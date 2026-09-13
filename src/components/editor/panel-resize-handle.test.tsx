// @vitest-environment jsdom
import {
  StrictMode,
  useLayoutEffect,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PanelResizeHandle,
  PANEL_BIG_STEP,
  PANEL_DEFAULT,
  PANEL_MAX,
  PANEL_MIN,
  PANEL_STEP,
  clampPanelWidth,
  panelMaxFor,
  parseStoredPanelWidth,
} from "./panel-resize-handle";

type HandleProps = ComponentProps<typeof PanelResizeHandle>;
type HandlePointer = (event: ReactPointerEvent<HTMLDivElement>) => void;
type HandleKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => void;
type HandleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => void;
type HandleRef<T extends HTMLElement> = (element: T | null) => void;

interface HandleHandlers {
  readonly pointerDown: HandlePointer;
  readonly pointerMove: HandlePointer;
  readonly pointerUp: HandlePointer;
  readonly pointerCancel: HandlePointer;
  readonly lostPointerCapture: HandlePointer;
  readonly keyDownCapture: HandleKeyboard;
  readonly keyDown: HandleKeyboard;
  readonly doubleClick: HandleDoubleClick;
}

interface BoundaryProps extends Partial<HandleProps> {
  readonly instance?: string;
  readonly present?: boolean;
  readonly boundary?: number;
  readonly onBoundary?: () => void;
}

const setPointerCapture = vi.fn();
const releasePointerCapture = vi.fn();
const roots = new Set<Root>();
const hosts = new Set<HTMLElement>();
let restoreExactWindowRealm: (() => void) | null = null;

const REACT_KEY_SCALARS = [
  "type",
  "nativeEvent",
  "target",
  "currentTarget",
  "eventPhase",
  "bubbles",
  "cancelable",
  "defaultPrevented",
  "isTrusted",
  "timeStamp",
  "detail",
  "key",
  "code",
  "location",
  "ctrlKey",
  "metaKey",
  "altKey",
  "shiftKey",
  "repeat",
  "isComposing",
  "view",
] as const;

function ResizeBoundary({
  instance = "resize",
  present = true,
  boundary = 0,
  onBoundary,
  width = PANEL_DEFAULT,
  min = PANEL_MIN,
  max = PANEL_MAX,
  onResize = vi.fn(),
  onReset = vi.fn(),
}: BoundaryProps) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? (
    <section data-testid="resize-higher-ancestor">
      <div data-testid="resize-parent">
        <PanelResizeHandle
          key={instance}
          width={width}
          min={min}
          max={max}
          onResize={onResize}
          onReset={onReset}
        />
      </div>
    </section>
  ) : null;
}

function strictView(props: BoundaryProps = {}, withSentinels = false) {
  const host = document.createElement("div");
  if (withSentinels) {
    const before = document.createElement("i");
    const after = document.createElement("i");
    before.dataset.sentinel = "before";
    after.dataset.sentinel = "after";
    document.body.append(before, host, after);
    hosts.add(before);
    hosts.add(after);
  } else {
    document.body.append(host);
  }
  hosts.add(host);
  const root = createRoot(host);
  roots.add(root);
  act(() => {
    root.render(
      <StrictMode>
        <ResizeBoundary {...props} />
      </StrictMode>,
    );
  });
  return { host, root };
}

function renderStrict(root: Root, props: BoundaryProps) {
  act(() => {
    root.render(
      <StrictMode>
        <ResizeBoundary {...props} />
      </StrictMode>,
    );
  });
}

function currentHandle(host?: HTMLElement) {
  const handle = host
    ? host.querySelector<HTMLElement>('[data-testid="panel-resize-handle"]')
    : screen.queryByTestId("panel-resize-handle");
  if (!(handle instanceof HTMLDivElement)) {
    throw new Error("The panel resize handle was not rendered");
  }
  return handle;
}

function currentLine(handle: HTMLDivElement) {
  const line = handle.firstElementChild;
  if (!(line instanceof HTMLSpanElement)) {
    throw new Error("The panel resize line was not rendered");
  }
  return line;
}

function reactPropsEntry(element: Element) {
  const key = Object.keys(element).find((candidate) =>
    candidate.startsWith("__reactProps$"));
  if (!key) throw new Error("React props were not attached to the handle");
  const record = element as unknown as Record<string, Record<string, unknown>>;
  return { key, record, props: record[key]! };
}

function reactHandler<T>(element: Element, name: string): T {
  const handler = reactPropsEntry(element).props[name];
  if (typeof handler !== "function") {
    throw new Error(`${name} was not attached to the handle`);
  }
  return handler as T;
}

function reactRef<T extends HTMLElement>(element: T): HandleRef<T> {
  const ref = reactPropsEntry(element).props.ref;
  if (typeof ref !== "function") {
    throw new Error("A callback ref was not attached to the handle");
  }
  return ref as HandleRef<T>;
}

function handlers(handle: HTMLDivElement): HandleHandlers {
  return {
    pointerDown: reactHandler(handle, "onPointerDown"),
    pointerMove: reactHandler(handle, "onPointerMove"),
    pointerUp: reactHandler(handle, "onPointerUp"),
    pointerCancel: reactHandler(handle, "onPointerCancel"),
    lostPointerCapture: reactHandler(handle, "onLostPointerCapture"),
    keyDownCapture: reactHandler(handle, "onKeyDownCapture"),
    keyDown: reactHandler(handle, "onKeyDown"),
    doubleClick: reactHandler(handle, "onDoubleClick"),
  };
}

function intercept<T>(
  element: Element,
  name: string,
  invoke: (current: T, event: unknown) => void,
) {
  const { key, record, props } = reactPropsEntry(element);
  const current = props[name];
  if (typeof current !== "function") {
    throw new Error(`${name} was not attached to the handle`);
  }
  const intercepted = {
    ...props,
    [name]: (event: unknown) => invoke(current as T, event),
  };
  record[key] = intercepted;
  return () => {
    if (record[key] === intercepted) record[key] = props;
  };
}

function pointerDown(
  target: Element,
  pointerId: number,
  clientX: number,
  pointerType = "mouse",
) {
  fireEvent.pointerDown(target, {
    pointerId,
    pointerType,
    clientX,
    button: 0,
    buttons: 1,
    isPrimary: true,
  });
}

function pointerMove(
  target: Element,
  pointerId: number,
  clientX: number,
  pointerType = "mouse",
) {
  fireEvent.pointerMove(target, {
    pointerId,
    pointerType,
    clientX,
    button: -1,
    buttons: 1,
    isPrimary: true,
  });
}

