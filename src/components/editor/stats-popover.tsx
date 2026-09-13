"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import * as Y from "yjs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/primitives";
import type { CollabSession } from "@/editor/collab/session";
import { getGoal, setGoal } from "@/editor/collab/meta";
import { computeSelectionStats, computeStats, goalProgress, type DocStats, type GoalKind, type GoalMode, type GoalProgress, type WritingGoal } from "@/editor/stats";
import { cn, formatNumber, shortcut } from "@/lib/utils";
import { jsonEqual, useSessionValue } from "./use-session";

/** Source range `[from, to]` of the local user's selection, or null when the caret is collapsed / unknown. */
export type SourceSelection = { from: number; to: number } | null;

type RelJSON = Parameters<typeof Y.createRelativePositionFromJSON>[0];
type SelectionAuthority = { session: CollabSession };

function resolve(session: CollabSession, rel: unknown): number | null {
  if (!rel) return null;
  try {
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel as RelJSON), session.ydoc);
    return abs && abs.type === session.ytext ? abs.index : null;
  } catch {
    return null;
  }
}

function isStatsFocusGuard(node: Node | null) {
  if (!node || node.nodeType !== 1) return false;
  const element = node as Element;
  const ElementConstructor = element.ownerDocument.defaultView?.Element;
  return (
    typeof ElementConstructor === "function" &&
    element instanceof ElementConstructor &&
    element.tagName === "SPAN" &&
    element.hasAttribute("data-radix-focus-guard")
  );
}

function previousStatsSibling(node: Node): Node | null {
  let sibling = node.previousSibling;
  while (isStatsFocusGuard(sibling)) {
    sibling = sibling?.previousSibling ?? null;
  }
  return sibling;
}

function nextStatsSibling(node: Node): Node | null {
  let sibling = node.nextSibling;
  while (isStatsFocusGuard(sibling)) {
    sibling = sibling?.nextSibling ?? null;
  }
  return sibling;
}

function readLocalSelection(session: CollabSession): SourceSelection {
  const cursor = session.awareness.getLocalState()?.cursor as { anchor?: unknown; head?: unknown } | null | undefined;
  if (!cursor) return null;
  const a = resolve(session, cursor.anchor);
  const h = resolve(session, cursor.head);
  if (a === null || h === null || a === h) return null;
  return { from: Math.min(a, h), to: Math.max(a, h) };
}

/**
 * The local selection as source offsets, read from the awareness cursor both editing surfaces
 * publish (so the status bar needs no wiring into the panes). Updates on awareness and text changes.
 */
export function useLocalSelection(session: CollabSession): SourceSelection {
  const [sel, setSel] = useState<SourceSelection>(null);
  const authorityRef = useRef<SelectionAuthority | null>(null);
  useLayoutEffect(() => {
    const authority = { session };
    authorityRef.current = authority;
    const update = () => {
      if (authorityRef.current !== authority) return;
      const next = readLocalSelection(authority.session);
      if (authorityRef.current !== authority) return;
      setSel((prev) => {
        if (authorityRef.current !== authority) return prev;
        return prev?.from === next?.from && prev?.to === next?.to ? prev : next;
      });
    };
    update();
    authority.session.awareness.on("change", update);
    const unsubscribe = authority.session.subscribe(update);
    return () => {
      if (authorityRef.current === authority) authorityRef.current = null;
      authority.session.awareness.off("change", update);
      unsubscribe();
    };
  }, [session]);
  return sel;
}

/** 16 px SVG progress ring; colour follows the goal state. */
export function GoalRing({ progress, className }: { progress: GoalProgress; className?: string }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const dash = c * progress.fraction;
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      className={cn("shrink-0 -rotate-90", progress.state === "reached" ? "text-success" : progress.state === "exceeded" ? "text-warning" : "text-accent", className)}
      data-testid="goal-ring"
      data-state={progress.state}
      aria-hidden
    >
      <circle cx={8} cy={8} r={r} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={2.5} />
      <circle cx={8} cy={8} r={r} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeDasharray={`${dash} ${c - dash}`} />
    </svg>
  );
}

function minutesLabel(m: number): string {
  return m === 0 ? "0 min" : m < 1 ? "< 1 min" : `${formatNumber(m)} min`;
}

const ROWS: { key: keyof DocStats; label: string; format?: (v: number) => string }[] = [
  { key: "words", label: "Words" },
  { key: "characters", label: "Characters" },
  { key: "charactersNoSpaces", label: "Characters (no spaces)" },
  { key: "sentences", label: "Sentences" },
  { key: "paragraphs", label: "Paragraphs" },
  { key: "headings", label: "Headings" },
  { key: "readingMinutes", label: "Reading time", format: minutesLabel },
  { key: "speakingMinutes", label: "Speaking time", format: minutesLabel },
];

export function describeGoal(goal: WritingGoal, progress: GoalProgress): string {
  const unit = goal.kind === "words" ? "words" : "min read";
  return `${formatNumber(progress.current)} / ${formatNumber(progress.target)} ${unit}`;
}

export interface StatsPopoverProps {
  session: CollabSession;
  /** Markdown source the stats are computed from. */
  source: string;
  selection: SourceSelection;
  /** False during server render / before hydration: show placeholders so markup matches. */
  hydrated: boolean;
}

type StatsLayoutDomain = "trigger" | "portal";
type StatsElementRole = "trigger" | "content";
type StatsRetirement = "layout" | "ref" | "mutation" | "drift" | "other";
type StatsOwnerWindow = Window & typeof globalThis;

interface StatsDisclosureMount {
  readonly identity: symbol;
}

interface StatsDisclosureVisit {
  readonly identity: symbol;
  readonly revision: number;
  readonly mount: StatsDisclosureMount;
  readonly session: CollabSession;
  readonly docId: string;
  readonly ydoc: Y.Doc;
  readonly ytext: Y.Text;
  readonly role: CollabSession["role"];
  readonly claimedEvents: WeakSet<object>;
  retired: boolean;
}

interface StatsDisclosureAuthority {
  readonly identity: symbol;
  readonly visit: StatsDisclosureVisit;
  readonly claimedEvents: WeakSet<object>;
  retired: boolean;
}

interface StatsDisclosureState {
  readonly visit: StatsDisclosureVisit;
  readonly authority: StatsDisclosureAuthority | null;
  readonly open: boolean;
}

type StatsSnapshot = DocStats & { stats: DocStats };
type GoalSnapshot = {
  goal: WritingGoal | null;
  kind: GoalKind | null;
  mode: GoalMode | null;
  value: number | null;
  setBy: string | null;
  setAt: number | null;
};
type ProgressSnapshot = {
  progress: GoalProgress | null;
  current: number | null;
  target: number | null;
  fraction: number | null;
  state: GoalProgress["state"] | null;
};

interface GoalDraft {
  session: CollabSession;
  sharedGoal: WritingGoal | null;
  kind: GoalKind;
  mode: GoalMode;
  value: string;
}

interface GoalPresentation {
  session: CollabSession;
  sharedGoal: GoalSnapshot;
  progress: ProgressSnapshot;
  canEdit: boolean;
  draft: GoalDraft;
  kind: GoalKind;
  mode: GoalMode;
  value: string;
  setBy: string | null;
  setDisabled: boolean;
}

interface GoalElementSlot<T extends HTMLElement> {
  expected: T | null;
  connection: { element: T } | null;
}

interface GoalGeneration {
  presentation: GoalPresentation;
  form: GoalElementSlot<HTMLFormElement>;
  modeSelect: GoalElementSlot<HTMLSelectElement>;
  valueInput: GoalElementSlot<HTMLInputElement>;
  kindSelect: GoalElementSlot<HTMLSelectElement>;
  setButton: GoalElementSlot<HTMLButtonElement>;
  clearButton: GoalElementSlot<HTMLButtonElement>;
}

interface GoalPublication {
  generation: GoalGeneration;
  presentation: GoalPresentation;
  form: HTMLFormElement;
  modeSelect: HTMLSelectElement;
  modeMinOption: HTMLOptionElement;
  modeMaxOption: HTMLOptionElement;
  valueInput: HTMLInputElement;
  kindSelect: HTMLSelectElement;
  kindWordsOption: HTMLOptionElement;
  kindMinutesOption: HTMLOptionElement;
  actions: HTMLSpanElement;
  setButton: HTMLButtonElement;
  clearButton: HTMLButtonElement | null;
  claimed: boolean;
  retired: boolean;
}

type StatsGoalActionNavigationKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";

type StatsGoalControlKey =
  | "mode"
  | "value"
  | "kind"
  | "set"
  | "clear";

interface StatsGoalControlIdentity {
  readonly identity: symbol;
  readonly key: StatsGoalControlKey;
  readonly testId:
    | "goal-mode"
    | "goal-value"
    | "goal-kind"
    | "goal-set"
    | "goal-clear";
  readonly tagName: "SELECT" | "INPUT" | "BUTTON";
  readonly enabled: boolean;
  readonly order: number;
}

interface StatsGoalControlConnection {
  readonly identity: symbol;
  readonly controlIdentity: StatsGoalControlIdentity;
  readonly element: HTMLElement;
  claimed: boolean;
}

interface StatsDisclosureRender {
  visit: StatsDisclosureVisit;
  state: StatsDisclosureState;
  authority: StatsDisclosureAuthority | null;
  session: CollabSession;
  source: string;
  selection: SourceSelection;
  selectionFrom: number | null;
  selectionTo: number | null;
  hydrated: boolean;
  stats: StatsSnapshot;
  selectionStats: StatsSnapshot | null;
  goal: GoalSnapshot;
  canEdit: boolean;
  mode: CollabSession["mode"];
  progress: ProgressSnapshot;
  open: boolean;
  shortcutLabel: string;
  triggerTitle: string;
  triggerLabel: string;
  selectionLabel: string | null;
  goalPresentation: GoalPresentation;
  goalControls: readonly StatsGoalControlIdentity[];
  setDraft: Dispatch<SetStateAction<GoalDraft>>;
  commitState: (
    expected: StatsDisclosureState,
    next: StatsDisclosureState,
  ) => void;
}

interface StatsDisclosurePublication {
  identity: symbol;
  render: StatsDisclosureRender;
  elements: {
    trigger: HTMLButtonElement | null;
    content: HTMLDivElement | null;
  };
  connections: {
    trigger: StatsElementConnection<HTMLButtonElement> | null;
    content: StatsElementConnection<HTMLDivElement> | null;
  };
  goalControls: Map<StatsGoalControlIdentity, StatsGoalControlConnection>;
  reactWrapperAuthority: StatsReactWrapperAuthority | null;
  established: boolean;
  retired: boolean;
  retirement: StatsRetirement | null;
  consumed: boolean;
  successorRequested: boolean;
  visitSuccessorRequested: boolean;
  layoutEstablished: Set<StatsLayoutDomain>;
  layoutRetired: Set<StatsLayoutDomain>;
  invalidReplay: Set<StatsLayoutDomain>;
  replayRefs: StatsRefReplay[];
  triggerDom: StatsDomSnapshot | null;
  triggerPlacement: StatsPlacement | null;
  contentDom: StatsDomSnapshot | null;
  contentPlacement: StatsPlacement | null;
  focusDestination: HTMLElement | null;
  guard: StatsDomGuard | null;
  requestSuccessor: (replaceVisit: boolean) => void;
  current: StatsDisclosureCurrent;
}

interface StatsElementConnection<T extends HTMLElement> {
  readonly identity: symbol;
  readonly element: T;
}

interface StatsElementOwner {
  readonly publication: StatsDisclosurePublication;
  readonly publicationIdentity: symbol;
  readonly role: StatsElementRole;
  readonly connectionIdentity: symbol;
}

interface StatsRefReplay {
  readonly role: StatsElementRole | "goal";
  readonly goalIdentity: StatsGoalControlIdentity | null;
  readonly domain: StatsLayoutDomain;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface StatsDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly StatsDomSnapshot[];
}

interface StatsPlacementEntry {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
}

interface StatsPlacement {
  readonly document: Document;
  readonly entries: readonly StatsPlacementEntry[];
}

interface StatsDomGuard {
  readonly isClean: () => boolean;
  readonly deactivate: () => void;
  readonly release: () => void;
}

interface StatsReplay {
  readonly source: StatsDisclosurePublication;
  readonly triggerDom: StatsDomSnapshot;
  readonly triggerPlacement: StatsPlacement;
  readonly contentDom: StatsDomSnapshot | null;
  readonly contentPlacement: StatsPlacement | null;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface StatsNativeProvenance {
  readonly publication: StatsDisclosurePublication;
  readonly event: Event;
  readonly kind: "click" | "keydown" | "pointerdown" | "focusin";
  readonly document: Document;
  readonly ownerWindow: Window;
  timeoutId: number;
}

interface StatsPointerProvenance extends StatsNativeProvenance {
  readonly kind: "pointerdown";
  readonly pointerDown: StatsPointerEventProof;
  pointerUp: StatsPointerEventProof | null;
  click: StatsPointerEventProof | null;
  expiresAt: number;
}

interface StatsPointerEventProof {
  readonly event: PointerEvent;
  readonly type: "pointerdown" | "pointerup" | "click";
  readonly target: Node;
  readonly path: readonly EventTarget[];
  readonly phase: number;
  readonly timeStamp: number;
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  readonly detail: number;
}

type StatsWindowKeyListener = (
  this: EventTarget,
  event: KeyboardEvent,
) => void;

interface StatsWindowKeyRegistration {
  readonly identity: symbol;
  readonly document: Document;
  readonly target: StatsOwnerWindow;
  readonly keyboardAuthority: StatsKeyboardAuthority;
  readonly listener: StatsWindowKeyListener;
  readonly addEventListener: Window["addEventListener"];
  readonly removeEventListener: Window["removeEventListener"];
  active: boolean;
  removed: boolean;
}

interface StatsNativeCapture {
  readonly document: Document;
  readonly ownerWindow: StatsOwnerWindow;
  readonly keyboardAuthority: StatsKeyboardAuthority;
  readonly windowKeyRegistration: StatsWindowKeyRegistration;
  readonly remove: VoidFunction;
}

interface StatsDisclosureProof {
  readonly publication: StatsDisclosurePublication;
  readonly authority: StatsDisclosureAuthority;
  readonly nextOpen: boolean;
  readonly source:
    | "trigger"
    | "shortcut"
    | "directional"
    | "escape"
    | "pointer"
    | "focus";
  readonly event: object;
  readonly nativeEvent: Event;
  readonly ownerWindow: Window;
  timeoutId: number;
}

interface StatsOpenFocus {
  readonly visit: StatsDisclosureVisit;
  readonly authority: StatsDisclosureAuthority;
  readonly directional: StatsDirectionalFocusIntent | null;
}

interface StatsCloseFocus {
  readonly publication: StatsDisclosurePublication;
  readonly visit: StatsDisclosureVisit;
  readonly authority: StatsDisclosureAuthority;
  readonly source: StatsDisclosureProof["source"];
  readonly trigger: HTMLButtonElement;
  expected: StatsDisclosurePublication | null;
  claimed: boolean;
}

type StatsFocusDirection = "first" | "last";

interface StatsIntrinsicGetter<T> {
  read: (target: object) => T;
  isCurrent: () => boolean;
}

interface StatsIntrinsicMethod<Args extends readonly unknown[], Result> {
  call: (target: object, ...args: Args) => Result;
  isCurrent: () => boolean;
}

interface StatsWindowMethodAuthority<Method> {
  readonly value: Method;
  readonly isCurrent: () => boolean;
}

interface StatsTrustAuthority {
  matches: (event: object) => boolean;
  read: (event: object) => boolean;
  isCurrent: () => boolean;
}

interface StatsKeyboardAuthority {
  ownerWindow: StatsOwnerWindow;
  eventPrototype: Event;
  keyboardPrototype: KeyboardEvent;
  customEventPrototype: CustomEvent;
  documentPrototype: Document;
  htmlElementPrototype: HTMLElement;
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor;
  getPrototypeOf: typeof Object.getPrototypeOf;
  apply: typeof Reflect.apply;
  eventType: StatsIntrinsicGetter<string>;
  eventTarget: StatsIntrinsicGetter<EventTarget | null>;
  eventCurrentTarget: StatsIntrinsicGetter<EventTarget | null>;
  eventPhase: StatsIntrinsicGetter<number>;
  eventBubbles: StatsIntrinsicGetter<boolean>;
  eventCancelable: StatsIntrinsicGetter<boolean>;
  eventComposed: StatsIntrinsicGetter<boolean>;
  eventDefaultPrevented: StatsIntrinsicGetter<boolean>;
  eventCancelBubble: StatsIntrinsicGetter<boolean>;
  eventTimeStamp: StatsIntrinsicGetter<number>;
  eventPath: StatsIntrinsicMethod<readonly [], EventTarget[]>;
  eventPreventDefault: StatsIntrinsicMethod<readonly [], void>;
  eventStopPropagation: StatsIntrinsicMethod<readonly [], void>;
  eventStopImmediatePropagation: StatsIntrinsicMethod<readonly [], void>;
  eventView: StatsIntrinsicGetter<Window | null>;
  keyboardKey: StatsIntrinsicGetter<string>;
  keyboardCode: StatsIntrinsicGetter<string>;
  keyboardLocation: StatsIntrinsicGetter<number>;
  keyboardCtrl: StatsIntrinsicGetter<boolean>;
  keyboardMeta: StatsIntrinsicGetter<boolean>;
  keyboardAlt: StatsIntrinsicGetter<boolean>;
  keyboardShift: StatsIntrinsicGetter<boolean>;
  keyboardRepeat: StatsIntrinsicGetter<boolean>;
  keyboardComposing: StatsIntrinsicGetter<boolean>;
  activeElement: StatsIntrinsicGetter<Element | null>;
  focus: StatsIntrinsicMethod<readonly [FocusOptions?], void>;
  addEventListener: StatsWindowMethodAuthority<Window["addEventListener"]>;
  removeEventListener: StatsWindowMethodAuthority<
    Window["removeEventListener"]
  >;
  isTrusted: StatsTrustAuthority;
  isCurrent: () => boolean;
}

interface StatsDirectionalNativeEvent {
  readonly publication: StatsDisclosurePublication;
  readonly event: KeyboardEvent;
  readonly keyboardAuthority: StatsKeyboardAuthority;
  readonly ownerDocument: Document;
  readonly ownerWindow: StatsOwnerWindow;
  readonly listener: StatsDirectionalListenerProof;
  readonly type: string;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  readonly intrinsicCurrentTarget: EventTarget | null;
  readonly path: readonly EventTarget[];
  readonly phase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly composed: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly trusted: boolean;
  readonly timeStamp: number;
  readonly view: Window | null | undefined;
  readonly intrinsicView: Window | null;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly composing: boolean;
  claimed: boolean;
}

interface StatsDirectionalListenerProof {
  readonly registration: StatsWindowKeyRegistration;
  readonly publication: StatsDisclosurePublication;
  readonly listener: StatsWindowKeyListener;
  readonly event: KeyboardEvent;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly intrinsicCurrentTarget: EventTarget;
  readonly terminal: EventTarget;
  claimed: boolean;
}

interface StatsDirectionalReactEvent {
  readonly event: ReactKeyboardEvent<HTMLButtonElement>;
  readonly native: StatsDirectionalNativeEvent;
  readonly boundary: "capture" | "bubble";
  readonly currentTarget: EventTarget | null;
  readonly target: EventTarget | null;
  readonly type: string;
  readonly phase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly trusted: boolean;
  readonly timeStamp: number;
  readonly view: ReactKeyboardEvent<HTMLButtonElement>["view"];
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly composing: boolean | undefined;
  readonly preventDefault: ReactKeyboardEvent<HTMLButtonElement>["preventDefault"];
  readonly stopPropagation: ReactKeyboardEvent<HTMLButtonElement>["stopPropagation"];
  readonly isDefaultPrevented: ReactKeyboardEvent<HTMLButtonElement>["isDefaultPrevented"];
  readonly isPropagationStopped: ReactKeyboardEvent<HTMLButtonElement>["isPropagationStopped"];
  claimed: boolean;
}

interface StatsReactWrapperMethodSeal {
  readonly property:
    | "preventDefault"
    | "stopPropagation"
    | "isDefaultPrevented"
    | "isPropagationStopped";
  readonly owner: object;
  readonly depth: number;
  readonly descriptor: PropertyDescriptor;
}

interface StatsReactWrapperAuthority {
  readonly isCurrent: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => boolean;
}

interface StatsDirectionalFocusIntent {
  readonly publication: StatsDisclosurePublication;
  readonly visit: StatsDisclosureVisit;
  readonly authority: StatsDisclosureAuthority;
  readonly direction: StatsFocusDirection;
  readonly destination: StatsGoalControlIdentity;
  readonly native: StatsDirectionalNativeEvent;
  readonly capture: StatsDirectionalReactEvent;
  readonly bubble: StatsDirectionalReactEvent;
  readonly keyboardAuthority: StatsKeyboardAuthority;
  readonly trigger: HTMLButtonElement;
  readonly ownerDocument: Document;
  readonly ownerWindow: StatsOwnerWindow;
  claimed: boolean;
}

interface StatsGoalActionReactMethods {
  readonly preventDefault: ReactKeyboardEvent<HTMLElement>["preventDefault"];
  readonly isDefaultPrevented: ReactKeyboardEvent<HTMLElement>["isDefaultPrevented"];
  readonly isPropagationStopped: ReactKeyboardEvent<HTMLElement>["isPropagationStopped"];
}

interface StatsGoalActionDelivery {
  readonly disclosure: StatsDisclosurePublication;
  readonly goal: GoalPublication;
  readonly wrapper: ReactKeyboardEvent<HTMLElement>;
  readonly methods: StatsGoalActionReactMethods;
  readonly native: StatsDirectionalNativeEvent;
  readonly currentTarget: HTMLElement;
  readonly dispatchTarget: EventTarget;
  readonly source: HTMLButtonElement;
  readonly sourceIdentity: StatsGoalControlIdentity;
  readonly key: StatsGoalActionNavigationKey;
  readonly type: string;
  readonly phase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly trusted: boolean;
  readonly view: ReactKeyboardEvent<HTMLElement>["view"];
  readonly code: string;
  readonly location: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly composing: boolean | undefined;
}

interface StatsGoalActionMovement {
  readonly identity: symbol;
  readonly disclosure: StatsDisclosurePublication;
  readonly goal: GoalPublication;
  readonly key: StatsGoalActionNavigationKey;
  readonly source: StatsGoalControlIdentity;
  readonly destination: StatsGoalControlIdentity;
}

interface StatsGoalActionClaim {
  readonly movement: StatsGoalActionMovement;
  readonly native: StatsDirectionalNativeEvent;
  readonly groupCapture: StatsGoalActionDelivery;
  readonly actionCapture: StatsGoalActionDelivery;
  readonly actionBubble: StatsGoalActionDelivery;
  readonly groupBubble: StatsGoalActionDelivery;
  readonly source: StatsGoalControlConnection;
  readonly destination: StatsGoalControlConnection;
}

const STATS_RESPONSIVE_TRIGGER_ATTRIBUTES = new Set([
  "data-radix-popper-align",
  "data-radix-popper-side",
]);
const STATS_RESPONSIVE_CONTENT_ATTRIBUTES = new Set([
  "data-align",
  "data-side",
  "style",
]);
const STATS_POINTER_CALLBACK_LEASE_MS = 1_000;
const STATS_POINTER_GESTURE_LEASE_MS = 5_000;

function statsDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  return Boolean(
    current &&
      current.configurable === expected.configurable &&
      current.enumerable === expected.enumerable &&
      current.get === expected.get &&
      current.set === expected.set &&
      current.value === expected.value &&
      current.writable === expected.writable
  );
}

