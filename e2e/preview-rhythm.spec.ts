import { test, expect } from "./fixtures";
import { devices, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn, devLogin, createDocument, openDocument, setTheme, focusRichEnd, shareWith } from "./helpers";

/**
 * Vertical rhythm of rendered Markdown (task #346, Burke #1057: "things run together in the preview").
 * Measures the real gaps between consecutive blocks with getBoundingClientRect in the rich editor
 * (light, dark, phone) and in the reader view, which share the rhythm rules in globals.css.
 *
 * Expected at a 16 px base (the reader is 17 px; the windows below cover both):
 *   heading -> first block   --md-space-heading-after 0.45em ≈ 7 px   (window 6–14)
 *   block -> block           --md-space               0.9em  ≈ 14 px  (window 12–16; a `pre` is 0.9em of its own 0.9em font, ≈ 13 px)
 *   h2 -> h3                 heading-after on the h3, 0.45em of 20 px ≈ 9 px (window 6–14)
 *   block -> h2 text         margin + padding of the h2 (--md-space-heading-before-h2) ≥ 24 px
 */

const DOC = [
  "# Rhythm fixture",
  "",
  "Intro paragraph under the title, long enough to wrap onto a second line when the pane is narrow on a phone.",
  "",
  "## Section",
  "",
  "First paragraph under the h2.",
  "",
  "Second paragraph right after the first one.",
  "",
  "### Subsection",
  "",
  "Paragraph under the h3, followed by a table.",
  "",
  "| Area | Status |",
  "| --- | --- |",
  "| Sync | Shipped |",
  "| Reader | Shipped |",
  "",
  "Paragraph after the table, followed by a list.",
  "",
  "- one",
  "- two",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "> A quote after the code block.",
  "",
  "---",
  "",
  "![Markdoc logo](/favicon.ico)",
  "",
  "## Second section",
  "",
  "### Directly nested",
  "",
  "Last words.",
  "",
].join("\n");

interface Gap {
  prev: string;
  next: string;
  /** next.top - prev.bottom: the space between the two boxes. */
  gap: number;
  /** Same, but to the top of next's content (past its border and padding) — the visual gap to a heading's text. */
  textGap: number;
  marginTop: number;
}

/** Gaps between consecutive visible direct children of `root`, in document order. */
async function measure(page: Page, root: string): Promise<Gap[]> {
  return page.locator(root).evaluate((el) => {
    const kids = [...el.children].filter((c): c is HTMLElement => c instanceof HTMLElement && getComputedStyle(c).display !== "none");
    const out: { prev: string; next: string; gap: number; textGap: number; marginTop: number }[] = [];
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1].getBoundingClientRect();
      const b = kids[i].getBoundingClientRect();
      const cs = getComputedStyle(kids[i]);
      out.push({
        prev: kids[i - 1].tagName.toLowerCase(),
        next: kids[i].tagName.toLowerCase(),
        gap: b.top - a.bottom,
        textGap: b.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) - a.bottom,
        marginTop: parseFloat(cs.marginTop),
      });
    }
    return out;
  });
}

function pair(gaps: Gap[], prev: string, next: string, nth = 0): Gap {
  const hits = gaps.filter((g) => g.prev === prev && g.next === next);
  const hit = hits[nth];
  if (!hit) throw new Error(`no ${prev} -> ${next} pair #${nth} in ${gaps.map((g) => `${g.prev}>${g.next}`).join(" ")}`);
  return hit;
}

const BLOCK = { min: 12, max: 16 };
const AFTER_HEADING = { min: 6, max: 14 };

