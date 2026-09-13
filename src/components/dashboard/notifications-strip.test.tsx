// @vitest-environment jsdom
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
type KeyHandler = (event: ReactKeyboardEvent<HTMLButtonElement>) => void;

interface CapturedActions {
  open: ClickHandler;
  keyDown: KeyHandler;
  rowKeyDownCapture: (
    event: ReactKeyboardEvent<HTMLLIElement>,
  ) => void;
  dismissKeyDown: KeyHandler;
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
type ReactPropsRecord = Record<string, unknown> & {
  onClick?: ClickHandler;
  onKeyDown?: KeyHandler;
  onKeyDownCapture?: (
    event: ReactKeyboardEvent<HTMLElement>,
  ) => void;
  ref?: unknown;
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
const ITEM_THREE: NotificationDto = {
  ...ITEM,
  id: "notification-three",
  documentId: "document-three",
  documentTitle: "Launch checklist",
  refId: "thread-three",
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

function reactPropsEntry(element: HTMLElement) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const record = element as unknown as Record<string, ReactPropsRecord | undefined>;
  const props = record[propsKey];
  if (!props) throw new Error(`React props were empty for ${element.dataset.testid ?? element.tagName}`);
  return { propsKey, record, props };
}

function reactHandler(element: HTMLElement, name = "onClick"): ClickHandler {
  const { props } = reactPropsEntry(element);
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return handler as ClickHandler;
}

function reactKeyHandler(element: HTMLElement): KeyHandler {
  const { props } = reactPropsEntry(element);
  if (typeof props.onKeyDown !== "function") {
    throw new Error(`onKeyDown was not attached to ${element.dataset.testid ?? element.tagName}`);
  }
  return props.onKeyDown;
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
  const rowKeyDownCapture = reactPropsEntry(row).props
    .onKeyDownCapture;
  if (
    !(list instanceof HTMLUListElement) ||
    !openButton ||
    !dismissButton ||
    !readAllButton ||
    typeof rowKeyDownCapture !== "function"
  ) {
    throw new Error("Notification strip hierarchy was incomplete");
  }
  const open = reactHandler(openButton);
  const keyDown = reactKeyHandler(openButton);
  const dismissKeyDown = reactKeyHandler(dismissButton);
  const dismiss = reactHandler(dismissButton);
  const readAll = reactHandler(readAllButton);
  clickTargets.set(open, openButton);
  clickTargets.set(dismiss, dismissButton);
  clickTargets.set(readAll, readAllButton);
  return {
    open,
    keyDown,
    rowKeyDownCapture:
      rowKeyDownCapture as (
        event: ReactKeyboardEvent<HTMLLIElement>,
      ) => void,
    dismissKeyDown,
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

function click(callback: ClickHandler) {
  const currentTarget = clickTargets.get(callback);
  if (!currentTarget) throw new Error("Click target was not captured");
  dispatchTrustedClick(currentTarget);
}

function interceptClick(
  element: HTMLButtonElement,
  invokeHandler: (original: ClickHandler, event: ReactMouseEvent<HTMLButtonElement>) => void,
) {
  const { propsKey, record, props } = reactPropsEntry(element);
  const original = props.onClick;
  if (!original) throw new Error("The button did not have an onClick handler");
  record[propsKey] = {
    ...props,
    onClick: ((event: ReactMouseEvent<HTMLButtonElement>) => {
      invokeHandler(original, event);
    }) as ClickHandler,
  };
  return () => {
    record[propsKey] = props;
  };
}

function interceptKeyDown(
  element: HTMLButtonElement,
  invokeHandler: (
    original: KeyHandler,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void,
) {
  const { propsKey, record, props } = reactPropsEntry(element);
  const original = props.onKeyDown;
  if (!original) throw new Error("The button did not have an onKeyDown handler");
  record[propsKey] = {
    ...props,
    onKeyDown: ((event: ReactKeyboardEvent<HTMLButtonElement>) => {
      invokeHandler(original, event);
    }) as KeyHandler,
  };
  return () => {
    record[propsKey] = props;
  };
}

function interceptKeyDownCapture(
  element: HTMLLIElement,
  invokeHandler: (
    original: CapturedActions["rowKeyDownCapture"],
    event: ReactKeyboardEvent<HTMLLIElement>,
  ) => void,
) {
  const { propsKey, record, props } = reactPropsEntry(element);
  const original = props.onKeyDownCapture;
  if (!original) {
    throw new Error("The row did not have an onKeyDownCapture handler");
  }
  record[propsKey] = {
    ...props,
    onKeyDownCapture: (event: ReactKeyboardEvent<HTMLElement>) => {
      invokeHandler(
        original as CapturedActions["rowKeyDownCapture"],
        event as ReactKeyboardEvent<HTMLLIElement>,
      );
    },
  };
  return () => {
    record[propsKey] = props;
  };
}

function exposeKeyboardScalarThroughGetter(
  event: ReactKeyboardEvent<HTMLElement>,
  property: keyof ReactKeyboardEvent<HTMLElement>,
) {
  const descriptor = Object.getOwnPropertyDescriptor(event, property);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !descriptor.configurable
  ) {
    throw new Error(`${String(property)} was not configurable public data`);
  }
  const value = descriptor.value;
  Object.defineProperty(event, property, {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: () => value,
  });
}

function connectedButton(label = "Other") {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", label);
  document.body.append(button);
  return button;
}

function markJsdomEventTrusted(event: Event) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find(
      (candidate): candidate is { isTrusted: boolean } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "isTrusted" in candidate &&
        candidate.isTrusted === false,
    );
  const descriptor = implementation
    ? Object.getOwnPropertyDescriptor(implementation, "isTrusted")
    : undefined;
  if (!implementation || !descriptor?.writable) {
    throw new Error("Unable to set jsdom's internal event trust slot");
  }
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  if (!event.isTrusted) {
    throw new Error("The jsdom event trust slot did not update");
  }
}

function dispatchTrustedClick(
  source: HTMLButtonElement,
  target: HTMLElement = source,
) {
  const view = source.ownerDocument.defaultView;
  if (!view) throw new Error("Notification control has no owner window");
  const ownerWindow = view as Window & typeof globalThis;
  const event = new ownerWindow.MouseEvent("click", {
    bubbles: true,
    button: 0,
    buttons: 0,
    cancelable: true,
  });
  markJsdomEventTrusted(event);
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
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

function createStrictView(router: Router, notificationSnapshot: NotificationSnapshot) {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { root: createRoot(host), host };
  directViews.push(view);
  currentRouter = router;
  currentSnapshot = notificationSnapshot;
  act(() => view.root.render(
    <StrictMode>
      <NotificationsStrip />
    </StrictMode>,
  ));
  return view;
}

function renderStrictGeneration(
  view: DirectView,
  router: Router,
  notificationSnapshot: NotificationSnapshot,
  generation: string,
) {
  currentRouter = router;
  currentSnapshot = notificationSnapshot;
  act(() => {
    view.root.render(
      <StrictMode>
        <div key={generation}>
          <NotificationsStrip />
        </div>
      </StrictMode>,
    );
  });
}

function createStrictGenerationView(
  router: Router,
  notificationSnapshot: NotificationSnapshot,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { root: createRoot(host), host };
  directViews.push(view);
  renderStrictGeneration(view, router, notificationSnapshot, "initial");
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

function openButtons(container: HTMLElement = document.body) {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-testid="notification-open"]'),
  );
}

function dispatchKey(
  source: HTMLButtonElement,
  key: string,
  init: KeyboardEventInit = {},
  focus = true,
) {
  if (focus) source.focus();
  const view = source.ownerDocument.defaultView;
  if (!view) throw new Error("Notification control has no owner window");
  const ownerWindow = view as Window & typeof globalThis;
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    ...init,
  });
  let allowed = true;
  act(() => {
    allowed = source.dispatchEvent(event);
  });
  return { event, allowed };
}

function dispatchTrustedKey(
  source: HTMLButtonElement,
  key: string,
  init: KeyboardEventInit = {},
  focus = true,
) {
  if (focus) source.focus();
  const view = source.ownerDocument.defaultView;
  if (!view) throw new Error("Notification control has no owner window");
  const ownerWindow = view as Window & typeof globalThis;
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    ...init,
  });
  markJsdomEventTrusted(event);
  let allowed = true;
  act(() => {
    allowed = source.dispatchEvent(event);
  });
  return { event, allowed };
}

