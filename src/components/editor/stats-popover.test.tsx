// @vitest-environment jsdom
import { useEffect, useLayoutEffect, type ComponentProps, type RefCallback } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as Y from "yjs";

type PopoverOpenChange = (open: boolean) => void;

const capturedPopoverOpenChanges = vi.hoisted(() => [] as PopoverOpenChange[]);
const publishedPopoverOpenChanges = vi.hoisted(
  () => [] as { callback: PopoverOpenChange; open: boolean }[],
);

vi.mock("@/components/ui/primitives", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/primitives")>();
  const ActualPopover = actual.Popover;
  return {
    ...actual,
    Popover: (props: ComponentProps<typeof ActualPopover>) => {
      const onOpenChange = props.onOpenChange;
      if (onOpenChange) capturedPopoverOpenChanges.push(onOpenChange);
      return (
        <ActualPopover
          {...props}
          onOpenChange={
            onOpenChange
              ? (open) => {
                  publishedPopoverOpenChanges.push({ callback: onOpenChange, open });
                  onOpenChange(open);
                }
              : undefined
          }
        />
      );
    },
  };
});

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  class HocuspocusProvider {
    awareness: InstanceType<typeof Awareness>;
    constructor(opts: { document: Y.Doc }) {
      this.awareness = new Awareness(opts.document);
    }
    destroy() {
      this.awareness.destroy();
    }
  }
  return { HocuspocusProvider };
});

import { CollabSession } from "@/editor/collab/session";
import { getGoal, setGoal } from "@/editor/collab/meta";
import { makeCollabUser } from "@/editor/collab/shared";
import type { WritingGoal } from "@/editor/stats";
import { StatsPopover, useLocalSelection, type SourceSelection } from "./stats-popover";

const sessions: CollabSession[] = [];
const unhandledRejections: unknown[] = [];

function recordUnhandledRejection(reason: unknown) {
  unhandledRejections.push(reason);
}

function makeSession(docId: string, role: "owner" | "viewer" = "owner", goal: WritingGoal | null = null): CollabSession {
  const session = new CollabSession({
    docId,
    user: makeCollabUser("alice", "Alice", null, "alice"),
    role,
    getToken: async () => {
      throw new Error("Provider access is forbidden in stats popover tests");
    },
    autoConnect: false,
    deferLocal: true,
  });
  session.keepAlive();
  if (goal) setGoal(session, goal);
  sessions.push(session);
  return session;
}

function goal(kind: WritingGoal["kind"], mode: WritingGoal["mode"], value: number, setBy = "bob"): WritingGoal {
  return { kind, mode, value, setBy, setAt: value };
}

function view(session: CollabSession, source = "One two three.") {
  return <StatsPopover session={session} source={source} selection={null} hydrated />;
}

function setLocalSelection(session: CollabSession, anchor: number, head: number) {
  session.awareness.setLocalStateField("cursor", {
    anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(session.ytext, anchor)),
    head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(session.ytext, head)),
  });
}

function seedSelection(session: CollabSession, source: string, anchor: number, head: number) {
  session.ytext.insert(0, source);
  setLocalSelection(session, anchor, head);
}

function trackSelectionSubscriptions(session: CollabSession) {
  const awarenessOn = vi.spyOn(session.awareness, "on");
  const awarenessOff = vi.spyOn(session.awareness, "off");
  const originalSubscribe = session.subscribe;
  const textUnsubscribes: { calls: number }[] = [];
  const subscribe = vi.spyOn(session, "subscribe").mockImplementation((listener) => {
    const unsubscribe = originalSubscribe(listener);
    const tracked = { calls: 0 };
    textUnsubscribes.push(tracked);
    return () => {
      tracked.calls++;
      unsubscribe();
    };
  });
  const awarenessCalls = (spy: typeof awarenessOn | typeof awarenessOff) =>
    spy.mock.calls.filter(([event]) => event === "change").length;
  return {
    awarenessOff,
    awarenessOn,
    subscribe,
    textUnsubscribes,
    activeAwareness: () => awarenessCalls(awarenessOn) - awarenessCalls(awarenessOff),
    activeText: () => subscribe.mock.calls.length - textUnsubscribes.filter(({ calls }) => calls > 0).length,
  };
}

function SelectionProbe({ session, onSelection }: { session: CollabSession; onSelection?: (selection: SourceSelection) => void }) {
  const selection = useLocalSelection(session);
  useLayoutEffect(() => onSelection?.(selection), [onSelection, selection]);
  return <output data-testid="selection-probe">{selection ? `${selection.from}:${selection.to}` : "none"}</output>;
}

function SelectionStats({ session, source }: { session: CollabSession; source: string }) {
  const selection = useLocalSelection(session);
  return <StatsPopover session={session} source={source} selection={selection} hydrated />;
}

function SelectionBoundary({
  session,
  present = true,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
  onSelection,
}: {
  session: CollabSession;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: (session: CollabSession, present: boolean) => void;
  onSelection?: (selection: SourceSelection) => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => () => onPassiveCleanup?.(session, present), [onPassiveCleanup, present, session]);
  return present ? <SelectionProbe session={session} onSelection={onSelection} /> : null;
}

function StatsBoundary({
  session,
  source = "One two three.",
  selection = null,
  hydrated = true,
  present = true,
  mount = "initial",
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  session: CollabSession;
  source?: string;
  selection?: SourceSelection;
  hydrated?: boolean;
  present?: boolean;
  mount?: "initial" | "replacement";
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => () => onPassiveCleanup?.(), [onPassiveCleanup, present, session]);
  if (!present) return null;
  const props = { session, source, selection, hydrated };
  return mount === "initial" ? <StatsPopover {...props} /> : <ReplacementStatsPopover {...props} />;
}