function pointerUp(
  target: Element,
  pointerId: number,
  pointerType = "mouse",
) {
  fireEvent.pointerUp(target, {
    pointerId,
    pointerType,
    button: 0,
    buttons: 0,
    isPrimary: true,
  });
}

function pointerCancel(
  target: Element,
  pointerId: number,
  pointerType = "mouse",
) {
  fireEvent.pointerCancel(target, {
    pointerId,
    pointerType,
    button: 0,
    buttons: 0,
    isPrimary: true,
  });
}

function lostPointerCapture(
  target: Element,
  pointerId: number,
  pointerType = "mouse",
) {
  fireEvent.lostPointerCapture(target, {
    pointerId,
    pointerType,
    button: 0,
    buttons: 0,
    isPrimary: true,
  });
}

function doubleClick(target: Element) {
  fireEvent.doubleClick(target, {
    button: 0,
    buttons: 0,
    detail: 2,
  });
}

function eventImplementation(event: Event) {
  return Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find(
      (candidate): candidate is { isTrusted: boolean; view: Window | null } =>
        typeof candidate === "object"
        && candidate !== null
        && "isTrusted" in candidate
        && typeof candidate.isTrusted === "boolean"
        && "view" in candidate,
    );
}

function trustKeyboardEvent(event: KeyboardEvent, ownerWindow: Window) {
  const implementation = eventImplementation(event);
  const descriptor = implementation
    ? Object.getOwnPropertyDescriptor(implementation, "isTrusted")
    : undefined;
  if (!implementation || !descriptor?.writable) {
    throw new Error("Unable to set jsdom's internal event trust slot");
  }
  implementation.view = ownerWindow;
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  if (!event.isTrusted || event.view !== ownerWindow) {
    throw new Error("The trusted owner-realm keyboard event was not created");
  }
}

function keyboardEvent(
  target: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
) {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The handle owner Window was unavailable");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    code: key,
    key,
    ...init,
  });
  trustKeyboardEvent(event, ownerWindow);
  return event;
}

function keyDown(
  target: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
) {
  const event = keyboardEvent(target, key, init);
  act(() => {
    target.focus();
    target.dispatchEvent(event);
  });
  return event;
}

function exposeKeyScalarsAsAccessors(event: object) {
  const record = event as Record<PropertyKey, unknown>;
  for (const property of REACT_KEY_SCALARS) {
    let value = record[property];
    Object.defineProperty(event, property, {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (next) => {
        value = next;
      },
    });
  }
}

function useExactWindowListenerRealm() {
  if (restoreExactWindowRealm) return;
  const exposedWindow = document.defaultView;
  if (!exposedWindow) throw new Error("Document default view was unavailable");
  let listenerReceiver: Window | null = null;
  const observeReceiver = function (this: Window, event: Event) {
    if (event.currentTarget !== this) {
      throw new Error("Window listener receiver did not match currentTarget");
    }
    listenerReceiver = event.currentTarget as Window;
  };
  exposedWindow.addEventListener(
    "panel-resize-window-probe",
    observeReceiver,
    { once: true },
  );
  exposedWindow.dispatchEvent(
    new exposedWindow.Event("panel-resize-window-probe"),
  );
  if (!listenerReceiver) throw new Error("Window listener receiver was unavailable");
  const ownDescriptor = Object.getOwnPropertyDescriptor(document, "defaultView");
  Object.defineProperty(document, "defaultView", {
    configurable: true,
    value: listenerReceiver,
  });
  restoreExactWindowRealm = () => {
    if (ownDescriptor) {
      Object.defineProperty(document, "defaultView", ownDescriptor);
    } else {
      Reflect.deleteProperty(document, "defaultView");
    }
    restoreExactWindowRealm = null;
  };
}

async function flushMutations() {
  await act(async () => {
    await Promise.resolve();
  });
}

function captureFirstStrictHandlers(
  props: BoundaryProps,
): {
  readonly view: ReturnType<typeof strictView>;
  readonly stale: HandleHandlers;
  readonly handle: HTMLDivElement;
  readonly current: HandleHandlers;
} {
  const stale: { value: HandleHandlers | null } = { value: null };
  const view = strictView({
    ...props,
    boundary: 1,
    onBoundary: () => {
      stale.value ??= handlers(currentHandle());
      props.onBoundary?.();
    },
  });
  const handle = currentHandle(view.host);
  const current = handlers(handle);
  const captured = stale.value;
  if (!captured) throw new Error("Strict Mode did not run the first layout");
  expect(current.pointerDown).not.toBe(captured.pointerDown);
  return { view, stale: captured, handle, current };
}

beforeEach(() => {
  Element.prototype.setPointerCapture = setPointerCapture;
  Element.prototype.releasePointerCapture = releasePointerCapture;
});

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount());
  }
  roots.clear();
  for (const host of hosts) host.remove();
  hosts.clear();
  Element.prototype.setPointerCapture = setPointerCapture;
  Element.prototype.releasePointerCapture = releasePointerCapture;
  setPointerCapture.mockReset();
  releasePointerCapture.mockReset();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  restoreExactWindowRealm?.();
});

