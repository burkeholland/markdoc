import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { signIn, createDocument, openDocument, uniqueLogin } from "./helpers";

/**
 * Escape and a click outside close the command palette from every way of opening it, and focus goes
 * back to what opened it, never <body> (#2216). Real input only: `page.keyboard` and `page.mouse`.
 * Runs against the dev server, or against a production build with PROD_BASE_URL set.
 */

const mod = process.platform === "darwin" ? "Meta" : "Control";
const palette = (page: Page) => page.getByTestId("command-palette");

type Dismiss = "escape" | "outside click";

async function dismiss(page: Page, how: Dismiss) {
  await expect(page.getByTestId("palette-input")).toBeFocused();
  if (how === "escape") {
    await page.keyboard.press("Escape");
  } else {
    // Bottom-left corner of the viewport: on the overlay, well away from the palette box.
    const box = await palette(page).boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize()!;
    const x = 24;
    const y = viewport.height - 24;
    expect(y > box!.y + box!.height || x < box!.x).toBe(true);
    await page.mouse.click(x, y);
  }
  await expect(palette(page)).toHaveCount(0);
}

/** Focus is on `opener` (and so not on <body>) and the page takes the next click on the first try. */
async function expectFocusBack(page: Page, opener: Locator) {
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
}

/** The very next real click on the page lands on the first try (nothing left over swallows it). */
async function expectNextShareClickLands(page: Page) {
  await page.getByTestId("share-button").click();
  await expect(page.getByTestId("share-connect-agent")).toBeVisible();
}

async function openDoc(page: Page) {
  const id = await createDocument(page, "# Palette dismissal\n\nSome text.\n");
  await openDocument(page, id);
}

for (const how of ["escape", "outside click"] as const) {
  test.describe(`command palette closes with ${how} (#2216)`, () => {
    test("More > Search commands with the mouse", async ({ browser }) => {
      const { page, context } = await signIn(browser, uniqueLogin("palette-dismiss-more-mouse"));
      await openDoc(page);
      const more = page.getByTestId("more-menu");

      await more.click();
      await page.getByTestId("menu-command-palette").click();
      await expect(palette(page)).toBeVisible();
      await dismiss(page, how);
      await expectFocusBack(page, more);
      await context.close();
    });

    // The More menu must close after a mouse pick (#2203) or the leftover body pointer-events block this click.
    test("More > Search commands with the mouse: the next click lands", async ({ browser }) => {
      const { page, context } = await signIn(browser, uniqueLogin("palette-dismiss-more-mouse-next"));
      await openDoc(page);
      await page.getByTestId("more-menu").click();
      await page.getByTestId("menu-command-palette").click();
      await expect(palette(page)).toBeVisible();
      await dismiss(page, how);
      await expectNextShareClickLands(page);
      await context.close();
    });

    test("More > Search commands with the keyboard", async ({ browser }) => {
      const { page, context } = await signIn(browser, uniqueLogin("palette-dismiss-more-keys"));
      await openDoc(page);
      const more = page.getByTestId("more-menu");

      await more.focus();
      await page.keyboard.press("Enter");
      const item = page.getByTestId("menu-command-palette");
      await expect(item).toBeVisible();
      await item.focus();
      await page.keyboard.press("Enter");
      await expect(palette(page)).toBeVisible();
      await dismiss(page, how);
      await expectFocusBack(page, more);

      // Opening again from the menu still works after a dismissal.
      await page.keyboard.press("Enter");
      await expect(item).toBeVisible();
      await item.focus();
      await page.keyboard.press("Enter");
      await expect(palette(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(palette(page)).toHaveCount(0);
      await expectFocusBack(page, more);
      await expectNextShareClickLands(page);
      await context.close();
    });

    test("the keyboard shortcut in the editor", async ({ browser }) => {
      const { page, context } = await signIn(browser, uniqueLogin("palette-dismiss-shortcut"));
      await openDoc(page);
      const rich = page.locator(".md-rich");
      await page.locator(".md-rich p").first().click();
      await expect(rich).toBeFocused();

      await page.keyboard.press(`${mod}+Shift+P`);
      await expect(palette(page)).toBeVisible();
      await dismiss(page, how);
      await expectFocusBack(page, rich);

      // Typing goes to the editor again, and the shortcut reopens the palette.
      await page.keyboard.press(`${mod}+Shift+P`);
      await expect(palette(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(palette(page)).toHaveCount(0);
      await expectFocusBack(page, rich);
      await expectNextShareClickLands(page);
      await context.close();
    });

    test("the keyboard shortcut on the dashboard", async ({ browser }) => {
      const { page, context } = await signIn(browser, uniqueLogin("palette-dismiss-dash"));
      const newDocument = page.getByTestId("new-document");
      await newDocument.focus();

      await page.keyboard.press(`${mod}+k`);
      await expect(palette(page)).toBeVisible();
      await expect(page.getByTestId("palette-item-dash:new")).toBeVisible();
      await dismiss(page, how);
      await expectFocusBack(page, newDocument);

      await page.keyboard.press(`${mod}+k`);
      await expect(palette(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(palette(page)).toHaveCount(0);
      await expectFocusBack(page, newDocument);

      // The next click lands on the first try.
      const search = page.getByTestId("search");
      await search.click();
      await expect(search).toBeFocused();
      await context.close();
    });
  });
}

test("picking a command from a palette opened from the More menu runs it and closes the palette", async ({ browser }) => {
  const { page, context } = await signIn(browser, uniqueLogin("palette-dismiss-run"));
  await openDoc(page);
  await page.getByTestId("more-menu").click();
  await page.getByTestId("menu-command-palette").click();
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type("outline");
  await expect(palette(page).getByRole("option").first()).toHaveAttribute("data-testid", "palette-item-view:outline");
  await page.mouse.click(...(await center(palette(page).getByRole("option").first())));
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByTestId("outline-collapsed")).toBeVisible();
  await context.close();
});

async function center(locator: Locator): Promise<[number, number]> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return [box!.x + box!.width / 2, box!.y + box!.height / 2];
}
