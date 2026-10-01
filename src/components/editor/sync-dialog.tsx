"use client";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AlertTriangle, Check, CloudDownload, GitMerge, Loader2, Scale, UploadCloud } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import { apiErrorText, type SyncStatusDto } from "@/lib/api";
import { formatDateTime, relativeTime } from "@/lib/utils";

type SyncActionKind = "merge" | "keep" | "take";
type SyncControlKind = SyncActionKind | "compare";
type SyncRefKind = SyncControlKind | "bridge" | "root" | "input";
interface SyncPresentation {
  mount: symbol;
  revision: number;
  replay: ReplayRequest | null;
  open: boolean;
  doc: DocumentDto;
  docId: string;
  storage: DocumentDto["storage"];
  repoPath: string | null;
  gistFile: string | null;
  repoOwner: string | null;
  repoName: string | null;
  repoBranch: string | null;
  publishedAt: string | null;
  sync: SyncStatusDto | null;
  syncLines: SyncStatusDto["lines"] | null;
  syncRemote: SyncStatusDto["remote"] | null;
  status: SyncStatusDto["status"];
  localChanged: boolean;
  remoteChanged: boolean;
  localLines: number;
  remoteLines: number;
  remoteUpdatedAt: string | null;
  remoteSha: string | null;
  remoteSize: number | null;
  remoteLimit: number | null;
  remoteUnreadable: boolean;
  actions: SyncActions;
  merge: SyncActions["merge"];
  keepMine: SyncActions["keepMine"];
  takeRemote: SyncActions["takeRemote"];
  compare: SyncActions["compare"];
  onOpenChange: (open: boolean) => void;
}
interface PublicationGeneration {
  presentation: SyncPresentation;
  message: string;
  busy: SyncActionKind | null;
  error: string | null;
  done: string | null;
  publications: PublicationSet | null;
}
interface ActionControlPublication {
  generation: PublicationGeneration;
  kind: SyncActionKind;
  invoke: () => Promise<string>;
}
interface CompareControlPublication {
  generation: PublicationGeneration;
  kind: "compare";
  invoke: SyncActions["compare"];
}
type ControlPublication = ActionControlPublication | CompareControlPublication;
type InputPublication = { generation: PublicationGeneration };
type DialogEventPublication = { generation: PublicationGeneration };
type RootPublication = { generation: PublicationGeneration };
type SyncPublication = ControlPublication | InputPublication | DialogEventPublication | RootPublication;
interface PublicationSet {
  dialogEvent: DialogEventPublication;
  root: RootPublication;
  input: InputPublication;
  controls: ReadonlyMap<SyncControlKind, ControlPublication>;
}
interface GenerationElements {
  elements: Map<SyncRefKind, HTMLElement>;
}
interface SyncDomTree {
  node: Node;
  nodeValue: string | null;
  attributes: readonly (readonly [string, string])[] | null;
  children: readonly SyncDomTree[];
}
interface CommittedPublication {
  generation: PublicationGeneration;
  bridge: HTMLDivElement;
  dialog: HTMLDivElement;
  root: HTMLDivElement;
  input: HTMLInputElement;
  close: HTMLButtonElement;
  controls: ReadonlyMap<SyncControlKind, HTMLButtonElement>;
  bridgeTree: SyncDomTree;
  rootTree: SyncDomTree;
  closeTree: SyncDomTree;
  navigation: SyncNavigationPublication | null;
}
interface ReplayRequest {
  predecessor: SyncPresentation;
  commit: CommittedPublication;
  revision: number;
  consumed: boolean;
}
type ActionOwner = {
  presentation: SyncPresentation;
  publication: ActionControlPublication;
  retired: boolean;
};
type SuccessClose = {
  owner: ActionOwner;
  timer: ReturnType<typeof setTimeout>;
  retired: boolean;
};
type SyncNavigationKey =
  | "ArrowDown"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowLeft"
  | "Home"
  | "End";
type SyncNavigationControl = Readonly<{
  kind: SyncControlKind;
  publication: ControlPublication;
  element: HTMLButtonElement;
}>;
type SyncNavigationPlacement = Readonly<{
  node: Node;
  parent: Node;
  previousSibling: Node | null;
  nextSibling: Node | null;
}>;
interface SyncNavigationHistory {
  readonly isClean: () => boolean;
  readonly release: () => void;
}
interface SyncTrustedAuthority {
  readonly read: (event: object) => boolean;
  readonly matches: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}
