import { test, expect } from "./fixtures";
import { devices, type Browser, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn, devLogin, waitForHydration, waitForEditor, reloadHydrated, createDocument, openDocument, ensureCommentsOpen, codeText, focusRichEnd, selectTextInRich, clickCell, tableCell, expectTableShape, mintToken, setTheme, cssPx, uniqueLogin } from "./helpers";
import { LONG_DOC } from "./fixtures/burke-scale";

// Some scans use minted fixture tokens or show a one-time key; capture must not retain their API credentials.
test.use({ trace: "off", screenshot: "off", video: "off" });
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

/**
 * Accessibility sweep: axe-core (WCAG 2.1 A/AA) on every screen and floating UI, then a
 * keyboard-only walkthrough of the editor. Run with `npx playwright test e2e/a11y.spec.ts`.
 * A11Y_SOFT=1 turns the zero-violation assertions into soft ones so one run reports every state.
 */

const DOC = [
  "# Accessibility fixture",
  "",
  "Intro paragraph with a **bold** word and a [link](https://example.com).",
  "",
  "## Table",
  "",
  "| Name | Role |",
  "| --- | --- |",
  "| Alice | Owner |",
  "| Bob | Editor |",
  "",
  "## Code",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "## Image",
  "",
  "![Markdoc logo](/favicon.ico)",
  "",
  "## Tasks",
  "",
  "- [x] Review accessibility notes",
  "- [ ] Publish the reader",
  "",
  "Closing words at the end.",
  "",
].join("\n");

const RICH_TYPESCRIPT_DOC = [
  "```ts",
  "interface Account {",
  "  id: number;",
  "  label: string;",
  "}",
  "",
  "class AccountService {",
  "  async findAccount(id: number): Promise<Account> {",
  '    const endpoint = "/api/accounts";',
  "    const retries = 3;",
  "    // Return one account",
  "    return { id, label: `${endpoint}/${retries}` };",
  "  }",
  "}",
  "```",
  "",
].join("\n");

const RICH_SYNTAX_VIEWPORTS = [
  { label: "390x844", viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 },
  { label: "1024x768", viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 },
  { label: "1440x900", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { label: "640x400 at 2x", viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 },
] as const;

const COMMENT_CONTRAST_VIEWPORTS = [
  { label: "390x844", viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 },
  { label: "640x400 at 2x", viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 },
  { label: "853x759", viewport: { width: 853, height: 759 }, deviceScaleFactor: 1 },
  { label: "1024x768", viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 },
  { label: "1440x900", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
] as const;

/**
 * Rules disabled with a reason. Everything else in the wcag2a/aa + wcag21a/aa tag set is enforced.
 * - `color-contrast`: in the light theme axe cannot resolve contrast through `backdrop-blur` headers,
 *   the translucent dialog overlay and editor decorations, and reports "incomplete" rather than a verdict;
 *   the light tokens are checked by eye and by src/app/theme-contrast.test.ts (see README → Accessibility).
 *   The dark dashboard and dark editor scans enable it (`contrast: true`): every dark token pair passed
 *   once ink-4 / cm-faint moved to #7f889a (task #192), so regressions there are caught. "axe: contrast"
 *   below scans the dashboard, editor, settings and reader with it on in light and dark — the palette
 *   was chosen to pass (src/app/tokens-contrast.test.ts).
 */
const DISABLED_RULES = ["color-contrast"];

const softMode = process.env.A11Y_SOFT === "1";

async function scan(page: Page, state: string, { contrast = false, targetSize = false }: { contrast?: boolean; targetSize?: boolean } = {}) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .disableRules(contrast ? [] : DISABLED_RULES)
    .analyze();
  const violations = [...results.violations];
  // WCAG 2.2 target size (24×24 px, SC 2.5.8) is outside the 2.1 tag set and `withRules` replaces
  // `withTags`, so touch scans run it as a second pass (#116: "Show all starred" was 117×16 px).
  if (targetSize) violations.push(...(await new AxeBuilder({ page }).withRules(["target-size"]).analyze()).violations);
  const lines = violations.map(
    (v) =>
      `  ${v.id} [${v.impact ?? "n/a"}] ×${v.nodes.length} — ${v.help}\n` +
      v.nodes
        .slice(0, 5)
        .map((n) => `      ${n.target.join(" ")}${n.failureSummary ? ` :: ${n.failureSummary.split("\n")[1]?.trim() ?? ""}` : ""}`)
        .join("\n"),
  );
  console.log(`[a11y] ${state}: ${violations.length} violation${violations.length === 1 ? "" : "s"}${lines.length ? `\n${lines.join("\n")}` : ""}`);
  const check = softMode ? expect.soft : expect;
  check(violations, `${state}\n${lines.join("\n")}`).toHaveLength(0);
}

function computedContrast(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`Cannot parse computed colour: ${color}`);
    const [r, g, b] = channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

async function expectRenderedTextContrast(locator: Locator, state: string) {
  const samples = await locator.evaluateAll((elements) => {
    type Rgba = [number, number, number, number];
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas 2D context is unavailable");
    const parse = (value: string): Rgba => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (foreground: Rgba, background: Rgba): Rgba => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      return [
        (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
        (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
        (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
        alpha,
      ];
    };
    const rgb = (color: Rgba) => `rgb(${Math.round(color[0])}, ${Math.round(color[1])}, ${Math.round(color[2])})`;

    return elements.map((element) => {
      const ancestors: Element[] = [];
      for (let current: Element | null = element; current; current = current.parentElement) ancestors.push(current);
      let background: Rgba = [255, 255, 255, 1];
      let opaqueAncestors = true;
      for (const ancestor of ancestors.reverse()) {
        const style = getComputedStyle(ancestor);
        opaqueAncestors &&= Number(style.opacity) === 1;
        background = over(parse(style.backgroundColor), background);
      }
      const foreground = parse(getComputedStyle(element).color);
      return {
        text: element.textContent?.trim() ?? "",
        foreground: rgb(over(foreground, background)),
        background: rgb(background),
        opaqueAncestors,
      };
    });
  });

  expect(samples.length, `${state}: representative text exists`).toBeGreaterThan(0);
  for (const sample of samples) {
    expect(sample.opaqueAncestors, `${state}: "${sample.text}" has no dimmed ancestor`).toBe(true);
    expect(
      computedContrast(sample.foreground, sample.background),
      `${state}: "${sample.text}" uses ${sample.foreground} on ${sample.background}`,
    ).toBeGreaterThanOrEqual(4.5);
  }
}

async function signInWithOptions(browser: Browser, login: string, options: Parameters<Browser["newContext"]>[0]) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await devLogin(page, login);
  await page.waitForLoadState("networkidle");
  return { context, page };
}

/** Sign in on a context that emulates an iPhone 13. */
async function signInPhone(browser: Browser, login: string) {
  return signInWithOptions(browser, login, { ...devices["iPhone 13"] });
}

async function seedDashboard(page: Page) {
  const a = await createDocument(page, "# Starred one\n\nBody.\n", "Starred one");
  await createDocument(page, "# Plain two\n\nBody.\n", "Plain two");
  const c = await createDocument(page, "# Trashed three\n\nBody.\n", "Trashed three");
  expect((await page.request.put(`/api/documents/${a}/star`)).ok()).toBeTruthy();
  expect((await page.request.delete(`/api/documents/${c}`)).ok()).toBeTruthy();
  await page.goto("/");
  await expect(page.getByTestId("document-card").first()).toBeVisible();
  await expect(page.getByTestId("starred-strip")).toBeVisible();
  await expect(page.getByTestId("filter-trash")).toBeVisible();
}

const READER_SCROLL_REGIONS = ".reader-body pre, .reader-body table";

async function expectReaderOverflowTabStops(page: Page, state: string) {
  await expect
    .poll(
      () =>
        page.locator(READER_SCROLL_REGIONS).evaluateAll(
          (regions) =>
            regions.filter((region) => region.scrollWidth > region.clientWidth + 1 && region.getAttribute("tabindex") !== "0").length,
        ),
      { message: `${state}: overflowing reader regions become keyboard focusable` },
    )
    .toBe(0);
  const result = await page.locator(READER_SCROLL_REGIONS).evaluateAll((regions) =>
    regions.map((region, index) => ({
      index,
      tag: region.tagName.toLowerCase(),
      overflow: region.scrollWidth > region.clientWidth + 1,
      tabIndex: region.getAttribute("tabindex"),
    })),
  );
  const overflowing = result.filter((region) => region.overflow);
  expect(overflowing.length, `${state}: at least one reader region overflows`).toBeGreaterThan(0);
  expect(
    overflowing.filter((region) => region.tabIndex !== "0"),
    `${state}: every overflowing region is its own keyboard focus target`,
  ).toEqual([]);
  expect(
    result.filter((region) => !region.overflow && region.tabIndex !== null),
    `${state}: regions that fit do not add tab stops`,
  ).toEqual([]);
  return overflowing;
}

async function scanReaderScrollableRegions(page: Page, state: string) {
  const violations = (await new AxeBuilder({ page }).withRules(["scrollable-region-focusable"]).analyze()).violations;
  expect(violations, `${state}: scrollable-region-focusable`).toHaveLength(0);
}

async function expectReaderRegionKeyboardScroll(page: Page, selector: "pre" | "table", state: string) {
  const regions = page.locator(`.reader-body ${selector}`);
  const index = await regions.evaluateAll((elements) => elements.findIndex((element) => element.scrollWidth > element.clientWidth + 1));
  expect(index, `${state}: an overflowing ${selector} exists`).toBeGreaterThanOrEqual(0);
  const region = regions.nth(index);
  await region.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await tabUntil(page, `.reader-body ${selector}`, 200);
  await expect(region).toBeFocused();
  const focusStyle = await region.evaluate((element) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("span");
    probe.style.color = "var(--color-accent)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { width: style.outlineWidth, offset: style.outlineOffset, color: style.outlineColor, accent };
  });
  expect(focusStyle.width, `${state}: ${selector} uses the 2 px focus ring`).toBe("2px");
  expect(focusStyle.offset, `${state}: ${selector} focus ring has the standard offset`).toBe("2px");
  expect(focusStyle.color, `${state}: ${selector} focus ring uses the accent color`).toBe(focusStyle.accent);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => region.evaluate((element) => element.scrollLeft), `${state}: ArrowRight scrolls the ${selector}`).toBeGreaterThan(0);
}

