import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, shareWith, selectTextInRich, ensureCommentsOpen, codeText, focusRichEnd, type User } from "./helpers";

const SOURCE = "# Review me\n\nOur product is very unique.\n\nWe launched recently and sales are good.\n\nThe end is near.\n";

/** JSON-RPC over /api/mcp, the way Copilot CLI calls the HTTP server. */
async function mcp<T>(page: Page, token: string, name: string, args: Record<string, unknown>): Promise<T> {
  const post = () =>
    page.request.post("/api/mcp", {
      headers: { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    });
  // The dev server occasionally drops a keep-alive socket while recompiling (read ECONNRESET); retry once.
  const res = await post().catch(async (err: unknown) => {
    if (!/ECONNRESET|ECONNREFUSED|socket hang up/.test(String(err))) throw err;
    await page.waitForTimeout(500);
    return post();
  });
  expect(res.ok(), `${name} -> ${res.status()} ${await res.text()}`).toBeTruthy();
  const text = await res.text();
  // Streamable HTTP may answer as SSE; the JSON-RPC result is the last `data:` line.
  const line = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5) : text;
  const body = JSON.parse(line) as { result: { structuredContent?: T; content: { text: string }[]; isError?: boolean } };
  expect(body.result.isError, body.result.content?.[0]?.text).toBeFalsy();
  return (body.result.structuredContent ?? JSON.parse(body.result.content[0].text)) as T;
}

/**
 * Comment on `quote` with a ```suggestion block proposing `replacement` (Ctrl+Shift+S in the composer
 * pre-fills the fence with the quote selected, so typing replaces it).
 */
async function suggestChange(page: Page, quote: string, replacement: string) {
  await selectTextInRich(page, quote);
  await page.getByTestId("tb-comment").click();
  const composer = page.getByTestId("comment-composer");
  await expect(composer).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+s");
  await expect(composer).toHaveValue(`\`\`\`suggestion\n${quote}\n\`\`\``);
  await page.keyboard.type(replacement);
  await page.keyboard.press("ControlOrMeta+Enter");
}

