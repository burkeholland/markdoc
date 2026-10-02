import { expect, test } from "./fixtures";
import {
  createDocument,
  devLogin,
  openDocument,
  shareWith,
  signIn,
  uniqueLogin,
  type User,
} from "./helpers";
import type { Route } from "@playwright/test";

test.use({ trace: "off", screenshot: "off", video: "off" });
test.describe.configure({ retries: 0 });

test("notification bell browses trusted keys without scrolling or activating", async ({
  browser,
}) => {
  const recipientContext = await browser.newContext({ serviceWorkers: "block" });
  const senderContext = await browser.newContext({ serviceWorkers: "block" });
  const recipient = await recipientContext.newPage();
  const sender = await senderContext.newPage();
  let externalRequests = 0;
  let popups = 0;
  let downloads = 0;
  const guardTraffic = async (route: Route) => {
    const url = new URL(route.request().url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    ) {
      // The development login gives each user a GitHub avatar URL (src/auth.ts) that the header loads on
      // every page. The keys did not cause that request, so it is blocked like the rest but not counted.
      if (url.hostname !== "avatars.githubusercontent.com") externalRequests += 1;
      await route.abort();
      return;
    }
    await route.continue();
  };
  await recipientContext.route("**/*", guardTraffic);
  await senderContext.route("**/*", guardTraffic);
  recipientContext.on("page", (page) => {
    if (page !== recipient) popups += 1;
  });
  recipient.on("download", () => {
    downloads += 1;
  });

  try {
    const recipientLogin = uniqueLogin("bell-keyboard-recipient");
    const senderLogin = uniqueLogin("bell-keyboard-sender");
    await devLogin(recipient, recipientLogin);
    await devLogin(sender, senderLogin);
    await Promise.all([
      recipient.waitForLoadState("networkidle"),
      sender.waitForLoadState("networkidle"),
    ]);
    await recipient.request.post("/api/notifications/read-all");

    const documentIds: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const documentId = await createDocument(
        sender,
        `# Keyboard notification ${index + 1}\n`,
        `Keyboard notification ${index + 1}`,
      );
      documentIds.push(documentId);
      await shareWith(sender, documentId, recipientLogin, "viewer");
    }

    await openDocument(recipient, documentIds[0]);
    await expect
      .poll(async () => {
        const response = await recipient.request.get("/api/notifications?unread=1");
        return ((await response.json()) as { unreadCount: number }).unreadCount;
      })
      .toBe(documentIds.length);
    await recipient.evaluate(() =>
      (
        window as unknown as {
          __markdocNotificationsRefresh?: () => Promise<void>;
        }
      ).__markdocNotificationsRefresh?.(),
    );

    const bell = recipient.getByTestId("notifications-bell");
    await expect(bell).toHaveAttribute("data-unread", String(documentIds.length));
    await bell.click();
    const popover = recipient.getByTestId("notifications-popover");
    const list = popover.getByRole("list", { name: "Notifications" });
    const rows = popover.getByTestId("notification-item");
    await expect(rows).toHaveCount(documentIds.length);
    await rows.first().focus();
    await list.evaluate((element) => {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    });
    const initialUrl = recipient.url();
    const initialOffsets = await list.evaluate((element) => ({
      listTop: element.scrollTop,
      listLeft: element.scrollLeft,
      documentTop: document.documentElement.scrollTop,
      documentLeft: document.documentElement.scrollLeft,
      bodyTop: document.body.scrollTop,
      bodyLeft: document.body.scrollLeft,
      windowX: window.scrollX,
      windowY: window.scrollY,
    }));

    for (const [key, index] of [
      ["ArrowDown", 1],
      ["ArrowUp", 0],
      ["ArrowUp", 7],
      ["ArrowDown", 0],
      ["End", 7],
      ["Home", 0],
    ] as const) {
      await recipient.keyboard.press(key);
      await expect(rows.nth(index)).toBeFocused();
      await expect
        .poll(() =>
          list.evaluate((element) => ({
            listTop: element.scrollTop,
            listLeft: element.scrollLeft,
            documentTop: document.documentElement.scrollTop,
            documentLeft: document.documentElement.scrollLeft,
            bodyTop: document.body.scrollTop,
            bodyLeft: document.body.scrollLeft,
            windowX: window.scrollX,
            windowY: window.scrollY,
          })),
        )
        .toEqual(initialOffsets);
    }

    await expect(popover).toBeVisible();
    expect(recipient.url()).toBe(initialUrl);
    expect(
      (
        (await (
          await recipient.request.get("/api/notifications?unread=1")
        ).json()) as { unreadCount: number }
      ).unreadCount,
    ).toBe(documentIds.length);

    const destinationId = await rows.first().getAttribute("data-document-id");
    await recipient.keyboard.press("Enter");
    await expect(popover).toHaveCount(0);
    await expect(recipient).toHaveURL(new RegExp(`/d/${destinationId}$`));
    await expect
      .poll(async () => {
        const response = await recipient.request.get("/api/notifications?unread=1");
        return ((await response.json()) as { unreadCount: number }).unreadCount;
      })
      .toBe(documentIds.length - 1);
    expect({ externalRequests, popups, downloads }).toEqual({
      externalRequests: 0,
      popups: 0,
      downloads: 0,
    });
  } finally {
    await Promise.all([recipientContext.close(), senderContext.close()]);
  }
});