test.describe("axe: pages", () => {
  test("login", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByTestId("dev-login")).toBeVisible();
    await scan(page, "login");
  });

  test("dashboard: list, starred strip, trash chip, template dialog, dark", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-dash");
    await seedDashboard(page);
    await scan(page, "dashboard");

    await page.getByTestId("new-from-template").click();
    await expect(page.getByTestId("template-dialog")).toBeVisible();
    await scan(page, "dashboard + template dialog");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("template-dialog")).toHaveCount(0);

    await setTheme(page, "dark");
    await expect(page.getByTestId("document-card").first()).toBeVisible();
    await scan(page, "dashboard (dark)", { contrast: true });

    // Active no-match search: the ✕ clear button in the field and the empty state's "Clear search" link.
    await page.getByTestId("search").fill("zzzzqqq");
    await expect(page.getByTestId("empty-state")).toContainText('No matches for "zzzzqqq"');
    await expect(page.getByTestId("empty-state-clear-search")).toBeVisible();
    await expect(page.getByTestId("search-clear")).toBeVisible();
    await scan(page, "dashboard no-match search (dark)", { contrast: true });
    await context.close();
  });

  test("onboarding: dashboard empty state with the guided-doc action, editor hint bar", async ({ browser }) => {
    const { page, context } = await signIn(browser, uniqueLogin("a11y-onboard"));
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await expect(page.getByTestId("start-guided-doc")).toBeVisible();
    await scan(page, "dashboard empty state");

    // A comment thread opens hint (c); the bar sits under the toolbar.
    const id = await createDocument(page, "# Hint fixture\n\nA paragraph with enough words to comment on.\n", "Hint fixture");
    expect((await page.request.post(`/api/documents/${id}/comments`, { data: { action: "add", quote: "enough words", body: "Thread" } })).ok()).toBeTruthy();
    await openDocument(page, id);
    const bar = page.getByTestId("hint-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("data-hint", "mention-copilot");
    await scan(page, "editor + hint bar");
    await context.close();
  });

  test("reader page", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-reader");
    const id = await createDocument(page, DOC, "Reader fixture");
    expect((await page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "view" } })).ok()).toBeTruthy();
    await page.goto(`/p/${id}`);
    await expect(page.getByTestId("reader-body")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Review accessibility notes", exact: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Publish the reader", exact: true })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Review accessibility notes", exact: true })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: "Publish the reader", exact: true })).toBeDisabled();
    await scan(page, "reader /p/<id>");
    await context.close();
  });

  // Since #1495 the aside (one Tab stop per h2/h3) precedes the article in the DOM on every screen size, so
  // keyboard and screen-reader users need a way past it (#1564): a skip link as the first Tab stop, hidden
  // until focused; a <main> landmark; and a focusable article target, because Chromium only scrolls to a
  // fragment whose element is not focusable. The sticky title follows the logo and shares that target.
  test("reader skip and header-title links focus the article below the sticky header", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const isLoopback = (url: string | URL) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
    await context.route(/^https?:\/\//, async (route) => {
      if (isLoopback(route.request().url())) await route.continue();
      else await route.abort("blockedbyclient");
    });
    await context.routeWebSocket((url) => !isLoopback(url), (socket) => socket.close());
    const page = await context.newPage();
    await devLogin(page, "a11y-reader-skip");
    await page.waitForLoadState("networkidle");
    const title = "Reader skip-link fixture";
    const id = await createDocument(page, DOC, title);
    expect((await page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "view" } })).ok()).toBeTruthy();
    await page.goto(`/p/${id}`);
    await waitForHydration(page);
    await expect(page.getByTestId("reader-body")).toBeVisible();
    const viewport = page.viewportSize()!;
    const header = page.getByTestId("reader-header");
    const titleLink = page.getByTestId("reader-header-title");
    const articleTarget = page.getByTestId("reader-article");
    const articlePosition = async () => (await articleTarget.boundingBox())!.y;
    const expectArticlePosition = async () => {
      await expect.poll(articlePosition).toBeGreaterThanOrEqual(56);
      await expect.poll(articlePosition).toBeLessThanOrEqual(100);
    };

    const skip = page.getByTestId("reader-skip-link");
    const aboveViewport = async () => {
      const box = await skip.boundingBox();
      return box !== null && box.y + box.height <= 0;
    };
    await expect(header).toHaveCSS("height", "56px");
    await expect(titleLink).toHaveCount(1);
    await expect(titleLink).toHaveAttribute("href", "#reader-article");
    await expect(titleLink).toHaveAttribute("title", title);
    await expect(titleLink).toHaveAccessibleName(title);
    await expect(header.getByText(title, { exact: true })).toHaveCount(1);
    await expect(page.locator('header [data-testid="reader-header-title"][href="#reader-article"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="reader-skip-link"][href="#reader-article"]')).toHaveCount(1);
    await expect(page.locator("#reader-article")).toHaveCount(1);
    await expect(articleTarget).toHaveAttribute("tabindex", "-1");
    for (const control of [
      page.getByTestId("open-in-editor"),
      page.getByTestId("reader-copy-link"),
      page.getByTestId("reader-download"),
      page.getByTestId("reader-download-menu"),
    ]) {
      const [headerBox, controlBox] = await Promise.all([header.boundingBox(), control.boundingBox()]);
      expect(controlBox!.y).toBeGreaterThanOrEqual(headerBox!.y);
      expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(headerBox!.y + headerBox!.height);
    }
    expect(await aboveViewport(), "the skip link sits above the viewport until it has focus").toBe(true);

    // Tab once: the link is focused, rendered whole inside the viewport and above the sticky header.
    await page.keyboard.press("Tab");
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await expect(skip).toBeInViewport({ ratio: 1 });
    await expect(skip).toHaveText("Skip to article");
    const box = (await skip.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.height).toBeGreaterThanOrEqual(24);
    const topmost = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest("[data-testid=reader-skip-link]") !== null,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(topmost, "the focused skip link paints over the sticky header").toBe(true);

    // The title follows the unchanged logo stop and exposes the global keyboard-focus affordance.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "All documents" })).toBeFocused();
    await expect.poll(aboveViewport, "the skip link hides again once focus leaves it").toBe(true);
    await page.keyboard.press("Tab");
    await expect(titleLink).toBeFocused();
    expect(await titleLink.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");

    // Native Enter activation focuses the target at its existing 88 px scroll margin.
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? null)).toBe("reader-article");
    await expectArticlePosition();

    // Pointer activation has the same native focus and scroll behavior after the title is off-screen.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(page.getByTestId("reader-title")).not.toBeInViewport();
    await titleLink.click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? null)).toBe("reader-article");
    await expectArticlePosition();

    // The original first stop and skip-link activation remain unchanged.
    await page.reload();
    await waitForHydration(page);
    await skip.focus();
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? null)).toBe("reader-article");
    await expectArticlePosition();

    // No focus ring on the target: a click in the text focuses the article too, and the first PageDown after
    // it would otherwise frame the whole column (the base-layer ring is for controls).
    expect(await articleTarget.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
    const article = (await articleTarget.boundingBox())!;
    const headerBox = (await header.boundingBox())!;
    expect(article.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
    expect(article.y).toBeLessThan(viewport.height);
    await expect(page.getByTestId("reader-title")).toBeInViewport({ ratio: 1 });

    // Landmarks: exactly one main, holding the article; the TOC nav is untouched and still precedes it.
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("main").getByTestId("reader-article")).toHaveCount(1);
    const toc = page.getByRole("navigation", { name: "Table of contents" });
    await expect(toc).toHaveCount(1);
    await expect(toc.getByTestId("reader-toc-entry")).toHaveCount(4);
    await scan(page, "reader /p/<id> with the article focused via the skip link");
    await context.close();
  });

  test("Burke-scale reader overflow regions are keyboard scrollable only when needed", async ({ browser }) => {
    const user = await signIn(browser, "a11y-reader-overflow");
    const id = await createDocument(user.page, LONG_DOC, "Reader overflow fixture");
    expect((await user.page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "view" } })).ok()).toBeTruthy();
    await user.context.close();

    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto(`/p/${id}`);
      await expect(page.getByTestId("reader-body")).toBeVisible();
      const state = `reader ${viewport.width}×${viewport.height}`;
      await expectReaderOverflowTabStops(page, state);
      await scanReaderScrollableRegions(page, state);
      if (viewport.width === 390) {
        await expectReaderRegionKeyboardScroll(page, "pre", state);
        await expectReaderRegionKeyboardScroll(page, "table", state);
        await page.setViewportSize({ width: 768, height: 1024 });
        await expect
          .poll(() =>
            page.locator(READER_SCROLL_REGIONS).evaluateAll((regions) => ({
              overflowing: regions.filter((region) => region.scrollWidth > region.clientWidth + 1).length,
              tabStops: regions.filter((region) => region.hasAttribute("tabindex")).length,
            })),
          )
          .toEqual({ overflowing: 0, tabStops: 0 });
      }
      await context.close();
    }

    const zoomContext = await browser.newContext({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 });
    const zoomPage = await zoomContext.newPage();
    await zoomPage.goto(`/p/${id}`);
    await expect(zoomPage.getByTestId("reader-body")).toBeVisible();
    await expectReaderOverflowTabStops(zoomPage, "reader 640×400 at 200%");
    await expectReaderRegionKeyboardScroll(zoomPage, "pre", "reader 640×400 at 200%");
    await scanReaderScrollableRegions(zoomPage, "reader 640×400 at 200%");
    await zoomContext.close();
  });
});

/**
 * Sign in, create the fixture document, open it in split view with the outline and comments panels
 * showing. Each editor scan below starts here so a failure names the UI that broke and no single
 * test carries more than a handful of axe runs (one test used to do 15 and hit the 90 s timeout on
 * the 2-vCPU CI runner, see task #278). `content` defaults to the small DOC; the plain split-view
 * scan passes the Burke-scale document so axe walks an editor with 40 sections, 6 tables and 20
 * code blocks — the small one stays for the floating menus, which need its known text.
 */
async function openEditorFixture(browser: Browser, login: string, { revisions = false, content = DOC }: { revisions?: boolean; content?: string } = {}) {
  const { page, context } = await signIn(browser, login);
  const id = await createDocument(page, content, "Editor fixture");
  // A second content revision so the versions panel has something to compare.
  if (revisions) {
    expect((await page.request.put(`/api/documents/${id}/content`, { data: { content: content + "\nVersion two.\n", message: "Two" } })).ok()).toBeTruthy();
  }
  await openDocument(page, id);
  await ensureOutlineOpen(page);
  await ensureCommentsOpen(page);
  await expect(page.locator(".md-rich table").first()).toBeVisible();
  await expect(page.locator(".md-rich pre").first()).toBeVisible();
  if (content === DOC) await expect(page.locator(".md-rich img[alt='Markdoc logo']")).toBeVisible();
  else await expect(page.locator(".md-rich img").first()).toBeAttached();
  return { page, context, id };
}

