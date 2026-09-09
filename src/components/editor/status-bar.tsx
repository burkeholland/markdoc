"use client";
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";

import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { AlertTriangle, ArrowUpDown, Check, ChevronDown, CircleHelp, GitBranch, HardDrive, Columns2, Code2, Eye, WrapText, MoreHorizontal } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { getGoal } from "@/editor/collab/meta";
import type { DocumentDto } from "@/server/dto";
import { lintMarkdown, type LintIssue } from "@/editor/markdown/lint";
import type { WritingGoal } from "@/editor/stats";

import { cn } from "@/lib/utils";
import { ThemeToggle, useTheme } from "@/components/ui/theme-toggle";
import { isThemePreference, THEME_ORDER, themeLabel, type ThemePreference } from "@/lib/theme";
import { useHydrated } from "@/lib/hooks";
import { jsonEqual, useDebouncedSessionValue, useSessionValue } from "./use-session";
import { StatsPopover, useLocalSelection, type SourceSelection } from "./stats-popover";
import { STATUS_BOX } from "./chrome-classes";

export type { Layout } from "@/lib/viewport";
import type { Layout } from "@/lib/viewport";

export interface StatusBarProps {
  session: CollabSession;
  doc: DocumentDto;
  layout: Layout;
  onLayout: (layout: Layout) => void;
  lineWrapping: boolean;
  onLineWrapping: (wrap: boolean) => void;
  syncScroll: boolean;
  onSyncScroll: (on: boolean) => void;
  onIssueSelect: (issue: LintIssue) => void;
  onShortcuts: () => void;
  onStorage?: () => void;
  /** Phone: word count · storage · ⋯ menu (layout, wrap, sync scrolling and theme live inside). */
  compact?: boolean;
}

interface StatusBarDocumentPublication {
  value: DocumentDto;
  storage: DocumentDto["storage"];
  repoBranch: DocumentDto["repoBranch"];
  repoOwner: DocumentDto["repoOwner"];
  repoName: DocumentDto["repoName"];
  repoPath: DocumentDto["repoPath"];
  gistId: DocumentDto["gistId"];
  hasUnpublishedChanges: DocumentDto["hasUnpublishedChanges"];
}

interface StatusBarIssuePublication {
  snapshot: readonly LintIssue[];
  issue: LintIssue;
  index: number;
  line: number;
  column: number;
  offset: number;
  message: string;
  rule: string;
  severity: LintIssue["severity"];
}

interface StatusBarAuthority {
  mount: symbol;
  publicationRevision: number;
  session: CollabSession;
  source: string;
  tree: unknown;
  document: StatusBarDocumentPublication;
  layout: Layout;
  layoutValues: readonly Layout[];
  onLayout: (layout: Layout) => void;
  lineWrapping: boolean;
  onLineWrapping: (wrap: boolean) => void;
  syncScroll: boolean;
  onSyncScroll: (on: boolean) => void;
  compact: boolean;
  hydrated: boolean;
  statsSelection: SourceSelection;
  statsSelectionFrom: number | null;
  statsSelectionTo: number | null;
  statsGoal: WritingGoal | null;
  statsGoalKind: WritingGoal["kind"] | null;
  statsGoalMode: WritingGoal["mode"] | null;
  statsGoalValue: number | null;
  statsGoalSetBy: string | null;
  statsGoalSetAt: number | null;
  issueSnapshot: readonly LintIssue[];
  issueRows: readonly StatusBarIssuePublication[];
  onIssueSelect: (issue: LintIssue) => void;
  onShortcuts: () => void;
  onStorage: (() => void) | undefined;
  themePreference: ThemePreference;
  themeValues: readonly ThemePreference[];
  setThemePreference: (next: ThemePreference) => void;
  menuOpen: boolean;
  issuesOpen: boolean;
}

interface StatusBarControlPublication<T extends HTMLElement = HTMLElement> {
  authority: StatusBarAuthority;
  epoch: number;
  slot: string;
  root: HTMLElement;
  control: T;
  enabled: boolean;
  claimed: boolean;
}

interface StatusBarNativeEventPublication {
  event: Event;
  type: string;
  target: EventTarget | null;
  currentTarget: EventTarget | null;
  path: readonly EventTarget[];
  bubbles: boolean;
  cancelable: boolean;
  composed: boolean;
  defaultPrevented: boolean;
  cancelBubble: boolean;
  trusted: boolean;
  timeStamp: number;
  phase: number;
  view: Window | null | undefined;
  key: string | undefined;
  code: string | undefined;
  repeat: boolean | undefined;
  composing: boolean | undefined;
  button: number | undefined;
  ctrlKey: boolean | undefined;
  altKey: boolean | undefined;
  metaKey: boolean | undefined;
  shiftKey: boolean | undefined;
  pointerId: number | undefined;
  pointerType: string | undefined;
  isPrimary: boolean | undefined;
  detail: number | undefined;
  extended: boolean;
  claimed: boolean;
  expired: boolean;
}

interface StatusBarReactEventPublication {
  event: SyntheticEvent<HTMLElement, Event>;
  native: StatusBarNativeEventPublication;
  type: string;
  target: EventTarget | null;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  timeStamp: number;
  phase: number;
  preventDefault: SyntheticEvent<HTMLElement, Event>["preventDefault"];
  stopPropagation: SyntheticEvent<HTMLElement, Event>["stopPropagation"];
  isDefaultPrevented: SyntheticEvent<HTMLElement, Event>["isDefaultPrevented"];
  isPropagationStopped: SyntheticEvent<HTMLElement, Event>["isPropagationStopped"];
  claimed: boolean;
}

interface StatusBarIntrinsicGetter<T> {
  read: (target: object) => T;
  isCurrent: () => boolean;
}

interface StatusBarIntrinsicMethod<Args extends readonly unknown[], Result> {
  call: (target: object, ...args: Args) => Result;
  isCurrent: () => boolean;
}

interface StatusBarTrustAuthority {
  matches: (event: object) => boolean;
  read: (event: object) => boolean;
  isCurrent: () => boolean;
}

interface StatusBarKeyboardAuthority {
  ownerWindow: Window & typeof globalThis;
  eventPrototype: Event;
  keyboardPrototype: KeyboardEvent;
  documentPrototype: Document;
  htmlElementPrototype: HTMLElement;
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor;
  getPrototypeOf: typeof Object.getPrototypeOf;
  apply: typeof Reflect.apply;
  eventType: StatusBarIntrinsicGetter<string>;
  eventTarget: StatusBarIntrinsicGetter<EventTarget | null>;
  eventCurrentTarget: StatusBarIntrinsicGetter<EventTarget | null>;
  eventPhase: StatusBarIntrinsicGetter<number>;
  eventBubbles: StatusBarIntrinsicGetter<boolean>;
  eventCancelable: StatusBarIntrinsicGetter<boolean>;
  eventComposed: StatusBarIntrinsicGetter<boolean>;
  eventDefaultPrevented: StatusBarIntrinsicGetter<boolean>;
  eventCancelBubble: StatusBarIntrinsicGetter<boolean>;
  eventTimeStamp: StatusBarIntrinsicGetter<number>;
  eventPath: StatusBarIntrinsicMethod<readonly [], EventTarget[]>;
  eventPreventDefault: StatusBarIntrinsicMethod<readonly [], void>;
  eventStopPropagation: StatusBarIntrinsicMethod<readonly [], void>;
  eventStopImmediatePropagation: StatusBarIntrinsicMethod<readonly [], void>;
  eventView: StatusBarIntrinsicGetter<Window | null>;
  keyboardKey: StatusBarIntrinsicGetter<string>;
  keyboardCode: StatusBarIntrinsicGetter<string>;
  keyboardCtrl: StatusBarIntrinsicGetter<boolean>;
  keyboardMeta: StatusBarIntrinsicGetter<boolean>;
  keyboardAlt: StatusBarIntrinsicGetter<boolean>;
  keyboardShift: StatusBarIntrinsicGetter<boolean>;
  keyboardRepeat: StatusBarIntrinsicGetter<boolean>;
  keyboardComposing: StatusBarIntrinsicGetter<boolean>;
  activeElement: StatusBarIntrinsicGetter<Element | null>;
  focus: StatusBarIntrinsicMethod<readonly [FocusOptions?], void>;
  isTrusted: StatusBarTrustAuthority;
  isCurrent: () => boolean;
}

interface StatusBarEventIntent {
  generation: StatusBarGeneration;
  publication: StatusBarControlPublication;
  nativeEvents: StatusBarNativeEventPublication[];
  reactEvents: StatusBarReactEventPublication[];
  claimedPublication: boolean;
  claims: Set<string>;
  pending: (() => void) | null;
  requiresReact: boolean;
}

interface StatusBarNodeSeal {
  node: Node;
  children: readonly Node[];
  attributes: readonly (readonly [string, string])[] | null;
  data: string | null;
  name: string | null;
  namespace: string | null;
}

interface StatusBarRelationSeal {
  node: Node;
  parent: Node | null;
  previous: Node | null;
  next: Node | null;
}

interface StatusBarObserverPublication {
  observer: MutationObserver;
  target: Node;
  statsPortal: boolean;
}

interface StatusBarOutsidePointerChain {
  pointerDown: StatusBarNativeEventPublication;
  pointerUp: StatusBarNativeEventPublication | null;
  click: StatusBarNativeEventPublication | null;
  expiresAt: number;
  cancelExpiry: () => void;
}

interface StatusBarStatsMutationLease {
  expectedOpen: boolean;
  controlsId: string | null;
  side: string | null;
  align: string | null;
  nativeEvents: readonly StatusBarNativeEventPublication[];
  reactEvent: StatusBarReactEventPublication | null;
  portalObserver: MutationObserver;
  portalRecords: MutationRecord[];
  subtreeRecords: MutationRecord[];
  triggerRecords: MutationRecord[];
  expiresAt: number;
  cancelExpiry: () => void;
}

interface StatusBarStatsPlacementLease {
  side: string;
  align: string;
  expiresAt: number;
  cancelExpiry: () => void;
}

interface StatusBarStatsBoundaryPublication {
  identity: symbol;
  session: CollabSession;
  side: string;
  align: string;
  ownerDocument: Document;
  trigger: HTMLButtonElement;
  content: HTMLElement;
  portal: HTMLElement;
}

type StatusBarPortalSlot = "menu-content" | "issues-content";

interface StatusBarPortalBoundaryPublication {
  identity: symbol;
  authority: StatusBarAuthority;
  slot: StatusBarPortalSlot;
  ownerDocument: Document;
  root: HTMLElement;
  content: HTMLElement;
  portal: HTMLElement;
}

interface StatusBarGeneration {
  manager: StatusBarPublicationManager;
  authority: StatusBarAuthority;
  epoch: number;
  identity: symbol;
  root: HTMLElement;
  ownerDocument: Document;
  controls: Map<string, StatusBarControlPublication>;
  portalBoundaries: Map<StatusBarPortalSlot, StatusBarPortalBoundaryPublication>;
  actions: Set<string>;
  nativeEvents: WeakMap<Event, StatusBarNativeEventPublication>;
  reactEvents: WeakMap<object, StatusBarReactEventPublication>;
  pendingIntents: Set<StatusBarEventIntent>;
  outsidePointerChain: StatusBarOutsidePointerChain | null;
  statsTrigger: HTMLButtonElement;
  statsBoundary: StatusBarStatsBoundaryPublication | null;
  retiredStatsBoundary: StatusBarStatsBoundaryPublication | null;
  statsContent: HTMLElement | null;
  statsPortalRoot: HTMLElement | null;
  statsSide: string | null;
  statsAlign: string | null;
  statsMutationLease: StatusBarStatsMutationLease | null;
  statsPlacementLease: StatusBarStatsPlacementLease | null;
  nodeSeals: StatusBarNodeSeal[];
  relationSeals: StatusBarRelationSeal[];
  observers: StatusBarObserverPublication[];
  removeEventListeners: (() => void)[];
  keyboardAuthority: StatusBarKeyboardAuthority | null;
  menuMutationObserved: boolean;
  retired: boolean;
}

interface StatusBarPublicationManager {
  mount: symbol;
  epoch: number;
  candidates: Map<string, StatusBarControlPublication>;
  active: StatusBarGeneration | null;
  statsBoundary: StatusBarStatsBoundaryPublication | null;
  portalBoundaries: Map<StatusBarPortalSlot, StatusBarPortalBoundaryPublication>;
  directionalNativeEvents: WeakSet<Event>;
  directionalReactEvents: WeakSet<object>;
  directionalFocusEvents: WeakSet<Event>;
  successorRequested: boolean;
  requestSuccessor: () => void;
}

interface StatusBarValueIntent<T> {
  authority: StatusBarAuthority;
  value: T;
  event: StatusBarEventIntent;
}

interface StatusBarDisclosureIntent {
  authority: StatusBarAuthority;
  event: StatusBarEventIntent;
}

type StatusBarMenuFocusDirection = "first" | "last";

interface StatusBarMenuFocusIntent {
  authority: StatusBarAuthority;
  generation: StatusBarGeneration;
  publication: StatusBarControlPublication<HTMLButtonElement>;
  interaction: StatusBarEventIntent;
  keyboardAuthority: StatusBarKeyboardAuthority;
  direction: StatusBarMenuFocusDirection;
  native: StatusBarNativeEventPublication;
  react: StatusBarReactEventPublication;
  trigger: HTMLButtonElement;
  root: HTMLElement;
  ownerDocument: Document;
  ownerWindow: Window & typeof globalThis;
  claimed: boolean;
}

type StatusBarReactEvent =
  | ReactKeyboardEvent<HTMLElement>
  | ReactMouseEvent<HTMLElement>
  | ReactPointerEvent<HTMLElement>;

const DESKTOP_LAYOUTS: readonly Layout[] = Object.freeze(["split", "code", "rich"]);
const COMPACT_LAYOUTS: readonly Layout[] = Object.freeze(["code", "rich"]);
const STATUS_BAR_THEMES: readonly ThemePreference[] = Object.freeze([...THEME_ORDER]);
const OUTSIDE_POINTER_GESTURE_LEASE_MS = 5_000;
const OUTSIDE_POINTER_CALLBACK_LEASE_MS = 1_000;
const STATS_MUTATION_LEASE_MS = 1_000;
const STATUS_BAR_NATIVE_EVENTS = [
  "click",
  "keydown",
  "pointerdown",
  "pointerup",
  "pointercancel",
  "focusin",
  "focusout",
  "menu.itemSelect",
  "dismissableLayer.pointerDownOutside",
  "dismissableLayer.focusOutside",
] as const;

function statusBarDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  return Boolean(
    current
    && current.configurable === expected.configurable
    && current.enumerable === expected.enumerable
    && current.get === expected.get
    && current.set === expected.set
    && current.value === expected.value
    && current.writable === expected.writable
  );
}

function statusBarEventView(event: Event) {
  if (!("view" in event)) return undefined;
  const view = event.view;
  return view === null || typeof view === "object"
    ? view as Window | null
    : undefined;
}

function captureStatusBarKeyboardAuthority(
  ownerWindow: Window & typeof globalThis,
): StatusBarKeyboardAuthority | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const eventPrototype = ownerWindow.Event.prototype;
  const keyboardPrototype = ownerWindow.KeyboardEvent.prototype;
  const documentPrototype = ownerWindow.Document.prototype;
  const htmlElementPrototype = ownerWindow.HTMLElement.prototype;
  const prototypeLinks: (readonly [object, object | null])[] = [];
  const authorities: { isCurrent: () => boolean }[] = [];
  const capturedPrototypes = new Set<object>();
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
    eventPrototype,
    documentPrototype,
    htmlElementPrototype,
  ].forEach(capturePrototypeChain);

  const captureGetter = <T,>(
    prototype: object,
    property: PropertyKey,
  ): StatusBarIntrinsicGetter<T> | null => {
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
            statusBarDescriptorsMatch(
              getOwnPropertyDescriptor(owner, property),
              expected,
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
  ): StatusBarIntrinsicMethod<Args, Result> | null => {
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
            statusBarDescriptorsMatch(
              getOwnPropertyDescriptor(owner, property),
              expected,
            ),
        });
        authorities.push(authority);
        return authority;
      }
      current = getPrototypeOf(current) as object | null;
    }
    return null;
  };

  const eventType = captureGetter<string>(eventPrototype, "type");
  const eventTarget = captureGetter<EventTarget | null>(eventPrototype, "target");
  const eventCurrentTarget = captureGetter<EventTarget | null>(
    eventPrototype,
    "currentTarget",
  );
  const eventPhase = captureGetter<number>(eventPrototype, "eventPhase");
  const eventBubbles = captureGetter<boolean>(eventPrototype, "bubbles");
  const eventCancelable = captureGetter<boolean>(eventPrototype, "cancelable");
  const eventComposed = captureGetter<boolean>(eventPrototype, "composed");
  const eventDefaultPrevented = captureGetter<boolean>(
    eventPrototype,
    "defaultPrevented",
  );
  const eventCancelBubble = captureGetter<boolean>(
    eventPrototype,
    "cancelBubble",
  );
  const eventTimeStamp = captureGetter<number>(eventPrototype, "timeStamp");
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
  const keyboardCtrl = captureGetter<boolean>(keyboardPrototype, "ctrlKey");
  const keyboardMeta = captureGetter<boolean>(keyboardPrototype, "metaKey");
  const keyboardAlt = captureGetter<boolean>(keyboardPrototype, "altKey");
  const keyboardShift = captureGetter<boolean>(keyboardPrototype, "shiftKey");
  const keyboardRepeat = captureGetter<boolean>(keyboardPrototype, "repeat");
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

  let trustProbe: KeyboardEvent;
  try {
    trustProbe = new ownerWindow.KeyboardEvent("status-bar-keyboard-intrinsic");
  } catch {
    return null;
  }
  const trustDescriptor = getOwnPropertyDescriptor(trustProbe, "isTrusted");
  if (
    !trustDescriptor
    || trustDescriptor.configurable !== false
    || typeof trustDescriptor.get !== "function"
    || trustDescriptor.set !== undefined
  )
    return null;
  const expectedTrustDescriptor = Object.freeze({ ...trustDescriptor });
  const isTrusted = Object.freeze({
    matches: (event: object) =>
      statusBarDescriptorsMatch(
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
      statusBarDescriptorsMatch(
        getOwnPropertyDescriptor(trustProbe, "isTrusted"),
        expectedTrustDescriptor,
      ),
  });

  if (
    !eventType
    || !eventTarget
    || !eventCurrentTarget
    || !eventPhase
    || !eventBubbles
    || !eventCancelable
    || !eventComposed
    || !eventDefaultPrevented
    || !eventCancelBubble
    || !eventTimeStamp
    || !eventPath
    || !eventPreventDefault
    || !eventStopPropagation
    || !eventStopImmediatePropagation
    || !eventView
    || !keyboardKey
    || !keyboardCode
    || !keyboardCtrl
    || !keyboardMeta
    || !keyboardAlt
    || !keyboardShift
    || !keyboardRepeat
    || !keyboardComposing
    || !activeElement
    || !focus
  )
    return null;

  const isCurrent = () =>
    ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor
    && ownerWindow.Object.getPrototypeOf === getPrototypeOf
    && ownerWindow.Reflect.apply === apply
    && ownerWindow.Event.prototype === eventPrototype
    && ownerWindow.KeyboardEvent.prototype === keyboardPrototype
    && ownerWindow.Document.prototype === documentPrototype
    && ownerWindow.HTMLElement.prototype === htmlElementPrototype
    && prototypeLinks.every(
      ([prototype, parent]) => getPrototypeOf(prototype) === parent,
    )
    && isTrusted.isCurrent()
    && authorities.every((authority) => authority.isCurrent());

  return Object.freeze({
    ownerWindow,
    eventPrototype,
    keyboardPrototype,
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
    keyboardCtrl,
    keyboardMeta,
    keyboardAlt,
    keyboardShift,
    keyboardRepeat,
    keyboardComposing,
    activeElement,
    focus,
    isTrusted,
    isCurrent,
  });
}

