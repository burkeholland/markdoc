import { test, expect } from "@playwright/test";
import { signIn, createDocument, openDocument, codeText } from "./helpers";

const SAMPLE = `# Pets

The cat sat on the mat. The cat ran.

Another cat came by later.
`;

async function openFromCodePane(page: import("@playwright/test").Page) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("find-bar")).toBeVisible();
  await expect(page.getByTestId("find-input")).toBeFocused();
}

test.describe("find & replace", () => {
  test("Mod-F opens the bar and a query highlights matches in both panes", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;

    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await openFromCodePane(page);
    // CodeMirror's own search panel must not open.
    await expect(page.locator(".cm-panel.cm-search")).toHaveCount(0);

    await page.keyboard.type("cat");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await expect(page.locator(".cm-content .md-find")).toHaveCount(3);
    await expect(page.locator(".md-rich .md-find")).toHaveCount(3);
    await expect(page.locator(".cm-content .md-find-active")).toHaveCount(1);
    await expect(page.locator(".md-rich .md-find-active")).toHaveCount(1);
    await expect(page.locator(".md-rich .md-find-active")).toHaveText("cat");

    // Options narrow the result set.
    await page.getByTestId("find-match-case").click();
    await page.getByTestId("find-input").fill("Cat");
    await expect(page.getByTestId("find-count")).toHaveText("0 of 0");
    await page.getByTestId("find-match-case").click();
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await user.context.close();
  });

  test("Enter cycles through matches and wraps around", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;

    await openFromCodePane(page);
    await page.keyboard.type("cat");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText("2 of 3");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText("3 of 3");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await page.keyboard.press("Shift+Enter");
    await expect(page.getByTestId("find-count")).toHaveText("3 of 3");
    await page.getByTestId("find-prev").click();
    await expect(page.getByTestId("find-count")).toHaveText("2 of 3");
    await page.getByTestId("find-next").click();
    await expect(page.getByTestId("find-count")).toHaveText("3 of 3");
    await expect(page.locator(".md-rich .md-find-active")).toHaveCount(1);
    await expect(page.locator(".cm-content .md-find-active")).toHaveText("cat");
    await user.context.close();
  });

  test("Replace and Replace all rewrite the source", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;

    // Mod-H opens with the replace row visible.
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Control+h");
    await expect(page.getByTestId("find-bar")).toBeVisible();
    await expect(page.getByTestId("find-replace-row")).toBeVisible();
    await page.getByTestId("find-input").fill("cat");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");

    await page.getByTestId("replace-input").fill("dog");
    await page.getByTestId("replace-one").click();
    await expect.poll(() => codeText(page)).toContain("The dog sat on the mat. The cat ran.");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 2");

    await page.getByTestId("replace-all").click();
    await expect.poll(() => codeText(page)).toBe(SAMPLE.replace(/cat/g, "dog"));
    await expect(page.getByTestId("find-count")).toHaveText("0 of 0");
    await expect(page.locator(".cm-content .md-find")).toHaveCount(0);
    await expect(page.locator(".md-rich p").first()).toContainText("The dog sat on the mat. The dog ran.");
    await user.context.close();
  });

  test("Escape closes the bar and selects the active match in the last active pane", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;

    await openFromCodePane(page);
    await page.keyboard.type("mat");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 1");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expect(page.locator(".cm-content .md-find")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toBeFocused();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("mat");

    // Selecting text in the preview and pressing Mod-F seeds the query with it.
    await page.locator(".md-rich p").last().click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("find-input")).toHaveValue("later");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 1");
    await page.getByTestId("find-close").click();
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await user.context.close();
  });
});
