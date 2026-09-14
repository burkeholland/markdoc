// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { formatDateTime } from "@/lib/utils";
import { RelativeTime, shortDate } from "./relative-time";

const NOW = new Date("2026-08-22T18:30:00Z").getTime();

interface IntervalRecord {
  callback: () => void;
  delay: number | undefined;
  handle: ReturnType<typeof setInterval>;
}

function captureIntervals() {
  const reusedHandle = setInterval(() => {}, 1);
  clearInterval(reusedHandle);
  const intervals: IntervalRecord[] = [];
  const clears: Parameters<typeof clearInterval>[0][] = [];

  vi.spyOn(globalThis, "setInterval").mockImplementation((handler, delay, ...args) => {
    if (typeof handler !== "function") throw new TypeError("Expected an interval callback");
    intervals.push({ callback: vi.fn(() => handler(...args)), delay, handle: reusedHandle });
    return reusedHandle;
  });
  vi.spyOn(globalThis, "clearInterval").mockImplementation((handle) => {
    clears.push(handle);
  });

  return { intervals, clears, reusedHandle };
}

function captureVisibilityListeners() {
  const added: EventListener[] = [];
  const removed: EventListenerOrEventListenerObject[] = [];
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);

  vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "visibilitychange") {
      if (typeof listener !== "function") throw new TypeError("Expected a visibility callback");
      added.push(listener);
    }
    add(type, listener, options);
  });
  vi.spyOn(document, "removeEventListener").mockImplementation((type, listener, options) => {
    if (type === "visibilitychange") removed.push(listener);
    remove(type, listener, options);
  });

  return { added, removed };
}

type StoreSubscribe = (listener: () => void) => () => void;
type StoreSnapshot = () => number;

async function captureTickerStore(): Promise<{ subscribe: StoreSubscribe; getSnapshot: StoreSnapshot }> {
  let subscribe: StoreSubscribe | undefined;
  let getSnapshot: StoreSnapshot | undefined;

  vi.resetModules();
  vi.doMock("react", async (importOriginal) => {
    const react = await importOriginal<typeof import("react")>();
    return {
      ...react,
      useSyncExternalStore: (nextSubscribe: StoreSubscribe, nextGetSnapshot: StoreSnapshot) => {
        subscribe = nextSubscribe;
        getSnapshot = nextGetSnapshot;
        return nextGetSnapshot();
      },
    };
  });

  const { RelativeTime: IsolatedRelativeTime } = await import("./relative-time");
  IsolatedRelativeTime({ date: NOW });
  vi.doUnmock("react");

  if (!subscribe || !getSnapshot) throw new Error("RelativeTime did not expose its external store to React");
  return { subscribe, getSnapshot };
}

