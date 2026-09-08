// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { useEffect, useLayoutEffect, type ReactNode, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";

const clipboard = vi.hoisted(() => ({
  copyText: vi.fn<(text: string) => Promise<boolean>>(),
  selectContents: vi.fn<(target: HTMLElement | null) => void>(),
}));

vi.mock("@/lib/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clipboard")>()),
  copyText: clipboard.copyText,
  selectContents: clipboard.selectContents,
}));

import { useCopy, type CopyStatus } from "./hooks";

const FIRST_TEXT = "first rendered value";
const NEXT_TEXT = "next rendered value";
type CopyResult = ReturnType<typeof useCopy>;

interface CopyControlProps {
  text: string;
  target?: RefObject<HTMLElement | null>;
  idleLabel?: string;
  observe: (copy: CopyResult) => void;
  onPassiveCleanup?: () => void;
}

function CopyControl({ text, target, idleLabel, observe, onPassiveCleanup }: CopyControlProps) {
  const copy = useCopy(text, target, idleLabel);
  observe(copy);
  useEffect(() => () => onPassiveCleanup?.(), [idleLabel, onPassiveCleanup, target, text]);
  return (
    <button data-testid="copy-control" onClick={copy.copy} aria-label={copy.label}>
      {copy.label}
    </button>
  );
}

function CopyBoundary({
  text,
  target,
  idleLabel,
  visitKey = "copy",
  present = true,
  boundary = 0,
  observe,
  onLayout,
  onPassiveCleanup,
}: {
  text: string;
  target?: RefObject<HTMLElement | null>;
  idleLabel?: string;
  visitKey?: string;
  present?: boolean;
  boundary?: number;
  observe: (copy: CopyResult) => void;
  onLayout?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onLayout?.();
  }, [boundary, onLayout]);
  return present ? (
    <CopyControl
      key={visitKey}
      text={text}
      target={target}
      idleLabel={idleLabel}
      observe={observe}
      onPassiveCleanup={onPassiveCleanup}
    />
  ) : null;
}

interface DirectRoot {
  host: HTMLDivElement;
  root: Root;
  active: boolean;
}

const directRoots: DirectRoot[] = [];

