import { test, expect } from "./fixtures";
import { signIn, createDocument, openDocument, codeText, focusCodeEnd } from "./helpers";

/** Selects `word` on the current code-pane line by walking the caret with Shift+ArrowLeft from the line end. */
async function selectLastWordInCode(page: import("@playwright/test").Page, word: string) {
  await page.keyboard.press("End");
  for (let i = 0; i < word.length; i++) await page.keyboard.press("Shift+ArrowLeft");
}

test.describe("code pane typing", () => {
  test("``` opens a fenced block, the language goes after the fence and Enter lands inside", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "# Notes\n\nIntro.\n");
    await openDocument(user.page, id);
    const { page } = user;

    await focusCodeEnd(page);
    await page.keyboard.type("```");
    await expect.poll(() => codeText(page)).toBe("# Notes\n\nIntro.\n```\n\n```");
    await page.keyboard.type("ts");
    await page.keyboard.press("Enter");
    await page.keyboard.type("const a = 1");
    await expect.poll(() => codeText(page)).toBe("# Notes\n\nIntro.\n```ts\nconst a = 1\n```");

    const block = page.locator('.md-rich pre[data-language="ts"] code');
    await expect(block).toHaveText("const a = 1");
    expect((await codeText(page)).split("\n").filter((l) => l.startsWith("```"))).toHaveLength(2);
    await user.context.close();
  });

  test("* wraps a selection (twice for bold) and ` is never auto-paired", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "Make this word strong\n");
    await openDocument(user.page, id);
    const { page } = user;

    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+Home");
    await selectLastWordInCode(page, "strong");
    await page.keyboard.press("*");
    await expect.poll(() => codeText(page)).toContain("Make this word *strong*");
    await page.keyboard.press("*");
    await expect.poll(() => codeText(page)).toContain("Make this word **strong**");
    await expect(page.locator(".md-rich strong")).toHaveText("strong");

    await page.keyboard.press("End");
    await page.keyboard.type(" `x`");
    await expect.poll(() => codeText(page)).toContain("**strong** `x`");
    await expect(page.locator(".md-rich code")).toHaveText("x");
    await user.context.close();
  });

  test("[ turns a selection into a link with the caret inside the parens", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "Read the docs\n");
    await openDocument(user.page, id);
    const { page } = user;

    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+Home");
    await selectLastWordInCode(page, "docs");
    await page.keyboard.press("[");
    await expect.poll(() => codeText(page)).toContain("Read the [docs]()");
    await page.keyboard.type("https://example.com/docs");
    await expect.poll(() => codeText(page)).toContain("Read the [docs](https://example.com/docs)");
    const link = page.locator(".md-rich a", { hasText: "docs" });
    await expect(link).toHaveAttribute("href", "https://example.com/docs");
    await user.context.close();
  });

  test("Tab nests a list item and Shift-Tab un-nests it", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "- parent\n- child\n");
    await openDocument(user.page, id);
    const { page } = user;

    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Tab");
    await expect.poll(() => codeText(page)).toContain("- parent\n  - child");
    await expect(page.locator(".md-rich li ul li")).toHaveText("child");
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => codeText(page)).toContain("- parent\n- child");
    await user.context.close();
  });
});
