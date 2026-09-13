// @vitest-environment jsdom
import {
  StrictMode,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import { NameVersionDialog, type NameVersionSaveOwner, type NameVersionVisit } from "./dialogs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function Harness({
  editor,
  documentId,
  onSubmit,
  onOpenChange = vi.fn(),
  nextOperationId,
  onAncestorKeyDown,
}: {
  editor: object;
  documentId: string;
  onSubmit: (owner: NameVersionSaveOwner) => Promise<void>;
  onOpenChange?: (open: boolean) => void;
  nextOperationId?: () => number;
  onAncestorKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  const visitSequence = useRef(1);
  const operationSequence = useRef(0);
  const makeVisit = (id: number): NameVersionVisit => ({ id, editor, documentId });
  const [visit, setVisit] = useState(() => makeVisit(1));
  const [open, setOpen] = useState(true);
  const changeOpen = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    setOpen(nextOpen);
  };
  return (
    <div onKeyDown={onAncestorKeyDown}>
      <button
        type="button"
        onClick={() => {
          setVisit(makeVisit(++visitSequence.current));
          setOpen(true);
        }}
      >
        Open version dialog
      </button>
      <NameVersionDialog
        open={open}
        visit={visit}
        onOpenChange={(_visit, nextOpen) => changeOpen(nextOpen)}
        nextOperationId={
          nextOperationId ?? (() => ++operationSequence.current)
        }
        onSubmit={onSubmit}
      />
    </div>
  );
}

function form() {
  return screen.getByTestId("version-name-submit").closest("form")!;
}

function submitImmediatelyTwice() {
  const submit = new Event("submit", { bubbles: true, cancelable: true });
  const duplicate = new Event("submit", { bubbles: true, cancelable: true });
  act(() => {
    form().dispatchEvent(submit);
    form().dispatchEvent(duplicate);
  });
}

interface DirectView {
  root: Root;
  host: HTMLDivElement;
  frame: HTMLIFrameElement | null;
}

const directViews: DirectView[] = [];

function renderStrict(
  element: ReactElement,
  ownerDocument: Document = document,
) {
  const host = ownerDocument.createElement("div");
  ownerDocument.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<StrictMode>{element}</StrictMode>));
  const frame = ownerDocument.defaultView?.frameElement;
  const view = {
    root,
    host,
    frame: frame instanceof HTMLIFrameElement ? frame : null,
  };
  directViews.push(view);
  return view;
}

function withGlobalDocument<Result>(
  ownerDocument: Document,
  run: () => Result,
): Result {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  if (!descriptor?.configurable) {
    throw new Error("The global document cannot be temporarily replaced");
  }
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    enumerable: descriptor.enumerable,
    writable: true,
    value: ownerDocument,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, "document", descriptor);
  }
}

function jsdomEventImplementation(event: Event) {
  const implementationSymbol = Object.getOwnPropertySymbols(event).find(
    (symbol) => String(symbol) === "Symbol(impl)",
  );
  const implementation = implementationSymbol
    ? (
        event as unknown as Record<
          symbol,
          {
            code: string;
            isTrusted: boolean;
            location: number;
            view: unknown;
          }
        >
      )[implementationSymbol]
    : null;
  if (!implementation) {
    throw new Error("The jsdom event implementation slot was unavailable");
  }
  return implementation;
}

function markJsdomEventTrusted(event: Event) {
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
  if (!event.isTrusted) {
    throw new Error("The jsdom event trust slot did not update");
  }
}

function setJsdomEventView(event: Event, view: unknown) {
  jsdomEventImplementation(event).view = view;
}

type NavigationKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";

function navigationInit(
  key: NavigationKey,
  extra: KeyboardEventInit = {},
): KeyboardEventInit {
  return { key, code: key, ...extra };
}

function trustedKey(
  target: HTMLElement,
  init: KeyboardEventInit,
  trusted = true,
  eventView?: unknown,
) {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The key target has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  setJsdomEventView(event, eventView ?? ownerWindow);
  if (trusted) markJsdomEventTrusted(event);
  fireEvent(target, event);
  return event;
}

type KeyHandler = (
  event: ReactKeyboardEvent<HTMLDivElement>,
) => void;

function reactHandlers(boundary: HTMLDivElement) {
  const propsKey = Object.keys(boundary).find((key) =>
    key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached");
  const properties = boundary as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const props = properties[propsKey];
  const capture = props?.onKeyDownCapture;
  const bubble = props?.onKeyDown;
  if (
    !props ||
    typeof capture !== "function" ||
    typeof bubble !== "function"
  ) {
    throw new Error("The action row has no keyboard delivery pair");
  }
  return {
    properties,
    propsKey,
    props,
    capture: capture as KeyHandler,
    bubble: bubble as KeyHandler,
  };
}

function withReactHandlers(
  boundary: HTMLDivElement,
  handlers: {
    capture: KeyHandler;
    bubble: KeyHandler;
  },
  run: () => KeyboardEvent,
) {
  const current = reactHandlers(boundary);
  const replacement = {
    ...current.props,
    onKeyDownCapture: handlers.capture,
    onKeyDown: handlers.bubble,
  };
  current.properties[current.propsKey] = replacement;
  try {
    return run();
  } finally {
    if (current.properties[current.propsKey] === replacement) {
      current.properties[current.propsKey] = current.props;
    }
  }
}

function trackNavigationEffects(ownerWindow: Window & typeof globalThis) {
  const nativePreventDefault = ownerWindow.Event.prototype.preventDefault;
  const nativeFocus = ownerWindow.HTMLElement.prototype.focus;
  const focusCalls: Array<{
    target: HTMLElement;
    options: FocusOptions | undefined;
  }> = [];
  const preventDefault = vi
    .spyOn(ownerWindow.Event.prototype, "preventDefault")
    .mockImplementation(function (this: Event) {
      Reflect.apply(nativePreventDefault, this, []);
    });
  const focus = vi
    .spyOn(ownerWindow.HTMLElement.prototype, "focus")
    .mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      focusCalls.push({ target: this, options });
      Reflect.apply(nativeFocus, this, [options]);
    });
  return { preventDefault, focus, focusCalls };
}

