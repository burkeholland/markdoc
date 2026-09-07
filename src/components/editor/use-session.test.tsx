// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { CollabSession, SaveState } from "@/editor/collab/session";
import type { SavedDocumentVersion } from "@/lib/document-persistence";
import { SaveIndicator } from "./header";
import { SAVED_HOLD_MS, useSettledSaveState } from "./use-session";

type FlushResult = SavedDocumentVersion | null;

function controlledSave() {
  let resolve!: (value: FlushResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<FlushResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const savedVersion: SavedDocumentVersion = {
  docId: "doc-1",
  version: "version-1",
  contentHash: "content-hash-1",
  title: "Document",
  savedAt: "2026-09-07T17:15:00.000Z",
};

/** Minimal stand-in for the session: the four fields the chip selects plus `subscribe`, and a setter that notifies. */
function fakeSession(initial: SaveState = "saved") {
  const listeners = new Set<() => void>();
  const s = {
    saveState: initial,
    unsyncedChanges: 0,
    recovered: false,
    prolongedOffline: false,
    canEdit: true,
    saveError: null as string | null,
    flushSave: vi.fn<() => Promise<FlushResult>>(async () => null),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(state: SaveState, extra: { unsynced?: number; recovered?: boolean } = {}) {
      s.saveState = state;
      s.unsyncedChanges = extra.unsynced ?? (state === "saving" ? 1 : 0);
      if (extra.recovered !== undefined) s.recovered = extra.recovered;
      listeners.forEach((l) => l());
    },
  };
  return s;
}

const asSession = (s: ReturnType<typeof fakeSession>) => s as unknown as CollabSession;

describe("useSettledSaveState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function hook(initial: SaveState, holdMs?: number) {
    type Props = { live: SaveState; hold?: number };
    return renderHook(({ live, hold }: Props) => useSettledSaveState(live, hold), {
      initialProps: { live: initial, hold: holdMs } as Props,
    });
  }

  it("holds saving → saved for exactly SAVED_HOLD_MS", () => {
    const { result, rerender } = hook("saving");
    expect(result.current).toBe("saving");

    rerender({ live: "saved" });
    expect(result.current).toBe("saving");
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(SAVED_HOLD_MS - 1));
    expect(result.current).toBe("saving");

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("saved");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never shows saved when saving returns inside the window, and a later saved restarts the full window", () => {
    const { result, rerender } = hook("saving");
    const seen: SaveState[] = [];
    const observe = () => {
      if (seen[seen.length - 1] !== result.current) seen.push(result.current);
    };
    observe();

    rerender({ live: "saved" });
    observe();
    act(() => vi.advanceTimersByTime(300));
    observe();
    rerender({ live: "saving" });
    observe();
    expect(vi.getTimerCount()).toBe(0);

    act(() => vi.advanceTimersByTime(SAVED_HOLD_MS * 2));
    observe();
    expect(seen).toEqual(["saving"]);

    rerender({ live: "saved" });
    observe();
    act(() => vi.advanceTimersByTime(SAVED_HOLD_MS - 1));
    observe();
    expect(result.current).toBe("saving");
    act(() => vi.advanceTimersByTime(1));
    observe();
    expect(seen).toEqual(["saving", "saved"]);
  });

  it.each([
    ["saving", "offline"],
    ["saving", "reconnecting"],
    ["saving", "error"],
    ["saved", "offline"],
    ["saved", "saving"],
  ] as const)("shows %s → %s immediately, without a timer", (from, to) => {
    const { result, rerender } = hook(from);
    rerender({ live: to });
    expect(result.current).toBe(to);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["connecting", "reconnecting", "offline"] as const)("shows %s → saved immediately", (from) => {
    const { result, rerender } = hook(from);
    rerender({ live: "saved" });
    expect(result.current).toBe("saved");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["connecting", "reconnecting", "offline", "error"] as const)(
    "does not hold the saved that ends a %s → saving handshake (open and recovery are unchanged)",
    (from) => {
      const { result, rerender } = hook(from);
      rerender({ live: "saving" });
      expect(result.current).toBe("saving");
      rerender({ live: "saved" });
      expect(result.current).toBe("saved");
      expect(vi.getTimerCount()).toBe(0);

      // The first run of edits on the live connection is held again.
      rerender({ live: "saving" });
      expect(result.current).toBe("saving");
      rerender({ live: "saved" });
      expect(result.current).toBe("saving");
      act(() => vi.advanceTimersByTime(SAVED_HOLD_MS));
      expect(result.current).toBe("saved");
    },
  );

  it("cancels the hold when a warning state interrupts it and settles the following handshake at once", () => {
    const { result, rerender } = hook("saved");
    rerender({ live: "saving" });
    rerender({ live: "saved" });
    expect(result.current).toBe("saving");
    rerender({ live: "offline" });
    expect(result.current).toBe("offline");
    expect(vi.getTimerCount()).toBe(0);
    rerender({ live: "reconnecting" });
    rerender({ live: "saving" });
    rerender({ live: "saved" });
    expect(result.current).toBe("saved");
  });

  it("honours a custom hold", () => {
    const { result, rerender } = hook("saving", 250);
    rerender({ live: "saved", hold: 250 });
    act(() => vi.advanceTimersByTime(249));
    expect(result.current).toBe("saving");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("saved");
  });

  it("clears the timer on unmount during the hold", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, rerender, unmount } = hook("saving");
    rerender({ live: "saved" });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(SAVED_HOLD_MS * 2));
    expect(result.current).toBe("saving");
    expect(error).not.toHaveBeenCalled();
  });
});

