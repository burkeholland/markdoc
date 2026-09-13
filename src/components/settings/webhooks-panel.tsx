"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefCallback,
} from "react";
import { Check, Copy, Loader2, Plus, Power, RefreshCw, Send, Trash2, Webhook } from "lucide-react";
import { relativeTime } from "@/lib/utils";
import { useCopy } from "@/lib/hooks";
import { ApiError, apiErrorText } from "@/lib/api";

interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  documentIds: string[] | null;
  active: boolean;
  failures: number;
  createdAt: string;
  lastDelivery: { status: number; at: string; attempt: number; event: string } | null;
}

interface MountGeneration {
  readonly identity: symbol;
}

interface Operation {
  readonly sequence: number;
  readonly generation: MountGeneration;
}

interface RowOperation extends Operation {
  readonly webhookId: string;
  readonly kind: "test" | "enable" | "delete";
}

interface CreatedWebhook {
  id: string;
  secret: string;
  url: string;
}

type DeliveryTone = "ok" | "bad" | "muted";
type PanelActionKind = "add" | "cancel" | "copy" | "create" | "refresh" | "retry";
type RowActionKind = RowOperation["kind"];

type ActionFacts = Readonly<{
  kind: PanelActionKind;
  eligible: boolean;
  route: string | null;
}>;

type CreateControlFacts = readonly [create: ActionFacts, cancel: ActionFacts];
type ListOperationIntent = "refresh" | "retry";
type ListRequestAuthority = Readonly<{ identity: symbol }>;
type ListRequestCallback = (operation: ListOperation) => void;

type ListOperationBinding = Readonly<{
  activation: PanelPublication;
  action: ActionFacts;
  root: HTMLDivElement;
  document: Document;
  placement: PanelPlacement;
}>;

type ListOperationAuthority = Readonly<{
  read: () => ListOperationBinding | null;
  release: () => void;
}>;

class RetiredListOperationAbort extends DOMException {
  readonly authority: ListOperationAuthority;

  constructor(authority: ListOperationAuthority) {
    super("The retired Webhooks list request was aborted.", "AbortError");
    this.authority = authority;
  }
}

interface ListOperation extends Operation {
  readonly intent: ListOperationIntent;
  readonly requestSequence: number;
  readonly request: ListRequestAuthority;
  readonly route: "/api/webhooks";
  readonly controller: AbortController;
  readonly abortReason: RetiredListOperationAbort;
  readonly authority: ListOperationAuthority;
}

type DraftInputFacts = Readonly<{
  kind: "url" | "docs";
  value: string;
  eligible: boolean;
}>;

type ChoiceFacts = Readonly<{
  kind: "choice";
  index: number;
  id: string;
  label: string;
  types: readonly string[];
  checked: boolean;
  eligible: boolean;
}>;

type DraftFacts = Readonly<{
  url: string;
  docs: string;
  choices: readonly string[];
  urlInput: DraftInputFacts;
  docsInput: DraftInputFacts;
  choiceInputs: readonly ChoiceFacts[];
}>;

type LastDeliveryFacts = Readonly<{
  status: number;
  at: string;
  attempt: number;
  event: string;
}>;

type RowActionFacts = Readonly<{
  kind: RowActionKind;
  eligible: boolean;
  route: string;
}>;

type WebhookRowFacts = Readonly<{
  source: WebhookRow;
  index: number;
  id: string;
  url: string;
  events: readonly string[];
  documentIds: readonly string[] | null;
  active: boolean;
  failures: number;
  createdAt: string;
  lastDelivery: LastDeliveryFacts | null;
  details: string;
  statusText: string;
  statusTone: DeliveryTone;
  operation: RowOperation | null;
  enable: RowActionFacts | null;
  test: RowActionFacts;
  delete: RowActionFacts;
}>;

type CreatedFacts = Readonly<{
  source: CreatedWebhook;
  id: string;
  secret: string;
  url: string;
}>;

type ListFacts = Readonly<{
  kind: "loading" | "unavailable" | "empty" | "rows";
  rows: readonly WebhookRowFacts[] | null;
}>;

type PanelPresentation = Readonly<{
  identity: symbol;
  revision: number;
  callbackToken: symbol;
  generation: MountGeneration;
  hooksSource: WebhookRow[] | null;
  choicesSource: string[];
  rowOperationsSource: Map<string, RowOperation>;
  createdSource: CreatedWebhook | null;
  adding: boolean;
  draft: DraftFacts;
  createOperation: Operation | null;
  listOperation: ListOperation | null;
  feedbackOperation: Operation | null;
  requestList: ListRequestAuthority;
  listError: string | null;
  actionError: string | null;
  created: CreatedFacts | null;
  list: ListFacts;
  add: ActionFacts;
  refresh: ActionFacts;
  create: ActionFacts | null;
  cancel: ActionFacts | null;
  createControls: CreateControlFacts | null;
  retry: ActionFacts | null;
  copy: ActionFacts | null;
  copyLabel: string;
  copied: boolean;
}>;

interface InputDomOverride {
  input: HTMLInputElement;
  value?: string;
  checked?: boolean;
}

interface ElementSlot<T extends HTMLElement> {
  readonly key: string;
  element: T | null;
  last: T | null;
  mouseTargets: readonly Node[] | null;
  binding: RefCallback<T> | null;
}

type FormKeyboardRefTarget = Readonly<{
  owner: ElementSlot<HTMLElement>;
  element: HTMLElement;
  binding: RefCallback<HTMLElement>;
}>;

interface FormKeyboardRefReplayTarget extends FormKeyboardRefTarget {
  released: boolean;
  rebound: boolean;
}

interface FormKeyboardRefReplay {
  readonly publication: PanelPublication;
  readonly presentation: PanelPresentation;
  readonly generation: MountGeneration;
  readonly targets: readonly FormKeyboardRefReplayTarget[];
  layoutReleased: boolean;
  layoutRebound: boolean;
  expired: boolean;
}

interface RowElements {
  root: ElementSlot<HTMLLIElement>;
  enable: ElementSlot<HTMLButtonElement>;
  test: ElementSlot<HTMLButtonElement>;
  delete: ElementSlot<HTMLButtonElement>;
  publication: PublishedWebhookRow | null;
}

interface PanelPublication {
  readonly identity: symbol;
  presentation: PanelPresentation;
  card: ElementSlot<HTMLDivElement>;
  header: ElementSlot<HTMLDivElement>;
  guidance: ElementSlot<HTMLParagraphElement>;
  refresh: ElementSlot<HTMLButtonElement>;
  add: ElementSlot<HTMLButtonElement>;
  form: ElementSlot<HTMLFormElement>;
  url: ElementSlot<HTMLInputElement>;
  docs: ElementSlot<HTMLInputElement>;
  choices: ElementSlot<HTMLInputElement>[];
  create: ElementSlot<HTMLButtonElement>;
  cancel: ElementSlot<HTMLButtonElement>;
  listError: ElementSlot<HTMLDivElement>;
  listAlert: ElementSlot<HTMLSpanElement>;
  retry: ElementSlot<HTMLButtonElement>;
  actionError: ElementSlot<HTMLDivElement>;
  created: ElementSlot<HTMLDivElement>;
  secret: ElementSlot<HTMLElement>;
  copy: ElementSlot<HTMLButtonElement>;
  listContent: ElementSlot<HTMLElement>;
  rowsList: ElementSlot<HTMLUListElement>;
  rows: RowElements[];
  rowPublications: readonly PublishedWebhookRow[];
  established: boolean;
  layoutRetired: boolean;
  consumed: boolean;
  successorRequested: boolean;
  invalidReplay: boolean;
  replayRefs: RefReplay[];
  stableSlots: Set<ElementSlot<HTMLElement>>;
  introducedSlots: Set<ElementSlot<HTMLElement>>;
  dom: PanelDomSnapshot | null;
  placement: PanelPlacement | null;
  guard: PanelDomGuard | null;
  keyboard: FormKeyboardAuthority | null;
  keyboardPair: FormKeyboardPair | null;
  rowKeyboard: RowKeyboardAuthority | null;
  rowKeyboardPairs: RowKeyboardPairStore | null;
  keyboardSuspended: boolean;
  keyboardLayoutReplayAvailable: boolean;
  keyboardReplay: FormKeyboardRefReplay | null;
  keyboardReplayExpiryQueued: boolean;
  guardExpiryQueued: boolean;
  factsAreCurrent: (() => boolean) | null;
  domIsExact: ((override?: InputDomOverride) => boolean) | null;
  requestSuccessor: (() => void) | null;
}

interface RefReplay {
  readonly owner: ElementSlot<HTMLElement>;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

type PanelDomSnapshot = Readonly<{
  node: Node;
  nodeValue: string | null;
  attributes: readonly (readonly [string, string])[] | null;
  children: readonly PanelDomSnapshot[];
}>;

type PanelPlacementLink = Readonly<{
  node: Node;
  parent: Node;
  previousSibling: Node | null;
  nextSibling: Node | null;
}>;

type PanelPlacement = Readonly<{
  document: Document;
  links: readonly PanelPlacementLink[];
}>;

type PanelDomGuard = Readonly<{
  acceptReactCommit: (
    inputs: readonly HTMLInputElement[],
    finalDomIsExact: () => boolean,
  ) => void;
  isClean: () => boolean;
  release: () => void;
}>;

type FormKeyboardNativeGetter = (this: object) => unknown;
type FormKeyboardEventField =
  | "type"
  | "target"
  | "currentTarget"
  | "eventPhase"
  | "bubbles"
  | "cancelable"
  | "defaultPrevented"
  | "cancelBubble";
type FormKeyboardKeyField =
  | "key"
  | "code"
  | "repeat"
  | "isComposing"
  | "ctrlKey"
  | "altKey"
  | "metaKey"
  | "shiftKey";

type FormKeyboardGetterAuthority<Field extends string> = Readonly<{
  getters: Readonly<Record<Field, FormKeyboardNativeGetter>>;
  isCurrent: () => boolean;
}>;

type FormKeyboardViewIdentity =
  | ReactKeyboardEvent<HTMLFormElement>["view"]
  | Window;

type FormKeyboardMethodAuthority<Method> = Readonly<{
  method: Method;
  isCurrent: () => boolean;
}>;

type FormKeyboardWindowMethod<Method> = Readonly<{
  value: Method;
  isCurrent: () => boolean;
}>;

type FormNavigationKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";
type FormKeyboardFocus = (
  this: HTMLElement,
  options?: FocusOptions,
) => void;

type FormKeyboardTrustedAuthority = Readonly<{
  matches: (event: object) => boolean;
  read: (event: object) => boolean;
  isCurrent: () => boolean;
}>;

type FormKeyboardTerminalProof = Readonly<{
  registration: FormKeyboardTerminalRegistration;
  nativeEvent: KeyboardEvent;
  receiver: EventTarget;
  currentTarget: EventTarget;
  terminal: EventTarget;
  path: readonly EventTarget[];
}>;

type FormKeyboardTerminalRegistration = Readonly<{
  proofFor: (event: KeyboardEvent) => FormKeyboardTerminalProof | null;
  claim: (proof: FormKeyboardTerminalProof) => boolean;
  release: () => void;
  isCurrent: () => boolean;
}>;

type FormKeyboardAuthority = Readonly<{
  form: HTMLFormElement;
  root: HTMLDivElement;
  document: Document;
  ownerWindow: Window & typeof globalThis;
  targets: readonly HTMLElement[];
  refTargets: readonly FormKeyboardRefTarget[];
  Event: typeof Event;
  UIEvent: typeof UIEvent;
  KeyboardEvent: typeof KeyboardEvent;
  Document: typeof Document;
  HTMLElement: typeof HTMLElement;
  event: FormKeyboardGetterAuthority<FormKeyboardEventField>["getters"];
  keyboard: FormKeyboardGetterAuthority<FormKeyboardKeyField>["getters"];
  view: FormKeyboardNativeGetter;
  activeElement: FormKeyboardNativeGetter;
  composedPath: Event["composedPath"];
  preventDefault: Event["preventDefault"];
  focus: FormKeyboardFocus;
  trusted: FormKeyboardTrustedAuthority;
  terminal: FormKeyboardTerminalRegistration;
  apply: typeof Reflect.apply;
  prototypeOf: typeof Object.getPrototypeOf;
  isCurrent: () => boolean;
}>;

type FormKeyboardEventSnapshot = Readonly<{
  event: KeyboardEvent;
  type: string;
  target: HTMLElement;
  currentTarget: EventTarget;
  phase: number;
  path: readonly EventTarget[];
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  cancelBubble: boolean;
  key: string;
  code: string;
  repeat: boolean;
  composing: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  view: FormKeyboardViewIdentity;
  trusted: true;
  terminal: FormKeyboardTerminalProof;
}>;

type FormKeyboardReactCancellation = Readonly<{
  isDefaultPrevented: () => boolean;
  isPropagationStopped: () => boolean;
}>;

type FormKeyboardReactSnapshot = Readonly<{
  event: ReactKeyboardEvent<HTMLFormElement>;
  cancellation: FormKeyboardReactCancellation;
}>;

type FormKeyboardPair = Readonly<{
  publication: PanelPublication;
  authority: FormKeyboardAuthority;
  native: FormKeyboardEventSnapshot;
  capture: FormKeyboardReactSnapshot;
}>;

type RowNavigationKey = FormNavigationKey;

type PublishedRowAction = Readonly<{
  identity: symbol;
  panel: PanelPublication;
  panelIdentity: symbol;
  rowIdentity: symbol;
  callbackToken: symbol;
  facts: RowActionFacts;
  owner: ElementSlot<HTMLButtonElement>;
  element: HTMLButtonElement;
  kind: RowActionKind;
  order: 0 | 1 | 2;
}>;

type PublishedWebhookRow = Readonly<{
  identity: symbol;
  panel: PanelPublication;
  panelIdentity: symbol;
  list: ListFacts;
  facts: WebhookRowFacts;
  elements: RowElements;
  root: HTMLLIElement;
  listElement: HTMLUListElement;
  document: Document;
  ownerWindow: Window & typeof globalThis;
  index: number;
  id: string;
  url: string;
  active: boolean;
  failures: number;
  operation: RowOperation | null;
  callbackToken: symbol;
  actions: readonly PublishedRowAction[];
}>;

type RowKeyboardEventField =
  | FormKeyboardEventField
  | "composed";
type RowKeyboardKeyField =
  | FormKeyboardKeyField
  | "location";

type RowKeyboardAuthority = Readonly<{
  panel: PanelPublication;
  root: HTMLDivElement;
  list: HTMLUListElement;
  rows: readonly PublishedWebhookRow[];
  document: Document;
  ownerWindow: Window & typeof globalThis;
  Event: typeof Event;
  UIEvent: typeof UIEvent;
  KeyboardEvent: typeof KeyboardEvent;
  Document: typeof Document;
  HTMLElement: typeof HTMLElement;
  event: FormKeyboardGetterAuthority<RowKeyboardEventField>["getters"];
  keyboard: FormKeyboardGetterAuthority<RowKeyboardKeyField>["getters"];
  view: FormKeyboardNativeGetter;
  detail: FormKeyboardNativeGetter;
  activeElement: FormKeyboardNativeGetter;
  composedPath: Event["composedPath"];
  focus: FormKeyboardFocus;
  trusted: FormKeyboardTrustedAuthority;
  terminal: FormKeyboardTerminalRegistration;
  apply: typeof Reflect.apply;
  prototypeOf: typeof Object.getPrototypeOf;
  isCurrent: () => boolean;
}>;

type RowKeyboardEventSnapshot = Readonly<{
  event: KeyboardEvent;
  type: string;
  target: HTMLElement;
  currentTarget: EventTarget;
  phase: number;
  path: readonly EventTarget[];
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  cancelBubble: boolean;
  composed: boolean;
  key: RowNavigationKey;
  code: string;
  location: number;
  repeat: boolean;
  composing: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  view: Window | EventTarget | null;
  detail: number;
  trusted: true;
  terminal: FormKeyboardTerminalProof;
}>;

type RowKeyboardPublicMethod = (...args: never[]) => unknown;

/**
 * Only the public React methods this route actually needs: prevention plus the
 * two public cancellation queries. Optional wrapper methods (`stopPropagation`,
 * `persist`, `isPersistent`) are never required, retained, or compared.
 */
type RowKeyboardReactMethods = Readonly<{
  preventDefault: RowKeyboardPublicMethod;
  isDefaultPrevented: RowKeyboardPublicMethod;
  isPropagationStopped: RowKeyboardPublicMethod;
}>;

type RowKeyboardReactExpectation = Readonly<{
  defaultPrevented: boolean;
  retainedDefaultQuery: boolean;
}>;

type RowKeyboardReactSnapshot = Readonly<{
  event: ReactKeyboardEvent<HTMLElement>;
  nativeEvent: KeyboardEvent;
  target: HTMLElement;
  currentTarget: HTMLElement;
  phase: number;
  view: ReactKeyboardEvent<HTMLElement>["view"];
  methods: RowKeyboardReactMethods;
}>;

type RowKeyboardPair = Readonly<{
  publication: PanelPublication;
  authority: RowKeyboardAuthority;
  row: PublishedWebhookRow;
  native: RowKeyboardEventSnapshot;
  capture: RowKeyboardReactSnapshot;
  terminal: FormKeyboardTerminalProof;
  source: PublishedRowAction;
  destination: PublishedRowAction;
  key: RowNavigationKey;
  movement: object;
  publicationClaim: object;
  rowClaim: object;
  movementClaim: object;
  wrapperClaim: object;
  nativeClaim: object;
  windowClaim: object;
  sourceClaim: object;
  destinationClaim: object;
}>;

type RowKeyboardDelivery = Readonly<{
  pair: RowKeyboardPair;
  bubble: RowKeyboardReactSnapshot;
}>;

/**
 * Publication-local weak pairing for one row-action keydown. The capture pair
 * is reachable only through the exact native event, so it survives any number
 * of nested browser microtask checkpoints between the two React phases and
 * disappears with the event itself. Retirement and cleanup replace the store
 * and revoke every later read.
 */
type RowKeyboardPairStore = Readonly<{
  publish: (event: KeyboardEvent, pair: RowKeyboardPair) => boolean;
  read: (event: KeyboardEvent) => RowKeyboardPair | null;
  consume: (event: KeyboardEvent, pair: RowKeyboardPair) => boolean;
  revoke: () => void;
  isCurrent: () => boolean;
}>;

type PanelReplay = Readonly<{
  source: PanelPublication;
  dom: PanelDomSnapshot;
  placement: PanelPlacement;
  historyIsClean: () => boolean;
  release: () => void;
}>;

class PanelPublicationCoordinator {
  readonly callbackToken = Symbol("webhooks-callbacks");
  readonly #mount: MountGeneration;
  #current: PanelPublication | null = null;
  #successorOf: PanelPublication | null = null;
  #replay: PanelReplay | null = null;
  #teardownRevision = 0;
  readonly #retired = new WeakSet<PanelPublication>();
  readonly #claimedPublications = new WeakSet<PanelPublication>();
  readonly #claimedRows = new WeakSet<object>();
  readonly #claimedActions = new WeakSet<object>();
  readonly #claimedReactEvents = new WeakSet<object>();
  readonly #claimedNativeEvents = new WeakSet<Event>();
  readonly #claimedKeyboardPairs = new WeakSet<FormKeyboardPair>();
  readonly #attemptedRowKeyboardReactEvents = new WeakSet<object>();
  readonly #attemptedRowKeyboardNativeEvents = new WeakSet<object>();
  readonly #claimedRowKeyboardDeliveries = new WeakSet<RowKeyboardDelivery>();
  readonly #claimedRowKeyboardPairs = new WeakSet<RowKeyboardPair>();
  readonly #claimedRowKeyboardMovements = new WeakSet<object>();
  readonly #claimedRowKeyboardPublications = new WeakSet<object>();
  readonly #claimedRowKeyboardRows = new WeakSet<object>();
  readonly #claimedRowKeyboardMovementClaims = new WeakSet<object>();
  readonly #claimedRowKeyboardWrapperClaims = new WeakSet<object>();
  readonly #claimedRowKeyboardNativeClaims = new WeakSet<object>();
  readonly #claimedRowKeyboardWindowClaims = new WeakSet<object>();
  readonly #claimedRowKeyboardSources = new WeakSet<object>();
  readonly #claimedRowKeyboardDestinations = new WeakSet<object>();
  readonly #claimedRowKeyboardReactEvents = new WeakSet<object>();
  readonly #claimedRowKeyboardNativeEvents = new WeakSet<Event>();
  #rowKeyboardDelivery: RowKeyboardDelivery | null = null;
  #rowKeyboardFenced = false;
  readonly #recentlyIntroduced = new WeakSet<HTMLElement>();

  constructor(mount: MountGeneration) {
    this.#mount = mount;
  }

  activate() {
    this.#teardownRevision += 1;
  }

  scheduleTeardown() {
    const revision = ++this.#teardownRevision;
    queueMicrotask(() => {
      if (revision !== this.#teardownRevision) return;
      const replay = this.#replay;
      this.#replay = null;
      replay?.release();
      const publications = new Set([
        this.#current,
        this.#successorOf,
        replay?.source ?? null,
      ]);
      for (const publication of publications) {
        publication?.guard?.release();
        if (publication) {
          publication.guard = null;
          publication.keyboard?.terminal.release();
          publication.keyboard = null;
          publication.keyboardPair = null;
          publication.rowKeyboard?.terminal.release();
          publication.rowKeyboard = null;
          publication.rowKeyboardPairs?.revoke();
          publication.rowKeyboardPairs = null;
          publication.rowPublications = [];
          for (const row of publication.rows) row.publication = null;
          publication.keyboardReplay = null;
        }
      }
      this.#current = null;
      this.#successorOf = null;
    });
  }

  bind<T extends HTMLElement>(
    candidate: PanelPublication,
    owner: ElementSlot<T>,
    element: T | null,
  ) {
    if (owner.element === element) return;
    const previous = owner.element;
    const last = owner.last;
    const slotOwner = owner as ElementSlot<HTMLElement>;
    const proof = candidate.established
      ? candidate.replayRefs.find((entry) => entry.owner === slotOwner)
      : null;
    const deferRetirement = proof
      ? this.#trackFormKeyboardRefReplay(
          candidate,
          slotOwner,
          previous,
          element,
          proof,
        )
      : false;
    owner.mouseTargets = null;
    owner.element = element;
    if (element) owner.last = element;
    if (!candidate.established) return;

    if (!proof) {
      candidate.invalidReplay = true;
      this.retire(candidate, "element");
      return;
    }
    if (element === null && previous === proof.element && proof.element.isConnected) {
      proof.detached = true;
      proof.reattached = false;
    } else if (
      element === proof.element &&
      previous === null &&
      proof.detached &&
      proof.element.isConnected
    ) {
      proof.reattached = true;
    } else {
      candidate.invalidReplay = true;
    }

    const introducedReplayCompleted =
      candidate.introducedSlots.has(slotOwner) &&
      proof.detached &&
      proof.reattached;
    if (
      candidate.stableSlots.has(slotOwner) &&
      (element === null || (element !== null && last !== null && element !== last)) &&
      !candidate.introducedSlots.has(slotOwner) &&
      !deferRetirement
    ) {
      this.retire(candidate, "element");
    }
    if (introducedReplayCompleted) {
      proof.detached = false;
      proof.reattached = false;
      const ownerWindow = proof.element.ownerDocument.defaultView;
      if (ownerWindow && proof.element instanceof ownerWindow.HTMLButtonElement) {
        slotOwner.mouseTargets = snapshotMouseTargets(proof.element);
      }
    }
    this.#requestReplaySuccessor(candidate);
  }

