import { expect, test } from "./fixtures";
import {
  createDocument,
  devLogin,
  openDocument,
  shareWith,
  uniqueLogin,
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
      externalRequests += 1;
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