function captureStatsKeyboardAuthority(
  ownerWindow: StatsOwnerWindow,
): StatsKeyboardAuthority | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const eventPrototype = ownerWindow.Event.prototype;
  const keyboardPrototype = ownerWindow.KeyboardEvent.prototype;
  const customEventPrototype = ownerWindow.CustomEvent.prototype;
  const documentPrototype = ownerWindow.Document.prototype;
  const htmlElementPrototype = ownerWindow.HTMLElement.prototype;
  const prototypeLinks: (readonly [object, object | null])[] = [];
  const authorities: { isCurrent: () => boolean }[] = [];
  const capturedPrototypes = new Set<object>();
  let stale = false;
  const retainCurrent = (current: boolean) => {
    if (!current) stale = true;
    return !stale;
  };
  const capturePrototypeChain = (prototype: object) => {
    let current: object | null = prototype;
    while (current && !capturedPrototypes.has(current)) {
      capturedPrototypes.add(current);
      const parent = getPrototypeOf(current) as object | null;
      prototypeLinks.push([current, parent]);
      current = parent;
    }
  };
  [
    keyboardPrototype,
    customEventPrototype,
    eventPrototype,
    documentPrototype,
    htmlElementPrototype,
  ].forEach(capturePrototypeChain);

  const captureGetter = <T,>(
    prototype: object,
    property: PropertyKey,
  ): StatsIntrinsicGetter<T> | null => {
    let current: object | null = prototype;
    while (current) {
      const descriptor = getOwnPropertyDescriptor(current, property);
      if (descriptor) {
        if (typeof descriptor.get !== "function") return null;
        const owner = current;
        const expected = Object.freeze({ ...descriptor });
        const getter = descriptor.get;
        const authority = Object.freeze({
          read: (target: object) => apply(getter, target, []) as T,
          isCurrent: () =>
            retainCurrent(
              statsDescriptorsMatch(
                getOwnPropertyDescriptor(owner, property),
                expected,
              ),
            ),
        });
        authorities.push(authority);
        return authority;
      }
      current = getPrototypeOf(current) as object | null;
    }
    return null;
  };

  const captureMethod = <Args extends readonly unknown[], Result>(
    prototype: object,
    property: PropertyKey,
  ): StatsIntrinsicMethod<Args, Result> | null => {
    let current: object | null = prototype;
    while (current) {
      const descriptor = getOwnPropertyDescriptor(current, property);
      if (descriptor) {
        if (typeof descriptor.value !== "function") return null;
        const owner = current;
        const expected = Object.freeze({ ...descriptor });
        const method = descriptor.value as (...args: Args) => Result;
        const authority = Object.freeze({
          call: (target: object, ...args: Args) =>
            apply(method, target, args) as Result,
          isCurrent: () =>
            retainCurrent(
              statsDescriptorsMatch(
                getOwnPropertyDescriptor(owner, property),
                expected,
              ),
            ),
        });
        authorities.push(authority);
        return authority;
      }
      current = getPrototypeOf(current) as object | null;
    }
    return null;
  };
  const captureWindowMethod = <
    Property extends "addEventListener" | "removeEventListener",
  >(
    property: Property,
  ): StatsWindowMethodAuthority<Window[Property]> | null => {
    const value = ownerWindow[property];
    if (typeof value !== "function") return null;
    let current = true;
    const isCurrent = () => {
      if (!current) return false;
      try {
        current = ownerWindow[property] === value;
      } catch {
        current = false;
      }
      return current;
    };
    return isCurrent() ? Object.freeze({ value, isCurrent }) : null;
  };

  const eventType = captureGetter<string>(eventPrototype, "type");
  const eventTarget = captureGetter<EventTarget | null>(
    eventPrototype,
    "target",
  );
  const eventCurrentTarget = captureGetter<EventTarget | null>(
    eventPrototype,
    "currentTarget",
  );
  const eventPhase = captureGetter<number>(eventPrototype, "eventPhase");
  const eventBubbles = captureGetter<boolean>(eventPrototype, "bubbles");
  const eventCancelable = captureGetter<boolean>(
    eventPrototype,
    "cancelable",
  );
  const eventComposed = captureGetter<boolean>(eventPrototype, "composed");
  const eventDefaultPrevented = captureGetter<boolean>(
    eventPrototype,
    "defaultPrevented",
  );
  const eventCancelBubble = captureGetter<boolean>(
    eventPrototype,
    "cancelBubble",
  );
  const eventTimeStamp = captureGetter<number>(
    eventPrototype,
    "timeStamp",
  );
  const eventPath = captureMethod<readonly [], EventTarget[]>(
    eventPrototype,
    "composedPath",
  );
  const eventPreventDefault = captureMethod<readonly [], void>(
    eventPrototype,
    "preventDefault",
  );
  const eventStopPropagation = captureMethod<readonly [], void>(
    eventPrototype,
    "stopPropagation",
  );
  const eventStopImmediatePropagation = captureMethod<readonly [], void>(
    eventPrototype,
    "stopImmediatePropagation",
  );
  const eventView = captureGetter<Window | null>(
    ownerWindow.UIEvent.prototype,
    "view",
  );
  const keyboardKey = captureGetter<string>(keyboardPrototype, "key");
  const keyboardCode = captureGetter<string>(keyboardPrototype, "code");
  const keyboardLocation = captureGetter<number>(
    keyboardPrototype,
    "location",
  );
  const keyboardCtrl = captureGetter<boolean>(
    keyboardPrototype,
    "ctrlKey",
  );
  const keyboardMeta = captureGetter<boolean>(
    keyboardPrototype,
    "metaKey",
  );
  const keyboardAlt = captureGetter<boolean>(keyboardPrototype, "altKey");
  const keyboardShift = captureGetter<boolean>(
    keyboardPrototype,
    "shiftKey",
  );
  const keyboardRepeat = captureGetter<boolean>(
    keyboardPrototype,
    "repeat",
  );
  const keyboardComposing = captureGetter<boolean>(
    keyboardPrototype,
    "isComposing",
  );
  const activeElement = captureGetter<Element | null>(
    documentPrototype,
    "activeElement",
  );
  const focus = captureMethod<readonly [FocusOptions?], void>(
    htmlElementPrototype,
    "focus",
  );
  const addEventListener = captureWindowMethod("addEventListener");
  const removeEventListener = captureWindowMethod("removeEventListener");

  const trustProbe = new ownerWindow.KeyboardEvent(
    "stats-keyboard-intrinsic",
  );
  const trustDescriptor = getOwnPropertyDescriptor(
    trustProbe,
    "isTrusted",
  );
  if (
    !trustDescriptor ||
    trustDescriptor.configurable !== false ||
    typeof trustDescriptor.get !== "function" ||
    trustDescriptor.set !== undefined
  ) {
    return null;
  }
  const expectedTrustDescriptor = Object.freeze({ ...trustDescriptor });
  const isTrusted = Object.freeze({
    matches: (event: object) =>
      statsDescriptorsMatch(
        getOwnPropertyDescriptor(event, "isTrusted"),
        expectedTrustDescriptor,
      ),
    read: (event: object) =>
      apply(
        trustDescriptor.get as (this: object) => boolean,
        event,
        [],
      ) as boolean,
    isCurrent: () =>
      retainCurrent(
        statsDescriptorsMatch(
          getOwnPropertyDescriptor(trustProbe, "isTrusted"),
          expectedTrustDescriptor,
        ),
      ),
  });

  if (
    !eventType ||
    !eventTarget ||
    !eventCurrentTarget ||
    !eventPhase ||
    !eventBubbles ||
    !eventCancelable ||
    !eventComposed ||
    !eventDefaultPrevented ||
    !eventCancelBubble ||
    !eventTimeStamp ||
    !eventPath ||
    !eventPreventDefault ||
    !eventStopPropagation ||
    !eventStopImmediatePropagation ||
    !eventView ||
    !keyboardKey ||
    !keyboardCode ||
    !keyboardLocation ||
    !keyboardCtrl ||
    !keyboardMeta ||
    !keyboardAlt ||
    !keyboardShift ||
    !keyboardRepeat ||
    !keyboardComposing ||
    !activeElement ||
    !focus ||
    !addEventListener ||
    !removeEventListener
  ) {
    return null;
  }

  const isCurrent = () => {
    if (stale) return false;
    return retainCurrent(
      ownerWindow.Object.getOwnPropertyDescriptor ===
        getOwnPropertyDescriptor &&
        ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
        ownerWindow.Reflect.apply === apply &&
        ownerWindow.Event.prototype === eventPrototype &&
        ownerWindow.KeyboardEvent.prototype === keyboardPrototype &&
        ownerWindow.CustomEvent.prototype === customEventPrototype &&
        ownerWindow.Document.prototype === documentPrototype &&
        ownerWindow.HTMLElement.prototype === htmlElementPrototype &&
        prototypeLinks.every(
          ([prototype, parent]) => getPrototypeOf(prototype) === parent,
        ) &&
        addEventListener.isCurrent() &&
        removeEventListener.isCurrent() &&
        isTrusted.isCurrent() &&
        authorities.every((authority) => authority.isCurrent()),
    );
  };

  return Object.freeze({
    ownerWindow,
    eventPrototype,
    keyboardPrototype,
    customEventPrototype,
    documentPrototype,
    htmlElementPrototype,
    getOwnPropertyDescriptor,
    getPrototypeOf,
    apply,
    eventType,
    eventTarget,
    eventCurrentTarget,
    eventPhase,
    eventBubbles,
    eventCancelable,
    eventComposed,
    eventDefaultPrevented,
    eventCancelBubble,
    eventTimeStamp,
    eventPath,
    eventPreventDefault,
    eventStopPropagation,
    eventStopImmediatePropagation,
    eventView,
    keyboardKey,
    keyboardCode,
    keyboardLocation,
    keyboardCtrl,
    keyboardMeta,
    keyboardAlt,
    keyboardShift,
    keyboardRepeat,
    keyboardComposing,
    activeElement,
    focus,
    addEventListener,
    removeEventListener,
    isTrusted,
    isCurrent,
  });
}

function captureStatsReactWrapperAuthority(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  keyboardAuthority: StatsKeyboardAuthority,
): StatsReactWrapperAuthority | null {
  const { getOwnPropertyDescriptor, getPrototypeOf } =
    keyboardAuthority;
  const properties: StatsReactWrapperMethodSeal["property"][] = [
    "preventDefault",
    "stopPropagation",
    "isDefaultPrevented",
    "isPropagationStopped",
  ];
  const seals: StatsReactWrapperMethodSeal[] = [];
  for (const property of properties) {
    let owner: object | null = event;
    let depth = 0;
    let descriptor: PropertyDescriptor | undefined;
    while (owner && !descriptor) {
      descriptor = getOwnPropertyDescriptor(owner, property);
      if (!descriptor) {
        owner = getPrototypeOf(owner) as object | null;
        depth += 1;
      }
    }
    if (
      !owner ||
      !descriptor ||
      typeof descriptor.value !== "function" ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return null;
    }
    seals.push(
      Object.freeze({
        property,
        owner,
        depth,
        descriptor: Object.freeze({ ...descriptor }),
      }),
    );
  }
  const wrapperPrototype = getPrototypeOf(event);
  const prototypeLinks: (readonly [object, object | null])[] = [];
  let current = wrapperPrototype as object | null;
  while (current) {
    const parent = getPrototypeOf(current) as object | null;
    prototypeLinks.push([current, parent]);
    current = parent;
  }
  let stale = false;
  const descriptorAtDepth = (
    candidate: object,
    depth: number,
  ): object | null => {
    let owner: object | null = candidate;
    for (let index = 0; index < depth && owner; index += 1) {
      owner = getPrototypeOf(owner) as object | null;
    }
    return owner;
  };
  return Object.freeze({
    isCurrent: (
      candidate: ReactKeyboardEvent<HTMLButtonElement>,
    ) => {
      if (stale) return false;
      const current =
        keyboardAuthority.isCurrent() &&
        getPrototypeOf(candidate) === wrapperPrototype &&
        prototypeLinks.every(
          ([prototype, parent]) =>
            getPrototypeOf(prototype) === parent,
        ) &&
        seals.every((seal) => {
          const owner = descriptorAtDepth(candidate, seal.depth);
          return Boolean(
            owner &&
              statsDescriptorsMatch(
                getOwnPropertyDescriptor(
                  seal.owner,
                  seal.property,
                ),
                seal.descriptor,
              ) &&
              statsDescriptorsMatch(
                getOwnPropertyDescriptor(owner, seal.property),
                seal.descriptor,
              ) &&
              candidate[seal.property] === seal.descriptor.value,
          );
        });
      if (!current) stale = true;
      return !stale;
    },
  });
}

function statsSnapshot(stats: DocStats): StatsSnapshot {
  return Object.freeze({ stats, ...stats });
}

function statsSnapshotIsExact(snapshot: StatsSnapshot): boolean {
  const stats = snapshot.stats;
  return (
    stats.words === snapshot.words &&
    stats.characters === snapshot.characters &&
    stats.charactersNoSpaces === snapshot.charactersNoSpaces &&
    stats.sentences === snapshot.sentences &&
    stats.paragraphs === snapshot.paragraphs &&
    stats.headings === snapshot.headings &&
    stats.readingMinutes === snapshot.readingMinutes &&
    stats.speakingMinutes === snapshot.speakingMinutes
  );
}

function goalSnapshot(goal: WritingGoal | null): GoalSnapshot {
  return Object.freeze({
    goal,
    kind: goal?.kind ?? null,
    mode: goal?.mode ?? null,
    value: goal?.value ?? null,
    setBy: goal?.setBy ?? null,
    setAt: goal?.setAt ?? null,
  });
}

function goalSnapshotIsExact(snapshot: GoalSnapshot): boolean {
  const goal = snapshot.goal;
  return goal
    ? goal.kind === snapshot.kind &&
        goal.mode === snapshot.mode &&
        goal.value === snapshot.value &&
        goal.setBy === snapshot.setBy &&
        goal.setAt === snapshot.setAt
    : snapshot.kind === null &&
        snapshot.mode === null &&
        snapshot.value === null &&
        snapshot.setBy === null &&
        snapshot.setAt === null;
}

function goalMatchesSnapshot(goal: WritingGoal | null, snapshot: GoalSnapshot): boolean {
  return goal
    ? goal.kind === snapshot.kind &&
        goal.mode === snapshot.mode &&
        goal.value === snapshot.value &&
        goal.setBy === snapshot.setBy &&
        goal.setAt === snapshot.setAt
    : snapshot.kind === null &&
        snapshot.mode === null &&
        snapshot.value === null &&
        snapshot.setBy === null &&
        snapshot.setAt === null;
}

function progressSnapshot(progress: GoalProgress | null): ProgressSnapshot {
  return Object.freeze({
    progress,
    current: progress?.current ?? null,
    target: progress?.target ?? null,
    fraction: progress?.fraction ?? null,
    state: progress?.state ?? null,
  });
}

function progressSnapshotIsExact(snapshot: ProgressSnapshot): boolean {
  const progress = snapshot.progress;
  return progress
    ? progress.current === snapshot.current &&
        progress.target === snapshot.target &&
        progress.fraction === snapshot.fraction &&
        progress.state === snapshot.state
    : snapshot.current === null &&
        snapshot.target === null &&
        snapshot.fraction === null &&
        snapshot.state === null;
}

function goalControlIdentities(
  canEdit: boolean,
  setDisabled: boolean,
  hasGoal: boolean,
): readonly StatsGoalControlIdentity[] {
  if (!canEdit) return Object.freeze([]);
  const values: readonly Omit<
    StatsGoalControlIdentity,
    "identity" | "order"
  >[] = [
    {
      key: "mode",
      testId: "goal-mode",
      tagName: "SELECT",
      enabled: true,
    },
    {
      key: "value",
      testId: "goal-value",
      tagName: "INPUT",
      enabled: true,
    },
    {
      key: "kind",
      testId: "goal-kind",
      tagName: "SELECT",
      enabled: true,
    },
    {
      key: "set",
      testId: "goal-set",
      tagName: "BUTTON",
      enabled: !setDisabled,
    },
    ...(hasGoal
      ? [
          {
            key: "clear" as const,
            testId: "goal-clear" as const,
            tagName: "BUTTON" as const,
            enabled: true,
          },
        ]
      : []),
  ];
  return Object.freeze(
    values.map((value, order) =>
      Object.freeze({
        identity: Symbol(`stats-goal-${value.key}`),
        order,
        ...value,
      }),
    ),
  );
}

function goalControlIdentitiesAreExact(render: StatsDisclosureRender) {
  const identities = render.goalControls;
  const presentation = render.goalPresentation;
  const expected: readonly (readonly [
    StatsGoalControlKey,
    StatsGoalControlIdentity["testId"],
    StatsGoalControlIdentity["tagName"],
    boolean,
  ])[] = presentation.canEdit
    ? [
        ["mode", "goal-mode", "SELECT", true],
        ["value", "goal-value", "INPUT", true],
        ["kind", "goal-kind", "SELECT", true],
        ["set", "goal-set", "BUTTON", !presentation.setDisabled],
        ...(presentation.sharedGoal.goal
          ? [
              [
                "clear",
                "goal-clear",
                "BUTTON",
                true,
              ] as const,
            ]
          : []),
      ]
    : [];
  return (
    Object.isFrozen(identities) &&
    new Set(identities).size === identities.length &&
    new Set(identities.map(({ identity }) => identity)).size ===
      identities.length &&
    identities.length === expected.length &&
    identities.every(
      (identity, index) =>
        Object.isFrozen(identity) &&
        identity.order === index &&
        identity.key === expected[index]?.[0] &&
        identity.testId === expected[index]?.[1] &&
        identity.tagName === expected[index]?.[2] &&
        identity.enabled === expected[index]?.[3],
    )
  );
}

function goalPresentationIsExact(presentation: GoalPresentation): boolean {
  const draft = presentation.draft;
  return (
    goalSnapshotIsExact(presentation.sharedGoal) &&
    goalMatchesSnapshot(getGoal(presentation.session), presentation.sharedGoal) &&
    progressSnapshotIsExact(presentation.progress) &&
    presentation.session.canEdit === presentation.canEdit &&
    presentation.session.user.login === presentation.setBy &&
    draft.session === presentation.session &&
    draft.sharedGoal === presentation.sharedGoal.goal &&
    draft.kind === presentation.kind &&
    draft.mode === presentation.mode &&
    draft.value === presentation.value &&
    presentation.setDisabled === !(Number(presentation.value) > 0)
  );
}

function snapshotStatsAttributes(
  node: Node,
): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  return Object.freeze(
    [...element.attributes]
      .filter(
        ({ name }) =>
          !(
            element.getAttribute("data-testid") === "stats-button" &&
            STATS_RESPONSIVE_TRIGGER_ATTRIBUTES.has(name)
          ) &&
          !(
            element.getAttribute("data-testid") === "stats-popover" &&
            STATS_RESPONSIVE_CONTENT_ATTRIBUTES.has(name)
          ) &&
          !(
            element.hasAttribute(
              "data-radix-popper-content-wrapper",
            ) &&
            name === "style"
          ),
      )
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotStatsDom(node: Node): StatsDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotStatsAttributes(node),
    children: Object.freeze(
      [...node.childNodes].map((child) => snapshotStatsDom(child)),
    ),
  });
}

function statsAttributesMatch(
  node: Node,
  expected: readonly (readonly [string, string])[] | null,
) {
  const current = snapshotStatsAttributes(node);
  if (current === null || expected === null) return current === expected;
  return (
    current.length === expected.length &&
    current.every(
      ([name, value], index) =>
        expected[index]?.[0] === name && expected[index]?.[1] === value,
    )
  );
}

function statsDomMatches(snapshot: StatsDomSnapshot): boolean {
  const { node } = snapshot;
  return (
    node.nodeValue === snapshot.nodeValue &&
    statsAttributesMatch(node, snapshot.attributes) &&
    node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        node.childNodes.item(index) === child.node && statsDomMatches(child),
    )
  );
}

function captureStatsPlacement(element: HTMLElement): StatsPlacement | null {
  const document = element.ownerDocument;
  if (!element.isConnected || !document.defaultView) return null;
  const entries: StatsPlacementEntry[] = [];
  let node: Node = element;
  while (node !== document) {
    const parent = node.parentNode;
    if (!parent) return null;
    entries.push(
      Object.freeze({
        node,
        parent,
        previousSibling: previousStatsSibling(node),
        nextSibling: nextStatsSibling(node),
        attributes: snapshotStatsAttributes(node),
      }),
    );
    node = parent;
  }
  return Object.freeze({
    document,
    entries: Object.freeze(entries),
  });
}

function statsPlacementMatches(
  element: HTMLElement,
  placement: StatsPlacement,
): boolean {
  return (
    element === placement.entries[0]?.node &&
    element.ownerDocument === placement.document &&
    element.isConnected &&
    placement.entries.every(
      (entry) =>
        entry.node.parentNode === entry.parent &&
        previousStatsSibling(entry.node) === entry.previousSibling &&
        nextStatsSibling(entry.node) === entry.nextSibling &&
        statsAttributesMatch(entry.node, entry.attributes),
    )
  );
}

function statsPlacementStructureMatches(
  element: HTMLElement,
  placement: StatsPlacement,
): boolean {
  return (
    element === placement.entries[0]?.node &&
    element.ownerDocument === placement.document &&
    element.isConnected &&
    placement.entries.every(
      (entry) =>
        entry.node.parentNode === entry.parent &&
        previousStatsSibling(entry.node) === entry.previousSibling &&
        nextStatsSibling(entry.node) === entry.nextSibling,
    )
  );
}

function mutationTouchesStatsPlacement(
  mutation: MutationRecord,
  roots: readonly HTMLElement[],
  placements: readonly StatsPlacement[],
) {
  if (
    mutation.type === "attributes" &&
    mutation.target instanceof Element &&
    mutation.attributeName !== null &&
    ((mutation.target.getAttribute("data-testid") === "stats-button" &&
      STATS_RESPONSIVE_TRIGGER_ATTRIBUTES.has(
        mutation.attributeName,
      )) ||
      (mutation.target.getAttribute("data-testid") ===
        "stats-popover" &&
        STATS_RESPONSIVE_CONTENT_ATTRIBUTES.has(
          mutation.attributeName,
        )) ||
      (mutation.target.hasAttribute(
        "data-radix-popper-content-wrapper",
      ) &&
        mutation.attributeName === "style") ||
      (mutation.target.getAttribute("data-testid") === "goal-value" &&
        ((mutation.attributeName === "name" &&
          !mutation.target.hasAttribute("name")) ||
          (mutation.attributeName === "type" &&
            mutation.target.getAttribute("type") === "number"))))
  ) {
    return false;
  }
  if (
    roots.some(
      (root) => mutation.target === root || root.contains(mutation.target),
    )
  ) {
    return true;
  }
  const entries = placements.flatMap((placement) => placement.entries);
  if (
    mutation.type !== "childList" &&
    entries.some((entry) => mutation.target === entry.node)
  ) {
    return true;
  }
  if (mutation.type !== "childList") return false;
  if (
    [...mutation.addedNodes, ...mutation.removedNodes].every(
      isStatsFocusGuard,
    )
  ) {
    return false;
  }
  return entries.some((entry) => {
    if (mutation.target !== entry.parent) return false;
    if (
      mutation.previousSibling === entry.node ||
      mutation.nextSibling === entry.node
    ) {
      return true;
    }
    return [...mutation.addedNodes, ...mutation.removedNodes].some(
      (node) =>
        node === entry.node ||
        (node.nodeType === 1 && (node as Element).contains(entry.node)),
    );
  });
}

function createStatsMutationGuard(
  roots: readonly HTMLElement[],
  placements: readonly StatsPlacement[],
  onMutation: () => void,
): Pick<StatsDomGuard, "isClean" | "release"> | null {
  const document = placements[0]?.document;
  const Observer = document?.defaultView?.MutationObserver;
  if (
    !document ||
    !Observer ||
    placements.some((placement) => placement.document !== document)
  ) {
    return null;
  }
  let changed = false;
  let released = false;
  const record = (records: readonly MutationRecord[]) => {
    if (changed || released) return;
    const relevant = records.find((mutation) =>
      mutationTouchesStatsPlacement(mutation, roots, placements),
    );
    if (relevant) {
      changed = true;
      onMutation();
    }
  };
  const observer = new Observer(record);
  observer.observe(document, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    characterDataOldValue: true,
    childList: true,
    subtree: true,
  });
  return Object.freeze({
    isClean: () => {
      record(observer.takeRecords());
      return !changed;
    },
    release: () => {
      if (released) return;
      record(observer.takeRecords());
      released = true;
      observer.disconnect();
    },
  });
}

function statsNodeFromDocument(
  value: EventTarget | null,
  document: Document,
): value is Node {
  const NodeConstructor = document.defaultView?.Node;
  return Boolean(
    NodeConstructor &&
      value instanceof NodeConstructor &&
      value.ownerDocument === document,
  );
}

function statsOwnerWindowTarget(
  value: EventTarget | null,
  document: Document,
  ownerWindow: StatsOwnerWindow,
) {
  return (
    value === ownerWindow ||
    (value instanceof ownerWindow.Window &&
      Reflect.get(value, "document") === document)
  );
}