/** The whole rhythm, asserted on one rendered surface. `label` names the surface in failures. */
function assertRhythm(gaps: Gap[], label: string) {
  const within = (g: Gap, { min, max }: { min: number; max: number }, what: string) => {
    expect(g.gap, `${label}: ${what} (${g.prev} -> ${g.next}) gap ${g.gap.toFixed(1)} px`).toBeGreaterThanOrEqual(min);
    expect(g.gap, `${label}: ${what} (${g.prev} -> ${g.next}) gap ${g.gap.toFixed(1)} px`).toBeLessThanOrEqual(max);
    // The gap is the child's own margin-top (no bottom margins anywhere in the system; ±0.5 px for a
    // collapsed table border that sits half outside the table box).
    expect(Math.abs(g.gap - g.marginTop), `${label}: ${what} gap should equal the child's margin-top`).toBeLessThan(1);
  };

  // The reader hides the document's leading h1 (the page title repeats it), so h1 -> p exists only in the editor.
  const h1p = gaps.find((g) => g.prev === "h1" && g.next === "p");
  if (h1p) within(h1p, AFTER_HEADING, "h1 -> p");
  within(pair(gaps, "h2", "p"), AFTER_HEADING, "h2 -> p");
  within(pair(gaps, "h3", "p"), AFTER_HEADING, "h3 -> p");
  within(pair(gaps, "h2", "h3"), AFTER_HEADING, "h2 -> h3");
  within(pair(gaps, "p", "p"), BLOCK, "p -> p");
  within(pair(gaps, "p", "table"), BLOCK, "p -> table");
  within(pair(gaps, "table", "p"), BLOCK, "table -> p");
  within(pair(gaps, "p", "ul"), BLOCK, "p -> ul");
  within(pair(gaps, "ul", "pre"), BLOCK, "ul -> pre");
  within(pair(gaps, "pre", "blockquote"), BLOCK, "pre -> blockquote");

  // A thematic break gets more air than a paragraph break, on both sides.
  for (const g of [pair(gaps, "blockquote", "hr"), pair(gaps, "hr", "p")]) {
    expect(g.gap, `${label}: ${g.prev} -> ${g.next} gap ${g.gap.toFixed(1)} px`).toBeGreaterThanOrEqual(20);
    expect(g.gap, `${label}: ${g.prev} -> ${g.next} gap ${g.gap.toFixed(1)} px`).toBeLessThanOrEqual(32);
  }

  // Section starts: previous block bottom -> h2 text top, border and padding included.
  for (const g of gaps.filter((x) => x.next === "h2")) {
    expect(g.textGap, `${label}: ${g.prev} -> h2 text gap ${g.textGap.toFixed(1)} px`).toBeGreaterThanOrEqual(24);
    expect(g.textGap, `${label}: ${g.prev} -> h2 text gap ${g.textGap.toFixed(1)} px`).toBeLessThanOrEqual(48);
  }
}

const previewGaps = (page: Page) => measure(page, ".md-rich");

async function waitForPreview(page: Page) {
  await expect(page.locator(".md-rich table")).toBeVisible();
  await expect(page.locator(".md-rich pre")).toBeVisible();
  await expect(page.locator(".md-rich hr")).toBeVisible();
  await expect(page.locator(".md-rich h2").nth(1)).toBeVisible();
  // The image decides the hr's and the second h2's position; wait for it so the gaps are final
  // (ProseMirror adds its own `img.ProseMirror-separator`, hence the alt filter).
  await page.locator(".md-rich img[alt='Markdoc logo']").evaluate((img: HTMLImageElement) => img.complete || new Promise((r) => img.addEventListener("load", r, { once: true })));
}