async function ensureOutlineOpen(page: Page) {
  if ((await page.getByTestId("outline").count()) === 0) await page.getByTestId("outline-button").click();
  await expect(page.getByTestId("outline")).toBeVisible();
}

/**
 * Sixty lines of prose with no links, checkboxes or other natively focusable content, so each pane's
 * only focusable child is the editor itself. This is the case that used to fail
 * `scrollable-region-focusable` (task #361): axe does not count a contenteditable without an explicit
 * tabindex as focusable, and the Burke-scale fixture passed by accident because its links inside the
 * rich pane satisfied the rule.
 */
const LONG_PLAIN_DOC = ["# Long plain fixture"]
  .concat(Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of plain prose, long enough to make both panes scroll at 1280×900.`))
  .join("\n\n");

/** Selector of each pane's scroll container: CodeMirror's own scroller and the rich pane's parent in the shell. */
const CODE_SCROLLER = ".cm-scroller";
const RICH_SCROLLER = "[data-testid=rich-pane] >> xpath=..";
const OUTLINE_SCROLLER = "[data-testid=outline] nav";

/** Whether `selector` scrolls vertically (the same 13 px buffer axe's scrollable-region-focusable uses). */
const scrolls = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => el.scrollHeight > el.clientHeight + 13);

const scrollTop = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => el.scrollTop);

/** Elements in the Tab order inside `selector` (tabindex ≥ 0 or natively focusable, not disabled, rendered). */
const tabStops = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((root) => {
    const out: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      const ti = el.getAttribute("tabindex");
      const native = el.matches("a[href], button, input:not([type=hidden]), select, textarea, summary, [contenteditable='true'], [contenteditable='']");
      const inOrder = ti !== null ? Number(ti) >= 0 : native;
      if (!inOrder || el.matches(":disabled") || getComputedStyle(el).display === "none") continue;
      out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`);
    }
    return out;
  });