interface SyncKeyboardAuthority {
  readonly ownerWindow: Window & typeof globalThis;
  readonly ownerDocument: Document;
  readonly listenerTarget: EventTarget;
  readonly keyboardPrototype: object;
  readonly capturingPhase: number;
  readonly bubblingPhase: number;
  readonly apply: typeof Reflect.apply;
  readonly getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor;
  readonly getPrototypeOf: typeof Object.getPrototypeOf;
  readonly trusted: SyncTrustedAuthority;
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
interface SyncKeyboardSnapshot {
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
type SyncWindowProof = Readonly<{
  publication: SyncNavigationPublication;
  nativeEvent: KeyboardEvent;
  receiver: EventTarget;
  currentTarget: EventTarget;
  terminal: EventTarget;
  snapshot: SyncKeyboardSnapshot;
}>;
interface SyncKeyListener {
  readonly activate: (publication: SyncNavigationPublication) => boolean;
  readonly proofFor: (
    event: KeyboardEvent,
    publication: SyncNavigationPublication,
  ) => SyncWindowProof | null;
  readonly claim: (
    proof: SyncWindowProof,
    publication: SyncNavigationPublication,
  ) => boolean;
  readonly retains: (
    proof: SyncWindowProof,
    publication: SyncNavigationPublication,
  ) => boolean;
  readonly release: (publication: SyncNavigationPublication) => void;
}
interface SyncNavigationPublication {
  readonly generation: PublicationGeneration;
  readonly root: HTMLDivElement;
  readonly controls: readonly SyncNavigationControl[];
  readonly authority: SyncKeyboardAuthority;
  readonly keyListener: SyncKeyListener;
  readonly historyIsClean: () => boolean;
  readonly activate: () => boolean;
  readonly retire: () => void;
  readonly isRetired: () => boolean;
}
type SyncReactCancellation = Readonly<{
  isDefaultPrevented: () => boolean;
  isPropagationStopped: () => boolean;
}>;
type SyncReactKey = Readonly<{
  event: ReactKeyboardEvent<HTMLButtonElement>;
  control: SyncNavigationControl;
  nativeEvent: KeyboardEvent;
  listenerProof: SyncWindowProof;
  snapshot: SyncKeyboardSnapshot;
  cancellation: SyncReactCancellation;
}>;
type SyncMovementClaim = {
  claimed: boolean;
  sourceClaimed: boolean;
  destinationClaimed: boolean;
};
type SyncMovement = Readonly<{
  publication: SyncNavigationPublication;
  source: HTMLButtonElement;
  destination: HTMLButtonElement;
  key: SyncNavigationKey;
  claim: SyncMovementClaim;
}>;

const SYNC_PREVENT_SCROLL = Object.freeze({ preventScroll: true });

function syncPlacement(node: Node): SyncNavigationPlacement | null {
  const parent = node.parentNode;
  if (!parent) return null;
  return Object.freeze({
    node,
    parent,
    previousSibling: node.previousSibling,
    nextSibling: node.nextSibling,
  });
}

function syncPlacementMatches(placement: SyncNavigationPlacement) {
  return placement.node.parentNode === placement.parent &&
    placement.node.previousSibling === placement.previousSibling &&
    placement.node.nextSibling === placement.nextSibling;
}

function createSyncNavigationHistory(
  ownerDocument: Document,
  root: HTMLDivElement,
): SyncNavigationHistory | null {
  const MutationObserverConstructor =
    ownerDocument.defaultView?.MutationObserver;
  const placement = syncPlacement(root);
  if (!MutationObserverConstructor || !placement) return null;
  let changed = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.length > 0;
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(root, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(placement.parent, { childList: true });
  return Object.freeze({
    isClean: () => {
      recordChanges(observer.takeRecords());
      return !changed && syncPlacementMatches(placement);
    },
    release: () => {
      recordChanges(observer.takeRecords());
      observer.disconnect();
    },
  });
}

function syncGetter<This extends object, Value>(
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

function syncDescriptorsMatch(
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

function captureSyncTrustedAuthority(
  ownerWindow: Window & typeof globalThis,
): SyncTrustedAuthority | null {
  let probe: KeyboardEvent;
  try {
    probe = new ownerWindow.KeyboardEvent("sync-navigation-intrinsic");
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
    syncDescriptorsMatch(
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

function captureSyncKeyboardAuthority(
  ownerDocument: Document,
): SyncKeyboardAuthority | null {
  const ownerWindow = ownerDocument.defaultView as
    | (Window & typeof globalThis)
    | null;
  if (!ownerWindow) return null;
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
  const trusted = captureSyncTrustedAuthority(ownerWindow);
  const type = syncGetter<Event, string>(
    ownerWindow,
    eventPrototype,
    "type",
  );
  const target = syncGetter<Event, EventTarget | null>(
    ownerWindow,
    eventPrototype,
    "target",
  );
  const currentTarget = syncGetter<Event, EventTarget | null>(
    ownerWindow,
    eventPrototype,
    "currentTarget",
  );
  const eventPhase = syncGetter<Event, number>(
    ownerWindow,
    eventPrototype,
    "eventPhase",
  );
  const bubbles = syncGetter<Event, boolean>(
    ownerWindow,
    eventPrototype,
    "bubbles",
  );
  const cancelable = syncGetter<Event, boolean>(
    ownerWindow,
    eventPrototype,
    "cancelable",
  );
  const defaultPrevented = syncGetter<Event, boolean>(
    ownerWindow,
    eventPrototype,
    "defaultPrevented",
  );
  const cancelBubble = syncGetter<Event, boolean>(
    ownerWindow,
    eventPrototype,
    "cancelBubble",
  );
  const key = syncGetter<KeyboardEvent, string>(
    ownerWindow,
    keyboardPrototype,
    "key",
  );
  const code = syncGetter<KeyboardEvent, string>(
    ownerWindow,
    keyboardPrototype,
    "code",
  );
  const location = syncGetter<KeyboardEvent, number>(
    ownerWindow,
    keyboardPrototype,
    "location",
  );
  const altKey = syncGetter<KeyboardEvent, boolean>(
    ownerWindow,
    keyboardPrototype,
    "altKey",
  );
  const ctrlKey = syncGetter<KeyboardEvent, boolean>(
    ownerWindow,
    keyboardPrototype,
    "ctrlKey",
  );
  const metaKey = syncGetter<KeyboardEvent, boolean>(
    ownerWindow,
    keyboardPrototype,
    "metaKey",
  );
  const shiftKey = syncGetter<KeyboardEvent, boolean>(
    ownerWindow,
    keyboardPrototype,
    "shiftKey",
  );
  const repeat = syncGetter<KeyboardEvent, boolean>(
    ownerWindow,
    keyboardPrototype,
    "repeat",
  );
  const isComposing = syncGetter<KeyboardEvent, boolean>(
    ownerWindow,
    keyboardPrototype,
    "isComposing",
  );
  const view = syncGetter<UIEvent, Window | null>(
    ownerWindow,
    uiEventPrototype,
    "view",
  );
  const activeElement = syncGetter<Document, Element | null>(
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
  const authority: SyncKeyboardAuthority = {
    ownerWindow,
    ownerDocument,
    listenerTarget: ownerWindow,
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
      ownerWindow.document === ownerDocument &&
      ownerDocument.defaultView === ownerWindow &&
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
            return "value" in descriptor && descriptor.value === value;
          }
          owner = getPrototypeOf(owner);
        }
        return false;
      } catch {
        return false;
      }
    },
  };
  return Object.freeze(authority);
}

function readSyncKeyboardEvent(
  event: Event,
  authority: SyncKeyboardAuthority,
): SyncKeyboardSnapshot | null {
  try {
    if (
      authority.getPrototypeOf(event) !== authority.keyboardPrototype ||
      !authority.isCurrent() ||
      !authority.trusted.matches(event)
    ) {
      return null;
    }
    return Object.freeze({
      type: authority.apply(authority.event.type, event, []),
      target: authority.apply(authority.event.target, event, []),
      currentTarget: authority.apply(
        authority.event.currentTarget,
        event,
        [],
      ),
      eventPhase: authority.apply(
        authority.event.eventPhase,
        event,
        [],
      ),
      bubbles: authority.apply(authority.event.bubbles, event, []),
      cancelable: authority.apply(
        authority.event.cancelable,
        event,
        [],
      ),
      defaultPrevented: authority.apply(
        authority.event.defaultPrevented,
        event,
        [],
      ),
      cancelBubble: authority.apply(
        authority.event.cancelBubble,
        event,
        [],
      ),
      path: Object.freeze(
        authority.apply(authority.event.composedPath, event, []),
      ),
      key: authority.apply(authority.keyboard.key, event, []),
      code: authority.apply(authority.keyboard.code, event, []),
      location: authority.apply(
        authority.keyboard.location,
        event,
        [],
      ),
      altKey: authority.apply(authority.keyboard.altKey, event, []),
      ctrlKey: authority.apply(
        authority.keyboard.ctrlKey,
        event,
        [],
      ),
      metaKey: authority.apply(
        authority.keyboard.metaKey,
        event,
        [],
      ),
      shiftKey: authority.apply(
        authority.keyboard.shiftKey,
        event,
        [],
      ),
      repeat: authority.apply(authority.keyboard.repeat, event, []),
      isComposing: authority.apply(
        authority.keyboard.isComposing,
        event,
        [],
      ),
      isTrusted: authority.trusted.read(event),
      view: authority.apply(authority.view, event, []),
    });
  } catch {
    return null;
  }
}

function syncKeyboardStableFactsMatch(
  left: SyncKeyboardSnapshot,
  right: SyncKeyboardSnapshot,
) {
  return left.type === right.type &&
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
    left.path.every((entry, index) => entry === right.path[index]);
}

function syncKeyboardFactsMatch(
  left: SyncKeyboardSnapshot,
  right: SyncKeyboardSnapshot,
) {
  return syncKeyboardStableFactsMatch(left, right) &&
    left.currentTarget === right.currentTarget &&
    left.eventPhase === right.eventPhase;
}

function syncKeyboardPathMatches(
  path: readonly EventTarget[],
  source: HTMLButtonElement,
  ownerDocument: Document,
  terminal: EventTarget,
) {
  const expected: EventTarget[] = [];
  let current: Node | null = source;
  while (current) {
    expected.push(current);
    if (current === ownerDocument) break;
    current = current.parentNode;
  }
  return expected.at(-1) === ownerDocument &&
    path.length === expected.length + 1 &&
    expected.every((entry, index) => path[index] === entry) &&
    path.at(-1) === terminal;
}

function readSyncReactCancellation(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  authority: SyncKeyboardAuthority,
): SyncReactCancellation | null {
  try {
    const isDefaultPrevented = event.isDefaultPrevented;
    const isPropagationStopped = event.isPropagationStopped;
    if (
      !authority.isCurrent() ||
      !authority.methodMatches(
        event,
        "isDefaultPrevented",
        isDefaultPrevented,
      ) ||
      !authority.methodMatches(
        event,
        "isPropagationStopped",
        isPropagationStopped,
      ) ||
      authority.apply(isDefaultPrevented, event, []) !== false ||
      authority.apply(isPropagationStopped, event, []) !== false
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

function syncReactCancellationMatches(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  expected: SyncReactCancellation,
  authority: SyncKeyboardAuthority,
) {
  const current = readSyncReactCancellation(event, authority);
  return Boolean(
    current &&
      current.isDefaultPrevented === expected.isDefaultPrevented &&
      current.isPropagationStopped === expected.isPropagationStopped
  );
}

function readSyncReactKey(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  control: SyncNavigationControl,
  publication: SyncNavigationPublication,
  expectedPhase: number,
): SyncReactKey | null {
  try {
    if (!event || typeof event !== "object") return null;
    const authority = publication.authority;
    const nativeEvent = event.nativeEvent;
    const listenerProof = publication.keyListener.proofFor(
      nativeEvent,
      publication,
    );
    const snapshot = listenerProof
      ? readSyncKeyboardEvent(nativeEvent, authority)
      : null;
    const cancellation = snapshot
      ? readSyncReactCancellation(event, authority)
      : null;
    if (
      !listenerProof ||
      !snapshot ||
      !cancellation ||
      !authority.isCurrent() ||
      event === (nativeEvent as unknown) ||
      event.type !== "keydown" ||
      event.type !== snapshot.type ||
      event.nativeEvent !== nativeEvent ||
      event.currentTarget !== control.element ||
      event.target !== control.element ||
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
      snapshot.target !== control.element ||
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
        snapshot.view !== authority.ownerWindow) ||
      !snapshot.path.includes(snapshot.currentTarget) ||
      snapshot.path.filter(
        (entry) => entry === snapshot.currentTarget,
      ).length !== 1 ||
      !syncKeyboardPathMatches(
        snapshot.path,
        control.element,
        authority.ownerDocument,
        listenerProof.receiver,
      ) ||
      !syncReactCancellationMatches(
        event,
        cancellation,
        authority,
      )
    ) {
      return null;
    }
    return Object.freeze({
      event,
      control,
      nativeEvent,
      listenerProof,
      snapshot,
      cancellation,
    });
  } catch {
    return null;
  }
}

function syncReactKeyPairMatches(
  capture: SyncReactKey,
  bubble: SyncReactKey,
  publication: SyncNavigationPublication,
) {
  const authority = publication.authority;
  return capture.event !== bubble.event &&
    capture.control === bubble.control &&
    capture.nativeEvent === bubble.nativeEvent &&
    capture.listenerProof === bubble.listenerProof &&
    capture.listenerProof.publication === publication &&
    capture.listenerProof.nativeEvent === capture.nativeEvent &&
    capture.listenerProof.receiver ===
      capture.listenerProof.currentTarget &&
    capture.listenerProof.receiver === capture.listenerProof.terminal &&
    capture.snapshot.eventPhase === authority.capturingPhase &&
    bubble.snapshot.eventPhase === authority.bubblingPhase &&
    syncKeyboardStableFactsMatch(capture.snapshot, bubble.snapshot) &&
    syncKeyboardPathMatches(
      capture.snapshot.path,
      capture.control.element,
      authority.ownerDocument,
      capture.listenerProof.receiver,
    ) &&
    syncKeyboardPathMatches(
      bubble.snapshot.path,
      bubble.control.element,
      authority.ownerDocument,
      bubble.listenerProof.receiver,
    );
}

function createSyncKeyListener(
  authority: SyncKeyboardAuthority,
): SyncKeyListener {
  const proofs = new WeakMap<KeyboardEvent, SyncWindowProof>();
  const invalidEvents = new WeakSet<Event>();
  const claimedProofs = new WeakSet<object>();
  let publication: SyncNavigationPublication | null = null;
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
      authority.getPrototypeOf(event) !==
        authority.keyboardPrototype ||
      !authority.isCurrent()
    ) {
      return;
    }
    const nativeEvent = event as KeyboardEvent;
    if (proofs.has(nativeEvent)) {
      invalidEvents.add(nativeEvent);
      return;
    }
    const snapshot = readSyncKeyboardEvent(nativeEvent, authority);
    const source = snapshot
      ? current.controls.find(
          ({ element }) => element === snapshot.target,
        )
      : undefined;
    const terminal = snapshot?.path.at(-1);
    if (
      !snapshot ||
      !source ||
      !terminal ||
      snapshot.currentTarget !== this ||
      terminal !== this ||
      snapshot.eventPhase !== authority.capturingPhase ||
      !syncKeyboardPathMatches(
        snapshot.path,
        source.element,
        authority.ownerDocument,
        this,
      )
    ) {
      return;
    }
    proofs.set(nativeEvent, Object.freeze({
      publication: current,
      nativeEvent,
      receiver: this,
      currentTarget: this,
      terminal,
      snapshot,
    }));
  };

  const proofFor = (
    event: KeyboardEvent,
    current: SyncNavigationPublication,
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
      !authority.isCurrent()
    ) {
      return null;
    }
    const snapshot = readSyncKeyboardEvent(event, authority);
    const source = snapshot
      ? current.controls.find(
          ({ element }) => element === snapshot.target,
        )
      : undefined;
    return snapshot &&
      source &&
      syncKeyboardStableFactsMatch(proof.snapshot, snapshot) &&
      syncKeyboardPathMatches(
        snapshot.path,
        source.element,
        authority.ownerDocument,
        proof.receiver,
      )
      ? proof
      : null;
  };

  const registration: SyncKeyListener = Object.freeze({
    activate: (current: SyncNavigationPublication) => {
      if (
        publication ||
        active ||
        released ||
        current.keyListener !== registration ||
        current.authority !== authority ||
        current.generation.presentation.open !== true ||
        !authority.isCurrent()
      ) {
        return false;
      }
      publication = current;
      active = true;
      try {
        authority.apply(
          authority.addEventListener,
          authority.listenerTarget,
          ["keydown", listener, true],
        );
      } catch {
        active = false;
        publication = null;
        return false;
      }
      if (authority.isCurrent()) return true;
      active = false;
      publication = null;
      try {
        authority.apply(
          authority.removeEventListener,
          authority.listenerTarget,
          ["keydown", listener, true],
        );
      } catch {
        // The captured removal method is the only authority for this listener.
      }
      return false;
    },
    proofFor,
    claim: (
      proof: SyncWindowProof,
      current: SyncNavigationPublication,
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
      proof: SyncWindowProof,
      current: SyncNavigationPublication,
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
      authority.isCurrent(),
    release: (current: SyncNavigationPublication) => {
      if (publication !== current || released) return;
      released = true;
      const wasActive = active;
      active = false;
      if (!wasActive) return;
      try {
        authority.apply(
          authority.removeEventListener,
          authority.listenerTarget,
          ["keydown", listener, true],
        );
      } catch {
        // Cleanup cannot substitute a different listener target or method.
      }
    },
  });
  return registration;
}

function createSyncNavigationPublication(
  generation: PublicationGeneration,
  root: HTMLDivElement,
  controls: readonly SyncNavigationControl[],
): SyncNavigationPublication | null {
  const ownerDocument = root.ownerDocument;
  const authority = captureSyncKeyboardAuthority(ownerDocument);
  const history = createSyncNavigationHistory(ownerDocument, root);
  if (!authority || !history) {
    history?.release();
    return null;
  }
  let retired = false;
  const keyListener = createSyncKeyListener(authority);
  const publication: SyncNavigationPublication = Object.freeze({
    generation,
    root,
    controls: Object.freeze([...controls]),
    authority,
    keyListener,
    historyIsClean: history.isClean,
    activate: () => !retired && keyListener.activate(publication),
    retire: () => {
      if (retired) return;
      retired = true;
      keyListener.release(publication);
      history.release();
    },
    isRetired: () => retired,
  });
  return publication;
}

function syncNavigationKey(value: string): SyncNavigationKey | null {
  return value === "ArrowDown" ||
    value === "ArrowRight" ||
    value === "ArrowUp" ||
    value === "ArrowLeft" ||
    value === "Home" ||
    value === "End"
    ? value
    : null;
}

function syncNavigationDestination(
  key: SyncNavigationKey,
  sourceIndex: number,
  controlCount: number,
) {
  if (sourceIndex < 0 || sourceIndex >= controlCount) return -1;
  if (key === "ArrowDown" || key === "ArrowRight") {
    return Math.min(sourceIndex + 1, controlCount - 1);
  }
  if (key === "ArrowUp" || key === "ArrowLeft") {
    return Math.max(sourceIndex - 1, 0);
  }
  return key === "Home" ? 0 : controlCount - 1;
}

function syncControlIsEnabled(button: HTMLButtonElement) {
  if (
    button.disabled ||
    button.matches(":disabled") ||
    button.getAttribute("aria-disabled")?.toLowerCase() === "true"
  ) {
    return false;
  }
  for (
    let element: HTMLElement | null = button;
    element;
    element = element.parentElement
  ) {
    if (
      element.hidden ||
      element.hasAttribute("inert") ||
      element.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
      element.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function snapshotAttributes(node: Node) {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotDom(node: Node): SyncDomTree {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotDom)),
  });
}

function domMatches(snapshot: SyncDomTree): boolean {
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
  return node.childNodes.length === snapshot.children.length &&
    snapshot.children.every((child, index) =>
      node.childNodes.item(index) === child.node && domMatches(child));
}

function samePresentationFacts(left: SyncPresentation, right: SyncPresentation) {
  return left.mount === right.mount &&
    left.open === right.open &&
    left.doc === right.doc &&
    left.docId === right.docId &&
    left.storage === right.storage &&
    left.repoPath === right.repoPath &&
    left.gistFile === right.gistFile &&
    left.repoOwner === right.repoOwner &&
    left.repoName === right.repoName &&
    left.repoBranch === right.repoBranch &&
    left.publishedAt === right.publishedAt &&
    left.sync === right.sync &&
    left.syncLines === right.syncLines &&
    left.syncRemote === right.syncRemote &&
    left.status === right.status &&
    left.localChanged === right.localChanged &&
    left.remoteChanged === right.remoteChanged &&
    left.localLines === right.localLines &&
    left.remoteLines === right.remoteLines &&
    left.remoteUpdatedAt === right.remoteUpdatedAt &&
    left.remoteSha === right.remoteSha &&
    left.remoteSize === right.remoteSize &&
    left.remoteLimit === right.remoteLimit &&
    left.remoteUnreadable === right.remoteUnreadable &&
    left.actions === right.actions &&
    left.merge === right.merge &&
    left.keepMine === right.keepMine &&
    left.takeRemote === right.takeRemote &&
    left.compare === right.compare &&
    left.onOpenChange === right.onOpenChange;
}

export interface SyncActions {
  /** pull?merge=1 — resolves to the number of conflicts left in the document (0 = clean merge). */
  merge: () => Promise<number>;
  keepMine: (message: string) => Promise<void>;
  takeRemote: () => Promise<void>;
  compare: () => void;
}

/**
 * Three-way summary for a document whose GitHub file and local text both moved. An oversized remote
 * file cannot be read, so only the force-publish path remains available.
 */
export const SyncDialog = memo(function SyncDialog({
  open,
  onOpenChange,
  doc,
  sync,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  sync: SyncStatusDto | null;
  actions: SyncActions;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"merge" | "keep" | "take" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [publicationRevision, setPublicationRevision] = useState(0);
  const [mount] = useState(() => Symbol("sync-dialog"));
  const activePresentationRef = useRef<SyncPresentation | null>(null);
  const activePublicationRef = useRef<CommittedPublication | null>(null);
  const lastPublicationRef = useRef(new WeakMap<SyncPresentation, CommittedPublication>());
  const retiredPresentationRef = useRef(new WeakSet<SyncPresentation>());
  const retiredPublicationRef = useRef(new WeakSet<SyncPublication>());
  const retiredGenerationRef = useRef(new WeakSet<PublicationGeneration>());
  const generationElementsRef = useRef(new WeakMap<PublicationGeneration, GenerationElements>());
  const detachedElementsRef = useRef(new WeakMap<SyncPresentation, Set<HTMLElement>>());
  const reattachedElementsRef = useRef(new WeakMap<SyncPresentation, Set<HTMLElement>>());
  const latestGenerationRef = useRef<PublicationGeneration | null>(null);
  const replaySetupRef = useRef<{ presentation: SyncPresentation; active: boolean } | null>(null);
  const replayRequestRef = useRef<ReplayRequest | null>(null);
  const revisionRef = useRef(publicationRevision);
  const latestPresentationRef = useRef<SyncPresentation | null>(null);
  const inFlightRef = useRef<ActionOwner | null>(null);
  const successCloseRef = useRef<SuccessClose | null>(null);
  const capturedNavigationRef = useRef(
    new WeakMap<
      SyncNavigationPublication,
      WeakMap<KeyboardEvent, SyncReactKey>
    >(),
  );
  const claimedReactKeyEventsRef = useRef(new WeakSet<object>());
  const claimedNativeKeyEventsRef = useRef(new WeakSet<Event>());
  const claimedMovementsRef = useRef(new WeakSet<SyncMovement>());
  const claimedMovementClaimsRef = useRef(
    new WeakSet<SyncMovementClaim>(),
  );
  const activeMovementRef = useRef<SyncMovement | null>(null);
  const claimedSourcesRef = useRef(
    new WeakMap<HTMLButtonElement, SyncMovement>(),
  );
  const claimedDestinationsRef = useRef(
    new WeakMap<HTMLButtonElement, SyncMovement>(),
  );
  revisionRef.current = publicationRevision;
  const docId = doc.id;
  const storage = doc.storage;
  const repoPath = doc.repoPath;
  const gistFile = doc.gistFile;
  const repoOwner = doc.repoOwner;
  const repoName = doc.repoName;
  const repoBranch = doc.repoBranch;
  const publishedAt = doc.publishedAt;
  const syncLines = sync?.lines ?? null;
  const syncRemote = sync?.remote ?? null;
  const status = sync?.status ?? "diverged";
  const localChanged = sync?.localChanged ?? false;
  const remoteChanged = sync?.remoteChanged ?? false;
  const localLines = syncLines?.local ?? 0;
  const remoteLines = syncLines?.remote ?? 0;
  const remoteUpdatedAt = syncRemote?.updatedAt ?? null;
  const remoteSha = syncRemote?.sha ?? null;
  const remoteSize = sync?.size ?? null;
  const remoteLimit = sync?.limit ?? null;
  const remoteUnreadable = status === "remote-unreadable";
  const merge = actions.merge;
  const keepMine = actions.keepMine;
  const takeRemote = actions.takeRemote;
  const compare = actions.compare;
  const presentation = useMemo<SyncPresentation>(
    () => {
      const request = replayRequestRef.current;
      const replay =
        request?.revision === publicationRevision && !request.consumed
          ? request
          : null;
      return {
        mount,
        revision: publicationRevision,
        replay,
        open,
        doc,
        docId,
        storage,
        repoPath,
        gistFile,
        repoOwner,
        repoName,
        repoBranch,
        publishedAt,
        sync,
        syncLines,
        syncRemote,
        status,
        localChanged,
        remoteChanged,
        localLines,
        remoteLines,
        remoteUpdatedAt,
        remoteSha,
        remoteSize,
        remoteLimit,
        remoteUnreadable,
        actions,
        merge,
        keepMine,
        takeRemote,
        compare,
        onOpenChange,
      };
    },
    [
      actions,
      compare,
      doc,
      docId,
      gistFile,
      keepMine,
      localChanged,
      localLines,
      merge,
      mount,
      onOpenChange,
      open,
      publishedAt,
      publicationRevision,
      remoteChanged,
      remoteLimit,
      remoteLines,
      remoteSha,
      remoteSize,
      remoteUnreadable,
      remoteUpdatedAt,
      repoBranch,
      repoName,
      repoOwner,
      repoPath,
      status,
      storage,
      sync,
      syncLines,
      syncRemote,
      takeRemote,
    ],
  );
  latestPresentationRef.current = presentation;
  const initialMessageVisit = useMemo(
    () => (open ? { mount, docId, repoPath, gistFile, message: `Update ${repoPath ?? gistFile ?? "document"}` } : null),
    [docId, gistFile, mount, open, repoPath],
  );

  const expectedControlKinds = useCallback((candidate: SyncPresentation): readonly SyncControlKind[] =>
    candidate.remoteUnreadable
      ? ["keep"]
      : ["merge", "keep", "take", "compare"], []);
  const presentationFactsAreCurrent = useCallback(
    (candidate: SyncPresentation) => {
      const lines = candidate.sync?.lines ?? null;
      const remote = candidate.sync?.remote ?? null;
      return candidate.mount === mount &&
        candidate.open &&
        candidate.doc === doc &&
        candidate.doc.id === candidate.docId &&
        candidate.doc.storage === candidate.storage &&
        candidate.doc.repoPath === candidate.repoPath &&
        candidate.doc.gistFile === candidate.gistFile &&
        candidate.doc.repoOwner === candidate.repoOwner &&
        candidate.doc.repoName === candidate.repoName &&
        candidate.doc.repoBranch === candidate.repoBranch &&
        candidate.doc.publishedAt === candidate.publishedAt &&
        candidate.sync === sync &&
        lines === candidate.syncLines &&
        remote === candidate.syncRemote &&
        (candidate.sync?.status ?? "diverged") === candidate.status &&
        (candidate.sync?.localChanged ?? false) === candidate.localChanged &&
        (candidate.sync?.remoteChanged ?? false) === candidate.remoteChanged &&
        (lines?.local ?? 0) === candidate.localLines &&
        (lines?.remote ?? 0) === candidate.remoteLines &&
        (remote?.updatedAt ?? null) === candidate.remoteUpdatedAt &&
        (remote?.sha ?? null) === candidate.remoteSha &&
        (candidate.sync?.size ?? null) === candidate.remoteSize &&
        (candidate.sync?.limit ?? null) === candidate.remoteLimit &&
        (candidate.status === "remote-unreadable") === candidate.remoteUnreadable &&
        candidate.actions === actions &&
        candidate.actions.merge === candidate.merge &&
        candidate.actions.keepMine === candidate.keepMine &&
        candidate.actions.takeRemote === candidate.takeRemote &&
        candidate.actions.compare === candidate.compare &&
        candidate.onOpenChange === onOpenChange;
    },
    [actions, doc, mount, onOpenChange, sync],
  );
  const elementsFor = useCallback((generation: PublicationGeneration) => {
    let elements = generationElementsRef.current.get(generation);
    if (!elements) {
      elements = {
        elements: new Map<SyncRefKind, HTMLElement>(),
      };
      generationElementsRef.current.set(generation, elements);
    }
    return elements;
  }, []);
  const retireGeneration = useCallback((generation: PublicationGeneration) => {
    if (retiredGenerationRef.current.has(generation)) return;
    retiredGenerationRef.current.add(generation);
    const publications = generation.publications;
    if (publications) {
      retiredPublicationRef.current.add(publications.dialogEvent);
      retiredPublicationRef.current.add(publications.root);
      retiredPublicationRef.current.add(publications.input);
      for (const publication of publications.controls.values()) {
        retiredPublicationRef.current.add(publication);
      }
    }
    const activeCommit = activePublicationRef.current;
    if (activeCommit?.generation === generation) {
      activeCommit.navigation?.retire();
      activePublicationRef.current = null;
    }
    const lastCommit = lastPublicationRef.current.get(
      generation.presentation,
    );
    if (
      lastCommit?.generation === generation &&
      lastCommit !== activeCommit
    ) {
      lastCommit.navigation?.retire();
    }
  }, []);
  const snapshotDomMatches = useCallback(
    (commit: CommittedPublication, checkInputValue = true) => {
      const { generation } = commit;
      if (
        !commit.bridge.isConnected ||
        !commit.dialog.isConnected ||
        !commit.root.isConnected ||
        !commit.input.isConnected ||
        !commit.close.isConnected ||
        commit.root.closest('[role="dialog"]') !== commit.dialog ||
        !commit.dialog.contains(commit.root) ||
        !commit.dialog.contains(commit.input) ||
        !commit.dialog.contains(commit.close) ||
        commit.dialog.contains(commit.bridge) ||
        commit.dialog.getAttribute("role") !== "dialog" ||
        !commit.dialog.classList.contains("dialog") ||
        commit.dialog.querySelectorAll('button[aria-label="Close"]').length !== 1 ||
        commit.dialog.querySelector('button[aria-label="Close"]') !== commit.close ||
        !domMatches(commit.bridgeTree) ||
        !domMatches(commit.rootTree) ||
        !domMatches(commit.closeTree) ||
        (checkInputValue && commit.input.value !== generation.message)
      ) {
        return false;
      }
      return true;
    },
    [],
  );
  const publicationDomMatches = useCallback(
    (commit: CommittedPublication, checkInputValue = true) => {
      const { generation } = commit;
      const elements = generationElementsRef.current.get(generation);
      if (
        !elements ||
        elements.elements.get("bridge") !== commit.bridge ||
        elements.elements.get("root") !== commit.root ||
        elements.elements.get("input") !== commit.input ||
        !snapshotDomMatches(commit, checkInputValue)
      ) {
        return false;
      }
      for (const kind of expectedControlKinds(generation.presentation)) {
        if (elements.elements.get(kind) !== commit.controls.get(kind)) return false;
      }
      return true;
    },
    [expectedControlKinds, snapshotDomMatches],
  );
  const buildPublication = useCallback(
    (
      generation: PublicationGeneration,
      allowRetired = false,
    ): CommittedPublication | null => {
      if (
        (!allowRetired && retiredGenerationRef.current.has(generation)) ||
        (!allowRetired &&
          retiredPresentationRef.current.has(generation.presentation)) ||
        !presentationFactsAreCurrent(generation.presentation)
      ) {
        return null;
      }
      const observed = generationElementsRef.current.get(generation);
      if (!observed) return null;
      const bridge = observed.elements.get("bridge");
      const root = observed.elements.get("root");
      const input = observed.elements.get("input");
      const ownerWindow = bridge?.ownerDocument.defaultView;
      if (
        !ownerWindow ||
        !(bridge instanceof ownerWindow.HTMLDivElement) ||
        !(root instanceof ownerWindow.HTMLDivElement) ||
        !(input instanceof ownerWindow.HTMLInputElement) ||
        bridge.ownerDocument !== root.ownerDocument ||
        bridge.ownerDocument !== input.ownerDocument
      ) {
        return null;
      }
      const dialog = root.closest('[role="dialog"]');
      const close = dialog?.querySelector('button[aria-label="Close"]');
      if (
        !(dialog instanceof ownerWindow.HTMLDivElement) ||
        !(close instanceof ownerWindow.HTMLButtonElement) ||
        !bridge.isConnected ||
        bridge.className !== "contents" ||
        !root.isConnected ||
        root.parentElement === null ||
        !dialog.contains(root) ||
        !dialog.contains(input) ||
        dialog.contains(bridge) ||
        dialog.querySelectorAll('[data-testid="sync-dialog"]').length !== 1 ||
        dialog.querySelector('[data-testid="sync-dialog"]') !== root ||
        dialog.querySelectorAll('button[aria-label="Close"]').length !== 1 ||
        root.className !== "flex flex-col gap-4" ||
        root.dataset.status !== generation.presentation.status ||
        input.className !== "input" ||
        input.value !== generation.message ||
        input.getAttribute("data-testid") !== "commit-message" ||
        input.closest("label")?.parentElement !== root ||
        close.type !== "button" ||
        close.disabled
      ) {
        return null;
      }
      const expectedKinds = expectedControlKinds(generation.presentation);
      const expectedIds: Record<SyncControlKind, string> = {
        merge: "sync-merge",
        keep: "sync-keep-mine",
        take: "sync-take-remote",
        compare: "sync-compare",
      };
      const expectedClasses: Record<SyncControlKind, string> = {
        merge: "btn btn-primary justify-start gap-2",
        keep: "btn btn-outline justify-start gap-2",
        take: "btn btn-outline justify-start gap-2",
        compare: "btn btn-ghost justify-start gap-2",
      };
      const controls = new Map<SyncControlKind, HTMLButtonElement>();
      for (const kind of expectedKinds) {
        const element = observed.elements.get(kind);
        const testId = expectedIds[kind];
        const controlPublication =
          generation.publications?.controls.get(kind);
        const expectedDisabled = kind === "compare"
          ? generation.busy !== null
          : generation.busy !== null || generation.done !== null;
        if (
          !(element instanceof ownerWindow.HTMLButtonElement) ||
          !controlPublication ||
          controlPublication.generation !== generation ||
          controlPublication.kind !== kind ||
          !element.isConnected ||
          element.parentElement === null ||
          !root.contains(element) ||
          root.querySelectorAll(`[data-testid="${testId}"]`).length !== 1 ||
          root.querySelector(`[data-testid="${testId}"]`) !== element ||
          element.type !== "button" ||
          element.disabled !== expectedDisabled ||
          element.className !== expectedClasses[kind]
        ) {
          return null;
        }
        controls.set(kind, element);
      }
      const renderedControls = [...root.querySelectorAll<HTMLButtonElement>(
        'button[data-testid^="sync-"]',
      )];
      if (
        renderedControls.length !== expectedKinds.length ||
        renderedControls.some((element, index) =>
          element !== controls.get(expectedKinds[index]!))
      ) {
        return null;
      }
      const commit: CommittedPublication = {
        generation,
        bridge,
        dialog,
        root,
        input,
        close,
        controls,
        bridgeTree: snapshotDom(bridge),
        rootTree: snapshotDom(root),
        closeTree: snapshotDom(close),
        navigation: null,
      };
      if (!allowRetired) {
        const navigationControls = [...controls]
          .filter(([, element]) => !element.disabled)
          .map(([kind, element]) => Object.freeze({
            kind,
            element,
            publication:
              generation.publications!.controls.get(kind)!,
          }));
        commit.navigation = createSyncNavigationPublication(
          generation,
          root,
          navigationControls,
        );
      }
      return commit;
    },
    [expectedControlKinds, presentationFactsAreCurrent],
  );
  const sameCommittedElements = useCallback(
    (left: CommittedPublication, right: CommittedPublication) => {
      if (
        left.bridge !== right.bridge ||
        left.dialog !== right.dialog ||
        left.root !== right.root ||
        left.input !== right.input ||
        left.close !== right.close ||
        left.controls.size !== right.controls.size
      ) {
        return false;
      }
      for (const [kind, element] of left.controls) {
        if (right.controls.get(kind) !== element) return false;
      }
      return true;
    },
    [],
  );
  const sawCompleteRefReplay = useCallback(
    (commit: CommittedPublication) => {
      // The outer bridge can replay before Radix commits its portal. Require every
      // exact element in the final presentation to detach and reattach before succession.
      const candidate = commit.generation.presentation;
      const detached = detachedElementsRef.current.get(candidate);
      const reattached = reattachedElementsRef.current.get(candidate);
      if (!detached || !reattached) return false;
      const required: HTMLElement[] = [
        commit.bridge,
        commit.root,
        commit.input,
        ...expectedControlKinds(candidate).map((kind) => commit.controls.get(kind)!),
      ];
      return required.every((element) =>
        detached.has(element) && reattached.has(element));
    },
    [expectedControlKinds],
  );
  const retirePresentation = useCallback(
    (candidate: SyncPresentation) => {
      if (retiredPresentationRef.current.has(candidate)) return false;
      retiredPresentationRef.current.add(candidate);
      const wasActive = activePresentationRef.current === candidate;
      if (wasActive) activePresentationRef.current = null;
      const commit = lastPublicationRef.current.get(candidate);
      if (commit) retireGeneration(commit.generation);
      const inFlight = inFlightRef.current;
      if (inFlight?.presentation === candidate) {
        inFlight.retired = true;
        inFlightRef.current = null;
      }
      const scheduledClose = successCloseRef.current;
      if (scheduledClose?.owner.presentation === candidate) {
        scheduledClose.retired = true;
        scheduledClose.owner.retired = true;
        clearTimeout(scheduledClose.timer);
        successCloseRef.current = null;
      }
      return wasActive;
    },
    [retireGeneration],
  );
  const maybeRequestReplay = useCallback(
    (candidate: SyncPresentation) => {
      const setup = replaySetupRef.current;
      const commit = lastPublicationRef.current.get(candidate);
      if (
        !setup?.active ||
        setup.presentation !== candidate ||
        !commit ||
        (replayRequestRef.current && !replayRequestRef.current.consumed) ||
        activePresentationRef.current ||
        activePublicationRef.current ||
        !retiredPresentationRef.current.has(candidate) ||
        !retiredGenerationRef.current.has(commit.generation) ||
        !presentationFactsAreCurrent(candidate) ||
        !publicationDomMatches(commit) ||
        !sawCompleteRefReplay(commit)
      ) {
        return;
      }
      const request: ReplayRequest = {
        predecessor: candidate,
        commit,
        revision: revisionRef.current + 1,
        consumed: false,
      };
      replayRequestRef.current = request;
      setPublicationRevision(request.revision);
    },
    [presentationFactsAreCurrent, publicationDomMatches, sawCompleteRefReplay],
  );
  const admitReplay = useCallback(
    (
      candidate: SyncPresentation,
      generation: PublicationGeneration,
      commit: CommittedPublication,
    ) => {
      const replayRequest = candidate.replay;
      if (!replayRequest) return true;
      if (replayRequest.consumed) {
        return activePresentationRef.current === candidate;
      }
      const predecessorCommit = replayRequest.commit;
      if (
        replayRequestRef.current !== replayRequest ||
        replayRequest.revision !== candidate.revision ||
        replayRequest.predecessor === candidate ||
        !retiredPresentationRef.current.has(replayRequest.predecessor) ||
        !retiredGenerationRef.current.has(predecessorCommit.generation) ||
        !samePresentationFacts(candidate, replayRequest.predecessor) ||
        generation.message !== predecessorCommit.generation.message ||
        generation.busy !== predecessorCommit.generation.busy ||
        generation.error !== predecessorCommit.generation.error ||
        generation.done !== predecessorCommit.generation.done ||
        !snapshotDomMatches(predecessorCommit) ||
        !sawCompleteRefReplay(predecessorCommit) ||
        !sameCommittedElements(commit, predecessorCommit)
      ) {
        // A rejected replay request must still be marked consumed so it
        // isn't silently re-attached (via matching revision) to every
        // subsequent presentation object recreated on later renders. Leaving
        // it unconsumed here caused every freshly created presentation to be
        // retired immediately, which left the dialog permanently unable to
        // close (e.g. via Escape) once a replay was rejected.
        replayRequest.consumed = true;
        return false;
      }
      replayRequest.consumed = true;
      return true;
    },
    [sameCommittedElements, sawCompleteRefReplay, snapshotDomMatches],
  );
  const publishGeneration = useCallback(
    (generation: PublicationGeneration) => {
      if (
        activePresentationRef.current !== generation.presentation ||
        retiredPresentationRef.current.has(generation.presentation)
      ) {
        return null;
      }
      const commit = buildPublication(generation);
      if (!commit) return null;
      if (!admitReplay(generation.presentation, generation, commit)) {
        commit.navigation?.retire();
        retireGeneration(generation);
        retirePresentation(generation.presentation);
        return null;
      }
      activePublicationRef.current = commit;
      if (commit.navigation && !commit.navigation.activate()) {
        commit.navigation.retire();
        commit.navigation = null;
      }
      lastPublicationRef.current.set(generation.presentation, commit);
      return commit;
    },
    [admitReplay, buildPublication, retireGeneration, retirePresentation],
  );
  const activateGeneration = useCallback(
    (generation: PublicationGeneration) => {
      const candidate = generation.presentation;
      const previous = activePresentationRef.current;
      if (previous && previous !== candidate) retirePresentation(previous);
      activePresentationRef.current = candidate;
      const commit = buildPublication(generation);
      if (!commit) return true;
      if (!admitReplay(candidate, generation, commit)) {
        commit.navigation?.retire();
        retireGeneration(generation);
        retirePresentation(candidate);
        return false;
      }
      activePublicationRef.current = commit;
      if (commit.navigation && !commit.navigation.activate()) {
        commit.navigation.retire();
        commit.navigation = null;
      }
      lastPublicationRef.current.set(candidate, commit);
      return true;
    },
    [
      admitReplay,
      buildPublication,
      retireGeneration,
      retirePresentation,
    ],
  );
  const setPublicationElement = useCallback(
    (
      publication: SyncPublication,
      kind: SyncRefKind,
      element: HTMLElement | null,
    ) => {
      const generation = publication.generation;
      const observed = elementsFor(generation);
      const previous = observed.elements.get(kind) ?? null;
      const candidate = generation.presentation;
      if (element === null) {
        if (previous) {
          observed.elements.delete(kind);
          let detached = detachedElementsRef.current.get(candidate);
          if (!detached) {
            detached = new Set<HTMLElement>();
            detachedElementsRef.current.set(candidate, detached);
          }
          detached.add(previous);
        }
        retireGeneration(generation);
      } else {
        if (previous && previous !== element) retireGeneration(generation);
        observed.elements.set(kind, element);
        if (detachedElementsRef.current.get(candidate)?.has(element)) {
          let reattached = reattachedElementsRef.current.get(candidate);
          if (!reattached) {
            reattached = new Set<HTMLElement>();
            reattachedElementsRef.current.set(candidate, reattached);
          }
          reattached.add(element);
        }
      }
      if (retiredPresentationRef.current.has(candidate)) {
        retireGeneration(generation);
        const replayCommit = buildPublication(generation, true);
        if (replayCommit) {
          lastPublicationRef.current.set(candidate, replayCommit);
        }
        maybeRequestReplay(candidate);
      } else if (!retiredGenerationRef.current.has(generation)) {
        publishGeneration(generation);
      }
    },
    [
      buildPublication,
      elementsFor,
      maybeRequestReplay,
      publishGeneration,
      retireGeneration,
    ],
  );
  const ownsPresentation = useCallback(
    (candidate: SyncPresentation) => {
      const commit = activePublicationRef.current;
      return activePresentationRef.current === candidate &&
        !retiredPresentationRef.current.has(candidate) &&
        candidate.mount === mount &&
        candidate.open &&
        !!commit &&
        commit.generation.presentation === candidate &&
        !retiredGenerationRef.current.has(commit.generation) &&
        presentationFactsAreCurrent(candidate) &&
        publicationDomMatches(commit);
    },
    [mount, presentationFactsAreCurrent, publicationDomMatches],
  );
  const ownsControl = useCallback(
    (
      publication: ControlPublication,
      element: HTMLButtonElement,
    ) => {
      const commit = activePublicationRef.current;
      return !retiredPublicationRef.current.has(publication) &&
        commit?.generation === publication.generation &&
        commit.controls.get(publication.kind) === element &&
        ownsPresentation(publication.generation.presentation);
    },
    [ownsPresentation],
  );
  const ownsInput = useCallback(
    (
      publication: InputPublication,
      element: HTMLInputElement,
    ) => {
      const commit = activePublicationRef.current;
      return !retiredPublicationRef.current.has(publication) &&
        commit?.generation === publication.generation &&
        commit.input === element &&
        publicationDomMatches(commit, false) &&
        activePresentationRef.current === publication.generation.presentation &&
        !retiredPresentationRef.current.has(publication.generation.presentation) &&
        presentationFactsAreCurrent(publication.generation.presentation);
    },
    [presentationFactsAreCurrent, publicationDomMatches],
  );
  const ownsNavigation = useCallback(
    (publication: SyncNavigationPublication) => {
      const commit = activePublicationRef.current;
      const enabled = commit
        ? [...commit.controls].filter(([, element]) => !element.disabled)
        : [];
      return commit?.navigation === publication &&
        publication.generation === commit.generation &&
        publication.root === commit.root &&
        publication.controls.length === enabled.length &&
        publication.controls.every((control, index) => {
          const expected = enabled[index];
          return !!expected &&
            control.kind === expected[0] &&
            control.element === expected[1] &&
            control.publication ===
              commit.generation.publications?.controls.get(expected[0]);
        }) &&
        !publication.isRetired() &&
        publication.historyIsClean() &&
        publication.authority.ownerDocument === commit.root.ownerDocument &&
        publication.authority.ownerWindow ===
          commit.root.ownerDocument.defaultView &&
        publication.authority.isCurrent() &&
        ownsPresentation(publication.generation.presentation);
    },
    [ownsPresentation],
  );
  const captureNavigation = (
    controlPublication: ControlPublication,
    element: HTMLButtonElement,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (!event || typeof event !== "object") return;
    const commit = activePublicationRef.current;
    const publication = commit?.navigation;
    if (
      !commit ||
      !publication ||
      controlPublication.generation !== publication.generation
    ) {
      return;
    }
    let captures = capturedNavigationRef.current.get(publication);
    const nativeEvent = event.nativeEvent;
    if (captures?.has(nativeEvent)) {
      captures.delete(nativeEvent);
      claimedNativeKeyEventsRef.current.add(nativeEvent);
      return;
    }
    const control = publication.controls.find(
      (candidate) =>
        candidate.publication === controlPublication &&
        candidate.element === element,
    );
    if (!control) return;
    const key = readSyncReactKey(
      event,
      control,
      publication,
      publication.authority.capturingPhase,
    );
    const navigationKey = key
      ? syncNavigationKey(key.snapshot.key)
      : null;
    const sourceIndex = key
      ? publication.controls.indexOf(control)
      : -1;
    const destinationIndex =
      navigationKey && sourceIndex >= 0
        ? syncNavigationDestination(
            navigationKey,
            sourceIndex,
            publication.controls.length,
          )
        : -1;
    const destination =
      destinationIndex >= 0
        ? publication.controls[destinationIndex]
        : undefined;
    const authority = publication.authority;
    if (
      !key ||
      !navigationKey ||
      !destination ||
      destination === control ||
      destination.element === control.element ||
      authority.apply(
        authority.activeElement,
        authority.ownerDocument,
        [],
      ) !== control.element ||
      !syncControlIsEnabled(control.element) ||
      !syncControlIsEnabled(destination.element) ||
      claimedReactKeyEventsRef.current.has(event) ||
      claimedNativeKeyEventsRef.current.has(nativeEvent) ||
      activeMovementRef.current !== null ||
      claimedSourcesRef.current.has(control.element) ||
      claimedDestinationsRef.current.has(destination.element) ||
      !ownsNavigation(publication)
    ) {
      return;
    }
    if (!captures) {
      captures = new WeakMap();
      capturedNavigationRef.current.set(publication, captures);
    }
    captures.set(nativeEvent, key);
  };
  const navigate = (
    controlPublication: ControlPublication,
    element: HTMLButtonElement,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (!event || typeof event !== "object") return;
    const commit = activePublicationRef.current;
    const publication = commit?.navigation;
    const nativeEvent = event.nativeEvent;
    const captures = publication
      ? capturedNavigationRef.current.get(publication)
      : undefined;
    const captured = captures?.get(nativeEvent);
    if (captures) captures.delete(nativeEvent);
    if (
      !commit ||
      !publication ||
      !captured ||
      controlPublication.generation !== publication.generation
    ) {
      return;
    }
    const control = publication.controls.find(
      (candidate) =>
        candidate.publication === controlPublication &&
        candidate.element === element,
    );
    if (!control) return;
    const authority = publication.authority;
    const bubble = readSyncReactKey(
      event,
      control,
      publication,
      authority.bubblingPhase,
    );
    const navigationKey = bubble
      ? syncNavigationKey(bubble.snapshot.key)
      : null;
    const sourceIndex = bubble
      ? publication.controls.indexOf(control)
      : -1;
    const destinationIndex =
      navigationKey && sourceIndex >= 0
        ? syncNavigationDestination(
            navigationKey,
            sourceIndex,
            publication.controls.length,
          )
        : -1;
    const destination =
      destinationIndex >= 0
        ? publication.controls[destinationIndex]
        : undefined;
    if (
      !bubble ||
      !navigationKey ||
      !destination ||
      destination === control ||
      destination.element === control.element ||
      !syncReactKeyPairMatches(captured, bubble, publication) ||
      authority.apply(
        authority.activeElement,
        authority.ownerDocument,
        [],
      ) !== control.element ||
      !syncControlIsEnabled(control.element) ||
      !syncControlIsEnabled(destination.element) ||
      claimedReactKeyEventsRef.current.has(captured.event) ||
      claimedReactKeyEventsRef.current.has(event) ||
      claimedNativeKeyEventsRef.current.has(nativeEvent) ||
      activeMovementRef.current !== null ||
      claimedSourcesRef.current.has(control.element) ||
      claimedDestinationsRef.current.has(destination.element) ||
      !ownsNavigation(publication) ||
      !syncReactCancellationMatches(
        captured.event,
        captured.cancellation,
        authority,
      ) ||
      !syncReactCancellationMatches(
        event,
        bubble.cancellation,
        authority,
      ) ||
      !publication.keyListener.claim(
        bubble.listenerProof,
        publication,
      )
    ) {
      return;
    }

    const claim: SyncMovementClaim = {
      claimed: false,
      sourceClaimed: false,
      destinationClaimed: false,
    };
    const movement = Object.freeze<SyncMovement>({
      publication,
      source: control.element,
      destination: destination.element,
      key: navigationKey,
      claim,
    });
    activeMovementRef.current = movement;
    claimedMovementsRef.current.add(movement);
    claimedMovementClaimsRef.current.add(claim);
    claimedReactKeyEventsRef.current.add(captured.event);
    claimedReactKeyEventsRef.current.add(event);
    claimedNativeKeyEventsRef.current.add(nativeEvent);
    claimedSourcesRef.current.set(control.element, movement);
    claimedDestinationsRef.current.set(destination.element, movement);
    claim.claimed = true;
    claim.sourceClaimed = true;
    claim.destinationClaimed = true;

    try {
      const currentSnapshot = readSyncKeyboardEvent(
        nativeEvent,
        authority,
      );
      if (
        !currentSnapshot ||
        !syncKeyboardFactsMatch(
          bubble.snapshot,
          currentSnapshot,
        ) ||
        !publication.keyListener.retains(
          bubble.listenerProof,
          publication,
        ) ||
        !syncReactCancellationMatches(
          captured.event,
          captured.cancellation,
          authority,
        ) ||
        !syncReactCancellationMatches(
          event,
          bubble.cancellation,
          authority,
        ) ||
        activeMovementRef.current !== movement ||
        !claimedMovementsRef.current.has(movement) ||
        !claimedMovementClaimsRef.current.has(claim) ||
        claimedSourcesRef.current.get(control.element) !== movement ||
        claimedDestinationsRef.current.get(destination.element) !==
          movement ||
        !claim.claimed ||
        !claim.sourceClaimed ||
        !claim.destinationClaimed ||
        movement.publication !== publication ||
        movement.source !== control.element ||
        movement.destination !== destination.element ||
        movement.key !== navigationKey ||
        authority.apply(
          authority.activeElement,
          authority.ownerDocument,
          [],
        ) !== control.element ||
        !syncControlIsEnabled(control.element) ||
        !syncControlIsEnabled(destination.element) ||
        !ownsNavigation(publication)
      ) {
        return;
      }
      authority.apply(
        authority.event.preventDefault,
        nativeEvent,
        [],
      );
      if (
        !authority.apply(
          authority.event.defaultPrevented,
          nativeEvent,
          [],
        ) ||
        !publication.keyListener.retains(
          bubble.listenerProof,
          publication,
        ) ||
        activeMovementRef.current !== movement ||
        claimedSourcesRef.current.get(control.element) !== movement ||
        claimedDestinationsRef.current.get(destination.element) !==
          movement ||
        authority.apply(
          authority.activeElement,
          authority.ownerDocument,
          [],
        ) !== control.element ||
        !syncControlIsEnabled(control.element) ||
        !syncControlIsEnabled(destination.element) ||
        !ownsNavigation(publication)
      ) {
        return;
      }
      authority.apply(authority.focus, destination.element, [
        SYNC_PREVENT_SCROLL,
      ]);
    } finally {
      if (activeMovementRef.current === movement) {
        activeMovementRef.current = null;
      }
      if (claimedSourcesRef.current.get(control.element) === movement) {
        claimedSourcesRef.current.delete(control.element);
      }
      if (
        claimedDestinationsRef.current.get(destination.element) ===
        movement
      ) {
        claimedDestinationsRef.current.delete(destination.element);
      }
    }
  };
  const closePresentation = useCallback(
    (candidate: SyncPresentation) => {
      if (!ownsPresentation(candidate) || !retirePresentation(candidate)) return;
      candidate.onOpenChange(false);
    },
    [ownsPresentation, retirePresentation],
  );

  const run = async (
    publication: ActionControlPublication,
    element: HTMLButtonElement,
  ) => {
    const candidate = publication.generation.presentation;
    if (
      !ownsControl(publication, element) ||
      inFlightRef.current ||
      successCloseRef.current ||
      ((publication.kind === "merge" || publication.kind === "take") &&
        candidate.remoteUnreadable)
    ) {
      return;
    }

    const owner: ActionOwner = {
      presentation: candidate,
      publication,
      retired: false,
    };
    inFlightRef.current = owner;
    setBusy(publication.kind);
    setError(null);
    setDone(null);
    try {
      const note = await publication.invoke();
      if (
        owner.retired ||
        !ownsPresentation(candidate) ||
        inFlightRef.current !== owner
      ) {
        return;
      }
      setDone(note);
      const scheduledClose: SuccessClose = {
        owner,
        timer: setTimeout(() => {
          if (
            scheduledClose.retired ||
            owner.retired ||
            successCloseRef.current !== scheduledClose ||
            !ownsPresentation(candidate)
          ) {
            return;
          }
          scheduledClose.retired = true;
          owner.retired = true;
          successCloseRef.current = null;
          closePresentation(candidate);
        }, 900),
        retired: false,
      };
      successCloseRef.current = scheduledClose;
    } catch (e) {
      if (
        owner.retired ||
        !ownsPresentation(candidate) ||
        inFlightRef.current !== owner
      ) {
        return;
      }
      setError(apiErrorText(e, "Sync failed"));
    } finally {
      if (
        !owner.retired &&
        ownsPresentation(candidate) &&
        inFlightRef.current === owner
      ) {
        inFlightRef.current = null;
        setBusy(null);
        if (!successCloseRef.current || successCloseRef.current.owner !== owner) {
          owner.retired = true;
        }
      }
    }
  };

  const generation: PublicationGeneration = {
    presentation,
    message,
    busy,
    error,
    done,
    publications: null,
  };
  const dialogEventPublication: DialogEventPublication = { generation };
  const rootPublication: RootPublication = { generation };
  const inputPublication: InputPublication = { generation };
  const publishedMessage = message.trim();
  const mergePublication: ActionControlPublication = {
    generation,
    kind: "merge",
    invoke: async () => {
      const conflicts = await presentation.merge();
      return conflicts > 0
        ? `${conflicts} conflict${conflicts === 1 ? "" : "s"} to resolve in the editor`
        : "Merged — review, then publish";
    },
  };
  const keepPublication: ActionControlPublication = {
    generation,
    kind: "keep",
    invoke: async () =>
      (await presentation.keepMine(publishedMessage), "Published your version"),
  };
  const takePublication: ActionControlPublication = {
    generation,
    kind: "take",
    invoke: async () =>
      (await presentation.takeRemote(), "Replaced with GitHub's copy"),
  };
  const comparePublication: CompareControlPublication = {
    generation,
    kind: "compare",
    invoke: presentation.compare,
  };
  generation.publications = {
    dialogEvent: dialogEventPublication,
    root: rootPublication,
    input: inputPublication,
    controls: new Map<SyncControlKind, ControlPublication>([
      ["merge", mergePublication],
      ["keep", keepPublication],
      ["take", takePublication],
      ["compare", comparePublication],
    ]),
  };
  latestGenerationRef.current = generation;

  useLayoutEffect(() => {
    const previous = activePresentationRef.current;
    if (previous && previous !== presentation) retirePresentation(previous);
    if (!presentation.open) {
      return () => {
        retirePresentation(presentation);
      };
    }
    if (retiredPresentationRef.current.has(presentation)) {
      const setup = { presentation, active: true };
      replaySetupRef.current = setup;
      maybeRequestReplay(presentation);
      return () => {
        setup.active = false;
        if (replaySetupRef.current === setup) replaySetupRef.current = null;
        retirePresentation(presentation);
      };
    }

    const currentGeneration = latestGenerationRef.current;
    if (
      currentGeneration?.presentation === presentation &&
      activateGeneration(currentGeneration) &&
      !presentation.replay
    ) {
      setError(null);
      setDone(null);
      setBusy(null);
    }
    return () => {
      retirePresentation(presentation);
    };
  }, [
    activateGeneration,
    maybeRequestReplay,
    presentation,
    retirePresentation,
  ]);

  useLayoutEffect(() => {
    if (initialMessageVisit) setMessage(initialMessageVisit.message);
  }, [initialMessageVisit]);

  const activateCompare = (
    publication: CompareControlPublication,
    element: HTMLButtonElement,
  ) => {
    const candidate = publication.generation.presentation;
    if (
      !ownsControl(publication, element) ||
      candidate.remoteUnreadable ||
      inFlightRef.current ||
      successCloseRef.current ||
      !retirePresentation(candidate)
    ) {
      return;
    }
    publication.invoke();
    candidate.onOpenChange(false);
  };
  // Stable identity (unlike a plain inline function) so that the root dialog's cached
  // presentation - and its Radix Escape-close binding - survives the frequent re-renders
  // that a live sync-status poll causes (regression for #2215: Escape stopped closing Sync).
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      const current = latestPresentationRef.current;
      if (nextOpen) return;
      if (!current || retiredPresentationRef.current.has(current)) return;
      retirePresentation(current);
      onOpenChange(false);
    },
    [onOpenChange, retirePresentation],
  );
  const where = presentation.storage === "gist"
    ? "the gist"
    : `${presentation.repoOwner}/${presentation.repoName} (${presentation.repoBranch})`;
  const plural = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  const formatMb = (bytes: number) => {
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? String(Math.ceil(mb)) : String(Math.ceil(mb * 100) / 100);
  };
  const sizeMessage =
    presentation.remoteSize != null && presentation.remoteLimit != null
      ? `The GitHub file is ${formatMb(presentation.remoteSize)} MB, but Markdoc can read files up to ${formatMb(presentation.remoteLimit)} MB.`
      : "The GitHub file is too large for Markdoc to read.";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <div
        ref={(element) =>
          setPublicationElement(dialogEventPublication, "bridge", element)}
        className="contents"
      >
        <DialogContent
          title="Sync with GitHub"
          description={presentation.remoteUnreadable ? `The file in ${where} cannot be read until it is made smaller or replaced.` : `This document and ${where} both changed since they were last in sync.`}
        >
          <div
            ref={(element) =>
              setPublicationElement(rootPublication, "root", element)}
            className="flex flex-col gap-4"
            data-testid="sync-dialog"
            data-status={presentation.status}
          >
          {presentation.remoteUnreadable ? (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="alert" data-testid="sync-remote-unreadable">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                <div>{sizeMessage}</div>
                <div className="mt-1 text-xs">Merge, pull, and compare are unavailable. Keep mine will replace the GitHub file with this document.</div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl border border-line bg-surface-2 p-3">
                <div className="text-xs font-medium uppercase tracking-wide text-ink-3">This document</div>
                <div className="mt-1 font-medium text-ink" data-testid="sync-local-lines">
                  {presentation.localChanged ? `${plural(presentation.localLines)} changed` : "No changes"}
                </div>
                <div className="text-xs text-ink-3" title={presentation.publishedAt ? formatDateTime(presentation.publishedAt) : undefined}>since {presentation.publishedAt ? relativeTime(presentation.publishedAt) : "the last sync"}</div>
              </div>
              <div className="rounded-xl border border-line bg-surface-2 p-3">
                <div className="text-xs font-medium uppercase tracking-wide text-ink-3">On GitHub</div>
                <div className="mt-1 font-medium text-ink" data-testid="sync-remote-lines">
                  {presentation.remoteChanged ? `${plural(presentation.remoteLines)} changed` : "No changes"}
                </div>
                <div className="truncate text-xs text-ink-3" title={presentation.remoteUpdatedAt ? formatDateTime(presentation.remoteUpdatedAt) : presentation.remoteSha || undefined}>
                  {presentation.remoteUpdatedAt ? `updated ${relativeTime(presentation.remoteUpdatedAt)}` : presentation.remoteSha ? `at ${presentation.remoteSha.slice(0, 7)}` : "\u00a0"}
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {!presentation.remoteUnreadable && (
              <button
                ref={(element) =>
                  setPublicationElement(mergePublication, "merge", element)}
                type="button"
                className="btn btn-primary justify-start gap-2"
                disabled={!!busy || !!done}
                data-testid="sync-merge"
                onClick={(event) => void run(mergePublication, event.currentTarget)}
                onKeyDownCapture={(event) =>
                  captureNavigation(
                    mergePublication,
                    event.currentTarget,
                    event,
                  )}
                onKeyDown={(event) =>
                  navigate(
                    mergePublication,
                    event.currentTarget,
                    event,
                  )}
              >
                {busy === "merge" ? <Loader2 size={16} className="animate-spin" /> : <GitMerge size={16} />}
                <span className="flex flex-col items-start">
                  <span>Merge</span>
                  <span className="text-xs font-normal opacity-80">Combine both sets of edits; conflicting lines are marked for you to resolve.</span>
                </span>
              </button>
            )}
            <button
              ref={(element) =>
                setPublicationElement(keepPublication, "keep", element)}
              type="button"
              className="btn btn-outline justify-start gap-2"
              disabled={!!busy || !!done}
              data-testid="sync-keep-mine"
              onClick={(event) => void run(keepPublication, event.currentTarget)}
              onKeyDownCapture={(event) =>
                captureNavigation(
                  keepPublication,
                  event.currentTarget,
                  event,
                )}
              onKeyDown={(event) =>
                navigate(
                  keepPublication,
                  event.currentTarget,
                  event,
                )}
            >
              {busy === "keep" ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
              <span className="flex flex-col items-start">
                <span>Keep mine</span>
                <span className="text-xs font-normal text-ink-3">Force-publish this document over the GitHub file.</span>
              </span>
            </button>
            {!presentation.remoteUnreadable && (
              <>
                <button
                  ref={(element) =>
                    setPublicationElement(takePublication, "take", element)}
                  type="button"
                  className="btn btn-outline justify-start gap-2"
                  disabled={!!busy || !!done}
                  data-testid="sync-take-remote"
                  onClick={(event) => void run(takePublication, event.currentTarget)}
                  onKeyDownCapture={(event) =>
                    captureNavigation(
                      takePublication,
                      event.currentTarget,
                      event,
                    )}
                  onKeyDown={(event) =>
                    navigate(
                      takePublication,
                      event.currentTarget,
                      event,
                    )}
                >
                  {busy === "take" ? <Loader2 size={16} className="animate-spin" /> : <CloudDownload size={16} />}
                  <span className="flex flex-col items-start">
                    <span>Take GitHub</span>
                    <span className="text-xs font-normal text-ink-3">Force-pull; your local edits are kept in version history.</span>
                  </span>
                </button>
                <button
                  ref={(element) =>
                    setPublicationElement(comparePublication, "compare", element)}
                  type="button"
                  className="btn btn-ghost justify-start gap-2"
                  disabled={!!busy}
                  data-testid="sync-compare"
                  onClick={(event) => activateCompare(comparePublication, event.currentTarget)}
                  onKeyDownCapture={(event) =>
                    captureNavigation(
                      comparePublication,
                      event.currentTarget,
                      event,
                    )}
                  onKeyDown={(event) =>
                    navigate(
                      comparePublication,
                      event.currentTarget,
                      event,
                    )}
                >
                  <Scale size={16} /> Compare GitHub with this document
                </button>
              </>
            )}
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-2">{presentation.storage === "gist" ? "Description" : "Commit message"} <span className="font-normal text-ink-3">(for Keep mine)</span></span>
            <input
              ref={(element) =>
                setPublicationElement(inputPublication, "input", element)}
              className="input"
              value={message}
              onChange={(event) => {
                if (!ownsInput(inputPublication, event.currentTarget)) return;
                setMessage(event.currentTarget.value);
              }}
              data-testid="commit-message"
            />
          </label>

          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger wrap-anywhere dark:bg-red-950/40" role="alert">
              <AlertTriangle size={14} className="shrink-0" /> {error}
            </div>
          )}
          {done && (
            <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2 wrap-anywhere" data-testid="sync-done">
              <Check size={14} className="shrink-0 text-success" /> {done}
            </div>
          )}
          </div>
        </DialogContent>
      </div>
    </Dialog>
  );
});
