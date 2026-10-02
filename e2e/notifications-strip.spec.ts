import type { Browser, Locator, Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createDocument, devLogin, reloadHydrated, shareWith, signIn, uniqueLogin, waitForEditor, waitForHydration, type User } from "./helpers";

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 1024, height: 768 };
const DESKTOP = { width: 1440, height: 1000 };
const isDocument = (url: URL) => url.pathname.startsWith("/d/");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The dashboard strip with a real mouse and real keys (#2225): every click and key used to be dropped.
test.describe("dashboard notification strip with real input", () => {
  let sender: User;
  let recipient: User;

  const unreadCount = async () => {
    const response = await recipient.page.request.get("/api/notifications?unread=1");
    return ((await response.json()) as { unreadCount: number }).unreadCount;
  };
  /** Shares `count` new documents with the recipient, oldest first, and returns their ids. */
  const shareNew = async (count: number) => {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const title = `Strip share ${index + 1}`;
      const id = await createDocument(sender.page, `# ${title}\n`, title);
      await shareWith(sender.page, id, recipient.login, "viewer");
      ids.push(id);
    }
    await expect.poll(unreadCount).toBe(count);
    return ids;
  };
  const openDashboard = async (rows: number, page: Page = recipient.page) => {
    await page.goto("/");
    await waitForHydration(page);
    const strip = page.getByTestId("notifications-strip");
    await expect(strip.getByTestId("notification-item")).toHaveCount(rows);
    return strip;
  };
  /** Paths of the mark-read requests the recipient's page sends from now on. */
  const watchReads = (page: Page = recipient.page) => {
    const reads: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && /^\/api\/notifications\/(read-all|[^/]+\/read)$/.test(path)) reads.push(path);
    });
    return reads;
  };
  const boxOf = async (target: Locator) => {
    const box = await target.boundingBox();
    if (!box) throw new Error("the target has no box");
    return box;
  };
  /** The point at `fraction` of the target's width and half its height. */
  const pointAt = async (target: Locator, fraction: number) => {
    const box = await boxOf(target);
    return { x: box.x + box.width * fraction, y: box.y + box.height / 2 };
  };
  const centre = (target: Locator) => pointAt(target, 0.5);
  /** Presses Tab until the target has focus, as a keyboard user would reach it. */
  const tabTo = async (target: Locator) => {
    for (let presses = 0; presses < 20; presses += 1) {
      await recipient.page.keyboard.press("Tab");
      if (await target.evaluate((element) => element === document.activeElement)) return;
    }
    throw new Error("Tab never reached the target");
  };

  test.beforeEach(async ({ browser }) => {
    sender = await signIn(browser, uniqueLogin("strip-sender"));
    recipient = await signIn(browser, uniqueLogin("strip-recipient"));
  });

  test.afterEach(async () => {
    await Promise.all([sender.context.close(), recipient.context.close()]);
  });

  test("a share notification opens with a click and is marked read", async () => {
    const [shared] = await shareNew(1);
    const strip = await openDashboard(1);
    await expect(strip.getByTestId("notification-item")).toHaveAttribute("data-kind", "share");

    await strip.getByTestId("notification-open").click();

    await recipient.page.waitForURL(`**/d/${shared}`);
    await expect.poll(unreadCount).toBe(0);
  });

  test("the arrow keys move between rows and Enter opens the focused one", async () => {
    const [older, newer] = await shareNew(2);
    const strip = await openDashboard(2);
    const controls = strip.getByTestId("notification-open");
    await expect(controls.first()).toContainText("Strip share 2");

    await controls.first().focus();
    await recipient.page.keyboard.press("ArrowDown");
    await expect(controls.nth(1)).toBeFocused();
    await recipient.page.keyboard.press("ArrowDown");
    await expect(controls.first()).toBeFocused();
    await recipient.page.keyboard.press("End");
    await expect(controls.nth(1)).toBeFocused();
    await recipient.page.keyboard.press("ArrowRight");
    await expect(strip.getByTestId("notification-dismiss").nth(1)).toBeFocused();
    await recipient.page.keyboard.press("ArrowLeft");
    await expect(controls.nth(1)).toBeFocused();
    expect(await unreadCount()).toBe(2);
    await recipient.page.keyboard.press("Enter");

    await recipient.page.waitForURL(`**/d/${older}`);
    await expect.poll(unreadCount).toBe(1);
    const remaining = await openDashboard(1);
    await expect(remaining.getByTestId("notification-open")).toContainText("Strip share 2");
    await remaining.getByTestId("notification-open").focus();
    await recipient.page.keyboard.press("Space");
    await recipient.page.waitForURL(`**/d/${newer}`);
    await expect.poll(unreadCount).toBe(0);
  });

  test("Mark as read, Delete and Mark all read clear rows without leaving the dashboard", async () => {
    await shareNew(4);
    const strip = await openDashboard(4);
    const rows = strip.getByTestId("notification-item");

    await strip.getByTestId("notification-dismiss").first().click();
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText("Strip share 3");
    await expect.poll(unreadCount).toBe(3);

    // Delete marks the focused row read and focus moves to the next one, so the key can be pressed again.
    const controls = strip.getByTestId("notification-open");
    await controls.first().focus();
    await recipient.page.keyboard.press("Delete");
    await expect(rows).toHaveCount(2);
    await expect(controls.first()).toContainText("Strip share 2");
    await expect(controls.first()).toBeFocused();
    await recipient.page.keyboard.press("Delete");
    await expect(rows).toHaveCount(1);
    await expect(controls.first()).toContainText("Strip share 1");
    await expect(controls.first()).toBeFocused();
    await expect.poll(unreadCount).toBe(1);

    await strip.getByTestId("notifications-strip-read-all").click();
    await expect(strip).toHaveCount(0);
    await expect.poll(unreadCount).toBe(0);
    expect(new URL(recipient.page.url()).pathname).toBe("/");
  });

  // The first click takes the row away and the next row moves up under the pointer, so the rest of the
  // gesture must not act on that row.
  test("a double-click or a triple-click on a row opens only that row's document", async () => {
    const page = recipient.page;
    const shared = await shareNew(4);
    const reads = watchReads();
    const gestures: [string, (x: number, y: number) => Promise<void>][] = [
      ["a double-click", (x, y) => page.mouse.dblclick(x, y)],
      [
        "two clicks 120 ms apart",
        async (x, y) => {
          await page.mouse.click(x, y);
          await page.waitForTimeout(120);
          await page.mouse.click(x, y);
        },
      ],
      ["a triple-click", (x, y) => page.mouse.click(x, y, { clickCount: 3 })],
    ];

    for (const [index, [name, gesture]] of gestures.entries()) {
      const strip = await openDashboard(4 - index);
      const row = strip.getByTestId("notification-item").first();
      const id = await row.getAttribute("data-notification-id");
      const { x, y } = await centre(row.getByTestId("notification-open"));
      reads.length = 0;

      await gesture(x, y);

      await page.waitForURL(/\/d\//);
      await waitForEditor(page);
      expect(reads, name).toEqual([`/api/notifications/${id}/read`]);
      expect(new URL(page.url()).pathname, name).toBe(`/d/${shared[3 - index]}`);
      await expect.poll(unreadCount, name).toBe(3 - index);
    }
  });

  test("a double-click on Mark as read takes one row away, and two separate clicks take two", async () => {
    const page = recipient.page;
    await shareNew(4);
    const strip = await openDashboard(4);
    const rows = strip.getByTestId("notification-item");
    const first = await rows.first().getAttribute("data-notification-id");
    const { x, y } = await centre(strip.getByTestId("notification-dismiss").first());
    const reads = watchReads();

    await page.mouse.dblclick(x, y);
    await expect.poll(unreadCount).toBe(3);
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText("Strip share 3");
    expect(reads).toEqual([`/api/notifications/${first}/read`]);

    // Two deliberate clicks are two clicks: each takes the row under it.
    await page.waitForTimeout(700);
    await page.mouse.click(x, y);
    await expect(rows).toHaveCount(2);
    await page.waitForTimeout(700);
    await page.mouse.click(x, y);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Strip share 1");
    await expect.poll(unreadCount).toBe(1);
    expect(new URL(page.url()).pathname).toBe("/");
  });

  // A held key repeats its keydown. Mark as read moves focus to the next row, so the repeats used to
  // open that row.
  test("a held Enter on Mark as read takes one row away and opens nothing", async () => {
    const page = recipient.page;
    await shareNew(3);
    const strip = await openDashboard(3);
    const rows = strip.getByTestId("notification-item");
    const first = await rows.first().getAttribute("data-notification-id");
    await tabTo(strip.getByTestId("notification-open").first());
    await page.keyboard.press("ArrowRight");
    await expect(strip.getByTestId("notification-dismiss").first()).toBeFocused();
    const reads = watchReads();

    for (let repeats = 0; repeats < 10; repeats += 1) {
      await page.keyboard.down("Enter");
      await page.waitForTimeout(35);
    }
    await page.keyboard.up("Enter");

    await expect.poll(unreadCount).toBe(2);
    await expect(rows).toHaveCount(2);
    await expect(strip.getByTestId("notification-open").first()).toBeFocused();
    expect(reads).toEqual([`/api/notifications/${first}/read`]);
    expect(new URL(page.url()).pathname).toBe("/");
  });

  // Emptying the strip removes the control that had focus. Focus goes to a status line in the strip's
  // place, never to <body>, and the next Tab carries on from where the strip was.
  test("when the last row leaves, focus moves to a status line and Tab carries on from there", async () => {
    const page = recipient.page;
    const status = page.getByTestId("notifications-strip-status");
    const handedOff = async (next: "Tab" | "Shift+Tab") => {
      await expect(page.getByTestId("notifications-strip")).toHaveCount(0);
      await expect(status).toBeFocused();
      await expect(status).toHaveText("No unread notifications");
      await expect(status).toHaveAttribute("role", "status");
      await page.keyboard.press(next);
      await expect(next === "Tab" ? page.getByTestId("new-document") : page.getByRole("button", { name: "Account" })).toBeFocused();
      await expect(status).toHaveCount(0);
    };

    await shareNew(1);
    let strip = await openDashboard(1);
    await tabTo(strip.getByTestId("notification-open"));
    await page.keyboard.press("Delete");
    await handedOff("Tab");

    await shareNew(1);
    strip = await openDashboard(1);
    await tabTo(strip.getByTestId("notification-open"));
    await page.keyboard.press("ArrowRight");
    await expect(strip.getByTestId("notification-dismiss")).toBeFocused();
    await page.keyboard.press("Enter");
    await handedOff("Shift+Tab");

    await shareNew(2);
    strip = await openDashboard(2);
    await tabTo(strip.getByTestId("notifications-strip-read-all"));
    await page.keyboard.press("Enter");
    await handedOff("Tab");

    await shareNew(1);
    strip = await openDashboard(1);
    const { x, y } = await centre(strip.getByTestId("notification-dismiss"));
    await page.mouse.click(x, y);
    await handedOff("Shift+Tab");
    await expect.poll(unreadCount).toBe(0);

    // The strip empties in the background while focus is elsewhere: focus stays where the user put it.
    await shareNew(1);
    await openDashboard(1);
    const search = page.getByTestId("search");
    await search.click();
    await page.request.post("/api/notifications/read-all");
    await page.evaluate(() => (window as unknown as { __markdocNotificationsRefresh?: () => Promise<void> }).__markdocNotificationsRefresh?.());
    await expect(page.getByTestId("notifications-strip")).toHaveCount(0);
    await expect(status).toHaveCount(0);
    await expect(search).toBeFocused();
  });

  // Nothing may move under the pointer because of the strip. A row that is opened leaves the list, and
  // the last row takes the strip with it, so the dashboard used to move up at once: the second click of
  // a double-click, or a second tap, landed on "New document" or on one of the buttons next to it.

  const documentCount = async () => {
    const response = await recipient.page.request.get("/api/documents");
    return ((await response.json()) as { documents: unknown[] }).documents.length;
  };
  /** What a stray click on the dashboard does. The returned check fails if any of it happened since this call. */
  const watchStrayClicks = async (page: Page) => {
    const documents = await documentCount();
    let choosers = 0;
    page.on("filechooser", () => {
      choosers += 1;
    });
    return async () => {
      expect(choosers, "file choosers opened").toBe(0);
      await expect(page.locator('[role="dialog"], [role="alertdialog"]')).toHaveCount(0);
      expect(await documentCount(), "documents the recipient has").toBe(documents);
    };
  };
  /** Makes every document page take `delay` ms longer, so the dashboard is still there after a gesture. */
  const slowDocuments = (page: Page, delay: number) =>
    page.route(isDocument, async (route) => {
      await sleep(delay);
      await route.continue().catch(() => {});
    });
  /** A page of the recipient on a touch screen. */
  const touchPage = async (browser: Browser, viewport: { width: number; height: number }) => {
    const phone = viewport.width < 500;
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: phone, deviceScaleFactor: phone ? 3 : 1 });
    const page = await context.newPage();
    await devLogin(page, recipient.login);
    return page;
  };
  const doubleClick = (page: Page) => (x: number, y: number) => page.mouse.dblclick(x, y);
  const doubleTap = (page: Page) => async (x: number, y: number) => {
    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x, y);
  };
  const clickAgainAfter = (page: Page, pause: number) => async (x: number, y: number) => {
    await page.mouse.click(x, y);
    await page.waitForTimeout(pause);
    await page.mouse.click(x, y);
  };

  /**
   * The gesture on the only row, at `fraction` of its width, while its document takes `delay` ms: the
   * strip and the dashboard under it stay where they were, then that document opens, with one read
   * request and nothing else done.
   */
  const expectOnlyRowOpens = async (page: Page, fraction: number, delay: number, gesture: (x: number, y: number) => Promise<void>) => {
    const [shared] = await shareNew(1);
    const strip = await openDashboard(1, page);
    const row = strip.getByTestId("notification-item");
    const id = await row.getAttribute("data-notification-id");
    const below = page.getByTestId("new-document");
    const before = { strip: await boxOf(strip), below: await boxOf(below) };
    const { x, y } = await pointAt(row.getByTestId("notification-open"), fraction);
    const nothingElse = await watchStrayClicks(page);
    const reads = watchReads(page);
    await slowDocuments(page, delay);

    await gesture(x, y);

    expect(new URL(page.url()).pathname).toBe("/");
    expect(await row.count()).toBe(1);
    expect({ strip: await boxOf(strip), below: await boxOf(below) }).toEqual(before);
    await page.waitForURL(`**/d/${shared}`, { timeout: 30_000 });
    await waitForEditor(page);
    expect(reads).toEqual([`/api/notifications/${id}/read`]);
    await nothingElse();
    expect(new URL(page.url()).pathname).toBe(`/d/${shared}`);
    await expect.poll(unreadCount).toBe(0);
  };

  for (const viewport of [PHONE, DESKTOP]) {
    for (const percent of [10, 50]) {
      test(`a double-click on the only row at ${percent} percent of its width opens its document and nothing else, at ${viewport.width} px`, async () => {
        await recipient.page.setViewportSize(viewport);
        await expectOnlyRowOpens(recipient.page, percent / 100, 1_500, doubleClick(recipient.page));
      });
    }
  }

  for (const viewport of [PHONE, TABLET]) {
    test(`a double tap on the only row opens its document and nothing else, at ${viewport.width} px`, async ({ browser }) => {
      const page = await touchPage(browser, viewport);
      await expectOnlyRowOpens(page, 0.2, 1_500, doubleTap(page));
    });
  }

  // On a slow network the page changes long after the click. Until it does, a later click is no
  // different from the second click of a double-click.
  for (const pause of [600, 2_000]) {
    test(`a second click ${pause} ms later, while the only row's document is still loading, does nothing`, async () => {
      await recipient.page.setViewportSize(PHONE);
      await expectOnlyRowOpens(recipient.page, 0.5, 3_000, clickAgainAfter(recipient.page, pause));
    });
  }

  // An ordinary slow open is a navigation inside the app: the browser loads no page, so nothing but the
  // new page itself ends the wait in the first 30 seconds.
  test("a document that takes 10 seconds holds the strip all that time, and a click after 9 seconds does nothing", async () => {
    test.setTimeout(150_000);
    const page = recipient.page;
    await page.setViewportSize(PHONE);
    type Marked = Window & { pageLoadStarted?: boolean };
    let shown = 0;

    await expectOnlyRowOpens(page, 0.5, 10_000, async (x, y) => {
      shown = await page.evaluate(() => {
        window.addEventListener("beforeunload", () => {
          (window as Marked).pageLoadStarted = true;
        });
        return performance.timeOrigin;
      });
      await clickAgainAfter(page, 9_000)(x, y);
    });

    // Still the same window, and the browser never started to load a page.
    expect(await page.evaluate(() => [performance.timeOrigin, (window as Marked).pageLoadStarted ?? false])).toEqual([shown, false]);
  });

  test("a row opened with the keyboard keeps the focus until its document is there", async () => {
    const page = recipient.page;
    const [shared] = await shareNew(1);
    const strip = await openDashboard(1);
    const open = strip.getByTestId("notification-open");
    const id = await strip.getByTestId("notification-item").getAttribute("data-notification-id");
    await tabTo(open);
    const reads = watchReads();
    await slowDocuments(page, 2_500);

    await page.keyboard.press("Enter");

    await expect(open).toBeFocused({ timeout: 1_000 });
    await page.waitForTimeout(1_000);
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(open).toBeFocused({ timeout: 1_000 });
    // A second press while it opens is not a second open.
    await page.keyboard.press("Enter");
    await page.waitForURL(`**/d/${shared}`);
    await waitForEditor(page);
    expect(reads).toEqual([`/api/notifications/${id}/read`]);
  });

  // The app router falls back to loading the document as a whole page when its own request fails. If the
  // user stops that load, the dashboard stays and nothing tells it, so the strip stops waiting by itself.
  //
  // The dashboard's prefetches of document pages are made to fail, as if there were none (the dev server
  // does none). With them, a production build's router navigates nowhere after such a stop, from a
  // document card as much as from the strip: that is #2249, and not the strip's to fix.
  test("after a page load that a row started is stopped, the other rows open again without a reload", async () => {
    const page = recipient.page;
    const shared = await shareNew(3);
    const isPrefetch = (route: Route) => Boolean(route.request().headers()["next-router-prefetch"]);
    await page.route(isDocument, (route) => (isPrefetch(route) ? route.abort("failed") : route.fallback()));
    const strip = await openDashboard(3);
    const rows = strip.getByTestId("notification-item");
    let hanging = true;
    let loadStarted = () => {};
    const pageLoad = new Promise<void>((resolve) => {
      loadStarted = resolve;
    });
    const failTheOpen = async (route: Route) => {
      if (isPrefetch(route)) return route.fallback();
      if (route.request().resourceType() === "fetch") return route.abort("failed");
      loadStarted();
      while (hanging) await sleep(100);
      await route.abort("aborted").catch(() => {});
    };
    await page.route(isDocument, failTheOpen);
    const first = await centre(rows.first().getByTestId("notification-open"));
    // Stop also cancels the requests of the page that is shown, so let the read request finish first.
    const read = page.waitForResponse((response) => /^\/api\/notifications\/[^/]+\/read$/.test(new URL(response.url()).pathname));
    await page.mouse.click(first.x, first.y);
    await Promise.all([pageLoad, read]);

    // The browser's Stop button. Script cannot do it: Playwright runs none while a page load is pending.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Page.stopLoading");
    hanging = false;
    await page.unroute(isDocument, failTheOpen);
    await cdp.detach();

    // The opened row is read. It leaves once the strip stops waiting for the page that never came.
    await expect(rows).toHaveCount(2, { timeout: 10_000 });
    expect(new URL(page.url()).pathname).toBe("/");
    const next = await centre(rows.first().getByTestId("notification-open"));
    await page.mouse.click(next.x, next.y);
    await page.waitForURL(`**/d/${shared[1]}`, { timeout: 15_000 });
    await expect.poll(unreadCount).toBe(1);
  });

  /**
   * The gesture on a control that empties the strip: the dashboard below stays where it was while the
   * gesture lasts, nothing on it is pressed, and then it takes the place a dashboard without a strip has.
   */
  const expectEmptiesInPlace = async (page: Page, rows: number, target: (strip: Locator) => Locator, edge: number | null, gesture: (x: number, y: number) => Promise<void>) => {
    await shareNew(rows);
    const strip = await openDashboard(rows, page);
    const below = page.getByTestId("new-document");
    const withStrip = await boxOf(below);
    const box = await boxOf(target(strip));
    const point = { x: edge === null ? box.x + box.width / 2 : box.x + edge, y: box.y + box.height / 2 };
    const nothingElse = await watchStrayClicks(page);
    const reads = watchReads(page);

    await gesture(point.x, point.y);

    expect(await boxOf(below)).toEqual(withStrip);
    await expect.poll(async () => (await boxOf(below)).y, { timeout: 5_000 }).toBeLessThan(withStrip.y);
    const settled = await boxOf(below);
    expect(reads).toHaveLength(1);
    await nothingElse();
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(strip).toHaveCount(0);
    await expect.poll(unreadCount).toBe(0);
    await reloadHydrated(page);
    expect(await boxOf(below)).toEqual(settled);
  };

  for (const input of ["double-click", "double tap"] as const) {
    test(`a ${input} on the first pixels of Mark all read presses nothing on the dashboard below, at 390 px`, async ({ browser }) => {
      const touch = input === "double tap";
      const page = touch ? await touchPage(browser, PHONE) : recipient.page;
      if (!touch) await page.setViewportSize(PHONE);
      await expectEmptiesInPlace(page, 3, (strip) => strip.getByTestId("notifications-strip-read-all"), 5, touch ? doubleTap(page) : doubleClick(page));
    });
  }

  for (const viewport of [PHONE, DESKTOP]) {
    test(`a double-click on Mark as read of the only row presses nothing on the dashboard below, at ${viewport.width} px`, async () => {
      await recipient.page.setViewportSize(viewport);
      await expectEmptiesInPlace(recipient.page, 1, (strip) => strip.getByTestId("notification-dismiss"), null, doubleClick(recipient.page));
    });
  }

  test("the place of an emptied strip closes by itself, takes no focus, and from the keyboard closes at once", async () => {
    const page = recipient.page;
    const below = page.getByTestId("new-document");
    const status = page.getByTestId("notifications-strip-status");
    await shareNew(2);
    let strip = await openDashboard(2);
    const withStrip = await boxOf(below);
    const { x, y } = await centre(strip.getByTestId("notifications-strip-read-all"));

    await page.mouse.click(x, y);

    await expect(status).toBeFocused();
    await expect(strip).toHaveCount(0);
    expect(await boxOf(below)).toEqual(withStrip);
    // The place is still held. Tab goes straight on to what follows the strip.
    await page.keyboard.press("Tab");
    await expect(below).toBeFocused();
    await expect(status).toHaveCount(0);
    await expect.poll(async () => (await boxOf(below)).y, { timeout: 5_000 }).toBeLessThan(withStrip.y);
    const settled = await boxOf(below);
    await expect(below).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Account" })).toBeFocused();
    await reloadHydrated(page);
    expect(await boxOf(below)).toEqual(settled);

    // The keyboard has no pointer to keep the place for.
    await shareNew(1);
    strip = await openDashboard(1);
    await tabTo(strip.getByTestId("notifications-strip-read-all"));
    await page.keyboard.press("Enter");
    await expect(status).toBeFocused();
    expect(await boxOf(below)).toEqual(settled);
  });
});
