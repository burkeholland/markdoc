"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefCallback,
} from "react";
import { createPortal } from "react-dom";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { Bold, Italic, Code, Link as LinkIcon, MessageSquarePlus, Strikethrough } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { EditorActions, FormatState } from "./actions";
import { cn } from "@/lib/utils";
import type { Box, Insets } from "@/lib/viewport";
import { isCoarsePointer } from "@/lib/viewport-hooks";
import {
  placeSelectionBubble,
  selectionBubbleLayerPosition,
  selectionBubbleBounds,
  selectionClientBox,
  selectionIntersectsBounds,
  SELECTION_BUBBLE_ARROW_SIZE,
  type SelectionBubblePosition,
  type VisualViewportBox,
} from "./selection-bubble-geometry";

const cssPixels = (style: CSSStyleDeclaration, property: string): number => {
  const value = Number.parseFloat(style.getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
};

const clientBox = ({ left, top, width, height }: Pick<DOMRect, "left" | "top" | "width" | "height">): Box => ({ left, top, width, height });
const caretBox = ({ left, right, top, bottom }: Pick<DOMRect, "left" | "right" | "top" | "bottom">): Box => ({
  left,
  top,
  width: Math.max(0, right - left),
  height: Math.max(0, bottom - top),
});

function safeAreaInsets(): Insets {
  const style = getComputedStyle(document.documentElement);
  return {
    top: cssPixels(style, "--safe-area-inset-top"),
    right: cssPixels(style, "--safe-area-inset-right"),
    bottom: cssPixels(style, "--safe-area-inset-bottom"),
    left: cssPixels(style, "--safe-area-inset-left"),
  };
}

interface BubbleGeometry {
  owner: BubbleOwner;
  authority: BubbleActionAuthority;
  layer: HTMLDivElement;
  position: SelectionBubblePosition;
  placement: NonNullable<ReturnType<typeof selectionBubbleLayerPosition>>;
}

interface BubbleOwner {
  view: EditorView;
  editor: HTMLElement;
  scroller: HTMLElement;
  session: CollabSession;
  schedule: () => void;
  dispose: () => void;
}

interface BubbleActionAuthority {
  owner: BubbleOwner;
  view: EditorView;
  session: CollabSession;
  actions: EditorActions;
  onLink: () => void;
  onComment: () => void;
}

type BubbleControlPermission = "edit" | "comment";
type BubbleMark = Parameters<EditorActions["toggleMark"]>[0];

interface BubbleControlFacts {
  mount: symbol;
  geometry: BubbleGeometry;
  owner: BubbleOwner;
  authority: BubbleActionAuthority;
  view: EditorView;
  editor: HTMLElement;
  scroller: HTMLElement;
  session: CollabSession;
  activeSurface: CollabSession["activeSurface"] | null;
  actions: EditorActions;
  toggleMark: EditorActions["toggleMark"];
  format: FormatState;
  formatValues: Readonly<Pick<FormatState, "strong" | "em" | "strike" | "code" | "link">>;
  canEdit: boolean;
  canComment: boolean;
  onLink: () => void;
  onComment: () => void;
  editorState: EditorView["state"];
  selection: EditorView["state"]["selection"];
  selectionAnchor: number;
  selectionHead: number;
  rovingIndex: number;
  setRovingIndex: (index: number) => void;
  isCurrent: (publication: BubbleControlPublication) => boolean;
}

interface BubbleControlPublication {
  identity: symbol;
  retired: boolean;
  generation: BubbleControlGeneration;
  facts: Readonly<BubbleControlFacts>;
  bubbleBinding: BubbleElementBinding<HTMLDivElement>;
  rootBinding: BubbleElementBinding<HTMLDivElement>;
  controlBindings: ReadonlyMap<BubbleControl, BubbleElementBinding<HTMLButtonElement>>;
  topology: BubbleControlTopology;
  mouseEvents: WeakSet<object>;
  mouseEventSeen: boolean;
  claimed: Set<BubbleControl>;
  mutationObserver: MutationObserver | null;
  mutated: boolean;
  keyboardAuthority: BubbleKeyboardAuthority;
  controlPaths: ReadonlyMap<BubbleControl, readonly EventTarget[]>;
  keyboardListeners: readonly BubbleKeyboardListener[];
  keyboardDelivery: BubbleKeyboardDelivery | null;
  reactCapture: BubbleReactCapture | null;
  keyboardEventSeen: boolean;
}

interface BubbleControl {
  identity: symbol;
  generation: BubbleControlGeneration;
  permission: BubbleControlPermission;
  enabled: boolean;
  binding: BubbleElementBinding<HTMLButtonElement> | null;
  captureButton: RefCallback<HTMLButtonElement>;
  invoke: () => void;
  index: number;
  tabStop: boolean;
}

interface BubbleControls {
  bold: BubbleControl;
  italic: BubbleControl;
  strike: BubbleControl;
  code: BubbleControl;
  link: BubbleControl;
  comment: BubbleControl;
}

type BubbleContainerRole = "bubble" | "root";

interface BubbleControlGeneration {
  identity: symbol;
  facts: Readonly<BubbleControlFacts>;
  bubbleBinding: BubbleElementBinding<HTMLDivElement> | null;
  rootBinding: BubbleElementBinding<HTMLDivElement> | null;
  controls: readonly BubbleControl[];
}

interface BubbleElementBinding<T extends HTMLElement> {
  identity: symbol;
  generation: BubbleControlGeneration;
  role: BubbleContainerRole | "control";
  control: BubbleControl | null;
  element: T;
  active: boolean;
}

interface BubbleControlTopology {
  nodes: readonly Node[];
  markup: string;
  layerParent: Node | null;
}

interface BubbleElementOwner {
  generation: BubbleControlGeneration;
  generationIdentity: symbol;
  binding: BubbleElementBinding<HTMLElement>;
  bindingIdentity: symbol;
}

interface BubbleControlReplay {
  publication: BubbleControlPublication;
  generation: BubbleControlGeneration;
  expectedBindings: ReadonlySet<BubbleElementBinding<HTMLElement>>;
  released: Set<BubbleElementBinding<HTMLElement>>;
  rebound: Map<BubbleElementBinding<HTMLElement>, BubbleElementBinding<HTMLElement>>;
  invalid: boolean;
}

type BubbleEventField =
  | "type"
  | "target"
  | "currentTarget"
  | "eventPhase"
  | "bubbles"
  | "cancelable"
  | "defaultPrevented"
  | "cancelBubble"
  | "composed"
  | "timeStamp";
type BubbleKeyboardField =
  | "key"
  | "code"
  | "location"
  | "repeat"
  | "isComposing"
  | "ctrlKey"
  | "shiftKey"
  | "altKey"
  | "metaKey";
type BubbleNativeGetter = (this: object) => unknown;
type BubbleNativeMethod = (...args: never[]) => unknown;

interface BubbleDescriptorAuthority {
  readonly isCurrent: () => boolean;
}

interface BubbleGetterAuthority<Field extends string> {
  readonly getters: Readonly<Record<Field, BubbleNativeGetter>>;
  readonly isCurrent: () => boolean;
}

interface BubbleMethodAuthority<Method extends BubbleNativeMethod> {
  readonly method: Method;
  readonly isCurrent: () => boolean;
}

interface BubbleTrustAuthority {
  readonly getter: BubbleNativeGetter;
  readonly matches: (event: object) => boolean;
  readonly read: (event: object) => unknown;
  readonly isCurrent: () => boolean;
}

interface BubbleKeyboardAuthority {
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly Event: typeof Event;
  readonly UIEvent: typeof UIEvent;
  readonly KeyboardEvent: typeof KeyboardEvent;
  readonly event: Readonly<Record<BubbleEventField, BubbleNativeGetter>>;
  readonly keyboard: Readonly<Record<BubbleKeyboardField, BubbleNativeGetter>>;
  readonly ui: Readonly<Record<"detail" | "view", BubbleNativeGetter>>;
  readonly document: Readonly<Record<"activeElement", BubbleNativeGetter>>;
  readonly composedPath: Event["composedPath"];
  readonly preventDefault: Event["preventDefault"];
  readonly stopPropagation: Event["stopPropagation"];
  readonly stopImmediatePropagation: Event["stopImmediatePropagation"];
  readonly focus: HTMLElement["focus"];
  readonly addEventListener: EventTarget["addEventListener"];
  readonly removeEventListener: EventTarget["removeEventListener"];
  readonly apply: typeof Reflect.apply;
  readonly defineProperty: typeof Reflect.defineProperty;
  readonly getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor;
  readonly getPrototypeOf: typeof Object.getPrototypeOf;
  readonly trust: BubbleTrustAuthority;
  readonly historyIsClean: () => boolean;
}

interface BubbleKeyboardSnapshot {
  readonly event: KeyboardEvent;
  readonly publication: BubbleControlPublication;
  readonly sourceControl: BubbleControl;
  readonly destinationControl: BubbleControl;
  readonly source: HTMLButtonElement;
  readonly destination: HTMLButtonElement;
  readonly path: readonly EventTarget[];
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly composed: boolean;
  readonly timeStamp: number;
  readonly detail: number;
  readonly view: Window | null;
  readonly trustGetter: BubbleNativeGetter;
  readonly propagationStopped: () => boolean;
}

interface BubbleReactSnapshot {
  readonly event: object;
  readonly descriptors: ReadonlyMap<PropertyKey, PropertyDescriptor>;
  readonly methods: ReadonlyMap<PropertyKey, unknown>;
}

interface BubbleReactCapture {
  readonly event: object;
  readonly nativeEvent: KeyboardEvent;
  readonly sourceControl: BubbleControl;
  readonly source: HTMLButtonElement;
  readonly methods: ReadonlyMap<PropertyKey, unknown>;
}

interface BubbleKeyboardDelivery {
  readonly snapshot: BubbleKeyboardSnapshot;
  react: BubbleReactSnapshot | null;
  buttonSeen: number;
  rootSeen: number;
  invalid: boolean;
}

interface BubbleKeyboardListener {
  readonly target: EventTarget;
  readonly listener: EventListener;
  readonly capture: boolean;
}

const BUBBLE_PREVENT_SCROLL = Object.freeze({ preventScroll: true });
const BUBBLE_REACT_FIELDS = Object.freeze([
  "nativeEvent",
  "type",
  "target",
  "currentTarget",
  "eventPhase",
  "bubbles",
  "cancelable",
  "defaultPrevented",
  "isTrusted",
  "timeStamp",
  "key",
  "code",
  "location",
  "repeat",
  "ctrlKey",
  "shiftKey",
  "altKey",
  "metaKey",
  "view",
  "detail",
] as const);
const BUBBLE_REACT_METHODS = Object.freeze([
  "preventDefault",
  "stopPropagation",
  "isDefaultPrevented",
  "isPropagationStopped",
  "persist",
] as const);

function bubbleDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  return Boolean(
    current &&
      current.configurable === expected.configurable &&
      current.enumerable === expected.enumerable &&
      current.writable === expected.writable &&
      current.value === expected.value &&
      current.get === expected.get &&
      current.set === expected.set,
  );
}

