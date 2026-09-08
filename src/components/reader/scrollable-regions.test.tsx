// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capturedLayoutCleanups = vi.hoisted(() => [] as Array<() => void>);
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useLayoutEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]) {
      react.useLayoutEffect(() => {
        const retire = effect();
        if (typeof retire === "function") capturedLayoutCleanups.push(retire);
        return retire;
      }, dependencies);
    },
  };
});

import { StrictMode, useLayoutEffect } from "react";
import { ReaderScrollableRegions } from "./scrollable-regions";

type RegionSpec = {
  id: string;
  tag?: "pre" | "table";
  clientWidth: number;
  scrollWidth: number;
  tabIndex?: string;
};

type TabIndexWrite = {
  target: Element;
  value: string | null;
};

class InstrumentedResizeObserver implements ResizeObserver {
  static instances: InstrumentedResizeObserver[] = [];
  static onDisconnect: ((observer: InstrumentedResizeObserver) => void) | null = null;
  static onObserve: ((observer: InstrumentedResizeObserver, target: Element) => void) | null = null;

  readonly observed: Element[] = [];
  connected = true;
  readonly observe = vi.fn((target: Element) => {
    this.observed.push(target);
    InstrumentedResizeObserver.onObserve?.(this, target);
  });
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn(() => {
    InstrumentedResizeObserver.onDisconnect?.(this);
    this.connected = false;
  });

  constructor(private readonly callback: ResizeObserverCallback) {
    InstrumentedResizeObserver.instances.push(this);
  }

  capture() {
    return () => this.callback([], this);
  }

  publish() {
    act(this.capture());
  }
}

class InstrumentedFonts {
  readonly callbacks: Array<() => void> = [];
  ready = this.createReady();

  private createReady() {
    return {
      then: (continuation: (fonts: FontFaceSet) => unknown) => {
        this.callbacks.push(() => continuation(document.fonts));
        return Promise.resolve(document.fonts);
      },
    } as Promise<FontFaceSet>;
  }

  replaceReady() {
    this.ready = this.createReady();
  }

  publish(index: number) {
    const callback = this.callbacks[index];
    if (!callback) throw new Error(`No font-ready continuation at index ${index}`);
    act(callback);
  }
}

function regionHtml(spec: RegionSpec): string {
  const attributes = [
    `data-region="${spec.id}"`,
    `data-client-width="${spec.clientWidth}"`,
    `data-scroll-width="${spec.scrollWidth}"`,
    spec.tabIndex === undefined ? "" : `tabindex="${spec.tabIndex}"`,
  ].filter(Boolean).join(" ");
  if (spec.tag === "table") {
    return `<table ${attributes}><tbody><tr><td>${spec.id}</td></tr></tbody></table>`;
  }
  return `<pre ${attributes}><code>${spec.id}</code></pre>`;
}

function bodyHtml(...regions: RegionSpec[]) {
  return regions.map(regionHtml).join("");
}

function DirectRegion({ spec }: { spec: RegionSpec }) {
  const props = {
    "data-region": spec.id,
    "data-client-width": spec.clientWidth,
    "data-scroll-width": spec.scrollWidth,
    tabIndex: spec.tabIndex === undefined ? undefined : Number(spec.tabIndex),
  };
  if (spec.tag === "table") {
    return (
      <table {...props}>
        <tbody><tr><td>{spec.id}</td></tr></tbody>
      </table>
    );
  }
  return <pre {...props}><code>{spec.id}</code></pre>;
}

function ReaderFixture({
  contentKey = "content-a",
  rootKey = "root-a",
  html,
  commit = 0,
  showRoot = true,
  showHelper = true,
  intervening = false,
  readerId = "reader-a",
  directRegions,
  onLayout,
}: {
  contentKey?: string;
  rootKey?: string;
  html: string;
  commit?: number;
  showRoot?: boolean;
  showHelper?: boolean;
  intervening?: boolean;
  readerId?: string;
  directRegions?: RegionSpec[];
  onLayout?: () => void;
}) {
  useLayoutEffect(() => {
    onLayout?.();
  });

  return (
    <>
      {showRoot && (
        <div
          key={rootKey}
          data-reader-overflow-root
          data-reader-id={readerId}
          data-commit={commit}
          {...(directRegions ? {} : { dangerouslySetInnerHTML: { __html: html } })}
        >
          {directRegions?.map((spec) => <DirectRegion key={spec.id} spec={spec} />)}
        </div>
      )}
      {intervening && <div data-intervening />}
      {showHelper && <ReaderScrollableRegions contentKey={contentKey} />}
    </>
  );
}

const nativeGetAttribute = Element.prototype.getAttribute;
const nativeSetAttribute = Element.prototype.setAttribute;
const nativeRemoveAttribute = Element.prototype.removeAttribute;
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
let fonts: InstrumentedFonts;
let geometryReads: Array<{ target: HTMLElement; name: "clientWidth" | "scrollWidth" }>;
let onGeometryRead: ((target: HTMLElement, name: "clientWidth" | "scrollWidth") => void) | null;
let tabIndexReads: Element[];
let tabIndexWrites: TabIndexWrite[];