function directActions(host: HTMLElement) {
  const scope = within(host.ownerDocument.body);
  const cancel = scope.getByRole("button", {
    name: "Cancel",
  }) as HTMLButtonElement;
  const save = scope.getByTestId(
    "version-name-submit",
  ) as HTMLButtonElement;
  const input = scope.getByTestId("version-name") as HTMLInputElement;
  const formElement = save.closest("form");
  const boundary = cancel.parentElement;
  const ownerWindow = host.ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !(formElement instanceof ownerWindow.HTMLFormElement) ||
    !(boundary instanceof ownerWindow.HTMLDivElement)
  ) {
    throw new Error("The version form boundary is incomplete");
  }
  return { scope, cancel, save, input, form: formElement, boundary };
}

afterEach(() => {
  for (const view of directViews.splice(0)) {
    act(() => view.root.unmount());
    view.host.remove();
    view.frame?.remove();
  }
  cleanup();
  vi.restoreAllMocks();
});

describe("NameVersionDialog keyboard action navigation", () => {
  it.each([
    ["Cancel", "Save version", "ArrowRight", "ArrowRight", 0],
    ["Cancel", "Save version", "ArrowDown", "ArrowDown", 0],
    ["Cancel", "Save version", "End", "End", 0],
    ["Save version", "Cancel", "ArrowLeft", "ArrowLeft", 0],
    ["Save version", "Cancel", "ArrowUp", "ArrowUp", 0],
    ["Save version", "Cancel", "Home", "Home", 0],
    ["Save version", "Cancel", "ArrowLeft", "Numpad4", 3],
    ["Save version", "Cancel", "ArrowUp", "Numpad8", 3],
    ["Cancel", "Save version", "ArrowRight", "Numpad6", 3],
    ["Cancel", "Save version", "ArrowDown", "Numpad2", 3],
    ["Save version", "Cancel", "Home", "Numpad7", 3],
    ["Cancel", "Save version", "End", "Numpad1", 3],
  ] as const)(
    "moves from %s to %s with %s (%s, location %i) once without form or scroll work",
    (sourceName, destinationName, key, code, location) => {
      const effects = trackNavigationEffects(window);
      const onSubmit = vi.fn(async () => undefined);
      const onOpenChange = vi.fn();
      const nextOperationId = vi.fn(() => 1);
      const view = renderStrict(
        <Harness
          editor={{}}
          documentId="doc-navigation"
          onSubmit={onSubmit}
          onOpenChange={onOpenChange}
          nextOperationId={nextOperationId}
        />,
      );
      fireEvent.change(directActions(view.host).input, {
        target: { value: "Keyboard checkpoint" },
      });
      const actions = directActions(view.host);
      const source =
        sourceName === "Cancel" ? actions.cancel : actions.save;
      const destination =
        destinationName === "Cancel" ? actions.cancel : actions.save;
      const scroll = {
        bodyLeft: document.body.scrollLeft,
        bodyTop: document.body.scrollTop,
        formLeft: actions.form.scrollLeft,
        formTop: actions.form.scrollTop,
        rowLeft: actions.boundary.scrollLeft,
        rowTop: actions.boundary.scrollTop,
      };

      source.focus();
      effects.preventDefault.mockClear();
      effects.focus.mockClear();
      effects.focusCalls.length = 0;
      const event = trustedKey(
        source,
        navigationInit(key, { code, location }),
      );

      expect(event.defaultPrevented).toBe(true);
      expect(effects.preventDefault).toHaveBeenCalledOnce();
      expect(effects.preventDefault.mock.contexts[0]).toBe(event);
      expect(effects.focus).toHaveBeenCalledOnce();
      expect(effects.focusCalls).toEqual([
        { target: destination, options: { preventScroll: true } },
      ]);
      expect(destination).toHaveFocus();
      expect({
        bodyLeft: document.body.scrollLeft,
        bodyTop: document.body.scrollTop,
        formLeft: actions.form.scrollLeft,
        formTop: actions.form.scrollTop,
        rowLeft: actions.boundary.scrollLeft,
        rowTop: actions.boundary.scrollTop,
      }).toEqual(scroll);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(nextOperationId).not.toHaveBeenCalled();
      expect(actions.scope.getByRole("dialog")).toBeInTheDocument();
      expect(actions.input).toHaveValue("Keyboard checkpoint");
    },
  );

  it("leaves enabled edges, blank and busy single-action states unclaimed", () => {
    const effects = trackNavigationEffects(window);
    const pending = deferred<void>();
    const onSubmit = vi.fn(() => pending.promise);
    const onOpenChange = vi.fn();
    const nextOperationId = vi.fn(() => 1);
    const view = renderStrict(
      <Harness
        editor={{}}
        documentId="doc-boundaries"
        onSubmit={onSubmit}
        onOpenChange={onOpenChange}
        nextOperationId={nextOperationId}
      />,
    );
    let actions = directActions(view.host);
    expect(actions.save).toBeDisabled();
    actions.cancel.focus();
    for (const key of ["ArrowRight", "ArrowDown", "End"] as const) {
      effects.preventDefault.mockClear();
      effects.focus.mockClear();
      effects.focusCalls.length = 0;
      const event = trustedKey(actions.cancel, navigationInit(key));
      expect(event.defaultPrevented, key).toBe(false);
      expect(effects.preventDefault, key).not.toHaveBeenCalled();
      expect(effects.focus, key).not.toHaveBeenCalled();
      expect(actions.cancel, key).toHaveFocus();
    }

    fireEvent.change(actions.input, { target: { value: "Ready" } });
    actions = directActions(view.host);
    const edges = [
      [actions.cancel, "ArrowLeft", "ArrowLeft", 0],
      [actions.cancel, "ArrowUp", "ArrowUp", 0],
      [actions.cancel, "Home", "Home", 0],
      [actions.save, "ArrowRight", "ArrowRight", 0],
      [actions.save, "ArrowDown", "ArrowDown", 0],
      [actions.save, "End", "End", 0],
      [actions.cancel, "ArrowLeft", "Numpad4", 3],
      [actions.cancel, "ArrowUp", "Numpad8", 3],
      [actions.cancel, "Home", "Numpad7", 3],
      [actions.save, "ArrowRight", "Numpad6", 3],
      [actions.save, "ArrowDown", "Numpad2", 3],
      [actions.save, "End", "Numpad1", 3],
    ] as const;
    for (const [source, key, code, location] of edges) {
      source.focus();
      effects.preventDefault.mockClear();
      effects.focus.mockClear();
      const event = trustedKey(
        source,
        navigationInit(key, { code, location }),
      );
      expect(event.defaultPrevented, key).toBe(false);
      expect(effects.preventDefault, key).not.toHaveBeenCalled();
      expect(effects.focus, key).not.toHaveBeenCalled();
      expect(source, key).toHaveFocus();
    }

    fireEvent.submit(actions.form);
    actions = directActions(view.host);
    expect(actions.input).toBeDisabled();
    expect(actions.save).toBeDisabled();
    actions.cancel.focus();
    effects.preventDefault.mockClear();
    effects.focus.mockClear();
    const busy = trustedKey(
      actions.cancel,
      navigationInit("ArrowRight"),
    );
    expect(busy.defaultPrevented).toBe(false);
    expect(effects.preventDefault).not.toHaveBeenCalled();
    expect(effects.focus).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(nextOperationId).toHaveBeenCalledOnce();
  });

  it("rejects modifiers, repeat, composition, untrusted input, wrong focus, and activation keys", () => {
    const effects = trackNavigationEffects(window);
    const onSubmit = vi.fn(async () => undefined);
    const onOpenChange = vi.fn();
    const view = renderStrict(
      <Harness
        editor={{}}
        documentId="doc-rejections"
        onSubmit={onSubmit}
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.change(directActions(view.host).input, {
      target: { value: "Ready" },
    });
    const actions = directActions(view.host);
    const rejected: Array<{
      init: KeyboardEventInit;
      trusted?: boolean;
    }> = [
      { init: navigationInit("ArrowRight", { altKey: true }) },
      { init: navigationInit("ArrowRight", { ctrlKey: true }) },
      { init: navigationInit("ArrowRight", { metaKey: true }) },
      { init: navigationInit("ArrowRight", { shiftKey: true }) },
      { init: navigationInit("ArrowRight", { repeat: true }) },
      { init: navigationInit("ArrowRight", { isComposing: true }) },
      { init: navigationInit("ArrowRight"), trusted: false },
      { init: { key: "Tab", code: "Tab" } },
      { init: { key: "Enter", code: "Enter" } },
      { init: { key: " ", code: "Space" } },
    ];
    for (const { init, trusted } of rejected) {
      actions.cancel.focus();
      effects.preventDefault.mockClear();
      effects.focus.mockClear();
      const event = trustedKey(actions.cancel, init, trusted);
      expect(event.defaultPrevented).toBe(false);
      expect(effects.preventDefault).not.toHaveBeenCalled();
      expect(effects.focus).not.toHaveBeenCalled();
      expect(actions.cancel).toHaveFocus();
    }

    actions.cancel.focus();
    effects.preventDefault.mockClear();
    effects.focus.mockClear();
    const wrongFocus = trustedKey(
      actions.save,
      navigationInit("ArrowLeft"),
    );
    expect(wrongFocus.defaultPrevented).toBe(false);
    expect(effects.preventDefault).not.toHaveBeenCalled();
    expect(effects.focus).not.toHaveBeenCalled();
    expect(actions.cancel).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("publishes prevention to a real same-root synthetic ancestor without activating it", () => {
    const effects = trackNavigationEffects(window);
    const ancestorAction = vi.fn();
    const observations: Array<{
      defaultPrevented: boolean;
      syntheticDefaultPrevented: boolean;
    }> = [];
    const view = renderStrict(
      <Harness
        editor={{}}
        documentId="doc-ancestor-prevention"
        onSubmit={async () => undefined}
        onAncestorKeyDown={(event) => {
          const syntheticDefaultPrevented = event.isDefaultPrevented();
          observations.push({
            defaultPrevented: event.defaultPrevented,
            syntheticDefaultPrevented,
          });
          if (!event.defaultPrevented && !syntheticDefaultPrevented) {
            ancestorAction();
          }
        }}
      />,
    );
    fireEvent.change(directActions(view.host).input, {
      target: { value: "Ready" },
    });
    const actions = directActions(view.host);
    actions.cancel.focus();
    effects.preventDefault.mockClear();
    effects.focus.mockClear();

    const event = trustedKey(
      actions.cancel,
      navigationInit("ArrowRight"),
    );

    expect(event.defaultPrevented).toBe(true);
    expect(observations).toEqual([
      {
        defaultPrevented: true,
        syntheticDefaultPrevented: true,
      },
    ]);
    expect(ancestorAction).not.toHaveBeenCalled();
    expect(effects.preventDefault).toHaveBeenCalledOnce();
    expect(effects.focus).toHaveBeenCalledOnce();
    expect(actions.save).toHaveFocus();
  });

  it("accepts distinct phase wrappers with different prototypes and cancellation methods", () => {
    const effects = trackNavigationEffects(window);
    const view = renderStrict(
      <Harness
        editor={{}}
        documentId="doc-wrapper-pair"
        onSubmit={async () => undefined}
      />,
    );
    fireEvent.change(directActions(view.host).input, {
      target: { value: "Ready" },
    });
    const actions = directActions(view.host);
    const current = reactHandlers(actions.boundary);
    const capturePrototype = Object.freeze({ phase: "capture" });
    const bubblePrototype = Object.freeze({ phase: "bubble" });
    const captureDefault = vi.fn(() => false);
    const capturePropagation = vi.fn(() => false);
    const bubbleDefault = vi.fn(() => false);
    const bubblePropagation = vi.fn(() => false);
    const capturePrevent = vi.fn(function (
      this: ReactKeyboardEvent<HTMLDivElement>,
    ) {
      this.nativeEvent.preventDefault();
    });
    const bubblePrevent = vi.fn(function (
      this: ReactKeyboardEvent<HTMLDivElement>,
    ) {
      this.nativeEvent.preventDefault();
      Object.defineProperties(this, {
        defaultPrevented: {
          configurable: true,
          value: true,
        },
        isDefaultPrevented: {
          configurable: true,
          value: () => true,
        },
      });
    });
    let captureEvent: ReactKeyboardEvent<HTMLDivElement> | null = null;
    let bubbleEvent: ReactKeyboardEvent<HTMLDivElement> | null = null;
    actions.cancel.focus();
    effects.preventDefault.mockClear();
    effects.focus.mockClear();
    effects.focusCalls.length = 0;

    const event = withReactHandlers(
      actions.boundary,
      {
        capture: (reactEvent) => {
          captureEvent = reactEvent;
          Object.setPrototypeOf(reactEvent, capturePrototype);
          Object.defineProperties(reactEvent, {
            preventDefault: {
              configurable: true,
              value: capturePrevent,
            },
            isDefaultPrevented: {
              configurable: true,
              value: captureDefault,
            },
            isPropagationStopped: {
              configurable: true,
              value: capturePropagation,
            },
          });
          current.capture(reactEvent);
        },
        bubble: (reactEvent) => {
          bubbleEvent = reactEvent;
          Object.setPrototypeOf(reactEvent, bubblePrototype);
          Object.defineProperties(reactEvent, {
            preventDefault: {
              configurable: true,
              value: bubblePrevent,
            },
            isDefaultPrevented: {
              configurable: true,
              value: bubbleDefault,
            },
            isPropagationStopped: {
              configurable: true,
              value: bubblePropagation,
            },
          });
          current.bubble(reactEvent);
        },
      },
      () =>
        trustedKey(actions.cancel, navigationInit("ArrowRight")),
    );

    expect(captureEvent).not.toBe(bubbleEvent);
    expect(Object.getPrototypeOf(captureEvent)).toBe(capturePrototype);
    expect(Object.getPrototypeOf(bubbleEvent)).toBe(bubblePrototype);
    expect(captureDefault).not.toBe(bubbleDefault);
    expect(capturePropagation).not.toBe(bubblePropagation);
    expect(capturePrevent).not.toBe(bubblePrevent);
    expect(capturePrevent).not.toHaveBeenCalled();
    expect(bubblePrevent).toHaveBeenCalledOnce();
    expect(bubblePrevent.mock.contexts[0]).toBe(bubbleEvent);
    expect(captureDefault).toHaveBeenCalled();
    expect(capturePropagation).toHaveBeenCalled();
    expect(bubbleDefault).toHaveBeenCalled();
    expect(bubblePropagation).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(effects.preventDefault).toHaveBeenCalledOnce();
    expect(effects.focus).toHaveBeenCalledOnce();
    expect(effects.focusCalls).toEqual([
      {
        target: actions.save,
        options: { preventScroll: true },
      },
    ]);
  });

  it.each([
    ["capture", "preventDefault"],
    ["capture", "isDefaultPrevented"],
    ["capture", "isPropagationStopped"],
    ["bubble", "preventDefault"],
    ["bubble", "isDefaultPrevented"],
    ["bubble", "isPropagationStopped"],
  ] as const)(
    "rejects %s-wrapper %s drift and accepts a clean successor",
    (phase, property) => {
      const effects = trackNavigationEffects(window);
      const view = renderStrict(
        <Harness
          editor={{}}
          documentId="doc-method-drift"
          onSubmit={async () => undefined}
        />,
      );
      fireEvent.change(directActions(view.host).input, {
        target: { value: "Ready" },
      });
      const actions = directActions(view.host);
      const current = reactHandlers(actions.boundary);
      const replacement = vi.fn(() => false);
      actions.cancel.focus();
      effects.preventDefault.mockClear();
      effects.focus.mockClear();

      const rejected = withReactHandlers(
        actions.boundary,
        {
          capture: (event) => {
            current.capture(event);
            if (phase === "capture") {
              Object.defineProperty(event, property, {
                configurable: true,
                value: replacement,
              });
            }
          },
          bubble: (event) => {
            if (phase === "bubble") {
              const original = event[property];
              let reads = 0;
              Object.defineProperty(event, property, {
                configurable: true,
                get: () => {
                  reads += 1;
                  return reads === 1 ? original : replacement;
                },
              });
            }
            current.bubble(event);
          },
        },
        () =>
          trustedKey(actions.cancel, navigationInit("ArrowRight")),
      );
      expect(rejected.defaultPrevented).toBe(false);
      expect(effects.preventDefault).not.toHaveBeenCalled();
      expect(effects.focus).not.toHaveBeenCalled();
      expect(actions.cancel).toHaveFocus();

      const accepted = trustedKey(
        actions.cancel,
        navigationInit("ArrowRight"),
      );
      expect(accepted.defaultPrevented).toBe(true);
      expect(effects.preventDefault).toHaveBeenCalledOnce();
      expect(effects.focus).toHaveBeenCalledOnce();
      expect(actions.save).toHaveFocus();
    },
  );

  it.each(["code", "location"] as const)(
    "rejects native %s drift between phase deliveries and accepts a clean successor",
    (property) => {
      const effects = trackNavigationEffects(window);
      const view = renderStrict(
        <Harness
          editor={{}}
          documentId="doc-native-key-drift"
          onSubmit={async () => undefined}
        />,
      );
      fireEvent.change(directActions(view.host).input, {
        target: { value: "Ready" },
      });
      const actions = directActions(view.host);
      const current = reactHandlers(actions.boundary);
      actions.cancel.focus();
      effects.preventDefault.mockClear();
      effects.focus.mockClear();

      const rejected = withReactHandlers(
        actions.boundary,
        {
          capture: (event) => {
            current.capture(event);
            const implementation = jsdomEventImplementation(
              event.nativeEvent,
            );
            if (property === "code") {
              implementation.code = "Numpad6";
            } else {
              implementation.location = 3;
            }
          },
          bubble: current.bubble,
        },
        () =>
          trustedKey(actions.cancel, navigationInit("ArrowRight")),
      );
      expect(rejected.defaultPrevented).toBe(false);
      expect(effects.preventDefault).not.toHaveBeenCalled();
      expect(effects.focus).not.toHaveBeenCalled();
      expect(actions.cancel).toHaveFocus();

      const accepted = trustedKey(
        actions.cancel,
        navigationInit("ArrowRight", {
          code: "Numpad6",
          location: 3,
        }),
      );
      expect(accepted.defaultPrevented).toBe(true);
      expect(effects.preventDefault).toHaveBeenCalledOnce();
      expect(effects.focus).toHaveBeenCalledOnce();
      expect(actions.save).toHaveFocus();
    },
  );

  it("rejects reentrant DOM history from a cancellation method and recovers", () => {
    const effects = trackNavigationEffects(window);
    const view = renderStrict(
      <Harness
        editor={{}}
        documentId="doc-method-reentrancy"
        onSubmit={async () => undefined}
      />,
    );
    fireEvent.change(directActions(view.host).input, {
      target: { value: "Ready" },
    });
    let actions = directActions(view.host);
    const current = reactHandlers(actions.boundary);
    actions.cancel.focus();
    effects.preventDefault.mockClear();
    effects.focus.mockClear();

    const rejected = withReactHandlers(
      actions.boundary,
      {
        capture: current.capture,
        bubble: (event) => {
          let checks = 0;
          Object.defineProperty(event, "isPropagationStopped", {
            configurable: true,
            value: () => {
              checks += 1;
              if (checks === 3) {
                actions.boundary.insertBefore(actions.save, actions.cancel);
                actions.boundary.append(actions.save);
              }
              return false;
            },
          });
          current.bubble(event);
        },
      },
      () =>
        trustedKey(actions.cancel, navigationInit("ArrowRight")),
    );
    expect(rejected.defaultPrevented).toBe(false);
    expect(effects.preventDefault).not.toHaveBeenCalled();
    expect(effects.focus).not.toHaveBeenCalled();
    expect(actions.cancel).toHaveFocus();

    fireEvent.change(actions.input, {
      target: { value: "Ready again" },
    });
    actions = directActions(view.host);
    actions.cancel.focus();
    effects.focus.mockClear();
    const accepted = trustedKey(
      actions.cancel,
      navigationInit("ArrowRight"),
    );
    expect(accepted.defaultPrevented).toBe(true);
    expect(effects.preventDefault).toHaveBeenCalledOnce();
    expect(effects.focus).toHaveBeenCalledOnce();
    expect(actions.save).toHaveFocus();
  });

  it("prevents but refuses focus when the post-prevention query reenters", () => {
    const effects = trackNavigationEffects(window);
    const view = renderStrict(
      <Harness
        editor={{}}
        documentId="doc-post-prevention-reentrancy"
        onSubmit={async () => undefined}
      />,
    );
    fireEvent.change(directActions(view.host).input, {
      target: { value: "Ready" },
    });
    let actions = directActions(view.host);
    const current = reactHandlers(actions.boundary);
    actions.cancel.focus();
    effects.preventDefault.mockClear();
    effects.focus.mockClear();

    const prevented = withReactHandlers(
      actions.boundary,
      {
        capture: current.capture,
        bubble: (event) => {
          const reactPreventDefault = event.preventDefault;
          Object.defineProperty(event, "preventDefault", {
            configurable: true,
            value: function (
              this: ReactKeyboardEvent<HTMLDivElement>,
            ) {
              Reflect.apply(reactPreventDefault, this, []);
              Object.defineProperty(this, "isDefaultPrevented", {
                configurable: true,
                value: function (
                  this: ReactKeyboardEvent<HTMLDivElement>,
                ) {
                  Object.defineProperty(this, "defaultPrevented", {
                    configurable: true,
                    value: false,
                  });
                  return true;
                },
              });
            },
          });
          current.bubble(event);
        },
      },
      () =>
        trustedKey(actions.cancel, navigationInit("ArrowRight")),
    );
    expect(prevented.defaultPrevented).toBe(true);
    expect(effects.preventDefault).toHaveBeenCalledOnce();
    expect(effects.focus).not.toHaveBeenCalled();
    expect(actions.cancel).toHaveFocus();

    actions = directActions(view.host);
    effects.preventDefault.mockClear();
    effects.focus.mockClear();
    const accepted = trustedKey(
      actions.cancel,
      navigationInit("ArrowRight"),
    );
    expect(accepted.defaultPrevented).toBe(true);
    expect(effects.preventDefault).toHaveBeenCalledOnce();
    expect(effects.focus).toHaveBeenCalledOnce();
    expect(actions.save).toHaveFocus();
  });

  it("binds authority to the event-local Window receiver and rejects structural terminals", () => {
    const ownerWindow = window;
    const nativePath = ownerWindow.Event.prototype.composedPath;
    const currentTargetDescriptor = Object.getOwnPropertyDescriptor(
      ownerWindow.Event.prototype,
      "currentTarget",
    );
    if (typeof currentTargetDescriptor?.get !== "function") {
      throw new Error("Event.currentTarget has no intrinsic getter");
    }
    const observations: Array<{
      receiver: EventTarget;
      currentTarget: EventTarget | null;
      terminal: EventTarget | undefined;
    }> = [];
    const observer = function (this: EventTarget, event: Event) {
      observations.push({
        receiver: this,
        currentTarget: Reflect.apply(
          currentTargetDescriptor.get!,
          event,
          [],
        ) as EventTarget | null,
        terminal: (
          Reflect.apply(nativePath, event, []) as EventTarget[]
        ).at(-1),
      });
    };
    ownerWindow.addEventListener("keydown", observer, true);
    const effects = trackNavigationEffects(ownerWindow);
    const view = renderStrict(
      <Harness
        editor={{}}
        documentId="doc-window-proof"
        onSubmit={async () => undefined}
      />,
    );
    fireEvent.change(directActions(view.host).input, {
      target: { value: "Ready" },
    });
    const actions = directActions(view.host);
    actions.cancel.focus();
    effects.preventDefault.mockClear();
    effects.focus.mockClear();
    const accepted = trustedKey(
      actions.cancel,
      navigationInit("ArrowRight"),
    );
    ownerWindow.removeEventListener("keydown", observer, true);

    expect(accepted.defaultPrevented).toBe(true);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.currentTarget).toBe(
      observations[0]?.receiver,
    );
    expect(observations[0]?.terminal).toBe(observations[0]?.receiver);
    expect(effects.preventDefault).toHaveBeenCalledOnce();
    expect(effects.focus).toHaveBeenCalledOnce();
  });

  it("accepts a foreign owner facade and its proven backing receiver but rejects a lookalike view", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const ownerDocument = frame.contentDocument;
    const backingWindow = frame.contentWindow;
    if (!ownerDocument || !backingWindow) {
      frame.remove();
      throw new Error("The foreign keyboard realm was unavailable");
    }
    const addEventListener =
      backingWindow.addEventListener.bind(backingWindow);
    const removeEventListener =
      backingWindow.removeEventListener.bind(backingWindow);
    let ownerWindow!: Window & typeof globalThis;
    ownerWindow = new Proxy(backingWindow, {
      get: (target, property) => {
        if (property === "addEventListener") return addEventListener;
        if (property === "removeEventListener") return removeEventListener;
        return Reflect.get(target, property, target);
      },
    }) as Window & typeof globalThis;
    Object.defineProperty(ownerDocument, "defaultView", {
      configurable: true,
      value: ownerWindow,
    });
    if (ownerDocument.defaultView !== ownerWindow) {
      frame.remove();
      throw new Error("The foreign Window facade was not published");
    }
    const backingReceiver: EventTarget = backingWindow;
    const lookalike = Object.create(
      ownerWindow.Window.prototype,
    ) as Window & Record<string, unknown>;
    Object.defineProperties(lookalike, {
      document: { configurable: true, value: ownerDocument },
      window: { configurable: true, value: lookalike },
      self: { configurable: true, value: lookalike },
      Event: { configurable: true, value: ownerWindow.Event },
      KeyboardEvent: {
        configurable: true,
        value: ownerWindow.KeyboardEvent,
      },
      Object: { configurable: true, value: ownerWindow.Object },
      Reflect: { configurable: true, value: ownerWindow.Reflect },
    });

    withGlobalDocument(ownerDocument, () => {
      const effects = trackNavigationEffects(ownerWindow);
      const view = renderStrict(
        <Harness
          editor={{}}
          documentId="doc-foreign-window-proof"
          onSubmit={async () => undefined}
        />,
        ownerDocument,
      );
      fireEvent.change(directActions(view.host).input, {
        target: { value: "Ready" },
      });
      let actions = directActions(view.host);
      actions.cancel.focus();
      effects.preventDefault.mockClear();
      effects.focus.mockClear();

      const facade = trustedKey(
        actions.cancel,
        navigationInit("ArrowRight"),
        true,
        ownerWindow,
      );
      expect(facade.defaultPrevented).toBe(true);
      expect(actions.save).toHaveFocus();

      actions = directActions(view.host);
      effects.preventDefault.mockClear();
      effects.focus.mockClear();
      const backing = trustedKey(
        actions.save,
        navigationInit("ArrowLeft"),
        true,
        backingReceiver,
      );
      expect(backing.defaultPrevented).toBe(true);
      expect(actions.cancel).toHaveFocus();

      actions = directActions(view.host);
      effects.preventDefault.mockClear();
      effects.focus.mockClear();
      const structural = trustedKey(
        actions.cancel,
        navigationInit("ArrowRight"),
        true,
        lookalike,
      );
      expect(structural.defaultPrevented).toBe(false);
      expect(effects.preventDefault).not.toHaveBeenCalled();
      expect(effects.focus).not.toHaveBeenCalled();
      expect(actions.cancel).toHaveFocus();
    });
  });

  it("rejects a Window-shaped path terminal and recovers on a clean event", () => {
    const ownerWindow = window;
    const nativePath = ownerWindow.Event.prototype.composedPath;
    const lookalike = Object.create(
      ownerWindow.Window.prototype,
    ) as Window & Record<string, unknown>;
    Object.defineProperties(lookalike, {
      document: { configurable: true, value: ownerWindow.document },
      window: { configurable: true, value: lookalike },
      self: { configurable: true, value: lookalike },
      Event: { configurable: true, value: ownerWindow.Event },
      KeyboardEvent: {
        configurable: true,
        value: ownerWindow.KeyboardEvent,
      },
      Object: { configurable: true, value: ownerWindow.Object },
      Reflect: { configurable: true, value: ownerWindow.Reflect },
    });
    let spoofTerminal = true;
    vi.spyOn(
      ownerWindow.Event.prototype,
      "composedPath",
    ).mockImplementation(function (this: Event) {
      const path = Reflect.apply(nativePath, this, []) as EventTarget[];
      return spoofTerminal && path.length > 0
        ? [...path.slice(0, -1), lookalike]
        : path;
    });
    const effects = trackNavigationEffects(ownerWindow);
    const view = renderStrict(
      <Harness
        editor={{}}
        documentId="doc-window-lookalike"
        onSubmit={async () => undefined}
      />,
    );
    fireEvent.change(directActions(view.host).input, {
      target: { value: "Ready" },
    });
    const actions = directActions(view.host);
    actions.cancel.focus();
    effects.preventDefault.mockClear();
    effects.focus.mockClear();

    const rejected = trustedKey(
      actions.cancel,
      navigationInit("ArrowRight"),
    );
    expect(rejected.defaultPrevented).toBe(false);
    expect(effects.preventDefault).not.toHaveBeenCalled();
    expect(effects.focus).not.toHaveBeenCalled();
    expect(actions.cancel).toHaveFocus();

    spoofTerminal = false;
    const accepted = trustedKey(
      actions.cancel,
      navigationInit("ArrowRight"),
    );
    expect(accepted.defaultPrevented).toBe(true);
    expect(effects.preventDefault).toHaveBeenCalledOnce();
    expect(effects.focus).toHaveBeenCalledOnce();
    expect(actions.save).toHaveFocus();
  });

  it("rejects stale handlers, restored DOM history, and native replay before clean recovery", () => {
    const effects = trackNavigationEffects(window);
    const onSubmit = vi.fn(async () => undefined);
    const onOpenChange = vi.fn();
    const view = renderStrict(
      <Harness
        editor={{}}
        documentId="doc-history"
        onSubmit={onSubmit}
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.change(directActions(view.host).input, {
      target: { value: "First title" },
    });
    let actions = directActions(view.host);
    const stale = reactHandlers(actions.boundary);
    fireEvent.change(actions.input, {
      target: { value: "Current title" },
    });
    actions = directActions(view.host);
    actions.cancel.focus();
    effects.preventDefault.mockClear();
    effects.focus.mockClear();

    const staleEvent = withReactHandlers(
      actions.boundary,
      { capture: stale.capture, bubble: stale.bubble },
      () =>
        trustedKey(actions.cancel, navigationInit("ArrowRight")),
    );
    expect(staleEvent.defaultPrevented).toBe(false);
    expect(effects.preventDefault).not.toHaveBeenCalled();
    expect(effects.focus).not.toHaveBeenCalled();

    actions.boundary.insertBefore(actions.save, actions.cancel);
    actions.boundary.append(actions.save);
    const restored = trustedKey(
      actions.cancel,
      navigationInit("ArrowRight"),
    );
    expect(restored.defaultPrevented).toBe(false);
    expect(effects.preventDefault).not.toHaveBeenCalled();
    expect(effects.focus).not.toHaveBeenCalled();

    fireEvent.change(actions.input, {
      target: { value: "Recovery title" },
    });
    actions = directActions(view.host);
    actions.cancel.focus();
    effects.preventDefault.mockClear();
    effects.focus.mockClear();
    const accepted = trustedKey(
      actions.cancel,
      navigationInit("ArrowRight"),
    );
    expect(accepted.defaultPrevented).toBe(true);
    expect(actions.save).toHaveFocus();
    fireEvent(actions.cancel, accepted);
    expect(effects.preventDefault).toHaveBeenCalledOnce();
    expect(effects.focus).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(actions.input).toHaveValue("Recovery title");
  });

  it("removes navigation authority on cleanup and leaves a fresh Strict root usable", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const effects = trackNavigationEffects(window);
    const retired = renderStrict(
      <Harness
        editor={{}}
        documentId="doc-retired"
        onSubmit={async () => undefined}
      />,
    );
    fireEvent.change(directActions(retired.host).input, {
      target: { value: "Retired" },
    });
    const retiredActions = directActions(retired.host);
    const retiredButton = retiredActions.cancel;
    act(() => retired.root.unmount());
    retired.host.remove();
    directViews.splice(directViews.indexOf(retired), 1);
    const registrations = add.mock.calls.filter(
      ([type, , options]) => type === "keydown" && options === true,
    ).length;
    const removals = remove.mock.calls.filter(
      ([type, , options]) => type === "keydown" && options === true,
    ).length;
    expect(removals).toBe(registrations);
    effects.preventDefault.mockClear();
    effects.focus.mockClear();
    const retiredEvent = trustedKey(
      retiredButton,
      navigationInit("ArrowRight"),
    );
    expect(retiredEvent.defaultPrevented).toBe(false);
    expect(effects.preventDefault).not.toHaveBeenCalled();
    expect(effects.focus).not.toHaveBeenCalled();

    const fresh = renderStrict(
      <Harness
        editor={{}}
        documentId="doc-fresh"
        onSubmit={async () => undefined}
      />,
    );
    fireEvent.change(directActions(fresh.host).input, {
      target: { value: "Fresh" },
    });
    const freshActions = directActions(fresh.host);
    freshActions.cancel.focus();
    effects.preventDefault.mockClear();
    effects.focus.mockClear();
    const freshEvent = trustedKey(
      freshActions.cancel,
      navigationInit("ArrowRight"),
    );
    expect(freshEvent.defaultPrevented).toBe(true);
    expect(effects.preventDefault).toHaveBeenCalledOnce();
    expect(effects.focus).toHaveBeenCalledOnce();
    expect(freshActions.save).toHaveFocus();
  });

  it("retains native Tab order, Enter and Space activation, and title-field submit", async () => {
    const user = userEvent.setup();
    const tabSubmit = vi.fn<
      (owner: NameVersionSaveOwner) => Promise<void>
    >(async () => undefined);
    const tabClose = vi.fn();
    const tabView = renderStrict(
      <Harness
        editor={{}}
        documentId="doc-tab"
        onSubmit={tabSubmit}
        onOpenChange={tabClose}
      />,
    );
    let actions = directActions(tabView.host);
    await user.type(actions.input, "Tab save");
    expect(actions.input).toHaveFocus();
    await user.tab();
    actions = directActions(tabView.host);
    expect(actions.cancel).toHaveFocus();
    await user.tab();
    expect(actions.save).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(tabSubmit).toHaveBeenCalledOnce());
    expect(tabSubmit.mock.calls[0]?.[0].title).toBe("Tab save");
    await waitFor(() => expect(tabClose).toHaveBeenCalledWith(false));

    const spaceClose = vi.fn();
    const spaceView = renderStrict(
      <Harness
        editor={{}}
        documentId="doc-space"
        onSubmit={async () => undefined}
        onOpenChange={spaceClose}
      />,
    );
    actions = directActions(spaceView.host);
    actions.cancel.focus();
    await user.keyboard(" ");
    expect(spaceClose).toHaveBeenCalledExactlyOnceWith(false);

    const inputSubmit = vi.fn<
      (owner: NameVersionSaveOwner) => Promise<void>
    >(async () => undefined);
    const inputView = renderStrict(
      <Harness
        editor={{}}
        documentId="doc-input-submit"
        onSubmit={inputSubmit}
      />,
    );
    actions = directActions(inputView.host);
    await user.type(actions.input, "Field submit{Enter}");
    await waitFor(() => expect(inputSubmit).toHaveBeenCalledOnce());
    expect(inputSubmit.mock.calls[0]?.[0].title).toBe("Field submit");
  });
});

