import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, ensureCommentsOpen, budgetMs, type User } from "./helpers";

/**
 * Clicking a comment card scrolls the document so the commented text sits in the middle of the
 * visible pane(s) (task #992). Measured, not assumed: every step reads the scroller's scrollTop and
 * the highlighted mark's position relative to the scroller box and prints them.
 */

// Chromium turns programmatic smooth scrolling off when the OS has animations disabled (remote desktop,
// "Show animations in Windows" off), and always in the headless shell: `behavior: "smooth"` then jumps
// instantly and a smooth scroll can never be interrupted. Burke's browser animates, so this suite forces
// the animator on; the flag is a no-op where it is already on.
test.use({ launchOptions: { args: ["--enable-smooth-scrolling"] } });

// 150 paragraphs of ~150 characters: 2–3 lines in either pane, well over 3 000 px in every layout.
const FILLER = "the quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly and the sphinx of black quartz judges my vow";
const PARAGRAPHS = Array.from({ length: 150 }, (_, i) => `Paragraph ${i + 1} ${FILLER}.`);
const DOCUMENT = "# Comment reveal fixture\n\n" + PARAGRAPHS.join("\n\n") + "\n";

const RICH_SCROLLER = '[data-testid="rich-column"] .overflow-y-auto';
const CODE_SCROLLER = ".cm-scroller";

type Pane = "rich" | "code";

interface Reading {
  scrollTop: number;
  scrollHeight: number;
  height: number;
  /** Centre of the highlighted mark relative to the scroller's top edge, or null when not rendered. */
  centre: number | null;
  withinMiddle: boolean;
}

/** scrollTop of a pane and where the thread's highlight mark sits inside the pane's box. */
async function read(page: Page, pane: Pane, threadId: string): Promise<Reading> {
  return page.evaluate(
    ([pane, id, richSel, codeSel]) => {
      const scroller = document.querySelector<HTMLElement>(pane === "rich" ? richSel : codeSel);
      if (!scroller) throw new Error(`${pane} scroller not found`);
      const root = pane === "rich" ? ".md-rich" : ".cm-content";
      const marks = Array.from(document.querySelectorAll<HTMLElement>(`${root} [data-highlight-id="${id}"]`));
      const box = scroller.getBoundingClientRect();
      let centre: number | null = null;
      if (marks.length) {
        const rects = marks.map((m) => m.getBoundingClientRect()).filter((r) => r.height > 0);
        if (rects.length) {
          const top = Math.min(...rects.map((r) => r.top));
          const bottom = Math.max(...rects.map((r) => r.bottom));
          centre = (top + bottom) / 2 - box.top;
        }
      }
      const withinMiddle = centre !== null && centre >= box.height * 0.2 && centre <= box.height * 0.8;
      return { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, height: box.height, centre, withinMiddle };
    },
    [pane, threadId, RICH_SCROLLER, CODE_SCROLLER] as const,
  );
}

const fmt = (r: Reading) => `scrollTop=${r.scrollTop.toFixed(0)} (of ${r.scrollHeight}) centre=${r.centre === null ? "n/a" : r.centre.toFixed(0)}/${r.height.toFixed(0)} middle60=${r.withinMiddle}`;

async function scrollPaneTo(page: Page, pane: Pane, top: number) {
  await page.evaluate(
    ([pane, top, richSel, codeSel]) => {
      const el = document.querySelector<HTMLElement>(pane === "rich" ? richSel : codeSel);
      if (!el) throw new Error(`${pane} scroller not found`);
      el.scrollTo({ top, behavior: "auto" });
    },
    [pane, top, RICH_SCROLLER, CODE_SCROLLER] as const,
  );
  await expect.poll(() => read(page, pane, "none").then((r) => Math.abs(r.scrollTop - top) < 2)).toBe(true);
}

async function setLayout(page: Page, layout: "split" | "rich" | "code") {
  const labels = { split: /Code and preview/, rich: /Preview only/, code: /Code only/ };
  await page.getByTestId("layout-menu").click();
  await page.getByRole("menuitemradio", { name: labels[layout] }).click();
  await expect(page.getByTestId("rich-column")).toBeVisible({ visible: layout !== "code" });
  await expect(page.getByTestId("code-column")).toBeVisible({ visible: layout !== "rich" });
  await expect(page.getByRole("menu")).toHaveCount(0);
}

async function expectSyncScroll(page: Page, on: boolean) {
  await page.getByTestId("layout-menu").click();
  const toggle = page.getByTestId("sync-scroll-toggle");
  await expect(toggle).toBeVisible();
  const checked = (await toggle.getAttribute("aria-checked")) === "true";
  if (checked !== on) await toggle.click();
  else await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByTestId("layout-menu").click();
  await expect(page.getByTestId("sync-scroll-toggle")).toHaveAttribute("aria-checked", on ? "true" : "false");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
}

