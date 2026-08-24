import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, shareWith, selectTextInRich, ensureCommentsOpen, codeText, type User } from "./helpers";

/** JSON-RPC over /api/mcp, the way Copilot CLI calls the HTTP server. */
async function mcp<T>(page: Page, token: string, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await page.request.post("/api/mcp", {
    headers: { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(res.ok(), `${name} -> ${res.status()} ${await res.text()}`).toBeTruthy();
  const text = await res.text();
  // Streamable HTTP may answer as SSE; the JSON-RPC result is the last `data:` line.
  const line = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5) : text;
  const body = JSON.parse(line) as { result: { structuredContent?: T; content: { text: string }[]; isError?: boolean } };
  expect(body.result.isError, body.result.content?.[0]?.text).toBeFalsy();
  return (body.result.structuredContent ?? JSON.parse(body.result.content[0].text)) as T;
}

test.describe("review suggestions: ```suggestion blocks in comments, Accept / Reject, agent reviews", () => {
  let alice: User;
  let bob: User;
  let docId: string;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
    bob = await signIn(browser, "bob");
    docId = await createDocument(alice.page, "# Review me\n\nOur product is very unique.\n\nWe launched recently and sales are good.\n\nThe end is near.\n", "Review me");
    await shareWith(alice.page, docId, "bob", "editor");
    await openDocument(alice.page, docId);
    await openDocument(bob.page, docId);
    await ensureCommentsOpen(alice.page);
    await ensureCommentsOpen(bob.page);
  });

  test.afterAll(async () => {
    await alice.context.close();
    await bob.context.close();
  });

  test("Suggest a change pre-fills the quote; the thread shows a diff; Accept replaces the text, resolves, and Ctrl+Z undoes it in one step", async () => {
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
    await expect(alice.page.getByTestId("toast")).toContainText("Accepted suggestion from Bob");
    // Accepting resolves the thread (it moves to the Resolved tab).
    await expect(alice.page.getByTestId("comments-tab-resolved")).toContainText("1");
    await alice.page.getByTestId("comments-tab-resolved").click();
    await expect(alice.page.getByTestId("comment-thread").first()).toHaveAttribute("data-suggestion", "accepted");
    await alice.page.getByTestId("comments-tab-open").click();

    // One undo step in the editor restores the text and the thread.
    await alice.page.locator(".md-rich").click();
    await alice.page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => codeText(alice.page)).toContain("Our product is very unique.");
    await expect(alice.page.getByTestId("comments-tab-open")).toContainText("1");
  });

  test("Reject keeps the text; editing the quoted text first marks the suggestion Outdated and disables Accept", async () => {
    const page = alice.page;
    // Reject the (undone, so pending again) first suggestion.
    const first = page.getByTestId("comment-thread").first();
    await first.getByTestId("suggestion-reject-comment").click();
    await expect(first).toHaveAttribute("data-suggestion", "rejected");
    expect(await codeText(page)).toContain("Our product is very unique.");
    await expect(first.getByTestId("suggestion-accept-comment")).toHaveCount(0);

    // Bob suggests on "sales are good"; Alice edits that text before deciding.
    await selectTextInRich(bob.page, "sales are good");
    await bob.page.getByTestId("tb-comment").click();
    await bob.page.keyboard.press("ControlOrMeta+Shift+s");
    const composer = bob.page.getByTestId("comment-composer");
    await expect(composer).toHaveValue("```suggestion\nsales are good\n```");
    await bob.page.keyboard.type("sales are strong");
    await bob.page.keyboard.press("ControlOrMeta+Enter");

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
    const page = alice.page;
    const res = await page.request.post("/api/tokens", { data: { name: "Copilot", expiresInDays: 30 } });
    expect(res.ok()).toBeTruthy();
    const token = ((await res.json()) as { token: { token: string } }).token.token;

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

    // The comment author (Alice's token acts for Alice, so she is the actor) is not notified of her own acceptance;
    // the bell still shows the review notification is suppressed for the owner acting on herself.
    const comments = (await (await page.request.get(`/api/documents/${docId}/comments`)).json()) as { comments: { id: string; suggestion: { state: string } | null }[] };
    const accepted = comments.comments.find((c) => c.id === review.threadIds[0]);
    expect(accepted?.suggestion?.state).toBe("accepted");
  });

  test("a viewer sees the suggestion diff without Accept / Reject", async ({ browser }) => {
    await shareWith(alice.page, docId, "carol", "viewer");
    const carol = await signIn(browser, "carol");
    try {
      await openDocument(carol.page, docId);
      await ensureCommentsOpen(carol.page);
      await carol.page.getByTestId("comments-tab-open").click();
      const thread = carol.page.getByTestId("comment-thread").filter({ hasText: "sales are" }).first();
      await expect(thread.getByTestId("suggestion-diff")).toBeVisible();
      await expect(thread.getByTestId("suggestion-accept-comment")).toHaveCount(0);
      await expect(thread.getByTestId("suggestion-reject-comment")).toHaveCount(0);
      await expect(carol.page.getByTestId("review-card").first()).toBeVisible();
      await expect(carol.page.getByTestId("review-accept-all")).toHaveCount(0);
    } finally {
      await carol.context.close();
    }
  });
});
