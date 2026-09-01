import { test, expect, type Page } from "@playwright/test";
import { budgetMs, signIn, createDocument, openDocument, shareWith, selectTextInRich, ensureCommentsOpen, mintToken, type MintedToken, type User } from "./helpers";

/**
 * Agent requests from comments (task #1024): mentioning an agent in a comment or reply makes the comment a request.
 * The composer grows a mode row (Tracked changes / Comment only / Rewrite directly) while the body names an agent,
 * posting creates the request against the thread, and the thread card carries the request as a chip that the
 * requester or the owner can cancel. The agent side is the same REST the CLI uses, with a token minted here.
 */

interface RequestDto {
  id: string;
  documentId: string;
  status: string;
  mode: string;
  claimedBy: string | null;
  instruction: string;
  threadId: string | null;
  selection: { from: number; to: number; quote: string } | null;
  result: { suggestions: number; comments: number; summary?: string } | null;
}

/** Act as an agent: the calls Copilot CLI makes through mcp/server.mjs, with a token minted in the UI. */
function agent(page: Page, token: string) {
  const headers = { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" };
  const call = async <T,>(method: "get" | "post", path: string, data?: unknown): Promise<T> => {
    const res = method === "get" ? await page.request.get(path, { headers }) : await page.request.post(path, { headers, data: data ?? {} });
    expect(res.ok(), `${method.toUpperCase()} ${path} -> ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as T;
  };
  return {
    claim: (docId: string, rid: string) => call<{ request: RequestDto }>("post", `/api/documents/${docId}/requests/${rid}/claim`),
    suggest: (docId: string, rid: string, edits: { find: string; replace: string }[]) => call<{ suggestions: number }>("post", `/api/documents/${docId}/suggest`, { edits, requestId: rid }),
    complete: (docId: string, rid: string, summary: string) => call<{ request: RequestDto }>("post", `/api/documents/${docId}/requests/${rid}/complete`, { summary }),
  };
}

/** The document's requests as the browser session sees them (owner/collaborator cookie), newest first. */
async function listRequests(page: Page, docId: string, status?: string): Promise<RequestDto[]> {
  const res = await page.request.get(`/api/documents/${docId}/requests${status ? `?status=${status}` : ""}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { requests: RequestDto[] }).requests;
}

/** Text under the composer box that is not inside a control: the row is controls only (no hint text). */
const looseTextUnderBox = (page: Page) =>
  page.getByTestId("composer-agent-row").evaluate((row) => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const loose: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim() && !node.parentElement?.closest("button")) loose.push(node.textContent.trim());
    }
    return loose;
  });

/** Durations of the sync waits the comments panel measured before posting a request (User Timing). */
const syncWaits = (page: Page) => page.evaluate(() => performance.getEntriesByName("markdoc:request-sync-wait").map((e) => e.duration));

/** Counts 404 answers to POST /requests on this page: the race the sync wait is there to avoid. */
function countRequestNotFound(page: Page) {
  let count = 0;
  page.on("response", (res) => {
    if (res.request().method() === "POST" && /\/api\/documents\/[^/]+\/requests$/.test(new URL(res.url()).pathname) && res.status() === 404) count++;
  });
  return () => count;
}

/** Pull the notifications store now instead of waiting for the 30 s poll. */
const refreshNotifications = (page: Page) =>
  page.evaluate(() => (window as unknown as { __markdocNotificationsRefresh?: () => Promise<void> }).__markdocNotificationsRefresh?.());

const DOC = "# Requests doc\n\nThe quick brown fox jumps over the lazy dog in the garden.\n\nA second paragraph to keep.\n\nA third paragraph for later.\n";