  #trackFormKeyboardRefReplay(
    candidate: PanelPublication,
    owner: ElementSlot<HTMLElement>,
    previous: HTMLElement | null,
    element: HTMLElement | null,
    proof: RefReplay,
  ) {
    if (candidate.successorRequested) return false;
    const authority = candidate.keyboard;
    const currentKeyboardPublication =
      candidate.established &&
      candidate.presentation.adding &&
      candidate.presentation.generation === this.#mount &&
      this.#current === candidate &&
      !this.#retired.has(candidate) &&
      authority !== null;
    const captured = authority?.refTargets.find(
      (target) => target.owner === owner,
    );

    if (
      !candidate.keyboardReplay &&
      currentKeyboardPublication &&
      captured &&
      element === null &&
      previous === captured.element &&
      previous === proof.element &&
      previous.isConnected &&
      authority.refTargets.every(
        (target) =>
          target.owner.element === target.element &&
          target.owner.binding === target.binding &&
          target.element.isConnected,
      )
    ) {
      const replayedLayout = candidate.keyboardLayoutReplayAvailable;
      candidate.keyboardLayoutReplayAvailable = false;
      const replay: FormKeyboardRefReplay = {
        publication: candidate,
        presentation: candidate.presentation,
        generation: candidate.presentation.generation,
        targets: Object.freeze(
          authority.refTargets.map((target) => ({
            ...target,
            released: false,
            rebound: false,
          })),
        ),
        layoutReleased: candidate.layoutRetired || replayedLayout,
        layoutRebound: replayedLayout,
        expired: false,
      };
      candidate.keyboardReplay = replay;
      candidate.keyboardSuspended = true;
      this.#scheduleFormKeyboardReplayExpiry(candidate);
      this.retire(candidate, "element");
    } else if (
      !candidate.keyboardReplay &&
      currentKeyboardPublication &&
      !captured &&
      !candidate.introducedSlots.has(owner) &&
      element === null &&
      previous === proof.element &&
      previous.isConnected
    ) {
      // Strict ref cleanup reaches the panel shell before the form. Suspend
      // keyboard work until the first form target can open the full replay.
      candidate.keyboardSuspended = true;
      this.#scheduleFormKeyboardReplayExpiry(candidate);
      return true;
    }

    const replay = candidate.keyboardReplay;
    if (!replay || replay.expired) return false;
    const target = replay.targets.find((entry) => entry.owner === owner);
    if (!target) return false;
    if (
      replay.generation !== candidate.presentation.generation ||
      replay.generation !== this.#mount ||
      owner.binding !== target.binding
    ) {
      this.#expireFormKeyboardReplay(candidate);
      return false;
    }
    if (
      element === null &&
      previous === target.element &&
      !target.released &&
      !target.rebound &&
      target.element.isConnected
    ) {
      target.released = true;
    } else if (
      element === target.element &&
      previous === null &&
      target.released &&
      !target.rebound &&
      target.element.isConnected
    ) {
      target.rebound = true;
    } else {
      this.#expireFormKeyboardReplay(candidate);
    }
    return false;
  }

  establish(
    candidate: PanelPublication,
    factsAreCurrent: () => boolean,
    domIsExact: (override?: InputDomOverride) => boolean,
    requestSuccessor: () => void,
  ): (() => void) | undefined {
    candidate.factsAreCurrent = factsAreCurrent;
    candidate.domIsExact = domIsExact;
    candidate.requestSuccessor = requestSuccessor;
    if (candidate.established) {
      const keyboardReplay = candidate.keyboardReplay;
      if (
        keyboardReplay &&
        !keyboardReplay.expired &&
        keyboardReplay.layoutReleased
      ) {
        keyboardReplay.layoutRebound = true;
      }
      this.#requestReplaySuccessor(candidate);
      return undefined;
    }
    if (
      candidate.presentation.generation !== this.#mount ||
      !factsAreCurrent() ||
      !domIsExact()
    ) {
      return undefined;
    }
    const root = candidate.card.element;
    const placement = root ? capturePanelPlacement(root) : null;
    if (!root || !placement) return undefined;

    const pendingReplay = this.#replay;
    if (pendingReplay) {
      const revisionMatches =
        candidate.presentation.revision ===
        pendingReplay.source.presentation.revision + 1;
      const presentationsMatch = panelPresentationsMatch(
        pendingReplay.source.presentation,
        candidate.presentation,
      );
      const sameAuthority = revisionMatches && presentationsMatch;
      if (sameAuthority) {
        pendingReplay.source.guard?.acceptReactCommit(
          [
            candidate.url.element,
            ...candidate.choices.map((choice) => choice.element),
            candidate.docs.element,
          ].filter((input): input is HTMLInputElement => input !== null),
          () =>
            factsAreCurrent() &&
            domIsExact() &&
            pendingReplay.dom.node === root &&
            panelPlacementMatches(root, pendingReplay.placement) &&
            panelDomMatches(pendingReplay.dom),
        );
      }
      const exactReplay =
        sameAuthority &&
        this.#acceptsSuccessorOf(pendingReplay.source) &&
        pendingReplay.historyIsClean() &&
        pendingReplay.dom.node === root &&
        panelPlacementMatches(root, pendingReplay.placement) &&
        panelDomMatches(pendingReplay.dom);
      this.#replay = null;
      pendingReplay.release();
      pendingReplay.source.keyboardReplay = null;
      if (this.#successorOf === pendingReplay.source) this.#successorOf = null;
      if (sameAuthority && !exactReplay) return undefined;
    }

    const guard = createPanelDomGuard(root, placement);
    if (!guard) return undefined;
    const expected = expectedPanelSlots(candidate);
    if (expected.some((owner) => !owner.element)) {
      guard.release();
      return undefined;
    }
    const rowPublications = publishWebhookRows(candidate, root);
    if (!rowPublications) {
      guard.release();
      return undefined;
    }
    const keyboard = candidate.presentation.adding
      ? captureFormKeyboardAuthority(candidate, root)
      : null;
    const rowKeyboard = candidate.presentation.list.kind === "rows"
      ? captureRowKeyboardAuthority(candidate, root, rowPublications)
      : null;
    if (candidate.presentation.adding && !keyboard) {
      guard.release();
      rowKeyboard?.terminal.release();
      return undefined;
    }
    if (candidate.presentation.list.kind === "rows" && !rowKeyboard) {
      guard.release();
      keyboard?.terminal.release();
      return undefined;
    }
    const predecessor = this.#current ?? this.#successorOf;
    const hasMatchingIntroducedFormLayout =
      keyboard !== null &&
      predecessor !== null &&
      predecessor.presentation.generation === candidate.presentation.generation &&
      !predecessor.presentation.adding &&
      predecessor.consumed &&
      predecessor.layoutRetired &&
      this.#retired.has(predecessor) &&
      this.#claimedPublications.has(predecessor);
    if (
      predecessor &&
      predecessor.presentation.generation === candidate.presentation.generation
    ) {
      const predecessorElements = new Map(
        expectedPanelSlots(predecessor).map((owner) => [owner.key, owner.element]),
      );
      const predecessorIntroduced = new Map(
        [...predecessor.introducedSlots].map((owner) => [owner.key, owner.element]),
      );
      for (const owner of expected) {
        const introduced =
          !predecessorElements.has(owner.key) ||
          predecessorElements.get(owner.key) !== owner.element;
        const carriedIntroduction =
          owner.element !== null &&
          (
            predecessorIntroduced.get(owner.key) === owner.element ||
            this.#recentlyIntroduced.has(owner.element)
          );
        if (introduced || carriedIntroduction) {
          candidate.introducedSlots.add(owner);
        }
        if (owner.element && introduced) {
          this.#recentlyIntroduced.add(owner.element);
        } else if (owner.element && carriedIntroduction) {
          this.#recentlyIntroduced.delete(owner.element);
        }
      }
    }
    const previous = this.#current;
    if (previous && previous !== candidate) this.retire(previous, "other");
    if (
      this.#retired.has(candidate) ||
      candidate.presentation.generation !== this.#mount
    ) {
      guard.release();
      keyboard?.terminal.release();
      rowKeyboard?.terminal.release();
      return undefined;
    }

    candidate.established = true;
    candidate.stableSlots = new Set(expected);
    candidate.replayRefs = expected.map((owner) => ({
      owner,
      element: owner.element!,
      detached: false,
      reattached: false,
    }));
    candidate.dom = snapshotPanelDom(root);
    candidate.placement = placement;
    candidate.guard = guard;
    candidate.keyboard = keyboard;
    candidate.rowPublications = rowPublications;
    candidate.rowKeyboard = rowKeyboard;
    for (const row of rowPublications) row.elements.publication = row;
    candidate.keyboardLayoutReplayAvailable = hasMatchingIntroducedFormLayout;
    for (const owner of panelButtonSlots(candidate)) {
      owner.mouseTargets = owner.element ? snapshotMouseTargets(owner.element) : null;
    }
    this.#current = candidate;
    this.#successorOf = null;
    queueMicrotask(() => {
      if (this.#current === candidate && !this.#retired.has(candidate)) {
        candidate.keyboardLayoutReplayAvailable = false;
        this.#acceptInputReconciliation(candidate);
      }
    });
    return () => {
      candidate.layoutRetired = true;
      const keyboardReplay = candidate.keyboardReplay;
      if (keyboardReplay && !keyboardReplay.expired) {
        keyboardReplay.layoutReleased = true;
      }
      if (
        this.#current === candidate &&
        !this.#retired.has(candidate) &&
        candidate.presentation.adding &&
        candidate.keyboard
      ) {
        candidate.keyboardSuspended = true;
        this.#scheduleFormKeyboardReplayExpiry(candidate);
      } else {
        this.retire(candidate, "layout");
      }
      this.#requestReplaySuccessor(candidate);
    };
  }

  retire(candidate: PanelPublication, reason: "element" | "layout" | "other" = "other") {
    if (this.#retired.has(candidate)) return false;
    candidate.guard?.isClean();
    this.#retired.add(candidate);
    candidate.keyboard?.terminal.release();
    candidate.keyboard = null;
    candidate.keyboardPair = null;
    candidate.rowKeyboard?.terminal.release();
    candidate.rowKeyboard = null;
    candidate.rowKeyboardPairs?.revoke();
    candidate.rowKeyboardPairs = null;
    candidate.rowPublications = [];
    for (const row of candidate.rows) row.publication = null;
    const wasCurrent = this.#current === candidate;
    if (wasCurrent) {
      this.#current = null;
      this.#successorOf = candidate;
    }
    if (reason === "other") {
      candidate.guard?.release();
      candidate.guard = null;
    } else {
      this.#scheduleGuardExpiry(candidate);
    }
    return wasCurrent;
  }

  owns(candidate: PanelPublication) {
    const result =
      this.#current === candidate &&
      !this.#retired.has(candidate) &&
      !candidate.keyboardSuspended &&
      !this.#claimedPublications.has(candidate) &&
      candidate.guard?.isClean() === true;
    return result;
  }

  ownsListOperation(operation: ListOperation) {
    const candidate = this.#current;
    const root = candidate?.card.element;
    const authority = operation.authority.read();
    return Boolean(
      candidate &&
      root &&
      authority &&
      this.owns(candidate) &&
      candidate.presentation.listOperation === operation &&
      candidate.presentation.requestList === operation.request &&
      candidate.presentation.generation === operation.generation &&
      authority.activation.presentation.generation === operation.generation &&
      authority.activation.presentation.requestList === operation.request &&
      authority.action === (
        operation.intent === "refresh"
          ? authority.activation.presentation.refresh
          : authority.activation.presentation.retry
      ) &&
      authority.action.kind === operation.intent &&
      authority.action.route === operation.route &&
      root === authority.root &&
      root.ownerDocument === authority.document &&
      authority.placement.document === authority.document &&
      panelPlacementMatches(root, authority.placement) &&
      candidate.factsAreCurrent?.() === true &&
      candidate.domIsExact?.() === true
    );
  }

  reconcileReactCommit(candidate: PanelPublication) {
    if (
      this.#current !== candidate ||
      this.#retired.has(candidate) ||
      !candidate.dom
    ) {
      return;
    }
    this.#acceptInputReconciliation(candidate);
  }

  finishReactCommit(candidate: PanelPublication) {
    queueMicrotask(() => {
      if (this.#current === candidate && !this.#retired.has(candidate)) {
        candidate.introducedSlots.clear();
      }
    });
  }

  prepareControlClaim(candidate: PanelPublication, override?: InputDomOverride) {
    if (
      this.#current === candidate &&
      !this.#retired.has(candidate) &&
      !this.#claimedPublications.has(candidate)
    ) {
      this.#acceptInputReconciliation(candidate, override);
    }
  }

  publishKeyboardCapture(
    candidate: PanelPublication,
    event: ReactKeyboardEvent<HTMLFormElement>,
  ) {
    const authority = candidate.keyboard;
    const pending = candidate.keyboardPair;
    if (
      authority &&
      pending &&
      pending.authority === authority &&
      pending.native.event !== event.nativeEvent
    ) {
      try {
        const phase = formKeyboardNativeValue<number>(
          authority,
          authority.event.eventPhase,
          pending.native.event,
        );
        const currentTarget = formKeyboardNativeValue<EventTarget | null>(
          authority,
          authority.event.currentTarget,
          pending.native.event,
        );
        if (phase === authority.Event.NONE && currentTarget === null) {
          candidate.keyboardPair = null;
        }
      } catch {
        return;
      }
    }
    if (
      !authority ||
      candidate.keyboardPair ||
      candidate.keyboardSuspended ||
      candidate.keyboardReplay ||
      !this.owns(candidate)
    ) {
      return;
    }
    const native = captureFormKeyboardEvent(
      authority,
      event.nativeEvent,
      authority.Event.CAPTURING_PHASE,
    );
    const capture = native
      ? captureFormKeyboardReactEvent(event, authority, native)
      : null;
    if (
      !native ||
      !capture ||
      candidate.keyboard !== authority ||
      candidate.form.element !== authority.form ||
      candidate.card.element !== authority.root ||
      candidate.factsAreCurrent?.() !== true ||
      candidate.domIsExact?.() !== true ||
      !this.owns(candidate)
    ) {
      return;
    }
    const pair = Object.freeze({
      publication: candidate,
      authority,
      native,
      capture,
    });
    candidate.keyboardPair = pair;
    queueMicrotask(() => {
      if (candidate.keyboardPair === pair) candidate.keyboardPair = null;
    });
  }

  discardKeyboardPair(candidate: PanelPublication) {
    candidate.keyboardPair = null;
  }

  rowKeyboardIsFenced() {
    return this.#rowKeyboardFenced;
  }

  /**
   * Runs one row-action keyboard attempt with every public wrapper query and
   * prevention call fenced: any reentrant capture or bubble attempt raised from
   * inside a public method sees the fence and performs no work.
   */
  fenceRowKeyboard(operation: () => void) {
    if (this.#rowKeyboardFenced) return;
    this.#rowKeyboardFenced = true;
    try {
      operation();
    } finally {
      this.#rowKeyboardFenced = false;
    }
  }

  prepareRowKeyboardCapture(event: object, nativeEvent: object) {
    if (
      this.#rowKeyboardDelivery ||
      this.#rowKeyboardFenced ||
      this.#attemptedRowKeyboardReactEvents.has(event) ||
      this.#attemptedRowKeyboardNativeEvents.has(nativeEvent)
    ) {
      return false;
    }
    this.#attemptedRowKeyboardReactEvents.add(event);
    this.#attemptedRowKeyboardNativeEvents.add(nativeEvent);
    return true;
  }

  prepareRowKeyboardBubble(event: object, nativeEvent: object) {
    if (
      this.#rowKeyboardDelivery ||
      this.#rowKeyboardFenced ||
      this.#attemptedRowKeyboardReactEvents.has(event) ||
      !this.#attemptedRowKeyboardNativeEvents.has(nativeEvent)
    ) {
      return false;
    }
    this.#attemptedRowKeyboardReactEvents.add(event);
    return true;
  }

  claimRowKeyboardNavigation(delivery: RowKeyboardDelivery) {
    const { pair, bubble } = delivery;
    const nativeEvent = pair.native.event;
    if (
      this.#rowKeyboardDelivery ||
      !this.owns(pair.publication) ||
      pair.publication.rowKeyboard !== pair.authority ||
      pair.row.panel !== pair.publication ||
      this.#claimedRowKeyboardDeliveries.has(delivery) ||
      this.#claimedRowKeyboardPairs.has(pair) ||
      this.#claimedRowKeyboardMovements.has(pair.movement) ||
      this.#claimedRowKeyboardPublications.has(pair.publicationClaim) ||
      this.#claimedRowKeyboardRows.has(pair.rowClaim) ||
      this.#claimedRowKeyboardMovementClaims.has(pair.movementClaim) ||
      this.#claimedRowKeyboardWrapperClaims.has(pair.wrapperClaim) ||
      this.#claimedRowKeyboardNativeClaims.has(pair.nativeClaim) ||
      this.#claimedRowKeyboardWindowClaims.has(pair.windowClaim) ||
      this.#claimedRowKeyboardSources.has(pair.sourceClaim) ||
      this.#claimedRowKeyboardDestinations.has(pair.destinationClaim) ||
      this.#claimedRowKeyboardReactEvents.has(pair.capture.event) ||
      this.#claimedRowKeyboardReactEvents.has(bubble.event) ||
      this.#claimedRowKeyboardNativeEvents.has(nativeEvent) ||
      !this.#attemptedRowKeyboardReactEvents.has(pair.capture.event) ||
      !this.#attemptedRowKeyboardReactEvents.has(bubble.event) ||
      !this.#attemptedRowKeyboardNativeEvents.has(nativeEvent) ||
      !pair.authority.terminal.claim(pair.terminal)
    ) {
      return false;
    }
    this.#claimedRowKeyboardDeliveries.add(delivery);
    this.#claimedRowKeyboardPairs.add(pair);
    this.#claimedRowKeyboardMovements.add(pair.movement);
    this.#claimedRowKeyboardPublications.add(pair.publicationClaim);
    this.#claimedRowKeyboardRows.add(pair.rowClaim);
    this.#claimedRowKeyboardMovementClaims.add(pair.movementClaim);
    this.#claimedRowKeyboardWrapperClaims.add(pair.wrapperClaim);
    this.#claimedRowKeyboardNativeClaims.add(pair.nativeClaim);
    this.#claimedRowKeyboardWindowClaims.add(pair.windowClaim);
    this.#claimedRowKeyboardSources.add(pair.sourceClaim);
    this.#claimedRowKeyboardDestinations.add(pair.destinationClaim);
    this.#claimedRowKeyboardReactEvents.add(pair.capture.event);
    this.#claimedRowKeyboardReactEvents.add(bubble.event);
    this.#claimedRowKeyboardNativeEvents.add(nativeEvent);
    this.#rowKeyboardDelivery = delivery;
    return true;
  }

  rowKeyboardNavigationIsDelivering(delivery: RowKeyboardDelivery) {
    return this.#rowKeyboardDelivery === delivery;
  }

  finishRowKeyboardNavigation(delivery: RowKeyboardDelivery) {
    if (this.#rowKeyboardDelivery === delivery) {
      this.#rowKeyboardDelivery = null;
    }
  }

  #acceptInputReconciliation(candidate: PanelPublication, override?: InputDomOverride) {
    candidate.guard?.acceptReactCommit(
      [
        candidate.url.element,
        ...candidate.choices.map((choice) => choice.element),
        candidate.docs.element,
      ].filter((input): input is HTMLInputElement => input !== null),
      () =>
        candidate.factsAreCurrent?.() === true &&
        candidate.domIsExact?.(override) === true &&
        candidate.dom !== null &&
        panelDomMatches(candidate.dom),
    );
  }

  claim(
    candidate: PanelPublication,
    row: object | null,
    action: object,
    reactEvent: object,
    nativeEvent: Event,
    keyboardPair: FormKeyboardPair | null = null,
  ) {
    if (
      !this.owns(candidate) ||
      (row !== null && this.#claimedRows.has(row)) ||
      this.#claimedActions.has(action) ||
      this.#claimedReactEvents.has(reactEvent) ||
      this.#claimedNativeEvents.has(nativeEvent) ||
      (keyboardPair !== null &&
        (candidate.keyboardPair !== keyboardPair ||
          keyboardPair.publication !== candidate ||
          keyboardPair.authority !== candidate.keyboard ||
          keyboardPair.native.event !== nativeEvent ||
          keyboardPair.capture.event === reactEvent ||
          this.#claimedKeyboardPairs.has(keyboardPair) ||
          this.#claimedReactEvents.has(keyboardPair.capture.event) ||
          !keyboardPair.authority.terminal.claim(keyboardPair.native.terminal)))
    ) {
      return false;
    }
    this.#claimedPublications.add(candidate);
    if (row !== null) this.#claimedRows.add(row);
    this.#claimedActions.add(action);
    this.#claimedReactEvents.add(reactEvent);
    this.#claimedNativeEvents.add(nativeEvent);
    if (keyboardPair) {
      this.#claimedKeyboardPairs.add(keyboardPair);
      this.#claimedReactEvents.add(keyboardPair.capture.event);
    }
    candidate.consumed = true;
    this.retire(candidate, "other");
    return true;
  }

  #acceptsSuccessorOf(candidate: PanelPublication) {
    return (
      this.#current === null &&
      this.#successorOf === candidate &&
      this.#retired.has(candidate) &&
      !this.#claimedPublications.has(candidate)
    );
  }

  #scheduleGuardExpiry(candidate: PanelPublication) {
    if (candidate.guardExpiryQueued) return;
    candidate.guardExpiryQueued = true;
    queueMicrotask(() => {
      if (this.#replay?.source !== candidate) {
        candidate.guard?.release();
        candidate.guard = null;
      }
    });
  }

  #scheduleFormKeyboardReplayExpiry(candidate: PanelPublication) {
    if (candidate.keyboardReplayExpiryQueued) return;
    candidate.keyboardReplayExpiryQueued = true;
    queueMicrotask(() => {
      candidate.keyboardReplayExpiryQueued = false;
      if (candidate.successorRequested) return;
      this.#expireFormKeyboardReplay(candidate);
      candidate.invalidReplay = true;
      candidate.keyboardSuspended = true;
      candidate.keyboard?.terminal.release();
      candidate.keyboard = null;
      candidate.keyboardPair = null;
      this.retire(candidate, "element");
    });
  }

  #expireFormKeyboardReplay(candidate: PanelPublication) {
    const replay = candidate.keyboardReplay;
    if (replay) replay.expired = true;
    candidate.keyboardReplay = null;
    candidate.invalidReplay = true;
  }

  #requestReplaySuccessor(candidate: PanelPublication) {
    const keyboardReplay = candidate.keyboardReplay;
    const keyboardSlots = formKeyboardSlots(candidate);
    const keyboardReplayMatchesPublication =
      candidate.presentation.adding &&
      keyboardReplay !== null &&
      keyboardReplay.publication === candidate &&
      keyboardReplay.presentation === candidate.presentation &&
      keyboardReplay.generation === candidate.presentation.generation &&
      keyboardReplay.generation === this.#mount;
    const genericReplayRefsAreExact =
      candidate.replayRefs.length > 0 &&
      candidate.replayRefs.every(
        (entry) =>
          entry.detached &&
          entry.reattached &&
          entry.owner.element === entry.element &&
          entry.element.isConnected,
      );
    const dom = candidate.dom;
    const placement = candidate.placement;
    const publicationGuard = candidate.guard;
    const currentPublicationIsExact =
      candidate.established &&
      !candidate.consumed &&
      !candidate.invalidReplay &&
      candidate.factsAreCurrent?.() === true &&
      candidate.domIsExact?.() === true &&
      dom !== null &&
      placement !== null &&
      publicationGuard?.isClean() === true &&
      panelPlacementMatches(dom.node as HTMLElement, placement) &&
      panelDomMatches(dom);
    const exactFormKeyboardReplay =
      keyboardReplayMatchesPublication &&
      (
        !keyboardReplay.expired &&
        keyboardReplay.layoutReleased &&
        keyboardReplay.layoutRebound &&
        candidate.keyboard === null &&
        keyboardReplay.targets.length === keyboardSlots.length &&
        keyboardReplay.targets.every(
          (target, index) =>
            keyboardSlots[index] === target.owner &&
            target.released &&
            target.rebound &&
            target.owner.element === target.element &&
            target.owner.binding === target.binding &&
            target.element.isConnected,
        )
      ) &&
      currentPublicationIsExact;
    const layoutRetired =
      candidate.layoutRetired || exactFormKeyboardReplay;
    const replayRefsAreExact =
      genericReplayRefsAreExact || exactFormKeyboardReplay;
    const exactKeyboardReplay =
      !candidate.presentation.adding || exactFormKeyboardReplay;
    const exactReplay =
      this.#acceptsSuccessorOf(candidate) &&
      layoutRetired &&
      currentPublicationIsExact &&
      replayRefsAreExact &&
      exactKeyboardReplay;
    if (
      candidate.successorRequested ||
      !exactReplay ||
      !candidate.dom ||
      !candidate.placement ||
      !candidate.guard ||
      !candidate.requestSuccessor
    ) {
      return;
    }
    candidate.successorRequested = true;
    const guard = candidate.guard;
    this.#replay = Object.freeze({
      source: candidate,
      dom: candidate.dom,
      placement: candidate.placement,
      historyIsClean: guard.isClean,
      release: guard.release,
    });
    candidate.requestSuccessor();
  }
}

