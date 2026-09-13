// @vitest-environment jsdom
import {
  StrictMode,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadMenu } from "./download-menu";

const DOC_ID = "doc-919";
const NEXT_DOC_ID = "doc-920";
const FORMATS = ["md", "html", "pdf"] as const;
type Format = (typeof FORMATS)[number];

const downloadHref = (docId: string, format: Format) =>
  `/api/documents/${docId}/export?format=${format}&download=1`;

function BoundaryHarness({
  docId,
  present = true,
  instance = "menu",
  boundary = 0,
  onBoundary,
}: {
  docId: string;
  present?: boolean;
  instance?: string;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <DownloadMenu key={instance} docId={docId} /> : null;
}

function reactHandler<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return handler as T;
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

type ClickEvent<E extends HTMLElement> = {
  type: "click";
  currentTarget: E;
  target: EventTarget;
  nativeEvent: MouseEvent;
};
type ToggleClick = (event: ClickEvent<HTMLButtonElement>) => void;
type LinkClick = (event: ClickEvent<HTMLAnchorElement>) => void;
type ToggleKey = (event: {
  type: "keydown";
  currentTarget: HTMLButtonElement;
  target: EventTarget;
  nativeEvent: KeyboardEvent;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  preventDefault: () => void;
}) => void;
type ListKey = (event: {
  type: "keydown";
  currentTarget: HTMLDivElement;
  target: EventTarget;
  nativeEvent: KeyboardEvent;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  preventDefault: () => void;
}) => void;
type RootKey = (event: {
  type: "keydown";
  currentTarget: HTMLDivElement;
  target: EventTarget;
  nativeEvent: KeyboardEvent;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  preventDefault: () => void;
}) => void;
type DeliveredKey = {
  type: "keydown";
  currentTarget: HTMLElement;
  target: EventTarget;
  nativeEvent: KeyboardEvent;
  eventPhase: number;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  isTrusted: boolean;
  key: string;
  code: string;
  location: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  view: Window | null;
  isDefaultPrevented: () => boolean;
  isPropagationStopped: () => boolean;
};
type RootBlur = (event: {
  type: "blur";
  currentTarget: HTMLDivElement;
  target: EventTarget;
  nativeEvent: FocusEvent;
  relatedTarget: EventTarget | null;
}) => void;

function clickEvent<E extends HTMLElement>(
  currentTarget: E,
  target: EventTarget = currentTarget,
  nativeTarget: EventTarget = target,
): ClickEvent<E> {
  const MouseEventConstructor = currentTarget.ownerDocument.defaultView?.MouseEvent;
  if (!MouseEventConstructor) throw new Error("The control has no owner-document MouseEvent");
  const nativeEvent = new MouseEventConstructor("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  Object.defineProperty(nativeEvent, "target", {
    configurable: true,
    value: nativeTarget,
  });
  return { type: "click", currentTarget, target, nativeEvent };
}

function keyEvent<E extends HTMLElement>(
  currentTarget: E,
  target: EventTarget,
  key: string,
) {
  const KeyboardEventConstructor =
    currentTarget.ownerDocument.defaultView?.KeyboardEvent;
  if (!KeyboardEventConstructor) {
    throw new Error("The control has no owner-document KeyboardEvent");
  }
  const nativeEvent = new KeyboardEventConstructor("keydown", {
    bubbles: true,
    cancelable: true,
    key,
  });
  Object.defineProperty(nativeEvent, "target", {
    configurable: true,
    value: target,
  });
  return {
    type: "keydown" as const,
    currentTarget,
    target,
    nativeEvent,
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
  };
}

function markJsdomEventTrusted(event: Event) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map(
      (symbol) =>
        (event as unknown as Record<symbol, unknown>)[symbol],
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

function toggleKeyEvent(
  element: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
): KeyboardEvent {
  const KeyboardEventConstructor =
    element.ownerDocument.defaultView?.KeyboardEvent;
  if (!KeyboardEventConstructor) {
    throw new Error("The element has no owner-realm KeyboardEvent");
  }
  const event = new KeyboardEventConstructor("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (trusted) markJsdomEventTrusted(event);
  return event;
}

function dispatchToggleKey(
  element: HTMLElement,
  keyOrEvent: string | KeyboardEvent,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event =
    typeof keyOrEvent === "string"
      ? toggleKeyEvent(element, keyOrEvent, init)
      : keyOrEvent;
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function dispatchToggleKeyWithHandler(
  element: HTMLButtonElement,
  event: KeyboardEvent,
  onKeyDown: (event: Parameters<ToggleKey>[0]) => void,
) {
  const propsKey = Object.keys(element).find((key) =>
    key.startsWith("__reactProps$"),
  );
  if (!propsKey) {
    throw new Error("React props were not attached to the toggle");
  }

  const properties = element as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const props = properties[propsKey];
  const replacement = { ...props, onKeyDown };
  properties[propsKey] = replacement;
  try {
    act(() => {
      element.dispatchEvent(event);
    });
  } finally {
    if (properties[propsKey] === replacement) {
      properties[propsKey] = props;
    }
  }
}

function distinctReactKey(
  event: DeliveredKey,
  prototype: object,
): DeliveredKey {
  const wrapper = Object.create(prototype) as DeliveredKey;
  for (const property of [
    "type",
    "currentTarget",
    "target",
    "nativeEvent",
    "eventPhase",
    "bubbles",
    "cancelable",
    "defaultPrevented",
    "isTrusted",
    "key",
    "code",
    "location",
    "altKey",
    "ctrlKey",
    "metaKey",
    "shiftKey",
    "repeat",
    "view",
  ] as const) {
    Object.defineProperty(wrapper, property, {
      configurable: true,
      get: () => event[property],
    });
  }
  return wrapper;
}

function blurEvent(
  currentTarget: HTMLDivElement,
  target: EventTarget,
  relatedTarget: EventTarget | null,
  nativeTarget: EventTarget = target,
) {
  const FocusEventConstructor =
    currentTarget.ownerDocument.defaultView?.FocusEvent;
  if (!FocusEventConstructor) {
    throw new Error("The root has no owner-document FocusEvent");
  }
  const nativeEvent = new FocusEventConstructor("focusout", {
    bubbles: true,
    relatedTarget,
  });
  Object.defineProperty(nativeEvent, "target", {
    configurable: true,
    value: nativeTarget,
  });
  return {
    type: "blur" as const,
    currentTarget,
    target,
    nativeEvent,
    relatedTarget,
  };
}

function menuElements() {
  const primary = screen.getByTestId("reader-download") as HTMLAnchorElement;
  const toggle = screen.getByTestId("reader-download-menu") as HTMLButtonElement;
  const list = screen.getByTestId("reader-download-list") as HTMLDivElement;
  const links = Object.fromEntries(
    FORMATS.map((format) => [
      format,
      screen.getByTestId(`reader-download-${format}`) as HTMLAnchorElement,
    ]),
  ) as Record<Format, HTMLAnchorElement>;
  const root = primary.parentElement;
  if (!(root instanceof HTMLDivElement)) throw new Error("Download root was not rendered");
  return { root, primary, toggle, list, links };
}

function trackPointerListeners() {
  const active = new Set<EventListener>();
  const captured: EventListener[] = [];
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "pointerdown" && typeof listener === "function") {
      active.add(listener);
      captured.push(listener);
    }
    add(type, listener, options);
  });
  vi.spyOn(document, "removeEventListener").mockImplementation((type, listener, options) => {
    if (type === "pointerdown" && typeof listener === "function") active.delete(listener);
    remove(type, listener, options);
  });
  return { active, captured };
}

function pointerEvent(target: EventTarget) {
  const ownerDocument =
    target instanceof Node ? target.ownerDocument ?? document : document;
  const PointerEventConstructor = ownerDocument.defaultView?.PointerEvent;
  if (!PointerEventConstructor) {
    throw new Error("The pointer target has no owner-document PointerEvent");
  }
  const event = new PointerEventConstructor("pointerdown", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "target", {
    configurable: true,
    value: target,
  });
  return event;
}

