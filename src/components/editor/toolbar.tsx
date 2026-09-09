"use client";

import {
  memo,
  useCallback,
  useLayoutEffect,
  useState,
  type Dispatch,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type SetStateAction,
} from "react";
import {
  Bold,
  Italic,
  Link as LinkIcon,
  Code,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Image as ImageIcon,
  Table,
  Minus,
  Undo2,
  Redo2,
  ChevronDown,
  Heading,
  Strikethrough,
  SquareCode,
  MessageSquarePlus,
} from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { EditorActions, FormatState } from "./actions";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger, Tip } from "@/components/ui/primitives";
import { cn, shortcut } from "@/lib/utils";
import { rovingIndex } from "@/lib/a11y";
import { shallowEqual, useSessionValue } from "./use-session";
import { TOOLBAR_BOX } from "./chrome-classes";

type ToolbarPermission = "edit" | "undo" | "redo" | "comment" | "current";
type HeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface HeadingDisclosure {
  readonly mount: object;
  readonly destination: HeadingLevel;
  readonly keyboard: ToolbarKeyboardIntrinsics;
}

interface HeadingState {
  readonly mount: object;
  readonly open: boolean;
  readonly disclosure: HeadingDisclosure | null;
}

type ToolbarControl<T extends HTMLElement = HTMLButtonElement> = Readonly<{
  id: string;
  enabled: boolean;
  rootButton: boolean;
  element: () => T | null;
  capture: (element: T | null) => void;
  onClick: (event: MouseEvent<T>) => void;
  onMouseDown: (event: MouseEvent<T>) => void;
}>;

type OwnedToolbarControl = Readonly<{
  id: string;
  enabled: boolean;
  rootButton: boolean;
  element: () => HTMLElement | null;
}>;

type ToolbarAction = Readonly<{
  token: symbol;
  control: OwnedToolbarControl;
  permission: ToolbarPermission;
  requireEnabled: boolean;
  run: () => void;
}>;

type ToolbarButtons = Readonly<{
  heading: ToolbarControl;
  bold: ToolbarControl;
  italic: ToolbarControl;
  strike: ToolbarControl;
  link: ToolbarControl;
  code: ToolbarControl;
  codeBlock: ToolbarControl;
  bullet: ToolbarControl;
  ordered: ToolbarControl;
  task: ToolbarControl;
  quote: ToolbarControl;
  image: ToolbarControl;
  table: ToolbarControl;
  rule: ToolbarControl;
  undo: ToolbarControl;
  redo: ToolbarControl;
  comment: ToolbarControl;
}>;

type ToolbarPublication = Readonly<{
  captureRoot: (element: HTMLDivElement | null) => void;
  captureHeadingContent: (element: HTMLDivElement | null) => void;
  buttons: ToolbarButtons;
  headingItems: ReadonlyArray<Readonly<{
    level: HeadingLevel;
    control: ToolbarControl<HTMLDivElement>;
    onSelect: (event: Event) => void;
  }>>;
  establish: () => void | (() => void);
  retire: () => boolean;
  isRetired: () => boolean;
  onFocus: (event: FocusEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onHeadingKeyCapture: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onHeadingKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onHeadingOpenChange: (open: boolean) => void;
  onHeadingClose: (event: Event) => void;
}>;

class CurrentCell<T> {
  constructor(public current: T) {}
}

class PublicationIdentity {
  current?: ToolbarPublication;
}

interface ElementOwnerView {
  readonly element: () => HTMLElement | null;
}

class ElementOwner<T extends HTMLElement> {
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: ElementOwnerView,
      element: HTMLElement | null,
      previous: HTMLElement | null,
      last: HTMLElement | null,
    ) => void,
  ) {}

  readonly element = () => this.current;
  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    const previous = this.current;
    const last = this.last;
    this.current = element;
    if (element) this.last = element;
    this.onChange(this, element, previous, last);
  };
}

interface ToolbarDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly ToolbarDomSnapshot[];
}

interface ToolbarPlacement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface ToolbarReplay {
  readonly source: ToolbarPublication;
  readonly dom: ToolbarDomSnapshot;
  readonly placement: ToolbarPlacement;
  readonly keyboard: ToolbarKeyboardIntrinsics;
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

interface RefReplay {
  readonly owner: ElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface ToolbarTrustedAuthority {
  readonly read: (event: object) => boolean;
  readonly matches: (event: object) => boolean;
}

interface ToolbarDescriptorEvidence {
  readonly owner: object;
  readonly property: PropertyKey;
  readonly descriptor: PropertyDescriptor;
}

interface ToolbarKeyboardIntrinsics {
  readonly ownerWindow: Window & typeof globalThis;
  readonly windowPrototype: object;
  readonly keyboardPrototype: object;
  readonly objectPrototype: object;
  readonly capturingPhase: number;
  readonly bubblingPhase: number;
  readonly apply: typeof Reflect.apply;
  readonly getPrototypeOf: typeof Object.getPrototypeOf;
  readonly isPrototypeOf: typeof Object.prototype.isPrototypeOf;
  readonly trusted: ToolbarTrustedAuthority;
  readonly event: Readonly<{
    type: (this: Event) => string;
    target: (this: Event) => EventTarget | null;
    currentTarget: (this: Event) => EventTarget | null;
    eventPhase: (this: Event) => number;
    bubbles: (this: Event) => boolean;
    cancelable: (this: Event) => boolean;
    defaultPrevented: (this: Event) => boolean;
    cancelBubble: (this: Event) => boolean;
    composedPath: (this: Event) => EventTarget[];
  }>;
  readonly keyboard: Readonly<{
    key: (this: globalThis.KeyboardEvent) => string;
    code: (this: globalThis.KeyboardEvent) => string;
    location: (this: globalThis.KeyboardEvent) => number;
    altKey: (this: globalThis.KeyboardEvent) => boolean;
    ctrlKey: (this: globalThis.KeyboardEvent) => boolean;
    metaKey: (this: globalThis.KeyboardEvent) => boolean;
    shiftKey: (this: globalThis.KeyboardEvent) => boolean;
    repeat: (this: globalThis.KeyboardEvent) => boolean;
    isComposing: (this: globalThis.KeyboardEvent) => boolean;
  }>;
  readonly view: (this: UIEvent) => Window | null;
  readonly activeElement: (this: Document) => Element | null;
  readonly focus: (this: HTMLElement, options?: FocusOptions) => void;
  readonly isCurrent: () => boolean;
  readonly methodMatches: (
    event: object,
    property: PropertyKey,
    value: unknown,
  ) => boolean;
  readonly ownDataMatches: (
    event: object,
    property: PropertyKey,
    value: unknown,
  ) => boolean;
}

interface ToolbarKeyboardSnapshot {
  readonly type: string;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  readonly eventPhase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly path: readonly EventTarget[];
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly isTrusted: boolean;
  readonly view: Window | null;
}

interface HeadingKeyPublication {
  readonly source: ToolbarPublication;
  readonly reactEvent: KeyboardEvent<HTMLButtonElement>;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly snapshot: ToolbarKeyboardSnapshot;
}

interface HeadingCloseVisit {
  readonly source: ToolbarPublication;
  readonly content: HTMLDivElement;
}

const TRANSIENT_BUTTON_ATTRIBUTES = new Set([
  "aria-controls",
  "aria-describedby",
  "aria-expanded",
  "data-state",
]);

const TRANSIENT_HEADING_ATTRIBUTES = new Set([
  "data-align",
  "data-highlighted",
  "data-orientation",
  "data-side",
  "style",
  "tabindex",
]);
const PREVENT_SCROLL = Object.freeze({ preventScroll: true });

function isTransientToolbarAttribute(node: Node, name: string | null): boolean {
  if (!name || node.nodeType !== 1) return false;
  const element = node as Element;
  if (element.tagName === "BUTTON" && TRANSIENT_BUTTON_ATTRIBUTES.has(name)) return true;
  return Boolean(
    TRANSIENT_HEADING_ATTRIBUTES.has(name) &&
      (element.hasAttribute("data-toolbar-heading-content") ||
        element.hasAttribute("data-toolbar-heading") ||
        element.closest("[data-toolbar-heading-content]")),
  );
}

function toolbarGetter<This extends object, Value>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  owner: object,
  property: PropertyKey,
  evidence: ToolbarDescriptorEvidence[],
): ((this: This) => Value) | null {
  const descriptor = getOwnPropertyDescriptor(owner, property);
  const getter = descriptor?.get;
  if (typeof getter === "function" && descriptor) {
    evidence.push(Object.freeze({
      owner,
      property,
      descriptor: Object.freeze({ ...descriptor }),
    }));
  }
  return typeof getter === "function" ? (getter as (this: This) => Value) : null;
}

function toolbarMethod<Method extends (...args: never[]) => unknown>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  owner: object,
  property: PropertyKey,
  evidence: ToolbarDescriptorEvidence[],
): Method | null {
  const descriptor = getOwnPropertyDescriptor(owner, property);
  const method = descriptor?.value;
  if (typeof method === "function" && descriptor) {
    evidence.push(Object.freeze({
      owner,
      property,
      descriptor: Object.freeze({ ...descriptor }),
    }));
  }
  return typeof method === "function" ? (method as Method) : null;
}

function toolbarDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
): boolean {
  if (
    !current ||
    current.configurable !== expected.configurable ||
    current.enumerable !== expected.enumerable ||
    ("value" in current) !== ("value" in expected) ||
    ("writable" in current) !== ("writable" in expected) ||
    ("get" in current) !== ("get" in expected) ||
    ("set" in current) !== ("set" in expected)
  ) {
    return false;
  }
  return "value" in expected
    ? current.value === expected.value &&
        current.writable === expected.writable
    : current.get === expected.get && current.set === expected.set;
}

