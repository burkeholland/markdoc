import { test, expect } from "@playwright/test";
import { signIn, createDocument, openDocument, shareWith, codeText, richText, focusRichEnd, focusCodeEnd, selectTextInRich, ensureCommentsOpen, type User } from "./helpers";
import { LONG_DOC, h2Texts } from "./fixtures/burke-scale";

test.describe("collaboration between two users", () => {
  let alice: User;
  let bob: User;
  let docId: string;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
    bob = await signIn(browser, "bob");
    docId = await createDocument(alice.page, "# Shared doc\n\nFirst paragraph.\n");
    await shareWith(alice.page, docId, "bob", "editor");
    await openDocument(alice.page, docId);
    await openDocument(bob.page, docId);
  });

  test.afterAll(async () => {
    await alice.context.close();
    await bob.context.close();
  });

  test("both users are present and see each other's edits on both surfaces", async () => {
    await expect(alice.page.getByTestId("presence").locator(".avatar")).toHaveCount(2);
    await expect(bob.page.getByTestId("presence").locator(".avatar")).toHaveCount(2);

    // Alice types in the rich pane; Bob sees it in both panes.
    await focusRichEnd(alice.page);
    await alice.page.keyboard.type(" Alice was here.");
    await expect.poll(() => codeText(bob.page)).toContain("First paragraph. Alice was here.");
    await expect.poll(() => richText(bob.page)).toContain("Alice was here.");

    // Bob types in the code pane; Alice sees it rendered.
    await focusCodeEnd(bob.page);
    await bob.page.keyboard.type("\n\n## Bob's section\n\nBob typed this.");
    await expect(alice.page.locator(".md-rich h2").last()).toHaveText("Bob's section");
    await expect.poll(() => codeText(alice.page)).toContain("Bob typed this.");

    // Alice's caret (from the rich pane) is visible in Bob's editors.
    await expect(bob.page.locator(".md-remote-caret").first()).toBeVisible();
    await expect(bob.page.locator(".cm-ySelectionCaret").first()).toBeVisible();
    await expect(bob.page.locator(".md-remote-caret-label").first()).toHaveText("alice");
  });

  test("concurrent edits in different places merge and converge", async () => {
    // Alice types at the end in the rich pane while Bob types at the start of the code pane.
    await focusRichEnd(alice.page);
    await bob.page.locator(".cm-content").click();
    await bob.page.keyboard.press("Control+Home");
    await bob.page.keyboard.press("End");
    await Promise.all([alice.page.keyboard.type(" AAAA", { delay: 30 }), bob.page.keyboard.type(" BBBB", { delay: 30 })]);
    await expect.poll(() => codeText(alice.page)).toContain("AAAA");
    await expect.poll(() => codeText(alice.page)).toContain("# Shared doc BBBB");
    await expect.poll(() => codeText(bob.page)).toContain("AAAA");
    await expect.poll(async () => (await codeText(alice.page)) === (await codeText(bob.page))).toBe(true);
    await expect.poll(() => richText(alice.page)).toContain("Shared doc BBBB");
  });

  test("comments are anchored, synced, replied to and resolved", async () => {
    await selectTextInRich(alice.page, "First paragraph");
    await alice.page.getByTestId("tb-comment").click();
    await alice.page.getByTestId("comment-composer").fill("Can we expand this?");
    await alice.page.getByTestId("comment-submit").click();
    await expect(alice.page.getByTestId("comment-thread")).toHaveCount(1);
    await expect(alice.page.locator(".md-rich .md-comment").first()).toBeVisible();
    await expect(alice.page.locator(".cm-content .md-comment").first()).toBeVisible();

    // Bob sees the thread and the highlight, and replies.
    await expect(bob.page.getByTestId("comments-badge")).toHaveText("1");
    await ensureCommentsOpen(bob.page);
    await expect(bob.page.getByTestId("comment-thread")).toContainText("Can we expand this?");
    await expect(bob.page.locator(".md-rich .md-comment").first()).toBeVisible();
    await bob.page.getByTestId("comment-reply").click();
    await bob.page.getByTestId("comment-composer").fill("Sure, on it.");
    await bob.page.getByTestId("comment-submit").click();
    await expect(alice.page.getByTestId("comment-thread")).toContainText("Sure, on it.");

    // The anchor follows the text when someone types before it.
    await alice.page.locator(".md-rich h1").click();
    await alice.page.keyboard.press("Home");
    await alice.page.keyboard.type("Our ");
    await expect.poll(() => codeText(bob.page)).toContain("# Our Shared doc");
    await expect(bob.page.locator(".md-rich .md-comment").first()).toContainText("First paragraph");

    // Resolve from Bob's side; Alice sees it move to resolved.
    await bob.page.getByTestId("comment-resolve").click();
    await expect(alice.page.getByTestId("comments-badge")).toHaveCount(0);
    await alice.page.getByTestId("comments-tab-resolved").click();
    await expect(alice.page.getByTestId("comment-thread")).toContainText("Resolved");
  });

  test("suggesting mode produces tracked changes that can be accepted or rejected", async () => {
    // Bob switches to suggesting and edits.
    await bob.page.getByTestId("mode-switcher").click();
    await bob.page.getByRole("menuitemradio", { name: /Suggesting/ }).click();
    await expect(bob.page.getByTestId("mode-switcher")).toContainText("Suggesting");

    await focusRichEnd(bob.page);
    await bob.page.keyboard.type(" Suggested text.");
    await expect(bob.page.locator(".md-rich .md-suggest-insert").first()).toContainText("Suggested text.");
    await expect(alice.page.locator(".md-rich .md-suggest-insert").first()).toContainText("Suggested text.");
    await expect(alice.page.locator(".cm-content .md-suggest-insert").first()).toBeVisible();

    // Bob deletes a word in the code pane while suggesting: text stays, struck through.
    await bob.page.locator(".cm-content").click();
    const before = await codeText(bob.page);
    await bob.page.keyboard.press("Control+Home");
    await bob.page.keyboard.press("End");
    for (let i = 0; i < 4; i++) await bob.page.keyboard.press("Backspace");
    await expect.poll(() => codeText(bob.page)).toBe(before);
    await expect(alice.page.locator(".cm-content .md-suggest-delete").first()).toHaveText("BBBB");

    // Alice reviews: rejects the deletion, accepts the insertion.
    await ensureCommentsOpen(alice.page);
    await alice.page.getByTestId("comments-tab-suggestions").click();
    await expect(alice.page.getByTestId("suggestion-card")).toHaveCount(2);
    const deleteCard = alice.page.getByTestId("suggestion-card").filter({ hasText: "Delete:" });
    await deleteCard.getByTestId("suggestion-reject").click();
    await expect(alice.page.getByTestId("suggestion-card")).toHaveCount(1);
    await expect.poll(() => codeText(alice.page)).toContain("# Our Shared doc BBBB");
    await alice.page.getByTestId("suggestion-card").getByTestId("suggestion-accept").click();
    await expect(alice.page.getByTestId("suggestion-card")).toHaveCount(0);
    await expect.poll(() => codeText(alice.page)).toContain("Suggested text.");
    await expect(alice.page.locator(".md-suggest-insert")).toHaveCount(0);
    await expect(bob.page.locator(".md-suggest-insert")).toHaveCount(0);

    // Back to editing for Bob.
    await bob.page.getByTestId("mode-switcher").click();
    await bob.page.getByRole("menuitemradio", { name: /^Editing/ }).click();
  });

  test("commenters can comment (through the API) but not edit", async ({ browser }) => {
    const carol = await signIn(browser, "carol-commenter");
    await shareWith(alice.page, docId, "carol-commenter", "commenter");
    await openDocument(carol.page, docId);
    await expect(carol.page.locator(".md-rich")).toHaveAttribute("contenteditable", "false");
    await expect(carol.page.getByTestId("tb-comment")).toBeVisible();

    // Commenters read comments through the API too. This is also the first request to the
    // comments route in the suite, so give the dev server's on-demand compile room here rather
    // than inside the 15s UI expectations below.
    const list = await carol.page.request.get(`/api/documents/${docId}/comments`, { timeout: 60_000 });
    expect(list.ok()).toBeTruthy();
    expect(Array.isArray(((await list.json()) as { comments: unknown[] }).comments)).toBeTruthy();

    await selectTextInRich(carol.page, "First paragraph");
    await carol.page.getByTestId("tb-comment").click();
    await carol.page.getByTestId("comment-composer").fill("Nice section, Bob.");
    await carol.page.getByTestId("comment-submit").click();
    await expect(carol.page.getByTestId("comment-thread").filter({ hasText: "Nice section, Bob." })).toBeVisible();
    await expect(carol.page.locator(".md-rich .md-comment").filter({ hasText: "First paragraph" })).toBeVisible();

    // The thread reached the other collaborators through the server.
    await ensureCommentsOpen(alice.page);
    await alice.page.getByTestId("comments-tab-open").click();
    await expect(alice.page.getByTestId("comment-thread").filter({ hasText: "Nice section, Bob." })).toBeVisible();
    await carol.context.close();
  });

  test("viewers get a read-only document", async ({ browser }) => {
    const carol = await signIn(browser, "carol");
    await shareWith(alice.page, docId, "carol", "viewer");
    await openDocument(carol.page, docId);
    await expect(carol.page.getByTestId("mode-switcher")).toContainText("Viewing");
    await expect(carol.page.getByTestId("tb-bold")).toBeDisabled();
    await expect(carol.page.locator(".md-rich")).toHaveAttribute("contenteditable", "false");
    const before = await codeText(carol.page);
    await carol.page.locator(".cm-content").click();
    await carol.page.keyboard.type("nope");
    await carol.page.waitForTimeout(300);
    expect(await codeText(carol.page)).toBe(before);
    await carol.context.close();
  });

  test("unshared users cannot open the document", async ({ browser }) => {
    const dave = await signIn(browser, "dave");
    const res = await dave.page.request.get(`/api/documents/${docId}`);
    expect(res.status()).toBe(404);
    await dave.page.goto(`/d/${docId}`);
    await expect(dave.page.getByText(/not found|could not be found/i)).toBeVisible();
    await dave.context.close();
  });
});