function renderDirect(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const view: DirectRoot = { host, root: createRoot(host), active: true };
  directRoots.push(view);
  act(() => view.root.render(node));
  return {
    host,
    root: view.root,
    rerender(next: ReactNode) {
      act(() => view.root.render(next));
    },
    unmount() {
      if (!view.active) return;
      view.active = false;
      act(() => view.root.unmount());
      host.remove();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function staleEffectSnapshot(host: HTMLElement, focusOwner: HTMLElement, clearTimeoutCalls: number) {
  return {
    clipboardAttempts: clipboard.copyText.mock.calls.length,
    timerCount: vi.getTimerCount(),
    clearTimeoutCalls,
    fallbackSelections: clipboard.selectContents.mock.calls.length,
    focusUnchanged: document.activeElement === focusOwner,
    location: window.location.href,
    markup: host.innerHTML,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  clipboard.copyText.mockReset();
  clipboard.selectContents.mockReset();
});

afterEach(() => {
  for (const view of directRoots.splice(0)) {
    if (view.active) act(() => view.root.unmount());
    view.host.remove();
  }
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("useCopy", () => {
  it("starts one synchronous attempt for duplicate activation while the rendered value is pending", async () => {
    const pending = deferred<boolean>();
    clipboard.copyText.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useCopy(FIRST_TEXT));

    act(() => {
      result.current.copy();
      result.current.copy();
    });

    expect(clipboard.copyText).toHaveBeenCalledExactlyOnceWith(FIRST_TEXT);
    await flush(() => pending.resolve(true));
    expect(result.current.status).toBe("copied");
  });

  it.each([
    ["text replacement", "text"],
    ["target-ref replacement", "target"],
    ["idle-label replacement", "idle-label"],
    ["equal-value distinct remount", "remount"],
    ["removal", "removal"],
  ] as const)(
    "makes a captured callback inert at and after the parent layout boundary for %s",
    async (_label, replacement) => {
      clipboard.copyText.mockResolvedValue(true);
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const firstTarget = { current: document.createElement("pre") };
      const nextTarget = { current: document.createElement("pre") };
      const focusOwner = document.createElement("button");
      focusOwner.textContent = "Persistent focus owner";
      document.body.append(focusOwner);
      let latest!: CopyResult;
      let passiveCleanups = 0;
      const observe = (copy: CopyResult) => {
        latest = copy;
      };
      const onPassiveCleanup = () => {
        passiveCleanups++;
      };
      const view = renderDirect(
        <CopyBoundary
          text={FIRST_TEXT}
          target={firstTarget}
          idleLabel="Copy original"
          visitKey="first"
          observe={observe}
          onPassiveCleanup={onPassiveCleanup}
        />,
      );

      try {
        const staleCopy = latest.copy;
        await flush(() => staleCopy());
        expect(latest.status).toBe("copied");
        expect(vi.getTimerCount()).toBe(1);
        const oldTimerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 1500);
        const oldTimer = setTimeoutSpy.mock.results[oldTimerIndex]?.value;
        expect(oldTimerIndex).toBeGreaterThanOrEqual(0);
        clipboard.copyText.mockClear();
        clipboard.selectContents.mockClear();
        focusOwner.focus();

        const nextText = replacement === "text" ? NEXT_TEXT : FIRST_TEXT;
        const target = replacement === "target" ? nextTarget : firstTarget;
        const idleLabel = replacement === "idle-label" ? "Copy current" : "Copy original";
        const visitKey = replacement === "remount" ? "second" : "first";
        const present = replacement !== "removal";
        let passiveCleanupsAtBoundary = -1;
        let beforeStaleAtBoundary: ReturnType<typeof staleEffectSnapshot> | undefined;
        let afterStaleAtBoundary: ReturnType<typeof staleEffectSnapshot> | undefined;
        let statusAtBoundary: CopyStatus | undefined;
        let labelAtBoundary: string | null | undefined;
        let reachBoundary!: () => void;
        const boundaryReached = new Promise<void>((resolve) => {
          reachBoundary = resolve;
        });

        view.root.render(
          <CopyBoundary
            text={nextText}
            target={target}
            idleLabel={idleLabel}
            visitKey={visitKey}
            present={present}
            boundary={1}
            observe={observe}
            onPassiveCleanup={onPassiveCleanup}
            onLayout={() => {
              passiveCleanupsAtBoundary = passiveCleanups;
              statusAtBoundary = present ? latest.status : undefined;
              labelAtBoundary = view.host.querySelector("button")?.getAttribute("aria-label");
              beforeStaleAtBoundary = staleEffectSnapshot(
                view.host,
                focusOwner,
                clearTimeoutSpy.mock.calls.length,
              );
              staleCopy();
              afterStaleAtBoundary = staleEffectSnapshot(
                view.host,
                focusOwner,
                clearTimeoutSpy.mock.calls.length,
              );
              reachBoundary();
            }}
          />,
        );
        await boundaryReached;

        expect(passiveCleanupsAtBoundary).toBe(0);
        expect(afterStaleAtBoundary).toEqual(beforeStaleAtBoundary);
        expect(clipboard.copyText).not.toHaveBeenCalled();
        expect(clipboard.selectContents).not.toHaveBeenCalled();
        expect(clearTimeoutSpy.mock.calls.filter(([timer]) => timer === oldTimer)).toHaveLength(1);
        if (present) {
          expect(statusAtBoundary).toBe("idle");
          expect(labelAtBoundary).toBe(idleLabel);
        } else {
          expect(view.host).toBeEmptyDOMElement();
        }

        await act(async () => {});
        expect(passiveCleanups).toBe(1);
        const beforeStaleAfterCleanup = staleEffectSnapshot(
          view.host,
          focusOwner,
          clearTimeoutSpy.mock.calls.length,
        );
        act(() => staleCopy());
        expect(
          staleEffectSnapshot(view.host, focusOwner, clearTimeoutSpy.mock.calls.length),
        ).toEqual(beforeStaleAfterCleanup);
      } finally {
        view.unmount();
        focusOwner.remove();
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    },
  );

  it.each([
    ["stale-first", "success"],
    ["current-first", "success"],
    ["stale-first", "failure"],
    ["current-first", "failure"],
  ] as const)(
    "keeps an equal-value remount authoritative with reused timer handles: %s, pending %s",
    async (order, outcome) => {
      const current = deferred<boolean>();
      clipboard.copyText
        .mockResolvedValueOnce(true)
        .mockReturnValueOnce(current.promise);
      const sharedTimer = setTimeout(() => undefined, 60_000);
      clearTimeout(sharedTimer);
      const scheduled: { callback: () => void; delay: number | undefined }[] = [];
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay) => {
        if (typeof callback !== "function") throw new Error("Expected a timeout callback");
        scheduled.push({ callback: callback as () => void, delay });
        return sharedTimer;
      });
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
      const staleTarget = { current: document.createElement("pre") };
      const currentTarget = { current: document.createElement("pre") };
      let latest!: CopyResult;
      const observe = (copy: CopyResult) => {
        latest = copy;
      };
      const view = renderDirect(
        <CopyBoundary text={FIRST_TEXT} target={staleTarget} visitKey="first" observe={observe} />,
      );

      try {
        const staleCopy = latest.copy;
        await flush(() => staleCopy());
        expect(latest.status).toBe("copied");
        const staleTimer = scheduled.find(({ delay }) => delay === 1500);
        if (!staleTimer) throw new Error("The stale feedback timer was not scheduled");

        view.rerender(
          <CopyBoundary text={FIRST_TEXT} target={currentTarget} visitKey="second" observe={observe} />,
        );
        expect(latest.status).toBe("idle");
        expect(clearTimeoutSpy).toHaveBeenCalledExactlyOnceWith(sharedTimer);
        const currentCopy = latest.copy;
        clipboard.copyText.mockClear();
        clipboard.selectContents.mockClear();

        act(() => {
          if (order === "stale-first") {
            staleCopy();
            currentCopy();
          } else {
            currentCopy();
            staleCopy();
          }
        });
        expect(clipboard.copyText).toHaveBeenCalledExactlyOnceWith(FIRST_TEXT);
        expect(latest.status).toBe("idle");

        await flush(() => {
          if (outcome === "success") current.resolve(true);
          else current.reject(new Error("current clipboard failure"));
        });
        const expectedStatus = outcome === "success" ? "copied" : "fallback";
        const expectedDelay = outcome === "success" ? 1500 : 2000;
        expect(latest.status).toBe(expectedStatus);
        expect(latest.label).toBe(outcome === "success" ? "Copied" : "Select & press Ctrl+C");
        expect(clipboard.selectContents).toHaveBeenCalledTimes(outcome === "success" ? 0 : 1);
        if (outcome === "failure") {
          expect(clipboard.selectContents).toHaveBeenCalledExactlyOnceWith(currentTarget.current);
        }
        expect(clipboard.selectContents.mock.calls.some(([target]) => target === staleTarget.current)).toBe(false);
        const currentTimer = scheduled.filter(({ delay }) => delay === expectedDelay).at(-1);
        if (!currentTimer) throw new Error("The current feedback timer was not scheduled");
        expect(setTimeoutSpy).toHaveReturnedWith(sharedTimer);
        expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

        const currentMarkup = view.host.innerHTML;
        act(() => {
          staleTimer.callback();
          staleCopy();
        });
        expect(view.host.innerHTML).toBe(currentMarkup);
        expect(latest.status).toBe(expectedStatus);
        expect(clipboard.copyText).toHaveBeenCalledTimes(1);
        expect(clipboard.selectContents).toHaveBeenCalledTimes(outcome === "success" ? 0 : 1);
        expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

        act(() => currentTimer.callback());
        expect(latest.status).toBe("idle");
        expect(latest.label).toBe("Copy");
        expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
      } finally {
        view.unmount();
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    },
  );

  it("renders replacement text as idle before its parent layout boundary", async () => {
    clipboard.copyText.mockResolvedValue(true);
    let latest!: CopyResult;
    const observe = (copy: CopyResult) => {
      latest = copy;
    };
    const { rerender } = render(<CopyBoundary text={FIRST_TEXT} observe={observe} />);

    await flush(() => latest.copy());
    expect(latest.status).toBe("copied");
    expect(screen.getByTestId("copy-control")).toHaveAccessibleName("Copied");
    let statusAtBoundary: CopyStatus | undefined;
    let labelAtBoundary: string | null | undefined;

    rerender(
      <CopyBoundary
        text={NEXT_TEXT}
        boundary={1}
        observe={observe}
        onLayout={() => {
          statusAtBoundary = latest.status;
          labelAtBoundary = screen.getByTestId("copy-control").getAttribute("aria-label");
        }}
      />,
    );

    expect(statusAtBoundary).toBe("idle");
    expect(labelAtBoundary).toBe("Copy");
    expect(latest.status).toBe("idle");
  });

  it("does not revive retired feedback when text cycles back to the same value", async () => {
    clipboard.copyText.mockResolvedValue(true);
    const { result, rerender } = renderHook(({ text }: { text: string }) => useCopy(text), {
      initialProps: { text: FIRST_TEXT },
    });

    await flush(() => result.current.copy());
    expect(result.current.status).toBe("copied");

    rerender({ text: NEXT_TEXT });
    expect(result.current.status).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
    rerender({ text: FIRST_TEXT });
    expect(result.current.status).toBe("idle");
  });

  it.each(["resolve", "reject"] as const)(
    "retires a pending operation before its %s settles at the replacement parent layout boundary",
    async (outcome) => {
      const pending = deferred<boolean>();
      clipboard.copyText.mockReturnValue(pending.promise);
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      let latest!: CopyResult;
      const observe = (copy: CopyResult) => {
        latest = copy;
      };

      try {
        const { rerender } = render(<CopyBoundary text={FIRST_TEXT} observe={observe} />);
        act(() => latest.copy());
        expect(clipboard.copyText).toHaveBeenCalledExactlyOnceWith(FIRST_TEXT);
        let statusAtBoundary: CopyStatus | undefined;

        rerender(
          <CopyBoundary
            text={NEXT_TEXT}
            boundary={1}
            observe={observe}
            onLayout={() => {
              statusAtBoundary = latest.status;
              if (outcome === "resolve") pending.resolve(true);
              else pending.reject(new Error("retired clipboard failure"));
            }}
          />,
        );
        await flush(() => undefined);

        expect(statusAtBoundary).toBe("idle");
        expect(latest.status).toBe("idle");
        expect(clipboard.selectContents).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    },
  );

  it("keeps success and fallback feedback for exactly 1.5 and 2 seconds", async () => {
    const firstTarget = document.createElement("pre");
    const replacementTarget = document.createElement("pre");
    const target = { current: firstTarget };
    clipboard.copyText.mockResolvedValueOnce(true);
    const failure = deferred<boolean>();
    clipboard.copyText.mockReturnValueOnce(failure.promise);
    const { result } = renderHook(() => useCopy(FIRST_TEXT, target));

    await flush(() => result.current.copy());
    expect(result.current.status).toBe("copied");
    expect(result.current.label).toBe("Copied");
    await advance(1499);
    expect(result.current.status).toBe("copied");
    await advance(1);
    expect(result.current.status).toBe("idle");

    act(() => {
      result.current.copy();
      target.current = replacementTarget;
    });
    await flush(() => failure.resolve(false));
    expect(clipboard.selectContents).toHaveBeenCalledExactlyOnceWith(firstTarget);
    expect(result.current.status).toBe("fallback");
    expect(result.current.label).toBe("Select & press Ctrl+C");
    await advance(1999);
    expect(result.current.status).toBe("fallback");
    await advance(1);
    expect(result.current.status).toBe("idle");
  });

  it.each([
    {
      oldResult: true,
      oldStatus: "copied" as const,
      elapsedBeforeReplacement: 500,
      oldTimeRemaining: 1000,
      currentResult: false,
      currentStatus: "fallback" as const,
      currentDuration: 2000,
    },
    {
      oldResult: false,
      oldStatus: "fallback" as const,
      elapsedBeforeReplacement: 600,
      oldTimeRemaining: 1400,
      currentResult: true,
      currentStatus: "copied" as const,
      currentDuration: 1500,
    },
  ])(
    "does not let an old $oldStatus timer clear newer $currentStatus feedback",
    async ({
      oldResult,
      oldStatus,
      elapsedBeforeReplacement,
      oldTimeRemaining,
      currentResult,
      currentStatus,
      currentDuration,
    }) => {
      clipboard.copyText.mockResolvedValueOnce(oldResult).mockResolvedValueOnce(currentResult);
      const { result, rerender } = renderHook(({ text }: { text: string }) => useCopy(text), {
        initialProps: { text: FIRST_TEXT },
      });

      await flush(() => result.current.copy());
      expect(result.current.status).toBe(oldStatus);
      await advance(elapsedBeforeReplacement);

      rerender({ text: NEXT_TEXT });
      expect(result.current.status).toBe("idle");
      expect(vi.getTimerCount()).toBe(0);
      await flush(() => result.current.copy());
      expect(clipboard.copyText).toHaveBeenNthCalledWith(2, NEXT_TEXT);
      expect(result.current.status).toBe(currentStatus);

      await advance(oldTimeRemaining);
      expect(result.current.status).toBe(currentStatus);
      await advance(currentDuration - oldTimeRemaining - 1);
      expect(result.current.status).toBe(currentStatus);
      await advance(1);
      expect(result.current.status).toBe("idle");
    },
  );

  it.each([
    { order: "stale first", staleResult: true, currentResult: false, currentStatus: "fallback" as const },
    { order: "current first", staleResult: true, currentResult: false, currentStatus: "fallback" as const },
    { order: "stale first", staleResult: false, currentResult: true, currentStatus: "copied" as const },
    { order: "current first", staleResult: false, currentResult: true, currentStatus: "copied" as const },
  ])("ignores stale settlement when it resolves $order", async ({ order, staleResult, currentResult, currentStatus }) => {
    const stale = deferred<boolean>();
    const current = deferred<boolean>();
    clipboard.copyText.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const obsoleteTarget = document.createElement("pre");
    const currentTarget = document.createElement("pre");
    const target: { current: HTMLElement | null } = { current: obsoleteTarget };
    const { result, rerender } = renderHook(({ text }: { text: string }) => useCopy(text, target), {
      initialProps: { text: FIRST_TEXT },
    });

    act(() => result.current.copy());
    target.current = currentTarget;
    rerender({ text: NEXT_TEXT });
    act(() => result.current.copy());
    expect(clipboard.copyText).toHaveBeenNthCalledWith(2, NEXT_TEXT);

    if (order === "stale first") {
      await flush(() => stale.resolve(staleResult));
      expect(result.current.status).toBe("idle");
      expect(clipboard.selectContents).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }

    await flush(() => current.resolve(currentResult));
    expect(result.current.status).toBe(currentStatus);
    const selections = currentResult ? 0 : 1;
    expect(clipboard.selectContents).toHaveBeenCalledTimes(selections);
    if (selections) expect(clipboard.selectContents.mock.calls[0][0]).toBe(currentTarget);
    expect(vi.getTimerCount()).toBe(1);

    if (order === "current first") await flush(() => stale.resolve(staleResult));
    expect(result.current.status).toBe(currentStatus);
    expect(clipboard.selectContents).toHaveBeenCalledTimes(selections);
    expect(clipboard.selectContents.mock.calls.some(([selected]) => selected === obsoleteTarget)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("ignores late resolution and rejection after unmount without effects", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      for (const outcome of ["resolve", "reject"] as const) {
        const pending = deferred<boolean>();
        clipboard.copyText.mockReturnValueOnce(pending.promise);
        const target = { current: document.createElement("pre") };
        const observed: CopyStatus[] = [];
        const hook = renderHook(() => {
          const copy = useCopy(FIRST_TEXT, target);
          observed.push(copy.status);
          return copy;
        });
        act(() => hook.result.current.copy());
        const renders = observed.length;
        hook.unmount();

        await flush(() => {
          if (outcome === "resolve") pending.resolve(false);
          else pending.reject(new Error("late clipboard failure"));
        });

        expect(observed).toHaveLength(renders);
        expect(clipboard.selectContents).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
