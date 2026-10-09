// @vitest-environment jsdom
import { StrictMode, type ComponentProps, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { TooltipProvider } from "@/components/ui/primitives";
import type { DocumentDto } from "@/server/dto";
import type { SyncStatusDto } from "@/lib/api";

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  return {
    HocuspocusProvider: class {
      awareness: InstanceType<typeof Awareness>;
      constructor(opts: { document: Y.Doc }) {
        this.awareness = new Awareness(opts.document);
      }
      destroy() {
        this.awareness.destroy();
      }
    },
  };
});

import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { Header } from "./header";

type HeaderProps = ComponentProps<typeof Header>;
type HeaderActions = Pick<
  HeaderProps,
  "onHistory" | "onNameVersion" | "onDuplicate" | "onDelete"
>;

interface DirectView {
  host: HTMLDivElement;
  root: Root;
}

interface ReactFiber {
  return: ReactFiber | null;
  elementType?: string | { displayName?: string; name?: string };
  memoizedProps?: Record<string, unknown>;
  ref?: ((element: HTMLElement | null) => void) | { current: HTMLElement | null };
}

const DOC: DocumentDto = {
  id: "menu-document",
  title: "Menu source",
  storage: "local",
  linkAccess: "private",
  linkPreview: false,
  ownerId: "owner-1",
  gistId: null,
  gistFile: null,
  repoOwner: null,
  repoName: null,
  repoBranch: null,
  repoPath: null,
  publishedAt: null,
  hasUnpublishedChanges: false,
  githubUrl: null,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};

const sessions: CollabSession[] = [];
const views: DirectView[] = [];

function createSession(
  docId = DOC.id,
  role: CollabSession["role"] = "owner",
) {
  const session = new CollabSession({
    docId,
    user: makeCollabUser("owner-1", "Owner One", null, null),
    role,
    autoConnect: false,
    getToken: async () => {
      throw new Error("No provider connection permitted");
    },
  });
  session.keepAlive();
  session.localLoaded = true;
  session.synced = true;
  sessions.push(session);
  return session;
}

function createActions(): HeaderActions {
  return {
    onHistory: vi.fn(),
    onNameVersion: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
  };
}

function headerProps(
  session: CollabSession,
  actions: HeaderActions,
  overrides: Partial<HeaderProps> = {},
): HeaderProps {
  return {
    session,
    doc: DOC,
    commentsOpen: false,
    onToggleComments: vi.fn(),
    onOpenNotification: vi.fn(),
    onShare: vi.fn(),
    onPublish: vi.fn(),
    onPublishNow: vi.fn(),
    onPull: vi.fn(),
    onSync: vi.fn(),
    sync: null,
    onHistory: actions.onHistory,
    onMoreMenuOpen: vi.fn(),
    onActivity: vi.fn(),
    onShortcuts: vi.fn(),
    onCommandPalette: vi.fn(),
    onDelete: actions.onDelete,
    onDuplicate: actions.onDuplicate,
    onDownload: vi.fn(),
    onCopyMarkdown: vi.fn(),
    onNameVersion: actions.onNameVersion,
    documentMutation: null,
    publishing: false,
    isOwner: true,
    githubConfigured: true,
    onHome: vi.fn(),
    layout: "rich",
    onLayout: vi.fn(),
    onOutline: vi.fn(),
    compact: false,
    ...overrides,
  };
}

async function renderStrict(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const view = { host, root };
  views.push(view);
  await act(async () => {
    root.render(<StrictMode>{node}</StrictMode>);
  });
  return {
    ...view,
    render: async (next: ReactNode) => {
      await act(async () => {
        root.render(<StrictMode>{next}</StrictMode>);
      });
    },
  };
}

function header(props: HeaderProps, outside = false) {
  return (
    <TooltipProvider>
      <Header {...props} />
      {outside && <button type="button">Outside menu</button>}
    </TooltipProvider>
  );
}

function trigger() {
  return screen.getByTestId("more-menu");
}

function openMenu() {
  fireEvent(
    trigger(),
    new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    }),
  );
  return screen.getByRole("menu");
}

function item(name: MoreActionName) {
  if (name === "history") return screen.getByTestId("menu-history");
  if (name === "name-version") {
    return screen.getByRole("menuitem", { name: "Name current version" });
  }
  if (name === "duplicate") return screen.getByTestId("menu-duplicate");
  return screen.getByTestId("menu-delete");
}

type MoreActionName = "history" | "name-version" | "duplicate" | "delete";
type SelectHandler = (event: Event) => void;
type OpenHandler = (open: boolean) => void;
type EscapeHandler = (event: KeyboardEvent) => void;
type OutsideHandler = (event: CustomEvent<{ originalEvent: Event }>) => void;

function fiberFor(element: HTMLElement) {
  const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
  if (!key) throw new Error("React fiber was not attached");
  return (element as unknown as Record<string, ReactFiber>)[key]!;
}

function captureSelect(element: HTMLElement): SelectHandler {
  return captureHandler(element, "onSelect", "MenuItem");
}

function captureHandler<T>(
  element: HTMLElement,
  prop: string,
  ownerName?: string,
): T {
  let fiber: ReactFiber | null = fiberFor(element);
  while (fiber) {
    const type = fiber.elementType;
    const name = typeof type === "string" ? type : type?.displayName ?? type?.name;
    const handler = fiber.memoizedProps?.[prop];
    if ((!ownerName || name === ownerName) && typeof handler === "function") {
      return handler as T;
    }
    fiber = fiber.return;
  }
  throw new Error(`${prop} handler was not attached`);
}

function captureOpenChange() {
  return captureHandler<OpenHandler>(trigger(), "onOpenChange");
}

function captureEscape() {
  return captureHandler<EscapeHandler>(screen.getByRole("menu"), "onEscapeKeyDown", "MenuContent");
}

function captureOutside() {
  return captureHandler<OutsideHandler>(
    screen.getByRole("menu"),
    "onPointerDownOutside",
    "MenuContent",
  );
}

function captureFocusOutside() {
  return captureHandler<OutsideHandler>(
    screen.getByRole("menu"),
    "onFocusOutside",
    "MenuContent",
  );
}

function shadowEvent(event: Event, values: Readonly<Record<string, unknown>>) {
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(event, name, { configurable: true, value });
  }
}

function dispatchUnadmittedSelection(element: HTMLElement, select = captureSelect(element)) {
  const event = new CustomEvent("menu.itemSelect", {
    bubbles: true,
    cancelable: true,
  });
  element.addEventListener(
    "menu.itemSelect",
    (current) => {
      current.stopImmediatePropagation();
      select(current);
    },
    { once: true },
  );
  element.dispatchEvent(event);
  return event;
}

async function waitForOutsideListener() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function markJsdomEventTrusted(event: Event) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find(
      (candidate): candidate is { isTrusted: boolean } =>
        typeof candidate === "object"
        && candidate !== null
        && "isTrusted" in candidate
        && candidate.isTrusted === false,
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

function publishTrigger() {
  return screen.getByTestId("publish-menu") as HTMLButtonElement;
}

function publishArrow(
  key: "ArrowDown" | "ArrowUp",
  init: Omit<KeyboardEventInit, "key"> = {},
  trusted = true,
) {
  const button = publishTrigger();
  const ownerWindow = button.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The Publish trigger has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    key,
    ...init,
  });
  if (trusted) markJsdomEventTrusted(event);
  act(() => button.dispatchEvent(event));
  return event;
}

type PublishKeyEvent = React.KeyboardEvent<HTMLButtonElement>;
type PublishKeyHandler = (event: unknown) => void;
type PublishPhase = "capture" | "bubble";
type PublishBoundary = "captureTrigger" | "captureBoundary" | "bubbleTrigger" | "bubbleBoundary";
type PublishWrapperShape = "plain" | "null" | "unrelated" | "getters" | "proxy";

function publishKeyHandlers(button = publishTrigger()) {
  type PublishFiber = ReactFiber & {
    child?: PublishFiber | null;
    sibling?: PublishFiber | null;
    stateNode?: unknown;
  };
  let root: PublishFiber = fiberFor(button);
  while (root.return) root = root.return;
  const current = (root.stateNode as { current: PublishFiber }).current;
  function find(
    fiber: PublishFiber,
    owner: Record<string, unknown> | null = null,
  ): Record<string, unknown> | null {
    if (
      typeof fiber.elementType !== "string"
      && fiber.elementType?.name === "PublishMenuTriggerButton"
    ) {
      owner = fiber.memoizedProps ?? null;
    }
    if (fiber.stateNode === button) return owner;
    for (let child = fiber.child; child; child = child.sibling) {
      const found = find(child, owner);
      if (found) return found;
    }
    return null;
  }
  const props = find(current);
  if (!props) throw new Error("Current Publish trigger component was not attached");
  const handler = (property: string) => {
    const callback = props[property];
    if (typeof callback !== "function") throw new Error(`Publish ${property} was not attached`);
    return callback as PublishKeyHandler;
  };
  return {
    captureTrigger: handler("onDirectionalKeyDownCapture"),
    captureBoundary: handler("onKeyDownCapture"),
    bubbleTrigger: handler("onDirectionalTriggerKeyDown"),
    bubbleBoundary: handler("onDirectionalKeyDown"),
  };
}

function interceptPublishKeys(
  callback: (event: PublishKeyEvent, phase: PublishPhase, original: PublishKeyHandler) => void,
  button = publishTrigger(),
) {
  const key = Object.keys(button).find((name) => name.startsWith("__reactProps$"));
  if (!key) throw new Error("Publish trigger React props were not attached");
  const record = button as unknown as Record<string, Record<string, unknown>>;
  const props = record[key]!;
  const intercepted = { ...props };
  for (const [property, phase] of [
    ["onKeyDownCapture", "capture"],
    ["onKeyDown", "bubble"],
  ] as const) {
    const original = props[property];
    if (typeof original !== "function") throw new Error(`Publish ${property} was not attached`);
    intercepted[property] = (event: PublishKeyEvent) =>
      callback(event, phase, original as PublishKeyHandler);
  }
  record[key] = intercepted;
  return () => {
    if (record[key] === intercepted) record[key] = props;
  };
}

function publicPublishWrapper(
  source: PublishKeyEvent,
  shape: PublishWrapperShape = "plain",
  compatibility: "absent" | "throwing" = "absent",
) {
  const prototype = shape === "plain"
    ? Object.prototype
    : shape === "unrelated" ? { unrelated: true } : null;
  const event: Record<string, unknown> = shape === "proxy"
    ? new Proxy({}, {}) : Object.create(prototype);
  const values: Record<string, unknown> = {};
  const set = (name: string, value: unknown) => {
    values[name] = value;
    Object.defineProperty(event, name, shape === "getters"
      ? { configurable: true, enumerable: true, get: () => values[name] }
      : { configurable: true, enumerable: true, writable: true, value });
  };
  for (const name of [
    "nativeEvent", "type", "target", "currentTarget", "eventPhase", "bubbles",
    "cancelable", "defaultPrevented", "isTrusted", "timeStamp", "key", "code",
    "location", "altKey", "ctrlKey", "metaKey", "shiftKey", "repeat", "detail", "view",
  ] as const) {
    set(name, source[name]);
  }
  const methods = {
    preventDefault: vi.fn(function (this: object) {
      expect(this).toBe(event);
      source.nativeEvent.preventDefault();
      set("defaultPrevented", true);
      set("isDefaultPrevented", preventedQuery);
    }),
    isDefaultPrevented: vi.fn(function (this: object) {
      expect(this).toBe(event);
      return values.defaultPrevented;
    }),
    isPropagationStopped: vi.fn(function (this: object) {
      expect(this).toBe(event);
      return false;
    }),
  };
  const preventedQuery = vi.fn(function (this: object) {
    expect(this).toBe(event);
    return true;
  });
  for (const [name, method] of Object.entries(methods)) set(name, method);
  const optionalRead = vi.fn(() => { throw new Error("Optional/private wrapper property read"); });
  if (compatibility === "throwing") {
    for (const name of [
      "stopPropagation", "persist", "isPersistent", "constructor", "_reactName",
      "_targetInst", "_reactInternals", "isComposing",
    ]) {
      Object.defineProperty(event, name, { configurable: true, get: optionalRead });
    }
  }
  return { event, set, methods, preventedQuery, optionalRead };
}