test.describe("preview vertical rhythm", () => {
  test("editor preview: headings hug their first block, blocks breathe, tables have air (light and dark)", async ({ browser }) => {
    const { page, context } = await signIn(browser, "rhythm-editor");
    const id = await createDocument(page, DOC, "Rhythm fixture");
    await openDocument(page, id);
    await waitForPreview(page);

    const light = await previewGaps(page);
    expect(light.some((g) => g.prev === "h1" && g.next === "p"), "the editor shows the title h1 followed by the intro").toBe(true);
    assertRhythm(light, "editor light");
    // The first block starts flush with the pane (no leading gap).
    expect(await page.locator(".md-rich > :first-child").evaluate((el) => parseFloat(getComputedStyle(el).marginTop))).toBe(0);

    await setTheme(page, "dark");
    await expect(page.locator(".md-rich")).toBeVisible();
    await waitForPreview(page);
    const dark = await previewGaps(page);
    assertRhythm(dark, "editor dark");
    // Tokens are em-based and theme-independent: the same numbers in both themes.
    expect(dark.map((g) => `${g.prev}>${g.next}:${g.gap.toFixed(1)}`)).toEqual(light.map((g) => `${g.prev}>${g.next}:${g.gap.toFixed(1)}`));

    await context.close();
  });

  test("reader view /p/<id> uses the same rhythm", async ({ browser }) => {
    const owner = await signIn(browser, "rhythm-reader");
    const id = await createDocument(owner.page, DOC, "Rhythm fixture");
    expect((await owner.page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "view" } })).ok()).toBeTruthy();

    const anon = await browser.newContext();
    const page = await anon.newPage();
    await page.goto(`/p/${id}`);
    const body = page.getByTestId("reader-body");
    await expect(body.locator("table")).toBeVisible();
    await body.locator("img").evaluate((img: HTMLImageElement) => img.complete || new Promise((r) => img.addEventListener("load", r, { once: true })));

    const gaps = await measure(page, '[data-testid="reader-body"]');
    assertRhythm(gaps, "reader");
    // The visible first block starts flush when the leading h1 is hidden.
    if ((await body.getAttribute("data-hide-first-h1")) === "true") {
      expect(await body.locator(":scope > :nth-child(2)").evaluate((el) => parseFloat(getComputedStyle(el).marginTop))).toBe(0);
    }

    await anon.close();
    await owner.context.close();
  });

  test("phone layout (390×844) keeps the same rhythm", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await devLogin(page, "rhythm-phone");
    const id = await createDocument(page, DOC, "Rhythm fixture");
    await page.goto(`/d/${id}`);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(page.getByTestId("editor-shell")).toHaveAttribute("data-breakpoint", "phone");
    await waitForPreview(page);

    assertRhythm(await previewGaps(page), "phone");
    await context.close();
  });

  test("axe: the preview has no violations in light or dark", async ({ browser }) => {
    const { page, context } = await signIn(browser, "rhythm-axe");
    const id = await createDocument(page, DOC, "Rhythm fixture");
    await openDocument(page, id);
    await waitForPreview(page);

    // Same rule set as e2e/a11y.spec.ts: color-contrast is skipped in the light theme (axe cannot
    // resolve it through the translucent chrome) and enforced in dark. The whole editor is scanned:
    // this 40-line fixture makes both panes scroll, which is exactly the case that used to trip
    // `scrollable-region-focusable` on the rich pane's scroller (fixed in task #361 — the
    // contenteditable `.ProseMirror` now carries tabindex="0", see src/editor/prosemirror/setup.ts).
    const scan = async (contrast: boolean) =>
      new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .disableRules(contrast ? [] : ["color-contrast"])
        .analyze();
    const light = await scan(false);
    expect(light.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

    await setTheme(page, "dark");
    await waitForPreview(page);
    const dark = await scan(true);
    expect(dark.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    await context.close();
  });
});

/**
 * Space below a picture (Burke #2348). A picture is drawn as a block, so words that follow it in the
 * same paragraph (a picture, then "I asked" typed right after it) start a new line under it. That line
 * used to touch the picture: 0 px. It now sits one paragraph space below, in the visual pane and on
 * the published page. A picture that ends its paragraph was never too close to the next block (the
 * next block brings its own margin-top), and must not gain anything from the rule.
 *
 * Gaps are measured to the line box of the words (the glyph box plus half the leading), the same edge
 * a paragraph's own box has, so "picture -> words" and "paragraph -> paragraph" compare like for like.
 */