function captureBubbleDescriptor(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  owner: object,
  property: PropertyKey,
): BubbleDescriptorAuthority | null {
  const descriptor = getOwnPropertyDescriptor(owner, property);
  if (!descriptor) return null;
  const expected = Object.freeze({ ...descriptor });
  return Object.freeze({
    isCurrent: () =>
      bubbleDescriptorsMatch(
        getOwnPropertyDescriptor(owner, property),
        expected,
      ),
  });
}

function captureBubbleGetters<const Field extends string>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  getPrototypeOf: typeof Object.getPrototypeOf,
  prototype: object | null,
  fields: readonly Field[],
): BubbleGetterAuthority<Field> | null {
  const getters = Object.create(null) as Record<Field, BubbleNativeGetter>;
  const descriptors: {
    owner: object;
    property: Field;
    descriptor: PropertyDescriptor;
  }[] = [];
  for (const property of fields) {
    let owner = prototype;
    let descriptor: PropertyDescriptor | undefined;
    while (owner && !descriptor) {
      descriptor = getOwnPropertyDescriptor(owner, property);
      if (!descriptor) owner = getPrototypeOf(owner);
    }
    if (!owner || !descriptor || typeof descriptor.get !== "function") {
      return null;
    }
    getters[property] = descriptor.get;
    descriptors.push({
      owner,
      property,
      descriptor: Object.freeze({ ...descriptor }),
    });
  }
  return Object.freeze({
    getters: Object.freeze(getters),
    isCurrent: () =>
      descriptors.every(({ owner, property, descriptor }) =>
        bubbleDescriptorsMatch(
          getOwnPropertyDescriptor(owner, property),
          descriptor,
        ),
      ),
  });
}

function captureBubbleMethod<Method extends BubbleNativeMethod>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  getPrototypeOf: typeof Object.getPrototypeOf,
  prototype: object | null,
  property: PropertyKey,
): BubbleMethodAuthority<Method> | null {
  let owner = prototype;
  let descriptor: PropertyDescriptor | undefined;
  while (owner && !descriptor) {
    descriptor = getOwnPropertyDescriptor(owner, property);
    if (!descriptor) owner = getPrototypeOf(owner);
  }
  if (
    !owner ||
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  return Object.freeze({
    method: descriptor.value as Method,
    isCurrent: () =>
      bubbleDescriptorsMatch(
        getOwnPropertyDescriptor(owner, property),
        expected,
      ),
  });
}

function captureBubbleTrust(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
  probe: KeyboardEvent,
): BubbleTrustAuthority | null {
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    !descriptor ||
    descriptor.configurable !== false ||
    descriptor.enumerable !== true ||
    typeof descriptor.get !== "function" ||
    descriptor.set !== undefined ||
    "value" in descriptor ||
    "writable" in descriptor
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const matches = (event: object) =>
    bubbleDescriptorsMatch(
      getOwnPropertyDescriptor(event, "isTrusted"),
      expected,
    );
  return Object.freeze({
    getter: descriptor.get,
    matches,
    read: (event: object) => apply(descriptor.get as BubbleNativeGetter, event, []),
    isCurrent: () => matches(probe),
  });
}

function captureBubbleKeyboardAuthority(
  ownerDocument: Document,
): BubbleKeyboardAuthority | null {
  const ownerWindow = ownerDocument.defaultView as
    | (Window & typeof globalThis)
    | null;
  if (!ownerWindow) return null;
  const getOwnPropertyDescriptor =
    ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const construct = ownerWindow.Reflect.construct;
  const defineProperty = ownerWindow.Reflect.defineProperty;
  const EventConstructor = ownerWindow.Event;
  const UIEventConstructor = ownerWindow.UIEvent;
  const KeyboardEventConstructor = ownerWindow.KeyboardEvent;
  const DocumentConstructor = ownerWindow.Document;
  const HTMLElementConstructor = ownerWindow.HTMLElement;
  const EventTargetConstructor = ownerWindow.EventTarget;
  const eventPrototype = EventConstructor.prototype;
  const uiPrototype = UIEventConstructor.prototype;
  const keyboardPrototype = KeyboardEventConstructor.prototype;
  const documentPrototype = DocumentConstructor.prototype;
  const htmlElementPrototype = HTMLElementConstructor.prototype;
  const eventTargetPrototype = EventTargetConstructor.prototype;
  const event = captureBubbleGetters(
    getOwnPropertyDescriptor,
    getPrototypeOf,
    eventPrototype,
    [
      "type",
      "target",
      "currentTarget",
      "eventPhase",
      "bubbles",
      "cancelable",
      "defaultPrevented",
      "cancelBubble",
      "composed",
      "timeStamp",
    ] as const,
  );
  const keyboard = captureBubbleGetters(
    getOwnPropertyDescriptor,
    getPrototypeOf,
    keyboardPrototype,
    [
      "key",
      "code",
      "location",
      "repeat",
      "isComposing",
      "ctrlKey",
      "shiftKey",
      "altKey",
      "metaKey",
    ] as const,
  );
  const ui = captureBubbleGetters(
    getOwnPropertyDescriptor,
    getPrototypeOf,
    uiPrototype,
    ["detail", "view"] as const,
  );
  const document = captureBubbleGetters(
    getOwnPropertyDescriptor,
    getPrototypeOf,
    documentPrototype,
    ["activeElement"] as const,
  );
  const composedPath = captureBubbleMethod<Event["composedPath"]>(
    getOwnPropertyDescriptor,
    getPrototypeOf,
    eventPrototype,
    "composedPath",
  );
  const preventDefault = captureBubbleMethod<Event["preventDefault"]>(
    getOwnPropertyDescriptor,
    getPrototypeOf,
    eventPrototype,
    "preventDefault",
  );
  const stopPropagation = captureBubbleMethod<Event["stopPropagation"]>(
    getOwnPropertyDescriptor,
    getPrototypeOf,
    eventPrototype,
    "stopPropagation",
  );
  const stopImmediatePropagation =
    captureBubbleMethod<Event["stopImmediatePropagation"]>(
      getOwnPropertyDescriptor,
      getPrototypeOf,
      eventPrototype,
      "stopImmediatePropagation",
    );
  const focus = captureBubbleMethod<HTMLElement["focus"]>(
    getOwnPropertyDescriptor,
    getPrototypeOf,
    htmlElementPrototype,
    "focus",
  );
  const addEventListener =
    captureBubbleMethod<EventTarget["addEventListener"]>(
      getOwnPropertyDescriptor,
      getPrototypeOf,
      eventTargetPrototype,
      "addEventListener",
    );
  const removeEventListener =
    captureBubbleMethod<EventTarget["removeEventListener"]>(
      getOwnPropertyDescriptor,
      getPrototypeOf,
      eventTargetPrototype,
      "removeEventListener",
    );
  const realmDescriptors = [
    captureBubbleDescriptor(
      getOwnPropertyDescriptor,
      EventConstructor,
      "prototype",
    ),
    captureBubbleDescriptor(
      getOwnPropertyDescriptor,
      UIEventConstructor,
      "prototype",
    ),
    captureBubbleDescriptor(
      getOwnPropertyDescriptor,
      KeyboardEventConstructor,
      "prototype",
    ),
    captureBubbleDescriptor(
      getOwnPropertyDescriptor,
      DocumentConstructor,
      "prototype",
    ),
    captureBubbleDescriptor(
      getOwnPropertyDescriptor,
      HTMLElementConstructor,
      "prototype",
    ),
    captureBubbleDescriptor(
      getOwnPropertyDescriptor,
      eventPrototype,
      "constructor",
    ),
    captureBubbleDescriptor(
      getOwnPropertyDescriptor,
      uiPrototype,
      "constructor",
    ),
    captureBubbleDescriptor(
      getOwnPropertyDescriptor,
      keyboardPrototype,
      "constructor",
    ),
    captureBubbleDescriptor(
      getOwnPropertyDescriptor,
      documentPrototype,
      "constructor",
    ),
    captureBubbleDescriptor(
      getOwnPropertyDescriptor,
      htmlElementPrototype,
      "constructor",
    ),
  ];
  if (
    !event ||
    !keyboard ||
    !ui ||
    !document ||
    !composedPath ||
    !preventDefault ||
    !stopPropagation ||
    !stopImmediatePropagation ||
    !focus ||
    !addEventListener ||
    !removeEventListener ||
    realmDescriptors.some((descriptor) => !descriptor)
  ) {
    return null;
  }
  let probe: KeyboardEvent;
  try {
    probe = apply(construct, ownerWindow.Reflect, [
      KeyboardEventConstructor,
      ["selection-bubble-keyboard-intrinsic"],
      KeyboardEventConstructor,
    ]) as KeyboardEvent;
  } catch {
    return null;
  }
  const trust = captureBubbleTrust(getOwnPropertyDescriptor, apply, probe);
  if (
    !trust ||
    getPrototypeOf(probe) !== keyboardPrototype ||
    trust.read(probe) !== false
  ) {
    return null;
  }
  let historyIsClean = true;
  const checkHistory = () => {
    if (!historyIsClean) return false;
    historyIsClean =
      ownerDocument.defaultView === ownerWindow &&
      ownerWindow.Object.getOwnPropertyDescriptor ===
        getOwnPropertyDescriptor &&
      ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
      ownerWindow.Reflect.apply === apply &&
      ownerWindow.Reflect.construct === construct &&
      ownerWindow.Reflect.defineProperty === defineProperty &&
      ownerWindow.Event === EventConstructor &&
      ownerWindow.UIEvent === UIEventConstructor &&
      ownerWindow.KeyboardEvent === KeyboardEventConstructor &&
      ownerWindow.Document === DocumentConstructor &&
      ownerWindow.HTMLElement === HTMLElementConstructor &&
      ownerWindow.EventTarget === EventTargetConstructor &&
      EventConstructor.prototype === eventPrototype &&
      UIEventConstructor.prototype === uiPrototype &&
      KeyboardEventConstructor.prototype === keyboardPrototype &&
      DocumentConstructor.prototype === documentPrototype &&
      HTMLElementConstructor.prototype === htmlElementPrototype &&
      EventTargetConstructor.prototype === eventTargetPrototype &&
      getPrototypeOf(keyboardPrototype) === uiPrototype &&
      getPrototypeOf(uiPrototype) === eventPrototype &&
      event.isCurrent() &&
      keyboard.isCurrent() &&
      ui.isCurrent() &&
      document.isCurrent() &&
      composedPath.isCurrent() &&
      preventDefault.isCurrent() &&
      stopPropagation.isCurrent() &&
      stopImmediatePropagation.isCurrent() &&
      focus.isCurrent() &&
      addEventListener.isCurrent() &&
      removeEventListener.isCurrent() &&
      trust.isCurrent() &&
      realmDescriptors.every(
        (descriptor) => descriptor?.isCurrent() === true,
      );
    return historyIsClean;
  };
  return Object.freeze({
    ownerDocument,
    ownerWindow,
    Event: EventConstructor,
    UIEvent: UIEventConstructor,
    KeyboardEvent: KeyboardEventConstructor,
    event: event.getters,
    keyboard: keyboard.getters,
    ui: ui.getters,
    document: document.getters,
    composedPath: composedPath.method,
    preventDefault: preventDefault.method,
    stopPropagation: stopPropagation.method,
    stopImmediatePropagation: stopImmediatePropagation.method,
    focus: focus.method,
    addEventListener: addEventListener.method,
    removeEventListener: removeEventListener.method,
    apply,
    defineProperty,
    getOwnPropertyDescriptor,
    getPrototypeOf,
    trust,
    historyIsClean: checkHistory,
  });
}

function bubbleNativeValue<Value>(
  authority: BubbleKeyboardAuthority,
  getter: BubbleNativeGetter,
  event: Event,
): Value {
  return authority.apply(getter, event, []) as Value;
}

function bubbleActiveElement(authority: BubbleKeyboardAuthority) {
  return authority.apply(
    authority.document.activeElement,
    authority.ownerDocument,
    [],
  ) as Element | null;
}

function bubbleEventPath(
  authority: BubbleKeyboardAuthority,
  event: Event,
) {
  return authority.apply(authority.composedPath, event, []) as EventTarget[];
}

function bubbleControlPath(
  ownerDocument: Document,
  element: HTMLElement,
): readonly EventTarget[] | null {
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow || element.ownerDocument !== ownerDocument) return null;
  const path: EventTarget[] = [];
  let current: Node | null = element;
  while (current) {
    path.push(current);
    if (current === ownerDocument) break;
    current = current.parentNode;
  }
  if (path.at(-1) !== ownerDocument) return null;
  path.push(ownerWindow);
  return Object.freeze(path);
}