function restoreProperty(target: object, name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, name, descriptor);
  else Reflect.deleteProperty(target, name);
}

function readerRoot(container: HTMLElement, id = "reader-a") {
  return container.querySelector<HTMLElement>(`[data-reader-id="${id}"]`)!;
}

function regions(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>("pre, table"));
}

function region(root: HTMLElement, id: string) {
  return root.querySelector<HTMLElement>(`[data-region="${id}"]`)!;
}

function setGeometry(target: HTMLElement, clientWidth: number, scrollWidth: number) {
  nativeSetAttribute.call(target, "data-client-width", String(clientWidth));
  nativeSetAttribute.call(target, "data-scroll-width", String(scrollWidth));
}

function setExternalTabIndex(target: HTMLElement, value: string | null) {
  if (value === null) nativeRemoveAttribute.call(target, "tabindex");
  else nativeSetAttribute.call(target, "tabindex", value);
}

function writesFor(target: Element) {
  return tabIndexWrites.filter((write) => write.target === target).map((write) => write.value);
}

beforeEach(() => {
  InstrumentedResizeObserver.instances = [];
  InstrumentedResizeObserver.onDisconnect = null;
  InstrumentedResizeObserver.onObserve = null;
  capturedLayoutCleanups.length = 0;
  fonts = new InstrumentedFonts();
  geometryReads = [];
  onGeometryRead = null;
  tabIndexReads = [];
  tabIndexWrites = [];
  vi.stubGlobal("ResizeObserver", InstrumentedResizeObserver);
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth: {
      configurable: true,
      get(this: HTMLElement) {
        geometryReads.push({ target: this, name: "clientWidth" });
        onGeometryRead?.(this, "clientWidth");
        return Number(nativeGetAttribute.call(this, "data-client-width") ?? 0);
      },
    },
    scrollWidth: {
      configurable: true,
      get(this: HTMLElement) {
        geometryReads.push({ target: this, name: "scrollWidth" });
        onGeometryRead?.(this, "scrollWidth");
        return Number(nativeGetAttribute.call(this, "data-scroll-width") ?? 0);
      },
    },
  });
  vi.spyOn(Element.prototype, "getAttribute").mockImplementation(function (this: Element, name) {
    if (name.toLowerCase() === "tabindex") tabIndexReads.push(this);
    return nativeGetAttribute.call(this, name);
  });
  vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (this: Element, name, value) {
    if (name.toLowerCase() === "tabindex") tabIndexWrites.push({ target: this, value });
    return nativeSetAttribute.call(this, name, value);
  });
  vi.spyOn(Element.prototype, "removeAttribute").mockImplementation(function (this: Element, name) {
    if (name.toLowerCase() === "tabindex") tabIndexWrites.push({ target: this, value: null });
    return nativeRemoveAttribute.call(this, name);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreProperty(HTMLElement.prototype, "clientWidth", originalClientWidth);
  restoreProperty(HTMLElement.prototype, "scrollWidth", originalScrollWidth);
  restoreProperty(document, "fonts", originalFonts);
});

