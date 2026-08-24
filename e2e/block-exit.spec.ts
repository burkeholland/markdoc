import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn, createDocument, openDocument, codeText, clickCell, clickEdgeOf, caretPath, expectRhythm, type User } from "./helpers";

/**
 * Leaving blocks with the keyboard in the preview (task #415, Burke #1240: "I cannot get out of
 * a blockquote; Enter does nothing"). Every row of the block matrix is driven with real key
 * presses in `.md-rich` and asserted on the Markdown source; the gap between a block and the
 * paragraph created below it must be the paragraph's own margin-top (the `--md-space` rhythm).
 */

const DOC = ["# H1", "", "> A quote line.", "", "## Heading two", "", "- one", "- two", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");

const clickEndOf = (page: Page, selector: string) => clickEdgeOf(page, selector, "end");
const clickStartOf = (page: Page, selector: string) => clickEdgeOf(page, selector, "start");

async function setup(browser: Parameters<typeof signIn>[0], login: string, content = DOC): Promise<User> {
  const user = await signIn(browser, login);
  const id = await createDocument(user.page, content);
  await openDocument(user.page, id);
  await expect(user.page.locator(".md-rich > :first-child")).toBeVisible();
  return user;
}

test.describe("leaving blocks with the keyboard", () => {
  test("Burke's repro: Enter twice at the end of a quote, then typing — the text lands below the quote, never at the top", async ({ browser }) => {
    const { page, context } = await setup(browser, "exit-repro");
    await clickEndOf(page, "blockquote p");
    const before = await codeText(page);

    await page.keyboard.press("Enter");
    // The first Enter opens an empty line inside the quote; the caret stays in the quote.
    await expect.poll(() => caretPath(page)).toBe("blockquote>p");
    await expect.poll(() => codeText(page)).toContain("> A quote line.\n>\n>\n\n## Heading two");
    await expect(page.locator(".md-rich blockquote p")).toHaveCount(2);

    await page.keyboard.press("Enter");
    await expect.poll(() => caretPath(page)).toBe("p");
    await page.keyboard.type("After quote");
    await expect.poll(() => codeText(page)).toBe(before.replace("> A quote line.\n", "> A quote line.\n\nAfter quote\n"));
    const text = await codeText(page);
    expect(text.startsWith("# H1\n"), "nothing was inserted at the top of the document").toBe(true);
    expect(text).not.toContain("After quoteHeading");
    await expect(page.locator(".md-rich blockquote p")).toHaveCount(1);
    await expectRhythm(page, "blockquote", "p");
    await context.close();
  });

  test("heading h1–h3: Enter gives a paragraph, Shift+Enter too, Backspace at the start merges or demotes", async ({ browser }) => {
    const { page, context } = await setup(browser, "exit-heading", "# One\n\n## Two\n\n### Three\n\nEnd.\n");
    for (const [tag, hashes] of [
      ["h1", "#"],
      ["h2", "##"],
      ["h3", "###"],
    ] as const) {
      await clickEndOf(page, tag);
      await page.keyboard.press("Enter");
      await expect.poll(() => caretPath(page)).toBe("p");
      await page.keyboard.type(`After ${tag}`);
      await expect.poll(() => codeText(page)).toMatch(new RegExp(`^${hashes} \\w+\\n\\nAfter ${tag}\\n`, "m"));
      await expectRhythm(page, tag, "p");
    }
    // Shift+Enter cannot break a heading line: it behaves like Enter.
    await clickEndOf(page, "h2");
    await page.keyboard.press("Shift+Enter");
    await expect.poll(() => caretPath(page)).toBe("p");
    await page.keyboard.type("Soft");
    await expect.poll(() => codeText(page)).toContain("## Two\n\nSoft\n");
    await expect(page.locator(".md-rich h2")).toHaveText("Two");
    // Backspace at the start of the h3 merges it into the paragraph above; at the top the h1 becomes a paragraph.
    await clickStartOf(page, "h3");
    await page.keyboard.press("Backspace");
    await expect.poll(() => codeText(page)).toContain("After h2Three");
    await clickStartOf(page, "h1");
    await page.keyboard.press("Backspace");
    await expect.poll(() => codeText(page)).toMatch(/^One\n/);
    await context.close();
  });

  test("blockquote: Shift+Enter keeps the line break in both panes, Backspace at the start of the first paragraph lifts it out of the quote", async ({ browser }) => {
    const { page, context } = await setup(browser, "exit-quote");
    // Task #434: the break is inserted before anything follows it; it must survive the round trip
    // (spelled `<br>` until the next line exists, then as a trailing backslash).
    await clickEndOf(page, "blockquote p");
    await page.keyboard.press("Shift+Enter");
    await expect.poll(() => caretPath(page)).toBe("blockquote>p");
    await expect.poll(() => codeText(page)).toContain("> A quote line.<br>\n\n## Heading two");
    await page.keyboard.type("second line");
    await expect.poll(() => codeText(page)).toContain("> A quote line.\\\n> second line\n\n## Heading two");
    await expect(page.locator(".md-rich blockquote p")).toHaveCount(1);
    await expect(page.locator(".md-rich blockquote p br")).toHaveCount(1);
    await expect(page.locator(".md-rich blockquote p")).toHaveText("A quote line.second line");
    const lines = await page.locator(".md-rich blockquote p").evaluate((p) => {
      const range = document.createRange();
      range.selectNodeContents(p);
      return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size;
    });
    expect(lines, "the quote paragraph renders as two lines").toBe(2);
    // After a reload the text still has the break.
    await page.reload();
    await expect(page.locator(".md-rich blockquote p br")).toHaveCount(1);
    await expect.poll(() => codeText(page)).toContain("> A quote line.\\\n> second line");

    await clickStartOf(page, "blockquote p");
    await page.keyboard.press("Backspace");
    await expect.poll(() => codeText(page)).toContain("# H1\n\nA quote line.\\\nsecond line\n\n## Heading two");
    await expect(page.locator(".md-rich blockquote")).toHaveCount(0);
    await context.close();
  });

  test("lists (bullet, ordered, task): Enter makes an item, Enter on the empty item leaves the list", async ({ browser }) => {
    const { page, context } = await setup(browser, "exit-list", "> q\n\n- one\n- two\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo\n");
    const cases: [string, string, RegExp][] = [
      ["ul li", "- two\n-", /- two\n\nAfter bullet\n/],
      ["ol li:last-child", "2. second\n3.", /2\. second\n\nAfter ordered\n/],
      ["ul:last-of-type li:last-child", "- [ ] todo\n- [ ]", /- \[ \] todo\n\nAfter task\n/],
    ];
    for (const [selector, intermediate, result] of cases) {
      const word = selector.startsWith("ol") ? "ordered" : selector.includes("last-of-type") ? "task" : "bullet";
      await clickEndOf(page, selector.includes("ul li") && word === "bullet" ? "ul li:nth-child(2) p" : `${selector} p`);
      await page.keyboard.press("Enter");
      await expect.poll(() => codeText(page)).toContain(intermediate);
      await expect.poll(() => caretPath(page)).toMatch(/li>/);
      await page.keyboard.press("Enter");
      await expect.poll(() => caretPath(page)).toBe("p");
      await page.keyboard.type(`After ${word}`);
      await expect.poll(() => codeText(page)).toMatch(result);
    }
    await expectRhythm(page, "ul", "p");
    await expectRhythm(page, "ol", "p");
    // Shift+Enter inside an item keeps the break (task #434): `<br>` until the next line is typed, then a trailing backslash.
    await clickEndOf(page, "ul li:first-child p");
    await page.keyboard.press("Shift+Enter");
    await expect.poll(() => codeText(page)).toContain("- one<br>\n- two");
    await page.keyboard.type("more");
    await expect.poll(() => codeText(page)).toContain("- one\\\n  more\n- two");
    await expect(page.locator(".md-rich ul li:first-child p br")).toHaveCount(1);
    // Backspace at the start of the first item makes it a paragraph.
    await clickStartOf(page, "ul li:first-child p");
    await page.keyboard.press("Backspace");
    await expect.poll(() => codeText(page)).toMatch(/\n\none\\\nmore\n\n- two/);
    await context.close();
  });

  test("code block: Enter ×3 at the end leaves it, Ctrl+Enter leaves it, Backspace at the start demotes it", async ({ browser }) => {
    const { page, context } = await setup(browser, "exit-code", "> q\n\n```ts\nconst a = 1;\n```\n\nEnd.\n");
    // Task #434: the first Enter adds a blank last line that must survive the round trip through the binding.
    await clickEndOf(page, "pre code");
    await page.keyboard.press("Enter");
    await expect.poll(() => codeText(page)).toContain("```ts\nconst a = 1;\n\n```\n\nEnd.");
    await expect.poll(() => caretPath(page)).toMatch(/^pre>code/);
    await page.keyboard.press("Enter");
    await expect.poll(() => codeText(page)).toContain("```ts\nconst a = 1;\n\n\n```\n\nEnd.");
    await page.keyboard.press("Enter");
    await expect.poll(() => caretPath(page)).toBe("p");
    await page.keyboard.type("Out by Enter");
    await expect.poll(() => codeText(page)).toContain("```ts\nconst a = 1;\n```\n\nOut by Enter\n\nEnd.");
    await expectRhythm(page, "pre", "p");

    await clickEndOf(page, "pre code");
    await page.keyboard.press("Control+Enter");
    await expect.poll(() => caretPath(page)).toBe("p");
    await page.keyboard.type("Out by Ctrl");
    await expect.poll(() => codeText(page)).toContain("```\n\nOut by Ctrl\n\nOut by Enter\n\nEnd.");
    await expectRhythm(page, "pre", "p");

    await clickStartOf(page, "pre code");
    await page.keyboard.press("Backspace");
    await expect.poll(() => codeText(page)).not.toContain("```");
    await expect.poll(() => codeText(page)).toContain("> q\n\nconst a = 1;\n\nOut by Ctrl");
    await expect(page.locator(".md-rich pre")).toHaveCount(0);
    await context.close();
  });

  test("table: Tab moves cells, Shift+Enter is a <br> in the cell, Ctrl+Enter and ArrowDown from the last row leave it", async ({ browser }) => {
    const { page, context } = await setup(browser, "exit-table");
    await clickCell(page, 1, 0);
    // Tab selects the next cell's content, so typing replaces it.
    await page.keyboard.press("Tab");
    await page.keyboard.type("x");
    await expect.poll(() => codeText(page)).toMatch(/\| 1 +\| x +\|/);
    // Shift+Enter keeps the break in the cell (task #434); GFM has no multi-line cells, so it is a `<br>`.
    await page.keyboard.press("Shift+Enter");
    await expect.poll(() => codeText(page)).toMatch(/\| 1 +\| x<br> +\|/);
    await page.keyboard.type("y");
    await expect.poll(() => codeText(page)).toMatch(/\| 1 +\| x<br>y +\|/);
    await expect(page.locator(".md-rich table td br")).toHaveCount(1);

    // The table is the last block: ArrowDown from the last row makes a paragraph after it.
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => caretPath(page)).toBe("p");
    await page.keyboard.type("After table");
    await expect.poll(() => codeText(page)).toMatch(/\| 1 +\| x<br>y +\|\n\nAfter table\n?$/);
    await expectRhythm(page, "table", "p");

    // Ctrl+Enter from any cell moves to the start of the block below.
    await clickCell(page, 0, 0);
    await page.keyboard.press("Control+Enter");
    await expect.poll(() => caretPath(page)).toBe("p");
    await page.keyboard.type("!");
    await expect.poll(() => codeText(page)).toMatch(/\n\n!After table\n?$/);
    await context.close();
  });

  test("end of document: Enter always gives a new paragraph; the shortcuts dialog lists the exits", async ({ browser }) => {
    const { page, context } = await setup(browser, "exit-end", "> q\n\nLast.\n");
    await clickEndOf(page, "> p:last-of-type");
    await page.keyboard.press("Enter");
    await page.keyboard.type("New");
    await expect.poll(() => codeText(page)).toBe("> q\n\nLast.\n\nNew\n");
    await page.keyboard.press("Control+/");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Leave a code block");
    await expect(dialog).toContainText("Leave the table");
    await expect(dialog).toContainText("Leave a quote or list");
    const scan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).disableRules(["color-contrast"]).analyze();
    expect(scan.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    await context.close();
  });
});
