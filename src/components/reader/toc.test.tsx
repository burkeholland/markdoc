// @vitest-environment jsdom
import { useLayoutEffect } from "react";
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

const documentA: TestHeading[] = [
  { id: "alpha", level: 2, text: "Alpha", top: 120 },
  { id: "shared", level: 3, text: "Shared in A", top: 240 },
];
const documentB: TestHeading[] = [
  { id: "beta", level: 2, text: "Beta", top: 120 },
  { id: "shared", level: 3, text: "Shared in B", top: 240 },
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
