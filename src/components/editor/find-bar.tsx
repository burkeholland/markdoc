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
  readonly attemptedActionReactEvents: WeakSet<object>;
  readonly attemptedActionNativeEvents: WeakSet<object>;
  readonly claimedActionDeliveries: WeakSet<object>;
  readonly claimedActionTokens: WeakSet<object>;
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
const FIND_ACTION_CAPTURING_PHASE = 1;
const FIND_ACTION_BUBBLING_PHASE = 3;

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
  readonly addEventListener: FindActionMember<Window["addEventListener"]>;
  readonly removeEventListener: FindActionMember<Window["removeEventListener"]>;
  readonly isCurrent: () => boolean;
  readonly methodMatches: (
    value: object,
    property: PropertyKey,
    method: unknown,
  ) => boolean;
  readonly read: (method: AnyFunction, receiver: object) => unknown;
  readonly invoke: (method: AnyFunction, receiver: object) => boolean;
  readonly propagationStopped: (event: object) => boolean;
  readonly focusWithoutScroll: (element: HTMLElement) => boolean;
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
  readonly claim: (
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
    for (
      let node: HTMLElement | null = element;
      node;
      node = node.parentElement
    ) {
      if (
        node.hasAttribute("inert") ||
        node.getAttribute("aria-disabled")?.toLowerCase() === "true"
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function findActionDescriptorsMatch(
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
      current.writable === expected.writable,
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

function captureFindActionWindowMethod<
  Property extends "addEventListener" | "removeEventListener",
>(
  ownerWindow: Window & typeof globalThis,
  property: Property,
): FindActionMember<Window[Property]> | null {
  try {
    const chain: {
      readonly owner: object;
      readonly descriptor: PropertyDescriptor | null;
      readonly prototype: object | null;
    }[] = [];
    let owner: object | null = ownerWindow;
    let holder: object | null = null;
    while (owner) {
      const descriptor = FIND_ACTION_OWN_DESCRIPTOR(owner, property) ?? null;
      const prototype = FIND_ACTION_PROTOTYPE_OF(owner) as object | null;
      chain.push(
        FIND_ACTION_FREEZE({
          owner,
          descriptor: descriptor ? FIND_ACTION_FREEZE({ ...descriptor }) : null,
          prototype,
        }),
      );
      if (descriptor) {
        holder = owner;
        break;
      }
      owner = prototype;
    }
    if (!holder) return null;
    const holdingOwner = holder;
    // The unit realm publishes the Window's registration methods as own accessors, not data slots.
    const readValue = () => {
      const descriptor = FIND_ACTION_OWN_DESCRIPTOR(holdingOwner, property);
      if (!descriptor) return undefined;
      if ("value" in descriptor) return descriptor.value as unknown;
      return typeof descriptor.get === "function"
        ? FIND_ACTION_APPLY(
            descriptor.get as (...args: unknown[]) => unknown,
            ownerWindow,
            [],
          )
        : undefined;
    };
    const value = readValue();
    if (typeof value !== "function") return null;
    const isCurrent = () => {
      try {
        return chain.every(({ owner: entry, descriptor, prototype }) =>
          FIND_ACTION_PROTOTYPE_OF(entry) === prototype &&
          (descriptor
            ? findActionDescriptorsMatch(
                FIND_ACTION_OWN_DESCRIPTOR(entry, property),
                descriptor,
              )
            : FIND_ACTION_OWN_DESCRIPTOR(entry, property) === undefined)) &&
          readValue() === value;
      } catch {
        return false;
      }
    };
    return isCurrent()
      ? FIND_ACTION_FREEZE({ value: value as Window[Property], isCurrent })
      : null;
  } catch {
    return null;
  }
}

function captureFindActionIntrinsics(view: Window): FindActionIntrinsics | null {
  try {
    const ownerWindow = view as Window & typeof globalThis;
    const htmlElement = ownerWindow.HTMLElement;
    const eventConstructor = ownerWindow.Event;
    const nodeConstructor = ownerWindow.Node;
    if (
      typeof htmlElement !== "function" ||
      typeof eventConstructor !== "function" ||
      typeof nodeConstructor !== "function"
    ) {
      return null;
    }
    const htmlElementPrototype = htmlElement.prototype;
    const eventPrototype = eventConstructor.prototype;
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
    const addEventListener = captureFindActionWindowMethod(
      ownerWindow,
      "addEventListener",
    );
    const removeEventListener = captureFindActionWindowMethod(
      ownerWindow,
      "removeEventListener",
    );
    if (!focus || !cancelBubble || !addEventListener || !removeEventListener) {
      return null;
    }
    const isCurrent = () => {
      try {
        return (
          ownerWindow.HTMLElement === htmlElement &&
          ownerWindow.Event === eventConstructor &&
          ownerWindow.Node === nodeConstructor &&
          htmlElement.prototype === htmlElementPrototype &&
          eventConstructor.prototype === eventPrototype &&
          focus.isCurrent() &&
          cancelBubble.isCurrent() &&
          addEventListener.isCurrent() &&
          removeEventListener.isCurrent()
        );
      } catch {
        return false;
      }
    };
    return FIND_ACTION_FREEZE({
      ownerWindow,
      nodeConstructor,
      addEventListener,
      removeEventListener,
      isCurrent,
      methodMatches: (value: object, property: PropertyKey, method: unknown) => {
        if (!isCurrent() || typeof method !== "function") return false;
        try {
          let owner: object | null = value;
          while (owner) {
            const descriptor = FIND_ACTION_OWN_DESCRIPTOR(owner, property);
            if (descriptor) {
              return "value" in descriptor && descriptor.value === method;
            }
            owner = FIND_ACTION_PROTOTYPE_OF(owner) as object | null;
          }
          return false;
        } catch {
          return false;
        }
      },
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
      focusWithoutScroll: (element: HTMLElement) => {
        if (!isCurrent()) return false;
        try {
          FIND_ACTION_APPLY(
            focus.value as (...args: unknown[]) => unknown,
            element,
            [FIND_ACTION_PREVENT_SCROLL],
          );
          return true;
        } catch {
          return false;
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
): FindActionKeyListener {
  const proofs = new WeakMap<object, FindActionWindowProof>();
  const invalidEvents = new WeakSet<object>();
  const claimedEvents = new WeakSet<object>();
  let publication: FindBarPublication | null = null;
  let active = false;
  let released = false;

  const listener = function (this: EventTarget, event: Event) {
    const current = publication;
    if (
      !current ||
      !active ||
      released ||
      !intrinsics.isCurrent() ||
      invalidEvents.has(event)
    ) {
      return;
    }
    if (proofs.has(event)) {
      invalidEvents.add(event);
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
      invalidEvents.add(event);
      return;
    }
    proofs.set(
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
    const proof = proofs.get(event);
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
      claimedEvents.has(event) ||
      invalidEvents.has(event) ||
      !intrinsics.isCurrent()
    ) {
      return null;
    }
    const facts = readFacts(event);
    return facts &&
      facts.path.length === proof.path.length &&
      facts.path.every((entry, index) => entry === proof.path[index]) &&
      facts.path[facts.path.length - 2] === ownerDocument &&
      facts.path[facts.path.length - 1] === proof.receiver
      ? proof
      : null;
  };

  const registration: FindActionKeyListener = FIND_ACTION_FREEZE({
    proofFor,
    claim: (proof: FindActionWindowProof, current: FindBarPublication) => {
      if (
        claimedEvents.has(proof.nativeEvent) ||
        proofFor(proof.nativeEvent, current) !== proof
      ) {
        return false;
      }
      claimedEvents.add(proof.nativeEvent);
      return true;
    },
    retains: (proof: FindActionWindowProof, current: FindBarPublication) =>
      publication === current &&
      proof.publication === current &&
      proofs.get(proof.nativeEvent) === proof &&
      claimedEvents.has(proof.nativeEvent) &&
      !invalidEvents.has(proof.nativeEvent) &&
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

function findActionViewIsOwned(
  view: unknown,
  nav: FindActionRuntimeView,
  proof: FindActionWindowProof,
) {
  return (
    view === null ||
    view === undefined ||
    Object.is(view, nav.ownerWindow) ||
    Object.is(view, proof.receiver)
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
      Object.is(event.view as unknown, snapshot.view) &&
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
  const claim = (...events: object[]) => {
    if (events.some((event) => cells.claimedActivations.has(event))) return false;
    for (const event of events) cells.claimedActivations.add(event);
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
    controlOwners.set(id, owner);
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
                cells.claimedMouseDowns.has(event)
              ) return;
              cells.claimedMouseDowns.add(event);
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
    ...expectedControls().map((control) => controlOwners.get(control.id)!),
    ...(authority.showReplace ? [replaceOwner] : []),
  ];
  const isCurrentKeyboardTarget = (target: Node) =>
    target === searchOwner.element() ||
    (authority.showReplace && target === replaceOwner.element()) ||
    expectedControls().some((control) =>
      target === controlOwners.get(control.id)?.element());
  const exactDomIsCurrent = () => {
    const root = bar.element();
    const rowElement = firstRow.element();
    const searchElement = searchOwner.element();
    const replaceElement = replaceOwner.element();
    const controlElements = expectedControls().map((control) =>
      controlOwners.get(control.id)?.element());
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

  const firstRowActionControls = (): readonly FindControlPublication[] => [
    controls.previous,
    controls.next,
    ...(authority.canEdit ? [controls.toggleReplace] : []),
    controls.close,
  ];

  /**
   * The bounded group: the current enabled first-row actions in exact committed DOM order. Anything
   * missing, detached, reordered, or outside the published row collapses the whole group.
   */
  const currentFirstRowActions = (publication: FindBarPublication) => {
    const root = bar.element();
    const row = firstRow.element();
    if (!root || !row || !row.isConnected || row.parentNode !== root) return null;
    if (!ownsAuthority(publication)) return null;
    const expected: { control: FindControlPublication; element: HTMLButtonElement }[] = [];
    for (const control of firstRowActionControls()) {
      const owner = controlOwners.get(control.id);
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
      expected.push({ control, element });
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
  ) => {
    const resolved = resolveFirstRowMovement(publication, movement.source, movement.key);
    const sourceOwner = controlOwners.get(movement.sourceControl.id);
    const destinationOwner = controlOwners.get(movement.destinationControl.id);
    return Boolean(
      currentRuntime === runtime &&
        !runtime.isRetired() &&
        runtime.publication === publication &&
        cells.active.current === publication &&
        runtime.nav?.isCurrent() === true &&
        resolved &&
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
        exactDomIsCurrent() &&
        runtime.publishedDomMatches(),
    );
  };

  const prepareFirstRowCapture = (event: object, nativeEvent: object) => {
    if (
      cells.activeActionDelivery.current ||
      cells.attemptedActionReactEvents.has(event) ||
      cells.attemptedActionNativeEvents.has(nativeEvent)
    ) {
      return false;
    }
    cells.attemptedActionReactEvents.add(event);
    cells.attemptedActionNativeEvents.add(nativeEvent);
    return true;
  };

  const prepareFirstRowBubble = (event: object, nativeEvent: object) => {
    if (
      cells.activeActionDelivery.current ||
      cells.attemptedActionReactEvents.has(event) ||
      !cells.attemptedActionNativeEvents.has(nativeEvent)
    ) {
      return false;
    }
    cells.attemptedActionReactEvents.add(event);
    return true;
  };

  const firstRowTokens = (pair: FindActionKeyPair): readonly object[] => [
    pair.publicationToken,
    pair.sourceToken,
    pair.destinationToken,
    pair.captureToken,
    pair.nativeToken,
    pair.windowToken,
  ];

  const claimFirstRowMovement = (
    delivery: FindActionKeyDelivery,
    publication: FindBarPublication,
    listener: FindActionKeyListener,
  ) => {
    const { pair, bubble } = delivery;
    if (
      cells.activeActionDelivery.current ||
      cells.active.current !== publication ||
      pair.publication !== publication ||
      cells.claimedActionDeliveries.has(delivery) ||
      cells.claimedActionDeliveries.has(pair) ||
      cells.claimedActionDeliveries.has(pair.movement) ||
      firstRowTokens(pair).some((token) => cells.claimedActionTokens.has(token)) ||
      cells.claimedActionTokens.has(pair.capture.event) ||
      cells.claimedActionTokens.has(bubble.event) ||
      cells.claimedActionTokens.has(pair.nativeEvent) ||
      !cells.attemptedActionReactEvents.has(pair.capture.event) ||
      !cells.attemptedActionReactEvents.has(bubble.event) ||
      !cells.attemptedActionNativeEvents.has(pair.nativeEvent) ||
      !listener.claim(pair.proof, publication)
    ) {
      return false;
    }
    cells.claimedActionDeliveries.add(delivery);
    cells.claimedActionDeliveries.add(pair);
    cells.claimedActionDeliveries.add(pair.movement);
    for (const token of firstRowTokens(pair)) cells.claimedActionTokens.add(token);
    cells.claimedActionTokens.add(pair.capture.event);
    cells.claimedActionTokens.add(bubble.event);
    cells.claimedActionTokens.add(pair.nativeEvent);
    cells.activeActionDelivery.current = delivery;
    return true;
  };

  const firstRowMovementIsDelivering = (
    delivery: FindActionKeyDelivery,
    publication: FindBarPublication,
  ) =>
    cells.activeActionDelivery.current === delivery &&
    cells.claimedActionDeliveries.has(delivery) &&
    cells.claimedActionDeliveries.has(delivery.pair) &&
    cells.claimedActionDeliveries.has(delivery.pair.movement) &&
    firstRowTokens(delivery.pair).every((token) =>
      cells.claimedActionTokens.has(token)) &&
    cells.claimedActionTokens.has(delivery.pair.capture.event) &&
    cells.claimedActionTokens.has(delivery.bubble.event) &&
    cells.claimedActionTokens.has(delivery.pair.nativeEvent) &&
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
      event.currentTarget !== row ||
      cells.actionPairs.has(nativeEvent)
    ) {
      return;
    }
    const facts = nav.facts(nativeEvent);
    if (!facts || facts.type !== "keydown" || !isFindActionKey(facts.key)) return;
    if (!prepareFirstRowCapture(event, nativeEvent)) return;
    const proof = nav.listener.proofFor(nativeEvent, publication);
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
    if (!firstRowMovementIsCurrent(runtime, publication, facts, movement)) return;
    cells.actionPairs.set(
      nativeEvent,
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
    const pair = nativeEvent && typeof nativeEvent === "object"
      ? cells.actionPairs.get(nativeEvent)
      : undefined;
    if (
      !pair ||
      !nativeEvent ||
      typeof nativeEvent !== "object" ||
      pair.nativeEvent !== nativeEvent ||
      !prepareFirstRowBubble(event, nativeEvent)
    ) {
      return;
    }
    cells.actionPairs.delete(nativeEvent);
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
      !sameFindActionFacts(pair.facts, facts) ||
      !findActionReactRemainsExact(pair.capture, nav, pair.facts, proof, null) ||
      !findActionReactRemainsExact(
        bubble,
        nav,
        facts,
        proof,
        pair.movement.source,
      ) ||
      !firstRowMovementIsCurrent(runtime, publication, facts, pair.movement)
    ) {
      return;
    }
    const delivery: FindActionKeyDelivery = FIND_ACTION_FREEZE({ pair, bubble });
    if (!claimFirstRowMovement(delivery, publication, nav.listener)) return;
    try {
      if (
        !firstRowMovementIsDelivering(delivery, publication) ||
        !nav.listener.retains(pair.proof, publication) ||
        !findActionReactRemainsExact(pair.capture, nav, pair.facts, proof, null) ||
        !findActionReactRemainsExact(
          bubble,
          nav,
          facts,
          proof,
          pair.movement.source,
        ) ||
        !firstRowMovementIsCurrent(runtime, publication, facts, pair.movement) ||
        !nav.intrinsics.invoke(bubble.methods.preventDefault, bubble.event)
      ) {
        return;
      }
      const prevented = nav.facts(nativeEvent);
      if (
        !prevented ||
        !prevented.defaultPrevented ||
        !sameFindActionFacts(pair.facts, prevented, true) ||
        prevented.currentTarget !== facts.currentTarget ||
        prevented.eventPhase !== facts.eventPhase ||
        nav.intrinsics.propagationStopped(nativeEvent) ||
        !nav.listener.retains(pair.proof, publication) ||
        !firstRowMovementIsDelivering(delivery, publication) ||
        !findActionReactRemainsExact(pair.capture, nav, pair.facts, proof, null) ||
        !findActionReactRemainsExact(
          bubble,
          nav,
          prevented,
          proof,
          pair.movement.source,
          true,
        ) ||
        !firstRowMovementIsCurrent(runtime, publication, prevented, pair.movement)
      ) {
        return;
      }
      nav.intrinsics.focusWithoutScroll(pair.movement.destination);
    } finally {
      finishFirstRowMovement(delivery);
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
    const readActionFacts = (event: object) =>
      keyboardIntrinsics && keyboardIntrinsicsAreCurrent()
        ? readFindKeyboardFacts(keyboardIntrinsics, event, ownerDocument)
        : null;
    const actionIntrinsics = ownerWindow
      ? captureFindActionIntrinsics(ownerWindow)
      : null;
    const actionListener = actionIntrinsics
      ? createFindActionKeyListener(actionIntrinsics, ownerDocument, readActionFacts)
      : null;
    const nav: FindActionRuntimeView | null =
      actionIntrinsics && actionListener && keyboardIntrinsics
        ? FIND_ACTION_FREEZE({
            intrinsics: actionIntrinsics,
            listener: actionListener,
            ownerWindow: actionIntrinsics.ownerWindow,
            ownerDocument,
            root: publishedRoot,
            facts: readActionFacts,
            isCurrent: () =>
              keyboardIntrinsicsAreCurrent() &&
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
    const releaseReplayGuard = () => {
      if (!domObserver) return;
      recordMutations(domObserver.takeRecords());
      domObserver.disconnect();
      domObserver = null;
    };
    const queueReplayGuardRelease = () => {
      if (replayGuardReleaseQueued) return;
      replayGuardReleaseQueued = true;
      queueMicrotask(() => {
        if (!domObserver) return;
        recordMutations(domObserver.takeRecords());
        domObserver.disconnect();
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
    const retire = (reason: Retirement) => {
      if (retired) return false;
      if (domObserver) recordMutations(domObserver.takeRecords());
      retired = true;
      retirement = reason;
      if (cells.active.current === publication) {
        cells.active.current = null;
        cells.successorOf.current = publication;
      }
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
        cells.claimedActivations.has(event) ||
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
      cells.keyboardDeliveries.set(event, delivery);
      const scheduled = scheduleFindKeyboardRecordExpiry(facts.view, () => {
        if (cells.keyboardDeliveries.get(event) === delivery) {
          cells.keyboardDeliveries.delete(event);
        }
      });
      if (!scheduled) cells.keyboardDeliveries.delete(event);
    }
    const publishedDomMatches = () => {
      if (domObserver) noteMutations(domObserver.takeRecords());
      return Boolean(
        !domChanged &&
        domSnapshot &&
        placementSnapshot &&
        bar.element() === root &&
        root === domSnapshot.node &&
        root.isConnected &&
        findBarPlacementMatches(root, placementSnapshot) &&
        findBarDomMatches(domSnapshot)
      );
    };
    const refsHaveNoReplay = () =>
      !invalidReplay &&
      replayRefs.every((entry) =>
        !entry.detached &&
        !entry.reattached &&
        entry.owner.element() === entry.element);
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every((entry) =>
        entry.detached &&
        entry.reattached &&
        entry.owner.element() === entry.element);
    function deliverKeyboard(nativeEvent: Event) {
      const delivery = cells.keyboardDeliveries.get(nativeEvent);
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
      cells.keyboardDeliveries.delete(nativeEvent);
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
        const MutationObserverConstructor = ownerWindow?.MutationObserver;
        if (MutationObserverConstructor) {
          domObserver = new MutationObserverConstructor((records) => {
            noteMutations(records);
          });
          domObserver.observe(ownerDocument, {
            attributes: true,
            characterData: true,
            childList: true,
            subtree: true,
          });
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
        if (domObserver) recordMutations(domObserver.takeRecords());
        return Boolean(
          !domChanged &&
          domSnapshot &&
          placementSnapshot &&
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
    attemptedActionReactEvents: new WeakSet<object>(),
    attemptedActionNativeEvents: new WeakSet<object>(),
    claimedActionDeliveries: new WeakSet<object>(),
    claimedActionTokens: new WeakSet<object>(),
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