/**
 * The same presence / cross-surface / caret checks on the Burke-scale document (~12k words, 40 H2
 * sections; e2e/fixtures/burke-scale.ts). The small-document suite above keeps the assertions that
 * need a known first line ("# Shared doc BBBB"); this one proves the live session behaves the same
 * when the text is 1,200 lines long.
 */
test.describe("collaboration on a Burke-scale document", () => {
  let alice: User;
  let bob: User;
  let docId: string;
  const lastH2 = h2Texts(LONG_DOC)[39];

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice-scale");
    bob = await signIn(browser, "bob-scale");
    docId = await createDocument(alice.page, LONG_DOC);
    await shareWith(alice.page, docId, "bob-scale", "editor");
    await openDocument(alice.page, docId);
    await openDocument(bob.page, docId);
  });

  test.afterAll(async () => {
    await alice.context.close();
    await bob.context.close();
  });

  test("both users are present and see each other's edits on both surfaces", async () => {
    await expect(alice.page.getByTestId("presence").locator(".avatar")).toHaveCount(2);
    await expect(bob.page.getByTestId("presence").locator(".avatar")).toHaveCount(2);
    expect(await codeText(bob.page)).toBe(LONG_DOC);

    // Alice types at the end of the rich pane; Bob sees it in both panes.
    await focusRichEnd(alice.page);
    await alice.page.keyboard.type(" Alice was here.");
    await expect.poll(() => codeText(bob.page)).toContain("Alice was here.");
    await expect.poll(() => richText(bob.page)).toContain("Alice was here.");

    // Bob adds a 41st section in the code pane; Alice's preview and outline pick it up.
    await focusCodeEnd(bob.page);
    await bob.page.keyboard.type("\n\n## 41. Bob's section\n\nBob typed this.");
    await expect(alice.page.locator(".md-rich h2").last()).toHaveText("41. Bob's section");
    await expect(alice.page.locator(".md-rich h2")).toHaveCount(41);
    await expect(alice.page.getByTestId("outline").locator("[data-outline-item]").filter({ hasText: "41. Bob's section" })).toHaveCount(1);
    await expect.poll(() => codeText(alice.page)).toContain("Bob typed this.");
    // The previous last heading is still there and nothing doubled.
    expect((await codeText(alice.page)).split(`## ${lastH2}`).length - 1).toBe(1);

    // Carets: Alice's (from the rich pane) in Bob's editors, both at the end where Bob is looking.
    await expect(bob.page.locator(".md-remote-caret").first()).toBeVisible();
    await expect(bob.page.locator(".cm-ySelectionCaret").first()).toBeVisible();
    await expect(bob.page.locator(".md-remote-caret-label").first()).toHaveText("alice-scale");
  });
});


