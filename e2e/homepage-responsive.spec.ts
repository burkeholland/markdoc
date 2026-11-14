import { test, expect } from "./fixtures";
import { cssPx } from "./helpers";

test("homepage exposes its header as a banner landmark separate from main", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("banner")).toHaveCount(1);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("banner").locator('a[href="/login"]')).toBeVisible();
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test(`homepage header sign-in target is at least 44px tall at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");

    const signIn = page.locator('header.app-header a[href="/login"]');
    await expect(signIn).toBeVisible();
    const box = await signIn.boundingBox();
    expect(box).not.toBeNull();
    expect(cssPx(box!.height)).toBeGreaterThanOrEqual(44);
  });
}

test("homepage sign-in action stays on one line beside the wordmark at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");

  const header = page.locator("header.app-header");
  const signIn = header.locator('a[href="/login"]');
  await expect(signIn).toBeVisible();

  const label = await signIn.evaluate((link) => {
    const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
    const lines = new Set<number>();
    let text = "";
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.textContent?.trim() || !node.parentElement || getComputedStyle(node.parentElement).display === "none") continue;
      text += node.textContent;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) lines.add(Math.round(rect.top));
    }
    return { text: text.replace(/\s+/g, " ").trim(), lines: lines.size };
  });
  expect(label.lines, "sign-in label renders on one line").toBe(1);
  expect(label.text, "phone label is compact").toBe("Sign in");

  const brandBox = await header.locator(".wordmark").boundingBox();
  const signInBox = await signIn.boundingBox();
  expect(brandBox).not.toBeNull();
  expect(signInBox).not.toBeNull();
  expect(signInBox!.x - brandBox!.x - brandBox!.width, "wordmark and sign-in action have separation").toBeGreaterThanOrEqual(8);

  await page.setViewportSize({ width: 1280, height: 800 });
  const desktopLabel = await signIn.evaluate((link) => (link as HTMLElement).innerText.replace(/\s+/g, " ").trim());
  expect(desktopLabel, "desktop label keeps the GitHub detail").toBe("Sign in with GitHub");
});

test("homepage offers a next step after the features on phones", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const nextStep = page.locator('main a[href="/login"]').last();
  await expect(nextStep).toHaveText("Get started");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(nextStep).toBeInViewport();
});
