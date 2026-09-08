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
  section: HTMLElement;
  list: HTMLUListElement;
  item: HTMLLIElement;
  openButton: HTMLButtonElement;
  dismissButton: HTMLButtonElement;
  readAllButton: HTMLButtonElement;
}

interface DirectView {
  root: Root;
  host: HTMLDivElement;
}

type CapturedPart = "section" | "readAllButton" | "list" | "item" | "openButton" | "dismissButton";

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

function reactRef<T extends HTMLElement>(element: T): (node: T | null) => void {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (element as unknown as Record<string, { ref?: unknown }>)[propsKey]
    : undefined;
  if (typeof props?.ref === "function") return props.ref as (node: T | null) => void;
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error(`React fiber was not attached to ${element.dataset.testid ?? element.tagName}`);
  const fiber = (element as unknown as Record<string, { ref?: unknown }>)[fiberKey];
  if (typeof fiber?.ref !== "function") throw new Error(`React ref was not attached to ${element.dataset.testid ?? element.tagName}`);
  return fiber.ref as (node: T | null) => void;
}

const clickTargets = new WeakMap<ClickHandler, HTMLButtonElement>();

function captureActions(rowIndex = 0, container: HTMLElement = document.body): CapturedActions {
  const section = container.matches('[data-testid="notifications-strip"]')
    ? container
    : container.querySelector<HTMLElement>('[data-testid="notifications-strip"]');
  if (!section) throw new Error("Notification strip was not rendered");
  const rows = section.querySelectorAll<HTMLLIElement>('[data-testid="notification-item"]');
  const row = rows.item(rowIndex);
  const list = row.parentElement;
  const openButton = row.querySelector<HTMLButtonElement>('[data-testid="notification-open"]');
  const dismissButton = row.querySelector<HTMLButtonElement>('[data-testid="notification-dismiss"]');
  const readAllButton = section.querySelector<HTMLButtonElement>('[data-testid="notifications-strip-read-all"]');
  if (!(list instanceof HTMLUListElement) || !openButton || !dismissButton || !readAllButton) {
    throw new Error("Notification strip hierarchy was incomplete");
  }
  const open = reactHandler(openButton);
  const dismiss = reactHandler(dismissButton);
  const readAll = reactHandler(readAllButton);
  clickTargets.set(open, openButton);
  clickTargets.set(dismiss, dismissButton);
  clickTargets.set(readAll, readAllButton);
  return {
    open,
    dismiss,
    readAll,
    section,
    list,
    item: row,
    openButton,
    dismissButton,
    readAllButton,
  };
}

function eventProbe(currentTarget: HTMLButtonElement) {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const event = {
    currentTarget,
    preventDefault,
    stopPropagation,
    isDefaultPrevented: () => preventDefault.mock.calls.length > 0,
    isPropagationStopped: () => stopPropagation.mock.calls.length > 0,
  } as unknown as ReactMouseEvent<HTMLButtonElement>;
  return { event, preventDefault, stopPropagation };
}

function invoke(callback: ClickHandler, currentTarget = clickTargets.get(callback)) {
  if (!currentTarget) throw new Error("Click target was not captured");
  callback(eventProbe(currentTarget).event);
}

