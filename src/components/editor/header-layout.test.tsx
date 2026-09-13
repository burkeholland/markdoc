// @vitest-environment jsdom
import {
  StrictMode,
  useCallback,
  useLayoutEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Layout } from "@/lib/viewport";
import { LayoutSegment } from "./header";

type LayoutKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => void;

interface DirectView {
  readonly host: HTMLDivElement;
  readonly root: Root;
}

const views = new Set<DirectView>();

function renderDirect(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { host, root: createRoot(host) };
  views.add(view);
  act(() => view.root.render(node));
  return view;
}

function ControlledSegment({
  initial = "rich",
  onChange,
}: {
  initial?: Layout;
  onChange: (layout: Layout) => void;
}) {
  const [layout, setLayout] = useState(initial);
  const change = useCallback((next: Layout) => {
    onChange(next);
    setLayout(next);
  }, [onChange]);
  return <LayoutSegment layout={layout} onLayout={change} />;
}

function segment(host: ParentNode) {
  const element = host.querySelector('[data-testid="layout-segment"]');
  if (!(element instanceof HTMLDivElement)) {
    throw new Error("The phone pane switch was not rendered");
  }
  return element;
}

function pane(host: ParentNode, layout: "rich" | "code") {
  const element = host.querySelector(`[data-testid="layout-segment-${layout}"]`);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`The ${layout} pane radio was not rendered`);
  }
  return element;
}

function reactProperties(element: Element): Record<string, unknown> {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the pane radio");
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  if (!props) throw new Error("React props were not available on the pane radio");
  return props;
}

function reactPropsEntry(element: Element) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the pane radio");
  const record = element as unknown as Record<string, Record<string, unknown> | undefined>;
  const props = record[propsKey];
  if (!props) throw new Error("React props were not available on the pane radio");
  return { propsKey, record, props };
}

function captureKeyDown(element: HTMLButtonElement): LayoutKeyDown {
  const handler = reactProperties(element).onKeyDown;
  if (typeof handler !== "function") {
    throw new Error("The pane radio did not have an onKeyDown handler");
  }
  return handler as LayoutKeyDown;
}

function captureKeyDownCapture(element: HTMLButtonElement): LayoutKeyDown {
  const handler = reactProperties(element).onKeyDownCapture;
  if (typeof handler !== "function") {
    throw new Error("The pane radio did not have an onKeyDownCapture handler");
  }
  return handler as LayoutKeyDown;
}

function interceptKeyDown(
  element: HTMLButtonElement,
  name: "onKeyDown" | "onKeyDownCapture",
  invoke: (
    original: LayoutKeyDown,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void,
) {
  const { propsKey, record, props } = reactPropsEntry(element);
  const original = props[name];
  if (typeof original !== "function") {
    throw new Error(`The pane radio did not have an ${name} handler`);
  }
  record[propsKey] = {
    ...props,
    [name]: (event: ReactKeyboardEvent<HTMLButtonElement>) =>
      invoke(original as LayoutKeyDown, event),
  };
  return () => {
    record[propsKey] = props;
  };
}

function replacePublicEventValue(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  property: keyof ReactKeyboardEvent<HTMLButtonElement>,
  value: unknown,
) {
  const descriptor = Object.getOwnPropertyDescriptor(event, property);
  if (!descriptor || !descriptor.configurable) {
    throw new Error(`${String(property)} was not configurable public event data`);
  }
  Object.defineProperty(event, property, { ...descriptor, value });
}

function exposePublicScalarsAsAccessors(
  event: ReactKeyboardEvent<HTMLButtonElement>,
) {
  const properties = [
    "nativeEvent",
    "type",
    "target",
    "currentTarget",
    "eventPhase",
    "bubbles",
    "cancelable",
    "defaultPrevented",
    "isTrusted",
    "timeStamp",
    "view",
    "detail",
    "key",
    "code",
    "location",
    "repeat",
    "altKey",
    "ctrlKey",
    "metaKey",
    "shiftKey",
    "charCode",
    "keyCode",
    "which",
  ] as const;
  for (const property of properties) {
    const descriptor = Object.getOwnPropertyDescriptor(event, property);
    if (!descriptor || !("value" in descriptor) || !descriptor.configurable) {
      throw new Error(`${property} was not configurable public event data`);
    }
    let value = descriptor.value;
    Object.defineProperty(event, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: () => value,
      set: (next) => {
        value = next;
      },
    });
  }
}

type CompatibilityMode = "absent" | "replaced" | "non-function";

function customizeReactKeyWrapper(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  phase: "capture" | "bubble",
  compatibility: CompatibilityMode,
  preventReceivers: object[],
  defaultReceivers: object[],
  propagationReceivers: object[],
) {
  const originalPreventDefault = event.preventDefault;
  const originalIsDefaultPrevented = event.isDefaultPrevented;
  const originalIsPropagationStopped = event.isPropagationStopped;
  event.preventDefault = function publicPrevention(this: object) {
    preventReceivers.push(this);
    return Reflect.apply(originalPreventDefault, this, []);
  };
  event.isDefaultPrevented = function publicDefaultQuery(this: object) {
    defaultReceivers.push(this);
    return Reflect.apply(originalIsDefaultPrevented, this, []);
  };
  event.isPropagationStopped = function publicPropagationQuery(this: object) {
    propagationReceivers.push(this);
    return Reflect.apply(originalIsPropagationStopped, this, []);
  };
  const prototype = Object.create(null) as Record<string, unknown>;
  prototype[`${phase}Only`] = true;
  for (const name of [
    "_reactName",
    "persist",
    "isPersistent",
    "stopPropagation",
  ] as const) {
    if (!Reflect.deleteProperty(event, name)) {
      throw new Error(`${name} was not removable React compatibility data`);
    }
  }
  if (compatibility === "replaced") {
    Object.defineProperties(event, {
      _reactName: { configurable: true, value: `replaced-${phase}` },
      persist: { configurable: true, value: vi.fn() },
      isPersistent: { configurable: true, value: vi.fn(() => false) },
      stopPropagation: { configurable: true, value: vi.fn() },
    });
  } else if (compatibility === "non-function") {
    Object.defineProperties(event, {
      _reactName: { configurable: true, value: 17 },
      persist: { configurable: true, value: null },
      isPersistent: { configurable: true, value: "no" },
      stopPropagation: { configurable: true, value: false },
    });
  }
  Object.setPrototypeOf(event, prototype);
}

