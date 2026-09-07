import { type Locator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { createDocument, cssPx, devLogin, uniqueLogin, waitForEditor } from "./helpers";

const viewports = [
  { width: 360, height: 780 },
  { width: 393, height: 851 },
] as const;

async function expectNoHorizontalOverflow(page: Page) {
  const root = await page.evaluate(() => {
    const element = document.scrollingElement!;
    return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  });
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
}

async function expectTappableClose(dialog: Locator) {
  const close = dialog.getByRole("button", { name: "Close" });
  const box = (await close.boundingBox())!;
  expect(cssPx(box.width)).toBeGreaterThanOrEqual(24);
  expect(cssPx(box.height)).toBeGreaterThanOrEqual(24);
}

test.describe("phone overlays", () => {
  for (const viewport of viewports) {
    test(`stay on-screen at ${viewport.width} px`, async ({ browser }) => {
      const context = await browser.newContext({ viewport, hasTouch: true });
      const page = await context.newPage();
      await devLogin(page, uniqueLogin(`phone-overlays-${viewport.width}`));
      await page.waitForLoadState("networkidle");

      await page.getByTestId("new-from-template").click();
      const templateDialog = page.getByRole("dialog");
      await expect(templateDialog).toBeVisible();
      await expectTappableClose(templateDialog);
      await expectNoHorizontalOverflow(page);
      await templateDialog.getByRole("button", { name: "Close" }).click();
      await expect(templateDialog).toHaveCount(0);

      const id = await createDocument(page, "# Phone overlays\n", `Phone overlays at ${viewport.width} px`);
      await page.goto(`/d/${id}`);
      await waitForEditor(page);
      await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });

      await page.getByTestId("notifications-bell").click();
      const popover = page.getByTestId("notifications-popover");
      await expect(popover).toBeVisible();
      const popoverBox = (await popover.boundingBox())!;
      expect(cssPx(popoverBox.x)).toBeGreaterThanOrEqual(8);
      expect(cssPx(popoverBox.x + popoverBox.width)).toBeLessThanOrEqual(viewport.width - 8);
      await expectNoHorizontalOverflow(page);
      await page.keyboard.press("Escape");
      await expect(popover).toHaveCount(0);

      await page.getByTestId("more-menu").click();
      await page.getByTestId("menu-share").click();
      const shareDialog = page.getByRole("dialog");
      await expect(shareDialog).toBeVisible();
      await expectTappableClose(shareDialog);
      await expectNoHorizontalOverflow(page);
      await context.close();
    });
  }
});
