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
  vi.restoreAllMocks();
});

describe("notification strip presentation", () => {
  it("renders nothing until there is something unread", async () => {
    await mountStrip([READ]);
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
    expect(share).toHaveTextContent("@bob shared ‘Shared brief’ with you as viewer");
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
    expect(rowIds()).toEqual([ITEM_TWO.id]);
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

  // Double submit: the first click takes the row out of the list, so later clicks have nothing to land on.
  it.each([false, true])("opens a notification once however often it is clicked (Strict Mode: %s)", async (strict) => {
    const pending = deferred<{ ok: true }>();
    notificationApi.read.mockReturnValue(pending.promise);
    await mountStrip([ITEM, ITEM_TWO], { strict });
    const open = opens()[0]!;
    const dismiss = dismisses()[0]!;

    fireEvent.click(open);
    fireEvent.click(open);
    fireEvent.doubleClick(open);
    fireEvent.click(dismiss);

    expect(open).not.toBeInTheDocument();
    expect(notificationApi.read).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(router.push).toHaveBeenCalledOnce();
    expect(rowIds()).toEqual([ITEM_TWO.id]);
    await act(async () => {
      pending.resolve({ ok: true });
      await pending.promise;
    });
    expect(rowIds()).toEqual([ITEM_TWO.id]);
  });

  it("Mark as read takes only its row away, once, without navigating", async () => {
    await mountStrip([ITEM, ITEM_TWO, ITEM_THREE]);
    const dismiss = dismisses()[1]!;

    fireEvent.click(dismiss);
    fireEvent.click(dismiss);

    expect(notificationApi.read).toHaveBeenCalledExactlyOnceWith(ITEM_TWO.id);
    expect(router.push).not.toHaveBeenCalled();
    expect(rowIds()).toEqual([ITEM.id, ITEM_THREE.id]);
    expect(screen.getByRole("heading", { name: /Notifications\s*2/ })).toBeVisible();
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
