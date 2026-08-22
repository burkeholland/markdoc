import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, codeText, focusRichEnd, selectTextInRich } from "./helpers";

/**
 * Paste into the rich pane by dispatching a synthetic ClipboardEvent with the given
 * clipboard payloads. ProseMirror reads event.clipboardData, so this exercises the same
 * handlePaste path a real Ctrl+V does, without needing clipboard permissions.
 */
async function pasteInRich(page: Page, data: { text: string; html?: string }) {
  await page.evaluate(({ text, html }) => {
    const root = document.querySelector(".ProseMirror") as HTMLElement | null;
    if (!root) throw new Error(".ProseMirror not found");
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    if (html) dt.setData("text/html", html);
    const event = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    root.dispatchEvent(event);
  }, data);
}

test.describe("smart paste in the rich pane", () => {
  test("pasting a URL over a selected word turns it into a link", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "Read the docs for details.\n");
    await openDocument(user.page, id);
    const { page } = user;

    await selectTextInRich(page, "docs");
    await pasteInRich(page, { text: "https://example.com/docs" });

    await expect.poll(() => codeText(page)).toContain("Read the [docs](https://example.com/docs) for details.");
    await expect(page.locator(".md-rich a")).toHaveText("docs");
    await expect(page.locator(".md-rich a")).toHaveAttribute("href", "https://example.com/docs");

    // Undo removes the link as one step.
    await page.getByTestId("tb-undo").click();
    await expect.poll(() => codeText(page)).toBe("Read the docs for details.\n");
    await user.context.close();
  });

  test("pasting a URL with no selection inserts it as text", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "See:\n");
    await openDocument(user.page, id);
    const { page } = user;

    await focusRichEnd(page);
    await page.keyboard.type(" ");
    await pasteInRich(page, { text: "https://example.com" });
    await expect.poll(() => codeText(page)).toContain("See: https://example.com");
    await user.context.close();
  });

  test("pasting multi-line Markdown text inserts it as structure, not escaped text", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "Intro paragraph.\n");
    await openDocument(user.page, id);
    const { page } = user;

    await focusRichEnd(page);
    await page.keyboard.press("Enter");
    await pasteInRich(page, { text: "# Pasted Title\n\n- alpha\n- beta\n\n```js\nconsole.log(1);\n```" });

    await expect(page.locator(".md-rich h1")).toHaveText("Pasted Title");
    await expect(page.locator(".md-rich ul li")).toHaveCount(2);
    await expect(page.locator(".md-rich ul li").first()).toHaveText("alpha");
    await expect(page.locator(".md-rich pre")).toContainText("console.log(1);");

    const source = await codeText(page);
    expect(source).toContain("Intro paragraph.");
    expect(source).toContain("\n# Pasted Title\n");
    expect(source).toContain("- alpha\n- beta");
    expect(source).toContain("```js\nconsole.log(1);\n```");
    expect(source).not.toContain("\\#");
    expect(source).not.toContain("\\-");
    expect(source).not.toContain("\\`");

    // The whole paste undoes as a single step.
    await page.getByTestId("tb-undo").click();
    await expect.poll(() => codeText(page)).not.toContain("Pasted Title");
    await expect.poll(() => codeText(page)).toContain("Intro paragraph.");
    await user.context.close();
  });

  test("pasting a single line of plain text keeps the default behaviour", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "Start\n");
    await openDocument(user.page, id);
    const { page } = user;

    await focusRichEnd(page);
    await page.keyboard.press("Enter");
    await pasteInRich(page, { text: "# not a heading" });
    // One line is literal text: the serializer escapes it and no heading is made.
    await expect.poll(() => codeText(page)).toContain("\\# not a heading");
    await expect(page.locator(".md-rich h1")).toHaveCount(0);
    await expect(page.locator(".md-rich p").last()).toHaveText("# not a heading");
    await user.context.close();
  });

  test("pasting HTML keeps bold and list structure", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "Before.\n");
    await openDocument(user.page, id);
    const { page } = user;

    await focusRichEnd(page);
    await page.keyboard.press("Enter");
    await pasteInRich(page, {
      text: "Some bold text\nfirst\nsecond",
      html: '<meta charset="utf-8"><p>Some <strong>bold</strong> text</p><ul><li>first</li><li>second</li></ul>',
    });

    await expect(page.locator(".md-rich strong")).toHaveText("bold");
    await expect(page.locator(".md-rich ul li")).toHaveCount(2);

    const source = await codeText(page);
    expect(source).toContain("Some **bold** text");
    expect(source).toContain("- first\n- second");
    await user.context.close();
  });
});
