import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createDocument, shareWith, signIn, uniqueLogin, waitForEditor, waitForHydration, type User } from "./helpers";

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
  const openDashboard = async (rows: number) => {
    await recipient.page.goto("/");
    await waitForHydration(recipient.page);
    const strip = recipient.page.getByTestId("notifications-strip");
    await expect(strip.getByTestId("notification-item")).toHaveCount(rows);
    return strip;
  };
  /** Paths of the mark-read requests the recipient's page sends from now on. */
  const watchReads = () => {
    const reads: string[] = [];
    recipient.page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && /^\/api\/notifications\/(read-all|[^/]+\/read)$/.test(path)) reads.push(path);
    });
    return reads;
  };
  const centre = async (target: Locator) => {
    const box = await target.boundingBox();
    if (!box) throw new Error("the target has no box");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
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
});
