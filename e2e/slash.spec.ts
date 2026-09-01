import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { signIn, createDocument, openDocument, codeText } from "./helpers";

const mod = process.platform === "darwin" ? "Meta" : "Control";

/** Caret at the start of an empty paragraph after the intro text. */
async function emptyParagraph(page: Page) {
  await page.locator(".md-rich p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.locator(".md-rich p").count()).toBe(2);
}

test.describe("slash command menu", () => {
  test("typing / opens the menu, filters and inserts a heading that shows up in the Markdown", async ({ browser }) => {
    const user = await signIn(browser, "slasher");
    const { page } = user;
    const id = await createDocument(page, "Intro paragraph.\n");
    await openDocument(page, id);
    await emptyParagraph(page);

    await page.keyboard.type("/");
    const menu = page.getByTestId("slash-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("slash-item-heading1")).toBeVisible();
    await expect(page.getByTestId("slash-item-table")).toBeVisible();
    await page.screenshot({ path: "test-results/slash-menu.png" });

    await page.keyboard.type("head");
    await expect(menu.getByRole("option").first()).toHaveAttribute("data-testid", "slash-item-heading1");
    await expect(page.getByTestId("slash-item-heading1")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("slash-item-table")).toHaveCount(0);

    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(page.locator(".md-rich h1")).toHaveCount(1);
    await page.keyboard.type("Title");
    await expect.poll(() => codeText(page)).toContain("Intro paragraph.\n\n# Title");
    expect(await codeText(page)).not.toContain("/head");

    // Arrow keys move the highlight and Enter picks the highlighted row; Escape closes.
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(menu).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("slash-item-heading1")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    expect(await codeText(page)).toContain("/");

    await user.context.close();
  });

  test("/table inserts a table in both panes and hides block items inside cells", async ({ browser }) => {
    const user = await signIn(browser, "slasher");
    const { page } = user;
    const id = await createDocument(page, "Intro paragraph.\n");
    await openDocument(page, id);
    await emptyParagraph(page);

    await page.keyboard.type("/table");
    await expect(page.getByTestId("slash-item-table")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page.locator(".md-rich table")).toBeVisible();
    await expect(page.locator(".md-rich th")).toHaveCount(3);
    await expect.poll(() => codeText(page)).toContain("| Column 1 | Column 2 | Column 3 |");
    expect(await codeText(page)).not.toContain("/table");

    // Inside a cell the menu offers no table or heading insertion.
    await page.locator(".md-rich td").first().click();
    await page.keyboard.type("/");
    await expect(page.getByTestId("slash-menu")).toBeVisible();
    await expect(page.getByTestId("slash-item-table")).toHaveCount(0);
    await expect(page.getByTestId("slash-item-heading1")).toHaveCount(0);
    await expect(page.getByTestId("slash-item-date")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("slash-menu")).toHaveCount(0);

    await user.context.close();
  });

  test("/code ts makes a fenced ts block", async ({ browser }) => {
    const user = await signIn(browser, "slasher");
    const { page } = user;
    const id = await createDocument(page, "Intro paragraph.\n");
    await openDocument(page, id);
    await emptyParagraph(page);

    // A trailing argument sets the code block language.
    await page.keyboard.type("/code ts");
    await expect(page.getByTestId("slash-item-code")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page.locator(".md-rich pre")).toHaveCount(1);
    await page.keyboard.type("let a = 1;");
    await expect.poll(() => codeText(page)).toContain("```ts\nlet a = 1;\n```");

    await user.context.close();
  });

  test("mouse selection, no-match row and undo", async ({ browser }) => {
    const user = await signIn(browser, "slasher");
    const { page } = user;
    const id = await createDocument(page, "Intro paragraph.\n");
    await openDocument(page, id);
    await emptyParagraph(page);
    const before = await codeText(page);

    await page.keyboard.type("/zzz");
    await expect(page.getByTestId("slash-empty")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("slash-menu")).toHaveCount(0);
    expect(await codeText(page)).toContain("/zzz");
    await page.keyboard.press("Shift+Home");
    await page.keyboard.press("Backspace");

    await page.keyboard.type("/");
    await page.getByTestId("slash-item-quote").hover();
    await expect(page.getByTestId("slash-item-quote")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("slash-item-quote").click();
    await expect(page.locator(".md-rich blockquote")).toHaveCount(1);
    await expect.poll(() => codeText(page)).toContain(">");

    // One undo removes the slash insertion: the /query deletion and the block change are
    // a single transaction, so they are always one undo step. The typed "/" is the user's
    // own keystroke and stays a separate step, so it comes back (slash-menu.test.ts covers
    // the second undo that removes it again).
    await page.keyboard.press(`${mod}+z`);
    await expect(page.locator(".md-rich blockquote")).toHaveCount(0);
    await expect.poll(() => codeText(page)).not.toContain(">");
    await expect(page.locator(".md-rich p")).toHaveCount(2);
    await expect(page.locator(".md-rich p").last()).toHaveText("/");
    expect(await codeText(page)).toContain(before.trimEnd());
    expect(await codeText(page)).toContain("/");

    await user.context.close();
  });

  test("the menu is disabled in viewing mode", async ({ browser }) => {
    const user = await signIn(browser, "slasher");
    const { page } = user;
    const id = await createDocument(page, "Intro paragraph.\n");
    await openDocument(page, id);
    await page.getByTestId("preview-mode-toggle").click();
    await expect(page.locator(".md-rich")).toHaveAttribute("contenteditable", "false");
    await page.locator(".md-rich p").first().click();
    await page.keyboard.type("/");
    await expect(page.getByTestId("slash-menu")).toHaveCount(0);
    // The pane is read-only, so the keystroke changes nothing.
    expect(await codeText(page)).toBe("Intro paragraph.\n");

    // In the Markdown pane a slash is just a slash.
    await page.getByTestId("preview-mode-toggle").click();
    await page.locator(".cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" /head");
    await expect(page.getByTestId("slash-menu")).toHaveCount(0);
    await expect.poll(() => codeText(page)).toContain(" /head");

    await user.context.close();
  });
});
