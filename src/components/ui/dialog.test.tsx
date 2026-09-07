// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Dialog, DialogContent } from "./dialog";
import { lazyOnFirstUse } from "@/components/editor/lazy-on-first-use";

// What `next/dynamic` is in the browser once its Next-specific wrapping is peeled away: `React.lazy` under a
// Suspense boundary — a component that suspends on its own first render even when its module is in.
vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default: (loader: () => Promise<unknown>, opts?: { loading?: (() => React.ReactElement | null) | null }) => {
      const Lazy = React.lazy(() => loader().then((mod) => ({ default: mod as React.ComponentType<object> })));
      const Loading = opts?.loading;
      return (props: object) => <React.Suspense fallback={Loading ? <Loading /> : null}>{React.createElement(Lazy, props)}</React.Suspense>;
    },
  };
});

// A dialog opened from the ⋮ menu with the keyboard (task #1349): the menu item is unmounted in the commit
// that opens the dialog and Radix's menu FocusScope hands focus back to the trigger in a setTimeout(0). A
// dialog whose content mounts after that — a lazily loaded chunk — had its `autoFocus` input robbed by that
// hand-back, and never learned who opened it. Focus is played by hand here: the trigger takes it right
// after the dialog has mounted, as the menu's timer did.
describe("DialogContent opening focus", () => {
  const flushTimers = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  let getClientRects: typeof Element.prototype.getClientRects;

  beforeEach(() => {
    // jsdom lays nothing out; `firstTabbable` treats a control without client rects as display:none.
    getClientRects = Element.prototype.getClientRects;
    Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
  });
  afterEach(() => {
    cleanup();
    Element.prototype.getClientRects = getClientRects;
  });

  function Harness({ open, children, title = "Name this version" }: { open: boolean; children?: React.ReactNode; title?: string }) {
    return (
      <>
        <button type="button" data-testid="more-menu">
          ⋮
        </button>
        <Dialog open={open}>
          <DialogContent title={title}>{children}</DialogContent>
        </Dialog>
      </>
    );
  }

  it("brings focus back to the autoFocus input when the closing menu focuses its trigger right after the dialog mounted", async () => {
    render(
      <Harness open>
        <input data-testid="version-name" autoFocus />
      </Harness>,
    );
    const input = screen.getByTestId("version-name");
    expect(input).toHaveFocus();

    act(() => screen.getByTestId("more-menu").focus());
    expect(screen.getByTestId("more-menu")).toHaveFocus();

    await flushTimers();
    expect(input).toHaveFocus();
  });

  it("hands focus back to whoever took it, the menu trigger, when the dialog closes — it never saw the menu item", async () => {
    const { rerender } = render(
      <Harness open>
        <input data-testid="version-name" autoFocus />
      </Harness>,
    );
    act(() => screen.getByTestId("more-menu").focus());
    await flushTimers();
    expect(screen.getByTestId("version-name")).toHaveFocus();

    rerender(<Harness open={false} />);
    await flushTimers();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("more-menu")).toHaveFocus();
  });

  it("keeps focus inside a dialog without an autoFocus control too, and still returns it to the trigger", async () => {
    const { rerender } = render(
      <Harness open title="Keyboard shortcuts">
        <p>Command palette — Mod-Shift-P</p>
      </Harness>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    act(() => screen.getByTestId("more-menu").focus());
    await flushTimers();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    rerender(<Harness open={false} />);
    await flushTimers();
    expect(screen.getByTestId("more-menu")).toHaveFocus();
  });

  it("leaves focus alone when the user has already moved it to another control of the dialog", async () => {
    render(
      <Harness open>
        <input data-testid="version-name" autoFocus />
        <input data-testid="second" />
      </Harness>,
    );
    act(() => screen.getByTestId("second").focus());
    await flushTimers();
    expect(screen.getByTestId("second")).toHaveFocus();
  });
});

