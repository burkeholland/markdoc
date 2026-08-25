import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, type User } from "./helpers";
import { LONG_DOC, wordCount } from "./fixtures/burke-scale";

/**
 * The server-rendered preview (`[data-testid="rich-placeholder"]`, issue #118) must lay out exactly
 * like the `.md-rich` pane that replaces it: same base type scale, line-height and block spacing, so
 * that no glyph moves when the editor mounts. It used to carry the reader's 17 px / 1.7 scale while
 * the editor is 16 px / 1.65, which pushed every line ~9 % lower and made the second paragraph jump
 * 55 px upwards at the swap (issue #164). The placeholder's scale now mirrors .md-rich in
 * globals.css ("Rich-pane placeholder scale").
 *
 * The swap is fast on a warm server, so the page's scripts are held back until the placeholder has
 * been measured (no hydration, no Yjs, no ProseMirror); releasing them lets the editor mount and the
 * same blocks are measured again in `.md-rich`.
 */

const SHORT_DOC = [
  "# On-call handbook",
  "",
  "The first paragraph sits right under the title and is long enough to wrap onto a second line at the pane's 528 px of text width.",
  "",
  "The second paragraph is the one that used to jump 55 px when the editor swapped in, so its top is the number to watch.",
  "",
  "A third paragraph, so the list has something to follow: **bold**, _italic_, `inline code` and a [link](https://example.com).",
  "",
].join("\n");

// The Burke-scale document (~12k words) without the constructs the editor renders as something other
// than the reader's HTML: images (placeholder URLs that 404 in the suite), raw inline HTML (the editor
// shows it as source) and footnotes (the editor keeps the definition in place; GFM moves it to the end).
const LONG_PLAIN_DOC = LONG_DOC.split("\n")
  .filter((line) => !line.startsWith("![") && !line.includes("<kbd>") && !/\[\^fn\d+\]/.test(line))
  .join("\n");

interface Block {
  tag: string;
  top: number;
  height: number;
}

interface Snapshot {
  fontSize: string;
  lineHeight: string;
  rootTop: number;
  blocks: Block[];
}

/** Tops of the top-level blocks relative to the surface's own box, so a scrolled pane reads the same. */
async function snapshot(page: Page, selector: string): Promise<Snapshot> {
  return page.locator(selector).evaluate((root) => {
    const rootRect = root.getBoundingClientRect();
    const cs = getComputedStyle(root);
    const blocks = [...root.children]
      .filter((c): c is HTMLElement => c instanceof HTMLElement && !/ProseMirror-|md-remote-caret/.test(c.className) && getComputedStyle(c).display !== "none")
      .map((c) => {
        const r = c.getBoundingClientRect();
        return { tag: c.tagName.toLowerCase(), top: r.top - rootRect.top, height: r.height };
      });
    return { fontSize: cs.fontSize, lineHeight: cs.lineHeight, rootTop: rootRect.top, blocks };
  });
}

/** Measure the placeholder with the editor's scripts held back, then release them and measure `.md-rich`. */
async function measureSwap(page: Page, id: string): Promise<{ before: Snapshot; after: Snapshot }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const scripts = /\/_next\/static\/.*\.js(\?|$)/;
  await page.route(scripts, async (route) => {
    await gate;
    await route.continue();
  });

  await page.goto(`/d/${id}`);
  const placeholder = page.getByTestId("rich-placeholder");
  await expect(placeholder).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const before = await snapshot(page, '[data-testid="rich-placeholder"]');

  release();
  await page.unroute(scripts);
  await expect(placeholder).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  await expect(page.locator(".md-rich")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const after = await snapshot(page, ".md-rich");
  return { before, after };
}

function assertNoJump({ before, after }: { before: Snapshot; after: Snapshot }, label: string) {
  expect(before.fontSize, `${label}: base font-size`).toBe(after.fontSize);
  expect(before.lineHeight, `${label}: base line-height`).toBe(after.lineHeight);
  expect(Math.abs(before.rootTop - after.rootTop), `${label}: the surface itself moved`).toBeLessThanOrEqual(1);
  expect(before.blocks.length, `${label}: block count`).toBeGreaterThan(1);
  expect(after.blocks.map((b) => b.tag), `${label}: block sequence`).toEqual(before.blocks.map((b) => b.tag));

  const deltas = before.blocks.map((b, i) => ({ i, tag: b.tag, dTop: after.blocks[i].top - b.top, dHeight: after.blocks[i].height - b.height }));
  const worst = deltas.reduce((a, b) => (Math.abs(b.dTop) > Math.abs(a.dTop) ? b : a));
  const moved = deltas.filter((d) => Math.abs(d.dTop) > 1).map((d) => `#${d.i} <${d.tag}> top ${d.dTop.toFixed(1)} px (height ${d.dHeight.toFixed(1)} px)`);
  expect(moved, `${label}: blocks that moved at the swap (worst #${worst.i} <${worst.tag}> ${worst.dTop.toFixed(1)} px):\n${moved.join("\n")}`).toEqual([]);
}

test.describe("server-rendered preview matches the editor's layout", () => {
  let user: User;

  test.beforeAll(async ({ browser }) => {
    user = await signIn(browser, "ssr-preview");
  });

  test.afterAll(async () => {
    await user.context.close();
  });

  for (const theme of ["light", "dark"] as const) {
    test(`3-paragraph document, ${theme}: no block moves when the editor swaps in`, async () => {
      const { page } = user;
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate((t) => localStorage.setItem("markdoc:theme", t), theme);
      const id = await createDocument(page, SHORT_DOC, "On-call handbook");

      const swap = await measureSwap(page, id);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(swap.before.blocks.map((b) => b.tag)).toEqual(["h1", "p", "p", "p"]);
      assertNoJump(swap, `short ${theme}`);
    });
  }

  test("12k-word document, light: headings, lists, tables, code and quotes all stay put", async () => {
    const { page } = user;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => localStorage.setItem("markdoc:theme", "light"));
    expect(wordCount(LONG_PLAIN_DOC)).toBeGreaterThan(10_000);
    const id = await createDocument(page, LONG_PLAIN_DOC, "Burke-scale");

    const swap = await measureSwap(page, id);
    const tags = new Set(swap.before.blocks.map((b) => b.tag));
    for (const tag of ["h1", "h2", "h3", "p", "ul", "pre", "table", "blockquote"]) expect(tags, `fixture has a <${tag}>`).toContain(tag);
    assertNoJump(swap, "long light");
  });

  test("12k-word document, dark: same numbers as light", async () => {
    const { page } = user;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => localStorage.setItem("markdoc:theme", "dark"));
    const id = await createDocument(page, LONG_PLAIN_DOC, "Burke-scale");

    const swap = await measureSwap(page, id);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    assertNoJump(swap, "long dark");
  });
});
