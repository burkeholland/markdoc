// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { compile } from "tailwindcss";
import type { NotificationDto } from "@/lib/api";
import type { NotificationReadError } from "@/lib/notifications-store";
import { TooltipProvider } from "@/components/ui/primitives";

const store = vi.hoisted(() => ({
  useNotifications: vi.fn(),
  refreshNotifications: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn(),
  retryNotificationRead: vi.fn(),
}));

vi.mock("@/lib/notifications-store", () => ({
  ...store,
  sentence: () => "mentioned you",
}));

import { NotificationsBell, type NotificationsBellProps } from "./notifications-bell";

interface BellState {
  items: NotificationDto[];
  unreadCount: number;
  loaded: boolean;
  loading: boolean;
  loadError: boolean;
  readAllPending: boolean;
  readError: NotificationReadError | null;
  readErrorPending: boolean;
}

const EMPTY: BellState = {
  items: [],
  unreadCount: 0,
  loaded: false,
  loading: false,
  loadError: false,
  readAllPending: false,
  readError: null,
  readErrorPending: false,
};
const ITEM: NotificationDto = {
  id: "notification-one",
  kind: "mention",
  documentId: "document-one",
  documentTitle: "Launch plan",
  actorLogin: "alice",
  actorName: "Alice",
  refId: "thread-one",
  snippet: "Please review this",
  createdAt: "2026-09-07T12:00:00.000Z",
  readAt: null,
};
const ITEM_TWO: NotificationDto = {
  ...ITEM,
  id: "notification-two",
  kind: "reply",
  documentId: "document-two",
  documentTitle: "Second launch plan",
  actorLogin: "bob",
  actorName: "Bob",
  refId: "thread-two",
  snippet: "A second notification",
  createdAt: "2026-09-07T13:00:00.000Z",
};
const ITEM_THREE: NotificationDto = {
  ...ITEM,
  id: "notification-three",
  kind: "resolve",
  documentId: "document-three",
  documentTitle: "Third launch plan",
  actorLogin: "carol",
  actorName: "Carol",
  refId: "thread-three",
  snippet: "A third notification",
  createdAt: "2026-09-07T14:00:00.000Z",
};
const SHARE: NotificationDto = {
  ...ITEM,
  id: "notification-share",
  kind: "share",
  documentId: "document-shared",
  documentTitle: "Shared plan",
  refId: "document-shared:carol",
  snippet: "viewer",
};
const PAGE_ITEMS: NotificationDto[] = Array.from({ length: 14 }, (_, index) => ({
  ...ITEM,
  id: `notification-page-${index + 1}`,
  documentId: `document-page-${index + 1}`,
  refId: `page-thread-${index + 1}`,
}));
const READ_AT = "2026-09-07T12:10:00.000Z";
const READ_FAILURE: NotificationReadError = {
  id: 7,
  operationId: 7,
  operation: "single",
  message: "Couldn't mark this notification as read.",
  notificationId: ITEM.id,
};
const THREE = { ...EMPTY, items: [ITEM, ITEM_TWO, ITEM_THREE], unreadCount: 3, loaded: true };
const PAGE = { ...EMPTY, items: PAGE_ITEMS, unreadCount: PAGE_ITEMS.length, loaded: true };

function bell(props: Partial<NotificationsBellProps> = {}) {
  return (
    <TooltipProvider>
      <NotificationsBell onOpen={vi.fn()} {...props} />
    </TooltipProvider>
  );
}

function renderBell(state: BellState, props: Partial<NotificationsBellProps> = {}, strict = false) {
  store.useNotifications.mockReturnValue(state);
  const wrap = (node: ReactNode) => (strict ? <StrictMode>{node}</StrictMode> : node);
  const view = render(wrap(bell(props)));
  return {
    /** Renders again with new store state and, optionally, new props. */
    update(next: BellState, nextProps: Partial<NotificationsBellProps> = props) {
      store.useNotifications.mockReturnValue(next);
      view.rerender(wrap(bell(nextProps)));
    },
  };
}

function clickBell() {
  fireEvent.click(screen.getByTestId("notifications-bell"));
}

function openBell(state: BellState, props: Partial<NotificationsBellProps> = {}, strict = false) {
  const view = renderBell(state, props, strict);
  clickBell();
  expect(screen.getByTestId("notifications-popover")).toBeVisible();
  return view;
}

const trigger = () => screen.getByTestId("notifications-bell");
const popover = () => screen.queryByTestId("notifications-popover");
const rows = () => screen.queryAllByTestId("notification-item");
/** Radix moves focus (back to the bell, into the popover) and arms its outside listeners on a timer. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** A cancelable keydown, as a browser sends it; returns the event so the test can read `defaultPrevented`. */
function press(element: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  fireEvent(element, event);
  return event;
}

