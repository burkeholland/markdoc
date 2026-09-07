// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

import { NotificationsBell } from "./notifications-bell";

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

function openBell(state: BellState, onOpen = vi.fn()) {
  store.useNotifications.mockReturnValue(state);
  const view = render(
    <TooltipProvider>
      <NotificationsBell onOpen={onOpen} />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByTestId("notifications-bell"));
  return view;
}

beforeEach(() => {
  store.useNotifications.mockReset();
  store.refreshNotifications.mockReset().mockResolvedValue(undefined);
  store.markAllNotificationsRead.mockReset();
  store.markNotificationRead.mockReset();
  store.retryNotificationRead.mockReset();
});

describe("notification read actions", () => {
  it("claims a single read before opening the item once", () => {
    const order: string[] = [];
    const onOpen = vi.fn(() => order.push("open"));
    store.markNotificationRead.mockImplementation(() => {
      order.push("read");
      return Promise.resolve();
    });
    openBell({ ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true }, onOpen);

    fireEvent.click(screen.getByTestId("notification-item"));

    expect(order).toEqual(["read", "open"]);
    expect(store.markNotificationRead).toHaveBeenCalledWith(ITEM.id);
    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(ITEM);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("disables read-all while pending and presents one retryable rollback", () => {
    const failure: NotificationReadError = {
      id: 1,
      operationId: 1,
      operation: "all",
      message: "Couldn't mark all notifications as read.",
    };
    const view = openBell({ ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true });
    const readAll = screen.getByRole("button", { name: "Mark all read" });

    fireEvent.click(readAll);
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();

    store.useNotifications.mockReturnValue({
      ...EMPTY,
      items: [{ ...ITEM, readAt: "2026-09-07T12:10:00.000Z" }],
      loaded: true,
      readAllPending: true,
    });
    view.rerender(
      <TooltipProvider>
        <NotificationsBell onOpen={vi.fn()} />
      </TooltipProvider>,
    );

    const pending = screen.getByRole("button", { name: "Marking all…" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("notifications-badge")).toBeNull();

    store.useNotifications.mockReturnValue({
      ...EMPTY,
      items: [ITEM],
      unreadCount: 1,
      loaded: true,
      readError: failure,
    });
    view.rerender(
      <TooltipProvider>
        <NotificationsBell onOpen={vi.fn()} />
      </TooltipProvider>,
    );

    expect(screen.getByTestId("notifications-badge")).toHaveTextContent("1");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't mark all notifications as read.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(store.retryNotificationRead).toHaveBeenCalledWith(failure);
    expect(store.retryNotificationRead).toHaveBeenCalledOnce();
  });

  it("disables a mutation retry while its replacement owner is pending", () => {
    const failure: NotificationReadError = {
      id: 2,
      operationId: 2,
      operation: "single",
      message: "Couldn't mark this notification as read.",
      notificationId: ITEM.id,
    };
    openBell({
      ...EMPTY,
      items: [{ ...ITEM, readAt: "2026-09-07T12:10:00.000Z" }],
      loaded: true,
      readError: failure,
      readErrorPending: true,
    });

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
  });
});

afterEach(() => cleanup());

describe("notification bell loading", () => {
  it("shows a neutral first-load state instead of claiming the empty result succeeded", () => {
    openBell({ ...EMPTY, loading: true });

    expect(screen.getByText("Loading notifications…")).toBeVisible();
    expect(screen.queryByText("You're all caught up.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows one Retry action for a first-load failure and exposes its pending state", () => {
    const view = openBell({ ...EMPTY, loadError: true });

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load notifications.");
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(screen.queryByText("You're all caught up.")).toBeNull();

    fireEvent.click(retry);
    expect(store.refreshNotifications).toHaveBeenCalledTimes(1);

    store.useNotifications.mockReturnValue({ ...EMPTY, loading: true, loadError: true });
    view.rerender(
      <TooltipProvider>
        <NotificationsBell onOpen={vi.fn()} />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
  });

  it("shows the unchanged empty-success sentence only after a successful load", () => {
    openBell({ ...EMPTY, loaded: true });

    expect(screen.getByText("You're all caught up.")).toBeVisible();
    expect(screen.queryByText("Loading notifications…")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a cached unread list visible when a background refresh fails", () => {
    openBell({ ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true, loadError: true });

    expect(screen.getByTestId("notification-item")).toHaveTextContent("Alice mentioned you");
    expect(screen.getByTestId("notifications-badge")).toHaveTextContent("1");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("You're all caught up.")).toBeNull();
  });
});