function ExactContentBoundary({
  visit,
  contentKey = visit,
  modal = true,
  open = true,
  present = true,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
  onClosed,
}: {
  visit: string;
  contentKey?: string;
  modal?: boolean;
  open?: boolean;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
  onClosed?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => onPassiveCleanup, [contentKey, modal, onPassiveCleanup, open, present, visit]);
  if (!present) return null;
  return (
    <Dialog modal={modal} open={open}>
      <DialogContent key={contentKey} title={`Dialog ${visit}`} onClosed={onClosed}>
        <input data-testid={`input-${visit}`} autoFocus />
        <button type="button" data-testid={`action-${visit}`}>
          Use {visit}
        </button>
      </DialogContent>
    </Dialog>
  );
}

function trackContentFocusOutListeners() {
  const additions = vi.spyOn(HTMLElement.prototype, "addEventListener");
  const removals = vi.spyOn(HTMLElement.prototype, "removeEventListener");
  const records = () =>
    additions.mock.calls.flatMap((call, index) => {
      const content = additions.mock.contexts[index];
      const listener = call[1];
      return call[0] === "focusout" &&
        content instanceof HTMLDivElement &&
        content.getAttribute("role") === "dialog" &&
        typeof listener === "function"
        ? [{ content, listener }]
        : [];
    });
  const wasRemoved = ({ content, listener }: ReturnType<typeof records>[number]) =>
    removals.mock.calls.some(
      (call, index) => removals.mock.contexts[index] === content && call[0] === "focusout" && call[1] === listener,
    );
  return { additions, removals, records, wasRemoved };
}

function trackTimers() {
  const scheduled = vi.spyOn(globalThis, "setTimeout");
  const cleared = vi.spyOn(globalThis, "clearTimeout");
  const records = () =>
    scheduled.mock.calls.flatMap((call, index) => {
      const callback = call[0];
      const handle = scheduled.mock.results[index]?.value as ReturnType<typeof setTimeout> | undefined;
      return typeof callback === "function" && handle !== undefined
        ? [{ callback: () => callback(), handle, name: callback.name, source: callback.toString() }]
        : [];
    });
  const opening = () => records().filter(({ name }) => name === "recoverOpeningFocus");
  const closing = () => records().filter(({ source }) => source.includes("unmountEvent"));
  const wasCleared = (handle: ReturnType<typeof setTimeout>) => cleared.mock.calls.some(([candidate]) => candidate === handle);
  return { scheduled, cleared, opening, closing, wasCleared };
}

function invokeFocusOut(
  record: ReturnType<ReturnType<typeof trackContentFocusOutListeners>["records"]>[number],
  relatedTarget: HTMLElement,
) {
  record.listener.call(record.content, new FocusEvent("focusout", { relatedTarget }));
}