function ReplacementStatsPopover(props: ComponentProps<typeof StatsPopover>) {
  return <StatsPopover {...props} />;
}

type WindowKeyListener = EventListenerOrEventListenerObject;

function trackWindowKeydownListeners() {
  const added: WindowKeyListener[] = [];
  const removed: WindowKeyListener[] = [];
  const active = new Set<WindowKeyListener>();
  const nativeAdd = window.addEventListener.bind(window);
  const nativeRemove = window.removeEventListener.bind(window);

  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "keydown") {
      added.push(listener);
      active.add(listener);
    }
    nativeAdd(type, listener, options);
  });
  vi.spyOn(window, "removeEventListener").mockImplementation((type, listener, options) => {
    if (type === "keydown") {
      removed.push(listener);
      active.delete(listener);
    }
    nativeRemove(type, listener, options);
  });

  return { active, added, removed };
}

function invokeWindowListener(listener: WindowKeyListener, event: KeyboardEvent) {
  if (typeof listener === "function") listener(event);
  else listener.handleEvent(event);
}

const emptySelectionCases: { label: string; select: (session: CollabSession) => void }[] = [
  { label: "missing", select: () => {} },
  { label: "collapsed", select: (session) => setLocalSelection(session, 4, 4) },
];

function openPopover() {
  fireEvent.click(screen.getByTestId("stats-button"));
  expect(screen.getByTestId("stats-popover")).toBeVisible();
}

function reactProp<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const value = props?.[name];
  if (typeof value !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return value as T;
}

type SourceHandler = (event: { currentTarget: EventTarget | null }) => void;
type GoalChangeHandler<T extends HTMLElement> = (event: { currentTarget: T }) => void;
type GoalSubmitHandler = (event: React.FormEvent<HTMLFormElement>) => void;
type GoalClearHandler = (event: { currentTarget: HTMLButtonElement }) => void;

interface GoalActions {
  form: HTMLFormElement;
  mode: HTMLSelectElement;
  value: HTMLInputElement;
  kind: HTMLSelectElement;
  set: HTMLButtonElement;
  clear: HTMLButtonElement | null;
  changeMode: GoalChangeHandler<HTMLSelectElement>;
  changeValue: GoalChangeHandler<HTMLInputElement>;
  changeKind: GoalChangeHandler<HTMLSelectElement>;
  submit: GoalSubmitHandler;
  clearGoal: GoalClearHandler | null;
  formRef: RefCallback<HTMLFormElement>;
  modeRef: RefCallback<HTMLSelectElement>;
  valueRef: RefCallback<HTMLInputElement>;
  kindRef: RefCallback<HTMLSelectElement>;
  setRef: RefCallback<HTMLButtonElement>;
  clearRef: RefCallback<HTMLButtonElement> | null;
}

function captureGoalActions(): GoalActions {
  const mode = screen.getByTestId("goal-mode") as HTMLSelectElement;
  const value = screen.getByTestId("goal-value") as HTMLInputElement;
  const kind = screen.getByTestId("goal-kind") as HTMLSelectElement;
  const set = screen.getByTestId("goal-set") as HTMLButtonElement;
  const form = set.form;
  if (!form) throw new Error("The Set button has no form");
  const clear = screen.queryByTestId("goal-clear") as HTMLButtonElement | null;
  return {
    form,
    mode,
    value,
    kind,
    set,
    clear,
    changeMode: reactProp(mode, "onChange"),
    changeValue: reactProp(value, "onChange"),
    changeKind: reactProp(kind, "onChange"),
    submit: reactProp(form, "onSubmit"),
    clearGoal: clear ? reactProp(clear, "onClick") : null,
    formRef: reactProp(form, "ref"),
    modeRef: reactProp(mode, "ref"),
    valueRef: reactProp(value, "ref"),
    kindRef: reactProp(kind, "ref"),
    setRef: reactProp(set, "ref"),
    clearRef: clear ? reactProp(clear, "ref") : null,
  };
}

function directSubmit(
  action: GoalActions,
  {
    currentTarget = action.form,
    nativeTarget = action.form,
    submitter = action.set,
    defaultPrevented = false,
    nativeEvent: suppliedNativeEvent,
  }: {
    currentTarget?: HTMLFormElement;
    nativeTarget?: EventTarget | null;
    submitter?: HTMLElement | null;
    defaultPrevented?: boolean;
    nativeEvent?: SubmitEvent;
  } = {},
) {
  const nativeEvent = suppliedNativeEvent ?? makeSubmitEvent(nativeTarget, submitter, defaultPrevented);
  const preventDefault = vi.fn(() => nativeEvent.preventDefault());
  action.submit({
    currentTarget,
    nativeEvent,
    defaultPrevented,
    preventDefault,
  } as unknown as React.FormEvent<HTMLFormElement>);
  return { nativeEvent, preventDefault };
}

function makeSubmitEvent(
  target: EventTarget | null,
  submitter: HTMLElement | null,
  defaultPrevented = false,
) {
  const event = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  if (defaultPrevented) event.preventDefault();
  return event;
}

function authorizeTrigger(source: EventTarget | null = screen.getByTestId("stats-button")) {
  const trigger = screen.getByTestId("stats-button");
  reactProp<SourceHandler>(trigger, "onClickCapture")({ currentTarget: source });
}

function expectDraft(kind: WritingGoal["kind"], mode: WritingGoal["mode"], value: string) {
  expect(screen.getByTestId("goal-kind")).toHaveValue(kind);
  expect(screen.getByTestId("goal-mode")).toHaveValue(mode);
  expect(screen.getByTestId("goal-value")).toHaveValue(Number(value) || null);
}