describe("PanelResizeHandle", () => {
  it("preserves the exact separator presentation and keyboard semantics after Strict Mode replay", () => {
    const onResize = vi.fn();
    const onReset = vi.fn();
    const { handle } = captureFirstStrictHandlers({ onResize, onReset });

    expect(handle).toHaveAttribute("role", "separator");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-label", "Resize panel");
    expect(handle).toHaveAttribute("aria-valuemin", String(PANEL_MIN));
    expect(handle).toHaveAttribute("aria-valuemax", String(PANEL_MAX));
    expect(handle).toHaveAttribute("aria-valuenow", String(PANEL_DEFAULT));
    expect(handle).toHaveAttribute("aria-valuetext", `${PANEL_DEFAULT} pixels`);
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).not.toHaveAttribute("data-dragging");
    expect(handle.childNodes).toHaveLength(1);
    expect(currentLine(handle)).toHaveAttribute("aria-hidden", "true");

    keyDown(handle, "ArrowLeft");
    keyDown(handle, "ArrowRight", { shiftKey: true });
    keyDown(handle, "Home");
    keyDown(handle, "End");
    keyDown(handle, "Enter");
    doubleClick(handle);
    keyDown(handle, "ArrowUp");

    expect(onResize.mock.calls).toEqual([
      [PANEL_DEFAULT + PANEL_STEP],
      [PANEL_MIN],
      [PANEL_MIN],
      [PANEL_MAX],
    ]);
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["ArrowLeft", false, 340, 356, false],
    ["ArrowLeft", true, 340, 404, false],
    ["ArrowRight", false, 340, 324, false],
    ["ArrowRight", true, 340, 280, false],
    ["ArrowLeft", true, 700, PANEL_MAX, false],
    ["ArrowRight", true, 300, PANEL_MIN, false],
    ["Home", false, 500, PANEL_MIN, false],
    ["End", false, 500, PANEL_MAX, false],
    ["Enter", false, 500, null, true],
  ] as const)(
    "uses the exact public-keyboard result for %s (Shift %s)",
    (key, shiftKey, width, expected, reset) => {
      const onResize = vi.fn();
      const onReset = vi.fn();
      const view = strictView({ width, onResize, onReset });
      const handle = currentHandle(view.host);
      const parent = handle.parentElement;
      if (!parent) throw new Error("The resize handle parent was unavailable");
      parent.scrollLeft = 13;
      parent.scrollTop = 17;
      const pageScroll = [window.scrollX, window.scrollY] as const;

      const event = keyDown(handle, key, { shiftKey });

      expect(event.defaultPrevented).toBe(true);
      expect(parent.scrollLeft).toBe(13);
      expect(parent.scrollTop).toBe(17);
      expect([window.scrollX, window.scrollY]).toEqual(pageScroll);
      if (reset) {
        expect(onReset).toHaveBeenCalledOnce();
        expect(onResize).not.toHaveBeenCalled();
      } else {
        expect(onResize).toHaveBeenCalledExactlyOnceWith(expected);
        expect(onReset).not.toHaveBeenCalled();
      }
    },
  );

  it("retains exact public methods and prevents once before one callback", () => {
    const onResize = vi.fn();
    const view = strictView({ onResize });
    const handle = currentHandle(view.host);
    let retainedPrevent: ((this: object) => unknown) | null = null;
    const prevent = vi.fn(function (this: object) {
      if (!retainedPrevent) throw new Error("No public preventDefault was retained");
      return Reflect.apply(retainedPrevent, this, []);
    });
    const install = (event: unknown) => {
      const wrapper = event as Record<PropertyKey, unknown>;
      if (!retainedPrevent) {
        if (typeof wrapper.preventDefault !== "function") {
          throw new Error("React preventDefault was unavailable");
        }
        retainedPrevent = wrapper.preventDefault as (this: object) => unknown;
      }
      Object.defineProperty(wrapper, "preventDefault", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: prevent,
      });
    };
    const stopCapture = intercept<HandleKeyboard>(
      handle,
      "onKeyDownCapture",
      (current, event) => {
        install(event);
        current(event as ReactKeyboardEvent<HTMLDivElement>);
      },
    );
    const stopBubble = intercept<HandleKeyboard>(
      handle,
      "onKeyDown",
      (current, event) => {
        install(event);
        current(event as ReactKeyboardEvent<HTMLDivElement>);
      },
    );

    const event = keyDown(handle, "ArrowLeft");
    stopBubble();
    stopCapture();

    expect(event.defaultPrevented).toBe(true);
    expect(prevent).toHaveBeenCalledOnce();
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
  });

  it("admits exact public scalar accessors on both React deliveries", () => {
    const onResize = vi.fn();
    const view = strictView({ onResize });
    const handle = currentHandle(view.host);
    const wrappers: object[] = [];
    const expose = (
      current: HandleKeyboard,
      event: unknown,
    ) => {
      exposeKeyScalarsAsAccessors(event as object);
      wrappers.push(event as object);
      current(event as ReactKeyboardEvent<HTMLDivElement>);
    };
    const stopCapture = intercept<HandleKeyboard>(
      handle,
      "onKeyDownCapture",
      expose,
    );
    const stopBubble = intercept<HandleKeyboard>(
      handle,
      "onKeyDown",
      expose,
    );

    const event = keyDown(handle, "ArrowLeft");
    stopBubble();
    stopCapture();

    expect(wrappers).toHaveLength(2);
    expect(wrappers[0]).not.toBe(wrappers[1]);
    for (const wrapper of wrappers) {
      for (const property of REACT_KEY_SCALARS) {
        expect(Object.getOwnPropertyDescriptor(wrapper, property)?.get)
          .toBeTypeOf("function");
      }
    }
    expect(event.defaultPrevented).toBe(true);
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
  });

  it.each(["absent", "replaced", "non-function", "unreadable"] as const)(
    "does not authenticate %s private or optional wrapper fields",
    (variant) => {
      const onResize = vi.fn();
      const view = strictView({ onResize });
      const handle = currentHandle(view.host);
      const mutate = (
        current: HandleKeyboard,
        event: unknown,
      ) => {
        for (const property of [
          "_reactName",
          "persist",
          "isPersistent",
          "stopPropagation",
        ]) {
          if (variant === "absent") {
            Reflect.deleteProperty(event as object, property);
          } else if (variant === "unreadable") {
            Object.defineProperty(event as object, property, {
              configurable: true,
              get: () => {
                throw new Error(`${property} must not be read for keydown`);
              },
            });
          } else {
            Object.defineProperty(event as object, property, {
              configurable: true,
              enumerable: true,
              writable: true,
              value: variant === "replaced" ? vi.fn() : null,
            });
          }
        }
        current(event as ReactKeyboardEvent<HTMLDivElement>);
      };
      const stopCapture = intercept<HandleKeyboard>(
        handle,
        "onKeyDownCapture",
        mutate,
      );
      const stopBubble = intercept<HandleKeyboard>(
        handle,
        "onKeyDown",
        mutate,
      );

      const event = keyDown(handle, "ArrowLeft");
      stopBubble();
      stopCapture();

      expect(event.defaultPrevented).toBe(true);
      expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
    },
  );

  it("accepts the event-proven Window listener receiver", () => {
    useExactWindowListenerRealm();
    const onResize = vi.fn();
    const view = strictView({ onResize });
    const handle = currentHandle(view.host);

    const event = keyDown(handle, "ArrowLeft");

    expect(event.defaultPrevented).toBe(true);
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
  });

  it("rejects untrusted, wrong-focus, and foreign-realm native events", () => {
    const onResize = vi.fn();
    const outside = document.createElement("button");
    const frame = document.createElement("iframe");
    document.body.append(outside, frame);
    hosts.add(outside);
    hosts.add(frame);
    const foreignWindow = frame.contentWindow as
      | (Window & typeof globalThis)
      | null;
    if (!foreignWindow) throw new Error("The foreign Window was unavailable");
    const view = strictView({ onResize });
    const handle = currentHandle(view.host);
    const ownerWindow = handle.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("The handle owner Window was unavailable");
    handle.focus();
    const untrusted = new ownerWindow.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: "ArrowLeft",
    });
    act(() => handle.dispatchEvent(untrusted));

    outside.focus();
    const wrongFocus = keyboardEvent(handle, "ArrowLeft");
    act(() => handle.dispatchEvent(wrongFocus));

    const foreign = new foreignWindow.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: "ArrowLeft",
    });
    trustKeyboardEvent(foreign, foreignWindow);
    handle.focus();
    act(() => handle.dispatchEvent(foreign));

    expect(untrusted.defaultPrevented).toBe(false);
    expect(wrongFocus.defaultPrevented).toBe(false);
    expect(foreign.defaultPrevented).toBe(false);
    expect(onResize).not.toHaveBeenCalled();
    const accepted = keyDown(handle, "ArrowLeft");
    expect(accepted.defaultPrevented).toBe(true);
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
  });

  it("does no callback work for a natively cancelled key", () => {
    let handle: HTMLDivElement | null = null;
    const cancel = (event: Event) => {
      if (event.target === handle) event.preventDefault();
    };
    document.addEventListener("keydown", cancel, true);
    try {
      const onResize = vi.fn();
      const view = strictView({ onResize });
      handle = currentHandle(view.host);

      const rejected = keyDown(handle, "ArrowLeft");

      expect(rejected.defaultPrevented).toBe(true);
      expect(onResize).not.toHaveBeenCalled();
      document.removeEventListener("keydown", cancel, true);
      const accepted = keyDown(handle, "ArrowLeft");
      expect(accepted.defaultPrevented).toBe(true);
      expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
    } finally {
      document.removeEventListener("keydown", cancel, true);
    }
  });

  it("claims a Strict Mode drag once before stale, repeated, and fabricated start work", () => {
    const onResize = vi.fn();
    const { stale, handle, current } = captureFirstStrictHandlers({ onResize });
    const stopIntercept = intercept<HandlePointer>(
      handle,
      "onPointerDown",
      (start, event) => {
        stale.pointerDown(event as ReactPointerEvent<HTMLDivElement>);
        start({ ...(event as object) } as ReactPointerEvent<HTMLDivElement>);
        start(event as ReactPointerEvent<HTMLDivElement>);
        stale.pointerDown(event as ReactPointerEvent<HTMLDivElement>);
        current.pointerDown(event as ReactPointerEvent<HTMLDivElement>);
      },
    );

    pointerDown(currentLine(handle), 11, 800);
    stopIntercept();
    expect(setPointerCapture).toHaveBeenCalledExactlyOnceWith(11);
    expect(setPointerCapture.mock.contexts[0]).toBe(handle);
    expect(handle).toHaveAttribute("data-dragging", "true");
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    const stopMoveIntercept = intercept<HandlePointer>(
      handle,
      "onPointerMove",
      (move, event) => {
        stale.pointerMove(event as ReactPointerEvent<HTMLDivElement>);
        move({ ...(event as object) } as ReactPointerEvent<HTMLDivElement>);
        move(event as ReactPointerEvent<HTMLDivElement>);
        current.pointerMove(event as ReactPointerEvent<HTMLDivElement>);
      },
    );
    pointerMove(handle, 11, 760);
    stopMoveIntercept();
    expect(onResize).toHaveBeenCalledExactlyOnceWith(380);

    const stopUpIntercept = intercept<HandlePointer>(
      handle,
      "onPointerUp",
      (end, event) => {
        stale.pointerUp(event as ReactPointerEvent<HTMLDivElement>);
        end({ ...(event as object) } as ReactPointerEvent<HTMLDivElement>);
        end(event as ReactPointerEvent<HTMLDivElement>);
        current.pointerUp(event as ReactPointerEvent<HTMLDivElement>);
      },
    );
    pointerUp(handle, 11);
    stopUpIntercept();
    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(11);
    expect(handle).not.toHaveAttribute("data-dragging");
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it.each([
    ["pointer cancel", pointerCancel, 1],
    ["lost pointer capture", lostPointerCapture, 0],
  ] as const)(
    "ends a current drag once on %s and makes every later terminal event inert",
    (_, terminal, expectedReleases) => {
      const onResize = vi.fn();
      document.body.style.cursor = "wait";
      document.body.style.userSelect = "text";
      const { handle, stale } = captureFirstStrictHandlers({ onResize });
      pointerDown(handle, 12, 800, "pen");
      pointerMove(handle, 12, 730, "pen");
      terminal(handle, 12, "pen");
      pointerUp(handle, 12, "pen");
      pointerCancel(handle, 12, "pen");
      lostPointerCapture(handle, 12, "pen");

      expect(onResize).toHaveBeenCalledExactlyOnceWith(410);
      expect(releasePointerCapture).toHaveBeenCalledTimes(expectedReleases);
      expect(handle).not.toHaveAttribute("data-dragging");
      expect(document.body.style.cursor).toBe("wait");
      expect(document.body.style.userSelect).toBe("text");

      const replacement = currentHandle();
      const stop = intercept<HandleKeyboard>(
        replacement,
        "onKeyDown",
        (current, event) => {
          stale.keyDown(event as ReactKeyboardEvent<HTMLDivElement>);
          current(event as ReactKeyboardEvent<HTMLDivElement>);
        },
      );
      keyDown(replacement, "ArrowLeft");
      stop();
      expect(onResize).toHaveBeenLastCalledWith(356);
    },
  );

  it("freezes accepted drag geometry, callbacks, and range until the exact drag retires", () => {
    const oldResize = vi.fn();
    const newResize = vi.fn();
    const oldReset = vi.fn();
    const newReset = vi.fn();
    const view = strictView({
      width: 340,
      min: 280,
      max: 400,
      onResize: oldResize,
      onReset: oldReset,
    });
    const handle = currentHandle(view.host);
    pointerDown(handle, 19, 800);

    renderStrict(view.root, {
      width: 600,
      min: 500,
      max: 620,
      onResize: newResize,
      onReset: newReset,
    });
    expect(handle).toHaveAttribute("aria-valuenow", "340");
    pointerMove(handle, 19, 700);
    expect(oldResize).toHaveBeenCalledExactlyOnceWith(400);
    expect(newResize).not.toHaveBeenCalled();
    pointerUp(handle, 19);

    const current = currentHandle(view.host);
    expect(current).toBe(handle);
    expect(current).toHaveAttribute("aria-valuenow", "600");
    keyDown(current, "ArrowLeft");
    keyDown(current, "Enter");
    expect(newResize).toHaveBeenCalledExactlyOnceWith(616);
    expect(newReset).toHaveBeenCalledOnce();
    expect(oldReset).not.toHaveBeenCalled();
  });

  it.each(["handle", "line", "both"] as const)(
    "creates a distinct successor after an exact %s callback-ref replay",
    (part) => {
      const onResize = vi.fn();
      const view = strictView({ onResize });
      const handle = currentHandle(view.host);
      const line = currentLine(handle);
      const stale = handlers(handle);
      const handleRef = reactRef(handle);
      const lineRef = reactRef(line);

      act(() => {
        if (part === "handle" || part === "both") handleRef(null);
        if (part === "line" || part === "both") lineRef(null);
        if (part === "handle" || part === "both") handleRef(handle);
        if (part === "line" || part === "both") lineRef(line);
      });

      const current = handlers(handle);
      expect(current.keyDown).not.toBe(stale.keyDown);
      const stop = intercept<HandleKeyboard>(
        handle,
        "onKeyDown",
        (next, event) => {
          stale.keyDown(event as ReactKeyboardEvent<HTMLDivElement>);
          next(event as ReactKeyboardEvent<HTMLDivElement>);
          stale.keyDown(event as ReactKeyboardEvent<HTMLDivElement>);
        },
      );
      keyDown(handle, "ArrowLeft");
      stop();
      expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
    },
  );

  it("rejects restored DOM mutation and then admits a clean fresh publication", async () => {
    const onResize = vi.fn();
    const view = strictView({ onResize });
    const handle = currentHandle(view.host);
    const stale = handlers(handle);
    handle.setAttribute("aria-label", "Changed");
    handle.setAttribute("aria-label", "Resize panel");
    await flushMutations();

    keyDown(handle, "ArrowLeft");
    expect(onResize).not.toHaveBeenCalled();

    renderStrict(view.root, { onResize, boundary: 2 });
    const current = currentHandle(view.host);
    expect(handlers(current).keyDown).not.toBe(stale.keyDown);
    keyDown(current, "ArrowLeft");
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
  });

  it.each(["parent", "higher ancestor"] as const)(
    "permanently retires an owner after %s detach and exact reinsertion",
    async (level) => {
      const onResize = vi.fn();
      const view = strictView({ onResize });
      const handle = currentHandle(view.host);
      const stale = handlers(handle);
      const target = level === "parent"
        ? handle.parentElement
        : handle.parentElement?.parentElement;
      const parent = target?.parentNode;
      const next = target?.nextSibling ?? null;
      if (!target || !parent) throw new Error("Expected a connected ancestor");
      parent.removeChild(target);
      parent.insertBefore(target, next);
      await flushMutations();

      keyDown(handle, "ArrowLeft");
      expect(onResize).not.toHaveBeenCalled();

      renderStrict(view.root, {
        instance: `fresh-${level}`,
        onResize,
      });
      const current = currentHandle(view.host);
      expect(handlers(current).keyDown).not.toBe(stale.keyDown);
      keyDown(current, "ArrowLeft");
      expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
    },
  );

  it("keeps a publication eligible through nonadjacent ancestor churn", async () => {
    const onResize = vi.fn();
    const view = strictView({ onResize }, true);
    const handle = currentHandle(view.host);
    const before = handlers(handle);
    const churn = document.createElement("div");
    document.body.append(churn);
    hosts.add(churn);
    await flushMutations();

    expect(handlers(handle).keyDown).toBe(before.keyDown);
    keyDown(handle, "ArrowLeft");
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
  });

  it("retires A at replacement before B starts and isolates late A events from B ownership", () => {
    const oldResize = vi.fn();
    const currentResize = vi.fn();
    document.body.style.cursor = "help";
    document.body.style.userSelect = "text";
    const view = strictView({ instance: "a", onResize: oldResize });
    const oldHandle = currentHandle(view.host);
    const stale = handlers(oldHandle);
    pointerDown(oldHandle, 27, 800);

    renderStrict(view.root, {
      instance: "b",
      width: 500,
      onResize: currentResize,
    });
    const current = currentHandle(view.host);
    expect(current).not.toBe(oldHandle);
    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(27);
    expect(document.body.style.cursor).toBe("help");
    expect(document.body.style.userSelect).toBe("text");

    pointerDown(current, 27, 800, "touch");
    const stopMove = intercept<HandlePointer>(
      current,
      "onPointerMove",
      (move, event) => {
        stale.pointerMove(event as ReactPointerEvent<HTMLDivElement>);
        move(event as ReactPointerEvent<HTMLDivElement>);
      },
    );
    pointerMove(current, 27, 750, "touch");
    stopMove();
    expect(oldResize).not.toHaveBeenCalled();
    expect(currentResize).toHaveBeenCalledExactlyOnceWith(550);
    expect(current).toHaveAttribute("data-dragging", "true");

    const stopEnd = intercept<HandlePointer>(
      current,
      "onPointerUp",
      (end, event) => {
        stale.pointerUp(event as ReactPointerEvent<HTMLDivElement>);
        stale.pointerCancel(event as ReactPointerEvent<HTMLDivElement>);
        stale.lostPointerCapture(event as ReactPointerEvent<HTMLDivElement>);
        end(event as ReactPointerEvent<HTMLDivElement>);
      },
    );
    pointerUp(current, 27, "touch");
    stopEnd();
    expect(releasePointerCapture).toHaveBeenCalledTimes(2);
    expect(document.body.style.cursor).toBe("help");
    expect(document.body.style.userSelect).toBe("text");
  });

  it.each([
    {
      changed: "cursor",
      mutate: () => {
        document.body.style.cursor = "wait";
      },
      afterRetire: ["wait", "text"],
    },
    {
      changed: "userSelect",
      mutate: () => {
        document.body.style.userSelect = "contain";
      },
      afterRetire: ["help", "contain"],
    },
  ] as const)(
    "preserves external $changed ownership while restoring the other body style",
    async ({ mutate, afterRetire }) => {
      const oldResize = vi.fn();
      const currentResize = vi.fn();
      document.body.style.cursor = "help";
      document.body.style.userSelect = "text";
      const view = strictView({ instance: "a", onResize: oldResize });
      const oldHandle = currentHandle(view.host);
      const stale = handlers(oldHandle);
      pointerDown(oldHandle, 29, 800);

      mutate();
      await flushMutations();
      expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(29);
      expect(releasePointerCapture.mock.contexts[0]).toBe(oldHandle);
      expect(document.body.style.cursor).toBe(afterRetire[0]);
      expect(document.body.style.userSelect).toBe(afterRetire[1]);
      expect(oldHandle).not.toHaveAttribute("data-dragging");

      renderStrict(view.root, {
        instance: "b",
        width: 500,
        onResize: currentResize,
      });
      const current = currentHandle(view.host);
      pointerDown(current, 29, 800, "touch");
      const stopMove = intercept<HandlePointer>(
        current,
        "onPointerMove",
        (move, event) => {
          stale.pointerMove(event as ReactPointerEvent<HTMLDivElement>);
          move(event as ReactPointerEvent<HTMLDivElement>);
        },
      );
      pointerMove(current, 29, 760, "touch");
      stopMove();
      expect(oldResize).not.toHaveBeenCalled();
      expect(currentResize).toHaveBeenCalledExactlyOnceWith(540);
      expect(current).toHaveAttribute("data-dragging", "true");
      expect(document.body.style.cursor).toBe("col-resize");
      expect(document.body.style.userSelect).toBe("none");

      const stopEnd = intercept<HandlePointer>(
        current,
        "onPointerUp",
        (end, event) => {
          stale.pointerUp(event as ReactPointerEvent<HTMLDivElement>);
          stale.pointerCancel(event as ReactPointerEvent<HTMLDivElement>);
          stale.lostPointerCapture(event as ReactPointerEvent<HTMLDivElement>);
          expect(current).toHaveAttribute("data-dragging", "true");
          expect(document.body.style.cursor).toBe("col-resize");
          expect(document.body.style.userSelect).toBe("none");
          end(event as ReactPointerEvent<HTMLDivElement>);
        },
      );
      pointerUp(current, 29, "touch");
      stopEnd();
      expect(releasePointerCapture).toHaveBeenCalledTimes(2);
      expect(releasePointerCapture.mock.contexts[1]).toBe(current);
      expect(document.body.style.cursor).toBe(afterRetire[0]);
      expect(document.body.style.userSelect).toBe(afterRetire[1]);
    },
  );

  it("restores exact body styles when capture and release throw", () => {
    document.body.style.cursor = "crosshair";
    document.body.style.userSelect = "all";
    const firstResize = vi.fn();
    setPointerCapture.mockImplementationOnce(() => {
      throw new Error("capture failed");
    });
    const first = strictView({ onResize: firstResize });
    const firstHandle = currentHandle(first.host);
    pointerDown(firstHandle, 31, 700);
    pointerMove(firstHandle, 31, 680);
    pointerUp(firstHandle, 31);
    expect(firstResize).toHaveBeenCalledExactlyOnceWith(360);
    expect(releasePointerCapture).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("crosshair");
    expect(document.body.style.userSelect).toBe("all");

    renderStrict(first.root, { instance: "release-throws" });
    releasePointerCapture.mockImplementationOnce(() => {
      throw new Error("release failed");
    });
    const secondHandle = currentHandle(first.host);
    pointerDown(secondHandle, 32, 700);
    pointerUp(secondHandle, 32);
    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(32);
    expect(document.body.style.cursor).toBe("crosshair");
    expect(document.body.style.userSelect).toBe("all");
  });

  it("releases only its own capture and styles on active unmount", () => {
    document.body.style.cursor = "zoom-in";
    document.body.style.userSelect = "contain";
    const view = strictView();
    const handle = currentHandle(view.host);
    pointerDown(handle, 39, 900);
    act(() => view.root.unmount());
    roots.delete(view.root);

    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(39);
    expect(releasePointerCapture.mock.contexts[0]).toBe(handle);
    expect(document.body.style.cursor).toBe("zoom-in");
    expect(document.body.style.userSelect).toBe("contain");
  });

  it("rejects crossed pointer identities, types, buttons, realms, and reused native events", () => {
    const onResize = vi.fn();
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    hosts.add(iframe);
    const foreignWindow = iframe.contentWindow as
      | (Window & typeof globalThis)
      | null;
    if (!foreignWindow) throw new Error("Expected an iframe realm");
    const view = strictView({ onResize });
    const handle = currentHandle(view.host);
    fireEvent.pointerDown(handle, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 800,
      button: 2,
      buttons: 2,
      isPrimary: true,
    });
    pointerDown(handle, 4, 800, "mouse");
    pointerMove(handle, 5, 700, "mouse");
    pointerMove(handle, 4, 700, "pen");
    fireEvent.pointerMove(handle, {
      pointerId: 4,
      pointerType: "mouse",
      clientX: 700,
      button: -1,
      buttons: 0,
      isPrimary: true,
    });
    expect(onResize).not.toHaveBeenCalled();

    const stop = intercept<HandlePointer>(
      handle,
      "onPointerMove",
      (move, event) => {
        const fabricated = {
          ...(event as object),
          nativeEvent: new foreignWindow.PointerEvent("pointermove", {
            bubbles: true,
            composed: true,
            pointerId: 4,
            pointerType: "mouse",
            clientX: 700,
            button: -1,
            buttons: 1,
          }),
        } as ReactPointerEvent<HTMLDivElement>;
        move(fabricated);
        move(event as ReactPointerEvent<HTMLDivElement>);
        move(event as ReactPointerEvent<HTMLDivElement>);
      },
    );
    pointerMove(handle, 4, 760, "mouse");
    stop();
    expect(onResize).toHaveBeenCalledExactlyOnceWith(380);
    pointerUp(handle, 4);
  });

  it("keeps the rightful pair through wrong, crossed, and reentrant React attempts", () => {
    const onResize = vi.fn();
    const view = strictView({ onResize });
    const handle = currentHandle(view.host);
    let captureWrapper: ReactKeyboardEvent<HTMLDivElement> | null = null;
    const nested: { value: KeyboardEvent | null } = { value: null };
    let reentered = false;
    const stopCapture = intercept<HandleKeyboard>(
      handle,
      "onKeyDownCapture",
      (current, event) => {
        const wrapper = event as ReactKeyboardEvent<HTMLDivElement>;
        if (!captureWrapper) {
          captureWrapper = wrapper;
          const key = wrapper.key;
          Object.defineProperty(wrapper, "key", {
            configurable: true,
            enumerable: true,
            get: () => {
              if (!reentered) {
                reentered = true;
                nested.value = keyboardEvent(handle, "ArrowRight");
                handle.dispatchEvent(nested.value);
              }
              return key;
            },
          });
        }
        current(wrapper);
      },
    );
    const stopBubble = intercept<HandleKeyboard>(
      handle,
      "onKeyDown",
      (current, event) => {
        if (captureWrapper) current(captureWrapper);
        current({ ...(event as object) } as ReactKeyboardEvent<HTMLDivElement>);
        current(event as ReactKeyboardEvent<HTMLDivElement>);
      },
    );

    const event = keyDown(handle, "ArrowLeft");
    stopBubble();
    stopCapture();

    expect(nested.value).not.toBeNull();
    expect(nested.value?.defaultPrevented).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
  });

  it("rejects a structurally copied wrapper and recovers on a genuine delivery", () => {
    const onResize = vi.fn();
    const view = strictView({ onResize });
    const handle = currentHandle(view.host);
    const stop = intercept<HandleKeyboard>(
      handle,
      "onKeyDown",
      (current, event) => {
        current({ ...(event as object) } as ReactKeyboardEvent<HTMLDivElement>);
      },
    );

    const rejected = keyDown(handle, "ArrowLeft");
    stop();

    expect(rejected.defaultPrevented).toBe(false);
    expect(onResize).not.toHaveBeenCalled();
    const accepted = keyDown(handle, "ArrowLeft");
    expect(accepted.defaultPrevented).toBe(true);
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
  });

  it("rejects required public method drift without poisoning the next pair", () => {
    const onResize = vi.fn();
    const view = strictView({ onResize });
    const handle = currentHandle(view.host);
    const stop = intercept<HandleKeyboard>(
      handle,
      "onKeyDown",
      (current, event) => {
        Object.defineProperty(event as object, "isPropagationStopped", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: vi.fn(() => false),
        });
        current(event as ReactKeyboardEvent<HTMLDivElement>);
      },
    );

    const rejected = keyDown(handle, "ArrowLeft");
    stop();

    expect(rejected.defaultPrevented).toBe(false);
    expect(onResize).not.toHaveBeenCalled();
    const accepted = keyDown(handle, "ArrowLeft");
    expect(accepted.defaultPrevented).toBe(true);
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
  });

  it("revalidates public methods after prevention before callback work", () => {
    const onResize = vi.fn();
    const view = strictView({ onResize });
    const handle = currentHandle(view.host);
    let retainedPrevent: ((this: object) => unknown) | null = null;
    let bubbleWrapper: Record<PropertyKey, unknown> | null = null;
    const prevent = vi.fn(function (this: object) {
      if (!retainedPrevent || !bubbleWrapper) {
        throw new Error("The bubble prevention proof was unavailable");
      }
      const result = Reflect.apply(retainedPrevent, this, []);
      Object.defineProperty(bubbleWrapper, "isPropagationStopped", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: vi.fn(() => false),
      });
      return result;
    });
    const install = (
      current: HandleKeyboard,
      event: unknown,
      bubble: boolean,
    ) => {
      const wrapper = event as Record<PropertyKey, unknown>;
      if (!retainedPrevent) {
        if (typeof wrapper.preventDefault !== "function") {
          throw new Error("React preventDefault was unavailable");
        }
        retainedPrevent = wrapper.preventDefault as (this: object) => unknown;
      }
      if (bubble) bubbleWrapper = wrapper;
      Object.defineProperty(wrapper, "preventDefault", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: prevent,
      });
      current(event as ReactKeyboardEvent<HTMLDivElement>);
    };
    const stopCapture = intercept<HandleKeyboard>(
      handle,
      "onKeyDownCapture",
      (current, event) => install(current, event, false),
    );
    const stopBubble = intercept<HandleKeyboard>(
      handle,
      "onKeyDown",
      (current, event) => install(current, event, true),
    );

    const rejected = keyDown(handle, "ArrowLeft");
    stopBubble();
    stopCapture();

    expect(prevent).toHaveBeenCalledOnce();
    expect(rejected.defaultPrevented).toBe(true);
    expect(onResize).not.toHaveBeenCalled();
    const accepted = keyDown(handle, "ArrowLeft");
    expect(accepted.defaultPrevented).toBe(true);
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
  });

  it("rejects a replayed native event after exactly one callback", () => {
    const onResize = vi.fn();
    const view = strictView({ onResize });
    const handle = currentHandle(view.host);
    const event = keyDown(handle, "ArrowLeft");
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);

    act(() => {
      handle.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onResize).toHaveBeenCalledOnce();
  });

  it("retires on owner-realm method drift and admits a clean successor", () => {
    const onResize = vi.fn();
    const view = strictView({ onResize });
    const handle = currentHandle(view.host);
    const stale = handlers(handle);
    const ownerWindow = handle.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("The handle owner Window was unavailable");
    const prototype = ownerWindow.KeyboardEvent.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "key");
    if (!descriptor?.get) throw new Error("KeyboardEvent.key was unavailable");
    const rejected = keyboardEvent(handle, "ArrowLeft");
    handle.focus();

    act(() => {
      Object.defineProperty(prototype, "key", {
        ...descriptor,
        get: function () {
          return Reflect.apply(descriptor.get!, this, []);
        },
      });
      try {
        handle.dispatchEvent(rejected);
      } finally {
        Object.defineProperty(prototype, "key", descriptor);
      }
    });

    expect(rejected.defaultPrevented).toBe(false);
    expect(onResize).not.toHaveBeenCalled();
    const current = currentHandle(view.host);
    expect(handlers(current).keyDown).not.toBe(stale.keyDown);
    const accepted = keyDown(current, "ArrowLeft");
    expect(accepted.defaultPrevented).toBe(true);
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
  });

  it("keeps the pair after a wrong Window receiver and releases listeners on cleanup", () => {
    const ownerWindow = document.defaultView;
    if (!ownerWindow) throw new Error("Document default view was unavailable");
    const addDescriptor = Object.getOwnPropertyDescriptor(
      ownerWindow,
      "addEventListener",
    );
    const removeDescriptor = Object.getOwnPropertyDescriptor(
      ownerWindow,
      "removeEventListener",
    );
    const add = ownerWindow.addEventListener;
    const remove = ownerWindow.removeEventListener;
    const eventTargetPrototype = ownerWindow.EventTarget.prototype;
    const targetAddDescriptor = Object.getOwnPropertyDescriptor(
      eventTargetPrototype,
      "addEventListener",
    );
    const targetRemoveDescriptor = Object.getOwnPropertyDescriptor(
      eventTargetPrototype,
      "removeEventListener",
    );
    const targetAdd = eventTargetPrototype.addEventListener;
    const targetRemove = eventTargetPrototype.removeEventListener;
    const active = new Set<EventListener>();
    const documentActive = new Set<EventListener>();
    const keyboardListener: { value: EventListener | null } = { value: null };
    Object.defineProperty(eventTargetPrototype, "addEventListener", {
      ...targetAddDescriptor,
      value: function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (
          this === document
          && type === "keydown"
          && typeof listener === "function"
        ) {
          documentActive.add(listener);
        }
        return targetAdd.call(this, type, listener, options);
      },
    });
    Object.defineProperty(eventTargetPrototype, "removeEventListener", {
      ...targetRemoveDescriptor,
      value: function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ) {
        if (
          this === document
          && type === "keydown"
          && typeof listener === "function"
        ) {
          documentActive.delete(listener);
        }
        return targetRemove.call(this, type, listener, options);
      },
    });
    Object.defineProperty(ownerWindow, "addEventListener", {
      configurable: true,
      writable: true,
      value: function (
        this: Window,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (type === "keydown" && typeof listener === "function") {
          active.add(listener);
          keyboardListener.value = listener;
        }
        return add.call(this, type, listener, options);
      },
    });
    Object.defineProperty(ownerWindow, "removeEventListener", {
      configurable: true,
      writable: true,
      value: function (
        this: Window,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ) {
        if (type === "keydown" && typeof listener === "function") {
          active.delete(listener);
        }
        return remove.call(this, type, listener, options);
      },
    });
    try {
      const onResize = vi.fn();
      const view = strictView({ onResize });
      const handle = currentHandle(view.host);
      expect(active).toHaveLength(1);
      expect(documentActive).toHaveLength(1);
      const stop = intercept<HandleKeyboard>(
        handle,
        "onKeyDown",
        (current, event) => {
          const native = (
            event as ReactKeyboardEvent<HTMLDivElement>
          ).nativeEvent;
          current(event as ReactKeyboardEvent<HTMLDivElement>);
          keyboardListener.value?.call(document, native);
        },
      );
      const accepted = keyDown(handle, "ArrowLeft");
      stop();
      expect(accepted.defaultPrevented).toBe(true);
      expect(onResize).toHaveBeenCalledExactlyOnceWith(356);

      act(() => view.root.unmount());
      roots.delete(view.root);
      expect(active).toHaveLength(0);
      expect(documentActive).toHaveLength(0);
      keyboardListener.value?.call(
        ownerWindow,
        keyboardEvent(handle, "ArrowLeft"),
      );
      expect(onResize).toHaveBeenCalledOnce();
    } finally {
      if (addDescriptor) {
        Object.defineProperty(ownerWindow, "addEventListener", addDescriptor);
      } else {
        Reflect.deleteProperty(ownerWindow, "addEventListener");
      }
      if (removeDescriptor) {
        Object.defineProperty(
          ownerWindow,
          "removeEventListener",
          removeDescriptor,
        );
      } else {
        Reflect.deleteProperty(ownerWindow, "removeEventListener");
      }
      if (targetAddDescriptor) {
        Object.defineProperty(
          eventTargetPrototype,
          "addEventListener",
          targetAddDescriptor,
        );
      }
      if (targetRemoveDescriptor) {
        Object.defineProperty(
          eventTargetPrototype,
          "removeEventListener",
          targetRemoveDescriptor,
        );
      }
    }
  });

  it("claims keyboard and double-click wrappers and native events once before prevention or callbacks", () => {
    const onResize = vi.fn();
    const onReset = vi.fn();
    const { handle, stale } = captureFirstStrictHandlers({ onResize, onReset });
    const stopKey = intercept<HandleKeyboard>(
      handle,
      "onKeyDown",
      (current, event) => {
        const keyboardEvent = event as ReactKeyboardEvent<HTMLDivElement>;
        stale.keyDown(keyboardEvent);
        current({ ...(event as object) } as ReactKeyboardEvent<HTMLDivElement>);
        expect(keyboardEvent.defaultPrevented).toBe(false);
        current(keyboardEvent);
        current(keyboardEvent);
      },
    );
    keyDown(handle, "ArrowLeft");
    stopKey();
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);

    const stopDouble = intercept<HandleDoubleClick>(
      handle,
      "onDoubleClick",
      (current, event) => {
        const mouseEvent = event as ReactMouseEvent<HTMLDivElement>;
        stale.doubleClick(mouseEvent);
        current({ ...(event as object) } as ReactMouseEvent<HTMLDivElement>);
        current(mouseEvent);
        current(mouseEvent);
      },
    );
    doubleClick(handle);
    stopDouble();
    expect(onReset).toHaveBeenCalledOnce();
  });
});

describe("panel width helpers", () => {
  it("uses 720 px or 60% of the viewport without dropping below the minimum", () => {
    expect(panelMaxFor(1440)).toBe(PANEL_MAX);
    expect(panelMaxFor(1200)).toBe(PANEL_MAX);
    expect(panelMaxFor(1199)).toBe(719);
    expect(panelMaxFor(1024)).toBe(614);
    expect(panelMaxFor(100)).toBe(PANEL_MIN);
  });

  it("rounds, clamps, and parses stored whole-pixel widths", () => {
    expect(clampPanelWidth(339.6, PANEL_MIN, PANEL_MAX)).toBe(340);
    expect(clampPanelWidth(10, PANEL_MIN, PANEL_MAX)).toBe(PANEL_MIN);
    expect(clampPanelWidth(5000, PANEL_MIN, PANEL_MAX)).toBe(PANEL_MAX);
    expect(parseStoredPanelWidth("500")).toBe(500);
    expect(parseStoredPanelWidth(" 420 ")).toBe(420);
    for (const invalid of [null, "", "abc", "500.5", "-300", "1e3", "{}"]) {
      expect(parseStoredPanelWidth(invalid)).toBeNull();
    }
    expect(PANEL_BIG_STEP).toBe(64);
  });
});
