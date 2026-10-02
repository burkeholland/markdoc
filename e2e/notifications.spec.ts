import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { signIn, createDocument, openDocument, shareWith, selectTextInRich, ensureCommentsOpen, focusRichEnd, uniqueLogin, type User } from "./helpers";

test.use({ screenshot: "off", trace: "off", video: "off" });

/** Pull the notifications store now instead of waiting for the 30 s poll. */
const refresh = (page: Page) =>
  page.evaluate(() => (window as unknown as { __markdocNotificationsRefresh?: () => Promise<void> }).__markdocNotificationsRefresh?.());

const unreadCount = async (page: Page) => {
  const res = await page.request.get("/api/notifications?unread=1");
  return ((await res.json()) as { unreadCount: number }).unreadCount;
};

test.describe("notifications", () => {
  let alice: User;
  let bob: User;
  let carol: User;
  let docId: string;

  test.beforeAll(async ({ browser }) => {
    // All three per run (computed once, here): unread counts, the badge and the dashboard strip are counted over
    // the whole account, so a fixed login shares them with other specs and with a previous run (--repeat-each).
    alice = await signIn(browser, uniqueLogin("alice"));
    bob = await signIn(browser, uniqueLogin("bob"));
    carol = await signIn(browser, uniqueLogin("carol"));
    await alice.page.request.post("/api/notifications/read-all");
    await bob.page.request.post("/api/notifications/read-all");
    await carol.page.request.post("/api/notifications/read-all");
    docId = await createDocument(alice.page, "# Notify doc\n\nFirst paragraph.\n\nSecond paragraph.\n", "Notify doc");
    await shareWith(alice.page, docId, bob.login, "editor");
    // Bob was just notified of the share; start the thread tests from a clean slate.
    await bob.page.request.post("/api/notifications/read-all");
    await openDocument(alice.page, docId);
    await openDocument(bob.page, docId);
  });

  test.afterAll(async () => {
    await alice.context.close();
    await bob.context.close();
    await carol.context.close();
  });

  test("a reply to my thread rings the bell; opening it lands on the thread and clears the badge", async () => {
    await selectTextInRich(alice.page, "First paragraph");
    await alice.page.getByTestId("tb-comment").click();
    await alice.page.getByTestId("comment-composer").fill("Can we expand this?");
    await alice.page.getByTestId("comment-submit").click();
    await expect(alice.page.getByTestId("comment-thread")).toHaveCount(1);
    // Close the panel so opening from the bell is observable.
    await alice.page.getByTestId("comments-toggle").click();
    await expect(alice.page.getByTestId("comments-panel")).toHaveCount(0);

    await ensureCommentsOpen(bob.page);
    await expect(bob.page.getByTestId("comment-thread")).toContainText("Can we expand this?");
    await bob.page.getByTestId("comment-reply").click();
    await bob.page.getByTestId("comment-composer").fill("Sure, on it.");
    await bob.page.getByTestId("comment-submit").click();
    await expect(alice.page.getByTestId("comment-thread")).toHaveCount(0); // panel still closed

    await expect.poll(() => unreadCount(alice.page)).toBe(1);
    await refresh(alice.page);
    const bell = alice.page.getByTestId("notifications-bell");
    await expect(bell).toHaveAttribute("data-unread", "1");
    await expect(alice.page.getByTestId("notifications-badge")).toHaveText("1");
    // The replier is never notified about his own reply.
    const bobItems = ((await (await bob.page.request.get("/api/notifications?unread=1")).json()) as { items: unknown[] }).items;
    expect(bobItems, JSON.stringify(bobItems)).toHaveLength(0);

    await bell.click();
    const popover = alice.page.getByTestId("notifications-popover");
    await expect(popover).toBeVisible();
    // Earlier (read) notifications from other specs may be listed too; the new one is first and the only unread one.
    await expect(popover.locator("[data-testid=notification-item][data-unread=true]")).toHaveCount(1);
    const item = popover.getByTestId("notification-item").first();
    await expect(item).toHaveAttribute("data-kind", "reply");
    await expect(item).toContainText(`${bob.login} replied to your comment`);
    await expect(item).toContainText("Sure, on it.");
    await expect(item.getByTestId("notification-unread-dot")).toBeVisible();
    if (process.env.SHOT_DIR) await alice.page.screenshot({ path: `${process.env.SHOT_DIR}/notifications-bell.png` });

    await item.click();
    await expect(popover).toHaveCount(0);
    await expect(alice.page.getByTestId("comments-panel")).toBeVisible();
    const thread = alice.page.getByTestId("comment-thread");
    await expect(thread).toHaveCount(1);
    await expect(thread).toHaveClass(/border-accent/);
    await expect(alice.page.getByTestId("notifications-badge")).toHaveCount(0);
    await expect.poll(() => unreadCount(alice.page)).toBe(0);
  });

  test("resolving my thread notifies me; the thread card carries an unread dot until opened", async () => {
    // Alice starts another thread (which becomes the active one) so the first is not active when the notification arrives.
    await selectTextInRich(alice.page, "Second paragraph");
    await alice.page.getByTestId("tb-comment").click();
    await alice.page.getByTestId("comment-composer").fill("Another note");
    await alice.page.getByTestId("comment-submit").click();
    await expect(alice.page.getByTestId("comment-thread")).toHaveCount(2);
    await alice.page.getByTestId("comments-toggle").click();
    await expect(alice.page.getByTestId("comments-panel")).toHaveCount(0);

    await expect(bob.page.getByTestId("comment-thread")).toHaveCount(2);
    await bob.page.getByTestId("comment-thread").filter({ hasText: "Can we expand this?" }).getByTestId("comment-resolve").click();
    await expect.poll(() => unreadCount(alice.page)).toBe(1);
    await refresh(alice.page);
    await expect(alice.page.getByTestId("notifications-badge")).toHaveText("1");
    // The first poll is deferred until the document is synced (#118): after a reload the badge must
    // still be there within 3 s of "saved" (openDocument waits for it), without a manual refresh.
    await openDocument(alice.page, docId);
    await expect(alice.page.getByTestId("notifications-badge")).toHaveText("1", { timeout: 3_000 });
    await alice.page.getByTestId("notifications-bell").click();
    const item = alice.page.getByTestId("notifications-popover").getByTestId("notification-item").first();
    await expect(item).toHaveAttribute("data-kind", "resolve");
    await expect(item).toContainText(`${bob.login} resolved your thread`);
    await alice.page.keyboard.press("Escape");

    // The resolved thread shows a dot in the panel; activating it marks the notification read.
    await ensureCommentsOpen(alice.page);
    await alice.page.getByTestId("comments-tab-resolved").click();
    const card = alice.page.getByTestId("comment-thread").filter({ hasText: "Can we expand this?" });
    await expect(card.getByTestId("thread-unread-dot")).toBeVisible();
    await card.click();
    await expect(card.getByTestId("thread-unread-dot")).toHaveCount(0);
    await expect.poll(() => unreadCount(alice.page)).toBe(0);
    await expect(alice.page.getByTestId("notifications-badge")).toHaveCount(0);
  });

  test("opening a resolve notification for the thread that is already active switches the panel to Resolved", async () => {
    // "Another note" is open; make it the active thread, then Bob resolves it. Activating the same id again
    // must still move the panel to the Resolved tab, otherwise the click lands on an empty Open list.
    await alice.page.getByTestId("comments-tab-open").click();
    const card = alice.page.getByTestId("comment-thread").filter({ hasText: "Another note" });
    await card.click();
    await expect(card).toHaveClass(/border-accent/);

    await bob.page.getByTestId("comment-thread").filter({ hasText: "Another note" }).getByTestId("comment-resolve").click();
    await expect.poll(() => unreadCount(alice.page)).toBe(1);
    await refresh(alice.page);
    await alice.page.getByTestId("notifications-bell").click();
    const item = alice.page.getByTestId("notifications-popover").getByTestId("notification-item").first();
    await expect(item).toHaveAttribute("data-kind", "resolve");
    await item.click();

    await expect(alice.page.getByTestId("comments-panel")).toBeVisible();
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/border-accent/);
    await expect(alice.page.getByTestId("comments-tab-resolved")).toHaveClass(/bg-surface/);
    await expect.poll(() => unreadCount(alice.page)).toBe(0);
  });

  test("accepting my suggestion notifies me", async () => {
    await alice.page.getByTestId("mode-switcher").click();
    await alice.page.getByRole("menuitemradio", { name: /Suggesting/ }).click();
    await expect(alice.page.getByTestId("mode-switcher")).toContainText("Suggesting");
    await focusRichEnd(alice.page);
    await alice.page.keyboard.type(" Suggested text.");
    await expect(bob.page.locator(".md-rich .md-suggest-insert").first()).toContainText("Suggested text.");

    await bob.page.getByTestId("comments-tab-suggestions").click();
    await expect(bob.page.getByTestId("suggestion-card")).toHaveCount(1);
    await bob.page.getByTestId("suggestion-card").getByTestId("suggestion-accept").click();
    await expect(bob.page.getByTestId("suggestion-card")).toHaveCount(0);

    await expect.poll(() => unreadCount(alice.page)).toBe(1);
    await refresh(alice.page);
    await alice.page.getByTestId("notifications-bell").click();
    const item = alice.page.getByTestId("notifications-popover").getByTestId("notification-item").first();
    await expect(item).toHaveAttribute("data-kind", "suggestion.accept");
    await expect(item).toContainText(`${bob.login} accepted your suggestion`);
    await expect(item).toContainText("Suggested text.");
    await alice.page.keyboard.press("Escape");
    expect(await unreadCount(bob.page)).toBe(0);
  });

  test("sharing a document notifies the new collaborator on the dashboard and on any document's bell", async () => {
    const other = await createDocument(alice.page, "# Shared with Carol\n\nHello.\n", "Shared with Carol");
    await shareWith(alice.page, other, carol.login, "commenter");
    await expect.poll(() => unreadCount(carol.page)).toBe(1);

    await carol.page.goto("/");
    const strip = carol.page.getByTestId("notifications-strip");
    await expect(strip).toBeVisible();
    const row = strip.getByTestId("notification-item");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-kind", "share");
    await expect(row).toContainText(`${alice.login} shared ‘Shared with Carol’ with you as commenter`);

    // Carol's own document: the bell shows the share too.
    const mine = await createDocument(carol.page, "# Carol's notes\n", "Carol's notes");
    await openDocument(carol.page, mine);
    await expect(carol.page.getByTestId("notifications-badge")).toHaveText("1");
    await carol.page.getByTestId("notifications-bell").click();
    const popover = carol.page.getByTestId("notifications-popover");
    await expect(popover.getByTestId("notification-item").first()).toContainText("shared ‘Shared with Carol’ with you");
    await popover.getByTestId("notifications-read-all").click();
    await expect(carol.page.getByTestId("notifications-badge")).toHaveCount(0);
    await expect(popover.getByTestId("notification-unread-dot")).toHaveCount(0);
    await expect.poll(() => unreadCount(carol.page)).toBe(0);
    await carol.page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);

    // Opening the shared item from the popover of another document navigates there.
    await shareWith(alice.page, docId, carol.login, "viewer");
    await refresh(carol.page);
    await expect(carol.page.getByTestId("notifications-badge")).toHaveText("1");
    await carol.page.getByTestId("notifications-bell").click();
    await carol.page.getByTestId("notifications-popover").getByTestId("notification-item").first().click();
    await carol.page.waitForURL(`**/d/${docId}`);
    await expect.poll(() => unreadCount(carol.page)).toBe(0);
  });

  test("anonymous callers get 401 and the /api/mentions alias still answers", async ({ browser }) => {
    const anon = await browser.newContext();
    const res = await anon.request.get("/api/notifications");
    expect(res.status()).toBe(401);
    await anon.close();
    const alias = await alice.page.request.get("/api/mentions");
    expect(alias.ok()).toBeTruthy();
    const body = (await alias.json()) as { items: unknown[]; unreadCount: number; mentions: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(Array.isArray(body.mentions)).toBe(true);
  });
});