async function updateSharedGoal(session: CollabSession, next: WritingGoal | null) {
  await act(async () => {
    setGoal(session, next);
    await Promise.resolve();
  });
}

beforeEach(() => {
  capturedPopoverOpenChanges.length = 0;
  publishedPopoverOpenChanges.length = 0;
  unhandledRejections.length = 0;
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(async () => {
  cleanup();
  while (sessions.length) sessions.pop()!.destroy();
  await Promise.resolve();
  process.off("unhandledRejection", recordUnhandledRejection);
  vi.restoreAllMocks();
  expect(unhandledRejections).toEqual([]);
});

describe("StatsPopover local selection authority", () => {
  it("publishes current awareness and text changes once while keeping one subscription to each", async () => {
    const session = makeSession("current-selection");
    seedSelection(session, "One two three.", 0, 3);
    const subscriptions = trackSelectionSubscriptions(session);
    const publications = vi.fn();

    render(<SelectionProbe session={session} onSelection={publications} />);
    await act(async () => {});

    expect(screen.getByTestId("selection-probe")).toHaveTextContent("0:3");
    expect(subscriptions.activeAwareness()).toBe(1);
    expect(subscriptions.activeText()).toBe(1);
    expect(publications.mock.calls.map(([selection]) => selection)).toEqual([null, { from: 0, to: 3 }]);

    act(() => setLocalSelection(session, 4, 7));
    expect(screen.getByTestId("selection-probe")).toHaveTextContent("4:7");
    expect(publications.mock.calls.map(([selection]) => selection)).toEqual([null, { from: 0, to: 3 }, { from: 4, to: 7 }]);

    act(() => session.awareness.setLocalStateField("stats-test-revision", 1));
    await act(async () => {
      session.ytext.insert(session.ytext.length, " Four.");
      await Promise.resolve();
    });
    expect(publications.mock.calls.map(([selection]) => selection)).toEqual([null, { from: 0, to: 3 }, { from: 4, to: 7 }]);

    await act(async () => {
      session.ytext.insert(0, "Zero ");
      await Promise.resolve();
    });
    expect(screen.getByTestId("selection-probe")).toHaveTextContent("9:12");
    expect(publications.mock.calls.map(([selection]) => selection)).toEqual([
      null,
      { from: 0, to: 3 },
      { from: 4, to: 7 },
      { from: 9, to: 12 },
    ]);
    expect(subscriptions.activeAwareness()).toBe(1);
    expect(subscriptions.activeText()).toBe(1);
  });

  it("retires replacement listeners before old awareness and text changes at the parent layout boundary", async () => {
    const previous = makeSession("selection-previous");
    const current = makeSession("selection-current");
    seedSelection(previous, "One two three four.", 0, 13);
    seedSelection(current, "Alpha beta gamma.", 6, 10);
    const previousSubscriptions = trackSelectionSubscriptions(previous);
    const currentSubscriptions = trackSelectionSubscriptions(current);
    const currentInitialRead = vi.spyOn(current.awareness, "getLocalState");
    const publications = vi.fn();
    let previousPassiveCleaned = false;
    const onPassiveCleanup = vi.fn((session: CollabSession) => {
      if (session === previous) previousPassiveCleaned = true;
    });
    const rendered = render(
      <SelectionBoundary session={previous} onPassiveCleanup={onPassiveCleanup} onSelection={publications} />,
    );
    await act(async () => {});
    expect(screen.getByTestId("selection-probe")).toHaveTextContent("0:13");

    rendered.rerender(
      <SelectionBoundary
        session={current}
        boundary={1}
        onPassiveCleanup={onPassiveCleanup}
        onSelection={publications}
        onBoundary={() => {
          expect(previousPassiveCleaned).toBe(false);
          expect(currentInitialRead).toHaveBeenCalledOnce();
          setLocalSelection(previous, 14, 18);
          previous.ytext.insert(0, "Stale ");
        }}
      />,
    );
    await act(async () => {});

    expect(screen.getByTestId("selection-probe")).toHaveTextContent("6:10");
    expect(publications.mock.calls.map(([selection]) => selection)).toEqual([
      null,
      { from: 0, to: 13 },
      { from: 6, to: 10 },
    ]);
    expect(previousSubscriptions.activeAwareness()).toBe(0);
    expect(previousSubscriptions.activeText()).toBe(0);
    expect(previousSubscriptions.textUnsubscribes[0]?.calls).toBe(1);
    expect(currentSubscriptions.activeAwareness()).toBe(1);
    expect(currentSubscriptions.activeText()).toBe(1);
    expect(currentSubscriptions.awarenessOff).not.toHaveBeenCalled();
    expect(currentSubscriptions.textUnsubscribes[0]?.calls).toBe(0);
    expect(previousPassiveCleaned).toBe(true);
  });

  it("retires removed listeners before old awareness and text changes at the parent layout boundary", async () => {
    const session = makeSession("selection-removed");
    seedSelection(session, "One two three.", 4, 7);
    const subscriptions = trackSelectionSubscriptions(session);
    const publications = vi.fn();
    let passiveCleaned = false;
    const onPassiveCleanup = vi.fn((removed: CollabSession, present: boolean) => {
      if (removed === session && present) passiveCleaned = true;
    });
    const rendered = render(
      <SelectionBoundary session={session} onPassiveCleanup={onPassiveCleanup} onSelection={publications} />,
    );
    await act(async () => {});
    expect(screen.getByTestId("selection-probe")).toHaveTextContent("4:7");

    rendered.rerender(
      <SelectionBoundary
        session={session}
        present={false}
        boundary={1}
        onPassiveCleanup={onPassiveCleanup}
        onSelection={publications}
        onBoundary={() => {
          expect(passiveCleaned).toBe(false);
          setLocalSelection(session, 8, 13);
          session.ytext.insert(0, "Stale ");
        }}
      />,
    );
    await act(async () => {});

    expect(screen.queryByTestId("selection-probe")).toBeNull();
    expect(publications.mock.calls.map(([selection]) => selection)).toEqual([null, { from: 4, to: 7 }]);
    expect(subscriptions.activeAwareness()).toBe(0);
    expect(subscriptions.activeText()).toBe(0);
    expect(subscriptions.textUnsubscribes[0]?.calls).toBe(1);
    expect(passiveCleaned).toBe(true);
  });

  it.each(emptySelectionCases)("renders no selection counts for a $label local selection", async ({ select }) => {
    const session = makeSession("empty-selection");
    const source = "One two three.";
    session.ytext.insert(0, source);
    select(session);

    render(<SelectionStats session={session} source={source} />);
    await act(async () => {});
    openPopover();

    expect(screen.queryByTestId("selection-count")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Selection" })).toBeNull();
  });
});

describe("StatsPopover disclosure visit authority", () => {
  it("requires one exact current trigger or content event for each disclosure transition", () => {
    const session = makeSession("disclosure-controls");
    render(view(session));
    const trigger = screen.getByTestId("stats-button");
    const authorizeOpen = reactProp<SourceHandler>(trigger, "onClickCapture");
    const openChange = capturedPopoverOpenChanges.at(-1)!;
    const foreign = document.createElement("button");
    const sibling = document.createElement("button");
    const detached = document.createElement("button");
    const replacement = trigger.cloneNode(true) as HTMLButtonElement;
    const focusOwner = document.createElement("button");
    trigger.parentElement?.append(sibling);
    document.body.append(foreign, focusOwner);
    focusOwner.focus();

    try {
      const closedMarkup = document.body.innerHTML;
      act(() => {
        for (const source of [foreign, sibling, detached, replacement]) {
          authorizeOpen({ currentTarget: source });
          openChange(true);
        }
        openChange(true);
      });
      expect(screen.queryByTestId("stats-popover")).toBeNull();
      expect(document.body.innerHTML).toBe(closedMarkup);
      expect(focusOwner).toHaveFocus();

      act(() => {
        authorizeOpen({ currentTarget: trigger });
        openChange(true);
        openChange(true);
      });
      const content = screen.getByTestId("stats-popover");
      expect(content).toBeVisible();
      const staleOpenChange = openChange;
      const staleAuthorizeOpen = authorizeOpen;
      const closeChange = capturedPopoverOpenChanges.at(-1)!;
      const authorizeClose = reactProp<SourceHandler>(content, "onKeyDownCapture");
      const openMarkup = document.body.innerHTML;
      const focusAfterOpen = document.activeElement;

      act(() => {
        staleAuthorizeOpen({ currentTarget: trigger });
        staleOpenChange(false);
        for (const source of [foreign, sibling, detached, replacement, trigger]) {
          authorizeClose({ currentTarget: source });
          closeChange(false);
        }
        closeChange(false);
      });
      expect(screen.getByTestId("stats-popover")).toBeVisible();
      expect(document.body.innerHTML).toBe(openMarkup);
      expect(document.activeElement).toBe(focusAfterOpen);

      fireEvent.pointerDown(content, { button: 0 });
      act(() => {
        closeChange(false);
        closeChange(false);
      });
      expect(screen.queryByTestId("stats-popover")).toBeNull();
    } finally {
      foreign.remove();
      sibling.remove();
      replacement.remove();
      focusOwner.remove();
    }
  });

  it.each([
    ["source/statistics", { source: "One two three four five.", selection: null, hydrated: true, mount: "initial" }],
    ["selection", { source: "One two three.", selection: { from: 0, to: 3 }, hydrated: true, mount: "initial" }],
    ["hydration", { source: "One two three.", selection: null, hydrated: false, mount: "initial" }],
    ["equal-looking remount", { source: "One two three.", selection: null, hydrated: true, mount: "replacement" }],
  ] as const)("retires a disclosure publication at the parent layout boundary for %s", (_label, next) => {
    const session = makeSession(`disclosure-${_label}`);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(<StatsBoundary session={session} />));
      openPopover();
      const staleTrigger = screen.getByTestId("stats-button");
      const staleAuthorize = reactProp<SourceHandler>(staleTrigger, "onClickCapture");
      const staleChange = capturedPopoverOpenChanges.at(-1)!;
      let boundaryReached = false;

      act(() => {
        root.render(
          <StatsBoundary
            session={session}
            source={next.source}
            selection={next.selection}
            hydrated={next.hydrated}
            mount={next.mount}
            boundary={1}
            onBoundary={() => {
              boundaryReached = true;
              const markup = host.innerHTML;
              staleAuthorize({ currentTarget: staleTrigger });
              staleChange(false);
              expect(host.innerHTML).toBe(markup);
              if (next.mount === "replacement") expect(screen.queryByTestId("stats-popover")).toBeNull();
              else expect(screen.getByTestId("stats-popover")).toBeVisible();
            }}
          />,
        );
      });

      expect(boundaryReached).toBe(true);
      if (next.mount === "replacement") openPopover();
      expect(screen.getByTestId("stats-popover")).toBeVisible();
      expect(screen.getByTestId("word-count")).toHaveTextContent(next.hydrated ? `${next.source.split(/\s+/).length} words` : "— words");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it.each([
    ["A before B", false],
    ["B before A", true],
  ] as const)(
    "retires A before a replacement parent layout boundary and preserves B when callbacks run %s",
    (_label, currentFirst) => {
      const previous = makeSession("stats-previous");
      const current = makeSession("stats-current");
      const listeners = trackWindowKeydownListeners();
      const host = document.createElement("div");
      const focusOwner = document.createElement("button");
      document.body.append(focusOwner, host);
      const root = createRoot(host);
      let passiveCleanups = 0;

      try {
        act(() => root.render(<StatsBoundary session={previous} onPassiveCleanup={() => passiveCleanups++} />));
        fireEvent.click(screen.getByTestId("stats-button"));
        expect(screen.getByTestId("stats-popover")).toBeVisible();
        expect(listeners.active.size).toBe(1);

        const staleKey = listeners.added[0]!;
        const staleOpenChange = capturedPopoverOpenChanges[0]!;
        const staleEvent = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "KeyC",
          ctrlKey: true,
          shiftKey: true,
        });
        const stalePreventDefault = vi.spyOn(staleEvent, "preventDefault");
        publishedPopoverOpenChanges.length = 0;
        focusOwner.focus();

        act(() => {
          root.render(
            <StatsBoundary
              session={current}
              source="One two three four five."
              boundary={1}
              onPassiveCleanup={() => passiveCleanups++}
              onBoundary={() => {
                expect(passiveCleanups).toBe(0);
                expect(screen.queryByTestId("stats-popover")).toBeNull();
                expect(listeners.added).toHaveLength(2);
                expect(listeners.removed).toEqual([staleKey]);
                expect([...listeners.active]).toEqual([listeners.added[1]]);

                const currentOpenChange = capturedPopoverOpenChanges.findLast(
                  (callback) => callback !== staleOpenChange,
                )!;
                const focusBeforeStaleCallbacks = document.activeElement;
                if (currentFirst) {
                  authorizeTrigger();
                  currentOpenChange(true);
                }
                staleOpenChange(false);
                invokeWindowListener(staleKey, staleEvent);
                if (!currentFirst) {
                  authorizeTrigger();
                  currentOpenChange(true);
                }
                expect(document.activeElement).toBe(focusBeforeStaleCallbacks);
              }}
            />,
          );
        });

        expect(stalePreventDefault).not.toHaveBeenCalled();
        expect(screen.getByTestId("stats-popover")).toBeVisible();
        expect(screen.getByTestId("word-count")).toHaveTextContent("5 words");
        const currentOpenChange = capturedPopoverOpenChanges.findLast(
          (callback) => callback !== staleOpenChange,
        )!;

        publishedPopoverOpenChanges.length = 0;
        fireEvent.click(screen.getByTestId("stats-button"));
        expect(screen.queryByTestId("stats-popover")).toBeNull();
        expect(
          publishedPopoverOpenChanges.filter(({ callback }) => callback === currentOpenChange),
        ).toEqual([{ callback: currentOpenChange, open: false }]);

        const currentEvent = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "KeyC",
          ctrlKey: true,
          shiftKey: true,
        });
        const currentPreventDefault = vi.spyOn(currentEvent, "preventDefault");
        act(() => window.dispatchEvent(currentEvent));
        expect(currentPreventDefault).toHaveBeenCalledOnce();
        expect(screen.getByTestId("stats-popover")).toBeVisible();
        expect(listeners.active.size).toBe(1);

        act(() => {
          staleOpenChange(false);
          invokeWindowListener(staleKey, staleEvent);
        });
        expect(stalePreventDefault).not.toHaveBeenCalled();
        expect(screen.getByTestId("stats-popover")).toBeVisible();
        expect([...listeners.active]).toEqual([listeners.added[1]]);
      } finally {
        act(() => root.unmount());
        host.remove();
        focusOwner.remove();
      }
    },
  );

  it("retires a removed visit before the parent layout boundary", () => {
    const session = makeSession("stats-removed");
    const listeners = trackWindowKeydownListeners();
    const host = document.createElement("div");
    const focusOwner = document.createElement("button");
    document.body.append(focusOwner, host);
    const root = createRoot(host);
    let passiveCleanups = 0;

    try {
      act(() => root.render(<StatsBoundary session={session} onPassiveCleanup={() => passiveCleanups++} />));
      fireEvent.click(screen.getByTestId("stats-button"));
      expect(screen.getByTestId("stats-popover")).toBeVisible();

      const staleKey = listeners.added[0]!;
      const staleOpenChange = capturedPopoverOpenChanges[0]!;
      const staleEvent = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyC",
        metaKey: true,
        shiftKey: true,
      });
      const stalePreventDefault = vi.spyOn(staleEvent, "preventDefault");
      focusOwner.focus();

      act(() => {
        root.render(
          <StatsBoundary
            session={session}
            present={false}
            boundary={1}
            onPassiveCleanup={() => passiveCleanups++}
            onBoundary={() => {
              expect(passiveCleanups).toBe(0);
              expect(screen.queryByTestId("stats-popover")).toBeNull();
              expect(listeners.removed).toEqual([staleKey]);
              expect(listeners.active.size).toBe(0);
              const focusBeforeStaleCallbacks = document.activeElement;
              staleOpenChange(true);
              invokeWindowListener(staleKey, staleEvent);
              expect(document.activeElement).toBe(focusBeforeStaleCallbacks);
            }}
          />,
        );
      });

      expect(stalePreventDefault).not.toHaveBeenCalled();
      expect(screen.queryByTestId("stats-popover")).toBeNull();
      expect(listeners.active.size).toBe(0);
    } finally {
      act(() => root.unmount());
      host.remove();
      focusOwner.remove();
    }
  });
});

