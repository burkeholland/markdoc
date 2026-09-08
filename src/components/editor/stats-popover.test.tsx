// @vitest-environment jsdom
import { StrictMode, useEffect, useLayoutEffect, type ComponentProps, type RefCallback } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as Y from "yjs";

type PopoverOpenChange = (open: boolean) => void;
interface StatsContentCallbacks {
  escape?: (event: KeyboardEvent) => void;
  closeAutoFocus?: (event: Event) => void;
  pointerOutside?: (
    event: CustomEvent<{ originalEvent: PointerEvent }>,
  ) => void;
  focusOutside?: (
    event: CustomEvent<{ originalEvent: FocusEvent }>,
  ) => void;
}

const capturedPopoverOpenChanges = vi.hoisted(() => [] as PopoverOpenChange[]);
const capturedStatsContentCallbacks = vi.hoisted(
  () => [] as StatsContentCallbacks[],
);
const publishedPopoverOpenChanges = vi.hoisted(
  () => [] as { callback: PopoverOpenChange; open: boolean }[],
);

vi.mock("@/components/ui/primitives", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/primitives")>();
  const ActualPopover = actual.Popover;
  const ActualPopoverContent = actual.PopoverContent;
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
    PopoverContent: (
      props: ComponentProps<typeof ActualPopoverContent>,
    ) => {
      capturedStatsContentCallbacks.push({
        escape: props.onEscapeKeyDown,
        closeAutoFocus: props.onCloseAutoFocus,
        pointerOutside: props.onPointerDownOutside,
        focusOutside: props.onFocusOutside,
      });
      return <ActualPopoverContent {...props} />;
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

type GoalChangeHandler<T extends HTMLElement> = (event: React.ChangeEvent<T>) => void;
type GoalSubmitHandler = (event: React.FormEvent<HTMLFormElement>) => void;
type GoalClearHandler = (event: React.MouseEvent<HTMLButtonElement>) => void;

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
    target = action.form,
    nativeTarget = action.form,
    submitter = action.set,
    defaultPrevented = false,
    nativeEvent: suppliedNativeEvent,
  }: {
    currentTarget?: HTMLFormElement;
    target?: EventTarget | null;
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
    target,
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
  const ownerWindow = target instanceof Node ? target.ownerDocument?.defaultView : window;
  const event = new (ownerWindow ?? window).SubmitEvent("submit", { bubbles: true, cancelable: true, submitter });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  if (defaultPrevented) event.preventDefault();
  return event;
}

function makeChangeEvent(target: HTMLElement, type: "change" | "input" = "change") {
  const ownerWindow = target.ownerDocument.defaultView ?? window;
  const event = new ownerWindow.Event(type, { bubbles: true });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function directChange<T extends HTMLSelectElement | HTMLInputElement>(
  handler: GoalChangeHandler<T>,
  control: T,
  {
    currentTarget = control,
    target = control,
    nativeEvent = makeChangeEvent(control, control instanceof HTMLInputElement ? "input" : "change"),
    defaultPrevented = false,
  }: {
    currentTarget?: T;
    target?: EventTarget | null;
    nativeEvent?: Event;
    defaultPrevented?: boolean;
  } = {},
) {
  handler({
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented,
  } as unknown as React.ChangeEvent<T>);
  return nativeEvent;
}

function makeClickEvent(target: Node) {
  const ownerWindow = target.ownerDocument?.defaultView ?? window;
  const event = new ownerWindow.MouseEvent("click", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function directClear(
  action: GoalActions,
  {
    currentTarget = action.clear,
    target = action.clear,
    nativeEvent = target ? makeClickEvent(target) : null,
    defaultPrevented = false,
  }: {
    currentTarget?: HTMLButtonElement | null;
    target?: Node | null;
    nativeEvent?: MouseEvent | null;
    defaultPrevented?: boolean;
  } = {},
) {
  if (!action.clearGoal || !currentTarget || !target || !nativeEvent) throw new Error("Clear control was not rendered");
  action.clearGoal({
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented,
  } as unknown as React.MouseEvent<HTMLButtonElement>);
  return nativeEvent;
}

type StatsTriggerHandler = (
  event: React.MouseEvent<HTMLButtonElement>,
) => void;

interface CapturedStatsTrigger {
  element: HTMLButtonElement;
  click: StatsTriggerHandler;
  ref: RefCallback<HTMLButtonElement>;
}

function captureStatsTrigger(): CapturedStatsTrigger {
  const element = screen.getByTestId(
    "stats-button",
  ) as HTMLButtonElement;
  return {
    element,
    click: reactProp(element, "onClick"),
    ref: reactProp(element, "ref"),
  };
}

function dispatchStatsClick(
  trigger: CapturedStatsTrigger,
  handlers: readonly StatsTriggerHandler[],
) {
  const propsKey = Object.keys(trigger.element).find((key) =>
    key.startsWith("__reactProps$"),
  );
  if (!propsKey) {
    throw new Error("React props were not attached to stats-button");
  }
  const properties = trigger.element as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const props = properties[propsKey];
  if (!props) {
    throw new Error("React props were not attached to stats-button");
  }
  const wrapped = {
    ...props,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      for (const handler of handlers) handler(event);
    },
  };
  properties[propsKey] = wrapped;
  try {
    fireEvent.click(trigger.element);
  } finally {
    if (properties[propsKey] === wrapped) {
      properties[propsKey] = props;
    }
  }
}

function renderStrictStats(
  session: CollabSession,
  onBoundary: () => void,
  source = "One two three.",
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <StrictMode>
        <StatsBoundary
          session={session}
          source={source}
          boundary={1}
          onBoundary={onBoundary}
        />
      </StrictMode>,
    ),
  );
  return { host, root };
}

function dispatchStatsOutside(
  source: "pointer" | "focus",
  target: HTMLElement,
  callbacks: readonly StatsContentCallbacks[],
  openChanges: readonly PopoverOpenChange[],
) {
  const pending: VoidFunction[] = [];
  const queued = vi
    .spyOn(globalThis, "queueMicrotask")
    .mockImplementation((callback) => pending.push(callback));
  const callbackName =
    source === "pointer" ? "pointerOutside" : "focusOutside";
  const customType =
    source === "pointer"
      ? "dismissableLayer.pointerDownOutside"
      : "dismissableLayer.focusOutside";
  const consumeType = source === "pointer" ? "click" : "focusin";
  const original =
    source === "pointer"
      ? new MouseEvent("pointerdown", {
          bubbles: true,
          button: 0,
          cancelable: true,
          composed: true,
        })
      : new FocusEvent("focusin", {
          bubbles: true,
          cancelable: true,
          composed: true,
        });
  const consume = (event: Event) => {
    if (source === "focus" && event !== original) return;
    const custom = new CustomEvent(customType, {
      bubbles: true,
      cancelable: true,
      composed: true,
      detail: { originalEvent: original },
    });
    for (const callbacksForPublication of callbacks) {
      const callback = callbacksForPublication[callbackName];
      if (!callback) continue;
      target.addEventListener(
        customType,
        (value) =>
          callback(
            value as CustomEvent<{
              originalEvent: PointerEvent & FocusEvent;
            }>,
          ),
        { once: true },
      );
    }
    target.dispatchEvent(custom);
    for (const openChange of openChanges) {
      queueMicrotask(() => openChange(false));
    }
    while (pending.length) pending.shift()!();
    event.stopPropagation();
  };
  target.addEventListener(consumeType, consume);
  try {
    act(() => {
      if (source === "pointer") {
        target.dispatchEvent(original);
        target.dispatchEvent(
          new MouseEvent("pointerup", {
            bubbles: true,
            button: 0,
            cancelable: true,
            composed: true,
          }),
        );
        target.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            button: 0,
            cancelable: true,
            composed: true,
          }),
        );
      } else {
        target.dispatchEvent(original);
      }
    });
  } finally {
    target.removeEventListener(consumeType, consume);
    queued.mockRestore();
    act(() => {
      while (pending.length) pending.shift()!();
    });
  }
}

