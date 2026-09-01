import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

const viewports = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 853, height: 759 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
] as const;

const screenshotWidths = new Set([320, 853, 1440]);

async function boundingBox(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, `${await locator.getAttribute("data-testid")} bounding box`).not.toBeNull();
  return box!;
}

async function expectCardContentVisible(page: Page) {
  const card = page.getByTestId("login-card");
  const githubAuth = page.locator('[data-testid="github-signin"], [data-testid="github-not-configured"]');
  const visibleContent = [
    page.getByRole("heading", { name: "Markdoc" }),
    page.getByText("Collaborative Markdown editing."),
    page.getByText("Development login"),
    page.getByTestId("dev-login"),
    page.getByTestId("dev-login-submit"),
    page.getByText("Only available when AUTH_DEV_LOGIN=1 outside production."),
    page.getByText("Markdoc asks for access to your gists and repositories so it can publish documents on your behalf."),
  ];

  await expect(card).toBeVisible();
  await expect(githubAuth).toHaveCount(1);
  await expect(githubAuth).toBeVisible();
  for (const locator of visibleContent) await expect(locator).toBeVisible();

  const outOfViewport = await card.locator("*").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      const outside = rect.left < -0.5 || rect.right > window.innerWidth + 0.5 || rect.top < -0.5 || rect.bottom > window.innerHeight + 0.5;
      return visible && outside ? [`${element.tagName.toLowerCase()}${element.getAttribute("data-testid") ? `[data-testid="${element.getAttribute("data-testid")}"]` : ""}`] : [];
    }),
  );
  expect(outOfViewport, "visible login-card elements outside the viewport").toEqual([]);
}

for (const viewport of viewports) {
  test(`login card stays responsive at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/login");

    await expectCardContentVisible(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "page has no horizontal overflow").toBe(true);

    const card = await boundingBox(page.getByTestId("login-card"));
    const controls = await boundingBox(page.getByTestId("dev-login-controls"));
    const input = await boundingBox(page.getByTestId("dev-login"));
    const submit = await boundingBox(page.getByTestId("dev-login-submit"));
    const submitText = await page.getByTestId("dev-login-submit").evaluate((button) => {
      const text = Array.from(button.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim() === "Sign in");
      const range = document.createRange();
      if (text) range.selectNodeContents(text);
      const rects = text ? Array.from(range.getClientRects()) : [];
      return {
        clientHeight: button.clientHeight,
        scrollHeight: button.scrollHeight,
        textRects: rects.length,
        textLines: new Set(rects.map((rect) => Math.round(rect.top))).size,
      };
    });

    expect(submitText.scrollHeight, "submit label does not overflow").toBeLessThanOrEqual(submitText.clientHeight);
    expect(submitText.textRects, "submit label renders in one client rect").toBe(1);
    expect(submitText.textLines, "submit label renders on one line").toBe(1);
    expect(submit.height, "submit height").toBeLessThanOrEqual(44);

    if (viewport.width >= 640) {
      expect(Math.abs(input.y - submit.y), "desktop control top edges").toBeLessThanOrEqual(2);
      expect(Math.abs(input.y + input.height - (submit.y + submit.height)), "desktop control bottom edges").toBeLessThanOrEqual(2);
      expect(Math.abs(input.height - submit.height), "desktop control heights").toBeLessThanOrEqual(2);
    } else {
      expect(submit.y, "phone submit follows the input").toBeGreaterThan(input.y + input.height);
      expect(Math.abs(input.x - controls.x), "phone input left edge").toBeLessThanOrEqual(2);
      expect(Math.abs(submit.x - controls.x), "phone submit left edge").toBeLessThanOrEqual(2);
      expect(Math.abs(input.width - controls.width), "phone input width").toBeLessThanOrEqual(2);
      expect(Math.abs(submit.width - controls.width), "phone submit width").toBeLessThanOrEqual(2);
      expect(card.x, "phone card left margin").toBeGreaterThanOrEqual(12);
      expect(viewport.width - (card.x + card.width), "phone card right margin").toBeGreaterThanOrEqual(12);
    }

    if (screenshotWidths.has(viewport.width)) {
      await page.screenshot({ path: testInfo.outputPath(`login-${viewport.width}x${viewport.height}.png`), fullPage: true });
    }
  });
}
