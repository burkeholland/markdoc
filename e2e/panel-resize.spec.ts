import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { createDocument, devLogin, ensureCommentsOpen, openDocument, reloadHydrated } from "./helpers";

/**
 * Task #978: the desktop Comments / Versions / Activity panel is resizable from its left edge.
 * Default 340 px, clamped to 280..min(720, 60 % of the viewport), remembered in localStorage.
 * Phones and tablets keep their sheet/overlay (e2e/mobile.spec.ts).
 */

const DOC = "# Resize me\n\nA paragraph that is long enough to wrap inside the comments panel once its width changes.\n\n## Second\n\nMore words here.\n";
const VIEWPORT = { width: 1440, height: 900 };
const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 280;
const MAX_WIDTH = Math.min(720, Math.floor(VIEWPORT.width * 0.6));

async function signInDesktop(browser: Browser, login: string) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await devLogin(page, login);
  await page.waitForLoadState("networkidle");
  return { context, page };
}

const panel = (page: Page) => page.getByTestId("side-panel");
const handle = (page: Page) => page.getByTestId("panel-resize-handle");
const widthOf = async (locator: Locator) => (await locator.boundingBox())!.width;

async function expectWidth(page: Page, expected: number, tolerance = 0) {
  await expect.poll(() => widthOf(panel(page))).toBeGreaterThanOrEqual(expected - tolerance);
  await expect.poll(() => widthOf(panel(page))).toBeLessThanOrEqual(expected + tolerance);
  await expect(handle(page)).toHaveAttribute("aria-valuenow", String(Math.round(await widthOf(panel(page)))));
}

/** Press on the grip and move the mouse `dx` px (negative = left = wider). */
async function dragHandle(page: Page, dx: number) {
  const box = (await handle(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 5 });
  await page.mouse.move(x + dx, y, { steps: 5 });
  await page.mouse.up();
}

/** Both panes and the status bar are laid out inside the window. */
async function expectEditorIntact(page: Page) {
  const viewport = page.viewportSize()!;
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator(".md-rich")).toBeVisible();
  const code = (await page.getByTestId("code-column").boundingBox())!;
  const rich = (await page.getByTestId("rich-column").boundingBox())!;
  expect(code.width).toBeGreaterThan(80);
  expect(rich.width).toBeGreaterThan(80);
  expect(rich.x + rich.width).toBeLessThanOrEqual((await panel(page).boundingBox())!.x + 1);
  const status = (await page.getByTestId("status-bar").boundingBox())!;
  expect(status.y + status.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(status.width).toBeGreaterThanOrEqual(viewport.width - 1);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth)).toBe(true);
}

test.describe("resizable side panel (desktop)", () => {
  test("drag widens the panel, the width survives a reload and a double-click restores 340", async ({ browser }) => {
    const { context, page } = await signInDesktop(browser, "panel-resizer");
    const id = await createDocument(page, DOC, "Resize");
    await openDocument(page, id);
    await expect(page.getByTestId("editor-shell")).toHaveAttribute("data-breakpoint", "desktop");
    await ensureCommentsOpen(page);

    await expectWidth(page, DEFAULT_WIDTH);
    await expect(handle(page)).toHaveCSS("cursor", "col-resize");
    expect(await page.evaluate(() => localStorage.getItem("markdoc:panelWidth"))).toBeNull();

    await dragHandle(page, -160);
    await expectWidth(page, 500, 2);
    expect(Number(await page.evaluate(() => localStorage.getItem("markdoc:panelWidth")))).toBeGreaterThanOrEqual(498);
    await expectEditorIntact(page);

    // Version history shares the width.
    await page.getByTestId("more-menu").click();
    await page.getByRole("menuitem", { name: "Version history" }).click();
    await expect(page.getByTestId("versions-panel")).toBeVisible();
    await expectWidth(page, 500, 2);

    await reloadHydrated(page);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await ensureCommentsOpen(page);
    await expectWidth(page, 500, 2);

    await handle(page).dblclick();
    await expectWidth(page, DEFAULT_WIDTH);
    expect(await page.evaluate(() => localStorage.getItem("markdoc:panelWidth"))).toBe(String(DEFAULT_WIDTH));

    await context.close();
  });

  test("the width is clamped to 280 px and to min(720, 60 % of the viewport)", async ({ browser }) => {
    const { context, page } = await signInDesktop(browser, "panel-clamper");
    const id = await createDocument(page, DOC, "Clamp");
    await openDocument(page, id);
    await ensureCommentsOpen(page);
    await expectWidth(page, DEFAULT_WIDTH);

    // +200 px would give 140 px unclamped; the panel stops at its minimum.
    await dragHandle(page, 200);
    await expectWidth(page, MIN_WIDTH);
    await expect(handle(page)).toHaveAttribute("aria-valuemin", String(MIN_WIDTH));
    await expectEditorIntact(page);

    await dragHandle(page, -1000);
    await expectWidth(page, MAX_WIDTH);
    expect(MAX_WIDTH).toBe(720);
    await expect(handle(page)).toHaveAttribute("aria-valuemax", String(MAX_WIDTH));
    await expectEditorIntact(page);

    // A stored width above the new window's limit is clamped when the editor opens.
    await page.setViewportSize({ width: 1100, height: 900 });
    await expectWidth(page, Math.floor(1100 * 0.6));
    await expectEditorIntact(page);

    await context.close();
  });

  test("the grip is a focusable separator: Shift+Tab reaches it, arrows nudge by 16 px, Enter resets", async ({ browser }) => {
    const { context, page } = await signInDesktop(browser, "panel-keyboard");
    const id = await createDocument(page, DOC, "Keyboard");
    await openDocument(page, id);
    await ensureCommentsOpen(page);
    await expectWidth(page, DEFAULT_WIDTH);

    const grip = handle(page);
    await expect(grip).toHaveAttribute("role", "separator");
    await expect(grip).toHaveAttribute("aria-orientation", "vertical");
    await expect(grip).toHaveAttribute("aria-label", "Resize panel");

    // The grip sits just before the panel's first control in the tab order.
    await page.getByRole("button", { name: "Close comments" }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(grip).toBeFocused();

    await page.keyboard.press("ArrowRight");
    await expectWidth(page, DEFAULT_WIDTH - 16);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Shift+ArrowLeft");
    await expectWidth(page, DEFAULT_WIDTH + 64);
    await page.keyboard.press("Home");
    await expectWidth(page, MIN_WIDTH);
    await page.keyboard.press("End");
    await expectWidth(page, MAX_WIDTH);
    await page.keyboard.press("Enter");
    await expectWidth(page, DEFAULT_WIDTH);
    await expect(grip).toBeFocused();

    await context.close();
  });
});
