// @vitest-environment jsdom
import { useEffect, useLayoutEffect, type MouseEvent as ReactMouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationDto } from "@/lib/api";

const store = vi.hoisted(() => ({
  useNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}));
const navigation = vi.hoisted(() => ({
  useRouter: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: navigation.useRouter,
}));
vi.mock("@/lib/notifications-store", () => ({
  ...store,
  sentence: (notification: NotificationDto) => `${notification.kind} sentence`,
}));
vi.mock("@/components/notifications/notifications-bell", () => ({
  KindIcon: ({ kind }: { kind: NotificationDto["kind"] }) => <span data-testid={`kind-${kind}`} />,
  actorLabel: (notification: NotificationDto) => notification.actorName ?? (notification.actorLogin ? `@${notification.actorLogin}` : "Someone"),
}));
vi.mock("@/components/ui/relative-time", () => ({
  RelativeTime: ({ date, className }: { date: string; className?: string }) => (
    <time className={className} data-testid="relative-time">
      {date}
    </time>
  ),
}));

import { NotificationsStrip } from "./notifications-strip";

interface NotificationSnapshot {
  items: NotificationDto[];
  unreadCount: number;
  loaded: boolean;
  loading: boolean;
  loadError: boolean;
  readAllPending: boolean;
  readError: null;
  readErrorPending: boolean;
}

type Router = ReturnType<typeof createRouter>;
type ClickHandler = (event: ReactMouseEvent<HTMLButtonElement>) => void;

interface CapturedActions {
  open: ClickHandler;
  dismiss: ClickHandler;
  readAll: ClickHandler;
}

interface DirectView {
  root: Root;
  host: HTMLDivElement;
}

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
const SHARE: NotificationDto = {
  id: "notification-share",
  kind: "share",
  documentId: "document-shared",
  documentTitle: "Shared brief",
  actorLogin: "bob",
  actorName: null,
  refId: "document-shared:bob",
  snippet: "This is not presented for shares",
  createdAt: "2026-09-07T12:30:00.000Z",
  readAt: null,
};
const ITEM_TWO: NotificationDto = {
  ...ITEM,
  id: "notification-two",
  documentId: "document-two",
  documentTitle: "Release notes",
  refId: "thread-two",
};
const SAME_ID_REPLACEMENT: NotificationDto = {
  id: ITEM.id,
  kind: "reply",
  documentId: "document-current",
  documentTitle: "Current launch plan",
  actorLogin: "carol",
  actorName: "Carol",
  refId: "thread-current",
  snippet: "The replacement row",
  createdAt: "2026-09-07T13:00:00.000Z",
  readAt: null,
};

const directViews: DirectView[] = [];
let currentSnapshot: NotificationSnapshot;
let currentRouter: Router;

function snapshot(items: NotificationDto[], unreadCount = items.filter((notification) => !notification.readAt).length): NotificationSnapshot {
  return {
    items,
    unreadCount,
    loaded: true,
    loading: false,
    loadError: false,
    readAllPending: false,
    readError: null,
    readErrorPending: false,
  };
}