function bubblePathsMatch(
  expected: readonly EventTarget[],
  actual: readonly EventTarget[],
  ownerDocument: Document,
) {
  const expectedWindow = expected.at(-1);
  const actualWindow = actual.at(-1);
  const hasOwnerWindow =
    actualWindow === expectedWindow ||
    (typeof actualWindow === "object" &&
      actualWindow !== null &&
      "document" in actualWindow &&
      actualWindow.document === ownerDocument &&
      "window" in actualWindow &&
      actualWindow.window === actualWindow);
  return (
    expected.length === actual.length &&
    hasOwnerWindow &&
    actual
      .slice(0, -1)
      .every((entry, index) => entry === expected[index])
  );
}

function bubbleOwnDescriptor(
  authority: BubbleKeyboardAuthority,
  value: object,
  property: PropertyKey,
) {
  const descriptor = authority.getOwnPropertyDescriptor(value, property);
  return descriptor && "value" in descriptor ? descriptor : null;
}

function bubbleReactMethod(
  value: object,
  property: PropertyKey,
) {
  const method = Reflect.get(value, property);
  return typeof method === "function" ? method : null;
}

function captureBubbleReactSnapshot(
  authority: BubbleKeyboardAuthority,
  event: object,
  native: BubbleKeyboardSnapshot,
  currentTarget: HTMLElement,
): BubbleReactSnapshot | null {
  const expected = {
    nativeEvent: native.event,
    type: "keydown",
    target: native.source,
    currentTarget,
    eventPhase: authority.Event.BUBBLING_PHASE,
    bubbles: native.bubbles,
    cancelable: native.cancelable,
    defaultPrevented: false,
    isTrusted: true,
    timeStamp: native.timeStamp,
    key: native.key,
    code: native.code,
    location: native.location,
    repeat: native.repeat,
    ctrlKey: native.ctrlKey,
    shiftKey: native.shiftKey,
    altKey: native.altKey,
    metaKey: native.metaKey,
    view: native.view,
    detail: native.detail,
  } as const;
  const descriptors = new Map<PropertyKey, PropertyDescriptor>();
  for (const property of BUBBLE_REACT_FIELDS) {
    const descriptor = bubbleOwnDescriptor(authority, event, property);
    if (!descriptor || descriptor.value !== expected[property]) return null;
    descriptors.set(property, Object.freeze({ ...descriptor }));
  }
  const methods = new Map<PropertyKey, unknown>();
  for (const property of BUBBLE_REACT_METHODS) {
    const method = bubbleReactMethod(event, property);
    if (!method) return null;
    methods.set(property, method);
  }
  const isDefaultPrevented = methods.get("isDefaultPrevented");
  const isPropagationStopped = methods.get("isPropagationStopped");
  if (
    typeof isDefaultPrevented !== "function" ||
    typeof isPropagationStopped !== "function" ||
    authority.apply(isDefaultPrevented, event, []) !== false ||
    authority.apply(isPropagationStopped, event, []) !== false
  ) {
    return null;
  }
  return Object.freeze({
    event,
    descriptors,
    methods,
  });
}

function bubbleReactSnapshotMatches(
  authority: BubbleKeyboardAuthority,
  snapshot: BubbleReactSnapshot,
  native: BubbleKeyboardSnapshot,
  currentTarget: HTMLElement | null,
) {
  for (const property of BUBBLE_REACT_FIELDS) {
    const expected = snapshot.descriptors.get(property);
    const current = bubbleOwnDescriptor(authority, snapshot.event, property);
    if (!expected || !current) return false;
    const expectedValue =
      property === "currentTarget" ? currentTarget : expected.value;
    if (
      current.configurable !== expected.configurable ||
      current.enumerable !== expected.enumerable ||
      current.writable !== expected.writable ||
      current.value !== expectedValue
    ) {
      return false;
    }
  }
  for (const [property, method] of snapshot.methods) {
    if (bubbleReactMethod(snapshot.event, property) !== method) return false;
  }
  const isDefaultPrevented = snapshot.methods.get("isDefaultPrevented");
  const isPropagationStopped = snapshot.methods.get("isPropagationStopped");
  return (
    typeof isDefaultPrevented === "function" &&
    typeof isPropagationStopped === "function" &&
    authority.apply(isDefaultPrevented, snapshot.event, []) === false &&
    authority.apply(isPropagationStopped, snapshot.event, []) === false &&
    bubbleNativeValue<EventTarget | null>(
      authority,
      authority.event.target,
      native.event,
    ) === native.source
  );
}

function bubbleRovingIndex(
  requested: number,
  enabled: readonly boolean[],
) {
  if (enabled[requested]) return requested;
  const start = requested >= 0 && requested < enabled.length ? requested : -1;
  for (let offset = 1; offset <= enabled.length; offset++) {
    const index = (start + offset) % enabled.length;
    if (enabled[index]) return index;
  }
  return -1;
}

function bubbleKeyDestination(
  controls: readonly BubbleControl[],
  source: BubbleControl,
  key: string,
) {
  if (!controls[source.index]?.enabled || controls[source.index] !== source) {
    return null;
  }
  if (key === "Home" || key === "End") {
    const ordered = key === "Home" ? controls : [...controls].reverse();
    const destination = ordered.find((control) => control.enabled) ?? null;
    return destination === source ? null : destination;
  }
  const step =
    key === "ArrowRight" || key === "ArrowDown"
      ? 1
      : key === "ArrowLeft" || key === "ArrowUp"
        ? -1
        : 0;
  if (!step) return null;
  for (let offset = 1; offset <= controls.length; offset++) {
    const index =
      (source.index + step * offset + controls.length) % controls.length;
    const destination = controls[index];
    if (destination?.enabled) return destination;
  }
  return null;
}

const ControlMutationObserver = typeof MutationObserver === "function" ? MutationObserver : null;

class BubbleControlCurrent {
  #geometry: BubbleGeometry | null = null;
  #owner: BubbleOwner | null = null;
  #authority: BubbleActionAuthority | null = null;
  #readContainer: (() => HTMLElement | null) | null = null;

  bindContainer(read: () => HTMLElement | null) {
    this.#readContainer = read;
  }

