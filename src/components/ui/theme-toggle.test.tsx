// @vitest-environment jsdom
import { useEffect, useLayoutEffect, type ReactNode } from "react";
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

function captureClick(element: Element): () => void {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the theme control");
  const props = (element as unknown as Record<string, { onClick?: () => void } | undefined>)[propsKey];
  if (!props?.onClick) throw new Error("The theme control did not have an onClick handler");
  return props.onClick;
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
  it("cycles one current Toggle activation through every preference exactly once", () => {
    const { host } = renderDirect(<ThemeToggle />);
    const effects = trackThemeEffects();

    for (const preference of ["light", "dark", "system"] as const) {
      const click = captureClick(toggle(host));
      act(() => click());
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
    const effects = trackThemeEffects();
    let disabledAtBoundary = false;
    let disabledEvidence!: StaleEvidence;
    const root = await act(async () => hydrateRoot(host, (
      <HydrationBoundary onLayout={() => {
        const button = toggle(host);
        disabledAtBoundary = button.disabled && button.getAttribute("aria-busy") === "true";
        disabledEvidence = invokeStale(effects, host, [captureClick(button)]);
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
    const selectLight = captureClick(option(host, "light"));
    act(() => {
      selectLight();
      selectLight();
    });
    expect(consumer.preference).toBe("light");
    expect(option(host, "light")).toHaveAttribute("aria-checked", "true");
    expect(effectCounts(effects)).toMatchObject({ attribute: 1, emission: 1, storage: 1 });

    const selectCurrentLight = captureClick(option(host, "light"));
    const currentSetter = consumer.setPreference;
    act(() => {
      selectCurrentLight();
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
    const staleToggle = captureClick(toggle(view.host));
    const stalePicker = captureClick(option(view.host, "dark"));
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
          const currentToggle = captureClick(toggle(view.host));
          const staleCallbacks = [
            staleToggle,
            stalePicker,
            () => staleSetter("dark"),
          ];
          passiveAtBoundary = passiveCleaned;
          if (staleFirst) {
            staleEvidence = invokeStale(effects, view.host, staleCallbacks);
            currentToggle();
          } else {
            currentToggle();
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

    act(() => captureClick(option(view.host, "dark"))());
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
      captureClick(toggle(view.host)),
      captureClick(option(view.host, "light")),
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
