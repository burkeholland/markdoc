import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, selectTextInRich, reloadHydrated } from "./helpers";

const CONTENT = ["# Theme doc", "", "First paragraph to comment on.", "", "```ts", "const answer: number = 42;", "```", ""].join("\n");

/** Computed background colour parsed to [r, g, b]; `null` when transparent. */
async function bg(page: Page, selector: string): Promise<[number, number, number] | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`missing ${sel}`);
    const m = getComputedStyle(el).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  }, selector);
}

const isDark = (rgb: [number, number, number] | null) => rgb !== null && rgb[0] + rgb[1] + rgb[2] < 3 * 60;
const isLight = (rgb: [number, number, number] | null) => rgb !== null && rgb[0] + rgb[1] + rgb[2] > 3 * 200;

test.describe("dark mode", () => {
  test("follows the OS preference by default, toggles without a reload and persists", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByTestId("dev-login").fill("themer");
    await page.getByTestId("dev-login-submit").click();
    await page.waitForURL((url) => url.pathname === "/");

    // Dashboard in dark.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(isDark(await bg(page, "body"))).toBe(true);
    const toggle = page.getByTestId("theme-toggle");
    await expect(toggle).toHaveAttribute("data-theme-preference", "system");

    // system → light: attribute flips without a reload.
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-theme-preference", "light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(isLight(await bg(page, "body"))).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("markdoc:theme"))).toBe("light");

    // Persists after reload even though the OS still prefers dark.
    await reloadHydrated(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByTestId("theme-toggle")).toHaveAttribute("data-theme-preference", "light");

    // light → dark → system.
    await page.getByTestId("theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByTestId("theme-toggle").click();
    await expect(page.getByTestId("theme-toggle")).toHaveAttribute("data-theme-preference", "system");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await context.close();
  });

  test("no flash: the attribute is set before hydration from localStorage", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "light" });
    await context.addInitScript(() => localStorage.setItem("markdoc:theme", "dark"));
    const page = await context.newPage();
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    // Read synchronously at domcontentloaded: React has not hydrated yet.
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    expect(isDark(await bg(page, "body"))).toBe(true);
    await context.close();
  });

  test("editor surfaces, comment highlight, slash and table menus, settings and reader render in dark", async ({ browser }) => {
    const user = await signIn(browser, "dark-editor");
    const { page } = user;
    await page.evaluate(() => localStorage.setItem("markdoc:theme", "dark"));
    const id = await createDocument(page, CONTENT, "Theme doc");
    await openDocument(page, id);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    expect(isDark(await bg(page, "body"))).toBe(true);
    expect(isDark(await bg(page, ".cm-editor"))).toBe(true);
    const richBg = await bg(page, ".md-rich");
    expect(richBg === null || isDark(richBg)).toBe(true);
    // Code block and hljs spans pick up the dark palette (not the light #7c3aed keyword). The grammars
    // arrive from their own chunk after the editor mounts, so wait for the first token before reading it.
    expect(isDark(await bg(page, ".md-rich pre"))).toBe(true);
    await expect(page.locator(".md-rich pre .hljs-keyword").first()).toBeVisible();
    const keywordColor = await page.evaluate(() => getComputedStyle(document.querySelector(".md-rich pre .hljs-keyword")!).color);
    expect(keywordColor).not.toBe("rgb(124, 58, 237)");

    // The toggle lives in the status bar too and reports the current preference.
    await expect(page.getByTestId("status-bar").getByTestId("theme-toggle")).toHaveAttribute("data-theme-preference", "dark");

    // Comment highlight: translucent amber over a dark surface, readable ink.
    await selectTextInRich(page, "First paragraph");
    await page.getByTestId("tb-comment").click();
    await page.getByTestId("comment-composer").fill("Looks good in the dark.");
    await page.getByTestId("comment-submit").click();
    const highlight = page.locator(".md-rich .md-comment").first();
    await expect(highlight).toBeVisible();
    const commentBg = await highlight.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(commentBg).not.toBe("rgb(254, 243, 199)");

    // Slash menu renders on a dark surface.
    await page.locator(".md-rich p").last().click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(page.getByTestId("slash-menu")).toBeVisible();
    expect(isDark(await bg(page, '[data-testid="slash-menu"]'))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("slash-menu")).toHaveCount(0);

    // Table from the toolbar; its floating menu stays distinguishable from the page.
    await page.getByTestId("tb-table").click();
    await page.getByTestId("table-grid").getByRole("button", { name: "2 by 2" }).click();
    await expect(page.locator(".md-rich table")).toBeVisible();
    await page.locator(".md-rich td").first().click();
    const tableMenu = page.getByTestId("table-menu");
    await expect(tableMenu).toBeVisible();
    const menuBg = await bg(page, '[data-testid="table-menu"]');
    const pageBg = await bg(page, "body");
    expect(menuBg).not.toBeNull();
    expect(Math.abs(menuBg![0] - pageBg![0]) + Math.abs(menuBg![1] - pageBg![1]) + Math.abs(menuBg![2] - pageBg![2])).toBeGreaterThan(60);

    // Palette command cycles the preference (dark → system).
    await page.keyboard.press("Control+Shift+P");
    await page.getByTestId("palette-input").fill("Toggle theme");
    await page.getByTestId("palette-item-view:theme").click();
    await expect(page.getByTestId("status-bar").getByTestId("theme-toggle")).toHaveAttribute("data-theme-preference", "system");
    await page.evaluate(() => localStorage.setItem("markdoc:theme", "dark"));

    // Settings page has a theme row.
    await page.goto("/settings");
    await expect(page.getByTestId("theme-row")).toBeVisible();
    await expect(page.getByTestId("theme-option-dark")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("theme-option-light").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByTestId("theme-option-dark").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // Reader page in dark.
    const res = await page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "view" } });
    expect(res.ok()).toBeTruthy();
    await page.goto(`/p/${id}`);
    await expect(page.getByTestId("reader-body")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(isDark(await bg(page, '[data-testid="reader"]'))).toBe(true);
    expect(isDark(await bg(page, ".reader-body pre"))).toBe(true);
    await user.context.close();
  });
});
