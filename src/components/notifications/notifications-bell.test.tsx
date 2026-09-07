// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { NotificationDto } from "@/lib/api";
import { TooltipProvider } from "@/components/ui/primitives";

const store = vi.hoisted(() => ({
  useNotifications: vi.fn(),
  refreshNotifications: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn(),
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
}

const EMPTY: BellState = { items: [], unreadCount: 0, loaded: false, loading: false, loadError: false };
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

function openBell(state: BellState) {
  store.useNotifications.mockReturnValue(state);
  const view = render(
    <TooltipProvider>
      <NotificationsBell onOpen={vi.fn()} />
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
    openBell({ items: [ITEM], unreadCount: 1, loaded: true, loading: false, loadError: true });

    expect(screen.getByTestId("notification-item")).toHaveTextContent("Alice mentioned you");
    expect(screen.getByTestId("notifications-badge")).toHaveTextContent("1");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("You're all caught up.")).toBeNull();
  });
});
