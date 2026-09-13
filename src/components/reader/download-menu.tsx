"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type Dispatch,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from "react";
import { ChevronDown, Download, FileCode2, FileText } from "lucide-react";

type Format = "md" | "html" | "pdf";
type ExportHrefs = Readonly<Record<Format, string>>;

interface DocumentVisit {
  readonly mount: symbol;
  readonly docId: string;
  readonly hrefs: ExportHrefs;
}

interface DisclosureVisit {
  readonly document: DocumentVisit;
  readonly initialFocus: Format;
  readonly focus: ((this: HTMLElement, options?: FocusOptions) => void) | null;
  readonly keyboardAction: DownloadKeyboardAction | null;
}

interface DownloadState {
  readonly document: DocumentVisit;
  readonly disclosure: DisclosureVisit | null;
}

interface PresentationAuthority {
  readonly document: DocumentVisit;
  readonly sourceState: DownloadState;
  readonly state: DownloadState | null;
  readonly disclosure: DisclosureVisit | null;
  readonly open: boolean;
  readonly focusPublished: boolean;
}

interface LinkPublication {
  readonly format: Format;
  readonly href: string;
  readonly capture: (element: HTMLAnchorElement | null) => void;
  readonly element: () => HTMLAnchorElement | null;
  readonly onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
}

interface DownloadPublication {
  readonly authority: PresentationAuthority;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly root: HTMLDivElement;
  readonly primary: HTMLAnchorElement;
  readonly toggle: HTMLButtonElement;
  readonly list: HTMLDivElement;
  readonly linkElements: Readonly<Record<Format, HTMLAnchorElement>>;
  readonly rootTargets: readonly Node[];
  readonly toggleTargets: readonly Node[];
  readonly linkTargets: Readonly<Record<Format, readonly Node[]>>;
  readonly links: readonly HTMLAnchorElement[];
  readonly keyboard: DownloadKeyboardIntrinsics;
  readonly keyListener: DownloadKeyListener;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
}

interface DownloadPublicationSet {
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly capturePrimary: (element: HTMLAnchorElement | null) => void;
  readonly captureToggle: (element: HTMLButtonElement | null) => void;
  readonly captureList: (element: HTMLDivElement | null) => void;
  readonly links: Readonly<Record<Format, LinkPublication>>;
  readonly establish: () => void | (() => void);
  readonly onToggleClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onToggleKeyDownCapture: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly onToggleKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly onListKeyDownCapture: (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  readonly onListKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onRootKeyDownCapture: (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  readonly onRootKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onRootBlur: (event: ReactFocusEvent<HTMLDivElement>) => void;
}

class CurrentCell<T> {
  constructor(public current: T) {}
}

interface ElementOwnerView {
  readonly element: () => HTMLElement | null;
}

class ElementOwner<T extends HTMLElement> implements ElementOwnerView {
  private current: T | null = null;
  private lastElement: T | null = null;

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
    if (
      element &&
      this.lastElement &&
      element !== this.lastElement &&
      !element.isConnected
    ) {
      return;
    }
    const previous = this.current;
    const last = this.lastElement;
    const replaced = element !== null && last !== null && last !== element;
    this.current = element;
    if (element) this.lastElement = element;
    if (replaced || element === null || previous !== element) {
      this.onChange(this, element, previous, last);
    }
  };
}

interface PublicationCells {
  readonly active: CurrentCell<DownloadPublication | null>;
  readonly readingKeyboard: CurrentCell<boolean>;
  readonly successorOf: CurrentCell<DownloadPublication | null>;
  readonly replay: CurrentCell<DownloadReplay | null>;
  readonly focused: WeakSet<DisclosureVisit>;
  readonly claimedEvents: WeakSet<Event>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedKeyboardPublications: WeakSet<DownloadPublication>;
  readonly claimedKeyboardActions: WeakSet<DownloadKeyboardAction>;
  readonly activeKeyboardActions: WeakMap<
    DownloadPublication,
    DownloadKeyboardAction
  >;
  readonly claimedSources: WeakMap<
    HTMLElement,
    DownloadKeyboardAction
  >;
  readonly claimedDestinations: WeakMap<
    HTMLElement,
    DownloadKeyboardAction
  >;
  readonly reactKeys: WeakMap<
    DownloadPublication,
    WeakMap<KeyboardEvent, DownloadReactKey>
  >;
}

interface DownloadTrustedAuthority {
  readonly read: (event: object) => boolean;
  readonly matches: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}

interface DownloadKeyboardIntrinsics {
  readonly ownerWindow: Window & typeof globalThis;
  readonly listenerTarget: Window & typeof globalThis;
  readonly keyboardPrototype: object;
  readonly capturingPhase: number;
  readonly bubblingPhase: number;
  readonly apply: typeof Reflect.apply;
  readonly getPrototypeOf: typeof Object.getPrototypeOf;
  readonly trusted: DownloadTrustedAuthority;
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
    preventDefault: (this: Event) => void;
  }>;
  readonly keyboard: Readonly<{
    key: (this: KeyboardEvent) => string;
    code: (this: KeyboardEvent) => string;
    location: (this: KeyboardEvent) => number;
    altKey: (this: KeyboardEvent) => boolean;
    ctrlKey: (this: KeyboardEvent) => boolean;
    metaKey: (this: KeyboardEvent) => boolean;
    shiftKey: (this: KeyboardEvent) => boolean;
    repeat: (this: KeyboardEvent) => boolean;
    isComposing: (this: KeyboardEvent) => boolean;
  }>;
  readonly view: (this: UIEvent) => Window | null;
  readonly activeElement: (this: Document) => Element | null;
  readonly focus: (this: HTMLElement, options?: FocusOptions) => void;
  readonly addEventListener: DownloadWindowMethod<Window["addEventListener"]>;
  readonly removeEventListener: DownloadWindowMethod<
    Window["removeEventListener"]
  >;
  readonly isCurrent: () => boolean;
}

interface DownloadKeyboardSnapshot {
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

interface DownloadWindowMethod<Method> {
  readonly value: Method;
  readonly isCurrent: () => boolean;
}

interface DownloadWindowProof {
  readonly identity: symbol;
  readonly publication: DownloadPublication;
  readonly nativeEvent: KeyboardEvent;
  readonly source: HTMLElement;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly snapshot: DownloadKeyboardSnapshot;
}

interface DownloadKeyListener {
  readonly listener: EventListener;
  readonly activate: (publication: DownloadPublication) => boolean;
  readonly proofFor: (
    event: KeyboardEvent,
    publication: DownloadPublication,
  ) => DownloadWindowProof | null;
  readonly claim: (
    proof: DownloadWindowProof,
    publication: DownloadPublication,
  ) => boolean;
  readonly retains: (
    proof: DownloadWindowProof,
    publication: DownloadPublication,
  ) => boolean;
  readonly release: (publication: DownloadPublication) => void;
}

interface DownloadReactCancellation {
  readonly preventDefault: () => void;
  readonly isDefaultPrevented: () => boolean;
  readonly isPropagationStopped: () => boolean;
}

interface DownloadReactKey {
  readonly event: ReactKeyboardEvent<HTMLElement>;
  readonly nativeEvent: KeyboardEvent;
  readonly listenerProof: DownloadWindowProof;
  readonly source: HTMLElement;
  readonly boundary: HTMLElement;
  readonly snapshot: DownloadKeyboardSnapshot;
  readonly cancellation: DownloadReactCancellation;
}

type DownloadKeyboardActionKind = "open" | "move" | "escape";

interface DownloadKeyboardAction {
  readonly identity: symbol;
  readonly kind: DownloadKeyboardActionKind;
  readonly publication: DownloadPublication;
  readonly source: HTMLElement;
  readonly destination: HTMLElement;
  readonly nativeEvent: KeyboardEvent;
  readonly focus: (this: HTMLElement, options?: FocusOptions) => void;
  readonly capture: DownloadReactKey;
  readonly bubble: DownloadReactKey;
  claimed: boolean;
  sourceClaimed: boolean;
  destinationClaimed: boolean;
  focusClaimed: boolean;
}

interface DownloadDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly DownloadDomSnapshot[];
}

interface DownloadPlacement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface DownloadReplay {
  readonly source: DownloadPublication;
  readonly dom: DownloadDomSnapshot;
  readonly placement: DownloadPlacement;
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

interface RefReplay {
  readonly owner: ElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface DownloadPublicationRuntime {
  readonly publication: DownloadPublication;
  readonly publish: (
    snapshot: DownloadDomSnapshot,
    placement: DownloadPlacement,
    owners: readonly ElementOwnerView[],
  ) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly focusFactsMatch: () => boolean;
  readonly focusDisclosure: () => boolean;
  readonly installPointer: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replayDomUnchanged: () => boolean;
  readonly releaseReplayGuard: () => void;
  readonly snapshot: () => DownloadDomSnapshot | null;
  readonly placement: () => DownloadPlacement | null;
}

const ROWS: { format: Format; label: string; Icon: typeof Download }[] = [
  { format: "md", label: "Markdown", Icon: Download },
  { format: "html", label: "HTML", Icon: FileCode2 },
  { format: "pdf", label: "PDF", Icon: FileText },
];
const FORMATS = ROWS.map(({ format }) => format);
const LIST_ID = "reader-download-list";
const PREVENT_SCROLL = Object.freeze({ preventScroll: true });

function exportHref(docId: string, format: Format) {
  return `/api/documents/${docId}/export?format=${format}&download=1`;
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotDownloadDom(node: Node): DownloadDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotDownloadDom)),
  });
}

function downloadDomMatches(snapshot: DownloadDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = snapshotAttributes(node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length ||
    attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || name !== expected[0] || value !== expected[1];
    })
  ) {
    return false;
  }
  return (
    node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        node.childNodes.item(index) === child.node && downloadDomMatches(child),
    )
  );
}

function captureDownloadPlacement(root: HTMLDivElement): DownloadPlacement | null {
  const parent = root.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: root.ownerDocument,
    parent,
    previousSibling: root.previousSibling,
    nextSibling: root.nextSibling,
  });
}