  unbindContainer(read: () => HTMLElement | null) {
    if (this.#readContainer === read) this.#readContainer = null;
  }

  publishGeometry(publication: BubbleGeometry) {
    this.#geometry = publication;
  }

  retireGeometry(publication: BubbleGeometry) {
    if (this.#geometry === publication) this.#geometry = null;
  }

  publishOwner(owner: BubbleOwner) {
    this.#owner = owner;
  }

  retireOwner(owner: BubbleOwner | null) {
    if (this.#owner === owner) this.#owner = null;
  }

  publishAuthority(authority: BubbleActionAuthority) {
    this.#authority = authority;
  }

  retireAuthority(authority: BubbleActionAuthority) {
    if (this.#authority === authority) this.#authority = null;
  }

  clear() {
    this.#geometry = null;
    this.#owner = null;
    this.#authority = null;
    this.#readContainer = null;
  }

  matches(publication: BubbleControlPublication, geometry: BubbleGeometry | null, mount: symbol) {
    const facts = publication.facts;
    const values = facts.formatValues;
    return (
      facts.mount === mount &&
      facts.geometry === geometry &&
      facts.geometry.owner === facts.owner &&
      facts.geometry.authority === facts.authority &&
      facts.geometry.layer.isConnected &&
      this.#geometry === facts.geometry &&
      this.#owner === facts.owner &&
      this.#authority === facts.authority &&
      facts.owner.view === facts.view &&
      facts.owner.editor === facts.editor &&
      facts.owner.scroller === facts.scroller &&
      facts.owner.session === facts.session &&
      facts.view.dom === facts.editor &&
      !facts.view.isDestroyed &&
      facts.editor.isConnected &&
      facts.scroller.isConnected &&
      facts.editor.ownerDocument === facts.geometry.layer.ownerDocument &&
      facts.scroller.ownerDocument === facts.geometry.layer.ownerDocument &&
      this.#readContainer?.() === facts.scroller &&
      facts.authority.owner === facts.owner &&
      facts.authority.view === facts.view &&
      facts.authority.session === facts.session &&
      facts.authority.actions === facts.actions &&
      facts.authority.onLink === facts.onLink &&
      facts.authority.onComment === facts.onComment &&
      facts.actions.toggleMark === facts.toggleMark &&
      facts.format.strong === values.strong &&
      facts.format.em === values.em &&
      facts.format.strike === values.strike &&
      facts.format.code === values.code &&
      facts.format.link === values.link &&
      facts.activeSurface === "rich" &&
      facts.session.activeSurface === facts.activeSurface &&
      facts.session.canEdit === facts.canEdit &&
      facts.session.canComment === facts.canComment
    );
  }
}

function controlTopology(bubble: HTMLDivElement, layer: HTMLDivElement): BubbleControlTopology {
  const nodes: Node[] = [];
  const visit = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(bubble);
  return {
    nodes: Object.freeze(nodes),
    markup: bubble.outerHTML,
    layerParent: layer.parentNode,
  };
}

function topologyMatches(topology: BubbleControlTopology, bubble: HTMLDivElement, layer: HTMLDivElement) {
  if (topology.layerParent !== layer.parentNode || topology.markup !== bubble.outerHTML) return false;
  const nodes: Node[] = [];
  const visit = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(bubble);
  return nodes.length === topology.nodes.length && nodes.every((node, index) => node === topology.nodes[index]);
}

class BubbleControlCoordinator {
  #current: BubbleControlPublication | null = null;
  #elementOwners = new WeakMap<HTMLElement, BubbleElementOwner>();
  #publishedGenerations = new WeakSet<BubbleControlGeneration>();
  #replayedGenerations = new WeakSet<BubbleControlGeneration>();
  #claimedKeyboardPublications = new WeakSet<BubbleControlPublication>();
  #claimedKeyboardControls = new WeakSet<BubbleControl>();
  #claimedReactEvents = new WeakSet<object>();
  #claimedNativeEvents = new WeakSet<Event>();
  #attemptedReactEvents = new WeakSet<object>();
  #attemptedNativeEvents = new WeakSet<Event>();
  #replay: BubbleControlReplay | null = null;

  publish(publication: BubbleControlPublication) {
    if (publication.retired || this.#current) return false;
    this.#current = publication;
    if (ControlMutationObserver) {
      const observer = new ControlMutationObserver(() => {
        publication.mutated = true;
      });
      observer.observe(publication.facts.geometry.layer, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      const layerParent = publication.facts.geometry.layer.parentNode;
      if (layerParent) observer.observe(layerParent, { childList: true });
      publication.mutationObserver = observer;
    }
    this.#connectKeyboard(publication);
    return true;
  }

  retire(publication: BubbleControlPublication | null) {
    if (!publication || publication.retired) return;
    const wasCurrent = this.#current === publication;
    const replayable = wasCurrent && this.#canReplay(publication);
    publication.retired = true;
    if (!wasCurrent) {
      this.#disconnect(publication);
      return;
    }
    this.#current = null;
    if (!replayable) {
      this.#disconnect(publication);
      return;
    }
    const expectedBindings = new Set<BubbleElementBinding<HTMLElement>>([
      publication.bubbleBinding,
      publication.rootBinding,
      ...publication.controlBindings.values(),
    ]);
    const replay: BubbleControlReplay = {
      publication,
      generation: publication.generation,
      expectedBindings,
      released: new Set(),
      rebound: new Map(),
      invalid: false,
    };
    this.#replay = replay;
    queueMicrotask(() => {
      if (this.#replay !== replay) return;
      this.#replay = null;
      this.#disconnect(publication);
    });
  }

  bindContainer(
    generation: BubbleControlGeneration,
    role: BubbleContainerRole,
    element: HTMLDivElement | null,
  ) {
    const previous = role === "bubble" ? generation.bubbleBinding : generation.rootBinding;
    if (!element) {
      if (previous) this.#release(previous, "null");
      return;
    }
    if (previous) this.#release(previous, "replace");
    const binding: BubbleElementBinding<HTMLDivElement> = {
      identity: Symbol(`selection-bubble-${role}-binding`),
      generation,
      role,
      control: null,
      element,
      active: true,
    };
    if (role === "bubble") generation.bubbleBinding = binding;
    else generation.rootBinding = binding;
    this.#elementOwners.set(element, {
      generation,
      generationIdentity: generation.identity,
      binding,
      bindingIdentity: binding.identity,
    });
    this.#recordRebound(binding);
    return () => this.#release(binding, "cleanup");
  }

  bindControl(control: BubbleControl, element: HTMLButtonElement | null) {
    const previous = control.binding;
    if (!element) {
      if (previous) this.#release(previous, "null");
      return;
    }
    if (previous) this.#release(previous, "replace");
    const binding: BubbleElementBinding<HTMLButtonElement> = {
      identity: Symbol("selection-bubble-control-binding"),
      generation: control.generation,
      role: "control",
      control,
      element,
      active: true,
    };
    control.binding = binding;
    this.#elementOwners.set(element, {
      generation: control.generation,
      generationIdentity: control.generation.identity,
      binding,
      bindingIdentity: binding.identity,
    });
    this.#recordRebound(binding);
    return () => this.#release(binding, "cleanup");
  }

  prepare(generation: BubbleControlGeneration) {
    const replay = this.#replay;
    if (replay) {
      this.#replay = null;
      const mutationFree = this.#mutationFree(replay.publication);
      this.#disconnect(replay.publication);
      if (replay.generation === generation) {
        if (
          this.#replayedGenerations.has(generation) ||
          replay.invalid ||
          !mutationFree ||
          replay.released.size !== replay.expectedBindings.size ||
          replay.rebound.size !== replay.expectedBindings.size ||
          [...replay.expectedBindings].some((binding) => {
            const rebound = replay.rebound.get(binding);
            return !rebound || rebound.element !== binding.element;
          })
        ) {
          return null;
        }
        this.#replayedGenerations.add(generation);
        return this.#createPublication(generation, replay.publication.topology);
      }
    }
    if (this.#publishedGenerations.has(generation)) return null;
    this.#publishedGenerations.add(generation);
    return this.#createPublication(generation);
  }

  discard(publication: BubbleControlPublication | null) {
    if (!publication) return;
    publication.retired = true;
    this.#disconnect(publication);
  }

  ownsControl(
    generation: BubbleControlGeneration,
    control: BubbleControl,
    element: HTMLButtonElement,
  ) {
    const publication = this.#current;
    if (
      !publication ||
      publication.retired ||
      publication.generation !== generation ||
      publication.claimed.has(control) ||
      control.generation !== generation
    ) {
      return null;
    }
    const binding = publication.controlBindings.get(control);
    if (!binding || binding.element !== element || control.binding !== binding || !binding.active) return null;
    const owner = this.#elementOwners.get(element);
    if (
      owner?.generation !== generation ||
      owner.generationIdentity !== generation.identity ||
      owner.binding !== binding ||
      owner.bindingIdentity !== binding.identity
    ) {
      return null;
    }
    if (!control.enabled || element.disabled || !element.isConnected || !this.#ownsElements(publication)) return null;
    return publication;
  }

  current(generation: BubbleControlGeneration) {
    const publication = this.#current;
    return publication?.generation === generation && !publication.retired ? publication : null;
  }

  captureRootKey(
    generation: BubbleControlGeneration,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    const publication = this.current(generation);
    if (
      !publication ||
      !event ||
      typeof event !== "object" ||
      publication.reactCapture ||
      this.#attemptedReactEvents.has(event) ||
      this.#claimedReactEvents.has(event) ||
      !this.#keyboardPublicationMatches(publication)
    ) {
      return;
    }
    const authority = publication.keyboardAuthority;
    const nativeEvent = event.nativeEvent;
    const source = event.target;
    const sourceControl = publication.generation.controls.find(
      (control) =>
        publication.controlBindings.get(control)?.element === source,
    );
    if (
      !sourceControl ||
      !(source instanceof authority.ownerWindow.HTMLButtonElement) ||
      authority.getPrototypeOf(nativeEvent) !==
        authority.KeyboardEvent.prototype ||
      event.type !== "keydown" ||
      event.currentTarget !== publication.rootBinding.element ||
      event.isTrusted !== true ||
      event.defaultPrevented ||
      event.isDefaultPrevented() ||
      event.isPropagationStopped() ||
      bubbleActiveElement(authority) !== source ||
      !publication.controlPaths.get(sourceControl) ||
      !bubblePathsMatch(
        publication.controlPaths.get(sourceControl)!,
        bubbleEventPath(authority, nativeEvent),
        authority.ownerDocument,
      ) ||
      !bubbleKeyDestination(
        publication.generation.controls,
        sourceControl,
        event.key,
      )
    ) {
      return;
    }
    let trusted = false;
    try {
      trusted =
        authority.trust.matches(nativeEvent) &&
        authority.trust.read(nativeEvent) === true;
    } catch {
      return;
    }
    if (!trusted) return;
    this.#attemptedReactEvents.add(event);
    const methods = new Map<PropertyKey, unknown>();
    for (const property of BUBBLE_REACT_METHODS) {
      const method = bubbleReactMethod(event, property);
      if (!method) return;
      methods.set(property, method);
    }
    const capture: BubbleReactCapture = Object.freeze({
      event,
      nativeEvent,
      sourceControl,
      source,
      methods,
    });
    publication.reactCapture = capture;
    queueMicrotask(() => {
      if (
        publication.reactCapture === capture &&
        publication.keyboardDelivery === null
      ) {
        publication.reactCapture = null;
      }
    });
  }

  stageControlKey(
    generation: BubbleControlGeneration,
    control: BubbleControl,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    const current = this.current(generation);
    const active = current?.keyboardDelivery;
    const captureEvent = current?.reactCapture?.event;
    if (
      !event ||
      typeof event !== "object" ||
      (this.#attemptedReactEvents.has(event) && captureEvent !== event) ||
      this.#claimedReactEvents.has(event)
    ) {
      if (active?.react?.event === event) active.invalid = true;
      return;
    }
    if (!this.#attemptedReactEvents.has(event)) {
      this.#attemptedReactEvents.add(event);
    }
    const publication = current;
    const nativeEvent = event.nativeEvent;
    const delivery = publication?.keyboardDelivery;
    if (
      !publication ||
      !delivery ||
      delivery.snapshot.event !== nativeEvent ||
      delivery.snapshot.sourceControl !== control ||
      delivery.react ||
      publication.reactCapture?.nativeEvent !== nativeEvent ||
      publication.reactCapture.sourceControl !== control ||
      !this.#keyboardPublicationMatches(publication)
    ) {
      if (delivery) delivery.invalid = true;
      return;
    }
    const react = captureBubbleReactSnapshot(
      publication.keyboardAuthority,
      event,
      delivery.snapshot,
      delivery.snapshot.source,
    );
    if (!react) {
      delivery.invalid = true;
      return;
    }
    for (const [property, method] of publication.reactCapture.methods) {
      if (react.methods.get(property) !== method) {
        delivery.invalid = true;
        return;
      }
    }
    delivery.react = react;
    delivery.buttonSeen++;
    if (delivery.buttonSeen !== 1) delivery.invalid = true;
  }

  stageRootKey(
    generation: BubbleControlGeneration,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    const publication = this.current(generation);
    const delivery = publication?.keyboardDelivery;
    const react = delivery?.react;
    if (
      !publication ||
      !delivery ||
      !react ||
      delivery.invalid ||
      react.event !== event ||
      delivery.snapshot.event !== event.nativeEvent ||
      !bubbleReactSnapshotMatches(
        publication.keyboardAuthority,
        react,
        delivery.snapshot,
        publication.rootBinding.element,
      ) ||
      !this.#keyboardPublicationMatches(publication)
    ) {
      if (delivery) delivery.invalid = true;
      return;
    }
    delivery.rootSeen++;
    if (delivery.rootSeen !== 1) delivery.invalid = true;
  }

  #keyboardPublicationMatches(publication: BubbleControlPublication) {
    const authority = publication.keyboardAuthority;
    const facts = publication.facts;
    return (
      this.#current === publication &&
      !publication.retired &&
      facts.isCurrent(publication) &&
      facts.view.state === facts.editorState &&
      facts.editorState.selection === facts.selection &&
      facts.selection.anchor === facts.selectionAnchor &&
      facts.selection.head === facts.selectionHead &&
      !facts.selection.empty &&
      authority.historyIsClean() &&
      this.#mutationFree(publication) &&
      this.#ownsElements(publication)
    );
  }

  #nativeSnapshotMatches(
    delivery: BubbleKeyboardDelivery,
    currentTarget: EventTarget,
    eventPhase: number,
  ) {
    const snapshot = delivery.snapshot;
    const publication = snapshot.publication;
    const authority = publication.keyboardAuthority;
    const { event, keyboard, ui } = authority;
    const path = bubbleEventPath(authority, snapshot.event);
    let trusted = false;
    try {
      trusted =
        authority.trust.matches(snapshot.event) &&
        authority.trust.read(snapshot.event) === true;
    } catch {
      return false;
    }
    return (
      trusted &&
      snapshot.trustGetter === authority.trust.getter &&
      authority.getPrototypeOf(snapshot.event) ===
        authority.KeyboardEvent.prototype &&
      bubbleNativeValue<string>(
        authority,
        event.type,
        snapshot.event,
      ) === "keydown" &&
      bubbleNativeValue<EventTarget | null>(
        authority,
        event.target,
        snapshot.event,
      ) === snapshot.source &&
      bubbleNativeValue<EventTarget | null>(
        authority,
        event.currentTarget,
        snapshot.event,
      ) === currentTarget &&
      bubbleNativeValue<number>(
        authority,
        event.eventPhase,
        snapshot.event,
      ) === eventPhase &&
      bubbleNativeValue<boolean>(
        authority,
        event.bubbles,
        snapshot.event,
      ) === snapshot.bubbles &&
      bubbleNativeValue<boolean>(
        authority,
        event.cancelable,
        snapshot.event,
      ) === snapshot.cancelable &&
      bubbleNativeValue<boolean>(
        authority,
        event.defaultPrevented,
        snapshot.event,
      ) === false &&
      bubbleNativeValue<boolean>(
        authority,
        event.cancelBubble,
        snapshot.event,
      ) === false &&
      bubbleNativeValue<boolean>(
        authority,
        event.composed,
        snapshot.event,
      ) === snapshot.composed &&
      bubbleNativeValue<number>(
        authority,
        event.timeStamp,
        snapshot.event,
      ) === snapshot.timeStamp &&
      bubbleNativeValue<string>(
        authority,
        keyboard.key,
        snapshot.event,
      ) === snapshot.key &&
      bubbleNativeValue<string>(
        authority,
        keyboard.code,
        snapshot.event,
      ) === snapshot.code &&
      bubbleNativeValue<number>(
        authority,
        keyboard.location,
        snapshot.event,
      ) === snapshot.location &&
      bubbleNativeValue<boolean>(
        authority,
        keyboard.repeat,
        snapshot.event,
      ) === snapshot.repeat &&
      bubbleNativeValue<boolean>(
        authority,
        keyboard.isComposing,
        snapshot.event,
      ) === snapshot.isComposing &&
      bubbleNativeValue<boolean>(
        authority,
        keyboard.ctrlKey,
        snapshot.event,
      ) === snapshot.ctrlKey &&
      bubbleNativeValue<boolean>(
        authority,
        keyboard.shiftKey,
        snapshot.event,
      ) === snapshot.shiftKey &&
      bubbleNativeValue<boolean>(
        authority,
        keyboard.altKey,
        snapshot.event,
      ) === snapshot.altKey &&
      bubbleNativeValue<boolean>(
        authority,
        keyboard.metaKey,
        snapshot.event,
      ) === snapshot.metaKey &&
      bubbleNativeValue<number>(
        authority,
        ui.detail,
        snapshot.event,
      ) === snapshot.detail &&
      bubbleNativeValue<Window | null>(
        authority,
        ui.view,
        snapshot.event,
      ) === snapshot.view &&
      bubblePathsMatch(snapshot.path, path, authority.ownerDocument)
    );
  }

  #captureKeyboard(
    publication: BubbleControlPublication,
    control: BubbleControl,
    event: Event,
  ) {
    publication.keyboardEventSeen = true;
    if (
      this.#attemptedNativeEvents.has(event) ||
      this.#claimedNativeEvents.has(event)
    ) {
      return;
    }
    this.#attemptedNativeEvents.add(event);
    const competing = publication.keyboardDelivery;
    if (
      publication.reactCapture &&
      publication.reactCapture.nativeEvent !== event
    ) {
      publication.reactCapture = null;
      if (competing) competing.invalid = true;
      return;
    }
    if (competing) {
      competing.invalid = true;
      return;
    }
    const authority = publication.keyboardAuthority;
    const binding = publication.controlBindings.get(control);
    const reactCapture = publication.reactCapture;
    if (
      !binding ||
      !reactCapture ||
      reactCapture.nativeEvent !== event ||
      reactCapture.sourceControl !== control ||
      reactCapture.source !== binding.element ||
      authority.getPrototypeOf(event) !== authority.KeyboardEvent.prototype ||
      !this.#keyboardPublicationMatches(publication)
    ) {
      return;
    }
    let trusted = false;
    try {
      trusted =
        authority.trust.matches(event) &&
        authority.trust.read(event) === true;
    } catch {
      return;
    }
    if (!trusted) return;
    const { event: eventGetters, keyboard, ui } = authority;
    const key = bubbleNativeValue<string>(authority, keyboard.key, event);
    const destinationControl = bubbleKeyDestination(
      publication.generation.controls,
      control,
      key,
    );
    const destinationBinding = destinationControl
      ? publication.controlBindings.get(destinationControl)
      : null;
    const path = bubbleEventPath(authority, event);
    const expectedPath = publication.controlPaths.get(control);
    const bubbles = bubbleNativeValue<boolean>(
      authority,
      eventGetters.bubbles,
      event,
    );
    const cancelable = bubbleNativeValue<boolean>(
      authority,
      eventGetters.cancelable,
      event,
    );
    const repeat = bubbleNativeValue<boolean>(
      authority,
      keyboard.repeat,
      event,
    );
    const isComposing = bubbleNativeValue<boolean>(
      authority,
      keyboard.isComposing,
      event,
    );
    const ctrlKey = bubbleNativeValue<boolean>(
      authority,
      keyboard.ctrlKey,
      event,
    );
    const shiftKey = bubbleNativeValue<boolean>(
      authority,
      keyboard.shiftKey,
      event,
    );
    const altKey = bubbleNativeValue<boolean>(
      authority,
      keyboard.altKey,
      event,
    );
    const metaKey = bubbleNativeValue<boolean>(
      authority,
      keyboard.metaKey,
      event,
    );
    const view = bubbleNativeValue<Window | null>(
      authority,
      ui.view,
      event,
    );
    if (
      !destinationControl ||
      !destinationBinding ||
      !destinationControl.enabled ||
      destinationBinding.element.disabled ||
      !expectedPath ||
      bubbleNativeValue<string>(
        authority,
        eventGetters.type,
        event,
      ) !== "keydown" ||
      bubbleNativeValue<EventTarget | null>(
        authority,
        eventGetters.target,
        event,
      ) !== binding.element ||
      bubbleNativeValue<EventTarget | null>(
        authority,
        eventGetters.currentTarget,
        event,
      ) !== binding.element ||
      bubbleNativeValue<number>(
        authority,
        eventGetters.eventPhase,
        event,
      ) !== authority.Event.AT_TARGET ||
      !bubbles ||
      !cancelable ||
      bubbleNativeValue<boolean>(
        authority,
        eventGetters.defaultPrevented,
        event,
      ) ||
      bubbleNativeValue<boolean>(
        authority,
        eventGetters.cancelBubble,
        event,
      ) ||
      repeat ||
      isComposing ||
      ctrlKey ||
      shiftKey ||
      altKey ||
      metaKey ||
      (view !== null && view !== authority.ownerWindow) ||
      bubbleActiveElement(authority) !== binding.element ||
      !bubblePathsMatch(expectedPath, path, authority.ownerDocument) ||
      authority.getOwnPropertyDescriptor(event, "stopPropagation") ||
      authority.getOwnPropertyDescriptor(event, "stopImmediatePropagation")
    ) {
      return;
    }
    let propagationStopped = false;
    if (
      !authority.defineProperty(event, "stopPropagation", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: () => {
          propagationStopped = true;
          authority.apply(authority.stopPropagation, event, []);
        },
      }) ||
      !authority.defineProperty(event, "stopImmediatePropagation", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: () => {
          propagationStopped = true;
          authority.apply(authority.stopImmediatePropagation, event, []);
        },
      })
    ) {
      return;
    }
    const snapshot: BubbleKeyboardSnapshot = Object.freeze({
      event: event as KeyboardEvent,
      publication,
      sourceControl: control,
      destinationControl,
      source: binding.element,
      destination: destinationBinding.element,
      path: Object.freeze([...path]),
      key,
      code: bubbleNativeValue<string>(authority, keyboard.code, event),
      location: bubbleNativeValue<number>(
        authority,
        keyboard.location,
        event,
      ),
      repeat,
      isComposing,
      ctrlKey,
      shiftKey,
      altKey,
      metaKey,
      bubbles,
      cancelable,
      composed: bubbleNativeValue<boolean>(
        authority,
        eventGetters.composed,
        event,
      ),
      timeStamp: bubbleNativeValue<number>(
        authority,
        eventGetters.timeStamp,
        event,
      ),
      detail: bubbleNativeValue<number>(authority, ui.detail, event),
      view,
      trustGetter: authority.trust.getter,
      propagationStopped: () => propagationStopped,
    });
    const delivery: BubbleKeyboardDelivery = {
      snapshot,
      react: null,
      buttonSeen: 0,
      rootSeen: 0,
      invalid: false,
    };
    publication.keyboardDelivery = delivery;
    queueMicrotask(() => {
      if (publication.keyboardDelivery === delivery) {
        publication.keyboardDelivery = null;
      }
    });
  }

  #settleKeyboard(
    publication: BubbleControlPublication,
    event: Event,
  ) {
    const delivery = publication.keyboardDelivery;
    const snapshot = delivery?.snapshot;
    const react = delivery?.react;
    const reactCapture = publication.reactCapture;
    const authority = publication.keyboardAuthority;
    if (
      !delivery ||
      !snapshot ||
      !react ||
      !reactCapture ||
      reactCapture.nativeEvent !== event ||
      snapshot.event !== event ||
      delivery.invalid ||
      delivery.buttonSeen !== 1 ||
      delivery.rootSeen !== 1 ||
      snapshot.propagationStopped() ||
      !this.#nativeSnapshotMatches(
        delivery,
        authority.ownerDocument,
        authority.Event.BUBBLING_PHASE,
      ) ||
      !bubbleReactSnapshotMatches(authority, react, snapshot, null) ||
      bubbleActiveElement(authority) !== snapshot.source ||
      !this.#keyboardPublicationMatches(publication) ||
      this.#claimedKeyboardPublications.has(publication) ||
      this.#claimedKeyboardControls.has(snapshot.sourceControl) ||
      this.#claimedReactEvents.has(reactCapture.event) ||
      this.#claimedReactEvents.has(react.event) ||
      this.#claimedNativeEvents.has(snapshot.event)
    ) {
      if (delivery) {
        delivery.invalid = true;
        publication.keyboardDelivery = null;
        publication.reactCapture = null;
      }
      return;
    }
    this.#claimedKeyboardPublications.add(publication);
    this.#claimedKeyboardControls.add(snapshot.sourceControl);
    this.#claimedReactEvents.add(reactCapture.event);
    this.#claimedReactEvents.add(react.event);
    this.#claimedNativeEvents.add(snapshot.event);
    publication.keyboardDelivery = null;
    publication.reactCapture = null;
    authority.apply(authority.preventDefault, snapshot.event, []);
    if (
      bubbleNativeValue<boolean>(
        authority,
        authority.event.defaultPrevented,
        snapshot.event,
      ) !== true
    ) {
      return;
    }
    authority.apply(authority.focus, snapshot.destination, [
      BUBBLE_PREVENT_SCROLL,
    ]);
    publication.facts.setRovingIndex(snapshot.destinationControl.index);
  }

  #connectKeyboard(publication: BubbleControlPublication) {
    const authority = publication.keyboardAuthority;
    for (const { target, listener, capture } of publication.keyboardListeners) {
      authority.apply(authority.addEventListener, target, [
        "keydown",
        listener,
        capture,
      ]);
    }
  }

  #disconnectKeyboard(publication: BubbleControlPublication) {
    const authority = publication.keyboardAuthority;
    const delivery = publication.keyboardDelivery;
    if (delivery) delivery.invalid = true;
    publication.keyboardDelivery = null;
    publication.reactCapture = null;
    for (const { target, listener, capture } of publication.keyboardListeners) {
      authority.apply(authority.removeEventListener, target, [
        "keydown",
        listener,
        capture,
      ]);
    }
  }

  #release(
    binding: BubbleElementBinding<HTMLElement>,
    source: "cleanup" | "null" | "replace",
  ) {
    if (!binding.active) return;
    binding.active = false;
    const { generation, control, role, element } = binding;
    if (role === "bubble" && generation.bubbleBinding === binding) generation.bubbleBinding = null;
    else if (role === "root" && generation.rootBinding === binding) generation.rootBinding = null;
    else if (role === "control" && control?.binding === binding) control.binding = null;
    const owner = this.#elementOwners.get(element);
    if (owner?.binding === binding && owner.bindingIdentity === binding.identity) {
      this.#elementOwners.delete(element);
    }
    const replay = this.#replay;
    if (replay?.generation !== generation) return;
    if (
      source !== "cleanup" ||
      !replay.expectedBindings.has(binding) ||
      replay.released.has(binding)
    ) {
      replay.invalid = true;
      return;
    }
    replay.released.add(binding);
  }

  #recordRebound(binding: BubbleElementBinding<HTMLElement>) {
    const replay = this.#replay;
    if (replay?.generation !== binding.generation) return;
    const expected = [...replay.expectedBindings].find((candidate) =>
      candidate.role === binding.role && candidate.control === binding.control);
    if (
      !expected ||
      !replay.released.has(expected) ||
      replay.rebound.has(expected) ||
      expected.element !== binding.element
    ) {
      replay.invalid = true;
      return;
    }
    replay.rebound.set(expected, binding);
  }

  #ownsBinding(binding: BubbleElementBinding<HTMLElement>) {
    if (!binding.active) return false;
    const owner = this.#elementOwners.get(binding.element);
    return owner?.generation === binding.generation &&
      owner.generationIdentity === binding.generation.identity &&
      owner.binding === binding &&
      owner.bindingIdentity === binding.identity;
  }

  #ownsElements(publication: BubbleControlPublication) {
    const { facts, generation, bubbleBinding, rootBinding } = publication;
    const bubble = bubbleBinding.element;
    const root = rootBinding.element;
    if (
      generation.bubbleBinding !== bubbleBinding ||
      generation.rootBinding !== rootBinding ||
      !this.#ownsBinding(bubbleBinding) ||
      !this.#ownsBinding(rootBinding) ||
      !bubble.isConnected ||
      !root.isConnected ||
      !facts.geometry.layer.isConnected ||
      !bubble.contains(root) ||
      !facts.geometry.layer.contains(bubble) ||
      !topologyMatches(publication.topology, bubble, facts.geometry.layer)
    ) {
      return false;
    }
    for (const [control, binding] of publication.controlBindings) {
      if (
        control.binding !== binding ||
        !this.#ownsBinding(binding) ||
        !binding.element.isConnected ||
        binding.element.ownerDocument !==
          publication.keyboardAuthority.ownerDocument ||
        binding.element.disabled === control.enabled ||
        binding.element.tabIndex !== (control.tabStop ? 0 : -1) ||
        !root.contains(binding.element) ||
        !bubble.contains(binding.element) ||
        !facts.geometry.layer.contains(binding.element)
      ) {
        return false;
      }
    }
    return (
      root.ownerDocument === publication.keyboardAuthority.ownerDocument &&
      bubble.ownerDocument === publication.keyboardAuthority.ownerDocument &&
      facts.geometry.layer.ownerDocument ===
        publication.keyboardAuthority.ownerDocument &&
      !root.hasAttribute("tabindex") &&
      generation.controls.filter((control) => control.tabStop).length === 1 &&
      generation.controls[facts.rovingIndex]?.tabStop === true
    );
  }

  #createPublication(
    generation: BubbleControlGeneration,
    expectedTopology?: BubbleControlTopology,
  ): BubbleControlPublication | null {
    const { facts, bubbleBinding, rootBinding } = generation;
    if (
      !bubbleBinding ||
      !rootBinding ||
      generation.controls.length !== 6 ||
      !this.#ownsBinding(bubbleBinding) ||
      !this.#ownsBinding(rootBinding)
    ) {
      return null;
    }
    const controlBindings = new Map<BubbleControl, BubbleElementBinding<HTMLButtonElement>>();
    for (const control of generation.controls) {
      const binding = control.binding;
      if (!binding || !this.#ownsBinding(binding)) return null;
      controlBindings.set(control, binding);
    }
    const buttons = [...rootBinding.element.querySelectorAll("button")];
    if (
      buttons.length !== generation.controls.length ||
      generation.controls.some((control, index) => controlBindings.get(control)?.element !== buttons[index])
    ) {
      return null;
    }
    const ownerDocument = rootBinding.element.ownerDocument;
    const keyboardAuthority =
      captureBubbleKeyboardAuthority(ownerDocument);
    if (
      !keyboardAuthority ||
      generation.controls.filter((control) => control.tabStop).length !== 1 ||
      generation.controls[generation.facts.rovingIndex]?.tabStop !== true
    ) {
      return null;
    }
    const controlPaths = new Map<
      BubbleControl,
      readonly EventTarget[]
    >();
    for (const [control, binding] of controlBindings) {
      const path = bubbleControlPath(ownerDocument, binding.element);
      if (!path) return null;
      controlPaths.set(control, path);
    }
    const topology = controlTopology(bubbleBinding.element, facts.geometry.layer);
    if (
      expectedTopology &&
      (
        !topologyMatches(expectedTopology, bubbleBinding.element, facts.geometry.layer) ||
        topology.nodes.length !== expectedTopology.nodes.length ||
        topology.nodes.some((node, index) => node !== expectedTopology.nodes[index])
      )
    ) {
      return null;
    }
    let publication: BubbleControlPublication;
    const keyboardListeners: BubbleKeyboardListener[] = [
      ...generation.controls.map((control) => {
        const binding = controlBindings.get(control)!;
        const listener: EventListener = (event) =>
          this.#captureKeyboard(publication, control, event);
        return Object.freeze({
          target: binding.element,
          listener,
          capture: true,
        });
      }),
      Object.freeze({
        target: keyboardAuthority.ownerDocument,
        listener: ((event: Event) =>
          this.#settleKeyboard(publication, event)) as EventListener,
        capture: false,
      }),
    ];
    publication = {
      identity: Symbol("selection-bubble-control-publication"),
      retired: false,
      generation,
      facts,
      bubbleBinding,
      rootBinding,
      controlBindings,
      topology,
      mouseEvents: new WeakSet(),
      mouseEventSeen: false,
      claimed: new Set(),
      mutationObserver: null,
      mutated: false,
      keyboardAuthority,
      controlPaths,
      keyboardListeners: Object.freeze(keyboardListeners),
      keyboardDelivery: null,
      reactCapture: null,
      keyboardEventSeen: false,
    };
    return this.#ownsElements(publication) ? publication : null;
  }

  #canReplay(publication: BubbleControlPublication) {
    return (
      !this.#replayedGenerations.has(publication.generation) &&
      publication.claimed.size === 0 &&
      !publication.mouseEventSeen &&
      !publication.keyboardEventSeen &&
      this.#mutationFree(publication) &&
      this.#ownsElements(publication)
    );
  }

  #mutationFree(publication: BubbleControlPublication) {
    if (
      publication.mutated ||
      (publication.mutationObserver?.takeRecords().length ?? 0) > 0
    ) {
      publication.mutated = true;
      return false;
    }
    return true;
  }

  #disconnect(publication: BubbleControlPublication) {
    this.#disconnectKeyboard(publication);
    publication.mutationObserver?.disconnect();
    publication.mutationObserver = null;
  }
}