function captureToolbarTrustedAuthority(
  ownerWindow: Window & typeof globalThis,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
  evidence: ToolbarDescriptorEvidence[],
): ToolbarTrustedAuthority | null {
  let probe: globalThis.KeyboardEvent;
  try {
    probe = new ownerWindow.KeyboardEvent("toolbar-keyboard-intrinsic");
  } catch {
    return null;
  }
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    !descriptor ||
    descriptor.configurable !== false ||
    typeof descriptor.get !== "function" ||
    descriptor.set !== undefined
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  evidence.push(Object.freeze({
    owner: probe,
    property: "isTrusted",
    descriptor: expected,
  }));
  const matches = (event: object) =>
    toolbarDescriptorsMatch(getOwnPropertyDescriptor(event, "isTrusted"), expected);
  return Object.freeze({
    matches,
    read: (event: object) =>
      apply(descriptor.get as (this: object) => boolean, event, []),
  });
}

function captureToolbarKeyboardIntrinsics(
  ownerWindow: Window & typeof globalThis,
): ToolbarKeyboardIntrinsics | null {
  const objectConstructor = ownerWindow.Object;
  const reflectObject = ownerWindow.Reflect;
  const windowConstructor = ownerWindow.Window;
  const eventConstructor = ownerWindow.Event;
  const uiEventConstructor = ownerWindow.UIEvent;
  const keyboardConstructor = ownerWindow.KeyboardEvent;
  const documentConstructor = ownerWindow.Document;
  const htmlElementConstructor = ownerWindow.HTMLElement;
  const objectPrototype = objectConstructor.prototype;
  const windowPrototype = windowConstructor.prototype;
  const eventPrototype = eventConstructor.prototype;
  const keyboardPrototype = keyboardConstructor.prototype;
  const uiEventPrototype = uiEventConstructor.prototype;
  const documentPrototype = documentConstructor.prototype;
  const htmlElementPrototype = htmlElementConstructor.prototype;
  const getOwnPropertyDescriptor = objectConstructor.getOwnPropertyDescriptor;
  const evidence: ToolbarDescriptorEvidence[] = [];
  const apply = toolbarMethod<typeof Reflect.apply>(
    getOwnPropertyDescriptor,
    reflectObject,
    "apply",
    evidence,
  );
  const getPrototypeOf = toolbarMethod<typeof Object.getPrototypeOf>(
    getOwnPropertyDescriptor,
    objectConstructor,
    "getPrototypeOf",
    evidence,
  );
  const isPrototypeOf = toolbarMethod<typeof Object.prototype.isPrototypeOf>(
    getOwnPropertyDescriptor,
    objectPrototype,
    "isPrototypeOf",
    evidence,
  );
  const descriptorMethod = toolbarMethod<
    typeof Object.getOwnPropertyDescriptor
  >(
    getOwnPropertyDescriptor,
    objectConstructor,
    "getOwnPropertyDescriptor",
    evidence,
  );
  if (
    apply !== ownerWindow.Reflect.apply ||
    getPrototypeOf !== ownerWindow.Object.getPrototypeOf ||
    isPrototypeOf !== ownerWindow.Object.prototype.isPrototypeOf ||
    descriptorMethod !== getOwnPropertyDescriptor
  ) {
    return null;
  }
  const trusted = captureToolbarTrustedAuthority(
    ownerWindow,
    getOwnPropertyDescriptor,
    apply,
    evidence,
  );
  const type = toolbarGetter<Event, string>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "type",
    evidence,
  );
  const target = toolbarGetter<Event, EventTarget | null>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "target",
    evidence,
  );
  const currentTarget = toolbarGetter<Event, EventTarget | null>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "currentTarget",
    evidence,
  );
  const eventPhase = toolbarGetter<Event, number>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "eventPhase",
    evidence,
  );
  const bubbles = toolbarGetter<Event, boolean>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "bubbles",
    evidence,
  );
  const cancelable = toolbarGetter<Event, boolean>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "cancelable",
    evidence,
  );
  const defaultPrevented = toolbarGetter<Event, boolean>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "defaultPrevented",
    evidence,
  );
  const cancelBubble = toolbarGetter<Event, boolean>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "cancelBubble",
    evidence,
  );
  const key = toolbarGetter<globalThis.KeyboardEvent, string>(
    getOwnPropertyDescriptor,
    keyboardPrototype,
    "key",
    evidence,
  );
  const code = toolbarGetter<globalThis.KeyboardEvent, string>(
    getOwnPropertyDescriptor,
    keyboardPrototype,
    "code",
    evidence,
  );
  const location = toolbarGetter<globalThis.KeyboardEvent, number>(
    getOwnPropertyDescriptor,
    keyboardPrototype,
    "location",
    evidence,
  );
  const altKey = toolbarGetter<globalThis.KeyboardEvent, boolean>(
    getOwnPropertyDescriptor,
    keyboardPrototype,
    "altKey",
    evidence,
  );
  const ctrlKey = toolbarGetter<globalThis.KeyboardEvent, boolean>(
    getOwnPropertyDescriptor,
    keyboardPrototype,
    "ctrlKey",
    evidence,
  );
  const metaKey = toolbarGetter<globalThis.KeyboardEvent, boolean>(
    getOwnPropertyDescriptor,
    keyboardPrototype,
    "metaKey",
    evidence,
  );
  const shiftKey = toolbarGetter<globalThis.KeyboardEvent, boolean>(
    getOwnPropertyDescriptor,
    keyboardPrototype,
    "shiftKey",
    evidence,
  );
  const repeat = toolbarGetter<globalThis.KeyboardEvent, boolean>(
    getOwnPropertyDescriptor,
    keyboardPrototype,
    "repeat",
    evidence,
  );
  const isComposing = toolbarGetter<globalThis.KeyboardEvent, boolean>(
    getOwnPropertyDescriptor,
    keyboardPrototype,
    "isComposing",
    evidence,
  );
  const view = toolbarGetter<UIEvent, Window | null>(
    getOwnPropertyDescriptor,
    uiEventPrototype,
    "view",
    evidence,
  );
  const activeElement = toolbarGetter<Document, Element | null>(
    getOwnPropertyDescriptor,
    documentPrototype,
    "activeElement",
    evidence,
  );
  const composedPath = toolbarMethod<typeof Event.prototype.composedPath>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "composedPath",
    evidence,
  );
  const focus = toolbarMethod<typeof HTMLElement.prototype.focus>(
    getOwnPropertyDescriptor,
    htmlElementPrototype,
    "focus",
    evidence,
  );
  if (
    !trusted ||
    !type ||
    !target ||
    !currentTarget ||
    !eventPhase ||
    !bubbles ||
    !cancelable ||
    !defaultPrevented ||
    !cancelBubble ||
    !key ||
    !code ||
    !location ||
    !altKey ||
    !ctrlKey ||
    !metaKey ||
    !shiftKey ||
    !repeat ||
    !isComposing ||
    !view ||
    !activeElement ||
    typeof composedPath !== "function" ||
    typeof focus !== "function" ||
    typeof apply !== "function" ||
    typeof getPrototypeOf !== "function" ||
    typeof isPrototypeOf !== "function"
  ) {
    return null;
  }
  let historyIsClean = true;
  const ownerRealmIsCurrent = () =>
    ownerWindow.Object === objectConstructor &&
    ownerWindow.Reflect === reflectObject &&
    ownerWindow.Window === windowConstructor &&
    ownerWindow.Event === eventConstructor &&
    ownerWindow.UIEvent === uiEventConstructor &&
    ownerWindow.KeyboardEvent === keyboardConstructor &&
    ownerWindow.Document === documentConstructor &&
    ownerWindow.HTMLElement === htmlElementConstructor &&
    ownerWindow.Object.prototype === objectPrototype &&
    windowConstructor.prototype === windowPrototype &&
    eventConstructor.prototype === eventPrototype &&
    uiEventConstructor.prototype === uiEventPrototype &&
    keyboardConstructor.prototype === keyboardPrototype &&
    documentConstructor.prototype === documentPrototype &&
    htmlElementConstructor.prototype === htmlElementPrototype &&
    ownerWindow.Object.getOwnPropertyDescriptor ===
      getOwnPropertyDescriptor &&
    ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
    ownerWindow.Object.prototype.isPrototypeOf === isPrototypeOf &&
    ownerWindow.Reflect.apply === apply;
  const isCurrent = () => {
    if (!historyIsClean) return false;
    try {
      historyIsClean =
        ownerRealmIsCurrent() &&
        evidence.every(({ owner, property, descriptor }) =>
          toolbarDescriptorsMatch(
            getOwnPropertyDescriptor(owner, property),
            descriptor,
          ),
        );
    } catch {
      historyIsClean = false;
    }
    return historyIsClean;
  };
  const methodMatches = (
    event: object,
    property: PropertyKey,
    value: unknown,
  ) => {
    if (!isCurrent() || typeof value !== "function") return false;
    try {
      let owner: object | null = event;
      while (owner) {
        const descriptor = getOwnPropertyDescriptor(owner, property);
        if (descriptor) {
          return "value" in descriptor && descriptor.value === value;
        }
        owner = getPrototypeOf(owner);
      }
      return false;
    } catch {
      historyIsClean = false;
      return false;
    }
  };
  const ownDataMatches = (
    event: object,
    property: PropertyKey,
    value: unknown,
  ) => {
    if (!isCurrent()) return false;
    try {
      const descriptor = getOwnPropertyDescriptor(event, property);
      return Boolean(
        descriptor &&
          "value" in descriptor &&
          descriptor.value === value,
      );
    } catch {
      historyIsClean = false;
      return false;
    }
  };
  if (!isCurrent()) return null;
  return Object.freeze({
    ownerWindow,
    windowPrototype,
    keyboardPrototype,
    objectPrototype,
    capturingPhase: ownerWindow.Event.CAPTURING_PHASE,
    bubblingPhase: ownerWindow.Event.BUBBLING_PHASE,
    apply,
    getPrototypeOf,
    isPrototypeOf,
    trusted,
    event: Object.freeze({
      type,
      target,
      currentTarget,
      eventPhase,
      bubbles,
      cancelable,
      defaultPrevented,
      cancelBubble,
      composedPath,
    }),
    keyboard: Object.freeze({
      key,
      code,
      location,
      altKey,
      ctrlKey,
      metaKey,
      shiftKey,
      repeat,
      isComposing,
    }),
    view,
    activeElement,
    focus,
    isCurrent,
    methodMatches,
    ownDataMatches,
  });
}