function invokePointer(
  listener: EventListener | undefined,
  target: EventTarget,
  event = pointerEvent(target),
) {
  if (!listener) throw new Error("Pointer listener was not installed");
  listener(event);
  return event;
}

function connectedElement<K extends keyof HTMLElementTagNameMap>(tag: K) {
  const element = document.createElement(tag);
  document.body.append(element);
  return element;
}

const directRoots = new Set<Root>();

function LayoutCapture({
  capture,
  children,
}: {
  capture: () => void;
  children: ReactNode;
}) {
  useLayoutEffect(capture, [capture]);
  return children;
}

afterEach(() => {
  for (const root of directRoots) act(() => root.unmount());
  directRoots.clear();
  cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("DownloadMenu presentation", () => {
  it("preserves the split button, exact routes, labels, and closed disclosure relationships", () => {
    render(<DownloadMenu docId={DOC_ID} />);
    const { primary, toggle, list, links } = menuElements();

    expect(primary).toHaveAttribute("href", downloadHref(DOC_ID, "md"));
    expect(primary).toHaveClass("btn", "btn-sm", "btn-outline", "reader-split-main", "gap-1.5");
    expect(primary).toHaveAccessibleName("Download Markdown");
    expect(within(primary).getByText("Download")).toHaveClass("hidden", "sm:inline");
    expect(screen.queryByRole("button", { name: "Download Markdown" })).not.toBeInTheDocument();
    expect(toggle).toHaveClass("btn", "btn-sm", "btn-outline", "reader-split-more");
    expect(toggle).toHaveAccessibleName("Download as…");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "reader-download-list");
    expect(toggle).not.toHaveAttribute("aria-haspopup");
    expect(list).toHaveAttribute("id", "reader-download-list");
    expect(list).not.toBeVisible();
    expect(list).toHaveClass("menu", "animate-fade-in", "absolute", "right-0", "top-full", "mt-1.5", "w-48");
    expect(Object.values(links)).toHaveLength(3);
    for (const format of FORMATS) {
      expect(links[format]).toHaveAttribute("href", downloadHref(DOC_ID, format));
    }

    for (const event of [
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    ]) {
      let preventedBeforeBrowserDefault = true;
      document.addEventListener(
        event.type,
        (observed) => {
          preventedBeforeBrowserDefault = observed.defaultPrevented;
          observed.preventDefault();
        },
        { once: true },
      );
      fireEvent(primary, event);
      expect(preventedBeforeBrowserDefault).toBe(false);
    }
  });

  it("opens by click, focuses the exact first link once, and toggle-closes without refocusing", () => {
    const pointers = trackPointerListeners();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    let { toggle, list, links } = menuElements();

    fireEvent.click(toggle);
    ({ toggle, list, links } = menuElements());
    expect(list).toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(links.md).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith();
    expect(pointers.active.size).toBe(1);

    focus.mockClear();
    fireEvent.click(toggle);
    expect(list).not.toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(focus).not.toHaveBeenCalled();
    expect(pointers.active.size).toBe(0);
  });

  it("opens by ArrowDown and gives Tab and unsupported toggle keys native behavior", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    const { toggle, list, links } = menuElements();

    const enter = fireEvent.keyDown(toggle, { key: "Enter" });
    const tab = fireEvent.keyDown(toggle, { key: "Tab" });
    expect(enter).toBe(true);
    expect(tab).toBe(true);
    expect(list).not.toBeVisible();

    toggle.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const arrow = dispatchToggleKey(toggle, "ArrowDown");
    expect(arrow.defaultPrevented).toBe(true);
    expect(list).toBeVisible();
    expect(links.md).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });
  });

  it("moves through the exact ordered links with wrapping and leaves modifier and unsupported keys native", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    fireEvent.click(menuElements().toggle);
    const { links } = menuElements();
    focus.mockClear();

    expect(dispatchToggleKey(links.md, "ArrowDown").defaultPrevented).toBe(
      true,
    );
    expect(links.html).toHaveFocus();
    expect(dispatchToggleKey(links.html, "End").defaultPrevented).toBe(true);
    expect(links.pdf).toHaveFocus();
    expect(dispatchToggleKey(links.pdf, "ArrowDown").defaultPrevented).toBe(
      true,
    );
    expect(links.md).toHaveFocus();
    expect(dispatchToggleKey(links.md, "ArrowUp").defaultPrevented).toBe(
      true,
    );
    expect(links.pdf).toHaveFocus();
    expect(dispatchToggleKey(links.pdf, "Home").defaultPrevented).toBe(true);
    expect(links.md).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(5);
    for (const call of focus.mock.calls) {
      expect(call).toEqual([{ preventScroll: true }]);
    }

    focus.mockClear();
    expect(fireEvent.keyDown(links.md, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(links.md, { key: "PageDown" })).toBe(true);
    expect(fireEvent.keyDown(links.md, { key: "ArrowDown", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(links.md, { key: "Home", shiftKey: true })).toBe(true);
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(FORMATS)("lets the exact %s link keep native activation, close once, and refocus the exact toggle once", (format) => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    fireEvent.click(menuElements().toggle);
    const { toggle, list, links } = menuElements();
    focus.mockClear();
    let preventedBeforeBrowserDefault = true;
    document.addEventListener(
      "click",
      (event) => {
        preventedBeforeBrowserDefault = event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );

    fireEvent.click(links[format]);

    expect(preventedBeforeBrowserDefault).toBe(false);
    expect(list).not.toBeVisible();
    expect(toggle).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith();
  });

  it("handles exact Escape, outside blur, and outside pointer while retaining inside and null-focus behavior", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    const outside = connectedElement("button");
    fireEvent.click(menuElements().toggle);
    let { root, toggle, list, links } = menuElements();
    focus.mockClear();

    fireEvent.blur(links.md, { relatedTarget: null });
    expect(list).toBeVisible();
    fireEvent.blur(links.md, { relatedTarget: links.html });
    expect(list).toBeVisible();
    fireEvent.pointerDown(links.html);
    expect(list).toBeVisible();
    expect(focus).not.toHaveBeenCalled();

    fireEvent.blur(links.md, { relatedTarget: outside });
    expect(list).not.toBeVisible();
    expect(focus).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    ({ root, toggle, list, links } = menuElements());
    focus.mockClear();
    fireEvent.pointerDown(outside);
    expect(list).not.toBeVisible();
    expect(focus).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    ({ root, toggle, list, links } = menuElements());
    links.pdf.focus();
    focus.mockClear();
    expect(dispatchToggleKey(links.pdf, "Escape").defaultPrevented).toBe(
      true,
    );
    expect(list).not.toBeVisible();
    expect(toggle).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });
    expect(root).toContainElement(toggle);
  });
});

