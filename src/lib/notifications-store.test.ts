// @vitest-environment jsdom
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { NotificationDto, NotificationsPageDto } from "./api";

const notificationApi = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  readAll: vi.fn(),
  readRefs: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: { notifications: notificationApi } }));

const EMPTY_PAGE: NotificationsPageDto = { items: [], unreadCount: 0 };
const ITEM: Extract<NotificationDto, { documentId: string }> = {
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function mountStore() {
  const store = await import("./notifications-store");
  const hook = renderHook(() => store.useNotifications());
  return { store, ...hook };
}

async function mountLoaded(page: NotificationsPageDto) {
  notificationApi.list.mockResolvedValueOnce(page);
  const mounted = await mountStore();
  await waitFor(() => expect(mounted.result.current.loaded).toBe(true));
  return mounted;
}

const ITEM_TWO: NotificationDto = {
  ...ITEM,
  id: "notification-two",
  documentId: "document-two",
  documentTitle: "Release notes",
  refId: "thread-two",
};
const REF_ITEMS: NotificationDto[] = [
  { ...ITEM, id: "notification-a", refId: "thread-a" },
  { ...ITEM, id: "notification-b", refId: "thread-b" },
  { ...ITEM, id: "notification-c", refId: "thread-c" },
];

beforeEach(() => {
  vi.resetModules();
  notificationApi.list.mockReset();
  notificationApi.read.mockReset();
  notificationApi.readAll.mockReset();
  notificationApi.readRefs.mockReset();
});

afterEach(() => cleanup());

describe("notification sentences", () => {
  it("directs disabled webhook recovery to the existing hook", async () => {
    const { sentence } = await import("./notifications-store");
    const text = sentence({
      kind: "webhook.disabled",
      documentTitle: "Launch plan",
      snippet: "https://receiver.example/webhook",
    });

    expect(text).toContain("enable the existing hook in Settings");
    expect(text).not.toContain("re-add it");
  });
});

describe("notification loading", () => {
  it("reports the first load as pending until a genuine empty success arrives", async () => {
    const pending = deferred<NotificationsPageDto>();
    notificationApi.list.mockReturnValueOnce(pending.promise);

    const { result } = await mountStore();
    expect(notificationApi.list).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ items: [], unreadCount: 0, loaded: false, loading: true, loadError: false });

    await act(async () => {
      pending.resolve(EMPTY_PAGE);
      await pending.promise;
    });

    expect(result.current).toMatchObject({ items: [], unreadCount: 0, loaded: true, loading: false, loadError: false });
  });

  it("makes a first-load failure retryable and shares repeated Retry calls with the in-flight request", async () => {
    const retry = deferred<NotificationsPageDto>();
    notificationApi.list.mockRejectedValueOnce(new Error("temporarily unavailable")).mockReturnValueOnce(retry.promise);

    const { store, result } = await mountStore();
    await waitFor(() => expect(result.current).toMatchObject({ loaded: false, loading: false, loadError: true }));

    let first!: Promise<void>;
    let repeated!: Promise<void>;
    act(() => {
      first = store.refreshNotifications();
      repeated = store.refreshNotifications();
    });

    expect(first).toBe(repeated);
    expect(notificationApi.list).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ loaded: false, loading: true, loadError: true });

    await act(async () => {
      retry.resolve({ items: [ITEM], unreadCount: 1 });
      await first;
    });

    expect(result.current).toMatchObject({ items: [ITEM], unreadCount: 1, loaded: true, loading: false, loadError: false });
  });

  it("retains cached notifications and their unread count after a later refresh fails", async () => {
    notificationApi.list.mockResolvedValueOnce({ items: [ITEM], unreadCount: 1 });
    const { store, result } = await mountStore();
    await waitFor(() => expect(result.current.loaded).toBe(true));

    notificationApi.list.mockRejectedValueOnce(new Error("poll failed"));
    await act(async () => {
      await store.refreshNotifications();
    });

    expect(result.current).toMatchObject({ items: [ITEM], unreadCount: 1, loaded: true, loading: false, loadError: false });
  });

  it("treats a first-load 401 as anonymous and stops requesting without exposing a recovery error", async () => {
    notificationApi.list.mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { status: 401 }));
    const { store, result } = await mountStore();
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current).toMatchObject({ items: [], unreadCount: 0, loaded: false, loading: false, loadError: false });
    await act(async () => {
      await store.refreshNotifications();
    });
    expect(notificationApi.list).toHaveBeenCalledTimes(1);
  });
});