const PICTURE = "/brand/og.png";
const PICTURE_DOC = [
  "# Picture fixture",
  "",
  "First paragraph.",
  "",
  "Second paragraph.",
  "",
  `![typed-after](${PICTURE})`,
  "Words typed after the picture, in the same paragraph.",
  "",
  "A paragraph after the typed words.",
  "",
  `[![linked](${PICTURE})](https://example.com/) words after a picture that is a link.`,
  "",
  `![then-line-break](${PICTURE})\\`,
  "Words after a hard line break, which is already an empty line under the picture.",
  "",
  "Before a picture alone in its paragraph.",
  "",
  `![then-paragraph](${PICTURE})`,
  "",
  "A paragraph of its own after the picture.",
  "",
  `![then-heading](${PICTURE})`,
  "",
  "## A heading after the picture",
  "",
  "- A list item with a picture",
  "",
  `  ![in-list](${PICTURE})`,
  "",
  "  and words after it.",
  "- The next item",
  "",
  `> ![in-quote](${PICTURE})`,
  ">",
  "> Words in the same quote.",
  "",
  "| Picture | Words |",
  "| --- | --- |",
  `| ![in-table](${PICTURE}) | beside it |`,
  "",
  "Before the last picture.",
  "",
  `![at-end](${PICTURE})`,
  "",
].join("\n");

interface PictureGap {
  /** Picture bottom -> top of the next thing a person sees: the line box of the next words, or the next box. */
  below: number | null;
  /** Bottom of the previous words' line box (or box) -> picture top. */
  above: number | null;
  /** The picture's own computed margin-bottom. */
  marginBottom: number;
  /** Bottom of the block that holds the picture -> top of the next block, and that block's margin-top (top-level pictures). */
  blockGap: number | null;
  nextMarginTop: number | null;
  /** Bottom of the surface's content box -> picture bottom: what a picture leaves under itself at the end of the document. */
  toEnd: number;
  radius: string;
  display: string;
}

/** The gaps around every picture with an alt text inside `root`, keyed by alt. */
async function pictureGaps(page: Page, root: string): Promise<Record<string, PictureGap>> {
  const surface = page.locator(root);
  await surface.evaluate((el) =>
    Promise.all([...el.querySelectorAll<HTMLImageElement>("img[alt]:not([alt=''])")].map((img) => img.complete || new Promise((r) => img.addEventListener("load", r, { once: true })))),
  );
  return surface.evaluate((el) => {
    const BOXES = new Set(["IMG", "PRE", "FIGURE", "TABLE", "HR"]);
    // Everything a person sees, in document order: text with words in it, and boxes. ProseMirror's own
    // nodes after a picture (a separator image, the trailing break) hold no words and are not boxes here.
    const drawn: (Text | HTMLElement)[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n instanceof Text ? n.data.trim() !== "" : n instanceof HTMLElement && BOXES.has(n.tagName) && !n.classList.contains("ProseMirror-separator")) drawn.push(n as Text | HTMLElement);
    }
    const edges = (n: Text | HTMLElement, lastWord: boolean) => {
      if (n instanceof HTMLElement) return n.getBoundingClientRect();
      const at = lastWord ? n.data.trimEnd().length - 1 : n.data.length - n.data.trimStart().length;
      const range = document.createRange();
      range.setStart(n, at);
      range.setEnd(n, at + 1);
      const glyphs = range.getBoundingClientRect();
      const halfLeading = (parseFloat(getComputedStyle(n.parentElement!).lineHeight) - glyphs.height) / 2;
      return { top: glyphs.top - halfLeading, bottom: glyphs.bottom + halfLeading };
    };
    const style = getComputedStyle(el);
    const contentBottom = el.getBoundingClientRect().bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth);
    const out: Record<string, PictureGap> = {};
    drawn.forEach((n, i) => {
      if (!(n instanceof HTMLImageElement) || !n.alt) return;
      const box = n.getBoundingClientRect();
      const own = getComputedStyle(n);
      const block = [...el.children].find((child) => child.contains(n));
      const nextBlock = block?.nextElementSibling ?? null;
      out[n.alt] = {
        below: drawn[i + 1] ? edges(drawn[i + 1], false).top - box.bottom : null,
        above: drawn[i - 1] ? box.top - edges(drawn[i - 1], true).bottom : null,
        marginBottom: parseFloat(own.marginBottom),
        blockGap: block && nextBlock ? nextBlock.getBoundingClientRect().top - block.getBoundingClientRect().bottom : null,
        nextMarginTop: nextBlock ? parseFloat(getComputedStyle(nextBlock).marginTop) : null,
        toEnd: contentBottom - box.bottom,
        radius: own.borderRadius,
        display: own.display,
      };
    });
    return out;
  });
}

