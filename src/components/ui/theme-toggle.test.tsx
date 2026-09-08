// @vitest-environment jsdom
import {
  useEffect,
  useLayoutEffect,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { act } from "@testing-library/react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, themeStore, type ThemePreference } from "@/lib/theme";
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

function reactProperty<T>(element: Element, name: string): T | undefined {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the theme control");
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  return props?.[name] as T | undefined;
}

function captureClick(element: Element): ThemeClick {
  const click = reactProperty<ThemeClick>(element, "onClick");
  if (typeof click !== "function") throw new Error("The theme control did not have an onClick handler");
  return click;
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
    expect(rows.map((row) => row.querySelector("svg")?.getAttribute("width"))).toEqual(["14", "14", "14"]);
  });

  it("cycles one current Toggle activation through every preference exactly once", () => {
    const { host } = renderDirect(<ThemeToggle />);
    const effects = trackThemeEffects();

    for (const preference of ["light", "dark", "system"] as const) {
      const button = toggle(host);
      const click = captureClick(button);
      act(() => click(clickEvent(button)));
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
    const selectLight = captureClick(light);
    const selectLightEvent = clickEvent(light);
    act(() => {
      selectLight(selectLightEvent);
      selectLight(selectLightEvent);
    });
    expect(consumer.preference).toBe("light");
    expect(option(host, "light")).toHaveAttribute("aria-checked", "true");
    expect(effectCounts(effects)).toMatchObject({ attribute: 1, emission: 1, storage: 1 });

    const currentLight = option(host, "light");
    const selectCurrentLight = captureClick(currentLight);
    const currentSetter = consumer.setPreference;
    act(() => {
      selectCurrentLight(clickEvent(currentLight));
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
    act(() => captureClick(system)(clickEvent(system)));
    expect(consumer.preference).toBe("system");
    expect(option(host, "system")).toHaveAttribute("aria-checked", "true");

    const dark = option(host, "dark");
    act(() => captureClick(dark)(clickEvent(dark)));
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
  ] as const)("rejects a %s Toggle source without work and keeps the exact control usable", (source) => {
    const { host } = renderDirect(
      <>
        <fieldset>
          <ThemeToggle />
        </fieldset>
        <ThemeToggle />
      </>,
    );
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
    const exactEvent = clickEvent(button, button.querySelector("svg"));
    act(() => click(exactEvent));
    expect(button.dataset.themePreference).toBe("light");
    expect(effectCounts(effects)).toMatchObject({ attribute: 1, emission: 1, storage: 1 });
    expect(exactEvent.preventDefault).not.toHaveBeenCalled();
    expect(exactEvent.stopPropagation).not.toHaveBeenCalled();
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

    const exactEvent = clickEvent(light, light.querySelector("svg"));
    act(() => {
      selectLight(exactEvent);
      selectLight(exactEvent);
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
    const current = captureClick(button);
    act(() => current(clickEvent(button)));
    expect(button.dataset.themePreference).toBe("light");
    expect(effectCounts(effects)).toMatchObject({ attribute: 1, emission: 1, storage: 1 });
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
    const staleIconRef = captureRef(previousIcon);
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
            const currentClick = captureClick(currentButton);
            const staleCallbacks = [
              () => staleClick(clickEvent(currentButton)),
              () => {
                staleButtonRef(currentButton);
                staleIconRef(currentIcon);
                staleIconRef(null);
                staleButtonRef(null);
              },
            ];
            expect(currentButton).toBe(previousButton);
            expect(currentIcon).toBe(previousIcon);
            expect(currentButton).toHaveClass("theme-b");
            expect(currentIcon).toHaveAttribute("width", "24");
            if (staleFirst) {
              staleEvidence = invokeStale(effects, view.host, staleCallbacks);
              currentClick(clickEvent(currentButton, currentIcon));
            } else {
              currentClick(clickEvent(currentButton, currentIcon));
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
      const currentEvent = clickEvent(currentButton, currentButton.querySelector("svg"));
      act(() => captureClick(currentButton)(currentEvent));
      expect(toggle(view.host).dataset.themePreference).toBe("light");
      expect(effectCounts(effects)).toMatchObject({ attribute: 1, emission: 1, storage: 1 });
      expect(focusOwner).toHaveFocus();

      act(() => staleRef(null));
      replacement.remove();
      focusOwner.remove();
    },
  );

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
      captureElementRef(staleToggleButton.querySelector("svg")!),
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
            currentToggle(clickEvent(currentButton));
          } else {
            currentToggle(clickEvent(currentButton));
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
      currentToggleButton.querySelector("svg")!,
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
    act(() => captureClick(dark)(clickEvent(dark)));
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