type PublicPublishWrapper = ReturnType<typeof publicPublishWrapper>;

function publishKeyMeasurements() {
  const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
  const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
  const dispatchEvent = vi.spyOn(window.EventTarget.prototype, "dispatchEvent");
  return { preventDefault, focus, dispatchEvent };
}

function expectNoPublishActions(props: HeaderProps) {
  for (const action of [
    props.onPublish, props.onPublishNow, props.onPull, props.onSync,
    props.onDownload, props.onShare, props.onHistory, props.onDelete,
  ]) {
    expect(action).not.toHaveBeenCalled();
  }
  expect(window.open).not.toHaveBeenCalled();
}

function expectPublishRejected(
  props: HeaderProps,
  measurements: ReturnType<typeof publishKeyMeasurements>,
  event: Event,
  preventionCount = 0,
) {
  expect(measurements.preventDefault.mock.contexts.filter((receiver) => receiver === event))
    .toHaveLength(preventionCount);
  expect(event.defaultPrevented).toBe(preventionCount === 1);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(measurements.focus).not.toHaveBeenCalled();
  expectNoPublishActions(props);
}

async function expectPublishAccepted(
  props: HeaderProps,
  measurements: ReturnType<typeof publishKeyMeasurements>,
  event: Event,
  destination = "Gist or repository…",
) {
  expect(event.defaultPrevented).toBe(true);
  expect(measurements.preventDefault.mock.contexts.filter((receiver) => receiver === event))
    .toHaveLength(1);
  await waitFor(() => expect(screen.getByRole("menuitem", { name: destination })).toHaveFocus());
  expect(screen.getAllByRole("menu")).toHaveLength(1);
  expect(publishTrigger()).toHaveAttribute("aria-expanded", "true");
  expect(measurements.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  expect(measurements.focus.mock.contexts[0])
    .toBe(screen.getByRole("menuitem", { name: destination }));
  const autoFocus = measurements.dispatchEvent.mock.calls.flatMap(
    (args, index) => args[0].type === "focusScope.autoFocusOnMount"
      && measurements.dispatchEvent.mock.contexts[index] === screen.getByRole("menu")
      ? [args[0]] : [],
  );
  expect(autoFocus).toHaveLength(1);
  expect(autoFocus[0]!.defaultPrevented).toBe(true);
  expect(measurements.preventDefault.mock.contexts.filter((receiver) => receiver === autoFocus[0]))
    .toHaveLength(1);
  expectNoPublishActions(props);
}

function linkedDocument(
  githubUrl: string | null = "https://github.com/o/r/blob/main/doc.md",
): DocumentDto {
  return {
    ...DOC,
    storage: "repo",
    repoOwner: "o",
    repoName: "r",
    repoBranch: "main",
    repoPath: "doc.md",
    publishedAt: "2026-09-08T01:00:00.000Z",
    githubUrl,
  };
}

function syncStatus(status: SyncStatusDto["status"] = "in-sync"): SyncStatusDto {
  return {
    status,
    remote: {
      sha: "abc123",
      revision: "abc123",
      url: "https://github.com/o/r/blob/main/doc.md",
      updatedAt: null,
    },
    localChanged: false,
    remoteChanged: status === "remote-unreadable",
    lines: { local: 0, remote: 0 },
    ...(status === "remote-unreadable"
      ? { size: 3_000_000, limit: 2_097_152 }
      : {}),
  };
}

beforeEach(() => {
  vi.spyOn(window, "open").mockImplementation(() => null);
  const eventTargetAdd = EventTarget.prototype.addEventListener;
  const eventTargetRemove = EventTarget.prototype.removeEventListener;
  const windowAdd = window.addEventListener;
  const windowRemove = window.removeEventListener;
  // jsdom's Window methods do not delegate through EventTarget.prototype.
  vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(
    function (this: EventTarget, type, callback, options) {
      if (callback === null) return;
      if (this === window) windowAdd.call(window, type, callback, options);
      else eventTargetAdd.call(this, type, callback, options);
    },
  );
  vi.spyOn(EventTarget.prototype, "removeEventListener").mockImplementation(
    function (this: EventTarget, type, callback, options) {
      if (callback === null) return;
      if (this === window) windowRemove.call(window, type, callback, options);
      else eventTargetRemove.call(this, type, callback, options);
    },
  );
});

afterEach(async () => {
  for (const view of views.splice(0)) {
    await act(async () => view.root.unmount());
    view.host.remove();
  }
  for (const session of sessions.splice(0)) session.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("editor header More menu authority", () => {
  it("keeps genuine selection usable after a pre-mount body decoy", async () => {
    const session = createSession();
    const actions = createActions();
    let history: HTMLElement | null = null;
    document.body.addEventListener("click", (event) => {
      if (!history || event.target !== history) return;
      history.dispatchEvent(new CustomEvent("menu.itemSelect", {
        bubbles: true,
        cancelable: true,
      }));
    }, { once: true });
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    history = item("history");

    fireEvent.click(history);

    expect(actions.onHistory).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the exact native selection through a mid-dispatch microtask checkpoint", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const history = item("history");
    vi.useFakeTimers({ toFake: ["queueMicrotask"] });
    history.addEventListener("click", () => {
      vi.runAllTicks();
    }, { capture: true, once: true });

    try {
      fireEvent.click(history);
    } finally {
      vi.runAllTicks();
      vi.useRealTimers();
    }

    expect(actions.onHistory).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("retires unconsumed selection authority at the native window boundary", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const history = item("history");
    const staleSelect = captureSelect(history);
    history.addEventListener("click", (event) => event.preventDefault(), { once: true });

    fireEvent.click(history);
    act(() => dispatchUnadmittedSelection(history, staleSelect));

    expect(actions.onHistory).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(history);
    expect(actions.onHistory).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each([
    ["history", "onHistory"],
    ["name-version", "onNameVersion"],
    ["duplicate", "onDuplicate"],
    ["delete", "onDelete"],
  ] as const)("runs the current %s action exactly once through direct-root Strict Mode", async (name, callback) => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    const menuTrigger = trigger();
    menuTrigger.focus();

    openMenu();
    await userEvent.click(item(name));

    expect(actions[callback]).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(menuTrigger).toHaveFocus());
  });

  it("preserves the realm CustomEvent constructor and restores item dispatch", async () => {
    const session = createSession();
    const actions = createActions();
    const CustomEventConstructor = window.CustomEvent;
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const history = item("history");

    expect(window.CustomEvent).toBe(CustomEventConstructor);
    fireEvent.click(history);

    expect(history.dispatchEvent).toBe(EventTarget.prototype.dispatchEvent);
  });

  it("fails closed when a current item becomes non-extensible before replacement", async () => {
    const session = createSession();
    const actions = createActions();
    const props = headerProps(session, actions);
    const view = await renderStrict(header(props));
    openMenu();
    const history = item("history");
    Object.preventExtensions(history);

    await view.render(header({ ...props, commentsOpen: true }));

    fireEvent.click(history);
    fireEvent.click(item("history"));
    expect(actions.onHistory).not.toHaveBeenCalled();
  });

  it("fails closed when an owned item is non-extensible before publication", async () => {
    const nativeSetAttribute = Element.prototype.setAttribute;
    const setAttribute = vi.spyOn(Element.prototype, "setAttribute").mockImplementation(
      function (this: Element, name: string, value: string) {
        Reflect.apply(nativeSetAttribute, this, [name, value]);
        if (name === "data-testid" && value === "menu-history") {
          void this.attributes;
          void this.children;
          void this.childNodes;
          void this.classList;
          void (this as HTMLElement).dataset;
          void (this as HTMLElement).style;
          Object.preventExtensions(this);
        }
      },
    );
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));

    openMenu();
    setAttribute.mockRestore();
    fireEvent.click(item("history"));

    expect(actions.onHistory).not.toHaveBeenCalled();
  });

  it("restores a fresh item's exact dispatch descriptor after selection", async () => {
    const nativeSetAttribute = Element.prototype.setAttribute;
    const originalDispatch = function (this: EventTarget, event: Event) {
      return Reflect.apply(EventTarget.prototype.dispatchEvent, this, [event]) as boolean;
    };
    const originalDescriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: true,
      value: originalDispatch,
      writable: false,
    };
    const setAttribute = vi.spyOn(Element.prototype, "setAttribute").mockImplementation(
      function (this: Element, name: string, value: string) {
        Reflect.apply(nativeSetAttribute, this, [name, value]);
        if (name === "data-testid" && value === "menu-history") {
          Object.defineProperty(this, "dispatchEvent", originalDescriptor);
        }
      },
    );
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    setAttribute.mockRestore();
    const history = item("history");

    fireEvent.click(history);

    expect(actions.onHistory).toHaveBeenCalledOnce();
    expect(Object.getOwnPropertyDescriptor(history, "dispatchEvent")).toEqual(originalDescriptor);
  });

  it("does not overwrite a same-value foreign dispatch descriptor", async () => {
    const session = createSession();
    const actions = createActions();
    const props = headerProps(session, actions);
    const view = await renderStrict(header(props));
    openMenu();
    const history = item("history");
    const foreignDescriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: true,
      value: history.dispatchEvent,
      writable: false,
    };
    Object.defineProperty(history, "dispatchEvent", foreignDescriptor);

    await view.render(header({ ...props, commentsOpen: true }));

    expect(Object.getOwnPropertyDescriptor(history, "dispatchEvent")).toEqual(foreignDescriptor);
    fireEvent.click(history);
    fireEvent.click(item("history"));
    expect(actions.onHistory).not.toHaveBeenCalled();

    await view.render(<div key="fresh">{header(props)}</div>);
    openMenu();
    const freshHistory = item("history");
    expect(freshHistory).not.toBe(history);
    fireEvent.click(freshHistory);
    expect(actions.onHistory).toHaveBeenCalledOnce();
  });

  it("treats a foreign deletion before first cleanup as unsafe", async () => {
    const session = createSession();
    const actions = createActions();
    const props = headerProps(session, actions);
    const view = await renderStrict(header(props));
    openMenu();
    const history = item("history");
    expect(Object.prototype.hasOwnProperty.call(history, "dispatchEvent")).toBe(true);
    Reflect.deleteProperty(history, "dispatchEvent");

    await view.render(header({ ...props, commentsOpen: true }));

    expect(Object.getOwnPropertyDescriptor(history, "dispatchEvent")).toBeUndefined();
    fireEvent.click(history);
    fireEvent.click(item("history"));
    expect(actions.onHistory).not.toHaveBeenCalled();
  });

  it.each(["data", "accessor"] as const)(
    "treats a foreign restoration of the original own %s descriptor as unsafe",
    async (kind) => {
      const nativeSetAttribute = Element.prototype.setAttribute;
      const originalDispatch = function (this: EventTarget, event: Event) {
        return Reflect.apply(EventTarget.prototype.dispatchEvent, this, [event]) as boolean;
      };
      const originalDescriptor: PropertyDescriptor = kind === "data"
        ? {
            configurable: true,
            enumerable: true,
            value: originalDispatch,
            writable: false,
          }
        : {
            configurable: true,
            enumerable: true,
            get: () => originalDispatch,
          };
      const setAttribute = vi.spyOn(Element.prototype, "setAttribute").mockImplementation(
        function (this: Element, name: string, value: string) {
          Reflect.apply(nativeSetAttribute, this, [name, value]);
          if (name === "data-testid" && value === "menu-history") {
            Object.defineProperty(this, "dispatchEvent", originalDescriptor);
          }
        },
      );
      const session = createSession();
      const actions = createActions();
      const props = headerProps(session, actions);
      const view = await renderStrict(header(props));
      openMenu();
      setAttribute.mockRestore();
      const history = item("history");
      Object.defineProperty(history, "dispatchEvent", originalDescriptor);

      await view.render(header({ ...props, commentsOpen: true }));

      expect(Object.getOwnPropertyDescriptor(history, "dispatchEvent")).toEqual(
        originalDescriptor,
      );
      fireEvent.click(history);
      fireEvent.click(item("history"));
      expect(actions.onHistory).not.toHaveBeenCalled();
    },
  );

  it("treats foreign deletion of an outside-target observer as unsafe", async () => {
    const session = createSession();
    const actions = createActions();
    const props = headerProps(session, actions);
    let outside: HTMLElement | null = null;
    const deleteObserver = (event: PointerEvent) => {
      if (!outside || event.target !== outside) return;
      document.removeEventListener("pointerdown", deleteObserver);
      Reflect.deleteProperty(outside, "dispatchEvent");
    };
    document.addEventListener("pointerdown", deleteObserver);
    const view = await renderStrict(header(props, true));
    const outsideElement = screen.getByRole("button", { name: "Outside menu" });
    outside = outsideElement;
    openMenu();
    item("history").focus();
    await waitForOutsideListener();

    fireEvent.pointerDown(outsideElement, { button: 0, pointerType: "mouse" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(Object.getOwnPropertyDescriptor(outsideElement, "dispatchEvent")).toBeUndefined();
    await view.render(header({ ...props, commentsOpen: true }, true));
    await waitForOutsideListener();
    fireEvent.pointerDown(outsideElement, { button: 0, pointerType: "mouse" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("keeps a successor wrapper after its predecessor restores itself", async () => {
    const session = createSession();
    const actions = createActions();
    const props = headerProps(session, actions);
    const view = await renderStrict(header(props));
    openMenu();
    const history = item("history");
    const firstWrapper = history.dispatchEvent;

    await view.render(header({ ...props, commentsOpen: true }));
    const successorWrapper = history.dispatchEvent;
    expect(successorWrapper).not.toBe(firstWrapper);
    await act(async () => Promise.resolve());
    expect(history.dispatchEvent).toBe(successorWrapper);

    fireEvent.click(history);
    expect(actions.onHistory).toHaveBeenCalledOnce();
    expect(history.dispatchEvent).toBe(EventTarget.prototype.dispatchEvent);
  });

  it("rejects unadmitted and repeated custom selection without consuming a fresh action", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const history = item("history");
    const select = captureSelect(history);

    act(() => {
      dispatchUnadmittedSelection(history, select);
      dispatchUnadmittedSelection(history, select);
    });
    expect(actions.onHistory).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(history);
    act(() => dispatchUnadmittedSelection(history, select));
    expect(actions.onHistory).toHaveBeenCalledOnce();
  });

  it("rejects a canceled owned click replay before callback or delete confirmation", async () => {
    const session = createSession();
    const actions = createActions();
    const confirmDelete = vi.spyOn(window, "confirm").mockReturnValue(false);
    actions.onDelete = vi.fn(() => {
      confirm(`Move “${DOC.title}” to trash? You can restore it from the dashboard for 30 days.`);
    });
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const deleteItem = item("delete");
    const select = captureSelect(deleteItem);
    const canceledClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    deleteItem.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true, once: true });

    act(() => {
      deleteItem.dispatchEvent(canceledClick);
      shadowEvent(canceledClick, {
        currentTarget: document.body,
        defaultPrevented: false,
        eventPhase: Event.BUBBLING_PHASE,
        target: deleteItem,
        composedPath: () => [
          deleteItem,
          screen.getByRole("menu"),
          document.body,
          document.documentElement,
          document,
          window,
        ],
      });
      dispatchUnadmittedSelection(deleteItem, select);
    });
    expect(actions.onDelete).not.toHaveBeenCalled();
    expect(confirmDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(deleteItem);
    expect(actions.onDelete).toHaveBeenCalledOnce();
    expect(confirmDelete).toHaveBeenCalledOnce();
  });

  it("rejects nested selection from a pre-mount window interceptor", async () => {
    const session = createSession();
    const actions = createActions();
    const confirmDelete = vi.spyOn(window, "confirm").mockReturnValue(false);
    actions.onDelete = vi.fn(() => {
      confirm(`Move “${DOC.title}” to trash? You can restore it from the dashboard for 30 days.`);
    });
    let deleteItem: HTMLElement | null = null;
    let decoy: CustomEvent | null = null;
    window.addEventListener("menu.itemSelect", (event) => {
      if (!deleteItem || !decoy || event.target !== deleteItem) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      deleteItem.dispatchEvent(decoy);
    }, { capture: true, once: true });
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    deleteItem = item("delete");
    deleteItem.addEventListener("click", () => {
      decoy = new CustomEvent("menu.itemSelect", {
        bubbles: true,
        cancelable: true,
      });
    }, { capture: true, once: true });

    fireEvent.click(deleteItem);
    expect(actions.onDelete).not.toHaveBeenCalled();
    expect(confirmDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(deleteItem);
    expect(actions.onDelete).toHaveBeenCalledOnce();
    expect(confirmDelete).toHaveBeenCalledOnce();
  });

  it("rejects plain and prototype-only public event shells without throwing", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const history = item("history");
    const select = captureSelect(history);
    const plainShell = {
      type: "menu.itemSelect",
      target: history,
      currentTarget: history,
      eventPhase: Event.AT_TARGET,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      detail: null,
      composedPath: () => [history, screen.getByRole("menu"), document.body, document],
    } as unknown as Event;
    const prototypeShell = Object.create(CustomEvent.prototype) as Event;

    act(() => {
      select(plainShell);
      select(prototypeShell);
    });
    expect(actions.onHistory).not.toHaveBeenCalled();

    fireEvent.click(history);
    expect(actions.onHistory).toHaveBeenCalledOnce();
  });

  it("rejects a crossed custom selection admitted by another action's native click", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const history = item("history");
    const duplicate = item("duplicate");
    const selectDuplicate = captureSelect(duplicate);

    history.addEventListener("click", (event) => {
      event.stopImmediatePropagation();
      dispatchUnadmittedSelection(duplicate, selectDuplicate);
    }, { capture: true, once: true });
    act(() => {
      history.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }));
    });

    expect(actions.onHistory).not.toHaveBeenCalled();
    expect(actions.onDuplicate).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(history);
    expect(actions.onHistory).toHaveBeenCalledOnce();
  });

  it("retires a partial item-ref replay without consuming its complete successor", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const history = item("history");
    const staleSelect = captureSelect(history);
    const ref = fiberFor(history).ref;
    if (typeof ref !== "function") throw new Error("History callback ref was not attached");

    act(() => {
      ref(null);
      ref(history);
      dispatchUnadmittedSelection(history, staleSelect);
    });
    expect(actions.onHistory).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await waitFor(() => expect(item("history")).toBe(history));
    fireEvent.click(history);
    expect(actions.onHistory).toHaveBeenCalledOnce();
  });

  it.each(["attribute", "order", "item", "portal", "portal-ancestor", "placement"] as const)(
    "permanently retires restored %s mutation history and keeps a reopened successor usable",
    async (mutation) => {
      const session = createSession();
      const actions = createActions();
      await renderStrict(header(headerProps(session, actions)));
      const content = openMenu();
      const history = item("history");

      act(() => {
        if (mutation === "attribute") {
          history.setAttribute("role", "option");
          history.setAttribute("role", "menuitem");
        } else if (mutation === "order") {
          const successor = history.nextSibling!;
          content.insertBefore(successor, history);
          content.insertBefore(history, successor);
        } else if (mutation === "item") {
          const parent = history.parentNode!;
          const successor = history.nextSibling;
          parent.removeChild(history);
          parent.insertBefore(history, successor);
        } else if (mutation === "portal") {
          const parent = content.parentNode!;
          parent.removeChild(content);
          parent.appendChild(content);
        } else if (mutation === "portal-ancestor") {
          const portal = content.parentNode!;
          const parent = portal.parentNode!;
          parent.removeChild(portal);
          parent.appendChild(portal);
        } else {
          const parent = content.parentNode!;
          const sibling = document.createElement("div");
          parent.insertBefore(sibling, content);
          sibling.remove();
        }
      });
      fireEvent.click(history);
      expect(actions.onHistory).not.toHaveBeenCalled();

      await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
      fireEvent.click(item("history"));
      expect(actions.onHistory).toHaveBeenCalledOnce();
      expect(screen.queryByRole("menu")).toBeNull();
    },
  );

  it("retires stale document and callback actions while preserving the current document", async () => {
    const firstSession = createSession();
    const first = createActions();
    const view = await renderStrict(header(headerProps(firstSession, first)));
    openMenu();
    const staleHistoryElement = item("history");
    const staleHistory = captureSelect(staleHistoryElement);

    const nextDoc = { ...DOC, id: "next-document", title: "Next source" };
    const nextSession = createSession(nextDoc.id);
    const next = createActions();
    await view.render(header(headerProps(nextSession, next, { doc: nextDoc })));
    act(() => dispatchUnadmittedSelection(staleHistoryElement, staleHistory));
    expect(first.onHistory).not.toHaveBeenCalled();
    expect(next.onHistory).not.toHaveBeenCalled();

    openMenu();
    fireEvent.click(item("history"));
    expect(next.onHistory).toHaveBeenCalledOnce();
  });

  it("rejects document and permission drift without closing or invoking the stale action", async () => {
    const session = createSession();
    const actions = createActions();
    const doc = { ...DOC };
    await renderStrict(header(headerProps(session, actions, { doc })));
    openMenu();

    doc.title = "Mutated source";
    fireEvent.click(item("history"));
    expect(actions.onHistory).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    doc.title = DOC.title;

    Object.defineProperty(session, "role", { configurable: true, value: "viewer" });
    fireEvent.click(item("name-version"));
    expect(actions.onNameVersion).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    Object.defineProperty(session, "role", { configurable: true, value: "owner" });

    fireEvent.click(item("history"));
    expect(actions.onHistory).toHaveBeenCalledOnce();
  });

  it("keeps conditional permissions, disabled mutations, labels, classes, and icons exact", async () => {
    const viewer = createSession(DOC.id, "viewer");
    const actions = createActions();
    const view = await renderStrict(
      header(headerProps(viewer, actions, {
        isOwner: false,
        documentMutation: "duplicate",
      })),
    );
    openMenu();

    expect(screen.queryByRole("menuitem", { name: "Name current version" })).toBeNull();
    expect(screen.queryByTestId("menu-delete")).toBeNull();
    expect(item("history")).toHaveTextContent("Version history");
    expect(item("history").querySelector(".lucide-rotate-ccw-clock")).not.toBeNull();
    expect(item("duplicate")).toHaveTextContent("Making a copy…");
    expect(item("duplicate")).toHaveClass("menu-item");
    expect(item("duplicate")).toHaveAttribute("aria-disabled", "true");
    expect(item("duplicate")).toHaveAttribute("aria-busy", "true");
    expect(item("duplicate").querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(item("duplicate"));
    expect(actions.onDuplicate).not.toHaveBeenCalled();

    fireEvent.keyDown(item("history"), { key: "Escape" });
    const owner = createSession();
    await view.render(header(headerProps(owner, actions)));
    openMenu();
    expect(item("delete")).toHaveClass("menu-item", "text-danger");
    expect(item("delete").querySelector(".lucide-trash-2")).not.toBeNull();
  });

  it("preserves keyboard selection, Escape, outside dismissal, and focus return", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions), true));
    const menuTrigger = trigger();
    const outside = screen.getByRole("button", { name: "Outside menu" });

    menuTrigger.focus();
    fireEvent.keyDown(menuTrigger, { key: "ArrowDown" });
    await waitFor(() => expect(item("history")).toHaveFocus());
    await userEvent.keyboard("{Enter}");
    expect(actions.onHistory).toHaveBeenCalledOnce();
    await waitFor(() => expect(menuTrigger).toHaveFocus());

    openMenu();
    fireEvent.keyDown(item("history"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(menuTrigger).toHaveFocus());

    openMenu();
    await waitForOutsideListener();
    fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("preserves close and focus behavior for existing unowned items and window blur", async () => {
    const session = createSession();
    const actions = createActions();
    const onActivity = vi.fn();
    await renderStrict(header(headerProps(session, actions, { onActivity })));
    const menuTrigger = trigger();
    menuTrigger.focus();

    openMenu();
    fireEvent.click(screen.getByTestId("menu-activity"));
    expect(onActivity).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(menuTrigger).toHaveFocus());

    openMenu();
    fireEvent(window, new Event("blur"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("closes generic selections that synchronously change header facts", async () => {
    const activitySession = createSession();
    const activityActions = createActions();
    const activity = vi.fn();
    const baseProps = headerProps(activitySession, activityActions);
    function ActivityHeader() {
      const [commentsOpen, setCommentsOpen] = useState(true);
      return (
        <Header
          {...baseProps}
          commentsOpen={commentsOpen}
          onActivity={() => {
            activity();
            setCommentsOpen(false);
          }}
        />
      );
    }
    await renderStrict(
      <TooltipProvider>
        <ActivityHeader />
      </TooltipProvider>,
    );

    openMenu();
    fireEvent.click(screen.getByTestId("menu-activity"));
    expect(activity).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  // Basic coverage for the #2203 plain-select close path, not a regression guard: fireEvent.click
  // dispatches synchronously from script, the same way Radix's Enter handling does, so these pass
  // against main's unmodified header.tsx too - jsdom can't reproduce the real (trusted) mouse
  // click's async timing that actually causes the menu to stay open. The regression guards are
  // the mouse-driven e2e/reader.spec.ts:182 test and the e2e/prod-smoke.spec.ts "Open reader view"
  // test, both of which fail against main's header.tsx and pass against this PR's.
  it("closes before opening the reader view in a new tab (basic coverage)", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    const menuTrigger = trigger();
    menuTrigger.focus();

    openMenu();
    fireEvent.click(screen.getByTestId("menu-reader"));
    expect(window.open).toHaveBeenCalledWith(`/p/${DOC.id}`, "_blank", "noopener");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("closes before opening a linked document's GitHub URL in a new tab (basic coverage)", async () => {
    const session = createSession();
    const actions = createActions();
    const linkedDoc: DocumentDto = {
      ...DOC,
      storage: "repo",
      repoOwner: "o",
      repoName: "r",
      repoBranch: "main",
      repoPath: "doc.md",
      githubUrl: "https://github.com/o/r/blob/main/doc.md",
    };
    await renderStrict(header(headerProps(session, actions, { doc: linkedDoc })));
    const menuTrigger = trigger();
    menuTrigger.focus();

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open on GitHub" }));
    expect(window.open).toHaveBeenCalledWith(linkedDoc.githubUrl, "_blank", "noopener");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("closes the Publish menu's own Open on GitHub item before opening the URL (basic coverage; Publish's onOpenChange close path was never affected by #2203)", async () => {
    const doc = linkedDocument();
    const props = headerProps(createSession(doc.id, "viewer"), createActions(), {
      doc,
      sync: syncStatus(),
      isOwner: false,
    });
    await renderStrict(header(props));
    const menuTrigger = publishTrigger();
    menuTrigger.focus();

    fireEvent(
      menuTrigger,
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        ctrlKey: false,
        pointerType: "mouse",
      }),
    );
    await screen.findByRole("menu");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open on GitHub" }));
    expect(window.open).toHaveBeenCalledWith(doc.githubUrl, "_blank", "noopener");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("closes a compact Mode selection that changes the current session mode", async () => {
    const session = createSession();
    const actions = createActions();
    const setMode = vi.spyOn(session, "setMode");
    await renderStrict(header(headerProps(session, actions, { compact: true })));
    const menuTrigger = trigger();
    menuTrigger.focus();
    fireEvent.keyDown(menuTrigger, { key: "ArrowDown" });
    const viewing = await screen.findByRole("menuitemradio", { name: /Viewing/ });
    viewing.focus();

    await userEvent.keyboard("{Enter}");
    expect(setMode).toHaveBeenCalledExactlyOnceWith("viewing");
    expect(session.mode).toBe("viewing");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(menuTrigger).toHaveFocus());
  });

  it("rejects a canceled Escape with valid-looking own event fields", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    const handlers: {
      escape: EscapeHandler | null;
      close: OpenHandler | null;
    } = { escape: null, close: null };
    const intercept = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      document.removeEventListener("keydown", intercept, { capture: true });
      event.preventDefault();
      event.stopImmediatePropagation();
      shadowEvent(event, {
        currentTarget: document,
        defaultPrevented: false,
        eventPhase: Event.CAPTURING_PHASE,
        composedPath: () => [
          event.target,
          screen.getByRole("menu"),
          document.body,
          document.documentElement,
          document,
          window,
        ],
      });
      if (!handlers.escape || !handlers.close) throw new Error("Escape handlers were not captured");
      handlers.escape(event);
      handlers.close(false);
    };
    document.addEventListener("keydown", intercept, { capture: true });
    openMenu();
    const history = item("history");
    history.focus();
    handlers.escape = captureEscape();
    handlers.close = captureOpenChange();

    fireEvent.keyDown(history, { key: "Escape" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(history).toHaveFocus();

    fireEvent.keyDown(history, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it.each(["pointer", "focus"] as const)(
    "rejects canceled poisoned %s-outside dismissal and keeps a fresh dismissal usable",
    async (family) => {
      const session = createSession();
      const actions = createActions();
      await renderStrict(header(headerProps(session, actions), true));
      const outside = screen.getByRole("button", { name: "Outside menu" });
      const handlers: {
        outside: OutsideHandler | null;
        close: OpenHandler | null;
      } = { outside: null, close: null };
      const eventName = family === "pointer" ? "pointerdown" : "focusin";
      const intercept = (event: Event) => {
        if (event.target !== outside) return;
        document.removeEventListener(eventName, intercept);
        event.stopImmediatePropagation();
        if (family === "pointer") {
          event.preventDefault();
          shadowEvent(event, { defaultPrevented: false });
        }
        const outsideEvent = new CustomEvent(
          family === "pointer"
            ? "dismissableLayer.pointerDownOutside"
            : "dismissableLayer.focusOutside",
          {
            bubbles: false,
            cancelable: true,
            detail: { originalEvent: event },
          },
        );
        outside.addEventListener(outsideEvent.type, (current) => {
          current.stopImmediatePropagation();
          if (family === "focus") {
            current.preventDefault();
            shadowEvent(current, { defaultPrevented: false });
          }
          if (!handlers.outside || !handlers.close) {
            throw new Error("Outside handlers were not captured");
          }
          handlers.outside(current as CustomEvent<{ originalEvent: Event }>);
          handlers.close(false);
        }, { once: true });
        outside.dispatchEvent(outsideEvent);
      };
      document.addEventListener(eventName, intercept);
      openMenu();
      const history = item("history");
      history.focus();
      handlers.outside = family === "pointer" ? captureOutside() : captureFocusOutside();
      handlers.close = captureOpenChange();
      if (family === "pointer") await waitForOutsideListener();

      if (family === "pointer") {
        fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
      } else {
        outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      }
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(history).toHaveFocus();

      if (family === "pointer") {
        await waitForOutsideListener();
        fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
      } else {
        const freshIntercept = (event: FocusEvent) => {
          if (event.target !== outside) return;
          document.removeEventListener("focusin", freshIntercept);
          event.stopImmediatePropagation();
          const freshOutside = new CustomEvent("dismissableLayer.focusOutside", {
            bubbles: false,
            cancelable: true,
            detail: { originalEvent: event },
          });
          outside.addEventListener(freshOutside.type, (current) => {
            current.stopImmediatePropagation();
            if (!handlers.outside || !handlers.close) {
              throw new Error("Outside handlers were not captured");
            }
            handlers.outside(current as CustomEvent<{ originalEvent: Event }>);
            handlers.close(false);
          }, { once: true });
          outside.dispatchEvent(freshOutside);
        };
        document.addEventListener("focusin", freshIntercept);
        outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      }
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    },
  );

  it("rejects nested pointer-outside from a pre-mount window interceptor", async () => {
    const session = createSession();
    const actions = createActions();
    let outside: HTMLElement | null = null;
    window.addEventListener("dismissableLayer.pointerDownOutside", (event) => {
      if (!outside || event.target !== outside) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const originalEvent = (event as CustomEvent<{ originalEvent: Event }>).detail.originalEvent;
      outside.dispatchEvent(new CustomEvent("dismissableLayer.pointerDownOutside", {
        bubbles: false,
        cancelable: true,
        detail: { originalEvent },
      }));
    }, { capture: true, once: true });
    await renderStrict(header(headerProps(session, actions), true));
    outside = screen.getByRole("button", { name: "Outside menu" });
    openMenu();
    const history = item("history");
    history.focus();
    await waitForOutsideListener();

    fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(history).toHaveFocus();

    await waitForOutsideListener();
    fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it.each(["pointer", "focus"] as const)(
    "accepts its own %s-outside event after another layer's event for the same native event",
    async (family) => {
      const session = createSession();
      const actions = createActions();
      await renderStrict(header(headerProps(session, actions), true));
      const outside = screen.getByRole("button", { name: "Outside menu" });
      const eventName = family === "pointer" ? "pointerdown" : "focusin";
      const handlers: {
        outside: OutsideHandler | null;
        close: OpenHandler | null;
      } = { outside: null, close: null };
      const injectForeignLayerEvent = (originalEvent: Event) => {
        if (originalEvent.target !== outside) return;
        document.removeEventListener(eventName, injectForeignLayerEvent);
        outside.dispatchEvent(new CustomEvent(
          family === "pointer"
            ? "dismissableLayer.pointerDownOutside"
            : "dismissableLayer.focusOutside",
          {
            bubbles: false,
            cancelable: true,
            detail: { originalEvent },
          },
        ));
        if (family === "focus") {
          const ownEvent = new CustomEvent("dismissableLayer.focusOutside", {
            bubbles: false,
            cancelable: true,
            detail: { originalEvent },
          });
          outside.addEventListener(ownEvent.type, (event) => {
            event.stopImmediatePropagation();
            if (!handlers.outside || !handlers.close) {
              throw new Error("Outside handlers were not captured");
            }
            handlers.outside(event as CustomEvent<{ originalEvent: Event }>);
            handlers.close(false);
          }, { once: true });
          outside.dispatchEvent(ownEvent);
          originalEvent.stopImmediatePropagation();
        }
      };
      document.addEventListener(eventName, injectForeignLayerEvent);
      openMenu();
      item("history").focus();
      if (family === "pointer") {
        await waitForOutsideListener();
      } else {
        handlers.outside = captureFocusOutside();
        handlers.close = captureOpenChange();
      }

      if (family === "pointer") {
        fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
      } else {
        outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      }

      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    },
  );

  it("keeps stale Escape and outside handlers from closing or focusing a reopened visit", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions), true));
    const menuTrigger = trigger();
    const outside = screen.getByRole("button", { name: "Outside menu" });

    openMenu();
    const staleHistory = item("history");
    const staleEscape = captureEscape();
    const staleEscapeClose = captureOpenChange();
    fireEvent.keyDown(staleHistory, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    openMenu();
    item("history").focus();

    const replayedEscape = new KeyboardEvent("keydown", { bubbles: true, key: "Escape" });
    staleHistory.addEventListener("keydown", (event) => {
      event.stopImmediatePropagation();
      staleEscape(event);
      staleEscapeClose(false);
    }, { capture: true, once: true });
    act(() => staleHistory.dispatchEvent(replayedEscape));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(menuTrigger).not.toHaveFocus();

    const staleOutside = captureOutside();
    const staleOutsideClose = captureOpenChange();
    fireEvent.keyDown(item("history"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    openMenu();
    await waitForOutsideListener();
    const replayedOriginal = new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      pointerType: "mouse",
    });
    const replayedOutside = new CustomEvent("dismissableLayer.pointerDownOutside", {
      bubbles: true,
      cancelable: true,
      detail: { originalEvent: replayedOriginal },
    });
    outside.addEventListener(replayedOutside.type, (event) => {
      event.stopImmediatePropagation();
      staleOutside(event as CustomEvent<{ originalEvent: Event }>);
      staleOutsideClose(false);
    }, { capture: true, once: true });
    act(() => outside.dispatchEvent(replayedOutside));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await waitForOutsideListener();
    fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("claims the old action before a synchronous callback publishes a fresh document", async () => {
    const firstSession = createSession();
    const nextDoc = { ...DOC, id: "callback-successor", title: "Callback successor" };
    const nextSession = createSession(nextDoc.id);
    const first = createActions();
    const next = createActions();
    const firstProps = headerProps(firstSession, first);
    const nextView = header(headerProps(nextSession, next, { doc: nextDoc }));
    const viewRef: { current: DirectView | null } = { current: null };
    first.onHistory = vi.fn(() => {
      if (!viewRef.current) throw new Error("Header root was not mounted");
      viewRef.current.root.render(<StrictMode>{nextView}</StrictMode>);
    });
    const view = await renderStrict(header({ ...firstProps, onHistory: first.onHistory }));
    viewRef.current = view;

    openMenu();
    const currentHistory = item("history");
    const currentStaleSelect = captureSelect(currentHistory);
    fireEvent.click(currentHistory);
    expect(first.onHistory).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    act(() => {
      dispatchUnadmittedSelection(currentHistory, currentStaleSelect);
    });
    expect(first.onHistory).toHaveBeenCalledOnce();
    expect(next.onHistory).not.toHaveBeenCalled();

    openMenu();
    fireEvent.click(item("history"));
    expect(next.onHistory).toHaveBeenCalledOnce();
  });

  it("consumes one delete confirmation choice and leaves a fresh successor exact", async () => {
    const session = createSession();
    const mutation = vi.fn();
    const confirmDelete = vi.spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const actions = createActions();
    actions.onDelete = vi.fn(() => {
      if (confirm(`Move “${DOC.title}” to trash? You can restore it from the dashboard for 30 days.`)) {
        mutation();
      }
    });
    await renderStrict(header(headerProps(session, actions)));

    openMenu();
    fireEvent.click(item("delete"));
    expect(confirmDelete).toHaveBeenCalledExactlyOnceWith(
      "Move “Menu source” to trash? You can restore it from the dashboard for 30 days.",
    );
    expect(mutation).not.toHaveBeenCalled();

    openMenu();
    fireEvent.click(item("delete"));
    expect(confirmDelete).toHaveBeenCalledTimes(2);
    expect(mutation).toHaveBeenCalledOnce();
  });
});

describe("editor header Publish options directional focus", () => {
  describe("rendered capture reentry", () => {
    it.each(
      (["nativeEvent", "cancellation query"] as const).flatMap((boundary) =>
        [false, true].flatMap((republish) =>
          [false, true].map((throwing) => ({ boundary, republish, throwing })))),
    )("excludes nested arrows at $boundary with republish=$republish and throwing=$throwing", async ({
      boundary, republish, throwing,
    }) => {
      const measurements = publishKeyMeasurements();
      const props = headerProps(createSession(), createActions());
      const successor = { ...props, onPublish: vi.fn() };
      const view = await renderStrict(header(props));
      const button = publishTrigger();
      const initialHandlers = publishKeyHandlers(button);
      const nestedPhases: Array<{
        phase: PublishPhase;
        event: KeyboardEvent;
        target: EventTarget;
        currentTarget: EventTarget;
        insideCapture: boolean;
      }> = [];
      const openChanges: MutationRecord[] = [];
      const observer = new MutationObserver((records) => openChanges.push(...records));
      observer.observe(button, {
        attributes: true, attributeOldValue: true, attributeFilter: ["aria-expanded"],
      });
      let nested: KeyboardEvent | null = null;
      let currentButton: HTMLButtonElement | null = null;
      let currentHandlers: ReturnType<typeof publishKeyHandlers> | null = null;
      let entered = false;
      let insideCapture = false;
      let nestedOutcome: {
        prevented: boolean;
        preventions: number;
        menu: HTMLElement | null;
        expanded: string | null;
        autofocus: number;
        focus: number;
      } | null = null;
      const reenter = vi.fn(() => {
        if (entered) return;
        entered = true;
        if (republish) {
          flushSync(() => view.root.render(<StrictMode>{header(successor)}</StrictMode>));
        }
        currentButton = publishTrigger();
        currentHandlers = publishKeyHandlers(currentButton);
        nested = new KeyboardEvent("keydown", {
          bubbles: true, cancelable: true, composed: true, key: "ArrowUp",
        });
        markJsdomEventTrusted(nested);
        const restoreNested = interceptPublishKeys((event, phase, original) => {
          if (event.nativeEvent === nested) {
            nestedPhases.push({
              phase, event: event.nativeEvent, target: event.target,
              currentTarget: event.currentTarget, insideCapture,
            });
          }
          original(event);
        }, currentButton);
        try {
          currentButton.dispatchEvent(nested);
          nestedOutcome = {
            prevented: nested.defaultPrevented,
            preventions: measurements.preventDefault.mock.contexts
              .filter((receiver) => receiver === nested).length,
            menu: screen.queryByRole("menu"),
            expanded: currentButton.getAttribute("aria-expanded"),
            autofocus: measurements.dispatchEvent.mock.calls
              .filter(([event]) => event.type === "focusScope.autoFocusOnMount").length,
            focus: measurements.focus.mock.calls.length,
          };
        } finally {
          restoreNested();
        }
        if (throwing) throw new Error("Throwing capture callback after nested dispatch");
      });
      const restore = interceptPublishKeys((source, phase, original) => {
        if (phase !== "capture" || source.nativeEvent === nested) {
          original(source);
          return;
        }
        const wrapper = publicPublishWrapper(source, "getters");
        if (boundary === "nativeEvent") {
          Object.defineProperty(wrapper.event, "nativeEvent", {
            get: () => {
              reenter();
              return source.nativeEvent;
            },
          });
        } else {
          wrapper.methods.isDefaultPrevented.mockImplementation(() => {
            reenter();
            return false;
          });
        }
        insideCapture = true;
        try {
          original(wrapper.event);
        } finally {
          insideCapture = false;
        }
      }, button);
      button.focus();
      measurements.focus.mockClear();
      try {
        const outer = publishArrow("ArrowDown");
        restore();
        expect(reenter).toHaveBeenCalled();
        expect(nested).not.toBeNull();
        expect(nested).not.toBe(outer);
        expect(nested!.isTrusted).toBe(true);
        expect(currentButton).toBe(button);
        expect(currentHandlers).not.toBeNull();
        if (republish) {
          expect(currentHandlers!.captureTrigger).not.toBe(initialHandlers.captureTrigger);
        } else {
          expect(currentHandlers!.captureTrigger).toBe(initialHandlers.captureTrigger);
        }
        expect(nestedPhases).toEqual(["capture", "bubble"].map((phase) => ({
          phase, event: nested, target: button, currentTarget: button, insideCapture: true,
        })));
        expect(measurements.dispatchEvent.mock.calls.flatMap(([event], index) =>
          event === nested ? [measurements.dispatchEvent.mock.contexts[index]] : []))
          .toEqual([button]);
        expect(nestedOutcome).toEqual({
          prevented: false, preventions: 0, menu: null, expanded: "false", autofocus: 0, focus: 0,
        });
        expect(nested!.defaultPrevented).toBe(false);
        expectNoPublishActions(props);
        expectNoPublishActions(successor);
        if (republish || throwing) {
          expectPublishRejected(props, measurements, outer);
          expect(measurements.dispatchEvent.mock.calls
            .filter(([event]) => event.type === "focusScope.autoFocusOnMount")).toHaveLength(0);
        } else {
          await expectPublishAccepted(props, measurements, outer);
          fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
          await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
          await waitFor(() => expect(button).toHaveFocus());
          measurements.focus.mockClear();
          measurements.dispatchEvent.mockClear();
        }
        openChanges.push(...observer.takeRecords());
        expect(openChanges.filter((record) => record.oldValue === "false"))
          .toHaveLength(republish || throwing ? 0 : 1);
        openChanges.length = 0;
        const clean = publishArrow("ArrowUp");
        await expectPublishAccepted(republish ? successor : props, measurements, clean, "Share link…");
        openChanges.push(...observer.takeRecords());
        expect(openChanges.filter((record) => record.oldValue === "false")).toHaveLength(1);
        expectNoPublishActions(props);
        expectNoPublishActions(successor);
      } finally {
        restore();
        observer.disconnect();
      }
    });
  });

  describe("public React authority", () => {
    it.each(
      (["plain", "null", "unrelated", "getters", "proxy"] as const).flatMap((shape) =>
        (["absent", "throwing"] as const).flatMap((compatibility) =>
          (["aliases", "independent"] as const).flatMap((composition) =>
            (["ArrowDown", "ArrowUp"] as const).map((key) => ({
              shape, compatibility, composition, key,
            }))))),
    )("accepts $shape wrappers with $compatibility optional members, $composition and $key", async ({
      shape, compatibility, composition, key,
    }) => {
      const measurements = publishKeyMeasurements();
      const props = headerProps(createSession(), createActions());
      await renderStrict(header(props));
      const button = publishTrigger();
      const handlers = publishKeyHandlers();
      const wrappers: PublicPublishWrapper[] = [];
      const restore = interceptPublishKeys((source, phase, original) => {
        const trigger = publicPublishWrapper(source, shape, compatibility);
        const boundary = composition === "aliases"
          ? trigger : publicPublishWrapper(source, shape, compatibility);
        wrappers.push(trigger);
        if (boundary !== trigger) wrappers.push(boundary);
        if (composition === "aliases") {
          original(trigger.event);
        } else {
          handlers[phase === "capture" ? "captureTrigger" : "bubbleTrigger"](trigger.event);
          expect(trigger.methods.isDefaultPrevented, `${phase} trigger was authenticated`).toHaveBeenCalled();
          handlers[phase === "capture" ? "captureBoundary" : "bubbleBoundary"](boundary.event);
          expect(boundary.methods.isDefaultPrevented, `${phase} boundary was authenticated`).toHaveBeenCalled();
        }
        if (phase === "capture") {
          trigger.set("currentTarget", null);
          boundary.set("currentTarget", null);
        }
      });
      const changes: MutationRecord[] = [];
      const observer = new MutationObserver((records) => changes.push(...records));
      observer.observe(button, {
        attributes: true, attributeOldValue: true, attributeFilter: ["aria-expanded"],
      });
      button.focus();
      measurements.focus.mockClear();
      try {
        const event = publishArrow(key, { code: "Numpad2", location: 3 });
        await expectPublishAccepted(
          props, measurements, event, key === "ArrowDown" ? "Gist or repository…" : "Share link…",
        );
        changes.push(...observer.takeRecords());
        expect(changes.filter((record) => record.oldValue === "false")).toHaveLength(1);
        expect(wrappers).toHaveLength(composition === "aliases" ? 2 : 4);
        const prevented = wrappers.at(-1)!;
        for (const wrapper of wrappers) {
          expect(wrapper.optionalRead).not.toHaveBeenCalled();
          expect(wrapper.methods.preventDefault.mock.contexts)
            .toEqual(wrapper === prevented ? [wrapper.event] : []);
          expect(wrapper.methods.isDefaultPrevented).toHaveBeenCalled();
          expect(wrapper.methods.isPropagationStopped).toHaveBeenCalled();
          expect(wrapper.event.isDefaultPrevented)
            .toBe(wrapper === prevented ? wrapper.preventedQuery : wrapper.methods.isDefaultPrevented);
        }
      } finally {
        observer.disconnect();
        restore();
      }
    });

    const malformedPublicValues: ReadonlyArray<readonly [string, string, () => unknown]> = [
      ["wrong target", "target", () => document.body],
      ["wrong currentTarget", "currentTarget", () => document.body],
      ["released currentTarget", "currentTarget", () => null],
      ["wrong phase", "eventPhase", () => Event.AT_TARGET],
      ["wrong native", "nativeEvent", () => new KeyboardEvent("keydown", { key: "ArrowDown" })],
      ["structural native", "nativeEvent", () => Object.create(KeyboardEvent.prototype)],
      ["wrong type", "type", () => "keyup"],
      ["wrong key", "key", () => "Enter"],
      ["wrong code", "code", () => "DifferentCode"],
      ["wrong location", "location", () => 3],
      ["wrong time", "timeStamp", () => -1],
      ["wrong detail", "detail", () => 2],
      ["wrong Window", "view", () => Object.create(window)],
      ["canceled", "defaultPrevented", () => true],
      ["stopped", "isPropagationStopped", () => () => true],
      ["default query canceled", "isDefaultPrevented", () => () => true],
      ["untrusted wrapper", "isTrusted", () => false],
      ["non-bubbling", "bubbles", () => false],
      ["non-cancelable", "cancelable", () => false],
      ["Alt", "altKey", () => true],
      ["Control", "ctrlKey", () => true],
      ["Meta", "metaKey", () => true],
      ["Shift", "shiftKey", () => true],
      ["repeated", "repeat", () => true],
      ["missing prevention", "preventDefault", () => undefined],
      ["missing default query", "isDefaultPrevented", () => undefined],
      ["missing propagation query", "isPropagationStopped", () => undefined],
    ];
    it.each(malformedPublicValues)("rejects %s before prevention and accepts a clean successor", async (
      _label, property, value,
    ) => {
      const measurements = publishKeyMeasurements();
      const props = headerProps(createSession(), createActions());
      await renderStrict(header(props));
      const restore = interceptPublishKeys((source, phase, original) => {
        const wrapper = publicPublishWrapper(source, "getters");
        if (phase === "bubble") wrapper.set(property, value());
        original(wrapper.event);
      });
      publishTrigger().focus();
      measurements.focus.mockClear();
      const rejected = publishArrow("ArrowDown");
      restore();
      expectPublishRejected(props, measurements, rejected);
      const accepted = publishArrow("ArrowDown");
      await expectPublishAccepted(props, measurements, accepted);
    });

    it.each([
      "captureTrigger", "captureBoundary", "bubbleTrigger", "bubbleBoundary",
    ] as const)("does not let malformed %s release a rightful pair in the same dispatch", async (badBoundary) => {
      const measurements = publishKeyMeasurements();
      const props = headerProps(createSession(), createActions());
      await renderStrict(header(props));
      const handlers = publishKeyHandlers();
      const restore = interceptPublishKeys((source, phase) => {
        const boundaries: PublishBoundary[] = phase === "capture"
          ? ["captureTrigger", "captureBoundary"] : ["bubbleTrigger", "bubbleBoundary"];
        for (const boundary of boundaries) {
          if (boundary === badBoundary) {
            const malformed = publicPublishWrapper(source, "getters");
            Object.defineProperty(malformed.event, "view", {
              get: () => {
                malformed.set("nativeEvent", new KeyboardEvent("keydown"));
                return source.view;
              },
            });
            handlers[boundary](malformed.event);
            expectPublishRejected(props, measurements, source.nativeEvent);
          }
          const rightful = publicPublishWrapper(source, "null", "throwing");
          handlers[boundary](rightful.event);
        }
      });
      publishTrigger().focus();
      measurements.focus.mockClear();
      try {
        const accepted = publishArrow("ArrowDown");
        await expectPublishAccepted(props, measurements, accepted);
      } finally {
        restore();
      }
    });

    it.each(["capture", "bubble"] as const)(
      "rejects crossed %s native deliveries without stealing the real delivery",
      async (badPhase) => {
        const measurements = publishKeyMeasurements();
        const props = headerProps(createSession(), createActions());
        await renderStrict(header(props));
        const handlers = publishKeyHandlers();
        const crossed = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" });
        markJsdomEventTrusted(crossed);
        const restore = interceptPublishKeys((source, phase) => {
          const wrapper = publicPublishWrapper(source);
          const trigger = phase === "capture" ? handlers.captureTrigger : handlers.bubbleTrigger;
          const boundary = phase === "capture" ? handlers.captureBoundary : handlers.bubbleBoundary;
          if (phase === badPhase) {
            wrapper.set("nativeEvent", crossed);
            trigger(wrapper.event);
            boundary(wrapper.event);
            expectPublishRejected(props, measurements, source.nativeEvent);
            wrapper.set("nativeEvent", source.nativeEvent);
          }
          trigger(wrapper.event);
          boundary(wrapper.event);
        });
        publishTrigger().focus();
        measurements.focus.mockClear();
        try {
          const accepted = publishArrow("ArrowDown");
          await expectPublishAccepted(props, measurements, accepted);
          expect(crossed.defaultPrevented).toBe(false);
        } finally {
          restore();
        }
      },
    );

    it("rejects duplicate and reentrant phase claims without an extra prevention or open", async () => {
      const measurements = publishKeyMeasurements();
      const props = headerProps(createSession(), createActions());
      await renderStrict(header(props));
      const handlers = publishKeyHandlers();
      const restore = interceptPublishKeys((source, phase) => {
        const wrapper = publicPublishWrapper(source);
        const trigger = phase === "capture" ? handlers.captureTrigger : handlers.bubbleTrigger;
        const boundary = phase === "capture" ? handlers.captureBoundary : handlers.bubbleBoundary;
        if (phase === "bubble") {
          wrapper.methods.preventDefault.mockImplementationOnce(function () {
            handlers.bubbleBoundary(wrapper.event);
            source.nativeEvent.preventDefault();
            wrapper.set("defaultPrevented", true);
            wrapper.set("isDefaultPrevented", wrapper.preventedQuery);
          });
        }
        trigger(wrapper.event);
        trigger(wrapper.event);
        boundary(wrapper.event);
        boundary(wrapper.event);
      });
      publishTrigger().focus();
      measurements.focus.mockClear();
      try {
        const accepted = publishArrow("ArrowUp");
        await expectPublishAccepted(props, measurements, accepted, "Share link…");
      } finally {
        restore();
      }
    });

    it.each([1, 3, 8])("retains native proof through %i nested capture microtasks", async (depth) => {
      const measurements = publishKeyMeasurements();
      const props = headerProps(createSession(), createActions());
      await renderStrict(header(props));
      const queued: VoidFunction[] = [];
      const queue = vi.spyOn(window, "queueMicrotask").mockImplementation((callback) => queued.push(callback));
      let checkpoints = 0;
      const restore = interceptPublishKeys((source, phase, original) => {
        original(source);
        if (phase !== "capture") return;
        const checkpoint = (remaining: number) => {
          if (remaining === 0) return;
          window.queueMicrotask(() => {
            checkpoints += 1;
            checkpoint(remaining - 1);
          });
        };
        checkpoint(depth);
        while (queued.length) queued.shift()!();
        queue.mockRestore();
      });
      publishTrigger().focus();
      measurements.focus.mockClear();
      try {
        const accepted = publishArrow("ArrowDown");
        expect(checkpoints).toBe(depth);
        await expectPublishAccepted(props, measurements, accepted);
      } finally {
        queue.mockRestore();
        restore();
      }
    });

    it.each([
      ["self default query", "isDefaultPrevented", "isDefaultPrevented"],
      ["default to propagation query", "isDefaultPrevented", "isPropagationStopped"],
      ["propagation to default query", "isPropagationStopped", "isDefaultPrevented"],
      ["query to prevention", "isDefaultPrevented", "preventDefault"],
    ] as const)("rejects %s method drift before prevention", async (_label, query, changed) => {
      const measurements = publishKeyMeasurements();
      const props = headerProps(createSession(), createActions());
      await renderStrict(header(props));
      const replacement = vi.fn(() => false);
      const restore = interceptPublishKeys((source, phase, original) => {
        const wrapper = publicPublishWrapper(source, "getters");
        if (phase === "bubble") {
          wrapper.set(query, function () {
            wrapper.set(changed, replacement);
            return false;
          });
        }
        original(wrapper.event);
      });
      publishTrigger().focus();
      measurements.focus.mockClear();
      const rejected = publishArrow("ArrowDown");
      restore();
      expectPublishRejected(props, measurements, rejected);
      expect(replacement).not.toHaveBeenCalled();
      await expectPublishAccepted(props, measurements, publishArrow("ArrowDown"));
    });

    it.each(["capture", "bubble"] as const)("rejects %s accessor-time method drift", async (badPhase) => {
      const measurements = publishKeyMeasurements();
      const props = headerProps(createSession(), createActions());
      await renderStrict(header(props));
      const replacement = vi.fn(() => false);
      const restore = interceptPublishKeys((source, phase, original) => {
        const wrapper = publicPublishWrapper(source, "getters");
        if (phase === badPhase) {
          Object.defineProperty(wrapper.event, "view", {
            get: () => {
              wrapper.set("preventDefault", replacement);
              return source.view;
            },
          });
        }
        original(wrapper.event);
      });
      publishTrigger().focus();
      measurements.focus.mockClear();
      const rejected = publishArrow("ArrowDown");
      restore();
      expectPublishRejected(props, measurements, rejected);
      expect(replacement).not.toHaveBeenCalled();
      await expectPublishAccepted(props, measurements, publishArrow("ArrowDown"));
    });

    it("rejects cross-wrapper query drift without invoking a replaced capture method", async () => {
      const measurements = publishKeyMeasurements();
      const props = headerProps(createSession(), createActions());
      await renderStrict(header(props));
      const handlers = publishKeyHandlers();
      const captures: PublicPublishWrapper[] = [];
      const replacement = vi.fn(() => false);
      const restore = interceptPublishKeys((source, phase) => {
        const trigger = publicPublishWrapper(source, "getters");
        const boundary = publicPublishWrapper(source, "null");
        if (phase === "capture") {
          captures.push(trigger, boundary);
          handlers.captureTrigger(trigger.event);
          handlers.captureBoundary(boundary.event);
        } else {
          trigger.methods.isDefaultPrevented.mockImplementationOnce(() => {
            captures[1]!.set("isPropagationStopped", replacement);
            return false;
          });
          handlers.bubbleTrigger(trigger.event);
          handlers.bubbleBoundary(boundary.event);
        }
      });
      publishTrigger().focus();
      measurements.focus.mockClear();
      const rejected = publishArrow("ArrowDown");
      restore();
      expectPublishRejected(props, measurements, rejected);
      expect(replacement).not.toHaveBeenCalled();
      await expectPublishAccepted(props, measurements, publishArrow("ArrowDown"));
    });

    it.each(["nativeEvent", "key", "isDefaultPrevented"] as const)(
      "leaves a throwing public %s accessor unprevented",
      async (property) => {
        const measurements = publishKeyMeasurements();
        const props = headerProps(createSession(), createActions());
        await renderStrict(header(props));
        const restore = interceptPublishKeys((source, phase, original) => {
          const wrapper = publicPublishWrapper(source, "getters");
          if (phase === "bubble") {
            Object.defineProperty(wrapper.event, property, {
              get: () => { throw new Error("Malformed public accessor"); },
            });
          }
          original(wrapper.event);
        });
        publishTrigger().focus();
        measurements.focus.mockClear();
        const rejected = publishArrow("ArrowDown");
        restore();
        expectPublishRejected(props, measurements, rejected);
        await expectPublishAccepted(props, measurements, publishArrow("ArrowDown"));
      },
    );

    it.each(["focus", "restored DOM history", "role", "permission", "sync"] as const)(
      "rechecks %s after a public query before prevention",
      async (change) => {
        const measurements = publishKeyMeasurements();
        const initialSync = syncStatus();
        const props = headerProps(createSession(), createActions(), { sync: initialSync });
        const view = await renderStrict(<div key="before">{header(props, true)}</div>);
        const restore = interceptPublishKeys((source, phase, original) => {
          const wrapper = publicPublishWrapper(source, "getters");
          if (phase === "bubble") {
            wrapper.methods.isDefaultPrevented.mockImplementationOnce(() => {
              if (change === "focus") {
                screen.getByRole("button", { name: "Outside menu" }).focus();
                measurements.focus.mockClear();
              } else if (change === "restored DOM history") {
                source.currentTarget.setAttribute("aria-label", "Changed");
                source.currentTarget.setAttribute("aria-label", "Publish options");
              } else if (change === "role") {
                Object.defineProperty(props.session, "role", { configurable: true, value: "viewer" });
              } else if (change === "permission") {
                flushSync(() => view.root.render(
                  <StrictMode>
                    <div key="before">{header({ ...props, githubConfigured: false }, true)}</div>
                  </StrictMode>,
                ));
              } else {
                initialSync.status = "local-ahead";
              }
              return false;
            });
          }
          original(wrapper.event);
        });
        publishTrigger().focus();
        measurements.focus.mockClear();
        const rejected = publishArrow("ArrowDown");
        restore();
        expectPublishRejected(props, measurements, rejected);
        const successor = headerProps(createSession(), createActions());
        await view.render(<div key="after">{header(successor)}</div>);
        publishTrigger().focus();
        measurements.focus.mockClear();
        await expectPublishAccepted(successor, measurements, publishArrow("ArrowDown"));
      },
    );

    it.each([
      "prevention method", "propagation method", "capture default query", "capture prevention",
      "post-prevention accessor", "post-prevention self-query", "post-prevention cross-query",
      "wrapper cancellation", "native cancellation",
    ] as const)("rejects %s drift at prevention without opening", async (drift) => {
      const measurements = publishKeyMeasurements();
      const props = headerProps(createSession(), createActions());
      await renderStrict(header(props));
      let capture: PublicPublishWrapper | null = null;
      const replacement = vi.fn(() => false);
      const restore = interceptPublishKeys((source, phase, original) => {
        const wrapper = publicPublishWrapper(source, "getters");
        if (phase === "capture") {
          capture = wrapper;
        } else {
          wrapper.methods.preventDefault.mockImplementationOnce(function () {
            if (drift !== "native cancellation") source.nativeEvent.preventDefault();
            wrapper.set("defaultPrevented", drift !== "wrapper cancellation");
            wrapper.set("isDefaultPrevented", wrapper.preventedQuery);
            if (drift === "prevention method") wrapper.set("preventDefault", replacement);
            if (drift === "propagation method") wrapper.set("isPropagationStopped", replacement);
            if (drift === "capture default query") capture!.set("isDefaultPrevented", replacement);
            if (drift === "capture prevention") capture!.set("preventDefault", replacement);
            if (drift === "post-prevention accessor") {
              Object.defineProperty(wrapper.event, "view", {
                get: () => {
                  wrapper.set("isDefaultPrevented", replacement);
                  return source.view;
                },
              });
            }
            if (drift === "post-prevention self-query") {
              wrapper.preventedQuery.mockImplementationOnce(() => {
                wrapper.set("isDefaultPrevented", replacement);
                return true;
              });
            }
            if (drift === "post-prevention cross-query") {
              wrapper.methods.isPropagationStopped.mockImplementationOnce(() => {
                wrapper.set("isDefaultPrevented", replacement);
                return false;
              });
            }
          });
        }
        original(wrapper.event);
      });
      publishTrigger().focus();
      measurements.focus.mockClear();
      const rejected = publishArrow("ArrowDown");
      restore();
      expectPublishRejected(props, measurements, rejected, drift === "native cancellation" ? 0 : 1);
      expect(replacement).not.toHaveBeenCalled();
    });

    it.each(["accessor", "query", "prevention"] as const)(
      "revokes a pair when a public %s retires the trigger ref",
      async (point) => {
        const measurements = publishKeyMeasurements();
        const props = headerProps(createSession(), createActions());
        await renderStrict(header(props));
        const button = publishTrigger();
        const ref = fiberFor(button).ref;
        if (typeof ref !== "function") throw new Error("Publish ref not attached");
        let retired = false;
        const retire = () => {
          if (retired) return;
          retired = true;
          ref(null);
        };
        const restore = interceptPublishKeys((source, phase, original) => {
          const wrapper = publicPublishWrapper(source, "getters");
          if (phase === "bubble") {
            if (point === "accessor") {
              Object.defineProperty(wrapper.event, "view", {
                get: () => { retire(); return source.view; },
              });
            } else if (point === "query") {
              wrapper.methods.isDefaultPrevented.mockImplementationOnce(() => {
                retire();
                return false;
              });
            } else {
              wrapper.methods.preventDefault.mockImplementationOnce(() => {
                source.nativeEvent.preventDefault();
                wrapper.set("defaultPrevented", true);
                wrapper.set("isDefaultPrevented", wrapper.preventedQuery);
                retire();
              });
            }
          }
          original(wrapper.event);
        });
        button.focus();
        measurements.focus.mockClear();
        const rejected = publishArrow("ArrowDown");
        restore();
        expect(retired).toBe(true);
        expectPublishRejected(props, measurements, rejected, point === "prevention" ? 1 : 0);
        await act(async () => ref(button));
        measurements.focus.mockClear();
        await expectPublishAccepted(props, measurements, publishArrow("ArrowDown"));
      },
    );

    it.each(["unfocused", "native canceled", "native stopped", "native composing"] as const)(
      "rejects %s between phase deliveries",
      async (reason) => {
        const measurements = publishKeyMeasurements();
        const props = headerProps(createSession(), createActions());
        await renderStrict(header(props, true));
        const nativePrevent = Event.prototype.preventDefault;
        const restore = interceptPublishKeys((source, phase, original) => {
          if (phase === "bubble") {
            if (reason === "unfocused") screen.getByRole("button", { name: "Outside menu" }).focus();
            if (reason === "native canceled") nativePrevent.call(source.nativeEvent);
            if (reason === "native stopped") source.nativeEvent.stopPropagation();
            if (reason === "native composing") {
              Object.defineProperty(source.nativeEvent, "isComposing", { value: true });
            }
            measurements.focus.mockClear();
          }
          original(source);
        });
        publishTrigger().focus();
        measurements.focus.mockClear();
        const rejected = publishArrow("ArrowDown", reason === "native composing" ? { isComposing: true } : {});
        restore();
        expectPublishRejected(props, measurements, rejected, reason === "native canceled" ? 1 : 0);
        publishTrigger().focus();
        measurements.focus.mockClear();
        await expectPublishAccepted(props, measurements, publishArrow("ArrowDown"));
      },
    );

    it("revokes abandoned proof on ref cleanup and rejects old callbacks in a fresh visit", async () => {
      const measurements = publishKeyMeasurements();
      const props = headerProps(createSession(), createActions());
      const view = await renderStrict(<div key="old">{header(props)}</div>);
      const button = publishTrigger();
      const handlers = publishKeyHandlers();
      let oldCapture: PublicPublishWrapper | null = null;
      const restore = interceptPublishKeys((source, phase, original) => {
        if (phase === "capture") {
          oldCapture = publicPublishWrapper(source);
          original(oldCapture.event);
        }
      });
      button.focus();
      measurements.focus.mockClear();
      const abandoned = publishArrow("ArrowDown");
      restore();
      expectPublishRejected(props, measurements, abandoned);
      await view.render(<div key="new">{header(props)}</div>);
      const restoreSuccessor = interceptPublishKeys((source, phase, original) => {
        const wrapper = publicPublishWrapper(source);
        handlers[phase === "capture" ? "captureTrigger" : "bubbleTrigger"](wrapper.event);
        handlers[phase === "capture" ? "captureBoundary" : "bubbleBoundary"](wrapper.event);
        if (oldCapture) {
          handlers.captureTrigger(oldCapture.event);
          handlers.captureBoundary(oldCapture.event);
          handlers.bubbleTrigger(oldCapture.event);
          handlers.bubbleBoundary(oldCapture.event);
        }
        expectPublishRejected(props, measurements, source.nativeEvent);
        original(source);
      });
      publishTrigger().focus();
      measurements.focus.mockClear();
      try {
        await expectPublishAccepted(props, measurements, publishArrow("ArrowDown"));
      } finally {
        restoreSuccessor();
      }
      expect(abandoned.defaultPrevented).toBe(false);
    });

    it("rejects an abandoned event redispatch but accepts a distinct native successor", async () => {
      const measurements = publishKeyMeasurements();
      const props = headerProps(createSession(), createActions());
      await renderStrict(header(props));
      const restore = interceptPublishKeys((source, phase, original) => {
        if (phase === "capture") original(source);
      });
      publishTrigger().focus();
      measurements.focus.mockClear();
      const abandoned = publishArrow("ArrowDown");
      restore();
      expectPublishRejected(props, measurements, abandoned);
      act(() => publishTrigger().dispatchEvent(abandoned));
      expectPublishRejected(props, measurements, abandoned);
      await expectPublishAccepted(props, measurements, publishArrow("ArrowDown"));
    });

    it("does not let a wrong-receiver native callback clean up a pending capture pair", async () => {
      const measurements = publishKeyMeasurements();
      const props = headerProps(createSession(), createActions());
      await renderStrict(header(props));
      const registrations = vi.mocked(EventTarget.prototype.addEventListener);
      const listener = registrations.mock.calls.flatMap((call, index) =>
        registrations.mock.contexts[index] === window
        && call[0] === "keydown" && call[2] === true && typeof call[1] === "function"
          ? [call[1] as EventListener] : []).at(-1);
      if (!listener) throw new Error("Publish native listener was not attached");
      const restore = interceptPublishKeys((source, phase, original) => {
        if (phase === "bubble") {
          listener.call(document, source.nativeEvent);
          listener.call(window, source.nativeEvent);
          expectPublishRejected(props, measurements, source.nativeEvent);
        }
        original(source);
      });
      publishTrigger().focus();
      measurements.focus.mockClear();
      try {
        await expectPublishAccepted(props, measurements, publishArrow("ArrowDown"));
      } finally {
        restore();
      }
    });
  });

  it("publishes a complete successor after the Strict callback-ref replay", async () => {
    const props = headerProps(createSession(), createActions());
    const composedPath = vi.spyOn(window.Event.prototype, "composedPath");
    const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
    let reactPair: null | {
      readonly nativeEvent: globalThis.KeyboardEvent;
      readonly view: unknown;
    } = null;
    const view = await renderStrict(
      <div
        onKeyDown={(current) => {
          reactPair = {
            nativeEvent: current.nativeEvent,
            view: current.view,
          };
        }}
      >
        {header(props)}
      </div>,
    );
    const button = publishTrigger();
    const ownerWindow = button.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("The Publish trigger has no owner window");
    const ref = fiberFor(button).ref;
    if (typeof ref !== "function") throw new Error("Publish trigger callback ref was not attached");
    const publicationListeners = () => {
      const addEventListener = vi.mocked(EventTarget.prototype.addEventListener);
      return addEventListener.mock.calls.flatMap(
        (call, index) =>
          addEventListener.mock.contexts[index] === ownerWindow
          && call[0] === "keydown"
          && call[2] === true
          && typeof call[1] === "function"
            ? [call[1] as EventListener]
            : [],
      );
    };
    const listenerRemovals = (listener: EventListener) => {
      const removeEventListener = vi.mocked(EventTarget.prototype.removeEventListener);
      return removeEventListener.mock.calls.filter(
        (call, index) =>
          removeEventListener.mock.contexts[index] === ownerWindow
          && call[0] === "keydown"
          && call[1] === listener
          && call[2] === true,
      ).length;
    };
    const initialListeners = publicationListeners();
    const predecessorListener = initialListeners.at(-1);
    if (!predecessorListener) throw new Error("Publish Window listener was not attached");
    const predecessorRemovals = listenerRemovals(predecessorListener);

    act(() => {
      ref(null);
    });
    expect(publicationListeners()).toHaveLength(initialListeners.length);
    expect(listenerRemovals(predecessorListener)).toBe(predecessorRemovals + 1);
    ownerWindow.addEventListener("keydown", predecessorListener, true);
    button.focus();
    const partial = publishArrow("ArrowDown");
    ownerWindow.removeEventListener("keydown", predecessorListener, true);
    expect(partial.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    act(() => {
      ref(button);
    });
    await waitFor(() =>
      expect(publicationListeners()).toHaveLength(initialListeners.length + 1));
    await act(async () => Promise.resolve());
    const successorListener = publicationListeners().at(-1);
    if (!successorListener) throw new Error("Publish successor listener was not attached");
    expect(successorListener).not.toBe(predecessorListener);
    ownerWindow.removeEventListener("keydown", successorListener, true);
    button.ownerDocument.addEventListener("keydown", successorListener, true);
    button.focus();
    const wrongReceiver = publishArrow("ArrowDown");
    button.ownerDocument.removeEventListener("keydown", successorListener, true);
    ownerWindow.addEventListener("keydown", successorListener, true);
    expect(wrongReceiver.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    const observe = vi.spyOn(window.MutationObserver.prototype, "observe");
    composedPath.mockClear();
    preventDefault.mockClear();
    let nativeDelivery: null | {
      readonly receiver: EventTarget;
      readonly currentTarget: EventTarget | null;
      readonly eventPhase: number;
      readonly path: readonly EventTarget[];
      readonly view: Window | null;
    } = null;
    ownerWindow.addEventListener("keydown", function (current) {
      const keyboard = current as globalThis.KeyboardEvent;
      nativeDelivery = {
        receiver: this,
        currentTarget: current.currentTarget,
        eventPhase: current.eventPhase,
        path: current.composedPath(),
        view: keyboard.view,
      };
    }, { capture: true, once: true });
    button.focus();

    const event = publishArrow("ArrowDown");
    const pathCalls = () =>
      composedPath.mock.contexts.filter((context) => context === event).length;
    const preventionCalls = () =>
      preventDefault.mock.contexts.filter((context) => context === event).length;

    const expectedPath: EventTarget[] = [];
    for (let current: Node | null = button; current; current = current.parentNode) {
      expectedPath.push(current);
      if (current === button.ownerDocument) break;
    }
    expect(nativeDelivery).not.toBeNull();
    expect(ownerWindow).toBe(window);
    expect(nativeDelivery!.receiver).not.toBe(ownerWindow);
    expect(nativeDelivery!.currentTarget).toBe(nativeDelivery!.receiver);
    expect(nativeDelivery!.eventPhase).toBe(window.Event.CAPTURING_PHASE);
    expect(nativeDelivery!.path).toHaveLength(expectedPath.length + 1);
    expect(
      nativeDelivery!.path.slice(0, -1)
        .findIndex((entry, index) => entry !== expectedPath[index]),
    ).toBe(-1);
    const pathTerminal = nativeDelivery!.path.at(-1);
    expect(pathTerminal).toBe(nativeDelivery!.receiver);
    expect(nativeDelivery!.view).toBe(event.view);
    expect(Object.getPrototypeOf(event)).toBe(window.KeyboardEvent.prototype);
    expect(event.isTrusted).toBe(true);
    expect(reactPair).not.toBeNull();
    expect(reactPair!.nativeEvent).toBe(event);
    expect(reactPair!.view).toBe(event.view);
    expect(pathCalls()).toBe(103);
    expect(observe).toHaveBeenCalled();
    expect(preventionCalls()).toBe(1);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Gist or repository…" })).toHaveFocus());
    expect(listenerRemovals(successorListener)).toBe(1);
    const openListener = publicationListeners().at(-1);
    if (!openListener || openListener === successorListener) {
      throw new Error("Open Publish publication listener was not attached");
    }
    const openListenerRemovals = listenerRemovals(openListener);
    await act(async () => view.root.unmount());
    const viewIndex = views.findIndex((candidate) => candidate.root === view.root);
    if (viewIndex >= 0) views.splice(viewIndex, 1);
    view.host.remove();
    expect(listenerRemovals(openListener)).toBe(openListenerRemovals + 1);
  });

  it("rejects a structural Window terminal before accepting the exact listener terminal", async () => {
    const nativeComposedPath = window.Event.prototype.composedPath;
    let terminal: EventTarget | null = null;
    vi.spyOn(window.Event.prototype, "composedPath").mockImplementation(function (this: Event) {
      const path = nativeComposedPath.call(this);
      return terminal ? [...path.slice(0, -1), terminal] : path;
    });
    const props = headerProps(createSession(), createActions());
    await renderStrict(header(props));
    const button = publishTrigger();
    const ownerWindow = button.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("The Publish trigger has no owner window");
    const structuralTerminal = Object.create(
      ownerWindow.Window.prototype,
    ) as Window & typeof globalThis;
    Object.defineProperties(structuralTerminal, {
      window: { configurable: true, value: structuralTerminal },
      self: { configurable: true, value: structuralTerminal },
      document: { configurable: true, value: button.ownerDocument },
      Window: { configurable: true, value: ownerWindow.Window },
      Object: { configurable: true, value: ownerWindow.Object },
      Event: { configurable: true, value: ownerWindow.Event },
      KeyboardEvent: { configurable: true, value: ownerWindow.KeyboardEvent },
    });
    expect(Object.getPrototypeOf(structuralTerminal)).toBe(ownerWindow.Window.prototype);
    expect(structuralTerminal.document).toBe(button.ownerDocument);
    expect(structuralTerminal.Window).toBe(ownerWindow.Window);
    expect(structuralTerminal.Object).toBe(ownerWindow.Object);
    expect(structuralTerminal.Event).toBe(ownerWindow.Event);
    expect(structuralTerminal.KeyboardEvent).toBe(ownerWindow.KeyboardEvent);
    terminal = structuralTerminal;
    button.focus();

    const rejected = publishArrow("ArrowDown");

    expect(rejected.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(props.onPublish).not.toHaveBeenCalled();
    expect(props.onDownload).not.toHaveBeenCalled();
    terminal = null;
    const accepted = publishArrow("ArrowDown");
    expect(accepted.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Gist or repository…" })).toHaveFocus());
  });

  it.each([
    ["ArrowDown", "Gist or repository…"],
    ["ArrowUp", "Share link…"],
  ] as const)("opens an unlinked owner menu with %s at %s", async (key, destination) => {
    const props = headerProps(createSession(), createActions());
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const dispatchEvent = vi.spyOn(window.EventTarget.prototype, "dispatchEvent");
    const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
    await renderStrict(header(props));
    publishTrigger().focus();
    focus.mockClear();

    const event = publishArrow(key);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: destination })).toHaveFocus());
    const content = screen.getByRole("menu");
    const autoFocusDeliveries = dispatchEvent.mock.calls.flatMap(
      (args, index) =>
        args[0] instanceof window.CustomEvent
        && args[0].type === "focusScope.autoFocusOnMount"
        && dispatchEvent.mock.contexts[index] === content
          ? [args[0]]
          : [],
    );
    expect(autoFocusDeliveries).toHaveLength(1);
    expect(autoFocusDeliveries[0]!.target).toBe(content);
    expect(autoFocusDeliveries[0]!.defaultPrevented).toBe(true);
    expect(
      preventDefault.mock.contexts.filter((context) => context === autoFocusDeliveries[0]),
    ).toHaveLength(1);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(focus.mock.contexts[0]).toBe(screen.getByRole("menuitem", { name: destination }));
    expect(props.onPublish).not.toHaveBeenCalled();
    expect(props.onDownload).not.toHaveBeenCalled();
    expect(props.onShare).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it.each([
    ["owner without GitHub", "owner", true],
    ["editor", "editor", false],
    ["viewer", "viewer", false],
  ] as const)(
    "skips the disabled first action for an unlinked %s",
    async (_name, role, isOwner) => {
      const props = headerProps(createSession(DOC.id, role), createActions(), {
        isOwner,
        githubConfigured: false,
      });
      await renderStrict(header(props));
      publishTrigger().focus();

      publishArrow("ArrowDown");

      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "Download Markdown" })).toHaveFocus());
      expect(screen.getByRole("menuitem", { name: /Gist or repository/ }))
        .toHaveAttribute("aria-disabled", "true");
      expect(props.onPublish).not.toHaveBeenCalled();
      expect(props.onDownload).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["owner", "owner", true, "Commit to GitHub…", "Change connection…"],
    ["editor", "editor", false, "Commit to GitHub…", "Open on GitHub"],
    ["viewer", "viewer", false, "Open on GitHub", "Open on GitHub"],
  ] as const)(
    "uses exact linked %s enabled endpoints",
    async (_name, role, isOwner, first, last) => {
      const doc = linkedDocument();
      const props = headerProps(createSession(doc.id, role), createActions(), {
        doc,
        sync: syncStatus(),
        isOwner,
      });
      const view = await renderStrict(header(props));
      publishTrigger().focus();
      publishArrow("ArrowDown");
      await waitFor(() => expect(screen.getByRole("menuitem", { name: first })).toHaveFocus());
      fireEvent.keyDown(screen.getByRole("menuitem", { name: first }), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      await view.render(header({ ...props }));
      publishTrigger().focus();
      publishArrow("ArrowUp");
      await waitFor(() => expect(screen.getByRole("menuitem", { name: last })).toHaveFocus());

      expect(props.onPublishNow).not.toHaveBeenCalled();
      expect(props.onPull).not.toHaveBeenCalled();
      expect(props.onSync).not.toHaveBeenCalled();
      expect(props.onPublish).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
    },
  );

  it("skips an unreadable Pull row and chooses the optional last action", async () => {
    const doc = linkedDocument();
    const props = headerProps(createSession(doc.id, "editor"), createActions(), {
      doc,
      sync: syncStatus("remote-unreadable"),
      isOwner: false,
    });
    await renderStrict(header(props));
    publishTrigger().focus();

    publishArrow("ArrowUp");

    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Open on GitHub" })).toHaveFocus());
    expect(screen.getByRole("menuitem", { name: "Pull latest from GitHub" }))
      .toHaveAttribute("aria-disabled", "true");
    expect(props.onPull).not.toHaveBeenCalled();
    expect(props.onSync).not.toHaveBeenCalled();
  });

  it("does no work when a linked viewer has no enabled current action", async () => {
    const doc = linkedDocument(null);
    const props = headerProps(createSession(doc.id, "viewer"), createActions(), {
      doc,
      sync: syncStatus(),
      isOwner: false,
    });
    await renderStrict(header(props));
    publishTrigger().focus();

    const event = publishArrow("ArrowDown");

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(props.onPublishNow).not.toHaveBeenCalled();
    expect(props.onPull).not.toHaveBeenCalled();
    expect(props.onSync).not.toHaveBeenCalled();
  });

  it.each([
    ["untrusted", {}, false],
    ["Alt-modified", { altKey: true }, true],
    ["Control-modified", { ctrlKey: true }, true],
    ["Meta-modified", { metaKey: true }, true],
    ["Shift-modified", { shiftKey: true }, true],
    ["repeating", { repeat: true }, true],
    ["composing", { isComposing: true }, true],
  ] as const)("rejects %s ArrowDown before accepting a clean successor", async (
    _name,
    init,
    trusted,
  ) => {
    const props = headerProps(createSession(), createActions());
    await renderStrict(header(props));
    publishTrigger().focus();

    const rejected = publishArrow("ArrowDown", init, trusted);

    expect(rejected.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
    const accepted = publishArrow("ArrowDown");
    expect(accepted.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Gist or repository…" })).toHaveFocus());
  });

  it.each(["attribute", "placement"] as const)(
    "rejects restored trigger %s history and recovers in a distinct visit",
    async (mutation) => {
      const props = headerProps(createSession(), createActions());
      const view = await renderStrict(<div key="first">{header(props)}</div>);
      const current = publishTrigger();
      if (mutation === "attribute") {
        current.setAttribute("aria-label", "Changed");
        current.setAttribute("aria-label", "Publish options");
      } else {
        const parent = current.parentNode!;
        const next = current.nextSibling;
        current.remove();
        parent.insertBefore(current, next);
      }
      current.focus();

      const rejected = publishArrow("ArrowDown");

      expect(rejected.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
      await view.render(<div key="second">{header(props)}</div>);
      publishTrigger().focus();
      publishArrow("ArrowDown");
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "Gist or repository…" })).toHaveFocus());
    },
  );

  it("retains pointer, Enter, Space, item activation, Escape, and outside close", async () => {
    const props = headerProps(createSession(), createActions());
    await renderStrict(header(props, true));
    const outside = screen.getByRole("button", { name: "Outside menu" });

    fireEvent.pointerDown(publishTrigger(), {
      bubbles: true,
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Download Markdown" }));
    expect(props.onDownload).toHaveBeenCalledExactlyOnceWith("md", false);

    publishTrigger().focus();
    fireEvent.keyDown(publishTrigger(), { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(publishTrigger()).toHaveFocus());

    fireEvent.keyDown(publishTrigger(), { key: " " });
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    await waitForOutsideListener();
    fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});
