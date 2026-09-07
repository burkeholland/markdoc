// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

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

  it("retires old feedback on a text change without letting its timer clear newer feedback", async () => {
    clipboard.copyText.mockResolvedValue(true);
    const { result, rerender } = renderHook(({ text }: { text: string }) => useCopy(text), {
      initialProps: { text: FIRST_TEXT },
    });

    await flush(() => result.current.copy());
    expect(result.current.status).toBe("copied");
    await advance(500);

    rerender({ text: NEXT_TEXT });
    expect(result.current.status).toBe("idle");
    await flush(() => result.current.copy());
    expect(clipboard.copyText).toHaveBeenNthCalledWith(2, NEXT_TEXT);
    expect(result.current.status).toBe("copied");

    await advance(1000);
    expect(result.current.status).toBe("copied");
    await advance(499);
    expect(result.current.status).toBe("copied");
    await advance(1);
    expect(result.current.status).toBe("idle");
  });

  it.each([
    { staleResult: true, currentResult: false, currentStatus: "fallback" as const },
    { staleResult: false, currentResult: true, currentStatus: "copied" as const },
  ])("ignores stale settlement after a new rendered value owns Copy", async ({ staleResult, currentResult, currentStatus }) => {
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

    await flush(() => current.resolve(currentResult));
    expect(result.current.status).toBe(currentStatus);
    const selections = currentResult ? 0 : 1;
    expect(clipboard.selectContents).toHaveBeenCalledTimes(selections);
    if (selections) expect(clipboard.selectContents.mock.calls[0][0]).toBe(currentTarget);
    expect(vi.getTimerCount()).toBe(1);

    await flush(() => stale.resolve(staleResult));
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
