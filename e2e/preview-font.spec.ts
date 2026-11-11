import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { PREVIEW_FONTS, PREVIEW_FONT_STORAGE_KEY } from "../src/lib/preview-font";
import { codeText, createDocument, openDocument, reloadHydrated, signIn } from "./helpers";

const DOC = [
  "# Heading one",
  "",
  "## Heading two",
  "",
  "### Heading three",
  "",
  "#### Heading four",
  "",
  "##### Heading five",
  "",
  "###### Heading six",
  "",
  "Body text with `inline code`.",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "> ## Nested heading",
  "",
].join("\n");

const headings = (page: Page) => page.locator(".md-rich > :is(h1, h2, h3, h4, h5, h6)");

async function typography(elements: Locator) {
  return elements.evaluateAll((els) => els.map((el) => {
    const style = getComputedStyle(el);
    return {
      family: style.fontFamily,
      size: style.fontSize,
      weight: style.fontWeight,
      variation: style.fontVariationSettings,
    };
  }));
}

async function expectPreviewFont(page: Page, family: string) {
  await expect(page.locator(".md-rich > p")).toHaveCSS("font-family", family);
  await expect(page.locator(".doc-title")).toHaveCSS("font-family", family);
  await expect(page.locator(".doc-title")).toHaveCSS("font-variation-settings", "normal");
  const allHeadings = page.locator(".md-rich :is(h1, h2, h3, h4, h5, h6)");
  await expect(allHeadings).toHaveCount(7);
  for (const heading of await allHeadings.all()) {
    await expect(heading).toHaveCSS("font-family", family);
    await expect(heading).toHaveCSS("font-variation-settings", "normal");
  }
}

test.describe("preview font", () => {
  test("the server-rendered loading preview uses the default font for headings too", async ({ browser }) => {
    const owner = await signIn(browser, "preview-font-loading");
    const id = await createDocument(owner.page, DOC, "Loading preview");
    const context = await browser.newContext({ javaScriptEnabled: false, storageState: await owner.context.storageState() });
    const page = await context.newPage();
    await page.goto(`/d/${id}`);
    await expect(page.getByTestId("editor-loading")).toBeVisible();
    const placeholder = page.getByTestId("rich-placeholder");
    await expect(placeholder.locator("p").first()).toHaveCSS("font-family", /Instrument Sans/);
    const family = await placeholder.evaluate((el) => getComputedStyle(el).fontFamily);
    const loadingHeadings = placeholder.locator("h1, h2, h3, h4, h5, h6");
    await expect(loadingHeadings).toHaveCount(7);
    for (const heading of await loadingHeadings.all()) {
      await expect(heading).toHaveCSS("font-family", family);
      await expect(heading).toHaveCSS("font-variation-settings", "normal");
    }
    await context.close();
    await owner.context.close();
  });

  test("every preview font choice controls body and h1-h6, keeps the hierarchy, and survives reloads and navigation", async ({ browser }) => {
    const { page, context } = await signIn(browser, "preview-font-choices");
    const id = await createDocument(page, DOC, "Preview font fixture");
    const otherId = await createDocument(page, DOC, "Another preview");
    await openDocument(page, id);

    const initialHeadings = await typography(headings(page));
    expect(initialHeadings.map((style) => Number.parseFloat(style.size))).toEqual([32, 24, 20, 16.8, 16, 16]);
    expect(initialHeadings.map((style) => style.weight)).toEqual(["600", "600", "600", "700", "700", "700"]);
    const hierarchy = initialHeadings.map(({ size, weight }) => ({ size, weight }));
    const unchanged = page.locator(".wordmark, .pane-label, .cm-content, .md-rich pre code, .md-rich code.md-inline-code");
    const originalTypography = await typography(unchanged);
    expect(originalTypography.length).toBeGreaterThanOrEqual(6);
    await expect(page.locator(".md-rich pre code")).toHaveCSS("font-family", /JetBrains/);
    await expect(page.locator(".md-rich code.md-inline-code")).toHaveCSS("font-family", /JetBrains/);

    for (const font of [...PREVIEW_FONTS.slice(1), PREVIEW_FONTS[0]]) {
      await page.getByTestId("preview-menu-trigger").click();
      const option = page.getByTestId(`preview-font-${font.id}`);
      const family = await option.locator("span[style]").evaluate((el) => getComputedStyle(el).fontFamily);
      await option.click();
      await expect(page.getByTestId("rich-column")).toHaveAttribute("data-preview-font", font.id);
      await expectPreviewFont(page, family);
      expect((await typography(headings(page))).map(({ size, weight }) => ({ size, weight }))).toEqual(hierarchy);
      expect(await typography(unchanged)).toEqual(originalTypography);
      expect(await page.evaluate((key) => localStorage.getItem(key), PREVIEW_FONT_STORAGE_KEY)).toBe(font.id);
      expect(await codeText(page)).toBe(DOC);

      await reloadHydrated(page);
      await expectPreviewFont(page, family);
      await page.getByTestId("preview-menu-trigger").click();
      await expect(page.getByTestId(`preview-font-${font.id}`)).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");

      await openDocument(page, otherId);
      await expectPreviewFont(page, family);
    }

    await context.close();
  });

  test("the preference stays browser-local and leaves the reader and exports unchanged", async ({ browser }) => {
    const { page, context } = await signIn(browser, "preview-font-scope");
    const id = await createDocument(page, DOC, "Preview scope fixture");
    expect((await page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "view" } })).ok()).toBeTruthy();
    await openDocument(page, id);

    const reader = await context.newPage();
    await reader.goto(`/p/${id}`);
    await expect(reader.getByTestId("reader-body").locator("h2").first()).toBeVisible();
    const readerElements = reader.locator(".wordmark, .doc-title, .reader-body, .reader-body :is(h1, h2, h3, h4, h5, h6), .reader-body pre code");
    const readerTypography = await typography(readerElements);
    await expect(reader.getByTestId("reader-body").locator("h2").first()).toHaveCSS("font-family", /Fraunces/);
    await expect(reader.getByTestId("reader-body").locator("h2").first()).toHaveCSS("font-variation-settings", '"SOFT" 30, "opsz" 36');
    const exported = await page.request.get(`/api/documents/${id}/export?format=html`);
    expect(exported.ok()).toBeTruthy();
    const originalExport = await exported.text();

    await page.getByTestId("preview-menu-trigger").click();
    await page.getByTestId("preview-font-source-serif").click();
    await expect(page.locator(".md-rich h1")).toHaveCSS("font-family", /Source Serif/);
    await reloadHydrated(reader);
    expect(await typography(readerElements)).toEqual(readerTypography);
    const afterExport = await page.request.get(`/api/documents/${id}/export?format=html`);
    expect(afterExport.ok()).toBeTruthy();
    expect(await afterExport.text()).toBe(originalExport);

    const separate = await signIn(browser, "preview-font-scope");
    await openDocument(separate.page, id);
    await expect(separate.page.getByTestId("rich-column")).toHaveAttribute("data-preview-font", "instrument-sans");
    await expect(separate.page.locator(".md-rich h1")).toHaveCSS("font-family", /Instrument Sans/);
    expect(await separate.page.evaluate((key) => localStorage.getItem(key), PREVIEW_FONT_STORAGE_KEY)).toBeNull();
    await separate.context.close();
    await context.close();
  });
});
