import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, codeText, focusRichEnd, focusCodeEnd, selectTextInRich } from "./helpers";

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

const TSV = "Name\tQty\tPrice\nApple\t3\t1.20\nPear\t5\t0.80\n";
const TSV_TABLE = "| Name  | Qty | Price |\n| ----- | --- | ----- |\n| Apple | 3   | 1.20  |\n| Pear  | 5   | 0.80  |";

async function pasteInCode(page: Page, text: string) {
  await page.evaluate((text) => {
    const root = document.querySelector(".cm-content") as HTMLElement | null;
    if (!root) throw new Error(".cm-content not found");
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

test.describe("smart paste of tab-separated text (#166)", () => {
  test("TSV pasted into the rich pane becomes a table; Undo restores the document", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "| a | b |\n| - | - |\n| 1 | 2 |\n\nIntro paragraph.\n");
    await openDocument(user.page, id);
    const { page } = user;
    await expect(page.locator(".md-rich table")).toHaveCount(1);

    await focusRichEnd(page);
    await page.keyboard.press("Enter");
    await pasteInRich(page, { text: TSV });

    await expect(page.locator(".md-rich table")).toHaveCount(2);
    const pasted = page.locator(".md-rich table").nth(1);
    await expect(pasted.locator("th")).toHaveText(["Name", "Qty", "Price"]);
    await expect(pasted.locator("tr")).toHaveCount(3);
    await expect.poll(() => codeText(page)).toContain(TSV_TABLE);
    expect(await codeText(page)).not.toContain("\t");

    const toast = page.getByTestId("toast").filter({ hasText: "Pasted tab-separated text as a table" });
    await expect(toast).toBeVisible();
    await toast.getByTestId("toast-action").click();
    await expect.poll(() => codeText(page)).not.toContain("| Name");
    await expect(page.locator(".md-rich table")).toHaveCount(1);
    await user.context.close();
  });

  test("TSV pasted into the code pane inserts the Markdown table text", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "Intro paragraph.\n");
    await openDocument(user.page, id);
    const { page } = user;

    await focusCodeEnd(page);
    await pasteInCode(page, TSV);

    await expect.poll(() => codeText(page)).toContain(TSV_TABLE);
    await expect(page.locator(".md-rich table")).toHaveCount(1);
    await expect(page.locator(".md-rich table th")).toHaveText(["Name", "Qty", "Price"]);

    // Ctrl+Z takes the whole table out in one step.
    await page.keyboard.press("Control+z");
    await expect.poll(() => codeText(page)).not.toContain("| Name");
    await expect(page.locator(".md-rich table")).toHaveCount(0);
    await user.context.close();
  });

  test("a single line with tabs and ragged rows stay plain text", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "Start\n");
    await openDocument(user.page, id);
    const { page } = user;

    await focusRichEnd(page);
    await page.keyboard.press("Enter");
    await pasteInRich(page, { text: "Name\tQty\tPrice" });
    await expect.poll(() => codeText(page)).toContain("Name\tQty\tPrice");
    await expect(page.locator(".md-rich table")).toHaveCount(0);

    await focusRichEnd(page);
    await page.keyboard.press("Enter");
    await pasteInRich(page, { text: "a\tb\nc\td\te" });
    await expect.poll(() => codeText(page)).toContain("c\td\te");
    await expect(page.locator(".md-rich table")).toHaveCount(0);
    expect(await codeText(page)).not.toContain("|");
    await user.context.close();
  });
});
