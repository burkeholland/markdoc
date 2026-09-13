// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  StrictMode,
  useLayoutEffect,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { compile } from "tailwindcss";
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
type KeyboardHandler = (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
type KeyboardListHandler = (event: ReactKeyboardEvent<HTMLUListElement>) => void;
type CancellationQuery =
  | "isDefaultPrevented"
  | "isPropagationStopped";
type ElementRef<T extends HTMLElement> = (element: T | null) => void;

interface CapturedControl {
  element: HTMLButtonElement;
  click: MouseHandler;
  keyDown: KeyboardHandler | null;
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
const ITEM_THREE: NotificationDto = {
  ...ITEM,
  id: "notification-three",
  kind: "resolve",
  documentId: "document-three",
  documentTitle: "Third launch plan",
  actorLogin: "carol",
  actorName: "Carol",
  refId: "thread-three",
  snippet: "A third notification",
  createdAt: "2026-09-07T14:00:00.000Z",
};
const PAGE_ITEMS: NotificationDto[] = Array.from({ length: 14 }, (_, index) => ({
  ...ITEM,
  id: `notification-page-${index + 1}`,
  documentId: `document-page-${index + 1}`,
  documentTitle: `Page document ${index + 1}`,
  actorLogin: `page-actor-${index + 1}`,
  actorName: `Page actor ${index + 1}`,
  refId: `page-thread-${index + 1}`,
  snippet: `Page notification ${index + 1}`,
  createdAt: `2026-09-08T${String(index).padStart(2, "0")}:00:00.000Z`,
}));
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
    keyDown:
      reactProperty<KeyboardHandler>(element, "onKeyDown") ?? null,
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

function dispatchKeyWithHandlers(
  control: CapturedControl,
  handlers: readonly KeyboardHandler[],
  init: KeyboardEventInit,
) {
  const propsKey = Object.keys(control.element).find((key) =>
    key.startsWith("__reactProps$"),
  );
  if (!propsKey) throw new Error("React props were not attached to the control");
  const props = (
    control.element as unknown as Record<string, Record<string, unknown>>
  )[propsKey];
  if (!props) throw new Error("React props were not attached to the control");
  const properties = control.element as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const wrapped = {
    ...props,
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      for (const handler of handlers) handler(event);
    },
  };
  properties[propsKey] = wrapped;
  try {
    const view = control.element.ownerDocument.defaultView;
    if (!view) throw new Error("The keyboard target has no owner window");
    const event = new view.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    markJsdomEventTrusted(event);
    fireEvent(control.element, event);
    return event;
  } finally {
    if (properties[propsKey] === wrapped) properties[propsKey] = props;
  }
}

function dispatchKeyWithMicrotaskCheckpoints(
  control: CapturedControl,
  checkpoints: number,
  init: KeyboardEventInit,
) {
  const pending: VoidFunction[] = [];
  const queue = vi
    .spyOn(globalThis, "queueMicrotask")
    .mockImplementation((callback) => pending.push(callback));
  const checkpoint = (event: Event) => {
    if (event.target !== control.element) return;
    const nest = (remaining: number) => {
      if (remaining <= 0) return;
      queueMicrotask(() => nest(remaining - 1));
    };
    nest(checkpoints);
    while (pending.length) pending.shift()!();
  };
  control.element.addEventListener("keydown", checkpoint, true);
  try {
    const view = control.element.ownerDocument.defaultView;
    if (!view) throw new Error("The keyboard target has no owner window");
    const event = new view.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    markJsdomEventTrusted(event);
    fireEvent(control.element, event);
    return event;
  } finally {
    control.element.removeEventListener("keydown", checkpoint, true);
    queue.mockRestore();
    act(() => {
      while (pending.length) pending.shift()!();
    });
  }
}

function exposeKeyboardScalarsThroughGetters(
  event: ReactKeyboardEvent<HTMLButtonElement>,
) {
  for (const field of [
    "type",
    "eventPhase",
    "bubbles",
    "cancelable",
    "defaultPrevented",
    "isTrusted",
    "timeStamp",
    "detail",
    "view",
    "key",
    "code",
    "location",
    "repeat",
    "ctrlKey",
    "shiftKey",
    "altKey",
    "metaKey",
  ] as const) {
    const value = event[field];
    Object.defineProperty(event, field, {
      configurable: true,
      enumerable: true,
      get: () => value,
    });
  }
}

function alterSyntheticPersist(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  variant: "absent" | "replaced" | "non-function",
) {
  if (variant === "absent") {
    Object.setPrototypeOf(event, Object.create(null));
    return;
  }
  Object.defineProperty(event, "persist", {
    configurable: true,
    value: variant === "replaced" ? () => undefined : "not a function",
  });
}

function replaceCancellationQuery(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  method: CancellationQuery,
  invokeAt: number,
  mutate: () => void,
) {
  let calls = 0;
  Object.defineProperty(event, method, {
    configurable: true,
    value: () => {
      calls += 1;
      if (calls === invokeAt) mutate();
      return false;
    },
  });
}

function markJsdomEventTrusted(event: Event) {
  // jsdom has no hardware input; set its internal slot so accepted-path tests model browser input.
  const implementation = Object.getOwnPropertySymbols(event)
    .map(
      (symbol) => (event as unknown as Record<symbol, unknown>)[symbol],
    )
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
  if (!event.isTrusted) throw new Error("The jsdom event trust slot did not update");
}

function cloneSyntheticClick(
  event: CapturedMouseEvent,
  syntheticConstructor: new () => object,
) {
  const prototype = Object.create(Object.getPrototypeOf(event), {
    constructor: { value: syntheticConstructor },
  });
  return Object.assign(
    Object.create(prototype) as CapturedMouseEvent,
    event,
  );
}

function cloneSyntheticKey(
  event: ReactKeyboardEvent<HTMLButtonElement>,
): ReactKeyboardEvent<HTMLButtonElement> {
  return Object.assign(
    Object.create(Object.getPrototypeOf(event)) as ReactKeyboardEvent<HTMLButtonElement>,
    event,
  );
}

function dispatchWithListenerMicrotaskCheckpoint(
  type: "click" | "focusin",
  target: EventTarget,
  dispatch: () => void,
) {
  const pending: VoidFunction[] = [];
  const queue = vi
    .spyOn(globalThis, "queueMicrotask")
    .mockImplementation((callback) => pending.push(callback));
  const checkpoint = (event: Event) => {
    if (event.target !== target) return;
    while (pending.length) pending.shift()!();
  };
  document.addEventListener(type, checkpoint, true);
  try {
    dispatch();
  } finally {
    document.removeEventListener(type, checkpoint, true);
    queue.mockRestore();
    act(() => {
      while (pending.length) pending.shift()!();
    });
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

function renderStrictBellRoot(
  root: Root,
  state: BellState,
  props: NotificationsBellProps & {
    present?: boolean;
    boundary?: number;
    onBoundary?: () => void;
  },
) {
  store.useNotifications.mockReturnValue(state);
  act(() =>
    root.render(
      <StrictMode>
        <BellBoundary {...props} />
      </StrictMode>,
    ),
  );
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
  vi.restoreAllMocks();
});

describe("notification snippet titles", () => {
  const mentionSnippet =
    '  Please review <strong title="launch">the launch plan</strong> with "quoted feedback" & literal markup. The preview includes the complete rollout notes, the remaining owner decisions, and the follow-up questions that must stay readable even when the notification row is clipped.  ';
  const commentSnippet =
    'A comment says <a href="https://example.invalid">"do not turn this into a link"</a> and <img src="preview" alt="literal text">. Keep every character of this longer discussion, including the final request to compare the revised schedule with the original milestones before responding.';
  const snippetClasses = "mt-0.5 block truncate text-xs text-ink-3";

  it.each([
    ["unread mention", ITEM, mentionSnippet, null],
    ["read mention", ITEM, mentionSnippet, REPLACEMENT_ITEM.readAt],
    ["unread comment", ITEM_TWO, commentSnippet, null],
    ["read comment", ITEM_TWO, commentSnippet, REPLACEMENT_ITEM.readAt],
  ] as const)(
    "keeps the full %s title passive and activates the existing row once",
    async (_label, item, snippet, readAt) => {
      const notification = { ...item, snippet, readAt };
      const order: string[] = [];
      const onOpen = vi.fn(() => order.push("open"));
      store.markNotificationRead.mockImplementation(() => {
        order.push("read");
        return Promise.resolve();
      });
      openBell({
        ...EMPTY,
        items: [notification],
        unreadCount: readAt ? 0 : 1,
        loaded: true,
      }, onOpen);
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

      const row = screen.getByTestId("notification-item");
      const preview = row.querySelector("span.truncate");
      if (!(preview instanceof HTMLSpanElement)) throw new Error("Expected the existing snippet span");
      expect(snippet.length).toBeGreaterThanOrEqual(200);
      expect(row.querySelectorAll("span.truncate")).toHaveLength(1);
      expect(row.querySelectorAll("span[title]")).toHaveLength(1);
      expect(preview.title).toBe(snippet);
      expect(preview.textContent).toBe(snippet);
      expect(preview.className).toBe(snippetClasses);
      expect(preview.getAttributeNames().sort()).toEqual(["class", "title"]);
      expect(preview.childNodes).toHaveLength(1);
      expect(preview.firstChild).toBeInstanceOf(Text);
      expect(preview.children).toHaveLength(0);
      expect(preview.tabIndex).toBe(-1);
      expect(row.querySelectorAll("a, button, input, select, textarea, [tabindex], [contenteditable]")).toHaveLength(0);
      expect([...preview.parentElement!.children].map((child) => child.tagName)).toEqual(["SPAN", "SPAN", "TIME"]);
      expect(screen.getAllByRole("button")).toHaveLength(3);
      expect(row).toHaveAttribute("data-kind", notification.kind);
      expect(row).toHaveAttribute("data-unread", String(!readAt));
      expect(screen.queryAllByTestId("notification-unread-dot")).toHaveLength(readAt ? 0 : 1);
      expect(row.querySelector(".font-medium")?.textContent).toBe(notification.actorName);
      expect(row).toHaveTextContent(notification.documentTitle);
      expect(row.querySelector("time")).toHaveAttribute("datetime", notification.createdAt);

      const content = screen.getByTestId("notifications-popover");
      const focused = document.activeElement;
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const request = vi.spyOn(globalThis, "fetch");
      const xhr = vi.spyOn(XMLHttpRequest.prototype, "send");
      const mutation = vi.fn();
      const observer = new MutationObserver(mutation);
      observer.observe(content, { attributes: true, childList: true, characterData: true, subtree: true });
      const timeout = vi.spyOn(globalThis, "setTimeout");
      const interval = vi.spyOn(globalThis, "setInterval");
      try {
        fireEvent.pointerOver(preview, { pointerType: "mouse" });
        fireEvent.mouseOver(preview);
        fireEvent.pointerMove(preview, { pointerType: "mouse" });
        fireEvent.mouseMove(preview);
        fireEvent.pointerOut(preview, { pointerType: "mouse" });
        fireEvent.mouseOut(preview);
        expect(timeout).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
        expect(observer.takeRecords()).toEqual([]);
        await act(() => Promise.resolve());
        expect(mutation).not.toHaveBeenCalled();
      } finally {
        observer.disconnect();
        timeout.mockRestore();
        interval.mockRestore();
      }
      expect(focus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(focused);
      expect(request).not.toHaveBeenCalled();
      expect(xhr).not.toHaveBeenCalled();
      expect(store.refreshNotifications).not.toHaveBeenCalled();
      expect(store.markNotificationRead).not.toHaveBeenCalled();
      expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
      expect(store.retryNotificationRead).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
      expect(content).toBeVisible();

      fireEvent.click(preview);
      await act(() => Promise.resolve());

      expect(order).toEqual(["read", "open"]);
      expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(notification.id);
      expect(onOpen).toHaveBeenCalledExactlyOnceWith(notification);
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
    },
  );

  it.each([
    ["mention", null],
    ["mention", ""],
    ["reply", null],
    ["reply", ""],
    ["share", null],
    ["share", ""],
    ["share", mentionSnippet],
  ] as const)("omits snippet spans and titles for %s with %j", (kind, snippet) => {
    // Exercise nullable runtime data at the mocked store boundary, not the string-only DTO.
    store.useNotifications.mockReturnValue({
      ...EMPTY,
      items: [{ ...ITEM, kind, snippet }],
      unreadCount: 1,
      loaded: true,
    });
    render(<BellBoundary onOpen={vi.fn()} />);
    openCurrentBell();

    const row = screen.getByTestId("notification-item");
    expect(row.querySelectorAll("span.truncate")).toHaveLength(0);
    expect(row.querySelectorAll("span[title]")).toHaveLength(0);
    expect(row).not.toHaveTextContent(mentionSnippet.trim());
  });

  it("preserves a truthy whitespace-only snippet without normalization", () => {
    const snippet = " \t ";
    openBell({ ...EMPTY, items: [{ ...ITEM, snippet }], unreadCount: 1, loaded: true });

    const preview = screen.getByTestId("notification-item").querySelector("span.truncate");
    expect(preview).toHaveAttribute("title", snippet);
    expect(preview?.textContent).toBe(snippet);
  });

  it("replaces the title for the same notification ID and removes it with the list", () => {
    const onOpen = vi.fn();
    const state = { ...EMPTY, items: [{ ...ITEM, snippet: mentionSnippet }], unreadCount: 1, loaded: true };
    const root = createBellRoot(state, { onOpen });
    openCurrentBell();
    const preview = screen.getByTitle(mentionSnippet, { normalizer: (value) => value });
    const replacement = { ...REPLACEMENT_ITEM, snippet: commentSnippet };

    renderBellRoot(root, { ...state, items: [replacement], unreadCount: 0 }, { onOpen });

    expect(screen.queryByTitle(mentionSnippet, { normalizer: (value) => value })).toBeNull();
    expect(screen.queryByText(mentionSnippet.trim())).toBeNull();
    expect(screen.getByTitle(commentSnippet)).toBe(preview);
    expect(preview.textContent).toBe(commentSnippet);
    expect(screen.getByTestId("notification-item")).toHaveAttribute("data-notification-id", ITEM.id);

    renderBellRoot(root, { ...state, items: [], unreadCount: 0 }, { onOpen });

    expect(screen.queryAllByTestId("notification-item")).toHaveLength(0);
    expect(screen.queryByTitle(commentSnippet)).toBeNull();
    expect(screen.queryByText(commentSnippet)).toBeNull();
    expect(screen.getByText("You're all caught up.")).toBeVisible();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shows only the current title after a document context switch and opens the current row", async () => {
    const onOpen = vi.fn();
    const state = { ...EMPTY, items: [{ ...ITEM, snippet: mentionSnippet }], unreadCount: 1, loaded: true };
    const root = createBellRoot(state, { currentDocId: ITEM.documentId, onOpen });
    openCurrentBell();
    expect(screen.getByTitle(mentionSnippet, { normalizer: (value) => value })).toHaveTextContent(mentionSnippet.trim());
    const replacement = { ...REPLACEMENT_ITEM, snippet: commentSnippet };

    renderBellRoot(root, { ...state, items: [replacement], unreadCount: 0 }, {
      currentDocId: replacement.documentId,
      onOpen,
    });

    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    expect(screen.queryByTitle(mentionSnippet, { normalizer: (value) => value })).toBeNull();
    openCurrentBell();
    expect(screen.queryByTitle(mentionSnippet, { normalizer: (value) => value })).toBeNull();
    expect(screen.queryByText(mentionSnippet.trim())).toBeNull();
    expect(screen.getByTitle(commentSnippet).textContent).toBe(commentSnippet);
    expect(screen.getByTestId("notification-item")).not.toHaveTextContent(replacement.documentTitle);
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle(commentSnippet));
    await act(() => Promise.resolve());

    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(replacement.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(replacement);
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
  });
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

describe("notification read-error wrapping", () => {
  const unbrokenMessage = "NotificationReadFailure".repeat(16);
  const ordinaryMessage = "The notification could not be marked as read because the request was interrupted. Please retry without leaving the current document. ".repeat(3);
  const literalMessage = ' \tCould not read <strong>this notification</strong>\n<img src="invalid" alt="literal"> & "retry"  '.repeat(3);
  const alertClass = "flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40";
  const state = {
    ...EMPTY,
    items: [ITEM, ITEM_TWO],
    unreadCount: 2,
    loaded: true,
  };

  function expectReadError(message: string, pending = false) {
    const alert = screen.getByRole("alert");
    const span = alert.firstElementChild;
    const retry = screen.getByTestId("notifications-read-retry");
    if (!(span instanceof HTMLSpanElement)) throw new Error("Expected the existing read-error span");

    expect(alert.tagName).toBe("DIV");
    expect(Object.fromEntries([...alert.attributes].map(({ name, value }) => [name, value]))).toEqual({
      class: alertClass,
      role: "alert",
      "aria-atomic": "true",
    });
    expect([...alert.childNodes]).toEqual([span, retry]);
    expect(span.textContent).toBe(message);
    expect(span.childNodes).toHaveLength(1);
    expect(span.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(span.children).toHaveLength(0);
    expect(Object.fromEntries([...span.attributes].map(({ name, value }) => [name, value]))).toEqual({
      class: "min-w-0 wrap-anywhere",
    });
    expect(retry.tagName).toBe("BUTTON");
    expect(retry.textContent).toBe(pending ? "Retrying…" : "Retry");
    expect(retry.children).toHaveLength(0);
    expect(Object.fromEntries([...retry.attributes].map(({ name, value }) => [name, value]))).toEqual({
      type: "button",
      class: "btn btn-outline h-7 shrink-0 px-2 text-xs",
      "data-testid": "notifications-read-retry",
      ...(pending ? { disabled: "" } : {}),
    });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getAllByTestId("notifications-read-retry")).toEqual([retry]);
    expect(screen.queryByTestId("notifications-load-retry")).toBeNull();
    expect(alert.parentElement?.tagName).toBe("LI");
    expect(alert.parentElement).toHaveAttribute("class", "px-3 py-2");
    const list = screen.getByRole("list", { name: "Notifications" });
    expect(list.firstElementChild).toBe(alert.parentElement);
    expect(list.children).toHaveLength(3);
    expect(list.className).toBe("scrollbar-thin max-h-[420px] overflow-y-auto py-1");
    expect(screen.getByTestId("notifications-popover")).toHaveClass("w-[min(380px,calc(100vw-16px))]", "p-0");
    return { span, retry };
  }

  function surroundingMarkup() {
    const root = screen.getByTestId("notifications-popover").firstElementChild;
    const badge = screen.getByTestId("notifications-badge");
    const bell = screen.getByTestId("notifications-bell");
    expect(bell).toHaveAttribute("data-unread", "2");
    expect(bell).toHaveAttribute("aria-label", "Notifications, 2 unread");
    expect(badge.textContent).toBe("2");
    expect(screen.getByTestId("notifications-unread-count").textContent).toBe("2 unread");
    const rows = screen.getAllByTestId("notification-item");
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toHaveTextContent(ITEM.documentTitle);
    expect(rows[1]).toHaveTextContent(ITEM_TWO.documentTitle);
    expect(rows[0]?.querySelector("span[title]")).toHaveAttribute("title", ITEM.snippet);
    expect(rows[1]?.querySelector("span[title]")).toHaveAttribute("title", ITEM_TWO.snippet);
    return [
      root?.firstElementChild?.outerHTML,
      ...rows.map((row) => row.outerHTML),
      root?.lastElementChild?.outerHTML,
      badge.outerHTML,
    ];
  }

  it.each([
    ["unbroken", unbrokenMessage],
    ["ordinary", ordinaryMessage],
    ["literal HTML and whitespace", literalMessage],
  ])("keeps the exact %s read reason beside one unchanged Retry", (_label, message) => {
    expect(message.length).toBeGreaterThanOrEqual(240);
    expect(unbrokenMessage).not.toMatch(/\s/);
    const error = { ...READ_FAILURE, message };
    const onOpen = vi.fn();
    createBellRoot({ ...state, readError: error }, { currentDocId: ITEM.documentId, onOpen });
    openCurrentBell();

    expectReadError(message);
    const before = surroundingMarkup();
    expect(store.retryNotificationRead).not.toHaveBeenCalled();
    const retry = captureActions().readRetry!;
    dispatchWithHandlers(retry, [retry.click, retry.click]);
    fireEvent.click(retry.element);

    expect(store.retryNotificationRead).toHaveBeenCalledExactlyOnceWith(error);
    expect(surroundingMarkup()).toEqual(before);
    expect(store.refreshNotifications).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each([
    ["state replacement", false, false],
    ["state replacement, current first", false, true],
    ["closed/reopened visit", true, false],
    ["closed/reopened visit, current first", true, true],
  ] as const)("keeps only the current read Retry through %s, pending and recovery", (_label, reopen, currentFirst) => {
    const onOpen = vi.fn();
    const props = { currentDocId: ITEM.documentId, onOpen };
    const root = createBellRoot({
      ...state,
      readError: { ...READ_FAILURE, message: unbrokenMessage },
    }, props);
    openCurrentBell();
    const original = expectReadError(unbrokenMessage);
    const before = surroundingMarkup();
    const stale = captureActions().readRetry!;
    const replacement = { ...READ_FAILURE, id: 8, operationId: 8, message: literalMessage };

    if (reopen) {
      fireEvent.click(screen.getByTestId("notifications-bell"));
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(original.span.isConnected).toBe(false);
    }
    renderBellRoot(root, { ...state, readError: replacement }, props);
    if (reopen) openCurrentBell();

    const updated = expectReadError(literalMessage);
    expect(updated.span === original.span).toBe(!reopen);
    expect(screen.queryByText(unbrokenMessage)).toBeNull();
    expect(surroundingMarkup()).toEqual(before);
    const current = captureActions().readRetry!;
    dispatchWithHandlers(current, [stale.click, stale.click]);
    expect(store.retryNotificationRead).not.toHaveBeenCalled();
    dispatchWithHandlers(
      current,
      currentFirst
        ? [current.click, stale.click, current.click]
        : [stale.click, current.click, current.click],
    );
    fireEvent.click(current.element);
    expect(store.retryNotificationRead).toHaveBeenCalledExactlyOnceWith(replacement);

    renderBellRoot(root, { ...state, readError: replacement, readErrorPending: true }, props);
    const pending = expectReadError(literalMessage, true);
    expect(pending.span).toBe(updated.span);
    expect(pending.retry).toBeDisabled();
    const pendingControl = captureActions().readRetry!;
    dispatchWithHandlers(pendingControl, [stale.click, current.click, pendingControl.click, pendingControl.click]);
    fireEvent.click(pending.retry);
    expect(store.retryNotificationRead).toHaveBeenCalledExactlyOnceWith(replacement);
    expect(surroundingMarkup()).toEqual(before);

    renderBellRoot(root, state, props);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("notifications-read-retry")).toBeNull();
    expect(screen.queryByText(literalMessage, { normalizer: (value) => value })).toBeNull();
    expect(pending.span.isConnected).toBe(false);
    expect(pending.retry.isConnected).toBe(false);
    expect(screen.getByRole("list", { name: "Notifications" }).children).toHaveLength(2);
    expect(surroundingMarkup()).toEqual(before);
    expect(store.retryNotificationRead).toHaveBeenCalledExactlyOnceWith(replacement);
    expect(store.refreshNotifications).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("notifications-read-all"));
    fireEvent.click(screen.getByTestId("notifications-read-all"));
    expect(store.markAllNotificationsRead).toHaveBeenCalledOnce();
    fireEvent.click(screen.getAllByTestId("notification-item")[0]!);
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM);
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
  });

  it("still retires the Retry after read-error class mutation and restoration", () => {
    createBellRoot({
      ...state,
      readError: { ...READ_FAILURE, message: unbrokenMessage },
    }, { currentDocId: ITEM.documentId, onOpen: vi.fn() });
    openCurrentBell();
    const { span } = expectReadError(unbrokenMessage);
    const retry = captureActions().readRetry!;
    span.className = "min-w-0 wrap-anywhere extra";
    span.className = "min-w-0 wrap-anywhere";
    fireEvent.click(retry.element);
    expect(store.retryNotificationRead).not.toHaveBeenCalled();
  });

  it("compiles read-error wrapping and Retry shrinking with the installed Tailwind theme", async () => {
    const theme = readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8");
    const { build } = await compile(`${theme}\n@tailwind utilities;`);
    const css = build(["min-w-0", "wrap-anywhere", "shrink-0"]);
    expect(css).toMatch(/\.min-w-0\s*\{\s*min-width:\s*0px;\s*\}/);
    expect(css).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
    expect(css).toMatch(/\.shrink-0\s*\{\s*flex-shrink:\s*0;\s*\}/);
    expect(css).not.toMatch(/word-break:\s*break-all|overflow:\s*(auto|scroll|hidden)|text-overflow:\s*ellipsis/);
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

    const alert = screen.getByRole("alert");
    const span = alert.firstElementChild;
    expect(span?.tagName).toBe("SPAN");
    expect(span?.textContent).toBe("Couldn't load notifications.");
    expect(span?.getAttributeNames()).toEqual([]);
    expect(span?.children).toHaveLength(0);
    expect([...alert.childNodes]).toEqual([span, retry]);
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert.className).toBe("flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40");
    expect(screen.getAllByTestId("notifications-load-retry")).toEqual([retry]);
    expect(screen.queryByTestId("notifications-read-retry")).toBeNull();
    expect(retry).toHaveAttribute("type", "button");
    expect(retry.className).toBe("btn btn-outline h-7 shrink-0 px-2 text-xs");
    expect(retry.textContent).toBe("Retry");
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(store.refreshNotifications).toHaveBeenCalledOnce();

    store.useNotifications.mockReturnValue({ ...EMPTY, loading: true, loadError: true });
    view.rerender(
      <TooltipProvider>
        <NotificationsBell onOpen={onOpen} />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
    expect(span?.textContent).toBe("Couldn't load notifications.");
    expect(span?.getAttributeNames()).toEqual([]);
    fireEvent.click(screen.getByTestId("notifications-load-retry"));
    expect(store.refreshNotifications).toHaveBeenCalledOnce();

    store.useNotifications.mockReturnValue({ ...EMPTY, loaded: true });
    view.rerender(
      <TooltipProvider>
        <NotificationsBell onOpen={onOpen} />
      </TooltipProvider>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("notifications-load-retry")).toBeNull();
    expect(screen.getByText("You're all caught up.")).toBeVisible();
    expect(store.refreshNotifications).toHaveBeenCalledOnce();
    expect(store.retryNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
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

  it.each(["click", "focus"] as const)(
    "keeps genuine owner-document %s provenance through a listener microtask checkpoint",
    async (kind) => {
      const outside = document.createElement("button");
      document.body.append(outside);
      createBellRoot(state, { onOpen: vi.fn() });
      openCurrentBell();
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

      if (kind === "click") {
        fireEvent.pointerDown(outside);
        await act(() => Promise.resolve());
        dispatchWithListenerMicrotaskCheckpoint("click", outside, () => {
          fireEvent.click(outside);
        });
      } else {
        dispatchWithListenerMicrotaskCheckpoint("focusin", outside, () => {
          act(() => outside.focus());
        });
      }

      expect(screen.queryByTestId("notifications-popover")).toBeNull();
      outside.remove();
    },
  );

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

describe("notification row keyboard browsing", () => {
  const state = {
    ...EMPTY,
    items: [ITEM, ITEM_TWO, ITEM_THREE],
    unreadCount: 3,
    loaded: true,
  };

  function openStrictKeyboardBell(
    currentState: BellState = state,
    onOpen = vi.fn(),
  ) {
    const root = createStrictBellRoot(
      currentState,
      { onOpen },
      () => undefined,
    );
    openCurrentBell();
    return { root, onOpen, actions: captureActions() };
  }

  function nativeKey(
    element: HTMLElement,
    key: string,
    init: KeyboardEventInit = {},
  ) {
    const view = element.ownerDocument.defaultView;
    if (!view) throw new Error("The keyboard target has no owner window");
    const event = new view.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    markJsdomEventTrusted(event);
    fireEvent(element, event);
    return event;
  }

  function expectNoKeyboardActions(onOpen: ReturnType<typeof vi.fn>) {
    expect(store.retryNotificationRead).not.toHaveBeenCalled();
    expect(store.refreshNotifications).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId("notifications-popover")).toBeVisible();
  }

  function pageScrollSnapshot(list: HTMLElement) {
    return {
      listTop: list.scrollTop,
      listLeft: list.scrollLeft,
      documentTop: document.documentElement.scrollTop,
      documentLeft: document.documentElement.scrollLeft,
      bodyTop: document.body.scrollTop,
      bodyLeft: document.body.scrollLeft,
      windowX: window.scrollX,
      windowY: window.scrollY,
      pageX: window.pageXOffset,
      pageY: window.pageYOffset,
    };
  }

  function seedPageScroll(list: HTMLElement) {
    list.scrollTop = 41;
    list.scrollLeft = 9;
    document.documentElement.scrollTop = 23;
    document.documentElement.scrollLeft = 7;
    document.body.scrollTop = 17;
    document.body.scrollLeft = 5;
  }

  it.each([
    ["forward ten", "PageDown", 1, 11],
    ["backward ten", "PageUp", 12, 2],
    ["forward clamp", "PageDown", 5, 13],
    ["backward clamp", "PageUp", 7, 0],
  ] as const)(
    "moves one exact Page destination for %s without scrolling, actions, or tab-order changes",
    (_label, key, sourceIndex, destinationIndex) => {
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const pageState = {
        ...EMPTY,
        items: PAGE_ITEMS,
        unreadCount: PAGE_ITEMS.length,
        loaded: true,
      };
      const { onOpen, actions } = openStrictKeyboardBell(pageState);
      const list = screen.getByRole("list", { name: "Notifications" });
      const source = actions.rows[sourceIndex]!.element;
      const destination = actions.rows[destinationIndex]!.element;
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      seedPageScroll(list);
      const scroll = pageScrollSnapshot(list);

      const event = nativeKey(source, key);

      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(
        preventDefault.mock.contexts.filter((context) => context === event),
      ).toHaveLength(1);
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(focus.mock.contexts[0]).toBe(destination);
      expect(pageScrollSnapshot(list)).toEqual(scroll);
      expect(actions.rows.map(({ element }) => element.tabIndex)).toEqual(
        PAGE_ITEMS.map(() => 0),
      );
      expect(actions.readAll.element.tabIndex).toBe(0);
      expectNoKeyboardActions(onOpen);
    },
  );

  it.each([
    ["PageUp", 0],
    ["PageDown", PAGE_ITEMS.length - 1],
  ] as const)(
    "leaves the exact %s boundary unprevented and inert",
    (key, sourceIndex) => {
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const pageState = {
        ...EMPTY,
        items: PAGE_ITEMS,
        unreadCount: PAGE_ITEMS.length,
        loaded: true,
      };
      const { onOpen, actions } = openStrictKeyboardBell(pageState);
      const list = screen.getByRole("list", { name: "Notifications" });
      const source = actions.rows[sourceIndex]!.element;
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      seedPageScroll(list);
      const scroll = pageScrollSnapshot(list);

      const event = nativeKey(source, key);

      expect(event.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(
        preventDefault.mock.contexts.filter((context) => context === event),
      ).toHaveLength(0);
      expect(focus).not.toHaveBeenCalled();
      expect(pageScrollSnapshot(list)).toEqual(scroll);
      expect(actions.rows.map(({ element }) => element.tabIndex)).toEqual(
        PAGE_ITEMS.map(() => 0),
      );
      expect(actions.readAll.element.tabIndex).toBe(0);
      expectNoKeyboardActions(onOpen);
    },
  );

  it("recognizes the exact unforgeable KeyboardEvent trust descriptor from independent probes", () => {
    const firstProbe = new window.KeyboardEvent("keydown");
    const secondProbe = new window.KeyboardEvent("keydown");
    const plainEvent = new window.Event("plain-event-probe");
    const first = Object.getOwnPropertyDescriptor(firstProbe, "isTrusted");
    const second = Object.getOwnPropertyDescriptor(secondProbe, "isTrusted");
    const plain = Object.getOwnPropertyDescriptor(plainEvent, "isTrusted");

    expect(first).toMatchObject({
      configurable: false,
      enumerable: true,
      get: expect.any(Function),
      set: undefined,
    });
    expect(second).toMatchObject(first!);
    if (plain?.get !== first?.get) expect(plain?.get).not.toBe(first?.get);
    expect(
      Object.getOwnPropertyDescriptor(window.Event.prototype, "isTrusted"),
    ).toBeUndefined();
  });

  it("constructs a fresh probe for each authority and never carries stale probe trust forward", async () => {
    const NativeKeyboardEvent = window.KeyboardEvent;
    const constructorDescriptor = Object.getOwnPropertyDescriptor(
      NativeKeyboardEvent.prototype,
      "constructor",
    );
    if (!constructorDescriptor || !("value" in constructorDescriptor)) {
      throw new Error("KeyboardEvent prototype constructor is unavailable");
    }
    const probes: KeyboardEvent[] = [];
    let rejectProbeConstruction = false;
    const ObservedKeyboardEvent = new Proxy(NativeKeyboardEvent, {
      construct(target, args, newTarget) {
        const isAuthorityProbe =
          args[0] === "notification-keyboard-intrinsic";
        if (isAuthorityProbe && rejectProbeConstruction) {
          throw new Error("Authority probe construction rejected");
        }
        const event = Reflect.construct(target, args, newTarget) as KeyboardEvent;
        if (isAuthorityProbe) probes.push(event);
        return event;
      },
    });
    let view: ReturnType<typeof render> | null = null;
    Object.defineProperty(NativeKeyboardEvent.prototype, "constructor", {
      ...constructorDescriptor,
      value: ObservedKeyboardEvent,
    });
    window.KeyboardEvent = ObservedKeyboardEvent;
    try {
      vi.resetModules();
      const { NotificationsBell: IsolatedNotificationsBell } = await import(
        "./notifications-bell"
      );
      expect(probes).toHaveLength(0);
      const onOpen = vi.fn();
      store.useNotifications.mockReturnValue(state);
      view = render(
        <TooltipProvider>
          <IsolatedNotificationsBell onOpen={onOpen} />
        </TooltipProvider>,
      );
      expect(probes.length).toBeGreaterThan(0);
      const staleProbe = probes[0]!;
      const closedProbeCount = probes.length;
      markJsdomEventTrusted(staleProbe);

      fireEvent.click(screen.getByTestId("notifications-bell"));

      expect(screen.getByTestId("notifications-popover")).toBeVisible();
      expect(probes.length).toBeGreaterThan(closedProbeCount);
      expect(new Set(probes).size).toBe(probes.length);
      expect(probes.slice(closedProbeCount)).not.toContain(staleProbe);
      const rows = screen.getAllByTestId("notification-item");
      const source = rows[0]!;
      source.focus();
      const synthetic = new ObservedKeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });

      fireEvent(source, synthetic);

      expect(synthetic.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expectNoKeyboardActions(onOpen);

      const trusted = new ObservedKeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      markJsdomEventTrusted(trusted);
      fireEvent(source, trusted);
      expect(trusted.defaultPrevented).toBe(true);
      expect(rows[1]).toHaveFocus();
      expectNoKeyboardActions(onOpen);

      fireEvent.click(screen.getByTestId("notifications-bell"));
      rejectProbeConstruction = true;
      const probeCountBeforeFailure = probes.length;
      fireEvent.click(screen.getByTestId("notifications-bell"));
      expect(screen.getByTestId("notifications-popover")).toBeVisible();
      expect(probes).toHaveLength(probeCountBeforeFailure);
      const currentRow = screen.getAllByTestId("notification-item")[0]!;
      currentRow.focus();
      const rejected = new ObservedKeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      markJsdomEventTrusted(rejected);
      fireEvent(currentRow, rejected);
      expect(rejected.defaultPrevented).toBe(false);
      expect(currentRow).toHaveFocus();
      currentRow.click();
      expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
      expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM);
    } finally {
      view?.unmount();
      window.KeyboardEvent = NativeKeyboardEvent;
      Object.defineProperty(
        NativeKeyboardEvent.prototype,
        "constructor",
        constructorDescriptor,
      );
      vi.resetModules();
    }
  });

  it.each([
    [
      "KeyboardEvent constructor",
      () => {
        const NativeKeyboardEvent = window.KeyboardEvent;
        class ReplacedKeyboardEvent extends NativeKeyboardEvent {}
        window.KeyboardEvent = ReplacedKeyboardEvent;
        return () => {
          window.KeyboardEvent = NativeKeyboardEvent;
        };
      },
    ],
    [
      "KeyboardEvent prototype chain",
      () => {
        const parent = Object.getPrototypeOf(KeyboardEvent.prototype);
        Object.setPrototypeOf(KeyboardEvent.prototype, Event.prototype);
        return () => Object.setPrototypeOf(KeyboardEvent.prototype, parent);
      },
    ],
    [
      "KeyboardEvent key descriptor",
      () => {
        const descriptor = Object.getOwnPropertyDescriptor(
          KeyboardEvent.prototype,
          "key",
        );
        if (!descriptor?.get) {
          throw new Error("KeyboardEvent.key getter is unavailable");
        }
        Object.defineProperty(KeyboardEvent.prototype, "key", {
          ...descriptor,
          get() {
            return descriptor.get!.call(this);
          },
        });
        return () =>
          Object.defineProperty(KeyboardEvent.prototype, "key", descriptor);
      },
    ],
    [
      "Object descriptor authority",
      () => {
        const descriptor = Object.getOwnPropertyDescriptor(
          Object,
          "getOwnPropertyDescriptor",
        );
        if (!descriptor || typeof descriptor.value !== "function") {
          throw new Error("Object descriptor authority is unavailable");
        }
        const getOwnPropertyDescriptor = descriptor.value;
        Object.defineProperty(Object, "getOwnPropertyDescriptor", {
          ...descriptor,
          value: (...args: Parameters<ObjectConstructor["getOwnPropertyDescriptor"]>) =>
            getOwnPropertyDescriptor(...args),
        });
        return () =>
          Object.defineProperty(Object, "getOwnPropertyDescriptor", descriptor);
      },
    ],
  ] as const)(
    "rejects poisoned %s state present before publication without affecting row activation",
    (_label, poison) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const opened = openStrictKeyboardBell();
      let restore!: () => void;
      try {
        restore = poison();
        renderStrictBellRoot(opened.root, state, { onOpen: opened.onOpen });
      } finally {
        restore?.();
      }
      const source = captureActions().rows[0]!.element;
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const rejected = nativeKey(source, "ArrowDown");

      expect(rejected.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expectNoKeyboardActions(opened.onOpen);

      source.click();
      expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM.id);
      expect(opened.onOpen).toHaveBeenCalledExactlyOnceWith(ITEM);
    },
  );

  it("does not revive keyboard authority after descriptor replacement and restoration", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const onOpen = vi.fn();
    const { root, actions } = openStrictKeyboardBell(state, onOpen);
    const source = actions.rows[0]!.element;
    const descriptor = Object.getOwnPropertyDescriptor(
      KeyboardEvent.prototype,
      "key",
    );
    if (!descriptor?.get) {
      throw new Error("KeyboardEvent.key getter is unavailable");
    }
    source.focus();
    focus.mockClear();
    preventDefault.mockClear();

    Object.defineProperty(KeyboardEvent.prototype, "key", {
      ...descriptor,
      get() {
        return descriptor.get!.call(this);
      },
    });
    try {
      expect(nativeKey(source, "ArrowDown").defaultPrevented).toBe(false);
    } finally {
      Object.defineProperty(KeyboardEvent.prototype, "key", descriptor);
    }

    expect(nativeKey(source, "ArrowDown").defaultPrevented).toBe(false);
    expect(source).toHaveFocus();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectNoKeyboardActions(onOpen);

    renderStrictBellRoot(root, state, { onOpen });
    const current = captureActions().rows[0]!.element;
    current.focus();
    focus.mockClear();
    expect(nativeKey(current, "ArrowDown").defaultPrevented).toBe(true);
    expect(captureActions().rows[1]!.element).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("rechecks the exact candidate prototype immediately before claiming the key", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const { onOpen, actions } = openStrictKeyboardBell();
    const source = actions.rows[0]!.element;
    const replacementPrototype = Object.create(KeyboardEvent.prototype);
    let changedEvent: KeyboardEvent | null = null;
    const replacePrototype = (event: Event) => {
      changedEvent = event as KeyboardEvent;
      Object.setPrototypeOf(event, replacementPrototype);
    };
    source.addEventListener("keydown", replacePrototype, {
      capture: true,
      once: true,
    });
    source.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const rejected = nativeKey(source, "ArrowDown");
    Object.setPrototypeOf(rejected, KeyboardEvent.prototype);

    expect(changedEvent).toBe(rejected);
    expect(rejected.defaultPrevented).toBe(false);
    expect(source).toHaveFocus();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectNoKeyboardActions(onOpen);

    expect(nativeKey(source, "ArrowDown").defaultPrevented).toBe(true);
    expect(actions.rows[1]!.element).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("rejects a replaced own trust getter without invoking candidate authority", () => {
    const add = vi.spyOn(EventTarget.prototype, "addEventListener");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const { onOpen, actions } = openStrictKeyboardBell();
    const source = actions.rows[0]!.element;
    const listenerIndex = add.mock.calls.findIndex(
      ([type], index) =>
        type === "keydown" && add.mock.contexts[index] === source,
    );
    const listener = add.mock.calls[listenerIndex]?.[1];
    if (typeof listener !== "function") {
      throw new Error("The exact notification row key listener was not captured");
    }
    const canonical = Object.getOwnPropertyDescriptor(
      new KeyboardEvent("keydown"),
      "isTrusted",
    );
    if (!canonical?.get) {
      throw new Error("KeyboardEvent trust descriptor is unavailable");
    }
    const replacementGetter = vi.fn(() => true);
    const forged = Object.create(KeyboardEvent.prototype) as KeyboardEvent;
    Object.defineProperty(forged, "isTrusted", {
      ...canonical,
      get: replacementGetter,
    });
    source.focus();
    focus.mockClear();
    preventDefault.mockClear();

    listener.call(source, forged);

    expect(replacementGetter).not.toHaveBeenCalled();
    expect(source).toHaveFocus();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectNoKeyboardActions(onOpen);
  });

  it.each([
    ["ArrowDown middle", "ArrowDown", 1, 2],
    ["ArrowDown wrap", "ArrowDown", 2, 0],
    ["ArrowUp middle", "ArrowUp", 1, 0],
    ["ArrowUp wrap", "ArrowUp", 0, 2],
    ["Home", "Home", 1, 0],
    ["End", "End", 1, 2],
  ] as const)(
    "focuses exactly one ordered row for %s without changing tab order",
    (_label, key, sourceIndex, destinationIndex) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const { onOpen, actions } = openStrictKeyboardBell();
      const source = actions.rows[sourceIndex]!.element;
      const destination = actions.rows[destinationIndex]!.element;
      source.focus();
      focus.mockClear();

      const event = nativeKey(source, key);

      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(actions.rows.map(({ element }) => element.tabIndex)).toEqual([0, 0, 0]);
      expect(actions.readAll.element.tabIndex).toBe(0);
      expectNoKeyboardActions(onOpen);
    },
  );

  it.each([
    ["ArrowDown", 2],
    ["ArrowUp", 0],
    ["Home", 0],
    ["End", 2],
    ["PageDown", 2],
    ["PageUp", 0],
  ] as const)(
    "rejects a same-realm constructed %s before accepting trusted input",
    (key, destinationIndex) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const { onOpen, actions } = openStrictKeyboardBell();
      const source = actions.rows[1]!.element;
      const view = source.ownerDocument.defaultView!;
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const synthetic = new view.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });

      fireEvent(source, synthetic);

      expect(synthetic.isTrusted).toBe(false);
      expect(synthetic.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expectNoKeyboardActions(onOpen);

      const trusted = nativeKey(source, key);
      expect(trusted.isTrusted).toBe(true);
      expect(trusted.defaultPrevented).toBe(true);
      expect(actions.rows[destinationIndex]!.element).toHaveFocus();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
    },
  );

  it.each(["ArrowDown", "ArrowUp", "Home", "End"] as const)(
    "keeps the single %s row focused with one scroll-free focus call",
    (key) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const oneRow = {
        ...EMPTY,
        items: [ITEM],
        unreadCount: 1,
        loaded: true,
      };
      const { onOpen, actions } = openStrictKeyboardBell(oneRow);
      const row = actions.rows[0]!.element;
      row.focus();
      focus.mockClear();

      const event = nativeKey(row, key);

      expect(event.defaultPrevented).toBe(true);
      expect(row).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expectNoKeyboardActions(onOpen);
    },
  );

  it("does nothing when the current publication has no notification rows", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    openStrictKeyboardBell({ ...EMPTY, loaded: true });
    const list = screen.getByRole("list", { name: "Notifications" });
    const active = document.activeElement;
    focus.mockClear();

    const event = nativeKey(list, "ArrowDown");

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(active);
    expect(focus).not.toHaveBeenCalled();
    expect(captureActions().rows).toHaveLength(0);
  });

  it("preserves list, document, and window scroll and activates only after native click", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const onOpen = vi.fn();
    const { actions } = openStrictKeyboardBell(state, onOpen);
    const list = screen.getByRole("list", { name: "Notifications" });
    const source = actions.rows[0]!.element;
    const destination = actions.rows[1]!.element;
    list.scrollTop = 31;
    list.scrollLeft = 7;
    document.documentElement.scrollTop = 19;
    document.documentElement.scrollLeft = 5;
    document.body.scrollTop = 13;
    document.body.scrollLeft = 3;
    const windowScroll = {
      x: window.scrollX,
      y: window.scrollY,
      pageX: window.pageXOffset,
      pageY: window.pageYOffset,
    };
    source.focus();
    focus.mockClear();

    nativeKey(source, "ArrowDown");

    expect(destination).toHaveFocus();
    expect(list.scrollTop).toBe(31);
    expect(list.scrollLeft).toBe(7);
    expect(document.documentElement.scrollTop).toBe(19);
    expect(document.documentElement.scrollLeft).toBe(5);
    expect(document.body.scrollTop).toBe(13);
    expect(document.body.scrollLeft).toBe(3);
    expect({
      x: window.scrollX,
      y: window.scrollY,
      pageX: window.pageXOffset,
      pageY: window.pageYOffset,
    }).toEqual(windowScroll);
    expectNoKeyboardActions(onOpen);

    act(() => destination.click());
    expect(store.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ITEM_TWO.id);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEM_TWO);
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
  });

  it.each([
    ["Control PageDown", "PageDown", { ctrlKey: true }],
    ["Shift PageUp", "PageUp", { shiftKey: true }],
    ["Alt PageDown", "PageDown", { altKey: true }],
    ["Meta PageUp", "PageUp", { metaKey: true }],
    ["repeated PageDown", "PageDown", { repeat: true }],
    ["composing PageUp", "PageUp", { isComposing: true }],
    ["non-bubbling PageDown", "PageDown", { bubbles: false }],
    ["non-cancelable PageUp", "PageUp", { cancelable: false }],
  ] as const)("rejects %s before prevention or focus", (_label, key, init) => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const { onOpen, actions } = openStrictKeyboardBell();
    const source =
      actions.rows[key === "PageUp" ? actions.rows.length - 1 : 0]!.element;
    source.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const event = nativeKey(source, key, init);

    expect(event.defaultPrevented).toBe(false);
    expect(source).toHaveFocus();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectNoKeyboardActions(onOpen);
  });

  it("rejects already canceled and stopped PageDown input before prevention or focus", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const { onOpen, actions } = openStrictKeyboardBell();
    const source = actions.rows[0]!.element;
    const view = source.ownerDocument.defaultView!;
    const event = new view.KeyboardEvent("keydown", {
      key: "PageDown",
      bubbles: true,
      cancelable: true,
    });
    markJsdomEventTrusted(event);
    event.preventDefault();
    source.focus();
    focus.mockClear();
    preventDefault.mockClear();

    fireEvent(source, event);

    expect(event.defaultPrevented).toBe(true);
    expect(source).toHaveFocus();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectNoKeyboardActions(onOpen);

    const stopped = new view.KeyboardEvent("keydown", {
      key: "PageDown",
      bubbles: true,
      cancelable: true,
    });
    markJsdomEventTrusted(stopped);
    stopped.stopPropagation();
    fireEvent(source, stopped);
    expect(stopped.defaultPrevented).toBe(false);
    expect(source).toHaveFocus();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("rejects footer, retry, and outside PageDown sources without spending a row key", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const currentState = {
      ...state,
      readError: READ_FAILURE,
    };
    const { root, onOpen, actions } = openStrictKeyboardBell(currentState);
    const outside = document.createElement("button");
    document.body.append(outside);
    const controls = [
      actions.readRetry!.element,
      actions.readAll.element,
      outside,
    ];

    for (const control of controls) {
      control.focus();
      focus.mockClear();
      const event = nativeKey(control, "PageDown");
      expect(event.defaultPrevented).toBe(false);
      expect(control).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
    }

    expectNoKeyboardActions(onOpen);
    fireEvent.click(screen.getByTestId("notifications-bell"));
    renderStrictBellRoot(root, { ...EMPTY, loadError: true }, { onOpen });
    openCurrentBell();
    const loadRetry = screen.getByTestId("notifications-load-retry");
    loadRetry.focus();
    focus.mockClear();
    expect(nativeKey(loadRetry, "PageDown").defaultPrevented).toBe(false);
    expect(loadRetry).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("notifications-bell"));
    renderStrictBellRoot(root, currentState, { onOpen });
    openCurrentBell();
    const currentRows = captureActions().rows;
    const row = currentRows[0]!.element;
    row.focus();
    nativeKey(row, "PageDown");
    expect(currentRows[2]!.element).toHaveFocus();
    outside.remove();
  });

  it("requires exact native, React, and owner-window authority for PageDown", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const { onOpen, actions } = openStrictKeyboardBell();
    const source = actions.rows[0]!;
    source.element.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const nativeEvent = new KeyboardEvent("keydown", {
      key: "PageDown",
      bubbles: true,
      cancelable: true,
    });
    const forged = {
      nativeEvent,
      type: "keydown",
      currentTarget: source.element,
      target: source.element,
      key: "PageDown",
      code: "",
      location: 0,
      repeat: false,
      isComposing: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      timeStamp: nativeEvent.timeStamp,
      _reactName: "onKeyDown",
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
      persist: () => undefined,
    } as unknown as ReactKeyboardEvent<HTMLButtonElement>;
    source.keyDown?.(forged);
    dispatchKeyWithHandlers(
      source,
      [
        (event) => {
          source.keyDown?.(cloneSyntheticKey(event));
        },
      ],
      { key: "PageDown" },
    );

    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const foreignWindow = iframe.contentWindow as Window & typeof globalThis;
    const foreign = new foreignWindow.KeyboardEvent("keydown", {
      key: "PageDown",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(source.element, foreign);

    expect(nativeEvent.defaultPrevented).toBe(false);
    expect(foreign.defaultPrevented).toBe(false);
    expect(source.element).toHaveFocus();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectNoKeyboardActions(onOpen);
    iframe.remove();

    nativeKey(source.element, "PageDown");
    expect(actions.rows[2]!.element).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });

  it.each(["absent", "replaced", "non-function"] as const)(
    "keeps legitimate row delivery independent of %s persist",
    (variant) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const { onOpen, actions } = openStrictKeyboardBell();
      const source = actions.rows[0]!;
      source.element.focus();
      focus.mockClear();

      const event = dispatchKeyWithHandlers(
        source,
        [
          (reactEvent) => alterSyntheticPersist(reactEvent, variant),
          source.keyDown!,
        ],
        { key: "PageDown" },
      );

      expect(event.defaultPrevented).toBe(true);
      expect(actions.rows[2]!.element).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expectNoKeyboardActions(onOpen);
    },
  );

  it("accepts the exact row wrapper through unrelated prototypes and ordinary scalar getters", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { onOpen, actions } = openStrictKeyboardBell();
    const source = actions.rows[0]!;
    source.element.focus();
    focus.mockClear();

    const event = dispatchKeyWithHandlers(
      source,
      [
        (reactEvent) => {
          exposeKeyboardScalarsThroughGetters(reactEvent);
          Object.setPrototypeOf(reactEvent, {
            unrelated: true,
            persist: "unrelated",
          });
        },
        source.keyDown!,
      ],
      { key: "PageDown" },
    );

    expect(event.defaultPrevented).toBe(true);
    expect(actions.rows[2]!.element).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expectNoKeyboardActions(onOpen);
  });

  it.each([1, 3])(
    "retains exact row delivery through %i capture-to-bubble microtask checkpoint(s)",
    (checkpoints) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const { onOpen, actions } = openStrictKeyboardBell();
      const source = actions.rows[0]!;
      source.element.focus();
      focus.mockClear();

      const event = dispatchKeyWithMicrotaskCheckpoints(
        source,
        checkpoints,
        { key: "PageDown" },
      );

      expect(event.defaultPrevented).toBe(true);
      expect(actions.rows[2]!.element).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expectNoKeyboardActions(onOpen);
    },
  );

  it.each(["isDefaultPrevented", "isPropagationStopped"] as const)(
    "rejects row delivery after public %s query drift and admits a distinct event",
    (method) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const { onOpen, actions } = openStrictKeyboardBell();
      const source = actions.rows[0]!;
      source.element.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const rejected = dispatchKeyWithHandlers(
        source,
        [
          source.keyDown!,
          (event) => {
            Object.defineProperty(event, method, {
              configurable: true,
              value: () => true,
            });
          },
        ],
        { key: "PageDown" },
      );

      expect(rejected.defaultPrevented).toBe(false);
      expect(source.element).toHaveFocus();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expectNoKeyboardActions(onOpen);

      const accepted = nativeKey(source.element, "PageDown");
      expect(accepted.defaultPrevented).toBe(true);
      expect(actions.rows[2]!.element).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    },
  );

  it("preserves an exact row delivery through invalid, wrong-source, and crossed list terminals", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const { onOpen, actions } = openStrictKeyboardBell();
    const list = screen.getByRole("list", { name: "Notifications" });
    const listKeyDown = reactHandler<KeyboardListHandler>(list, "onKeyDown");
    const source = actions.rows[0]!;
    source.element.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const event = dispatchKeyWithHandlers(
      source,
      [
        source.keyDown!,
        (reactEvent) => {
          const original = {
            type: reactEvent.type,
            target: reactEvent.target,
            currentTarget: reactEvent.currentTarget,
          };
          const invokeExact = (
            type: string,
            target: EventTarget | null,
          ) => {
            Object.defineProperties(reactEvent, {
              type: { configurable: true, writable: true, value: type },
              target: { configurable: true, writable: true, value: target },
              currentTarget: {
                configurable: true,
                writable: true,
                value: list,
              },
            });
            listKeyDown(
              reactEvent as unknown as ReactKeyboardEvent<HTMLUListElement>,
            );
          };
          invokeExact("keyup", source.element);
          invokeExact("keydown", actions.rows[1]!.element);

          const crossed = cloneSyntheticKey(reactEvent);
          Object.defineProperties(crossed, {
            target: {
              configurable: true,
              writable: true,
              value: source.element,
            },
            currentTarget: {
              configurable: true,
              writable: true,
              value: list,
            },
          });
          listKeyDown(
            crossed as unknown as ReactKeyboardEvent<HTMLUListElement>,
          );
          Object.defineProperties(reactEvent, {
            type: {
              configurable: true,
              writable: true,
              value: original.type,
            },
            target: {
              configurable: true,
              writable: true,
              value: original.target,
            },
            currentTarget: {
              configurable: true,
              writable: true,
              value: original.currentTarget,
            },
          });
        },
      ],
      { key: "PageDown" },
    );

    expect(event.defaultPrevented).toBe(true);
    expect(actions.rows[2]!.element).toHaveFocus();
    expect(
      preventDefault.mock.contexts.filter((context) => context === event),
    ).toHaveLength(1);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expectNoKeyboardActions(onOpen);
  });

  it.each([
    ["authentication", "isDefaultPrevented", 2],
    ["authentication", "isPropagationStopped", 2],
    ["final validation", "isDefaultPrevented", 3],
  ] as const)(
    "poisons row delivery when %s %s reenters staging and admits a distinct event",
    (_phase, method, invokeAt) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const { onOpen, actions } = openStrictKeyboardBell();
      const source = actions.rows[0]!;
      source.element.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const rejected = dispatchKeyWithHandlers(
        source,
        [
          (event) =>
            replaceCancellationQuery(event, method, invokeAt, () =>
              source.keyDown?.(event),
            ),
          source.keyDown!,
        ],
        { key: "PageDown" },
      );

      expect(rejected.defaultPrevented).toBe(invokeAt === 3);
      expect(source.element).toHaveFocus();
      expect(
        preventDefault.mock.contexts.filter(
          (context) => context === rejected,
        ),
      ).toHaveLength(invokeAt === 3 ? 1 : 0);
      expect(
        focus.mock.contexts.filter(
          (context) => context === actions.rows[2]!.element,
        ),
      ).toHaveLength(0);
      expectNoKeyboardActions(onOpen);

      source.element.focus();
      focus.mockClear();
      const accepted = nativeKey(source.element, "PageDown");
      expect(accepted.defaultPrevented).toBe(true);
      expect(actions.rows[2]!.element).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    },
  );

  it("poisons row delivery on the first propagation query after exact prevention", () => {
    const nativePreventDefault = Event.prototype.preventDefault;
    let exactEvent: Event | null = null;
    let preventionCompleted = false;
    let hostileQueryRan = false;
    const preventDefault = vi
      .spyOn(Event.prototype, "preventDefault")
      .mockImplementation(function (this: Event) {
        Reflect.apply(nativePreventDefault, this, []);
        if (this === exactEvent) preventionCompleted = true;
      });
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { onOpen, actions } = openStrictKeyboardBell();
    const source = actions.rows[0]!;
    const destination = actions.rows[2]!.element;
    source.element.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const rejected = dispatchKeyWithHandlers(
      source,
      [
        (event) => {
          exactEvent = event.nativeEvent;
          const isPropagationStopped = event.isPropagationStopped;
          Object.defineProperty(event, "isPropagationStopped", {
            configurable: true,
            value: () => {
              const stopped = Reflect.apply(
                isPropagationStopped,
                event,
                [],
              );
              if (preventionCompleted && !hostileQueryRan) {
                hostileQueryRan = true;
                source.keyDown?.(event);
              }
              return stopped;
            },
          });
        },
        source.keyDown!,
      ],
      { key: "PageDown" },
    );

    expect(rejected.defaultPrevented).toBe(true);
    expect(preventionCompleted).toBe(true);
    expect(hostileQueryRan).toBe(true);
    expect(source.element).toHaveFocus();
    expect(
      preventDefault.mock.contexts.filter((context) => context === rejected),
    ).toHaveLength(1);
    expect(
      focus.mock.contexts.filter((context) => context === destination),
    ).toHaveLength(0);
    expectNoKeyboardActions(onOpen);

    source.element.focus();
    focus.mockClear();
    fireEvent(source.element, rejected);
    expect(source.element).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expectNoKeyboardActions(onOpen);

    const successor = nativeKey(source.element, "PageDown");
    expect(successor.defaultPrevented).toBe(true);
    expect(destination).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it.each([
    "native propagation",
    "required method",
    "focus",
    "destination DOM",
    "publication",
  ] as const)(
    "revalidates row authority after a current cancellation query mutates %s",
    (change) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const { root, onOpen, actions } = openStrictKeyboardBell();
      const source = actions.rows[0]!;
      const destination = actions.rows[2]!.element;
      source.element.focus();
      focus.mockClear();

      const rejected = dispatchKeyWithHandlers(
        source,
        [
          (event) =>
            replaceCancellationQuery(
              event,
              "isDefaultPrevented",
              3,
              () => {
                if (change === "native propagation") {
                  event.nativeEvent.stopPropagation();
                } else if (change === "required method") {
                  Object.defineProperty(event, "isPropagationStopped", {
                    configurable: true,
                    value: () => false,
                  });
                } else if (change === "focus") {
                  actions.rows[1]!.element.focus();
                } else if (change === "destination DOM") {
                  const parent = destination.parentNode;
                  const next = destination.nextSibling;
                  destination.remove();
                  parent?.insertBefore(destination, next);
                } else {
                  source.ref(null);
                  source.ref(source.element);
                }
              },
            ),
          source.keyDown!,
        ],
        { key: "PageDown" },
      );

      expect(rejected.defaultPrevented).toBe(true);
      expect(
        focus.mock.contexts.filter((context) => context === destination),
      ).toHaveLength(0);
      expectNoKeyboardActions(onOpen);

      if (change === "destination DOM" || change === "publication") {
        renderStrictBellRoot(root, state, { onOpen });
      }
      const current = captureActions();
      current.rows[0]!.element.focus();
      focus.mockClear();
      const accepted = nativeKey(current.rows[0]!.element, "PageDown");
      expect(accepted.defaultPrevented).toBe(true);
      expect(current.rows[2]!.element).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    },
  );

  it("keeps replayed and retired exact row delivery inert before a clean successor", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const onOpen = vi.fn();
    const { root, actions } = openStrictKeyboardBell(state, onOpen);
    const source = actions.rows[0]!;
    source.element.focus();
    focus.mockClear();

    const accepted = nativeKey(source.element, "PageDown");
    expect(accepted.defaultPrevented).toBe(true);
    expect(actions.rows[2]!.element).toHaveFocus();
    source.element.focus();
    focus.mockClear();
    fireEvent(source.element, accepted);
    expect(source.element).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();

    const retired = dispatchKeyWithHandlers(
      source,
      [
        source.keyDown!,
        (event) => {
          source.ref(null);
          source.ref(source.element);
          source.keyDown?.(event);
        },
      ],
      { key: "PageDown" },
    );
    expect(retired.defaultPrevented).toBe(false);
    expect(source.element).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expectNoKeyboardActions(onOpen);

    renderStrictBellRoot(root, state, { onOpen });
    const current = captureActions().rows[0]!.element;
    current.focus();
    focus.mockClear();
    const successor = nativeKey(current, "PageDown");
    expect(successor.defaultPrevented).toBe(true);
    expect(captureActions().rows[2]!.element).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("uses captured prevention and focus authority for PageDown instead of mutable public methods", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { actions } = openStrictKeyboardBell();
    const source = actions.rows[0]!.element;
    const destination = actions.rows[2]!.element;
    const dynamicPreventDefault = vi.fn();
    const dynamicFocus = vi.fn();
    source.focus();
    focus.mockClear();
    Object.defineProperty(destination, "focus", {
      configurable: true,
      value: dynamicFocus,
    });
    const view = source.ownerDocument.defaultView!;
    const event = new view.KeyboardEvent("keydown", {
      key: "PageDown",
      bubbles: true,
      cancelable: true,
    });
    markJsdomEventTrusted(event);
    Object.defineProperty(event, "preventDefault", {
      configurable: true,
      value: dynamicPreventDefault,
    });

    fireEvent(source, event);

    expect(event.defaultPrevented).toBe(true);
    expect(destination).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(dynamicPreventDefault).not.toHaveBeenCalled();
    expect(dynamicFocus).not.toHaveBeenCalled();
  });

  it("rejects crossed and reentrant PageDown handlers before one exact move", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { onOpen, actions } = openStrictKeyboardBell();
    const source = actions.rows[1]!;
    source.element.focus();
    focus.mockClear();

    dispatchKeyWithHandlers(
      source,
      [actions.rows[0]!.keyDown!, source.keyDown!, source.keyDown!],
      { key: "PageDown" },
    );

    expect(source.element).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expectNoKeyboardActions(onOpen);

    nativeKey(source.element, "PageDown");
    expect(actions.rows[2]!.element).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("rejects PageDown when ordered facts change between native and React delivery", () => {
    const items = [{ ...ITEM }, { ...ITEM_TWO }, { ...ITEM_THREE }];
    const mutableState = {
      ...EMPTY,
      items,
      unreadCount: items.length,
      loaded: true,
    };
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const onOpen = vi.fn();
    const { root, actions } = openStrictKeyboardBell(mutableState, onOpen);
    const stale = actions.rows[0]!;
    stale.element.focus();
    focus.mockClear();
    preventDefault.mockClear();

    dispatchKeyWithHandlers(
      stale,
      [
        () => {
          mutableState.loading = true;
        },
        stale.keyDown!,
      ],
      { key: "PageDown" },
    );

    expect(stale.element).toHaveFocus();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectNoKeyboardActions(onOpen);

    mutableState.loading = false;
    expect(nativeKey(stale.element, "PageDown").defaultPrevented).toBe(false);
    renderStrictBellRoot(root, mutableState, { onOpen });
    const current = captureActions().rows[0]!.element;
    current.focus();
    focus.mockClear();
    expect(nativeKey(current, "PageDown").defaultPrevented).toBe(true);
    expect(captureActions().rows[2]!.element).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });

  it.each([
    "root detach and reinsert",
    "row reorder and restore",
    "row replacement and restore",
    "attribute mutation and restore",
  ] as const)(
    "retires PageDown after %s history before a clean successor",
    (change) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const onOpen = vi.fn();
      const { root, actions } = openStrictKeyboardBell(state, onOpen);
      const source = actions.rows[0]!.element;
      const content = screen.getByTestId("notifications-popover");
      const portalRoot = content.firstElementChild;
      const list = portalRoot?.children.item(1);
      if (
        !(portalRoot instanceof HTMLDivElement) ||
        !(list instanceof HTMLUListElement)
      ) {
        throw new Error("Expected the exact notification portal topology");
      }
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();

      if (change === "root detach and reinsert") {
        const parent = portalRoot.parentNode;
        const next = portalRoot.nextSibling;
        if (!parent) throw new Error("The notification root has no parent");
        portalRoot.remove();
        parent.insertBefore(portalRoot, next);
      } else if (change === "row reorder and restore") {
        const first = list.children.item(0);
        const second = list.children.item(1);
        if (!first || !second) throw new Error("Expected notification rows");
        list.append(first);
        list.insertBefore(first, second);
      } else if (change === "row replacement and restore") {
        const parent = source.parentNode;
        const clone = source.cloneNode(true);
        if (!parent) throw new Error("The notification row has no parent");
        parent.replaceChild(clone, source);
        parent.replaceChild(source, clone);
      } else {
        source.dataset.notificationId = "changed-notification";
        source.dataset.notificationId = ITEM.id;
      }

      const rejected = nativeKey(source, "PageDown");
      expect(rejected.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expectNoKeyboardActions(onOpen);

      renderStrictBellRoot(root, state, { onOpen });
      const current = captureActions().rows[0]!.element;
      current.focus();
      focus.mockClear();
      const accepted = nativeKey(current, "PageDown");
      expect(accepted.defaultPrevented).toBe(true);
      expect(captureActions().rows[2]!.element).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    },
  );

  it("retires PageDown on restored fact drift until a fresh render", () => {
    const first = { ...ITEM };
    const items = [first, { ...ITEM_TWO }, { ...ITEM_THREE }];
    const mutableState = {
      ...EMPTY,
      items,
      unreadCount: 3,
      loaded: true,
    };
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const onOpen = vi.fn();
    const { root, actions } = openStrictKeyboardBell(mutableState, onOpen);
    const stale = actions.rows[0]!.element;
    stale.focus();
    focus.mockClear();
    first.documentTitle = "Producer drift";

    expect(nativeKey(stale, "PageDown").defaultPrevented).toBe(false);
    first.documentTitle = ITEM.documentTitle;
    expect(nativeKey(stale, "PageDown").defaultPrevented).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expectNoKeyboardActions(onOpen);

    renderStrictBellRoot(root, mutableState, { onOpen });
    const current = captureActions().rows[0]!.element;
    current.focus();
    focus.mockClear();
    expect(nativeKey(current, "PageDown").defaultPrevented).toBe(true);
    expect(captureActions().rows[2]!.element).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("rejects stale PageDown callbacks and gives the replacement visit fresh authority", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const firstOpen = vi.fn();
    const nextOpen = vi.fn();
    const { root, actions } = openStrictKeyboardBell(state, firstOpen);
    const stale = actions.rows[0]!;

    renderStrictBellRoot(root, state, { onOpen: nextOpen });
    stale.element.focus();
    focus.mockClear();
    expect(nativeKey(stale.element, "PageDown").defaultPrevented).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(firstOpen).not.toHaveBeenCalled();
    expect(nextOpen).not.toHaveBeenCalled();

    openCurrentBell();
    const current = captureActions().rows[0]!.element;
    current.focus();
    focus.mockClear();
    expect(nativeKey(current, "PageDown").defaultPrevented).toBe(true);
    expect(captureActions().rows[2]!.element).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("rejects stale and replaced PageDown disclosures before fresh recovery", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { actions } = openStrictKeyboardBell();
    const stale = actions.rows[0]!;
    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    focus.mockClear();

    stale.element.focus();
    stale.keyDown?.({
      nativeEvent: new KeyboardEvent("keydown", {
        key: "PageDown",
        bubbles: true,
        cancelable: true,
      }),
    } as unknown as ReactKeyboardEvent<HTMLButtonElement>);
    expect(focus).toHaveBeenCalledOnce();
    focus.mockClear();

    openCurrentBell();
    const current = captureActions().rows[0]!;
    current.element.focus();
    focus.mockClear();
    dispatchKeyWithHandlers(current, [stale.keyDown!, current.keyDown!], {
      key: "PageDown",
    });
    expect(captureActions().rows[2]!.element).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("rejects partial Strict Mode PageDown replay and recovers on a clean successor", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { root, onOpen, actions } = openStrictKeyboardBell();
    const stale = actions.rows[0]!;
    stale.element.focus();
    focus.mockClear();

    act(() => {
      stale.ref(null);
      stale.ref(stale.element);
    });
    expect(nativeKey(stale.element, "PageDown").defaultPrevented).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expectNoKeyboardActions(onOpen);

    renderStrictBellRoot(root, state, { onOpen });
    const current = captureActions().rows[0]!.element;
    current.focus();
    focus.mockClear();
    expect(nativeKey(current, "PageDown").defaultPrevented).toBe(true);
    expect(captureActions().rows[2]!.element).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("ignores old cleanup and stale PageDown handlers before one current move", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { root, onOpen, actions: stale } = openStrictKeyboardBell();
    let current!: ReturnType<typeof captureActions>;

    renderStrictBellRoot(root, state, {
      onOpen,
      boundary: 2,
      onBoundary: () => {
        current = captureActions();
      },
    });
    expect(current.rows[0]!.element).toBe(stale.rows[0]!.element);
    act(() => stale.rows[0]!.ref(null));
    current.rows[0]!.element.focus();
    focus.mockClear();

    dispatchKeyWithHandlers(
      current.rows[0]!,
      [stale.rows[0]!.keyDown!, current.rows[0]!.keyDown!],
      { key: "PageDown" },
    );

    expect(current.rows[2]!.element).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
    expectNoKeyboardActions(onOpen);
  });

  it("removes PageDown row listeners on cleanup and leaves a fresh mount usable", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const add = vi.spyOn(EventTarget.prototype, "addEventListener");
    const remove = vi.spyOn(EventTarget.prototype, "removeEventListener");
    const onOpen = vi.fn();
    const { root, actions } = openStrictKeyboardBell(state, onOpen);
    const stale = actions.rows[0]!.element;
    const staleRows = new Set(actions.rows.map(({ element }) => element));
    const staleKeyAdds = add.mock.calls.filter(
      ([type], index) =>
        type === "keydown" && staleRows.has(add.mock.contexts[index] as HTMLButtonElement),
    ).length;
    expect(staleKeyAdds).toBeGreaterThanOrEqual(state.items.length);

    renderStrictBellRoot(root, state, { onOpen, present: false });
    const keyRemovals = remove.mock.calls.filter(
      ([type], index) =>
        type === "keydown" &&
        staleRows.has(remove.mock.contexts[index] as HTMLButtonElement),
    ).length;
    expect(keyRemovals).toBeGreaterThanOrEqual(staleKeyAdds);
    focus.mockClear();
    stale.focus();
    focus.mockClear();
    expect(nativeKey(stale, "PageDown").defaultPrevented).toBe(false);
    expect(focus).not.toHaveBeenCalled();

    renderStrictBellRoot(root, state, { onOpen, present: true });
    openCurrentBell();
    const current = captureActions().rows[0]!.element;
    current.focus();
    focus.mockClear();
    expect(nativeKey(current, "PageDown").defaultPrevented).toBe(true);
    expect(captureActions().rows[2]!.element).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });
});

describe("notification bell directional disclosure", () => {
  const state = {
    ...EMPTY,
    items: [ITEM, ITEM_TWO, ITEM_THREE],
    unreadCount: 3,
    loaded: true,
  };

  function trustedKey(
    element: HTMLElement,
    key: string,
    init: KeyboardEventInit = {},
  ) {
    const view = element.ownerDocument.defaultView;
    if (!view) throw new Error("The keyboard target has no owner window");
    const event = new view.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    markJsdomEventTrusted(event);
    fireEvent(element, event);
    return event;
  }

  function expectNoDisclosureWork(onOpen: ReturnType<typeof vi.fn>) {
    expect(store.retryNotificationRead).not.toHaveBeenCalled();
    expect(store.refreshNotifications).not.toHaveBeenCalled();
    expect(store.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(store.markNotificationRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  }

  it.each([
    ["ArrowDown", 0],
    ["ArrowUp", 2],
  ] as const)(
    "opens with trusted %s and focuses the exact ordered row once without other work",
    (key, destinationIndex) => {
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const onOpen = vi.fn();
      createStrictBellRoot(state, { onOpen }, () => undefined);
      const trigger = screen.getByTestId("notifications-bell");
      const scroll = {
        documentTop: document.documentElement.scrollTop,
        documentLeft: document.documentElement.scrollLeft,
        bodyTop: document.body.scrollTop,
        bodyLeft: document.body.scrollLeft,
        windowX: window.scrollX,
        windowY: window.scrollY,
      };
      trigger.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const event = trustedKey(trigger, key);

      const rows = screen.getAllByTestId("notification-item");
      expect(event.defaultPrevented).toBe(true);
      expect(screen.getAllByTestId("notifications-popover")).toHaveLength(1);
      expect(rows[destinationIndex]).toHaveFocus();
      expect(
        preventDefault.mock.contexts.filter((context) => context === event),
      ).toHaveLength(1);
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(focus.mock.contexts[0]).toBe(rows[destinationIndex]);
      expect({
        documentTop: document.documentElement.scrollTop,
        documentLeft: document.documentElement.scrollLeft,
        bodyTop: document.body.scrollTop,
        bodyLeft: document.body.scrollLeft,
        windowX: window.scrollX,
        windowY: window.scrollY,
      }).toEqual(scroll);
      expectNoDisclosureWork(onOpen);
    },
  );

  it("opens an empty disclosure without moving focus and keeps Escape closing", async () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const onOpen = vi.fn();
    createStrictBellRoot(
      { ...EMPTY, loaded: true },
      { onOpen },
      () => undefined,
    );
    const trigger = screen.getByTestId("notifications-bell");
    trigger.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const event = trustedKey(trigger, "ArrowDown");
    await act(() => Promise.resolve());

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByTestId("notifications-popover")).toBeVisible();
    expect(screen.queryAllByTestId("notification-item")).toHaveLength(0);
    expect(trigger).toHaveFocus();
    expect(
      preventDefault.mock.contexts.filter((context) => context === event),
    ).toHaveLength(1);
    expect(focus).not.toHaveBeenCalled();
    expectNoDisclosureWork(onOpen);

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(trigger).toHaveFocus();
  });

  it("retains row navigation, Escape return focus, and click toggling", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const onOpen = vi.fn();
    createStrictBellRoot(state, { onOpen }, () => undefined);
    const trigger = screen.getByTestId("notifications-bell");
    trigger.focus();
    focus.mockClear();
    trustedKey(trigger, "ArrowDown");
    const rows = screen.getAllByTestId("notification-item");
    focus.mockClear();

    const browse = trustedKey(rows[0]!, "ArrowDown");
    expect(browse.defaultPrevented).toBe(true);
    expect(rows[1]).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expectNoDisclosureWork(onOpen);

    fireEvent.keyDown(rows[1]!, { key: "Escape" });
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    expect(screen.getByTestId("notifications-popover")).toBeVisible();
    fireEvent.click(trigger);
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    for (const key of ["Enter", " "] as const) {
      const toggleKey = trustedKey(trigger, key);
      expect(toggleKey.defaultPrevented).toBe(false);
      fireEvent.click(trigger);
      expect(screen.getByTestId("notifications-popover")).toBeVisible();
      fireEvent.click(trigger);
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
    }
    expectNoDisclosureWork(onOpen);
  });

  it.each(["absent", "replaced", "non-function"] as const)(
    "keeps legitimate trigger delivery independent of %s persist",
    (variant) => {
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const onOpen = vi.fn();
      createStrictBellRoot(state, { onOpen }, () => undefined);
      const trigger = captureControl(screen.getByTestId("notifications-bell"));
      trigger.element.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const event = dispatchKeyWithHandlers(
        trigger,
        [
          (reactEvent) => alterSyntheticPersist(reactEvent, variant),
          trigger.keyDown!,
        ],
        { key: "ArrowDown" },
      );

      expect(event.defaultPrevented).toBe(true);
      expect(screen.getAllByTestId("notification-item")[0]).toHaveFocus();
      expect(
        preventDefault.mock.contexts.filter((context) => context === event),
      ).toHaveLength(1);
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expectNoDisclosureWork(onOpen);
    },
  );

  it("accepts the exact trigger wrapper through unrelated prototypes and ordinary scalar getters", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const onOpen = vi.fn();
    createStrictBellRoot(state, { onOpen }, () => undefined);
    const trigger = captureControl(screen.getByTestId("notifications-bell"));
    trigger.element.focus();
    focus.mockClear();

    const event = dispatchKeyWithHandlers(
      trigger,
      [
        (reactEvent) => {
          exposeKeyboardScalarsThroughGetters(reactEvent);
          Object.setPrototypeOf(reactEvent, {
            unrelated: true,
            persist: 17,
          });
        },
        trigger.keyDown!,
      ],
      { key: "ArrowUp" },
    );

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getAllByTestId("notification-item")[2]).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expectNoDisclosureWork(onOpen);
  });

  it.each([1, 3])(
    "retains exact trigger delivery through %i capture-to-document microtask checkpoint(s)",
    (checkpoints) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const onOpen = vi.fn();
      createStrictBellRoot(state, { onOpen }, () => undefined);
      const trigger = captureControl(screen.getByTestId("notifications-bell"));
      trigger.element.focus();
      focus.mockClear();

      const event = dispatchKeyWithMicrotaskCheckpoints(
        trigger,
        checkpoints,
        { key: "ArrowDown" },
      );

      expect(event.defaultPrevented).toBe(true);
      expect(screen.getAllByTestId("notification-item")[0]).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expectNoDisclosureWork(onOpen);
    },
  );

  it.each(["isDefaultPrevented", "isPropagationStopped"] as const)(
    "rejects trigger delivery after public %s query drift and admits a distinct event",
    (method) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const onOpen = vi.fn();
      createStrictBellRoot(state, { onOpen }, () => undefined);
      const trigger = captureControl(screen.getByTestId("notifications-bell"));
      trigger.element.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const rejected = dispatchKeyWithHandlers(
        trigger,
        [
          trigger.keyDown!,
          (event) => {
            Object.defineProperty(event, method, {
              configurable: true,
              value: () => true,
            });
          },
        ],
        { key: "ArrowDown" },
      );

      expect(rejected.defaultPrevented).toBe(false);
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expectNoDisclosureWork(onOpen);

      const accepted = trustedKey(trigger.element, "ArrowUp");
      expect(accepted.defaultPrevented).toBe(true);
      expect(screen.getAllByTestId("notification-item")[2]).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    },
  );

  it("preserves an exact trigger delivery after a failed competing document terminal", () => {
    const competing = { event: null as ReactKeyboardEvent<HTMLButtonElement> | null };
    let terminal: EventListener | null = null;
    const competingTerminal: EventListener = (nativeEvent) => {
      const event = competing.event;
      if (!event || !terminal) return;
      const original = event.isDefaultPrevented;
      Object.defineProperty(event, "isDefaultPrevented", {
        configurable: true,
        value: () => true,
      });
      terminal(nativeEvent);
      Object.defineProperty(event, "isDefaultPrevented", {
        configurable: true,
        value: original,
      });
    };
    document.addEventListener("keydown", competingTerminal, false);
    const add = vi.spyOn(EventTarget.prototype, "addEventListener");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const onOpen = vi.fn();
    createStrictBellRoot(state, { onOpen }, () => undefined);
    terminal =
      (add.mock.calls
        .map((call, index) => ({
          call,
          context: add.mock.contexts[index],
        }))
        .filter(
          ({ call: [type, listener, options], context }) =>
            context === document &&
            type === "keydown" &&
            options === false &&
            typeof listener === "function",
        )
        .at(-1)?.call[1] as EventListener | undefined) ?? null;
    if (!terminal) throw new Error("The document key terminal was not attached");
    const trigger = captureControl(screen.getByTestId("notifications-bell"));
    trigger.element.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const event = dispatchKeyWithHandlers(
      trigger,
      [
        trigger.keyDown!,
        (reactEvent) => {
          competing.event = reactEvent;
        },
      ],
      { key: "ArrowDown" },
    );
    document.removeEventListener("keydown", competingTerminal, false);

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getAllByTestId("notification-item")[0]).toHaveFocus();
    expect(
      preventDefault.mock.contexts.filter((context) => context === event),
    ).toHaveLength(1);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expectNoDisclosureWork(onOpen);
  });

  it.each([
    ["authentication", "isDefaultPrevented", 2],
    ["authentication", "isPropagationStopped", 2],
    ["final validation", "isDefaultPrevented", 3],
    ["final validation", "isPropagationStopped", 3],
  ] as const)(
    "poisons trigger delivery when %s %s reenters staging and admits a distinct event",
    (_phase, method, invokeAt) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const onOpen = vi.fn();
      createStrictBellRoot(state, { onOpen }, () => undefined);
      const trigger = captureControl(screen.getByTestId("notifications-bell"));
      trigger.element.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const rejected = dispatchKeyWithHandlers(
        trigger,
        [
          (event) =>
            replaceCancellationQuery(event, method, invokeAt, () =>
              trigger.keyDown?.(event),
            ),
          trigger.keyDown!,
        ],
        { key: "ArrowDown" },
      );

      expect(rejected.defaultPrevented).toBe(invokeAt === 3);
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
      expect(trigger.element).toHaveFocus();
      expect(
        preventDefault.mock.contexts.filter(
          (context) => context === rejected,
        ),
      ).toHaveLength(invokeAt === 3 ? 1 : 0);
      expect(focus).not.toHaveBeenCalled();
      expectNoDisclosureWork(onOpen);

      focus.mockClear();
      const accepted = trustedKey(trigger.element, "ArrowUp");
      expect(accepted.defaultPrevented).toBe(true);
      expect(screen.getAllByTestId("notification-item")[2]).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    },
  );

  it.each([
    "native propagation",
    "required method",
    "focus",
    "publication",
  ] as const)(
    "revalidates trigger authority after a current cancellation query mutates %s",
    (change) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const onOpen = vi.fn();
      const root = createStrictBellRoot(state, { onOpen }, () => undefined);
      const trigger = captureControl(screen.getByTestId("notifications-bell"));
      const outside = document.createElement("button");
      document.body.append(outside);
      trigger.element.focus();
      focus.mockClear();

      const rejected = dispatchKeyWithHandlers(
        trigger,
        [
          (event) =>
            replaceCancellationQuery(
              event,
              "isDefaultPrevented",
              3,
              () => {
                if (change === "native propagation") {
                  event.nativeEvent.stopPropagation();
                } else if (change === "required method") {
                  Object.defineProperty(event, "isPropagationStopped", {
                    configurable: true,
                    value: () => false,
                  });
                } else if (change === "focus") {
                  outside.focus();
                } else {
                  trigger.ref(null);
                  trigger.ref(trigger.element);
                }
              },
            ),
          trigger.keyDown!,
        ],
        { key: "ArrowDown" },
      );

      expect(rejected.defaultPrevented).toBe(true);
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
      expectNoDisclosureWork(onOpen);

      outside.remove();
      if (change === "publication") {
        renderStrictBellRoot(root, state, { onOpen });
      }
      const current = screen.getByTestId("notifications-bell");
      current.focus();
      focus.mockClear();
      const accepted = trustedKey(current, "ArrowUp");
      expect(accepted.defaultPrevented).toBe(true);
      expect(screen.getAllByTestId("notification-item")[2]).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    },
  );

  it("keeps a retired exact trigger delivery inert before a distinct clean successor", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const onOpen = vi.fn();
    const root = createStrictBellRoot(state, { onOpen }, () => undefined);
    const stale = captureControl(screen.getByTestId("notifications-bell"));
    stale.element.focus();
    focus.mockClear();

    const retired = dispatchKeyWithHandlers(
      stale,
      [
        stale.keyDown!,
        (event) => {
          stale.ref(null);
          stale.ref(stale.element);
          stale.keyDown?.(event);
        },
      ],
      { key: "ArrowDown" },
    );

    expect(retired.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    expectNoDisclosureWork(onOpen);

    renderStrictBellRoot(root, state, { onOpen });
    const current = captureControl(screen.getByTestId("notifications-bell"));
    current.element.focus();
    focus.mockClear();
    const successor = trustedKey(current.element, "ArrowDown");
    expect(successor.defaultPrevented).toBe(true);
    expect(screen.getAllByTestId("notification-item")[0]).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("rejects altered, canceled, stopped, untrusted, and unfocused keys before recovery", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const onOpen = vi.fn();
    createStrictBellRoot(state, { onOpen }, () => undefined);
    const trigger = screen.getByTestId("notifications-bell");
    const outside = document.createElement("button");
    document.body.append(outside);
    const rejected: KeyboardEvent[] = [];
    for (const init of [
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { metaKey: true },
      { repeat: true },
      { isComposing: true },
      { bubbles: false },
      { cancelable: false },
    ]) {
      trigger.focus();
      const event = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      markJsdomEventTrusted(event);
      rejected.push(event);
    }
    rejected.push(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
    const prevented = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    markJsdomEventTrusted(prevented);
    Event.prototype.preventDefault.call(prevented);
    rejected.push(prevented);
    const stopped = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    markJsdomEventTrusted(stopped);
    stopped.stopPropagation();
    rejected.push(stopped);

    preventDefault.mockClear();
    focus.mockClear();
    for (const event of rejected) {
      trigger.focus();
      focus.mockClear();
      fireEvent(trigger, event);
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
      expect(focus).not.toHaveBeenCalled();
    }
    outside.focus();
    focus.mockClear();
    const unfocused = trustedKey(trigger, "ArrowDown");
    expect(unfocused.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    expectNoDisclosureWork(onOpen);

    trigger.focus();
    focus.mockClear();
    const accepted = trustedKey(trigger, "ArrowUp");
    expect(accepted.defaultPrevented).toBe(true);
    expect(screen.getAllByTestId("notification-item")[2]).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    outside.remove();
  });

  it("rejects crossed Strict replay handlers and admits one fresh pair", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const onOpen = vi.fn();
    const replay = { trigger: null as CapturedControl | null };
    createStrictBellRoot(state, { onOpen }, () => {
      replay.trigger ??= captureControl(
        screen.getByTestId("notifications-bell"),
      );
    });
    const stale = replay.trigger;
    if (!stale?.keyDown) {
      throw new Error("Strict Mode did not publish its replay trigger key");
    }
    const current = captureControl(screen.getByTestId("notifications-bell"));
    if (!current.keyDown) {
      throw new Error("The current trigger key was not published");
    }
    expect(current.element).toBe(stale.element);
    expect(current.keyDown).not.toBe(stale.keyDown);
    current.element.focus();
    focus.mockClear();

    dispatchKeyWithHandlers(
      current,
      [stale.keyDown, current.keyDown],
      { key: "ArrowDown" },
    );

    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    expectNoDisclosureWork(onOpen);

    const accepted = trustedKey(current.element, "ArrowDown");
    expect(accepted.defaultPrevented).toBe(true);
    expect(screen.getAllByTestId("notification-item")[0]).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("rejects fabricated, foreign, reentrant, and replayed pairs before fresh recovery", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const onOpen = vi.fn();
    createStrictBellRoot(state, { onOpen }, () => undefined);
    const control = captureControl(
      screen.getByTestId("notifications-bell"),
    );
    if (!control.keyDown) {
      throw new Error("The current trigger key was not published");
    }
    const fabricatedNative = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    control.keyDown({
      nativeEvent: fabricatedNative,
      type: "keydown",
      currentTarget: control.element,
      target: control.element,
      key: "ArrowDown",
    } as unknown as ReactKeyboardEvent<HTMLButtonElement>);
    expect(screen.queryByTestId("notifications-popover")).toBeNull();

    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const foreignWindow = iframe.contentWindow as Window & typeof globalThis;
    const foreign = new foreignWindow.KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    control.element.focus();
    focus.mockClear();
    fireEvent(control.element, foreign);
    expect(foreign.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    iframe.remove();

    dispatchKeyWithHandlers(
      control,
      [control.keyDown, control.keyDown],
      { key: "ArrowDown" },
    );
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    expect(focus).not.toHaveBeenCalled();

    const accepted = trustedKey(control.element, "ArrowDown");
    expect(accepted.defaultPrevented).toBe(true);
    expect(screen.getAllByTestId("notification-item")[0]).toHaveFocus();
    fireEvent.click(control.element);
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    focus.mockClear();

    fireEvent(control.element, accepted);
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    expectNoDisclosureWork(onOpen);

    control.element.focus();
    focus.mockClear();
    const recovered = trustedKey(control.element, "ArrowUp");
    expect(recovered.defaultPrevented).toBe(true);
    expect(screen.getAllByTestId("notification-item")[2]).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it.each([
    "detach and restore",
    "reorder and restore",
    "replace and restore",
    "attribute and restore",
  ] as const)(
    "retires trigger DOM after %s before a distinct successor recovers",
    (change) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const onOpen = vi.fn();
      const root = createStrictBellRoot(
        state,
        { onOpen },
        () => undefined,
      );
      const stale = captureControl(screen.getByTestId("notifications-bell"));
      const trigger = stale.element;
      const parent = trigger.parentNode;
      if (!parent) throw new Error("The trigger has no parent");

      if (change === "detach and restore") {
        const next = trigger.nextSibling;
        trigger.remove();
        parent.insertBefore(trigger, next);
      } else if (change === "reorder and restore") {
        const marker = document.createElement("span");
        parent.insertBefore(marker, trigger);
        parent.append(trigger);
        parent.insertBefore(trigger, marker.nextSibling);
        marker.remove();
      } else if (change === "replace and restore") {
        const replacement = trigger.cloneNode(true);
        parent.replaceChild(replacement, trigger);
        parent.replaceChild(trigger, replacement);
      } else {
        trigger.dataset.unread = "changed";
        trigger.dataset.unread = String(state.unreadCount);
      }
      trigger.focus();
      focus.mockClear();

      const rejected = trustedKey(trigger, "ArrowDown");
      expect(rejected.defaultPrevented).toBe(false);
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
      expect(focus).not.toHaveBeenCalled();
      expectNoDisclosureWork(onOpen);

      renderStrictBellRoot(root, state, { onOpen });
      const current = captureControl(
        screen.getByTestId("notifications-bell"),
      );
      expect(current.keyDown).not.toBe(stale.keyDown);
      current.element.focus();
      focus.mockClear();
      const accepted = trustedKey(current.element, "ArrowDown");
      expect(accepted.defaultPrevented).toBe(true);
      expect(screen.getAllByTestId("notification-item")[0]).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
    },
  );

  it("retires restored row and load drift until a fresh render", () => {
    const first = { ...ITEM };
    const items = [first, { ...ITEM_TWO }];
    const mutable = {
      ...EMPTY,
      items,
      unreadCount: 2,
      loaded: true,
    };
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const onOpen = vi.fn();
    const root = createStrictBellRoot(
      mutable,
      { onOpen },
      () => undefined,
    );
    const stale = captureControl(screen.getByTestId("notifications-bell"));
    stale.element.focus();
    focus.mockClear();
    first.documentTitle = "Drifted";
    mutable.loading = true;

    expect(trustedKey(stale.element, "ArrowDown").defaultPrevented).toBe(
      false,
    );
    first.documentTitle = ITEM.documentTitle;
    mutable.loading = false;
    expect(trustedKey(stale.element, "ArrowDown").defaultPrevented).toBe(
      false,
    );
    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    expectNoDisclosureWork(onOpen);

    renderStrictBellRoot(root, mutable, { onOpen });
    const current = screen.getByTestId("notifications-bell");
    current.focus();
    focus.mockClear();
    expect(trustedKey(current, "ArrowUp").defaultPrevented).toBe(true);
    expect(screen.getAllByTestId("notification-item")[1]).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("removes trigger key listeners on cleanup and keeps a fresh mount usable", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const add = vi.spyOn(EventTarget.prototype, "addEventListener");
    const remove = vi.spyOn(EventTarget.prototype, "removeEventListener");
    const onOpen = vi.fn();
    const root = createStrictBellRoot(
      state,
      { onOpen },
      () => undefined,
    );
    const stale = captureControl(screen.getByTestId("notifications-bell"));
    const keyAdds = add.mock.calls.filter(
      ([type], index) =>
        type === "keydown" &&
        add.mock.contexts[index] === stale.element,
    ).length;
    expect(keyAdds).toBeGreaterThanOrEqual(2);

    renderStrictBellRoot(root, state, { onOpen, present: false });
    const keyRemovals = remove.mock.calls.filter(
      ([type], index) =>
        type === "keydown" &&
        remove.mock.contexts[index] === stale.element,
    ).length;
    expect(keyRemovals).toBeGreaterThanOrEqual(1);
    focus.mockClear();
    expect(trustedKey(stale.element, "ArrowDown").defaultPrevented).toBe(
      false,
    );
    expect(focus).not.toHaveBeenCalled();
    expectNoDisclosureWork(onOpen);

    renderStrictBellRoot(root, state, { onOpen, present: true });
    const current = screen.getByTestId("notifications-bell");
    current.focus();
    focus.mockClear();
    expect(trustedKey(current, "ArrowDown").defaultPrevented).toBe(true);
    expect(screen.getAllByTestId("notification-item")[0]).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });
});

describe("notification bell Strict Mode replay", () => {
  it("accepts an exact replay click after its synthetic constructor is production-mangled", () => {
    const state = { ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true };
    createStrictBellRoot(state, { onOpen: vi.fn() }, () => undefined);
    const trigger = captureControl(screen.getByTestId("notifications-bell"));
    const mangledConstructor = class a {};

    dispatchWithHandlers(trigger, [
      (event) => {
        const syntheticClick = cloneSyntheticClick(event, mangledConstructor);
        expect(Object.getPrototypeOf(syntheticClick).constructor.name).toBe("a");
        trigger.click(syntheticClick);
      },
    ]);

    expect(screen.getByTestId("notifications-popover")).toBeVisible();
  });

  it.each([
    ["focus-open", false],
    ["pointerdown-close", true],
  ] as const)("keeps the trigger exact through real tooltip %s", (_phase, closeOnPointerDown) => {
    const state = { ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true };
    const replay = { trigger: null as CapturedControl | null };
    createStrictBellRoot(state, { onOpen: vi.fn() }, () => {
      replay.trigger ??= captureControl(screen.getByTestId("notifications-bell"));
    });
    const replayTrigger = replay.trigger;
    if (!replayTrigger) throw new Error("Strict Mode did not expose its first layout");
    const currentTrigger = captureControl(screen.getByTestId("notifications-bell"));

    fireEvent.focus(currentTrigger.element);
    const descriptionId = currentTrigger.element.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(screen.getByRole("tooltip")).toHaveAttribute("id", descriptionId);
    if (closeOnPointerDown) {
      fireEvent.pointerDown(currentTrigger.element);
      expect(currentTrigger.element).not.toHaveAttribute("aria-describedby");
      expect(screen.queryByRole("tooltip")).toBeNull();
    }

    dispatchWithHandlers(currentTrigger, [
      replayTrigger.click,
      currentTrigger.click,
      currentTrigger.click,
    ]);

    expect(screen.getByTestId("notifications-popover")).toBeVisible();
    expect(currentTrigger.element).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("rejects restored non-tooltip attributes without poisoning the successor", () => {
    const state = { ...EMPTY, items: [ITEM], unreadCount: 1, loaded: true };
    createBellRoot(state, { onOpen: vi.fn() });
    const staleTrigger = captureControl(screen.getByTestId("notifications-bell"));

    staleTrigger.element.dataset.unrelated = "changed";
    delete staleTrigger.element.dataset.unrelated;
    fireEvent.click(staleTrigger.element);
    expect(screen.queryByTestId("notifications-popover")).toBeNull();

    const currentTrigger = captureControl(screen.getByTestId("notifications-bell"));
    expect(currentTrigger.element).toBe(staleTrigger.element);
    expect(currentTrigger.click).not.toBe(staleTrigger.click);
    dispatchWithHandlers(currentTrigger, [
      staleTrigger.click,
      currentTrigger.click,
      currentTrigger.click,
    ]);
    expect(screen.getByTestId("notifications-popover")).toBeVisible();
  });

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