function createControlGeneration({
  coordinator,
  mount,
  geometry,
  view,
  session,
  activeSurface,
  actions,
  format,
  canEdit,
  canComment,
  onLink,
  onComment,
  rovingIndex,
  setRovingIndex,
  isCurrent,
}: {
  coordinator: BubbleControlCoordinator;
  mount: symbol;
  geometry: BubbleGeometry;
  view: EditorView;
  session: CollabSession;
  activeSurface: CollabSession["activeSurface"] | null;
  actions: EditorActions;
  format: FormatState;
  canEdit: boolean;
  canComment: boolean;
  onLink: () => void;
  onComment: () => void;
  rovingIndex: number;
  setRovingIndex: (index: number) => void;
  isCurrent: (publication: BubbleControlPublication) => boolean;
}): {
  generation: BubbleControlGeneration;
  controls: BubbleControls;
  captureBubble: RefCallback<HTMLDivElement>;
  captureRoot: RefCallback<HTMLDivElement>;
} {
  const editorState = view.state;
  const selection = editorState.selection;
  const facts = Object.freeze({
    mount,
    geometry,
    owner: geometry.owner,
    authority: geometry.authority,
    view,
    editor: geometry.owner.editor,
    scroller: geometry.owner.scroller,
    session,
    activeSurface,
    actions,
    toggleMark: actions.toggleMark,
    format,
    formatValues: Object.freeze({
      strong: format.strong,
      em: format.em,
      strike: format.strike,
      code: format.code,
      link: format.link,
    }),
    canEdit,
    canComment,
    onLink,
    onComment,
    editorState,
    selection,
    selectionAnchor: selection.anchor,
    selectionHead: selection.head,
    rovingIndex,
    setRovingIndex,
    isCurrent,
  } satisfies BubbleControlFacts);
  const generation: BubbleControlGeneration = {
    identity: Symbol("selection-bubble-control-generation"),
    facts,
    bubbleBinding: null,
    rootBinding: null,
    controls: [],
  };
  let nextIndex = 0;
  const control = (
    permission: BubbleControlPermission,
    invoke: () => void,
  ): BubbleControl => {
    const index = nextIndex++;
    const owned: BubbleControl = {
      identity: Symbol("selection-bubble-control"),
      generation,
      permission,
      enabled: permission === "edit" ? canEdit : canComment,
      binding: null,
      captureButton: (element) => coordinator.bindControl(owned, element),
      invoke,
      index,
      tabStop: index === rovingIndex,
    };
    return owned;
  };
  const toggleMark = facts.toggleMark;
  const mark = (value: BubbleMark) =>
    control("edit", () => toggleMark.call(actions, value));

  const controls = {
    bold: mark("strong"),
    italic: mark("em"),
    strike: mark("strike"),
    code: mark("code"),
    link: control("edit", onLink),
    comment: control("comment", onComment),
  };
  generation.controls = Object.freeze(Object.values(controls));
  return {
    generation,
    captureBubble: (element) => coordinator.bindContainer(generation, "bubble", element),
    captureRoot: (element) => coordinator.bindContainer(generation, "root", element),
    controls,
  };
}

