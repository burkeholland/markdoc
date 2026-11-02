import { devices } from "@playwright/test";
import { test, expect } from "./fixtures";
import { signIn, createDocument, openDocument, focusCodeEnd, codeText, cssPx, devLogin, uniqueLogin } from "./helpers";

const CONTENT = ["# Reader Title", "", "Intro paragraph for the reader.", "", "## First Section", "", "Some text in the first section.", "", "## Second Section", "", "```ts", "const x = 1;", "```", ""].join("\n");

async function setLinkAccess(page: import("@playwright/test").Page, id: string, linkAccess: "private" | "view" | "comment" | "edit") {
  const res = await page.request.patch(`/api/documents/${id}`, { data: { linkAccess } });
  expect(res.ok()).toBeTruthy();
}

test.describe("reader view", () => {
  test("anonymous visitor reads a view-shared document with a table of contents", async ({ browser }) => {
    const owner = await signIn(browser, "reader-owner");
    const id = await createDocument(owner.page, CONTENT, "Reader Title");
    await setLinkAccess(owner.page, id, "view");

    const anon = await browser.newContext();
    const page = await anon.newPage();
    const res = await page.goto(`/p/${id}`);
    expect(res?.status()).toBe(200);

    await expect(page.getByTestId("reader-title")).toHaveText("Reader Title");
    const body = page.getByTestId("reader-body");
    await expect(body.locator("h1")).toHaveText("Reader Title");
    await expect(body.locator("h2")).toHaveCount(2);
    await expect(body.locator("pre code.hljs")).toBeVisible();
    await expect(page.getByTestId("reader-byline")).toContainText("Updated");

    const toc = page.getByTestId("reader-toc-entry");
    await expect(toc).toHaveCount(2);
    await expect(toc.nth(0)).toHaveText("First Section");
    await expect(toc.nth(1)).toHaveText("Second Section");

    // No editor chrome for the audience; no edit affordance for a viewer.
    await expect(page.getByTestId("editor-shell")).toHaveCount(0);
    await expect(page.getByTestId("toolbar")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toHaveCount(0);
    await expect(page.getByTestId("open-in-editor")).toHaveCount(0);
    await expect(page.getByTestId("reader-download")).toBeVisible();

    // The TOC links to the heading anchors.
    await toc.nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/p/${id}#second-section$`));
    await expect(body.locator("#second-section")).toBeInViewport();

    // Downloads go through the existing export route.
    const md = await anon.request.get(`/api/documents/${id}/export?format=md`);
    expect(md.ok()).toBeTruthy();
    expect(await md.text()).toContain("# Reader Title");

    await anon.close();
    await owner.context.close();
  });

  test("mobile reader header controls have 44px touch targets without visible clutter", async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      ...devices["iPhone 13"],
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await devLogin(page, uniqueLogin("reader-touch-targets"));
    await page.waitForLoadState("networkidle");
    const id = await createDocument(page, CONTENT, "Reader Title");
    await setLinkAccess(page, id, "view");
    await page.goto(`/p/${id}`);
    await expect(page.getByTestId("reader-title")).toHaveText("Reader Title");
    await page.waitForLoadState("networkidle");

    const header = page.getByTestId("reader-header");
    await page.screenshot({
      path: testInfo.outputPath("reader-header-mobile.png"),
      clip: { x: 0, y: 0, width: 375, height: 56 },
      scale: "css",
    });

    const controls = [
      { label: "All documents", locator: header.getByRole("link", { name: "All documents", exact: true }) },
      { label: "Edit", locator: header.getByTestId("open-in-editor") },
      { label: "Copy link", locator: header.getByTestId("reader-copy-link") },
      { label: "Download Markdown", locator: header.getByTestId("reader-download") },
      { label: "Download as", locator: header.getByTestId("reader-download-menu") },
    ];
    for (const { label, locator } of controls) {
      await expect(locator).toBeVisible();
      const target = await locator.evaluate((element) => {
        const after = getComputedStyle(element, "::after");
        return {
          width: Number.parseFloat(after.width),
          height: Number.parseFloat(after.height),
          content: after.content,
        };
      });
      expect(target.content, `${label} touch target`).not.toBe("none");
      expect(target.width, `${label} touch target width`).toBeGreaterThanOrEqual(44);
      expect(target.height, `${label} touch target height`).toBeGreaterThanOrEqual(44);
    }

    await expect(header.getByText("Edit", { exact: true })).toBeVisible();
    await expect(header.getByText("Open in editor", { exact: true })).toBeHidden();
    await expect(header.getByText("Copy link", { exact: true })).toBeHidden();
    await expect(header.getByText("Download", { exact: true })).toBeHidden();
    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(cssPx(headerBox!.height)).toBe(56);
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);

    await context.close();
  });

  test("download menu lists Markdown, HTML and PDF links, is keyboard-operable and closes on Escape and outside click", async ({ browser }) => {
    const owner = await signIn(browser, "reader-owner");
    const id = await createDocument(owner.page, CONTENT, "Reader Title");
    await setLinkAccess(owner.page, id, "view");

    const anon = await browser.newContext();
    const page = await anon.newPage();
    await page.goto(`/p/${id}`);
    await expect(page.getByTestId("reader-title")).toHaveText("Reader Title");
    // The header is server-rendered; the toggle only answers clicks once React has hydrated the page.
    await page.waitForLoadState("networkidle");

    const toggle = page.getByTestId("reader-download-menu");
    const list = page.getByTestId("reader-download-list");
    const md = page.getByTestId("reader-download-md");
    const html = page.getByTestId("reader-download-html");
    const pdf = page.getByTestId("reader-download-pdf");

    // Closed by default; the disclosure is a button with a list of links, not a menu.
    await expect(list).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).not.toHaveAttribute("aria-haspopup");

    // Click opens: three plain links to the export route, focus on the first one.
    await toggle.click();
    await expect(list).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(md).toBeVisible();
    await expect(html).toBeVisible();
    await expect(pdf).toBeVisible();
    await expect(md).toHaveAttribute("href", `/api/documents/${id}/export?format=md&download=1`);
    await expect(html).toHaveAttribute("href", `/api/documents/${id}/export?format=html&download=1`);
    await expect(pdf).toHaveAttribute("href", `/api/documents/${id}/export?format=pdf&download=1`);
    await expect(md).toBeFocused();

    // Arrow keys move and wrap; End jumps to the last link.
    await page.keyboard.press("ArrowDown");
    await expect(html).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(md).toBeFocused();
    await page.keyboard.press("End");
    await expect(pdf).toBeFocused();

    // Escape closes and returns focus to the toggle.
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();

    // A click outside closes.
    await toggle.click();
    await expect(list).toBeVisible();
    await page.getByTestId("reader-body").click();
    await expect(list).toBeHidden();

    // Enter on the toggle opens; Tab past the last link leaves the component and closes the list.
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(list).toBeVisible();
    await expect(md).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(list).toBeHidden();

    // Activating a link downloads through the export route (an attachment, so the page stays),
    // closes the list and returns focus to the toggle. HTML rather than PDF: PDF rendering is slow under load.
    await toggle.click();
    await expect(html).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await html.click();
    const download = await downloadPromise;
    expect(download.url()).toContain("format=html&download=1");
    expect(download.suggestedFilename()).toMatch(/\.html$/);
    await expect(list).toBeHidden();
    await expect(toggle).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/p/${id}$`));

    await anon.close();
    await owner.context.close();
  });

  test("anonymous /d on a view-only link redirects to the reader; comment links keep the editor", async ({ browser }) => {
    const owner = await signIn(browser, "reader-owner");
    const id = await createDocument(owner.page, CONTENT, "Reader Title");
    await setLinkAccess(owner.page, id, "view");

    const anon = await browser.newContext();
    const page = await anon.newPage();
    await page.goto(`/d/${id}`);
    await expect(page).toHaveURL(new RegExp(`/p/${id}$`));
    await expect(page.getByTestId("reader-title")).toHaveText("Reader Title");

    await setLinkAccess(owner.page, id, "comment");
    await page.goto(`/d/${id}`);
    await expect(page).toHaveURL(new RegExp(`/d/${id}$`));
    await expect(page.getByTestId("editor-shell")).toBeVisible();

    await anon.close();
    await owner.context.close();
  });

  test("private documents are not readable anonymously; strangers get 404", async ({ browser }) => {
    const owner = await signIn(browser, "reader-owner");
    const id = await createDocument(owner.page, CONTENT, "Reader Title");

    // Same as /d today: signed-out visitors are sent to sign in.
    const anon = await browser.newContext();
    const page = await anon.newPage();
    await page.goto(`/p/${id}`);
    await expect(page).toHaveURL(/\/login\?next=/);
    expect(new URL(page.url()).searchParams.get("next")).toBe(`/p/${id}`);
    await anon.close();

    const stranger = await signIn(browser, "reader-stranger");
    const res = await stranger.page.goto(`/p/${id}`);
    expect(res?.status()).toBe(404);
    await stranger.context.close();

    // The owner can always read their own document and gets the editor link.
    await owner.page.goto(`/p/${id}`);
    await expect(owner.page.getByTestId("reader-title")).toHaveText("Reader Title");
    await expect(owner.page.getByTestId("open-in-editor")).toHaveAttribute("href", `/d/${id}`);
    await owner.context.close();
  });

  test("header menu opens the reader view and the share dialog shows the reader link", async ({ browser }) => {
    const owner = await signIn(browser, "reader-owner");
    const { page } = owner;
    const id = await createDocument(page, CONTENT, "Reader Title");
    await openDocument(page, id);

    await page.getByTestId("more-menu").click();
    const popupPromise = page.waitForEvent("popup");
    await page.getByTestId("menu-reader").click();
    const reader = await popupPromise;
    await reader.waitForURL(new RegExp(`/p/${id}$`));
    await expect(reader.getByTestId("reader-title")).toHaveText("Reader Title");
    await reader.close();

    await page.getByTestId("share-button").click();
    await expect(page.getByTestId("reader-link")).toHaveCount(0);
    await page.getByTestId("link-access").selectOption("view");
    await expect(page.getByTestId("reader-link")).toContainText(`/p/${id}`);
    await expect(page.getByTestId("copy-reader-link")).toBeVisible();
    await expect(page.getByTestId("copy-link")).toBeVisible();
    await page.keyboard.press("Escape");
    await owner.context.close();
  });

  // #2203: the stuck-open bug only ever hit a real, trusted mouse click. A capture-phase click
  // listener on the document stages a one-shot admission token and queues a microtask to clear it;
  // that microtask always runs - clearing the token - before Radix's separately-scheduled click
  // handling gets around to dispatching its own "menu.itemSelect" event, so the old close path's
  // admission check always saw a cleared token. Enter doesn't hit this: Radix drives it by calling
  // the item's `.click()` from script, which runs the whole chain, including "menu.itemSelect",
  // synchronously in one task, ahead of the queued microtask - so Enter already worked on main.
  // This test proves that Enter keeps working with the new direct-close handler: focus the item,
  // press Enter, and check the reader opens, the menu is actually gone, and the very next click (on
  // Share) lands on the first try rather than being swallowed by a stuck menu.
  test("keyboard Enter on header menu's Open reader view opens the reader, closes the menu, and the next click lands", async ({
    browser,
  }) => {
    const owner = await signIn(browser, "reader-kbd");
    const { page } = owner;
    const id = await createDocument(page, CONTENT, "Reader Title");
    await openDocument(page, id);

    await page.getByTestId("more-menu").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.getByTestId("menu-reader").focus();
    const popupPromise = page.waitForEvent("popup");
    await page.keyboard.press("Enter");
    const reader = await popupPromise;
    await reader.waitForURL(new RegExp(`/p/${id}$`));
    await expect(reader.getByTestId("reader-title")).toHaveText("Reader Title");
    await reader.close();

    await expect(page.getByRole("menu")).toHaveCount(0);

    // The next click must land on the first try - a stuck-open menu would swallow it instead.
    await page.getByTestId("share-button").click();
    await expect(page.getByTestId("copy-link")).toBeVisible();
    await page.keyboard.press("Escape");
    await owner.context.close();
  });

  test("anonymous reader can dismiss one update and refresh on the next", async ({ browser }) => {
    const owner = await signIn(browser, "reader-owner");
    const id = await createDocument(owner.page, CONTENT, "Reader Title");
    await setLinkAccess(owner.page, id, "view");

    const anon = await browser.newContext();
    const page = await anon.newPage();
    await page.goto(`/p/${id}`);
    await expect(page.getByTestId("reader-title")).toHaveText("Reader Title");
    await expect(page.getByTestId("reader-updated")).toHaveCount(0);

    await openDocument(owner.page, id);
    await focusCodeEnd(owner.page);
    await owner.page.keyboard.type("\nA new closing line.");
    await expect.poll(() => codeText(owner.page)).toContain("A new closing line.");

    // The dev server runs with READER_POLL_MS=2000 (playwright.config.ts); the pill shows within 35 s regardless.
    await expect(page.getByTestId("reader-updated")).toBeVisible({ timeout: 35_000 });
    await page.getByRole("button", { name: "Dismiss update notice" }).click();
    await expect(page.getByTestId("reader-updated")).toHaveCount(0);
    await expect(page.getByTestId("reader-body")).not.toContainText("A new closing line.");

    await owner.page.keyboard.type("\nA later closing line.");
    await expect.poll(() => codeText(owner.page)).toContain("A later closing line.");

    await expect(page.getByTestId("reader-updated")).toBeVisible({ timeout: 35_000 });
    await page.getByRole("button", { name: /Updated.*Refresh/ }).click();
    await expect(page.getByTestId("reader-body")).toContainText("A new closing line.");
    await expect(page.getByTestId("reader-body")).toContainText("A later closing line.");
    await expect(page.getByTestId("reader-updated")).toHaveCount(0);

    await anon.close();
    await owner.context.close();
  });
});

test.describe("local reader TOC keyboard verification", () => {
  test.skip(
    process.env.E2E_READER_TOC_KEYBOARD !== "1",
    "Opt-in selector for the shared local browser slot",
  );

  test("trusted arrow, Home, End, Enter, and Escape keys preserve native TOC behavior", async ({ browser }) => {
    const owner = await signIn(browser, "reader-toc-keyboard-owner");
    const id = await createDocument(owner.page, CONTENT, "Reader Title");
    await setLinkAccess(owner.page, id, "view");

    const anon = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await anon.newPage();
    await page.goto(`/p/${id}`);
    await page.waitForLoadState("networkidle");

    const toggle = page.getByTestId("reader-toc-toggle");
    const list = page.locator("#reader-toc-list");
    const entries = page.getByTestId("reader-toc-entry");
    await expect(toggle).toBeVisible();
    await expect(entries).toHaveCount(2);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(list).toBeVisible();

    const focusedIndex = () =>
      entries.evaluateAll((links) => links.findIndex((link) => link === document.activeElement));
    const pressAndExpect = async (
      from: import("@playwright/test").Locator,
      key: "ArrowDown" | "ArrowUp" | "Home" | "End",
      expectedIndex: number,
    ) => {
      await from.focus();
      const before = await page.evaluate(() => ({
        hash: location.hash,
        scrollX,
        scrollY,
        current: Array.from(
          document.querySelectorAll<HTMLAnchorElement>('[data-testid="reader-toc-entry"]'),
          (link) => link.getAttribute("aria-current"),
        ),
      }));
      await page.evaluate(() => {
        const runtime = window as typeof window & {
          __readerTocKey?: { focus: number; key: string; trusted: boolean; ownerView: boolean };
        };
        runtime.__readerTocKey = { focus: 0, key: "", trusted: false, ownerView: false };
        const nav = document.querySelector<HTMLElement>('[data-testid="reader-toc"]')!;
        nav.addEventListener("keydown", (event) => {
          const keyboard = event as KeyboardEvent;
          runtime.__readerTocKey!.key = keyboard.key;
          runtime.__readerTocKey!.trusted = keyboard.isTrusted;
          runtime.__readerTocKey!.ownerView = keyboard.view === window;
        }, { capture: true, once: true });
        nav.addEventListener("focusin", () => {
          runtime.__readerTocKey!.focus += 1;
        }, { once: true });
      });

      await page.keyboard.press(key);

      await expect.poll(focusedIndex).toBe(expectedIndex);
      expect(await page.evaluate(() => (
        window as typeof window & {
          __readerTocKey: { focus: number; key: string; trusted: boolean; ownerView: boolean };
        }
      ).__readerTocKey)).toEqual({
        focus: 1,
        key,
        trusted: true,
        ownerView: true,
      });
      expect(await page.evaluate(() => ({
        hash: location.hash,
        scrollX,
        scrollY,
        current: Array.from(
          document.querySelectorAll<HTMLAnchorElement>('[data-testid="reader-toc-entry"]'),
          (link) => link.getAttribute("aria-current"),
        ),
      }))).toEqual(before);
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(list).toBeVisible();
    };

    const activeIndex = await entries.evaluateAll((links) =>
      links.findIndex((link) => link.getAttribute("aria-current") === "location"));
    await pressAndExpect(toggle, "ArrowDown", activeIndex >= 0 ? activeIndex : 0);
    await pressAndExpect(entries.nth(1), "ArrowDown", 0);
    await pressAndExpect(entries.nth(0), "ArrowUp", 1);
    await pressAndExpect(entries.nth(1), "Home", 0);
    await pressAndExpect(entries.nth(0), "End", 1);
    await pressAndExpect(toggle, "ArrowUp", activeIndex >= 0 ? activeIndex : 1);

    await entries.nth(1).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/p/${id}#second-section$`));
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(list).toBeHidden();

    await toggle.click();
    await entries.nth(0).focus();
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(list).toBeHidden();
    await expect(toggle).toBeFocused();

    await anon.close();
    await owner.context.close();
  });
});
