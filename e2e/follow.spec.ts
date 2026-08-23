import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, shareWith, type User } from "./helpers";

const SECTIONS = 6;
const LINES_PER_SECTION = 20;

function longDoc(): string {
  const parts: string[] = [];
  for (let s = 1; s <= SECTIONS; s++) {
    parts.push(`# Section ${s}`, "");
    for (let i = 1; i < LINES_PER_SECTION - 1; i++) parts.push(`Section ${s} paragraph ${i} with enough words to take a line.`, "");
  }
  return parts.join("\n") + "\n";
}

/** Scroll container of the rich pane. */
const richScroller = (page: Page) => page.locator('[data-testid="rich-column"] .overflow-y-auto');

const richScrollTop = (page: Page) => richScroller(page).evaluate((el) => el.scrollTop);

/** Whether a remote caret for `userId` sits inside the rich pane's visible area. */
async function caretInView(page: Page, userId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const caret = document.querySelector<HTMLElement>(`.md-remote-caret[data-user-id="${id}"]`);
    const scroller = document.querySelector<HTMLElement>('[data-testid="rich-column"] .overflow-y-auto');
    if (!caret || !scroller) return false;
    const c = caret.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    return c.top >= s.top && c.bottom <= s.bottom;
  }, userId);
}

async function userId(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __markdocSession: { user: { id: string } } }).__markdocSession.user.id);
}

test.describe("presence: jump to and follow a collaborator", () => {
  let alice: User;
  let bob: User;
  let bobId: string;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
    bob = await signIn(browser, "bob");
    const docId = await createDocument(alice.page, longDoc());
    await shareWith(alice.page, docId, "bob", "editor");
    await openDocument(alice.page, docId);
    await openDocument(bob.page, docId);
    bobId = await userId(bob.page);
    await expect(alice.page.getByTestId("presence").locator(".avatar")).toHaveCount(2);
  });

  test.afterAll(async () => {
    await alice.context.close();
    await bob.context.close().catch(() => {});
  });

  test("popover shows the collaborator's section, Jump reveals their caret, Follow tracks it", async () => {
    // Bob parks his caret in Section 5; Alice stays at the top.
    await bob.page.locator(".md-rich h1", { hasText: "Section 5" }).click();
    await alice.page.locator(".md-rich h1", { hasText: "Section 1" }).click();
    await expect(alice.page.locator(`.md-remote-caret[data-user-id="${bobId}"]`)).toBeAttached();
    expect(await caretInView(alice.page, bobId)).toBe(false);
    const before = await richScrollTop(alice.page);

    // Popover lists Bob with his section.
    await alice.page.getByTestId("presence").click();
    const popover = alice.page.getByTestId("presence-popover");
    await expect(popover).toBeVisible();
    const bobRow = popover.getByTestId("presence-row").filter({ hasText: "bob" });
    await expect(bobRow.getByTestId("presence-section")).toHaveText("in ‘Section 5’");

    // Jump scrolls Alice's preview to Bob's caret and flashes it.
    await bobRow.getByTestId("presence-jump").click();
    await expect(popover).toBeHidden();
    await expect.poll(() => richScrollTop(alice.page)).not.toBe(before);
    await expect.poll(() => caretInView(alice.page, bobId)).toBe(true);
    await expect(alice.page.locator(`.md-remote-caret[data-user-id="${bobId}"]`)).toHaveAttribute("data-flash", "");

    // Follow: banner appears, followed caret is marked.
    await alice.page.getByTestId("presence").click();
    await popover.getByTestId("presence-row").filter({ hasText: "bob" }).getByTestId("presence-follow").click();
    const banner = alice.page.getByTestId("follow-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Following bob");
    await expect(alice.page.locator(`.md-remote-caret[data-user-id="${bobId}"]`)).toHaveAttribute("data-following", "");

    // Bob moves to Section 1; Alice's view follows within a second.
    await bob.page.locator(".md-rich h1", { hasText: "Section 1" }).click();
    await expect.poll(() => caretInView(alice.page, bobId), { timeout: 1_000, intervals: [50, 100, 200] }).toBe(true);
    await expect(banner).toContainText("in ‘Section 1’");

    // Alice's own wheel scroll stops following.
    const box = (await richScroller(alice.page).boundingBox())!;
    await alice.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await alice.page.mouse.wheel(0, 200);
    await expect(banner).toBeHidden();

    // Follow again, then Esc.
    await alice.page.getByTestId("presence").click();
    await popover.getByTestId("presence-row").filter({ hasText: "bob" }).getByTestId("presence-follow").click();
    await expect(banner).toBeVisible();
    await alice.page.keyboard.press("Escape");
    await expect(banner).toBeHidden();
  });

  test("clicking a caret label in the code pane follows; the banner goes when the user leaves", async () => {
    await bob.page.locator(".md-rich h1", { hasText: "Section 1" }).click();
    const label = alice.page.locator(".cm-ySelectionCaret .cm-ySelectionInfo", { hasText: "bob" }).first();
    await expect(label).toBeAttached();
    await label.click({ force: true });
    const banner = alice.page.getByTestId("follow-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Following bob");
    await expect(alice.page.locator(`.cm-ySelectionCaret[data-user-id="${bobId}"]`).first()).toHaveAttribute("data-following", "");

    // The palette also offers following.
    await alice.page.keyboard.press("Escape");
    await expect(banner).toBeHidden();
    await alice.page.keyboard.press("Control+Shift+P");
    await expect(alice.page.getByTestId("command-palette")).toBeVisible();
    await alice.page.getByTestId("palette-input").fill("Follow collaborator");
    await alice.page.getByTestId("palette-item-nav:follow").click();
    await alice.page.getByTestId(`palette-item-follow:${bobId}`).click();
    await expect(banner).toBeVisible();

    // Bob leaves: following ends with a toast.
    await bob.context.close();
    await expect(alice.page.getByTestId("toast").filter({ hasText: "bob left" })).toBeVisible({ timeout: 20_000 });
    await expect(banner).toBeHidden();
  });
});
