// @vitest-environment jsdom
import { StrictMode, useEffect, useLayoutEffect, type ComponentProps, type RefCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as Y from "yjs";

type PopoverOpenChange = (open: boolean) => void;
interface StatsContentCallbacks {
  escape?: (event: KeyboardEvent) => void;
  openAutoFocus?: (event: Event) => void;
  closeAutoFocus?: (event: Event) => void;
  pointerOutside?: (
    event: CustomEvent<{ originalEvent: PointerEvent }>,
  ) => void;
  focusOutside?: (
    event: CustomEvent<{ originalEvent: FocusEvent }>,
  ) => void;
}

class StatsPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

const capturedPopoverOpenChanges = vi.hoisted(() => [] as PopoverOpenChange[]);
const capturedStatsContentCallbacks = vi.hoisted(
  () => [] as StatsContentCallbacks[],
);
const publishedPopoverOpenChanges = vi.hoisted(
  () => [] as { callback: PopoverOpenChange; open: boolean }[],
);
const deliveredStatsCloseAutoFocusEvents = vi.hoisted(
  () => [] as Event[],
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
        openAutoFocus: props.onOpenAutoFocus,
        closeAutoFocus: props.onCloseAutoFocus,
        pointerOutside: props.onPointerDownOutside,
        focusOutside: props.onFocusOutside,
      });
      return (
        <ActualPopoverContent
          {...props}
          onCloseAutoFocus={
            props.onCloseAutoFocus
              ? (event) => {
                  deliveredStatsCloseAutoFocusEvents.push(event);
                  props.onCloseAutoFocus?.(event);
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
const manualRoots = new Set<Root>();

function createTrackedRoot(host: HTMLElement) {
  const root = createRoot(host);
  const unmount = root.unmount.bind(root);
  root.unmount = () => {
    if (!manualRoots.delete(root)) return;
    unmount();
  };
  manualRoots.add(root);
  return root;
}

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
  session.synced = true;
  vi.spyOn(session.binding, "hasHeldSync", "get").mockReturnValue(false);
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

  return { active, added, nativeAdd, nativeRemove, removed };
}

function invokeWindowListener(
  listener: WindowKeyListener,
  event: KeyboardEvent,
  receiver: EventTarget = window,
) {
  if (typeof listener === "function") {
    Reflect.apply(listener, receiver, [event]);
  }
  else listener.handleEvent(event);
}

function observeWindowListenerReceiver(
  ownerWindow: Window & typeof globalThis,
) {
  const receivers = new WeakMap<Event, Window>();
  let currentTarget: EventTarget | null = null;
  let terminal: EventTarget | null = null;
  const type = `stats-window-receiver-${Math.random()}`;
  const observe = function (this: Window, event: Event) {
    receivers.set(event, this);
    currentTarget = event.currentTarget;
    terminal = event.composedPath().at(-1) ?? null;
  };
  ownerWindow.addEventListener(type, observe, { once: true });
  const event = new ownerWindow.Event(type);
  ownerWindow.dispatchEvent(event);
  const receiver = receivers.get(event);
  if (!receiver) {
    throw new Error("Window listener receiver was unavailable");
  }
  expect(currentTarget).toBe(receiver);
  expect(terminal).toBe(receiver);
  return receiver;
}

function exposeExactWindowListenerReceiver(ownerDocument: Document) {
  const publicWindow = ownerDocument.defaultView;
  if (!publicWindow) {
    throw new Error("Document default view was unavailable");
  }
  const receiver = observeWindowListenerReceiver(publicWindow);
  const descriptor = Object.getOwnPropertyDescriptor(
    ownerDocument,
    "defaultView",
  );
  Object.defineProperty(ownerDocument, "defaultView", {
    configurable: true,
    value: receiver,
  });
  return {
    receiver,
    restore: () => {
      if (descriptor) {
        Object.defineProperty(ownerDocument, "defaultView", descriptor);
      } else {
        Reflect.deleteProperty(ownerDocument, "defaultView");
      }
    },
  };
}

function redirectWindowKeyCaptureReceiver(receiver: EventTarget) {
  const nativeAdd = window.addEventListener.bind(window);
  const nativeRemove = window.removeEventListener.bind(window);
  const wrappers = new Map<WindowKeyListener, EventListener>();
  const captures = (options?: boolean | AddEventListenerOptions) =>
    options === true ||
    (typeof options === "object" && options.capture === true);
  const add = vi.spyOn(window, "addEventListener").mockImplementation(
    (type, listener, options) => {
      if (
        type === "keydown" &&
        captures(options) &&
        typeof listener === "function"
      ) {
        const wrapper: EventListener = (event) =>
          Reflect.apply(listener, receiver, [event]);
        wrappers.set(listener, wrapper);
        nativeAdd(type, wrapper, options);
        return;
      }
      nativeAdd(type, listener, options);
    },
  );
  const remove = vi.spyOn(window, "removeEventListener").mockImplementation(
    (type, listener, options) => {
      const wrapper =
        type === "keydown" && captures(options)
          ? wrappers.get(listener)
          : undefined;
      nativeRemove(type, wrapper ?? listener, options);
      if (wrapper) wrappers.delete(listener);
    },
  );
  return () => {
    add.mockRestore();
    remove.mockRestore();
  };
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
type GoalKeyHandler<T extends HTMLElement> = (
  event: React.KeyboardEvent<T>,
) => void;

interface GoalActions {
  form: HTMLFormElement;
  actions: HTMLSpanElement;
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
  groupKeyDownCapture: GoalKeyHandler<HTMLSpanElement>;
  groupKeyDown: GoalKeyHandler<HTMLSpanElement>;
  setKeyDownCapture: GoalKeyHandler<HTMLButtonElement>;
  setKeyDown: GoalKeyHandler<HTMLButtonElement>;
  clearKeyDownCapture: GoalKeyHandler<HTMLButtonElement> | null;
  clearKeyDown: GoalKeyHandler<HTMLButtonElement> | null;
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
  const actions = set.parentElement;
  if (!(actions instanceof HTMLSpanElement)) {
    throw new Error("The writing-goal actions have no group");
  }
  return {
    form,
    actions,
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
    groupKeyDownCapture: reactProp(actions, "onKeyDownCapture"),
    groupKeyDown: reactProp(actions, "onKeyDown"),
    setKeyDownCapture: reactProp(set, "onKeyDownCapture"),
    setKeyDown: reactProp(set, "onKeyDown"),
    clearKeyDownCapture: clear
      ? reactProp(clear, "onKeyDownCapture")
      : null,
    clearKeyDown: clear ? reactProp(clear, "onKeyDown") : null,
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

function statsPointerEvent(
  type: "pointerdown" | "pointerup" | "click",
  init: PointerEventInit = {},
) {
  return new StatsPointerEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    composed: true,
    detail: type === "click" ? 1 : 0,
    isPrimary: type !== "click",
    pointerId: 7,
    pointerType: "mouse",
    ...init,
  });
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
type StatsTriggerKeyHandler = (
  event: React.KeyboardEvent<HTMLButtonElement>,
) => void;

interface CapturedStatsTrigger {
  element: HTMLButtonElement;
  click: StatsTriggerHandler;
  keyDownCapture: StatsTriggerKeyHandler;
  keyDown: StatsTriggerKeyHandler;
  ref: RefCallback<HTMLButtonElement>;
}

function captureStatsTrigger(): CapturedStatsTrigger {
  const element = screen.getByTestId(
    "stats-button",
  ) as HTMLButtonElement;
  return {
    element,
    click: reactProp(element, "onClick"),
    keyDownCapture: reactProp(element, "onKeyDownCapture"),
    keyDown: reactProp(element, "onKeyDown"),
    ref: reactProp(element, "ref"),
  };
}

function trustStatsKeyboardEvent(
  event: KeyboardEvent,
  ownerWindow: Window,
) {
  const implementationSymbol = Object.getOwnPropertySymbols(event).find(
    (symbol) => String(symbol) === "Symbol(impl)",
  );
  if (!implementationSymbol) {
    throw new Error("Keyboard event implementation slot was not available");
  }
  const implementation = (
    event as unknown as Record<symbol, { isTrusted: boolean }>
  )[implementationSymbol];
  const descriptor = Object.getOwnPropertyDescriptor(
    implementation,
    "isTrusted",
  );
  if (!descriptor?.writable) {
    throw new Error("Keyboard event trust slot was not writable");
  }
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  expect(event.isTrusted).toBe(true);
  expect(event.view).toBe(ownerWindow);
}

function statsKey(
  target: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) {
    throw new Error("Statistics trigger owner window was unavailable");
  }
  const implementationSymbol = Object.getOwnPropertySymbols(
    target.ownerDocument,
  ).find((symbol) => String(symbol) === "Symbol(impl)");
  if (!implementationSymbol) {
    throw new Error("Document implementation slot was not available");
  }
  const nativeOwnerWindow = (
    target.ownerDocument as unknown as Record<
      symbol,
      { _globalObject: Window }
    >
  )[implementationSymbol]._globalObject;
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    code: key,
    key,
    view: nativeOwnerWindow,
    ...init,
  });
  if (trusted) trustStatsKeyboardEvent(event, nativeOwnerWindow);
  return event;
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

function dispatchStatsKey(
  trigger: CapturedStatsTrigger,
  event: KeyboardEvent,
  captureHandlers: readonly StatsTriggerKeyHandler[],
  bubbleHandlers: readonly StatsTriggerKeyHandler[],
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
    onKeyDownCapture: (
      reactEvent: React.KeyboardEvent<HTMLButtonElement>,
    ) => {
      for (const handler of captureHandlers) handler(reactEvent);
    },
    onKeyDown: (
      reactEvent: React.KeyboardEvent<HTMLButtonElement>,
    ) => {
      for (const handler of bubbleHandlers) handler(reactEvent);
    },
  };
  properties[propsKey] = wrapped;
  try {
    trigger.element.dispatchEvent(event);
  } finally {
    if (properties[propsKey] === wrapped) {
      properties[propsKey] = props;
    }
  }
}

type GoalActionSource = "set" | "clear";

interface GoalActionKeyDispatch {
  captureWrapper: React.KeyboardEvent<HTMLSpanElement> | null;
  bubbleWrapper: React.KeyboardEvent<HTMLButtonElement> | null;
  publicPreventDefault: ReturnType<typeof vi.fn> | null;
}

function dispatchGoalActionKey(
  actions: GoalActions,
  sourceName: GoalActionSource,
  event: KeyboardEvent,
  {
    handlers = actions,
    beforeCapture,
    afterCapture,
    beforeActionBubble,
    afterActionBubble,
    beforeGroupBubble,
    duringPublicPreventDefault,
  }: {
    handlers?: GoalActions;
    beforeCapture?: (event: React.KeyboardEvent<HTMLSpanElement>) => void;
    afterCapture?: (event: React.KeyboardEvent<HTMLSpanElement>) => void;
    beforeActionBubble?: (
      event: React.KeyboardEvent<HTMLButtonElement>,
    ) => void;
    afterActionBubble?: (
      event: React.KeyboardEvent<HTMLButtonElement>,
    ) => void;
    beforeGroupBubble?: (
      event: React.KeyboardEvent<HTMLSpanElement>,
    ) => void;
    duringPublicPreventDefault?: () => void;
  } = {},
): GoalActionKeyDispatch {
  const source = sourceName === "set" ? actions.set : actions.clear;
  const sourceCapture =
    sourceName === "set"
      ? handlers.setKeyDownCapture
      : handlers.clearKeyDownCapture;
  const sourceBubble =
    sourceName === "set" ? handlers.setKeyDown : handlers.clearKeyDown;
  if (!source || !sourceCapture || !sourceBubble) {
    throw new Error(`${sourceName} action was not rendered`);
  }

  const groupPropsKey = Object.keys(actions.actions).find((key) =>
    key.startsWith("__reactProps$"),
  );
  const sourcePropsKey = Object.keys(source).find((key) =>
    key.startsWith("__reactProps$"),
  );
  if (!groupPropsKey || !sourcePropsKey) {
    throw new Error("React props were not attached to writing-goal actions");
  }
  const groupProperties = actions.actions as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const sourceProperties = source as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const groupProps = groupProperties[groupPropsKey];
  const sourceProps = sourceProperties[sourcePropsKey];
  if (!groupProps || !sourceProps) {
    throw new Error("React props were not attached to writing-goal actions");
  }

  let captureWrapper: React.KeyboardEvent<HTMLSpanElement> | null = null;
  let bubbleWrapper: React.KeyboardEvent<HTMLButtonElement> | null = null;
  let publicPreventDefault: ReturnType<typeof vi.fn> | null = null;
  const wrappedGroupProps = {
    ...groupProps,
    onKeyDownCapture: (reactEvent: React.KeyboardEvent<HTMLSpanElement>) => {
      captureWrapper = reactEvent;
      beforeCapture?.(reactEvent);
      handlers.groupKeyDownCapture(reactEvent);
      afterCapture?.(reactEvent);
    },
    onKeyDown: (reactEvent: React.KeyboardEvent<HTMLSpanElement>) => {
      beforeGroupBubble?.(reactEvent);
      handlers.groupKeyDown(reactEvent);
    },
  };
  const wrappedSourceProps = {
    ...sourceProps,
    onKeyDownCapture: sourceCapture,
    onKeyDown: (reactEvent: React.KeyboardEvent<HTMLButtonElement>) => {
      const isOuterDelivery = bubbleWrapper === null;
      if (isOuterDelivery) bubbleWrapper = reactEvent;
      beforeActionBubble?.(reactEvent);
      const retainedPreventDefault = reactEvent.preventDefault;
      const exactPreventDefault = vi.fn(function (
        this: React.KeyboardEvent<HTMLButtonElement>,
      ) {
        duringPublicPreventDefault?.();
        return Reflect.apply(retainedPreventDefault, this, []);
      });
      if (isOuterDelivery) {
        publicPreventDefault = exactPreventDefault;
        Object.defineProperty(reactEvent, "preventDefault", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: exactPreventDefault,
        });
      }
      sourceBubble(reactEvent);
      afterActionBubble?.(reactEvent);
    },
  };

  groupProperties[groupPropsKey] = wrappedGroupProps;
  sourceProperties[sourcePropsKey] = wrappedSourceProps;
  try {
    source.dispatchEvent(event);
  } finally {
    if (groupProperties[groupPropsKey] === wrappedGroupProps) {
      groupProperties[groupPropsKey] = groupProps;
    }
    if (sourceProperties[sourcePropsKey] === wrappedSourceProps) {
      sourceProperties[sourcePropsKey] = sourceProps;
    }
  }
  return { captureWrapper, bubbleWrapper, publicPreventDefault };
}

