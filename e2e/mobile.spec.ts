import { test, expect } from "./fixtures";
import { devices, type Browser, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createDocument, cssPx, devLogin, selectTextInRich, uniqueLogin, waitForHydration } from "./helpers";

const DOC = "# Mobile doc\n\nSome **bold** text here to select.\n\n## Second\n\nMore words.\n\n## Third\n\nEnd.\n";

/** Enough content to fill a phone screen on first paint: a heading, a list, a table and a code block (the CLS tests). */
const CLS_DOC = [
  "# Layout shift fixture",
  "",
  "The preview of this document is server-rendered, so the first paint already shows all of it.",
  "",
  "## Checklist",
  "",
  "- Outline rail hidden below `md` before hydration",
  "- Code column hidden while the layout is still `split`",
  "- Header controls sized for the phone from the server",
  "- Reader aside precedes the article in the DOM",
  "",
  "## Numbers",
  "",
  "| Page | Before | After |",
  "| --- | --- | --- |",
  "| Editor | 0.891 | 0.016 |",
  "| Reader | 0.070 | 0.000 |",
  "| Desktop | 0.000 | 0.000 |",
  "",
  "## Code",
  "",
  "```ts",
  "const observer = new PerformanceObserver((list) => {",
  "  for (const entry of list.getEntries()) sum += entry.value;",
  "});",
  "observer.observe({ type: 'layout-shift', buffered: true });",
  "```",
  "",
  "## Closing",
  "",
  "A last paragraph so the page is taller than an iPhone 13 viewport and the pane container has",
  "something to move if the rail or the code column were to appear late.",
  "",
  "1. First step",
  "2. Second step",
  "3. Third step",
  "",
  "> A quote to round the fixture off.",
  "",
].join("\n");

/**
 * Runs before any script of every document in the context: collects every `layout-shift` entry's
 * score into `window.__cls`. Nothing is filtered on `hadRecentInput` on purpose — at 1× the
 * emulator's resize flags the hydration flip as input for 500 ms, so a filtered sum reads 0.000 on
 * a page that visibly jumps (#1470). The unfiltered sum read 0.852 here (0.891 in #1470) before the SSR phone layout.
 */
function observeLayoutShifts() {
  const w = window as Window & { __cls?: number[] };
  w.__cls = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) w.__cls!.push((entry as PerformanceEntry & { value: number }).value);
  }).observe({ type: "layout-shift", buffered: true });
}

const layoutShiftSum = (page: Page) => page.evaluate(() => ((window as Window & { __cls?: number[] }).__cls ?? []).reduce((a, b) => a + b, 0));

/**
 * Runs before any script of every document in the context: records the status bar's layout-menu
 * trigger's box in the first frame it exists (`window.__firstMenuRect`) — the server markup as first
 * painted, before React hydrates and `compact` flips (#1531). rAF rather than a MutationObserver so the
 * measurement waits for the stylesheet: rendering (and rAF) is blocked until it has loaded.
 */
function observeFirstMenuRect() {
  const w = window as Window & { __firstMenuRect?: { x: number; width: number } };
  const tick = () => {
    const el = document.querySelector('[data-testid="layout-menu"]');
    if (!el) {
      requestAnimationFrame(tick);
      return;
    }
    const r = el.getBoundingClientRect();
    w.__firstMenuRect = { x: r.x, width: r.width };
  };
  requestAnimationFrame(tick);
}

/**
 * ~145 kB of HTML: on a 4× slower CPU (a phone) the parser paints the article before the end of the
 * document arrives, which is when a table of contents that follows the article in the DOM would push it down.
 * At 1× on localhost the whole page paints at once and no order bug is visible (measured 0.000 either way).
 */
const LONG_READER_DOC =
  "# Long reader fixture\n\n" +
  Array.from(
    { length: 60 },
    (_, i) =>
      `## Section ${i + 1}\n\nA paragraph of ordinary prose that runs long enough to wrap on a phone several times over, so the article has real height and the parser has real work to do before it reaches the end of the document.\n\n- first point\n- second point\n- third point\n\n| Col A | Col B |\n| --- | --- |\n| ${i} | ${i * 2} |\n\n\`\`\`ts\nconst value${i} = ${i};\n\`\`\`\n`,
  ).join("\n");