const StatusBarStatsPopover = memo(
  StatsPopover,
  (previous, next) => (
    previous.session === next.session
    && previous.source === next.source
    && previous.hydrated === next.hydrated
    && previous.selection?.from === next.selection?.from
    && previous.selection?.to === next.selection?.to
  ),
);

function createPublicationManager(
  requestSuccessor: () => void,
): StatusBarPublicationManager {
  return {
    mount: Symbol("status-bar"),
    epoch: 0,
    candidates: new Map(),
    active: null,
    statsBoundary: null,
    portalBoundaries: new Map(),
    directionalNativeEvents: new WeakSet(),
    directionalReactEvents: new WeakSet(),
    directionalFocusEvents: new WeakSet(),
    successorRequested: false,
    requestSuccessor,
  };
}

function documentPublicationIsExact(document: StatusBarDocumentPublication) {
  const current = document.value;
  return (
    current.storage === document.storage
    && current.repoBranch === document.repoBranch
    && current.repoOwner === document.repoOwner
    && current.repoName === document.repoName
    && current.repoPath === document.repoPath
    && current.gistId === document.gistId
    && current.hasUnpublishedChanges === document.hasUnpublishedChanges
  );
}

function issuePublicationIsExact(authority: StatusBarAuthority, row: StatusBarIssuePublication) {
  const issue = row.issue;
  return (
    row.snapshot === authority.issueSnapshot
    && authority.issueRows[row.index] === row
    && row.snapshot[row.index] === issue
    && issue.line === row.line
    && issue.column === row.column
    && issue.offset === row.offset
    && issue.message === row.message
    && issue.rule === row.rule
    && issue.severity === row.severity
  );
}

function authorityIsExact(authority: StatusBarAuthority) {
  const expectedLayouts = authority.compact ? COMPACT_LAYOUTS : DESKTOP_LAYOUTS;
  const selection = authority.statsSelection;
  const goal = authority.statsGoal;
  const currentGoal = getGoal(authority.session);
  if (
    authority.layoutValues.length !== expectedLayouts.length
    || authority.layoutValues.some((value, index) => value !== expectedLayouts[index])
    || authority.themeValues.length !== STATUS_BAR_THEMES.length
    || authority.themeValues.some((value, index) => value !== STATUS_BAR_THEMES[index])
    || !documentPublicationIsExact(authority.document)
    || authority.issueRows.length !== authority.issueSnapshot.length
    || (selection
      ? selection.from !== authority.statsSelectionFrom
        || selection.to !== authority.statsSelectionTo
      : authority.statsSelectionFrom !== null || authority.statsSelectionTo !== null)
    || (goal
      ? goal.kind !== authority.statsGoalKind
        || goal.mode !== authority.statsGoalMode
        || goal.value !== authority.statsGoalValue
        || goal.setBy !== authority.statsGoalSetBy
        || goal.setAt !== authority.statsGoalSetAt
      : authority.statsGoalKind !== null
        || authority.statsGoalMode !== null
        || authority.statsGoalValue !== null
        || authority.statsGoalSetBy !== null
        || authority.statsGoalSetAt !== null)
    || (currentGoal
      ? currentGoal.kind !== authority.statsGoalKind
        || currentGoal.mode !== authority.statsGoalMode
        || currentGoal.value !== authority.statsGoalValue
        || currentGoal.setBy !== authority.statsGoalSetBy
        || currentGoal.setAt !== authority.statsGoalSetAt
      : authority.statsGoal !== null)
  )
    return false;
  return authority.issueRows.every((row, index) => row.index === index && issuePublicationIsExact(authority, row));
}

function expectedStatusBarSlots(authority: StatusBarAuthority) {
  const slots = ["root", "menu-trigger", "storage"];
  if (!authority.compact) slots.push("issues-trigger", "desktop-shortcuts");
  if (authority.menuOpen) {
    slots.push("menu-content");
    authority.layoutValues.forEach((value) => slots.push(`layout:${value}`));
    slots.push("line-wrapping", "sync-scroll");
    if (authority.compact) {
      authority.themeValues.forEach((value) => slots.push(`theme:${value}`));
      slots.push("compact-shortcuts");
    }
  }
  if (authority.issuesOpen && !authority.compact) {
    slots.push("issues-content");
    authority.issueRows.forEach((row) => slots.push(`issue:${row.index}`));
  }
  return slots;
}

function isStatusBarMenuItemSlot(slot: string) {
  return (
    slot.startsWith("layout:")
    || slot === "line-wrapping"
    || slot === "sync-scroll"
    || slot.startsWith("theme:")
    || slot === "compact-shortcuts"
  );
}

function statusBarMenuAuthoritiesAreSuccessive(
  closed: StatusBarAuthority,
  open: StatusBarAuthority,
) {
  return (
    Object.isFrozen(closed)
    && Object.isFrozen(open)
    && closed !== open
    && !closed.menuOpen
    && open.menuOpen
    && closed.mount === open.mount
    && closed.publicationRevision === open.publicationRevision
    && closed.session === open.session
    && closed.source === open.source
    && closed.tree === open.tree
    && closed.document === open.document
    && closed.layout === open.layout
    && closed.layoutValues === open.layoutValues
    && closed.onLayout === open.onLayout
    && closed.lineWrapping === open.lineWrapping
    && closed.onLineWrapping === open.onLineWrapping
    && closed.syncScroll === open.syncScroll
    && closed.onSyncScroll === open.onSyncScroll
    && closed.compact === open.compact
    && closed.hydrated === open.hydrated
    && closed.statsSelection === open.statsSelection
    && closed.statsSelectionFrom === open.statsSelectionFrom
    && closed.statsSelectionTo === open.statsSelectionTo
    && closed.statsGoal === open.statsGoal
    && closed.statsGoalKind === open.statsGoalKind
    && closed.statsGoalMode === open.statsGoalMode
    && closed.statsGoalValue === open.statsGoalValue
    && closed.statsGoalSetBy === open.statsGoalSetBy
    && closed.statsGoalSetAt === open.statsGoalSetAt
    && closed.issueSnapshot === open.issueSnapshot
    && closed.issueRows.length === open.issueRows.length
    && closed.issueRows.every((row, index) => {
      const successor = open.issueRows[index];
      return Boolean(
        successor
        && row.snapshot === successor.snapshot
        && row.issue === successor.issue
        && row.index === successor.index
        && row.line === successor.line
        && row.column === successor.column
        && row.offset === successor.offset
        && row.message === successor.message
        && row.rule === successor.rule
        && row.severity === successor.severity
      );
    })
    && closed.onIssueSelect === open.onIssueSelect
    && closed.onShortcuts === open.onShortcuts
    && closed.onStorage === open.onStorage
    && closed.themePreference === open.themePreference
    && closed.themeValues === open.themeValues
    && closed.setThemePreference === open.setThemePreference
    && closed.issuesOpen === open.issuesOpen
  );
}

function statusBarEventPathIsExact(
  target: Node,
  path: readonly EventTarget[],
  ownerDocument: Document,
  ownerWindow: Window,
) {
  const expected: EventTarget[] = [];
  let current: Node | null = target;
  while (current) {
    expected.push(current);
    current = current.parentNode;
  }
  const pathWindow = path.at(-1);
  return (
    expected.includes(ownerDocument)
    && path.length === expected.length + 1
    && arraysAreIdentical(expected, path.slice(0, -1))
    && typeof pathWindow === "object"
    && pathWindow !== null
    && "document" in pathWindow
    && pathWindow.document === ownerDocument
    && ownerDocument.defaultView === ownerWindow
  );
}

function statusBarEventWindowMatches(
  candidate: { readonly document: Document } | null | undefined,
  ownerDocument: Document,
  ownerWindow: Window,
) {
  return (
    candidate === ownerWindow
    || (
      candidate != null
      && candidate.document === ownerDocument
      && ownerDocument.defaultView === ownerWindow
    )
  );
}