function createRouter(name: string) {
  return {
    name,
    push: vi.fn<(href: string) => void>(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  };
}

function reactHandler(element: HTMLElement, name = "onClick"): ClickHandler {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return handler as ClickHandler;
}

function captureActions(rowIndex = 0): CapturedActions {
  const row = screen.getAllByTestId("notification-item")[rowIndex];
  return {
    open: reactHandler(within(row).getByTestId("notification-open")),
    dismiss: reactHandler(within(row).getByTestId("notification-dismiss")),
    readAll: reactHandler(screen.getByTestId("notifications-strip-read-all")),
  };
}

function eventProbe() {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const event = {
    preventDefault,
    stopPropagation,
    isDefaultPrevented: () => preventDefault.mock.calls.length > 0,
    isPropagationStopped: () => stopPropagation.mock.calls.length > 0,
  } as unknown as ReactMouseEvent<HTMLButtonElement>;
  return { event, preventDefault, stopPropagation };
}

function invoke(callback: ClickHandler) {
  callback(eventProbe().event);
}

function PassiveCleanupProbe({ generation, onCleanup }: { generation: string; onCleanup: () => void }) {
  useEffect(() => onCleanup, [generation, onCleanup]);
  return null;
}

function InitialStripMount() {
  return <NotificationsStrip />;
}

function ReplacementStripMount() {
  return <NotificationsStrip />;
}

function StripBoundary({
  present = true,
  mount = "initial",
  boundary = 0,
  passiveGeneration = "initial",
  onBoundary,
  onPassiveCleanup,
}: {
  present?: boolean;
  mount?: "initial" | "replacement";
  boundary?: number;
  passiveGeneration?: string;
  onBoundary?: () => void;
  onPassiveCleanup: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);

  return (
    <>
      {present ? mount === "initial" ? <InitialStripMount /> : <ReplacementStripMount /> : null}
      <PassiveCleanupProbe generation={passiveGeneration} onCleanup={onPassiveCleanup} />
    </>
  );
}

function createDirectView(router: Router, notificationSnapshot: NotificationSnapshot, onPassiveCleanup = vi.fn()) {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { root: createRoot(host), host };
  directViews.push(view);
  renderDirect(view, router, notificationSnapshot, { onPassiveCleanup });
  return view;
}

function renderDirect(
  view: DirectView,
  router: Router,
  notificationSnapshot: NotificationSnapshot,
  props: Omit<Parameters<typeof StripBoundary>[0], "onPassiveCleanup"> & { onPassiveCleanup: () => void },
) {
  currentRouter = router;
  currentSnapshot = notificationSnapshot;
  act(() => view.root.render(<StripBoundary {...props} />));
}

function expectStaleInert(actions: CapturedActions, view: DirectView, routers: Router[]) {
  const focusTarget = document.createElement("button");
  document.body.append(focusTarget);
  focusTarget.focus();
  const html = view.host.innerHTML;
  const hookCalls = store.useNotifications.mock.calls.length;
  const markCalls = store.markNotificationRead.mock.calls.length;
  const markAllCalls = store.markAllNotificationsRead.mock.calls.length;
  const pushCalls = routers.map((router) => router.push.mock.calls.length);
  const events = [eventProbe(), eventProbe(), eventProbe()];

  actions.open(events[0].event);
  actions.dismiss(events[1].event);
  actions.readAll(events[2].event);

  expect(store.useNotifications).toHaveBeenCalledTimes(hookCalls);
  expect(store.markNotificationRead).toHaveBeenCalledTimes(markCalls);
  expect(store.markAllNotificationsRead).toHaveBeenCalledTimes(markAllCalls);
  routers.forEach((router, index) => expect(router.push).toHaveBeenCalledTimes(pushCalls[index]));
  events.forEach(({ preventDefault, stopPropagation }) => {
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });
  expect(view.host.innerHTML).toBe(html);
  expect(document.activeElement).toBe(focusTarget);
  focusTarget.remove();
}

beforeEach(() => {
  currentSnapshot = snapshot([ITEM]);
  currentRouter = createRouter("default");
  store.useNotifications.mockReset().mockImplementation(() => currentSnapshot);
  store.markNotificationRead.mockReset().mockResolvedValue(undefined);
  store.markAllNotificationsRead.mockReset().mockResolvedValue(undefined);
  navigation.useRouter.mockReset().mockImplementation(() => currentRouter);
});

afterEach(() => {
  cleanup();
  while (directViews.length) {
    const view = directViews.pop()!;
    act(() => view.root.unmount());
    view.host.remove();
  }
});

describe("notification strip current actions", () => {
  it("preserves document and share presentation while claiming Open and Mark all read once", () => {
    const order: string[] = [];
    const router = createRouter("current");
    router.push.mockImplementation((href) => order.push(`push:${href}`));
    store.markNotificationRead.mockImplementation((id) => {
      order.push(`mark:${id}`);
      return Promise.resolve();
    });
    const view = createDirectView(router, snapshot([ITEM, SHARE], 2));

    const rows = screen.getAllByTestId("notification-item");
    expect(rows.map((row) => row.dataset.notificationId)).toEqual([ITEM.id, SHARE.id]);
    expect(screen.getByRole("heading", { name: /Notifications\s*2/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeVisible();
    expect(within(rows[0]).getByTestId("notification-open")).toHaveTextContent("Alice mention sentence in Launch plan");
    expect(within(rows[0]).getByTestId("notification-open")).toHaveTextContent(ITEM.snippet);
    expect(within(rows[1]).getByTestId("notification-open")).toHaveTextContent("@bob share sentence");
    expect(within(rows[1]).getByTestId("notification-open")).not.toHaveTextContent(SHARE.documentTitle);
    expect(within(rows[1]).getByTestId("notification-open")).not.toHaveTextContent(SHARE.snippet);
    expect(screen.getAllByTestId("relative-time").map((time) => time.textContent)).toEqual([ITEM.createdAt, SHARE.createdAt]);
    expect(screen.getAllByRole("button", { name: "Mark as read" })).toHaveLength(2);

    const current = captureActions();
    invoke(current.open);
    invoke(current.open);
    invoke(current.dismiss);
    invoke(current.readAll);
    invoke(current.readAll);

    expect(order).toEqual([`mark:${ITEM.id}`, `push:/d/${ITEM.documentId}?thread=${ITEM.refId}`]);
    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledOnce();
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(view.host.querySelectorAll('[data-testid="notification-item"]')).toHaveLength(2);
  });

  it("lets Dismiss win a row claim once without navigating", () => {
    const router = createRouter("current");
    createDirectView(router, snapshot([ITEM]));
    const current = captureActions();

    invoke(current.dismiss);
    invoke(current.dismiss);
    invoke(current.open);

    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(store.markNotificationRead).toHaveBeenCalledWith(ITEM.id);
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("notification strip snapshot authority", () => {
  it("retires an exact snapshot before the parent layout boundary and keeps B usable stale-before-current", () => {
    const passiveCleanup = vi.fn();
    const router = createRouter("shared");
    const firstSnapshot = snapshot([ITEM]);
    const view = createDirectView(router, firstSnapshot, passiveCleanup);
    const stale = captureActions();
    const replacementSnapshot = snapshot([ITEM_TWO]);
    let current!: CapturedActions;

    renderDirect(view, router, replacementSnapshot, {
      boundary: 1,
      passiveGeneration: "replacement",
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        expect(passiveCleanup).not.toHaveBeenCalled();
        current = captureActions();
        expectStaleInert(stale, view, [router]);
        invoke(current.dismiss);
        invoke(current.readAll);
      },
    });

    expect(passiveCleanup).toHaveBeenCalledOnce();
    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(store.markNotificationRead).toHaveBeenCalledWith(ITEM_TWO.id);
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
    expectStaleInert(stale, view, [router]);
    invoke(current.open);
    invoke(current.dismiss);
    invoke(current.readAll);
    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
  });

  it("retires the exact router before the parent layout boundary and preserves B claims current-before-stale", () => {
    const order: string[] = [];
    const passiveCleanup = vi.fn();
    const firstRouter = createRouter("first");
    const currentRouter = createRouter("current");
    currentRouter.push.mockImplementation((href) => order.push(`push:${href}`));
    store.markNotificationRead.mockImplementation((id) => {
      order.push(`mark:${id}`);
      return Promise.resolve();
    });
    const sharedSnapshot = snapshot([ITEM]);
    const view = createDirectView(firstRouter, sharedSnapshot, passiveCleanup);
    const stale = captureActions();
    let current!: CapturedActions;

    renderDirect(view, currentRouter, sharedSnapshot, {
      boundary: 1,
      passiveGeneration: "router-replacement",
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        expect(passiveCleanup).not.toHaveBeenCalled();
        current = captureActions();
        invoke(current.open);
        invoke(current.readAll);
        expectStaleInert(stale, view, [firstRouter, currentRouter]);
      },
    });

    expect(order).toEqual([`mark:${ITEM.id}`, `push:/d/${ITEM.documentId}?thread=${ITEM.refId}`]);
    expect(firstRouter.push).not.toHaveBeenCalled();
    expect(currentRouter.push).toHaveBeenCalledOnce();
    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(passiveCleanup).toHaveBeenCalledOnce();
    expectStaleInert(stale, view, [firstRouter, currentRouter]);
    invoke(current.open);
    invoke(current.dismiss);
    invoke(current.readAll);
    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
  });

  it.each([
    ["stale before current", false],
    ["current before stale", true],
  ] as const)("rejects a same-ID changed row and leaves the exact B row claim usable %s", (_label, currentFirst) => {
    const passiveCleanup = vi.fn();
    const router = createRouter("shared");
    const view = createDirectView(router, snapshot([ITEM]), passiveCleanup);
    const stale = captureActions();
    let current!: CapturedActions;

    renderDirect(view, router, snapshot([SAME_ID_REPLACEMENT]), {
      boundary: 1,
      passiveGeneration: `same-id-${currentFirst}`,
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        expect(passiveCleanup).not.toHaveBeenCalled();
        current = captureActions();
        expect(screen.getByTestId("notification-item")).toHaveTextContent("Carol reply sentence in Current launch plan");
        if (currentFirst) {
          invoke(current.open);
          invoke(current.readAll);
        }
        expectStaleInert(stale, view, [router]);
        if (!currentFirst) {
          invoke(current.open);
          invoke(current.readAll);
        }
      },
    });

    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(store.markNotificationRead).toHaveBeenCalledWith(SAME_ID_REPLACEMENT.id);
    expect(router.push).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledWith(`/d/${SAME_ID_REPLACEMENT.documentId}?thread=${SAME_ID_REPLACEMENT.refId}`);
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(passiveCleanup).toHaveBeenCalledOnce();
    expectStaleInert(stale, view, [router]);
    invoke(current.open);
    invoke(current.dismiss);
    invoke(current.readAll);
    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
  });

  it("gives an equal-value distinct remount separate authority and isolated claims", () => {
    const passiveCleanup = vi.fn();
    const router = createRouter("shared");
    const sharedSnapshot = snapshot([ITEM]);
    const view = createDirectView(router, sharedSnapshot, passiveCleanup);
    const stale = captureActions();
    let current!: CapturedActions;

    renderDirect(view, router, sharedSnapshot, {
      mount: "replacement",
      boundary: 1,
      passiveGeneration: "remount",
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        expect(passiveCleanup).not.toHaveBeenCalled();
        current = captureActions();
        expectStaleInert(stale, view, [router]);
        invoke(current.dismiss);
        invoke(current.readAll);
      },
    });

    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(passiveCleanup).toHaveBeenCalledOnce();
    expectStaleInert(stale, view, [router]);
    invoke(current.dismiss);
    invoke(current.open);
    invoke(current.readAll);
    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
  });

  it("retires every callback before removal reaches the parent layout boundary", () => {
    const passiveCleanup = vi.fn();
    const router = createRouter("removed");
    const view = createDirectView(router, snapshot([ITEM]), passiveCleanup);
    const stale = captureActions();

    renderDirect(view, router, snapshot([]), {
      present: false,
      boundary: 1,
      passiveGeneration: "removed",
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        expect(passiveCleanup).not.toHaveBeenCalled();
        expect(screen.queryByTestId("notifications-strip")).toBeNull();
        expectStaleInert(stale, view, [router]);
      },
    });

    expect(passiveCleanup).toHaveBeenCalledOnce();
    expectStaleInert(stale, view, [router]);
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });
});
