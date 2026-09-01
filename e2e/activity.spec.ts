import { test, expect } from "./fixtures";
import { signIn, createDocument, openDocument, shareWith, focusRichEnd, selectTextInRich, mintToken, type MintedToken, type User } from "./helpers";

async function openActivity(page: User["page"]) {
  await page.getByTestId("more-menu").click();
  await page.getByTestId("menu-activity").click();
  await expect(page.getByTestId("activity-panel")).toBeVisible();
}

async function closeActivity(page: User["page"]) {
  await page.getByRole("button", { name: "Close activity" }).click();
  await expect(page.getByTestId("activity-panel")).toBeHidden();
}

test.describe("activity panel", () => {
  let alice: User;
  let bob: User;
  let docId: string;
  let minted: MintedToken | undefined;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
    bob = await signIn(browser, "bob");
    docId = await createDocument(alice.page, "# Activity doc\n\nFirst paragraph.\n", "Activity doc");
    await openDocument(alice.page, docId);
  });

  test.afterAll(async () => {
    await minted?.revoke();
    await alice.context.close();
    await bob.context.close();
  });

  test("edits, comments and versions show up in order with readable sentences", async () => {
    // First request to the activity route compiles it on demand; keep that out of the timed assertions below.
    const warm = await alice.page.request.get(`/api/documents/${docId}/activity`, { timeout: 60_000 });
    expect(warm.ok()).toBeTruthy();

    // Typing in the editor becomes one coalesced "edit" row once the server stores the change.
    // Wait until every typed character is accounted for: the watcher flushes on a timer, so on a
    // slow machine the text can land in two flushes, and a late flush after the comment below
    // would otherwise start a second edit row.
    const typed = " Alice added a closing line here.";
    await focusRichEnd(alice.page);
    await alice.page.keyboard.type(typed);
    await expect(alice.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
    await expect
      .poll(
        async () => {
          const { items } = (await (await alice.page.request.get(`/api/documents/${docId}/activity`)).json()) as { items: { action: string; detail: { chars?: number } }[] };
          return items.filter((i) => i.action === "edit").map((i) => i.detail.chars ?? 0);
        },
        { timeout: 30_000 },
      )
      .toEqual([typed.length]);

    await selectTextInRich(alice.page, "First paragraph");
    await alice.page.getByTestId("tb-comment").click();
    await alice.page.getByTestId("comment-composer").fill("Could this paragraph be shorter?");
    await alice.page.getByTestId("comment-submit").click();
    await expect(alice.page.getByTestId("comment-thread")).toHaveCount(1);

    await alice.page.getByTestId("more-menu").click();
    await alice.page.getByRole("menuitem", { name: "Name current version" }).click();
    await alice.page.getByTestId("version-name").fill("Before review");
    await alice.page.getByTestId("version-name-submit").click();
    await expect(alice.page.getByTestId("toast")).toContainText("Saved version");

    await openActivity(alice.page);
    const rows = alice.page.getByTestId("activity-row");
    await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(3);
    await expect(rows.nth(0)).toHaveAttribute("data-action", "version.save");
    await expect(rows.nth(0)).toContainText("alice");
    await expect(rows.nth(0)).toContainText(/saved version \d+ ‘Before review’/);
    await expect(rows.nth(1)).toHaveAttribute("data-action", "comment.add");
    await expect(rows.nth(1)).toContainText("commented: “Could this paragraph be shorter?”");
    await expect(rows.nth(2)).toHaveAttribute("data-action", "edit");
    await expect(rows.nth(2)).toContainText(/edited the document \(~\d+ characters\)/);
    await expect(alice.page.getByTestId("activity-agent-chip")).toHaveCount(0);
    await alice.page.screenshot({ path: "test-results/activity-panel.png" });
    await closeActivity(alice.page);
  });

  test("a commenter sees the panel, and agent API actions get the agent chip", async () => {
    await shareWith(alice.page, docId, "bob", "commenter");
    await openDocument(bob.page, docId);
    await openActivity(bob.page);
    const bobRows = bob.page.getByTestId("activity-row");
    await expect(bobRows.first()).toHaveAttribute("data-action", "share.add");
    await expect(bobRows.first()).toContainText("shared with @bob as commenter");
    await expect.poll(() => bobRows.count()).toBeGreaterThanOrEqual(4);
    await closeActivity(bob.page);

    // An agent acts for Alice through a personal access token (revoked in afterAll).
    minted = await mintToken(alice.page, "Review Bot");
    const commented = await alice.page.request.post(`/api/documents/${docId}/comments`, {
      headers: { Authorization: ["Bearer", minted.token].join(" ") },
      data: { action: "add", quote: "Activity doc", body: "Consider a more specific title." },
      timeout: 60_000,
    });
    expect(commented.ok()).toBeTruthy();

    // Reopening the panel refreshes it (it also polls every 30 s while open).
    await openActivity(alice.page);
    const row = alice.page.getByTestId("activity-row").first();
    await expect(row).toHaveAttribute("data-actor-kind", "agent");
    await expect(row).toContainText("Review Bot");
    await expect(row.getByTestId("activity-agent-chip")).toBeVisible();
    await expect(row).toContainText("commented: “Consider a more specific title.”");
    await alice.page.screenshot({ path: "test-results/activity-panel-agent.png" });
  });
});