test.describe("review suggestions: ```suggestion blocks in comments, Accept / Reject, agent reviews", () => {
  let alice: User;
  let bob: User;
  let token: string;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
    bob = await signIn(browser, "bob");
    const res = await alice.page.request.post("/api/tokens", { data: { name: "Copilot", expiresInDays: 30 } });
    expect(res.ok()).toBeTruthy();
    token = ((await res.json()) as { token: { token: string } }).token.token;
  });

  test.afterAll(async () => {
    await alice.context.close();
    await bob.context.close();
  });

  /** Each test gets its own document (Alice owns, Bob edits) so a failure in one never leaks into the next. */
  async function freshDocument(): Promise<string> {
    const docId = await createDocument(alice.page, SOURCE, "Review me");
    await shareWith(alice.page, docId, "bob", "editor");
    await openDocument(alice.page, docId);
    await openDocument(bob.page, docId);
    await ensureCommentsOpen(alice.page);
    await ensureCommentsOpen(bob.page);
    return docId;
  }

  test("Suggest a change pre-fills the quote; the thread shows a diff; Accept replaces the text, resolves, and Ctrl+Z undoes it in one step", async () => {
    await freshDocument();
    const page = bob.page;
    await selectTextInRich(page, "very unique");
    await page.getByTestId("tb-comment").click();
    const composer = page.getByTestId("comment-composer");
    await expect(composer).toBeFocused();
    await page.keyboard.type("Redundant.");
    await page.getByTestId("comment-suggest-change").click();
    await expect(composer).toHaveValue("Redundant.\n\n```suggestion\nvery unique\n```");
    // The quote is selected inside the block, so typing replaces it.
    await page.keyboard.type("unique");
    await page.keyboard.press("ControlOrMeta+Enter");

    const thread = page.getByTestId("comment-thread").first();
    await expect(thread).toHaveAttribute("data-suggestion", "pending");
    const diff = thread.getByTestId("suggestion-diff");
    // "very unique" → "unique": the diff is one deletion; the kept word stays plain.
    await expect(diff.locator("del")).toContainText("very");
    await expect(diff).toContainText("unique");
    await expect(diff.locator("ins")).toHaveCount(0);
    // The prose renders without the fence.
    await expect(thread.getByTestId("comment-body")).toHaveText("Redundant.");
    await expect(thread.getByTestId("comment-body")).not.toContainText("```");

    // Alice sees the same diff and accepts it.
    const aliceThread = alice.page.getByTestId("comment-thread").first();
    await expect(aliceThread.getByTestId("suggestion-diff")).toBeVisible();
    const before = Date.now();
    await aliceThread.getByTestId("suggestion-accept-comment").click();
    await expect.poll(() => codeText(alice.page)).toContain("Our product is unique.");
    expect(Date.now() - before).toBeLessThan(1500);
    // The dev-login display name is the lower-case handle.
    await expect(alice.page.getByTestId("toast")).toContainText(/Accepted suggestion from bob/i);
    // Accepting resolves the thread (it moves to the Resolved tab).
    await expect(alice.page.getByTestId("comments-tab-resolved")).toContainText("1");
    await alice.page.getByTestId("comments-tab-resolved").click();
    await expect(alice.page.getByTestId("comment-thread").first()).toHaveAttribute("data-suggestion", "accepted");
    await alice.page.getByTestId("comments-tab-open").click();

    // One undo step in the editor restores the text. The undo manager's scope is the text (as for
    // accepted tracked changes), so the thread keeps its decision record and stays resolved.
    await alice.page.locator(".md-rich").click();
    await alice.page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => codeText(alice.page)).toContain("Our product is very unique.");
    await expect(alice.page.getByTestId("comments-tab-resolved")).toContainText("1");
  });

  test("Reject keeps the text; editing the quoted text first marks the suggestion Outdated and disables Accept", async () => {
    await freshDocument();
    const page = alice.page;

    // Bob suggests on "very unique"; Alice rejects — the text is untouched and the thread is decided.
    await suggestChange(bob.page, "very unique", "unique");
    const first = page.getByTestId("comment-thread").filter({ hasText: "very unique" }).first();
    await expect(first).toHaveAttribute("data-suggestion", "pending");
    await first.getByTestId("suggestion-reject-comment").click();
    await expect(first).toHaveAttribute("data-suggestion", "rejected");
    expect(await codeText(page)).toContain("Our product is very unique.");
    await expect(first.getByTestId("suggestion-accept-comment")).toHaveCount(0);

    // Bob suggests on "sales are good"; Alice edits that text before deciding.
    await suggestChange(bob.page, "sales are good", "sales are strong");
    const outdated = page.getByTestId("comment-thread").filter({ hasText: "sales are" }).first();
    await expect(outdated).toHaveAttribute("data-suggestion", "pending");
    await selectTextInRich(page, "good");
    await page.keyboard.type("great");
    await expect.poll(() => codeText(page)).toContain("sales are great");
    await expect(outdated).toHaveAttribute("data-suggestion", "outdated");
    await expect(outdated.getByTestId("suggestion-outdated")).toBeVisible();
    await expect(outdated.getByTestId("suggestion-accept-comment")).toBeDisabled();
    await expect(outdated.getByTestId("suggestion-reject-comment")).toBeEnabled();
  });

  test("an agent posts a review over MCP → review card; Accept all applies the suggestion; markdoc_watch reports suggestion.accepted; a bad quote creates nothing", async () => {
    const docId = await freshDocument();
    const page = alice.page;

    const watch0 = await mcp<{ cursor: string }>(page, token, "markdoc_watch", { id: docId, wait: 0 });
    expect(watch0.cursor).toBeTruthy();

    // Atomic: one quote that is not in the text → 400 and no threads.
    const threadsBefore = await page.getByTestId("comment-thread").count();
    const bad = await page.request.post(`/api/documents/${docId}/reviews`, {
      headers: { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" },
      data: { summary: "x", verdict: "comment", comments: [{ quote: "The end is near.", body: "ok" }, { quote: "NOT IN THE DOCUMENT", body: "nope" }] },
    });
    expect(bad.status()).toBe(400);
    expect(((await bad.json()) as { notFound: string[] }).notFound).toEqual(["NOT IN THE DOCUMENT"]);
    await page.waitForTimeout(300);
    expect(await page.getByTestId("comment-thread").count()).toBe(threadsBefore);
    expect(await page.getByTestId("review-card").count()).toBe(0);

    const review = await mcp<{ id: string; threadIds: string[] }>(page, token, "markdoc_review", {
      id: docId,
      verdict: "request_changes",
      summary: "Two small things.",
      comments: [
        { quote: "The end is near.", body: "Softer close.\n\n```suggestion\nThat is all for now.\n```" },
        { quote: "# Review me", body: "Title works." },
      ],
    });
    expect(review.threadIds).toHaveLength(2);

    const card = page.getByTestId("review-card").first();
    await expect(card).toBeVisible();
    await expect(card.getByTestId("review-verdict")).toHaveText("Copilot requested changes");
    await expect(card.getByTestId("review-counts")).toContainText("2 comments · 1 suggestion");
    await card.getByTestId("review-toggle").click();
    await expect(card.getByTestId("review-thread-link")).toHaveCount(2);

    await card.getByTestId("review-accept-all").click();
    await expect.poll(() => codeText(page)).toContain("That is all for now.");
    expect(await codeText(page)).not.toContain("The end is near.");
    await expect(page.getByTestId("toast")).toContainText("Accepted 1 suggestion from Copilot");
    await expect(card.getByTestId("review-accept-all")).toHaveCount(0);

    // The agent hears about it.
    await expect
      .poll(
        async () => {
          const w = await mcp<{ cursor: string; events: { type: string; threadId?: string | null }[] }>(page, token, "markdoc_watch", { id: docId, since: watch0.cursor, wait: 1 });
          return w.events.map((e) => e.type);
        },
        { timeout: 10_000 },
      )
      .toEqual(expect.arrayContaining(["review.created", "suggestion.accepted", "comment.resolved"]));

    // The REST comments listing reports the decided state.
    const comments = (await (await page.request.get(`/api/documents/${docId}/comments`)).json()) as { comments: { id: string; suggestion: { state: string } | null }[] };
    const accepted = comments.comments.find((c) => c.id === review.threadIds[0]);
    expect(accepted?.suggestion?.state).toBe("accepted");
  });

  test("a viewer sees the suggestion diff and the review card without Accept / Reject", async ({ browser }) => {
    const docId = await freshDocument();
    // A pending human suggestion and a pending agent review on the same document.
    await suggestChange(bob.page, "sales are good", "sales are strong");
    await expect(alice.page.getByTestId("comment-thread").filter({ hasText: "sales are" }).first()).toHaveAttribute("data-suggestion", "pending");
    await mcp(alice.page, token, "markdoc_review", {
      id: docId,
      verdict: "comment",
      summary: "One thought.",
      comments: [{ quote: "The end is near.", body: "Softer close.\n\n```suggestion\nThat is all for now.\n```" }],
    });
    await expect(alice.page.getByTestId("review-card").first()).toBeVisible();

    await shareWith(alice.page, docId, "carol", "viewer");
    const carol = await signIn(browser, "carol");
    try {
      await openDocument(carol.page, docId);
      await ensureCommentsOpen(carol.page);
      await carol.page.getByTestId("comments-tab-open").click();
      const thread = carol.page.getByTestId("comment-thread").filter({ hasText: "sales are" }).first();
      await expect(thread).toHaveAttribute("data-suggestion", "pending");
      await expect(thread.getByTestId("suggestion-diff")).toBeVisible();
      await expect(thread.getByTestId("suggestion-accept-comment")).toHaveCount(0);
      await expect(thread.getByTestId("suggestion-reject-comment")).toHaveCount(0);
      await expect(carol.page.getByTestId("review-card").first()).toBeVisible();
      await expect(carol.page.getByTestId("review-accept-all")).toHaveCount(0);
      await expect(carol.page.getByTestId("review-reject-all")).toHaveCount(0);
    } finally {
      await carol.context.close();
    }
  });
});