function BubbleButton({
  label,
  active,
  captureButton,
  onMouseDown,
  onClick,
  onKeyDown,
  tabIndex,
  children,
  disabled,
}: {
  label: string;
  active?: boolean;
  captureButton: RefCallback<HTMLButtonElement>;
  onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  tabIndex: 0 | -1;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      ref={captureButton}
      type="button"
      className={cn("flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-md text-white/85 hover:bg-white/15 hover:text-white disabled:opacity-30", active && "bg-white/20 text-white")}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      aria-label={label}
      title={label}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function SelectionBubbleControls({
  geometry,
  session,
  actions,
  format,
  onComment,
  onLink,
  activeSurface,
  canEdit,
  canComment,
  controlMount,
  controlCoordinator,
  controlCurrent,
}: {
  geometry: BubbleGeometry;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  onComment: () => void;
  onLink: () => void;
  activeSurface: CollabSession["activeSurface"] | null;
  canEdit: boolean;
  canComment: boolean;
  controlMount: symbol;
  controlCoordinator: BubbleControlCoordinator;
  controlCurrent: BubbleControlCurrent;
}) {
  const enabled = [canEdit, canEdit, canEdit, canEdit, canEdit, canComment];
  const [requestedRovingIndex, setRovingIndex] = useState(() =>
    bubbleRovingIndex(-1, enabled),
  );
  const rovingIndex = bubbleRovingIndex(requestedRovingIndex, enabled);
  useLayoutEffect(() => {
    if (requestedRovingIndex !== rovingIndex) setRovingIndex(rovingIndex);
  }, [requestedRovingIndex, rovingIndex]);
  const controlSet = createControlGeneration({
    coordinator: controlCoordinator,
    mount: controlMount,
    geometry,
    view: geometry.owner.view,
    session,
    activeSurface,
    actions,
    format,
    canEdit,
    canComment,
    onLink,
    onComment,
    rovingIndex,
    setRovingIndex,
    isCurrent: (publication) =>
      controlCurrent.matches(publication, geometry, controlMount),
  });
  const { generation, controls, captureBubble, captureRoot } = controlSet;

  useLayoutEffect(() => {
    const candidate = controlCoordinator.prepare(generation);
    const publication =
      candidate &&
      controlCurrent.matches(candidate, geometry, controlMount) &&
      controlCoordinator.publish(candidate)
        ? candidate
        : null;
    if (candidate !== publication) controlCoordinator.discard(candidate);
    return () => controlCoordinator.retire(publication);
  }, [controlCoordinator, controlCurrent, controlMount, generation, geometry]);

  const ownsControl = (
    control: BubbleControl,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    const element = control.binding?.element;
    if (!element || event.currentTarget !== element) return null;
    const publication = controlCoordinator.ownsControl(generation, control, element);
    if (!publication || !controlCurrent.matches(publication, geometry, controlMount)) return null;
    const { facts } = publication;
    return control.permission === "edit"
      ? facts.canEdit ? publication : null
      : facts.canComment ? publication : null;
  };
  const onMouseDown = (control: BubbleControl) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    const current = controlCoordinator.current(generation);
    if (event.currentTarget !== control.binding?.element || current?.mouseEvents.has(event)) return;
    const publication = ownsControl(control, event);
    if (!publication) return;
    publication.mouseEvents.add(event);
    publication.mouseEventSeen = true;
    event.preventDefault();
  };
  const onClick = (control: BubbleControl) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    const publication = ownsControl(control, event);
    if (!publication) return;
    publication.claimed.add(control);
    control.invoke();
  };
  const onKeyDown = (control: BubbleControl) =>
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      controlCoordinator.stageControlKey(generation, control, event);
    };
  const onRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    controlCoordinator.stageRootKey(generation, event);
  };
  const onRootKeyDownCapture = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    controlCoordinator.captureRootKey(generation, event);
  };
  const { position: pos, placement, layer } = geometry;

  return createPortal(
    <div
      ref={captureBubble}
      className="selection-bubble touch-target absolute z-30 rounded-lg bg-inverse shadow-xl dark:ring-1 dark:ring-white/10"
      style={{ left: placement.left, top: placement.top, width: pos.width, transform: `scale(${placement.scaleX}, ${placement.scaleY})`, transformOrigin: "top left" }}
      data-testid="selection-bubble"
      data-below={pos.below || undefined}
    >
      <div
        ref={captureRoot}
        className="selection-bubble-scroll flex items-center gap-[2px] overflow-x-auto overflow-y-hidden rounded-lg p-[4px]"
        role="toolbar"
        aria-label="Selection"
        aria-orientation="horizontal"
        onKeyDownCapture={onRootKeyDownCapture}
        onKeyDown={onRootKeyDown}
      >
        <BubbleButton label="Bold" active={format.strong} disabled={!canEdit} captureButton={controls.bold.captureButton} onMouseDown={onMouseDown(controls.bold)} onClick={onClick(controls.bold)} onKeyDown={onKeyDown(controls.bold)} tabIndex={controls.bold.tabStop ? 0 : -1}>
          <Bold size={16} strokeWidth={2.6} />
        </BubbleButton>
        <BubbleButton label="Italic" active={format.em} disabled={!canEdit} captureButton={controls.italic.captureButton} onMouseDown={onMouseDown(controls.italic)} onClick={onClick(controls.italic)} onKeyDown={onKeyDown(controls.italic)} tabIndex={controls.italic.tabStop ? 0 : -1}>
          <Italic size={16} />
        </BubbleButton>
        <BubbleButton label="Strikethrough" active={format.strike} disabled={!canEdit} captureButton={controls.strike.captureButton} onMouseDown={onMouseDown(controls.strike)} onClick={onClick(controls.strike)} onKeyDown={onKeyDown(controls.strike)} tabIndex={controls.strike.tabStop ? 0 : -1}>
          <Strikethrough size={16} />
        </BubbleButton>
        <BubbleButton label="Inline code" active={format.code} disabled={!canEdit} captureButton={controls.code.captureButton} onMouseDown={onMouseDown(controls.code)} onClick={onClick(controls.code)} onKeyDown={onKeyDown(controls.code)} tabIndex={controls.code.tabStop ? 0 : -1}>
          <Code size={16} />
        </BubbleButton>
        <BubbleButton label="Link" active={format.link} disabled={!canEdit} captureButton={controls.link.captureButton} onMouseDown={onMouseDown(controls.link)} onClick={onClick(controls.link)} onKeyDown={onKeyDown(controls.link)} tabIndex={controls.link.tabStop ? 0 : -1}>
          <LinkIcon size={16} />
        </BubbleButton>
        <span className="mx-[2px] h-[20px] w-px shrink-0 bg-white/20" />
        <BubbleButton label="Comment" disabled={!canComment} captureButton={controls.comment.captureButton} onMouseDown={onMouseDown(controls.comment)} onClick={onClick(controls.comment)} onKeyDown={onKeyDown(controls.comment)} tabIndex={controls.comment.tabStop ? 0 : -1}>
          <MessageSquarePlus size={16} />
        </BubbleButton>
      </div>
      <span
        className="absolute -translate-x-1/2 rotate-45 bg-inverse"
        style={{ left: pos.arrowLeft, width: SELECTION_BUBBLE_ARROW_SIZE, height: SELECTION_BUBBLE_ARROW_SIZE, ...(pos.below ? { top: -4 } : { bottom: -4 }) }}
        aria-hidden
      />
    </div>,
    layer,
  );
}

