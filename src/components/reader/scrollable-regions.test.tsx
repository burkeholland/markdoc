// @vitest-environment jsdom

import { useLayoutEffect } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderScrollableRegions } from "./scrollable-regions";

const CONTENT_A = "<pre><code>content A</code></pre>";
const CONTENT_B = "<table><tbody><tr><td>content B</td></tr></tbody></table>";

class InstrumentedResizeObserver implements ResizeObserver {
  static instances: InstrumentedResizeObserver[] = [];

  readonly observed = new Set<Element>();
  readonly observe = vi.fn((target: Element) => this.observed.add(target));
  readonly unobserve = vi.fn((target: Element) => this.observed.delete(target));
  readonly disconnect = vi.fn(() => this.observed.clear());

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

function ReaderBoundary({
  html,
  show = true,
  boundary = 0,
  onLayout,
}: {
  html: string;
  show?: boolean;
  boundary?: number;
  onLayout?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onLayout?.();
  }, [boundary, onLayout]);

  return show ? <ReaderScrollableRegions html={html} hideFirstH1={false} /> : null;
}

function setWidths(element: HTMLElement, clientWidth: number, scrollWidth: number) {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: { configurable: true, value: scrollWidth },
  });
}

const region = (text: string) => screen.getByText(text).closest<HTMLElement>("pre, table")!;
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");

beforeEach(() => {
  InstrumentedResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", InstrumentedResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});

describe("ReaderScrollableRegions content authority", () => {
  it("scopes each observer and its tab stops to the exact body it renders", () => {
    const fonts = Promise.withResolvers<FontFaceSet>();
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: fonts.promise } });
    render(
      <>
        <ReaderScrollableRegions html={CONTENT_A} hideFirstH1 />
        <ReaderScrollableRegions html={CONTENT_B} hideFirstH1={false} />
      </>,
    );

    const contentA = region("content A");
    const contentB = region("content B");
    const [observerA, observerB] = InstrumentedResizeObserver.instances;
    setWidths(contentA, 100, 240);
    setWidths(contentB, 240, 100);
    observerA.publish();
    observerB.publish();

    expect(observerA.observed).toEqual(new Set([contentA.parentElement!, contentA]));
    expect(observerB.observed).toEqual(new Set([contentB.parentElement!, contentB]));
    expect(contentA).toHaveAttribute("tabindex", "0");
    expect(contentB).not.toHaveAttribute("tabindex");
    expect(contentA.parentElement).toHaveAttribute("data-hide-first-h1", "true");
    expect(contentB.parentElement).not.toHaveAttribute("data-hide-first-h1");

    setWidths(contentA, 240, 100);
    setWidths(contentB, 100, 240);
    observerA.publish();
    observerB.publish();
    expect(contentA).not.toHaveAttribute("tabindex");
    expect(contentB).toHaveAttribute("tabindex", "0");
  });

  it("retires A before B's parent layout boundary and ignores A's captured resize", () => {
    const fonts = Promise.withResolvers<FontFaceSet>();
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: fonts.promise } });
    const view = render(<ReaderBoundary html={CONTENT_A} />);
    const contentA = region("content A");
    const observerA = InstrumentedResizeObserver.instances[0];
    setWidths(contentA, 100, 240);
    observerA.publish();
    expect(contentA).toHaveAttribute("tabindex", "0");
    const staleResize = observerA.capture();
    let retiredAtBoundary = false;
    let staleResizeWasInert = false;

    view.rerender(
      <ReaderBoundary
        html={CONTENT_B}
        boundary={1}
        onLayout={() => {
          retiredAtBoundary = observerA.observed.size === 0 && observerA.disconnect.mock.calls.length === 1;
          staleResize();
          staleResizeWasInert = !contentA.hasAttribute("tabindex");
        }}
      />,
    );

    expect(retiredAtBoundary).toBe(true);
    expect(staleResizeWasInert).toBe(true);
    expect(contentA).not.toHaveAttribute("tabindex");
    const contentB = region("content B");
    const observerB = InstrumentedResizeObserver.instances[1];
    setWidths(contentB, 100, 240);
    observerB.publish();
    expect(contentB).toHaveAttribute("tabindex", "0");
    expect(observerA.disconnect).toHaveBeenCalledTimes(1);
    expect(observerB.disconnect).not.toHaveBeenCalled();
  });

  it("keeps stale A work inert across an A-B-A visit while the current A stays usable", () => {
    const fonts = Promise.withResolvers<FontFaceSet>();
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: fonts.promise } });
    const view = render(<ReaderBoundary html={CONTENT_A} />);
    const firstA = region("content A");
    const firstObserverA = InstrumentedResizeObserver.instances[0];
    const staleFirstA = firstObserverA.capture();

    view.rerender(<ReaderBoundary html={CONTENT_B} />);
    view.rerender(<ReaderBoundary html={CONTENT_A} />);
    const currentA = region("content A");
    const currentObserverA = InstrumentedResizeObserver.instances[2];
    setWidths(firstA, 100, 240);
    setWidths(currentA, 100, 240);
    staleFirstA();

    expect(firstA).not.toHaveAttribute("tabindex");
    expect(currentA).not.toHaveAttribute("tabindex");
    currentObserverA.publish();
    expect(currentA).toHaveAttribute("tabindex", "0");
    expect(firstObserverA.disconnect).toHaveBeenCalledTimes(1);
    expect(currentObserverA.disconnect).not.toHaveBeenCalled();
  });

  it("retires on removal and lets only the current content answer font readiness", async () => {
    const fonts = Promise.withResolvers<FontFaceSet>();
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: fonts.promise } });
    const view = render(<ReaderBoundary html={CONTENT_A} />);
    const contentA = region("content A");
    const observerA = InstrumentedResizeObserver.instances[0];
    setWidths(contentA, 100, 240);
    observerA.publish();
    const staleResize = observerA.capture();
    let retiredAtBoundary = false;

    view.rerender(
      <ReaderBoundary
        html={CONTENT_A}
        show={false}
        boundary={1}
        onLayout={() => {
          retiredAtBoundary = observerA.observed.size === 0 && observerA.disconnect.mock.calls.length === 1;
          staleResize();
        }}
      />,
    );
    expect(retiredAtBoundary).toBe(true);
    expect(contentA).not.toHaveAttribute("tabindex");

    view.rerender(<ReaderBoundary html={CONTENT_B} boundary={2} />);
    const contentB = region("content B");
    const observerB = InstrumentedResizeObserver.instances[1];
    setWidths(contentA, 100, 260);
    setWidths(contentB, 100, 260);
    await act(async () => fonts.resolve(document.fonts));

    expect(contentA).not.toHaveAttribute("tabindex");
    expect(contentB).toHaveAttribute("tabindex", "0");
    expect(observerA.disconnect).toHaveBeenCalledTimes(1);
    expect(observerB.disconnect).not.toHaveBeenCalled();
  });
});