describe("DialogContent exact content ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "binds keyed replacement timers, listeners, return targets, and close callbacks with %s ordering",
    (order) => {
      const listeners = trackContentFocusOutListeners();
      const timers = trackTimers();
      const host = document.createElement("div");
      const reusedOpener = document.createElement("button");
      const staleTarget = document.createElement("button");
      document.body.append(reusedOpener, staleTarget, host);
      const root = createRoot(host);
      const closedA = vi.fn();
      const closedB = vi.fn();
      let passiveCleanups = 0;

      try {
        act(() =>
          root.render(
            <ExactContentBoundary visit="A" onClosed={closedA} onPassiveCleanup={() => passiveCleanups++} />,
          ),
        );
        const inputA = screen.getByTestId("input-A");
        const contentA = inputA.closest<HTMLDivElement>('[role="dialog"]')!;
        const listenerA = listeners.records().find((record) => record.content === contentA)!;
        const openingA = timers.opening()[0]!;
        expect(inputA).toHaveFocus();
        expect(listeners.records().filter((record) => record.content === contentA)).toHaveLength(1);
        expect(timers.opening()).toHaveLength(1);

        invokeFocusOut(listenerA, reusedOpener);
        act(() => {
          root.render(
            <ExactContentBoundary
              visit="B"
              onClosed={closedB}
              boundary={1}
              onPassiveCleanup={() => passiveCleanups++}
              onBoundary={() => {
                expect(passiveCleanups).toBe(0);
                expect(timers.wasCleared(openingA.handle)).toBe(true);
                expect(listeners.wasRemoved(listenerA)).toBe(true);
                expect(timers.opening().filter(({ handle }) => !timers.wasCleared(handle))).toHaveLength(0);
              }}
            />,
          );
        });

        expect(passiveCleanups).toBe(1);
        const inputB = screen.getByTestId("input-B");
        const contentB = inputB.closest<HTMLDivElement>('[role="dialog"]')!;
        const listenerB = listeners.records().find((record) => record.content === contentB)!;
        const openingB = timers.opening()[1]!;
        const closeA = timers.closing()[0]!;
        expect(listeners.records().filter((record) => record.content === contentB)).toHaveLength(1);

        const clearCallsBeforeStale = timers.cleared.mock.calls.length;
        const removeCallsBeforeStale = listeners.removals.mock.calls.length;
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        if (order === "stale-before-current") {
          invokeFocusOut(listenerA, staleTarget);
          invokeFocusOut(listenerB, reusedOpener);
        } else {
          invokeFocusOut(listenerB, reusedOpener);
          invokeFocusOut(listenerA, staleTarget);
        }
        reusedOpener.focus();
        expect(reusedOpener).toHaveFocus();
        focus.mockClear();
        const invokeCurrentTimer = () => openingB.callback();
        if (order === "stale-before-current") {
          openingA.callback();
          invokeCurrentTimer();
        } else {
          invokeCurrentTimer();
          openingA.callback();
        }

        expect(inputB).toHaveFocus();
        expect(focus).toHaveBeenCalledOnce();
        expect(focus.mock.contexts[0]).toBe(inputB);
        expect(timers.cleared.mock.calls.length).toBe(clearCallsBeforeStale);
        expect(listeners.removals.mock.calls.length).toBe(removeCallsBeforeStale + 1);
        expect(listeners.wasRemoved(listenerB)).toBe(true);
        fireEvent.input(inputB, { target: { value: "still usable" } });
        expect(inputB).toHaveValue("still usable");

        act(() => {
          root.render(
            <ExactContentBoundary
              visit="B"
              present={false}
              onClosed={closedB}
              boundary={2}
              onPassiveCleanup={() => passiveCleanups++}
              onBoundary={() => {
                expect(listeners.wasRemoved(listenerB)).toBe(true);
                expect(timers.wasCleared(openingB.handle)).toBe(false);
              }}
            />,
          );
        });
        const closeB = timers.closing()[1]!;
        expect(document.activeElement).toBe(document.body);
        focus.mockClear();

        const invokeStaleClose = () => closeA.callback();
        const invokeCurrentClose = () => closeB.callback();
        if (order === "stale-before-current") {
          invokeStaleClose();
          invokeCurrentClose();
        } else {
          invokeCurrentClose();
          invokeStaleClose();
        }

        expect(reusedOpener).toHaveFocus();
        expect(focus).toHaveBeenCalledOnce();
        expect(focus.mock.contexts[0]).toBe(reusedOpener);
        expect(closedA).not.toHaveBeenCalled();
        expect(closedB).toHaveBeenCalledOnce();
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it("rebinds a replaced Radix content DOM behind stable DialogContent refs", () => {
    const listeners = trackContentFocusOutListeners();
    const timers = trackTimers();
    const host = document.createElement("div");
    const opener = document.createElement("button");
    document.body.append(opener, host);
    opener.focus();
    const root = createRoot(host);
    const closed = vi.fn();
    let passiveCleanups = 0;

    try {
      act(() =>
        root.render(
          <ExactContentBoundary
            visit="A"
            contentKey="stable"
            onClosed={closed}
            onPassiveCleanup={() => passiveCleanups++}
          />,
        ),
      );
      const contentA = screen.getByTestId("input-A").closest<HTMLDivElement>('[role="dialog"]')!;
      const listenerA = listeners.records().find((record) => record.content === contentA)!;
      const openingA = timers.opening()[0]!;

      act(() => {
        root.render(
          <ExactContentBoundary
            contentKey="stable"
            modal={false}
            visit="B"
            boundary={1}
            onClosed={closed}
            onPassiveCleanup={() => passiveCleanups++}
            onBoundary={() => {
              expect(passiveCleanups).toBe(0);
              expect(timers.wasCleared(openingA.handle)).toBe(true);
              expect(listeners.wasRemoved(listenerA)).toBe(true);
              const contentB = screen.getByTestId("input-B").closest<HTMLDivElement>('[role="dialog"]')!;
              expect(contentB).not.toBe(contentA);
              expect(listeners.records().filter((record) => record.content === contentB)).toHaveLength(1);
              expect(timers.opening().filter(({ handle }) => !timers.wasCleared(handle))).toHaveLength(1);
            }}
          />,
        );
      });
      expect(passiveCleanups).toBe(1);
      const closeA = timers.closing()[0]!;

      const inputB = screen.getByTestId("input-B");
      const contentB = inputB.closest<HTMLDivElement>('[role="dialog"]')!;
      const listenerB = listeners.records().find((record) => record.content === contentB)!;
      const openingB = timers.opening()[1]!;
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      focus.mockClear();
      closeA.callback();
      openingA.callback();
      invokeFocusOut(listenerA, opener);
      expect(closed).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(timers.wasCleared(openingB.handle)).toBe(false);
      expect(listeners.wasRemoved(listenerB)).toBe(false);

      openingB.callback();
      expect(inputB).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
      expect(listeners.wasRemoved(listenerB)).toBe(true);
      fireEvent.click(screen.getByTestId("action-B"));
      expect(screen.getByTestId("action-B")).toBeEnabled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("physically retires a removed content owner before the parent layout effect", () => {
    const listeners = trackContentFocusOutListeners();
    const timers = trackTimers();
    const host = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(outside, host);
    const root = createRoot(host);
    let passiveCleanups = 0;

    try {
      act(() =>
        root.render(
          <ExactContentBoundary visit="removed" onPassiveCleanup={() => passiveCleanups++} />,
        ),
      );
      const input = screen.getByTestId("input-removed");
      const content = input.closest<HTMLDivElement>('[role="dialog"]')!;
      const listener = listeners.records().find((record) => record.content === content)!;
      const opening = timers.opening()[0]!;
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      focus.mockClear();

      act(() => {
        root.render(
          <ExactContentBoundary
            visit="removed"
            present={false}
            boundary={1}
            onPassiveCleanup={() => passiveCleanups++}
            onBoundary={() => {
              expect(passiveCleanups).toBe(0);
              expect(timers.wasCleared(opening.handle)).toBe(true);
              expect(listeners.wasRemoved(listener)).toBe(true);
              expect(timers.opening().filter(({ handle }) => !timers.wasCleared(handle))).toHaveLength(0);
              const clears = timers.cleared.mock.calls.length;
              const removals = listeners.removals.mock.calls.length;
              invokeFocusOut(listener, outside);
              opening.callback();
              expect(timers.cleared.mock.calls).toHaveLength(clears);
              expect(listeners.removals.mock.calls).toHaveLength(removals);
              expect(focus).not.toHaveBeenCalled();
            }}
          />,
        );
      });

      expect(passiveCleanups).toBe(1);
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("lazyOnFirstUse", () => {
  afterEach(cleanup);

  it("mounts a component in the same commit once a sibling from its module has loaded it", async () => {
    const mod = {
      Shortcuts: () => <p data-testid="shortcuts">shortcuts</p>,
      NameVersion: () => <p data-testid="name-version">name version</p>,
    };
    const load = vi.fn(() => Promise.resolve(mod));
    const Shortcuts = lazyOnFirstUse(load, (m) => m.Shortcuts);
    const NameVersion = lazyOnFirstUse(load, (m) => m.NameVersion);

    render(<Shortcuts />);
    expect(await screen.findByTestId("shortcuts")).toBeInTheDocument();

    // Not the component that loaded the module: the ⋮ menu item that opened it is still mounted and focused
    // in this commit, and nothing has queued a focus change yet — the same as a static import.
    render(<NameVersion />);
    expect(screen.getByTestId("name-version")).toBeInTheDocument();
  });
});