/**
 * Floating toolbar that appears over a non-empty selection in the rich pane, the way
 * word processors do. It offers the most common inline actions and "Comment".
 */
export function SelectionBubble({
  view,
  session,
  actions,
  format,
  containerRef,
  onComment,
  onLink,
}: {
  view: EditorView | null;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  containerRef: React.RefObject<HTMLElement | null>;
  onComment: () => void;
  onLink: () => void;
}) {
  const [geometry, setGeometry] = useState<BubbleGeometry | null>(null);
  const publicationRef = useRef<BubbleGeometry | null>(null);
  const ownerRef = useRef<BubbleOwner | null>(null);
  const authorityRef = useRef<BubbleActionAuthority | null>(null);
  const [controlMount] = useState(() => Symbol("selection-bubble-controls"));
  const [controlCoordinator] = useState(() => new BubbleControlCoordinator());
  const [controlCurrent] = useState(() => new BubbleControlCurrent());

  useLayoutEffect(() => {
    const readContainer = () => containerRef.current;
    controlCurrent.bindContainer(readContainer);
    return () => controlCurrent.unbindContainer(readContainer);
  }, [containerRef, controlCurrent]);

  const retirePublication = (publication: BubbleGeometry) => {
    if (publicationRef.current === publication) {
      publicationRef.current = null;
      controlCurrent.retireGeometry(publication);
    }
    setGeometry((current) => current === publication ? null : current);
  };
  const retireAuthority = (authority: BubbleActionAuthority) => {
    if (authorityRef.current !== authority) return;
    authorityRef.current = null;
    controlCurrent.retireAuthority(authority);
    const publication = publicationRef.current;
    if (publication?.authority === authority) retirePublication(publication);
  };

  // Resolve ref.current on every commit: the pane can be replaced without replacing its ref.
  useLayoutEffect(() => {
    const scroller = containerRef.current;
    const previous = ownerRef.current;
    if (previous?.view === view && previous?.editor === view?.dom && previous?.scroller === scroller && previous?.session === session) {
      const previousAuthority = authorityRef.current;
      if (
        previousAuthority?.owner === previous &&
        previousAuthority.view === view &&
        previousAuthority.session === session &&
        previousAuthority.actions === actions &&
        previousAuthority.onLink === onLink &&
        previousAuthority.onComment === onComment
      ) return;
      if (previousAuthority) retireAuthority(previousAuthority);
      const nextAuthority = { owner: previous, view, session, actions, onLink, onComment };
      authorityRef.current = nextAuthority;
      controlCurrent.publishAuthority(nextAuthority);
      previous.schedule();
      return;
    }
    const previousAuthority = authorityRef.current;
    if (previousAuthority) retireAuthority(previousAuthority);
    previous?.dispose();
    ownerRef.current = null;
    controlCurrent.retireOwner(previous);
    if (!view || !scroller) {
      return;
    }
    const editor = view.dom;
    const visualViewport = window.visualViewport;
    const fonts = document.fonts;
    const layer = document.createElement("div");
    layer.className = "selection-bubble-layer";
    layer.setAttribute("data-selection-bubble-layer", "");
    layer.contentEditable = "false";
    const topLayer = typeof layer.showPopover === "function";
    if (topLayer) layer.popover = "manual";
    let disposed = false;
    let pointerDown = false;
    let frame: number | null = null;
    let fullscreenWidget: {
      decorations: NonNullable<EditorView["props"]["decorations"]>;
      previous: EditorView["props"]["decorations"];
    } | null = null;
    const observedContent = new Set<Element>();

    const removeFullscreenWidget = () => {
      const owned = fullscreenWidget;
      fullscreenWidget = null;
      if (owned && !view.isDestroyed && view.props.decorations === owned.decorations) {
        view.setProps({ decorations: owned.previous });
      }
    };
    const hide = () => {
      if (disposed) return;
      if (topLayer && layer.matches(":popover-open")) layer.hidePopover();
      const publication = publicationRef.current;
      if (publication?.owner === owner) retirePublication(publication);
    };
    const compute = () => {
      if (disposed) return;
      const authority = authorityRef.current;
      if (ownerRef.current !== owner || authority?.owner !== owner) {
        hide();
        return;
      }
      if (view.isDestroyed || !editor.isConnected || !scroller.isConnected || containerRef.current !== scroller) {
        hide();
        return;
      }
      const { from, to, empty } = view.state.selection;
      const ownsFocus = view.hasFocus() || Boolean(document.activeElement && layer.contains(document.activeElement));
      if (empty || !ownsFocus || pointerDown || session.activeSurface !== "rich" || !(session.canEdit || session.canComment)) {
        hide();
        return;
      }
      const fullscreen = document.fullscreenElement;
      if (fullscreen && !fullscreen.contains(editor) && !fullscreen.contains(scroller)) {
        hide();
        return;
      }
      // The top layer escapes transforms and overflow. The non-popover fallback is outside
      // transformed body, or directly inside fullscreen with an explicit scale conversion.
      const target = fullscreen ?? document.documentElement;
      if (layer.parentElement !== target) {
        if (topLayer && layer.matches(":popover-open")) layer.hidePopover();
        if (target === editor) {
          // A portal inside editable content must be a widget: otherwise ProseMirror removes
          // its DOM, reparses its contents, and handles the toolbar's keyboard events as edits.
          // Changing the plugin array restarts every plugin view, including suggesting,
          // pending uploads and slash-menu ownership. A direct decoration leaves them intact.
          if (!fullscreenWidget || view.props.decorations !== fullscreenWidget.decorations) {
            const previous = view.props.decorations;
            const decorations: NonNullable<EditorView["props"]["decorations"]> = (state) => {
              if (disposed || fullscreenWidget?.decorations !== decorations) return DecorationSet.empty;
              let result = DecorationSet.create(state.doc, [
                Decoration.widget(0, layer, { side: -1, ignoreSelection: true, stopEvent: () => true }),
              ]);
              previous?.call(view, state)?.forEachSet((set) => { result = result.add(state.doc, set.find()); });
              return result;
            };
            fullscreenWidget = { decorations, previous };
            view.setProps({ decorations });
          }
        } else {
          removeFullscreenWidget();
          target.appendChild(layer);
        }
      }
      layer.dir = getComputedStyle(editor).direction;
      if (topLayer && !layer.matches(":popover-open")) layer.showPopover();
      try {
        const start = view.coordsAtPos(from);
        const end = view.coordsAtPos(to, -1);
        const startDOM = view.domAtPos(from);
        const endDOM = view.domAtPos(to);
        const range = document.createRange();
        range.setStart(startDOM.node, startDOM.offset);
        range.setEnd(endDOM.node, endDOM.offset);
        const fragments = Array.from(range.getClientRects(), clientBox);
        const nextContent = new Set<Element>();
        for (const node of [startDOM.node, endDOM.node]) {
          let element = node instanceof Element ? node : node.parentElement;
          while (element && element !== editor && editor.contains(element)) {
            nextContent.add(element);
            element = element.parentElement;
          }
        }
        for (const element of observedContent) {
          if (!nextContent.has(element)) {
            resizeObserver?.unobserve(element);
            observedContent.delete(element);
          }
        }
        for (const element of nextContent) {
          if (!observedContent.has(element)) {
            resizeObserver?.observe(element);
            observedContent.add(element);
          }
        }
        const visual: VisualViewportBox | null = visualViewport
          ? {
              offsetLeft: visualViewport.offsetLeft,
              offsetTop: visualViewport.offsetTop,
              width: visualViewport.width,
              height: visualViewport.height,
            }
          : null;
        const bounds = selectionBubbleBounds({
          host: clientBox((fullscreen && !fullscreen.contains(scroller) ? fullscreen : scroller).getBoundingClientRect()),
          layoutViewport: {
            left: 0,
            top: 0,
            width: document.documentElement.clientWidth || window.innerWidth,
            height: document.documentElement.clientHeight || window.innerHeight,
          },
          visualViewport: visual,
          safeArea: safeAreaInsets(),
        });
        if (fragments.length && !fragments.some((fragment) => selectionIntersectsBounds(fragment, bounds))) {
          hide();
          return;
        }
        const position = placeSelectionBubble(selectionClientBox(caretBox(start), caretBox(end), fragments), bounds, isCoarsePointer());
        const layerBox = clientBox(layer.getBoundingClientRect());
        const layerStyle = getComputedStyle(layer);
        // offsetWidth rounds fractional CSS pixels, which otherwise invents a scale at zoom.
        const layerWidth = cssPixels(layerStyle, "width") || layer.offsetWidth;
        const layerHeight = cssPixels(layerStyle, "height") || layer.offsetHeight;
        const placement = position && selectionBubbleLayerPosition(position, layerBox, layerWidth, layerHeight);
        if (!position || !placement) {
          hide();
          return;
        }
        // Clip only paint beyond the allowed pane/viewport intersection (including shadow tails).
        layer.style.clipPath = `inset(${(bounds.top - layerBox.top) * placement.scaleY}px ${(layerBox.left + layerBox.width - bounds.left - bounds.width) * placement.scaleX}px ${(layerBox.top + layerBox.height - bounds.top - bounds.height) * placement.scaleY}px ${(bounds.left - layerBox.left) * placement.scaleX}px)`;
        if (ownerRef.current !== owner || authorityRef.current !== authority) return;
        const publication = { owner, authority, layer, position, placement };
        publicationRef.current = publication;
        controlCurrent.publishGeometry(publication);
        setGeometry(publication);
      } catch (error) {
        // A replaced editor DOM can invalidate a range between selection and layout updates.
        if (error instanceof RangeError || (error instanceof DOMException && ["IndexSizeError", "InvalidStateError"].includes(error.name))) {
          hide();
          return;
        }
        throw error;
      }
    };
    const schedule = () => {
      if (disposed || frame !== null) return;
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        frame = null;
        compute();
      });
    };
    const onPointerDown = (event: PointerEvent) => {
      if (disposed) return;
      if (event.target instanceof Node && editor.contains(event.target) && !layer.contains(event.target)) {
        pointerDown = true;
        hide();
      }
    };
    const onPointerUp = () => {
      if (disposed) return;
      pointerDown = false;
      schedule();
    };
    const onBlur = (event: FocusEvent) => {
      if (disposed) return;
      if (event.relatedTarget instanceof Node && layer.contains(event.relatedTarget)) return;
      hide();
    };
    const onMutation: MutationCallback = (records) => {
      if (disposed) return;
      if (!records.length || records.some((record) => {
        if (layer.contains(record.target)) return false;
        return record.type !== "childList" || [...record.addedNodes, ...record.removedNodes].some((node) => node !== layer);
      })) schedule();
    };
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    resizeObserver?.observe(scroller);
    resizeObserver?.observe(editor);
    const mutationObserver = new MutationObserver(onMutation);
    mutationObserver.observe(editor, { childList: true, characterData: true, attributes: true, subtree: true });
    // Ancestor attribute changes can move content without resizing the scroller. No document subtree observer.
    for (let ancestor: HTMLElement | null = scroller; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor === editor) continue;
      mutationObserver.observe(ancestor, { attributes: true, attributeFilter: ["style", "class", "dir", "hidden"], childList: ancestor === scroller });
    }
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerUp, { passive: true });
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("fullscreenchange", schedule);
    visualViewport?.addEventListener("resize", schedule, { passive: true });
    visualViewport?.addEventListener("scroll", schedule, { passive: true });
    editor.addEventListener("blur", onBlur);
    editor.addEventListener("load", schedule, true);
    layer.addEventListener("focusout", schedule);
    fonts?.addEventListener("loadingdone", schedule);
    fonts?.addEventListener("loadingerror", schedule);
    void fonts?.ready.then(schedule);
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("fullscreenchange", schedule);
      visualViewport?.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("scroll", schedule);
      editor.removeEventListener("blur", onBlur);
      editor.removeEventListener("load", schedule, true);
      layer.removeEventListener("focusout", schedule);
      fonts?.removeEventListener("loadingdone", schedule);
      fonts?.removeEventListener("loadingerror", schedule);
      resizeObserver?.disconnect();
      observedContent.clear();
      mutationObserver.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (topLayer && layer.matches(":popover-open")) layer.hidePopover();
      removeFullscreenWidget();
      layer.remove();
    };
    const owner = { view, editor, scroller, session, schedule, dispose };
    const authority = { owner, view, session, actions, onLink, onComment };
    ownerRef.current = owner;
    authorityRef.current = authority;
    controlCurrent.publishOwner(owner);
    controlCurrent.publishAuthority(authority);
    owner.schedule();
  });

  useLayoutEffect(() => () => {
    authorityRef.current = null;
    publicationRef.current = null;
    ownerRef.current?.dispose();
    ownerRef.current = null;
    controlCurrent.clear();
  }, [controlCurrent]);

  // Format changes carry every editor selection update into the shared geometry scheduler.
  useLayoutEffect(() => ownerRef.current?.schedule(), [format]);

  const geometryIsCurrent = Boolean(
    geometry &&
    geometry.owner.view === view &&
    geometry.owner.session === session &&
    geometry.authority.owner === geometry.owner &&
    geometry.authority.view === view &&
    geometry.authority.session === session &&
    geometry.authority.actions === actions &&
    geometry.authority.onLink === onLink &&
    geometry.authority.onComment === onComment,
  );
  const canEdit = geometryIsCurrent ? session.canEdit : false;
  const canComment = geometryIsCurrent ? session.canComment : false;
  const activeSurface = geometryIsCurrent ? session.activeSurface : null;
  if (!geometryIsCurrent || !geometry) return null;
  return (
    <SelectionBubbleControls
      geometry={geometry}
      session={session}
      actions={actions}
      format={format}
      onComment={onComment}
      onLink={onLink}
      activeSurface={activeSurface}
      canEdit={canEdit}
      canComment={canComment}
      controlMount={controlMount}
      controlCoordinator={controlCoordinator}
      controlCurrent={controlCurrent}
    />
  );
}
