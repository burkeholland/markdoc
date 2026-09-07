// @vitest-environment jsdom
import { useLayoutEffect, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

type PopoverOpenChange = (open: boolean) => void;
const capturedPopoverOpenChanges = vi.hoisted(() => [] as PopoverOpenChange[]);

vi.mock("@/lib/notifications-store", () => ({
  ...store,
  sentence: () => "mentioned you",
}));

vi.mock("@/components/ui/primitives", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/primitives")>();
  const ActualPopover = actual.Popover;
  return {
    ...actual,
    Popover: (props: ComponentProps<typeof ActualPopover>) => {
      if (props.onOpenChange) capturedPopoverOpenChanges.push(props.onOpenChange);
      return <ActualPopover {...props} />;
    },
  };
});

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
const REPLACEMENT_ITEM: NotificationDto = {
  ...ITEM,
  kind: "reply",
  documentId: "document-two",
  documentTitle: "Current launch plan",
  actorLogin: "bob",
  actorName: "Bob",
  refId: "thread-two",
  snippet: "This row replaced the old one",
  createdAt: "2026-09-07T13:00:00.000Z",
  readAt: "2026-09-07T13:05:00.000Z",
};

const directRoots: { root: Root; host: HTMLDivElement }[] = [];

function reactHandler<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (!handler) throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return handler as T;
}

function BellBoundary({
  present = true,
  boundary = 0,
  onBoundary,
  ...props
}: NotificationsBellProps & {
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? (
    <TooltipProvider>
      <NotificationsBell {...props} />
    </TooltipProvider>
  ) : null;
}

function createBellRoot(state: BellState, props: NotificationsBellProps) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  directRoots.push({ root, host });
  store.useNotifications.mockReturnValue(state);
  act(() => root.render(<BellBoundary {...props} />));
  return root;
}

function renderBellRoot(root: Root, state: BellState, props: NotificationsBellProps & { present?: boolean; boundary?: number; onBoundary?: () => void }) {
  store.useNotifications.mockReturnValue(state);
  act(() => root.render(<BellBoundary {...props} />));
}

function latestOpenChange(except?: PopoverOpenChange) {
  const callback = capturedPopoverOpenChanges.findLast((candidate) => candidate !== except);
  if (!callback) throw new Error("The popover did not publish an open-change callback");
  return callback;
}

function openDirectBell(callback = latestOpenChange()) {
  act(() => callback(true));
  expect(screen.getByTestId("notifications-popover")).toBeVisible();
}

function captureCurrentActions() {
  return {
    item: reactHandler<() => void>(screen.getByTestId("notification-item"), "onClick"),
    readAll: reactHandler<() => void>(screen.getByTestId("notifications-read-all"), "onClick"),
    retry: reactHandler<() => void>(screen.getByRole("button", { name: "Retry" }), "onClick"),
  };
}

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
  capturedPopoverOpenChanges.length = 0;
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
    const onOpen = vi.fn();
    const view = openBell({ ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true }, onOpen);
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
        <NotificationsBell onOpen={onOpen} />
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
        <NotificationsBell onOpen={onOpen} />
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

afterEach(() => {
  cleanup();
  while (directRoots.length) {
    const mounted = directRoots.pop()!;
    act(() => mounted.root.unmount());
    mounted.host.remove();
  }
});

