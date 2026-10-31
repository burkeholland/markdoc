import { test, expect } from "./fixtures";
import { devices, type Browser } from "@playwright/test";
import { signIn, createDocument, openDocument, codeText, devLogin, focusCodeEnd, focusRichEnd } from "./helpers";

/**
 * The `/` menu in the Markdown source pane, the fancygist-style items (table of contents, callout,
 * footnote) and the menu on a phone. slash.spec.ts covers the rich pane's menu in depth.
 */
test.describe("slash command menu: source pane and fancygist items", () => {
  test("typing / in the Markdown pane opens the menu, filters, and inserts Markdown", async ({ browser }) => {
    const user = await signIn(browser, "slash-source");
    const { page } = user;
    const id = await createDocument(page, "# Guide\n\n## Install\n\nSome text.\n");
    await openDocument(page, id);
    await focusCodeEnd(page);
    await page.keyboard.press("Enter");

    await page.keyboard.type("/");
    const menu = page.getByTestId("slash-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("data-surface", "source");
    await expect(menu).toHaveAttribute("role", "listbox");
    // The editor owns the listbox: the highlighted row is its active descendant.
    const content = page.locator(".cm-content");
    await expect(content).toHaveAttribute("aria-controls", (await menu.getAttribute("id"))!);
    await expect(content).toHaveAttribute("aria-activedescendant", (await page.getByTestId("slash-item-text").getAttribute("id"))!);
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("slash-item-heading1")).toHaveAttribute("aria-selected", "true");
    await expect(content).toHaveAttribute("aria-activedescendant", (await page.getByTestId("slash-item-heading1").getAttribute("id"))!);
    await page.screenshot({ path: "test-results/slash-source-menu.png" });

    // Table of contents from the headings above.
    await page.keyboard.type("toc");
    await expect(page.getByTestId("slash-item-toc")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect.poll(() => codeText(page)).toContain("- [Guide](#guide)\n  - [Install](#install)");
    expect(await codeText(page)).not.toContain("/toc");

    // A callout with an argument: `/callout warn`.
    await focusCodeEnd(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("/callout warn");
    await expect(menu.getByRole("option")).toHaveCount(1);
    await page.screenshot({ path: "test-results/slash-source-callout.png" });
    await page.keyboard.press("Enter");
    await page.keyboard.type("Back up first.");
    await expect.poll(() => codeText(page)).toContain("> [!WARNING]\n> Back up first.");

    // Escape closes and keeps the text; a slash inside a word or in code never opens it.
    await focusCodeEnd(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("/he");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await page.keyboard.type(" and/or");
    await expect(menu).toHaveCount(0);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("```\n");
    await page.keyboard.type("/");
    await expect(menu).toHaveCount(0);
    await expect.poll(() => codeText(page)).toContain("/he and/or");

    await user.context.close();
  });

  test("/toc and /footnote in the rich pane", async ({ browser }) => {
    const user = await signIn(browser, "slash-source");
    const { page } = user;
    const id = await createDocument(page, "# Guide\n\n## Install\n\nSome text.\n");
    await openDocument(page, id);
    await focusRichEnd(page);
    await page.keyboard.type(" /foot");
    await expect(page.getByTestId("slash-item-footnote")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await page.keyboard.type("A note.");
    await expect.poll(() => codeText(page)).toContain("Some text. [^1]");
    await expect.poll(() => codeText(page)).toContain("[^1]: A note.");

    await page.locator(".md-rich p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    // Callouts are offered in the Markdown pane only.
    await expect(page.getByTestId("slash-item-toc")).toBeVisible();
    await expect(page.getByTestId("slash-item-callout")).toHaveCount(0);
    await page.keyboard.type("contents");
    await page.screenshot({ path: "test-results/slash-rich-toc.png" });
    await page.keyboard.press("Enter");
    await expect(page.locator(".md-rich a[href='#install']")).toBeVisible();
    await expect.poll(() => codeText(page)).toContain("- [Guide](#guide)\n  - [Install](#install)");

    await user.context.close();
  });
});

test.describe("slash command menu on a phone", () => {
  async function phoneUser(browser: Browser) {
    const context = await browser.newContext({ ...devices["Pixel 5"] });
    const page = await context.newPage();
    await devLogin(page, "slash-phone");
    await page.waitForLoadState("networkidle");
    return { context, page };
  }

  test("the menu fits the screen and a tap picks an item", async ({ browser }) => {
    const { context, page } = await phoneUser(browser);
    const id = await createDocument(page, "Intro paragraph.\n");
    await page.goto(`/d/${id}`);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(page.locator(".md-rich")).toBeVisible();
    await focusRichEnd(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    const menu = page.getByTestId("slash-menu");
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: "test-results/slash-phone.png" });
    await page.getByTestId("slash-item-task").tap();
    await expect(menu).toHaveCount(0);
    await expect(page.locator(".md-rich li.md-task-item")).toHaveCount(1);
    await expect.poll(() => codeText(page)).toContain("- [ ]");
    expect(await codeText(page)).not.toContain("/");
    await context.close();
  });
});