/** ≈ 300 lines for the deferred-editor CLS row: headings, prose, lists and code (no tables, see the row). */
const DEFER_DOC =
  "# Deferred editor fixture\n\n" +
  Array.from(
    { length: 27 },
    (_, i) =>
      `## Section ${i + 1}\n\nA paragraph of ordinary prose that runs long enough to wrap on a phone several times over, so the preview has real height from the first paint and the parser has real work to do before it reaches the end of the document.\n\n- first point\n- second point\n\n\`\`\`ts\nconst value${i} = ${i};\n\`\`\`\n`,
  ).join("\n");

/** Sign in on a context that emulates a phone (or the given viewport). */
async function signInOn(browser: Browser, login: string, options: Parameters<Browser["newContext"]>[0]) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await devLogin(page, login);
  await page.waitForLoadState("networkidle");
  return { context, page };
}

async function openDoc(page: Page, id: string) {
  await page.goto(`/d/${id}`);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
}

/** Wait for the drawer/sheet slide-in to finish before measuring. */
const settled = (locator: Locator) => locator.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)).then(() => undefined));

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => {
    const el = document.scrollingElement!;
    return el.scrollWidth <= window.innerWidth;
  });

const settingsViewports = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
] as const;

test.describe("phone", () => {
  const phone = devices["iPhone 13"];

  test("editor opens in Preview only and the segmented control switches panes", async ({ browser }) => {
    const { context, page } = await signInOn(browser, "phone-user", { ...phone });
    const id = await createDocument(page, DOC, "Mobile");
    await openDoc(page, id);
    await expect(page.getByTestId("editor-shell")).toHaveAttribute("data-breakpoint", "phone");
    await expect(page.locator(".md-rich")).toBeVisible();
    await expect(page.locator(".cm-content")).toBeHidden();
    await expect(page.getByTestId("layout-segment-rich")).toHaveAttribute("aria-checked", "true");
    // No inline outline rail, no desktop-only chrome.
    await expect(page.getByTestId("outline")).toHaveCount(0);
    await expect(page.getByTestId("outline-collapsed")).toHaveCount(0);
    await expect(page.getByTestId("share-button")).toBeHidden();
    await expect(page.getByTestId("publish-button")).toBeHidden();
    expect(await noHorizontalScroll(page)).toBe(true);

    await page.getByTestId("layout-segment-code").click();
    await expect(page.locator(".cm-content")).toBeVisible();
    await expect(page.locator(".md-rich")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("markdoc:layout"))).toBe("code");
    // The choice survives a reload.
    await openDoc(page, id);
    await expect(page.locator(".cm-content")).toBeVisible();
    await expect(page.locator(".md-rich")).toBeHidden();
    await page.getByTestId("layout-segment-rich").click();
    await expect(page.locator(".md-rich")).toBeVisible();
    await expect(page.locator(".cm-content")).toBeHidden();
    await context.close();
  });

  test("outline opens as a drawer and jumps to a heading", async ({ browser }) => {
    const { context, page } = await signInOn(browser, "phone-user", { ...phone });
    const id = await createDocument(page, DOC, "Mobile outline");
    await openDoc(page, id);
    await page.getByTestId("outline-button").click();
    const drawer = page.getByTestId("outline-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Third" })).toBeVisible();
    await settled(drawer);
    await expect.poll(async () => (await drawer.boundingBox())!.x).toBe(0);
    const box = (await drawer.boundingBox())!;
    expect(box.width).toBeLessThan(phone.viewport.width);
    await drawer.getByRole("button", { name: "Hide outline" }).click();
    await expect(drawer).toHaveCount(0);
    await page.getByTestId("outline-button").click();
    await expect(page.getByTestId("outline-drawer")).toBeVisible();
    await page.getByTestId("outline-drawer").getByRole("button", { name: "Third" }).click();
    await expect(page.getByTestId("outline-drawer")).toHaveCount(0);
    await context.close();
  });

  test("comments open as a bottom sheet and close from the backdrop", async ({ browser }) => {
    const { context, page } = await signInOn(browser, "phone-user", { ...phone });
    const id = await createDocument(page, DOC, "Mobile comments");
    await openDoc(page, id);
    await page.getByTestId("comments-toggle").click();
    const sheet = page.getByTestId("sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-panel", "comments");
    await expect(sheet.getByTestId("comments-panel")).toBeVisible();
    await settled(sheet);
    await expect.poll(async () => {
      const b = (await sheet.boundingBox())!;
      return Math.round(b.y + b.height);
    }).toBe(phone.viewport.height);
    const box = (await sheet.boundingBox())!;
    expect(box.x).toBe(0);
    expect(Math.round(box.width)).toBe(phone.viewport.width);
    // Tap the backdrop above the sheet.
    await page.mouse.click(phone.viewport.width / 2, 10);
    await expect(sheet).toHaveCount(0);
    // History and activity use the same sheet.
    await page.getByTestId("more-menu").click();
    await page.getByRole("menuitem", { name: "Version history" }).click();
    await expect(page.getByTestId("sheet")).toHaveAttribute("data-panel", "versions");
    await expect(page.getByTestId("versions-panel")).toBeVisible();
    await context.close();
  });

  test("toolbar scrolls horizontally and Bold still works", async ({ browser }) => {
    const { context, page } = await signInOn(browser, "phone-user", { ...phone });
    const id = await createDocument(page, DOC, "Mobile toolbar");
    await openDoc(page, id);
    const toolbar = page.getByTestId("toolbar");
    const scrollable = await toolbar.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrollable).toBe(true);
    await selectTextInRich(page, "here");
    await page.getByTestId("tb-bold").click();
    await expect(page.locator(".md-rich strong", { hasText: "here" })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await context.close();
  });

  test("selection bubble stays inside the viewport and sits below the selection", async ({ browser }) => {
    const { context, page } = await signInOn(browser, "phone-user", { ...phone });
    const id = await createDocument(page, DOC, "Mobile bubble");
    await openDoc(page, id);
    await selectTextInRich(page, "select");
    const bubble = page.getByTestId("selection-bubble");
    await expect(bubble).toBeVisible();
    await expect(bubble).toHaveAttribute("data-below", "true");
    const box = (await bubble.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(phone.viewport.width);
    expect(cssPx(box.height)).toBeGreaterThanOrEqual(40);
    const selectionBottom = await page.evaluate(() => {
      const range = window.getSelection()!.getRangeAt(0);
      return range.getBoundingClientRect().bottom;
    });
    expect(box.y).toBeGreaterThan(selectionBottom);
    await context.close();
  });

  test("status bar collapses to word count, storage and a menu with view options", async ({ browser }) => {
    const { context, page } = await signInOn(browser, "phone-user", { ...phone });
    const id = await createDocument(page, DOC, "Mobile status");
    await openDoc(page, id);
    const bar = page.getByTestId("status-bar");
    await expect(bar).toHaveAttribute("data-compact", "true");
    await expect(bar.getByTestId("issues-button")).toHaveCount(0);
    await expect(bar.getByTestId("theme-toggle")).toHaveCount(0);
    await bar.getByTestId("layout-menu").click();
    await expect(page.getByTestId("sync-scroll-toggle")).toBeVisible();
    await expect(page.getByTestId("menu-theme-dark")).toBeVisible();
    await page.getByTestId("menu-theme-dark").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await context.close();
  });

  test("header ⋮ menu fits the 844 px screen and scrolls so Move to trash is reachable", async ({ browser }) => {
    const { context, page } = await signInOn(browser, "phone-menu", { ...phone });
    const id = await createDocument(page, DOC, "Mobile menu");
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("markdoc:theme", t), theme);
      await openDoc(page, id);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.getByTestId("more-menu").click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await settled(menu);
      // The phone menu folds Share / Publish / Mode in, so it is taller than the screen without a cap.
      const rows = (await menu.getByRole("menuitem").count()) + (await menu.getByRole("menuitemradio").count());
      expect(rows).toBeGreaterThanOrEqual(20);
      const box = (await menu.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(phone.viewport.height);
      expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      const trash = menu.getByRole("menuitem", { name: "Move to trash" });
      await trash.scrollIntoViewIfNeeded();
      await expect(trash).toBeInViewport();
      // Scoped to the menu: the rest of the page is aria-hidden by Radix while a menu is open (the skip link
      // there is a page-level finding, not this menu's).
      const results = await new AxeBuilder({ page })
        .include('[role="menu"]')
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .disableRules(["color-contrast"])
        .analyze();
      expect(results.violations, `${theme} menu: ${JSON.stringify(results.violations.map((v) => v.id))}`).toHaveLength(0);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
    // Tapping the last row actually works: the document lands in the trash.
    page.on("dialog", (dialog) => void dialog.accept());
    await page.getByTestId("more-menu").click();
    const trash = page.getByRole("menuitem", { name: "Move to trash" });
    await trash.scrollIntoViewIfNeeded();
    await trash.click();
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.getByTestId("toast")).toContainText("moved to the trash");
    await context.close();
  });

  test("dashboard at 390 px has no horizontal scroll and the template dialog fits", async ({ browser }) => {
    const { context, page } = await signInOn(browser, "phone-dash", { ...phone });
    await createDocument(page, DOC, "A document with a fairly long title that needs to wrap nicely");
    await page.request.post("/api/documents", { data: { content: "# Two\n", title: "Two" } });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("document-list")).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await expect(page.getByTestId("search")).toBeVisible();
    await expect(page.getByTestId("filter-starred")).toBeVisible();
    // The search ✕ is a finger-sized target on phone, and clears the query.
    await page.getByTestId("search").fill("zzzzqqq");
    const clear = page.getByTestId("search-clear");
    await expect(clear).toBeVisible();
    const clearBox = (await clear.boundingBox())!;
    expect(cssPx(clearBox.width)).toBeGreaterThanOrEqual(44);
    expect(cssPx(clearBox.height)).toBeGreaterThanOrEqual(44);
    expect(await noHorizontalScroll(page)).toBe(true);
    await clear.click();
    await expect(page.getByTestId("search")).toHaveValue("");
    await expect(page.getByTestId("document-list")).toBeVisible();
    await page.getByTestId("new-from-template").click();
    const dialog = page.getByTestId("template-dialog");
    await expect(dialog).toBeVisible();
    const box = (await page.getByRole("dialog").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(phone.viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(phone.viewport.height);
    await context.close();
  });

  test("reader page at 390 px has no horizontal scroll", async ({ browser }) => {
    const { context, page } = await signInOn(browser, "phone-reader", { ...phone });
    const id = await createDocument(page, DOC, "Mobile reader");
    await page.goto(`/p/${id}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("reader-aside")).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await context.close();
  });

  // Cumulative layout shift from first paint to one second after the editor is interactive. The server
  // and the hydration render assume a desktop viewport (useBreakpoint), so the phone layout must come
  // from CSS (`max-md:hidden` rail and code column, header residual) or the whole pane jumps at
  // hydration: 0.852 before that CSS (#1470 measured 0.891), 0.009 with it (the status bar's compact
  // swap), 0.000 once the status bar's phone form came from CSS too (#1531). 0.1 is Lighthouse's "good" threshold.
  test("editor first paint is already the phone layout: no layout shift while it hydrates", async ({ browser }) => {
    const context = await browser.newContext({ ...phone });
    await context.addInitScript(observeLayoutShifts);
    const page = await context.newPage();
    await devLogin(page, "phone-cls-editor");
    const id = await createDocument(page, CLS_DOC, "Mobile CLS editor");
    await openDoc(page, id);
    await expect(page.getByTestId("editor-shell")).toHaveAttribute("data-breakpoint", "phone");
    await page.waitForTimeout(1000);
    const cls = await layoutShiftSum(page);
    console.log(`[1495] /d/<id> phone CLS: ${cls.toFixed(3)}`);
    expect(cls).toBeLessThanOrEqual(0.1);
    await context.close();
  });

  // #1545: the editor stack (8 chunks, ≈ 924 kB) loads behind a server-rendered placeholder of the shell's
  // chrome, and the swap must not move a pixel. 4× CPU keeps the placeholder on screen for seconds (≈ 2–3 s
  // to hydrate, ≈ 6–9 s to the shell on a production build); the observer runs from the first byte to 1 s after
  // the shell has saved. Measured 0.000 in 5/5 runs (short and 300-line fixtures) after the change, 0.011–0.020
  // before it (status-bar compact swap, header controls re-laid out at hydration) and 0.129 at 820 px (the rail
  // collapsing at hydration). No table in the fixture: the TableMenu's touch strip resizes once the rich pane
  // mounts (0.008 on a phone, in the previous build too), which is outside what this row guards.
  test("editor stack loads behind the placeholder without a layout shift (300 lines, 4× CPU, CLS ≤ 0.01)", async ({ browser }) => {
    const context = await browser.newContext({ ...phone });
    await context.addInitScript(observeLayoutShifts);
    const page = await context.newPage();
    await devLogin(page, "phone-cls-defer");
    const id = await createDocument(page, DEFER_DOC, "Mobile CLS deferred editor");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.goto(`/d/${id}`, { waitUntil: "commit" });
    // The placeholder is the server HTML: on screen before any script, gone once the shell has mounted.
    await expect(page.getByTestId("editor-loading")).toBeVisible();
    await expect(page.getByTestId("rich-placeholder").locator("h1")).toHaveText("Deferred editor fixture");
    await expect(page.getByTestId("editor-shell")).toHaveAttribute("data-breakpoint", "phone", { timeout: 60_000 });
    await expect(page.getByTestId("editor-loading")).toHaveCount(0);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 60_000 });
    await page.waitForTimeout(1000);
    const cls = await layoutShiftSum(page);
    console.log(`[defer] /d/<id> phone CLS (4× CPU, 300 lines): ${cls.toFixed(3)}`);
    expect(cls).toBeLessThanOrEqual(0.01);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await context.close();
  });

  // The reader's "Contents" button sits above the article on phones; it must precede the article in
  // the DOM too, or the streamed article paints first and drops 62 px when the aside arrives. Visible
  // only when the parser paints mid-document: a long document on a 4× throttled CPU (a mid-range phone)
  // read 0.073 with the aside last in the DOM and 0.000 with it first, so the bar is 0.02, not 0.1.
  test("reader first paint keeps the Contents button above the article: no layout shift", async ({ browser }) => {
    const context = await browser.newContext({ ...phone });
    await context.addInitScript(observeLayoutShifts);
    const page = await context.newPage();
    await devLogin(page, "phone-cls-reader");
    const id = await createDocument(page, LONG_READER_DOC, "Mobile CLS reader");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.goto(`/p/${id}`);
    await waitForHydration(page);
    await expect(page.getByTestId("reader-toc-toggle")).toBeVisible();
    await page.waitForTimeout(1000);
    const cls = await layoutShiftSum(page);
    console.log(`[1495] /p/<id> phone CLS (4× CPU): ${cls.toFixed(3)}`);
    expect(cls).toBeLessThanOrEqual(0.02);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await context.close();
  });

  // The status bar's phone form is CSS from the server too (#1531): `compact` is false until hydration,
  // and the desktop bar painted first — the layout-menu trigger then moved 268 px and the word counter
  // wrapped, 0.0087 of the editor's 0.009 above. Two checks: the page total, and the trigger's first
  // rendered box against its settled one (the sum alone cannot tell a 0.009 status-bar swap from noise).
  // Since #1545 the bar's controls arrive with the shell (the server sends an empty footer of the same box),
  // so "first" is the shell's first client frame; the row still catches a bar that re-lays itself out after it.
  test("status bar first paint is already the phone bar: the layout-menu trigger does not move at hydration", async ({ browser }) => {
    const context = await browser.newContext({ ...phone });
    await context.addInitScript(observeLayoutShifts);
    await context.addInitScript(observeFirstMenuRect);
    const page = await context.newPage();
    await devLogin(page, "phone-cls-status-bar");
    const id = await createDocument(page, CLS_DOC, "Mobile CLS status bar");
    await openDoc(page, id);
    await expect(page.getByTestId("status-bar")).toHaveAttribute("data-compact", "true");
    await page.waitForTimeout(1000);
    const cls = await layoutShiftSum(page);
    const { first, settled } = await page.evaluate(() => {
      const w = window as Window & { __firstMenuRect?: { x: number; width: number } };
      const r = document.querySelector('[data-testid="layout-menu"]')!.getBoundingClientRect();
      return { first: w.__firstMenuRect ?? null, settled: { x: r.x, width: r.width } };
    });
    expect(first, "layout-menu rendered (with the shell since #1545)").not.toBeNull();
    const dx = Math.abs(settled.x - first!.x);
    const dw = Math.abs(settled.width - first!.width);
    console.log(`[1531] /d/<id> phone CLS: ${cls.toFixed(3)}; status-bar layout-menu Δx=${dx.toFixed(1)} Δwidth=${dw.toFixed(1)}`);
    expect(cls).toBeLessThanOrEqual(0.1);
    expect(dx).toBeLessThanOrEqual(2);
    expect(dw).toBeLessThanOrEqual(2);
    await context.close();
  });

  // The dashboard's chips row (sort select + five filters, 534 px) never fits beside the "Documents"
  // heading on a phone, so its final place is a full-width second line. Painted beside the heading while
  // only the select had parsed and dropped when the rest arrived, it pushed the cards ≈ 30 px down:
  // 0.017 median / 0.022 max at 4× CPU (#1503). `max-sm:basis-full min-h-8` gives the row its line and its
  // height from the first frame (0.000 in 5/5 runs after). 1× here, so 4× headroom below 0.1.
  test("dashboard at 393 px does not shift after hydration (CLS ≤ 0.1)", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["Pixel 5"] });
    await context.addInitScript(observeLayoutShifts);
    const page = await context.newPage();
    await devLogin(page, uniqueLogin("phone-cls-dash"));
    for (const title of ["One", "Two"]) {
      const res = await context.request.post("/api/documents", { data: { content: `# ${title}\n`, title } });
      expect(res.ok()).toBeTruthy();
    }
    await page.goto("/");
    await waitForHydration(page);
    await page.waitForTimeout(1000);
    const cls = await layoutShiftSum(page);
    console.log(`[1525] / phone CLS: ${cls.toFixed(3)}`);
    expect(cls).toBeLessThanOrEqual(0.1);
    await context.close();
  });

  for (const viewport of settingsViewports) {
    test(`settings at ${viewport.width} px keeps its header and theme card in the viewport`, async ({ browser }) => {
      const { context, page } = await signInOn(browser, `phone-settings-${viewport.width}`, { ...phone, viewport });
      await page.goto("/settings");
      await page.waitForLoadState("networkidle");

      const documentsLink = page.getByRole("link", { name: /Documents/i });
      await expect(documentsLink).toBeVisible();
      await expect(documentsLink).toHaveAccessibleName(/Documents/i);
      const rootWidth = await page.evaluate(() => document.scrollingElement!.scrollWidth);
      expect(rootWidth).toBeLessThanOrEqual(viewport.width);
      const documentsBox = (await documentsLink.boundingBox())!;
      expect(documentsBox.x).toBeGreaterThanOrEqual(0);
      expect(documentsBox.x + documentsBox.width).toBeLessThanOrEqual(viewport.width);
      expect(cssPx(documentsBox.height)).toBeGreaterThanOrEqual(32);

      const picker = page.getByTestId("theme-picker");
      await expect(picker).toBeVisible();
      const description = (await page.getByTestId("theme-description").boundingBox())!;
      const pickerBox = (await picker.boundingBox())!;
      expect(pickerBox.y).toBeGreaterThan(description.y + description.height - 1);
      expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(viewport.width);
      // The description gets the card's full width rather than being squeezed beside the control.
      expect(description.width).toBeGreaterThan(viewport.width / 2);
      await context.close();
    });
  }

  test("find bar at 390 px keeps the close button on the first row", async ({ browser }) => {
    const { context, page } = await signInOn(browser, "phone-find", { ...phone });
    const id = await createDocument(page, DOC, "Mobile find");
    await openDoc(page, id);
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("find-bar")).toBeVisible();
    const input = (await page.getByTestId("find-input").boundingBox())!;
    const close = (await page.getByTestId("find-close").boundingBox())!;
    expect(Math.abs(close.y - input.y)).toBeLessThanOrEqual(4);
    expect(close.x).toBeGreaterThan(input.x + input.width);
    expect(close.x + close.width).toBeLessThanOrEqual(phone.viewport.width);
    expect(await noHorizontalScroll(page)).toBe(true);
    await context.close();
  });
});