/** Checkbox labels; `suggestion` covers both decisions like the long-poll does. */
const EVENT_CHOICES = Object.freeze([
  Object.freeze({ id: "request.created", label: "request.created", types: Object.freeze(["request.created"]) }),
  Object.freeze({ id: "mention", label: "mention", types: Object.freeze(["mention"]) }),
  Object.freeze({ id: "comment.added", label: "comment.added", types: Object.freeze(["comment.added"]) }),
  Object.freeze({ id: "comment.replied", label: "comment.replied", types: Object.freeze(["comment.replied"]) }),
  Object.freeze({ id: "review.created", label: "review.created", types: Object.freeze(["review.created"]) }),
  Object.freeze({ id: "suggestion", label: "suggestion.accepted/rejected", types: Object.freeze(["suggestion.accepted", "suggestion.rejected"]) }),
  Object.freeze({ id: "content.changed", label: "content.changed", types: Object.freeze(["content.changed"]) }),
]);
const DEFAULT_CHOICES = Object.freeze(["request.created", "mention", "comment.added", "comment.replied"]);

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.text();
  const data = body ? JSON.parse(body) : null;
  if (!res.ok) {
    // Keep the 400's `issues` so the form can show the field's reason, not the bare "Invalid request".
    const err = (data ?? {}) as { error?: string; issues?: unknown };
    throw new ApiError(res.status, err.error ?? res.statusText, err.issues);
  }
  return data as T;
}

function deliveryLabel(h: WebhookRow): { text: string; tone: DeliveryTone } {
  if (!h.active) return { text: `disabled after ${h.failures} failures`, tone: "bad" };
  if (!h.lastDelivery) return { text: "no deliveries yet", tone: "muted" };
  const d = h.lastDelivery;
  const ok = d.status >= 200 && d.status < 300;
  if (ok) return { text: `${d.status} · ${relativeTime(d.at)}`, tone: "ok" };
  if (h.failures === 0) return { text: `enabled · last attempt ${d.status || "no response"} · ${relativeTime(d.at)}`, tone: "muted" };
  return { text: `failed ×${h.failures}${d.status ? ` · ${d.status}` : " · no response"} · ${relativeTime(d.at)}`, tone: "bad" };
}

function snapshotRow(h: WebhookRow, index: number, operation: RowOperation | null): WebhookRowFacts {
  const events = Object.freeze([...h.events]);
  const documentIds = h.documentIds ? Object.freeze([...h.documentIds]) : null;
  const lastDelivery = h.lastDelivery
    ? Object.freeze({
        status: h.lastDelivery.status,
        at: h.lastDelivery.at,
        attempt: h.lastDelivery.attempt,
        event: h.lastDelivery.event,
      })
    : null;
  const status = deliveryLabel(h);
  const eligible = operation === null;
  return Object.freeze({
    source: h,
    index,
    id: h.id,
    url: h.url,
    events,
    documentIds,
    active: h.active,
    failures: h.failures,
    createdAt: h.createdAt,
    lastDelivery,
    details: `${events.join(", ")}${
      documentIds
        ? ` · ${documentIds.length} document${documentIds.length === 1 ? "" : "s"}`
        : " · all documents"
    } · added ${relativeTime(h.createdAt)}`,
    statusText: status.text,
    statusTone: status.tone,
    operation,
    enable: h.active
      ? null
      : Object.freeze({ kind: "enable" as const, eligible, route: `/api/webhooks/${h.id}/enable` }),
    test: Object.freeze({ kind: "test" as const, eligible, route: `/api/webhooks/${h.id}/test` }),
    delete: Object.freeze({ kind: "delete" as const, eligible, route: `/api/webhooks/${h.id}` }),
  });
}

function arraysMatch(current: readonly string[], snapshot: readonly string[]): boolean {
  return current.length === snapshot.length && current.every((value, index) => value === snapshot[index]);
}

function rowMatchesSnapshot(row: WebhookRow, snapshot: WebhookRowFacts): boolean {
  const delivery = row.lastDelivery;
  const frozenDelivery = snapshot.lastDelivery;
  return (
    row.id === snapshot.id &&
    row.url === snapshot.url &&
    arraysMatch(row.events, snapshot.events) &&
    (row.documentIds
      ? snapshot.documentIds !== null && arraysMatch(row.documentIds, snapshot.documentIds)
      : snapshot.documentIds === null) &&
    row.active === snapshot.active &&
    row.failures === snapshot.failures &&
    row.createdAt === snapshot.createdAt &&
    (delivery
      ? frozenDelivery !== null &&
        delivery.status === frozenDelivery.status &&
        delivery.at === frozenDelivery.at &&
        delivery.attempt === frozenDelivery.attempt &&
        delivery.event === frozenDelivery.event
      : frozenDelivery === null)
  );
}

function createdMatchesSnapshot(created: CreatedWebhook | null, snapshot: CreatedFacts | null): boolean {
  return created
    ? snapshot !== null &&
        created === snapshot.source &&
        created.id === snapshot.id &&
        created.secret === snapshot.secret &&
        created.url === snapshot.url
    : snapshot === null;
}

function snapshotMouseTargets(control: HTMLButtonElement): readonly Node[] {
  return Object.freeze([control, ...Array.from(control.querySelectorAll("*"))]);
}

function snapshotPanelAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotPanelDom(node: Node): PanelDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotPanelAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotPanelDom)),
  });
}

function panelDomMatches(snapshot: PanelDomSnapshot): boolean {
  if (snapshot.node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = snapshotPanelAttributes(snapshot.node);
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
        snapshot.node.childNodes.item(index) === child.node &&
        panelDomMatches(child),
    )
  );
}

function capturePanelPlacement(root: HTMLElement): PanelPlacement | null {
  const document = root.ownerDocument;
  if (!root.isConnected) return null;
  const links: PanelPlacementLink[] = [];
  let node: Node = root;
  while (node !== document) {
    const parent = node.parentNode;
    if (!parent) return null;
    links.push(Object.freeze({
      node,
      parent,
      previousSibling: node.previousSibling,
      nextSibling: node.nextSibling,
    }));
    node = parent;
  }
  if (links.length === 0) return null;
  return Object.freeze({
    document,
    links: Object.freeze(links),
  });
}

function panelPlacementMatches(root: HTMLElement, placement: PanelPlacement): boolean {
  return (
    root.ownerDocument === placement.document &&
    root.isConnected &&
    placement.links[0]?.node === root &&
    placement.links.every((link) =>
      link.node.isConnected &&
      link.node.parentNode === link.parent &&
      link.node.previousSibling === link.previousSibling &&
      link.node.nextSibling === link.nextSibling
    ) &&
    placement.links.at(-1)?.parent === placement.document
  );
}

function createPanelDomGuard(
  root: HTMLElement,
  placement: PanelPlacement,
): PanelDomGuard | null {
  const MutationObserverConstructor = placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  let released = false;
  const pendingRecords: MutationRecord[] = [];
  const takeRecords = () => {
    const records = [...pendingRecords, ...observer.takeRecords()];
    pendingRecords.length = 0;
    return records;
  };
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((record) => {
      if (record.target === root || root.contains(record.target)) return true;
      if (record.type !== "childList") return false;
      return placement.links.some((link) =>
        record.target === link.parent &&
        (
          record.previousSibling === link.node ||
          record.nextSibling === link.node ||
          [...record.addedNodes, ...record.removedNodes].includes(link.node)
        )
      );
    });
  };
  const observer = new MutationObserverConstructor((records) => {
    pendingRecords.push(...records);
  });
  observer.observe(root, {
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  for (const parent of new Set(placement.links.map((link) => link.parent))) {
    observer.observe(parent, { childList: true });
  }
  const exactReactInputRecords = (
    records: readonly MutationRecord[],
    inputs: readonly HTMLInputElement[],
  ) => {
    if (records.length === 0) return true;
    for (let index = 0; index < records.length;) {
      const nameStart = records[index];
      const possibleType = records[index + 1];
      const hasTypeReset =
        possibleType?.type === "attributes" &&
        possibleType.attributeName === "type" &&
        possibleType.target === nameStart?.target;
      const nameEnd = records[index + (hasTypeReset ? 2 : 1)];
      if (
        nameStart?.type !== "attributes" ||
        nameStart.attributeName !== "name" ||
        nameStart.oldValue !== null ||
        !(nameStart.target instanceof placement.document.defaultView!.HTMLInputElement) ||
        !inputs.includes(nameStart.target) ||
        nameEnd?.type !== "attributes" ||
        nameEnd.attributeName !== "name" ||
        nameEnd.target !== nameStart.target ||
        nameEnd.oldValue !== "" ||
        nameStart.target.hasAttribute("name") ||
        (hasTypeReset &&
          possibleType.oldValue !== nameStart.target.getAttribute("type"))
      ) {
        return false;
      }
      index += hasTypeReset ? 3 : 2;
    }
    return true;
  };
  return Object.freeze({
    acceptReactCommit: (inputs, finalDomIsExact) => {
      const records = takeRecords();
      if (
        records.length > 0 &&
        exactReactInputRecords(records, inputs) &&
        finalDomIsExact()
      ) {
        return;
      }
      recordChanges(records);
    },
    isClean: () => {
      recordChanges(takeRecords());
      return !changed;
    },
    release: () => {
      if (released) return;
      released = true;
      recordChanges(takeRecords());
      observer.disconnect();
    },
  });
}

function actionFactsMatch(
  left: ActionFacts | RowActionFacts | null,
  right: ActionFacts | RowActionFacts | null,
) {
  return left === null
    ? right === null
    : right !== null &&
        left.kind === right.kind &&
        left.eligible === right.eligible &&
        left.route === right.route;
}

function createControlsAreExact(presentation: PanelPresentation) {
  const controls = presentation.createControls;
  return controls === null
    ? presentation.create === null && presentation.cancel === null
    : controls.length === 2 &&
        controls[0] === presentation.create &&
        controls[1] === presentation.cancel;
}

function panelPresentationsMatch(
  left: PanelPresentation,
  right: PanelPresentation,
): boolean {
  if (
    left.callbackToken !== right.callbackToken ||
    left.generation !== right.generation ||
    left.hooksSource !== right.hooksSource ||
    left.choicesSource !== right.choicesSource ||
    left.rowOperationsSource !== right.rowOperationsSource ||
    left.createdSource !== right.createdSource ||
    left.adding !== right.adding ||
    left.draft.url !== right.draft.url ||
    left.draft.docs !== right.draft.docs ||
    !arraysMatch(left.draft.choices, right.draft.choices) ||
    left.createOperation !== right.createOperation ||
    left.listOperation !== right.listOperation ||
    left.feedbackOperation !== right.feedbackOperation ||
    left.requestList !== right.requestList ||
    left.listError !== right.listError ||
    left.actionError !== right.actionError ||
    !createdMatchesSnapshot(left.createdSource, right.created) ||
    !createdMatchesSnapshot(right.createdSource, left.created) ||
    left.list.kind !== right.list.kind ||
    left.copyLabel !== right.copyLabel ||
    left.copied !== right.copied ||
    !createControlsAreExact(left) ||
    !createControlsAreExact(right) ||
    (left.createControls === null) !== (right.createControls === null) ||
    !actionFactsMatch(left.add, right.add) ||
    !actionFactsMatch(left.refresh, right.refresh) ||
    !actionFactsMatch(left.create, right.create) ||
    !actionFactsMatch(left.cancel, right.cancel) ||
    !actionFactsMatch(left.retry, right.retry) ||
    !actionFactsMatch(left.copy, right.copy)
  ) {
    return false;
  }
  if (
    left.draft.choiceInputs.length !== right.draft.choiceInputs.length ||
    left.draft.choiceInputs.some((choice, index) => {
      const candidate = right.draft.choiceInputs[index];
      return (
        !candidate ||
        choice.index !== candidate.index ||
        choice.id !== candidate.id ||
        choice.label !== candidate.label ||
        !arraysMatch(choice.types, candidate.types) ||
        choice.checked !== candidate.checked ||
        choice.eligible !== candidate.eligible
      );
    })
  ) {
    return false;
  }
  const leftRows = left.list.rows;
  const rightRows = right.list.rows;
  if (leftRows === null || rightRows === null) return leftRows === rightRows;
  return (
    leftRows.length === rightRows.length &&
    leftRows.every((row, index) => {
      const candidate = rightRows[index];
      return (
        !!candidate &&
        row.source === candidate.source &&
        rowMatchesSnapshot(row.source, candidate) &&
        row.index === candidate.index &&
        row.details === candidate.details &&
        row.statusText === candidate.statusText &&
        row.statusTone === candidate.statusTone &&
        row.operation === candidate.operation &&
        actionFactsMatch(row.enable, candidate.enable) &&
        actionFactsMatch(row.test, candidate.test) &&
        actionFactsMatch(row.delete, candidate.delete)
      );
    })
  );
}

function isNativeReactMouseEvent(
  event: ReactMouseEvent<HTMLButtonElement>,
  control: HTMLButtonElement | null,
  mouseTargets: readonly Node[] | null,
  root: HTMLElement | null,
): MouseEvent | null {
  const ownerWindow = control?.ownerDocument.defaultView;
  const nativeEvent = event?.nativeEvent;
  const target = event.target;
  return (
    !!control &&
    !!root &&
    !!ownerWindow &&
    root.ownerDocument === control.ownerDocument &&
    event.currentTarget === control &&
    event.type === "click" &&
    event.button === 0 &&
    event.bubbles &&
    !event.defaultPrevented &&
    nativeEvent instanceof ownerWindow.MouseEvent &&
    nativeEvent.type === "click" &&
    nativeEvent.button === 0 &&
    nativeEvent.bubbles &&
    nativeEvent.cancelable &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    !nativeEvent.defaultPrevented &&
    nativeEvent.target === target &&
    target instanceof ownerWindow.Node &&
    target.ownerDocument === control.ownerDocument &&
    control.contains(target) &&
    root.contains(control) &&
    nativeEvent.composedPath().includes(control) &&
    nativeEvent.composedPath().includes(root) &&
    mouseTargets?.includes(target) === true
  ) ? nativeEvent : null;
}

function isNativeReactInputEvent(
  event: ChangeEvent<HTMLInputElement>,
  input: HTMLInputElement | null,
  root: HTMLElement | null,
): Event | null {
  const ownerWindow = input?.ownerDocument.defaultView;
  const nativeEvent = event?.nativeEvent;
  return (
    !!input &&
    !!root &&
    !!ownerWindow &&
    root.ownerDocument === input.ownerDocument &&
    (event.type === "input" || event.type === "change") &&
    event.currentTarget === input &&
    event.target === input &&
    !event.defaultPrevented &&
    nativeEvent instanceof ownerWindow.Event &&
    (nativeEvent.type === "input" ||
      nativeEvent.type === "change" ||
      nativeEvent.type === "click") &&
    (!(nativeEvent instanceof ownerWindow.MouseEvent) || nativeEvent.button === 0) &&
    nativeEvent.bubbles &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    !nativeEvent.defaultPrevented &&
    nativeEvent.target === input &&
    nativeEvent.composedPath().includes(input) &&
    nativeEvent.composedPath().includes(root)
  ) ? nativeEvent : null;
}

function isNativeReactSubmitEvent(
  event: FormEvent<HTMLFormElement>,
  form: HTMLFormElement | null,
  root: HTMLElement | null,
): Event | null {
  const ownerWindow = form?.ownerDocument.defaultView;
  const nativeEvent = event?.nativeEvent;
  return (
    !!form &&
    !!root &&
    !!ownerWindow &&
    root.ownerDocument === form.ownerDocument &&
    event.type === "submit" &&
    event.currentTarget === form &&
    event.target === form &&
    !event.defaultPrevented &&
    nativeEvent instanceof ownerWindow.Event &&
    nativeEvent.type === "submit" &&
    nativeEvent.bubbles &&
    nativeEvent.cancelable &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    nativeEvent.target === form &&
    nativeEvent.composedPath().includes(form) &&
    nativeEvent.composedPath().includes(root) &&
    !nativeEvent.defaultPrevented
  ) ? nativeEvent : null;
}

function formKeyboardDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
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
    ? current.value === expected.value && current.writable === expected.writable
    : current.get === expected.get && current.set === expected.set;
}

function captureFormKeyboardGetters<const Fields extends readonly string[]>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  prototype: object,
  fields: Fields,
): FormKeyboardGetterAuthority<Fields[number]> | null {
  const entries: [Fields[number], FormKeyboardNativeGetter][] = [];
  const descriptors: [Fields[number], PropertyDescriptor][] = [];
  for (const field of fields) {
    const descriptor = getOwnPropertyDescriptor(prototype, field);
    if (!descriptor || typeof descriptor.get !== "function") return null;
    entries.push([field, descriptor.get]);
    descriptors.push([field, Object.freeze({ ...descriptor })]);
  }
  const getters = Object.freeze(
    Object.fromEntries(entries),
  ) as Readonly<Record<Fields[number], FormKeyboardNativeGetter>>;
  return Object.freeze({
    getters,
    isCurrent: () =>
      descriptors.every(([field, expected]) =>
        formKeyboardDescriptorsMatch(
          getOwnPropertyDescriptor(prototype, field),
          expected,
        )),
  });
}

function captureFormKeyboardMethod<Method>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  prototype: object,
  name: PropertyKey,
): FormKeyboardMethodAuthority<Method> | null {
  const descriptor = getOwnPropertyDescriptor(prototype, name);
  if (!descriptor || typeof descriptor.value !== "function") return null;
  const expected = Object.freeze({ ...descriptor });
  return Object.freeze({
    method: descriptor.value as Method,
    isCurrent: () =>
      formKeyboardDescriptorsMatch(
        getOwnPropertyDescriptor(prototype, name),
        expected,
      ),
  });
}

function captureFormKeyboardWindowMethod<
  Property extends "addEventListener" | "removeEventListener",
>(
  ownerWindow: Window & typeof globalThis,
  property: Property,
): FormKeyboardWindowMethod<Window[Property]> | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
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
  const value = reflectGet(ownerWindow, property, ownerWindow) as Window[Property];
  if (!found || typeof value !== "function") return null;
  const isCurrent = () =>
    ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
    ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
    ownerWindow.Reflect.get === reflectGet &&
    path.every(
      ({ target: entry, descriptor, prototype }) =>
        getPrototypeOf(entry) === prototype &&
        (descriptor
          ? formKeyboardDescriptorsMatch(
              getOwnPropertyDescriptor(entry, property),
              descriptor,
            )
          : getOwnPropertyDescriptor(entry, property) === undefined),
    ) &&
    reflectGet(ownerWindow, property, ownerWindow) === value;
  return isCurrent() ? Object.freeze({ value, isCurrent }) : null;
}

function captureFormKeyboardTrustedAuthority(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
  probe: KeyboardEvent,
): FormKeyboardTrustedAuthority | null {
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    !descriptor ||
    descriptor.configurable !== false ||
    descriptor.enumerable !== true ||
    typeof descriptor.get !== "function" ||
    descriptor.set !== undefined
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const matches = (event: object) =>
    formKeyboardDescriptorsMatch(
      getOwnPropertyDescriptor(event, "isTrusted"),
      expected,
    );
  return Object.freeze({
    matches,
    read: (event: object) =>
      apply(descriptor.get as FormKeyboardNativeGetter, event, []) as boolean,
    isCurrent: () => matches(probe),
  });
}

function createFormKeyboardTerminalRegistration(
  ownerWindow: Window & typeof globalThis,
  ownerDocument: Document,
  KeyboardEventConstructor: typeof KeyboardEvent,
  keyboardEventPrototype: object,
  eventCurrentTarget: FormKeyboardNativeGetter,
  eventPhase: FormKeyboardNativeGetter,
  composedPath: Event["composedPath"],
  addEventListener: FormKeyboardWindowMethod<Window["addEventListener"]>,
  removeEventListener: FormKeyboardWindowMethod<Window["removeEventListener"]>,
  apply: typeof Reflect.apply,
  prototypeOf: typeof Object.getPrototypeOf,
  intrinsicsAreCurrent: () => boolean,
): FormKeyboardTerminalRegistration | null {
  const proofs = new WeakMap<KeyboardEvent, FormKeyboardTerminalProof>();
  const invalidEvents = new WeakSet<Event>();
  const claimed = new WeakSet<Event>();
  let active = false;
  let released = false;

  const listener: EventListener = function (this: EventTarget, event: Event) {
    if (
      !active ||
      released ||
      !(event instanceof KeyboardEventConstructor) ||
      prototypeOf(event) !== keyboardEventPrototype ||
      invalidEvents.has(event) ||
      !intrinsicsAreCurrent()
    ) {
      return;
    }
    if (proofs.has(event)) {
      invalidEvents.add(event);
      return;
    }
    try {
      const currentTarget = apply(eventCurrentTarget, event, []) as EventTarget | null;
      const phase = apply(eventPhase, event, []) as number;
      const path = apply(composedPath, event, []) as EventTarget[];
      const terminal = path.at(-1);
      if (
        currentTarget !== this ||
        terminal !== this ||
        phase !== ownerWindow.Event.CAPTURING_PHASE ||
        path.at(-2) !== ownerDocument
      ) {
        invalidEvents.add(event);
        return;
      }
      proofs.set(
        event,
        Object.freeze({
          registration,
          nativeEvent: event,
          receiver: this,
          currentTarget,
          terminal,
          path: Object.freeze([...path]),
        }),
      );
    } catch {
      invalidEvents.add(event);
    }
  };

  const proofFor = (event: KeyboardEvent) => {
    const proof = proofs.get(event);
    if (
      !proof ||
      !active ||
      released ||
      claimed.has(event) ||
      invalidEvents.has(event) ||
      proof.registration !== registration ||
      proof.nativeEvent !== event ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      !intrinsicsAreCurrent()
    ) {
      return null;
    }
    try {
      const path = apply(composedPath, event, []) as EventTarget[];
      return path.length === proof.path.length &&
        path.every((entry, index) => entry === proof.path[index]) &&
        path.at(-2) === ownerDocument &&
        path.at(-1) === proof.receiver
        ? proof
        : null;
    } catch {
      invalidEvents.add(event);
      return null;
    }
  };

  const registration: FormKeyboardTerminalRegistration = Object.freeze({
    proofFor,
    claim: (proof) => {
      if (claimed.has(proof.nativeEvent) || proofFor(proof.nativeEvent) !== proof) {
        return false;
      }
      claimed.add(proof.nativeEvent);
      return true;
    },
    release: () => {
      if (released) return;
      released = true;
      active = false;
      apply(removeEventListener.value, ownerWindow, ["keydown", listener, true]);
    },
    isCurrent: () =>
      active &&
      !released &&
      intrinsicsAreCurrent() &&
      addEventListener.isCurrent() &&
      removeEventListener.isCurrent(),
  });

  active = true;
  try {
    apply(addEventListener.value, ownerWindow, ["keydown", listener, true]);
    if (registration.isCurrent()) return registration;
    registration.release();
    return null;
  } catch {
    active = false;
    released = true;
    return null;
  }
}

