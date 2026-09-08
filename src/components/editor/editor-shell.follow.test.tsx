// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { createRoot, type Root } from "react-dom/client";
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

import { CollabSession, type PresenceUser } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { EditorActions } from "./actions";
import { useCollaboratorFollowVisit } from "./editor-shell";
import { FollowBanner } from "./follow-banner";

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

type BannerFollow = Mock<(userId: string | null) => void>;
type StopClick = (event: ReactMouseEvent<HTMLButtonElement>) => void;

interface BannerParts {
  readonly banner: HTMLDivElement;
  readonly message: HTMLSpanElement;
  readonly section: HTMLSpanElement | null;
  readonly separator: HTMLSpanElement;
  readonly stop: HTMLButtonElement;
  readonly icon: SVGSVGElement;
  readonly shortcut: HTMLSpanElement;
}

interface CapturedElementRef {
  readonly element: Element;
  readonly ref: (element: Element | null) => void;
}

interface CapturedStopEvent extends ReactMouseEvent<HTMLButtonElement> {
  readonly preventDefault: Mock<() => void>;
  readonly stopPropagation: Mock<() => void>;
}

interface BannerBoundaryProps {
  readonly session: BannerSession;
  readonly present?: boolean;
  readonly bannerKey?: string;
  readonly domKey?: string;
  readonly passiveKey?: number;
  readonly boundary?: number;
  readonly onBoundary?: () => void;
  readonly onPassiveCleanup?: () => void;
}

interface DirectView {
  readonly root: Root;
  readonly host: HTMLDivElement;
}

const BASE_BANNER_USER: PresenceUser = {
  id: "followed-a",
  name: "Ada",
  color: "#123456",
  colorLight: "#12345633",
  avatar: null,
  login: "ada",
  clientId: 101,
  cursor: 8,
  section: "Introduction",
  idleSince: null,
  role: "editor",
  isLocal: false,
  isAgent: false,
  status: null,
  ownerLogin: null,
  ownerName: null,
};

const directViews: DirectView[] = [];

function bannerUser(overrides: Partial<PresenceUser> = {}): PresenceUser {
  return { ...BASE_BANNER_USER, ...overrides };
}

class BannerSession {
  version = 0;
  follow: CollabSession["follow"];
  readonly targetReads = vi.fn();
  readonly presence: Mock<() => PresenceUser[]>;
  private target: string | null;
  private users: PresenceUser[];

  constructor(target: string | null, users: PresenceUser[], follow: BannerFollow) {
    this.target = target;
    this.users = users;
    this.follow = follow;
    this.presence = vi.fn(() => this.users);
  }

  get followUserId() {
    this.targetReads();
    return this.target;
  }

  readonly subscribe = () => () => {};

  publish(target: string | null, users: PresenceUser[]) {
    this.target = target;
    this.users = users;
    this.version++;
  }

  setTargetWithoutRender(target: string | null) {
    this.target = target;
  }

  asCollabSession(): CollabSession {
    return this as unknown as CollabSession;
  }
}

function BannerBoundary({
  session: owner,
  present = true,
  bannerKey = "banner-a",
  domKey = "dom-a",
  passiveKey = 0,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: BannerBoundaryProps) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => () => onPassiveCleanup?.(), [onPassiveCleanup, passiveKey]);
  return present ? (
    <div key={domKey}>
      <FollowBanner key={bannerKey} session={owner.asCollabSession()} />
    </div>
  ) : null;
}

function directRoot(node: ReactNode): DirectView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { root: createRoot(host), host };
  directViews.push(view);
  act(() => view.root.render(node));
  return view;
}

