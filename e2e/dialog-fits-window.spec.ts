import { test, expect } from "./fixtures";
import { createDocument, openDocument, signIn } from "./helpers";

// #2250: a dialog taller than the window kept its title and Close button above the top edge.
for (const [width, height] of [
  [1440, 1000],
  [1280, 720],
  [1024, 600],
] as const) {
  test(`Keyboard shortcuts fits a ${width}x${height} window: the X is reachable and the list scrolls`, async ({ browser }) => {
    const user = await signIn(browser, `dialog-fit-${width}`);
    const { page } = user;
    await page.setViewportSize({ width, height });
    const id = await createDocument(page, "# Dialog\n\nText.");
    await openDocument(page, id);
    await page.locator(".md-rich").click();
    await page.keyboard.press("ControlOrMeta+/");

    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.y, "dialog top is inside the window").toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, "dialog bottom is inside the window").toBeLessThanOrEqual(height);
    const title = (await dialog.getByRole("heading", { name: "Keyboard shortcuts" }).boundingBox())!;
    expect(title.y).toBeGreaterThanOrEqual(0);

    // The body scrolls; the header (title and X) stays in view.
    const scrollable = await dialog.evaluate((element) => element.scrollHeight > element.clientHeight);
    expect(scrollable, "the shortcut list is taller than the window and scrolls").toBe(true);
    await dialog.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    const close = dialog.getByRole("button", { name: "Close" });
    const x = (await close.boundingBox())!;
    expect(x.y).toBeGreaterThanOrEqual(0);
    expect(x.y + x.height).toBeLessThanOrEqual(height);
    expect(x.x + x.width).toBeLessThanOrEqual(width);

    await page.mouse.click(x.x + x.width / 2, x.y + x.height / 2);
    await expect(dialog).toHaveCount(0);
    await user.context.close();
  });
}
