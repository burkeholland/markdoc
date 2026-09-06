// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { CollabSession, SaveState } from "@/editor/collab/session";
import { SaveIndicator } from "./header";
import { SAVED_HOLD_MS, useSettledSaveState } from "./use-session";

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
    flushSave: vi.fn(async () => null),
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

  it("offers explicit Save and surfaces a rejected persistence acknowledgement", async () => {
    const session = fakeSession("pending");
    session.flushSave.mockRejectedValueOnce(new Error("Store unavailable"));
    render(<SaveIndicator session={asSession(session)} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save document" })));
    expect(session.flushSave).toHaveBeenCalledOnce();
    expect(screen.getByTestId("save-state")).toHaveTextContent("Store unavailable");
    act(() => session.set("saved"));
    expect(screen.getByTestId("save-state")).toHaveTextContent("Saved");
  });

  it("does not show an old document's failed save after switching documents", async () => {
    const first = fakeSession("pending");
    let reject!: (error: Error) => void;
    first.flushSave.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
    const { rerender } = render(<SaveIndicator session={asSession(first)} />);
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));
    const second = fakeSession("saved");
    rerender(<SaveIndicator session={asSession(second)} />);
    await act(async () => reject(new Error("Old document failed")));
    expect(screen.getByTestId("save-state")).toHaveTextContent("Saved");
    expect(screen.getByTestId("save-state")).not.toHaveTextContent("Old document failed");
  });
});