describe("RelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.doUnmock("react");
  });

  it("imports and renders the absolute UTC date on the server without browser globals", async () => {
    vi.resetModules();
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("window", undefined);
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const { RelativeTime: ServerRelativeTime } = await import("./relative-time");
      const html = renderToString(
        <ServerRelativeTime date={new Date(NOW - 60_000)} prefix="Edited " className="timestamp" />,
      );
      expect(html).toContain('<time dateTime="2026-08-22T18:29:00.000Z"');
      expect(html).toContain('class="timestamp"');
      expect(html).toContain(">Edited Aug 22, 2026</time>");
      expect(html).not.toContain("ago");
      expect(html).not.toContain("title=");
      expect(html).not.toContain("data-relative");
      expect(intervalSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("includes the date's year regardless of the current clock", () => {
    for (const now of ["2026-12-31T23:59:59Z", "2027-01-01T00:00:01Z", "2025-01-01T00:00:00Z"]) {
      vi.setSystemTime(new Date(now));
      expect(shortDate(new Date("2025-12-31T23:59:00Z"))).toBe("Dec 31, 2025");
      expect(shortDate(new Date("2026-01-01T00:00:00Z"))).toBe("Jan 1, 2026");
    }
  });

  it.each([
    ["same clock", "2026-08-22T18:30:00Z", "2026-08-22T18:30:00Z", "2026-08-22T18:29:00Z", "Aug 22, 2026", "1 minute ago"],
    ["UTC New Year", "2026-12-31T23:59:59Z", "2027-01-01T00:00:01Z", "2026-12-31T23:59:01Z", "Dec 31, 2026", "1 minute ago"],
    ["inverse clock years", "2027-01-01T00:00:01Z", "2026-12-31T23:59:59Z", "2026-12-31T23:58:59Z", "Dec 31, 2026", "1 minute ago"],
    [
      "another year's date", "2026-12-31T23:59:59Z", "2027-01-01T00:00:01Z", "2025-12-31T23:59:00Z", "Dec 31, 2025",
      new Date("2025-12-31T23:59:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    ],
  ])("hydrates without mismatch and then switches to relative text: %s", async (_case, serverClock, clientClock, dateString, absolute, relative) => {
    const date = new Date(dateString);
    const element = <RelativeTime date={date} prefix="Edited " className="timestamp" />;
    const container = document.createElement("div");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const recoverableErrors = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      vi.setSystemTime(new Date(serverClock));
      const html = renderToString(element);
      expect(html).toBe(`<time dateTime="${date.toISOString()}" class="timestamp">Edited ${absolute}</time>`);
      container.innerHTML = html;
      document.body.appendChild(container);
      expect(container.textContent).toBe(`Edited ${absolute}`);
      const initialTime = container.querySelector("time");

      vi.setSystemTime(new Date(clientClock));
      await act(async () => {
        root = hydrateRoot(container, element, { onRecoverableError: recoverableErrors });
      });
      expect(errors).not.toHaveBeenCalled();
      expect(recoverableErrors).not.toHaveBeenCalled();

      const time = container.querySelector("time")!;
      expect(time).toBe(initialTime);
      expect(time.textContent).toBe(`Edited ${relative}`);
      expect(time.getAttribute("title")).toBe(formatDateTime(date));
      expect(time.getAttribute("dateTime")).toBe(date.toISOString());
      expect(time.className).toBe("timestamp");
      expect(time.dataset.relative).toBe("true");
    } finally {
      try {
        act(() => root?.unmount());
      } finally {
        container.remove();
        vi.restoreAllMocks();
      }
    }
  });

  it("publishes one current tick to every concurrent subscriber and clears only after the last unmount", () => {
    const { intervals, clears, reusedHandle } = captureIntervals();
    const nowSpy = vi.spyOn(Date, "now");
    const date = new Date(NOW - 20_000);
    function Group({ names }: { names: string[] }) {
      return names.map((name) => <RelativeTime key={name} date={date} prefix={`${name} `} />);
    }

    const view = render(<Group names={["A", "B", "C"]} />);
    expect(screen.getByText("A just now")).toBeInTheDocument();
    expect(screen.getByText("C just now")).toBeInTheDocument();
    expect(intervals).toHaveLength(1);
    expect(intervals[0].delay).toBe(60_000);

    vi.setSystemTime(NOW + 60_000);
    nowSpy.mockClear();
    act(() => {
      intervals[0].callback();
    });
    expect(nowSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("A 1 minute ago")).toBeInTheDocument();
    expect(screen.getByText("B 1 minute ago")).toBeInTheDocument();
    expect(screen.getByText("C 1 minute ago")).toBeInTheDocument();

    view.rerender(<Group names={["A", "B"]} />);
    expect(clears).toHaveLength(0);
    expect(intervals).toHaveLength(1);

    view.rerender(<Group names={["A"]} />);
    expect(clears).toHaveLength(0);

    view.unmount();
    expect(clears).toEqual([reusedHandle]);
  });

  it("refreshes both timestamps on visibility return without ticking or duplicating shared resources", () => {
    const { intervals, clears, reusedHandle } = captureIntervals();
    const { added, removed } = captureVisibilityListeners();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const visibilityEvent = new Event("visibilitychange");
    const nowSpy = vi.spyOn(Date, "now");
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    const windowFocusSpy = vi.spyOn(window, "focus");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, "open");
    const date = new Date(NOW - 20_000);
    function Group({ names }: { names: string[] }) {
      return names.map((name) => <RelativeTime key={name} date={date} prefix={`${name} `} className="timestamp" />);
    }

    const view = render(<Group names={["A", "B"]} />);
    const first = screen.getByText("A just now");
    expect(screen.getByText("B just now")).toBeInTheDocument();
    const title = first.getAttribute("title");
    const focused = document.activeElement;
    expect(added).toHaveLength(1);
    expect(intervals).toHaveLength(1);
    expect(intervals[0].delay).toBe(60_000);

    vi.setSystemTime(NOW + 300_000);
    nowSpy.mockClear();
    act(() => document.dispatchEvent(visibilityEvent));
    expect(nowSpy).not.toHaveBeenCalled();
    expect(first).toHaveTextContent("A just now");
    expect(screen.getByText("B just now")).toBeInTheDocument();

    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(visibilityEvent));
    expect(nowSpy).toHaveBeenCalledTimes(1);
    expect(first).toHaveTextContent("A 5 minutes ago");
    expect(screen.getByText("B 5 minutes ago")).toBeInTheDocument();
    expect(first).toHaveAttribute("title", title);
    expect(first).toHaveAttribute("dateTime", date.toISOString());
    expect(first).toHaveAttribute("class", "timestamp");
    expect(first).toHaveAttribute("data-relative", "true");
    expect(intervals[0].callback).not.toHaveBeenCalled();

    vi.setSystemTime(NOW + 360_000);
    nowSpy.mockClear();
    act(() => document.dispatchEvent(visibilityEvent));
    expect(nowSpy).toHaveBeenCalledTimes(1);
    expect(first).toHaveTextContent("A 6 minutes ago");
    expect(screen.getByText("B 6 minutes ago")).toBeInTheDocument();
    expect(added).toHaveLength(1);
    expect(intervals).toHaveLength(1);
    expect(intervals[0].callback).not.toHaveBeenCalled();

    view.rerender(<Group names={["A"]} />);
    expect(removed).toHaveLength(0);
    expect(clears).toHaveLength(0);
    visibility.mockReturnValue("hidden");
    vi.setSystemTime(NOW + 420_000);
    nowSpy.mockClear();
    act(() => document.dispatchEvent(visibilityEvent));
    expect(nowSpy).not.toHaveBeenCalled();
    act(() => intervals[0].callback());
    expect(nowSpy).toHaveBeenCalledTimes(1);
    expect(first).toHaveTextContent("A 7 minutes ago");
    expect(intervals[0].callback).toHaveBeenCalledTimes(1);
    expect(added).toHaveLength(1);
    expect(intervals).toHaveLength(1);
    expect(removed).toHaveLength(0);
    expect(clears).toHaveLength(0);
    expect(document.activeElement).toBe(focused);
    expect(focusSpy).not.toHaveBeenCalled();
    expect(windowFocusSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
    expect(view.container.querySelector("[aria-live], [role='status'], [role='alert']")).toBeNull();

    view.unmount();
    expect(removed).toEqual([added[0]]);
    expect(clears).toEqual([reusedHandle]);
  });

  it("keeps retired visibility callbacks inert while a new generation refreshes once", async () => {
    const { intervals, clears, reusedHandle } = captureIntervals();
    const { added, removed } = captureVisibilityListeners();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const visibilityEvent = new Event("visibilitychange");
    const store = await captureTickerStore();
    const retiredListener = vi.fn();
    const unsubscribe = store.subscribe(retiredListener);
    const retiredVisibility = added[0];
    unsubscribe();
    unsubscribe();
    expect(removed).toEqual([retiredVisibility]);
    expect(clears).toEqual([reusedHandle]);

    const nowSpy = vi.spyOn(Date, "now");
    vi.setSystemTime(NOW + 300_000);
    retiredVisibility(visibilityEvent);
    document.dispatchEvent(visibilityEvent);
    expect(nowSpy).not.toHaveBeenCalled();
    expect(retiredListener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(NOW);

    const observedSnapshots: number[] = [];
    const liveListener = vi.fn(() => observedSnapshots.push(store.getSnapshot()));
    const unsubscribeNext = store.subscribe(liveListener);
    const unsubscribeOther = store.subscribe(liveListener);
    expect(added).toHaveLength(2);
    expect(added[1]).not.toBe(retiredVisibility);
    expect(intervals).toHaveLength(2);
    vi.setSystemTime(NOW + 360_000);
    nowSpy.mockClear();
    retiredVisibility(visibilityEvent);
    unsubscribe();
    expect(nowSpy).not.toHaveBeenCalled();
    expect(liveListener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(NOW + 300_000);
    expect(removed).toEqual([retiredVisibility]);

    document.dispatchEvent(visibilityEvent);
    expect(nowSpy).toHaveBeenCalledTimes(1);
    expect(liveListener).toHaveBeenCalledTimes(2);
    expect(observedSnapshots).toEqual([NOW + 360_000, NOW + 360_000]);
    expect(retiredListener).not.toHaveBeenCalled();
    expect(intervals.every(({ callback }) => vi.mocked(callback).mock.calls.length === 0)).toBe(true);
    unsubscribeNext();
    unsubscribeNext();
    expect(removed).toEqual([retiredVisibility]);
    unsubscribeOther();
    unsubscribeOther();
    expect(removed).toEqual(added);
    expect(clears).toEqual([reusedHandle, reusedHandle]);
  });

  it("tracks reused listener identities as exact, idempotent registrations", async () => {
    const { intervals, clears, reusedHandle } = captureIntervals();
    const store = await captureTickerStore();
    const observedSnapshots: number[] = [];
    const reusedListener = vi.fn(() => observedSnapshots.push(store.getSnapshot()));
    const unsubscribeFirst = store.subscribe(reusedListener);
    const unsubscribeSecond = store.subscribe(reusedListener);

    expect(intervals).toHaveLength(1);
    expect(intervals[0].delay).toBe(60_000);

    const nowSpy = vi.spyOn(Date, "now");
    vi.setSystemTime(NOW + 60_000);
    nowSpy.mockClear();
    intervals[0].callback();
    expect(nowSpy).toHaveBeenCalledTimes(1);
    expect(reusedListener).toHaveBeenCalledTimes(2);
    expect(observedSnapshots).toEqual([NOW + 60_000, NOW + 60_000]);

    unsubscribeFirst();
    unsubscribeFirst();
    expect(clears).toHaveLength(0);

    reusedListener.mockClear();
    observedSnapshots.length = 0;
    vi.setSystemTime(NOW + 120_000);
    nowSpy.mockClear();
    intervals[0].callback();
    expect(nowSpy).toHaveBeenCalledTimes(1);
    expect(reusedListener).toHaveBeenCalledTimes(1);
    expect(observedSnapshots).toEqual([NOW + 120_000]);

    unsubscribeSecond();
    unsubscribeSecond();
    expect(clears).toEqual([reusedHandle]);
  });

  it("keeps stale ticks and finalizers inert across A-B-A generations with reused handles", async () => {
    const { intervals, clears, reusedHandle } = captureIntervals();
    const store = await captureTickerStore();
    const reusedListener = vi.fn();

    const unsubscribeA = store.subscribe(reusedListener);
    const tickA = intervals[0].callback;
    unsubscribeA();
    expect(clears).toEqual([reusedHandle]);

    vi.setSystemTime(NOW + 60_000);
    const unsubscribeB = store.subscribe(reusedListener);
    const tickB = intervals[1].callback;
    expect(intervals[1].handle).toBe(intervals[0].handle);
    expect(store.getSnapshot()).toBe(NOW + 60_000);

    const nowSpy = vi.spyOn(Date, "now");
    vi.setSystemTime(NOW + 120_000);
    nowSpy.mockClear();
    tickA();
    unsubscribeA();
    expect(nowSpy).not.toHaveBeenCalled();
    expect(reusedListener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(NOW + 60_000);
    expect(clears).toEqual([reusedHandle]);

    tickB();
    expect(nowSpy).toHaveBeenCalledTimes(1);
    expect(reusedListener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(NOW + 120_000);

    reusedListener.mockClear();
    vi.setSystemTime(NOW + 180_000);
    nowSpy.mockClear();
    tickB();
    tickA();
    unsubscribeA();
    expect(nowSpy).toHaveBeenCalledTimes(1);
    expect(reusedListener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(NOW + 180_000);
    expect(clears).toEqual([reusedHandle]);

    unsubscribeB();
    expect(clears).toEqual([reusedHandle, reusedHandle]);

    vi.setSystemTime(NOW + 240_000);
    const unsubscribeANext = store.subscribe(reusedListener);
    const tickANext = intervals[2].callback;
    expect(intervals.map(({ handle }) => handle)).toEqual([reusedHandle, reusedHandle, reusedHandle]);

    reusedListener.mockClear();
    nowSpy.mockClear();
    tickB();
    unsubscribeB();
    expect(nowSpy).not.toHaveBeenCalled();
    expect(reusedListener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(NOW + 240_000);
    expect(clears).toEqual([reusedHandle, reusedHandle]);

    vi.setSystemTime(NOW + 300_000);
    tickANext();
    expect(nowSpy).toHaveBeenCalledTimes(1);
    expect(reusedListener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(NOW + 300_000);

    unsubscribeANext();
    expect(clears).toEqual([reusedHandle, reusedHandle, reusedHandle]);
  });

  it("prevents a removed visit from publishing into its replacement layout", async () => {
    const { intervals, clears, reusedHandle } = captureIntervals();
    const nowSpy = vi.spyOn(Date, "now");
    let reactPublications = 0;

    function Visit({ name }: { name: "a" | "b" | null }) {
      const content =
        name === "a" ? (
          <RelativeTime key="a" date={new Date(NOW - 20_000)} prefix="Updated " className="visit-a" />
        ) : name === "b" ? (
          <RelativeTime key="b" date={new Date(NOW)} prefix="Edited " className="visit-b" />
        ) : null;
      return (
        <Profiler id="visit" onRender={() => reactPublications++}>
          {content}
        </Profiler>
      );
    }

    const view = render(<Visit name="a" />);
    const tickA = intervals[0].callback;
    expect(view.container.querySelector("time")).toHaveTextContent("Updated just now");
    expect(view.container.querySelector("time")).toHaveAttribute("class", "visit-a");
    expect(view.container.querySelector("time")).toHaveAttribute("dateTime", "2026-08-22T18:29:40.000Z");
    view.rerender(<Visit name={null} />);
    expect(view.container.querySelector("time")).toBeNull();
    expect(clears).toEqual([reusedHandle]);

    vi.setSystemTime(NOW + 60_000);
    view.rerender(<Visit name="b" />);
    const tickB = intervals[1].callback;
    const time = view.container.querySelector("time");
    expect(time).not.toBeNull();
    expect(time).toHaveTextContent("Edited 1 minute ago");
    expect(time).toHaveAttribute("dateTime", "2026-08-22T18:30:00.000Z");
    expect(time).toHaveAttribute("class", "visit-b");
    expect(time).toHaveAttribute("data-relative", "true");
    expect(time).toHaveAttribute("title");

    const beforeStaleTick = {
      text: time!.textContent,
      dateTime: time!.getAttribute("dateTime"),
      title: time!.getAttribute("title"),
      className: time!.className,
      relative: time!.dataset.relative,
    };
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(view.container, { attributes: true, characterData: true, childList: true, subtree: true });
    reactPublications = 0;

    vi.setSystemTime(NOW + 120_000);
    nowSpy.mockClear();
    await act(async () => {
      tickA();
      await Promise.resolve();
    });
    expect(nowSpy).not.toHaveBeenCalled();
    expect(reactPublications).toBe(0);
    expect(mutations).toHaveLength(0);
    expect({
      text: time!.textContent,
      dateTime: time!.getAttribute("dateTime"),
      title: time!.getAttribute("title"),
      className: time!.className,
      relative: time!.dataset.relative,
    }).toEqual(beforeStaleTick);
    expect(clears).toEqual([reusedHandle]);

    await act(async () => {
      tickB();
      await Promise.resolve();
    });
    expect(nowSpy).toHaveBeenCalledTimes(1);
    expect(reactPublications).toBe(1);
    expect(mutations.length).toBeGreaterThan(0);
    expect(time).toHaveTextContent("Edited 2 minutes ago");
    expect(time).toHaveAttribute("dateTime", beforeStaleTick.dateTime);
    expect(time).toHaveAttribute("title", beforeStaleTick.title);
    expect(time).toHaveAttribute("class", "visit-b");

    observer.disconnect();
    view.unmount();
    expect(clears).toEqual([reusedHandle, reusedHandle]);
  });
});