function captureFormKeyboardAuthority(
  publication: PanelPublication,
  root: HTMLDivElement,
): FormKeyboardAuthority | null {
  const form = publication.form.element;
  const document = root.ownerDocument;
  const ownerWindow = document.defaultView;
  if (
    !form ||
    !ownerWindow ||
    form.ownerDocument !== document ||
    form.parentElement !== root
  ) {
    return null;
  }
  const objectConstructor = ownerWindow.Object;
  const getOwnPropertyDescriptor = objectConstructor.getOwnPropertyDescriptor;
  const prototypeOf = objectConstructor.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const EventConstructor = ownerWindow.Event;
  const UIEventConstructor = ownerWindow.UIEvent;
  const KeyboardEventConstructor = ownerWindow.KeyboardEvent;
  const DocumentConstructor = ownerWindow.Document;
  const HTMLElementConstructor = ownerWindow.HTMLElement;
  const eventPrototype = EventConstructor.prototype;
  const uiEventPrototype = UIEventConstructor.prototype;
  const keyboardEventPrototype = KeyboardEventConstructor.prototype;
  const documentPrototype = DocumentConstructor.prototype;
  const eventGetters = captureFormKeyboardGetters(
    getOwnPropertyDescriptor,
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
    ] as const,
  );
  const keyboardGetters = captureFormKeyboardGetters(
    getOwnPropertyDescriptor,
    keyboardEventPrototype,
    [
      "key",
      "code",
      "repeat",
      "isComposing",
      "ctrlKey",
      "altKey",
      "metaKey",
      "shiftKey",
    ] as const,
  );
  const uiGetters = captureFormKeyboardGetters(
    getOwnPropertyDescriptor,
    uiEventPrototype,
    ["view"] as const,
  );
  const documentGetters = captureFormKeyboardGetters(
    getOwnPropertyDescriptor,
    documentPrototype,
    ["activeElement"] as const,
  );
  const composedPath = captureFormKeyboardMethod<Event["composedPath"]>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "composedPath",
  );
  const preventDefault = captureFormKeyboardMethod<Event["preventDefault"]>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "preventDefault",
  );
  const focus = captureFormKeyboardMethod<FormKeyboardFocus>(
    getOwnPropertyDescriptor,
    HTMLElementConstructor.prototype,
    "focus",
  );
  const addEventListener = captureFormKeyboardWindowMethod(
    ownerWindow,
    "addEventListener",
  );
  const removeEventListener = captureFormKeyboardWindowMethod(
    ownerWindow,
    "removeEventListener",
  );
  if (
    !eventGetters ||
    !keyboardGetters ||
    !uiGetters ||
    !documentGetters ||
    !composedPath ||
    !preventDefault ||
    !focus ||
    !addEventListener ||
    !removeEventListener
  ) {
    return null;
  }
  let probe: KeyboardEvent;
  try {
    probe = new KeyboardEventConstructor("webhook-keyboard-intrinsic");
  } catch {
    return null;
  }
  const trusted = captureFormKeyboardTrustedAuthority(
    getOwnPropertyDescriptor,
    apply,
    probe,
  );
  if (!trusted) return null;
  const intrinsicsAreCurrent = () => {
    try {
      return (
        document.defaultView === ownerWindow &&
        ownerWindow.Object === objectConstructor &&
        ownerWindow.Object.getOwnPropertyDescriptor ===
          getOwnPropertyDescriptor &&
        ownerWindow.Object.getPrototypeOf === prototypeOf &&
        ownerWindow.Reflect.apply === apply &&
        ownerWindow.Event === EventConstructor &&
        ownerWindow.UIEvent === UIEventConstructor &&
        ownerWindow.KeyboardEvent === KeyboardEventConstructor &&
        ownerWindow.Document === DocumentConstructor &&
        ownerWindow.HTMLElement === HTMLElementConstructor &&
        EventConstructor.prototype === eventPrototype &&
        UIEventConstructor.prototype === uiEventPrototype &&
        KeyboardEventConstructor.prototype === keyboardEventPrototype &&
        DocumentConstructor.prototype === documentPrototype &&
        prototypeOf(probe) === keyboardEventPrototype &&
        prototypeOf(keyboardEventPrototype) === uiEventPrototype &&
        prototypeOf(uiEventPrototype) === eventPrototype &&
        eventGetters.isCurrent() &&
        keyboardGetters.isCurrent() &&
        uiGetters.isCurrent() &&
        documentGetters.isCurrent() &&
        composedPath.isCurrent() &&
        preventDefault.isCurrent() &&
        focus.isCurrent() &&
        addEventListener.isCurrent() &&
        removeEventListener.isCurrent() &&
        trusted.isCurrent()
      );
    } catch {
      return false;
    }
  };
  try {
    if (!intrinsicsAreCurrent() || trusted.read(probe) !== false) return null;
  } catch {
    return null;
  }
  const targets = [
    form,
    ...[...form.querySelectorAll("*")].filter(
      (target): target is HTMLElement =>
        target instanceof HTMLElementConstructor,
    ),
  ];
  const refTargets: FormKeyboardRefTarget[] = [];
  for (const owner of formKeyboardSlots(publication)) {
    const element = owner.element;
    const binding = owner.binding;
    if (
      !element ||
      !binding ||
      element.ownerDocument !== document ||
      !targets.includes(element)
    ) {
      return null;
    }
    refTargets.push(Object.freeze({ owner, element, binding }));
  }
  const terminal = createFormKeyboardTerminalRegistration(
    ownerWindow,
    document,
    KeyboardEventConstructor,
    keyboardEventPrototype,
    eventGetters.getters.currentTarget,
    eventGetters.getters.eventPhase,
    composedPath.method,
    addEventListener,
    removeEventListener,
    apply,
    prototypeOf,
    intrinsicsAreCurrent,
  );
  if (!terminal) return null;
  const isCurrent = () => intrinsicsAreCurrent() && terminal.isCurrent();
  return Object.freeze({
    form,
    root,
    document,
    ownerWindow,
    targets: Object.freeze(targets),
    refTargets: Object.freeze(refTargets),
    Event: EventConstructor,
    UIEvent: UIEventConstructor,
    KeyboardEvent: KeyboardEventConstructor,
    Document: DocumentConstructor,
    HTMLElement: HTMLElementConstructor,
    event: eventGetters.getters,
    keyboard: keyboardGetters.getters,
    view: uiGetters.getters.view,
    activeElement: documentGetters.getters.activeElement,
    composedPath: composedPath.method,
    preventDefault: preventDefault.method,
    focus: focus.method,
    trusted,
    terminal,
    apply,
    prototypeOf,
    isCurrent,
  });
}

function formKeyboardNativeValue<Value>(
  authority: FormKeyboardAuthority,
  getter: FormKeyboardNativeGetter,
  target: object,
): Value {
  return authority.apply(getter, target, []) as Value;
}

function isFormNavigationKey(key: string): key is FormNavigationKey {
  return (
    key === "ArrowLeft" ||
    key === "ArrowUp" ||
    key === "ArrowRight" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End"
  );
}

function captureFormKeyboardEvent(
  authority: FormKeyboardAuthority,
  nativeEvent: Event,
  expectedPhase: number,
): FormKeyboardEventSnapshot | null {
  if (
    !authority.isCurrent() ||
    authority.prototypeOf(nativeEvent) !== authority.KeyboardEvent.prototype ||
    !authority.trusted.matches(nativeEvent)
  ) {
    return null;
  }
  try {
    const type = formKeyboardNativeValue<string>(
      authority,
      authority.event.type,
      nativeEvent,
    );
    const target = formKeyboardNativeValue<EventTarget | null>(
      authority,
      authority.event.target,
      nativeEvent,
    );
    const currentTarget = formKeyboardNativeValue<EventTarget | null>(
      authority,
      authority.event.currentTarget,
      nativeEvent,
    );
    const phase = formKeyboardNativeValue<number>(
      authority,
      authority.event.eventPhase,
      nativeEvent,
    );
    const bubbles = formKeyboardNativeValue<boolean>(
      authority,
      authority.event.bubbles,
      nativeEvent,
    );
    const cancelable = formKeyboardNativeValue<boolean>(
      authority,
      authority.event.cancelable,
      nativeEvent,
    );
    const defaultPrevented = formKeyboardNativeValue<boolean>(
      authority,
      authority.event.defaultPrevented,
      nativeEvent,
    );
    const cancelBubble = formKeyboardNativeValue<boolean>(
      authority,
      authority.event.cancelBubble,
      nativeEvent,
    );
    const key = formKeyboardNativeValue<string>(
      authority,
      authority.keyboard.key,
      nativeEvent,
    );
    const code = formKeyboardNativeValue<string>(
      authority,
      authority.keyboard.code,
      nativeEvent,
    );
    const repeat = formKeyboardNativeValue<boolean>(
      authority,
      authority.keyboard.repeat,
      nativeEvent,
    );
    const composing = formKeyboardNativeValue<boolean>(
      authority,
      authority.keyboard.isComposing,
      nativeEvent,
    );
    const ctrlKey = formKeyboardNativeValue<boolean>(
      authority,
      authority.keyboard.ctrlKey,
      nativeEvent,
    );
    const altKey = formKeyboardNativeValue<boolean>(
      authority,
      authority.keyboard.altKey,
      nativeEvent,
    );
    const metaKey = formKeyboardNativeValue<boolean>(
      authority,
      authority.keyboard.metaKey,
      nativeEvent,
    );
    const shiftKey = formKeyboardNativeValue<boolean>(
      authority,
      authority.keyboard.shiftKey,
      nativeEvent,
    );
    const view = formKeyboardNativeValue<Window | null>(
      authority,
      authority.view,
      nativeEvent,
    );
    const activeElement = formKeyboardNativeValue<Element | null>(
      authority,
      authority.activeElement,
      authority.document,
    );
    const path = authority.apply(
      authority.composedPath,
      nativeEvent,
      [],
    ) as EventTarget[];
    const trusted = authority.trusted.read(nativeEvent);
    const terminal = authority.terminal.proofFor(nativeEvent as KeyboardEvent);
    if (
      type !== "keydown" ||
      !(target instanceof authority.HTMLElement) ||
      target.ownerDocument !== authority.document ||
      !authority.targets.includes(target) ||
      activeElement !== target ||
      !currentTarget ||
      phase !== expectedPhase ||
      !bubbles ||
      !cancelable ||
      defaultPrevented ||
      cancelBubble ||
      (key !== "Escape" && !isFormNavigationKey(key)) ||
      code !== key ||
      repeat ||
      composing ||
      ctrlKey ||
      altKey ||
      metaKey ||
      shiftKey ||
      view !== authority.ownerWindow ||
      trusted !== true ||
      !terminal ||
      !authority.form.isConnected ||
      !authority.root.isConnected ||
      authority.form.parentElement !== authority.root
    ) {
      return null;
    }
    const expectedPath: EventTarget[] = [];
    let node: Node | null = target;
    while (node) {
      expectedPath.push(node);
      if (node === authority.document) break;
      node = node.parentNode;
    }
    expectedPath.push(terminal.receiver);
    if (
      expectedPath.at(-2) !== authority.document ||
      path.length !== expectedPath.length ||
      path.some((entry, index) => entry !== expectedPath[index]) ||
      path.length !== terminal.path.length ||
      path.some((entry, index) => entry !== terminal.path[index]) ||
      terminal.receiver !== terminal.currentTarget ||
      terminal.receiver !== terminal.terminal ||
      !path.includes(authority.form) ||
      !path.includes(authority.root) ||
      !path.includes(currentTarget)
    ) {
      return null;
    }
    return Object.freeze({
      event: nativeEvent as KeyboardEvent,
      type,
      target,
      currentTarget,
      phase,
      path: Object.freeze([...path]),
      bubbles,
      cancelable,
      defaultPrevented,
      cancelBubble,
      key,
      code,
      repeat,
      composing,
      ctrlKey,
      altKey,
      metaKey,
      shiftKey,
      view,
      trusted: true,
      terminal,
    });
  } catch {
    return null;
  }
}

function formKeyboardEventMatches(
  authority: FormKeyboardAuthority,
  snapshot: FormKeyboardEventSnapshot,
) {
  const current = captureFormKeyboardEvent(
    authority,
    snapshot.event,
    snapshot.phase,
  );
  return Boolean(
    current &&
      current.type === snapshot.type &&
      current.target === snapshot.target &&
      current.currentTarget === snapshot.currentTarget &&
      current.phase === snapshot.phase &&
      current.bubbles === snapshot.bubbles &&
      current.cancelable === snapshot.cancelable &&
      current.defaultPrevented === snapshot.defaultPrevented &&
      current.cancelBubble === snapshot.cancelBubble &&
      current.key === snapshot.key &&
      current.code === snapshot.code &&
      current.repeat === snapshot.repeat &&
      current.composing === snapshot.composing &&
      current.ctrlKey === snapshot.ctrlKey &&
      current.altKey === snapshot.altKey &&
      current.metaKey === snapshot.metaKey &&
      current.shiftKey === snapshot.shiftKey &&
      current.view === snapshot.view &&
      current.trusted === snapshot.trusted &&
      current.terminal === snapshot.terminal &&
      current.path.length === snapshot.path.length &&
      current.path.every((entry, index) => entry === snapshot.path[index])
  );
}

function captureFormKeyboardReactCancellation(
  event: ReactKeyboardEvent<HTMLFormElement>,
  authority: FormKeyboardAuthority,
): FormKeyboardReactCancellation | null {
  try {
    const reactEvent = event as ReactKeyboardEvent<HTMLFormElement> & {
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
    };
    const isDefaultPrevented = reactEvent.isDefaultPrevented;
    const isPropagationStopped = reactEvent.isPropagationStopped;
    return typeof isDefaultPrevented === "function" &&
      typeof isPropagationStopped === "function" &&
      authority.apply(isDefaultPrevented, event, []) === false &&
      authority.apply(isPropagationStopped, event, []) === false
      ? Object.freeze({ isDefaultPrevented, isPropagationStopped })
      : null;
  } catch {
    return null;
  }
}

function formKeyboardReactCancellationMatches(
  event: ReactKeyboardEvent<HTMLFormElement>,
  expected: FormKeyboardReactCancellation,
  authority: FormKeyboardAuthority,
) {
  const current = captureFormKeyboardReactCancellation(event, authority);
  return Boolean(
    current &&
      current.isDefaultPrevented === expected.isDefaultPrevented &&
      current.isPropagationStopped === expected.isPropagationStopped,
  );
}

function captureFormKeyboardReactEvent(
  event: ReactKeyboardEvent<HTMLFormElement>,
  authority: FormKeyboardAuthority,
  snapshot: FormKeyboardEventSnapshot,
): FormKeyboardReactSnapshot | null {
  try {
    const reactEvent = event as ReactKeyboardEvent<HTMLFormElement> & {
      isPersistent?: unknown;
      persist?: unknown;
    };
    const cancellation = captureFormKeyboardReactCancellation(event, authority);
    const isPersistent = reactEvent.isPersistent;
    return (
      cancellation &&
      event.nativeEvent === snapshot.event &&
      event.type === snapshot.type &&
      event.target === snapshot.target &&
      event.currentTarget === authority.form &&
      event.eventPhase === snapshot.phase &&
      event.bubbles === snapshot.bubbles &&
      event.cancelable === snapshot.cancelable &&
      event.defaultPrevented === snapshot.defaultPrevented &&
      event.isTrusted === snapshot.trusted &&
      event.key === snapshot.key &&
      event.code === snapshot.code &&
      event.repeat === snapshot.repeat &&
      event.ctrlKey === snapshot.ctrlKey &&
      event.altKey === snapshot.altKey &&
      event.metaKey === snapshot.metaKey &&
      event.shiftKey === snapshot.shiftKey &&
      event.view === snapshot.view &&
      typeof event.preventDefault === "function" &&
      typeof event.stopPropagation === "function" &&
      typeof reactEvent.persist === "function" &&
      typeof isPersistent === "function" &&
      authority.apply(isPersistent, event, []) === true
    )
      ? Object.freeze({ event, cancellation })
      : null;
  } catch {
    return null;
  }
}

function formKeyboardReactEventMatches(
  snapshot: FormKeyboardReactSnapshot,
  authority: FormKeyboardAuthority,
  native: FormKeyboardEventSnapshot,
) {
  const current = captureFormKeyboardReactEvent(
    snapshot.event,
    authority,
    native,
  );
  return Boolean(
    current &&
      current.cancellation.isDefaultPrevented ===
        snapshot.cancellation.isDefaultPrevented &&
      current.cancellation.isPropagationStopped ===
        snapshot.cancellation.isPropagationStopped,
  );
}

function formKeyboardDeliveriesMatch(
  capture: FormKeyboardEventSnapshot,
  bubble: FormKeyboardEventSnapshot,
  authority: FormKeyboardAuthority,
) {
  return (
    capture.event === bubble.event &&
    capture.type === bubble.type &&
    capture.target === bubble.target &&
    capture.currentTarget === bubble.currentTarget &&
    capture.phase === authority.Event.CAPTURING_PHASE &&
    bubble.phase === authority.Event.BUBBLING_PHASE &&
    capture.bubbles === bubble.bubbles &&
    capture.cancelable === bubble.cancelable &&
    capture.defaultPrevented === bubble.defaultPrevented &&
    capture.cancelBubble === bubble.cancelBubble &&
    capture.key === bubble.key &&
    capture.code === bubble.code &&
    capture.repeat === bubble.repeat &&
    capture.composing === bubble.composing &&
    capture.ctrlKey === bubble.ctrlKey &&
    capture.altKey === bubble.altKey &&
    capture.metaKey === bubble.metaKey &&
    capture.shiftKey === bubble.shiftKey &&
    capture.view === bubble.view &&
    capture.trusted === bubble.trusted &&
    capture.terminal === bubble.terminal &&
    capture.path.length === bubble.path.length &&
    capture.path.every((entry, index) => entry === bubble.path[index])
  );
}

function capturePublishedFormKeyboardBubble(
  candidate: PanelPublication,
  event: ReactKeyboardEvent<HTMLFormElement>,
): Readonly<{
  authority: FormKeyboardAuthority;
  pair: FormKeyboardPair;
  native: FormKeyboardEventSnapshot;
  bubble: FormKeyboardReactSnapshot;
}> | null {
  const authority = candidate.keyboard;
  const pair = candidate.keyboardPair;
  if (
    !authority ||
    !pair ||
    pair.publication !== candidate ||
    pair.authority !== authority ||
    pair.capture.event === event ||
    pair.native.event !== event.nativeEvent ||
    candidate.keyboardSuspended ||
    candidate.keyboardReplay
  ) {
    return null;
  }
  const native = captureFormKeyboardEvent(
    authority,
    event.nativeEvent,
    authority.Event.BUBBLING_PHASE,
  );
  const bubble = native
    ? captureFormKeyboardReactEvent(event, authority, native)
    : null;
  if (
    !native ||
    !bubble ||
    pair.native.terminal !== native.terminal ||
    !formKeyboardDeliveriesMatch(pair.native, native, authority) ||
    !formKeyboardReactCancellationMatches(
      pair.capture.event,
      pair.capture.cancellation,
      authority,
    ) ||
    !formKeyboardReactEventMatches(bubble, authority, native) ||
    bubble.cancellation.isDefaultPrevented !==
      pair.capture.cancellation.isDefaultPrevented ||
    bubble.cancellation.isPropagationStopped !==
      pair.capture.cancellation.isPropagationStopped
  ) {
    return null;
  }
  return Object.freeze({ authority, pair, native, bubble });
}

function publishWebhookRows(
  panel: PanelPublication,
  root: HTMLDivElement,
): readonly PublishedWebhookRow[] | null {
  const facts = panel.presentation;
  if (facts.list.kind !== "rows") return Object.freeze([]);
  const rows = facts.list.rows;
  const list = panel.rowsList.element;
  const ownerWindow = root.ownerDocument.defaultView;
  if (
    !rows ||
    !list ||
    !ownerWindow ||
    list !== panel.listContent.element ||
    list.ownerDocument !== root.ownerDocument ||
    list.parentElement !== root ||
    panel.rows.length !== rows.length
  ) {
    return null;
  }
  const publications: PublishedWebhookRow[] = [];
  for (const factsRow of rows) {
    const elements = panel.rows[factsRow.index];
    const row = elements?.root.element;
    const test = elements?.test.element;
    const remove = elements?.delete.element;
    const enable = factsRow.enable ? elements?.enable.element : null;
    if (
      !elements ||
      !row ||
      !test ||
      !remove ||
      row.ownerDocument !== root.ownerDocument ||
      row.parentElement !== list ||
      list.children.item(factsRow.index) !== row ||
      test.parentElement !== row ||
      remove.parentElement !== row ||
      test.disabled !== !factsRow.test.eligible ||
      remove.disabled !== !factsRow.delete.eligible ||
      (factsRow.enable
        ? !enable ||
          enable.parentElement !== row ||
          enable.disabled !== !factsRow.enable.eligible
        : elements.enable.element !== null)
    ) {
      return null;
    }
    const rowIdentity = Symbol(`webhook-row:${factsRow.index}:${factsRow.id}`);
    const entries: readonly [
      RowActionFacts | null,
      ElementSlot<HTMLButtonElement>,
      HTMLButtonElement | null,
      0 | 1 | 2,
    ][] = [
      [factsRow.enable, elements.enable, enable, 0],
      [factsRow.test, elements.test, test, 1],
      [factsRow.delete, elements.delete, remove, 2],
    ];
    const actions = Object.freeze(
      entries.flatMap(([action, owner, element, order]) =>
        action?.eligible && element
          ? [
              Object.freeze<PublishedRowAction>({
                identity: Symbol(
                  `webhook-row:${factsRow.index}:${factsRow.id}:${action.kind}`,
                ),
                panel,
                panelIdentity: panel.identity,
                rowIdentity,
                callbackToken: facts.callbackToken,
                facts: action,
                owner,
                element,
                kind: action.kind,
                order,
              }),
            ]
          : []),
    );
    publications.push(
      Object.freeze({
        identity: rowIdentity,
        panel,
        panelIdentity: panel.identity,
        list: facts.list,
        facts: factsRow,
        elements,
        root: row,
        listElement: list,
        document: root.ownerDocument,
        ownerWindow,
        index: factsRow.index,
        id: factsRow.id,
        url: factsRow.url,
        active: factsRow.active,
        failures: factsRow.failures,
        operation: factsRow.operation,
        callbackToken: facts.callbackToken,
        actions,
      }),
    );
  }
  return Object.freeze(publications);
}

function publishedWebhookRowIsCurrent(
  panel: PanelPublication,
  published: PublishedWebhookRow,
) {
  const rows = panel.presentation.list.rows;
  const facts = rows?.[published.index];
  const elements = panel.rows[published.index];
  const list = panel.rowsList.element;
  if (
    !facts ||
    !elements ||
    panel.rowPublications[published.index] !== published ||
    published.panel !== panel ||
    published.panelIdentity !== panel.identity ||
    published.list !== panel.presentation.list ||
    published.facts !== facts ||
    published.elements !== elements ||
    published.root !== elements.root.element ||
    published.listElement !== list ||
    published.document !== published.root.ownerDocument ||
    published.ownerWindow !== published.document.defaultView ||
    published.index !== facts?.index ||
    published.id !== facts?.id ||
    published.url !== facts?.url ||
    published.active !== facts?.active ||
    published.failures !== facts?.failures ||
    published.operation !== facts?.operation ||
    published.callbackToken !== panel.presentation.callbackToken ||
    elements.publication !== published ||
    !list ||
    !published.root.isConnected ||
    published.root.parentElement !== list ||
    list.children.item(published.index) !== published.root
  ) {
    return false;
  }
  const entries: readonly [
    RowActionFacts | null,
    ElementSlot<HTMLButtonElement>,
    0 | 1 | 2,
  ][] = [
    [facts.enable, elements.enable, 0],
    [facts.test, elements.test, 1],
    [facts.delete, elements.delete, 2],
  ];
  const expected = entries.filter(([action]) => action?.eligible);
  return (
    published.actions.length === expected.length &&
    published.actions.every((action, index) => {
      const entry = expected[index];
      const factsAction = entry?.[0];
      const owner = entry?.[1];
      const order = entry?.[2];
      const element = owner?.element;
      return Boolean(
        factsAction &&
          owner &&
          element &&
          action.panel === panel &&
          action.panelIdentity === panel.identity &&
          action.rowIdentity === published.identity &&
          action.callbackToken === panel.presentation.callbackToken &&
          action.facts === factsAction &&
          action.owner === owner &&
          action.element === element &&
          action.kind === factsAction.kind &&
          action.order === order &&
          factsAction.eligible &&
          element.isConnected &&
          element.ownerDocument === published.root.ownerDocument &&
          element.parentElement === published.root &&
          !element.disabled,
      );
    }) &&
    new Set(published.actions.map(({ element }) => element)).size ===
      published.actions.length
  );
}