function statsEventView(event: Event) {
  if (!("view" in event)) return undefined;
  const view = event.view;
  return view === null || typeof view === "object"
    ? (view as Window | null)
    : undefined;
}

function statsEventPathIsExact(
  target: Node,
  path: readonly EventTarget[],
  ownerDocument: Document,
  ownerWindow: EventTarget,
) {
  const expected: EventTarget[] = [];
  let current: Node | null = target;
  while (current) {
    expected.push(current);
    current = current.parentNode;
  }
  return (
    expected.includes(ownerDocument) &&
    path.length === expected.length + 1 &&
    expected.every((value, index) => path[index] === value) &&
    path.at(-1) === ownerWindow
  );
}

function statsElementIsEnabled(element: HTMLElement) {
  if (
    element.matches(":disabled") ||
    element.getAttribute("aria-disabled")?.toLowerCase() === "true"
  ) {
    return false;
  }
  for (
    let current: HTMLElement | null = element;
    current;
    current = current.parentElement
  ) {
    if (
      current.hasAttribute("inert") ||
      current.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function statsGoalActionNavigationKey(
  key: string,
): key is StatsGoalActionNavigationKey {
  return (
    key === "ArrowLeft" ||
    key === "ArrowUp" ||
    key === "ArrowRight" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End"
  );
}

function statsGoalActionDestination(
  actions: readonly StatsGoalControlIdentity[],
  source: StatsGoalControlIdentity,
  key: StatsGoalActionNavigationKey,
) {
  const sourceIndex = actions.indexOf(source);
  if (sourceIndex < 0) return null;
  let destinationIndex: number | null = null;
  if (
    (key === "ArrowLeft" || key === "ArrowUp") &&
    sourceIndex > 0
  ) {
    destinationIndex = sourceIndex - 1;
  } else if (
    (key === "ArrowRight" || key === "ArrowDown") &&
    sourceIndex + 1 < actions.length
  ) {
    destinationIndex = sourceIndex + 1;
  } else if (key === "Home" && sourceIndex !== 0) {
    destinationIndex = 0;
  } else if (key === "End" && sourceIndex !== actions.length - 1) {
    destinationIndex = actions.length - 1;
  }
  const destination =
    destinationIndex === null ? null : actions[destinationIndex];
  return destination && destination !== source ? destination : null;
}

function statsReactPublicMethodMatches(
  event: object,
  property: keyof StatsGoalActionReactMethods,
  method: unknown,
  keyboardAuthority: StatsKeyboardAuthority,
) {
  if (!keyboardAuthority.isCurrent() || typeof method !== "function") {
    return false;
  }
  let owner: object | null = event;
  while (owner) {
    const descriptor = keyboardAuthority.getOwnPropertyDescriptor(
      owner,
      property,
    );
    if (descriptor) {
      return (
        "value" in descriptor &&
        descriptor.value === method &&
        descriptor.get === undefined &&
        descriptor.set === undefined
      );
    }
    owner = keyboardAuthority.getPrototypeOf(owner) as object | null;
  }
  return false;
}

function statsGoalActionMethodsRemainFalse(
  delivery: StatsGoalActionDelivery,
) {
  const { keyboardAuthority } = delivery.native;
  const { wrapper, methods } = delivery;
  try {
    return (
      wrapper.preventDefault === methods.preventDefault &&
      wrapper.isDefaultPrevented === methods.isDefaultPrevented &&
      wrapper.isPropagationStopped === methods.isPropagationStopped &&
      statsReactPublicMethodMatches(
        wrapper,
        "preventDefault",
        methods.preventDefault,
        keyboardAuthority,
      ) &&
      statsReactPublicMethodMatches(
        wrapper,
        "isDefaultPrevented",
        methods.isDefaultPrevented,
        keyboardAuthority,
      ) &&
      statsReactPublicMethodMatches(
        wrapper,
        "isPropagationStopped",
        methods.isPropagationStopped,
        keyboardAuthority,
      ) &&
      keyboardAuthority.apply(
        methods.isDefaultPrevented,
        wrapper,
        [],
      ) === false &&
      keyboardAuthority.apply(
        methods.isPropagationStopped,
        wrapper,
        [],
      ) === false
    );
  } catch {
    return false;
  }
}

function statsGoalActionDeliveriesMatchWithinPhase(
  left: StatsGoalActionDelivery,
  right: StatsGoalActionDelivery,
) {
  return (
    left.disclosure === right.disclosure &&
    left.goal === right.goal &&
    left.wrapper === right.wrapper &&
    left.methods.preventDefault === right.methods.preventDefault &&
    left.methods.isDefaultPrevented === right.methods.isDefaultPrevented &&
    left.methods.isPropagationStopped ===
      right.methods.isPropagationStopped &&
    left.native === right.native &&
    left.dispatchTarget === right.dispatchTarget &&
    left.source === right.source &&
    left.sourceIdentity === right.sourceIdentity &&
    left.key === right.key &&
    left.type === right.type &&
    left.phase === right.phase &&
    left.bubbles === right.bubbles &&
    left.cancelable === right.cancelable &&
    left.defaultPrevented === right.defaultPrevented &&
    left.trusted === right.trusted &&
    Object.is(left.view, right.view) &&
    left.code === right.code &&
    left.location === right.location &&
    left.ctrlKey === right.ctrlKey &&
    left.metaKey === right.metaKey &&
    left.altKey === right.altKey &&
    left.shiftKey === right.shiftKey &&
    left.repeat === right.repeat &&
    left.composing === right.composing
  );
}

function statsGoalActionDeliveriesMatchAcrossPhases(
  capture: StatsGoalActionDelivery,
  bubble: StatsGoalActionDelivery,
) {
  return (
    capture.disclosure === bubble.disclosure &&
    capture.goal === bubble.goal &&
    capture.wrapper !== bubble.wrapper &&
    capture.native === bubble.native &&
    capture.dispatchTarget === bubble.dispatchTarget &&
    capture.source === bubble.source &&
    capture.sourceIdentity === bubble.sourceIdentity &&
    capture.key === bubble.key &&
    capture.type === bubble.type &&
    capture.bubbles === bubble.bubbles &&
    capture.cancelable === bubble.cancelable &&
    capture.defaultPrevented === bubble.defaultPrevented &&
    capture.trusted === bubble.trusted &&
    Object.is(capture.view, bubble.view) &&
    capture.code === bubble.code &&
    capture.location === bubble.location &&
    capture.ctrlKey === bubble.ctrlKey &&
    capture.metaKey === bubble.metaKey &&
    capture.altKey === bubble.altKey &&
    capture.shiftKey === bubble.shiftKey &&
    capture.repeat === bubble.repeat &&
    capture.composing === bubble.composing
  );
}

function statsSnapshotEqual(left: StatsSnapshot, right: StatsSnapshot) {
  return (
    left.stats === right.stats &&
    left.words === right.words &&
    left.characters === right.characters &&
    left.charactersNoSpaces === right.charactersNoSpaces &&
    left.sentences === right.sentences &&
    left.paragraphs === right.paragraphs &&
    left.headings === right.headings &&
    left.readingMinutes === right.readingMinutes &&
    left.speakingMinutes === right.speakingMinutes
  );
}

function goalSnapshotEqual(left: GoalSnapshot, right: GoalSnapshot) {
  return (
    left.goal === right.goal &&
    left.kind === right.kind &&
    left.mode === right.mode &&
    left.value === right.value &&
    left.setBy === right.setBy &&
    left.setAt === right.setAt
  );
}

function progressSnapshotEqual(
  left: ProgressSnapshot,
  right: ProgressSnapshot,
) {
  return (
    left.progress === right.progress &&
    left.current === right.current &&
    left.target === right.target &&
    left.fraction === right.fraction &&
    left.state === right.state
  );
}

function statsVisitsMatch(
  left: StatsDisclosureVisit,
  right: StatsDisclosureVisit,
) {
  return (
    left.mount === right.mount &&
    left.session === right.session &&
    left.docId === right.docId &&
    left.ydoc === right.ydoc &&
    left.ytext === right.ytext &&
    left.role === right.role
  );
}

function statsRenderFactsMatch(
  left: StatsDisclosureRender,
  right: StatsDisclosureRender,
) {
  return (
    statsVisitsMatch(left.visit, right.visit) &&
    left.session === right.session &&
    left.source === right.source &&
    left.selection === right.selection &&
    left.selectionFrom === right.selectionFrom &&
    left.selectionTo === right.selectionTo &&
    left.hydrated === right.hydrated &&
    statsSnapshotEqual(left.stats, right.stats) &&
    (left.selectionStats && right.selectionStats
      ? statsSnapshotEqual(left.selectionStats, right.selectionStats)
      : left.selectionStats === right.selectionStats) &&
    goalSnapshotEqual(left.goal, right.goal) &&
    left.canEdit === right.canEdit &&
    progressSnapshotEqual(left.progress, right.progress) &&
    left.shortcutLabel === right.shortcutLabel &&
    left.triggerTitle === right.triggerTitle &&
    left.triggerLabel === right.triggerLabel &&
    left.selectionLabel === right.selectionLabel &&
    left.goalPresentation.session === right.goalPresentation.session &&
    left.goalPresentation.sharedGoal.goal ===
      right.goalPresentation.sharedGoal.goal &&
    left.goalPresentation.progress.progress ===
      right.goalPresentation.progress.progress &&
    left.goalPresentation.canEdit === right.goalPresentation.canEdit &&
    left.mode === right.mode &&
    left.goalPresentation.draft === right.goalPresentation.draft &&
    left.goalPresentation.kind === right.goalPresentation.kind &&
    left.goalPresentation.mode === right.goalPresentation.mode &&
    left.goalPresentation.value === right.goalPresentation.value &&
    left.goalPresentation.setBy === right.goalPresentation.setBy &&
    left.goalPresentation.setDisabled === right.goalPresentation.setDisabled &&
    left.goalControls === right.goalControls &&
    left.setDraft === right.setDraft &&
    left.commitState === right.commitState
  );
}

function statsRendersMatch(
  left: StatsDisclosureRender,
  right: StatsDisclosureRender,
) {
  return (
    statsRenderFactsMatch(left, right) &&
    left.open === right.open &&
    left.authority === right.authority
  );
}

function statsCloseSuccessorMatches(
  open: StatsDisclosureRender,
  closed: StatsDisclosureRender,
) {
  return (
    open.visit === closed.visit &&
    open.open &&
    open.authority !== null &&
    open.state.visit === open.visit &&
    open.state.authority === open.authority &&
    open.state.open &&
    !closed.open &&
    closed.authority === null &&
    closed.state.visit === open.visit &&
    closed.state.authority === null &&
    !closed.state.open &&
    statsRenderFactsMatch(open, closed)
  );
}

function statsOpenSuccessorMatches(
  closed: StatsDisclosureRender,
  open: StatsDisclosureRender,
  authority: StatsDisclosureAuthority,
) {
  return (
    closed.visit === open.visit &&
    !closed.open &&
    closed.authority === null &&
    closed.state.visit === closed.visit &&
    closed.state.authority === null &&
    !closed.state.open &&
    open.open &&
    open.authority === authority &&
    open.state.visit === closed.visit &&
    open.state.authority === authority &&
    open.state.open &&
    statsRenderFactsMatch(closed, open)
  );
}

function statsClosedSuccessorsMatch(
  expected: StatsDisclosureRender,
  current: StatsDisclosureRender,
) {
  return (
    expected.visit === current.visit &&
    !expected.open &&
    expected.authority === null &&
    !current.open &&
    current.authority === null &&
    statsRendersMatch(expected, current)
  );
}

class StatsDisclosureCurrent {
  #visit: StatsDisclosureVisit | null = null;
  #authority: StatsDisclosureAuthority | null = null;

  publishVisit(visit: StatsDisclosureVisit) {
    if (visit.retired || (this.#visit && this.#visit !== visit)) return false;
    this.#visit = visit;
    return true;
  }

  retireVisit(visit: StatsDisclosureVisit) {
    visit.retired = true;
    if (this.#visit === visit) this.#visit = null;
    if (this.#authority?.visit === visit) {
      this.#authority.retired = true;
      this.#authority = null;
    }
  }

  ownsVisit(visit: StatsDisclosureVisit) {
    return !visit.retired && this.#visit === visit;
  }

  authority() {
    return this.#authority;
  }

  canPublishAuthority(authority: StatsDisclosureAuthority) {
    return (
      !authority.retired &&
      this.#authority === null &&
      this.ownsVisit(authority.visit)
    );
  }

  publishAuthority(authority: StatsDisclosureAuthority) {
    if (!this.canPublishAuthority(authority)) return false;
    this.#authority = authority;
    return true;
  }

  ownsAuthority(authority: StatsDisclosureAuthority | null) {
    return (
      authority !== null &&
      !authority.retired &&
      this.ownsVisit(authority.visit) &&
      this.#authority === authority
    );
  }

  retireAuthority(authority: StatsDisclosureAuthority) {
    if (!this.ownsAuthority(authority)) return false;
    authority.retired = true;
    this.#authority = null;
    return true;
  }

  clear() {
    if (this.#visit) this.#visit.retired = true;
    if (this.#authority) this.#authority.retired = true;
    this.#visit = null;
    this.#authority = null;
  }
}

class StatsDisclosureCoordinator {
  #current: StatsDisclosurePublication | null = null;
  #successorOf: StatsDisclosurePublication | null = null;
  #replay: StatsReplay | null = null;
  #poisoned: StatsDisclosurePublication | null = null;
  #lease = 0;
  #elementOwners = new WeakMap<HTMLElement, StatsElementOwner>();
  #goalControlOwners = new WeakMap<
    HTMLElement,
    {
      publication: StatsDisclosurePublication;
      publicationIdentity: symbol;
      controlIdentity: StatsGoalControlIdentity;
      connectionIdentity: symbol;
    }
  >();
  #claimedEvents = new WeakSet<object>();
  #claimedDirections = new WeakSet<object>();
  #claimedDestinations = new WeakSet<object>();
  #directionalNativeEvents = new WeakMap<
    Event,
    StatsDirectionalNativeEvent
  >();
  #directionalCaptureEvents = new WeakMap<
    Event,
    StatsDirectionalReactEvent
  >();
  #directionalReactEvents = new WeakSet<object>();
  #claimedGoalPublications = new WeakSet<GoalPublication>();
  #claimedGoalGenerations = new WeakSet<GoalGeneration>();
  #claimedGoalMovements = new WeakSet<StatsGoalActionMovement>();
  #claimedGoalConnections = new WeakSet<StatsGoalControlConnection>();
  #nativeProvenance = new WeakMap<Event, StatsNativeProvenance>();
  #provenanceRecords = new Set<StatsNativeProvenance>();
  #pointerProvenance: StatsPointerProvenance | null = null;
  #capture: StatsNativeCapture | null = null;
  #proof: StatsDisclosureProof | null = null;
  #openFocus: StatsOpenFocus | null = null;
  #directionalIntent: StatsDirectionalFocusIntent | null = null;
  #closeFocus: StatsCloseFocus | null = null;
  #retiredCloseFocus = new Map<
    StatsDisclosurePublication,
    StatsCloseFocus
  >();

  beginLease() {
    this.#lease += 1;
    return this.#lease;
  }

  endLease(lease: number) {
    this.releaseCapture();
    queueMicrotask(() => {
      if (this.#lease !== lease) return;
      const close = this.#closeFocus;
      if (close) {
        this.retireCloseFocus(
          close,
          close.expected ?? close.publication,
        );
      }
      this.#current?.guard?.release();
      this.#replay?.release();
      this.#poisoned?.guard?.release();
      this.clearProof();
      this.clearProvenance();
      this.#current?.current.clear();
      this.#current = null;
      this.#successorOf = null;
      this.#replay = null;
      this.#poisoned = null;
      this.#openFocus = null;
      this.#directionalIntent = null;
      this.#closeFocus = null;
    });
  }

  domainFor(role: StatsElementRole): StatsLayoutDomain {
    return role === "trigger" ? "trigger" : "portal";
  }

  releaseOwner(
    publication: StatsDisclosurePublication,
    role: StatsElementRole,
    connection: StatsElementConnection<HTMLElement> | null,
  ) {
    if (!connection) return;
    const owner = this.#elementOwners.get(connection.element);
    if (
      owner?.publication === publication &&
      owner.publicationIdentity === publication.identity &&
      owner.role === role &&
      owner.connectionIdentity === connection.identity
    ) {
      this.#elementOwners.delete(connection.element);
    }
  }

  detachElement(
    publication: StatsDisclosurePublication,
    role: StatsElementRole,
    connection: StatsElementConnection<HTMLElement>,
  ) {
    const current =
      role === "trigger"
        ? publication.connections.trigger
        : publication.connections.content;
    if (current !== connection) return;
    this.releaseOwner(publication, role, connection);
    if (role === "trigger") {
      publication.connections.trigger = null;
      publication.elements.trigger = null;
    } else {
      publication.connections.content = null;
      publication.elements.content = null;
    }
    if (!publication.established && !publication.retired) return;
    const replay = publication.replayRefs.find((entry) => entry.role === role);
    if (
      !replay ||
      replay.element !== connection.element ||
      replay.detached ||
      replay.reattached
    ) {
      publication.invalidReplay.add(this.domainFor(role));
      this.retire(publication, "other");
      return;
    }
    replay.detached = true;
    this.retire(publication, "ref", this.domainFor(role));
  }

  bindElement(
    publication: StatsDisclosurePublication,
    role: "trigger",
    element: HTMLButtonElement | null,
  ): (() => void) | undefined;
  bindElement(
    publication: StatsDisclosurePublication,
    role: "content",
    element: HTMLDivElement | null,
  ): (() => void) | undefined;
  bindElement(
    publication: StatsDisclosurePublication,
    role: StatsElementRole,
    element: HTMLButtonElement | HTMLDivElement | null,
  ): (() => void) | undefined {
    const previous =
      role === "trigger"
        ? publication.connections.trigger
        : publication.connections.content;
    if (!element) {
      if (previous) this.detachElement(publication, role, previous);
      return;
    }
    const existingOwner = this.#elementOwners.get(element);
    if (existingOwner && existingOwner.publication !== publication) {
      publication.invalidReplay.add(this.domainFor(role));
      this.retire(publication, "other");
      return;
    }
    if (previous?.element === element) {
      return () => this.detachElement(publication, role, previous);
    }
    if (previous) {
      publication.invalidReplay.add(this.domainFor(role));
      this.retire(publication, "other");
      return;
    }

    if (publication.established || publication.retired) {
      const replay = publication.replayRefs.find(
        (entry) => entry.role === role,
      );
      if (
        !replay ||
        replay.element !== element ||
        !replay.detached ||
        replay.reattached ||
        !element.isConnected
      ) {
        publication.invalidReplay.add(this.domainFor(role));
        this.retire(publication, "other");
        return;
      }
      replay.reattached = true;
    }

    let connection: StatsElementConnection<HTMLElement>;
    if (role === "trigger") {
      if (!(element instanceof HTMLButtonElement)) return;
      const triggerConnection = {
        identity: Symbol("stats-trigger-connection"),
        element,
      };
      connection = triggerConnection;
      publication.connections.trigger = triggerConnection;
      publication.elements.trigger = element;
    } else {
      if (!(element instanceof HTMLDivElement)) return;
      const contentConnection = {
        identity: Symbol("stats-content-connection"),
        element,
      };
      connection = contentConnection;
      publication.connections.content = contentConnection;
      publication.elements.content = element;
    }
    this.#elementOwners.set(element, {
      publication,
      publicationIdentity: publication.identity,
      role,
      connectionIdentity: connection.identity,
    });
    if (publication.retired) {
      this.stageReplay(publication, this.domainFor(role));
    } else if (
      publication.layoutEstablished.has(this.domainFor(role))
    ) {
      this.establish(publication, this.domainFor(role));
    }
    return () => this.detachElement(publication, role, connection);
  }

  releaseGoalControlOwner(
    publication: StatsDisclosurePublication,
    connection: StatsGoalControlConnection | null,
  ) {
    if (!connection) return;
    const owner = this.#goalControlOwners.get(connection.element);
    if (
      owner?.publication === publication &&
      owner.publicationIdentity === publication.identity &&
      owner.controlIdentity === connection.controlIdentity &&
      owner.connectionIdentity === connection.identity
    ) {
      this.#goalControlOwners.delete(connection.element);
    }
  }

  detachGoalControl(
    publication: StatsDisclosurePublication,
    identity: StatsGoalControlIdentity,
    connection: StatsGoalControlConnection,
  ) {
    if (publication.goalControls.get(identity) !== connection) return;
    this.releaseGoalControlOwner(publication, connection);
    publication.goalControls.delete(identity);
    if (!publication.established && !publication.retired) return;
    const replay = publication.replayRefs.find(
      (entry) => entry.role === "goal" && entry.goalIdentity === identity,
    );
    if (
      !replay ||
      replay.element !== connection.element ||
      replay.detached ||
      replay.reattached
    ) {
      publication.invalidReplay.add("portal");
      this.retire(publication, "other");
      return;
    }
    replay.detached = true;
    this.retire(publication, "ref", "portal");
  }

  bindGoalControl(
    publication: StatsDisclosurePublication,
    identity: StatsGoalControlIdentity,
    element: HTMLElement | null,
  ): (() => void) | undefined {
    if (!publication.render.goalControls.includes(identity)) return;
    const previous = publication.goalControls.get(identity) ?? null;
    if (!element) {
      if (previous) this.detachGoalControl(publication, identity, previous);
      return;
    }
    const existingOwner = this.#goalControlOwners.get(element);
    if (
      existingOwner &&
      (existingOwner.publication !== publication ||
        existingOwner.controlIdentity !== identity)
    ) {
      publication.invalidReplay.add("portal");
      this.retire(publication, "other");
      return;
    }
    if (previous?.element === element) {
      return () => this.detachGoalControl(publication, identity, previous);
    }
    if (previous) {
      publication.invalidReplay.add("portal");
      this.retire(publication, "other");
      return;
    }
    if (publication.established || publication.retired) {
      const replay = publication.replayRefs.find(
        (entry) =>
          entry.role === "goal" && entry.goalIdentity === identity,
      );
      if (
        !replay ||
        replay.element !== element ||
        !replay.detached ||
        replay.reattached ||
        !element.isConnected
      ) {
        publication.invalidReplay.add("portal");
        this.retire(publication, "other");
        return;
      }
      replay.reattached = true;
    }
    const connection: StatsGoalControlConnection = {
      identity: Symbol(`stats-${identity.key}-connection`),
      controlIdentity: identity,
      element,
      claimed: false,
    };
    publication.goalControls.set(identity, connection);
    this.#goalControlOwners.set(element, {
      publication,
      publicationIdentity: publication.identity,
      controlIdentity: identity,
      connectionIdentity: connection.identity,
    });
    if (publication.retired) {
      this.stageReplay(publication, "portal");
    } else if (publication.layoutEstablished.has("portal")) {
      this.establish(publication, "portal");
    }
    return () =>
      this.detachGoalControl(publication, identity, connection);
  }

  requestSuccessor(
    publication: StatsDisclosurePublication,
    replaceVisit = !this.visitIsExact(publication.render.visit),
  ) {
    if (replaceVisit) {
      if (publication.visitSuccessorRequested) return;
      publication.visitSuccessorRequested = true;
      publication.requestSuccessor(true);
      return;
    }
    if (publication.successorRequested) return;
    publication.successorRequested = true;
    publication.requestSuccessor(false);
  }

  clearProvenance(publication?: StatsDisclosurePublication) {
    for (const provenance of [...this.#provenanceRecords]) {
      if (publication && provenance.publication !== publication) continue;
      provenance.ownerWindow.clearTimeout(provenance.timeoutId);
      this.#provenanceRecords.delete(provenance);
      this.#nativeProvenance.delete(provenance.event);
      if (this.#pointerProvenance === provenance) {
        this.#pointerProvenance = null;
      }
    }
  }

  releaseCapture() {
    this.#capture?.remove();
    this.#capture = null;
    this.clearProvenance();
  }

  recordDirectionalNative(
    publication: StatsDisclosurePublication,
    event: Event,
    document: Document,
    ownerWindow: StatsOwnerWindow,
    listener: StatsDirectionalListenerProof,
    keyboardAuthority: StatsKeyboardAuthority,
  ) {
    const trigger = publication.elements.trigger;
    keyboardAuthority.isCurrent();
    if (
      this.#directionalNativeEvents.has(event) ||
      !trigger ||
      keyboardAuthority.getPrototypeOf(event) !==
        keyboardAuthority.keyboardPrototype ||
      !(event instanceof ownerWindow.KeyboardEvent)
    ) {
      return;
    }
    const key = keyboardAuthority.keyboardKey.read(event);
    if (!statsGoalActionNavigationKey(key)) return;
    const target = keyboardAuthority.eventTarget.read(event);
    const path = keyboardAuthority.eventPath.call(event);
    const intrinsicView = keyboardAuthority.eventView.read(event);
    this.#directionalNativeEvents.set(event, {
      publication,
      event,
      keyboardAuthority,
      ownerDocument: document,
      ownerWindow,
      listener,
      type: keyboardAuthority.eventType.read(event),
      target,
      currentTarget: event.currentTarget,
      intrinsicCurrentTarget:
        keyboardAuthority.eventCurrentTarget.read(event),
      path: Object.freeze([...path]),
      phase: keyboardAuthority.eventPhase.read(event),
      bubbles: keyboardAuthority.eventBubbles.read(event),
      cancelable: keyboardAuthority.eventCancelable.read(event),
      composed: keyboardAuthority.eventComposed.read(event),
      defaultPrevented:
        keyboardAuthority.eventDefaultPrevented.read(event),
      cancelBubble: keyboardAuthority.eventCancelBubble.read(event),
      trusted: keyboardAuthority.isTrusted.matches(event)
        ? keyboardAuthority.isTrusted.read(event)
        : false,
      timeStamp: keyboardAuthority.eventTimeStamp.read(event),
      view: statsEventView(event),
      intrinsicView,
      key,
      code: keyboardAuthority.keyboardCode.read(event),
      location: keyboardAuthority.keyboardLocation.read(event),
      ctrlKey: keyboardAuthority.keyboardCtrl.read(event),
      metaKey: keyboardAuthority.keyboardMeta.read(event),
      altKey: keyboardAuthority.keyboardAlt.read(event),
      shiftKey: keyboardAuthority.keyboardShift.read(event),
      repeat: keyboardAuthority.keyboardRepeat.read(event),
      composing: keyboardAuthority.keyboardComposing.read(event),
      claimed: false,
    });
  }

  ensureCapture(document: Document, ownerWindow: StatsOwnerWindow) {
    if (
      this.#capture?.document === document &&
      this.#capture.ownerWindow === ownerWindow &&
      this.#capture.windowKeyRegistration.active &&
      !this.#capture.windowKeyRegistration.removed &&
      this.#capture.keyboardAuthority.isCurrent()
    ) {
      return true;
    }
    this.releaseCapture();
    const keyboardAuthority = captureStatsKeyboardAuthority(ownerWindow);
    if (!keyboardAuthority) return false;
    let active = true;
    const capturePointerEvent = (
      event: Event,
      type: StatsPointerEventProof["type"],
    ): StatsPointerEventProof | null => {
      const PointerEventConstructor = ownerWindow.PointerEvent;
      const target = event.target;
      const path = event.composedPath();
      if (
        !PointerEventConstructor ||
        !(event instanceof PointerEventConstructor) ||
        event.type !== type ||
        event.currentTarget !== document ||
        event.eventPhase !== ownerWindow.Event.CAPTURING_PHASE ||
        !statsNodeFromDocument(target, document) ||
        !target.isConnected ||
        !path.includes(target) ||
        !path.includes(document) ||
        event.button !== 0 ||
        typeof event.pointerId !== "number" ||
        typeof event.pointerType !== "string" ||
        typeof event.isPrimary !== "boolean"
      ) {
        return null;
      }
      return Object.freeze({
        event,
        type,
        target,
        path: Object.freeze([...path]),
        phase: event.eventPhase,
        timeStamp: event.timeStamp,
        button: event.button,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        isPrimary: event.isPrimary,
        detail: event.detail,
      });
    };
    const pointerPathsMatch = (
      first: readonly EventTarget[],
      second: readonly EventTarget[],
    ) =>
      first.length === second.length &&
      first.every((value, index) => value === second[index]);
    const pointerPartMatches = (
      pointerDown: StatsPointerEventProof,
      next: StatsPointerEventProof,
    ) =>
      next.target === pointerDown.target &&
      pointerPathsMatch(next.path, pointerDown.path) &&
      next.phase === pointerDown.phase &&
      next.timeStamp >= pointerDown.timeStamp &&
      next.button === pointerDown.button &&
      next.ctrlKey === pointerDown.ctrlKey &&
      next.altKey === pointerDown.altKey &&
      next.metaKey === pointerDown.metaKey &&
      next.shiftKey === pointerDown.shiftKey &&
      next.pointerId === pointerDown.pointerId &&
      next.pointerType === pointerDown.pointerType &&
      (next.type === "click" ||
        next.isPrimary === pointerDown.isPrimary) &&
      (next.type !== "click" || next.detail > 0);
    const pointerProvenanceIsCurrent = (
      provenance: StatsPointerProvenance,
    ) => {
      if (
        this.#pointerProvenance !== provenance ||
        ownerWindow.performance.now() >= provenance.expiresAt
      ) {
        this.forgetProvenance(provenance.event);
        return false;
      }
      return true;
    };
    const remember = (event: Event) => {
      const publication = this.#current;
      if (
        !active ||
        !publication ||
        event.currentTarget !== document
      ) {
        return;
      }
      const capturedPointer = this.#pointerProvenance;
      if (event.type === "pointercancel") {
        if (capturedPointer) {
          this.forgetProvenance(capturedPointer.event);
        }
        return;
      }
      if (event.type === "pointerup") {
        if (!capturedPointer) return;
        const pointerUp = capturePointerEvent(event, "pointerup");
        if (
          capturedPointer.publication !== publication ||
          !pointerProvenanceIsCurrent(capturedPointer) ||
          capturedPointer.pointerUp ||
          capturedPointer.click ||
          !pointerUp ||
          !pointerPartMatches(capturedPointer.pointerDown, pointerUp)
        ) {
          this.forgetProvenance(capturedPointer.event);
          return;
        }
        capturedPointer.pointerUp = pointerUp;
        return;
      }
      if (event.type === "click" && capturedPointer) {
        const click = capturePointerEvent(event, "click");
        if (
          capturedPointer.publication !== publication ||
          !pointerProvenanceIsCurrent(capturedPointer) ||
          !capturedPointer.pointerUp ||
          capturedPointer.click ||
          !click ||
          click.timeStamp < capturedPointer.pointerUp.timeStamp ||
          !pointerPartMatches(capturedPointer.pointerDown, click)
        ) {
          this.forgetProvenance(capturedPointer.event);
        } else {
          capturedPointer.click = click;
          capturedPointer.expiresAt =
            ownerWindow.performance.now() + STATS_POINTER_CALLBACK_LEASE_MS;
          capturedPointer.ownerWindow.clearTimeout(capturedPointer.timeoutId);
          capturedPointer.timeoutId = ownerWindow.setTimeout(
            () => this.forgetProvenance(capturedPointer.event),
            STATS_POINTER_CALLBACK_LEASE_MS,
          );
        }
      } else if (
        event.type === "keydown" ||
        (event.type === "pointerdown" && capturedPointer) ||
        (event.type === "focusin" && !capturedPointer)
      ) {
        this.clearProvenance(publication);
      }
      const kind =
        event.type === "click"
          ? "click"
          : event.type === "keydown"
            ? "keydown"
            : event.type === "pointerdown"
              ? "pointerdown"
              : event.type === "focusin"
                ? "focusin"
                : null;
      const target = event.target;
      if (
        !kind ||
        !(event instanceof ownerWindow.Event) ||
        event.eventPhase === ownerWindow.Event.NONE ||
        !statsNodeFromDocument(target, document) ||
        !target.isConnected ||
        !event.composedPath().includes(document) ||
        !this.matches(publication)
      ) {
        return;
      }
      if (
        (kind === "click" || kind === "pointerdown") &&
        typeof Reflect.get(event, "button") === "number" &&
        Reflect.get(event, "button") !== 0
      ) {
        return;
      }
      const provenance: StatsNativeProvenance = {
        publication,
        event,
        kind,
        document,
        ownerWindow,
        timeoutId: 0,
      };
      if (kind === "pointerdown") {
        const pointerDown = capturePointerEvent(event, "pointerdown");
        if (!pointerDown || pointerDown.isPrimary !== true) return;
        const expiresAt =
          ownerWindow.performance.now() + STATS_POINTER_GESTURE_LEASE_MS;
        const pointerProvenance: StatsPointerProvenance = {
          ...provenance,
          kind,
          pointerDown,
          pointerUp: null,
          click: null,
          expiresAt,
        };
        this.#pointerProvenance = pointerProvenance;
        this.#nativeProvenance.set(event, pointerProvenance);
        this.#provenanceRecords.add(pointerProvenance);
        pointerProvenance.timeoutId = ownerWindow.setTimeout(
          () => this.forgetProvenance(event),
          STATS_POINTER_GESTURE_LEASE_MS,
        );
        return;
      }
      this.#nativeProvenance.set(event, provenance);
      this.#provenanceRecords.add(provenance);
      provenance.timeoutId = ownerWindow.setTimeout(
        () => this.forgetProvenance(event),
        0,
      );
    };
    const registrationBox: {
      current: StatsWindowKeyRegistration | null;
    } = { current: null };
    const currentPublication = () => this.#current;
    const currentRegistration = () =>
      this.#capture?.windowKeyRegistration;
    const consumeShortcut = (
      publication: StatsDisclosurePublication,
      event: KeyboardEvent,
    ) => this.consumeShortcut(publication, event);
    const recordDirectionalNative = (
      publication: StatsDisclosurePublication,
      event: KeyboardEvent,
      listener: StatsDirectionalListenerProof,
    ) =>
      this.recordDirectionalNative(
        publication,
        event,
        document,
        ownerWindow,
        listener,
        keyboardAuthority,
      );
    const onWindowKey: StatsWindowKeyListener = function (
      this: EventTarget,
      event: KeyboardEvent,
    ) {
      const windowKeyRegistration = registrationBox.current;
      const publication = currentPublication();
      const phase = keyboardAuthority.eventPhase.read(event);
      if (
        !windowKeyRegistration ||
        !windowKeyRegistration.active ||
        windowKeyRegistration.removed ||
        currentRegistration() !== windowKeyRegistration ||
        windowKeyRegistration.listener !== onWindowKey ||
        windowKeyRegistration.target !== ownerWindow ||
        windowKeyRegistration.document !== document ||
        windowKeyRegistration.keyboardAuthority !== keyboardAuthority ||
        windowKeyRegistration.addEventListener !==
          keyboardAuthority.addEventListener.value ||
        windowKeyRegistration.removeEventListener !==
          keyboardAuthority.removeEventListener.value ||
        !keyboardAuthority.addEventListener.isCurrent() ||
        !keyboardAuthority.removeEventListener.isCurrent() ||
        !publication
      ) {
        return;
      }
      if (phase !== ownerWindow.Event.CAPTURING_PHASE) {
        consumeShortcut(publication, event);
        return;
      }
      const currentTarget = event.currentTarget;
      const intrinsicCurrentTarget =
        keyboardAuthority.eventCurrentTarget.read(event);
      const terminal = keyboardAuthority.eventPath.call(event).at(-1);
      if (
        !currentTarget ||
        !intrinsicCurrentTarget ||
        !terminal ||
        this !== currentTarget ||
        this !== intrinsicCurrentTarget ||
        this !== terminal
      ) {
        return;
      }
      const listener: StatsDirectionalListenerProof = {
        registration: windowKeyRegistration,
        publication,
        listener: onWindowKey,
        event,
        receiver: this,
        currentTarget,
        intrinsicCurrentTarget,
        terminal,
        claimed: false,
      };
      recordDirectionalNative(
        publication,
        event,
        listener,
      );
    };
    const windowKeyRegistration: StatsWindowKeyRegistration = {
      identity: Symbol("stats-window-key-registration"),
      document,
      target: ownerWindow,
      keyboardAuthority,
      listener: onWindowKey,
      addEventListener: keyboardAuthority.addEventListener.value,
      removeEventListener: keyboardAuthority.removeEventListener.value,
      active: true,
      removed: false,
    };
    registrationBox.current = windowKeyRegistration;
    document.addEventListener("click", remember, true);
    document.addEventListener("keydown", remember, true);
    document.addEventListener("pointerdown", remember, true);
    document.addEventListener("pointerup", remember, true);
    document.addEventListener("pointercancel", remember, true);
    document.addEventListener("focusin", remember, true);
    keyboardAuthority.apply(
      keyboardAuthority.addEventListener.value,
      ownerWindow,
      ["keydown", onWindowKey, true],
    );
    keyboardAuthority.apply(
      keyboardAuthority.addEventListener.value,
      ownerWindow,
      ["keydown", onWindowKey],
    );
    this.#capture = {
      document,
      ownerWindow,
      keyboardAuthority,
      windowKeyRegistration,
      remove: () => {
        if (!active) return;
        active = false;
        windowKeyRegistration.active = false;
        windowKeyRegistration.removed = true;
        document.removeEventListener("click", remember, true);
        document.removeEventListener("keydown", remember, true);
        document.removeEventListener("pointerdown", remember, true);
        document.removeEventListener("pointerup", remember, true);
        document.removeEventListener("pointercancel", remember, true);
        document.removeEventListener("focusin", remember, true);
        keyboardAuthority.apply(
          keyboardAuthority.removeEventListener.value,
          ownerWindow,
          ["keydown", onWindowKey, true],
        );
        keyboardAuthority.apply(
          keyboardAuthority.removeEventListener.value,
          ownerWindow,
          ["keydown", onWindowKey],
        );
      },
    };
    return true;
  }

  clearProof(expected?: StatsDisclosureProof) {
    const proof = this.#proof;
    if (!proof || (expected && proof !== expected)) return;
    proof.ownerWindow.clearTimeout(proof.timeoutId);
    this.#proof = null;
  }

  clearCloseFocus(expected?: StatsCloseFocus) {
    if (!expected) {
      this.#closeFocus = null;
      return;
    }
    if (this.#closeFocus === expected) {
      this.#closeFocus = null;
    }
    const publication = expected?.expected;
    if (
      publication &&
      this.#retiredCloseFocus.get(publication) === expected
    ) {
      this.#retiredCloseFocus.delete(publication);
    }
  }

  retireCloseFocus(
    expected?: StatsCloseFocus,
    callbackPublication?: StatsDisclosurePublication | null,
  ) {
    const close = expected ?? this.#closeFocus;
    if (!close || (expected && this.#closeFocus !== expected)) return;
    this.#closeFocus = null;
    const publication =
      callbackPublication ?? close.expected ?? close.publication;
    const ownerWindow =
      close.publication.triggerPlacement?.document.defaultView;
    if (!publication || !ownerWindow || close.claimed) return;
    this.#retiredCloseFocus.set(publication, close);
  }

  releaseCloseFocusAfterPortal(
    publication: StatsDisclosurePublication,
  ) {
    const ownerWindow =
      publication.triggerPlacement?.document.defaultView;
    if (!ownerWindow) return;
    ownerWindow.setTimeout(() => {
      ownerWindow.setTimeout(() => {
        const active = this.#closeFocus;
        if (active?.publication === publication) {
          this.clearCloseFocus(active);
        }
        for (const [callbackPublication, close] of this
          .#retiredCloseFocus) {
          if (close.publication === publication) {
            this.#retiredCloseFocus.delete(callbackPublication);
          }
        }
      }, 0);
    }, 0);
  }

  retire(
    publication: StatsDisclosurePublication | null,
    reason: StatsRetirement,
    domain?: StatsLayoutDomain,
  ) {
    if (!publication) return false;
    if (reason === "layout" && domain) {
      publication.layoutRetired.add(domain);
    }
    if (reason === "other" && domain) {
      publication.invalidReplay.add(domain);
    }
    const wasCurrent = this.#current === publication;
    if (
      reason === "mutation" &&
      publication.retired &&
      !wasCurrent &&
      this.#successorOf !== publication &&
      this.#replay?.source !== publication
    ) {
      publication.guard?.release();
      return false;
    }
    publication.guard?.deactivate();
    this.clearProvenance(publication);
    if (this.#proof?.publication === publication) this.clearProof();
    if (!publication.retired) {
      publication.retired = true;
      publication.retirement = reason;
      if (wasCurrent) {
        this.#current = null;
        this.#successorOf = publication;
      }
    } else if (publication.retirement === "layout" && reason !== "layout") {
      publication.retirement = reason;
    }

    if (reason === "mutation" || reason === "drift" || reason === "other") {
      if (this.#directionalIntent?.publication === publication) {
        this.#directionalIntent = null;
        this.#openFocus = null;
      }
      if (reason === "mutation" && publication.triggerDom) {
        this.#poisoned = publication;
      }
      if (this.#replay?.source === publication) {
        this.#replay = null;
      }
      publication.guard?.release();
      this.requestSuccessor(publication);
      return wasCurrent;
    }

    queueMicrotask(() => {
      if (
        this.#successorOf !== publication ||
        this.#replay?.source === publication ||
        this.#current
      ) {
        if (
          this.#replay?.source !== publication &&
          this.#poisoned !== publication
        ) {
          publication.guard?.release();
        }
        return;
      }
      publication.guard?.release();
      this.requestSuccessor(publication);
    });
    return wasCurrent;
  }

  retireLayout(
    publication: StatsDisclosurePublication,
    domain: StatsLayoutDomain,
  ) {
    this.retire(publication, "layout", domain);
  }

  visitIsExact(visit: StatsDisclosureVisit) {
    return (
      visit.session.docId === visit.docId &&
      visit.session.ydoc === visit.ydoc &&
      visit.session.ytext === visit.ytext &&
      visit.session.role === visit.role
    );
  }

  renderIsExact(render: StatsDisclosureRender, allowRetiredVisit = false) {
    const selection = render.selection;
    return (
      (allowRetiredVisit || !render.visit.retired) &&
      this.visitIsExact(render.visit) &&
      render.visit.session === render.session &&
      render.state.visit === render.visit &&
      render.state.authority === render.authority &&
      render.state.open === render.open &&
      (selection
        ? selection.from === render.selectionFrom &&
          selection.to === render.selectionTo
        : render.selectionFrom === null && render.selectionTo === null) &&
      statsSnapshotIsExact(render.stats) &&
      (!render.selectionStats ||
        statsSnapshotIsExact(render.selectionStats)) &&
      goalSnapshotIsExact(render.goal) &&
      goalMatchesSnapshot(getGoal(render.session), render.goal) &&
      progressSnapshotIsExact(render.progress) &&
      render.session.canEdit === render.canEdit &&
      render.session.mode === render.mode &&
      render.shortcutLabel === shortcut("Mod-Shift-C") &&
      render.triggerTitle ===
        (render.goal.goal && render.progress.progress
          ? describeGoal(render.goal.goal, render.progress.progress)
          : `Document statistics (${render.shortcutLabel})`) &&
      render.triggerLabel ===
        (render.hydrated
          ? `${formatNumber(render.stats.words)} words`
          : "— words") &&
      render.selectionLabel ===
        (render.hydrated && render.selectionStats
          ? `${formatNumber(render.selectionStats.words)} of ${formatNumber(render.stats.words)} selected`
          : null) &&
      goalPresentationIsExact(render.goalPresentation) &&
      goalControlIdentitiesAreExact(render)
    );
  }

  factsMatch(publication: StatsDisclosurePublication) {
    const { render, current } = publication;
    return (
      current.ownsVisit(render.visit) &&
      (render.open
        ? current.ownsAuthority(render.authority)
        : render.authority === null && current.authority() === null) &&
      this.renderIsExact(render)
    );
  }

  ownsElement(
    publication: StatsDisclosurePublication,
    role: StatsElementRole,
    element: HTMLElement,
  ) {
    const owner = this.#elementOwners.get(element);
    const connection = publication.connections[role];
    return (
      owner?.publication === publication &&
      owner.publicationIdentity === publication.identity &&
      owner.role === role &&
      owner.connectionIdentity === connection?.identity &&
      connection.element === element &&
      publication.elements[role] === element
    );
  }

  ownsGoalControl(
    publication: StatsDisclosurePublication,
    connection: StatsGoalControlConnection,
  ) {
    const owner = this.#goalControlOwners.get(connection.element);
    return (
      owner?.publication === publication &&
      owner.publicationIdentity === publication.identity &&
      owner.controlIdentity === connection.controlIdentity &&
      owner.connectionIdentity === connection.identity &&
      publication.goalControls.get(connection.controlIdentity) ===
        connection
    );
  }

  goalControlsMatch(publication: StatsDisclosurePublication) {
    const { content } = publication.elements;
    const identities = publication.render.goalControls;
    if (!publication.render.open) {
      return publication.goalControls.size === 0;
    }
    const ownerWindow = content?.ownerDocument.defaultView;
    if (!content || !ownerWindow) return false;
    const selector = identities
      .map((identity) => `[data-testid="${identity.testId}"]`)
      .join(",");
    const domOrder = selector
      ? [...content.querySelectorAll<HTMLElement>(selector)]
      : [];
    if (
      publication.goalControls.size !== identities.length ||
      domOrder.length !== identities.length
    ) {
      return false;
    }
    return identities.every((identity, index) => {
      const connection = publication.goalControls.get(identity);
      const element = connection?.element;
      return Boolean(
        connection &&
          element &&
          connection.controlIdentity === identity &&
          identity.order === index &&
          domOrder[index] === element &&
          element instanceof ownerWindow.HTMLElement &&
          element.ownerDocument === content.ownerDocument &&
          element.isConnected &&
          content.contains(element) &&
          element.dataset.testid === identity.testId &&
          element.tagName === identity.tagName &&
          statsElementIsEnabled(element) === identity.enabled &&
          this.ownsGoalControl(publication, connection),
      );
    });
  }

  controlsMatch(publication: StatsDisclosurePublication) {
    const { render } = publication;
    const { trigger, content } = publication.elements;
    const ownerWindow = trigger?.ownerDocument.defaultView;
    if (
      !ownerWindow ||
      !(trigger instanceof ownerWindow.HTMLButtonElement) ||
      !trigger.isConnected ||
      trigger.type !== "button" ||
      !statsElementIsEnabled(trigger) ||
      !this.ownsElement(publication, "trigger", trigger) ||
      trigger.dataset.testid !== "stats-button" ||
      trigger.title !== render.triggerTitle ||
      trigger.querySelector('[data-testid="word-count"]')?.textContent !==
        render.triggerLabel
    ) {
      return false;
    }
    const selection = trigger.querySelector(
      '[data-testid="selection-count"]',
    );
    if (
      render.selectionLabel
        ? selection?.textContent?.trim() !== `· ${render.selectionLabel}`
        : selection !== null
    ) {
      return false;
    }
    if (!render.open) {
      return content === null && this.goalControlsMatch(publication);
    }
    return Boolean(
      content &&
        content instanceof ownerWindow.HTMLDivElement &&
        content.isConnected &&
        content.ownerDocument === trigger.ownerDocument &&
        this.ownsElement(publication, "content", content) &&
        content.dataset.testid === "stats-popover" &&
        content.dataset.state === "open" &&
        !trigger.contains(content) &&
        content.querySelector('[data-testid="stats-table"]') &&
        content.querySelector('[data-testid="goal-section"]') &&
        this.goalControlsMatch(publication),
    );
  }

  closingCallbackMatches(
    close: StatsCloseFocus,
    publication: StatsDisclosurePublication,
  ) {
    const { trigger, content } = publication.elements;
    const closingContent = close.publication.contentDom?.node;
    const ownerWindow = trigger?.ownerDocument.defaultView;
    return Boolean(
      closingContent &&
        ownerWindow &&
        trigger === close.trigger &&
        content === closingContent &&
        trigger instanceof ownerWindow.HTMLButtonElement &&
        content instanceof ownerWindow.HTMLDivElement &&
        trigger.isConnected &&
        content.isConnected &&
        content.ownerDocument === trigger.ownerDocument &&
        this.ownsElement(publication, "trigger", trigger) &&
        this.ownsElement(publication, "content", content) &&
        !publication.render.open &&
        publication.render.authority === null &&
        publication.render.state.visit === publication.render.visit &&
        publication.render.state.authority === null &&
        !publication.render.state.open &&
        content.dataset.testid === "stats-popover" &&
        content.dataset.state === "closed" &&
        !trigger.contains(content) &&
        close.publication.triggerPlacement &&
        statsPlacementStructureMatches(
          trigger,
          close.publication.triggerPlacement,
        ),
    );
  }

  publicationDomMatches(publication: StatsDisclosurePublication) {
    const { trigger, content } = publication.elements;
    return Boolean(
      publication.guard?.isClean() &&
        trigger &&
        publication.triggerDom &&
        publication.triggerPlacement &&
        trigger === publication.triggerDom.node &&
        statsPlacementMatches(trigger, publication.triggerPlacement) &&
        statsDomMatches(publication.triggerDom) &&
        (publication.render.open
          ? content &&
            publication.contentDom &&
            publication.contentPlacement &&
            content === publication.contentDom.node &&
            statsPlacementMatches(content, publication.contentPlacement) &&
            statsDomMatches(publication.contentDom)
          : !content &&
            !publication.contentDom &&
            !publication.contentPlacement),
    );
  }

  matches(
    publication: StatsDisclosurePublication,
    allowConsumed = false,
  ) {
    const current =
      this.#current === publication &&
      publication.established &&
      !publication.retired &&
      (allowConsumed || !publication.consumed);
    if (!current) return false;
    if (
      !this.factsMatch(publication) ||
      !this.controlsMatch(publication) ||
      !this.publicationDomMatches(publication)
    ) {
      this.retire(publication, "drift");
      return false;
    }
    return true;
  }

  exactRefReplay(
    publication: StatsDisclosurePublication,
    domain: StatsLayoutDomain,
  ) {
    const refs = publication.replayRefs.filter(
      (entry) => entry.domain === domain,
    );
    return (
      !publication.invalidReplay.has(domain) &&
      refs.length > 0 &&
      refs.every(
        (entry) => {
          const element =
            entry.role === "goal" && entry.goalIdentity
              ? publication.goalControls.get(entry.goalIdentity)?.element
              : entry.role !== "goal"
                ? publication.elements[entry.role]
                : null;
          return (
            entry.detached &&
            entry.reattached &&
            element === entry.element &&
            (entry.role === "goal" ||
              publication.connections[entry.role]?.element === entry.element)
          );
        },
      )
    );
  }

  replayDomMatches(replay: StatsReplay) {
    const trigger = replay.triggerDom.node;
    const content = replay.contentDom?.node ?? null;
    return Boolean(
      trigger instanceof HTMLElement &&
        statsPlacementMatches(trigger, replay.triggerPlacement) &&
        statsDomMatches(replay.triggerDom) &&
        (replay.contentDom
          ? content instanceof HTMLElement &&
            replay.contentPlacement &&
            statsPlacementMatches(content, replay.contentPlacement) &&
            statsDomMatches(replay.contentDom)
          : !replay.contentPlacement) &&
        replay.historyIsClean(),
    );
  }

  stageReplay(
    publication: StatsDisclosurePublication,
    domain: StatsLayoutDomain,
  ) {
    if (
      this.#successorOf !== publication ||
      publication.consumed ||
      !publication.layoutRetired.has(domain) ||
      !this.exactRefReplay(publication, domain) ||
      !publication.triggerDom ||
      !publication.triggerPlacement ||
      !publication.guard?.isClean() ||
      !this.renderIsExact(publication.render, true)
    ) {
      return;
    }
    if (!this.#replay) {
      this.#replay = Object.freeze({
        source: publication,
        triggerDom: publication.triggerDom,
        triggerPlacement: publication.triggerPlacement,
        contentDom: publication.contentDom,
        contentPlacement: publication.contentPlacement,
        historyIsClean: publication.guard.isClean,
        release: publication.guard.release,
      });
    }
    this.requestSuccessor(
      publication,
      publication.render.visit.retired,
    );
  }

  canPublish(publication: StatsDisclosurePublication) {
    const hasContent = publication.elements.content !== null;
    return (
      this.factsMatch(publication) &&
      this.controlsMatch(publication) &&
      (publication.render.open ? hasContent : !hasContent)
    );
  }

  baselineMatches(
    source: StatsDisclosurePublication,
    publication: StatsDisclosurePublication,
  ) {
    const trigger = publication.elements.trigger;
    const content = publication.elements.content;
    return Boolean(
      trigger &&
        source.triggerDom &&
        source.triggerPlacement &&
        trigger === source.triggerDom.node &&
        statsPlacementMatches(trigger, source.triggerPlacement) &&
        statsDomMatches(source.triggerDom) &&
        (source.contentDom
          ? content &&
            source.contentPlacement &&
            content === source.contentDom.node &&
            statsPlacementMatches(content, source.contentPlacement) &&
            statsDomMatches(source.contentDom)
          : !content),
    );
  }

  initialize(publication: StatsDisclosurePublication) {
    const { trigger, content } = publication.elements;
    const triggerPlacement = trigger
      ? captureStatsPlacement(trigger)
      : null;
    const contentPlacement = content
      ? captureStatsPlacement(content)
      : null;
    if (
      !trigger ||
      !triggerPlacement ||
      (publication.render.open && (!content || !contentPlacement))
    ) {
      return false;
    }
    const roots =
      publication.render.open && content
        ? [trigger, content]
        : [trigger];
    const placements =
      publication.render.open && contentPlacement
        ? [triggerPlacement, contentPlacement]
        : [triggerPlacement];
    const mutationGuard = createStatsMutationGuard(
      roots,
      placements,
      () => this.retire(publication, "mutation"),
    );
    const document = trigger.ownerDocument;
    const ownerWindow = document.defaultView;
    if (
      !mutationGuard ||
      !ownerWindow ||
      !this.ensureCapture(document, ownerWindow)
    ) {
      mutationGuard?.release();
      return false;
    }
    let released = false;
    publication.triggerDom = snapshotStatsDom(trigger);
    publication.triggerPlacement = triggerPlacement;
    publication.contentDom = content ? snapshotStatsDom(content) : null;
    publication.contentPlacement = contentPlacement;
    publication.focusDestination = publication.render.open
      ? publication.render.canEdit
        ? publication.goalControls.get(
            publication.render.goalControls[0]!,
          )?.element ?? null
        : content
      : null;
    publication.replayRefs = [
      {
        role: "trigger",
        goalIdentity: null,
        domain: "trigger",
        element: trigger,
        detached: false,
        reattached: false,
      },
      ...(content
        ? [
            {
              role: "content" as const,
              goalIdentity: null,
              domain: "portal" as const,
              element: content,
              detached: false,
              reattached: false,
            },
          ]
        : []),
      ...(publication.render.open
        ? publication.render.goalControls.map((identity) => ({
            role: "goal" as const,
            goalIdentity: identity,
            domain: "portal" as const,
            element: publication.goalControls.get(identity)!.element,
            detached: false,
            reattached: false,
          }))
        : []),
    ];
    publication.guard = Object.freeze({
      isClean: mutationGuard.isClean,
      deactivate: () => {},
      release: () => {
        if (released) return;
        released = true;
        mutationGuard.release();
      },
    });
    return true;
  }

  publish(publication: StatsDisclosurePublication) {
    const close = this.#closeFocus;
    const closesPendingDisclosure = Boolean(
      close &&
        statsCloseSuccessorMatches(
          close.publication.render,
          publication.render,
        ),
    );
    if (
      close &&
      !close.expected &&
      this.closingCallbackMatches(close, publication)
    ) {
      close.expected = publication;
    }
    if (close && !closesPendingDisclosure) {
      this.retireCloseFocus(close);
    }
    if (!this.canPublish(publication)) {
      if (
        closesPendingDisclosure &&
        close &&
        close.expected !== publication
      ) {
        this.retireCloseFocus(close);
      }
      return false;
    }
    const poisoned = this.#poisoned;
    if (poisoned) {
      if (statsRendersMatch(poisoned.render, publication.render)) {
        if (!this.baselineMatches(poisoned, publication)) {
          publication.retired = true;
          publication.retirement = "mutation";
          if (closesPendingDisclosure && close) {
            this.retireCloseFocus(close);
          }
          return false;
        }
      }
      poisoned.guard?.release();
      this.#poisoned = null;
    }

    const replay = this.#replay;
    if (replay) {
      const sameGeneration = statsRendersMatch(
        replay.source.render,
        publication.render,
      );
      const exact =
        sameGeneration &&
        this.#successorOf === replay.source &&
        replay.source.retired &&
        !replay.source.consumed &&
        this.replayDomMatches(replay) &&
        publication.elements.trigger === replay.triggerDom.node &&
        publication.elements.content ===
          (replay.contentDom?.node ?? null);
      this.#replay = null;
      replay.release();
      if (this.#successorOf === replay.source) {
        this.#successorOf = null;
      }
      if (sameGeneration && !exact) {
        publication.retired = true;
        publication.retirement = "other";
        if (closesPendingDisclosure && close) {
          this.retireCloseFocus(close);
        }
        this.requestSuccessor(publication);
        return false;
      }
    }

    const previous = this.#current;
    if (previous && previous !== publication) {
      this.retire(previous, "other");
    }
    if (!this.initialize(publication)) {
      publication.retired = true;
      publication.retirement = "other";
      if (closesPendingDisclosure && close) {
        this.retireCloseFocus(close);
      }
      return false;
    }
    publication.established = true;
    this.#current = publication;
    this.#successorOf = null;
    if (closesPendingDisclosure && close && this.#closeFocus === close) {
      if (!close.expected) {
        close.expected = publication;
      } else if (
        !statsClosedSuccessorsMatch(
          close.expected.render,
          publication.render,
        )
      ) {
        this.retireCloseFocus(close);
      }
    }
    return true;
  }

  establish(
    publication: StatsDisclosurePublication,
    domain: StatsLayoutDomain,
  ) {
    publication.layoutEstablished.add(domain);
    if (publication.retired) {
      this.stageReplay(publication, domain);
      return;
    }
    const required: StatsLayoutDomain[] = publication.render.open
      ? ["trigger", "portal"]
      : ["trigger"];
    if (
      required.every((value) =>
        publication.layoutEstablished.has(value),
      )
    ) {
      this.publish(publication);
    }
  }

  forgetProvenance(event: Event) {
    const provenance = this.#nativeProvenance.get(event);
    if (!provenance) return;
    provenance.ownerWindow.clearTimeout(provenance.timeoutId);
    this.#nativeProvenance.delete(event);
    this.#provenanceRecords.delete(provenance);
    if (this.#pointerProvenance === provenance) {
      this.#pointerProvenance = null;
    }
  }

  authorityForTransition(
    publication: StatsDisclosurePublication,
    nextOpen: boolean,
  ) {
    const { render } = publication;
    if (nextOpen) {
      if (
        render.open ||
        render.authority ||
        publication.current.authority()
      ) {
        return null;
      }
      const authority: StatsDisclosureAuthority = {
        identity: Symbol("stats-disclosure"),
        visit: render.visit,
        claimedEvents: new WeakSet<object>(),
        retired: false,
      };
      return publication.current.canPublishAuthority(authority)
        ? authority
        : null;
    }
    return render.open &&
      render.authority &&
      publication.current.ownsAuthority(render.authority)
      ? render.authority
      : null;
  }

  claimTransition(
    publication: StatsDisclosurePublication,
    authority: StatsDisclosureAuthority,
    event: object,
    nativeEvent: Event,
    relatedEvent?: Event,
  ) {
    if (
      publication.consumed ||
      this.#claimedEvents.has(event) ||
      this.#claimedEvents.has(nativeEvent) ||
      (relatedEvent !== undefined &&
        this.#claimedEvents.has(relatedEvent)) ||
      publication.render.visit.claimedEvents.has(nativeEvent) ||
      (relatedEvent !== undefined &&
        publication.render.visit.claimedEvents.has(relatedEvent)) ||
      authority.claimedEvents.has(nativeEvent) ||
      (relatedEvent !== undefined &&
        authority.claimedEvents.has(relatedEvent)) ||
      !this.matches(publication)
    ) {
      return false;
    }
    publication.consumed = true;
    this.#claimedEvents.add(event);
    this.#claimedEvents.add(nativeEvent);
    publication.render.visit.claimedEvents.add(nativeEvent);
    authority.claimedEvents.add(nativeEvent);
    if (relatedEvent !== undefined) {
      this.#claimedEvents.add(relatedEvent);
      publication.render.visit.claimedEvents.add(relatedEvent);
      authority.claimedEvents.add(relatedEvent);
    }
    this.forgetProvenance(nativeEvent);
    return true;
  }

  publishProof(
    publication: StatsDisclosurePublication,
    authority: StatsDisclosureAuthority,
    nextOpen: boolean,
    source: StatsDisclosureProof["source"],
    event: object,
    nativeEvent: Event,
  ) {
    this.clearProof();
    const ownerWindow =
      publication.elements.trigger?.ownerDocument.defaultView;
    if (!ownerWindow) return;
    const proof: StatsDisclosureProof = {
      publication,
      authority,
      nextOpen,
      source,
      event,
      nativeEvent,
      ownerWindow,
      timeoutId: 0,
    };
    this.#proof = proof;
    proof.timeoutId = ownerWindow.setTimeout(() => {
      if (this.#proof !== proof) return;
      this.#proof = null;
      this.requestSuccessor(publication);
    }, 0);
  }

  commitTransition(proof: StatsDisclosureProof) {
    const { publication, authority, nextOpen, source } = proof;
    const { render } = publication;
    const trigger = publication.elements.trigger;
    if (!trigger || !this.matches(publication, true)) return false;
    if (nextOpen) {
      const directional =
        source === "directional" &&
        this.#directionalIntent?.publication === publication &&
        this.#directionalIntent.authority === authority
          ? this.#directionalIntent
          : null;
      if (
        source === "directional" &&
        (!directional ||
          !directional.native.claimed ||
          !directional.native.listener.claimed ||
          !this.#claimedEvents.has(directional.native.listener) ||
          !this.directionalListenerIsCurrent(directional.native))
      ) {
        return false;
      }
      if (!publication.current.publishAuthority(authority)) return false;
      this.#openFocus = { visit: render.visit, authority, directional };
      if (!directional) this.#directionalIntent = null;
      this.retireCloseFocus();
    } else {
      if (!publication.current.ownsAuthority(authority)) return false;
      this.retireCloseFocus();
      this.#closeFocus = {
        publication,
        visit: render.visit,
        authority,
        source,
        trigger,
        expected: null,
        claimed: false,
      };
      this.#openFocus = null;
      this.#directionalIntent = null;
      if (!publication.current.retireAuthority(authority)) return false;
    }
    const nextState = Object.freeze({
      visit: render.visit,
      authority: nextOpen ? authority : null,
      open: nextOpen,
    });
    render.commitState(render.state, nextState);
    return true;
  }

  consumeProof(
    publication: StatsDisclosurePublication,
    nextOpen: boolean,
  ) {
    const proof = this.#proof;
    if (
      !proof ||
      proof.publication !== publication ||
      proof.nextOpen !== nextOpen ||
      proof.authority.visit !== publication.render.visit ||
      proof.authority.retired
    ) {
      return false;
    }
    this.clearProof(proof);
    return this.commitTransition(proof);
  }

  directionalListenerIsCurrent(
    native: StatsDirectionalNativeEvent,
  ) {
    const listener = native.listener;
    const registration = listener.registration;
    const capture = this.#capture;
    return Boolean(
      capture &&
        capture.windowKeyRegistration === registration &&
        capture.document === native.ownerDocument &&
        capture.ownerWindow === native.ownerWindow &&
        capture.keyboardAuthority === native.keyboardAuthority &&
        registration.active &&
        !registration.removed &&
        registration.document === native.ownerDocument &&
        registration.target === native.ownerWindow &&
        registration.keyboardAuthority === native.keyboardAuthority &&
        registration.listener === listener.listener &&
        registration.addEventListener ===
          native.keyboardAuthority.addEventListener.value &&
        registration.removeEventListener ===
          native.keyboardAuthority.removeEventListener.value &&
        native.keyboardAuthority.addEventListener.isCurrent() &&
        native.keyboardAuthority.removeEventListener.isCurrent() &&
        listener.publication === native.publication &&
        listener.event === native.event &&
        listener.receiver === listener.currentTarget &&
        listener.receiver === listener.intrinsicCurrentTarget &&
        listener.receiver === listener.terminal &&
        native.currentTarget === listener.currentTarget &&
        native.intrinsicCurrentTarget ===
          listener.intrinsicCurrentTarget &&
        native.path.at(-1) === listener.terminal,
    );
  }

  directionalNativeIsExact(
    publication: StatsDisclosurePublication,
    native: StatsDirectionalNativeEvent,
    direction: StatsFocusDirection,
  ) {
    const event = native.event;
    const trigger = publication.elements.trigger;
    const { keyboardAuthority, ownerDocument, ownerWindow } = native;
    const key = direction === "first" ? "ArrowDown" : "ArrowUp";
    return Boolean(
      trigger &&
        this.#current === publication &&
        native.publication === publication &&
        this.directionalListenerIsCurrent(native) &&
        !native.listener.claimed &&
        native.ownerDocument === trigger.ownerDocument &&
        native.ownerWindow === trigger.ownerDocument.defaultView &&
        native.ownerWindow === keyboardAuthority.ownerWindow &&
        keyboardAuthority.ownerWindow === ownerWindow &&
        keyboardAuthority.isCurrent() &&
        keyboardAuthority.getPrototypeOf(event) ===
          keyboardAuthority.keyboardPrototype &&
        keyboardAuthority.isTrusted.matches(event) &&
        keyboardAuthority.isTrusted.read(event) &&
        !keyboardAuthority.getOwnPropertyDescriptor(
          event,
          "preventDefault",
        ) &&
        !keyboardAuthority.getOwnPropertyDescriptor(
          event,
          "stopPropagation",
        ) &&
        !keyboardAuthority.getOwnPropertyDescriptor(
          event,
          "stopImmediatePropagation",
        ) &&
        !native.claimed &&
        native.trusted &&
        native.type === "keydown" &&
        native.target === trigger &&
        native.currentTarget === native.listener.receiver &&
        native.intrinsicCurrentTarget === native.listener.receiver &&
        native.path.at(-1) === native.listener.receiver &&
        native.phase === ownerWindow.Event.CAPTURING_PHASE &&
        native.bubbles &&
        native.cancelable &&
        native.composed &&
        !native.defaultPrevented &&
        !native.cancelBubble &&
        native.key === key &&
        native.code === key &&
        native.ctrlKey === false &&
        native.metaKey === false &&
        native.altKey === false &&
        native.shiftKey === false &&
        native.repeat === false &&
        native.composing === false &&
        (native.view === null ||
          Object.is(native.view, native.listener.receiver)) &&
        (native.intrinsicView === null ||
          Object.is(native.intrinsicView, native.listener.receiver)) &&
        Object.is(native.view, native.intrinsicView) &&
        statsEventPathIsExact(
          trigger,
          native.path,
          ownerDocument,
          native.listener.receiver,
        ) &&
        keyboardAuthority.eventType.read(event) === native.type &&
        keyboardAuthority.eventTarget.read(event) === native.target &&
        keyboardAuthority.eventBubbles.read(event) === native.bubbles &&
        keyboardAuthority.eventCancelable.read(event) ===
          native.cancelable &&
        keyboardAuthority.eventComposed.read(event) === native.composed &&
        keyboardAuthority.eventDefaultPrevented.read(event) ===
          native.defaultPrevented &&
        keyboardAuthority.eventCancelBubble.read(event) ===
          native.cancelBubble &&
        keyboardAuthority.eventTimeStamp.read(event) === native.timeStamp &&
        keyboardAuthority
          .eventPath
          .call(event)
          .every((value, index, path) =>
            path.length === native.path.length &&
            value === native.path[index],
          ) &&
        Object.is(
          keyboardAuthority.eventView.read(event),
          native.intrinsicView,
        ) &&
        keyboardAuthority.keyboardKey.read(event) === native.key &&
        keyboardAuthority.keyboardCode.read(event) === native.code &&
        keyboardAuthority.keyboardCtrl.read(event) === native.ctrlKey &&
        keyboardAuthority.keyboardMeta.read(event) === native.metaKey &&
        keyboardAuthority.keyboardAlt.read(event) === native.altKey &&
        keyboardAuthority.keyboardShift.read(event) === native.shiftKey &&
        keyboardAuthority.keyboardRepeat.read(event) === native.repeat &&
        keyboardAuthority.keyboardComposing.read(event) ===
          native.composing &&
        keyboardAuthority.activeElement.read(ownerDocument) === trigger,
    );
  }

  directionalReactIsExact(
    publication: StatsDisclosurePublication,
    react: StatsDirectionalReactEvent,
    direction: StatsFocusDirection,
  ) {
    const event = react.event;
    const native = react.native;
    const { keyboardAuthority, ownerWindow } = native;
    const key = direction === "first" ? "ArrowDown" : "ArrowUp";
    const phase =
      react.boundary === "capture"
        ? ownerWindow.Event.CAPTURING_PHASE
        : ownerWindow.Event.BUBBLING_PHASE;
    return (
      react.currentTarget === publication.elements.trigger &&
      react.target === publication.elements.trigger &&
      event.nativeEvent === native.event &&
      event.currentTarget === react.currentTarget &&
      event.target === react.target &&
      event.type === react.type &&
      event.eventPhase === react.phase &&
      event.bubbles === react.bubbles &&
      event.cancelable === react.cancelable &&
      event.defaultPrevented === react.defaultPrevented &&
      event.isTrusted === react.trusted &&
      event.timeStamp === react.timeStamp &&
      Object.is(event.view, react.view) &&
      (event.view === null ||
        Object.is(event.view, native.listener.receiver)) &&
      Object.is(event.view, native.intrinsicView) &&
      event.key === react.key &&
      event.code === react.code &&
      event.ctrlKey === react.ctrlKey &&
      event.metaKey === react.metaKey &&
      event.altKey === react.altKey &&
      event.shiftKey === react.shiftKey &&
      event.repeat === react.repeat &&
      ("isComposing" in event
        ? event.isComposing === react.composing
        : react.composing === undefined) &&
      react.type === "keydown" &&
      react.phase === phase &&
      react.bubbles &&
      react.cancelable &&
      !react.defaultPrevented &&
      react.trusted &&
      react.key === key &&
      react.code === key &&
      react.ctrlKey === false &&
      react.metaKey === false &&
      react.altKey === false &&
      react.shiftKey === false &&
      react.repeat === false &&
      (react.composing === undefined || react.composing === false) &&
      event.preventDefault === react.preventDefault &&
      event.stopPropagation === react.stopPropagation &&
      event.isDefaultPrevented === react.isDefaultPrevented &&
      event.isPropagationStopped === react.isPropagationStopped &&
      !keyboardAuthority.apply(
        event.isDefaultPrevented,
        event,
        [],
      ) &&
      !keyboardAuthority.apply(
        event.isPropagationStopped,
        event,
        [],
      )
    );
  }

  directionalReactSnapshot(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    native: StatsDirectionalNativeEvent,
    boundary: StatsDirectionalReactEvent["boundary"],
  ): StatsDirectionalReactEvent {
    return {
      event,
      native,
      boundary,
      currentTarget: event.currentTarget,
      target: event.target,
      type: event.type,
      phase: event.eventPhase,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      trusted: event.isTrusted,
      timeStamp: event.timeStamp,
      view: event.view,
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      composing:
        "isComposing" in event &&
        typeof event.isComposing === "boolean"
          ? event.isComposing
          : undefined,
      preventDefault: event.preventDefault,
      stopPropagation: event.stopPropagation,
      isDefaultPrevented: event.isDefaultPrevented,
      isPropagationStopped: event.isPropagationStopped,
      claimed: false,
    };
  }

  captureDirectional(
    publication: StatsDisclosurePublication,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    const native = this.#directionalNativeEvents.get(event.nativeEvent);
    const keyboardAuthority =
      native?.keyboardAuthority ?? this.#capture?.keyboardAuthority;
    if (!keyboardAuthority) return;
    const wrapperAuthority =
      publication.reactWrapperAuthority ??
      captureStatsReactWrapperAuthority(event, keyboardAuthority);
    if (!wrapperAuthority || !wrapperAuthority.isCurrent(event)) {
      this.retire(publication, "other");
      return;
    }
    publication.reactWrapperAuthority = wrapperAuthority;
    const direction =
      event.key === "ArrowDown"
        ? "first"
        : event.key === "ArrowUp"
          ? "last"
          : null;
    if (
      !direction ||
      !native ||
      publication.render.open ||
      this.#directionalCaptureEvents.has(native.event)
    ) {
      return;
    }
    const capture = this.directionalReactSnapshot(
      event,
      native,
      "capture",
    );
    if (
      !this.directionalNativeIsExact(
        publication,
        native,
        direction,
      ) ||
      !this.directionalReactIsExact(
        publication,
        capture,
        direction,
      ) ||
      !this.matches(publication)
    ) {
      return;
    }
    this.#directionalCaptureEvents.set(native.event, capture);
  }

  consumeDirectional(
    publication: StatsDisclosurePublication,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    const direction =
      event.key === "ArrowDown"
        ? "first"
        : event.key === "ArrowUp"
          ? "last"
          : null;
    if (!direction || publication.render.open) return;
    const native = this.#directionalNativeEvents.get(event.nativeEvent);
    const capture = native
      ? this.#directionalCaptureEvents.get(native.event)
      : null;
    if (!native || this.#directionalReactEvents.has(event)) return;
    const bubble = this.directionalReactSnapshot(
      event,
      native,
      "bubble",
    );
    const enabled = publication.render.goalControls.filter(
      (identity) => identity.enabled,
    );
    const destination =
      direction === "first" ? enabled[0] : enabled.at(-1);
    const trigger = publication.elements.trigger;
    const keyboardAuthority = native.keyboardAuthority;
    const authority = this.authorityForTransition(publication, true);
    if (
      !destination ||
      !capture ||
      !trigger ||
      !authority ||
      native.publication !== publication ||
      native.event !== event.nativeEvent ||
      native.ownerDocument !== trigger.ownerDocument ||
      native.ownerWindow !== trigger.ownerDocument.defaultView ||
      !this.directionalListenerIsCurrent(native) ||
      this.#claimedEvents.has(native.listener) ||
      this.#claimedDirections.has(native) ||
      this.#claimedDestinations.has(destination) ||
      capture.event === bubble.event ||
      this.#directionalReactEvents.has(capture.event) ||
      this.#directionalReactEvents.has(bubble.event) ||
      !goalControlIdentitiesAreExact(publication.render) ||
      !this.directionalNativeIsExact(
        publication,
        native,
        direction,
      ) ||
      !this.directionalReactIsExact(
        publication,
        bubble,
        direction,
      ) ||
      publication.reactWrapperAuthority === null ||
      !publication.reactWrapperAuthority.isCurrent(
        bubble.event,
      ) ||
      !this.matches(publication)
    ) {
      if (!keyboardAuthority.isCurrent()) {
        this.retire(publication, "other");
      }
      return;
    }
    const intent: StatsDirectionalFocusIntent = {
      publication,
      visit: publication.render.visit,
      authority,
      direction,
      destination,
      native,
      capture,
      bubble,
      keyboardAuthority,
      trigger,
      ownerDocument: native.ownerDocument,
      ownerWindow: native.ownerWindow,
      claimed: false,
    };
    if (
      !this.claimTransition(
        publication,
        authority,
        event,
        native.event,
      )
    ) {
      return;
    }
    native.claimed = true;
    native.listener.claimed = true;
    capture.claimed = true;
    bubble.claimed = true;
    this.#claimedEvents.add(native.listener);
    publication.render.visit.claimedEvents.add(native.listener);
    authority.claimedEvents.add(native.listener);
    this.#claimedEvents.add(capture.event);
    publication.render.visit.claimedEvents.add(capture.event);
    authority.claimedEvents.add(capture.event);
    this.#claimedDirections.add(native);
    this.#claimedDestinations.add(destination);
    this.#directionalReactEvents.add(capture.event);
    this.#directionalReactEvents.add(bubble.event);
    this.#directionalIntent = intent;
    keyboardAuthority.apply(bubble.preventDefault, event, []);
    if (
      !keyboardAuthority.eventDefaultPrevented.read(native.event) ||
      !keyboardAuthority.apply(event.isDefaultPrevented, event, []) ||
      !this.directionalListenerIsCurrent(native) ||
      this.#directionalIntent !== intent
    ) {
      this.#directionalIntent = null;
      this.requestSuccessor(publication);
      return;
    }
    const proof: StatsDisclosureProof = {
      publication,
      authority,
      nextOpen: true,
      source: "directional",
      event,
      nativeEvent: native.event,
      ownerWindow: native.ownerWindow,
      timeoutId: 0,
    };
    if (!this.commitTransition(proof)) {
      this.#directionalIntent = null;
      this.requestSuccessor(publication);
    }
  }

  goalActionNativeIsExact(
    disclosure: StatsDisclosurePublication,
    goal: GoalPublication,
    native: StatsDirectionalNativeEvent,
    sourceIdentity: StatsGoalControlIdentity,
    allowClaimed = false,
  ) {
    const source =
      sourceIdentity.key === "set"
        ? goal.setButton
        : sourceIdentity.key === "clear"
          ? goal.clearButton
          : null;
    const connection = disclosure.goalControls.get(sourceIdentity);
    const content = disclosure.elements.content;
    const event = native.event;
    const { keyboardAuthority, ownerDocument, ownerWindow } = native;
    return Boolean(
      source &&
        connection &&
        content &&
        disclosure.render.open &&
        disclosure.render.authority &&
        disclosure.current.ownsAuthority(disclosure.render.authority) &&
        goal.presentation === disclosure.render.goalPresentation &&
        goal.generation.presentation === goal.presentation &&
        sourceIdentity.enabled &&
        disclosure.render.goalControls.includes(sourceIdentity) &&
        connection.controlIdentity === sourceIdentity &&
        connection.element === source &&
        this.ownsGoalControl(disclosure, connection) &&
        statsElementIsEnabled(source) &&
        goal.actions.contains(source) &&
        content.contains(goal.actions) &&
        this.#current === disclosure &&
        native.publication === disclosure &&
        this.directionalListenerIsCurrent(native) &&
        (allowClaimed
          ? native.listener.claimed &&
            this.#claimedEvents.has(native.listener)
          : !native.listener.claimed) &&
        native.ownerDocument === source.ownerDocument &&
        native.ownerDocument === content.ownerDocument &&
        native.ownerWindow === source.ownerDocument.defaultView &&
        native.ownerWindow === keyboardAuthority.ownerWindow &&
        keyboardAuthority.ownerWindow === ownerWindow &&
        keyboardAuthority.isCurrent() &&
        keyboardAuthority.getPrototypeOf(event) ===
          keyboardAuthority.keyboardPrototype &&
        keyboardAuthority.isTrusted.matches(event) &&
        keyboardAuthority.isTrusted.read(event) &&
        !keyboardAuthority.getOwnPropertyDescriptor(
          event,
          "preventDefault",
        ) &&
        !keyboardAuthority.getOwnPropertyDescriptor(
          event,
          "stopPropagation",
        ) &&
        !keyboardAuthority.getOwnPropertyDescriptor(
          event,
          "stopImmediatePropagation",
        ) &&
        (allowClaimed ? native.claimed : !native.claimed) &&
        native.trusted &&
        native.type === "keydown" &&
        native.target === source &&
        native.currentTarget === native.listener.receiver &&
        native.intrinsicCurrentTarget === native.listener.receiver &&
        native.path.at(-1) === native.listener.receiver &&
        native.phase === ownerWindow.Event.CAPTURING_PHASE &&
        native.bubbles &&
        native.cancelable &&
        native.composed &&
        !native.defaultPrevented &&
        !native.cancelBubble &&
        statsGoalActionNavigationKey(native.key) &&
        native.ctrlKey === false &&
        native.metaKey === false &&
        native.altKey === false &&
        native.shiftKey === false &&
        native.repeat === false &&
        native.composing === false &&
        (native.view === null ||
          native.view === ownerWindow ||
          native.view === native.listener.receiver) &&
        (native.intrinsicView === null ||
          native.intrinsicView === ownerWindow ||
          native.intrinsicView === native.listener.receiver) &&
        Object.is(native.view, native.intrinsicView) &&
        statsEventPathIsExact(
          source,
          native.path,
          ownerDocument,
          native.listener.receiver,
        ) &&
        keyboardAuthority.eventType.read(event) === native.type &&
        keyboardAuthority.eventTarget.read(event) === native.target &&
        keyboardAuthority.eventBubbles.read(event) === native.bubbles &&
        keyboardAuthority.eventCancelable.read(event) ===
          native.cancelable &&
        keyboardAuthority.eventComposed.read(event) === native.composed &&
        keyboardAuthority.eventDefaultPrevented.read(event) ===
          native.defaultPrevented &&
        keyboardAuthority.eventCancelBubble.read(event) ===
          native.cancelBubble &&
        keyboardAuthority.eventTimeStamp.read(event) === native.timeStamp &&
        keyboardAuthority
          .eventPath
          .call(event)
          .every(
            (value, index, path) =>
              path.length === native.path.length &&
              value === native.path[index],
          ) &&
        Object.is(
          keyboardAuthority.eventView.read(event),
          native.intrinsicView,
        ) &&
        keyboardAuthority.keyboardKey.read(event) === native.key &&
        keyboardAuthority.keyboardCode.read(event) === native.code &&
        keyboardAuthority.keyboardLocation.read(event) ===
          native.location &&
        keyboardAuthority.keyboardCtrl.read(event) === native.ctrlKey &&
        keyboardAuthority.keyboardMeta.read(event) === native.metaKey &&
        keyboardAuthority.keyboardAlt.read(event) === native.altKey &&
        keyboardAuthority.keyboardShift.read(event) === native.shiftKey &&
        keyboardAuthority.keyboardRepeat.read(event) === native.repeat &&
        keyboardAuthority.keyboardComposing.read(event) ===
          native.composing &&
        keyboardAuthority.activeElement.read(ownerDocument) === source &&
        goalPublicationDomIsExact(goal, null) &&
        this.matches(disclosure, allowClaimed),
    );
  }

  readGoalActionDelivery<T extends HTMLElement>(
    disclosure: StatsDisclosurePublication,
    goal: GoalPublication,
    event: ReactKeyboardEvent<T>,
    currentTarget: HTMLElement,
    expectedPhase: number,
  ): StatsGoalActionDelivery | null {
    const native = this.#directionalNativeEvents.get(event.nativeEvent);
    const keyboardAuthority =
      native?.keyboardAuthority ?? this.#capture?.keyboardAuthority;
    if (!native || !keyboardAuthority) return null;
    const sourceIdentity = disclosure.render.goalControls.find(
      (identity) =>
        (identity.key === "set" || identity.key === "clear") &&
        disclosure.goalControls.get(identity)?.element === native.target,
    );
    const source = sourceIdentity
      ? disclosure.goalControls.get(sourceIdentity)?.element
      : null;
    const dispatchTarget =
      keyboardAuthority.eventCurrentTarget.read(native.event);
    const nativePhase = keyboardAuthority.eventPhase.read(native.event);
    const wrapper = event as ReactKeyboardEvent<HTMLElement>;
    const composing =
      "isComposing" in wrapper &&
      typeof wrapper.isComposing === "boolean"
        ? wrapper.isComposing
        : undefined;
    let methods: StatsGoalActionReactMethods;
    try {
      methods = Object.freeze({
        preventDefault: wrapper.preventDefault,
        isDefaultPrevented: wrapper.isDefaultPrevented,
        isPropagationStopped: wrapper.isPropagationStopped,
      });
    } catch {
      return null;
    }
    if (
      !sourceIdentity ||
      !(source instanceof keyboardAuthority.ownerWindow.HTMLButtonElement) ||
      !dispatchTarget ||
      !statsGoalActionNavigationKey(native.key) ||
      nativePhase !== expectedPhase ||
      !native.path.includes(dispatchTarget) ||
      native.path.filter((value) => value === dispatchTarget).length !== 1 ||
      !this.goalActionNativeIsExact(
        disclosure,
        goal,
        native,
        sourceIdentity,
      ) ||
      wrapper === (native.event as unknown) ||
      wrapper.nativeEvent !== native.event ||
      wrapper.currentTarget !== currentTarget ||
      wrapper.target !== source ||
      wrapper.type !== native.type ||
      wrapper.eventPhase !== expectedPhase ||
      wrapper.bubbles !== native.bubbles ||
      wrapper.cancelable !== native.cancelable ||
      wrapper.defaultPrevented !== native.defaultPrevented ||
      wrapper.isTrusted !== native.trusted ||
      wrapper.key !== native.key ||
      wrapper.code !== native.code ||
      wrapper.location !== native.location ||
      wrapper.ctrlKey !== native.ctrlKey ||
      wrapper.metaKey !== native.metaKey ||
      wrapper.altKey !== native.altKey ||
      wrapper.shiftKey !== native.shiftKey ||
      wrapper.repeat !== native.repeat ||
      (composing !== undefined && composing !== native.composing) ||
      !Object.is(wrapper.view, native.intrinsicView) ||
      !statsReactPublicMethodMatches(
        wrapper,
        "preventDefault",
        methods.preventDefault,
        keyboardAuthority,
      ) ||
      !statsReactPublicMethodMatches(
        wrapper,
        "isDefaultPrevented",
        methods.isDefaultPrevented,
        keyboardAuthority,
      ) ||
      !statsReactPublicMethodMatches(
        wrapper,
        "isPropagationStopped",
        methods.isPropagationStopped,
        keyboardAuthority,
      )
    ) {
      return null;
    }
    try {
      if (
        keyboardAuthority.apply(
          methods.isDefaultPrevented,
          wrapper,
          [],
        ) !== false ||
        keyboardAuthority.apply(
          methods.isPropagationStopped,
          wrapper,
          [],
        ) !== false
      ) {
        return null;
      }
    } catch {
      return null;
    }
    return Object.freeze({
      disclosure,
      goal,
      wrapper,
      methods,
      native,
      currentTarget,
      dispatchTarget,
      source,
      sourceIdentity,
      key: native.key,
      type: wrapper.type,
      phase: wrapper.eventPhase,
      bubbles: wrapper.bubbles,
      cancelable: wrapper.cancelable,
      defaultPrevented: wrapper.defaultPrevented,
      trusted: wrapper.isTrusted,
      view: wrapper.view,
      code: wrapper.code,
      location: wrapper.location,
      ctrlKey: wrapper.ctrlKey,
      metaKey: wrapper.metaKey,
      altKey: wrapper.altKey,
      shiftKey: wrapper.shiftKey,
      repeat: wrapper.repeat,
      composing,
    });
  }

  claimGoalActionMovement(
    movement: StatsGoalActionMovement,
    groupCapture: StatsGoalActionDelivery,
    actionCapture: StatsGoalActionDelivery,
    actionBubble: StatsGoalActionDelivery,
    groupBubble: StatsGoalActionDelivery,
  ): StatsGoalActionClaim | null {
    const { disclosure, goal, source, destination } = movement;
    const native = groupBubble.native;
    const sourceConnection = disclosure.goalControls.get(source);
    const destinationConnection =
      disclosure.goalControls.get(destination);
    if (
      this.#claimedGoalPublications.has(goal) ||
      this.#claimedGoalGenerations.has(goal.generation) ||
      this.#claimedGoalMovements.has(movement) ||
      this.#claimedEvents.has(native.event) ||
      this.#claimedEvents.has(native.listener) ||
      this.#claimedEvents.has(groupCapture.wrapper) ||
      this.#claimedEvents.has(groupBubble.wrapper) ||
      this.#claimedDirections.has(native) ||
      !sourceConnection ||
      !destinationConnection ||
      sourceConnection === destinationConnection ||
      this.#claimedGoalConnections.has(sourceConnection) ||
      this.#claimedGoalConnections.has(destinationConnection) ||
      disclosure.consumed ||
      goal.claimed ||
      movement.key !== groupBubble.key ||
      groupBubble.sourceIdentity !== source ||
      !statsGoalActionDeliveriesMatchWithinPhase(
        groupCapture,
        actionCapture,
      ) ||
      !statsGoalActionDeliveriesMatchWithinPhase(
        actionBubble,
        groupBubble,
      ) ||
      !statsGoalActionDeliveriesMatchAcrossPhases(
        actionCapture,
        actionBubble,
      ) ||
      !statsGoalActionMethodsRemainFalse(groupCapture) ||
      !statsGoalActionMethodsRemainFalse(actionCapture) ||
      !statsGoalActionMethodsRemainFalse(actionBubble) ||
      !statsGoalActionMethodsRemainFalse(groupBubble) ||
      !this.goalActionNativeIsExact(
        disclosure,
        goal,
        native,
        source,
      ) ||
      !this.ownsGoalControl(disclosure, sourceConnection) ||
      !this.ownsGoalControl(disclosure, destinationConnection) ||
      !source.enabled ||
      !destination.enabled ||
      !statsElementIsEnabled(sourceConnection.element) ||
      !statsElementIsEnabled(destinationConnection.element) ||
      native.keyboardAuthority.activeElement.read(
        native.ownerDocument,
      ) !== sourceConnection.element
    ) {
      return null;
    }
    disclosure.consumed = true;
    goal.claimed = true;
    native.claimed = true;
    native.listener.claimed = true;
    sourceConnection.claimed = true;
    destinationConnection.claimed = true;
    this.#claimedGoalPublications.add(goal);
    this.#claimedGoalGenerations.add(goal.generation);
    this.#claimedGoalMovements.add(movement);
    this.#claimedGoalConnections.add(sourceConnection);
    this.#claimedGoalConnections.add(destinationConnection);
    this.#claimedDirections.add(native);
    for (const claimed of [
      native.event,
      native.listener,
      groupCapture.wrapper,
      groupBubble.wrapper,
    ]) {
      this.#claimedEvents.add(claimed);
      disclosure.render.visit.claimedEvents.add(claimed);
      disclosure.render.authority?.claimedEvents.add(claimed);
    }
    this.#directionalReactEvents.add(groupCapture.wrapper);
    this.#directionalReactEvents.add(groupBubble.wrapper);
    return Object.freeze({
      movement,
      native,
      groupCapture,
      actionCapture,
      actionBubble,
      groupBubble,
      source: sourceConnection,
      destination: destinationConnection,
    });
  }

  performGoalActionMovement(
    claim: StatsGoalActionClaim,
    goalPublicationIsCurrent: () => boolean,
  ) {
    const {
      movement,
      native,
      groupCapture,
      actionCapture,
      actionBubble,
      groupBubble,
      source,
      destination,
    } = claim;
    const { disclosure, goal } = movement;
    const keyboardAuthority = native.keyboardAuthority;
    const reject = () => {
      this.requestSuccessor(disclosure);
      return false;
    };
    const enabledActions = disclosure.render.goalControls.filter(
      (identity) =>
        (identity.key === "set" || identity.key === "clear") &&
        identity.enabled,
    );
    if (
      !this.#claimedGoalPublications.has(goal) ||
      !this.#claimedGoalGenerations.has(goal.generation) ||
      !this.#claimedGoalMovements.has(movement) ||
      !this.#claimedGoalConnections.has(source) ||
      !this.#claimedGoalConnections.has(destination) ||
      !this.#claimedDirections.has(native) ||
      !this.#claimedEvents.has(native.event) ||
      !this.#claimedEvents.has(native.listener) ||
      !this.#claimedEvents.has(groupCapture.wrapper) ||
      !this.#claimedEvents.has(groupBubble.wrapper) ||
      !this.#directionalReactEvents.has(groupCapture.wrapper) ||
      !this.#directionalReactEvents.has(groupBubble.wrapper) ||
      !disclosure.consumed ||
      !goal.claimed ||
      !native.claimed ||
      !native.listener.claimed ||
      !source.claimed ||
      !destination.claimed ||
      groupCapture.wrapper === groupBubble.wrapper ||
      movement.source !== groupBubble.sourceIdentity ||
      statsGoalActionDestination(
        enabledActions,
        movement.source,
        movement.key,
      ) !== movement.destination ||
      disclosure.goalControls.get(movement.source) !== source ||
      disclosure.goalControls.get(movement.destination) !== destination ||
      source.element !== groupBubble.source ||
      source.element === destination.element ||
      !this.ownsGoalControl(disclosure, source) ||
      !this.ownsGoalControl(disclosure, destination) ||
      !statsElementIsEnabled(source.element) ||
      !statsElementIsEnabled(destination.element) ||
      !statsGoalActionDeliveriesMatchWithinPhase(
        groupCapture,
        actionCapture,
      ) ||
      !statsGoalActionDeliveriesMatchWithinPhase(
        actionBubble,
        groupBubble,
      ) ||
      !statsGoalActionDeliveriesMatchAcrossPhases(
        actionCapture,
        actionBubble,
      ) ||
      !statsGoalActionMethodsRemainFalse(groupCapture) ||
      !statsGoalActionMethodsRemainFalse(actionCapture) ||
      !statsGoalActionMethodsRemainFalse(actionBubble) ||
      !statsGoalActionMethodsRemainFalse(groupBubble) ||
      !this.goalActionNativeIsExact(
        disclosure,
        goal,
        native,
        movement.source,
        true,
      ) ||
      !goalPublicationIsCurrent() ||
      keyboardAuthority.activeElement.read(native.ownerDocument) !==
        source.element ||
      !this.matches(disclosure, true)
    ) {
      return reject();
    }
    try {
      keyboardAuthority.apply(
        groupBubble.methods.preventDefault,
        groupBubble.wrapper,
        [],
      );
    } catch {
      return reject();
    }
    let publicDefaultWasPrevented = false;
    try {
      const currentDefaultQuery =
        groupBubble.wrapper.isDefaultPrevented;
      publicDefaultWasPrevented =
        statsReactPublicMethodMatches(
          groupBubble.wrapper,
          "isDefaultPrevented",
          currentDefaultQuery,
          keyboardAuthority,
        ) &&
        keyboardAuthority.apply(
          currentDefaultQuery,
          groupBubble.wrapper,
          [],
        ) === true;
    } catch {
      return reject();
    }
    if (
      !keyboardAuthority.eventDefaultPrevented.read(native.event) ||
      !groupBubble.wrapper.defaultPrevented ||
      !publicDefaultWasPrevented ||
      groupBubble.wrapper.preventDefault !==
        groupBubble.methods.preventDefault ||
      groupBubble.wrapper.isPropagationStopped !==
        groupBubble.methods.isPropagationStopped ||
      !statsReactPublicMethodMatches(
        groupBubble.wrapper,
        "preventDefault",
        groupBubble.methods.preventDefault,
        keyboardAuthority,
      ) ||
      !statsReactPublicMethodMatches(
        groupBubble.wrapper,
        "isPropagationStopped",
        groupBubble.methods.isPropagationStopped,
        keyboardAuthority,
      ) ||
      keyboardAuthority.apply(
        groupBubble.methods.isPropagationStopped,
        groupBubble.wrapper,
        [],
      ) !== false ||
      !goalPublicationIsCurrent() ||
      !this.directionalListenerIsCurrent(native) ||
      this.#current !== disclosure ||
      !this.matches(disclosure, true) ||
      keyboardAuthority.activeElement.read(native.ownerDocument) !==
        source.element ||
      disclosure.goalControls.get(movement.destination) !== destination ||
      !this.ownsGoalControl(disclosure, destination) ||
      !statsElementIsEnabled(destination.element)
    ) {
      return reject();
    }
    try {
      keyboardAuthority.focus.call(destination.element, {
        preventScroll: true,
      });
    } catch {
      return reject();
    }
    this.requestSuccessor(disclosure);
    return true;
  }

  mintTrigger(
    publication: StatsDisclosurePublication,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) {
    const trigger = publication.elements.trigger;
    const document = trigger?.ownerDocument;
    const ownerWindow = document?.defaultView;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    const provenance =
      ownerWindow && nativeEvent instanceof ownerWindow.Event
        ? this.#nativeProvenance.get(nativeEvent)
        : null;
    if (
      !trigger ||
      !document ||
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      provenance?.publication !== publication ||
      provenance.kind !== "click" ||
      provenance.document !== document ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      !nativeEvent.bubbles ||
      event.type !== "click" ||
      event.button !== 0 ||
      !event.bubbles ||
      event.currentTarget !== trigger ||
      nativeEvent.target !== target ||
      !statsNodeFromDocument(target, document) ||
      !target.isConnected ||
      !trigger.contains(target) ||
      !nativeEvent.composedPath().includes(trigger) ||
      !nativeEvent.composedPath().includes(document) ||
      event.defaultPrevented ||
      nativeEvent.defaultPrevented
    ) {
      return;
    }
    const nextOpen = !publication.render.open;
    const authority = this.authorityForTransition(
      publication,
      nextOpen,
    );
    if (
      !authority ||
      !this.claimTransition(
        publication,
        authority,
        event,
        nativeEvent,
      )
    ) {
      return;
    }
    this.publishProof(
      publication,
      authority,
      nextOpen,
      "trigger",
      event,
      nativeEvent,
    );
  }

  consumeShortcut(
    publication: StatsDisclosurePublication,
    event: KeyboardEvent,
  ) {
    const trigger = publication.elements.trigger;
    const document = trigger?.ownerDocument;
    const ownerWindow = document?.defaultView;
    const provenance = this.#nativeProvenance.get(event);
    const target = event.target;
    if (
      !trigger ||
      !document ||
      !ownerWindow ||
      !(event instanceof ownerWindow.KeyboardEvent) ||
      provenance?.publication !== publication ||
      provenance.kind !== "keydown" ||
      provenance.document !== document ||
      !statsOwnerWindowTarget(event.currentTarget, document, ownerWindow) ||
      event.type !== "keydown" ||
      event.eventPhase === ownerWindow.Event.NONE ||
      event.code !== "KeyC" ||
      !(event.ctrlKey || event.metaKey) ||
      !event.shiftKey ||
      event.altKey ||
      event.repeat ||
      event.isComposing ||
      !event.bubbles ||
      !statsNodeFromDocument(target, document) ||
      !target.isConnected ||
      !event.composedPath().includes(document) ||
      event.defaultPrevented
    ) {
      return;
    }
    const nextOpen = !publication.render.open;
    const authority = this.authorityForTransition(
      publication,
      nextOpen,
    );
    if (
      !authority ||
      !this.claimTransition(
        publication,
        authority,
        event,
        event,
      )
    ) {
      return;
    }
    const proof: StatsDisclosureProof = {
      publication,
      authority,
      nextOpen,
      source: "shortcut",
      event,
      nativeEvent: event,
      ownerWindow,
      timeoutId: 0,
    };
    event.preventDefault();
    if (!this.commitTransition(proof)) {
      this.requestSuccessor(publication);
    }
  }

  mintEscape(
    publication: StatsDisclosurePublication,
    event: KeyboardEvent,
  ) {
    const { content } = publication.elements;
    const document = content?.ownerDocument;
    const ownerWindow = document?.defaultView;
    const provenance = this.#nativeProvenance.get(event);
    const target = event.target;
    if (
      !content ||
      !document ||
      !ownerWindow ||
      !(event instanceof ownerWindow.KeyboardEvent) ||
      provenance?.publication !== publication ||
      provenance.kind !== "keydown" ||
      provenance.document !== document ||
      event.type !== "keydown" ||
      event.key !== "Escape" ||
      event.eventPhase === ownerWindow.Event.NONE ||
      event.currentTarget !== document ||
      event.defaultPrevented ||
      !statsNodeFromDocument(target, document) ||
      !target.isConnected ||
      !content.contains(target) ||
      !event.composedPath().includes(content) ||
      !event.composedPath().includes(document)
    ) {
      return;
    }
    const authority = this.authorityForTransition(publication, false);
    if (
      !authority ||
      !this.claimTransition(
        publication,
        authority,
        event,
        event,
      )
    ) {
      return;
    }
    this.publishProof(
      publication,
      authority,
      false,
      "escape",
      event,
      event,
    );
  }

  mintOutside(
    publication: StatsDisclosurePublication,
    event: CustomEvent<{ originalEvent: Event }>,
    source: "pointer" | "focus",
  ) {
    const { trigger, content } = publication.elements;
    const document = content?.ownerDocument;
    const ownerWindow = document?.defaultView;
    const originalEvent = event.detail?.originalEvent;
    const provenance = originalEvent
      ? this.#nativeProvenance.get(originalEvent)
      : null;
    const pointerProvenance =
      provenance?.kind === "pointerdown"
        ? (provenance as StatsPointerProvenance)
        : null;
    const target = originalEvent?.target ?? null;
    const expectedOriginal =
      source === "pointer" ? "pointerdown" : "focusin";
    const expectedCustom =
      source === "pointer"
        ? "dismissableLayer.pointerDownOutside"
        : "dismissableLayer.focusOutside";
    if (
      !trigger ||
      !content ||
      !document ||
      !ownerWindow ||
      !originalEvent ||
      !(originalEvent instanceof ownerWindow.Event) ||
      !(event instanceof ownerWindow.CustomEvent) ||
      provenance?.publication !== publication ||
      provenance.kind !== expectedOriginal ||
      provenance.document !== document ||
      originalEvent.type !== expectedOriginal ||
      (source === "focus" &&
        !(originalEvent instanceof ownerWindow.FocusEvent)) ||
      (source === "focus" &&
        originalEvent.eventPhase === ownerWindow.Event.NONE) ||
      event.type !== expectedCustom ||
      event.eventPhase === ownerWindow.Event.NONE ||
      event.defaultPrevented ||
      originalEvent.defaultPrevented ||
      event.target !== target ||
      event.currentTarget !== target ||
      !statsNodeFromDocument(target, document) ||
      !target.isConnected ||
      content.contains(target) ||
      trigger.contains(target) ||
      (source === "focus" &&
        !originalEvent.composedPath().includes(document)) ||
      !event.composedPath().includes(target) ||
      !event.composedPath().includes(document) ||
      (source === "pointer" &&
        (!pointerProvenance?.pointerUp ||
          !pointerProvenance.click ||
          ownerWindow.performance.now() >=
            pointerProvenance.expiresAt ||
          pointerProvenance.pointerDown.target !== target ||
          pointerProvenance.pointerDown.phase !==
            ownerWindow.Event.CAPTURING_PHASE ||
          pointerProvenance.pointerDown.isPrimary !== true ||
          pointerProvenance.click.target !== target ||
          !pointerProvenance.click.path.includes(document)))
    ) {
      return;
    }
    if (
      source === "pointer" &&
      typeof Reflect.get(originalEvent, "button") === "number" &&
      Reflect.get(originalEvent, "button") !== 0
    ) {
      return;
    }
    const authority = this.authorityForTransition(publication, false);
    if (
      !authority ||
      !this.claimTransition(
        publication,
        authority,
        event,
        originalEvent,
        source === "pointer"
          ? pointerProvenance?.click?.event
          : undefined,
      )
    ) {
      return;
    }
    this.publishProof(
      publication,
      authority,
      false,
      source,
      event,
      originalEvent,
    );
  }

  exactDirectionalAutoFocusEvent(
    event: Event,
    content: HTMLDivElement,
    intent: StatsDirectionalFocusIntent,
  ) {
    const authority = intent.keyboardAuthority;
    return (
      authority.isCurrent() &&
      authority.getPrototypeOf(event) === authority.customEventPrototype &&
      event instanceof intent.ownerWindow.CustomEvent &&
      !authority.getOwnPropertyDescriptor(event, "preventDefault") &&
      authority.eventType.read(event) ===
        "focusScope.autoFocusOnMount" &&
      authority.eventTarget.read(event) === content &&
      authority.eventCurrentTarget.read(event) === content &&
      authority.eventPhase.read(event) ===
        intent.ownerWindow.Event.AT_TARGET &&
      !authority.eventBubbles.read(event) &&
      authority.eventCancelable.read(event) &&
      !authority.eventComposed.read(event) &&
      !authority.eventDefaultPrevented.read(event) &&
      !authority.eventCancelBubble.read(event) &&
      (event as CustomEvent).detail === null &&
      statsEventPathIsExact(
        content,
        authority.eventPath.call(event),
        intent.ownerDocument,
        intent.native.listener.receiver,
      )
    );
  }

  completeDirectionalFocus(
    publication: StatsDisclosurePublication,
    event: Event,
    focus: StatsOpenFocus,
    intent: StatsDirectionalFocusIntent,
  ) {
    const { content, trigger } = publication.elements;
    if (
      this.#current !== publication ||
      publication.render.authority !== intent.authority ||
      event.currentTarget !== content
    ) {
      return;
    }
    const connection = publication.goalControls.get(intent.destination);
    const current = this.#current;
    const exact = Boolean(
      content &&
        trigger &&
        current === publication &&
        !intent.claimed &&
        this.#directionalIntent === intent &&
        focus.directional === intent &&
        intent.publication.retired &&
        intent.publication.consumed &&
        intent.publication.render.visit === intent.visit &&
        intent.native.claimed &&
        intent.native.listener.claimed &&
        this.#claimedEvents.has(intent.native.listener) &&
        this.directionalListenerIsCurrent(intent.native) &&
        intent.capture.claimed &&
        intent.bubble.claimed &&
        this.#claimedDirections.has(intent.native) &&
        this.#claimedDestinations.has(intent.destination) &&
        this.#directionalReactEvents.has(intent.capture.event) &&
        this.#directionalReactEvents.has(intent.bubble.event) &&
        intent.trigger === trigger &&
        trigger.ownerDocument === intent.ownerDocument &&
        intent.ownerDocument.defaultView === intent.ownerWindow &&
        publication.render.visit === intent.visit &&
        publication.render.authority === intent.authority &&
        publication.current.ownsAuthority(intent.authority) &&
        statsOpenSuccessorMatches(
          intent.publication.render,
          publication.render,
          intent.authority,
        ) &&
        publication.render.goalControls.includes(intent.destination) &&
        intent.destination.enabled &&
        connection &&
        !connection.claimed &&
        connection.controlIdentity === intent.destination &&
        this.ownsGoalControl(publication, connection) &&
        statsElementIsEnabled(connection.element) &&
        content.contains(connection.element) &&
        trigger.getAttribute("aria-expanded") === "true" &&
        trigger.getAttribute("aria-controls") === content.id &&
        content.dataset.align === "start" &&
        Boolean(content.dataset.side) &&
        intent.keyboardAuthority.activeElement.read(
          intent.ownerDocument,
        ) === trigger &&
        this.exactDirectionalAutoFocusEvent(event, content, intent) &&
        !this.#claimedEvents.has(event) &&
        this.matches(publication),
    );
    this.#directionalIntent = null;
    this.#openFocus = null;
    if (!exact || !connection) return;
    intent.claimed = true;
    connection.claimed = true;
    this.#claimedEvents.add(event);
    intent.visit.claimedEvents.add(event);
    intent.authority.claimedEvents.add(event);
    intent.keyboardAuthority.eventPreventDefault.call(event);
    if (
      !intent.keyboardAuthority.eventDefaultPrevented.read(event) ||
      !this.directionalListenerIsCurrent(intent.native) ||
      this.#current !== publication ||
      publication.render.authority !== intent.authority
    ) {
      return;
    }
    intent.keyboardAuthority.focus.call(connection.element, {
      preventScroll: true,
    });
  }

  openAutoFocus(
    publication: StatsDisclosurePublication,
    event: Event,
  ) {
    const { content } = publication.elements;
    const destination = publication.focusDestination;
    const ownerWindow = content?.ownerDocument.defaultView;
    const focus = this.#openFocus;
    if (focus?.directional) {
      this.completeDirectionalFocus(
        publication,
        event,
        focus,
        focus.directional,
      );
      return;
    }
    if (
      !content ||
      !destination ||
      !ownerWindow ||
      !focus ||
      focus.visit !== publication.render.visit ||
      focus.authority !== publication.render.authority ||
      !publication.current.ownsAuthority(focus.authority) ||
      !(event instanceof ownerWindow.Event) ||
      event.eventPhase === ownerWindow.Event.NONE ||
      event.currentTarget !== content ||
      event.target !== content ||
      !content.contains(destination) ||
      !destination.isConnected ||
      this.#claimedEvents.has(event) ||
      !this.matches(publication)
    ) {
      return;
    }
    this.#claimedEvents.add(event);
    publication.render.visit.claimedEvents.add(event);
    focus.authority.claimedEvents.add(event);
    this.#openFocus = null;
    this.#directionalIntent = null;
    event.preventDefault();
    destination.focus({ preventScroll: true });
  }

  closeAutoFocus(
    publication: StatsDisclosurePublication,
    event: Event,
  ) {
    const active = this.#closeFocus;
    const close =
      active?.expected === publication
        ? active
        : this.#retiredCloseFocus.get(publication);
    if (!close) return;
    const closingPublication = close.publication;
    const content = closingPublication?.contentDom?.node;
    const ownerWindow =
      closingPublication?.triggerPlacement?.document.defaultView;
    const current = this.#current;
    if (
      close.claimed ||
      !ownerWindow ||
      content !== event.currentTarget ||
      !(event instanceof ownerWindow.Event) ||
      event.eventPhase === ownerWindow.Event.NONE ||
      this.#claimedEvents.has(event)
    ) {
      this.clearCloseFocus(close);
      return;
    }
    const exact = Boolean(
      active === close &&
        close.authority.retired &&
        closingPublication.current.ownsVisit(close.visit) &&
        current &&
        current.render.visit === close.visit &&
        !current.render.open &&
        current.elements.trigger === close.trigger &&
        statsCloseSuccessorMatches(
          closingPublication.render,
          publication.render,
        ) &&
        statsClosedSuccessorsMatch(
          publication.render,
          current.render,
        ) &&
        this.matches(current),
    );
    close.claimed = true;
    this.#claimedEvents.add(event);
    close.visit.claimedEvents.add(event);
    close.authority.claimedEvents.add(event);
    this.clearCloseFocus(close);
    event.preventDefault();
    if (
      exact &&
      close.source !== "pointer" &&
      close.source !== "focus"
    ) {
      close.trigger.focus({ preventScroll: true });
    }
  }
}

function isGoalMode(value: string): value is GoalMode {
  return value === "min" || value === "max";
}

function isGoalKind(value: string): value is GoalKind {
  return value === "words" || value === "minutes";
}

function goalElementSlot<T extends HTMLElement>(): GoalElementSlot<T> {
  return { expected: null, connection: null };
}

const claimedGoalNativeEvents = new WeakSet<Event>();

function goalSelectValueIsExact(
  select: HTMLSelectElement,
  value: string,
  selected: HTMLOptionElement,
  other: HTMLOptionElement,
): boolean {
  return (
    select.value === value &&
    select.selectedIndex === selected.index &&
    select.selectedOptions.length === 1 &&
    select.selectedOptions.item(0) === selected &&
    selected.selected &&
    !other.selected
  );
}

function goalPublicationDomIsExact(
  publication: GoalPublication,
  mutable: "modeSelect" | "valueInput" | "kindSelect" | null,
): boolean {
  const {
    presentation,
    form,
    modeSelect,
    modeMinOption,
    modeMaxOption,
    valueInput,
    kindSelect,
    kindWordsOption,
    kindMinutesOption,
    actions,
    setButton,
    clearButton,
  } = publication;
  const document = form.ownerDocument;
  const ownerWindow = document.defaultView;
  const nodes = [
    form,
    modeSelect,
    modeMinOption,
    modeMaxOption,
    valueInput,
    kindSelect,
    kindWordsOption,
    kindMinutesOption,
    actions,
    setButton,
    ...(clearButton ? [clearButton] : []),
  ];
  if (
    !ownerWindow ||
    nodes.some((node) => node.ownerDocument !== document || !node.isConnected) ||
    form.children.length !== 4 ||
    form.children.item(0) !== modeSelect ||
    form.children.item(1) !== valueInput ||
    form.children.item(2) !== kindSelect ||
    form.children.item(3) !== actions ||
    modeSelect.form !== form ||
    valueInput.form !== form ||
    kindSelect.form !== form ||
    setButton.form !== form ||
    modeSelect.children.length !== 2 ||
    modeSelect.children.item(0) !== modeMinOption ||
    modeSelect.children.item(1) !== modeMaxOption ||
    modeSelect.options.length !== 2 ||
    modeSelect.options.item(0) !== modeMinOption ||
    modeSelect.options.item(1) !== modeMaxOption ||
    kindSelect.children.length !== 2 ||
    kindSelect.children.item(0) !== kindWordsOption ||
    kindSelect.children.item(1) !== kindMinutesOption ||
    kindSelect.options.length !== 2 ||
    kindSelect.options.item(0) !== kindWordsOption ||
    kindSelect.options.item(1) !== kindMinutesOption ||
    actions.parentElement !== form ||
    actions.children.length !== (clearButton ? 2 : 1) ||
    actions.children.item(0) !== setButton ||
    (clearButton ? actions.children.item(1) !== clearButton || clearButton.form !== form : actions.children.item(1) !== null) ||
    modeMinOption.value !== "min" ||
    modeMinOption.textContent !== "At least" ||
    modeMinOption.disabled ||
    modeMaxOption.value !== "max" ||
    modeMaxOption.textContent !== "At most" ||
    modeMaxOption.disabled ||
    kindWordsOption.value !== "words" ||
    kindWordsOption.textContent !== "words" ||
    kindWordsOption.disabled ||
    kindMinutesOption.value !== "minutes" ||
    kindMinutesOption.textContent !== "min read" ||
    kindMinutesOption.disabled ||
    modeSelect.disabled ||
    valueInput.disabled ||
    kindSelect.disabled ||
    valueInput.type !== "number" ||
    valueInput.min !== "1" ||
    valueInput.step !== "1" ||
    valueInput.inputMode !== "numeric" ||
    valueInput.placeholder !== (presentation.kind === "words" ? "500" : "5") ||
    setButton.type !== "submit" ||
    setButton.disabled !== presentation.setDisabled ||
    (clearButton ? clearButton.type !== "button" || clearButton.disabled : presentation.sharedGoal.goal !== null) ||
    Boolean(clearButton) !== Boolean(presentation.sharedGoal.goal)
  ) {
    return false;
  }
  const expectedModeOption = presentation.mode === "min" ? modeMinOption : modeMaxOption;
  const otherModeOption = presentation.mode === "min" ? modeMaxOption : modeMinOption;
  const expectedKindOption = presentation.kind === "words" ? kindWordsOption : kindMinutesOption;
  const otherKindOption = presentation.kind === "words" ? kindMinutesOption : kindWordsOption;
  return (
    (mutable === "modeSelect" || goalSelectValueIsExact(modeSelect, presentation.mode, expectedModeOption, otherModeOption)) &&
    (mutable === "valueInput" || valueInput.value === presentation.value) &&
    (mutable === "kindSelect" || goalSelectValueIsExact(kindSelect, presentation.kind, expectedKindOption, otherKindOption))
  );
}

function createStatsPublication(
  render: StatsDisclosureRender,
  current: StatsDisclosureCurrent,
  requestSuccessor: (replaceVisit: boolean) => void,
): StatsDisclosurePublication {
  return {
    identity: Symbol("stats-publication"),
    render,
    elements: { trigger: null, content: null },
    connections: { trigger: null, content: null },
    goalControls: new Map(),
    reactWrapperAuthority: null,
    established: false,
    retired: false,
    retirement: null,
    consumed: false,
    successorRequested: false,
    visitSuccessorRequested: false,
    layoutEstablished: new Set<StatsLayoutDomain>(),
    layoutRetired: new Set<StatsLayoutDomain>(),
    invalidReplay: new Set<StatsLayoutDomain>(),
    replayRefs: [],
    triggerDom: null,
    triggerPlacement: null,
    contentDom: null,
    contentPlacement: null,
    focusDestination: null,
    guard: null,
    requestSuccessor,
    current,
  };
}

function StatsDisclosurePortalLayout({
  coordinator,
  publication,
  children,
}: {
  coordinator: StatsDisclosureCoordinator;
  publication: StatsDisclosurePublication;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    coordinator.establish(publication, "portal");
    return () => coordinator.retireLayout(publication, "portal");
  }, [coordinator, publication]);
  useEffect(
    () => () =>
      coordinator.releaseCloseFocusAfterPortal(publication),
    [coordinator, publication],
  );
  return children;
}

/**
 * Word count button in the status bar with the statistics popover (Mod-Shift-C): whole-document
 * and selection counts, and the per-document writing goal shared through the Y meta map.
 */
export function StatsPopover({
  session,
  source,
  selection,
  hydrated,
}: StatsPopoverProps) {
  const [mount] = useState<StatsDisclosureMount>(() =>
    Object.freeze({ identity: Symbol("stats-mount") }),
  );
  const [current] = useState(() => new StatsDisclosureCurrent());
  const [coordinator] = useState(
    () => new StatsDisclosureCoordinator(),
  );
  const [visitRevision, setVisitRevision] = useState(0);
  const [, setPublicationRevision] = useState(0);
  const visit = useMemo<StatsDisclosureVisit>(
    () => ({
      identity: Symbol("stats-visit"),
      revision: visitRevision,
      mount,
      session,
      docId: session.docId,
      ydoc: session.ydoc,
      ytext: session.ytext,
      role: session.role,
      claimedEvents: new WeakSet<object>(),
      retired: false,
    }),
    [mount, session, visitRevision],
  );
  const [disclosure, setDisclosure] =
    useState<StatsDisclosureState>(() =>
      Object.freeze({ visit, authority: null, open: false }),
    );
  const ownsDisclosure =
    disclosure.visit === visit &&
    (!disclosure.authority ||
      disclosure.authority.visit === visit);
  const authority = ownsDisclosure ? disclosure.authority : null;
  const open = ownsDisclosure && disclosure.open && authority !== null;
  const stats = useMemo(() => computeStats(source), [source]);
  const selStats = useMemo(
    () =>
      selection
        ? computeSelectionStats(
            source,
            selection.from,
            selection.to,
          )
        : null,
    [selection, source],
  );
  const goal = useSessionValue(session, getGoal, jsonEqual);
  const canEdit = useSessionValue(session, (value) => value.canEdit);
  const progress = useMemo(
    () => (goal ? goalProgress(stats, goal) : null),
    [goal, stats],
  );
  const [storedDraft, setDraft] = useState(() =>
    goalDraft(session, goal),
  );
  let draft = storedDraft;
  if (draft.session !== session || draft.sharedGoal !== goal) {
    draft = goalDraft(session, goal);
    setDraft(draft);
  }
  const goalPresentation: GoalPresentation = Object.freeze({
    session,
    sharedGoal: goalSnapshot(goal),
    progress: progressSnapshot(progress),
    canEdit,
    draft,
    kind: draft.kind,
    mode: draft.mode,
    value: draft.value,
    setBy: session.user.login ?? null,
    setDisabled: !(Number(draft.value) > 0),
  });
  const goalControls = useMemo(
    () =>
      goalControlIdentities(
        canEdit,
        goalPresentation.setDisabled,
        goal !== null,
      ),
    [canEdit, goal, goalPresentation.setDisabled],
  );
  const shortcutLabel = shortcut("Mod-Shift-C");
  const triggerLabel = hydrated
    ? `${formatNumber(stats.words)} words`
    : "— words";
  const selectionLabel =
    hydrated && selStats
      ? `${formatNumber(selStats.words)} of ${formatNumber(stats.words)} selected`
      : null;
  const triggerTitle =
    goal && progress
      ? describeGoal(goal, progress)
      : `Document statistics (${shortcutLabel})`;
  const commitState = useCallback(
    (
      expected: StatsDisclosureState,
      next: StatsDisclosureState,
    ) => {
      setDisclosure((value) => (value === expected ? next : value));
    },
    [],
  );
  const requestSuccessor = useCallback((replaceVisit: boolean) => {
    if (replaceVisit) {
      setVisitRevision((revision) => revision + 1);
    } else {
      setPublicationRevision((revision) => revision + 1);
    }
  }, []);
  const disclosureRender: StatsDisclosureRender = Object.freeze({
    visit,
    state: disclosure,
    authority,
    session,
    source,
    selection,
    selectionFrom: selection?.from ?? null,
    selectionTo: selection?.to ?? null,
    hydrated,
    stats: statsSnapshot(stats),
    selectionStats: selStats ? statsSnapshot(selStats) : null,
    goal: goalSnapshot(goal),
    canEdit,
    mode: session.mode,
    progress: progressSnapshot(progress),
    open,
    shortcutLabel,
    triggerTitle,
    triggerLabel,
    selectionLabel,
    goalPresentation,
    goalControls,
    setDraft,
    commitState,
  });
  const publication = createStatsPublication(
    disclosureRender,
    current,
    requestSuccessor,
  );

  useLayoutEffect(() => {
    const lease = coordinator.beginLease();
    return () => coordinator.endLease(lease);
  }, [coordinator]);

  useLayoutEffect(() => {
    if (!current.publishVisit(visit)) return;
    setDisclosure((value) =>
      value.visit === visit
        ? value
        : Object.freeze({
            visit,
            authority: null,
            open: false,
          }),
    );
    return () => current.retireVisit(visit);
  }, [current, visit]);

  useLayoutEffect(() => {
    coordinator.establish(publication, "trigger");
    return () =>
      coordinator.retireLayout(publication, "trigger");
  }, [coordinator, publication]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) =>
        coordinator.consumeProof(publication, nextOpen)
      }
    >
      <PopoverTrigger asChild>
        <button
          ref={(element) =>
            coordinator.bindElement(
              publication,
              "trigger",
              element,
            )
          }
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3 hover:text-ink"
          title={triggerTitle}
          onClick={(event) =>
            coordinator.mintTrigger(publication, event)
          }
          onKeyDownCapture={(event) =>
            coordinator.captureDirectional(publication, event)
          }
          onKeyDown={(event) =>
            coordinator.consumeDirectional(publication, event)
          }
          data-testid="stats-button"
        >
          {goal && progress && hydrated ? (
            <GoalRing progress={progress} />
          ) : null}
          <span data-testid="word-count">{triggerLabel}</span>
          {selectionLabel && (
            <span
              className="text-ink-4"
              data-testid="selection-count"
            >
              · {selectionLabel}
            </span>
          )}
        </button>
      </PopoverTrigger>
      {ownsDisclosure && (
        <PopoverContent
          align="start"
          className="w-[24rem] p-0"
          onPointerDownOutside={(event) =>
            coordinator.mintOutside(
              publication,
              event,
              "pointer",
            )
          }
          onFocusOutside={(event) =>
            coordinator.mintOutside(
              publication,
              event,
              "focus",
            )
          }
          onEscapeKeyDown={(event) =>
            coordinator.mintEscape(publication, event)
          }
          onOpenAutoFocus={(event) =>
            coordinator.openAutoFocus(publication, event)
          }
          onCloseAutoFocus={(event) =>
            coordinator.closeAutoFocus(publication, event)
          }
          data-testid="stats-popover"
        >
          <StatsDisclosurePortalLayout
            coordinator={coordinator}
            publication={publication}
          >
            <div
              ref={(element) => {
                if (!element) {
                  return coordinator.bindElement(
                    publication,
                    "content",
                    null,
                  );
                }
                const content = element.parentElement;
                return coordinator.bindElement(
                  publication,
                  "content",
                  content instanceof HTMLDivElement ? content : null,
                );
              }}
              className="flex items-center justify-between border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wider text-ink-3"
            >
              <span>Document statistics</span>
              <span className="font-normal normal-case tracking-normal text-ink-4">
                {shortcutLabel}
              </span>
            </div>
            <table
              className="w-full text-[13px]"
              data-testid="stats-table"
            >
              {selStats && (
                <thead>
                  <tr className="text-xs text-ink-4">
                    <th className="px-3 pt-2 text-left font-normal" />
                    <th className="px-3 pt-2 text-right font-normal">
                      Selection
                    </th>
                    <th className="px-3 pt-2 text-right font-normal">
                      Document
                    </th>
                  </tr>
                </thead>
              )}
              <tbody>
                {ROWS.map((row) => {
                  const format = row.format ?? formatNumber;
                  return (
                    <tr key={row.key} data-stat={row.key}>
                      <td className="px-3 py-1 text-ink-2">
                        {row.label}
                      </td>
                      {selStats && (
                        <td className="px-3 py-1 text-right tabular-nums text-ink">
                          {format(selStats[row.key])}
                        </td>
                      )}
                      <td className="px-3 py-1 text-right tabular-nums text-ink">
                        {format(stats[row.key])}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="px-3 pb-2 text-[11px] text-ink-4">
              Prose only: code blocks and front matter are not
              counted. Reading at 200 wpm, speaking at 130 wpm.
            </p>
            <GoalEditor
              presentation={goalPresentation}
              setDraft={setDraft}
              coordinator={coordinator}
              disclosurePublication={publication}
              controlIdentities={goalControls}
            />
          </StatsDisclosurePortalLayout>
        </PopoverContent>
      )}
    </Popover>
  );
}

function goalDraft(session: CollabSession, goal: WritingGoal | null): GoalDraft {
  return {
    session,
    sharedGoal: goal,
    kind: goal?.kind ?? "words",
    mode: goal?.mode ?? "min",
    value: goal ? String(goal.value) : "",
  };
}

function GoalEditor({
  presentation,
  setDraft,
  coordinator,
  disclosurePublication,
  controlIdentities,
}: {
  presentation: GoalPresentation;
  setDraft: Dispatch<SetStateAction<GoalDraft>>;
  coordinator: StatsDisclosureCoordinator;
  disclosurePublication: StatsDisclosurePublication;
  controlIdentities: readonly StatsGoalControlIdentity[];
}) {
  const generation = useMemo<GoalGeneration>(
    () => ({
      presentation,
      form: goalElementSlot(),
      modeSelect: goalElementSlot(),
      valueInput: goalElementSlot(),
      kindSelect: goalElementSlot(),
      setButton: goalElementSlot(),
      clearButton: goalElementSlot(),
    }),
    [presentation],
  );
  const activeGenerationRef = useRef<GoalGeneration | null>(null);
  const claimedGenerationRef = useRef<GoalGeneration | null>(null);
  const activePublicationRef = useRef<GoalPublication | null>(null);
  const { canEdit, kind, mode, value } = presentation;
  const goal = presentation.sharedGoal.goal;
  const progress = presentation.progress.progress;

  function retirePublication(publication: GoalPublication | null) {
    if (!publication || publication.retired) return;
    publication.retired = true;
    if (activePublicationRef.current === publication) activePublicationRef.current = null;
  }

  function retireGenerationPublication(exactGeneration: GoalGeneration) {
    const publication = activePublicationRef.current;
    if (publication?.generation === exactGeneration) retirePublication(publication);
  }

  function publicationForGeneration(exactGeneration: GoalGeneration): GoalPublication | null {
    const form = exactGeneration.form.connection?.element;
    const modeSelect = exactGeneration.modeSelect.connection?.element;
    const valueInput = exactGeneration.valueInput.connection?.element;
    const kindSelect = exactGeneration.kindSelect.connection?.element;
    const setButton = exactGeneration.setButton.connection?.element;
    const clearButton = exactGeneration.clearButton.connection?.element ?? null;
    const ownerWindow = form?.ownerDocument.defaultView;
    const modeMinOption = modeSelect?.children.item(0);
    const modeMaxOption = modeSelect?.children.item(1);
    const kindWordsOption = kindSelect?.children.item(0);
    const kindMinutesOption = kindSelect?.children.item(1);
    const actions = setButton?.parentElement;
    if (
      !canEdit ||
      !form ||
      !modeSelect ||
      !valueInput ||
      !kindSelect ||
      !setButton ||
      (goal ? !clearButton : clearButton !== null) ||
      !ownerWindow ||
      !(modeMinOption instanceof ownerWindow.HTMLOptionElement) ||
      !(modeMaxOption instanceof ownerWindow.HTMLOptionElement) ||
      !(kindWordsOption instanceof ownerWindow.HTMLOptionElement) ||
      !(kindMinutesOption instanceof ownerWindow.HTMLOptionElement) ||
      !(actions instanceof ownerWindow.HTMLSpanElement)
    ) {
      return null;
    }
    const publication: GoalPublication = {
      generation: exactGeneration,
      presentation,
      form,
      modeSelect,
      modeMinOption,
      modeMaxOption,
      valueInput,
      kindSelect,
      kindWordsOption,
      kindMinutesOption,
      actions,
      setButton,
      clearButton,
      claimed: false,
      retired: false,
    };
    return goalPublicationDomIsExact(publication, null) ? publication : null;
  }

  function publishGeneration(exactGeneration: GoalGeneration) {
    if (
      claimedGenerationRef.current === exactGeneration ||
      activeGenerationRef.current !== exactGeneration
    ) {
      return;
    }
    const next = publicationForGeneration(exactGeneration);
    if (!next) return;
    const current = activePublicationRef.current;
    if (
      current &&
      !current.retired &&
      current.generation === exactGeneration &&
      current.form === next.form &&
      current.modeSelect === next.modeSelect &&
      current.valueInput === next.valueInput &&
      current.kindSelect === next.kindSelect &&
      current.setButton === next.setButton &&
      current.clearButton === next.clearButton
    ) {
      return;
    }
    retirePublication(current);
    activePublicationRef.current = next;
  }

  function bindElement<T extends HTMLElement>(
    exactGeneration: GoalGeneration,
    slot: GoalElementSlot<T>,
    element: T | null,
  ) {
    if (!element) {
      if (!slot.connection) return;
      slot.connection = null;
      retireGenerationPublication(exactGeneration);
      return;
    }
    if (slot.expected && slot.expected !== element) return;
    slot.expected ??= element;
    const connection = { element };
    slot.connection = connection;
    retireGenerationPublication(exactGeneration);
    publishGeneration(exactGeneration);
    return () => {
      if (slot.connection !== connection) return;
      slot.connection = null;
      retireGenerationPublication(exactGeneration);
    };
  }

  function bindGoalElement<T extends HTMLElement>(
    exactGeneration: GoalGeneration,
    slot: GoalElementSlot<T>,
    key: StatsGoalControlKey,
    element: T | null,
  ) {
    const controlIdentity = controlIdentities.find(
      (identity) => identity.key === key,
    );
    const releaseGoal = bindElement(exactGeneration, slot, element);
    const releaseDisclosure = controlIdentity
      ? coordinator.bindGoalControl(
          disclosurePublication,
          controlIdentity,
          element,
        )
      : undefined;
    if (!releaseGoal && !releaseDisclosure) return;
    return () => {
      releaseDisclosure?.();
      releaseGoal?.();
    };
  }

  useLayoutEffect(() => {
    activeGenerationRef.current = generation;
    publishGeneration(generation);
    return () => {
      if (activeGenerationRef.current === generation) activeGenerationRef.current = null;
      retireGenerationPublication(generation);
    };
  });

  function publicationIsCurrent(
    publication: GoalPublication,
    mutable: "modeSelect" | "valueInput" | "kindSelect" | null,
    claimed = false,
  ) {
    return !(
      activePublicationRef.current !== publication ||
      publication.retired ||
      (claimed ? !publication.claimed : publication.claimed) ||
      publication.generation !== generation ||
      publication.presentation !== presentation ||
      activeGenerationRef.current !== generation ||
      (claimed
        ? claimedGenerationRef.current !== generation
        : claimedGenerationRef.current === generation) ||
      !goalPresentationIsExact(presentation) ||
      !canEdit ||
      generation.form.connection?.element !== publication.form ||
      generation.modeSelect.connection?.element !== publication.modeSelect ||
      generation.valueInput.connection?.element !== publication.valueInput ||
      generation.kindSelect.connection?.element !== publication.kindSelect ||
      generation.setButton.connection?.element !== publication.setButton ||
      (publication.clearButton
        ? generation.clearButton.connection?.element !== publication.clearButton
        : generation.clearButton.connection !== null) ||
      !goalPublicationDomIsExact(publication, mutable)
    );
  }

  function currentPublication(
    mutable: "modeSelect" | "valueInput" | "kindSelect" | null,
  ) {
    const publication = activePublicationRef.current;
    return publication &&
      publicationIsCurrent(publication, mutable)
      ? publication
      : null;
  }

  function claimEvent(publication: GoalPublication, nativeEvent: Event) {
    if (
      activePublicationRef.current !== publication ||
      publication.retired ||
      publication.claimed ||
      claimedGenerationRef.current === publication.generation ||
      claimedGoalNativeEvents.has(nativeEvent)
    ) {
      return false;
    }
    publication.claimed = true;
    claimedGenerationRef.current = publication.generation;
    claimedGoalNativeEvents.add(nativeEvent);
    return true;
  }

  function exactChangeEvent<T extends HTMLSelectElement | HTMLInputElement>(
    event: React.ChangeEvent<T>,
    control: T,
    type: "change" | "input",
  ): Event | null {
    const nativeEvent = event.nativeEvent;
    const ownerWindow = control.ownerDocument.defaultView;
    if (
      !ownerWindow ||
      event.currentTarget !== control ||
      event.target !== control ||
      event.defaultPrevented ||
      !(nativeEvent instanceof ownerWindow.Event) ||
      nativeEvent.type !== type ||
      nativeEvent.target !== control ||
      nativeEvent.defaultPrevented
    ) {
      return null;
    }
    return nativeEvent;
  }

  function changeMode(event: React.ChangeEvent<HTMLSelectElement>) {
    const publication = currentPublication("modeSelect");
    if (!publication) return;
    const nativeEvent = exactChangeEvent(event, publication.modeSelect, "change");
    const next = publication.modeSelect.value;
    const selected = next === "min" ? publication.modeMinOption : publication.modeMaxOption;
    const other = next === "min" ? publication.modeMaxOption : publication.modeMinOption;
    if (
      !nativeEvent ||
      !isGoalMode(next) ||
      !goalSelectValueIsExact(publication.modeSelect, next, selected, other) ||
      !claimEvent(publication, nativeEvent)
    ) {
      return;
    }
    setDraft({ ...presentation.draft, mode: next });
  }

  function changeValue(event: React.ChangeEvent<HTMLInputElement>) {
    const publication = currentPublication("valueInput");
    if (!publication) return;
    const nativeEvent = exactChangeEvent(event, publication.valueInput, "input");
    if (!nativeEvent || !claimEvent(publication, nativeEvent)) return;
    const next = publication.valueInput.value;
    setDraft({ ...presentation.draft, value: next });
  }

  function changeKind(event: React.ChangeEvent<HTMLSelectElement>) {
    const publication = currentPublication("kindSelect");
    if (!publication) return;
    const nativeEvent = exactChangeEvent(event, publication.kindSelect, "change");
    const next = publication.kindSelect.value;
    const selected = next === "words" ? publication.kindWordsOption : publication.kindMinutesOption;
    const other = next === "words" ? publication.kindMinutesOption : publication.kindWordsOption;
    if (
      !nativeEvent ||
      !isGoalKind(next) ||
      !goalSelectValueIsExact(publication.kindSelect, next, selected, other) ||
      !claimEvent(publication, nativeEvent)
    ) {
      return;
    }
    setDraft({ ...presentation.draft, kind: next });
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    const publication = currentPublication(null);
    if (!publication) return;
    const nativeEvent = event.nativeEvent;
    const ownerWindow = publication.form.ownerDocument.defaultView;
    if (
      !ownerWindow ||
      event.currentTarget !== publication.form ||
      event.target !== publication.form ||
      event.defaultPrevented ||
      !(nativeEvent instanceof ownerWindow.SubmitEvent) ||
      nativeEvent.type !== "submit" ||
      nativeEvent.target !== publication.form ||
      nativeEvent.defaultPrevented ||
      !nativeEvent.bubbles ||
      !nativeEvent.cancelable ||
      (nativeEvent.submitter !== null && nativeEvent.submitter !== publication.setButton) ||
      publication.setButton.disabled ||
      !claimEvent(publication, nativeEvent)
    ) {
      return;
    }
    const exactSession = presentation.session;
    const exactKind = presentation.kind;
    const exactMode = presentation.mode;
    const exactValue = presentation.value;
    const exactSetBy = presentation.setBy;
    event.preventDefault();
    const parsed = Math.round(Number(exactValue));
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    setGoal(exactSession, {
      kind: exactKind,
      mode: exactMode,
      value: parsed,
      setBy: exactSetBy,
      setAt: Date.now(),
    });
  }

  function clear(event: React.MouseEvent<HTMLButtonElement>) {
    const publication = currentPublication(null);
    const clearButton = publication?.clearButton;
    if (!publication || !clearButton) return;
    const nativeEvent = event.nativeEvent;
    const ownerWindow = clearButton.ownerDocument.defaultView;
    const target = event.target;
    if (
      !presentation.sharedGoal.goal ||
      !ownerWindow ||
      event.currentTarget !== clearButton ||
      event.defaultPrevented ||
      !(target instanceof ownerWindow.Node) ||
      !clearButton.contains(target) ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== "click" ||
      nativeEvent.target !== target ||
      nativeEvent.defaultPrevented ||
      !nativeEvent.bubbles ||
      !nativeEvent.cancelable ||
      clearButton.disabled ||
      !claimEvent(publication, nativeEvent)
    ) {
      return;
    }
    setGoal(presentation.session, null);
  }

  let capturedActionGroup: StatsGoalActionDelivery | null = null;
  let capturedAction: StatsGoalActionDelivery | null = null;
  let bubbledAction: StatsGoalActionDelivery | null = null;
  const clearActionProof = () => {
    capturedActionGroup = null;
    capturedAction = null;
    bubbledAction = null;
  };
  const actionDelivery = <T extends HTMLElement>(
    event: ReactKeyboardEvent<T>,
    currentTarget: HTMLElement,
    phase: number,
  ) => {
    const publication = currentPublication(null);
    return publication
      ? coordinator.readGoalActionDelivery(
          disclosurePublication,
          publication,
          event,
          currentTarget,
          phase,
        )
      : null;
  };
  const actionGroupKeyDownCapture = (
    event: ReactKeyboardEvent<HTMLSpanElement>,
  ) => {
    clearActionProof();
    const publication = currentPublication(null);
    const ownerWindow = publication?.form.ownerDocument.defaultView;
    const delivery =
      publication && ownerWindow
        ? actionDelivery(
            event,
            publication.actions,
            ownerWindow.Event.CAPTURING_PHASE,
          )
        : null;
    if (
      !publication ||
      !delivery ||
      delivery.goal !== publication ||
      delivery.currentTarget !== publication.actions
    ) {
      return;
    }
    capturedActionGroup = delivery;
    queueMicrotask(() => {
      if (capturedActionGroup === delivery) clearActionProof();
    });
  };
  const actionKeyDownCapture = (
    key: "set" | "clear",
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const publication = currentPublication(null);
    const ownerWindow = publication?.form.ownerDocument.defaultView;
    const source =
      key === "set" ? publication?.setButton : publication?.clearButton;
    const delivery =
      publication && ownerWindow && source
        ? actionDelivery(
            event,
            source,
            ownerWindow.Event.CAPTURING_PHASE,
          )
        : null;
    if (
      !capturedActionGroup ||
      capturedAction ||
      bubbledAction ||
      !publication ||
      !source ||
      !delivery ||
      delivery.goal !== publication ||
      delivery.source !== source ||
      delivery.sourceIdentity.key !== key ||
      !statsGoalActionDeliveriesMatchWithinPhase(
        capturedActionGroup,
        delivery,
      )
    ) {
      clearActionProof();
      return;
    }
    capturedAction = delivery;
  };
  const actionKeyDown = (
    key: "set" | "clear",
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const publication = currentPublication(null);
    const ownerWindow = publication?.form.ownerDocument.defaultView;
    const source =
      key === "set" ? publication?.setButton : publication?.clearButton;
    const delivery =
      publication && ownerWindow && source
        ? actionDelivery(
            event,
            source,
            ownerWindow.Event.BUBBLING_PHASE,
          )
        : null;
    if (
      !capturedActionGroup ||
      !capturedAction ||
      bubbledAction ||
      !publication ||
      !source ||
      !delivery ||
      delivery.goal !== publication ||
      delivery.source !== source ||
      delivery.sourceIdentity.key !== key ||
      !statsGoalActionDeliveriesMatchWithinPhase(
        capturedActionGroup,
        capturedAction,
      ) ||
      !statsGoalActionDeliveriesMatchAcrossPhases(
        capturedAction,
        delivery,
      )
    ) {
      clearActionProof();
      return;
    }
    bubbledAction = delivery;
  };
  const actionGroupKeyDown = (
    event: ReactKeyboardEvent<HTMLSpanElement>,
  ) => {
    const groupCapture = capturedActionGroup;
    const actionCapture = capturedAction;
    const actionBubble = bubbledAction;
    const publication = currentPublication(null);
    const ownerWindow = publication?.form.ownerDocument.defaultView;
    const groupBubble =
      publication && ownerWindow
        ? actionDelivery(
            event,
            publication.actions,
            ownerWindow.Event.BUBBLING_PHASE,
          )
        : null;
    clearActionProof();
    if (
      !publication ||
      !groupCapture ||
      !actionCapture ||
      !actionBubble ||
      !groupBubble ||
      groupCapture.currentTarget !== publication.actions ||
      actionCapture.currentTarget !== actionCapture.source ||
      actionBubble.currentTarget !== actionBubble.source ||
      groupBubble.currentTarget !== publication.actions ||
      !statsGoalActionDeliveriesMatchWithinPhase(
        groupCapture,
        actionCapture,
      ) ||
      !statsGoalActionDeliveriesMatchWithinPhase(
        actionBubble,
        groupBubble,
      ) ||
      !statsGoalActionDeliveriesMatchAcrossPhases(
        actionCapture,
        actionBubble,
      ) ||
      !statsGoalActionMethodsRemainFalse(groupCapture) ||
      !statsGoalActionMethodsRemainFalse(actionCapture) ||
      !statsGoalActionMethodsRemainFalse(actionBubble) ||
      !statsGoalActionMethodsRemainFalse(groupBubble)
    ) {
      return;
    }
    const enabledActions = controlIdentities.filter(
      (identity) =>
        (identity.key === "set" || identity.key === "clear") &&
        identity.enabled,
    );
    const destination = statsGoalActionDestination(
      enabledActions,
      groupBubble.sourceIdentity,
      groupBubble.key,
    );
    if (!destination) return;
    const movement: StatsGoalActionMovement = Object.freeze({
      identity: Symbol("stats-goal-action-movement"),
      disclosure: disclosurePublication,
      goal: publication,
      key: groupBubble.key,
      source: groupBubble.sourceIdentity,
      destination,
    });
    const claim = coordinator.claimGoalActionMovement(
      movement,
      groupCapture,
      actionCapture,
      actionBubble,
      groupBubble,
    );
    if (!claim) return;
    claimedGenerationRef.current = generation;
    coordinator.performGoalActionMovement(claim, () =>
      publicationIsCurrent(publication, null, true),
    );
  };

  const summary =
    goal && progress ? (
      <div className="flex items-center gap-2 text-[13px] text-ink-2" data-testid="goal-summary" data-state={progress.state}>
        <GoalRing progress={progress} />
        <span>
          {goal.mode === "min" ? "At least" : "At most"} {formatNumber(goal.value)} {goal.kind === "words" ? "words" : "min read"} · {describeGoal(goal, progress)}
          {progress.state === "reached" && " · reached"}
          {progress.state === "exceeded" && " · over"}
        </span>
      </div>
    ) : (
      <div className="text-[13px] text-ink-4" data-testid="goal-summary" data-state="none">
        No goal set{canEdit ? "" : " for this document"}.
      </div>
    );

  return (
    <div className="border-t border-line px-3 py-2.5" data-testid="goal-section">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-ink-3">Goal</div>
      {summary}
      {goal?.setBy && <div className="mt-0.5 text-[11px] text-ink-4">Set by @{goal.setBy}; shared with everyone on this document.</div>}
      {canEdit && (
        <form ref={(element) => bindElement(generation, generation.form, element)} className="mt-2 flex flex-wrap items-center gap-1.5" onSubmit={submit}>
          <select
            ref={(element) =>
              bindGoalElement(
                generation,
                generation.modeSelect,
                "mode",
                element,
              )
            }
            className="select h-8 shrink-0 px-1.5 text-[13px]"
            value={mode}
            onChange={changeMode}
            aria-label="Goal mode"
            data-testid="goal-mode"
          >
            <option value="min">At least</option>
            <option value="max">At most</option>
          </select>
          <input
            ref={(element) =>
              bindGoalElement(
                generation,
                generation.valueInput,
                "value",
                element,
              )
            }
            className="input h-8 w-18 shrink-0 px-2 text-[13px] tabular-nums"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder={kind === "words" ? "500" : "5"}
            value={value}
            onChange={changeValue}
            aria-label="Goal value"
            data-testid="goal-value"
          />
          <select
            ref={(element) =>
              bindGoalElement(
                generation,
                generation.kindSelect,
                "kind",
                element,
              )
            }
            className="select h-8 shrink-0 px-1.5 text-[13px]"
            value={kind}
            onChange={changeKind}
            aria-label="Goal type"
            data-testid="goal-kind"
          >
            <option value="words">words</option>
            <option value="minutes">min read</option>
          </select>
          <span
            className="ml-auto inline-flex gap-1.5"
            onKeyDownCapture={actionGroupKeyDownCapture}
            onKeyDown={actionGroupKeyDown}
          >
            <button ref={(element) => bindGoalElement(generation, generation.setButton, "set", element)} type="submit" className="btn btn-primary btn-sm h-8" disabled={presentation.setDisabled} onKeyDownCapture={(event) => actionKeyDownCapture("set", event)} onKeyDown={(event) => actionKeyDown("set", event)} data-testid="goal-set">
              Set
            </button>
            {goal && (
              <button ref={(element) => bindGoalElement(generation, generation.clearButton, "clear", element)} type="button" className="btn btn-ghost btn-sm h-8" onClick={clear} onKeyDownCapture={(event) => actionKeyDownCapture("clear", event)} onKeyDown={(event) => actionKeyDown("clear", event)} data-testid="goal-clear">
                Clear
              </button>
            )}
          </span>
        </form>
      )}
    </div>
  );
}