/** Press Tab until focus lands inside `selector` (no traps on the way). */
async function tabUntil(page: Page, selector: string, max = 60) {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate((s) => document.activeElement?.closest(s) !== null, selector)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached ${selector}`);
}

/**
 * Both panes (and the outline) scroll at this size, the scanners see 0 violations, and a keyboard user
 * can reach each pane with Tab and scroll it with PageDown — one tab stop per pane, never two.
 */
async function expectScrollablePanesAccessible(page: Page, state: string, { contrast = false, outline = false }: { contrast?: boolean; outline?: boolean } = {}) {
  expect(await scrolls(page, CODE_SCROLLER), `${state}: the code pane scrolls`).toBe(true);
  expect(await scrolls(page, RICH_SCROLLER), `${state}: the rich pane scrolls`).toBe(true);
  if (outline) expect(await scrolls(page, OUTLINE_SCROLLER), `${state}: the outline scrolls`).toBe(true);
  await scan(page, state, { contrast });

  // Tab into the code pane → PageDown scrolls it. CodeMirror moves the cursor by a page and scrolls
  // it into view, so the second PageDown is the first one that has to move the scroller.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await tabUntil(page, ".cm-content");
  expect(await tabStops(page, "[data-testid=code-pane]"), `${state}: one tab stop in the code pane`).toEqual(["div.cm-content"]);
  const codeBefore = await scrollTop(page, CODE_SCROLLER);
  await page.keyboard.press("PageDown");
  await page.keyboard.press("PageDown");
  await expect.poll(() => scrollTop(page, CODE_SCROLLER), `${state}: PageDown scrolls the code pane`).toBeGreaterThan(codeBefore);

  // Esc then Tab leaves CodeMirror (Tab indents there); Tab into the preview → PageDown scrolls it.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await tabUntil(page, ".md-rich");
  expect(await tabStops(page, "[data-testid=rich-pane]"), `${state}: one tab stop in the rich pane`).toEqual(["div.ProseMirror"]);
  await page.keyboard.press("Control+Home");
  const richBefore = await scrollTop(page, RICH_SCROLLER);
  await page.keyboard.press("PageDown");
  await page.keyboard.press("PageDown");
  await expect.poll(() => scrollTop(page, RICH_SCROLLER), `${state}: PageDown scrolls the rich pane`).toBeGreaterThan(richBefore);
  await page.keyboard.press("Control+Home");
}

test.describe("axe: editor", () => {
  test("split view with outline and comments panels (Burke-scale document)", async ({ browser }) => {
    const { page, context } = await openEditorFixture(browser, "a11y-editor", { content: LONG_DOC });
    await expect(page.locator(".md-rich h2")).toHaveCount(40);
    await scan(page, "editor split + outline + comments (Burke-scale)");

    // Narrower and shorter: the outline list (40 h2 + their h3s) scrolls too, and both panes scroll
    // (task #361: scrollable-region-focusable on every scroller of a long document).
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await page.getByTestId("outline").locator("li").count()).toBeGreaterThan(100);
    expect(await tabStops(page, OUTLINE_SCROLLER), "the outline list is one roving tab stop").toHaveLength(1);
    await scan(page, "editor split + outline + comments (Burke-scale, 1280×900, light)");
    expect(await scrolls(page, CODE_SCROLLER), "the code pane scrolls").toBe(true);
    expect(await scrolls(page, RICH_SCROLLER), "the rich pane scrolls").toBe(true);
    expect(await scrolls(page, OUTLINE_SCROLLER), "the outline scrolls").toBe(true);
    await context.close();
  });

  test("long document without links: both panes scroll, light and dark, one tab stop per pane", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-editor-long");
    await page.setViewportSize({ width: 1280, height: 900 });
    const id = await createDocument(page, LONG_PLAIN_DOC, "Long plain fixture");
    await openDocument(page, id);
    await ensureOutlineOpen(page);
    await expect(page.locator(".md-rich p")).toHaveCount(60);
    await expectScrollablePanesAccessible(page, "editor split, 60 lines (light)");

    await setTheme(page, "dark");
    await expect(page.locator(".md-rich p")).toHaveCount(60);
    await expectScrollablePanesAccessible(page, "editor split, 60 lines (dark)", { contrast: true });
    await context.close();
  });

  test("floating menus: find bar, slash menu, table menu, selection bubble, command palette", async ({ browser }) => {
    const { page, context } = await openEditorFixture(browser, "a11y-editor-menus");

    // Find bar.
    await focusRichEnd(page);
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("find-bar")).toBeVisible();
    await scan(page, "editor + find bar");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);

    // Slash menu.
    await focusRichEnd(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(page.getByTestId("slash-menu")).toBeVisible();
    await scan(page, "editor + slash menu");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");

    // Table menu (clickCell waits for it).
    await clickCell(page, 1, 0);
    await scan(page, "editor + table menu");

    // Selection bubble. The slash-menu step above (focusRichEnd, then Escape+Backspace) can leave "Closing words"
    // scrolled off-screen, so this is the one caller that opts into scrollIntoView (every other caller leaves
    // scroll position alone).
    await selectTextInRich(page, "Closing words", { scrollIntoView: true });
    await expect(page.getByTestId("selection-bubble")).toBeVisible();
    await scan(page, "editor + selection bubble");
    await page.keyboard.press("End");

    // Command palette.
    await page.keyboard.press("Control+Shift+P");
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await scan(page, "editor + command palette");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-input")).toHaveCount(0);
    await context.close();
  });

  test("popovers and dialogs: stats, presence, notifications, share, image, shortcuts", async ({ browser }) => {
    const { page, context, id } = await openEditorFixture(browser, "a11y-editor-dialogs");

    // Stats popover.
    await page.getByTestId("stats-button").click();
    await expect(page.getByTestId("stats-popover")).toBeVisible();
    await scan(page, "editor + stats popover");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("stats-popover")).not.toBeVisible();

    // Presence popover.
    await page.getByTestId("presence").click();
    await expect(page.getByTestId("presence-popover")).toBeVisible();
    await scan(page, "editor + presence popover");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("presence-popover")).not.toBeVisible();

    // Notifications bell.
    await page.getByTestId("notifications-bell").click();
    await expect(page.getByTestId("notifications-popover")).toBeVisible();
    await scan(page, "editor + notifications popover");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("notifications-popover")).not.toBeVisible();

    // Share dialog. Opening focus lands on the first control of the body, not the header Close button.
    await page.getByTestId("share-button").click();
    await expect(page.getByRole("dialog", { name: /share/i })).toBeVisible();
    await expect(page.getByTestId("share-login")).toBeFocused();
    await scan(page, "editor + share dialog");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /share/i })).not.toBeVisible();

    // A request is a comment that mentions an agent (#1075). This user has no token, so the `@` picker ends in the
    // connect row instead of an agent; then a request (posted the way the composer does) shows in the presence
    // popover (waiting placeholder in the stack, Requests section with Cancel) and the connect dialog.
    await page.evaluate(() => window.localStorage.removeItem("markdoc:agent-connect-dismissed"));
    await page.getByTestId("comments-panel").getByTestId("comment-document").click();
    const composer = page.getByTestId("pending-comment").getByTestId("comment-composer");
    await expect(composer).toBeFocused();
    await page.keyboard.type("@");
    await expect(page.getByTestId("mention-suggestions")).toBeVisible();
    await expect(page.getByTestId("mention-connect-row")).toBeVisible();
    await scan(page, "editor + mention picker with the connect row");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mention-suggestions")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pending-comment")).toHaveCount(0);
    expect((await page.request.post(`/api/documents/${id}/requests`, { data: { instruction: "Tighten this", mode: "suggest" } })).status()).toBe(201);
    await expect(page.getByTestId("presence").getByTestId("presence-waiting")).toBeVisible();
    await scan(page, "editor + presence waiting placeholder");
    await page.getByTestId("presence").click();
    await expect(page.getByTestId("presence-popover")).toBeVisible();
    await expect(page.getByTestId("presence-requests")).toBeVisible();
    await scan(page, "editor + presence popover with a request");
    await page.getByTestId("presence-request-cancel").first().click();
    await expect(page.getByTestId("presence-requests")).toHaveCount(0);
    await expect(page.getByTestId("presence").getByTestId("presence-waiting")).toHaveCount(0);
    await page.getByTestId("presence-popover").getByTestId("connect-agent").click();
    await expect(page.getByTestId("presence-popover")).toHaveCount(0);
    await expect(page.getByTestId("agent-dialog")).toBeVisible();
    await scan(page, "editor + connect dialog");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("agent-dialog")).toHaveCount(0);

    // Image dialog.
    await page.getByTestId("tb-image").click();
    await expect(page.getByRole("dialog", { name: /image/i })).toBeVisible();
    await expect(page.getByTestId("image-url")).toBeFocused();
    await scan(page, "editor + image dialog");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /image/i })).not.toBeVisible();

    // Shortcuts dialog: nothing tabbable in the body, so the Close button takes focus.
    await page.getByTestId("status-bar").getByRole("button", { name: "Help and shortcuts" }).click();
    await expect(page.getByRole("dialog", { name: /shortcuts/i })).toBeVisible();
    await expect(page.getByRole("dialog", { name: /shortcuts/i }).getByRole("button", { name: "Close" })).toBeFocused();
    await scan(page, "editor + shortcuts dialog");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /shortcuts/i })).not.toBeVisible();
    await context.close();
  });

  test("review card and a comment with a suggestion (Accept / Reject, Outdated)", async ({ browser }) => {
    const { page, context, id } = await openEditorFixture(browser, "a11y-editor-review");
    // An agent review with one suggestion and one plain comment, posted over REST with a token (task #397).
    // Revoked in `finally`: a CI retry signs in as the same user again and the name must be free (409 otherwise).
    const minted = await mintToken(page, "Copilot", { expiresInDays: 1 });
    try {
      const res = await page.request.post(`/api/documents/${id}/reviews`, {
        headers: { Authorization: ["Bearer", minted.token].join(" "), "Content-Type": "application/json" },
        data: {
          summary: "Two small things.",
          verdict: "request_changes",
          comments: [
            { quote: "Intro paragraph with a", body: "Tighter opener.\n\n```suggestion\nAn intro paragraph with a\n```" },
            { quote: "## Table", body: "Good table." },
          ],
        },
      });
      expect(res.status(), await res.text()).toBe(201);
      await expect(page.getByTestId("review-card")).toBeVisible();
      await page.getByTestId("review-toggle").click();
      await expect(page.getByTestId("review-thread-link")).toHaveCount(2);
      await expect(page.getByTestId("suggestion-text").first()).toHaveText("An intro paragraph with a");
      await expect(page.getByTestId("suggestion-accept-comment")).toBeEnabled();
      await scan(page, "editor + review card + suggestion");
    } finally {
      await minted.revoke();
      await context.close();
    }
  });

  test("comment composer with the agent mode row, then a thread card carrying the request chip (#1024)", async ({ browser }) => {
    const { page, context, id } = await openEditorFixture(browser, "a11y-editor-requests");
    // One of the user's own tokens: the picker offers it even though it has never been in this document.
    // Revoked in `finally`: a CI retry signs in as the same user again and the name must be free (409 otherwise).
    const minted = await mintToken(page, "Copilot", { expiresInDays: 1 });
    try {
      // Next dev compiles the requests route on its first hit (the shared warm-up does not cover it); take
      // that hit here so posting the comment below is measured against the 15 s expect budget, not the compile.
      const warm = await page.request.get(`/api/documents/${id}/requests`, { timeout: 120_000 });
      expect(warm.ok()).toBeTruthy();
      await selectTextInRich(page, "Closing words");
      await page.getByTestId("tb-comment").click();
      const composer = page.getByTestId("comment-composer");
      await expect(composer).toBeFocused();
      await page.keyboard.type("@cop");
      await expect(page.getByTestId("mention-suggestions").getByTestId("mention-option")).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect(composer).toHaveValue(`@a11y-editor-requests/${minted.name} `);
      await expect(page.getByTestId("composer-agent-row")).toBeVisible();
      await expect(page.getByRole("radiogroup", { name: `How should ${minted.name} answer?` })).toBeVisible();
      await scan(page, "editor + comment composer with the agent mode row");
      await page.keyboard.type("tighten this");
      await page.getByTestId("comment-submit").click();
      const chip = page.getByTestId("comment-thread").getByTestId("comment-request-chip");
      await expect(chip).toHaveAttribute("data-status", "open");
      await expect(chip.getByTestId("comment-request-cancel")).toBeVisible();
      await scan(page, "editor + thread card with a request chip");
    } finally {
      await minted.revoke();
      await context.close();
    }
  });

  test("versions panel in compare mode, activity panel", async ({ browser }) => {
    const { page, context } = await openEditorFixture(browser, "a11y-editor-history", { revisions: true });

    // Versions panel in compare mode.
    await page.getByTestId("more-menu").click();
    await page.getByRole("menuitem", { name: "Version history" }).click();
    await expect(page.getByTestId("versions-panel")).toBeVisible();
    const compares = page.getByTestId("version-compare");
    await expect.poll(() => compares.count()).toBeGreaterThanOrEqual(2);
    await compares.nth(0).check();
    await compares.nth(1).check();
    await expect(page.getByTestId("version-diff")).toBeVisible();
    await scan(page, "editor + versions compare");

    // Activity panel.
    await page.getByTestId("more-menu").click();
    await page.getByTestId("menu-activity").click();
    await expect(page.getByTestId("activity-panel")).toBeVisible();
    await scan(page, "editor + activity panel");
    await context.close();
  });

  test("dark: split view with panels, find bar, slash menu, table menu (color-contrast enabled)", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-editor-dark");
    const id = await createDocument(page, DOC, "Dark fixture");
    // Theme is switched on the dashboard so the document loads dark once, with no reload of /d/<id>.
    await setTheme(page, "dark");
    await openDocument(page, id);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator(".md-rich table")).toBeVisible();
    await ensureOutlineOpen(page);
    await ensureCommentsOpen(page);
    await scan(page, "editor (dark) split + outline + comments", { contrast: true });

    await focusRichEnd(page);
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("find-bar")).toBeVisible();
    await scan(page, "editor (dark) + find bar", { contrast: true });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);

    await focusRichEnd(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(page.getByTestId("slash-menu")).toBeVisible();
    await scan(page, "editor (dark) + slash menu", { contrast: true });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");

    await clickCell(page, 1, 0);
    await scan(page, "editor (dark) + table menu", { contrast: true });
    await context.close();
  });
});

/**
 * The look (Ink & teal, tasks #398 → #416) scanned with color-contrast ON in light and dark on the
 * dashboard, the editor, settings and the reader. This is the gate on the palette: a failing colour is
 * fixed in globals.css (src/app/tokens-contrast.test.ts has the same pairs as numbers), never here.
 */
test.describe("axe: contrast", () => {
  test("dashboard light + dark (color-contrast enabled)", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-contrast-dash");
    await seedDashboard(page);
    await scan(page, "dashboard (light)", { contrast: true });

    await setTheme(page, "dark");
    await expect(page.getByTestId("document-card").first()).toBeVisible();
    await scan(page, "dashboard (dark)", { contrast: true });
    await context.close();
  });

  test("editor split + outline + comments, light + dark (color-contrast enabled)", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-contrast-editor");
    const id = await createDocument(page, DOC, "Contrast fixture");
    await openDocument(page, id);
    await expect(page.locator(".md-rich table")).toBeVisible();
    await ensureOutlineOpen(page);
    await ensureCommentsOpen(page);
    await scan(page, "editor (light) split + outline + comments", { contrast: true });

    await setTheme(page, "dark");
    await expect(page.locator(".md-rich table")).toBeVisible();
    await ensureOutlineOpen(page);
    await ensureCommentsOpen(page);
    await scan(page, "editor (dark) split + outline + comments", { contrast: true });
    await context.close();
  });

  for (const { label, viewport, deviceScaleFactor } of RICH_SYNTAX_VIEWPORTS) {
    test(`light rich TypeScript syntax at ${label}`, async ({ browser }) => {
      const login = `a11y-rich-syntax-${viewport.width}-${viewport.height}-${deviceScaleFactor}`;
      const { page, context } = await signInWithOptions(browser, login, { viewport, deviceScaleFactor });
      await page.evaluate(() => {
        localStorage.setItem("markdoc:theme", "light");
        localStorage.setItem("markdoc:layout", "rich");
      });
      const id = await createDocument(page, RICH_TYPESCRIPT_DOC, "Rich syntax contrast fixture");
      await page.goto(`/d/${id}`);
      await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await expect(page.getByTestId("code-column")).toBeHidden();
      await expect(page.locator(".md-rich")).toBeVisible();

      const block = page.locator('.md-rich pre[data-language="ts"]');
      await block.scrollIntoViewIfNeeded();
      await expect(block).toBeVisible();
      // The highlight.js grammars load from their own chunk after the editor mounts; the scan and the
      // token readings below must see the coloured block, so wait for the first token to render.
      await expect(block.locator(".hljs-keyword").first()).toBeVisible();

      const axe = await new AxeBuilder({ page }).include('.md-rich pre[data-language="ts"]').withRules(["color-contrast"]).analyze();
      expect(
        axe.violations.flatMap((violation) => violation.nodes),
        `${label}: axe color-contrast nodes inside the visible TypeScript block`,
      ).toHaveLength(0);

      const background = await block.evaluate((element) => getComputedStyle(element).backgroundColor);
      const tokens = await block.locator('[class*="hljs-"]').evaluateAll((elements) =>
        elements.map((element) => ({
          className: element.className,
          color: getComputedStyle(element).color,
          text: element.textContent,
        })),
      );
      expect(tokens.length, `${label}: highlighted TypeScript tokens`).toBeGreaterThan(0);
      for (const token of tokens) {
        expect(
          computedContrast(token.color, background),
          `${label}: ${token.className} "${token.text}" uses ${token.color} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }

      const colors = await block.evaluate((root) => {
        const selectors = {
          keyword: ".hljs-keyword",
          string: ".hljs-string",
          attribute: ".hljs-attr",
          number: ".hljs-number",
          comment: ".hljs-comment",
          title: ".hljs-title",
        };
        return Object.fromEntries(
          Object.entries(selectors).map(([name, selector]) => {
            const token = root.querySelector(selector);
            if (!token) throw new Error(`Missing representative ${name} token (${selector})`);
            return [name, getComputedStyle(token).color];
          }),
        );
      });
      expect(colors.attribute, `${label}: attributes share the string token group`).toBe(colors.string);
      expect(new Set([colors.keyword, colors.string, colors.number, colors.comment, colors.title])).toHaveProperty("size", 5);
      await context.close();
    });
  }

  test("settings + reader, light + dark (color-contrast enabled)", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-contrast-pages");
    const id = await createDocument(page, DOC, "Contrast reader fixture");
    expect((await page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "view" } })).ok()).toBeTruthy();
    for (const theme of ["light", "dark"] as const) {
      await page.goto("/settings");
      await setTheme(page, theme);
      await expect(page.getByTestId("theme-row")).toBeVisible();
      await scan(page, `settings (${theme})`, { contrast: true });
      await page.goto(`/p/${id}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByTestId("reader-body")).toBeVisible();
      await scan(page, `reader (${theme})`, { contrast: true });
    }
    await context.close();
  });
});

/**
 * The agent setup on Settings and in the editor's dialogs. These tests make keys and leave the one-time key on screen;
 * the file records no trace, screenshot or video, and PLAYWRIGHT_NO_COPY_PROMPT keeps failure snapshots (which print
 * the page) out too.
 */
test.describe("axe: agent setup and keys", () => {
  test("settings: setup, options, key created, keys list, advanced", async ({ browser }) => {
    // Per run: the test makes a key, and a fixed login would carry it into the next run.
    const { page, context } = await signIn(browser, uniqueLogin("a11y-settings"));
    await page.goto("/settings");
    await waitForHydration(page);
    await expect(page.getByTestId("theme-row")).toBeVisible();
    await expect(page.getByTestId("agent-setup")).toBeVisible();
    await expect(page.getByTestId("keys-card")).toHaveCount(0);
    await scan(page, "settings (agent setup, no keys)");
    await page.getByTestId("agent-options-toggle").click();
    await expect(page.getByTestId("agent-options")).toBeVisible();
    await scan(page, "settings (agent setup, options open)");
    await page.getByTestId("agent-create-key").click();
    await expect(page.getByTestId("agent-setup-snippet")).toBeVisible();
    await scan(page, "settings (key created, waiting for the agent)");
    await reloadHydrated(page);
    await expect(page.getByTestId("keys-card")).toBeVisible();
    await page.getByTestId("key-manage").click();
    await expect(page.getByTestId("key-details")).toBeVisible();
    await scan(page, "settings (keys list, one key managed)");
    await page.getByTestId("advanced-toggle").click();
    await expect(page.getByTestId("webhooks-card")).toBeVisible();
    await scan(page, "settings (advanced: webhooks)");
    await context.close();
  });

  test("agent setup, keys, and the Share and connect dialogs, light + dark (color-contrast enabled)", async ({ browser }) => {
    // Per run: the test makes a key.
    const { page, context } = await signIn(browser, uniqueLogin("a11y-contrast-agents"));
    const id = await createDocument(page, DOC, "Contrast agents fixture");
    // The theme is the html[data-theme] attribute; flipping it keeps the on-screen state (a reload would drop the key's command).
    // Colours ease over 150 ms and dialogs fade in, and axe would read the in-between values, so both are switched off first.
    const flip = (theme: "light" | "dark") =>
      page.evaluate((value) => {
        if (!document.getElementById("settled-styles")) {
          const style = document.createElement("style");
          style.id = "settled-styles";
          style.textContent = '*, *::before, *::after { transition: none !important; } [role="dialog"], [role="dialog"] * { animation: none !important; }';
          document.head.append(style);
        }
        document.documentElement.setAttribute("data-theme", value);
      }, theme);

    await page.goto("/settings");
    await waitForHydration(page);
    await page.getByTestId("agent-create-key").click();
    await expect(page.getByTestId("agent-setup-snippet")).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await flip(theme);
      await scan(page, `settings: key created, waiting for the agent (${theme})`, { contrast: true });
    }
    await reloadHydrated(page);
    await page.getByTestId("key-manage").click();
    await expect(page.getByTestId("key-details")).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await flip(theme);
      await scan(page, `settings: keys list, one key managed (${theme})`, { contrast: true });
    }

    await openDocument(page, id);
    for (const theme of ["light", "dark"] as const) {
      await flip(theme);
      await page.getByTestId("share-button").click();
      await expect(page.getByTestId("share-connect-agent")).toBeVisible();
      await scan(page, `share dialog (${theme})`, { contrast: true });
      await page.getByTestId("share-connect-agent").click();
      await expect(page.getByTestId("agent-dialog")).toBeVisible();
      await scan(page, `connect dialog (${theme})`, { contrast: true });
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("agent-dialog")).toHaveCount(0);
    }
    await context.close();
  });
});

test.describe("axe: comment metadata contrast", () => {
  const login = "a11y-comment-contrast-owner-with-a-long-name";
  let id: string;

  test.beforeAll(async ({ browser }) => {
    const owner = await signIn(browser, login);
    try {
      id = await createDocument(owner.page, "# Comment contrast\n\nShared text for every comment anchor.\n", "Comment contrast fixture");
      const threadIds: string[] = [];
      for (let start = 0; start < 25; start += 5) {
        const responses = await Promise.all(
          Array.from({ length: Math.min(5, 25 - start) }, (_, offset) => {
            const index = start + offset;
            const mention = index === 0 || index === 10 ? "@contrast-peer " : "";
            return owner.page.request.post(`/api/documents/${id}/comments`, {
              data: {
                action: "add",
                quote: "Shared text",
                body: `${mention}${index < 10 ? "Resolved" : "Open"} contrast thread ${index + 1}.`,
              },
            });
          }),
        );
        for (const response of responses) {
          expect(response.ok()).toBeTruthy();
          threadIds.push(((await response.json()) as { id: string }).id);
        }
      }
      expect(
        (
          await owner.page.request.post(`/api/documents/${id}/comments`, {
            data: { action: "reply", threadId: threadIds[0], body: "Reply timestamp." },
          })
        ).ok(),
      ).toBeTruthy();
      const resolved = await Promise.all(
        threadIds.slice(0, 10).map((threadId) =>
          owner.page.request.post(`/api/documents/${id}/comments`, {
            data: { action: "resolve", threadId, resolved: true },
          }),
        ),
      );
      expect(resolved.every((response) => response.ok())).toBe(true);
    } finally {
      await owner.context.close();
    }
  });

  for (const { label, viewport, deviceScaleFactor } of COMMENT_CONTRAST_VIEWPORTS) {
    test(`timestamps, resolved labels and mentions at ${label}`, async ({ browser }) => {
      const { page, context } = await signInWithOptions(browser, login, { viewport, deviceScaleFactor });
      await page.evaluate(() => {
        localStorage.setItem("markdoc:theme", "light");
      });
      await page.goto(`/d/${id}`);
      await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
      await expect(page.locator(".md-rich")).toBeVisible();

      for (const theme of ["light", "dark"] as const) {
        if (theme === "dark") await setTheme(page, theme);
        if ((await page.getByTestId("comments-panel").count()) === 0) {
          const toggle = page.getByTestId("comments-toggle");
          await expect(toggle).toBeVisible();
          await toggle.focus();
          await page.keyboard.press("Enter");
          await expect(toggle).toHaveAttribute("data-active", "true");
        }
        await expect(page.getByTestId("comments-panel")).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const panel = page.getByTestId("comments-panel");

        for (const [tab, count] of [
          ["open", 15],
          ["resolved", 10],
        ] as const) {
          await page.getByTestId(`comments-tab-${tab}`).click();
          await expect(panel.getByTestId("comment-thread")).toHaveCount(count);
          const axe = await new AxeBuilder({ page }).include('[data-testid="comments-panel"]').withRules(["color-contrast"]).analyze();
          expect(
            axe.violations.flatMap((violation) => violation.nodes),
            `${label} ${theme} ${tab}: axe color-contrast nodes inside the populated comments panel`,
          ).toHaveLength(0);
          await expectRenderedTextContrast(panel.getByTestId("comment-timestamp"), `${label} ${theme} ${tab} timestamps`);
          await expectRenderedTextContrast(panel.getByTestId("mention-chip"), `${label} ${theme} ${tab} mention chips`);
          if (tab === "resolved") {
            await expectRenderedTextContrast(panel.getByTestId("comment-resolved-state"), `${label} ${theme} resolved labels`);
          }
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
            `${label} ${theme} ${tab}: no horizontal page overflow`,
          ).toBe(true);
          expect(
            await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
            `${label} ${theme} ${tab}: no horizontal panel overflow`,
          ).toBe(true);
        }
      }

      await context.close();
    });
  }
});

test.describe("axe: phone (iPhone 13)", () => {
  test("dashboard + editor", async ({ browser }) => {
    // A user of its own per run: the tap below expects exactly seven starred cards, and a second run against the
    // same server (--repeat-each, a CI retry) as a fixed login sees the previous run's seven too (received 14).
    const { page, context } = await signInPhone(browser, uniqueLogin("a11y-phone"));
    await seedDashboard(page);
    // Seven starred documents so the strip overflows and renders "Show all starred" (#116).
    for (let i = 2; i <= 7; i++) {
      const id = await createDocument(page, `# Starred ${i}\n\nBody.\n`, `Starred ${i}`);
      expect((await page.request.put(`/api/documents/${id}/star`)).ok()).toBeTruthy();
    }
    await page.goto("/");
    // Server markup carries no handlers: the tap below is this page's first interaction.
    await waitForHydration(page);
    const showAll = page.getByTestId("show-all-starred");
    await expect(showAll).toBeVisible();
    const box = await showAll.boundingBox();
    expect(box, "show-all-starred bounding box").not.toBeNull();
    expect(cssPx(box!.height)).toBeGreaterThanOrEqual(44);
    expect(cssPx(box!.width)).toBeGreaterThanOrEqual(44);
    await scan(page, "phone dashboard", { targetSize: true });

    // Desktop keeps a ≥ 24 px target (WCAG 2.2 minimum) without the phone padding.
    await page.setViewportSize({ width: 1280, height: 900 });
    const desktopBox = await showAll.boundingBox();
    expect(cssPx(desktopBox!.height)).toBeGreaterThanOrEqual(24);
    await page.setViewportSize(devices["iPhone 13"].viewport);
    expect(cssPx((await showAll.boundingBox())!.height)).toBeGreaterThanOrEqual(44);

    // Tapping it filters to the starred documents.
    await showAll.tap();
    await expect(page.getByTestId("document-card")).toHaveCount(7);
    await expect(page.getByTestId("starred-strip")).toHaveCount(0);

    const id = await createDocument(page, DOC, "Phone fixture");
    await page.goto(`/d/${id}`);
    await expect(page.getByTestId("editor-shell")).toHaveAttribute("data-breakpoint", "phone");
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(page.locator(".md-rich")).toBeVisible();
    await scan(page, "phone editor");
    await context.close();
  });

  test("reader download keeps distinct accessible names across mobile and zoom breakpoints", async ({ browser }) => {
    const owner = await signIn(browser, "a11y-phone-reader");
    const id = await createDocument(owner.page, DOC, "Phone reader fixture");
    expect((await owner.page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "view" } })).ok()).toBeTruthy();

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`/p/${id}`);
    await expect(page.getByTestId("reader-body")).toBeVisible();

    for (const viewport of [
      { width: 320, height: 568 },
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 412, height: 915 },
      { width: 640, height: 400 },
      { width: 768, height: 1024 },
    ]) {
      await page.setViewportSize(viewport);
      // "Download Markdown" is a native `<a href>` link on purpose (pre-hydration downloads work without JS).
      const download = page.getByRole("link", { name: "Download Markdown", exact: true });
      await expect(download).toHaveAttribute("data-testid", "reader-download");
      await expect(page.getByRole("button", { name: "Download as…", exact: true })).toHaveAttribute("data-testid", "reader-download-menu");
      await expect(download.locator("span")).toBeVisible({ visible: viewport.width >= 640 });
      await scan(page, `reader download (${viewport.width}x${viewport.height})`);
    }

    await context.close();
    await owner.context.close();
  });

  test("reader download list opens inside the viewport and scans clean at 320 px and 1280 px", async ({ browser }) => {
    const owner = await signIn(browser, "a11y-phone-reader-list");
    const id = await createDocument(owner.page, DOC, "Phone reader list fixture");
    expect((await owner.page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "view" } })).ok()).toBeTruthy();

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`/p/${id}`);
    await expect(page.getByTestId("reader-body")).toBeVisible();
    // The header is server-rendered; the toggle only answers clicks once React has hydrated the page.
    await page.waitForLoadState("networkidle");

    const toggle = page.getByTestId("reader-download-menu");
    const list = page.getByTestId("reader-download-list");
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(list).toBeHidden();
      await toggle.click();
      await expect(list).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId("reader-download-md")).toBeFocused();
      // No portal and no collision maths: right-aligned under the toggle, the 192 px list must still fit a 320 px phone.
      const box = await list.boundingBox();
      expect(box, `reader-download-list bounding box at ${viewport.width}px`).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      await scan(page, `reader download open (${viewport.width}x${viewport.height})`);
      await page.keyboard.press("Escape");
      await expect(list).toBeHidden();
      await expect(toggle).toBeFocused();
    }

    await context.close();
    await owner.context.close();
  });
});