function captureRowKeyboardAuthority(
  panel: PanelPublication,
  root: HTMLDivElement,
  rows: readonly PublishedWebhookRow[],
): RowKeyboardAuthority | null {
  const list = panel.rowsList.element;
  const document = root.ownerDocument;
  const ownerWindow = document.defaultView;
  if (
    !list ||
    !ownerWindow ||
    list.ownerDocument !== document ||
    list.parentElement !== root ||
    rows.length !== panel.presentation.list.rows?.length
  ) {
    return null;
  }
  const objectConstructor = ownerWindow.Object;
  const getOwnPropertyDescriptor = objectConstructor.getOwnPropertyDescriptor;
  const prototypeOf = objectConstructor.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const EventConstructor = ownerWindow.Event;
  const UIEventConstructor = ownerWindow.UIEvent;
  const KeyboardEventConstructor = ownerWindow.KeyboardEvent;
  const DocumentConstructor = ownerWindow.Document;
  const HTMLElementConstructor = ownerWindow.HTMLElement;
  const eventPrototype = EventConstructor.prototype;
  const uiEventPrototype = UIEventConstructor.prototype;
  const keyboardEventPrototype = KeyboardEventConstructor.prototype;
  const documentPrototype = DocumentConstructor.prototype;
  const eventGetters = captureFormKeyboardGetters(
    getOwnPropertyDescriptor,
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
    ] as const,
  );
  const keyboardGetters = captureFormKeyboardGetters(
    getOwnPropertyDescriptor,
    keyboardEventPrototype,
    [
      "key",
      "code",
      "location",
      "repeat",
      "isComposing",
      "ctrlKey",
      "altKey",
      "metaKey",
      "shiftKey",
    ] as const,
  );
  const uiGetters = captureFormKeyboardGetters(
    getOwnPropertyDescriptor,
    uiEventPrototype,
    ["view", "detail"] as const,
  );
  const documentGetters = captureFormKeyboardGetters(
    getOwnPropertyDescriptor,
    documentPrototype,
    ["activeElement"] as const,
  );
  const composedPath = captureFormKeyboardMethod<Event["composedPath"]>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "composedPath",
  );
  const nativePreventDefault =
    captureFormKeyboardMethod<Event["preventDefault"]>(
      getOwnPropertyDescriptor,
      eventPrototype,
      "preventDefault",
    );
  const focus = captureFormKeyboardMethod<FormKeyboardFocus>(
    getOwnPropertyDescriptor,
    HTMLElementConstructor.prototype,
    "focus",
  );
  const addEventListener = captureFormKeyboardWindowMethod(
    ownerWindow,
    "addEventListener",
  );
  const removeEventListener = captureFormKeyboardWindowMethod(
    ownerWindow,
    "removeEventListener",
  );
  if (
    !eventGetters ||
    !keyboardGetters ||
    !uiGetters ||
    !documentGetters ||
    !composedPath ||
    !nativePreventDefault ||
    !focus ||
    !addEventListener ||
    !removeEventListener
  ) {
    return null;
  }
  let probe: KeyboardEvent;
  try {
    probe = new KeyboardEventConstructor("webhook-row-keyboard-intrinsic");
  } catch {
    return null;
  }
  const trusted = captureFormKeyboardTrustedAuthority(
    getOwnPropertyDescriptor,
    apply,
    probe,
  );
  if (!trusted) return null;
  let poisoned = false;
  const intrinsicsAreCurrent = () => {
    if (poisoned) return false;
    try {
      const current =
        document.defaultView === ownerWindow &&
        ownerWindow.Object === objectConstructor &&
        ownerWindow.Object.getOwnPropertyDescriptor ===
          getOwnPropertyDescriptor &&
        ownerWindow.Object.getPrototypeOf === prototypeOf &&
        ownerWindow.Reflect.apply === apply &&
        ownerWindow.Event === EventConstructor &&
        ownerWindow.UIEvent === UIEventConstructor &&
        ownerWindow.KeyboardEvent === KeyboardEventConstructor &&
        ownerWindow.Document === DocumentConstructor &&
        ownerWindow.HTMLElement === HTMLElementConstructor &&
        EventConstructor.prototype === eventPrototype &&
        UIEventConstructor.prototype === uiEventPrototype &&
        KeyboardEventConstructor.prototype === keyboardEventPrototype &&
        DocumentConstructor.prototype === documentPrototype &&
        prototypeOf(probe) === keyboardEventPrototype &&
        prototypeOf(keyboardEventPrototype) === uiEventPrototype &&
        prototypeOf(uiEventPrototype) === eventPrototype &&
        eventGetters.isCurrent() &&
        keyboardGetters.isCurrent() &&
        uiGetters.isCurrent() &&
        documentGetters.isCurrent() &&
        composedPath.isCurrent() &&
        nativePreventDefault.isCurrent() &&
        focus.isCurrent() &&
        addEventListener.isCurrent() &&
        removeEventListener.isCurrent() &&
        trusted.isCurrent();
      if (!current) poisoned = true;
      return current;
    } catch {
      poisoned = true;
      return false;
    }
  };
  try {
    if (!intrinsicsAreCurrent() || trusted.read(probe) !== false) return null;
  } catch {
    return null;
  }
  const terminal = createFormKeyboardTerminalRegistration(
    ownerWindow,
    document,
    KeyboardEventConstructor,
    keyboardEventPrototype,
    eventGetters.getters.currentTarget,
    eventGetters.getters.eventPhase,
    composedPath.method,
    addEventListener,
    removeEventListener,
    apply,
    prototypeOf,
    intrinsicsAreCurrent,
  );
  if (!terminal) return null;
  return Object.freeze({
    panel,
    root,
    list,
    rows,
    document,
    ownerWindow,
    Event: EventConstructor,
    UIEvent: UIEventConstructor,
    KeyboardEvent: KeyboardEventConstructor,
    Document: DocumentConstructor,
    HTMLElement: HTMLElementConstructor,
    event: eventGetters.getters,
    keyboard: keyboardGetters.getters,
    view: uiGetters.getters.view,
    detail: uiGetters.getters.detail,
    activeElement: documentGetters.getters.activeElement,
    composedPath: composedPath.method,
    focus: focus.method,
    trusted,
    terminal,
    apply,
    prototypeOf,
    isCurrent: () => intrinsicsAreCurrent() && terminal.isCurrent(),
  });
}

function rowKeyboardNativeValue<Value>(
  authority: RowKeyboardAuthority,
  getter: FormKeyboardNativeGetter,
  target: object,
): Value {
  return authority.apply(getter, target, []) as Value;
}

function rowKeyboardIdentitiesMatch(left: unknown, right: unknown) {
  return left === right;
}

function captureRowKeyboardEvent(
  authority: RowKeyboardAuthority,
  nativeEvent: Event,
  expectedPhase: number,
): RowKeyboardEventSnapshot | null {
  if (
    !authority.isCurrent() ||
    authority.prototypeOf(nativeEvent) !== authority.KeyboardEvent.prototype ||
    !authority.trusted.matches(nativeEvent)
  ) {
    return null;
  }
  try {
    const type = rowKeyboardNativeValue<string>(
      authority,
      authority.event.type,
      nativeEvent,
    );
    const target = rowKeyboardNativeValue<EventTarget | null>(
      authority,
      authority.event.target,
      nativeEvent,
    );
    const currentTarget = rowKeyboardNativeValue<EventTarget | null>(
      authority,
      authority.event.currentTarget,
      nativeEvent,
    );
    const phase = rowKeyboardNativeValue<number>(
      authority,
      authority.event.eventPhase,
      nativeEvent,
    );
    const bubbles = rowKeyboardNativeValue<boolean>(
      authority,
      authority.event.bubbles,
      nativeEvent,
    );
    const cancelable = rowKeyboardNativeValue<boolean>(
      authority,
      authority.event.cancelable,
      nativeEvent,
    );
    const defaultPrevented = rowKeyboardNativeValue<boolean>(
      authority,
      authority.event.defaultPrevented,
      nativeEvent,
    );
    const cancelBubble = rowKeyboardNativeValue<boolean>(
      authority,
      authority.event.cancelBubble,
      nativeEvent,
    );
    const composed = rowKeyboardNativeValue<boolean>(
      authority,
      authority.event.composed,
      nativeEvent,
    );
    const key = rowKeyboardNativeValue<string>(
      authority,
      authority.keyboard.key,
      nativeEvent,
    );
    const code = rowKeyboardNativeValue<string>(
      authority,
      authority.keyboard.code,
      nativeEvent,
    );
    const location = rowKeyboardNativeValue<number>(
      authority,
      authority.keyboard.location,
      nativeEvent,
    );
    const repeat = rowKeyboardNativeValue<boolean>(
      authority,
      authority.keyboard.repeat,
      nativeEvent,
    );
    const composing = rowKeyboardNativeValue<boolean>(
      authority,
      authority.keyboard.isComposing,
      nativeEvent,
    );
    const ctrlKey = rowKeyboardNativeValue<boolean>(
      authority,
      authority.keyboard.ctrlKey,
      nativeEvent,
    );
    const altKey = rowKeyboardNativeValue<boolean>(
      authority,
      authority.keyboard.altKey,
      nativeEvent,
    );
    const metaKey = rowKeyboardNativeValue<boolean>(
      authority,
      authority.keyboard.metaKey,
      nativeEvent,
    );
    const shiftKey = rowKeyboardNativeValue<boolean>(
      authority,
      authority.keyboard.shiftKey,
      nativeEvent,
    );
    const view = rowKeyboardNativeValue<Window | EventTarget | null>(
      authority,
      authority.view,
      nativeEvent,
    );
    const detail = rowKeyboardNativeValue<number>(
      authority,
      authority.detail,
      nativeEvent,
    );
    const activeElement = rowKeyboardNativeValue<Element | null>(
      authority,
      authority.activeElement,
      authority.document,
    );
    const path = authority.apply(
      authority.composedPath,
      nativeEvent,
      [],
    ) as EventTarget[];
    const trusted = authority.trusted.read(nativeEvent);
    const terminal = authority.terminal.proofFor(nativeEvent as KeyboardEvent);
    if (
      type !== "keydown" ||
      !(target instanceof authority.HTMLElement) ||
      target.ownerDocument !== authority.document ||
      activeElement !== target ||
      !currentTarget ||
      phase !== expectedPhase ||
      !bubbles ||
      !cancelable ||
      defaultPrevented ||
      cancelBubble ||
      !isFormNavigationKey(key) ||
      repeat ||
      composing ||
      ctrlKey ||
      altKey ||
      metaKey ||
      shiftKey ||
      (view !== null &&
        view !== authority.ownerWindow &&
        (!terminal || view !== terminal.receiver)) ||
      trusted !== true ||
      !terminal
    ) {
      return null;
    }
    const expectedPath: EventTarget[] = [];
    let node: Node | null = target;
    while (node) {
      expectedPath.push(node);
      if (node === authority.document) break;
      node = node.parentNode;
    }
    expectedPath.push(terminal.receiver);
    if (
      expectedPath.at(-2) !== authority.document ||
      path.length !== expectedPath.length ||
      path.some((entry, index) => entry !== expectedPath[index]) ||
      path.length !== terminal.path.length ||
      path.some((entry, index) => entry !== terminal.path[index]) ||
      terminal.receiver !== terminal.currentTarget ||
      terminal.receiver !== terminal.terminal ||
      !path.includes(currentTarget) ||
      !path.includes(authority.root) ||
      !path.includes(authority.list)
    ) {
      return null;
    }
    return Object.freeze({
      event: nativeEvent as KeyboardEvent,
      type,
      target,
      currentTarget,
      phase,
      path: Object.freeze([...path]),
      bubbles,
      cancelable,
      defaultPrevented,
      cancelBubble,
      composed,
      key,
      code,
      location,
      repeat,
      composing,
      ctrlKey,
      altKey,
      metaKey,
      shiftKey,
      view,
      detail,
      trusted: true,
      terminal,
    });
  } catch {
    return null;
  }
}

function rowKeyboardEventsMatch(
  capture: RowKeyboardEventSnapshot,
  bubble: RowKeyboardEventSnapshot,
  authority: RowKeyboardAuthority,
) {
  return (
    capture.event === bubble.event &&
    capture.type === bubble.type &&
    capture.target === bubble.target &&
    capture.currentTarget === bubble.currentTarget &&
    capture.phase === authority.Event.CAPTURING_PHASE &&
    bubble.phase === authority.Event.BUBBLING_PHASE &&
    capture.bubbles === bubble.bubbles &&
    capture.cancelable === bubble.cancelable &&
    capture.defaultPrevented === bubble.defaultPrevented &&
    capture.cancelBubble === bubble.cancelBubble &&
    capture.composed === bubble.composed &&
    capture.key === bubble.key &&
    capture.code === bubble.code &&
    capture.location === bubble.location &&
    capture.repeat === bubble.repeat &&
    capture.composing === bubble.composing &&
    capture.ctrlKey === bubble.ctrlKey &&
    capture.altKey === bubble.altKey &&
    capture.metaKey === bubble.metaKey &&
    capture.shiftKey === bubble.shiftKey &&
    capture.view === bubble.view &&
    capture.detail === bubble.detail &&
    capture.trusted === bubble.trusted &&
    capture.terminal === bubble.terminal &&
    capture.path.length === bubble.path.length &&
    capture.path.every((entry, index) => entry === bubble.path[index])
  );
}

function rowKeyboardSnapshotRemainsExact(
  snapshot: RowKeyboardEventSnapshot,
  authority: RowKeyboardAuthority,
  expectedDefaultPrevented = snapshot.defaultPrevented,
) {
  try {
    const currentPath = authority.apply(
      authority.composedPath,
      snapshot.event,
      [],
    ) as EventTarget[];
    return (
      authority.isCurrent() &&
      authority.prototypeOf(snapshot.event) ===
        authority.KeyboardEvent.prototype &&
      authority.trusted.matches(snapshot.event) &&
      authority.trusted.read(snapshot.event) === snapshot.trusted &&
      rowKeyboardNativeValue(authority, authority.event.type, snapshot.event) ===
        snapshot.type &&
      rowKeyboardNativeValue(
        authority,
        authority.event.target,
        snapshot.event,
      ) === snapshot.target &&
      rowKeyboardNativeValue(
        authority,
        authority.event.currentTarget,
        snapshot.event,
      ) === snapshot.currentTarget &&
      rowKeyboardNativeValue(
        authority,
        authority.event.eventPhase,
        snapshot.event,
      ) === snapshot.phase &&
      rowKeyboardNativeValue(
        authority,
        authority.event.bubbles,
        snapshot.event,
      ) === snapshot.bubbles &&
      rowKeyboardNativeValue(
        authority,
        authority.event.cancelable,
        snapshot.event,
      ) === snapshot.cancelable &&
      rowKeyboardNativeValue(
        authority,
        authority.event.defaultPrevented,
        snapshot.event,
      ) === expectedDefaultPrevented &&
      rowKeyboardNativeValue(
        authority,
        authority.event.cancelBubble,
        snapshot.event,
      ) === snapshot.cancelBubble &&
      rowKeyboardNativeValue(
        authority,
        authority.event.composed,
        snapshot.event,
      ) === snapshot.composed &&
      rowKeyboardNativeValue(
        authority,
        authority.keyboard.key,
        snapshot.event,
      ) === snapshot.key &&
      rowKeyboardNativeValue(
        authority,
        authority.keyboard.code,
        snapshot.event,
      ) === snapshot.code &&
      rowKeyboardNativeValue(
        authority,
        authority.keyboard.location,
        snapshot.event,
      ) === snapshot.location &&
      rowKeyboardNativeValue(
        authority,
        authority.keyboard.repeat,
        snapshot.event,
      ) === snapshot.repeat &&
      rowKeyboardNativeValue(
        authority,
        authority.keyboard.isComposing,
        snapshot.event,
      ) === snapshot.composing &&
      rowKeyboardNativeValue(
        authority,
        authority.keyboard.ctrlKey,
        snapshot.event,
      ) === snapshot.ctrlKey &&
      rowKeyboardNativeValue(
        authority,
        authority.keyboard.altKey,
        snapshot.event,
      ) === snapshot.altKey &&
      rowKeyboardNativeValue(
        authority,
        authority.keyboard.metaKey,
        snapshot.event,
      ) === snapshot.metaKey &&
      rowKeyboardNativeValue(
        authority,
        authority.keyboard.shiftKey,
        snapshot.event,
      ) === snapshot.shiftKey &&
      rowKeyboardNativeValue(authority, authority.view, snapshot.event) ===
        snapshot.view &&
      rowKeyboardNativeValue(authority, authority.detail, snapshot.event) ===
        snapshot.detail &&
      currentPath.length === snapshot.path.length &&
      currentPath.every((entry, index) => entry === snapshot.path[index]) &&
      currentPath.at(-1) === snapshot.terminal.receiver
    );
  } catch {
    return false;
  }
}

function createRowKeyboardPairStore(): RowKeyboardPairStore {
  // Closure-local: the only strong reference to a pair is this map, and the
  // only key is the exact native event. No timer, microtask, poll, global, or
  // stale event slot keeps a pair alive.
  let pairs: WeakMap<KeyboardEvent, RowKeyboardPair> | null = new WeakMap();
  return Object.freeze({
    publish: (event: KeyboardEvent, pair: RowKeyboardPair) => {
      if (!pairs || pairs.has(event)) return false;
      pairs.set(event, pair);
      return true;
    },
    read: (event: KeyboardEvent) => pairs?.get(event) ?? null,
    consume: (event: KeyboardEvent, pair: RowKeyboardPair) => {
      if (!pairs || pairs.get(event) !== pair) return false;
      pairs.delete(event);
      return true;
    },
    revoke: () => {
      pairs = null;
    },
    isCurrent: () => pairs !== null,
  });
}

function rowKeyboardPublicMethod(value: unknown): RowKeyboardPublicMethod | null {
  return typeof value === "function"
    ? (value as RowKeyboardPublicMethod)
    : null;
}

const ROW_KEYBOARD_PRISTINE_EXPECTATION: RowKeyboardReactExpectation =
  Object.freeze({ defaultPrevented: false, retainedDefaultQuery: true });

const ROW_KEYBOARD_PREVENTED_EXPECTATION: RowKeyboardReactExpectation =
  Object.freeze({ defaultPrevented: true, retainedDefaultQuery: false });

function captureRowKeyboardReactEvent(
  event: ReactKeyboardEvent<HTMLElement>,
  authority: RowKeyboardAuthority,
  native: RowKeyboardEventSnapshot,
  currentTarget: HTMLElement,
): RowKeyboardReactSnapshot | null {
  try {
    // Public wrapper authority only: ordinary public reads, no descriptors,
    // prototypes, private fields, or structural resemblance.
    const reactEvent = event as ReactKeyboardEvent<HTMLElement> & {
      preventDefault?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
    };
    const preventDefault = rowKeyboardPublicMethod(reactEvent.preventDefault);
    const isDefaultPrevented = rowKeyboardPublicMethod(
      reactEvent.isDefaultPrevented,
    );
    const isPropagationStopped = rowKeyboardPublicMethod(
      reactEvent.isPropagationStopped,
    );
    if (
      !preventDefault ||
      !isDefaultPrevented ||
      !isPropagationStopped ||
      authority.apply(isDefaultPrevented, event, []) !== false ||
      authority.apply(isPropagationStopped, event, []) !== false ||
      reactEvent.preventDefault !== preventDefault ||
      reactEvent.isDefaultPrevented !== isDefaultPrevented ||
      reactEvent.isPropagationStopped !== isPropagationStopped ||
      event.nativeEvent !== native.event ||
      event.type !== native.type ||
      event.target !== native.target ||
      event.currentTarget !== currentTarget ||
      event.eventPhase !== native.phase ||
      event.bubbles !== native.bubbles ||
      event.cancelable !== native.cancelable ||
      event.defaultPrevented !== native.defaultPrevented ||
      event.isTrusted !== native.trusted ||
      event.key !== native.key ||
      event.code !== native.code ||
      event.location !== native.location ||
      event.repeat !== native.repeat ||
      event.ctrlKey !== native.ctrlKey ||
      event.altKey !== native.altKey ||
      event.metaKey !== native.metaKey ||
      event.shiftKey !== native.shiftKey ||
      (event.view !== null &&
        !rowKeyboardIdentitiesMatch(event.view, authority.ownerWindow) &&
        !rowKeyboardIdentitiesMatch(
          event.view,
          native.terminal.receiver,
        )) ||
      event.detail !== native.detail
    ) {
      return null;
    }
    return Object.freeze({
      event,
      nativeEvent: native.event,
      target: native.target,
      currentTarget,
      phase: native.phase,
      view: event.view,
      methods: Object.freeze({
        preventDefault,
        isDefaultPrevented,
        isPropagationStopped,
      }),
    });
  } catch {
    return null;
  }
}

function rowKeyboardReactSnapshotMatches(
  snapshot: RowKeyboardReactSnapshot,
  authority: RowKeyboardAuthority,
  native: RowKeyboardEventSnapshot,
  currentTarget: HTMLElement | null,
  expectation: RowKeyboardReactExpectation = ROW_KEYBOARD_PRISTINE_EXPECTATION,
) {
  try {
    const event = snapshot.event as ReactKeyboardEvent<HTMLElement> & {
      preventDefault?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
    };
    const preventDefault = rowKeyboardPublicMethod(event.preventDefault);
    const isPropagationStopped = rowKeyboardPublicMethod(
      event.isPropagationStopped,
    );
    // React 19 replaces this public query when prevention succeeds: after a
    // prevention call, authenticate and invoke the current query instead of
    // demanding the pre-call identity.
    const isDefaultPrevented = rowKeyboardPublicMethod(
      event.isDefaultPrevented,
    );
    if (
      !preventDefault ||
      !isDefaultPrevented ||
      !isPropagationStopped ||
      preventDefault !== snapshot.methods.preventDefault ||
      isPropagationStopped !== snapshot.methods.isPropagationStopped ||
      (expectation.retainedDefaultQuery &&
        isDefaultPrevented !== snapshot.methods.isDefaultPrevented) ||
      event.nativeEvent !== snapshot.nativeEvent ||
      event.nativeEvent !== native.event ||
      event.type !== native.type ||
      event.target !== snapshot.target ||
      event.target !== native.target ||
      event.currentTarget !== currentTarget ||
      event.eventPhase !== snapshot.phase ||
      event.eventPhase !== native.phase ||
      event.bubbles !== native.bubbles ||
      event.cancelable !== native.cancelable ||
      event.defaultPrevented !== expectation.defaultPrevented ||
      event.isTrusted !== native.trusted ||
      event.key !== native.key ||
      event.code !== native.code ||
      event.location !== native.location ||
      event.repeat !== native.repeat ||
      event.ctrlKey !== native.ctrlKey ||
      event.altKey !== native.altKey ||
      event.metaKey !== native.metaKey ||
      event.shiftKey !== native.shiftKey ||
      event.view !== snapshot.view ||
      (event.view !== null &&
        !rowKeyboardIdentitiesMatch(event.view, authority.ownerWindow) &&
        !rowKeyboardIdentitiesMatch(
          event.view,
          native.terminal.receiver,
        )) ||
      event.detail !== native.detail ||
      authority.apply(isDefaultPrevented, snapshot.event, []) !==
        expectation.defaultPrevented ||
      authority.apply(isPropagationStopped, snapshot.event, []) !== false
    ) {
      return false;
    }
    return (
      event.preventDefault === snapshot.methods.preventDefault &&
      event.isPropagationStopped === snapshot.methods.isPropagationStopped &&
      event.isDefaultPrevented === isDefaultPrevented
    );
  } catch {
    return false;
  }
}