test.describe("notification keyboard browsing selector", () => {
  test.skip(
    process.env.TASK_3472_BROWSER !== "1",
    "Run locally with TASK_3472_BROWSER=1 after acquiring the shared browser slot",
  );

  test("trusted navigation keys move focus without notification work and preserve native activation", async ({
    browser,
  }) => {
    const owner = await signIn(browser, uniqueLogin("keyboard-owner"));
    const recipient = await signIn(browser, uniqueLogin("keyboard-recipient"));
    const documents: { id: string; title: string }[] = [];
    const readRequests: string[] = [];
    const isSingleRead = (url: string, method: string) =>
      method === "POST" &&
      /^\/api\/notifications\/[^/]+\/read$/.test(new URL(url).pathname);
    recipient.page.on("request", (request) => {
      if (isSingleRead(request.url(), request.method())) {
        readRequests.push(new URL(request.url()).pathname);
      }
    });

    const installProbes = async () => {
      await recipient.page.evaluate(() => {
        type ProbeWindow = Window & {
          __task3472Focuses?: number[];
          __task3472Keys?: {
            key: string;
            defaultPrevented: boolean;
            isTrusted: boolean;
          }[];
        };
        const probeWindow = window as ProbeWindow;
        probeWindow.__task3472Focuses = [];
        probeWindow.__task3472Keys = [];
        document.addEventListener("focusin", (event) => {
          if (
            event.target instanceof HTMLElement &&
            event.target.matches('[data-testid="notification-open"]')
          ) {
            probeWindow.__task3472Focuses!.push(
              Array.from(
                document.querySelectorAll('[data-testid="notification-open"]'),
              ).indexOf(event.target),
            );
          }
        });
        document.addEventListener("keydown", (event) => {
          if (
            event.target instanceof HTMLElement &&
            event.target.matches('[data-testid="notification-open"]')
          ) {
            probeWindow.__task3472Keys!.push({
              key: event.key,
              defaultPrevented: event.defaultPrevented,
              isTrusted: event.isTrusted,
            });
          }
        });
      });
    };
    const resetProbes = () =>
      recipient.page.evaluate(() => {
        const probeWindow = window as Window & {
          __task3472Focuses?: number[];
          __task3472Keys?: unknown[];
        };
        probeWindow.__task3472Focuses = [];
        probeWindow.__task3472Keys = [];
      });
    const probeResults = () =>
      recipient.page.evaluate(() => {
        const probeWindow = window as Window & {
          __task3472Focuses?: number[];
          __task3472Keys?: {
            key: string;
            defaultPrevented: boolean;
            isTrusted: boolean;
          }[];
        };
        return {
          focuses: probeWindow.__task3472Focuses ?? [],
          keys: probeWindow.__task3472Keys ?? [],
        };
      });

    try {
      for (const suffix of ["first", "second", "third"]) {
        const title = `Keyboard ${suffix}`;
        const id = await createDocument(
          owner.page,
          `# ${title}\n\nTrusted keyboard navigation.\n`,
          title,
        );
        documents.push({ id, title });
        await shareWith(owner.page, id, recipient.login, "viewer");
      }
      await expect.poll(() => unreadCount(recipient.page)).toBe(3);
      await recipient.page.goto("/");
      await refresh(recipient.page);

      const strip = recipient.page.getByTestId("notifications-strip");
      const rows = strip.getByTestId("notification-item");
      const controls = strip.getByTestId("notification-open");
      await expect(rows).toHaveCount(3);
      await installProbes();
      await controls.nth(1).focus();

      const move = async (key: "ArrowDown" | "ArrowUp" | "Home" | "End", to: number) => {
        await resetProbes();
        await recipient.page.keyboard.press(key);
        await expect(controls.nth(to)).toBeFocused();
        expect(await probeResults()).toEqual({
          focuses: [to],
          keys: [{ key, defaultPrevented: true, isTrusted: true }],
        });
      };

      await move("ArrowDown", 2);
      await move("ArrowUp", 1);
      await move("Home", 0);
      await move("End", 2);
      await move("ArrowDown", 0);
      await move("ArrowUp", 2);
      expect(readRequests).toHaveLength(0);
      expect(await unreadCount(recipient.page)).toBe(3);
      await expect(rows).toHaveCount(3);
      expect(new URL(recipient.page.url()).pathname).toBe("/");

      const activate = async (key: "Enter" | "Space") => {
        const focusedText = await recipient.page
          .locator('[data-testid="notification-open"]:focus')
          .innerText();
        const selected = documents.find(({ title }) =>
          focusedText.includes(title),
        );
        if (!selected) {
          throw new Error(`Focused notification did not identify a test document: ${focusedText}`);
        }
        readRequests.length = 0;
        const readResponse = recipient.page.waitForResponse((response) =>
          isSingleRead(response.url(), response.request().method()),
        );
        await recipient.page.keyboard.press(key);
        expect((await readResponse).ok()).toBeTruthy();
        await recipient.page.waitForURL(`**/d/${selected.id}`);
        expect(readRequests).toHaveLength(1);
      };

      await activate("Enter");
      await recipient.page.goto("/");
      await refresh(recipient.page);
      await expect(
        recipient.page.getByTestId("notification-open"),
      ).toHaveCount(2);
      await installProbes();
      const remaining = recipient.page.getByTestId("notification-open");
      await remaining.nth(0).focus();
      await resetProbes();
      await recipient.page.keyboard.press("ArrowDown");
      await expect(remaining.nth(1)).toBeFocused();
      expect(await probeResults()).toEqual({
        focuses: [1],
        keys: [
          { key: "ArrowDown", defaultPrevented: true, isTrusted: true },
        ],
      });
      await activate("Space");

      await recipient.page.goto("/");
      await refresh(recipient.page);
      const only = recipient.page.getByTestId("notification-open");
      await expect(only).toHaveCount(1);
      await installProbes();
      await only.focus();
      await resetProbes();
      readRequests.length = 0;
      await recipient.page.keyboard.press("Home");
      await expect(only).toBeFocused();
      expect(await probeResults()).toEqual({
        focuses: [],
        keys: [{ key: "Home", defaultPrevented: true, isTrusted: true }],
      });
      expect(readRequests).toHaveLength(0);
      expect(await unreadCount(recipient.page)).toBe(1);
      expect(new URL(recipient.page.url()).pathname).toBe("/");
    } finally {
      await recipient.context.close();
      await owner.context.close();
    }
  });
});
