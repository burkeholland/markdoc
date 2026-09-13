// @vitest-environment jsdom
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { act } from "@testing-library/react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  setThemePreference,
  themeStore,
  type ThemePreference,
} from "@/lib/theme";
import { ThemePicker, ThemeToggle, useTheme } from "./theme-toggle";

type ThemeSetter = (next: ThemePreference) => void;

interface ConsumerControl {
  preference: ThemePreference;
  setPreference: ThemeSetter;
}

interface DirectView {
  host: HTMLDivElement;
  root: Root;
}

interface EffectCounts {
  attribute: number;
  emission: number;
  focus: number;
  navigation: number;
  storage: number;
}

interface StaleEvidence extends EffectCounts {
  domMutations: number;
  focusPreserved: boolean;
  markupPreserved: boolean;
}

type ThemeClick = (event: ReactMouseEvent<HTMLButtonElement>) => void;
type ThemeKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
type ThemeGroupKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => void;
type CapturedClickEvent = ReactMouseEvent<HTMLButtonElement> & {
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
};

function createThemeEffects() {
  const emission = vi.fn();
  const unsubscribe = themeStore.subscribe(emission);
  const mutation = new MutationObserver(() => {});
  return {
    attribute: vi.spyOn(document.documentElement, "setAttribute"),
    emission,
    focus: vi.spyOn(HTMLElement.prototype, "focus"),
    mutation,
    open: vi.spyOn(window, "open").mockImplementation(() => null),
    pushState: vi.spyOn(window.history, "pushState"),
    replaceState: vi.spyOn(window.history, "replaceState"),
    storage: vi.spyOn(Storage.prototype, "setItem"),
    stop() {
      unsubscribe();
      mutation.disconnect();
    },
  };
}

type ThemeEffects = ReturnType<typeof createThemeEffects>;

const directViews: DirectView[] = [];
const activeEffects: ThemeEffects[] = [];

function renderDirect(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { host, root: createRoot(host) };
  directViews.push(view);
  act(() => view.root.render(node));
  return view;
}

function reactProperties(element: Element): Record<string, unknown> {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the theme control");
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  if (!props) throw new Error("React props were not available on the theme control");
  return props;
}

function reactPropsEntry(element: Element) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the theme control");
  const record = element as unknown as Record<string, Record<string, unknown> | undefined>;
  const props = record[propsKey];
  if (!props) throw new Error("React props were not available on the theme control");
  return { propsKey, record, props };
}

function reactProperty<T>(element: Element, name: string): T | undefined {
  return reactProperties(element)[name] as T | undefined;
}

function captureClick(element: Element): ThemeClick {
  const click = reactProperty<ThemeClick>(element, "onClick");
  if (typeof click !== "function") throw new Error("The theme control did not have an onClick handler");
  return click;
}

function captureKeyDown(element: Element): ThemeKeyDown {
  const keyDown = reactProperty<ThemeKeyDown>(element, "onKeyDown");
  if (typeof keyDown !== "function") throw new Error("The theme control did not have an onKeyDown handler");
  return keyDown;
}