describe("DownloadMenu trusted toggle directions", () => {
  it.each([
    ["closed", "ArrowDown", "md"],
    ["closed", "ArrowUp", "pdf"],
    ["open", "ArrowDown", "md"],
    ["open", "ArrowUp", "pdf"],
  ] as const)(
    "moves from a %s disclosure with %s to the exact %s link once",
    (state, key, format) => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      directRoots.add(root);
      act(() => {
        root.render(
          <StrictMode>
            <DownloadMenu docId={DOC_ID} />
          </StrictMode>,
        );
      });
      let { toggle, list, links } = menuElements();
      expect(FORMATS.map((item) => links[item].textContent?.trim())).toEqual([
        "Markdown",
        "HTML",
        "PDF",
      ]);
      if (state === "open") {
        fireEvent.click(toggle);
        ({ toggle, list, links } = menuElements());
        expect(list).toBeVisible();
        expect(links.md).toHaveFocus();
      }
      const originalList = list;
      const activations = Object.fromEntries(
        FORMATS.map((item) => {
          const listener = vi.fn();
          links[item].addEventListener("click", listener);
          return [item, listener];
        }),
      ) as Record<Format, ReturnType<typeof vi.fn>>;
      toggle.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const scroll = { x: window.scrollX, y: window.scrollY };

      const event = dispatchToggleKey(toggle, key);

      ({ toggle, list, links } = menuElements());
      expect(event.isTrusted).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(list).toBe(originalList);
      expect(list).toBeVisible();
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(links[format]).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
      expect(focus.mock.contexts[0]).toBe(links[format]);
      expect(Object.values(activations).every((listener) => listener.mock.calls.length === 0)).toBe(true);
      expect(window.scrollX).toBe(scroll.x);
      expect(window.scrollY).toBe(scroll.y);
    },
  );

  it("moves every list direction and Escape once without scrolling or activating a download", () => {
    const preventDefault = vi.spyOn(
      Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const fetch = vi.spyOn(globalThis, "fetch");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    directRoots.add(root);
    act(() => {
      root.render(
        <StrictMode>
          <DownloadMenu docId={DOC_ID} />
        </StrictMode>,
      );
    });
    fireEvent.click(menuElements().toggle);
    const menu = menuElements();
    const activations = Object.fromEntries(
      FORMATS.map((format) => {
        const listener = vi.fn();
        menu.links[format].addEventListener("click", listener);
        return [format, listener];
      }),
    ) as Record<Format, ReturnType<typeof vi.fn>>;
    const positions = [
      [menu.links.md, "Home", menu.links.md],
      [menu.links.md, "ArrowUp", menu.links.pdf],
      [menu.links.pdf, "End", menu.links.pdf],
      [menu.links.pdf, "ArrowDown", menu.links.md],
      [menu.links.md, "ArrowDown", menu.links.html],
      [menu.links.html, "End", menu.links.pdf],
      [menu.links.pdf, "Home", menu.links.md],
    ] as const;
    focus.mockClear();
    preventDefault.mockClear();

    for (const [source, key, destination] of positions) {
      document.documentElement.scrollTop = 11;
      host.scrollTop = 12;
      menu.root.scrollTop = 13;
      menu.list.scrollTop = 14;
      const event = dispatchToggleKey(source, key);
      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(document.documentElement.scrollTop).toBe(11);
      expect(host.scrollTop).toBe(12);
      expect(menu.root.scrollTop).toBe(13);
      expect(menu.list.scrollTop).toBe(14);
    }

    const escape = dispatchToggleKey(menu.links.md, "Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(menu.toggle).toHaveFocus();
    expect(menu.list).not.toBeVisible();
    expect(preventDefault).toHaveBeenCalledTimes(positions.length + 1);
    expect(focus).toHaveBeenCalledTimes(positions.length + 1);
    for (const call of focus.mock.calls) {
      expect(call).toEqual([{ preventScroll: true }]);
    }
    expect(
      Object.values(activations).every(
        (listener) => listener.mock.calls.length === 0,
      ),
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts distinct capture and bubble wrappers but rejects retained cancellation-method drift", () => {
    const preventDefault = vi.spyOn(
      Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(
      <StrictMode>
        <DownloadMenu docId={DOC_ID} />
      </StrictMode>,
    );
    const { toggle, list, links } = menuElements();
    const capture = reactHandler<(event: DeliveredKey) => void>(
      toggle,
      "onKeyDownCapture",
    );
    const bubble = reactHandler<(event: DeliveredKey) => void>(
      toggle,
      "onKeyDown",
    );
    const propsKey = Object.keys(toggle).find((key) =>
      key.startsWith("__reactProps$"),
    );
    if (!propsKey) throw new Error("React props were not attached");
    const properties = toggle as unknown as Record<
      string,
      Record<string, unknown>
    >;
    const props = properties[propsKey];
    const captureDefault = () => false;
    const captureStopped = () => false;
    const bubbleDefault = () => false;
    const bubbleStopped = () => false;
    const capturePrototype = Object.create(null) as object;
    const bubblePrototype = Object.create(null) as object;
    Object.defineProperties(capturePrototype, {
      isDefaultPrevented: {
        configurable: true,
        value: captureDefault,
      },
      isPropagationStopped: {
        configurable: true,
        value: captureStopped,
      },
    });
    Object.defineProperties(bubblePrototype, {
      isDefaultPrevented: {
        configurable: true,
        value: bubbleDefault,
      },
      isPropagationStopped: {
        configurable: true,
        value: bubbleStopped,
      },
    });
    let driftCapture = true;
    const replacement = {
      ...props,
      onKeyDownCapture: (event: DeliveredKey) => {
        capture(distinctReactKey(event, capturePrototype));
      },
      onKeyDown: (event: DeliveredKey) => {
        if (driftCapture) {
          Object.defineProperty(
            capturePrototype,
            "isDefaultPrevented",
            {
              configurable: true,
              value: () => false,
            },
          );
        }
        bubble(distinctReactKey(event, bubblePrototype));
      },
    };
    properties[propsKey] = replacement;
    toggle.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const rejected = dispatchToggleKey(toggle, "ArrowDown");
    expect(rejected.defaultPrevented).toBe(false);
    expect(list).not.toBeVisible();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();

    Object.defineProperty(capturePrototype, "isDefaultPrevented", {
      configurable: true,
      value: captureDefault,
    });
    driftCapture = false;
    const accepted = dispatchToggleKey(toggle, "ArrowUp");
    expect(accepted.defaultPrevented).toBe(true);
    expect(list).toBeVisible();
    expect(links.pdf).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });
    expect(Object.getPrototypeOf(capturePrototype)).toBeNull();
    expect(Object.getPrototypeOf(bubblePrototype)).toBeNull();
    expect(captureDefault).not.toBe(bubbleDefault);
    expect(captureStopped).not.toBe(bubbleStopped);
  });

  it("permanently rejects restored Window listener drift and publishes a clean successor", () => {
    const preventDefault = vi.spyOn(
      Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(
      <StrictMode>
        <DownloadMenu docId={DOC_ID} />
      </StrictMode>,
    );
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "addEventListener",
    );
    const original = window.addEventListener;
    const toggle = menuElements().toggle;
    toggle.focus();
    focus.mockClear();
    preventDefault.mockClear();
    Object.defineProperty(window, "addEventListener", {
      configurable: true,
      enumerable: originalDescriptor?.enumerable ?? true,
      writable: true,
      value: function (
        this: Window,
        ...args: Parameters<Window["addEventListener"]>
      ) {
        return Reflect.apply(original, this, args);
      },
    });
    const rejected = toggleKeyEvent(toggle, "ArrowDown");
    act(() => {
      try {
        toggle.dispatchEvent(rejected);
      } finally {
        if (originalDescriptor) {
          Object.defineProperty(
            window,
            "addEventListener",
            originalDescriptor,
          );
        } else {
          delete (window as unknown as Record<string, unknown>)
            .addEventListener;
        }
      }
    });
    expect(rejected.defaultPrevented).toBe(false);
    expect(menuElements().list).not.toBeVisible();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    const successor = menuElements().toggle;
    successor.focus();
    focus.mockClear();
    const accepted = dispatchToggleKey(successor, "ArrowDown");
    expect(accepted.defaultPrevented).toBe(true);
    expect(menuElements().links.md).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });
  });

  it("requires the real backing Window receiver instead of a same-prototype lookalike", () => {
    const originalAdd = window.addEventListener.bind(window);
    const originalRemove = window.removeEventListener.bind(window);
    const bridges = new WeakMap<EventListener, EventListener>();
    const lookalike = Object.create(
      Object.getPrototypeOf(window),
    ) as Window;
    Object.defineProperty(lookalike, "document", {
      configurable: true,
      value: document,
    });
    let useLookalike = true;
    vi.spyOn(window, "addEventListener").mockImplementation(
      (type, listener, options) => {
        if (type === "keydown" && typeof listener === "function") {
          const bridge: EventListener = function (this: Window, event) {
            Reflect.apply(
              listener,
              useLookalike ? lookalike : this,
              [event],
            );
          };
          bridges.set(listener, bridge);
          originalAdd(type, bridge, options);
          return;
        }
        originalAdd(type, listener, options);
      },
    );
    vi.spyOn(window, "removeEventListener").mockImplementation(
      (type, listener, options) => {
        const exact =
          type === "keydown" && typeof listener === "function"
            ? bridges.get(listener)
            : undefined;
        originalRemove(type, exact ?? listener, options);
      },
    );
    const preventDefault = vi.spyOn(
      Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    directRoots.add(root);
    act(() => {
      root.render(
        <StrictMode>
          <DownloadMenu docId={DOC_ID} />
        </StrictMode>,
      );
    });
    const toggle = menuElements().toggle;
    toggle.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const rejected = dispatchToggleKey(toggle, "ArrowDown");
    expect(rejected.defaultPrevented).toBe(false);
    expect(menuElements().list).not.toBeVisible();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(lookalike.document).toBe(document);
    expect(Object.getPrototypeOf(lookalike)).toBe(
      Object.getPrototypeOf(window),
    );

    useLookalike = false;
    const accepted = dispatchToggleKey(toggle, "ArrowUp");
    expect(accepted.defaultPrevented).toBe(true);
    expect(menuElements().links.pdf).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });
  });

  it("rejects altered key facts, prior cancellation, and missing focus before a fresh trusted recovery", () => {
    const nativePreventDefault = Event.prototype.preventDefault;
    const preventDefault = vi.spyOn(
      Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    directRoots.add(root);
    act(() => {
      root.render(
        <StrictMode>
          <DownloadMenu docId={DOC_ID} />
        </StrictMode>,
      );
    });
    const { toggle, list, links } = menuElements();
    const rejected = [
      toggleKeyEvent(toggle, "PageDown"),
      toggleKeyEvent(toggle, "ArrowDown", { ctrlKey: true }),
      toggleKeyEvent(toggle, "ArrowDown", { altKey: true }),
      toggleKeyEvent(toggle, "ArrowDown", { metaKey: true }),
      toggleKeyEvent(toggle, "ArrowDown", { shiftKey: true }),
      toggleKeyEvent(toggle, "ArrowDown", { repeat: true }),
      toggleKeyEvent(toggle, "ArrowDown", { isComposing: true }),
      toggleKeyEvent(toggle, "ArrowDown", { bubbles: false }),
      toggleKeyEvent(toggle, "ArrowDown", { cancelable: false }),
      toggleKeyEvent(toggle, "ArrowDown", {}, false),
    ];
    for (const event of rejected) {
      toggle.focus();
      focus.mockClear();
      preventDefault.mockClear();
      dispatchToggleKey(toggle, event);
      expect(event.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(list).not.toBeVisible();
    }

    const prevented = toggleKeyEvent(toggle, "ArrowDown");
    Reflect.apply(nativePreventDefault, prevented, []);
    toggle.focus();
    focus.mockClear();
    preventDefault.mockClear();
    dispatchToggleKey(toggle, prevented);
    expect(prevented.defaultPrevented).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    const stopped = toggleKeyEvent(toggle, "ArrowDown");
    stopped.stopPropagation();
    toggle.focus();
    focus.mockClear();
    preventDefault.mockClear();
    dispatchToggleKey(toggle, stopped);
    expect(stopped.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    const outside = connectedElement("button");
    outside.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const unfocused = dispatchToggleKey(toggle, "ArrowDown");
    expect(unfocused.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(list).not.toBeVisible();

    toggle.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const accepted = dispatchToggleKey(toggle, "ArrowUp");
    expect(accepted.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });
    expect(links.pdf).toHaveFocus();
  });

  it("rejects fabricated, crossed, forged, foreign, replayed, and reentrant pairs before successor recovery", () => {
    const nativePreventDefault = Event.prototype.preventDefault;
    const preventDefault = vi.spyOn(
      Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    directRoots.add(root);
    act(() => {
      root.render(
        <StrictMode>
          <DownloadMenu docId={DOC_ID} />
        </StrictMode>,
      );
    });
    let { toggle, list, links } = menuElements();
    const handler = reactHandler<ToggleKey>(toggle, "onKeyDown");
    const foreign = connectedElement("button");
    const fabricatedPreventDefault = vi.fn();
    handler({
      key: "ArrowDown",
      currentTarget: toggle,
      target: toggle,
      preventDefault: fabricatedPreventDefault,
    } as unknown as Parameters<ToggleKey>[0]);
    expect(fabricatedPreventDefault).not.toHaveBeenCalled();

    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const foreignView = iframe.contentWindow;
    const foreignEvent = iframe.contentDocument?.createEvent("KeyboardEvent");
    if (!foreignEvent) {
      throw new Error("The iframe has no KeyboardEvent");
    }
    foreignEvent.initKeyboardEvent(
      "keydown",
      true,
      true,
      foreignView,
      "ArrowDown",
    );
    handler({
      key: "ArrowDown",
      currentTarget: toggle,
      target: toggle,
      nativeEvent: foreignEvent,
      preventDefault: fabricatedPreventDefault,
    } as unknown as Parameters<ToggleKey>[0]);

    for (const property of [
      "currentTarget",
      "target",
      "isTrusted",
      "isDefaultPrevented",
    ] as const) {
      toggle.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const event = toggleKeyEvent(toggle, "ArrowDown");
      dispatchToggleKeyWithHandler(toggle, event, (reactEvent) => {
        handler(
          new Proxy(reactEvent, {
            get(target, current, receiver) {
              if (current !== property) {
                return Reflect.get(target, current, receiver);
              }
              if (property === "isDefaultPrevented") {
                return () => true;
              }
              if (property === "isTrusted") return false;
              return foreign;
            },
          }),
        );
      });
      expect(event.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(list).not.toBeVisible();
    }

    const forged = toggleKeyEvent(toggle, "ArrowDown");
    Object.defineProperty(forged, "key", {
      configurable: true,
      value: "ArrowUp",
    });
    toggle.focus();
    focus.mockClear();
    preventDefault.mockClear();
    dispatchToggleKey(toggle, forged);
    expect(forged.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    toggle.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const accepted = toggleKeyEvent(toggle, "ArrowUp");
    let activeReactEvent: Parameters<ToggleKey>[0] | null = null;
    preventDefault.mockImplementation(function (this: Event) {
      if (activeReactEvent) handler(activeReactEvent);
      Reflect.apply(nativePreventDefault, this, []);
    });
    dispatchToggleKeyWithHandler(toggle, accepted, (event) => {
      activeReactEvent = event;
      handler(event);
      handler(event);
      activeReactEvent = null;
    });
    ({ toggle, list, links } = menuElements());
    expect(accepted.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });
    expect(list).toBeVisible();
    expect(links.pdf).toHaveFocus();

    toggle.focus();
    focus.mockClear();
    preventDefault.mockClear();
    dispatchToggleKey(toggle, accepted);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(toggle).toHaveFocus();

    const currentToggle = menuElements().toggle;
    currentToggle.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const successor = dispatchToggleKey(currentToggle, "ArrowDown");
    expect(successor.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });
    expect(menuElements().links.md).toHaveFocus();
    iframe.remove();
  });
});

describe("DownloadMenu Strict Mode replay", () => {
  it("keeps all interaction families exact through direct-root ref and layout replay", () => {
    const pointers = trackPointerListeners();
    const preventDefault = vi.spyOn(
      Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    directRoots.add(root);

    const element = <T extends HTMLElement>(testId: string) => {
      const match = host.querySelector(`[data-testid="${testId}"]`);
      if (!(match instanceof HTMLElement)) throw new Error(`Missing ${testId}`);
      return match as T;
    };
    const capture = () => {
      const primary = element<HTMLAnchorElement>("reader-download");
      const toggle = element<HTMLButtonElement>("reader-download-menu");
      const list = element<HTMLDivElement>("reader-download-list");
      const links = Object.fromEntries(
        FORMATS.map((format) => [
          format,
          element<HTMLAnchorElement>(`reader-download-${format}`),
        ]),
      ) as Record<Format, HTMLAnchorElement>;
      const menuRoot = primary.parentElement;
      if (!(menuRoot instanceof HTMLDivElement)) {
        throw new Error("Download root was not rendered");
      }
      const nodes: HTMLElement[] = [
        menuRoot,
        primary,
        toggle,
        list,
        ...FORMATS.map((format) => links[format]),
      ];
      return {
        root: menuRoot,
        primary,
        toggle,
        list,
        links,
        nodes,
        refs: nodes.map((node) => reactRef(node)),
        toggleClick: reactHandler<ToggleClick>(toggle, "onClick"),
        toggleKey: reactHandler<ToggleKey>(toggle, "onKeyDown"),
        listKey: reactHandler<ListKey>(list, "onKeyDown"),
        rootKey: reactHandler<RootKey>(menuRoot, "onKeyDown"),
        rootBlur: reactHandler<RootBlur>(menuRoot, "onBlur"),
        linkClicks: Object.fromEntries(
          FORMATS.map((format) => [
            format,
            reactHandler<LinkClick>(links[format], "onClick"),
          ]),
        ) as Record<Format, LinkClick>,
      };
    };
    const strictLayouts: ReturnType<typeof capture>[] = [];
    const renderMenu = (instance: string, observeReplay = false) => (
      <StrictMode>
        <LayoutCapture
          capture={
            observeReplay
              ? () => {
                  strictLayouts.push(capture());
                }
              : () => {}
          }
        >
          <section key={instance}>
            <DownloadMenu docId={DOC_ID} />
          </section>
        </LayoutCapture>
      </StrictMode>
    );

    act(() => root.render(renderMenu("a", true)));
    const retiredByReplay = strictLayouts[0];
    if (!retiredByReplay) {
      throw new Error("Strict Mode did not run the first layout setup");
    }
    let current = capture();
    expect(current.root).toBe(retiredByReplay.root);
    expect(current.toggleClick).not.toBe(retiredByReplay.toggleClick);
    expect(current.refs[0]).not.toBe(retiredByReplay.refs[0]);

    const replayActivation = clickEvent(current.toggle);
    focus.mockClear();
    act(() => {
      retiredByReplay.refs.forEach((ref, index) => {
        ref(current.nodes[index] ?? null);
      });
      [...retiredByReplay.refs].reverse().forEach((ref) => ref(null));
      retiredByReplay.toggleClick(replayActivation);
      retiredByReplay.toggleKey(
        keyEvent(current.toggle, current.toggle, "ArrowDown"),
      );
      retiredByReplay.listKey(
        keyEvent(current.list, current.links.md, "ArrowDown"),
      );
      retiredByReplay.rootKey(
        keyEvent(current.root, current.links.md, "Escape"),
      );
      retiredByReplay.rootBlur(
        blurEvent(current.root, current.links.md, connectedElement("button")),
      );
      for (const format of FORMATS) {
        retiredByReplay.linkClicks[format](
          clickEvent(current.links[format]),
        );
      }
      current.toggleClick(replayActivation);
      current.toggleClick(replayActivation);
    });
    current = capture();
    expect(current.list).toBeVisible();
    expect(current.links.md).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith();
    expect(pointers.active.size).toBe(1);

    focus.mockClear();
    const closeActivation = clickEvent(current.toggle);
    act(() => {
      current.toggleClick(closeActivation);
      current.toggleClick(closeActivation);
    });
    current = capture();
    expect(current.list).not.toBeVisible();
    expect(focus).not.toHaveBeenCalled();
    expect(pointers.active.size).toBe(0);

    current.toggle.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const openKey = toggleKeyEvent(current.toggle, "ArrowDown");
    dispatchToggleKeyWithHandler(current.toggle, openKey, (event) => {
      current.toggleKey(event);
      current.toggleKey(event);
    });
    current = capture();
    expect(openKey.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(current.list).toBeVisible();
    expect(current.links.md).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });

    focus.mockClear();
    const moveKey = dispatchToggleKey(current.links.md, "ArrowDown");
    expect(moveKey.defaultPrevented).toBe(true);
    expect(current.links.html).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });
    expect(
      dispatchToggleKey(current.links.html, "End").defaultPrevented,
    ).toBe(true);
    expect(current.links.pdf).toHaveFocus();
    expect(
      dispatchToggleKey(current.links.pdf, "Home").defaultPrevented,
    ).toBe(true);
    expect(current.links.md).toHaveFocus();

    current = capture();
    focus.mockClear();
    const escapeKey = dispatchToggleKey(current.links.md, "Escape");
    current = capture();
    expect(escapeKey.defaultPrevented).toBe(true);
    expect(current.list).not.toBeVisible();
    expect(current.toggle).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });

    fireEvent.click(current.toggle);
    current = capture();
    const pointerListener = pointers.captured.at(-1);
    const outside = connectedElement("button");
    const outsidePointer = pointerEvent(outside);
    focus.mockClear();
    act(() => {
      invokePointer(pointerListener, outside, outsidePointer);
      invokePointer(pointerListener, outside, outsidePointer);
    });
    current = capture();
    expect(current.list).not.toBeVisible();
    expect(focus).not.toHaveBeenCalled();
    expect(pointers.active.size).toBe(0);

    fireEvent.click(current.toggle);
    current = capture();
    const outsideBlur = blurEvent(current.root, current.links.md, outside);
    act(() => {
      current.rootBlur(outsideBlur);
      current.rootBlur(outsideBlur);
    });
    current = capture();
    expect(current.list).not.toBeVisible();
    expect(pointers.active.size).toBe(0);

    for (const format of FORMATS) {
      fireEvent.click(current.toggle);
      current = capture();
      focus.mockClear();
      let preventedBeforeNavigation = true;
      document.addEventListener(
        "click",
        (event) => {
          preventedBeforeNavigation = event.defaultPrevented;
          event.preventDefault();
        },
        { once: true },
      );
      fireEvent.click(current.links[format]);
      current = capture();
      expect(preventedBeforeNavigation).toBe(false);
      expect(current.links[format]).toHaveAttribute(
        "href",
        downloadHref(DOC_ID, format),
      );
      expect(current.list).not.toBeVisible();
      expect(current.toggle).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith();
    }

    let primaryPrevented = true;
    document.addEventListener(
      "click",
      (event) => {
        primaryPrevented = event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );
    fireEvent.click(current.primary);
    expect(primaryPrevented).toBe(false);

    fireEvent.click(current.toggle);
    const stale = capture();
    const stalePointer = pointers.captured.at(-1);
    act(() => root.render(renderMenu("b")));
    current = capture();
    expect(current.root).not.toBe(stale.root);
    expect(current.toggleClick).not.toBe(stale.toggleClick);
    expect(pointers.active.size).toBe(0);

    const currentActivation = clickEvent(current.toggle);
    focus.mockClear();
    act(() => {
      stale.toggleClick(currentActivation);
      current.toggleClick(currentActivation);
      current.toggleClick(currentActivation);
    });
    current = capture();
    expect(current.list).toBeVisible();
    expect(current.links.md).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith();
    expect(pointers.active.size).toBe(1);

    focus.mockClear();
    act(() => {
      stale.refs.forEach((ref, index) => {
        ref(current.nodes[index] ?? null);
      });
      [...stale.refs].reverse().forEach((ref) => ref(null));
      current.refs.forEach((ref, index) => {
        ref(stale.nodes[index] ?? null);
      });
      stale.linkClicks.pdf(clickEvent(current.links.pdf));
      stale.rootKey(keyEvent(current.root, current.links.md, "Escape"));
      invokePointer(stalePointer, connectedElement("button"));
    });
    expect(current.list).toBeVisible();
    expect(current.links.md).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(pointers.active.size).toBe(1);

    fireEvent.click(current.links.pdf);
    expect(capture().list).not.toBeVisible();
  });
});

