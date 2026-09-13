// @vitest-environment jsdom
import {
  StrictMode,
  useLayoutEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefCallback,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderedHeading } from "@/server/export/html";
import { ReaderToc } from "./toc";

const headings = [
  { id: "overview", level: 2, text: "Overview" },
  { id: "details", level: 3, text: "Details" },
];

type TestHeading = RenderedHeading & { top: number };
type ObserverEvent = { target: Element; isIntersecting: boolean };
type NavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

const documentA: TestHeading[] = [
  { id: "alpha", level: 2, text: "Alpha", top: 120 },
  { id: "shared", level: 3, text: "Shared in A", top: 240 },
];
const documentB: TestHeading[] = [
  { id: "beta", level: 2, text: "Beta", top: 120 },
  { id: "shared", level: 3, text: "Shared in B", top: 240 },
];
const documentWithMissing: TestHeading[] = [
  ...documentA,
  { id: "missing", level: 3, text: "Missing", top: 360 },
];
const navigationHeadings: TestHeading[] = [
  { id: "first", level: 2, text: "First", top: 120 },
  { id: "middle", level: 3, text: "Middle", top: 240 },
  { id: "last", level: 2, text: "Last", top: 360 },
];

class InstrumentedIntersectionObserver {
  static instances: InstrumentedIntersectionObserver[] = [];

  readonly root = null;
  readonly rootMargin: string;
  readonly thresholds: number[];
  readonly observed = new Set<Element>();
  readonly observe = vi.fn((target: Element) => this.observed.add(target));
  readonly unobserve = vi.fn((target: Element) => this.observed.delete(target));
  readonly disconnect = vi.fn(() => this.observed.clear());
  readonly takeRecords = vi.fn((): IntersectionObserverEntry[] => []);

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.rootMargin = options.rootMargin ?? "0px";
    this.thresholds = typeof options.threshold === "number"
      ? [options.threshold]
      : [...(options.threshold ?? [0])];
    InstrumentedIntersectionObserver.instances.push(this);
  }

  get connected() {
    return this.observed.size > 0;
  }

  capture(events: ObserverEvent[]) {
    const entries = events.map(({ target, isIntersecting }) => ({ target, isIntersecting }) as IntersectionObserverEntry);
    return () => this.callback(entries, this as unknown as IntersectionObserver);
  }

  publish(events: ObserverEvent[]) {
    act(() => this.capture(events)());
  }
}

function ReaderBoundary({
  currentHeadings,
  show = true,
  onLayout,
}: {
  currentHeadings: TestHeading[];
  show?: boolean;
  onLayout?: () => void;
}) {
  useLayoutEffect(() => {
    onLayout?.();
  }, [currentHeadings, onLayout, show]);

  if (!show) return null;
  return (
    <>
      <article>
        {currentHeadings.map((heading) => (
          <div id={heading.id} data-heading-top={heading.top} key={heading.id}>
            {heading.text}
          </div>
        ))}
      </article>
      <ReaderToc headings={currentHeadings} />
    </>
  );
}

const currentLinks = () => screen.queryAllByRole("link").filter((link) => link.getAttribute("aria-current") === "location");

type DirectView = { root: Root; host: HTMLDivElement; active: boolean };
type ClickHandler<T extends HTMLElement = HTMLElement> = (event: ReactMouseEvent<T>) => void;
type KeyHandler = (event: ReactKeyboardEvent<HTMLElement>) => void;

const directViews: DirectView[] = [];

function directRoot(node: React.ReactNode): DirectView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { root: createRoot(host), host, active: true };
  directViews.push(view);
  act(() => view.root.render(node));
  return view;
}