function readToolbarKeyboardEvent(
  event: Event,
  intrinsics: ToolbarKeyboardIntrinsics,
): ToolbarKeyboardSnapshot | null {
  try {
    if (
      !intrinsics.isCurrent() ||
      !intrinsics.apply(intrinsics.isPrototypeOf, intrinsics.keyboardPrototype, [event]) ||
      !intrinsics.trusted.matches(event)
    ) {
      return null;
    }
    const snapshot = Object.freeze({
      type: intrinsics.apply(intrinsics.event.type, event, []),
      target: intrinsics.apply(intrinsics.event.target, event, []),
      currentTarget: intrinsics.apply(intrinsics.event.currentTarget, event, []),
      eventPhase: intrinsics.apply(intrinsics.event.eventPhase, event, []),
      bubbles: intrinsics.apply(intrinsics.event.bubbles, event, []),
      cancelable: intrinsics.apply(intrinsics.event.cancelable, event, []),
      defaultPrevented: intrinsics.apply(
        intrinsics.event.defaultPrevented,
        event,
        [],
      ),
      cancelBubble: intrinsics.apply(intrinsics.event.cancelBubble, event, []),
      path: Object.freeze(
        intrinsics.apply(intrinsics.event.composedPath, event, []),
      ),
      key: intrinsics.apply(intrinsics.keyboard.key, event, []),
      code: intrinsics.apply(intrinsics.keyboard.code, event, []),
      location: intrinsics.apply(intrinsics.keyboard.location, event, []),
      altKey: intrinsics.apply(intrinsics.keyboard.altKey, event, []),
      ctrlKey: intrinsics.apply(intrinsics.keyboard.ctrlKey, event, []),
      metaKey: intrinsics.apply(intrinsics.keyboard.metaKey, event, []),
      shiftKey: intrinsics.apply(intrinsics.keyboard.shiftKey, event, []),
      repeat: intrinsics.apply(intrinsics.keyboard.repeat, event, []),
      isComposing: intrinsics.apply(intrinsics.keyboard.isComposing, event, []),
      isTrusted: intrinsics.trusted.read(event),
      view: intrinsics.apply(intrinsics.view, event, []),
    });
    return intrinsics.isCurrent() ? snapshot : null;
  } catch {
    return null;
  }
}

function toolbarKeyboardPathMatches(
  path: readonly EventTarget[],
  trigger: HTMLButtonElement,
  ownerDocument: Document,
  intrinsics: ToolbarKeyboardIntrinsics,
): boolean {
  const expected: EventTarget[] = [];
  let current: Node | null = trigger;
  while (current) {
    expected.push(current);
    if (current === ownerDocument) break;
    current = current.parentNode;
  }
  const terminal = path.at(-1);
  const terminalMatches =
    terminal === intrinsics.ownerWindow ||
    Boolean(
      terminal &&
        intrinsics.apply(
          intrinsics.isPrototypeOf,
          intrinsics.windowPrototype,
          [terminal],
        ),
    );
  return (
    expected.at(-1) === ownerDocument &&
    path.length === expected.length + 1 &&
    expected.every((entry, index) => path[index] === entry) &&
    terminalMatches
  );
}

function toolbarKeyboardFactsMatch(
  captured: ToolbarKeyboardSnapshot,
  current: ToolbarKeyboardSnapshot,
): boolean {
  return (
    captured.type === current.type &&
    captured.target === current.target &&
    captured.bubbles === current.bubbles &&
    captured.cancelable === current.cancelable &&
    captured.defaultPrevented === current.defaultPrevented &&
    captured.cancelBubble === current.cancelBubble &&
    captured.key === current.key &&
    captured.code === current.code &&
    captured.location === current.location &&
    captured.altKey === current.altKey &&
    captured.ctrlKey === current.ctrlKey &&
    captured.metaKey === current.metaKey &&
    captured.shiftKey === current.shiftKey &&
    captured.repeat === current.repeat &&
    captured.isComposing === current.isComposing &&
    captured.isTrusted === current.isTrusted &&
    Object.is(captured.view, current.view) &&
    captured.path.length === current.path.length &&
    captured.path.every((entry, index) => current.path[index] === entry)
  );
}

function headingReactEventMatches(
  event: KeyboardEvent<HTMLButtonElement>,
  nativeEvent: globalThis.KeyboardEvent,
  snapshot: ToolbarKeyboardSnapshot,
  trigger: HTMLButtonElement,
): boolean {
  try {
    return (
      event.type === snapshot.type &&
      event.type === "keydown" &&
      event.nativeEvent === nativeEvent &&
      event.currentTarget === trigger &&
      event.target === trigger &&
      event.eventPhase === snapshot.eventPhase &&
      event.bubbles === snapshot.bubbles &&
      event.cancelable === snapshot.cancelable &&
      event.defaultPrevented === snapshot.defaultPrevented &&
      event.isDefaultPrevented() === snapshot.defaultPrevented &&
      event.isTrusted === snapshot.isTrusted &&
      event.key === snapshot.key &&
      event.code === snapshot.code &&
      event.location === snapshot.location &&
      event.altKey === snapshot.altKey &&
      event.ctrlKey === snapshot.ctrlKey &&
      event.metaKey === snapshot.metaKey &&
      event.shiftKey === snapshot.shiftKey &&
      event.repeat === snapshot.repeat &&
      Object.is(event.view, snapshot.view)
    );
  } catch {
    return false;
  }
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .filter(({ name }) => !isTransientToolbarAttribute(node, name))
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotToolbarDom(node: Node): ToolbarDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotToolbarDom)),
  });
}

function toolbarDomMatches(snapshot: ToolbarDomSnapshot): boolean {
  if (snapshot.node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = snapshotAttributes(snapshot.node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length ||
    attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || expected[0] !== name || expected[1] !== value;
    })
  ) {
    return false;
  }
  return (
    snapshot.node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        snapshot.node.childNodes.item(index) === child.node && toolbarDomMatches(child),
    )
  );
}

function captureToolbarPlacement(root: HTMLDivElement): ToolbarPlacement | null {
  const parent = root.parentNode;
  if (!parent) return null;
  const adjacentSibling = (
    start: Node | null,
    direction: "previousSibling" | "nextSibling",
  ) => {
    let sibling = start;
    while (
      sibling?.nodeType === 1 &&
      (sibling as Element).hasAttribute("data-radix-focus-guard")
    ) {
      sibling = sibling[direction];
    }
    return sibling;
  };
  return Object.freeze({
    document: root.ownerDocument,
    parent,
    previousSibling: adjacentSibling(root.previousSibling, "previousSibling"),
    nextSibling: adjacentSibling(root.nextSibling, "nextSibling"),
  });
}

function toolbarPlacementMatches(root: HTMLDivElement, placement: ToolbarPlacement): boolean {
  return (
    root.ownerDocument === placement.document &&
    root.parentNode === placement.parent &&
    root.previousSibling === placement.previousSibling &&
    root.nextSibling === placement.nextSibling
  );
}

function descendantsOf(element: HTMLElement): readonly Node[] {
  const nodes: Node[] = [];
  const collect = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) collect(child);
  };
  collect(element);
  return Object.freeze(nodes);
}

function isNodeFromDocument(value: EventTarget | null, ownerDocument: Document): value is Node {
  const NodeConstructor = ownerDocument.defaultView?.Node;
  return Boolean(
    NodeConstructor &&
      value instanceof NodeConstructor &&
      value.ownerDocument === ownerDocument,
  );
}