describe("DownloadMenu exact event sources", () => {
  it.each(["wrong-before-current", "current-before-wrong"] as const)(
    "accepts an exact toggle click once and ignores sibling, foreign, detached, and equal-looking sources (%s)",
    (order) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      render(
        <>
          <DownloadMenu docId={DOC_ID} />
          <DownloadMenu docId={NEXT_DOC_ID} />
        </>,
      );
      const toggles = screen.getAllByTestId("reader-download-menu") as HTMLButtonElement[];
      const lists = screen.getAllByTestId("reader-download-list") as HTMLDivElement[];
      const exact = toggles[0]!;
      const sibling = toggles[1]!;
      const foreign = connectedElement("button");
      const detached = document.createElement("button");
      const replacement = exact.cloneNode(true) as HTMLButtonElement;
      document.body.append(replacement);
      const handler = reactHandler<ToggleClick>(exact, "onClick");
      const event = clickEvent(
        order === "wrong-before-current" ? sibling : exact,
        exact,
      );
      focus.mockClear();

      act(() => {
        handler(clickEvent(foreign));
        handler(clickEvent(detached));
        handler(clickEvent(replacement));
        handler(event);
        event.currentTarget = order === "wrong-before-current" ? exact : sibling;
        handler(event);
        event.currentTarget = exact;
        handler(event);
      });

      expect(lists[0]).toBeVisible();
      expect(lists[1]).not.toBeVisible();
      expect(screen.getAllByTestId("reader-download-md")[0]).toHaveFocus();
      expect(focus).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["wrong-before-current", "current-before-wrong"] as const)(
    "accepts an exact toggle ArrowDown once without consuming wrong sources (%s)",
    (order) => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      render(<DownloadMenu docId={DOC_ID} />);
      const { toggle, list } = menuElements();
      const foreign = connectedElement("button");
      const detached = document.createElement("button");
      const replacement = toggle.cloneNode(true) as HTMLButtonElement;
      document.body.append(replacement);
      const handler = reactHandler<ToggleKey>(toggle, "onKeyDown");
      handler(keyEvent(detached, detached, "ArrowDown"));
      handler(keyEvent(replacement, replacement, "ArrowDown"));
      toggle.focus();
      preventDefault.mockClear();
      const event = toggleKeyEvent(toggle, "ArrowDown");
      dispatchToggleKeyWithHandler(toggle, event, (reactEvent) => {
        const wrong = new Proxy(reactEvent, {
          get(target, property, receiver) {
            if (property === "currentTarget") return foreign;
            return Reflect.get(target, property, receiver);
          },
        });
        if (order === "wrong-before-current") handler(wrong);
        handler(reactEvent);
        if (order === "current-before-wrong") handler(wrong);
        handler(reactEvent);
      });

      expect(list).toBeVisible();
      expect(event.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
    },
  );

  it.each(FORMATS)("binds the %s callback to only its exact format element and href", (format) => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    fireEvent.click(menuElements().toggle);
    const { toggle, list, links } = menuElements();
    const handler = reactHandler<LinkClick>(links[format], "onClick");
    const wrongFormat = links[FORMATS[(FORMATS.indexOf(format) + 1) % FORMATS.length]!]!;
    const foreign = connectedElement("a");
    foreign.href = links[format].href;
    const detached = links[format].cloneNode(true) as HTMLAnchorElement;
    const replacement = links[format].cloneNode(true) as HTMLAnchorElement;
    document.body.append(replacement);
    focus.mockClear();

    act(() => {
      handler(clickEvent(wrongFormat));
      handler(clickEvent(foreign));
      handler(clickEvent(detached));
      handler(clickEvent(replacement));
    });
    expect(list).toBeVisible();
    expect(focus).not.toHaveBeenCalled();

    act(() => handler(clickEvent(links[format])));
    expect(list).not.toBeVisible();
    expect(toggle).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("resolves list movement only from the exact list and exact published target, consuming an event once", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    fireEvent.click(menuElements().toggle);
    const { list, links } = menuElements();
    const handler = reactHandler<ListKey>(list, "onKeyDown");
    const foreignList = connectedElement("div");
    const foreignLink = connectedElement("a");
    const detachedList = document.createElement("div");
    const detachedLink = document.createElement("a");
    const replacementList = list.cloneNode(true) as HTMLDivElement;
    document.body.append(replacementList);
    const replacementLink = replacementList.querySelector("a");
    if (!(replacementLink instanceof HTMLAnchorElement)) throw new Error("Replacement list link was not cloned");
    focus.mockClear();

    const wrongList = keyEvent(foreignList, links.md, "ArrowDown");
    const wrongTarget = keyEvent(list, foreignLink, "ArrowDown");
    const detached = keyEvent(detachedList, detachedLink, "ArrowDown");
    const replacement = keyEvent(replacementList, replacementLink, "ArrowDown");
    handler(wrongList);
    handler(wrongTarget);
    handler(detached);
    handler(replacement);
    expect(wrongList.preventDefault).not.toHaveBeenCalled();
    expect(wrongTarget.preventDefault).not.toHaveBeenCalled();
    expect(detached.preventDefault).not.toHaveBeenCalled();
    expect(replacement.preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    const exact = dispatchToggleKey(links.md, "ArrowDown");
    expect(exact.defaultPrevented).toBe(true);
    expect(links.html).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });
  });

  it("binds Escape and blur to the exact root and exact event publication", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    fireEvent.click(menuElements().toggle);
    let { root, toggle, list, links } = menuElements();
    const rootKey = reactHandler<RootKey>(root, "onKeyDown");
    const rootBlur = reactHandler<RootBlur>(root, "onBlur");
    const foreignRoot = connectedElement("div");
    const foreignTarget = document.createElement("button");
    foreignRoot.append(foreignTarget);
    const detachedRoot = document.createElement("div");
    const detachedTarget = document.createElement("button");
    detachedRoot.append(detachedTarget);
    const outside = connectedElement("button");
    focus.mockClear();

    const wrongRoot = keyEvent(foreignRoot, foreignTarget, "Escape");
    const wrongTarget = keyEvent(root, foreignTarget, "Escape");
    const detached = keyEvent(detachedRoot, detachedTarget, "Escape");
    rootKey(wrongRoot);
    rootKey(wrongTarget);
    rootKey(detached);
    rootBlur(blurEvent(foreignRoot, foreignTarget, outside));
    rootBlur(blurEvent(root, foreignTarget, outside));
    rootBlur(blurEvent(detachedRoot, detachedTarget, outside));
    expect(list).toBeVisible();
    expect(focus).not.toHaveBeenCalled();
    expect(wrongRoot.preventDefault).not.toHaveBeenCalled();
    expect(wrongTarget.preventDefault).not.toHaveBeenCalled();
    expect(detached.preventDefault).not.toHaveBeenCalled();

    links.pdf.focus();
    focus.mockClear();
    const exactEscape = dispatchToggleKey(links.pdf, "Escape");
    expect(exactEscape.defaultPrevented).toBe(true);
    expect(list).not.toBeVisible();
    expect(toggle).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });

    fireEvent.click(toggle);
    ({ root, toggle, list, links } = menuElements());
    focus.mockClear();
    const currentBlur = reactHandler<RootBlur>(root, "onBlur");
    currentBlur(blurEvent(root, links.md, null));
    currentBlur(blurEvent(root, links.md, links.html));
    expect(list).toBeVisible();
    expect(focus).not.toHaveBeenCalled();
    act(() => currentBlur(blurEvent(root, links.md, outside)));
    expect(list).not.toBeVisible();
    expect(focus).not.toHaveBeenCalled();
  });
});

