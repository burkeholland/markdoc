"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, Replace, WholeWord, X } from "lucide-react";
import type { CollabSession, FindState } from "@/editor/collab/session";
import { compileFindRegex, type FindMatch, type FindOptions } from "@/editor/find";
import { Tip } from "@/components/ui/primitives";
import { cn, findReplaceShortcut, shortcut } from "@/lib/utils";
import { shallowEqual, useSessionValue } from "./use-session";
import {
  findKeyboardPathIncludes,
  freezeFindKeyboardRecord,
  preventFindKeyboardDefault,
  readFindKeyboardFacts,
  sameFindKeyboardDelivery,
  scheduleFindKeyboardRecordExpiry,
  trustedFindKeyboardIntrinsics,
  type FindKeyboardIntrinsics,
  type FindNativeKeyboardFacts,
} from "./find-keyboard-trust";

export interface FindBarProps {
  session: CollabSession;
  /** Whether the replace row is shown. */
  replaceVisible: boolean;
  onReplaceVisible: (visible: boolean) => void;
  /** Bumped by the shell whenever the bar should take focus (Mod-F while already open). */
  focusNonce: number;
  /** Called after the active match changes so the shell can scroll it into view. */
  onReveal: (match: FindMatch) => void;
  /** Called when the bar wants to close (Escape or the close button). */
  onClose: () => void;
}

type FindInput = "search" | "replace";
type FindControl =
  | "matchCase"
  | "wholeWord"
  | "regex"
  | "previous"
  | "next"
  | "toggleReplace"
  | "close"
  | "replaceOne"
  | "replaceAll";

interface FindBarVisit {
  readonly mount: symbol;
  readonly session: CollabSession;
}

interface SearchFocusRequest {
  readonly visit: FindBarVisit;
  readonly focusNonce: number;
}

interface ReplacementDraft {
  readonly visit: FindBarVisit;
  readonly value: string;
}

interface FindBarMethods {
  readonly setFind: CollabSession["setFind"];
  readonly stepFind: CollabSession["stepFind"];
  readonly replaceActive: CollabSession["replaceActive"];
  readonly replaceAll: CollabSession["replaceAll"];
}

interface FindBarAuthority {
  readonly visit: FindBarVisit;
  readonly session: CollabSession;
  readonly find: FindState;
  readonly options: FindOptions;
  readonly optionValues: Readonly<FindOptions>;
  readonly matches: FindMatch[];
  readonly matchValues: readonly Readonly<FindMatch>[];
  readonly query: string;
  readonly replacement: string;
  readonly canEdit: boolean;
  readonly total: number;
  readonly active: number;
  readonly replaceVisible: boolean;
  readonly showReplace: boolean;
  readonly focusNonce: number;
  readonly focusRequest: SearchFocusRequest;
  readonly invalidRegex: boolean;
  readonly noMatches: boolean;
  readonly actionsDisabled: boolean;
  readonly methods: FindBarMethods;
  readonly onReplaceVisible: (visible: boolean) => void;
  readonly onReveal: (match: FindMatch) => void;
  readonly onClose: () => void;
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
      retireOnDetach: boolean,
    ) => void,
    private readonly retireOnDetach = true,
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
    const replaced = element !== null && this.lastElement !== null && this.lastElement !== element;
    this.current = element;
    if (element) this.lastElement = element;
    if (replaced || element === null || previous !== element) {
      this.onChange(this, element, previous, last, this.retireOnDetach);
    }
  };
}

interface FindInputPublication {
  readonly capture: (element: HTMLInputElement | null) => void;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

interface FindControlPublication {
  readonly id: FindControl;
  readonly enabled: boolean;
  readonly capture: (element: HTMLButtonElement | null) => void;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onMouseDown?: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

interface FindBarPublication {
  readonly authority: FindBarAuthority;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
  readonly ownsInput: (kind: FindInput, element: HTMLInputElement) => boolean;
  readonly focusSearch: () => boolean;
  readonly scheduleReplaceFocus: () => boolean;
}

interface FindBarPublicationSet {
  readonly captureBar: (element: HTMLDivElement | null) => void;
  readonly captureFirstRow: (element: HTMLDivElement | null) => void;
  readonly inputs: Readonly<Record<FindInput, FindInputPublication>>;
  readonly controls: Readonly<Record<FindControl, FindControlPublication>>;
  readonly establish: () => void | (() => void);
  readonly onBarKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onFirstRowKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => void;
}

interface ReplaceFocusIntent {
  readonly source: FindBarPublication;
}

interface ReplaceFocusOwner {
  readonly publication: FindBarPublication;
  readonly element: HTMLInputElement;
  frame: number | null;
}

interface PublicationCells {
  readonly active: CurrentCell<FindBarPublication | null>;
  readonly successorOf: CurrentCell<FindBarPublication | null>;
  readonly replay: CurrentCell<FindBarReplay | null>;
  readonly focusRequest: CurrentCell<SearchFocusRequest | null>;
  readonly replaceIntent: CurrentCell<ReplaceFocusIntent | null>;
  readonly replaceFocus: CurrentCell<ReplaceFocusOwner | null>;
  readonly claimedActivations: WeakSet<object>;
  readonly claimedMouseDowns: WeakSet<object>;
  readonly keyboardDeliveries: WeakMap<object, FindKeyboardDelivery>;
  readonly actionPairs: WeakMap<object, FindActionKeyPair>;
  /**
   * The exact native-event keys each publication still has pending in `actionPairs`. The WeakMap
   * alone keeps a retired publication reachable for as long as its native event lives, so the keys
   * are tracked here and both entries are dropped together at the claim and at retirement.
   */
  readonly pendingActionKeys: Map<FindBarPublication, Set<object>>;
  readonly actionAttemptReactEvents: WeakSet<object>;
  readonly actionAttemptNativeEvents: WeakSet<object>;
  readonly claimedActionDeliveries: WeakSet<object>;
  readonly claimedActionTokens: WeakSet<object>;
  readonly activeActionAttempt: CurrentCell<FindActionAttempt | null>;
  readonly activeActionDelivery: CurrentCell<FindActionKeyDelivery | null>;
}

interface PublicationLifecycle {
  readonly establish: () => void | (() => void);
}

function createInactivePublication(cells: PublicationCells): PublicationLifecycle {
  return Object.freeze({
    establish: () => {
      cells.active.current?.retire();
      cells.successorOf.current = null;
      cells.replay.current?.release();
      cells.replay.current = null;
      cells.replaceIntent.current = null;
      // Cleanup revokes every pending pair, so no retired publication stays reachable through a
      // native event that outlives this bar. Every removal goes through a retained collection
      // intrinsic, so a replaced `delete`, `clear`, or iteration slot never answers for cleanup.
      findActionMapForEach(cells.pendingActionKeys, (pending) => {
        findActionSetForEach(pending, (nativeEvent) => {
          findActionWeakDelete(cells.actionPairs, nativeEvent);
        });
        findActionSetClear(pending);
      });
      findActionMapClear(cells.pendingActionKeys);
      cells.activeActionAttempt.current = null;
      cells.activeActionDelivery.current = null;
    },
  });
}

interface FindBarDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly FindBarDomSnapshot[];
}

interface FindBarReplay {
  readonly source: FindBarPublication;
  readonly dom: FindBarDomSnapshot;
  readonly placement: FindBarPlacement;
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

interface FindBarPlacement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface RefReplay {
  readonly owner: ElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface FindKeyboardDelivery {
  readonly publication: FindBarPublication;
  readonly facts: FindNativeKeyboardFacts;
}

interface FindBarPublicationRuntime {
  readonly publication: FindBarPublication;
  readonly nav: FindActionRuntimeView | null;
  readonly publish: (snapshot: FindBarDomSnapshot, owners: readonly ElementOwnerView[]) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  /**
   * Synchronously drains the observer through the authenticated owner-realm `takeRecords`, so a
   * mutation the last public walk queued is recorded before the callback-free gate reads history.
   */
  readonly drainObservedMutations: () => boolean;
  /** The recorded publication history, readable without calling one page-owned DOM operation. */
  readonly domHistoryIsRetained: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replayDomUnchanged: () => boolean;
  readonly releaseReplayGuard: () => void;
  readonly snapshot: () => FindBarDomSnapshot | null;
  readonly placement: () => FindBarPlacement | null;
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotFindBarDom(node: Node): FindBarDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotFindBarDom)),
  });
}

function findBarDomMatches(snapshot: FindBarDomSnapshot): boolean {
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
      node.childNodes.item(index) === child.node && findBarDomMatches(child));
}

function captureFindBarPlacement(root: HTMLDivElement): FindBarPlacement | null {
  const parent = root.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: root.ownerDocument,
    parent,
    previousSibling: root.previousSibling,
    nextSibling: root.nextSibling,
  });
}

function findBarPlacementMatches(
  root: HTMLDivElement,
  placement: FindBarPlacement,
): boolean {
  return (
    root.ownerDocument === placement.document &&
    root.parentNode === placement.parent &&
    root.previousSibling === placement.previousSibling &&
    root.nextSibling === placement.nextSibling
  );
}

function authoritiesMatch(
  previous: FindBarAuthority,
  current: FindBarAuthority,
  visibility: "same" | "opened",
) {
  const visibilityMatches = visibility === "same"
    ? previous.replaceVisible === current.replaceVisible &&
      previous.showReplace === current.showReplace
    : !previous.replaceVisible &&
      !previous.showReplace &&
      current.replaceVisible &&
      current.showReplace;
  return (
    visibilityMatches &&
    previous.visit === current.visit &&
    previous.session === current.session &&
    previous.find === current.find &&
    previous.options === current.options &&
    previous.optionValues.matchCase === current.optionValues.matchCase &&
    previous.optionValues.wholeWord === current.optionValues.wholeWord &&
    previous.optionValues.regex === current.optionValues.regex &&
    previous.matches === current.matches &&
    previous.matchValues.length === current.matchValues.length &&
    previous.matchValues.every((match, index) => {
      const candidate = current.matchValues[index];
      return candidate?.from === match.from && candidate.to === match.to;
    }) &&
    previous.query === current.query &&
    previous.replacement === current.replacement &&
    previous.canEdit === current.canEdit &&
    previous.total === current.total &&
    previous.active === current.active &&
    previous.focusNonce === current.focusNonce &&
    previous.focusRequest === current.focusRequest &&
    previous.invalidRegex === current.invalidRegex &&
    previous.noMatches === current.noMatches &&
    previous.actionsDisabled === current.actionsDisabled &&
    previous.methods.setFind === current.methods.setFind &&
    previous.methods.stepFind === current.methods.stepFind &&
    previous.methods.replaceActive === current.methods.replaceActive &&
    previous.methods.replaceAll === current.methods.replaceAll &&
    previous.onReplaceVisible === current.onReplaceVisible &&
    previous.onReveal === current.onReveal &&
    previous.onClose === current.onClose
  );
}

function isExactReplaySuccessor(source: FindBarPublication, authority: FindBarAuthority) {
  return authoritiesMatch(source.authority, authority, "same");
}

function isExactReplaceSuccessor(source: FindBarPublication, candidate: FindBarPublication) {
  const previous = source.authority;
  const current = candidate.authority;
  return authoritiesMatch(previous, current, "opened");
}

const FIND_ACTION_PREVENT_SCROLL: FocusOptions = Object.freeze({ preventScroll: true });
const FIND_ACTION_APPLY = Reflect.apply;
const FIND_ACTION_FREEZE = Object.freeze;
const FIND_ACTION_OWN_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const FIND_ACTION_PROTOTYPE_OF = Object.getPrototypeOf;
const FIND_ACTION_IS_ARRAY = Array.isArray;
const FIND_ACTION_IS = Object.is;
const FIND_ACTION_CONSTRUCT = Reflect.construct;
/**
 * Case folding for an attribute token, retained like every other intrinsic: the enabled walk never
 * dispatches through a `String.prototype` slot page code can replace.
 */
const FIND_ACTION_TO_LOWER_CASE = String.prototype.toLowerCase;
/**
 * The collection intrinsics the gate and claim paths need, retained at module evaluation and applied
 * directly. Nothing after the last mutable query looks a method up on a prototype page code can
 * replace, so no `has`, `get`, `add`, `set`, `delete`, `clear`, `size`, or iteration slot can answer
 * for — or re-enter — the claim boundary.
 */
const FIND_ACTION_WEAKSET_HAS = WeakSet.prototype.has;
const FIND_ACTION_WEAKSET_ADD = WeakSet.prototype.add;
const FIND_ACTION_WEAKSET_DELETE = WeakSet.prototype.delete;
const FIND_ACTION_WEAKMAP_GET = WeakMap.prototype.get;
const FIND_ACTION_WEAKMAP_HAS = WeakMap.prototype.has;
const FIND_ACTION_WEAKMAP_SET = WeakMap.prototype.set;
const FIND_ACTION_WEAKMAP_DELETE = WeakMap.prototype.delete;
const FIND_ACTION_MAP_GET = Map.prototype.get;
const FIND_ACTION_MAP_SET = Map.prototype.set;
const FIND_ACTION_MAP_DELETE = Map.prototype.delete;
const FIND_ACTION_MAP_CLEAR = Map.prototype.clear;
const FIND_ACTION_MAP_FOR_EACH = Map.prototype.forEach;
const FIND_ACTION_SET_CONSTRUCTOR = Set;
const FIND_ACTION_SET_HAS = Set.prototype.has;
const FIND_ACTION_SET_ADD = Set.prototype.add;
const FIND_ACTION_SET_DELETE = Set.prototype.delete;
const FIND_ACTION_SET_CLEAR = Set.prototype.clear;
const FIND_ACTION_SET_FOR_EACH = Set.prototype.forEach;
/**
 * `Set.prototype.size` is an accessor, so the boundary keeps its exact getter too: nothing on the
 * claim path may ask a collection for its size through a slot page code can replace.
 */
const FIND_ACTION_SET_SIZE = (FIND_ACTION_OWN_DESCRIPTOR(Set.prototype, "size")?.get ?? null) as
  | ((...args: unknown[]) => unknown)
  | null;
const FIND_ACTION_CAPTURING_PHASE = 1;
const FIND_ACTION_BUBBLING_PHASE = 3;
const FIND_ACTION_ELEMENT_NODE = 1;
/** Bounded walks: an ancestry or prototype chain that will not end is unreadable, never accepted. */
const FIND_ACTION_ANCESTOR_LIMIT = 64;
const FIND_ACTION_CHAIN_LIMIT = 32;
/** Returned when an authenticated intrinsic cannot be read, so every comparison against it fails. */
const FIND_ACTION_UNREADABLE = Symbol("find action unreadable");

function findActionTokenIsClaimed(set: WeakSet<object>, token: object) {
  return FIND_ACTION_APPLY(FIND_ACTION_WEAKSET_HAS, set, [token]) === true;
}

function findActionClaimToken(set: WeakSet<object>, token: object) {
  FIND_ACTION_APPLY(FIND_ACTION_WEAKSET_ADD, set, [token]);
}

function findActionReleaseToken(set: WeakSet<object>, token: object) {
  FIND_ACTION_APPLY(FIND_ACTION_WEAKSET_DELETE, set, [token]);
}

function findActionWeakGet<T>(map: WeakMap<object, T>, key: object): T | undefined {
  return FIND_ACTION_APPLY(FIND_ACTION_WEAKMAP_GET, map, [key]) as T | undefined;
}

function findActionWeakHas<T>(map: WeakMap<object, T>, key: object) {
  return FIND_ACTION_APPLY(FIND_ACTION_WEAKMAP_HAS, map, [key]) === true;
}

function findActionWeakSet<T>(map: WeakMap<object, T>, key: object, value: T) {
  FIND_ACTION_APPLY(FIND_ACTION_WEAKMAP_SET, map, [key, value]);
}

function findActionWeakDelete<T>(map: WeakMap<object, T>, key: object) {
  FIND_ACTION_APPLY(FIND_ACTION_WEAKMAP_DELETE, map, [key]);
}

function findActionMapGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  return FIND_ACTION_APPLY(FIND_ACTION_MAP_GET, map, [key]) as V | undefined;
}

function findActionMapSet<K, V>(map: Map<K, V>, key: K, value: V) {
  FIND_ACTION_APPLY(FIND_ACTION_MAP_SET, map, [key, value]);
}

function findActionMapDelete<K, V>(map: Map<K, V>, key: K) {
  FIND_ACTION_APPLY(FIND_ACTION_MAP_DELETE, map, [key]);
}

function findActionMapClear<K, V>(map: Map<K, V>) {
  FIND_ACTION_APPLY(FIND_ACTION_MAP_CLEAR, map, []);
}

/** `Map.prototype.forEach` walks the backing entries directly: no iterator protocol is consulted. */
function findActionMapForEach<K, V>(map: Map<K, V>, visit: (value: V, key: K) => void) {
  FIND_ACTION_APPLY(FIND_ACTION_MAP_FOR_EACH, map, [visit]);
}

function findActionNewSet<T>(): Set<T> {
  return new FIND_ACTION_SET_CONSTRUCTOR<T>();
}

function findActionSetHas<T>(set: Set<T>, value: T) {
  return FIND_ACTION_APPLY(FIND_ACTION_SET_HAS, set, [value]) === true;
}

function findActionSetAdd<T>(set: Set<T>, value: T) {
  FIND_ACTION_APPLY(FIND_ACTION_SET_ADD, set, [value]);
}

function findActionSetDelete<T>(set: Set<T>, value: T) {
  FIND_ACTION_APPLY(FIND_ACTION_SET_DELETE, set, [value]);
}

function findActionSetClear<T>(set: Set<T>) {
  FIND_ACTION_APPLY(FIND_ACTION_SET_CLEAR, set, []);
}

/** Walks the backing entries directly, like the Map form: no iterator protocol is consulted. */
function findActionSetForEach<T>(set: Set<T>, visit: (value: T) => void) {
  FIND_ACTION_APPLY(FIND_ACTION_SET_FOR_EACH, set, [visit]);
}

/** The exact size, or `-1` when the realm published no readable size getter to retain. */
function findActionSetSize<T>(set: Set<T>) {
  if (!FIND_ACTION_SET_SIZE) return -1;
  const size = FIND_ACTION_APPLY(FIND_ACTION_SET_SIZE, set, []);
  return typeof size === "number" ? size : -1;
}

/**
 * The exact own data slot behind a property, or {@link FIND_ACTION_UNREADABLE}. An accessor, a
 * missing slot, or a proxy trap that refuses the descriptor is never read and never invoked, so the
 * callback-free gate can bind live state without handing control to a getter.
 */
function findActionOwnData(target: unknown, property: PropertyKey): unknown {
  if (
    target === null ||
    (typeof target !== "object" && typeof target !== "function")
  ) {
    return FIND_ACTION_UNREADABLE;
  }
  try {
    const descriptor = FIND_ACTION_OWN_DESCRIPTOR(target as object, property);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return FIND_ACTION_UNREADABLE;
    }
    return descriptor.value as unknown;
  } catch {
    return FIND_ACTION_UNREADABLE;
  }
}

/** Case folding through the retained intrinsic, or `null` when the realm cannot answer for it. */
function findActionLowerCase(value: string) {
  try {
    const lowered = FIND_ACTION_APPLY(
      FIND_ACTION_TO_LOWER_CASE as (...args: unknown[]) => unknown,
      value,
      [],
    );
    return typeof lowered === "string" ? lowered : null;
  } catch {
    return null;
  }
}

/**
 * The exact accessor a class publishes for a live authority property: its holder, the holder's
 * prototype link, the getter and setter identities, and the descriptor flags, captured once at
 * publication. The gate compares this exact binding instead of accepting whatever accessor happens
 * to sit on the immediate prototype when it looks.
 */
interface FindActionAccessorBinding {
  readonly owner: object;
  readonly prototype: object | null;
  readonly descriptor: PropertyDescriptor;
  readonly getter: AnyFunction;
}

function captureFindActionAccessorBinding(
  target: object,
  property: PropertyKey,
): FindActionAccessorBinding | null {
  try {
    if (FIND_ACTION_OWN_DESCRIPTOR(target, property) !== undefined) return null;
    const owner = FIND_ACTION_PROTOTYPE_OF(target) as object | null;
    if (!owner) return null;
    const own = FIND_ACTION_OWN_DESCRIPTOR(owner, property);
    if (
      !own ||
      "value" in own ||
      typeof own.get !== "function" ||
      (own.set !== undefined && typeof own.set !== "function")
    ) {
      return null;
    }
    return FIND_ACTION_FREEZE({
      owner,
      prototype: FIND_ACTION_PROTOTYPE_OF(owner) as object | null,
      descriptor: FIND_ACTION_FREEZE({ ...own }),
      getter: own.get as AnyFunction,
    });
  } catch {
    return null;
  }
}

/** The retained accessor, re-read by descriptor only: exact holder, exact link, exact identities. */
function findActionAccessorIsRetained(
  binding: FindActionAccessorBinding,
  target: object,
  property: PropertyKey,
) {
  try {
    const current = FIND_ACTION_OWN_DESCRIPTOR(binding.owner, property);
    return (
      FIND_ACTION_OWN_DESCRIPTOR(target, property) === undefined &&
      FIND_ACTION_PROTOTYPE_OF(target) === binding.owner &&
      FIND_ACTION_PROTOTYPE_OF(binding.owner) === binding.prototype &&
      findActionDescriptorsMatch(current, binding.descriptor) &&
      !!current &&
      current.get === binding.getter
    );
  } catch {
    return false;
  }
}

type FindActionKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";

type AnyFunction = (...args: never[]) => unknown;

interface FindActionMember<T> {
  readonly value: T;
  readonly isCurrent: () => boolean;
}

interface FindActionIntrinsics {
  readonly ownerWindow: Window & typeof globalThis;
  readonly nodeConstructor: typeof Node;
  readonly mutationObserverConstructor: typeof MutationObserver;
  readonly addEventListener: FindActionMember<Window["addEventListener"]>;
  readonly removeEventListener: FindActionMember<Window["removeEventListener"]>;
  readonly isCurrent: () => boolean;
  readonly methodMatches: (
    value: object,
    property: PropertyKey,
    method: unknown,
  ) => boolean;
  readonly ownValue: (value: object, property: PropertyKey) => unknown;
  readonly read: (method: AnyFunction, receiver: object) => unknown;
  readonly invoke: (method: AnyFunction, receiver: object) => boolean;
  readonly propagationStopped: (event: object) => boolean;
  /**
   * The retained owner-realm `HTMLElement.prototype.focus`, applied directly once the final gate has
   * passed. Nothing re-reads a Window property, a collection, or a descriptor after that gate.
   */
  readonly focusMethod: AnyFunction;
  /**
   * Owner-realm property getters invoked directly, so the final gate re-reads native DOM state
   * that a public instance or prototype operation could otherwise own.
   */
  readonly nodeParent: (node: object) => Node | null | undefined;
  readonly nodePreviousSibling: (node: object) => Node | null | undefined;
  readonly nodeNextSibling: (node: object) => Node | null | undefined;
  readonly nodeOwnerDocument: (node: object) => Document | null | undefined;
  readonly nodeIsConnected: (node: object) => boolean | undefined;
  readonly nodeTypeOf: (node: object) => number | undefined;
  readonly buttonIsDisabled: (element: object) => boolean | undefined;
  readonly elementMatches: (element: object, selector: string) => boolean | undefined;
  readonly elementHasAttribute: (element: object, name: string) => boolean | undefined;
  readonly elementAttribute: (element: object, name: string) => string | null | undefined;
  /**
   * Native event and document state, read through the same authenticated getters. The gate uses
   * these instead of a public facts read, whose composed-path copy runs a replaceable iterator.
   */
  readonly eventDefaultPrevented: (event: object) => boolean | undefined;
  readonly eventPhaseOf: (event: object) => number | undefined;
  readonly eventCurrentTarget: (event: object) => EventTarget | null | undefined;
  readonly eventTarget: (event: object) => EventTarget | null | undefined;
  readonly documentActiveElement: (document: object) => Element | null | undefined;
  /**
   * The owner-realm `MutationObserver.prototype.takeRecords`, so the pre-final drain of newly
   * queued mutations cannot be answered by a page-owned instance or prototype method.
   */
  readonly observerTakeRecords: (observer: object) => readonly MutationRecord[] | null;
  readonly observerObserve: (
    observer: object,
    target: Node,
    options: MutationObserverInit,
  ) => boolean;
  readonly observerDisconnect: (observer: object) => void;
}

interface FindActionWindowProof {
  readonly registration: FindActionKeyListener;
  readonly publication: FindBarPublication;
  readonly nativeEvent: object;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly path: readonly EventTarget[];
}

interface FindActionKeyListener {
  readonly proofFor: (
    event: object,
    publication: FindBarPublication,
  ) => FindActionWindowProof | null;
  /**
   * The callback-free half of {@link proofFor}: the registered proof, still unclaimed and never
   * invalidated, read through retained collection intrinsics and without one public facts read.
   */
  readonly holds: (
    proof: FindActionWindowProof,
    publication: FindBarPublication,
  ) => boolean;
  readonly claim: (
    proof: FindActionWindowProof,
    publication: FindBarPublication,
  ) => boolean;
  /**
   * Drops only this listener's exact current, unclaimed proof when capture completed without
   * publishing an action pair. A pending pair and every bubble attempt keep their proof.
   */
  readonly releaseUnclaimed: (
    proof: FindActionWindowProof,
    publication: FindBarPublication,
    nativeEvent: object,
  ) => boolean;
  /**
   * Drops a consumed proof once its pair has been claimed and its delivery has finished. Rejected
   * attempts keep theirs, so the rightful bubble of the same exact native event can still recover.
   */
  readonly finish: (
    proof: FindActionWindowProof,
    publication: FindBarPublication,
  ) => boolean;
  readonly retains: (
    proof: FindActionWindowProof,
    publication: FindBarPublication,
  ) => boolean;
  readonly activate: (publication: FindBarPublication) => boolean;
  readonly release: (publication: FindBarPublication | null) => void;
  readonly isCurrent: () => boolean;
}

interface FindActionRuntimeView {
  readonly intrinsics: FindActionIntrinsics;
  readonly listener: FindActionKeyListener;
  readonly ownerWindow: Window & typeof globalThis;
  readonly ownerDocument: Document;
  readonly root: HTMLDivElement;
  readonly facts: (event: object) => FindNativeKeyboardFacts | null;
  readonly isCurrent: () => boolean;
  /**
   * The callback-free half of {@link isCurrent}: the same bindings proven by descriptor and
   * prototype-chain identity only. No Window accessor is applied, so this — and only this — is what
   * the pre-claim and final gates, and every action intrinsic read they reach, may ask.
   */
  readonly isDescriptorCurrent: () => boolean;
}

interface FindActionReactMethods {
  readonly preventDefault: AnyFunction;
  readonly isDefaultPrevented: AnyFunction;
  readonly isPropagationStopped: AnyFunction;
}

interface FindActionReactSnapshot {
  readonly event: KeyboardEvent<HTMLElement>;
  readonly nativeEvent: object;
  readonly target: EventTarget;
  readonly currentTarget: HTMLElement;
  readonly phase: number;
  readonly view: unknown;
  readonly methods: FindActionReactMethods;
}

interface FindActionMovement {
  readonly identity: symbol;
  readonly key: FindActionKey;
  readonly sourceControl: FindControlPublication;
  readonly destinationControl: FindControlPublication;
  readonly source: HTMLButtonElement;
  readonly destination: HTMLButtonElement;
}

interface FindActionKeyPair {
  readonly publication: FindBarPublication;
  readonly nativeEvent: object;
  readonly facts: FindNativeKeyboardFacts;
  readonly capture: FindActionReactSnapshot;
  readonly proof: FindActionWindowProof;
  readonly movement: FindActionMovement;
  readonly publicationToken: object;
  readonly sourceToken: object;
  readonly destinationToken: object;
  readonly captureToken: object;
  readonly nativeToken: object;
  readonly windowToken: object;
}

interface FindActionKeyDelivery {
  readonly pair: FindActionKeyPair;
  readonly bubble: FindActionReactSnapshot;
}

/** The exact React predicate identities a mutation-capable phase invoked, for the gate to re-read. */
interface FindActionReactPredicateReading {
  readonly snapshot: FindActionReactSnapshot;
  readonly defaultPrevented: boolean;
  readonly isDefaultPrevented: AnyFunction;
  readonly isPropagationStopped: AnyFunction;
}

interface FindActionPredicateReadings {
  readonly capture: FindActionReactPredicateReading;
  readonly bubble: FindActionReactPredicateReading;
}

/** Which callback-free gate is running: the one before the claim, or the one before focus. */
type FindActionGateStage = "pre-claim" | "final";

/**
 * A removable in-progress guard. An attempt that authenticates nothing clears its own guard, so a
 * crossed, malformed, wrong-source, duplicate, throwing, or reentrant attempt can neither consume
 * nor poison the rightful pair waiting for its exact source bubble.
 */
interface FindActionAttempt {
  readonly phase: "capture" | "bubble";
  readonly event: object;
  readonly nativeEvent: object;
}

interface FindActionCommittedEntry {
  readonly control: FindControlPublication;
  readonly owner: ElementOwner<HTMLButtonElement>;
  readonly element: HTMLButtonElement;
}

/** Owner-realm placement, captured and re-read through authenticated intrinsic getters only. */
interface FindActionPlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
  readonly ownerDocument: Document | null;
}

/** What the last mutable publication and DOM queries committed, for the final callback-free gate. */
interface FindActionCommitment {
  readonly runtime: FindBarPublicationRuntime;
  readonly publication: FindBarPublication;
  readonly authority: FindBarAuthority;
  readonly root: HTMLDivElement;
  readonly row: HTMLDivElement;
  readonly actions: readonly FindActionCommittedEntry[];
  readonly places: readonly FindActionPlacement[];
  readonly sourceIndex: number;
  readonly destinationIndex: number;
}

/**
 * The exact identities this publication was created from. The callback-free gate binds the live
 * session and the frozen authority's own slots to this record instead of comparing the frozen copy
 * with itself, so a mutated authority or a swapped published callback has nothing to hide behind.
 */
interface FindActionPublishedIdentities {
  readonly visit: FindBarVisit;
  readonly session: CollabSession;
  readonly find: FindState;
  readonly options: FindOptions;
  readonly matches: readonly FindMatch[];
  readonly methods: FindBarMethods;
  readonly setFind: unknown;
  readonly stepFind: unknown;
  readonly replaceActive: unknown;
  readonly replaceAll: unknown;
  readonly onReplaceVisible: unknown;
  readonly onReveal: unknown;
  readonly onClose: unknown;
  readonly query: string;
  readonly active: number;
  readonly total: number;
  readonly canEdit: boolean;
  readonly replacement: string;
}

/** How committed node state is read: public operations while mutation is still allowed, getters after. */
interface FindActionNodeReader {
  readonly enabled: (element: HTMLButtonElement) => boolean;
  readonly connected: (node: Node) => boolean | undefined;
  readonly ownerDocument: (node: Node) => Document | null | undefined;
  readonly parent: (node: Node) => Node | null | undefined;
}

const FIND_ACTION_PUBLIC_READER: FindActionNodeReader = FIND_ACTION_FREEZE({
  enabled: findActionIsEnabled,
  connected: (node: Node) => node.isConnected,
  ownerDocument: (node: Node) => node.ownerDocument,
  parent: (node: Node) => node.parentNode,
});

function findActionIsIntrinsicallyEnabled(
  element: HTMLButtonElement,
  intrinsics: FindActionIntrinsics,
) {
  if (
    intrinsics.buttonIsDisabled(element) !== false ||
    intrinsics.elementMatches(element, ":disabled") !== false
  ) {
    return false;
  }
  let node: Node | null | undefined = element;
  for (let depth = 0; node && depth < FIND_ACTION_ANCESTOR_LIMIT; depth += 1) {
    const nodeType = intrinsics.nodeTypeOf(node);
    if (nodeType === undefined) return false;
    if (nodeType === FIND_ACTION_ELEMENT_NODE) {
      const hasInert = intrinsics.elementHasAttribute(node, "inert");
      const ariaDisabled = intrinsics.elementAttribute(node, "aria-disabled");
      if (
        hasInert !== false ||
        ariaDisabled === undefined ||
        (ariaDisabled !== null && findActionLowerCase(ariaDisabled) === "true")
      ) {
        return false;
      }
    }
    node = intrinsics.nodeParent(node);
  }
  return node === null;
}

/**
 * The final reader uses only retained owner-realm getters. Full enabled semantics, including
 * `:disabled`, `inert`, and `aria-disabled`, are read through retained methods before the last DOM
 * walk and observer drain; the final gate then binds the button's direct disabled state while the
 * permanent mutation history proves that none of those reflected or ancestor attributes changed.
 */
function findActionFinalReader(
  intrinsics: FindActionIntrinsics,
): FindActionNodeReader {
  return FIND_ACTION_FREEZE({
    enabled: (element: HTMLButtonElement) =>
      intrinsics.buttonIsDisabled(element) === false,
    connected: (node: Node) => intrinsics.nodeIsConnected(node),
    ownerDocument: (node: Node) => intrinsics.nodeOwnerDocument(node),
    parent: (node: Node) => intrinsics.nodeParent(node),
  });
}

function captureFindActionPlacement(
  intrinsics: FindActionIntrinsics,
  node: Node,
): FindActionPlacement | null {
  const parent = intrinsics.nodeParent(node);
  const previousSibling = intrinsics.nodePreviousSibling(node);
  const nextSibling = intrinsics.nodeNextSibling(node);
  const ownerDocument = intrinsics.nodeOwnerDocument(node);
  if (
    !parent ||
    previousSibling === undefined ||
    nextSibling === undefined ||
    ownerDocument === undefined ||
    intrinsics.nodeIsConnected(node) !== true
  ) {
    return null;
  }
  return FIND_ACTION_FREEZE({
    node,
    parent,
    previousSibling,
    nextSibling,
    ownerDocument,
  });
}

function findActionPlacementIsRetained(
  intrinsics: FindActionIntrinsics,
  placement: FindActionPlacement,
) {
  return (
    intrinsics.nodeParent(placement.node) === placement.parent &&
    intrinsics.nodePreviousSibling(placement.node) === placement.previousSibling &&
    intrinsics.nodeNextSibling(placement.node) === placement.nextSibling &&
    intrinsics.nodeOwnerDocument(placement.node) === placement.ownerDocument &&
    intrinsics.nodeIsConnected(placement.node) === true
  );
}

function isFindActionKey(key: string): key is FindActionKey {
  return (
    key === "ArrowLeft" ||
    key === "ArrowUp" ||
    key === "ArrowRight" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End"
  );
}

/** Bounded and never wrapping: an unreachable neighbour or a same-destination Home/End stays inert. */
function findActionDestinationIndex(
  key: FindActionKey,
  index: number,
  length: number,
) {
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return index > 0 ? index - 1 : null;
  }
  if (key === "ArrowRight" || key === "ArrowDown") {
    return index + 1 < length ? index + 1 : null;
  }
  if (key === "Home") return index === 0 ? null : 0;
  return index === length - 1 ? null : length - 1;
}

function findActionIsEnabled(element: HTMLButtonElement) {
  try {
    if (element.disabled || element.matches(":disabled")) return false;
    let node: HTMLElement | null = element;
    for (let depth = 0; node && depth < FIND_ACTION_ANCESTOR_LIMIT; depth += 1) {
      const ariaDisabled = node.getAttribute("aria-disabled");
      if (
        node.hasAttribute("inert") ||
        (
          ariaDisabled !== null &&
          findActionLowerCase(ariaDisabled) === "true"
        )
      ) {
        return false;
      }
      node = node.parentElement;
    }
    return node === null;
  } catch {
    return false;
  }
}

/**
 * Descriptor equality by direct comparison only. Nothing on an authentication path may call a
 * mutable global — `Boolean` above all — so every result here is produced by `===` and `!!`.
 */
function findActionDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  return (
    !!current &&
    current.configurable === expected.configurable &&
    current.enumerable === expected.enumerable &&
    current.get === expected.get &&
    current.set === expected.set &&
    current.value === expected.value &&
    current.writable === expected.writable
  );
}

function captureFindActionPrototypeMember<T>(
  prototype: object | null | undefined,
  property: PropertyKey,
  kind: "method" | "getter",
): FindActionMember<T> | null {
  if (!prototype) return null;
  try {
    const descriptor = FIND_ACTION_OWN_DESCRIPTOR(prototype, property);
    if (!descriptor) return null;
    const value = kind === "method"
      ? ("value" in descriptor ? descriptor.value : undefined)
      : descriptor.get;
    if (typeof value !== "function") return null;
    const expected = FIND_ACTION_FREEZE({ ...descriptor });
    return FIND_ACTION_FREEZE({
      value: value as T,
      isCurrent: () =>
        findActionDescriptorsMatch(
          FIND_ACTION_OWN_DESCRIPTOR(prototype, property),
          expected,
        ),
    });
  } catch {
    return null;
  }
}

interface FindActionChainEntry {
  readonly owner: object;
  readonly descriptor: PropertyDescriptor | null;
  readonly prototype: object | null;
}

interface FindActionChainCapture {
  readonly chain: readonly FindActionChainEntry[];
  readonly holder: object | null;
  readonly descriptor: PropertyDescriptor | null;
}

/**
 * Every own descriptor and prototype link from `target` up to the first holder of `property`,
 * captured once. Re-reading the capture needs only the retained `Object.getOwnPropertyDescriptor`
 * and `Object.getPrototypeOf`, so a Window binding the realm publishes as a configurable accessor
 * can be re-authenticated later without ever invoking its getter or reading the public property.
 */
function captureFindActionOwnChain(
  target: object,
  property: PropertyKey,
): FindActionChainCapture | null {
  try {
    const chain: FindActionChainEntry[] = [];
    let owner: object | null = target;
    let holder: object | null = null;
    let holderDescriptor: PropertyDescriptor | null = null;
    for (let depth = 0; owner && depth < FIND_ACTION_CHAIN_LIMIT; depth += 1) {
      const own = FIND_ACTION_OWN_DESCRIPTOR(owner, property);
      const descriptor = own ? FIND_ACTION_FREEZE({ ...own }) : null;
      const prototype = FIND_ACTION_PROTOTYPE_OF(owner) as object | null;
      chain[chain.length] = FIND_ACTION_FREEZE({ owner, descriptor, prototype });
      if (descriptor) {
        holder = owner;
        holderDescriptor = descriptor;
        break;
      }
      owner = prototype;
    }
    if (owner && !holder) return null;
    return FIND_ACTION_FREEZE({
      chain: FIND_ACTION_FREEZE(chain),
      holder,
      descriptor: holderDescriptor,
    });
  } catch {
    return null;
  }
}

/**
 * The captured chain, re-read by descriptor only: exact owners, exact prototype links, exact flags,
 * and — for a data slot — the exact value. No getter is applied and no property is read, so a
 * stateful accessor installed over a Window binding is rejected without being given control.
 */
