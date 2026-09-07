// @vitest-environment jsdom
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function mountStore() {
  const store = await import("./notifications-store");
  const hook = renderHook(() => store.useNotifications());
  return { store, ...hook };
}

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