function isEffectivelyEnabled(element: HTMLElement): boolean {
  if (
    element.matches(":disabled") ||
    element.getAttribute("aria-disabled")?.toLowerCase() === "true"
  ) {
    return false;
  }
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (
      current.hasAttribute("inert") ||
      current.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function createToolbarPublication({
  mount,
  active,
  successorOf,
  replay,
  last,
  claimedEvents,
  claimedReactEvents,
  claimedHeadingPublications,
  focusedHeadings,
  pendingHeadingClose,
  headingState,
  setHeadingState,
  requestSuccessor,
  session,
  actions,
  format,
  canEdit,
  canUndo,
  canRedo,
  canComment,
  onComment,
  onImage,
  onTable,
}: {
  mount: object;
  active: CurrentCell<ToolbarPublication | null>;
  successorOf: CurrentCell<ToolbarPublication | null>;
  replay: CurrentCell<ToolbarReplay | null>;
  last: CurrentCell<HTMLButtonElement | null>;
  claimedEvents: WeakSet<Event>;
  claimedReactEvents: WeakSet<object>;
  claimedHeadingPublications: WeakSet<ToolbarPublication>;
  focusedHeadings: WeakSet<HeadingDisclosure>;
  pendingHeadingClose: CurrentCell<HeadingCloseVisit | null>;
  headingState: HeadingState;
  setHeadingState: Dispatch<SetStateAction<HeadingState>>;
  requestSuccessor: () => void;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  canEdit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canComment: boolean;
  onComment: () => void;
  onImage: () => void;
  onTable: () => void;
}): ToolbarPublication {
  const authority = Object.freeze({
    mount,
    session,
    actions,
    format,
    formatValues: Object.freeze({
      strong: format.strong,
      em: format.em,
      code: format.code,
      strike: format.strike,
      link: format.link,
      heading: format.heading,
      bullet: format.bullet,
      ordered: format.ordered,
      task: format.task,
      quote: format.quote,
      codeBlock: format.codeBlock,
      hasSelection: format.hasSelection,
      tablePos: format.tablePos,
      tableAlign: format.tableAlign,
    }),
    methods: Object.freeze({
      toggleMark: actions.toggleMark,
      openLinkDialog: actions.openLinkDialog,
      toggleCodeBlock: actions.toggleCodeBlock,
      toggleList: actions.toggleList,
      toggleQuote: actions.toggleQuote,
      horizontalRule: actions.horizontalRule,
      undo: actions.undo,
      redo: actions.redo,
      setHeading: actions.setHeading,
      focus: actions.focus,
    }),
    canEdit,
    canUndo,
    canRedo,
    canComment,
    onComment,
    onImage,
    onTable,
    headingState,
    headingOpen: headingState.open,
    headingDisclosure: headingState.disclosure,
    headingFocusPublished: headingState.disclosure
      ? focusedHeadings.has(headingState.disclosure)
      : false,
  });
  let retired = false;
  let established = false;
  let layoutRetired = false;
  let consumed = false;
  let successorRequested = false;
  let invalidReplay = false;
  let replayRefs: RefReplay[] = [];
  let stableOwners = new Set<ElementOwnerView>();
  let domSnapshot: ToolbarDomSnapshot | null = null;
  let placementSnapshot: ToolbarPlacement | null = null;
  let headingDomSnapshot: ToolbarDomSnapshot | null = null;
  let headingPlacementSnapshot: ToolbarPlacement | null = null;
  let domChanged = false;
  let domObserver: MutationObserver | null = null;
  let guardExpiryQueued = false;
  let headingFocusClaimed = false;
  let headingOpenChanged = false;
  let blockedRadixOpen: object | null = null;
  let headingKeyPublication: HeadingKeyPublication | null = null;
  let keyboard: ToolbarKeyboardIntrinsics | null = null;
  let establishmentDeferred = false;
  const claimed = new Set<symbol>();
  const headingKeyAction = Symbol("heading-key");
  const identity = new PublicationIdentity();
  const owners: ElementOwnerView[] = [];

  const onElementChange = (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    prior: HTMLElement | null,
  ) => {
    if (!established) {
      if (
        establishmentDeferred &&
        authority.headingOpen &&
        !successorRequested &&
        authorityOwned() &&
        exactHeadingStructure() &&
        buttonOrder.every((control) => control.element()?.isConnected)
      ) {
        successorRequested = true;
        requestSuccessor();
      }
      return;
    }
    const proof = replayRefs.find((entry) => entry.owner === owner);
    if (!proof) {
      invalidReplay = true;
      return;
    }
    if (
      element === null &&
      previous === proof.element &&
      proof.element.isConnected
    ) {
      proof.detached = true;
      proof.reattached = false;
    } else if (
      element === proof.element &&
      previous === null &&
      proof.detached &&
      proof.element.isConnected
    ) {
      proof.reattached = true;
    } else if (element !== previous) {
      invalidReplay = true;
    }
    if (
      stableOwners.has(owner) &&
      (element === null || (element !== null && prior !== null && element !== prior))
    ) {
      retire("element");
    }
    if (exactReplayReady()) requestReplaySuccessor();
  };
  const createOwner = <T extends HTMLElement>() => {
    const owner = new ElementOwner<T>(onElementChange);
    owners.push(owner);
    return owner;
  };
  const root = createOwner<HTMLDivElement>();
  const headingContent = createOwner<HTMLDivElement>();
  let lastHeadingContent: HTMLDivElement | null = null;
  const captureHeadingContent = (element: HTMLDivElement | null) => {
    if (element) lastHeadingContent = element;
    headingContent.capture(element);
  };

  const headingFocusFactsMatch = () => {
    const disclosure = authority.headingDisclosure;
    return disclosure
      ? focusedHeadings.has(disclosure) ===
          (authority.headingFocusPublished || headingFocusClaimed)
      : !authority.headingFocusPublished && !headingFocusClaimed;
  };
  const authorityOwned = () => {
    const values = authority.formatValues;
    const current = authority.format;
    return (
      Object.isFrozen(authority.headingState) &&
      authority.headingState.mount === mount &&
      authority.headingOpen === authority.headingState.open &&
      authority.headingDisclosure === authority.headingState.disclosure &&
      authority.headingOpen === Boolean(
        authority.headingOpen || authority.headingDisclosure,
      ) &&
      (!authority.headingDisclosure ||
        (Object.isFrozen(authority.headingDisclosure) &&
          authority.headingDisclosure.mount === mount &&
          (authority.headingDisclosure.destination === 0 ||
            authority.headingDisclosure.destination === 6) &&
          Object.isFrozen(authority.headingDisclosure.keyboard))) &&
      headingFocusFactsMatch() &&
      authority.session.canEdit === authority.canEdit &&
      authority.session.canUndo === authority.canUndo &&
      authority.session.canRedo === authority.canRedo &&
      authority.session.canComment === authority.canComment &&
      authority.methods.toggleMark === authority.actions.toggleMark &&
      authority.methods.openLinkDialog === authority.actions.openLinkDialog &&
      authority.methods.toggleCodeBlock === authority.actions.toggleCodeBlock &&
      authority.methods.toggleList === authority.actions.toggleList &&
      authority.methods.toggleQuote === authority.actions.toggleQuote &&
      authority.methods.horizontalRule === authority.actions.horizontalRule &&
      authority.methods.undo === authority.actions.undo &&
      authority.methods.redo === authority.actions.redo &&
      authority.methods.setHeading === authority.actions.setHeading &&
      authority.methods.focus === authority.actions.focus &&
      current.strong === values.strong &&
      current.em === values.em &&
      current.code === values.code &&
      current.strike === values.strike &&
      current.link === values.link &&
      current.heading === values.heading &&
      current.bullet === values.bullet &&
      current.ordered === values.ordered &&
      current.task === values.task &&
      current.quote === values.quote &&
      current.codeBlock === values.codeBlock &&
      current.hasSelection === values.hasSelection &&
      current.tablePos === values.tablePos &&
      current.tableAlign === values.tableAlign
    );
  };
  const permissionOwned = (permission: ToolbarPermission) => {
    switch (permission) {
      case "edit":
        return authority.canEdit && authority.session.canEdit;
      case "undo":
        return authority.canEdit && authority.canUndo && authority.session.canEdit && authority.session.canUndo;
      case "redo":
        return authority.canEdit && authority.canRedo && authority.session.canEdit && authority.session.canRedo;
      case "comment":
        return authority.canComment && authority.session.canComment;
      case "current":
        return true;
    }
  };
  const exactHeadingStructure = () => {
    const ownedRoot = root.element();
    const content = headingContent.element();
    const elements = headingItems.map(({ control }) => control.element());
    if (!content) {
      return !authority.headingOpen && elements.every((element) => element === null);
    }
    const placement = captureToolbarPlacement(content);
    const ordered = [
      ...content.querySelectorAll<HTMLElement>("[data-toolbar-heading]"),
    ];
    return Boolean(
      ownedRoot &&
        content.isConnected &&
        content.ownerDocument === ownedRoot.ownerDocument &&
        content.getAttribute("role") === "menu" &&
        content.dataset.toolbarHeadingContent === "" &&
        placement &&
        ordered.length === headingItems.length &&
        elements.every((element, index) => {
          const level = headingItems[index]?.level;
          return Boolean(
            element &&
              element.isConnected &&
              element.ownerDocument === ownedRoot.ownerDocument &&
              ordered[index] === element &&
              content.contains(element) &&
              element.getAttribute("role") === "menuitemradio" &&
              element.dataset.toolbarHeading === String(level) &&
              (authority.canEdit
                ? isEffectivelyEnabled(element)
                : element.getAttribute("aria-disabled")?.toLowerCase() === "true"),
          );
        }),
    );
  };
  const ownsControl = (control: OwnedToolbarControl, requireEnabled = true) => {
    if (
      retired ||
      active.current !== identity.current ||
      !authorityOwned() ||
      !publishedDomMatches()
    ) {
      return false;
    }
    const ownedRoot = root.element();
    const element = control.element();
    if (!ownedRoot || !element) return false;
    if (!ownedRoot.isConnected || !element.isConnected) return false;
    if (control.rootButton && !ownedRoot.contains(element)) return false;
    if (
      control === buttons.heading &&
      (element.tagName !== "BUTTON" ||
        (element as HTMLButtonElement).type !== "button" ||
        (element as HTMLButtonElement).disabled !== !authority.canEdit ||
        element.getAttribute("aria-label") !== "Text style" ||
        element.getAttribute("aria-haspopup") !== "menu" ||
        element.getAttribute("aria-expanded") !== String(authority.headingOpen) ||
        element.getAttribute("data-state") !==
          (authority.headingOpen ? "open" : "closed") ||
        (authority.headingOpen
          ? !element.getAttribute("aria-controls")
          : element.hasAttribute("aria-controls")))
    ) {
      return false;
    }
    if (!control.rootButton) {
      const content = headingContent.element();
      const itemIndex = headingItems.findIndex(({ control: item }) => item === control);
      const ordered = content
        ? [...content.querySelectorAll<HTMLElement>("[data-toolbar-heading]")]
        : [];
      if (
        !exactHeadingStructure() ||
        !content ||
        !content.isConnected ||
        content.ownerDocument !== ownedRoot.ownerDocument ||
        content.dataset.toolbarHeadingContent !== "" ||
        itemIndex < 0 ||
        ordered.length !== headingItems.length ||
        ordered[itemIndex] !== element ||
        !content.contains(element) ||
        element.getAttribute("role") !== "menuitemradio" ||
        element.dataset.toolbarHeading !== String(headingItems[itemIndex]?.level)
      ) {
        return false;
      }
    }
    if (
      requireEnabled &&
      (!control.enabled || !isEffectivelyEnabled(element))
    ) return false;
    return true;
  };
  const claimEvent = (event: Event) => {
    if (claimedEvents.has(event)) return false;
    claimedEvents.add(event);
    consumed = true;
    return true;
  };
  const claimHeadingKey = (
    captureEvent: object,
    event: object,
    nativeEvent: Event,
  ) => {
    const publication = identity.current;
    if (
      !publication ||
      captureEvent === event ||
      claimedHeadingPublications.has(publication) ||
      claimed.has(headingKeyAction) ||
      claimedReactEvents.has(captureEvent) ||
      claimedReactEvents.has(event) ||
      claimedEvents.has(nativeEvent)
    ) {
      return false;
    }
    claimedHeadingPublications.add(publication);
    claimed.add(headingKeyAction);
    claimedReactEvents.add(captureEvent);
    claimedReactEvents.add(event);
    claimedEvents.add(nativeEvent);
    consumed = true;
    return true;
  };
  const claim = (action: ToolbarAction, event: Event) => {
    if (
      !ownsControl(action.control, action.requireEnabled) ||
      !permissionOwned(action.permission) ||
      claimed.has(action.token) ||
      claimedEvents.has(event)
    ) {
      return false;
    }
    claimed.add(action.token);
    claimedEvents.add(event);
    consumed = true;
    return true;
  };
  const activate = (action: ToolbarAction, event: Event) => {
    if (!claim(action, event)) return;
    action.run();
  };
  const preventMouseDown = <T extends HTMLElement>(
    control: OwnedToolbarControl,
    event: MouseEvent<T>,
  ) => {
    const nativeEvent = exactMouseEvent(control, event, "mousedown");
    if (!nativeEvent || !ownsControl(control) || !claimEvent(nativeEvent)) return;
    event.preventDefault();
  };

  const makeControl = <T extends HTMLElement = HTMLButtonElement>({
    id,
    enabled,
    rootButton = true,
    permission = "current",
    requireEnabled = true,
    run,
  }: {
    id: string;
    enabled: boolean;
    rootButton?: boolean;
    permission?: ToolbarPermission;
    requireEnabled?: boolean;
    run?: () => void;
  }): ToolbarControl<T> => {
    const owner = createOwner<T>();
    let action: ToolbarAction | null = null;
    const control: ToolbarControl<T> = Object.freeze({
      id,
      enabled,
      rootButton,
      element: owner.element,
      capture: owner.capture,
      onClick: (event) => {
        if (!action) return;
        const nativeEvent = exactMouseEvent(control, event, "click");
        if (nativeEvent) activate(action, nativeEvent);
      },
      onMouseDown: (event) => preventMouseDown(control, event),
    });
    if (run) {
      action = Object.freeze({
        token: Symbol(id),
        control,
        permission,
        requireEnabled,
        run,
      });
    }
    return control;
  };

  const {
    toggleMark,
    openLinkDialog,
    toggleCodeBlock,
    toggleList,
    toggleQuote,
    horizontalRule,
    undo,
    redo,
    setHeading,
    focus,
  } = authority.methods;
  const buttons: ToolbarButtons = Object.freeze({
    heading: makeControl({ id: "heading", enabled: canEdit }),
    bold: makeControl({ id: "bold", enabled: canEdit, permission: "edit", run: () => toggleMark.call(actions, "strong") }),
    italic: makeControl({ id: "italic", enabled: canEdit, permission: "edit", run: () => toggleMark.call(actions, "em") }),
    strike: makeControl({ id: "strike", enabled: canEdit, permission: "edit", run: () => toggleMark.call(actions, "strike") }),
    link: makeControl({ id: "link", enabled: canEdit, permission: "edit", run: () => openLinkDialog.call(actions) }),
    code: makeControl({ id: "code", enabled: canEdit, permission: "edit", run: () => toggleMark.call(actions, "code") }),
    codeBlock: makeControl({ id: "code-block", enabled: canEdit, permission: "edit", run: () => toggleCodeBlock.call(actions) }),
    bullet: makeControl({ id: "bullet", enabled: canEdit, permission: "edit", run: () => toggleList.call(actions, "bullet") }),
    ordered: makeControl({ id: "ordered", enabled: canEdit, permission: "edit", run: () => toggleList.call(actions, "ordered") }),
    task: makeControl({ id: "task", enabled: canEdit, permission: "edit", run: () => toggleList.call(actions, "task") }),
    quote: makeControl({ id: "quote", enabled: canEdit, permission: "edit", run: () => toggleQuote.call(actions) }),
    image: makeControl({ id: "image", enabled: canEdit, permission: "edit", run: authority.onImage }),
    table: makeControl({ id: "table", enabled: canEdit, permission: "edit", run: authority.onTable }),
    rule: makeControl({ id: "rule", enabled: canEdit, permission: "edit", run: () => horizontalRule.call(actions) }),
    undo: makeControl({ id: "undo", enabled: canEdit && canUndo, permission: "undo", run: () => undo.call(actions) }),
    redo: makeControl({ id: "redo", enabled: canEdit && canRedo, permission: "redo", run: () => redo.call(actions) }),
    comment: makeControl({ id: "comment", enabled: canComment, permission: "comment", run: authority.onComment }),
  });
  const headingItems = Object.freeze(
    ([0, 1, 2, 3, 4, 5, 6] as const).map((level) => {
      const control = makeControl<HTMLDivElement>({
        id: `heading-${level}`,
        enabled: canEdit,
        rootButton: false,
        permission: "edit",
        run: () => setHeading.call(actions, level),
      });
      const action: ToolbarAction = Object.freeze({
        token: Symbol(`heading-${level}`),
        control,
        permission: "edit",
        requireEnabled: true,
        run: () => setHeading.call(actions, level),
      });
      return Object.freeze({
        level,
        control,
        onSelect: (event: Event) => {
          if (exactCustomEvent(event, control.element(), "menu.itemSelect")) {
            activate(action, event);
          }
        },
      });
    }),
  );
  const buttonOrder = Object.freeze([
    buttons.heading,
    buttons.bold,
    buttons.italic,
    buttons.strike,
    buttons.link,
    buttons.code,
    buttons.codeBlock,
    buttons.bullet,
    buttons.ordered,
    buttons.task,
    buttons.quote,
    buttons.image,
    buttons.table,
    buttons.rule,
    buttons.undo,
    buttons.redo,
    ...(canComment ? [buttons.comment] : []),
  ]);
  const closeAction: ToolbarAction = Object.freeze({
    token: Symbol("heading-close"),
    control: buttons.heading,
    permission: "current",
    requireEnabled: false,
    run: () => focus.call(actions),
  });

  const ownedButtons = () => {
    const ownedRoot = root.element();
    if (
      retired ||
      active.current !== identity.current ||
      !authorityOwned() ||
      !ownedRoot ||
      !ownedRoot.isConnected ||
      (established && !publishedDomMatches())
    ) {
      return null;
    }
    const owned: Array<{ control: ToolbarControl; element: HTMLButtonElement }> = [];
    for (const control of buttonOrder) {
      const element = control.element();
      if (!element || !element.isConnected || !ownedRoot.contains(element)) return null;
      owned.push({ control, element });
    }
    const domButtons = [...ownedRoot.querySelectorAll<HTMLButtonElement>("button")];
    if (
      domButtons.length !== owned.length ||
      owned.some(({ element }, index) => domButtons[index] !== element)
    ) {
      return null;
    }
    return owned;
  };
  const enabledButtons = () => {
    const owned = ownedButtons();
    return owned?.filter(({ control, element }) => control.enabled && !element.disabled) ?? [];
  };
  const mutationIsRelevant = (record: MutationRecord, allowTabStops = false) => {
    const ownedRoot =
      root.element() ??
      (domSnapshot?.node instanceof HTMLElement
        ? (domSnapshot.node as HTMLDivElement)
        : null);
    const content =
      headingContent.element() ??
      (headingDomSnapshot?.node instanceof HTMLElement
        ? (headingDomSnapshot.node as HTMLDivElement)
        : null);
    if (!ownedRoot) return true;
    if (
      record.type === "childList" &&
      [...record.addedNodes, ...record.removedNodes].every(
        (node) =>
          node.nodeType === 1 &&
          (node as Element).hasAttribute("data-radix-focus-guard"),
      )
    ) {
      return false;
    }
    if (
      record.type === "attributes" &&
      (isTransientToolbarAttribute(record.target, record.attributeName) ||
        (allowTabStops &&
          record.attributeName === "tabindex" &&
          buttonOrder.some((control) => control.element() === record.target)))
    ) {
      return false;
    }
    if (record.target === ownedRoot || ownedRoot.contains(record.target)) return true;
    if (content && (record.target === content || content.contains(record.target))) {
      return true;
    }
    if (
      record.type === "attributes" &&
      (record.attributeName === "disabled" ||
        record.attributeName === "inert" ||
        record.attributeName === "aria-disabled")
    ) {
      return record.target.contains(ownedRoot);
    }
    return (
      record.type === "childList" &&
      (record.target === placementSnapshot?.parent ||
        record.target === headingPlacementSnapshot?.parent)
    );
  };
  const recordMutations = (records: readonly MutationRecord[], allowTabStops = false) => {
    if (!domChanged && records.some((record) => mutationIsRelevant(record, allowTabStops))) {
      domChanged = true;
    }
    return domChanged;
  };
  const releaseReplayGuard = () => {
    if (!domObserver) return;
    recordMutations(domObserver.takeRecords());
    domObserver.disconnect();
    domObserver = null;
  };
  const publishedDomMatches = () => {
    if (domObserver) recordMutations(domObserver.takeRecords());
    const ownedRoot = root.element();
    const content = headingContent.element();
    const headingMatches = headingDomSnapshot
      ? Boolean(
          content &&
            headingPlacementSnapshot &&
            content === headingDomSnapshot.node &&
            content.isConnected &&
            toolbarPlacementMatches(content, headingPlacementSnapshot) &&
            toolbarDomMatches(headingDomSnapshot),
        )
      : !authority.headingOpen && content === null;
    return Boolean(
      !domChanged &&
        domSnapshot &&
        placementSnapshot &&
        ownedRoot &&
        ownedRoot === domSnapshot.node &&
        ownedRoot.isConnected &&
        toolbarPlacementMatches(ownedRoot, placementSnapshot) &&
        toolbarDomMatches(domSnapshot) &&
        headingMatches &&
        exactHeadingStructure(),
    );
  };
  const replayDomUnchanged = () => {
    if (!domObserver) return false;
    recordMutations(domObserver.takeRecords());
    return Boolean(
      !domChanged &&
        domSnapshot &&
        placementSnapshot &&
        domSnapshot.node.isConnected &&
        toolbarPlacementMatches(domSnapshot.node as HTMLDivElement, placementSnapshot) &&
        toolbarDomMatches(domSnapshot) &&
        (headingDomSnapshot
          ? Boolean(
              headingPlacementSnapshot &&
                headingDomSnapshot.node.isConnected &&
                toolbarPlacementMatches(
                  headingDomSnapshot.node as HTMLDivElement,
                  headingPlacementSnapshot,
                ) &&
                toolbarDomMatches(headingDomSnapshot),
            )
          : !authority.headingOpen),
    );
  };
  const syncTabStops = (commit = false) => {
    if (active.current !== identity.current || retired) return false;
    if (commit && !publishedDomMatches()) return false;
    const owned = ownedButtons();
    if (!owned) return false;
    const enabled = owned.filter(({ control, element }) => control.enabled && !element.disabled);
    const lastButton = last.current;
    const stop = enabled.find(({ element }) => element === lastButton)?.element ?? enabled[0]?.element;
    for (const { element } of owned) {
      element.tabIndex = element === stop ? 0 : -1;
    }
    if (commit && domObserver) {
      if (recordMutations(domObserver.takeRecords(), true)) {
        retire("element");
        return false;
      }
      const ownedRoot = root.element();
      if (!ownedRoot) return false;
      domSnapshot = snapshotToolbarDom(ownedRoot);
    }
    return true;
  };
  const exactReplayReady = () =>
    retired &&
    layoutRetired &&
    established &&
    !consumed &&
    !invalidReplay &&
    replayRefs.length > 0 &&
    replayRefs.every(
      (entry) =>
        entry.detached &&
        entry.reattached &&
        entry.owner.element() === entry.element,
    ) &&
    authorityOwned() &&
    replayDomUnchanged() &&
    successorOf.current === publication;
  type ToolbarAuthority = typeof authority;
  const editorAuthorityMatches = (
    previous: ToolbarAuthority,
    current: ToolbarAuthority,
  ) => {
    const left = previous.formatValues;
    const right = current.formatValues;
    return (
      previous.mount === current.mount &&
      previous.session === current.session &&
      previous.actions === current.actions &&
      previous.format === current.format &&
      previous.canEdit === current.canEdit &&
      previous.canUndo === current.canUndo &&
      previous.canRedo === current.canRedo &&
      previous.canComment === current.canComment &&
      previous.onComment === current.onComment &&
      previous.onImage === current.onImage &&
      previous.onTable === current.onTable &&
      previous.methods.toggleMark === current.methods.toggleMark &&
      previous.methods.openLinkDialog === current.methods.openLinkDialog &&
      previous.methods.toggleCodeBlock === current.methods.toggleCodeBlock &&
      previous.methods.toggleList === current.methods.toggleList &&
      previous.methods.toggleQuote === current.methods.toggleQuote &&
      previous.methods.horizontalRule === current.methods.horizontalRule &&
      previous.methods.undo === current.methods.undo &&
      previous.methods.redo === current.methods.redo &&
      previous.methods.setHeading === current.methods.setHeading &&
      previous.methods.focus === current.methods.focus &&
      left.strong === right.strong &&
      left.em === right.em &&
      left.code === right.code &&
      left.strike === right.strike &&
      left.link === right.link &&
      left.heading === right.heading &&
      left.bullet === right.bullet &&
      left.ordered === right.ordered &&
      left.task === right.task &&
      left.quote === right.quote &&
      left.codeBlock === right.codeBlock &&
      left.hasSelection === right.hasSelection &&
      left.tablePos === right.tablePos &&
      left.tableAlign === right.tableAlign
    );
  };
  const authorityMatches = (source: ToolbarPublication) => {
    const previous = (source as ToolbarPublication & { authority?: ToolbarAuthority }).authority;
    return Boolean(
      previous &&
        editorAuthorityMatches(previous, authority) &&
        previous.headingState === authority.headingState &&
        previous.headingOpen === authority.headingOpen &&
        previous.headingDisclosure === authority.headingDisclosure &&
        previous.headingFocusPublished === authority.headingFocusPublished,
    );
  };
  const focusHeadingDisclosure = () => {
    const disclosure = authority.headingDisclosure;
    if (!disclosure || authority.headingFocusPublished) return true;
    const destination = headingItems.find(
      ({ level }) => level === disclosure.destination,
    )?.control;
    const element = destination?.element();
    const disclosureKeyboard = disclosure?.keyboard;
    if (
      !keyboard ||
      !disclosureKeyboard ||
      !destination ||
      !element ||
      !authority.headingOpen ||
      !keyboard.isCurrent() ||
      !disclosureKeyboard.isCurrent() ||
      disclosureKeyboard.ownerWindow !== element.ownerDocument.defaultView ||
      !ownsControl(destination) ||
      focusedHeadings.has(disclosure)
    ) {
      return false;
    }
    focusedHeadings.add(disclosure);
    headingFocusClaimed = true;
    if (!disclosureKeyboard.isCurrent()) return false;
    disclosureKeyboard.apply(
      disclosureKeyboard.focus,
      element,
      [PREVENT_SCROLL],
    );
    return Boolean(
      disclosureKeyboard.isCurrent() &&
      disclosureKeyboard.apply(
        disclosureKeyboard.activeElement,
        element.ownerDocument,
        [],
      ) === element && ownsControl(destination),
    );
  };
  const requestReplaySuccessor = () => {
    if (
      successorRequested ||
      !domSnapshot ||
      !placementSnapshot ||
      !exactReplayReady()
    ) {
      return;
    }
    successorRequested = true;
    replay.current = Object.freeze({
      source: publication,
      dom: domSnapshot,
      placement: placementSnapshot,
      keyboard: keyboard!,
      unchanged: replayDomUnchanged,
      release: releaseReplayGuard,
    });
    requestSuccessor();
  };
  const establish = () => {
    if (established) {
      if (exactReplayReady()) requestReplaySuccessor();
      return undefined;
    }
    const ownedRoot = root.element();
    const ownerWindow = ownedRoot?.ownerDocument.defaultView;
    if (
      !authorityOwned() ||
      !ownedRoot ||
      !ownedRoot.isConnected ||
      !ownerWindow ||
      buttonOrder.some((control) => {
        const element = control.element();
        return !element || !element.isConnected || !ownedRoot.contains(element);
      })
    ) {
      return undefined;
    }
    if (!exactHeadingStructure()) {
      establishmentDeferred = authority.headingOpen;
      return undefined;
    }
    const placement = captureToolbarPlacement(ownedRoot);
    if (!placement) return undefined;
    const pendingReplay = replay.current;
    if (pendingReplay) {
      const sameAuthority = authorityMatches(pendingReplay.source);
      const exactReplay =
        sameAuthority &&
        pendingReplay.source.isRetired() &&
        successorOf.current === pendingReplay.source &&
        pendingReplay.keyboard.ownerWindow === ownerWindow &&
        pendingReplay.keyboard.isCurrent() &&
        pendingReplay.unchanged() &&
        pendingReplay.dom.node === ownedRoot &&
        toolbarPlacementMatches(ownedRoot, pendingReplay.placement) &&
        toolbarDomMatches(pendingReplay.dom);
      replay.current = null;
      pendingReplay.release();
      if (successorOf.current === pendingReplay.source) successorOf.current = null;
      if (sameAuthority && !exactReplay) return undefined;
      if (sameAuthority) keyboard = pendingReplay.keyboard;
    }
    keyboard ??= captureToolbarKeyboardIntrinsics(ownerWindow);
    if (!keyboard) return undefined;
    const previous = active.current;
    if (previous && previous !== publication) previous.retire();
    active.current = publication;
    if (!syncTabStops()) {
      active.current = null;
      return undefined;
    }
    established = true;
    stableOwners = new Set(owners.filter((owner) => owner.element()));
    replayRefs = [...stableOwners].map((owner) => ({
      owner,
      element: owner.element()!,
      detached: false,
      reattached: false,
    }));
    placementSnapshot = placement;
    domSnapshot = snapshotToolbarDom(ownedRoot);
    const content = headingContent.element();
    headingPlacementSnapshot = content
      ? captureToolbarPlacement(content)
      : null;
    headingDomSnapshot = content ? snapshotToolbarDom(content) : null;
    if (content && !headingPlacementSnapshot) {
      retire("other");
      return undefined;
    }
    const MutationObserverConstructor = ownedRoot.ownerDocument.defaultView?.MutationObserver;
    if (!MutationObserverConstructor) {
      retire("other");
      return undefined;
    }
    domObserver = new MutationObserverConstructor((records) => {
      if (recordMutations(records)) retire("element");
    });
    domObserver.observe(ownedRoot.ownerDocument, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    if (!focusHeadingDisclosure()) {
      retire("other");
      return undefined;
    }
    return retireForLayout;
  };
  const scheduleGuardExpiry = () => {
    if (guardExpiryQueued) return;
    guardExpiryQueued = true;
    queueMicrotask(() => {
      if (replay.current?.source === publication) return;
      if (domObserver) {
        recordMutations(domObserver.takeRecords());
        domChanged = true;
        domObserver.disconnect();
        domObserver = null;
      }
    });
  };
  const retire = (reason: "element" | "layout" | "other" = "other") => {
    if (retired) return false;
    if (domObserver) recordMutations(domObserver.takeRecords());
    retired = true;
    headingKeyPublication = null;
    const wasActive = active.current === publication;
    if (wasActive) {
      active.current = null;
      successorOf.current = publication;
    }
    if (reason === "other") releaseReplayGuard();
    else scheduleGuardExpiry();
    return wasActive;
  };
  const retireForLayout = () => {
    layoutRetired = true;
    retire("layout");
    scheduleGuardExpiry();
  };
  const exactMouseEvent = <T extends HTMLElement>(
    control: OwnedToolbarControl,
    event: MouseEvent<T>,
    type: "mousedown" | "click",
  ): globalThis.MouseEvent | null => {
    const ownedRoot = root.element();
    const element = control.element();
    const ownerWindow = ownedRoot?.ownerDocument.defaultView;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    if (
      !ownedRoot ||
      !element ||
      !ownerWindow ||
      event.type !== type ||
      event.button !== 0 ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== type ||
      nativeEvent.button !== 0 ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      event.currentTarget !== element ||
      nativeEvent.target !== target ||
      !isNodeFromDocument(target, ownedRoot.ownerDocument) ||
      !descendantsOf(element).includes(target) ||
      !nativeEvent.composedPath().includes(element) ||
      !nativeEvent.composedPath().includes(ownedRoot) ||
      event.defaultPrevented ||
      nativeEvent.defaultPrevented
    ) {
      return null;
    }
    return nativeEvent;
  };
  const exactCustomEvent = (
    event: Event,
    source: HTMLElement | null,
    type: "menu.itemSelect" | "focusScope.autoFocusOnUnmount",
  ) => {
    const ownedRoot = root.element();
    const ownerDocument = ownedRoot?.ownerDocument;
    return Boolean(
      ownerDocument &&
        source &&
        source.ownerDocument === ownerDocument &&
        exactCustomEventFromSource(event, source, type),
    );
  };
  const exactCustomEventFromSource = (
    event: Event,
    source: HTMLElement,
    type: "menu.itemSelect" | "focusScope.autoFocusOnUnmount",
  ) => {
    const ownerWindow = source.ownerDocument.defaultView;
    return Boolean(
      ownerWindow &&
        event instanceof ownerWindow.CustomEvent &&
        event.type === type &&
        event.eventPhase !== ownerWindow.Event.NONE &&
        event.currentTarget === source &&
        event.target === source &&
        (type !== "focusScope.autoFocusOnUnmount" ||
          source.dataset.toolbarHeadingContent === "") &&
        event.composedPath().includes(source) &&
        !event.defaultPrevented,
    );
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const ownedRoot = root.element();
    if (active.current !== identity.current || !ownedRoot || event.currentTarget !== ownedRoot) return;
    const ownerWindow = ownedRoot.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.FocusEvent) ||
      event.type !== "focus" ||
      nativeEvent.type !== "focusin" ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      nativeEvent.target !== target ||
      !isNodeFromDocument(target, ownedRoot.ownerDocument) ||
      !nativeEvent.composedPath().includes(ownedRoot) ||
      event.defaultPrevented ||
      nativeEvent.defaultPrevented
    ) {
      return;
    }
    const button = target instanceof ownerWindow.Element ? target.closest("button") : null;
    const owned = buttonOrder.find((control) => control.element() === button);
    if (!owned || !ownsControl(owned) || !claimEvent(nativeEvent)) return;
    last.current = button as HTMLButtonElement;
    syncTabStops(true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const ownedRoot = root.element();
    if (
      active.current !== identity.current ||
      !ownedRoot ||
      event.currentTarget !== ownedRoot ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) return;
    const items = enabledButtons();
    const current = items.findIndex(({ element }) => element === event.target);
    const next = rovingIndex(event.key, current, items.length, { orientation: "horizontal", wrap: true });
    const ownerWindow = ownedRoot.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      next < 0 ||
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.KeyboardEvent) ||
      event.type !== "keydown" ||
      nativeEvent.type !== "keydown" ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      nativeEvent.target !== target ||
      nativeEvent.key !== event.key ||
      nativeEvent.altKey !== event.altKey ||
      nativeEvent.ctrlKey !== event.ctrlKey ||
      nativeEvent.metaKey !== event.metaKey ||
      nativeEvent.shiftKey !== event.shiftKey ||
      !isNodeFromDocument(target, ownedRoot.ownerDocument) ||
      ownedRoot.ownerDocument.activeElement !== target ||
      !nativeEvent.composedPath().includes(ownedRoot) ||
      event.defaultPrevented ||
      nativeEvent.defaultPrevented ||
      !claimEvent(nativeEvent)
    ) {
      return;
    }
    event.preventDefault();
    items[next]?.element.focus();
  };
  const scheduleRadixOpenBlock = (event: object) => {
    blockedRadixOpen = event;
    queueMicrotask(() => {
      if (blockedRadixOpen === event) blockedRadixOpen = null;
    });
  };
  const onHeadingKeyCapture = (
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    headingKeyPublication = null;
    if (!event || typeof event !== "object") return;
    if (keyboard && !keyboard.isCurrent()) {
      retire("other");
      return;
    }
    const source = identity.current;
    const trigger = buttons.heading.element();
    const nativeEvent = event.nativeEvent;
    const snapshot =
      keyboard && nativeEvent
        ? readToolbarKeyboardEvent(nativeEvent, keyboard)
        : null;
    if (
      !source ||
      !keyboard ||
      !snapshot ||
      !trigger ||
      active.current !== source ||
      !ownsControl(buttons.heading) ||
      !headingReactEventMatches(event, nativeEvent, snapshot, trigger) ||
      snapshot.target !== trigger ||
      snapshot.currentTarget === null ||
      snapshot.eventPhase !== keyboard.capturingPhase ||
      !snapshot.bubbles ||
      !snapshot.cancelable ||
      snapshot.defaultPrevented ||
      snapshot.cancelBubble ||
      !snapshot.isTrusted ||
      (snapshot.key !== "ArrowDown" && snapshot.key !== "ArrowUp") ||
      snapshot.altKey ||
      snapshot.ctrlKey ||
      snapshot.metaKey ||
      snapshot.shiftKey ||
      snapshot.repeat ||
      snapshot.isComposing ||
      (snapshot.view !== null &&
        snapshot.view !== trigger.ownerDocument.defaultView) ||
      !snapshot.path.includes(snapshot.currentTarget) ||
      !toolbarKeyboardPathMatches(
        snapshot.path,
        trigger,
        trigger.ownerDocument,
        keyboard,
      ) ||
      keyboard.apply(
        keyboard.activeElement,
        trigger.ownerDocument,
        [],
      ) !== trigger ||
      !keyboard.isCurrent()
    ) {
      if (keyboard && !keyboard.isCurrent()) retire("other");
      return;
    }
    headingKeyPublication = Object.freeze({
      source,
      reactEvent: event,
      nativeEvent,
      snapshot,
    });
  };
  const onHeadingKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event || typeof event !== "object") return;
    if (event.key === "ArrowDown") {
      scheduleRadixOpenBlock(event);
    }
    const captured = headingKeyPublication;
    headingKeyPublication = null;
    if (keyboard && !keyboard.isCurrent()) {
      retire("other");
      return;
    }
    const trigger = buttons.heading.element();
    const nativeEvent = event.nativeEvent;
    const snapshot =
      keyboard && nativeEvent
        ? readToolbarKeyboardEvent(nativeEvent, keyboard)
        : null;
    const destination =
      snapshot?.key === "ArrowDown"
        ? headingItems[0]
        : snapshot?.key === "ArrowUp"
          ? headingItems.at(-1)
          : null;
    const destinationElement = destination?.control.element();
    const preventDefault = event.preventDefault;
    if (keyboard && !keyboard.isCurrent()) {
      retire("other");
      return;
    }
    if (
      !keyboard ||
      !snapshot ||
      !destination ||
      !trigger ||
      !captured ||
      captured.source !== identity.current ||
      captured.reactEvent === event ||
      captured.nativeEvent !== nativeEvent ||
      !toolbarKeyboardFactsMatch(captured.snapshot, snapshot) ||
      active.current !== identity.current ||
      !ownsControl(buttons.heading) ||
      (authority.headingOpen &&
        (!destinationElement ||
          !ownsControl(destination.control))) ||
      !headingReactEventMatches(event, nativeEvent, snapshot, trigger) ||
      snapshot.target !== trigger ||
      snapshot.currentTarget === null ||
      snapshot.eventPhase !== keyboard.bubblingPhase ||
      !snapshot.bubbles ||
      !snapshot.cancelable ||
      snapshot.defaultPrevented ||
      snapshot.cancelBubble ||
      !snapshot.isTrusted ||
      snapshot.altKey ||
      snapshot.ctrlKey ||
      snapshot.metaKey ||
      snapshot.shiftKey ||
      snapshot.repeat ||
      snapshot.isComposing ||
      (snapshot.view !== null &&
        snapshot.view !== trigger.ownerDocument.defaultView) ||
      !snapshot.path.includes(snapshot.currentTarget) ||
      !toolbarKeyboardPathMatches(
        snapshot.path,
        trigger,
        trigger.ownerDocument,
        keyboard,
      ) ||
      keyboard.apply(
        keyboard.activeElement,
        trigger.ownerDocument,
        [],
      ) !== trigger ||
      typeof preventDefault !== "function" ||
      !keyboard.isCurrent() ||
      !claimHeadingKey(captured.reactEvent, event, nativeEvent) ||
      !ownsControl(buttons.heading)
    ) {
      if (keyboard && !keyboard.isCurrent()) retire("other");
      return;
    }
    keyboard.apply(preventDefault, event, []);
    if (!keyboard.isCurrent()) {
      retire("other");
      return;
    }
    if (
      !event.defaultPrevented ||
      !keyboard.apply(
        keyboard.event.defaultPrevented,
        nativeEvent,
        [],
      ) ||
      keyboard.apply(
        keyboard.activeElement,
        trigger.ownerDocument,
        [],
      ) !== trigger ||
      !ownsControl(buttons.heading)
    ) {
      return;
    }
    blockedRadixOpen = null;
    const disclosure = Object.freeze({
      mount,
      destination: destination.level,
      keyboard,
    });
    const next = Object.freeze({
      mount,
      open: true,
      disclosure,
    });
    setHeadingState((current) =>
      current === authority.headingState ? next : current,
    );
  };
  const onHeadingOpenChange = (open: boolean) => {
    if (open && blockedRadixOpen) {
      blockedRadixOpen = null;
      return;
    }
    if (
      open === authority.headingOpen ||
      headingOpenChanged ||
      active.current !== identity.current ||
      !authorityOwned() ||
      !publishedDomMatches() ||
      !ownsControl(buttons.heading, !open)
    ) {
      return;
    }
    const content = headingContent.element() ?? lastHeadingContent;
    if (!open && content) {
      pendingHeadingClose.current = Object.freeze({
        source: publication,
        content,
      });
    } else if (open) {
      pendingHeadingClose.current = null;
    }
    headingOpenChanged = true;
    consumed = true;
    const next = Object.freeze({
      mount,
      open,
      disclosure: null,
    });
    setHeadingState((current) =>
      current === authority.headingState ? next : current,
    );
  };
  const onHeadingClose = (event: Event) => {
    const closeVisit = pendingHeadingClose.current;
    const current = active.current as
      | (ToolbarPublication & { authority?: ToolbarAuthority })
      | null;
    const sourceAuthority = closeVisit
      ? (closeVisit.source as ToolbarPublication & {
          authority?: ToolbarAuthority;
        }).authority
      : null;
    const currentAuthority = current?.authority;
    if (
      closeVisit &&
      sourceAuthority &&
      currentAuthority &&
      sourceAuthority.headingOpen &&
      !currentAuthority.headingOpen &&
      editorAuthorityMatches(sourceAuthority, currentAuthority) &&
      exactCustomEventFromSource(
        event,
        closeVisit.content,
        "focusScope.autoFocusOnUnmount",
      ) &&
      claimEvent(event)
    ) {
      pendingHeadingClose.current = null;
      event.preventDefault();
      sourceAuthority.methods.focus.call(sourceAuthority.actions);
      return;
    }
    const source = headingContent.element() ?? lastHeadingContent;
    if (
      !source ||
      !exactCustomEvent(event, source, "focusScope.autoFocusOnUnmount") ||
      !claim(closeAction, event)
    ) {
      return;
    }
    event.preventDefault();
    closeAction.run();
  };

  const publication = Object.freeze({
    authority,
    captureRoot: root.capture,
    captureHeadingContent,
    buttons,
    headingItems,
    establish,
    retire,
    isRetired: () => retired,
    onFocus,
    onKeyDown,
    onHeadingKeyCapture,
    onHeadingKeyDown,
    onHeadingOpenChange,
    onHeadingClose,
  } as ToolbarPublication & { authority: typeof authority });
  identity.current = publication;
  return publication;
}