test.describe("notification bell with real input (#2225)", () => {
  let sender: User;
  let recipient: User;

  const unreadCount = async () => {
    const response = await recipient.page.request.get("/api/notifications?unread=1");
    return ((await response.json()) as { unreadCount: number }).unreadCount;
  };
  /** Shares a new document with the recipient and waits until their bell shows it. */
  const shareNew = async (title: string, unread: number) => {
    const id = await createDocument(sender.page, `# ${title}\n`, title);
    await shareWith(sender.page, id, recipient.login, "viewer");
    await expect.poll(unreadCount).toBe(unread);
    await recipient.page.evaluate(() =>
      (window as unknown as { __markdocNotificationsRefresh?: () => Promise<void> }).__markdocNotificationsRefresh?.(),
    );
    await expect(recipient.page.getByTestId("notifications-bell")).toHaveAttribute("data-unread", String(unread));
    return id;
  };
  /** Where focus is, read two frames later so a browser that drops focus from a disabled button has done so. */
  const focusPlace = () =>
    recipient.page.evaluate(
      () =>
        new Promise<string>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const active = document.activeElement;
              const popover = document.querySelector('[data-testid="notifications-popover"]');
              resolve(active === document.body ? "body" : popover?.contains(active) ? "popover" : "elsewhere");
            }),
          ),
        ),
    );

  test.beforeEach(async ({ browser }) => {
    sender = await signIn(browser, uniqueLogin("bell-input-sender"));
    recipient = await signIn(browser, uniqueLogin("bell-input-recipient"));
    const own = await createDocument(recipient.page, "# My notes\n", "My notes");
    await openDocument(recipient.page, own);
  });

  test.afterEach(async () => {
    await Promise.all([sender.context.close(), recipient.context.close()]);
  });

  test("a share notification opens from the bell with the keyboard and is marked read", async () => {
    const page = recipient.page;
    const older = await shareNew("Keyboard share one", 1);
    const newer = await shareNew("Keyboard share two", 2);
    const bell = page.getByTestId("notifications-bell");
    const rows = page.getByTestId("notifications-popover").getByTestId("notification-item");

    // Real keys only: ArrowDown on the bell opens it on the first row, ArrowDown moves on, Enter opens that row.
    await bell.focus();
    await page.keyboard.press("ArrowDown");
    await expect(rows.first()).toBeFocused();
    await expect(rows.first()).toHaveAttribute("data-document-id", newer);
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
    await expect(rows.nth(1)).toHaveAttribute("data-document-id", older);
    await page.keyboard.press("Enter");

    await page.waitForURL(`**/d/${older}`);
    await expect.poll(unreadCount).toBe(1);
  });

  test("Mark all read keeps focus in the popover, so Escape closes it and the bell opens again", async () => {
    const page = recipient.page;
    const bell = page.getByTestId("notifications-bell");
    const popover = page.getByTestId("notifications-popover");
    const readAll = popover.getByTestId("notifications-read-all");

    // With the mouse: the clicked button disables itself while it has focus.
    await shareNew("Focus share one", 1);
    await bell.click();
    await readAll.click();
    await expect(readAll).toBeDisabled();
    await expect.poll(unreadCount).toBe(0);
    expect(await focusPlace()).toBe("popover");
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(bell).toBeFocused();

    // With the keyboard: Enter opens the bell on the first row, End and Tab reach Mark all read, Enter presses it.
    const shared = await shareNew("Focus share two", 1);
    await page.keyboard.press("Enter");
    await expect(popover.getByTestId("notification-item").first()).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.press("Tab");
    await expect(readAll).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(readAll).toBeDisabled();
    await expect.poll(unreadCount).toBe(0);
    expect(await focusPlace()).toBe("popover");
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(bell).toBeFocused();

    // The bell was really closed: one more press opens it, and the row still opens its document.
    await page.keyboard.press("Enter");
    const first = popover.getByTestId("notification-item").first();
    await expect(first).toBeFocused();
    await expect(first).toHaveAttribute("data-document-id", shared);
    await page.keyboard.press("Enter");
    await page.waitForURL(`**/d/${shared}`);
  });

  // A held key repeats its keydown. A row closes the popover and focus returns to the bell, so the
  // repeats used to open the bell again and then its first row.
  test("a held Enter is one press: the bell opens without opening a row, and a row opens alone", async () => {
    const page = recipient.page;
    const bell = page.getByTestId("notifications-bell");
    const popover = page.getByTestId("notifications-popover");
    const rows = popover.getByTestId("notification-item");
    const holdEnter = async () => {
      for (let repeats = 0; repeats < 10; repeats += 1) {
        await page.keyboard.down("Enter");
        await page.waitForTimeout(35);
      }
      await page.keyboard.up("Enter");
    };

    // Three replies in the open document, one thread each, so opening one leaves the others unread.
    const words = ["Alpha", "Bravo", "Charlie"];
    const docId = await createDocument(page, `# Held keys\n\n${words.map((word) => `${word} paragraph.`).join("\n\n")}\n`, "Held keys");
    await shareWith(page, docId, sender.login, "editor");
    for (const word of words) {
      const added = await page.request.post(`/api/documents/${docId}/comments`, { data: { action: "add", quote: `${word} paragraph`, body: `Thread on ${word}` } });
      expect(added.ok()).toBeTruthy();
      const thread = (await added.json()) as { id?: string; threadId?: string };
      const replied = await sender.page.request.post(`/api/documents/${docId}/comments`, { data: { action: "reply", threadId: thread.threadId ?? thread.id, body: `Reply on ${word}` } });
      expect(replied.ok()).toBeTruthy();
    }
    await expect.poll(unreadCount).toBe(3);
    await openDocument(page, docId);
    await expect(bell).toHaveAttribute("data-unread", "3");
    const reads: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && /^\/api\/notifications\/(read-all|[^/]+\/read)$/.test(path)) reads.push(path);
    });

    await bell.focus();
    await holdEnter();
    await expect(popover).toBeVisible();
    await expect(rows.first()).toBeFocused();
    expect(reads).toEqual([]);

    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
    const held = await rows.nth(1).getAttribute("data-notification-id");
    await holdEnter();
    await expect(popover).toHaveCount(0);
    await expect.poll(unreadCount).toBe(2);
    expect(reads).toEqual([`/api/notifications/${held}/read`]);
    expect(new URL(page.url()).pathname).toBe(`/d/${docId}`);
    await expect(popover).toHaveCount(0);
  });
});
