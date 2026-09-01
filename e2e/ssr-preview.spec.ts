import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { signIn, createDocument, waitForHydration, type User } from "./helpers";
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

  // "load" (and DOMContentLoaded, which waits for deferred scripts) never fires while the scripts are held.
  await page.goto(`/d/${id}`, { waitUntil: "commit" });
  const placeholder = page.getByTestId("rich-placeholder");
  await expect(placeholder).toBeVisible();
  // The stylesheet and the fonts are not gated; wait for them so the measurement is the settled one.
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="rich-placeholder"]')!).maxWidth === "820px");
  await page.evaluate(() => document.fonts.ready);
  const before = await snapshot(page, '[data-testid="rich-placeholder"]');

  release();
  // The route stays installed (it now continues every script at once); unrouting while the held
  // requests are still being continued trips "Route is already handled".
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

/**
 * The editor stack loads behind the server-rendered chrome (task #1545): `/d/<id>` ships a placeholder
 * of the shell's outer boxes (`[data-testid="editor-loading"]`) and `next/dynamic({ ssr: false })` swaps
 * the shell in once its chunks are down. Two things must hold for that swap to be invisible: the shell
 * mounts inside the same `display: contents` host as the placeholder (React would otherwise append it at
 * the end of `<body>`, behind the skip link and the portals), and every chrome box of the placeholder is
 * the shell's to the pixel — header, toolbar, rail, pane-label row, status bar — so nothing in the preview moves.
 */
test.describe("editor stack loads behind the server-rendered chrome", () => {
  let user: User;

  test.beforeAll(async ({ browser }) => {
    user = await signIn(browser, "ssr-defer");
  });

  test.afterAll(async () => {
    await user.context.close();
  });

  const CHROME = {
    header: ['[data-testid="editor-loading"] > header', 'header[data-testid="header"]'],
    toolbar: ['[data-testid="editor-loading"] > header + div', '[data-testid="toolbar"]'],
    "outline rail": ['[data-testid="editor-loading"] main > div:nth-child(2)', 'aside[data-testid="outline"]'],
    "code column": ['[data-testid="editor-loading"] main > div:nth-child(3) > div:nth-child(1)', '[data-testid="code-column"]'],
    "rich column": ['[data-testid="editor-loading"] .rich-column', '[data-testid="rich-column"]'],
    "pane-label row": ['[data-testid="editor-loading"] .rich-column > div:nth-child(1)', '[data-testid="rich-column"] > div:nth-child(1)'],
    "status bar": ['[data-testid="editor-loading"] > footer', 'footer[data-testid="status-bar"]'],
  } as const;

  const boxOf = (page: Page, selector: string) =>
    page.locator(selector).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(",");
    });

  test("the shell mounts where the placeholder was, keeps body order, and every chrome box is the same", async () => {
    const { page } = user;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => localStorage.setItem("markdoc:theme", "light"));
    const id = await createDocument(page, SHORT_DOC, "Deferred shell");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/_next\/static\/.*\.js(\?|$)/, async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto(`/d/${id}`, { waitUntil: "commit" });

    const loading = page.getByTestId("editor-loading");
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute("aria-busy", "true");
    await expect(page.getByTestId("editor-shell")).toHaveCount(0);
    await expect(page.getByTestId("rich-placeholder").locator("h1")).toHaveText("On-call handbook");
    // Landmarks are there before any script: header, main, footer.
    await expect(loading.locator("header")).toHaveCount(1);
    await expect(loading.locator("main#editor-main")).toHaveCount(1);
    await expect(loading.locator("footer")).toHaveCount(1);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="rich-placeholder"]')!).maxWidth === "820px");
    const placeholderBoxes: Record<string, string> = {};
    for (const [name, [before]] of Object.entries(CHROME)) placeholderBoxes[name] = await boxOf(page, before);
    // Tag the first child of <body> so we can tell it is the very same node after the swap, and note where the host sits.
    // A JS property, not an attribute: React would report an attribute it did not render as a hydration mismatch.
    const bodyFirst = await page.evaluate(() => {
      const first = document.body.children[0] as HTMLElement & { __e2eBodyFirst?: true };
      first.__e2eBodyFirst = true;
      return `${first.tagName.toLowerCase()}${first.className ? "." + first.className.trim().split(/\s+/).join(".") : ""}`;
    });
    const hostIndex = () => page.evaluate(() => [...document.body.children].indexOf(document.querySelector('[data-testid="editor-root"]')!));
    const hostIndexBefore = await hostIndex();
    expect(hostIndexBefore).toBeGreaterThanOrEqual(0);

    release();
    const shell = page.getByTestId("editor-shell");
    await shell.waitFor({ state: "attached", timeout: 30_000 });
    await expect(loading).toHaveCount(0);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });

    // Same host: the shell is a child of the `display: contents` root, not a late sibling at the end of <body>.
    await expect(shell.locator("xpath=..")).toHaveAttribute("data-testid", "editor-root");
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="editor-root"]')!).display)).toBe("contents");
    expect(await page.evaluate(() => (document.body.children[0] as HTMLElement & { __e2eBodyFirst?: true }).__e2eBodyFirst === true), `body's first child changed (was ${bodyFirst})`).toBe(true);
    expect(await hostIndex(), "the host moved among body's children").toBe(hostIndexBefore);

    const moved: string[] = [];
    for (const [name, [, after]] of Object.entries(CHROME)) {
      const box = await boxOf(page, after);
      if (box !== placeholderBoxes[name]) moved.push(`${name}: placeholder ${placeholderBoxes[name]} → shell ${box}`);
    }
    expect(moved, `chrome boxes that differ between placeholder and shell (left,top,width,height):\n${moved.join("\n")}`).toEqual([]);
  });

  test("hydrated placeholder announces the load; the live region goes with the placeholder", async () => {
    const { page } = user;
    await page.setViewportSize({ width: 1280, height: 800 });
    const id = await createDocument(page, SHORT_DOC, "Deferred shell live region");

    // Hold back only the chunks that are not in the server HTML: the page hydrates (placeholder effects
    // run), while the editor's own chunks — requested by the dynamic import — wait.
    const html = await (await page.request.get(`/d/${id}`)).text();
    const initial = new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => new URL(m[1], page.url()).pathname));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/_next\/static\/.*\.js(\?|$)/, async (route) => {
      if (!initial.has(new URL(route.request().url()).pathname)) await gate;
      await route.continue();
    });
    await page.goto(`/d/${id}`, { waitUntil: "commit" });
    await waitForHydration(page);

    const status = page.getByTestId("editor-loading-status");
    await expect(status).toHaveText("Loading the editor…");
    await expect(status).toHaveAttribute("role", "status");
    await expect(status).toHaveAttribute("aria-live", "polite");
    // Outside the busy subtree, so assistive technology does not suppress it.
    await expect(page.locator('[data-testid="editor-loading"] [data-testid="editor-loading-status"]')).toHaveCount(0);
    await expect(page.getByTestId("editor-shell")).toHaveCount(0);
    // Nothing in the placeholder takes focus: its only controls-to-be are empty boxes and the preview is `inert`.
    expect(
      await page.evaluate(() =>
        [...document.querySelector('[data-testid="editor-loading"]')!.querySelectorAll("a, button, input, textarea, select, [tabindex]")].filter((el) => !el.closest("[inert]")).length,
      ),
    ).toBe(0);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.querySelector('[data-testid="editor-loading"]')!.contains(document.activeElement))).toBe(false);

    release();
    await page.getByTestId("editor-shell").waitFor({ state: "attached", timeout: 30_000 });
    await expect(status).toHaveCount(0);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  });
});
