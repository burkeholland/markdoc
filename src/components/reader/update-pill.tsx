"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { RefreshCw, X } from "lucide-react";

const PILL_CLASS_NAME =
  "reader-pill pointer-events-none fixed inset-x-0 top-16 z-20 flex justify-center gap-1";
const BUTTON_CLASS_NAME =
  "pointer-events-auto inline-flex items-center gap-2 rounded-full border border-line-2 bg-surface px-3.5 py-1.5 text-sm font-medium text-ink shadow-md hover:bg-surface-2";
const DISMISS_BUTTON_CLASS_NAME =
  "pointer-events-auto inline-flex size-8 items-center justify-center rounded-full border border-line-2 bg-surface text-ink-3 shadow-md hover:bg-surface-2 hover:text-ink";
const UPDATED_CLASS_NAME = "text-ink-3";
const SEPARATOR_CLASS_NAME = "text-ink-4";
const ICON_CLASS_NAME = "text-accent";
const CONTROL_TEXT = "Updated—Refresh";
const DISMISS_LABEL = "Dismiss update notice";
const FAILURE_MESSAGE = "Couldn't check for updates.";
const RETRY_TEXT = "Retry now";
const FAILURE_NOTICE_CLASS_NAME =
  "pointer-events-auto inline-flex items-center gap-2 rounded-full border border-line-2 bg-surface px-3.5 py-1.5 text-sm font-medium text-ink shadow-md";
const RETRY_BUTTON_CLASS_NAME =
  "rounded-full text-accent hover:opacity-80 disabled:cursor-wait disabled:opacity-60";

type DocumentAuthority = Readonly<{
  mount: symbol;
  ownerDocument: Document;
  docId: string;
  initialHash: string;
}>;

type RefreshPublication = Readonly<{
  document: DocumentAuthority;
  remoteHash: string;
}>;

type DismissedUpdate = Readonly<{
  document: DocumentAuthority;
  remoteHash: string;
}>;

type PollingAuthority = Readonly<{
  document: DocumentAuthority;
  pollMs: number;
}>;

type PollingOwner = {
  authority: PollingAuthority;
  retry: (attempt: FailureCheckAttempt) => boolean;
  retire: () => void;
};

type RequestOwner = {
  authority: PollingAuthority;
  controller: AbortController;
  failureAttempt: FailureCheckAttempt | null;
};

type FailurePublication = Readonly<{
  identity: symbol;
  authority: PollingAuthority;
}>;

type FailureCheckAttempt = Readonly<{
  identity: symbol;
  authority: PollingAuthority;
  failure: FailurePublication;
  source: "poll" | "retry";
  control: Readonly<{
    ready: Promise<void>;
    publish: () => void;
    release: () => void;
  }>;
}>;

type FailureState = Readonly<{
  publication: FailurePublication;
  attempt: FailureCheckAttempt | null;
}>;

type RefreshControlRender = Readonly<{
  identity: symbol;
  mount: symbol;
  ownerDocument: Document;
  docId: string;
  initialHash: string;
  pollMs: number;
  document: DocumentAuthority;
  polling: PollingAuthority;
  refresh: RefreshPublication;
  dismiss: (publication: RefreshPublication) => void;
}>;

type RefreshAction = {
  claimed: boolean;
};

type ReloadAuthority = Readonly<{
  owner: Window;
  location: Location;
  reload: Location["reload"];
}>;

type RefreshControlPublication = Readonly<{
  render: RefreshControlRender;
  action: RefreshAction;
  pill: HTMLDivElement;
  refreshButton: HTMLButtonElement;
  dismissButton: HTMLButtonElement;
  ownerDocument: Document;
  refreshTargets: readonly Node[];
  dismissTargets: readonly Node[];
  reloadAuthority: ReloadAuthority;
  keyboard: RefreshControlKeyboardIntrinsics;
  keyListener: RefreshControlKeyListener;
  retire: () => boolean;
  isRetired: () => boolean;
}>;

type CurrentCell<T> = {
  current: T;
};

type RefreshControlCells = {
  active: CurrentCell<RefreshControlPublication | null>;
  successorOf: CurrentCell<RefreshControlPublication | null>;
  replay: CurrentCell<RefreshControlReplay | null>;
  invalidRefreshes: WeakSet<RefreshPublication>;
  claimedRefreshes: WeakSet<RefreshPublication>;
  claimedPublications: WeakSet<RefreshControlPublication>;
  claimedActions: WeakSet<RefreshAction>;
  claimedReactEvents: WeakSet<object>;
  claimedNativeEvents: WeakSet<Event>;
  reactKeys: WeakMap<
    RefreshControlPublication,
    WeakMap<KeyboardEvent, RefreshControlReactKey>
  >;
  claimedMovements: WeakSet<RefreshControlMovement>;
  claimedMovementActions: WeakSet<RefreshControlMovementAction>;
  activeMovements: WeakMap<
    RefreshControlPublication,
    RefreshControlMovement
  >;
  claimedDestinations: WeakMap<
    HTMLButtonElement,
    RefreshControlMovement
  >;
};

type RefreshControlMovementAction = {
  claimed: boolean;
  destinationClaimed: boolean;
};

type RefreshControlMovement = Readonly<{
  identity: symbol;
  publication: RefreshControlPublication;
  source: HTMLButtonElement;
  destination: HTMLButtonElement;
  key: string;
  action: RefreshControlMovementAction;
}>;

interface RefreshControlTrustedAuthority {
  readonly read: (event: object) => boolean;
  readonly matches: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}

interface RefreshControlKeyboardIntrinsics {
  readonly ownerWindow: Window & typeof globalThis;
  readonly listenerTarget: EventTarget;
  readonly keyboardPrototype: object;
  readonly capturingPhase: number;
  readonly bubblingPhase: number;
  readonly apply: typeof Reflect.apply;
  readonly getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor;
  readonly getPrototypeOf: typeof Object.getPrototypeOf;
  readonly trusted: RefreshControlTrustedAuthority;
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
  readonly addEventListener: typeof EventTarget.prototype.addEventListener;
  readonly removeEventListener: typeof EventTarget.prototype.removeEventListener;
  readonly isCurrent: () => boolean;
  readonly methodMatches: (
    event: object,
    property: PropertyKey,
    value: unknown,
  ) => boolean;
}

interface RefreshControlKeyboardSnapshot {
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

type RefreshControlReactCancellation = Readonly<{
  isDefaultPrevented: () => boolean;
  isPropagationStopped: () => boolean;
}>;

type RefreshControlWindowProof = Readonly<{
  identity: symbol;
  publication: RefreshControlPublication;
  nativeEvent: KeyboardEvent;
  receiver: EventTarget;
  currentTarget: EventTarget;
  terminal: EventTarget;
  snapshot: RefreshControlKeyboardSnapshot;
}>;

interface RefreshControlKeyListener {
  readonly listener: (this: EventTarget, event: Event) => void;
  readonly activate: (publication: RefreshControlPublication) => boolean;
  readonly proofFor: (
    event: KeyboardEvent,
    publication: RefreshControlPublication,
  ) => RefreshControlWindowProof | null;
  readonly claim: (
    proof: RefreshControlWindowProof,
    publication: RefreshControlPublication,
  ) => boolean;
  readonly retains: (
    proof: RefreshControlWindowProof,
    publication: RefreshControlPublication,
  ) => boolean;
  readonly release: (publication: RefreshControlPublication) => void;
}

type RefreshControlReactKey = Readonly<{
  event: ReactKeyboardEvent<HTMLButtonElement>;
  kind: "refresh" | "dismiss";
  nativeEvent: KeyboardEvent;
  listenerProof: RefreshControlWindowProof;
  source: HTMLButtonElement;
  snapshot: RefreshControlKeyboardSnapshot;
  cancellation: RefreshControlReactCancellation;
}>;

type RefreshControlDomSnapshot = Readonly<{
  node: Node;
  nodeValue: string | null;
  attributes: readonly (readonly [string, string])[] | null;
  children: readonly RefreshControlDomSnapshot[];
}>;

type RefreshControlPlacement = Readonly<{
  document: Document;
  parent: Node;
  previousSibling: Node | null;
  nextSibling: Node | null;
}>;

type RefreshControlReplay = Readonly<{
  source: RefreshControlPublication;
  dom: RefreshControlDomSnapshot;
  placement: RefreshControlPlacement;
  historyIsClean: () => boolean;
  release: () => void;
}>;

type FailureControlRender = Readonly<{
  identity: symbol;
  mount: symbol;
  ownerDocument: Document;
  docId: string;
  initialHash: string;
  pollMs: number;
  document: DocumentAuthority;
  polling: PollingAuthority;
  failure: FailurePublication;
  attempt: FailureCheckAttempt | null;
  retry: (attempt: FailureCheckAttempt) => boolean;
}>;

type RetryAction = {
  claimed: boolean;
};

type FailureControlPublication = Readonly<{
  render: FailureControlRender;
  action: RetryAction;
  pill: HTMLDivElement;
  retryButton: HTMLButtonElement;
  ownerDocument: Document;
  retryTargets: readonly Node[];
  retire: () => boolean;
  isRetired: () => boolean;
  settlementIsCurrent: () => boolean;
}>;

type FailureControlCells = {
  active: CurrentCell<FailureControlPublication | null>;
  successorOf: CurrentCell<FailureControlPublication | null>;
  replay: CurrentCell<FailureControlReplay | null>;
  invalidFailures: WeakSet<FailurePublication>;
  claimedPublications: WeakSet<FailureControlPublication>;
  claimedActions: WeakSet<RetryAction>;
  claimedReactEvents: WeakSet<object>;
  claimedNativeEvents: WeakSet<Event>;
};

type FailureControlReplay = Readonly<{
  source: FailureControlPublication;
  dom: RefreshControlDomSnapshot;
  placement: RefreshControlPlacement;
  historyIsClean: () => boolean;
  release: () => void;
}>;

interface FailureControlRuntime {
  readonly publication: FailureControlPublication;
  readonly publish: (
    snapshot: RefreshControlDomSnapshot,
    placement: RefreshControlPlacement,
    owners: readonly ElementOwnerView[],
  ) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly retireForInvalidation: () => void;
  readonly noteRef: (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly snapshot: () => RefreshControlDomSnapshot | null;
  readonly placement: () => RefreshControlPlacement | null;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

type FailureControlPublicationSet = Readonly<{
  capturePill: (element: HTMLDivElement | null) => void;
  captureRetryButton: (element: HTMLButtonElement | null) => void;
  establish: () => void | (() => void);
  onRetry: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}>;

interface ElementOwnerView {
  readonly element: () => HTMLElement | null;
}

class ElementOwner<T extends HTMLElement> implements ElementOwnerView {
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: ElementOwnerView,
      element: T | null,
      previous: T | null,
      last: T | null,
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

type RefReplay = {
  readonly owner: ElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
};

interface RefreshControlDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface RefreshControlRuntime {
  readonly publication: RefreshControlPublication;
  readonly publish: (
    snapshot: RefreshControlDomSnapshot,
    placement: RefreshControlPlacement,
    owners: readonly ElementOwnerView[],
  ) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly retireForInvalidation: () => void;
  readonly noteRef: (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly snapshot: () => RefreshControlDomSnapshot | null;
  readonly placement: () => RefreshControlPlacement | null;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

type RefreshControlPublicationSet = Readonly<{
  capturePill: (element: HTMLDivElement | null) => void;
  captureRefreshButton: (element: HTMLButtonElement | null) => void;
  captureDismissButton: (element: HTMLButtonElement | null) => void;
  establish: () => void | (() => void);
  onRefresh: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onDismiss: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onRefreshKeyDownCapture: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  onDismissKeyDownCapture: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  onRefreshKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onDismissKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}>;

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotControlDom(node: Node): RefreshControlDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotControlDom)),
  });
}

function controlDomMatches(snapshot: RefreshControlDomSnapshot): boolean {
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
        node.childNodes.item(index) === child.node && controlDomMatches(child),
    )
  );
}