describe("notification read ownership", () => {
  it("reports failed and retried HTTP confirmation without requiring a notification subscriber", async () => {
    const store = await import("./notifications-store");
    notificationApi.read.mockRejectedValueOnce(new Error("write unavailable")).mockResolvedValueOnce({ ok: true, changed: true });
    expect(await store.markNotificationReadConfirmed("folder-request")).toBe(false);
    expect(await store.markNotificationReadConfirmed("folder-request")).toBe(true);
    expect(notificationApi.read).toHaveBeenCalledTimes(2);
    expect(notificationApi.list).not.toHaveBeenCalled();
  });

  it("shares the actual write between optimistic and confirmed callers without confusing an optimistic read with success", async () => {
    const pending = deferred<{ ok: true; changed: boolean }>();
    notificationApi.read.mockReturnValueOnce(pending.promise);
    const { store, result } = await mountLoaded({ items: [ITEM], unreadCount: 1 });
    let optimistic!: Promise<void>;
    let confirmed!: Promise<boolean>;
    act(() => {
      optimistic = store.markNotificationRead(ITEM.id);
      confirmed = store.markNotificationReadConfirmed(ITEM.id);
    });
    expect(result.current.items[0].readAt).not.toBeNull();
    expect(notificationApi.read).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.reject(new Error("write failed"));
      await optimistic;
      expect(await confirmed).toBe(false);
    });
    expect(result.current.items[0].readAt).toBeNull();
    expect(result.current.readError).toMatchObject({ operation: "single", notificationId: ITEM.id });
  });

  it("shares duplicate single reads while independent ids settle and retry separately", async () => {
    const firstRead = deferred<{ ok: true; changed: boolean }>();
    const secondRead = deferred<{ ok: true; changed: boolean }>();
    const retry = deferred<{ ok: true; changed: boolean }>();
    notificationApi.read.mockImplementation((id: string) => {
      if (id === ITEM.id) return firstRead.promise;
      return notificationApi.read.mock.calls.filter(([calledId]) => calledId === ITEM_TWO.id).length === 1 ? secondRead.promise : retry.promise;
    });
    const { store, result } = await mountLoaded({ items: [ITEM, ITEM_TWO], unreadCount: 2 });

    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = store.markNotificationRead(ITEM.id);
      duplicate = store.markNotificationRead(ITEM.id);
      second = store.markNotificationRead(ITEM_TWO.id);
    });

    expect(duplicate).toBe(first);
    expect(notificationApi.read).toHaveBeenCalledTimes(2);
    expect(result.current.items.every((notification) => notification.readAt !== null)).toBe(true);
    expect(result.current.unreadCount).toBe(0);

    await act(async () => {
      firstRead.resolve({ ok: true, changed: true });
      secondRead.reject(new Error("read failed"));
      await Promise.all([first, second]);
    });

    expect(result.current.items.find((notification) => notification.id === ITEM.id)?.readAt).not.toBeNull();
    expect(result.current.items.find((notification) => notification.id === ITEM_TWO.id)?.readAt).toBeNull();
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.readError).toMatchObject({ operation: "single", notificationId: ITEM_TWO.id });

    let retried!: Promise<void>;
    act(() => {
      retried = store.retryNotificationRead(result.current.readError!);
    });
    expect(notificationApi.read).toHaveBeenCalledTimes(3);
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.readErrorPending).toBe(true);

    await act(async () => {
      retry.resolve({ ok: true, changed: true });
      await retried;
    });

    expect(result.current.items.every((notification) => notification.readAt !== null)).toBe(true);
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.readError).toBeNull();
  });

  it("gives read-all one owner and restores only rows it optimistically changed", async () => {
    const pending = deferred<{ ok: true; count: number }>();
    const alreadyRead = { ...ITEM_TWO, readAt: "2026-09-07T12:05:00.000Z" };
    notificationApi.readAll.mockReturnValueOnce(pending.promise);
    const { store, result } = await mountLoaded({ items: [ITEM, alreadyRead], unreadCount: 2 });

    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = store.markAllNotificationsRead();
      duplicate = store.markAllNotificationsRead();
    });

    expect(duplicate).toBe(first);
    expect(notificationApi.readAll).toHaveBeenCalledOnce();
    expect(result.current.readAllPending).toBe(true);
    expect(result.current.unreadCount).toBe(0);

    await act(async () => {
      pending.reject(new Error("read all failed"));
      await first;
    });

    expect(result.current.items.find((notification) => notification.id === ITEM.id)?.readAt).toBeNull();
    expect(result.current.items.find((notification) => notification.id === ITEM_TWO.id)?.readAt).toBe(alreadyRead.readAt);
    expect(result.current.unreadCount).toBe(2);
    expect(result.current.readAllPending).toBe(false);
    expect(result.current.readError).toMatchObject({ operation: "all" });
  });

  it("commits read-all and a newer single read when both succeed out of order", async () => {
    const all = deferred<{ ok: true; count: number }>();
    const single = deferred<{ ok: true; changed: boolean }>();
    notificationApi.readAll.mockReturnValueOnce(all.promise);
    notificationApi.read.mockReturnValueOnce(single.promise);
    const { store, result } = await mountLoaded({ items: [ITEM, ITEM_TWO], unreadCount: 2 });

    let allOperation!: Promise<void>;
    let singleOperation!: Promise<void>;
    act(() => {
      allOperation = store.markAllNotificationsRead();
      singleOperation = store.markNotificationRead(ITEM.id);
    });

    await act(async () => {
      single.resolve({ ok: true, changed: true });
      await singleOperation;
      all.resolve({ ok: true, count: 2 });
      await allOperation;
    });

    expect(notificationApi.readAll).toHaveBeenCalledOnce();
    expect(notificationApi.read).toHaveBeenCalledOnce();
    expect(result.current.items.every((notification) => notification.readAt !== null)).toBe(true);
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.readError).toBeNull();
    expect(result.current.readAllPending).toBe(false);
  });

  it("rolls back only the unconfirmed part of read-all and retries it", async () => {
    const all = deferred<{ ok: true; count: number }>();
    const single = deferred<{ ok: true; changed: boolean }>();
    const retry = deferred<{ ok: true; count: number }>();
    notificationApi.readAll.mockReturnValueOnce(all.promise).mockReturnValueOnce(retry.promise);
    notificationApi.read.mockReturnValueOnce(single.promise);
    const { store, result } = await mountLoaded({ items: [ITEM, ITEM_TWO], unreadCount: 2 });

    let allOperation!: Promise<void>;
    let singleOperation!: Promise<void>;
    act(() => {
      allOperation = store.markAllNotificationsRead();
      singleOperation = store.markNotificationRead(ITEM.id);
    });

    await act(async () => {
      single.resolve({ ok: true, changed: true });
      await singleOperation;
      all.reject(new Error("older read all failed"));
      await allOperation;
    });

    expect(result.current.items.find((notification) => notification.id === ITEM.id)?.readAt).not.toBeNull();
    expect(result.current.items.find((notification) => notification.id === ITEM_TWO.id)?.readAt).toBeNull();
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.readError).toMatchObject({ operation: "all" });
    expect(result.current.readAllPending).toBe(false);

    let retryOperation!: Promise<void>;
    act(() => {
      retryOperation = store.retryNotificationRead(result.current.readError!);
    });

    expect(notificationApi.readAll).toHaveBeenCalledTimes(2);
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.readAllPending).toBe(true);
    expect(result.current.readErrorPending).toBe(true);

    await act(async () => {
      retry.resolve({ ok: true, count: 1 });
      await retryOperation;
    });

    expect(result.current.items.every((notification) => notification.readAt !== null)).toBe(true);
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.readError).toBeNull();
    expect(result.current.readAllPending).toBe(false);
  });

  it("uses stable ref-set owners while different ref sets remain independent", async () => {
    const firstRefs = deferred<{ ok: true; count: number }>();
    const secondRefs = deferred<{ ok: true; count: number }>();
    const firstDocumentItems = [
      ITEM,
      { ...ITEM_TWO, documentId: ITEM.documentId, refId: "thread-three" },
    ];
    notificationApi.readRefs.mockImplementation((_documentId: string, refIds: string[]) =>
      refIds.includes(ITEM.refId) ? firstRefs.promise : secondRefs.promise,
    );
    const { store, result } = await mountLoaded({ items: firstDocumentItems, unreadCount: 2 });

    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = store.markRefsRead(ITEM.documentId, ["reply-one", ITEM.refId]);
      duplicate = store.markRefsRead(ITEM.documentId, [ITEM.refId, "reply-one", ITEM.refId]);
      second = store.markRefsRead(ITEM.documentId, ["thread-three"]);
    });

    expect(duplicate).toBe(first);
    expect(notificationApi.readRefs).toHaveBeenCalledTimes(2);
    expect(result.current.unreadCount).toBe(0);

    await act(async () => {
      secondRefs.resolve({ ok: true, count: 1 });
      await second;
      firstRefs.reject(new Error("thread read failed"));
      await first;
    });

    expect(result.current.items.find((notification) => notification.id === ITEM.id)?.readAt).toBeNull();
    expect(result.current.items.find((notification) => notification.id === ITEM_TWO.id)?.readAt).not.toBeNull();
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.readError).toMatchObject({
      operation: "refs",
      documentId: ITEM.documentId,
      refIds: ["reply-one", ITEM.refId],
    });
  });

  it("commits partially overlapping ref sets when both succeed out of order", async () => {
    const firstRefs = deferred<{ ok: true; count: number }>();
    const secondRefs = deferred<{ ok: true; count: number }>();
    notificationApi.readRefs.mockReturnValueOnce(firstRefs.promise).mockReturnValueOnce(secondRefs.promise);
    const { store, result } = await mountLoaded({ items: REF_ITEMS, unreadCount: 3 });

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = store.markRefsRead(ITEM.documentId, ["thread-a", "thread-b"]);
      second = store.markRefsRead(ITEM.documentId, ["thread-b", "thread-c"]);
    });

    expect(notificationApi.readRefs).toHaveBeenCalledTimes(2);
    expect(result.current.unreadCount).toBe(0);

    await act(async () => {
      secondRefs.resolve({ ok: true, count: 2 });
      await second;
      firstRefs.resolve({ ok: true, count: 2 });
      await first;
    });

    expect(result.current.items.every((notification) => notification.readAt !== null)).toBe(true);
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.readError).toBeNull();
    expect(result.current.readErrorPending).toBe(false);
  });

  it("retries only the unconfirmed part of a partially overlapping ref failure", async () => {
    const firstRefs = deferred<{ ok: true; count: number }>();
    const secondRefs = deferred<{ ok: true; count: number }>();
    const retry = deferred<{ ok: true; count: number }>();
    notificationApi.readRefs.mockReturnValueOnce(firstRefs.promise).mockReturnValueOnce(secondRefs.promise).mockReturnValueOnce(retry.promise);
    const { store, result } = await mountLoaded({ items: REF_ITEMS, unreadCount: 3 });

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = store.markRefsRead(ITEM.documentId, ["thread-a", "thread-b"]);
      second = store.markRefsRead(ITEM.documentId, ["thread-b", "thread-c"]);
    });

    await act(async () => {
      secondRefs.resolve({ ok: true, count: 2 });
      await second;
      firstRefs.reject(new Error("partial thread read failed"));
      await first;
    });

    expect(result.current.items.map((notification) => [notification.refId, notification.readAt !== null])).toEqual([
      ["thread-a", false],
      ["thread-b", true],
      ["thread-c", true],
    ]);
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.readError).toMatchObject({
      operation: "refs",
      documentId: ITEM.documentId,
      refIds: ["thread-a"],
    });

    await act(async () => {
      await store.markRefsRead(ITEM.documentId, ["thread-a", "thread-b"]);
    });
    expect(notificationApi.readRefs).toHaveBeenCalledTimes(2);

    let retryOperation!: Promise<void>;
    act(() => {
      retryOperation = store.retryNotificationRead(result.current.readError!);
    });

    expect(notificationApi.readRefs).toHaveBeenCalledTimes(3);
    expect(notificationApi.readRefs).toHaveBeenLastCalledWith(ITEM.documentId, ["thread-a"]);
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.readErrorPending).toBe(true);

    await act(async () => {
      retry.resolve({ ok: true, count: 1 });
      await retryOperation;
    });

    expect(result.current.items.every((notification) => notification.readAt !== null)).toBe(true);
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.readError).toBeNull();
    expect(result.current.readErrorPending).toBe(false);
  });

  it("holds a failed active-thread effect for explicit retry while unrelated refs keep progressing", async () => {
    const first = deferred<{ ok: true; count: number }>();
    const unrelated = deferred<{ ok: true; count: number }>();
    const retry = deferred<{ ok: true; count: number }>();
    const unexpected = deferred<{ ok: true; count: number }>();
    let failedRefCalls = 0;
    notificationApi.readRefs.mockImplementation((_documentId: string, refIds: string[]) => {
      if (!refIds.includes("thread-a")) return unrelated.promise;
      failedRefCalls++;
      if (failedRefCalls === 1) return first.promise;
      if (failedRefCalls === 2) return retry.promise;
      return unexpected.promise;
    });
    const { store, result } = await mountLoaded({ items: [REF_ITEMS[0]!, REF_ITEMS[1]!], unreadCount: 2 });
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);

    function useActiveThreadRead() {
      const unreadRefs = store.useUnreadRefs(ITEM.documentId);
      const unread = unreadRefs.has("thread-a");
      useEffect(() => {
        if (unread) void store.markRefsRead(ITEM.documentId, ["thread-a"]);
      }, [unread]);
    }
    const activeThread = renderHook(useActiveThreadRead);
    await waitFor(() => expect(failedRefCalls).toBe(1));

    await act(async () => {
      first.reject(new Error("thread read failed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.readError).toMatchObject({ operation: "refs", refIds: ["thread-a"] }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(failedRefCalls).toBe(1);
    expect(notificationApi.readRefs).toHaveBeenCalledOnce();
    expect(result.current.items.find((notification) => notification.refId === "thread-a")?.readAt).toBeNull();
    expect(result.current.unreadCount).toBe(2);

    let unrelatedOperation!: Promise<void>;
    act(() => {
      unrelatedOperation = store.markRefsRead(ITEM.documentId, ["thread-b"]);
    });
    expect(notificationApi.readRefs).toHaveBeenCalledTimes(2);
    await act(async () => {
      unrelated.resolve({ ok: true, count: 1 });
      await unrelatedOperation;
    });
    expect(result.current.items.find((notification) => notification.refId === "thread-b")?.readAt).not.toBeNull();
    expect(result.current.readError).toMatchObject({ operation: "refs", refIds: ["thread-a"] });

    const firstFailure = result.current.readError!;
    let retryOperation!: Promise<void>;
    act(() => {
      retryOperation = store.retryNotificationRead(firstFailure);
    });
    expect(failedRefCalls).toBe(2);
    expect(notificationApi.readRefs).toHaveBeenCalledTimes(3);
    expect(notificationApi.readRefs).toHaveBeenLastCalledWith(ITEM.documentId, ["thread-a"]);
    expect(result.current.readErrorPending).toBe(true);

    await act(async () => {
      retry.reject(new Error("thread retry failed"));
      await retryOperation;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(failedRefCalls).toBe(2);
    expect(notificationApi.readRefs).toHaveBeenCalledTimes(3);
    expect(result.current.readError).toMatchObject({ operation: "refs", refIds: ["thread-a"] });
    expect(result.current.readError?.id).not.toBe(firstFailure.id);
    expect(result.current.readErrorPending).toBe(false);
    expect(result.current.items.find((notification) => notification.refId === "thread-a")?.readAt).toBeNull();
    expect(result.current.unreadCount).toBe(1);
    expect(unhandled).not.toHaveBeenCalled();

    activeThread.unmount();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("clears an older single-read failure after read-all confirms it", async () => {
    notificationApi.read.mockRejectedValueOnce(new Error("single read failed"));
    notificationApi.readAll.mockResolvedValueOnce({ ok: true, count: 1 });
    const { store, result } = await mountLoaded({ items: [ITEM], unreadCount: 1 });

    await act(async () => {
      await store.markNotificationRead(ITEM.id);
    });
    expect(result.current.readError).toMatchObject({ operation: "single", notificationId: ITEM.id });

    await act(async () => {
      await store.markAllNotificationsRead();
    });

    expect(result.current.items[0]?.readAt).not.toBeNull();
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.readError).toBeNull();
  });

  it("keeps the loaded-empty ref optimization", async () => {
    const { store } = await mountLoaded(EMPTY_PAGE);

    await act(async () => {
      await store.markRefsRead(ITEM.documentId, [ITEM.refId]);
    });

    expect(notificationApi.readRefs).not.toHaveBeenCalled();
  });

  it("lets a newer poll supersede a late read failure without resurrecting or reporting it", async () => {
    const read = deferred<{ ok: true; changed: boolean }>();
    const poll = deferred<NotificationsPageDto>();
    notificationApi.read.mockReturnValueOnce(read.promise);
    const { store, result } = await mountLoaded({ items: [ITEM], unreadCount: 1 });
    notificationApi.list.mockReturnValueOnce(poll.promise);

    let readOperation!: Promise<void>;
    let refresh!: Promise<void>;
    act(() => {
      readOperation = store.markNotificationRead(ITEM.id);
      refresh = store.refreshNotifications();
    });

    await act(async () => {
      poll.resolve({ items: [{ ...ITEM, readAt: "2026-09-07T12:10:00.000Z" }], unreadCount: 0 });
      await refresh;
      read.reject(new Error("late read failure"));
      await readOperation;
    });

    expect(result.current.items[0]?.readAt).toBe("2026-09-07T12:10:00.000Z");
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.readError).toBeNull();
  });

  it("keeps a read optimistic when a later poll still contains the stale unread row", async () => {
    const read = deferred<{ ok: true; changed: boolean }>();
    const poll = deferred<NotificationsPageDto>();
    notificationApi.read.mockReturnValueOnce(read.promise);
    const { store, result } = await mountLoaded({ items: [ITEM], unreadCount: 1 });
    notificationApi.list.mockReturnValueOnce(poll.promise);

    let readOperation!: Promise<void>;
    let refresh!: Promise<void>;
    act(() => {
      readOperation = store.markNotificationRead(ITEM.id);
      refresh = store.refreshNotifications();
    });

    await act(async () => {
      poll.resolve({ items: [ITEM], unreadCount: 1 });
      await refresh;
    });

    expect(result.current.items[0]?.readAt).not.toBeNull();
    expect(result.current.unreadCount).toBe(0);

    await act(async () => {
      read.resolve({ ok: true, changed: true });
      await readOperation;
    });

    expect(result.current.items[0]?.readAt).not.toBeNull();
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.readError).toBeNull();
  });

  it("does not let an older poll supersede a read started after it", async () => {
    const poll = deferred<NotificationsPageDto>();
    const read = deferred<{ ok: true; changed: boolean }>();
    const { store, result } = await mountLoaded({ items: [ITEM], unreadCount: 1 });
    notificationApi.list.mockReturnValueOnce(poll.promise);
    notificationApi.read.mockReturnValueOnce(read.promise);

    let refresh!: Promise<void>;
    let readOperation!: Promise<void>;
    act(() => {
      refresh = store.refreshNotifications();
      readOperation = store.markNotificationRead(ITEM.id);
    });

    await act(async () => {
      poll.resolve({ items: [ITEM], unreadCount: 1 });
      await refresh;
    });

    expect(result.current.items[0]?.readAt).not.toBeNull();
    expect(result.current.unreadCount).toBe(0);

    await act(async () => {
      read.reject(new Error("newer read failed"));
      await readOperation;
    });

    expect(result.current.items[0]?.readAt).toBeNull();
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.readError).toMatchObject({ operation: "single", notificationId: ITEM.id });
  });

  it("does not let an out-of-order older failure replace a newer failure", async () => {
    const first = deferred<{ ok: true; changed: boolean }>();
    const second = deferred<{ ok: true; changed: boolean }>();
    notificationApi.read.mockImplementation((id: string) => (id === ITEM.id ? first.promise : second.promise));
    const { store, result } = await mountLoaded({ items: [ITEM, ITEM_TWO], unreadCount: 2 });

    let firstOperation!: Promise<void>;
    let secondOperation!: Promise<void>;
    act(() => {
      firstOperation = store.markNotificationRead(ITEM.id);
      secondOperation = store.markNotificationRead(ITEM_TWO.id);
    });

    await act(async () => {
      second.reject(new Error("newer failure"));
      await secondOperation;
      first.reject(new Error("older failure"));
      await firstOperation;
    });

    expect(result.current.items.every((notification) => notification.readAt === null)).toBe(true);
    expect(result.current.unreadCount).toBe(2);
    expect(result.current.readError).toMatchObject({ operation: "single", notificationId: ITEM_TWO.id });
  });

  it("handles a late rejection after the final subscriber unmounts", async () => {
    const pending = deferred<{ ok: true; changed: boolean }>();
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    notificationApi.read.mockReturnValueOnce(pending.promise);
    const { store, unmount } = await mountLoaded({ items: [ITEM], unreadCount: 1 });

    let operation!: Promise<void>;
    act(() => {
      operation = store.markNotificationRead(ITEM.id);
    });
    unmount();

    pending.reject(new Error("late rejection"));
    await operation;
    await Promise.resolve();

    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});
