import { test, expect } from "@playwright/test";
import { signIn, createDocument, openDocument, shareWith, selectTextInRich, ensureCommentsOpen, type User } from "./helpers";

test.describe("rich comments: Markdown, shortcuts, reactions, edited marker", () => {
  let alice: User;
  let bob: User;
  let docId: string;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
    bob = await signIn(browser, "bob");
    docId = await createDocument(alice.page, "# Rich comments\n\nFirst paragraph.\n", "Rich comments");
    await shareWith(alice.page, docId, "bob", "editor");
    await openDocument(alice.page, docId);
    await openDocument(bob.page, docId);
    await ensureCommentsOpen(bob.page);
  });

  test.afterAll(async () => {
    await alice.context.close();
    await bob.context.close();
  });

  test("renders **bold** and [links](…) in a comment, Ctrl+B wraps the selection", async () => {
    await selectTextInRich(alice.page, "First paragraph");
    await alice.page.getByTestId("tb-comment").click();
    const composer = alice.page.getByTestId("comment-composer");
    await expect(composer).toBeFocused();
    // Nothing is rendered under the box (#984): the shortcuts live in the send button's tooltip.
    await expect(alice.page.getByTestId("comment-format-hint")).toHaveCount(0);
    await expect(alice.page.getByText("Shift+Enter newline")).toHaveCount(0);

    await alice.page.keyboard.type("Please read the docs");
    // Select "docs" and make it bold with the shortcut.
    await composer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length - 4, el.value.length));
    await alice.page.keyboard.press("ControlOrMeta+b");
    await expect(composer).toHaveValue("Please read the **docs**");
    await expect(composer).toBeFocused();
    // The selection stays on the word, so typing would replace it; move to the end and add a link.
    await composer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
    await alice.page.keyboard.type(" at [example](https://example.com) today");
    // Shift+Enter is a newline; Enter sends.
    await alice.page.keyboard.press("Shift+Enter");
    await alice.page.keyboard.type("second line");
    await alice.page.keyboard.press("Enter");

    const thread = alice.page.getByTestId("comment-thread");
    await expect(thread).toHaveCount(1);
    const body = thread.getByTestId("comment-body");
    await expect(body.locator("strong")).toHaveText("docs");
    const link = body.locator("a");
    await expect(link).toHaveText("example");
    await expect(link).toHaveAttribute("href", "https://example.com");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    await expect(body.locator("br")).toHaveCount(1);
    await expect(body).toContainText("second line");
    // No edited marker on a fresh comment; the raw body is what the API returns.
    await expect(thread.getByTestId("comment-edited")).toHaveCount(0);
    const res = await alice.page.request.get(`/api/documents/${docId}/comments`);
    const { comments } = (await res.json()) as { comments: { body: string }[] };
    expect(comments[0].body).toBe("Please read the **docs** at [example](https://example.com) today\nsecond line");

    // Bob sees the same rendering live.
    await expect(bob.page.getByTestId("comment-thread").getByTestId("comment-body").locator("strong")).toHaveText("docs");
  });

  test("reactions from two browsers aggregate into one chip and toggle off", async () => {
    const aliceThread = alice.page.getByTestId("comment-thread").first();
    const bobThread = bob.page.getByTestId("comment-thread").first();
    const aliceRow = aliceThread.getByTestId("reaction-row").first();
    const bobRow = bobThread.getByTestId("reaction-row").first();

    await aliceRow.getByTestId("reaction-add").click();
    await alice.page.getByTestId("reaction-picker").locator('[data-emoji="👍"]').click();
    const aliceChip = aliceRow.getByTestId("reaction-chip");
    await expect(aliceChip).toHaveCount(1);
    await expect(aliceChip).toHaveText("👍 1");
    await expect(aliceChip).toHaveAttribute("data-mine", "true");

    // Bob sees Alice's reaction (not highlighted) and adds his own by clicking the chip.
    const bobChip = bobRow.getByTestId("reaction-chip");
    await expect(bobChip).toHaveText("👍 1");
    await expect(bobChip).not.toHaveAttribute("data-mine", "true");
    await bobChip.click();
    await expect(bobChip).toHaveText("👍 2");
    await expect(bobChip).toHaveAttribute("data-mine", "true");
    await expect(aliceChip).toHaveText("👍 2");
    await expect(aliceChip).toHaveAttribute("title", /alice/i);
    await expect(aliceChip).toHaveAttribute("title", /bob/i);

    // Un-react from Bob's side.
    await bobChip.click();
    await expect(bobChip).toHaveText("👍 1");
    await expect(aliceChip).toHaveText("👍 1");
    await expect(aliceChip).toHaveAttribute("data-mine", "true");
  });

  test("editing a comment shows (edited) with the time in the tooltip", async () => {
    const thread = alice.page.getByTestId("comment-thread").first();
    await thread.getByRole("button", { name: "Comment actions" }).click();
    await alice.page.getByRole("menuitem", { name: "Edit" }).click();
    const composer = thread.getByTestId("comment-composer");
    await expect(composer).toHaveValue(/Please read the/);
    // The menu hands focus back to its trigger when it closes; click into the editor explicitly.
    await composer.click();
    await expect(composer).toBeFocused();
    await composer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
    await alice.page.keyboard.type(" — `fixed`");
    await alice.page.keyboard.press("Enter");

    const edited = thread.getByTestId("comment-edited");
    await expect(edited).toHaveText("(edited)");
    await expect(edited).toHaveAttribute("title", /^Edited /);
    await expect(thread.getByTestId("comment-body").locator("code")).toHaveText("fixed");
    // The reaction survived the edit and Bob sees the marker too.
    await expect(thread.getByTestId("reaction-chip")).toHaveText("👍 1");
    await expect(bob.page.getByTestId("comment-thread").first().getByTestId("comment-edited")).toBeVisible();
  });

  test("an agent token can react through the API and the chip appears live", async () => {
    const created = await bob.page.request.post("/api/tokens", { data: { name: "Review Bot" } });
    expect(created.ok()).toBeTruthy();
    const { token } = (await created.json()) as { token: { token: string } };
    const list = await bob.page.request.get(`/api/documents/${docId}/comments`);
    type Listed = { comments: { id: string; reactions: Record<string, string[]> }[] };
    let { comments } = (await list.json()) as Listed;
    if (comments.length === 0) {
      // A failed earlier test restarts the worker with a fresh document; recreate the state we need.
      await alice.page.request.post(`/api/documents/${docId}/comments`, { data: { action: "add", quote: "First paragraph", body: "React to me" } });
      const { id } = ((await (await alice.page.request.get(`/api/documents/${docId}/comments`)).json()) as Listed).comments[0];
      await alice.page.request.post(`/api/documents/${docId}/comments`, { data: { action: "react", threadId: id, emoji: "👍" } });
      ({ comments } = (await (await bob.page.request.get(`/api/documents/${docId}/comments`)).json()) as Listed);
      await ensureCommentsOpen(alice.page);
    }
    expect(comments[0].reactions["👍"]).toHaveLength(1);

    const reacted = await bob.page.request.post(`/api/documents/${docId}/comments`, {
      headers: { Authorization: `Bearer ${token.token}` },
      data: { action: "react", threadId: comments[0].id, emoji: "🚀" },
      timeout: 60_000,
    });
    expect(reacted.ok()).toBeTruthy();
    expect(await reacted.json()).toEqual({ ok: true, reacted: true });

    const aliceRow = alice.page.getByTestId("comment-thread").first().getByTestId("reaction-row").first();
    const rocket = aliceRow.locator('[data-testid=reaction-chip][data-emoji="🚀"]');
    await expect(rocket).toHaveText("🚀 1");
    await expect(rocket).not.toHaveAttribute("data-mine", "true");
    // Reactions never notify: Alice's bell stays quiet about it.
    const notes = await alice.page.request.get("/api/notifications?unread=1");
    const { items } = (await notes.json()) as { items: { refId: string; kind: string }[] };
    expect(items.filter((n) => n.refId === comments[0].id)).toEqual([]);

    // Toggling again through the API removes it.
    const undone = await bob.page.request.post(`/api/documents/${docId}/comments`, {
      headers: { Authorization: `Bearer ${token.token}` },
      data: { action: "react", threadId: comments[0].id, emoji: "🚀" },
    });
    expect(await undone.json()).toEqual({ ok: true, reacted: false });
    await expect(rocket).toHaveCount(0);
  });
});