function connectedButton(label = "Other") {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", label);
  document.body.append(button);
  return button;
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

function SiblingStrips() {
  return (
    <>
      <NotificationsStrip />
      <NotificationsStrip />
    </>
  );
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
  const events = [
    eventProbe(actions.openButton),
    eventProbe(actions.dismissButton),
    eventProbe(actions.readAllButton),
  ];

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

  it("rejects crossed, foreign, detached, disabled, and replacement controls before accepting each exact source once", () => {
    const router = createRouter("exact-controls");
    const view = createDirectView(router, snapshot([ITEM, ITEM_TWO], 2));
    const first = captureActions(0);
    const second = captureActions(1);
    const foreign = connectedButton("Open");
    const detached = document.createElement("button");
    const replacement = first.openButton.cloneNode(true) as HTMLButtonElement;
    document.body.append(replacement);
    const focusTarget = connectedButton("Focus sentinel");
    focusTarget.focus();
    const markup = view.host.innerHTML;
    const wrongEvents = [
      eventProbe(first.dismissButton),
      eventProbe(second.openButton),
      eventProbe(foreign),
      eventProbe(detached),
      eventProbe(replacement),
      eventProbe(first.openButton),
      eventProbe(first.openButton),
    ];

    first.open(wrongEvents[0].event);
    first.open(wrongEvents[1].event);
    first.open(wrongEvents[2].event);
    first.open(wrongEvents[3].event);
    first.open(wrongEvents[4].event);
    first.openButton.disabled = true;
    first.open(wrongEvents[5].event);
    first.openButton.disabled = false;
    first.dismiss(wrongEvents[6].event);
    first.readAll(eventProbe(first.openButton).event);
    first.readAll(eventProbe(foreign).event);

    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(view.host.innerHTML).toBe(markup);
    expect(document.activeElement).toBe(focusTarget);
    wrongEvents.forEach(({ preventDefault, stopPropagation }) => {
      expect(preventDefault).not.toHaveBeenCalled();
      expect(stopPropagation).not.toHaveBeenCalled();
    });

    const reused = eventProbe(foreign);
    first.open(reused.event);
    (reused.event as unknown as { currentTarget: HTMLButtonElement }).currentTarget = first.openButton;
    first.open(reused.event);
    first.open(reused.event);
    invoke(first.dismiss);
    invoke(second.dismiss);
    invoke(second.open);

    first.readAllButton.disabled = true;
    invoke(first.readAll);
    first.readAllButton.disabled = false;
    invoke(first.readAll);
    invoke(first.readAll);

    expect(store.markNotificationRead.mock.calls).toEqual([[ITEM.id], [ITEM_TWO.id]]);
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM.documentId}?thread=${ITEM.refId}`);
    expect(document.activeElement).toBe(focusTarget);
  });

  it("isolates equal-looking sibling strips and their exact controls", () => {
    const router = createRouter("siblings");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    directViews.push({ root, host });
    currentRouter = router;
    currentSnapshot = snapshot([ITEM]);
    act(() => root.render(<SiblingStrips />));
    const sections = screen.getAllByTestId("notifications-strip");
    const first = captureActions(0, sections[0]);
    const second = captureActions(0, sections[1]);

    invoke(first.open, second.openButton);
    invoke(second.open, first.openButton);
    invoke(first.dismiss, second.dismissButton);
    invoke(second.dismiss, first.dismissButton);
    invoke(first.readAll, second.readAllButton);
    invoke(second.readAll, first.readAllButton);
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    invoke(second.dismiss);
    invoke(first.open);
    invoke(second.readAll);
    invoke(first.readAll);

    expect(store.markNotificationRead.mock.calls).toEqual([[ITEM.id], [ITEM.id]]);
    expect(store.markAllNotificationsRead).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM.documentId}?thread=${ITEM.refId}`);
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

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "freezes the exact push method and leaves the replacement usable %s",
    (order) => {
      const passiveCleanup = vi.fn();
      const router = createRouter("push-replacement");
      const firstPush = router.push;
      const sharedSnapshot = snapshot([ITEM]);
      const view = createDirectView(router, sharedSnapshot, passiveCleanup);
      const stale = captureActions();
      const replacementPush = vi.fn<(href: string) => void>();
      router.push = replacementPush;

      expectStaleInert(stale, view, [router]);
      let current!: CapturedActions;
      renderDirect(view, router, sharedSnapshot, {
        boundary: 1,
        passiveGeneration: `push-${order}`,
        onPassiveCleanup: passiveCleanup,
        onBoundary: () => {
          current = captureActions();
          if (order === "stale-before-current") expectStaleInert(stale, view, [router]);
          invoke(current.open);
          invoke(current.readAll);
          if (order === "current-before-stale") expectStaleInert(stale, view, [router]);
        },
      });

      expect(firstPush).not.toHaveBeenCalled();
      expect(replacementPush).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM.documentId}?thread=${ITEM.refId}`);
      expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
      expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
      expect(passiveCleanup).toHaveBeenCalledOnce();
      invoke(current.open);
      invoke(current.dismiss);
      invoke(current.readAll);
      expect(store.markNotificationRead).toHaveBeenCalledOnce();
      expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    },
  );

  it("rejects an in-place primitive mutation immediately and publishes only the newly rendered facts", () => {
    const passiveCleanup = vi.fn();
    const router = createRouter("primitive-mutation");
    const item = { ...ITEM };
    const sharedSnapshot = snapshot([item]);
    const view = createDirectView(router, sharedSnapshot, passiveCleanup);
    const stale = captureActions();
    const markup = view.host.innerHTML;

    item.kind = "reply";
    item.documentId = "document-mutated";
    item.documentTitle = "Mutated launch plan";
    item.actorName = "Morgan";
    item.refId = "thread-mutated";
    item.snippet = "Mutated snippet";
    item.createdAt = "2026-09-07T14:00:00.000Z";
    expectStaleInert(stale, view, [router]);
    expect(view.host.innerHTML).toBe(markup);

    let current!: CapturedActions;
    renderDirect(view, router, sharedSnapshot, {
      boundary: 1,
      passiveGeneration: "primitive-mutation",
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        current = captureActions();
        expectStaleInert(stale, view, [router]);
        expect(current.item).toHaveAttribute("data-kind", "reply");
        expect(current.openButton).toHaveTextContent("Morgan reply sentence in Mutated launch plan");
        invoke(current.open);
        invoke(current.readAll);
      },
    });

    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(item.id);
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/d/document-mutated?thread=thread-mutated");
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(passiveCleanup).toHaveBeenCalledOnce();
  });

  it("rejects an in-place reorder and binds each current handler to its exact ordered row", () => {
    const passiveCleanup = vi.fn();
    const router = createRouter("reorder");
    const items = [{ ...ITEM }, { ...ITEM_TWO }];
    const sharedSnapshot = snapshot(items);
    const view = createDirectView(router, sharedSnapshot, passiveCleanup);
    const staleFirst = captureActions(0);
    const staleSecond = captureActions(1);

    items.reverse();
    expectStaleInert(staleFirst, view, [router]);
    expectStaleInert(staleSecond, view, [router]);
    let currentFirst!: CapturedActions;
    let currentSecond!: CapturedActions;
    renderDirect(view, router, sharedSnapshot, {
      boundary: 1,
      passiveGeneration: "reorder",
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        currentFirst = captureActions(0);
        currentSecond = captureActions(1);
        expect([currentFirst.item.dataset.notificationId, currentSecond.item.dataset.notificationId]).toEqual([
          ITEM_TWO.id,
          ITEM.id,
        ]);
        invoke(staleFirst.open, currentFirst.openButton);
        invoke(staleSecond.dismiss, currentSecond.dismissButton);
        invoke(currentFirst.open, currentSecond.openButton);
        invoke(currentSecond.dismiss, currentFirst.dismissButton);
        expect(store.markNotificationRead).not.toHaveBeenCalled();
        invoke(currentFirst.open);
        invoke(currentSecond.dismiss);
      },
    });

    expect(store.markNotificationRead.mock.calls).toEqual([[ITEM_TWO.id], [ITEM.id]]);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM_TWO.documentId}?thread=${ITEM_TWO.refId}`);
    expect(passiveCleanup).toHaveBeenCalledOnce();
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
        invoke(stale.open, current.openButton);
        invoke(stale.dismiss, current.dismissButton);
        invoke(stale.readAll, current.readAllButton);
        invoke(current.open, stale.openButton);
        invoke(current.dismiss, stale.dismissButton);
        invoke(current.readAll, stale.readAllButton);
        expect(store.markNotificationRead).not.toHaveBeenCalled();
        expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
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

  it.each([
    ["section", "section"],
    ["read-all", "readAllButton"],
    ["list", "list"],
    ["item", "item"],
    ["open", "openButton"],
    ["dismiss", "dismissButton"],
  ] as const)("retires an exact %s callback-ref replacement without letting late A refs clear B", (_label, part: CapturedPart) => {
    const passiveCleanup = vi.fn();
    const router = createRouter(`ref-${part}`);
    const sharedSnapshot = snapshot([ITEM]);
    const view = createDirectView(router, sharedSnapshot, passiveCleanup);
    const stale = captureActions();
    const staleElement = stale[part];
    const staleRef = reactRef(staleElement);
    const replacement = staleElement.cloneNode(true) as typeof staleElement;
    document.body.append(replacement);

    staleRef(replacement);
    expectStaleInert(stale, view, [router]);
    replacement.remove();

    let current!: CapturedActions;
    renderDirect(view, router, sharedSnapshot, {
      boundary: 1,
      passiveGeneration: `ref-${part}`,
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        current = captureActions();
        const currentElement = current[part];
        staleRef(currentElement);
        staleRef(null);
        expectStaleInert(stale, view, [router]);
        invoke(stale.open, current.openButton);
        invoke(current.open, stale.openButton);
        invoke(current.readAll);
      },
    });

    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM.documentId}?thread=${ITEM.refId}`);
    expect(passiveCleanup).toHaveBeenCalledOnce();
    expectStaleInert(stale, view, [router]);
    invoke(current.dismiss);
    invoke(current.readAll);
    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
  });

  it("retires every callback before removal reaches the parent layout boundary", () => {
    const passiveCleanup = vi.fn();
    const router = createRouter("removed");
    const view = createDirectView(router, snapshot([ITEM]), passiveCleanup);
    const stale = captureActions();
    const staleSectionRef = reactRef(stale.section);

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

    let current!: CapturedActions;
    renderDirect(view, router, snapshot([ITEM]), {
      mount: "replacement",
      boundary: 2,
      passiveGeneration: "current",
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        current = captureActions();
        staleSectionRef(current.section);
        staleSectionRef(null);
        expectStaleInert(stale, view, [router]);
        invoke(current.open);
        invoke(current.readAll);
      },
    });
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM.documentId}?thread=${ITEM.refId}`);
  });
});