function downloadPlacementMatches(
  root: HTMLDivElement,
  placement: DownloadPlacement,
): boolean {
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

function downloadDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
): boolean {
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

function captureDownloadWindowMethod<
  Property extends "addEventListener" | "removeEventListener",
>(
  ownerWindow: Window & typeof globalThis,
  property: Property,
): DownloadWindowMethod<Window[Property]> | null {
  const getOwnPropertyDescriptor =
    ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const reflectGet = ownerWindow.Reflect.get;
  const path: {
    readonly target: object;
    readonly descriptor: Readonly<PropertyDescriptor> | null;
    readonly prototype: object | null;
  }[] = [];
  let target: object | null = ownerWindow;
  let found = false;
  while (target) {
    const descriptor = getOwnPropertyDescriptor(target, property);
    const prototype = getPrototypeOf(target) as object | null;
    path.push(
      Object.freeze({
        target,
        descriptor: descriptor ? Object.freeze({ ...descriptor }) : null,
        prototype,
      }),
    );
    if (descriptor) {
      found = true;
      break;
    }
    target = prototype;
  }
  const value = reflectGet(
    ownerWindow,
    property,
    ownerWindow,
  ) as Window[Property];
  if (!found || typeof value !== "function") return null;
  let historyIsClean = true;
  const isCurrent = () => {
    if (!historyIsClean) return false;
    historyIsClean =
      ownerWindow.Object.getOwnPropertyDescriptor ===
        getOwnPropertyDescriptor &&
      ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
      ownerWindow.Reflect.get === reflectGet &&
      path.every(
        ({ target: entry, descriptor, prototype }) =>
          getPrototypeOf(entry) === prototype &&
          (descriptor
            ? downloadDescriptorsMatch(
                getOwnPropertyDescriptor(entry, property),
                descriptor,
              )
            : getOwnPropertyDescriptor(entry, property) === undefined),
      ) &&
      reflectGet(ownerWindow, property, ownerWindow) === value;
    return historyIsClean;
  };
  return isCurrent() ? Object.freeze({ value, isCurrent }) : null;
}

function captureDownloadTrustedAuthority(
  ownerWindow: Window & typeof globalThis,
): DownloadTrustedAuthority | null {
  let probe: KeyboardEvent;
  try {
    probe = new ownerWindow.KeyboardEvent("download-keyboard-intrinsic");
  } catch {
    return null;
  }
  const getOwnPropertyDescriptor =
    ownerWindow.Object.getOwnPropertyDescriptor;
  const apply = ownerWindow.Reflect.apply;
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
  const matches = (event: object) =>
    downloadDescriptorsMatch(
      getOwnPropertyDescriptor(event, "isTrusted"),
      expected,
    );
  return Object.freeze({
    matches,
    read: (event: object) =>
      apply(descriptor.get as (this: object) => boolean, event, []),
    isCurrent: () =>
      ownerWindow.Object.getOwnPropertyDescriptor ===
        getOwnPropertyDescriptor &&
      ownerWindow.Reflect.apply === apply &&
      matches(probe),
  });
}

function captureDownloadKeyboardIntrinsics(
  ownerWindow: Window & typeof globalThis,
): DownloadKeyboardIntrinsics | null {
  const objectConstructor = ownerWindow.Object;
  const reflect = ownerWindow.Reflect;
  const eventConstructor = ownerWindow.Event;
  const keyboardConstructor = ownerWindow.KeyboardEvent;
  const uiEventConstructor = ownerWindow.UIEvent;
  const documentConstructor = ownerWindow.Document;
  const htmlElementConstructor = ownerWindow.HTMLElement;
  const eventPrototype = eventConstructor.prototype;
  const keyboardPrototype = keyboardConstructor.prototype;
  const uiEventPrototype = uiEventConstructor.prototype;
  const documentPrototype = documentConstructor.prototype;
  const htmlElementPrototype = htmlElementConstructor.prototype;
  const getOwnPropertyDescriptor =
    objectConstructor.getOwnPropertyDescriptor;
  const getPrototypeOf = objectConstructor.getPrototypeOf;
  const apply = reflect.apply;
  const descriptorProofs: {
    readonly target: object;
    readonly property: PropertyKey;
    readonly descriptor: Readonly<PropertyDescriptor>;
  }[] = [];
  const getter = <This extends object, Value>(
    target: object,
    property: PropertyKey,
  ): ((this: This) => Value) | null => {
    const descriptor = getOwnPropertyDescriptor(target, property);
    if (!descriptor || typeof descriptor.get !== "function") return null;
    descriptorProofs.push(
      Object.freeze({
        target,
        property,
        descriptor: Object.freeze({ ...descriptor }),
      }),
    );
    return descriptor.get as (this: This) => Value;
  };
  const method = <
    This extends object,
    Args extends readonly unknown[],
    Result,
  >(
    target: object,
    property: PropertyKey,
  ): ((this: This, ...args: Args) => Result) | null => {
    const descriptor = getOwnPropertyDescriptor(target, property);
    if (!descriptor || typeof descriptor.value !== "function") return null;
    descriptorProofs.push(
      Object.freeze({
        target,
        property,
        descriptor: Object.freeze({ ...descriptor }),
      }),
    );
    return descriptor.value as (this: This, ...args: Args) => Result;
  };
  const trusted = captureDownloadTrustedAuthority(ownerWindow);
  const type = getter<Event, string>(eventPrototype, "type");
  const target = getter<Event, EventTarget | null>(
    eventPrototype,
    "target",
  );
  const currentTarget = getter<Event, EventTarget | null>(
    eventPrototype,
    "currentTarget",
  );
  const eventPhase = getter<Event, number>(
    eventPrototype,
    "eventPhase",
  );
  const bubbles = getter<Event, boolean>(eventPrototype, "bubbles");
  const cancelable = getter<Event, boolean>(
    eventPrototype,
    "cancelable",
  );
  const defaultPrevented = getter<Event, boolean>(
    eventPrototype,
    "defaultPrevented",
  );
  const cancelBubble = getter<Event, boolean>(
    eventPrototype,
    "cancelBubble",
  );
  const key = getter<KeyboardEvent, string>(keyboardPrototype, "key");
  const code = getter<KeyboardEvent, string>(
    keyboardPrototype,
    "code",
  );
  const location = getter<KeyboardEvent, number>(
    keyboardPrototype,
    "location",
  );
  const altKey = getter<KeyboardEvent, boolean>(
    keyboardPrototype,
    "altKey",
  );
  const ctrlKey = getter<KeyboardEvent, boolean>(
    keyboardPrototype,
    "ctrlKey",
  );
  const metaKey = getter<KeyboardEvent, boolean>(
    keyboardPrototype,
    "metaKey",
  );
  const shiftKey = getter<KeyboardEvent, boolean>(
    keyboardPrototype,
    "shiftKey",
  );
  const repeat = getter<KeyboardEvent, boolean>(
    keyboardPrototype,
    "repeat",
  );
  const isComposing = getter<KeyboardEvent, boolean>(
    keyboardPrototype,
    "isComposing",
  );
  const view = getter<UIEvent, Window | null>(
    uiEventPrototype,
    "view",
  );
  const activeElement = getter<Document, Element | null>(
    documentPrototype,
    "activeElement",
  );
  const composedPath = method<Event, readonly [], EventTarget[]>(
    eventPrototype,
    "composedPath",
  );
  const preventDefault = method<Event, readonly [], void>(
    eventPrototype,
    "preventDefault",
  );
  const focus = method<
    HTMLElement,
    readonly [FocusOptions?],
    void
  >(htmlElementPrototype, "focus");
  const addEventListener = captureDownloadWindowMethod(
    ownerWindow,
    "addEventListener",
  );
  const removeEventListener = captureDownloadWindowMethod(
    ownerWindow,
    "removeEventListener",
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
    !composedPath ||
    !preventDefault ||
    !focus ||
    !addEventListener ||
    !removeEventListener ||
    typeof apply !== "function" ||
    typeof getPrototypeOf !== "function"
  ) {
    return null;
  }
  let historyIsClean = true;
  const isCurrent = () => {
    if (!historyIsClean) return false;
    try {
      historyIsClean =
        ownerWindow.Object === objectConstructor &&
        ownerWindow.Reflect === reflect &&
        ownerWindow.Event === eventConstructor &&
        ownerWindow.KeyboardEvent === keyboardConstructor &&
        ownerWindow.UIEvent === uiEventConstructor &&
        ownerWindow.Document === documentConstructor &&
        ownerWindow.HTMLElement === htmlElementConstructor &&
        eventConstructor.prototype === eventPrototype &&
        keyboardConstructor.prototype === keyboardPrototype &&
        uiEventConstructor.prototype === uiEventPrototype &&
        documentConstructor.prototype === documentPrototype &&
        htmlElementConstructor.prototype === htmlElementPrototype &&
        ownerWindow.Object.getOwnPropertyDescriptor ===
          getOwnPropertyDescriptor &&
        ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
        ownerWindow.Reflect.apply === apply &&
        descriptorProofs.every(({ target, property, descriptor }) =>
          downloadDescriptorsMatch(
            getOwnPropertyDescriptor(target, property),
            descriptor,
          ),
        ) &&
        addEventListener.isCurrent() &&
        removeEventListener.isCurrent() &&
        trusted.isCurrent();
    } catch {
      historyIsClean = false;
    }
    return historyIsClean;
  };
  const intrinsics: DownloadKeyboardIntrinsics = {
    ownerWindow,
    listenerTarget: ownerWindow,
    keyboardPrototype,
    capturingPhase: eventConstructor.CAPTURING_PHASE,
    bubblingPhase: eventConstructor.BUBBLING_PHASE,
    apply,
    getPrototypeOf,
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
      preventDefault,
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
    addEventListener,
    removeEventListener,
    isCurrent,
  };
  return isCurrent() ? Object.freeze(intrinsics) : null;
}

function readDownloadKeyboardEvent(
  event: Event,
  intrinsics: DownloadKeyboardIntrinsics,
): DownloadKeyboardSnapshot | null {
  try {
    if (
      intrinsics.getPrototypeOf(event) !== intrinsics.keyboardPrototype ||
      !intrinsics.isCurrent() ||
      !intrinsics.trusted.matches(event)
    ) {
      return null;
    }
    return Object.freeze({
      type: intrinsics.apply(intrinsics.event.type, event, []),
      target: intrinsics.apply(intrinsics.event.target, event, []),
      currentTarget: intrinsics.apply(
        intrinsics.event.currentTarget,
        event,
        [],
      ),
      eventPhase: intrinsics.apply(
        intrinsics.event.eventPhase,
        event,
        [],
      ),
      bubbles: intrinsics.apply(intrinsics.event.bubbles, event, []),
      cancelable: intrinsics.apply(
        intrinsics.event.cancelable,
        event,
        [],
      ),
      defaultPrevented: intrinsics.apply(
        intrinsics.event.defaultPrevented,
        event,
        [],
      ),
      cancelBubble: intrinsics.apply(
        intrinsics.event.cancelBubble,
        event,
        [],
      ),
      path: Object.freeze(
        intrinsics.apply(intrinsics.event.composedPath, event, []),
      ),
      key: intrinsics.apply(intrinsics.keyboard.key, event, []),
      code: intrinsics.apply(intrinsics.keyboard.code, event, []),
      location: intrinsics.apply(
        intrinsics.keyboard.location,
        event,
        [],
      ),
      altKey: intrinsics.apply(intrinsics.keyboard.altKey, event, []),
      ctrlKey: intrinsics.apply(intrinsics.keyboard.ctrlKey, event, []),
      metaKey: intrinsics.apply(intrinsics.keyboard.metaKey, event, []),
      shiftKey: intrinsics.apply(
        intrinsics.keyboard.shiftKey,
        event,
        [],
      ),
      repeat: intrinsics.apply(intrinsics.keyboard.repeat, event, []),
      isComposing: intrinsics.apply(
        intrinsics.keyboard.isComposing,
        event,
        [],
      ),
      isTrusted: intrinsics.trusted.read(event),
      view: intrinsics.apply(intrinsics.view, event, []),
    });
  } catch {
    return null;
  }
}

function downloadKeyboardFactsMatch(
  left: DownloadKeyboardSnapshot,
  right: DownloadKeyboardSnapshot,
): boolean {
  return (
    left.type === right.type &&
    left.target === right.target &&
    left.currentTarget === right.currentTarget &&
    left.eventPhase === right.eventPhase &&
    left.bubbles === right.bubbles &&
    left.cancelable === right.cancelable &&
    left.defaultPrevented === right.defaultPrevented &&
    left.cancelBubble === right.cancelBubble &&
    left.key === right.key &&
    left.code === right.code &&
    left.location === right.location &&
    left.altKey === right.altKey &&
    left.ctrlKey === right.ctrlKey &&
    left.metaKey === right.metaKey &&
    left.shiftKey === right.shiftKey &&
    left.repeat === right.repeat &&
    left.isComposing === right.isComposing &&
    left.isTrusted === right.isTrusted &&
    left.view === right.view &&
    left.path.length === right.path.length &&
    left.path.every((entry, index) => right.path[index] === entry)
  );
}

function downloadKeyboardStableFactsMatch(
  left: DownloadKeyboardSnapshot,
  right: DownloadKeyboardSnapshot,
): boolean {
  return (
    left.type === right.type &&
    left.target === right.target &&
    left.bubbles === right.bubbles &&
    left.cancelable === right.cancelable &&
    left.defaultPrevented === right.defaultPrevented &&
    left.cancelBubble === right.cancelBubble &&
    left.key === right.key &&
    left.code === right.code &&
    left.location === right.location &&
    left.altKey === right.altKey &&
    left.ctrlKey === right.ctrlKey &&
    left.metaKey === right.metaKey &&
    left.shiftKey === right.shiftKey &&
    left.repeat === right.repeat &&
    left.isComposing === right.isComposing &&
    left.isTrusted === right.isTrusted &&
    left.view === right.view &&
    left.path.length === right.path.length &&
    left.path.every((entry, index) => right.path[index] === entry)
  );
}

function downloadKeyboardPathMatches(
  path: readonly EventTarget[],
  source: HTMLElement,
  ownerDocument: Document,
  terminal: EventTarget,
): boolean {
  const expected: EventTarget[] = [];
  let current: Node | null = source;
  while (current) {
    expected.push(current);
    if (current === ownerDocument) break;
    current = current.parentNode;
  }
  return (
    expected.at(-1) === ownerDocument &&
    path.length === expected.length + 1 &&
    expected.every((entry, index) => path[index] === entry) &&
    path.at(-1) === terminal
  );
}

function readDownloadReactCancellation(
  event: ReactKeyboardEvent<HTMLElement>,
  isCurrent: () => boolean,
): DownloadReactCancellation | null {
  try {
    const preventDefault = event.preventDefault;
    if (!isCurrent() || typeof preventDefault !== "function") return null;
    const isDefaultPrevented = event.isDefaultPrevented;
    if (!isCurrent() || typeof isDefaultPrevented !== "function") return null;
    const isPropagationStopped = event.isPropagationStopped;
    if (
      !isCurrent() ||
      typeof isPropagationStopped !== "function"
    ) {
      return null;
    }
    return Object.freeze({
      preventDefault,
      isDefaultPrevented,
      isPropagationStopped,
    });
  } catch {
    return null;
  }
}

function downloadReactCancellationMatches(
  event: ReactKeyboardEvent<HTMLElement>,
  expected: DownloadReactCancellation,
  isCurrent: () => boolean,
  defaultQuery = expected.isDefaultPrevented,
): boolean {
  try {
    const isDefaultPrevented = event.isDefaultPrevented;
    if (!isCurrent() || isDefaultPrevented !== defaultQuery) return false;
    const isPropagationStopped = event.isPropagationStopped;
    if (!isCurrent() || isPropagationStopped !== expected.isPropagationStopped) return false;
    const preventDefault = event.preventDefault;
    return isCurrent() && preventDefault === expected.preventDefault;
  } catch {
    return false;
  }
}

function downloadReactPredicatesMatch(
  proof: DownloadReactKey,
  keyboard: DownloadKeyboardIntrinsics,
  revalidate: () => boolean,
  isCurrent: () => boolean,
  defaultPrevented = false,
  defaultQuery = proof.cancellation.isDefaultPrevented,
): boolean {
  try {
    const event = proof.event;
    // Every public walk precedes the selected callable's final identity read.
    return (
      revalidate() &&
      event.isDefaultPrevented === defaultQuery &&
      isCurrent() &&
      keyboard.apply(defaultQuery, event, []) === defaultPrevented &&
      isCurrent() &&
      revalidate() &&
      event.isPropagationStopped === proof.cancellation.isPropagationStopped &&
      isCurrent() &&
      keyboard.apply(proof.cancellation.isPropagationStopped, event, []) === false &&
      isCurrent() &&
      revalidate()
    );
  } catch {
    return false;
  }
}

function downloadReactKeyMatches(
  proof: DownloadReactKey,
  isCurrent: () => boolean,
  retained = false,
  defaultPrevented = false,
  defaultQuery = proof.cancellation.isDefaultPrevented,
): boolean {
  const { event, snapshot } = proof;
  try {
    const matches = (
      property: keyof ReactKeyboardEvent<HTMLElement>,
      expected: unknown,
    ) => {
      const value = event[property];
      return isCurrent() && Object.is(value, expected);
    };
    const currentTarget = event.currentTarget;
    return (
      isCurrent() &&
      (currentTarget === proof.boundary || (retained && currentTarget === null)) &&
      matches("nativeEvent", proof.nativeEvent) &&
      matches("type", snapshot.type) &&
      matches("target", proof.source) &&
      matches("eventPhase", snapshot.eventPhase) &&
      matches("bubbles", snapshot.bubbles) &&
      matches("cancelable", snapshot.cancelable) &&
      matches("defaultPrevented", defaultPrevented) &&
      matches("isTrusted", snapshot.isTrusted) &&
      matches("key", snapshot.key) &&
      matches("code", snapshot.code) &&
      matches("location", snapshot.location) &&
      matches("altKey", snapshot.altKey) &&
      matches("ctrlKey", snapshot.ctrlKey) &&
      matches("metaKey", snapshot.metaKey) &&
      matches("shiftKey", snapshot.shiftKey) &&
      matches("repeat", snapshot.repeat) &&
      matches("view", snapshot.view) &&
      downloadReactCancellationMatches(event, proof.cancellation, isCurrent, defaultQuery)
    );
  } catch {
    return false;
  }
}

function readDownloadReactRoute(
  event: ReactKeyboardEvent<HTMLElement>,
  isCurrent: () => boolean,
) {
  try {
    const key = event.key;
    if (!isCurrent()) return null;
    const nativeEvent = event.nativeEvent;
    return isCurrent() && nativeEvent && typeof nativeEvent === "object"
      ? { key, nativeEvent }
      : null;
  } catch {
    return null;
  }
}

function preventDownloadReactKey(
  proof: DownloadReactKey,
  keyboard: DownloadKeyboardIntrinsics,
  claim: () => boolean,
  isCurrent: () => boolean,
): (() => boolean) | null {
  try {
    const event = proof.event;
    if (
      event.preventDefault !== proof.cancellation.preventDefault ||
      !isCurrent() ||
      !claim()
    ) {
      return null;
    }
    keyboard.apply(proof.cancellation.preventDefault, event, []);
    // React 19 replaces this query on the prevented wrapper, not on its capture.
    const defaultQuery = event.isDefaultPrevented;
    return isCurrent() && typeof defaultQuery === "function" ? defaultQuery : null;
  } catch {
    return null;
  }
}

function readDownloadReactKey(
  event: ReactKeyboardEvent<HTMLElement>,
  nativeEvent: KeyboardEvent,
  boundary: HTMLElement,
  publication: DownloadPublication,
  expectedPhase: number,
  isCurrent: () => boolean,
): DownloadReactKey | null {
  const keyboard = publication.keyboard;
  const listenerProof = publication.keyListener.proofFor(
    nativeEvent,
    publication,
  );
  const snapshot = listenerProof
    ? readDownloadKeyboardEvent(nativeEvent, keyboard)
    : null;
  const cancellation = snapshot
    ? readDownloadReactCancellation(event, isCurrent)
    : null;
  const source = listenerProof?.source ?? null;
  if (
    !listenerProof ||
    !snapshot ||
    !cancellation ||
    !source ||
    !isCurrent() ||
    event === (nativeEvent as unknown) ||
    snapshot.type !== "keydown" ||
    snapshot.target !== source ||
    snapshot.currentTarget === null ||
    snapshot.eventPhase !== expectedPhase ||
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
    (snapshot.view !== null && snapshot.view !== keyboard.ownerWindow) ||
    !snapshot.path.includes(boundary) ||
    snapshot.path.filter((entry) => entry === boundary).length !== 1 ||
    !downloadKeyboardPathMatches(
      snapshot.path,
      source,
      publication.ownerDocument,
      listenerProof.receiver,
    )
  ) {
    return null;
  }
  const proof: DownloadReactKey = Object.freeze({
    event,
    boundary,
    source,
    nativeEvent,
    listenerProof,
    snapshot,
    cancellation,
  });
  const revalidate = () => {
    if (!isCurrent() || !downloadReactKeyMatches(proof, isCurrent)) return false;
    const current = readDownloadKeyboardEvent(nativeEvent, keyboard);
    return !!current && downloadKeyboardFactsMatch(snapshot, current) && isCurrent();
  };
  return downloadReactPredicatesMatch(proof, keyboard, revalidate, isCurrent)
    ? proof
    : null;
}

function downloadReactKeyPairMatches(
  capture: DownloadReactKey,
  bubble: DownloadReactKey,
  publication: DownloadPublication,
): boolean {
  const keyboard = publication.keyboard;
  return (
    capture.event !== bubble.event &&
    capture.boundary === bubble.boundary &&
    capture.source === bubble.source &&
    capture.nativeEvent === bubble.nativeEvent &&
    capture.listenerProof === bubble.listenerProof &&
    capture.listenerProof.publication === publication &&
    capture.listenerProof.nativeEvent === capture.nativeEvent &&
    capture.listenerProof.source === capture.source &&
    capture.listenerProof.receiver ===
      capture.listenerProof.currentTarget &&
    capture.listenerProof.receiver === capture.listenerProof.terminal &&
    capture.snapshot.eventPhase === keyboard.capturingPhase &&
    bubble.snapshot.eventPhase === keyboard.bubblingPhase &&
    downloadKeyboardStableFactsMatch(capture.snapshot, bubble.snapshot) &&
    downloadKeyboardPathMatches(
      capture.snapshot.path,
      capture.source,
      publication.ownerDocument,
      capture.listenerProof.receiver,
    ) &&
    downloadKeyboardPathMatches(
      bubble.snapshot.path,
      bubble.source,
      publication.ownerDocument,
      bubble.listenerProof.receiver,
    )
  );
}

function createDownloadKeyListener(
  keyboard: DownloadKeyboardIntrinsics,
): DownloadKeyListener {
  let proofs = new WeakMap<KeyboardEvent, DownloadWindowProof>();
  let invalidEvents = new WeakSet<Event>();
  let claimedProofs = new WeakSet<object>();
  let publication: DownloadPublication | null = null;
  let active = false;
  let released = false;

  const listener = function (this: EventTarget, event: Event) {
    const current = publication;
    if (
      !current ||
      !active ||
      released ||
      current.keyListener !== registration ||
      current.isRetired() ||
      invalidEvents.has(event) ||
      keyboard.getPrototypeOf(event) !== keyboard.keyboardPrototype ||
      !keyboard.isCurrent()
    ) {
      return;
    }
    const nativeEvent = event as KeyboardEvent;
    if (proofs.has(nativeEvent)) {
      invalidEvents.add(nativeEvent);
      return;
    }
    const snapshot = readDownloadKeyboardEvent(nativeEvent, keyboard);
    const target = snapshot?.target;
    const source =
      target === current.root ||
      target === current.toggle ||
      target === current.list ||
      current.links.some((link) => target === link)
        ? (target as HTMLElement)
        : null;
    const terminal = snapshot?.path.at(-1);
    if (
      !snapshot ||
      !source ||
      !terminal ||
      snapshot.currentTarget !== this ||
      terminal !== this ||
      snapshot.eventPhase !== keyboard.capturingPhase ||
      !downloadKeyboardPathMatches(
        snapshot.path,
        source,
        current.ownerDocument,
        this,
      )
    ) {
      return;
    }
    proofs.set(
      nativeEvent,
      Object.freeze({
        identity: Symbol("reader-download-window-key-proof"),
        publication: current,
        nativeEvent,
        source,
        receiver: this,
        currentTarget: this,
        terminal,
        snapshot,
      }),
    );
  };

  const proofFor = (
    event: KeyboardEvent,
    current: DownloadPublication,
  ) => {
    const proof = proofs.get(event);
    if (
      !proof ||
      !active ||
      released ||
      publication !== current ||
      current.keyListener !== registration ||
      current.isRetired() ||
      proof.publication !== current ||
      proof.nativeEvent !== event ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      invalidEvents.has(event) ||
      !keyboard.isCurrent()
    ) {
      return null;
    }
    const snapshot = readDownloadKeyboardEvent(event, keyboard);
    return snapshot &&
      downloadKeyboardStableFactsMatch(proof.snapshot, snapshot) &&
      downloadKeyboardPathMatches(
        snapshot.path,
        proof.source,
        current.ownerDocument,
        proof.receiver,
      )
      ? proof
      : null;
  };

  const registration: DownloadKeyListener = Object.freeze({
    listener,
    activate: (current: DownloadPublication) => {
      if (
        publication ||
        active ||
        released ||
        current.keyListener !== registration ||
        current.keyboard !== keyboard ||
        current.ownerDocument.defaultView !== keyboard.ownerWindow ||
        !keyboard.isCurrent()
      ) {
        return false;
      }
      publication = current;
      active = true;
      try {
        keyboard.apply(
          keyboard.addEventListener.value,
          keyboard.listenerTarget,
          ["keydown", listener, true],
        );
      } catch {
        active = false;
        publication = null;
        return false;
      }
      if (keyboard.isCurrent()) return true;
      active = false;
      publication = null;
      keyboard.apply(
        keyboard.removeEventListener.value,
        keyboard.listenerTarget,
        ["keydown", listener, true],
      );
      return false;
    },
    proofFor,
    claim: (
      proof: DownloadWindowProof,
      current: DownloadPublication,
    ) => {
      if (
        claimedProofs.has(proof) ||
        proofFor(proof.nativeEvent, current) !== proof
      ) {
        return false;
      }
      claimedProofs.add(proof);
      return true;
    },
    retains: (
      proof: DownloadWindowProof,
      current: DownloadPublication,
    ) =>
      publication === current &&
      current.keyListener === registration &&
      claimedProofs.has(proof) &&
      proofs.get(proof.nativeEvent) === proof &&
      proof.publication === current &&
      proof.receiver === proof.currentTarget &&
      proof.receiver === proof.terminal &&
      !invalidEvents.has(proof.nativeEvent) &&
      active &&
      !released &&
      keyboard.isCurrent(),
    release: (current: DownloadPublication) => {
      if (publication !== current || released) return;
      released = true;
      const wasActive = active;
      active = false;
      publication = null;
      proofs = new WeakMap();
      invalidEvents = new WeakSet();
      claimedProofs = new WeakSet();
      if (wasActive) {
        keyboard.apply(
          keyboard.removeEventListener.value,
          keyboard.listenerTarget,
          ["keydown", listener, true],
        );
      }
    },
  });
  return registration;
}

function isNodeFromDocument(
  value: EventTarget | null,
  ownerDocument: Document,
): value is Node {
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

function authoritiesMatch(
  previous: PresentationAuthority,
  current: PresentationAuthority,
): boolean {
  return (
    previous.document === current.document &&
    previous.document.mount === current.document.mount &&
    previous.document.docId === current.document.docId &&
    previous.document.hrefs === current.document.hrefs &&
    FORMATS.every(
      (format) =>
        previous.document.hrefs[format] === current.document.hrefs[format],
    ) &&
    previous.sourceState === current.sourceState &&
    previous.state === current.state &&
    previous.disclosure === current.disclosure &&
    previous.open === current.open &&
    previous.focusPublished === current.focusPublished
  );
}

function createDownloadPublication({
  authority,
  cells,
  setState,
  requestSuccessor,
}: {
  authority: PresentationAuthority;
  cells: PublicationCells;
  setState: Dispatch<SetStateAction<DownloadState>>;
  requestSuccessor: () => void;
}): DownloadPublicationSet {
  const mount = authority.document.mount;
  const docId = authority.document.docId;
  const hrefs = authority.document.hrefs;
  const sourceState = authority.sourceState;
  let currentRuntime: DownloadPublicationRuntime | null = null;
  let lastRuntime: DownloadPublicationRuntime | null = null;
  let successorRequested = false;

  const factsAreCurrent = (runtime?: DownloadPublicationRuntime) => {
    const focusFactsMatch = runtime
      ? runtime.focusFactsMatch()
      : authority.disclosure
        ? cells.focused.has(authority.disclosure) === authority.focusPublished
        : !authority.focusPublished;
    return (
      Object.isFrozen(authority) &&
      Object.isFrozen(authority.document) &&
      Object.isFrozen(authority.document.hrefs) &&
      Object.isFrozen(authority.sourceState) &&
      (!authority.disclosure || Object.isFrozen(authority.disclosure)) &&
      authority.document.mount === mount &&
      authority.document.docId === docId &&
      authority.document.hrefs === hrefs &&
      FORMATS.every(
        (format) => hrefs[format] === exportHref(docId, format),
      ) &&
      authority.open === (authority.disclosure !== null) &&
      authority.sourceState === sourceState &&
      authority.state ===
        (sourceState.document === authority.document ? sourceState : null) &&
      (!authority.state ||
        (authority.state.document === authority.document &&
          authority.state.disclosure === authority.disclosure)) &&
      (!authority.disclosure ||
        (Object.isFrozen(authority.disclosure) &&
          authority.disclosure.document === authority.document &&
          FORMATS.includes(authority.disclosure.initialFocus) &&
          (authority.disclosure.focus === null ||
            typeof authority.disclosure.focus === "function") &&
          (authority.disclosure.keyboardAction === null ||
            (authority.disclosure.keyboardAction.kind === "open" &&
              authority.disclosure.keyboardAction.destinationClaimed &&
              authority.disclosure.keyboardAction.destination ===
                authority.disclosure.keyboardAction.publication
                  .linkElements[authority.disclosure.initialFocus] &&
              authority.disclosure.focus ===
                authority.disclosure.keyboardAction.focus)))) &&
      focusFactsMatch
    );
  };

  const requestReplaySuccessor = (runtime: DownloadPublicationRuntime) => {
    const snapshot = runtime.snapshot();
    const placement = runtime.placement();
    if (
      successorRequested ||
      !snapshot ||
      !placement ||
      cells.successorOf.current !== runtime.publication ||
      !factsAreCurrent(runtime) ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches()
    ) {
      return;
    }
    successorRequested = true;
    cells.replay.current = Object.freeze({
      source: runtime.publication,
      dom: snapshot,
      placement,
      unchanged: runtime.replayDomUnchanged,
      release: runtime.releaseReplayGuard,
    });
    requestSuccessor();
  };

  const onElementChange = (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (element !== null && last !== null && element !== last)) {
      currentRuntime?.retireForElement();
    }
    if (
      runtime?.isExactElementReplay() &&
      cells.successorOf.current === runtime.publication
    ) {
      requestReplaySuccessor(runtime);
    }
  };

  const rootOwner = new ElementOwner<HTMLDivElement>(onElementChange);
  const primaryOwner = new ElementOwner<HTMLAnchorElement>(onElementChange);
  const toggleOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
  const listOwner = new ElementOwner<HTMLDivElement>(onElementChange);
  const linkOwners = new Map<Format, ElementOwner<HTMLAnchorElement>>();

  const exactDomIsCurrent = () => {
    const root = rootOwner.element();
    const primary = primaryOwner.element();
    const toggle = toggleOwner.element();
    const list = listOwner.element();
    if (
      !root ||
      !root.isConnected ||
      root.tagName !== "DIV" ||
      root.className !== "relative flex items-stretch" ||
      !primary ||
      !primary.isConnected ||
      primary.ownerDocument !== root.ownerDocument ||
      primary.tagName !== "A" ||
      primary.parentElement !== root ||
      root.children.item(0) !== primary ||
      root.children.length !== 3 ||
      primary.getAttribute("href") !== authority.document.hrefs.md ||
      primary.getAttribute("aria-label") !== "Download Markdown" ||
      primary.dataset.testid !== "reader-download" ||
      primary.className !==
        "btn btn-sm btn-outline reader-split-main gap-1.5" ||
      !isEffectivelyEnabled(primary) ||
      !toggle ||
      !toggle.isConnected ||
      toggle.ownerDocument !== root.ownerDocument ||
      toggle.tagName !== "BUTTON" ||
      toggle.type !== "button" ||
      toggle.parentElement !== root ||
      root.children.item(1) !== toggle ||
      toggle.className !== "btn btn-sm btn-outline reader-split-more" ||
      toggle.getAttribute("aria-label") !== "Download as…" ||
      toggle.getAttribute("aria-expanded") !== String(authority.open) ||
      toggle.getAttribute("aria-controls") !== LIST_ID ||
      toggle.dataset.testid !== "reader-download-menu" ||
      !isEffectivelyEnabled(toggle) ||
      !list ||
      !list.isConnected ||
      list.ownerDocument !== root.ownerDocument ||
      list.tagName !== "DIV" ||
      list.parentElement !== root ||
      root.children.item(2) !== list ||
      list.id !== LIST_ID ||
      list.className !==
        "menu animate-fade-in absolute right-0 top-full mt-1.5 w-48" ||
      list.hidden === authority.open ||
      list.dataset.testid !== "reader-download-list" ||
      list.children.length !== FORMATS.length
    ) {
      return false;
    }

    return FORMATS.every((format, index) => {
      const link = links[format];
      const element = linkOwners.get(format)?.element();
      return (
        link.format === format &&
        link.href === authority.document.hrefs[format] &&
        !!element &&
        element.isConnected &&
        element.ownerDocument === root.ownerDocument &&
        element.tagName === "A" &&
        element.parentElement === list &&
        list.children.item(index) === element &&
        element.getAttribute("href") === link.href &&
        element.className === "menu-item" &&
        element.dataset.testid === `reader-download-${format}` &&
        element.textContent?.trim() === ROWS[index]?.label &&
        isEffectivelyEnabled(element)
      );
    });
  };

  const ownsIdentity = (publication: DownloadPublication) => {
    const runtime = currentRuntime;
    return (
      !!runtime &&
      runtime.publication === publication &&
      !runtime.isRetired() &&
      cells.active.current === publication &&
      publication.authority === authority &&
      factsAreCurrent(runtime)
    );
  };
  const ownsAuthority = (publication: DownloadPublication) => {
    const runtime = currentRuntime;
    return (
      !!runtime &&
      runtime.publication === publication &&
      ownsIdentity(publication) &&
      exactDomIsCurrent() &&
      runtime.publishedDomMatches()
    );
  };
  const ownsRoot = (
    publication: DownloadPublication,
    element: HTMLDivElement,
  ) =>
    ownsAuthority(publication) &&
    rootOwner.element() === element &&
    publication.root === element &&
    element.isConnected;
  const ownsToggle = (
    publication: DownloadPublication,
    element: HTMLButtonElement,
  ) =>
    ownsAuthority(publication) &&
    toggleOwner.element() === element &&
    publication.toggle === element &&
    element.isConnected &&
    isEffectivelyEnabled(element);
  const ownsList = (
    publication: DownloadPublication,
    element: HTMLDivElement,
  ) =>
    authority.open &&
    ownsAuthority(publication) &&
    listOwner.element() === element &&
    publication.list === element &&
    element.isConnected;
  const ownsLink = (
    publication: DownloadPublication,
    link: LinkPublication,
    element: HTMLAnchorElement,
  ) => {
    const index = FORMATS.indexOf(link.format);
    return (
      authority.open &&
      ownsAuthority(publication) &&
      links[link.format] === link &&
      linkOwners.get(link.format)?.element() === element &&
      publication.linkElements[link.format] === element &&
      element.isConnected &&
      element.parentElement === publication.list &&
      publication.list.children.item(index) === element &&
      element.getAttribute("href") === link.href &&
      isEffectivelyEnabled(element)
    );
  };
  const claimEvent = (event: Event) => {
    if (cells.claimedEvents.has(event)) return false;
    cells.claimedEvents.add(event);
    return true;
  };
  const nativeMouseEvent = <T extends HTMLElement>(
    publication: DownloadPublication,
    event: ReactMouseEvent<T>,
    control: T,
    targets: readonly Node[],
  ): MouseEvent | null => {
    const ownerWindow = publication.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !ownerWindow ||
      event.type !== "click" ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      event.currentTarget !== control ||
      nativeEvent.target !== target ||
      !isNodeFromDocument(target, publication.ownerDocument) ||
      !targets.includes(target) ||
      !isEffectivelyEnabled(control)
    ) {
      return null;
    }
    return nativeEvent;
  };

  const nativeFocusEvent = (
    publication: DownloadPublication,
    event: ReactFocusEvent<HTMLDivElement>,
  ): FocusEvent | null => {
    const ownerWindow = publication.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !ownerWindow ||
      event.type !== "blur" ||
      !(nativeEvent instanceof ownerWindow.FocusEvent) ||
      (nativeEvent.type !== "focusout" && nativeEvent.type !== "blur") ||
      event.currentTarget !== publication.root ||
      nativeEvent.target !== target ||
      nativeEvent.relatedTarget !== event.relatedTarget ||
      !isNodeFromDocument(target, publication.ownerDocument) ||
      !publication.rootTargets.includes(target)
    ) {
      return null;
    }
    return nativeEvent;
  };

  const commitState = (next: DownloadState) => {
    setState((current) =>
      current === authority.sourceState ? next : current,
    );
  };
  const transition = (
    runtime: DownloadPublicationRuntime,
    disclosure: DisclosureVisit | null,
    refocus: boolean,
    keyboardAction?: DownloadKeyboardAction,
  ) => {
    const publication = runtime.publication;
    const toggle = publication.toggle;
    if (
      keyboardAction &&
      (!keyboardAction.claimed ||
        !keyboardAction.sourceClaimed ||
        !keyboardAction.destinationClaimed ||
        keyboardAction.focusClaimed ||
        keyboardAction.publication !== publication ||
        keyboardAction.destination !== toggle ||
        keyboardAction.focus !== publication.keyboard.focus ||
        cells.activeKeyboardActions.get(publication) !==
          keyboardAction ||
        !cells.claimedKeyboardActions.has(keyboardAction) ||
        cells.claimedSources.get(keyboardAction.source) !==
          keyboardAction ||
        cells.claimedDestinations.get(toggle) !== keyboardAction)
    ) {
      return false;
    }
    if (!publication.retire()) return false;
    const ownsSuccession = () =>
      cells.active.current === null &&
      cells.successorOf.current === publication &&
      factsAreCurrent(runtime) &&
      runtime.publishedDomMatches();
    if (!ownsSuccession()) return false;
    if (refocus) {
      if (!isEffectivelyEnabled(toggle)) return false;
      if (keyboardAction) {
        keyboardAction.focusClaimed = true;
        publication.keyboard.apply(keyboardAction.focus, toggle, [
          PREVENT_SCROLL,
        ]);
      } else {
        toggle.focus();
      }
      if (!ownsSuccession()) return false;
    }
    commitState(
      Object.freeze({
        document: authority.document,
        disclosure,
      }),
    );
    return true;
  };

  const links = Object.fromEntries(
    FORMATS.map((format) => {
      const owner = new ElementOwner<HTMLAnchorElement>(onElementChange);
      linkOwners.set(format, owner);
      const link: LinkPublication = Object.freeze({
        format,
        href: authority.document.hrefs[format],
        capture: owner.capture,
        element: owner.element,
        onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
          const runtime = currentRuntime;
          const publication = runtime?.publication;
          const element = event.currentTarget;
          if (
            !runtime ||
            !publication ||
            !ownsLink(publication, link, element)
          ) {
            return;
          }
          const nativeEvent = nativeMouseEvent(
            publication,
            event,
            element,
            publication.linkTargets[format],
          );
          if (!nativeEvent || !claimEvent(nativeEvent)) return;
          transition(runtime, null, true);
        },
      });
      return [format, link];
    }),
  ) as Record<Format, LinkPublication>;

  const onToggleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const toggle = event.currentTarget;
    if (
      !runtime ||
      !publication ||
      !ownsToggle(publication, toggle)
    ) {
      return;
    }
    const nativeEvent = nativeMouseEvent(
      publication,
      event,
      toggle,
      publication.toggleTargets,
    );
    if (!nativeEvent || !claimEvent(nativeEvent)) return;
    transition(
      runtime,
      authority.open
        ? null
        : Object.freeze({
            document: authority.document,
            initialFocus: "md",
            focus: null,
            keyboardAction: null,
          }),
      false,
    );
  };
  type KeyboardRoute = "toggle" | "list" | "root";
  const candidateFor = (
    publication: DownloadPublication,
    route: KeyboardRoute,
    key: string,
    source: HTMLElement,
  ): {
    readonly kind: DownloadKeyboardActionKind;
    readonly destination: HTMLElement;
    readonly format: Format | null;
  } | null => {
    if (route === "toggle") {
      const format =
        key === "ArrowDown" ? "md" : key === "ArrowUp" ? "pdf" : null;
      return format && source === publication.toggle
        ? {
            kind: authority.open ? "move" : "open",
            destination: publication.linkElements[format],
            format,
          }
        : null;
    }
    if (route === "root") {
      return key === "Escape" && authority.open
        ? {
            kind: "escape",
            destination: publication.toggle,
            format: null,
          }
        : null;
    }
    const current = FORMATS.findIndex(
      (format) => publication.linkElements[format] === source,
    );
    if (current < 0 || !authority.open) return null;
    let next: number;
    if (key === "ArrowDown") next = (current + 1) % FORMATS.length;
    else if (key === "ArrowUp") {
      next = (current - 1 + FORMATS.length) % FORMATS.length;
    } else if (key === "Home") next = 0;
    else if (key === "End") next = FORMATS.length - 1;
    else return null;
    const format = FORMATS[next]!;
    return {
      kind: "move",
      destination: publication.linkElements[format],
      format,
    };
  };
  const boundaryFor = (
    publication: DownloadPublication,
    route: KeyboardRoute,
  ) =>
    route === "toggle"
      ? publication.toggle
      : route === "list"
        ? publication.list
        : publication.root;
  const routeIsOwned = (
    publication: DownloadPublication,
    route: KeyboardRoute,
    boundary: HTMLElement,
    source: HTMLElement,
    destination: HTMLElement,
  ) => {
    if (
      publication.ownerDocument.defaultView !==
        publication.keyboard.ownerWindow ||
      publication.keyboard.ownerWindow.document !==
        publication.ownerDocument ||
      publication.keyboard.apply(
        publication.keyboard.activeElement,
        publication.ownerDocument,
        [],
      ) !== source ||
      !isEffectivelyEnabled(source) ||
      !isEffectivelyEnabled(destination)
    ) {
      return false;
    }
    if (route === "toggle") {
      return (
        boundary === publication.toggle &&
        source === publication.toggle &&
        ownsToggle(publication, publication.toggle) &&
        (!authority.open ||
          FORMATS.some(
            (format) =>
              publication.linkElements[format] === destination &&
              ownsLink(
                publication,
                links[format],
                publication.linkElements[format],
              ),
          ))
      );
    }
    if (route === "list") {
      return (
        boundary === publication.list &&
        ownsList(publication, publication.list) &&
        FORMATS.some(
          (format) =>
            publication.linkElements[format] === source &&
            ownsLink(
              publication,
              links[format],
              publication.linkElements[format],
            ),
        ) &&
        FORMATS.some(
          (format) =>
            publication.linkElements[format] === destination &&
            ownsLink(
              publication,
              links[format],
              publication.linkElements[format],
            ),
        )
      );
    }
    return (
      boundary === publication.root &&
      ownsRoot(publication, publication.root) &&
      publication.rootTargets.includes(source) &&
      destination === publication.toggle &&
      ownsToggle(publication, publication.toggle)
    );
  };
  const routeAcceptsKey = (route: KeyboardRoute, key: string) =>
    route === "toggle"
      ? key === "ArrowDown" || key === "ArrowUp"
      : route === "list"
        ? key === "ArrowDown" ||
          key === "ArrowUp" ||
          key === "Home" ||
          key === "End"
        : key === "Escape";

  const handleKeyboard = (
    event: ReactKeyboardEvent<HTMLElement>,
    route: KeyboardRoute,
    phase: "capture" | "bubble",
  ) => {
    if (cells.readingKeyboard.current || !event || typeof event !== "object") return;
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    if (!runtime || !publication || !ownsIdentity(publication)) return;
    // This mount-local exclusion belongs to the stack, not the publication.
    // Ref/layout cleanup and synchronous visit replacement must not clear it.
    cells.readingKeyboard.current = true;
    try {
      handleOwnedKeyboard(event, route, phase, runtime, publication);
    } finally {
      cells.readingKeyboard.current = false;
    }
  };

  const handleOwnedKeyboard = (
    event: ReactKeyboardEvent<HTMLElement>,
    route: KeyboardRoute,
    phase: "capture" | "bubble",
    runtime: DownloadPublicationRuntime,
    publication: DownloadPublication,
  ) => {
    const keyboard = publication.keyboard;
    if (!keyboard.isCurrent()) {
      if (publication.retire()) requestSuccessor();
      return;
    }
    const isCurrent = () =>
      currentRuntime === runtime &&
      cells.active.current === publication &&
      !publication.isRetired() &&
      keyboard.isCurrent();
    const delivery = readDownloadReactRoute(event, isCurrent);
    if (!delivery || !isCurrent() || !routeAcceptsKey(route, delivery.key)) return;
    const { nativeEvent } = delivery;
    const boundary = boundaryFor(publication, route);
    const proof = readDownloadReactKey(
      event,
      nativeEvent,
      boundary,
      publication,
      phase === "capture" ? keyboard.capturingPhase : keyboard.bubblingPhase,
      isCurrent,
    );
    if (!isCurrent() || !proof) return;
    const candidate = routeAcceptsKey(route, proof.snapshot.key)
      ? candidateFor(
          publication,
          route,
          proof.snapshot.key,
          proof.source,
        )
      : null;
    if (
      !candidate ||
      !routeIsOwned(
        publication,
        route,
        boundary,
        proof.source,
        candidate.destination,
      ) ||
      !isCurrent() ||
      cells.claimedReactEvents.has(event) ||
      cells.claimedEvents.has(nativeEvent) ||
      cells.activeKeyboardActions.has(publication) ||
      cells.claimedSources.has(proof.source) ||
      cells.claimedDestinations.has(candidate.destination) ||
      !ownsAuthority(publication)
    ) {
      return;
    }
    let reactKeys = cells.reactKeys.get(publication);
    const captured = reactKeys?.get(nativeEvent);
    if (phase === "capture") {
      // A duplicate or crossed candidate never replaces a rightful native pair.
      if (captured) return;
      if (!reactKeys) {
        reactKeys = new WeakMap();
        cells.reactKeys.set(publication, reactKeys);
      }
      reactKeys.set(nativeEvent, proof);
      return;
    }
    const bubble = proof;
    if (
      !captured ||
      !reactKeys ||
      !downloadReactKeyPairMatches(captured, bubble, publication) ||
      cells.claimedKeyboardPublications.has(publication)
    ) {
      return;
    }

    const nativeIsCurrent = (prevented: boolean) => {
      if (!isCurrent()) return false;
      const snapshot = readDownloadKeyboardEvent(nativeEvent, keyboard);
      return (
        !!snapshot &&
        downloadKeyboardFactsMatch(
          prevented ? { ...bubble.snapshot, defaultPrevented: true } : bubble.snapshot,
          snapshot,
        ) &&
        routeIsOwned(publication, route, boundary, bubble.source, candidate.destination) &&
        isCurrent()
      );
    };
    const publicProofsMatch = (
      prevented = false,
      defaultQuery = bubble.cancellation.isDefaultPrevented,
    ) =>
      isCurrent() &&
      downloadReactKeyMatches(captured, isCurrent, true) &&
      downloadReactKeyMatches(bubble, isCurrent, false, prevented, defaultQuery) &&
      nativeIsCurrent(prevented);
    const predicatesMatch = (
      prevented = false,
      defaultQuery = bubble.cancellation.isDefaultPrevented,
    ) => {
      const revalidate = () => publicProofsMatch(prevented, defaultQuery);
      const current = () => nativeIsCurrent(prevented);
      return (
        downloadReactPredicatesMatch(captured, keyboard, revalidate, current) &&
        downloadReactPredicatesMatch(
          bubble, keyboard, revalidate, current, prevented, defaultQuery,
        )
      );
    };
    if (
      !predicatesMatch() ||
      !isCurrent() ||
      cells.reactKeys.get(publication) !== reactKeys ||
      reactKeys.get(nativeEvent) !== captured ||
      cells.claimedReactEvents.has(captured.event) ||
      publication.keyListener.proofFor(nativeEvent, publication) !== bubble.listenerProof
    ) {
      return;
    }

    const action: DownloadKeyboardAction = {
      identity: Symbol("reader-download-keyboard-action"),
      kind: candidate.kind,
      publication,
      source: bubble.source,
      destination: candidate.destination,
      nativeEvent,
      capture: captured,
      bubble,
      focus: keyboard.focus,
      claimed: false,
      sourceClaimed: false,
      destinationClaimed: false,
      focusClaimed: false,
    };
    let retainedForSuccessor = false;
    try {
      const actionIsCurrent = (prevented: boolean) =>
        nativeIsCurrent(prevented) &&
        publication.keyListener.retains(bubble.listenerProof, publication) &&
        cells.activeKeyboardActions.get(publication) === action &&
        cells.claimedKeyboardActions.has(action) &&
        cells.claimedSources.get(action.source) === action &&
        cells.claimedDestinations.get(action.destination) === action &&
        action.claimed &&
        action.sourceClaimed &&
        action.destinationClaimed &&
        !action.focusClaimed &&
        action.focus === keyboard.focus;
      const claim = () => {
        if (
          !nativeIsCurrent(false) ||
          cells.reactKeys.get(publication) !== reactKeys ||
          reactKeys.get(nativeEvent) !== captured ||
          cells.claimedKeyboardPublications.has(publication) ||
          cells.claimedReactEvents.has(captured.event) ||
          cells.claimedReactEvents.has(event) ||
          cells.claimedEvents.has(nativeEvent) ||
          cells.activeKeyboardActions.has(publication) ||
          cells.claimedSources.has(action.source) ||
          cells.claimedDestinations.has(action.destination) ||
          !publication.keyListener.claim(bubble.listenerProof, publication)
        ) return false;
        cells.claimedKeyboardPublications.add(publication);
        cells.claimedKeyboardActions.add(action);
        cells.claimedReactEvents.add(captured.event);
        cells.claimedReactEvents.add(event);
        cells.claimedEvents.add(nativeEvent);
        cells.claimedSources.set(action.source, action);
        cells.claimedDestinations.set(action.destination, action);
        cells.activeKeyboardActions.set(publication, action);
        reactKeys.delete(nativeEvent);
        action.claimed = true;
        action.sourceClaimed = true;
        action.destinationClaimed = true;
        return true;
      };
      if (!predicatesMatch()) return;
      const defaultQuery = preventDownloadReactKey(
        bubble,
        keyboard,
        claim,
        isCurrent,
      );
      if (
        !defaultQuery ||
        !isCurrent() ||
        !predicatesMatch(true, defaultQuery) ||
        !publicProofsMatch(true, defaultQuery) ||
        !actionIsCurrent(true)
      ) return;

      if (action.kind === "open" && candidate.format) {
        retainedForSuccessor = transition(
          runtime,
          Object.freeze({
            document: authority.document,
            initialFocus: candidate.format,
            focus: action.focus,
            keyboardAction: action,
          }),
          false,
        );
        return;
      }
      if (action.kind === "escape") {
        transition(runtime, null, true, action);
        return;
      }

      action.focusClaimed = true;
      keyboard.apply(action.focus, action.destination, [
        PREVENT_SCROLL,
      ]);
      if (
        keyboard.apply(
          keyboard.activeElement,
          publication.ownerDocument,
          [],
        ) === action.destination &&
        publication.retire()
      ) {
        requestSuccessor();
      }
    } finally {
      if (!retainedForSuccessor) {
        if (cells.activeKeyboardActions.get(publication) === action) {
          cells.activeKeyboardActions.delete(publication);
        }
        if (cells.claimedSources.get(action.source) === action) {
          cells.claimedSources.delete(action.source);
        }
        if (
          cells.claimedDestinations.get(action.destination) === action
        ) {
          cells.claimedDestinations.delete(action.destination);
        }
      }
    }
  };

  const onToggleKeyDownCapture = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => handleKeyboard(event, "toggle", "capture");
  const onToggleKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => handleKeyboard(event, "toggle", "bubble");
  const onListKeyDownCapture = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => handleKeyboard(event, "list", "capture");
  const onListKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => handleKeyboard(event, "list", "bubble");
  const onRootKeyDownCapture = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => handleKeyboard(event, "root", "capture");
  const onRootKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => handleKeyboard(event, "root", "bubble");
  const onRootBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    if (
      !authority.open ||
      !runtime ||
      !publication ||
      !ownsRoot(publication, event.currentTarget)
    ) {
      return;
    }
    const nativeEvent = nativeFocusEvent(publication, event);
    if (!nativeEvent) return;
    const related = event.relatedTarget;
    if (
      !isNodeFromDocument(related, publication.ownerDocument) ||
      !related.isConnected ||
      publication.root.contains(related) ||
      !claimEvent(nativeEvent)
    ) {
      return;
    }
    transition(runtime, null, false);
  };

  const expectedOwners = (): readonly ElementOwnerView[] => [
    rootOwner,
    primaryOwner,
    toggleOwner,
    listOwner,
    ...FORMATS.map((format) => linkOwners.get(format)!),
  ];

  const createRuntime = (): DownloadPublicationRuntime | null => {
    type Retirement = "element" | "layout" | "other";
    const root = rootOwner.element();
    const primary = primaryOwner.element();
    const toggle = toggleOwner.element();
    const list = listOwner.element();
    const linkElements = Object.fromEntries(
      FORMATS.map((format) => [format, linkOwners.get(format)?.element()]),
    ) as Record<Format, HTMLAnchorElement | null>;
    const placement = root ? captureDownloadPlacement(root) : null;
    const ownerWindow = root?.ownerDocument.defaultView;
    const keyboard = ownerWindow
      ? captureDownloadKeyboardIntrinsics(ownerWindow)
      : null;
    if (
      !root ||
      !primary ||
      !toggle ||
      !list ||
      !placement ||
      !ownerWindow ||
      !keyboard ||
      FORMATS.some((format) => !linkElements[format])
    ) {
      return null;
    }

    const exactLinks = linkElements as Record<Format, HTMLAnchorElement>;
    const keyListener = createDownloadKeyListener(keyboard);
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let focusClaimed = false;
    let pointerListening = false;
    let domChanged = false;
    let domObserver: MutationObserver | null = null;
    let domSnapshot: DownloadDomSnapshot | null = null;
    let placementSnapshot: DownloadPlacement | null = null;
    let replayRefs: RefReplay[] = [];
    let invalidReplay = false;

    const linkTargets = Object.fromEntries(
      FORMATS.map((format) => [
        format,
        descendantsOf(exactLinks[format]),
      ]),
    ) as Record<Format, readonly Node[]>;
    const publication: DownloadPublication = Object.freeze({
      authority,
      ownerDocument: root.ownerDocument,
      ownerWindow,
      root,
      primary,
      toggle,
      list,
      linkElements: Object.freeze(exactLinks),
      rootTargets: descendantsOf(root),
      toggleTargets: descendantsOf(toggle),
      linkTargets: Object.freeze(linkTargets),
      links: Object.freeze(FORMATS.map((format) => exactLinks[format])),
      keyboard,
      keyListener,
      retire: () => retire("other"),
      isRetired: () => retired,
    });

    const uninstallPointer = () => {
      if (!pointerListening) return;
      pointerListening = false;
      publication.ownerDocument.removeEventListener(
        "pointerdown",
        onPointerDown,
      );
    };
    const mutationIsRelevant = (record: MutationRecord) => {
      if (record.target === root || root.contains(record.target)) return true;
      if (
        record.type === "attributes" &&
        (record.attributeName === "inert" ||
          record.attributeName === "aria-disabled" ||
          record.attributeName === "disabled")
      ) {
        return root.contains(record.target) || record.target.contains(root);
      }
      if (record.type !== "childList") return false;
      if (record.target === placement.parent) return true;
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) => node === root || node.contains(root),
      );
    };
    const recordMutations = (records: readonly MutationRecord[]) => {
      if (!domChanged && records.some(mutationIsRelevant)) domChanged = true;
      return domChanged;
    };
    const releaseReplayGuard = () => {
      if (!domObserver) return;
      recordMutations(domObserver.takeRecords());
      domObserver.disconnect();
      domObserver = null;
    };
    const noteMutations = (records: readonly MutationRecord[]) => {
      if (recordMutations(records)) retire("element");
    };
    const retire = (reason: Retirement) => {
      if (retired) return false;
      if (domObserver) recordMutations(domObserver.takeRecords());
      retired = true;
      retirement = reason;
      const wasActive = cells.active.current === publication;
      if (wasActive) {
        cells.active.current = null;
        cells.successorOf.current = publication;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      cells.reactKeys.delete(publication);
      keyListener.release(publication);
      uninstallPointer();
      if (reason === "layout") {
        queueMicrotask(() => {
          if (!domObserver) return;
          recordMutations(domObserver.takeRecords());
          domChanged = true;
          domObserver.disconnect();
          domObserver = null;
        });
      } else {
        releaseReplayGuard();
      }
      return wasActive;
    };
    const publishedDomMatches = () => {
      if (domObserver) noteMutations(domObserver.takeRecords());
      return Boolean(
        !domChanged &&
          domSnapshot &&
          placementSnapshot &&
          rootOwner.element() === root &&
          root.isConnected &&
          downloadPlacementMatches(root, placementSnapshot) &&
          downloadDomMatches(domSnapshot),
      );
    };
    const focusFactsMatch = () => {
      const disclosure = authority.disclosure;
      return disclosure
        ? cells.focused.has(disclosure) ===
            (authority.focusPublished || focusClaimed)
        : !authority.focusPublished && !focusClaimed;
    };
    const ownsPublishedAuthority = () =>
      currentRuntime === runtime &&
      cells.active.current === publication &&
      !retired &&
      factsAreCurrent(runtime) &&
      exactDomIsCurrent() &&
      publishedDomMatches();
    const nativePointerEvent = (event: Event) => {
      const ownerWindow = publication.ownerDocument.defaultView;
      if (!ownerWindow || event.type !== "pointerdown") return false;
      const PointerEventConstructor = ownerWindow.PointerEvent;
      return PointerEventConstructor
        ? event instanceof PointerEventConstructor
        : event instanceof ownerWindow.Event;
    };
    const onPointerDown = (event: Event) => {
      if (
        !pointerListening ||
        !authority.open ||
        !ownsPublishedAuthority() ||
        !nativePointerEvent(event)
      ) {
        return;
      }
      const target = event.target;
      if (
        !isNodeFromDocument(target, publication.ownerDocument) ||
        !target.isConnected ||
        publication.root.contains(target) ||
        !claimEvent(event)
      ) {
        return;
      }
      transition(runtime, null, false);
    };
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every(
        (entry) =>
          entry.detached &&
          entry.reattached &&
          entry.owner.element() === entry.element,
      );

    const runtime: DownloadPublicationRuntime = Object.freeze({
      publication,
      publish: (
        snapshot: DownloadDomSnapshot,
        publishedPlacement: DownloadPlacement,
        owners: readonly ElementOwnerView[],
      ) => {
        established = true;
        domSnapshot = snapshot;
        placementSnapshot = publishedPlacement;
        replayRefs = owners.map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish DownloadMenu without every committed ref",
            );
          }
          return { owner, element, detached: false, reattached: false };
        });
        cells.active.current = publication;
        cells.successorOf.current = null;
        cells.replay.current = null;
        if (!keyListener.activate(publication)) {
          retire("other");
          return;
        }
        const MutationObserverConstructor =
          publication.ownerDocument.defaultView?.MutationObserver;
        if (MutationObserverConstructor) {
          domObserver = new MutationObserverConstructor((records) => {
            noteMutations(records);
          });
          domObserver.observe(publication.ownerDocument, {
            attributes: true,
            characterData: true,
            childList: true,
            subtree: true,
          });
        }
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        layoutRetired = true;
        retire("layout");
      },
      noteRef: (
        owner: ElementOwnerView,
        element: HTMLElement | null,
        previous: HTMLElement | null,
      ) => {
        if (!established) return;
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
      },
      isRetired: () => retired,
      publishedDomMatches,
      focusFactsMatch,
      focusDisclosure: () => {
        const disclosure = authority.disclosure;
        const action = disclosure?.keyboardAction ?? null;
        if (
          !authority.open ||
          !disclosure ||
          authority.focusPublished ||
          cells.focused.has(disclosure)
        ) {
          return authority.focusPublished;
        }
        const destination = links[disclosure.initialFocus];
        const destinationElement =
          publication.linkElements[disclosure.initialFocus];
        if (
          !ownsLink(
            publication,
            destination,
            destinationElement,
          ) ||
          (action &&
            (!action.claimed ||
             !action.sourceClaimed ||
             !action.destinationClaimed ||
             action.focusClaimed ||
             action.kind !== "open" ||
             action.destination !== destinationElement ||
             action.focus !== disclosure.focus ||
             cells.activeKeyboardActions.get(action.publication) !==
               action ||
             !cells.claimedKeyboardActions.has(action) ||
             cells.claimedSources.get(action.source) !== action ||
             cells.claimedDestinations.get(destinationElement) !==
               action))
        ) {
          return false;
        }
        cells.focused.add(disclosure);
        focusClaimed = true;
        if (
          !ownsLink(
            publication,
            destination,
            destinationElement,
          )
        ) {
          return false;
        }
        if (action && disclosure.focus) {
          action.focusClaimed = true;
          keyboard.apply(action.focus, destinationElement, [
            PREVENT_SCROLL,
          ]);
        } else {
          destinationElement.focus();
        }
        if (action) {
          if (
            cells.activeKeyboardActions.get(action.publication) === action
          ) {
            cells.activeKeyboardActions.delete(action.publication);
          }
          if (cells.claimedSources.get(action.source) === action) {
            cells.claimedSources.delete(action.source);
          }
          if (
            cells.claimedDestinations.get(destinationElement) === action
          ) {
            cells.claimedDestinations.delete(destinationElement);
          }
        }
        return ownsLink(
          publication,
          destination,
          destinationElement,
        );
      },
      installPointer: () => {
        if (
          pointerListening ||
          !authority.open ||
          !ownsPublishedAuthority()
        ) {
          return !authority.open;
        }
        pointerListening = true;
        publication.ownerDocument.addEventListener(
          "pointerdown",
          onPointerDown,
        );
        if (!ownsPublishedAuthority()) {
          uninstallPointer();
          return false;
        }
        return true;
      },
      isExactElementReplay: () =>
        retired &&
        retirement === "element" &&
        layoutRetired &&
        established &&
        refsHaveExactReplay() &&
        focusFactsMatch() &&
        publishedDomMatches(),
      isExactLayoutReplay: () =>
        retired &&
        retirement === "layout" &&
        established &&
        refsHaveExactReplay() &&
        focusFactsMatch() &&
        publishedDomMatches(),
      replayDomUnchanged: () => {
        if (!domObserver) return false;
        recordMutations(domObserver.takeRecords());
        return Boolean(
          !domChanged &&
            domSnapshot &&
            placementSnapshot &&
            root.isConnected &&
            downloadPlacementMatches(root, placementSnapshot) &&
            downloadDomMatches(domSnapshot),
        );
      },
      releaseReplayGuard,
      snapshot: () => domSnapshot,
      placement: () => placementSnapshot,
    });
    return runtime;
  };

  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() ||
          lastRuntime.isExactElementReplay()) &&
        cells.successorOf.current === lastRuntime.publication
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!factsAreCurrent() || !exactDomIsCurrent()) return undefined;
    const root = rootOwner.element();
    const placement = root ? captureDownloadPlacement(root) : null;
    if (!root || !placement) return undefined;
    const replay = cells.replay.current;
    if (
      replay &&
      (
        cells.successorOf.current !== replay.source ||
        !authoritiesMatch(replay.source.authority, authority) ||
        root !== replay.dom.node ||
        !downloadPlacementMatches(root, replay.placement) ||
        !downloadDomMatches(replay.dom) ||
        !replay.unchanged()
      )
    ) {
      const exactDomStillCommitted =
        root === replay.dom.node &&
        downloadPlacementMatches(root, replay.placement) &&
        downloadDomMatches(replay.dom) &&
        replay.unchanged();
      replay.release();
      cells.replay.current = null;
      if (cells.successorOf.current === replay.source) {
        cells.successorOf.current = null;
      }
      if (exactDomStillCommitted) requestSuccessor();
      return undefined;
    }

    const runtime = createRuntime();
    if (!runtime) return undefined;
    const publication = runtime.publication;
    const previous = cells.active.current;
    if (previous && previous !== publication) previous.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    runtime.publish(
      snapshotDownloadDom(root),
      placement,
      expectedOwners(),
    );
    if (runtime.isRetired()) return runtime.retireForLayout;
    replay?.release();
    if (
      authority.open &&
      !authority.focusPublished &&
      !runtime.focusDisclosure()
    ) {
      publication.retire();
      return runtime.retireForLayout;
    }
    if (!runtime.installPointer()) publication.retire();
    return runtime.retireForLayout;
  };

  return Object.freeze({
    captureRoot: rootOwner.capture,
    capturePrimary: primaryOwner.capture,
    captureToggle: toggleOwner.capture,
    captureList: listOwner.capture,
    links: Object.freeze(links),
    establish,
    onToggleClick,
    onToggleKeyDownCapture,
    onToggleKeyDown,
    onListKeyDownCapture,
    onListKeyDown,
    onRootKeyDownCapture,
    onRootKeyDown,
    onRootBlur,
  });
}