/** Paragraph -> paragraph on this surface: the space the rule must give the words under a picture. */
async function paragraphSpace(page: Page, root: string): Promise<number> {
  const gap = pair(await measure(page, root), "p", "p");
  expect(gap.gap, "the fixture's first two paragraphs are one block space apart").toBeGreaterThanOrEqual(BLOCK.min);
  return gap.gap;
}

/** The line-box edge is computed from the glyph box, which the browser rounds: allow 1 px. */
const ROUNDING = 1;

function assertPictureSpacing(gaps: Record<string, PictureGap>, space: number, surface: "editor" | "reader") {
  const px = (n: number | null) => (n === null ? "none" : `${n.toFixed(1)} px`);
  const at = (alt: string) => {
    const gap = gaps[alt];
    if (!gap) throw new Error(`${surface}: no picture "${alt}" in ${Object.keys(gaps).join(", ")}`);
    return gap;
  };

  // The reported case, and the same with a picture that is a link: words in the picture's own paragraph.
  for (const alt of ["typed-after", "linked"]) {
    const gap = at(alt);
    expect(gap.below, `${surface}: words after "${alt}" are ${px(gap.below)} under the picture, a paragraph break is ${px(space)}`).toBeGreaterThanOrEqual(space - ROUNDING);
    expect(gap.below, `${surface}: words after "${alt}" are ${px(gap.below)} under the picture, a paragraph break is ${px(space)}`).toBeLessThanOrEqual(space + ROUNDING);
  }
  // Not smaller than the space above the picture (a paragraph break here).
  expect(at("typed-after").below! + ROUNDING, `${surface}: below ${px(at("typed-after").below)}, above ${px(at("typed-after").above)}`).toBeGreaterThanOrEqual(at("typed-after").above!);

  // A hard line break after the picture is already a whole empty line: the rule adds nothing to it.
  expect(at("then-line-break").marginBottom, `${surface}: a line break follows "then-line-break"`).toBe(0);
  expect(at("then-line-break").below, `${surface}: words after "then-line-break"`).toBeGreaterThanOrEqual(space - ROUNDING);

  // A picture that ends its paragraph, then a paragraph or a heading: never closer than a paragraph break, and
  // nothing added by the rule (the block gap is still exactly the next block's margin-top).
  for (const alt of ["then-paragraph", "then-heading"]) {
    const gap = at(alt);
    expect(gap.below, `${surface}: the block after "${alt}" is ${px(gap.below)} under the picture`).toBeGreaterThanOrEqual(space - ROUNDING);
    expect(gap.below! + ROUNDING, `${surface}: "${alt}" below ${px(gap.below)}, above ${px(gap.above)}`).toBeGreaterThanOrEqual(gap.above!);
    expect(Math.abs(gap.blockGap! - gap.nextMarginTop!), `${surface}: after "${alt}" the block gap ${px(gap.blockGap)} is the next block's margin-top ${px(gap.nextMarginTop)}`).toBeLessThan(ROUNDING);
    // In the editor ProseMirror's trailing break already leaves a line under such a picture; the margin is off there.
    if (surface === "editor") expect(gap.marginBottom, `${surface}: "${alt}" ends its paragraph`).toBe(0);
  }
  // The same in a list item, a quote and a table cell: the row is not pushed apart.
  for (const alt of ["in-list", "in-quote", "in-table"]) expect(at(alt).marginBottom, `${surface}: "${alt}" keeps no margin of its own`).toBe(0);

  // The end of the document: the picture leaves no band under itself beyond what the surface had (the
  // editor's trailing-break line; nothing in the reader, where the margin collapses through).
  const end = at("at-end");
  if (surface === "editor") expect(end.marginBottom, "editor: the last picture ends its paragraph").toBe(0);
  else expect(Math.abs(end.toEnd), `reader: ${px(end.toEnd)} under the last picture`).toBeLessThan(ROUNDING);

  // The picture itself is untouched.
  for (const gap of Object.values(gaps)) {
    expect(gap.radius).toBe("8px");
    expect(gap.display).toBe("block");
  }
}