function expectNothingDone(onOpen: ReturnType<typeof vi.fn>) {
  expect(store.markNotificationRead).not.toHaveBeenCalled();
  expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
  expect(store.retryNotificationRead).not.toHaveBeenCalled();
  expect(store.refreshNotifications).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
}

beforeEach(() => {
  store.useNotifications.mockReset();
  store.refreshNotifications.mockReset().mockResolvedValue(undefined);
  store.markAllNotificationsRead.mockReset().mockResolvedValue(undefined);
  store.markNotificationRead.mockReset().mockResolvedValue(undefined);
  store.retryNotificationRead.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("opening and closing the popover", () => {
  it("toggles with the bell and says so on the trigger", () => {
    renderBell(THREE);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");

    clickBell();
    expect(popover()).toBeVisible();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(rows()).toHaveLength(3);

    clickBell();
    expect(popover()).toBeNull();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on Escape from a row and returns focus to the bell", async () => {
    openBell(THREE);
    await settle();
    expect(rows()[0]).toHaveFocus();

    fireEvent.keyDown(rows()[0]!, { key: "Escape" });

    expect(popover()).toBeNull();
    await settle();
    expect(trigger()).toHaveFocus();
  });

  // #2225: the old event gate ignored an Escape that did not come from inside the popover, so the
  // popover stayed open and the next click on the bell closed it instead of opening it.
  it("closes on Escape wherever focus is", async () => {
    openBell(THREE);
    await settle();
    act(() => (document.activeElement as HTMLElement).blur());
    expect(document.body).toHaveFocus();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(popover()).toBeNull();
    clickBell();
    expect(popover()).toBeVisible();
  });

  it("closes on a press outside and when focus moves outside", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      openBell(THREE);
      await settle();
      fireEvent.pointerDown(outside);
      fireEvent.click(outside);
      await settle();
      expect(popover()).toBeNull();

      clickBell();
      await settle();
      act(() => outside.focus());
      expect(popover()).toBeNull();
    } finally {
      outside.remove();
    }
  });

  it("closes when another document is opened in place and lists rows for the new one", () => {
    const onOpen = vi.fn();
    const state = { ...EMPTY, items: [ITEM_TWO], unreadCount: 1, loaded: true };
    const view = openBell(state, { currentDocId: ITEM.documentId, onOpen });
    expect(rows()[0]).toHaveTextContent(ITEM_TWO.documentTitle);

    view.update(state, { currentDocId: ITEM_TWO.documentId, onOpen });

    expect(popover()).toBeNull();
    clickBell();
    expect(rows()[0]).not.toHaveTextContent(ITEM_TWO.documentTitle);
    fireEvent.click(rows()[0]!);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM_TWO.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM_TWO);
  });

  it("stays open while the list refreshes", () => {
    const view = openBell(THREE);
    view.update({ ...THREE, items: [ITEM_THREE, ITEM], unreadCount: 2, loading: true });
    expect(popover()).toBeVisible();
    expect(rows().map((row) => row.dataset.notificationId)).toEqual([ITEM_THREE.id, ITEM.id]);
  });

  it("shows its tooltip on focus and drops it when the popover opens", () => {
    renderBell(THREE);

    fireEvent.focus(trigger());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Notifications");
    expect(trigger()).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);

    clickBell();
    expect(popover()).toBeVisible();
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger()).not.toHaveAttribute("aria-describedby");
  });

  it("handles each input once in Strict Mode", async () => {
    const onOpen = vi.fn();
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      openBell({ ...EMPTY, items: [ITEM], unreadCount: 1, loadError: true, readError: READ_FAILURE }, { onOpen }, true);
      expect(screen.getAllByTestId("notifications-popover")).toHaveLength(1);

      fireEvent.click(screen.getByTestId("notifications-read-retry"));
      expect(store.retryNotificationRead).toHaveBeenCalledExactlyOnceWith(READ_FAILURE);
      fireEvent.click(screen.getByTestId("notifications-load-retry"));
      expect(store.refreshNotifications).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByTestId("notifications-read-all"));
      expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();

      fireEvent.keyDown(rows()[0]!, { key: "Escape" });
      expect(popover()).toBeNull();

      clickBell();
      await settle();
      fireEvent.pointerDown(outside);
      fireEvent.click(outside);
      await settle();
      expect(popover()).toBeNull();

      clickBell();
      fireEvent.click(rows()[0]!);
      expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
      expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM);
      expect(popover()).toBeNull();
    } finally {
      outside.remove();
    }
  });
});

