"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { EditorView } from "prosemirror-view";
import {
  ArrowUpToLine,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  TableRowsSplit,
  TableColumnsSplit,
  TextAlignStart,
  TextAlignCenter,
  TextAlignEnd,
  Trash2,
} from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { TableAlign } from "@/editor/prosemirror/commands";
import { isTableMenuHidden, TABLE_MENU_EVENT } from "@/editor/prosemirror/setup";
import type { EditorActions, FormatState, TableCommand } from "./actions";
import { Tip } from "@/components/ui/primitives";
import { cn, shortcut } from "@/lib/utils";
import { clampToViewport } from "@/lib/viewport";
import { useSessionValue } from "./use-session";

const MENU_WIDTH = 372;
const MENU_HEIGHT = 40;
const TABLE_MENU_CLASS =
  "touch-target scrollbar-thin absolute z-30 flex items-center gap-0.5 overflow-x-auto rounded-lg bg-inverse px-1 py-1 shadow-xl animate-fade-in dark:ring-1 dark:ring-white/10";
const TABLE_MENU_BUTTON_CLASS =
  "flex h-8 w-8 items-center justify-center rounded-md text-white/85 hover:bg-white/15 hover:text-white";
const TABLE_MENU_ACTIVE_BUTTON_CLASS = "bg-white/20 text-white";
const TABLE_MENU_LABEL = "Table";

const TABLE_MENU_CONTROL_DEFINITIONS = Object.freeze([
  Object.freeze({ label: "Row above", testId: "table-row-before", align: null }),
  Object.freeze({ label: "Row below", testId: "table-row-after", align: null }),
  Object.freeze({ label: "Column left", testId: "table-col-before", align: null }),
  Object.freeze({ label: "Column right", testId: "table-col-after", align: null }),
  Object.freeze({ label: "Delete row", testId: "table-delete-row", align: null }),
  Object.freeze({ label: "Delete column", testId: "table-delete-col", align: null }),
  Object.freeze({ label: "Align left", testId: "table-align-left", align: "left" }),
  Object.freeze({ label: "Align center", testId: "table-align-center", align: "center" }),
  Object.freeze({ label: "Align right", testId: "table-align-right", align: "right" }),
  Object.freeze({ label: "Delete table", testId: "table-delete", align: null }),
] as const);

interface ScheduledFrame {
  id: number;
}

interface TableMenuAuthority {
  active: boolean;
  view: EditorView;
  editor: HTMLElement | null;
  container: HTMLElement;
  session: CollabSession;
  format: FormatState;
  canEdit: boolean;
  activeSurface: CollabSession["activeSurface"];
  schedule: () => void;
  dispose: () => void;
}

interface TableMenuGeometry {
  authority: TableMenuAuthority;
  left: number;
  top: number;
  width: number;
}

type Alignment = Exclude<TableAlign, null>;

interface TableMenuControlPublication {
  identity: symbol;
  revision: number;
  retired: boolean;
  mount: symbol;
  geometry: TableMenuGeometry;
  authority: TableMenuAuthority;
  editor: HTMLElement;
  view: EditorView;
  container: HTMLElement;
  session: CollabSession;
  actions: EditorActions;
  tableAction: EditorActions["table"];
  alignAction: EditorActions["setColumnAlign"];
  format: FormatState;
  tablePos: number;
  tableAlign: TableAlign;
  canEdit: boolean;
  activeSurface: CollabSession["activeSurface"];
  controls: Set<TableMenuControl>;
  controlOrder: TableMenuControl[];
  mouseDownObserved: boolean;
  keyboardObserved: boolean;
  keyboardClaimed: boolean;
  successorRequested: boolean;
  requestSuccessor: () => void;
  root: HTMLDivElement | null;
  bindRoot: (element: HTMLDivElement | null) => void;
  domSnapshot: TableMenuDomSnapshot | null;
  domMonitor: TableMenuDomMonitor | null;
  keyboardRuntime: TableMenuKeyboardRuntime | null;
}

interface TableMenuControl {
  identity: symbol;
  publication: TableMenuControlPublication;
  element: HTMLButtonElement | null;
  buttonRef: (element: HTMLButtonElement | null) => void;
  claimed: boolean;
  invoke: () => void;
}

interface TableMenuControls {
  rowBefore: TableMenuControl;
  rowAfter: TableMenuControl;
  colBefore: TableMenuControl;
  colAfter: TableMenuControl;
  deleteRow: TableMenuControl;
  deleteColumn: TableMenuControl;
  alignLeft: TableMenuControl;
  alignCenter: TableMenuControl;
  alignRight: TableMenuControl;
  deleteTable: TableMenuControl;
}

interface TableMenuElementOwner {
  publication: TableMenuControlPublication;
  publicationIdentity: symbol;
  control: TableMenuControl;
  controlIdentity: symbol;
}

interface TableMenuDomNodeSnapshot {
  node: Node;
  children: readonly Node[];
  attributes: readonly (readonly [string, string])[] | null;
  value: string | null;
}

interface TableMenuDomSnapshot {
  root: HTMLDivElement;
  parent: Node | null;
  previousSibling: Node | null;
  nextSibling: Node | null;
  buttons: readonly HTMLButtonElement[];
  nodes: readonly TableMenuDomNodeSnapshot[];
}

interface TableMenuReplayRefState {
  expected: HTMLElement;
  detached: boolean;
  attached: boolean;
}

interface TableMenuReplayCandidate {
  publication: TableMenuControlPublication;
  snapshot: TableMenuDomSnapshot;
  refs: Map<TableMenuControl | symbol, TableMenuReplayRefState>;
}

interface TableMenuReplay {
  source: TableMenuControlPublication;
  snapshot: TableMenuDomSnapshot;
}

interface TableMenuDomMonitor {
  mutated: boolean;
  check: () => boolean;
  disconnect: () => void;
}

interface TableMenuControlSet {
  publication: TableMenuControlPublication;
  controls: TableMenuControls;
}

interface TableMenuKeyboardAction {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly controlIdentity: symbol;
  readonly index: number;
}

interface TableMenuKeyboardEntry {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly control: TableMenuControl;
  readonly index: number;
  readonly element: HTMLButtonElement;
  readonly path: readonly EventTarget[];
  readonly action: TableMenuKeyboardAction;
}

interface TableMenuKeyboardPublication {
  readonly identity: symbol;
  readonly controlPublication: TableMenuControlPublication;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly root: HTMLDivElement;
  readonly editor: HTMLElement;
  readonly view: EditorView;
  readonly container: HTMLElement;
  readonly session: CollabSession;
  readonly actions: EditorActions;
  readonly format: FormatState;
  readonly tablePos: number;
  readonly tableAlign: TableAlign;
  readonly canEdit: boolean;
  readonly activeSurface: CollabSession["activeSurface"];
  readonly entries: readonly TableMenuKeyboardEntry[];
  readonly snapshot: TableMenuDomSnapshot;
}

interface TableMenuNativeKeyProof {
  readonly identity: symbol;
  readonly publication: TableMenuKeyboardPublication;
  readonly entry: TableMenuKeyboardEntry;
  readonly action: TableMenuKeyboardAction;
  readonly event: KeyboardEvent;
  readonly target: HTMLButtonElement;
  readonly path: readonly EventTarget[];
  readonly key: string;
  readonly destination: TableMenuKeyboardEntry;
  readonly trusted: true;
  readonly ctrlKey: false;
  readonly metaKey: false;
  readonly altKey: false;
  readonly shiftKey: false;
  readonly repeat: false;
  readonly composing: false;
  readonly propagationStopped: () => boolean;
  crossed: boolean;
}

interface TableMenuReactEventMethods {
  readonly preventDefault: (...args: never[]) => unknown;
  readonly isDefaultPrevented: (...args: never[]) => unknown;
  readonly isPropagationStopped: (...args: never[]) => unknown;
}

interface TableMenuReactKeyProof {
  readonly event: object;
  readonly nativeEvent: KeyboardEvent;
  readonly target: HTMLButtonElement;
  readonly key: string;
  readonly eventPhase: number;
  readonly methods: TableMenuReactEventMethods;
  readonly composing: false | null;
}

interface TableMenuTerminalKeyProof {
  readonly native: TableMenuNativeKeyProof;
  readonly reactCapture: TableMenuReactKeyProof;
  readonly reactBubble: TableMenuReactKeyProof;
}

interface TableMenuNativeReactPair {
  readonly native: TableMenuNativeKeyProof;
  reactRootCapture: TableMenuReactKeyProof | null;
  reactControlCapture: TableMenuReactKeyProof | null;
  reactControlBubble: TableMenuReactKeyProof | null;
  reactRootBubble: TableMenuReactKeyProof | null;
  boundaryObserved: boolean;
  terminal: TableMenuTerminalKeyProof | null;
  consumed: boolean;
  rejected: boolean;
}