test.describe("agent requests from comments", () => {
  // b) and c) build on the thread and the agent activity a) leaves behind: a failure upstream skips them
  // rather than restarting the worker (and its beforeAll) into a fresh document.
  test.describe.configure({ mode: "serial" });
  let alice: User;
  let bob: User;
  let carol: User;
  let docId: string;
  let minted: MintedToken;
  /** Unique per run so the mention and `claimedBy` are unambiguous even when other suites minted "Copilot CLI" for alice. */
  const agentName = `Copilot CLI ${Date.now().toString(36).slice(-4)}`;
  const slug = agentName.replace(/[^A-Za-z0-9-]+/g, "-");
  const mention = `@alice/${slug}`;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
    bob = await signIn(browser, "bob");
    carol = await signIn(browser, "carol");
    minted = await mintToken(alice.page, agentName, { expiresInDays: 1 });
    expect(minted.name).toBe(agentName);
    // c) has bob (a commenter) ask alice's agent: since #1296 that needs alice's "Collaborators may ask this agent"
    // switch on, or the picker locks the agent for him and the composer refuses to send (e2e/agent-addressing.spec.ts).
    const opened = await alice.page.request.patch(`/api/tokens/${minted.id}`, { data: { collaboratorsMayAsk: true } });
    expect(opened.ok(), await opened.text()).toBeTruthy();
    docId = await createDocument(alice.page, DOC, "Requests doc");
    await shareWith(alice.page, docId, "bob", "commenter");
    await shareWith(alice.page, docId, "carol", "editor");
    await openDocument(alice.page, docId);
    await ensureCommentsOpen(alice.page);
  });

  test.afterAll(async () => {
    // Before the contexts close, so a worker restart can mint the name again (see mintToken).
    await minted?.revoke();
    await alice.context.close();
    await bob.context.close();
    await carol.context.close();
  });

  /** Opens the new-comment composer on `text` and mentions the agent through the picker; returns the composer. */
  async function mentionAgentOn(page: Page, text: string) {
    await selectTextInRich(page, text);
    await page.getByTestId("tb-comment").click();
    const composer = page.getByTestId("comment-composer");
    await expect(composer).toBeFocused();
    await expect(page.getByTestId("composer-agent-row")).toHaveCount(0);
    await page.keyboard.type("@cop");
    const options = page.getByTestId("mention-suggestions").getByTestId("mention-option");
    await expect(options).toHaveCount(1);
    await expect(options.first()).toHaveAttribute("data-login", `alice/${slug}`);
    await page.keyboard.press("Enter");
    await expect(composer).toHaveValue(`${mention} `);
    await expect(composer).toBeFocused();
    return composer;
  }

  test("a) a comment that mentions an agent: mode row, one request against the thread, chip waiting → working → done", async () => {
    const page = alice.page;
    const notFound = countRequestNotFound(page);
    // The agent has never been in this document: it is offered because it is one of alice's own tokens.
    await selectTextInRich(page, "quick brown fox");
    await page.getByTestId("tb-comment").click();
    const composer = page.getByTestId("comment-composer");
    await expect(composer).toBeFocused();
    // Nothing under the box until an agent is named (the comment-composer suite asserts the same for plain comments).
    await expect(page.locator('[data-testid="comment-composer"] ~ *')).toHaveCount(1);
    await page.keyboard.type("@cop");
    const option = page.getByTestId("mention-suggestions").getByTestId("mention-option");
    await expect(option).toHaveCount(1);
    await expect(option.first()).toHaveAttribute("data-own", "");
    await expect(option.first()).toContainText("your agent · not here yet");
    await page.keyboard.press("Enter");
    await expect(composer).toHaveValue(`${mention} `);

    const row = page.getByTestId("composer-agent-row");
    await expect(row).toBeVisible();
    await expect(composer).toBeFocused();
    expect(await looseTextUnderBox(page)).toEqual([]);
    const group = row.getByRole("radiogroup");
    await expect(group).toHaveAttribute("aria-label", `How should ${agentName} answer?`);
    await expect(page.getByTestId("composer-mode-suggest")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("composer-mode-comment")).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("composer-mode-rewrite")).toHaveAttribute("aria-checked", "false");
    for (const id of ["suggest", "comment", "rewrite"]) await expect(page.getByTestId(`composer-mode-${id}`)).not.toHaveAttribute("aria-disabled", "true");
    // A quick instruction lands after the mention; the caret stays in the box.
    await page.getByTestId("composer-chip").filter({ hasText: "Tighten this" }).click();
    await expect(composer).toHaveValue(`${mention} Tighten this`);
    await expect(composer).toBeFocused();
    // The row goes when the mention goes, and comes back with it.
    await composer.fill("Tighten this");
    await expect(row).toHaveCount(0);
    await composer.fill(`${mention} Tighten this`);
    await expect(row).toBeVisible();
    if (process.env.SHOT_DIR) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({ path: `${process.env.SHOT_DIR}/composer-agent-row.png` });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }

    await page.getByTestId("comment-submit").click();
    const thread = page.getByTestId("comment-thread");
    await expect(thread).toHaveCount(1);
    await expect(thread).toContainText("Tighten this");
    const threadId = await thread.getAttribute("data-thread-id");
    const chip = thread.getByTestId("comment-request-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-status", "open");
    await expect(chip).toContainText("Waiting for an agent");
    // The chip sits in the header row: right of the author and time, left of the ⋯ actions.
    const order = await thread.evaluate((card) => Array.from(card.querySelectorAll("[data-testid]")).map((el) => el.getAttribute("data-testid")));
    expect(order.indexOf("comment-timestamp")).toBeLessThan(order.indexOf("comment-request-chip"));
    expect(order.indexOf("comment-request-chip")).toBeLessThan(order.indexOf("comment-resolve"));
    // Exactly one request, on the thread, with the cleaned instruction and the comment's anchor; no dialog toast.
    const [request, ...rest] = await listRequests(page, docId, "open");
    expect(rest).toEqual([]);
    expect(request).toMatchObject({ mode: "suggest", instruction: "Tighten this", threadId, status: "open" });
    expect(request.selection?.quote).toBe("quick brown fox");
    await expect(page.getByTestId("toast").filter({ hasText: "Sent to agents" })).toHaveCount(0);
    expect(notFound()).toBe(0);

    const cli = agent(page, minted.token);
    await cli.claim(docId, request.id);
    await expect(chip).toHaveAttribute("data-status", "claimed");
    await expect(chip).toContainText(`${agentName} is working…`);
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/request-chip-claimed.png` });
    const suggested = await cli.suggest(docId, request.id, [{ find: "quick brown fox", replace: "swift brown fox" }]);
    expect(suggested.suggestions).toBeGreaterThan(0);
    await cli.complete(docId, request.id, "Tightened the opener.");
    // The done toast is the shell's existing one; it moves the panel to Suggestions, where the thread is not listed.
    await expect(page.getByTestId("toast").filter({ hasText: `${agentName} finished` })).toBeVisible();
    await page.getByTestId("comments-tab-open").click();
    const doneChip = page.getByTestId("comment-thread").filter({ hasText: "Tighten this" }).getByTestId("comment-request-chip");
    await expect(doneChip).toHaveAttribute("data-status", "done");
    await expect(doneChip).toContainText(`Done: ${suggested.suggestions} suggestion${suggested.suggestions === 1 ? "" : "s"}`);
    await expect(doneChip.getByTestId("comment-request-cancel")).toHaveCount(0);

    // Activity has the ask and the completion; the bell has request.done for the requester (#1075: this used to be
    // asserted for the dialog, which is gone — a comment is the request now).
    await page.getByTestId("more-menu").click();
    await page.getByTestId("menu-activity").click();
    const rows = page.getByTestId("activity-panel").getByTestId("activity-row");
    await expect(rows.filter({ hasText: "asked an agent" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "finished a request" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "finished a request" })).toContainText("Tightened the opener.");
    await refreshNotifications(page);
    await page.getByTestId("notifications-bell").click();
    const item = page.getByTestId("notifications-popover").locator('[data-testid=notification-item][data-kind="request.done"]').first();
    await expect(item).toBeVisible();
    await expect(item).toContainText("finished your request");
    await page.keyboard.press("Escape");
    await ensureCommentsOpen(page);
  });

  test("b) a reply that mentions the agent asks again (mode preselected from the thread), and the × cancels the request", async () => {
    const page = alice.page;
    await page.getByTestId("comments-tab-open").click();
    const thread = page.getByTestId("comment-thread").filter({ hasText: "Tighten this" });
    await thread.getByRole("button", { name: "Reply", exact: true }).click();
    const composer = page.getByTestId("comment-composer");
    await expect(composer).toBeFocused();
    await page.keyboard.type(`${mention} and the second paragraph? `);
    await expect(page.getByTestId("mention-suggestions")).toHaveCount(0);
    const row = page.getByTestId("composer-agent-row");
    await expect(row).toBeVisible();
    await expect(page.getByTestId("composer-mode-suggest")).toHaveAttribute("aria-checked", "true");
    // Choosing a mode with the pointer keeps the caret in the box.
    await page.getByTestId("composer-mode-comment").click();
    await expect(page.getByTestId("composer-mode-comment")).toHaveAttribute("aria-checked", "true");
    await expect(composer).toBeFocused();
    await page.getByTestId("comment-submit").click();
    await expect(thread).toContainText("and the second paragraph?");
    const chip = thread.getByTestId("comment-request-chip");
    await expect(chip).toHaveAttribute("data-status", "open");
    const open = await listRequests(page, docId, "open");
    expect(open).toHaveLength(1);
    const threadId = await thread.getAttribute("data-thread-id");
    expect(open[0]).toMatchObject({ mode: "comment", instruction: "and the second paragraph?", threadId });
    await expect(chip).toHaveAttribute("data-request-id", open[0].id);

    const cancel = chip.getByTestId("comment-request-cancel");
    await expect(cancel).toHaveAccessibleName("Cancel request");
    await cancel.click();
    await expect(thread.getByTestId("comment-request-chip")).toHaveCount(0);
    await expect(page.getByTestId("toast").filter({ hasText: "Request cancelled" })).toBeVisible();
    await expect.poll(async () => (await listRequests(page, docId, "cancelled")).map((r) => r.id)).toContain(open[0].id);
    // Cancelled: nothing on the card, not even the earlier done request (the thread's latest request is what counts).
    await page.waitForTimeout(500);
    await expect(thread.getByTestId("comment-request-chip")).toHaveCount(0);
    await expect(thread).toBeVisible();
  });

  test("c) a commenter can only ask for comments; the × is for the requester and the owner, not a third collaborator", async () => {
    const page = bob.page;
    await openDocument(page, docId);
    await ensureCommentsOpen(page);
    await selectTextInRich(page, "second paragraph to keep");
    await page.getByTestId("tb-comment").click();
    const composer = page.getByTestId("comment-composer");
    await expect(composer).toBeFocused();
    // Bob is not the token's owner: the agent is offered because it has been active in this document.
    await page.keyboard.type("@cop");
    const options = page.getByTestId("mention-suggestions").getByTestId("mention-option");
    await expect(options).toHaveCount(1);
    await expect(options.first()).toHaveAttribute("data-login", `alice/${slug}`);
    await expect(options.first()).not.toHaveAttribute("data-own", "");
    await page.keyboard.press("Enter");
    await page.keyboard.type("is this paragraph needed?");
    const row = page.getByTestId("composer-agent-row");
    await expect(row).toBeVisible();
    const suggest = page.getByTestId("composer-mode-suggest");
    await expect(suggest).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("composer-mode-rewrite")).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("composer-mode-comment")).toHaveAttribute("aria-checked", "true");
    await suggest.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Needs edit access");
    // Playwright refuses to click aria-disabled controls; force it to prove the click changes nothing.
    await suggest.click({ force: true });
    await expect(page.getByTestId("composer-mode-comment")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("comment-submit").click();
    const thread = page.getByTestId("comment-thread").filter({ hasText: "is this paragraph needed?" });
    await expect(thread).toHaveCount(1);
    const chip = thread.getByTestId("comment-request-chip");
    await expect(chip).toHaveAttribute("data-status", "open");
    const threadId = await thread.getAttribute("data-thread-id");
    const open = await listRequests(alice.page, docId, "open");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ mode: "comment", instruction: "is this paragraph needed?", threadId });
    // Bob asked: he can cancel. Alice owns the document: so can she. Carol (editor) cannot.
    await expect(chip.getByTestId("comment-request-cancel")).toBeVisible();
    const aliceThread = alice.page.getByTestId("comment-thread").filter({ hasText: "is this paragraph needed?" });
    await expect(aliceThread.getByTestId("comment-request-chip")).toHaveAttribute("data-status", "open");
    await expect(aliceThread.getByTestId("comment-request-cancel")).toBeVisible();
    await openDocument(carol.page, docId);
    await ensureCommentsOpen(carol.page);
    const carolThread = carol.page.getByTestId("comment-thread").filter({ hasText: "is this paragraph needed?" });
    await expect(carolThread.getByTestId("comment-request-chip")).toHaveAttribute("data-status", "open");
    await expect(carolThread.getByTestId("comment-request-cancel")).toHaveCount(0);
    // The chip fits the 280 px panel: the card is no wider than the panel.
    const panelWidth = (await carol.page.getByTestId("comments-panel").boundingBox())!.width;
    const cardWidth = (await carolThread.boundingBox())!.width;
    expect(cardWidth).toBeLessThanOrEqual(panelWidth);
    const cli = agent(alice.page, minted.token);
    await cli.claim(docId, open[0].id);
    await cli.complete(docId, open[0].id, "Kept it.");
    await expect(chip).toContainText("Done");
  });

  test("d) ten comments in a row: the request waits for the sync ack, so the server never answers 404", async () => {
    test.slow();
    const page = alice.page;
    const notFound = countRequestNotFound(page);
    const before = (await listRequests(page, docId)).length;
    for (let i = 0; i < 10; i++) {
      await mentionAgentOn(page, "third paragraph");
      await page.keyboard.type(`run ${i}`);
      await page.getByTestId("comment-submit").click();
      const thread = page.getByTestId("comment-thread").filter({ hasText: `run ${i}` });
      await expect(thread.getByTestId("comment-request-chip")).toHaveAttribute("data-status", "open");
    }
    const all = await listRequests(page, docId);
    expect(all.length - before).toBe(10);
    const waits = await syncWaits(page);
    const sorted = [...waits].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
    const max = sorted[sorted.length - 1] ?? 0;
    test.info().annotations.push({ type: "measurement", description: `POST /requests 404s over 10 runs: ${notFound()}; sync-wait p95 ${p95.toFixed(1)} ms over ${waits.length} waits (max ${max.toFixed(1)} ms)` });
    console.log(`[agent-requests] 404s=${notFound()} sync-wait p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms n=${waits.length}`);
    expect(notFound()).toBe(0);
    expect(p95).toBeLessThan(budgetMs(2000));
  });
});

/**
 * Document comments (task #1025): a comment started with nothing selected anchors to the whole document ({0,0}),
 * the empty state and the hint bar start one with `@` already typed, and the `@` picker of a user without an
 * API token ends in a "Connect an agent" row that goes away once per browser.
 */
const LONG_DOC =
  "# Whole document fixture\n\n" +
  Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of the fixture, long enough that the preview scrolls well past the fold.`).join("\n\n") +
  "\n";