function captureRef<T extends Element>(element: T): RefCallback<T> {
  const ref = reactProperties(element).ref;
  if (typeof ref !== "function") {
    throw new Error("The pane control did not have a callback ref");
  }
  return ref as RefCallback<T>;
}

function markJsdomEventTrusted(event: Event) {
  // jsdom has no hardware input; set its internal slot so accepted paths model browser input.
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

function keyboardEvent(
  ownerDocument: Document,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
  trusted = true,
) {
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The owner document has no window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    key,
    ...init,
  });
  if (trusted) markJsdomEventTrusted(event);
  return event;
}

function dispatchKey(
  target: Element,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
) {
  const event = keyboardEvent(target.ownerDocument, key, init);
  target.dispatchEvent(event);
  return event;
}

function dispatchWithKeyDown(
  target: HTMLButtonElement,
  event: KeyboardEvent,
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void,
) {
  const propsKey = Object.keys(target).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the pane radio");
  const properties = target as unknown as Record<string, Record<string, unknown>>;
  const props = properties[propsKey];
  const replacement = { ...props, onKeyDown };
  properties[propsKey] = replacement;
  try {
    target.dispatchEvent(event);
  } finally {
    if (properties[propsKey] === replacement) properties[propsKey] = props;
  }
}

function primaryClick(ownerDocument: Document) {
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent;
  if (!MouseEventConstructor) throw new Error("The owner document has no MouseEvent");
  return new MouseEventConstructor("click", {
    bubbles: true,
    button: 0,
    cancelable: true,
  });
}

function strictSegment(
  onChange: (layout: Layout) => void,
  initial: Layout = "rich",
) {
  return (
    <StrictMode>
      <ControlledSegment initial={initial} onChange={onChange} />
    </StrictMode>
  );
}

function expectSelection(host: ParentNode, selected: "rich" | "code") {
  const other = selected === "rich" ? "code" : "rich";
  expect(pane(host, selected)).toHaveAttribute("aria-checked", "true");
  expect(pane(host, other)).toHaveAttribute("aria-checked", "false");
  expect(pane(host, selected).tabIndex).toBe(0);
  expect(pane(host, other).tabIndex).toBe(-1);
}