describe("SaveIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows pending through a burst, saving during the write and saved immediately after persistence acknowledgement", () => {
    const session = fakeSession("saved");
    render(<SaveIndicator session={asSession(session)} />);
    const pill = screen.getByTestId("save-state");
    expect(pill).toHaveAttribute("role", "status");
    expect(pill).toHaveAttribute("data-state", "saved");
    expect(pill).toHaveAttribute("data-live-state", "saved");
    expect(pill).toHaveTextContent("Saved");

    // Every DOM change here is committed inside one of the `act` calls below (React batches a session
    // notification or a timer into one commit), so sampling after each act records every distinct value.
    const texts = [pill.textContent ?? ""];
    const states = [pill.getAttribute("data-state")!];
    const liveStates = [pill.getAttribute("data-live-state")!];
    const sample = () => {
      const push = (list: string[], value: string) => {
        if (list[list.length - 1] !== value) list.push(value);
      };
      push(texts, pill.textContent ?? "");
      push(states, pill.getAttribute("data-state")!);
      push(liveStates, pill.getAttribute("data-live-state")!);
    };
    const step = (fn: () => void) => {
      act(fn);
      sample();
    };

    // Transport acknowledgements no longer drive the save state.
    for (let i = 0; i < 5; i++) {
      step(() => session.set("pending"));
      step(() => vi.advanceTimersByTime(120));
      expect(pill).toHaveAttribute("data-state", "pending");
    }
    expect(pill).toHaveTextContent("Unsaved changes");

    step(() => vi.advanceTimersByTime(1000));
    step(() => session.set("saving"));
    expect(pill).toHaveAttribute("data-state", "saving");
    step(() => session.set("saved"));
    expect(pill).toHaveAttribute("data-state", "saved");
    expect(pill).toHaveTextContent("Saved");

    expect(liveStates).toEqual(["saved", "pending", "saving", "saved"]);
    expect(states).toEqual(liveStates);
    expect(texts).toEqual(["Saved", "Unsaved changes", "Saving…", "Saved"]);
  });

  it("shows warning states and the recovery flash at once", () => {
    const session = fakeSession("saved");
    render(<SaveIndicator session={asSession(session)} />);
    const pill = screen.getByTestId("save-state");

    act(() => session.set("saving"));
    act(() => session.set("offline", { unsynced: 2 }));
    expect(pill).toHaveAttribute("data-state", "offline");
    expect(pill).toHaveAttribute("data-live-state", "offline");
    expect(pill).toHaveTextContent("Offline — 2 unsaved changes");

    act(() => session.set("reconnecting", { unsynced: 2 }));
    expect(pill).toHaveAttribute("data-state", "reconnecting");
    act(() => session.set("saving", { unsynced: 2 }));
    expect(pill).toHaveAttribute("data-state", "saving");
    act(() => session.set("saved", { recovered: true }));
    expect(pill).toHaveAttribute("data-state", "saved");
    expect(pill).toHaveAttribute("data-recovered", "true");
    expect(pill).toHaveTextContent("All changes saved");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("single-owns two immediate Save clicks until the current success settles", async () => {
    const session = fakeSession("pending");
    const save = controlledSave();
    session.flushSave.mockReturnValueOnce(save.promise);
    render(<SaveIndicator session={asSession(session)} />);
    const button = screen.getByRole("button", { name: "Save document" });

    act(() => {
      button.focus();
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(session.flushSave).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveFocus();
    expect(screen.getByTestId("save-state")).toHaveTextContent("Unsaved changes");

    await act(async () => {
      save.resolve(savedVersion);
      await Promise.resolve();
    });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(screen.getByTestId("save-state")).not.toHaveTextContent("Save failed");
  });

  it("clears the old failure on retry and publishes a new current failure", async () => {
    const session = fakeSession("pending");
    const first = controlledSave();
    const retry = controlledSave();
    const recovered = controlledSave();
    session.flushSave
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(retry.promise)
      .mockReturnValueOnce(recovered.promise);
    render(<SaveIndicator session={asSession(session)} />);
    const button = screen.getByRole("button", { name: "Save document" });

    fireEvent.click(button);
    await act(async () => {
      first.reject(new Error("Store unavailable"));
      await Promise.resolve();
    });
    expect(session.flushSave).toHaveBeenCalledOnce();
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(screen.getByTestId("save-state")).toHaveTextContent("Store unavailable");
    expect(screen.getByTestId("save-state")).toHaveAttribute("title", "Store unavailable");

    fireEvent.click(button);
    expect(session.flushSave).toHaveBeenCalledTimes(2);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("save-state")).not.toHaveTextContent("Store unavailable");
    expect(screen.getByTestId("save-state")).not.toHaveAttribute("title");

    await act(async () => {
      retry.reject(new Error("Retry unavailable"));
      await Promise.resolve();
    });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(screen.getByTestId("save-state")).toHaveTextContent("Retry unavailable");
    expect(screen.getByTestId("save-state")).toHaveAttribute("title", "Retry unavailable");

    fireEvent.click(button);
    expect(session.flushSave).toHaveBeenCalledTimes(3);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("save-state")).not.toHaveTextContent("Retry unavailable");

    await act(async () => {
      recovered.resolve(savedVersion);
      await Promise.resolve();
    });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(screen.getByTestId("save-state")).not.toHaveTextContent("Retry unavailable");
  });

  it("treats an already-saved result as the current success without changing the save state", async () => {
    const session = fakeSession("saved");
    const save = controlledSave();
    session.flushSave.mockReturnValueOnce(save.promise);
    render(<SaveIndicator session={asSession(session)} />);
    const button = screen.getByRole("button", { name: "Save document" });

    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("save-state")).toHaveTextContent("Saved");

    await act(async () => {
      save.resolve(null);
      await Promise.resolve();
    });
    expect(session.flushSave).toHaveBeenCalledOnce();
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(screen.getByTestId("save-state")).toHaveTextContent("Saved");
  });

  it.each(["success", "failure"] as const)(
    "keeps replacement Save owned when the old session reaches a stale %s",
    async (oldSettlement) => {
      const first = fakeSession("pending");
      const oldSave = controlledSave();
      first.flushSave.mockReturnValueOnce(oldSave.promise);
      const { rerender } = render(<SaveIndicator session={asSession(first)} />);
      fireEvent.click(screen.getByRole("button", { name: "Save document" }));
      expect(first.flushSave).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Save document" })).toBeDisabled();

      const second = fakeSession("pending");
      const currentSave = controlledSave();
      second.flushSave.mockReturnValueOnce(currentSave.promise);
      rerender(<SaveIndicator session={asSession(second)} />);
      const replacementButton = screen.getByRole("button", { name: "Save document" });
      expect(replacementButton).toBeEnabled();
      expect(replacementButton).not.toHaveAttribute("aria-busy");

      fireEvent.click(replacementButton);
      expect(first.flushSave).toHaveBeenCalledOnce();
      expect(second.flushSave).toHaveBeenCalledOnce();
      expect(replacementButton).toBeDisabled();
      expect(replacementButton).toHaveAttribute("aria-busy", "true");

      await act(async () => {
        if (oldSettlement === "success") oldSave.resolve(savedVersion);
        else oldSave.reject(new Error("Old document failed"));
        await Promise.resolve();
      });
      expect(replacementButton).toBeDisabled();
      expect(replacementButton).toHaveAttribute("aria-busy", "true");
      expect(screen.getByTestId("save-state")).not.toHaveTextContent("Old document failed");

      await act(async () => {
        if (oldSettlement === "success") currentSave.reject(new Error("Current document failed"));
        else currentSave.resolve(savedVersion);
        await Promise.resolve();
      });
      expect(replacementButton).toBeEnabled();
      expect(replacementButton).not.toHaveAttribute("aria-busy");
      if (oldSettlement === "success") {
        expect(screen.getByTestId("save-state")).toHaveTextContent("Current document failed");
      } else {
        expect(screen.getByTestId("save-state")).not.toHaveTextContent("Old document failed");
      }
    },
  );

  it.each(["success", "failure"] as const)("ignores a pending Save settlement after unmount (%s)", async (settlement) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = fakeSession("pending");
    const save = controlledSave();
    first.flushSave.mockReturnValueOnce(save.promise);
    const { unmount } = render(<SaveIndicator session={asSession(first)} />);
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));
    expect(first.flushSave).toHaveBeenCalledOnce();
    unmount();

    await act(async () => {
      if (settlement === "success") save.resolve(savedVersion);
      else save.reject(new Error("Unmounted document failed"));
      await Promise.resolve();
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps Save unavailable without edit permission", () => {
    const session = fakeSession("pending");
    session.canEdit = false;
    render(<SaveIndicator session={asSession(session)} />);
    const button = screen.getByRole("button", { name: "Save document" });

    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("aria-busy");
    fireEvent.click(button);
    expect(session.flushSave).not.toHaveBeenCalled();
  });
});