function ToolButton({
  label,
  keys,
  active,
  disabled,
  control,
  children,
  testId,
}: {
  label: string;
  keys?: string;
  active?: boolean;
  disabled?: boolean;
  control: ToolbarControl;
  children: React.ReactNode;
  testId?: string;
}) {
  const { capture, onMouseDown, onClick } = control;
  return (
    <Tip label={label} shortcut={keys ? shortcut(keys) : undefined}>
      <button
        ref={capture}
        type="button"
        className="icon-btn"
        data-active={active ? "true" : undefined}
        disabled={disabled}
        onMouseDown={onMouseDown}
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        data-testid={testId}
      >
        {children}
      </button>
    </Tip>
  );
}

function Divider() {
  return <span className="tb-divider mx-1.5 h-6 w-px bg-line" aria-hidden />;
}

/** A run of related buttons. Plain inline flow today; the brand candidates draw it as a hairline pill. */
function Group({ children }: { children: React.ReactNode }) {
  return <span className="tb-group flex items-center gap-0.5">{children}</span>;
}

const HEADINGS = [
  { value: "0", label: "Paragraph", className: "text-[15px]" },
  { value: "1", label: "Heading 1", className: "text-[22px] font-bold" },
  { value: "2", label: "Heading 2", className: "text-[19px] font-bold" },
  { value: "3", label: "Heading 3", className: "text-[17px] font-semibold" },
  { value: "4", label: "Heading 4", className: "text-[15px] font-semibold" },
  { value: "5", label: "Heading 5", className: "text-[14px] font-semibold" },
  { value: "6", label: "Heading 6", className: "text-[13px] font-semibold" },
];

