import { test, expect, devices, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn, createDocument, openDocument, ensureCommentsOpen, codeText, focusRichEnd, selectTextInRich, clickCell } from "./helpers";
import { LONG_DOC } from "./fixtures/burke-scale";

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
  "Closing words at the end.",
  "",
].join("\n");

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

async function scan(page: Page, state: string, { contrast = false }: { contrast?: boolean } = {}) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .disableRules(contrast ? [] : DISABLED_RULES)
    .analyze();
  const { violations } = results;
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

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => localStorage.setItem("markdoc:theme", t), theme);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** Sign in on a context that emulates an iPhone 13. */
async function signInPhone(browser: Browser, login: string) {
  const context = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByTestId("dev-login").fill(login);
  await page.getByTestId("dev-login-submit").click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.waitForLoadState("networkidle");
  return { context, page };
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

  test("settings", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-settings");
    await page.goto("/settings");
    await expect(page.getByTestId("theme-row")).toBeVisible();
    await expect(page.getByTestId("copilot-checklist")).toBeVisible();
    await scan(page, "settings (with Copilot CLI checklist)");
    await context.close();
  });

  test("onboarding: dashboard empty state with the guided-doc action, editor hint bar", async ({ browser }) => {
    const { page, context } = await signIn(browser, `a11y-onboard-${Date.now().toString(36)}`);
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
    await scan(page, "reader /p/<id>");
    await context.close();
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

    // Selection bubble.
    await selectTextInRich(page, "Closing words");
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
    const { page, context } = await openEditorFixture(browser, "a11y-editor-dialogs");

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

    // Ask an agent dialog (with the first-run connect card when the user has no token), then the requests pill.
    await page.evaluate(() => window.localStorage.removeItem("markdoc:agent-connect-dismissed"));
    await page.getByTestId("ask-agent-button").click();
    await expect(page.getByTestId("ask-agent-dialog")).toBeVisible();
    await expect(page.getByRole("dialog", { name: /ask an agent/i }).getByRole("button", { name: "Close" })).not.toBeFocused();
    await page.getByTestId("ask-agent-instruction").fill("Tighten this");
    await scan(page, "editor + ask-agent dialog");
    await page.getByTestId("ask-agent-send").click();
    await expect(page.getByTestId("ask-agent-dialog")).toHaveCount(0);
    await expect(page.getByTestId("agent-requests-pill")).toBeVisible();
    await scan(page, "editor + agent requests pill");
    await page.getByTestId("agent-requests-pill").click();
    await expect(page.getByTestId("agent-requests-list")).toBeVisible();
    await scan(page, "editor + agent requests menu");
    await page.getByTestId("agent-request-cancel").first().click();
    await expect(page.getByTestId("agent-requests-pill")).toHaveCount(0);

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

  test("review card and a comment with a suggestion diff (Accept / Reject, Outdated)", async ({ browser }) => {
    const { page, context, id } = await openEditorFixture(browser, "a11y-editor-review");
    // An agent review with one suggestion and one plain comment, posted over REST with a token (task #397).
    const tok = await page.request.post("/api/tokens", { data: { name: "Copilot", expiresInDays: 1 } });
    expect(tok.ok()).toBeTruthy();
    const token = ((await tok.json()) as { token: { token: string } }).token.token;
    const res = await page.request.post(`/api/documents/${id}/reviews`, {
      headers: { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" },
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
    await expect(page.getByTestId("suggestion-diff").first()).toBeVisible();
    await expect(page.getByTestId("suggestion-accept-comment")).toBeEnabled();
    await scan(page, "editor + review card + suggestion diff");
    await context.close();
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

test.describe("axe: phone (iPhone 13)", () => {
  test("dashboard + editor", async ({ browser }) => {
    const { page, context } = await signInPhone(browser, "a11y-phone");
    await seedDashboard(page);
    await scan(page, "phone dashboard");

    const id = await createDocument(page, DOC, "Phone fixture");
    await page.goto(`/d/${id}`);
    await expect(page.getByTestId("editor-shell")).toHaveAttribute("data-breakpoint", "phone");
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(page.locator(".md-rich")).toBeVisible();
    await scan(page, "phone editor");
    await context.close();
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
    await expect(page.getByTestId("ask-agent-button")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("heading-menu")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("ask-agent-button")).toBeFocused();
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
    await expect(page.getByTestId("toast")).toContainText("Saved version “Keyboard named”");
    await context.close();
  });
});