describe("opening a notification", () => {
  it.each([
    ["an unread mention", ITEM],
    ["a read reply", { ...ITEM_TWO, readAt: READ_AT }],
    ["a share", SHARE],
  ] as const)("marks %s read, closes the popover, then opens it", (_label, notification) => {
    const order: string[] = [];
    const onOpen = vi.fn(() => order.push("open"));
    store.markNotificationRead.mockImplementation(() => {
      order.push("read");
      return Promise.resolve();
    });
    openBell({ ...EMPTY, items: [ITEM_THREE, notification], unreadCount: 2, loaded: true }, { onOpen });

    fireEvent.click(rows()[1]!);

    expect(order).toEqual(["read", "open"]);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(notification.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(notification);
    expect(popover()).toBeNull();
  });

  it("opens from a click anywhere in the row", () => {
    const onOpen = vi.fn();
    openBell({ ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true }, { onOpen });

    fireEvent.click(screen.getByTitle(ITEM.snippet));

    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM);
  });

  // Double submit: the first click closes the popover, which removes the row before a second click can land.
  it("opens a notification once however often its row is clicked", () => {
    const onOpen = vi.fn();
    openBell({ ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true }, { onOpen });
    const row = rows()[0]!;

    fireEvent.click(row);
    fireEvent.click(row);
    fireEvent.doubleClick(row);

    expect(row).not.toBeInTheDocument();
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM);
  });

  it("opens the same notification again after the bell is reopened", () => {
    const onOpen = vi.fn();
    openBell({ ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true }, { onOpen });
    fireEvent.click(rows()[0]!);

    clickBell();
    fireEvent.click(rows()[0]!);

    expect(store.markNotificationRead).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});

describe("focus when a button disables itself", () => {
  // Chromium drops focus from a button the moment it is disabled; Firefox, like jsdom, leaves it there.
  const BROWSERS = [
    ["a browser that drops focus from the disabled button", true],
    ["a browser that leaves focus on the disabled button", false],
  ] as const;

  function focusLike(dropsFocus: boolean, button: HTMLElement) {
    act(() => button.focus());
    if (!dropsFocus) return;
    const setAttribute = button.setAttribute.bind(button);
    button.setAttribute = (name: string, value: string) => {
      setAttribute(name, value);
      if (name === "disabled") button.blur();
    };
  }

  // #2225: "Mark all read" disables itself while it has focus. Focus must stay inside the popover rather
  // than fall to <body>, so the next Escape closes the popover and focus returns to the bell.
  it.each(BROWSERS)(
    "keeps focus in the popover after Mark all read, so Escape closes it and the next bell click opens it, in %s",
    async (_label, dropsFocus) => {
      const onOpen = vi.fn();
      const view = openBell({ ...EMPTY, items: [SHARE], unreadCount: 1, loaded: true }, { onOpen });
      await settle();
      const readAll = screen.getByTestId("notifications-read-all");
      focusLike(dropsFocus, readAll);
      expect(readAll).toHaveFocus();

      fireEvent.click(readAll);
      expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
      view.update({ ...EMPTY, items: [{ ...SHARE, readAt: READ_AT }], loaded: true, readAllPending: true });

      expect(readAll).toBeDisabled();
      expect(popover()).toHaveFocus();

      view.update({ ...EMPTY, items: [{ ...SHARE, readAt: READ_AT }], loaded: true });
      expect(popover()).toHaveFocus();

      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(popover()).toBeNull();
      await settle();
      expect(trigger()).toHaveFocus();

      const fresh = { ...SHARE, id: "notification-share-two", documentId: "document-shared-two" };
      view.update({ ...EMPTY, items: [fresh, { ...SHARE, readAt: READ_AT }], unreadCount: 1, loaded: true });
      clickBell();
      expect(popover()).toBeVisible();
      fireEvent.click(rows()[0]!);

      expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(fresh.id);
      expect(onOpen).toHaveBeenCalledExactlyOnceWith(fresh);
    },
  );

  it.each(BROWSERS)(
    "keeps focus in the popover when the unread count drops to zero under a focused Mark all read, in %s",
    async (_label, dropsFocus) => {
      const view = openBell(THREE);
      await settle();
      focusLike(dropsFocus, screen.getByTestId("notifications-read-all"));

      view.update({ ...THREE, items: THREE.items.map((item) => ({ ...item, readAt: READ_AT })), unreadCount: 0 });

      expect(popover()).toHaveFocus();
    },
  );

  it.each(
    BROWSERS.flatMap(([browser, dropsFocus]) => [
      ["the read Retry", browser, dropsFocus, "notifications-read-retry", { ...THREE, readError: READ_FAILURE }, { ...THREE, readError: READ_FAILURE, readErrorPending: true }] as const,
      ["the load Retry", browser, dropsFocus, "notifications-load-retry", { ...EMPTY, loadError: true }, { ...EMPTY, loadError: true, loading: true }] as const,
    ]),
  )("keeps focus in the popover when %s disables itself, in %s", async (_label, _browser, dropsFocus, testId, before, pending) => {
    const view = openBell(before);
    await settle();
    const retry = screen.getByTestId(testId);
    focusLike(dropsFocus, retry);

    fireEvent.click(retry);
    view.update(pending);

    expect(retry).toBeDisabled();
    expect(popover()).toHaveFocus();
  });

  it("leaves focus alone when a button that is not focused disables itself", async () => {
    const view = openBell(THREE);
    await settle();
    expect(rows()[0]).toHaveFocus();

    view.update({ ...THREE, readAllPending: true });

    expect(screen.getByTestId("notifications-read-all")).toBeDisabled();
    expect(rows()[0]).toHaveFocus();
  });

  it("leaves focus alone when it left a button before that button was disabled", async () => {
    const view = openBell(THREE);
    await settle();
    act(() => screen.getByTestId("notifications-read-all").focus());
    act(() => rows()[1]!.focus());

    view.update({ ...THREE, readAllPending: true });

    expect(rows()[1]).toHaveFocus();
  });
});

describe("notification rows", () => {
  it("carries the notification's identity and unread state on each row", () => {
    openBell({ ...EMPTY, items: [ITEM, { ...ITEM_TWO, readAt: READ_AT }], unreadCount: 1, loaded: true });
    const [unread, read] = rows();

    expect(unread).toHaveAttribute("data-notification-id", ITEM.id);
    expect(unread).toHaveAttribute("data-document-id", ITEM.documentId);
    expect(unread).toHaveAttribute("data-ref-id", ITEM.refId);
    expect(unread).toHaveAttribute("data-kind", "mention");
    expect(unread).toHaveAttribute("data-unread", "true");
    expect(unread).toHaveAttribute("type", "button");
    expect(read).toHaveAttribute("data-kind", "reply");
    expect(read).toHaveAttribute("data-unread", "false");
    expect(screen.getAllByTestId("notification-unread-dot")).toHaveLength(1);
    expect(unread).toContainElement(screen.getByTestId("notification-unread-dot"));
    expect(unread?.querySelector("time")).toHaveAttribute("datetime", ITEM.createdAt);
    expect(screen.getByRole("list", { name: "Notifications" }).children).toHaveLength(2);
  });

  it("names the actor, and the document unless it is the current one or the row is a share", () => {
    openBell(
      { ...EMPTY, items: [ITEM, ITEM_TWO, SHARE, { ...ITEM_THREE, actorName: null }, { ...ITEM_THREE, id: "anonymous", actorName: null, actorLogin: null }], unreadCount: 5, loaded: true },
      { currentDocId: ITEM.documentId },
    );
    const [current, other, share, login, anonymous] = rows();

    expect(current).toHaveTextContent("Alice mentioned you");
    expect(current).not.toHaveTextContent(ITEM.documentTitle);
    expect(other).toHaveTextContent(`Bob mentioned you in ${ITEM_TWO.documentTitle}`);
    expect(share).not.toHaveTextContent(SHARE.documentTitle);
    expect(login).toHaveTextContent("@carol mentioned you");
    expect(anonymous).toHaveTextContent("Someone mentioned you");
  });

  it.each([
    ["markup and quotes", '  Please review <strong title="launch">the launch plan</strong> with "quoted feedback" & literal markup.  '],
    ["a long preview", `A comment says <a href="https://example.invalid">do not turn this into a link</a>. ${"Keep every character. ".repeat(12)}`],
    ["whitespace only", " \t "],
  ])("shows the full snippet as passive text with a native title: %s", (_label, snippet) => {
    const onOpen = vi.fn();
    openBell({ ...EMPTY, items: [{ ...ITEM, snippet }], unreadCount: 1, loaded: true }, { onOpen });
    const row = rows()[0]!;
    const preview = row.querySelector("span.truncate");

    expect(row.querySelectorAll("span[title]")).toHaveLength(1);
    expect(preview).toHaveAttribute("title", snippet);
    expect(preview?.textContent).toBe(snippet);
    expect(preview?.children).toHaveLength(0);
    expect(preview).toHaveClass("block", "truncate");
    expect(row.querySelectorAll("a, button, input, select, textarea, [tabindex], [contenteditable]")).toHaveLength(0);

    fireEvent.mouseOver(preview!);
    fireEvent.mouseMove(preview!);
    fireEvent.mouseOut(preview!);
    expectNothingDone(onOpen);
    expect(popover()).toBeVisible();
  });

  it.each([
    ["mention", null],
    ["mention", ""],
    ["reply", null],
    ["share", null],
    ["share", "viewer"],
  ] as const)("shows no snippet for a %s with %j", (kind, snippet) => {
    // Nullable runtime data at the store boundary, not the string-only DTO.
    openBell({ ...EMPTY, items: [{ ...ITEM, kind, snippet: snippet as string }], unreadCount: 1, loaded: true });

    expect(rows()[0]!.querySelectorAll("span.truncate")).toHaveLength(0);
    expect(rows()[0]!.querySelectorAll("span[title]")).toHaveLength(0);
  });

  it("replaces a row's snippet in place and removes it with the list", () => {
    const state = { ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true };
    const view = openBell(state);
    const preview = screen.getByTitle(ITEM.snippet);

    view.update({ ...state, items: [{ ...ITEM, snippet: "Edited preview", readAt: READ_AT }], unreadCount: 0 });
    expect(screen.getByTitle("Edited preview")).toBe(preview);
    expect(screen.queryByTitle(ITEM.snippet)).toBeNull();
    expect(rows()[0]).toHaveAttribute("data-unread", "false");

    view.update({ ...state, items: [], unreadCount: 0 });
    expect(rows()).toHaveLength(0);
    expect(screen.queryByTitle("Edited preview")).toBeNull();
    expect(screen.getByText("You're all caught up.")).toBeVisible();
  });
});

describe("bell badge and labels", () => {
  it.each([
    [0, "Notifications", null, null],
    [1, "Notifications, 1 unread", "1", "1 unread"],
    [9, "Notifications, 9 unread", "9", "9 unread"],
    [12, "Notifications, 12 unread", "9+", "12 unread"],
  ] as const)("with %i unread", (unreadCount, label, badge, header) => {
    openBell({ ...EMPTY, items: [ITEM], unreadCount, loaded: true });

    expect(trigger()).toHaveAttribute("aria-label", label);
    expect(trigger()).toHaveAttribute("data-unread", String(unreadCount));
    expect(trigger()).toHaveAttribute("type", "button");
    if (badge) expect(screen.getByTestId("notifications-badge")).toHaveTextContent(badge);
    else expect(screen.queryByTestId("notifications-badge")).toBeNull();
    if (header) expect(screen.getByTestId("notifications-unread-count")).toHaveTextContent(header);
    else expect(screen.queryByTestId("notifications-unread-count")).toBeNull();
    expect(screen.getByTestId("notifications-read-all")).toHaveProperty("disabled", unreadCount === 0);
  });

  it("keeps the popover's size classes", () => {
    openBell(THREE);
    expect(popover()).toHaveClass("w-[min(380px,calc(100vw-16px))]", "p-0");
    expect(screen.getByRole("list", { name: "Notifications" })).toHaveClass("scrollbar-thin", "max-h-[420px]", "overflow-y-auto", "py-1");
  });
});

describe("notification read actions", () => {
  it("keeps optimistic all-read, the pending label, the badge and rollback with Retry", () => {
    const failure: NotificationReadError = {
      id: 1,
      operationId: 1,
      operation: "all",
      message: "Couldn't mark all notifications as read.",
    };
    const view = openBell({ ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true });

    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(popover()).toBeVisible();

    view.update({ ...EMPTY, items: [{ ...ITEM, readAt: READ_AT }], loaded: true, readAllPending: true });
    const pending = screen.getByRole("button", { name: "Marking all…" });
    expect(pending).toBeDisabled();
    expect(screen.queryByTestId("notifications-badge")).toBeNull();
    expect(screen.queryByTestId("notification-unread-dot")).toBeNull();
    fireEvent.click(pending);
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();

    view.update({ ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true, readError: failure });
    expect(screen.getByTestId("notifications-badge")).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(failure.message);
    fireEvent.click(screen.getByTestId("notifications-read-retry"));
    expect(store.retryNotificationRead).toHaveBeenCalledExactlyOnceWith(failure);
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
  });

  it("retries the current read error and disables Retry while it is pending", () => {
    const state = { ...THREE, readError: READ_FAILURE };
    const view = openBell(state);
    const replacement: NotificationReadError = { ...READ_FAILURE, id: 8, operationId: 8, message: "Still couldn't mark it as read." };

    view.update({ ...state, readError: replacement });
    expect(screen.getByRole("alert")).toHaveTextContent(replacement.message);
    expect(screen.queryByText(READ_FAILURE.message)).toBeNull();
    fireEvent.click(screen.getByTestId("notifications-read-retry"));
    expect(store.retryNotificationRead).toHaveBeenCalledExactlyOnceWith(replacement);

    view.update({ ...state, readError: replacement, readErrorPending: true });
    const pending = screen.getByRole("button", { name: "Retrying…" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(store.retryNotificationRead).toHaveBeenCalledOnce();

    view.update(THREE);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("notifications-read-retry")).toBeNull();
    expect(rows()).toHaveLength(3);
  });

  it("keeps the rows and Mark all read usable beside a read error", () => {
    const onOpen = vi.fn();
    openBell({ ...THREE, readError: READ_FAILURE }, { onOpen });

    fireEvent.click(screen.getByTestId("notifications-read-all"));
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    fireEvent.click(rows()[0]!);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM);
    expect(store.retryNotificationRead).not.toHaveBeenCalled();
  });
});

describe("notification read-error wrapping", () => {
  const alertClass = "flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40";
  const attributes = (element: Element) => Object.fromEntries([...element.attributes].map(({ name, value }) => [name, value]));

  it.each([
    ["unbroken", "NotificationReadFailure".repeat(16)],
    ["ordinary", "The notification could not be marked as read because the request was interrupted. Please retry. ".repeat(3)],
    ["literal HTML and whitespace", ' \tCould not read <strong>this notification</strong>\n<img src="invalid" alt="literal"> & "retry"  '.repeat(3)],
  ])("keeps the exact %s read reason beside one Retry, first in the list", (_label, message) => {
    openBell({ ...THREE, readError: { ...READ_FAILURE, message } });
    const alert = screen.getByRole("alert");
    const span = alert.firstElementChild!;
    const retry = screen.getByTestId("notifications-read-retry");

    expect(attributes(alert)).toEqual({ class: alertClass, role: "alert", "aria-atomic": "true" });
    expect([...alert.childNodes]).toEqual([span, retry]);
    expect(span.tagName).toBe("SPAN");
    expect(span.textContent).toBe(message);
    expect(span.children).toHaveLength(0);
    expect(attributes(span)).toEqual({ class: "min-w-0 wrap-anywhere" });
    expect(retry.textContent).toBe("Retry");
    expect(attributes(retry)).toEqual({
      type: "button",
      class: "btn btn-outline h-7 shrink-0 px-2 text-xs",
      "data-testid": "notifications-read-retry",
    });
    expect(screen.queryByTestId("notifications-load-retry")).toBeNull();
    const list = screen.getByRole("list", { name: "Notifications" });
    expect(list.firstElementChild).toBe(alert.parentElement);
    expect(alert.parentElement).toHaveAttribute("class", "px-3 py-2");
    expect(list.children).toHaveLength(4);
  });

  it("compiles read-error wrapping and Retry shrinking with the installed Tailwind theme", async () => {
    const theme = readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8");
    const { build } = await compile(`${theme}\n@tailwind utilities;`);
    const css = build(["min-w-0", "wrap-anywhere", "shrink-0"]);
    expect(css).toMatch(/\.min-w-0\s*\{\s*min-width:\s*0px;\s*\}/);
    expect(css).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
    expect(css).toMatch(/\.shrink-0\s*\{\s*flex-shrink:\s*0;\s*\}/);
    expect(css).not.toMatch(/word-break:\s*break-all|overflow:\s*(auto|scroll|hidden)|text-overflow:\s*ellipsis/);
  });
});

describe("notification bell loading", () => {
  it("shows a neutral first-load state instead of claiming empty success", () => {
    openBell({ ...EMPTY, loading: true });

    expect(screen.getByText("Loading notifications…")).toBeVisible();
    expect(screen.queryByText("You're all caught up.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows one first-load Retry that refreshes, is disabled while retrying, and goes away once loaded", () => {
    const onOpen = vi.fn();
    const view = openBell({ ...EMPTY, loadError: true }, { onOpen });
    const retry = screen.getByTestId("notifications-load-retry");
    const alert = screen.getByRole("alert");
    const span = alert.firstElementChild;

    expect(span?.tagName).toBe("SPAN");
    expect(span?.textContent).toBe("Couldn't load notifications.");
    expect([...alert.childNodes]).toEqual([span, retry]);
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(screen.queryByTestId("notifications-read-retry")).toBeNull();
    expect(retry).toHaveAttribute("type", "button");
    expect(retry.className).toBe("btn btn-outline h-7 shrink-0 px-2 text-xs");
    expect(retry.textContent).toBe("Retry");
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(store.refreshNotifications).toHaveBeenCalledOnce();

    view.update({ ...EMPTY, loading: true, loadError: true });
    const pending = screen.getByRole("button", { name: "Retrying…" });
    expect(pending).toBeDisabled();
    expect(screen.queryByText("Loading notifications…")).toBeNull();
    fireEvent.click(pending);
    expect(store.refreshNotifications).toHaveBeenCalledOnce();

    view.update({ ...EMPTY, loaded: true });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("notifications-load-retry")).toBeNull();
    expect(screen.getByText("You're all caught up.")).toBeVisible();
    expect(store.retryNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shows empty success only after a successful load", () => {
    openBell({ ...EMPTY, loaded: true });

    expect(screen.getByText("You're all caught up.")).toBeVisible();
    expect(screen.queryByText("Loading notifications…")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a cached unread list visible when a background refresh fails", () => {
    openBell({ ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true, loadError: true });

    expect(rows()[0]).toHaveTextContent("Alice mentioned you");
    expect(screen.getByTestId("notifications-badge")).toHaveTextContent("1");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("You're all caught up.")).toBeNull();
  });

  it("passes readiness to the store", () => {
    renderBell(EMPTY, { ready: false });
    expect(store.useNotifications).toHaveBeenLastCalledWith(false);
    cleanup();
    renderBell(EMPTY);
    expect(store.useNotifications).toHaveBeenLastCalledWith(true);
  });
});

// A held key repeats its keydown, and a browser presses the focused button on every Enter keydown that
// is not cancelled. jsdom does not, so these tests send the click the browser would.
describe("a held Enter or Space", () => {
  function pressLikeABrowser(key: "Enter" | " ", init: KeyboardEventInit = {}) {
    const target = document.activeElement!;
    const event = press(target, key, init);
    if (key === "Enter" && !event.defaultPrevented && target instanceof HTMLButtonElement && !target.disabled) fireEvent.click(target);
    return event;
  }

  it.each(["Enter", " "] as const)("cancels the repeats of a held %j on the bell, and not the first keydown", (key) => {
    renderBell(THREE);
    act(() => trigger().focus());

    expect(press(trigger(), key, { repeat: true }).defaultPrevented).toBe(true);
    expect(press(trigger(), key).defaultPrevented).toBe(false);
    expect(popover()).toBeNull();
  });

  it.each(["Enter", " "] as const)("cancels the repeats of a held %j on every button in the popover, and not the first keydown", (key) => {
    const onOpen = vi.fn();
    openBell({ ...THREE, readError: READ_FAILURE }, { onOpen });

    for (const button of [rows()[0]!, rows()[2]!, screen.getByTestId("notifications-read-retry"), screen.getByTestId("notifications-read-all")]) {
      act(() => button.focus());
      expect(press(button, key, { repeat: true }).defaultPrevented).toBe(true);
      expect(press(button, key).defaultPrevented).toBe(false);
    }
    expectNothingDone(onOpen);
    expect(popover()).toBeVisible();
  });

  // The row closes the popover and focus returns to the bell, where the repeats of the same press
  // used to open the bell again and then its first row.
  it("opens only the row it was held on, and leaves the bell closed", async () => {
    const onOpen = vi.fn();
    openBell(THREE, { onOpen });
    await settle();
    act(() => rows()[1]!.focus());

    pressLikeABrowser("Enter");
    expect(popover()).toBeNull();
    for (let repeats = 0; repeats < 5; repeats += 1) {
      await settle();
      expect(trigger()).toHaveFocus();
      pressLikeABrowser("Enter", { repeat: true });
    }

    expect(popover()).toBeNull();
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM_TWO.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM_TWO);
  });

  it("opens the bell once when held on it, without opening a row, and the next press opens the focused row", async () => {
    const onOpen = vi.fn();
    renderBell(THREE, { onOpen });
    act(() => trigger().focus());

    pressLikeABrowser("Enter");
    for (let repeats = 0; repeats < 5; repeats += 1) {
      await settle();
      expect(rows()[0]).toHaveFocus();
      pressLikeABrowser("Enter", { repeat: true });
    }

    expect(popover()).toBeVisible();
    expectNothingDone(onOpen);

    pressLikeABrowser("Enter");
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM);
    expect(popover()).toBeNull();
  });
});

describe("browsing rows with the keyboard", () => {
  it.each([
    ["ArrowDown", 0, 1],
    ["ArrowDown", 13, 0],
    ["ArrowUp", 1, 0],
    ["ArrowUp", 0, 13],
    ["Home", 9, 0],
    ["Home", 0, 0],
    ["End", 4, 13],
    ["End", 13, 13],
    ["PageDown", 1, 11],
    ["PageDown", 5, 13],
    ["PageUp", 12, 2],
    ["PageUp", 7, 0],
  ] as const)("%s on row %i moves focus to row %i without scrolling or opening anything", (key, from, to) => {
    const onOpen = vi.fn();
    openBell(PAGE, { onOpen }, true);
    const list = rows();
    act(() => list[from]!.focus());
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    const event = press(list[from]!, key);

    expect(event.defaultPrevented).toBe(true);
    expect(list[to]).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(focus.mock.contexts[0]).toBe(list[to]);
    expect(list.map((row) => row.tabIndex)).toEqual(PAGE_ITEMS.map(() => 0));
    expectNothingDone(onOpen);
    expect(popover()).toBeVisible();
  });

  it.each([
    ["PageUp", 0],
    ["PageDown", 13],
  ] as const)("%s on row %i, already at that end, is left to the browser", (key, index) => {
    openBell(PAGE);
    const list = rows();
    act(() => list[index]!.focus());
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    const event = press(list[index]!, key);

    expect(event.defaultPrevented).toBe(false);
    expect(list[index]).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(["ArrowDown", "ArrowUp", "Home", "End"] as const)("%s on the only row keeps focus there without scrolling", (key) => {
    openBell({ ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true });
    const row = rows()[0]!;
    act(() => row.focus());
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    const event = press(row, key);

    expect(event.defaultPrevented).toBe(true);
    expect(row).toHaveFocus();
    expect(focus.mock.calls).toEqual([[{ preventScroll: true }]]);
  });

  it.each([
    ["Control", { ctrlKey: true }],
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["Meta", { metaKey: true }],
    ["an IME composition", { isComposing: true }],
  ] as const)("ignores a navigation key pressed with %s", (_label, init) => {
    openBell(THREE);
    const list = rows();
    act(() => list[1]!.focus());

    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]) {
      expect(press(list[1]!, key, init).defaultPrevented).toBe(false);
    }
    expect(list[1]).toHaveFocus();
  });

  it("leaves other keys, and a key another handler already used, alone", () => {
    openBell(THREE);
    const list = rows();
    act(() => list[1]!.focus());

    for (const key of ["Tab", "Enter", " ", "a", "ArrowLeft", "ArrowRight"]) {
      expect(press(list[1]!, key).defaultPrevented).toBe(false);
    }
    const used = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    used.preventDefault();
    fireEvent(list[1]!, used);
    expect(list[1]).toHaveFocus();
  });

  it("does not move focus from the Retry or Mark all read buttons", () => {
    openBell({ ...THREE, readError: READ_FAILURE });
    for (const testId of ["notifications-read-retry", "notifications-read-all"]) {
      const button = screen.getByTestId(testId);
      act(() => button.focus());
      for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]) {
        expect(press(button, key).defaultPrevented).toBe(false);
      }
      expect(button).toHaveFocus();
    }
  });

  it("opens the focused row with Enter, which a button turns into a click", () => {
    const onOpen = vi.fn();
    openBell(THREE, { onOpen });
    act(() => rows()[0]!.focus());
    press(rows()[0]!, "ArrowDown");
    const focused = document.activeElement as HTMLElement;
    expect(focused).toBe(rows()[1]);

    // jsdom does not run a button's activation behavior for Enter, so send the click the browser would.
    expect(press(focused, "Enter").defaultPrevented).toBe(false);
    fireEvent.click(focused);

    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM_TWO.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM_TWO);
    expect(popover()).toBeNull();
  });
});