function rowKeyboardDestination(
  row: PublishedWebhookRow,
  source: PublishedRowAction,
  key: RowNavigationKey,
) {
  const sourceIndex = row.actions.indexOf(source);
  if (sourceIndex < 0) return null;
  let destinationIndex: number | null = null;
  if (
    (key === "ArrowLeft" || key === "ArrowUp") &&
    sourceIndex > 0
  ) {
    destinationIndex = sourceIndex - 1;
  } else if (
    (key === "ArrowRight" || key === "ArrowDown") &&
    sourceIndex + 1 < row.actions.length
  ) {
    destinationIndex = sourceIndex + 1;
  } else if (key === "Home" && sourceIndex !== 0) {
    destinationIndex = 0;
  } else if (key === "End" && sourceIndex !== row.actions.length - 1) {
    destinationIndex = row.actions.length - 1;
  }
  return destinationIndex === null
    ? null
    : row.actions[destinationIndex] ?? null;
}

function slot<T extends HTMLElement>(key: string): ElementSlot<T> {
  return {
    key,
    element: null,
    last: null,
    mouseTargets: null,
    binding: null,
  };
}

function createListOperationAuthority(
  binding: ListOperationBinding,
): ListOperationAuthority {
  let current: ListOperationBinding | null = Object.freeze(binding);
  return Object.freeze({
    read: () => current,
    release: () => {
      current = null;
    },
  });
}

function createPanelPublication(presentation: PanelPresentation): PanelPublication {
  const publication: PanelPublication = {
    identity: Symbol("webhooks-publication"),
    presentation,
    card: slot("card"),
    header: slot("header"),
    guidance: slot("guidance"),
    refresh: slot("refresh"),
    add: slot("add"),
    form: slot("form"),
    url: slot("url"),
    docs: slot("docs"),
    choices: presentation.draft.choiceInputs.map((choice) =>
      slot<HTMLInputElement>(`choice:${choice.id}`)),
    create: slot("create"),
    cancel: slot("cancel"),
    listError: slot("list-error"),
    listAlert: slot("list-alert"),
    retry: slot("retry"),
    actionError: slot("action-error"),
    created: slot("created"),
    secret: slot("secret"),
    copy: slot("copy"),
    listContent: slot("list-content"),
    rowsList: slot("rows-list"),
    rows: presentation.list.rows?.map((row) => ({
      root: slot<HTMLLIElement>(`row:${row.index}:${row.id}`),
      enable: slot<HTMLButtonElement>(`row:${row.index}:${row.id}:enable`),
      test: slot<HTMLButtonElement>(`row:${row.index}:${row.id}:test`),
      delete: slot<HTMLButtonElement>(`row:${row.index}:${row.id}:delete`),
      publication: null,
    })) ?? [],
    rowPublications: [],
    established: false,
    layoutRetired: false,
    consumed: false,
    successorRequested: false,
    invalidReplay: false,
    replayRefs: [],
    stableSlots: new Set(),
    introducedSlots: new Set(),
    dom: null,
    placement: null,
    guard: null,
    keyboard: null,
    keyboardPair: null,
    rowKeyboard: null,
    rowKeyboardPairs: createRowKeyboardPairStore(),
    keyboardSuspended: false,
    keyboardLayoutReplayAvailable: false,
    keyboardReplay: null,
    keyboardReplayExpiryQueued: false,
    guardExpiryQueued: false,
    factsAreCurrent: null,
    domIsExact: null,
    requestSuccessor: null,
  };
  return publication;
}

function expectedPanelSlots(
  publication: PanelPublication,
): ElementSlot<HTMLElement>[] {
  const facts = publication.presentation;
  const slots: ElementSlot<HTMLElement>[] = [
    publication.card,
    publication.header,
    publication.guidance,
  ];
  slots.push(publication.refresh, publication.add);
  if (facts.adding) {
    slots.push(
      publication.form,
      publication.url,
      ...publication.choices,
      publication.docs,
      publication.create,
      publication.cancel,
    );
  }
  if (facts.listError) {
    slots.push(
      publication.listError,
      publication.listAlert,
      publication.retry,
    );
  }
  if (facts.actionError) slots.push(publication.actionError);
  if (facts.created) {
    slots.push(
      publication.created,
      publication.secret,
      publication.copy,
    );
  }
  if (facts.list.kind === "loading" || facts.list.kind === "empty") {
    slots.push(publication.listContent);
  } else if (facts.list.kind === "rows") {
    slots.push(publication.listContent, publication.rowsList);
    for (const row of facts.list.rows ?? []) {
      const elements = publication.rows[row.index];
      if (!elements) continue;
      slots.push(elements.root);
      if (row.enable) slots.push(elements.enable);
      slots.push(elements.test, elements.delete);
    }
  }
  return slots;
}

function panelButtonSlots(
  publication: PanelPublication,
): ElementSlot<HTMLButtonElement>[] {
  const facts = publication.presentation;
  const slots = [publication.refresh, publication.add];
  if (facts.adding) slots.push(publication.cancel);
  if (facts.listError) slots.push(publication.retry);
  if (facts.created) slots.push(publication.copy);
  for (const row of facts.list.rows ?? []) {
    const elements = publication.rows[row.index];
    if (!elements) continue;
    if (row.enable) slots.push(elements.enable);
    slots.push(elements.test, elements.delete);
  }
  return slots;
}

function formKeyboardSlots(
  publication: PanelPublication,
): ElementSlot<HTMLElement>[] {
  return [
    publication.form,
    publication.url,
    ...publication.choices,
    publication.docs,
    publication.create,
    publication.cancel,
  ];
}

