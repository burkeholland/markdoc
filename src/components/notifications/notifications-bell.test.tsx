// @vitest-environment jsdom
import { StrictMode, useLayoutEffect, type ComponentProps } from "react";
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
interface ContentCallbacks {
  escape?: (event: KeyboardEvent) => void;
  outside?: unknown;
}

const capturedPopoverOpenChanges = vi.hoisted(() => [] as PopoverOpenChange[]);
const capturedContentCallbacks = vi.hoisted(() => [] as ContentCallbacks[]);

vi.mock("@/lib/notifications-store", () => ({
  ...store,
  sentence: () => "mentioned you",
}));

vi.mock("@/components/ui/primitives", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/primitives")>();
  const ActualPopover = actual.Popover;
  const ActualPopoverContent = actual.PopoverContent;
  return {
    ...actual,
    Popover: (props: ComponentProps<typeof ActualPopover>) => {
      if (props.onOpenChange) capturedPopoverOpenChanges.push(props.onOpenChange);
      return <ActualPopover {...props} />;
    },
    PopoverContent: (props: ComponentProps<typeof ActualPopoverContent>) => {
      capturedContentCallbacks.push({
        escape: props.onEscapeKeyDown,
        outside: props.onInteractOutside,
      });
      return <ActualPopoverContent {...props} />;
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

interface CapturedMouseEvent {
  type: string;
  currentTarget: EventTarget | null;
  target: EventTarget | null;
  nativeEvent: Event;
  defaultPrevented: boolean;
}

type MouseHandler = (event: CapturedMouseEvent) => void;
type ElementRef<T extends HTMLElement> = (element: T | null) => void;

interface CapturedControl {
  element: HTMLButtonElement;
  click: MouseHandler;
  ref: ElementRef<HTMLButtonElement>;
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
const ITEM_TWO: NotificationDto = {
  ...ITEM,
  id: "notification-two",
  kind: "reply",
  documentId: "document-two",
  documentTitle: "Second launch plan",
  actorLogin: "bob",
  actorName: "Bob",
  refId: "thread-two",
  snippet: "A second notification",
  createdAt: "2026-09-07T13:00:00.000Z",
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
const READ_FAILURE: NotificationReadError = {
  id: 7,
  operationId: 7,
  operation: "single",
  message: "Couldn't mark this notification as read.",
  notificationId: ITEM.id,
};

const directRoots: { root: Root; host: HTMLDivElement }[] = [];

function reactProperty<T>(element: HTMLElement, name: string): T | undefined {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  return props?.[name] as T | undefined;
}

function reactHandler<T extends (...args: never[]) => unknown>(element: HTMLElement, name: string): T {
  const handler = reactProperty<T>(element, name);
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return handler;
}

function reactRef<T extends HTMLElement>(element: HTMLElement): ElementRef<T> {
  const ref = reactProperty<ElementRef<T>>(element, "ref");
  if (typeof ref !== "function") throw new Error(`A callback ref was not attached to ${element.dataset.testid ?? element.tagName}`);
  return ref;
}

function captureControl(element: HTMLElement): CapturedControl {
  if (!(element instanceof HTMLButtonElement)) throw new Error("Expected a button control");
  return {
    element,
    click: reactHandler<MouseHandler>(element, "onClick"),
    ref: reactRef<HTMLButtonElement>(element),
  };
}

function dispatchWithHandlers(control: CapturedControl, handlers: readonly MouseHandler[]) {
  const propsKey = Object.keys(control.element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the control");
  const props = (control.element as unknown as Record<string, Record<string, unknown>>)[propsKey];
  if (!props) throw new Error("React props were not attached to the control");
  const properties = control.element as unknown as Record<string, Record<string, unknown>>;
  const wrapped = {
    ...props,
    onClick: (event: CapturedMouseEvent) => {
      for (const handler of handlers) handler(event);
    },
  };
  properties[propsKey] = wrapped;
  try {
    fireEvent.click(control.element);
  } finally {
    if (properties[propsKey] === wrapped) properties[propsKey] = props;
  }
}

function captureActions() {
  return {
    readRetry: screen.queryByTestId("notifications-read-retry")
      ? captureControl(screen.getByTestId("notifications-read-retry"))
      : null,
    loadRetry: screen.queryByTestId("notifications-load-retry")
      ? captureControl(screen.getByTestId("notifications-load-retry"))
      : null,
    readAll: captureControl(screen.getByTestId("notifications-read-all")),
    rows: screen.queryAllByTestId("notification-item").map(captureControl),
  };
}

function capturedMouseEvent(
  control: CapturedControl,
  source: EventTarget | null = control.element,
  target: EventTarget | null = source,
  nativeTarget: EventTarget | null = target,
): CapturedMouseEvent {
  const ownerDocument = source instanceof Node ? source.ownerDocument ?? document : document;
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  const nativeEvent = new MouseEventConstructor("click", { bubbles: true });
  Object.defineProperty(nativeEvent, "target", { configurable: true, value: nativeTarget });
  return {
    type: "click",
    currentTarget: source,
    target,
    nativeEvent,
    defaultPrevented: false,
  };
}

function invoke(control: CapturedControl, source: EventTarget | null = control.element, target: EventTarget | null = source) {
  control.click(capturedMouseEvent(control, source, target));
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

function createStrictBellRoot(
  state: BellState,
  props: NotificationsBellProps,
  onBoundary: () => void,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  directRoots.push({ root, host });
  store.useNotifications.mockReturnValue(state);
  act(() =>
    root.render(
      <StrictMode>
        <BellBoundary {...props} boundary={1} onBoundary={onBoundary} />
      </StrictMode>,
    ),
  );
  return root;
}
function renderBellRoot(
  root: Root,
  state: BellState,
  props: NotificationsBellProps & {
    present?: boolean;
    boundary?: number;
    onBoundary?: () => void;
  },
) {
  store.useNotifications.mockReturnValue(state);
  act(() => root.render(<BellBoundary {...props} />));
}

function latestOpenChange(except?: PopoverOpenChange) {
  const callback = capturedPopoverOpenChanges.findLast((candidate) => candidate !== except);
  if (!callback) throw new Error("The popover did not publish an open-change callback");
  return callback;
}

function latestContentCallbacks(except?: ContentCallbacks) {
  const callbacks = capturedContentCallbacks.findLast((candidate) => candidate !== except);
  if (!callbacks) throw new Error("The popover did not publish content callbacks");
  return callbacks;
}

function openCurrentBell() {
  fireEvent.click(screen.getByTestId("notifications-bell"));
  expect(screen.getByTestId("notifications-popover")).toBeVisible();
}

function openBell(state: BellState, onOpen = vi.fn()) {
  store.useNotifications.mockReturnValue(state);
  const view = render(
    <TooltipProvider>
      <NotificationsBell onOpen={onOpen} />
    </TooltipProvider>,
  );
  openCurrentBell();
  return view;
}

function outsideEvent(target: Node) {
  const ownerDocument = target.ownerDocument ?? document;
  const view = ownerDocument.defaultView;
  if (!view) throw new Error("Outside target has no window");
  const originalEvent = new view.MouseEvent("pointerdown", { bubbles: true });
  Object.defineProperty(originalEvent, "target", { configurable: true, value: target });
  const event = new view.CustomEvent("dismissableLayer.pointerDownOutside", {
    cancelable: true,
    detail: { originalEvent },
  });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function escapeEvent(target: Node) {
  const ownerDocument = target.ownerDocument ?? document;
  const view = ownerDocument.defaultView;
  if (!view) throw new Error("Escape target has no window");
  const event = new view.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  Object.defineProperty(event, "currentTarget", { configurable: true, value: ownerDocument });
  return event;
}

function invokeOutside(callback: unknown, event: Event) {
  if (typeof callback !== "function") throw new Error("The popover did not publish an outside callback");
  callback(event);
}

beforeEach(() => {
  capturedPopoverOpenChanges.length = 0;
  capturedContentCallbacks.length = 0;
  store.useNotifications.mockReset();
  store.refreshNotifications.mockReset().mockResolvedValue(undefined);
  store.markAllNotificationsRead.mockReset().mockResolvedValue(undefined);
  store.markNotificationRead.mockReset().mockResolvedValue(undefined);
  store.retryNotificationRead.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  while (directRoots.length) {
    const mounted = directRoots.pop()!;
    act(() => mounted.root.unmount());
    mounted.host.remove();
  }
});

describe("notification read actions", () => {
  it("claims a single read before opening the immutable item once", () => {
    const order: string[] = [];
    const onOpen = vi.fn((notification: NotificationDto) => {
      order.push("open");
      expect(Object.isFrozen(notification)).toBe(true);
    });
    store.markNotificationRead.mockImplementation(() => {
      order.push("read");
      return Promise.resolve();
    });
    openBell({ ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true }, onOpen);

    fireEvent.click(screen.getByTestId("notification-item"));

    expect(order).toEqual(["read", "open"]);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM);
  });

  it("keeps optimistic all-read, retry pending, badge, labels, and rollback behavior", () => {
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
    expect(screen.getByRole("button", { name: "Marking all…" })).toBeDisabled();
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
    expect(screen.getByRole("alert")).toHaveTextContent(failure.message);
    fireEvent.click(screen.getByTestId("notifications-read-retry"));
    expect(store.retryNotificationRead).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("disables a mutation retry while its replacement owner is pending", () => {
    openBell({
      ...EMPTY,
      items: [{ ...ITEM, readAt: "2026-09-07T12:10:00.000Z" }],
      loaded: true,
      readError: READ_FAILURE,
      readErrorPending: true,
    });

    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
  });
});

describe("notification bell loading", () => {
  it("shows a neutral first-load state instead of claiming empty success", () => {
    openBell({ ...EMPTY, loading: true });

    expect(screen.getByText("Loading notifications…")).toBeVisible();
    expect(screen.queryByText("You're all caught up.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows one first-load Retry and publishes its exact pending replacement", () => {
    const onOpen = vi.fn();
    const view = openBell({ ...EMPTY, loadError: true }, onOpen);
    const retry = screen.getByTestId("notifications-load-retry");

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load notifications.");
    fireEvent.click(retry);
    expect(store.refreshNotifications).toHaveBeenCalledOnce();

    store.useNotifications.mockReturnValue({ ...EMPTY, loading: true, loadError: true });
    view.rerender(
      <TooltipProvider>
        <NotificationsBell onOpen={onOpen} />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
  });

  it("shows empty success only after a successful load", () => {
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

describe("Radix disclosure provenance", () => {
  const state = { ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true };

  it("requires one current trigger proof for each open and close callback", () => {
    createBellRoot(state, { onOpen: vi.fn() });
    const closedCallback = latestOpenChange();

    act(() => {
      closedCallback(true);
      closedCallback(false);
    });
    expect(screen.queryByTestId("notifications-popover")).toBeNull();

    openCurrentBell();
    const openCallback = latestOpenChange(closedCallback);
    act(() => {
      closedCallback(false);
      openCallback(false);
      openCallback(false);
    });
    expect(screen.getByTestId("notifications-popover")).toBeVisible();

    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    act(() => openCallback(false));
    expect(screen.queryByTestId("notifications-popover")).toBeNull();

    openCurrentBell();
    expect(screen.getByTestId("notifications-read-all")).toBeEnabled();
  });

  it("accepts actual Escape and outside dismissal while rejecting stale content provenance", async () => {
    const root = createBellRoot(state, { currentDocId: "document-one", onOpen: vi.fn() });
    openCurrentBell();
    fireEvent.keyDown(screen.getByTestId("notification-item"), { key: "Escape" });
    expect(screen.queryByTestId("notifications-popover")).toBeNull();

    openCurrentBell();
    const staleContent = latestContentCallbacks();
    const staleOpenChange = latestOpenChange();
    renderBellRoot(root, state, {
      currentDocId: "document-two",
      onOpen: vi.fn(),
      boundary: 1,
      onBoundary: () => {
        expect(screen.queryByTestId("notifications-popover")).toBeNull();
        staleContent.escape?.(new KeyboardEvent("keydown", { key: "Escape" }));
        staleOpenChange(false);
      },
    });

    openCurrentBell();
    const outside = document.createElement("button");
    document.body.append(outside);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.pointerDown(outside);
    await act(() => Promise.resolve());
    fireEvent.click(outside);
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    outside.remove();
  });

  it("rejects same-document Escape outside the exact content without spending its close proof", () => {
    const onOpen = vi.fn();
    createBellRoot(state, { onOpen });
    openCurrentBell();
    const content = latestContentCallbacks();
    const openChange = latestOpenChange();
    const outside = document.createElement("button");
    document.body.append(outside);
    const focused = document.activeElement;
    const event = escapeEvent(outside);

    act(() => {
      content.escape?.(event);
      openChange(false);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(focused);
    expect(screen.getByTestId("notifications-popover")).toBeVisible();
    expect(store.retryNotificationRead).not.toHaveBeenCalled();
    expect(store.refreshNotifications).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();

    const row = screen.getByTestId("notification-item");
    fireEvent.keyDown(row, { key: "Escape" });
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    outside.remove();
  });

  it("rejects current content callbacks sourced from another document without spending a proof", async () => {
    createBellRoot(state, { onOpen: vi.fn() });
    openCurrentBell();
    const content = latestContentCallbacks();
    const openChange = latestOpenChange();
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const foreignTarget = iframe.contentDocument!.createElement("button");
    iframe.contentDocument!.body.append(foreignTarget);

    act(() => {
      invokeOutside(content.outside, outsideEvent(foreignTarget));
      openChange(false);
    });
    expect(screen.getByTestId("notifications-popover")).toBeVisible();

    const outside = document.createElement("button");
    document.body.append(outside);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.pointerDown(outside);
    await act(() => Promise.resolve());
    fireEvent.click(outside);
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    outside.remove();
    iframe.remove();
  });

  it("accepts a genuine owner-document focus-outside dismissal", async () => {
    createBellRoot(state, { onOpen: vi.fn() });
    openCurrentBell();
    const outside = document.createElement("button");
    document.body.append(outside);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    act(() => outside.focus());

    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    outside.remove();
  });

  it("rejects stale and fabricated trigger handlers on a reused bell", () => {
    const onOpen = vi.fn();
    const root = createBellRoot(state, { currentDocId: "document-one", onOpen });
    const trigger = captureControl(screen.getByTestId("notifications-bell"));
    let currentTrigger!: CapturedControl;

    renderBellRoot(root, state, {
      currentDocId: "document-two",
      onOpen,
      boundary: 1,
      onBoundary: () => {
        currentTrigger = captureControl(screen.getByTestId("notifications-bell"));
        expect(currentTrigger.element).toBe(trigger.element);
        invoke(trigger, currentTrigger.element);
        expect(screen.queryByTestId("notifications-popover")).toBeNull();
      },
    });

    act(() => invoke(currentTrigger, currentTrigger.element, document.body));
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    openCurrentBell();
  });
});

describe("exact notification controls", () => {
  const state = {
    ...EMPTY,
    items: [ITEM, ITEM_TWO],
    unreadCount: 2,
    loadError: true,
    readError: READ_FAILURE,
  };

  it("rejects sibling, foreign, detached, wrong-row, and cross-control sources independently", () => {
    const onOpen = vi.fn();
    createBellRoot(state, { onOpen });
    openCurrentBell();
    const actions = captureActions();
    const readRetry = actions.readRetry!;
    const loadRetry = actions.loadRetry!;
    const detached = document.createElement("button");
    const foreign = document.createElement("button");
    document.body.append(foreign);
    act(() => {
      invoke(readRetry, loadRetry.element);
      invoke(loadRetry, actions.readAll.element);
      invoke(actions.readAll, detached);
      invoke(actions.rows[0]!, actions.rows[1]!.element);
      invoke(actions.rows[1]!, foreign);
    });

    expect(store.retryNotificationRead).not.toHaveBeenCalled();
    expect(store.refreshNotifications).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(readRetry.element);
    fireEvent.click(loadRetry.element);
    fireEvent.click(actions.readAll.element);
    expect(store.retryNotificationRead).toHaveBeenCalledOnce();
    expect(store.refreshNotifications).toHaveBeenCalledOnce();
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();

    fireEvent.click(actions.rows[0]!.element);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM);
    foreign.remove();
  });

  it("requires an exact native click and target provenance before claiming captured action handlers", () => {
    const onOpen = vi.fn();
    createBellRoot(state, { onOpen });
    openCurrentBell();
    const actions = captureActions();
    const readRetry = actions.readRetry!;
    const loadRetry = actions.loadRetry!;
    const readAllTarget = actions.readAll.element.firstElementChild;
    if (!readAllTarget) throw new Error("The read-all control has no rendered descendant");
    const unpublishedControl = document.createElement("button");
    const unpublishedDescendant = document.createElement("span");
    unpublishedControl.append(unpublishedDescendant);
    document.body.append(unpublishedControl);
    const focused = document.activeElement;
    const fabricated = {
      ...capturedMouseEvent(readRetry),
      nativeEvent: new Event("click"),
    };
    const wrongType = {
      ...capturedMouseEvent(loadRetry),
      type: "pointerdown",
    };
    const mismatched = capturedMouseEvent(
      actions.readAll,
      actions.readAll.element,
      readAllTarget,
      actions.readAll.element,
    );
    const unpublished = capturedMouseEvent(
      actions.rows[0]!,
      actions.rows[0]!.element,
      unpublishedDescendant,
    );

    act(() => {
      readRetry.click(fabricated);
      loadRetry.click(wrongType);
      actions.readAll.click(mismatched);
      actions.rows[0]!.click(unpublished);
    });

    expect(fabricated.defaultPrevented).toBe(false);
    expect(wrongType.defaultPrevented).toBe(false);
    expect(mismatched.defaultPrevented).toBe(false);
    expect(unpublished.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(focused);
    expect(screen.getByTestId("notifications-popover")).toBeVisible();
    expect(store.retryNotificationRead).not.toHaveBeenCalled();
    expect(store.refreshNotifications).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(readRetry.element);
    fireEvent.click(loadRetry.element);
    fireEvent.click(actions.readAll.element);
    fireEvent.click(actions.rows[0]!.element);
    expect(store.retryNotificationRead).toHaveBeenCalledExactlyOnceWith(READ_FAILURE);
    expect(store.refreshNotifications).toHaveBeenCalledOnce();
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM);
    unpublishedControl.remove();
  });

  it("retires a replacement ref permanently and accepts only a later render", () => {
    const onOpen = vi.fn();
    const root = createBellRoot(state, { onOpen });
    openCurrentBell();
    const stale = captureActions().rows[0]!;
    const replacement = stale.element.cloneNode(true);
    if (!(replacement instanceof HTMLButtonElement)) throw new Error("Expected a replacement button");

    act(() => stale.ref(replacement));
    act(() => {
      invoke(stale, replacement);
      invoke(stale, stale.element);
    });
    expect(store.markNotificationRead).not.toHaveBeenCalled();

    fireEvent.click(stale.element);
    expect(store.markNotificationRead).not.toHaveBeenCalled();

    renderBellRoot(root, state, { onOpen });
    const current = captureActions().rows[0]!;
    expect(current.click).not.toBe(stale.click);
    fireEvent.click(current.element);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("keeps unrelated actions usable after rejected and claimed Retry and Mark all read callbacks", () => {
    createBellRoot(state, { onOpen: vi.fn() });
    openCurrentBell();
    const actions = captureActions();

    act(() => {
      invoke(actions.readRetry!, actions.rows[0]!.element);
    });
    fireEvent.click(actions.readRetry!.element);
    fireEvent.click(actions.readRetry!.element);
    fireEvent.click(actions.readAll.element);
    fireEvent.click(actions.readAll.element);
    fireEvent.click(actions.loadRetry!.element);

    expect(store.retryNotificationRead).toHaveBeenCalledOnce();
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(store.refreshNotifications).toHaveBeenCalledOnce();
    expect(screen.getByTestId("notifications-popover")).toBeVisible();

    fireEvent.click(actions.rows[1]!.element);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM_TWO.id);
  });

  it.each([
    "root detach and reinsert",
    "row reorder and restore",
    "attribute mutation and restore",
    "text mutation and restore",
  ] as const)("retires permanently after %s", (change) => {
    createBellRoot(
      { ...EMPTY, items: [ITEM, ITEM_TWO], unreadCount: 2, loaded: true },
      { onOpen: vi.fn() },
    );
    openCurrentBell();
    const actions = captureActions();
    const content = screen.getByTestId("notifications-popover");
    const root = content.firstElementChild;
    const list = root?.children.item(1);
    if (!(root instanceof HTMLDivElement) || !(list instanceof HTMLUListElement)) {
      throw new Error("Expected the exact notification portal topology");
    }

    if (change === "root detach and reinsert") {
      const parent = root.parentNode;
      const next = root.nextSibling;
      if (!parent) throw new Error("The notification root has no parent");
      root.remove();
      parent.insertBefore(root, next);
    } else if (change === "row reorder and restore") {
      const first = list.children.item(0);
      const second = list.children.item(1);
      if (!first || !second) throw new Error("Expected two notification rows");
      list.append(first);
      list.insertBefore(first, second);
    } else if (change === "attribute mutation and restore") {
      const row = actions.rows[0]!.element;
      row.dataset.documentId = "changed-document";
      row.dataset.documentId = ITEM.documentId;
    } else {
      const text = actions.rows[0]!.element.querySelector(".font-medium")?.firstChild;
      if (!(text instanceof Text)) throw new Error("Expected an actor text node");
      text.data = "Changed";
      text.data = ITEM.actorName!;
    }

    fireEvent.click(actions.rows[0]!.element);
    expect(store.markNotificationRead).not.toHaveBeenCalled();
  });
});

describe("publication succession", () => {
  const state = {
    ...EMPTY,
    items: [ITEM],
    unreadCount: 1,
    loaded: true,
    readError: READ_FAILURE,
  };

  it.each([
    ["stale before current", false],
    ["current before stale", true],
  ] as const)("keeps only B handlers live across an equal-looking same-element render, %s", (_label, currentFirst) => {
    const onOpen = vi.fn();
    const root = createBellRoot(state, { currentDocId: ITEM.documentId, onOpen });
    openCurrentBell();
    const stale = captureActions();
    let current!: ReturnType<typeof captureActions>;

    renderBellRoot(root, state, {
      currentDocId: ITEM.documentId,
      onOpen,
      boundary: 1,
      onBoundary: () => {
        current = captureActions();
        expect(current.rows[0]!.element).toBe(stale.rows[0]!.element);
        expect(current.readAll.element).toBe(stale.readAll.element);
      },
    });

    const inOrder = (a: CapturedControl, b: CapturedControl) => {
      dispatchWithHandlers(
        b,
        currentFirst ? [b.click, a.click, b.click] : [a.click, b.click, b.click],
      );
    };
    inOrder(stale.readRetry!, current.readRetry!);
    inOrder(stale.readAll, current.readAll);
    inOrder(stale.rows[0]!, current.rows[0]!);

    expect(store.retryNotificationRead).toHaveBeenCalledOnce();
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM);
  });

  it.each([
    ["A first", false],
    ["B first", true],
  ] as const)("enforces the A/B handler-control matrix across equal-looking remounts, %s", (_label, currentFirst) => {
    const onOpen = vi.fn();
    const root = createBellRoot(state, { onOpen });
    openCurrentBell();
    const stale = captureActions().readRetry!;

    renderBellRoot(root, state, { onOpen, present: false });
    renderBellRoot(root, state, { onOpen, present: true });
    openCurrentBell();
    const current = captureActions().readRetry!;

    act(() => {
      invoke(stale, stale.element);
      invoke(stale, current.element);
      invoke(current, stale.element);
    });
    dispatchWithHandlers(
      current,
      currentFirst
        ? [current.click, stale.click, current.click]
        : [stale.click, current.click, current.click],
    );

    expect(store.retryNotificationRead).toHaveBeenCalledExactlyOnceWith(READ_FAILURE);
    expect(screen.getByTestId("notifications-popover")).toBeVisible();
  });

  it("ignores late A control and portal cleanup after B owns reused elements", () => {
    const onOpen = vi.fn();
    const root = createBellRoot(state, { onOpen });
    openCurrentBell();
    const staleRow = captureActions().rows[0]!;
    const content = screen.getByTestId("notifications-popover");
    const portalRoot = content.firstElementChild;
    if (!(portalRoot instanceof HTMLDivElement)) throw new Error("Expected the portal root");
    const staleRootRef = reactRef<HTMLDivElement>(portalRoot);

    renderBellRoot(root, state, { onOpen });
    const currentRow = captureActions().rows[0]!;
    expect(currentRow.element).toBe(staleRow.element);

    act(() => {
      staleRow.ref(null);
      staleRootRef(null);
      invoke(staleRow, currentRow.element);
    });
    expect(store.markNotificationRead).not.toHaveBeenCalled();

    fireEvent.click(currentRow.element);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
  });

  it("rejects partial portal replay and replacement callbacks", () => {
    const onOpen = vi.fn();
    createBellRoot(state, { onOpen });
    openCurrentBell();
    const content = screen.getByTestId("notifications-popover");
    const portalRoot = content.firstElementChild;
    if (!(portalRoot instanceof HTMLDivElement)) throw new Error("Expected the portal root");
    const staleRootRef = reactRef<HTMLDivElement>(portalRoot);

    act(() => {
      staleRootRef(null);
      staleRootRef(portalRoot);
    });
    const attached = captureActions().rows[0]!;
    fireEvent.click(attached.element);
    expect(store.markNotificationRead).not.toHaveBeenCalled();

    const replacementContent = document.createElement("div");
    const replacementRoot = document.createElement("div");
    replacementContent.append(replacementRoot);
    document.body.append(replacementContent);
    const attachedRootRef = reactRef<HTMLDivElement>(
      screen.getByTestId("notifications-popover").firstElementChild as HTMLDivElement,
    );
    act(() => attachedRootRef(replacementRoot));
    fireEvent.click(captureActions().rows[0]!.element);
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    replacementContent.remove();
  });

  it("retires fact and DOM publication A before the parent layout boundary", () => {
    const onOpen = vi.fn();
    const root = createBellRoot(state, { currentDocId: "other", onOpen });
    openCurrentBell();
    const stale = captureActions().rows[0]!;
    let current!: CapturedControl;

    renderBellRoot(
      root,
      { ...state, items: [REPLACEMENT_ITEM], unreadCount: 0 },
      {
        currentDocId: "other",
        onOpen,
        boundary: 1,
        onBoundary: () => {
          current = captureActions().rows[0]!;
          invoke(stale, current.element);
          expect(store.markNotificationRead).not.toHaveBeenCalled();
          expect(screen.getByTestId("notification-item")).toHaveTextContent("Bob mentioned you");
        },
      },
    );

    fireEvent.click(current.element);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(REPLACEMENT_ITEM.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(REPLACEMENT_ITEM);
  });

  it("retires every disclosure action before readiness is false at the parent boundary", () => {
    const onOpen = vi.fn();
    const root = createBellRoot(state, { onOpen, ready: true });
    openCurrentBell();
    const stale = captureActions();
    const staleOpenChange = latestOpenChange();

    renderBellRoot(root, state, {
      onOpen,
      ready: false,
      boundary: 1,
      onBoundary: () => {
        expect(screen.queryByTestId("notifications-popover")).toBeNull();
        invoke(stale.readRetry!);
        invoke(stale.readAll);
        invoke(stale.rows[0]!);
        staleOpenChange(true);
      },
    });

    expect(store.useNotifications).toHaveBeenLastCalledWith(false);
    expect(store.retryNotificationRead).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
  });
});

describe("live fact revalidation and reentrancy", () => {
  it("retires on in-place notification and order drift before a later render can recover", () => {
    const first = { ...ITEM };
    const second = { ...ITEM_TWO };
    const items = [first, second];
    const state = { ...EMPTY, items, unreadCount: 2, loaded: true };
    const onOpen = vi.fn();
    const root = createBellRoot(state, { onOpen });
    openCurrentBell();
    const actions = captureActions();

    first.documentId = "mutated-document";
    items.reverse();
    act(() => invoke(actions.rows[0]!));
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();

    items.reverse();
    first.documentId = ITEM.documentId;
    act(() => invoke(actions.rows[0]!));
    expect(store.markNotificationRead).not.toHaveBeenCalled();

    renderBellRoot(root, state, { onOpen });
    fireEvent.click(captureActions().rows[0]!.element);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM);
  });

  it("retires on read-error and pending scalar drift without claiming the Retry", () => {
    const error = { ...READ_FAILURE };
    const state = {
      ...EMPTY,
      items: [ITEM],
      unreadCount: 1,
      loaded: true,
      readError: error,
    };
    const onOpen = vi.fn();
    const root = createBellRoot(state, { onOpen });
    openCurrentBell();
    const retry = captureActions().readRetry!;

    error.message = "Producer rewrote the failure";
    state.readErrorPending = true;
    act(() => invoke(retry));
    expect(store.retryNotificationRead).not.toHaveBeenCalled();

    error.message = READ_FAILURE.message;
    state.readErrorPending = false;
    act(() => invoke(retry));
    expect(store.retryNotificationRead).not.toHaveBeenCalled();

    renderBellRoot(root, state, { onOpen });
    fireEvent.click(captureActions().readRetry!.element);
    expect(store.retryNotificationRead).toHaveBeenCalledExactlyOnceWith(READ_FAILURE);
    expect(Object.isFrozen(store.retryNotificationRead.mock.calls[0]![0])).toBe(true);
  });

  it("retires on unread and pending drift before a later render can mark all read", () => {
    const state = { ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true };
    const onOpen = vi.fn();
    const root = createBellRoot(state, { onOpen });
    openCurrentBell();
    const readAll = captureActions().readAll;

    state.unreadCount = 0;
    state.readAllPending = true;
    act(() => invoke(readAll));
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();

    state.unreadCount = 1;
    state.readAllPending = false;
    act(() => invoke(readAll));
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();

    renderBellRoot(root, state, { onOpen });
    fireEvent.click(captureActions().readAll.element);
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
  });

  it("retires on loading and failure drift before a later render can retry", () => {
    const state = { ...EMPTY, loadError: true };
    const onOpen = vi.fn();
    const root = createBellRoot(state, { onOpen });
    openCurrentBell();
    const retry = captureActions().loadRetry!;

    state.loading = true;
    state.loadError = false;
    act(() => invoke(retry));
    expect(store.refreshNotifications).not.toHaveBeenCalled();

    state.loading = false;
    state.loadError = true;
    act(() => invoke(retry));
    expect(store.refreshNotifications).not.toHaveBeenCalled();

    renderBellRoot(root, state, { onOpen });
    fireEvent.click(captureActions().loadRetry!.element);
    expect(store.refreshNotifications).toHaveBeenCalledOnce();
  });

  it("claims a row before reentrant competing rows and actions, then preserves store-close-callback order", () => {
    const producerRow = { ...ITEM };
    const state = {
      ...EMPTY,
      items: [producerRow, { ...ITEM_TWO }],
      unreadCount: 2,
      loaded: true,
      readError: { ...READ_FAILURE },
    };
    const order: string[] = [];
    store.markNotificationRead.mockImplementation(() => {
      order.push("read");
      producerRow.documentTitle = "Mutated during the store call";
      return Promise.resolve();
    });
    const onOpen = vi.fn((notification: NotificationDto) => {
      order.push("open");
      expect(notification.documentTitle).toBe(ITEM.documentTitle);
      expect(Object.isFrozen(notification)).toBe(true);
      invoke(actions.rows[1]!);
      invoke(actions.readAll);
      invoke(actions.readRetry!);
    });
    createBellRoot(state, { onOpen });
    openCurrentBell();
    const actions = captureActions();

    fireEvent.click(actions.rows[0]!.element);

    expect(order).toEqual(["read", "open"]);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(store.retryNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("notifications-popover")).toBeNull();

    act(() => invoke(actions.rows[0]!));
    expect(store.markNotificationRead).toHaveBeenCalledOnce();
  });
});

describe("notification bell Strict Mode replay", () => {
  it.each([
    "trigger",
    "row",
    "read-all",
    "read-retry",
    "load-retry",
    "escape",
    "outside",
  ] as const)("keeps the %s interaction exact through direct-root replay", async (family) => {
    const state = {
      ...EMPTY,
      items: [ITEM],
      unreadCount: 1,
      loadError: true,
      readError: READ_FAILURE,
    };
    const onOpen = vi.fn();
    const replay = { trigger: null as CapturedControl | null };
    createStrictBellRoot(state, { onOpen }, () => {
      replay.trigger ??= captureControl(screen.getByTestId("notifications-bell"));
    });
    const replayTrigger = replay.trigger;
    if (!replayTrigger) throw new Error("Strict Mode did not expose its first layout");
    const currentTrigger = captureControl(screen.getByTestId("notifications-bell"));

    expect(currentTrigger.click).not.toBe(replayTrigger.click);
    dispatchWithHandlers(currentTrigger, [
      replayTrigger.click,
      currentTrigger.click,
      currentTrigger.click,
    ]);
    expect(screen.getByTestId("notifications-popover")).toBeVisible();

    const actions = captureActions();
    if (family === "trigger") {
      const openTrigger = captureControl(screen.getByTestId("notifications-bell"));
      fireEvent.click(openTrigger.element);
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
    } else if (family === "row") {
      dispatchWithHandlers(actions.rows[0]!, [
        actions.rows[0]!.click,
        actions.rows[0]!.click,
      ]);
      expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
      expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM);
    } else if (family === "read-all") {
      dispatchWithHandlers(actions.readAll, [
        actions.readAll.click,
        actions.readAll.click,
      ]);
      expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    } else if (family === "read-retry") {
      dispatchWithHandlers(actions.readRetry!, [
        actions.readRetry!.click,
        actions.readRetry!.click,
      ]);
      expect(store.retryNotificationRead).toHaveBeenCalledExactlyOnceWith(
        READ_FAILURE,
      );
    } else if (family === "load-retry") {
      dispatchWithHandlers(actions.loadRetry!, [
        actions.loadRetry!.click,
        actions.loadRetry!.click,
      ]);
      expect(store.refreshNotifications).toHaveBeenCalledOnce();
    } else if (family === "escape") {
      const staleContent = capturedContentCallbacks.at(0);
      const staleOpenChange = capturedPopoverOpenChanges.at(0);
      act(() => {
        staleContent?.escape?.(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        staleOpenChange?.(false);
      });
      expect(screen.getByTestId("notifications-popover")).toBeVisible();
      fireEvent.keyDown(actions.rows[0]!.element, { key: "Escape" });
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
    } else {
      const staleContent = capturedContentCallbacks.at(0);
      const staleOpenChange = capturedPopoverOpenChanges.at(0);
      const outside = document.createElement("button");
      document.body.append(outside);
      act(() => {
        if (staleContent) invokeOutside(staleContent.outside, outsideEvent(outside));
        staleOpenChange?.(false);
      });
      expect(screen.getByTestId("notifications-popover")).toBeVisible();
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      fireEvent.pointerDown(outside);
      await act(() => Promise.resolve());
      fireEvent.click(outside);
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
      outside.remove();
    }
  });
});