function captureControlPlacement(pill: HTMLDivElement): RefreshControlPlacement | null {
  const parent = pill.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: pill.ownerDocument,
    parent,
    previousSibling: pill.previousSibling,
    nextSibling: pill.nextSibling,
  });
}

function controlPlacementMatches(
  pill: HTMLDivElement,
  placement: RefreshControlPlacement,
): boolean {
  return (
    pill.ownerDocument === placement.document &&
    pill.parentNode === placement.parent &&
    pill.previousSibling === placement.previousSibling &&
    pill.nextSibling === placement.nextSibling
  );
}

function createControlDomGuard(
  pill: HTMLDivElement,
  placement: RefreshControlPlacement,
): RefreshControlDomGuard | null {
  const MutationObserverConstructor =
    placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((record) => {
      if (record.target === pill || pill.contains(record.target)) return true;
      if (record.type !== "childList" || record.target !== placement.parent) {
        return false;
      }
      return true;
    });
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(pill, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(placement.parent, { childList: true });
  return Object.freeze({
    isClean: () => {
      recordChanges(observer.takeRecords());
      return !changed;
    },
    release: () => {
      recordChanges(observer.takeRecords());
      observer.disconnect();
    },
  });
}

function descendantsOf(element: HTMLElement): readonly Node[] {
  const descendants: Node[] = [];
  const collect = (node: Node) => {
    descendants.push(node);
    for (const child of node.childNodes) collect(child);
  };
  collect(element);
  return Object.freeze(descendants);
}

const REFRESH_CONTROL_PREVENT_SCROLL = Object.freeze({
  preventScroll: true,
});

function refreshControlGetter<This extends object, Value>(
  ownerWindow: Window & typeof globalThis,
  prototype: object,
  property: string,
): ((this: This) => Value) | null {
  const getter = ownerWindow.Object.getOwnPropertyDescriptor(
    prototype,
    property,
  )?.get;
  return typeof getter === "function"
    ? (getter as (this: This) => Value)
    : null;
}

function refreshControlDescriptorsMatch(
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

function captureRefreshControlTrustedAuthority(
  ownerWindow: Window & typeof globalThis,
): RefreshControlTrustedAuthority | null {
  let probe: KeyboardEvent;
  try {
    probe = new ownerWindow.KeyboardEvent(
      "reader-update-keyboard-intrinsic",
    );
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
    refreshControlDescriptorsMatch(
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

function captureRefreshControlKeyboardIntrinsics(
  ownerWindow: Window & typeof globalThis,
): RefreshControlKeyboardIntrinsics | null {
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
  const trusted = captureRefreshControlTrustedAuthority(ownerWindow);
  const listenerTarget = ownerWindow;
  const type = refreshControlGetter<Event, string>(
    ownerWindow,
    eventPrototype,
    "type",
  );
  const target = refreshControlGetter<Event, EventTarget | null>(
    ownerWindow,
    eventPrototype,
    "target",
  );
  const currentTarget = refreshControlGetter<Event, EventTarget | null>(
    ownerWindow,
    eventPrototype,
    "currentTarget",
  );
  const eventPhase = refreshControlGetter<Event, number>(
    ownerWindow,
    eventPrototype,
    "eventPhase",
  );
  const bubbles = refreshControlGetter<Event, boolean>(
    ownerWindow,
    eventPrototype,
    "bubbles",
  );
  const cancelable = refreshControlGetter<Event, boolean>(
    ownerWindow,
    eventPrototype,
    "cancelable",
  );
  const defaultPrevented = refreshControlGetter<Event, boolean>(
    ownerWindow,
    eventPrototype,
    "defaultPrevented",
  );
  const cancelBubble = refreshControlGetter<Event, boolean>(
    ownerWindow,
    eventPrototype,
    "cancelBubble",
  );
  const key = refreshControlGetter<KeyboardEvent, string>(
    ownerWindow,
    keyboardPrototype,
    "key",
  );
  const code = refreshControlGetter<KeyboardEvent, string>(
    ownerWindow,
    keyboardPrototype,
    "code",
  );
  const location = refreshControlGetter<KeyboardEvent, number>(
    ownerWindow,
    keyboardPrototype,
    "location",
  );
  const altKey = refreshControlGetter<KeyboardEvent, boolean>(
    ownerWindow,
    keyboardPrototype,
    "altKey",
  );
  const ctrlKey = refreshControlGetter<KeyboardEvent, boolean>(
    ownerWindow,
    keyboardPrototype,
    "ctrlKey",
  );
  const metaKey = refreshControlGetter<KeyboardEvent, boolean>(
    ownerWindow,
    keyboardPrototype,
    "metaKey",
  );
  const shiftKey = refreshControlGetter<KeyboardEvent, boolean>(
    ownerWindow,
    keyboardPrototype,
    "shiftKey",
  );
  const repeat = refreshControlGetter<KeyboardEvent, boolean>(
    ownerWindow,
    keyboardPrototype,
    "repeat",
  );
  const isComposing = refreshControlGetter<KeyboardEvent, boolean>(
    ownerWindow,
    keyboardPrototype,
    "isComposing",
  );
  const view = refreshControlGetter<UIEvent, Window | null>(
    ownerWindow,
    uiEventPrototype,
    "view",
  );
  const activeElement = refreshControlGetter<Document, Element | null>(
    ownerWindow,
    documentPrototype,
    "activeElement",
  );
  const composedPath = eventPrototype.composedPath;
  const preventDefault = eventPrototype.preventDefault;
  const focus = htmlElementPrototype.focus;
  const addEventListener = ownerWindow.addEventListener;
  const removeEventListener = ownerWindow.removeEventListener;
  const apply = reflect.apply;
  const getOwnPropertyDescriptor =
    objectConstructor.getOwnPropertyDescriptor;
  const getPrototypeOf = objectConstructor.getPrototypeOf;
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
    typeof preventDefault !== "function" ||
    typeof focus !== "function" ||
    typeof addEventListener !== "function" ||
    typeof removeEventListener !== "function" ||
    typeof apply !== "function" ||
    typeof getOwnPropertyDescriptor !== "function" ||
    typeof getPrototypeOf !== "function"
  ) {
    return null;
  }
  const intrinsics: RefreshControlKeyboardIntrinsics = {
    ownerWindow,
    listenerTarget,
    keyboardPrototype,
    capturingPhase: eventConstructor.CAPTURING_PHASE,
    bubblingPhase: eventConstructor.BUBBLING_PHASE,
    apply,
    getOwnPropertyDescriptor,
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
    isCurrent: () =>
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
      eventPrototype.composedPath === composedPath &&
      eventPrototype.preventDefault === preventDefault &&
      htmlElementPrototype.focus === focus &&
      ownerWindow.addEventListener === addEventListener &&
      ownerWindow.removeEventListener === removeEventListener &&
      ownerWindow.Object.getOwnPropertyDescriptor ===
        getOwnPropertyDescriptor &&
      ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
      ownerWindow.Reflect.apply === apply &&
      trusted.isCurrent(),
    methodMatches: (
      event: object,
      property: PropertyKey,
      value: unknown,
    ) => {
      if (typeof value !== "function") return false;
      try {
        let owner: object | null = event;
        while (owner) {
          const descriptor = getOwnPropertyDescriptor(owner, property);
          if (descriptor) {
            return (
              "value" in descriptor && descriptor.value === value
            );
          }
          owner = getPrototypeOf(owner);
        }
        return false;
      } catch {
        return false;
      }
    },
  };
  return Object.freeze(intrinsics);
}

function readRefreshControlKeyboardEvent(
  event: Event,
  intrinsics: RefreshControlKeyboardIntrinsics,
): RefreshControlKeyboardSnapshot | null {
  try {
    if (
      intrinsics.getPrototypeOf(event) !==
        intrinsics.keyboardPrototype ||
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
      ctrlKey: intrinsics.apply(
        intrinsics.keyboard.ctrlKey,
        event,
        [],
      ),
      metaKey: intrinsics.apply(
        intrinsics.keyboard.metaKey,
        event,
        [],
      ),
      shiftKey: intrinsics.apply(
        intrinsics.keyboard.shiftKey,
        event,
        [],
      ),
      repeat: intrinsics.apply(
        intrinsics.keyboard.repeat,
        event,
        [],
      ),
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

function refreshControlKeyboardFactsMatch(
  left: RefreshControlKeyboardSnapshot,
  right: RefreshControlKeyboardSnapshot,
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

function refreshControlKeyboardPathMatches(
  path: readonly EventTarget[],
  source: HTMLButtonElement,
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

function refreshControlKeyboardStableFactsMatch(
  left: RefreshControlKeyboardSnapshot,
  right: RefreshControlKeyboardSnapshot,
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

function readRefreshControlReactCancellation(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  keyboard: RefreshControlKeyboardIntrinsics,
): RefreshControlReactCancellation | null {
  try {
    const isDefaultPrevented = event.isDefaultPrevented;
    const isPropagationStopped = event.isPropagationStopped;
    if (
      !keyboard.isCurrent() ||
      !keyboard.methodMatches(
        event,
        "isDefaultPrevented",
        isDefaultPrevented,
      ) ||
      !keyboard.methodMatches(
        event,
        "isPropagationStopped",
        isPropagationStopped,
      ) ||
      keyboard.apply(isDefaultPrevented, event, []) !== false ||
      keyboard.apply(isPropagationStopped, event, []) !== false
    ) {
      return null;
    }
    return Object.freeze({
      isDefaultPrevented,
      isPropagationStopped,
    });
  } catch {
    return null;
  }
}

function refreshControlReactCancellationMatches(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  expected: RefreshControlReactCancellation,
  keyboard: RefreshControlKeyboardIntrinsics,
): boolean {
  const current = readRefreshControlReactCancellation(event, keyboard);
  return Boolean(
    current &&
      current.isDefaultPrevented === expected.isDefaultPrevented &&
      current.isPropagationStopped ===
        expected.isPropagationStopped,
  );
}

function readRefreshControlReactKey(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  kind: "refresh" | "dismiss",
  publication: RefreshControlPublication,
  expectedPhase: number,
): RefreshControlReactKey | null {
  if (!event || typeof event !== "object") return null;
  const keyboard = publication.keyboard;
  const nativeEvent = event.nativeEvent;
  const listenerProof = publication.keyListener.proofFor(
    nativeEvent,
    publication,
  );
  const snapshot = listenerProof
    ? readRefreshControlKeyboardEvent(nativeEvent, keyboard)
    : null;
  const cancellation = snapshot
    ? readRefreshControlReactCancellation(event, keyboard)
    : null;
  const source =
    kind === "refresh"
      ? publication.refreshButton
      : publication.dismissButton;
  if (
    !listenerProof ||
    !snapshot ||
    !cancellation ||
    !keyboard.isCurrent() ||
    event === (nativeEvent as unknown) ||
    event.type !== "keydown" ||
    event.type !== snapshot.type ||
    event.nativeEvent !== nativeEvent ||
    event.currentTarget !== source ||
    event.target !== source ||
    event.eventPhase !== snapshot.eventPhase ||
    event.bubbles !== snapshot.bubbles ||
    event.cancelable !== snapshot.cancelable ||
    event.defaultPrevented !== snapshot.defaultPrevented ||
    event.isTrusted !== snapshot.isTrusted ||
    event.key !== snapshot.key ||
    event.code !== snapshot.code ||
    event.location !== snapshot.location ||
    event.altKey !== snapshot.altKey ||
    event.ctrlKey !== snapshot.ctrlKey ||
    event.metaKey !== snapshot.metaKey ||
    event.shiftKey !== snapshot.shiftKey ||
    event.repeat !== snapshot.repeat ||
    !Object.is(event.view, snapshot.view) ||
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
    (snapshot.view !== null &&
      snapshot.view !== keyboard.ownerWindow) ||
    !snapshot.path.includes(snapshot.currentTarget) ||
    snapshot.path.filter(
      (entry) => entry === snapshot.currentTarget,
    ).length !== 1 ||
    !refreshControlKeyboardPathMatches(
      snapshot.path,
      source,
      publication.ownerDocument,
      listenerProof.receiver,
    ) ||
    !refreshControlReactCancellationMatches(
      event,
      cancellation,
      keyboard,
    )
  ) {
    return null;
  }
  return Object.freeze({
    event,
    kind,
    source,
    nativeEvent,
    listenerProof,
    snapshot,
    cancellation,
  });
}

function refreshControlReactKeyPairMatches(
  capture: RefreshControlReactKey,
  bubble: RefreshControlReactKey,
  publication: RefreshControlPublication,
): boolean {
  const keyboard = publication.keyboard;
  return (
    capture.event !== bubble.event &&
    capture.kind === bubble.kind &&
    capture.source === bubble.source &&
    capture.nativeEvent === bubble.nativeEvent &&
    capture.listenerProof === bubble.listenerProof &&
    capture.listenerProof.publication === publication &&
    capture.listenerProof.nativeEvent === capture.nativeEvent &&
    capture.listenerProof.receiver ===
      capture.listenerProof.currentTarget &&
    capture.listenerProof.receiver ===
      capture.listenerProof.terminal &&
    capture.snapshot.eventPhase === keyboard.capturingPhase &&
    bubble.snapshot.eventPhase === keyboard.bubblingPhase &&
    refreshControlKeyboardStableFactsMatch(
      capture.snapshot,
      bubble.snapshot,
    ) &&
    capture.cancellation.isDefaultPrevented ===
      bubble.cancellation.isDefaultPrevented &&
    capture.cancellation.isPropagationStopped ===
      bubble.cancellation.isPropagationStopped &&
    refreshControlKeyboardPathMatches(
      capture.snapshot.path,
      capture.source,
      publication.ownerDocument,
      capture.listenerProof.receiver,
    ) &&
    refreshControlKeyboardPathMatches(
      bubble.snapshot.path,
      bubble.source,
      publication.ownerDocument,
      bubble.listenerProof.receiver,
    )
  );
}

function createRefreshControlKeyListener(
  keyboard: RefreshControlKeyboardIntrinsics,
): RefreshControlKeyListener {
  const proofs = new WeakMap<KeyboardEvent, RefreshControlWindowProof>();
  const invalidEvents = new WeakSet<Event>();
  const claimedProofs = new WeakSet<object>();
  let publication: RefreshControlPublication | null = null;
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
      keyboard.getPrototypeOf(event) !==
        keyboard.keyboardPrototype ||
      !keyboard.isCurrent()
    ) {
      return;
    }
    const nativeEvent = event as KeyboardEvent;
    if (proofs.has(nativeEvent)) {
      invalidEvents.add(nativeEvent);
      return;
    }
    const snapshot = readRefreshControlKeyboardEvent(
      nativeEvent,
      keyboard,
    );
    const source =
      snapshot?.target === current.refreshButton
        ? current.refreshButton
        : snapshot?.target === current.dismissButton
          ? current.dismissButton
          : null;
    const terminal = snapshot?.path.at(-1);
    if (
      !snapshot ||
      !source ||
      !terminal ||
      snapshot.currentTarget !== this ||
      terminal !== this ||
      snapshot.eventPhase !== keyboard.capturingPhase ||
      !refreshControlKeyboardPathMatches(
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
        identity: Symbol("reader-update-window-key-proof"),
        publication: current,
        nativeEvent,
        receiver: this,
        currentTarget: this,
        terminal,
        snapshot,
      }),
    );
  };

  const proofFor = (
    event: KeyboardEvent,
    current: RefreshControlPublication,
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
    const snapshot = readRefreshControlKeyboardEvent(event, keyboard);
    return snapshot &&
      refreshControlKeyboardStableFactsMatch(
        proof.snapshot,
        snapshot,
      ) &&
      refreshControlKeyboardPathMatches(
        snapshot.path,
        snapshot.target as HTMLButtonElement,
        current.ownerDocument,
        proof.receiver,
      )
      ? proof
      : null;
  };

  const registration: RefreshControlKeyListener = Object.freeze({
    listener,
    activate: (current: RefreshControlPublication) => {
      if (
        publication ||
        active ||
        released ||
        current.keyListener !== registration ||
        current.keyboard !== keyboard ||
        current.ownerDocument.defaultView !==
          keyboard.ownerWindow ||
        !keyboard.isCurrent()
      ) {
        return false;
      }
      publication = current;
      active = true;
      try {
        keyboard.apply(
          keyboard.addEventListener,
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
        keyboard.removeEventListener,
        keyboard.listenerTarget,
        ["keydown", listener, true],
      );
      return false;
    },
    proofFor,
    claim: (
      proof: RefreshControlWindowProof,
      current: RefreshControlPublication,
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
      proof: RefreshControlWindowProof,
      current: RefreshControlPublication,
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
    release: (current: RefreshControlPublication) => {
      if (publication !== current || released) return;
      released = true;
      const wasActive = active;
      active = false;
      if (wasActive) {
        keyboard.apply(
          keyboard.removeEventListener,
          keyboard.listenerTarget,
          ["keydown", listener, true],
        );
      }
    },
  });
  return registration;
}

function refreshControlDestination(
  key: string,
  sourceIndex: number,
): number {
  if (key === "ArrowRight" || key === "ArrowDown") {
    return sourceIndex < 1 ? sourceIndex + 1 : -1;
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return sourceIndex > 0 ? sourceIndex - 1 : -1;
  }
  if (key === "Home") return sourceIndex === 0 ? -1 : 0;
  if (key === "End") return sourceIndex === 1 ? -1 : 1;
  return -1;
}

function refreshControlIsVisible(
  pill: HTMLDivElement,
  ownerDocument: Document,
): boolean {
  if (ownerDocument.visibilityState !== "visible") return false;
  for (
    let element: HTMLElement | null = pill;
    element;
    element = element.parentElement
  ) {
    if (
      element.hidden ||
      element.getAttribute("aria-hidden")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function createFailureCheckAttempt(
  authority: PollingAuthority,
  failure: FailurePublication,
  source: FailureCheckAttempt["source"],
): FailureCheckAttempt {
  let release!: () => void;
  let released = false;
  const ready = new Promise<void>((resolve) => {
    release = () => {
      if (released) return;
      released = true;
      resolve();
    };
  });
  return Object.freeze({
    identity: Symbol(`reader-update-${source}-attempt`),
    authority,
    failure,
    source,
    control: Object.freeze({
      ready,
      publish: release,
      release,
    }),
  });
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

function isEffectivelyEnabled(button: HTMLButtonElement): boolean {
  if (
    button.disabled ||
    button.matches(":disabled") ||
    button.getAttribute("aria-disabled")?.toLowerCase() === "true"
  ) {
    return false;
  }
  for (let element: HTMLElement | null = button; element; element = element.parentElement) {
    if (
      element.hasAttribute("inert") ||
      element.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function controlHasExpectedPresentation(
  pill: HTMLDivElement,
  refreshButton: HTMLButtonElement,
  dismissButton: HTMLButtonElement,
): boolean {
  const updated = refreshButton.children.item(0);
  const separator = refreshButton.children.item(1);
  const refreshIcon = refreshButton.children.item(2);
  const refreshText = refreshButton.childNodes.item(3);
  const dismissIcon = dismissButton.children.item(0);
  return (
    pill.isConnected &&
    refreshButton.isConnected &&
    dismissButton.isConnected &&
    pill.ownerDocument === refreshButton.ownerDocument &&
    pill.ownerDocument === dismissButton.ownerDocument &&
    pill.tagName === "DIV" &&
    refreshButton.tagName === "BUTTON" &&
    dismissButton.tagName === "BUTTON" &&
    pill.getAttribute("class") === PILL_CLASS_NAME &&
    pill.getAttribute("role") === "status" &&
    pill.dataset.testid === "reader-updated" &&
    pill.children.length === 2 &&
    pill.childNodes.length === 2 &&
    pill.children.item(0) === refreshButton &&
    pill.children.item(1) === dismissButton &&
    refreshButton.parentElement === pill &&
    dismissButton.parentElement === pill &&
    refreshButton.getAttribute("type") === "button" &&
    refreshButton.type === "button" &&
    isEffectivelyEnabled(refreshButton) &&
    refreshButton.getAttribute("class") === BUTTON_CLASS_NAME &&
    refreshButton.children.length === 3 &&
    refreshButton.childNodes.length === 4 &&
    updated?.tagName === "SPAN" &&
    updated.getAttribute("class") === UPDATED_CLASS_NAME &&
    updated.childNodes.length === 1 &&
    updated.firstChild?.nodeType === 3 &&
    updated.firstChild.nodeValue === "Updated" &&
    separator?.tagName === "SPAN" &&
    separator.getAttribute("class") === SEPARATOR_CLASS_NAME &&
    separator.getAttribute("aria-hidden") === "true" &&
    separator.childNodes.length === 1 &&
    separator.firstChild?.nodeType === 3 &&
    separator.firstChild.nodeValue === "—" &&
    refreshIcon?.localName === "svg" &&
    refreshIcon.classList.contains("lucide-refresh-cw") &&
    refreshIcon.classList.contains(ICON_CLASS_NAME) &&
    refreshIcon.getAttribute("width") === "14" &&
    refreshIcon.getAttribute("height") === "14" &&
    refreshText?.nodeType === 3 &&
    refreshText.nodeValue === "Refresh" &&
    refreshButton.textContent === CONTROL_TEXT &&
    dismissButton.getAttribute("type") === "button" &&
    dismissButton.type === "button" &&
    isEffectivelyEnabled(dismissButton) &&
    dismissButton.getAttribute("class") === DISMISS_BUTTON_CLASS_NAME &&
    dismissButton.getAttribute("aria-label") === DISMISS_LABEL &&
    dismissButton.children.length === 1 &&
    dismissButton.childNodes.length === 1 &&
    dismissIcon?.localName === "svg" &&
    dismissIcon.classList.contains("lucide-x") &&
    dismissIcon.getAttribute("width") === "14" &&
    dismissIcon.getAttribute("height") === "14"
  );
}

function failureControlHasExpectedPresentation(
  pill: HTMLDivElement,
  retryButton: HTMLButtonElement,
  retryPending: boolean,
): boolean {
  const notice = pill.children.item(0);
  const message = notice?.children.item(0);
  return (
    pill.isConnected &&
    retryButton.isConnected &&
    pill.ownerDocument === retryButton.ownerDocument &&
    pill.tagName === "DIV" &&
    pill.getAttribute("class") === PILL_CLASS_NAME &&
    pill.getAttribute("role") === "status" &&
    pill.dataset.testid === "reader-update-error" &&
    pill.children.length === 1 &&
    pill.childNodes.length === 1 &&
    notice?.tagName === "DIV" &&
    notice.getAttribute("class") === FAILURE_NOTICE_CLASS_NAME &&
    notice.children.length === 2 &&
    notice.childNodes.length === 2 &&
    message?.tagName === "SPAN" &&
    message.childNodes.length === 1 &&
    message.firstChild?.nodeType === 3 &&
    message.firstChild.nodeValue === FAILURE_MESSAGE &&
    retryButton.parentElement === notice &&
    retryButton.tagName === "BUTTON" &&
    retryButton.getAttribute("type") === "button" &&
    retryButton.type === "button" &&
    retryButton.getAttribute("class") === RETRY_BUTTON_CLASS_NAME &&
    retryButton.children.length === 0 &&
    retryButton.childNodes.length === 1 &&
    retryButton.firstChild?.nodeType === 3 &&
    retryButton.firstChild.nodeValue === RETRY_TEXT &&
    retryButton.textContent === RETRY_TEXT &&
    retryButton.disabled === retryPending &&
    retryButton.matches(":disabled") === retryPending &&
    (retryPending || isEffectivelyEnabled(retryButton))
  );
}

function captureReloadAuthority(
  ownerDocument: Document,
): ReloadAuthority | null {
  const owner = window;
  if (owner.document !== ownerDocument) return null;
  const location = owner.location;
  const reload = location.reload;
  if (typeof reload !== "function") return null;
  return Object.freeze({ owner, location, reload });
}

function reloadAuthorityIsCurrent(
  authority: ReloadAuthority,
  ownerDocument: Document,
): boolean {
  return (
    authority.owner.document === ownerDocument &&
    authority.owner.location === authority.location &&
    authority.location.reload === authority.reload
  );
}

function reloadAuthoritiesMatch(
  previous: ReloadAuthority,
  current: ReloadAuthority,
): boolean {
  return (
    previous.owner === current.owner &&
    previous.location === current.location &&
    previous.reload === current.reload
  );
}

function controlAuthoritiesMatch(
  previous: RefreshControlRender,
  current: RefreshControlRender,
): boolean {
  return (
    previous.identity !== current.identity &&
    previous.mount === current.mount &&
    previous.ownerDocument === current.ownerDocument &&
    previous.docId === current.docId &&
    previous.initialHash === current.initialHash &&
    previous.pollMs === current.pollMs &&
    previous.document === current.document &&
    previous.polling === current.polling &&
    previous.refresh === current.refresh &&
    previous.refresh.remoteHash === current.refresh.remoteHash &&
    previous.dismiss === current.dismiss
  );
}

function retireInactiveControl(cells: RefreshControlCells) {
  cells.active.current?.retire();
  cells.replay.current?.release();
  cells.replay.current = null;
  cells.successorOf.current = null;
}

function createRefreshControlPublication(
  render: RefreshControlRender,
  cells: RefreshControlCells,
  documentAuthorityRef: React.RefObject<DocumentAuthority | null>,
  pollingAuthorityRef: React.RefObject<PollingAuthority | null>,
  refreshPublicationRef: React.RefObject<RefreshPublication | null>,
  requestSuccessor: () => void,
  dismissCurrentPublication: (publication: RefreshPublication) => void,
): RefreshControlPublicationSet {
  let currentRuntime: RefreshControlRuntime | null = null;
  let lastRuntime: RefreshControlRuntime | null = null;
  let successorRequested = false;

  const factsAreCurrent = () =>
    render.mount === render.document.mount &&
    render.ownerDocument === render.document.ownerDocument &&
    render.docId === render.document.docId &&
    render.initialHash === render.document.initialHash &&
    render.document === render.polling.document &&
    render.pollMs === render.polling.pollMs &&
    render.document === render.refresh.document &&
    render.dismiss === dismissCurrentPublication &&
    documentAuthorityRef.current === render.document &&
    pollingAuthorityRef.current === render.polling &&
    refreshPublicationRef.current === render.refresh &&
    !cells.invalidRefreshes.has(render.refresh) &&
    !cells.claimedRefreshes.has(render.refresh);

  const onElementChange = (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null) {
      currentRuntime?.retireForElement();
    } else if (last !== null && element !== last) {
      currentRuntime?.retireForInvalidation();
    }
    if (
      runtime?.isExactElementReplay() &&
      cells.successorOf.current === runtime.publication
    ) {
      requestReplaySuccessor(runtime);
    }
  };
  const pillOwner = new ElementOwner<HTMLDivElement>(onElementChange);
  const refreshButtonOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
  const dismissButtonOwner = new ElementOwner<HTMLButtonElement>(onElementChange);

  const exactDomIsCurrent = () => {
    const pill = pillOwner.element();
    const refreshButton = refreshButtonOwner.element();
    const dismissButton = dismissButtonOwner.element();
    return Boolean(
      pill &&
        refreshButton &&
        dismissButton &&
        pill.ownerDocument === render.ownerDocument &&
        refreshButton.ownerDocument === render.ownerDocument &&
        dismissButton.ownerDocument === render.ownerDocument &&
        controlHasExpectedPresentation(pill, refreshButton, dismissButton),
    );
  };

  const expectedOwners = (): readonly ElementOwnerView[] => [
    pillOwner,
    refreshButtonOwner,
    dismissButtonOwner,
  ];

  const publicationIsCurrent = (runtime: RefreshControlRuntime) => {
    const publication = runtime.publication;
    return (
      currentRuntime === runtime &&
      cells.active.current === publication &&
      !publication.isRetired() &&
      !publication.action.claimed &&
      !cells.claimedPublications.has(publication) &&
      !cells.claimedActions.has(publication.action) &&
      publication.render === render &&
      publication.pill === pillOwner.element() &&
      publication.refreshButton === refreshButtonOwner.element() &&
      publication.dismissButton === dismissButtonOwner.element() &&
      render.refresh.remoteHash.length > 0 &&
      render.refresh.remoteHash !== render.initialHash &&
      factsAreCurrent() &&
      exactDomIsCurrent() &&
      runtime.publishedDomMatches()
    );
  };

  const requestReplaySuccessor = (runtime: RefreshControlRuntime) => {
    const snapshot = runtime.snapshot();
    const placement = runtime.placement();
    const publication = runtime.publication;
    if (
      successorRequested ||
      !snapshot ||
      !placement ||
      cells.successorOf.current !== publication ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !reloadAuthorityIsCurrent(
        publication.reloadAuthority,
        publication.ownerDocument,
      ) ||
      !runtime.publishedDomMatches()
    ) {
      return;
    }
    successorRequested = true;
    cells.replay.current = Object.freeze({
      source: publication,
      dom: snapshot,
      placement,
      historyIsClean: runtime.historyIsClean,
      release: runtime.release,
    });
    requestSuccessor();
  };

  const createRuntime = (
    pill: HTMLDivElement,
    refreshButton: HTMLButtonElement,
    dismissButton: HTMLButtonElement,
    reloadAuthority: ReloadAuthority,
    keyboard: RefreshControlKeyboardIntrinsics,
  ): RefreshControlRuntime => {
    type Retirement = "element" | "layout" | "invalid" | "other";
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let domSnapshot: RefreshControlDomSnapshot | null = null;
    let placementSnapshot: RefreshControlPlacement | null = null;
    let domGuard: RefreshControlDomGuard | null = null;
    let replayRefs: RefReplay[] = [];
    let invalidReplay = false;
    const keyListener = createRefreshControlKeyListener(keyboard);

    const retire = (reason: Retirement) => {
      if (retired) return false;
      if (
        reason === "invalid" ||
        (reason === "element" && domGuard && !domGuard.isClean())
      ) {
        cells.invalidRefreshes.add(render.refresh);
      }
      retired = true;
      retirement = reason;
      keyListener.release(publication);
      if (cells.active.current === publication) {
        cells.active.current = null;
        cells.successorOf.current = publication;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      queueMicrotask(() => {
        if (cells.replay.current?.source !== publication) {
          domGuard?.release();
        }
        if (
          reason === "element" &&
          cells.active.current === null &&
          cells.successorOf.current === publication &&
          cells.replay.current?.source !== publication
        ) {
          cells.invalidRefreshes.add(render.refresh);
        }
      });
      return true;
    };
    const action: RefreshAction = { claimed: false };
    const publication: RefreshControlPublication = Object.freeze({
      render,
      action,
      pill,
      refreshButton,
      dismissButton,
      ownerDocument: pill.ownerDocument,
      refreshTargets: descendantsOf(refreshButton),
      dismissTargets: descendantsOf(dismissButton),
      reloadAuthority,
      keyboard,
      keyListener,
      retire: () => retire("other"),
      isRetired: () => retired,
    });
    const publishedDomMatches = () =>
      Boolean(
        domSnapshot &&
          placementSnapshot &&
          domGuard &&
          domGuard.isClean() &&
          pillOwner.element() === pill &&
          refreshButtonOwner.element() === refreshButton &&
          dismissButtonOwner.element() === dismissButton &&
          pill.isConnected &&
          refreshButton.isConnected &&
          dismissButton.isConnected &&
          controlPlacementMatches(pill, placementSnapshot) &&
          controlDomMatches(domSnapshot),
      );
    const refsHaveNoReplay = () =>
      !invalidReplay &&
      replayRefs.every(
        (entry) =>
          !entry.detached &&
          !entry.reattached &&
          entry.owner.element() === entry.element,
      );
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every(
        (entry) =>
          entry.detached &&
          entry.reattached &&
          entry.owner.element() === entry.element,
      );

    const runtime: RefreshControlRuntime = Object.freeze({
      publication,
      publish: (
        snapshot: RefreshControlDomSnapshot,
        placement: RefreshControlPlacement,
        owners: readonly ElementOwnerView[],
      ) => {
        established = true;
        domSnapshot = snapshot;
        placementSnapshot = placement;
        domGuard = createControlDomGuard(pill, placement);
        if (!domGuard) {
          throw new Error(
            "Cannot publish UpdatePill without a DOM mutation observer",
          );
        }
        replayRefs = owners.map((owner: ElementOwnerView) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish UpdatePill without every committed ref",
            );
          }
          return { owner, element, detached: false, reattached: false };
        });
        if (!keyListener.activate(publication)) {
          domGuard.release();
          throw new Error(
            "Cannot publish UpdatePill without keyboard authority",
          );
        }
        cells.active.current = publication;
        cells.successorOf.current = null;
        cells.replay.current = null;
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        layoutRetired = true;
        retire("layout");
      },
      retireForInvalidation: () => {
        retire("invalid");
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
      isExactElementReplay: () =>
        retired &&
        retirement === "element" &&
        layoutRetired &&
        established &&
        refsHaveExactReplay() &&
        publishedDomMatches(),
      isExactLayoutReplay: () =>
        retired &&
        retirement === "layout" &&
        established &&
        (refsHaveNoReplay() || refsHaveExactReplay()) &&
        publishedDomMatches(),
      publishedDomMatches,
      snapshot: () => domSnapshot,
      placement: () => placementSnapshot,
      historyIsClean: () => domGuard?.isClean() ?? false,
      release: () => {
        domGuard?.release();
      },
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
    if (!factsAreCurrent()) {
      if (
        !successorRequested &&
        documentAuthorityRef.current === render.document &&
        pollingAuthorityRef.current !== render.polling &&
        refreshPublicationRef.current === render.refresh &&
        exactDomIsCurrent()
      ) {
        successorRequested = true;
        requestSuccessor();
      }
      return undefined;
    }
    if (!exactDomIsCurrent()) return undefined;
    const pill = pillOwner.element();
    const refreshButton = refreshButtonOwner.element();
    const dismissButton = dismissButtonOwner.element();
    const placement = pill ? captureControlPlacement(pill) : null;
    const reloadAuthority = captureReloadAuthority(render.ownerDocument);
    const ownerWindow = render.ownerDocument.defaultView;
    const keyboard = ownerWindow
      ? captureRefreshControlKeyboardIntrinsics(ownerWindow)
      : null;
    if (
      !pill ||
      !refreshButton ||
      !dismissButton ||
      !placement ||
      !reloadAuthority ||
      !keyboard
    ) {
      return undefined;
    }

    const replay = cells.replay.current;
    if (replay) {
      const exactReplay =
        controlAuthoritiesMatch(replay.source.render, render) &&
        replay.source.isRetired() &&
        cells.successorOf.current === replay.source &&
        replay.historyIsClean() &&
        reloadAuthoritiesMatch(
          replay.source.reloadAuthority,
          reloadAuthority,
        ) &&
        pill === replay.dom.node &&
        controlPlacementMatches(pill, replay.placement) &&
        controlDomMatches(replay.dom);
      cells.replay.current = null;
      replay.release();
      if (cells.successorOf.current === replay.source) {
        cells.successorOf.current = null;
      }
      if (!exactReplay) return undefined;
    }

    const runtime = createRuntime(
      pill,
      refreshButton,
      dismissButton,
      reloadAuthority,
      keyboard,
    );
    const previous = cells.active.current;
    if (previous && previous !== runtime.publication) previous.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    runtime.publish(
      snapshotControlDom(pill),
      placement,
      expectedOwners(),
    );
    return runtime.retireForLayout;
  };

  const claim = (
    event: ReactMouseEvent<HTMLButtonElement>,
    kind: "refresh" | "dismiss",
  ) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const button =
      kind === "refresh"
        ? publication?.refreshButton
        : publication?.dismissButton;
    const targets =
      kind === "refresh"
        ? publication?.refreshTargets
        : publication?.dismissTargets;
    const ownerDocument = publication?.ownerDocument;
    const MouseEventConstructor = ownerDocument?.defaultView?.MouseEvent;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    if (
      !runtime ||
      !publication ||
      !button ||
      !targets ||
      !ownerDocument ||
      !MouseEventConstructor ||
      event.type !== "click" ||
      event.button !== 0 ||
      !(nativeEvent instanceof MouseEventConstructor) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      !nativeEvent.bubbles ||
      event.currentTarget !== button ||
      nativeEvent.target !== target ||
      !isNodeFromDocument(target, ownerDocument) ||
      !target.isConnected ||
      !button.contains(target) ||
      !targets.includes(target) ||
      event.defaultPrevented ||
      nativeEvent.defaultPrevented ||
      cells.claimedReactEvents.has(event) ||
      cells.claimedNativeEvents.has(nativeEvent) ||
      cells.activeMovements.has(publication) ||
      cells.claimedRefreshes.has(render.refresh) ||
      cells.claimedPublications.has(publication) ||
      cells.claimedActions.has(publication.action) ||
      publication.action.claimed
    ) {
      return;
    }
    if (!publicationIsCurrent(runtime)) {
      runtime.retireForInvalidation();
      return;
    }
    if (
      kind === "refresh" &&
      !reloadAuthorityIsCurrent(
        publication.reloadAuthority,
        publication.ownerDocument,
      )
    ) {
      runtime.retireForInvalidation();
      return;
    }

    cells.claimedRefreshes.add(render.refresh);
    cells.claimedPublications.add(publication);
    cells.claimedActions.add(publication.action);
    cells.claimedReactEvents.add(event);
    cells.claimedNativeEvents.add(nativeEvent);
    publication.action.claimed = true;
    publication.retire();
    if (
      kind === "refresh" &&
      refreshPublicationRef.current === render.refresh
    ) {
      refreshPublicationRef.current = null;
    }
    if (kind === "refresh") {
      publication.reloadAuthority.reload.call(
        publication.reloadAuthority.location,
      );
    } else {
      render.dismiss(render.refresh);
    }
  };

  const captureNavigation = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    kind: "refresh" | "dismiss",
  ) => {
    if (!event || typeof event !== "object") return;
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const nativeEvent = event.nativeEvent;
    const publications =
      publication && nativeEvent
        ? cells.reactKeys.get(publication)
        : undefined;
    if (publications && nativeEvent) {
      if (publications.has(nativeEvent)) {
        publications.delete(nativeEvent);
        return;
      }
    }
    if (!runtime || !publication) return;
    const keyboard = publication.keyboard;
    if (!keyboard.isCurrent()) {
      runtime.retireForInvalidation();
      return;
    }
    const key = readRefreshControlReactKey(
      event,
      kind,
      publication,
      keyboard.capturingPhase,
    );
    const controls = publication
      ? ([publication.refreshButton, publication.dismissButton] as const)
      : null;
    const sourceIndex =
      controls && key ? controls.indexOf(key.source) : -1;
    const destinationIndex =
      key && sourceIndex >= 0
        ? refreshControlDestination(key.snapshot.key, sourceIndex)
        : -1;
    const destination =
      controls && destinationIndex >= 0
        ? controls[destinationIndex]
        : undefined;
    if (
      !key ||
      !controls ||
      !destination ||
      sourceIndex < 0 ||
      destinationIndex < 0 ||
      destination === key.source ||
      publication.ownerDocument.defaultView !== keyboard.ownerWindow ||
      keyboard.ownerWindow.document !== publication.ownerDocument ||
      keyboard.apply(
        keyboard.activeElement,
        publication.ownerDocument,
        [],
      ) !== key.source ||
      !refreshControlIsVisible(
        publication.pill,
        publication.ownerDocument,
      ) ||
      !isEffectivelyEnabled(key.source) ||
      !isEffectivelyEnabled(destination) ||
      cells.claimedReactEvents.has(event) ||
      cells.claimedNativeEvents.has(nativeEvent) ||
      cells.activeMovements.has(publication) ||
      cells.claimedDestinations.has(destination) ||
      !publicationIsCurrent(runtime)
    ) {
      return;
    }
    let reactKeys = cells.reactKeys.get(publication);
    if (!reactKeys) {
      reactKeys = new WeakMap();
      cells.reactKeys.set(publication, reactKeys);
    }
    reactKeys.set(nativeEvent, key);
  };

  const navigate = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    kind: "refresh" | "dismiss",
  ) => {
    if (!event || typeof event !== "object") return;
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const nativeEvent = event.nativeEvent;
    const reactKeys = publication
      ? cells.reactKeys.get(publication)
      : undefined;
    const captured =
      reactKeys && nativeEvent ? reactKeys.get(nativeEvent) : undefined;
    if (reactKeys && nativeEvent) reactKeys.delete(nativeEvent);
    if (!runtime || !publication || !captured) return;
    const keyboard = publication.keyboard;
    if (!keyboard.isCurrent()) {
      runtime.retireForInvalidation();
      return;
    }
    const bubble = readRefreshControlReactKey(
      event,
      kind,
      publication,
      keyboard.bubblingPhase,
    );
    const controls = [
      publication.refreshButton,
      publication.dismissButton,
    ] as const;
    const sourceIndex = bubble
      ? controls.indexOf(bubble.source)
      : -1;
    const destinationIndex =
      bubble && sourceIndex >= 0
        ? refreshControlDestination(
            bubble.snapshot.key,
            sourceIndex,
          )
        : -1;
    const destination =
      destinationIndex >= 0
        ? controls[destinationIndex]
        : undefined;
    if (
      !bubble ||
      !destination ||
      sourceIndex < 0 ||
      destinationIndex < 0 ||
      destination === bubble.source ||
      publication.ownerDocument.defaultView !==
        keyboard.ownerWindow ||
      keyboard.ownerWindow.document !== publication.ownerDocument ||
      !refreshControlReactKeyPairMatches(
        captured,
        bubble,
        publication,
      ) ||
      keyboard.apply(
        keyboard.activeElement,
        publication.ownerDocument,
        [],
      ) !== bubble.source ||
      !refreshControlIsVisible(
        publication.pill,
        publication.ownerDocument,
      ) ||
      !isEffectivelyEnabled(bubble.source) ||
      !isEffectivelyEnabled(destination) ||
      cells.claimedReactEvents.has(captured.event) ||
      cells.claimedReactEvents.has(event) ||
      cells.claimedNativeEvents.has(nativeEvent) ||
      cells.activeMovements.has(publication) ||
      cells.claimedDestinations.has(destination) ||
      !publicationIsCurrent(runtime) ||
      !refreshControlReactCancellationMatches(
        captured.event,
        captured.cancellation,
        keyboard,
      ) ||
      !refreshControlReactCancellationMatches(
        event,
        bubble.cancellation,
        keyboard,
      ) ||
      !publication.keyListener.claim(
        bubble.listenerProof,
        publication,
      )
    ) {
      return;
    }

    const action: RefreshControlMovementAction = {
      claimed: false,
      destinationClaimed: false,
    };
    const movement = Object.freeze<RefreshControlMovement>({
      identity: Symbol("reader-update-control-movement"),
      publication,
      source: bubble.source,
      destination,
      key: bubble.snapshot.key,
      action,
    });
    cells.activeMovements.set(publication, movement);
    cells.claimedMovements.add(movement);
    cells.claimedMovementActions.add(action);
    cells.claimedReactEvents.add(captured.event);
    cells.claimedReactEvents.add(event);
    cells.claimedNativeEvents.add(nativeEvent);
    cells.claimedDestinations.set(destination, movement);
    action.claimed = true;
    action.destinationClaimed = true;

    try {
      const currentSnapshot = readRefreshControlKeyboardEvent(
        nativeEvent,
        keyboard,
      );
      if (
        !currentSnapshot ||
        !refreshControlKeyboardFactsMatch(
          bubble.snapshot,
          currentSnapshot,
        ) ||
        !publication.keyListener.retains(
          bubble.listenerProof,
          publication,
        ) ||
        !refreshControlReactCancellationMatches(
          captured.event,
          captured.cancellation,
          keyboard,
        ) ||
        !refreshControlReactCancellationMatches(
          event,
          bubble.cancellation,
          keyboard,
        ) ||
        cells.activeMovements.get(publication) !== movement ||
        !cells.claimedMovements.has(movement) ||
        !cells.claimedMovementActions.has(action) ||
        cells.claimedDestinations.get(destination) !== movement ||
        !action.claimed ||
        !action.destinationClaimed ||
        movement.publication !== publication ||
        movement.source !== bubble.source ||
        movement.destination !== destination ||
        movement.key !== bubble.snapshot.key ||
        keyboard.apply(
          keyboard.activeElement,
          publication.ownerDocument,
          [],
        ) !== bubble.source ||
        !refreshControlIsVisible(
          publication.pill,
          publication.ownerDocument,
        ) ||
        !publicationIsCurrent(runtime)
      ) {
        return;
      }
      keyboard.apply(
        keyboard.event.preventDefault,
        nativeEvent,
        [],
      );
      if (
        !keyboard.apply(
          keyboard.event.defaultPrevented,
          nativeEvent,
          [],
        ) ||
        !publication.keyListener.retains(
          bubble.listenerProof,
          publication,
        ) ||
        cells.activeMovements.get(publication) !== movement ||
        cells.claimedDestinations.get(destination) !== movement ||
        keyboard.apply(
          keyboard.activeElement,
          publication.ownerDocument,
          [],
        ) !== bubble.source ||
        !refreshControlIsVisible(
          publication.pill,
          publication.ownerDocument,
        ) ||
        !publicationIsCurrent(runtime)
      ) {
        return;
      }
      keyboard.apply(keyboard.focus, destination, [
        REFRESH_CONTROL_PREVENT_SCROLL,
      ]);
    } finally {
      if (cells.activeMovements.get(publication) === movement) {
        cells.activeMovements.delete(publication);
      }
      if (cells.claimedDestinations.get(destination) === movement) {
        cells.claimedDestinations.delete(destination);
      }
    }
  };

  return Object.freeze({
    capturePill: pillOwner.capture,
    captureRefreshButton: refreshButtonOwner.capture,
    captureDismissButton: dismissButtonOwner.capture,
    establish,
    onRefresh: (event) => claim(event, "refresh"),
    onDismiss: (event) => claim(event, "dismiss"),
    onRefreshKeyDownCapture: (event) =>
      captureNavigation(event, "refresh"),
    onDismissKeyDownCapture: (event) =>
      captureNavigation(event, "dismiss"),
    onRefreshKeyDown: (event) => navigate(event, "refresh"),
    onDismissKeyDown: (event) => navigate(event, "dismiss"),
  });
}

function failureControlAuthoritiesMatch(
  previous: FailureControlRender,
  current: FailureControlRender,
): boolean {
  return (
    previous.identity !== current.identity &&
    previous.mount === current.mount &&
    previous.ownerDocument === current.ownerDocument &&
    previous.docId === current.docId &&
    previous.initialHash === current.initialHash &&
    previous.pollMs === current.pollMs &&
    previous.document === current.document &&
    previous.polling === current.polling &&
    previous.failure === current.failure &&
    previous.attempt === current.attempt &&
    previous.retry === current.retry
  );
}

function retireInactiveFailureControl(cells: FailureControlCells) {
  cells.active.current?.retire();
  cells.replay.current?.release();
  cells.replay.current = null;
  cells.successorOf.current = null;
}

function failureControlSettlementIsCurrent(
  cells: FailureControlCells,
  attempt: FailureCheckAttempt,
): boolean {
  const publication = cells.active.current;
  return Boolean(
    publication &&
      publication.render.attempt === attempt &&
      publication.render.failure === attempt.failure &&
      publication.render.polling === attempt.authority &&
      publication.settlementIsCurrent(),
  );
}

function createFailureControlPublication(
  render: FailureControlRender,
  cells: FailureControlCells,
  documentAuthorityRef: React.RefObject<DocumentAuthority | null>,
  pollingAuthorityRef: React.RefObject<PollingAuthority | null>,
  failurePublicationRef: React.RefObject<FailurePublication | null>,
  failureAttemptRef: React.RefObject<FailureCheckAttempt | null>,
  requestSuccessor: () => void,
): FailureControlPublicationSet {
  let currentRuntime: FailureControlRuntime | null = null;
  let lastRuntime: FailureControlRuntime | null = null;
  let successorRequested = false;

  const factsAreCurrent = () =>
    render.mount === render.document.mount &&
    render.ownerDocument === render.document.ownerDocument &&
    render.docId === render.document.docId &&
    render.initialHash === render.document.initialHash &&
    render.document === render.polling.document &&
    render.pollMs === render.polling.pollMs &&
    render.failure.authority === render.polling &&
    (render.attempt === null ||
      (render.attempt.authority === render.polling &&
        render.attempt.failure === render.failure)) &&
    documentAuthorityRef.current === render.document &&
    pollingAuthorityRef.current === render.polling &&
    failurePublicationRef.current === render.failure &&
    failureAttemptRef.current === render.attempt &&
    !cells.invalidFailures.has(render.failure);

  const onElementChange = (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null) {
      currentRuntime?.retireForElement();
    } else if (last !== null && element !== last) {
      currentRuntime?.retireForInvalidation();
    }
    if (
      runtime?.isExactElementReplay() &&
      cells.successorOf.current === runtime.publication
    ) {
      requestReplaySuccessor(runtime);
    }
  };
  const pillOwner = new ElementOwner<HTMLDivElement>(onElementChange);
  const retryButtonOwner = new ElementOwner<HTMLButtonElement>(onElementChange);

  const exactDomIsCurrent = () => {
    const pill = pillOwner.element();
    const retryButton = retryButtonOwner.element();
    return Boolean(
      pill &&
        retryButton &&
        pill.ownerDocument === render.ownerDocument &&
        retryButton.ownerDocument === render.ownerDocument &&
        failureControlHasExpectedPresentation(
          pill,
          retryButton,
          render.attempt !== null,
        ),
    );
  };

  const expectedOwners = (): readonly ElementOwnerView[] => [
    pillOwner,
    retryButtonOwner,
  ];

  const publicationIsCurrent = (runtime: FailureControlRuntime) => {
    const publication = runtime.publication;
    return (
      currentRuntime === runtime &&
      cells.active.current === publication &&
      !publication.isRetired() &&
      !publication.action.claimed &&
      !cells.claimedPublications.has(publication) &&
      !cells.claimedActions.has(publication.action) &&
      publication.render === render &&
      publication.pill === pillOwner.element() &&
      publication.retryButton === retryButtonOwner.element() &&
      factsAreCurrent() &&
      exactDomIsCurrent() &&
      runtime.publishedDomMatches()
    );
  };

  const requestReplaySuccessor = (runtime: FailureControlRuntime) => {
    const snapshot = runtime.snapshot();
    const placement = runtime.placement();
    const publication = runtime.publication;
    if (
      successorRequested ||
      !snapshot ||
      !placement ||
      cells.successorOf.current !== publication ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches()
    ) {
      return;
    }
    successorRequested = true;
    cells.replay.current = Object.freeze({
      source: publication,
      dom: snapshot,
      placement,
      historyIsClean: runtime.historyIsClean,
      release: runtime.release,
    });
    requestSuccessor();
  };

  const createRuntime = (
    pill: HTMLDivElement,
    retryButton: HTMLButtonElement,
  ): FailureControlRuntime => {
    type Retirement = "element" | "layout" | "invalid" | "other";
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let domSnapshot: RefreshControlDomSnapshot | null = null;
    let placementSnapshot: RefreshControlPlacement | null = null;
    let domGuard: RefreshControlDomGuard | null = null;
    let replayRefs: RefReplay[] = [];
    let invalidReplay = false;
    const retire = (reason: Retirement) => {
      if (retired) return false;
      if (
        reason === "invalid" ||
        (reason === "element" && domGuard && !domGuard.isClean())
      ) {
        cells.invalidFailures.add(render.failure);
        render.attempt?.control.release();
      }
      retired = true;
      retirement = reason;
      if (cells.active.current === publication) {
        cells.active.current = null;
        cells.successorOf.current = publication;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      queueMicrotask(() => {
        if (cells.replay.current?.source !== publication) {
          domGuard?.release();
        }
        if (
          reason === "element" &&
          cells.active.current === null &&
          cells.successorOf.current === publication &&
          cells.replay.current?.source !== publication
        ) {
          cells.invalidFailures.add(render.failure);
          render.attempt?.control.release();
        }
      });
      return true;
    };
    const action: RetryAction = { claimed: false };
    const publication: FailureControlPublication = Object.freeze({
      render,
      action,
      pill,
      retryButton,
      ownerDocument: pill.ownerDocument,
      retryTargets: descendantsOf(retryButton),
      retire: () => retire("other"),
      isRetired: () => retired,
      settlementIsCurrent: () => {
        if (render.attempt === null) return false;
        const current = publicationIsCurrent(runtime);
        if (
          !current &&
          !retired &&
          cells.active.current === publication &&
          factsAreCurrent()
        ) {
          runtime.retireForInvalidation();
        }
        return current;
      },
    });
    const publishedDomMatches = () =>
      Boolean(
        domSnapshot &&
          placementSnapshot &&
          domGuard &&
          domGuard.isClean() &&
          pillOwner.element() === pill &&
          retryButtonOwner.element() === retryButton &&
          pill.isConnected &&
          retryButton.isConnected &&
          controlPlacementMatches(pill, placementSnapshot) &&
          controlDomMatches(domSnapshot),
      );
    const refsHaveNoReplay = () =>
      !invalidReplay &&
      replayRefs.every(
        (entry) =>
          !entry.detached &&
          !entry.reattached &&
          entry.owner.element() === entry.element,
      );
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every(
        (entry) =>
          entry.detached &&
          entry.reattached &&
          entry.owner.element() === entry.element,
      );

    const runtime: FailureControlRuntime = Object.freeze({
      publication,
      publish: (
        snapshot: RefreshControlDomSnapshot,
        placement: RefreshControlPlacement,
        owners: readonly ElementOwnerView[],
      ) => {
        established = true;
        domSnapshot = snapshot;
        placementSnapshot = placement;
        domGuard = createControlDomGuard(pill, placement);
        if (!domGuard) {
          throw new Error(
            "Cannot publish UpdatePill failure without a DOM mutation observer",
          );
        }
        replayRefs = owners.map((owner: ElementOwnerView) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish UpdatePill failure without every committed ref",
            );
          }
          return { owner, element, detached: false, reattached: false };
        });
        cells.active.current = publication;
        cells.successorOf.current = null;
        cells.replay.current = null;
        if (render.attempt) {
          queueMicrotask(() => {
            if (publication.settlementIsCurrent()) {
              render.attempt?.control.publish();
            }
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
      retireForInvalidation: () => {
        retire("invalid");
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
      isExactElementReplay: () =>
        retired &&
        retirement === "element" &&
        layoutRetired &&
        established &&
        refsHaveExactReplay() &&
        publishedDomMatches(),
      isExactLayoutReplay: () =>
        retired &&
        retirement === "layout" &&
        established &&
        (refsHaveNoReplay() || refsHaveExactReplay()) &&
        publishedDomMatches(),
      publishedDomMatches,
      snapshot: () => domSnapshot,
      placement: () => placementSnapshot,
      historyIsClean: () => domGuard?.isClean() ?? false,
      release: () => {
        domGuard?.release();
      },
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
    if (!factsAreCurrent()) {
      if (
        !successorRequested &&
        documentAuthorityRef.current === render.document &&
        pollingAuthorityRef.current !== render.polling &&
        failurePublicationRef.current === render.failure &&
        exactDomIsCurrent()
      ) {
        successorRequested = true;
        requestSuccessor();
      }
      return undefined;
    }
    if (!exactDomIsCurrent()) {
      if (factsAreCurrent()) {
        cells.invalidFailures.add(render.failure);
        render.attempt?.control.release();
      }
      return undefined;
    }
    const pill = pillOwner.element();
    const retryButton = retryButtonOwner.element();
    const placement = pill ? captureControlPlacement(pill) : null;
    if (!pill || !retryButton || !placement) {
      cells.invalidFailures.add(render.failure);
      render.attempt?.control.release();
      return undefined;
    }

    const replay = cells.replay.current;
    if (replay) {
      const exactReplay =
        failureControlAuthoritiesMatch(replay.source.render, render) &&
        replay.source.isRetired() &&
        cells.successorOf.current === replay.source &&
        replay.historyIsClean() &&
        pill === replay.dom.node &&
        controlPlacementMatches(pill, replay.placement) &&
        controlDomMatches(replay.dom);
      cells.replay.current = null;
      replay.release();
      if (cells.successorOf.current === replay.source) {
        cells.successorOf.current = null;
      }
      if (!exactReplay) {
        cells.invalidFailures.add(render.failure);
        render.attempt?.control.release();
        return undefined;
      }
    }

    const runtime = createRuntime(pill, retryButton);
    const previous = cells.active.current;
    if (previous && previous !== runtime.publication) previous.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    runtime.publish(
      snapshotControlDom(pill),
      placement,
      expectedOwners(),
    );
    return runtime.retireForLayout;
  };

  const onRetry = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const button = publication?.retryButton;
    const ownerDocument = publication?.ownerDocument;
    const MouseEventConstructor = ownerDocument?.defaultView?.MouseEvent;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    const propagationStopped =
      typeof event?.isPropagationStopped === "function" &&
      event.isPropagationStopped();
    const defaultPrevented =
      event.defaultPrevented ||
      (typeof event?.isDefaultPrevented === "function" &&
        event.isDefaultPrevented());
    if (
      !runtime ||
      !publication ||
      !button ||
      !ownerDocument ||
      !MouseEventConstructor ||
      render.attempt !== null ||
      event.type !== "click" ||
      event.button !== 0 ||
      !(nativeEvent instanceof MouseEventConstructor) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      !nativeEvent.bubbles ||
      event.currentTarget !== button ||
      nativeEvent.target !== target ||
      !isNodeFromDocument(target, ownerDocument) ||
      !target.isConnected ||
      !button.contains(target) ||
      !publication.retryTargets.includes(target) ||
      defaultPrevented ||
      nativeEvent.defaultPrevented ||
      propagationStopped ||
      nativeEvent.cancelBubble ||
      cells.claimedReactEvents.has(event) ||
      cells.claimedNativeEvents.has(nativeEvent) ||
      cells.claimedPublications.has(publication) ||
      cells.claimedActions.has(publication.action) ||
      publication.action.claimed
    ) {
      return;
    }
    if (render.ownerDocument.visibilityState !== "visible") return;
    if (!publicationIsCurrent(runtime)) {
      runtime.retireForInvalidation();
      return;
    }

    const attempt = createFailureCheckAttempt(
      render.polling,
      render.failure,
      "retry",
    );
    cells.claimedPublications.add(publication);
    cells.claimedActions.add(publication.action);
    cells.claimedReactEvents.add(event);
    cells.claimedNativeEvents.add(nativeEvent);
    publication.action.claimed = true;
    publication.retire();
    render.retry(attempt);
  };

  return Object.freeze({
    capturePill: pillOwner.capture,
    captureRetryButton: retryButtonOwner.capture,
    establish,
    onRetry,
  });
}

function FailureControl({
  mount,
  ownerDocument,
  docId,
  initialHash,
  pollMs,
  documentAuthority,
  pollingAuthority,
  failurePublication,
  failureAttempt,
  cells,
  documentAuthorityRef,
  pollingAuthorityRef,
  failurePublicationRef,
  failureAttemptRef,
  retryCurrentFailure,
}: {
  mount: symbol;
  ownerDocument: Document;
  docId: string;
  initialHash: string;
  pollMs: number;
  documentAuthority: DocumentAuthority;
  pollingAuthority: PollingAuthority;
  failurePublication: FailurePublication;
  failureAttempt: FailureCheckAttempt | null;
  cells: FailureControlCells;
  documentAuthorityRef: React.RefObject<DocumentAuthority | null>;
  pollingAuthorityRef: React.RefObject<PollingAuthority | null>;
  failurePublicationRef: React.RefObject<FailurePublication | null>;
  failureAttemptRef: React.RefObject<FailureCheckAttempt | null>;
  retryCurrentFailure: (attempt: FailureCheckAttempt) => boolean;
}) {
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const render = Object.freeze<FailureControlRender>({
    identity: Symbol("reader-update-failure-control-render"),
    mount,
    ownerDocument,
    docId,
    initialHash,
    pollMs,
    document: documentAuthority,
    polling: pollingAuthority,
    failure: failurePublication,
    attempt: failureAttempt,
    retry: retryCurrentFailure,
  });
  const publication = createFailureControlPublication(
    render,
    cells,
    documentAuthorityRef,
    pollingAuthorityRef,
    failurePublicationRef,
    failureAttemptRef,
    requestPublicationSuccessor,
  );

  useLayoutEffect(() => publication.establish(), [publication]);

  const { capturePill, captureRetryButton, onRetry } = publication;
  return (
    <div
      ref={capturePill}
      className={PILL_CLASS_NAME}
      role="status"
      data-testid="reader-update-error"
    >
      <div className={FAILURE_NOTICE_CLASS_NAME}>
        <span>{FAILURE_MESSAGE}</span>
        <button
          ref={captureRetryButton}
          type="button"
          className={RETRY_BUTTON_CLASS_NAME}
          disabled={failureAttempt !== null}
          onClick={onRetry}
        >
          {RETRY_TEXT}
        </button>
      </div>
    </div>
  );
}

function RefreshControl({
  mount,
  ownerDocument,
  docId,
  initialHash,
  pollMs,
  documentAuthority,
  pollingAuthority,
  refreshPublication,
  cells,
  documentAuthorityRef,
  pollingAuthorityRef,
  refreshPublicationRef,
  dismissCurrentPublication,
}: {
  mount: symbol;
  ownerDocument: Document;
  docId: string;
  initialHash: string;
  pollMs: number;
  documentAuthority: DocumentAuthority;
  pollingAuthority: PollingAuthority;
  refreshPublication: RefreshPublication;
  cells: RefreshControlCells;
  documentAuthorityRef: React.RefObject<DocumentAuthority | null>;
  pollingAuthorityRef: React.RefObject<PollingAuthority | null>;
  refreshPublicationRef: React.RefObject<RefreshPublication | null>;
  dismissCurrentPublication: (publication: RefreshPublication) => void;
}) {
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const render = Object.freeze<RefreshControlRender>({
    identity: Symbol("reader-update-control-render"),
    mount,
    ownerDocument,
    docId,
    initialHash,
    pollMs,
    document: documentAuthority,
    polling: pollingAuthority,
    refresh: refreshPublication,
    dismiss: dismissCurrentPublication,
  });
  const publication = createRefreshControlPublication(
    render,
    cells,
    documentAuthorityRef,
    pollingAuthorityRef,
    refreshPublicationRef,
    requestPublicationSuccessor,
    dismissCurrentPublication,
  );

  useLayoutEffect(() => publication.establish(), [publication]);

  const {
    capturePill,
    captureRefreshButton,
    captureDismissButton,
    onRefresh,
    onDismiss,
    onRefreshKeyDownCapture,
    onDismissKeyDownCapture,
    onRefreshKeyDown,
    onDismissKeyDown,
  } = publication;
  return (
    <div
      ref={capturePill}
      className={PILL_CLASS_NAME}
      role="status"
      data-testid="reader-updated"
    >
      <button
        ref={captureRefreshButton}
        type="button"
        className={BUTTON_CLASS_NAME}
        onClick={onRefresh}
        onKeyDownCapture={onRefreshKeyDownCapture}
        onKeyDown={onRefreshKeyDown}
      >
        <span className={UPDATED_CLASS_NAME}>Updated</span>
        <span aria-hidden className={SEPARATOR_CLASS_NAME}>
          —
        </span>
        <RefreshCw size={14} className={ICON_CLASS_NAME} />
        Refresh
      </button>
      <button
        ref={captureDismissButton}
        type="button"
        className={DISMISS_BUTTON_CLASS_NAME}
        aria-label={DISMISS_LABEL}
        onClick={onDismiss}
        onKeyDownCapture={onDismissKeyDownCapture}
        onKeyDown={onDismissKeyDown}
      >
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * Polls the document's content hash while the tab is visible and offers a refresh when it
 * changed. No WebSocket: a reader does not need live cursors, only to know it is stale.
 */
export function UpdatePill({
  docId,
  initialHash,
  pollMs,
}: {
  docId: string;
  initialHash: string;
  pollMs: number;
}) {
  const [mount] = useState(() => Symbol("reader-update-pill"));
  const ownerDocument =
    typeof document === "undefined" ? null : document;
  const documentAuthority = useMemo<DocumentAuthority | null>(
    () =>
      ownerDocument
        ? Object.freeze({ mount, ownerDocument, docId, initialHash })
        : null,
    [mount, ownerDocument, docId, initialHash],
  );
  const authority = useMemo<PollingAuthority | null>(
    () =>
      documentAuthority
        ? Object.freeze({ document: documentAuthority, pollMs })
        : null,
    [documentAuthority, pollMs],
  );
  const documentAuthorityRef = useRef<DocumentAuthority | null>(null);
  const authorityRef = useRef<PollingAuthority | null>(null);
  const pollingOwnerRef = useRef<PollingOwner | null>(null);
  const requestOwnerRef = useRef<RequestOwner | null>(null);
  const refreshPublicationRef = useRef<RefreshPublication | null>(null);
  const dismissedUpdateRef = useRef<DismissedUpdate | null>(null);
  const failurePublicationRef = useRef<FailurePublication | null>(null);
  const failureAttemptRef = useRef<FailureCheckAttempt | null>(null);
  const [refreshPublication, setRefreshPublication] =
    useState<RefreshPublication | null>(null);
  const [failureState, setFailureState] = useState<FailureState | null>(null);
  const [controlCells] = useState<RefreshControlCells>(() => ({
    active: { current: null },
    successorOf: { current: null },
    replay: { current: null },
    invalidRefreshes: new WeakSet<RefreshPublication>(),
    claimedRefreshes: new WeakSet<RefreshPublication>(),
    claimedPublications: new WeakSet<RefreshControlPublication>(),
    claimedActions: new WeakSet<RefreshAction>(),
    claimedReactEvents: new WeakSet<object>(),
    claimedNativeEvents: new WeakSet<Event>(),
    reactKeys: new WeakMap<
      RefreshControlPublication,
      WeakMap<KeyboardEvent, RefreshControlReactKey>
    >(),
    claimedMovements: new WeakSet<RefreshControlMovement>(),
    claimedMovementActions: new WeakSet<RefreshControlMovementAction>(),
    activeMovements: new WeakMap<
      RefreshControlPublication,
      RefreshControlMovement
    >(),
    claimedDestinations: new WeakMap<
      HTMLButtonElement,
      RefreshControlMovement
    >(),
  }));
  const [failureControlCells] = useState<FailureControlCells>(() => ({
    active: { current: null },
    successorOf: { current: null },
    replay: { current: null },
    invalidFailures: new WeakSet<FailurePublication>(),
    claimedPublications: new WeakSet<FailureControlPublication>(),
    claimedActions: new WeakSet<RetryAction>(),
    claimedReactEvents: new WeakSet<object>(),
    claimedNativeEvents: new WeakSet<Event>(),
  }));
  useLayoutEffect(() => {
    if (!documentAuthority) return;
    documentAuthorityRef.current = documentAuthority;

    return () => {
      if (documentAuthorityRef.current === documentAuthority) {
        documentAuthorityRef.current = null;
      }
      if (refreshPublicationRef.current?.document === documentAuthority) {
        refreshPublicationRef.current = null;
      }
      if (dismissedUpdateRef.current?.document === documentAuthority) {
        dismissedUpdateRef.current = null;
      }
      if (
        failurePublicationRef.current?.authority.document === documentAuthority
      ) {
        failurePublicationRef.current = null;
        failureAttemptRef.current = null;
      }
    };
  }, [documentAuthority]);

  const dismissCurrentPublication = useCallback(
    (publication: RefreshPublication) => {
      if (
        documentAuthorityRef.current !== publication.document ||
        refreshPublicationRef.current !== publication ||
        publication.remoteHash.length === 0 ||
        publication.remoteHash === publication.document.initialHash
      ) {
        return;
      }
      dismissedUpdateRef.current = Object.freeze({
        document: publication.document,
        remoteHash: publication.remoteHash,
      });
      refreshPublicationRef.current = null;
      setRefreshPublication((current) =>
        current === publication ? null : current,
      );
    },
    [],
  );

  const retryCurrentFailure = useCallback(
    (attempt: FailureCheckAttempt) => {
      const polling = pollingOwnerRef.current;
      return Boolean(
        polling &&
          polling.authority === attempt.authority &&
          attempt.failure.authority === attempt.authority &&
          documentAuthorityRef.current === attempt.authority.document &&
          authorityRef.current === attempt.authority &&
          failurePublicationRef.current === attempt.failure &&
          failureAttemptRef.current === null &&
          !failureControlCells.invalidFailures.has(attempt.failure) &&
          attempt.authority.document.ownerDocument.visibilityState ===
            "visible" &&
          requestOwnerRef.current === null &&
          polling.retry(attempt),
      );
    },
    [failureControlCells],
  );

  useLayoutEffect(() => {
    if (!authority) return;
    authorityRef.current = authority;

    return () => {
      if (authorityRef.current === authority) authorityRef.current = null;

      const request = requestOwnerRef.current;
      if (request?.authority === authority) {
        requestOwnerRef.current = null;
        request.failureAttempt?.control.release();
        request.controller.abort();
      }
      const polling = pollingOwnerRef.current;
      if (polling?.authority === authority) polling.retire();
    };
  }, [authority]);

  useEffect(() => {
    if (!authority) return;
    const pollingDocument = authority.document.ownerDocument;
    const hasAuthority = () => authorityRef.current === authority;
    if (
      !hasAuthority() ||
      refreshPublication?.document === authority.document
    ) {
      return;
    }
    const resumesDismissedUpdate =
      dismissedUpdateRef.current?.document === authority.document;

    let timer: ReturnType<typeof setInterval> | null = null;
    let retired = false;
    let changed = false;
    const stopTimer = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const stopRequest = (restoreFailure: boolean) => {
      const request = requestOwnerRef.current;
      if (request?.authority !== authority) return;
      requestOwnerRef.current = null;
      const attempt = request.failureAttempt;
      if (attempt && failureAttemptRef.current === attempt) {
        failureAttemptRef.current = null;
        if (
          restoreFailure &&
          failurePublicationRef.current === attempt.failure &&
          !failureControlCells.invalidFailures.has(attempt.failure)
        ) {
          setFailureState((current) =>
            current?.publication === attempt.failure &&
            current.attempt === attempt
              ? Object.freeze({
                  publication: attempt.failure,
                  attempt: null,
                })
              : current,
          );
        }
      }
      attempt?.control.release();
      request.controller.abort();
    };
    const stop = (restoreFailure: boolean) => {
      stopTimer();
      stopRequest(restoreFailure);
    };

    const failureIsCurrent = (failure: FailurePublication) =>
      failure.authority === authority &&
      failurePublicationRef.current === failure &&
      !failureControlCells.invalidFailures.has(failure);

    const publishFailure = () => {
      if (
        retired ||
        changed ||
        !hasAuthority() ||
        pollingDocument.visibilityState !== "visible"
      ) {
        return;
      }
      const current = failurePublicationRef.current;
      const publication =
        current && failureIsCurrent(current)
          ? current
          : Object.freeze<FailurePublication>({
              identity: Symbol("reader-update-failure"),
              authority,
            });
      failurePublicationRef.current = publication;
      failureAttemptRef.current = null;
      setFailureState((state) =>
        state?.publication === publication && state.attempt === null
          ? state
          : Object.freeze({ publication, attempt: null }),
      );
    };

    const clearFailure = () => {
      const failure = failurePublicationRef.current;
      if (failure?.authority !== authority) return;
      failurePublicationRef.current = null;
      failureAttemptRef.current = null;
      setFailureState((current) =>
        current?.publication.authority === authority ? null : current,
      );
    };

    const requestCanSettle = (request: RequestOwner) => {
      if (
        retired ||
        changed ||
        !hasAuthority() ||
        requestOwnerRef.current !== request ||
        request.controller.signal.aborted ||
        pollingDocument.visibilityState !== "visible"
      ) {
        return false;
      }
      const attempt = request.failureAttempt;
      return (
        attempt === null ||
        (failureAttemptRef.current === attempt &&
          failureIsCurrent(attempt.failure) &&
          failureControlSettlementIsCurrent(failureControlCells, attempt))
      );
    };

    const releaseAcceptedRequest = (request: RequestOwner) => {
      requestOwnerRef.current = null;
      if (failureAttemptRef.current === request.failureAttempt) {
        failureAttemptRef.current = null;
      }
      request.failureAttempt?.control.release();
    };

    const settleFailure = (request: RequestOwner) => {
      if (!requestCanSettle(request)) return;
      releaseAcceptedRequest(request);
      publishFailure();
    };

    const settleHash = (request: RequestOwner, remoteHash: string) => {
      if (!requestCanSettle(request)) return;
      releaseAcceptedRequest(request);
      clearFailure();
      if (remoteHash === authority.document.initialHash) {
        if (
          dismissedUpdateRef.current?.document === authority.document
        ) {
          dismissedUpdateRef.current = null;
        }
        return;
      }
      const dismissed = dismissedUpdateRef.current;
      if (
        dismissed?.document === authority.document &&
        dismissed.remoteHash === remoteHash
      ) {
        return;
      }
      changed = true;
      stopTimer();
      const publication = Object.freeze<RefreshPublication>({
        document: authority.document,
        remoteHash,
      });
      refreshPublicationRef.current = publication;
      setRefreshPublication(publication);
    };

    const performRequest = async (request: RequestOwner) => {
      try {
        const res = await fetch(
          `/api/documents/${authority.document.docId}/content`,
          {
            cache: "no-store",
            signal: request.controller.signal,
          },
        );
        await request.failureAttempt?.control.ready;
        if (!requestCanSettle(request)) return;
        if (!res.ok) {
          settleFailure(request);
          return;
        }
        const data = (await res.json()) as { contentHash?: unknown };
        if (!requestCanSettle(request)) return;
        const remoteHash = data.contentHash;
        if (typeof remoteHash !== "string" || remoteHash.length === 0) {
          settleFailure(request);
          return;
        }
        settleHash(request, remoteHash);
      } catch {
        await request.failureAttempt?.control.ready;
        settleFailure(request);
      } finally {
        if (requestOwnerRef.current === request) {
          requestOwnerRef.current = null;
          if (failureAttemptRef.current === request.failureAttempt) {
            failureAttemptRef.current = null;
          }
        }
        request.failureAttempt?.control.release();
      }
    };

    const check = (retryAttempt: FailureCheckAttempt | null = null) => {
      if (
        retired ||
        changed ||
        !hasAuthority() ||
        requestOwnerRef.current !== null ||
        pollingDocument.visibilityState !== "visible"
      ) {
        return false;
      }
      const currentFailure = failurePublicationRef.current;
      if (
        retryAttempt &&
        (retryAttempt.source !== "retry" ||
          retryAttempt.authority !== authority ||
          retryAttempt.failure !== currentFailure ||
          !failureIsCurrent(retryAttempt.failure) ||
          failureAttemptRef.current !== null)
      ) {
        return false;
      }
      const failureAttempt =
        retryAttempt ??
        (currentFailure && failureIsCurrent(currentFailure)
          ? createFailureCheckAttempt(authority, currentFailure, "poll")
          : null);
      const request: RequestOwner = {
        authority,
        controller: new AbortController(),
        failureAttempt,
      };
      requestOwnerRef.current = request;
      if (failureAttempt) {
        failureAttemptRef.current = failureAttempt;
        setFailureState((current) =>
          current?.publication === failureAttempt.failure
            ? Object.freeze({
                publication: failureAttempt.failure,
                attempt: failureAttempt,
              })
            : current,
        );
      }
      void performRequest(request);
      return true;
    };
    const start = (checkImmediately = true) => {
      if (
        retired ||
        changed ||
        !hasAuthority() ||
        pollingDocument.visibilityState !== "visible"
      ) {
        return;
      }
      if (checkImmediately) void check();
      if (timer !== null) return;
      timer = setInterval(() => void check(), authority.pollMs);
    };
    const onVisibility = () => {
      if (pollingDocument.visibilityState === "visible") {
        start();
      } else {
        stop(true);
      }
    };
    const retire = () => {
      if (retired) return;
      retired = true;
      stop(false);
      pollingDocument.removeEventListener("visibilitychange", onVisibility);
      if (pollingOwnerRef.current === polling) {
        pollingOwnerRef.current = null;
      }
    };
    const polling: PollingOwner = {
      authority,
      retry: (attempt) => check(attempt),
      retire,
    };

    pollingOwnerRef.current = polling;
    start(!resumesDismissedUpdate);
    pollingDocument.addEventListener("visibilitychange", onVisibility);
    return retire;
  }, [authority, failureControlCells, refreshPublication]);

  const currentPublication =
    documentAuthority &&
    refreshPublication?.document === documentAuthority &&
    refreshPublication.remoteHash.length > 0 &&
    refreshPublication.remoteHash !== documentAuthority.initialHash &&
    !controlCells.invalidRefreshes.has(refreshPublication) &&
    !controlCells.claimedRefreshes.has(refreshPublication)
      ? refreshPublication
      : null;
  const currentFailure =
    documentAuthority &&
    authority &&
    failureState?.publication.authority === authority &&
    !failureControlCells.invalidFailures.has(failureState.publication)
      ? failureState
      : null;

  useLayoutEffect(() => {
    if (currentPublication) return;
    retireInactiveControl(controlCells);
  }, [controlCells, currentPublication]);

  useLayoutEffect(() => {
    if (currentFailure) return;
    retireInactiveFailureControl(failureControlCells);
  }, [currentFailure, failureControlCells]);

  if (!ownerDocument || !documentAuthority || !authority) {
    return null;
  }
  if (currentPublication) {
    return (
      <RefreshControl
        mount={mount}
        ownerDocument={ownerDocument}
        docId={docId}
        initialHash={initialHash}
        pollMs={pollMs}
        documentAuthority={documentAuthority}
        pollingAuthority={authority}
        refreshPublication={currentPublication}
        cells={controlCells}
        documentAuthorityRef={documentAuthorityRef}
        pollingAuthorityRef={authorityRef}
        refreshPublicationRef={refreshPublicationRef}
        dismissCurrentPublication={dismissCurrentPublication}
      />
    );
  }
  if (currentFailure) {
    return (
      <FailureControl
        mount={mount}
        ownerDocument={ownerDocument}
        docId={docId}
        initialHash={initialHash}
        pollMs={pollMs}
        documentAuthority={documentAuthority}
        pollingAuthority={authority}
        failurePublication={currentFailure.publication}
        failureAttempt={currentFailure.attempt}
        cells={failureControlCells}
        documentAuthorityRef={documentAuthorityRef}
        pollingAuthorityRef={authorityRef}
        failurePublicationRef={failurePublicationRef}
        failureAttemptRef={failureAttemptRef}
        retryCurrentFailure={retryCurrentFailure}
      />
    );
  }
  return null;
}
