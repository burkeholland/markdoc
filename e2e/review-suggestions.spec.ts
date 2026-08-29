import { test, expect, type Locator, type Page } from "@playwright/test";
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

async function addComment(page: Page, quote: string, body: string): Promise<string> {
  await selectTextInRich(page, quote);
  await page.getByTestId("tb-comment").click();
  const composer = page.getByTestId("comment-composer");
  await expect(composer).toBeFocused();
  await composer.fill(body);
  await page.keyboard.press("ControlOrMeta+Enter");
  const thread = page.getByTestId("comment-thread").filter({ hasText: body }).first();
  await expect(thread).toBeVisible();
  return (await thread.getAttribute("data-thread-id"))!;
}

/** The suggestion card shows the proposed text verbatim (no diff against the quoted passage). */
async function expectSuggestionText(text: Locator, to: string) {
  await expect.poll(async () => ((await text.textContent()) ?? "").trim()).toBe(to);
}

async function pressSourceHistory(page: Page, action: "undo" | "redo") {
  const source = page.locator(".cm-content");
  await expect(source).toBeVisible();
  await source.click();
  await expect(source).toBeFocused();
  await page.keyboard.press(action === "undo" ? "ControlOrMeta+z" : process.platform === "darwin" ? "Meta+Shift+z" : "Control+y");
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

  test("a root suggestion preserves its exact decision through Undo and Redo across reloads", async () => {
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
    // "very unique" → "unique": the card shows only the proposed text; the quoted passage is highlighted in the document, not repeated here.
    await expectSuggestionText(thread.getByTestId("suggestion-text"), "unique");
    expect(await thread.getByTestId("suggestion-box").locator("ins, del").count()).toBe(0);
    await expect(thread.getByTestId("suggestion-deletes")).toHaveCount(0);
    // The prose renders without the fence.
    await expect(thread.getByTestId("comment-body")).toHaveText("Redundant.");
    await expect(thread.getByTestId("comment-body")).not.toContainText("```");

    // Alice sees the same proposal and accepts it.
    const aliceThread = alice.page.getByTestId("comment-thread").first();
    await expectSuggestionText(aliceThread.getByTestId("suggestion-text"), "unique");
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

    // One undo step restores both the text and the root decision.
    await alice.page.locator(".md-rich").click();
    await alice.page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => codeText(alice.page)).toContain("Our product is very unique.");
    await expect(alice.page.getByTestId("comments-tab-resolved")).not.toContainText("1");
    await expect(aliceThread).toHaveAttribute("data-suggestion", "pending");
    await expect(aliceThread.getByTestId("suggestion-accept-comment")).toBeVisible();
    await expect(aliceThread.getByTestId("suggestion-reject-comment")).toBeVisible();

    await alice.page.reload();
    await expect(alice.page.getByTestId("tb-redo")).toBeEnabled({ timeout: 5_000 });
    await ensureCommentsOpen(alice.page);
    await pressSourceHistory(alice.page, "redo");
    await expect.poll(() => codeText(alice.page)).toContain("Our product is unique.");
    await alice.page.getByTestId("comments-tab-resolved").click();
    await expect(aliceThread).toHaveAttribute("data-suggestion", "accepted");

    await alice.page.reload();
    await expect(alice.page.getByTestId("tb-undo")).toBeEnabled({ timeout: 5_000 });
    await pressSourceHistory(alice.page, "undo");
    await expect.poll(() => codeText(alice.page)).toContain("Our product is very unique.");
    await ensureCommentsOpen(alice.page);
    await expect(aliceThread).toHaveAttribute("data-suggestion", "pending");

    await alice.page.reload();
    await expect(alice.page.getByTestId("tb-redo")).toBeEnabled({ timeout: 5_000 });
    await ensureCommentsOpen(alice.page);
    await pressSourceHistory(alice.page, "redo");
    await expect.poll(() => codeText(alice.page)).toContain("Our product is unique.");
  });

  test("the composer's Suggest a change / Cancel / Comment sit on one row with single-line labels at every panel width", async () => {
    await freshDocument();
    const page = bob.page;
    const original = page.viewportSize()!;
    try {
      // 1280 and 1024 show the 340 px side panel; 800 is the tablet overlay (360 px). The label is icon-only in
      // all three (the container query shows it again from 21rem of composer width, e.g. the phone sheet).
      for (const [width, height] of [
        [1280, 800],
        [1024, 768],
        [800, 600],
      ] as const) {
        await page.setViewportSize({ width, height });
        await ensureCommentsOpen(page);
        await selectTextInRich(page, "very unique");
        await page.getByTestId("tb-comment").click();
        const composer = page.getByTestId("comment-composer");
        await expect(composer).toBeFocused();
        const suggest = page.getByTestId("comment-suggest-change");
        await expect(suggest).toBeVisible();
        const row = suggest.locator("xpath=..");
        const buttons = row.locator("button");
        await expect(buttons).toHaveCount(3);
        const boxes = [];
        for (const b of await buttons.all()) {
          const box = (await b.boundingBox())!;
          const { scrollHeight, clientHeight, label } = await b.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, label: el.textContent?.trim() }));
          boxes.push({ ...box, scrollHeight, clientHeight, label });
        }
        for (const box of boxes) {
          // One line of btn-sm: 32 px, and nothing wrapped inside it.
          expect(box.height, `${width}px: ${box.label} height`).toBeLessThanOrEqual(32);
          expect(box.scrollHeight, `${width}px: ${box.label} overflows`).toBeLessThanOrEqual(box.clientHeight);
          expect(Math.abs(box.y - boxes[0].y), `${width}px: ${box.label} on the same row`).toBeLessThanOrEqual(2);
        }
        // Still the real button: the tooltip and name carry the label when the row is too narrow for the text.
        await expect(suggest).toHaveAttribute("aria-label", "Suggest a change");
        await expect(suggest).toHaveAttribute("title", "Suggest a change (Ctrl+Shift+S)");
        await suggest.click();
        await expect(composer).toHaveValue("```suggestion\nvery unique\n```");
        await expect(suggest).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(composer).toHaveCount(0);
      }
    } finally {
      await page.setViewportSize(original);
    }
  });

  test("an agent reply suggestion has responsive actions, applies within one second, persists its exact decision, and undoes in one step", async ({}, testInfo) => {
    const docId = await freshDocument();
    const threadId = await addComment(bob.page, "sales are good", "Can Copilot tighten this?");
    const { id: replyId } = await mcp<{ id: string }>(alice.page, token, "markdoc_comment", {
      id: docId,
      action: "reply",
      threadId,
      body: "Yes — this is more direct.\n\n```suggestion\nsales are strong\n```",
    });
    const page = alice.page;
    const reply = () => page.locator(`[data-testid="comment-reply"][data-reply-id="${replyId}"]`);
    const expectReplyEditHidden = async () => {
      await reply().getByRole("button", { name: "Reply actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Edit", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
    };
    await expect(reply()).toHaveAttribute("data-state", "pending");

    for (const [width, height] of [
      [552, 1211],
      [1280, 800],
    ] as const) {
      await page.setViewportSize({ width, height });
      await ensureCommentsOpen(page);
      const box = reply().getByTestId("suggestion-box");
      await expect(box).toBeVisible();
      const boxMetrics = await box.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
      expect(boxMetrics.scrollWidth, `${width}px suggestion box overflow`).toBeLessThanOrEqual(boxMetrics.clientWidth);
      for (const [testId, label] of [
        ["suggestion-accept-comment", "Accept suggestion"],
        ["suggestion-reject-comment", "Reject"],
      ] as const) {
        const button = reply().getByTestId(testId);
        await expect(button).toBeVisible();
        await expect(button).toHaveText(label);
        const metrics = await button.evaluate((element) => ({
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          right: element.getBoundingClientRect().right,
        }));
        expect(metrics.scrollHeight, `${width}px ${label} wrapped`).toBeLessThanOrEqual(metrics.clientHeight);
        expect(metrics.right, `${width}px ${label} outside viewport`).toBeLessThanOrEqual(width);
      }
      if (width === 552) {
        const path = testInfo.outputPath("reply-suggestion-552x1211.png");
        await page.screenshot({ path });
        await testInfo.attach("reply-suggestion-552x1211", { path, contentType: "image/png" });
      }
    }

    const started = Date.now();
    await reply().getByTestId("suggestion-accept-comment").click();
    await expect.poll(() => codeText(page), { timeout: 1_000 }).toContain("sales are strong");
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(reply()).toHaveAttribute("data-state", "accepted");
    await expectSuggestionText(reply().getByTestId("suggestion-text"), "sales are strong");
    await expect(page.getByTestId("toast")).toContainText("Accepted suggestion from Copilot");
    await expect(page.getByTestId("toast-action")).toHaveText("Undo");
    await expectReplyEditHidden();

    const comments = (await (await page.request.get(`/api/documents/${docId}/comments`)).json()) as {
      comments: { id: string; replies: { id: string; suggestion: { state: string; source: string; at: string | null } | null }[] }[];
    };
    expect(comments.comments.find((thread) => thread.id === threadId)?.replies.find((item) => item.id === replyId)?.suggestion).toMatchObject({
      state: "accepted",
      source: "sales are good",
      at: expect.any(String),
    });
    const activity = (await (await page.request.get(`/api/documents/${docId}/activity?limit=200`)).json()) as {
      items: { action: string; detail: { replyId?: string; threadId?: string } }[];
    };
    expect(activity.items.filter((item) => item.action === "comment.suggestion.accepted" && item.detail.replyId === replyId)).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ threadId, replyId }) }),
    ]);

    await page.getByTestId("toast-action").click();
    await expect.poll(() => codeText(page)).toContain("sales are good");
    await expect(reply()).toHaveAttribute("data-state", "pending");
    await expect(reply().getByTestId("suggestion-accept-comment")).toBeVisible();
    await expect(reply().getByTestId("suggestion-reject-comment")).toBeVisible();
    await expect
      .poll(async () => {
        const undone = (await (await page.request.get(`/api/documents/${docId}/comments`)).json()) as {
          comments: { id: string; quote: string; currentText: string | null }[];
        };
        return undone.comments.find((thread) => thread.id === threadId);
      })
      .toMatchObject({ quote: "sales are good", currentText: "sales are good" });

    await page.reload();
    await expect(page.getByTestId("tb-redo")).toBeEnabled({ timeout: 5_000 });
    await ensureCommentsOpen(page);
    await pressSourceHistory(page, "redo");
    await expect.poll(() => codeText(page)).toContain("sales are strong");
    await expect(reply()).toHaveAttribute("data-state", "accepted");
    await expectSuggestionText(reply().getByTestId("suggestion-text"), "sales are strong");

    await page.reload();
    await expect(page.getByTestId("tb-undo")).toBeEnabled({ timeout: 5_000 });
    await ensureCommentsOpen(page);
    await pressSourceHistory(page, "undo");
    await expect.poll(() => codeText(page)).toContain("sales are good");
    await expect(reply()).toHaveAttribute("data-state", "pending");
    await page.reload();
    await expect(page.getByTestId("tb-redo")).toBeEnabled({ timeout: 5_000 });
    await ensureCommentsOpen(page);
    await pressSourceHistory(page, "redo");
    await expect.poll(() => codeText(page)).toContain("sales are strong");
    await expect(reply()).toHaveAttribute("data-state", "accepted");
    await page.getByTestId("tb-undo").click();
    await expect.poll(() => codeText(page)).toContain("sales are good");
    await expect(reply()).toHaveAttribute("data-state", "pending");
    await expectSuggestionText(reply().getByTestId("suggestion-text"), "sales are strong");
    await expect(reply().getByTestId("suggestion-accept-comment")).toBeVisible();
    await expect(reply().getByTestId("suggestion-reject-comment")).toBeVisible();
  });

  test("reply suggestions stay independent in bulk review; outdated replies can be rejected once", async () => {
    const docId = await freshDocument();
    const page = alice.page;
    const bulkThreadId = await addComment(bob.page, "very unique", "Give me two alternatives.");
    const first = await mcp<{ id: string }>(page, token, "markdoc_comment", {
      id: docId,
      action: "reply",
      threadId: bulkThreadId,
      body: "First option.\n\n```suggestion\nunique\n```",
    });
    const second = await mcp<{ id: string }>(page, token, "markdoc_comment", {
      id: docId,
      action: "reply",
      threadId: bulkThreadId,
      body: "Second option.\n\n```suggestion\ndistinctive\n```",
    });

    await page.getByTestId("comments-tab-suggestions").click();
    await expect(page.getByTestId("comments-tab-suggestions")).toHaveText(/Suggestions\s*2$/);
    await page.getByTestId("accept-all").click();
    await expect.poll(() => codeText(page)).toContain("Our product is distinctive.");
    await page.getByTestId("comments-tab-open").click();
    const bulkThread = page.locator(`[data-testid="comment-thread"][data-thread-id="${bulkThreadId}"]`);
    const firstReply = bulkThread.locator(`[data-reply-id="${first.id}"]`);
    const secondReply = bulkThread.locator(`[data-reply-id="${second.id}"]`);
    await expect(firstReply).toHaveAttribute("data-state", "accepted");
    await expect(secondReply).toHaveAttribute("data-state", "accepted");
    await expectSuggestionText(firstReply.getByTestId("suggestion-text"), "unique");
    await expectSuggestionText(secondReply.getByTestId("suggestion-text"), "distinctive");
    await page.reload();
    await ensureCommentsOpen(page);
    await page.getByTestId("comments-tab-open").click();
    const reloadedBulkThread = page.locator(`[data-testid="comment-thread"][data-thread-id="${bulkThreadId}"]`);
    await expectSuggestionText(reloadedBulkThread.locator(`[data-reply-id="${first.id}"]`).getByTestId("suggestion-text"), "unique");
    await expectSuggestionText(reloadedBulkThread.locator(`[data-reply-id="${second.id}"]`).getByTestId("suggestion-text"), "distinctive");

    const staleThreadId = await addComment(bob.page, "sales are good", "Can this be stronger?");
    const stale = await mcp<{ id: string }>(page, token, "markdoc_comment", {
      id: docId,
      action: "reply",
      threadId: staleThreadId,
      body: "Try this.\n\n```suggestion\nsales are excellent\n```",
    });
    const staleReply = page.locator(`[data-testid="comment-reply"][data-reply-id="${stale.id}"]`);
    await expect(staleReply).toHaveAttribute("data-state", "pending");
    await selectTextInRich(page, "good");
    await page.keyboard.type("okay");
    await expect.poll(() => codeText(page)).toContain("sales are okay");
    await expect(staleReply).toHaveAttribute("data-state", "outdated");
    await expect(staleReply.getByTestId("suggestion-accept-comment")).toBeDisabled();
    await expect(staleReply.getByTestId("suggestion-reject-comment")).toBeEnabled();

    const staleAccept = await page.request.post(`/api/documents/${docId}/comments`, {
      data: { action: "suggestion", threadId: staleThreadId, replyId: stale.id, decision: "accept" },
    });
    expect(staleAccept.status()).toBe(409);
    await staleReply.getByTestId("suggestion-reject-comment").click();
    await expect(staleReply).toHaveAttribute("data-state", "rejected");
    expect(await codeText(page)).toContain("sales are okay");
    const repeat = await page.request.post(`/api/documents/${docId}/comments`, {
      data: { action: "suggestion", threadId: staleThreadId, replyId: stale.id, decision: "reject" },
    });
    expect(repeat.status()).toBe(409);
    await page.reload();
    await ensureCommentsOpen(page);
    await expect(page.locator(`[data-testid="comment-reply"][data-reply-id="${stale.id}"]`)).toHaveAttribute("data-state", "rejected");
  });

  test("an accepted root keeps its proposed text while a pending reply follows the advanced anchor", async () => {
    const docId = await freshDocument();
    const page = bob.page;
    await selectTextInRich(page, "sales are good");
    await page.getByTestId("tb-comment").click();
    await page.getByTestId("comment-composer").fill("Root option.\n\n```suggestion\nsales are strong\n```");
    await page.keyboard.press("ControlOrMeta+Enter");
    const authoredThread = page.getByTestId("comment-thread").filter({ hasText: "Root option." }).first();
    await expect(authoredThread).toBeVisible();
    const threadId = (await authoredThread.getAttribute("data-thread-id"))!;
    const reply = await mcp<{ id: string }>(alice.page, token, "markdoc_comment", {
      id: docId,
      action: "reply",
      threadId,
      body: "Another option.\n\n```suggestion\nsales are excellent\n```",
    });

    const thread = alice.page.locator(`[data-testid="comment-thread"][data-thread-id="${threadId}"]`);
    await thread.getByTestId("suggestion-box").first().getByTestId("suggestion-accept-comment").click();
    await expect.poll(() => codeText(alice.page)).toContain("sales are strong");
    await alice.page.getByTestId("comments-tab-resolved").click();
    await expect(thread).toHaveAttribute("data-suggestion", "accepted");
    const replyCard = thread.locator(`[data-reply-id="${reply.id}"]`);
    await expect(replyCard).toHaveAttribute("data-state", "pending");
    await expectSuggestionText(thread.getByTestId("suggestion-text").first(), "sales are strong");
    await expectSuggestionText(replyCard.getByTestId("suggestion-text"), "sales are excellent");

    await alice.page.reload();
    await ensureCommentsOpen(alice.page);
    const reloaded = alice.page.locator(`[data-testid="comment-thread"][data-thread-id="${threadId}"]`);
    await expectSuggestionText(reloaded.getByTestId("suggestion-text").first(), "sales are strong");
    await expectSuggestionText(reloaded.locator(`[data-reply-id="${reply.id}"]`).getByTestId("suggestion-text"), "sales are excellent");
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
          const w = await mcp<{ cursor: string; events: { type: string; threadId?: string | null }[] }>(page, token, "markdoc_watch", {
            id: docId,
            since: watch0.cursor,
            wait: 1,
            includeSelf: true,
          });
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

  test("a viewer sees the suggested text and the review card without Accept / Reject", async ({ browser }) => {
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
    const replyThreadId = await addComment(bob.page, "We launched recently", "Could an agent tighten this?");
    const reply = await mcp<{ id: string }>(alice.page, token, "markdoc_comment", {
      id: docId,
      action: "reply",
      threadId: replyThreadId,
      body: "Yes.\n\n```suggestion\nWe launched in March\n```",
    });

    await shareWith(alice.page, docId, "carol", "viewer");
    const carol = await signIn(browser, "carol");
    try {
      await openDocument(carol.page, docId);
      await ensureCommentsOpen(carol.page);
      await carol.page.getByTestId("comments-tab-open").click();
      const thread = carol.page.getByTestId("comment-thread").filter({ hasText: "sales are" }).first();
      await expect(thread).toHaveAttribute("data-suggestion", "pending");
      await expectSuggestionText(thread.getByTestId("suggestion-text"), "sales are strong");
      await expect(thread.getByTestId("suggestion-accept-comment")).toHaveCount(0);
      await expect(thread.getByTestId("suggestion-reject-comment")).toHaveCount(0);
      const replySuggestion = carol.page.locator(`[data-testid="comment-reply"][data-reply-id="${reply.id}"]`);
      await expect(replySuggestion).toHaveAttribute("data-state", "pending");
      await expectSuggestionText(replySuggestion.getByTestId("suggestion-text"), "We launched in March");
      await expect(replySuggestion.getByTestId("suggestion-accept-comment")).toHaveCount(0);
      await expect(replySuggestion.getByTestId("suggestion-reject-comment")).toHaveCount(0);
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