describe("DownloadMenu permanent retirement", () => {
  it.each([
    "partial ref replay",
    "root detach and reinsert",
    "root replacement and restore",
    "list replacement and restore",
    "link reorder and restore",
    "href mutation and restore",
    "descendant mutation and restore",
    "disabled ancestor and restore",
  ] as const)("does not revive after %s", (change) => {
    const pointers = trackPointerListeners();
    const preventDefault = vi.spyOn(
      Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const view = render(
      <fieldset data-testid="download-boundary">
        <DownloadMenu docId={DOC_ID} />
      </fieldset>,
    );
    fireEvent.click(menuElements().toggle);
    const current = menuElements();
    const staleLink = reactHandler<LinkClick>(
      current.links.md,
      "onClick",
    );
    const stalePointer = pointers.captured.at(-1);
    const rootRef = reactRef(current.root);

    if (change === "partial ref replay") {
      act(() => {
        rootRef(null);
        rootRef(current.root);
      });
    } else if (change === "root detach and reinsert") {
      const parent = current.root.parentNode;
      const next = current.root.nextSibling;
      if (!parent) throw new Error("Download root had no parent");
      current.root.remove();
      parent.insertBefore(current.root, next);
    } else if (change === "root replacement and restore") {
      const replacement = current.root.cloneNode(true) as HTMLDivElement;
      current.root.replaceWith(replacement);
      replacement.replaceWith(current.root);
    } else if (change === "list replacement and restore") {
      const replacement = current.list.cloneNode(true) as HTMLDivElement;
      current.list.replaceWith(replacement);
      replacement.replaceWith(current.list);
    } else if (change === "link reorder and restore") {
      current.list.append(current.links.md);
      current.list.insertBefore(current.links.md, current.links.html);
    } else if (change === "href mutation and restore") {
      current.links.md.setAttribute(
        "href",
        downloadHref(NEXT_DOC_ID, "md"),
      );
      current.links.md.setAttribute("href", downloadHref(DOC_ID, "md"));
    } else if (change === "descendant mutation and restore") {
      const label = current.links.md.lastElementChild;
      if (!(label instanceof HTMLSpanElement)) {
        throw new Error("Markdown link had no label");
      }
      label.textContent = "Changed";
      label.textContent = "Markdown";
    } else {
      const fieldset = screen.getByTestId("download-boundary");
      if (!(fieldset instanceof HTMLFieldSetElement)) {
        throw new Error("Download boundary was not a fieldset");
      }
      fieldset.disabled = true;
      fieldset.disabled = false;
    }

    current.toggle.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const staleKey = dispatchToggleKey(
      current.toggle,
      "ArrowUp",
    );
    expect(staleKey.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    const outside = connectedElement("button");
    act(() => {
      staleLink(clickEvent(current.links.md));
      invokePointer(stalePointer, outside);
    });
    expect(current.list).toBeVisible();
    expect(focus).not.toHaveBeenCalled();
    expect(pointers.active.size).toBe(0);

    view.rerender(
      <fieldset data-testid="download-boundary">
        <DownloadMenu key="fresh" docId={DOC_ID} />
      </fieldset>,
    );
    const recovered = menuElements();
    recovered.toggle.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const recoveredKey = dispatchToggleKey(
      recovered.toggle,
      "ArrowUp",
    );
    expect(recoveredKey.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });
    expect(menuElements().links.pdf).toHaveFocus();
  });

  it("rejects a restored mutation between Strict Mode replay and successor publication", () => {
    const pointers = trackPointerListeners();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    directRoots.add(root);
    let layoutSetups = 0;

    function ReplayMutation() {
      useLayoutEffect(() => {
        layoutSetups += 1;
        if (layoutSetups !== 2) return;
        const link = host.querySelector(
          '[data-testid="reader-download-md"]',
        );
        if (!(link instanceof HTMLAnchorElement)) {
          throw new Error("Strict replay had no Markdown link");
        }
        link.setAttribute("href", downloadHref(NEXT_DOC_ID, "md"));
        link.setAttribute("href", downloadHref(DOC_ID, "md"));
      }, []);
      return <DownloadMenu docId={DOC_ID} />;
    }

    act(() => {
      root.render(
        <StrictMode>
          <ReplayMutation />
        </StrictMode>,
      );
    });
    const toggle = host.querySelector(
      '[data-testid="reader-download-menu"]',
    );
    const list = host.querySelector(
      '[data-testid="reader-download-list"]',
    );
    if (
      !(toggle instanceof HTMLButtonElement) ||
      !(list instanceof HTMLDivElement)
    ) {
      throw new Error("Strict replay menu was not rendered");
    }
    fireEvent.click(toggle);
    expect(list).not.toBeVisible();
    expect(pointers.active.size).toBe(0);
  });

  it("rejects fabricated and crossed native targets before claiming the exact click", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    const { toggle, list, links } = menuElements();
    const click = reactHandler<ToggleClick>(toggle, "onClick");
    const crossed = clickEvent(toggle, toggle, links.md);
    const fabricated = {
      type: "click",
      currentTarget: toggle,
      target: toggle,
      nativeEvent: { type: "click", target: toggle },
    } as unknown as ClickEvent<HTMLButtonElement>;

    click(fabricated);
    click(crossed);
    expect(list).not.toBeVisible();
    expect(focus).not.toHaveBeenCalled();

    Object.defineProperty(crossed.nativeEvent, "target", {
      configurable: true,
      value: toggle,
    });
    act(() => {
      click(crossed);
      click(crossed);
    });
    expect(list).toBeVisible();
    expect(links.md).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith();
  });
});