test.describe("suggesting mode: one typed word is one suggestion, even with an unpadded table in the document (task #475)", () => {
  const TABLE_DOC = "# Scout doc\n\nFirst paragraph with some words to select here.\n\n- item one\n- item two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nLast paragraph.\n";
  const TABLE_LINES = ["| a | b |", "| --- | --- |", "| 1 | 2 |"];
  let alice: User;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
  });
  test.afterAll(async () => {
    await alice.context.close();
  });

  const tableLinesOf = (text: string) => text.split("\n").slice(7, 10);
  /** Line numbers (1-based) of the code pane that carry an insertion mark. */
  const markedCodeLines = (page: Page) =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll(".cm-content .md-suggest-insert")).map((el) => {
        const line = el.closest(".cm-line")!;
        return Array.from(line.parentElement!.children).indexOf(line) + 1;
      }),
    );

  async function openTableDoc() {
    const docId = await createDocument(alice.page, TABLE_DOC, "Scout doc");
    await openDocument(alice.page, docId);
    await ensureCommentsOpen(alice.page);
    expect(tableLinesOf(await codeText(alice.page))).toEqual(TABLE_LINES);
  }

  async function switchToSuggesting() {
    await alice.page.getByTestId("mode-switcher").click();
    await alice.page.getByRole("menuitemradio", { name: /Suggesting/ }).click();
    await expect(alice.page.getByTestId("mode-switcher")).toContainText("Suggesting");
  }

  test("typing into the trailing paragraph the rich pane created: Suggestions 1, table lines untouched, one mark on the last line", async () => {
    await openTableDoc();
    const page = alice.page;
    // Still in Editing mode: Enter at the end, open and dismiss the slash menu, Backspace. The document text
    // is unchanged; the rich pane keeps a trailing empty paragraph.
    await focusRichEnd(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(page.getByTestId("slash-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");
    await expect.poll(() => codeText(page)).toBe(TABLE_DOC);

    await switchToSuggesting();
    await focusRichEnd(page);
    await page.keyboard.type(" suggested-words");
    await expect.poll(() => codeText(page)).toContain("suggested-words");

    const text = await codeText(page);
    expect(text).toBe(TABLE_DOC.trimEnd() + "\n\n suggested-words\n");
    expect(tableLinesOf(text)).toEqual(TABLE_LINES);
    await page.getByTestId("comments-tab-suggestions").click();
    await expect(page.getByTestId("comments-tab-suggestions")).toHaveText(/Suggestions\s*1$/);
    await expect(page.getByTestId("suggestion-card")).toHaveCount(1);
    // The only insertion mark in the code pane is on the typed line (line 14; the table is lines 8–10).
    await expect(page.locator(".cm-content .md-suggest-insert")).toHaveCount(1);
    expect(await markedCodeLines(page)).toEqual([14]);
    await expect(page.locator(".md-rich .md-suggest-insert")).toHaveCount(1);
    await expect(page.locator(".md-rich .md-suggest-insert")).toHaveText("suggested-words");
    // No blank paragraph slipped in between "Last paragraph." and the suggestion: three paragraphs, six blocks.
    await expect(page.locator(".md-rich > p")).toHaveCount(3);
    await expect(page.locator(".md-rich > p").last()).toHaveText(/^\s?suggested-words$/);

    // Accept all: only the typed word lands.
    await page.getByTestId("accept-all").click();
    await expect(page.getByTestId("suggestion-card")).toHaveCount(0);
    const accepted = await codeText(page);
    expect(accepted).toBe(TABLE_DOC.trimEnd() + "\n\n suggested-words\n");
    expect(tableLinesOf(accepted)).toEqual(TABLE_LINES);
  });

  test("control: typing at the end of the last paragraph is still exactly one suggestion", async () => {
    await openTableDoc();
    const page = alice.page;
    await switchToSuggesting();
    await focusRichEnd(page);
    await page.keyboard.type(" suggested-words");
    await expect.poll(() => codeText(page)).toContain("Last paragraph. suggested-words");
    expect(tableLinesOf(await codeText(page))).toEqual(TABLE_LINES);
    await page.getByTestId("comments-tab-suggestions").click();
    await expect(page.getByTestId("comments-tab-suggestions")).toHaveText(/Suggestions\s*1$/);
    await expect(page.locator(".cm-content .md-suggest-insert")).toHaveCount(1);
    expect(await markedCodeLines(page)).toEqual([12]);
  });

  test("the panel lands on Suggestions in Suggesting mode, switches there once when the first suggestion arrives, and the Open empty state links to it (#117)", async () => {
    const docId = await createDocument(alice.page, TABLE_DOC, "Scout doc");
    await openDocument(alice.page, docId);
    const page = alice.page;
    const suggestionsTab = page.getByRole("tab", { name: /Suggestions/ });
    const openTab = page.getByRole("tab", { name: /Open/ });

    // Repro from the issue: Suggesting → type → open the panel with the header toggle.
    await expect(page.getByTestId("comments-panel")).toHaveCount(0);
    await switchToSuggesting();
    await focusRichEnd(page);
    await page.keyboard.type(" suggested-words");
    await expect.poll(() => codeText(page)).toContain("Last paragraph. suggested-words");
    await page.getByTestId("comments-toggle").click();
    await expect(page.getByTestId("comments-panel")).toBeVisible();
    await expect(suggestionsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("suggestion-card")).toHaveCount(1);
    await expect(page.getByText("No open comments")).toHaveCount(0);

    // Open tab, no comments, one suggestion: the empty state links to the Suggestions tab.
    await openTab.click();
    await expect(openTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("No open comments")).toBeVisible();
    await expect(page.getByTestId("comments-empty-suggestions-button")).toHaveText(/1 suggestion waiting/);
    await page.getByTestId("comments-empty-suggestions-button").click();
    await expect(suggestionsTab).toHaveAttribute("aria-selected", "true");

    // Back in Editing mode with the panel closed and the suggestion rejected: the panel opens on Open again.
    await page.getByTestId("reject-all").click();
    await expect(page.getByTestId("suggestion-card")).toHaveCount(0);
    await page.getByTestId("mode-switcher").click();
    await page.getByRole("menuitemradio", { name: /^Editing/ }).click();
    await expect(page.getByTestId("mode-switcher")).toContainText("Editing");
    await page.getByTestId("comments-toggle").click();
    await expect(page.getByTestId("comments-panel")).toHaveCount(0);
    await page.getByTestId("comments-toggle").click();
    await expect(openTab).toHaveAttribute("aria-selected", "true");

    // Panel already open on Open: the first suggestion of the session moves it to Suggestions…
    await switchToSuggesting();
    await focusRichEnd(page);
    await page.keyboard.type(" again");
    await expect.poll(() => codeText(page)).toContain("Last paragraph. again");
    await expect(suggestionsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("suggestion-card")).toHaveCount(1);
    // …but only once: a user who switched back to Open is not fought when the next suggestion appears.
    await openTab.click();
    await expect(openTab).toHaveAttribute("aria-selected", "true");
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("End");
    await page.keyboard.type(" more");
    await expect.poll(() => codeText(page)).toContain("# Scout doc more");
    await expect(page.getByTestId("comments-tab-suggestions")).toHaveText(/Suggestions\s*2$/);
    await expect(openTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("comments-empty-suggestions-button")).toHaveText(/2 suggestions waiting/);
  });
});
