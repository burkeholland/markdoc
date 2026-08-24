import { test, expect, devices, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn, createDocument, openDocument } from "./helpers";

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

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => localStorage.setItem("markdoc:theme", t), theme);
  // A full navigation rather than reload(): on a loaded box the reload raced the editor's own
  // navigation and aborted (ERR_ABORTED) — see the first run of this spec.
  await page.goto(page.url());
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
}

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
    await page.goto("/login");
    await page.getByTestId("dev-login").fill("rhythm-phone");
    await page.getByTestId("dev-login-submit").click();
    await page.waitForURL((url) => url.pathname === "/");
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