interface TableMenuKeyboardRuntime {
  readonly publication: TableMenuKeyboardPublication;
  readonly publish: () => boolean;
  readonly release: () => void;
  readonly captureRoot: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly captureControl: (
    control: TableMenuControl,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly bubbleControl: (
    control: TableMenuControl,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly bubbleRoot: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

type TableMenuIntrinsicGetter<T> = {
  readonly read: (target: object) => T;
  readonly isCurrent: () => boolean;
};

type TableMenuIntrinsicMethod<Args extends readonly unknown[], Result> = {
  readonly call: (target: object, ...args: Args) => Result;
  readonly isCurrent: () => boolean;
};

interface TableMenuKeyboardAuthority {
  readonly ownerWindow: Window & typeof globalThis;
  readonly eventPrototype: object;
  readonly keyboardPrototype: object;
  readonly documentPrototype: object;
  readonly htmlElementPrototype: object;
  readonly eventType: TableMenuIntrinsicGetter<string>;
  readonly eventTarget: TableMenuIntrinsicGetter<EventTarget | null>;
  readonly eventCurrentTarget: TableMenuIntrinsicGetter<EventTarget | null>;
  readonly eventPhase: TableMenuIntrinsicGetter<number>;
  readonly eventBubbles: TableMenuIntrinsicGetter<boolean>;
  readonly eventCancelable: TableMenuIntrinsicGetter<boolean>;
  readonly eventDefaultPrevented: TableMenuIntrinsicGetter<boolean>;
  readonly eventCancelBubble: TableMenuIntrinsicGetter<boolean>;
  readonly eventPath: TableMenuIntrinsicMethod<readonly [], EventTarget[]>;
  readonly eventPreventDefault: TableMenuIntrinsicMethod<readonly [], void>;
  readonly eventStopPropagation: TableMenuIntrinsicMethod<readonly [], void>;
  readonly eventStopImmediatePropagation: TableMenuIntrinsicMethod<readonly [], void>;
  readonly eventView: TableMenuIntrinsicGetter<Window | null>;
  readonly keyboardKey: TableMenuIntrinsicGetter<string>;
  readonly keyboardCtrl: TableMenuIntrinsicGetter<boolean>;
  readonly keyboardMeta: TableMenuIntrinsicGetter<boolean>;
  readonly keyboardAlt: TableMenuIntrinsicGetter<boolean>;
  readonly keyboardShift: TableMenuIntrinsicGetter<boolean>;
  readonly keyboardRepeat: TableMenuIntrinsicGetter<boolean>;
  readonly keyboardComposing: TableMenuIntrinsicGetter<boolean>;
  readonly activeElement: TableMenuIntrinsicGetter<Element | null>;
  readonly focus: TableMenuIntrinsicMethod<readonly [FocusOptions?], void>;
  readonly addEventListener: TableMenuIntrinsicMethod<
    readonly [string, EventListener, (boolean | AddEventListenerOptions)?],
    void
  >;
  readonly removeEventListener: TableMenuIntrinsicMethod<
    readonly [string, EventListener, (boolean | EventListenerOptions)?],
    void
  >;
  readonly addWindowEventListener: TableMenuIntrinsicMethod<
    readonly [string, EventListener, (boolean | AddEventListenerOptions)?],
    void
  >;
  readonly removeWindowEventListener: TableMenuIntrinsicMethod<
    readonly [string, EventListener, (boolean | EventListenerOptions)?],
    void
  >;
  readonly isTrusted: {
    readonly matches: (event: object) => boolean;
    readonly read: (event: object) => boolean;
    readonly isCurrent: () => boolean;
  };
  readonly defineProperty: typeof Reflect.defineProperty;
  readonly apply: typeof Reflect.apply;
  readonly getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor;
  readonly getPrototypeOf: typeof Object.getPrototypeOf;
  readonly isCurrent: () => boolean;
}

const ROOT_REPLAY_REF = Symbol("table-menu-root-ref");

function tableMenuDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  return Boolean(
    current
    && current.configurable === expected.configurable
    && current.enumerable === expected.enumerable
    && current.writable === expected.writable
    && current.value === expected.value
    && current.get === expected.get
    && current.set === expected.set
  );
}

function captureTableMenuKeyboardAuthority(
  ownerWindow: Window & typeof globalThis,
): TableMenuKeyboardAuthority | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const defineProperty = ownerWindow.Reflect.defineProperty;
  const eventPrototype = ownerWindow.Event.prototype;
  const keyboardPrototype = ownerWindow.KeyboardEvent.prototype;
  const documentPrototype = ownerWindow.Document.prototype;
  const htmlElementPrototype = ownerWindow.HTMLElement.prototype;
  const authorities: Array<{ readonly isCurrent: () => boolean }> = [];
  const prototypeLinks: Array<readonly [object, object | null]> = [];
  const linkedPrototypes = new Set<object>();
  const capturePrototypeChain = (prototype: object) => {
    let current: object | null = prototype;
    while (current && !linkedPrototypes.has(current)) {
      linkedPrototypes.add(current);
      const parent = getPrototypeOf(current) as object | null;
      prototypeLinks.push(Object.freeze([current, parent] as const));
      current = parent;
    }
  };
  capturePrototypeChain(keyboardPrototype);
  capturePrototypeChain(eventPrototype);
  capturePrototypeChain(documentPrototype);
  capturePrototypeChain(htmlElementPrototype);
  capturePrototypeChain(ownerWindow.EventTarget.prototype);

  const captureGetter = <T,>(
    prototype: object,
    property: PropertyKey,
  ): TableMenuIntrinsicGetter<T> | null => {
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
            tableMenuDescriptorsMatch(
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
  ): TableMenuIntrinsicMethod<Args, Result> | null => {
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
            tableMenuDescriptorsMatch(
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

  const captureCallableProperty = <Args extends readonly unknown[], Result>(
    target: object,
    property: PropertyKey,
  ): TableMenuIntrinsicMethod<Args, Result> | null => {
    let current: object | null = target;
    while (current) {
      const descriptor = getOwnPropertyDescriptor(current, property);
      if (descriptor) {
        const method = typeof descriptor.value === "function"
          ? descriptor.value
          : typeof descriptor.get === "function"
            ? apply(descriptor.get, target, [])
            : null;
        if (typeof method !== "function") return null;
        const owner = current;
        const expected = Object.freeze({ ...descriptor });
        const authority = Object.freeze({
          call: (receiver: object, ...args: Args) =>
            apply(method as (...values: Args) => Result, receiver, args) as Result,
          isCurrent: () => {
            const currentDescriptor = getOwnPropertyDescriptor(owner, property);
            if (!tableMenuDescriptorsMatch(currentDescriptor, expected)) return false;
            return typeof expected.get !== "function"
              || apply(expected.get, target, []) === method;
          },
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
  const eventDefaultPrevented = captureGetter<boolean>(
    eventPrototype,
    "defaultPrevented",
  );
  const eventCancelBubble = captureGetter<boolean>(
    eventPrototype,
    "cancelBubble",
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
  const addEventListener = captureMethod<
    readonly [string, EventListener, (boolean | AddEventListenerOptions)?],
    void
  >(ownerWindow.EventTarget.prototype, "addEventListener");
  const removeEventListener = captureMethod<
    readonly [string, EventListener, (boolean | EventListenerOptions)?],
    void
  >(ownerWindow.EventTarget.prototype, "removeEventListener");
  const addWindowEventListener = captureCallableProperty<
    readonly [string, EventListener, (boolean | AddEventListenerOptions)?],
    void
  >(ownerWindow, "addEventListener");
  const removeWindowEventListener = captureCallableProperty<
    readonly [string, EventListener, (boolean | EventListenerOptions)?],
    void
  >(ownerWindow, "removeEventListener");

  let trustProbe: KeyboardEvent;
  try {
    trustProbe = new ownerWindow.KeyboardEvent("table-menu-keyboard-intrinsic");
  } catch {
    return null;
  }
  const trustDescriptor = getOwnPropertyDescriptor(trustProbe, "isTrusted");
  if (
    !trustDescriptor
    || trustDescriptor.configurable !== false
    || typeof trustDescriptor.get !== "function"
    || trustDescriptor.set !== undefined
  ) {
    return null;
  }
  const expectedTrustDescriptor = Object.freeze({ ...trustDescriptor });
  const isTrusted = Object.freeze({
    matches: (event: object) =>
      tableMenuDescriptorsMatch(
        getOwnPropertyDescriptor(event, "isTrusted"),
        expectedTrustDescriptor,
      ),
    read: (event: object) =>
      apply(trustDescriptor.get as (this: object) => boolean, event, []),
    isCurrent: () =>
      tableMenuDescriptorsMatch(
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
    || !eventDefaultPrevented
    || !eventCancelBubble
    || !eventPath
    || !eventPreventDefault
    || !eventStopPropagation
    || !eventStopImmediatePropagation
    || !eventView
    || !keyboardKey
    || !keyboardCtrl
    || !keyboardMeta
    || !keyboardAlt
    || !keyboardShift
    || !keyboardRepeat
    || !keyboardComposing
    || !activeElement
    || !focus
    || !addEventListener
    || !removeEventListener
    || !addWindowEventListener
    || !removeWindowEventListener
  ) {
    return null;
  }

  const isCurrent = () =>
    ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor
    && ownerWindow.Object.getPrototypeOf === getPrototypeOf
    && ownerWindow.Reflect.apply === apply
    && ownerWindow.Reflect.defineProperty === defineProperty
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
    eventType,
    eventTarget,
    eventCurrentTarget,
    eventPhase,
    eventBubbles,
    eventCancelable,
    eventDefaultPrevented,
    eventCancelBubble,
    eventPath,
    eventPreventDefault,
    eventStopPropagation,
    eventStopImmediatePropagation,
    eventView,
    keyboardKey,
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
    addWindowEventListener,
    removeWindowEventListener,
    isTrusted,
    defineProperty,
    apply,
    getOwnPropertyDescriptor,
    getPrototypeOf,
    isCurrent,
  });
}

function tableMenuEventPath(
  ownerDocument: Document,
  ownerWindow: Window,
  target: Node,
) {
  const path: EventTarget[] = [];
  let current: Node | null = target;
  while (current) {
    path.push(current);
    current = current.parentNode;
  }
  if (path.at(-1) !== ownerDocument) return null;
  path.push(ownerWindow);
  return Object.freeze(path);
}

function tableMenuPathMatches(
  expected: readonly EventTarget[],
  actual: readonly EventTarget[],
  ownerDocument: Document,
) {
  const actualWindow = actual.at(-1);
  const expectedWindow = expected.at(-1);
  return actual.length === expected.length
    && tableMenuIsOwnerWindow(actualWindow, ownerDocument, expectedWindow)
    && actual.slice(0, -1).every((target, index) => target === expected[index]);
}

function tableMenuIsOwnerWindow(
  candidate: unknown,
  ownerDocument: Document,
  expected: unknown,
) {
  return candidate === expected
    || (
      typeof candidate === "object"
      && candidate !== null
      && "document" in candidate
      && candidate.document === ownerDocument
      && "window" in candidate
      && candidate.window === candidate
    );
}

function tableMenuDestination(key: string, current: number, count: number) {
  if (count !== TABLE_MENU_CONTROL_DEFINITIONS.length || current < 0 || current >= count) {
    return null;
  }
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return current === 0 ? null : 0;
  if (key === "End") return current === count - 1 ? null : count - 1;
  return null;
}

function elementAttributes(node: Node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  return Object.freeze(
    Array.from((node as Element).attributes, ({ name, value }) => Object.freeze([name, value] as const)),
  );
}

function domNodeSnapshots(root: Node) {
  const snapshots: TableMenuDomNodeSnapshot[] = [];
  const visit = (node: Node) => {
    const children = Object.freeze(Array.from(node.childNodes));
    snapshots.push(Object.freeze({
      node,
      children,
      attributes: elementAttributes(node),
      value: node.nodeValue,
    }));
    children.forEach(visit);
  };
  visit(root);
  return Object.freeze(snapshots);
}

function matchesDomSnapshot(snapshot: TableMenuDomSnapshot, exactContent = false) {
  const { root } = snapshot;
  if (
    !root.isConnected
    || root.parentNode !== snapshot.parent
    || root.previousSibling !== snapshot.previousSibling
    || root.nextSibling !== snapshot.nextSibling
  ) {
    return false;
  }
  for (const record of snapshot.nodes) {
    const children = record.node.childNodes;
    if (children.length !== record.children.length) return false;
    for (let index = 0; index < children.length; index++) {
      if (children[index] !== record.children[index]) return false;
    }
    if (exactContent && record.node.nodeValue !== record.value) return false;
    if (exactContent && record.attributes) {
      const attributes = (record.node as Element).attributes;
      if (attributes.length !== record.attributes.length) return false;
      for (let index = 0; index < attributes.length; index++) {
        const expected = record.attributes[index];
        if (attributes[index].name !== expected[0] || attributes[index].value !== expected[1]) return false;
      }
    }
  }
  return true;
}

function captureDomSnapshot(publication: TableMenuControlPublication): TableMenuDomSnapshot | null {
  const root = publication.root;
  const buttons = publication.controlOrder.map((control) => control.element);
  if (!root?.isConnected || buttons.some((button) => !button)) return null;
  const ownedButtons = buttons as HTMLButtonElement[];
  const renderedButtons = Array.from(root.querySelectorAll("button"));
  if (
    renderedButtons.length !== ownedButtons.length
    || renderedButtons.some((button, index) => button !== ownedButtons[index])
  ) {
    return null;
  }
  return Object.freeze({
    root,
    parent: root.parentNode,
    previousSibling: root.previousSibling,
    nextSibling: root.nextSibling,
    buttons: Object.freeze([...ownedButtons]),
    nodes: domNodeSnapshots(root),
  });
}

function observeDomSnapshot(
  snapshot: TableMenuDomSnapshot,
  onMutation: () => void,
): TableMenuDomMonitor | null {
  const parent = snapshot.parent;
  if (!parent) return null;
  let mutated = false;
  const recordMutation = (records: MutationRecord[]) => {
    if (records.length === 0) return;
    mutated = true;
    monitor.mutated = true;
    onMutation();
  };
  const rootObserver = new MutationObserver(recordMutation);
  const parentObserver = new MutationObserver(recordMutation);
  rootObserver.observe(snapshot.root, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  parentObserver.observe(parent, { childList: true });
  const monitor: TableMenuDomMonitor = {
    mutated,
    check: () => {
      recordMutation([...rootObserver.takeRecords(), ...parentObserver.takeRecords()]);
      return !monitor.mutated;
    },
    disconnect: () => {
      rootObserver.disconnect();
      parentObserver.disconnect();
    },
  };
  return monitor;
}

function publicationMatchesSnapshot(
  publication: TableMenuControlPublication,
  snapshot: TableMenuDomSnapshot,
  exactContent = false,
) {
  return publication.root === snapshot.root
    && publication.controlOrder.every((control, index) => control.element === snapshot.buttons[index])
    && matchesDomSnapshot(snapshot, exactContent);
}

function tableMenuPublicationFactsAreCurrent(
  publication: TableMenuKeyboardPublication,
  coordinator: TableMenuControlCoordinator,
) {
  const controlPublication = publication.controlPublication;
  const authority = controlPublication.authority;
  return coordinator.ownsPublication(controlPublication)
    && !controlPublication.retired
    && controlPublication.keyboardRuntime?.publication === publication
    && authority.active
    && controlPublication.geometry.authority === authority
    && controlPublication.editor === publication.editor
    && authority.editor === publication.editor
    && authority.view === publication.view
    && authority.container === publication.container
    && authority.session === publication.session
    && authority.format === publication.format
    && authority.canEdit === publication.canEdit
    && authority.activeSurface === publication.activeSurface
    && controlPublication.view === publication.view
    && controlPublication.container === publication.container
    && controlPublication.session === publication.session
    && controlPublication.actions === publication.actions
    && controlPublication.format === publication.format
    && controlPublication.tablePos === publication.tablePos
    && controlPublication.tableAlign === publication.tableAlign
    && controlPublication.canEdit === publication.canEdit
    && controlPublication.activeSurface === publication.activeSurface
    && publication.session.canEdit === publication.canEdit
    && publication.session.activeSurface === publication.activeSurface
    && publication.format.tablePos === publication.tablePos
    && publication.format.tableAlign === publication.tableAlign
    && publication.tablePos >= 0
    && publication.canEdit
    && publication.activeSurface === "rich"
    && publication.ownerDocument.defaultView === publication.ownerWindow
    && publication.root.ownerDocument === publication.ownerDocument
    && publication.editor.ownerDocument === publication.ownerDocument
    && publication.container.ownerDocument === publication.ownerDocument
    && publication.view.dom === publication.editor
    && !publication.view.isDestroyed
    && !isTableMenuHidden(publication.view.state);
}

function tableMenuDomIsExact(publication: TableMenuKeyboardPublication) {
  const controlPublication = publication.controlPublication;
  const root = publication.root;
  const snapshot = publication.snapshot;
  if (
    controlPublication.domSnapshot !== snapshot
    || !controlPublication.domMonitor?.check()
    || !publicationMatchesSnapshot(controlPublication, snapshot, true)
    || snapshot.root !== root
    || snapshot.buttons.length !== TABLE_MENU_CONTROL_DEFINITIONS.length
    || publication.entries.length !== TABLE_MENU_CONTROL_DEFINITIONS.length
    || controlPublication.controlOrder.length !== TABLE_MENU_CONTROL_DEFINITIONS.length
    || controlPublication.controls.size !== TABLE_MENU_CONTROL_DEFINITIONS.length
    || !Object.isFrozen(publication)
    || !Object.isFrozen(publication.entries)
    || !Object.isFrozen(controlPublication.controlOrder)
    || root.ownerDocument !== publication.ownerDocument
    || !root.isConnected
    || root.tagName !== "DIV"
    || root.className !== TABLE_MENU_CLASS
    || root.getAttribute("role") !== "toolbar"
    || root.getAttribute("aria-label") !== TABLE_MENU_LABEL
    || root.getAttribute("aria-orientation") !== "horizontal"
    || root.dataset.testid !== "table-menu"
  ) {
    return false;
  }
  return publication.entries.every((entry, index) => {
    const definition = TABLE_MENU_CONTROL_DEFINITIONS[index];
    const expectedPressed = definition.align
      ? String(publication.tableAlign === definition.align)
      : null;
    const button = entry.element;
    return entry.index === index
      && entry.publicationIdentity === publication.identity
      && entry.control === controlPublication.controlOrder[index]
      && entry.control.publication === controlPublication
      && entry.control.identity === entry.action.controlIdentity
      && entry.action.publicationIdentity === publication.identity
      && entry.action.index === index
      && snapshot.buttons[index] === button
      && entry.control.element === button
      && button.ownerDocument === publication.ownerDocument
      && button.isConnected
      && button.tagName === "BUTTON"
      && button.parentElement !== null
      && root.contains(button)
      && button.type === "button"
      && button.getAttribute("type") === "button"
      && !button.disabled
      && !button.matches(":disabled")
      && button.getAttribute("aria-label") === definition.label
      && button.getAttribute("aria-pressed") === expectedPressed
      && button.dataset.testid === definition.testId
      && button.className === cn(
        TABLE_MENU_BUTTON_CLASS,
        expectedPressed === "true" && TABLE_MENU_ACTIVE_BUTTON_CLASS,
      );
  });
}

function readTableMenuReactKeyProof(
  event: object,
  native: TableMenuNativeKeyProof,
  currentTarget: Element,
  authority: TableMenuKeyboardAuthority,
  expectedMethods?: TableMenuReactEventMethods,
): TableMenuReactKeyProof | null {
  const publicValue = (property: PropertyKey) =>
    (event as Record<PropertyKey, unknown>)[property];
  const preventDefault = publicValue("preventDefault");
  const isDefaultPrevented = publicValue("isDefaultPrevented");
  const isPropagationStopped = publicValue("isPropagationStopped");
  if (
    typeof preventDefault !== "function"
    || typeof isDefaultPrevented !== "function"
    || typeof isPropagationStopped !== "function"
  ) {
    return null;
  }
  const methods = Object.freeze({
    preventDefault: preventDefault as (...args: never[]) => unknown,
    isDefaultPrevented: isDefaultPrevented as (...args: never[]) => unknown,
    isPropagationStopped: isPropagationStopped as (...args: never[]) => unknown,
  });
  const composing = publicValue("isComposing");
  const eventPhase = publicValue("eventPhase");
  if (
    publicValue("type") !== "keydown"
    || publicValue("nativeEvent") !== native.event
    || publicValue("target") !== native.target
    || publicValue("currentTarget") !== currentTarget
    || publicValue("bubbles") !== true
    || publicValue("cancelable") !== true
    || publicValue("defaultPrevented") !== false
    || publicValue("isTrusted") !== true
    || publicValue("key") !== native.key
    || publicValue("ctrlKey") !== false
    || publicValue("metaKey") !== false
    || publicValue("altKey") !== false
    || publicValue("shiftKey") !== false
    || publicValue("repeat") !== false
    || (composing !== undefined && composing !== false)
    || publicValue("view") !== native.publication.ownerWindow
    || eventPhase !== authority.eventPhase.read(native.event)
    || authority.apply(isDefaultPrevented, event, []) !== false
    || authority.apply(isPropagationStopped, event, []) !== false
    || (expectedMethods && (
      methods.preventDefault !== expectedMethods.preventDefault
      || methods.isDefaultPrevented !== expectedMethods.isDefaultPrevented
      || methods.isPropagationStopped !== expectedMethods.isPropagationStopped
    ))
  ) {
    return null;
  }
  return Object.freeze({
    event,
    nativeEvent: native.event,
    target: native.target,
    key: native.key,
    eventPhase: eventPhase as number,
    methods,
    composing: composing === undefined ? null : false,
  });
}

function tableMenuReactProofIsCurrent(
  proof: TableMenuReactKeyProof,
  native: TableMenuNativeKeyProof,
  authority: TableMenuKeyboardAuthority,
) {
  const event = proof.event;
  const publicValue = (property: PropertyKey) =>
    (event as Record<PropertyKey, unknown>)[property];
  return publicValue("type") === "keydown"
    && publicValue("nativeEvent") === native.event
    && publicValue("target") === native.target
    && publicValue("currentTarget") === null
    && publicValue("bubbles") === true
    && publicValue("cancelable") === true
    && publicValue("defaultPrevented") === false
    && publicValue("isTrusted") === true
    && publicValue("key") === native.key
    && publicValue("ctrlKey") === false
    && publicValue("metaKey") === false
    && publicValue("altKey") === false
    && publicValue("shiftKey") === false
    && publicValue("repeat") === false
    && (
      proof.composing === null
        ? publicValue("isComposing") === undefined
        : publicValue("isComposing") === false
    )
    && publicValue("view") === native.publication.ownerWindow
    && publicValue("eventPhase") === proof.eventPhase
    && publicValue("preventDefault") === proof.methods.preventDefault
    && publicValue("isDefaultPrevented") === proof.methods.isDefaultPrevented
    && publicValue("isPropagationStopped") === proof.methods.isPropagationStopped
    && authority.apply(proof.methods.isDefaultPrevented, event, []) === false
    && authority.apply(proof.methods.isPropagationStopped, event, []) === false;
}

function tableMenuReactProofIsPrevented(
  proof: TableMenuReactKeyProof,
  native: TableMenuNativeKeyProof,
  authority: TableMenuKeyboardAuthority,
) {
  const event = proof.event;
  const publicValue = (property: PropertyKey) =>
    (event as Record<PropertyKey, unknown>)[property];
  const currentIsDefaultPrevented = publicValue("isDefaultPrevented");
  return publicValue("type") === "keydown"
    && publicValue("nativeEvent") === native.event
    && publicValue("target") === native.target
    && publicValue("currentTarget") === null
    && publicValue("bubbles") === true
    && publicValue("cancelable") === true
    && publicValue("defaultPrevented") === true
    && publicValue("isTrusted") === true
    && publicValue("key") === native.key
    && publicValue("ctrlKey") === false
    && publicValue("metaKey") === false
    && publicValue("altKey") === false
    && publicValue("shiftKey") === false
    && publicValue("repeat") === false
    && (
      proof.composing === null
        ? publicValue("isComposing") === undefined
        : publicValue("isComposing") === false
    )
    && publicValue("view") === native.publication.ownerWindow
    && publicValue("eventPhase") === proof.eventPhase
    && publicValue("preventDefault") === proof.methods.preventDefault
    && typeof currentIsDefaultPrevented === "function"
    && publicValue("isPropagationStopped") === proof.methods.isPropagationStopped
    && authority.apply(currentIsDefaultPrevented, event, []) === true
    && authority.apply(proof.methods.isPropagationStopped, event, []) === false;
}

function createTableMenuKeyboardRuntime(
  controlPublication: TableMenuControlPublication,
  snapshot: TableMenuDomSnapshot,
  coordinator: TableMenuControlCoordinator,
): TableMenuKeyboardRuntime | null {
  const root = snapshot.root;
  const ownerDocument = root.ownerDocument;
  const ownerWindow = ownerDocument.defaultView as (Window & typeof globalThis) | null;
  if (
    !ownerWindow
    || controlPublication.root !== root
    || controlPublication.editor.ownerDocument !== ownerDocument
    || controlPublication.container.ownerDocument !== ownerDocument
  ) {
    return null;
  }
  const authority = captureTableMenuKeyboardAuthority(ownerWindow);
  if (!authority || !authority.isCurrent()) return null;
  const windowAuthority = ownerWindow;
  const keyboardAuthority = authority;
  const identity = Symbol("table-menu-keyboard-publication");
  const entries: TableMenuKeyboardEntry[] = [];
  for (let index = 0; index < controlPublication.controlOrder.length; index++) {
    const control = controlPublication.controlOrder[index];
    const element = control?.element;
    const path = element
      ? tableMenuEventPath(ownerDocument, ownerWindow, element)
      : null;
    if (!control || !element || !path || snapshot.buttons[index] !== element) return null;
    entries.push(Object.freeze({
      identity: Symbol(`table-menu-keyboard-entry-${index}`),
      publicationIdentity: identity,
      control,
      index,
      element,
      path,
      action: Object.freeze({
        identity: Symbol(`table-menu-keyboard-action-${index}`),
        publicationIdentity: identity,
        controlIdentity: control.identity,
        index,
      }),
    }));
  }
  const publication: TableMenuKeyboardPublication = Object.freeze({
    identity,
    controlPublication,
    ownerDocument,
    ownerWindow,
    root,
    editor: controlPublication.editor,
    view: controlPublication.view,
    container: controlPublication.container,
    session: controlPublication.session,
    actions: controlPublication.actions,
    format: controlPublication.format,
    tablePos: controlPublication.tablePos,
    tableAlign: controlPublication.tableAlign,
    canEdit: controlPublication.canEdit,
    activeSurface: controlPublication.activeSurface,
    entries: Object.freeze(entries),
    snapshot,
  });

  let released = false;
  let published = false;
  // Keep capture state reachable only through the exact native event.
  let nativePairs = new WeakMap<KeyboardEvent, TableMenuNativeReactPair>();
  let activeNativeEvent: WeakRef<KeyboardEvent> | null = null;
  let windowListenerActive = false;

  const publicationIsCurrent = () => {
    if (
      authority.isCurrent()
      && tableMenuPublicationFactsAreCurrent(publication, coordinator)
      && tableMenuDomIsExact(publication)
    ) {
      return true;
    }
    if (coordinator.ownsPublication(controlPublication)) {
      coordinator.invalidate(controlPublication);
    }
    return false;
  };
  const nativeStillMatches = (proof: TableMenuNativeKeyProof) =>
    authority.isCurrent()
    && authority.getPrototypeOf(proof.event) === authority.keyboardPrototype
    && authority.isTrusted.matches(proof.event)
    && authority.isTrusted.read(proof.event) === proof.trusted
    && authority.eventType.read(proof.event) === "keydown"
    && authority.eventTarget.read(proof.event) === proof.target
    && authority.eventView.read(proof.event) === publication.ownerWindow
    && authority.eventBubbles.read(proof.event)
    && authority.eventCancelable.read(proof.event)
    && authority.keyboardKey.read(proof.event) === proof.key
    && authority.keyboardCtrl.read(proof.event) === proof.ctrlKey
    && authority.keyboardMeta.read(proof.event) === proof.metaKey
    && authority.keyboardAlt.read(proof.event) === proof.altKey
    && authority.keyboardShift.read(proof.event) === proof.shiftKey
    && authority.keyboardRepeat.read(proof.event) === proof.repeat
    && authority.keyboardComposing.read(proof.event) === proof.composing;
  const entryForControl = (control: TableMenuControl) =>
    publication.entries.find((entry) => entry.control === control) ?? null;
  const removeWindowListener = () => {
    if (!windowListenerActive) return;
    authority.removeWindowEventListener.call(
      publication.ownerWindow,
      "keydown",
      onNativeWindowBubble,
    );
    windowListenerActive = false;
  };
  const rejectPair = (
    pair: TableMenuNativeReactPair,
    retirePublication = false,
  ) => {
    if (pair.consumed) return;
    pair.rejected = true;
    if (!retirePublication) return;
    nativePairs.delete(pair.native.event);
    if (pair.terminal) removeWindowListener();
    if (coordinator.ownsPublication(controlPublication)) {
      coordinator.invalidate(controlPublication);
    }
  };
  const replacePairs = () => {
    removeWindowListener();
    nativePairs = new WeakMap<KeyboardEvent, TableMenuNativeReactPair>();
    activeNativeEvent = null;
  };
  const exactNativeEvent = (
    event: Event,
    entry: TableMenuKeyboardEntry,
  ): TableMenuNativeKeyProof | null => {
    if (
      !publicationIsCurrent()
      || authority.getPrototypeOf(event) !== authority.keyboardPrototype
      || !authority.isTrusted.matches(event)
      || authority.isTrusted.read(event) !== true
    ) {
      return null;
    }
    const key = authority.keyboardKey.read(event);
    const destinationIndex = tableMenuDestination(
      key,
      entry.index,
      publication.entries.length,
    );
    const destination = destinationIndex === null
      ? null
      : publication.entries[destinationIndex];
    if (
      !destination
      || authority.eventCurrentTarget.read(event) !== ownerDocument
      || authority.eventPhase.read(event) !== ownerWindow.Event.CAPTURING_PHASE
      || !authority.eventBubbles.read(event)
      || !authority.eventCancelable.read(event)
      || authority.eventDefaultPrevented.read(event)
      || authority.eventCancelBubble.read(event)
      || authority.eventView.read(event) !== ownerWindow
      || authority.keyboardCtrl.read(event)
      || authority.keyboardMeta.read(event)
      || authority.keyboardAlt.read(event)
      || authority.keyboardShift.read(event)
      || authority.keyboardRepeat.read(event)
      || authority.keyboardComposing.read(event)
      || authority.activeElement.read(ownerDocument) !== entry.element
      || entry.publicationIdentity !== publication.identity
      || entry.action.publicationIdentity !== publication.identity
      || entry.action.controlIdentity !== entry.control.identity
      || destination.publicationIdentity !== publication.identity
      || !tableMenuPathMatches(
        entry.path,
        authority.eventPath.call(event),
        ownerDocument,
      )
      || authority.getOwnPropertyDescriptor(event, "preventDefault")
      || authority.getOwnPropertyDescriptor(event, "stopPropagation")
      || authority.getOwnPropertyDescriptor(event, "stopImmediatePropagation")
    ) {
      return null;
    }
    let propagationStopped = false;
    if (
      !authority.defineProperty(event, "stopPropagation", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: () => {
          propagationStopped = true;
          authority.eventStopPropagation.call(event);
        },
      })
      || !authority.defineProperty(event, "stopImmediatePropagation", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: () => {
          propagationStopped = true;
          authority.eventStopImmediatePropagation.call(event);
        },
      })
    ) {
      return null;
    }
    return {
      identity: Symbol("table-menu-native-key"),
      publication,
      entry,
      action: entry.action,
      event: event as KeyboardEvent,
      target: entry.element,
      path: entry.path,
      key,
      destination,
      trusted: true,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      composing: false,
      propagationStopped: () => propagationStopped,
      crossed: false,
    };
  };
  const beginNativeEvent = (event: Event) => {
    if (
      released
      || authority.eventType.read(event) !== "keydown"
      || authority.getPrototypeOf(event) !== authority.keyboardPrototype
    ) {
      return;
    }
    const target = authority.eventTarget.read(event);
    const entry = publication.entries.find(({ element }) => element === target);
    if (!entry) return;
    const activeEvent = activeNativeEvent?.deref();
    if (
      activeEvent
      && authority.eventPhase.read(activeEvent) !== ownerWindow.Event.NONE
    ) {
      const activePair = nativePairs.get(activeEvent);
      if (activePair) {
        activePair.native.crossed = true;
        rejectPair(activePair);
      }
      coordinator.attemptNativeEvent(event);
      return;
    }
    if (!coordinator.attemptNativeEvent(event)) return;
    const proof = exactNativeEvent(event, entry);
    if (!proof) return;
    controlPublication.keyboardObserved = true;
    nativePairs.set(proof.event, {
      native: proof,
      reactRootCapture: null,
      reactControlCapture: null,
      reactControlBubble: null,
      reactRootBubble: null,
      boundaryObserved: false,
      terminal: null,
      consumed: false,
      rejected: false,
    });
    activeNativeEvent = new WeakRef(proof.event);
  };
  const pairForReactEvent = (event: object) => {
    const nativeEvent = (event as Record<PropertyKey, unknown>).nativeEvent;
    return typeof nativeEvent === "object" && nativeEvent !== null
      ? nativePairs.get(nativeEvent as KeyboardEvent)
      : undefined;
  };
  const readReact = (
    pair: TableMenuNativeReactPair,
    event: object,
    currentTarget: Element,
    expectedMethods?: TableMenuReactEventMethods,
  ) => readTableMenuReactKeyProof(
    event,
    pair.native,
    currentTarget,
    authority,
    expectedMethods,
  );
  const captureRoot = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!event || typeof event !== "object") return;
    const pair = pairForReactEvent(event);
    if (
      !pair
      || pair.rejected
      || pair.consumed
    ) {
      return;
    }
    if (
      pair.reactRootCapture
      || !coordinator.attemptReactEvent(event, "capture")
    ) {
      rejectPair(pair);
      return;
    }
    const proof = readReact(pair, event, publication.root);
    if (!proof) {
      rejectPair(pair);
      return;
    }
    pair.reactRootCapture = proof;
  };
  const captureControl = (
    control: TableMenuControl,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const pair = event && typeof event === "object"
      ? pairForReactEvent(event)
      : undefined;
    const entry = entryForControl(control);
    if (
      !pair
      || pair.rejected
      || pair.consumed
      || !entry
      || pair.native.entry !== entry
      || !pair.reactRootCapture
      || pair.reactControlCapture
      || event !== pair.reactRootCapture.event
    ) {
      if (pair) rejectPair(pair);
      return;
    }
    const proof = readReact(
      pair,
      event,
      entry.element,
      pair.reactRootCapture.methods,
    );
    if (!proof) {
      rejectPair(pair);
      return;
    }
    pair.reactControlCapture = proof;
  };
  const bubbleControl = (
    control: TableMenuControl,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (!event || typeof event !== "object") return;
    const pair = pairForReactEvent(event);
    const entry = entryForControl(control);
    if (
      !pair
      || pair.rejected
      || pair.consumed
      || !entry
      || pair.native.entry !== entry
      || !pair.reactControlCapture
      || pair.reactControlBubble
      || !coordinator.attemptReactEvent(event, "bubble")
    ) {
      if (pair) rejectPair(pair);
      return;
    }
    const proof = readReact(
      pair,
      event,
      entry.element,
    );
    if (!proof) {
      rejectPair(pair);
      return;
    }
    pair.reactControlBubble = proof;
  };
  const bubbleRoot = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const pair = event && typeof event === "object"
      ? pairForReactEvent(event)
      : undefined;
    if (
      !pair
      || pair.rejected
      || pair.consumed
      || !pair.reactControlBubble
      || pair.reactRootBubble
      || event !== pair.reactControlBubble.event
    ) {
      if (pair) rejectPair(pair);
      return;
    }
    const proof = readReact(
      pair,
      event,
      publication.root,
      pair.reactControlBubble.methods,
    );
    if (!proof) {
      rejectPair(pair);
      return;
    }
    pair.reactRootBubble = proof;
  };
  const authenticateTerminal = (pair: TableMenuNativeReactPair) => {
    const proof = pair.native;
    if (
      pair.rejected
      || pair.consumed
      || proof.crossed
      || !pair.boundaryObserved
      || !pair.reactRootCapture
      || pair.reactControlCapture?.event !== pair.reactRootCapture.event
      || !pair.reactControlBubble
      || pair.reactRootBubble?.event !== pair.reactControlBubble.event
      || !nativeStillMatches(proof)
      || !tableMenuReactProofIsCurrent(
        pair.reactRootCapture,
        proof,
        authority,
      )
      || !tableMenuReactProofIsCurrent(
        pair.reactControlBubble,
        proof,
        authority,
      )
      || !publicationIsCurrent()
      || authority.activeElement.read(ownerDocument) !== proof.target
    ) {
      return null;
    }
    return Object.freeze({
      native: proof,
      reactCapture: pair.reactRootCapture,
      reactBubble: pair.reactControlBubble,
    });
  };
  const settleTerminal = (
    pair: TableMenuNativeReactPair,
    proof: TableMenuTerminalKeyProof,
  ) => {
    const native = proof.native;
    if (
      !pair.consumed
      || pair.terminal !== proof
      || released
      || native.crossed
      || native.propagationStopped()
      || authority.eventCurrentTarget.read(native.event) !== null
      || authority.eventPhase.read(native.event) !== ownerWindow.Event.NONE
      || authority.eventDefaultPrevented.read(native.event)
      || authority.eventCancelBubble.read(native.event)
      || authority.activeElement.read(ownerDocument) !== native.target
      || !nativeStillMatches(native)
      || !tableMenuReactProofIsCurrent(proof.reactCapture, native, authority)
      || !tableMenuReactProofIsCurrent(proof.reactBubble, native, authority)
      || !publicationIsCurrent()
      || !coordinator.canClaimKeyboard(
        publication,
        native.entry,
        native.action,
        proof.reactCapture.event,
        proof.reactBubble.event,
        native.event,
      )
    ) {
      return;
    }
    authority.apply(
      proof.reactBubble.methods.preventDefault,
      proof.reactBubble.event,
      [],
    );
    if (
      !authority.eventDefaultPrevented.read(native.event)
      || authority.eventCancelBubble.read(native.event)
      || native.propagationStopped()
      || authority.activeElement.read(ownerDocument) !== native.target
      || !nativeStillMatches(native)
      || !tableMenuReactProofIsPrevented(
        proof.reactBubble,
        native,
        authority,
      )
      || !publicationIsCurrent()
      || !coordinator.claimKeyboard(
        publication,
        native.entry,
        native.action,
        proof.reactCapture.event,
        proof.reactBubble.event,
        native.event,
      )
    ) {
      return;
    }
    authority.focus.call(native.destination.element, { preventScroll: true });
    coordinator.requestSuccessor(controlPublication);
  };
  function onNativeWindowBubble(event: Event) {
    if (authority.getPrototypeOf(event) !== authority.keyboardPrototype) return;
    const pair = nativePairs.get(event as KeyboardEvent);
    const terminal = pair?.terminal;
    if (
      !pair
      || !terminal
      || terminal.native.event !== event
      || !tableMenuIsOwnerWindow(
        keyboardAuthority.eventCurrentTarget.read(event),
        ownerDocument,
        windowAuthority,
      )
      || keyboardAuthority.eventPhase.read(event) !== windowAuthority.Event.BUBBLING_PHASE
      || keyboardAuthority.eventDefaultPrevented.read(event)
      || keyboardAuthority.eventCancelBubble.read(event)
      || terminal.native.propagationStopped()
      || !tableMenuPathMatches(
        terminal.native.path,
        keyboardAuthority.eventPath.call(event),
        ownerDocument,
      )
    ) {
      if (pair) rejectPair(pair, true);
      return;
    }
    pair.consumed = true;
    nativePairs.delete(pair.native.event);
    removeWindowListener();
    queueMicrotask(() => settleTerminal(pair, terminal));
  }
  const onNativeCapture = (event: Event) => {
    beginNativeEvent(event);
  };
  const onNativeBubble = (event: Event) => {
    if (authority.getPrototypeOf(event) !== authority.keyboardPrototype) return;
    const pair = nativePairs.get(event as KeyboardEvent);
    const proof = pair?.native;
    if (
      !pair
      || !proof
      || proof.event !== event
      || authority.eventCurrentTarget.read(event) !== ownerDocument
      || authority.eventPhase.read(event) !== ownerWindow.Event.BUBBLING_PHASE
      || authority.eventDefaultPrevented.read(event)
      || authority.eventCancelBubble.read(event)
    ) {
      if (pair) rejectPair(pair, true);
      return;
    }
    const authenticated = authenticateTerminal(pair);
    if (!authenticated || proof.path.at(-1) !== ownerWindow) {
      rejectPair(pair, true);
      return;
    }
    pair.terminal = authenticated;
    windowListenerActive = true;
    authority.addWindowEventListener.call(
      ownerWindow,
      "keydown",
      onNativeWindowBubble,
    );
  };
  const boundaryListeners = publication.entries.map((entry) => {
    const listener = (event: Event) => {
      if (authority.getPrototypeOf(event) !== authority.keyboardPrototype) return;
      const pair = nativePairs.get(event as KeyboardEvent);
      if (
        pair
        && !pair.rejected
        && !pair.consumed
        && pair.native.event === event
        && pair.native.entry === entry
        && authority.eventCurrentTarget.read(event) === entry.element
        && (
          authority.eventPhase.read(event) === ownerWindow.Event.CAPTURING_PHASE
          || authority.eventPhase.read(event) === ownerWindow.Event.AT_TARGET
        )
        && publicationIsCurrent()
        && authority.activeElement.read(ownerDocument) === entry.element
      ) {
        pair.boundaryObserved = true;
      }
    };
    return Object.freeze({ entry, listener });
  });
  const publish = () => {
    if (
      published
      || released
      || !authority.isCurrent()
      || !tableMenuDomIsExact(publication)
    ) {
      return false;
    }
    published = true;
    authority.addEventListener.call(ownerDocument, "keydown", onNativeCapture, true);
    authority.addEventListener.call(ownerDocument, "keydown", onNativeBubble);
    for (const { entry, listener } of boundaryListeners) {
      authority.addEventListener.call(entry.element, "keydown", listener, true);
    }
    return true;
  };
  const release = () => {
    if (released) return;
    released = true;
    replacePairs();
    if (!published) return;
    authority.removeEventListener.call(ownerDocument, "keydown", onNativeCapture, true);
    authority.removeEventListener.call(ownerDocument, "keydown", onNativeBubble);
    for (const { entry, listener } of boundaryListeners) {
      authority.removeEventListener.call(entry.element, "keydown", listener, true);
    }
  };

  return Object.freeze({
    publication,
    publish,
    release,
    captureRoot,
    captureControl,
    bubbleControl,
    bubbleRoot,
  });
}

function publicationsMatchForReplay(
  source: TableMenuControlPublication,
  successor: TableMenuControlPublication,
) {
  return successor.identity !== source.identity
    && successor.mount === source.mount
    && successor.geometry.authority === source.geometry.authority
    && successor.geometry.left === source.geometry.left
    && successor.geometry.top === source.geometry.top
    && successor.geometry.width === source.geometry.width
    && successor.authority === source.authority
    && successor.editor === source.editor
    && successor.view === source.view
    && successor.container === source.container
    && successor.session === source.session
    && successor.actions === source.actions
    && successor.tableAction === source.tableAction
    && successor.alignAction === source.alignAction
    && successor.format === source.format
    && successor.tablePos === source.tablePos
    && successor.tableAlign === source.tableAlign
    && successor.canEdit === source.canEdit
    && successor.activeSurface === source.activeSurface
    && successor.requestSuccessor === source.requestSuccessor
    && !successor.view.isDestroyed
    && !isTableMenuHidden(successor.view.state);
}

class TableMenuControlCoordinator {
  #current: TableMenuControlPublication | null = null;
  #container: HTMLElement | null = null;
  #elementOwners = new WeakMap<HTMLButtonElement, TableMenuElementOwner>();
  #replayCandidate: TableMenuReplayCandidate | null = null;
  #replay: TableMenuReplay | null = null;
  #claimedPublications = new WeakSet<TableMenuKeyboardPublication>();
  #claimedEntries = new WeakSet<TableMenuKeyboardEntry>();
  #claimedActions = new WeakSet<TableMenuKeyboardAction>();
  #claimedReactEvents = new WeakSet<object>();
  #claimedNativeEvents = new WeakSet<Event>();
  #attemptedReactEvents = new WeakMap<object, number>();
  #attemptedNativeEvents = new WeakSet<Event>();

  publish(publication: TableMenuControlPublication) {
    if (publication.retired || (this.#current && this.#current !== publication)) return false;
    const replay = this.#replay;
    const snapshot = replay?.snapshot ?? captureDomSnapshot(publication);
    if (
      !snapshot
      || (replay && (
        replay.source.mouseDownObserved
        || replay.source.keyboardObserved
        || replay.source.controlOrder.some((control) => control.claimed)
        || !replay.source.domMonitor?.check()
        || !publicationsMatchForReplay(replay.source, publication)
        || !publicationMatchesSnapshot(publication, replay.snapshot, true)
      ))
    ) {
      this.#retire(publication, false);
      return false;
    }
    const candidate = this.#replayCandidate;
    this.#replayCandidate = null;
    candidate?.publication.domMonitor?.disconnect();
    this.#replay = null;
    replay?.source.domMonitor?.disconnect();
    publication.domMonitor = observeDomSnapshot(snapshot, () => this.#invalidateMutation(publication));
    if (!publication.domMonitor) {
      this.#retire(publication, false);
      return false;
    }
    publication.domSnapshot = snapshot;
    this.#current = publication;
    this.#container = publication.container;
    const keyboardRuntime = createTableMenuKeyboardRuntime(
      publication,
      snapshot,
      this,
    );
    publication.keyboardRuntime = keyboardRuntime;
    const keyboardPublished = keyboardRuntime?.publish();
    if (!keyboardPublished) {
      this.#retire(publication, false);
      return false;
    }
    return true;
  }

  retire(publication: TableMenuControlPublication | null) {
    this.#retire(publication, true);
  }

  replay(publication: TableMenuControlPublication) {
    const candidate = this.#replayCandidate;
    if (!candidate || candidate.publication !== publication) return null;
    this.#replayCandidate = null;
    if (
      this.#current
      || !publication.retired
      || publication.mouseDownObserved
      || publication.keyboardObserved
      || publication.controlOrder.some((control) => control.claimed)
      || !publication.domMonitor?.check()
      || publication.view.isDestroyed
      || isTableMenuHidden(publication.view.state)
      || !matchesDomSnapshot(candidate.snapshot, true)
      || [...candidate.refs.values()].some((ref) => !ref.detached || !ref.attached)
    ) {
      return null;
    }
    this.#replay = { source: publication, snapshot: candidate.snapshot };
    return this.#replay;
  }

  ownsPublication(publication: TableMenuControlPublication) {
    return this.#current === publication && this.#container === publication.container;
  }

  attemptNativeEvent(event: Event) {
    if (this.#attemptedNativeEvents.has(event)) return false;
    this.#attemptedNativeEvents.add(event);
    return true;
  }

  attemptReactEvent(event: object, phase: "capture" | "bubble") {
    const phaseFlag = phase === "capture" ? 1 : 2;
    const attempted = this.#attemptedReactEvents.get(event) ?? 0;
    if (attempted & phaseFlag) return false;
    this.#attemptedReactEvents.set(event, attempted | phaseFlag);
    return true;
  }

  claimKeyboard(
    publication: TableMenuKeyboardPublication,
    entry: TableMenuKeyboardEntry,
    action: TableMenuKeyboardAction,
    captureEvent: object,
    bubbleEvent: object,
    nativeEvent: Event,
  ) {
    if (!this.canClaimKeyboard(
      publication,
      entry,
      action,
      captureEvent,
      bubbleEvent,
      nativeEvent,
    )) {
      return false;
    }
    this.#claimedPublications.add(publication);
    this.#claimedEntries.add(entry);
    this.#claimedActions.add(action);
    this.#claimedReactEvents.add(captureEvent);
    this.#claimedReactEvents.add(bubbleEvent);
    this.#claimedNativeEvents.add(nativeEvent);
    publication.controlPublication.keyboardClaimed = true;
    return true;
  }

  canClaimKeyboard(
    publication: TableMenuKeyboardPublication,
    entry: TableMenuKeyboardEntry,
    action: TableMenuKeyboardAction,
    captureEvent: object,
    bubbleEvent: object,
    nativeEvent: Event,
  ) {
    const controlPublication = publication.controlPublication;
    return !(
      !this.ownsPublication(controlPublication)
      || controlPublication.keyboardRuntime?.publication !== publication
      || publication.entries[entry.index] !== entry
      || entry.action !== action
      || entry.publicationIdentity !== publication.identity
      || action.publicationIdentity !== publication.identity
      || this.#claimedPublications.has(publication)
      || this.#claimedEntries.has(entry)
      || this.#claimedActions.has(action)
      || this.#claimedReactEvents.has(captureEvent)
      || this.#claimedReactEvents.has(bubbleEvent)
      || this.#claimedNativeEvents.has(nativeEvent)
    );
  }

  requestSuccessor(publication: TableMenuControlPublication) {
    if (publication.successorRequested) return;
    publication.successorRequested = true;
    publication.requestSuccessor();
  }

  invalidate(publication: TableMenuControlPublication) {
    if (publication.retired) {
      this.requestSuccessor(publication);
      return;
    }
    this.#retire(publication, false);
    this.requestSuccessor(publication);
  }

  captureRootKey(
    publication: TableMenuControlPublication,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    publication.keyboardRuntime?.captureRoot(event);
  }

  captureControlKey(
    publication: TableMenuControlPublication,
    control: TableMenuControl,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    publication.keyboardRuntime?.captureControl(control, event);
  }

  bubbleControlKey(
    publication: TableMenuControlPublication,
    control: TableMenuControl,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    publication.keyboardRuntime?.bubbleControl(control, event);
  }

  bubbleRootKey(
    publication: TableMenuControlPublication,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    publication.keyboardRuntime?.bubbleRoot(event);
  }

  bindRoot(publication: TableMenuControlPublication, element: HTMLDivElement | null) {
    this.#observeReplayRef(publication, ROOT_REPLAY_REF, element);
    if (publication.retired || publication.root === element) return;
    if (publication.root || this.#current === publication) {
      this.#retire(publication, false);
      return;
    }
    if (element) publication.root = element;
  }

  bind(control: TableMenuControl, element: HTMLButtonElement | null) {
    const publication = control.publication;
    this.#observeReplayRef(publication, control, element);
    if (publication.retired || control.element === element) return;
    const previous = control.element;
    if (previous || this.#current === publication) {
      this.#retire(publication, false);
      return;
    }
    if (!element) return;
    const owner = this.#elementOwners.get(element);
    if (owner && (owner.publication !== publication || owner.control !== control)) {
      this.#retire(publication, false);
      return;
    }
    this.#elementOwners.set(element, {
      publication,
      publicationIdentity: publication.identity,
      control,
      controlIdentity: control.identity,
    });
    control.element = element;
  }

  ownsControl(publication: TableMenuControlPublication, control: TableMenuControl, element: HTMLButtonElement) {
    if (
      !this.ownsPublication(publication)
      || publication.retired
      || control.claimed
      || control.publication !== publication
      || control.element !== element
      || !element.isConnected
      || !publication.domSnapshot
    ) {
      return false;
    }
    if (!publicationMatchesSnapshot(publication, publication.domSnapshot)) {
      this.#retire(publication, false);
      return false;
    }
    const owner = this.#elementOwners.get(element);
    return owner?.publication === publication
      && owner.publicationIdentity === publication.identity
      && owner.control === control
      && owner.controlIdentity === control.identity;
  }

  #observeReplayRef(
    publication: TableMenuControlPublication,
    key: TableMenuControl | symbol,
    element: HTMLElement | null,
  ) {
    const candidate = this.#replayCandidate;
    if (!candidate || candidate.publication !== publication) return;
    const ref = candidate.refs.get(key);
    if (
      !ref
      || !publication.domMonitor?.check()
      || !matchesDomSnapshot(candidate.snapshot, true)
    ) {
      this.#discardReplay(publication);
      return;
    }
    if (!element) {
      if (ref.detached || [...candidate.refs.values()].some((current) => current.attached)) {
        this.#discardReplay(publication);
        return;
      }
      ref.detached = true;
      return;
    }
    if (
      element !== ref.expected
      || ref.attached
      || [...candidate.refs.values()].some((current) => !current.detached)
    ) {
      this.#discardReplay(publication);
      return;
    }
    ref.attached = true;
  }

  #retire(publication: TableMenuControlPublication | null, allowReplay: boolean) {
    if (!publication || publication.retired) return;
    const snapshot = publication.domSnapshot;
    const replay = this.#replay;
    this.#replay = null;
    replay?.source.domMonitor?.disconnect();
    // Strict replay cleans layout effects before replaying refs. A real replacement
    // detaches refs first, so it cannot leave this complete connected candidate.
    this.#replayCandidate = allowReplay
      && this.#current === publication
      && snapshot
      && !publication.mouseDownObserved
      && !publication.keyboardObserved
      && !publication.keyboardClaimed
      && publication.controlOrder.every((control) => !control.claimed)
      && publication.domMonitor?.check()
      && publicationMatchesSnapshot(publication, snapshot, true)
      ? {
        publication,
        snapshot,
        refs: new Map<TableMenuControl | symbol, TableMenuReplayRefState>([
          [ROOT_REPLAY_REF, { expected: snapshot.root, detached: false, attached: false }],
          ...publication.controlOrder.map((control, index) => [
            control,
            { expected: snapshot.buttons[index], detached: false, attached: false },
          ] as const),
        ]),
      }
      : null;
    if (!this.#replayCandidate) publication.domMonitor?.disconnect();
    publication.keyboardRuntime?.release();
    publication.keyboardRuntime = null;
    publication.retired = true;
    publication.domSnapshot = null;
    if (this.#current === publication) {
      this.#current = null;
      this.#container = null;
    }
    for (const control of publication.controlOrder) {
      const element = control.element;
      if (element) {
        const owner = this.#elementOwners.get(element);
        if (
          owner?.publication === publication
          && owner.publicationIdentity === publication.identity
          && owner.control === control
          && owner.controlIdentity === control.identity
        ) {
          this.#elementOwners.delete(element);
        }
      }
      control.element = null;
    }
    publication.root = null;
    const candidate = this.#replayCandidate;
    if (candidate?.publication === publication) {
      queueMicrotask(() => {
        if (this.#replayCandidate === candidate) this.#discardReplay(publication);
      });
    }
  }

  #invalidateMutation(publication: TableMenuControlPublication) {
    if (
      this.#current === publication
      || this.#replayCandidate?.publication === publication
      || this.#replay?.source === publication
    ) {
      this.#discardReplay(publication);
      if (!publication.retired) this.#retire(publication, false);
      this.requestSuccessor(publication);
    }
  }

  #discardReplay(publication: TableMenuControlPublication) {
    if (this.#replayCandidate?.publication === publication) this.#replayCandidate = null;
    if (this.#replay?.source === publication) this.#replay = null;
    publication.domMonitor?.disconnect();
  }
}

function createControlPublication({
  coordinator,
  mount,
  geometry,
  view,
  container,
  session,
  actions,
  format,
  canEdit,
  activeSurface,
  requestSuccessor,
  revision,
}: {
  coordinator: TableMenuControlCoordinator;
  mount: symbol;
  geometry: TableMenuGeometry;
  view: EditorView;
  container: HTMLElement;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  canEdit: boolean;
  activeSurface: CollabSession["activeSurface"];
  requestSuccessor: () => void;
  revision: number;
}): TableMenuControlSet {
  const editor = geometry.authority.editor;
  if (!editor) {
    throw new Error("Cannot publish table controls without the current editor");
  }
  const ownedGeometry = {
    authority: geometry.authority,
    left: geometry.left,
    top: geometry.top,
    width: geometry.width,
  };
  const publication: TableMenuControlPublication = {
    identity: Symbol("table-menu-control-publication"),
    revision,
    retired: false,
    mount,
    geometry: ownedGeometry,
    authority: ownedGeometry.authority,
    editor,
    view,
    container,
    session,
    actions,
    tableAction: actions.table,
    alignAction: actions.setColumnAlign,
    format,
    tablePos: format.tablePos,
    tableAlign: format.tableAlign,
    canEdit,
    activeSurface,
    controls: new Set(),
    controlOrder: [],
    mouseDownObserved: false,
    keyboardObserved: false,
    keyboardClaimed: false,
    successorRequested: false,
    requestSuccessor,
    root: null,
    bindRoot: () => undefined,
    domSnapshot: null,
    domMonitor: null,
    keyboardRuntime: null,
  };
  publication.bindRoot = (element) => coordinator.bindRoot(publication, element);
  const control = (invoke: () => void): TableMenuControl => {
    const owned: TableMenuControl = {
      identity: Symbol("table-menu-control"),
      publication,
      element: null,
      buttonRef: (element) => coordinator.bind(owned, element),
      claimed: false,
      invoke,
    };
    publication.controls.add(owned);
    publication.controlOrder.push(owned);
    return owned;
  };
  const table = (command: TableCommand) => control(() => publication.tableAction.call(publication.actions, command));
  const align = (value: Alignment) => {
    const target = publication.tableAlign === value ? null : value;
    return control(() => publication.alignAction.call(publication.actions, target));
  };

  const controls = Object.freeze({
    rowBefore: table("rowBefore"),
    rowAfter: table("rowAfter"),
    colBefore: table("colBefore"),
    colAfter: table("colAfter"),
    deleteRow: table("deleteRow"),
    deleteColumn: table("deleteColumn"),
    alignLeft: align("left"),
    alignCenter: align("center"),
    alignRight: align("right"),
    deleteTable: table("deleteTable"),
  });
  Object.freeze(publication.controlOrder);
  return Object.freeze({ publication, controls });
}

function MenuButton({
  label,
  keys,
  active,
  buttonRef,
  onMouseDown,
  onClick,
  onKeyDownCapture,
  onKeyDown,
  children,
  testId,
}: {
  label: string;
  keys?: string;
  active?: boolean;
  buttonRef: (element: HTMLButtonElement | null) => void;
  onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onKeyDownCapture: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Tip label={label} shortcut={keys ? shortcut(keys) : undefined} side="top">
      <button
        ref={buttonRef}
        type="button"
        className={cn(TABLE_MENU_BUTTON_CLASS, active && TABLE_MENU_ACTIVE_BUTTON_CLASS)}
        onMouseDown={onMouseDown}
        onClick={onClick}
        onKeyDownCapture={onKeyDownCapture}
        onKeyDown={onKeyDown}
        aria-label={label}
        aria-pressed={active}
        data-testid={testId}
      >
        {children}
      </button>
    </Tip>
  );
}

function publicationMatchesRender(
  publication: TableMenuControlPublication,
  {
    controlMount,
    geometry,
    view,
    session,
    actions,
    format,
    canEdit,
    activeSurface,
    container,
  }: {
    controlMount: symbol;
    geometry: TableMenuGeometry;
    view: EditorView;
    session: CollabSession;
    actions: EditorActions;
    format: FormatState;
    canEdit: boolean;
    activeSurface: CollabSession["activeSurface"];
    container: HTMLElement | null;
  },
) {
  return publication.mount === controlMount
    && publication.geometry.authority === geometry.authority
    && publication.geometry.left === geometry.left
    && publication.geometry.top === geometry.top
    && publication.geometry.width === geometry.width
    && publication.authority === geometry.authority
    && publication.view === view
    && publication.container === container
    && publication.session === session
    && publication.actions === actions
    && publication.tableAction === actions.table
    && publication.alignAction === actions.setColumnAlign
    && publication.format === format
    && publication.tablePos === format.tablePos
    && publication.tableAlign === format.tableAlign
    && publication.canEdit === canEdit
    && publication.activeSurface === activeSurface;
}

function TableMenuControls({
  geometry,
  view,
  session,
  actions,
  format,
  canEdit,
  activeSurface,
  containerRef,
  authorityRef,
}: {
  geometry: TableMenuGeometry;
  view: EditorView;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  canEdit: boolean;
  activeSurface: CollabSession["activeSurface"];
  containerRef: React.RefObject<HTMLElement | null>;
  authorityRef: React.RefObject<TableMenuAuthority | null>;
}) {
  const [controlMount] = useState(() => Symbol("table-menu-controls"));
  const [controlCoordinator] = useState(() => new TableMenuControlCoordinator());
  const [publicationRevision, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const controlSet = createControlPublication({
    coordinator: controlCoordinator,
    mount: controlMount,
    geometry,
    view,
    container: geometry.authority.container,
    session,
    actions,
    format,
    canEdit,
    activeSurface,
    requestSuccessor: requestPublicationSuccessor,
    revision: publicationRevision,
  });
  const { publication, controls } = controlSet;

  useLayoutEffect(() => {
    const current = publication.authority.active
      && authorityRef.current === publication.authority
      && publicationMatchesRender(publication, {
        controlMount,
        geometry,
        view,
        session,
        actions,
        format,
        canEdit,
        activeSurface,
        container: containerRef.current,
      })
      && publication.authority.container === publication.container
      && publication.authority.format === publication.format
      && publication.authority.canEdit === publication.canEdit
      && publication.authority.activeSurface === publication.activeSurface
      && publication.session.canEdit === publication.canEdit
      && publication.session.activeSurface === publication.activeSurface
      && publication.tablePos >= 0
      && publication.canEdit
      && publication.activeSurface === "rich";
    if (current && !controlCoordinator.publish(publication)) {
      if (controlCoordinator.replay(publication)) {
        setPublicationRevision((revision) => revision + 1);
      }
    } else {
      if (!current) controlCoordinator.retire(publication);
    }
    return () => controlCoordinator.retire(publication);
  }, [
    actions,
    activeSurface,
    authorityRef,
    canEdit,
    containerRef,
    controlCoordinator,
    controlMount,
    format,
    geometry,
    publication,
    session,
    view,
  ]);

  const { left, top, width } = publication.geometry;
  const ownsControl = (control: TableMenuControl, event: ReactMouseEvent<HTMLButtonElement>) => {
    if (
      control.publication !== publication
      || !publication.controls.has(control)
      || !controlCoordinator.ownsControl(publication, control, event.currentTarget)
    ) {
      return false;
    }
    const authority = publication.authority;
    if (
      !authority.active
      || publication.mount !== controlMount
      || publication.geometry.authority !== authority
      || authority.view !== publication.view
      || authority.container !== publication.container
      || authority.session !== publication.session
      || authority.format !== publication.format
      || authority.canEdit !== publication.canEdit
      || authority.activeSurface !== publication.activeSurface
      || publication.session.canEdit !== publication.canEdit
      || publication.session.activeSurface !== publication.activeSurface
      || publication.format.tablePos !== publication.tablePos
      || publication.format.tableAlign !== publication.tableAlign
      || publication.tablePos < 0
      || !publication.canEdit
      || publication.activeSurface !== "rich"
    ) {
      return false;
    }
    return !publication.view.isDestroyed && !isTableMenuHidden(publication.view.state);
  };
  const onMouseDown = (control: TableMenuControl) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    publication.mouseDownObserved = true;
    if (ownsControl(control, event)) event.preventDefault();
  };
  const onClick = (control: TableMenuControl) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!ownsControl(control, event)) return;
    control.claimed = true;
    control.invoke();
  };
  const onKeyDownCapture = (control: TableMenuControl) => (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    controlCoordinator.captureControlKey(publication, control, event);
  };
  const onKeyDown = (control: TableMenuControl) => (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    controlCoordinator.bubbleControlKey(publication, control, event);
  };

  return (
    <div
      ref={(element) => publication.bindRoot(element)}
      className={TABLE_MENU_CLASS}
      style={{ left, top, width }}
      data-testid="table-menu"
      role="toolbar"
      aria-label={TABLE_MENU_LABEL}
      aria-orientation="horizontal"
      onKeyDownCapture={(event) => controlCoordinator.captureRootKey(publication, event)}
      onKeyDown={(event) => controlCoordinator.bubbleRootKey(publication, event)}
    >
      <MenuButton label="Row above" keys="Mod-Alt-↑" buttonRef={controls.rowBefore.buttonRef} onMouseDown={onMouseDown(controls.rowBefore)} onClick={onClick(controls.rowBefore)} onKeyDownCapture={onKeyDownCapture(controls.rowBefore)} onKeyDown={onKeyDown(controls.rowBefore)} testId="table-row-before">
        <ArrowUpToLine size={16} />
      </MenuButton>
      <MenuButton label="Row below" keys="Mod-Alt-↓" buttonRef={controls.rowAfter.buttonRef} onMouseDown={onMouseDown(controls.rowAfter)} onClick={onClick(controls.rowAfter)} onKeyDownCapture={onKeyDownCapture(controls.rowAfter)} onKeyDown={onKeyDown(controls.rowAfter)} testId="table-row-after">
        <ArrowDownToLine size={16} />
      </MenuButton>
      <MenuButton label="Column left" keys="Mod-Alt-←" buttonRef={controls.colBefore.buttonRef} onMouseDown={onMouseDown(controls.colBefore)} onClick={onClick(controls.colBefore)} onKeyDownCapture={onKeyDownCapture(controls.colBefore)} onKeyDown={onKeyDown(controls.colBefore)} testId="table-col-before">
        <ArrowLeftToLine size={16} />
      </MenuButton>
      <MenuButton label="Column right" keys="Mod-Alt-→" buttonRef={controls.colAfter.buttonRef} onMouseDown={onMouseDown(controls.colAfter)} onClick={onClick(controls.colAfter)} onKeyDownCapture={onKeyDownCapture(controls.colAfter)} onKeyDown={onKeyDown(controls.colAfter)} testId="table-col-after">
        <ArrowRightToLine size={16} />
      </MenuButton>
      <span className="mx-0.5 h-5 w-px bg-white/20" />
      <MenuButton label="Delete row" keys="Mod-Alt-⌫" buttonRef={controls.deleteRow.buttonRef} onMouseDown={onMouseDown(controls.deleteRow)} onClick={onClick(controls.deleteRow)} onKeyDownCapture={onKeyDownCapture(controls.deleteRow)} onKeyDown={onKeyDown(controls.deleteRow)} testId="table-delete-row">
        <TableRowsSplit size={16} />
      </MenuButton>
      <MenuButton label="Delete column" keys="Mod-Alt-Shift-⌫" buttonRef={controls.deleteColumn.buttonRef} onMouseDown={onMouseDown(controls.deleteColumn)} onClick={onClick(controls.deleteColumn)} onKeyDownCapture={onKeyDownCapture(controls.deleteColumn)} onKeyDown={onKeyDown(controls.deleteColumn)} testId="table-delete-col">
        <TableColumnsSplit size={16} />
      </MenuButton>
      <span className="mx-0.5 h-5 w-px bg-white/20" />
      <MenuButton label="Align left" active={format.tableAlign === "left"} buttonRef={controls.alignLeft.buttonRef} onMouseDown={onMouseDown(controls.alignLeft)} onClick={onClick(controls.alignLeft)} onKeyDownCapture={onKeyDownCapture(controls.alignLeft)} onKeyDown={onKeyDown(controls.alignLeft)} testId="table-align-left">
        <TextAlignStart size={16} />
      </MenuButton>
      <MenuButton label="Align center" active={format.tableAlign === "center"} buttonRef={controls.alignCenter.buttonRef} onMouseDown={onMouseDown(controls.alignCenter)} onClick={onClick(controls.alignCenter)} onKeyDownCapture={onKeyDownCapture(controls.alignCenter)} onKeyDown={onKeyDown(controls.alignCenter)} testId="table-align-center">
        <TextAlignCenter size={16} />
      </MenuButton>
      <MenuButton label="Align right" active={format.tableAlign === "right"} buttonRef={controls.alignRight.buttonRef} onMouseDown={onMouseDown(controls.alignRight)} onClick={onClick(controls.alignRight)} onKeyDownCapture={onKeyDownCapture(controls.alignRight)} onKeyDown={onKeyDown(controls.alignRight)} testId="table-align-right">
        <TextAlignEnd size={16} />
      </MenuButton>
      <span className="mx-0.5 h-5 w-px bg-white/20" />
      <MenuButton label="Delete table" buttonRef={controls.deleteTable.buttonRef} onMouseDown={onMouseDown(controls.deleteTable)} onClick={onClick(controls.deleteTable)} onKeyDownCapture={onKeyDownCapture(controls.deleteTable)} onKeyDown={onKeyDown(controls.deleteTable)} testId="table-delete">
        <Trash2 size={16} />
      </MenuButton>
    </div>
  );
}

/**
 * Floating table toolbar anchored to the top edge of the table around the rich
 * pane's selection. Unlike the selection bubble it does not follow the caret, so
 * both can be visible at once without overlapping.
 */
export function TableMenu({
  view,
  session,
  actions,
  format,
  containerRef,
}: {
  view: EditorView | null;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const [geometry, setGeometry] = useState<TableMenuGeometry | null>(null);
  const authorityRef = useRef<TableMenuAuthority | null>(null);
  const canEdit = useSessionValue(session, (s) => s.canEdit);
  const activeSurface = useSessionValue(session, (s) => s.activeSurface);

  // Resolve ref.current on every commit: the pane can be replaced without replacing its ref.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const previous = authorityRef.current;
    if (previous?.view === view && previous.container === container && previous.session === session) {
      const changed = previous.format !== format || previous.canEdit !== canEdit || previous.activeSurface !== activeSurface;
      previous.format = format;
      previous.canEdit = canEdit;
      previous.activeSurface = activeSurface;
      if (changed) previous.schedule();
      return;
    }
    previous?.dispose();
    authorityRef.current = null;
    if (!view || !container) {
      return;
    }
    const ownedView = view;
    const ownedContainer = container;

    let disposed = false;
    let frame: ScheduledFrame | null = null;
    const authority: TableMenuAuthority = {
      active: true,
      view: ownedView,
      editor: null,
      container: ownedContainer,
      session,
      format,
      canEdit,
      activeSurface,
      schedule,
      dispose,
    };

    function owns(scheduled: ScheduledFrame) {
      return !disposed && authorityRef.current === authority && frame === scheduled;
    }

    function publish(scheduled: ScheduledFrame, position: Omit<TableMenuGeometry, "authority"> | null) {
      if (!owns(scheduled)) return;
      setGeometry(position ? { authority, ...position } : null);
    }

    function compute(scheduled: ScheduledFrame) {
      if (!owns(scheduled)) return;
      const currentFormat = authority.format;
      if (
        ownedView.isDestroyed ||
        currentFormat.tablePos < 0 ||
        !authority.canEdit ||
        authority.activeSurface !== "rich" ||
        isTableMenuHidden(ownedView.state)
      ) {
        publish(scheduled, null);
        return;
      }
      if (!owns(scheduled)) return;
      const dom = ownedView.nodeDOM(currentFormat.tablePos);
      // The table node view wraps the <table>; anchor to whichever element is actually rendered.
      const table = dom instanceof HTMLElement ? (dom.tagName === "TABLE" ? dom : dom.querySelector("table") ?? dom) : null;
      if (!table) {
        publish(scheduled, null);
        return;
      }
      const rect = table.getBoundingClientRect();
      const host = ownedContainer.getBoundingClientRect();
      // Sit above the table; if that edge is scrolled away, stick to the top of the pane. Then keep
      // the whole menu inside the window (narrow phones shrink it and let it scroll sideways).
      const box = clampToViewport(
        { left: rect.left, top: Math.max(host.top + 4, rect.top - MENU_HEIGHT - 8), width: MENU_WIDTH, height: MENU_HEIGHT },
        { width: window.innerWidth, height: window.innerHeight },
      );
      const left = Math.max(8, Math.min(ownedContainer.clientWidth - box.width - 8, box.left - host.left));
      const top = Math.max(ownedContainer.scrollTop + 4, box.top - host.top + ownedContainer.scrollTop);
      publish(scheduled, { left, top, width: box.width });
    }

    function schedule() {
      if (disposed || authorityRef.current !== authority || frame !== null) return;
      const scheduled: ScheduledFrame = { id: -1 };
      frame = scheduled;
      scheduled.id = requestAnimationFrame(() => {
        if (!owns(scheduled)) return;
        compute(scheduled);
        if (frame === scheduled) frame = null;
      });
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      authority.active = false;
      ownedContainer.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      authority.editor?.removeEventListener(TABLE_MENU_EVENT, schedule);
      const scheduled = frame;
      frame = null;
      if (scheduled) cancelAnimationFrame(scheduled.id);
      setGeometry((current) => current?.authority === authority ? null : current);
    }

    authorityRef.current = authority;
    if (authorityRef.current !== authority) return;
    const editor = ownedView.dom;
    authority.editor = editor;
    ownedContainer.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // Esc hides the menu (and the next caret move shows it again) through plugin state; the editor
    // announces each flip here because a meta-only transaction changes nothing the shell re-renders on.
    editor.addEventListener(TABLE_MENU_EVENT, schedule);
    schedule();
  });

  useLayoutEffect(() => () => {
    authorityRef.current?.dispose();
    authorityRef.current = null;
  }, []);

  if (!geometry || !view || geometry.authority.view !== view || geometry.authority.session !== session) {
    return null;
  }
  return (
    <TableMenuControls
      geometry={geometry}
      view={view}
      session={session}
      actions={actions}
      format={format}
      canEdit={canEdit}
      activeSurface={activeSurface}
      containerRef={containerRef}
      authorityRef={authorityRef}
    />
  );
}