function findActionChainIsRetained(
  capture: FindActionChainCapture,
  property: PropertyKey,
) {
  try {
    const chain = capture.chain;
    for (let index = 0; index < chain.length; index += 1) {
      const entry = chain[index];
      if (!entry) return false;
      if (FIND_ACTION_PROTOTYPE_OF(entry.owner) !== entry.prototype) return false;
      const current = FIND_ACTION_OWN_DESCRIPTOR(entry.owner, property);
      if (
        entry.descriptor
          ? !findActionDescriptorsMatch(current, entry.descriptor)
          : current !== undefined
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** The value behind a captured binding, read once at runtime setup and never on the gate path. */
function findActionCapturedValue(
  capture: FindActionChainCapture,
  receiver: object,
): unknown {
  const descriptor = capture.descriptor;
  if (!capture.holder || !descriptor) return undefined;
  if (
    "value" in descriptor &&
    descriptor.get === undefined &&
    descriptor.set === undefined
  ) {
    return descriptor.value as unknown;
  }
  return typeof descriptor.get === "function"
    ? FIND_ACTION_APPLY(
        descriptor.get as (...args: unknown[]) => unknown,
        receiver,
        [],
      )
    : undefined;
}

function captureFindActionWindowMethod<
  Property extends "addEventListener" | "removeEventListener",
>(
  ownerWindow: Window & typeof globalThis,
  property: Property,
): FindActionMember<Window[Property]> | null {
  try {
    const capture = captureFindActionOwnChain(ownerWindow, property);
    if (!capture || !capture.holder || !capture.descriptor) return null;
    // The unit realm publishes the Window's registration methods as own accessors, not data slots,
    // so the value is resolved here, once, at runtime setup. Afterwards only the exact descriptor,
    // its flags, and the prototype-chain identity answer for it: the accessor is never applied
    // again, so no gate or listener check can hand a Window getter control.
    const value = findActionCapturedValue(capture, ownerWindow);
    if (typeof value !== "function") return null;
    const isCurrent = () => findActionChainIsRetained(capture, property);
    return isCurrent()
      ? FIND_ACTION_FREEZE({ value: value as Window[Property], isCurrent })
      : null;
  } catch {
    return null;
  }
}

/** A Window constructor binding, captured once and re-authenticated by descriptor only. */
interface FindActionConstructorBinding {
  readonly value: unknown;
  readonly prototype: object | null;
  readonly present: boolean;
  readonly isCurrent: () => boolean;
}

/**
 * The exact prototype-chain owners, descriptors, and links behind a Window constructor property, the
 * constructor value they resolved to at runtime setup, and that constructor's own `prototype` data
 * descriptor. {@link FindActionConstructorBinding.isCurrent} re-reads all of it through the retained
 * `Object.getOwnPropertyDescriptor` and `Object.getPrototypeOf`, never invoking a configurable
 * Window accessor and never making one public `.prototype` read. An optional constructor the realm
 * does not publish is captured as absent, and the same walk proves it stays absent.
 */
function captureFindActionWindowConstructor(
  ownerWindow: Window & typeof globalThis,
  property: PropertyKey,
  optional = false,
): FindActionConstructorBinding | null {
  try {
    const capture = captureFindActionOwnChain(ownerWindow, property);
    if (!capture) return null;
    const chainIsRetained = () => findActionChainIsRetained(capture, property);
    if (!capture.holder || !capture.descriptor) {
      return optional && chainIsRetained()
        ? FIND_ACTION_FREEZE({
            value: undefined,
            prototype: null,
            present: false,
            isCurrent: chainIsRetained,
          })
        : null;
    }
    const value = findActionCapturedValue(capture, ownerWindow);
    if (typeof value !== "function") return null;
    const constructorValue = value as object;
    const own = FIND_ACTION_OWN_DESCRIPTOR(constructorValue, "prototype");
    if (
      !own ||
      !("value" in own) ||
      own.get !== undefined ||
      own.set !== undefined ||
      !own.value ||
      typeof own.value !== "object"
    ) {
      return null;
    }
    const prototype = own.value as object;
    const expected = FIND_ACTION_FREEZE({ ...own });
    const isCurrent = () => {
      try {
        return (
          chainIsRetained() &&
          expected.value === prototype &&
          findActionDescriptorsMatch(
            FIND_ACTION_OWN_DESCRIPTOR(constructorValue, "prototype"),
            expected,
          )
        );
      } catch {
        return false;
      }
    };
    return isCurrent()
      ? FIND_ACTION_FREEZE({ value, prototype, present: true, isCurrent })
      : null;
  } catch {
    return null;
  }
}

/**
 * The retained keyboard-trust bindings, re-authenticated locally and by descriptor only.
 *
 * The shared `trustedFindKeyboardIntrinsics` walk resolves an accessor-backed Window constructor by
 * *applying* its captured getter, which hands page code control on an authentication path. The
 * callback-free gates therefore never call it: they call {@link FindKeyboardDescriptorProof.isCurrent},
 * which proves the exact same bindings through `Object.getOwnPropertyDescriptor` and
 * `Object.getPrototypeOf` alone — exact chain owners and prototype links, exact descriptor kind,
 * getter, setter and flags, and the constructor's own `prototype` data descriptor identity — without
 * ever invoking a Window getter or making one public property read.
 */
type FindKeyboardConstructorBinding = FindKeyboardIntrinsics["event"];
type FindKeyboardMemberBinding = FindKeyboardIntrinsics["members"][number];

interface FindKeyboardDescriptorProof {
  readonly intrinsics: FindKeyboardIntrinsics;
  readonly view: Window;
  readonly isCurrent: () => boolean;
}

function findKeyboardConstructorIsDescriptorCurrent(
  binding: FindKeyboardConstructorBinding,
  view: Window,
) {
  try {
    const chain = binding.chain;
    if (chain.length === 0 || chain[0] !== view) return false;
    for (let index = 0; index < chain.length; index += 1) {
      const owner = chain[index];
      if (!owner) return false;
      const descriptor = FIND_ACTION_OWN_DESCRIPTOR(owner, binding.name);
      if (index < chain.length - 1) {
        // Nothing may shadow the binding below its captured holder, and the link must be exact.
        if (descriptor !== undefined) return false;
        if (FIND_ACTION_PROTOTYPE_OF(owner) !== chain[index + 1]) return false;
        continue;
      }
      if (!descriptor) return false;
      if (binding.getter) {
        // The captured accessor is compared by identity and never applied.
        if (
          "value" in descriptor ||
          descriptor.get !== binding.getter ||
          descriptor.set !== binding.setter
        ) {
          return false;
        }
      } else if (
        !("value" in descriptor) ||
        descriptor.value !== binding.value ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        binding.setter !== undefined
      ) {
        return false;
      }
      if (
        descriptor.writable !== binding.writable ||
        descriptor.enumerable !== binding.enumerable ||
        descriptor.configurable !== binding.configurable
      ) {
        return false;
      }
    }
    const own = FIND_ACTION_OWN_DESCRIPTOR(binding.value, "prototype");
    return (
      !!own &&
      "value" in own &&
      own.get === undefined &&
      own.set === undefined &&
      own.value === binding.prototype &&
      own.writable === binding.prototypeWritable &&
      own.enumerable === binding.prototypeEnumerable &&
      own.configurable === binding.prototypeConfigurable &&
      FIND_ACTION_PROTOTYPE_OF(binding.prototype) === binding.prototypeParent
    );
  } catch {
    return false;
  }
}

function findKeyboardMemberIsDescriptorCurrent(binding: FindKeyboardMemberBinding) {
  try {
    const descriptor = FIND_ACTION_OWN_DESCRIPTOR(binding.owner, binding.name);
    if (!descriptor) return false;
    if (binding.kind === "getter") {
      if (
        "value" in descriptor ||
        descriptor.get !== binding.intrinsic ||
        descriptor.set !== binding.setter
      ) {
        return false;
      }
    } else if (
      !("value" in descriptor) ||
      descriptor.value !== binding.intrinsic ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return false;
    }
    return (
      descriptor.writable === binding.writable &&
      descriptor.enumerable === binding.enumerable &&
      descriptor.configurable === binding.configurable
    );
  } catch {
    return false;
  }
}

function captureFindKeyboardDescriptorProof(
  intrinsics: FindKeyboardIntrinsics,
  view: Window,
): FindKeyboardDescriptorProof | null {
  try {
    const constructors: readonly FindKeyboardConstructorBinding[] = FIND_ACTION_FREEZE([
      intrinsics.event,
      intrinsics.uiEvent,
      intrinsics.keyboardEvent,
      intrinsics.node,
      intrinsics.document,
    ]);
    const members = intrinsics.members;
    const isCurrent = () => {
      try {
        if (intrinsics.view !== view) return false;
        for (let index = 0; index < constructors.length; index += 1) {
          const binding = constructors[index];
          if (!binding || !findKeyboardConstructorIsDescriptorCurrent(binding, view)) {
            return false;
          }
        }
        for (let index = 0; index < members.length; index += 1) {
          const member = members[index];
          if (!member || !findKeyboardMemberIsDescriptorCurrent(member)) return false;
        }
        return true;
      } catch {
        return false;
      }
    };
    return isCurrent()
      ? FIND_ACTION_FREEZE({ intrinsics, view, isCurrent })
      : null;
  } catch {
    return null;
  }
}

function captureFindActionIntrinsics(view: Window): FindActionIntrinsics | null {
  try {
    const ownerWindow = view as Window & typeof globalThis;
    // Every Window constructor is bound once, here, through its exact prototype-chain descriptors.
    // Nothing below — and nothing the gate, the listener, or an intrinsic getter runs afterwards —
    // reads `ownerWindow.HTMLElement` and friends again, so a configurable Window accessor never
    // gets control on an authentication path.
    const htmlElementBinding = captureFindActionWindowConstructor(
      ownerWindow,
      "HTMLElement",
    );
    const elementBinding = captureFindActionWindowConstructor(ownerWindow, "Element");
    const eventBinding = captureFindActionWindowConstructor(ownerWindow, "Event");
    const nodeBinding = captureFindActionWindowConstructor(ownerWindow, "Node");
    const documentBinding = captureFindActionWindowConstructor(ownerWindow, "Document");
    const buttonBinding = captureFindActionWindowConstructor(
      ownerWindow,
      "HTMLButtonElement",
    );
    const observerBinding = captureFindActionWindowConstructor(
      ownerWindow,
      "MutationObserver",
    );
    // The realm need not publish `MutationRecord`; when it does, the readers the relevance test uses
    // are authenticated with everything else, so a patched record getter fails the drain too.
    const recordBinding = captureFindActionWindowConstructor(
      ownerWindow,
      "MutationRecord",
      true,
    );
    if (
      !htmlElementBinding ||
      !elementBinding ||
      !eventBinding ||
      !nodeBinding ||
      !documentBinding ||
      !buttonBinding ||
      !observerBinding ||
      !recordBinding
    ) {
      return null;
    }
    const nodeConstructor = nodeBinding.value as typeof Node;
    const htmlElementPrototype = htmlElementBinding.prototype;
    const elementPrototype = elementBinding.prototype;
    const eventPrototype = eventBinding.prototype;
    const nodePrototype = nodeBinding.prototype;
    const documentPrototype = documentBinding.prototype;
    const buttonPrototype = buttonBinding.prototype;
    const observerPrototype = observerBinding.prototype;
    const recordPrototype: object | null = recordBinding.present
      ? recordBinding.prototype
      : null;
    const recordProperties: readonly string[] = recordPrototype
      ? ["type", "target", "attributeName", "addedNodes", "removedNodes"]
      : [];
    const recordReaders: (FindActionMember<AnyFunction> | null)[] = [];
    for (let index = 0; index < recordProperties.length; index += 1) {
      const property = recordProperties[index];
      recordReaders[index] = property === undefined
        ? null
        : captureFindActionPrototypeMember<AnyFunction>(
            recordPrototype,
            property,
            "getter",
          );
    }
    let recordReadersAreExact = true;
    for (let index = 0; index < recordReaders.length; index += 1) {
      if (!recordReaders[index]) recordReadersAreExact = false;
    }
    const focus = captureFindActionPrototypeMember<AnyFunction>(
      htmlElementPrototype,
      "focus",
      "method",
    );
    const cancelBubble = captureFindActionPrototypeMember<AnyFunction>(
      eventPrototype,
      "cancelBubble",
      "getter",
    );
    const parentNode = captureFindActionPrototypeMember<AnyFunction>(
      nodePrototype,
      "parentNode",
      "getter",
    );
    const previousSibling = captureFindActionPrototypeMember<AnyFunction>(
      nodePrototype,
      "previousSibling",
      "getter",
    );
    const nextSibling = captureFindActionPrototypeMember<AnyFunction>(
      nodePrototype,
      "nextSibling",
      "getter",
    );
    const ownerDocument = captureFindActionPrototypeMember<AnyFunction>(
      nodePrototype,
      "ownerDocument",
      "getter",
    );
    const isConnected = captureFindActionPrototypeMember<AnyFunction>(
      nodePrototype,
      "isConnected",
      "getter",
    );
    const nodeType = captureFindActionPrototypeMember<AnyFunction>(
      nodePrototype,
      "nodeType",
      "getter",
    );
    const disabled = captureFindActionPrototypeMember<AnyFunction>(
      buttonPrototype,
      "disabled",
      "getter",
    );
    const matches = captureFindActionPrototypeMember<AnyFunction>(
      elementPrototype,
      "matches",
      "method",
    );
    const hasAttribute = captureFindActionPrototypeMember<AnyFunction>(
      elementPrototype,
      "hasAttribute",
      "method",
    );
    const getAttribute = captureFindActionPrototypeMember<AnyFunction>(
      elementPrototype,
      "getAttribute",
      "method",
    );
    const observe = captureFindActionPrototypeMember<AnyFunction>(
      observerPrototype,
      "observe",
      "method",
    );
    const disconnect = captureFindActionPrototypeMember<AnyFunction>(
      observerPrototype,
      "disconnect",
      "method",
    );
    const takeRecords = captureFindActionPrototypeMember<AnyFunction>(
      observerPrototype,
      "takeRecords",
      "method",
    );
    const defaultPrevented = captureFindActionPrototypeMember<AnyFunction>(
      eventPrototype,
      "defaultPrevented",
      "getter",
    );
    const eventPhase = captureFindActionPrototypeMember<AnyFunction>(
      eventPrototype,
      "eventPhase",
      "getter",
    );
    const currentTarget = captureFindActionPrototypeMember<AnyFunction>(
      eventPrototype,
      "currentTarget",
      "getter",
    );
    const eventTarget = captureFindActionPrototypeMember<AnyFunction>(
      eventPrototype,
      "target",
      "getter",
    );
    const activeElement = captureFindActionPrototypeMember<AnyFunction>(
      documentPrototype,
      "activeElement",
      "getter",
    );
    const addEventListener = captureFindActionWindowMethod(
      ownerWindow,
      "addEventListener",
    );
    const removeEventListener = captureFindActionWindowMethod(
      ownerWindow,
      "removeEventListener",
    );
    if (
      !focus ||
      !cancelBubble ||
      !parentNode ||
      !previousSibling ||
      !nextSibling ||
      !ownerDocument ||
      !isConnected ||
      !nodeType ||
      !disabled ||
      !matches ||
      !hasAttribute ||
      !getAttribute ||
      !observe ||
      !disconnect ||
      !takeRecords ||
      !defaultPrevented ||
      !eventPhase ||
      !currentTarget ||
      !eventTarget ||
      !activeElement ||
      !recordReadersAreExact ||
      !addEventListener ||
      !removeEventListener
    ) {
      return null;
    }
    const recordReadersAreCurrent = () => {
      for (let index = 0; index < recordReaders.length; index += 1) {
        if (recordReaders[index]?.isCurrent() !== true) return false;
      }
      return true;
    };
    const isCurrent = () => {
      try {
        return (
          // Descriptor and prototype-chain identity only: no Window property is read, no Window
          // accessor is applied, and no constructor's public `.prototype` is consulted.
          htmlElementBinding.isCurrent() &&
          elementBinding.isCurrent() &&
          eventBinding.isCurrent() &&
          nodeBinding.isCurrent() &&
          documentBinding.isCurrent() &&
          buttonBinding.isCurrent() &&
          observerBinding.isCurrent() &&
          recordBinding.isCurrent() &&
          focus.isCurrent() &&
          cancelBubble.isCurrent() &&
          parentNode.isCurrent() &&
          previousSibling.isCurrent() &&
          nextSibling.isCurrent() &&
          ownerDocument.isCurrent() &&
          isConnected.isCurrent() &&
          nodeType.isCurrent() &&
          disabled.isCurrent() &&
          matches.isCurrent() &&
          hasAttribute.isCurrent() &&
          getAttribute.isCurrent() &&
          observe.isCurrent() &&
          disconnect.isCurrent() &&
          takeRecords.isCurrent() &&
          defaultPrevented.isCurrent() &&
          eventPhase.isCurrent() &&
          currentTarget.isCurrent() &&
          eventTarget.isCurrent() &&
          activeElement.isCurrent() &&
          recordReadersAreCurrent() &&
          addEventListener.isCurrent() &&
          removeEventListener.isCurrent()
        );
      } catch {
        return false;
      }
    };
    const readGetter = (member: FindActionMember<AnyFunction>, receiver: object) => {
      if (!isCurrent()) return FIND_ACTION_UNREADABLE;
      try {
        return FIND_ACTION_APPLY(
          member.value as (...args: unknown[]) => unknown,
          receiver,
          [],
        );
      } catch {
        return FIND_ACTION_UNREADABLE;
      }
    };
    const readNode = (member: FindActionMember<AnyFunction>, node: object) => {
      const value = readGetter(member, node);
      if (value === FIND_ACTION_UNREADABLE) return undefined;
      return (value ?? null) as Node | null;
    };
    const readBoolean = (member: FindActionMember<AnyFunction>, node: object) => {
      const value = readGetter(member, node);
      return typeof value === "boolean" ? value : undefined;
    };
    const readNumber = (member: FindActionMember<AnyFunction>, node: object) => {
      const value = readGetter(member, node);
      return typeof value === "number" ? value : undefined;
    };
    const callMember = (
      member: FindActionMember<AnyFunction>,
      receiver: object,
      args: readonly unknown[],
    ) => {
      if (!isCurrent()) return FIND_ACTION_UNREADABLE;
      try {
        return FIND_ACTION_APPLY(
          member.value as (...args: unknown[]) => unknown,
          receiver,
          args,
        );
      } catch {
        return FIND_ACTION_UNREADABLE;
      }
    };
    const readTarget = (member: FindActionMember<AnyFunction>, receiver: object) => {
      const value = readGetter(member, receiver);
      if (value === FIND_ACTION_UNREADABLE) return undefined;
      return (value ?? null) as EventTarget | null;
    };
    const ownValue = (value: object, property: PropertyKey) => {
      if (!isCurrent()) return FIND_ACTION_UNREADABLE;
      try {
        let owner: object | null = value;
        for (
          let depth = 0;
          owner && depth < FIND_ACTION_CHAIN_LIMIT;
          depth += 1
        ) {
          const descriptor = FIND_ACTION_OWN_DESCRIPTOR(owner, property);
          if (descriptor) {
            return "value" in descriptor
              ? (descriptor.value as unknown)
              : FIND_ACTION_UNREADABLE;
          }
          owner = FIND_ACTION_PROTOTYPE_OF(owner) as object | null;
        }
        return FIND_ACTION_UNREADABLE;
      } catch {
        return FIND_ACTION_UNREADABLE;
      }
    };
    return FIND_ACTION_FREEZE({
      ownerWindow,
      nodeConstructor,
      mutationObserverConstructor: observerBinding.value as typeof MutationObserver,
      addEventListener,
      removeEventListener,
      isCurrent,
      methodMatches: (value: object, property: PropertyKey, method: unknown) => {
        if (!isCurrent() || typeof method !== "function") return false;
        return ownValue(value, property) === method;
      },
      ownValue,
      read: (method: AnyFunction, receiver: object) => {
        if (!isCurrent()) return undefined;
        try {
          return FIND_ACTION_APPLY(
            method as (...args: unknown[]) => unknown,
            receiver,
            [],
          );
        } catch {
          return undefined;
        }
      },
      invoke: (method: AnyFunction, receiver: object) => {
        if (!isCurrent()) return false;
        try {
          FIND_ACTION_APPLY(
            method as (...args: unknown[]) => unknown,
            receiver,
            [],
          );
          return true;
        } catch {
          return false;
        }
      },
      propagationStopped: (event: object) => {
        if (!isCurrent()) return true;
        try {
          return FIND_ACTION_APPLY(
            cancelBubble.value as (...args: unknown[]) => unknown,
            event,
            [],
          ) === true;
        } catch {
          return true;
        }
      },
      focusMethod: focus.value,
      nodeParent: (node: object) => readNode(parentNode, node),
      nodePreviousSibling: (node: object) => readNode(previousSibling, node),
      nodeNextSibling: (node: object) => readNode(nextSibling, node),
      nodeOwnerDocument: (node: object) =>
        readNode(ownerDocument, node) as Document | null | undefined,
      nodeIsConnected: (node: object) => readBoolean(isConnected, node),
      nodeTypeOf: (node: object) => readNumber(nodeType, node),
      buttonIsDisabled: (element: object) => readBoolean(disabled, element),
      elementMatches: (element: object, selector: string) => {
        const value = callMember(matches, element, [selector]);
        return typeof value === "boolean" ? value : undefined;
      },
      elementHasAttribute: (element: object, name: string) => {
        const value = callMember(hasAttribute, element, [name]);
        return typeof value === "boolean" ? value : undefined;
      },
      elementAttribute: (element: object, name: string) => {
        const value = callMember(getAttribute, element, [name]);
        return typeof value === "string" || value === null ? value : undefined;
      },
      eventDefaultPrevented: (event: object) => readBoolean(defaultPrevented, event),
      eventPhaseOf: (event: object) => {
        const value = readGetter(eventPhase, event);
        return typeof value === "number" ? value : undefined;
      },
      eventCurrentTarget: (event: object) => readTarget(currentTarget, event),
      eventTarget: (event: object) => readTarget(eventTarget, event),
      documentActiveElement: (document: object) =>
        readTarget(activeElement, document) as Element | null | undefined,
      observerTakeRecords: (observer: object) => {
        if (!isCurrent()) return null;
        try {
          const records = FIND_ACTION_APPLY(
            takeRecords.value as (...args: unknown[]) => unknown,
            observer,
            [],
          );
          return FIND_ACTION_IS_ARRAY(records)
            ? (records as readonly MutationRecord[])
            : null;
        } catch {
          return null;
        }
      },
      observerObserve: (
        observer: object,
        target: Node,
        options: MutationObserverInit,
      ) =>
        callMember(observe, observer, [target, options]) !== FIND_ACTION_UNREADABLE,
      observerDisconnect: (observer: object) => {
        try {
          FIND_ACTION_APPLY(
            disconnect.value as (...args: unknown[]) => unknown,
            observer,
            [],
          );
        } catch {
          return;
        }
      },
    });
  } catch {
    return null;
  }
}

/**
 * An ordinary function keeps the Window's own event-local receiver (`this`), which every delivery
 * compares with the intrinsic current target and the original composed-path terminal.
 */
function createFindActionKeyListener(
  intrinsics: FindActionIntrinsics,
  ownerDocument: Document,
  readFacts: (event: object) => FindNativeKeyboardFacts | null,
  actionPairIsAbsent: (event: object, publication: FindBarPublication) => boolean,
): FindActionKeyListener {
  const proofs = new WeakMap<object, FindActionWindowProof>();
  /**
   * Every native-event key this listener still has in {@link proofs}. The WeakMap alone keeps a
   * retired publication reachable for as long as the native event lives, so the keys are tracked
   * here through retained collection intrinsics and dropped with their entries at `finish` and,
   * unconditionally, at `release`.
   */
  const proofKeys = findActionNewSet<object>();
  const invalidEvents = new WeakSet<object>();
  const claimedEvents = new WeakSet<object>();
  let publication: FindBarPublication | null = null;
  let active = false;
  let released = false;
  let claiming = false;
  let releasing = false;

  const forgetProof = (nativeEvent: object) => {
    findActionWeakDelete(proofs, nativeEvent);
    findActionSetDelete(proofKeys, nativeEvent);
  };

  const forgetEveryProof = () => {
    findActionSetForEach(proofKeys, (nativeEvent) => {
      findActionWeakDelete(proofs, nativeEvent);
    });
    findActionSetClear(proofKeys);
  };

  const listener = function (this: EventTarget, event: Event) {
    const current = publication;
    if (
      !current ||
      !active ||
      released ||
      !intrinsics.isCurrent() ||
      findActionTokenIsClaimed(invalidEvents, event)
    ) {
      return;
    }
    // A consumed native event never gets a second proof, so a replay cannot re-retain a publication
    // whose proof `finish` already dropped.
    if (
      findActionWeakHas(proofs, event) ||
      findActionTokenIsClaimed(claimedEvents, event)
    ) {
      findActionClaimToken(invalidEvents, event);
      return;
    }
    const facts = readFacts(event);
    const terminal = facts ? facts.path[facts.path.length - 1] : null;
    const currentTarget = facts ? facts.currentTarget : null;
    if (
      !facts ||
      !terminal ||
      !currentTarget ||
      facts.type !== "keydown" ||
      currentTarget !== this ||
      terminal !== this ||
      facts.eventPhase !== FIND_ACTION_CAPTURING_PHASE ||
      facts.path[facts.path.length - 2] !== ownerDocument
    ) {
      findActionClaimToken(invalidEvents, event);
      return;
    }
    findActionSetAdd(proofKeys, event);
    findActionWeakSet(
      proofs,
      event,
      FIND_ACTION_FREEZE({
        registration,
        publication: current,
        nativeEvent: event,
        receiver: this,
        currentTarget,
        terminal,
        path: facts.path,
      }),
    );
  };

  const proofFor = (event: object, current: FindBarPublication) => {
    const proof = findActionWeakGet(proofs, event);
    if (
      !proof ||
      !active ||
      released ||
      publication !== current ||
      proof.registration !== registration ||
      proof.publication !== current ||
      proof.nativeEvent !== event ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      findActionTokenIsClaimed(claimedEvents, event) ||
      findActionTokenIsClaimed(invalidEvents, event) ||
      !intrinsics.isCurrent()
    ) {
      return null;
    }
    const facts = readFacts(event);
    if (!facts || facts.path.length !== proof.path.length) return null;
    for (let index = 0; index < facts.path.length; index += 1) {
      if (facts.path[index] !== proof.path[index]) return null;
    }
    return facts.path[facts.path.length - 2] === ownerDocument &&
      facts.path[facts.path.length - 1] === proof.receiver
      ? proof
      : null;
  };

  /** No facts read, no prototype lookup: what the gate can ask once mutation is no longer allowed. */
  const holds = (proof: FindActionWindowProof, current: FindBarPublication) =>
    publication === current &&
    proof.registration === registration &&
    proof.publication === current &&
    findActionWeakGet(proofs, proof.nativeEvent) === proof &&
    !findActionTokenIsClaimed(claimedEvents, proof.nativeEvent) &&
    !findActionTokenIsClaimed(invalidEvents, proof.nativeEvent) &&
    proof.receiver === proof.currentTarget &&
    proof.receiver === proof.terminal &&
    active &&
    !released &&
    intrinsics.isCurrent();

  const registration: FindActionKeyListener = FIND_ACTION_FREEZE({
    proofFor,
    holds,
    claim: (proof: FindActionWindowProof, current: FindBarPublication) => {
      // Callback-free and non-reentrant: the full facts and proof authentication already ran in the
      // mutation-capable phase, so the boundary only confirms the still-unclaimed retained state
      // through {@link holds} — before it changes anything — and then marks it through the retained
      // `WeakSet.prototype.add`. No public facts read, no prototype lookup, and no page code can run
      // between the two, and a reentrant claim is refused outright.
      if (claiming) return false;
      claiming = true;
      try {
        if (!holds(proof, current)) return false;
        findActionClaimToken(claimedEvents, proof.nativeEvent);
        return true;
      } finally {
        claiming = false;
      }
    },
    releaseUnclaimed: (
      proof: FindActionWindowProof,
      current: FindBarPublication,
      nativeEvent: object,
    ) => {
      if (claiming || releasing) return false;
      releasing = true;
      try {
        if (
          proof.registration !== registration ||
          proof.publication !== current ||
          proof.nativeEvent !== nativeEvent ||
          publication !== current ||
          findActionWeakGet(proofs, nativeEvent) !== proof ||
          findActionTokenIsClaimed(claimedEvents, nativeEvent) ||
          findActionTokenIsClaimed(invalidEvents, nativeEvent) ||
          !active ||
          released ||
          !intrinsics.isCurrent() ||
          !actionPairIsAbsent(nativeEvent, current)
        ) {
          return false;
        }
        forgetProof(nativeEvent);
        return true;
      } finally {
        releasing = false;
      }
    },
    finish: (proof: FindActionWindowProof, current: FindBarPublication) => {
      // Only a proof whose native event was actually claimed is dropped: a rejected attempt leaves
      // the registration exactly where the rightful bubble of the same native event expects it.
      if (
        proof.registration !== registration ||
        proof.publication !== current ||
        publication !== current ||
        findActionWeakGet(proofs, proof.nativeEvent) !== proof ||
        !findActionTokenIsClaimed(claimedEvents, proof.nativeEvent)
      ) {
        return false;
      }
      forgetProof(proof.nativeEvent);
      return true;
    },
    retains: (proof: FindActionWindowProof, current: FindBarPublication) =>
      publication === current &&
      proof.publication === current &&
      findActionWeakGet(proofs, proof.nativeEvent) === proof &&
      findActionTokenIsClaimed(claimedEvents, proof.nativeEvent) &&
      !findActionTokenIsClaimed(invalidEvents, proof.nativeEvent) &&
      proof.receiver === proof.currentTarget &&
      proof.receiver === proof.terminal &&
      active &&
      !released &&
      intrinsics.isCurrent(),
    activate: (current: FindBarPublication) => {
      if (publication || active || released || !intrinsics.isCurrent()) {
        return false;
      }
      publication = current;
      active = true;
      try {
        FIND_ACTION_APPLY(
          intrinsics.addEventListener.value as (...args: unknown[]) => unknown,
          intrinsics.ownerWindow,
          ["keydown", listener, true],
        );
      } catch {
        publication = null;
        active = false;
        return false;
      }
      if (registration.isCurrent()) return true;
      publication = null;
      active = false;
      try {
        FIND_ACTION_APPLY(
          intrinsics.removeEventListener.value as (...args: unknown[]) => unknown,
          intrinsics.ownerWindow,
          ["keydown", listener, true],
        );
      } catch {
        return false;
      }
      return false;
    },
    release: (current: FindBarPublication | null) => {
      if (!current || publication !== current || released) return;
      released = true;
      const wasActive = active;
      active = false;
      // Mandatory cleanup: every proof this listener ever registered is dropped here, through
      // retained collection intrinsics, so a live native event or a stale handler cannot keep a
      // retired publication's work reachable through the map.
      forgetEveryProof();
      if (!wasActive) return;
      try {
        FIND_ACTION_APPLY(
          intrinsics.removeEventListener.value as (...args: unknown[]) => unknown,
          intrinsics.ownerWindow,
          ["keydown", listener, true],
        );
      } catch {
        return;
      }
    },
    isCurrent: () =>
      active && !released && publication !== null && intrinsics.isCurrent(),
  });
  return registration;
}

/** Only an absent view is free; any published view must be the exact owner Window or its receiver. */
function findActionViewIsOwned(
  view: unknown,
  nav: FindActionRuntimeView,
  proof: FindActionWindowProof,
) {
  return (
    view === null ||
    FIND_ACTION_IS(view, nav.ownerWindow) ||
    FIND_ACTION_IS(view, proof.receiver)
  );
}

function captureFindActionReactKey(
  event: KeyboardEvent<HTMLElement>,
  nav: FindActionRuntimeView,
  facts: FindNativeKeyboardFacts,
  nativeEvent: object,
  currentTarget: HTMLElement,
  proof: FindActionWindowProof,
): FindActionReactSnapshot | null {
  const intrinsics = nav.intrinsics;
  try {
    const preventDefault = event.preventDefault as unknown;
    const isDefaultPrevented = event.isDefaultPrevented as unknown;
    const isPropagationStopped = event.isPropagationStopped as unknown;
    const view = event.view as unknown;
    if (
      typeof preventDefault !== "function" ||
      typeof isDefaultPrevented !== "function" ||
      typeof isPropagationStopped !== "function" ||
      !intrinsics.methodMatches(event, "preventDefault", preventDefault) ||
      !intrinsics.methodMatches(event, "isDefaultPrevented", isDefaultPrevented) ||
      !intrinsics.methodMatches(
        event,
        "isPropagationStopped",
        isPropagationStopped,
      ) ||
      intrinsics.read(isDefaultPrevented as AnyFunction, event) !== false ||
      intrinsics.read(isPropagationStopped as AnyFunction, event) !== false ||
      (event as unknown) === nativeEvent ||
      (event.nativeEvent as unknown) !== nativeEvent ||
      event.type !== facts.type ||
      (event.target as unknown) !== facts.target ||
      (event.currentTarget as unknown) !== currentTarget ||
      event.eventPhase !== facts.eventPhase ||
      event.bubbles !== facts.bubbles ||
      event.cancelable !== facts.cancelable ||
      event.defaultPrevented !== facts.defaultPrevented ||
      event.key !== facts.key ||
      event.code !== facts.code ||
      event.location !== facts.location ||
      event.altKey !== facts.altKey ||
      event.ctrlKey !== facts.ctrlKey ||
      event.metaKey !== facts.metaKey ||
      event.shiftKey !== facts.shiftKey ||
      event.repeat !== facts.repeat ||
      !findActionViewIsOwned(view, nav, proof)
    ) {
      return null;
    }
    return FIND_ACTION_FREEZE({
      event,
      nativeEvent,
      target: facts.target as EventTarget,
      currentTarget,
      phase: facts.eventPhase,
      view,
      methods: FIND_ACTION_FREEZE({
        preventDefault: preventDefault as AnyFunction,
        isDefaultPrevented: isDefaultPrevented as AnyFunction,
        isPropagationStopped: isPropagationStopped as AnyFunction,
      }),
    });
  } catch {
    return null;
  }
}

function findActionReactRemainsExact(
  snapshot: FindActionReactSnapshot,
  nav: FindActionRuntimeView,
  facts: FindNativeKeyboardFacts,
  proof: FindActionWindowProof,
  currentTarget: HTMLElement | null,
  defaultPrevented = false,
) {
  const intrinsics = nav.intrinsics;
  try {
    const event = snapshot.event;
    const methods = snapshot.methods;
    const currentIsDefaultPrevented = event.isDefaultPrevented as unknown;
    return (
      (event.nativeEvent as unknown) === snapshot.nativeEvent &&
      event.type === facts.type &&
      (event.target as unknown) === snapshot.target &&
      (event.target as unknown) === facts.target &&
      (event.currentTarget as unknown) === currentTarget &&
      event.eventPhase === snapshot.phase &&
      event.eventPhase === facts.eventPhase &&
      event.bubbles === facts.bubbles &&
      event.cancelable === facts.cancelable &&
      event.defaultPrevented === defaultPrevented &&
      event.key === facts.key &&
      event.code === facts.code &&
      event.location === facts.location &&
      event.altKey === facts.altKey &&
      event.ctrlKey === facts.ctrlKey &&
      event.metaKey === facts.metaKey &&
      event.shiftKey === facts.shiftKey &&
      event.repeat === facts.repeat &&
      FIND_ACTION_IS(event.view as unknown, snapshot.view) &&
      findActionViewIsOwned(event.view as unknown, nav, proof) &&
      (event.preventDefault as unknown) === methods.preventDefault &&
      (event.isPropagationStopped as unknown) === methods.isPropagationStopped &&
      intrinsics.methodMatches(event, "preventDefault", methods.preventDefault) &&
      intrinsics.methodMatches(
        event,
        "isPropagationStopped",
        methods.isPropagationStopped,
      ) &&
      typeof currentIsDefaultPrevented === "function" &&
      intrinsics.methodMatches(
        event,
        "isDefaultPrevented",
        currentIsDefaultPrevented,
      ) &&
      (defaultPrevented
        ? intrinsics.read(currentIsDefaultPrevented as AnyFunction, event) === true
        : currentIsDefaultPrevented === methods.isDefaultPrevented &&
          intrinsics.read(methods.isDefaultPrevented, event) === false) &&
      intrinsics.read(methods.isPropagationStopped, event) === false
    );
  } catch {
    return false;
  }
}

/**
 * The one place either authenticated React predicate is invoked. Both predicates can hand control to
 * page code, so every wrapper reading happens here, in the mutation-capable phase, and the exact
 * invoked identities are frozen for the callback-free gate to re-read by descriptor afterwards.
 */
function readFindActionReactPredicates(
  snapshot: FindActionReactSnapshot,
  nav: FindActionRuntimeView,
  defaultPrevented: boolean,
): FindActionReactPredicateReading | null {
  const intrinsics = nav.intrinsics;
  try {
    const event = snapshot.event as unknown as object;
    const methods = snapshot.methods;
    const isDefaultPrevented = intrinsics.ownValue(event, "isDefaultPrevented");
    const isPropagationStopped = intrinsics.ownValue(event, "isPropagationStopped");
    if (
      typeof isDefaultPrevented !== "function" ||
      isPropagationStopped !== methods.isPropagationStopped ||
      (!defaultPrevented && isDefaultPrevented !== methods.isDefaultPrevented) ||
      intrinsics.read(isDefaultPrevented as AnyFunction, event) !== defaultPrevented ||
      intrinsics.read(methods.isPropagationStopped, event) !== false
    ) {
      return null;
    }
    return FIND_ACTION_FREEZE({
      snapshot,
      defaultPrevented,
      isDefaultPrevented: isDefaultPrevented as AnyFunction,
      isPropagationStopped: methods.isPropagationStopped,
    });
  } catch {
    return null;
  }
}

/**
 * The callback-free wrapper authentication. Every React property is read from its own data
 * descriptor through the authenticated intrinsic, so neither an overridable accessor nor a React
 * predicate can run here: the two predicates were already invoked by
 * {@link readFindActionReactPredicates}, and the identities they resolved to are re-read by
 * descriptor now, after all predicate calls, so a predicate that replaced its own or the other
 * phase's retained method while returning the accepted boolean no longer escapes revalidation.
 */
function findActionReactIsFinal(
  snapshot: FindActionReactSnapshot,
  nav: FindActionRuntimeView,
  facts: FindNativeKeyboardFacts,
  proof: FindActionWindowProof,
  currentTarget: HTMLElement | null,
  defaultPrevented: boolean,
  reading: FindActionReactPredicateReading | null,
) {
  const intrinsics = nav.intrinsics;
  try {
    const event = snapshot.event as unknown as object;
    const methods = snapshot.methods;
    const read = (property: PropertyKey) => intrinsics.ownValue(event, property);
    return (
      !!reading &&
      reading.snapshot === snapshot &&
      reading.defaultPrevented === defaultPrevented &&
      reading.isPropagationStopped === methods.isPropagationStopped &&
      (defaultPrevented || reading.isDefaultPrevented === methods.isDefaultPrevented) &&
      read("isDefaultPrevented") === reading.isDefaultPrevented &&
      read("isPropagationStopped") === reading.isPropagationStopped &&
      read("nativeEvent") === snapshot.nativeEvent &&
      read("type") === facts.type &&
      read("target") === snapshot.target &&
      snapshot.target === facts.target &&
      read("currentTarget") === currentTarget &&
      read("eventPhase") === snapshot.phase &&
      snapshot.phase === facts.eventPhase &&
      read("bubbles") === facts.bubbles &&
      read("cancelable") === facts.cancelable &&
      read("defaultPrevented") === defaultPrevented &&
      read("key") === facts.key &&
      read("code") === facts.code &&
      read("location") === facts.location &&
      read("altKey") === facts.altKey &&
      read("ctrlKey") === facts.ctrlKey &&
      read("metaKey") === facts.metaKey &&
      read("shiftKey") === facts.shiftKey &&
      read("repeat") === facts.repeat &&
      FIND_ACTION_IS(read("view"), snapshot.view) &&
      findActionViewIsOwned(snapshot.view, nav, proof) &&
      read("preventDefault") === methods.preventDefault
    );
  } catch {
    return false;
  }
}

function sameFindActionFacts(
  captured: FindNativeKeyboardFacts,
  current: FindNativeKeyboardFacts,
  defaultPrevented = false,
) {
  if (
    current.event !== captured.event ||
    current.type !== captured.type ||
    current.key !== captured.key ||
    current.code !== captured.code ||
    current.location !== captured.location ||
    current.repeat !== captured.repeat ||
    current.isComposing !== captured.isComposing ||
    current.altKey !== captured.altKey ||
    current.ctrlKey !== captured.ctrlKey ||
    current.metaKey !== captured.metaKey ||
    current.shiftKey !== captured.shiftKey ||
    current.bubbles !== captured.bubbles ||
    current.cancelable !== captured.cancelable ||
    current.isTrusted !== captured.isTrusted ||
    current.timeStamp !== captured.timeStamp ||
    current.view !== captured.view ||
    current.ownerView !== captured.ownerView ||
    current.target !== captured.target ||
    current.activeElement !== captured.target ||
    captured.defaultPrevented ||
    current.defaultPrevented !== defaultPrevented ||
    current.path.length !== captured.path.length
  ) {
    return false;
  }
  for (let index = 0; index < current.path.length; index += 1) {
    if (current.path[index] !== captured.path[index]) return false;
  }
  return true;
}

function createFindBarPublication({
  authority,
  cells,
  setReplacementDraft,
  requestSuccessor,
}: {
  authority: FindBarAuthority;
  cells: PublicationCells;
  setReplacementDraft: Dispatch<SetStateAction<ReplacementDraft>>;
  requestSuccessor: () => void;
}): FindBarPublicationSet {
  let currentRuntime: FindBarPublicationRuntime | null = null;
  let lastRuntime: FindBarPublicationRuntime | null = null;
  let successorRequested = false;

  /**
   * What this publication was created from, frozen before any delivery. The callback-free gate binds
   * the live session and the frozen authority's own data slots to these identities, so a comparison
   * can never be satisfied by re-reading the same mutated value twice.
   */
  const published: FindActionPublishedIdentities = FIND_ACTION_FREEZE({
    visit: authority.visit,
    session: authority.session,
    find: authority.find,
    options: authority.options,
    matches: authority.matches,
    methods: authority.methods,
    setFind: authority.methods.setFind,
    stepFind: authority.methods.stepFind,
    replaceActive: authority.methods.replaceActive,
    replaceAll: authority.methods.replaceAll,
    onReplaceVisible: authority.onReplaceVisible,
    onReveal: authority.onReveal,
    onClose: authority.onClose,
    query: authority.query,
    active: authority.active,
    total: authority.total,
    canEdit: authority.canEdit,
    replacement: authority.replacement,
  });
  const canEditAccessor = captureFindActionAccessorBinding(
    authority.session,
    "canEdit",
  );

  const factsAreCurrent = () => {
    const current = authority.session.find;
    const values = authority.optionValues;
    return (
      authority.visit.session === authority.session &&
      current === authority.find &&
      current.options === authority.options &&
      current.matches === authority.matches &&
      current.query === authority.query &&
      current.matches.length === authority.total &&
      current.matches.length === authority.matchValues.length &&
      current.matches.every((match, index) => {
        const expected = authority.matchValues[index];
        return expected?.from === match.from && expected.to === match.to;
      }) &&
      current.active === authority.active &&
      current.options.matchCase === values.matchCase &&
      current.options.wholeWord === values.wholeWord &&
      current.options.regex === values.regex &&
      authority.session.canEdit === authority.canEdit &&
      authority.showReplace === (authority.replaceVisible && authority.canEdit) &&
      authority.noMatches === (authority.total === 0) &&
      authority.actionsDisabled === (authority.invalidRegex || authority.noMatches)
    );
  };

  const requestReplaySuccessor = (runtime: FindBarPublicationRuntime) => {
    const snapshot = runtime.snapshot();
    const placement = runtime.placement();
    if (
      successorRequested ||
      !snapshot ||
      !placement ||
      !cells.successorOf.current ||
      cells.successorOf.current !== runtime.publication ||
      !factsAreCurrent() ||
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
    retireOnDetach: boolean,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (
      (retireOnDetach && element === null) ||
      (element !== null && last !== null && element !== last)
    ) {
      currentRuntime?.retireForElement();
    }
    if (
      runtime?.isExactElementReplay() &&
      cells.successorOf.current === runtime.publication
    ) {
      requestReplaySuccessor(runtime);
    }
  };
  const bar = new ElementOwner<HTMLDivElement>(onElementChange);
  const firstRow = new ElementOwner<HTMLDivElement>(onElementChange);
  const searchOwner = new ElementOwner<HTMLInputElement>(onElementChange);
  const replaceOwner = new ElementOwner<HTMLInputElement>(onElementChange);

  const ownsIdentity = (publication: FindBarPublication) => {
    const runtime = currentRuntime;
    return (
      !!runtime &&
      runtime.publication === publication &&
      !runtime.isRetired() &&
      cells.active.current === publication &&
      publication.authority.visit.mount === authority.visit.mount
    );
  };
  const ownsAuthority = (publication: FindBarPublication) =>
    ownsIdentity(publication) &&
    factsAreCurrent() &&
    exactDomIsCurrent();
  const ownsBar = (publication: FindBarPublication, element: HTMLDivElement) => {
    const owned = bar.element();
    return (
      ownsAuthority(publication) &&
      owned === element &&
      element.isConnected
    );
  };
  const inputOwner = (kind: FindInput) => kind === "search" ? searchOwner : replaceOwner;
  const ownsInput = (
    publication: FindBarPublication,
    kind: FindInput,
    element: HTMLInputElement,
  ) => {
    const root = bar.element();
    return (
      ownsAuthority(publication) &&
      inputOwner(kind).element() === element &&
      !!root &&
      root.isConnected &&
      element.isConnected &&
      root.contains(element)
    );
  };
  /**
   * Activation claims, marked through the retained `WeakSet` intrinsics and an indexed loop: no
   * `some`, no iterator, and no `has`/`add` slot page code can replace ever answers for a claim.
   */
  const claim = (...events: object[]) => {
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event || findActionTokenIsClaimed(cells.claimedActivations, event)) {
        return false;
      }
    }
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event) findActionClaimToken(cells.claimedActivations, event);
    }
    return true;
  };
  const reveal = (publication: FindBarPublication, match: FindMatch | null) => {
    if (match && ownsIdentity(publication)) authority.onReveal(match);
  };
  const update = (
    publication: FindBarPublication,
    nextQuery: string,
    nextOptions: FindOptions,
  ) => {
    authority.methods.setFind.call(authority.session, nextQuery, nextOptions);
    const result = authority.session.find;
    if (
      !ownsIdentity(publication) ||
      !result ||
      result === authority.find ||
      result.query !== nextQuery ||
      result.options !== nextOptions
    ) return;
    reveal(publication, result.matches[result.active] ?? null);
  };
  const step = (publication: FindBarPublication, direction: 1 | -1) => {
    const match = authority.methods.stepFind.call(authority.session, direction);
    reveal(publication, match);
  };
  const replaceOne = (publication: FindBarPublication) => {
    const match = authority.methods.replaceActive.call(authority.session, authority.replacement);
    reveal(publication, match);
  };
  const replaceAll = () => {
    authority.methods.replaceAll.call(authority.session, authority.replacement);
  };
  const cancelReplaceFocus = (publication: FindBarPublication) => {
    const owner = cells.replaceFocus.current;
    if (owner?.publication !== publication) return;
    cells.replaceFocus.current = null;
    if (owner.frame !== null) cancelAnimationFrame(owner.frame);
  };
  const close = (publication: FindBarPublication) => {
    if (!publication.retire()) return;
    authority.onClose();
  };
  const nextOptions = (key: keyof FindOptions): FindOptions =>
    Object.freeze({ ...authority.optionValues, [key]: !authority.optionValues[key] });

  const controlOwners = new Map<FindControl, ElementOwner<HTMLButtonElement>>();
  const ownsControl = (
    publication: FindBarPublication,
    control: FindControlPublication,
    owner: ElementOwner<HTMLButtonElement>,
    element: HTMLButtonElement,
    requireEnabled = true,
  ) => {
    const root = bar.element();
    return (
      ownsAuthority(publication) &&
      owner.element() === element &&
      !!root &&
      root.isConnected &&
      element.isConnected &&
      root.contains(element) &&
      (!requireEnabled || (control.enabled && !element.disabled))
    );
  };
  const makeControl = ({
    id,
    enabled = true,
    keepInputFocus = false,
    navigable = false,
    run,
  }: {
    id: FindControl;
    enabled?: boolean;
    keepInputFocus?: boolean;
    navigable?: boolean;
    run: (publication: FindBarPublication) => void;
  }): FindControlPublication => {
    // Radix's asChild trigger may detach and reattach its composed ref to the same button.
    const owner = new ElementOwner<HTMLButtonElement>(onElementChange, false);
    findActionMapSet(controlOwners, id, owner);
    const control: FindControlPublication = Object.freeze({
      id,
      enabled,
      capture: owner.capture,
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        const publication = currentRuntime?.publication;
        if (
          !publication ||
          !ownsControl(publication, control, owner, event.currentTarget) ||
          !claim(event)
        ) {
          return;
        }
        run(publication);
      },
      ...(navigable
        ? {
            onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
              completeFirstRowNavigation(control, event);
            },
          }
        : {}),
      ...(keepInputFocus
        ? {
            onMouseDown: (event: MouseEvent<HTMLButtonElement>) => {
              const publication = currentRuntime?.publication;
              if (
                !publication ||
                !ownsControl(publication, control, owner, event.currentTarget) ||
                findActionTokenIsClaimed(cells.claimedMouseDowns, event)
              ) return;
              findActionClaimToken(cells.claimedMouseDowns, event);
              event.preventDefault();
            },
          }
        : {}),
    });
    return control;
  };

  const controls: Record<FindControl, FindControlPublication> = {
    matchCase: makeControl({
      id: "matchCase",
      keepInputFocus: true,
      run: (publication) => update(publication, authority.query, nextOptions("matchCase")),
    }),
    wholeWord: makeControl({
      id: "wholeWord",
      keepInputFocus: true,
      run: (publication) => update(publication, authority.query, nextOptions("wholeWord")),
    }),
    regex: makeControl({
      id: "regex",
      keepInputFocus: true,
      run: (publication) => update(publication, authority.query, nextOptions("regex")),
    }),
    previous: makeControl({
      id: "previous",
      enabled: !authority.actionsDisabled,
      keepInputFocus: true,
      navigable: true,
      run: (publication) => step(publication, -1),
    }),
    next: makeControl({
      id: "next",
      enabled: !authority.actionsDisabled,
      keepInputFocus: true,
      navigable: true,
      run: (publication) => step(publication, 1),
    }),
    toggleReplace: makeControl({
      id: "toggleReplace",
      enabled: authority.canEdit,
      keepInputFocus: true,
      navigable: true,
      run: (publication) => {
        if (authority.replaceVisible) {
          cancelReplaceFocus(publication);
          authority.onReplaceVisible(false);
          return;
        }
        const intent: ReplaceFocusIntent = { source: publication };
        cells.replaceIntent.current = intent;
        authority.onReplaceVisible(true);
      },
    }),
    close: makeControl({ id: "close", navigable: true, run: close }),
    replaceOne: makeControl({
      id: "replaceOne",
      enabled: authority.showReplace && !authority.actionsDisabled,
      run: replaceOne,
    }),
    replaceAll: makeControl({
      id: "replaceAll",
      enabled: authority.showReplace && !authority.actionsDisabled,
      run: replaceAll,
    }),
  };

  const closeFromKeyboard = (
    publication: FindBarPublication,
    event: KeyboardEvent<HTMLDivElement> | KeyboardEvent<HTMLInputElement>,
  ) => {
    if (!claim(event)) return;
    event.preventDefault();
    event.stopPropagation();
    close(publication);
  };
  const search: FindInputPublication = Object.freeze({
    capture: searchOwner.capture,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const publication = currentRuntime?.publication;
      if (
        !publication ||
        !ownsInput(publication, "search", event.currentTarget) ||
        !claim(event)
      ) {
        return;
      }
      update(publication, event.currentTarget.value, authority.options);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      const publication = currentRuntime?.publication;
      if (!publication || !ownsInput(publication, "search", event.currentTarget)) return;
      if (event.key === "Escape") {
        closeFromKeyboard(publication, event);
        return;
      }
      if (event.key !== "Enter" || !claim(event)) return;
      event.preventDefault();
      if (!authority.invalidRegex) step(publication, event.shiftKey ? -1 : 1);
    },
  });
  const replacement: FindInputPublication = Object.freeze({
    capture: replaceOwner.capture,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const publication = currentRuntime?.publication;
      if (
        !publication ||
        !ownsInput(publication, "replace", event.currentTarget) ||
        !claim(event)
      ) {
        return;
      }
      setReplacementDraft({ visit: authority.visit, value: event.currentTarget.value });
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      const publication = currentRuntime?.publication;
      if (!publication || !ownsInput(publication, "replace", event.currentTarget)) return;
      if (event.key === "Escape") {
        closeFromKeyboard(publication, event);
        return;
      }
      if (event.key !== "Enter" || !claim(event)) return;
      event.preventDefault();
      if (authority.invalidRegex) return;
      if (event.shiftKey) step(publication, -1);
      else replaceOne(publication);
    },
  });

  const expectedControls = () => [
    controls.matchCase,
    controls.wholeWord,
    controls.regex,
    controls.previous,
    controls.next,
    ...(authority.canEdit ? [controls.toggleReplace] : []),
    controls.close,
    ...(authority.showReplace ? [controls.replaceOne, controls.replaceAll] : []),
  ];
  const controlTestIds: Readonly<Record<FindControl, string>> = {
    matchCase: "find-match-case",
    wholeWord: "find-whole-word",
    regex: "find-regex",
    previous: "find-prev",
    next: "find-next",
    toggleReplace: "find-toggle-replace",
    close: "find-close",
    replaceOne: "replace-one",
    replaceAll: "replace-all",
  };
  const expectedOwners = (): readonly ElementOwnerView[] => [
    bar,
    firstRow,
    searchOwner,
    ...expectedControls().map((control) => findActionMapGet(controlOwners, control.id)!),
    ...(authority.showReplace ? [replaceOwner] : []),
  ];
  const isCurrentKeyboardTarget = (target: Node) =>
    target === searchOwner.element() ||
    (authority.showReplace && target === replaceOwner.element()) ||
    expectedControls().some((control) =>
      target === findActionMapGet(controlOwners, control.id)?.element());
  const exactDomIsCurrent = () => {
    const root = bar.element();
    const rowElement = firstRow.element();
    const searchElement = searchOwner.element();
    const replaceElement = replaceOwner.element();
    const controlElements = expectedControls().map((control) =>
      findActionMapGet(controlOwners, control.id)?.element());
    const interactiveElements: readonly (HTMLElement | null | undefined)[] = [
      searchElement,
      ...controlElements.slice(0, authority.canEdit ? 6 : 5),
      controlElements[authority.canEdit ? 6 : 5],
      ...(authority.showReplace
        ? [replaceElement, ...controlElements.slice(authority.canEdit ? 7 : 6)]
        : []),
    ];
    const ownedInteractiveElements = root
      ? [...root.querySelectorAll<HTMLElement>("input, button")]
          .filter((element) => interactiveElements.includes(element))
      : [];
    return (
      !!root &&
      root.isConnected &&
      root.tagName === "DIV" &&
      root.getAttribute("role") === "search" &&
      root.getAttribute("aria-label") === "Find and replace" &&
      root.dataset.testid === "find-bar" &&
      !!rowElement &&
      rowElement.isConnected &&
      rowElement.ownerDocument === root.ownerDocument &&
      rowElement.tagName === "DIV" &&
      rowElement.dataset.testid === "find-actions" &&
      rowElement.parentNode === root &&
      !!searchElement &&
      searchElement.isConnected &&
      searchElement.ownerDocument === root.ownerDocument &&
      searchElement.tagName === "INPUT" &&
      searchElement.dataset.testid === "find-input" &&
      root.contains(searchElement) &&
      (authority.showReplace
        ? !!replaceElement &&
          replaceElement.isConnected &&
          replaceElement.ownerDocument === root.ownerDocument &&
          replaceElement.tagName === "INPUT" &&
          replaceElement.dataset.testid === "replace-input" &&
          root.contains(replaceElement)
        : replaceElement === null) &&
      controlElements.every((element, index) =>
        !!element &&
        element.isConnected &&
        element.ownerDocument === root.ownerDocument &&
        element.tagName === "BUTTON" &&
        element.type === "button" &&
        element.dataset.testid === controlTestIds[expectedControls()[index]!.id] &&
        root.contains(element)) &&
      interactiveElements.every((element, index) =>
        element !== null && ownedInteractiveElements[index] === element) &&
      ownedInteractiveElements.length === interactiveElements.length
    );
  };
  const focusSearch = (publication: FindBarPublication) => {
    const element = searchOwner.element();
    if (!element || !ownsInput(publication, "search", element)) return false;
    element.focus();
    if (ownsInput(publication, "search", element)) element.select();
    return true;
  };
  const scheduleReplaceFocus = (publication: FindBarPublication) => {
    const element = replaceOwner.element();
    if (!element || !ownsInput(publication, "replace", element)) return false;
    const owner: ReplaceFocusOwner = { publication, element, frame: null };
    cells.replaceFocus.current = owner;
    const frame = requestAnimationFrame(() => {
      if (
        owner.frame !== frame ||
        cells.replaceFocus.current !== owner ||
        !ownsInput(publication, "replace", owner.element)
      ) return;
      cells.replaceFocus.current = null;
      owner.element.focus();
    });
    owner.frame = frame;
    return true;
  };

  /** Built without a spread: the gate path runs no array iterator page code can replace. */
  const firstRowActionControls = (): readonly FindControlPublication[] =>
    authority.canEdit
      ? FIND_ACTION_FREEZE([
          controls.previous,
          controls.next,
          controls.toggleReplace,
          controls.close,
        ])
      : FIND_ACTION_FREEZE([controls.previous, controls.next, controls.close]);

  /**
   * The bounded group: the current enabled first-row actions in exact committed DOM order. Anything
   * missing, detached, reordered, or outside the published row collapses the whole group.
   */
  const currentFirstRowActions = (publication: FindBarPublication) => {
    const root = bar.element();
    const row = firstRow.element();
    if (!root || !row || !row.isConnected || row.parentNode !== root) return null;
    if (!ownsAuthority(publication)) return null;
    const expected: FindActionCommittedEntry[] = [];
    for (const control of firstRowActionControls()) {
      const owner = findActionMapGet(controlOwners, control.id);
      const element = owner?.element() ?? null;
      if (
        !owner ||
        !element ||
        !element.isConnected ||
        element.ownerDocument !== root.ownerDocument ||
        !row.contains(element)
      ) {
        return null;
      }
      expected.push({ control, owner, element });
    }
    const committed = [...row.querySelectorAll<HTMLButtonElement>("button")]
      .filter((element) => expected.some((entry) => entry.element === element));
    if (
      committed.length !== expected.length ||
      expected.some((entry, index) => committed[index] !== entry.element)
    ) {
      return null;
    }
    return Object.freeze(
      expected.filter(({ control, element }) =>
        control.enabled && !element.disabled && findActionIsEnabled(element)),
    );
  };

  const resolveFirstRowMovement = (
    publication: FindBarPublication,
    source: EventTarget,
    key: string,
  ) => {
    if (!isFindActionKey(key)) return null;
    const actions = currentFirstRowActions(publication);
    if (!actions || actions.length < 2) return null;
    const index = actions.findIndex((entry) => entry.element === source);
    if (index < 0) return null;
    const destinationIndex = findActionDestinationIndex(key, index, actions.length);
    if (destinationIndex === null || destinationIndex === index) return null;
    const sourceEntry = actions[index];
    const destinationEntry = actions[destinationIndex];
    if (
      !sourceEntry ||
      !destinationEntry ||
      sourceEntry.element === destinationEntry.element
    ) {
      return null;
    }
    return {
      key,
      actions,
      index,
      destinationIndex,
      sourceControl: sourceEntry.control,
      destinationControl: destinationEntry.control,
      source: sourceEntry.element,
      destination: destinationEntry.element,
    };
  };

  const firstRowMovementIsCurrent = (
    runtime: FindBarPublicationRuntime,
    publication: FindBarPublication,
    facts: FindNativeKeyboardFacts,
    movement: FindActionMovement,
  ): FindActionCommitment | null => {
    const root = bar.element();
    const row = firstRow.element();
    const resolved = resolveFirstRowMovement(publication, movement.source, movement.key);
    const sourceOwner = findActionMapGet(controlOwners, movement.sourceControl.id);
    const destinationOwner = findActionMapGet(
      controlOwners,
      movement.destinationControl.id,
    );
    const current =
      currentRuntime === runtime &&
      !runtime.isRetired() &&
      runtime.publication === publication &&
      cells.active.current === publication &&
      runtime.nav?.isDescriptorCurrent() === true &&
      !!root &&
      !!row &&
      !!resolved &&
      resolved.key === movement.key &&
      resolved.sourceControl === movement.sourceControl &&
      resolved.destinationControl === movement.destinationControl &&
      resolved.source === movement.source &&
      resolved.destination === movement.destination &&
      !!sourceOwner &&
      !!destinationOwner &&
      ownsControl(publication, movement.sourceControl, sourceOwner, movement.source) &&
      ownsControl(
        publication,
        movement.destinationControl,
        destinationOwner,
        movement.destination,
      ) &&
      facts.activeElement === movement.source &&
      factsAreCurrent() &&
      exactDomIsCurrent();
    if (!current || !root || !row || !resolved) return null;
    const intrinsics = runtime.nav?.intrinsics;
    if (!intrinsics) return null;
    // Retained Element methods run only while later publication walks and the observer drain can
    // record anything they or their realm internals mutate. The callback-free gate never calls them.
    for (let index = 0; index < resolved.actions.length; index += 1) {
      const entry = resolved.actions[index];
      if (!entry || !findActionIsIntrinsicallyEnabled(entry.element, intrinsics)) return null;
    }
    const places: FindActionPlacement[] = [];
    for (const node of [root, row, ...resolved.actions.map((entry) => entry.element)]) {
      const placement = captureFindActionPlacement(intrinsics, node);
      if (!placement) return null;
      places.push(placement);
    }
    return FIND_ACTION_FREEZE({
      runtime,
      publication,
      authority,
      root,
      row,
      actions: resolved.actions,
      places: FIND_ACTION_FREEZE(places),
      sourceIndex: resolved.index,
      destinationIndex: resolved.destinationIndex,
    });
  };

  /** A placement walk, so neither phase needs a DOM method that page code can own. */
  const firstRowPlaces = (
    row: HTMLDivElement,
    element: HTMLElement,
    read: FindActionNodeReader,
  ) => {
    let node: Node | null | undefined = element;
    for (
      let depth = 0;
      node && depth < FIND_ACTION_ANCESTOR_LIMIT;
      depth += 1
    ) {
      if (node === row) return true;
      node = read.parent(node);
    }
    return false;
  };

  /**
   * The committed first-row publication, re-read from owners and node state only: the exact enabled
   * actions, in their committed order, still owned, connected, enabled, and placed. Phase reads pass
   * the public reader while mutation is still allowed; the final gate passes the intrinsic reader.
   */
  const firstRowCommitmentIsRetained = (
    commitment: FindActionCommitment,
    movement: FindActionMovement,
    read: FindActionNodeReader,
  ) => {
    const { actions, sourceIndex, destinationIndex, root, row } = commitment;
    const order = firstRowActionControls();
    const rootDocument = read.ownerDocument(root);
    if (rootDocument === undefined) return false;
    let placed = -1;
    for (let index = 0; index < actions.length; index += 1) {
      const entry = actions[index];
      if (!entry) return false;
      let position = -1;
      for (let slot = 0; slot < order.length; slot += 1) {
        if (order[slot] === entry.control) {
          position = slot;
          break;
        }
      }
      if (
        position <= placed ||
        findActionMapGet(controlOwners, entry.control.id) !== entry.owner ||
        entry.owner.element() !== entry.element ||
        !entry.control.enabled ||
        !read.enabled(entry.element) ||
        read.connected(entry.element) !== true ||
        read.ownerDocument(entry.element) !== rootDocument ||
        !firstRowPlaces(row, entry.element, read)
      ) {
        return false;
      }
      placed = position;
    }
    const source = actions[sourceIndex];
    const destination = actions[destinationIndex];
    return (
      actions.length > 1 &&
      !!source &&
      !!destination &&
      source !== destination &&
      source.control === movement.sourceControl &&
      source.element === movement.source &&
      destination.control === movement.destinationControl &&
      destination.element === movement.destination &&
      findActionDestinationIndex(movement.key, sourceIndex, actions.length) ===
        destinationIndex &&
      bar.element() === root &&
      firstRow.element() === row &&
      read.connected(root) === true &&
      read.connected(row) === true &&
      read.parent(row) === root
    );
  };

  /**
   * The last mutation-capable pass over the live session and the published callbacks. Every value is
   * read publicly and on purpose: a session `find`, can-edit, or method accessor gets its chance to
   * run here, while mutation is still allowed, and whatever it changes is still ahead of the
   * callback-free gate. Nothing this pass produces is kept — a one-pass reading can stale itself the
   * moment a later getter in the same pass moves `find` — so only its completion is reported, and
   * {@link liveAuthorityIsExact} re-derives every fact from the backing slots afterwards.
   */
  const probeLiveAuthority = () => {
    try {
      const session = authority.session;
      const find = session.find ?? null;
      const options = find ? find.options : null;
      const matches = find ? find.matches : null;
      const readings: unknown[] = [find, options, matches];
      if (find) {
        readings[readings.length] = find.query;
        readings[readings.length] = find.active;
      }
      if (options) {
        readings[readings.length] = options.matchCase;
        readings[readings.length] = options.wholeWord;
        readings[readings.length] = options.regex;
      }
      if (matches) {
        for (let index = 0; index < matches.length; index += 1) {
          const match = matches[index];
          if (!match) return false;
          readings[readings.length] = match.from;
          readings[readings.length] = match.to;
        }
      }
      const order = firstRowActionControls();
      for (let index = 0; index < order.length; index += 1) {
        const control = order[index];
        if (!control) return false;
        readings[readings.length] = control.enabled;
      }
      readings[readings.length] = session.setFind;
      readings[readings.length] = session.stepFind;
      readings[readings.length] = session.replaceActive;
      readings[readings.length] = session.replaceAll;
      // Read last, so every earlier reading is already behind whatever this getter decides to do.
      readings[readings.length] = session.canEdit;
      readings[readings.length] = authority.onReplaceVisible;
      readings[readings.length] = authority.onReveal;
      readings[readings.length] = authority.onClose;
      readings[readings.length] = authority.replacement;
      return readings.length > 0;
    } catch {
      return false;
    }
  };

  /**
   * The live authority, re-derived after every public read and without making one. The session's
   * `find`, `role`, and `mode` come from their own data slots, the find state's fields and every
   * match bound are compared by hand, `canEdit` is derived from the exact role and mode instead of
   * being asked for, the four session methods are authenticated by prototype-chain data descriptor
   * without invoking a getter, and the frozen authority's own slots must still hold the identities
   * this publication was created from. An accessor, an own shadow, or a moved slot anywhere rejects
   * the delivery, so a method or can-edit getter that changed `session.find` while the public pass
   * was reading it cannot leave a stale reading behind for the gate to trust.
   */
  const liveAuthorityIsExact = (
    publication: FindBarPublication,
    intrinsics: FindActionIntrinsics,
  ) => {
    const session = authority.session;
    if (
      !session ||
      typeof session !== "object" ||
      publication.authority !== authority ||
      cells.active.current !== publication ||
      authority.visit !== published.visit ||
      authority.session !== published.session ||
      authority.visit.session !== published.session
    ) {
      return false;
    }
    if (
      findActionOwnData(authority, "visit") !== published.visit ||
      findActionOwnData(authority, "session") !== published.session ||
      findActionOwnData(authority, "find") !== published.find ||
      findActionOwnData(authority, "options") !== published.options ||
      findActionOwnData(authority, "matches") !== published.matches ||
      findActionOwnData(authority, "methods") !== published.methods ||
      findActionOwnData(authority, "query") !== published.query ||
      findActionOwnData(authority, "active") !== published.active ||
      findActionOwnData(authority, "total") !== published.total ||
      findActionOwnData(authority, "canEdit") !== published.canEdit ||
      findActionOwnData(authority, "replacement") !== published.replacement ||
      findActionOwnData(authority, "onReplaceVisible") !== published.onReplaceVisible ||
      findActionOwnData(authority, "onReveal") !== published.onReveal ||
      findActionOwnData(authority, "onClose") !== published.onClose ||
      findActionOwnData(published.methods, "setFind") !== published.setFind ||
      findActionOwnData(published.methods, "stepFind") !== published.stepFind ||
      findActionOwnData(published.methods, "replaceActive") !== published.replaceActive ||
      findActionOwnData(published.methods, "replaceAll") !== published.replaceAll
    ) {
      return false;
    }
    // The session's backing slots: never a getter, never an own shadow of a published method.
    const find = findActionOwnData(session, "find");
    const role = findActionOwnData(session, "role");
    const mode = findActionOwnData(session, "mode");
    if (
      find !== published.find ||
      typeof role !== "string" ||
      typeof mode !== "string" ||
      intrinsics.ownValue(session, "setFind") !== published.setFind ||
      intrinsics.ownValue(session, "stepFind") !== published.stepFind ||
      intrinsics.ownValue(session, "replaceActive") !== published.replaceActive ||
      intrinsics.ownValue(session, "replaceAll") !== published.replaceAll
    ) {
      return false;
    }
    const options = findActionOwnData(published.find, "options");
    const matches = findActionOwnData(published.find, "matches");
    if (
      options !== published.options ||
      matches !== published.matches ||
      findActionOwnData(published.find, "query") !== published.query ||
      findActionOwnData(published.find, "active") !== published.active ||
      findActionOwnData(published.options, "matchCase") !== authority.optionValues.matchCase ||
      findActionOwnData(published.options, "wholeWord") !== authority.optionValues.wholeWord ||
      findActionOwnData(published.options, "regex") !== authority.optionValues.regex ||
      !FIND_ACTION_IS_ARRAY(published.matches) ||
      findActionOwnData(published.matches, "length") !== published.total ||
      authority.matchValues.length !== published.total
    ) {
      return false;
    }
    for (let index = 0; index < authority.matchValues.length; index += 1) {
      const expected = authority.matchValues[index];
      const match = findActionOwnData(published.matches, index);
      if (
        !expected ||
        !match ||
        typeof match !== "object" ||
        findActionOwnData(match, "from") !== expected.from ||
        findActionOwnData(match, "to") !== expected.to
      ) {
        return false;
      }
    }
    // Can-edit is derived from the exact role and mode. Its originally published accessor, descriptor
    // flags, holder, and prototype links must also remain exact; an own shadow or a replacement getter
    // that happens to answer with the same value is a change of authority, not an answer.
    const canEdit = (role === "owner" || role === "editor") && mode !== "viewing";
    if (
      !canEditAccessor ||
      !findActionAccessorIsRetained(canEditAccessor, session, "canEdit") ||
      canEdit !== published.canEdit ||
      canEdit !== authority.canEdit
    ) {
      return false;
    }
    const order = firstRowActionControls();
    const toggled = canEdit ? 1 : 0;
    if (
      order.length !== 3 + toggled ||
      order[0] !== controls.previous ||
      order[1] !== controls.next ||
      (canEdit && order[2] !== controls.toggleReplace) ||
      order[2 + toggled] !== controls.close
    ) {
      return false;
    }
    return (
      authority.focusRequest.visit === authority.visit &&
      authority.focusRequest.focusNonce === authority.focusNonce &&
      authority.showReplace === (authority.replaceVisible && canEdit) &&
      authority.noMatches === (published.total === 0) &&
      authority.actionsDisabled === (authority.invalidRegex || authority.noMatches) &&
      controls.previous.enabled === !authority.actionsDisabled &&
      controls.next.enabled === !authority.actionsDisabled &&
      controls.toggleReplace.enabled === canEdit &&
      controls.close.enabled
    );
  };

  /**
   * The public wrapper reads and both authenticated React predicates, for both phases. Every
   * predicate call of a phase happens here, before that phase's callback-free gate re-reads the
   * retained properties and method identities by descriptor.
   */
  const readFirstRowPredicates = (
    pair: FindActionKeyPair,
    bubble: FindActionReactSnapshot,
    nav: FindActionRuntimeView,
    facts: FindNativeKeyboardFacts,
    prevented: boolean,
  ): FindActionPredicateReadings | null => {
    if (
      !findActionReactRemainsExact(pair.capture, nav, pair.facts, pair.proof, null) ||
      !findActionReactRemainsExact(
        bubble,
        nav,
        facts,
        pair.proof,
        pair.movement.source,
        prevented,
      )
    ) {
      return null;
    }
    const capture = readFindActionReactPredicates(pair.capture, nav, false);
    const bubbleReading = readFindActionReactPredicates(bubble, nav, prevented);
    return capture && bubbleReading
      ? FIND_ACTION_FREEZE({ capture, bubble: bubbleReading })
      : null;
  };

  /**
   * The callback-free gate, run twice: once before the pair is claimed and once immediately before
   * owner-realm focus. Every mutation-capable query of the phase — the React predicates, `matches()`
   * and `querySelectorAll()`, the committed re-read through public node state, the published DOM
   * walk, the live session pass, the native facts read whose composed path the realm copies through
   * a replaceable iterator, and the observer drain — has already finished, in that order.
   *
   * This gate makes no public property read, invokes no predicate, dispatches through no mutable
   * prototype method or iterator, and reads no facts again. It works in one order: internal identity
   * first, then the live authority re-derived from the session's own data slots, then the retained
   * React wrappers re-read by descriptor, then native and DOM state through authenticated
   * owner-realm getters, then its own claim and permanent history state through retained collection
   * intrinsics. Any drift the last query caused rejects the attempt; a pre-claim rejection leaves the
   * rightful pair pending for the same exact native event.
   */
  const firstRowGateIsExact = (
    stage: FindActionGateStage,
    runtime: FindBarPublicationRuntime,
    publication: FindBarPublication,
    nav: FindActionRuntimeView,
    delivery: FindActionKeyDelivery,
    attempt: FindActionAttempt,
    commitment: FindActionCommitment,
    facts: FindNativeKeyboardFacts,
    readings: FindActionPredicateReadings,
  ) => {
    const { pair, bubble } = delivery;
    const movement = pair.movement;
    const intrinsics = nav.intrinsics;
    const prevented = stage === "final";
    // 1. Identity: the exact runtime, publication, authority, pair, and readings of this delivery.
    if (
      commitment.runtime !== runtime ||
      commitment.publication !== publication ||
      commitment.authority !== authority ||
      currentRuntime !== runtime ||
      runtime.isRetired() ||
      runtime.publication !== publication ||
      runtime.nav !== nav ||
      cells.active.current !== publication ||
      publication.authority !== authority ||
      publication.authority.visit.mount !== authority.visit.mount ||
      pair.publication !== publication ||
      readings.capture.snapshot !== pair.capture ||
      readings.bubble.snapshot !== bubble ||
      !ownsIdentity(publication) ||
      // Descriptor-only currentness: the shared keyboard-trust walk applies captured Window
      // constructor accessors, so no gate — and nothing a gate reaches — may ask it.
      !nav.isDescriptorCurrent()
    ) {
      return false;
    }
    // 2. The live authority, from backing slots only — never the public pass that just ran.
    if (!liveAuthorityIsExact(publication, intrinsics)) return false;
    // 3. The retained React wrappers, re-read by descriptor after the last predicate call of all.
    if (
      !findActionReactIsFinal(
        pair.capture,
        nav,
        pair.facts,
        pair.proof,
        null,
        false,
        readings.capture,
      ) ||
      !findActionReactIsFinal(
        bubble,
        nav,
        facts,
        pair.proof,
        movement.source,
        prevented,
        readings.bubble,
      )
    ) {
      return false;
    }
    // 4. Native cancellation, propagation, phase, target, and focus, through owner-realm getters.
    if (
      intrinsics.eventDefaultPrevented(pair.nativeEvent) !== prevented ||
      intrinsics.eventPhaseOf(pair.nativeEvent) !== FIND_ACTION_BUBBLING_PHASE ||
      intrinsics.eventCurrentTarget(pair.nativeEvent) !== pair.facts.currentTarget ||
      intrinsics.eventTarget(pair.nativeEvent) !== movement.source ||
      intrinsics.documentActiveElement(nav.ownerDocument) !== movement.source ||
      intrinsics.propagationStopped(pair.nativeEvent)
    ) {
      return false;
    }
    // 5. The last facts reading, bound to the capture-phase pair and to the Window proof.
    if (
      facts.defaultPrevented !== prevented ||
      facts.eventPhase !== FIND_ACTION_BUBBLING_PHASE ||
      facts.currentTarget !== pair.facts.currentTarget ||
      facts.activeElement !== movement.source ||
      facts.path[facts.path.length - 1] !== pair.proof.receiver ||
      pair.facts.eventPhase !== FIND_ACTION_CAPTURING_PHASE ||
      !sameFindActionFacts(pair.facts, facts, prevented) ||
      !findActionViewIsOwned(facts.view, nav, pair.proof) ||
      pair.proof.publication !== publication ||
      pair.proof.nativeEvent !== pair.nativeEvent ||
      pair.proof.receiver !== pair.proof.currentTarget ||
      pair.proof.receiver !== pair.proof.terminal
    ) {
      return false;
    }
    // 6. The removable attempt and the claim state, through retained collection intrinsics.
    if (
      !firstRowAttemptIsCurrent(attempt) ||
      attempt.phase !== "bubble" ||
      attempt.event !== bubble.event ||
      attempt.nativeEvent !== pair.nativeEvent
    ) {
      return false;
    }
    const claimState = prevented
      ? firstRowMovementIsDelivering(delivery, publication) &&
        firstRowPairIsReleased(pair) &&
        nav.listener.retains(pair.proof, publication)
      : !cells.activeActionDelivery.current &&
        firstRowPairIsPending(pair) &&
        !findActionTokenIsClaimed(cells.claimedActionDeliveries, delivery) &&
        !findActionTokenIsClaimed(cells.claimedActionDeliveries, pair) &&
        !findActionTokenIsClaimed(cells.claimedActionDeliveries, movement) &&
        firstRowTokensAreFree(pair) &&
        !findActionTokenIsClaimed(cells.claimedActionTokens, pair.capture.event) &&
        !findActionTokenIsClaimed(cells.claimedActionTokens, bubble.event) &&
        !findActionTokenIsClaimed(cells.claimedActionTokens, pair.nativeEvent) &&
        nav.listener.holds(pair.proof, publication);
    if (!claimState) return false;
    // 7. The committed first row, its owner-realm placement, and the permanent history.
    const read = findActionFinalReader(intrinsics);
    return (
      firstRowCommitmentIsRetained(commitment, movement, read) &&
      commitment.places.length > 2 &&
      firstRowPlacesAreRetained(intrinsics, commitment.places) &&
      runtime.domHistoryIsRetained()
    );
  };

  /**
   * Authentication runs behind removable in-progress guards only: a rejected attempt clears them,
   * performs no effect, and leaves the rightful pair exactly where the rightful bubble expects it.
   */
  const beginFirstRowAttempt = (
    phase: FindActionAttempt["phase"],
    event: object,
    nativeEvent: object,
  ): FindActionAttempt | null => {
    if (
      cells.activeActionAttempt.current ||
      cells.activeActionDelivery.current ||
      findActionTokenIsClaimed(cells.actionAttemptReactEvents, event) ||
      findActionTokenIsClaimed(cells.actionAttemptNativeEvents, nativeEvent) ||
      findActionTokenIsClaimed(cells.claimedActionTokens, event) ||
      findActionTokenIsClaimed(cells.claimedActionTokens, nativeEvent)
    ) {
      return null;
    }
    const attempt: FindActionAttempt = FIND_ACTION_FREEZE({ phase, event, nativeEvent });
    cells.activeActionAttempt.current = attempt;
    findActionClaimToken(cells.actionAttemptReactEvents, event);
    findActionClaimToken(cells.actionAttemptNativeEvents, nativeEvent);
    return attempt;
  };

  const firstRowAttemptIsCurrent = (attempt: FindActionAttempt) =>
    cells.activeActionAttempt.current === attempt &&
    findActionTokenIsClaimed(cells.actionAttemptReactEvents, attempt.event) &&
    findActionTokenIsClaimed(cells.actionAttemptNativeEvents, attempt.nativeEvent);

  const endFirstRowAttempt = (attempt: FindActionAttempt) => {
    if (cells.activeActionAttempt.current === attempt) {
      cells.activeActionAttempt.current = null;
    }
    findActionReleaseToken(cells.actionAttemptReactEvents, attempt.event);
    findActionReleaseToken(cells.actionAttemptNativeEvents, attempt.nativeEvent);
  };

  /** Internal frozen data, built without a spread so no array iterator page code owns is consulted. */
  const firstRowTokens = (pair: FindActionKeyPair): readonly object[] =>
    FIND_ACTION_FREEZE([
      pair.publicationToken,
      pair.sourceToken,
      pair.destinationToken,
      pair.captureToken,
      pair.nativeToken,
      pair.windowToken,
    ]);

  /** Walked by index and asked through the retained intrinsic: no `every`, `some`, or iterator. */
  const firstRowTokensAreFree = (pair: FindActionKeyPair) => {
    const tokens = firstRowTokens(pair);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token || findActionTokenIsClaimed(cells.claimedActionTokens, token)) {
        return false;
      }
    }
    return true;
  };

  const firstRowTokensAreClaimed = (pair: FindActionKeyPair) => {
    const tokens = firstRowTokens(pair);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token || !findActionTokenIsClaimed(cells.claimedActionTokens, token)) {
        return false;
      }
    }
    return true;
  };

  const claimFirstRowTokens = (pair: FindActionKeyPair) => {
    const tokens = firstRowTokens(pair);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token) findActionClaimToken(cells.claimedActionTokens, token);
    }
  };

  const firstRowPlacesAreRetained = (
    intrinsics: FindActionIntrinsics,
    places: readonly FindActionPlacement[],
  ) => {
    for (let index = 0; index < places.length; index += 1) {
      const placement = places[index];
      if (!placement || !findActionPlacementIsRetained(intrinsics, placement)) {
        return false;
      }
    }
    return true;
  };

  /**
   * A pending pair is tracked twice: in the required WeakMap keyed by the exact native event, and in
   * the publication's own key set. Both entries are written and dropped together through retained
   * collection intrinsics, so the map never hands a stale handler a pair whose publication has
   * retired, a retired publication is not kept reachable by a native event that outlives it, and a
   * replaced `add`, `set`, `delete`, `clear`, or `size` slot can neither answer nor re-enter.
   */
  const rememberFirstRowPair = (pair: FindActionKeyPair) => {
    let pending = findActionMapGet(cells.pendingActionKeys, pair.publication);
    if (!pending) {
      pending = findActionNewSet<object>();
      findActionMapSet(cells.pendingActionKeys, pair.publication, pending);
    }
    findActionSetAdd(pending, pair.nativeEvent);
    findActionWeakSet(cells.actionPairs, pair.nativeEvent, pair);
  };

  const forgetFirstRowPair = (pair: FindActionKeyPair) => {
    const pending = findActionMapGet(cells.pendingActionKeys, pair.publication);
    if (pending) {
      findActionSetDelete(pending, pair.nativeEvent);
      if (findActionSetSize(pending) === 0) {
        findActionMapDelete(cells.pendingActionKeys, pair.publication);
      }
    }
    findActionWeakDelete(cells.actionPairs, pair.nativeEvent);
  };

  const firstRowPairIsPending = (pair: FindActionKeyPair) => {
    const pending = findActionMapGet(cells.pendingActionKeys, pair.publication);
    return (
      findActionWeakGet(cells.actionPairs, pair.nativeEvent) === pair &&
      !!pending &&
      findActionSetHas(pending, pair.nativeEvent)
    );
  };

  const firstRowPairIsReleased = (pair: FindActionKeyPair) => {
    const pending = findActionMapGet(cells.pendingActionKeys, pair.publication);
    return (
      !findActionWeakHas(cells.actionPairs, pair.nativeEvent) &&
      (!pending || !findActionSetHas(pending, pair.nativeEvent))
    );
  };

  /** Retirement and cleanup revoke every pending pair and any in-flight work of that publication. */
  const revokeFirstRowWork = (publication: FindBarPublication) => {
    const pending = findActionMapGet(cells.pendingActionKeys, publication);
    const attempt = cells.activeActionAttempt.current;
    const delivery = cells.activeActionDelivery.current;
    let attemptWasRevoked = false;
    if (pending) {
      if (attempt && findActionSetHas(pending, attempt.nativeEvent)) {
        attemptWasRevoked = true;
      }
      findActionSetForEach(pending, (nativeEvent) => {
        findActionWeakDelete(cells.actionPairs, nativeEvent);
      });
      findActionSetClear(pending);
      findActionMapDelete(cells.pendingActionKeys, publication);
    }
    if (delivery && delivery.pair.publication === publication) {
      cells.activeActionDelivery.current = null;
      if (attempt && attempt.nativeEvent === delivery.pair.nativeEvent) {
        attemptWasRevoked = true;
      }
    }
    if (attempt && attemptWasRevoked) cells.activeActionAttempt.current = null;
  };

  const claimFirstRowMovement = (
    delivery: FindActionKeyDelivery,
    publication: FindBarPublication,
    listener: FindActionKeyListener,
    attempt: FindActionAttempt,
  ) => {
    const { pair, bubble } = delivery;
    // Callback-free from here to the end: every check reads internal state or a retained collection
    // intrinsic, and `holds` is the already-authenticated half of the Window proof — no native facts
    // read, no dynamic prototype dispatch, and no user callback can run inside the boundary.
    if (
      cells.activeActionDelivery.current ||
      cells.active.current !== publication ||
      pair.publication !== publication ||
      attempt.phase !== "bubble" ||
      attempt.event !== bubble.event ||
      attempt.nativeEvent !== pair.nativeEvent ||
      !firstRowAttemptIsCurrent(attempt) ||
      !firstRowPairIsPending(pair) ||
      findActionTokenIsClaimed(cells.claimedActionDeliveries, delivery) ||
      findActionTokenIsClaimed(cells.claimedActionDeliveries, pair) ||
      findActionTokenIsClaimed(cells.claimedActionDeliveries, pair.movement) ||
      !firstRowTokensAreFree(pair) ||
      findActionTokenIsClaimed(cells.claimedActionTokens, pair.capture.event) ||
      findActionTokenIsClaimed(cells.claimedActionTokens, bubble.event) ||
      findActionTokenIsClaimed(cells.claimedActionTokens, pair.nativeEvent) ||
      !listener.holds(pair.proof, publication)
    ) {
      return false;
    }
    // The one successful boundary, in one uninterruptible synchronous order and before any public
    // effect. The listener goes first: it re-confirms its callback-free `holds` and marks the native
    // event through the retained `WeakSet.prototype.add`, so the only step that can still reject
    // happens while the pair is untouched. Everything after it is a straight-line commit through
    // retained collection intrinsics — the exact pair is consumed from both the tracking set and the
    // WeakMap, every replay token is marked, and only then does the delivery become active. Nothing
    // below can reject, throw, or re-enter, so no attempt can observe or be left with half a commit,
    // and neither the native event nor a wrapper can run twice.
    if (!listener.claim(pair.proof, publication)) return false;
    forgetFirstRowPair(pair);
    findActionClaimToken(cells.claimedActionDeliveries, delivery);
    findActionClaimToken(cells.claimedActionDeliveries, pair);
    findActionClaimToken(cells.claimedActionDeliveries, pair.movement);
    claimFirstRowTokens(pair);
    findActionClaimToken(cells.claimedActionTokens, pair.capture.event);
    findActionClaimToken(cells.claimedActionTokens, bubble.event);
    findActionClaimToken(cells.claimedActionTokens, pair.nativeEvent);
    cells.activeActionDelivery.current = delivery;
    return true;
  };

  const firstRowMovementIsDelivering = (
    delivery: FindActionKeyDelivery,
    publication: FindBarPublication,
  ) =>
    cells.activeActionDelivery.current === delivery &&
    findActionTokenIsClaimed(cells.claimedActionDeliveries, delivery) &&
    findActionTokenIsClaimed(cells.claimedActionDeliveries, delivery.pair) &&
    findActionTokenIsClaimed(cells.claimedActionDeliveries, delivery.pair.movement) &&
    firstRowTokensAreClaimed(delivery.pair) &&
    findActionTokenIsClaimed(cells.claimedActionTokens, delivery.pair.capture.event) &&
    findActionTokenIsClaimed(cells.claimedActionTokens, delivery.bubble.event) &&
    findActionTokenIsClaimed(cells.claimedActionTokens, delivery.pair.nativeEvent) &&
    firstRowPairIsReleased(delivery.pair) &&
    cells.active.current === publication &&
    delivery.pair.publication === publication;

  const finishFirstRowMovement = (delivery: FindActionKeyDelivery) => {
    if (cells.activeActionDelivery.current === delivery) {
      cells.activeActionDelivery.current = null;
    }
  };

  const captureFirstRowNavigation = (event: KeyboardEvent<HTMLDivElement>) => {
    let nativeEvent: unknown;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    if (!nativeEvent || typeof nativeEvent !== "object") return;
    if (findActionWeakHas(cells.actionPairs, nativeEvent)) return;
    const attempt = beginFirstRowAttempt("capture", event, nativeEvent);
    if (!attempt) return;
    let unclaimedProof: FindActionWindowProof | null = null;
    let unclaimedPublication: FindBarPublication | null = null;
    let unclaimedListener: FindActionKeyListener | null = null;
    try {
      const runtime = currentRuntime;
      const publication = runtime?.publication;
      const nav = runtime?.nav ?? null;
      const root = bar.element();
      const row = firstRow.element();
      if (
        !runtime ||
        !publication ||
        !nav ||
        !root ||
        !row ||
        runtime.isRetired() ||
        !nav.isCurrent() ||
        nav.root !== root ||
        event.currentTarget !== row
      ) {
        return;
      }
      const facts = nav.facts(nativeEvent);
      if (!facts || facts.type !== "keydown" || !isFindActionKey(facts.key)) return;
      const proof = nav.listener.proofFor(nativeEvent, publication);
      if (proof) {
        unclaimedProof = proof;
        unclaimedPublication = publication;
        unclaimedListener = nav.listener;
      }
      const resolved = proof
        ? resolveFirstRowMovement(publication, facts.target, facts.key)
        : null;
      const capture = proof
        ? captureFindActionReactKey(event, nav, facts, nativeEvent, row, proof)
        : null;
      const terminal = facts.path[facts.path.length - 1];
      const nativeCurrentTarget = facts.currentTarget;
      if (
        !proof ||
        !resolved ||
        !capture ||
        facts.eventPhase !== FIND_ACTION_CAPTURING_PHASE ||
        !facts.bubbles ||
        !facts.cancelable ||
        facts.defaultPrevented ||
        nav.intrinsics.propagationStopped(nativeEvent) ||
        !facts.isTrusted ||
        facts.altKey ||
        facts.ctrlKey ||
        facts.metaKey ||
        facts.shiftKey ||
        facts.repeat ||
        facts.isComposing ||
        facts.target !== resolved.source ||
        facts.activeElement !== resolved.source ||
        facts.path[0] !== facts.target ||
        !findKeyboardPathIncludes(facts, row) ||
        !findKeyboardPathIncludes(facts, root) ||
        !findKeyboardPathIncludes(facts, nav.ownerDocument) ||
        !nativeCurrentTarget ||
        !findKeyboardPathIncludes(facts, nativeCurrentTarget) ||
        !(nativeCurrentTarget instanceof nav.intrinsics.nodeConstructor) ||
        !nativeCurrentTarget.contains(row) ||
        proof.publication !== publication ||
        proof.nativeEvent !== nativeEvent ||
        proof.receiver !== proof.currentTarget ||
        proof.receiver !== proof.terminal ||
        terminal !== proof.receiver ||
        !findActionViewIsOwned(facts.view, nav, proof)
      ) {
        return;
      }
      const movement: FindActionMovement = FIND_ACTION_FREEZE({
        identity: Symbol("find first-row action movement"),
        key: resolved.key,
        sourceControl: resolved.sourceControl,
        destinationControl: resolved.destinationControl,
        source: resolved.source,
        destination: resolved.destination,
      });
      if (
        !firstRowMovementIsCurrent(runtime, publication, facts, movement) ||
        !runtime.publishedDomMatches()
      ) {
        return;
      }
      if (
        !firstRowAttemptIsCurrent(attempt) ||
        cells.activeActionDelivery.current ||
        findActionWeakHas(cells.actionPairs, nativeEvent) ||
        findActionTokenIsClaimed(cells.claimedActionTokens, nativeEvent) ||
        findActionTokenIsClaimed(cells.claimedActionTokens, event)
      ) {
        return;
      }
      rememberFirstRowPair(
        FIND_ACTION_FREEZE({
          publication,
          nativeEvent,
          facts,
          capture,
          proof,
          movement,
          publicationToken: FIND_ACTION_FREEZE({ publication }),
          sourceToken: FIND_ACTION_FREEZE({
            control: resolved.sourceControl,
            element: resolved.source,
          }),
          destinationToken: FIND_ACTION_FREEZE({
            control: resolved.destinationControl,
            element: resolved.destination,
          }),
          captureToken: FIND_ACTION_FREEZE({ capture }),
          nativeToken: FIND_ACTION_FREEZE({ nativeEvent }),
          windowToken: FIND_ACTION_FREEZE({
            listener: nav.listener,
            proof,
            receiver: proof.receiver,
          }),
        }),
      );
      unclaimedProof = null;
      unclaimedPublication = null;
      unclaimedListener = null;
    } finally {
      endFirstRowAttempt(attempt);
      if (unclaimedProof && unclaimedPublication && unclaimedListener) {
        unclaimedListener.releaseUnclaimed(
          unclaimedProof,
          unclaimedPublication,
          nativeEvent,
        );
      }
    }
  };

  const completeFirstRowNavigation = (
    control: FindControlPublication,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    let nativeEvent: unknown;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    if (!nativeEvent || typeof nativeEvent !== "object") return;
    const pair = findActionWeakGet(cells.actionPairs, nativeEvent);
    if (!pair || pair.nativeEvent !== nativeEvent || !firstRowPairIsPending(pair)) return;
    const attempt = beginFirstRowAttempt("bubble", event, nativeEvent);
    if (!attempt) return;
    try {
      // A. The rightful source bubble authenticates without consuming anything: the pending pair
      // stays in the WeakMap and in this publication's key set until the callback-free gate passes.
      const runtime = currentRuntime;
      const publication = runtime?.publication;
      const nav = runtime?.nav ?? null;
      if (
        !runtime ||
        !publication ||
        !nav ||
        runtime.isRetired() ||
        !nav.isCurrent() ||
        pair.publication !== publication ||
        pair.movement.sourceControl !== control ||
        event.currentTarget !== pair.movement.source
      ) {
        return;
      }
      const facts = nav.facts(nativeEvent);
      const proof = facts ? nav.listener.proofFor(nativeEvent, publication) : null;
      const bubble = facts && proof
        ? captureFindActionReactKey(
            event,
            nav,
            facts,
            nativeEvent,
            pair.movement.source,
            proof,
          )
        : null;
      if (
        !facts ||
        !proof ||
        !bubble ||
        bubble.event === pair.capture.event ||
        proof !== pair.proof ||
        facts.eventPhase !== FIND_ACTION_BUBBLING_PHASE ||
        pair.facts.eventPhase !== FIND_ACTION_CAPTURING_PHASE ||
        facts.currentTarget !== pair.facts.currentTarget ||
        facts.path[facts.path.length - 1] !== proof.receiver ||
        nav.intrinsics.propagationStopped(nativeEvent) ||
        !sameFindActionFacts(pair.facts, facts)
      ) {
        return;
      }
      const delivery: FindActionKeyDelivery = FIND_ACTION_FREEZE({ pair, bubble });
      // B. Every callback-capable pre-claim query runs here and finishes here, in this order: both
      // React predicates and public method identities, current movement and committed-row facts, the
      // exact listener proof, exact native facts, one final published-DOM walk, and the live authority
      // probe last. The retained observer drain then records whatever those operations queued.
      const readings = readFirstRowPredicates(pair, bubble, nav, facts, false);
      const commitment = readings
        ? firstRowMovementIsCurrent(runtime, publication, facts, pair.movement)
        : null;
      const movementRetained = !!commitment &&
        firstRowCommitmentIsRetained(
          commitment,
          pair.movement,
          FIND_ACTION_PUBLIC_READER,
        );
      const proofRetained = movementRetained &&
        nav.listener.proofFor(pair.nativeEvent, publication) === pair.proof;
      const current = proofRetained ? nav.facts(nativeEvent) : null;
      const domRetained = !!current && runtime.publishedDomMatches();
      const liveRetained = domRetained && probeLiveAuthority();
      const drained = liveRetained && runtime.drainObservedMutations();
      // C. Callback-free: nothing below can hand control to page code, so a pre-claim query that
      // mutated a wrapper, the live authority, the publication, or the DOM is rejected here — with
      // only this removable attempt cleared and the rightful pair still pending for this event.
      if (
        !readings ||
        !commitment ||
        !current ||
        !drained ||
        !firstRowGateIsExact(
          "pre-claim",
          runtime,
          publication,
          nav,
          delivery,
          attempt,
          commitment,
          current,
          readings,
        )
      ) {
        return;
      }
      // D. The one successful boundary: the listener's callback-free `holds` and its mark first,
      // then the pair's removal from both the WeakMap and the tracking set and every replay claim,
      // through retained collection intrinsics only, atomically and before any effect.
      const listener = nav.listener;
      const claimedPublication = publication;
      if (!claimFirstRowMovement(delivery, claimedPublication, listener, attempt)) return;
      try {
        // E. The single public effect: the exact bubble wrapper's own `preventDefault`, once.
        if (!nav.intrinsics.invoke(bubble.methods.preventDefault, bubble.event)) return;
        const prevented = nav.facts(nativeEvent);
        if (
          !prevented ||
          !prevented.defaultPrevented ||
          !sameFindActionFacts(pair.facts, prevented, true) ||
          prevented.currentTarget !== facts.currentTarget ||
          prevented.eventPhase !== facts.eventPhase ||
          nav.intrinsics.propagationStopped(nativeEvent)
        ) {
          return;
        }
        // F. Every callback-capable post-effect query, in the same order and for the last time:
        // wrappers, movement, listener proof, native facts, one final DOM walk, then live authority.
        // Only the retained mutation drain and callback-free exact gate follow.
        const finalReadings = readFirstRowPredicates(pair, bubble, nav, prevented, true);
        const committed = finalReadings
          ? firstRowMovementIsCurrent(runtime, publication, prevented, pair.movement)
          : null;
        const finalMovementRetained = !!committed &&
          firstRowCommitmentIsRetained(
            committed,
            pair.movement,
            FIND_ACTION_PUBLIC_READER,
          );
        const finalProofRetained = finalMovementRetained &&
          nav.listener.retains(pair.proof, publication);
        const finalFacts = finalProofRetained ? nav.facts(nativeEvent) : null;
        const finalDomRetained = !!finalFacts && runtime.publishedDomMatches();
        const finalLiveRetained = finalDomRetained && probeLiveAuthority();
        const finalDrained = finalLiveRetained && runtime.drainObservedMutations();
        // G. Immediately before owner-realm focus, and after nothing that can call page code.
        if (
          !finalReadings ||
          !committed ||
          !finalFacts ||
          !finalDrained ||
          !firstRowGateIsExact(
            "final",
            runtime,
            publication,
            nav,
            delivery,
            attempt,
            committed,
            finalFacts,
            finalReadings,
          )
        ) {
          return;
        }
        // The only operation after the gate: the already-retained owner-realm focus, applied
        // directly with the frozen options. No property lookup, no collection, no predicate, no
        // Window read, and no revalidation runs between the gate and the move.
        try {
          FIND_ACTION_APPLY(
            nav.intrinsics.focusMethod as (...args: unknown[]) => unknown,
            pair.movement.destination,
            [FIND_ACTION_PREVENT_SCROLL],
          );
        } catch {
          // A refused focus leaves this delivery consumed and nothing else changed.
        }
      } finally {
        // The terminal React bubble of the rightful source is over: the consumed proof is dropped
        // here — never on a rejected attempt — so a live native event cannot keep it reachable.
        finishFirstRowMovement(delivery);
        listener.finish(pair.proof, claimedPublication);
      }
    } finally {
      endFirstRowAttempt(attempt);
    }
  };

  const createRuntime = (): FindBarPublicationRuntime => {
    type Retirement = "element" | "layout" | "other";
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let domSnapshot: FindBarDomSnapshot | null = null;
    let placementSnapshot: FindBarPlacement | null = null;
    let replayRefs: RefReplay[] = [];
    let invalidReplay = false;
    let layoutRetired = false;
    let domChanged = false;
    let domObserver: MutationObserver | null = null;
    let keyboardListening = false;
    let replayGuardReleaseQueued = false;
    const root = bar.element();
    if (!root) throw new Error("Cannot create a FindBar publication without its root");
    const publishedRoot = root;
    const ownerDocument = root.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const keyboardIntrinsics = ownerWindow
      ? trustedFindKeyboardIntrinsics(ownerWindow)
      : null;
    const keyboardIntrinsicsAreCurrent = () =>
      !!ownerWindow &&
      trustedFindKeyboardIntrinsics(ownerWindow) === keyboardIntrinsics;
    /**
     * The action-local, descriptor-only proof of the very same keyboard-trust bindings. It is built
     * once, here, and is the only currentness question the callback-free gates and the action facts
     * read ever ask, so no Window constructor accessor is applied once a delivery is under way.
     */
    const keyboardDescriptorProof =
      ownerWindow && keyboardIntrinsics
        ? captureFindKeyboardDescriptorProof(keyboardIntrinsics, ownerWindow)
        : null;
    const keyboardDescriptorIsCurrent = () =>
      !!keyboardIntrinsics &&
      !!keyboardDescriptorProof &&
      keyboardDescriptorProof.intrinsics === keyboardIntrinsics &&
      keyboardDescriptorProof.isCurrent();
    const readActionFacts = (event: object) =>
      keyboardIntrinsics && keyboardDescriptorIsCurrent()
        ? readFindKeyboardFacts(keyboardIntrinsics, event, ownerDocument)
        : null;
    const actionIntrinsics = ownerWindow
      ? captureFindActionIntrinsics(ownerWindow)
      : null;
    const actionListener = actionIntrinsics
      ? createFindActionKeyListener(
          actionIntrinsics,
          ownerDocument,
          readActionFacts,
          (nativeEvent, currentPublication) => {
            const pair = findActionWeakGet(cells.actionPairs, nativeEvent);
            const pending = findActionMapGet(cells.pendingActionKeys, currentPublication);
            return (
              pair === undefined &&
              (!pending || !findActionSetHas(pending, nativeEvent))
            );
          },
        )
      : null;
    const nav: FindActionRuntimeView | null =
      actionIntrinsics && actionListener && keyboardIntrinsics && keyboardDescriptorProof
        ? FIND_ACTION_FREEZE({
            intrinsics: actionIntrinsics,
            listener: actionListener,
            ownerWindow: actionIntrinsics.ownerWindow,
            ownerDocument,
            root: publishedRoot,
            facts: readActionFacts,
            // The mutation-capable entry check keeps the full shared validation; it runs before the
            // first wrapper descriptor read of a delivery and never again.
            isCurrent: () =>
              keyboardIntrinsicsAreCurrent() &&
              keyboardDescriptorIsCurrent() &&
              actionIntrinsics.isCurrent() &&
              actionListener.isCurrent(),
            isDescriptorCurrent: () =>
              keyboardDescriptorIsCurrent() &&
              actionIntrinsics.isCurrent() &&
              actionListener.isCurrent(),
          })
        : null;
    const uninstallKeyboard = () => {
      actionListener?.release(publication);
      if (!keyboardListening) return;
      keyboardListening = false;
      root.removeEventListener("keydown", rememberKeyboard, true);
      ownerDocument.removeEventListener("keydown", deliverKeyboard);
    };
    const mutationIsRelevant = (record: MutationRecord) => {
      // React temporarily rewrites controlled input names while restoring their state.
      if (
        record.type === "attributes" &&
        record.attributeName === "name" &&
        (
          (record.target as Element).getAttribute?.("data-testid") === "find-input" ||
          (record.target as Element).getAttribute?.("data-testid") === "replace-input"
        )
      ) {
        return false;
      }
      if (record.target === root || root.contains(record.target)) return true;
      if (
        record.type === "attributes" &&
        (
          record.attributeName === "inert" ||
          record.attributeName === "aria-disabled" ||
          record.attributeName === "disabled"
        )
      ) {
        return record.target instanceof Node &&
          (root.contains(record.target) || record.target.contains(root));
      }
      if (record.type !== "childList") return false;
      if (record.target === placementSnapshot?.parent) return true;
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) => node === root || node.contains(root),
      );
    };
    const recordMutations = (records: readonly MutationRecord[]) => {
      if (!domChanged && records.some(mutationIsRelevant)) domChanged = true;
      return domChanged;
    };
    /**
     * The one way this publication ever empties the observer: the authenticated owner-realm
     * `MutationObserver.prototype.takeRecords`, applied directly to the observer. No lifecycle,
     * replay, retirement, or pre-gate drain looks the method up on the instance or the prototype, so
     * a page-owned replacement is never consulted and can never launder a queue by answering for it.
     * A drain the exact intrinsic cannot answer fails closed: the DOM counts as changed.
     */
    const drainObserver = (observer: MutationObserver) => {
      const records = actionIntrinsics
        ? actionIntrinsics.observerTakeRecords(observer)
        : null;
      if (!records) {
        domChanged = true;
        return false;
      }
      recordMutations(records);
      return true;
    };
    const releaseReplayGuard = () => {
      if (!domObserver) return;
      drainObserver(domObserver);
      actionIntrinsics?.observerDisconnect(domObserver);
      domObserver = null;
    };
    const queueReplayGuardRelease = () => {
      if (replayGuardReleaseQueued) return;
      replayGuardReleaseQueued = true;
      queueMicrotask(() => {
        if (!domObserver) return;
        drainObserver(domObserver);
        actionIntrinsics?.observerDisconnect(domObserver);
        domObserver = null;
      });
    };
    const noteMutations = (records: readonly MutationRecord[]) => {
      if (
        recordMutations(records) &&
        retire("element") &&
        !successorRequested
      ) {
        successorRequested = true;
        requestSuccessor();
      }
    };
    const noteDrainedMutations = (observer: MutationObserver) => {
      const drained = drainObserver(observer);
      if (domChanged && retire("element") && !successorRequested) {
        successorRequested = true;
        requestSuccessor();
      }
      return drained;
    };
    const retire = (reason: Retirement) => {
      if (retired) return false;
      if (domObserver) drainObserver(domObserver);
      retired = true;
      retirement = reason;
      if (cells.active.current === publication) {
        cells.active.current = null;
        cells.successorOf.current = publication;
      }
      // Retirement revokes this publication's first-row work: every pending pair is dropped from
      // both the tracking set and the WeakMap, and any attempt or delivery it owns is cleared, so a
      // stale handler can no longer reach it and no retired publication stays retained.
      revokeFirstRowWork(publication);
      cancelReplaceFocus(publication);
      if (currentRuntime?.publication === publication) currentRuntime = null;
      uninstallKeyboard();
      if (reason === "other") releaseReplayGuard();
      else queueReplayGuardRelease();
      return true;
    };
    const publication: FindBarPublication = Object.freeze({
      authority,
      retire: () => retire("other"),
      isRetired: () => retired,
      ownsInput: (kind: FindInput, element: HTMLInputElement) =>
        ownsInput(publication, kind, element),
      focusSearch: () => focusSearch(publication),
      scheduleReplaceFocus: () => scheduleReplaceFocus(publication),
    });
    function rememberKeyboard(event: Event) {
      if (
        !keyboardListening ||
        !keyboardIntrinsics ||
        !keyboardIntrinsicsAreCurrent() ||
        findActionTokenIsClaimed(cells.claimedActivations, event) ||
        !ownsAuthority(publication)
      ) {
        return;
      }
      const facts = readFindKeyboardFacts(
        keyboardIntrinsics,
        event,
        ownerDocument,
      );
      if (
        !facts ||
        facts.type !== "keydown" ||
        facts.key !== "F3" ||
        facts.code !== "F3" ||
        facts.repeat ||
        !facts.isTrusted ||
        !facts.view ||
        facts.view !== facts.ownerView ||
        facts.eventPhase === 0 ||
        facts.currentTarget !== publishedRoot ||
        !facts.bubbles ||
        !facts.cancelable ||
        facts.defaultPrevented ||
        facts.isComposing ||
        facts.altKey ||
        facts.ctrlKey ||
        facts.metaKey ||
        facts.activeElement !== facts.target ||
        !isCurrentKeyboardTarget(facts.target) ||
        facts.path[0] !== facts.target ||
        !findKeyboardPathIncludes(facts, publishedRoot) ||
        !findKeyboardPathIncludes(facts, ownerDocument)
      ) {
        return;
      }
      const delivery = freezeFindKeyboardRecord<FindKeyboardDelivery>({
        publication,
        facts,
      });
      findActionWeakSet(cells.keyboardDeliveries, event, delivery);
      const scheduled = scheduleFindKeyboardRecordExpiry(facts.view, () => {
        if (findActionWeakGet(cells.keyboardDeliveries, event) === delivery) {
          findActionWeakDelete(cells.keyboardDeliveries, event);
        }
      });
      if (!scheduled) findActionWeakDelete(cells.keyboardDeliveries, event);
    }
    const publishedDomMatches = () => {
      if (domObserver) noteDrainedMutations(domObserver);
      return (
        !domChanged &&
        !!domSnapshot &&
        !!placementSnapshot &&
        bar.element() === root &&
        root === domSnapshot.node &&
        root.isConnected &&
        findBarPlacementMatches(root, placementSnapshot) &&
        findBarDomMatches(domSnapshot)
      );
    };
    /**
     * The pre-final drain. `publishedDomMatches` takes records before it walks, so anything the walk
     * itself queues — a detach and reinsert at the exact original parent and sibling position above
     * all, which every placement read still accepts — is only visible to a drain that runs after it.
     * The records are taken through the authenticated owner-realm `MutationObserver.prototype`
     * method, drained until the queue is empty, and folded into the permanent history, so the
     * callback-free gate that follows reads a `domChanged` flag nothing is still hiding from.
     */
    const drainObservedMutations = () => {
      if (!actionIntrinsics) {
        domChanged = true;
        return false;
      }
      for (let pass = 0; pass < 4; pass += 1) {
        const observer = domObserver;
        if (!observer) return false;
        const records = actionIntrinsics.observerTakeRecords(observer);
        if (!records) {
          domChanged = true;
          return false;
        }
        noteMutations(records);
        if (domChanged || retired) return false;
        if (records.length === 0) return true;
      }
      return false;
    };
    const refsHaveNoReplay = () => {
      if (invalidReplay) return false;
      for (let index = 0; index < replayRefs.length; index += 1) {
        const entry = replayRefs[index];
        if (
          !entry ||
          entry.detached ||
          entry.reattached ||
          entry.owner.element() !== entry.element
        ) {
          return false;
        }
      }
      return true;
    };
    /**
     * The publication's own recorded history — established, never retired, no observed DOM change,
     * no ref replay, the exact published root still owned — read from closure state and owner
     * identity only, so the final gate can confirm it without one page-owned DOM operation.
     */
    const domHistoryIsRetained = () =>
      established &&
      !retired &&
      retirement === null &&
      !layoutRetired &&
      !domChanged &&
      !replayGuardReleaseQueued &&
      keyboardListening &&
      !!domObserver &&
      !!domSnapshot &&
      !!placementSnapshot &&
      bar.element() === root &&
      root === domSnapshot.node &&
      replayRefs.length > 0 &&
      refsHaveNoReplay();
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every((entry) =>
        entry.detached &&
        entry.reattached &&
        entry.owner.element() === entry.element);
    function deliverKeyboard(nativeEvent: Event) {
      const delivery = findActionWeakGet(cells.keyboardDeliveries, nativeEvent);
      const currentFacts = keyboardIntrinsics
        ? readFindKeyboardFacts(
            keyboardIntrinsics,
            nativeEvent,
            ownerDocument,
          )
        : null;
      if (
        !ownerWindow ||
        !keyboardIntrinsics ||
        !keyboardIntrinsicsAreCurrent() ||
        !delivery ||
        delivery.publication !== publication ||
        !currentFacts ||
        currentFacts.defaultPrevented ||
        !sameFindKeyboardDelivery(
          delivery.facts,
          currentFacts,
          publishedRoot,
          ownerDocument,
        ) ||
        !isCurrentKeyboardTarget(delivery.facts.target) ||
        !factsAreCurrent() ||
        !ownsAuthority(publication) ||
        !publishedDomMatches() ||
        !claim(nativeEvent) ||
        !factsAreCurrent() ||
        !ownsAuthority(publication) ||
        !publishedDomMatches()
      ) {
        return;
      }
      findActionWeakDelete(cells.keyboardDeliveries, nativeEvent);
      if (!preventFindKeyboardDefault(keyboardIntrinsics, nativeEvent)) return;
      if (
        !factsAreCurrent() ||
        !ownsAuthority(publication) ||
        !publishedDomMatches()
      ) {
        return;
      }
      if (!authority.actionsDisabled) {
        step(publication, delivery.facts.shiftKey ? -1 : 1);
      }
    }
    const runtime: FindBarPublicationRuntime = Object.freeze({
      publication,
      nav,
      publish: (
        snapshot: FindBarDomSnapshot,
        owners: readonly ElementOwnerView[],
      ) => {
        established = true;
        domSnapshot = snapshot;
        const root = bar.element();
        if (!root) throw new Error("Cannot publish a FindBar without its root");
        placementSnapshot = captureFindBarPlacement(root);
        if (!placementSnapshot) {
          throw new Error("Cannot publish a FindBar without a committed parent");
        }
        replayRefs = owners.map((owner) => {
          const element = owner.element();
          if (!element) throw new Error("Cannot publish a FindBar without every committed ref");
          return { owner, element, detached: false, reattached: false };
        });
        cells.active.current = publication;
        cells.successorOf.current = null;
        cells.replay.current = null;
        if (actionIntrinsics) {
          try {
            const observer = FIND_ACTION_CONSTRUCT(
              actionIntrinsics.mutationObserverConstructor,
              [(records: MutationRecord[]) => noteMutations(records)],
            ) as MutationObserver;
            const observing = actionIntrinsics.observerObserve(
              observer,
              ownerDocument,
              FIND_ACTION_FREEZE({
                attributes: true,
                characterData: true,
                childList: true,
                subtree: true,
              }),
            );
            if (observing) domObserver = observer;
            else {
              domChanged = true;
              actionIntrinsics.observerDisconnect(observer);
            }
          } catch {
            domChanged = true;
          }
        }
        if (keyboardIntrinsics) {
          keyboardListening = true;
          root.addEventListener("keydown", rememberKeyboard, true);
          ownerDocument.addEventListener("keydown", deliverKeyboard);
        }
        nav?.listener.activate(publication);
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
        if (element === null && previous === proof.element) {
          proof.detached = true;
          proof.reattached = false;
        } else if (
          element === proof.element &&
          previous === null &&
          proof.detached
        ) {
          proof.reattached = true;
        } else if (element !== previous) {
          invalidReplay = true;
        }
        if (
          !retired &&
          replayRefs.every((entry) => entry.owner.element() === entry.element)
        ) {
          for (const entry of replayRefs) {
            entry.detached = false;
            entry.reattached = false;
          }
          invalidReplay = false;
        }
      },
      isRetired: () => retired,
      publishedDomMatches,
      drainObservedMutations,
      domHistoryIsRetained,
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
      replayDomUnchanged: () => {
        if (domObserver) drainObserver(domObserver);
        return (
          !domChanged &&
          !!domSnapshot &&
          !!placementSnapshot &&
          root.isConnected &&
          findBarPlacementMatches(root, placementSnapshot) &&
          findBarDomMatches(domSnapshot)
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
        (lastRuntime.isExactLayoutReplay() || lastRuntime.isExactElementReplay()) &&
        cells.successorOf.current === lastRuntime.publication
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!factsAreCurrent() || !exactDomIsCurrent()) return undefined;
    const replay = cells.replay.current;
    const root = bar.element();
    if (!root) return undefined;
    if (
      replay &&
      (
        cells.successorOf.current !== replay.source ||
        !isExactReplaySuccessor(replay.source, authority) ||
        root !== replay.dom.node ||
        !findBarPlacementMatches(root, replay.placement) ||
        !findBarDomMatches(replay.dom) ||
        !replay.unchanged()
      )
    ) {
      const exactDomStillCommitted =
        root === replay.dom.node &&
        findBarPlacementMatches(root, replay.placement) &&
        findBarDomMatches(replay.dom) &&
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
    const publication = runtime.publication;
    const previous = cells.active.current;
    if (previous && previous !== publication) previous.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    runtime.publish(snapshotFindBarDom(root), expectedOwners());
    replay?.release();
    if (
      cells.focusRequest.current !== authority.focusRequest &&
      publication.focusSearch()
    ) {
      cells.focusRequest.current = authority.focusRequest;
    }

    const intent = cells.replaceIntent.current;
    if (intent && intent.source !== publication) {
      cells.replaceIntent.current = null;
      if (isExactReplaceSuccessor(intent.source, publication)) {
        publication.scheduleReplaceFocus();
      }
    }
    return runtime.retireForLayout;
  };

  const onBarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    if (!publication) return;
    const root = bar.element();
    if (!ownsBar(publication, event.currentTarget)) return;
    const target = event.target;
    if (
      !root ||
      !(target instanceof Node) ||
      !target.isConnected ||
      (target !== root && !root.contains(target)) ||
      event.key !== "Escape"
    ) return;
    closeFromKeyboard(publication, event);
  };

  return Object.freeze({
    captureBar: bar.capture,
    captureFirstRow: firstRow.capture,
    inputs: Object.freeze({ search, replace: replacement }),
    controls: Object.freeze(controls),
    establish,
    onBarKeyDown,
    onFirstRowKeyDownCapture: captureFirstRowNavigation,
  });
}

function OptionToggle({
  label,
  active,
  control,
  testId,
  children,
}: {
  label: string;
  active: boolean;
  control: FindControlPublication;
  testId: string;
  children: ReactNode;
}) {
  const { capture, onMouseDown, onClick } = control;
  return (
    <Tip label={label}>
      <button
        ref={capture}
        type="button"
        className="icon-btn h-7 w-7 rounded-md"
        data-active={active ? "true" : undefined}
        aria-pressed={active}
        aria-label={label}
        onMouseDown={onMouseDown}
        onClick={onClick}
        data-testid={testId}
      >
        {children}
      </button>
    </Tip>
  );
}

export function FindBar({
  session,
  replaceVisible,
  onReplaceVisible,
  focusNonce,
  onReveal,
  onClose,
}: FindBarProps) {
  const [mount] = useState(() => Symbol("find bar mount"));
  const visit = useMemo<FindBarVisit>(() => Object.freeze({ mount, session }), [mount, session]);
  const focusRequest = useMemo<SearchFocusRequest>(
    () => Object.freeze({ visit, focusNonce }),
    [focusNonce, visit],
  );
  const { find, canEdit, total, active } = useSessionValue(
    session,
    (current) => ({
      find: current.find,
      canEdit: current.canEdit,
      total: current.find?.matches.length ?? 0,
      active: current.find?.active ?? -1,
    }),
    shallowEqual,
  );
  const [replacementDraft, setReplacementDraft] = useState<ReplacementDraft>(
    () => ({ visit, value: "" }),
  );
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const [cells] = useState<PublicationCells>(() => ({
    active: new CurrentCell<FindBarPublication | null>(null),
    successorOf: new CurrentCell<FindBarPublication | null>(null),
    replay: new CurrentCell<FindBarReplay | null>(null),
    focusRequest: new CurrentCell<SearchFocusRequest | null>(null),
    replaceIntent: new CurrentCell<ReplaceFocusIntent | null>(null),
    replaceFocus: new CurrentCell<ReplaceFocusOwner | null>(null),
    claimedActivations: new WeakSet<object>(),
    claimedMouseDowns: new WeakSet<object>(),
    keyboardDeliveries: new WeakMap<object, FindKeyboardDelivery>(),
    actionPairs: new WeakMap<object, FindActionKeyPair>(),
    pendingActionKeys: new Map<FindBarPublication, Set<object>>(),
    actionAttemptReactEvents: new WeakSet<object>(),
    actionAttemptNativeEvents: new WeakSet<object>(),
    claimedActionDeliveries: new WeakSet<object>(),
    claimedActionTokens: new WeakSet<object>(),
    activeActionAttempt: new CurrentCell<FindActionAttempt | null>(null),
    activeActionDelivery: new CurrentCell<FindActionKeyDelivery | null>(null),
  }));
  const replacement = replacementDraft.visit === visit ? replacementDraft.value : "";
  const options = find?.options;
  const query = find?.query ?? "";
  const invalidRegex = options ? compileFindRegex(query, options).invalid : false;
  const showReplace = replaceVisible && canEdit;
  const noMatches = total === 0;
  const actionsDisabled = invalidRegex || noMatches;

  const publicationSet = find && options
    ? createFindBarPublication({
        authority: Object.freeze({
          visit,
          session,
          find,
          options,
          optionValues: Object.freeze({
            matchCase: options.matchCase,
            wholeWord: options.wholeWord,
            regex: options.regex,
          }),
          matches: find.matches,
          matchValues: Object.freeze(find.matches.map((match) =>
            Object.freeze({ from: match.from, to: match.to }))),
          query,
          replacement,
          canEdit,
          total,
          active,
          replaceVisible,
          showReplace,
          focusNonce,
          focusRequest,
          invalidRegex,
          noMatches,
          actionsDisabled,
          methods: Object.freeze({
            setFind: session.setFind,
            stepFind: session.stepFind,
            replaceActive: session.replaceActive,
            replaceAll: session.replaceAll,
          }),
          onReplaceVisible,
          onReveal,
          onClose,
        }),
        cells,
        setReplacementDraft,
        requestSuccessor: requestPublicationSuccessor,
      })
    : null;
  const lifecycle = publicationSet ?? createInactivePublication(cells);

  useLayoutEffect(() => lifecycle.establish(), [lifecycle]);

  if (!publicationSet || !options) return null;

  const {
    captureBar,
    captureFirstRow,
    inputs,
    controls,
    onBarKeyDown,
    onFirstRowKeyDownCapture,
  } = publicationSet;
  const { search: searchInput, replace: replaceInput } = inputs;
  const {
    matchCase,
    wholeWord,
    regex,
    previous,
    next,
    toggleReplace,
    close,
    replaceOne,
    replaceAll,
  } = controls;
  const {
    capture: captureSearch,
    onChange: onSearchChange,
    onKeyDown: onSearchKeyDown,
  } = searchInput;
  const {
    capture: captureReplace,
    onChange: onReplaceChange,
    onKeyDown: onReplaceKeyDown,
  } = replaceInput;
  const { capture: capturePrevious, onMouseDown: onPreviousMouseDown, onClick: onPreviousClick, onKeyDown: onPreviousKeyDown } = previous;
  const { capture: captureNext, onMouseDown: onNextMouseDown, onClick: onNextClick, onKeyDown: onNextKeyDown } = next;
  const {
    capture: captureToggleReplace,
    onMouseDown: onToggleReplaceMouseDown,
    onClick: onToggleReplaceClick,
    onKeyDown: onToggleReplaceKeyDown,
  } = toggleReplace;
  const { capture: captureClose, onClick: onCloseClick, onKeyDown: onCloseKeyDown } = close;
  const { capture: captureReplaceOne, onClick: onReplaceOneClick } = replaceOne;
  const { capture: captureReplaceAll, onClick: onReplaceAllClick } = replaceAll;
  const counter = query ? `${total === 0 ? 0 : active + 1} of ${total}` : "";
  return (
    <div
      ref={captureBar}
      className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-surface-2 px-3 py-1.5 text-[13px]"
      role="search"
      aria-label="Find and replace"
      data-testid="find-bar"
      onKeyDown={onBarKeyDown}
    >
      <div
        className="flex items-start gap-1.5"
        ref={captureFirstRow}
        data-testid="find-actions"
        onKeyDownCapture={onFirstRowKeyDownCapture}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" data-testid="find-row">
        <div className="flex h-8 min-w-[9rem] flex-1 items-center gap-0.5 rounded-lg md:w-[min(420px,40vw)] md:flex-none border border-line-2 bg-surface pl-2.5 pr-1 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
          <input
            ref={captureSearch}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
            placeholder="Find"
            value={query}
            onChange={onSearchChange}
            onKeyDown={onSearchKeyDown}
            spellCheck={false}
            autoComplete="off"
            aria-label="Find"
            aria-invalid={invalidRegex}
            aria-describedby={invalidRegex ? "find-regex-error" : undefined}
            data-testid="find-input"
          />
          <OptionToggle label="Match case" active={options.matchCase} control={matchCase} testId="find-match-case">
            <CaseSensitive size={15} />
          </OptionToggle>
          <OptionToggle label="Whole word" active={options.wholeWord} control={wholeWord} testId="find-whole-word">
            <WholeWord size={15} />
          </OptionToggle>
          <OptionToggle label="Regular expression" active={options.regex} control={regex} testId="find-regex">
            <Regex size={15} />
          </OptionToggle>
        </div>
        {invalidRegex ? (
          <span id="find-regex-error" className="min-w-[72px] whitespace-nowrap px-1 text-danger" role="status" data-testid="find-regex-error">
            Invalid regular expression
          </span>
        ) : (
          <span className={cn("min-w-[72px] px-1 tabular-nums", noMatches && query ? "text-danger" : "text-ink-3")} aria-live="polite" data-testid="find-count">
            {counter}
          </span>
        )}
        <Tip label="Previous match" shortcut={shortcut("Shift-Enter")}>
          <button
            ref={capturePrevious}
            type="button"
            className="icon-btn h-7 w-7 rounded-md"
            disabled={actionsDisabled}
            onMouseDown={onPreviousMouseDown}
            onClick={onPreviousClick}
            onKeyDown={onPreviousKeyDown}
            aria-label="Previous match"
            data-testid="find-prev"
          >
            <ChevronUp size={16} />
          </button>
        </Tip>
        <Tip label="Next match" shortcut="Enter">
          <button
            ref={captureNext}
            type="button"
            className="icon-btn h-7 w-7 rounded-md"
            disabled={actionsDisabled}
            onMouseDown={onNextMouseDown}
            onClick={onNextClick}
            onKeyDown={onNextKeyDown}
            aria-label="Next match"
            data-testid="find-next"
          >
            <ChevronDown size={16} />
          </button>
        </Tip>
        {canEdit && (
          <Tip label={replaceVisible ? "Hide replace" : "Replace"} shortcut={replaceVisible ? undefined : shortcut(findReplaceShortcut())}>
            <button
              ref={captureToggleReplace}
              type="button"
              className={cn("btn btn-ghost h-8 shrink-0 gap-1.5 px-2 text-[13px]", replaceVisible && "bg-surface-3 text-ink")}
              onMouseDown={onToggleReplaceMouseDown}
              onClick={onToggleReplaceClick}
              onKeyDown={onToggleReplaceKeyDown}
              aria-expanded={replaceVisible}
              aria-controls="find-replace-row"
              data-testid="find-toggle-replace"
            >
              <Replace size={15} aria-hidden="true" />
              {/* Icon only below 640 px so the row keeps its one-line shape on phones. */}
              <span className="sr-only sm:not-sr-only">{replaceVisible ? "Hide replace" : "Replace"}</span>
            </button>
          </Tip>
        )}
        <div className="flex-1" />
        </div>
        {/* Outside the wrapping row so it stays pinned top-right when the controls wrap on phones. */}
        <Tip label="Close" shortcut="Esc">
          <button
            ref={captureClose}
            type="button"
            className="icon-btn mt-0.5 h-7 w-7 shrink-0 rounded-md"
            onClick={onCloseClick}
            onKeyDown={onCloseKeyDown}
            aria-label="Close find"
            data-testid="find-close"
          >
            <X size={15} />
          </button>
        </Tip>
      </div>
      {showReplace && (
        <div id="find-replace-row" className="flex flex-wrap items-center gap-1.5" data-testid="find-replace-row">
          <div className="min-w-[9rem] flex-1 md:w-[min(420px,40vw)] md:flex-none">
            <input
              ref={captureReplace}
              className="input h-8 text-[13px]"
              placeholder="Replace with"
              value={replacement}
              onChange={onReplaceChange}
              onKeyDown={onReplaceKeyDown}
              spellCheck={false}
              autoComplete="off"
              aria-label="Replace with"
              data-testid="replace-input"
            />
          </div>
          <button
            ref={captureReplaceOne}
            type="button"
            className="btn btn-outline h-8 shrink-0 whitespace-nowrap px-2.5 text-[13px]"
            disabled={actionsDisabled}
            onClick={onReplaceOneClick}
            data-testid="replace-one"
          >
            Replace
          </button>
          <button
            ref={captureReplaceAll}
            type="button"
            className="btn btn-outline h-8 shrink-0 whitespace-nowrap px-2.5 text-[13px]"
            disabled={actionsDisabled}
            onClick={onReplaceAllClick}
            data-testid="replace-all"
          >
            Replace all
          </button>
        </div>
      )}
    </div>
  );
}