test.describe("manual checks", () => {
  test("landmarks, pane names, live regions, skip link, unique control names", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-manual");
    const id = await createDocument(page, DOC, "Manual fixture");
    await openDocument(page, id);

    // Landmarks on the editor shell.
    await expect(page.getByRole("banner")).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("contentinfo")).toHaveCount(1);
    await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Document outline" })).toBeVisible();

    // Pane names and roles.
    const rich = page.locator(".md-rich");
    await expect(rich).toHaveAttribute("role", "textbox");
    await expect(rich).toHaveAttribute("aria-multiline", "true");
    await expect(rich).toHaveAttribute("aria-label", "Rich text editor");
    await expect(page.locator(".cm-content")).toHaveAttribute("aria-label", "Markdown source");

    // Live regions.
    await expect(page.getByTestId("save-state")).toHaveAttribute("role", "status");

    // Skip link targets the active pane.
    const skip = page.getByTestId("skip-link");
    await page.keyboard.press("Tab");
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest(".md-rich, .cm-content") !== null)).toBe(true);

    // Screen-reader names resolve uniquely for the main controls.
    for (const name of ["Bold", "Italic", "Comments", "More", "Share", "Star document", "Help and shortcuts", "Undo", "Redo"]) {
      await expect(page.getByRole("button", { name, exact: true }), name).toHaveCount(1);
    }
    await expect(page.getByRole("button", { name: /^1 person here: / })).toHaveCount(1);
    await context.close();
  });
});

