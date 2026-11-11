import { test, expect } from "./fixtures";
import { waitForHydration } from "./helpers";

test.use({ viewport: { width: 1280, height: 720 } });

test("missing documents render without React errors and keep the saved theme", async ({ page }) => {
  await page.goto("/login");
  await waitForHydration(page);
  await page.getByTestId("demo-signin").click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.evaluate(() => {
    localStorage.setItem("markdoc:theme", "dark");
    localStorage.setItem("markdoc:brand", "a");
  });

  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  for (let load = 0; load < 2; load++) {
    const response = await page.goto("/d/not-a-real-document");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "You can't open this document" })).toBeVisible();
    await waitForHydration(page);
    expect(errors).toEqual([]);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("markdoc:brand"))).toBeNull();
  }
});