test.describe("tablet", () => {
  test("split layout with the outline hidden; the comments overlay does not reflow the preview", async ({ browser }) => {
    const { context, page } = await signInOn(browser, "tablet-user", { viewport: { width: 900, height: 1200 }, hasTouch: true });
    const id = await createDocument(page, DOC, "Tablet");
    await openDoc(page, id);
    await expect(page.getByTestId("editor-shell")).toHaveAttribute("data-breakpoint", "tablet");
    await expect(page.locator(".cm-content")).toBeVisible();
    await expect(page.locator(".md-rich")).toBeVisible();
    await expect(page.getByTestId("outline-collapsed")).toBeVisible();
    await expect(page.getByTestId("outline")).toHaveCount(0);
    const before = (await page.locator(".md-rich").boundingBox())!;
    await page.getByTestId("comments-toggle").click();
    await expect(page.getByTestId("panel-overlay")).toBeVisible();
    await expect(page.getByTestId("comments-panel")).toBeVisible();
    const overlay = (await page.getByTestId("panel-overlay").boundingBox())!;
    expect(Math.round(overlay.width)).toBe(360);
    const after = (await page.locator(".md-rich").boundingBox())!;
    expect(after.width).toBe(before.width);
    expect(after.x).toBe(before.x);
    await context.close();
  });
});