test.describe("keyboard-only walkthrough", () => {
  test("tab to toolbar, bold, palette theme toggle, comment, share, focus restore", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-keys");
    const id = await createDocument(page, "# Keys\n\nAlpha bravo charlie.\n", "Keys fixture");
    await openDocument(page, id);

    const activeIn = (selector: string) => page.evaluate((s) => document.activeElement?.closest(s) !== null, selector);
    const tabUntil = async (selector: string, max = 40) => {
      for (let i = 0; i < max; i++) {
        if (await activeIn(selector)) return;
        await page.keyboard.press("Tab");
      }
      throw new Error(`Tab never reached ${selector}`);
    };

    // From page load: Tab reaches the skip link, the header, then the toolbar, then the panes — no traps.
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("skip-link")).toBeFocused();
    await tabUntil("[data-testid=header]");
    await tabUntil("[data-testid=toolbar]");
    // Roving tabindex: the toolbar is one tab stop that lands on its first enabled button; ←/→ move
    // (wrapping), Home/End jump, disabled buttons (Undo/Redo on a fresh document) are skipped.
    await expect(page.getByTestId("heading-menu")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("tb-bold")).toBeFocused();
    await expect(page.getByTestId("tb-undo")).toBeDisabled();
    await expect(page.getByTestId("tb-redo")).toBeDisabled();
    await page.keyboard.press("End");
    await expect(page.getByTestId("tb-comment")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("heading-menu")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("tb-comment")).toBeFocused();
    // Undo/Redo sit between Horizontal rule and Comment; disabled, they are skipped.
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("button", { name: "Horizontal rule", exact: true })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.getByTestId("heading-menu")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("tb-bold")).toBeFocused();
    // One Tab leaves the toolbar; Shift+Tab comes back to the last-used button, not the first.
    await page.keyboard.press("Tab");
    expect(await activeIn("[data-testid=toolbar]")).toBe(false);
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByTestId("tb-bold")).toBeFocused();
    await page.keyboard.press("Tab");
    // The Markdown pane binds Tab to indent; CodeMirror's escape hatch is Esc then Tab (within 2 s).
    await tabUntil(".cm-content");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await tabUntil(".md-rich");

    // Bold the last word of the rich pane (step over the full stop first).
    await page.keyboard.press("Control+End");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Shift+Control+ArrowLeft");
    await expect.poll(() => page.evaluate(() => String(window.getSelection()))).toBe("charlie");
    // Let ProseMirror pick up the DOM selection before the shortcut (see selectTextInRich in helpers).
    await page.waitForTimeout(200);
    await page.keyboard.press("Control+b");
    await expect.poll(() => codeText(page)).toContain("**charlie**");

    // Palette → Toggle theme (cycles system → light → dark; assert the preference moved on).
    const toggle = page.getByTestId("theme-toggle").first();
    const before = await toggle.getAttribute("data-theme-preference");
    await page.keyboard.press("Control+Shift+P");
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await page.keyboard.type("Toggle theme");
    await page.keyboard.press("Enter");
    await expect(toggle).not.toHaveAttribute("data-theme-preference", before ?? "");
    await expect(page.getByTestId("toast")).toContainText("Theme:");

    // Select a word and comment on it with Ctrl+Alt+M; Enter submits, Esc returns to the editor.
    if (!(await activeIn(".md-rich"))) {
      await tabUntil(".cm-content");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Tab");
      await tabUntil(".md-rich");
    }
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+Control+ArrowRight");
    await expect.poll(() => page.evaluate(() => String(window.getSelection()).trim())).toBe("Alpha");
    await page.waitForTimeout(200);
    await page.keyboard.press("Control+Alt+m");
    await expect(page.getByTestId("comments-panel")).toBeVisible();
    await expect(page.getByTestId("comment-composer")).toBeFocused();
    await page.keyboard.type("Keyboard-only comment");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("comments-panel")).toContainText("Keyboard-only comment");
    // Posting hands focus back to the editor; Esc there is a no-op rather than a trap.
    await expect.poll(() => activeIn(".md-rich, .cm-content")).toBe(true);
    await page.keyboard.press("Escape");

    // Share via the palette; Esc closes it and focus returns exactly to where it was before the palette
    // opened — inside the rich pane — not to <body> (the dialog has no Radix Trigger to fall back on).
    if (!(await activeIn(".md-rich"))) {
      await tabUntil(".cm-content");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Tab");
      await tabUntil(".md-rich");
    }
    expect(await activeIn(".md-rich")).toBe(true);
    await page.keyboard.press("Control+Shift+P");
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await page.keyboard.type("Share");
    await page.keyboard.press("Enter");
    const share = page.getByRole("dialog", { name: /share/i });
    await expect(share).toBeVisible();
    await expect(page.getByTestId("share-login")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(share).toHaveCount(0);
    await expect.poll(() => activeIn(".md-rich")).toBe(true);

    // Palette → Esc (no command) also returns focus to the rich pane.
    await page.keyboard.press("Control+Shift+P");
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-input")).toHaveCount(0);
    await expect.poll(() => activeIn(".md-rich")).toBe(true);

    // Share from the header button (keyboard): focus starts in the handle field; Esc returns it to that button.
    await page.getByTestId("share-button").focus();
    await page.keyboard.press("Enter");
    await expect(share).toBeVisible();
    await expect(page.getByTestId("share-login")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(share).toHaveCount(0);
    await expect(page.getByTestId("share-button")).toBeFocused();

    // Name current version from the ⋮ menu (keyboard only): focus must be in the name field, not on the
    // dialog's Close button, so typing + Enter names the version (#110).
    await page.getByTestId("more-menu").focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Name current version" }).focus();
    await page.keyboard.press("Enter");
    const nameDialog = page.getByRole("dialog", { name: "Name this version" });
    await expect(nameDialog).toBeVisible();
    await expect(page.getByTestId("version-name")).toBeFocused();
    await page.keyboard.type("Keyboard named");
    await page.keyboard.press("Enter");
    await expect(nameDialog).toHaveCount(0);
    // The "Theme:" toast from above may still be showing (4.5 s), so pick the version toast by text.
    await expect(page.getByTestId("toast").filter({ hasText: "Saved version" })).toContainText("Saved version “Keyboard named”");
    await context.close();
  });
});

