import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn, createDocument, openDocument, codeText, clickCell, type User } from "./helpers";

/**
 * Leaving blocks with the keyboard in the preview (task #415, Burke #1240: "I cannot get out of
 * a blockquote; Enter does nothing"). Every row of the block matrix is driven with real key
 * presses in `.md-rich` and asserted on the Markdown source; the gap between a block and the
 * paragraph created below it must be the paragraph's own margin-top (the `--md-space` rhythm).
 */

const DOC = ["# H1", "", "> A quote line.", "", "## Heading two", "", "- one", "- two", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");

/** Put the caret at the end of the text of the first element matching `selector`, with a real mouse click. */
async function clickEndOf(page: Page, selector: string) {
  const el = page.locator(`.md-rich ${selector}`).first();
  await expect(el).toBeVisible();
  const rect = await el.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = range.getClientRects();
    const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
    return { x: last.right, y: last.top + last.height / 2 };
  });
  await page.mouse.click(rect.x - 1, rect.y);
  await expect
    .poll(() => page.evaluate((sel) => document.getSelection()?.anchorNode?.parentElement?.closest(sel) !== null, `.md-rich ${selector}`), {
      message: `caret should be inside ${selector}`,
    })
    .toBe(true);
}

/** Caret path inside .md-rich (e.g. "blockquote>p") from the DOM selection. */
const caretPath = (page: Page) =>
  page.evaluate(() => {
    const sel = document.getSelection();
    let el = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
    const path: string[] = [];
    while (el && !el.classList.contains("md-rich")) {
      path.unshift(el.tagName.toLowerCase());
      el = el.parentElement;
    }
    return path.join(">");
  });

/** Gap between the first `.md-rich > prev` and its next sibling, and that sibling's margin-top. */
async function gapAfter(page: Page, prev: string) {
  return page.locator(`.md-rich > ${prev}`).first().evaluate((el) => {
    const next = el.nextElementSibling as HTMLElement | null;
    if (!next) throw new Error(`nothing after ${el.tagName}`);
    const a = el.getBoundingClientRect();
    const b = next.getBoundingClientRect();
    return { next: next.tagName.toLowerCase(), gap: b.top - a.bottom, marginTop: parseFloat(getComputedStyle(next).marginTop) };
  });
}

async function expectRhythm(page: Page, prev: string, next: string) {
  const g = await gapAfter(page, prev);
  expect(g.next, `${prev} is followed by ${next}`).toBe(next);
  expect(g.marginTop, `the paragraph after ${prev} gets the --md-space margin`).toBeGreaterThanOrEqual(12);
  expect(Math.abs(g.gap - g.marginTop), `gap after ${prev} (${g.gap.toFixed(1)} px) equals the margin-top (${g.marginTop.toFixed(1)} px)`).toBeLessThan(1);
}

async function setup(browser: Parameters<typeof signIn>[0], login: string, content = DOC): Promise<User> {
  const user = await signIn(browser, login);
  const id = await createDocument(user.page, content);
  await openDocument(user.page, id);
  await expect(user.page.locator(".md-rich blockquote")).toBeVisible();
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
    await clickEndOf(page, "h3");
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");
    await expect.poll(() => codeText(page)).toContain("After h2Three");
    await clickEndOf(page, "h1");
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");
    await expect.poll(() => codeText(page)).toMatch(/^One\n/);
    await context.close();
  });

  test("blockquote: Shift+Enter breaks the line, Backspace at the start lifts the first paragraph out", async ({ browser }) => {
    const { page, context } = await setup(browser, "exit-quote");
    await clickEndOf(page, "blockquote p");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second line");
    await expect.poll(() => codeText(page)).toContain("> A quote line.\\\n> second line");
    await expect.poll(() => caretPath(page)).toBe("blockquote>p");
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Home");
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
    // Shift+Enter breaks the line inside an item; Backspace at the start of the first item makes it a paragraph.
    await clickEndOf(page, "ul li:first-child p");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("more");
    await expect.poll(() => codeText(page)).toContain("- one\\\n  more");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");
    await expect.poll(() => codeText(page)).toMatch(/\n\none\\\nmore\n\n- two/);
    await context.close();
  });

  test("code block: Enter is a newline, three Enters on empty lines or Ctrl+Enter leave it, Backspace at the start demotes it", async ({ browser }) => {
    const { page, context } = await setup(browser, "exit-code", "> q\n\n```ts\nconst a = 1;\n```\n\nEnd.\n");
    await clickEndOf(page, "pre code");
    await page.keyboard.press("Enter");
    await page.keyboard.type("const b = 2;");
    await expect.poll(() => codeText(page)).toContain("const a = 1;\nconst b = 2;\n```");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect.poll(() => codeText(page)).toContain("const b = 2;\n\n\n```");
    await page.keyboard.press("Enter");
    await expect.poll(() => caretPath(page)).toBe("p");
    await page.keyboard.type("Out by Enter");
    await expect.poll(() => codeText(page)).toContain("const b = 2;\n```\n\nOut by Enter\n\nEnd.");
    await expectRhythm(page, "pre", "p");

    await clickEndOf(page, "pre code");
    await page.keyboard.press("Control+Enter");
    await expect.poll(() => caretPath(page)).toBe("p");
    await page.keyboard.type("Out by Ctrl");
    await expect.poll(() => codeText(page)).toContain("```\n\nOut by Ctrl\n\nOut by Enter");

    await clickEndOf(page, "pre code");
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Backspace");
    await expect.poll(() => codeText(page)).not.toContain("```");
    await expect(page.locator(".md-rich pre")).toHaveCount(0);
    await context.close();
  });

  test("table: Tab moves cells, Ctrl+Enter and ArrowDown from the last row leave it, Shift+Enter is a <br>", async ({ browser }) => {
    const { page, context } = await setup(browser, "exit-table");
    await clickCell(page, 1, 0);
    await page.keyboard.press("Tab");
    await page.keyboard.type("x");
    await expect.poll(() => codeText(page)).toMatch(/\| 1 +\| 2x +\|/);
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("y");
    await expect.poll(() => codeText(page)).toMatch(/\| 2x<br>y +\|/);
    await expect(page.locator(".md-rich td br")).toHaveCount(1);

    // The table is the last block: ArrowDown from the last row makes a paragraph after it.
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => caretPath(page)).toBe("p");
    await page.keyboard.type("After table");
    await expect.poll(() => codeText(page)).toMatch(/\| 2x<br>y +\|\n\nAfter table$/);
    await expectRhythm(page, "table", "p");

    // Ctrl+Enter from any cell moves to the block below.
    await clickCell(page, 0, 0);
    await page.keyboard.press("Control+Enter");
    await expect.poll(() => caretPath(page)).toBe("p");
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await expect.poll(() => codeText(page)).toMatch(/After table!$/);
    await context.close();
  });

  test("end of document: Enter always gives a new paragraph; the shortcuts dialog lists the exits", async ({ browser }) => {
    const { page, context } = await setup(browser, "exit-end", "> q\n\nLast.\n");
    await clickEndOf(page, "p:last-child");
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
