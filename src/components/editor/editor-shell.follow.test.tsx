// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import * as Y from "yjs";

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  return {
    HocuspocusProvider: class {
      awareness: InstanceType<typeof Awareness>;
      constructor(opts: { document: Y.Doc }) { this.awareness = new Awareness(opts.document); }
      destroy() { this.awareness.destroy(); }
    },
  };
});

import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { EditorActions } from "./actions";
import { useCollaboratorFollowVisit } from "./editor-shell";

type FollowOptions = Parameters<typeof useCollaboratorFollowVisit>[0];
type FollowEventType = "wheel" | "touchmove" | "beforeinput" | "keydown";

interface FollowTimerRecord {
  readonly callback: () => void;
  readonly handle: ReturnType<typeof setTimeout>;
  pending: boolean;
  cleared: boolean;
}

interface ListenerRecord {
  readonly target: EventTarget;
  readonly type: FollowEventType;
  readonly listener: EventListenerOrEventListenerObject;
  readonly capture: boolean;
  readonly passive: boolean;
  active: boolean;
}

const sessions: CollabSession[] = [];

function session(id: string): CollabSession {
  const value = new CollabSession({
    docId: `doc-${id}`,
    user: makeCollabUser(id, id),
    role: "owner",
    autoConnect: false,
    getToken: async () => { throw new Error("No provider connection permitted"); },
  });
  value.followUserId = "collaborator";
  sessions.push(value);
  return value;
}

function actionOwner(owner: CollabSession) {
  const actions = new EditorActions(owner, () => {});
  const scroll = vi.spyOn(actions, "scrollToSource").mockImplementation(() => {});
  return { actions, scroll };
}

function options(
  owner: CollabSession,
  actions: EditorActions,
  values: Partial<Omit<FollowOptions, "session" | "actions">> = {},
): FollowOptions {
  return {
    session: owner,
    actions,
    richView: null,
    codeView: null,
    richScroller: null,
    showCode: true,
    showRich: true,
    syncScroll: true,
    userId: "collaborator",
    cursor: 17,
    ...values,
  };
}

function FollowHarness(props: FollowOptions) {
  useCollaboratorFollowVisit(props);
  return null;
}

function ParentLayoutBoundary({
  visit,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  visit: FollowOptions;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <FollowHarness {...visit} /> : null;
}

function trackFollowTimers(reuseHandle = false) {
  const records: FollowTimerRecord[] = [];
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const reused = 3076 as unknown as ReturnType<typeof setTimeout>;

  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay !== 150 || typeof callback !== "function") {
      return nativeSetTimeout(callback, delay, ...args);
    }
    const handle = reuseHandle
      ? reused
      : (3076 + records.length) as unknown as ReturnType<typeof setTimeout>;
    records.push({
      callback: () => callback(...args),
      handle,
      pending: true,
      cleared: false,
    });
    return handle;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    const record = records.findLast((candidate) => candidate.pending && candidate.handle === handle);
    if (!record) {
      nativeClearTimeout(handle);
      return;
    }
    record.pending = false;
    record.cleared = true;
  });

  return {
    records,
    fire(record: FollowTimerRecord) {
      record.pending = false;
      record.callback();
    },
    pending() {
      return records.filter((record) => record.pending);
    },
  };
}

function captureOption(options: boolean | AddEventListenerOptions | undefined, key: "capture" | "passive"): boolean {
  if (typeof options === "boolean") return key === "capture" && options;
  return options?.[key] === true;
}

function trackFollowListeners(targets: readonly EventTarget[]) {
  const types = new Set<FollowEventType>(["wheel", "touchmove", "beforeinput", "keydown"]);
  const added: ListenerRecord[] = [];
  const removed: ListenerRecord[] = [];

  for (const target of new Set(targets)) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, listener, eventOptions) => {
      if (types.has(type as FollowEventType) && listener) {
        added.push({
          target,
          type: type as FollowEventType,
          listener,
          capture: captureOption(eventOptions, "capture"),
          passive: captureOption(eventOptions, "passive"),
          active: true,
        });
      }
      add(type, listener, eventOptions);
    });
    vi.spyOn(target, "removeEventListener").mockImplementation((type, listener, eventOptions) => {
      if (types.has(type as FollowEventType) && listener) {
        const capture = captureOption(eventOptions, "capture");
        const active = added.find(
          (record) =>
            record.active &&
            record.target === target &&
            record.type === type &&
            record.listener === listener &&
            record.capture === capture,
        );
        if (active) active.active = false;
        removed.push({
          target,
          type: type as FollowEventType,
          listener,
          capture,
          passive: captureOption(eventOptions, "passive"),
          active: false,
        });
      }
      remove(type, listener, eventOptions);
    });
  }

  return { added, removed, active: () => added.filter((record) => record.active) };
}