describe("notification bell loading", () => {
  it("shows a neutral first-load state instead of claiming the empty result succeeded", () => {
    openBell({ ...EMPTY, loading: true });

    expect(screen.getByText("Loading notifications…")).toBeVisible();
    expect(screen.queryByText("You're all caught up.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows one Retry action for a first-load failure and exposes its pending state", () => {
    const onOpen = vi.fn();
    const view = openBell({ ...EMPTY, loadError: true }, onOpen);

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load notifications.");
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(screen.queryByText("You're all caught up.")).toBeNull();

    fireEvent.click(retry);
    expect(store.refreshNotifications).toHaveBeenCalledTimes(1);

    store.useNotifications.mockReturnValue({ ...EMPTY, loading: true, loadError: true });
    view.rerender(
      <TooltipProvider>
        <NotificationsBell onOpen={onOpen} />
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

describe("notification bell visit authority", () => {
  const readFailure: NotificationReadError = {
    id: 7,
    operationId: 7,
    operation: "single",
    message: "Couldn't mark this notification as read.",
    notificationId: ITEM.id,
  };
  const actionableState = {
    ...EMPTY,
    items: [ITEM],
    unreadCount: 1,
    loaded: true,
    readError: readFailure,
  };

  it.each([
    ["stale before current", false],
    ["current before stale", true],
  ] as const)(
    "retires a document visit before the parent layout boundary and preserves current actions %s",
    (_label, currentFirst) => {
      const order: string[] = [];
      const previousOpen = vi.fn();
      const currentOpen = vi.fn((): void => {
        order.push("open");
      });
      store.markNotificationRead.mockImplementation(() => {
        order.push("read");
        return Promise.resolve();
      });
      const root = createBellRoot(actionableState, {
        currentDocId: "document-one",
        onOpen: previousOpen,
      });
      const staleOpenChange = latestOpenChange();
      openDirectBell(staleOpenChange);
      const stale = captureCurrentActions();
      let nextOpenChange!: PopoverOpenChange;

      renderBellRoot(root, actionableState, {
        currentDocId: "document-two",
        onOpen: currentOpen,
        boundary: 1,
        onBoundary: () => {
          expect(screen.queryByTestId("notifications-popover")).toBeNull();
          nextOpenChange = latestOpenChange(staleOpenChange);
          staleOpenChange(true);
          stale.item();
          stale.readAll();
          stale.retry();
          expect(screen.queryByTestId("notifications-popover")).toBeNull();
          expect(store.markNotificationRead).not.toHaveBeenCalled();
          expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
          expect(store.retryNotificationRead).not.toHaveBeenCalled();
          expect(previousOpen).not.toHaveBeenCalled();
          expect(currentOpen).not.toHaveBeenCalled();
        },
      });

      openDirectBell(nextOpenChange);
      const current = captureCurrentActions();
      const invokeInOrder = (staleAction: () => void, currentAction: () => void) => {
        act(() => {
          if (currentFirst) currentAction();
          staleAction();
          if (!currentFirst) currentAction();
        });
      };

      invokeInOrder(stale.retry, current.retry);
      expect(store.retryNotificationRead).toHaveBeenCalledOnce();
      expect(store.retryNotificationRead).toHaveBeenCalledWith(readFailure);

      invokeInOrder(stale.readAll, current.readAll);
      expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();

      act(() => {
        if (currentFirst) nextOpenChange(false);
        staleOpenChange(currentFirst);
        if (!currentFirst) nextOpenChange(false);
      });
      expect(screen.queryByTestId("notifications-popover")).toBeNull();

      openDirectBell(nextOpenChange);
      const reopened = captureCurrentActions();
      let reentered = false;
      currentOpen.mockImplementation(() => {
        order.push("open");
        if (!reentered) {
          reentered = true;
          reopened.item();
        }
      });
      invokeInOrder(stale.item, reopened.item);

      expect(order).toEqual(["read", "open"]);
      expect(store.markNotificationRead).toHaveBeenCalledOnce();
      expect(store.markNotificationRead).toHaveBeenCalledWith(ITEM.id);
      expect(currentOpen).toHaveBeenCalledOnce();
      expect(currentOpen).toHaveBeenCalledWith(ITEM);
      expect(previousOpen).not.toHaveBeenCalled();
      expect(screen.queryByTestId("notifications-popover")).toBeNull();

      act(() => {
        reopened.item();
        staleOpenChange(true);
        stale.item();
        stale.readAll();
        stale.retry();
      });
      expect(store.markNotificationRead).toHaveBeenCalledOnce();
      expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
      expect(store.retryNotificationRead).toHaveBeenCalledOnce();
      expect(currentOpen).toHaveBeenCalledOnce();
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
    },
  );

  it("retires the previous callback visit even when the document id is unchanged", () => {
    const previousOpen = vi.fn();
    const currentOpen = vi.fn();
    const root = createBellRoot(actionableState, {
      currentDocId: ITEM.documentId,
      onOpen: previousOpen,
    });
    const staleOpenChange = latestOpenChange();
    openDirectBell(staleOpenChange);
    const stale = captureCurrentActions();
    let nextOpenChange!: PopoverOpenChange;

    renderBellRoot(root, actionableState, {
      currentDocId: ITEM.documentId,
      onOpen: currentOpen,
      boundary: 1,
      onBoundary: () => {
        expect(screen.queryByTestId("notifications-popover")).toBeNull();
        nextOpenChange = latestOpenChange(staleOpenChange);
        staleOpenChange(true);
        stale.item();
        stale.readAll();
        stale.retry();
      },
    });

    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(store.retryNotificationRead).not.toHaveBeenCalled();
    expect(previousOpen).not.toHaveBeenCalled();
    openDirectBell(nextOpenChange);
    const currentItem = reactHandler<() => void>(screen.getByTestId("notification-item"), "onClick");
    act(() => currentItem());
    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(currentOpen).toHaveBeenCalledWith(ITEM);
    expect(currentOpen).toHaveBeenCalledOnce();
    expect(previousOpen).not.toHaveBeenCalled();
  });

  it("closes and retires the visit when readiness becomes false without enabling notification fetching", () => {
    const onOpen = vi.fn();
    const root = createBellRoot(actionableState, {
      currentDocId: ITEM.documentId,
      onOpen,
      ready: true,
    });
    const staleOpenChange = latestOpenChange();
    openDirectBell(staleOpenChange);
    const stale = captureCurrentActions();
    let notReadyOpenChange!: PopoverOpenChange;

    renderBellRoot(root, actionableState, {
      currentDocId: ITEM.documentId,
      onOpen,
      ready: false,
      boundary: 1,
      onBoundary: () => {
        expect(screen.queryByTestId("notifications-popover")).toBeNull();
        notReadyOpenChange = latestOpenChange(staleOpenChange);
        staleOpenChange(true);
        stale.item();
        stale.readAll();
        stale.retry();
        notReadyOpenChange(true);
      },
    });

    expect(store.useNotifications).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(store.retryNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("retires every captured action before a removed bell reaches the parent layout boundary", () => {
    const onOpen = vi.fn();
    const root = createBellRoot(actionableState, {
      currentDocId: ITEM.documentId,
      onOpen,
    });
    const staleOpenChange = latestOpenChange();
    openDirectBell(staleOpenChange);
    const stale = captureCurrentActions();

    renderBellRoot(root, actionableState, {
      currentDocId: ITEM.documentId,
      onOpen,
      present: false,
      boundary: 1,
      onBoundary: () => {
        expect(screen.queryByTestId("notifications-popover")).toBeNull();
        staleOpenChange(true);
        stale.item();
        stale.readAll();
        stale.retry();
      },
    });

    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(store.retryNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
  });

  it.each([
    ["stale before current", false],
    ["current before stale", true],
  ] as const)("retires same-id row data before the parent layout boundary with the %s callback order", (_label, currentFirst) => {
    const onOpen = vi.fn();
    const root = createBellRoot(
      { ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true },
      { currentDocId: "other-document", onOpen },
    );
    openDirectBell();
    const staleItem = reactHandler<() => void>(screen.getByTestId("notification-item"), "onClick");
    let currentItem!: () => void;

    renderBellRoot(
      root,
      { ...EMPTY, items: [REPLACEMENT_ITEM], loaded: true },
      {
        currentDocId: "other-document",
        onOpen,
        boundary: 1,
        onBoundary: () => {
          expect(screen.getByTestId("notifications-popover")).toBeVisible();
          expect(screen.getByTestId("notification-item")).toHaveTextContent("Bob mentioned you");
          currentItem = reactHandler<() => void>(screen.getByTestId("notification-item"), "onClick");
          if (!currentFirst) staleItem();
          expect(store.markNotificationRead).not.toHaveBeenCalled();
        },
      },
    );

    act(() => {
      if (currentFirst) currentItem();
      staleItem();
      if (!currentFirst) currentItem();
      currentItem();
    });
    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(store.markNotificationRead).toHaveBeenCalledWith(REPLACEMENT_ITEM.id);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(REPLACEMENT_ITEM);
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
  });

  it.each([
    ["stale before current", false],
    ["current before stale", true],
  ] as const)("keeps only the current visit's initial-load Retry usable %s", (_label, currentFirst) => {
    const loadFailureState = { ...EMPTY, loadError: true };
    const previousOpen = vi.fn();
    const currentOpen = vi.fn();
    const root = createBellRoot(loadFailureState, {
      currentDocId: "document-one",
      onOpen: previousOpen,
    });
    const staleOpenChange = latestOpenChange();
    openDirectBell(staleOpenChange);
    const staleRetry = reactHandler<() => void>(screen.getByRole("button", { name: "Retry" }), "onClick");
    let nextOpenChange!: PopoverOpenChange;

    renderBellRoot(root, loadFailureState, {
      currentDocId: "document-two",
      onOpen: currentOpen,
      boundary: 1,
      onBoundary: () => {
        expect(screen.queryByTestId("notifications-popover")).toBeNull();
        nextOpenChange = latestOpenChange(staleOpenChange);
        staleRetry();
      },
    });

    openDirectBell(nextOpenChange);
    const currentRetry = reactHandler<() => void>(screen.getByRole("button", { name: "Retry" }), "onClick");
    act(() => {
      if (currentFirst) currentRetry();
      staleRetry();
      if (!currentFirst) currentRetry();
    });
    expect(store.refreshNotifications).toHaveBeenCalledOnce();
    expect(previousOpen).not.toHaveBeenCalled();
    expect(currentOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId("notifications-popover")).toBeVisible();
  });
});