function bannerParts(host: ParentNode, index = 0): BannerParts {
  const banners = host.querySelectorAll<HTMLDivElement>('[data-testid="follow-banner"]');
  const banner = banners.item(index);
  const message = banner?.children.item(0);
  const separator = banner?.children.item(1);
  const stop = banner?.children.item(2);
  const icon = stop?.children.item(0);
  const shortcut = stop?.children.item(1);
  if (
    !(banner instanceof HTMLDivElement) ||
    !(message instanceof HTMLSpanElement) ||
    !(separator instanceof HTMLSpanElement) ||
    !(stop instanceof HTMLButtonElement) ||
    !(icon instanceof SVGSVGElement) ||
    !(shortcut instanceof HTMLSpanElement)
  ) {
    throw new Error("The complete Follow banner was not rendered");
  }
  const section = message.children.item(0);
  if (section !== null && !(section instanceof HTMLSpanElement)) {
    throw new Error("The Follow section was not a span");
  }
  return { banner, message, section, separator, stop, icon, shortcut };
}

function reactProperty<T>(element: Element, name: string): T | undefined {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the Follow banner");
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  return props?.[name] as T | undefined;
}

function stopHandler(stop: HTMLButtonElement): StopClick {
  const handler = reactProperty<StopClick>(stop, "onClick");
  if (typeof handler !== "function") throw new Error("The Stop handler was not attached");
  return handler;
}

function capturedRef<T extends Element>(element: T): CapturedElementRef {
  const ref = reactProperty<RefCallback<T>>(element, "ref");
  if (typeof ref !== "function") throw new Error("A Follow callback ref was not attached");
  return {
    element,
    ref: (next) => ref(next as T | null),
  };
}

function bannerRefs(parts: BannerParts): CapturedElementRef[] {
  return [
    capturedRef(parts.banner),
    capturedRef(parts.message),
    ...(parts.section ? [capturedRef(parts.section)] : []),
    capturedRef(parts.separator),
    capturedRef(parts.stop),
    capturedRef(parts.icon),
    capturedRef(parts.shortcut),
  ];
}

