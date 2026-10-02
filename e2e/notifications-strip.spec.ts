import { expect, test } from "./fixtures";
import { createDocument, shareWith, signIn, uniqueLogin, waitForHydration, type User } from "./helpers";

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
});