describe("DownloadMenu publication replacement", () => {
  it.each(["stale-before-current", "current-before-stale"] as const)(
    "retires document A before the parent layout boundary and keeps B usable in %s order",
    (order) => {
      const pointers = trackPointerListeners();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const boundaryListeners: number[] = [];
      const view = render(
        <BoundaryHarness
          docId={DOC_ID}
          boundary={0}
          onBoundary={() => boundaryListeners.push(pointers.active.size)}
        />,
      );
      const closedA = menuElements();
      const staleClosedToggle = reactHandler<ToggleClick>(closedA.toggle, "onClick");
      fireEvent.click(closedA.toggle);
      const openA = menuElements();
      const staleToggle = reactHandler<ToggleClick>(openA.toggle, "onClick");
      const staleLink = reactHandler<LinkClick>(openA.links.html, "onClick");
      const staleList = reactHandler<ListKey>(openA.list, "onKeyDown");
      const staleRootKey = reactHandler<RootKey>(openA.root, "onKeyDown");
      const staleRootBlur = reactHandler<RootBlur>(openA.root, "onBlur");
      const stalePointer = pointers.captured.at(-1);
      expect(pointers.active.size).toBe(1);

      view.rerender(
        <BoundaryHarness
          docId={NEXT_DOC_ID}
          boundary={1}
          onBoundary={() => boundaryListeners.push(pointers.active.size)}
        />,
      );

      const closedB = menuElements();
      expect(boundaryListeners).toEqual([0]);
      expect(closedB.list).not.toBeVisible();
      expect(pointers.active.size).toBe(0);
      for (const format of FORMATS) {
        expect(closedB.links[format]).toHaveAttribute("href", downloadHref(NEXT_DOC_ID, format));
      }
      const currentToggle = reactHandler<ToggleClick>(closedB.toggle, "onClick");
      const activation = clickEvent(closedB.toggle);
      focus.mockClear();
      act(() => {
        if (order === "stale-before-current") staleClosedToggle(activation);
        currentToggle(activation);
        if (order === "current-before-stale") staleClosedToggle(activation);
        staleClosedToggle(activation);
      });
      const openB = menuElements();
      expect(openB.list).toBeVisible();
      expect(openB.links.md).toHaveFocus();
      expect(focus).toHaveBeenCalledTimes(1);
      expect(pointers.active.size).toBe(1);

      const outside = connectedElement("button");
      const staleListEvent = keyEvent(openB.list, openB.links.md, "ArrowDown");
      const staleEscape = keyEvent(openB.root, openB.links.md, "Escape");
      focus.mockClear();
      act(() => {
        staleToggle(clickEvent(openB.toggle));
        staleLink(clickEvent(openB.links.html));
        staleList(staleListEvent);
        staleRootKey(staleEscape);
        staleRootBlur(
          blurEvent(openB.root, openB.links.md, outside),
        );
        invokePointer(stalePointer, outside);
      });
      expect(openB.list).toBeVisible();
      expect(staleListEvent.preventDefault).not.toHaveBeenCalled();
      expect(staleEscape.preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(pointers.active.size).toBe(1);

      dispatchToggleKey(openB.links.md, "ArrowDown");
      expect(openB.links.html).toHaveFocus();
      fireEvent.click(openB.links.html);
      expect(openB.list).not.toBeVisible();
      expect(openB.toggle).toHaveFocus();
    },
  );

  it.each(["root", "toggle", "list", "md", "html", "pdf"] as const)(
    "retires an exact %s callback-ref replacement and lets the successor own reused DOM",
    (part) => {
      const pointers = trackPointerListeners();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const boundaryListeners: number[] = [];
      const view = render(
        <BoundaryHarness
          docId={DOC_ID}
          boundary={0}
          onBoundary={() => boundaryListeners.push(pointers.active.size)}
        />,
      );
      fireEvent.click(menuElements().toggle);
      const previous = menuElements();
      const element =
        part === "root"
          ? previous.root
          : part === "toggle"
            ? previous.toggle
            : part === "list"
              ? previous.list
              : previous.links[part];
      const staleRef = reactRef(element);
      const staleToggle = reactHandler<ToggleClick>(previous.toggle, "onClick");
      const stalePointer = pointers.captured.at(-1);
      const replacement = element.cloneNode(true) as typeof element;
      document.body.append(replacement);

      act(() => staleRef(replacement));
      expect(pointers.active.size).toBe(0);
      focus.mockClear();
      staleToggle(clickEvent(previous.toggle));
      invokePointer(stalePointer, connectedElement("button"));
      expect(previous.list).toBeVisible();
      expect(focus).not.toHaveBeenCalled();
      replacement.remove();

      view.rerender(
        <BoundaryHarness
          docId={DOC_ID}
          boundary={1}
          onBoundary={() => boundaryListeners.push(pointers.active.size)}
        />,
      );
      const current = menuElements();
      expect(boundaryListeners).toEqual([1]);
      expect(current.list).toBeVisible();
      expect(pointers.active.size).toBe(1);
      focus.mockClear();
      act(() => staleRef(null));
      expect(current.list).toBeVisible();
      expect(pointers.active.size).toBe(1);
      expect(focus).not.toHaveBeenCalled();

      fireEvent.click(current.toggle);
      expect(current.list).not.toBeVisible();
      expect(pointers.active.size).toBe(0);
    },
  );

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "isolates an equal-looking remount and its reused callback refs in %s order",
    (order) => {
      const pointers = trackPointerListeners();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const boundaryListeners: number[] = [];
      const view = render(
        <BoundaryHarness
          docId={DOC_ID}
          instance="a"
          boundary={0}
          onBoundary={() => boundaryListeners.push(pointers.active.size)}
        />,
      );
      fireEvent.click(menuElements().toggle);
      const previous = menuElements();
      const staleRootRef = reactRef(previous.root);
      const staleToggleRef = reactRef(previous.toggle);
      const staleListRef = reactRef(previous.list);
      const staleLinkRef = reactRef(previous.links.md);
      const staleToggle = reactHandler<ToggleClick>(previous.toggle, "onClick");
      const staleLink = reactHandler<LinkClick>(previous.links.md, "onClick");
      const stalePointer = pointers.captured.at(-1);

      view.rerender(
        <BoundaryHarness
          docId={DOC_ID}
          instance="b"
          boundary={1}
          onBoundary={() => boundaryListeners.push(pointers.active.size)}
        />,
      );
      const currentClosed = menuElements();
      expect(boundaryListeners).toEqual([0]);
      expect(currentClosed.root).not.toBe(previous.root);
      expect(currentClosed.list).not.toBeVisible();
      const currentToggle = reactHandler<ToggleClick>(currentClosed.toggle, "onClick");
      const activation = clickEvent(currentClosed.toggle);
      act(() => {
        if (order === "stale-before-current") staleToggle(activation);
        currentToggle(activation);
        if (order === "current-before-stale") staleToggle(activation);
      });
      const current = menuElements();
      expect(current.list).toBeVisible();
      expect(current.links.md).toHaveFocus();
      expect(pointers.active.size).toBe(1);

      focus.mockClear();
      act(() => {
        staleRootRef(current.root);
        staleToggleRef(current.toggle);
        staleListRef(current.list);
        staleLinkRef(current.links.md);
        staleRootRef(null);
        staleToggleRef(null);
        staleListRef(null);
        staleLinkRef(null);
        staleLink(clickEvent(current.links.md));
        invokePointer(stalePointer, connectedElement("button"));
      });
      expect(current.list).toBeVisible();
      expect(current.links.md).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
      expect(pointers.active.size).toBe(1);

      fireEvent.click(current.links.pdf);
      expect(current.list).not.toBeVisible();
      expect(current.toggle).toHaveFocus();
    },
  );

  it("retires removal before the parent layout boundary and cannot be revived by stale refs or listeners", () => {
    const pointers = trackPointerListeners();
    const preventDefault = vi.spyOn(
      Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const boundaryListeners: number[] = [];
    const view = render(
      <BoundaryHarness
        docId={DOC_ID}
        boundary={0}
        onBoundary={() => boundaryListeners.push(pointers.active.size)}
      />,
    );
    fireEvent.click(menuElements().toggle);
    const previous = menuElements();
    const staleRootRef = reactRef(previous.root);
    const staleToggle = reactHandler<ToggleClick>(previous.toggle, "onClick");
    const staleToggleKey = reactHandler<ToggleKey>(
      previous.toggle,
      "onKeyDown",
    );
    const staleLink = reactHandler<LinkClick>(previous.links.pdf, "onClick");
    const stalePointer = pointers.captured.at(-1);

    focus.mockClear();
    view.rerender(
      <BoundaryHarness
        docId={DOC_ID}
        present={false}
        boundary={1}
        onBoundary={() => boundaryListeners.push(pointers.active.size)}
      />,
    );
    act(() => {
      staleRootRef(previous.root);
      staleRootRef(null);
      staleToggle(clickEvent(previous.toggle));
      staleToggleKey(
        keyEvent(previous.toggle, previous.toggle, "ArrowUp"),
      );
      staleLink(clickEvent(previous.links.pdf));
      invokePointer(stalePointer, connectedElement("button"));
    });
    const staleNativeKey = dispatchToggleKey(
      previous.toggle,
      "ArrowUp",
    );
    expect(boundaryListeners).toEqual([0]);
    expect(pointers.active.size).toBe(0);
    expect(staleNativeKey.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    view.rerender(
      <BoundaryHarness
        docId={NEXT_DOC_ID}
        instance="new"
        boundary={2}
        onBoundary={() => boundaryListeners.push(pointers.active.size)}
      />,
    );
    const current = menuElements();
    expect(boundaryListeners).toEqual([0, 0]);
    fireEvent.click(current.toggle);
    expect(current.list).toBeVisible();
    expect(current.links.md).toHaveFocus();
    expect(pointers.active.size).toBe(1);
  });
});