describe("opening the bell with an arrow key", () => {
  it.each([
    ["ArrowDown", 0, false],
    ["ArrowUp", 2, false],
    ["ArrowDown", 0, true],
    ["ArrowUp", 2, true],
  ] as const)("%s opens it on row %i (Strict Mode: %s)", async (key, index, strict) => {
    const onOpen = vi.fn();
    renderBell(THREE, { onOpen }, strict);
    act(() => trigger().focus());
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    const event = press(trigger(), key);

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getAllByTestId("notifications-popover")).toHaveLength(1);
    expect(rows()[index]).toHaveFocus();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    await settle();
    expect(rows()[index]).toHaveFocus();
    expectNothingDone(onOpen);
  });

  it("opens an empty list without moving focus off the bell, and Escape still closes it", async () => {
    renderBell({ ...EMPTY, loaded: true });
    act(() => trigger().focus());

    const event = press(trigger(), "ArrowDown");
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByText("You're all caught up.")).toBeVisible();
    expect(trigger()).toHaveFocus();

    fireEvent.keyDown(trigger(), { key: "Escape" });
    expect(popover()).toBeNull();
    await settle();
    expect(trigger()).toHaveFocus();
  });

  it("continues with the list keys, then Escape returns focus to the bell", async () => {
    renderBell(THREE);
    act(() => trigger().focus());
    press(trigger(), "ArrowUp");
    expect(rows()[2]).toHaveFocus();

    press(rows()[2]!, "ArrowDown");
    expect(rows()[0]).toHaveFocus();

    fireEvent.keyDown(rows()[0]!, { key: "Escape" });
    expect(popover()).toBeNull();
    await settle();
    expect(trigger()).toHaveFocus();
  });

  it("focuses the first row, not the arrow's row, when the bell is next opened with a click", async () => {
    renderBell(THREE);
    act(() => trigger().focus());
    press(trigger(), "ArrowUp");
    fireEvent.keyDown(rows()[2]!, { key: "Escape" });
    await settle();

    clickBell();
    await settle();

    expect(rows()[0]).toHaveFocus();
  });

  it.each([
    ["Control", { ctrlKey: true }],
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["Meta", { metaKey: true }],
    ["an IME composition", { isComposing: true }],
  ] as const)("stays closed for an arrow pressed with %s", (_label, init) => {
    renderBell(THREE);
    act(() => trigger().focus());

    for (const key of ["ArrowDown", "ArrowUp"]) {
      expect(press(trigger(), key, init).defaultPrevented).toBe(false);
    }
    expect(popover()).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it("stays closed for other keys and leaves Enter and Space to the button", () => {
    renderBell(THREE);
    act(() => trigger().focus());

    for (const key of ["Home", "End", "PageDown", "PageUp", "ArrowLeft", "ArrowRight", "Enter", " "]) {
      expect(press(trigger(), key).defaultPrevented).toBe(false);
    }
    expect(popover()).toBeNull();
  });

  it("leaves an arrow on the bell alone while the popover is already open", async () => {
    renderBell({ ...EMPTY, loaded: true });
    act(() => trigger().focus());
    press(trigger(), "ArrowDown");
    await settle();

    expect(press(trigger(), "ArrowDown").defaultPrevented).toBe(false);
    expect(popover()).toBeVisible();
    expect(trigger()).toHaveFocus();
  });
});