export const Toolbar = memo(function Toolbar({
  session,
  actions,
  format,
  onComment,
  onImage,
  onTable,
}: {
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  onComment: () => void;
  onImage: () => void;
  onTable: () => void;
}) {
  const { canEdit, canUndo, canRedo, canComment } = useSessionValue(
    session,
    (s) => ({
      canEdit: s.canEdit,
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      canComment: s.canComment,
    }),
    shallowEqual,
  );
  const dis = !canEdit;
  const [mount] = useState(() => Object.freeze({}));
  const [active] = useState(() => new CurrentCell<ToolbarPublication | null>(null));
  const [successorOf] = useState(() => new CurrentCell<ToolbarPublication | null>(null));
  const [replay] = useState(() => new CurrentCell<ToolbarReplay | null>(null));
  const [last] = useState(() => new CurrentCell<HTMLButtonElement | null>(null));
  const [claimedEvents] = useState(() => new WeakSet<Event>());
  const [claimedReactEvents] = useState(() => new WeakSet<object>());
  const [claimedHeadingPublications] = useState(
    () => new WeakSet<ToolbarPublication>(),
  );
  const [focusedHeadings] = useState(() => new WeakSet<HeadingDisclosure>());
  const [pendingHeadingClose] = useState(
    () => new CurrentCell<HeadingCloseVisit | null>(null),
  );
  const [headingState, setHeadingState] = useState<HeadingState>(() =>
    Object.freeze({ mount, open: false, disclosure: null }),
  );
  const [, setPublicationRevision] = useState(0);
  const requestSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const publication = createToolbarPublication({
    mount,
    active,
    successorOf,
    replay,
    last,
    claimedEvents,
    claimedReactEvents,
    claimedHeadingPublications,
    focusedHeadings,
    pendingHeadingClose,
    headingState,
    setHeadingState,
    requestSuccessor,
    session,
    actions,
    format,
    canEdit,
    canUndo,
    canRedo,
    canComment,
    onComment,
    onImage,
    onTable,
  });
  useLayoutEffect(() => publication.establish(), [publication]);
  const {
    captureRoot,
    captureHeadingContent,
    onFocus: onToolbarFocus,
    onKeyDown: onToolbarKeyDown,
    onHeadingKeyCapture,
    onHeadingKeyDown,
    onHeadingOpenChange,
    onHeadingClose,
    headingItems,
    buttons,
  } = publication;
  const {
    heading,
    bold,
    italic,
    strike,
    link,
    code,
    codeBlock,
    bullet,
    ordered,
    task,
    quote,
    image,
    table,
    rule,
    undo,
    redo,
    comment,
  } = buttons;
  const { capture: captureHeading, onMouseDown: onHeadingMouseDown } = heading;
  const {
    capture: captureComment,
    onMouseDown: onCommentMouseDown,
    onClick: onCommentClick,
  } = comment;

  return (
    <div
      ref={captureRoot}
      className={TOOLBAR_BOX}
      role="toolbar"
      aria-label="Formatting"
      aria-orientation="horizontal"
      data-testid="toolbar"
      onFocus={onToolbarFocus}
      onKeyDown={onToolbarKeyDown}
    >
      <Group>
        <Menu open={headingState.open} onOpenChange={onHeadingOpenChange}>
          <MenuTrigger asChild onKeyDown={onHeadingKeyDown}>
            <button
              ref={captureHeading}
              type="button"
              className="icon-btn w-auto gap-1 px-2.5 font-semibold"
              disabled={dis}
              onMouseDown={onHeadingMouseDown}
              onKeyDownCapture={onHeadingKeyCapture}
              aria-label="Text style"
              data-testid="heading-menu"
            >
              <Heading size={18} />
              {format.heading > 0 && <span className="text-xs text-accent">{format.heading}</span>}
              <ChevronDown size={14} className="text-ink-4" />
            </button>
          </MenuTrigger>
          <MenuContent
            ref={captureHeadingContent}
            align="start"
            className="w-56"
            data-toolbar-heading-content=""
            // Radix hands focus back to the trigger when the menu closes; the caret belongs in the editor
            // the moment a style is picked (task #437: Ctrl+Z and typing went to the toolbar button).
            onCloseAutoFocus={onHeadingClose}
          >
            <MenuRadioGroup value={String(format.heading)}>
              {HEADINGS.map((h, index) => (
                <MenuRadioItem
                  ref={headingItems[index].control.capture}
                  key={h.value}
                  value={h.value}
                  className={h.className}
                  disabled={dis}
                  data-toolbar-heading={h.value}
                  onSelect={headingItems[index].onSelect}
                >
                  {h.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Bold" keys="Mod-B" active={format.strong} disabled={dis} control={bold} testId="tb-bold">
          <Bold size={18} strokeWidth={2.6} />
        </ToolButton>
        <ToolButton label="Italic" keys="Mod-I" active={format.em} disabled={dis} control={italic} testId="tb-italic">
          <Italic size={18} />
        </ToolButton>
        <ToolButton label="Strikethrough" keys="Mod-Shift-X" active={format.strike} disabled={dis} control={strike}>
          <Strikethrough size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Link" keys="Mod-K" active={format.link} disabled={dis} control={link} testId="tb-link">
          <LinkIcon size={18} />
        </ToolButton>
        <ToolButton label="Inline code" keys="Mod-`" active={format.code} disabled={dis} control={code} testId="tb-code">
          <Code size={18} />
        </ToolButton>
        <ToolButton label="Code block" keys="Mod-Alt-C" active={format.codeBlock} disabled={dis} control={codeBlock}>
          <SquareCode size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Bulleted list" keys="Mod-Shift-8" active={format.bullet} disabled={dis} control={bullet} testId="tb-bullet">
          <List size={18} />
        </ToolButton>
        <ToolButton label="Numbered list" keys="Mod-Shift-7" active={format.ordered} disabled={dis} control={ordered} testId="tb-ordered">
          <ListOrdered size={18} />
        </ToolButton>
        <ToolButton label="Task list" keys="Mod-Shift-9" active={format.task} disabled={dis} control={task} testId="tb-task">
          <ListChecks size={18} />
        </ToolButton>
        <ToolButton label="Quote" keys="Mod-Shift-." active={format.quote} disabled={dis} control={quote}>
          <Quote size={18} />
        </ToolButton>
        <ToolButton label="Image" disabled={dis} control={image} testId="tb-image">
          <ImageIcon size={18} />
        </ToolButton>
        <ToolButton label="Table" disabled={dis} control={table} testId="tb-table">
          <Table size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Horizontal rule" disabled={dis} control={rule}>
          <Minus size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Undo" keys="Mod-Z" disabled={!canEdit || !canUndo} control={undo} testId="tb-undo">
          <Undo2 size={18} />
        </ToolButton>
        <ToolButton label="Redo" keys="Mod-Shift-Z" disabled={!canEdit || !canRedo} control={redo} testId="tb-redo">
          <Redo2 size={18} />
        </ToolButton>
      </Group>
      <div className="flex-1" />
      {canComment && (
        <Tip label="Add comment" shortcut={shortcut("Mod-Alt-M")}>
          <button
            ref={captureComment}
            type="button"
            className={cn("btn btn-sm gap-1.5", format.hasSelection ? "btn-outline text-ink" : "btn-ghost text-ink-3")}
            onMouseDown={onCommentMouseDown}
            onClick={onCommentClick}
            data-testid="tb-comment"
          >
            <MessageSquarePlus size={16} />
            Comment
          </button>
        </Tip>
      )}
    </div>
  );
});
