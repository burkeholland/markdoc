// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationDto, NotificationsPageDto } from "@/lib/api";

// The real notifications store runs under the strip, so these tests see what a click really does to the
// list (the row leaves at once). Only the network and the router are replaced.
const notificationApi = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  readAll: vi.fn(),
  readRefs: vi.fn(),
}));
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: { notifications: notificationApi } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

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
  documentTitle: "Release notes",
  refId: "thread-two",
  snippet: "A reply",
};
const ITEM_THREE: NotificationDto = {
  ...ITEM,
  id: "notification-three",
  documentId: "document-three",
  documentTitle: "Launch checklist",
  refId: "thread-three",
};
const SHARE: NotificationDto = {
  id: "notification-share",
  kind: "share",
  documentId: "document-shared",
  documentTitle: "Shared brief",
  actorLogin: "bob",
  actorName: null,
  refId: "document-shared:bob",
  snippet: "viewer",
  createdAt: "2026-09-07T12:30:00.000Z",
  readAt: null,
};
const READ: NotificationDto = { ...ITEM, id: "notification-read", readAt: "2026-09-07T12:10:00.000Z" };
const ACCESS_REQUEST: NotificationDto = {
  ...ITEM,
  id: "notification-access-request",
  kind: "access.request",
  documentId: "document-requested",
  documentTitle: "Requested plan",
  snippet: "Please let me view this",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Mounts the strip over a fresh store that has loaded `items`. */
async function mountStrip(items: NotificationDto[], { strict = false, unreadCount }: { strict?: boolean; unreadCount?: number } = {}) {
  const page: NotificationsPageDto = { items, unreadCount: unreadCount ?? items.filter((item) => !item.readAt).length };
  notificationApi.list.mockResolvedValue(page);
  const { NotificationsStrip } = await import("./notifications-strip");
  const store = await import("@/lib/notifications-store");
  const view = render(strict ? <StrictMode><NotificationsStrip /></StrictMode> : <NotificationsStrip />);
  await waitFor(() => expect(notificationApi.list).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return { ...view, store };
}

const strip = () => screen.queryByTestId("notifications-strip");
const rows = () => screen.queryAllByTestId("notification-item");
const rowIds = () => rows().map((row) => row.dataset.notificationId);
const opens = () => screen.queryAllByTestId("notification-open") as HTMLButtonElement[];
const dismisses = () => screen.queryAllByTestId("notification-dismiss") as HTMLButtonElement[];
const readAll = () => screen.getByTestId("notifications-strip-read-all");
const status = () => screen.queryByTestId("notifications-strip-status");
const emptiedBox = () => screen.queryByTestId("notifications-strip-emptied");
const hrefOf = (notification: NotificationDto) => `/d/${notification.documentId}?thread=${notification.refId}`;

const elapse = (ms: number) => act(() => vi.advanceTimersByTime(ms));

/** A cancelable keydown, as a browser sends it; returns the event so the test can read `defaultPrevented`. */
function press(element: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  fireEvent(element, event);
  return event;
}

function expectNothingDone() {
  expect(notificationApi.read).not.toHaveBeenCalled();
  expect(notificationApi.readAll).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetModules();
  for (const mock of [...Object.values(notificationApi), ...Object.values(router)]) mock.mockReset();
  notificationApi.read.mockResolvedValue({ ok: true });
  notificationApi.readAll.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("notification strip presentation", () => {
  it("renders nothing until there is something unread", async () => {
    await mountStrip([READ]);
    expect(strip()).toBeNull();
  });

  it("renders nothing while the first load is pending", async () => {
    notificationApi.list.mockReturnValue(new Promise(() => {}));
    const { NotificationsStrip } = await import("./notifications-strip");
    render(<NotificationsStrip />);
    await waitFor(() => expect(notificationApi.list).toHaveBeenCalled());
    expect(strip()).toBeNull();
  });

  it("lists only unread notifications, with the unread count and one Mark all read", async () => {
    await mountStrip([ITEM, READ, ITEM_TWO, SHARE], { unreadCount: 7 });

    expect(strip()).toHaveAttribute("aria-label", "Notifications");
    expect(rowIds()).toEqual([ITEM.id, ITEM_TWO.id, SHARE.id]);
    expect(rows().map((row) => row.dataset.kind)).toEqual(["mention", "reply", "share"]);
    expect(screen.getByRole("heading", { name: /Notifications\s*7/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Mark all read" })).toBe(readAll());
    expect(screen.getAllByRole("button", { name: "Mark as read" })).toEqual(dismisses());
    expect(screen.getAllByRole("button")).toHaveLength(7);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getAllByRole("button").every((button) => button.getAttribute("type") === "button" && button.tabIndex === 0)).toBe(true);
  });

  it("names the actor and the document, and neither the document nor the snippet for a share", async () => {
    await mountStrip([ITEM, SHARE, { ...ITEM_THREE, actorName: null, actorLogin: null }]);
    const [mention, share, anonymous] = opens();

    expect(mention).toHaveTextContent("Alice mentioned you in Launch plan");
    expect(within(mention!).getByTestId("notification-doc-title")).toHaveTextContent(ITEM.documentTitle);
    expect(mention!.querySelector("time")).toHaveAttribute("datetime", ITEM.createdAt);
    expect(share).toHaveTextContent("@bob shared document ‘Shared brief’ with you as viewer");
    expect(within(share!).queryByTestId("notification-doc-title")).toBeNull();
    expect(share!.querySelectorAll(".truncate, span[title]")).toHaveLength(0);
    expect(anonymous).toHaveTextContent("Someone mentioned you");
  });

  it.each([
    ["a long preview", `  Please review the launch plan. ${"Keep the full context here. ".repeat(10)}`],
    ["literal markup", '  Literal <strong data-note="quoted">comment</strong> &amp; <a href="/not-a-link">not a link</a>\nsecond line  '],
  ])("shows the full snippet as passive text with a native title: %s", async (_label, snippet) => {
    await mountStrip([{ ...ITEM, snippet }]);
    const open = opens()[0]!;
    const preview = open.querySelector("span.truncate");

    expect(open.querySelectorAll("span[title]")).toHaveLength(1);
    expect(preview).toHaveAttribute("title", snippet);
    expect(preview?.textContent).toBe(snippet);
    expect(preview).toHaveAttribute("class", "mt-0.5 block truncate text-ink-3");
    expect(preview?.childElementCount).toBe(0);
    expect(open.lastElementChild).toBe(preview);
    expect(rows()[0]!.querySelectorAll("a, button, input, select, textarea, [tabindex], [contenteditable]")).toHaveLength(2);

    fireEvent.mouseOver(preview!);
    fireEvent.mouseMove(preview!);
    fireEvent.mouseOut(preview!);
    expectNothingDone();
    expect(rows()).toHaveLength(1);
  });

  it.each([null, ""])("shows no snippet for %j", async (snippet) => {
    // Nullable runtime data at the store boundary, not the string-only DTO.
    await mountStrip([{ ...ITEM, snippet: snippet as string }]);
    expect(opens()[0]!.querySelectorAll(".truncate, span[title]")).toHaveLength(0);
  });

  it("follows the store: a refresh replaces the rows and the last one takes the strip away", async () => {
    const { store } = await mountStrip([ITEM, ITEM_TWO]);

    notificationApi.list.mockResolvedValue({ items: [{ ...ITEM, snippet: "Edited" }, ITEM_THREE], unreadCount: 2 });
    await act(() => store.refreshNotifications());
    expect(rowIds()).toEqual([ITEM.id, ITEM_THREE.id]);
    expect(screen.getByTitle("Edited")).toBeVisible();

    notificationApi.list.mockResolvedValue({ items: [], unreadCount: 0 });
    await act(() => store.refreshNotifications());
    expect(strip()).toBeNull();
  });
});

describe("notification strip actions", () => {
  it("keeps an unread access request unread and opens its decision prompt", async () => {
    await mountStrip([ACCESS_REQUEST]);

    fireEvent.click(opens()[0]!);

    expect(notificationApi.read).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledExactlyOnceWith(
      `/d/${ACCESS_REQUEST.documentId}?accessRequest=${ACCESS_REQUEST.actorLogin}&notification=${ACCESS_REQUEST.id}`,
    );
  });

  it.each([
    ["a mention", ITEM, `/d/${ITEM.documentId}?thread=${ITEM.refId}`],
    ["a share", SHARE, `/d/${SHARE.documentId}`],
  ] as const)("opening %s marks it read, then navigates to it", async (_label, notification, href) => {
    const order: string[] = [];
    notificationApi.read.mockImplementation((id: string) => {
      order.push(`read:${id}`);
      return Promise.resolve({ ok: true });
    });
    router.push.mockImplementation((to: string) => order.push(`push:${to}`));
    await mountStrip([ITEM_TWO, notification]);

    fireEvent.click(opens()[1]!);

    expect(order).toEqual([`read:${notification.id}`, `push:${href}`]);
    expect(notificationApi.readAll).not.toHaveBeenCalled();
    // The row stays until the page changes.
    expect(rowIds()).toEqual([ITEM_TWO.id, notification.id]);
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("opens from a click anywhere in the row's button", async () => {
    await mountStrip([ITEM]);

    fireEvent.click(screen.getByTitle(ITEM.snippet));

    expect(notificationApi.read).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM.documentId}?thread=${ITEM.refId}`);
  });

  // The browser counts the clicks of a double or triple click (`detail`). The strip does not move while
  // the row opens, so the rest of the gesture lands on the same row.
  it.each([false, true])("a double-click or a triple-click opens only the row under the first click (Strict Mode: %s)", async (strict) => {
    const pending = deferred<{ ok: true }>();
    notificationApi.read.mockReturnValue(pending.promise);
    await mountStrip([ITEM, ITEM_TWO, ITEM_THREE], { strict });

    fireEvent.click(opens()[0]!, { detail: 1 });
    fireEvent.click(opens()[0]!, { detail: 2 });
    fireEvent.click(opens()[0]!, { detail: 3 });

    expect(notificationApi.read).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(hrefOf(ITEM));
    expect(rowIds()).toEqual([ITEM.id, ITEM_TWO.id, ITEM_THREE.id]);
    await act(async () => {
      pending.resolve({ ok: true });
      await pending.promise;
    });
    expect(rowIds()).toEqual([ITEM.id, ITEM_TWO.id, ITEM_THREE.id]);
  });

  // The first click of the gesture was on something else, which moved this row under the pointer.
  it("the second click of a double-click that lands on a row opens nothing", async () => {
    await mountStrip([ITEM, ITEM_TWO]);

    fireEvent.click(opens()[0]!, { detail: 2 });
    fireEvent.click(opens()[1]!, { detail: 3 });

    expectNothingDone();
    expect(rowIds()).toEqual([ITEM.id, ITEM_TWO.id]);
  });

  it("Mark as read takes only its row away, without navigating", async () => {
    await mountStrip([ITEM, ITEM_TWO, ITEM_THREE]);

    fireEvent.click(dismisses()[1]!);

    expect(notificationApi.read).toHaveBeenCalledExactlyOnceWith(ITEM_TWO.id);
    expect(router.push).not.toHaveBeenCalled();
    expect(rowIds()).toEqual([ITEM.id, ITEM_THREE.id]);
    expect(screen.getByRole("heading", { name: /Notifications\s*2/ })).toBeVisible();
    await act(async () => {
      await Promise.resolve();
    });
  });

  // The next row's "Mark as read" moves up under the pointer, like the row itself.
  it("a double-click on Mark as read takes one row away, and a separate click takes the next", async () => {
    await mountStrip([ITEM, ITEM_TWO, ITEM_THREE]);

    fireEvent.click(dismisses()[0]!, { detail: 1 });
    expect(rowIds()).toEqual([ITEM_TWO.id, ITEM_THREE.id]);
    fireEvent.click(dismisses()[0]!, { detail: 2 });
    fireEvent.click(dismisses()[0]!, { detail: 3 });

    expect(notificationApi.read).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(rowIds()).toEqual([ITEM_TWO.id, ITEM_THREE.id]);

    fireEvent.click(dismisses()[0]!, { detail: 1 });

    expect(notificationApi.read).toHaveBeenCalledTimes(2);
    expect(notificationApi.read).toHaveBeenLastCalledWith(ITEM_TWO.id);
    expect(rowIds()).toEqual([ITEM_THREE.id]);
    expect(router.push).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("Mark all read sends one request and takes the strip away", async () => {
    const pending = deferred<{ ok: true }>();
    notificationApi.readAll.mockReturnValue(pending.promise);
    await mountStrip([ITEM, SHARE]);
    const button = readAll();

    fireEvent.click(button);
    fireEvent.click(button);

    expect(notificationApi.readAll).toHaveBeenCalledOnce();
    expect(notificationApi.read).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(strip()).toBeNull();
    await act(async () => {
      pending.resolve({ ok: true });
      await pending.promise;
    });
    expect(strip()).toBeNull();
  });

  it("after the list reorders, each row opens its own notification", async () => {
    const { store } = await mountStrip([ITEM, ITEM_TWO, SHARE]);

    notificationApi.list.mockResolvedValue({ items: [SHARE, ITEM_TWO, ITEM], unreadCount: 3 });
    await act(() => store.refreshNotifications());
    expect(rowIds()).toEqual([SHARE.id, ITEM_TWO.id, ITEM.id]);
    fireEvent.click(opens()[0]!);

    expect(notificationApi.read).toHaveBeenCalledExactlyOnceWith(SHARE.id);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${SHARE.documentId}`);
    expect(rowIds()).toEqual([SHARE.id, ITEM_TWO.id, ITEM.id]);
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("brings a row back when marking it read fails, and it can be opened again", async () => {
    notificationApi.read.mockRejectedValueOnce(new Error("offline"));
    await mountStrip([ITEM, ITEM_TWO]);

    fireEvent.click(dismisses()[0]!);
    expect(rowIds()).toEqual([ITEM_TWO.id]);
    await waitFor(() => expect(rowIds()).toEqual([ITEM.id, ITEM_TWO.id]));

    fireEvent.click(opens()[0]!);
    expect(notificationApi.read).toHaveBeenCalledTimes(2);
    expect(notificationApi.read).toHaveBeenLastCalledWith(ITEM.id);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM.documentId}?thread=${ITEM.refId}`);
    await act(async () => {
      await Promise.resolve();
    });
  });
});

describe("notification strip keyboard", () => {
  it.each([
    ["ArrowDown", 0, 1],
    ["ArrowDown", 1, 2],
    ["ArrowDown", 2, 0],
    ["ArrowUp", 0, 2],
    ["ArrowUp", 1, 0],
    ["ArrowUp", 2, 1],
    ["Home", 1, 0],
    ["Home", 2, 0],
    ["End", 0, 2],
    ["End", 1, 2],
  ] as const)("%s on row %i moves focus to row %i without scrolling or acting", async (key, from, to) => {
    await mountStrip([ITEM, ITEM_TWO, ITEM_THREE], { strict: true });
    const controls = opens();
    act(() => controls[from]!.focus());
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    const event = press(controls[from]!, key);

    expect(event.defaultPrevented).toBe(true);
    expect(controls[to]).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(focus.mock.contexts[0]).toBe(controls[to]);
    expectNothingDone();
    expect(rows()).toHaveLength(3);
  });

  it("moves through the list key after key, also from the numeric keypad, then opens the focused row", async () => {
    await mountStrip([ITEM, ITEM_TWO, ITEM_THREE]);
    const controls = opens();
    act(() => controls[0]!.focus());

    press(document.activeElement!, "ArrowDown");
    expect(controls[1]).toHaveFocus();
    press(document.activeElement!, "End", { code: "Numpad1", location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD });
    expect(controls[2]).toHaveFocus();
    press(document.activeElement!, "ArrowDown", { code: "Numpad2", location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD });
    expect(controls[0]).toHaveFocus();
    press(document.activeElement!, "ArrowUp", { repeat: true });
    expect(controls[2]).toHaveFocus();
    expectNothingDone();

    // jsdom does not run a button's activation behavior for Enter, so send the click the browser would.
    expect(press(document.activeElement!, "Enter").defaultPrevented).toBe(false);
    fireEvent.click(document.activeElement!);

    expect(notificationApi.read).toHaveBeenCalledExactlyOnceWith(ITEM_THREE.id);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM_THREE.documentId}?thread=${ITEM_THREE.refId}`);
    await act(async () => {
      await Promise.resolve();
    });
  });

  it.each([
    ["Home", 0, [ITEM, ITEM_TWO, ITEM_THREE]],
    ["End", 2, [ITEM, ITEM_TWO, ITEM_THREE]],
    ["ArrowDown", 0, [ITEM]],
    ["ArrowUp", 0, [ITEM]],
    ["Home", 0, [ITEM]],
    ["End", 0, [ITEM]],
  ] as const)("%s on row %i with nowhere to go keeps focus there and does not scroll the page", async (key, index, items) => {
    await mountStrip([...items]);
    const source = opens()[index]!;
    act(() => source.focus());
    const moved = vi.fn();
    document.addEventListener("focusin", moved);

    const event = press(source, key);

    document.removeEventListener("focusin", moved);
    expect(event.defaultPrevented).toBe(true);
    expect(source).toHaveFocus();
    expect(moved).not.toHaveBeenCalled();
    expectNothingDone();
  });

  it.each([
    ["the row", "ArrowRight"],
    ["Mark as read", "ArrowLeft"],
    ["Mark as read", "ArrowUp"],
    ["Mark as read", "Home"],
  ] as const)("from %s, %s moves to the other button of the same notification", async (from, key) => {
    await mountStrip([ITEM, ITEM_TWO, ITEM_THREE]);
    const source = from === "the row" ? opens()[1]! : dismisses()[1]!;
    const destination = from === "the row" ? dismisses()[1]! : opens()[1]!;
    act(() => source.focus());
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    const event = press(source, key);

    expect(event.defaultPrevented).toBe(true);
    expect(destination).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expectNothingDone();
  });

  it.each([
    ["the row", "ArrowLeft"],
    ["Mark as read", "ArrowRight"],
    ["Mark as read", "ArrowDown"],
    ["Mark as read", "End"],
    ["Mark as read", "Delete"],
    ["Mark all read", "ArrowDown"],
    ["Mark all read", "Home"],
    ["Mark all read", "Delete"],
  ] as const)("on %s, %s does nothing", async (from, key) => {
    await mountStrip([ITEM, ITEM_TWO]);
    const source = from === "the row" ? opens()[0]! : from === "Mark as read" ? dismisses()[0]! : readAll();
    act(() => source.focus());

    expect(press(source, key).defaultPrevented).toBe(false);
    expect(source).toHaveFocus();
    expectNothingDone();
  });

  it.each([
    ["Control", { ctrlKey: true }],
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["Meta", { metaKey: true }],
    ["an IME composition", { isComposing: true }],
  ] as const)("ignores a key pressed with %s", async (_label, init) => {
    await mountStrip([ITEM, ITEM_TWO]);
    const open = opens()[0]!;
    const dismiss = dismisses()[0]!;

    act(() => open.focus());
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "Delete"]) {
      expect(press(open, key, init).defaultPrevented).toBe(false);
    }
    expect(open).toHaveFocus();
    act(() => dismiss.focus());
    for (const key of ["ArrowLeft", "ArrowUp", "Home"]) {
      expect(press(dismiss, key, init).defaultPrevented).toBe(false);
    }
    expect(dismiss).toHaveFocus();
    expectNothingDone();
  });

  it("leaves Enter, Space and Tab to the buttons, and a key another handler already used", async () => {
    await mountStrip([ITEM, ITEM_TWO]);
    const open = opens()[0]!;
    act(() => open.focus());

    for (const button of [open, dismisses()[0]!, readAll()]) {
      for (const key of ["Enter", " ", "Tab", "a"]) {
        expect(press(button, key).defaultPrevented).toBe(false);
      }
    }
    const used = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    used.preventDefault();
    fireEvent(open, used);
    expect(open).toHaveFocus();
    expectNothingDone();
  });

  it.each([
    ["first", 0, ITEM.id],
    ["middle", 1, ITEM_TWO.id],
    ["last", 2, ITEM_THREE.id],
  ] as const)("Delete on the %s row marks only that notification read, without navigating", async (_label, index, id) => {
    await mountStrip([ITEM, ITEM_TWO, ITEM_THREE]);
    const source = opens()[index]!;
    act(() => source.focus());

    const event = press(source, "Delete");

    expect(event.defaultPrevented).toBe(true);
    expect(notificationApi.read).toHaveBeenCalledExactlyOnceWith(id);
    expect(notificationApi.readAll).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(rowIds()).toEqual([ITEM.id, ITEM_TWO.id, ITEM_THREE.id].filter((other) => other !== id));
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("ignores a held Delete", async () => {
    await mountStrip([ITEM, ITEM_TWO]);
    act(() => opens()[0]!.focus());

    expect(press(opens()[0]!, "Delete", { repeat: true }).defaultPrevented).toBe(false);

    expectNothingDone();
    expect(rows()).toHaveLength(2);
  });

  // A browser presses a button on each Enter keydown unless the keydown is cancelled, and on Space keyup.
  // jsdom does neither, so this sends the click the browser would.
  function pressLikeABrowser(key: "Enter" | " ", init: KeyboardEventInit = {}) {
    const target = document.activeElement!;
    const event = press(target, key, init);
    if (key === "Enter" && !event.defaultPrevented && target instanceof HTMLButtonElement) fireEvent.click(target);
    return event;
  }

  it.each(["Enter", " "] as const)("cancels the repeats of a held %j on every button, and not the first keydown", async (key) => {
    await mountStrip([ITEM, ITEM_TWO]);

    for (const button of [opens()[0]!, dismisses()[0]!, readAll()]) {
      expect(press(button, key).defaultPrevented).toBe(false);
      expect(press(button, key, { repeat: true }).defaultPrevented).toBe(true);
    }
    expectNothingDone();
  });

  // Mark as read moves focus to the next row, where the repeats of the same press would open it.
  it("a held Enter on Mark as read takes one row away and opens nothing", async () => {
    await mountStrip([ITEM, ITEM_TWO, ITEM_THREE]);
    act(() => dismisses()[0]!.focus());

    pressLikeABrowser("Enter");
    expect(opens()[0]).toHaveFocus();
    for (let repeats = 0; repeats < 5; repeats += 1) pressLikeABrowser("Enter", { repeat: true });

    expect(notificationApi.read).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(router.push).not.toHaveBeenCalled();
    expect(rowIds()).toEqual([ITEM_TWO.id, ITEM_THREE.id]);
    expect(opens()[0]).toHaveFocus();

    // The key is released and pressed again: that is a new press.
    pressLikeABrowser("Enter");
    expect(router.push).toHaveBeenCalledExactlyOnceWith(hrefOf(ITEM_TWO));
    await act(async () => {
      await Promise.resolve();
    });
  });
});

describe("notification strip focus when a row leaves", () => {
  const focusedId = () => (document.activeElement as HTMLElement).closest("li")?.dataset.notificationId;

  it.each([
    ["first", 0, ITEM_TWO.id],
    ["middle", 1, ITEM_THREE.id],
    ["last", 2, ITEM_TWO.id],
  ] as const)("Delete on the %s row moves focus to the next row, or the previous one at the end", async (_label, index, neighbour) => {
    await mountStrip([ITEM, ITEM_TWO, ITEM_THREE]);
    act(() => opens()[index]!.focus());

    press(opens()[index]!, "Delete");

    expect(rows()).toHaveLength(2);
    expect(document.activeElement).toHaveAttribute("data-testid", "notification-open");
    expect(focusedId()).toBe(neighbour);
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("clears the list with Delete alone, one row after another", async () => {
    await mountStrip([ITEM, ITEM_TWO, ITEM_THREE]);
    act(() => opens()[0]!.focus());

    press(document.activeElement!, "Delete");
    expect(focusedId()).toBe(ITEM_TWO.id);
    press(document.activeElement!, "Delete");
    expect(focusedId()).toBe(ITEM_THREE.id);
    press(document.activeElement!, "Delete");

    expect(strip()).toBeNull();
    expect(status()).toHaveFocus();
    expect(notificationApi.read.mock.calls).toEqual([[ITEM.id], [ITEM_TWO.id], [ITEM_THREE.id]]);
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("Mark as read moves focus from its own button to the next row", async () => {
    await mountStrip([ITEM, ITEM_TWO]);
    act(() => dismisses()[0]!.focus());

    fireEvent.click(dismisses()[0]!);

    expect(rowIds()).toEqual([ITEM_TWO.id]);
    expect(opens()[0]).toHaveFocus();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("leaves focus alone when it is not in the row that leaves", async () => {
    await mountStrip([ITEM, ITEM_TWO, ITEM_THREE]);
    act(() => opens()[2]!.focus());
    const moved = vi.fn();
    document.addEventListener("focusin", moved);

    // A browser that does not focus a button on click: focus is still on another row.
    fireEvent.click(dismisses()[0]!);

    document.removeEventListener("focusin", moved);
    expect(rowIds()).toEqual([ITEM_TWO.id, ITEM_THREE.id]);
    expect(focusedId()).toBe(ITEM_THREE.id);
    expect(moved).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
  });
});

// The last row leaves and the strip with it. The control that had focus is gone, so a status line that
// only assistive technology sees takes its place and its focus, and goes away once focus moves on.
describe("notification strip focus when the strip empties", () => {
  const expectStatusFocused = () => {
    expect(strip()).toBeNull();
    expect(status()).toHaveFocus();
    expect(status()).toHaveTextContent("No unread notifications");
    expect(status()).toHaveAttribute("role", "status");
    expect(status()).toHaveAttribute("tabindex", "-1");
    expect(status()).toHaveClass("sr-only");
  };
  const settle = () =>
    act(async () => {
      await Promise.resolve();
    });

  it.each([
    ["Delete on the only row", () => press(opens()[0]!, "Delete"), () => opens()[0]!],
    ["Mark as read on the only row", () => fireEvent.click(dismisses()[0]!), () => dismisses()[0]!],
    ["Mark as read on the only row, clicked with focus on the row", () => fireEvent.click(dismisses()[0]!), () => opens()[0]!],
  ] as const)("%s moves focus to the status line", async (_label, action, focused) => {
    await mountStrip([ITEM]);
    act(() => focused().focus());
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    action();

    expectStatusFocused();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(notificationApi.read).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(router.push).not.toHaveBeenCalled();
    await settle();
    expectStatusFocused();
  });

  it.each([
    ["Mark all read", () => readAll()],
    ["a row", () => opens()[1]!],
  ] as const)("Mark all read with focus on %s moves focus to the status line", async (_label, focused) => {
    await mountStrip([ITEM, ITEM_TWO, SHARE], { strict: true });
    act(() => focused().focus());

    fireEvent.click(readAll());

    expectStatusFocused();
    expect(notificationApi.readAll).toHaveBeenCalledOnce();
    await settle();
    expectStatusFocused();
  });

  it("removes the status line once focus leaves it", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      await mountStrip([ITEM]);
      act(() => opens()[0]!.focus());
      press(opens()[0]!, "Delete");
      expectStatusFocused();

      // The window loses focus (another app, another tab): the line is still the active element and stays.
      fireEvent.blur(status()!);
      expectStatusFocused();

      act(() => outside.focus());

      expect(status()).toBeNull();
      expect(strip()).toBeNull();
      expect(outside).toHaveFocus();
    } finally {
      outside.remove();
    }
  });

  it("shows no status line and moves no focus when focus was outside the strip", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      await mountStrip([ITEM, ITEM_TWO]);
      act(() => outside.focus());
      const moved = vi.fn();
      document.addEventListener("focusin", moved);

      fireEvent.click(dismisses()[1]!);
      fireEvent.click(readAll());

      document.removeEventListener("focusin", moved);
      expect(strip()).toBeNull();
      expect(status()).toBeNull();
      expect(outside).toHaveFocus();
      expect(moved).not.toHaveBeenCalled();
      await settle();
    } finally {
      outside.remove();
    }
  });

  it("does not take focus when a background refresh empties the strip", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      const { store } = await mountStrip([ITEM, ITEM_TWO]);
      // An earlier action in the strip, with focus in it, that left a row behind.
      act(() => opens()[0]!.focus());
      press(opens()[0]!, "Delete");
      expect(opens()[0]).toHaveFocus();
      await settle();
      act(() => outside.focus());
      const moved = vi.fn();
      document.addEventListener("focusin", moved);

      notificationApi.list.mockResolvedValue({ items: [], unreadCount: 0 });
      await act(() => store.refreshNotifications());

      document.removeEventListener("focusin", moved);
      expect(strip()).toBeNull();
      expect(status()).toBeNull();
      expect(outside).toHaveFocus();
      expect(moved).not.toHaveBeenCalled();
    } finally {
      outside.remove();
    }
  });

  it("keeps focus on the status line, now silent, when the row comes back because marking it read failed", async () => {
    notificationApi.read.mockRejectedValueOnce(new Error("offline"));
    await mountStrip([ITEM]);
    act(() => dismisses()[0]!.focus());

    fireEvent.click(dismisses()[0]!);
    expectStatusFocused();
    await waitFor(() => expect(rowIds()).toEqual([ITEM.id]));

    expect(status()).toHaveFocus();
    expect(status()).toBeEmptyDOMElement();
    expect(strip()!.compareDocumentPosition(status()!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();

    // Clearing the strip again from the row says so again.
    act(() => opens()[0]!.focus());
    expect(status()).toBeNull();
    press(opens()[0]!, "Delete");
    expectStatusFocused();
    await settle();
  });
});

// A row that is opened is marked read at once, and so would leave the list, and the last row would take
// the strip with it, while the pointer is still there. Until the page changes the strip stays as it was.
// The router is a mock here: the page never changes, as when a navigation ends on the dashboard itself.
describe("notification strip while a row's document opens", () => {
  const HEIGHT = 96.5;
  const measured = () => vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: HEIGHT } as DOMRect);
  const heading = (count: number) => screen.getByRole("heading", { name: new RegExp(`Notifications\\s*${count}$`) });
  const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const open = (index: number) => fireEvent.click(opens()[index]!, { detail: 1 });
  const windowEvent = (type: string) => fireEvent(window, new Event(type));
  /** `persisted` true: the browser had kept the page for Back and shows it again. False: a page load has just ended. */
  const pageShown = (persisted: boolean) => fireEvent(window, new PageTransitionEvent("pageshow", { persisted }));
  const settle = () =>
    act(async () => {
      await Promise.resolve();
    });

  it("stays as it was, the opened row included, and does nothing", async () => {
    const all = [ITEM, ITEM_TWO, ITEM_THREE, SHARE];
    const { store } = await mountStrip(all);
    act(() => opens()[0]!.focus());

    open(0);

    const held = () => {
      expect(rowIds()).toEqual(all.map((item) => item.id));
      expect(heading(4)).toBeVisible();
      expect(opens()[0]).toHaveFocus();
      expect(status()).toBeNull();
      expect(emptiedBox()).toBeNull();
      expect(notificationApi.read).toHaveBeenCalledExactlyOnceWith(ITEM.id);
      expect(notificationApi.readAll).not.toHaveBeenCalled();
      expect(router.push).toHaveBeenCalledExactlyOnceWith(hrefOf(ITEM));
    };
    held();
    // The same row again as a new click and from the keyboard, another row, both ways to mark as read,
    // and Mark all read.
    open(0);
    fireEvent.click(opens()[0]!);
    open(2);
    fireEvent.click(dismisses()[0]!, { detail: 1 });
    fireEvent.click(dismisses()[2]!);
    press(opens()[0]!, "Delete");
    fireEvent.click(readAll(), { detail: 1 });
    fireEvent.click(readAll());
    await settle();
    held();
    // The list changes behind it: the poll comes back without the opened row and with a new one.
    notificationApi.list.mockResolvedValue({ items: [{ ...ITEM, id: "notification-new" }, ITEM_TWO, ITEM_THREE, SHARE], unreadCount: 9 });
    await act(() => store.refreshNotifications());
    held();
    // The arrow keys are not actions. They still move focus.
    press(opens()[0]!, "ArrowDown");
    expect(opens()[1]).toHaveFocus();
  });

  it.each([
    ["Back or Forward", () => windowEvent("popstate")],
    ["the page shown again after the browser had kept it", () => pageShown(true)],
  ] as const)("%s ends the wait at once: the strip follows the list in one step and rows open again", async (_label, end) => {
    const { store } = await mountStrip([ITEM, ITEM_TWO, ITEM_THREE]);
    open(0);
    await settle();
    notificationApi.list.mockResolvedValue({ items: [{ ...ITEM, id: "notification-new" }, ITEM_TWO, ITEM_THREE], unreadCount: 7 });
    await act(() => store.refreshNotifications());
    expect(rowIds()).toEqual([ITEM.id, ITEM_TWO.id, ITEM_THREE.id]);

    end();

    expect(rowIds()).toEqual(["notification-new", ITEM_TWO.id, ITEM_THREE.id]);
    expect(heading(7)).toBeVisible();
    open(1);
    expect(notificationApi.read).toHaveBeenLastCalledWith(ITEM_TWO.id);
    expect(router.push).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenLastCalledWith(hrefOf(ITEM_TWO));
    await settle();
  });

  // Every page load ends with a `pageshow`, right after `load`. A row can be opened before that: one slow
  // image is enough to hold `load` back. That `pageshow` says nothing about the document that is opening.
  it.each([
    ["with persisted false", () => pageShown(false)],
    ["without persisted", () => windowEvent("pageshow")],
  ] as const)("the pageshow that ends an ordinary page load, %s, does not end the wait", async (_label, loaded) => {
    const { store } = await mountStrip([ITEM, ITEM_TWO, ITEM_THREE]);
    act(() => opens()[0]!.focus());
    open(0);
    await settle();
    notificationApi.list.mockResolvedValue({ items: [ITEM_TWO, ITEM_THREE], unreadCount: 2 });
    await act(() => store.refreshNotifications());

    loaded();

    expect(rowIds()).toEqual([ITEM.id, ITEM_TWO.id, ITEM_THREE.id]);
    expect(heading(3)).toBeVisible();
    expect(opens()[0]).toHaveFocus();
    // The rows still do nothing: a second click on the same spot, another row, Mark as read, Mark all read.
    open(0);
    open(1);
    fireEvent.click(dismisses()[1]!, { detail: 1 });
    fireEvent.click(readAll(), { detail: 1 });
    expect(notificationApi.read).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(notificationApi.readAll).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledExactlyOnceWith(hrefOf(ITEM));

    // The same event for a page the browser had kept still ends it.
    pageShown(true);
    expect(rowIds()).toEqual([ITEM_TWO.id, ITEM_THREE.id]);
    open(0);
    expect(router.push).toHaveBeenLastCalledWith(hrefOf(ITEM_TWO));
    await settle();
  });

  it("the pageshow that ends an ordinary page load leaves the limits running: 30 seconds, or 8 from a page load", async () => {
    await mountStrip([ITEM, ITEM_TWO, ITEM_THREE]);
    fakeTimers();

    open(0);
    await settle();
    elapse(300);
    pageShown(false);
    elapse(29_699);
    expect(rowIds()).toEqual([ITEM.id, ITEM_TWO.id, ITEM_THREE.id]);
    elapse(1);
    expect(rowIds()).toEqual([ITEM_TWO.id, ITEM_THREE.id]);

    open(0);
    await settle();
    windowEvent("beforeunload");
    pageShown(false);
    elapse(7_999);
    expect(rowIds()).toEqual([ITEM_TWO.id, ITEM_THREE.id]);
    elapse(1);
    expect(rowIds()).toEqual([ITEM_THREE.id]);
  });

  it("waits 30 seconds at most, and every open waits anew", async () => {
    await mountStrip([ITEM, ITEM_TWO, ITEM_THREE]);
    fakeTimers();

    open(0);
    await settle();
    elapse(29_999);
    open(1);
    expect(rowIds()).toEqual([ITEM.id, ITEM_TWO.id, ITEM_THREE.id]);
    expect(router.push).toHaveBeenCalledOnce();
    elapse(1);
    expect(rowIds()).toEqual([ITEM_TWO.id, ITEM_THREE.id]);

    open(0);
    await settle();
    expect(router.push).toHaveBeenLastCalledWith(hrefOf(ITEM_TWO));
    elapse(29_999);
    open(1);
    expect(rowIds()).toEqual([ITEM_TWO.id, ITEM_THREE.id]);
    expect(router.push).toHaveBeenCalledTimes(2);
    elapse(1);
    expect(rowIds()).toEqual([ITEM_THREE.id]);
  });

  // The app router falls back to loading the document as a whole page when its own request fails. The
  // user can stop that load, and nothing tells the page.
  it("waits 8 seconds once the browser has started to load a page, counted from then", async () => {
    await mountStrip([ITEM, ITEM_TWO, ITEM_THREE]);
    fakeTimers();

    open(0);
    await settle();
    elapse(1_000);
    windowEvent("beforeunload");
    elapse(7_999);
    open(1);
    expect(rowIds()).toEqual([ITEM.id, ITEM_TWO.id, ITEM_THREE.id]);
    expect(router.push).toHaveBeenCalledOnce();
    elapse(1);
    expect(rowIds()).toEqual([ITEM_TWO.id, ITEM_THREE.id]);

    // The next open waits anew: 30 seconds, or 8 from its own page load.
    open(0);
    await settle();
    elapse(25_000);
    windowEvent("beforeunload");
    elapse(7_999);
    expect(rowIds()).toEqual([ITEM_TWO.id, ITEM_THREE.id]);
    elapse(1);
    expect(rowIds()).toEqual([ITEM_THREE.id]);
    open(0);
    expect(router.push).toHaveBeenLastCalledWith(hrefOf(ITEM_THREE));
    await settle();
  });

  it.each([
    ["30 seconds", () => elapse(30_000)],
    ["Back", () => windowEvent("popstate")],
    ["a page shown again after the browser had kept it", () => pageShown(true)],
    ["8 seconds of a page load", () => {
      windowEvent("beforeunload");
      elapse(8_000);
    }],
  ] as const)("when the only row was opened and the wait ends after %s, the strip's box stays for one second", async (_label, end) => {
    await mountStrip([ITEM]);
    measured();
    fakeTimers();
    open(0);
    fireEvent.click(opens()[0]!, { detail: 2 });
    await settle();
    expect(rowIds()).toEqual([ITEM.id]);

    end();

    expect(strip()).toBeNull();
    expect(status()).toBeNull();
    expect(emptiedBox()).toHaveStyle({ height: `${HEIGHT}px` });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    elapse(999);
    expect(emptiedBox()).not.toBeNull();
    elapse(1);
    expect(emptiedBox()).toBeNull();
    expect(router.push).toHaveBeenCalledOnce();
  });

  it("brings the row back as a live one when marking it read failed", async () => {
    notificationApi.read.mockRejectedValueOnce(new Error("offline"));
    await mountStrip([ITEM, ITEM_TWO]);
    measured();

    open(0);
    await settle();
    await settle();
    expect(rowIds()).toEqual([ITEM.id, ITEM_TWO.id]);
    windowEvent("popstate");

    expect(rowIds()).toEqual([ITEM.id, ITEM_TWO.id]);
    expect(emptiedBox()).toBeNull();
    open(0);
    expect(notificationApi.read).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenCalledTimes(2);
    await settle();
  });

  it.each([
    ["while it waits", () => {}],
    ["while it waits for a page load", () => windowEvent("beforeunload")],
    ["during the box's second", () => elapse(30_000)],
  ] as const)("leaves no timer and no listener behind when the page changes %s", async (_label, before) => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const listened = (spy: typeof added | typeof removed) =>
      spy.mock.calls.filter(([type]) => type === "beforeunload" || type === "popstate" || type === "pageshow").map(([type, listener]) => [type, listener]);
    const { unmount } = await mountStrip([ITEM]);
    expect(listened(added)).toEqual([]);
    fakeTimers();

    open(0);
    await settle();
    expect(listened(added).map(([type]) => type)).toEqual(["beforeunload", "popstate", "pageshow"]);
    expect(vi.getTimerCount()).toBe(1);
    before();
    expect(vi.getTimerCount()).toBe(1);
    unmount();

    expect(listened(removed)).toEqual(listened(added));
    expect(vi.getTimerCount()).toBe(0);
  });
});

// A click or a tap on "Mark all read", or on "Mark as read" of the only row, empties the strip under the
// pointer. The dashboard below would move up into the rest of a double-click, so an empty box keeps the
// strip's place for a moment.
describe("notification strip when a click empties it", () => {
  const HEIGHT = 137.5;
  const measured = () => vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: HEIGHT } as DOMRect);
  const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const settle = () =>
    act(async () => {
      await Promise.resolve();
    });

  it.each([
    ["Mark all read", [ITEM, ITEM_TWO, SHARE], () => readAll()],
    ["Mark all read with one row", [ITEM], () => readAll()],
    ["Mark as read on the only row", [ITEM], () => dismisses()[0]!],
  ] as const)("%s leaves an empty box of the strip's height for one second", async (_label, items, control) => {
    await mountStrip([...items]);
    measured();
    fakeTimers();

    fireEvent.click(control(), { detail: 1 });

    expect(strip()).toBeNull();
    const box = emptiedBox()!;
    expect(box).toHaveStyle({ height: `${HEIGHT}px` });
    expect(box).toHaveClass("mb-8");
    expect(box.childElementCount).toBe(1);
    expect(box.firstElementChild).toBeEmptyDOMElement();
    expect(box.firstElementChild).toHaveAttribute("inert");
    expect(box.querySelectorAll("a, button, input, select, textarea, [tabindex], [role], [aria-live]")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    elapse(999);
    expect(emptiedBox()).toBe(box);
    elapse(1);
    expect(emptiedBox()).toBeNull();
    expect(strip()).toBeNull();
    await settle();
  });

  it("every press on the box starts its second again, and does nothing else", async () => {
    await mountStrip([ITEM, ITEM_TWO]);
    measured();
    fakeTimers();
    fireEvent.click(readAll(), { detail: 1 });
    const box = emptiedBox()!;

    elapse(900);
    fireEvent.pointerDown(box);
    fireEvent.pointerUp(box);
    fireEvent.click(box, { detail: 2 });
    elapse(900);
    fireEvent.pointerDown(box);
    fireEvent.pointerUp(box);
    fireEvent.click(box, { detail: 3 });
    elapse(999);

    expect(emptiedBox()).toBe(box);
    expect(box).toHaveStyle({ height: `${HEIGHT}px` });
    expect(notificationApi.readAll).toHaveBeenCalledOnce();
    expect(notificationApi.read).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    elapse(1);
    expect(emptiedBox()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await settle();
  });

  // A press that is held: the box under it must not go away, or the release lands on the dashboard below.
  // The press can end anywhere, so its end is heard on the window.
  it.each([
    ["the pointer is released on the box", () => fireEvent.pointerUp(emptiedBox()!)],
    ["the pointer is released outside the box", () => fireEvent.pointerUp(document.body)],
    ["a pointerup reaches the window only", () => fireEvent(window, new Event("pointerup"))],
    ["the press is cancelled, as when a touch becomes a scroll", () => fireEvent.pointerCancel(document.body)],
    ["a pointercancel reaches the window only", () => fireEvent(window, new Event("pointercancel"))],
  ] as const)("a press held on the box keeps it, and its second starts when %s", async (_label, endPress) => {
    await mountStrip([ITEM, ITEM_TWO]);
    measured();
    fakeTimers();
    fireEvent.click(readAll(), { detail: 1 });
    const box = emptiedBox()!;

    elapse(900);
    fireEvent.pointerDown(box);
    elapse(5_000);

    expect(emptiedBox()).toBe(box);
    expect(box).toHaveStyle({ height: `${HEIGHT}px` });
    expect(strip()).toBeNull();
    endPress();
    elapse(999);
    expect(emptiedBox()).toBe(box);
    elapse(1);
    expect(emptiedBox()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(notificationApi.readAll).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
    await settle();
  });

  it("a press on the box after a held one is held the same way", async () => {
    await mountStrip([ITEM, ITEM_TWO]);
    fakeTimers();
    fireEvent.click(readAll(), { detail: 1 });
    const box = emptiedBox()!;

    fireEvent.pointerDown(box);
    elapse(3_000);
    fireEvent.pointerUp(box);
    elapse(900);
    fireEvent.pointerDown(box);
    elapse(3_000);
    expect(emptiedBox()).toBe(box);
    fireEvent.pointerUp(box);
    elapse(999);
    expect(emptiedBox()).toBe(box);
    elapse(1);

    expect(emptiedBox()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await settle();
  });

  it("a press whose end never arrives is given up after 10 seconds", async () => {
    await mountStrip([ITEM, ITEM_TWO]);
    fakeTimers();
    fireEvent.click(readAll(), { detail: 1 });
    const box = emptiedBox()!;

    elapse(900);
    fireEvent.pointerDown(box);
    elapse(9_999);

    expect(emptiedBox()).toBe(box);
    elapse(1);
    expect(emptiedBox()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await settle();
  });

  // The end of a press somewhere else is not the box's business: it listens only while it is pressed.
  it("the end of a press that did not start on the box does not start its second again", async () => {
    const added = vi.spyOn(window, "addEventListener");
    await mountStrip([ITEM, ITEM_TWO]);
    fakeTimers();
    fireEvent.click(readAll(), { detail: 1 });
    const box = emptiedBox()!;

    elapse(900);
    fireEvent.pointerUp(document.body);
    fireEvent.pointerCancel(document.body);
    elapse(99);

    expect(emptiedBox()).toBe(box);
    elapse(1);
    expect(emptiedBox()).toBeNull();
    expect(added.mock.calls.filter(([type]) => type === "pointerup" || type === "pointercancel")).toEqual([]);
    await settle();
  });

  it.each([
    ["while a press is held on the box", () => {}],
    ["in the box's second after a held press", () => fireEvent.pointerUp(emptiedBox()!)],
  ] as const)("leaves no timer and no listener behind when the page changes %s", async (_label, before) => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const listened = (spy: typeof added | typeof removed) =>
      spy.mock.calls.filter(([type]) => type === "pointerup" || type === "pointercancel").map(([type, listener, options]) => [type, listener, options]);
    const { unmount } = await mountStrip([ITEM, ITEM_TWO]);
    fakeTimers();
    fireEvent.click(readAll(), { detail: 1 });
    expect(listened(added)).toEqual([]);

    fireEvent.pointerDown(emptiedBox()!);
    expect(listened(added).map(([type]) => type)).toEqual(["pointerup", "pointercancel"]);
    expect(vi.getTimerCount()).toBe(1);
    before();
    expect(vi.getTimerCount()).toBe(1);
    unmount();

    expect(listened(removed)).toEqual(listened(added));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says it once: the status line takes the focus, the box says nothing", async () => {
    await mountStrip([ITEM, ITEM_TWO]);
    measured();
    act(() => readAll().focus());

    fireEvent.click(readAll(), { detail: 1 });

    expect(screen.getAllByRole("status")).toEqual([status()]);
    expect(status()).toHaveFocus();
    expect(status()).toHaveTextContent("No unread notifications");
    expect(emptiedBox()!.textContent).toBe("");
    expect(status()!.compareDocumentPosition(emptiedBox()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await settle();
  });

  it.each([
    ["Mark all read from the keyboard", [ITEM, ITEM_TWO], () => fireEvent.click(readAll())],
    ["Mark as read on the only row from the keyboard", [ITEM], () => fireEvent.click(dismisses()[0]!)],
    ["Delete on the only row", [ITEM], () => press(opens()[0]!, "Delete")],
  ] as const)("%s leaves no box", async (_label, items, action) => {
    await mountStrip([...items]);
    measured();

    action();

    expect(strip()).toBeNull();
    expect(emptiedBox()).toBeNull();
    await settle();
  });

  it("a click on Mark as read that leaves a row behind keeps no box, also when the keyboard then empties the strip", async () => {
    await mountStrip([ITEM, ITEM_TWO]);
    measured();

    fireEvent.click(dismisses()[0]!, { detail: 1 });
    expect(rowIds()).toEqual([ITEM_TWO.id]);
    expect(emptiedBox()).toBeNull();
    press(opens()[0]!, "Delete");

    expect(strip()).toBeNull();
    expect(emptiedBox()).toBeNull();
    await settle();
  });

  it("gives its place back to the rows when marking them read failed", async () => {
    notificationApi.readAll.mockRejectedValueOnce(new Error("offline"));
    await mountStrip([ITEM, ITEM_TWO]);
    measured();

    fireEvent.click(readAll(), { detail: 1 });
    expect(emptiedBox()).not.toBeNull();
    await waitFor(() => expect(rowIds()).toEqual([ITEM.id, ITEM_TWO.id]));

    expect(emptiedBox()).toBeNull();
    fireEvent.click(opens()[1]!, { detail: 1 });
    expect(router.push).toHaveBeenCalledExactlyOnceWith(hrefOf(ITEM_TWO));
    await settle();
  });
});
