import { test, expect, devices, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn, createDocument, openDocument, ensureCommentsOpen, codeText, focusRichEnd, selectTextInRich, clickCell } from "./helpers";

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
 * - `color-contrast`: axe cannot resolve contrast through `backdrop-blur` headers, the translucent
 *   dialog overlay and editor decorations, and reports "incomplete" rather than a verdict; the palette
 *   tokens are checked by eye in both themes (see README → Accessibility).
 */
const DISABLED_RULES = ["color-contrast"];

const softMode = process.env.A11Y_SOFT === "1";

async function scan(page: Page, state: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .disableRules(DISABLED_RULES)
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
    await scan(page, "dashboard (dark)");
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

test.describe("axe: editor", () => {
  test("split view, panels, every floating UI, compare mode, dark", async ({ browser }) => {
    const { page, context } = await signIn(browser, "a11y-editor");
    const id = await createDocument(page, DOC, "Editor fixture");
    // Two content revisions so the versions panel has something to compare.
    expect((await page.request.put(`/api/documents/${id}/content`, { data: { content: DOC + "\nVersion two.\n", message: "Two" } })).ok()).toBeTruthy();
    await openDocument(page, id);

    if ((await page.getByTestId("outline").count()) === 0) await page.getByTestId("outline-button").click();
    await expect(page.getByTestId("outline")).toBeVisible();
    await ensureCommentsOpen(page);
    await expect(page.locator(".md-rich table")).toBeVisible();
    await expect(page.locator(".md-rich pre")).toBeVisible();
    await expect(page.locator(".md-rich img[alt='Markdoc logo']")).toBeVisible();
    await scan(page, "editor split + outline + comments");

    // Find bar.
    await focusRichEnd(page);
    await page.keyboard.press("Control+F");
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

    // Table menu.
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

    // Stats popover.
    await page.getByTestId("stats-button").click();
    await expect(page.getByTestId("stats-popover")).toBeVisible();
    await scan(page, "editor + stats popover");
    await page.keyboard.press("Escape");

    // Presence popover.
    await page.getByTestId("presence").click();
    await expect(page.getByTestId("presence-popover")).toBeVisible();
    await scan(page, "editor + presence popover");
    await page.keyboard.press("Escape");

    // Notifications bell.
    await page.getByTestId("notifications-bell").click();
    await expect(page.getByTestId("notifications-popover")).toBeVisible();
    await scan(page, "editor + notifications popover");
    await page.keyboard.press("Escape");

    // Share dialog.
    await page.getByTestId("share-button").click();
    await expect(page.getByRole("dialog", { name: /share/i })).toBeVisible();
    await scan(page, "editor + share dialog");
    await page.keyboard.press("Escape");

    // Image dialog.
    await page.getByTestId("tb-image").click();
    await expect(page.getByRole("dialog", { name: /image/i })).toBeVisible();
    await scan(page, "editor + image dialog");
    await page.keyboard.press("Escape");

    // Shortcuts dialog.
    await page.getByTestId("status-bar").getByRole("button", { name: "Help and shortcuts" }).click();
    await expect(page.getByRole("dialog", { name: /shortcuts/i })).toBeVisible();
    await scan(page, "editor + shortcuts dialog");
    await page.keyboard.press("Escape");

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

    // Dark mode.
    await setTheme(page, "dark");
    await expect(page.locator(".md-rich")).toBeVisible();
    await ensureCommentsOpen(page);
    await scan(page, "editor (dark)");
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
    await tabUntil("[data-testid=tb-bold]");
    await expect(page.getByTestId("tb-bold")).toBeFocused();
    await tabUntil(".md-rich");

    // Bold the last word of the rich pane.
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Shift+Control+Left");
    await page.keyboard.press("Control+B");
    await expect.poll(() => codeText(page)).toContain("**charlie**");

    // Palette → Toggle theme.
    const before = await page.locator("html").getAttribute("data-theme");
    await page.keyboard.press("Control+Shift+P");
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await page.keyboard.type("Toggle theme");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme", before === "dark" ? "light" : "dark");
    await expect(page.locator(".md-rich")).toBeFocused();

    // Select a word and comment on it with Ctrl+Alt+M; Enter submits, Esc returns to the editor.
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+Control+Right");
    await page.keyboard.press("Control+Alt+M");
    await expect(page.getByTestId("comments-panel")).toBeVisible();
    await expect(page.getByTestId("comment-composer")).toBeFocused();
    await page.keyboard.type("Keyboard-only comment");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("comments-panel")).toContainText("Keyboard-only comment");
    await page.keyboard.press("Escape");

    // Share via the palette; Esc closes it and focus returns to the editor.
    await page.keyboard.press("Control+Shift+P");
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await page.keyboard.type("Share");
    await page.keyboard.press("Enter");
    const share = page.getByRole("dialog", { name: /share/i });
    await expect(share).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(share).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest(".md-rich, .cm-content, [data-testid=share-button], [data-testid=more-menu]") !== null)).toBe(true);
    await context.close();
  });
});
