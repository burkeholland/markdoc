// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import {
  StrictMode,
  useLayoutEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { createRoot, type Root } from "react-dom/client";
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
    dirty: false,
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

interface ReactFiber {
  ref?: unknown;
}

function reactProperty<T>(element: Element, name: string): T | undefined {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached while capturing ${name}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  return props?.[name] as T | undefined;
}

function reactHandler<T extends (...args: never[]) => unknown>(element: Element, name: string): T {
  const handler = reactProperty<T>(element, name);
  if (typeof handler !== "function") throw new Error(`${name} was not attached`);
  return handler;
}

function reactRef<T extends Element>(element: T): RefCallback<T> {
  const direct = reactProperty<RefCallback<T>>(element, "ref");
  if (typeof direct === "function") return direct;
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error("React fiber was not attached while capturing ref");
  const fiber = (element as unknown as Record<string, ReactFiber>)[fiberKey];
  if (typeof fiber.ref !== "function") throw new Error("A callback ref was not attached");
  return fiber.ref as RefCallback<T>;
}

type SaveClick = (event: ReactMouseEvent<HTMLButtonElement>) => void;
type SaveRootClick = (event: ReactMouseEvent<HTMLSpanElement>) => void;

interface SaveControl {
  root: HTMLSpanElement;
  button: HTMLButtonElement;
  icon: SVGSVGElement;
  text: HTMLSpanElement;
  rootClick: SaveRootClick;
  click: SaveClick;
  rootRef: RefCallback<HTMLSpanElement>;
  buttonRef: RefCallback<HTMLButtonElement>;
  iconRef: RefCallback<SVGSVGElement>;
  textRef: RefCallback<HTMLSpanElement>;
}

function captureSave(root: ParentNode = document): SaveControl {
  const status = root.querySelector('[data-testid="save-state"]');
  const button = status?.firstElementChild;
  const icon = button?.children.item(0);
  const text = button?.children.item(1);
  if (
    !(status instanceof HTMLSpanElement)
    || !(button instanceof HTMLButtonElement)
    || !(icon instanceof SVGSVGElement)
    || !(text instanceof HTMLSpanElement)
  ) {
    throw new Error("The SaveIndicator presentation was incomplete");
  }
  return {
    root: status,
    button,
    icon,
    text,
    rootClick: reactHandler(status, "onClickCapture"),
    click: reactHandler(button, "onClickCapture"),
    rootRef: reactRef(status),
    buttonRef: reactRef(button),
    iconRef: reactRef(icon),
    textRef: reactRef(text),
  };
}

function directSaveClick(
  control: SaveControl,
  nativeEvent: Event = new MouseEvent("click", { bubbles: true, cancelable: true }),
) {
  const mouse = nativeEvent instanceof MouseEvent ? nativeEvent : null;
  control.click({
    type: nativeEvent.type,
    currentTarget: control.button,
    target: control.button,
    nativeEvent,
    button: mouse?.button ?? 0,
    buttons: mouse?.buttons ?? 0,
    altKey: mouse?.altKey ?? false,
    ctrlKey: mouse?.ctrlKey ?? false,
    metaKey: mouse?.metaKey ?? false,
    shiftKey: mouse?.shiftKey ?? false,
    clientX: mouse?.clientX ?? 0,
    clientY: mouse?.clientY ?? 0,
    detail: mouse?.detail ?? 0,
    bubbles: nativeEvent.bubbles,
    cancelable: nativeEvent.cancelable,
    eventPhase: nativeEvent.eventPhase,
    isTrusted: nativeEvent.isTrusted,
    timeStamp: nativeEvent.timeStamp,
    defaultPrevented: false,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    isDefaultPrevented: () => false,
    isPropagationStopped: () => false,
    persist: () => undefined,
  } as unknown as ReactMouseEvent<HTMLButtonElement>);
}

function SaveLayoutCapture({ capture }: { capture: () => void }) {
  useLayoutEffect(() => {
    capture();
  });
  return null;
}

function RemoveSaveDuringReplay({
  session,
  remove,
}: {
  session: ReturnType<typeof fakeSession>;
  remove: () => boolean;
}) {
  const [present, setPresent] = useState(true);
  useLayoutEffect(() => {
    if (remove()) setPresent(false);
  }, [remove]);
  return present ? <SaveIndicator session={asSession(session)} /> : null;
}