function interceptKeyDownCapture(
  element: HTMLDivElement,
  invoke: (
    original: ThemeGroupKeyDown,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void,
) {
  const { propsKey, record, props } = reactPropsEntry(element);
  const original = props.onKeyDownCapture as ThemeGroupKeyDown | undefined;
  if (!original) throw new Error("The theme picker did not have an onKeyDownCapture handler");
  record[propsKey] = {
    ...props,
    onKeyDownCapture: (event: ReactKeyboardEvent<HTMLDivElement>) =>
      invoke(original, event),
  };
  return () => {
    record[propsKey] = props;
  };
}

function interceptKeyDown(
  element: HTMLButtonElement,
  invoke: (
    original: ThemeKeyDown,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void,
) {
  const { propsKey, record, props } = reactPropsEntry(element);
  const original = props.onKeyDown as ThemeKeyDown | undefined;
  if (!original) throw new Error("The theme option did not have an onKeyDown handler");
  record[propsKey] = {
    ...props,
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) =>
      invoke(original, event),
  };
  return () => {
    record[propsKey] = props;
  };
}

function installKeyDownCapture(
  element: HTMLButtonElement,
  handler: (event: ReactKeyboardEvent<HTMLButtonElement>) => void,
) {
  const { propsKey, record, props } = reactPropsEntry(element);
  record[propsKey] = { ...props, onKeyDownCapture: handler };
  return () => {
    record[propsKey] = props;
  };
}

function replacePublicEventValue(
  event: ReactKeyboardEvent<HTMLElement>,
  property: keyof ReactKeyboardEvent<HTMLElement>,
  value: unknown,
) {
  const descriptor = Object.getOwnPropertyDescriptor(event, property);
  if (!descriptor || !("value" in descriptor) || !descriptor.configurable) {
    throw new Error(`${String(property)} was not configurable public event data`);
  }
  Object.defineProperty(event, property, { ...descriptor, value });
}

type CompatibilityMode = "absent" | "replaced" | "non-function";

function customizeReactKeyWrapper(
  event: ReactKeyboardEvent<HTMLElement>,
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
  const compatibilityNames = [
    "_reactName",
    "persist",
    "isPersistent",
    "stopPropagation",
  ] as const;
  for (const name of compatibilityNames) {
    if (!Reflect.deleteProperty(event, name)) {
      throw new Error(`${name} was not removable public event data`);
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
  const ref = reactProperty<RefCallback<T>>(element, "ref");
  if (typeof ref !== "function") throw new Error("The theme control did not have a callback ref");
  return ref;
}

function captureElementRef<T extends Element>(element: T): (node: Element | null) => void {
  const ref = captureRef(element);
  return (node) => ref(node as T | null);
}

function clickEvent(
  currentTarget: EventTarget | null,
  target: EventTarget | null = currentTarget,
  nativeTarget: EventTarget | null = target,
  type = "click",
  nativeType = type,
): CapturedClickEvent {
  const ownerDocument = currentTarget instanceof Node
    ? currentTarget.ownerDocument ?? document
    : document;
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  const nativeEvent = new MouseEventConstructor(nativeType, { bubbles: true });
  Object.defineProperty(nativeEvent, "target", { configurable: true, value: nativeTarget });
  return {
    type,
    currentTarget,
    target,
    nativeEvent,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as CapturedClickEvent;
}

function primaryClickEvent(ownerDocument = document) {
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  return new MouseEventConstructor("click", {
    bubbles: true,
    button: 0,
    cancelable: true,
  });
}

function dispatchClick(target: Element, event = primaryClickEvent(target.ownerDocument)) {
  target.dispatchEvent(event);
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

function keyboardEvent(
  ownerDocument: Document,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
  trusted = true,
) {
  const KeyboardEventConstructor = ownerDocument.defaultView?.KeyboardEvent ?? KeyboardEvent;
  const event = new KeyboardEventConstructor("keydown", {
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

function retainedClick(element: HTMLButtonElement): () => void {
  const click = captureClick(element);
  const event = clickEvent(element);
  return () => click(event);
}

function ThemeConsumer({ capture }: { capture: (control: ConsumerControl) => void }) {
  const [preference, setPreference] = useTheme();
  capture({ preference, setPreference });
  return <output data-testid="theme-consumer">{preference}</output>;
}

function ThemeVisit({
  capture,
  onPassiveCleanup,
  visit,
}: {
  capture: (visit: string, control: ConsumerControl) => void;
  onPassiveCleanup: (visit: string) => void;
  visit: string;
}) {
  useEffect(() => () => onPassiveCleanup(visit), [onPassiveCleanup, visit]);
  return (
    <section data-visit={visit}>
      <ThemeToggle />
      <ThemePicker />
      <ThemeConsumer capture={(control) => capture(visit, control)} />
    </section>
  );
}

function ThemeBoundary({
  boundary = 0,
  capture,
  onLayout,
  onPassiveCleanup,
  show = true,
  visit,
}: {
  boundary?: number;
  capture: (visit: string, control: ConsumerControl) => void;
  onLayout?: () => void;
  onPassiveCleanup: (visit: string) => void;
  show?: boolean;
  visit: string;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onLayout?.();
  }, [boundary, onLayout]);
  return show
    ? <ThemeVisit key={visit} capture={capture} onPassiveCleanup={onPassiveCleanup} visit={visit} />
    : null;
}

function HydrationBoundary({ onLayout }: { onLayout: () => void }) {
  useLayoutEffect(onLayout, [onLayout]);
  return <ThemeToggle />;
}

function TogglePropsBoundary({
  boundary = 0,
  className,
  onLayout,
  size,
}: {
  boundary?: number;
  className?: string;
  onLayout?: () => void;
  size?: number;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onLayout?.();
  }, [boundary, className, onLayout, size]);
  return <ThemeToggle className={className} size={size} />;
}

function LayoutProbe({
  children,
  onLayout,
}: {
  children: ReactNode;
  onLayout: () => void;
}) {
  useLayoutEffect(onLayout, [onLayout]);
  return children;
}

function trackThemeEffects(): ThemeEffects {
  const effects = createThemeEffects();
  effects.mutation.observe(document, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  activeEffects.push(effects);
  return effects;
}

function effectCounts(effects: ThemeEffects): EffectCounts {
  return {
    attribute: effects.attribute.mock.calls.filter(([name]) => name === "data-theme").length,
    emission: effects.emission.mock.calls.length,
    focus: effects.focus.mock.calls.length,
    navigation:
      effects.open.mock.calls.length
      + effects.pushState.mock.calls.length
      + effects.replaceState.mock.calls.length,
    storage: effects.storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY).length,
  };
}

function invokeStale(
  effects: ThemeEffects,
  host: HTMLElement,
  callbacks: Array<() => void>,
): StaleEvidence {
  effects.mutation.takeRecords();
  const before = effectCounts(effects);
  const markup = host.innerHTML;
  const focused = document.activeElement;
  for (const callback of callbacks) callback();
  const after = effectCounts(effects);
  return {
    attribute: after.attribute - before.attribute,
    domMutations: effects.mutation.takeRecords().length,
    emission: after.emission - before.emission,
    focus: after.focus - before.focus,
    focusPreserved: document.activeElement === focused,
    markupPreserved: host.innerHTML === markup,
    navigation: after.navigation - before.navigation,
    storage: after.storage - before.storage,
  };
}

function expectNoStaleEffects(evidence: StaleEvidence) {
  expect(evidence).toEqual({
    attribute: 0,
    domMutations: 0,
    emission: 0,
    focus: 0,
    focusPreserved: true,
    markupPreserved: true,
    navigation: 0,
    storage: 0,
  });
}

function toggle(host: ParentNode) {
  const element = host.querySelector('[data-testid="theme-toggle"]');
  if (!element) throw new Error("ThemeToggle was not rendered");
  return element as HTMLButtonElement;
}

function picker(host: ParentNode) {
  const element = host.querySelector('[data-testid="theme-picker"]');
  if (!element) throw new Error("ThemePicker was not rendered");
  return element as HTMLDivElement;
}

function option(host: ParentNode, preference: ThemePreference) {
  const element = host.querySelector(`[data-testid="theme-option-${preference}"]`);
  if (!element) throw new Error(`ThemePicker option ${preference} was not rendered`);
  return element as HTMLButtonElement;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  while (directViews.length) {
    const view = directViews.pop()!;
    act(() => view.root.unmount());
    view.host.remove();
  }
  while (activeEffects.length) activeEffects.pop()!.stop();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "matchMedia");
});

describe("mounted theme controls", () => {
  it("preserves the compact and picker labels, title, icons, classes, order, and selected state", () => {
    const { host } = renderDirect(
      <>
        <ThemeToggle className="theme-extra" size={22} />
        <ThemePicker />
      </>,
    );
    const button = toggle(host);
    const toggleIcon = button.querySelector("svg");
    const root = picker(host);
    const rows = [...root.children] as HTMLButtonElement[];

    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button).toHaveAttribute("aria-label", "Theme: System");
    expect(button).toHaveAttribute("title", "Theme: System (click to switch)");
    expect(button).toHaveAttribute("class", "icon-btn theme-extra");
    expect(button).toHaveAttribute("data-theme-preference", "system");
    expect(toggleIcon).toHaveAttribute("width", "22");
    expect(toggleIcon).toHaveAttribute("height", "22");
    expect(toggleIcon).toHaveClass("lucide-monitor");
    expect(root).toHaveAttribute("role", "radiogroup");
    expect(root).toHaveAttribute("aria-label", "Theme");
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      "theme-option-system",
      "theme-option-light",
      "theme-option-dark",
    ]);
    expect(rows.map((row) => row.textContent?.trim())).toEqual(["System", "Light", "Dark"]);
    expect(rows.map((row) => row.getAttribute("role"))).toEqual(["radio", "radio", "radio"]);
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);
    expect(rows.map((row) => row.querySelector("svg")?.getAttribute("width"))).toEqual(["14", "14", "14"]);
  });

  it.each([
    ["ArrowRight", "system", "light"],
    ["ArrowDown", "light", "dark"],
    ["ArrowLeft", "dark", "light"],
    ["ArrowUp", "light", "system"],
    ["ArrowRight", "dark", "system"],
    ["ArrowLeft", "system", "dark"],
    ["Home", "dark", "system"],
    ["End", "system", "dark"],
  ] as const)(
    "moves a direct Strict Mode picker once with %s from %s to %s without scrolling",
    (key, initial, destination) => {
      if (initial !== "system") localStorage.setItem(THEME_STORAGE_KEY, initial);
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const { host } = renderDirect(
        <StrictMode>
          <ThemePicker />
        </StrictMode>,
      );
      const storage = vi.spyOn(Storage.prototype, "setItem");
      const source = option(host, initial);
      const destinationBeforeKey = option(host, destination);
      const publicFocus = vi.fn();
      Object.defineProperty(destinationBeforeKey, "focus", {
        configurable: true,
        value: publicFocus,
      });
      const beforeScroll = [window.scrollX, window.scrollY];
      expect(
        (["system", "light", "dark"] as const).map((value) => option(host, value).tabIndex),
      ).toEqual(
        (["system", "light", "dark"] as const).map((value) => value === initial ? 0 : -1),
      );
      source.focus();
      focus.mockClear();

      let event!: KeyboardEvent;
      act(() => {
        event = dispatchKey(source, key);
      });

      const selected = option(host, destination);
      expect(event.defaultPrevented).toBe(true);
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(destination);
      expect(selected).toHaveAttribute("aria-checked", "true");
      expect(selected).toHaveFocus();
      expect(
        (["system", "light", "dark"] as const).map((value) => option(host, value).tabIndex),
      ).toEqual(
        (["system", "light", "dark"] as const).map((value) => value === destination ? 0 : -1),
      );
      expect(storage.mock.calls.filter(([storageKey]) => storageKey === THEME_STORAGE_KEY))
        .toEqual([[THEME_STORAGE_KEY, destination]]);
      expect(focus).toHaveBeenCalledTimes(1);
      expect(focus.mock.instances[0]).toBe(selected);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(publicFocus).not.toHaveBeenCalled();
      expect([window.scrollX, window.scrollY]).toEqual(beforeScroll);
    },
  );

  it.each([
    ["ArrowRight", "Numpad6", "system", "light"],
    ["ArrowDown", "Numpad2", "light", "dark"],
    ["ArrowLeft", "Numpad4", "system", "dark"],
    ["ArrowUp", "Numpad8", "dark", "light"],
    ["Home", "Numpad7", "dark", "system"],
    ["End", "Numpad1", "system", "dark"],
  ] as const)(
    "uses semantic %s with unrestricted %s code and numeric-keypad location",
    (key, code, initial, destination) => {
      if (initial !== "system") localStorage.setItem(THEME_STORAGE_KEY, initial);
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const { host } = renderDirect(
        <StrictMode>
          <ThemePicker />
        </StrictMode>,
      );
      const storage = vi.spyOn(Storage.prototype, "setItem");
      const source = option(host, initial);
      source.focus();
      focus.mockClear();

      const event = dispatchKey(source, key, { code, location: 3 });

      expect(event.defaultPrevented).toBe(true);
      expect(option(host, destination)).toHaveFocus();
      expect(storage.mock.calls.filter(([storageKey]) => storageKey === THEME_STORAGE_KEY))
        .toEqual([[THEME_STORAGE_KEY, destination]]);
      expect(focus).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    },
  );

  it.each(["absent", "replaced", "non-function"] as const)(
    "pairs independent public wrappers with %s private compatibility fields",
    (compatibility) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const { host } = renderDirect(
        <StrictMode>
          <ThemePicker />
        </StrictMode>,
      );
      const storage = vi.spyOn(Storage.prototype, "setItem");
      const root = picker(host);
      const system = option(host, "system");
      const capturePreventReceivers: object[] = [];
      const bubblePreventReceivers: object[] = [];
      const captureDefaultReceivers: object[] = [];
      const bubbleDefaultReceivers: object[] = [];
      const capturePropagationReceivers: object[] = [];
      const bubblePropagationReceivers: object[] = [];
      let captureWrapper: ReactKeyboardEvent<HTMLElement> | null = null;
      let bubbleWrapper: ReactKeyboardEvent<HTMLElement> | null = null;
      const restoreCapture = interceptKeyDownCapture(root, (original, event) => {
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
      });
      const restoreBubble = interceptKeyDown(system, (original, event) => {
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
      });
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      const pushState = vi.spyOn(window.history, "pushState");
      const replaceState = vi.spyOn(window.history, "replaceState");
      const setTimeout = vi.spyOn(window, "setTimeout");
      const setInterval = vi.spyOn(window, "setInterval");
      const fetch = vi.spyOn(globalThis, "fetch");
      root.scrollLeft = 11;
      root.scrollTop = 7;
      const scroll = [window.scrollX, window.scrollY, root.scrollLeft, root.scrollTop];
      system.focus();
      focus.mockClear();
      try {
        const event = dispatchKey(system, "ArrowRight");

        expect(event.defaultPrevented).toBe(true);
        expect(captureWrapper).not.toBeNull();
        expect(bubbleWrapper).not.toBeNull();
        expect(captureWrapper).not.toBe(bubbleWrapper);
        expect(Object.getPrototypeOf(captureWrapper)).not.toBe(Object.getPrototypeOf(bubbleWrapper));
        expect(capturePreventReceivers).toEqual([]);
        expect(bubblePreventReceivers).toEqual([bubbleWrapper]);
        expect(captureDefaultReceivers.every((receiver) => receiver === captureWrapper)).toBe(true);
        expect(bubbleDefaultReceivers.every((receiver) => receiver === bubbleWrapper)).toBe(true);
        expect(capturePropagationReceivers.every((receiver) => receiver === captureWrapper))
          .toBe(true);
        expect(bubblePropagationReceivers.every((receiver) => receiver === bubbleWrapper))
          .toBe(true);
        expect(option(host, "light")).toHaveFocus();
        expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY))
          .toEqual([[THEME_STORAGE_KEY, "light"]]);
        expect(focus).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect([window.scrollX, window.scrollY, root.scrollLeft, root.scrollTop]).toEqual(scroll);
        expect(open).not.toHaveBeenCalled();
        expect(pushState).not.toHaveBeenCalled();
        expect(replaceState).not.toHaveBeenCalled();
        expect(setTimeout.mock.calls.filter(([, delay]) => delay !== 0)).toHaveLength(0);
        expect(setInterval).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        restoreBubble();
        restoreCapture();
      }
    },
  );

  it("rejects retained required-method drift and admits a clean successor", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { host } = renderDirect(
      <StrictMode>
        <ThemePicker />
      </StrictMode>,
    );
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const root = picker(host);
    const system = option(host, "system");
    const restore = interceptKeyDownCapture(root, (original, event) => {
      original(event);
      event.preventDefault = vi.fn();
    });
    system.focus();
    focus.mockClear();

    const rejected = dispatchKey(system, "ArrowRight");
    restore();

    expect(rejected.defaultPrevented).toBe(false);
    expect(system).toHaveFocus();
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY)).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();

    const accepted = dispatchKey(system, "ArrowRight");
    expect(accepted.defaultPrevented).toBe(true);
    expect(option(host, "light")).toHaveFocus();
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY))
      .toEqual([[THEME_STORAGE_KEY, "light"]]);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("rejects system-theme drift between capture and bubble and then recovers", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { host } = renderDirect(
      <StrictMode>
        <ThemePicker />
      </StrictMode>,
    );
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const system = option(host, "system");
    const originalMatchMedia = window.matchMedia;
    const restore = interceptKeyDown(system, (original, event) => {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: vi.fn(() => ({
          matches: true,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      });
      original(event);
    });
    system.focus();
    focus.mockClear();

    const rejected = dispatchKey(system, "ArrowRight");
    restore();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });

    expect(rejected.defaultPrevented).toBe(false);
    expect(system).toHaveFocus();
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY)).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();

    const accepted = dispatchKey(system, "ArrowRight");
    expect(accepted.defaultPrevented).toBe(true);
    expect(option(host, "light")).toHaveFocus();
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY))
      .toEqual([[THEME_STORAGE_KEY, "light"]]);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("claims movement before public prevention reentry", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { host } = renderDirect(
      <StrictMode>
        <ThemePicker />
      </StrictMode>,
    );
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const system = option(host, "system");
    let reentered = false;
    const restore = interceptKeyDown(system, (original, event) => {
      const publicPreventDefault = event.preventDefault;
      event.preventDefault = function preventWithReentry(this: typeof event) {
        if (!reentered) {
          reentered = true;
          system.dispatchEvent(keyboardEvent(document, "ArrowRight"));
        }
        Reflect.apply(publicPreventDefault, this, []);
      };
      original(event);
    });
    system.focus();
    focus.mockClear();
    try {
      const event = dispatchKey(system, "ArrowRight");

      expect(event.defaultPrevented).toBe(true);
      expect(reentered).toBe(true);
      expect(option(host, "light")).toHaveFocus();
      expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY))
        .toEqual([[THEME_STORAGE_KEY, "light"]]);
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it("retains each exact native pair across nested capture microtask checkpoints", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { host } = renderDirect(
      <StrictMode>
        <ThemePicker />
      </StrictMode>,
    );
    const root = picker(host);
    const ownerWindow = root.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("The theme picker did not have an owner Window");
    const checkpoints: number[] = [];
    vi.spyOn(ownerWindow, "queueMicrotask").mockImplementation((callback: VoidFunction) => {
      checkpoints.push(checkpoints.length + 1);
      callback();
    });
    const system = option(host, "system");
    const restore = installKeyDownCapture(system, () => {
      const checkpoint = (remaining: number) => {
        if (remaining < 1) return;
        ownerWindow.queueMicrotask(() => checkpoint(remaining - 1));
      };
      checkpoint(2);
    });
    try {
      system.focus();
      focus.mockClear();

      const event = dispatchKey(system, "ArrowRight");

      expect(checkpoints).toHaveLength(2);
      expect(event.defaultPrevented).toBe(true);
      expect(option(host, "light")).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      restore();
    }
  });

  it("accepts exact public owner Window views and rejects a structural lookalike", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { host } = renderDirect(
      <StrictMode>
        <ThemePicker />
      </StrictMode>,
    );
    const root = picker(host);
    const system = option(host, "system");
    const ownerWindow = system.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("The theme picker did not have an owner Window");
    system.focus();
    focus.mockClear();

    const restoreLookalike = interceptKeyDownCapture(root, (original, event) => {
      replacePublicEventValue(event, "view", Object.create(ownerWindow));
      original(event);
    });
    const rejected = dispatchKey(system, "ArrowRight");
    restoreLookalike();
    expect(rejected.defaultPrevented).toBe(false);
    expect(system).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();

    const setOwnerWindow = (event: ReactKeyboardEvent<HTMLElement>) => {
      replacePublicEventValue(event, "view", ownerWindow);
    };
    const restoreCapture = interceptKeyDownCapture(root, (original, event) => {
      setOwnerWindow(event);
      original(event);
    });
    const restoreBubble = interceptKeyDown(system, (original, event) => {
      setOwnerWindow(event);
      original(event);
    });
    try {
      const accepted = dispatchKey(system, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(option(host, "light")).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      restoreBubble();
      restoreCapture();
    }
  });

  it.each(["Tab", "Enter", " "] as const)(
    "leaves native %s behavior unprevented and unselected",
    (key) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const { host } = renderDirect(
        <StrictMode>
          <ThemePicker />
        </StrictMode>,
      );
      const storage = vi.spyOn(Storage.prototype, "setItem");
      const system = option(host, "system");
      system.focus();
      focus.mockClear();

      const event = dispatchKey(system, key);

      expect(event.defaultPrevented).toBe(false);
      expect(system).toHaveAttribute("aria-checked", "true");
      expect(system).toHaveFocus();
      expect(storage.mock.calls.filter(([storageKey]) => storageKey === THEME_STORAGE_KEY))
        .toHaveLength(0);
      expect(focus).not.toHaveBeenCalled();
    },
  );

  it("keeps native Picker clicks compatible while moving the single tab stop", () => {
    const { host } = renderDirect(
      <StrictMode>
        <ThemePicker />
      </StrictMode>,
    );
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const light = option(host, "light");
    const event = primaryClickEvent();

    act(() => dispatchClick(light.querySelector("svg") ?? light, event));

    expect(event.defaultPrevented).toBe(false);
    expect(option(host, "light")).toHaveAttribute("aria-checked", "true");
    expect(
      (["system", "light", "dark"] as const).map((value) => option(host, value).tabIndex),
    ).toEqual([-1, 0, -1]);
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY))
      .toEqual([[THEME_STORAGE_KEY, "light"]]);
  });

  it.each([
    ["Home", "system"],
    ["End", "dark"],
  ] as const)("leaves an already-selected %s destination inert", (key, preference) => {
    if (preference !== "system") localStorage.setItem(THEME_STORAGE_KEY, preference);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { host } = renderDirect(
      <StrictMode>
        <ThemePicker />
      </StrictMode>,
    );
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const source = option(host, preference);
    source.focus();
    focus.mockClear();

    const event = dispatchKey(source, key);

    expect(event.defaultPrevented).toBe(false);
    expect(storage.mock.calls.filter(([storageKey]) => storageKey === THEME_STORAGE_KEY))
      .toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();
    expect(source).toHaveAttribute("aria-checked", "true");
    expect(source.tabIndex).toBe(0);
  });

  it("requires public bubble prevention to cancel the exact native event before selection", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { host } = renderDirect(
      <StrictMode>
        <ThemePicker />
      </StrictMode>,
    );
    const system = option(host, "system");
    system.focus();
    focus.mockClear();
    const event = keyboardEvent(document, "ArrowRight");
    const nativePreventDefault = Event.prototype.preventDefault;
    const publicPreventDefault = vi.fn(function preventDefault(this: Event) {
      nativePreventDefault.call(this);
    });
    Object.defineProperty(event, "preventDefault", {
      configurable: true,
      value: publicPreventDefault,
    });

    act(() => {
      system.dispatchEvent(event);
    });

    expect(option(host, "light")).toHaveAttribute("aria-checked", "true");
    expect(option(host, "light")).toHaveFocus();
    expect(event.defaultPrevented).toBe(true);
    expect(publicPreventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("rejects an untrusted key without consuming a clean successor", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { host } = renderDirect(
      <StrictMode>
        <ThemePicker />
      </StrictMode>,
    );
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const system = option(host, "system");
    system.focus();
    focus.mockClear();
    const untrusted = keyboardEvent(document, "ArrowRight", {}, false);

    act(() => {
      system.dispatchEvent(untrusted);
    });

    expect(untrusted.defaultPrevented).toBe(false);
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY)).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();

    const accepted = dispatchKey(system, "ArrowRight");
    expect(accepted.defaultPrevented).toBe(true);
    expect(option(host, "light")).toHaveFocus();
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY))
      .toEqual([[THEME_STORAGE_KEY, "light"]]);
    expect(focus).toHaveBeenCalledOnce();
  });

  it.each([
    ["canceled", { canceled: true }],
    ["Alt-modified", { altKey: true }],
    ["Control-modified", { ctrlKey: true }],
    ["Meta-modified", { metaKey: true }],
    ["Shift-modified", { shiftKey: true }],
    ["repeating", { repeat: true }],
    ["composing", { isComposing: true }],
    ["non-bubbling", { bubbles: false }],
    ["non-cancelable", { cancelable: false }],
  ] as const)("rejects a %s key before theme or focus work and remains usable", (_name, setup) => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { host } = renderDirect(
      <StrictMode>
        <ThemePicker />
      </StrictMode>,
    );
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const system = option(host, "system");
    system.focus();
    focus.mockClear();
    const { canceled, ...init } = setup as KeyboardEventInit & { canceled?: boolean };
    const event = keyboardEvent(document, "ArrowRight", init);
    if (canceled) event.preventDefault();

    act(() => {
      system.dispatchEvent(event);
    });

    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY)).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();
    if (!canceled) expect(event.defaultPrevented).toBe(false);

    act(() => dispatchKey(system, "ArrowRight"));
    expect(option(host, "light")).toHaveAttribute("aria-checked", "true");
    expect(option(host, "light")).toHaveFocus();
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY))
      .toEqual([[THEME_STORAGE_KEY, "light"]]);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("rejects forged and foreign-realm key events before accepting one native owner-realm key", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { host } = renderDirect(
      <StrictMode>
        <ThemePicker />
      </StrictMode>,
    );
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const system = option(host, "system");
    const handler = captureKeyDown(system);
    system.focus();
    focus.mockClear();
    const nativeEvent = keyboardEvent(document, "ArrowRight");
    const forged = {
      type: "keydown",
      currentTarget: system,
      target: system,
      nativeEvent,
    } as unknown as ReactKeyboardEvent<HTMLButtonElement>;
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignEvent = keyboardEvent(frame.contentDocument!, "ArrowRight");

    act(() => {
      handler(forged);
      system.dispatchEvent(new Event("keydown", { bubbles: true, cancelable: true }));
      system.dispatchEvent(foreignEvent);
    });

    expect(nativeEvent.defaultPrevented).toBe(false);
    expect(foreignEvent.defaultPrevented).toBe(false);
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY)).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();

    act(() => dispatchKey(system, "ArrowRight"));
    expect(option(host, "light")).toHaveAttribute("aria-checked", "true");
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY))
      .toEqual([[THEME_STORAGE_KEY, "light"]]);
    expect(focus).toHaveBeenCalledTimes(1);
    frame.remove();
  });

  it("claims a Picker publication, action, React event, and native key only once", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { host } = renderDirect(
      <StrictMode>
        <ThemePicker />
      </StrictMode>,
    );
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const system = option(host, "system");
    system.focus();
    focus.mockClear();
    const event = keyboardEvent(document, "ArrowRight");

    act(() => {
      system.dispatchEvent(event);
      option(host, "light").dispatchEvent(event);
    });

    expect(option(host, "light")).toHaveAttribute("aria-checked", "true");
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY))
      .toEqual([[THEME_STORAGE_KEY, "light"]]);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("rejects unchecked and wrong-picker sources without poisoning the exact checked row", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const crossed = { handler: undefined as ThemeKeyDown | undefined };
    let intercept = false;
    const { host } = renderDirect(
      <StrictMode>
        <div onKeyDownCapture={(event) => {
          if (!intercept || !crossed.handler) return;
          crossed.handler(event as unknown as ReactKeyboardEvent<HTMLButtonElement>);
          event.stopPropagation();
        }}>
          <ThemePicker />
          <ThemePicker />
        </div>
      </StrictMode>,
    );
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const roots = [...host.querySelectorAll<HTMLDivElement>('[data-testid="theme-picker"]')];
    const firstSystem = option(roots[0], "system");
    const firstLight = option(roots[0], "light");
    const secondSystem = option(roots[1], "system");
    crossed.handler = captureKeyDown(firstSystem);
    firstLight.focus();
    focus.mockClear();

    act(() => {
      dispatchKey(firstSystem, "ArrowRight");
      dispatchKey(firstLight, "ArrowRight");
    });
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY)).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();

    intercept = true;
    secondSystem.focus();
    focus.mockClear();
    act(() => dispatchKey(secondSystem, "ArrowRight"));
    intercept = false;
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY)).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();

    firstSystem.focus();
    focus.mockClear();
    act(() => dispatchKey(firstSystem, "ArrowRight"));
    expect(option(roots[0], "light")).toHaveAttribute("aria-checked", "true");
    expect(option(roots[1], "light")).toHaveAttribute("aria-checked", "true");
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY))
      .toEqual([[THEME_STORAGE_KEY, "light"]]);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it.each([
    "detached and reinserted",
    "reordered and restored",
    "replaced and restored",
    "attribute changed and restored",
  ] as const)(
    "retires a Picker whose DOM was %s and accepts a distinct clean successor",
    (mutation) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const controls = (visit: string) => (
        <StrictMode>
          <section key={visit}>
            <ThemePicker />
          </section>
        </StrictMode>
      );
      const view = renderDirect(controls("a"));
      const storage = vi.spyOn(Storage.prototype, "setItem");
      const root = picker(view.host);
      const system = option(root, "system");
      const light = option(root, "light");
      const dark = option(root, "dark");
      if (mutation === "detached and reinserted") {
        const parent = root.parentNode!;
        const nextSibling = root.nextSibling;
        root.remove();
        parent.insertBefore(root, nextSibling);
      } else if (mutation === "reordered and restored") {
        root.insertBefore(dark, system);
        root.append(dark);
      } else if (mutation === "replaced and restored") {
        const replacement = system.cloneNode(true) as HTMLButtonElement;
        system.replaceWith(replacement);
        replacement.replaceWith(system);
      } else {
        system.setAttribute("aria-checked", "false");
        system.setAttribute("aria-checked", "true");
      }
      system.focus();
      focus.mockClear();
      let rejected!: KeyboardEvent;

      act(() => {
        rejected = dispatchKey(system, "ArrowRight");
      });

      expect(rejected.defaultPrevented).toBe(false);
      expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY)).toHaveLength(0);
      expect(focus).not.toHaveBeenCalled();
      expect(light).toHaveAttribute("aria-checked", "false");

      act(() => view.root.render(controls("b")));
      const currentSystem = option(view.host, "system");
      currentSystem.focus();
      focus.mockClear();
      act(() => dispatchKey(currentSystem, "ArrowRight"));
      expect(option(view.host, "light")).toHaveAttribute("aria-checked", "true");
      expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY))
        .toEqual([[THEME_STORAGE_KEY, "light"]]);
      expect(focus).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps an incomplete one-row Picker inert and requires a clean successor", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const controls = (visit: string) => (
      <StrictMode>
        <section key={visit}>
          <ThemePicker />
        </section>
      </StrictMode>
    );
    const view = renderDirect(controls("a"));
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const root = picker(view.host);
    const system = option(root, "system");
    const light = option(root, "light");
    const dark = option(root, "dark");
    light.remove();
    dark.remove();
    system.focus();
    focus.mockClear();

    const rejected = dispatchKey(system, "ArrowRight");

    expect(rejected.defaultPrevented).toBe(false);
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY)).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();
    root.append(light, dark);
    act(() => view.root.render(controls("b")));
    const currentSystem = option(view.host, "system");
    currentSystem.focus();
    focus.mockClear();
    act(() => dispatchKey(currentSystem, "ArrowRight"));
    expect(option(view.host, "light")).toHaveAttribute("aria-checked", "true");
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY))
      .toEqual([[THEME_STORAGE_KEY, "light"]]);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("rejects store and callback drift before prevention and keeps current authority usable", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const stale = { handler: undefined as ThemeKeyDown | undefined };
    let intercept = false;
    const { host } = renderDirect(
      <StrictMode>
        <div onKeyDownCapture={(event) => {
          if (!intercept || !stale.handler) return;
          stale.handler(event as unknown as ReactKeyboardEvent<HTMLButtonElement>);
          event.stopPropagation();
        }}>
          <ThemePicker />
        </div>
      </StrictMode>,
    );
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const system = option(host, "system");
    stale.handler = captureKeyDown(system);
    system.focus();
    focus.mockClear();
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    storage.mockClear();

    const storeDrift = dispatchKey(system, "ArrowRight");
    expect(storeDrift.defaultPrevented).toBe(false);
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY)).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();

    localStorage.setItem(THEME_STORAGE_KEY, "system");
    act(() => setThemePreference("dark"));
    storage.mockClear();
    const dark = option(host, "dark");
    intercept = true;
    dark.focus();
    focus.mockClear();
    const callbackDrift = dispatchKey(dark, "ArrowRight");
    intercept = false;
    expect(callbackDrift.defaultPrevented).toBe(false);
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY)).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();

    act(() => dispatchKey(dark, "ArrowRight"));
    expect(option(host, "system")).toHaveAttribute("aria-checked", "true");
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY))
      .toEqual([[THEME_STORAGE_KEY, "system"]]);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("retires a partial Strict Mode keyboard publication before its clean replay", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    directViews.push({ host, root });
    let retiredHandler: ThemeKeyDown | undefined;
    let intercept = false;
    act(() => {
      root.render(
        <StrictMode>
          <div onKeyDownCapture={(event) => {
            if (!intercept || !retiredHandler) return;
            retiredHandler(event as unknown as ReactKeyboardEvent<HTMLButtonElement>);
            event.stopPropagation();
          }}>
            <LayoutProbe onLayout={() => {
              retiredHandler ??= captureKeyDown(option(host, "system"));
            }}>
              <ThemePicker />
            </LayoutProbe>
          </div>
        </StrictMode>,
      );
    });
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const system = option(host, "system");
    const currentHandler = captureKeyDown(system);
    expect(retiredHandler).toBeDefined();
    expect(currentHandler).not.toBe(retiredHandler);
    intercept = true;
    system.focus();
    focus.mockClear();

    const staleEvent = dispatchKey(system, "ArrowRight");
    expect(staleEvent.defaultPrevented).toBe(false);
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY)).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();

    intercept = false;
    act(() => dispatchKey(system, "ArrowRight"));
    expect(option(host, "light")).toHaveAttribute("aria-checked", "true");
    expect(storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY))
      .toEqual([[THEME_STORAGE_KEY, "light"]]);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("cycles one current Toggle activation through every preference exactly once", () => {
    const { host } = renderDirect(<ThemeToggle />);
    const effects = trackThemeEffects();

    for (const preference of ["light", "dark", "system"] as const) {
      const button = toggle(host);
      act(() => dispatchClick(button.querySelector("svg") ?? button));
      expect(toggle(host).dataset.themePreference).toBe(preference);
    }

    expect(effectCounts(effects)).toMatchObject({
      attribute: 3,
      emission: 3,
      storage: 3,
    });
    expect(effects.storage.mock.calls.filter(([key]) => key === THEME_STORAGE_KEY).map(([, value]) => value))
      .toEqual(["light", "dark", "system"]);
  });

  it("keeps the attached Toggle callback inert while hydration still has it disabled", async () => {
    const host = document.createElement("div");
    host.innerHTML = renderToString(<HydrationBoundary onLayout={() => {}} />);
    document.body.append(host);
    const serverButton = toggle(host);
    const preHydrationReplacement = serverButton.cloneNode(true) as HTMLButtonElement;
    serverButton.replaceWith(preHydrationReplacement);
    const effects = trackThemeEffects();
    let disabledAtBoundary = false;
    let disabledEvidence!: StaleEvidence;
    const root = await act(async () => hydrateRoot(host, (
      <HydrationBoundary onLayout={() => {
        const button = toggle(host);
        disabledAtBoundary = button.disabled && button.getAttribute("aria-busy") === "true";
        disabledEvidence = invokeStale(effects, host, [retainedClick(button)]);
      }}
      />
    )));
    directViews.push({ host, root });

    expect(disabledAtBoundary).toBe(true);
    expectNoStaleEffects(disabledEvidence);
    expect(effectCounts(effects)).toMatchObject({
      attribute: 0,
      emission: 0,
      storage: 0,
    });
    expect(toggle(host)).toBe(preHydrationReplacement);
    expect(toggle(host)).toBeEnabled();
  });

  it.each([
    {
      initial: "system",
      kind: "toggle",
      name: "Toggle cycle",
      selections: ["light", "dark", "system"],
    },
    {
      initial: "dark",
      kind: "picker",
      name: "Picker System",
      selections: ["system"],
    },
    {
      initial: "system",
      kind: "picker",
      name: "Picker Light",
      selections: ["light"],
    },
    {
      initial: "system",
      kind: "picker",
      name: "Picker Dark",
      selections: ["dark"],
    },
  ] as const)(
    "keeps $name exact through direct Strict Mode replay, repetition, and reentry",
    ({ initial, kind, selections }) => {
      if (initial !== "system") localStorage.setItem(THEME_STORAGE_KEY, initial);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      directViews.push({ host, root });
      let retiredClick: ThemeClick | undefined;
      let retiredRefs: Array<(node: Element | null) => void> = [];
      const captureRetired = () => {
        if (retiredClick) return;
        const button = kind === "toggle"
          ? toggle(host)
          : option(host, selections[0]);
        retiredClick = captureClick(button);
        retiredRefs = kind === "toggle"
          ? [captureElementRef(button)]
          : [
              captureElementRef(picker(host)),
              ...(["system", "light", "dark"] as const).flatMap((preference) => {
                const row = option(host, preference);
                return [
                  captureElementRef(row),
                  captureElementRef(row.querySelector("svg")!),
                ];
              }),
            ];
      };
      act(() => root.render(
        <StrictMode>
          <LayoutProbe onLayout={captureRetired}>
            {kind === "toggle" ? <ThemeToggle /> : <ThemePicker />}
          </LayoutProbe>
        </StrictMode>,
      ));

      const firstButton = kind === "toggle"
        ? toggle(host)
        : option(host, selections[0]);
      const currentClick = captureClick(firstButton);
      expect(retiredClick).toBeDefined();
      expect(currentClick).not.toBe(retiredClick);
      const currentElements = kind === "toggle"
        ? [firstButton]
        : [
            picker(host),
            ...(["system", "light", "dark"] as const).flatMap((preference) => {
              const row = option(host, preference);
              return [row, row.querySelector("svg")!];
            }),
          ];
      const originalSetItem = Storage.prototype.setItem;
      const effects = trackThemeEffects();
      let reentered = false;
      effects.storage.mockImplementation(function setItem(this: Storage, key, value) {
        if (key === THEME_STORAGE_KEY && !reentered) {
          reentered = true;
          dispatchClick(firstButton.querySelector("svg") ?? firstButton);
          retiredClick?.(clickEvent(firstButton));
        }
        return originalSetItem.call(this, key, value);
      });
      const staleEvidence = invokeStale(effects, host, [
        () => retiredClick?.(clickEvent(firstButton)),
        () => {
          retiredRefs.forEach((ref, index) => ref(currentElements[index]));
          [...retiredRefs].reverse().forEach((ref) => ref(null));
        },
      ]);
      expectNoStaleEffects(staleEvidence);

      selections.forEach((selection) => {
        const button = kind === "toggle"
          ? toggle(host)
          : option(host, selection);
        const repeated = primaryClickEvent();
        act(() => {
          dispatchClick(button.querySelector("svg") ?? button, repeated);
          dispatchClick(button.querySelector("svg") ?? button, repeated);
        });
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(selection);
        if (kind === "toggle") {
          expect(toggle(host).dataset.themePreference).toBe(selection);
        } else {
          expect(option(host, selection)).toHaveAttribute("aria-checked", "true");
        }
      });
      expect(effectCounts(effects)).toMatchObject({
        attribute: selections.length,
        emission: selections.length,
        storage: selections.length,
      });
    },
  );

  it("accepts valid Picker and useTheme selections once and rejects repeated, selected, and invalid values", () => {
    let consumer!: ConsumerControl;
    const { host } = renderDirect(
      <>
        <ThemePicker />
        <ThemeConsumer capture={(control) => { consumer = control; }} />
      </>,
    );
    const effects = trackThemeEffects();

    expect(option(host, "system")).toHaveAttribute("role", "radio");
    expect(option(host, "system")).toHaveAttribute("aria-checked", "true");
    const light = option(host, "light");
    const selectLightEvent = primaryClickEvent();
    act(() => {
      dispatchClick(light.querySelector("svg") ?? light, selectLightEvent);
      dispatchClick(light.querySelector("svg") ?? light, selectLightEvent);
    });
    expect(consumer.preference).toBe("light");
    expect(option(host, "light")).toHaveAttribute("aria-checked", "true");
    expect(effectCounts(effects)).toMatchObject({ attribute: 1, emission: 1, storage: 1 });

    const currentLight = option(host, "light");
    const currentSetter = consumer.setPreference;
    act(() => {
      dispatchClick(currentLight);
      (currentSetter as (next: unknown) => void)("sepia");
      currentSetter("light");
    });
    expect(effectCounts(effects)).toMatchObject({ attribute: 1, emission: 1, storage: 1 });

    act(() => {
      currentSetter("dark");
      currentSetter("dark");
    });
    expect(consumer.preference).toBe("dark");
    expect(effectCounts(effects)).toMatchObject({ attribute: 2, emission: 2, storage: 2 });

    const system = option(host, "system");
    act(() => dispatchClick(system));
    expect(consumer.preference).toBe("system");
    expect(option(host, "system")).toHaveAttribute("aria-checked", "true");

    const dark = option(host, "dark");
    act(() => dispatchClick(dark));
    expect(consumer.preference).toBe("dark");
    expect(option(host, "dark")).toHaveAttribute("aria-checked", "true");
    expect(effectCounts(effects)).toMatchObject({ attribute: 4, emission: 4, storage: 4 });
  });

  it.each([
    "sibling",
    "foreign connected",
    "detached",
    "disabled",
    "disabled fieldset",
    "replacement",
    "outside target",
    "mismatched target",
    "wrong event type",
    "fabricated event",
  ] as const)("rejects a %s Toggle source without work and keeps later authority usable", (source) => {
    const controls = (visit: string) => (
      <section key={visit}>
        <fieldset>
          <ThemeToggle />
        </fieldset>
        <ThemeToggle />
      </section>
    );
    const view = renderDirect(controls("a"));
    const { host } = view;
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="theme-toggle"]')];
    const button = buttons[0];
    const sibling = buttons[1];
    const click = captureClick(button);
    const focusOwner = document.createElement("button");
    document.body.prepend(focusOwner);
    focusOwner.focus();
    const effects = trackThemeEffects();
    let cleanup = () => {};
    let restore = () => {};
    let event: CapturedClickEvent;

    if (source === "sibling") {
      event = clickEvent(sibling);
    } else if (source === "foreign connected") {
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const foreignButton = frame.contentDocument!.createElement("button");
      frame.contentDocument!.body.append(foreignButton);
      event = clickEvent(foreignButton);
      cleanup = () => frame.remove();
    } else if (source === "detached") {
      event = clickEvent(button.cloneNode(true));
    } else if (source === "disabled") {
      button.disabled = true;
      event = clickEvent(button);
      restore = () => {
        button.disabled = false;
      };
    } else if (source === "disabled fieldset") {
      const fieldset = button.closest("fieldset")!;
      fieldset.disabled = true;
      event = clickEvent(button);
      restore = () => {
        fieldset.disabled = false;
      };
    } else if (source === "replacement") {
      const replacement = button.cloneNode(true) as HTMLButtonElement;
      document.body.append(replacement);
      event = clickEvent(replacement);
      cleanup = () => replacement.remove();
    } else if (source === "outside target") {
      event = clickEvent(button, sibling);
    } else if (source === "mismatched target") {
      event = clickEvent(button, button, sibling);
    } else if (source === "wrong event type") {
      event = clickEvent(button, button, button, "click", "mousedown");
    } else {
      event = {
        type: "click",
        currentTarget: button,
        target: button,
        nativeEvent: { type: "click", target: button },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as CapturedClickEvent;
    }

    let evidence!: StaleEvidence;
    act(() => {
      evidence = invokeStale(effects, host, [() => click(event)]);
    });
    expectNoStaleEffects(evidence);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();

    restore();
    cleanup();
    effects.mutation.takeRecords();
    let currentButton = button;
    if (source === "disabled") {
      const retiredEvidence = invokeStale(effects, host, [
        () => dispatchClick(button.querySelector("svg") ?? button),
      ]);
      expectNoStaleEffects(retiredEvidence);
      act(() => view.root.render(controls("b")));
      currentButton = toggle(host);
    }
    const exactEvent = primaryClickEvent();
    act(() => dispatchClick(currentButton.querySelector("svg") ?? currentButton, exactEvent));
    expect(currentButton.dataset.themePreference).toBe("light");
    expect(effectCounts(effects)).toMatchObject({ attribute: 1, emission: 1, storage: 1 });
    expect(exactEvent.defaultPrevented).toBe(false);
    expect(focusOwner).toHaveFocus();
    focusOwner.remove();
  });

  it("rejects selected, sibling, and wrong-row Picker sources before accepting the exact row once", () => {
    const { host } = renderDirect(
      <>
        <ThemePicker />
        <ThemePicker />
      </>,
    );
    const roots = [...host.querySelectorAll<HTMLDivElement>('[data-testid="theme-picker"]')];
    const system = option(roots[0], "system");
    const light = option(roots[0], "light");
    const dark = option(roots[0], "dark");
    const siblingLight = option(roots[1], "light");
    const selectSystem = captureClick(system);
    const selectLight = captureClick(light);
    const siblingSelectLight = captureClick(siblingLight);
    const selectedEvent = clickEvent(system);
    const wrongRowEvent = clickEvent(dark);
    const crossedEvent = clickEvent(light);
    const effects = trackThemeEffects();
    let evidence!: StaleEvidence;

    act(() => {
      evidence = invokeStale(effects, host, [
        () => selectSystem(selectedEvent),
        () => selectLight(wrongRowEvent),
        () => siblingSelectLight(crossedEvent),
      ]);
    });
    expectNoStaleEffects(evidence);
    for (const event of [selectedEvent, wrongRowEvent, crossedEvent]) {
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }

    const exactEvent = primaryClickEvent();
    act(() => {
      dispatchClick(light.querySelector("svg") ?? light, exactEvent);
      dispatchClick(light.querySelector("svg") ?? light, exactEvent);
    });
    expect(option(roots[0], "light")).toHaveAttribute("aria-checked", "true");
    expect(option(roots[1], "light")).toHaveAttribute("aria-checked", "true");
    expect(effectCounts(effects)).toMatchObject({ attribute: 1, emission: 1, storage: 1 });
  });

  it("re-reads the store before claiming stale Toggle and Picker activations", () => {
    const { host } = renderDirect(
      <>
        <ThemeToggle />
        <ThemePicker />
      </>,
    );
    const button = toggle(host);
    const light = option(host, "light");
    const staleToggle = retainedClick(button);
    const stalePicker = retainedClick(light);
    const effects = trackThemeEffects();

    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    let evidence!: StaleEvidence;
    act(() => {
      evidence = invokeStale(effects, host, [staleToggle, stalePicker]);
    });
    expectNoStaleEffects(evidence);
    expect(button.dataset.themePreference).toBe("system");

    localStorage.removeItem(THEME_STORAGE_KEY);
    effects.attribute.mockClear();
    effects.emission.mockClear();
    effects.storage.mockClear();
    effects.mutation.takeRecords();
    act(() => dispatchClick(button));
    expect(button.dataset.themePreference).toBe("light");
    expect(effectCounts(effects)).toMatchObject({ attribute: 1, emission: 1, storage: 1 });
  });

  it("fails transient mutation, root detach, restored reorder, and partial ref replay closed without poisoning successors", () => {
    const controls = (visit: string) => (
      <section key={visit}>
        <ThemeToggle />
        <ThemePicker />
      </section>
    );
    const view = renderDirect(controls("a"));
    const staleToggle = toggle(view.host);
    const stalePicker = picker(view.host);
    const staleLight = option(stalePicker, "light");
    const staleToggleClick = captureClick(staleToggle);
    const staleLightClick = captureClick(staleLight);
    const staleToggleRef = captureElementRef(staleToggle);
    const parent = stalePicker.parentNode;
    if (!parent) throw new Error("ThemePicker did not have a committed parent");
    const nextSibling = stalePicker.nextSibling;
    const dark = option(stalePicker, "dark");
    const lightIcon = staleLight.querySelector("svg");
    if (!lightIcon) throw new Error("ThemePicker Light did not have an icon");
    const replacementIcon = lightIcon.cloneNode(true) as Element;
    const originalLabel = staleToggle.getAttribute("aria-label");

    staleToggle.setAttribute("aria-label", "Changed");
    if (originalLabel === null) staleToggle.removeAttribute("aria-label");
    else staleToggle.setAttribute("aria-label", originalLabel);
    stalePicker.remove();
    parent.insertBefore(stalePicker, nextSibling);
    stalePicker.insertBefore(dark, staleLight);
    stalePicker.insertBefore(staleLight, dark);
    lightIcon.replaceWith(replacementIcon);
    replacementIcon.replaceWith(lightIcon);
    staleToggleRef(null);
    staleToggleRef(staleToggle);

    const effects = trackThemeEffects();
    const retiredEvidence = invokeStale(effects, view.host, [
      () => dispatchClick(staleToggle),
      () => dispatchClick(staleLight),
      () => staleToggleClick(clickEvent(staleToggle)),
      () => staleLightClick(clickEvent(staleLight)),
    ]);
    expectNoStaleEffects(retiredEvidence);

    act(() => view.root.render(controls("b")));
    const currentToggle = toggle(view.host);
    const currentLight = option(view.host, "light");
    expect(captureClick(currentToggle)).not.toBe(staleToggleClick);
    expect(captureClick(currentLight)).not.toBe(staleLightClick);
    act(() => dispatchClick(currentToggle));
    expect(toggle(view.host).dataset.themePreference).toBe("light");
    const currentDark = option(view.host, "dark");
    act(() => dispatchClick(currentDark));
    expect(toggle(view.host).dataset.themePreference).toBe("dark");
    expect(effectCounts(effects)).toMatchObject({ attribute: 2, emission: 2, storage: 2 });
  });

  it.each([
    ["stale before current", true],
    ["current before stale", false],
  ])("keeps reused Toggle DOM owned by its size/class presentation: %s", (_name, staleFirst) => {
    const view = renderDirect(<TogglePropsBoundary className="theme-a" size={16} />);
    const previousButton = toggle(view.host);
    const previousIcon = previousButton.querySelector("svg")!;
    const staleClick = captureClick(previousButton);
    const staleButtonRef = captureRef(previousButton);
    const effects = trackThemeEffects();
    let staleEvidence!: StaleEvidence;
    let boundaryRan = false;

    act(() => {
      view.root.render(
        <TogglePropsBoundary
          boundary={1}
          className="theme-b"
          size={24}
          onLayout={() => {
            boundaryRan = true;
            const currentButton = toggle(view.host);
            const currentIcon = currentButton.querySelector("svg")!;
            const staleCallbacks = [
              () => staleClick(clickEvent(currentButton)),
              () => {
                staleButtonRef(currentButton);
                staleButtonRef(null);
              },
            ];
            expect(currentButton).toBe(previousButton);
            expect(currentIcon).toBe(previousIcon);
            expect(currentButton).toHaveClass("theme-b");
            expect(currentIcon).toHaveAttribute("width", "24");
            if (staleFirst) {
              staleEvidence = invokeStale(effects, view.host, staleCallbacks);
              dispatchClick(currentIcon);
            } else {
              dispatchClick(currentIcon);
              effects.mutation.takeRecords();
              staleEvidence = invokeStale(effects, view.host, staleCallbacks);
            }
          }}
        />,
      );
    });

    expect(boundaryRan).toBe(true);
    expectNoStaleEffects(staleEvidence);
    expect(toggle(view.host).dataset.themePreference).toBe("light");
    expect(effectCounts(effects)).toMatchObject({ attribute: 1, emission: 1, storage: 1 });
  });

  it.each(["Toggle control", "Picker root", "Picker row"] as const)(
    "retires an active presentation when its %s callback ref receives a replacement",
    (part) => {
      const view = renderDirect(
        <section key="a">
          <ThemeToggle />
          <ThemePicker />
        </section>,
      );
      const staleButton = part === "Toggle control" ? toggle(view.host) : option(view.host, "light");
      const staleClick = captureClick(staleButton);
      const refElement = part === "Toggle control"
        ? staleButton
        : part === "Picker root"
          ? picker(view.host)
          : staleButton;
      const staleRef = captureElementRef(refElement);
      const replacement = refElement.cloneNode(true) as Element;
      document.body.append(replacement);
      const focusOwner = document.createElement("button");
      document.body.prepend(focusOwner);
      focusOwner.focus();
      const effects = trackThemeEffects();

      act(() => staleRef(replacement));
      const staleEvent = clickEvent(staleButton);
      let evidence!: StaleEvidence;
      act(() => {
        evidence = invokeStale(effects, view.host, [
          () => staleClick(staleEvent),
          () => staleClick(clickEvent(
            replacement instanceof HTMLButtonElement ? replacement : staleButton,
          )),
        ]);
      });
      expectNoStaleEffects(evidence);
      expect(staleEvent.preventDefault).not.toHaveBeenCalled();

      act(() => {
        view.root.render(
          <section key="b">
            <ThemeToggle />
            <ThemePicker />
          </section>,
        );
      });
      const currentButton = part === "Toggle control" ? toggle(view.host) : option(view.host, "light");
      act(() => dispatchClick(currentButton.querySelector("svg") ?? currentButton));
      expect(toggle(view.host).dataset.themePreference).toBe("light");
      expect(effectCounts(effects)).toMatchObject({ attribute: 1, emission: 1, storage: 1 });
      expect(focusOwner).toHaveFocus();

      act(() => staleRef(null));
      replacement.remove();
      focusOwner.remove();
    },
  );

  it("keeps the exact successor usable through Strict Mode ref and layout replay", () => {
    const view = renderDirect(
      <StrictMode>
        <section key="a">
          <ThemeToggle />
          <ThemePicker />
        </section>
      </StrictMode>,
    );
    const staleToggleButton = toggle(view.host);
    const staleLightButton = option(view.host, "light");
    const staleToggle = captureClick(staleToggleButton);
    const staleLight = captureClick(staleLightButton);
    const staleRefs = [
      captureElementRef(staleToggleButton),
      captureElementRef(picker(view.host)),
      captureElementRef(staleLightButton),
      captureElementRef(staleLightButton.querySelector("svg")!),
    ];
    const effects = trackThemeEffects();

    act(() => {
      view.root.render(
        <StrictMode>
          <section key="b">
            <ThemeToggle />
            <ThemePicker />
          </section>
        </StrictMode>,
      );
    });
    const currentToggleButton = toggle(view.host);
    const currentLightButton = option(view.host, "light");
    const currentElements = [
      currentToggleButton,
      picker(view.host),
      currentLightButton,
      currentLightButton.querySelector("svg")!,
    ];
    let evidence!: StaleEvidence;
    act(() => {
      evidence = invokeStale(effects, view.host, [
        () => staleToggle(clickEvent(currentToggleButton)),
        () => staleLight(clickEvent(currentLightButton)),
        () => {
          staleRefs.forEach((ref, index) => ref(currentElements[index]));
          [...staleRefs].reverse().forEach((ref) => ref(null));
        },
      ]);
    });
    expectNoStaleEffects(evidence);

    const currentEvent = primaryClickEvent();
    act(() => {
      dispatchClick(currentLightButton.querySelector("svg") ?? currentLightButton, currentEvent);
      dispatchClick(currentLightButton.querySelector("svg") ?? currentLightButton, currentEvent);
    });
    expect(toggle(view.host).dataset.themePreference).toBe("light");
    expect(effectCounts(effects)).toMatchObject({ attribute: 1, emission: 1, storage: 1 });
  });

  it.each([
    ["stale before current", true],
    ["current before stale", false],
  ])("retires keyed equal-value visit A before visit B layout: %s", async (_name, staleFirst) => {
    let aConsumer!: ConsumerControl;
    let passiveCleaned = false;
    const capture = (visit: string, control: ConsumerControl) => {
      if (visit === "a") aConsumer = control;
    };
    const onPassiveCleanup = (visit: string) => {
      if (visit === "a") passiveCleaned = true;
    };
    const view = renderDirect(
      <ThemeBoundary
        capture={capture}
        onPassiveCleanup={onPassiveCleanup}
        visit="a"
      />,
    );
    const staleToggleButton = toggle(view.host);
    const stalePickerRoot = picker(view.host);
    const staleDarkButton = option(view.host, "dark");
    const staleToggleHandler = captureClick(staleToggleButton);
    const stalePickerHandler = captureClick(staleDarkButton);
    const staleToggle = () => staleToggleHandler(clickEvent(staleToggleButton));
    const stalePicker = () => stalePickerHandler(clickEvent(staleDarkButton));
    const staleRefs = [
      captureElementRef(staleToggleButton),
      captureElementRef(stalePickerRoot),
      ...(["system", "light", "dark"] as const).flatMap((preference) => {
        const button = option(stalePickerRoot, preference);
        const icon = button.querySelector("svg")!;
        return [
          captureElementRef(button),
          captureElementRef(icon),
        ];
      }),
    ];
    const staleSetter = aConsumer.setPreference;
    const focusOwner = document.createElement("button");
    document.body.prepend(focusOwner);
    focusOwner.focus();
    const effects = trackThemeEffects();
    let staleEvidence!: StaleEvidence;
    let passiveAtBoundary = true;
    let reachBoundary!: () => void;
    const atBoundary = new Promise<void>((resolve) => {
      reachBoundary = resolve;
    });

    view.root.render(
      <ThemeBoundary
        boundary={1}
        capture={capture}
        onLayout={() => {
          const currentButton = toggle(view.host);
          const currentToggle = captureClick(currentButton);
          const currentDark = option(view.host, "dark");
          const staleCallbacks = [
            staleToggle,
            stalePicker,
            () => staleToggleHandler(clickEvent(currentButton)),
            () => stalePickerHandler(clickEvent(currentDark)),
            () => currentToggle(clickEvent(staleToggleButton)),
            () => staleSetter("dark"),
          ];
          passiveAtBoundary = passiveCleaned;
          if (staleFirst) {
            staleEvidence = invokeStale(effects, view.host, staleCallbacks);
            dispatchClick(currentButton);
          } else {
            dispatchClick(currentButton);
            effects.mutation.takeRecords();
            staleEvidence = invokeStale(effects, view.host, staleCallbacks);
          }
          reachBoundary();
        }}
        onPassiveCleanup={onPassiveCleanup}
        visit="b"
      />,
    );
    await atBoundary;
    await act(async () => {});

    expect(passiveAtBoundary).toBe(false);
    expectNoStaleEffects(staleEvidence);
    expect(toggle(view.host).dataset.themePreference).toBe("light");
    expect(effectCounts(effects)).toMatchObject({ attribute: 1, emission: 1, storage: 1 });
    expect(focusOwner).toHaveFocus();

    const currentToggleButton = toggle(view.host);
    const currentPickerRoot = picker(view.host);
    const currentRefElements = [
      currentToggleButton,
      currentPickerRoot,
      ...(["system", "light", "dark"] as const).flatMap((preference) => {
        const button = option(currentPickerRoot, preference);
        return [button, button.querySelector("svg")!];
      }),
    ];
    const refEvidence = invokeStale(effects, view.host, [
      () => {
        staleRefs.forEach((ref, index) => ref(currentRefElements[index]));
        [...staleRefs].reverse().forEach((ref) => ref(null));
      },
    ]);
    expectNoStaleEffects(refEvidence);

    const dark = option(view.host, "dark");
    act(() => dispatchClick(dark));
    expect(toggle(view.host).dataset.themePreference).toBe("dark");
    expect(effectCounts(effects)).toMatchObject({ attribute: 2, emission: 2, storage: 2 });
    focusOwner.remove();
  });

  it("retires removed visit A before its parent layout boundary and passive cleanup", async () => {
    let aConsumer!: ConsumerControl;
    let passiveCleaned = false;
    const capture = (_visit: string, control: ConsumerControl) => {
      aConsumer = control;
    };
    const onPassiveCleanup = () => {
      passiveCleaned = true;
    };
    const view = renderDirect(
      <ThemeBoundary
        capture={capture}
        onPassiveCleanup={onPassiveCleanup}
        visit="a"
      />,
    );
    const staleCallbacks = [
      retainedClick(toggle(view.host)),
      retainedClick(option(view.host, "light")),
      () => aConsumer.setPreference("dark"),
    ];
    const focusOwner = document.createElement("button");
    document.body.prepend(focusOwner);
    focusOwner.focus();
    const effects = trackThemeEffects();
    let staleEvidence!: StaleEvidence;
    let passiveAtBoundary = true;
    let reachBoundary!: () => void;
    const atBoundary = new Promise<void>((resolve) => {
      reachBoundary = resolve;
    });

    view.root.render(
      <ThemeBoundary
        boundary={1}
        capture={capture}
        onLayout={() => {
          passiveAtBoundary = passiveCleaned;
          staleEvidence = invokeStale(effects, view.host, staleCallbacks);
          reachBoundary();
        }}
        onPassiveCleanup={onPassiveCleanup}
        show={false}
        visit="a"
      />,
    );
    await atBoundary;
    await act(async () => {});

    expect(passiveAtBoundary).toBe(false);
    expectNoStaleEffects(staleEvidence);
    expect(view.host).toBeEmptyDOMElement();
    expect(effectCounts(effects)).toMatchObject({ attribute: 0, emission: 0, storage: 0 });
    expect(focusOwner).toHaveFocus();
    focusOwner.remove();
  });
});