describe("NameVersionDialog save ownership", () => {
  it("takes one synchronous owner with the exact trimmed snapshot and closes once on current success", async () => {
    const pending = deferred<void>();
    const editor = {};
    const onSubmit = vi.fn<(owner: NameVersionSaveOwner) => Promise<void>>(() => pending.promise);
    const onOpenChange = vi.fn();
    render(<Harness editor={editor} documentId="doc-1" onSubmit={onSubmit} onOpenChange={onOpenChange} />);

    const input = screen.getByTestId("version-name");
    fireEvent.change(input, { target: { value: "  Draft sent for review  " } });
    submitImmediatelyTwice();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const owner = onSubmit.mock.calls[0][0];
    expect(owner).toMatchObject({
      editor,
      documentId: "doc-1",
      operationId: 1,
      title: "Draft sent for review",
      visit: { id: 1, editor, documentId: "doc-1" },
    });
    expect(input).toBeDisabled();
    expect(screen.getByTestId("version-name-submit")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("does not cancel the version already being saved");

    fireEvent.change(input, { target: { value: "A forced late edit" } });
    fireEvent.submit(form());
    expect(input).toHaveValue("  Draft sent for review  ");
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("formats the current API failure inline, preserves the title, and admits one intentional retry", async () => {
    const failed = deferred<void>();
    const retry = deferred<void>();
    const onSubmit = vi.fn().mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    const onOpenChange = vi.fn();
    render(<Harness editor={{}} documentId="doc-1" onSubmit={onSubmit} onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Release candidate" } });
    fireEvent.submit(form());
    await act(async () => failed.reject(new ApiError(400, "Invalid request", [{ message: "Version names must be unique" }])));

    expect(screen.getByRole("alert")).toHaveTextContent("Version names must be unique");
    expect(screen.getByTestId("version-name")).toHaveValue("Release candidate");
    expect(screen.getByTestId("version-name")).toBeEnabled();
    expect(screen.getByTestId("version-name-submit")).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    submitImmediatelyTwice();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[1][0]).toMatchObject({ operationId: 2, title: "Release candidate" });
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => retry.resolve());
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("retires Cancel before an old success and keeps newer same-document work current", async () => {
    const stale = deferred<void>();
    const current = deferred<void>();
    const onSubmit = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const onOpenChange = vi.fn();
    render(<Harness editor={{}} documentId="doc-1" onSubmit={onSubmit} onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Old visit" } });
    fireEvent.submit(form());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Open version dialog" }));
    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Current visit" } });
    fireEvent.submit(form());
    expect(screen.getByTestId("version-name")).toBeDisabled();

    await act(async () => stale.resolve());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("version-name")).toHaveValue("Current visit");
    expect(screen.getByTestId("version-name")).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onOpenChange).toHaveBeenCalledTimes(1);

    await act(async () => current.resolve());
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("retires the actual Dialog close before an old failure can change a reopened visit", async () => {
    const stale = deferred<void>();
    const onSubmit = vi.fn<(owner: NameVersionSaveOwner) => Promise<void>>(() => stale.promise);
    const onOpenChange = vi.fn();
    render(<Harness editor={{}} documentId="doc-1" onSubmit={onSubmit} onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Old visit" } });
    fireEvent.submit(form());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Open version dialog" }));
    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Replacement title" } });

    await act(async () => stale.reject(new Error("Obsolete failure")));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("version-name")).toHaveValue("Replacement title");
    expect(screen.getByTestId("version-name")).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("routes Escape and overlay dismissal through the same retiring close boundary", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const second = deferred<void>();
    const onSubmit = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onOpenChange = vi.fn();
    render(<Harness editor={{}} documentId="doc-1" onSubmit={onSubmit} onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Escape save" } });
    fireEvent.submit(form());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Open version dialog" }));
    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Overlay save" } });
    fireEvent.submit(form());
    const overlay = document.querySelector(".dialog-overlay")!;
    await user.click(overlay);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve();
      second.reject(new Error("Closed failure"));
      await Promise.allSettled([first.promise, second.promise]);
    });
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it("retires ownership on unmount and consumes late rejection without reading or reporting it", async () => {
    const pending = deferred<void>();
    const readMessage = vi.fn(() => "Too late");
    const error = new Error();
    Object.defineProperty(error, "message", { get: readMessage });
    const unhandled = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener("unhandledrejection", unhandled);
    const view = render(<Harness editor={{}} documentId="doc-1" onSubmit={() => pending.promise} />);

    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Unmounted save" } });
    fireEvent.submit(form());
    view.unmount();
    await act(async () => {
      pending.reject(error);
      await pending.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(readMessage).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});