afterEach(async () => {
  for (const view of views) {
    await act(async () => view.root.unmount());
    view.host.remove();
  }
  views.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("phone pane switch keyboard navigation", () => {
  it("keeps two labeled 32 px radios, one tab stop, phone visibility, order, icons, and native clicks", () => {
    const onChange = vi.fn<(layout: Layout) => void>();
    const { host } = renderDirect(strictSegment(onChange));
    const root = segment(host);
    const preview = pane(host, "rich");
    const markdown = pane(host, "code");

    expect(root).toHaveAttribute("role", "radiogroup");
    expect(root).toHaveAttribute("aria-label", "Pane");
    expect(root).toHaveClass("h-9", "md:hidden");
    expect([...root.children]).toEqual([preview, markdown]);
    expect([preview, markdown].map((button) => button.getAttribute("role")))
      .toEqual(["radio", "radio"]);
    expect([preview, markdown].map((button) => button.getAttribute("aria-label")))
      .toEqual(["Preview", "Markdown"]);
    expect([preview, markdown].map((button) => button.getAttribute("title")))
      .toEqual(["Preview", "Markdown"]);
    expect([preview, markdown].map((button) => button.classList.contains("h-8")))
      .toEqual([true, true]);
    expect([preview, markdown].map((button) => button.classList.contains("w-8")))
      .toEqual([true, true]);
    expect(preview.querySelector("svg")).toHaveClass("lucide-eye");
    expect(markdown.querySelector("svg")).toHaveClass("lucide-code-xml");
    expectSelection(host, "rich");

    const toMarkdown = primaryClick(document);
    act(() => markdown.querySelector("svg")!.dispatchEvent(toMarkdown));
    expect(toMarkdown.defaultPrevented).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith("code");
    expectSelection(host, "code");

    const toPreview = primaryClick(document);
    act(() => pane(host, "rich").dispatchEvent(toPreview));
    expect(toPreview.defaultPrevented).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith("rich");
    expect(onChange).toHaveBeenCalledTimes(2);
    expectSelection(host, "rich");
  });

  it.each([
    ["ArrowRight", "rich", "code"],
    ["ArrowDown", "rich", "code"],
    ["ArrowLeft", "code", "rich"],
    ["ArrowUp", "code", "rich"],
    ["ArrowRight", "code", "rich"],
    ["ArrowLeft", "rich", "code"],
    ["Home", "code", "rich"],
    ["End", "rich", "code"],
  ] as const)(
    "moves once with %s from %s to %s without scrolling",
    (key, initial, destination) => {
      const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
      const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
      const onChange = vi.fn<(layout: Layout) => void>();
      const { host } = renderDirect(strictSegment(onChange, initial));
      const source = pane(host, initial);
      const originalDestination = pane(host, destination);
      const publicFocus = vi.fn();
      Object.defineProperty(originalDestination, "focus", {
        configurable: true,
        value: publicFocus,
      });
      const beforeScroll = [window.scrollX, window.scrollY];
      source.focus();
      focus.mockClear();

      let event!: KeyboardEvent;
      act(() => {
        event = dispatchKey(source, key);
      });

      const selected = pane(host, destination);
      expect(event.defaultPrevented).toBe(true);
      expect(
        preventDefault.mock.instances.filter((instance) => instance === event),
      ).toHaveLength(1);
      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledWith(destination);
      expectSelection(host, destination);
      expect(selected).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      expect(focus.mock.instances[0]).toBe(selected);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(publicFocus).not.toHaveBeenCalled();
      expect([window.scrollX, window.scrollY]).toEqual(beforeScroll);
    },
  );

  it.each([
    ["Home", "rich"],
    ["End", "code"],
  ] as const)("leaves %s inert at its current destination", (key, initial) => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const onChange = vi.fn<(layout: Layout) => void>();
    const { host } = renderDirect(strictSegment(onChange, initial));
    const source = pane(host, initial);
    source.focus();
    focus.mockClear();

    const event = dispatchKey(source, key);

    expect(event.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectSelection(host, initial);
  });

  it.each(["Tab", "Enter", " ", "Escape"] as const)(
    "leaves native %s behavior unprevented and unselected",
    (key) => {
      const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
      const onChange = vi.fn<(layout: Layout) => void>();
      const { host } = renderDirect(strictSegment(onChange));
      const source = pane(host, "rich");
      source.focus();
      focus.mockClear();

      const event = dispatchKey(source, key);

      expect(event.defaultPrevented).toBe(false);
      expect(onChange).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expectSelection(host, "rich");
      expect(source).toHaveFocus();
    },
  );

  it("does not query a composed path for keys outside the pane switch", () => {
    const composedPath = vi.spyOn(window.Event.prototype, "composedPath");
    const onChange = vi.fn<(layout: Layout) => void>();
    const { host } = renderDirect(strictSegment(onChange));
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();

    dispatchKey(outside, "ArrowRight");

    expect(composedPath).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expectSelection(host, "rich");
  });

  it.each(["absent", "replaced", "non-function"] as const)(
    "pairs independent public wrappers with %s private and optional members",
    (compatibility) => {
      const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
      const onChange = vi.fn<(layout: Layout) => void>();
      const { host } = renderDirect(strictSegment(onChange));
      const source = pane(host, "rich");
      const capturePreventReceivers: object[] = [];
      const bubblePreventReceivers: object[] = [];
      const captureDefaultReceivers: object[] = [];
      const bubbleDefaultReceivers: object[] = [];
      const capturePropagationReceivers: object[] = [];
      const bubblePropagationReceivers: object[] = [];
      let captureWrapper: ReactKeyboardEvent<HTMLButtonElement> | null = null;
      let bubbleWrapper: ReactKeyboardEvent<HTMLButtonElement> | null = null;
      const restoreCapture = interceptKeyDown(
        source,
        "onKeyDownCapture",
        (original, event) => {
          captureWrapper = event;
          customizeReactKeyWrapper(
            event,
            "capture",
            compatibility,
            capturePreventReceivers,
            captureDefaultReceivers,
            capturePropagationReceivers,
          );
          original(event);
        },
      );
      const restoreBubble = interceptKeyDown(
        source,
        "onKeyDown",
        (original, event) => {
          bubbleWrapper = event;
          customizeReactKeyWrapper(
            event,
            "bubble",
            compatibility,
            bubblePreventReceivers,
            bubbleDefaultReceivers,
            bubblePropagationReceivers,
          );
          original(event);
        },
      );
      source.focus();
      focus.mockClear();
      try {
        const event = dispatchKey(source, "ArrowRight");

        expect(event.defaultPrevented).toBe(true);
        expect(captureWrapper).not.toBeNull();
        expect(bubbleWrapper).not.toBeNull();
        expect(captureWrapper).not.toBe(bubbleWrapper);
        expect(Object.getPrototypeOf(captureWrapper))
          .not.toBe(Object.getPrototypeOf(bubbleWrapper));
        expect(capturePreventReceivers).toEqual([]);
        expect(bubblePreventReceivers).toEqual([bubbleWrapper]);
        expect(captureDefaultReceivers.every(
          (receiver) => receiver === captureWrapper,
        )).toBe(true);
        expect(bubbleDefaultReceivers.every(
          (receiver) => receiver === bubbleWrapper,
        )).toBe(true);
        expect(capturePropagationReceivers.every(
          (receiver) => receiver === captureWrapper,
        )).toBe(true);
        expect(bubblePropagationReceivers.every(
          (receiver) => receiver === bubbleWrapper,
        )).toBe(true);
        expect(onChange).toHaveBeenCalledOnce();
        expect(onChange).toHaveBeenCalledWith("code");
        expect(pane(host, "code")).toHaveFocus();
        expect(focus).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      } finally {
        restoreBubble();
        restoreCapture();
      }
    },
  );

  it("accepts exact public keyboard scalars exposed through ordinary accessors", () => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const onChange = vi.fn<(layout: Layout) => void>();
    const { host } = renderDirect(strictSegment(onChange));
    const source = pane(host, "rich");
    const restoreCapture = interceptKeyDown(
      source,
      "onKeyDownCapture",
      (original, event) => {
        exposePublicScalarsAsAccessors(event);
        original(event);
      },
    );
    const restoreBubble = interceptKeyDown(
      source,
      "onKeyDown",
      (original, event) => {
        exposePublicScalarsAsAccessors(event);
        original(event);
      },
    );
    source.focus();
    focus.mockClear();
    try {
      const event = dispatchKey(source, "ArrowRight", {
        code: "Numpad6",
        location: 3,
      });

      expect(event.defaultPrevented).toBe(true);
      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledWith("code");
      expect(pane(host, "code")).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      restoreBubble();
      restoreCapture();
    }
  });

  it("retains the exact native pair across nested capture microtask checkpoints", () => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const onChange = vi.fn<(layout: Layout) => void>();
    const { host } = renderDirect(strictSegment(onChange));
    const source = pane(host, "rich");
    const ownerWindow = source.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("The pane radio did not have an owner Window");
    const checkpoints: number[] = [];
    const restoreCapture = interceptKeyDown(
      source,
      "onKeyDownCapture",
      (original, event) => {
        const queue = vi.spyOn(ownerWindow, "queueMicrotask").mockImplementation(
          (callback: VoidFunction) => {
            checkpoints.push(checkpoints.length + 1);
            callback();
          },
        );
        try {
          original(event);
          const checkpoint = (remaining: number) => {
            if (remaining < 1) return;
            ownerWindow.queueMicrotask(() => checkpoint(remaining - 1));
          };
          checkpoint(2);
        } finally {
          queue.mockRestore();
        }
      },
    );
    source.focus();
    focus.mockClear();
    try {
      const event = dispatchKey(source, "ArrowRight");

      expect(checkpoints).toHaveLength(2);
      expect(event.defaultPrevented).toBe(true);
      expect(onChange).toHaveBeenCalledOnce();
      expect(pane(host, "code")).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      restoreCapture();
    }
  });

  it("accepts exact owner Window views and rejects a structural lookalike", () => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const onChange = vi.fn<(layout: Layout) => void>();
    const { host } = renderDirect(strictSegment(onChange));
    const source = pane(host, "rich");
    const ownerWindow = source.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("The pane radio did not have an owner Window");
    const restoreLookalike = interceptKeyDown(
      source,
      "onKeyDownCapture",
      (original, event) => {
        replacePublicEventValue(event, "view", Object.create(ownerWindow));
        original(event);
      },
    );
    source.focus();
    focus.mockClear();

    const rejected = dispatchKey(source, "ArrowRight");
    restoreLookalike();
    expect(rejected.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    const setOwnerWindow = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      replacePublicEventValue(event, "view", ownerWindow);
    };
    const restoreCapture = interceptKeyDown(
      source,
      "onKeyDownCapture",
      (original, event) => {
        setOwnerWindow(event);
        original(event);
      },
    );
    const restoreBubble = interceptKeyDown(
      source,
      "onKeyDown",
      (original, event) => {
        setOwnerWindow(event);
        original(event);
      },
    );
    try {
      const accepted = dispatchKey(source, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(onChange).toHaveBeenCalledOnce();
      expect(pane(host, "code")).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      restoreBubble();
      restoreCapture();
    }
  });

  it("uses public bubble prevention with captured key, path, active-element, and focus authorities", () => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const onChange = vi.fn<(layout: Layout) => void>();
    const { host } = renderDirect(strictSegment(onChange));
    const source = pane(host, "rich");
    const destination = pane(host, "code");
    const publicFocus = vi.fn();
    Object.defineProperty(destination, "focus", {
      configurable: true,
      value: publicFocus,
    });
    source.focus();
    focus.mockClear();
    const event = keyboardEvent(document, "ArrowRight");
    const nativePreventDefault = window.Event.prototype.preventDefault;
    const publicPreventDefault = vi.fn(function preventDefault(this: Event) {
      nativePreventDefault.call(this);
    });
    Object.defineProperties(event, {
      composedPath: { configurable: true, value: vi.fn(() => []) },
      preventDefault: { configurable: true, value: publicPreventDefault },
    });

    act(() => source.dispatchEvent(event));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("code");
    expectSelection(host, "code");
    expect(pane(host, "code")).toHaveFocus();
    expect(event.defaultPrevented).toBe(true);
    expect(publicPreventDefault).toHaveBeenCalledOnce();
    expect(publicPreventDefault.mock.instances[0]).toBe(event);
    expect(publicFocus).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("rejects a dispatched untrusted owner-realm key before accepting a trusted successor", () => {
    const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const onChange = vi.fn<(layout: Layout) => void>();
    const { host } = renderDirect(strictSegment(onChange));
    const source = pane(host, "rich");
    source.focus();
    focus.mockClear();
    const untrusted = keyboardEvent(document, "ArrowRight", {}, false);

    act(() => source.dispatchEvent(untrusted));

    expect(untrusted.isTrusted).toBe(false);
    expect(untrusted.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectSelection(host, "rich");

    let trusted!: KeyboardEvent;
    act(() => {
      trusted = dispatchKey(source, "ArrowRight");
    });
    expect(trusted.isTrusted).toBe(true);
    expect(trusted.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("code");
    expect(focus).toHaveBeenCalledOnce();
    expectSelection(host, "code");
  });

  it("rejects a replacement React wrapper predicate before accepting the genuine pair", () => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const onChange = vi.fn<(layout: Layout) => void>();
    const { host } = renderDirect(strictSegment(onChange));
    const source = pane(host, "rich");
    const handler = captureKeyDown(source);
    source.focus();
    focus.mockClear();
    const replaced = keyboardEvent(document, "ArrowRight");

    act(() => {
      dispatchWithKeyDown(source, replaced, (event) => {
        handler(new Proxy(event, {
          get(target, property, receiver) {
            if (property === "isDefaultPrevented") return () => true;
            return Reflect.get(target, property, receiver);
          },
        }));
      });
    });

    expect(replaced.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectSelection(host, "rich");

    act(() => dispatchKey(source, "ArrowRight"));
    expect(onChange).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expectSelection(host, "code");
  });

  it.each(["wrong source", "malformed source", "reentrant bubble"] as const)(
    "preserves the rightful native pair after a %s attempt",
    (attempt) => {
      const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
      const onChange = vi.fn<(layout: Layout) => void>();
      const { host } = renderDirect(strictSegment(onChange));
      const source = pane(host, "rich");
      const wrongSource = captureKeyDown(pane(host, "code"));
      let reentered = false;
      const restore = interceptKeyDown(
        source,
        "onKeyDown",
        (original, event) => {
          if (attempt === "wrong source") {
            wrongSource(event);
          } else if (attempt === "malformed source") {
            const descriptor = Object.getOwnPropertyDescriptor(
              event,
              "currentTarget",
            );
            if (!descriptor) {
              throw new Error("The public currentTarget was not owned");
            }
            replacePublicEventValue(event, "currentTarget", pane(host, "code"));
            original(event);
            Object.defineProperty(event, "currentTarget", descriptor);
          } else {
            const publicQuery = event.isPropagationStopped;
            event.isPropagationStopped = function queryWithReentry(
              this: typeof event,
            ) {
              if (!reentered) {
                reentered = true;
                original(event);
              }
              return Reflect.apply(publicQuery, this, []);
            };
          }
          original(event);
        },
      );
      source.focus();
      focus.mockClear();
      try {
        const event = dispatchKey(source, "ArrowRight");

        expect(event.defaultPrevented).toBe(true);
        expect(onChange).toHaveBeenCalledOnce();
        expect(onChange).toHaveBeenCalledWith("code");
        expect(pane(host, "code")).toHaveFocus();
        expect(focus).toHaveBeenCalledOnce();
        if (attempt === "reentrant bubble") expect(reentered).toBe(true);
      } finally {
        restore();
      }
    },
  );

  it("rejects retained capture-method drift without poisoning a clean successor", () => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const onChange = vi.fn<(layout: Layout) => void>();
    const { host } = renderDirect(strictSegment(onChange));
    const source = pane(host, "rich");
    const restore = interceptKeyDown(
      source,
      "onKeyDownCapture",
      (original, event) => {
        original(event);
        event.preventDefault = vi.fn();
      },
    );
    source.focus();
    focus.mockClear();

    const rejected = dispatchKey(source, "ArrowRight");
    restore();

    expect(rejected.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    act(() => dispatchKey(source, "ArrowRight"));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("code");
    expect(pane(host, "code")).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("rejects a throwing public query without consuming a clean successor", () => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const onChange = vi.fn<(layout: Layout) => void>();
    const { host } = renderDirect(strictSegment(onChange));
    const source = pane(host, "rich");
    const restore = interceptKeyDown(
      source,
      "onKeyDown",
      (original, event) => {
        event.isPropagationStopped = () => {
          throw new Error("query failed");
        };
        original(event);
      },
    );
    source.focus();
    focus.mockClear();

    const rejected = dispatchKey(source, "ArrowRight");
    restore();

    expect(rejected.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    act(() => dispatchKey(source, "ArrowRight"));
    expect(onChange).toHaveBeenCalledOnce();
    expect(pane(host, "code")).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("claims movement before public prevention can reenter the route", () => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const onChange = vi.fn<(layout: Layout) => void>();
    const { host } = renderDirect(strictSegment(onChange));
    const source = pane(host, "rich");
    let reentered = false;
    const nested = { event: null as KeyboardEvent | null };
    const restore = interceptKeyDown(
      source,
      "onKeyDown",
      (original, event) => {
        const publicPreventDefault = event.preventDefault;
        event.preventDefault = function preventWithReentry(this: typeof event) {
          if (!reentered) {
            reentered = true;
            nested.event = dispatchKey(source, "ArrowRight");
          }
          return Reflect.apply(publicPreventDefault, this, []);
        };
        original(event);
      },
    );
    source.focus();
    focus.mockClear();
    try {
      const event = dispatchKey(source, "ArrowRight");

      expect(event.defaultPrevented).toBe(true);
      expect(nested.event?.defaultPrevented).toBe(false);
      expect(reentered).toBe(true);
      expect(onChange).toHaveBeenCalledOnce();
      expect(pane(host, "code")).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it("authenticates React 19's replaced post-prevention default query", () => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const onChange = vi.fn<(layout: Layout) => void>();
    const { host } = renderDirect(strictSegment(onChange));
    const source = pane(host, "rich");
    let before: ((...args: never[]) => boolean) | null = null;
    let after: ((...args: never[]) => boolean) | null = null;
    let bubbleWrapper: ReactKeyboardEvent<HTMLButtonElement> | null = null;
    const postPreventionReceivers: object[] = [];
    const restore = interceptKeyDown(
      source,
      "onKeyDown",
      (original, event) => {
        bubbleWrapper = event;
        const publicPreventDefault = event.preventDefault;
        before = event.isDefaultPrevented;
        event.preventDefault = function replaceDefaultQuery(this: typeof event) {
          Reflect.apply(publicPreventDefault, this, []);
          const replaced = this.isDefaultPrevented;
          this.isDefaultPrevented = function postPreventionQuery(
            this: typeof event,
          ) {
            postPreventionReceivers.push(this);
            return Reflect.apply(replaced, this, []);
          };
          after = this.isDefaultPrevented;
        };
        original(event);
      },
    );
    source.focus();
    focus.mockClear();
    try {
      const event = dispatchKey(source, "ArrowRight");

      expect(event.defaultPrevented).toBe(true);
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      expect(after).not.toBe(before);
      expect(postPreventionReceivers.length).toBeGreaterThan(0);
      expect(postPreventionReceivers.every(
        (receiver) => receiver === bubbleWrapper,
      )).toBe(true);
      expect(onChange).toHaveBeenCalledOnce();
      expect(pane(host, "code")).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it.each([
    ["prevented", { prevented: true }],
    ["stopped", { stopped: true }],
    ["Alt-modified", { altKey: true }],
    ["Control-modified", { ctrlKey: true }],
    ["Meta-modified", { metaKey: true }],
    ["Shift-modified", { shiftKey: true }],
    ["repeating", { repeat: true }],
    ["composing", { isComposing: true }],
    ["non-bubbling", { bubbles: false }],
    ["non-cancelable", { cancelable: false }],
  ] as const)(
    "rejects a %s key with zero work and remains usable",
    (_name, setup) => {
      const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
      const onChange = vi.fn<(layout: Layout) => void>();
      const { host } = renderDirect(strictSegment(onChange));
      const source = pane(host, "rich");
      source.focus();
      focus.mockClear();
      const { prevented, stopped, ...init } = setup as KeyboardEventInit & {
        prevented?: boolean;
        stopped?: boolean;
      };
      const event = keyboardEvent(document, "ArrowRight", init);
      if (prevented) event.preventDefault();
      if (stopped) event.stopPropagation();

      act(() => source.dispatchEvent(event));

      expect(onChange).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expectSelection(host, "rich");
      if (!prevented) expect(event.defaultPrevented).toBe(false);

      act(() => dispatchKey(source, "ArrowRight"));
      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledWith("code");
      expect(focus).toHaveBeenCalledOnce();
      expectSelection(host, "code");
    },
  );

  it("rejects unfocused, forged, wrong-native, and foreign-realm events before a genuine pair", () => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const onChange = vi.fn<(layout: Layout) => void>();
    const { host } = renderDirect(strictSegment(onChange));
    const source = pane(host, "rich");
    const handler = captureKeyDown(source);
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const foreign = keyboardEvent(iframe.contentDocument!, "ArrowRight");
    const nativeEvent = keyboardEvent(document, "ArrowRight");
    const forged = {
      type: "keydown",
      currentTarget: source,
      target: source,
      nativeEvent,
    } as unknown as ReactKeyboardEvent<HTMLButtonElement>;

    act(() => {
      source.dispatchEvent(keyboardEvent(document, "ArrowRight"));
      handler(forged);
      source.dispatchEvent(new Event("keydown", {
        bubbles: true,
        cancelable: true,
      }));
      source.dispatchEvent(foreign);
    });

    expect(nativeEvent.defaultPrevented).toBe(false);
    expect(foreign.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectSelection(host, "rich");

    source.focus();
    focus.mockClear();
    act(() => dispatchKey(source, "ArrowRight"));
    expect(onChange).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expectSelection(host, "code");
    iframe.remove();
  });

  it("claims the immutable publication, action, React event, and native event once before reentry", () => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const onChange = vi.fn<(layout: Layout) => void>();
    const reentry: {
      handler?: LayoutKeyDown;
      event?: ReactKeyboardEvent<HTMLButtonElement>;
    } = {};
    function ReentryHarness() {
      const [layout, setLayout] = useState<Layout>("rich");
      return (
        <div onKeyDownCapture={(event) => {
          reentry.event = event as unknown as ReactKeyboardEvent<HTMLButtonElement>;
        }}>
          <LayoutSegment
            layout={layout}
            onLayout={(next) => {
              onChange(next);
              if (reentry.handler && reentry.event) {
                reentry.handler(reentry.event);
              }
              setLayout(next);
            }}
          />
        </div>
      );
    }
    const { host } = renderDirect(
      <StrictMode>
        <ReentryHarness />
      </StrictMode>,
    );
    const source = pane(host, "rich");
    reentry.handler = captureKeyDown(source);
    source.focus();
    focus.mockClear();
    const event = keyboardEvent(document, "ArrowRight");

    act(() => source.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expectSelection(host, "code");
  });

  it("rejects unchecked and crossed-radio handlers without poisoning the checked source", () => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const firstChange = vi.fn<(layout: Layout) => void>();
    const secondChange = vi.fn<(layout: Layout) => void>();
    const crossed = { handler: undefined as LayoutKeyDown | undefined };
    let intercept = false;
    const { host } = renderDirect(
      <StrictMode>
        <div onKeyDownCapture={(event) => {
          if (!intercept || !crossed.handler) return;
          crossed.handler(event as unknown as ReactKeyboardEvent<HTMLButtonElement>);
          event.stopPropagation();
        }}>
          <ControlledSegment onChange={firstChange} />
          <ControlledSegment onChange={secondChange} />
        </div>
      </StrictMode>,
    );
    const roots = [...host.querySelectorAll<HTMLDivElement>('[data-testid="layout-segment"]')];
    const firstPreview = pane(roots[0], "rich");
    const firstMarkdown = pane(roots[0], "code");
    const secondPreview = pane(roots[1], "rich");
    crossed.handler = captureKeyDown(firstPreview);

    firstMarkdown.focus();
    focus.mockClear();
    act(() => dispatchKey(firstMarkdown, "ArrowRight"));
    expect(firstChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    intercept = true;
    secondPreview.focus();
    focus.mockClear();
    act(() => dispatchKey(secondPreview, "ArrowRight"));
    intercept = false;
    expect(firstChange).not.toHaveBeenCalled();
    expect(secondChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    firstPreview.focus();
    focus.mockClear();
    act(() => dispatchKey(firstPreview, "ArrowRight"));
    expect(firstChange).toHaveBeenCalledOnce();
    expect(secondChange).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
    expectSelection(roots[0], "code");
    expectSelection(roots[1], "rich");
  });

  it("retires stale callback and layout handlers while the current publication stays usable", () => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const staleChange = vi.fn<(layout: Layout) => void>();
    const currentChange = vi.fn<(layout: Layout) => void>();
    const stale = { handler: undefined as LayoutKeyDown | undefined };
    let intercept = false;

    function Harness({ onChange }: { onChange: (layout: Layout) => void }) {
      return (
        <div onKeyDownCapture={(event) => {
          if (!intercept || !stale.handler) return;
          stale.handler(event as unknown as ReactKeyboardEvent<HTMLButtonElement>);
          event.stopPropagation();
        }}>
          <ControlledSegment onChange={onChange} />
        </div>
      );
    }

    const view = renderDirect(
      <StrictMode>
        <Harness onChange={staleChange} />
      </StrictMode>,
    );
    stale.handler = captureKeyDown(pane(view.host, "rich"));
    act(() => view.root.render(
      <StrictMode>
        <Harness onChange={currentChange} />
      </StrictMode>,
    ));
    act(() => pane(view.host, "code").dispatchEvent(primaryClick(document)));
    currentChange.mockClear();
    const source = pane(view.host, "code");
    source.focus();
    focus.mockClear();

    intercept = true;
    const rejected = dispatchKey(source, "ArrowLeft");
    intercept = false;
    expect(rejected.defaultPrevented).toBe(false);
    expect(staleChange).not.toHaveBeenCalled();
    expect(currentChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectSelection(view.host, "code");

    act(() => dispatchKey(source, "ArrowLeft"));
    expect(staleChange).not.toHaveBeenCalled();
    expect(currentChange).toHaveBeenCalledOnce();
    expect(currentChange).toHaveBeenCalledWith("rich");
    expect(focus).toHaveBeenCalledOnce();
    expectSelection(view.host, "rich");
  });

  it.each([
    "detached and reinserted",
    "reordered and restored",
    "replaced and restored",
    "attribute changed and restored",
  ] as const)(
    "rejects a %s control history and recovers only with a distinct clean successor",
    (mutation) => {
      const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
      const staleChange = vi.fn<(layout: Layout) => void>();
      const currentChange = vi.fn<(layout: Layout) => void>();
      const controls = (
        visit: string,
        onChange: (layout: Layout) => void,
      ) => (
        <StrictMode>
          <section key={visit}>
            <ControlledSegment onChange={onChange} />
          </section>
        </StrictMode>
      );
      const view = renderDirect(controls("a", staleChange));
      const root = segment(view.host);
      const preview = pane(root, "rich");
      const markdown = pane(root, "code");
      if (mutation === "detached and reinserted") {
        const parent = root.parentNode!;
        const nextSibling = root.nextSibling;
        root.remove();
        parent.insertBefore(root, nextSibling);
      } else if (mutation === "reordered and restored") {
        root.insertBefore(markdown, preview);
        root.append(markdown);
      } else if (mutation === "replaced and restored") {
        const replacement = preview.cloneNode(true) as HTMLButtonElement;
        preview.replaceWith(replacement);
        replacement.replaceWith(preview);
      } else {
        preview.setAttribute("aria-checked", "false");
        preview.setAttribute("aria-checked", "true");
      }
      preview.focus();
      focus.mockClear();

      const rejected = dispatchKey(preview, "ArrowRight");

      expect(rejected.defaultPrevented).toBe(false);
      expect(staleChange).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expectSelection(root, "rich");

      act(() => view.root.render(controls("b", currentChange)));
      const currentPreview = pane(view.host, "rich");
      currentPreview.focus();
      focus.mockClear();
      act(() => dispatchKey(currentPreview, "ArrowRight"));
      expect(staleChange).not.toHaveBeenCalled();
      expect(currentChange).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
      expectSelection(view.host, "code");
    },
  );

  it("retires replacement callback refs and an incomplete control before a clean successor", () => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const staleChange = vi.fn<(layout: Layout) => void>();
    const currentChange = vi.fn<(layout: Layout) => void>();
    const controls = (
      visit: string,
      onChange: (layout: Layout) => void,
    ) => (
      <StrictMode>
        <section key={visit}>
          <ControlledSegment onChange={onChange} />
        </section>
      </StrictMode>
    );
    const view = renderDirect(controls("a", staleChange));
    const root = segment(view.host);
    const preview = pane(root, "rich");
    const markdown = pane(root, "code");
    const previewRef = captureRef(preview);
    const replacement = preview.cloneNode(true) as HTMLButtonElement;
    document.body.append(replacement);
    act(() => previewRef(replacement));
    markdown.remove();
    preview.focus();
    focus.mockClear();

    const rejected = dispatchKey(preview, "ArrowRight");

    expect(rejected.defaultPrevented).toBe(false);
    expect(staleChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    replacement.remove();
    act(() => view.root.render(controls("b", currentChange)));
    const currentPreview = pane(view.host, "rich");
    currentPreview.focus();
    focus.mockClear();
    act(() => dispatchKey(currentPreview, "ArrowRight"));
    expect(currentChange).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expectSelection(view.host, "code");
  });

  it("retires a partial Strict Mode publication before its complete replay", () => {
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const onChange = vi.fn<(layout: Layout) => void>();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const view = { host, root };
    views.add(view);
    let retiredHandler: LayoutKeyDown | undefined;
    let intercept = false;

    function LayoutProbe({ children }: { children: ReactNode }) {
      useLayoutEffect(() => {
        retiredHandler ??= captureKeyDown(pane(host, "rich"));
      }, []);
      return children;
    }

    act(() => root.render(
      <StrictMode>
        <div onKeyDownCapture={(event) => {
          if (!intercept || !retiredHandler) return;
          retiredHandler(event as unknown as ReactKeyboardEvent<HTMLButtonElement>);
          event.stopPropagation();
        }}>
          <LayoutProbe>
            <ControlledSegment onChange={onChange} />
          </LayoutProbe>
        </div>
      </StrictMode>,
    ));
    const source = pane(host, "rich");
    expect(retiredHandler).toBeDefined();
    expect(captureKeyDown(source)).not.toBe(retiredHandler);
    source.focus();
    focus.mockClear();

    intercept = true;
    const staleEvent = dispatchKey(source, "ArrowRight");
    intercept = false;
    expect(staleEvent.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectSelection(host, "rich");

    act(() => dispatchKey(source, "ArrowRight"));
    expect(onChange).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expectSelection(host, "code");
  });

  it("revokes listener and weak-pair access while retained wrappers stay inert after cleanup", async () => {
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const staleChange = vi.fn<(layout: Layout) => void>();
    const view = renderDirect(strictSegment(staleChange));
    const source = pane(view.host, "rich");
    const staleCapture = captureKeyDownCapture(source);
    const staleBubble = captureKeyDown(source);
    let captureWrapper: ReactKeyboardEvent<HTMLButtonElement> | null = null;
    let bubbleWrapper: ReactKeyboardEvent<HTMLButtonElement> | null = null;
    const restoreCapture = interceptKeyDown(
      source,
      "onKeyDownCapture",
      (original, event) => {
        captureWrapper = event;
        original(event);
      },
    );
    const restoreBubble = interceptKeyDown(
      source,
      "onKeyDown",
      (_original, event) => {
        bubbleWrapper = event;
      },
    );
    source.focus();
    focus.mockClear();
    const inert = dispatchKey(source, "ArrowRight");
    restoreBubble();
    restoreCapture();
    expect(inert.defaultPrevented).toBe(false);
    if (!captureWrapper || !bubbleWrapper) {
      throw new Error("The public capture and bubble wrappers were not observed");
    }
    const releasesBeforeCleanup = removeEventListener.mock.calls.filter(
      ([type, , options]) => type === "keydown" && options === true,
    ).length;

    await act(async () => view.root.unmount());
    views.delete(view);

    expect(removeEventListener.mock.calls.filter(
      ([type, , options]) => type === "keydown" && options === true,
    )).toHaveLength(releasesBeforeCleanup + 1);
    const weakAccesses = [
      vi.spyOn(WeakMap.prototype, "get"),
      vi.spyOn(WeakMap.prototype, "set"),
      vi.spyOn(WeakMap.prototype, "has"),
      vi.spyOn(WeakMap.prototype, "delete"),
      vi.spyOn(WeakSet.prototype, "add"),
      vi.spyOn(WeakSet.prototype, "has"),
      vi.spyOn(WeakSet.prototype, "delete"),
    ];
    const accessCount = () => weakAccesses.reduce(
      (count, method) => count + method.mock.calls.length,
      0,
    );
    const beforeRetainedCallbacks = accessCount();
    staleCapture(captureWrapper);
    staleBubble(bubbleWrapper);
    expect(accessCount()).toBe(beforeRetainedCallbacks);
    expect(staleChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    const currentChange = vi.fn<(layout: Layout) => void>();
    const successor = renderDirect(strictSegment(currentChange));
    const currentSource = pane(successor.host, "rich");
    currentSource.focus();
    focus.mockClear();
    act(() => dispatchKey(currentSource, "ArrowRight"));
    expect(currentChange).toHaveBeenCalledOnce();
    expect(pane(successor.host, "code")).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("disconnects mutation history and leaves retained handlers inert after cleanup", async () => {
    const NativeMutationObserver = window.MutationObserver;
    const observers = new Set<MutationObserver>();
    class TrackingMutationObserver extends NativeMutationObserver {
      constructor(callback: MutationCallback) {
        super(callback);
        observers.add(this);
      }

      override disconnect() {
        observers.delete(this);
        super.disconnect();
      }
    }
    Object.defineProperty(window, "MutationObserver", {
      configurable: true,
      value: TrackingMutationObserver,
    });
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const staleChange = vi.fn<(layout: Layout) => void>();
    const view = renderDirect(strictSegment(staleChange));
    const preview = pane(view.host, "rich");
    const staleHandler = captureKeyDown(preview);
    const staleRef = captureRef(preview);
    expect(observers.size).toBeGreaterThan(0);

    await act(async () => view.root.unmount());
    views.delete(view);
    await act(async () => {});
    focus.mockClear();
    const nativeEvent = keyboardEvent(document, "ArrowRight");
    const retainedEvent = {
      type: "keydown",
      currentTarget: preview,
      target: preview,
      nativeEvent,
    } as unknown as ReactKeyboardEvent<HTMLButtonElement>;
    act(() => {
      staleHandler(retainedEvent);
      staleRef(preview);
      staleRef(null);
    });

    expect(observers).toHaveLength(0);
    expect(nativeEvent.defaultPrevented).toBe(false);
    expect(staleChange).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    const currentChange = vi.fn<(layout: Layout) => void>();
    const successor = renderDirect(strictSegment(currentChange));
    const currentPreview = pane(successor.host, "rich");
    currentPreview.focus();
    focus.mockClear();
    act(() => dispatchKey(currentPreview, "ArrowRight"));
    expect(currentChange).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expectSelection(successor.host, "code");
  });
});