test.describe("dialog focus return (#161)", () => {
  test("Image, Link, Shortcuts, GitHub and Name version hand focus back to their opener, never <body>", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-return");
    const id = await createDocument(page, "# Return\n\nAlpha bravo charlie.\n", "Return fixture");
    await openDocument(page, id);

    // tag/testid of document.activeElement, the way the issue's evidence table reads.
    const active = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "body";
        return el.getAttribute("data-testid") ?? (el.closest(".md-rich") ? "rich" : el.closest(".cm-content") ? "code" : el.tagName.toLowerCase());
      });
    const closedWith = async (name: RegExp | string, key: "Escape" | "Cancel") => {
      const dialog = page.getByRole("dialog", { name });
      await expect(dialog).toBeVisible();
      if (key === "Escape") await page.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
    };

    // 1. Insert image from the toolbar with the mouse: the button does not take focus (it keeps the caret
    //    in the editor), so the editor is the opener and gets focus — and its selection — back.
    await selectTextInRich(page, "charlie");
    await page.getByTestId("tb-image").click();
    await expect(page.getByTestId("image-url")).toBeFocused();
    await closedWith("Insert image", "Escape");
    await expect.poll(active).toBe("rich");
    expect(await page.evaluate(() => String(window.getSelection()).trim())).toBe("charlie");

    // 2. Insert link with Ctrl+K on a selection (a shortcut): back to the rich pane, selection intact.
    await selectAfterFocusReturn(page, "bravo");
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("link-url")).toBeFocused();
    await closedWith(/link/i, "Escape");
    await expect.poll(active).toBe("rich");
    expect(await page.evaluate(() => String(window.getSelection()).trim())).toBe("bravo");
    // The Cancel button behaves like Esc.
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("link-url")).toBeFocused();
    await closedWith(/link/i, "Cancel");
    await expect.poll(active).toBe("rich");

    // 3–5. Dialogs opened from the ⋮ menu with the keyboard: the menu item is unmounted by the time the
    //      dialog closes, so focus goes to the menu's trigger. The item we want is picked once it really
    //      has focus.
    const fromMenu = async (item: string) => {
      await openMoreByKeyboard(page);
      const menuItem = page.getByRole("menuitem", { name: item });
      await menuItem.focus();
      await expect(menuItem).toBeFocused();
      await page.keyboard.press("Enter");
    };
    await fromMenu("Keyboard shortcuts");
    await closedWith("Keyboard shortcuts", "Escape");
    await expect.poll(active).toBe("more-menu");

    await fromMenu("Connect to GitHub…");
    await closedWith("Connect to GitHub", "Escape");
    await expect.poll(active).toBe("more-menu");

    await fromMenu("Name current version");
    await expect(page.getByTestId("version-name")).toBeFocused();
    await closedWith("Name this version", "Escape");
    await expect.poll(active).toBe("more-menu");
    // The shortcut form of the same dialog (Ctrl+/) from the editor returns to the editor.
    await moreMenuGone(page);
    await focusRichEnd(page);
    await page.keyboard.press("Control+/");
    await closedWith("Keyboard shortcuts", "Escape");
    await expect.poll(active).toBe("rich");

    // Toolbar button activated with Enter: the dialog takes focus (it did not, #161) and Esc returns to the button.
    await page.getByTestId("tb-image").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("image-url")).toBeFocused();
    await closedWith("Insert image", "Escape");
    await expect.poll(active).toBe("tb-image");

    // Submitting still lands in the editor (task #437): Apply on the link dialog puts the caret after the link.
    await selectTextInRich(page, "Alpha");
    await page.keyboard.press("Control+k");
    await page.getByTestId("link-url").fill("https://example.com");
    await page.getByTestId("link-submit").click();
    await expect(page.getByRole("dialog", { name: /link/i })).toHaveCount(0);
    await expect.poll(active).toBe("rich");
    await expect.poll(() => codeText(page)).toContain("[Alpha](https://example.com)");
    await context.close();
  });

  // #2223: on main the shared dialog closed on Escape only once a hand-rolled coordinator had "published"
  // it. After any other dialog had opened and closed on the page, a dialog opened from the ⋮ menu was
  // never published, so Escape did nothing. These tests use a dialog first, then open each dialog the way
  // a person does (real keys walking the menu, or real mouse clicks) and press Escape as soon as it shows.
  const focusedId = (page: Page) =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "body";
      return el.getAttribute("data-testid") ?? (el.closest(".md-rich") ? "rich" : el.closest(".cm-content") ? "code" : el.tagName.toLowerCase());
    });
  // ProseMirror writes its own selection back to the page once, about 20 ms after the editor regains
  // focus (its focus handler), so a selection made by script in that window is undone: on a production
  // build 14 of 15 at 20 ms after a dialog gave focus back to the editor, none of 15 at 5 ms and at
  // 80 ms. A person cannot select text that fast. So the selection is made again until the selection on
  // the page is the wanted text.
  const selectAfterFocusReturn = (page: Page, text: string) =>
    expect(async () => {
      await selectTextInRich(page, text);
      expect(await page.evaluate(() => String(window.getSelection()))).toBe(text);
    }, `the selection on the page should be "${text}" once a dialog has given focus back to the editor`).toPass({ timeout: 45_000 });
  // The ⋮ menu stays mounted, closed, until its 120 ms fade-in has ended (up to about 170 ms after it
  // opened) when one of its items is picked sooner than that. Until it is gone, Enter on the ⋮ button
  // is dropped by the menu's own gate in header.tsx (#2222, inventory row 34), and it still answers
  // Escape in place of a dialog that has just opened. A person cannot press a key 10 ms after a dialog
  // closes, so the next step waits until the earlier menu is gone.
  const moreMenuGone = (page: Page) => expect(page.getByRole("menu")).toHaveCount(0);
  // The menu opened by Enter is ready once it has put focus on one of its items.
  const openMoreByKeyboard = async (page: Page) => {
    await moreMenuGone(page);
    await page.getByTestId("more-menu").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[role="menuitem"]:focus')).toHaveCount(1);
  };
  const arrowToItem = async (page: Page, name: string) => {
    await expect(page.getByRole("menu")).toBeVisible();
    for (let i = 0; i < 30; i++) {
      // Radix moves menu focus in a setTimeout after ArrowDown; wait one task so we read where it landed.
      const text = await page.evaluate(
        () =>
          new Promise<string | null>((resolve) =>
            setTimeout(() => resolve(document.activeElement?.getAttribute("role") === "menuitem" ? document.activeElement.textContent : null)),
          ),
      );
      if (text?.includes(name)) return;
      await page.keyboard.press("ArrowDown");
    }
    throw new Error(`ArrowDown never reached the "${name}" menu item`);
  };
  const escapeCloses = async (page: Page, name: RegExp | string) => {
    const dialog = page.getByRole("dialog", { name });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  };

  test("Keyboard shortcuts opened from More with the real keyboard closes on the first Escape and focus returns to More (#2223)", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-esc-kbd");
    const id = await createDocument(page, "# Escape\n\nAlpha bravo charlie.\n", "Escape fixture");
    await openDocument(page, id);

    // Use another dialog first (Ctrl+K, then Escape): on main this is what left later dialogs unclosable.
    await selectTextInRich(page, "bravo");
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("link-url")).toBeFocused();
    await escapeCloses(page, /link/i);

    await openMoreByKeyboard(page);
    await arrowToItem(page, "Keyboard shortcuts");
    await page.keyboard.press("Enter");
    await escapeCloses(page, "Keyboard shortcuts");
    await expect.poll(() => focusedId(page)).toBe("more-menu");
    await context.close();
  });

  for (const via of ["mouse", "keyboard"] as const) {
    test(`Image, Link, Shortcuts, GitHub and Name version opened by ${via} close on the first Escape and focus returns to the opener (#2223)`, async ({ browser }) => {
      const { page, context } = await signIn(browser, `a11y-esc-${via}`);
      const id = await createDocument(page, "# Escape\n\nAlpha bravo charlie.\n", "Escape fixture");
      await openDocument(page, id);

      const fromMore = async (item: string) => {
        if (via === "mouse") {
          await page.getByTestId("more-menu").click();
          await page.getByRole("menuitem", { name: item }).click();
        } else {
          await openMoreByKeyboard(page);
          await arrowToItem(page, item);
          await page.keyboard.press("Enter");
        }
      };
      const fromToolbar = async (testId: string) => {
        if (via === "mouse") await page.getByTestId(testId).click();
        else {
          await page.getByTestId(testId).focus();
          await page.keyboard.press("Enter");
        }
      };

      // A mouse click on a toolbar button keeps the caret in the editor, so the editor is the opener;
      // Enter on a focused button makes the button the opener.
      const toolbarOpener = (testId: string) => (via === "mouse" ? "rich" : testId);
      await selectTextInRich(page, "charlie");
      await fromToolbar("tb-image");
      await expect(page.getByTestId("image-url")).toBeFocused();
      await escapeCloses(page, "Insert image");
      await expect.poll(() => focusedId(page)).toBe(toolbarOpener("tb-image"));

      await selectAfterFocusReturn(page, "bravo");
      await fromToolbar("tb-link");
      await expect(page.getByTestId("link-url")).toBeFocused();
      await escapeCloses(page, /link/i);
      await expect.poll(() => focusedId(page)).toBe(toolbarOpener("tb-link"));

      await fromMore("Keyboard shortcuts");
      await escapeCloses(page, "Keyboard shortcuts");
      await expect.poll(() => focusedId(page)).toBe("more-menu");

      await fromMore("Connect to GitHub");
      await escapeCloses(page, "Connect to GitHub");
      await expect.poll(() => focusedId(page)).toBe("more-menu");

      await fromMore("Name current version");
      await expect(page.getByTestId("version-name")).toBeFocused();
      await escapeCloses(page, "Name this version");
      await expect.poll(() => focusedId(page)).toBe("more-menu");
      await context.close();
    });

    // The people popover closes in the commit that opens "Connect an AI agent", so the popover button that
    // opened the dialog is gone when the dialog closes: focus belongs on the people button, the popover's
    // trigger. The first open on a page also loads the dialog's chunk, which hid the bug (focus on <body>
    // from the second time on), so every way of closing runs after an earlier round.
    test(`Connect an AI agent opened from the people popover by ${via} returns focus to the people button every time`, async ({ browser }) => {
      const { page, context } = await signIn(browser, `a11y-people-${via}`);
      const id = await createDocument(page, "# People\n\nAlpha bravo charlie.\n", "People fixture");
      await openDocument(page, id);

      const people = page.getByTestId("presence");
      const popover = page.getByTestId("presence-popover");
      const connect = popover.getByTestId("connect-agent");
      const dialog = page.getByRole("dialog", { name: "Connect an AI agent" });
      const close = dialog.getByRole("button", { name: "Close" });
      const tabTo = async (target: Locator, key: "Tab" | "Shift+Tab") => {
        for (let i = 0; i < 20 && !(await target.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press(key);
        await expect(target).toBeFocused();
      };

      for (const how of ["Escape", "Close", "Escape", "Close"] as const) {
        if (via === "mouse") {
          await people.click();
          await connect.click();
        } else {
          await people.focus();
          await page.keyboard.press("Enter");
          await expect(popover).toBeVisible();
          await tabTo(connect, "Tab");
          await page.keyboard.press("Enter");
        }
        await expect(dialog).toBeVisible();
        await expect(popover).toHaveCount(0);
        await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);

        if (how === "Escape") await page.keyboard.press("Escape");
        else if (via === "mouse") await close.click();
        else {
          await tabTo(close, "Shift+Tab");
          await page.keyboard.press("Enter");
        }
        await expect(dialog).toHaveCount(0);
        await expect(people).toBeFocused();
      }
      await context.close();
    });
  }

  // #2207: the keyboard case above (`fromMenu` + Enter) already passed on main - Radix drives Enter by
  // calling the item's `.click()` from script, so the whole chain runs synchronously ahead of the
  // microtask that the real-mouse bug depended on. A real, trusted mouse click is a different code path
  // and, on main, left focus on <body> instead of handing it back to the More trigger. This test is the
  // mouse counterpart to the Enter cases already covered above (Keyboard shortcuts, Connect to GitHub).
  test("a real mouse click on Keyboard shortcuts, Connect to GitHub and a linked GitHub connection hands focus back to the More trigger, never <body> (#2207)", async ({
    browser,
  }) => {
    const { page, context } = await signIn(browser, "a11y-return-mouse");
    const id = await createDocument(page, "# Return\n\nAlpha bravo charlie.\n", "Return fixture");
    await openDocument(page, id);

    const active = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "body";
        return el.getAttribute("data-testid") ?? el.tagName.toLowerCase();
      });
    const closedWithMouseThenEscape = async (name: RegExp | string) => {
      const dialog = page.getByRole("dialog", { name });
      await expect(dialog).toBeVisible();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    };

    // Keyboard shortcuts: a real mouse click on the item, not Enter.
    await page.getByTestId("more-menu").click();
    await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
    await closedWithMouseThenEscape("Keyboard shortcuts");
    await expect.poll(active).toBe("more-menu");

    // Connect to GitHub: unlinked document, same mouse-click path.
    await page.getByTestId("more-menu").click();
    await page.getByTestId("menu-github").click();
    await closedWithMouseThenEscape("Connect to GitHub");
    await expect.poll(active).toBe("more-menu");

    // GitHub connection: a document already linked to a (fake) repo shows the "connected" variant of the
    // same item, which reads the live doc.storage rather than a window.open target.
    const linkedId = await createDocument(page, "# Linked\n", "Linked fixture");
    const seed = await page.request.post("/api/github/mock", { data: { kind: "repo", owner: "mock", repo: "a11y-return", branch: "main", path: "doc.md", content: "# Linked\n" } });
    expect(seed.ok()).toBeTruthy();
    const link = await page.request.post(`/api/documents/${linkedId}/link`, { data: { storage: "repo", owner: "mock", repo: "a11y-return", branch: "main", path: "doc.md" } });
    expect(link.ok()).toBeTruthy();
    await openDocument(page, linkedId);
    await page.getByTestId("more-menu").click();
    await page.getByTestId("menu-github").click();
    await closedWithMouseThenEscape("GitHub connection");
    await expect.poll(active).toBe("more-menu");

    await context.close();
  });

  // #2207: compact-only paths need the phone layout, where Share and Publish move into the More menu
  // itself instead of having their own toolbar buttons.
  test("a real mouse click on compact Share and compact Publish hands focus back to the More trigger, never <body> (#2207)", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 393, height: 851 } });
    const page = await context.newPage();
    await devLogin(page, uniqueLogin("a11y-return-compact"));
    await waitForHydration(page);

    const active = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "body";
        return el.getAttribute("data-testid") ?? el.tagName.toLowerCase();
      });

    const id = await createDocument(page, "# Compact\n", "Compact fixture");
    // Not `openDocument`: on a phone layout only one pane renders at a time (#1121), so its
    // `.cm-content` + `.md-rich` both-visible check never passes here (see e2e/phone-overlays.spec.ts).
    await page.goto(`/d/${id}`);
    await waitForEditor(page);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });

    // compact Share
    await page.getByTestId("more-menu").click();
    await page.getByTestId("menu-share").click();
    const share = page.getByRole("dialog", { name: /^Share /});
    await expect(share).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(share).toHaveCount(0);
    await expect.poll(active).toBe("more-menu");

    // compact Publish to GitHub: the document is unlinked here, so this opens the same
    // "Connect to GitHub" dialog as menu-github's unlinked state. (The linked "Commit to
    // GitHub…" state uses CommitDialog, which has its own pre-existing Escape bug tracked
    // separately and is out of scope for #2203/#2207.)
    await page.getByTestId("more-menu").click();
    await page.getByTestId("menu-publish").click();
    const publish = page.getByRole("dialog", { name: "Connect to GitHub" });
    await expect(publish).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(publish).toHaveCount(0);
    await expect.poll(active).toBe("more-menu");

    await context.close();
  });
});