function saveTree({
  session,
  revision = 0,
  compact,
  capture,
}: {
  session: ReturnType<typeof fakeSession>;
  revision?: number;
  compact?: boolean;
  capture?: () => void;
}) {
  void revision;
  return (
    <StrictMode>
      <section data-testid="save-higher">
        <i data-testid="save-before" />
        <div data-testid="save-parent">
          <SaveIndicator session={asSession(session)} compact={compact} />
        </div>
        <i data-testid="save-after" />
        {capture && <SaveLayoutCapture capture={capture} />}
      </section>
    </StrictMode>
  );
}

interface DirectSaveRoot {
  host: HTMLDivElement;
  root: Root;
  render: (node: ReactNode) => void;
  unmount: () => void;
}

function directSaveRoot(node: ReactNode): DirectSaveRoot {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return {
    host,
    root,
    render: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

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

  it("retires the first Strict Mode publication and lets only its exact successor Save", async () => {
    const session = fakeSession("pending");
    const save = controlledSave();
    session.flushSave.mockReturnValueOnce(save.promise);
    const layouts: SaveControl[] = [];
    const view = directSaveRoot(saveTree({
      session,
      capture: () => layouts.push(captureSave()),
    }));
    try {
      const retired = layouts[0];
      const current = captureSave(view.host);
      if (!retired) throw new Error("Strict Mode did not expose its first Save publication");
      expect(retired.button).toBe(current.button);
      expect(retired.click).not.toBe(current.click);

      act(() => directSaveClick(retired));
      expect(session.flushSave).not.toHaveBeenCalled();

      act(() => {
        current.button.focus();
        current.button.click();
        current.button.click();
      });
      expect(session.flushSave).toHaveBeenCalledOnce();
      expect(current.button).toBeDisabled();
      expect(current.button).toHaveAttribute("aria-busy", "true");
      expect(current.button).toHaveFocus();

      await act(async () => {
        save.resolve(savedVersion);
        await Promise.resolve();
      });
      expect(current.button).toBeEnabled();
      expect(current.button).not.toHaveAttribute("aria-busy");
    } finally {
      view.unmount();
    }
  });

  it.each([
    "icon attribute",
    "root comment",
    "button text node",
    "nested same-text markup",
  ] as const)("does not canonize pre-publication %s", (tampering) => {
    const session = fakeSession("pending");
    const save = controlledSave();
    session.flushSave.mockReturnValue(save.promise);
    let setup = 0;
    let restore = () => {};
    const tamperBeforePublication = () => {
      setup++;
      if (setup !== 1) return;
      const current = captureSave();
      if (tampering === "icon attribute") {
        current.icon.setAttribute("data-tampered", "true");
        restore = () => current.icon.removeAttribute("data-tampered");
      } else if (tampering === "root comment") {
        const comment = current.root.ownerDocument.createComment("tampered");
        current.root.append(comment);
        restore = () => comment.remove();
      } else if (tampering === "button text node") {
        const extraText = current.button.ownerDocument.createTextNode("");
        current.button.append(extraText);
        restore = () => extraText.remove();
      } else {
        const expectedText = current.text.textContent ?? "";
        const nested = current.text.ownerDocument.createElement("b");
        nested.textContent = expectedText;
        current.text.replaceChildren(nested);
        restore = () => current.text.replaceChildren(
          current.text.ownerDocument.createTextNode(expectedText),
        );
      }
    };
    const tree = (revision: number) => {
      void revision;
      return (
        <StrictMode>
          <section>
            <SaveLayoutCapture capture={tamperBeforePublication} />
            <div>
              <SaveIndicator session={asSession(session)} />
            </div>
          </section>
        </StrictMode>
      );
    };
    const view = directSaveRoot(tree(0));
    try {
      const tampered = captureSave(view.host);
      act(() => tampered.button.click());
      expect(session.flushSave).not.toHaveBeenCalled();

      restore();
      act(() => tampered.button.click());
      expect(session.flushSave).not.toHaveBeenCalled();

      view.render(tree(1));
      act(() => captureSave(view.host).button.click());
      expect(session.flushSave).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
    }
  });

  it("releases the document observer when unmounted during replay handoff", async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const session = fakeSession("pending");
    let setup = 0;
    const view = directSaveRoot(
      <StrictMode>
        <RemoveSaveDuringReplay
          session={session}
          remove={() => ++setup === 2}
        />
      </StrictMode>,
    );
    try {
      await act(async () => {
        await Promise.resolve();
      });
      expect(view.host).toBeEmptyDOMElement();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it("rejects a custom-prototype wrapper passed through both handlers during a live native click", () => {
    const session = fakeSession("pending");
    const save = controlledSave();
    session.flushSave.mockReturnValue(save.promise);
    const host = document.createElement("div");
    document.body.append(host);
    let current: SaveControl | null = null;
    const intercept = (nativeEvent: Event) => {
      const control = current;
      if (!control || !(nativeEvent instanceof MouseEvent)) return;
      function ForgedSyntheticEvent() {}
      const customPrototype = ForgedSyntheticEvent.prototype;
      const wrapper = Object.assign(Object.create(customPrototype), {
        type: "click",
        currentTarget: control.root as EventTarget | null,
        target: control.button,
        nativeEvent,
        button: nativeEvent.button,
        buttons: nativeEvent.buttons,
        altKey: nativeEvent.altKey,
        ctrlKey: nativeEvent.ctrlKey,
        metaKey: nativeEvent.metaKey,
        shiftKey: nativeEvent.shiftKey,
        clientX: nativeEvent.clientX,
        clientY: nativeEvent.clientY,
        detail: nativeEvent.detail,
        bubbles: nativeEvent.bubbles,
        cancelable: nativeEvent.cancelable,
        eventPhase: nativeEvent.eventPhase,
        isTrusted: nativeEvent.isTrusted,
        timeStamp: nativeEvent.timeStamp,
        defaultPrevented: false,
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
        isDefaultPrevented: () => false,
        isPropagationStopped: () => false,
        persist: () => undefined,
      });
      expect(customPrototype.constructor).toBe(ForgedSyntheticEvent);
      expect(ForgedSyntheticEvent.prototype).toBe(customPrototype);
      control.rootClick(wrapper as ReactMouseEvent<HTMLSpanElement>);
      wrapper.currentTarget = null;
      wrapper.currentTarget = control.button;
      control.click(wrapper as ReactMouseEvent<HTMLButtonElement>);
      session.canEdit = false;
      control.root.addEventListener("click", () => {
        session.canEdit = true;
      }, { capture: true, once: true });
    };
    host.addEventListener("click", intercept, { capture: true, once: true });
    const root = createRoot(host);
    try {
      act(() => root.render(saveTree({ session })));
      current = captureSave(host);
      act(() => current?.button.click());
      expect(session.flushSave).not.toHaveBeenCalled();

      act(() => current?.button.click());
      expect(session.flushSave).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("keeps Strict Mode failure and retry publication ownership exact", async () => {
    const session = fakeSession("pending");
    const failed = controlledSave();
    const retried = controlledSave();
    session.flushSave
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retried.promise);
    const view = directSaveRoot(saveTree({ session }));
    try {
      act(() => captureSave(view.host).button.click());
      await act(async () => {
        failed.reject(new Error("Strict store unavailable"));
        await Promise.resolve();
      });
      const retry = captureSave(view.host);
      expect(retry.button).toBeEnabled();
      expect(retry.root).toHaveTextContent("Strict store unavailable");
      expect(retry.root).toHaveAttribute("title", "Strict store unavailable");

      act(() => {
        retry.button.click();
        retry.button.click();
      });
      expect(session.flushSave).toHaveBeenCalledTimes(2);
      expect(retry.button).toBeDisabled();
      expect(retry.root).not.toHaveTextContent("Strict store unavailable");

      await act(async () => {
        retried.resolve(savedVersion);
        await Promise.resolve();
      });
      expect(retry.button).toBeEnabled();
      expect(retry.root).not.toHaveAttribute("title");
    } finally {
      view.unmount();
    }
  });

  it.each([
    "root",
    "button",
    "icon",
    "text",
  ] as const)("rejects a partial %s ref replay, then admits a fresh exact successor", (part) => {
    const session = fakeSession("pending");
    const save = controlledSave();
    session.flushSave.mockReturnValue(save.promise);
    let setup = 0;
    let retired: SaveControl | null = null;
    const capture = () => {
      setup++;
      if (setup === 1) {
        retired = captureSave();
      } else if (setup === 2 && retired) {
        const refs = {
          root: retired.rootRef,
          button: retired.buttonRef,
          icon: retired.iconRef,
          text: retired.textRef,
        };
        refs[part](null);
      }
    };
    const view = directSaveRoot(saveTree({ session, capture }));
    try {
      act(() => captureSave(view.host).button.click());
      expect(session.flushSave).not.toHaveBeenCalled();
      const retiredControl = retired;
      if (!retiredControl) throw new Error("Strict Mode did not publish a replay source");
      act(() => directSaveClick(retiredControl));
      expect(session.flushSave).not.toHaveBeenCalled();

      view.render(saveTree({ session, revision: 1 }));
      act(() => captureSave(view.host).button.click());
      expect(session.flushSave).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
    }
  });

  it.each([
    "root attribute",
    "text",
    "root detach",
    "parent detach",
    "higher detach",
    "adjacent placement",
  ] as const)("permanently retires replay after %s mutation and restores only through a fresh render", (change) => {
    const session = fakeSession("pending");
    const save = controlledSave();
    session.flushSave.mockReturnValue(save.promise);
    let setup = 0;
    const capture = () => {
      setup++;
      if (setup !== 2) return;
      const current = captureSave();
      const parent = screen.getByTestId("save-parent");
      const higher = screen.getByTestId("save-higher");
      if (change === "root attribute") {
        current.root.dataset.state = "changed";
        current.root.dataset.state = "pending";
      } else if (change === "text") {
        current.text.textContent = "Changed";
        current.text.textContent = "Unsaved changes";
      } else if (change === "root detach") {
        const next = current.root.nextSibling;
        current.root.remove();
        parent.insertBefore(current.root, next);
      } else if (change === "parent detach") {
        const next = parent.nextSibling;
        parent.remove();
        higher.insertBefore(parent, next);
      } else if (change === "higher detach") {
        const container = higher.parentNode;
        const next = higher.nextSibling;
        if (!container) throw new Error("The higher Save ancestor had no parent");
        higher.remove();
        container.insertBefore(higher, next);
      } else {
        const adjacent = document.createElement("b");
        higher.insertBefore(adjacent, parent);
        adjacent.remove();
      }
    };
    const view = directSaveRoot(saveTree({ session, capture }));
    try {
      act(() => captureSave(view.host).button.click());
      expect(session.flushSave).not.toHaveBeenCalled();

      view.render(saveTree({ session, revision: 1 }));
      act(() => captureSave(view.host).button.click());
      expect(session.flushSave).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
    }
  });

  it("allows genuinely nonadjacent ancestor churn during replay", () => {
    const session = fakeSession("pending");
    const save = controlledSave();
    session.flushSave.mockReturnValue(save.promise);
    let setup = 0;
    const capture = () => {
      setup++;
      if (setup !== 2) return;
      const higher = screen.getByTestId("save-higher");
      const before = screen.getByTestId("save-before");
      const distant = document.createElement("b");
      higher.insertBefore(distant, before);
      distant.remove();
    };
    const view = directSaveRoot(saveTree({ session, capture }));
    try {
      act(() => captureSave(view.host).button.click());
      expect(session.flushSave).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
    }
  });

  it.each([
    "canEdit",
    "flushSave",
    "saveState",
    "unsyncedChanges",
    "dirty",
    "recovered",
    "prolongedOffline",
    "saveError",
  ] as const)("revalidates the live %s primitive before accepting Save", (field) => {
    const session = fakeSession("pending");
    const original = session[field];
    const replacement = vi.fn<() => Promise<FlushResult>>(async () => null);
    const view = directSaveRoot(saveTree({ session }));
    try {
      if (field === "canEdit") session.canEdit = false;
      else if (field === "flushSave") session.flushSave = replacement;
      else if (field === "saveState") session.saveState = "offline";
      else if (field === "unsyncedChanges") session.unsyncedChanges = 2;
      else if (field === "dirty") session.dirty = true;
      else if (field === "recovered") session.recovered = true;
      else if (field === "prolongedOffline") session.prolongedOffline = true;
      else session.saveError = "Changed error";

      act(() => captureSave(view.host).button.click());
      expect(session.flushSave).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();

      Object.assign(session, { [field]: original });
      act(() => captureSave(view.host).button.click());
      expect(session.flushSave).toHaveBeenCalledOnce();
      expect(replacement).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it.each([
    ["dirty", 1, false, 1, true],
    ["unsyncedChanges", 0, true, 1, true],
  ] as const)(
    "rejects masked %s drift even when the computed unsynced count stays one",
    (field, beforeUnsynced, beforeDirty, afterUnsynced, afterDirty) => {
      const session = fakeSession("pending");
      session.unsyncedChanges = beforeUnsynced;
      session.dirty = beforeDirty;
      const save = controlledSave();
      session.flushSave.mockReturnValue(save.promise);
      const view = directSaveRoot(saveTree({ session }));
      try {
        const stale = captureSave(view.host);
        session.unsyncedChanges = afterUnsynced;
        session.dirty = afterDirty;
        expect(Math.max(beforeUnsynced, beforeDirty ? 1 : 0)).toBe(1);
        expect(Math.max(afterUnsynced, afterDirty ? 1 : 0)).toBe(1);

        act(() => stale.button.click());
        expect(session.flushSave).not.toHaveBeenCalled();

        session.unsyncedChanges = beforeUnsynced;
        session.dirty = beforeDirty;
        act(() => stale.button.click());
        expect(session.flushSave).toHaveBeenCalledOnce();
      } finally {
        view.unmount();
      }
    },
  );

  it("claims the publication, action, wrapper, native event, and request before reentrant Save work", async () => {
    const session = fakeSession("pending");
    const save = controlledSave();
    const view = directSaveRoot(saveTree({ session }));
    try {
      const current = captureSave(view.host);
      session.flushSave.mockImplementationOnce(() => {
        current.button.click();
        directSaveClick(current);
        return save.promise;
      });
      const wrongNative = new Event("click", { bubbles: true, cancelable: true });
      const detachedNative = new MouseEvent("click", { bubbles: true, cancelable: true });

      act(() => {
        directSaveClick(current, wrongNative);
        directSaveClick(current, detachedNative);
        current.button.click();
        current.button.click();
      });
      expect(session.flushSave).toHaveBeenCalledOnce();
      expect(current.button).toBeDisabled();

      await act(async () => {
        save.resolve(savedVersion);
        await Promise.resolve();
      });
      const successor = captureSave(view.host);
      const next = controlledSave();
      session.flushSave.mockReturnValueOnce(next.promise);
      act(() => successor.button.click());
      expect(session.flushSave).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
    }
  });

  it.each(["session", "callback"] as const)(
    "retires the old %s handler before the exact same-looking replacement can Save",
    (replacement) => {
      const first = fakeSession("pending");
      let current = first;
      const oldFlush = first.flushSave;
      const nextFlush = vi.fn<() => Promise<FlushResult>>(() => controlledSave().promise);
      const view = directSaveRoot(saveTree({ session: first }));
      try {
        const stale = captureSave(view.host);
        if (replacement === "session") {
          current = fakeSession("pending");
          current.flushSave = nextFlush;
        } else {
          first.flushSave = nextFlush;
        }
        view.render(saveTree({ session: current, revision: 1 }));
        const successor = captureSave(view.host);
        expect(successor.button).toBe(stale.button);
        expect(successor.click).not.toBe(stale.click);

        act(() => directSaveClick(stale));
        expect(oldFlush).not.toHaveBeenCalled();
        expect(nextFlush).not.toHaveBeenCalled();

        act(() => successor.button.click());
        expect(oldFlush).not.toHaveBeenCalled();
        expect(nextFlush).toHaveBeenCalledOnce();
      } finally {
        view.unmount();
      }
    },
  );

  it.each(["success", "failure"] as const)(
    "keeps B request and status exact through late A %s and finally",
    async (settlement) => {
      const first = fakeSession("pending");
      const firstSave = controlledSave();
      first.flushSave.mockReturnValueOnce(firstSave.promise);
      const second = fakeSession("pending");
      const secondSave = controlledSave();
      second.flushSave.mockReturnValueOnce(secondSave.promise);
      const view = directSaveRoot(saveTree({ session: first }));
      try {
        act(() => captureSave(view.host).button.click());
        expect(first.flushSave).toHaveBeenCalledOnce();

        view.render(saveTree({ session: second, revision: 1 }));
        const current = captureSave(view.host);
        expect(current.button).toBeEnabled();
        act(() => current.button.click());
        expect(second.flushSave).toHaveBeenCalledOnce();
        expect(current.button).toBeDisabled();

        await act(async () => {
          if (settlement === "success") firstSave.resolve(savedVersion);
          else firstSave.reject(new Error("Late A failure"));
          await Promise.resolve();
        });
        expect(current.button).toBeDisabled();
        expect(current.button).toHaveAttribute("aria-busy", "true");
        expect(captureSave(view.host).root).not.toHaveTextContent("Late A failure");

        await act(async () => {
          secondSave.resolve(savedVersion);
          await Promise.resolve();
        });
        expect(current.button).toBeEnabled();
        act(() => current.button.click());
        expect(second.flushSave).toHaveBeenCalledTimes(2);
      } finally {
        view.unmount();
      }
    },
  );

  it.each(["success", "failure"] as const)(
    "does not publish a Strict Mode request settlement after unmount (%s)",
    async (settlement) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const session = fakeSession("pending");
      const save = controlledSave();
      session.flushSave.mockReturnValueOnce(save.promise);
      const view = directSaveRoot(saveTree({ session }));
      act(() => captureSave(view.host).button.click());
      view.unmount();

      await act(async () => {
        if (settlement === "success") save.resolve(savedVersion);
        else save.reject(new Error("Unmounted Strict save"));
        await Promise.resolve();
      });
      expect(error).not.toHaveBeenCalled();
    },
  );
});