function expectDraft(kind: WritingGoal["kind"], mode: WritingGoal["mode"], value: string) {
  expect(screen.getByTestId("goal-kind")).toHaveValue(kind);
  expect(screen.getByTestId("goal-mode")).toHaveValue(mode);
  expect(screen.getByTestId("goal-value")).toHaveValue(Number(value) || null);
}

function mountStrictGoal(session: CollabSession, source = "One two three.") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<StrictMode>{view(session, source)}</StrictMode>));
  openPopover();
  return {
    host,
    root,
    rerender(nextSource: string, replacement = false) {
      const props = { session, source: nextSource, selection: null, hydrated: true };
      act(() =>
        root.render(
          <StrictMode>
            {replacement ? <ReplacementStatsPopover {...props} /> : <StatsPopover {...props} />}
          </StrictMode>,
        ),
      );
    },
  };
}

async function updateSharedGoal(session: CollabSession, next: WritingGoal | null) {
  await act(async () => {
    setGoal(session, next);
    await Promise.resolve();
  });
}

beforeEach(() => {
  capturedPopoverOpenChanges.length = 0;
  capturedStatsContentCallbacks.length = 0;
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
  it("uses only the distinct exact trigger successor after direct-root Strict Mode replay", () => {
    const session = makeSession("strict-trigger");
    const replay = {
      trigger: null as CapturedStatsTrigger | null,
    };
    const mounted = renderStrictStats(session, () => {
      replay.trigger ??= captureStatsTrigger();
    });

    try {
      const replayTrigger = replay.trigger;
      if (!replayTrigger) {
        throw new Error("Strict Mode did not expose its first layout");
      }
      const current = captureStatsTrigger();
      expect(current.element).toBe(replayTrigger.element);
      expect(current.click).not.toBe(replayTrigger.click);
      replayTrigger.ref(null);
      replayTrigger.ref(current.element);

      dispatchStatsClick(current, [
        replayTrigger.click,
        current.click,
        current.click,
      ]);

      expect(screen.getByTestId("stats-popover")).toBeVisible();
      fireEvent.click(screen.getByTestId("stats-button"));
      expect(screen.queryByTestId("stats-popover")).toBeNull();
    } finally {
      act(() => mounted.root.unmount());
      mounted.host.remove();
    }
  });

  it("keeps mutated, detached, replaced, and reordered trigger publications retired", () => {
    const mounted = renderStrictStats(
      makeSession("strict-trigger-integrity"),
      () => {},
    );
    const retired: StatsTriggerHandler[] = [];
    const retireAfter = (change: (trigger: HTMLButtonElement) => void) => {
      const stale = captureStatsTrigger();
      retired.push(stale.click);
      change(stale.element);
      fireEvent.click(stale.element);
      expect(screen.queryByTestId("stats-popover")).toBeNull();
      expect(captureStatsTrigger().click).not.toBe(stale.click);
    };

    try {
      retireAfter((trigger) => {
        trigger.setAttribute("data-integrity-probe", "changed");
        trigger.removeAttribute("data-integrity-probe");
      });
      retireAfter(() => {
        const next = mounted.host.nextSibling;
        mounted.host.remove();
        document.body.insertBefore(mounted.host, next);
      });
      retireAfter((trigger) => {
        const replacement =
          trigger.cloneNode(true) as HTMLButtonElement;
        trigger.replaceWith(replacement);
        replacement.replaceWith(trigger);
      });
      retireAfter(() => {
        const sibling = document.createElement("span");
        document.body.insertBefore(sibling, mounted.host);
        sibling.remove();
      });

      const current = captureStatsTrigger();
      dispatchStatsClick(current, [
        ...retired,
        current.click,
        current.click,
      ]);
      expect(screen.getByTestId("stats-popover")).toBeVisible();
    } finally {
      act(() => mounted.root.unmount());
      mounted.host.remove();
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

  it("keeps one current owner-window shortcut through direct-root replay and replacement", () => {
    const previous = makeSession("stats-previous");
    const current = makeSession("stats-current");
    const listeners = trackWindowKeydownListeners();
    let replayListener: WindowKeyListener | null = null;
    const mounted = renderStrictStats(previous, () => {
      replayListener ??= [...listeners.active][0] ?? null;
    });

    try {
      if (!replayListener) {
        throw new Error("Strict Mode did not expose its first listener");
      }
      expect(listeners.active.size).toBe(1);
      expect([...listeners.active][0]).not.toBe(replayListener);

      const staleEvent = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyC",
        ctrlKey: true,
        shiftKey: true,
      });
      const stalePreventDefault = vi.spyOn(
        staleEvent,
        "preventDefault",
      );
      invokeWindowListener(replayListener, staleEvent);
      expect(stalePreventDefault).not.toHaveBeenCalled();
      expect(screen.queryByTestId("stats-popover")).toBeNull();

      const windowEvent = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyC",
        ctrlKey: true,
        shiftKey: true,
      });
      const windowPreventDefault = vi.spyOn(
        windowEvent,
        "preventDefault",
      );
      act(() => window.dispatchEvent(windowEvent));
      expect(windowPreventDefault).not.toHaveBeenCalled();
      expect(screen.queryByTestId("stats-popover")).toBeNull();

      const currentEvent = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyC",
        ctrlKey: true,
        shiftKey: true,
      });
      const currentPreventDefault = vi.spyOn(
        currentEvent,
        "preventDefault",
      );
      act(() => document.body.dispatchEvent(currentEvent));
      expect(currentPreventDefault).toHaveBeenCalledOnce();
      expect(screen.getByTestId("stats-popover")).toBeVisible();
      expect(listeners.active.size).toBe(1);
      const currentListener = [...listeners.active][0]!;
      invokeWindowListener(currentListener, currentEvent);
      invokeWindowListener(currentListener, currentEvent);
      expect(currentPreventDefault).toHaveBeenCalledOnce();
      expect(screen.getByTestId("stats-popover")).toBeVisible();

      act(() =>
        mounted.root.render(
          <StatsBoundary session={current} source="One two three four five." />,
        ),
      );
      expect(screen.queryByTestId("stats-popover")).toBeNull();
      expect(listeners.active.size).toBe(1);
      invokeWindowListener(replayListener, staleEvent);
      expect(stalePreventDefault).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("stats-button"));
      expect(screen.getByTestId("stats-popover")).toBeVisible();
      expect(screen.getByTestId("word-count")).toHaveTextContent(
        "5 words",
      );
    } finally {
      act(() => mounted.root.unmount());
      mounted.host.remove();
    }
  });

  it("accepts one genuine Escape dismissal after direct-root Strict Mode replay", async () => {
    vi.useFakeTimers();
    const mounted = renderStrictStats(makeSession("strict-escape"), () => {});
    try {
      openPopover();
      expect(document.activeElement).toBe(
        screen.getByTestId("goal-mode"),
      );
      const trigger = screen.getByTestId(
        "stats-button",
      ) as HTMLButtonElement;
      const focusTrigger = vi.spyOn(trigger, "focus");
      const currentCallbacks = capturedStatsContentCallbacks.at(-1)!;
      const staleCallbacks = [...capturedStatsContentCallbacks]
        .reverse()
        .find(
          ({ escape }) => escape !== currentCallbacks.escape,
        )!;
      const currentOpenChange = capturedPopoverOpenChanges.at(-1)!;
      const staleOpenChange = [...capturedPopoverOpenChanges]
        .reverse()
        .find((openChange) => openChange !== currentOpenChange)!;
      const closeCount = publishedPopoverOpenChanges.filter(
        ({ open }) => !open,
      ).length;
      const escape = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Escape",
        key: "Escape",
      });
      act(() =>
        screen.getByTestId("stats-popover").dispatchEvent(escape),
      );
      await act(
        () => vi.advanceTimersByTimeAsync(0),
      );

      expect(screen.queryByTestId("stats-popover")).toBeNull();
      expect(
        publishedPopoverOpenChanges.filter(({ open }) => !open),
      ).toHaveLength(closeCount + 1);
      expect(focusTrigger).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(trigger);

      staleCallbacks.escape?.(escape);
      currentCallbacks.escape?.(escape);
      currentCallbacks.escape?.(escape);
      staleOpenChange(true);
      currentOpenChange(true);
      currentOpenChange(true);
      expect(screen.queryByTestId("stats-popover")).toBeNull();
      expect(focusTrigger).toHaveBeenCalledOnce();
    } finally {
      act(() => mounted.root.unmount());
      vi.clearAllTimers();
      vi.useRealTimers();
      mounted.host.remove();
    }
  });

  it.each([
    "source",
    "statistics",
    "selection",
    "goal",
    "editability",
    "mode",
    "callbacks",
  ] as const)(
    "retires delayed Escape focus when %s changes before autofocus",
    async (change) => {
      vi.useFakeTimers();
      const session = makeSession(`strict-close-${change}`);
      const mounted = renderStrictStats(session, () => {});
      let source = "One two three.";
      let selection: SourceSelection = null;
      let mount: "initial" | "replacement" = "initial";
      const renderCurrent = () =>
        mounted.root.render(
          <StrictMode>
            <StatsBoundary
              session={session}
              source={source}
              selection={selection}
              mount={mount}
            />
          </StrictMode>,
        );

      try {
        openPopover();
        const closingContent = screen.getByTestId(
          "stats-popover",
        ) as HTMLDivElement;
        const closingTrigger = screen.getByTestId(
          "stats-button",
        ) as HTMLButtonElement;
        const focusClosingTrigger = vi.spyOn(
          closingTrigger,
          "focus",
        );
        const staleOpenChange = capturedPopoverOpenChanges.at(-1)!;

        fireEvent.keyDown(closingContent, {
          bubbles: true,
          cancelable: true,
          code: "Escape",
          key: "Escape",
        });
        const staleCloseAutoFocus =
          capturedStatsContentCallbacks.at(-1)?.closeAutoFocus;
        expect(staleCloseAutoFocus).toBeTypeOf("function");
        expect(screen.queryByTestId("stats-popover")).toBeNull();
        expect(focusClosingTrigger).not.toHaveBeenCalled();

        act(() => {
          if (change === "source") {
            source = "One two three!";
          } else if (change === "statistics") {
            source = "One two three four.";
          } else if (change === "selection") {
            selection = { from: 0, to: 3 };
          } else if (change === "goal") {
            setGoal(session, goal("words", "min", 250));
          } else if (change === "editability") {
            Object.defineProperty(session, "canEdit", {
              configurable: true,
              value: false,
            });
          } else if (change === "mode") {
            session.setMode("suggesting");
          } else {
            mount = "replacement";
          }
          renderCurrent();
        });

        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(focusClosingTrigger).not.toHaveBeenCalled();
        expect(screen.queryByTestId("stats-popover")).toBeNull();

        const staleFocusEvent = new Event(
          "stats-close-autofocus",
          {
            bubbles: false,
            cancelable: true,
          },
        );
        closingContent.addEventListener(
          staleFocusEvent.type,
          (event) => staleCloseAutoFocus?.(event),
          { once: true },
        );
        closingContent.dispatchEvent(staleFocusEvent);
        staleOpenChange(true);
        expect(staleFocusEvent.defaultPrevented).toBe(false);
        expect(focusClosingTrigger).not.toHaveBeenCalled();
        expect(screen.queryByTestId("stats-popover")).toBeNull();

        const currentTrigger = screen.getByTestId(
          "stats-button",
        );
        if (change === "callbacks") {
          expect(currentTrigger).not.toBe(closingTrigger);
        }
        fireEvent.click(currentTrigger);
        expect(screen.getByTestId("stats-popover")).toBeVisible();
        if (change === "statistics") {
          expect(screen.getByTestId("word-count")).toHaveTextContent(
            "4 words",
          );
        } else if (change === "selection") {
          expect(screen.getByTestId("selection-count")).toHaveTextContent(
            "1 of 3 selected",
          );
        } else if (change === "goal") {
          expect(getGoal(session)).toEqual(
            goal("words", "min", 250),
          );
        } else if (change === "editability") {
          expect(screen.queryByTestId("goal-set")).toBeNull();
        } else if (change === "mode") {
          expect(session.mode).toBe("suggesting");
        }
      } finally {
        act(() => mounted.root.unmount());
        vi.clearAllTimers();
        vi.useRealTimers();
        mounted.host.remove();
      }
    },
  );

  it.each([
    "source",
    "statistics",
    "selection",
    "goal",
    "editability",
    "mode",
    "callbacks",
  ] as const)(
    "suppresses delayed Escape focus when %s changes in the closing batch",
    async (change) => {
      vi.useFakeTimers();
      const session = makeSession(`strict-close-batched-${change}`);
      const mounted = renderStrictStats(session, () => {});
      let source = "One two three.";
      let selection: SourceSelection = null;
      let mount: "initial" | "replacement" = "initial";
      const renderCurrent = () =>
        mounted.root.render(
          <StrictMode>
            <StatsBoundary
              session={session}
              source={source}
              selection={selection}
              mount={mount}
            />
          </StrictMode>,
        );

      try {
        openPopover();
        const closingContent = screen.getByTestId(
          "stats-popover",
        ) as HTMLDivElement;
        const closingTrigger = screen.getByTestId(
          "stats-button",
        ) as HTMLButtonElement;
        const focusClosingTrigger = vi.spyOn(
          closingTrigger,
          "focus",
        );
        const escape = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "Escape",
          key: "Escape",
        });

        act(() => {
          closingContent.dispatchEvent(escape);
          if (change === "source") {
            source = "One two three!";
          } else if (change === "statistics") {
            source = "One two three four.";
          } else if (change === "selection") {
            selection = { from: 0, to: 3 };
          } else if (change === "goal") {
            setGoal(session, goal("words", "min", 250));
          } else if (change === "editability") {
            Object.defineProperty(session, "canEdit", {
              configurable: true,
              value: false,
            });
          } else if (change === "mode") {
            session.setMode("suggesting");
          } else {
            mount = "replacement";
          }
          renderCurrent();
        });
        expect(screen.queryByTestId("stats-popover")).toBeNull();
        expect(focusClosingTrigger).not.toHaveBeenCalled();

        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(focusClosingTrigger).not.toHaveBeenCalled();
        expect(screen.queryByTestId("stats-popover")).toBeNull();

        const currentTrigger = screen.getByTestId(
          "stats-button",
        );
        if (change === "callbacks") {
          expect(currentTrigger).not.toBe(closingTrigger);
        }
        fireEvent.click(currentTrigger);
        expect(screen.getByTestId("stats-popover")).toBeVisible();
        if (change === "statistics") {
          expect(screen.getByTestId("word-count")).toHaveTextContent(
            "4 words",
          );
        } else if (change === "selection") {
          expect(screen.getByTestId("selection-count")).toHaveTextContent(
            "1 of 3 selected",
          );
        } else if (change === "goal") {
          expect(getGoal(session)).toEqual(
            goal("words", "min", 250),
          );
        } else if (change === "editability") {
          expect(screen.queryByTestId("goal-set")).toBeNull();
        } else if (change === "mode") {
          expect(session.mode).toBe("suggesting");
        }
      } finally {
        act(() => mounted.root.unmount());
        vi.clearAllTimers();
        vi.useRealTimers();
        mounted.host.remove();
      }
    },
  );

  it.each(["drifted", "equivalent"] as const)(
    "keeps a fresh close intent after claiming an older %s autofocus callback",
    async (change) => {
      vi.useFakeTimers();
      const session = makeSession(
        `strict-close-independent-${change}`,
      );
      const mounted = renderStrictStats(session, () => {});
      let source = "One two three.";
      const renderCurrent = () =>
        mounted.root.render(
          <StrictMode>
            <StatsBoundary session={session} source={source} />
          </StrictMode>,
        );

      try {
        openPopover();
        const firstContent = screen.getByTestId(
          "stats-popover",
        ) as HTMLDivElement;
        const trigger = screen.getByTestId(
          "stats-button",
        ) as HTMLButtonElement;
        const focusTrigger = vi.spyOn(trigger, "focus");
        const callbackCount = capturedStatsContentCallbacks.length;

        const escape = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "Escape",
          key: "Escape",
        });
        if (change === "drifted") {
          act(() => {
            firstContent.dispatchEvent(escape);
            source = "One two three!";
            renderCurrent();
          });
        } else {
          act(() => firstContent.dispatchEvent(escape));
        }
        const firstCloseAutoFocus =
          capturedStatsContentCallbacks
            .slice(callbackCount)
            .find(({ closeAutoFocus }) => closeAutoFocus)
            ?.closeAutoFocus;
        expect(firstCloseAutoFocus).toBeTypeOf("function");
        if (change === "equivalent") {
          act(() => renderCurrent());
        }
        vi.clearAllTimers();

        fireEvent.click(trigger);
        const secondContent = screen.getByTestId(
          "stats-popover",
        ) as HTMLDivElement;
        fireEvent.keyDown(secondContent, {
          bubbles: true,
          cancelable: true,
          code: "Escape",
          key: "Escape",
        });
        expect(screen.queryByTestId("stats-popover")).toBeNull();

        const firstFocusEvent = new Event(
          "stats-close-autofocus",
          {
            bubbles: false,
            cancelable: true,
          },
        );
        firstContent.addEventListener(
          firstFocusEvent.type,
          (event) => firstCloseAutoFocus?.(event),
          { once: true },
        );
        firstContent.dispatchEvent(firstFocusEvent);
        expect(firstFocusEvent.defaultPrevented).toBe(true);
        expect(focusTrigger).not.toHaveBeenCalled();

        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(focusTrigger).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(trigger);
      } finally {
        act(() => mounted.root.unmount());
        vi.clearAllTimers();
        vi.useRealTimers();
        mounted.host.remove();
      }
    },
  );

  it.each([
    "attribute mutation/restore",
    "ancestor detach/reinsert",
    "replacement/restore",
    "reorder/restore",
  ] as const)("keeps a restored portal %s retired without poisoning its exact successor", (change) => {
    const mounted = renderStrictStats(
      makeSession(`strict-portal-${change}`),
      () => {},
    );
    try {
      openPopover();
      const content = screen.getByTestId("stats-popover") as HTMLDivElement;
      const previousCallbacks = capturedStatsContentCallbacks.at(-1);
      if (change === "attribute mutation/restore") {
        content.setAttribute("data-integrity-probe", "changed");
        content.removeAttribute("data-integrity-probe");
      } else if (change === "ancestor detach/reinsert") {
        const wrapper = content.parentElement!;
        const next = wrapper.nextSibling;
        wrapper.remove();
        document.body.insertBefore(wrapper, next);
      } else if (change === "replacement/restore") {
        const child = content.firstElementChild!;
        const replacement = child.cloneNode(true) as Element;
        child.replaceWith(replacement);
        replacement.replaceWith(child);
      } else {
        const first = content.children.item(0)!;
        const second = content.children.item(1)!;
        content.insertBefore(second, first);
        content.insertBefore(first, second);
      }

      fireEvent.keyDown(content, {
        bubbles: true,
        cancelable: true,
        code: "Escape",
        key: "Escape",
      });
      expect(screen.getByTestId("stats-popover")).toBeVisible();
      expect(capturedStatsContentCallbacks.at(-1)).not.toBe(
        previousCallbacks,
      );

      fireEvent.keyDown(screen.getByTestId("stats-popover"), {
        bubbles: true,
        cancelable: true,
        code: "Escape",
        key: "Escape",
      });
      expect(screen.queryByTestId("stats-popover")).toBeNull();
    } finally {
      act(() => mounted.root.unmount());
      mounted.host.remove();
    }
  });

  it("accepts one genuine pointer-outside dismissal after direct-root Strict Mode replay", async () => {
    vi.useFakeTimers();
    const outside = document.createElement("button");
    document.body.append(outside);
    const mounted = renderStrictStats(
      makeSession("strict-pointer-outside"),
      () => {},
    );
    try {
      openPopover();
      const currentCallbacks = capturedStatsContentCallbacks.at(-1)!;
      const staleCallbacks = [...capturedStatsContentCallbacks]
        .reverse()
        .find(
          ({ pointerOutside }) =>
            pointerOutside !== currentCallbacks.pointerOutside,
        )!;
      const currentOpenChange = capturedPopoverOpenChanges.at(-1)!;
      const staleOpenChange = [...capturedPopoverOpenChanges]
        .reverse()
        .find((openChange) => openChange !== currentOpenChange)!;
      const focusTrigger = vi.spyOn(
        screen.getByTestId("stats-button"),
        "focus",
      );
      expect(currentCallbacks.pointerOutside).not.toBe(
        staleCallbacks.pointerOutside,
      );

      dispatchStatsOutside(
        "pointer",
        outside,
        [staleCallbacks, currentCallbacks, currentCallbacks],
        [staleOpenChange, currentOpenChange, currentOpenChange],
      );
      await act(
        () => vi.advanceTimersByTimeAsync(0),
      );

      expect(screen.queryByTestId("stats-popover")).toBeNull();
      expect(document.activeElement).not.toBe(
        screen.getByTestId("stats-button"),
      );
      expect(focusTrigger).not.toHaveBeenCalled();
    } finally {
      act(() => mounted.root.unmount());
      vi.clearAllTimers();
      vi.useRealTimers();
      mounted.host.remove();
      outside.remove();
    }
  });

  it("accepts one genuine focus-outside dismissal after direct-root Strict Mode replay", async () => {
    vi.useFakeTimers();
    const outside = document.createElement("button");
    document.body.append(outside);
    const mounted = renderStrictStats(
      makeSession("strict-focus-outside"),
      () => {},
    );
    try {
      openPopover();
      const currentCallbacks = capturedStatsContentCallbacks.at(-1)!;
      const staleCallbacks = [...capturedStatsContentCallbacks]
        .reverse()
        .find(
          ({ focusOutside }) =>
            focusOutside !== currentCallbacks.focusOutside,
        )!;
      const currentOpenChange = capturedPopoverOpenChanges.at(-1)!;
      const staleOpenChange = [...capturedPopoverOpenChanges]
        .reverse()
        .find((openChange) => openChange !== currentOpenChange)!;
      const focusTrigger = vi.spyOn(
        screen.getByTestId("stats-button"),
        "focus",
      );
      expect(currentCallbacks.focusOutside).not.toBe(
        staleCallbacks.focusOutside,
      );

      dispatchStatsOutside(
        "focus",
        outside,
        [staleCallbacks, currentCallbacks, currentCallbacks],
        [staleOpenChange, currentOpenChange, currentOpenChange],
      );
      await act(
        () => vi.advanceTimersByTimeAsync(0),
      );

      expect(screen.queryByTestId("stats-popover")).toBeNull();
      expect(document.activeElement).not.toBe(
        screen.getByTestId("stats-button"),
      );
      expect(focusTrigger).not.toHaveBeenCalled();
    } finally {
      act(() => mounted.root.unmount());
      vi.clearAllTimers();
      vi.useRealTimers();
      mounted.host.remove();
      outside.remove();
    }
  });

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

      const staleKey = [...listeners.active][0]!;
      const staleOpenChange = capturedPopoverOpenChanges.at(-1)!;
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
              expect(listeners.removed).toContain(staleKey);
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

    fireEvent.input(screen.getByTestId("goal-value"), { target: { value: "999" } });
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

    fireEvent.input(screen.getByTestId("goal-value"), { target: { value: "44" } });
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
    fireEvent.input(screen.getByTestId("goal-value"), { target: { value: "333" } });
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
        directChange(stale.changeMode, foreignMode);
        directChange(stale.changeMode, detachedMode);
        directChange(stale.changeValue, foreignValue);
        directChange(stale.changeValue, detachedValue);
        directChange(stale.changeKind, foreignKind);
        directChange(stale.changeKind, detachedKind);
      });
      expectDraft("words", "min", "100");

      const replacement = stale.value.cloneNode(true) as HTMLInputElement;
      replacement.value = "999";
      stale.value.replaceWith(replacement);
      stale.valueRef(null);
      act(() => {
        directChange(stale.changeValue, stale.value);
        directChange(stale.changeValue, replacement);
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
        directChange(stale.changeMode, current.mode);
        directChange(current.changeMode, current.mode);
        directChange(current.changeMode, current.mode);
      });
      expectDraft("words", "max", "100");

      const afterMode = captureGoalActions();
      afterMode.value.value = "321";
      act(() => directChange(afterMode.changeValue, afterMode.value));
      const afterValue = captureGoalActions();
      afterValue.kind.value = "minutes";
      act(() => directChange(afterValue.changeKind, afterValue.kind));
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

  it("requires owner-window native draft events and exact wrapper and option facts without poisoning the control", () => {
    const session = makeSession("draft-native", "owner", goal("words", "min", 100));
    const rendered = render(view(session));
    openPopover();
    const current = captureGoalActions();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignWindow = frame.contentWindow as typeof window | null;
    if (!foreignWindow) throw new Error("The foreign document has no window");
    current.mode.value = "max";
    const fabricated = {
      type: "change",
      target: current.mode,
      defaultPrevented: false,
    } as unknown as Event;
    const wrongType = new Event("click", { bubbles: true });
    Object.defineProperty(wrongType, "target", { configurable: true, value: current.mode });
    const foreignEvent = new foreignWindow.Event("change", { bubbles: true });
    Object.defineProperty(foreignEvent, "target", { configurable: true, value: current.mode });
    const mismatchedTarget = makeChangeEvent(current.mode);
    const exactEvent = makeChangeEvent(current.mode);
    const minOption = current.mode.options.item(0);
    if (!minOption) throw new Error("The minimum mode option was not rendered");

    try {
      act(() => {
        directChange(current.changeMode, current.mode, { nativeEvent: fabricated });
        directChange(current.changeMode, current.mode, { nativeEvent: wrongType });
        directChange(current.changeMode, current.mode, { nativeEvent: foreignEvent });
        directChange(current.changeMode, current.mode, {
          target: current.value,
          nativeEvent: mismatchedTarget,
        });
        minOption.textContent = "Changed";
        directChange(current.changeMode, current.mode, { nativeEvent: exactEvent });
        minOption.textContent = "At least";
      });
      rendered.rerender(view(session, "One two three four."));
      expectDraft("words", "min", "100");

      const usable = captureGoalActions();
      usable.mode.value = "max";
      act(() => directChange(usable.changeMode, usable.mode));
      expectDraft("words", "max", "100");

      const valueAction = captureGoalActions();
      valueAction.value.value = "222";
      act(() =>
        directChange(valueAction.changeValue, valueAction.value, {
          nativeEvent: makeChangeEvent(valueAction.value, "change"),
        }),
      );
      rendered.rerender(view(session, "One two three four five."));
      expectDraft("words", "max", "100");

      const usableValue = captureGoalActions();
      usableValue.value.value = "222";
      act(() => directChange(usableValue.changeValue, usableValue.value));
      expectDraft("words", "max", "222");
      expect(getGoal(session)).toEqual(goal("words", "min", 100));
    } finally {
      frame.remove();
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

      fireEvent.input(disabled.value, { target: { value: "4.6" } });
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

  it("requires the form owner's native SubmitEvent and exact hierarchy without poisoning Set", () => {
    const session = makeSession("set-native");
    let writes = 0;
    session.meta.observe(() => writes++);
    render(view(session));
    openPopover();
    fireEvent.input(screen.getByTestId("goal-value"), { target: { value: "12" } });
    const current = captureGoalActions();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignWindow = frame.contentWindow as typeof window | null;
    if (!foreignWindow) throw new Error("The foreign document has no window");
    const fabricated = {
      type: "submit",
      target: current.form,
      submitter: current.set,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
    } as unknown as SubmitEvent;
    const genericEvent = new Event("submit", { bubbles: true, cancelable: true });
    Object.defineProperty(genericEvent, "target", { configurable: true, value: current.form });
    const foreignEvent = new foreignWindow.SubmitEvent("submit", {
      bubbles: true,
      cancelable: true,
      submitter: current.set,
    });
    Object.defineProperty(foreignEvent, "target", { configurable: true, value: current.form });
    const mismatchedWrapper = makeSubmitEvent(current.form, current.set);
    const reordered = makeSubmitEvent(current.form, current.set);

    try {
      const rejected = [
        directSubmit(current, { nativeEvent: fabricated }),
        directSubmit(current, { nativeEvent: genericEvent as SubmitEvent }),
        directSubmit(current, { nativeEvent: foreignEvent }),
        directSubmit(current, { target: current.mode, nativeEvent: mismatchedWrapper }),
      ];
      current.form.insertBefore(current.kind, current.value);
      rejected.push(directSubmit(current, { nativeEvent: reordered }));
      current.form.insertBefore(current.value, current.kind);
      expect(rejected.map(({ preventDefault }) => preventDefault.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
      expect(writes).toBe(0);
      expect(getGoal(session)).toBeNull();

      const exactEvent = makeSubmitEvent(current.form, current.set);
      const accepted = directSubmit(current, { nativeEvent: exactEvent });
      expect(accepted.preventDefault).toHaveBeenCalledOnce();
      expect(writes).toBe(1);
      expect(getGoal(session)).toMatchObject({ kind: "words", mode: "min", value: 12 });
    } finally {
      frame.remove();
    }
  });

  it("sets the frozen current draft once after wrong submitters and repeated competing submissions", async () => {
    const session = makeSession("set-once");
    let writes = 0;
    session.meta.observe(() => writes++);
    render(view(session));
    openPopover();
    fireEvent.change(screen.getByTestId("goal-mode"), { target: { value: "max" } });
    fireEvent.input(screen.getByTestId("goal-value"), { target: { value: "4.6" } });
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
      if (currentFirst) directClear(current);
      directClear(stale);
      directClear(stale, { currentTarget: current.clear, target: current.clear });
      if (!currentFirst) directClear(current);
      directClear(current);
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
    const staleClearEvent = makeClickEvent(stale.clear);
    const now = vi.spyOn(Date, "now").mockReturnValue(987_654);

    setGoal(session, goal("minutes", "max", 8, "carol"));
    const submitAttempt = directSubmit(stale, { nativeEvent: staleSubmitEvent });
    directClear(stale, { nativeEvent: staleClearEvent });

    expect(writes).toBe(1);
    expect(submitAttempt.preventDefault).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(getGoal(session)).toEqual(goal("minutes", "max", 8, "carol"));

    await act(async () => {
      await Promise.resolve();
    });
    const current = captureGoalActions();
    if (!current.clear || !current.clearGoal) throw new Error("Current Clear was not rendered");
    act(() => directClear(current));
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
    act(() => directClear(stale));
    expect(writes).toBe(0);
    expect(getGoal(session)).toMatchObject({ value: 50 });

    await act(async () => {
      session.setMode("editing");
      await Promise.resolve();
    });
    const current = captureGoalActions();
    if (!current.clear || !current.clearGoal) throw new Error("Current Clear was not rendered");
    act(() => {
      directClear(stale, { currentTarget: current.clear, target: current.clear });
      directClear(current);
      directClear(current);
    });
    expect(writes).toBe(1);
    expect(getGoal(session)).toBeNull();
  });

  it("requires an owner-window click target inside the enabled exact Clear button without poisoning it", () => {
    const expectedGoal = goal("words", "min", 50);
    const session = makeSession("clear-native", "owner", expectedGoal);
    let writes = 0;
    session.meta.observe(() => writes++);
    render(view(session));
    openPopover();
    const current = captureGoalActions();
    if (!current.clear) throw new Error("Clear control was not rendered");
    const frame = document.createElement("iframe");
    const sibling = document.createElement("span");
    document.body.append(frame, sibling);
    const foreignWindow = frame.contentWindow as typeof window | null;
    if (!foreignWindow) throw new Error("The foreign document has no window");
    const fabricated = {
      type: "click",
      target: current.clear,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
    } as unknown as MouseEvent;
    const genericEvent = new Event("click", { bubbles: true, cancelable: true }) as MouseEvent;
    Object.defineProperty(genericEvent, "target", { configurable: true, value: current.clear });
    const foreignEvent = new foreignWindow.MouseEvent("click", { bubbles: true, cancelable: true });
    Object.defineProperty(foreignEvent, "target", { configurable: true, value: current.clear });

    try {
      act(() => {
        directClear(current, { nativeEvent: fabricated });
        directClear(current, { nativeEvent: genericEvent });
        directClear(current, { target: sibling, nativeEvent: makeClickEvent(sibling) });
        directClear(current, { nativeEvent: foreignEvent });
        current.clear!.disabled = true;
        directClear(current);
        current.clear!.disabled = false;
        current.clear!.parentElement!.insertBefore(current.clear!, current.set);
        directClear(current);
        current.clear!.parentElement!.append(current.clear!);
      });
      expect(writes).toBe(0);
      expect(getGoal(session)).toEqual(expectedGoal);

      const text = current.clear.firstChild;
      if (!text) throw new Error("Clear button text was not rendered");
      act(() => directClear(current, { target: text, nativeEvent: makeClickEvent(text) }));
      expect(writes).toBe(1);
      expect(getGoal(session)).toBeNull();
    } finally {
      frame.remove();
      sibling.remove();
    }
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
    fireEvent.input(screen.getByTestId("goal-value"), { target: { value: "4.6" } });
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

  it.each([
    [
      "mode",
      (stale: GoalActions, current: GoalActions) => {
        current.mode.value = "max";
        const nativeEvent = makeChangeEvent(current.mode);
        directChange(stale.changeMode, current.mode, { nativeEvent });
        fireEvent(current.mode, nativeEvent);
        fireEvent(current.mode, nativeEvent);
      },
      ["words", "max", "100"],
    ],
    [
      "value",
      (stale: GoalActions, current: GoalActions) => {
        current.value.value = "321";
        const nativeEvent = makeChangeEvent(current.value, "input");
        directChange(stale.changeValue, current.value, { nativeEvent });
        fireEvent(current.value, nativeEvent);
        fireEvent(current.value, nativeEvent);
      },
      ["words", "min", "321"],
    ],
    [
      "kind",
      (stale: GoalActions, current: GoalActions) => {
        current.kind.value = "minutes";
        const nativeEvent = makeChangeEvent(current.kind);
        directChange(stale.changeKind, current.kind, { nativeEvent });
        fireEvent(current.kind, nativeEvent);
        fireEvent(current.kind, nativeEvent);
      },
      ["minutes", "min", "100"],
    ],
  ] as const)(
    "keeps the current Strict Mode %s control usable after replay and rejects its stale handler",
    (_label, interact, expected) => {
      const session = makeSession(`strict-${_label}`, "owner", goal("words", "min", 100));
      let writes = 0;
      session.meta.observe(() => writes++);
      const mounted = mountStrictGoal(session);
      try {
        const stale = captureGoalActions();
        mounted.rerender("One two three four.");
        const current = captureGoalActions();
        expect(current.mode).toBe(stale.mode);
        expect(current.value).toBe(stale.value);
        expect(current.kind).toBe(stale.kind);

        act(() => interact(stale, current));

        expectDraft(expected[0], expected[1], expected[2]);
        expect(writes).toBe(0);
        expect(getGoal(session)).toEqual(goal("words", "min", 100));
      } finally {
        act(() => mounted.root.unmount());
        mounted.host.remove();
      }
    },
  );

  it.each([
    ["button", (action: GoalActions) => action.set],
    ["keyboard", () => null],
  ] as const)(
    "writes once from the current Strict Mode Set by %s after replay and rejects stale authority",
    async (_label, submitter) => {
      const session = makeSession(`strict-set-${_label}`);
      let writes = 0;
      let reenter: (() => void) | null = null;
      session.meta.observe(() => {
        writes++;
        reenter?.();
      });
      const mounted = mountStrictGoal(session);
      try {
        fireEvent.change(screen.getByTestId("goal-mode"), { target: { value: "max" } });
        fireEvent.input(screen.getByTestId("goal-value"), { target: { value: "4.6" } });
        fireEvent.change(screen.getByTestId("goal-kind"), { target: { value: "minutes" } });
        const stale = captureGoalActions();
        mounted.rerender("One two three four five.");
        const current = captureGoalActions();
        const nativeEvent = makeSubmitEvent(current.form, submitter(current));

        const rejected = directSubmit(stale, {
          currentTarget: current.form,
          target: current.form,
          nativeEvent,
        });
        expect(rejected.preventDefault).not.toHaveBeenCalled();
        expect(nativeEvent.defaultPrevented).toBe(false);
        expect(writes).toBe(0);

        act(() => {
          reenter = () => directSubmit(current, { nativeEvent });
          fireEvent(current.form, nativeEvent);
          fireEvent(current.form, nativeEvent);
          reenter = null;
        });
        expect(nativeEvent.defaultPrevented).toBe(true);
        expect(writes).toBe(1);
        await waitFor(() => {
          expect(getGoal(session)).toMatchObject({
            kind: "minutes",
            mode: "max",
            value: 5,
            setBy: "alice",
          });
        });
      } finally {
        act(() => mounted.root.unmount());
        mounted.host.remove();
      }
    },
  );

  it("clears once from the current Strict Mode button after replay and rejects the stale handler", () => {
    const expectedGoal = goal("words", "min", 100);
    const session = makeSession("strict-clear", "owner", expectedGoal);
    let writes = 0;
    let reenter: (() => void) | null = null;
    session.meta.observe(() => {
      writes++;
      reenter?.();
    });
    const mounted = mountStrictGoal(session);
    try {
      const stale = captureGoalActions();
      mounted.rerender("One two three four five six.", true);
      expect(screen.queryByTestId("stats-popover")).toBeNull();
      openPopover();
      const current = captureGoalActions();
      if (!current.clear) throw new Error("Current Clear control was not rendered");
      const nativeEvent = makeClickEvent(current.clear);

      act(() => {
        directClear(stale, {
          currentTarget: current.clear,
          target: current.clear,
          nativeEvent,
        });
      });
      expect(writes).toBe(0);
      expect(getGoal(session)).toEqual(expectedGoal);

      act(() => {
        reenter = () => directClear(current, { nativeEvent });
        fireEvent(current.clear!, nativeEvent);
        fireEvent(current.clear!, nativeEvent);
        reenter = null;
      });
      expect(writes).toBe(1);
      expect(getGoal(session)).toBeNull();
    } finally {
      act(() => mounted.root.unmount());
      mounted.host.remove();
    }
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