function reactHandler<T>(element: Element, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.tagName}`);
  return handler as T;
}

function clickEvent<T extends HTMLElement>(
  currentTarget: T,
  target: Element = currentTarget,
  options: { button?: number; nativeEvent?: MouseEvent } = {},
) {
  const nativeEvent = options.nativeEvent ?? new window.MouseEvent("click", {
    bubbles: true,
    button: options.button ?? 0,
    cancelable: true,
  });
  const preventDefault = vi.fn(() => nativeEvent.preventDefault());
  return {
    nativeEvent,
    preventDefault,
    dispatch: (...handlers: ClickHandler<T>[]) => {
      target.addEventListener("click", (dispatched) => {
        dispatched.stopPropagation();
        const event = {
          type: "click",
          currentTarget,
          target: dispatched.target,
          nativeEvent: dispatched,
          preventDefault,
        } as unknown as ReactMouseEvent<T>;
        handlers.forEach((handler) => handler(event));
      }, { capture: true, once: true });
      target.dispatchEvent(nativeEvent);
    },
  };
}

function escapeEvent(
  currentTarget: HTMLElement,
  target: Element,
  options: { nativeEvent?: KeyboardEvent; repeat?: boolean } = {},
) {
  const nativeEvent = options.nativeEvent ?? new window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Escape",
    repeat: options.repeat,
  });
  const preventDefault = vi.fn(() => nativeEvent.preventDefault());
  return {
    nativeEvent,
    preventDefault,
    dispatch: (...handlers: KeyHandler[]) => {
      target.addEventListener("keydown", (dispatched) => {
        dispatched.stopPropagation();
        const event = {
          type: "keydown",
          key: "Escape",
          currentTarget,
          target: dispatched.target,
          nativeEvent: dispatched,
          preventDefault,
        } as unknown as ReactKeyboardEvent<HTMLElement>;
        handlers.forEach((handler) => handler(event));
      }, { capture: true, once: true });
      target.dispatchEvent(nativeEvent);
    },
  };
}

function setJsdomEventView(event: KeyboardEvent, view: Window) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find((value): value is { view: Window | null } =>
      Boolean(value && typeof value === "object" && "view" in value));
  if (!implementation) throw new Error("The jsdom KeyboardEvent implementation was not found");
  implementation.view = view;
}

function navigationEvent(
  currentTarget: HTMLElement,
  target: Element,
  key: NavigationKey,
  options: {
    nativeEvent?: KeyboardEvent;
    repeat?: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    isComposing?: boolean;
    canceled?: boolean;
    stopped?: boolean;
    onNativeEventRead?: (read: number) => void;
  } = {},
) {
  const ownerView = target.ownerDocument.defaultView ?? window;
  const nativeEvent = options.nativeEvent ?? new ownerView.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    repeat: options.repeat,
    altKey: options.altKey,
    ctrlKey: options.ctrlKey,
    metaKey: options.metaKey,
    shiftKey: options.shiftKey,
    isComposing: options.isComposing,
  });
  if (!options.nativeEvent) setJsdomEventView(nativeEvent, ownerView);
  const preventDefault = vi.fn(() => nativeEvent.preventDefault());
  return {
    nativeEvent,
    preventDefault,
    dispatch: (...handlers: KeyHandler[]) => {
      target.addEventListener("keydown", (dispatched) => {
        if (options.canceled) dispatched.preventDefault();
        if (options.stopped) dispatched.stopPropagation();
        const keyboard = dispatched as KeyboardEvent;
        let nativeEventReads = 0;
        const event = {
          type: "keydown",
          key: keyboard.key,
          repeat: keyboard.repeat,
          altKey: keyboard.altKey,
          ctrlKey: keyboard.ctrlKey,
          metaKey: keyboard.metaKey,
          shiftKey: keyboard.shiftKey,
          isComposing: keyboard.isComposing,
          defaultPrevented: keyboard.defaultPrevented,
          currentTarget,
          target: dispatched.target,
          get nativeEvent() {
            nativeEventReads += 1;
            options.onNativeEventRead?.(nativeEventReads);
            return keyboard;
          },
          preventDefault,
          isDefaultPrevented: () => keyboard.defaultPrevented,
          isPropagationStopped: () => keyboard.cancelBubble,
        } as unknown as ReactKeyboardEvent<HTMLElement>;
        handlers.forEach((handler) => handler(event));
        dispatched.stopImmediatePropagation();
      }, { capture: true, once: true });
      target.dispatchEvent(nativeEvent);
    },
  };
}

function directControls(host: HTMLElement) {
  const nav = host.querySelector<HTMLElement>('[data-testid="reader-toc"]');
  const toggle = host.querySelector<HTMLButtonElement>('[data-testid="reader-toc-toggle"]');
  const list = host.querySelector<HTMLOListElement>("#reader-toc-list");
  const links = Array.from(host.querySelectorAll<HTMLAnchorElement>('[data-testid="reader-toc-entry"]'));
  if (!nav || !toggle || !list) throw new Error("The reader TOC was not fully rendered");
  return { nav, toggle, list, links };
}

function DirectReaderBoundary({
  currentHeadings,
  present = true,
  domKey,
  boundary = 0,
  onLayout,
  omitHeadingId,
  includeIdDecoy = false,
}: {
  currentHeadings: TestHeading[];
  present?: boolean;
  domKey?: string;
  boundary?: number;
  onLayout?: () => void;
  omitHeadingId?: string;
  includeIdDecoy?: boolean;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onLayout?.();
  }, [boundary, onLayout]);

  if (!present) return null;
  return (
    <>
      <article>
        {includeIdDecoy && <div data-testid="reader-heading-id-decoy" />}
        {currentHeadings.map((heading) => (
          <div
            id={heading.id === omitHeadingId ? undefined : heading.id}
            data-heading-top={heading.top}
            key={heading.id}
          >
            {heading.text}
          </div>
        ))}
      </article>
      <ReaderToc key={domKey} headings={currentHeadings} />
    </>
  );
}

type CapturedControls = ReturnType<typeof directControls> & {
  toggleHandler: ClickHandler<HTMLButtonElement>;
  linkHandler: ClickHandler<HTMLAnchorElement>;
  escapeHandler: KeyHandler;
  refs: RefCallback<Element>[];
};

function StrictReaderBoundary({
  currentHeadings,
  onLayout,
}: {
  currentHeadings: TestHeading[];
  onLayout: (capture: CapturedControls) => void;
}) {
  useLayoutEffect(() => {
    const controls = directControls(document.body);
    onLayout({
      ...controls,
      toggleHandler: reactHandler<ClickHandler<HTMLButtonElement>>(controls.toggle, "onClick"),
      linkHandler: reactHandler<ClickHandler<HTMLAnchorElement>>(controls.links[0], "onClick"),
      escapeHandler: reactHandler<KeyHandler>(controls.nav, "onKeyDown"),
      refs: [
        reactHandler<RefCallback<Element>>(controls.nav, "ref"),
        reactHandler<RefCallback<Element>>(controls.toggle, "ref"),
        reactHandler<RefCallback<Element>>(controls.list, "ref"),
        ...controls.links.map((link) => reactHandler<RefCallback<Element>>(link, "ref")),
      ],
    });
  }, [onLayout]);

  return <DirectReaderBoundary currentHeadings={currentHeadings} />;
}

beforeEach(() => {
  InstrumentedIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", InstrumentedIntersectionObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = Number(this.dataset.headingTop ?? 0);
    return {
      x: 0,
      y: top,
      width: 0,
      height: 0,
      top,
      right: 0,
      bottom: top,
      left: 0,
      toJSON: () => ({}),
    };
  });
});

afterEach(() => {
  for (const view of directViews.splice(0)) {
    if (!view.active) continue;
    act(() => view.root.unmount());
    view.active = false;
    view.host.remove();
  }
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ReaderToc mobile disclosure", () => {
  it("closes on Escape and returns focus to the Contents button", () => {
    render(<ReaderToc headings={headings} />);
    const toggle = screen.getByRole("button", { name: "Contents" });
    fireEvent.click(toggle);
    const firstLink = screen.getByRole("link", { name: "Overview" });
    firstLink.focus();

    fireEvent.keyDown(firstLink, { key: "Escape" });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
    expect(screen.getByRole("list")).toHaveClass("hidden");
  });

  it("keeps heading links in native Tab order with unchanged hrefs and closes when one is clicked", () => {
    render(<ReaderToc headings={headings} />);
    const toggle = screen.getByRole("button", { name: "Contents" });
    fireEvent.click(toggle);
    const links = screen.getAllByRole("link");

    expect(links.map((link) => link.getAttribute("href"))).toEqual(["#overview", "#details"]);
    expect(links.every((link) => !link.hasAttribute("role") && !link.hasAttribute("tabindex"))).toBe(true);
    expect(links[0]).toHaveClass("pl-2");
    expect(links[1]).toHaveClass("pl-5");
    fireEvent.click(links[1]);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("list")).toHaveClass("hidden");
  });
});

describe("ReaderToc heading wrapping", () => {
  const longHeadings: TestHeading[] = [
    { id: "long-word", level: 2, text: "Heading".repeat(40), top: 120 },
    { id: "long-url", level: 3, text: `https://example.com/${"section".repeat(40)}`, top: 240 },
    { id: "ordinary-heading", level: 2, text: "An ordinary heading", top: 360 },
    { id: "ordinary-child", level: 3, text: "An ordinary child heading", top: 480 },
  ];

  function expectEntries(links: HTMLAnchorElement[], expected: TestHeading[]) {
    expect(links.map((link) => link.textContent)).toEqual(expected.map((heading) => heading.text));
    expect(links.map((link) => link.getAttribute("href"))).toEqual(expected.map((heading) => `#${heading.id}`));
    links.forEach((link, index) => {
      expect(link).toHaveClass("block", "wrap-anywhere", "rounded-md", "py-1", "pr-2", "text-[13px]", "leading-snug");
      expect(link).toHaveClass(expected[index].level === 3 ? "pl-5" : "pl-2");
      expect(link).not.toHaveClass(expected[index].level === 3 ? "pl-2" : "pl-5");
      expect(link.childNodes).toHaveLength(1);
      expect(link.firstChild?.nodeType).toBe(Node.TEXT_NODE);
      expect(link).not.toHaveAttribute("role");
      expect(link).not.toHaveAttribute("tabindex");
      expect(link).not.toHaveAttribute("target");
    });
  }

  it("gives full long and multiword headings the shared wrapping rule in desktop and mobile markup without render side effects", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const click = vi.spyOn(HTMLElement.prototype, "click");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const send = vi.spyOn(XMLHttpRequest.prototype, "send");
    const activeElement = document.activeElement;
    const view = render(<ReaderBoundary currentHeadings={longHeadings} />);
    const controls = directControls(view.container);

    longHeadings.slice(0, 2).forEach((heading) => {
      expect(heading.text.length).toBeGreaterThanOrEqual(200);
      expect(heading.text).not.toMatch(/\s/);
    });
    expectEntries(controls.links, longHeadings);
    expect(controls.nav).toHaveClass("lg:sticky", "lg:top-20");
    expect(controls.toggle).toHaveClass("lg:hidden");
    expect(controls.toggle).toHaveAttribute("aria-expanded", "false");
    expect(controls.list).toHaveClass("hidden", "lg:flex", "flex-col");
    expect(screen.getByText("On this page")).toHaveClass("hidden", "lg:block");
    expect(currentLinks()).toEqual([controls.links[0]]);
    expect(controls.links[0]).toHaveClass("bg-accent-soft", "font-medium", "text-accent");
    expect(controls.links[1]).toHaveClass("text-ink-3", "hover:bg-surface-2", "hover:text-ink");

    const observer = InstrumentedIntersectionObserver.instances[0];
    observer.publish([{ target: document.getElementById("long-url")!, isIntersecting: true }]);
    expect(currentLinks()).toEqual([controls.links[1]]);
    expect(controls.links[1]).toHaveClass("wrap-anywhere", "pl-5", "bg-accent-soft", "font-medium", "text-accent");
    expect(controls.links[0]).toHaveClass("wrap-anywhere", "pl-2", "text-ink-3");
    expectEntries(controls.links, longHeadings);
    expect(document.activeElement).toBe(activeElement);
    expect(focus).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([0, 1])("keeps one accepted disclosure/link action and native href behavior for long entry %s under StrictMode", (index) => {
    const view = directRoot(
      <StrictMode>
        <DirectReaderBoundary currentHeadings={longHeadings} />
      </StrictMode>,
    );
    const controls = directControls(view.host);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const toggleHandler = reactHandler<ClickHandler<HTMLButtonElement>>(controls.toggle, "onClick");
    const toggleEvent = clickEvent(controls.toggle);
    act(() => toggleEvent.dispatch(toggleHandler, toggleHandler));
    expect(controls.toggle).toHaveAttribute("aria-expanded", "true");
    expect(controls.list).toHaveClass("flex", "lg:flex");
    expect(controls.list).not.toHaveClass("hidden");
    expectEntries(controls.links, longHeadings);

    const select = reactHandler<ClickHandler<HTMLAnchorElement>>(controls.links[index], "onClick");
    const activation = clickEvent(controls.links[index]);
    act(() => activation.dispatch(select, select));
    expect(activation.preventDefault).not.toHaveBeenCalled();
    expect(activation.nativeEvent.defaultPrevented).toBe(false);
    expect(controls.toggle).toHaveAttribute("aria-expanded", "false");
    expect(controls.list).toHaveClass("hidden", "lg:flex");
    expectEntries(controls.links, longHeadings);

    fireEvent.click(controls.toggle);
    act(() => activation.dispatch(select));
    expect(controls.toggle).toHaveAttribute("aria-expanded", "true");
    expect(focus).not.toHaveBeenCalled();
    expect(InstrumentedIntersectionObserver.instances.filter((observer) => observer.connected)).toHaveLength(1);
  });

  it("keeps wrapping on replacement headings without stale labels, hrefs, or observer updates", () => {
    const replacement: TestHeading[] = [
      { id: "new-identifier", level: 2, text: "NewIdentifier".repeat(20), top: 120 },
      { id: "long-url", level: 3, text: "ReplacementChild".repeat(20), top: 240 },
      { id: "new-ordinary", level: 2, text: "A different ordinary heading", top: 360 },
    ];
    const view = render(<ReaderBoundary currentHeadings={longHeadings} />);
    const oldObserver = InstrumentedIntersectionObserver.instances[0];
    const staleUpdate = oldObserver.capture([{ target: document.getElementById("long-word")!, isIntersecting: true }]);
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));

    view.rerender(<ReaderBoundary currentHeadings={replacement} />);
    const controls = directControls(view.container);
    expectEntries(controls.links, replacement);
    expect(view.container.querySelector('a[href="#long-word"]')).toBeNull();
    expect(controls.toggle).toHaveAttribute("aria-expanded", "false");
    expect(currentLinks()).toEqual([controls.links[0]]);
    expect(oldObserver.disconnect).toHaveBeenCalledOnce();
    expect(InstrumentedIntersectionObserver.instances).toHaveLength(2);

    const observer = InstrumentedIntersectionObserver.instances[1];
    observer.publish([{ target: document.getElementById("long-url")!, isIntersecting: true }]);
    act(staleUpdate);
    expect(currentLinks()).toEqual([controls.links[1]]);
    expectEntries(controls.links, replacement);
    expect(observer.disconnect).not.toHaveBeenCalled();
    fireEvent.click(controls.toggle);
    expect(controls.toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(controls.links[1]);
    expect(controls.toggle).toHaveAttribute("aria-expanded", "false");
    view.unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(oldObserver.disconnect).toHaveBeenCalledOnce();
  });
});