describe("StatsPopover writing goal draft", () => {
  it("follows a collaborator setting, changing, and clearing every shared goal field", async () => {
    const session = makeSession("doc");
    render(view(session));
    openPopover();
    expectDraft("words", "min", "");

    await updateSharedGoal(session, goal("words", "min", 250));
    expectDraft("words", "min", "250");

    fireEvent.change(screen.getByTestId("goal-value"), { target: { value: "999" } });
    fireEvent.change(screen.getByTestId("goal-kind"), { target: { value: "minutes" } });
    await updateSharedGoal(session, goal("minutes", "max", 7, "carol"));
    expectDraft("minutes", "max", "7");
    expect(screen.getByTestId("goal-section")).toHaveTextContent("Set by @carol");

    await updateSharedGoal(session, null);
    expectDraft("words", "min", "");
    expect(screen.getByTestId("goal-summary")).toHaveAttribute("data-state", "none");
  });

  it("drops the previous document draft when navigation supplies a goal-less session", () => {
    const first = makeSession("first", "owner", goal("minutes", "max", 12));
    const second = makeSession("second");
    const rendered = render(view(first));
    openPopover();
    expectDraft("minutes", "max", "12");

    fireEvent.change(screen.getByTestId("goal-value"), { target: { value: "44" } });
    rendered.rerender(view(second));

    expect(screen.queryByTestId("stats-popover")).toBeNull();
    openPopover();
    expectDraft("words", "min", "");
    expect(screen.getByTestId("goal-summary")).toHaveAttribute("data-state", "none");
  });

  it("keeps local edits through source, statistics, and unrelated session rerenders", async () => {
    const session = makeSession("doc", "owner", goal("words", "min", 100));
    const rendered = render(view(session, "One two."));
    openPopover();

    fireEvent.change(screen.getByTestId("goal-mode"), { target: { value: "max" } });
    fireEvent.change(screen.getByTestId("goal-value"), { target: { value: "333" } });
    fireEvent.change(screen.getByTestId("goal-kind"), { target: { value: "minutes" } });
    await act(async () => {
      session.ytext.insert(0, "An unrelated source update.");
      await Promise.resolve();
    });
    rendered.rerender(view(session, "One two three four five."));

    expect(screen.getByTestId("word-count")).toHaveTextContent("5 words");
    expectDraft("minutes", "max", "333");
    expect(getGoal(session)).toMatchObject({ kind: "words", mode: "min", value: 100 });
  });

  it("binds every draft callback and callback-ref retirement to the exact current form control", () => {
    const session = makeSession("draft-controls", "owner", goal("words", "min", 100));
    const rendered = render(view(session));
    openPopover();
    const stale = captureGoalActions();
    const foreignMode = document.createElement("select");
    const foreignValue = document.createElement("input");
    const foreignKind = document.createElement("select");
    const detachedMode = stale.mode.cloneNode(true) as HTMLSelectElement;
    const detachedValue = stale.value.cloneNode(true) as HTMLInputElement;
    const detachedKind = stale.kind.cloneNode(true) as HTMLSelectElement;
    foreignMode.innerHTML = '<option value="max">At most</option>';
    foreignKind.innerHTML = '<option value="minutes">min read</option>';
    foreignMode.value = "max";
    foreignValue.value = "777";
    foreignKind.value = "minutes";
    detachedMode.value = "max";
    detachedValue.value = "888";
    detachedKind.value = "minutes";
    document.body.append(foreignMode, foreignValue, foreignKind);

    try {
      act(() => {
        stale.changeMode({ currentTarget: foreignMode });
        stale.changeMode({ currentTarget: detachedMode });
        stale.changeValue({ currentTarget: foreignValue });
        stale.changeValue({ currentTarget: detachedValue });
        stale.changeKind({ currentTarget: foreignKind });
        stale.changeKind({ currentTarget: detachedKind });
      });
      expectDraft("words", "min", "100");

      const replacement = stale.value.cloneNode(true) as HTMLInputElement;
      replacement.value = "999";
      stale.value.replaceWith(replacement);
      stale.valueRef(null);
      act(() => {
        stale.changeValue({ currentTarget: stale.value });
        stale.changeValue({ currentTarget: replacement });
      });
      expect(screen.getByTestId("goal-value")).toBe(replacement);
      expect(getGoal(session)).toMatchObject({ value: 100 });

      replacement.replaceWith(stale.value);
      rendered.rerender(view(session, "One two three four."));
      const current = captureGoalActions();
      expect(current.form).toBe(stale.form);
      expect(current.mode).toBe(stale.mode);
      expect(current.value).toBe(stale.value);
      expect(current.kind).toBe(stale.kind);
      stale.formRef(null);
      stale.modeRef(null);
      stale.valueRef(null);
      stale.kindRef(null);
      stale.setRef(null);
      stale.clearRef?.(null);

      current.mode.value = "max";
      act(() => {
        stale.changeMode({ currentTarget: current.mode });
        current.changeMode({ currentTarget: current.mode });
        current.changeMode({ currentTarget: current.mode });
      });
      expectDraft("words", "max", "100");

      const afterMode = captureGoalActions();
      afterMode.value.value = "321";
      act(() => afterMode.changeValue({ currentTarget: afterMode.value }));
      const afterValue = captureGoalActions();
      afterValue.kind.value = "minutes";
      act(() => afterValue.changeKind({ currentTarget: afterValue.kind }));
      expectDraft("minutes", "max", "321");
      expect(getGoal(session)).toMatchObject({ kind: "words", mode: "min", value: 100 });
    } finally {
      foreignMode.remove();
      foreignValue.remove();
      foreignKind.remove();
      detachedMode.remove();
      detachedValue.remove();
      detachedKind.remove();
    }
  });

  it("claims only an exact enabled Set submitter before prevention, parsing, time, and one shared write", () => {
    const session = makeSession("set-controls");
    let writes = 0;
    session.meta.observe(() => writes++);
    const rendered = render(view(session));
    openPopover();
    const disabled = captureGoalActions();
    const foreignForm = document.createElement("form");
    const foreignButton = document.createElement("button");
    const detachedButton = document.createElement("button");
    foreignForm.append(foreignButton);
    document.body.append(foreignForm);
    const disabledEvent = makeSubmitEvent(disabled.form, disabled.set);
    const wrongFormEvent = makeSubmitEvent(foreignForm, disabled.set);
    const wrongSubmitterEvent = makeSubmitEvent(disabled.form, foreignButton);
    const detachedSubmitterEvent = makeSubmitEvent(disabled.form, detachedButton);
    const now = vi.spyOn(Date, "now").mockReturnValue(123_456);

    try {
      const disabledSubmit = directSubmit(disabled, { nativeEvent: disabledEvent });
      const wrongForm = directSubmit(disabled, {
        currentTarget: foreignForm,
        nativeEvent: wrongFormEvent,
      });
      const wrongSubmitter = directSubmit(disabled, { nativeEvent: wrongSubmitterEvent });
      const detachedSubmitter = directSubmit(disabled, { nativeEvent: detachedSubmitterEvent });
      expect([
        disabledSubmit.preventDefault,
        wrongForm.preventDefault,
        wrongSubmitter.preventDefault,
        detachedSubmitter.preventDefault,
      ].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);
      expect(now).not.toHaveBeenCalled();
      expect(writes).toBe(0);
      expect(getGoal(session)).toBeNull();

      fireEvent.change(disabled.value, { target: { value: "4.6" } });
      fireEvent.change(screen.getByTestId("goal-mode"), { target: { value: "max" } });
      fireEvent.change(screen.getByTestId("goal-kind"), { target: { value: "minutes" } });
      const current = captureGoalActions();
      expect(current.set).not.toBeDisabled();
      const replacement = current.set.cloneNode(true) as HTMLButtonElement;
      current.set.replaceWith(replacement);
      const replacementEvent = makeSubmitEvent(current.form, replacement);
      const retiredEvent = makeSubmitEvent(current.form, current.set);
      now.mockClear();
      const replaced = directSubmit(current, { nativeEvent: replacementEvent });
      const retired = directSubmit(current, { nativeEvent: retiredEvent });
      expect(replaced.preventDefault).not.toHaveBeenCalled();
      expect(retired.preventDefault).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
      expect(writes).toBe(0);
      replacement.replaceWith(current.set);
      rendered.rerender(view(session, "Refreshed source."));
      const refreshed = captureGoalActions();
      const acceptedEvent = makeSubmitEvent(refreshed.form, refreshed.set);
      now.mockClear();
      let accepted!: ReturnType<typeof directSubmit>;
      act(() => {
        accepted = directSubmit(refreshed, { nativeEvent: acceptedEvent });
      });
      expect(accepted.preventDefault).toHaveBeenCalledOnce();
      expect(now).toHaveBeenCalledOnce();
      expect(writes).toBe(1);
      expect(getGoal(session)).toMatchObject({
        kind: "minutes",
        mode: "max",
        value: 5,
        setBy: "alice",
        setAt: 123_456,
      });
    } finally {
      foreignForm.remove();
      detachedButton.remove();
    }
  });

  it("sets the frozen current draft once after wrong submitters and repeated competing submissions", async () => {
    const session = makeSession("set-once");
    let writes = 0;
    session.meta.observe(() => writes++);
    render(view(session));
    openPopover();
    fireEvent.change(screen.getByTestId("goal-mode"), { target: { value: "max" } });
    fireEvent.change(screen.getByTestId("goal-value"), { target: { value: "4.6" } });
    fireEvent.change(screen.getByTestId("goal-kind"), { target: { value: "minutes" } });
    const current = captureGoalActions();
    const wrong = document.createElement("button");
    document.body.append(wrong);
    const wrongEvent = makeSubmitEvent(current.form, wrong);
    const now = vi.spyOn(Date, "now").mockReturnValue(654_321);

    try {
      const wrongSubmit = directSubmit(current, { nativeEvent: wrongEvent });
      expect(wrongSubmit.preventDefault).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
      expect(writes).toBe(0);

      const acceptedEvent = makeSubmitEvent(current.form, current.set);
      const repeatedEvent = makeSubmitEvent(current.form, current.set);
      now.mockClear();
      let accepted!: ReturnType<typeof directSubmit>;
      act(() => {
        accepted = directSubmit(current, { nativeEvent: acceptedEvent });
        directSubmit(current, { nativeEvent: repeatedEvent });
      });
      expect(accepted.preventDefault).toHaveBeenCalledOnce();
      expect(now).toHaveBeenCalledOnce();
      expect(writes).toBe(1);
      await waitFor(() => {
        expect(getGoal(session)).toEqual({
          kind: "minutes",
          mode: "max",
          value: 5,
          setBy: "alice",
          setAt: 654_321,
        });
      });
    } finally {
      wrong.remove();
    }
  });

  it.each([
    ["stale before current", false],
    ["current before stale", true],
  ] as const)("lets only the exact collaborator-updated Clear presentation write in %s order", async (_label, currentFirst) => {
    const session = makeSession("clear-order", "owner", goal("words", "min", 100));
    let writes = 0;
    session.meta.observe(() => writes++);
    render(view(session));
    openPopover();
    const stale = captureGoalActions();
    await updateSharedGoal(session, goal("minutes", "max", 9, "carol"));
    writes = 0;
    const current = captureGoalActions();
    if (!stale.clear || !stale.clearGoal || !current.clear || !current.clearGoal) {
      throw new Error("Clear controls were not rendered");
    }

    act(() => {
      if (currentFirst) current.clearGoal!({ currentTarget: current.clear! });
      stale.clearGoal!({ currentTarget: stale.clear! });
      stale.clearGoal!({ currentTarget: current.clear! });
      if (!currentFirst) current.clearGoal!({ currentTarget: current.clear! });
      current.clearGoal!({ currentTarget: current.clear! });
    });

    expect(writes).toBe(1);
    expect(getGoal(session)).toBeNull();
  });

  it("rejects Set and Clear immediately when the shared goal changes before React republishes", async () => {
    const session = makeSession("goal-before-render", "owner", goal("words", "min", 100));
    let writes = 0;
    session.meta.observe(() => writes++);
    render(view(session));
    openPopover();
    const stale = captureGoalActions();
    if (!stale.clear || !stale.clearGoal) throw new Error("Clear was not rendered");
    const staleSubmitEvent = makeSubmitEvent(stale.form, stale.set);
    const now = vi.spyOn(Date, "now").mockReturnValue(987_654);

    setGoal(session, goal("minutes", "max", 8, "carol"));
    const submitAttempt = directSubmit(stale, { nativeEvent: staleSubmitEvent });
    stale.clearGoal({ currentTarget: stale.clear });

    expect(writes).toBe(1);
    expect(submitAttempt.preventDefault).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(getGoal(session)).toEqual(goal("minutes", "max", 8, "carol"));

    await act(async () => {
      await Promise.resolve();
    });
    const current = captureGoalActions();
    if (!current.clear || !current.clearGoal) throw new Error("Current Clear was not rendered");
    act(() => current.clearGoal!({ currentTarget: current.clear! }));
    expect(writes).toBe(2);
    expect(getGoal(session)).toBeNull();
  });

  it("retires Clear synchronously across permission removal and restores one usable current control", async () => {
    const session = makeSession("clear-permission", "owner", goal("words", "min", 50));
    let writes = 0;
    session.meta.observe(() => writes++);
    render(view(session));
    openPopover();
    const stale = captureGoalActions();
    if (!stale.clear || !stale.clearGoal) throw new Error("Clear was not rendered");

    await act(async () => {
      session.setMode("viewing");
      await Promise.resolve();
    });
    expect(screen.queryByTestId("goal-clear")).toBeNull();
    act(() => stale.clearGoal!({ currentTarget: stale.clear! }));
    expect(writes).toBe(0);
    expect(getGoal(session)).toMatchObject({ value: 50 });

    await act(async () => {
      session.setMode("editing");
      await Promise.resolve();
    });
    const current = captureGoalActions();
    if (!current.clear || !current.clearGoal) throw new Error("Current Clear was not rendered");
    act(() => {
      stale.clearGoal!({ currentTarget: current.clear! });
      current.clearGoal!({ currentTarget: current.clear! });
      current.clearGoal!({ currentTarget: current.clear! });
    });
    expect(writes).toBe(1);
    expect(getGoal(session)).toBeNull();
  });

  it("submits and clears only the current session, preserving rounding and attribution", async () => {
    const previous = makeSession("previous", "owner", goal("words", "min", 400));
    const current = makeSession("current");
    let previousWrites = 0;
    let currentWrites = 0;
    previous.meta.observe(() => previousWrites++);
    current.meta.observe(() => currentWrites++);

    const rendered = render(view(previous));
    openPopover();
    rendered.rerender(view(current));
    expect(screen.queryByTestId("stats-popover")).toBeNull();
    openPopover();
    fireEvent.change(screen.getByTestId("goal-mode"), { target: { value: "max" } });
    fireEvent.change(screen.getByTestId("goal-value"), { target: { value: "4.6" } });
    fireEvent.change(screen.getByTestId("goal-kind"), { target: { value: "minutes" } });
    directSubmit(captureGoalActions());

    await waitFor(() => expect(getGoal(current)).toMatchObject({ kind: "minutes", mode: "max", value: 5, setBy: "alice" }));
    expect(getGoal(previous)).toMatchObject({ kind: "words", mode: "min", value: 400 });
    expect(previousWrites).toBe(0);
    expect(currentWrites).toBe(1);
    expectDraft("minutes", "max", "5");

    fireEvent.click(screen.getByTestId("goal-clear"));
    await waitFor(() => expect(getGoal(current)).toBeNull());
    expect(getGoal(previous)).toMatchObject({ value: 400 });
    expect(previousWrites).toBe(0);
    expect(currentWrites).toBe(2);
    expectDraft("words", "min", "");
  });

  it("keeps shared goal progress and attribution read-only while following remote updates", async () => {
    const session = makeSession("read-only", "viewer", goal("minutes", "max", 3));
    render(view(session));
    openPopover();

    expect(screen.getByTestId("goal-summary")).toHaveTextContent("At most 3 min read");
    expect(screen.getAllByTestId("goal-ring")).toHaveLength(2);
    expect(screen.getByTestId("goal-section")).toHaveTextContent("Set by @bob");
    expect(screen.queryByTestId("goal-set")).toBeNull();
    expect(screen.queryByTestId("goal-clear")).toBeNull();

    await updateSharedGoal(session, goal("words", "min", 10, "carol"));
    expect(screen.getByTestId("goal-summary")).toHaveTextContent("At least 10 words");
    expect(screen.getByTestId("goal-section")).toHaveTextContent("Set by @carol");
    expect(screen.queryByTestId("goal-value")).toBeNull();

    await updateSharedGoal(session, null);
    expect(screen.getByTestId("goal-summary")).toHaveTextContent("No goal set for this document");
    expect(screen.queryAllByTestId("goal-ring")).toHaveLength(0);
  });
});