export function WebhooksPanel() {
  const [hooks, setHooks] = useState<WebhookRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [choices, setChoices] = useState<string[]>(() => [...DEFAULT_CHOICES]);
  const [docs, setDocs] = useState("");
  const [createOperation, setCreateOperation] = useState<Operation | null>(null);
  const [rowOperations, setRowOperations] = useState<Map<string, RowOperation>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listOperation, setListOperation] = useState<ListOperation | null>(null);
  const [feedbackOperation, setFeedbackOperation] = useState<Operation | null>(null);
  const [created, setCreated] = useState<CreatedWebhook | null>(null);
  const [mountGeneration] = useState<MountGeneration>(() => Object.freeze({ identity: Symbol("webhooks-mount") }));
  const [publicationRevision, setPublicationRevision] = useState(0);
  const activeMountRef = useRef<MountGeneration | null>(null);
  const operationSequence = useRef(0);
  const createOwner = useRef<Operation | null>(null);
  const rowOwners = useRef(new Map<string, RowOperation>());
  const feedbackOwner = useRef<Operation | null>(null);
  const listOwner = useRef<ListOperation | null>(null);
  const claimedListRequests = useRef(new WeakSet<ListOperation>());
  const listRequest = useRef(0);
  const [listRequestCallback] = useState<ListRequestAuthority>(
    () => Object.freeze({ identity: Symbol("webhooks-list-request") }),
  );
  const [publicationCoordinator] = useState(
    () => new PanelPublicationCoordinator(mountGeneration),
  );
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const secretTarget = useRef<HTMLElement>(null);
  const {
    copy: currentCopySecret,
    label: copyLabel,
    copied,
  } = useCopy(created?.secret ?? "", secretTarget);
  const copyCallbackRef = useRef<(() => void) | null>(null);
  const [copySecret] = useState<() => void>(
    () => () => copyCallbackRef.current?.(),
  );
  const retireListOperation = useCallback((
    expected: ListOperation | null = listOwner.current,
    updateState = true,
  ) => {
    const operation = listOwner.current;
    if (!operation || operation !== expected) return false;
    listOwner.current = null;
    listRequest.current += 1;
    operation.authority.release();
    if (!operation.controller.signal.aborted) {
      operation.controller.abort(operation.abortReason);
    }
    if (updateState) {
      setListOperation((current) => (current === operation ? null : current));
    }
    return true;
  }, []);

  useLayoutEffect(() => {
    copyCallbackRef.current = currentCopySecret;
    return () => {
      if (copyCallbackRef.current === currentCopySecret) {
        copyCallbackRef.current = null;
      }
    };
  }, [currentCopySecret]);

  useLayoutEffect(() => {
    const owners = rowOwners.current;
    publicationCoordinator.activate();
    activeMountRef.current = mountGeneration;
    return () => {
      publicationCoordinator.scheduleTeardown();
      if (activeMountRef.current !== mountGeneration) return;
      activeMountRef.current = null;
      const operation = listOwner.current;
      if (!operation || operation.generation !== mountGeneration) {
        listRequest.current += 1;
      } else {
        retireListOperation(operation, false);
      }
      if (createOwner.current?.generation === mountGeneration) createOwner.current = null;
      for (const [webhookId, operation] of owners) {
        if (operation.generation === mountGeneration) owners.delete(webhookId);
      }
      if (feedbackOwner.current?.generation === mountGeneration) feedbackOwner.current = null;
    };
  }, [mountGeneration, publicationCoordinator, retireListOperation]);

  const load = useCallback(async (continuationIsCurrent: () => boolean = () => true) => {
    const generation = activeMountRef.current;
    if (!generation) return;
    const currentRequest = ++listRequest.current;
    try {
      const res = await request<{ webhooks: WebhookRow[] }>("/api/webhooks");
      if (generation !== activeMountRef.current || currentRequest !== listRequest.current || !continuationIsCurrent()) return;
      setHooks(res.webhooks);
      setListError(null);
    } catch (e) {
      if (generation !== activeMountRef.current || currentRequest !== listRequest.current || !continuationIsCurrent()) return;
      setListError(apiErrorText(e, "Failed to load webhooks"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isCreateCurrent = (operation: Operation) =>
    operation.generation === activeMountRef.current && createOwner.current === operation;

  const isRowCurrent = (operation: RowOperation) =>
    operation.generation === activeMountRef.current && rowOwners.current.get(operation.webhookId) === operation;

  const nextOperation = (): Operation | null => {
    const generation = activeMountRef.current;
    if (!generation) return null;
    return Object.freeze({
      sequence: ++operationSequence.current,
      generation,
    });
  };

  const claimFeedback = (operation: Operation) => {
    feedbackOwner.current = operation;
    setFeedbackOperation(operation);
    setError(null);
  };

  const requestListOperation = useCallback<ListRequestCallback>((operation) => {
    if (
      operation.generation !== activeMountRef.current ||
      operation.generation !== mountGeneration ||
      operation.request !== listRequestCallback ||
      operation.requestSequence !== listRequest.current ||
      listOwner.current !== operation ||
      claimedListRequests.current.has(operation)
    ) {
      return;
    }
    claimedListRequests.current.add(operation);
    const ownsRequest = () =>
      operation.generation === activeMountRef.current &&
      operation.generation === mountGeneration &&
      operation.request === listRequestCallback &&
      operation.requestSequence === listRequest.current &&
      listOwner.current === operation &&
      publicationCoordinator.ownsListOperation(operation);
    const finishCurrentRequest = () => {
      if (listOwner.current !== operation) return false;
      listOwner.current = null;
      operation.authority.release();
      setListOperation((current) => (current === operation ? null : current));
      return true;
    };
    void (async () => {
      try {
        const res = await request<{ webhooks: WebhookRow[] }>(operation.route, {
          signal: operation.controller.signal,
        });
        if (!ownsRequest() || !finishCurrentRequest()) return;
        setHooks(res.webhooks);
        setListError(null);
      } catch (e) {
        const exactRetiredAbort =
          operation.controller.signal.aborted &&
          operation.controller.signal.reason === operation.abortReason &&
          e === operation.abortReason &&
          operation.authority.read() === null &&
          listOwner.current !== operation;
        if (exactRetiredAbort || !ownsRequest() || !finishCurrentRequest()) return;
        setListError(apiErrorText(e, "Failed to load webhooks"));
      }
    })();
  }, [listRequestCallback, mountGeneration, publicationCoordinator]);

  const beginRowOperation = (webhookId: string, kind: RowOperation["kind"]): RowOperation | null => {
    const generation = activeMountRef.current;
    if (!generation || rowOwners.current.has(webhookId)) return null;
    const operation = Object.freeze({
      sequence: ++operationSequence.current,
      generation,
      webhookId,
      kind,
    });
    claimFeedback(operation);
    rowOwners.current.set(webhookId, operation);
    setRowOperations((current) => new Map(current).set(webhookId, operation));
    retireListOperation();
    return operation;
  };

  const finishRowOperation = (operation: RowOperation) => {
    if (!isRowCurrent(operation)) return;
    rowOwners.current.delete(operation.webhookId);
    setRowOperations((current) => {
      if (current.get(operation.webhookId) !== operation) return current;
      const next = new Map(current);
      next.delete(operation.webhookId);
      return next;
    });
  };

  const setOperationError = (operation: Operation, message: string) => {
    if (operation.generation === activeMountRef.current && feedbackOwner.current === operation) {
      setError(message);
    }
  };

  const startCreate = (presentation: PanelPresentation) => {
    if (createOwner.current) return;
    const operation = nextOperation();
    if (!operation) return;
    claimFeedback(operation);
    createOwner.current = operation;
    setCreateOperation(operation);
    retireListOperation();
    const exactUrl = presentation.draft.url;
    const exactDocs = presentation.draft.docs;
    const exactChoices = presentation.draft.choiceInputs;
    const events = exactChoices.filter((choice) => choice.checked).flatMap((choice) => [...choice.types]);
    const documentIds = exactDocs
      .split(/[\s,]+/)
      .map((value) => value.trim().replace(/^.*\/d\//, ""))
      .filter(Boolean);
    void (async () => {
      try {
        const res = await request<{ webhook: WebhookRow & { secret: string } }>(presentation.create!.route!, {
          method: "POST",
          body: JSON.stringify({ url: exactUrl, events, documentIds: documentIds.length ? documentIds : null }),
        });
        if (!isCreateCurrent(operation)) return;
        setCreated({ id: res.webhook.id, secret: res.webhook.secret, url: res.webhook.url });
        setUrl("");
        setDocs("");
        setAdding(false);
        retireListOperation();
        await load(() => isCreateCurrent(operation));
      } catch (e) {
        if (isCreateCurrent(operation)) {
          setOperationError(operation, apiErrorText(e, "Could not add webhook"));
        }
      } finally {
        if (isCreateCurrent(operation)) {
          createOwner.current = null;
          setCreateOperation((current) => (current === operation ? null : current));
        }
      }
    })();
  };

  const startListOperation = (
    candidate: PanelPublication,
    action: ActionFacts,
    intent: ListOperationIntent,
  ) => {
    const root = candidate.card.element;
    const placement = candidate.placement;
    if (
      listOwner.current ||
      createOwner.current ||
      rowOwners.current.size > 0 ||
      !root ||
      !placement ||
      !action.eligible ||
      action.kind !== intent ||
      action.route !== "/api/webhooks" ||
      candidate.presentation.createOperation !== null ||
      candidate.presentation.rowOperationsSource.size > 0 ||
      candidate.presentation.listOperation !== null ||
      candidate.presentation.requestList !== listRequestCallback ||
      candidate.presentation.generation !== activeMountRef.current ||
      root.ownerDocument !== placement.document ||
      !panelPlacementMatches(root, placement)
    ) {
      return;
    }
    const operation = nextOperation();
    if (!operation) return;
    const controller = new AbortController();
    const authority = createListOperationAuthority({
      activation: candidate,
      action,
      root,
      document: root.ownerDocument,
      placement,
    });
    const listOwnerOperation = Object.freeze<ListOperation>({
      ...operation,
      intent,
      requestSequence: ++listRequest.current,
      request: listRequestCallback,
      route: "/api/webhooks",
      controller,
      abortReason: new RetiredListOperationAbort(authority),
      authority,
    });
    listOwner.current = listOwnerOperation;
    setListOperation(listOwnerOperation);
    requestListOperation(listOwnerOperation);
  };

  const startTest = (row: WebhookRowFacts) => {
    const operation = beginRowOperation(row.id, "test");
    if (!operation) return;
    void (async () => {
      try {
        await request(row.test.route, { method: "POST" });
        if (!isRowCurrent(operation)) return;
        retireListOperation();
        await load(() => isRowCurrent(operation));
      } catch (e) {
        if (isRowCurrent(operation)) {
          setOperationError(operation, apiErrorText(e, "Test failed"));
        }
      } finally {
        finishRowOperation(operation);
      }
    })();
  };

  const startEnable = (row: WebhookRowFacts) => {
    const operation = beginRowOperation(row.id, "enable");
    if (!operation || !row.enable) return;
    void (async () => {
      try {
        await request<{ webhook: WebhookRow }>(row.enable!.route, { method: "POST" });
        if (!isRowCurrent(operation)) return;
        retireListOperation();
        await load(() => isRowCurrent(operation));
      } catch (e) {
        if (isRowCurrent(operation)) {
          setOperationError(operation, apiErrorText(e, "Could not enable webhook"));
        }
      } finally {
        finishRowOperation(operation);
      }
    })();
  };

  const startDelete = (row: WebhookRowFacts) => {
    const operation = beginRowOperation(row.id, "delete");
    if (!operation) return;
    void (async () => {
      try {
        await request(row.delete.route, { method: "DELETE" });
        if (!isRowCurrent(operation)) return;
        setCreated((current) => (current?.id === row.id ? null : current));
        retireListOperation();
        await load(() => isRowCurrent(operation));
      } catch (e) {
        if (isRowCurrent(operation)) {
          setOperationError(operation, apiErrorText(e, "Could not delete webhook"));
        }
      } finally {
        finishRowOperation(operation);
      }
    })();
  };

  const presentation = useMemo<PanelPresentation>(() => {
    const choiceInputs = Object.freeze(
      EVENT_CHOICES.map((choice, index) =>
        Object.freeze<ChoiceFacts>({
          kind: "choice",
          index,
          id: choice.id,
          label: choice.label,
          types: choice.types,
          checked: choices.includes(choice.id),
          eligible: createOperation === null,
        }),
      ),
    );
    const draft = Object.freeze<DraftFacts>({
      url,
      docs,
      choices: Object.freeze([...choices]),
      urlInput: Object.freeze({ kind: "url", value: url, eligible: createOperation === null }),
      docsInput: Object.freeze({ kind: "docs", value: docs, eligible: createOperation === null }),
      choiceInputs,
    });
    const rowFacts = hooks
      ? Object.freeze(
          hooks.map((hook, index) =>
            snapshotRow(hook, index, rowOperations.get(hook.id) ?? null)),
        )
      : null;
    const list = Object.freeze<ListFacts>({
      kind: hooks === null
        ? (listError ? "unavailable" : "loading")
        : hooks.length === 0
          ? "empty"
          : "rows",
      rows: rowFacts,
    });
    const createdFacts = created
      ? Object.freeze<CreatedFacts>({
          source: created,
          id: created.id,
          secret: created.secret,
          url: created.url,
        })
      : null;
    const listOperationEligible =
      createOperation === null &&
      rowOperations.size === 0 &&
      listOperation === null;
    const createAction = adding
      ? Object.freeze<ActionFacts>({
          kind: "create",
          eligible:
            createOperation === null &&
            url.trim().length > 0 &&
            choices.length > 0,
          route: "/api/webhooks",
        })
      : null;
    const cancelAction = adding
      ? Object.freeze<ActionFacts>({
          kind: "cancel",
          eligible: createOperation === null,
          route: null,
        })
      : null;
    const createControls =
      createAction && cancelAction
        ? Object.freeze([createAction, cancelAction] as const)
        : null;
    return Object.freeze({
      identity: Symbol("webhooks-presentation"),
      revision: publicationRevision,
      callbackToken: publicationCoordinator.callbackToken,
      generation: mountGeneration,
      hooksSource: hooks,
      choicesSource: choices,
      rowOperationsSource: rowOperations,
      createdSource: created,
      adding,
      draft,
      createOperation,
      listOperation,
      feedbackOperation,
      requestList: listRequestCallback,
      listError,
      actionError: error,
      created: createdFacts,
      list,
      add: Object.freeze({ kind: "add", eligible: createOperation === null, route: null }),
      refresh: Object.freeze({
        kind: "refresh",
        eligible:
          (hooks !== null || listError !== null) &&
          listOperationEligible,
        route: "/api/webhooks",
      }),
      create: createAction,
      cancel: cancelAction,
      createControls,
      retry: listError
        ? Object.freeze({
            kind: "retry",
            eligible: listOperationEligible,
            route: "/api/webhooks",
          })
        : null,
      copy: created
        ? Object.freeze({ kind: "copy", eligible: true, route: null })
        : null,
      copyLabel,
      copied,
    });
  }, [
    adding,
    choices,
    copied,
    copyLabel,
    createOperation,
    created,
    docs,
    error,
    feedbackOperation,
    hooks,
    listRequestCallback,
    listOperation,
    listError,
    mountGeneration,
    publicationCoordinator,
    publicationRevision,
    rowOperations,
    url,
  ]);
  const publication = useMemo(
    () => createPanelPublication(presentation),
    [presentation],
  );

  const bindElement = <T extends HTMLElement>(
    candidate: PanelPublication,
    owner: ElementSlot<T>,
    afterBind?: (element: T | null) => void,
  ): RefCallback<T> => {
    owner.binding ??= (element) => {
      publicationCoordinator.bind(candidate, owner, element);
      afterBind?.(element);
    };
    return owner.binding;
  };

  const domIsExact = useCallback((
    candidate: PanelPublication,
    override?: InputDomOverride,
    focus?: HTMLElement,
  ): boolean => {
    const facts = candidate.presentation;
    const card = candidate.card.element;
    const header = candidate.header.element;
    const guidance = candidate.guidance.element;
    const refreshButton = candidate.refresh.element;
    const addButton = candidate.add.element;
    if (
      !card ||
      !header ||
      !guidance ||
      !addButton ||
      !card.ownerDocument.defaultView ||
      expectedPanelSlots(candidate).some(
        (owner) =>
          !owner.element ||
          owner.element.ownerDocument !== card.ownerDocument,
      ) ||
      !card.isConnected ||
      !header.isConnected ||
      !guidance.isConnected ||
      !addButton.isConnected ||
      card.id !== "webhooks" ||
      card.dataset.testid !== "webhooks-card" ||
      card.children.item(0) !== header ||
      card.children.item(1) !== guidance ||
      header.parentElement !== card ||
      guidance.parentElement !== card ||
      header.children.length !== 3 ||
      header.lastElementChild !== addButton ||
      addButton.parentElement !== header ||
      addButton.type !== "button" ||
      ((!focus || focus === addButton) && addButton.disabled !== !facts.add.eligible) ||
      addButton.dataset.testid !== "webhook-add" ||
      addButton.textContent?.trim() !== "Add webhook"
    ) {
      return false;
    }
    const refreshing = facts.listOperation?.intent === "refresh";
    if (
      !refreshButton ||
      !refreshButton.isConnected ||
      refreshButton.parentElement !== header ||
      header.children.item(1) !== refreshButton ||
      refreshButton.nextElementSibling !== addButton ||
      refreshButton.type !== "button" ||
      ((!focus || focus === refreshButton) &&
        refreshButton.disabled !== !facts.refresh.eligible) ||
      refreshButton.dataset.testid !== "webhook-refresh" ||
      refreshButton.getAttribute("aria-busy") !== (refreshing ? "true" : null) ||
      refreshButton.textContent?.trim() !== (
        refreshing ? "Refreshing webhooks" : "Refresh webhooks"
      )
    ) {
      return false;
    }

    const directChildren: HTMLElement[] = [header, guidance];
    const form = candidate.form.element;
    if (facts.adding) {
      const urlInput = candidate.url.element;
      const docsInput = candidate.docs.element;
      const createButton = candidate.create.element;
      const cancelButton = candidate.cancel.element;
      if (
        !facts.create ||
        !facts.cancel ||
        !form ||
        !urlInput ||
        !docsInput ||
        !createButton ||
        !cancelButton ||
        !form.isConnected ||
        !urlInput.isConnected ||
        !docsInput.isConnected ||
        !createButton.isConnected ||
        !cancelButton.isConnected ||
        form.parentElement !== card ||
        form.dataset.testid !== "webhook-form" ||
        form.tabIndex !== -1 ||
        form.getAttribute("aria-busy") !== (facts.createOperation ? "true" : null) ||
        form.children.length !== 4 ||
        urlInput.form !== form ||
        docsInput.form !== form ||
        createButton.form !== form ||
        cancelButton.form !== form ||
        form.children.item(0) !== urlInput.parentElement ||
        form.children.item(2) !== docsInput.parentElement ||
        form.children.item(3) !== createButton.parentElement ||
        createButton.parentElement !== cancelButton.parentElement ||
        createButton.parentElement?.children.length !== 2 ||
        createButton.parentElement.children.item(0) !== createButton ||
        createButton.parentElement.children.item(1) !== cancelButton ||
        urlInput.dataset.testid !== "webhook-url" ||
        ((!focus || focus === createButton || focus === urlInput) &&
          urlInput.value !== (override?.input === urlInput && override.value !== undefined ? override.value : facts.draft.url)) ||
        ((!focus || focus === createButton || focus === urlInput) &&
          urlInput.disabled !== !facts.draft.urlInput.eligible) ||
        !urlInput.required ||
        docsInput.dataset.testid !== "webhook-docs" ||
        ((!focus || focus === createButton || focus === docsInput) &&
          docsInput.value !== (override?.input === docsInput && override.value !== undefined ? override.value : facts.draft.docs)) ||
        ((!focus || focus === createButton || focus === docsInput) &&
          docsInput.disabled !== !facts.draft.docsInput.eligible) ||
        createButton.dataset.testid !== "webhook-create" ||
        createButton.type !== "submit" ||
        ((!focus || focus === createButton) && createButton.disabled !== !facts.create.eligible) ||
        createButton.textContent?.trim() !== "Add webhook" ||
        cancelButton.type !== "button" ||
        ((!focus || focus === cancelButton) && cancelButton.disabled !== !facts.cancel.eligible) ||
        cancelButton.textContent?.trim() !== "Cancel"
      ) {
        return false;
      }
      const fieldset = form.children.item(1);
      const choicesContainer = fieldset?.children.item(1);
      if (
        !(fieldset instanceof card.ownerDocument.defaultView.HTMLFieldSetElement) ||
        fieldset.disabled !== (facts.createOperation !== null) ||
        !choicesContainer ||
        choicesContainer.children.length !== facts.draft.choiceInputs.length ||
        candidate.choices.length !== facts.draft.choiceInputs.length
      ) {
        return false;
      }
      for (const choice of facts.draft.choiceInputs) {
        const input = candidate.choices[choice.index]?.element;
        const label: Element | null = choicesContainer.children.item(choice.index);
        if (
          !input ||
          !input.isConnected ||
          input.form !== form ||
          input.parentElement !== label ||
          label?.parentElement !== choicesContainer ||
          input.type !== "checkbox" ||
          input.dataset.testid !== `webhook-event-${choice.id}` ||
          ((!focus || focus === createButton || focus === input) &&
            input.checked !== (override?.input === input && override.checked !== undefined ? override.checked : choice.checked)) ||
          input.disabled ||
          ((!focus || focus === createButton || focus === input) &&
            input.matches(":disabled") !== !choice.eligible) ||
          label.textContent?.trim() !== choice.label
        ) {
          return false;
        }
      }
      directChildren.push(form);
    } else if (
      form ||
      candidate.url.element ||
      candidate.docs.element ||
      candidate.create.element ||
      candidate.cancel.element ||
      candidate.choices.some((choice) => choice.element)
    ) {
      return false;
    }

    const listErrorBlock = candidate.listError.element;
    const listAlert = candidate.listAlert.element;
    const retryButton = candidate.retry.element;
    if (facts.listError) {
      if (
        !facts.retry ||
        !listErrorBlock ||
        !listAlert ||
        !retryButton ||
        !listErrorBlock.isConnected ||
        !listAlert.isConnected ||
        !retryButton.isConnected ||
        listErrorBlock.parentElement !== card ||
        listErrorBlock.dataset.testid !== "webhooks-list-error" ||
        listErrorBlock.children.length !== 2 ||
        listErrorBlock.children.item(0) !== listAlert ||
        listErrorBlock.children.item(1) !== retryButton ||
        listAlert.parentElement !== listErrorBlock ||
        listAlert.getAttribute("role") !== "alert" ||
        listAlert.getAttribute("aria-atomic") !== "true" ||
        listAlert.textContent !== facts.listError ||
        retryButton.parentElement !== listErrorBlock ||
        retryButton.type !== "button" ||
        ((!focus || focus === retryButton) && retryButton.disabled !== !facts.retry.eligible) ||
        retryButton.getAttribute("aria-busy") !== (
          facts.listOperation?.intent === "retry" ? "true" : null
        ) ||
        retryButton.textContent?.trim() !== (
          facts.listOperation?.intent === "retry" ? "Retrying…" : "Retry"
        )
      ) {
        return false;
      }
      directChildren.push(listErrorBlock);
    } else if (listErrorBlock || listAlert || retryButton || facts.retry) {
      return false;
    }

    const actionError = candidate.actionError.element;
    if (facts.actionError) {
      if (
        !actionError ||
        !actionError.isConnected ||
        actionError.parentElement !== card ||
        actionError.dataset.testid !== "webhook-action-error" ||
        actionError.getAttribute("role") !== "alert" ||
        actionError.getAttribute("aria-atomic") !== "true" ||
        actionError.textContent !== facts.actionError
      ) {
        return false;
      }
      directChildren.push(actionError);
    } else if (actionError) {
      return false;
    }

    const createdRoot = candidate.created.element;
    if (facts.created) {
      const secret = candidate.secret.element;
      const copyButton = candidate.copy.element;
      const secretRow = secret?.parentElement;
      if (
        !facts.copy ||
        !createdRoot ||
        !secret ||
        !copyButton ||
        !secretRow ||
        !createdRoot.isConnected ||
        !secret.isConnected ||
        !copyButton.isConnected ||
        createdRoot.parentElement !== card ||
        createdRoot.dataset.testid !== "webhook-created" ||
        createdRoot.getAttribute("role") !== "status" ||
        createdRoot.getAttribute("aria-live") !== "polite" ||
        createdRoot.getAttribute("aria-atomic") !== "true" ||
        createdRoot.children.length !== 3 ||
        createdRoot.children.item(0)?.textContent !== "Webhook added. Copy the signing secret now; it will not be shown again." ||
        createdRoot.children.item(1) !== secretRow ||
        secretRow.parentElement !== createdRoot ||
        secretRow.children.length !== 2 ||
        secretRow.children.item(0) !== secret ||
        secretRow.children.item(1) !== copyButton ||
        secret.parentElement !== secretRow ||
        secret.dataset.testid !== "webhook-secret" ||
        secret.textContent !== facts.created.secret ||
        copyButton.parentElement !== secretRow ||
        copyButton.type !== "button" ||
        copyButton.disabled ||
        copyButton.getAttribute("aria-label") !== "Copy secret" ||
        copyButton.textContent?.trim() !== facts.copyLabel
      ) {
        return false;
      }
      directChildren.push(createdRoot);
    } else if (
      createdRoot ||
      candidate.secret.element ||
      candidate.copy.element ||
      facts.copy
    ) {
      return false;
    }

    const listContent = candidate.listContent.element;
    const rowsList = candidate.rowsList.element;
    if (facts.list.kind === "unavailable") {
      if (listContent || rowsList || candidate.rows.length !== 0) return false;
    } else if (facts.list.kind === "loading") {
      if (
        !listContent ||
        !listContent.isConnected ||
        listContent.parentElement !== card ||
        listContent.textContent !== "Loading…" ||
        rowsList ||
        candidate.rows.length !== 0
      ) {
        return false;
      }
      directChildren.push(listContent);
    } else if (facts.list.kind === "empty") {
      if (
        !listContent ||
        !listContent.isConnected ||
        listContent.parentElement !== card ||
        listContent.dataset.testid !== "webhooks-empty" ||
        listContent.textContent?.trim() !== "No webhooks yet." ||
        rowsList ||
        candidate.rows.length !== 0
      ) {
        return false;
      }
      directChildren.push(listContent);
    } else {
      const rows = facts.list.rows;
      if (
        !rows ||
        !listContent ||
        !rowsList ||
        listContent !== rowsList ||
        !rowsList.isConnected ||
        rowsList.parentElement !== card ||
        rowsList.children.length !== rows.length ||
        candidate.rows.length !== rows.length
      ) {
        return false;
      }
      for (const row of rows) {
        const elements = candidate.rows[row.index];
        const root = elements?.root.element;
        const enableButton = elements?.enable.element;
        const testButton = elements?.test.element;
        const deleteButton = elements?.delete.element;
        const status = root?.children.item(1);
        const content = root?.children.item(0);
        const expectedChildren = row.enable ? 5 : 4;
        const validateEligibility = !focus || (root?.contains(focus) ?? false);
        if (
          !elements ||
          !root ||
          !testButton ||
          !deleteButton ||
          !root.isConnected ||
          !testButton.isConnected ||
          !deleteButton.isConnected ||
          rowsList.children.item(row.index) !== root ||
          root.parentElement !== rowsList ||
          root.dataset.testid !== "webhook-row" ||
          root.children.length !== expectedChildren ||
          !content ||
          content.children.length !== 2 ||
          content.children.item(0)?.textContent !== row.url ||
          content.children.item(1)?.textContent !== row.details ||
          status?.getAttribute("data-testid") !== "webhook-status" ||
          status.textContent?.trim() !== row.statusText ||
          !status.classList.contains(row.statusTone === "ok" ? "text-success" : row.statusTone === "bad" ? "text-danger" : "text-ink-3") ||
          testButton.parentElement !== root ||
          testButton.type !== "button" ||
          testButton.dataset.testid !== "webhook-test" ||
          (validateEligibility && testButton.disabled !== !row.test.eligible) ||
          testButton.textContent?.trim() !== "Send test" ||
          deleteButton.parentElement !== root ||
          deleteButton.type !== "button" ||
          deleteButton.dataset.testid !== "webhook-delete" ||
          (validateEligibility && deleteButton.disabled !== !row.delete.eligible) ||
          deleteButton.getAttribute("aria-label") !== `Delete webhook ${row.url}` ||
          root.lastElementChild !== deleteButton
        ) {
          return false;
        }
        if (row.enable) {
          if (
            !enableButton ||
            !enableButton.isConnected ||
            enableButton.parentElement !== root ||
            enableButton.type !== "button" ||
            enableButton.dataset.testid !== "webhook-enable" ||
            (validateEligibility && enableButton.disabled !== !row.enable.eligible) ||
            enableButton.textContent?.trim() !== "Enable" ||
            root.children.item(2) !== enableButton ||
            root.children.item(3) !== testButton
          ) {
            return false;
          }
        } else if (enableButton || root.children.item(2) !== testButton) {
          return false;
        }
      }
      directChildren.push(rowsList);
    }

    return (
      card.children.length === directChildren.length &&
      directChildren.every((element, index) => card.children.item(index) === element)
    );
  }, []);

  const factsAreCurrent = useCallback((candidate: PanelPublication): boolean => {
    const facts = candidate.presentation;
    if (
      activeMountRef.current !== facts.generation ||
      facts.generation !== mountGeneration ||
      facts.revision !== publicationRevision ||
      facts.callbackToken !== publicationCoordinator.callbackToken ||
      facts.hooksSource !== hooks ||
      facts.choicesSource !== choices ||
      facts.rowOperationsSource !== rowOperations ||
      facts.createdSource !== created ||
      facts.adding !== adding ||
      facts.draft.url !== url ||
      facts.draft.docs !== docs ||
      !arraysMatch(choices, facts.draft.choices) ||
      facts.createOperation !== createOperation ||
      facts.listOperation !== listOperation ||
      facts.feedbackOperation !== feedbackOperation ||
      facts.requestList !== listRequestCallback ||
      feedbackOperation !== feedbackOwner.current ||
      facts.listError !== listError ||
      facts.actionError !== error ||
      facts.copyLabel !== copyLabel ||
      facts.copied !== copied ||
      !createControlsAreExact(facts) ||
      (facts.adding
        ? facts.createControls === null
        : facts.createControls !== null) ||
      !createdMatchesSnapshot(created, facts.created) ||
      (createOperation
        ? createOwner.current !== createOperation || createOperation.generation !== mountGeneration
        : createOwner.current !== null) ||
      (listOperation
        ? listOwner.current !== listOperation ||
          listOperation.generation !== mountGeneration ||
          listOperation.request !== listRequestCallback ||
          listOperation.requestSequence !== listRequest.current
        : listOwner.current !== null)
    ) {
      return false;
    }
    const rows = facts.list.rows;
    if (hooks === null) {
      if (rows !== null) return false;
    } else {
      if (!rows || hooks.length !== rows.length || rowOperations.size !== rows.length - rows.filter((row) => row.operation === null).length) {
        return false;
      }
      for (const row of rows) {
        const current = hooks[row.index];
        const stateOperation = rowOperations.get(row.id) ?? null;
        const ownerOperation = rowOwners.current.get(row.id) ?? null;
        if (
          !current ||
          !rowMatchesSnapshot(current, row) ||
          stateOperation !== row.operation ||
          ownerOperation !== row.operation ||
          (row.operation &&
            (row.operation.generation !== mountGeneration ||
              row.operation.webhookId !== row.id))
        ) {
          return false;
        }
      }
    }
    return true;
  }, [
    adding,
    choices,
    copied,
    copyLabel,
    createOperation,
    created,
    docs,
    error,
    feedbackOperation,
    hooks,
    listError,
    mountGeneration,
    publicationCoordinator,
    publicationRevision,
    listOperation,
    listRequestCallback,
    rowOperations,
    url,
  ]);

  const ownsPanel = (
    candidate: PanelPublication,
    override?: InputDomOverride,
    focus?: HTMLElement,
  ): boolean =>
    publicationCoordinator.owns(candidate) &&
    factsAreCurrent(candidate) &&
    domIsExact(candidate, override, focus);

  const ownsPanelAction = (
    candidate: PanelPublication,
    action: ActionFacts | RowActionFacts,
    element: HTMLButtonElement,
    owner: ElementSlot<HTMLButtonElement>,
  ): boolean =>
    action.eligible &&
    owner.element === element &&
    element.isConnected &&
    !element.disabled &&
    ownsPanel(candidate, undefined, element);

  const claimPublishedClick = (
    candidate: PanelPublication,
    row: WebhookRowFacts | CreatedFacts | null,
    action: ActionFacts | RowActionFacts,
    event: ReactMouseEvent<HTMLButtonElement>,
    owner: ElementSlot<HTMLButtonElement>,
  ) => {
    if (!action.eligible || event.currentTarget.disabled) return false;
    const nativeEvent = isNativeReactMouseEvent(
      event,
      owner.element,
      owner.mouseTargets,
      candidate.card.element,
    );
    if (!nativeEvent) return false;
    publicationCoordinator.prepareControlClaim(candidate);
    if (!ownsPanelAction(candidate, action, event.currentTarget, owner)) {
      return false;
    }
    return publicationCoordinator.claim(
      candidate,
      row,
      action,
      event,
      nativeEvent,
    );
  };

  const claimPublishedEscape = (
    candidate: PanelPublication,
    action: ActionFacts,
    event: ReactKeyboardEvent<HTMLFormElement>,
  ): Readonly<{
    authority: FormKeyboardAuthority;
    nativeEvent: KeyboardEvent;
  }> | null => {
    const delivery = capturePublishedFormKeyboardBubble(candidate, event);
    const authority = delivery?.authority;
    if (
      !action.eligible ||
      !authority ||
      !delivery ||
      candidate.keyboardSuspended ||
      candidate.keyboardReplay
    ) {
      return null;
    }
    const { native, pair } = delivery;
    if (
      native.key !== "Escape" ||
      pair.capture.event === event
    ) {
      return null;
    }
    publicationCoordinator.prepareControlClaim(candidate);
    if (
      candidate.keyboard !== authority ||
      candidate.form.element !== authority.form ||
      candidate.card.element !== authority.root ||
      candidate.presentation.cancel !== action ||
      !formKeyboardEventMatches(authority, native) ||
      capturePublishedFormKeyboardBubble(candidate, event)?.pair !== pair ||
      !ownsPanel(candidate) ||
      !publicationCoordinator.claim(
        candidate,
        null,
        action,
        event,
        native.event,
        pair,
      )
    ) {
      return null;
    }
    return Object.freeze({ authority, nativeEvent: native.event });
  };

  const claimPublishedCreateNavigation = (
    candidate: PanelPublication,
    event: ReactKeyboardEvent<HTMLFormElement>,
  ): Readonly<{
    authority: FormKeyboardAuthority;
    nativeEvent: KeyboardEvent;
    destination: HTMLButtonElement;
  }> | null => {
    const delivery = capturePublishedFormKeyboardBubble(candidate, event);
    const authority = delivery?.authority;
    const controls = candidate.presentation.createControls;
    if (
      !authority ||
      !delivery ||
      !controls ||
      !createControlsAreExact(candidate.presentation) ||
      candidate.keyboardSuspended ||
      candidate.keyboardReplay
    ) {
      return null;
    }
    const { native, pair } = delivery;
    if (
      !isFormNavigationKey(native.key) ||
      pair.capture.event === event
    ) {
      return null;
    }
    const owners = [candidate.create, candidate.cancel] as const;
    const elements = [owners[0].element, owners[1].element] as const;
    const sourceIndex = elements.findIndex(
      (element) => element === native.target,
    );
    const controlIsEnabled = (index: number) => {
      const action = controls[index];
      const owner = owners[index];
      const element = elements[index];
      return Boolean(
        action &&
          owner &&
          element &&
          action.eligible &&
          owner.element === element &&
          element.isConnected &&
          !element.disabled,
      );
    };
    if (sourceIndex < 0 || !controlIsEnabled(sourceIndex)) return null;

    let destinationIndex: number | null = null;
    if (native.key === "ArrowLeft" || native.key === "ArrowUp") {
      for (let index = sourceIndex - 1; index >= 0; index -= 1) {
        if (controlIsEnabled(index)) {
          destinationIndex = index;
          break;
        }
      }
    } else if (native.key === "ArrowRight" || native.key === "ArrowDown") {
      for (let index = sourceIndex + 1; index < elements.length; index += 1) {
        if (controlIsEnabled(index)) {
          destinationIndex = index;
          break;
        }
      }
    } else if (native.key === "Home") {
      destinationIndex = elements.findIndex((_, index) =>
        controlIsEnabled(index));
    } else {
      for (let index = elements.length - 1; index >= 0; index -= 1) {
        if (controlIsEnabled(index)) {
          destinationIndex = index;
          break;
        }
      }
    }
    if (
      destinationIndex === null ||
      destinationIndex < 0 ||
      destinationIndex === sourceIndex
    ) {
      return null;
    }
    const source = elements[sourceIndex];
    const destination = elements[destinationIndex];
    if (!source || !destination || source === destination) return null;

    publicationCoordinator.prepareControlClaim(candidate);
    if (
      candidate.keyboard !== authority ||
      candidate.form.element !== authority.form ||
      candidate.card.element !== authority.root ||
      candidate.presentation.createControls !== controls ||
      controls[0] !== candidate.presentation.create ||
      controls[1] !== candidate.presentation.cancel ||
      elements[0] !== candidate.create.element ||
      elements[1] !== candidate.cancel.element ||
      native.target !== source ||
      !controlIsEnabled(sourceIndex) ||
      !controlIsEnabled(destinationIndex) ||
      !formKeyboardEventMatches(authority, native) ||
      capturePublishedFormKeyboardBubble(candidate, event)?.pair !== pair ||
      !ownsPanel(candidate) ||
      !publicationCoordinator.claim(
        candidate,
        null,
        controls,
        event,
        native.event,
        pair,
      )
    ) {
      return null;
    }
    return Object.freeze({
      authority,
      nativeEvent: native.event,
      destination,
    });
  };

  const rowNavigationIsCurrent = (
    candidate: PanelPublication,
    authority: RowKeyboardAuthority,
    published: PublishedWebhookRow,
    source: PublishedRowAction,
    destination: PublishedRowAction,
    key: RowNavigationKey,
  ) => {
    const list = candidate.rowsList.element;
    if (
      candidate.rowKeyboard !== authority ||
      authority.panel !== candidate ||
      authority.root !== candidate.card.element ||
      authority.list !== list ||
      authority.rows !== candidate.rowPublications ||
      authority.document !== candidate.card.element?.ownerDocument ||
      authority.ownerWindow !== authority.document.defaultView ||
      !authority.isCurrent() ||
      !candidate.rowPublications.includes(published) ||
      !publishedWebhookRowIsCurrent(candidate, published) ||
      !published.actions.includes(source) ||
      !published.actions.includes(destination) ||
      source === destination ||
      source.panel !== candidate ||
      destination.panel !== candidate ||
      source.rowIdentity !== published.identity ||
      destination.rowIdentity !== published.identity ||
      source.callbackToken !== candidate.presentation.callbackToken ||
      destination.callbackToken !== candidate.presentation.callbackToken ||
      source.facts !== (
        source.kind === "enable"
          ? published.facts.enable
          : source.kind === "test"
            ? published.facts.test
            : published.facts.delete
      ) ||
      destination.facts !== (
        destination.kind === "enable"
          ? published.facts.enable
          : destination.kind === "test"
            ? published.facts.test
            : published.facts.delete
      ) ||
      !source.facts.eligible ||
      !destination.facts.eligible ||
      source.owner.element !== source.element ||
      destination.owner.element !== destination.element ||
      source.element.disabled ||
      destination.element.disabled ||
      source.element.ownerDocument !== authority.document ||
      destination.element.ownerDocument !== authority.document ||
      source.element.parentElement !== published.root ||
      destination.element.parentElement !== published.root ||
      rowKeyboardDestination(published, source, key) !== destination ||
      !ownsPanel(candidate, undefined, source.element)
    ) {
      return false;
    }
    try {
      return (
        rowKeyboardNativeValue<Element | null>(
          authority,
          authority.activeElement,
          authority.document,
        ) === source.element
      );
    } catch {
      return false;
    }
  };

  const capturePublishedRowNavigation = (
    candidate: PanelPublication,
    row: WebhookRowFacts,
    event: ReactKeyboardEvent<HTMLLIElement>,
  ) => {
    let nativeEvent: unknown;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    const pairs = candidate.rowKeyboardPairs;
    if (
      !nativeEvent ||
      typeof nativeEvent !== "object" ||
      !pairs ||
      !pairs.isCurrent() ||
      pairs.read(nativeEvent as KeyboardEvent) !== null ||
      publicationCoordinator.rowKeyboardIsFenced() ||
      !publicationCoordinator.prepareRowKeyboardCapture(event, nativeEvent)
    ) {
      return;
    }
    const store: RowKeyboardPairStore = pairs;
    publicationCoordinator.fenceRowKeyboard(() => {
      const authority = candidate.rowKeyboard;
      const elements = candidate.rows[row.index];
      const published = elements?.publication;
      const root = elements?.root.element;
      if (
        !authority ||
        !published ||
        !root ||
        published.facts !== row ||
        candidate.rowPublications[row.index] !== published
      ) {
        return;
      }
      const native = captureRowKeyboardEvent(
        authority,
        nativeEvent as Event,
        authority.Event.CAPTURING_PHASE,
      );
      // The row-capture wrapper is authenticated on its own, at its actual
      // capture phase and row currentTarget.
      const capture = native
        ? captureRowKeyboardReactEvent(
            event as ReactKeyboardEvent<HTMLElement>,
            authority,
            native,
            root,
          )
        : null;
      const source = native
        ? published.actions.find(({ element }) => element === native.target)
        : undefined;
      const destination =
        source && native
          ? rowKeyboardDestination(published, source, native.key)
          : null;
      if (
        !native ||
        !capture ||
        !source ||
        !destination ||
        native.terminal !== authority.terminal.proofFor(native.event) ||
        !rowKeyboardSnapshotRemainsExact(native, authority) ||
        !rowKeyboardReactSnapshotMatches(capture, authority, native, root) ||
        !rowNavigationIsCurrent(
          candidate,
          authority,
          published,
          source,
          destination,
          native.key,
        )
      ) {
        return;
      }
      const pair: RowKeyboardPair = Object.freeze({
        publication: candidate,
        authority,
        row: published,
        native,
        capture,
        terminal: native.terminal,
        source,
        destination,
        key: native.key,
        movement: Object.freeze({
          panel: candidate,
          row: published,
          source,
          destination,
          key: native.key,
        }),
        publicationClaim: Object.freeze({ publication: candidate }),
        rowClaim: Object.freeze({ row: published }),
        movementClaim: Object.freeze({
          row: published,
          source,
          destination,
          key: native.key,
        }),
        wrapperClaim: Object.freeze({ capture: event }),
        nativeClaim: Object.freeze({ nativeEvent }),
        windowClaim: Object.freeze({
          registration: authority.terminal,
          proof: native.terminal,
          receiver: native.terminal.receiver,
        }),
        sourceClaim: Object.freeze({ source }),
        destinationClaim: Object.freeze({ destination }),
      });
      if (
        candidate.rowKeyboardPairs !== store ||
        !store.isCurrent() ||
        store.read(native.event) !== null ||
        candidate.rowKeyboard !== authority ||
        !authority.terminal.isCurrent() ||
        native.terminal !== authority.terminal.proofFor(native.event) ||
        !rowKeyboardSnapshotRemainsExact(native, authority) ||
        !rowKeyboardReactSnapshotMatches(capture, authority, native, root) ||
        !rowNavigationIsCurrent(
          candidate,
          authority,
          published,
          source,
          destination,
          native.key,
        )
      ) {
        return;
      }
      store.publish(native.event, pair);
    });
  };

  const completePublishedRowNavigation = (
    candidate: PanelPublication,
    row: WebhookRowFacts,
    action: RowActionFacts,
    owner: ElementSlot<HTMLButtonElement>,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const pairs = candidate.rowKeyboardPairs;
    let nativeEvent: unknown;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    if (
      !nativeEvent ||
      typeof nativeEvent !== "object" ||
      !pairs ||
      !pairs.isCurrent() ||
      publicationCoordinator.rowKeyboardIsFenced()
    ) {
      return;
    }
    // The only route back to the capture pair is the exact native event, so a
    // wrong-source, crossed, replayed, or retired attempt reads nothing.
    const pending = pairs.read(nativeEvent as KeyboardEvent);
    if (
      !pending ||
      pending.publication !== candidate ||
      pending.native.event !== nativeEvent ||
      pending.capture.event === event ||
      !publicationCoordinator.prepareRowKeyboardBubble(event, nativeEvent)
    ) {
      return;
    }
    const store: RowKeyboardPairStore = pairs;
    const pair: RowKeyboardPair = pending;
    publicationCoordinator.fenceRowKeyboard(() => {
      const {
        authority,
        row: published,
        source,
        destination,
        key,
      } = pair;
      let delivery: RowKeyboardDelivery | null = null;
      try {
        const element = owner.element;
        const nativeCandidate = captureRowKeyboardEvent(
          authority,
          nativeEvent as Event,
          authority.Event.BUBBLING_PHASE,
        );
        // The action-bubble wrapper is authenticated on its own, at its actual
        // bubbling phase and action currentTarget.
        const bubbleCandidate =
          nativeCandidate && element
            ? captureRowKeyboardReactEvent(
                event as ReactKeyboardEvent<HTMLElement>,
                authority,
                nativeCandidate,
                element,
              )
            : null;
        if (
          !element ||
          !nativeCandidate ||
          !bubbleCandidate ||
          bubbleCandidate.event === pair.capture.event ||
          nativeCandidate.terminal !== pair.terminal ||
          nativeCandidate.terminal !==
            authority.terminal.proofFor(nativeCandidate.event) ||
          !rowKeyboardEventsMatch(pair.native, nativeCandidate, authority)
        ) {
          return;
        }
        const currentElement: HTMLButtonElement = element;
        const native: RowKeyboardEventSnapshot = nativeCandidate;
        const bubble: RowKeyboardReactSnapshot = bubbleCandidate;
        /**
         * One complete re-read of every authority this move depends on: store,
         * claim, publication, row order/operation/eligibility, source focus,
         * permanent DOM and placement history, destination, action identities,
         * owner-Window listener proof, wrapper identities, and the required
         * public methods. It runs again after every public invocation.
         */
        const deliveryIsCurrent = (
          expectation: RowKeyboardReactExpectation,
          claimed: boolean,
          consumed: boolean,
        ) => {
          try {
            return (
              publicationCoordinator.rowKeyboardIsFenced() &&
              candidate.rowKeyboardPairs === store &&
              store.isCurrent() &&
              store.read(native.event) === (consumed ? null : pair) &&
              (!claimed ||
                (delivery !== null &&
                  publicationCoordinator.rowKeyboardNavigationIsDelivering(
                    delivery,
                  ))) &&
              pair.publication === candidate &&
              pair.authority === authority &&
              pair.row === published &&
              pair.source === source &&
              pair.destination === destination &&
              pair.key === key &&
              pair.terminal === native.terminal &&
              pair.native.event === native.event &&
              pair.capture.nativeEvent === native.event &&
              bubble.nativeEvent === native.event &&
              published.facts === row &&
              source.facts === action &&
              source.owner === owner &&
              source.element === currentElement &&
              owner.element === currentElement &&
              event.currentTarget === currentElement &&
              pair.capture.currentTarget === published.root &&
              bubble.currentTarget === currentElement &&
              pair.capture.phase === authority.Event.CAPTURING_PHASE &&
              bubble.phase === authority.Event.BUBBLING_PHASE &&
              authority.terminal.isCurrent() &&
              native.terminal.registration === authority.terminal &&
              native.terminal.nativeEvent === native.event &&
              native.terminal.receiver === native.terminal.currentTarget &&
              native.terminal.receiver === native.terminal.terminal &&
              rowKeyboardEventsMatch(pair.native, native, authority) &&
              rowKeyboardSnapshotRemainsExact(
                native,
                authority,
                expectation.defaultPrevented,
              ) &&
              rowKeyboardReactSnapshotMatches(
                pair.capture,
                authority,
                pair.native,
                null,
              ) &&
              rowKeyboardReactSnapshotMatches(
                bubble,
                authority,
                native,
                currentElement,
                expectation,
              ) &&
              rowNavigationIsCurrent(
                candidate,
                authority,
                published,
                source,
                destination,
                key,
              )
            );
          } catch {
            return false;
          }
        };
        if (!deliveryIsCurrent(ROW_KEYBOARD_PRISTINE_EXPECTATION, false, false)) {
          return;
        }
        delivery = Object.freeze({ pair, bubble });
        if (
          !publicationCoordinator.claimRowKeyboardNavigation(delivery) ||
          !deliveryIsCurrent(ROW_KEYBOARD_PRISTINE_EXPECTATION, true, false) ||
          // Atomic: only a fully authenticated rightful bubble takes the pair,
          // and it takes it before any public effect.
          !store.consume(native.event, pair) ||
          !deliveryIsCurrent(ROW_KEYBOARD_PRISTINE_EXPECTATION, true, true)
        ) {
          return;
        }
        authority.apply(bubble.methods.preventDefault, bubble.event, []);
        if (!deliveryIsCurrent(ROW_KEYBOARD_PREVENTED_EXPECTATION, true, true)) {
          return;
        }
        authority.apply(authority.focus, destination.element, [
          { preventScroll: true },
        ]);
      } catch {
        return;
      } finally {
        if (delivery) {
          publicationCoordinator.finishRowKeyboardNavigation(delivery);
        }
      }
    });
  };

  useLayoutEffect(() => {
    return publicationCoordinator.establish(
      publication,
      () => factsAreCurrent(publication),
      (override) => domIsExact(publication, override),
      requestPublicationSuccessor,
    );
  }, [
    domIsExact,
    factsAreCurrent,
    publication,
    publicationCoordinator,
    requestPublicationSuccessor,
  ]);
  useLayoutEffect(() => {
    publicationCoordinator.reconcileReactCommit(publication);
  });
  useEffect(() => {
    publicationCoordinator.finishReactCommit(publication);
  }, [publication, publicationCoordinator]);

  return (
    <div
      ref={bindElement(publication, publication.card)}
      className="rounded-2xl border border-line bg-surface"
      id="webhooks"
      data-testid="webhooks-card"
    >
      <div
        ref={bindElement(publication, publication.header)}
        className="flex items-center gap-2 border-b border-line px-5 py-3 text-sm font-semibold text-ink"
      >
        <Webhook size={16} className="text-ink-3" /> Webhooks
        <button
          ref={bindElement(publication, publication.refresh)}
          type="button"
          className="btn btn-outline btn-sm ml-auto gap-1.5"
          onClick={(event) => {
            if (!claimPublishedClick(
              publication,
              null,
              presentation.refresh,
              event,
              publication.refresh,
            )) return;
            requestPublicationSuccessor();
            startListOperation(publication, presentation.refresh, "refresh");
          }}
          disabled={!presentation.refresh.eligible}
          aria-busy={presentation.listOperation?.intent === "refresh" || undefined}
          data-testid="webhook-refresh"
        >
          <RefreshCw
            size={14}
            className={
              presentation.listOperation?.intent === "refresh"
                ? "animate-spin"
                : undefined
            }
          />
          {presentation.listOperation?.intent === "refresh"
            ? "Refreshing webhooks"
            : "Refresh webhooks"}
        </button>
        <button
          ref={bindElement(publication, publication.add)}
          type="button"
          className="btn btn-outline btn-sm gap-1.5"
          onClick={(event) => {
           if (!claimPublishedClick(
             publication,
             null,
             presentation.add,
             event,
             publication.add,
           )) return;
           requestPublicationSuccessor();
           setAdding(!presentation.adding);
          }}
          disabled={!presentation.add.eligible}
          data-testid="webhook-add"
        >
          <Plus size={14} /> Add webhook
        </button>
      </div>
      <p
        ref={bindElement(publication, publication.guidance)}
        className="px-5 pt-3 text-sm leading-6 text-ink-3"
      >
        Push the events <code className="text-xs">markdoc_watch</code> returns to an HTTP endpoint instead of long-polling: a GitHub Actions job, a bot, a Slack bridge. Each
        delivery is a JSON <code className="text-xs">POST</code> with <code className="text-xs">X-Markdoc-Event</code>, <code className="text-xs">X-Markdoc-Delivery</code> and{" "}
        <code className="text-xs">X-Markdoc-Signature: sha256=&lt;HMAC of the body&gt;</code>; failures are retried after 10 s, 1 min and 10 min, and a hook is disabled after 20 in a row. After fixing the receiver, enable the same hook here without changing its signing secret.
      </p>

      {presentation.adding && (
        <form
          ref={bindElement(publication, publication.form)}
          className="m-5 flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4"
          data-testid="webhook-form"
          tabIndex={-1}
          aria-busy={presentation.createOperation !== null || undefined}
          onKeyDownCapture={(event) => {
            publicationCoordinator.publishKeyboardCapture(publication, event);
          }}
          onKeyDown={(event) => {
            const movement = claimPublishedCreateNavigation(
              publication,
              event,
            );
            if (movement) {
              movement.authority.apply(
                movement.authority.preventDefault,
                movement.nativeEvent,
                [],
              );
              movement.authority.apply(
                movement.authority.focus,
                movement.destination,
                [{ preventScroll: true }],
              );
              requestPublicationSuccessor();
              return;
            }
            const action = presentation.cancel;
            if (!action) {
              publicationCoordinator.discardKeyboardPair(publication);
              return;
            }
            const claim = claimPublishedEscape(publication, action, event);
            if (!claim) {
              publicationCoordinator.discardKeyboardPair(publication);
              return;
            }
            claim.authority.apply(
              claim.authority.preventDefault,
              claim.nativeEvent,
              [],
            );
            requestPublicationSuccessor();
            setAdding(false);
          }}
          onSubmit={(event) => {
            const renderedForm = publication.form.element ?? publication.form.last;
            const renderedCreateButton = publication.create.element ?? publication.create.last;
            const renderedRoot = publication.card.element ?? publication.card.last;
            const nativeEvent = isNativeReactSubmitEvent(
              event,
              renderedForm,
              renderedRoot,
            );
            const submitter = nativeEvent && "submitter" in nativeEvent
              ? nativeEvent.submitter
              : null;
            if (
              !renderedForm ||
              !renderedCreateButton ||
              !renderedRoot ||
              !nativeEvent ||
              !renderedForm.isConnected ||
              !renderedCreateButton.isConnected ||
              !renderedRoot.isConnected ||
              renderedCreateButton.form !== renderedForm ||
              (submitter !== null && submitter !== renderedCreateButton)
            ) {
              return;
            }
            event.preventDefault();
            publicationCoordinator.prepareControlClaim(publication);
            const form = publication.form.element;
            const createButton = publication.create.element;
            if (
              !presentation.create ||
              !form ||
              !createButton ||
              !ownsPanelAction(publication, presentation.create, createButton, publication.create) ||
              !publicationCoordinator.claim(
                publication,
                null,
                presentation.create,
                event,
                nativeEvent,
              )
            ) {
              return;
            }
            requestPublicationSuccessor();
            startCreate(presentation);
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
            URL
            <input
              ref={bindElement(publication, publication.url)}
              className="input"
              value={presentation.draft.url}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const input = publication.url.element;
                const next = event.currentTarget.value;
                const nativeEvent = isNativeReactInputEvent(
                  event,
                  input,
                  publication.card.element,
                );
                if (nativeEvent && input) {
                  publicationCoordinator.prepareControlClaim(publication, { input, value: next });
                }
                if (
                  !input ||
                  !nativeEvent ||
                  next !== input.value ||
                  !presentation.draft.urlInput.eligible ||
                  next === presentation.draft.url ||
                  !ownsPanel(publication, { input, value: next }, input) ||
                  !publicationCoordinator.claim(
                    publication,
                    null,
                    presentation.draft.urlInput,
                    event,
                    nativeEvent,
                  )
                ) {
                  return;
                }
                requestPublicationSuccessor();
                setUrl(next);
              }}
              placeholder="https://example.com/markdoc"
              data-testid="webhook-url"
              disabled={!presentation.draft.urlInput.eligible}
              required
            />
          </label>
          <fieldset className="flex flex-col gap-1 text-xs font-medium text-ink-3" disabled={presentation.createOperation !== null}>
            <legend className="mb-1">Events</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {presentation.draft.choiceInputs.map((choice) => (
                <label key={choice.id} className="flex min-h-6 items-center gap-1.5 font-mono text-xs text-ink-2">
                  <input
                    ref={bindElement(publication, publication.choices[choice.index]!)}
                    type="checkbox"
                    checked={choice.checked}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                      const input = publication.choices[choice.index]?.element;
                      const checked = event.currentTarget.checked;
                      const nativeEvent = isNativeReactInputEvent(
                        event,
                        input ?? null,
                        publication.card.element,
                      );
                      if (nativeEvent && input) {
                        publicationCoordinator.prepareControlClaim(publication, { input, checked });
                      }
                      if (
                        !input ||
                        !nativeEvent ||
                        checked !== input.checked ||
                        !choice.eligible ||
                        checked === choice.checked ||
                        !ownsPanel(publication, { input, checked }, input) ||
                        !publicationCoordinator.claim(
                          publication,
                          null,
                          choice,
                          event,
                          nativeEvent,
                        )
                      ) {
                        return;
                      }
                      requestPublicationSuccessor();
                      setChoices(
                        checked
                          ? [...presentation.draft.choices, choice.id]
                          : presentation.draft.choices.filter((id) => id !== choice.id),
                      );
                    }}
                    data-testid={`webhook-event-${choice.id}`}
                  />
                  {choice.label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
            Only these documents (optional: ids or links, comma or space separated)
            <input
              ref={bindElement(publication, publication.docs)}
              className="input"
              value={presentation.draft.docs}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const input = publication.docs.element;
                const next = event.currentTarget.value;
                const nativeEvent = isNativeReactInputEvent(
                  event,
                  input,
                  publication.card.element,
                );
                if (nativeEvent && input) {
                  publicationCoordinator.prepareControlClaim(publication, { input, value: next });
                }
                if (
                  !input ||
                  !nativeEvent ||
                  next !== input.value ||
                  !presentation.draft.docsInput.eligible ||
                  next === presentation.draft.docs ||
                  !ownsPanel(publication, { input, value: next }, input) ||
                  !publicationCoordinator.claim(
                    publication,
                    null,
                    presentation.draft.docsInput,
                    event,
                    nativeEvent,
                  )
                ) {
                  return;
                }
                requestPublicationSuccessor();
                setDocs(next);
              }}
              placeholder="Leave empty for every document you can see"
              data-testid="webhook-docs"
              disabled={!presentation.draft.docsInput.eligible}
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              ref={bindElement(publication, publication.create)}
              type="submit"
              className="btn btn-primary btn-sm gap-1.5"
              disabled={!presentation.create?.eligible}
              data-testid="webhook-create"
            >
              {presentation.createOperation ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add webhook
            </button>
            <button
              ref={bindElement(publication, publication.cancel)}
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={(event) => {
                if (!presentation.cancel || !claimPublishedClick(
                  publication,
                  null,
                  presentation.cancel,
                  event,
                  publication.cancel,
                )) return;
                requestPublicationSuccessor();
                setAdding(false);
              }}
              disabled={!presentation.cancel?.eligible}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {presentation.listError && (
        <div
          ref={bindElement(publication, publication.listError)}
          className="mx-5 mt-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
          data-testid="webhooks-list-error"
        >
          <span
            ref={bindElement(publication, publication.listAlert)}
            className="min-w-0 flex-1"
            role="alert"
            aria-atomic="true"
          >
            {presentation.listError}
          </span>
          <button
            ref={bindElement(publication, publication.retry)}
            type="button"
            className="btn btn-outline btn-sm shrink-0 gap-1.5"
            onClick={(event) => {
             if (!presentation.retry || !claimPublishedClick(
               publication,
               null,
               presentation.retry,
               event,
               publication.retry,
             )) return;
             requestPublicationSuccessor();
              startListOperation(publication, presentation.retry, "retry");
            }}
            disabled={!presentation.retry?.eligible}
            aria-busy={presentation.listOperation?.intent === "retry" || undefined}
          >
            {presentation.listOperation?.intent === "retry" && <Loader2 size={14} className="animate-spin" />}
            {presentation.listOperation?.intent === "retry" ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {presentation.actionError && (
        <div
          ref={bindElement(publication, publication.actionError)}
          className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
          role="alert"
          aria-atomic="true"
          data-testid="webhook-action-error"
        >
          {presentation.actionError}
        </div>
      )}

      {presentation.created && (
        <div
          ref={bindElement(publication, publication.created)}
          className="m-5 rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/40"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="webhook-created"
        >
          <div className="mb-2 text-sm font-medium text-green-900 dark:text-green-200">Webhook added. Copy the signing secret now; it will not be shown again.</div>
          <div className="flex items-center gap-2">
            <code
              ref={bindElement(publication, publication.secret, (element) => {
                if (element) secretTarget.current = element;
              })}
              className="min-w-0 flex-1 select-text break-all rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[13px] text-ink"
              data-testid="webhook-secret"
            >
              {presentation.created.secret}
            </code>
            <button
              ref={bindElement(publication, publication.copy)}
              type="button"
              className="btn btn-outline btn-sm shrink-0 gap-1.5"
              onClick={(event) => {
                if (!presentation.copy || !claimPublishedClick(
                  publication,
                  presentation.created,
                  presentation.copy,
                  event,
                  publication.copy,
                )) return;
                requestPublicationSuccessor();
                copySecret();
              }}
              aria-label="Copy secret"
            >
              {presentation.copied
                ? <Check size={14} className="text-success" />
                : <Copy size={14} />}
              {presentation.copyLabel}
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-3">
            Verify each delivery with <code>HMAC-SHA256(secret, raw body)</code> against <code>X-Markdoc-Signature</code>. Press <em>Send test</em> below to see a delivery land.
          </p>
        </div>
      )}

      {presentation.list.kind === "loading" ? (
        <div
          ref={bindElement(publication, publication.listContent)}
          className="px-5 py-6 text-sm text-ink-3"
        >
          Loading…
        </div>
      ) : presentation.list.kind === "unavailable" ? null : presentation.list.kind === "empty" ? (
        <div
          ref={bindElement(publication, publication.listContent)}
          className="px-5 py-6 text-sm text-ink-3"
          data-testid="webhooks-empty"
        >
          No webhooks yet.
        </div>
      ) : (
        <ul
          ref={bindElement(publication, publication.listContent, (element) => {
            publicationCoordinator.bind(publication, publication.rowsList, element);
          })}
          className="mt-3 divide-y divide-line border-t border-line"
        >
          {presentation.list.rows!.map((row) => {
            const rowElements = publication.rows[row.index]!;
            return (
              <li
                key={row.id}
                ref={bindElement(publication, rowElements.root)}
                className="flex items-center gap-4 px-5 py-3"
                data-testid="webhook-row"
                onKeyDownCapture={(event) => {
                  capturePublishedRowNavigation(publication, row, event);
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm text-ink">{row.url}</div>
                  <div className="truncate text-xs text-ink-3">{row.details}</div>
                </div>
                <div
                  className={`shrink-0 text-xs ${row.statusTone === "ok" ? "text-success" : row.statusTone === "bad" ? "text-danger" : "text-ink-3"}`}
                  data-testid="webhook-status"
                >
                  {row.statusText}
                </div>
                {row.enable && (
                  <button
                    ref={bindElement(publication, rowElements.enable)}
                    type="button"
                    className="btn btn-outline btn-sm gap-1.5"
                    onClick={(event) => {
                     if (!row.enable || !claimPublishedClick(
                       publication,
                       row,
                       row.enable,
                       event,
                       rowElements.enable,
                     )) return;
                     requestPublicationSuccessor();
                      startEnable(row);
                    }}
                    onKeyDown={(event) => {
                     if (!row.enable) return;
                     completePublishedRowNavigation(
                       publication,
                       row,
                       row.enable,
                       rowElements.enable,
                       event,
                     );
                    }}
                    disabled={!row.enable.eligible}
                    data-testid="webhook-enable"
                  >
                    {row.operation?.kind === "enable" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />} Enable
                  </button>
                )}
                <button
                  ref={bindElement(publication, rowElements.test)}
                  type="button"
                  className="btn btn-outline btn-sm gap-1.5"
                  onClick={(event) => {
                   if (!claimPublishedClick(
                     publication,
                     row,
                     row.test,
                     event,
                     rowElements.test,
                   )) return;
                   requestPublicationSuccessor();
                   startTest(row);
                  }}
                  onKeyDown={(event) => {
                   completePublishedRowNavigation(
                     publication,
                     row,
                     row.test,
                     rowElements.test,
                     event,
                   );
                  }}
                  disabled={!row.test.eligible}
                  data-testid="webhook-test"
                >
                  {row.operation?.kind === "test" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send test
                </button>
                <button
                  ref={bindElement(publication, rowElements.delete)}
                  type="button"
                  className="icon-btn h-8 w-8 text-ink-3 hover:text-danger"
                  onClick={(event) => {
                   if (!claimPublishedClick(
                     publication,
                     row,
                     row.delete,
                     event,
                     rowElements.delete,
                   )) return;
                   requestPublicationSuccessor();
                   if (!confirm(`Delete the webhook to ${row.url}?`)) return;
                   startDelete(row);
                  }}
                  onKeyDown={(event) => {
                   completePublishedRowNavigation(
                     publication,
                     row,
                     row.delete,
                     rowElements.delete,
                     event,
                   );
                  }}
                  disabled={!row.delete.eligible}
                  aria-label={`Delete webhook ${row.url}`}
                  data-testid="webhook-delete"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
