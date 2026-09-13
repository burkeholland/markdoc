// @vitest-environment jsdom
import { StrictMode, useLayoutEffect } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabSession, EditMode } from "@/editor/collab/session";
import { ModeSwitcher } from "./header";

type ModeRole = "owner" | "editor" | "commenter" | "viewer";

class ModeSession {
  version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    public docId: string,
    public role: ModeRole,
    public mode: EditMode,
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setMode = vi.fn((mode: EditMode) => {
    this.mode = mode;
    this.publish();
  });

  setExternalMode(mode: EditMode) {
    this.mode = mode;
    this.publish();
  }

  asCollabSession(): CollabSession {
    return this as unknown as CollabSession;
  }

  private publish() {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

function ModeBoundary({
  session,
  present = true,
  boundary = 0,
  revision = 0,
  onChildBoundary,
  onBoundary,
}: {
  session: ModeSession;
  present?: boolean;
  boundary?: number;
  revision?: number;
  onChildBoundary?: () => void;
  onBoundary?: () => void;
}) {
  void revision;
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return (
    <>
      <LayoutBoundary boundary={boundary} onBoundary={onChildBoundary} />
      {present ? <ModeSwitcher session={session.asCollabSession()} /> : null}
    </>
  );
}

function LayoutBoundary({ boundary, onBoundary }: { boundary: number; onBoundary?: () => void }) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return null;
}

interface ReactFiber {
  return: ReactFiber | null;
  alternate?: ReactFiber | null;
  elementType?: string | { displayName?: string; name?: string };
  memoizedProps?: Record<string, unknown>;
  ref?: ((element: Element | null) => void) | { current: Element | null } | null;
}

function fiberFor(element: HTMLElement) {
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!fiberKey || !propsKey) throw new Error("React internals were not attached");
  const record = element as unknown as Record<string, ReactFiber | Record<string, unknown>>;
  const fiber = record[fiberKey] as ReactFiber;
  const props = record[propsKey] as Record<string, unknown>;
  const alternate = fiber.alternate;
  if (!alternate) return fiber;
  const eventProps = ["onClick", "onPointerDown", "onKeyDown"];
  const alternateIsCurrent = eventProps.some(
    (name) => typeof props[name] === "function" && alternate.memoizedProps?.[name] === props[name],
  );
  return alternateIsCurrent ? alternate : fiber;
}

function nearestHandler<T>(element: HTMLElement, property: string): T {
  let fiber: ReactFiber | null = fiberFor(element);
  while (fiber) {
    const handler = fiber.memoizedProps?.[property];
    if (typeof handler === "function") return handler as T;
    fiber = fiber.return;
  }
  throw new Error(`No ${property} handler was found`);
}

function handlerOwnedBy<T>(element: HTMLElement, property: string, owner: string): T {
  let fiber: ReactFiber | null = fiberFor(element);
  while (fiber) {
    const type = fiber.elementType;
    const name = typeof type === "string" ? type : type?.displayName ?? type?.name;
    const handler = fiber.memoizedProps?.[property];
    if (name === owner && typeof handler === "function") return handler as T;
    fiber = fiber.return;
  }
  throw new Error(`No ${property} handler owned by ${owner} was found`);
}

function reactHandler<T>(element: HTMLElement, property: string): T {
  const props = reactPropsFor(element);
  const handler = props[property];
  if (typeof handler !== "function") throw new Error(`No ${property} handler was attached`);
  return handler as T;
}

function reactPropsFor(element: HTMLElement) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached");
  return (element as unknown as Record<string, Record<string, unknown>>)[propsKey];
}

function replaceReactProps(element: HTMLElement, props: Record<string, unknown>) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached");
  (element as unknown as Record<string, Record<string, unknown>>)[propsKey] = props;
}

type ModeReactKeyEvent = ReactKeyboardEvent<HTMLButtonElement>;
type ModeReactKeyHandler = (event: ModeReactKeyEvent) => void;

function interceptModeKeyWrappers(
  element: HTMLButtonElement,
  intercept: (event: ModeReactKeyEvent, phase: "capture" | "bubble") => void,
) {
  const props = { ...reactPropsFor(element) };
  for (const [property, phase] of [
    ["onKeyDownCapture", "capture"],
    ["onKeyDown", "bubble"],
  ] as const) {
    const original = props[property];
    if (typeof original !== "function") throw new Error(`No ${property} handler was attached`);
    props[property] = (event: ModeReactKeyEvent) => {
      intercept(event, phase);
      (original as ModeReactKeyHandler)(event);
    };
  }
  replaceReactProps(element, props);
}

function makeModeWrapperPublicAndIndependent(
  event: ModeReactKeyEvent,
  phase: "capture" | "bubble",
) {
  const prototype = Object.create(Object.getPrototypeOf(event)) as object;
  Object.defineProperty(prototype, "phase", { value: phase });
  Object.setPrototypeOf(event, prototype);

  const preventDefault = event.preventDefault;
  Object.defineProperties(event, {
    preventDefault: {
      configurable: true,
      writable: true,
      value: function (this: ModeReactKeyEvent) {
        return preventDefault.call(this);
      },
    },
    isDefaultPrevented: {
      configurable: true,
      writable: true,
      value: function (this: ModeReactKeyEvent) {
        return this.defaultPrevented;
      },
    },
    isPropagationStopped: {
      configurable: true,
      writable: true,
      value: () => false,
    },
    _reactName: { configurable: true, value: null },
    persist: { configurable: true, value: undefined },
    isPersistent: { configurable: true, value: "not a function" },
    stopPropagation: { configurable: true, value: 17 },
  });

  for (const property of [
    "key",
    "code",
    "location",
    "altKey",
    "ctrlKey",
    "metaKey",
    "shiftKey",
    "repeat",
    "detail",
    "view",
  ] as const) {
    const value = event[property];
    Object.defineProperty(event, property, {
      configurable: true,
      get: () => value,
    });
  }
}

type OpenHandler = (open: boolean) => void;
type ValueHandler = (value: string) => void;
type EventHandler = (event: Event) => void;
type SourceHandler = (event: ReturnType<typeof sourceEvent>) => void;
type OutsideHandler = (event: CustomEvent<{ originalEvent: Event }>) => void;

function trigger(): HTMLButtonElement {
  const element = screen.getByTestId("mode-switcher");
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error("The mode switcher trigger is not a button");
  }
  return element;
}

function menu() {
  return screen.getByRole("menu");
}

function radio(name: "Editing" | "Suggesting" | "Viewing") {
  return screen.getByRole("menuitemradio", { name: new RegExp(name) });
}

function openMenu() {
  fireEvent(trigger(), new PointerEvent("pointerdown", {
    bubbles: true,
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  }));
  return menu();
}

function pointerDown(element: Element, event = new PointerEvent("pointerdown", {
  bubbles: true,
  button: 0,
  ctrlKey: false,
  pointerType: "mouse",
})) {
  fireEvent(element, event);
  return event;
}

function keyDown(element: Element, key: string) {
  const event = new KeyboardEvent("keydown", { bubbles: true, key });
  fireEvent(element, event);
  return event;
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

function modeArrowEvent(
  element: Element,
  key: "ArrowDown" | "ArrowUp",
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The mode trigger has no owner realm");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (trusted) markJsdomEventTrusted(event);
  return event;
}

function modeArrow(
  element: Element,
  key: "ArrowDown" | "ArrowUp",
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const event = modeArrowEvent(element, key, init, trusted);
  fireEvent(element, event);
  return event;
}

function openingFocusGuard(record: MutationRecord) {
  const node = record.addedNodes.item(0) ?? record.removedNodes.item(0);
  return node instanceof HTMLSpanElement
    && node.hasAttribute("data-radix-focus-guard")
    ? node
    : null;
}

function mutationRecordWith(
  record: MutationRecord,
  overrides: Partial<MutationRecord>,
): MutationRecord {
  return new Proxy(record, {
    get(target, property) {
      return Object.prototype.hasOwnProperty.call(overrides, property)
        ? Reflect.get(overrides, property, overrides)
        : Reflect.get(target, property, target);
    },
  });
}

function mutationNodeList(nodes: readonly Node[]): NodeList {
  const list = [...nodes] as Node[] & { item(index: number): Node | null };
  list.item = (index) => list[index] ?? null;
  return list as unknown as NodeList;
}

function observeOpeningMutations(
  transform: (records: MutationRecord[]) => MutationRecord[],
) {
  const NativeMutationObserver = window.MutationObserver;
  const descriptor = Object.getOwnPropertyDescriptor(window, "MutationObserver");
  class OpeningMutationObserver implements MutationObserver {
    readonly #observer: MutationObserver;
    #opening = false;

    constructor(callback: MutationCallback) {
      this.#observer = new NativeMutationObserver((records) => {
        callback(this.#records(records), this);
      });
    }

    disconnect() {
      this.#observer.disconnect();
    }

    observe(target: Node, options?: MutationObserverInit) {
      if (
        target === document.body
        && options?.attributes
        && options.attributeOldValue
        && options.childList
        && options.subtree
      ) {
        this.#opening = true;
      }
      this.#observer.observe(target, options);
    }

    takeRecords() {
      return this.#records(this.#observer.takeRecords());
    }

    #records(records: MutationRecord[]) {
      return this.#opening ? transform(records) : records;
    }
  }
  Object.defineProperty(window, "MutationObserver", {
    configurable: true,
    value: OpeningMutationObserver,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(window, "MutationObserver", descriptor);
    } else {
      Reflect.deleteProperty(window, "MutationObserver");
    }
  };
}