/**
 * "Download" split button: Markdown, HTML or PDF through the existing export route.
 * The "Download as…" half is a WAI-ARIA disclosure (a button that shows a list of links), not a Radix
 * menu: this was the public reader's only Radix consumer and its first load matters most. The list
 * stays in the DOM with `hidden` while closed, so `aria-controls` always resolves.
 */
export function DownloadMenu({ docId }: { docId: string }) {
  const [mount] = useState(() => Symbol("reader download menu"));
  const documentVisit = useMemo<DocumentVisit>(() => {
    return Object.freeze({
      mount,
      docId,
      hrefs: Object.freeze({
        md: exportHref(docId, "md"),
        html: exportHref(docId, "html"),
        pdf: exportHref(docId, "pdf"),
      }),
    });
  }, [docId, mount]);
  const [state, setState] = useState<DownloadState>(() =>
    Object.freeze({ document: documentVisit, disclosure: null }),
  );
  const [cells] = useState<PublicationCells>(() => ({
    active: new CurrentCell<DownloadPublication | null>(null),
    readingKeyboard: new CurrentCell(false),
    successorOf: new CurrentCell<DownloadPublication | null>(null),
    replay: new CurrentCell<DownloadReplay | null>(null),
    focused: new WeakSet<DisclosureVisit>(),
    claimedEvents: new WeakSet<Event>(),
    claimedReactEvents: new WeakSet<object>(),
    claimedKeyboardPublications: new WeakSet<DownloadPublication>(),
    claimedKeyboardActions: new WeakSet<DownloadKeyboardAction>(),
    claimedSources: new WeakMap<HTMLElement, DownloadKeyboardAction>(),
    claimedDestinations: new WeakMap<
      HTMLElement,
      DownloadKeyboardAction
    >(),
    activeKeyboardActions: new WeakMap<
      DownloadPublication,
      DownloadKeyboardAction
    >(),
    reactKeys: new WeakMap<
      DownloadPublication,
      WeakMap<KeyboardEvent, DownloadReactKey>
    >(),
  }));
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const currentState = state.document === documentVisit ? state : null;
  const disclosure = currentState?.disclosure ?? null;
  const open = disclosure !== null;
  const publication = createDownloadPublication({
    authority: Object.freeze({
      document: documentVisit,
      sourceState: state,
      state: currentState,
      disclosure,
      open,
      focusPublished: disclosure ? cells.focused.has(disclosure) : false,
    }),
    cells,
    setState,
    requestSuccessor: requestPublicationSuccessor,
  });

  useLayoutEffect(() => publication.establish(), [publication]);

  const {
    captureRoot,
    capturePrimary,
    captureToggle,
    captureList,
    links,
    onToggleClick,
    onToggleKeyDownCapture,
    onToggleKeyDown,
    onListKeyDownCapture,
    onListKeyDown,
    onRootKeyDownCapture,
    onRootKeyDown,
    onRootBlur,
  } = publication;

  return (
    <div
      ref={captureRoot}
      className="relative flex items-stretch"
      onKeyDownCapture={onRootKeyDownCapture}
      onKeyDown={onRootKeyDown}
      onBlur={onRootBlur}
    >
      <a ref={capturePrimary} href={documentVisit.hrefs.md} className="btn btn-sm btn-outline reader-split-main gap-1.5" aria-label="Download Markdown" data-testid="reader-download">
        <Download size={14} />
        <span className="hidden sm:inline">Download</span>
      </a>
      <button
        ref={captureToggle}
        type="button"
        className="btn btn-sm btn-outline reader-split-more"
        aria-label="Download as…"
        aria-expanded={open}
        aria-controls={LIST_ID}
        onClick={onToggleClick}
        onKeyDownCapture={onToggleKeyDownCapture}
        onKeyDown={onToggleKeyDown}
        data-testid="reader-download-menu"
      >
        <ChevronDown size={14} className="shrink-0" />
      </button>
      <div
        ref={captureList}
        id={LIST_ID}
        className="menu animate-fade-in absolute right-0 top-full mt-1.5 w-48"
        hidden={!open}
        onKeyDownCapture={onListKeyDownCapture}
        onKeyDown={onListKeyDown}
        data-testid="reader-download-list"
      >
        {ROWS.map(({ format, label, Icon }) => {
          const link = links[format];
          return (
            <a ref={link.capture} key={format} href={link.href} className="menu-item" onClick={link.onClick} data-testid={`reader-download-${format}`}>
              <span className="flex h-4 w-4 items-center justify-center text-ink-3">
                <Icon size={15} />
              </span>
              <span className="flex-1">{label}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