function stableAttributes(element: Element) {
  const menuItem = element.getAttribute("role")?.startsWith("menuitem") ?? false;
  const placed = element.hasAttribute("data-radix-popper-content-wrapper")
    || element.hasAttribute("data-testid")
      && ["status-menu-content", "status-issues-content", "stats-popover"].includes(
        element.getAttribute("data-testid") ?? "",
      );
  return [...element.attributes]
    .filter((attribute) => {
      if (menuItem && ["data-highlighted", "tabindex"].includes(attribute.name)) return false;
      if (placed && ["style", "data-side", "data-align"].includes(attribute.name)) return false;
      if (["data-radix-popper-side", "data-radix-popper-align"].includes(attribute.name)) return false;
      return true;
    })
    .map((attribute) => [attribute.name, attribute.value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

function sealSubtree(
  root: Node,
  seals: StatusBarNodeSeal[],
  seen: Set<Node>,
) {
  if (seen.has(root)) return;
  seen.add(root);
  sealNode(root, seals);
  root.childNodes.forEach((child) => sealSubtree(child, seals, seen));
}

function sealNode(
  node: Node,
  seals: StatusBarNodeSeal[],
) {
  const element = node instanceof Element ? node : null;
  const data = node instanceof CharacterData ? node.data : null;
  seals.push({
    node,
    children: Object.freeze([...node.childNodes]),
    attributes: element ? Object.freeze(stableAttributes(element)) : null,
    data,
    name: element?.tagName ?? null,
    namespace: element?.namespaceURI ?? null,
  });
}

function sealRelations(
  node: Node,
  ownerDocument: Document,
  seals: StatusBarRelationSeal[],
  seen: Set<Node>,
) {
  let current: Node | null = node;
  while (current && !seen.has(current)) {
    seen.add(current);
    seals.push({
      node: current,
      parent: current.parentNode,
      previous: current.previousSibling,
      next: current.nextSibling,
    });
    if (current === ownerDocument) return;
    current = current.parentNode;
  }
}

function arraysAreIdentical<T>(left: readonly T[], right: readonly T[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function controlIsEnabled(control: HTMLElement) {
  return (
    !("disabled" in control && control.disabled === true)
    && control.getAttribute("aria-disabled") !== "true"
    && !control.hasAttribute("data-disabled")
  );
}

function nodeSealIsExact(seal: StatusBarNodeSeal, ignoreAttributes = false) {
  const element = seal.node instanceof Element ? seal.node : null;
  return (
    arraysAreIdentical([...seal.node.childNodes], seal.children)
    && (
      ignoreAttributes
      || !seal.attributes
      || Boolean(element && arraysAreIdentical(
        stableAttributes(element).map(([name, value]) => `${name}\u0000${value}`),
        seal.attributes.map(([name, value]) => `${name}\u0000${value}`),
      ))
    )
    && (seal.data === null || seal.node instanceof CharacterData && seal.node.data === seal.data)
    && (seal.name === null || element?.tagName === seal.name)
    && (seal.namespace === null || element?.namespaceURI === seal.namespace)
  );
}

function refreshNodeSeals(generation: StatusBarGeneration) {
  generation.nodeSeals.length = 0;
  const seen = new Set<Node>();
  sealSubtree(generation.root, generation.nodeSeals, seen);
  for (const slot of ["menu-content", "issues-content"]) {
    const content = generation.controls.get(slot)?.control;
    if (!content) continue;
    let top: Node = content;
    while (top.parentNode && top.parentNode !== generation.ownerDocument.body)
      top = top.parentNode;
    sealSubtree(top, generation.nodeSeals, seen);
  }
  if (generation.statsPortalRoot)
    sealNode(generation.statsPortalRoot, generation.nodeSeals);
}

function mutationTouchesStatusBarMenu(
  generation: StatusBarGeneration,
  record: MutationRecord,
) {
  const trigger = generation.controls.get("menu-trigger")?.control;
  const boundary = generation.authority.menuOpen
    ? generation.portalBoundaries.get("menu-content")
    : undefined;
  if (
    !generation.authority.menuOpen
    && record.type === "attributes"
    && record.target === trigger
    && record.attributeName
    && ["data-radix-popper-side", "data-radix-popper-align"].includes(
      record.attributeName,
    )
    && record.oldValue !== null
    && !trigger?.hasAttribute(record.attributeName)
  )
    return false;
  const ownedNodes = [trigger, boundary?.content, boundary?.portal].filter(
    (node): node is HTMLElement => Boolean(node),
  );
  if (
    ownedNodes.some(
      (node) =>
        record.target === node
        || node.contains(record.target),
    )
  )
    return true;
  if (record.type !== "childList") return false;
  return [...record.addedNodes, ...record.removedNodes].some((changed) =>
    ownedNodes.some(
      (node) =>
        changed === node
        || changed.contains(node)
        || node.contains(changed),
    ),
  );
}

function retainStatusBarMenuMutationHistory(
  generation: StatusBarGeneration,
  records: readonly MutationRecord[],
) {
  if (
    !generation.menuMutationObserved
    && records.some((record) => mutationTouchesStatusBarMenu(generation, record))
  )
    generation.menuMutationObserved = true;
}

function validateGeneration(generation: StatusBarGeneration, drain = true): boolean {
  if (generation.retired) return false;
  const placementLease = generation.statsPlacementLease;
  if (placementLease && !statsPlacementLeaseIsCurrent(generation, placementLease))
    return false;
  if (!authorityIsExact(generation.authority)) {
    retireGeneration(generation);
    return false;
  }
  if (
    generation.manager.statsBoundary !== generation.statsBoundary
    || (
      !generation.statsMutationLease
      && generation.statsBoundary
      && !statsBoundaryPublicationIsExact(
        generation,
        generation.statsBoundary,
      )
    )
  ) {
    retireGeneration(generation);
    return false;
  }
  if (drain) {
    for (const publication of generation.observers) {
      const records = publication.observer.takeRecords();
      retainStatusBarMenuMutationHistory(generation, records);
      const lease = generation.statsMutationLease;
      const deferredStatsClose = Boolean(
        records.length > 0
        && publication.statsPortal
        && lease
        && !lease.expectedOpen
        && lease.triggerRecords.length > 0,
      );
      if (deferredStatsClose && lease) {
        lease.subtreeRecords.push(...records);
      } else if (!mutationsAreOwned(generation, records)) {
        retireGeneration(generation);
        return false;
      }
      if (records.some((record) => record.type === "childList"))
        refreshRelationSeals(generation);
    }
    const lease = generation.statsMutationLease;
    if (lease && statsMutationLeaseIsCurrent(generation, lease)) {
      lease.portalRecords.push(...lease.portalObserver.takeRecords());
      if (lease.portalRecords.length > 0 && lease.triggerRecords.length === 0) {
        retireGeneration(generation);
        return false;
      }
    }
  }
  if (
    !generation.root.isConnected
    || generation.root.ownerDocument !== generation.ownerDocument
    || !generation.ownerDocument.documentElement.contains(generation.root)
  ) {
    retireGeneration(generation);
    return false;
  }
  const currentPlacementLease = generation.statsPlacementLease;
  if (
    currentPlacementLease
    && !statsPendingPlacementIsExact(generation, currentPlacementLease)
  ) {
    retireGeneration(generation);
    return false;
  }
  const statsTransition = generation.statsMutationLease?.triggerRecords.length
    ? generation.statsMutationLease
    : null;
  for (const seal of generation.nodeSeals) {
    const transitionAttribute = Boolean(
      statsTransition
      && (
        seal.node === generation.statsTrigger
        || generation.statsPortalRoot?.contains(seal.node)
      ),
    );
    if (!nodeSealIsExact(seal, transitionAttribute)) {
      retireGeneration(generation);
      return false;
    }
  }
  const relationsAreExact = generation.relationSeals.every((seal) => (
    seal.node.parentNode === seal.parent
    && seal.node.previousSibling === seal.previous
    && seal.node.nextSibling === seal.next
  ));
  if (!relationsAreExact) retireGeneration(generation);
  return relationsAreExact;
}

function isStatusBarFocusGuard(node: Node) {
  return (
    node instanceof HTMLElement
    && node.tagName === "SPAN"
    && node.hasAttribute("data-radix-focus-guard")
  );
}

function isStatusBarPortalSlot(slot: string): slot is StatusBarPortalSlot {
  return slot === "menu-content" || slot === "issues-content";
}

function statusBarPortalTestId(slot: StatusBarPortalSlot) {
  return slot === "menu-content"
    ? "status-menu-content"
    : "status-issues-content";
}

function statusBarPortalBoundaryIsExact(
  publication: StatusBarPortalBoundaryPublication,
  connected: boolean,
) {
  const { content, ownerDocument, portal, root, slot } = publication;
  const matchingContents = connected
    ? [...ownerDocument.querySelectorAll<HTMLElement>(
      `[data-testid="${statusBarPortalTestId(slot)}"]`,
    )]
    : [];
  return (
    Object.isFrozen(publication)
    && typeof publication.identity === "symbol"
    && root.ownerDocument === ownerDocument
    && content.ownerDocument === ownerDocument
    && portal.ownerDocument === ownerDocument
    && content.getAttribute("data-testid") === statusBarPortalTestId(slot)
    && content.parentElement === portal
    && portal.hasAttribute("data-radix-popper-content-wrapper")
    && (
      connected
        ? root.isConnected
          && content.isConnected
          && portal.isConnected
          && portal.parentElement === ownerDocument.body
          && matchingContents.length === 1
          && matchingContents[0] === content
        : !content.isConnected
          && !portal.isConnected
          && portal.parentElement === null
    )
  );
}

function publishStatusBarPortalBoundary(
  manager: StatusBarPublicationManager,
  authority: StatusBarAuthority,
  slot: StatusBarPortalSlot,
  root: HTMLElement,
  content: HTMLElement,
) {
  const ownerDocument = root.ownerDocument;
  const portal = content.parentElement;
  if (
    authority.mount !== manager.mount
    || !authorityIsExact(authority)
    || !expectedStatusBarSlots(authority).includes(slot)
    || !root.isConnected
    || content.ownerDocument !== ownerDocument
    || !content.isConnected
    || content.getAttribute("data-testid") !== statusBarPortalTestId(slot)
    || !(portal instanceof HTMLElement)
    || portal.parentElement !== ownerDocument.body
    || !portal.hasAttribute("data-radix-popper-content-wrapper")
  )
    return false;
  const publication = Object.freeze({
    identity: Symbol(`status-bar-${slot}-portal`),
    authority,
    slot,
    ownerDocument,
    root,
    content,
    portal,
  });
  manager.portalBoundaries.set(slot, publication);
  return statusBarPortalBoundaryIsExact(publication, true);
}

function publishedStatusBarPortalForNode(
  generation: StatusBarGeneration,
  node: Node,
) {
  const publications = new Set([
    ...generation.portalBoundaries.values(),
    ...generation.manager.portalBoundaries.values(),
  ]);
  return [...publications].some((publication) => (
    publication.ownerDocument === generation.ownerDocument
    && publication.portal === node
    && (
      statusBarPortalBoundaryIsExact(publication, true)
      || statusBarPortalBoundaryIsExact(publication, false)
    )
  ));
}

function publishedStatusBarPlacementTarget(
  generation: StatusBarGeneration,
  target: Element,
) {
  const publications = new Set([
    ...generation.portalBoundaries.values(),
    ...generation.manager.portalBoundaries.values(),
  ]);
  return [...publications].some((publication) => (
    publication.ownerDocument === generation.ownerDocument
    && statusBarPortalBoundaryIsExact(publication, true)
    && (publication.portal === target || publication.content === target)
  ));
}

function mutationIsRadixOwned(
  generation: StatusBarGeneration,
  record: MutationRecord,
  openingStatsPortal: HTMLElement | null = null,
) {
  if (record.type === "childList") {
    const changed = [...record.addedNodes, ...record.removedNodes];
    return changed.length > 0 && changed.every((node) => (
      isStatusBarFocusGuard(node)
      || publishedStatusBarPortalForNode(generation, node)
      || node === openingStatsPortal
      || node === generation.statsPortalRoot
      || node === generation.retiredStatsBoundary?.portal
    ));
  }
  if (record.type !== "attributes" || !(record.target instanceof Element) || !record.attributeName)
    return false;
  const role = record.target.getAttribute("role");
  if (role?.startsWith("menuitem") && ["data-highlighted", "tabindex"].includes(record.attributeName))
    return true;
  if (
    (
      publishedStatusBarPlacementTarget(generation, record.target)
      || record.target === generation.statsPortalRoot
    )
    && ["style", "data-side", "data-align"].includes(record.attributeName)
  )
    return true;
  if (
    record.target === generation.statsPortalRoot
    && record.attributeName === "style"
  )
    return true;
  if (
    record.target === generation.statsContent
    && record.attributeName === "style"
    && statsBoundContentIsExact(generation)
  )
    return true;
  if (["data-radix-popper-side", "data-radix-popper-align"].includes(record.attributeName)) {
    return [...generation.controls.values()].some(
      ({ control }) => control === record.target,
    );
  }
  return false;
}

function statsBoundContentIsExact(generation: StatusBarGeneration) {
  const { statsContent: content, statsPortalRoot: portal } = generation;
  const publication = generation.statsBoundary;
  const controlsId = generation.statsTrigger.getAttribute("aria-controls");
  return (
    publication !== null
    && generation.manager.statsBoundary === publication
    && publication.session === generation.authority.session
    && publication.ownerDocument === generation.ownerDocument
    && publication.trigger === generation.statsTrigger
    && publication.content === content
    && publication.portal === portal
    && Object.isFrozen(publication)
    && typeof publication.identity === "symbol"
    && content !== null
    && portal !== null
    && controlsId !== null
    && generation.ownerDocument.getElementById(controlsId) === content
    && [...generation.ownerDocument.querySelectorAll<HTMLElement>("[id]")]
      .filter((element) => element.id === controlsId).length === 1
    && content.getAttribute("data-testid") === "stats-popover"
    && content.getAttribute("role") === "dialog"
    && content.getAttribute("data-state") === "open"
    && content.isConnected
    && content.ownerDocument === generation.ownerDocument
    && content.parentElement === portal
    && portal.parentElement === generation.ownerDocument.body
    && portal.hasAttribute("data-radix-popper-content-wrapper")
    && portal.isConnected
  );
}

function statsBoundaryPublicationIsExact(
  generation: StatusBarGeneration,
  publication: StatusBarStatsBoundaryPublication,
) {
  const { content, ownerDocument, portal, trigger } = publication;
  const controlsId = trigger.getAttribute("aria-controls");
  return (
    generation.manager.statsBoundary === publication
    && generation.statsBoundary === publication
    && publication.session === generation.authority.session
    && ownerDocument === generation.ownerDocument
    && trigger === generation.statsTrigger
    && Object.isFrozen(publication)
    && typeof publication.identity === "symbol"
    && content instanceof HTMLElement
    && portal instanceof HTMLElement
    && controlsId !== null
    && ownerDocument.getElementById(controlsId) === content
    && content.getAttribute("data-testid") === "stats-popover"
    && content.getAttribute("role") === "dialog"
    && content.getAttribute("data-state") === "open"
    && content.ownerDocument === ownerDocument
    && content.isConnected
    && content.parentElement === portal
    && portal.parentElement === ownerDocument.body
    && portal.hasAttribute("data-radix-popper-content-wrapper")
    && portal.ownerDocument === ownerDocument
    && portal.isConnected
    && [...ownerDocument.querySelectorAll<HTMLElement>("[id]")]
      .filter((element) => element.id === controlsId).length === 1
  );
}

function statsBoundaryCanRetireForSession(
  generation: StatusBarGeneration,
  publication: StatusBarStatsBoundaryPublication,
) {
  const { content, ownerDocument, portal, session, trigger } = publication;
  return (
    Object.isFrozen(publication)
    && typeof publication.identity === "symbol"
    && session !== generation.authority.session
    && ownerDocument === generation.ownerDocument
    && trigger === generation.statsTrigger
    && content.ownerDocument === ownerDocument
    && portal.ownerDocument === ownerDocument
    && content.parentElement === portal
    && !content.isConnected
    && !portal.isConnected
    && portal.parentElement === null
  );
}

function statsTriggerAfterSessionRetirementIsExact(
  generation: StatusBarGeneration,
  publication: StatusBarStatsBoundaryPublication,
) {
  const trigger = generation.statsTrigger;
  return (
    trigger.ownerDocument === generation.ownerDocument
    && trigger.parentElement === generation.root
    && trigger.isConnected
    && trigger.tagName === "BUTTON"
    && trigger.type === "button"
    && trigger.getAttribute("data-testid") === "stats-button"
    && trigger.getAttribute("aria-haspopup") === "dialog"
    && trigger.getAttribute("aria-expanded") === "false"
    && trigger.getAttribute("data-state") === "closed"
    && trigger.getAttribute("aria-controls") === null
    && trigger.getAttribute("data-radix-popper-side") === publication.side
    && trigger.getAttribute("data-radix-popper-align") === publication.align
    && generation.statsContent === null
    && generation.statsPortalRoot === null
    && generation.statsSide === null
    && generation.statsAlign === null
  );
}

function retiredStatsTriggerMutationIsExact(
  generation: StatusBarGeneration,
  records: readonly MutationRecord[],
) {
  const publication = generation.retiredStatsBoundary;
  const exact = Boolean(
    publication
    && records.length >= 1
    && records.length <= 2
    && new Set(records.map((record) => record.attributeName)).size === records.length
    && records.every((record) => (
      record.type === "attributes"
      && record.target === generation.statsTrigger
      && record.attributeNamespace === null
      && ["data-radix-popper-side", "data-radix-popper-align"].includes(
        record.attributeName ?? "",
      )
      && record.oldValue === (
        record.attributeName === "data-radix-popper-side"
          ? publication.side
          : publication.align
      )
      && generation.statsTrigger.getAttribute(record.attributeName ?? "") === null
    ))
  );
  if (
    exact
    && generation.statsTrigger.getAttribute("data-radix-popper-side") === null
    && generation.statsTrigger.getAttribute("data-radix-popper-align") === null
  )
    generation.retiredStatsBoundary = null;
  return exact;
}

function clearStatsPlacementLease(generation: StatusBarGeneration) {
  const lease = generation.statsPlacementLease;
  if (!lease) return;
  lease.cancelExpiry();
  generation.statsPlacementLease = null;
}

function statsPlacementLeaseIsCurrent(
  generation: StatusBarGeneration,
  lease: StatusBarStatsPlacementLease,
) {
  if (
    generation.statsPlacementLease !== lease
    || statusBarNow(generation) >= lease.expiresAt
  ) {
    if (generation.statsPlacementLease === lease)
      retireGeneration(generation);
    return false;
  }
  return true;
}

function statsPendingPlacementIsExact(
  generation: StatusBarGeneration,
  lease: StatusBarStatsPlacementLease,
) {
  const triggerSide = generation.statsTrigger.getAttribute("data-radix-popper-side");
  const triggerAlign = generation.statsTrigger.getAttribute("data-radix-popper-align");
  return (
    statsBoundContentIsExact(generation)
    && generation.statsContent?.getAttribute("data-side") === lease.side
    && generation.statsContent.getAttribute("data-align") === lease.align
    && (
      triggerSide === generation.statsSide
      || triggerSide === lease.side
    )
    && (
      triggerAlign === generation.statsAlign
      || triggerAlign === lease.align
    )
  );
}

function beginStatsPlacementLease(
  generation: StatusBarGeneration,
  side: string,
  align: string,
) {
  const ownerWindow = generation.ownerDocument.defaultView;
  if (
    !ownerWindow
    || generation.statsPlacementLease
    || generation.statsMutationLease
  )
    return false;
  const lease: StatusBarStatsPlacementLease = {
    side,
    align,
    expiresAt: statusBarNow(generation) + STATS_MUTATION_LEASE_MS,
    cancelExpiry: () => {},
  };
  generation.statsPlacementLease = lease;
  const timer = ownerWindow.setTimeout(() => {
    if (generation.statsPlacementLease === lease)
      retireGeneration(generation);
  }, STATS_MUTATION_LEASE_MS);
  lease.cancelExpiry = () => ownerWindow.clearTimeout(timer);
  return true;
}

function statsContentPlacementMutationIsExact(
  generation: StatusBarGeneration,
  records: readonly MutationRecord[],
) {
  const names = records.map((record) => record.attributeName);
  const side = generation.statsContent?.getAttribute("data-side");
  const align = generation.statsContent?.getAttribute("data-align");
  const triggerSide = generation.statsTrigger.getAttribute("data-radix-popper-side");
  const triggerAlign = generation.statsTrigger.getAttribute("data-radix-popper-align");
  if (
    generation.statsPlacementLease
    || generation.statsMutationLease
    || !statsBoundContentIsExact(generation)
    || !side
    || !align
    || side === generation.statsSide && align === generation.statsAlign
    || records.length < 1
    || records.length > 2
    || new Set(names).size !== records.length
    || records.some((record) => (
      record.type !== "attributes"
      || record.target !== generation.statsContent
      || record.attributeNamespace !== null
      || !["data-side", "data-align"].includes(record.attributeName ?? "")
      || record.oldValue !== (
        record.attributeName === "data-side"
          ? generation.statsSide
          : generation.statsAlign
      )
    ))
    || (!names.includes("data-side") && side !== generation.statsSide)
    || (!names.includes("data-align") && align !== generation.statsAlign)
    || ![generation.statsSide, side].includes(triggerSide)
    || ![generation.statsAlign, align].includes(triggerAlign)
  )
    return false;
  return beginStatsPlacementLease(generation, side, align);
}

function drainStatsContentPlacementRecords(generation: StatusBarGeneration) {
  const publication = generation.observers.find((candidate) => (
    candidate.statsPortal
    && candidate.target === generation.statsContent
  ));
  if (!publication) return true;
  const records = publication.observer.takeRecords();
  const placementRecords = records.filter((record) => (
    ["data-side", "data-align"].includes(record.attributeName ?? "")
  ));
  const otherRecords = records.filter((record) => !placementRecords.includes(record));
  return (
    otherRecords.every((record) => mutationIsRadixOwned(generation, record))
    && (
      placementRecords.length === 0
      || statsContentPlacementMutationIsExact(generation, placementRecords)
    )
  );
}

function statsTriggerStateIsExact(generation: StatusBarGeneration, open: boolean) {
  const trigger = generation.statsTrigger;
  const controlsId = trigger.getAttribute("aria-controls");
  const side = trigger.getAttribute("data-radix-popper-side");
  const align = trigger.getAttribute("data-radix-popper-align");
  return (
    trigger.ownerDocument === generation.ownerDocument
    && trigger.parentElement === generation.root
    && trigger.isConnected
    && trigger.tagName === "BUTTON"
    && trigger.type === "button"
    && trigger.getAttribute("data-testid") === "stats-button"
    && trigger.getAttribute("aria-haspopup") === "dialog"
    && trigger.getAttribute("aria-expanded") === String(open)
    && trigger.getAttribute("data-state") === (open ? "open" : "closed")
    && (open
      ? Boolean(
        controlsId
        && side
        && align
        && statsBoundContentIsExact(generation)
        && generation.statsContent?.getAttribute("data-side") === side
        && generation.statsContent.getAttribute("data-align") === align
        && generation.statsSide === side
        && generation.statsAlign === align,
      )
      : controlsId === null
        && side === null
        && align === null
        && generation.statsContent === null
        && generation.statsPortalRoot === null
        && generation.statsSide === null
        && generation.statsAlign === null)
  );
}

function clearStatsMutationLease(generation: StatusBarGeneration, claim: boolean) {
  const lease = generation.statsMutationLease;
  if (!lease) return;
  lease.cancelExpiry();
  lease.portalObserver.takeRecords();
  lease.portalObserver.disconnect();
  generation.statsMutationLease = null;
  lease.nativeEvents.forEach((event) => {
    event.extended = false;
    event.expired = true;
    if (claim) event.claimed = true;
  });
  if (lease.reactEvent) lease.reactEvent.claimed = claim;
  const chain = generation.outsidePointerChain;
  if (
    claim
    && chain
    && lease.nativeEvents.some((event) => (
      event === chain.pointerDown
      || event === chain.pointerUp
      || event === chain.click
    ))
  ) {
    chain.cancelExpiry();
    generation.outsidePointerChain = null;
  }
}

function expireStatsMutationLease(
  generation: StatusBarGeneration,
  lease: StatusBarStatsMutationLease,
) {
  lease.portalRecords.push(...lease.portalObserver.takeRecords());
  const mutated = (
    lease.triggerRecords.length > 0
    || lease.subtreeRecords.length > 0
    || lease.portalRecords.length > 0
  );
  clearStatsMutationLease(generation, false);
  if (mutated) retireGeneration(generation);
}

function statusBarNow(generation: StatusBarGeneration) {
  return generation.ownerDocument.defaultView?.performance.now()
    ?? Number.POSITIVE_INFINITY;
}

function statsMutationLeaseIsCurrent(
  generation: StatusBarGeneration,
  lease: StatusBarStatsMutationLease,
) {
  if (
    generation.statsMutationLease !== lease
    || statusBarNow(generation) >= lease.expiresAt
  ) {
    if (generation.statsMutationLease === lease)
      expireStatsMutationLease(generation, lease);
    return false;
  }
  return true;
}

function takeStatsPortalMutationRecords(lease: StatusBarStatsMutationLease) {
  lease.portalRecords.push(...lease.portalObserver.takeRecords());
  return lease.portalRecords.splice(0);
}

function drainStatsAncestorRecords(generation: StatusBarGeneration) {
  for (const publication of generation.observers) {
    if (publication.target === generation.ownerDocument.body)
      publication.observer.takeRecords();
  }
}

function statsOpeningPortalIsExact(
  generation: StatusBarGeneration,
  controlsId: string,
  records: readonly MutationRecord[],
) {
  const body = generation.ownerDocument.body;
  const topAdditions = records.flatMap((record) => (
    record.type === "childList" && record.target === body
      ? [...record.addedNodes].filter((node) => !isStatusBarFocusGuard(node))
      : []
  ));
  const changed = records.flatMap((record) => (
    record.type === "childList"
      ? [...record.addedNodes, ...record.removedNodes]
      : []
  ));
  const portal = topAdditions.length === 1
    && topAdditions[0] instanceof HTMLElement
    && topAdditions[0].hasAttribute("data-radix-popper-content-wrapper")
      ? topAdditions[0]
      : null;
  const content = portal?.firstElementChild;
  return (
    records.length > 0
    && records.every((record) => record.type === "childList")
    && portal !== null
    && portal.childElementCount === 1
    && content instanceof HTMLElement
    && content.id === controlsId
    && generation.ownerDocument.getElementById(controlsId) === content
    && content.getAttribute("data-testid") === "stats-popover"
    && content.getAttribute("role") === "dialog"
    && content.getAttribute("data-state") === "open"
    && content.ownerDocument === generation.ownerDocument
    && content.isConnected
    && [...generation.ownerDocument.querySelectorAll<HTMLElement>("[id]")]
      .filter((element) => element.id === controlsId).length === 1
    && records.every((record) => (
      [...record.removedNodes].every(isStatusBarFocusGuard)
      && [...record.addedNodes].every((node) => (
        isStatusBarFocusGuard(node)
        || node === portal
        || portal.contains(node)
      ))
    ))
    && changed.some((node) => node === portal)
      ? { content, portal }
      : null
  );
}

function statsClosingPortalIsExact(
  generation: StatusBarGeneration,
  records: readonly MutationRecord[],
) {
  const portal = generation.statsPortalRoot;
  if (!portal || !generation.statsContent || records.length === 0) return false;
  const body = generation.ownerDocument.body;
  const topRemovals = records.flatMap((record) => (
    record.type === "childList" && record.target === body
      ? [...record.removedNodes].filter((node) => !isStatusBarFocusGuard(node))
      : []
  ));
  return (
    topRemovals.length === 1
    && topRemovals[0] === portal
    && records.every((record) => (
      record.type === "childList"
      && [...record.addedNodes].every(isStatusBarFocusGuard)
      && [...record.removedNodes].every((node) => (
        isStatusBarFocusGuard(node)
        || node === portal
        || portal.contains(node)
      ))
    ))
    && !portal.isConnected
    && !generation.statsContent.isConnected
  );
}

function statsClosingSubtreeRecordsAreExact(
  generation: StatusBarGeneration,
  deferredRecords: readonly MutationRecord[],
) {
  const records = [
    ...deferredRecords,
    ...generation.observers
      .filter(({ statsPortal }) => statsPortal)
      .flatMap(({ observer }) => observer.takeRecords()),
  ];
  return records.every((record) => (
    record.type === "attributes"
    && record.attributeNamespace === null
    && (
      record.target === generation.statsContent
        && (
          record.attributeName === "data-state"
            ? record.oldValue === "open"
              && generation.statsContent?.getAttribute("data-state") === "closed"
          : ["style", "data-side", "data-align"].includes(record.attributeName ?? "")
        )
      || record.target === generation.statsPortalRoot
        && ["style", "data-side", "data-align"].includes(record.attributeName ?? "")
    )
  ));
}

function statsPlacementMutationIsExact(
  generation: StatusBarGeneration,
  records: readonly MutationRecord[],
) {
  if (!drainStatsContentPlacementRecords(generation)) return false;
  const lease = generation.statsPlacementLease;
  const oldSide = generation.statsSide;
  const oldAlign = generation.statsAlign;
  const side = generation.statsTrigger.getAttribute("data-radix-popper-side");
  const align = generation.statsTrigger.getAttribute("data-radix-popper-align");
  if (!(
    !generation.statsMutationLease
    && lease
    && statsPlacementLeaseIsCurrent(generation, lease)
    && statsBoundContentIsExact(generation)
    && side
    && align
    && generation.statsContent?.getAttribute("data-side") === side
    && generation.statsContent.getAttribute("data-align") === align
    && records.length >= 1
    && records.length <= 2
    && new Set(records.map((record) => record.attributeName)).size === records.length
    && records.every((record) => (
      record.type !== "attributes"
        ? false
        : record.target === generation.statsTrigger
          && record.attributeNamespace === null
          && ["data-radix-popper-side", "data-radix-popper-align"].includes(
        record.attributeName ?? "",
      )
          && record.oldValue === (
            record.attributeName === "data-radix-popper-side"
              ? oldSide
              : oldAlign
          )
    ))
  )) {
    return false;
  }
  clearStatsPlacementLease(generation);
  generation.statsSide = side;
  generation.statsAlign = align;
  const publication = generation.statsBoundary;
  if (publication) {
    const nextBoundary = Object.freeze({
      ...publication,
      identity: Symbol("status-bar-stats-boundary"),
      side,
      align,
    });
    generation.manager.statsBoundary = nextBoundary;
    generation.statsBoundary = nextBoundary;
  }
  return true;
}

function statsMutationIsExact(
  generation: StatusBarGeneration,
  records: readonly MutationRecord[],
) {
  const lease = generation.statsMutationLease;
  const triggerSeal = generation.nodeSeals.find((seal) => seal.node === generation.statsTrigger);
  const expectedNames = [
    "aria-expanded",
    "aria-controls",
    "data-state",
    "data-radix-popper-side",
    "data-radix-popper-align",
  ];
  if (
    !lease
    || !statsMutationLeaseIsCurrent(generation, lease)
    || !triggerSeal?.attributes
    || records.length === 0
    || records.some((record) => (
      record.type !== "attributes"
      || record.target !== generation.statsTrigger
      || record.attributeNamespace !== null
    ))
    || !lease.nativeEvents.every((event) => (
      (event.phase === Event.CAPTURING_PHASE || event.phase === Event.AT_TARGET)
      && nativeEventIsExact(
        event,
        event.phase,
        event.type === "keydown"
          && (event.code === "KeyC" || event.key === "Escape"),
      )
    ))
    || Boolean(lease.reactEvent && !reactEventIsExact(lease.reactEvent))
    || generation.nodeSeals.some((seal) => (
      (seal.node === generation.statsTrigger || generation.statsTrigger.contains(seal.node))
      && !nodeSealIsExact(seal, seal.node === generation.statsTrigger)
    ))
  ) {
    return false;
  }
  const triggerRecords = [...lease.triggerRecords, ...records];
  if (
    triggerRecords.length > expectedNames.length
    || !arraysAreIdentical(
      triggerRecords.map((record) => record.attributeName),
      expectedNames.slice(0, triggerRecords.length),
    )
  )
    return false;
  const oldOpen = !lease.expectedOpen;
  const oldValues = [
    String(oldOpen),
    oldOpen ? lease.controlsId : null,
    oldOpen ? "open" : "closed",
    oldOpen ? lease.side : null,
    oldOpen ? lease.align : null,
  ];
  if (!arraysAreIdentical(
    triggerRecords.map((record) => record.oldValue),
    oldValues.slice(0, triggerRecords.length),
  ))
    return false;
  lease.triggerRecords.push(...records);
  const currentControlsId = generation.statsTrigger.getAttribute("aria-controls");
  const currentSide = generation.statsTrigger.getAttribute("data-radix-popper-side");
  const currentAlign = generation.statsTrigger.getAttribute("data-radix-popper-align");
  const expectedAttributes = new Map(triggerSeal.attributes);
  if (triggerRecords.length >= 1)
    expectedAttributes.set("aria-expanded", String(lease.expectedOpen));
  if (triggerRecords.length >= 2) {
    if (lease.expectedOpen && currentControlsId)
      expectedAttributes.set("aria-controls", currentControlsId);
    else
      expectedAttributes.delete("aria-controls");
  }
  if (triggerRecords.length >= 3)
    expectedAttributes.set("data-state", lease.expectedOpen ? "open" : "closed");
  const expected = [...expectedAttributes]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}\u0000${value}`);
  if (!arraysAreIdentical(
    stableAttributes(generation.statsTrigger).map(([name, value]) => `${name}\u0000${value}`),
    expected,
  ))
    return false;
  if (triggerRecords.length < expectedNames.length) return true;
  const portalRecords = takeStatsPortalMutationRecords(lease);
  const openingPortal = lease.expectedOpen && currentControlsId
    ? statsOpeningPortalIsExact(generation, currentControlsId, portalRecords)
    : null;
  const currentBoundary = generation.statsBoundary;
  if (
    (
      lease.expectedOpen
        ? !currentControlsId || !currentSide || !currentAlign
        : currentControlsId !== null
    )
    || (
      lease.expectedOpen
        ? !openingPortal
        : !currentBoundary
          || generation.manager.statsBoundary !== currentBoundary
          || !statsClosingPortalIsExact(generation, portalRecords)
          || !statsClosingSubtreeRecordsAreExact(generation, lease.subtreeRecords)
    )
  )
    return false;
  drainStatsAncestorRecords(generation);
  clearStatsMutationLease(generation, true);
  const nextBoundary = openingPortal && currentSide && currentAlign
    ? Object.freeze({
      identity: Symbol("status-bar-stats-boundary"),
      session: generation.authority.session,
      side: currentSide,
      align: currentAlign,
      ownerDocument: generation.ownerDocument,
      trigger: generation.statsTrigger,
      content: openingPortal.content,
      portal: openingPortal.portal,
    })
    : null;
  generation.manager.statsBoundary = nextBoundary;
  generation.statsBoundary = nextBoundary;
  generation.statsContent = openingPortal?.content ?? null;
  generation.statsPortalRoot = openingPortal?.portal ?? null;
  generation.statsSide = lease.expectedOpen
    ? generation.statsTrigger.getAttribute("data-radix-popper-side")
    : null;
  generation.statsAlign = lease.expectedOpen
    ? generation.statsTrigger.getAttribute("data-radix-popper-align")
    : null;
  syncStatsPortalObserver(generation);
  if (!statsTriggerStateIsExact(generation, lease.expectedOpen)) return false;
  refreshNodeSeals(generation);
  refreshRelationSeals(generation);
  return true;
}

function mutationsAreOwned(
  generation: StatusBarGeneration,
  records: readonly MutationRecord[],
) {
  if (records.length === 0) return true;
  const addedWrappers = new Set<Node>();
  const removedWrappers = new Set<Node>();
  records.forEach((record) => {
    if (record.type !== "childList") return;
    record.addedNodes.forEach((node) => {
      if (
        node instanceof HTMLElement
        && node.hasAttribute("data-radix-popper-content-wrapper")
      )
        addedWrappers.add(node);
    });
    record.removedNodes.forEach((node) => {
      if (
        node instanceof HTMLElement
        && node.hasAttribute("data-radix-popper-content-wrapper")
      )
        removedWrappers.add(node);
    });
  });
  if ([...addedWrappers].some((node) => removedWrappers.has(node)))
    return false;
  const lease = generation.statsMutationLease;
  const controlsId = generation.statsTrigger.getAttribute("aria-controls");
  const openingStatsPortal = lease?.expectedOpen && controlsId
    ? statsOpeningPortalIsExact(generation, controlsId, records)?.portal ?? null
    : null;
  const statsRecords = records.filter((record) => (
    record.target === generation.statsTrigger
    || generation.statsTrigger.contains(record.target)
  ));
  const statsContentPlacementRecords = records.filter((record) => (
    record.target === generation.statsContent
    && ["data-side", "data-align"].includes(record.attributeName ?? "")
  ));
  const otherRecords = records.filter((record) => (
    !statsRecords.includes(record)
    && !statsContentPlacementRecords.includes(record)
  ));
  if (otherRecords.some(
    (record) => !mutationIsRadixOwned(generation, record, openingStatsPortal),
  ))
    return false;
  if (
    statsContentPlacementRecords.length > 0
    && !statsContentPlacementMutationIsExact(
      generation,
      statsContentPlacementRecords,
    )
  )
    return false;
  if (statsRecords.length === 0) return true;
  if (generation.retiredStatsBoundary)
    return retiredStatsTriggerMutationIsExact(generation, statsRecords);
  return generation.statsMutationLease
    ? statsMutationIsExact(generation, statsRecords)
    : statsPlacementMutationIsExact(generation, statsRecords);
}

function refreshRelationSeals(generation: StatusBarGeneration) {
  generation.relationSeals.length = 0;
  const seen = new Set<Node>();
  sealRelations(
    generation.root,
    generation.ownerDocument,
    generation.relationSeals,
    seen,
  );
  for (const slot of ["menu-content", "issues-content"]) {
    const content = generation.controls.get(slot)?.control;
    if (!content) continue;
    let top: Node = content;
    while (top.parentNode && top.parentNode !== generation.ownerDocument.body) top = top.parentNode;
    sealRelations(top, generation.ownerDocument, generation.relationSeals, seen);
  }
  if (generation.statsPortalRoot) {
    sealRelations(
      generation.statsPortalRoot,
      generation.ownerDocument,
      generation.relationSeals,
      seen,
    );
  }
}

function retireGeneration(
  generation: StatusBarGeneration,
  requestSuccessor = true,
) {
  if (generation.retired) return;
  generation.retired = true;
  generation.pendingIntents.forEach((intent) => {
    intent.pending = null;
  });
  generation.pendingIntents.clear();
  clearStatsMutationLease(generation, false);
  clearStatsPlacementLease(generation);
  retireOutsidePointerChain(generation);
  generation.removeEventListeners.forEach((remove) => remove());
  generation.removeEventListeners.length = 0;
  generation.observers.forEach(({ observer }) => {
    observer.takeRecords();
    observer.disconnect();
  });
  generation.observers.length = 0;
  const { manager } = generation;
  if (
    requestSuccessor
    && manager.active === generation
    && !manager.successorRequested
  ) {
    manager.successorRequested = true;
    manager.requestSuccessor();
  }
}

function retireManagerGeneration(
  manager: StatusBarPublicationManager,
  publication: StatusBarControlPublication,
) {
  if (manager.candidates.get(publication.slot) === publication)
    manager.candidates.delete(publication.slot);
  if (
    manager.active?.controls.get(publication.slot) !== publication
    && manager.candidates.size > 0
  )
    return;
  if (manager.active) retireGeneration(manager.active, false);
  manager.active = null;
  manager.candidates.clear();
  manager.epoch += 1;
}

function observeGenerationTarget(
  generation: StatusBarGeneration,
  target: Node,
  options: MutationObserverInit,
  statsPortal = false,
) {
  const observer = new MutationObserver((records) => {
    retainStatusBarMenuMutationHistory(generation, records);
    const lease = generation.statsMutationLease;
    if (
      records.length > 0
      && statsPortal
      && lease
      && !lease.expectedOpen
      && lease.triggerRecords.length > 0
    ) {
      lease.subtreeRecords.push(...records);
    } else if (!mutationsAreOwned(generation, records)) {
      retireGeneration(generation);
    } else if (records.some((record) => record.type === "childList")) {
      refreshRelationSeals(generation);
    }
  });
  observer.observe(target, options);
  generation.observers.push({ observer, target, statsPortal });
}

function syncStatsPortalObserver(generation: StatusBarGeneration) {
  const current = generation.observers.filter(({ statsPortal }) => statsPortal);
  const targets = new Set(current.map(({ target }) => target));
  if (
    current.length === 2
    && generation.statsPortalRoot
    && generation.statsContent
    && targets.has(generation.statsPortalRoot)
    && targets.has(generation.statsContent)
  )
    return;
  current.forEach((publication) => {
    const { observer } = publication;
    observer.takeRecords();
    observer.disconnect();
    generation.observers.splice(generation.observers.indexOf(publication), 1);
  });
  if (!generation.statsPortalRoot || !generation.statsContent) return;
  observeGenerationTarget(generation, generation.statsPortalRoot, {
    attributes: true,
    attributeOldValue: true,
    childList: true,
  }, true);
  observeGenerationTarget(generation, generation.statsContent, {
    attributes: true,
    attributeOldValue: true,
  }, true);
}

function observeGeneration(generation: StatusBarGeneration) {
  const observe = (target: Node, options: MutationObserverInit) =>
    observeGenerationTarget(generation, target, options);
  const subtreeRoots = [generation.root];
  for (const slot of ["menu-content", "issues-content"]) {
    const content = generation.controls.get(slot)?.control;
    if (!content) continue;
    let top: Node = content;
    while (top.parentNode && top.parentNode !== generation.ownerDocument.body) top = top.parentNode;
    subtreeRoots.push(top as HTMLElement);
  }
  [...new Set(subtreeRoots)].forEach((root) => observe(root, {
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    characterDataOldValue: true,
    childList: true,
    subtree: true,
  }));
  const parents = new Set<Node>();
  generation.relationSeals.forEach((seal) => {
    if (seal.parent) parents.add(seal.parent);
  });
  parents.forEach((parent) => {
    if (!subtreeRoots.some((root) => root === parent || root.contains(parent)))
      observe(parent, { childList: true });
  });
}

function retireOutsidePointerChain(generation: StatusBarGeneration) {
  const chain = generation.outsidePointerChain;
  if (!chain) return;
  chain.cancelExpiry();
  chain.pointerDown.expired = true;
  if (chain.pointerUp) chain.pointerUp.expired = true;
  if (chain.click) chain.click.expired = true;
  generation.outsidePointerChain = null;
}

function replaceOutsidePointerExpiry(
  generation: StatusBarGeneration,
  chain: StatusBarOutsidePointerChain,
  delay: number,
) {
  const ownerWindow = generation.ownerDocument.defaultView;
  if (!ownerWindow) return false;
  chain.cancelExpiry();
  chain.expiresAt = statusBarNow(generation) + delay;
  const timer = ownerWindow.setTimeout(() => {
    if (generation.outsidePointerChain === chain)
      retireOutsidePointerChain(generation);
  }, delay);
  chain.cancelExpiry = () => ownerWindow.clearTimeout(timer);
  return true;
}

function outsidePointerChainIsCurrent(
  generation: StatusBarGeneration,
  chain: StatusBarOutsidePointerChain,
) {
  if (
    generation.outsidePointerChain !== chain
    || statusBarNow(generation) >= chain.expiresAt
  ) {
    retireOutsidePointerChain(generation);
    return false;
  }
  return true;
}

function pointerChainEventIsExact(
  generation: StatusBarGeneration,
  pointerDown: StatusBarNativeEventPublication,
  next: StatusBarNativeEventPublication,
) {
  const PointerEventConstructor =
    generation.ownerDocument.defaultView?.PointerEvent;
  if (!PointerEventConstructor) return false;
  return (
    pointerDown.event instanceof PointerEventConstructor
    && next.event instanceof PointerEventConstructor
    && pointerDown.phase === Event.CAPTURING_PHASE
    && next.phase === Event.CAPTURING_PHASE
    && pointerDown.type === "pointerdown"
    && (next.type === "pointerup" || next.type === "click")
    && next.target === pointerDown.target
    && arraysAreIdentical(next.path, pointerDown.path)
    && next.button === pointerDown.button
    && next.ctrlKey === pointerDown.ctrlKey
    && next.altKey === pointerDown.altKey
    && next.metaKey === pointerDown.metaKey
    && next.shiftKey === pointerDown.shiftKey
    && next.pointerId === pointerDown.pointerId
    && next.pointerType === pointerDown.pointerType
    && (
      next.type === "click"
      || next.isPrimary === pointerDown.isPrimary
    )
    && (next.type !== "click" || typeof next.detail === "number" && next.detail > 0)
  );
}

function beginStatsMutationLease(
  generation: StatusBarGeneration,
  expectedOpen: boolean,
  nativeEvents: readonly StatusBarNativeEventPublication[],
  reactEvent: StatusBarReactEventPublication | null,
) {
  const currentOpen = !expectedOpen;
  const controlsId = generation.statsTrigger.getAttribute("aria-controls");
  if (
    generation.statsPlacementLease
    ||
    !statsTriggerStateIsExact(generation, currentOpen)
    || nativeEvents.length === 0
    || nativeEvents.some((event) => (
      event.claimed
      || event.expired
      || (
        event.phase !== Event.CAPTURING_PHASE
        && event.phase !== Event.AT_TARGET
      )
      || !nativeEventIsExact(event, event.phase)
    ))
    || Boolean(reactEvent && (
      reactEvent.claimed
      || reactEvent.phase !== Event.CAPTURING_PHASE
      || !reactEventIsExact(reactEvent)
    ))
  )
    return;
  clearStatsMutationLease(generation, false);
  const ownerWindow = generation.ownerDocument.defaultView;
  if (!ownerWindow) return;
  const portalRecords: MutationRecord[] = [];
  const portalObserver = new MutationObserver((records) => {
    if (generation.statsMutationLease === lease)
      portalRecords.push(...records);
  });
  const lease: StatusBarStatsMutationLease = {
    expectedOpen,
    controlsId,
    side: generation.statsTrigger.getAttribute("data-radix-popper-side"),
    align: generation.statsTrigger.getAttribute("data-radix-popper-align"),
    nativeEvents: Object.freeze([...nativeEvents]),
    reactEvent,
    portalObserver,
    portalRecords,
    subtreeRecords: [],
    triggerRecords: [],
    expiresAt: statusBarNow(generation) + STATS_MUTATION_LEASE_MS,
    cancelExpiry: () => {},
  };
  portalObserver.observe(generation.ownerDocument.body, {
    childList: true,
    subtree: true,
  });
  nativeEvents.forEach((event) => {
    event.extended = true;
    event.expired = false;
  });
  generation.statsMutationLease = lease;
  const timer = ownerWindow.setTimeout(() => {
    if (generation.statsMutationLease === lease)
      expireStatsMutationLease(generation, lease);
  }, STATS_MUTATION_LEASE_MS);
  lease.cancelExpiry = () => ownerWindow.clearTimeout(timer);
}

function armStatsMutationFromReact(
  generation: StatusBarGeneration,
  publication: StatusBarReactEventPublication,
  event: StatusBarReactEvent,
) {
  const native = publication.native;
  if (
    native.type !== "click"
    || event.currentTarget !== generation.root
    || !native.path.includes(generation.statsTrigger)
    || !(native.target instanceof Node)
    || !generation.statsTrigger.contains(native.target)
  )
    return;
  const expanded = generation.statsTrigger.getAttribute("aria-expanded");
  if (expanded !== "true" && expanded !== "false") return;
  beginStatsMutationLease(generation, expanded === "false", [native], publication);
}

function armStatsMutationFromNative(
  generation: StatusBarGeneration,
  publication: StatusBarNativeEventPublication,
) {
  const activeLease = generation.statsMutationLease;
  if (activeLease && !statsMutationLeaseIsCurrent(generation, activeLease))
    return;
  const expanded = generation.statsTrigger.getAttribute("aria-expanded");
  if (expanded !== "true" && expanded !== "false") return;
  const open = expanded === "true";
  if (
    publication.type === "keydown"
    && publication.code === "KeyC"
    && (publication.ctrlKey || publication.metaKey)
    && publication.shiftKey === true
    && publication.altKey === false
  ) {
    beginStatsMutationLease(generation, !open, [publication], null);
    return;
  }
  const content = generation.statsContent;
  if (
    !open
    || !(content instanceof HTMLElement)
    || !statsBoundContentIsExact(generation)
  )
    return;
  if (
    publication.type === "keydown"
    && publication.key === "Escape"
    && publication.path.includes(content)
  ) {
    beginStatsMutationLease(generation, false, [publication], null);
    return;
  }
  if (
    publication.type !== "dismissableLayer.pointerDownOutside"
    && publication.type !== "dismissableLayer.focusOutside"
  )
    return;
  const outside = publication.event as CustomEvent<{ originalEvent?: Event }>;
  const original = outside.detail?.originalEvent
    ? generation.nativeEvents.get(outside.detail.originalEvent)
    : null;
  if (
    !original
    || original.target !== publication.target
    || outside.currentTarget !== generation.ownerDocument
    || !(original.target instanceof Node)
    || content.contains(original.target)
    || !nativeEventIsExact(original, original.phase)
  )
    return;
  const nativeEvents = [publication, original];
  if (publication.type === "dismissableLayer.pointerDownOutside") {
    const ownerWindow = generation.ownerDocument.defaultView;
    const PointerEventConstructor = ownerWindow?.PointerEvent;
    if (
      !PointerEventConstructor
      || !(original.event instanceof PointerEventConstructor)
      || original.type !== "pointerdown"
      || original.phase !== Event.CAPTURING_PHASE
      || original.isPrimary !== true
    )
      return;
    if (original.button !== 0) {
      return;
    }
    const chain = generation.outsidePointerChain;
    if (
      chain?.pointerDown !== original
      || !outsidePointerChainIsCurrent(generation, chain)
      || !chain.pointerUp
      || !chain.click
      || !nativeEventIsExact(chain.pointerUp, chain.pointerUp.phase)
      || !nativeEventIsExact(chain.click, chain.click.phase)
    )
      return;
    nativeEvents.push(chain.pointerUp, chain.click);
  } else if (original.type !== "focusin") {
    return;
  }
  beginStatsMutationLease(generation, false, nativeEvents, null);
}

function recordNativeEvent(generation: StatusBarGeneration, event: Event) {
  if (!validateGeneration(generation)) return;
  if (generation.nativeEvents.has(event)) return;
  const path = event.composedPath();
  const publication: StatusBarNativeEventPublication = {
    event,
    type: event.type,
    target: event.target,
    currentTarget: event.currentTarget,
    path: Object.freeze([...path]),
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    composed: event.composed,
    defaultPrevented: event.defaultPrevented,
    cancelBubble: event.cancelBubble,
    trusted: event.isTrusted,
    timeStamp: event.timeStamp,
    phase: event.eventPhase,
    view: statusBarEventView(event),
    key: "key" in event && typeof event.key === "string" ? event.key : undefined,
    code: "code" in event && typeof event.code === "string" ? event.code : undefined,
    repeat: "repeat" in event && typeof event.repeat === "boolean"
      ? event.repeat
      : undefined,
    composing: "isComposing" in event && typeof event.isComposing === "boolean"
      ? event.isComposing
      : undefined,
    button: "button" in event && typeof event.button === "number" ? event.button : undefined,
    ctrlKey: "ctrlKey" in event && typeof event.ctrlKey === "boolean" ? event.ctrlKey : undefined,
    altKey: "altKey" in event && typeof event.altKey === "boolean" ? event.altKey : undefined,
    metaKey: "metaKey" in event && typeof event.metaKey === "boolean" ? event.metaKey : undefined,
    shiftKey: "shiftKey" in event && typeof event.shiftKey === "boolean" ? event.shiftKey : undefined,
    pointerId: "pointerId" in event && typeof event.pointerId === "number" ? event.pointerId : undefined,
    pointerType: "pointerType" in event && typeof event.pointerType === "string" ? event.pointerType : undefined,
    isPrimary: "isPrimary" in event && typeof event.isPrimary === "boolean" ? event.isPrimary : undefined,
    detail: "detail" in event && typeof event.detail === "number" ? event.detail : undefined,
    extended: false,
    claimed: false,
    expired: false,
  };
  generation.nativeEvents.set(event, publication);
  let preserveForOutside = false;
  const ownerWindow = generation.ownerDocument.defaultView;
  const PointerEventConstructor = ownerWindow?.PointerEvent;
  const genuinePointer = Boolean(
    PointerEventConstructor
    && event instanceof PointerEventConstructor
    && publication.phase === Event.CAPTURING_PHASE,
  );
  if (
    publication.type === "pointerdown"
    && genuinePointer
    && publication.button === 0
    && publication.isPrimary === true
  ) {
    retireOutsidePointerChain(generation);
    const chain: StatusBarOutsidePointerChain = {
      pointerDown: publication,
      pointerUp: null,
      click: null,
      expiresAt: 0,
      cancelExpiry: () => {},
    };
    generation.outsidePointerChain = chain;
    if (replaceOutsidePointerExpiry(generation, chain, OUTSIDE_POINTER_GESTURE_LEASE_MS))
      preserveForOutside = true;
    else
      retireOutsidePointerChain(generation);
  } else if (publication.type === "pointercancel") {
    retireOutsidePointerChain(generation);
  } else if (publication.type === "pointerup") {
    const chain = generation.outsidePointerChain;
    if (
      chain
      && outsidePointerChainIsCurrent(generation, chain)
      && !chain.pointerUp
      && !chain.click
      && publication.timeStamp >= chain.pointerDown.timeStamp
      && pointerChainEventIsExact(generation, chain.pointerDown, publication)
    ) {
      chain.pointerUp = publication;
      preserveForOutside = true;
    } else if (chain) {
      retireOutsidePointerChain(generation);
    }
  } else if (publication.type === "click") {
    const chain = generation.outsidePointerChain;
    if (
      chain?.pointerUp
      && outsidePointerChainIsCurrent(generation, chain)
      && !chain.click
      && publication.timeStamp >= chain.pointerUp.timeStamp
      && pointerChainEventIsExact(generation, chain.pointerDown, publication)
    ) {
      chain.click = publication;
      preserveForOutside = replaceOutsidePointerExpiry(
        generation,
        chain,
        OUTSIDE_POINTER_CALLBACK_LEASE_MS,
      );
      if (!preserveForOutside) retireOutsidePointerChain(generation);
    } else if (chain) {
      retireOutsidePointerChain(generation);
    }
  }
  if (preserveForOutside) {
    publication.extended = true;
  } else {
    queueMicrotask(() => {
      if (!publication.extended) publication.expired = true;
    });
  }
  armStatsMutationFromNative(generation, publication);
}

function activateGeneration(
  manager: StatusBarPublicationManager,
  authority: StatusBarAuthority,
) {
  if (manager.active || !authorityIsExact(authority)) return;
  const expected = expectedStatusBarSlots(authority);
  if (
    manager.candidates.size !== expected.length
    || expected.some((slot) => manager.candidates.get(slot)?.authority !== authority)
  ) {
    return;
  }
  const controls = new Map(manager.candidates);
  const root = controls.get("root")?.control;
  if (!(root instanceof HTMLElement) || !root.isConnected) return;
  const ownerDocument = root.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const statsTriggers = root.querySelectorAll<HTMLElement>('[data-testid="stats-button"]');
  const statsTrigger = statsTriggers.item(0);
  if (
    statsTriggers.length !== 1
    || !statsTrigger
    || !(statsTrigger instanceof HTMLButtonElement)
    || statsTrigger.tagName !== "BUTTON"
    || statsTrigger.parentElement !== root
  )
    return;
  const portalContents = ["menu-content", "issues-content"]
    .map((slot) => controls.get(slot)?.control)
    .filter((control): control is HTMLElement => Boolean(control));
  for (const slot of ["menu-content", "issues-content"] as const) {
    const content = controls.get(slot)?.control;
    const publication = manager.portalBoundaries.get(slot);
    if (content) {
      if (
        !publication
        || publication.authority !== authority
        || publication.root !== root
        || publication.content !== content
        || !statusBarPortalBoundaryIsExact(publication, true)
      )
        return;
    } else if (publication) {
      if (statusBarPortalBoundaryIsExact(publication, true)) {
        const wasOpen = slot === "menu-content"
          ? publication.authority.menuOpen
          : publication.authority.issuesOpen;
        const remainsOpen = slot === "menu-content"
          ? authority.menuOpen
          : authority.issuesOpen;
        if (
          publication.root !== root
          || !wasOpen
          || remainsOpen
        )
          return;
      } else if (!statusBarPortalBoundaryIsExact(publication, false)) return;
    }
  }
  if ([...controls.values()].some((publication) => (
    publication.epoch !== manager.epoch
    || publication.root !== root
    || publication.control.ownerDocument !== ownerDocument
    || !publication.control.isConnected
    || (
      publication.control !== root
      && !root.contains(publication.control)
      && !portalContents.some((content) => content.contains(publication.control))
    )
  )))
    return;
  const generation: StatusBarGeneration = {
    manager,
    authority,
    epoch: manager.epoch,
    identity: Symbol("status-bar-publication"),
    root,
    ownerDocument,
    controls,
    portalBoundaries: new Map(manager.portalBoundaries),
    actions: new Set(),
    nativeEvents: new WeakMap(),
    reactEvents: new WeakMap(),
    pendingIntents: new Set(),
    outsidePointerChain: null,
    statsTrigger,
    statsBoundary: manager.statsBoundary,
    retiredStatsBoundary: null,
    statsContent: null,
    statsPortalRoot: null,
    statsSide: null,
    statsAlign: null,
    statsMutationLease: null,
    statsPlacementLease: null,
    nodeSeals: [],
    relationSeals: [],
    observers: [],
    removeEventListeners: [],
    keyboardAuthority: ownerWindow
      ? captureStatusBarKeyboardAuthority(ownerWindow)
      : null,
    menuMutationObserved: false,
    retired: false,
  };
  for (const slot of ["menu-content", "issues-content"] as const) {
    if (!controls.has(slot)) manager.portalBoundaries.delete(slot);
  }
  const expanded = statsTrigger.getAttribute("aria-expanded");
  let retiredStatsBoundary: StatusBarStatsBoundaryPublication | null = null;
  if (expanded === "true") {
    const side = statsTrigger.getAttribute("data-radix-popper-side");
    const align = statsTrigger.getAttribute("data-radix-popper-align");
    const publication = generation.statsBoundary;
    if (
      !publication
      || !statsBoundaryPublicationIsExact(generation, publication)
    )
      return;
    generation.statsContent = publication.content;
    generation.statsPortalRoot = publication.portal;
    generation.statsSide = side;
    generation.statsAlign = align;
    const contentSide = publication.content.getAttribute("data-side");
    const contentAlign = publication.content.getAttribute("data-align");
    if (
      !contentSide
      || !contentAlign
      || (
        (contentSide !== side || contentAlign !== align)
        && !beginStatsPlacementLease(generation, contentSide, contentAlign)
      )
    )
      return;
  } else if (manager.statsBoundary !== null) {
    if (!statsBoundaryCanRetireForSession(generation, manager.statsBoundary))
      return;
    retiredStatsBoundary = manager.statsBoundary;
    generation.retiredStatsBoundary = retiredStatsBoundary;
    manager.statsBoundary = null;
    generation.statsBoundary = null;
  }
  if (
    retiredStatsBoundary
      ? !statsTriggerAfterSessionRetirementIsExact(
        generation,
        retiredStatsBoundary,
      )
      : generation.statsPlacementLease
        ? !statsPendingPlacementIsExact(generation, generation.statsPlacementLease)
        : !statsTriggerStateIsExact(generation, expanded === "true")
  )
    return;
  const relationNodes = new Set<Node>();
  sealSubtree(root, generation.nodeSeals, new Set());
  sealRelations(root, ownerDocument, generation.relationSeals, relationNodes);
  portalContents.forEach((content) => {
    let top: Node = content;
    while (top.parentNode && top.parentNode !== ownerDocument.body) top = top.parentNode;
    sealSubtree(top, generation.nodeSeals, new Set(generation.nodeSeals.map((seal) => seal.node)));
    sealRelations(top, ownerDocument, generation.relationSeals, relationNodes);
  });
  if (generation.statsPortalRoot) {
    sealNode(generation.statsPortalRoot, generation.nodeSeals);
    sealRelations(
      generation.statsPortalRoot,
      ownerDocument,
      generation.relationSeals,
      relationNodes,
    );
  }
  manager.active = generation;
  manager.successorRequested = false;
  STATUS_BAR_NATIVE_EVENTS.forEach((type) => {
    const listener = (event: Event) => recordNativeEvent(generation, event);
    ownerDocument.addEventListener(type, listener, true);
    generation.removeEventListeners.push(() => ownerDocument.removeEventListener(type, listener, true));
  });
  if (ownerWindow) {
    const listener = (event: KeyboardEvent) => recordNativeEvent(generation, event);
    ownerWindow.addEventListener("keydown", listener, true);
    generation.removeEventListeners.push(() => ownerWindow.removeEventListener("keydown", listener, true));
  }
  observeGeneration(generation);
  syncStatsPortalObserver(generation);
}

function registerControl<T extends HTMLElement>(
  manager: StatusBarPublicationManager,
  authority: StatusBarAuthority,
  slot: string,
  root: HTMLElement,
  control: T,
) {
  const active = manager.active;
  if (
    active
    || authority.mount !== manager.mount
    || !expectedStatusBarSlots(authority).includes(slot)
    || manager.candidates.has(slot)
    || !root.isConnected
    || !control.isConnected
  )
    return null;
  const publication: StatusBarControlPublication<T> = {
    authority,
    epoch: manager.epoch,
    slot,
    root,
    control,
    enabled: controlIsEnabled(control),
    claimed: false,
  };
  manager.candidates.set(slot, publication);
  activateGeneration(manager, authority);
  return publication;
}

function nativeEventIsExact(
  publication: StatusBarNativeEventPublication,
  expectedPhase: number = Event.CAPTURING_PHASE,
  allowDefaultPrevention = false,
) {
  const event = publication.event;
  const path = event.composedPath();
  return (
    !publication.expired
    && !publication.claimed
    && event.type === publication.type
    && event.target === publication.target
    && (
      arraysAreIdentical(path, publication.path)
      || (
        publication.extended
        && event.eventPhase === Event.NONE
        && path.length === 0
      )
    )
    && event.bubbles === publication.bubbles
    && event.cancelable === publication.cancelable
    && event.composed === publication.composed
    && (
      event.defaultPrevented === publication.defaultPrevented
      || allowDefaultPrevention
        && !publication.defaultPrevented
        && event.defaultPrevented
    )
    && event.timeStamp === publication.timeStamp
    && publication.phase === expectedPhase
    && (!("key" in event) || event.key === publication.key)
    && (!("code" in event) || event.code === publication.code)
    && (!("button" in event) || event.button === publication.button)
    && (!("ctrlKey" in event) || event.ctrlKey === publication.ctrlKey)
    && (!("altKey" in event) || event.altKey === publication.altKey)
    && (!("metaKey" in event) || event.metaKey === publication.metaKey)
    && (!("shiftKey" in event) || event.shiftKey === publication.shiftKey)
    && (!("pointerId" in event) || event.pointerId === publication.pointerId)
    && (!("pointerType" in event) || event.pointerType === publication.pointerType)
    && (!("isPrimary" in event) || event.isPrimary === publication.isPrimary)
    && (
      !("detail" in event)
      || typeof event.detail !== "number"
      || event.detail === publication.detail
    )
  );
}

function reactEventIsExact(publication: StatusBarReactEventPublication) {
  const event = publication.event;
  return (
    !publication.claimed
    && event.nativeEvent === publication.native.event
    && event.type === publication.type
    && event.target === publication.target
    && event.bubbles === publication.bubbles
    && event.cancelable === publication.cancelable
    && event.defaultPrevented === publication.defaultPrevented
    && event.timeStamp === publication.timeStamp
    && event.preventDefault === publication.preventDefault
    && event.stopPropagation === publication.stopPropagation
    && event.isDefaultPrevented === publication.isDefaultPrevented
    && event.isPropagationStopped === publication.isPropagationStopped
  );
}

function rememberReactEvent(
  manager: StatusBarPublicationManager,
  event: StatusBarReactEvent,
) {
  const generation = manager.active;
  let native = generation?.nativeEvents.get(event.nativeEvent);
  if (
    generation
    && !native
    && event.eventPhase === Event.CAPTURING_PHASE
    && event.nativeEvent.eventPhase === Event.CAPTURING_PHASE
  ) {
    recordNativeEvent(generation, event.nativeEvent);
    native = generation.nativeEvents.get(event.nativeEvent);
  }
  if (
    !generation
    || !native
    || !nativeEventIsExact(native)
    || event.target !== native.target
    || event.type !== native.type
  )
    return;
  let publication = generation.reactEvents.get(event);
  if (!publication) {
    publication = {
      event,
      native,
      type: event.type,
      target: event.target,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      timeStamp: event.timeStamp,
      phase: event.eventPhase,
      preventDefault: event.preventDefault,
      stopPropagation: event.stopPropagation,
      isDefaultPrevented: event.isDefaultPrevented,
      isPropagationStopped: event.isPropagationStopped,
      claimed: false,
    };
    generation.reactEvents.set(event, publication);
  }
  armStatsMutationFromReact(generation, publication, event);
  for (const intent of generation.pendingIntents) {
    if (
      intent.nativeEvents[0] === native
      && native.target instanceof Node
      && intent.publication.control.contains(native.target as Node)
      && intent.reactEvents.length === 0
    ) {
      intent.reactEvents.push(publication);
      intent.requiresReact = false;
      generation.pendingIntents.delete(intent);
      const pending = intent.pending;
      intent.pending = null;
      pending?.();
      break;
    }
  }
}

function useStatusBarControl<T extends HTMLElement>(
  authority: StatusBarAuthority,
  rootRef: RefObject<HTMLElement | null>,
  manager: StatusBarPublicationManager,
  slot: string,
) {
  const controlRef = useRef<T | null>(null);
  const publicationRef = useRef<StatusBarControlPublication<T> | null>(null);
  const layoutAttemptedRef = useRef(false);
  const [refVersion, setRefVersion] = useState(0);
  const setControl = useCallback((control: T | null) => {
    if (!control) return;
    const root = rootRef.current;
    if (
      isStatusBarPortalSlot(slot)
      && (
        !root
        || !publishStatusBarPortalBoundary(
          manager,
          authority,
          slot,
          root,
          control,
        )
      )
    )
      return;
    const publication = publicationRef.current;
    if (
      publication
      && manager.active?.controls.get(publication.slot) === publication
      && publication.control !== control
    )
      return;
    if (controlRef.current === control) return;
    controlRef.current = control;
    if (layoutAttemptedRef.current) setRefVersion((version) => version + 1);
  }, [authority, manager, rootRef, slot]);

  useLayoutEffect(() => {
    layoutAttemptedRef.current = true;
    const root = rootRef.current;
    const control = controlRef.current;
    if (!root || !control) {
      return () => {
        layoutAttemptedRef.current = false;
      };
    }
    const publication = registerControl(manager, authority, slot, root, control);
    if (!publication) {
      return () => {
        layoutAttemptedRef.current = false;
      };
    }
    publicationRef.current = publication;
    return () => {
      layoutAttemptedRef.current = false;
      if (publicationRef.current === publication) publicationRef.current = null;
      retireManagerGeneration(manager, publication);
    };
  }, [authority, manager, refVersion, rootRef, slot]);

  const createReactIntent = useCallback((event: StatusBarReactEvent) => {
    const publication = publicationRef.current;
    const generation = manager.active;
    const reactEvent = generation?.reactEvents.get(event);
    const native = reactEvent?.native;
    if (
      !publication
      || !generation
      || generation.authority !== authority
      || generation.controls.get(slot) !== publication
      || publication.control !== event.currentTarget
      || !publication.enabled
      || !controlIsEnabled(publication.control)
      || !reactEvent
      || !native
      || !reactEventIsExact(reactEvent)
      || !nativeEventIsExact(native)
      || !native.path.includes(publication.control)
      || reactEvent.phase !== Event.CAPTURING_PHASE
      || !validateGeneration(generation)
    )
      return null;
    return {
      generation,
      publication,
      nativeEvents: [native],
      reactEvents: [reactEvent],
      claimedPublication: false,
      claims: new Set<string>(),
      pending: null,
      requiresReact: false,
    } satisfies StatusBarEventIntent;
  }, [authority, manager, slot]);

  const createSelectIntent = useCallback((
    activation: StatusBarEventIntent | null,
    event: Event,
  ) => {
    const publication = publicationRef.current;
    const generation = manager.active;
    const native = generation?.nativeEvents.get(event);
    if (
      !activation
      || !publication
      || !generation
      || activation.generation !== generation
      || activation.publication !== publication
      || generation.controls.get(slot) !== publication
      || event.currentTarget !== publication.control
      || !publication.enabled
      || !controlIsEnabled(publication.control)
      || native?.type !== "menu.itemSelect"
      || native.target !== publication.control
      || event.eventPhase !== Event.AT_TARGET
      || !nativeEventIsExact(native)
      || !validateGeneration(generation)
    )
      return null;
    activation.nativeEvents.push(native);
    return activation;
  }, [manager, slot]);

  return [setControl, createReactIntent, createSelectIntent, publicationRef] as const;
}

function claimIntent(intent: StatusBarEventIntent, action: string) {
  const { generation, publication } = intent;
  const pointerChain = generation.outsidePointerChain;
  if (
    pointerChain
    && intent.nativeEvents.includes(pointerChain.pointerDown)
    && !outsidePointerChainIsCurrent(generation, pointerChain)
  )
    return false;
  if (
    intent.requiresReact
    || generation.retired
    || generation.statsMutationLease
    || generation.statsPlacementLease
    || generation.controls.get(publication.slot) !== publication
    || !validateGeneration(generation)
    || intent.nativeEvents.some((event) => (
      intent.claimedPublication ? event.expired || event.event.type !== event.type : !nativeEventIsExact(event)
    ))
    || intent.reactEvents.some((event) => (
      intent.claimedPublication ? event.event.nativeEvent !== event.native.event : !reactEventIsExact(event)
    ))
    || intent.claims.has(action)
    || generation.actions.has(action)
    || (publication.claimed && !intent.claimedPublication)
  )
    return false;
  if (!intent.claimedPublication) {
    publication.claimed = true;
    intent.claimedPublication = true;
    intent.nativeEvents.forEach((event) => {
      event.claimed = true;
    });
    intent.reactEvents.forEach((event) => {
      event.claimed = true;
    });
  }
  intent.claims.add(action);
  generation.actions.add(action);
  const outsidePointerChain = generation.outsidePointerChain;
  if (
    outsidePointerChain
    && intent.nativeEvents.includes(outsidePointerChain.pointerDown)
  ) {
    outsidePointerChain.cancelExpiry();
    generation.outsidePointerChain = null;
  }
  return true;
}

function statusBarMenuFocusDirection(
  event: ReactKeyboardEvent<HTMLElement>,
): StatusBarMenuFocusDirection | null {
  if (event.key === "ArrowDown") return "first";
  if (event.key === "ArrowUp") return "last";
  return null;
}

function isStatusBarMenuTriggerPublication(
  publication: StatusBarControlPublication,
  ownerWindow: Window & typeof globalThis,
): publication is StatusBarControlPublication<HTMLButtonElement> {
  return (
    publication.slot === "menu-trigger"
    && publication.control instanceof ownerWindow.HTMLButtonElement
  );
}

function statusBarDirectionalNativeIsExact(
  generation: StatusBarGeneration,
  publication: StatusBarControlPublication<HTMLButtonElement>,
  native: StatusBarNativeEventPublication,
  keyboardAuthority: StatusBarKeyboardAuthority,
  direction: StatusBarMenuFocusDirection,
) {
  const event = native.event;
  const trigger = publication.control;
  const ownerWindow = keyboardAuthority.ownerWindow;
  const key = direction === "first" ? "ArrowDown" : "ArrowUp";
  return (
    keyboardAuthority.isCurrent()
    && keyboardAuthority.getPrototypeOf(event)
      === keyboardAuthority.keyboardPrototype
    && keyboardAuthority.isTrusted.matches(event)
    && keyboardAuthority.isTrusted.read(event)
    && !keyboardAuthority.getOwnPropertyDescriptor(event, "preventDefault")
    && !keyboardAuthority.getOwnPropertyDescriptor(event, "stopPropagation")
    && !keyboardAuthority.getOwnPropertyDescriptor(
      event,
      "stopImmediatePropagation",
    )
    && native.trusted
    && native.type === "keydown"
    && native.target === trigger
    && native.currentTarget === native.path.at(-1)
    && native.phase === ownerWindow.Event.CAPTURING_PHASE
    && native.bubbles
    && native.cancelable
    && !native.defaultPrevented
    && !native.cancelBubble
    && statusBarEventWindowMatches(
      native.view,
      generation.ownerDocument,
      ownerWindow,
    )
    && native.key === key
    && native.ctrlKey === false
    && native.metaKey === false
    && native.altKey === false
    && native.shiftKey === false
    && native.repeat === false
    && native.composing === false
    && statusBarEventPathIsExact(
      trigger,
      native.path,
      generation.ownerDocument,
      ownerWindow,
    )
    && keyboardAuthority.eventType.read(event) === native.type
    && keyboardAuthority.eventTarget.read(event) === native.target
    && keyboardAuthority.eventBubbles.read(event) === native.bubbles
    && keyboardAuthority.eventCancelable.read(event) === native.cancelable
    && keyboardAuthority.eventComposed.read(event) === native.composed
    && keyboardAuthority.eventDefaultPrevented.read(event)
      === native.defaultPrevented
    && keyboardAuthority.eventCancelBubble.read(event) === native.cancelBubble
    && keyboardAuthority.eventTimeStamp.read(event) === native.timeStamp
    && arraysAreIdentical(
      keyboardAuthority.eventPath.call(event),
      native.path,
    )
    && keyboardAuthority.eventView.read(event) === native.view
    && keyboardAuthority.keyboardKey.read(event) === native.key
    && keyboardAuthority.keyboardCode.read(event) === native.code
    && keyboardAuthority.keyboardCtrl.read(event) === native.ctrlKey
    && keyboardAuthority.keyboardMeta.read(event) === native.metaKey
    && keyboardAuthority.keyboardAlt.read(event) === native.altKey
    && keyboardAuthority.keyboardShift.read(event) === native.shiftKey
    && keyboardAuthority.keyboardRepeat.read(event) === native.repeat
    && keyboardAuthority.keyboardComposing.read(event) === native.composing
    && keyboardAuthority.activeElement.read(generation.ownerDocument)
      === trigger
  );
}

function statusBarDirectionalReactIsExact(
  event: ReactKeyboardEvent<HTMLElement>,
  react: StatusBarReactEventPublication,
  native: StatusBarNativeEventPublication,
  publication: StatusBarControlPublication<HTMLButtonElement>,
  keyboardAuthority: StatusBarKeyboardAuthority,
  direction: StatusBarMenuFocusDirection,
) {
  const key = direction === "first" ? "ArrowDown" : "ArrowUp";
  return (
    react.event === event
    && react.native === native
    && event.nativeEvent === native.event
    && event.currentTarget === publication.control
    && event.target === publication.control
    && event.type === "keydown"
    && event.eventPhase === keyboardAuthority.ownerWindow.Event.CAPTURING_PHASE
    && event.bubbles === native.bubbles
    && event.cancelable === native.cancelable
    && !event.defaultPrevented
    && event.isTrusted
    && statusBarEventWindowMatches(
      event.view,
      publication.control.ownerDocument,
      keyboardAuthority.ownerWindow,
    )
    && event.key === key
    && event.code === native.code
    && event.ctrlKey === false
    && event.metaKey === false
    && event.altKey === false
    && event.shiftKey === false
    && event.repeat === false
    && (!("isComposing" in event) || event.isComposing === false)
    && event.preventDefault === react.preventDefault
    && event.stopPropagation === react.stopPropagation
    && event.isDefaultPrevented === react.isDefaultPrevented
    && event.isPropagationStopped === react.isPropagationStopped
    && !keyboardAuthority.apply(event.isDefaultPrevented, event, [])
    && !keyboardAuthority.apply(event.isPropagationStopped, event, [])
    && reactEventIsExact(react)
  );
}

function createStatusBarMenuFocusIntent(
  manager: StatusBarPublicationManager,
  authority: StatusBarAuthority,
  disclosure: StatusBarDisclosureIntent | null,
  event: ReactKeyboardEvent<HTMLElement>,
): StatusBarMenuFocusIntent | null {
  const direction = statusBarMenuFocusDirection(event);
  const intent = disclosure?.event;
  const generation = intent?.generation;
  const publication = intent?.publication;
  const keyboardAuthority = generation?.keyboardAuthority;
  const native = intent?.nativeEvents[0];
  const react = intent?.reactEvents[0];
  if (
    !direction
    || authority.menuOpen
    || disclosure?.authority !== authority
    || !intent
    || !generation
    || generation !== manager.active
    || generation.authority !== authority
    || generation.retired
    || generation.menuMutationObserved
    || !keyboardAuthority
    || !publication
    || !isStatusBarMenuTriggerPublication(publication, keyboardAuthority.ownerWindow)
    || generation.controls.get("menu-trigger") !== publication
    || intent.nativeEvents.length !== 1
    || intent.reactEvents.length !== 1
    || !native
    || !react
    || manager.directionalNativeEvents.has(native.event)
    || manager.directionalReactEvents.has(react.event)
    || !statusBarDirectionalNativeIsExact(
      generation,
      publication,
      native,
      keyboardAuthority,
      direction,
    )
    || !statusBarDirectionalReactIsExact(
      event,
      react,
      native,
      publication,
      keyboardAuthority,
      direction,
    )
    || !validateGeneration(generation)
    || generation.menuMutationObserved
  )
    return null;
  return {
    authority,
    generation,
    publication,
    interaction: intent,
    keyboardAuthority,
    direction,
    native,
    react,
    trigger: publication.control,
    root: generation.root,
    ownerDocument: generation.ownerDocument,
    ownerWindow: keyboardAuthority.ownerWindow,
    claimed: false,
  };
}

function suppressRejectedStatusBarDirectionalKey(
  manager: StatusBarPublicationManager,
  event: ReactKeyboardEvent<HTMLElement>,
) {
  if (!statusBarMenuFocusDirection(event)) return;
  const generation = manager.active;
  const keyboardAuthority = generation?.keyboardAuthority;
  const react = generation?.reactEvents.get(event);
  if (
    !generation
    || !keyboardAuthority
    || !keyboardAuthority.isCurrent()
    || event.currentTarget
      !== generation.controls.get("menu-trigger")?.control
    || typeof event.stopPropagation !== "function"
    || typeof event.isPropagationStopped !== "function"
    || keyboardAuthority.apply(event.isPropagationStopped, event, [])
  )
    return;
  if (
    react
    && (
      react.event !== event
      || event.stopPropagation !== react.stopPropagation
      || event.isPropagationStopped !== react.isPropagationStopped
    )
  )
    return;
  keyboardAuthority.apply(
    react?.stopPropagation ?? event.stopPropagation,
    event,
    [],
  );
}

function statusBarMenuFocusPublications(
  generation: StatusBarGeneration,
) {
  const content = generation.controls.get("menu-content")?.control;
  const ownerWindow = generation.ownerDocument.defaultView;
  if (!ownerWindow || !(content instanceof ownerWindow.HTMLElement))
    return null;
  const slots = expectedStatusBarSlots(generation.authority).filter(
    isStatusBarMenuItemSlot,
  );
  const publications: StatusBarControlPublication[] = [];
  for (const slot of slots) {
    const publication = generation.controls.get(slot);
    if (
      !publication
      || publication.slot !== slot
      || publication.authority !== generation.authority
      || publication.root !== generation.root
      || !publication.control.isConnected
      || !content.contains(publication.control)
      || !publication.control.getAttribute("role")?.startsWith("menuitem")
    )
      return null;
    if (publication.enabled && controlIsEnabled(publication.control))
      publications.push(publication);
  }
  return publications;
}

function exactStatusBarMenuAutoFocusEvent(
  event: Event,
  content: HTMLElement,
  keyboardAuthority: StatusBarKeyboardAuthority,
) {
  const ownerWindow = keyboardAuthority.ownerWindow;
  return (
    keyboardAuthority.isCurrent()
    && keyboardAuthority.getPrototypeOf(event) === ownerWindow.CustomEvent.prototype
    && event instanceof ownerWindow.CustomEvent
    && keyboardAuthority.eventType.read(event)
      === "focusScope.autoFocusOnMount"
    && keyboardAuthority.eventTarget.read(event) === content
    && keyboardAuthority.eventCurrentTarget.read(event) === content
    && keyboardAuthority.eventPhase.read(event) === ownerWindow.Event.AT_TARGET
    && !keyboardAuthority.eventBubbles.read(event)
    && keyboardAuthority.eventCancelable.read(event)
    && !keyboardAuthority.eventComposed.read(event)
    && !keyboardAuthority.eventDefaultPrevented.read(event)
    && !keyboardAuthority.eventCancelBubble.read(event)
    && event.detail === null
    && statusBarEventPathIsExact(
      content,
      keyboardAuthority.eventPath.call(event),
      content.ownerDocument,
      ownerWindow,
    )
  );
}

function completeStatusBarMenuFocus(
  manager: StatusBarPublicationManager,
  authority: StatusBarAuthority,
  focusIntentRef: MutableRefObject<StatusBarMenuFocusIntent | null>,
  contentPublicationRef: MutableRefObject<StatusBarControlPublication<HTMLDivElement> | null>,
  event: Event,
) {
  const intent = focusIntentRef.current;
  const generation = manager.active;
  const contentPublication = contentPublicationRef.current;
  const portalBoundary = generation?.portalBoundaries.get("menu-content");
  if (
    !intent
    || intent.claimed
    || !generation
    || generation.retired
    || generation.authority !== authority
    || !statusBarMenuAuthoritiesAreSuccessive(intent.authority, authority)
    || intent.generation === generation
    || !intent.generation.retired
    || intent.generation.manager !== manager
    || intent.generation.authority !== intent.authority
    || intent.generation.root !== intent.root
    || intent.generation.controls.get("menu-trigger") !== intent.publication
    || !intent.publication.claimed
    || !intent.native.claimed
    || !intent.react.claimed
    || intent.trigger !== intent.publication.control
    || intent.trigger.ownerDocument !== intent.ownerDocument
    || intent.ownerDocument.defaultView !== intent.ownerWindow
    || generation.root !== intent.root
    || generation.ownerDocument !== intent.ownerDocument
    || generation.keyboardAuthority === null
    || generation.keyboardAuthority.ownerWindow !== intent.ownerWindow
    || !intent.keyboardAuthority.isCurrent()
    || generation.menuMutationObserved
    || generation.actions.has("menu-direction-focus")
    || manager.directionalFocusEvents.has(event)
    || !contentPublication
    || generation.controls.get("menu-content") !== contentPublication
    || contentPublication.authority !== authority
    || event.currentTarget !== contentPublication.control
    || !portalBoundary
    || !statusBarPortalBoundaryIsExact(portalBoundary, true)
    || contentPublication.control.getAttribute("data-align") !== "end"
    || !contentPublication.control.getAttribute("data-side")
    || intent.trigger.getAttribute("aria-expanded") !== "true"
    || intent.trigger.getAttribute("aria-controls")
      !== contentPublication.control.id
    || keyboardAuthorityActiveElement(intent) !== intent.trigger
    || !exactStatusBarMenuAutoFocusEvent(
      event,
      contentPublication.control,
      intent.keyboardAuthority,
    )
    || !validateGeneration(generation)
    || generation.menuMutationObserved
  ) {
    if (focusIntentRef.current === intent) focusIntentRef.current = null;
    return;
  }
  const publications = statusBarMenuFocusPublications(generation);
  const destination = intent.direction === "first"
    ? publications?.[0]
    : publications?.at(-1);
  if (!destination) {
    focusIntentRef.current = null;
    return;
  }
  intent.claimed = true;
  generation.actions.add("menu-direction-focus");
  manager.directionalFocusEvents.add(event);
  focusIntentRef.current = null;
  intent.keyboardAuthority.eventPreventDefault.call(event);
  intent.keyboardAuthority.focus.call(
    destination.control,
    { preventScroll: true },
  );
}

function keyboardAuthorityActiveElement(intent: StatusBarMenuFocusIntent) {
  return intent.keyboardAuthority.activeElement.read(intent.ownerDocument);
}

function useStatusBarIntent<T>(authority: StatusBarAuthority) {
  const intentRef = useRef<StatusBarValueIntent<T> | null>(null);
  useLayoutEffect(() => {
    if (intentRef.current?.authority !== authority) intentRef.current = null;
    return () => {
      if (intentRef.current?.authority === authority) intentRef.current = null;
    };
  }, [authority]);
  return intentRef;
}

function StatusBarRadioItem({
  authority,
  rootRef,
  manager,
  intentRef,
  disclosureIntentRef,
  slot,
  value,
  eligible,
  children,
  testId,
}: {
  authority: StatusBarAuthority;
  rootRef: RefObject<HTMLElement | null>;
  manager: StatusBarPublicationManager;
  intentRef: MutableRefObject<StatusBarValueIntent<string> | null>;
  disclosureIntentRef: MutableRefObject<StatusBarDisclosureIntent | null>;
  slot: string;
  value: string;
  eligible: boolean;
  children: ReactNode;
  testId?: string;
}) {
  const [itemRef, createReactIntent, createSelectIntent] = useStatusBarControl<HTMLDivElement>(
    authority,
    rootRef,
    manager,
    slot,
  );
  const activationRef = useRef<StatusBarEventIntent | null>(null);
  const authorize = useCallback((event: Event) => {
    if (!eligible) return;
    const intent = createSelectIntent(activationRef.current, event);
    if (!intent) return;
    activationRef.current = null;
    intentRef.current = { authority, value, event: intent };
    disclosureIntentRef.current = { authority, event: intent };
  }, [authority, createSelectIntent, disclosureIntentRef, eligible, intentRef, value]);

  return (
    <MenuRadioItem
      ref={itemRef}
      value={value}
      onClickCapture={(event) => {
        activationRef.current = createReactIntent(event);
      }}
      onSelect={authorize}
      data-testid={testId}
    >
      {children}
    </MenuRadioItem>
  );
}

function StatusBarCheckboxControl({
  authority,
  rootRef,
  manager,
  slot,
  action,
  disclosureIntentRef,
  checked,
  children,
  testId,
  onChange,
}: {
  authority: StatusBarAuthority;
  rootRef: RefObject<HTMLElement | null>;
  manager: StatusBarPublicationManager;
  slot: string;
  action: string;
  disclosureIntentRef: MutableRefObject<StatusBarDisclosureIntent | null>;
  checked: boolean;
  children: ReactNode;
  testId?: string;
  onChange: (value: boolean) => void;
}) {
  const [itemRef, createReactIntent, createSelectIntent] = useStatusBarControl<HTMLDivElement>(
    authority,
    rootRef,
    manager,
    slot,
  );
  const activationRef = useRef<StatusBarEventIntent | null>(null);
  const intentRef = useStatusBarIntent<boolean>(authority);
  const next = !checked;
  const authorize = useCallback((event: Event) => {
    const intent = createSelectIntent(activationRef.current, event);
    if (!intent) return;
    activationRef.current = null;
    intentRef.current = { authority, value: next, event: intent };
    disclosureIntentRef.current = { authority, event: intent };
  }, [authority, createSelectIntent, disclosureIntentRef, intentRef, next]);
  const change = useCallback((value: boolean | "indeterminate") => {
    const intent = intentRef.current;
    if (
      typeof value !== "boolean"
      || value !== next
      || intent?.authority !== authority
      || intent.value !== value
      || !claimIntent(intent.event, action)
    )
      return;
    intentRef.current = null;
    onChange(value);
  }, [action, authority, intentRef, next, onChange]);

  return (
    <MenuCheckboxItem
      ref={itemRef}
      checked={checked}
      onClickCapture={(event) => {
        activationRef.current = createReactIntent(event);
      }}
      onSelect={authorize}
      onCheckedChange={change}
      data-testid={testId}
    >
      {children}
    </MenuCheckboxItem>
  );
}

function StatusBarMenuControls({
  authority,
  rootRef,
  manager,
  disclosureIntentRef,
}: {
  authority: StatusBarAuthority;
  rootRef: RefObject<HTMLElement | null>;
  manager: StatusBarPublicationManager;
  disclosureIntentRef: MutableRefObject<StatusBarDisclosureIntent | null>;
}) {
  const layoutIntentRef = useStatusBarIntent<string>(authority);
  const themeIntentRef = useStatusBarIntent<string>(authority);
  const shortcutsActivationRef = useRef<StatusBarEventIntent | null>(null);
  const [shortcutsRef, createShortcutsIntent, createShortcutsSelectIntent] =
    useStatusBarControl<HTMLDivElement>(
      authority,
      rootRef,
      manager,
      "compact-shortcuts",
    );

  const selectLayout = useCallback((value: string) => {
    const next = authority.layoutValues.find((candidate) => candidate === value);
    const intent = layoutIntentRef.current;
    if (
      !next
      || next === authority.layout
      || intent?.authority !== authority
      || intent.value !== next
      || !claimIntent(intent.event, "layout")
    )
      return;
    layoutIntentRef.current = null;
    authority.onLayout(next);
  }, [authority, layoutIntentRef]);

  const selectTheme = useCallback((value: string) => {
    const intent = themeIntentRef.current;
    if (
      !isThemePreference(value)
      || !authority.themeValues.includes(value)
      || value === authority.themePreference
      || intent?.authority !== authority
      || intent.value !== value
      || !claimIntent(intent.event, "theme")
    )
      return;
    themeIntentRef.current = null;
    authority.setThemePreference(value);
  }, [authority, themeIntentRef]);

  return (
    <>
      <MenuLabel>View</MenuLabel>
      <MenuRadioGroup value={authority.layout} onValueChange={selectLayout}>
        {!authority.compact && (
          <StatusBarRadioItem
            authority={authority}
            rootRef={rootRef}
            manager={manager}
            intentRef={layoutIntentRef}
            disclosureIntentRef={disclosureIntentRef}
            slot="layout:split"
            value="split"
            eligible={authority.layout !== "split"}
          >
            <span className="inline-flex items-center gap-2">
              <Columns2 size={14} /> Code and preview
            </span>
          </StatusBarRadioItem>
        )}
        <StatusBarRadioItem
          authority={authority}
          rootRef={rootRef}
          manager={manager}
          intentRef={layoutIntentRef}
          disclosureIntentRef={disclosureIntentRef}
          slot="layout:code"
          value="code"
          eligible={authority.layout !== "code"}
        >
          <span className="inline-flex items-center gap-2">
            <Code2 size={14} /> Code only
          </span>
        </StatusBarRadioItem>
        <StatusBarRadioItem
          authority={authority}
          rootRef={rootRef}
          manager={manager}
          intentRef={layoutIntentRef}
          disclosureIntentRef={disclosureIntentRef}
          slot="layout:rich"
          value="rich"
          eligible={authority.layout !== "rich"}
        >
          <span className="inline-flex items-center gap-2">
            <Eye size={14} /> Preview only
          </span>
        </StatusBarRadioItem>
      </MenuRadioGroup>
      <MenuSeparator />
      <StatusBarCheckboxControl
        authority={authority}
        rootRef={rootRef}
        manager={manager}
        slot="line-wrapping"
        action="line-wrapping"
        disclosureIntentRef={disclosureIntentRef}
        checked={authority.lineWrapping}
        onChange={authority.onLineWrapping}
      >
        <span className="inline-flex items-center gap-2">
          <WrapText size={14} /> Wrap long lines
        </span>
      </StatusBarCheckboxControl>
      <StatusBarCheckboxControl
        authority={authority}
        rootRef={rootRef}
        manager={manager}
        slot="sync-scroll"
        action="sync-scroll"
        disclosureIntentRef={disclosureIntentRef}
        checked={authority.syncScroll}
        onChange={authority.onSyncScroll}
        testId="sync-scroll-toggle"
      >
        <span className="inline-flex items-center gap-2">
          <ArrowUpDown size={14} /> Sync scrolling
        </span>
      </StatusBarCheckboxControl>
      {authority.compact && (
        <>
          <MenuSeparator />
          <MenuLabel>Theme</MenuLabel>
          <MenuRadioGroup value={authority.themePreference} onValueChange={selectTheme}>
            {authority.themeValues.map((theme) => (
              <StatusBarRadioItem
                key={theme}
                authority={authority}
                rootRef={rootRef}
                manager={manager}
                intentRef={themeIntentRef}
                disclosureIntentRef={disclosureIntentRef}
                slot={`theme:${theme}`}
                value={theme}
                eligible={authority.themePreference !== theme}
                testId={`menu-theme-${theme}`}
              >
                {themeLabel(theme)}
              </StatusBarRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem
            ref={shortcutsRef}
            icon={<CircleHelp size={15} />}
            onClickCapture={(event) => {
              shortcutsActivationRef.current = createShortcutsIntent(event);
            }}
            onSelect={(event) => {
              const intent = createShortcutsSelectIntent(shortcutsActivationRef.current, event);
              if (!intent) return;
              shortcutsActivationRef.current = null;
              disclosureIntentRef.current = { authority, event: intent };
              if (claimIntent(intent, "shortcuts")) authority.onShortcuts();
            }}
          >
            Help and shortcuts
          </MenuItem>
        </>
      )}
      {!authority.compact && (
        <>
          <MenuSeparator />
          <MenuLabel>Flavor</MenuLabel>
          <div className="px-2.5 pb-2 text-xs text-ink-3">GitHub Flavored Markdown (tables, task lists, footnotes, strikethrough).</div>
        </>
      )}
    </>
  );
}

function StatusBarIssueRow({
  authority,
  row,
  rootRef,
  manager,
}: {
  authority: StatusBarAuthority;
  row: StatusBarIssuePublication;
  rootRef: RefObject<HTMLElement | null>;
  manager: StatusBarPublicationManager;
}) {
  const [buttonRef, createReactIntent] = useStatusBarControl<HTMLButtonElement>(
    authority,
    rootRef,
    manager,
    `issue:${row.index}`,
  );
  const intentRef = useRef<StatusBarEventIntent | null>(null);
  return (
    <button
      ref={buttonRef}
      type="button"
      className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-3"
      onClickCapture={(event) => {
        intentRef.current = createReactIntent(event);
      }}
      onClick={(event) => {
        const intent = intentRef.current;
        if (
          !intent
          || !completeReactIntent(intent, event)
          || !issuePublicationIsExact(authority, row)
          || !claimIntent(intent, `issue:${row.index}`)
        )
          return;
        intentRef.current = null;
        authority.onIssueSelect(row.issue);
      }}
    >
      <span className={cn("mt-0.5 h-2 w-2 shrink-0 rounded-full", row.severity === "error" ? "bg-danger" : "bg-warning")} />
      <span className="flex-1 text-ink-2">{row.message}</span>
      <span className="shrink-0 font-mono text-xs text-ink-4">L{row.line}</span>
    </button>
  );
}

function completeReactIntent(
  intent: StatusBarEventIntent,
  event: ReactMouseEvent<HTMLElement>,
) {
  const { generation, publication } = intent;
  if (
    generation.retired
    || event.currentTarget !== publication.control
    || event.nativeEvent !== intent.nativeEvents[0]?.event
    || event.target !== intent.nativeEvents[0]?.target
    || !publication.enabled
    || !controlIsEnabled(publication.control)
    || (
      event.eventPhase !== Event.AT_TARGET
      && event.eventPhase !== Event.BUBBLING_PHASE
    )
    || !validateGeneration(generation)
  )
    return false;
  const existing = generation.reactEvents.get(event);
  if (existing) {
    if (!intent.reactEvents.includes(existing)) intent.reactEvents.push(existing);
    return reactEventIsExact(existing);
  }
  const reactEvent: StatusBarReactEventPublication = {
    event,
    native: intent.nativeEvents[0],
    type: event.type,
    target: event.target,
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    defaultPrevented: event.defaultPrevented,
    timeStamp: event.timeStamp,
    phase: event.eventPhase,
    preventDefault: event.preventDefault,
    stopPropagation: event.stopPropagation,
    isDefaultPrevented: event.isDefaultPrevented,
    isPropagationStopped: event.isPropagationStopped,
    claimed: false,
  };
  generation.reactEvents.set(event, reactEvent);
  intent.reactEvents.push(reactEvent);
  return reactEventIsExact(reactEvent);
}

function createContentNativeIntent(
  manager: StatusBarPublicationManager,
  authority: StatusBarAuthority,
  publicationRef: MutableRefObject<StatusBarControlPublication<HTMLDivElement> | null>,
  event: Event,
  mode: "escape" | "outside",
) {
  const generation = manager.active;
  const publication = publicationRef.current;
  const native = generation?.nativeEvents.get(event);
  if (
    !generation
    || !publication
    || generation.authority !== authority
    || generation.controls.get(publication.slot) !== publication
    || !native
    || !nativeEventIsExact(native)
    || !validateGeneration(generation)
  )
    return null;
  const nativeEvents = [native];
  if (mode === "escape") {
    if (
      native.type !== "keydown"
      || native.key !== "Escape"
      || !native.path.includes(publication.control)
      || event.eventPhase !== Event.CAPTURING_PHASE
      || event.currentTarget !== generation.ownerDocument
    )
      return null;
  } else {
    const outside = event as CustomEvent<{ originalEvent?: Event }>;
    const originalEvent = outside.detail?.originalEvent;
    const original = originalEvent ? generation.nativeEvents.get(originalEvent) : null;
    const pointerChain = generation.outsidePointerChain;
    if (
      !["dismissableLayer.pointerDownOutside", "dismissableLayer.focusOutside"].includes(native.type)
      || !original
      || !nativeEventIsExact(original)
      || event.target !== original.target
      || event.currentTarget !== original.target
      || event.eventPhase !== Event.AT_TARGET
      || !(original.target instanceof Node)
      || publication.control.contains(original.target)
    )
      return null;
    nativeEvents.push(original);
    if (native.type === "dismissableLayer.pointerDownOutside") {
      const ownerWindow = generation.ownerDocument.defaultView;
      const PointerEventConstructor = ownerWindow?.PointerEvent;
      if (
        !PointerEventConstructor
        || !(original.event instanceof PointerEventConstructor)
        || original.type !== "pointerdown"
        || original.phase !== Event.CAPTURING_PHASE
        || original.isPrimary !== true
        || typeof original.button !== "number"
        || original.button < 0
      )
        return null;
      if (original.button !== 0) {
        return {
          generation,
          publication,
          nativeEvents,
          reactEvents: [],
          claimedPublication: false,
          claims: new Set<string>(),
          pending: null,
          requiresReact: false,
        };
      }
      if (
        pointerChain?.pointerDown !== original
        || !outsidePointerChainIsCurrent(generation, pointerChain)
        || !pointerChain.pointerUp
        || !pointerChain.click
        || !nativeEventIsExact(pointerChain.pointerUp)
        || !nativeEventIsExact(pointerChain.click)
      )
        return null;
      nativeEvents.push(pointerChain.pointerUp, pointerChain.click);
    }
  }
  const intent: StatusBarEventIntent = {
    generation,
    publication,
    nativeEvents,
    reactEvents: [],
    claimedPublication: false,
    claims: new Set(),
    pending: null,
    requiresReact: false,
  };
  return intent;
}

function StatusBarMenuContent({
  authority,
  rootRef,
  manager,
  intentRef,
  focusIntentRef,
  children,
}: {
  authority: StatusBarAuthority;
  rootRef: RefObject<HTMLElement | null>;
  manager: StatusBarPublicationManager;
  intentRef: MutableRefObject<StatusBarDisclosureIntent | null>;
  focusIntentRef: MutableRefObject<StatusBarMenuFocusIntent | null>;
  children: ReactNode;
}) {
  const [setContent, createReactIntent, , publicationRef] = useStatusBarControl<HTMLDivElement>(
    authority,
    rootRef,
    manager,
    "menu-content",
  );
  const authorize = useCallback((event: StatusBarReactEvent) => {
    rememberReactEvent(manager, event);
    if ("key" in event && event.key === "Escape") return;
    const intent = createReactIntent(event);
    if (intent) intentRef.current = { authority, event: intent };
  }, [authority, createReactIntent, intentRef, manager]);
  const authorizeOutside = useCallback((event: CustomEvent<{ originalEvent: Event }>) => {
    const intent = createContentNativeIntent(manager, authority, publicationRef, event, "outside");
    if (intent) intentRef.current = { authority, event: intent };
  }, [authority, intentRef, manager, publicationRef]);
  const authorizeEscape = useCallback((event: KeyboardEvent) => {
    const intent = createContentNativeIntent(manager, authority, publicationRef, event, "escape");
    if (intent && claimIntent(intent, "menu-disclosure"))
      intentRef.current = { authority, event: intent };
  }, [authority, intentRef, manager, publicationRef]);
  const openAutoFocus = useCallback((event: Event) => {
    completeStatusBarMenuFocus(
      manager,
      authority,
      focusIntentRef,
      publicationRef,
      event,
    );
  }, [authority, focusIntentRef, manager, publicationRef]);
  const openAutoFocusProps = { onOpenAutoFocus: openAutoFocus };

  return (
    <MenuContent
      ref={setContent}
      align="end"
      className="w-60"
      data-testid="status-menu-content"
      onPointerDownCapture={authorize}
      onKeyDownCapture={authorize}
      onClickCapture={(event) => rememberReactEvent(manager, event)}
      onPointerDownOutside={authorizeOutside}
      onFocusOutside={authorizeOutside}
      onEscapeKeyDown={authorizeEscape}
      {...openAutoFocusProps}
    >
      {children}
    </MenuContent>
  );
}

function StatusBarIssuesContent({
  authority,
  rootRef,
  manager,
  intentRef,
  children,
}: {
  authority: StatusBarAuthority;
  rootRef: RefObject<HTMLElement | null>;
  manager: StatusBarPublicationManager;
  intentRef: MutableRefObject<StatusBarDisclosureIntent | null>;
  children: ReactNode;
}) {
  const [setContent, createReactIntent, , publicationRef] = useStatusBarControl<HTMLDivElement>(
    authority,
    rootRef,
    manager,
    "issues-content",
  );
  const authorize = useCallback((event: StatusBarReactEvent) => {
    rememberReactEvent(manager, event);
    if ("key" in event && event.key === "Escape") return;
    const intent = createReactIntent(event);
    if (intent) intentRef.current = { authority, event: intent };
  }, [authority, createReactIntent, intentRef, manager]);
  const authorizeOutside = useCallback((event: CustomEvent<{ originalEvent: Event }>) => {
    const intent = createContentNativeIntent(manager, authority, publicationRef, event, "outside");
    if (intent) intentRef.current = { authority, event: intent };
  }, [authority, intentRef, manager, publicationRef]);
  const authorizeEscape = useCallback((event: KeyboardEvent) => {
    const intent = createContentNativeIntent(manager, authority, publicationRef, event, "escape");
    if (intent && claimIntent(intent, "issues-disclosure"))
      intentRef.current = { authority, event: intent };
  }, [authority, intentRef, manager, publicationRef]);

  return (
    <PopoverContent
      ref={setContent}
      align="end"
      className="w-80 p-0"
      data-testid="status-issues-content"
      onKeyDownCapture={authorize}
      onPointerDownCapture={authorize}
      onClickCapture={(event) => rememberReactEvent(manager, event)}
      onPointerDownOutside={authorizeOutside}
      onFocusOutside={authorizeOutside}
      onEscapeKeyDown={authorizeEscape}
    >
      {children}
    </PopoverContent>
  );
}

export const StatusBar = memo(function StatusBar({ session, doc, layout, onLayout, lineWrapping, onLineWrapping, syncScroll, onSyncScroll, onIssueSelect, onShortcuts, onStorage, compact = false }: StatusBarProps) {
  // Linting walks the document and statistics count it: wait for a pause in typing. The tree is the
  // binding's incrementally maintained parse, so no second parse of the document happens here.
  const { text: source, tree } = useDebouncedSessionValue(session, (s) => s.binding.getTree(), 500, (a, b) => a.text === b.text);
  // The server renders an empty session; by the time this part of the page hydrates the client
  // may already hold the local copy. Show placeholders until hydrated so the markup matches.
  const hydrated = useHydrated();
  const issues = useMemo(() => (hydrated ? lintMarkdown(source, tree) : []), [hydrated, source, tree]);
  const selection = useLocalSelection(session);
  const statsGoal = useSessionValue(session, getGoal, jsonEqual);
  const errors = issues.filter((i) => i.severity === "error").length;

  const [themePreference, setThemePreference] = useTheme();
  const [publicationRevision, setPublicationRevision] = useState(0);
  const [manager] = useState(() =>
    createPublicationManager(() =>
      setPublicationRevision((revision) => revision + 1),
    ),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const documentValue = doc;
  const documentStorage = doc.storage;
  const documentRepoBranch = doc.repoBranch;
  const documentRepoOwner = doc.repoOwner;
  const documentRepoName = doc.repoName;
  const documentRepoPath = doc.repoPath;
  const documentGistId = doc.gistId;
  const documentHasUnpublishedChanges = doc.hasUnpublishedChanges;
  const documentPublication = useMemo<StatusBarDocumentPublication>(() => Object.freeze({
    value: documentValue,
    storage: documentStorage,
    repoBranch: documentRepoBranch,
    repoOwner: documentRepoOwner,
    repoName: documentRepoName,
    repoPath: documentRepoPath,
    gistId: documentGistId,
    hasUnpublishedChanges: documentHasUnpublishedChanges,
  }), [
    documentGistId,
    documentHasUnpublishedChanges,
    documentRepoBranch,
    documentRepoName,
    documentRepoOwner,
    documentRepoPath,
    documentStorage,
    documentValue,
  ]);
  const authority = useMemo<StatusBarAuthority>(() => {
    const issueRows = Object.freeze(issues.map((issue, index) => Object.freeze({
      snapshot: issues,
      issue,
      index,
      line: issue.line,
      column: issue.column,
      offset: issue.offset,
      message: issue.message,
      rule: issue.rule,
      severity: issue.severity,
    })));
    return Object.freeze({
      mount: manager.mount,
      publicationRevision,
      session,
      source,
      tree,
      document: documentPublication,
      layout,
      layoutValues: compact ? COMPACT_LAYOUTS : DESKTOP_LAYOUTS,
      onLayout,
      lineWrapping,
      onLineWrapping,
      syncScroll,
      onSyncScroll,
      compact,
      hydrated,
      statsSelection: selection,
      statsSelectionFrom: selection?.from ?? null,
      statsSelectionTo: selection?.to ?? null,
      statsGoal,
      statsGoalKind: statsGoal?.kind ?? null,
      statsGoalMode: statsGoal?.mode ?? null,
      statsGoalValue: statsGoal?.value ?? null,
      statsGoalSetBy: statsGoal?.setBy ?? null,
      statsGoalSetAt: statsGoal?.setAt ?? null,
      issueSnapshot: issues,
      issueRows,
      onIssueSelect,
      onShortcuts,
      onStorage,
      themePreference,
      themeValues: STATUS_BAR_THEMES,
      setThemePreference,
      menuOpen,
      issuesOpen,
    });
  }, [
    compact,
    documentPublication,
    hydrated,
    issues,
    issuesOpen,
    layout,
    lineWrapping,
    manager,
    menuOpen,
    onIssueSelect,
    onLayout,
    onLineWrapping,
    onShortcuts,
    onStorage,
    onSyncScroll,
    publicationRevision,
    session,
    setThemePreference,
    selection,
    source,
    statsGoal,
    syncScroll,
    themePreference,
    tree,
  ]);
  const rootRef = useRef<HTMLElement>(null);
  const menuIntentRef = useRef<StatusBarDisclosureIntent | null>(null);
  const menuFocusIntentRef = useRef<StatusBarMenuFocusIntent | null>(null);
  const issuesIntentRef = useRef<StatusBarDisclosureIntent | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const publication = registerControl(manager, authority, "root", root, root);
    if (!publication) return;
    if (menuIntentRef.current?.authority !== authority) menuIntentRef.current = null;
    const menuFocusIntent = menuFocusIntentRef.current;
    if (
      menuFocusIntent
      && menuFocusIntent.authority !== authority
      && !statusBarMenuAuthoritiesAreSuccessive(
        menuFocusIntent.authority,
        authority,
      )
    )
      menuFocusIntentRef.current = null;
    if (issuesIntentRef.current?.authority !== authority) issuesIntentRef.current = null;
    return () => {
      if (menuIntentRef.current?.authority === authority) menuIntentRef.current = null;
      if (issuesIntentRef.current?.authority === authority) issuesIntentRef.current = null;
      retireManagerGeneration(manager, publication);
    };
  }, [authority, manager]);

  const [menuTriggerRef, createMenuIntent] = useStatusBarControl<HTMLButtonElement>(
    authority,
    rootRef,
    manager,
    "menu-trigger",
  );
  const [issuesTriggerRef, createIssuesIntent] = useStatusBarControl<HTMLButtonElement>(
    authority,
    rootRef,
    manager,
    "issues-trigger",
  );
  const [storageRef, createStorageIntent] = useStatusBarControl<HTMLButtonElement>(
    authority,
    rootRef,
    manager,
    "storage",
  );
  const [desktopShortcutsRef, createDesktopShortcutsIntent] =
    useStatusBarControl<HTMLButtonElement>(
      authority,
      rootRef,
      manager,
      "desktop-shortcuts",
    );
  const storageIntentRef = useRef<StatusBarEventIntent | null>(null);
  const desktopShortcutsIntentRef = useRef<StatusBarEventIntent | null>(null);

  const authorizeMenuChange = useCallback((event: StatusBarReactEvent) => {
    menuFocusIntentRef.current = null;
    rememberReactEvent(manager, event);
    const intent = createMenuIntent(event);
    menuIntentRef.current = intent ? { authority, event: intent } : null;
  }, [authority, createMenuIntent, manager]);

  const authorizeIssuesChange = useCallback((event: StatusBarReactEvent) => {
    rememberReactEvent(manager, event);
    const intent = createIssuesIntent(event);
    if (intent) issuesIntentRef.current = { authority, event: intent };
  }, [authority, createIssuesIntent, manager]);

  const changeMenuOpen = useCallback((open: boolean) => {
    const intent = menuIntentRef.current;
    if (
      open === authority.menuOpen
      || intent?.authority !== authority
      || intent.event.generation !== manager.active
    )
      return;
    if (intent.event.requiresReact) {
      intent.event.pending = () => {
        if (
          menuIntentRef.current === intent
          && claimIntent(intent.event, "menu-disclosure")
        ) {
          menuIntentRef.current = null;
          setMenuOpen(open);
        }
      };
      return;
    }
    if (
      !intent.event.claims.has("menu-disclosure")
      && !claimIntent(intent.event, "menu-disclosure")
    )
      return;
    menuIntentRef.current = null;
    setMenuOpen(open);
  }, [authority, manager]);

  const authorizeDirectionalMenuOpen = useCallback((
    event: ReactKeyboardEvent<HTMLElement>,
  ) => {
    authorizeMenuChange(event);
    if (!statusBarMenuFocusDirection(event)) return;
    const disclosure = menuIntentRef.current;
    const focusIntent = createStatusBarMenuFocusIntent(
      manager,
      authority,
      disclosure,
      event,
    );
    if (
      !focusIntent
      || !claimIntent(
        focusIntent.interaction,
        `menu-direction:${focusIntent?.direction ?? "rejected"}`,
      )
    ) {
      menuIntentRef.current = null;
      suppressRejectedStatusBarDirectionalKey(manager, event);
      return;
    }
    const intent = focusIntent.interaction;
    if (
      !claimIntent(intent, "menu-disclosure")
      || focusIntent.generation.menuMutationObserved
      || !focusIntent.keyboardAuthority.isCurrent()
    ) {
      menuIntentRef.current = null;
      suppressRejectedStatusBarDirectionalKey(manager, event);
      return;
    }
    manager.directionalNativeEvents.add(focusIntent.native.event);
    manager.directionalReactEvents.add(focusIntent.react.event);
    focusIntent.keyboardAuthority.apply(
      focusIntent.react.preventDefault,
      event,
      [],
    );
    if (!event.defaultPrevented || !event.isDefaultPrevented()) {
      menuIntentRef.current = null;
      return;
    }
    menuIntentRef.current = { authority, event: intent };
    menuFocusIntentRef.current = focusIntent;
    changeMenuOpen(true);
  }, [authority, authorizeMenuChange, changeMenuOpen, manager]);

  const changeIssuesOpen = useCallback((open: boolean) => {
    const intent = issuesIntentRef.current;
    if (
      open === authority.issuesOpen
      || intent?.authority !== authority
      || intent.event.generation !== manager.active
    )
      return;
    if (intent.event.requiresReact) {
      intent.event.pending = () => {
        if (
          issuesIntentRef.current === intent
          && claimIntent(intent.event, "issues-disclosure")
        ) {
          issuesIntentRef.current = null;
          setIssuesOpen(open);
        }
      };
      return;
    }
    if (
      !intent.event.claims.has("issues-disclosure")
      && !claimIntent(intent.event, "issues-disclosure")
    )
      return;
    issuesIntentRef.current = null;
    setIssuesOpen(open);
  }, [authority, manager]);

  const document = authority.document;
  const storageLabel =
    document.storage === "repo" ? (document.repoBranch ?? "main") : document.storage === "gist" ? "gist" : "local";
  const StorageIcon = document.storage === "repo" ? GitBranch : document.storage === "gist" ? GitHubIcon : HardDrive;

  return (
    <footer
      ref={rootRef}
      className={STATUS_BOX}
      data-testid="status-bar"
      data-compact={compact || undefined}
      onPointerDownCapture={(event) => rememberReactEvent(manager, event)}
      onKeyDownCapture={(event) => rememberReactEvent(manager, event)}
      onClickCapture={(event) => rememberReactEvent(manager, event)}
    >
      <StatusBarStatsPopover
        session={session}
        source={source}
        selection={selection}
        hydrated={hydrated}
      />
      <div className="flex-1" />

      {/* One trigger for both layouts: `compact` is false on the server and during hydration, so the phone
          form (32 px ⋯ icon, last in the row) comes from `max-md:`/`md:` classes and nothing moves when
          `compact` flips (#1531). The menu's contents still branch on `compact` — a portal, not first paint. */}
      <Menu open={menuOpen} onOpenChange={changeMenuOpen}>
        <MenuTrigger asChild>
          <button
            ref={menuTriggerRef}
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-surface-3 hover:text-ink max-md:order-last max-md:text-ink-2 max-md:transition-colors md:h-7 md:w-auto md:gap-1 md:px-2"
            aria-label={compact ? "View options" : undefined}
            onPointerDownCapture={authorizeMenuChange}
            onKeyDownCapture={authorizeDirectionalMenuOpen}
            data-testid="layout-menu"
          >
            {/* The phone name from the first byte: `compact` (and so `aria-label`) is false until hydration, and the
                visible "Markdown" text is `max-md:hidden` — without this the server markup has an unnamed button for ≈ 1 s.
                After hydration `aria-label` wins; from `md` the span is hidden and the visible text is the name (#1562). */}
            <span className="sr-only md:hidden">View options</span>
            <span className="inline-flex md:hidden">
              <MoreHorizontal size={18} />
            </span>
            <span className="inline-flex items-center gap-1 max-md:hidden">
              Markdown
              <ChevronDown size={14} />
            </span>
          </button>
        </MenuTrigger>
        <StatusBarMenuContent
          authority={authority}
          rootRef={rootRef}
          manager={manager}
          intentRef={menuIntentRef}
          focusIntentRef={menuFocusIntentRef}
        >
          <StatusBarMenuControls
            authority={authority}
            rootRef={rootRef}
            manager={manager}
            disclosureIntentRef={menuIntentRef}
          />
        </StatusBarMenuContent>
      </Menu>

      {/* Desktop-only controls: hidden by CSS below `md` from the first paint, unmounted once `compact` is known
          (mobile.spec.ts asserts they are absent, not merely hidden). */}
      {compact ? null : (
      <Popover open={issuesOpen} onOpenChange={changeIssuesOpen}>
        <PopoverTrigger asChild>
          <button
            ref={issuesTriggerRef}
            type="button"
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3 max-md:hidden", issues.length ? (errors ? "text-danger" : "text-warning") : "text-ink-3 hover:text-ink")}
            onClickCapture={authorizeIssuesChange}
            data-testid="issues-button"
          >
            {issues.length ? <AlertTriangle size={14} /> : <Check size={14} />}
            {issues.length === 0 ? "No issues" : `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`}
          </button>
        </PopoverTrigger>
        <StatusBarIssuesContent
          authority={authority}
          rootRef={rootRef}
          manager={manager}
          intentRef={issuesIntentRef}
        >
          <div className="border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Markdown issues</div>
          {issues.length === 0 ? (
            <div className="px-3 py-4 text-sm text-ink-3">Everything looks good.</div>
          ) : (
            <ul className="scrollbar-thin max-h-72 overflow-y-auto py-1">
              {authority.issueRows.map((row) => (
                <li key={row.index}>
                  <StatusBarIssueRow
                    authority={authority}
                    row={row}
                    rootRef={rootRef}
                    manager={manager}
                  />
                </li>
              ))}
            </ul>
          )}
        </StatusBarIssuesContent>
      </Popover>
      )}

      {/* Rendered once for both layouts (32 px tall on phones, 28 px from `md`), so it is already in place at first paint. */}
      <button
        ref={storageRef}
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3 hover:text-ink md:h-7"
        onClickCapture={authority.onStorage ? (event) => {
          storageIntentRef.current = createStorageIntent(event);
        } : undefined}
        onClick={authority.onStorage ? (event) => {
          const intent = storageIntentRef.current;
          if (
            !intent
            || !completeReactIntent(intent, event)
            || !claimIntent(intent, "storage")
          )
            return;
          storageIntentRef.current = null;
          authority.onStorage?.();
        } : undefined}
        disabled={!authority.onStorage}
        title={document.storage === "repo" ? `${document.repoOwner}/${document.repoName}: ${document.repoPath}` : document.storage === "gist" ? `Gist ${document.gistId}` : "Stored in Markdoc"}
        data-testid="storage-indicator"
      >
        <StorageIcon size={14} />
        {storageLabel}
        {document.hasUnpublishedChanges && document.storage !== "local" && <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Unpublished changes" />}
      </button>

      {compact ? null : (
        <>
          <ThemeToggle className="h-7 w-7 max-md:hidden" />
          <button
            ref={desktopShortcutsRef}
            type="button"
            className="icon-btn h-7 w-7 max-md:hidden"
            onClickCapture={(event) => {
              desktopShortcutsIntentRef.current = createDesktopShortcutsIntent(event);
            }}
            onClick={(event) => {
              const intent = desktopShortcutsIntentRef.current;
              if (
                !intent
                || !completeReactIntent(intent, event)
                || !claimIntent(intent, "shortcuts")
              )
                return;
              desktopShortcutsIntentRef.current = null;
              authority.onShortcuts();
            }}
            aria-label="Help and shortcuts"
          >
            <CircleHelp size={16} />
          </button>
        </>
      )}
    </footer>
  );
});