function giveKeyboardWrapperDistinctMethods(
  event: React.KeyboardEvent<HTMLElement>,
) {
  const prototype = Object.create(Object.getPrototypeOf(event)) as object;
  const preventDefault = event.preventDefault;
  const isDefaultPrevented = event.isDefaultPrevented;
  const isPropagationStopped = event.isPropagationStopped;
  Object.setPrototypeOf(event, prototype);
  Object.defineProperties(event, {
    preventDefault: {
      configurable: true,
      writable: true,
      value: function (this: React.KeyboardEvent<HTMLElement>) {
        return Reflect.apply(preventDefault, this, []);
      },
    },
    isDefaultPrevented: {
      configurable: true,
      writable: true,
      value: function (this: React.KeyboardEvent<HTMLElement>) {
        return Reflect.apply(isDefaultPrevented, this, []);
      },
    },
    isPropagationStopped: {
      configurable: true,
      writable: true,
      value: function (this: React.KeyboardEvent<HTMLElement>) {
        return Reflect.apply(isPropagationStopped, this, []);
      },
    },
  });
}

function renderStrictStats(
  session: CollabSession,
  onBoundary: () => void,
  source = "One two three.",
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createTrackedRoot(host);
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
  pointerDelayMs = 0,
  pointerEvents?: readonly Event[],
  pointerOriginal?: Event,
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
      ? (pointerOriginal ?? statsPointerEvent("pointerdown"))
      : new FocusEvent("focusin", {
          bubbles: true,
          cancelable: true,
          composed: true,
        });
  let pointerCallbackScheduled = false;
  const consume = (event: Event) => {
    if (source === "focus" && event !== original) return;
    const deliver = () => {
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
    };
    if (source === "pointer") {
      if (!pointerCallbackScheduled) {
        pointerCallbackScheduled = true;
        setTimeout(deliver, pointerDelayMs);
      }
    } else {
      deliver();
    }
    event.stopPropagation();
  };
  target.addEventListener(consumeType, consume);
  try {
    act(() => {
      if (source === "pointer") {
        target.dispatchEvent(original);
        for (
          const pointerEvent of pointerEvents ?? [
            statsPointerEvent("pointerup"),
            statsPointerEvent("click"),
          ]
        ) {
          target.dispatchEvent(pointerEvent);
        }
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
  const root = createTrackedRoot(host);
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
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: StatsPointerEvent,
  });
  capturedPopoverOpenChanges.length = 0;
  capturedStatsContentCallbacks.length = 0;
  publishedPopoverOpenChanges.length = 0;
  deliveredStatsCloseAutoFocusEvents.length = 0;
  unhandledRejections.length = 0;
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(async () => {
  for (const root of [...manualRoots]) {
    act(() => root.unmount());
  }
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

describe("StatsPopover directional disclosure authority", () => {
  it.each([
    ["empty", null, "ArrowDown", "goal-mode"],
    ["empty", null, "ArrowUp", "goal-kind"],
    [
      "existing",
      goal("words", "min", 250),
      "ArrowDown",
      "goal-mode",
    ],
    [
      "existing",
      goal("words", "min", 250),
      "ArrowUp",
      "goal-clear",
    ],
  ] as const)(
    "opens an %s goal with %s and focuses the exact %s once without document work or scroll",
    async (_state, existingGoal, key, testId) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const documentScroll = vi
        .spyOn(window, "scrollTo")
        .mockImplementation(() => {});
      const scrollIntoView = vi.fn();
      const originalScrollIntoView = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "scrollIntoView",
      );
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: scrollIntoView,
        writable: true,
      });
      const session = makeSession(
        `direction-${_state}-${key}`,
        "owner",
        existingGoal,
      );
      let goalWrites = 0;
      let textWrites = 0;
      session.meta.observe(() => goalWrites++);
      session.ytext.observe(() => textWrites++);
      const mounted = renderStrictStats(session, () => {});
      try {
        const trigger = screen.getByTestId(
          "stats-button",
        ) as HTMLButtonElement;
        trigger.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const before = {
          goal: getGoal(session),
          mode: session.mode,
          source: session.ytext.toString(),
          bodyLeft: document.body.scrollLeft,
          bodyTop: document.body.scrollTop,
          documentLeft: document.documentElement.scrollLeft,
          documentTop: document.documentElement.scrollTop,
          x: window.scrollX,
          y: window.scrollY,
        };
        const event = statsKey(trigger, key);

        await act(async () => {
          trigger.dispatchEvent(event);
          await Promise.resolve();
        });

        const destination = screen.getByTestId(testId);
        expect(screen.getAllByTestId("stats-popover")).toHaveLength(1);
        expect(trigger).toHaveAttribute("aria-expanded", "true");
        expect(destination).toHaveFocus();
        expect(
          preventDefault.mock.contexts.filter(
            (context) => context === event,
          ),
        ).toHaveLength(1);
        expect(
          focus.mock.contexts.filter(
            (context) => context === destination,
          ),
        ).toHaveLength(1);
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(goalWrites).toBe(0);
        expect(textWrites).toBe(0);
        expect(getGoal(session)).toEqual(before.goal);
        expect(session.mode).toBe(before.mode);
        expect(session.ytext.toString()).toBe(before.source);
        expect(documentScroll).not.toHaveBeenCalled();
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect({
          bodyLeft: document.body.scrollLeft,
          bodyTop: document.body.scrollTop,
          documentLeft: document.documentElement.scrollLeft,
          documentTop: document.documentElement.scrollTop,
          x: window.scrollX,
          y: window.scrollY,
        }).toEqual({
          bodyLeft: before.bodyLeft,
          bodyTop: before.bodyTop,
          documentLeft: before.documentLeft,
          documentTop: before.documentTop,
          x: before.x,
          y: before.y,
        });
        expectDraft(
          existingGoal?.kind ?? "words",
          existingGoal?.mode ?? "min",
          existingGoal ? String(existingGoal.value) : "",
        );
      } finally {
        act(() => mounted.root.unmount());
        mounted.host.remove();
        focus.mockRestore();
        preventDefault.mockRestore();
        documentScroll.mockRestore();
        if (originalScrollIntoView) {
          Object.defineProperty(
            HTMLElement.prototype,
            "scrollIntoView",
            originalScrollIntoView,
          );
        } else {
          Reflect.deleteProperty(
            HTMLElement.prototype,
            "scrollIntoView",
          );
        }
      }
    },
  );

  it.each(["ArrowDown", "ArrowUp"] as const)(
    "leaves readonly %s unprevented and closed when no goal control is enabled",
    async (key) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const mounted = renderStrictStats(
        makeSession(`direction-readonly-${key}`, "viewer"),
        () => {},
      );
      try {
        const trigger = screen.getByTestId(
          "stats-button",
        ) as HTMLButtonElement;
        trigger.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const event = statsKey(trigger, key);

        await act(async () => {
          trigger.dispatchEvent(event);
          await Promise.resolve();
        });

        expect(event.defaultPrevented).toBe(false);
        expect(
          preventDefault.mock.contexts.filter(
            (context) => context === event,
          ),
        ).toHaveLength(0);
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByTestId("stats-popover")).toBeNull();
        expect(focus).not.toHaveBeenCalled();
      } finally {
        act(() => mounted.root.unmount());
        mounted.host.remove();
        focus.mockRestore();
        preventDefault.mockRestore();
      }
    },
  );

  it.each([
    ["distinct jsdom", false],
    ["identical public", true],
  ] as const)(
    "binds directional authority to the %s listener receiver",
    async (_label, exposeReceiver) => {
      const ownerDocument = document;
      const publicWindow = ownerDocument.defaultView;
      if (!publicWindow) {
        throw new Error("Document default view was unavailable");
      }
      let receiver = observeWindowListenerReceiver(publicWindow);
      let restore = () => {};
      if (exposeReceiver) {
        const exact = exposeExactWindowListenerReceiver(ownerDocument);
        receiver = exact.receiver;
        restore = exact.restore;
        expect(ownerDocument.defaultView).toBe(receiver);
      } else {
        expect(receiver).not.toBe(publicWindow);
      }
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const mounted = renderStrictStats(
        makeSession(`direction-listener-${_label}`),
        () => {},
      );
      try {
        const trigger = screen.getByTestId(
          "stats-button",
        ) as HTMLButtonElement;
        trigger.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const event = statsKey(trigger, "ArrowDown");

        await act(async () => {
          trigger.dispatchEvent(event);
          await Promise.resolve();
        });

        expect(event.view).toBe(receiver);
        expect(event.defaultPrevented).toBe(true);
        expect(screen.getByTestId("goal-mode")).toHaveFocus();
        expect(
          preventDefault.mock.contexts.filter(
            (context) => context === event,
          ),
        ).toHaveLength(1);
        expect(focus).toHaveBeenCalledOnce();
      } finally {
        act(() => mounted.root.unmount());
        mounted.host.remove();
        restore();
        focus.mockRestore();
        preventDefault.mockRestore();
      }
    },
  );

  it("rejects a same-prototype Window-shaped callback receiver", async () => {
    const publicWindow = document.defaultView;
    if (!publicWindow) {
      throw new Error("Document default view was unavailable");
    }
    const genuineReceiver =
      observeWindowListenerReceiver(publicWindow);
    const structuralReceiver = Object.create(
      Object.getPrototypeOf(genuineReceiver),
    ) as Window;
    Object.defineProperties(structuralReceiver, {
      constructor: {
        configurable: true,
        value: genuineReceiver.constructor,
      },
      document: { configurable: true, value: document },
      self: {
        configurable: true,
        value: structuralReceiver,
      },
      window: {
        configurable: true,
        value: structuralReceiver,
      },
    });
    expect(Object.getPrototypeOf(structuralReceiver)).toBe(
      Object.getPrototypeOf(genuineReceiver),
    );
    expect(structuralReceiver.constructor).toBe(
      genuineReceiver.constructor,
    );
    expect(structuralReceiver.document).toBe(document);
    const restoreReceiver =
      redirectWindowKeyCaptureReceiver(structuralReceiver);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const mounted = renderStrictStats(
      makeSession("direction-structural-listener"),
      () => {},
    );
    try {
      const trigger = screen.getByTestId(
        "stats-button",
      ) as HTMLButtonElement;
      trigger.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const event = statsKey(trigger, "ArrowDown");

      await act(async () => {
        trigger.dispatchEvent(event);
        await Promise.resolve();
      });

      expect(event.defaultPrevented).toBe(false);
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("stats-popover")).toBeNull();
      expect(focus).not.toHaveBeenCalled();
      expect(
        preventDefault.mock.contexts.filter(
          (context) => context === event,
        ),
      ).toHaveLength(0);
    } finally {
      act(() => mounted.root.unmount());
      mounted.host.remove();
      restoreReceiver();
      focus.mockRestore();
      preventDefault.mockRestore();
    }
  });

  it("invalidates a removed Strict listener and accepts a clean successor", async () => {
    const listeners = trackWindowKeydownListeners();
    let replayListener: WindowKeyListener | null = null;
    const first = renderStrictStats(
      makeSession("direction-stale-listener"),
      () => {
        replayListener ??= [...listeners.active][0] ?? null;
      },
    );
    let firstMounted = true;
    let relay: ((this: Window, event: KeyboardEvent) => void) | null =
      null;
    let second:
      | ReturnType<typeof renderStrictStats>
      | null = null;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    try {
      if (!replayListener) {
        throw new Error("Strict Mode did not expose its first listener");
      }
      const currentListener = [...listeners.active][0];
      if (!currentListener) {
        throw new Error("Current Window listener was unavailable");
      }
      expect(currentListener).not.toBe(replayListener);
      expect(
        listeners.added.filter(
          (listener) => listener === replayListener,
        ),
      ).toHaveLength(2);
      expect(
        listeners.removed.filter(
          (listener) => listener === replayListener,
        ),
      ).toHaveLength(2);
      expect(
        listeners.added.filter(
          (listener) => listener === currentListener,
        ),
      ).toHaveLength(2);

      listeners.nativeRemove(
        "keydown",
        currentListener,
        true,
      );
      listeners.nativeRemove("keydown", currentListener);
      relay = function (this: Window, event: KeyboardEvent) {
        invokeWindowListener(replayListener!, event, this);
      };
      listeners.nativeAdd("keydown", relay, true);
      const trigger = screen.getByTestId(
        "stats-button",
      ) as HTMLButtonElement;
      trigger.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const rejected = statsKey(trigger, "ArrowDown");

      await act(async () => {
        trigger.dispatchEvent(rejected);
        await Promise.resolve();
      });

      expect(rejected.defaultPrevented).toBe(false);
      expect(screen.queryByTestId("stats-popover")).toBeNull();
      expect(focus).not.toHaveBeenCalled();

      await act(async () => {
        first.root.unmount();
        await Promise.resolve();
      });
      firstMounted = false;
      first.host.remove();
      listeners.nativeRemove("keydown", relay, true);
      relay = null;
      expect(
        listeners.removed.filter(
          (listener) => listener === currentListener,
        ),
      ).toHaveLength(2);

      second = renderStrictStats(
        makeSession("direction-clean-listener"),
        () => {},
      );
      const successorTrigger = screen.getByTestId(
        "stats-button",
      ) as HTMLButtonElement;
      successorTrigger.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const successor = statsKey(
        successorTrigger,
        "ArrowDown",
      );
      await act(async () => {
        successorTrigger.dispatchEvent(successor);
        await Promise.resolve();
      });

      expect(successor.defaultPrevented).toBe(true);
      expect(screen.getByTestId("goal-mode")).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      if (relay) {
        listeners.nativeRemove("keydown", relay, true);
      }
      if (firstMounted) {
        act(() => first.root.unmount());
        first.host.remove();
      }
      if (second) {
        const mountedSecond = second;
        act(() => mountedSecond.root.unmount());
        mountedSecond.host.remove();
      }
      focus.mockRestore();
      preventDefault.mockRestore();
    }
  });

  it.each(["ArrowDown", "ArrowUp"] as const)(
    "rejects untrusted, modified, repeated, composing, malformed, unfocused, and wrong-target %s input",
    async (key) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const mounted = renderStrictStats(
        makeSession(`direction-rejections-${key}`),
        () => {},
      );
      try {
        const trigger = screen.getByTestId(
          "stats-button",
        ) as HTMLButtonElement;
        const child = trigger.querySelector<HTMLElement>(
          '[data-testid="word-count"]',
        );
        if (!child) throw new Error("Word count child was not rendered");
        const reject = async (
          event: KeyboardEvent,
          target: HTMLElement = trigger,
          alreadyPrevented = false,
        ) => {
          focus.mockClear();
          const calls = preventDefault.mock.contexts.filter(
            (context) => context === event,
          ).length;
          await act(async () => {
            target.dispatchEvent(event);
            await Promise.resolve();
          });
          expect(event.defaultPrevented).toBe(alreadyPrevented);
          expect(
            preventDefault.mock.contexts.filter(
              (context) => context === event,
            ),
          ).toHaveLength(calls);
          expect(trigger).toHaveAttribute("aria-expanded", "false");
          expect(screen.queryByTestId("stats-popover")).toBeNull();
          expect(focus).not.toHaveBeenCalled();
        };

        trigger.focus();
        await reject(statsKey(trigger, key, {}, false));
        for (const init of [
          { ctrlKey: true },
          { altKey: true },
          { metaKey: true },
          { shiftKey: true },
          { repeat: true },
          { isComposing: true },
          { cancelable: false },
          { bubbles: false },
          { code: key === "ArrowDown" ? "ArrowUp" : "ArrowDown" },
        ] satisfies KeyboardEventInit[]) {
          trigger.focus();
          await reject(statsKey(trigger, key, init));
        }

        trigger.focus();
        await reject(statsKey(child, key), child);

        trigger.blur();
        await reject(statsKey(trigger, key));

        trigger.focus();
        const prevented = statsKey(trigger, key);
        prevented.preventDefault();
        await reject(prevented, trigger, true);

        trigger.focus();
        focus.mockClear();
        const accepted = statsKey(trigger, key);
        await act(async () => {
          trigger.dispatchEvent(accepted);
          await Promise.resolve();
        });
        expect(trigger).toHaveAttribute("aria-expanded", "true");
        expect(accepted.defaultPrevented).toBe(true);
        expect(
          preventDefault.mock.contexts.filter(
            (context) => context === accepted,
          ),
        ).toHaveLength(1);
        expect(focus).toHaveBeenCalledOnce();
      } finally {
        act(() => mounted.root.unmount());
        mounted.host.remove();
        focus.mockRestore();
        preventDefault.mockRestore();
      }
    },
  );

  it("rejects a structural view lookalike and accepts a distinct exact-view successor", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const mounted = renderStrictStats(
      makeSession("direction-view-authority"),
      () => {},
    );
    try {
      const trigger = screen.getByTestId(
        "stats-button",
      ) as HTMLButtonElement;
      trigger.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const lookalike: Record<string, unknown> = {
        document: trigger.ownerDocument,
      };
      lookalike.window = lookalike;
      const crossed = statsKey(trigger, "ArrowDown");
      Object.defineProperty(crossed, "view", {
        configurable: true,
        value: lookalike,
      });

      await act(async () => {
        trigger.dispatchEvent(crossed);
        await Promise.resolve();
      });

      expect(crossed.defaultPrevented).toBe(false);
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(focus).not.toHaveBeenCalled();

      const successor = statsKey(trigger, "ArrowDown");
      await act(async () => {
        trigger.dispatchEvent(successor);
        await Promise.resolve();
      });
      expect(successor.defaultPrevented).toBe(true);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("goal-mode")).toHaveFocus();
      expect(
        preventDefault.mock.contexts.filter(
          (context) => context === successor,
        ),
      ).toHaveLength(1);
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      act(() => mounted.root.unmount());
      mounted.host.remove();
      focus.mockRestore();
      preventDefault.mockRestore();
    }
  });

  it("latches restored keyboard descriptors and recovers with a complete clean successor", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const mounted = renderStrictStats(
      makeSession("direction-descriptor-history"),
      () => {},
    );
    const descriptor = Object.getOwnPropertyDescriptor(
      window.KeyboardEvent.prototype,
      "key",
    );
    if (!descriptor?.get) {
      throw new Error("KeyboardEvent key getter was unavailable");
    }
    try {
      const trigger = screen.getByTestId(
        "stats-button",
      ) as HTMLButtonElement;
      trigger.focus();
      Object.defineProperty(window.KeyboardEvent.prototype, "key", {
        ...descriptor,
        get(this: KeyboardEvent) {
          return Reflect.apply(descriptor.get!, this, []);
        },
      });
      trigger.dispatchEvent(statsKey(trigger, "F1"));
      Object.defineProperty(
        window.KeyboardEvent.prototype,
        "key",
        descriptor,
      );
      focus.mockClear();
      preventDefault.mockClear();
      const rejected = statsKey(trigger, "ArrowDown");

      await act(async () => {
        trigger.dispatchEvent(rejected);
        await Promise.resolve();
      });

      expect(rejected.defaultPrevented).toBe(false);
      expect(screen.queryByTestId("stats-popover")).toBeNull();
      expect(focus).not.toHaveBeenCalled();

      const currentTrigger = screen.getByTestId(
        "stats-button",
      ) as HTMLButtonElement;
      currentTrigger.focus();
      focus.mockClear();
      const successor = statsKey(currentTrigger, "ArrowDown");
      await act(async () => {
        currentTrigger.dispatchEvent(successor);
        await Promise.resolve();
      });
      expect(successor.defaultPrevented).toBe(true);
      expect(screen.getByTestId("goal-mode")).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(
        window.KeyboardEvent.prototype,
        "key",
        descriptor,
      );
      act(() => mounted.root.unmount());
      mounted.host.remove();
      focus.mockRestore();
      preventDefault.mockRestore();
    }
  });

  it("claims one current native and React pair across Strict replay and reentrancy", async () => {
    const nativePreventDefault = Event.prototype.preventDefault;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const mounted = renderStrictStats(
      makeSession("direction-pair-replay"),
      () => {},
    );
    try {
      const stale = captureStatsTrigger();
      act(() =>
        mounted.root.render(
          <StrictMode>
            <StatsBoundary
              session={sessions.at(-1)!}
              source="One two three four."
            />
          </StrictMode>,
        ),
      );
      const current = captureStatsTrigger();
      expect(current.element).toBe(stale.element);
      expect(current.keyDownCapture).not.toBe(
        stale.keyDownCapture,
      );
      expect(current.keyDown).not.toBe(stale.keyDown);
      current.element.focus();
      focus.mockClear();
      const accepted = statsKey(current.element, "ArrowDown");
      const crossed = statsKey(current.element, "ArrowUp");
      preventDefault.mockImplementation(function (this: Event) {
        nativePreventDefault.call(this);
        if (this === accepted) current.element.dispatchEvent(crossed);
      });

      await act(async () => {
        dispatchStatsKey(
          current,
          accepted,
          [
            stale.keyDownCapture,
            current.keyDownCapture,
            current.keyDownCapture,
          ],
          [stale.keyDown, current.keyDown, current.keyDown],
        );
        await Promise.resolve();
      });

      expect(accepted.defaultPrevented).toBe(true);
      expect(crossed.defaultPrevented).toBe(false);
      expect(
        preventDefault.mock.contexts.filter(
          (context) => context === accepted,
        ),
      ).toHaveLength(1);
      expect(
        preventDefault.mock.contexts.filter(
          (context) => context === crossed,
        ),
      ).toHaveLength(0);
      expect(screen.getAllByTestId("stats-popover")).toHaveLength(1);
      expect(screen.getByTestId("goal-mode")).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      act(() => mounted.root.unmount());
      mounted.host.remove();
      focus.mockRestore();
      preventDefault.mockRestore();
    }
  });

  it("keeps a mutate-restored trigger retired and accepts a clean keyed successor", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const mounted = renderStrictStats(
      makeSession("direction-trigger-history"),
      () => {},
    );
    try {
      const trigger = screen.getByTestId(
        "stats-button",
      ) as HTMLButtonElement;
      trigger.focus();
      trigger.setAttribute("data-integrity-probe", "changed");
      trigger.removeAttribute("data-integrity-probe");
      focus.mockClear();
      preventDefault.mockClear();
      const rejected = statsKey(trigger, "ArrowDown");
      await act(async () => {
        trigger.dispatchEvent(rejected);
        await Promise.resolve();
      });
      expect(rejected.defaultPrevented).toBe(false);
      expect(screen.queryByTestId("stats-popover")).toBeNull();
      expect(focus).not.toHaveBeenCalled();

      const currentTrigger = screen.getByTestId(
        "stats-button",
      ) as HTMLButtonElement;
      currentTrigger.focus();
      focus.mockClear();
      const successor = statsKey(currentTrigger, "ArrowUp");
      await act(async () => {
        currentTrigger.dispatchEvent(successor);
        await Promise.resolve();
      });
      expect(successor.defaultPrevented).toBe(true);
      expect(screen.getByTestId("goal-kind")).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      act(() => mounted.root.unmount());
      mounted.host.remove();
      focus.mockRestore();
      preventDefault.mockRestore();
    }
  });

  it.each([
    "session",
    "statistics",
    "selection",
    "goal",
    "callbacks",
  ] as const)(
    "rejects stale %s wrappers and accepts only the complete current publication",
    async (change) => {
      const initial = makeSession(`direction-stale-${change}`);
      const replacement =
        change === "session"
          ? makeSession(`direction-current-${change}`)
          : initial;
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createTrackedRoot(host);
      let source = "One two three.";
      let selection: SourceSelection = null;
      let mount: "initial" | "replacement" = "initial";
      const renderCurrent = () =>
        root.render(
          <StrictMode>
            <StatsBoundary
              session={replacement}
              source={source}
              selection={selection}
              mount={mount}
            />
          </StrictMode>,
        );
      try {
        act(() =>
          root.render(
            <StrictMode>
              <StatsBoundary session={initial} />
            </StrictMode>,
          ),
        );
        const stale = captureStatsTrigger();
        await act(async () => {
          if (change === "statistics") {
            source = "One two three four.";
          } else if (change === "selection") {
            selection = { from: 0, to: 3 };
          } else if (change === "goal") {
            setGoal(initial, goal("words", "min", 100));
          } else if (change === "callbacks") {
            mount = "replacement";
          }
          renderCurrent();
          await Promise.resolve();
        });
        const current = captureStatsTrigger();
        current.element.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const rejected = statsKey(
          current.element,
          "ArrowDown",
        );

        await act(async () => {
          dispatchStatsKey(
            current,
            rejected,
            [stale.keyDownCapture],
            [stale.keyDown],
          );
          await Promise.resolve();
        });

        expect(rejected.defaultPrevented).toBe(false);
        expect(screen.queryByTestId("stats-popover")).toBeNull();
        expect(focus).not.toHaveBeenCalled();

        const successorTrigger = screen.getByTestId(
          "stats-button",
        ) as HTMLButtonElement;
        successorTrigger.focus();
        focus.mockClear();
        const successor = statsKey(
          successorTrigger,
          "ArrowDown",
        );
        await act(async () => {
          successorTrigger.dispatchEvent(successor);
          await Promise.resolve();
        });
        expect(successor.defaultPrevented).toBe(true);
        expect(screen.getByTestId("goal-mode")).toHaveFocus();
        expect(
          preventDefault.mock.contexts.filter(
            (context) => context === successor,
          ),
        ).toHaveLength(1);
        expect(focus).toHaveBeenCalledOnce();
      } finally {
        act(() => root.unmount());
        host.remove();
        focus.mockRestore();
        preventDefault.mockRestore();
      }
    },
  );
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
    const root = createTrackedRoot(host);
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

  it("keeps batched close suppression through Radix passive cleanup ordering", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T08:00:00.000Z"));
    const session = makeSession("strict-close-passive-order");
    const mounted = renderStrictStats(session, () => {});
    let advancedLayoutClock = false;

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
      const deliveredCount =
        deliveredStatsCloseAutoFocusEvents.length;
      const escape = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Escape",
        key: "Escape",
      });

      act(() => {
        closingContent.dispatchEvent(escape);
        mounted.root.render(
          <StrictMode>
            <StatsBoundary
              session={session}
              source="One two three!"
              boundary={1}
              onBoundary={() => {
                if (advancedLayoutClock) return;
                advancedLayoutClock = true;
                vi.setSystemTime(Date.now() + 2);
              }}
            />
          </StrictMode>,
        );
      });
      expect(advancedLayoutClock).toBe(true);
      expect(focusClosingTrigger).not.toHaveBeenCalled();

      await act(() => vi.advanceTimersByTimeAsync(0));
      const [closeAutoFocusEvent] =
        deliveredStatsCloseAutoFocusEvents.slice(deliveredCount);
      expect(closeAutoFocusEvent).toBeDefined();
      expect(closeAutoFocusEvent.defaultPrevented).toBe(true);
      expect(focusClosingTrigger).not.toHaveBeenCalled();
      expect(screen.queryByTestId("stats-popover")).toBeNull();
    } finally {
      act(() => mounted.root.unmount());
      vi.clearAllTimers();
      vi.useRealTimers();
      mounted.host.remove();
    }
  });

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
        const deliveredCount =
          deliveredStatsCloseAutoFocusEvents.length;

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
        if (change === "equivalent") {
          act(() => renderCurrent());
        }

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
        expect(focusTrigger).not.toHaveBeenCalled();

        await act(() => vi.advanceTimersByTimeAsync(0));
        const closeAutoFocusEvents =
          deliveredStatsCloseAutoFocusEvents.slice(deliveredCount);
        expect(closeAutoFocusEvents).toHaveLength(2);
        expect(
          closeAutoFocusEvents.every(
            (event) => event.defaultPrevented,
          ),
        ).toBe(true);
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

  it("retains one exact pointer-outside dismissal through the deferred Radix callback", async () => {
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

  it.each([
    "duplicate pointerup",
    "duplicate click",
    "moved path",
    "MouseEvent-named pointer chain",
  ] as const)("rejects a %s before the deferred outside callback", async (variant) => {
    vi.useFakeTimers();
    const outside = document.createElement("button");
    document.body.append(outside);
    const mounted = renderStrictStats(
      makeSession(`strict-pointer-outside-${variant}`),
      () => {},
    );
    try {
      openPopover();
      let original: Event | undefined;
      let pointerEvents: readonly Event[];
      if (variant === "duplicate pointerup") {
        pointerEvents = [
          statsPointerEvent("pointerup"),
          statsPointerEvent("pointerup"),
          statsPointerEvent("click"),
        ];
      } else if (variant === "duplicate click") {
        pointerEvents = [
          statsPointerEvent("pointerup"),
          statsPointerEvent("click"),
          statsPointerEvent("click"),
        ];
      } else if (variant === "moved path") {
        const movedClick = statsPointerEvent("click");
        Object.defineProperty(movedClick, "composedPath", {
          configurable: true,
          value: () => [outside, document, window],
        });
        pointerEvents = [
          statsPointerEvent("pointerup"),
          movedClick,
        ];
      } else {
        original = new MouseEvent("pointerdown", {
          bubbles: true,
          button: 0,
          cancelable: true,
          composed: true,
        });
        pointerEvents = [
          new MouseEvent("pointerup", {
            bubbles: true,
            button: 0,
            cancelable: true,
            composed: true,
          }),
          new MouseEvent("click", {
            bubbles: true,
            button: 0,
            cancelable: true,
            composed: true,
            detail: 1,
          }),
        ];
      }

      dispatchStatsOutside(
        "pointer",
        outside,
        [capturedStatsContentCallbacks.at(-1)!],
        [capturedPopoverOpenChanges.at(-1)!],
        0,
        pointerEvents,
        original,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(screen.getByTestId("stats-popover")).toBeVisible();
      fireEvent.click(screen.getByTestId("stats-button"));
      expect(screen.queryByTestId("stats-popover")).toBeNull();
    } finally {
      act(() => mounted.root.unmount());
      vi.clearAllTimers();
      vi.useRealTimers();
      mounted.host.remove();
      outside.remove();
    }
  });

  it("does not renew a timer-starved completed proof from a second click", async () => {
    vi.useFakeTimers();
    const outside = document.createElement("button");
    document.body.append(outside);
    const mounted = renderStrictStats(
      makeSession("strict-pointer-outside-renewal"),
      () => {},
    );
    let now = window.performance.now();
    const clock = vi
      .spyOn(window.performance, "now")
      .mockImplementation(() => now);
    outside.addEventListener("click", () => {
      now += 1_001;
    }, { once: true });
    try {
      openPopover();
      dispatchStatsOutside(
        "pointer",
        outside,
        [capturedStatsContentCallbacks.at(-1)!],
        [capturedPopoverOpenChanges.at(-1)!],
        0,
        [
          statsPointerEvent("pointerup"),
          statsPointerEvent("click"),
          statsPointerEvent("click"),
        ],
      );
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(screen.getByTestId("stats-popover")).toBeVisible();
      fireEvent.click(screen.getByTestId("stats-button"));
      expect(screen.queryByTestId("stats-popover")).toBeNull();
    } finally {
      clock.mockRestore();
      act(() => mounted.root.unmount());
      vi.clearAllTimers();
      vi.useRealTimers();
      mounted.host.remove();
      outside.remove();
    }
  });

  it("rejects a deferred pointer-outside dismissal after its exact click lease expires", async () => {
    vi.useFakeTimers();
    const outside = document.createElement("button");
    document.body.append(outside);
    const mounted = renderStrictStats(
      makeSession("strict-pointer-outside-expired"),
      () => {},
    );
    try {
      openPopover();
      dispatchStatsOutside(
        "pointer",
        outside,
        [capturedStatsContentCallbacks.at(-1)!],
        [capturedPopoverOpenChanges.at(-1)!],
        1_001,
      );
      await act(() => vi.advanceTimersByTimeAsync(1_001));

      expect(screen.getByTestId("stats-popover")).toBeVisible();
      fireEvent.click(screen.getByTestId("stats-button"));
      expect(screen.queryByTestId("stats-popover")).toBeNull();
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

describe("StatsPopover writing goal action navigation", () => {
  function focusSpy() {
    return vi.spyOn(window.HTMLElement.prototype, "focus");
  }

  function dispatchObserved(
    actions: GoalActions,
    sourceName: GoalActionSource,
    key: string,
    init: KeyboardEventInit = {},
    hooks: Parameters<typeof dispatchGoalActionKey>[3] = {},
  ) {
    const source = sourceName === "set" ? actions.set : actions.clear;
    if (!source) throw new Error(`${sourceName} action was not rendered`);
    source.focus();
    (
      window.HTMLElement.prototype.focus as typeof window.HTMLElement.prototype.focus & {
        mockClear?: () => void;
      }
    ).mockClear?.();
    const event = statsKey(source, key, init);
    let observation: GoalActionKeyDispatch | undefined;
    act(() => {
      observation = dispatchGoalActionKey(
        actions,
        sourceName,
        event,
        hooks,
      );
    });
    if (!observation) throw new Error("Writing-goal key was not dispatched");
    return { event, observation };
  }

  function expectAccepted(
    focus: ReturnType<typeof focusSpy>,
    destination: HTMLButtonElement,
    result: ReturnType<typeof dispatchObserved>,
    label = "navigation",
  ) {
    const { event, observation } = result;
    expect(event.defaultPrevented, label).toBe(true);
    expect(observation.captureWrapper).not.toBe(observation.bubbleWrapper);
    expect(observation.bubbleWrapper?.defaultPrevented).toBe(true);
    expect(observation.bubbleWrapper?.isDefaultPrevented()).toBe(true);
    expect(observation.publicPreventDefault).toHaveBeenCalledTimes(1);
    expect(observation.publicPreventDefault?.mock.contexts[0]).toBe(
      observation.bubbleWrapper,
    );
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus.mock.instances[0]).toBe(destination);
    expect(focus.mock.calls[0]).toEqual([{ preventScroll: true }]);
    expect(document.activeElement).toBe(destination);
  }

  function expectRejected(
    focus: ReturnType<typeof focusSpy>,
    result: ReturnType<typeof dispatchObserved>,
  ) {
    expect(result.event.defaultPrevented).toBe(false);
    expect(result.observation.publicPreventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  }

  it("moves between enabled Set and Clear actions for arrows, Home, End, and keypad equivalents without activating or scrolling", () => {
    const focus = focusSpy();
    const session = makeSession(
      "goal-action-navigation",
      "owner",
      goal("words", "min", 100),
    );
    mountStrictGoal(session);
    const transaction = vi.spyOn(session.ydoc, "transact");
    const submit = vi.fn();
    const click = vi.fn();
    const initialOpenChanges = publishedPopoverOpenChanges.length;
    const initialGoal = getGoal(session);
    const initialDraft = {
      kind: screen.getByTestId("goal-kind").getAttribute("value"),
      mode: screen.getByTestId("goal-mode").getAttribute("value"),
      value: (screen.getByTestId("goal-value") as HTMLInputElement).value,
    };
    let actions = captureGoalActions();
    actions.form.addEventListener("submit", submit);
    actions.set.addEventListener("click", click);
    actions.clear?.addEventListener("click", click);
    actions.actions.scrollTop = 17;

    const semanticCases = [
      ["set", "ArrowLeft", false],
      ["set", "ArrowUp", false],
      ["set", "Home", false],
      ["set", "ArrowRight", true],
      ["set", "ArrowDown", true],
      ["set", "End", true],
      ["clear", "ArrowLeft", true],
      ["clear", "ArrowUp", true],
      ["clear", "Home", true],
      ["clear", "ArrowRight", false],
      ["clear", "ArrowDown", false],
      ["clear", "End", false],
    ] as const;
    for (const [sourceName, key, moves] of semanticCases) {
      actions = captureGoalActions();
      const destination =
        sourceName === "set" ? actions.clear : actions.set;
      if (!destination) throw new Error("Clear action was not rendered");
      const scrollIntoView = vi.fn();
      Object.defineProperty(destination, "scrollIntoView", {
        configurable: true,
        value: scrollIntoView,
      });
      focus.mockClear();
      const result = dispatchObserved(actions, sourceName, key);
      if (moves) expectAccepted(focus, destination, result, `${sourceName} ${key}`);
      else expectRejected(focus, result);
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(actions.actions.scrollTop).toBe(17);
    }

    const keypadCases = [
      ["clear", "ArrowLeft", "Numpad4"],
      ["clear", "ArrowUp", "Numpad8"],
      ["set", "ArrowRight", "Numpad6"],
      ["set", "ArrowDown", "Numpad2"],
      ["clear", "Home", "Numpad7"],
      ["set", "End", "Numpad1"],
    ] as const;
    for (const [sourceName, key, code] of keypadCases) {
      actions = captureGoalActions();
      const destination =
        sourceName === "set" ? actions.clear : actions.set;
      if (!destination) throw new Error("Clear action was not rendered");
      focus.mockClear();
      const result = dispatchObserved(actions, sourceName, key, {
        code,
        location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
      });
      expectAccepted(focus, destination, result, `${sourceName} ${key} ${code}`);
    }

    expect(getGoal(session)).toEqual(initialGoal);
    expect((screen.getByTestId("goal-value") as HTMLInputElement).value).toBe(
      initialDraft.value,
    );
    expect(screen.getByTestId("goal-kind").getAttribute("value")).toBe(
      initialDraft.kind,
    );
    expect(screen.getByTestId("goal-mode").getAttribute("value")).toBe(
      initialDraft.mode,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(publishedPopoverOpenChanges).toHaveLength(initialOpenChanges);
    expect(screen.getByTestId("stats-popover")).toBeVisible();
  });

  it("leaves disabled, missing, single, and bounded action sets unhandled", () => {
    const focus = focusSpy();
    const session = makeSession("goal-action-single");
    mountStrictGoal(session);

    let actions = captureGoalActions();
    expect(actions.set).toBeDisabled();
    expect(actions.clear).toBeNull();
    for (const key of [
      "ArrowLeft",
      "ArrowUp",
      "ArrowRight",
      "ArrowDown",
      "Home",
      "End",
    ]) {
      const event = statsKey(actions.set, key);
      actions.value.focus();
      focus.mockClear();
      act(() => {
        actions.set.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();
    }

    fireEvent.input(actions.value, { target: { value: "25" } });
    actions = captureGoalActions();
    expect(actions.set).toBeEnabled();
    expect(actions.clear).toBeNull();
    for (const key of [
      "ArrowLeft",
      "ArrowUp",
      "ArrowRight",
      "ArrowDown",
      "Home",
      "End",
    ]) {
      focus.mockClear();
      expectRejected(focus, dispatchObserved(actions, "set", key));
    }
  });

  it("excludes a disabled Set action when Clear is the only enabled action", () => {
    const focus = focusSpy();
    const session = makeSession(
      "goal-action-disabled-set",
      "owner",
      goal("words", "min", 100),
    );
    mountStrictGoal(session);
    let actions = captureGoalActions();
    fireEvent.input(actions.value, { target: { value: "" } });
    actions = captureGoalActions();
    expect(actions.set).toBeDisabled();
    expect(actions.clear).toBeEnabled();

    for (const key of [
      "ArrowLeft",
      "ArrowUp",
      "ArrowRight",
      "ArrowDown",
      "Home",
      "End",
    ]) {
      focus.mockClear();
      expectRejected(focus, dispatchObserved(actions, "clear", key));
    }
  });

  it("isolates the selects and numeric input from action navigation", () => {
    const focus = focusSpy();
    const session = makeSession(
      "goal-action-control-isolation",
      "owner",
      goal("words", "min", 100),
    );
    mountStrictGoal(session);
    const actions = captureGoalActions();

    for (const [control, key] of [
      [actions.mode, "ArrowDown"],
      [actions.kind, "ArrowUp"],
      [actions.value, "ArrowRight"],
      [actions.value, "Home"],
    ] as const) {
      control.focus();
      focus.mockClear();
      const event = statsKey(control, key);
      act(() => {
        control.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(control);
    }
  });

  it("requires unmodified, unrepeated, composing-free, uncancelled delivery through every boundary", () => {
    const focus = focusSpy();
    const session = makeSession(
      "goal-action-event-state",
      "owner",
      goal("words", "min", 100),
    );
    mountStrictGoal(session);
    const actions = captureGoalActions();

    for (const init of [
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { repeat: true },
      { isComposing: true },
    ]) {
      focus.mockClear();
      expectRejected(
        focus,
        dispatchObserved(actions, "set", "ArrowRight", init),
      );
    }

    actions.set.focus();
    focus.mockClear();
    const cancelled = statsKey(actions.set, "ArrowRight");
    cancelled.preventDefault();
    let cancelledResult: GoalActionKeyDispatch | undefined;
    act(() => {
      cancelledResult = dispatchGoalActionKey(
        actions,
        "set",
        cancelled,
      );
    });
    if (!cancelledResult) throw new Error("Cancelled key was not dispatched");
    expect(cancelled.defaultPrevented).toBe(true);
    expect(cancelledResult.publicPreventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    focus.mockClear();
    const stopped = dispatchObserved(
      actions,
      "set",
      "ArrowRight",
      {},
      {
        beforeCapture: (event) => event.stopPropagation(),
      },
    );
    expect(stopped.event.defaultPrevented).toBe(false);
    expect(stopped.observation.bubbleWrapper).toBeNull();
    expect(focus).not.toHaveBeenCalled();
  });

  it("accepts distinct capture and bubble wrappers, prototypes, and public methods while preserving each phase", () => {
    const focus = focusSpy();
    const session = makeSession(
      "goal-action-phase-authority",
      "owner",
      goal("words", "min", 100),
    );
    mountStrictGoal(session);
    const actions = captureGoalActions();
    focus.mockClear();

    const result = dispatchObserved(
      actions,
      "set",
      "ArrowRight",
      {},
      {
        beforeCapture: (event) =>
          giveKeyboardWrapperDistinctMethods(
            event as React.KeyboardEvent<HTMLElement>,
          ),
        beforeActionBubble: (event) =>
          giveKeyboardWrapperDistinctMethods(
            event as React.KeyboardEvent<HTMLElement>,
          ),
      },
    );

    expectAccepted(focus, actions.clear!, result);
    expect(Object.getPrototypeOf(result.observation.captureWrapper)).not.toBe(
      Object.getPrototypeOf(result.observation.bubbleWrapper),
    );
    expect(result.observation.captureWrapper?.isDefaultPrevented).not.toBe(
      result.observation.bubbleWrapper?.isDefaultPrevented,
    );
    expect(
      result.observation.captureWrapper?.isPropagationStopped,
    ).not.toBe(result.observation.bubbleWrapper?.isPropagationStopped);
  });

  it("rejects same-phase public method drift and recovers for a clean event", () => {
    const focus = focusSpy();
    const session = makeSession(
      "goal-action-method-drift",
      "owner",
      goal("words", "min", 100),
    );
    mountStrictGoal(session);
    let actions = captureGoalActions();
    focus.mockClear();

    const drifted = dispatchObserved(
      actions,
      "set",
      "ArrowRight",
      {},
      {
        afterActionBubble: (event) => {
          const retained = event.isPropagationStopped;
          Object.defineProperty(event, "isPropagationStopped", {
            configurable: true,
            value: function (
              this: React.KeyboardEvent<HTMLButtonElement>,
            ) {
              return Reflect.apply(retained, this, []);
            },
          });
        },
      },
    );
    expectRejected(focus, drifted);
    expect(document.activeElement).toBe(actions.set);

    actions = captureGoalActions();
    focus.mockClear();
    expectAccepted(
      focus,
      actions.clear!,
      dispatchObserved(actions, "set", "ArrowRight"),
    );
  });

  it("rejects stale goal handlers and recovers through current handlers", () => {
    const focus = focusSpy();
    const session = makeSession(
      "goal-action-stale-handlers",
      "owner",
      goal("words", "min", 100),
    );
    const mounted = mountStrictGoal(session);
    const stale = captureGoalActions();
    mounted.rerender("A changed source.");
    let current = captureGoalActions();
    focus.mockClear();

    expectRejected(
      focus,
      dispatchObserved(current, "set", "ArrowRight", {}, { handlers: stale }),
    );
    expect(document.activeElement).toBe(current.set);

    current = captureGoalActions();
    focus.mockClear();
    expectAccepted(
      focus,
      current.clear!,
      dispatchObserved(current, "set", "ArrowRight"),
    );
  });

  it("rejects detach-reinsert and reorder-restore histories before recovering with a fresh publication", async () => {
    const focus = focusSpy();
    const session = makeSession(
      "goal-action-dom-history",
      "owner",
      goal("words", "min", 100),
    );
    mountStrictGoal(session);
    let actions = captureGoalActions();
    const actionParent = actions.actions.parentElement;
    if (!actionParent || !actions.clear) {
      throw new Error("Writing-goal action DOM was unavailable");
    }
    focus.mockClear();

    expectRejected(
      focus,
      dispatchObserved(
        actions,
        "set",
        "ArrowRight",
        {},
        {
          afterCapture: () => {
            actions.actions.remove();
            actionParent.append(actions.actions);
          },
        },
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });

    actions = captureGoalActions();
    focus.mockClear();
    expectRejected(
      focus,
      dispatchObserved(
        actions,
        "set",
        "ArrowRight",
        {},
        {
          afterCapture: () => {
            actions.actions.insertBefore(actions.clear!, actions.set);
            actions.actions.insertBefore(actions.set, actions.clear!);
          },
        },
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });

    actions = captureGoalActions();
    focus.mockClear();
    expectAccepted(
      focus,
      actions.clear!,
      dispatchObserved(actions, "set", "ArrowRight"),
    );
  });

  it("latches Window registration-method drift until a clean Strict Mode successor mounts", () => {
    const focus = focusSpy();
    const session = makeSession(
      "goal-action-window-method-drift",
      "owner",
      goal("words", "min", 100),
    );
    const first = mountStrictGoal(session);
    let actions = captureGoalActions();
    const descriptor = Object.getOwnPropertyDescriptor(
      window,
      "addEventListener",
    );
    const retainedAdd = window.addEventListener;
    Object.defineProperty(window, "addEventListener", {
      configurable: true,
      writable: true,
      value: function (
        this: Window,
        ...args: Parameters<Window["addEventListener"]>
      ) {
        return Reflect.apply(retainedAdd, this, args);
      },
    });
    focus.mockClear();
    expectRejected(
      focus,
      dispatchObserved(actions, "set", "ArrowRight"),
    );
    if (descriptor) {
      Object.defineProperty(window, "addEventListener", descriptor);
    } else {
      Reflect.deleteProperty(window, "addEventListener");
    }

    actions = captureGoalActions();
    focus.mockClear();
    expectRejected(
      focus,
      dispatchObserved(actions, "set", "ArrowRight"),
    );
    act(() => first.root.unmount());

    mountStrictGoal(session);
    actions = captureGoalActions();
    focus.mockClear();
    expectAccepted(
      focus,
      actions.clear!,
      dispatchObserved(actions, "set", "ArrowRight"),
    );
  });

  it("rejects an inexact Window listener receiver and permits a clean successor", () => {
    const focus = focusSpy();
    const receiver = new EventTarget();
    const restoreReceiver = redirectWindowKeyCaptureReceiver(receiver);
    const session = makeSession(
      "goal-action-window-receiver",
      "owner",
      goal("words", "min", 100),
    );
    const first = mountStrictGoal(session);
    let actions = captureGoalActions();
    focus.mockClear();
    expectRejected(
      focus,
      dispatchObserved(actions, "set", "ArrowRight"),
    );
    act(() => first.root.unmount());
    restoreReceiver();

    mountStrictGoal(session);
    actions = captureGoalActions();
    focus.mockClear();
    expectAccepted(
      focus,
      actions.clear!,
      dispatchObserved(actions, "set", "ArrowRight"),
    );
  });

  it("binds action navigation to the exact backing Window receiver", () => {
    const backing = exposeExactWindowListenerReceiver(document);
    const focus = focusSpy();
    const session = makeSession(
      "goal-action-backing-window",
      "owner",
      goal("words", "min", 100),
    );
    const mounted = mountStrictGoal(session);
    const actions = captureGoalActions();
    focus.mockClear();

    expectAccepted(
      focus,
      actions.clear!,
      dispatchObserved(actions, "set", "ArrowRight"),
    );
    act(() => mounted.root.unmount());
    backing.restore();
  });

  it("rejects a structural event view and accepts an exact-view successor", () => {
    const focus = focusSpy();
    const session = makeSession(
      "goal-action-structural-view",
      "owner",
      goal("words", "min", 100),
    );
    mountStrictGoal(session);
    let actions = captureGoalActions();
    actions.set.focus();
    focus.mockClear();
    const event = statsKey(actions.set, "ArrowRight");
    Object.defineProperty(event, "view", {
      configurable: true,
      value: Object.create(event.view as object),
    });
    let observation: GoalActionKeyDispatch | undefined;
    act(() => {
      observation = dispatchGoalActionKey(actions, "set", event);
    });
    if (!observation) throw new Error("Structural-view key was not dispatched");
    expectRejected(focus, { event, observation });

    actions = captureGoalActions();
    focus.mockClear();
    expectAccepted(
      focus,
      actions.clear!,
      dispatchObserved(actions, "set", "ArrowRight"),
    );
  });

  it("claims an accepted movement before rejecting a reentrant key", () => {
    const focus = focusSpy();
    const session = makeSession(
      "goal-action-reentrancy",
      "owner",
      goal("words", "min", 100),
    );
    mountStrictGoal(session);
    const actions = captureGoalActions();
    const nested: KeyboardEvent[] = [];
    focus.mockClear();

    const result = dispatchObserved(
      actions,
      "set",
      "ArrowRight",
      {},
      {
        duringPublicPreventDefault: () => {
          if (nested.length > 0) return;
          const nestedEvent = statsKey(actions.set, "ArrowDown");
          nested.push(nestedEvent);
          actions.set.dispatchEvent(nestedEvent);
        },
      },
    );

    expectAccepted(focus, actions.clear!, result);
    expect(nested).toHaveLength(1);
    expect(nested[0].defaultPrevented).toBe(false);
  });

  it("rejects replay, removes its Window listener on cleanup, and accepts a clean successor event", () => {
    const listeners = trackWindowKeydownListeners();
    const focus = focusSpy();
    const session = makeSession(
      "goal-action-replay-cleanup",
      "owner",
      goal("words", "min", 100),
    );
    const mounted = mountStrictGoal(session);
    let actions = captureGoalActions();
    actions.set.focus();
    const replayed = statsKey(actions.set, "ArrowRight");
    focus.mockClear();
    let first: GoalActionKeyDispatch | undefined;
    act(() => {
      first = dispatchGoalActionKey(actions, "set", replayed);
    });
    if (!first) throw new Error("Initial key was not dispatched");
    expectAccepted(focus, actions.clear!, {
      event: replayed,
      observation: first,
    });

    actions = captureGoalActions();
    actions.set.focus();
    focus.mockClear();
    let replay: GoalActionKeyDispatch | undefined;
    act(() => {
      replay = dispatchGoalActionKey(actions, "set", replayed);
    });
    if (!replay) throw new Error("Replayed key was not dispatched");
    expect(replay.publicPreventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    actions = captureGoalActions();
    focus.mockClear();
    expectAccepted(
      focus,
      actions.clear!,
      dispatchObserved(actions, "set", "ArrowRight"),
    );
    expect(listeners.active.size).toBe(1);
    act(() => mounted.root.unmount());
    expect(listeners.active.size).toBe(0);
    expect(listeners.removed.length).toBeGreaterThan(0);
  });

  it("retains Tab, Enter, Space, click, and input-submit behavior", () => {
    const focus = focusSpy();
    const session = makeSession(
      "goal-action-retained-behavior",
      "owner",
      goal("words", "min", 100),
    );
    const mounted = mountStrictGoal(session);
    let actions = captureGoalActions();
    const clicks = vi.fn();
    actions.clear?.addEventListener("click", clicks);

    const tab = dispatchObserved(actions, "clear", "Tab");
    expect(tab.observation.captureWrapper).not.toBeNull();
    expect(tab.observation.bubbleWrapper).not.toBeNull();
    for (const key of ["Enter", " "]) {
      focus.mockClear();
      expectRejected(focus, dispatchObserved(actions, "clear", key));
    }
    expect(clicks).not.toHaveBeenCalled();
    fireEvent.click(actions.clear!);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(getGoal(session)).toBeNull();
    act(() => mounted.root.unmount());

    const submitSession = makeSession("goal-action-retained-submit");
    mountStrictGoal(submitSession);
    actions = captureGoalActions();
    fireEvent.input(actions.value, { target: { value: "12" } });
    actions = captureGoalActions();
    expect(actions.set).toBeEnabled();
    act(() => {
      directSubmit(actions);
    });
    expect(getGoal(submitSession)).toEqual(
      expect.objectContaining({ kind: "words", mode: "min", value: 12 }),
    );
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