describe("ReaderScrollableRegions exact content visits", () => {
  it("synchronizes exact initial regions, resizes and current font completion with transition-only writes", () => {
    const html = bodyHtml(
      { id: "overflow", clientWidth: 100, scrollWidth: 102 },
      { id: "fit", tag: "table", clientWidth: 100, scrollWidth: 101 },
    );
    const view = render(<ReaderFixture html={html} />);
    const root = readerRoot(view.container);
    const [overflow, fit] = regions(root);
    const observer = InstrumentedResizeObserver.instances[0];
    const marker = view.container.querySelector<HTMLElement>("[data-reader-overflow-marker]")!;

    expect(overflow).toHaveAttribute("tabindex", "0");
    expect(fit).not.toHaveAttribute("tabindex");
    expect(tabIndexWrites).toEqual([{ target: overflow, value: "0" }]);
    expect(observer.observed).toEqual([root, overflow, fit]);
    expect(observer.observe).toHaveBeenCalledTimes(3);
    expect(new Set(observer.observed).size).toBe(3);
    expect(fonts.callbacks).toHaveLength(1);
    expect(marker.previousElementSibling).toBe(root);
    expect(marker).toHaveAttribute("hidden");
    expect(marker).toHaveAttribute("aria-hidden", "true");
    expect(marker).not.toHaveAttribute("tabindex");
    expect(marker).toHaveTextContent("");
    expect(getComputedStyle(marker).display).toBe("none");

    observer.publish();
    expect(tabIndexWrites).toHaveLength(1);

    setGeometry(overflow, 100, 101);
    setGeometry(fit, 100, 102);
    observer.publish();
    expect(overflow).not.toHaveAttribute("tabindex");
    expect(fit).toHaveAttribute("tabindex", "0");
    expect(writesFor(overflow)).toEqual(["0", null]);
    expect(writesFor(fit)).toEqual(["0"]);

    observer.publish();
    expect(tabIndexWrites).toHaveLength(3);
    setGeometry(fit, 100, 101);
    fonts.publish(0);
    expect(fit).not.toHaveAttribute("tabindex");
    expect(writesFor(fit)).toEqual(["0", null]);
    expect(tabIndexReads.length).toBeGreaterThan(0);
  });

  it.each([
    { label: "absent", before: undefined, overflow: true, applied: "0", restored: null },
    { label: "zero", before: "0", overflow: false, applied: null, restored: "0" },
    { label: "negative", before: "-1", overflow: true, applied: "0", restored: "-1" },
    { label: "other", before: "reader-owned-elsewhere", overflow: false, applied: null, restored: "reader-owned-elsewhere" },
  ])("restores a preexisting $label value exactly once when its write is still owned", ({ before, overflow, applied, restored }) => {
    const html = bodyHtml({
      id: "target",
      clientWidth: 100,
      scrollWidth: overflow ? 102 : 101,
      tabIndex: before,
    });
    const view = render(<ReaderFixture html={html} />);
    const target = region(readerRoot(view.container), "target");
    const observer = InstrumentedResizeObserver.instances[0];

    expect(target.getAttribute("tabindex")).toBe(applied);
    expect(writesFor(target)).toEqual([applied]);
    view.rerender(<ReaderFixture html={html} showHelper={false} />);

    expect(target.getAttribute("tabindex")).toBe(restored);
    expect(writesFor(target)).toEqual([applied, restored]);
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it.each([
    { label: "absent fitting", tabIndex: undefined, scrollWidth: 101, expected: null },
    { label: "zero overflowing", tabIndex: "0", scrollWidth: 102, expected: "0" },
  ])("does not write an unchanged $label value during sync or retirement", ({ tabIndex, scrollWidth, expected }) => {
    const view = render(
      <ReaderFixture html={bodyHtml({ id: "target", clientWidth: 100, scrollWidth, tabIndex })} />,
    );
    const target = region(readerRoot(view.container), "target");
    const observer = InstrumentedResizeObserver.instances[0];

    observer.publish();
    fonts.publish(0);
    expect(target.getAttribute("tabindex")).toBe(expected);
    expect(writesFor(target)).toEqual([]);
    view.unmount();
    expect(target.getAttribute("tabindex")).toBe(expected);
    expect(writesFor(target)).toEqual([]);
  });

  it("leaves an external attribute change made after the visit's write untouched", () => {
    const view = render(
      <ReaderFixture html={bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 102 })} />,
    );
    const target = region(readerRoot(view.container), "target");
    expect(writesFor(target)).toEqual(["0"]);

    setExternalTabIndex(target, "-1");
    view.unmount();

    expect(target).toHaveAttribute("tabindex", "-1");
    expect(writesFor(target)).toEqual(["0"]);
  });

  it.each([
    {
      label: "same-key root identity replacement",
      nextRootKey: "root-b",
      nextHtml: bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 102 }),
      nextContentKey: "content-a",
      rootReused: false,
      regionsReused: false,
      directRegions: undefined,
    },
    {
      label: "same-key ordered-region identity replacement",
      nextRootKey: "root-a",
      nextHtml: bodyHtml(
        { id: "second", tag: "table", clientWidth: 100, scrollWidth: 102 },
        { id: "target", clientWidth: 100, scrollWidth: 102 },
      ),
      nextContentKey: "content-a",
      rootReused: true,
      regionsReused: false,
      directRegions: undefined,
    },
    {
      label: "content-key replacement with reused nodes",
      nextRootKey: "root-a",
      nextHtml: bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 102 }),
      nextContentKey: "content-b",
      rootReused: true,
      regionsReused: true,
      directRegions: [{ id: "target", clientWidth: 100, scrollWidth: 102 }],
    },
    {
      label: "equal render with reused nodes",
      nextRootKey: "root-a",
      nextHtml: bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 102 }),
      nextContentKey: "content-a",
      rootReused: true,
      regionsReused: true,
      directRegions: [{ id: "target", clientWidth: 100, scrollWidth: 102 }],
    },
  ])("retires the old observer before the parent layout boundary for $label", ({
    nextRootKey,
    nextHtml,
    nextContentKey,
    rootReused,
    regionsReused,
    directRegions,
  }) => {
    const initialHtml = bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 102 });
    const initialDirectRegions = directRegions ? [{ id: "target", clientWidth: 100, scrollWidth: 102 }] : undefined;
    const view = render(<ReaderFixture html={initialHtml} directRegions={initialDirectRegions} />);
    const oldRoot = readerRoot(view.container);
    const oldRegions = regions(oldRoot);
    const oldObserver = InstrumentedResizeObserver.instances[0];
    const staleResize = oldObserver.capture();
    const staleFonts = fonts.callbacks[0];
    const oldRetire = capturedLayoutCleanups[0];
    let disconnectedAtBoundary = false;
    let staleMutations = -1;
    let lateCleanupMutations = -1;

    view.rerender(
      <ReaderFixture
        html={nextHtml}
        rootKey={nextRootKey}
        contentKey={nextContentKey}
        commit={1}
        directRegions={directRegions}
        onLayout={() => {
          disconnectedAtBoundary = !oldObserver.connected && oldObserver.disconnect.mock.calls.length === 1;
          const beforeStale = tabIndexWrites.length;
          staleResize();
          staleFonts();
          staleMutations = tabIndexWrites.length - beforeStale;
          const beforeLateCleanup = tabIndexWrites.length;
          oldRetire();
          oldRetire();
          lateCleanupMutations = tabIndexWrites.length - beforeLateCleanup;
        }}
      />,
    );

    const currentRoot = readerRoot(view.container);
    const currentRegions = regions(currentRoot);
    const currentObserver = InstrumentedResizeObserver.instances[1];
    expect(disconnectedAtBoundary).toBe(true);
    expect(staleMutations).toBe(0);
    expect(lateCleanupMutations).toBe(0);
    expect(currentRoot === oldRoot).toBe(rootReused);
    expect(currentRegions.length > 0 && currentRegions[0] === oldRegions[0]).toBe(regionsReused);
    expect(currentObserver).not.toBe(oldObserver);
    expect(currentObserver.observed).toEqual([currentRoot, ...currentRegions]);
    expect(currentObserver.observe).toHaveBeenCalledTimes(currentRegions.length + 1);
    expect(currentRegions.every((target) => target.getAttribute("tabindex") === "0")).toBe(true);
    expect(oldObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(currentObserver.disconnect).not.toHaveBeenCalled();

    view.unmount();
    expect(oldObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(currentObserver.disconnect).toHaveBeenCalledTimes(1);
  });

  it("recognizes a same-key ordered-region replacement by identity on the next commit", () => {
    const html = bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 102 });
    const view = render(<ReaderFixture html={html} />);
    const root = readerRoot(view.container);
    const oldRegion = region(root, "target");
    const oldObserver = InstrumentedResizeObserver.instances[0];
    const staleResize = oldObserver.capture();

    root.innerHTML = html;
    const replacement = region(root, "target");
    expect(replacement).not.toBe(oldRegion);
    tabIndexWrites.length = 0;
    staleResize();
    expect(tabIndexWrites).toHaveLength(0);
    expect(replacement).not.toHaveAttribute("tabindex");

    view.rerender(<ReaderFixture html={html} commit={1} />);
    const currentObserver = InstrumentedResizeObserver.instances[1];
    const committed = region(root, "target");
    expect(currentObserver.observed).toEqual([root, committed]);
    expect(committed).toHaveAttribute("tabindex", "0");
    expect(writesFor(committed)).toEqual(["0"]);
    expect(oldObserver.disconnect).toHaveBeenCalledTimes(1);
  });

  it("retires on helper removal before the parent layout probe and creates no observer without an exact root", () => {
    const html = bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 102 });
    const view = render(<ReaderFixture html={html} />);
    const root = readerRoot(view.container);
    const target = region(root, "target");
    const oldObserver = InstrumentedResizeObserver.instances[0];
    const staleResize = oldObserver.capture();
    const staleFonts = fonts.callbacks[0];
    let retiredAtBoundary = false;
    let staleMutations = -1;

    view.rerender(
      <ReaderFixture
        html={html}
        showHelper={false}
        commit={1}
        onLayout={() => {
          retiredAtBoundary = !oldObserver.connected && oldObserver.disconnect.mock.calls.length === 1;
          const before = tabIndexWrites.length;
          staleResize();
          staleFonts();
          staleMutations = tabIndexWrites.length - before;
        }}
      />,
    );
    expect(retiredAtBoundary).toBe(true);
    expect(staleMutations).toBe(0);
    expect(target).not.toHaveAttribute("tabindex");
    expect(oldObserver.disconnect).toHaveBeenCalledTimes(1);

    view.rerender(<ReaderFixture html={html} showRoot={false} commit={2} />);
    const marker = view.container.querySelector<HTMLElement>("[data-reader-overflow-marker]")!;
    expect(marker).toHaveAttribute("hidden");
    expect(InstrumentedResizeObserver.instances).toHaveLength(1);
    expect(fonts.callbacks).toHaveLength(1);

    view.rerender(<ReaderFixture html={html} intervening commit={3} />);
    expect(InstrumentedResizeObserver.instances).toHaveLength(1);
    view.unmount();
    expect(oldObserver.disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps two parallel helpers bound only to their exact preceding reader bodies", () => {
    const view = render(
      <>
        <ReaderFixture
          readerId="reader-a"
          html={bodyHtml({ id: "a", clientWidth: 100, scrollWidth: 102 })}
        />
        <ReaderFixture
          readerId="reader-b"
          html={bodyHtml({ id: "b", tag: "table", clientWidth: 100, scrollWidth: 101 })}
        />
      </>,
    );
    const rootA = readerRoot(view.container, "reader-a");
    const rootB = readerRoot(view.container, "reader-b");
    const regionA = region(rootA, "a");
    const regionB = region(rootB, "b");
    const [observerA, observerB] = InstrumentedResizeObserver.instances;

    expect(observerA.observed).toEqual([rootA, regionA]);
    expect(observerB.observed).toEqual([rootB, regionB]);
    expect(regionA).toHaveAttribute("tabindex", "0");
    expect(regionB).not.toHaveAttribute("tabindex");
    expect(view.container.querySelectorAll("[data-reader-overflow-marker]")).toHaveLength(2);

    setGeometry(regionB, 100, 102);
    observerB.publish();
    expect(regionB).toHaveAttribute("tabindex", "0");
    expect(writesFor(regionA)).toEqual(["0"]);
    expect(writesFor(regionB)).toEqual(["0"]);
  });

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "keeps current reused nodes usable with observer and font callbacks in %s order",
    (order) => {
      const html = bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 101 });
      const directRegions = [{ id: "target", clientWidth: 100, scrollWidth: 101 }];
      const view = render(<ReaderFixture html={html} directRegions={directRegions} />);
      const root = readerRoot(view.container);
      const target = region(root, "target");
      const oldObserver = InstrumentedResizeObserver.instances[0];
      const staleResize = oldObserver.capture();
      const staleFonts = fonts.callbacks[0];

      view.rerender(<ReaderFixture html={html} contentKey="content-b" commit={1} directRegions={directRegions} />);
      const currentObserver = InstrumentedResizeObserver.instances[1];
      const currentResize = currentObserver.capture();
      const currentFonts = fonts.callbacks[1];
      expect(region(readerRoot(view.container), "target")).toBe(target);
      setGeometry(target, 100, 102);
      tabIndexWrites.length = 0;

      const stale = () => {
        staleResize();
        staleFonts();
      };
      const current = () => {
        currentResize();
        currentFonts();
      };
      if (order === "stale-before-current") {
        stale();
        current();
      } else {
        current();
        stale();
      }

      expect(target).toHaveAttribute("tabindex", "0");
      expect(writesFor(target)).toEqual(["0"]);
      expect(oldObserver.disconnect).toHaveBeenCalledTimes(1);
      expect(currentObserver.disconnect).not.toHaveBeenCalled();

      setGeometry(target, 100, 101);
      currentObserver.publish();
      expect(target).not.toHaveAttribute("tabindex");
      expect(writesFor(target)).toEqual(["0", null]);
      const afterCurrent = tabIndexWrites.length;
      stale();
      expect(tabIndexWrites).toHaveLength(afterCurrent);
    },
  );

  it("does not let a late A cleanup overwrite B on reused nodes and finalizes each observer once", () => {
    const html = bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 102 });
    const directRegions = [{ id: "target", clientWidth: 100, scrollWidth: 102 }];
    const view = render(<ReaderFixture html={html} directRegions={directRegions} />);
    const target = region(readerRoot(view.container), "target");
    const oldObserver = InstrumentedResizeObserver.instances[0];
    const oldRetire = capturedLayoutCleanups[0];

    view.rerender(<ReaderFixture html={html} contentKey="content-b" commit={1} directRegions={directRegions} />);
    const currentObserver = InstrumentedResizeObserver.instances[1];
    expect(region(readerRoot(view.container), "target")).toBe(target);
    expect(target).toHaveAttribute("tabindex", "0");
    tabIndexWrites.length = 0;

    oldRetire();
    oldRetire();
    expect(target).toHaveAttribute("tabindex", "0");
    expect(tabIndexWrites).toHaveLength(0);
    expect(oldObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(currentObserver.disconnect).not.toHaveBeenCalled();

    view.unmount();
    capturedLayoutCleanups[1]();
    expect(oldObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(currentObserver.disconnect).toHaveBeenCalledTimes(1);
  });

  it("publishes one exact Strict Mode successor and makes every late A continuation inert", () => {
    const html = bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 102 });
    const view = render(
      <StrictMode>
        <ReaderFixture html={html} />
      </StrictMode>,
    );
    const target = region(readerRoot(view.container), "target");
    const [retired, current] = InstrumentedResizeObserver.instances;
    const lateResize = retired.capture();

    expect(InstrumentedResizeObserver.instances).toHaveLength(2);
    expect(writesFor(target)).toEqual(["0", null, "0"]);
    expect(retired.disconnect).toHaveBeenCalledTimes(1);
    expect(current.disconnect).not.toHaveBeenCalled();

    tabIndexReads.length = 0;
    tabIndexWrites.length = 0;
    geometryReads.length = 0;
    lateResize();
    fonts.publish(0);
    expect(tabIndexReads).toHaveLength(0);
    expect(tabIndexWrites).toHaveLength(0);
    expect(geometryReads).toHaveLength(0);
    expect(retired.disconnect).toHaveBeenCalledTimes(1);
    expect(current.disconnect).not.toHaveBeenCalled();

    setGeometry(target, 100, 101);
    current.publish();
    expect(target).not.toHaveAttribute("tabindex");
    expect(writesFor(target)).toEqual([null]);
  });

  it("rejects an equal-looking partial Strict Mode replay and recovers on a fresh commit", () => {
    const html = bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 102 });
    let replaced: HTMLElement | null = null;
    InstrumentedResizeObserver.onDisconnect = (observer) => {
      if (observer !== InstrumentedResizeObserver.instances[0]) return;
      const root = observer.observed[0] as HTMLElement;
      root.innerHTML = html;
      replaced = region(root, "target");
      InstrumentedResizeObserver.onDisconnect = null;
    };
    const view = render(
      <StrictMode>
        <ReaderFixture html={html} />
      </StrictMode>,
    );
    const root = readerRoot(view.container);

    expect(InstrumentedResizeObserver.instances).toHaveLength(1);
    expect(replaced).toBe(region(root, "target"));
    expect(replaced).not.toHaveAttribute("tabindex");
    expect(InstrumentedResizeObserver.instances[0].disconnect).toHaveBeenCalledTimes(1);

    view.rerender(
      <StrictMode>
        <ReaderFixture html={html} commit={1} />
      </StrictMode>,
    );
    const current = InstrumentedResizeObserver.instances[1];
    const recovered = region(root, "target");
    expect(current.observed).toEqual([root, recovered]);
    expect(recovered).toHaveAttribute("tabindex", "0");
    expect(current.disconnect).not.toHaveBeenCalled();
  });

  it("publishes nothing for an intervening Strict Mode replay and admits a later exact layout", () => {
    const html = bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 102 });
    let intervening: HTMLElement | null = null;
    InstrumentedResizeObserver.onDisconnect = (observer) => {
      if (observer !== InstrumentedResizeObserver.instances[0]) return;
      const root = observer.observed[0] as HTMLElement;
      const marker = root.nextSibling;
      intervening = document.createElement("i");
      root.parentNode?.insertBefore(intervening, marker);
      InstrumentedResizeObserver.onDisconnect = null;
    };
    const view = render(
      <StrictMode>
        <ReaderFixture html={html} />
      </StrictMode>,
    );

    expect(InstrumentedResizeObserver.instances).toHaveLength(1);
    expect(intervening).not.toBeNull();
    view.container.querySelector("i")?.remove();
    view.rerender(
      <StrictMode>
        <ReaderFixture html={html} commit={1} />
      </StrictMode>,
    );
    const root = readerRoot(view.container);
    const target = region(root, "target");
    const current = InstrumentedResizeObserver.instances[1];
    expect(current.observed).toEqual([root, target]);
    expect(target).toHaveAttribute("tabindex", "0");
  });

  it.each([
    "root",
    "region reorder",
    "region subtree",
    "marker presentation",
    "root presentation",
    "immediate ancestor",
    "higher ancestor",
  ] as const)("permanently retires after restored %s mutation history", (kind) => {
    const html = bodyHtml(
      { id: "first", clientWidth: 100, scrollWidth: 102 },
      { id: "second", tag: "table", clientWidth: 100, scrollWidth: 102 },
    );
    const outer = document.createElement("section");
    const mount = document.createElement("div");
    outer.append(mount);
    document.body.append(outer);
    const view = render(<ReaderFixture html={html} />, { container: mount });
    const root = readerRoot(mount);
    const [first, second] = regions(root);
    const observer = InstrumentedResizeObserver.instances[0];
    const lateResize = observer.capture();
    const lateFonts = fonts.callbacks[0];

    if (kind === "root") {
      const parent = root.parentNode!;
      const next = root.nextSibling;
      root.remove();
      parent.insertBefore(root, next);
    } else if (kind === "region reorder") {
      root.insertBefore(second, first);
      root.insertBefore(first, second);
    } else if (kind === "region subtree") {
      const child = first.firstChild as ChildNode;
      const replacement = child.cloneNode(true) as ChildNode;
      child.replaceWith(replacement);
      replacement.replaceWith(child);
    } else if (kind === "marker presentation") {
      const marker = root.nextSibling as HTMLElement;
      marker.removeAttribute("hidden");
      marker.setAttribute("hidden", "");
    } else if (kind === "root presentation") {
      root.removeAttribute("data-reader-overflow-root");
      root.setAttribute("data-reader-overflow-root", "");
    } else {
      const target = kind === "immediate ancestor" ? mount : outer;
      const parent = target.parentNode!;
      const next = target.nextSibling;
      target.remove();
      parent.insertBefore(target, next);
    }

    tabIndexReads.length = 0;
    tabIndexWrites.length = 0;
    geometryReads.length = 0;
    lateResize();
    lateFonts();
    expect(tabIndexReads).toHaveLength(0);
    expect(tabIndexWrites).toHaveLength(0);
    expect(geometryReads).toHaveLength(0);
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("tabindex", "0");

    view.unmount();
    outer.remove();
  });

  it.each(["text", "comment", "element"] as const)(
    "permanently retires after restored marker %s subtree mutation",
    (kind) => {
      const html = bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 102 });
      const view = render(<ReaderFixture html={html} />);
      const root = readerRoot(view.container);
      const target = region(root, "target");
      const marker = view.container.querySelector<HTMLElement>("[data-reader-overflow-marker]")!;
      const observer = InstrumentedResizeObserver.instances[0];
      const lateResize = observer.capture();
      const lateFonts = fonts.callbacks[0];
      const child = kind === "text"
        ? document.createTextNode("temporary")
        : kind === "comment"
          ? document.createComment("temporary")
          : document.createElement("i");

      marker.append(child);
      if (kind === "text") child.nodeValue = "changed";
      child.remove();
      tabIndexReads.length = 0;
      tabIndexWrites.length = 0;
      geometryReads.length = 0;
      lateResize();
      lateFonts();

      expect(marker).toHaveTextContent("");
      expect(marker.childNodes).toHaveLength(0);
      expect(tabIndexReads).toHaveLength(0);
      expect(tabIndexWrites).toHaveLength(0);
      expect(geometryReads).toHaveLength(0);
      expect(observer.disconnect).toHaveBeenCalledTimes(1);
      expect(target).toHaveAttribute("tabindex", "0");
    },
  );

  it("transfers only the externally replaced region and restores the independently owned peer", () => {
    const html = bodyHtml(
      { id: "external", clientWidth: 100, scrollWidth: 102 },
      { id: "owned", tag: "table", clientWidth: 100, scrollWidth: 102 },
    );
    const view = render(<ReaderFixture html={html} />);
    const root = readerRoot(view.container);
    const external = region(root, "external");
    const owned = region(root, "owned");
    const observer = InstrumentedResizeObserver.instances[0];

    setExternalTabIndex(external, "-1");
    setGeometry(external, 100, 101);
    tabIndexWrites.length = 0;
    observer.publish();
    expect(external).toHaveAttribute("tabindex", "-1");
    expect(owned).toHaveAttribute("tabindex", "0");
    expect(tabIndexWrites).toHaveLength(0);

    view.rerender(<ReaderFixture html={html} showHelper={false} />);
    expect(external).toHaveAttribute("tabindex", "-1");
    expect(owned).not.toHaveAttribute("tabindex");
    expect(writesFor(external)).toEqual([]);
    expect(writesFor(owned)).toEqual([null]);
  });

  it("carries a restored mutation's owned value only into a fresh exact commit", async () => {
    const html = bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 102 });
    const directRegions = [{ id: "target", clientWidth: 100, scrollWidth: 102 }];
    const view = render(<ReaderFixture html={html} directRegions={directRegions} />);
    const root = readerRoot(view.container);
    const target = region(root, "target");
    const oldObserver = InstrumentedResizeObserver.instances[0];
    const parent = target.parentNode!;
    const next = target.nextSibling;
    target.remove();
    parent.insertBefore(target, next);
    oldObserver.publish();
    expect(oldObserver.disconnect).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.resolve();
    });
    view.rerender(<ReaderFixture html={html} directRegions={directRegions} commit={1} />);
    const currentObserver = InstrumentedResizeObserver.instances[1];
    expect(region(root, "target")).toBe(target);
    expect(target).toHaveAttribute("tabindex", "0");
    expect(currentObserver.disconnect).not.toHaveBeenCalled();

    tabIndexWrites.length = 0;
    view.rerender(
      <ReaderFixture html={html} directRegions={directRegions} showHelper={false} commit={2} />,
    );
    expect(target).not.toHaveAttribute("tabindex");
    expect(writesFor(target)).toEqual([null]);
    expect(currentObserver.disconnect).toHaveBeenCalledTimes(1);
  });

  it.each(["before", "during"] as const)(
    "permanently transfers one region after an external tabindex write %s sync",
    (timing) => {
      const html = bodyHtml(
        { id: "external", clientWidth: 100, scrollWidth: 102 },
        { id: "owned", tag: "table", clientWidth: 100, scrollWidth: 102 },
      );
      if (timing === "before") {
        InstrumentedResizeObserver.onObserve = (_observer, target) => {
          if (!(target instanceof HTMLElement) || !target.matches("[data-reader-overflow-root]")) return;
          setExternalTabIndex(region(target, "external"), "-1");
          InstrumentedResizeObserver.onObserve = null;
        };
      }
      const view = render(<ReaderFixture html={html} />);
      const root = readerRoot(view.container);
      const external = region(root, "external");
      const owned = region(root, "owned");
      const observer = InstrumentedResizeObserver.instances[0];
      if (timing === "during") {
        onGeometryRead = (target, name) => {
          if (target !== external || name !== "clientWidth") return;
          setExternalTabIndex(external, "-1");
          onGeometryRead = null;
        };
        observer.publish();
      }

      expect(external).toHaveAttribute("tabindex", "-1");
      expect(owned).toHaveAttribute("tabindex", "0");
      expect(writesFor(external)).toEqual(timing === "before" ? [] : ["0"]);
      expect(writesFor(owned)).toEqual(["0"]);

      setGeometry(external, 100, 101);
      setGeometry(owned, 100, 101);
      tabIndexWrites.length = 0;
      observer.publish();
      expect(external).toHaveAttribute("tabindex", "-1");
      expect(owned).not.toHaveAttribute("tabindex");
      expect(writesFor(external)).toEqual([]);
      expect(writesFor(owned)).toEqual([null]);
    },
  );

  it("ignores truly nonadjacent churn while retaining the strict overflow boundary", () => {
    const unrelated = document.createElement("aside");
    document.body.append(unrelated);
    const html = bodyHtml(
      { id: "boundary", clientWidth: 100, scrollWidth: 101 },
      { id: "overflow", tag: "table", clientWidth: 100, scrollWidth: 102 },
    );
    const view = render(<ReaderFixture html={html} />);
    const root = readerRoot(view.container);
    const boundary = region(root, "boundary");
    const overflow = region(root, "overflow");
    const observer = InstrumentedResizeObserver.instances[0];
    expect(boundary).not.toHaveAttribute("tabindex");
    expect(overflow).toHaveAttribute("tabindex", "0");

    unrelated.append(document.createElement("b"));
    setGeometry(boundary, 100, 102);
    setGeometry(overflow, 100, 101);
    tabIndexWrites.length = 0;
    observer.publish();
    expect(boundary).toHaveAttribute("tabindex", "0");
    expect(overflow).not.toHaveAttribute("tabindex");
    expect(writesFor(boundary)).toEqual(["0"]);
    expect(writesFor(overflow)).toEqual([null]);
    expect(observer.disconnect).not.toHaveBeenCalled();

    view.unmount();
    unrelated.remove();
  });

  it("retires a font continuation whose frozen FontFaceSet source was replaced", () => {
    const html = bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 102 });
    const view = render(<ReaderFixture html={html} />);
    const target = region(readerRoot(view.container), "target");
    const observer = InstrumentedResizeObserver.instances[0];
    const retiredFonts = fonts.callbacks[0];
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: new InstrumentedFonts(),
    });
    tabIndexReads.length = 0;
    tabIndexWrites.length = 0;
    geometryReads.length = 0;

    retiredFonts();
    expect(tabIndexReads).toHaveLength(0);
    expect(tabIndexWrites).toHaveLength(0);
    expect(geometryReads).toHaveLength(0);
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(target).toHaveAttribute("tabindex", "0");

    view.unmount();
  });

  it("rearms a new FontFaceSet ready cycle without a render and keeps the stale cycle inert", () => {
    const html = bodyHtml({ id: "target", clientWidth: 100, scrollWidth: 101 });
    const view = render(<ReaderFixture html={html} />);
    const target = region(readerRoot(view.container), "target");
    const observer = InstrumentedResizeObserver.instances[0];
    const staleReady = fonts.callbacks[0];

    fonts.replaceReady();
    setGeometry(target, 100, 102);
    geometryReads.length = 0;
    tabIndexWrites.length = 0;

    observer.publish();
    expect(fonts.callbacks).toHaveLength(2);
    expect(observer.disconnect).not.toHaveBeenCalled();
    expect(tabIndexWrites).toHaveLength(0);
    expect(geometryReads).toHaveLength(0);
    expect(target).not.toHaveAttribute("tabindex");

    staleReady();
    expect(fonts.callbacks).toHaveLength(2);
    expect(tabIndexWrites).toHaveLength(0);
    expect(geometryReads).toHaveLength(0);
    expect(observer.disconnect).not.toHaveBeenCalled();

    fonts.publish(1);
    expect(target).toHaveAttribute("tabindex", "0");
    expect(writesFor(target)).toEqual(["0"]);
    expect(geometryReads).toEqual([
      { target, name: "clientWidth" },
      { target, name: "scrollWidth" },
    ]);
    expect(observer.disconnect).not.toHaveBeenCalled();
  });
});