async function waitForOutsideListener() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function dispatchTrustedEscapeOutsideAct(target: HTMLElement) {
  const escape = captureEscape();
  const close = captureOpenChange();
  const event = new KeyboardEvent("keydown", { bubbles: true, key: "Escape" });
  document.addEventListener("keydown", (nativeEvent) => {
    nativeEvent.stopImmediatePropagation();
    escape(nativeEvent);
    close(false);
  }, { capture: true, once: true });
  target.dispatchEvent(event);
  return event;
}

function dispatchTrustedModeSelectionOutsideAct(
  name: "Editing" | "Suggesting" | "Viewing",
  value: EditMode,
) {
  const row = radio(name);
  const select = captureRowSelect(name);
  const change = captureModeChange();
  const event = new CustomEvent("menu.itemSelect", { cancelable: true });
  row.addEventListener("menu.itemSelect", (nativeEvent) => {
    nativeEvent.stopImmediatePropagation();
    select(nativeEvent);
    change(value);
  }, { once: true });
  row.dispatchEvent(event);
  return event;
}

function captureOpenChange(): OpenHandler {
  return nearestHandler(trigger(), "onOpenChange");
}

function captureModeChange(): ValueHandler {
  return nearestHandler(radio("Editing"), "onValueChange");
}

function captureRowSelect(name: "Editing" | "Suggesting" | "Viewing"): EventHandler {
  return handlerOwnedBy(radio(name), "onSelect", "MenuRadioItem");
}

function captureReaderSelect(): EventHandler {
  return handlerOwnedBy(screen.getByTestId("mode-reader"), "onSelect", "MenuItem");
}

function captureEscape(): (event: KeyboardEvent) => void {
  return handlerOwnedBy(menu(), "onEscapeKeyDown", "MenuContent");
}

function captureOutside(): OutsideHandler {
  return handlerOwnedBy(menu(), "onPointerDownOutside", "MenuContent");
}

function sourceEvent(currentTarget: EventTarget | null, key = "") {
  return {
    currentTarget,
    target: currentTarget,
    key,
    button: 0,
    ctrlKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    isDefaultPrevented() {
      return this.defaultPrevented;
    },
    stopPropagation: vi.fn(),
    isPropagationStopped: () => false,
  };
}

function nativeSourceEvent(
  currentTarget: EventTarget,
  nativeEvent: PointerEvent | KeyboardEvent,
  key = "",
) {
  return {
    ...sourceEvent(currentTarget, key),
    type: nativeEvent.type,
    target: nativeEvent.target,
    nativeEvent,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
  };
}

function selectEvent(currentTarget: EventTarget | null) {
  return {
    currentTarget,
    target: currentTarget,
    defaultPrevented: false,
    preventDefault: vi.fn(),
  } as unknown as Event;
}

function selectMode(name: "Editing" | "Suggesting" | "Viewing", value: EditMode) {
  void value;
  fireEvent.click(radio(name));
}

