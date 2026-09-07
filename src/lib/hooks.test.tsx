// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";

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

function CopyControl({ text, observe }: { text: string; observe: (copy: CopyResult) => void }) {
  const copy = useCopy(text);
  observe(copy);
  return (
    <button data-testid="copy-control" onClick={copy.copy} aria-label={copy.label}>
      {copy.label}
    </button>
  );
}

function CopyBoundary({
  text,
  boundary = 0,
  observe,
  onLayout,
}: {
  text: string;
  boundary?: number;
  observe: (copy: CopyResult) => void;
  onLayout?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onLayout?.();
  }, [boundary, onLayout]);
  return <CopyControl text={text} observe={observe} />;
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

beforeEach(() => {
  vi.useFakeTimers();
  clipboard.copyText.mockReset();
  clipboard.selectContents.mockReset();
});

afterEach(() => {
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