test.describe("space below a picture (#2348)", () => {
  test("visual pane: words after a picture sit one paragraph space under it; a picture that ends its paragraph gains nothing", async ({ browser }) => {
    const { page, context } = await signIn(browser, "picture-gap-editor");
    const id = await createDocument(page, PICTURE_DOC, "Picture fixture");
    await openDocument(page, id);
    await expect(page.locator(".md-rich img[alt='at-end']")).toBeVisible();

    assertPictureSpacing(await pictureGaps(page, ".md-rich"), await paragraphSpace(page, ".md-rich"), "editor");
    await context.close();
  });

  test("visual pane: typing right after a picture, the way the report was made", async ({ browser }) => {
    const { page, context } = await signIn(browser, "picture-gap-typing");
    const id = await createDocument(page, `First paragraph.\n\nSecond paragraph.\n\n![typed-after](${PICTURE})\n`, "Picture typing");
    await openDocument(page, id);
    await expect(page.locator(".md-rich img[alt='typed-after']")).toBeVisible();

    // The caret after the picture is in the picture's paragraph: the words land there, on a line of their own.
    await focusRichEnd(page);
    await page.keyboard.type("I asked");
    await page.keyboard.press("Enter");
    await page.keyboard.type("A new paragraph after the words.");
    await expect(page.locator(".md-rich > p", { hasText: "I asked" }).locator("img[alt='typed-after']")).toHaveCount(1);

    const space = await paragraphSpace(page, ".md-rich");
    const gap = (await pictureGaps(page, ".md-rich"))["typed-after"];
    expect(gap.below, `"I asked" is ${gap.below?.toFixed(1)} px under the picture, a paragraph break is ${space.toFixed(1)} px`).toBeGreaterThanOrEqual(space - ROUNDING);
    expect(gap.below).toBeLessThanOrEqual(space + ROUNDING);
    await context.close();
  });

  test("visual pane: another person's caret right after a picture moves nothing", async ({ browser }) => {
    const alice = await signIn(browser, "picture-gap-alice");
    const bob = await signIn(browser, "picture-gap-bob");
    const doc = [
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      `![alone](${PICTURE})`,
      "",
      "After the picture.",
      "",
      `[![linked-alone](${PICTURE})](https://example.com/)`,
      "",
      "After the linked picture.",
      "",
      `![typed-after](${PICTURE})`,
      "I asked",
      "",
      "The end.",
      "",
    ].join("\n");
    const id = await createDocument(alice.page, doc, "Picture and a second caret");
    await shareWith(alice.page, id, "picture-gap-bob", "editor");
    await openDocument(alice.page, id);
    await openDocument(bob.page, id);
    await expect(alice.page.locator(".md-rich img[alt='typed-after']")).toBeVisible();
    const space = await paragraphSpace(alice.page, ".md-rich");

    // What Alice sees: the picture's bottom edge -> the top of the paragraph after the picture's paragraph.
    const underPicture = (alt: string) =>
      alice.page.locator(`.md-rich img[alt='${alt}']`).evaluate((img) => img.closest(".md-rich > p")!.nextElementSibling!.getBoundingClientRect().top - img.getBoundingClientRect().bottom);
    const bobsCaretNextTo = (alt: string) => alice.page.locator(".md-rich > p", { has: alice.page.locator(`img[alt='${alt}']`) }).locator(".md-remote-caret");
    /**
     * Bob's caret to the end of the paragraph that holds picture `alt`: a click at the start of the paragraph
     * `next` after it, then one step left. Bob's pane scrolls to `next` for the click, and a click that
     * arrives while it still moves lands on something else (a picture above, which it then selects). So
     * each step is checked on Bob's own page and the whole move is tried again until it holds.
     */
    const bobsCaretIsIn = (text: string | null, alt: string | null) =>
      bob.page.evaluate(
        ({ text, alt }) => {
          const selection = getSelection();
          const at = selection?.anchorNode;
          const block = (at instanceof Element ? at : at?.parentElement)?.closest(".md-rich > p");
          if (!selection?.isCollapsed || !block) return false;
          return alt === null ? (block.textContent ?? "").includes(text ?? "") : block.querySelector(`img[alt='${alt}']`) !== null;
        },
        { text, alt },
      );
    const bobStepsBackFrom = async (next: string, alt: string) => {
      const start = bob.page.locator(".md-rich > p", { hasText: next });
      await expect(async () => {
        await start.click({ position: { x: 4, y: 8 } });
        expect(await bobsCaretIsIn(next, null), `Bob's click landed in "${next}"`).toBe(true);
        await bob.page.keyboard.press("Home");
        await bob.page.keyboard.press("ArrowLeft");
        expect(await bobsCaretIsIn(null, alt), `Bob's caret is in the paragraph of "${alt}"`).toBe(true);
      }, `Bob's caret goes to the end of the paragraph of "${alt}"`).toPass({ timeout: 45_000 });
    };

    // A picture that ends its paragraph: Bob's caret right after it (between the picture and the trailing
    // break) must not bring the picture's margin back, or everything below jumps for Alice.
    for (const [alt, next] of [
      ["alone", "After the picture."],
      ["linked-alone", "After the linked picture."],
    ] as const) {
      const before = await underPicture(alt);
      await bobStepsBackFrom(next, alt);
      await expect(bobsCaretNextTo(alt), `Bob's caret is right after "${alt}"`).toHaveCount(1);
      const gap = (await pictureGaps(alice.page, ".md-rich"))[alt];
      expect(gap.marginBottom, `"${alt}" ends its paragraph: Bob's caret after it adds no margin`).toBe(0);
      const now = await underPicture(alt);
      expect(Math.abs(now - before), `under "${alt}": ${before.toFixed(1)} px without Bob's caret, ${now.toFixed(1)} px with it`).toBeLessThan(ROUNDING);
    }

    // Words after the picture, and Bob's caret at the end of those words: the words keep their space.
    await bobStepsBackFrom("The end.", "typed-after");
    await expect(bobsCaretNextTo("typed-after"), "Bob's caret is at the end of the words after the picture").toHaveCount(1);
    const typed = (await pictureGaps(alice.page, ".md-rich"))["typed-after"];
    expect(typed.below, `"I asked" is ${typed.below?.toFixed(1)} px under the picture with Bob's caret after it, a paragraph break is ${space.toFixed(1)} px`).toBeGreaterThanOrEqual(space - ROUNDING);
    expect(typed.below).toBeLessThanOrEqual(space + ROUNDING);

    // The same with Bob's caret between the picture and the words (" I asked": the line break and 7 letters).
    for (let i = 0; i < 8; i++) await bob.page.keyboard.press("ArrowLeft");
    await expect
      .poll(() => alice.page.locator(".md-rich img[alt='typed-after']").evaluate((img) => (img.nextSibling instanceof HTMLElement ? img.nextSibling.className : "words")), { message: "Bob's caret is the node right after the picture" })
      .toContain("md-remote-caret");
    const between = (await pictureGaps(alice.page, ".md-rich"))["typed-after"];
    expect(Math.abs(between.marginBottom - space), `words follow the picture and Bob's caret: the picture keeps ${between.marginBottom.toFixed(1)} px, a paragraph break is ${space.toFixed(1)} px`).toBeLessThan(ROUNDING);

    await alice.context.close();
    await bob.context.close();
  });

  test("published page /p/<id>: the same space under a picture", async ({ browser }) => {
    const owner = await signIn(browser, "picture-gap-reader");
    const id = await createDocument(owner.page, PICTURE_DOC, "Picture fixture");
    expect((await owner.page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "view" } })).ok()).toBeTruthy();

    const anon = await browser.newContext();
    const page = await anon.newPage();
    await page.goto(`/p/${id}`);
    await expect(page.getByTestId("reader-body").locator("img[alt='at-end']")).toBeVisible();

    const root = '[data-testid="reader-body"]';
    assertPictureSpacing(await pictureGaps(page, root), await paragraphSpace(page, root), "reader");
    await anon.close();
    await owner.context.close();
  });
});