function expectNoModeAction(session: ModeSession) {
  expect(session.setMode).not.toHaveBeenCalled();
  expect(window.open).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ModeSwitcher presentation authority", () => {
  it.each([
    ["pointer", "", "stale-before-current"],
    ["pointer", "", "current-before-stale"],
    ["keyboard", "Enter", "stale-before-current"],
    ["keyboard", "Enter", "current-before-stale"],
    ["keyboard", " ", "stale-before-current"],
    ["keyboard", " ", "current-before-stale"],
    ["keyboard", "ArrowDown", "stale-before-current"],
    ["keyboard", "ArrowDown", "current-before-stale"],
    ["keyboard", "ArrowUp", "stale-before-current"],
    ["keyboard", "ArrowUp", "current-before-stale"],
  ] as const)("accepts only the current exact %s open source with %s %s", (kind, key, order) => {
    const session = new ModeSession("same-element", "owner", "editing");
    const host = document.createElement("div");
    const wrong = document.createElement("button");
    document.body.append(wrong, host);
    const root = createRoot(host);

    try {
      act(() => root.render(<ModeBoundary session={session} />));
      const reused = trigger();
      const stale = reactHandler<SourceHandler>(reused, kind === "pointer" ? "onPointerDown" : "onKeyDown");
      const staleOpen = captureOpenChange();

      act(() => root.render(<ModeBoundary session={session} revision={1} />));
      expect(trigger()).toBe(reused);
      const exactEvent = kind === "pointer"
        ? new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            ctrlKey: false,
            pointerType: "mouse",
          })
        : key === "ArrowDown" || key === "ArrowUp"
          ? modeArrowEvent(reused, key)
          : new KeyboardEvent("keydown", { bubbles: true, key });
      if (kind === "keyboard") reused.focus();
      const invokeCurrent = () => reused.dispatchEvent(exactEvent);
      const invokeStale = () => {
        stale(sourceEvent(reused, key));
        staleOpen(true);
        if (kind === "pointer") {
          reactHandler<SourceHandler>(reused, "onPointerDown")(sourceEvent(wrong, key));
        } else {
          reactHandler<SourceHandler>(reused, "onKeyDown")(sourceEvent(wrong, key));
        }
      };
      act(() => {
        if (order === "stale-before-current") {
          reused.addEventListener(exactEvent.type, (nativeEvent) => {
            stale(nativeSourceEvent(reused, nativeEvent as PointerEvent | KeyboardEvent, key));
            staleOpen(true);
          }, { capture: true, once: true });
          invokeCurrent();
          invokeCurrent();
        } else {
          invokeCurrent();
          invokeCurrent();
          invokeStale();
        }
      });

      expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
      expect(session.setMode).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("rejects bare disclosure booleans, wrong values, wrong siblings, detached controls, and foreign controls without consuming the current presentation", () => {
    const session = new ModeSession("exact-sources", "owner", "viewing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const open = captureOpenChange();

    act(() => open(true));
    expect(screen.queryByRole("menu")).toBeNull();
    openMenu();

    const editing = radio("Editing");
    const detached = document.createElement("div");
    const sibling = document.createElement("div");
    document.body.append(sibling);
    const foreign = document.implementation.createHTMLDocument("foreign").createElement("div");
    const selectEditing = captureRowSelect("Editing");
    const changeMode = captureModeChange();
    act(() => {
      selectEditing(selectEvent(sibling));
      changeMode("editing");
      selectEditing(selectEvent(detached));
      changeMode("editing");
      selectEditing(selectEvent(foreign));
      changeMode("editing");
      selectEditing(selectEvent(editing));
      changeMode("suggesting");
    });
    expect(session.setMode).not.toHaveBeenCalled();
    expect(menu()).toBeInTheDocument();

    fireEvent.click(editing);
    fireEvent.click(editing);
    expect(session.setMode).toHaveBeenCalledExactlyOnceWith("editing");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("retires an open A before child and parent layout when the exact session changes, then keeps B usable", () => {
    const sessionA = new ModeSession("document-a", "owner", "editing");
    const sessionB = new ModeSession("document-b", "editor", "viewing");
    const host = document.createElement("div");
    const focusOwner = document.createElement("button");
    document.body.append(focusOwner, host);
    const root = createRoot(host);

    try {
      act(() => root.render(<ModeBoundary session={sessionA} />));
      openMenu();
      const oldTrigger = trigger();
      const oldEditing = radio("Editing");
      const oldReader = screen.getByTestId("mode-reader");
      const stalePointer = reactHandler<SourceHandler>(oldTrigger, "onPointerDown");
      const staleOpen = captureOpenChange();
      const staleSelect = captureRowSelect("Editing");
      const staleMode = captureModeChange();
      const staleReader = captureReaderSelect();
      const boundaries: string[] = [];
      const invokeStale = (boundary: string) => {
        boundaries.push(boundary);
        focusOwner.focus();
        stalePointer(sourceEvent(oldTrigger));
        staleOpen(true);
        staleSelect(selectEvent(oldEditing));
        staleMode("editing");
        staleReader(selectEvent(oldReader));
      };

      act(() => root.render(
        <ModeBoundary
          session={sessionB}
          boundary={1}
          onChildBoundary={() => invokeStale("child")}
          onBoundary={() => invokeStale("parent")}
        />,
      ));

      expect(boundaries).toEqual(["child", "parent"]);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(focusOwner).toHaveFocus();
      expect(sessionA.setMode).not.toHaveBeenCalled();
      expect(sessionB.setMode).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();

      openMenu();
      act(() => selectMode("Suggesting", "suggesting"));
      expect(sessionB.setMode).toHaveBeenCalledExactlyOnceWith("suggesting");
      expect(sessionB.setMode.mock.contexts[0]).toBe(sessionB);

      openMenu();
      const reader = screen.getByTestId("mode-reader");
      fireEvent.click(reader);
      expect(window.open).toHaveBeenCalledExactlyOnceWith("/p/document-b", "_blank", "noopener");
    } finally {
      act(() => root.unmount());
    }
  });

  it("retires detach, reattach, replacement, removal, and unmount handlers without clearing a newer publication", () => {
    const removed = new ModeSession("removed", "owner", "editing");
    const current = new ModeSession("current", "owner", "editing");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<ModeBoundary session={removed} />));
    const oldElement = trigger();
    const oldPointer = reactHandler<SourceHandler>(oldElement, "onPointerDown");
    const oldOpen = captureOpenChange();
    const ref = fiberFor(oldElement).ref;
    if (typeof ref !== "function") throw new Error("Mode trigger callback ref was not attached");
    act(() => {
      ref(null);
      ref(oldElement);
    });
    oldPointer(sourceEvent(oldElement));
    oldOpen(true);
    expect(screen.queryByRole("menu")).toBeNull();

    act(() => root.render(<ModeBoundary session={current} revision={1} />));
    act(() => {
      oldPointer(sourceEvent(trigger()));
    });
    pointerDown(trigger());
    expect(menu()).toBeInTheDocument();

    const staleReaderElement = screen.getByTestId("mode-reader");
    const staleReader = captureReaderSelect();
    const staleModeElement = radio("Viewing");
    const staleMode = captureRowSelect("Viewing");
    const staleValue = captureModeChange();
    act(() => root.render(<ModeBoundary session={current} present={false} boundary={2} />));
    act(() => {
      staleReader(selectEvent(staleReaderElement));
      staleMode(selectEvent(staleModeElement));
      staleValue("viewing");
      oldOpen(false);
      root.unmount();
      staleReader(selectEvent(staleReaderElement));
      staleMode(selectEvent(staleModeElement));
      staleValue("viewing");
    });
    expect(removed.setMode).not.toHaveBeenCalled();
    expect(current.setMode).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("publishes viewer rows exactly and leaves disabled row events inert", () => {
    const viewer = new ModeSession("viewer", "viewer", "viewing");
    render(<ModeSwitcher session={viewer.asCollabSession()} />);
    openMenu();
    expect(radio("Editing")).toHaveAttribute("aria-disabled", "true");
    expect(radio("Suggesting")).toHaveAttribute("aria-disabled", "true");
    expect(radio("Viewing")).not.toHaveAttribute("aria-disabled");

    act(() => {
      selectMode("Editing", "editing");
      selectMode("Suggesting", "suggesting");
    });
    expect(viewer.setMode).not.toHaveBeenCalled();
    expect(menu()).toBeInTheDocument();

    act(() => selectMode("Viewing", "viewing"));
    expect(viewer.setMode).toHaveBeenCalledExactlyOnceWith("viewing");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("requires exact trigger, content, and outside close events before closing or returning focus", async () => {
    const session = new ModeSession("close-sources", "owner", "editing");
    render(
      <>
        <ModeSwitcher session={session.asCollabSession()} />
        <button type="button">Outside</button>
      </>,
    );

    const modeTrigger = trigger();
    const outside = screen.getByRole("button", { name: "Outside" });
    openMenu();
    menu().focus();

    let close = captureOpenChange();
    const triggerPointer = reactHandler<SourceHandler>(modeTrigger, "onPointerDown");
    act(() => {
      triggerPointer(sourceEvent(outside));
      close(false);
    });
    expect(menu()).toBeInTheDocument();
    expect(modeTrigger).not.toHaveFocus();

    pointerDown(modeTrigger);
    expect(screen.queryByRole("menu")).toBeNull();

    openMenu();
    menu().focus();
    close = captureOpenChange();
    const escape = captureEscape();
    const wrongEscape = {
      key: "Escape",
      target: outside,
      currentTarget: document,
      defaultPrevented: false,
    } as unknown as KeyboardEvent;
    act(() => {
      escape(wrongEscape);
      close(false);
    });
    expect(menu()).toBeInTheDocument();
    expect(modeTrigger).not.toHaveFocus();

    keyDown(radio("Editing"), "Escape");
    expect(screen.queryByRole("menu")).toBeNull();

    openMenu();
    menu().focus();
    close = captureOpenChange();
    const outsideHandler = captureOutside();
    const wrongOriginal = { target: outside } as unknown as Event;
    act(() => {
      outsideHandler({
        currentTarget: modeTrigger,
        target: modeTrigger,
        detail: { originalEvent: wrongOriginal },
        defaultPrevented: false,
      } as unknown as CustomEvent<{ originalEvent: Event }>);
      close(false);
    });
    expect(menu()).toBeInTheDocument();
    expect(modeTrigger).not.toHaveFocus();

    await waitForOutsideListener();
    pointerDown(outside);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("rejects changed doc, role, mode, and method facts until the exact frozen presentation is current again", () => {
    const session = new ModeSession("frozen-document", "owner", "viewing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    openMenu();
    const readerElement = screen.getByTestId("mode-reader");
    const reader = captureReaderSelect();
    const editingElement = radio("Editing");
    const editing = captureRowSelect("Editing");
    const changeMode = captureModeChange();
    const originalSetMode = session.setMode;
    const wrongReader = document.createElement("div");
    document.body.append(wrongReader);

    act(() => reader(selectEvent(wrongReader)));
    session.docId = "changed-document";
    act(() => reader(selectEvent(readerElement)));
    session.docId = "frozen-document";
    session.role = "viewer";
    act(() => {
      editing(selectEvent(editingElement));
      changeMode("editing");
    });
    session.role = "owner";
    session.mode = "editing";
    act(() => reader(selectEvent(readerElement)));
    session.mode = "viewing";
    session.setMode = vi.fn();
    act(() => {
      editing(selectEvent(editingElement));
      changeMode("editing");
    });
    session.setMode = originalSetMode;

    expect(originalSetMode).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(menu()).toBeInTheDocument();

    fireEvent.click(editingElement);
    expect(originalSetMode).toHaveBeenCalledExactlyOnceWith("editing");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("retires a partial row handler while a fresh complete render remains usable", () => {
    const session = new ModeSession("row-ref", "owner", "editing");
    render(<ModeBoundary session={session} />);
    openMenu();
    const rowElement = radio("Viewing");
    const staleSelect = captureRowSelect("Viewing");
    const staleValue = captureModeChange();
    const staleClose = captureOpenChange();
    const ref = fiberFor(rowElement).ref;
    if (typeof ref !== "function") throw new Error("Mode row callback ref was not attached");

    act(() => {
      ref(null);
      ref(rowElement);
    });
    act(() => {
      staleSelect(selectEvent(rowElement));
      staleValue("viewing");
      staleClose(false);
    });
    expect(session.setMode).not.toHaveBeenCalled();
    expect(menu()).toBeInTheDocument();

    fireEvent.click(rowElement);
    expect(session.setMode).toHaveBeenCalledExactlyOnceWith("viewing");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each(["attribute", "order", "portal", "portal-ancestor", "placement"] as const)(
    "permanently retires a presentation after a restored transient %s mutation",
    (mutation) => {
      const session = new ModeSession(`mutation-${mutation}`, "owner", "editing");
      render(<ModeSwitcher session={session.asCollabSession()} />);
      openMenu();
      const content = menu();
      const group = radio("Editing").parentElement;
      if (!(group instanceof HTMLDivElement)) throw new Error("Mode group was not rendered");
      const editing = radio("Editing");
      const suggesting = radio("Suggesting");

      act(() => {
        if (mutation === "attribute") {
          editing.setAttribute("role", "option");
          editing.setAttribute("role", "menuitemradio");
        } else if (mutation === "order") {
          group.insertBefore(suggesting, editing);
          group.insertBefore(editing, suggesting);
        } else if (mutation === "portal") {
          const parent = content.parentNode;
          if (!parent) throw new Error("Mode portal did not have a parent");
          parent.removeChild(content);
          parent.appendChild(content);
        } else if (mutation === "portal-ancestor") {
          const portal = content.parentNode;
          const parent = portal?.parentNode;
          if (!portal || !parent) throw new Error("Mode portal wrapper did not have a parent");
          parent.removeChild(portal);
          parent.appendChild(portal);
        } else {
          const parent = content.parentNode;
          if (!parent) throw new Error("Mode portal did not have a parent");
          const sibling = document.createElement("div");
          parent.insertBefore(sibling, content);
          sibling.remove();
        }
      });

      fireEvent.click(radio("Viewing"));
      expect(session.setMode).not.toHaveBeenCalled();
      expect(menu()).toBeInTheDocument();
    },
  );
});

describe("ModeSwitcher trusted arrow disclosure", () => {
  it.each([
    ["owner", "ArrowDown", false, "Editing"],
    ["owner", "ArrowUp", false, "reader"],
    ["viewer", "ArrowDown", false, "Viewing"],
    ["viewer", "ArrowUp", false, "reader"],
    ["owner", "ArrowDown", true, "Editing"],
    ["owner", "ArrowUp", true, "reader"],
    ["viewer", "ArrowDown", true, "Viewing"],
    ["viewer", "ArrowUp", true, "reader"],
  ] as const)(
    "opens or keeps open for a current %s %s from %s and focuses %s once",
    async (role, key, initiallyOpen, destinationName) => {
      const session = new ModeSession(
        `${role}-${key}-${initiallyOpen ? "open" : "closed"}`,
        role,
        role === "viewer" ? "viewing" : "editing",
      );
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");

      try {
        act(() => root.render(
          <StrictMode>
            <ModeSwitcher session={session.asCollabSession()} />
          </StrictMode>,
        ));
        const modeTrigger = trigger();
        if (initiallyOpen) openMenu();
        const source = initiallyOpen ? menu() : modeTrigger;
        source.focus();
        focus.mockClear();
        preventDefault.mockClear();
        document.documentElement.scrollTop = 19;
        document.documentElement.scrollLeft = 5;
        document.body.scrollTop = 13;
        document.body.scrollLeft = 3;

        const event = modeArrow(source, key);
        const destination = destinationName === "reader"
          ? screen.getByTestId("mode-reader")
          : radio(destinationName);
        await waitFor(() => expect(destination).toHaveFocus());

        expect(event.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalled();
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
        expect(focus.mock.contexts.filter((context) => context === destination)).toHaveLength(1);
        expect(document.documentElement.scrollTop).toBe(19);
        expect(document.documentElement.scrollLeft).toBe(5);
        expect(document.body.scrollTop).toBe(13);
        expect(document.body.scrollLeft).toBe(3);
        expectNoModeAction(session);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it.each([
    ["ArrowDown", "Editing", "KeyQ", 3],
    ["ArrowUp", "reader", "Numpad7", 1],
  ] as const)(
    "accepts %s through independent public phase wrappers and exact unrestricted code/location",
    async (key, destinationName, code, location) => {
      const session = new ModeSession(`public-${key}`, "owner", "editing");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const wrappers: ModeReactKeyEvent[] = [];
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");

      try {
        act(() => root.render(
          <StrictMode>
            <ModeSwitcher session={session.asCollabSession()} />
          </StrictMode>,
        ));
        const modeTrigger = trigger();
        modeTrigger.focus();
        focus.mockClear();
        preventDefault.mockClear();
        interceptModeKeyWrappers(modeTrigger, (event, phase) => {
          wrappers.push(event);
          makeModeWrapperPublicAndIndependent(event, phase);
        });

        const event = modeArrow(modeTrigger, key, { code, location });
        const destination = destinationName === "reader"
          ? screen.getByTestId("mode-reader")
          : radio(destinationName);
        await waitFor(() => expect(destination).toHaveFocus());

        expect(event.code).toBe(code);
        expect(event.location).toBe(location);
        expect(event.defaultPrevented).toBe(true);
        expect(preventDefault.mock.contexts.filter((context) => context === event)).toHaveLength(1);
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
        expect(focus.mock.contexts.filter((context) => context === destination)).toHaveLength(1);
        expect(wrappers).toHaveLength(2);
        expect(wrappers[0]).not.toBe(wrappers[1]);
        expect(Object.getPrototypeOf(wrappers[0])).not.toBe(Object.getPrototypeOf(wrappers[1]));
        expect(wrappers[0]!.preventDefault).not.toBe(wrappers[1]!.preventDefault);
        expect(wrappers[0]!.isDefaultPrevented).not.toBe(wrappers[1]!.isDefaultPrevented);
        expect(wrappers[0]!.isPropagationStopped).not.toBe(
          wrappers[1]!.isPropagationStopped,
        );
        expectNoModeAction(session);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it("retains an incomplete capture pair through nested microtask checkpoints", async () => {
    const session = new ModeSession("arrow-microtasks", "owner", "editing");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      act(() => root.render(
        <StrictMode>
          <ModeSwitcher session={session.asCollabSession()} />
        </StrictMode>,
      ));
      const modeTrigger = trigger();
      modeTrigger.focus();
      modeTrigger.addEventListener("keydown", (event) => event.stopPropagation(), {
        once: true,
      });
      const event = modeArrow(modeTrigger, "ArrowUp", { code: "KeyM", location: 2 });
      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();

      await Promise.resolve();
      await Promise.resolve();
      fireEvent(modeTrigger, event);
      await waitFor(() => expect(screen.getByTestId("mode-reader")).toHaveFocus());

      expect(event.defaultPrevented).toBe(true);
      expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
      expectNoModeAction(session);
    } finally {
      act(() => root.unmount());
    }
  });

  it("fences public query reentry without consuming the rightful pair", async () => {
    const session = new ModeSession("arrow-query-reentry", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    const nested = modeArrowEvent(modeTrigger, "ArrowDown");
    let reentered = false;
    interceptModeKeyWrappers(modeTrigger, (event, phase) => {
      if (phase !== "capture") return;
      const query = event.isDefaultPrevented;
      Object.defineProperty(event, "isDefaultPrevented", {
        configurable: true,
        writable: true,
        value: function (this: ModeReactKeyEvent) {
          if (!reentered) {
            reentered = true;
            modeTrigger.dispatchEvent(nested);
          }
          return query.call(this);
        },
      });
    });
    modeTrigger.focus();

    const rightful = modeArrow(modeTrigger, "ArrowDown");
    await waitFor(() => expect(radio("Editing")).toHaveFocus());

    expect(reentered).toBe(true);
    expect(rightful.defaultPrevented).toBe(true);
    expect(nested.defaultPrevented).toBe(false);
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expectNoModeAction(session);
  });

  it("rejects post-prevention method drift and admits a distinct clean successor", async () => {
    const session = new ModeSession("arrow-method-drift", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    let drift = true;
    interceptModeKeyWrappers(modeTrigger, (event, phase) => {
      if (phase !== "bubble" || !drift) return;
      drift = false;
      const preventDefault = event.preventDefault;
      Object.defineProperty(event, "preventDefault", {
        configurable: true,
        writable: true,
        value: function (this: ModeReactKeyEvent) {
          preventDefault.call(this);
          this.isPropagationStopped = () => false;
        },
      });
    });
    modeTrigger.focus();

    const rejected = modeArrow(modeTrigger, "ArrowUp");
    expect(rejected.defaultPrevented).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(modeTrigger).toHaveFocus();
    expectNoModeAction(session);

    const accepted = modeArrow(modeTrigger, "ArrowUp");
    await waitFor(() => expect(screen.getByTestId("mode-reader")).toHaveFocus());
    expect(accepted.defaultPrevented).toBe(true);
    expectNoModeAction(session);
  });

  it("rejects a replay after public query drift and admits a distinct clean successor", async () => {
    const session = new ModeSession("arrow-query-drift", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    let drift = true;
    interceptModeKeyWrappers(modeTrigger, (event, phase) => {
      if (phase !== "capture" || !drift) return;
      drift = false;
      Object.defineProperty(event, "isDefaultPrevented", {
        configurable: true,
        writable: true,
        value: function (this: ModeReactKeyEvent) {
          this.isDefaultPrevented = () => false;
          return false;
        },
      });
    });
    modeTrigger.focus();

    const replay = modeArrow(modeTrigger, "ArrowUp");
    expect(replay.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent(modeTrigger, replay);
    expect(replay.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();

    const successor = modeArrow(modeTrigger, "ArrowUp");
    await waitFor(() => expect(screen.getByTestId("mode-reader")).toHaveFocus());
    expect(successor.defaultPrevented).toBe(true);
    expectNoModeAction(session);
  });

  it.each([
    ["non-Strict add pair", false, 2, 0],
    ["Strict add, retire, and distinct rebind", true, 4, 2],
  ] as const)("accepts the exact %s opening history", async (_name, strict, addCount, removeCount) => {
    const session = new ModeSession(`arrow-${strict ? "strict" : "plain"}-history`, "owner", "editing");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const additions: HTMLSpanElement[] = [];
    const removals: HTMLSpanElement[] = [];
    const decorations = new Map<HTMLSpanElement, Set<string>>();
    let restoreObserver: () => void = () => undefined;

    try {
      act(() => root.render(
        strict
          ? <StrictMode><ModeSwitcher session={session.asCollabSession()} /></StrictMode>
          : <ModeSwitcher session={session.asCollabSession()} />,
      ));
      restoreObserver = observeOpeningMutations((records) => {
        for (const record of records) {
          const guard = openingFocusGuard(record);
          if (guard && record.type === "childList") {
            if (record.addedNodes.length === 1) additions.push(guard);
            if (record.removedNodes.length === 1) removals.push(guard);
          }
          if (
            record.type === "attributes"
            && record.target instanceof HTMLSpanElement
            && (
              record.attributeName === "aria-hidden"
              || record.attributeName === "data-aria-hidden"
            )
          ) {
            const names = decorations.get(record.target) ?? new Set<string>();
            names.add(`${record.attributeName}:${record.oldValue ?? "null"}`);
            decorations.set(record.target, names);
          }
        }
        return records;
      });
      const modeTrigger = trigger();
      modeTrigger.focus();
      const event = modeArrow(modeTrigger, "ArrowUp");
      await waitFor(() => expect(screen.getByTestId("mode-reader")).toHaveFocus());

      expect(event.defaultPrevented).toBe(true);
      expect(additions).toHaveLength(addCount);
      expect(removals).toHaveLength(removeCount);
      expect(new Set(additions).size).toBe(addCount);
      expect(removals).toEqual(additions.slice(0, removeCount));
      for (const guard of additions.slice(-2)) {
        expect(decorations.get(guard)).toEqual(new Set([
          "aria-hidden:null",
          "data-aria-hidden:null",
        ]));
      }
      expectNoModeAction(session);
    } finally {
      act(() => root.unmount());
      restoreObserver();
    }
  });

  it.each([
    "one-sided removal",
    "one-sided addition",
    "repeated cycle",
    "reused identity",
    "swapped edge",
    "wrong parent",
    "unrelated insertion",
    "wrong aria name",
    "wrong aria value",
    "wrong aria oldValue",
    "duplicate decoration",
    "malformed final guard",
  ] as const)("rejects a %s opening history and admits a fresh opening", async (fault) => {
    const session = new ModeSession(`arrow-guard-${fault}`, "owner", "editing");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    let poisoned = false;
    let restoreObserver: () => void = () => undefined;

    try {
      act(() => root.render(
        <StrictMode>
          <ModeSwitcher session={session.asCollabSession()} />
        </StrictMode>,
      ));
      restoreObserver = observeOpeningMutations((records) => {
        if (poisoned) return records;
        const additions = records.filter(
          (record) => record.type === "childList"
            && record.addedNodes.length === 1
            && openingFocusGuard(record),
        );
        const removals = records.filter(
          (record) => record.type === "childList"
            && record.removedNodes.length === 1
            && openingFocusGuard(record),
        );
        if (additions.length !== 4 || removals.length !== 2) return records;
        const finalStartRecord = additions[2]!;
        const finalEndRecord = additions[3]!;
        const finalStart = openingFocusGuard(finalStartRecord)!;
        const finalAttributes = records.filter(
          (record) => record.type === "attributes" && record.target === finalStart,
        );
        const finalMarker = finalAttributes.find(
          (record) => record.attributeName === "data-aria-hidden",
        )!;
        const finalAria = finalAttributes.find(
          (record) => record.attributeName === "aria-hidden",
        )!;
        poisoned = true;

        if (fault === "one-sided removal") {
          return records.filter((record) => record !== removals[1]);
        }
        if (fault === "one-sided addition") {
          return records.filter((record) => record !== finalEndRecord);
        }
        if (fault === "repeated cycle") {
          return [...records, mutationRecordWith(removals[0]!, {
            removedNodes: finalStartRecord.addedNodes,
          })];
        }
        if (fault === "reused identity") {
          return records.map((record) => record === finalStartRecord
            ? mutationRecordWith(record, { addedNodes: removals[0]!.removedNodes })
            : record);
        }
        if (fault === "swapped edge") {
          return records.map((record) => record === finalStartRecord
            ? mutationRecordWith(record, {
                nextSibling: null,
                previousSibling: document.body.firstChild,
              })
            : record);
        }
        if (fault === "wrong parent") {
          return records.map((record) => record === finalStartRecord
            ? mutationRecordWith(record, { target: host })
            : record);
        }
        if (fault === "unrelated insertion") {
          const unrelated = document.createElement("div");
          return [
            ...records,
            mutationRecordWith(finalEndRecord, {
              addedNodes: mutationNodeList([unrelated]),
            }),
          ];
        }
        if (fault === "wrong aria name") {
          return records.map((record) => record === finalMarker
            ? mutationRecordWith(record, { attributeName: "aria-label" })
            : record);
        }
        if (fault === "wrong aria value") {
          finalStart.setAttribute("aria-hidden", "false");
          return records;
        }
        if (fault === "wrong aria oldValue") {
          return records.map((record) => record === finalAria
            ? mutationRecordWith(record, { oldValue: "false" })
            : record);
        }
        if (fault === "duplicate decoration") {
          const index = records.indexOf(finalMarker);
          return [...records.slice(0, index + 1), finalMarker, ...records.slice(index + 1)];
        }
        finalStart.style.opacity = "0.5";
        return records;
      });

      const modeTrigger = trigger();
      modeTrigger.focus();
      focus.mockClear();
      const rejected = modeArrow(modeTrigger, "ArrowUp");
      const rejectedReader = screen.getByTestId("mode-reader");

      expect(poisoned).toBe(true);
      expect(rejected.defaultPrevented).toBe(true);
      expect(rejectedReader).not.toHaveFocus();
      expect(focus.mock.contexts.filter((context) => context === rejectedReader)).toHaveLength(0);
      expectNoModeAction(session);

      pointerDown(modeTrigger);
      expect(screen.queryByRole("menu")).toBeNull();
      modeTrigger.focus();
      focus.mockClear();
      const recovered = modeArrow(modeTrigger, "ArrowUp");
      const recoveredReader = screen.getByTestId("mode-reader");
      await waitFor(() => expect(recoveredReader).toHaveFocus());

      expect(recovered.defaultPrevented).toBe(true);
      expect(focus.mock.contexts.filter((context) => context === recoveredReader)).toHaveLength(1);
      expectNoModeAction(session);
    } finally {
      act(() => root.unmount());
      restoreObserver();
    }
  });

  it.each([
    ["Control", { ctrlKey: true }],
    ["Alt", { altKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["repeat", { repeat: true }],
    ["composition", { isComposing: true }],
    ["non-bubbling", { bubbles: false }],
    ["non-cancelable", { cancelable: false }],
  ] as const)("rejects %s arrows before prevention, opening, focus, or activation", (_name, init) => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const session = new ModeSession(`rejected-${_name}`, "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    modeTrigger.focus();
    for (const key of ["ArrowDown", "ArrowUp"] as const) {
      focus.mockClear();
      preventDefault.mockClear();
      const event = modeArrow(modeTrigger, key, init);

      expect(event.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(screen.queryByRole("menu")).toBeNull();
      expect(modeTrigger).toHaveFocus();
      expectNoModeAction(session);
    }
  });

  it("rejects untrusted, pre-canceled, propagation-stopped, unfocused, descendant, and foreign-realm input without spending a clean arrow", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const session = new ModeSession("rejected-provenance", "owner", "editing");
    render(
      <>
        <ModeSwitcher session={session.asCollabSession()} />
        <button type="button">Outside arrow owner</button>
      </>,
    );
    const modeTrigger = trigger();
    const outside = screen.getByRole("button", { name: "Outside arrow owner" });
    modeTrigger.focus();
    focus.mockClear();

    const untrusted = modeArrow(modeTrigger, "ArrowUp", {}, false);
    const prevented = modeArrowEvent(modeTrigger, "ArrowUp");
    prevented.preventDefault();
    preventDefault.mockClear();
    fireEvent(modeTrigger, prevented);
    const stopped = modeArrowEvent(modeTrigger, "ArrowUp");
    stopped.stopPropagation();
    fireEvent(modeTrigger, stopped);
    outside.focus();
    focus.mockClear();
    const unfocused = modeArrow(modeTrigger, "ArrowUp");
    modeTrigger.focus();
    focus.mockClear();
    const label = modeTrigger.querySelector("span");
    if (!label) throw new Error("The mode trigger label was not rendered");
    const descendant = modeArrow(label, "ArrowUp");
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const foreignWindow = iframe.contentWindow as (Window & typeof globalThis) | null;
    if (!foreignWindow) throw new Error("The iframe has no window");
    const foreign = new foreignWindow.KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });
    markJsdomEventTrusted(foreign);
    fireEvent(modeTrigger, foreign);

    expect(untrusted.defaultPrevented).toBe(false);
    expect(prevented.defaultPrevented).toBe(true);
    expect(stopped.defaultPrevented).toBe(false);
    expect(unfocused.defaultPrevented).toBe(false);
    expect(descendant.defaultPrevented).toBe(false);
    expect(foreign.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expectNoModeAction(session);

    iframe.remove();
  });

  it("rejects ineffective public native cancellation and admits a clean successor", async () => {
    const nativeFocus = vi.spyOn(HTMLElement.prototype, "focus");
    const session = new ModeSession("arrow-intrinsics", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    modeTrigger.focus();
    const dynamicPreventDefault = vi.fn();
    const event = modeArrowEvent(modeTrigger, "ArrowUp");
    Object.defineProperty(event, "preventDefault", {
      configurable: true,
      value: dynamicPreventDefault,
    });
    nativeFocus.mockClear();

    fireEvent(modeTrigger, event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(modeTrigger).toHaveFocus();
    expect(dynamicPreventDefault).toHaveBeenCalledTimes(1);
    expectNoModeAction(session);

    const accepted = modeArrow(modeTrigger, "ArrowUp");
    const reader = screen.getByTestId("mode-reader");
    await waitFor(() => expect(reader).toHaveFocus());
    expect(accepted.defaultPrevented).toBe(true);
    expect(nativeFocus.mock.contexts.filter((context) => context === reader)).toHaveLength(1);
    expect(nativeFocus).toHaveBeenCalledWith({ preventScroll: true });
    expectNoModeAction(session);
  });

  it("claims one exact arrow across native replay and a reentrant competing event", async () => {
    const readerFocus = vi.spyOn(HTMLElement.prototype, "focus");
    const session = new ModeSession("arrow-replay", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    modeTrigger.focus();
    readerFocus.mockClear();
    const replay = modeArrowEvent(modeTrigger, "ArrowUp");
    const reentrant = modeArrowEvent(modeTrigger, "ArrowUp");
    let nested = false;
    modeTrigger.addEventListener("keydown", () => {
      if (nested) return;
      nested = true;
      modeTrigger.dispatchEvent(reentrant);
    }, { once: true });

    act(() => {
      modeTrigger.dispatchEvent(replay);
      modeTrigger.dispatchEvent(replay);
    });
    const reader = screen.getByTestId("mode-reader");
    await waitFor(() => expect(reader).toHaveFocus());

    expect([replay.defaultPrevented, reentrant.defaultPrevented].filter(Boolean)).toHaveLength(1);
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(readerFocus.mock.contexts.filter((context) => context === reader)).toHaveLength(1);
    expectNoModeAction(session);
  });

  it.each([
    "attribute restoration",
    "sibling restoration",
    "replacement restoration",
    "session restoration",
  ] as const)("permanently rejects %s and admits a complete keyed successor", async (change) => {
    const session = new ModeSession(`arrow-${change}`, "owner", "editing");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      act(() => root.render(
        <StrictMode>
          <ModeBoundary key="initial" session={session} />
        </StrictMode>,
      ));
      const stale = trigger();
      stale.focus();
      if (change === "attribute restoration") {
        stale.setAttribute("aria-label", "mutated");
        stale.removeAttribute("aria-label");
      } else if (change === "sibling restoration") {
        const sibling = document.createElement("span");
        stale.parentNode?.insertBefore(sibling, stale);
        sibling.remove();
      } else if (change === "replacement restoration") {
        const parent = stale.parentNode;
        if (!parent) throw new Error("The mode trigger has no parent");
        const replacement = stale.cloneNode(true);
        parent.replaceChild(replacement, stale);
        parent.replaceChild(stale, replacement);
      } else if (change === "session restoration") {
        session.role = "viewer";
      }
      const rejected = modeArrow(stale, "ArrowUp");
      if (change === "session restoration") session.role = "owner";
      stale.focus();
      const restored = modeArrow(stale, "ArrowUp");

      expect(rejected.defaultPrevented).toBe(false);
      expect(restored.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
      expectNoModeAction(session);

      act(() => root.render(
        <StrictMode>
          <ModeBoundary key="successor" session={session} />
        </StrictMode>,
      ));
      const current = trigger();
      current.focus();
      const accepted = modeArrow(current, "ArrowUp");
      await waitFor(() => expect(screen.getByTestId("mode-reader")).toHaveFocus());
      expect(accepted.defaultPrevented).toBe(true);
      expectNoModeAction(session);
    } finally {
      act(() => root.unmount());
    }
  });

  it("rejects partial ref cleanup and admits a complete keyed successor", async () => {
    const session = new ModeSession("arrow-partial-ref", "owner", "editing");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      act(() => root.render(
        <StrictMode>
          <ModeBoundary key="initial" session={session} />
        </StrictMode>,
      ));
      const stale = trigger();
      const ref = fiberFor(stale).ref;
      if (typeof ref !== "function") throw new Error("Mode trigger callback ref was not attached");
      stale.focus();
      act(() => ref(null));

      const rejected = modeArrow(stale, "ArrowUp");
      expect(rejected.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
      expectNoModeAction(session);

      act(() => root.render(
        <StrictMode>
          <ModeBoundary key="successor" session={session} />
        </StrictMode>,
      ));
      const current = trigger();
      current.focus();
      const accepted = modeArrow(current, "ArrowUp");
      await waitFor(() => expect(screen.getByTestId("mode-reader")).toHaveFocus());
      expect(accepted.defaultPrevented).toBe(true);
      expectNoModeAction(session);
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not revive arrow authority after descriptor replacement and restoration", async () => {
    const session = new ModeSession("arrow-descriptor-history", "owner", "editing");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const descriptor = Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, "key");
    if (!descriptor?.get) throw new Error("KeyboardEvent.key getter is unavailable");

    try {
      act(() => root.render(
        <StrictMode>
          <ModeBoundary key="initial" session={session} />
        </StrictMode>,
      ));
      const stale = trigger();
      stale.focus();
      Object.defineProperty(KeyboardEvent.prototype, "key", {
        ...descriptor,
        get() {
          return descriptor.get!.call(this);
        },
      });
      const poisoned = modeArrow(stale, "ArrowUp");
      Object.defineProperty(KeyboardEvent.prototype, "key", descriptor);
      const restored = modeArrow(stale, "ArrowUp");

      expect(poisoned.defaultPrevented).toBe(false);
      expect(restored.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
      expectNoModeAction(session);

      act(() => root.render(
        <StrictMode>
          <ModeBoundary key="successor" session={session} />
        </StrictMode>,
      ));
      const current = trigger();
      current.focus();
      const accepted = modeArrow(current, "ArrowUp");
      await waitFor(() => expect(screen.getByTestId("mode-reader")).toHaveFocus());
      expect(accepted.defaultPrevented).toBe(true);
      expectNoModeAction(session);
    } finally {
      Object.defineProperty(KeyboardEvent.prototype, "key", descriptor);
      act(() => root.unmount());
    }
  });

  it("rejects a window listener call with the wrong backing receiver without spending the event", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const session = new ModeSession("arrow-window-receiver", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    const addition = add.mock.calls
      .map((call, index) => ({ call, context: add.mock.contexts[index] }))
      .find(
        ({ call, context }) =>
          call[0] === "keydown"
          && call[2] === true
          && context === window,
      );
    if (!addition || typeof addition.call[1] !== "function") {
      throw new Error("The owner-window key listener was not registered");
    }
    const event = modeArrowEvent(modeTrigger, "ArrowUp");
    modeTrigger.focus();

    Reflect.apply(addition.call[1], document, [event]);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent(modeTrigger, event);
    await waitFor(() => expect(screen.getByTestId("mode-reader")).toHaveFocus());
    expect(event.defaultPrevented).toBe(true);
    expectNoModeAction(session);
  });

  it("removes the exact owner-window listener on cleanup and leaves detached input inert", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const session = new ModeSession("arrow-cleanup", "owner", "editing");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<ModeSwitcher session={session.asCollabSession()} />));
    const stale = trigger();
    const additions = add.mock.calls
      .map((call, index) => ({ call, context: add.mock.contexts[index] }))
      .filter(
        ({ call, context }) =>
          call[0] === "keydown"
          && call[2] === true
          && context === window,
      );
    expect(additions.length).toBeGreaterThan(0);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });

    for (const { call: addition } of additions) {
      const listener = addition[1];
      const removals = remove.mock.calls
        .map((call, index) => ({ call, context: remove.mock.contexts[index] }))
        .filter(
          ({ call, context }) =>
            call[0] === "keydown"
            && call[1] === listener
            && call[2] === true
            && context === window,
        );
      expect(removals).toHaveLength(1);
    }
    stale.focus();
    const event = modeArrow(stale, "ArrowUp");
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
    expectNoModeAction(session);
  });
});

describe("ModeSwitcher current behavior", () => {
  it.each([
    ["trigger pointer", "pointer"],
    ["trigger keyboard", "keyboard"],
    ["trigger Space", "space"],
    ["Editing choice", "editing"],
    ["Suggesting choice", "suggesting"],
    ["Viewing choice", "viewing"],
    ["reader link", "reader"],
    ["Escape close", "escape"],
    ["outside close", "outside"],
  ] as const)("keeps the %s exact through direct-root Strict Mode replay", async (_name, family) => {
    const initialMode: EditMode = family === "viewing" ? "editing" : "viewing";
    const session = new ModeSession(`strict-${family}`, "owner", initialMode);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      act(() => root.render(
        <StrictMode>
          <ModeSwitcher session={session.asCollabSession()} />
          <button type="button">Strict outside</button>
        </StrictMode>,
      ));
      const modeTrigger = trigger();
      const strictOutside = screen.getByRole("button", { name: "Strict outside" });
      modeTrigger.focus();

      if (family === "pointer") {
        pointerDown(modeTrigger);
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
      } else if (family === "keyboard" || family === "space") {
        keyDown(modeTrigger, family === "keyboard" ? "Enter" : " ");
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
      } else {
        openMenu();
        if (family === "editing" || family === "suggesting" || family === "viewing") {
          const label = family === "editing" ? "Editing" : family === "suggesting" ? "Suggesting" : "Viewing";
          fireEvent.click(radio(label));
          expect(session.setMode).toHaveBeenCalledExactlyOnceWith(family);
          expect(screen.queryByRole("menu")).toBeNull();
        } else if (family === "reader") {
          fireEvent.click(screen.getByTestId("mode-reader"));
          expect(window.open).toHaveBeenCalledExactlyOnceWith(`/p/strict-${family}`, "_blank", "noopener");
          expect(screen.queryByRole("menu")).toBeNull();
        } else if (family === "escape") {
          keyDown(radio("Viewing"), "Escape");
          expect(screen.queryByRole("menu")).toBeNull();
        } else {
          await waitForOutsideListener();
          pointerDown(strictOutside);
          expect(screen.queryByRole("menu")).toBeNull();
        }
        await waitFor(() => expect(modeTrigger).toHaveFocus());
      }
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps Radix collision-placement attributes dynamic", () => {
    const session = new ModeSession("dynamic-placement", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    openMenu();

    act(() => {
      menu().setAttribute("data-side", "top");
      menu().setAttribute("data-align", "start");
    });
    fireEvent.click(radio("Viewing"));

    expect(session.setMode).toHaveBeenCalledExactlyOnceWith("viewing");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each([
    ["owner", "editing"],
    ["owner", "suggesting"],
    ["owner", "viewing"],
    ["editor", "editing"],
    ["editor", "suggesting"],
    ["editor", "viewing"],
    ["commenter", "viewing"],
    ["viewer", "viewing"],
  ] as const)("lets a current %s choose %s exactly once", (role, choice) => {
    const session = new ModeSession(`${role}-${choice}`, role, choice === "editing" ? "viewing" : "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    openMenu();

    const label = choice === "editing" ? "Editing" : choice === "suggesting" ? "Suggesting" : "Viewing";
    act(() => selectMode(label, choice));

    expect(session.setMode).toHaveBeenCalledExactlyOnceWith(choice);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each(["commenter", "viewer"] as const)(
    "rejects unknown and disabled editing modes for a current %s",
    (role) => {
      const session = new ModeSession(`${role}-disabled`, role, "viewing");
      render(<ModeSwitcher session={session.asCollabSession()} />);
      openMenu();
      const changeMode = captureModeChange();

      act(() => {
        changeMode("arbitrary");
        selectMode("Editing", "editing");
        selectMode("Suggesting", "suggesting");
      });

      expect(session.setMode).not.toHaveBeenCalled();
      expect(menu()).toBeInTheDocument();
    },
  );

  it.each(["owner", "editor"] as const)("keeps Editing and Suggesting enabled for a current %s", (role) => {
    const session = new ModeSession(`${role}-permissions`, role, "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    openMenu();

    expect(radio("Editing")).not.toHaveAttribute("aria-disabled");
    expect(radio("Suggesting")).not.toHaveAttribute("aria-disabled");
    expect(radio("Viewing")).not.toHaveAttribute("aria-disabled");
  });

  it("preserves labels, descriptions, styling, alignment, icons, and live session mode updates", () => {
    const session = new ModeSession("live-mode", "owner", "suggesting");
    render(<ModeSwitcher session={session.asCollabSession()} />);

    expect(trigger()).toHaveTextContent("Suggesting");
    expect(trigger()).toHaveClass("border-green-200", "bg-green-50", "text-green-800");
    expect(trigger().querySelector(".lucide-message-square-plus")).not.toBeNull();
    openMenu();

    const content = menu();
    expect(content).toHaveClass("w-64");
    expect(content).toHaveAttribute("data-align", "end");
    expect(radio("Editing")).toHaveTextContent("Edit the document directly");
    expect(radio("Suggesting")).toHaveTextContent("Edits become suggestions others can accept");
    expect(radio("Viewing")).toHaveTextContent("Read or print the final document");
    expect(screen.getAllByRole("menuitemradio").map((row) => row.textContent?.replace(/^✓/, ""))).toEqual([
      "EditingEdit the document directly",
      "SuggestingEdits become suggestions others can accept",
      "ViewingRead or print the final document",
    ]);
    expect(radio("Suggesting")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("mode-reader")).toHaveTextContent("Open reader view");

    act(() => session.setExternalMode("editing"));

    expect(trigger()).toHaveTextContent("Editing");
    expect(trigger()).toHaveClass("border-line-2", "bg-surface", "text-ink-2");
    expect(trigger()).not.toHaveClass("border-green-200");
    expect(trigger().querySelector(".lucide-pen-line")).not.toBeNull();
    expect(radio("Editing")).toHaveAttribute("aria-checked", "true");
    expect(radio("Suggesting")).toHaveAttribute("aria-checked", "false");
  });

  it("opens the current reader exactly once with the current document", async () => {
    const session = new ModeSession("reader-current", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    modeTrigger.focus();
    openMenu();

    const reader = screen.getByTestId("mode-reader");
    const selectReader = captureReaderSelect();
    const event = selectEvent(reader);
    fireEvent.click(reader);
    await waitFor(() => expect(modeTrigger).toHaveFocus());
    act(() => {
      selectReader(event);
      selectReader(event);
    });

    expect(window.open).toHaveBeenCalledExactlyOnceWith("/p/reader-current", "_blank", "noopener");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each([
    ["Escape", "escape"],
    ["mode selection", "mode"],
  ] as const)("returns focus once after a trusted %s commits beyond the event microtask", async (_name, family) => {
    const session = new ModeSession(`${family}-focus-order`, "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    openMenu();
    const viewing = radio("Viewing");
    viewing.focus();
    const focus = vi.spyOn(modeTrigger, "focus");

    if (family === "escape") {
      dispatchTrustedEscapeOutsideAct(viewing);
    } else {
      dispatchTrustedModeSelectionOutsideAct("Viewing", "viewing");
    }
    await Promise.resolve();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    if (family === "mode") {
      expect(session.setMode).toHaveBeenCalledExactlyOnceWith("viewing");
    }
    expect(focus).toHaveBeenCalledTimes(1);
    expect(modeTrigger).toHaveFocus();
  });

  it.each([
    ["Escape", "retained", "escape"],
    ["Escape", "restored", "escape"],
    ["mode selection", "retained", "mode"],
    ["mode selection", "restored", "mode"],
  ] as const)(
    "does not focus after a trusted %s with a %s adjacent sibling mutation",
    async (_name, mutation, family) => {
      const session = new ModeSession(`${family}-${mutation}-adjacent-focus`, "owner", "editing");
      render(<ModeSwitcher session={session.asCollabSession()} />);
      const modeTrigger = trigger();
      const parent = modeTrigger.parentNode;
      if (!parent) throw new Error("Mode trigger did not have a parent");
      openMenu();
      const viewing = radio("Viewing");
      viewing.focus();
      const focus = vi.spyOn(modeTrigger, "focus");

      if (family === "escape") {
        dispatchTrustedEscapeOutsideAct(viewing);
      } else {
        dispatchTrustedModeSelectionOutsideAct("Viewing", "viewing");
      }
      const adjacent = document.createElement("span");
      parent.insertBefore(adjacent, modeTrigger.nextSibling);
      if (mutation === "restored") adjacent.remove();
      await Promise.resolve();
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      if (family === "mode") {
        expect(session.setMode).toHaveBeenCalledExactlyOnceWith("viewing");
      }
      expect(focus).not.toHaveBeenCalled();
      adjacent.remove();
    },
  );

  it.each([
    ["Escape", "escape"],
    ["mode selection", "mode"],
  ] as const)("keeps one focus after a trusted %s with a nonadjacent sibling mutation", async (_name, family) => {
    const session = new ModeSession(`${family}-nonadjacent-focus`, "owner", "editing");
    render(
      <>
        <ModeSwitcher session={session.asCollabSession()} />
        <span data-testid="mode-sibling-buffer" />
      </>,
    );
    const modeTrigger = trigger();
    const parent = modeTrigger.parentNode;
    if (!parent) throw new Error("Mode trigger did not have a parent");
    openMenu();
    const viewing = radio("Viewing");
    viewing.focus();
    const focus = vi.spyOn(modeTrigger, "focus");

    if (family === "escape") {
      dispatchTrustedEscapeOutsideAct(viewing);
    } else {
      dispatchTrustedModeSelectionOutsideAct("Viewing", "viewing");
    }
    const nonadjacent = document.createElement("span");
    parent.appendChild(nonadjacent);
    await Promise.resolve();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    if (family === "mode") {
      expect(session.setMode).toHaveBeenCalledExactlyOnceWith("viewing");
    }
    expect(focus).toHaveBeenCalledTimes(1);
    expect(modeTrigger).toHaveFocus();
    nonadjacent.remove();
  });

  it("returns focus once when the trusted current trigger toggles the menu closed", async () => {
    const session = new ModeSession("trigger-close-focus", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    openMenu();
    menu().focus();
    const focus = vi.spyOn(modeTrigger, "focus");

    pointerDown(modeTrigger);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    expect(focus).toHaveBeenCalledTimes(1);
    expect(modeTrigger).toHaveFocus();
  });

  it.each(["replaced", "mutated"] as const)(
    "does not focus a %s stale trigger after a trusted Escape close",
    async (change) => {
      const session = new ModeSession(`stale-focus-${change}`, "owner", "editing");
      render(<ModeSwitcher session={session.asCollabSession()} />);
      const modeTrigger = trigger();
      openMenu();
      const viewing = radio("Viewing");
      viewing.focus();
      const staleFocus = vi.spyOn(modeTrigger, "focus");
      const replacement = modeTrigger.cloneNode(true) as HTMLButtonElement;
      const replacementFocus = vi.spyOn(replacement, "focus");
      const ref = fiberFor(modeTrigger).ref;
      if (typeof ref !== "function") throw new Error("Mode trigger callback ref was not attached");

      dispatchTrustedEscapeOutsideAct(viewing);
      if (change === "replaced") {
        ref(null);
        ref(replacement);
      } else {
        modeTrigger.setAttribute("aria-label", "stale mode trigger");
      }
      await Promise.resolve();
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      expect(staleFocus).not.toHaveBeenCalled();
      expect(replacementFocus).not.toHaveBeenCalled();
    },
  );

  it("does not focus a mode-changing trigger with an unrelated pending mutation", async () => {
    const session = new ModeSession("mode-change-stale-focus", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    openMenu();
    radio("Viewing").focus();
    const focus = vi.spyOn(modeTrigger, "focus");

    dispatchTrustedModeSelectionOutsideAct("Viewing", "viewing");
    modeTrigger.setAttribute("aria-label", "mutated while close was pending");
    await Promise.resolve();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    expect(session.setMode).toHaveBeenCalledExactlyOnceWith("viewing");
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(["style", "tabindex", "svg", "label"] as const)(
    "rejects a pending trusted focus after a transient %s mutation",
    async (mutation) => {
      const session = new ModeSession(`pending-focus-${mutation}`, "owner", "editing");
      render(<ModeSwitcher session={session.asCollabSession()} />);
      const modeTrigger = trigger();
      openMenu();
      radio("Viewing").focus();
      const focus = vi.spyOn(modeTrigger, "focus");

      if (mutation === "style" || mutation === "tabindex") {
        dispatchTrustedEscapeOutsideAct(radio("Viewing"));
        if (mutation === "style") {
          modeTrigger.style.visibility = "hidden";
        } else {
          modeTrigger.tabIndex = -1;
        }
      } else {
        dispatchTrustedModeSelectionOutsideAct("Viewing", "viewing");
        if (mutation === "svg") {
          modeTrigger.querySelector("svg")?.setAttribute("stroke", "tomato");
        } else {
          const label = modeTrigger.children.item(1);
          if (!label) throw new Error("Mode trigger label was not rendered");
          label.textContent = "Corrupted";
        }
      }
      await Promise.resolve();
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      expect(focus).not.toHaveBeenCalled();
    },
  );

  it("preserves keyboard selection, Escape and outside close, and trigger focus return", async () => {
    const session = new ModeSession("keyboard-current", "editor", "editing");
    render(
      <>
        <ModeSwitcher session={session.asCollabSession()} />
        <button type="button">Outside control</button>
      </>,
    );
    const modeTrigger = trigger();
    const outside = screen.getByRole("button", { name: "Outside control" });
    modeTrigger.focus();

    modeArrow(modeTrigger, "ArrowDown");
    await waitFor(() => expect(radio("Editing")).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}");
    expect(radio("Suggesting")).toHaveFocus();
    await userEvent.keyboard("{Enter}");

    expect(session.setMode).toHaveBeenCalledExactlyOnceWith("suggesting");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(modeTrigger).toHaveFocus());

    await userEvent.click(modeTrigger);
    await waitFor(() => expect(menu()).toBeInTheDocument());
    fireEvent.keyDown(radio("Suggesting"), { key: "Escape", shiftKey: true });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(modeTrigger).toHaveFocus());

    await userEvent.click(modeTrigger);
    await waitFor(() => expect(menu()).toBeInTheDocument());
    menu().focus();
    await waitForOutsideListener();
    pointerDown(outside, new PointerEvent("pointerdown", {
      bubbles: true,
      button: 2,
      pointerType: "mouse",
    }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(modeTrigger).not.toHaveFocus();

    await userEvent.click(modeTrigger);
    await waitFor(() => expect(menu()).toBeInTheDocument());
    outside.addEventListener("pointerdown", (event) => event.preventDefault(), { once: true });
    pointerDown(outside);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("keeps one controlled menu when the same current trigger event and callback are replayed", () => {
    const session = new ModeSession("single-disclosure", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    const openEvent = new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });

    act(() => {
      modeTrigger.dispatchEvent(openEvent);
      modeTrigger.dispatchEvent(openEvent);
    });
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    const closeEvent = new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });

    act(() => {
      modeTrigger.dispatchEvent(closeEvent);
      modeTrigger.dispatchEvent(closeEvent);
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