function stopEvent(
  currentTarget: EventTarget | null,
  target: EventTarget | null = currentTarget,
  options: {
    readonly type?: string;
    readonly nativeType?: string;
    readonly nativeTarget?: EventTarget | null;
    readonly nativeEvent?: Event;
  } = {},
): CapturedStopEvent {
  const ownerDocument = currentTarget instanceof Node
    ? currentTarget.ownerDocument ?? document
    : document;
  const view = ownerDocument.defaultView ?? window;
  const type = options.type ?? "click";
  const nativeEvent = options.nativeEvent ??
    new view.MouseEvent(options.nativeType ?? type, { bubbles: true, button: 0 });
  Object.defineProperty(nativeEvent, "target", {
    configurable: true,
    value: options.nativeTarget === undefined ? target : options.nativeTarget,
  });
  return {
    type,
    currentTarget,
    target,
    nativeEvent,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as CapturedStopEvent;
}

function expectRejected({
  callback,
  event,
  follow,
  owner,
  host,
  allowFactReads = false,
}: {
  readonly callback: () => void;
  readonly event?: CapturedStopEvent;
  readonly follow: readonly BannerFollow[];
  readonly owner: readonly BannerSession[];
  readonly host: HTMLElement;
  readonly allowFactReads?: boolean;
}) {
  const actionCalls = follow.map((action) => action.mock.calls.length);
  const targetReads = owner.map((sessionOwner) => sessionOwner.targetReads.mock.calls.length);
  const presenceReads = owner.map((sessionOwner) => sessionOwner.presence.mock.calls.length);
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  const contains = vi.spyOn(Node.prototype, "contains");
  const eventWork = vi.fn();
  host.addEventListener("click", eventWork);
  const observer = new MutationObserver(() => undefined);
  observer.observe(host, { attributes: true, childList: true, characterData: true, subtree: true });
  observer.takeRecords();
  const markup = host.innerHTML;
  const activeElement = document.activeElement;

  try {
    callback();
    expect(follow.map((action) => action.mock.calls.length)).toEqual(actionCalls);
    if (!allowFactReads) {
      expect(owner.map((sessionOwner) => sessionOwner.targetReads.mock.calls.length)).toEqual(targetReads);
      expect(owner.map((sessionOwner) => sessionOwner.presence.mock.calls.length)).toEqual(presenceReads);
    }
    expect(focus).not.toHaveBeenCalled();
    expect(contains).not.toHaveBeenCalled();
    expect(eventWork).not.toHaveBeenCalled();
    expect(observer.takeRecords()).toHaveLength(0);
    expect(host.innerHTML).toBe(markup);
    expect(document.activeElement).toBe(activeElement);
    if (event) {
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }
  } finally {
    observer.disconnect();
    host.removeEventListener("click", eventWork);
    focus.mockRestore();
    contains.mockRestore();
  }
}

afterEach(() => {
  for (const view of directViews.splice(0)) {
    act(() => view.root.unmount());
    view.host.remove();
  }
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

describe("Follow banner Stop publication", () => {
  it("preserves the exact visible banner and native button accessibility", () => {
    const follow = vi.fn<(userId: string | null) => void>();
    const owner = new BannerSession(BASE_BANNER_USER.id, [bannerUser()], follow);
    const view = directRoot(<FollowBanner session={owner.asCollabSession()} />);
    const parts = bannerParts(view.host);

    expect(parts.banner).toHaveAttribute("role", "status");
    expect(parts.banner).toHaveAttribute("data-user-id", BASE_BANNER_USER.id);
    expect(parts.banner).toHaveClass("h-8", "shrink-0");
    expect(parts.banner.style.backgroundColor).toBe("rgb(18, 52, 86)");
    expect(parts.banner).toHaveTextContent("Following Ada · in ‘Introduction’·Stop (Esc)");
    expect(parts.message).toHaveTextContent("Following Ada · in ‘Introduction’");
    expect(parts.separator).toHaveTextContent("·");
    expect(parts.stop).toHaveAttribute("type", "button");
    expect(parts.stop).toHaveAccessibleName("Stop (Esc)");
    expect(parts.icon).toHaveClass("lucide-x");

    act(() => parts.stop.click());
    act(() => parts.stop.click());
    expect(follow).toHaveBeenCalledExactlyOnceWith(null);
    expect(follow.mock.contexts[0]).toBe(owner);
  });

  const authorityReplacements = [
    "session",
    "followed user",
    "name",
    "color",
    "section",
    "callback",
    "equal remount",
    "DOM remount",
  ] as const;

  it.each(
    authorityReplacements.flatMap((replacement) =>
      (["stale before current", "current before stale"] as const)
        .map((order) => [replacement, order] as const),
    ),
  )("retires %s authority before parent layout and keeps B usable: %s", (replacement, order) => {
    const followA = vi.fn<(userId: string | null) => void>();
    const followB = vi.fn<(userId: string | null) => void>();
    const ownerA = new BannerSession(BASE_BANNER_USER.id, [bannerUser()], followA);
    let ownerB = ownerA;
    let bannerKey = "banner-a";
    let domKey = "dom-a";
    let expectedFollow = followA;
    let passiveCleanups = 0;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };
    const view = directRoot(
      <BannerBoundary session={ownerA} onPassiveCleanup={onPassiveCleanup} />,
    );
    const staleParts = bannerParts(view.host);
    const staleStop = stopHandler(staleParts.stop);

    if (replacement === "session") {
      ownerB = new BannerSession(BASE_BANNER_USER.id, [bannerUser()], followB);
      expectedFollow = followB;
    } else if (replacement === "followed user") {
      ownerA.publish("followed-b", [bannerUser({ id: "followed-b", clientId: 202 })]);
    } else if (replacement === "name") {
      ownerA.publish(BASE_BANNER_USER.id, [bannerUser({ name: "Grace" })]);
    } else if (replacement === "color") {
      ownerA.publish(BASE_BANNER_USER.id, [bannerUser({ color: "#654321" })]);
    } else if (replacement === "section") {
      ownerA.publish(BASE_BANNER_USER.id, [bannerUser({ section: "Details" })]);
    } else if (replacement === "callback") {
      ownerA.follow = followB;
      expectedFollow = followB;
    } else if (replacement === "equal remount") {
      bannerKey = "banner-b";
    } else {
      domKey = "dom-b";
    }

    let currentParts!: BannerParts;
    act(() => {
      view.root.render(
        <BannerBoundary
          session={ownerB}
          bannerKey={bannerKey}
          domKey={domKey}
          passiveKey={1}
          boundary={1}
          onPassiveCleanup={onPassiveCleanup}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            currentParts = bannerParts(view.host);
            const currentStop = stopHandler(currentParts.stop);
            if (order === "stale before current") {
              const staleEvent = stopEvent(staleParts.stop);
              expectRejected({
                callback: () => staleStop(staleEvent),
                event: staleEvent,
                follow: [followA, followB],
                owner: [ownerA, ownerB],
                host: view.host,
              });
            }
            currentStop(stopEvent(currentParts.stop, currentParts.icon));
            if (order === "current before stale") {
              const staleEvent = stopEvent(staleParts.stop);
              expectRejected({
                callback: () => staleStop(staleEvent),
                event: staleEvent,
                follow: [followA, followB],
                owner: [ownerA, ownerB],
                host: view.host,
              });
            }
          }}
        />,
      );
    });

    expect(passiveCleanups).toBe(1);
    expect(expectedFollow).toHaveBeenCalledExactlyOnceWith(null);
    expect(expectedFollow.mock.contexts[0]).toBe(ownerB);
    expect(followA.mock.calls.length + followB.mock.calls.length).toBe(1);
    if (replacement === "equal remount" || replacement === "DOM remount") {
      expect(currentParts.stop).not.toBe(staleParts.stop);
    } else {
      expect(currentParts.stop).toBe(staleParts.stop);
    }
  });

  it("keeps a same-DOM, equal-facts rerender on its one current publication", () => {
    const follow = vi.fn<(userId: string | null) => void>();
    const owner = new BannerSession(BASE_BANNER_USER.id, [bannerUser()], follow);
    const view = directRoot(<BannerBoundary session={owner} />);
    const before = bannerParts(view.host);
    const beforeStop = stopHandler(before.stop);
    let boundaryRan = false;

    act(() => {
      view.root.render(
        <BannerBoundary
          session={owner}
          boundary={1}
          onBoundary={() => {
            boundaryRan = true;
            const current = bannerParts(view.host);
            expect(current.stop).toBe(before.stop);
            expect(stopHandler(current.stop)).toBe(beforeStop);
            beforeStop(stopEvent(current.stop, current.shortcut));
          }}
        />,
      );
    });

    expect(boundaryRan).toBe(true);
    expect(follow).toHaveBeenCalledExactlyOnceWith(null);
  });

  const refParts = [
    "banner",
    "message",
    "section",
    "separator",
    "stop",
    "icon",
    "shortcut",
  ] as const;

  it.each(refParts)("retires when the %s callback ref receives a replacement", (part) => {
    const follow = vi.fn<(userId: string | null) => void>();
    const owner = new BannerSession(BASE_BANNER_USER.id, [bannerUser()], follow);
    const view = directRoot(<BannerBoundary session={owner} />);
    const stale = bannerParts(view.host);
    const staleStop = stopHandler(stale.stop);
    const source = stale[part];
    if (!source) throw new Error("Expected the Follow section");
    const ref = capturedRef(source);
    const replacement = source.cloneNode(true) as Element;
    document.body.append(replacement);

    act(() => ref.ref(replacement));
    const staleEvent = stopEvent(stale.stop);
    expectRejected({
      callback: () => staleStop(staleEvent),
      event: staleEvent,
      follow: [follow],
      owner: [owner],
      host: view.host,
    });
    act(() => {
      ref.ref(source);
      ref.ref(null);
    });
    expect(follow).not.toHaveBeenCalled();

    act(() => view.root.render(
      <BannerBoundary session={owner} bannerKey="banner-b" domKey="dom-b" />,
    ));
    const current = bannerParts(view.host);
    stopHandler(current.stop)(stopEvent(current.stop, current.icon));
    expect(follow).toHaveBeenCalledExactlyOnceWith(null);
    replacement.remove();
  });

  it.each([
    "message text",
    "separator",
    "injected descendant",
    "removed descendant",
    "replaced descendant",
  ] as const)("rejects %s drift without consuming the restored publication", (drift) => {
    const follow = vi.fn<(userId: string | null) => void>();
    const owner = new BannerSession(BASE_BANNER_USER.id, [bannerUser()], follow);
    const view = directRoot(<BannerBoundary session={owner} />);
    const parts = bannerParts(view.host);
    const click = stopHandler(parts.stop);
    let restore: () => void;
    let target: EventTarget = parts.stop;

    if (drift === "message text") {
      const text = parts.message.firstChild;
      if (!text) throw new Error("Expected the Following text node");
      const original = text.textContent;
      text.textContent = "Following Eve";
      restore = () => {
        text.textContent = original;
      };
    } else if (drift === "separator") {
      const original = parts.separator.className;
      parts.separator.className = "changed";
      restore = () => {
        parts.separator.className = original;
      };
    } else if (drift === "injected descendant") {
      const injected = document.createElement("span");
      injected.textContent = "later";
      parts.stop.append(injected);
      target = injected;
      restore = () => injected.remove();
    } else if (drift === "removed descendant") {
      parts.shortcut.remove();
      restore = () => parts.stop.append(parts.shortcut);
    } else {
      const clone = parts.shortcut.cloneNode(true) as HTMLSpanElement;
      parts.shortcut.replaceWith(clone);
      restore = () => clone.replaceWith(parts.shortcut);
    }

    const rejected = stopEvent(parts.stop, target);
    expectRejected({
      callback: () => click(rejected),
      event: rejected,
      follow: [follow],
      owner: [owner],
      host: view.host,
      allowFactReads: true,
    });
    restore();
    click(stopEvent(parts.stop, parts.icon));
    expect(follow).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("rejects wrong controls and fabricated provenance before any session or incidental work", () => {
    const follow = vi.fn<(userId: string | null) => void>();
    const owner = new BannerSession(BASE_BANNER_USER.id, [bannerUser()], follow);
    const view = directRoot(<BannerBoundary session={owner} />);
    const parts = bannerParts(view.host);
    const click = stopHandler(parts.stop);
    const sibling = document.createElement("button");
    const foreign = document.createElement("button");
    const detached = document.createElement("button");
    const replacement = parts.stop.cloneNode(true) as HTMLButtonElement;
    document.body.append(sibling, foreign, replacement);
    const foreignDocument = document.implementation.createHTMLDocument("foreign");
    const foreignTarget = foreignDocument.createElement("span");
    foreignDocument.body.append(foreignTarget);
    const wrongNativeType = stopEvent(parts.stop, parts.stop, { nativeType: "keydown" });
    const wrongNativeClass = stopEvent(parts.stop, parts.stop, {
      nativeEvent: new Event("click", { bubbles: true }),
    });
    const mismatch = stopEvent(parts.stop, parts.icon, { nativeTarget: parts.shortcut });
    const wrongWrapperType = stopEvent(parts.stop, parts.stop, { type: "keydown" });
    const wrongTarget = stopEvent(parts.stop, sibling);
    const foreignTargetEvent = stopEvent(parts.stop, foreignTarget);
    const attempts: { event?: CapturedStopEvent; run: () => void }[] = [
      { event: stopEvent(sibling), run: () => click(stopEvent(sibling)) },
      { event: stopEvent(foreign), run: () => click(stopEvent(foreign)) },
      { event: stopEvent(detached), run: () => click(stopEvent(detached)) },
      { event: stopEvent(replacement), run: () => click(stopEvent(replacement)) },
      { event: wrongTarget, run: () => click(wrongTarget) },
      { event: foreignTargetEvent, run: () => click(foreignTargetEvent) },
      { event: wrongNativeType, run: () => click(wrongNativeType) },
      { event: wrongNativeClass, run: () => click(wrongNativeClass) },
      { event: mismatch, run: () => click(mismatch) },
      { event: wrongWrapperType, run: () => click(wrongWrapperType) },
      {
        run: () => click({ currentTarget: parts.stop } as ReactMouseEvent<HTMLButtonElement>),
      },
    ];

    for (const attempt of attempts) {
      expectRejected({
        callback: attempt.run,
        event: attempt.event,
        follow: [follow],
        owner: [owner],
        host: view.host,
      });
    }

    parts.stop.disabled = true;
    const disabledEvent = stopEvent(parts.stop);
    expectRejected({
      callback: () => click(disabledEvent),
      event: disabledEvent,
      follow: [follow],
      owner: [owner],
      host: view.host,
    });
    parts.stop.disabled = false;

    click(stopEvent(parts.stop, parts.shortcut));
    expect(follow).toHaveBeenCalledExactlyOnceWith(null);
    sibling.remove();
    foreign.remove();
    replacement.remove();
  });

  it.each(["stale before current", "current before stale"] as const)(
    "isolates every A/B handler and control pairing: %s",
    (order) => {
      const follow = vi.fn<(userId: string | null) => void>();
      const owner = new BannerSession(BASE_BANNER_USER.id, [bannerUser()], follow);
      const view = directRoot(<BannerBoundary session={owner} />);
      const a = bannerParts(view.host);
      const aClick = stopHandler(a.stop);

      act(() => view.root.render(
        <BannerBoundary session={owner} bannerKey="banner-b" domKey="dom-b" passiveKey={1} />,
      ));
      const b = bannerParts(view.host);
      const bClick = stopHandler(b.stop);
      document.body.append(a.stop);

      const rejectCrossPairs = () => {
        const attempts = [
          { click: aClick, event: stopEvent(b.stop, b.icon) },
          { click: bClick, event: stopEvent(a.stop, a.icon) },
          { click: aClick, event: stopEvent(a.stop, a.icon) },
        ];
        for (const attempt of attempts) {
          expectRejected({
            callback: () => attempt.click(attempt.event),
            event: attempt.event,
            follow: [follow],
            owner: [owner],
            host: view.host,
          });
        }
      };

      if (order === "stale before current") rejectCrossPairs();
      bClick(stopEvent(b.stop, b.icon));
      if (order === "current before stale") rejectCrossPairs();
      expect(follow).toHaveBeenCalledExactlyOnceWith(null);
      a.stop.remove();
    },
  );

  it("keeps two current banner mounts isolated", () => {
    const followA = vi.fn<(userId: string | null) => void>();
    const followB = vi.fn<(userId: string | null) => void>();
    const ownerA = new BannerSession(BASE_BANNER_USER.id, [bannerUser()], followA);
    const ownerB = new BannerSession("followed-b", [
      bannerUser({ id: "followed-b", name: "Grace", clientId: 202 }),
    ], followB);
    const view = directRoot(
      <>
        <FollowBanner session={ownerA.asCollabSession()} />
        <FollowBanner session={ownerB.asCollabSession()} />
      </>,
    );
    const a = bannerParts(view.host, 0);
    const b = bannerParts(view.host, 1);
    const aClick = stopHandler(a.stop);
    const bClick = stopHandler(b.stop);

    const aOnB = stopEvent(b.stop, b.icon);
    const bOnA = stopEvent(a.stop, a.icon);
    expectRejected({
      callback: () => aClick(aOnB),
      event: aOnB,
      follow: [followA, followB],
      owner: [ownerA, ownerB],
      host: view.host,
    });
    expectRejected({
      callback: () => bClick(bOnA),
      event: bOnA,
      follow: [followA, followB],
      owner: [ownerA, ownerB],
      host: view.host,
    });
    aClick(stopEvent(a.stop, a.icon));
    bClick(stopEvent(b.stop, b.icon));
    expect(followA).toHaveBeenCalledExactlyOnceWith(null);
    expect(followB).toHaveBeenCalledExactlyOnceWith(null);
  });

  it.each(["follow target", "id", "name", "color", "section", "callback"] as const)(
    "does not consume a publication rejected for in-place %s mutation",
    (fact) => {
      const follow = vi.fn<(userId: string | null) => void>();
      const replacementFollow = vi.fn<(userId: string | null) => void>();
      const currentUser = bannerUser();
      const owner = new BannerSession(BASE_BANNER_USER.id, [currentUser], follow);
      const view = directRoot(<BannerBoundary session={owner} />);
      const parts = bannerParts(view.host);
      const click = stopHandler(parts.stop);
      const event = stopEvent(parts.stop, parts.icon);
      let restore: () => void;

      if (fact === "follow target") {
        owner.setTargetWithoutRender("followed-b");
        restore = () => owner.setTargetWithoutRender(BASE_BANNER_USER.id);
      } else if (fact === "callback") {
        owner.follow = replacementFollow;
        restore = () => {
          owner.follow = follow;
        };
      } else {
        const key = fact;
        const previous = currentUser[key];
        if (fact === "id") currentUser.id = "followed-b";
        else if (fact === "name") currentUser.name = "Grace";
        else if (fact === "color") currentUser.color = "#654321";
        else currentUser.section = "Details";
        restore = () => {
          if (key === "id") currentUser.id = previous as string;
          else if (key === "name") currentUser.name = previous as string;
          else if (key === "color") currentUser.color = previous as string;
          else currentUser.section = previous;
        };
      }

      expectRejected({
        callback: () => click(event),
        event,
        follow: [follow, replacementFollow],
        owner: [owner],
        host: view.host,
        allowFactReads: true,
      });
      restore();
      click(event);
      expect(follow).toHaveBeenCalledExactlyOnceWith(null);
      expect(replacementFollow).not.toHaveBeenCalled();
    },
  );

  it("claims the native event and action before a reentrant callback", () => {
    const interaction: { click?: StopClick; event?: CapturedStopEvent } = {};
    const follow = vi.fn<(userId: string | null) => void>(() => {
      const { click, event } = interaction;
      if (!click || !event) throw new Error("The reentrant interaction was not captured");
      click(event);
      click(stopEvent(event.currentTarget, event.target, { nativeEvent: event.nativeEvent }));
    });
    const owner = new BannerSession(BASE_BANNER_USER.id, [bannerUser()], follow);
    const view = directRoot(<BannerBoundary session={owner} />);
    const parts = bannerParts(view.host);
    const click = stopHandler(parts.stop);
    const event = stopEvent(parts.stop, parts.icon);
    interaction.click = click;
    interaction.event = event;

    click(event);
    click(event);
    click(stopEvent(parts.stop, parts.icon));
    expect(follow).toHaveBeenCalledExactlyOnceWith(null);
    expect(follow.mock.contexts[0]).toBe(owner);
  });

  it("retires removal before passive cleanup and ignores every late A ref", () => {
    const follow = vi.fn<(userId: string | null) => void>();
    const owner = new BannerSession(BASE_BANNER_USER.id, [bannerUser()], follow);
    let passiveCleanups = 0;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };
    const view = directRoot(
      <BannerBoundary session={owner} onPassiveCleanup={onPassiveCleanup} />,
    );
    const stale = bannerParts(view.host);
    const staleClick = stopHandler(stale.stop);
    const staleRefs = bannerRefs(stale);

    act(() => {
      view.root.render(
        <BannerBoundary
          session={owner}
          present={false}
          passiveKey={1}
          boundary={1}
          onPassiveCleanup={onPassiveCleanup}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            const event = stopEvent(stale.stop);
            expectRejected({
              callback: () => staleClick(event),
              event,
              follow: [follow],
              owner: [owner],
              host: view.host,
            });
          }}
        />,
      );
    });
    expect(passiveCleanups).toBe(1);

    act(() => {
      staleRefs.forEach(({ element, ref }) => ref(element));
      [...staleRefs].reverse().forEach(({ ref }) => ref(null));
      view.root.render(
        <BannerBoundary
          session={owner}
          bannerKey="banner-b"
          domKey="dom-b"
          passiveKey={2}
          onPassiveCleanup={onPassiveCleanup}
        />,
      );
    });
    const current = bannerParts(view.host);
    const staleOnB = stopEvent(current.stop, current.icon);
    expectRejected({
      callback: () => staleClick(staleOnB),
      event: staleOnB,
      follow: [follow],
      owner: [owner],
      host: view.host,
    });
    stopHandler(current.stop)(stopEvent(current.stop, current.icon));
    expect(follow).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("keeps same-element successor B current through late A refs", () => {
    const follow = vi.fn<(userId: string | null) => void>();
    const owner = new BannerSession(BASE_BANNER_USER.id, [bannerUser()], follow);
    const view = directRoot(<BannerBoundary session={owner} />);
    const stale = bannerParts(view.host);
    const staleClick = stopHandler(stale.stop);
    const staleRefs = bannerRefs(stale);
    owner.publish(BASE_BANNER_USER.id, [bannerUser({ name: "Grace" })]);
    let current!: BannerParts;

    act(() => {
      view.root.render(
        <BannerBoundary
          session={owner}
          passiveKey={1}
          boundary={1}
          onBoundary={() => {
            current = bannerParts(view.host);
            expect(current.stop).toBe(stale.stop);
            const currentRefs = bannerRefs(current);
            staleRefs.forEach(({ ref }, index) => ref(currentRefs[index].element));
            [...staleRefs].reverse().forEach(({ ref }) => ref(null));
            const staleEvent = stopEvent(current.stop, current.icon);
            expectRejected({
              callback: () => staleClick(staleEvent),
              event: staleEvent,
              follow: [follow],
              owner: [owner],
              host: view.host,
            });
            stopHandler(current.stop)(stopEvent(current.stop, current.icon));
          }}
        />,
      );
    });

    expect(follow).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("keeps the exact Strict Mode successor usable after setup and cleanup replay", () => {
    const follow = vi.fn<(userId: string | null) => void>();
    const owner = new BannerSession(BASE_BANNER_USER.id, [bannerUser()], follow);
    const view = directRoot(
      <StrictMode>
        <BannerBoundary session={owner} bannerKey="banner-a" domKey="dom-a" />
      </StrictMode>,
    );
    const stale = bannerParts(view.host);
    const staleClick = stopHandler(stale.stop);
    const staleRefs = bannerRefs(stale);

    act(() => view.root.render(
      <StrictMode>
        <BannerBoundary
          session={owner}
          bannerKey="banner-b"
          domKey="dom-b"
          passiveKey={1}
        />
      </StrictMode>,
    ));
    const current = bannerParts(view.host);
    const currentRefs = bannerRefs(current);
    act(() => {
      staleRefs.forEach(({ ref }, index) => ref(currentRefs[index].element));
      [...staleRefs].reverse().forEach(({ ref }) => ref(null));
    });
    const staleEvent = stopEvent(current.stop, current.icon);
    expectRejected({
      callback: () => staleClick(staleEvent),
      event: staleEvent,
      follow: [follow],
      owner: [owner],
      host: view.host,
    });
    const currentClick = stopHandler(current.stop);
    const currentEvent = stopEvent(current.stop, current.icon);
    currentClick(currentEvent);
    currentClick(currentEvent);
    expect(follow).toHaveBeenCalledExactlyOnceWith(null);
  });
});
