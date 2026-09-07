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

import { useLayoutEffect } from "react";
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

  readonly observed: Element[] = [];
  connected = true;
  readonly observe = vi.fn((target: Element) => this.observed.push(target));
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn(() => {
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
  readonly ready = {
    then: (continuation: (fonts: FontFaceSet) => unknown) => {
      this.callbacks.push(() => continuation(document.fonts));
      return Promise.resolve(document.fonts);
    },
  } as Promise<FontFaceSet>;

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
  capturedLayoutCleanups.length = 0;
  fonts = new InstrumentedFonts();
  tabIndexReads = [];
  tabIndexWrites = [];
  vi.stubGlobal("ResizeObserver", InstrumentedResizeObserver);
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return Number(nativeGetAttribute.call(this, "data-client-width") ?? 0);
      },
    },
    scrollWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return Number(nativeGetAttribute.call(this, "data-scroll-width") ?? 0);
      },
    },
  });
  vi.spyOn(Element.prototype, "getAttribute").mockImplementation(function (name) {
    if (name.toLowerCase() === "tabindex") tabIndexReads.push(this);
    return nativeGetAttribute.call(this, name);
  });
  vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (name, value) {
    if (name.toLowerCase() === "tabindex") tabIndexWrites.push({ target: this, value });
    return nativeSetAttribute.call(this, name, value);
  });
  vi.spyOn(Element.prototype, "removeAttribute").mockImplementation(function (name) {
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
    view.unmount();

    expect(target.getAttribute("tabindex")).toBe(restored);
    expect(writesFor(target)).toEqual([applied, restored]);
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
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
});
