// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderScrollableRegions } from "./scrollable-regions";

const widths = new Map<Element, { client: number; scroll: number }>();
let resizeCallbacks: ResizeObserverCallback[] = [];

beforeEach(() => {
  widths.clear();
  resizeCallbacks = [];
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return widths.get(this)?.client ?? 100;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return widths.get(this)?.scroll ?? 100;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: ResizeObserverCallback) {
        resizeCallbacks.push(cb);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HTML = { __html: "<pre>code</pre><table><tbody><tr><td>x</td></tr></tbody></table>" };

function Body({ helper = true }: { helper?: boolean }) {
  return (
    <div>
      <div data-reader-overflow-root dangerouslySetInnerHTML={HTML} />
      {helper && <ReaderScrollableRegions contentKey="a" />}
    </div>
  );
}

function setup() {
  const view = render(<Body />);
  const pre = view.container.querySelector("pre")!;
  const table = view.container.querySelector("table")!;
  return { view, pre, table };
}

describe("ReaderScrollableRegions", () => {
  it("makes only overflowing regions focusable and updates on resize", () => {
    const { pre, table } = setup();
    expect(pre).not.toHaveAttribute("tabindex");
    widths.set(pre, { client: 100, scroll: 300 });
    act(() => resizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver)));
    expect(pre).toHaveAttribute("tabindex", "0");
    expect(table).not.toHaveAttribute("tabindex");
    widths.set(pre, { client: 300, scroll: 300 });
    act(() => resizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver)));
    expect(pre).not.toHaveAttribute("tabindex");
  });

  it("restores original tabindex on unmount", () => {
    const { view, pre } = setup();
    widths.set(pre, { client: 100, scroll: 300 });
    act(() => resizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver)));
    expect(pre).toHaveAttribute("tabindex", "0");
    view.rerender(<Body helper={false} />);
    expect(pre).not.toHaveAttribute("tabindex");
  });
});