function invoke(record: ListenerRecord, event: Event) {
  if (typeof record.listener === "function") {
    record.listener.call(record.target, event);
  } else {
    record.listener.handleEvent(event);
  }
}

function captureOwner(records: readonly ListenerRecord[], start: number): ListenerRecord[] {
  return records.slice(start);
}

function expectOwnerRetired(records: readonly ListenerRecord[]) {
  expect(records).not.toHaveLength(0);
  expect(records.filter((record) => record.active)).toHaveLength(0);
}

function expectBalancedListeners(tracker: ReturnType<typeof trackFollowListeners>) {
  expect(tracker.active()).toHaveLength(0);
  expect(tracker.removed).toHaveLength(tracker.added.length);
  tracker.added.forEach((added, index) => {
    const removed = tracker.removed[index];
    expect(removed).toMatchObject({
      target: added.target,
      type: added.type,
      listener: added.listener,
      capture: added.capture,
    });
  });
}

function staleEvents(records: readonly ListenerRecord[]): Event[] {
  return records.map((record) => {
    if (record.type === "keydown") return new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    return new Event(record.type, { cancelable: true });
  });
}

afterEach(() => {
  cleanup();
  for (const value of sessions.splice(0)) value.destroy();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("collaborator follow visit ownership", () => {
  it.each([
    ["stale before current", "stale-current"],
    ["current before stale", "current-stale"],
  ] as const)("keeps a replacement session authoritative with reused targets, handles, and equal cursor values: %s", (_name, order) => {
    const shared = document.createElement("div");
    const focusOwner = document.createElement("button");
    const marker = document.createElement("div");
    marker.dataset.state = "unchanged";
    document.body.append(shared, focusOwner, marker);
    focusOwner.focus();

    const timers = trackFollowTimers(true);
    const listeners = trackFollowListeners([shared, window]);
    const oldSession = session("old");
    const currentSession = session("current");
    const oldDispatch = vi.spyOn(oldSession, "dispatchFollow");
    const currentDispatch = vi.spyOn(currentSession, "dispatchFollow");
    const oldActions = actionOwner(oldSession);
    const currentActions = actionOwner(currentSession);
    const sharedViews = {
      richView: { dom: shared },
      codeView: { scrollDOM: shared, contentDOM: shared },
      richScroller: shared,
    };
    const oldVisit = options(oldSession, oldActions.actions, sharedViews);
    const currentVisit = options(currentSession, currentActions.actions, sharedViews);
    const rendered = render(<ParentLayoutBoundary visit={oldVisit} />);
    const oldTimer = timers.records[0];
    const oldListeners = captureOwner(listeners.added, 0);

    expect(timers.pending()).toEqual([oldTimer]);
    expect(oldListeners).toHaveLength(4);
    expect(new Set(oldListeners.map((record) => `${record.type}:${String(record.capture)}`)).size).toBe(4);
    expect(oldListeners.find((record) => record.type === "wheel")).toMatchObject({ passive: true, capture: false });
    expect(oldListeners.find((record) => record.type === "touchmove")).toMatchObject({ passive: true, capture: false });
    expect(oldListeners.find((record) => record.type === "beforeinput")).toMatchObject({ capture: true });
    expect(oldListeners.find((record) => record.type === "keydown")).toMatchObject({ capture: true });

    let oldPendingAtBoundary = -1;
    let oldListenersAtBoundary = -1;
    rendered.rerender(
      <ParentLayoutBoundary
        visit={currentVisit}
        boundary={1}
        onBoundary={() => {
          oldPendingAtBoundary = oldTimer.pending ? 1 : 0;
          oldListenersAtBoundary = oldListeners.filter((record) => record.active).length;
        }}
      />,
    );
    const currentTimer = timers.records[1];
    const currentListeners = captureOwner(listeners.added, oldListeners.length);
    expect(oldPendingAtBoundary).toBe(0);
    expect(oldListenersAtBoundary).toBe(0);
    expect(oldTimer.cleared).toBe(true);
    expect(currentTimer.handle).toBe(oldTimer.handle);
    expect(timers.pending()).toEqual([currentTimer]);
    expect(currentListeners).toHaveLength(4);
    expect(listeners.active()).toEqual(currentListeners);
    expect(oldSession.followUserId).toBe("collaborator");
    expect(currentSession.followUserId).toBe("collaborator");

    const runStale = () => {
      timers.fire(oldTimer);
      const events = staleEvents(oldListeners);
      oldListeners.forEach((record, index) => invoke(record, events[index]));
      expect(events.every((event) => !event.defaultPrevented)).toBe(true);
      expect(oldActions.scroll).not.toHaveBeenCalled();
      expect(oldDispatch).not.toHaveBeenCalled();
      expect(focusOwner).toHaveFocus();
      expect(marker).toHaveAttribute("data-state", "unchanged");
    };
    const runCurrent = () => {
      timers.fire(currentTimer);
      shared.dispatchEvent(new WheelEvent("wheel", { cancelable: true }));
      shared.dispatchEvent(new Event("touchmove", { cancelable: true }));
      shared.dispatchEvent(new InputEvent("beforeinput", { cancelable: true }));
      shared.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    };

    if (order === "stale-current") {
      runStale();
      expect(timers.pending()).toEqual([currentTimer]);
      expect(currentSession.followUserId).toBe("collaborator");
      runCurrent();
    } else {
      runCurrent();
      runStale();
    }

    expect(currentActions.scroll).toHaveBeenCalledExactlyOnceWith(17, { code: true, rich: true, synced: true });
    expect(currentDispatch.mock.calls.map(([event]) => event)).toEqual([
      { type: "user-scroll" },
      { type: "user-scroll" },
      { type: "typing" },
      { type: "stop" },
    ]);
    expect(oldActions.scroll).not.toHaveBeenCalled();
    expect(oldDispatch).not.toHaveBeenCalled();
    expect(oldSession.followUserId).toBe("collaborator");
    expect(currentSession.followUserId).toBeNull();

    rendered.unmount();
    expectBalancedListeners(listeners);
  });

  it("retires same-session rich/code views and scrollers before installing the replacement intent", () => {
    const oldRichScroller = document.createElement("div");
    const oldCodeScroller = document.createElement("div");
    const oldRichEditor = document.createElement("div");
    const oldCodeEditor = document.createElement("div");
    const currentRichScroller = document.createElement("div");
    const currentCodeScroller = document.createElement("div");
    const currentRichEditor = document.createElement("div");
    const currentCodeEditor = document.createElement("div");
    const targets: EventTarget[] = [
      oldRichScroller,
      oldCodeScroller,
      oldRichEditor,
      oldCodeEditor,
      currentRichScroller,
      currentCodeScroller,
      currentRichEditor,
      currentCodeEditor,
      window,
    ];
    document.body.append(
      oldRichScroller,
      oldCodeScroller,
      oldRichEditor,
      oldCodeEditor,
      currentRichScroller,
      currentCodeScroller,
      currentRichEditor,
      currentCodeEditor,
    );

    const timers = trackFollowTimers();
    const listeners = trackFollowListeners(targets);
    const owner = session("same");
    const dispatch = vi.spyOn(owner, "dispatchFollow");
    const action = actionOwner(owner);
    const oldVisit = options(owner, action.actions, {
      richView: { dom: oldRichEditor },
      codeView: { scrollDOM: oldCodeScroller, contentDOM: oldCodeEditor },
      richScroller: oldRichScroller,
      cursor: 5,
    });
    const currentVisit = options(owner, action.actions, {
      richView: { dom: currentRichEditor },
      codeView: { scrollDOM: currentCodeScroller, contentDOM: currentCodeEditor },
      richScroller: currentRichScroller,
      showCode: false,
      showRich: true,
      syncScroll: false,
      userId: "other-collaborator",
      cursor: 29,
    });
    const rendered = render(<ParentLayoutBoundary visit={oldVisit} />);
    const oldTimer = timers.records[0];
    const oldListeners = captureOwner(listeners.added, 0);
    expect(oldListeners).toHaveLength(7);

    rendered.rerender(
      <ParentLayoutBoundary
        visit={currentVisit}
        boundary={1}
        onBoundary={() => {
          expect(oldTimer.pending).toBe(false);
          expectOwnerRetired(oldListeners);
        }}
      />,
    );
    const currentTimer = timers.records[1];
    const currentListeners = captureOwner(listeners.added, oldListeners.length);
    expect(timers.pending()).toEqual([currentTimer]);
    expect(currentListeners).toHaveLength(7);

    timers.fire(oldTimer);
    oldListeners.forEach((record, index) => invoke(record, staleEvents(oldListeners)[index]));
    expect(action.scroll).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(timers.pending()).toEqual([currentTimer]);

    timers.fire(currentTimer);
    currentRichScroller.dispatchEvent(new WheelEvent("wheel"));
    currentCodeScroller.dispatchEvent(new Event("touchmove"));
    currentRichEditor.dispatchEvent(new InputEvent("beforeinput"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(action.scroll).toHaveBeenCalledExactlyOnceWith(29, { code: false, rich: true, synced: false });
    expect(dispatch.mock.calls.map(([event]) => event)).toEqual([
      { type: "user-scroll" },
      { type: "user-scroll" },
      { type: "typing" },
      { type: "stop" },
    ]);

    rendered.unmount();
    expectBalancedListeners(listeners);
  });

  it("physically retires a removed visit before the parent layout boundary", () => {
    const scroller = document.createElement("div");
    const editor = document.createElement("div");
    const focusOwner = document.createElement("button");
    document.body.append(scroller, editor, focusOwner);
    focusOwner.focus();
    const timers = trackFollowTimers();
    const listeners = trackFollowListeners([scroller, editor, window]);
    const owner = session("removed");
    const dispatch = vi.spyOn(owner, "dispatchFollow");
    const action = actionOwner(owner);
    const visit = options(owner, action.actions, {
      richView: { dom: editor },
      richScroller: scroller,
      showCode: false,
    });
    const rendered = render(<ParentLayoutBoundary visit={visit} />);
    const timer = timers.records[0];
    const captured = captureOwner(listeners.added, 0);
    let timersAtBoundary = -1;
    let listenersAtBoundary = -1;

    rendered.rerender(
      <ParentLayoutBoundary
        visit={visit}
        present={false}
        boundary={1}
        onBoundary={() => {
          timersAtBoundary = timers.pending().length;
          listenersAtBoundary = listeners.active().length;
        }}
      />,
    );
    expect(timersAtBoundary).toBe(0);
    expect(listenersAtBoundary).toBe(0);
    expect(timer.cleared).toBe(true);

    timers.fire(timer);
    const events = staleEvents(captured);
    captured.forEach((record, index) => invoke(record, events[index]));
    expect(action.scroll).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(events.every((event) => !event.defaultPrevented)).toBe(true);
    expect(focusOwner).toHaveFocus();
    expectBalancedListeners(listeners);
  });

  it.each([
    ["code only", true, false, true, { code: true, rich: false, synced: false }],
    ["rich only", false, true, true, { code: false, rich: true, synced: false }],
    ["both synced", true, true, true, { code: true, rich: true, synced: true }],
    ["both independent", true, true, false, { code: true, rich: true, synced: false }],
  ] as const)("centres the current %s visit once with its immutable visible-pane intent", (_name, showCode, showRich, syncScroll, expected) => {
    const timers = trackFollowTimers();
    const owner = session(`layout-${_name}`);
    const action = actionOwner(owner);
    const visit = options(owner, action.actions, { showCode, showRich, syncScroll, cursor: 41 });
    const rendered = render(<FollowHarness {...visit} />);

    expect(timers.records).toHaveLength(1);
    expect(timers.pending()).toHaveLength(1);
    timers.fire(timers.records[0]);
    timers.fire(timers.records[0]);
    expect(action.scroll).toHaveBeenCalledExactlyOnceWith(41, expected);

    rendered.unmount();
  });
});
