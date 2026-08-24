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
 *   once ink-4 / cm-faint moved to #7f889a (task #192), so regressions there are caught.
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
    await context.close();
  });

  test("settings", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-settings");
    await page.goto("/settings");
    await expect(page.getByTestId("theme-row")).toBeVisible();
    await scan(page, "settings");
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

test.describe("axe: editor", () => {
  test("split view with outline and comments panels (Burke-scale document)", async ({ browser }) => {
    const { page, context } = await openEditorFixture(browser, "a11y-editor", { content: LONG_DOC });
    await expect(page.locator(".md-rich h2")).toHaveCount(40);
    await scan(page, "editor split + outline + comments (Burke-scale)");
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

    // Share dialog.
    await page.getByTestId("share-button").click();
    await expect(page.getByRole("dialog", { name: /share/i })).toBeVisible();
    await scan(page, "editor + share dialog");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /share/i })).not.toBeVisible();

    // Ask an agent dialog (with the first-run connect card when the user has no token), then the requests pill.
    await page.evaluate(() => window.localStorage.removeItem("markdoc:agent-connect-dismissed"));
    await page.getByTestId("ask-agent-button").click();
    await expect(page.getByTestId("ask-agent-dialog")).toBeVisible();
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
    await scan(page, "editor + image dialog");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /image/i })).not.toBeVisible();

    // Shortcuts dialog.
    await page.getByTestId("status-bar").getByRole("button", { name: "Help and shortcuts" }).click();
    await expect(page.getByRole("dialog", { name: /shortcuts/i })).toBeVisible();
    await scan(page, "editor + shortcuts dialog");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /shortcuts/i })).not.toBeVisible();
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
    await page.keyboard.press("Escape");
    await expect(share).toHaveCount(0);
    await expect.poll(() => activeIn(".md-rich")).toBe(true);

    // Palette → Esc (no command) also returns focus to the rich pane.
    await page.keyboard.press("Control+Shift+P");
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-input")).toHaveCount(0);
    await expect.poll(() => activeIn(".md-rich")).toBe(true);

    // Share from the header button (keyboard): Esc returns focus to that button.
    await page.getByTestId("share-button").focus();
    await page.keyboard.press("Enter");
    await expect(share).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(share).toHaveCount(0);
    await expect(page.getByTestId("share-button")).toBeFocused();
    await context.close();
  });
});
