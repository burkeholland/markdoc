import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, codeText, selectTextInRich } from "./helpers";

const mod = process.platform === "darwin" ? "Meta" : "Control";
const palette = (page: Page) => page.getByTestId("command-palette");

/** Caret in an empty paragraph after the last block of the rich pane. */
async function emptyParagraph(page: Page) {
  await page.locator(".md-rich p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
}

test.describe("command palette", () => {
  test("Mod-Shift-P opens, 'head' ranks Heading 1 first and Enter applies it", async ({ browser }) => {
    const user = await signIn(browser, "palette");
    const { page } = user;
    const id = await createDocument(page, "Intro paragraph.\n");
    await openDocument(page, id);
    await emptyParagraph(page);

    await page.keyboard.press(`${mod}+Shift+P`);
    await expect(palette(page)).toBeVisible();
    await expect(palette(page)).toHaveAttribute("aria-label", "Command palette");
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await expect(page.getByTestId("palette-item-doc:reader")).toBeVisible();
    await expect(page.getByTestId("palette-item-doc:find")).toContainText(/Ctrl|⌘/);
    await page.screenshot({ path: "test-results/command-palette.png" });

    await page.keyboard.type("head");
    const options = palette(page).getByRole("option");
    await expect(options.first()).toHaveAttribute("data-testid", "palette-item-block:heading1");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("palette-item-doc:share")).toHaveCount(0);

    await page.keyboard.press("Enter");
    await expect(palette(page)).toHaveCount(0);
    await expect(page.locator(".md-rich h1")).toHaveCount(1);
    await page.keyboard.type("Title");
    await expect.poll(() => codeText(page)).toContain("Intro paragraph.\n\n# Title");

    // Escape closes without running anything; "No matching commands" for junk.
    await page.keyboard.press(`${mod}+Shift+P`);
    await expect(palette(page)).toBeVisible();
    await page.keyboard.type("zzzzqqq");
    await expect(page.getByTestId("palette-empty")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette(page)).toHaveCount(0);
    expect(await codeText(page)).not.toContain("zzzz");
    await user.context.close();
  });

  test("Mod-K opens the palette with a collapsed selection and the Link dialog with a selected word", async ({ browser }) => {
    const user = await signIn(browser, "palette");
    const { page } = user;
    const id = await createDocument(page, "Read the docs for details.\n");
    await openDocument(page, id);

    await page.locator(".md-rich p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.press(`${mod}+k`);
    await expect(palette(page)).toBeVisible();
    await expect(page.getByTestId("link-url")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(palette(page)).toHaveCount(0);

    await selectTextInRich(page, "the docs");
    await page.keyboard.press(`${mod}+k`);
    await expect(page.getByTestId("link-url")).toBeVisible();
    await expect(palette(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await user.context.close();
  });

  test("Go to heading lists the headings and moves the caret; Backspace goes back", async ({ browser }) => {
    const user = await signIn(browser, "palette");
    const { page } = user;
    const id = await createDocument(page, "# First\n\nText one.\n\n## Second\n\nText two.\n\n### Third\n\nText three.\n");
    await openDocument(page, id);
    await page.locator(".md-rich p").first().click();

    await page.keyboard.press(`${mod}+Shift+P`);
    await page.keyboard.type("go to head");
    await expect(palette(page).getByRole("option").first()).toHaveAttribute("data-testid", "palette-item-nav:heading");
    await page.keyboard.press("Enter");
    await expect(palette(page)).toBeVisible();
    await expect(page.getByTestId("palette-back")).toBeVisible();
    const headings = palette(page).getByRole("option");
    await expect(headings).toHaveCount(3);
    await expect(headings.nth(0)).toContainText("First");
    await expect(headings.nth(2)).toContainText("Third");

    await page.keyboard.press("Backspace");
    await expect(page.getByTestId("palette-back")).toHaveCount(0);
    await expect(page.getByTestId("palette-item-nav:heading")).toBeVisible();
    await page.getByTestId("palette-item-nav:heading").click();
    await expect(headings).toHaveCount(3);

    await page.keyboard.type("thi");
    await expect(headings).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(palette(page)).toHaveCount(0);
    await expect(page.locator(".cm-activeLine")).toContainText("### Third");
    await user.context.close();
  });

  test("a recently run command floats to the top on reopen", async ({ browser }) => {
    const user = await signIn(browser, "palette");
    const { page } = user;
    const id = await createDocument(page, "Hello.\n");
    await openDocument(page, id);
    await page.locator(".md-rich p").first().click();

    await page.keyboard.press(`${mod}+Shift+P`);
    await expect(palette(page).getByRole("option").first()).not.toHaveAttribute("data-testid", "palette-item-view:outline");
    await page.keyboard.type("outline");
    await expect(palette(page).getByRole("option").first()).toHaveAttribute("data-testid", "palette-item-view:outline");
    await page.keyboard.press("Enter");
    await expect(palette(page)).toHaveCount(0);
    await expect(page.getByTestId("outline-collapsed")).toBeVisible();

    await page.keyboard.press(`${mod}+Shift+P`);
    await expect(palette(page)).toBeVisible();
    await expect(palette(page).getByRole("option").first()).toHaveAttribute("data-testid", "palette-item-view:outline");
    await expect(palette(page).getByRole("group", { name: "Recent" })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("markdoc:paletteRecent"))).toContain("view:outline");
    await page.keyboard.press("Escape");
    await user.context.close();
  });

  test("on the dashboard Mod-K shows templates and picking Meeting notes lands in the editor", async ({ browser }) => {
    const user = await signIn(browser, "palette-dash");
    const { page } = user;
    await page.locator("body").click();
    await page.keyboard.press(`${mod}+k`);
    await expect(palette(page)).toBeVisible();
    await expect(page.getByTestId("palette-item-dash:new")).toBeVisible();
    await expect(page.getByTestId("palette-item-dash:signout")).toBeVisible();
    await expect(page.getByTestId("palette-item-doc:share")).toHaveCount(0);

    await page.getByTestId("palette-item-dash:template").click();
    await expect(palette(page).getByRole("option")).toHaveCount(8);
    await page.keyboard.type("meeting");
    await expect(palette(page).getByRole("option").first()).toHaveAttribute("data-testid", "palette-item-template:meeting-notes");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/d\/[^/]+$/);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(page.getByTestId("title")).toHaveText("Meeting notes");
    await user.context.close();
  });
});