test.describe("insert-table grid keyboard (#160)", () => {
  test("one Tab stop, arrows move focus and the label, Enter inserts, Tab leaves for Close, axe clean", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-table-grid");
    const id = await createDocument(page, "# Grid\n\nIntro paragraph.\n", "Grid fixture");
    await openDocument(page, id);
    await page.locator(".md-rich p").last().click();
    await page.keyboard.press("End");
    await page.getByTestId("tb-table").click();

    const dialog = page.getByRole("dialog", { name: "Insert table" });
    await expect(dialog).toBeVisible();
    const grid = page.getByTestId("table-grid");
    const activeLabel = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);

    // WAI-ARIA grid: one roving tab stop, focus starts on the first cell and the label follows it.
    await expect(grid).toHaveAttribute("role", "grid");
    await expect(grid.getByRole("row")).toHaveCount(6);
    await expect(grid.getByRole("gridcell")).toHaveCount(48);
    await expect(grid.locator('[tabindex="0"]')).toHaveCount(1);
    await expect(grid.locator('button[tabindex="-1"]')).toHaveCount(47);
    await expect.poll(activeLabel).toBe("1 by 1");
    await expect(page.getByTestId("table-grid-label")).toHaveText("1 rows × 1 columns");

    // ArrowRight ×2, ArrowDown ×2 → 3 by 3; the label reads the same; still exactly one tab stop.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect.poll(activeLabel).toBe("3 by 3");
    await expect(page.getByTestId("table-grid-label")).toHaveText("3 rows × 3 columns");
    await expect(grid.locator('[tabindex="0"]')).toHaveCount(1);
    await expect(grid.locator('[tabindex="0"]')).toHaveAttribute("aria-label", "3 by 3");
    await scan(page, "editor + insert table dialog (grid focus on 3 by 3)");

    // Edges clamp; Home/End stay in the row; Ctrl+Home returns to the first cell.
    await page.keyboard.press("End");
    await expect.poll(activeLabel).toBe("3 by 8");
    await page.keyboard.press("ArrowRight");
    await expect.poll(activeLabel).toBe("3 by 8");
    await page.keyboard.press("Home");
    await expect.poll(activeLabel).toBe("3 by 1");
    await page.keyboard.press("ArrowLeft");
    await expect.poll(activeLabel).toBe("3 by 1");
    await page.keyboard.press("Control+End");
    await expect.poll(activeLabel).toBe("6 by 8");
    await page.keyboard.press("Control+Home");
    await expect.poll(activeLabel).toBe("1 by 1");

    // Exactly one Tab from a grid cell reaches the dialog's Close button (was 48, #160); Shift+Tab comes back.
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect.poll(activeLabel).toBe("1 by 1");

    // Back to 3 by 3 with the keyboard and Enter inserts a 3×3 table; the caret lands in it.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect.poll(activeLabel).toBe("3 by 3");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expectTableShape(page, 3, 3);
    await expect(page.locator(".md-rich")).toBeFocused();

    // Reopening starts over at 1 by 1 (not where the last pick left focus).
    await page.getByTestId("tb-table").click();
    await expect(dialog).toBeVisible();
    await expect.poll(activeLabel).toBe("1 by 1");
    await expect(page.getByTestId("table-grid-label")).toHaveText("1 rows × 1 columns");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await context.close();
  });
});

test.describe("Esc dismisses the floating menus (#163)", () => {
  test("selection bubble: Esc collapses the selection; table menu: Esc hides it, typing stays in the cell; find bar still closes", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-escape");
    const id = await createDocument(page, "# Esc\n\nSelect these words for the bubble test please.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nLast paragraph.\n", "Esc fixture");
    await openDocument(page, id);
    await expect(page.locator(".md-rich table")).toBeVisible();
    const collapsed = () => page.evaluate(() => window.getSelection()?.isCollapsed ?? null);

    // Selection bubble.
    await selectTextInRich(page, "these words");
    await expect(page.getByTestId("selection-bubble")).toBeVisible();
    expect(await collapsed()).toBe(false);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("selection-bubble")).toHaveCount(0);
    await expect.poll(collapsed).toBe(true);
    // Focus stays in the editor and the caret sits at the selection's head, so typing continues there.
    await expect(page.locator(".md-rich")).toBeFocused();
    await page.keyboard.type("X");
    await expect(page.locator(".md-rich p").nth(0)).toHaveText("Select these wordsX for the bubble test please.");
    await page.keyboard.press("Backspace");

    // Table menu: Esc hides it, the caret stays in the cell, a typed character lands there.
    await clickCell(page, 1, 0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("table-menu")).toHaveCount(0);
    await expect(page.locator(".md-rich")).toBeFocused();
    await page.keyboard.type("z");
    await expect(tableCell(page, 1, 0)).toHaveText("1z");
    // Typing moved the selection, so the menu is back; a caret move also brings it back after another Esc.
    await expect(page.getByTestId("table-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("table-menu")).toHaveCount(0);
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("table-menu")).toBeVisible();

    // Esc with a selection inside the cell collapses first (bubble), the second Esc hides the menu.
    await page.keyboard.press("Shift+ArrowRight");
    await expect(page.getByTestId("selection-bubble")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("selection-bubble")).toHaveCount(0);
    await expect(page.getByTestId("table-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("table-menu")).toHaveCount(0);

    // Regression guard: Esc in the find bar still closes it, with the rich pane's Esc binding in place.
    await page.locator(".md-rich p").last().click();
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("find-input")).toBeFocused();
    await page.keyboard.type("Last");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 1");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expect(page.locator(".md-rich")).toBeFocused();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("Last");
    // …and the selection the find bar handed back collapses with one more Esc, bubble gone.
    await expect(page.getByTestId("selection-bubble")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("selection-bubble")).toHaveCount(0);
    await expect.poll(collapsed).toBe(true);

    // The Shortcuts dialog documents the decision: docked panels close from their header, not Esc.
    await page.keyboard.press("Control+/");
    const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(shortcuts).toBeVisible();
    await expect(shortcuts.getByText("Clear the selection / hide the table menu")).toBeVisible();
    await expect(page.getByTestId("shortcuts-panels-note")).toContainText("close from the × in their header");
    await page.keyboard.press("Escape");
    await expect(shortcuts).toHaveCount(0);
    await context.close();
  });
});
