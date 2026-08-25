import { test, expect, devices, type Browser, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createDocument, selectTextInRich } from "./helpers";

const DOC = "# Mobile doc\n\nSome **bold** text here to select.\n\n## Second\n\nMore words.\n\n## Third\n\nEnd.\n";

/** Sign in on a context that emulates a phone (or the given viewport). */
async function signInOn(browser: Browser, login: string, options: Parameters<Browser["newContext"]>[0]) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByTestId("dev-login").fill(login);
  await page.getByTestId("dev-login-submit").click();
  await page.waitForURL((url) => url.pathname === "/");
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
    expect(box.height).toBeGreaterThanOrEqual(40);
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
    expect(clearBox.width).toBeGreaterThanOrEqual(44);
    expect(clearBox.height).toBeGreaterThanOrEqual(44);
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

  test("settings theme card at 390 px stacks the picker under its description", async ({ browser }) => {
    const { context, page } = await signInOn(browser, "phone-settings", { ...phone });
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    const picker = page.getByTestId("theme-picker");
    await expect(picker).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    const description = (await page.getByTestId("theme-description").boundingBox())!;
    const pickerBox = (await picker.boundingBox())!;
    expect(pickerBox.y).toBeGreaterThan(description.y + description.height - 1);
    expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(phone.viewport.width);
    // The description gets the card's full width rather than being squeezed beside the control.
    expect(description.width).toBeGreaterThan(phone.viewport.width / 2);
    await context.close();
  });

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