describe("ReaderToc keyboard navigation", () => {
  it("uses the stable KeyboardEvent-specific trust getter as keyboard authority", () => {
    const firstKeyboard = new window.KeyboardEvent("keydown", { key: "ArrowDown" });
    const secondKeyboard = new window.KeyboardEvent("keydown", { key: "ArrowUp" });
    const plainEvent = new window.Event("keydown");
    const firstDescriptor = Object.getOwnPropertyDescriptor(firstKeyboard, "isTrusted");
    const secondDescriptor = Object.getOwnPropertyDescriptor(secondKeyboard, "isTrusted");
    const plainDescriptor = Object.getOwnPropertyDescriptor(plainEvent, "isTrusted");

    expect(firstDescriptor?.get).toBeTypeOf("function");
    expect(secondDescriptor?.get).toBe(firstDescriptor?.get);
    expect(firstDescriptor?.configurable).toBe(false);
    if (plainDescriptor?.get !== firstDescriptor?.get) {
      expect(plainDescriptor?.get).not.toBe(firstDescriptor?.get);
    }
  });

  it.each(["ArrowDown", "ArrowUp", "Home", "End"] as const)(
    "rejects a unit-created untrusted %s event before prevention or focus",
    (key) => {
      const view = directRoot(
        <StrictMode>
          <ReaderToc headings={navigationHeadings} />
        </StrictMode>,
      );
      const controls = directControls(view.host);
      fireEvent.click(controls.toggle);
      controls.toggle.focus();
      const handler = reactHandler<KeyHandler>(controls.nav, "onKeyDown");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      focus.mockClear();
      const probe = navigationEvent(controls.nav, controls.toggle, key);

      act(() => probe.dispatch(handler));

      expect(probe.nativeEvent.isTrusted).toBe(false);
      expect(probe.preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(controls.toggle).toHaveFocus();
      expect(controls.toggle).toHaveAttribute("aria-expanded", "true");
    },
  );

  it.each([
    ["repeat", { repeat: true }],
    ["Alt", { altKey: true }],
    ["Control", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
    ["composition", { isComposing: true }],
    ["canceled", { canceled: true }],
    ["stopped", { stopped: true }],
  ] as const)("rejects a %s key before prevention or focus", (_label, options) => {
    const view = directRoot(
      <StrictMode>
        <ReaderToc headings={navigationHeadings} />
      </StrictMode>,
    );
    const controls = directControls(view.host);
    fireEvent.click(controls.toggle);
    controls.links[0].focus();
    const handler = reactHandler<KeyHandler>(controls.nav, "onKeyDown");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    focus.mockClear();
    const rejected = navigationEvent(controls.nav, controls.links[0], "ArrowDown", options);

    act(() => rejected.dispatch(handler));

    expect(rejected.preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(controls.links[0]).toHaveFocus();
    expect(controls.toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("leaves Enter to the native anchor and keeps Escape close and focus return", () => {
    const view = directRoot(
      <StrictMode>
        <ReaderToc headings={navigationHeadings} />
      </StrictMode>,
    );
    let controls = directControls(view.host);
    fireEvent.click(controls.toggle);
    controls.links[0].focus();

    fireEvent.keyDown(controls.links[0], { key: "Enter" });
    expect(controls.links[0]).toHaveFocus();
    expect(controls.toggle).toHaveAttribute("aria-expanded", "true");

    const activate = reactHandler<ClickHandler<HTMLAnchorElement>>(controls.links[0], "onClick");
    const activation = clickEvent(controls.links[0]);
    act(() => activation.dispatch(activate));
    expect(activation.preventDefault).not.toHaveBeenCalled();
    expect(controls.toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(controls.toggle);
    controls = directControls(view.host);
    controls.links[1].focus();
    fireEvent.keyDown(controls.links[1], { key: "Escape" });
    expect(controls.toggle).toHaveAttribute("aria-expanded", "false");
    expect(controls.toggle).toHaveFocus();
  });

  it("rejects a prototype-forged keyboard object with no native slots without throwing", () => {
    const view = directRoot(
      <StrictMode>
        <ReaderToc headings={navigationHeadings} />
      </StrictMode>,
    );
    const controls = directControls(view.host);
    fireEvent.click(controls.toggle);
    controls.links[0].focus();
    const handler = reactHandler<KeyHandler>(controls.nav, "onKeyDown");
    const preventDefault = vi.fn();
    const forged = {
      type: "keydown",
      key: "ArrowDown",
      repeat: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      isComposing: false,
      defaultPrevented: false,
      currentTarget: controls.nav,
      target: controls.links[0],
      nativeEvent: Object.create(window.KeyboardEvent.prototype),
      preventDefault,
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
    } as unknown as ReactKeyboardEvent<HTMLElement>;

    expect(() => act(() => handler(forged))).not.toThrow();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(controls.links[0]).toHaveFocus();
    expect(controls.toggle).toHaveAttribute("aria-expanded", "true");
  });

  it.each([
    ["Event.target", Event.prototype, "target"],
    ["KeyboardEvent.key", KeyboardEvent.prototype, "key"],
  ] as const)("retires a publication with a changed or throwing %s descriptor", (_label, owner, key) => {
    const view = directRoot(
      <StrictMode>
        <DirectReaderBoundary currentHeadings={navigationHeadings} domKey="a" />
      </StrictMode>,
    );
    let controls = directControls(view.host);
    fireEvent.click(controls.toggle);
    controls.links[0].focus();
    const handler = reactHandler<KeyHandler>(controls.nav, "onKeyDown");
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
    const throwingGetter = vi.fn(() => {
      throw new Error("changed descriptor must not run");
    });
    const nativeEvent = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowDown",
    });
    const preventDefault = vi.fn();
    const rejected = {
      type: "keydown",
      key: "ArrowDown",
      repeat: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      defaultPrevented: false,
      currentTarget: controls.nav,
      target: controls.links[0],
      nativeEvent,
      preventDefault,
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
    } as unknown as ReactKeyboardEvent<HTMLElement>;
    Object.defineProperty(owner, key, { ...descriptor, get: throwingGetter });
    try {
      expect(() => act(() => handler(rejected))).not.toThrow();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(throwingGetter).not.toHaveBeenCalled();
      expect(controls.links[0]).toHaveFocus();
    } finally {
      Object.defineProperty(owner, key, descriptor);
    }

    act(() => view.root.render(
      <StrictMode>
        <DirectReaderBoundary currentHeadings={navigationHeadings} domKey="b" />
      </StrictMode>,
    ));
    controls = directControls(view.host);
    fireEvent.click(controls.toggle);
    controls.links[0].focus();
    fireEvent.keyDown(controls.links[0], { key: "Escape" });
    expect(controls.toggle).toHaveAttribute("aria-expanded", "false");
    expect(controls.toggle).toHaveFocus();
  });

  it("does not invoke an own destination focus getter that tries to steal custody", () => {
    const view = directRoot(
      <StrictMode>
        <DirectReaderBoundary currentHeadings={navigationHeadings} domKey="a" />
      </StrictMode>,
    );
    const controls = directControls(view.host);
    fireEvent.click(controls.toggle);
    controls.links[0].focus();
    const outside = document.createElement("button");
    document.body.append(outside);
    const focusGetter = vi.fn(() => {
      outside.focus();
      return HTMLElement.prototype.focus;
    });
    Object.defineProperty(controls.links[1], "focus", {
      configurable: true,
      get: focusGetter,
    });
    const handler = reactHandler<KeyHandler>(controls.nav, "onKeyDown");
    const rejected = navigationEvent(controls.nav, controls.links[0], "ArrowDown");
    try {
      expect(() => act(() => rejected.dispatch(handler))).not.toThrow();
      expect(focusGetter).not.toHaveBeenCalled();
      expect(rejected.preventDefault).not.toHaveBeenCalled();
      expect(controls.links[0]).toHaveFocus();
    } finally {
      Reflect.deleteProperty(controls.links[1], "focus");
      outside.remove();
    }
  });

  it("rejects owner-realm focus prototype replacement before prevention or focus", () => {
    const view = directRoot(
      <StrictMode>
        <ReaderToc headings={navigationHeadings} />
      </StrictMode>,
    );
    const controls = directControls(view.host);
    fireEvent.click(controls.toggle);
    controls.links[0].focus();
    const handler = reactHandler<KeyHandler>(controls.nav, "onKeyDown");
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")!;
    const replacement = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "focus", { ...descriptor, value: replacement });
    const rejected = navigationEvent(controls.nav, controls.links[0], "ArrowDown");
    try {
      expect(() => act(() => rejected.dispatch(handler))).not.toThrow();
      expect(rejected.preventDefault).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
      expect(controls.links[0]).toHaveFocus();
    } finally {
      Object.defineProperty(HTMLElement.prototype, "focus", descriptor);
    }
  });

  it("rejects a foreign owner-view keyboard event after its prototype is grafted", () => {
    const view = directRoot(
      <StrictMode>
        <ReaderToc headings={navigationHeadings} />
      </StrictMode>,
    );
    const controls = directControls(view.host);
    fireEvent.click(controls.toggle);
    controls.links[0].focus();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignWindow = frame.contentWindow! as Window & typeof globalThis;
    const foreignEvent = new foreignWindow.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowDown",
    });
    setJsdomEventView(foreignEvent, document.defaultView!);
    Object.setPrototypeOf(foreignEvent, window.KeyboardEvent.prototype);
    const handler = reactHandler<KeyHandler>(controls.nav, "onKeyDown");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    focus.mockClear();
    const rejected = navigationEvent(controls.nav, controls.links[0], "ArrowDown", {
      nativeEvent: foreignEvent,
    });
    try {
      expect(() => act(() => rejected.dispatch(handler))).not.toThrow();
      expect(rejected.preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(controls.links[0]).toHaveFocus();
    } finally {
      frame.remove();
    }
  });

  it("rejects custody loss while revalidating event facts", () => {
    const view = directRoot(
      <StrictMode>
        <ReaderToc headings={navigationHeadings} />
      </StrictMode>,
    );
    const controls = directControls(view.host);
    fireEvent.click(controls.toggle);
    controls.links[0].focus();
    const outside = document.createElement("button");
    document.body.append(outside);
    const handler = reactHandler<KeyHandler>(controls.nav, "onKeyDown");
    let reads = 0;
    const rejected = navigationEvent(controls.nav, controls.links[0], "ArrowDown", {
      onNativeEventRead: (read) => {
        reads = read;
        if (read === 3) outside.focus();
      },
    });

    act(() => rejected.dispatch(handler));

    expect(reads).toBeGreaterThanOrEqual(3);
    expect(rejected.preventDefault).not.toHaveBeenCalled();
    expect(outside).toHaveFocus();
    expect(controls.toggle).toHaveAttribute("aria-expanded", "true");
    outside.remove();
  });

  it("rejects mutation history introduced while revalidating event facts", () => {
    const renderBoundary = (domKey: string) => (
      <StrictMode>
        <DirectReaderBoundary currentHeadings={navigationHeadings} domKey={domKey} />
      </StrictMode>
    );
    const view = directRoot(renderBoundary("a"));
    let controls = directControls(view.host);
    fireEvent.click(controls.toggle);
    controls.links[0].focus();
    const handler = reactHandler<KeyHandler>(controls.nav, "onKeyDown");
    const rejected = navigationEvent(controls.nav, controls.links[0], "ArrowDown", {
      onNativeEventRead: (read) => {
        if (read !== 3) return;
        controls.nav.setAttribute("aria-label", "Changed contents");
        controls.nav.setAttribute("aria-label", "Table of contents");
      },
    });

    act(() => rejected.dispatch(handler));

    expect(rejected.preventDefault).not.toHaveBeenCalled();
    expect(controls.links[0]).toHaveFocus();
    fireEvent.keyDown(controls.links[0], { key: "Escape" });
    expect(controls.toggle).toHaveAttribute("aria-expanded", "true");

    act(() => view.root.render(renderBoundary("b")));
    controls = directControls(view.host);
    fireEvent.click(controls.toggle);
    controls.links[0].focus();
    fireEvent.keyDown(controls.links[0], { key: "Escape" });
    expect(controls.toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("rejects stale and replayed events while a complete clean successor remains usable", () => {
    const renderBoundary = (headings: TestHeading[], domKey: string) => (
      <StrictMode>
        <DirectReaderBoundary currentHeadings={headings} domKey={domKey} />
      </StrictMode>
    );
    const view = directRoot(renderBoundary(documentA, "a"));
    let controls = directControls(view.host);
    fireEvent.click(controls.toggle);
    const staleHandler = reactHandler<KeyHandler>(controls.nav, "onKeyDown");

    act(() => view.root.render(renderBoundary(documentB, "b")));
    controls = directControls(view.host);
    fireEvent.click(controls.toggle);
    controls.links[0].focus();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    focus.mockClear();
    const stale = navigationEvent(controls.nav, controls.links[0], "ArrowDown");
    act(() => stale.dispatch(staleHandler));
    expect(stale.preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    const currentHandler = reactHandler<KeyHandler>(controls.nav, "onKeyDown");
    const replayed = navigationEvent(controls.nav, controls.links[0], "ArrowDown");
    act(() => replayed.dispatch(currentHandler, currentHandler));
    expect(replayed.preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    fireEvent.keyDown(controls.links[0], { key: "Escape" });
    expect(controls.toggle).toHaveAttribute("aria-expanded", "false");
    expect(controls.toggle).toHaveFocus();
  });

  it.each(["attribute-restore", "detach-restore", "reorder-restore"] as const)(
    "retires %s history and leaves a distinct complete successor usable",
    (kind) => {
      const renderBoundary = (domKey: string) => (
        <StrictMode>
          <DirectReaderBoundary currentHeadings={navigationHeadings} domKey={domKey} />
        </StrictMode>
      );
      const view = directRoot(renderBoundary("a"));
      let controls = directControls(view.host);
      fireEvent.click(controls.toggle);
      controls.links[0].focus();
      const staleHandler = reactHandler<KeyHandler>(controls.nav, "onKeyDown");
      const firstItem = controls.links[0].parentElement as HTMLLIElement;
      const secondItem = controls.links[1].parentElement as HTMLLIElement;
      if (kind === "attribute-restore") {
        controls.links[0].setAttribute("href", "#changed");
        controls.links[0].setAttribute("href", "#first");
      } else if (kind === "detach-restore") {
        firstItem.remove();
        controls.list.insertBefore(firstItem, secondItem);
      } else {
        controls.list.insertBefore(secondItem, firstItem);
        controls.list.insertBefore(firstItem, secondItem);
      }
      const focusBefore = document.activeElement;
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      focus.mockClear();
      const stale = navigationEvent(controls.nav, controls.links[0], "ArrowDown");

      act(() => stale.dispatch(staleHandler));

      expect(stale.preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(focusBefore);

      act(() => view.root.render(renderBoundary("b")));
      controls = directControls(view.host);
      fireEvent.click(controls.toggle);
      controls.links[0].focus();
      fireEvent.keyDown(controls.links[0], { key: "Escape" });
      expect(controls.toggle).toHaveAttribute("aria-expanded", "false");
      expect(controls.toggle).toHaveFocus();
    },
  );

  it("rejects a partial Strict replay and accepts the exact current key handler", () => {
    const captures: CapturedControls[] = [];
    const view = directRoot(
      <StrictMode>
        <StrictReaderBoundary
          currentHeadings={documentA}
          onLayout={(capture) => captures.push(capture)}
        />
      </StrictMode>,
    );
    expect(captures).toHaveLength(2);
    const controls = directControls(view.host);
    fireEvent.click(controls.toggle);
    controls.links[0].focus();
    const stale = captures[0];
    act(() => {
      stale.refs[0](controls.nav);
      stale.refs[1](controls.toggle);
      stale.refs[0](null);
      stale.refs[1](null);
    });
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    focus.mockClear();
    const rejected = navigationEvent(controls.nav, controls.links[0], "ArrowDown");
    act(() => rejected.dispatch(stale.escapeHandler));
    expect(rejected.preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    const current = navigationEvent(controls.nav, controls.links[0], "ArrowDown");
    const currentHandler = reactHandler<KeyHandler>(controls.nav, "onKeyDown");
    act(() => current.dispatch(currentHandler));
    expect(current.preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(controls.links[0]).toHaveFocus();
  });
});

describe("ReaderToc headings visit authority", () => {
  it("retires A before B's parent layout boundary and lets only B publish a current heading", () => {
    const view = render(<ReaderBoundary currentHeadings={documentA} />);
    const oldObserver = InstrumentedIntersectionObserver.instances[0];
    const oldShared = document.getElementById("shared");
    expect(oldObserver).toBeDefined();
    expect(oldShared).not.toBeNull();
    expect(InstrumentedIntersectionObserver.instances.filter((observer) => observer.connected)).toHaveLength(1);
    expect([...oldObserver.observed].map((element) => element.id)).toEqual(["alpha", "shared"]);
    expect(oldObserver.rootMargin).toBe("-88px 0px -55% 0px");
    expect(oldObserver.thresholds).toEqual([0, 1]);
    expect(currentLinks()).toHaveLength(1);
    expect(currentLinks()[0]).toHaveTextContent("Alpha");

    const toggle = screen.getByRole("button", { name: "Contents" });
    fireEvent.click(toggle);
    screen.getByRole("link", { name: "Alpha" }).focus();
    const staleOverlap = oldObserver.capture([{ target: oldShared!, isIntersecting: true }]);
    let disconnectedAtBoundary = false;
    let closedAtBoundary = false;
    let currentAtBoundary = -1;
    let focusUnchangedByStaleCallback = false;

    view.rerender(
      <ReaderBoundary
        currentHeadings={documentB}
        onLayout={() => {
          disconnectedAtBoundary = !oldObserver.connected && oldObserver.disconnect.mock.calls.length === 1;
          const focusBeforeStaleCallback = document.activeElement;
          staleOverlap();
          focusUnchangedByStaleCallback = document.activeElement === focusBeforeStaleCallback;
          closedAtBoundary = screen.getByRole("button", { name: "Contents" }).getAttribute("aria-expanded") === "false";
          currentAtBoundary = currentLinks().length;
        }}
      />,
    );

    expect(disconnectedAtBoundary).toBe(true);
    expect(closedAtBoundary).toBe(true);
    expect(currentAtBoundary).toBe(0);
    expect(focusUnchangedByStaleCallback).toBe(true);
    expect(oldObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(InstrumentedIntersectionObserver.instances).toHaveLength(2);
    const currentObserver = InstrumentedIntersectionObserver.instances[1];
    expect(currentObserver.disconnect).not.toHaveBeenCalled();
    expect(InstrumentedIntersectionObserver.instances.filter((observer) => observer.connected)).toEqual([currentObserver]);
    expect([...currentObserver.observed].map((element) => element.id)).toEqual(["beta", "shared"]);
    expect(currentLinks()).toHaveLength(1);
    expect(currentLinks()[0]).toHaveTextContent("Beta");
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["#beta", "#shared"]);

    currentObserver.publish([{ target: document.getElementById("shared")!, isIntersecting: true }]);
    expect(currentLinks()).toHaveLength(1);
    expect(currentLinks()[0]).toHaveTextContent("Shared in B");
    expect(currentObserver.disconnect).not.toHaveBeenCalled();
  });

  it("ignores an overlapping A callback after current B callbacks and keeps B's observer usable", () => {
    const view = render(<ReaderBoundary currentHeadings={documentA} />);
    const oldObserver = InstrumentedIntersectionObserver.instances[0];
    const oldShared = document.getElementById("shared");
    expect(oldShared).not.toBeNull();
    const staleOverlap = oldObserver.capture([{ target: oldShared!, isIntersecting: true }]);

    view.rerender(<ReaderBoundary currentHeadings={documentB} />);
    const currentObserver = InstrumentedIntersectionObserver.instances[1];
    const beta = document.getElementById("beta");
    const shared = document.getElementById("shared");
    expect(beta).not.toBeNull();
    expect(shared).not.toBeNull();

    currentObserver.publish([{ target: shared!, isIntersecting: true }]);
    expect(currentLinks()[0]).toHaveTextContent("Shared in B");
    currentObserver.publish([
      { target: shared!, isIntersecting: false },
      { target: beta!, isIntersecting: true },
    ]);
    expect(currentLinks()[0]).toHaveTextContent("Beta");

    const toggle = screen.getByRole("button", { name: "Contents" });
    fireEvent.click(toggle);
    const betaLink = screen.getByRole("link", { name: "Beta" });
    betaLink.focus();
    act(staleOverlap);

    expect(currentLinks()).toHaveLength(1);
    expect(currentLinks()[0]).toBe(betaLink);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(betaLink).toHaveFocus();
    expect(oldObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(currentObserver.disconnect).not.toHaveBeenCalled();

    currentObserver.publish([
      { target: beta!, isIntersecting: false },
      { target: shared!, isIntersecting: true },
    ]);
    expect(currentLinks()).toHaveLength(1);
    expect(currentLinks()[0]).toHaveTextContent("Shared in B");
  });

  it("disconnects A before the parent layout boundary on removal and ignores its captured callback", () => {
    const view = render(<ReaderBoundary currentHeadings={documentA} />);
    const oldObserver = InstrumentedIntersectionObserver.instances[0];
    const oldShared = document.getElementById("shared");
    expect(oldShared).not.toBeNull();
    const staleOverlap = oldObserver.capture([{ target: oldShared!, isIntersecting: true }]);
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    screen.getByRole("link", { name: "Alpha" }).focus();
    let disconnectedAtBoundary = false;
    let focusUnchangedByStaleCallback = false;
    let tocAbsentAtBoundary = false;

    view.rerender(
      <ReaderBoundary
        currentHeadings={documentA}
        show={false}
        onLayout={() => {
          disconnectedAtBoundary = !oldObserver.connected && oldObserver.disconnect.mock.calls.length === 1;
          const focusBeforeStaleCallback = document.activeElement;
          staleOverlap();
          focusUnchangedByStaleCallback = document.activeElement === focusBeforeStaleCallback;
          tocAbsentAtBoundary = screen.queryByTestId("reader-toc") === null;
        }}
      />,
    );

    expect(disconnectedAtBoundary).toBe(true);
    expect(focusUnchangedByStaleCallback).toBe(true);
    expect(tocAbsentAtBoundary).toBe(true);
    expect(oldObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(InstrumentedIntersectionObserver.instances).toHaveLength(1);
    expect(InstrumentedIntersectionObserver.instances.filter((observer) => observer.connected)).toHaveLength(0);
    expect(screen.queryByTestId("reader-toc")).not.toBeInTheDocument();
  });
});

describe("ReaderToc exact DOM publications", () => {
  const wrongSources = ["sibling", "foreign", "detached", "replacement", "cross-row", "wrong-order"] as const;

  it.each(wrongSources)("rejects a %s link source without consuming the current publication", (sourceKind) => {
    const view = directRoot(<DirectReaderBoundary currentHeadings={documentA} />);
    fireEvent.click(directControls(view.host).toggle);
    const { links, list, toggle } = directControls(view.host);
    const first = links[0];
    const second = links[1];
    const firstItem = first.parentElement as HTMLLIElement;
    const secondItem = second.parentElement as HTMLLIElement;
    const select = reactHandler<ClickHandler<HTMLAnchorElement>>(first, "onClick");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    let source: HTMLAnchorElement = first;
    let restore: () => void = () => {};

    if (sourceKind === "sibling") {
      source = first.cloneNode(true) as HTMLAnchorElement;
      document.body.append(source);
      restore = () => source.remove();
    } else if (sourceKind === "foreign") {
      const foreignDocument = document.implementation.createHTMLDocument("foreign");
      source = foreignDocument.createElement("a");
      source.href = "#alpha";
      foreignDocument.body.append(source);
    } else if (sourceKind === "detached") {
      firstItem.remove();
      restore = () => {
        list.insertBefore(firstItem, list.firstElementChild);
      };
    } else if (sourceKind === "replacement") {
      source = first.cloneNode(true) as HTMLAnchorElement;
      first.replaceWith(source);
      restore = () => source.replaceWith(first);
    } else if (sourceKind === "cross-row") {
      source = second;
    } else {
      list.insertBefore(secondItem, firstItem);
      restore = () => {
        list.insertBefore(firstItem, secondItem);
      };
    }

    const probe = clickEvent(source);
    const before = {
      markup: view.host.innerHTML,
      activeElement: document.activeElement,
      observers: InstrumentedIntersectionObserver.instances.length,
      disconnects: InstrumentedIntersectionObserver.instances.map((observer) => observer.disconnect.mock.calls.length),
    };
    act(() => probe.dispatch(select));

    expect(probe.preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect({
      markup: view.host.innerHTML,
      activeElement: document.activeElement,
      observers: InstrumentedIntersectionObserver.instances.length,
      disconnects: InstrumentedIntersectionObserver.instances.map((observer) => observer.disconnect.mock.calls.length),
    }).toEqual(before);

    restore();
    if (sourceKind === "detached" || sourceKind === "replacement" || sourceKind === "wrong-order") {
      const retired = clickEvent(first);
      act(() => retired.dispatch(select));
      expect(toggle).toHaveAttribute("aria-expanded", "true");

      act(() => view.root.render(<DirectReaderBoundary currentHeadings={documentA} boundary={1} />));
      const current = directControls(view.host);
      const currentHandler = reactHandler<ClickHandler<HTMLAnchorElement>>(current.links[0], "onClick");
      const currentEvent = clickEvent(current.links[0]);
      act(() => currentEvent.dispatch(currentHandler));
      expect(current.toggle).toHaveAttribute("aria-expanded", "false");
      expect(current.list).toHaveClass("hidden");
      expect(currentEvent.preventDefault).not.toHaveBeenCalled();
    } else {
      const current = clickEvent(first);
      act(() => current.dispatch(select));
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(list).toHaveClass("hidden");
      expect(current.preventDefault).not.toHaveBeenCalled();
    }
  });

  it.each(["A-before-B", "B-before-A"] as const)(
    "rejects A-handler/B-control and B-handler/A-control pairings %s",
    (order) => {
      const view = directRoot(<DirectReaderBoundary currentHeadings={documentA} domKey="a" />);
      const a = directControls(view.host);
      const aToggle = reactHandler<ClickHandler<HTMLButtonElement>>(a.toggle, "onClick");
      const aLink = reactHandler<ClickHandler<HTMLAnchorElement>>(a.links[0], "onClick");
      const aEscape = reactHandler<KeyHandler>(a.nav, "onKeyDown");

      act(() => view.root.render(<DirectReaderBoundary currentHeadings={documentB} domKey="b" />));
      const b = directControls(view.host);
      const bToggle = reactHandler<ClickHandler<HTMLButtonElement>>(b.toggle, "onClick");
      const bLink = reactHandler<ClickHandler<HTMLAnchorElement>>(b.links[0], "onClick");
      const bEscape = reactHandler<KeyHandler>(b.nav, "onKeyDown");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const escapeAOnB = escapeEvent(b.nav, b.links[0]);
      const escapeBOnA = escapeEvent(a.nav, a.links[0]);
      const aOnB = () => {
        clickEvent(b.toggle).dispatch(aToggle);
        clickEvent(b.links[0]).dispatch(aLink);
        escapeAOnB.dispatch(aEscape);
      };
      const bOnA = () => {
        clickEvent(a.toggle).dispatch(bToggle);
        clickEvent(a.links[0]).dispatch(bLink);
        escapeBOnA.dispatch(bEscape);
      };

      document.body.append(a.nav);
      try {
        const before = view.host.innerHTML;
        act(() => {
          if (order === "A-before-B") {
            aOnB();
            bOnA();
          } else {
            bOnA();
            aOnB();
          }
        });
        expect(view.host.innerHTML).toBe(before);
        expect(escapeAOnB.preventDefault).not.toHaveBeenCalled();
        expect(escapeBOnA.preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();

        act(() => clickEvent(b.toggle).dispatch(bToggle));
        expect(b.toggle).toHaveAttribute("aria-expanded", "true");
        const currentLink = reactHandler<ClickHandler<HTMLAnchorElement>>(b.links[0], "onClick");
        act(() => clickEvent(b.links[0]).dispatch(currentLink));
        expect(b.toggle).toHaveAttribute("aria-expanded", "false");

        fireEvent.click(b.toggle);
        b.links[0].focus();
        focus.mockClear();
        const currentEscape = reactHandler<KeyHandler>(b.nav, "onKeyDown");
        const currentEvent = escapeEvent(b.nav, b.links[0]);
        act(() => currentEvent.dispatch(currentEscape));
        expect(currentEvent.preventDefault).toHaveBeenCalledOnce();
        expect(b.toggle).toHaveFocus();
      } finally {
        a.nav.remove();
      }
    },
  );

  it.each(["retired-first", "current-first"] as const)(
    "keeps reused equal-looking DOM bound to the current callbacks with %s invocation",
    (order) => {
      const equalA = documentA.map((heading) => ({ ...heading }));
      const equalB = documentA.map((heading) => ({ ...heading }));
      const view = directRoot(<DirectReaderBoundary currentHeadings={equalA} />);
      const a = directControls(view.host);
      const aToggle = reactHandler<ClickHandler<HTMLButtonElement>>(a.toggle, "onClick");
      const aLink = reactHandler<ClickHandler<HTMLAnchorElement>>(a.links[0], "onClick");
      const aEscape = reactHandler<KeyHandler>(a.nav, "onKeyDown");
      const retiredRefs = [
        reactHandler<RefCallback<Element>>(a.nav, "ref"),
        reactHandler<RefCallback<Element>>(a.toggle, "ref"),
        reactHandler<RefCallback<Element>>(a.list, "ref"),
        ...a.links.map((link) => reactHandler<RefCallback<Element>>(link, "ref")),
      ];

      act(() => view.root.render(<DirectReaderBoundary currentHeadings={equalB} boundary={1} />));
      const b = directControls(view.host);
      expect(b.nav).toBe(a.nav);
      expect(b.toggle).toBe(a.toggle);
      expect(b.list).toBe(a.list);
      expect(b.links).toEqual(a.links);
      const bToggle = reactHandler<ClickHandler<HTMLButtonElement>>(b.toggle, "onClick");
      const staleEscape = escapeEvent(b.nav, b.links[0]);
      const staleWork = () => {
        clickEvent(b.toggle).dispatch(aToggle);
        clickEvent(b.links[0]).dispatch(aLink);
        staleEscape.dispatch(aEscape);
      };

      act(() => {
        if (order === "retired-first") staleWork();
        else clickEvent(b.toggle).dispatch(bToggle);
      });
      if (order === "retired-first") expect(b.toggle).toHaveAttribute("aria-expanded", "false");
      else expect(b.toggle).toHaveAttribute("aria-expanded", "true");
      expect(staleEscape.preventDefault).not.toHaveBeenCalled();

      act(() => retiredRefs.forEach((ref) => ref(null)));
      if (order === "retired-first") {
        act(() => clickEvent(b.toggle).dispatch(bToggle));
        expect(b.toggle).toHaveAttribute("aria-expanded", "true");
      } else {
        act(staleWork);
        expect(b.toggle).toHaveAttribute("aria-expanded", "true");
        const currentToggle = reactHandler<ClickHandler<HTMLButtonElement>>(b.toggle, "onClick");
        act(() => clickEvent(b.toggle).dispatch(currentToggle));
        expect(b.toggle).toHaveAttribute("aria-expanded", "false");
      }
    },
  );

  it("invalidates an in-place-mutated headings producer and publishes only frozen replacement values", () => {
    const mutable: TestHeading[] = documentA.map((heading) => ({ ...heading }));
    const view = directRoot(<DirectReaderBoundary currentHeadings={mutable} />);
    const a = directControls(view.host);
    const staleToggle = reactHandler<ClickHandler<HTMLButtonElement>>(a.toggle, "onClick");
    const staleLink = reactHandler<ClickHandler<HTMLAnchorElement>>(a.links[0], "onClick");
    const oldObserver = InstrumentedIntersectionObserver.instances[0];
    const oldHeading = document.getElementById("alpha");
    const staleObserver = oldObserver.capture([{ target: oldHeading!, isIntersecting: true }]);

    Object.assign(mutable[0], { id: "changed-alpha", level: 3, text: "Changed Alpha", top: 140 });
    Object.assign(mutable[1], { id: "changed-shared", level: 2, text: "Changed Shared", top: 260 });
    act(() => view.root.render(<DirectReaderBoundary currentHeadings={mutable} />));

    const b = directControls(view.host);
    expect(b.nav).toBe(a.nav);
    expect(b.toggle).toBe(a.toggle);
    expect(b.list).toBe(a.list);
    expect(b.links.map((link) => link.getAttribute("href"))).toEqual(["#changed-alpha", "#changed-shared"]);
    expect(b.links.map((link) => link.textContent)).toEqual(["Changed Alpha", "Changed Shared"]);
    expect(b.links[0]).toHaveClass("pl-5");
    expect(b.links[1]).toHaveClass("pl-2");
    expect(oldObserver.disconnect).toHaveBeenCalledOnce();
    expect(InstrumentedIntersectionObserver.instances).toHaveLength(2);

    const before = view.host.innerHTML;
    act(() => {
      clickEvent(b.toggle).dispatch(staleToggle);
      clickEvent(b.links[0]).dispatch(staleLink);
      staleObserver();
    });
    expect(view.host.innerHTML).toBe(before);

    fireEvent.click(b.toggle);
    expect(b.toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(b.links[0]);
    expect(b.toggle).toHaveAttribute("aria-expanded", "false");
    expect(InstrumentedIntersectionObserver.instances[1].disconnect).not.toHaveBeenCalled();
  });

  it("allows only one toggle, link, or Escape claim per publication and keeps the observer usable", () => {
    const view = directRoot(<DirectReaderBoundary currentHeadings={documentA} />);
    const observer = InstrumentedIntersectionObserver.instances[0];
    let controls = directControls(view.host);
    const toggleA = reactHandler<ClickHandler<HTMLButtonElement>>(controls.toggle, "onClick");
    const toggleEvent = clickEvent(controls.toggle);
    act(() => {
      toggleEvent.dispatch(toggleA, toggleA);
    });
    expect(controls.toggle).toHaveAttribute("aria-expanded", "true");
    act(() => toggleEvent.dispatch(toggleA));
    expect(controls.toggle).toHaveAttribute("aria-expanded", "true");

    const linkA = reactHandler<ClickHandler<HTMLAnchorElement>>(controls.links[0], "onClick");
    const linkEvent = clickEvent(controls.links[0]);
    act(() => {
      linkEvent.dispatch(linkA, linkA);
    });
    expect(controls.toggle).toHaveAttribute("aria-expanded", "false");
    expect(linkEvent.preventDefault).not.toHaveBeenCalled();

    fireEvent.click(controls.toggle);
    controls = directControls(view.host);
    controls.links[0].focus();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const escape = reactHandler<KeyHandler>(controls.nav, "onKeyDown");
    const firstEscape = escapeEvent(controls.nav, controls.links[0]);
    const competingEscape = escapeEvent(controls.nav, controls.links[0]);
    act(() => {
      firstEscape.dispatch(escape);
      competingEscape.dispatch(escape);
    });
    expect(firstEscape.preventDefault).toHaveBeenCalledOnce();
    expect(competingEscape.preventDefault).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
    expect(controls.toggle).toHaveFocus();

    expect(InstrumentedIntersectionObserver.instances).toEqual([observer]);
    expect(observer.disconnect).not.toHaveBeenCalled();
    observer.publish([{ target: document.getElementById("shared")!, isIntersecting: true }]);
    expect(directControls(view.host).links[1]).toHaveAttribute("aria-current", "location");
    expect(observer.disconnect).not.toHaveBeenCalled();
  });

  it("does not cancel Escape or focus from an unpublished descendant", () => {
    const view = directRoot(<DirectReaderBoundary currentHeadings={documentA} />);
    const controls = directControls(view.host);
    fireEvent.click(controls.toggle);
    controls.links[0].focus();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const escape = reactHandler<KeyHandler>(controls.nav, "onKeyDown");
    const icon = controls.toggle.querySelector("svg");
    if (!icon) throw new Error("The Contents icon was not rendered");
    const descendantEscape = escapeEvent(controls.nav, icon);

    act(() => descendantEscape.dispatch(escape));
    expect(descendantEscape.preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(controls.toggle).toHaveAttribute("aria-expanded", "true");
    expect(controls.links[0]).toHaveFocus();

    const currentEscape = escapeEvent(controls.nav, controls.links[0]);
    act(() => currentEscape.dispatch(escape));
    expect(currentEscape.preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(controls.toggle).toHaveFocus();
  });

  it.each(["replacement", "removal"] as const)(
    "retires callbacks and observers before a parent layout sees %s",
    (kind) => {
      const view = directRoot(<DirectReaderBoundary currentHeadings={documentA} />);
      const a = directControls(view.host);
      const staleToggle = reactHandler<ClickHandler<HTMLButtonElement>>(a.toggle, "onClick");
      const staleLink = reactHandler<ClickHandler<HTMLAnchorElement>>(a.links[0], "onClick");
      const staleEscape = reactHandler<KeyHandler>(a.nav, "onKeyDown");
      const observer = InstrumentedIntersectionObserver.instances[0];
      const oldHeading = document.getElementById("alpha");
      const staleObserver = observer.capture([{ target: oldHeading!, isIntersecting: true }]);
      const preventions: ReturnType<typeof escapeEvent>[] = [];
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      let boundaryRan = false;

      act(() => {
        view.root.render(
          <DirectReaderBoundary
            currentHeadings={kind === "replacement" ? documentB : documentA}
            present={kind === "replacement"}
            boundary={1}
            onLayout={() => {
              boundaryRan = true;
              expect(observer.disconnect).toHaveBeenCalledOnce();
              const current = kind === "replacement" ? directControls(view.host) : a;
              const escapeProbe = escapeEvent(current.nav, current.links[0]);
              preventions.push(escapeProbe);
              clickEvent(current.toggle).dispatch(staleToggle);
              clickEvent(current.links[0]).dispatch(staleLink);
              escapeProbe.dispatch(staleEscape);
              staleObserver();
            }}
          />,
        );
      });

      expect(boundaryRan).toBe(true);
      expect(preventions[0].preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(observer.disconnect).toHaveBeenCalledOnce();
      if (kind === "replacement") {
        const b = directControls(view.host);
        expect(b.toggle).toHaveAttribute("aria-expanded", "false");
        expect(InstrumentedIntersectionObserver.instances).toHaveLength(2);
        fireEvent.click(b.toggle);
        expect(b.toggle).toHaveAttribute("aria-expanded", "true");
        expect(InstrumentedIntersectionObserver.instances[1].disconnect).not.toHaveBeenCalled();
      } else {
        expect(view.host).toBeEmptyDOMElement();
        expect(InstrumentedIntersectionObserver.instances).toHaveLength(1);
      }
    },
  );
});

      describe("ReaderToc direct-root StrictMode replay", () => {
        it("keeps toggle, link, Escape, and active-heading authority on the exact replay successor", () => {
          const captures: CapturedControls[] = [];
          let firstEvent: ReturnType<typeof clickEvent<HTMLAnchorElement>> | null = null;
          const oldShared = document.createElement("div");
          const onLayout = (capture: CapturedControls) => {
            captures.push(capture);
            if (captures.length !== 1) return;
            firstEvent = clickEvent(capture.links[0]);
            firstEvent.dispatch(capture.linkHandler);
          };
          const view = directRoot(
            <StrictMode>
              <StrictReaderBoundary currentHeadings={documentA} onLayout={onLayout} />
            </StrictMode>,
          );
          const controls = directControls(view.host);
          const firstObserver = InstrumentedIntersectionObserver.instances[0];
          const currentObserver = InstrumentedIntersectionObserver.instances.at(-1);
          const currentShared = document.getElementById("shared");
          expect(captures).toHaveLength(2);
          expect(captures[0].nav).toBe(captures[1].nav);
          expect(firstEvent).not.toBeNull();
          expect(firstEvent!.preventDefault).not.toHaveBeenCalled();
          expect(firstObserver.disconnect).toHaveBeenCalledOnce();
          expect(currentObserver).toBeDefined();
          expect(currentObserver).not.toBe(firstObserver);
          expect(currentObserver!.disconnect).not.toHaveBeenCalled();
          expect(currentShared).not.toBeNull();

          oldShared.id = "shared";
          const lateFirstUpdate = firstObserver.capture([{ target: oldShared, isIntersecting: true }]);
          currentObserver!.publish([{ target: currentShared!, isIntersecting: true }]);
          expect(controls.links[1]).toHaveAttribute("aria-current", "location");
          expect(controls.links[1]).toHaveClass("bg-accent-soft", "font-medium", "text-accent");
          act(lateFirstUpdate);
          expect(controls.links[1]).toHaveAttribute("aria-current", "location");

          act(() => firstEvent!.dispatch(captures[0].linkHandler));
          expect(controls.toggle).toHaveAttribute("aria-expanded", "false");

          fireEvent.click(controls.toggle);
          expect(controls.toggle).toHaveAttribute("aria-expanded", "true");
          const currentLink = reactHandler<ClickHandler<HTMLAnchorElement>>(controls.links[0], "onClick");
          const currentLinkEvent = clickEvent(controls.links[0]);
          act(() => currentLinkEvent.dispatch(currentLink));
          expect(currentLinkEvent.preventDefault).not.toHaveBeenCalled();
          expect(controls.toggle).toHaveAttribute("aria-expanded", "false");

          fireEvent.click(controls.toggle);
          controls.links[0].focus();
          fireEvent.keyDown(controls.links[0], { key: "Escape" });
          expect(controls.toggle).toHaveAttribute("aria-expanded", "false");
          expect(controls.toggle).toHaveFocus();
          expect(currentObserver!.disconnect).not.toHaveBeenCalled();
        });

        it("rejects strict stale/current crosses, partial late refs, forged events, and repeated keys", () => {
          const captures: CapturedControls[] = [];
          const onLayout = (capture: CapturedControls) => captures.push(capture);
          const view = directRoot(
            <StrictMode>
              <StrictReaderBoundary currentHeadings={documentA} onLayout={onLayout} />
            </StrictMode>,
          );
          expect(captures).toHaveLength(2);
          const stale = captures[0];
          let controls = directControls(view.host);
          const forgedPreventDefault = vi.fn();
          const forgedNative = {
            type: "click",
            button: 0,
            bubbles: true,
            cancelable: true,
            target: controls.toggle,
            view: window,
            composedPath: () => [controls.toggle, controls.nav, document, window],
            constructor: { name: "MouseEvent" },
          };
          const forgedReact = {
            type: "click",
            currentTarget: controls.toggle,
            target: controls.toggle,
            nativeEvent: forgedNative,
            preventDefault: forgedPreventDefault,
          } as unknown as ReactMouseEvent<HTMLButtonElement>;
          act(() => stale.toggleHandler(forgedReact));
          expect(forgedPreventDefault).not.toHaveBeenCalled();
          expect(controls.toggle).toHaveAttribute("aria-expanded", "false");

          const crossedTarget = clickEvent(controls.toggle, controls.links[0]);
          act(() => crossedTarget.dispatch(stale.toggleHandler));
          expect(controls.toggle).toHaveAttribute("aria-expanded", "false");

          const secondary = clickEvent(controls.toggle, controls.toggle, { button: 1 });
          act(() => secondary.dispatch(stale.toggleHandler));
          expect(controls.toggle).toHaveAttribute("aria-expanded", "false");

          act(() => {
            stale.refs[0](controls.nav);
            stale.refs[1](controls.toggle);
            stale.refs[0](null);
            stale.refs[1](null);
          });
          fireEvent.click(controls.toggle);
          expect(controls.toggle).toHaveAttribute("aria-expanded", "true");

          controls = directControls(view.host);
          controls.links[0].focus();
          const escape = reactHandler<KeyHandler>(controls.nav, "onKeyDown");
          const repeated = escapeEvent(controls.nav, controls.links[0], { repeat: true });
          act(() => repeated.dispatch(escape));
          expect(repeated.preventDefault).not.toHaveBeenCalled();
          expect(controls.toggle).toHaveAttribute("aria-expanded", "true");
          expect(controls.links[0]).toHaveFocus();

          const current = escapeEvent(controls.nav, controls.links[0]);
          act(() => current.dispatch(escape, escape));
          expect(current.preventDefault).toHaveBeenCalledOnce();
          expect(controls.toggle).toHaveAttribute("aria-expanded", "false");
          expect(controls.toggle).toHaveFocus();
        });

        it.each(["attribute-restore", "detach-reinsert", "reorder-restore"] as const)(
          "permanently retires a %s publication but accepts an exact later replay",
          (kind) => {
            const onLayout = () => {};
            const view = directRoot(
              <StrictMode>
                <StrictReaderBoundary currentHeadings={documentA} onLayout={onLayout} />
              </StrictMode>,
            );
            let controls = directControls(view.host);
            fireEvent.click(controls.toggle);
            const handler = reactHandler<ClickHandler<HTMLAnchorElement>>(controls.links[0], "onClick");
            const firstItem = controls.links[0].parentElement as HTMLLIElement;
            const secondItem = controls.links[1].parentElement as HTMLLIElement;
            if (kind === "attribute-restore") {
              controls.links[0].setAttribute("href", "#tampered");
              controls.links[0].setAttribute("href", "#alpha");
            } else if (kind === "detach-reinsert") {
              firstItem.remove();
              controls.list.insertBefore(firstItem, secondItem);
            } else {
              controls.list.insertBefore(secondItem, firstItem);
              controls.list.insertBefore(firstItem, secondItem);
            }

            const retiredEvent = clickEvent(controls.links[0]);
            act(() => retiredEvent.dispatch(handler));
            expect(retiredEvent.preventDefault).not.toHaveBeenCalled();
            expect(controls.toggle).toHaveAttribute("aria-expanded", "true");

            act(() => view.root.render(
              <StrictMode>
                <StrictReaderBoundary currentHeadings={documentA} onLayout={onLayout} />
              </StrictMode>,
            ));
            controls = directControls(view.host);
            const successor = reactHandler<ClickHandler<HTMLAnchorElement>>(controls.links[0], "onClick");
            const successorEvent = clickEvent(controls.links[0]);
            act(() => successorEvent.dispatch(successor));
            expect(successorEvent.preventDefault).not.toHaveBeenCalled();
            expect(controls.toggle).toHaveAttribute("aria-expanded", "false");
          },
        );

        it("retires heading observation across detach/restore history and republishes on a new visit", () => {
          const onLayout = () => {};
          const view = directRoot(
            <StrictMode>
              <StrictReaderBoundary currentHeadings={documentA} onLayout={onLayout} />
            </StrictMode>,
          );
          const controls = directControls(view.host);
          const observer = InstrumentedIntersectionObserver.instances.at(-1)!;
          const alpha = document.getElementById("alpha")!;
          const shared = document.getElementById("shared")!;
          const parent = shared.parentElement!;
          shared.remove();
          parent.append(shared);

          observer.publish([{ target: shared, isIntersecting: true }]);
          expect(observer.disconnect).toHaveBeenCalledOnce();
          expect(controls.links.every((link) => !link.hasAttribute("aria-current"))).toBe(true);
          expect(controls.links.every((link) => !link.classList.contains("bg-accent-soft"))).toBe(true);

          const nextVisit = documentA.map((heading) => ({ ...heading }));
          act(() => view.root.render(
            <StrictMode>
              <StrictReaderBoundary currentHeadings={nextVisit} onLayout={onLayout} />
            </StrictMode>,
          ));
          const successor = InstrumentedIntersectionObserver.instances.at(-1)!;
          expect(successor).not.toBe(observer);
          expect([...successor.observed]).toEqual([alpha, shared]);
          successor.publish([{ target: shared, isIntersecting: true }]);
          expect(directControls(view.host).links[1]).toHaveAttribute("aria-current", "location");
        });

        it.each(["heading-id", "duplicate-id", "missing-id"] as const)(
          "clears active styling when queued %s history retires during a parent replay",
          (kind) => {
            const currentHeadings = kind === "missing-id" ? documentWithMissing : documentA;
            const renderBoundary = (domKey: string, boundary: number) => (
              <StrictMode>
                <DirectReaderBoundary
                  currentHeadings={currentHeadings}
                  domKey={domKey}
                  boundary={boundary}
                  omitHeadingId={kind === "missing-id" ? "missing" : undefined}
                  includeIdDecoy={kind !== "heading-id"}
                />
              </StrictMode>
            );
            const view = directRoot(renderBoundary("active-a", 0));
            let controls = directControls(view.host);
            const observer = InstrumentedIntersectionObserver.instances.at(-1)!;
            const shared = document.getElementById("shared")!;

            observer.publish([{ target: shared, isIntersecting: true }]);
            expect(controls.links[1]).toHaveAttribute("aria-current", "location");
            if (kind === "heading-id") {
              shared.id = "shared-tampered";
              shared.id = "shared";
            } else {
              const decoy = view.host.querySelector<HTMLElement>(
                '[data-testid="reader-heading-id-decoy"]',
              )!;
              decoy.id = kind === "duplicate-id" ? "shared" : "missing";
              decoy.removeAttribute("id");
            }

            act(() => view.root.render(renderBoundary("active-a", 1)));
            controls = directControls(view.host);
            expect(observer.disconnect).toHaveBeenCalledOnce();
            expect(controls.links.every((link) => !link.hasAttribute("aria-current"))).toBe(true);
            expect(controls.links.every((link) => !link.classList.contains("bg-accent-soft"))).toBe(true);

            observer.publish([{ target: shared, isIntersecting: true }]);
            expect(controls.links.every((link) => !link.hasAttribute("aria-current"))).toBe(true);

            act(() => view.root.render(renderBoundary("active-b", 2)));
            controls = directControls(view.host);
            const freshObserver = InstrumentedIntersectionObserver.instances.at(-1)!;
            expect(freshObserver).not.toBe(observer);
            expect(freshObserver.connected).toBe(true);
            freshObserver.publish([{ target: shared, isIntersecting: true }]);
            expect(controls.links.filter((link) => link.getAttribute("aria-current") === "location"))
              .toEqual([controls.links[1]]);
          },
        );

        it.each(["missing-id-restore", "duplicate-id"] as const)(
          "permanently retires stale link and observer work after a %s mutation",
          (kind) => {
            const currentHeadings = kind === "missing-id-restore" ? documentWithMissing : documentA;
            const renderBoundary = (domKey: string) => (
              <StrictMode>
                <DirectReaderBoundary
                  currentHeadings={currentHeadings}
                  domKey={domKey}
                  omitHeadingId={kind === "missing-id-restore" ? "missing" : undefined}
                  includeIdDecoy
                />
              </StrictMode>
            );
            const view = directRoot(renderBoundary("id-a"));
            let controls = directControls(view.host);
            fireEvent.click(controls.toggle);
            expect(controls.toggle).toHaveAttribute("aria-expanded", "true");
            controls = directControls(view.host);
            const staleLink = reactHandler<ClickHandler<HTMLAnchorElement>>(controls.links[1], "onClick");
            const staleObserver = InstrumentedIntersectionObserver.instances.at(-1)!;
            const shared = document.getElementById("shared")!;
            const decoy = view.host.querySelector<HTMLElement>(
              '[data-testid="reader-heading-id-decoy"]',
            )!;

            decoy.id = kind === "missing-id-restore" ? "missing" : "shared";
            if (kind === "missing-id-restore") {
              decoy.removeAttribute("id");
            } else {
              expect(document.getElementById("shared")).toBe(decoy);
            }

            const staleEvent = clickEvent(controls.links[1]);
            act(() => staleEvent.dispatch(staleLink));
            expect(staleEvent.preventDefault).not.toHaveBeenCalled();
            expect(controls.toggle).toHaveAttribute("aria-expanded", "true");
            decoy.removeAttribute("id");

            staleObserver.publish([{ target: shared, isIntersecting: true }]);
            expect(staleObserver.disconnect).toHaveBeenCalledOnce();
            expect(controls.links.every((link) => !link.hasAttribute("aria-current"))).toBe(true);
            expect(controls.links.every((link) => !link.classList.contains("bg-accent-soft"))).toBe(true);

            act(() => view.root.render(renderBoundary("id-b")));
            controls = directControls(view.host);
            const freshObserver = InstrumentedIntersectionObserver.instances.at(-1)!;
            expect(freshObserver).not.toBe(staleObserver);
            expect(freshObserver.connected).toBe(true);
            freshObserver.publish([{ target: shared, isIntersecting: true }]);
            expect(controls.links[1]).toHaveAttribute("aria-current", "location");

            fireEvent.click(controls.toggle);
            expect(controls.toggle).toHaveAttribute("aria-expanded", "true");
            const freshLink = reactHandler<ClickHandler<HTMLAnchorElement>>(controls.links[1], "onClick");
            const freshEvent = clickEvent(controls.links[1]);
            act(() => freshEvent.dispatch(freshLink));
            expect(freshEvent.preventDefault).not.toHaveBeenCalled();
            expect(controls.toggle).toHaveAttribute("aria-expanded", "false");
          },
        );

        it("prevents only unsafe retired-anchor navigation and leaves the current publication usable", () => {
          const view = directRoot(<DirectReaderBoundary currentHeadings={documentA} domKey="a" />);
          const a = directControls(view.host);
          const staleLink = reactHandler<ClickHandler<HTMLAnchorElement>>(a.links[0], "onClick");
          act(() => view.root.render(<DirectReaderBoundary currentHeadings={documentB} domKey="b" />));
          const b = directControls(view.host);
          document.body.append(a.nav);
          try {
            const unsafe = clickEvent(a.links[0]);
            act(() => unsafe.dispatch(staleLink));
            expect(unsafe.preventDefault).toHaveBeenCalledOnce();
            expect(b.toggle).toHaveAttribute("aria-expanded", "false");

            fireEvent.click(b.toggle);
            expect(b.toggle).toHaveAttribute("aria-expanded", "true");
            const currentLink = reactHandler<ClickHandler<HTMLAnchorElement>>(b.links[0], "onClick");
            const current = clickEvent(b.links[0]);
            act(() => current.dispatch(currentLink));
            expect(current.preventDefault).not.toHaveBeenCalled();
            expect(b.toggle).toHaveAttribute("aria-expanded", "false");

            const tamperedHandler = reactHandler<ClickHandler<HTMLAnchorElement>>(b.links[0], "onClick");
            b.links[0].setAttribute("target", "_blank");
            const tampered = clickEvent(b.links[0]);
            act(() => tampered.dispatch(tamperedHandler));
            expect(tampered.preventDefault).toHaveBeenCalledOnce();
          } finally {
            a.nav.remove();
          }
        });
      });