const card = (page: Page, threadId: string) => page.locator(`[data-testid="comment-thread"][data-thread-id="${threadId}"]`);

/** Start sampling a pane's scrollTop every frame (for ~2 s); `stopTrace` returns the samples as "t:scrollTop" pairs. */
async function startTrace(page: Page, pane: Pane) {
  await page.evaluate(
    ([pane, richSel, codeSel]) => {
      const el = document.querySelector<HTMLElement>(pane === "rich" ? richSel : codeSel);
      if (!el) throw new Error(`${pane} scroller not found`);
      const w = window as unknown as { __revealTrace?: Record<string, [number, number][]> };
      w.__revealTrace ??= {};
      const samples: [number, number][] = [];
      w.__revealTrace[pane] = samples;
      const t0 = performance.now();
      const tick = () => {
        samples.push([Math.round(performance.now() - t0), Math.round(el.scrollTop)]);
        if (performance.now() - t0 < 2_000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    [pane, RICH_SCROLLER, CODE_SCROLLER] as const,
  );
}

async function stopTrace(page: Page, pane: Pane): Promise<string> {
  const samples = await page.evaluate((pane) => (window as unknown as { __revealTrace?: Record<string, [number, number][]> }).__revealTrace?.[pane] ?? [], pane);
  // One sample per ~100 ms plus the last one is enough to see a jump, a glide or an interrupted glide.
  const kept = samples.filter(([t], i) => i === 0 || i === samples.length - 1 || t - samples[i - 1][0] >= 100 || Math.floor(t / 100) !== Math.floor(samples[i - 1][0] / 100));
  return kept.map(([t, y]) => `${t}ms:${y}`).join(" ");
}

/**
 * Click (or key-activate) a card and wait until the given panes have the thread's mark inside the
 * middle 60 % of their box, within the budget; returns the readings and the time it took.
 */
async function revealAndMeasure(page: Page, threadId: string, panes: Pane[], activate: (c: ReturnType<typeof card>) => Promise<void>, label: string) {
  const before = await Promise.all(panes.map((p) => read(page, p, threadId)));
  for (const p of panes) await startTrace(page, p);
  const started = Date.now();
  await activate(card(page, threadId));
  let last: Reading[] = before;
  const centred = await expect
    .poll(
      async () => {
        last = await Promise.all(panes.map((p) => read(page, p, threadId)));
        return last.every((r) => r.withinMiddle);
      },
      { timeout: budgetMs(1_500), message: `${label}: mark should be centred in ${panes.join("+")} (last: ${last.map(fmt).join(" | ")})` },
    )
    .toBe(true)
    .then(
      () => true,
      (e: unknown) => e,
    );
  const elapsed = Date.now() - started;
  // Two more frames: nothing (sync step, re-render) may move it away afterwards.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));
  const settled = await Promise.all(panes.map((p) => read(page, p, threadId)));
  for (let i = 0; i < panes.length; i++) {
    console.log(`[comment-reveal] ${label} ${panes[i]}: before ${fmt(before[i])} → after ${fmt(settled[i])} (${elapsed} ms)`);
    console.log(`[comment-reveal] ${label} ${panes[i]} trace: ${await stopTrace(page, panes[i])}`);
  }
  if (centred !== true) throw centred;
  for (let i = 0; i < panes.length; i++) expect(settled[i].withinMiddle, `${label} ${panes[i]} settled: ${fmt(settled[i])}`).toBe(true);
  await expect(card(page, threadId)).toHaveClass(/border-accent/);
  return { before, settled, elapsed };
}

async function addComment(page: Page, docId: string, quote: string, body: string): Promise<string> {
  const res = await page.request.post(`/api/documents/${docId}/comments`, { data: { action: "add", quote, body } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

test.describe("comment card click reveals the commented text", () => {
  let user: User;
  let page: Page;
  let docId: string;
  let far: string;
  let near: string;
  let gone: string;

  test.beforeAll(async ({ browser }) => {
    user = await signIn(browser, `reveal-${Date.now().toString(36)}`);
    page = user.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    docId = await createDocument(page, DOCUMENT, "Comment reveal fixture");
    far = await addComment(page, docId, "Paragraph 140 the quick", "Far down the document.");
    near = await addComment(page, docId, "Paragraph 5 the quick", "Near the top.");
    gone = await addComment(page, docId, "Paragraph 75 the quick", "The text of this one is gone.");
    await openDocument(page, docId);
    await ensureCommentsOpen(page);
    await expect(page.getByTestId("comment-thread")).toHaveCount(3);
    await expect(page.locator(`.md-rich [data-highlight-id="${near}"]`)).toBeAttached();
    // A thread whose anchor no longer resolves: the panel shows "(original text removed)" for it.
    await page.evaluate((id) => {
      const s = (window as unknown as { __markdocSession: { comments: { ymap: { get(id: string): { delete(key: string): void } | undefined } } } }).__markdocSession;
      s.comments.ymap.get(id)?.delete("anchor");
    }, gone);
    await expect(card(page, gone)).toContainText("(original text removed)");
  });

  test.afterAll(async () => {
    await user?.context.close();
  });

  test("text layout: far card centres paragraph 140, near card comes back to paragraph 5", async () => {
    await setLayout(page, "rich");
    await scrollPaneTo(page, "rich", 0);
    const tall = await read(page, "rich", far);
    expect(tall.scrollHeight, `rich pane is tall enough (${tall.scrollHeight} px)`).toBeGreaterThan(3_000);

    const down = await revealAndMeasure(page, far, ["rich"], (c) => c.click(), "text/far");
    expect(down.settled[0].scrollTop, fmt(down.settled[0])).toBeGreaterThan(2_000);

    const up = await revealAndMeasure(page, near, ["rich"], (c) => c.click(), "text/near");
    expect(up.settled[0].scrollTop, fmt(up.settled[0])).toBeLessThan(400);
  });

  test("clicking the quote line of a card reveals too", async () => {
    await setLayout(page, "rich");
    await scrollPaneTo(page, "rich", 0);
    const down = await revealAndMeasure(page, far, ["rich"], (c) => c.locator('[title^="Paragraph 140"]').click(), "text/quote-line");
    expect(down.settled[0].scrollTop).toBeGreaterThan(2_000);
  });

  test("split layout with scroll sync on: both panes end with the text in the middle", async () => {
    await setLayout(page, "split");
    await expectSyncScroll(page, true);
    await scrollPaneTo(page, "rich", 0);
    await scrollPaneTo(page, "code", 0);
    await expect.poll(() => read(page, "rich", far).then((r) => r.scrollTop)).toBeLessThan(2);

    const down = await revealAndMeasure(page, far, ["rich", "code"], (c) => c.click(), "split/far");
    expect(down.settled[0].scrollTop, fmt(down.settled[0])).toBeGreaterThan(2_000);
    expect(down.settled[1].scrollTop, fmt(down.settled[1])).toBeGreaterThan(2_000);

    const up = await revealAndMeasure(page, near, ["rich", "code"], (c) => c.click(), "split/near");
    expect(up.settled[0].scrollTop, fmt(up.settled[0])).toBeLessThan(400);
    // The code pane is mirrored by the sync (top block aligned), so it only needs to be near the top too.
    expect(up.settled[1].scrollTop, fmt(up.settled[1])).toBeLessThan(1_000);
  });

  test("source layout: CodeMirror scrolls the line to the middle", async () => {
    await setLayout(page, "code");
    await scrollPaneTo(page, "code", 0);

    const down = await revealAndMeasure(page, far, ["code"], (c) => c.click(), "source/far");
    expect(down.settled[0].scrollTop, fmt(down.settled[0])).toBeGreaterThan(2_000);

    const up = await revealAndMeasure(page, near, ["code"], (c) => c.click(), "source/near");
    expect(up.settled[0].scrollTop, fmt(up.settled[0])).toBeLessThan(400);
  });

  test("a comment whose text was removed: toast, active style, no scroll", async () => {
    await setLayout(page, "rich");
    await scrollPaneTo(page, "rich", 600);
    const before = await read(page, "rich", far);
    const started = Date.now();
    await card(page, gone).click();
    const toast = page.getByTestId("toast").filter({ hasText: /removed|deleted|gone/i });
    await expect(toast).toBeVisible({ timeout: budgetMs(500) });
    console.log(`[comment-reveal] removed-text: toast "${(await toast.innerText()).trim()}" after ${Date.now() - started} ms`);
    await expect(card(page, gone)).toHaveClass(/border-accent/);
    await page.waitForTimeout(300);
    const after = await read(page, "rich", far);
    console.log(`[comment-reveal] removed-text: scrollTop ${before.scrollTop} → ${after.scrollTop}`);
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThan(2);
  });

  test("Enter on a focused card reveals like a click", async () => {
    await setLayout(page, "rich");
    await scrollPaneTo(page, "rich", 0);
    const down = await revealAndMeasure(
      page,
      far,
      ["rich"],
      async (c) => {
        await c.focus();
        await expect(c).toBeFocused();
        await page.keyboard.press("Enter");
      },
      "text/keyboard-enter",
    );
    expect(down.settled[0].scrollTop).toBeGreaterThan(2_000);

    // Space does the same and does not scroll the panel (the default page-down of Space is suppressed).
    const up = await revealAndMeasure(
      page,
      near,
      ["rich"],
      async (c) => {
        await c.focus();
        await expect(c).toBeFocused();
        await page.keyboard.press("Space");
      },
      "text/keyboard-space",
    );
    expect(up.settled[0].scrollTop).toBeLessThan(400);
  });
});