const RICH_SCROLLER = '[data-testid="rich-column"] .overflow-y-auto';
const CONNECT_DISMISSED_KEY = "markdoc:agent-connect-dismissed";
const fresh = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

const richScrollTop = (page: Page) => page.evaluate((sel) => document.querySelector<HTMLElement>(sel)?.scrollTop ?? -1, RICH_SCROLLER);
/** The thread's live range as the client model resolves it (`{0,0}` for a document comment). */
const threadRange = (page: Page, threadId: string) =>
  page.evaluate(
    (id) => (window as unknown as { __markdocSession: { comments: { get(id: string): { range: { from: number; to: number } | null; quote: string } | null } } }).__markdocSession.comments.get(id),
    threadId,
  );

test.describe("document comments, the empty state and the connect row (#1025)", () => {
  test.describe.configure({ mode: "serial" });
  let alice: User;
  let bob: User;
  let docId: string;
  let minted: MintedToken;
  const agentName = "Reviewer";

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, fresh("dc-alice"));
    bob = await signIn(browser, fresh("dc-bob"));
    minted = await mintToken(alice.page, agentName, { expiresInDays: 1 });
    docId = await createDocument(alice.page, LONG_DOC, "Whole document fixture");
    await shareWith(alice.page, docId, bob.login, "commenter");
    await openDocument(alice.page, docId);
    await ensureCommentsOpen(alice.page);
  });

  test.afterAll(async () => {
    await minted?.revoke();
    await alice.context.close();
    await bob.context.close();
  });

  test("e) the empty state starts a comment on the whole document with `@` typed; the thread anchors to {0,0}, highlights nothing and reveals the top", async () => {
    const page = alice.page;
    const panel = page.getByTestId("comments-panel");
    await expect(panel.getByTestId("comments-empty-agent-line")).toContainText("Comment and mention an agent");
    await expect(panel.getByText("Ask an agent")).toHaveCount(0);
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/comments-empty-state.png` });

    const t0 = Date.now();
    await panel.getByTestId("comments-empty-agent").click();
    const pending = panel.getByTestId("pending-comment");
    await expect(pending).toBeVisible();
    await expect(pending.getByTestId("comment-quote-document")).toHaveText("Whole document");
    const composer = pending.getByTestId("comment-composer");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("@");
    expect(await composer.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([1, 1]);
    const picker = page.getByTestId("mention-suggestions");
    await expect(picker).toBeVisible();
    const pickerMs = Date.now() - t0;
    test.info().annotations.push({ type: "measurement", description: `empty state → composer with "@" and the picker open: ${pickerMs} ms` });
    console.log(`[document-comment] empty state → "@" + picker in ${pickerMs}ms`);
    expect(pickerMs).toBeLessThan(budgetMs(2_000));
    // Alice has a token: her own agent is offered and the connect row stays away.
    const own = picker.locator('[data-testid="mention-option"][data-own]');
    await expect(own).toHaveCount(1);
    await expect(picker.getByTestId("mention-connect-row")).toHaveCount(0);
    await own.click();
    await expect(composer).toHaveValue(new RegExp(`^@${alice.login}/${agentName} $`));
    await expect(pending.getByTestId("composer-agent-row")).toBeVisible();
    await page.keyboard.type("tighten the whole thing");
    const highlightsBefore = await page.locator(".md-rich .md-comment").count();
    await pending.getByTestId("comment-submit").click();

    const card = panel.getByTestId("comment-thread").filter({ hasText: "tighten the whole thing" });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("comment-quote-document")).toHaveText("Whole document");
    await expect(card.getByTestId("comment-request-chip")).toHaveAttribute("data-status", "open");
    await expect(card.getByRole("button", { name: /^Accept/ })).toHaveCount(0);
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/document-comment-card.png` });
    // No text is highlighted for a document comment, before or after typing at the very start of the document.
    expect(await page.locator(".md-rich .md-comment").count()).toBe(highlightsBefore);
    const threadId = (await card.getAttribute("data-thread-id")) ?? "";
    expect(threadId).not.toBe("");
    expect(await threadRange(page, threadId)).toMatchObject({ range: { from: 0, to: 0 }, quote: "" });
    await page.evaluate(() => (window as unknown as { __markdocSession: { ytext: { insert(i: number, s: string): void } } }).__markdocSession.ytext.insert(0, "x".repeat(200)));
    await expect.poll(() => threadRange(page, threadId).then((t) => t?.range)).toEqual({ from: 0, to: 0 });
    expect(await page.locator(".md-rich .md-comment").count()).toBe(highlightsBefore);
    await page.evaluate(() => (window as unknown as { __markdocSession: { ytext: { delete(i: number, n: number): void } } }).__markdocSession.ytext.delete(0, 200));

    // The request carries no selection and points at the thread.
    const open = await listRequests(page, docId, "open");
    const req = open.find((r) => r.threadId === threadId);
    expect(req, JSON.stringify(open)).toBeTruthy();
    expect(req!.selection).toBeNull();
    expect(req!.instruction).toContain("tighten the whole thing");

    // Clicking the card reveals the top of the document.
    await page.evaluate((sel) => document.querySelector<HTMLElement>(sel)!.scrollTo({ top: 1e6, behavior: "auto" }), RICH_SCROLLER);
    await expect.poll(() => richScrollTop(page)).toBeGreaterThan(1_000);
    await card.getByTestId("comment-body").first().click();
    await expect.poll(() => richScrollTop(page), { timeout: 5_000 }).toBeLessThan(2);
  });

  test("f) Comment with nothing selected (toolbar and Ctrl+Alt+M) opens a whole-document composer instead of a toast", async () => {
    const page = alice.page;
    const panel = page.getByTestId("comments-panel");
    await page.locator(".md-rich h1").click();
    await page.getByTestId("tb-comment").click();
    const pending = panel.getByTestId("pending-comment");
    await expect(pending).toBeVisible();
    await expect(pending.getByTestId("comment-quote-document")).toHaveText("Whole document");
    await expect(pending.getByTestId("comment-composer")).toHaveValue("");
    await expect(page.getByTestId("toast")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(pending).toHaveCount(0);

    await page.locator(".md-rich h1").click();
    await page.keyboard.press("Control+Alt+m");
    await expect(pending).toBeVisible();
    await expect(pending.getByTestId("comment-quote-document")).toHaveText("Whole document");
    await expect(page.getByTestId("toast")).toHaveCount(0);
    // The header button of the panel does the same.
    await page.keyboard.press("Escape");
    await expect(pending).toHaveCount(0);
    await panel.getByTestId("comment-document").click();
    await expect(pending).toBeVisible();
    await expect(pending.getByTestId("comment-quote-document")).toHaveText("Whole document");
    await page.keyboard.press("Escape");
    await expect(pending).toHaveCount(0);
  });

  test("g) a commenter without an API token gets the connect row under the picker; ✕ hides it for good on this browser", async () => {
    const page = bob.page;
    await openDocument(page, docId);
    await ensureCommentsOpen(page);
    const panel = page.getByTestId("comments-panel");
    await panel.getByTestId("comment-document").click();
    const composer = panel.getByTestId("pending-comment").getByTestId("comment-composer");
    await expect(composer).toBeFocused();
    await page.keyboard.type("@");
    const picker = page.getByTestId("mention-suggestions");
    await expect(picker).toBeVisible();
    // The document's owner is offered (her agent has not been in the document yet); the row sits under the list.
    await expect(picker.getByTestId("mention-option")).toHaveCount(1);
    const row = picker.getByTestId("mention-connect-row");
    await expect(row).toBeVisible();
    await expect(row).toContainText("No agent connected yet");
    await expect(row.getByTestId("mention-connect-agent")).toHaveText("Connect an agent");
    await expect(row.getByTestId("mention-connect-docs")).toHaveAttribute("href", /docs\/agents\.md$/);
    await expect(row.getByTestId("mention-connect-docs")).toHaveAttribute("target", "_blank");
    await row.getByTestId("mention-connect-dismiss").click();
    await expect(picker.getByTestId("mention-connect-row")).toHaveCount(0);
    await expect(picker.getByTestId("mention-option")).toHaveCount(1);
    await expect(composer).toBeFocused();
    expect(await page.evaluate((k) => localStorage.getItem(k), CONNECT_DISMISSED_KEY)).toBe("1");

    // Remembered across a reload.
    await openDocument(page, docId);
    await ensureCommentsOpen(page);
    await panel.getByTestId("comment-document").click();
    await expect(panel.getByTestId("pending-comment").getByTestId("comment-composer")).toBeFocused();
    await page.keyboard.type("@");
    await expect(picker).toBeVisible();
    await expect(picker.getByTestId("mention-option")).toHaveCount(1);
    await page.waitForTimeout(500);
    await expect(picker.getByTestId("mention-connect-row")).toHaveCount(0);
  });

  test("h) Connect an agent in that row goes to /settings#tokens, where the connect card carries this origin's MCP config", async () => {
    const page = bob.page;
    await page.evaluate((k) => localStorage.removeItem(k), CONNECT_DISMISSED_KEY);
    await openDocument(page, docId);
    await ensureCommentsOpen(page);
    const panel = page.getByTestId("comments-panel");
    await panel.getByTestId("comment-document").click();
    await expect(panel.getByTestId("pending-comment").getByTestId("comment-composer")).toBeFocused();
    await page.keyboard.type("@");
    const row = page.getByTestId("mention-suggestions").getByTestId("mention-connect-row");
    await expect(row).toBeVisible();
    await row.getByTestId("mention-connect-agent").click();
    await page.waitForURL((u) => u.pathname === "/settings");
    expect(new URL(page.url()).hash).toBe("#tokens");
    await expect(page.getByTestId("token-name")).toBeVisible();
    const card = page.getByTestId("agent-connect-card");
    await expect(card).toBeVisible();
    const origin = await page.evaluate(() => window.location.origin);
    await expect(page.getByTestId("agent-connect-config")).toContainText(`"url": "${origin}/api/mcp"`);
    await expect(page.getByTestId("agent-connect-config")).toContainText('"type": "http"');
    await expect(page.getByTestId("agent-connect-config")).toContainText(["Bearer", "MARKDOC_TOKEN"].join(" "));
    // The stdio config is still there, one click away.
    await page.getByTestId("agent-connect-stdio-toggle").click();
    await expect(page.getByTestId("agent-connect-config-stdio")).toContainText(`"MARKDOC_URL": "${origin}"`);
    await expect(card).toContainText("Check Markdoc for requests");
    // The same "Stop the permission prompts" block as the Share card, with the allow line for the `markdoc` server key.
    await expect(card).toContainText("Stop the permission prompts");
    await expect(page.getByTestId("agent-connect-allow-line")).toContainText("copilot --allow-tool 'markdoc(markdoc_suggest)");
    await expect(page.getByRole("tab", { name: "Copilot CLI" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "VS Code / other MCP clients" })).toBeVisible();
    await page.getByRole("tab", { name: "Copilot app" }).click();
    await expect(page.getByTestId("agent-connect-app-install")).toContainText("~/.copilot/extensions/markdoc");
    await expect(page.getByRole("link", { name: "Inside the Copilot app setup and limits" })).toHaveAttribute("href", /agents\.md#inside-the-copilot-app$/);
    await page.getByTestId("settings-back-to-document").click();
    await page.waitForURL((u) => u.pathname === `/d/${docId}`);
  });
});