function dispatchTrustedDelete(
  source: HTMLButtonElement,
  init: KeyboardEventInit = {},
  focus = true,
) {
  return dispatchTrustedKey(
    source,
    "Delete",
    { code: "Delete", ...init },
    focus,
  );
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
    click(current.open);
    click(current.open);
    click(current.dismiss);
    click(current.readAll);
    click(current.readAll);

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

    click(current.dismiss);
    click(current.dismiss);
    click(current.open);

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
    click(first.open);
    click(first.dismiss);
    click(second.dismiss);
    click(second.open);

    first.readAllButton.disabled = true;
    click(first.readAll);
    first.readAllButton.disabled = false;
    click(first.readAll);
    click(first.readAll);

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

    click(second.dismiss);
    click(first.open);
    click(second.readAll);
    click(first.readAll);

    expect(store.markNotificationRead.mock.calls).toEqual([[ITEM.id], [ITEM.id]]);
    expect(store.markAllNotificationsRead).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM.documentId}?thread=${ITEM.refId}`);
  });

  it("keeps all action families exact after direct-root Strict Mode replay", () => {
    const router = createRouter("strict");
    const sharedSnapshot = snapshot([ITEM, ITEM_TWO], 2);
    const host = document.createElement("div");
    document.body.append(host);
    const view = { root: createRoot(host), host };
    directViews.push(view);
    const renderGeneration = (generation: string) => {
      currentRouter = router;
      currentSnapshot = sharedSnapshot;
      act(() => {
        view.root.render(
          <StrictMode>
            <div key={generation}>
              <NotificationsStrip />
              <NotificationsStrip />
              <NotificationsStrip />
            </div>
          </StrictMode>,
        );
      });
    };

    renderGeneration("A");
    const staleSections = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="notifications-strip"]'));
    const staleOpen = captureActions(0, staleSections[0]);
    const staleDismiss = captureActions(1, staleSections[1]);
    const staleReadAll = captureActions(0, staleSections[2]);
    const staleSectionRef = reactRef(staleOpen.section);
    const staleListRef = reactRef(staleOpen.list);
    const staleOpenRef = reactRef(staleOpen.openButton);
    const staleItemRef = reactRef(staleDismiss.item);
    const staleDismissRef = reactRef(staleDismiss.dismissButton);
    const staleReadAllRef = reactRef(staleReadAll.readAllButton);

    renderGeneration("B");
    const currentSections = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="notifications-strip"]'));
    const currentOpen = captureActions(0, currentSections[0]);
    const currentDismiss = captureActions(1, currentSections[1]);
    const currentReadAll = captureActions(0, currentSections[2]);
    expect(currentOpen.openButton).not.toBe(staleOpen.openButton);
    expect(currentDismiss.dismissButton).not.toBe(staleDismiss.dismissButton);
    expect(currentReadAll.readAllButton).not.toBe(staleReadAll.readAllButton);

    staleSectionRef(currentOpen.section);
    staleListRef(currentOpen.list);
    staleOpenRef(currentOpen.openButton);
    staleItemRef(currentDismiss.item);
    staleDismissRef(currentDismiss.dismissButton);
    staleReadAllRef(currentReadAll.readAllButton);
    staleReadAllRef(null);
    staleDismissRef(null);
    staleItemRef(null);
    staleOpenRef(null);
    staleListRef(null);
    staleSectionRef(null);
    expectStaleInert(staleOpen, view, [router]);
    expectStaleInert(staleDismiss, view, [router]);
    expectStaleInert(staleReadAll, view, [router]);
    invoke(currentOpen.open, staleOpen.openButton);
    invoke(currentDismiss.dismiss, staleDismiss.dismissButton);
    invoke(currentReadAll.readAll, staleReadAll.readAllButton);

    const order: string[] = [];
    store.markNotificationRead.mockImplementation((id) => {
      order.push(`mark:${id}`);
      if (id === ITEM.id) dispatchTrustedClick(currentOpen.openButton);
      if (id === ITEM_TWO.id) dispatchTrustedClick(currentDismiss.dismissButton);
      return Promise.resolve();
    });
    store.markAllNotificationsRead.mockImplementation(() => {
      order.push("mark-all");
      dispatchTrustedClick(currentReadAll.readAllButton);
      return Promise.resolve();
    });
    router.push.mockImplementation((href) => {
      order.push(`push:${href}`);
      dispatchTrustedClick(currentOpen.openButton);
    });

    const restoreOpen = interceptClick(currentOpen.openButton, (original, event) => {
      staleOpen.open(event);
      original(event);
      original(event);
    });
    const restoreDismiss = interceptClick(currentDismiss.dismissButton, (original, event) => {
      staleDismiss.dismiss(event);
      original(event);
      original(event);
    });
    const restoreReadAll = interceptClick(currentReadAll.readAllButton, (original, event) => {
      staleReadAll.readAll(event);
      original(event);
      original(event);
    });
    dispatchTrustedClick(currentOpen.openButton);
    dispatchTrustedClick(currentDismiss.dismissButton);
    dispatchTrustedClick(currentReadAll.readAllButton);
    restoreOpen();
    restoreDismiss();
    restoreReadAll();

    dispatchTrustedClick(currentOpen.openButton);
    dispatchTrustedClick(currentDismiss.dismissButton);
    dispatchTrustedClick(currentReadAll.readAllButton);
    expect(order).toEqual([
      `mark:${ITEM.id}`,
      `push:/d/${ITEM.documentId}?thread=${ITEM.refId}`,
      `mark:${ITEM_TWO.id}`,
      "mark-all",
    ]);
    expect(store.markNotificationRead.mock.calls).toEqual([[ITEM.id], [ITEM_TWO.id]]);
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM.documentId}?thread=${ITEM.refId}`);
  });

  it("requires an exact primary React and owner-document native click without consuming rejected attempts", () => {
    const router = createRouter("native-provenance");
    const view = createDirectView(router, snapshot([ITEM]));
    const current = captureActions();
    const focusTarget = connectedButton("Focus sentinel");
    focusTarget.focus();
    const markup = view.host.innerHTML;

    current.openButton.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 }),
    );
    current.openButton.setAttribute("aria-disabled", "true");
    dispatchTrustedClick(current.openButton);
    current.openButton.removeAttribute("aria-disabled");
    current.item.setAttribute("inert", "");
    dispatchTrustedClick(current.openButton);
    current.item.removeAttribute("inert");

    const restore = interceptClick(current.openButton, (original, event) => {
      const fabricated = { ...event } as unknown as ReactMouseEvent<HTMLButtonElement>;
      const mismatchedTarget = new Proxy(event, {
        get(target, property, receiver) {
          return property === "target" ? current.item : Reflect.get(target, property, receiver);
        },
      });
      original(fabricated);
      original(mismatchedTarget);
      original(event);
    });
    dispatchTrustedClick(current.openButton);
    restore();

    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM.documentId}?thread=${ITEM.refId}`);
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(focusTarget);
    expect(view.host.innerHTML).toBe(markup);
    focusTarget.remove();
  });

  it("revalidates the complete committed root, list, row, and control topology before claiming", () => {
    const router = createRouter("topology");
    const view = createDirectView(router, snapshot([ITEM, ITEM_TWO], 2));
    const first = captureActions(0);
    const second = captureActions(1);
    const markup = view.host.innerHTML;
    const sectionClass = first.section.className;
    const listClass = first.list.className;
    const rowKind = first.item.dataset.kind;

    first.section.className = `${sectionClass} changed`;
    dispatchTrustedClick(first.openButton);
    first.section.className = sectionClass;
    first.list.className = `${listClass} changed`;
    dispatchTrustedClick(first.openButton);
    first.list.className = listClass;
    first.item.dataset.kind = "reply";
    dispatchTrustedClick(first.openButton);
    first.item.dataset.kind = rowKind;

    first.list.append(first.item);
    dispatchTrustedClick(first.openButton);
    first.list.insertBefore(first.item, second.item);

    const replacement = first.item.cloneNode(true) as HTMLLIElement;
    first.item.replaceWith(replacement);
    dispatchTrustedClick(first.openButton);
    replacement.replaceWith(first.item);

    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(view.host.innerHTML).toBe(markup);

    const target = first.openButton.querySelector("span");
    if (!target) throw new Error("The Open control had no committed descendant target");
    dispatchTrustedClick(first.openButton, target);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM.documentId}?thread=${ITEM.refId}`);
  });

  it.each(["partial ref replay", "detach and reinsert"] as const)(
    "does not mint replacement authority after %s without the exact layout proof",
    (scenario) => {
      const router = createRouter(scenario);
      const sharedSnapshot = snapshot([ITEM]);
      const view = createDirectView(router, sharedSnapshot);
      const stale = captureActions();
      const openRef = reactRef(stale.openButton);

      if (scenario === "partial ref replay") {
        openRef(null);
        openRef(stale.openButton);
      } else {
        const sectionRef = reactRef(stale.section);
        const readAllRef = reactRef(stale.readAllButton);
        const listRef = reactRef(stale.list);
        const itemRef = reactRef(stale.item);
        const dismissRef = reactRef(stale.dismissButton);
        sectionRef(null);
        readAllRef(null);
        listRef(null);
        itemRef(null);
        openRef(null);
        dismissRef(null);
        stale.section.remove();
        view.host.append(stale.section);
        sectionRef(stale.section);
        readAllRef(stale.readAllButton);
        listRef(stale.list);
        itemRef(stale.item);
        openRef(stale.openButton);
        dismissRef(stale.dismissButton);
      }

      dispatchTrustedClick(stale.openButton);
      expect(store.markNotificationRead).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();

      let current!: CapturedActions;
      renderDirect(view, router, sharedSnapshot, {
        boundary: 1,
        passiveGeneration: scenario,
        onPassiveCleanup: vi.fn(),
        onBoundary: () => {
          current = captureActions();
        },
      });
      dispatchTrustedClick(current.openButton);
      expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
      expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM.documentId}?thread=${ITEM.refId}`);
    },
  );

  it.each(["open", "dismiss", "read-all"] as const)(
    "rejects an untrusted owner-realm %s click and accepts one trusted successor",
    (action) => {
      const router = createRouter(`click-trust-${action}`);
      const view = createStrictView(router, snapshot([ITEM]));
      const current = captureActions(0, view.host);
      const source =
        action === "open"
          ? current.openButton
          : action === "dismiss"
            ? current.dismissButton
            : current.readAllButton;
      const ownerWindow = source.ownerDocument.defaultView as
        | (Window & typeof globalThis)
        | null;
      if (!ownerWindow) throw new Error("The click source has no owner window");
      const untrusted = new ownerWindow.MouseEvent("click", {
        bubbles: true,
        button: 0,
        buttons: 0,
        cancelable: true,
      });

      act(() => {
        source.dispatchEvent(untrusted);
      });

      expect(untrusted.isTrusted).toBe(false);
      expect(store.markNotificationRead).not.toHaveBeenCalled();
      expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();

      dispatchTrustedClick(source);

      if (action === "read-all") {
        expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
        expect(store.markNotificationRead).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
      } else {
        expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(
          ITEM.id,
        );
        expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
        if (action === "open") {
          expect(router.push).toHaveBeenCalledExactlyOnceWith(
            `/d/${ITEM.documentId}?thread=${ITEM.refId}`,
          );
        } else {
          expect(router.push).not.toHaveBeenCalled();
        }
      }
    },
  );

  it("rejects replacement click wrapper trust, fields, and predicates before trusted recovery", () => {
    const router = createRouter("click-wrapper-parity");
    const view = createStrictView(router, snapshot([ITEM]));
    const current = captureActions(0, view.host);
    const restore = interceptClick(current.openButton, (original, event) => {
      original(new Proxy(event, {
        get(target, property, receiver) {
          if (property === "isTrusted") return false;
          return Reflect.get(target, property, receiver);
        },
      }));
      original(new Proxy(event, {
        get(target, property, receiver) {
          if (property === "button") return 1;
          return Reflect.get(target, property, receiver);
        },
      }));
      original(new Proxy(event, {
        get(target, property, receiver) {
          if (property === "isDefaultPrevented") return () => false;
          return Reflect.get(target, property, receiver);
        },
      }));
      expect(store.markNotificationRead).not.toHaveBeenCalled();
      expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      original(event);
    });
    try {
      dispatchTrustedClick(current.openButton);
    } finally {
      restore();
    }

    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledExactlyOnceWith(
      `/d/${ITEM.documentId}?thread=${ITEM.refId}`,
    );
  });

  it("accepts a trusted click independently of its React wrapper constructor name", () => {
    const router = createRouter("click-constructor-name");
    const view = createStrictView(router, snapshot([ITEM]));
    const current = captureActions(0, view.host);
    const restore = interceptClick(current.openButton, (original, event) => {
      const constructor = Object.getPrototypeOf(event)?.constructor;
      const descriptor = constructor
        ? Object.getOwnPropertyDescriptor(constructor, "name")
        : undefined;
      if (!constructor || !descriptor?.configurable) {
        throw new Error("The React event constructor name is not replaceable");
      }
      Object.defineProperty(constructor, "name", {
        ...descriptor,
        value: "M",
      });
      try {
        original(event);
      } finally {
        Object.defineProperty(constructor, "name", descriptor);
      }
    });
    try {
      dispatchTrustedClick(current.openButton);
    } finally {
      restore();
    }

    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(
      `/d/${ITEM.documentId}?thread=${ITEM.refId}`,
    );
  });
});

describe("notification strip keyboard browsing", () => {
  it.each([
    ["ArrowDown", 2, 0],
    ["ArrowUp", 0, 2],
    ["Home", 1, 0],
    ["End", 1, 2],
  ] as const)(
    "uses one trusted %s to prevent once and move focus from row %i to row %i only",
    (key, sourceIndex, destinationIndex) => {
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const router = createRouter(`trusted-${key}`);
      try {
        const view = createStrictView(
          router,
          snapshot([ITEM, ITEM_TWO, ITEM_THREE], 3),
        );
        const controls = openButtons(view.host);
        const source = controls[sourceIndex]!;
        const destination = controls[destinationIndex]!;
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();

        const result = dispatchTrustedKey(source, key, {}, false);

        expect(result.allowed).toBe(false);
        expect(result.event.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledOnce();
        expect(destination).toHaveFocus();
        expect(store.markNotificationRead).not.toHaveBeenCalled();
        expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
      } finally {
        preventDefault.mockRestore();
        focus.mockRestore();
      }
    },
  );

  it("rejects untrusted keyboard input and replacement wrapper facts before trusted recovery", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const router = createRouter("keyboard-wrapper-parity");
    try {
      const view = createStrictView(
        router,
        snapshot([ITEM, ITEM_TWO, ITEM_THREE], 3),
      );
      const controls = openButtons(view.host);
      const source = controls[1]!;
      source.focus();
      preventDefault.mockClear();
      focus.mockClear();

      const untrusted = dispatchKey(source, "ArrowDown", {}, false);
      expect(untrusted.event.isTrusted).toBe(false);
      expect(untrusted.allowed).toBe(true);

      const handler = reactKeyHandler(source);
      const restore = interceptKeyDown(source, (original, event) => {
        original(new Proxy(event, {
          get(target, property, receiver) {
            if (property === "isTrusted") return false;
            return Reflect.get(target, property, receiver);
          },
        }));
        original(new Proxy(event, {
          get(target, property, receiver) {
            if (property === "key") return "ArrowUp";
            return Reflect.get(target, property, receiver);
          },
        }));
        original(new Proxy(event, {
          get(target, property, receiver) {
            if (property === "isPropagationStopped") return () => false;
            return Reflect.get(target, property, receiver);
          },
        }));
        expect(handler).toBe(original);
      });
      try {
        const replaced = dispatchTrustedKey(
          source,
          "ArrowDown",
          {},
          false,
        );
        expect(replaced.allowed).toBe(true);
        expect(replaced.event.defaultPrevented).toBe(false);
      } finally {
        restore();
      }
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(source).toHaveFocus();
      expect(store.markNotificationRead).not.toHaveBeenCalled();
      expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();

      const recovered = dispatchTrustedKey(
        source,
        "ArrowDown",
        {},
        false,
      );
      expect(recovered.allowed).toBe(false);
      expect(recovered.event.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
      expect(controls[2]).toHaveFocus();
    } finally {
      preventDefault.mockRestore();
      focus.mockRestore();
    }
  });

  it("accepts trusted navigation independently of its React wrapper constructor name", () => {
    const router = createRouter("keyboard-constructor-name");
    const view = createStrictView(router, snapshot([ITEM, ITEM_TWO], 2));
    const controls = openButtons(view.host);
    const source = controls[0]!;
    source.focus();
    const restore = interceptKeyDown(source, (original, event) => {
      const constructor = Object.getPrototypeOf(event)?.constructor;
      const descriptor = constructor
        ? Object.getOwnPropertyDescriptor(constructor, "name")
        : undefined;
      if (!constructor || !descriptor?.configurable) {
        throw new Error("The React event constructor name is not replaceable");
      }
      Object.defineProperty(constructor, "name", {
        ...descriptor,
        value: "K",
      });
      try {
        original(event);
      } finally {
        Object.defineProperty(constructor, "name", descriptor);
      }
    });
    try {
      const result = dispatchTrustedKey(source, "ArrowDown", {}, false);
      expect(result.allowed).toBe(false);
      expect(result.event.defaultPrevented).toBe(true);
    } finally {
      restore();
    }

    expect(controls[1]).toHaveFocus();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("recognizes isTrusted as a keyboard-specific own descriptor, not a prototype getter", () => {
    const firstProbe = new window.KeyboardEvent("keydown");
    const secondProbe = new window.KeyboardEvent("keydown");
    const synthetic = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowDown",
    });
    const firstDescriptor = Object.getOwnPropertyDescriptor(
      firstProbe,
      "isTrusted",
    );
    const secondDescriptor = Object.getOwnPropertyDescriptor(
      secondProbe,
      "isTrusted",
    );
    const syntheticDescriptor = Object.getOwnPropertyDescriptor(
      synthetic,
      "isTrusted",
    );

    expect(Object.hasOwn(firstProbe, "isTrusted")).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(window.Event.prototype, "isTrusted"),
    ).toBeUndefined();
    expect(firstDescriptor?.get).toBeTypeOf("function");
    expect(secondDescriptor).toMatchObject({
      get: firstDescriptor?.get,
      set: firstDescriptor?.set,
      configurable: firstDescriptor?.configurable,
      enumerable: firstDescriptor?.enumerable,
    });
    expect(syntheticDescriptor).toMatchObject({
      get: firstDescriptor?.get,
      set: firstDescriptor?.set,
      configurable: firstDescriptor?.configurable,
      enumerable: firstDescriptor?.enumerable,
    });
    const plainDescriptor = Object.getOwnPropertyDescriptor(
      new window.Event("plain-event-probe"),
      "isTrusted",
    );
    if (plainDescriptor?.get !== firstDescriptor?.get) {
      expect(plainDescriptor?.get).not.toBe(firstDescriptor?.get);
    }

    const router = createRouter("trusted-own-descriptor");
    const view = createStrictView(router, snapshot([ITEM, ITEM_TWO], 2));
    const controls = openButtons(view.host);
    controls[0]!.focus();
    expect(controls[0]!.dispatchEvent(synthetic)).toBe(true);
    expect(controls[0]).toHaveFocus();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each([
    "ArrowDown",
    "ArrowUp",
    "Home",
    "End",
  ] as const)("rejects an untrusted synthetic %s event without changing focus", (key) => {
    const router = createRouter(`synthetic-${key}`);
    const view = createStrictView(
      router,
      snapshot([ITEM, ITEM_TWO, ITEM_THREE], 3),
    );
    const controls = openButtons(view.host);
    const source = controls[1]!;

    const result = dispatchKey(source, key);

    expect(result.event.isTrusted).toBe(false);
    expect(result.allowed).toBe(true);
    expect(source).toHaveFocus();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("keeps every open control in tab order when untrusted wrap attempts are rejected", () => {
    const router = createRouter("synthetic-wrap");
    const view = createStrictView(
      router,
      snapshot([ITEM, ITEM_TWO, ITEM_THREE], 3),
    );
    const controls = openButtons(view.host);
    const tabOrder = Array.from(
      view.host.querySelectorAll<HTMLButtonElement>("button"),
    );

    expect(dispatchKey(controls[2]!, "ArrowDown").allowed).toBe(true);
    expect(controls[2]).toHaveFocus();
    expect(dispatchKey(controls[0]!, "ArrowUp").allowed).toBe(true);
    expect(controls[0]).toHaveFocus();
    expect(tabOrder).toEqual([
      screen.getByTestId("notifications-strip-read-all"),
      controls[0],
      screen.getAllByTestId("notification-dismiss")[0],
      controls[1],
      screen.getAllByTestId("notification-dismiss")[1],
      controls[2],
      screen.getAllByTestId("notification-dismiss")[2],
    ]);
    expect(tabOrder.every((button) => button.tabIndex === 0)).toBe(true);
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("does not claim or refocus a synthetic one-row no-op", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const router = createRouter("one-row");
    const view = createStrictView(router, snapshot([ITEM]));
    const current = captureActions(0, view.host);
    current.openButton.focus();
    focus.mockClear();

    try {
      const result = dispatchKey(current.openButton, "Home", {}, false);
      expect(result.allowed).toBe(true);
      expect(current.openButton).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
    } finally {
      focus.mockRestore();
    }
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ] as const)("keeps script-created %s activation inert before trusted click recovery", async (_name, activation) => {
    const user = userEvent.setup();
    const router = createRouter(`activation-${_name}`);
    const view = createStrictView(router, snapshot([ITEM, ITEM_TWO], 2));
    const controls = openButtons(view.host);

    expect(dispatchKey(controls[0]!, "ArrowDown").allowed).toBe(true);
    expect(controls[0]).toHaveFocus();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    await user.keyboard(activation);

    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();

    dispatchTrustedClick(controls[0]!);

    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(
      `/d/${ITEM.documentId}?thread=${ITEM.refId}`,
    );
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Alt", { altKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["repeat", { repeat: true }],
    ["composition", { isComposing: true }],
  ] as const)("rejects trusted %s and accepts a later unmodified navigation", (_name, init) => {
    const router = createRouter(`reject-${_name}`);
    const view = createStrictView(router, snapshot([ITEM, ITEM_TWO], 2));
    const controls = openButtons(view.host);

    expect(dispatchTrustedKey(controls[0]!, "ArrowDown", init).allowed).toBe(true);
    expect(controls[0]).toHaveFocus();
    expect(dispatchTrustedKey(controls[0]!, "ArrowDown").allowed).toBe(false);
    expect(controls[1]).toHaveFocus();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("rejects canceled, stopped, foreign-realm, fabricated, dismiss, read-all, and unfocused events", () => {
    const router = createRouter("event-provenance");
    const view = createStrictView(router, snapshot([ITEM, ITEM_TWO], 2));
    const current = captureActions(0, view.host);
    const controls = openButtons(view.host);
    const sentinel = connectedButton("Focus sentinel");

    const cancel = (event: KeyboardEvent) => event.preventDefault();
    current.openButton.addEventListener("keydown", cancel, { capture: true, once: true });
    expect(dispatchTrustedKey(current.openButton, "ArrowDown").allowed).toBe(false);
    expect(current.openButton).toHaveFocus();

    const stop = (event: KeyboardEvent) => event.stopPropagation();
    current.openButton.addEventListener("keydown", stop, { capture: true, once: true });
    expect(dispatchTrustedKey(current.openButton, "ArrowDown").allowed).toBe(true);
    expect(current.openButton).toHaveFocus();

    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const foreignWindow = iframe.contentWindow as
      | (Window & typeof globalThis)
      | null;
    if (!foreignWindow) throw new Error("Foreign realm was not created");
    current.openButton.focus();
    const foreign = new foreignWindow.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowDown",
      view: foreignWindow,
    });
    // jsdom rejects a same-origin Window from another realm during Web IDL
    // conversion, so set the initialized slot to model the browser-valid input.
    const implementationSymbol = Object.getOwnPropertySymbols(foreign).find(
      (symbol) => String(symbol) === "Symbol(impl)",
    );
    if (!implementationSymbol) {
      throw new Error("Foreign event implementation slot was not available");
    }
    const implementation = (
      foreign as unknown as Record<symbol, { view: Window | null }>
    )[implementationSymbol];
    implementation.view = window;
    Object.setPrototypeOf(foreign, window.KeyboardEvent.prototype);
    expect(current.openButton.dispatchEvent(foreign)).toBe(true);
    expect(current.openButton).toHaveFocus();
    iframe.remove();

    sentinel.focus();
    current.keyDown({
      type: "keydown",
      key: "ArrowDown",
      target: current.openButton,
      currentTarget: current.openButton,
      nativeEvent: new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowDown",
      }),
      preventDefault: vi.fn(),
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
      persist: vi.fn(),
    } as unknown as ReactKeyboardEvent<HTMLButtonElement>);
    expect(sentinel).toHaveFocus();

    for (const outside of [current.dismissButton, current.readAllButton]) {
      const { propsKey, record, props } = reactPropsEntry(outside);
      record[propsKey] = { ...props, onKeyDown: current.keyDown };
      try {
        expect(dispatchTrustedKey(outside, "ArrowDown").allowed).toBe(true);
        expect(outside).toHaveFocus();
      } finally {
        record[propsKey] = props;
      }
    }

    sentinel.focus();
    expect(dispatchTrustedKey(controls[0]!, "ArrowDown", {}, false).allowed).toBe(true);
    expect(sentinel).toHaveFocus();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    sentinel.remove();
  });

  it.each([
    [
      "slotless owner-prototype object",
      () => Object.create(window.KeyboardEvent.prototype) as object,
    ],
    [
      "proxy whose native getters throw",
      () =>
        new Proxy(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "ArrowDown",
          }),
          {},
        ),
    ],
  ] as const)("fails closed without throwing for a %s", (_name, nativeEvent) => {
    const router = createRouter(`forged-${_name}`);
    const view = createStrictView(router, snapshot([ITEM, ITEM_TWO], 2));
    const current = captureActions(0, view.host);
    const sentinel = connectedButton("Forgery sentinel");
    const preventDefault = vi.fn();
    sentinel.focus();

    expect(() =>
      current.keyDown({
        type: "keydown",
        key: "ArrowDown",
        target: current.openButton,
        currentTarget: current.openButton,
        nativeEvent: nativeEvent(),
        preventDefault,
        isDefaultPrevented: () => false,
        isPropagationStopped: () => false,
        persist: vi.fn(),
      } as unknown as ReactKeyboardEvent<HTMLButtonElement>),
    ).not.toThrow();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(sentinel).toHaveFocus();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    sentinel.remove();
  });

  it("keeps clicks exact when a trusted getter changed before publication", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      KeyboardEvent.prototype,
      "key",
    );
    if (!descriptor?.get) throw new Error("KeyboardEvent.key getter is unavailable");
    Object.defineProperty(KeyboardEvent.prototype, "key", {
      ...descriptor,
      get() {
        return descriptor.get!.call(this);
      },
    });
    const router = createRouter("descriptor-before");
    let view!: DirectView;
    try {
      view = createStrictView(router, snapshot([ITEM, ITEM_TWO], 2));
    } finally {
      Object.defineProperty(KeyboardEvent.prototype, "key", descriptor);
    }
    const current = captureActions(0, view.host);

    expect(dispatchKey(current.openButton, "ArrowDown").allowed).toBe(true);
    expect(current.openButton).toHaveFocus();
    dispatchTrustedClick(current.openButton);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(
      `/d/${ITEM.documentId}?thread=${ITEM.refId}`,
    );
  });

  it("does not revive keyboard custody after a post-publication descriptor change", () => {
    const router = createRouter("descriptor-after");
    const view = createStrictView(router, snapshot([ITEM, ITEM_TWO], 2));
    const current = captureActions(0, view.host);
    const descriptor = Object.getOwnPropertyDescriptor(
      KeyboardEvent.prototype,
      "key",
    );
    if (!descriptor?.get) throw new Error("KeyboardEvent.key getter is unavailable");
    Object.defineProperty(KeyboardEvent.prototype, "key", {
      ...descriptor,
      get() {
        return descriptor.get!.call(this);
      },
    });
    try {
      expect(dispatchKey(current.openButton, "ArrowDown").allowed).toBe(true);
      expect(current.openButton).toHaveFocus();
    } finally {
      Object.defineProperty(KeyboardEvent.prototype, "key", descriptor);
    }

    expect(dispatchKey(current.openButton, "ArrowDown").allowed).toBe(true);
    expect(current.openButton).toHaveFocus();
    dispatchTrustedClick(current.openButton);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(
      `/d/${ITEM.documentId}?thread=${ITEM.refId}`,
    );
  });

  it.each([
    ["row reorder", (first: CapturedActions, second: CapturedActions) => {
      first.list.append(first.item);
      first.list.insertBefore(first.item, second.item);
    }],
    ["row removal", (first: CapturedActions) => {
      first.item.remove();
      first.list.prepend(first.item);
    }],
    ["row replacement", (first: CapturedActions) => {
      const replacement = first.item.cloneNode(true) as HTMLLIElement;
      first.item.replaceWith(replacement);
      replacement.replaceWith(first.item);
    }],
    ["mutation restore", (first: CapturedActions) => {
      const className = first.openButton.className;
      first.openButton.className = `${className} changed`;
      first.openButton.className = className;
    }],
    ["detach and reinsert", (first: CapturedActions, _second: CapturedActions, view: DirectView) => {
      first.section.remove();
      view.host.append(first.section);
    }],
  ] as const)("keeps a restored %s history inert and permits a fresh successor", (_name, tamper) => {
    const router = createRouter(`history-${_name}`);
    const sharedSnapshot = snapshot([ITEM, ITEM_TWO], 2);
    const view = createDirectView(router, sharedSnapshot);
    const first = captureActions(0, view.host);
    const second = captureActions(1, view.host);

    tamper(first, second, view);
    first.openButton.focus();
    expect(dispatchTrustedKey(first.openButton, "ArrowDown", {}, false).allowed).toBe(true);
    expect(first.openButton).toHaveFocus();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    let current!: CapturedActions;
    renderDirect(view, router, sharedSnapshot, {
      mount: "replacement",
      boundary: 1,
      passiveGeneration: `fresh-${_name}`,
      onPassiveCleanup: vi.fn(),
      onBoundary: () => {
        current = captureActions(0, view.host);
      },
    });
    expect(current.openButton).not.toBe(first.openButton);
    const currentControls = openButtons(view.host);
    expect(dispatchTrustedKey(currentControls[0]!, "ArrowDown").allowed).toBe(false);
    expect(currentControls[1]).toHaveFocus();
    dispatchTrustedClick(current.openButton);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(
      `/d/${ITEM.documentId}?thread=${ITEM.refId}`,
    );
  });

  it("rejects partial ref replay, then recovers click authority with a complete generation", () => {
    const router = createRouter("partial-replay");
    const sharedSnapshot = snapshot([ITEM, ITEM_TWO], 2);
    const view = createDirectView(router, sharedSnapshot);
    const stale = captureActions(0, view.host);
    const staleOpenRef = reactRef(stale.openButton);

    staleOpenRef(null);
    staleOpenRef(stale.openButton);
    stale.openButton.focus();
    expect(dispatchTrustedKey(stale.openButton, "ArrowDown", {}, false).allowed).toBe(true);
    expect(stale.openButton).toHaveFocus();

    let current!: CapturedActions;
    renderDirect(view, router, sharedSnapshot, {
      boundary: 1,
      passiveGeneration: "complete-replay",
      onPassiveCleanup: vi.fn(),
      onBoundary: () => {
        current = captureActions(0, view.host);
      },
    });
    const currentControls = openButtons(view.host);
    expect(dispatchTrustedKey(currentControls[0]!, "ArrowDown").allowed).toBe(false);
    expect(currentControls[1]).toHaveFocus();
    dispatchTrustedClick(current.openButton);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(
      `/d/${ITEM.documentId}?thread=${ITEM.refId}`,
    );
  });

  it("retires cleanup observers and leaves removed publication handlers inert", async () => {
    const NativeMutationObserver = window.MutationObserver;
    const active = new Set<MutationObserver>();
    class TrackingMutationObserver extends NativeMutationObserver {
      constructor(callback: MutationCallback) {
        super(callback);
        active.add(this);
      }

      override disconnect() {
        active.delete(this);
        super.disconnect();
      }
    }
    window.MutationObserver = TrackingMutationObserver;
    const router = createRouter("cleanup");
    let view: DirectView | null = null;
    try {
      view = createStrictView(router, snapshot([ITEM, ITEM_TWO], 2));
      const stale = captureActions(0, view.host);
      const removed = stale.section;
      expect(active.size).toBe(1);

      await act(async () => {
        view!.root.unmount();
        await Promise.resolve();
      });
      const index = directViews.indexOf(view);
      if (index >= 0) directViews.splice(index, 1);
      expect(active.size).toBe(0);

      view.host.append(removed);
      const sentinel = connectedButton("Cleanup sentinel");
      sentinel.focus();
      stale.keyDown({
        currentTarget: stale.openButton,
        nativeEvent: new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "ArrowDown",
        }),
      } as unknown as ReactKeyboardEvent<HTMLButtonElement>);
      expect(sentinel).toHaveFocus();
      expect(store.markNotificationRead).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      sentinel.remove();
    } finally {
      window.MutationObserver = NativeMutationObserver;
      view?.host.remove();
    }
  });
});

describe("notification strip row action navigation", () => {
  it.each([
    ["Open", "ArrowRight", "Numpad6", 3, "dismiss"],
    ["Mark as read", "ArrowLeft", "Numpad4", 3, "open"],
    ["Mark as read", "ArrowUp", "Numpad8", 3, "open"],
    ["Mark as read", "Home", "Numpad7", 3, "open"],
  ] as const)(
    "moves from %s on trusted %s without activating either action",
    (sourceName, key, code, location, destinationName) => {
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
      const router = createRouter(`row-action-${key}`);
      try {
        const view = createStrictView(router, snapshot([ITEM]));
        const actions = captureActions(0, view.host);
        const source = sourceName === "Open"
          ? actions.openButton
          : actions.dismissButton;
        const destination = destinationName === "open"
          ? actions.openButton
          : actions.dismissButton;
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();

        const result = dispatchTrustedKey(
          source,
          key,
          { code, location },
          false,
        );

        expect(result.allowed).toBe(false);
        expect(result.event.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(destination).toHaveFocus();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(store.markNotificationRead).not.toHaveBeenCalled();
        expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
      } finally {
        preventDefault.mockRestore();
        focus.mockRestore();
      }
    },
  );

  it.each([
    ["Open", "ArrowLeft"],
    ["Mark as read", "ArrowRight"],
    ["Mark as read", "ArrowDown"],
    ["Mark as read", "End"],
  ] as const)(
    "leaves the %s boundary key %s inert and unprevented",
    (sourceName, key) => {
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
      const router = createRouter(`row-boundary-${key}`);
      try {
        const view = createStrictView(router, snapshot([ITEM]));
        const actions = captureActions(0, view.host);
        const source = sourceName === "Open"
          ? actions.openButton
          : actions.dismissButton;
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();

        const result = dispatchTrustedKey(source, key, {}, false);

        expect(result.allowed).toBe(true);
        expect(result.event.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(source).toHaveFocus();
        expect(store.markNotificationRead).not.toHaveBeenCalled();
        expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
      } finally {
        preventDefault.mockRestore();
        focus.mockRestore();
      }
    },
  );

  it.each([
    ["ArrowDown", "Numpad2", 3],
    ["End", "Numpad1", 3],
  ] as const)(
    "preserves Open-control vertical %s browsing for numeric-keypad input",
    (key, code, location) => {
      const router = createRouter(`vertical-row-action-${key}`);
      const view = createStrictView(
        router,
        snapshot([ITEM, ITEM_TWO, ITEM_THREE], 3),
      );
      const controls = openButtons(view.host);
      controls[1]!.focus();

      const result = dispatchTrustedKey(
        controls[1]!,
        key,
        { code, location },
        false,
      );

      expect(result.allowed).toBe(false);
      expect(result.event.defaultPrevented).toBe(true);
      expect(controls[2]).toHaveFocus();
      expect(captureActions(1, view.host).dismissButton).not.toHaveFocus();
      expect(store.markNotificationRead).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
    },
  );

  it("authenticates independent public capture and bubble wrappers before using only bubble prevention", () => {
    const router = createRouter("independent-row-wrappers");
    const view = createStrictView(router, snapshot([ITEM]));
    const actions = captureActions(0, view.host);
    const capturePreventDefault = vi.fn();
    const bubblePreventDefault = vi.fn();
    let captureWrapper: ReactKeyboardEvent<HTMLLIElement> | null = null;
    let bubbleWrapper: ReactKeyboardEvent<HTMLButtonElement> | null = null;
    const restoreCapture = interceptKeyDownCapture(
      actions.item,
      (original, event) => {
        captureWrapper = event;
        const originalPreventDefault = event.preventDefault;
        event.preventDefault = function capturePrevention() {
          capturePreventDefault();
          originalPreventDefault.call(event);
        };
        original(event);
      },
    );
    const restoreBubble = interceptKeyDown(
      actions.openButton,
      (original, event) => {
        bubbleWrapper = event;
        const originalPreventDefault = event.preventDefault;
        event.preventDefault = function bubblePrevention() {
          bubblePreventDefault();
          originalPreventDefault.call(event);
        };
        original(event);
      },
    );
    try {
      actions.openButton.focus();
      const result = dispatchTrustedKey(
        actions.openButton,
        "ArrowRight",
        {},
        false,
      );

      expect(result.allowed).toBe(false);
      expect(actions.dismissButton).toHaveFocus();
      expect(captureWrapper).not.toBe(bubbleWrapper);
      expect(capturePreventDefault).not.toHaveBeenCalled();
      expect(bubblePreventDefault).toHaveBeenCalledOnce();
      expect(store.markNotificationRead).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
    } finally {
      restoreBubble();
      restoreCapture();
    }
  });

  it("accepts exact scalar wrapper values exposed through non-data descriptors", () => {
    const router = createRouter("row-wrapper-accessors");
    const view = createStrictView(router, snapshot([ITEM]));
    const actions = captureActions(0, view.host);
    const restoreCapture = interceptKeyDownCapture(
      actions.item,
      (original, event) => {
        exposeKeyboardScalarThroughGetter(event, "key");
        original(event);
      },
    );
    const restoreBubble = interceptKeyDown(
      actions.openButton,
      (original, event) => {
        exposeKeyboardScalarThroughGetter(event, "key");
        original(event);
      },
    );
    try {
      actions.openButton.focus();
      const result = dispatchTrustedKey(
        actions.openButton,
        "ArrowRight",
        {},
        false,
      );

      expect(result.allowed).toBe(false);
      expect(result.event.defaultPrevented).toBe(true);
      expect(actions.dismissButton).toHaveFocus();
      expect(store.markNotificationRead).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
    } finally {
      restoreBubble();
      restoreCapture();
    }
  });

  it("rejects scalar value and required-method drift without consuming a clean successor", () => {
    const router = createRouter("replaced-row-wrapper-facts");
    const view = createStrictView(router, snapshot([ITEM]));
    const actions = captureActions(0, view.host);
    actions.openButton.focus();

    const restoreCapture = interceptKeyDownCapture(
      actions.item,
      (original, event) => {
        const descriptor = Object.getOwnPropertyDescriptor(event, "key");
        if (!descriptor || !("value" in descriptor)) {
          throw new Error("The capture wrapper key was not public data");
        }
        Object.defineProperty(event, "key", {
          ...descriptor,
          value: "ArrowLeft",
        });
        original(event);
      },
    );
    try {
      const rejectedCapture = dispatchTrustedKey(
        actions.openButton,
        "ArrowRight",
        {},
        false,
      );
      expect(rejectedCapture.allowed).toBe(true);
      expect(rejectedCapture.event.defaultPrevented).toBe(false);
      expect(actions.openButton).toHaveFocus();
    } finally {
      restoreCapture();
    }

    const restoreBubble = interceptKeyDown(
      actions.openButton,
      (original, event) => {
        original(new Proxy(event, {
          get(target, property, receiver) {
            if (property === "preventDefault") return vi.fn();
            return Reflect.get(target, property, receiver);
          },
        }));
      },
    );
    try {
      const rejectedBubble = dispatchTrustedKey(
        actions.openButton,
        "ArrowRight",
        {},
        false,
      );
      expect(rejectedBubble.allowed).toBe(true);
      expect(rejectedBubble.event.defaultPrevented).toBe(false);
      expect(actions.openButton).toHaveFocus();
    } finally {
      restoreBubble();
    }

    const recovered = dispatchTrustedKey(
      actions.openButton,
      "ArrowRight",
      {},
      false,
    );
    expect(recovered.allowed).toBe(false);
    expect(actions.dismissButton).toHaveFocus();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("accepts the exact public owner Window and rejects a structural wrapper lookalike", () => {
    const router = createRouter("row-window-proof");
    const view = createStrictView(router, snapshot([ITEM]));
    const actions = captureActions(0, view.host);
    const ownerWindow = actions.openButton.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("Notification control has no owner window");
    actions.openButton.focus();

    const restore = interceptKeyDownCapture(
      actions.item,
      (original, event) => {
        const descriptor = Object.getOwnPropertyDescriptor(event, "view");
        if (!descriptor || !("value" in descriptor)) {
          throw new Error("The capture wrapper view was not public data");
        }
        Object.defineProperty(event, "view", {
          ...descriptor,
          value: Object.create(ownerWindow),
        });
        original(event);
      },
    );
    try {
      const rejected = dispatchTrustedKey(
        actions.openButton,
        "ArrowRight",
        {},
        false,
      );
      expect(rejected.allowed).toBe(true);
      expect(rejected.event.defaultPrevented).toBe(false);
      expect(actions.openButton).toHaveFocus();
    } finally {
      restore();
    }

    const setExactView = (
      event: ReactKeyboardEvent<HTMLElement>,
    ) => {
      const descriptor = Object.getOwnPropertyDescriptor(event, "view");
      if (!descriptor || !("value" in descriptor)) {
        throw new Error("The React wrapper view was not public data");
      }
      Object.defineProperty(event, "view", {
        ...descriptor,
        value: ownerWindow,
      });
    };
    const restoreCapture = interceptKeyDownCapture(
      actions.item,
      (original, event) => {
        setExactView(event);
        original(event);
      },
    );
    const restoreBubble = interceptKeyDown(
      actions.openButton,
      (original, event) => {
        setExactView(event);
        original(event);
      },
    );
    try {
      const accepted = dispatchTrustedKey(
        actions.openButton,
        "ArrowRight",
        {},
        false,
      );
      expect(accepted.allowed).toBe(false);
      expect(actions.dismissButton).toHaveFocus();
    } finally {
      restoreBubble();
      restoreCapture();
    }
  });

  it("rejects untrusted and modified dismiss input before a trusted successor", () => {
    const router = createRouter("dismiss-row-input");
    const view = createStrictView(router, snapshot([ITEM]));
    const actions = captureActions(0, view.host);
    actions.dismissButton.focus();

    const untrusted = dispatchKey(
      actions.dismissButton,
      "ArrowLeft",
      {},
      false,
    );
    const modified = dispatchTrustedKey(
      actions.dismissButton,
      "ArrowLeft",
      { ctrlKey: true },
      false,
    );

    expect(untrusted.allowed).toBe(true);
    expect(untrusted.event.defaultPrevented).toBe(false);
    expect(modified.allowed).toBe(true);
    expect(modified.event.defaultPrevented).toBe(false);
    expect(actions.dismissButton).toHaveFocus();

    const recovered = dispatchTrustedKey(
      actions.dismissButton,
      "ArrowLeft",
      {},
      false,
    );
    expect(recovered.allowed).toBe(false);
    expect(actions.openButton).toHaveFocus();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("retires restored DOM history and recovers only through a complete successor", async () => {
    const router = createRouter("restored-row-action-dom");
    const view = createStrictGenerationView(router, snapshot([ITEM, ITEM_TWO], 2));
    const stale = captureActions(0, view.host);
    const next = stale.item.nextElementSibling;
    stale.list.append(stale.item);
    stale.list.insertBefore(stale.item, next);
    await act(async () => {
      await Promise.resolve();
    });

    stale.openButton.focus();
    const rejected = dispatchTrustedKey(
      stale.openButton,
      "ArrowRight",
      {},
      false,
    );
    expect(rejected.allowed).toBe(true);
    expect(rejected.event.defaultPrevented).toBe(false);
    expect(stale.openButton).toHaveFocus();

    renderStrictGeneration(
      view,
      router,
      snapshot([ITEM, ITEM_TWO], 2),
      "successor",
    );
    const current = captureActions(0, view.host);
    current.openButton.focus();
    const accepted = dispatchTrustedKey(
      current.openButton,
      "ArrowRight",
      {},
      false,
    );
    expect(accepted.allowed).toBe(false);
    expect(current.dismissButton).toHaveFocus();
  });

  it("keeps native tab order and non-navigation activation keys untouched", async () => {
    const user = userEvent.setup();
    const router = createRouter("native-row-actions");
    const view = createStrictView(router, snapshot([ITEM]));
    const actions = captureActions(0, view.host);

    expect(actions.item).not.toHaveAttribute("role", "toolbar");
    expect(actions.openButton.tabIndex).toBe(0);
    expect(actions.dismissButton.tabIndex).toBe(0);
    actions.openButton.focus();
    await user.tab();
    expect(actions.dismissButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(actions.openButton).toHaveFocus();

    for (const key of ["Enter", " "] as const) {
      const open = dispatchTrustedKey(actions.openButton, key, {}, false);
      expect(open.allowed).toBe(true);
      expect(open.event.defaultPrevented).toBe(false);
      actions.dismissButton.focus();
      const dismiss = dispatchTrustedKey(
        actions.dismissButton,
        key,
        {},
        false,
      );
      expect(dismiss.allowed).toBe(true);
      expect(dismiss.event.defaultPrevented).toBe(false);
      actions.openButton.focus();
    }
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("removes every Strict Mode Window capture listener on retirement", async () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const router = createRouter("row-listener-cleanup");
    try {
      const view = createStrictView(router, snapshot([ITEM]));
      const addedListeners = addEventListener.mock.calls
        .filter(([type, , options]) => type === "keydown" && options === true)
        .map(([, listener]) => listener);
      const removedBeforeUnmount = removeEventListener.mock.calls
        .filter(([type, , options]) => type === "keydown" && options === true)
        .map(([, listener]) => listener);
      expect(addedListeners).toHaveLength(2);
      expect(removedBeforeUnmount).toEqual([addedListeners[0]]);

      await act(async () => {
        view.root.unmount();
        await Promise.resolve();
      });
      const index = directViews.indexOf(view);
      if (index >= 0) directViews.splice(index, 1);
      const removedAfterUnmount = removeEventListener.mock.calls
        .filter(([type, , options]) => type === "keydown" && options === true)
        .map(([, listener]) => listener);
      expect(removedAfterUnmount).toEqual(addedListeners);
    } finally {
      addEventListener.mockRestore();
      removeEventListener.mockRestore();
    }
  });
});

describe("notification strip Delete dismissal", () => {
  it.each([
    ["first", 0, ITEM.id],
    ["middle", 1, ITEM_TWO.id],
    ["last", 2, ITEM_THREE.id],
  ] as const)(
    "marks only the %s focused row read after one trusted prevention",
    (_position, sourceIndex, expectedId) => {
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const router = createRouter(`delete-${sourceIndex}`);
      const scroll = { x: window.scrollX, y: window.scrollY };
      try {
        const view = createStrictView(
          router,
          snapshot([ITEM, ITEM_TWO, ITEM_THREE], 3),
        );
        const controls = openButtons(view.host);
        const source = controls[sourceIndex]!;
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();
        store.markNotificationRead.mockImplementation((id) => {
          expect(id).toBe(expectedId);
          expect(document.activeElement).toBe(source);
          expect(focus).not.toHaveBeenCalled();
          return Promise.resolve();
        });

        const result = dispatchTrustedDelete(source, {}, false);

        expect(result.allowed).toBe(false);
        expect(result.event.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(
          expectedId,
        );
        expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(source).toHaveFocus();
        expect(window.scrollX).toBe(scroll.x);
        expect(window.scrollY).toBe(scroll.y);
      } finally {
        preventDefault.mockRestore();
        focus.mockRestore();
      }
    },
  );

  it("rejects untrusted, inexact, modified, repeated, composing, canceled, stopped, and unfocused Delete input", () => {
    const router = createRouter("delete-rejections");
    const view = createStrictView(
      router,
      snapshot([ITEM, ITEM_TWO, ITEM_THREE], 3),
    );
    const current = captureActions(1, view.host);
    const source = current.openButton;
    const sentinel = connectedButton("Delete focus sentinel");

    expect(dispatchKey(source, "Delete", { code: "Delete" }).allowed).toBe(true);
    for (const init of [
      { code: "Backspace" },
      { code: "Delete", location: 1 },
      { code: "Delete", ctrlKey: true },
      { code: "Delete", altKey: true },
      { code: "Delete", metaKey: true },
      { code: "Delete", shiftKey: true },
      { code: "Delete", repeat: true },
      { code: "Delete", isComposing: true },
    ] satisfies KeyboardEventInit[]) {
      const result = dispatchTrustedKey(source, "Delete", init);
      expect(result.allowed).toBe(true);
      expect(result.event.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
    }

    const cancel = (event: KeyboardEvent) => event.preventDefault();
    source.addEventListener("keydown", cancel, { capture: true, once: true });
    expect(dispatchTrustedDelete(source).allowed).toBe(false);
    expect(source).toHaveFocus();

    const stop = (event: KeyboardEvent) => event.stopPropagation();
    source.addEventListener("keydown", stop, { capture: true, once: true });
    expect(dispatchTrustedDelete(source).allowed).toBe(true);
    expect(source).toHaveFocus();

    sentinel.focus();
    const unfocused = dispatchTrustedDelete(source, {}, false);
    expect(unfocused.allowed).toBe(true);
    expect(unfocused.event.defaultPrevented).toBe(false);
    expect(sentinel).toHaveFocus();

    for (const outside of [current.dismissButton, current.readAllButton]) {
      const { propsKey, record, props } = reactPropsEntry(outside);
      record[propsKey] = { ...props, onKeyDown: current.keyDown };
      try {
        const result = dispatchTrustedDelete(outside);
        expect(result.allowed).toBe(true);
        expect(result.event.defaultPrevented).toBe(false);
        expect(outside).toHaveFocus();
      } finally {
        record[propsKey] = props;
      }
    }

    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    const recovered = dispatchTrustedDelete(source);
    expect(recovered.allowed).toBe(false);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(
      ITEM_TWO.id,
    );
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    sentinel.remove();
  });

  it("claims the exact React wrapper, native event, row, action, and publication once before reentry", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const router = createRouter("delete-one-use");
    const view = createStrictView(
      router,
      snapshot([ITEM, ITEM_TWO, ITEM_THREE], 3),
    );
    const current = captureActions(1, view.host);
    let reenter: () => void = () => undefined;
    store.markNotificationRead.mockImplementation(() => {
      reenter();
      return Promise.resolve();
    });
    current.openButton.focus();
    preventDefault.mockClear();
    const restore = interceptKeyDown(current.openButton, (original, event) => {
      original({ ...event } as ReactKeyboardEvent<HTMLButtonElement>);
      original(new Proxy(event, {
        get(target, property, receiver) {
          if (property === "isTrusted") return false;
          return Reflect.get(target, property, receiver);
        },
      }));
      original(new Proxy(event, {
        get(target, property, receiver) {
          if (property === "view") return undefined;
          return Reflect.get(target, property, receiver);
        },
      }));
      original(new Proxy(event, {
        get(target, property, receiver) {
          if (property === "code") return "Backspace";
          return Reflect.get(target, property, receiver);
        },
      }));
      expect(store.markNotificationRead).not.toHaveBeenCalled();
      reenter = () => original(event);
      original(event);
      original(event);
    });
    try {
      const result = dispatchTrustedDelete(current.openButton, {}, false);
      expect(result.allowed).toBe(false);
      expect(result.event.defaultPrevented).toBe(true);
    } finally {
      restore();
      preventDefault.mockRestore();
    }

    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(
      ITEM_TWO.id,
    );
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("keeps stale item, router, and row-order facts inert before a complete clean successor", () => {
    const first = { ...ITEM };
    const second = { ...ITEM_TWO };
    const third = { ...ITEM_THREE };
    const items = [first, second, third];
    const current = snapshot(items, 3);
    const router = createRouter("delete-stale");
    const view = createStrictGenerationView(router, current);
    const stale = captureActions(0, view.host);

    first.documentTitle = "Mutated title";
    items.reverse();
    router.push = vi.fn();
    stale.openButton.focus();
    const rejected = dispatchTrustedDelete(stale.openButton, {}, false);

    expect(rejected.allowed).toBe(true);
    expect(rejected.event.defaultPrevented).toBe(false);
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    renderStrictGeneration(view, router, current, "successor");
    const successor = captureActions(0, view.host);
    expect(successor.item).toHaveAttribute(
      "data-notification-id",
      ITEM_THREE.id,
    );
    const accepted = dispatchTrustedDelete(successor.openButton);
    expect(accepted.allowed).toBe(false);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(
      ITEM_THREE.id,
    );
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each([
    ["reordered row", (first: CapturedActions, second: CapturedActions) => {
      first.list.append(first.item);
      first.list.insertBefore(first.item, second.item);
    }],
    ["detached row", (first: CapturedActions) => {
      first.item.remove();
      first.list.prepend(first.item);
    }],
    ["replaced row", (first: CapturedActions) => {
      const replacement = first.item.cloneNode(true) as HTMLLIElement;
      first.item.replaceWith(replacement);
      replacement.replaceWith(first.item);
    }],
    ["restored attribute", (first: CapturedActions) => {
      const className = first.openButton.className;
      first.openButton.className = `${className} changed`;
      first.openButton.className = className;
    }],
    ["detached strip", (first: CapturedActions, _second: CapturedActions, view: DirectView) => {
      first.section.remove();
      view.host.append(first.section);
    }],
  ] as const)(
    "rejects a restored %s DOM history and lets a distinct clean successor recover",
    (_scenario, tamper) => {
      const router = createRouter(`delete-history-${_scenario}`);
      const current = snapshot([ITEM, ITEM_TWO], 2);
      const view = createStrictGenerationView(router, current);
      const first = captureActions(0, view.host);
      const second = captureActions(1, view.host);

      tamper(first, second, view);
      const rejected = dispatchTrustedDelete(first.openButton);
      expect(rejected.allowed).toBe(true);
      expect(rejected.event.defaultPrevented).toBe(false);
      expect(store.markNotificationRead).not.toHaveBeenCalled();
      expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();

      renderStrictGeneration(view, router, current, `successor-${_scenario}`);
      const sections = view.host.querySelectorAll<HTMLElement>(
        '[data-testid="notifications-strip"]',
      );
      const successor = captureActions(0, sections[sections.length - 1]!);
      const accepted = dispatchTrustedDelete(successor.openButton);
      expect(accepted.allowed).toBe(false);
      expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(
        ITEM.id,
      );
      expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
    },
  );

  it("does not revive Delete authority after a keyboard descriptor is replaced and restored", () => {
    const router = createRouter("delete-descriptor");
    const current = snapshot([ITEM, ITEM_TWO], 2);
    const view = createStrictGenerationView(router, current);
    const stale = captureActions(0, view.host);
    const descriptor = Object.getOwnPropertyDescriptor(
      KeyboardEvent.prototype,
      "code",
    );
    if (!descriptor?.get) {
      throw new Error("KeyboardEvent.code getter is unavailable");
    }
    Object.defineProperty(KeyboardEvent.prototype, "code", {
      ...descriptor,
      get() {
        return descriptor.get!.call(this);
      },
    });
    try {
      expect(dispatchTrustedDelete(stale.openButton).allowed).toBe(true);
    } finally {
      Object.defineProperty(KeyboardEvent.prototype, "code", descriptor);
    }

    expect(dispatchTrustedDelete(stale.openButton).allowed).toBe(true);
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    renderStrictGeneration(view, router, current, "descriptor-successor");
    const successor = captureActions(0, view.host);
    expect(dispatchTrustedDelete(successor.openButton).allowed).toBe(false);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(
      ITEM.id,
    );
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("retires a cleaned-up Delete handler and accepts a later complete mount", async () => {
    const router = createRouter("delete-cleanup");
    const current = snapshot([ITEM, ITEM_TWO], 2);
    const view = createStrictView(router, current);
    const stale = captureActions(0, view.host);
    const staleInput: {
      event?: ReactKeyboardEvent<HTMLButtonElement>;
    } = {};
    const restore = interceptKeyDown(stale.openButton, (original, event) => {
      expect(original).toBe(stale.keyDown);
      staleInput.event = event;
    });
    dispatchTrustedDelete(stale.openButton);
    restore();
    const removed = stale.section;

    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
    const index = directViews.indexOf(view);
    if (index >= 0) directViews.splice(index, 1);
    view.host.append(removed);
    if (!staleInput.event) {
      throw new Error("The stale Delete event was not captured");
    }
    stale.keyDown(staleInput.event);

    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    const successor = createStrictView(router, current);
    const active = captureActions(1, successor.host);
    expect(dispatchTrustedDelete(active.openButton).allowed).toBe(false);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(
      ITEM_TWO.id,
    );
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    view.host.remove();
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
        click(current.dismiss);
        click(current.readAll);
      },
    });

    expect(passiveCleanup).toHaveBeenCalledOnce();
    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(store.markNotificationRead).toHaveBeenCalledWith(ITEM_TWO.id);
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
    expectStaleInert(stale, view, [router]);
    click(current.open);
    click(current.dismiss);
    click(current.readAll);
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
        click(current.open);
        click(current.readAll);
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
    click(current.open);
    click(current.dismiss);
    click(current.readAll);
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
          click(current.open);
          click(current.readAll);
          if (order === "current-before-stale") expectStaleInert(stale, view, [router]);
        },
      });

      expect(firstPush).not.toHaveBeenCalled();
      expect(replacementPush).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM.documentId}?thread=${ITEM.refId}`);
      expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
      expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
      expect(passiveCleanup).toHaveBeenCalledOnce();
      click(current.open);
      click(current.dismiss);
      click(current.readAll);
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
    sharedSnapshot.unreadCount = 7;
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
        expect(screen.getByRole("heading", { name: /Notifications\s*7/ })).toBeVisible();
        click(current.open);
        click(current.readAll);
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
        click(currentFirst.open);
        click(currentSecond.dismiss);
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
          click(current.open);
          click(current.readAll);
        }
        expectStaleInert(stale, view, [router]);
        if (!currentFirst) {
          click(current.open);
          click(current.readAll);
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
    click(current.open);
    click(current.dismiss);
    click(current.readAll);
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
        click(current.dismiss);
        click(current.readAll);
      },
    });

    expect(store.markNotificationRead).toHaveBeenCalledOnce();
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(passiveCleanup).toHaveBeenCalledOnce();
    expectStaleInert(stale, view, [router]);
    click(current.dismiss);
    click(current.open);
    click(current.readAll);
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
        click(current.open);
        click(current.readAll);
      },
    });

    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM.documentId}?thread=${ITEM.refId}`);
    expect(passiveCleanup).toHaveBeenCalledOnce();
    expectStaleInert(stale, view, [router]);
    click(current.dismiss);
    click(current.readAll);
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
        click(current.open);
        click(current.readAll);
      },
    });
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledExactlyOnceWith(`/d/${ITEM.documentId}?thread=${ITEM.refId}`);
  });
});
