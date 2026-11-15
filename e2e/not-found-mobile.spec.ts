import { expect, test } from "./fixtures";

test.use({ viewport: { width: 320, height: 640 } });

test("404 recovery link has a 44px mobile touch target", async ({ page }) => {
  const response = await page.goto("/p/");
  expect(response?.status()).toBe(404);

  const link = page.getByRole("link", { name: "Back to Markdoc home" });
  await expect(link).toBeVisible();
  const box = await link.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
});
