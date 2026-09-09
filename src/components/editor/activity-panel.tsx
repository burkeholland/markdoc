"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Activity as ActivityIcon,
  Bot,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { api, apiErrorText, type ActivityItemDto } from "@/lib/api";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import { Avatar, EmptyState, Spinner } from "@/components/ui/primitives";

export interface ActivityPanelProps {
  session: CollabSession;
  onClose: () => void;
}

const REFRESH_MS = 30_000;
const PAGE = 50;

type ActivityVisit = {
  readonly session: CollabSession;
  readonly documentId: string;
  readonly onClose: () => void;
  readonly predecessor: ActivityVisit | null;
};

type CadenceOperation = {
  readonly visit: ActivityVisit;
  readonly timer: ReturnType<typeof setInterval>;
};

type RefreshOperation = {
  readonly visit: ActivityVisit;
  readonly id: number;
};

type LoadMoreOperation = RefreshOperation & {
  cursor: string;
};

type ActivityItemFacts = Readonly<{
  id: string;
  actorId: string | null;
  actorName: string;
  actorKind: "user" | "agent";
  action: ActivityItemDto["action"];
  detail: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;

type ActivityGroupFacts = Readonly<{
  day: string;
  rows: readonly Readonly<{ index: number; item: ActivityItemFacts }>[];
}>;

type ActivityContentMode = "loading" | "empty" | "list" | "none";
type ActivityClickActionKind = "close" | "refresh" | "retry" | "load-more";
type ActivityHeaderControlKind = "refresh" | "close";
type ActivityActionKind =
  | ActivityClickActionKind
  | "navigate-refresh"
  | "navigate-close";
type ActivityHeaderNavigationKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";

interface ActivitySourceFacts {
  readonly stateVisit: ActivityVisit;
  readonly items: ActivityItemDto[] | null;
  readonly nextBefore: string | null;
  readonly error: string | null;
  readonly listError: string | null;
  readonly retrying: boolean;
  readonly loadingMore: boolean;
  readonly now: number;
  readonly cadence: CadenceOperation | null;
  readonly refresh: RefreshOperation | null;
  readonly loadMore: LoadMoreOperation | null;
}

interface ActivityPresentation {
  readonly mount: symbol;
  readonly visit: ActivityVisit;
  readonly session: CollabSession;
  readonly documentId: string;
  readonly onClose: () => void;
  readonly source: ActivitySourceFacts;
  readonly items: readonly ActivityItemFacts[] | null;
  readonly nextBefore: string | null;
  readonly error: string | null;
  readonly listError: string | null;
  readonly refreshAvailable: boolean;
  readonly refreshing: boolean;
  readonly retrying: boolean;
  readonly loadingMore: boolean;
  readonly now: number;
  readonly groups: readonly ActivityGroupFacts[];
  readonly contentMode: ActivityContentMode;
}

interface ActivityHeaderControl {
  readonly kind: ActivityHeaderControlKind;
  readonly index: number;
  readonly element: HTMLButtonElement;
}

interface ActivityCapturedIntrinsic {
  readonly isCurrent: () => boolean;
}

interface ActivityCapturedGetter<Value> extends ActivityCapturedIntrinsic {
  readonly read: (target: object) => Value;
}

interface ActivityCapturedValue<Value> extends ActivityCapturedIntrinsic {
  readonly read: () => Value;
}

interface ActivityCapturedMethod<Args extends readonly unknown[], Result>
  extends ActivityCapturedIntrinsic {
  readonly invoke: (target: object, ...args: Args) => Result;
}

interface ActivityTrustedGetter extends ActivityCapturedIntrinsic {
  readonly read: (event: object) => boolean;
  readonly matches: (event: object) => boolean;
}

/**
 * Owner-realm event and focus intrinsics captured when the header is published. `isCurrent`
 * retains its history: one replaced descriptor retires this authority for good, so restoring
 * the descriptor cannot revive it — only a fresh publication captures a clean authority.
 */
interface ActivityKeyboardAuthority {
  readonly ownerWindow: Window & typeof globalThis;
  readonly Event: typeof globalThis.Event;
  readonly KeyboardEvent: typeof globalThis.KeyboardEvent;
  readonly Node: typeof globalThis.Node;
  readonly apply: typeof Reflect.apply;
  readonly eventType: ActivityCapturedGetter<string>;
  readonly eventTarget: ActivityCapturedGetter<EventTarget | null>;
  readonly eventCurrentTarget: ActivityCapturedGetter<EventTarget | null>;
  readonly eventPhase: ActivityCapturedGetter<number>;
  readonly eventBubbles: ActivityCapturedGetter<boolean>;
  readonly eventCancelable: ActivityCapturedGetter<boolean>;
  readonly eventDefaultPrevented: ActivityCapturedGetter<boolean>;
  readonly eventCancelBubble: ActivityCapturedGetter<boolean>;
  readonly eventPath: ActivityCapturedMethod<readonly [], EventTarget[]>;
  readonly eventPreventDefault: ActivityCapturedMethod<readonly [], void>;
  readonly eventView: ActivityCapturedGetter<Window | null>;
  readonly key: ActivityCapturedGetter<string>;
  readonly code: ActivityCapturedGetter<string>;
  readonly repeat: ActivityCapturedGetter<boolean>;
  readonly composing: ActivityCapturedGetter<boolean>;
  readonly altKey: ActivityCapturedGetter<boolean>;
  readonly ctrlKey: ActivityCapturedGetter<boolean>;
  readonly metaKey: ActivityCapturedGetter<boolean>;
  readonly shiftKey: ActivityCapturedGetter<boolean>;
  readonly activeElement: ActivityCapturedGetter<Element | null>;
  readonly documentView: ActivityCapturedValue<Window | null>;
  readonly focus: ActivityCapturedMethod<readonly [FocusOptions?], void>;
  readonly listen: ActivityCapturedMethod<
    readonly [string, EventListener, boolean],
    void
  >;
  readonly unlisten: ActivityCapturedMethod<
    readonly [string, EventListener, boolean],
    void
  >;
  readonly trusted: ActivityTrustedGetter;
  readonly reactMethodMatches: (
    event: object,
    property: PropertyKey,
    value: unknown,
  ) => boolean;
  readonly isCurrent: () => boolean;
}

type ActivityHeaderKeyPhase = "capture" | "bubble";

interface ActivityReactKeyMethods {
  readonly preventDefault: (...args: never[]) => unknown;
  readonly stopPropagation: (...args: never[]) => unknown;
  readonly isDefaultPrevented: (...args: never[]) => unknown;
  readonly isPropagationStopped: (...args: never[]) => unknown;
  readonly persist: (...args: never[]) => unknown;
}

interface ActivityHeaderKeyFacts {
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly key: ActivityHeaderNavigationKey;
  readonly delegationTarget: Node;
  readonly methods: ActivityReactKeyMethods;
}

/**
 * The live native keydown as the publication's own owner-realm capture listener first saw it,
 * before any other listener could reach it.
 */
interface ActivityNativeKeySnapshot {
  readonly event: globalThis.KeyboardEvent;
  readonly publication: ActivityPublication;
  readonly control: ActivityHeaderControl;
  readonly key: ActivityHeaderNavigationKey;
  readonly code: string;
  readonly target: EventTarget | null;
  readonly path: readonly EventTarget[];
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly view: Window | null;
  readonly receiver: EventTarget;
}

/**
 * Provenance ledger for one native keydown. Only React's own capture and bubble deliveries at the
 * delegation root can fill it, and the panel crossing has to separate them; anything else — a
 * fabricated wrapper handed to a control handler by an earlier native listener, a replay, a crossed
 * control, a partially staged pair — poisons the ledger so the whole dispatch does no work.
 */
interface ActivityNativeKeyDelivery {
  readonly snapshot: ActivityNativeKeySnapshot;
  delegationTarget: Node | null;
  crossedPanel: boolean;
  captureInvalid: boolean;
  captureRootCount: number;
  captureRootEvent: ReactKeyboardEvent<HTMLElement> | null;
  reactMethods: ActivityReactKeyMethods | null;
  captureCount: number;
  captureEvent: ReactKeyboardEvent<HTMLButtonElement> | null;
  bubbleInvalid: boolean;
  bubbleCount: number;
  bubbleEvent: ReactKeyboardEvent<HTMLButtonElement> | null;
  bubbleRootCount: number;
  bubbleRootEvent: ReactKeyboardEvent<HTMLElement> | null;
}

interface ActivityPublication {
  readonly identity: symbol;
  readonly presentation: ActivityPresentation;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly panel: HTMLElement;
  readonly header: HTMLDivElement;
  readonly headerControls: readonly ActivityHeaderControl[];
  readonly keyboard: ActivityKeyboardAuthority | null;
  readonly dom: ActivityDomSnapshot;
  readonly placement: ActivityPlacement;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
}

interface ActivityPublicationSet {
  readonly establish: () => (() => void) | undefined;
  readonly capturePanel: (element: HTMLElement | null) => void;
  readonly captureHeader: (element: HTMLDivElement | null) => void;
  readonly captureRefresh: (element: HTMLButtonElement | null) => void;
  readonly captureClose: (element: HTMLButtonElement | null) => void;
  readonly captureScroll: (element: HTMLDivElement | null) => void;
  readonly captureContent: (element: HTMLDivElement | null) => void;
  readonly captureListError: (element: HTMLDivElement | null) => void;
  readonly captureRetry: (element: HTMLButtonElement | null) => void;
  readonly capturePageError: (element: HTMLDivElement | null) => void;
  readonly captureGroup: (index: number) => (element: HTMLDivElement | null) => void;
  readonly captureRow: (index: number) => (element: HTMLLIElement | null) => void;
  readonly captureLoadMore: (element: HTMLButtonElement | null) => void;
  readonly manualRefresh: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly close: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly retry: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly loadMore: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly navigateFromRefresh: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly navigateFromClose: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly navigateCaptureFromRefresh: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly navigateCaptureFromClose: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly navigateCaptureFromHeader: (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  readonly navigateFromHeader: (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
}

interface ActivityPublicationRuntime {
  readonly publication: ActivityPublication;
  readonly publish: () => boolean;
  readonly stageHeaderKey: (
    kind: ActivityHeaderControlKind,
    phase: ActivityHeaderKeyPhase,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly stageHeaderRootKey: (
    phase: ActivityHeaderKeyPhase,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: ActivityElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replay: () => ActivityPublicationReplay | null;
}

interface ActivityDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly ActivityDomSnapshot[];
}

interface ActivityPlacement {
  readonly document: Document;
  readonly chain: readonly ActivityNodePlacement[];
}

interface ActivityNodePlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
  readonly exactSiblings: boolean;
}

interface ActivityDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface ActivityElementOwnerView {
  readonly element: () => HTMLElement | null;
}

interface ActivityRefReplay {
  readonly owner: ActivityElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface ActivityPublicationReplay {
  readonly source: ActivityPublication;
  readonly dom: ActivityDomSnapshot;
  readonly placement: ActivityPlacement;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface ActivityAction {
  readonly identity: symbol;
  readonly kind: ActivityActionKind;
}

class ActivityPublicationCoordinator {
  readonly #mount: symbol;
  #active: ActivityPublication | null = null;
  #successorOf: ActivityPublication | null = null;
  #replay: ActivityPublicationReplay | null = null;
  #retired = new WeakSet<ActivityPublication>();
  #claimedVisits = new WeakMap<ActivityVisit, ActivityPublication>();
  #claimedPublications = new WeakSet<ActivityPublication>();
  #claimedActions = new WeakSet<ActivityAction>();
  #claimedEvents = new WeakSet<object>();
  #claimedControls = new WeakMap<ActivityPublication, Set<HTMLElement>>();

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  active() {
    return this.#active;
  }

  replay() {
    return this.#replay;
  }

  publish(publication: ActivityPublication) {
    if (
      publication.presentation.mount !== this.#mount ||
      this.#retired.has(publication)
    ) {
      return false;
    }
    const previous = this.#active;
    if (previous && previous !== publication) previous.retire();
    this.#active = publication;
    this.#successorOf = null;
    this.#replay = null;
    this.#claimedVisits.delete(publication.presentation.visit);
    return true;
  }

  retire(publication: ActivityPublication) {
    if (this.#retired.has(publication)) return false;
    this.#retired.add(publication);
    if (this.#active === publication) {
      this.#active = null;
      this.#successorOf = publication;
    }
    return true;
  }

  acceptsSuccessorOf(publication: ActivityPublication) {
    return (
      this.#active === null &&
      this.#successorOf === publication &&
      this.#retired.has(publication) &&
      !this.#claimedPublications.has(publication)
    );
  }

  stageReplay(replay: ActivityPublicationReplay) {
    if (!this.acceptsSuccessorOf(replay.source)) return false;
    this.#replay = replay;
    return true;
  }

  abandonReplay(publication: ActivityPublication) {
    if (this.#replay?.source === publication) this.#replay = null;
    if (this.#successorOf === publication) this.#successorOf = null;
  }

  isCurrent(publication: ActivityPublication) {
    return this.#active === publication && !this.#retired.has(publication);
  }

  hasClaimed(
    visit: ActivityVisit,
    publication: ActivityPublication,
    action: ActivityAction,
    events: readonly object[],
    nativeEvent: Event,
    controls: readonly HTMLElement[] = [],
  ) {
    const claimedControls = this.#claimedControls.get(publication);
    return (
      this.#claimedVisits.get(visit) === publication ||
      this.#claimedPublications.has(publication) ||
      this.#claimedActions.has(action) ||
      events.some((event) => this.#claimedEvents.has(event)) ||
      this.#claimedEvents.has(nativeEvent) ||
      (claimedControls !== undefined &&
        controls.some((control) => claimedControls.has(control)))
    );
  }

  claim(
    visit: ActivityVisit,
    publication: ActivityPublication,
    action: ActivityAction,
    events: readonly object[],
    nativeEvent: Event,
    controls: readonly HTMLElement[] = [],
  ) {
    if (
      !this.isCurrent(publication) ||
      this.hasClaimed(visit, publication, action, events, nativeEvent, controls)
    ) {
      return false;
    }
    this.#claimedVisits.set(visit, publication);
    this.#claimedPublications.add(publication);
    this.#claimedActions.add(action);
    for (const event of events) this.#claimedEvents.add(event);
    this.#claimedEvents.add(nativeEvent);
    const claimedControls =
      this.#claimedControls.get(publication) ?? new Set<HTMLElement>();
    for (const control of controls) claimedControls.add(control);
    this.#claimedControls.set(publication, claimedControls);
    return true;
  }
}

class ActivityCurrent {
  #activeVisit: ActivityVisit | null = null;
  #hasActivatedVisit = false;
  #retiredVisits = new WeakSet<ActivityVisit>();
  #startedVisits = new WeakSet<ActivityVisit>();
  #cadenceOperations = new Map<ActivityVisit, CadenceOperation>();
  #refreshOperations = new Map<ActivityVisit, RefreshOperation>();
  #loadMoreOperations = new Map<ActivityVisit, LoadMoreOperation>();
  #cursors = new Map<ActivityVisit, string | null>();
  #expandedVisits = new WeakSet<ActivityVisit>();
  #refreshSequence = 0;
  #loadMoreSequence = 0;

  activateVisit(visit: ActivityVisit) {
    if (this.#retiredVisits.has(visit) || this.#activeVisit !== null) return null;
    const activation = this.#hasActivatedVisit ? "replacement" : "initial";
    this.#hasActivatedVisit = true;
    this.#activeVisit = visit;
    this.#cursors.set(visit, null);
    this.#expandedVisits.delete(visit);
    return activation;
  }

  retireVisit(visit: ActivityVisit) {
    if (this.#retiredVisits.has(visit)) return null;
    this.#retiredVisits.add(visit);
    if (this.#activeVisit === visit) this.#activeVisit = null;
    const cadence = this.#cadenceOperations.get(visit) ?? null;
    this.#cadenceOperations.delete(visit);
    this.#refreshOperations.delete(visit);
    this.#loadMoreOperations.delete(visit);
    this.#cursors.delete(visit);
    this.#expandedVisits.delete(visit);
    return cadence;
  }

  ownsVisit(visit: ActivityVisit) {
    return !this.#retiredVisits.has(visit) && this.#activeVisit === visit;
  }

  isRetired(visit: ActivityVisit) {
    return this.#retiredVisits.has(visit);
  }

  startVisit(visit: ActivityVisit) {
    if (!this.ownsVisit(visit) || this.#startedVisits.has(visit)) return false;
    this.#startedVisits.add(visit);
    return true;
  }

  publishCadence(visit: ActivityVisit, operation: CadenceOperation) {
    this.#cadenceOperations.set(visit, operation);
  }

  cadence(visit: ActivityVisit) {
    return this.#cadenceOperations.get(visit) ?? null;
  }

  hasRefresh(visit: ActivityVisit) {
    return this.#refreshOperations.has(visit);
  }

  refresh(visit: ActivityVisit) {
    return this.#refreshOperations.get(visit) ?? null;
  }

  publishRefresh(operation: RefreshOperation) {
    this.#refreshOperations.set(operation.visit, operation);
  }

  ownsRefresh(operation: RefreshOperation) {
    return this.ownsVisit(operation.visit) &&
      this.#refreshOperations.get(operation.visit) === operation;
  }

  retireRefresh(operation: RefreshOperation) {
    if (!this.ownsRefresh(operation)) return false;
    this.#refreshOperations.delete(operation.visit);
    return true;
  }

  hasLoadMore(visit: ActivityVisit) {
    return this.#loadMoreOperations.has(visit);
  }

  loadMore(visit: ActivityVisit) {
    return this.#loadMoreOperations.get(visit) ?? null;
  }

  publishLoadMore(operation: LoadMoreOperation) {
    this.#loadMoreOperations.set(operation.visit, operation);
  }

  ownsLoadMoreRequest(operation: LoadMoreOperation) {
    return this.ownsVisit(operation.visit) &&
      this.#loadMoreOperations.get(operation.visit) === operation;
  }

  ownsLoadMoreSettlement(operation: LoadMoreOperation) {
    return this.ownsLoadMoreRequest(operation) &&
      this.#cursors.get(operation.visit) === operation.cursor;
  }

  retireLoadMore(operation: LoadMoreOperation) {
    if (!this.ownsLoadMoreRequest(operation)) return false;
    this.#loadMoreOperations.delete(operation.visit);
    return true;
  }

  retireLoadMoreForCursor(visit: ActivityVisit, cursor: string | null) {
    const operation = this.#loadMoreOperations.get(visit);
    if (!operation || operation.cursor === cursor) return false;
    this.#loadMoreOperations.delete(visit);
    return true;
  }

  cursor(visit: ActivityVisit) {
    return this.#cursors.get(visit);
  }

  publishCursor(visit: ActivityVisit, cursor: string | null) {
    this.#cursors.set(visit, cursor);
  }

  isExpanded(visit: ActivityVisit) {
    return this.#expandedVisits.has(visit);
  }

  markExpanded(visit: ActivityVisit) {
    this.#expandedVisits.add(visit);
  }

  nextRefreshId() {
    return ++this.#refreshSequence;
  }

  nextLoadMoreId() {
    return ++this.#loadMoreSequence;
  }
}

class ActivityElementOwner<T extends HTMLElement> implements ActivityElementOwnerView {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: ActivityElementOwnerView,
      element: T | null,
      previous: T | null,
      last: T | null,
    ) => void,
  ) {}

  readonly element = () => this.#current;

  readonly capture = (element: T | null) => {
    if (this.#current === element) return;
    const previous = this.#current;
    const last = this.#last;
    this.#current = element;
    if (element) this.#last = element;
    this.onChange(this, element, previous, last);
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One human sentence per row, without the actor (rendered separately). */
export function describeActivity(item: Readonly<ActivityItemDto> | ActivityItemFacts): string {
  const d = item.detail ?? {};
  switch (item.action) {
    case "edit": {
      const chars = num(d.chars);
      return chars && chars > 0 ? `edited the document (~${chars.toLocaleString("en-US")} characters)` : "edited the document";
    }
    case "comment.add": {
      const quote = str(d.quote);
      return quote ? `commented: “${quote}”` : "commented";
    }
    case "comment.reply": {
      const quote = str(d.quote);
      return quote ? `replied: “${quote}”` : "replied to a comment";
    }
    case "comment.resolve": {
      const quote = str(d.quote);
      return quote ? `resolved a comment: “${quote}”` : "resolved a comment";
    }
    case "suggestion.add": {
      const n = num(d.count) ?? 1;
      return `suggested ${plural(n, "change")}`;
    }
    case "suggestion.accept": {
      const n = num(d.count) ?? 1;
      return `accepted ${plural(n, "suggestion")}`;
    }
    case "suggestion.reject": {
      const n = num(d.count) ?? 1;
      return `rejected ${plural(n, "suggestion")}`;
    }
    case "version.save": {
      const n = num(d.number);
      const title = str(d.title);
      return `saved version${n ? ` ${n}` : ""}${title ? ` ‘${title}’` : ""}`;
    }
    case "version.restore": {
      const n = num(d.number);
      const title = str(d.title);
      return `restored version${n ? ` ${n}` : ""}${title ? ` ‘${title}’` : ""}`;
    }
    case "publish": {
      const storage = str(d.storage);
      return storage === "gist" ? "published to the gist" : storage === "repo" ? "committed to GitHub" : "published";
    }
    case "share.add": {
      const login = str(d.login);
      const role = str(d.role);
      return `shared with ${login ? `@${login}` : "someone"}${role ? ` as ${role}` : ""}`;
    }
    case "share.remove": {
      const login = str(d.login);
      return `removed ${login ? `@${login}` : "a collaborator"}`;
    }
    case "asset.upload": {
      const name = str(d.name);
      return name ? `uploaded ${name}` : "uploaded an image";
    }
    case "title.change": {
      const title = str(d.title);
      return title ? `renamed the document to “${title}”` : "renamed the document";
    }
    case "agent.request": {
      const instruction = str(d.instruction);
      return instruction ? `asked an agent: “${instruction}”` : "asked an agent for help";
    }
    case "agent.request.done": {
      const parts: string[] = [];
      const s = num(d.suggestions);
      const c = num(d.comments);
      if (s) parts.push(plural(s, "suggestion"));
      if (c) parts.push(plural(c, "comment"));
      const summary = str(d.summary);
      return `finished a request${parts.length ? ` (${parts.join(", ")})` : ""}${summary ? `: “${summary}”` : ""}`;
    }
    default:
      return String(item.action);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeActivityValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeActivityValue));
  }
  if (!isPlainRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = freezeActivityValue(entry);
  }
  return Object.freeze(result);
}

function activityValuesMatch(source: unknown, frozen: unknown): boolean {
  if (Object.is(source, frozen)) return true;
  if (Array.isArray(source) && Array.isArray(frozen)) {
    return source.length === frozen.length && source.every((value, index) =>
      activityValuesMatch(value, frozen[index]));
  }
  if (!isPlainRecord(source) || !isPlainRecord(frozen)) return false;
  const sourceKeys = Object.keys(source);
  const frozenKeys = Object.keys(frozen);
  return sourceKeys.length === frozenKeys.length && sourceKeys.every((key, index) =>
    key === frozenKeys[index] && activityValuesMatch(source[key], frozen[key]));
}

function freezeActivityItem(item: ActivityItemDto): ActivityItemFacts {
  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item.detail)) {
    detail[key] = freezeActivityValue(value);
  }
  return Object.freeze({
    id: item.id,
    actorId: item.actorId,
    actorName: item.actorName,
    actorKind: item.actorKind,
    action: item.action,
    detail: Object.freeze(detail),
    createdAt: item.createdAt,
  });
}

function activityItemsMatch(
  source: ActivityItemDto[] | null,
  frozen: readonly ActivityItemFacts[] | null,
): boolean {
  if (!source || !frozen) return source === frozen;
  return source.length === frozen.length && source.every((item, index) => {
    const expected = frozen[index];
    return Boolean(
      expected &&
      item.id === expected.id &&
      item.actorId === expected.actorId &&
      item.actorName === expected.actorName &&
      item.actorKind === expected.actorKind &&
      item.action === expected.action &&
      item.createdAt === expected.createdAt &&
      activityValuesMatch(item.detail, expected.detail)
    );
  });
}

function groupByDay(items: readonly ActivityItemFacts[]): readonly ActivityGroupFacts[] {
  const groups: { day: string; rows: Readonly<{ index: number; item: ActivityItemFacts }>[] }[] = [];
  for (const [index, item] of items.entries()) {
    const key = new Date(item.createdAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    const last = groups[groups.length - 1];
    const row = Object.freeze({ index, item });
    if (last && last.day === key) last.rows.push(row);
    else groups.push({ day: key, rows: [row] });
  }
  return Object.freeze(groups.map((group) => Object.freeze({
    day: group.day,
    rows: Object.freeze(group.rows),
  })));
}

function activityContentMode(
  items: readonly ActivityItemFacts[] | null,
  listError: string | null,
): ActivityContentMode {
  if (items === null) return listError ? "none" : "loading";
  return items.length === 0 ? "empty" : "list";
}

function createActivityPresentation(
  mount: symbol,
  visit: ActivityVisit,
  source: ActivitySourceFacts,
): ActivityPresentation {
  const items = source.items
    ? Object.freeze(source.items.map(freezeActivityItem))
    : null;
  return Object.freeze({
    mount,
    visit,
    session: visit.session,
    documentId: visit.documentId,
    onClose: visit.onClose,
    source: Object.freeze(source),
    items,
    nextBefore: source.nextBefore,
    error: source.error,
    listError: source.listError,
    refreshAvailable: items !== null || source.listError !== null,
    refreshing: source.refresh !== null,
    retrying: source.retrying,
    loadingMore: source.loadingMore,
    now: source.now,
    groups: groupByDay(items ?? []),
    contentMode: activityContentMode(items, source.listError),
  });
}

function isNodeFromDocument(value: EventTarget | null, document: Document): value is Node {
  const NodeConstructor = document.defaultView?.Node;
  return Boolean(NodeConstructor && value instanceof NodeConstructor);
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  return Object.freeze(
    [...element.attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotActivityDom(node: Node): ActivityDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotActivityDom)),
  });
}

function activityDomMatches(snapshot: ActivityDomSnapshot): boolean {
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
      node.childNodes.item(index) === child.node && activityDomMatches(child));
}

function captureActivityPlacement(node: HTMLElement): ActivityPlacement | null {
  if (!node.isConnected) return null;
  const document = node.ownerDocument;
  const chain: ActivityNodePlacement[] = [];
  let current: Node = node;
  while (current !== document) {
    const parent = current.parentNode;
    if (!parent) return null;
    chain.push(Object.freeze({
      node: current,
      parent,
      previousSibling: current.previousSibling,
      nextSibling: current.nextSibling,
      exactSiblings: current === node,
    }));
    current = parent;
  }
  const root = chain[0];
  if (!root) return null;
  return Object.freeze({
    document,
    chain: Object.freeze(chain),
  });
}

function activityPlacementMatches(node: HTMLElement, placement: ActivityPlacement) {
  return (
    node.ownerDocument === placement.document &&
    node.isConnected &&
    placement.chain[0]?.node === node &&
    placement.chain.every(
      (entry) =>
        entry.node.parentNode === entry.parent &&
        (!entry.exactSiblings ||
          (entry.node.previousSibling === entry.previousSibling &&
            entry.node.nextSibling === entry.nextSibling)),
    )
  );
}

function activityPlacementRecordChanged(
  record: MutationRecord,
  placement: ActivityNodePlacement,
) {
  if (record.type !== "childList" || record.target !== placement.parent) {
    return false;
  }
  if (
    placement.exactSiblings &&
    (record.previousSibling === placement.node ||
      record.nextSibling === placement.node)
  ) {
    return true;
  }
  return [...record.addedNodes, ...record.removedNodes].some(
    (node) => node === placement.node || node.contains(placement.node),
  );
}

function createActivityDomGuard(
  root: HTMLElement,
  placement: ActivityPlacement,
): ActivityDomGuard | null {
  const MutationObserverConstructor =
    placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((record) => {
       if (record.target === root || root.contains(record.target)) return true;
       return placement.chain.some((entry) =>
         activityPlacementRecordChanged(record, entry),
       );
    });
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(root, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  for (const entry of placement.chain) {
    observer.observe(entry.parent, { childList: true });
  }
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

function frozenActivityItemsMatch(
  left: readonly ActivityItemFacts[] | null,
  right: readonly ActivityItemFacts[] | null,
) {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((item, index) => {
    const candidate = right[index];
    return Boolean(
       candidate &&
       item.id === candidate.id &&
       item.actorId === candidate.actorId &&
       item.actorName === candidate.actorName &&
       item.actorKind === candidate.actorKind &&
       item.action === candidate.action &&
       item.createdAt === candidate.createdAt &&
       activityValuesMatch(item.detail, candidate.detail)
    );
  });
}

function activityReplayFactsMatch(
  source: ActivityPresentation,
  successor: ActivityPresentation,
) {
  const sameVisit = successor.visit === source.visit;
  return (
    source.mount === successor.mount &&
    (sameVisit || successor.visit.predecessor === source.visit) &&
    source.session === successor.session &&
    source.documentId === successor.documentId &&
    source.onClose === successor.onClose &&
    source.nextBefore === successor.nextBefore &&
    source.error === successor.error &&
    source.listError === successor.listError &&
    source.refreshAvailable === successor.refreshAvailable &&
    source.refreshing === successor.refreshing &&
    source.retrying === successor.retrying &&
    source.loadingMore === successor.loadingMore &&
    source.contentMode === successor.contentMode &&
    source.source.stateVisit === source.visit &&
    successor.source.stateVisit === successor.visit &&
    (sameVisit
      ? source.source.cadence === successor.source.cadence &&
        source.source.refresh === successor.source.refresh &&
        source.source.loadMore === successor.source.loadMore
      : successor.source.cadence === null &&
        successor.source.refresh === null &&
        successor.source.loadMore === null) &&
    frozenActivityItemsMatch(source.items, successor.items)
  );
}

function replayAllowsActivityPublication(
  coordinator: ActivityPublicationCoordinator,
  presentation: ActivityPresentation,
  panel: HTMLElement,
) {
  const replay = coordinator.replay();
  if (!replay) return true;
  const exactReplay =
    activityReplayFactsMatch(replay.source.presentation, presentation) &&
    coordinator.acceptsSuccessorOf(replay.source) &&
    replay.historyIsClean() &&
    panel === replay.dom.node &&
    activityPlacementMatches(panel, replay.placement) &&
    activityDomMatches(replay.dom);
  coordinator.abandonReplay(replay.source);
  replay.release();
  return exactReplay;
}

function activityDescriptorMatches(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  if (
    !current ||
    current.configurable !== expected.configurable ||
    current.enumerable !== expected.enumerable
  ) {
    return false;
  }
  return "value" in expected
    ? current.value === expected.value && current.writable === expected.writable
    : current.get === expected.get && current.set === expected.set;
}

function captureActivityGetter<Value>(
  ownerWindow: Window & typeof globalThis,
  prototype: object,
  property: string,
): ActivityCapturedGetter<Value> | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  let owner: object | null = prototype;
  while (owner) {
    const holder = owner;
    const descriptor = getOwnPropertyDescriptor(holder, property);
    if (descriptor) {
      if (typeof descriptor.get !== "function") return null;
      const expected = Object.freeze({ ...descriptor });
      const getter = descriptor.get;
      return Object.freeze({
        read: (target: object) => apply(getter, target, []) as Value,
        isCurrent: () =>
          ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
          ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
          ownerWindow.Reflect.apply === apply &&
          activityDescriptorMatches(
            getOwnPropertyDescriptor(holder, property),
            expected,
          ),
      });
    }
    owner = getPrototypeOf(holder) as object | null;
  }
  return null;
}

function captureActivityValue<Value>(
  ownerWindow: Window & typeof globalThis,
  target: object,
  property: string,
): ActivityCapturedValue<Value> | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const emptyOwners: object[] = [];
  let owner: object | null = target;
  while (owner) {
    const descriptor = getOwnPropertyDescriptor(owner, property);
    if (descriptor) {
      if (!("value" in descriptor) && typeof descriptor.get !== "function") {
        return null;
      }
      const holder = owner;
      const expected = Object.freeze({ ...descriptor });
      const read = "value" in descriptor
        ? () => descriptor.value as Value
        : () => apply(descriptor.get!, target, []) as Value;
      return Object.freeze({
        read,
        isCurrent: () =>
          ownerWindow.Object.getOwnPropertyDescriptor ===
            getOwnPropertyDescriptor &&
          ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
          ownerWindow.Reflect.apply === apply &&
          emptyOwners.every(
            (candidate) =>
              getOwnPropertyDescriptor(candidate, property) === undefined,
          ) &&
          activityDescriptorMatches(
            getOwnPropertyDescriptor(holder, property),
            expected,
          ),
      });
    }
    emptyOwners.push(owner);
    owner = getPrototypeOf(owner) as object | null;
  }
  return null;
}

function captureActivityMethod<Args extends readonly unknown[], Result>(
  ownerWindow: Window & typeof globalThis,
  prototype: object,
  property: string,
): ActivityCapturedMethod<Args, Result> | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  let owner: object | null = prototype;
  while (owner) {
    const holder = owner;
    const descriptor = getOwnPropertyDescriptor(holder, property);
    if (descriptor) {
      if (typeof descriptor.value !== "function") return null;
      const expected = Object.freeze({ ...descriptor });
      const method = descriptor.value as (...args: Args) => Result;
      return Object.freeze({
        invoke: (target: object, ...args: Args) =>
          apply(method, target, args) as Result,
        isCurrent: () =>
          ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
          ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
          ownerWindow.Reflect.apply === apply &&
          activityDescriptorMatches(
            getOwnPropertyDescriptor(holder, property),
            expected,
          ),
      });
    }
    owner = getPrototypeOf(holder) as object | null;
  }
  return null;
}

function captureActivityTrustedGetter(
  ownerWindow: Window & typeof globalThis,
): ActivityTrustedGetter | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const apply = ownerWindow.Reflect.apply;
  let probe: globalThis.KeyboardEvent;
  try {
    probe = new ownerWindow.KeyboardEvent("activity-header-trust-probe");
  } catch {
    return null;
  }
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    !descriptor ||
    descriptor.configurable !== false ||
    typeof descriptor.get !== "function"
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const getter = descriptor.get;
  const matches = (event: object) =>
    activityDescriptorMatches(
      getOwnPropertyDescriptor(event, "isTrusted"),
      expected,
    );
  return Object.freeze({
    read: (event: object) => apply(getter, event, []) as boolean,
    matches,
    isCurrent: () =>
      ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
      ownerWindow.Reflect.apply === apply &&
      matches(probe),
  });
}

function captureActivityKeyboardAuthority(
  ownerDocument: Document,
  ownerWindow: Window & typeof globalThis,
): ActivityKeyboardAuthority | null {
  const EventConstructor = ownerWindow.Event;
  const UIEventConstructor = ownerWindow.UIEvent;
  const KeyboardEventConstructor = ownerWindow.KeyboardEvent;
  const NodeConstructor = ownerWindow.Node;
  const DocumentConstructor = ownerWindow.Document;
  const HTMLElementConstructor = ownerWindow.HTMLElement;
  const EventTargetConstructor = ownerWindow.EventTarget;
  const apply = ownerWindow.Reflect.apply;
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const eventPrototype = EventConstructor.prototype;
  const uiEventPrototype = UIEventConstructor.prototype;
  const keyboardPrototype = KeyboardEventConstructor.prototype;
  const documentPrototype = DocumentConstructor.prototype;
  const htmlElementPrototype = HTMLElementConstructor.prototype;
  const eventTargetPrototype = EventTargetConstructor.prototype;
  const eventType = captureActivityGetter<string>(ownerWindow, eventPrototype, "type");
  const eventTarget = captureActivityGetter<EventTarget | null>(ownerWindow, eventPrototype, "target");
  const eventCurrentTarget = captureActivityGetter<EventTarget | null>(ownerWindow, eventPrototype, "currentTarget");
  const eventPhase = captureActivityGetter<number>(ownerWindow, eventPrototype, "eventPhase");
  const eventBubbles = captureActivityGetter<boolean>(ownerWindow, eventPrototype, "bubbles");
  const eventCancelable = captureActivityGetter<boolean>(ownerWindow, eventPrototype, "cancelable");
  const eventDefaultPrevented = captureActivityGetter<boolean>(ownerWindow, eventPrototype, "defaultPrevented");
  const eventCancelBubble = captureActivityGetter<boolean>(ownerWindow, eventPrototype, "cancelBubble");
  const eventPath = captureActivityMethod<readonly [], EventTarget[]>(ownerWindow, eventPrototype, "composedPath");
  const eventPreventDefault = captureActivityMethod<readonly [], void>(ownerWindow, eventPrototype, "preventDefault");
  const eventView = captureActivityGetter<Window | null>(ownerWindow, uiEventPrototype, "view");
  const key = captureActivityGetter<string>(ownerWindow, keyboardPrototype, "key");
  const code = captureActivityGetter<string>(ownerWindow, keyboardPrototype, "code");
  const repeat = captureActivityGetter<boolean>(ownerWindow, keyboardPrototype, "repeat");
  const composing = captureActivityGetter<boolean>(ownerWindow, keyboardPrototype, "isComposing");
  const altKey = captureActivityGetter<boolean>(ownerWindow, keyboardPrototype, "altKey");
  const ctrlKey = captureActivityGetter<boolean>(ownerWindow, keyboardPrototype, "ctrlKey");
  const metaKey = captureActivityGetter<boolean>(ownerWindow, keyboardPrototype, "metaKey");
  const shiftKey = captureActivityGetter<boolean>(ownerWindow, keyboardPrototype, "shiftKey");
  const activeElement = captureActivityGetter<Element | null>(ownerWindow, documentPrototype, "activeElement");
  const documentView = captureActivityValue<Window | null>(
    ownerWindow,
    ownerDocument,
    "defaultView",
  );
  const focus = captureActivityMethod<readonly [FocusOptions?], void>(ownerWindow, htmlElementPrototype, "focus");
  const listen = captureActivityMethod<readonly [string, EventListener, boolean], void>(ownerWindow, eventTargetPrototype, "addEventListener");
  const unlisten = captureActivityMethod<readonly [string, EventListener, boolean], void>(ownerWindow, eventTargetPrototype, "removeEventListener");
  const trusted = captureActivityTrustedGetter(ownerWindow);
  if (
    !eventType ||
    !eventTarget ||
    !eventCurrentTarget ||
    !eventPhase ||
    !eventBubbles ||
    !eventCancelable ||
    !eventDefaultPrevented ||
    !eventCancelBubble ||
    !eventPath ||
    !eventPreventDefault ||
    !eventView ||
    !key ||
    !code ||
    !repeat ||
    !composing ||
    !altKey ||
    !ctrlKey ||
    !metaKey ||
    !shiftKey ||
    !activeElement ||
    !documentView ||
    !focus ||
    !listen ||
    !unlisten ||
    !trusted ||
    documentView.read() !== ownerWindow
  ) {
    return null;
  }
  const captured: readonly ActivityCapturedIntrinsic[] = Object.freeze([
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
    eventView,
    key,
    code,
    repeat,
    composing,
    altKey,
    ctrlKey,
    metaKey,
    shiftKey,
    activeElement,
    documentView,
    focus,
    listen,
    unlisten,
    trusted,
  ]);
  let historyIsClean = true;
  const isCurrent = () => {
    if (!historyIsClean) return false;
    historyIsClean =
      ownerWindow.Event === EventConstructor &&
      ownerWindow.UIEvent === UIEventConstructor &&
      ownerWindow.KeyboardEvent === KeyboardEventConstructor &&
      ownerWindow.Node === NodeConstructor &&
      ownerWindow.Document === DocumentConstructor &&
      ownerWindow.HTMLElement === HTMLElementConstructor &&
      ownerWindow.EventTarget === EventTargetConstructor &&
      EventConstructor.prototype === eventPrototype &&
      UIEventConstructor.prototype === uiEventPrototype &&
      KeyboardEventConstructor.prototype === keyboardPrototype &&
      DocumentConstructor.prototype === documentPrototype &&
      HTMLElementConstructor.prototype === htmlElementPrototype &&
      EventTargetConstructor.prototype === eventTargetPrototype &&
      captured.every((intrinsic) => intrinsic.isCurrent()) &&
      documentView.read() === ownerWindow;
    return historyIsClean;
  };
  const reactMethodMatches = (
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
        owner = getPrototypeOf(owner) as object | null;
      }
    } catch {
      historyIsClean = false;
    }
    return false;
  };
  if (!isCurrent()) return null;
  return Object.freeze({
    ownerWindow,
    Event: EventConstructor,
    KeyboardEvent: KeyboardEventConstructor,
    Node: NodeConstructor,
    apply,
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
    eventView,
    key,
    code,
    repeat,
    composing,
    altKey,
    ctrlKey,
    metaKey,
    shiftKey,
    activeElement,
    documentView,
    focus,
    listen,
    unlisten,
    trusted,
    reactMethodMatches,
    isCurrent,
  });
}

function isActivityHeaderNavigationKey(
  key: string,
): key is ActivityHeaderNavigationKey {
  return (
    key === "ArrowLeft" ||
    key === "ArrowUp" ||
    key === "ArrowRight" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End"
  );
}

/** Published header order, without wrapping: an absent or already focused destination is inert. */
function activityHeaderDestination(
  key: ActivityHeaderNavigationKey,
  current: number,
  count: number,
): number | null {
  if (current < 0 || current >= count) return null;
  const destination =
    key === "ArrowRight" || key === "ArrowDown"
      ? current + 1
      : key === "ArrowLeft" || key === "ArrowUp"
        ? current - 1
        : key === "Home"
          ? 0
          : count - 1;
  if (destination < 0 || destination >= count || destination === current) {
    return null;
  }
  return destination;
}

function activityHeaderControlsMatch(
  published: readonly ActivityHeaderControl[],
  current: readonly ActivityHeaderControl[],
) {
  return (
    published.length === current.length &&
    published.every((control, index) => {
      const candidate = current[index];
      return Boolean(
        candidate &&
          control.index === index &&
          candidate.index === index &&
          control.kind === candidate.kind &&
          control.element === candidate.element,
      );
    })
  );
}

function activityControlIsEnabled(element: HTMLButtonElement) {
  if (
    element.disabled ||
    element.matches(":disabled") ||
    element.getAttribute("aria-disabled")?.toLowerCase() === "true"
  ) {
    return false;
  }
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
}

/**
 * The live native keydown still agrees, field for field, with the snapshot the publication's own
 * capture listener took: nothing was replaced, prevented or stopped between the two readings.
 */
function activityNativeKeySnapshotMatches(
  keyboard: ActivityKeyboardAuthority,
  delivery: ActivityNativeKeyDelivery,
) {
  const { snapshot } = delivery;
  const { event } = snapshot;
  if (!keyboard.isCurrent()) return false;
  try {
    const path = keyboard.eventPath.invoke(event);
    const view = keyboard.eventView.read(event);
    return (
      keyboard.trusted.matches(event) &&
      keyboard.trusted.read(event) &&
      keyboard.eventType.read(event) === "keydown" &&
      keyboard.key.read(event) === snapshot.key &&
      keyboard.code.read(event) === snapshot.code &&
      keyboard.eventTarget.read(event) === snapshot.target &&
      keyboard.eventBubbles.read(event) === snapshot.bubbles &&
      keyboard.eventCancelable.read(event) === snapshot.cancelable &&
      Object.is(view, snapshot.view) &&
      (view === null || view === keyboard.ownerWindow) &&
      !keyboard.eventDefaultPrevented.read(event) &&
      !keyboard.eventCancelBubble.read(event) &&
      !keyboard.repeat.read(event) &&
      !keyboard.composing.read(event) &&
      !keyboard.altKey.read(event) &&
      !keyboard.ctrlKey.read(event) &&
      !keyboard.metaKey.read(event) &&
      !keyboard.shiftKey.read(event) &&
      snapshot.path[snapshot.path.length - 2] ===
        snapshot.publication.ownerDocument &&
      snapshot.path[snapshot.path.length - 1] === snapshot.receiver &&
      path.length === snapshot.path.length &&
      path.every((entry, index) => entry === snapshot.path[index])
    );
  } catch {
    return false;
  }
}

/** The React wrapper's own claim about which native event it carries, without trusting it. */
function activityWrapperNativeEvent(
  event: ReactKeyboardEvent<HTMLElement>,
): object | null {
  try {
    const nativeEvent: unknown = event.nativeEvent;
    return nativeEvent && typeof nativeEvent === "object" ? nativeEvent : null;
  } catch {
    return null;
  }
}

function activityReactKeyMethods(
  event: ReactKeyboardEvent<HTMLElement>,
  keyboard: ActivityKeyboardAuthority,
  expected?: ActivityReactKeyMethods,
): ActivityReactKeyMethods | null {
  try {
    const methods = Object.freeze({
      preventDefault: event.preventDefault as (...args: never[]) => unknown,
      stopPropagation: event.stopPropagation as (...args: never[]) => unknown,
      isDefaultPrevented: event.isDefaultPrevented as (
        ...args: never[]
      ) => unknown,
      isPropagationStopped: event.isPropagationStopped as (
        ...args: never[]
      ) => unknown,
      persist: event.persist as (...args: never[]) => unknown,
    });
    if (
      !keyboard.reactMethodMatches(
        event,
        "preventDefault",
        methods.preventDefault,
      ) ||
      !keyboard.reactMethodMatches(
        event,
        "stopPropagation",
        methods.stopPropagation,
      ) ||
      !keyboard.reactMethodMatches(
        event,
        "isDefaultPrevented",
        methods.isDefaultPrevented,
      ) ||
      !keyboard.reactMethodMatches(
        event,
        "isPropagationStopped",
        methods.isPropagationStopped,
      ) ||
      !keyboard.reactMethodMatches(event, "persist", methods.persist) ||
      keyboard.apply(methods.isDefaultPrevented, event, []) !== false ||
      keyboard.apply(methods.isPropagationStopped, event, []) !== false ||
      (expected !== undefined &&
        (methods.preventDefault !== expected.preventDefault ||
          methods.stopPropagation !== expected.stopPropagation ||
          methods.isDefaultPrevented !== expected.isDefaultPrevented ||
          methods.isPropagationStopped !== expected.isPropagationStopped ||
          methods.persist !== expected.persist))
    ) {
      return null;
    }
    return methods;
  } catch {
    return null;
  }
}

/**
 * One genuine trusted React/native keydown pair on the exact focused header control, read through
 * the publication's captured owner-realm intrinsics rather than the event's own properties. The
 * native event has to be standing at the requested React delegation phase, so the returned
 * delegation target is the node React itself was dispatching from.
 */
function exactActivityHeaderKey<Element extends HTMLElement>(
  event: ReactKeyboardEvent<Element>,
  publication: ActivityPublication,
  source: HTMLButtonElement,
  reactCurrentTarget: Element,
  phase: ActivityHeaderKeyPhase,
  windowReceiver: EventTarget,
  expectedMethods?: ActivityReactKeyMethods,
): ActivityHeaderKeyFacts | null {
  const keyboard = publication.keyboard;
  if (!event || typeof event !== "object" || !keyboard || !keyboard.isCurrent()) {
    return null;
  }
  const nativeEvent = event.nativeEvent;
  if (
    !nativeEvent ||
    typeof nativeEvent !== "object" ||
    !(nativeEvent instanceof keyboard.KeyboardEvent) ||
    Object.getPrototypeOf(nativeEvent) !== keyboard.KeyboardEvent.prototype ||
    !keyboard.trusted.matches(nativeEvent)
  ) {
    return null;
  }
  try {
    const key = keyboard.key.read(nativeEvent);
    if (!isActivityHeaderNavigationKey(key)) return null;
    const code = keyboard.code.read(nativeEvent);
    const target = keyboard.eventTarget.read(nativeEvent);
    const currentTarget = keyboard.eventCurrentTarget.read(nativeEvent);
    const path = keyboard.eventPath.invoke(nativeEvent);
    const nativePhase = keyboard.eventPhase.read(nativeEvent);
    const bubbles = keyboard.eventBubbles.read(nativeEvent);
    const cancelable = keyboard.eventCancelable.read(nativeEvent);
    const defaultPrevented = keyboard.eventDefaultPrevented.read(nativeEvent);
    const cancelBubble = keyboard.eventCancelBubble.read(nativeEvent);
    const trusted = keyboard.trusted.read(nativeEvent);
    const repeat = keyboard.repeat.read(nativeEvent);
    const composing = keyboard.composing.read(nativeEvent);
    const altKey = keyboard.altKey.read(nativeEvent);
    const ctrlKey = keyboard.ctrlKey.read(nativeEvent);
    const metaKey = keyboard.metaKey.read(nativeEvent);
    const shiftKey = keyboard.shiftKey.read(nativeEvent);
    const nativeView = keyboard.eventView.read(nativeEvent);
    const methods = activityReactKeyMethods(
      event as ReactKeyboardEvent<HTMLElement>,
      keyboard,
      expectedMethods,
    );
    return keyboard.eventType.read(nativeEvent) === "keydown" &&
      nativePhase ===
        (phase === "capture"
          ? keyboard.Event.CAPTURING_PHASE
          : keyboard.Event.BUBBLING_PHASE) &&
      bubbles &&
      cancelable &&
      !defaultPrevented &&
      !cancelBubble &&
      trusted &&
      !repeat &&
      !composing &&
      !altKey &&
      !ctrlKey &&
      !metaKey &&
      !shiftKey &&
      (nativeView === null || nativeView === keyboard.ownerWindow) &&
      target === source &&
      target instanceof keyboard.Node &&
      target.ownerDocument === publication.ownerDocument &&
      currentTarget instanceof keyboard.Node &&
      (currentTarget === publication.ownerDocument ||
        currentTarget.ownerDocument === publication.ownerDocument) &&
      currentTarget.contains(publication.panel) &&
      path[0] === source &&
      path.filter((entry) => entry === source).length === 1 &&
      path.includes(currentTarget) &&
      path.includes(publication.header) &&
      path.includes(publication.panel) &&
      path[path.length - 1] === windowReceiver &&
      keyboard.activeElement.read(publication.ownerDocument) === source &&
      event.type === "keydown" &&
      event.currentTarget === reactCurrentTarget &&
      event.target === target &&
      event.nativeEvent === nativeEvent &&
      event.key === key &&
      event.code === code &&
      event.repeat === repeat &&
      event.altKey === altKey &&
      event.ctrlKey === ctrlKey &&
      event.metaKey === metaKey &&
      event.shiftKey === shiftKey &&
      event.bubbles === bubbles &&
      event.cancelable === cancelable &&
      event.defaultPrevented === defaultPrevented &&
      event.eventPhase === nativePhase &&
      event.isTrusted === trusted &&
      Object.is(event.view, nativeView) &&
      methods
      ? Object.freeze({
          nativeEvent,
          key,
          delegationTarget: currentTarget,
          methods,
        })
      : null;
  } catch {
    return null;
  }
}

function createActivityPublication({
  presentation,
  coordinator,
  current,
  retireVisit,
  refresh,
  requestMore,
  startVisit,
  requestPublicationSuccessor,
  requestVisitSuccessor,
}: {
  presentation: ActivityPresentation;
  coordinator: ActivityPublicationCoordinator;
  current: ActivityCurrent;
  retireVisit: (visit: ActivityVisit) => void;
  refresh: (visit: ActivityVisit, isRetry: boolean) => void;
  requestMore: (visit: ActivityVisit, cursor: string) => void;
  startVisit: (visit: ActivityVisit) => void;
  requestPublicationSuccessor: () => void;
  requestVisitSuccessor: (visit: ActivityVisit) => void;
}): ActivityPublicationSet {
  let layoutPassed = false;
  let currentRuntime: ActivityPublicationRuntime | null = null;
  let lastRuntime: ActivityPublicationRuntime | null = null;
  let successorRequested = false;
  const actions: Readonly<Record<ActivityActionKind, ActivityAction>> = Object.freeze({
    close: Object.freeze({ identity: Symbol("activity-close"), kind: "close" }),
    refresh: Object.freeze({
      identity: Symbol("activity-refresh"),
      kind: "refresh",
    }),
    retry: Object.freeze({ identity: Symbol("activity-retry"), kind: "retry" }),
    "load-more": Object.freeze({
      identity: Symbol("activity-load-more"),
      kind: "load-more",
    }),
    "navigate-refresh": Object.freeze({
      identity: Symbol("activity-navigate-refresh"),
      kind: "navigate-refresh",
    }),
    "navigate-close": Object.freeze({
      identity: Symbol("activity-navigate-close"),
      kind: "navigate-close",
    }),
  });
  const retireForElementChange = (
    owner: ActivityElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (layoutPassed && element !== previous) || (element && last && element !== last)) {
      currentRuntime?.retireForElement();
      currentRuntime = null;
    }
    if (
      !successorRequested &&
      runtime?.isExactElementReplay() &&
      coordinator.acceptsSuccessorOf(runtime.publication) &&
      exactDomIsCurrent() &&
      stageReplay(runtime)
    ) {
      successorRequested = true;
      if (current.isRetired(presentation.visit)) {
        requestVisitSuccessor(presentation.visit);
      } else {
        requestPublicationSuccessor();
      }
    }
  };
  const panel = new ActivityElementOwner<HTMLElement>(retireForElementChange);
  const header = new ActivityElementOwner<HTMLDivElement>(retireForElementChange);
  const manualRefresh = new ActivityElementOwner<HTMLButtonElement>(
    retireForElementChange,
  );
  const close = new ActivityElementOwner<HTMLButtonElement>(retireForElementChange);
  const scroll = new ActivityElementOwner<HTMLDivElement>(retireForElementChange);
  const content = new ActivityElementOwner<HTMLDivElement>(retireForElementChange);
  const listError = new ActivityElementOwner<HTMLDivElement>(retireForElementChange);
  const retry = new ActivityElementOwner<HTMLButtonElement>(retireForElementChange);
  const pageError = new ActivityElementOwner<HTMLDivElement>(retireForElementChange);
  const groups = presentation.groups.map(() =>
    new ActivityElementOwner<HTMLDivElement>(retireForElementChange));
  const rows = (presentation.items ?? []).map(() =>
    new ActivityElementOwner<HTMLLIElement>(retireForElementChange));
  const loadMore = new ActivityElementOwner<HTMLButtonElement>(retireForElementChange);

  const frozenFactsAreCurrent = () => {
    const { source, visit } = presentation;
    return (
      presentation.session === visit.session &&
      presentation.documentId === visit.documentId &&
      presentation.onClose === visit.onClose &&
      visit.session.docId === presentation.documentId &&
      source.stateVisit === visit &&
      source.nextBefore === presentation.nextBefore &&
      source.error === presentation.error &&
      source.listError === presentation.listError &&
      (source.items !== null || source.listError !== null) ===
        presentation.refreshAvailable &&
      Boolean(source.refresh) === presentation.refreshing &&
      source.retrying === presentation.retrying &&
      source.loadingMore === presentation.loadingMore &&
      source.now === presentation.now &&
      activityItemsMatch(source.items, presentation.items) &&
      (!source.cadence || source.cadence.visit === visit) &&
      (!source.refresh || source.refresh.visit === visit) &&
      (!source.loadMore ||
        (source.loadMore.visit === visit &&
          source.loadMore.cursor === presentation.nextBefore))
    );
  };

  const factsAreCurrent = () => {
    const { source, visit } = presentation;
    return (
      frozenFactsAreCurrent() &&
      current.ownsVisit(visit) &&
      current.cursor(visit) === presentation.nextBefore &&
      current.cadence(visit) === source.cadence &&
      current.refresh(visit) === source.refresh &&
      current.loadMore(visit) === source.loadMore &&
      Boolean(source.loadMore) === presentation.loadingMore
    );
  };

  /** Header child index of a control in the published DOM: label, optional Refresh, then Close. */
  const headerDomIndex = (kind: ActivityHeaderControlKind) =>
    kind === "refresh" ? 1 : presentation.refreshAvailable ? 2 : 1;

  /** Currently available and enabled header controls, in exact published DOM order. */
  const currentHeaderControls = (): readonly ActivityHeaderControl[] | null => {
    const closeElement = close.element();
    const refreshElement = manualRefresh.element();
    if (!closeElement) return null;
    const controls: ActivityHeaderControl[] = [];
    if (presentation.refreshAvailable && !presentation.refreshing) {
      if (!refreshElement) return null;
      controls.push({ kind: "refresh", index: 0, element: refreshElement });
    }
    controls.push({
      kind: "close",
      index: controls.length,
      element: closeElement,
    });
    return Object.freeze(controls.map((control) => Object.freeze(control)));
  };

  const exactDomIsCurrent = () => {
    const panelElement = panel.element();
    const headerElement = header.element();
    const refreshElement = manualRefresh.element();
    const closeElement = close.element();
    const scrollElement = scroll.element();
    const contentElement = content.element();
    if (
      !panelElement ||
      !headerElement ||
      !closeElement ||
      !scrollElement ||
      !contentElement ||
      !panelElement.isConnected ||
      panelElement.tagName !== "ASIDE" ||
      panelElement.dataset.testid !== "activity-panel" ||
      panelElement.children.length !== 2 ||
      panelElement.children.item(0) !== headerElement ||
      panelElement.children.item(1) !== scrollElement ||
      headerElement.parentElement !== panelElement ||
      headerElement.children.length !==
        (presentation.refreshAvailable ? 3 : 2) ||
      headerElement.children.item(
        presentation.refreshAvailable ? 2 : 1,
      ) !== closeElement ||
      headerElement.children.item(0)?.tagName !== "SPAN" ||
      headerElement.children.item(0)?.textContent !== "Activity" ||
      closeElement.parentElement !== headerElement ||
      closeElement.type !== "button" ||
      closeElement.disabled ||
      closeElement.getAttribute("aria-label") !== "Close activity" ||
      scrollElement.parentElement !== panelElement ||
      scrollElement.children.length !== 1 ||
      scrollElement.firstElementChild !== contentElement ||
      contentElement.parentElement !== scrollElement
    ) {
      return false;
    }
    if (presentation.refreshAvailable) {
      if (
        !refreshElement ||
        headerElement.children.item(1) !== refreshElement ||
        refreshElement.parentElement !== headerElement ||
        refreshElement.type !== "button" ||
        refreshElement.disabled !== presentation.refreshing ||
        refreshElement.getAttribute("aria-label") !==
          (presentation.refreshing
            ? "Refreshing activity"
            : "Refresh activity")
      ) {
        return false;
      }
    } else if (refreshElement) {
      return false;
    }

    const contentChildren = [...contentElement.children];
    let contentIndex = 0;
    const listErrorElement = listError.element();
    const retryElement = retry.element();
    if (presentation.listError) {
      if (
        !listErrorElement ||
        !retryElement ||
        contentChildren[contentIndex++] !== listErrorElement ||
        listErrorElement.parentElement !== contentElement ||
        listErrorElement.getAttribute("role") !== "alert" ||
        listErrorElement.getAttribute("aria-atomic") !== "true" ||
        listErrorElement.children.length !== 2 ||
        listErrorElement.children.item(0)?.textContent !== presentation.listError ||
        listErrorElement.children.item(1) !== retryElement ||
        retryElement.parentElement !== listErrorElement ||
        retryElement.type !== "button" ||
        retryElement.disabled !==
          (presentation.retrying || presentation.refreshing) ||
        retryElement.textContent?.trim() !== (presentation.retrying ? "Retrying…" : "Retry")
      ) {
        return false;
      }
    } else if (listErrorElement || retryElement) {
      return false;
    }

    const pageErrorElement = pageError.element();
    if (presentation.error) {
      if (
        !pageErrorElement ||
        contentChildren[contentIndex++] !== pageErrorElement ||
        pageErrorElement.parentElement !== contentElement ||
        pageErrorElement.textContent !== presentation.error
      ) {
        return false;
      }
    } else if (pageErrorElement) {
      return false;
    }

    if (presentation.contentMode === "loading") {
      const loading = contentChildren[contentIndex++];
      if (!loading || loading.className !== "flex justify-center py-10") return false;
    } else if (presentation.contentMode === "empty") {
      const empty = contentChildren[contentIndex++];
      if (
        !empty ||
        !empty.textContent?.includes("No activity yet") ||
        !empty.textContent.includes("Edits, comments, versions and shares by people and agents show up here.")
      ) {
        return false;
      }
    } else if (presentation.contentMode === "list") {
      for (const [groupIndex, groupFacts] of presentation.groups.entries()) {
        const groupElement = groups[groupIndex]?.element();
        const listElement = groupElement?.children.item(1);
        if (
          !groupElement ||
          contentChildren[contentIndex++] !== groupElement ||
          groupElement.parentElement !== contentElement ||
          groupElement.children.length !== 2 ||
          groupElement.children.item(0)?.textContent !== groupFacts.day ||
          listElement?.tagName !== "UL" ||
          listElement.children.length !== groupFacts.rows.length
        ) {
          return false;
        }
        for (const [rowIndex, rowFacts] of groupFacts.rows.entries()) {
          const rowElement = rows[rowFacts.index]?.element();
          if (
            !rowElement ||
            rowElement.parentElement !== listElement ||
            listElement.children.item(rowIndex) !== rowElement ||
            rowElement.dataset.testid !== "activity-row" ||
            rowElement.dataset.action !== rowFacts.item.action ||
            rowElement.dataset.actorKind !== rowFacts.item.actorKind
          ) {
            return false;
          }
        }
      }
    }

    const loadMoreElement = loadMore.element();
    const expectsLoadMore = presentation.contentMode === "list" && presentation.nextBefore !== null;
    if (expectsLoadMore) {
      if (
        !loadMoreElement ||
        contentChildren[contentIndex++] !== loadMoreElement ||
        loadMoreElement.parentElement !== contentElement ||
        loadMoreElement.type !== "button" ||
        loadMoreElement.disabled !== presentation.loadingMore ||
        loadMoreElement.dataset.testid !== "activity-load-more" ||
        loadMoreElement.textContent?.trim() !== "Load more"
      ) {
        return false;
      }
    } else if (loadMoreElement) {
      return false;
    }
    return contentIndex === contentChildren.length;
  };

  const expectedOwners = (): readonly ActivityElementOwnerView[] => {
    const owners: ActivityElementOwnerView[] = [
      panel,
      header,
      ...(presentation.refreshAvailable ? [manualRefresh] : []),
      close,
      scroll,
      content,
    ];
    if (presentation.listError) owners.push(listError, retry);
    if (presentation.error) owners.push(pageError);
    if (presentation.contentMode === "list") {
      owners.push(...groups, ...rows);
      if (presentation.nextBefore) owners.push(loadMore);
    }
    return owners;
  };

  const stageReplay = (runtime: ActivityPublicationRuntime) => {
    const replay = runtime.replay();
    const retiredVisitIsClean =
      current.isRetired(presentation.visit) &&
      current.cadence(presentation.visit) === null &&
      current.refresh(presentation.visit) === null &&
      current.loadMore(presentation.visit) === null;
    return Boolean(
      replay &&
      frozenFactsAreCurrent() &&
      (retiredVisitIsClean || factsAreCurrent()) &&
      runtime.publication.publishedDomMatches() &&
      coordinator.stageReplay(replay)
    );
  };

  const claim = (
    kind: ActivityClickActionKind,
    event: ReactMouseEvent<HTMLButtonElement>,
  ): ActivityPublication | null => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const action = actions[kind];
    if (
      !runtime ||
      !publication ||
      publication.isRetired() ||
      !event ||
      typeof event !== "object"
    ) {
      return null;
    }
    const element = kind === "close"
      ? close.element()
      : kind === "refresh"
        ? manualRefresh.element()
        : kind === "retry"
          ? retry.element()
          : loadMore.element();
    const document = element?.ownerDocument;
    const MouseEventConstructor = document?.defaultView?.MouseEvent;
    const nativeEvent = event.nativeEvent;
    if (
      !element ||
      !document ||
      !MouseEventConstructor ||
      event.type !== "click" ||
      !(nativeEvent instanceof MouseEventConstructor) ||
      nativeEvent.type !== "click" ||
      event.currentTarget !== element ||
      nativeEvent.target !== event.target ||
      !isNodeFromDocument(event.target, document) ||
      !element.contains(event.target) ||
      !element.isConnected ||
      element.disabled ||
      !coordinator.isCurrent(publication) ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !publication.publishedDomMatches()
    ) {
      return null;
    }
    if (
      kind === "refresh" &&
      (!presentation.refreshAvailable ||
        presentation.refreshing ||
        current.hasRefresh(presentation.visit))
    ) {
      return null;
    }
    if (
      kind === "retry" &&
      (!presentation.listError || presentation.retrying || current.hasRefresh(presentation.visit))
    ) {
      return null;
    }
    if (
      kind === "load-more" &&
      (!presentation.nextBefore ||
        presentation.loadingMore ||
        current.cursor(presentation.visit) !== presentation.nextBefore ||
        current.hasLoadMore(presentation.visit))
    ) {
      return null;
    }
    if (
      !coordinator.claim(
        presentation.visit,
        publication,
        action,
        [event],
        nativeEvent,
      )
    ) {
      return null;
    }
    return publication;
  };

  const createRuntime = (): ActivityPublicationRuntime | null => {
    type Retirement = "element" | "layout" | "other";
    const panelElement = panel.element();
    const headerElement = header.element();
    const ownerWindow = panelElement?.ownerDocument.defaultView;
    const headerControls = currentHeaderControls();
    const placement = panelElement
      ? captureActivityPlacement(panelElement)
      : null;
    if (
      !panelElement ||
      !placement ||
      !headerElement ||
      !ownerWindow ||
      !headerControls
    ) {
      return null;
    }
    const keyboard = captureActivityKeyboardAuthority(
      panelElement.ownerDocument,
      ownerWindow,
    );
    const dom = snapshotActivityDom(panelElement);
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let invalidReplay = false;
    let replayRefs: ActivityRefReplay[] = [];
    let domGuard: ActivityDomGuard | null = null;
    let listening = false;
    const nativeDeliveries = new WeakMap<object, ActivityNativeKeyDelivery>();
    const seenNativeKeys = new WeakSet<object>();
    const nativeBubbleTargets = new Set<EventTarget>();
    const publishedDomMatches = () =>
      Boolean(
        domGuard &&
        domGuard.isClean() &&
        panel.element() === panelElement &&
        panelElement === dom.node &&
        panelElement.isConnected &&
        activityPlacementMatches(panelElement, placement) &&
        activityDomMatches(dom)
      );
    const removeListeners = () => {
      if (!listening || !keyboard) return;
      listening = false;
      try {
        keyboard.unlisten.invoke(ownerWindow, "keydown", captureNative, true);
        keyboard.unlisten.invoke(panelElement, "keydown", crossNativePanel, false);
        for (const target of nativeBubbleTargets) {
          keyboard.unlisten.invoke(target, "keydown", finalizeNative, false);
        }
      } catch {
        /* A replaced listener intrinsic cannot be undone; the retired publication stays inert. */
      }
      nativeBubbleTargets.clear();
    };
    const retire = (reason: Retirement) => {
      if (retired) return false;
      retired = true;
      retirement = reason;
      removeListeners();
      coordinator.retire(publication);
      if (currentRuntime?.publication === publication) currentRuntime = null;
      queueMicrotask(() => {
        if (coordinator.replay()?.source !== publication) domGuard?.release();
      });
      return true;
    };
    const publication: ActivityPublication = Object.freeze({
      identity: Symbol("activity-publication"),
      presentation,
      ownerDocument: panelElement.ownerDocument,
      ownerWindow,
      panel: panelElement,
      header: headerElement,
      headerControls,
      keyboard,
      dom,
      placement,
      retire: () => retire("other"),
      isRetired: () => retired,
      publishedDomMatches,
    });
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
      replayRefs.some((entry) => entry.detached && entry.reattached) &&
      replayRefs.every(
        (entry) =>
          ((!entry.detached && !entry.reattached) ||
            (entry.detached && entry.reattached)) &&
          entry.owner.element() === entry.element,
      );

    /**
     * The publication's own owner-realm capture listener on the window: the first listener that can
     * see a trusted header keydown, and the only place a delivery ledger is ever opened. One native
     * event is snapshotted at most once, so a re-dispatched event can never open a second ledger.
     */
    function captureNative(this: EventTarget, nativeEvent: Event) {
      if (
        retired ||
        !keyboard ||
        !keyboard.isCurrent() ||
        !(nativeEvent instanceof keyboard.KeyboardEvent) ||
        Object.getPrototypeOf(nativeEvent) !== keyboard.KeyboardEvent.prototype ||
        seenNativeKeys.has(nativeEvent)
      ) {
        return;
      }
      seenNativeKeys.add(nativeEvent);
      if (!coordinator.isCurrent(publication)) return;
      try {
        const currentTarget = keyboard.eventCurrentTarget.read(nativeEvent);
        const path = keyboard.eventPath.invoke(nativeEvent);
        if (
          !keyboard.trusted.matches(nativeEvent) ||
          !keyboard.trusted.read(nativeEvent) ||
          keyboard.eventType.read(nativeEvent) !== "keydown" ||
          currentTarget !== this ||
          keyboard.eventPhase.read(nativeEvent) !==
            keyboard.Event.CAPTURING_PHASE ||
          path[path.length - 2] !== publication.ownerDocument ||
          path[path.length - 1] !== this
        ) {
          return;
        }
        const key = keyboard.key.read(nativeEvent);
        const target = keyboard.eventTarget.read(nativeEvent);
        const control =
          headerControls.find((entry) => entry.element === target) ?? null;
        if (!isActivityHeaderNavigationKey(key) || !control) return;
        const delivery: ActivityNativeKeyDelivery = {
          snapshot: Object.freeze({
            event: nativeEvent,
            publication,
            control,
            key,
            code: keyboard.code.read(nativeEvent),
            target,
            path: Object.freeze([...path]),
            bubbles: keyboard.eventBubbles.read(nativeEvent),
            cancelable: keyboard.eventCancelable.read(nativeEvent),
            view: keyboard.eventView.read(nativeEvent),
            receiver: this,
          }),
          delegationTarget: null,
          crossedPanel: false,
          captureInvalid: false,
          captureRootCount: 0,
          captureRootEvent: null,
          reactMethods: null,
          captureCount: 0,
          captureEvent: null,
          bubbleInvalid: false,
          bubbleCount: 0,
          bubbleEvent: null,
          bubbleRootCount: 0,
          bubbleRootEvent: null,
        };
        nativeDeliveries.set(nativeEvent, delivery);
        queueMicrotask(() => {
          queueMicrotask(() => {
            if (nativeDeliveries.get(nativeEvent) === delivery) {
              nativeDeliveries.delete(nativeEvent);
            }
          });
        });
      } catch {
        nativeDeliveries.delete(nativeEvent);
      }
    }

    /** The published panel's own bubble listener: proof the native event really left the header. */
    function crossNativePanel(nativeEvent: Event) {
      const delivery = nativeDeliveries.get(nativeEvent);
      if (retired || !keyboard || !delivery) return;
      if (delivery.snapshot.publication !== publication) return;
      try {
        if (
          keyboard.eventCurrentTarget.read(nativeEvent) !== panelElement ||
          keyboard.eventPhase.read(nativeEvent) !==
            keyboard.Event.BUBBLING_PHASE
        ) {
          return;
        }
      } catch {
        delivery.captureInvalid = true;
        delivery.bubbleInvalid = true;
        return;
      }
      delivery.crossedPanel = true;
      if (
        delivery.captureInvalid ||
        delivery.captureCount !== 1 ||
        !delivery.captureEvent ||
        !delivery.delegationTarget ||
        !activityNativeKeySnapshotMatches(keyboard, delivery)
      ) {
        delivery.captureInvalid = true;
      }
    }

    const listenOnDelegationTarget = (target: Node) => {
      if (!keyboard || !listening) return false;
      if (nativeBubbleTargets.has(target)) return true;
      try {
        keyboard.listen.invoke(target, "keydown", finalizeNative, false);
      } catch {
        return false;
      }
      nativeBubbleTargets.add(target);
      return true;
    };

    const stageHeaderRootKey = (
      phase: ActivityHeaderKeyPhase,
      event: ReactKeyboardEvent<HTMLDivElement>,
    ) => {
      if (retired || !keyboard || !event || typeof event !== "object") return;
      const carried = activityWrapperNativeEvent(event);
      const delivery = carried ? nativeDeliveries.get(carried) : undefined;
      if (!delivery || delivery.snapshot.publication !== publication) return;
      const staged = delivery.snapshot;
      const controls = currentHeaderControls();
      const source =
        controls?.find((control) => control.kind === staged.control.kind) ?? null;
      const liveHeader = header.element();
      const action =
        actions[
          staged.control.kind === "refresh"
            ? "navigate-refresh"
            : "navigate-close"
        ];
      const facts =
        source && liveHeader
          ? exactActivityHeaderKey(
              event,
              publication,
              source.element,
              liveHeader,
              phase,
              staged.receiver,
              delivery.reactMethods ?? undefined,
            )
          : null;
      if (
        !facts ||
        !controls ||
        !source ||
        !liveHeader ||
        liveHeader !== publication.header ||
        source.index !== staged.control.index ||
        source.element !== staged.control.element ||
        !activityHeaderControlsMatch(publication.headerControls, controls) ||
        !coordinator.isCurrent(publication) ||
        !factsAreCurrent() ||
        !exactDomIsCurrent() ||
        !publication.publishedDomMatches()
      ) {
        if (phase === "capture") delivery.captureInvalid = true;
        else delivery.bubbleInvalid = true;
        return;
      }
      if (phase === "capture") {
        if (
          delivery.crossedPanel ||
          delivery.captureInvalid ||
          delivery.captureRootCount !== 0 ||
          delivery.captureRootEvent !== null ||
          delivery.captureCount !== 0 ||
          delivery.captureEvent !== null ||
          delivery.delegationTarget !== null ||
          facts.delegationTarget === panelElement ||
          !staged.path.includes(facts.delegationTarget) ||
          coordinator.hasClaimed(
            presentation.visit,
            publication,
            action,
            [event],
            facts.nativeEvent,
            [source.element],
          ) ||
          !listenOnDelegationTarget(facts.delegationTarget)
        ) {
          delivery.captureInvalid = true;
          return;
        }
        delivery.captureRootCount += 1;
        delivery.captureRootEvent = event;
        delivery.reactMethods = facts.methods;
        delivery.delegationTarget = facts.delegationTarget;
        return;
      }
      const rootEvent: ReactKeyboardEvent<HTMLElement> = event;
      if (
        !delivery.delegationTarget ||
        delivery.delegationTarget !== facts.delegationTarget ||
        !delivery.crossedPanel ||
        delivery.captureInvalid ||
        delivery.bubbleInvalid ||
        delivery.captureRootCount !== 1 ||
        !delivery.captureRootEvent ||
        delivery.captureCount !== 1 ||
        !delivery.captureEvent ||
        delivery.bubbleCount !== 1 ||
        delivery.bubbleEvent !== rootEvent ||
        delivery.bubbleRootCount !== 0 ||
        delivery.bubbleRootEvent !== null ||
        coordinator.hasClaimed(
          presentation.visit,
          publication,
          action,
          [delivery.captureRootEvent, event],
          facts.nativeEvent,
          [source.element],
        )
      ) {
        delivery.bubbleInvalid = true;
        return;
      }
      delivery.bubbleRootCount += 1;
      delivery.bubbleRootEvent = event;
    };

    /**
     * Stages one React delivery of a header key. The header and control must receive the same
     * capture wrapper and the same distinct bubble wrapper. This binds the committed callback
     * chain as well as the native dispatch, so replacing a control callback cannot authenticate a
     * fabricated wrapper by withholding React's genuine one.
     */
    const stageHeaderKey = (
      kind: ActivityHeaderControlKind,
      phase: ActivityHeaderKeyPhase,
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ) => {
      if (retired || !keyboard || !event || typeof event !== "object") return;
      const controls = currentHeaderControls();
      const owned = kind === "refresh" ? manualRefresh.element() : close.element();
      const source = controls?.find((control) => control.kind === kind) ?? null;
      const liveHeader = header.element();
      const action =
        actions[kind === "refresh" ? "navigate-refresh" : "navigate-close"];
      if (
        !controls ||
        !source ||
        !owned ||
        !liveHeader ||
        publication.presentation !== presentation ||
        keyboard.ownerWindow !== publication.ownerWindow ||
        keyboard.documentView.read() !== publication.ownerWindow ||
        liveHeader !== publication.header ||
        source.element !== owned ||
        !activityHeaderControlsMatch(publication.headerControls, controls) ||
        !coordinator.isCurrent(publication) ||
        !factsAreCurrent() ||
        !exactDomIsCurrent() ||
        !publication.publishedDomMatches()
      ) {
        return;
      }
      const carried = activityWrapperNativeEvent(event);
      const delivery = carried ? nativeDeliveries.get(carried) : undefined;
      if (!delivery || delivery.snapshot.publication !== publication) return;
      const facts = exactActivityHeaderKey(
        event,
        publication,
        source.element,
        source.element,
        phase,
        delivery.snapshot.receiver,
        delivery.reactMethods ?? undefined,
      );
      if (!facts) {
        if (phase === "capture") delivery.captureInvalid = true;
        else delivery.bubbleInvalid = true;
        return;
      }
      const staged = delivery.snapshot;
      const exactSource =
        staged.key === facts.key &&
        staged.control.kind === source.kind &&
        staged.control.index === source.index &&
        staged.control.element === source.element;
      if (phase === "capture") {
        if (
          delivery.crossedPanel ||
          delivery.captureInvalid ||
          delivery.captureRootCount !== 1 ||
          delivery.captureRootEvent !== event ||
          delivery.captureCount !== 0 ||
          delivery.captureEvent !== null ||
          delivery.delegationTarget !== facts.delegationTarget ||
          !exactSource ||
          !activityNativeKeySnapshotMatches(keyboard, delivery) ||
          coordinator.hasClaimed(
            presentation.visit,
            publication,
            action,
            [event],
            facts.nativeEvent,
            [source.element],
          )
        ) {
          delivery.captureInvalid = true;
          return;
        }
        delivery.captureCount += 1;
        if (delivery.captureCount !== 1) {
          delivery.captureInvalid = true;
          return;
        }
        delivery.captureEvent = event;
        return;
      }
      if (
        !delivery.delegationTarget ||
        delivery.delegationTarget !== facts.delegationTarget
      ) {
        delivery.bubbleInvalid = true;
        return;
      }
      const captureEvent = delivery.captureEvent;
      if (
        !delivery.crossedPanel ||
        delivery.captureInvalid ||
        delivery.bubbleInvalid ||
        delivery.captureCount !== 1 ||
        !captureEvent ||
        captureEvent === event ||
        delivery.bubbleEvent !== null ||
        delivery.bubbleRootCount !== 0 ||
        delivery.bubbleRootEvent !== null ||
        !exactSource ||
        !activityNativeKeySnapshotMatches(keyboard, delivery) ||
        coordinator.hasClaimed(
          presentation.visit,
          publication,
          action,
          [captureEvent, event],
          facts.nativeEvent,
          [source.element],
        )
      ) {
        delivery.bubbleInvalid = true;
        return;
      }
      delivery.bubbleCount += 1;
      if (delivery.bubbleCount !== 1) {
        delivery.bubbleInvalid = true;
        return;
      }
      delivery.bubbleEvent = event;
    };

    /**
     * The publication's own bubble listener on the delegation root, registered while React was
     * dispatching the capture pass and therefore invoked after React's own delivery. Nothing is
     * prevented or focused until the publication, the movement, both exact wrapper identities, the
     * native event, the source and the destination have all been claimed together.
     */
    function finalizeNative(nativeEvent: Event) {
      const delivery = nativeDeliveries.get(nativeEvent);
      if (retired || !keyboard || !delivery) return;
      if (delivery.snapshot.publication !== publication) return;
      const staged = delivery.snapshot;
      const captureEvent = delivery.captureEvent;
      const bubbleEvent = delivery.bubbleEvent;
      const controls = currentHeaderControls();
      const source =
        controls?.find((control) => control.kind === staged.control.kind) ?? null;
      const liveHeader = header.element();
      const action =
        actions[
          staged.control.kind === "refresh"
            ? "navigate-refresh"
            : "navigate-close"
        ];
      try {
        if (
          keyboard.eventCurrentTarget.read(nativeEvent) !==
            delivery.delegationTarget ||
          keyboard.eventPhase.read(nativeEvent) !==
            keyboard.Event.BUBBLING_PHASE ||
          !delivery.crossedPanel ||
          delivery.captureInvalid ||
          delivery.bubbleInvalid ||
          delivery.captureRootCount !== 1 ||
          delivery.captureCount !== 1 ||
          delivery.bubbleCount !== 1 ||
          delivery.bubbleRootCount !== 1 ||
          !delivery.captureRootEvent ||
          !captureEvent ||
          !bubbleEvent ||
          !delivery.bubbleRootEvent ||
          delivery.captureRootEvent !== captureEvent ||
          delivery.bubbleRootEvent !== bubbleEvent ||
          captureEvent === bubbleEvent ||
          !controls ||
          !source ||
          !liveHeader ||
          liveHeader !== publication.header ||
          source.index !== staged.control.index ||
          source.element !== staged.control.element ||
          !activityHeaderControlsMatch(publication.headerControls, controls) ||
          keyboard.activeElement.read(publication.ownerDocument) !==
            source.element ||
          !activityNativeKeySnapshotMatches(keyboard, delivery) ||
          !coordinator.isCurrent(publication) ||
          !factsAreCurrent() ||
          !exactDomIsCurrent() ||
          !publication.publishedDomMatches()
        ) {
          return;
        }
        const destinationIndex = activityHeaderDestination(
          staged.key,
          source.index,
          controls.length,
        );
        const destination =
          destinationIndex === null ? null : (controls[destinationIndex] ?? null);
        if (
          destinationIndex === null ||
          !destination ||
          destination.element === source.element ||
          publication.headerControls[destinationIndex]?.element !==
            destination.element ||
          destination.element.ownerDocument !== publication.ownerDocument ||
          !destination.element.isConnected ||
          destination.element.parentElement !== liveHeader ||
          liveHeader.children.item(headerDomIndex(destination.kind)) !==
            destination.element ||
          !activityControlIsEnabled(destination.element) ||
          !coordinator.claim(
            presentation.visit,
            publication,
            action,
            [captureEvent, bubbleEvent],
            nativeEvent,
            [source.element, destination.element],
          )
        ) {
          return;
        }
        delivery.captureInvalid = true;
        delivery.bubbleInvalid = true;
        nativeDeliveries.delete(nativeEvent);
        keyboard.eventPreventDefault.invoke(nativeEvent);
        if (keyboard.eventDefaultPrevented.read(nativeEvent)) {
          keyboard.focus.invoke(destination.element, { preventScroll: true });
        }
      } catch {
        delivery.captureInvalid = true;
        delivery.bubbleInvalid = true;
        return;
      }
      requestPublicationSuccessor();
    }

    const attachListeners = () => {
      if (!keyboard || !keyboard.isCurrent() || listening) return false;
      listening = true;
      try {
        keyboard.listen.invoke(ownerWindow, "keydown", captureNative, true);
        keyboard.listen.invoke(panelElement, "keydown", crossNativePanel, false);
      } catch {
        removeListeners();
        return false;
      }
      return true;
    };

    const runtime: ActivityPublicationRuntime = Object.freeze({
      publication,
      publish: () => {
        established = true;
        replayRefs = expectedOwners().map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish Activity controls without every committed ref",
            );
          }
          return { owner, element, detached: false, reattached: false };
        });
        domGuard = createActivityDomGuard(panelElement, placement);
        if (!domGuard || !coordinator.publish(publication)) {
          domGuard?.release();
          return false;
        }
        attachListeners();
        return true;
      },
      stageHeaderRootKey,
      stageHeaderKey,
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        retire("layout");
      },
      noteRef: (
        owner: ActivityElementOwnerView,
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
      isExactElementReplay: () =>
        retired &&
        retirement === "element" &&
        established &&
        refsHaveExactReplay() &&
        publishedDomMatches(),
      isExactLayoutReplay: () =>
        retired &&
        retirement === "layout" &&
        established &&
        (refsHaveNoReplay() || refsHaveExactReplay()) &&
        publishedDomMatches(),
      replay: () =>
        domGuard
          ? Object.freeze({
              source: publication,
              dom,
              placement,
              historyIsClean: domGuard.isClean,
              release: domGuard.release,
            })
          : null,
    });
    return runtime;
  };

  /**
   * Moves focus between the current enabled header controls. Only the exact React capture and
   * bubble deliveries React itself makes for one native dispatch may stage the movement; the
   * publication's own listener on that delegation root finalizes it.
   */
  const navigate = (
    kind: ActivityHeaderControlKind,
    phase: ActivityHeaderKeyPhase,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const runtime = currentRuntime;
    if (!runtime || runtime.publication.isRetired()) return;
    runtime.stageHeaderKey(kind, phase, event);
  };
  const navigateHeader = (
    phase: ActivityHeaderKeyPhase,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const runtime = currentRuntime;
    if (!runtime || runtime.publication.isRetired()) return;
    runtime.stageHeaderRootKey(phase, event);
  };

  return Object.freeze({
    establish: () => {
      layoutPassed = true;
      if (lastRuntime) {
        if (
          !successorRequested &&
          (lastRuntime.isExactLayoutReplay() ||
            lastRuntime.isExactElementReplay()) &&
          coordinator.acceptsSuccessorOf(lastRuntime.publication) &&
          exactDomIsCurrent() &&
          stageReplay(lastRuntime)
        ) {
          successorRequested = true;
          if (current.isRetired(presentation.visit)) {
            requestVisitSuccessor(presentation.visit);
          } else {
            requestPublicationSuccessor();
          }
        }
        return undefined;
      }
      if (!factsAreCurrent() || !exactDomIsCurrent()) return undefined;
      const panelElement = panel.element();
      if (
        !panelElement ||
        !replayAllowsActivityPublication(
          coordinator,
          presentation,
          panelElement,
        )
      ) {
        return undefined;
      }
      const runtime = createRuntime();
      if (!runtime) return undefined;
      currentRuntime = runtime;
      lastRuntime = runtime;
      if (!runtime.publish()) {
        runtime.retireForElement();
        currentRuntime = null;
        return undefined;
      }
      startVisit(presentation.visit);
      return runtime.retireForLayout;
    },
    capturePanel: panel.capture,
    captureHeader: header.capture,
    captureRefresh: manualRefresh.capture,
    captureClose: close.capture,
    captureScroll: scroll.capture,
    captureContent: content.capture,
    captureListError: listError.capture,
    captureRetry: retry.capture,
    capturePageError: pageError.capture,
    captureGroup: (index: number) => groups[index]?.capture ?? (() => {}),
    captureRow: (index: number) => rows[index]?.capture ?? (() => {}),
    captureLoadMore: loadMore.capture,
    manualRefresh: (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (!claim("refresh", event)) return;
      refresh(presentation.visit, false);
    },
    close: (event: ReactMouseEvent<HTMLButtonElement>) => {
      const publication = claim("close", event);
      if (!publication) return;
      publication.retire();
      retireVisit(presentation.visit);
      presentation.onClose();
    },
    retry: (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (!claim("retry", event)) return;
      refresh(presentation.visit, true);
    },
    loadMore: (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (!claim("load-more", event) || !presentation.nextBefore) return;
      requestMore(presentation.visit, presentation.nextBefore);
    },
    navigateFromRefresh: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      navigate("refresh", "bubble", event);
    },
    navigateFromClose: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      navigate("close", "bubble", event);
    },
    navigateCaptureFromRefresh: (
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ) => {
      navigate("refresh", "capture", event);
    },
    navigateCaptureFromClose: (
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ) => {
      navigate("close", "capture", event);
    },
    navigateCaptureFromHeader: (
      event: ReactKeyboardEvent<HTMLDivElement>,
    ) => {
      navigateHeader("capture", event);
    },
    navigateFromHeader: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      navigateHeader("bubble", event);
    },
  });
}

function ActorAvatar({ item }: { item: ActivityItemFacts }) {
  if (item.actorKind === "agent") {
    return (
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700" title={`${item.actorName} (agent)`}>
        <Bot size={15} />
      </span>
    );
  }
  return <Avatar name={item.actorName} size={28} />;
}

export function ActivityPanel(props: ActivityPanelProps) {
  return <ActivityPanelForDocument key={props.session.docId} {...props} />;
}

function ActivityPanelForDocument({ session, onClose }: ActivityPanelProps) {
  const documentId = session.docId;
  const sourceVisit = useMemo<ActivityVisit>(
    () => Object.freeze({
      session,
      documentId,
      onClose,
      predecessor: null,
    }),
    [session, documentId, onClose],
  );
  const [mount] = useState(() => Symbol("activity-panel"));
  const [coordinator] = useState(() => new ActivityPublicationCoordinator(mount));
  const [current] = useState(() => new ActivityCurrent());
  const [replayVisit, setReplayVisit] = useState<ActivityVisit | null>(null);
  const visit =
    replayVisit?.session === session &&
    replayVisit.documentId === documentId &&
    replayVisit.onClose === onClose
      ? replayVisit
      : sourceVisit;
  const [, setPublicationRevision] = useState(0);
  const [stateVisit, setStateVisit] = useState(visit);
  const [items, setItems] = useState<ActivityItemDto[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [clearedCadences] = useState(() => new WeakSet<CadenceOperation>());
  const requestPublicationRevision = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const requestVisitSuccessor = useCallback((predecessor: ActivityVisit) => {
    if (!current.isRetired(predecessor)) return;
    setReplayVisit((existing) => {
      const candidate =
        existing?.session === session &&
        existing.documentId === documentId &&
        existing.onClose === onClose
          ? existing
          : sourceVisit;
      if (candidate !== predecessor) return existing;
      return Object.freeze({
        session: predecessor.session,
        documentId: predecessor.documentId,
        onClose: predecessor.onClose,
        predecessor,
      });
    });
  }, [current, documentId, onClose, session, sourceVisit]);

  const clearCadence = useCallback((operation: CadenceOperation) => {
    if (clearedCadences.has(operation)) return;
    clearedCadences.add(operation);
    clearInterval(operation.timer);
  }, [clearedCadences]);

  const retireVisit = useCallback(
    (owner: ActivityVisit) => {
      const cadence = current.retireVisit(owner);
      if (cadence) clearCadence(cadence);
    },
    [clearCadence, current],
  );

  const ownsVisit = useCallback(
    (owner: ActivityVisit) => current.ownsVisit(owner),
    [current],
  );
  const ownsRefresh = useCallback(
    (operation: RefreshOperation) => current.ownsRefresh(operation),
    [current],
  );
  const ownsLoadMoreRequest = useCallback(
    (operation: LoadMoreOperation) => current.ownsLoadMoreRequest(operation),
    [current],
  );
  const ownsLoadMoreSettlement = useCallback(
    (operation: LoadMoreOperation) => current.ownsLoadMoreSettlement(operation),
    [current],
  );

  // Reload the first page; older pages the user has already expanded are kept below it.
  const refresh = useCallback((owner: ActivityVisit, isRetry = false) => {
    if (!ownsVisit(owner) || current.hasRefresh(owner)) return;
    const operation = Object.freeze({
      visit: owner,
      id: current.nextRefreshId(),
    });
    current.publishRefresh(operation);
    if (isRetry) setRetrying(true);
    requestPublicationRevision();

    void (async () => {
      try {
        const page = await api.documents.activity(owner.documentId, { limit: PAGE });
        if (!ownsRefresh(operation)) return;
        setItems((prev) => {
          if (!prev || !current.isExpanded(owner)) return page.items;
          const seen = new Set(page.items.map((i) => i.id));
          return [...page.items, ...prev.filter((i) => !seen.has(i.id))];
        });
        if (!current.isExpanded(owner)) {
          if (current.retireLoadMoreForCursor(owner, page.nextBefore)) {
            setLoadingMore(false);
          }
          current.publishCursor(owner, page.nextBefore);
          setNextBefore(page.nextBefore);
        }
        setListError(null);
        setNow(Date.now());
      } catch (e) {
        if (!ownsRefresh(operation)) return;
        setListError(apiErrorText(e, "Failed to load activity"));
      } finally {
        if (!ownsRefresh(operation)) return;
        current.retireRefresh(operation);
        if (isRetry) setRetrying(false);
        requestPublicationRevision();
      }
    })();
  }, [current, ownsRefresh, ownsVisit, requestPublicationRevision]);

  const loadMore = useCallback((owner: ActivityVisit, cursor: string) => {
    if (
      !ownsVisit(owner) ||
      current.cursor(owner) !== cursor ||
      current.hasLoadMore(owner)
    ) {
      return;
    }
    const operation = Object.freeze({
      visit: owner,
      id: current.nextLoadMoreId(),
      cursor,
    });
    current.publishLoadMore(operation);
    setLoadingMore(true);

    void (async () => {
      try {
        const page = await api.documents.activity(owner.documentId, { before: cursor, limit: PAGE });
        if (!ownsLoadMoreSettlement(operation)) return;
        setItems((prev) => {
          const seen = new Set((prev ?? []).map((i) => i.id));
          return [...(prev ?? []), ...page.items.filter((i) => !seen.has(i.id))];
        });
        current.publishCursor(owner, page.nextBefore);
        setNextBefore(page.nextBefore);
        current.markExpanded(owner);
        setError(null);
      } catch (e) {
        if (!ownsLoadMoreSettlement(operation)) return;
        setError(apiErrorText(e, "Failed to load more"));
      } finally {
        if (!ownsLoadMoreRequest(operation)) return;
        current.retireLoadMore(operation);
        setLoadingMore(false);
      }
    })();
  }, [current, ownsLoadMoreRequest, ownsLoadMoreSettlement, ownsVisit]);

  const startVisit = useCallback((owner: ActivityVisit) => {
    if (!current.startVisit(owner)) return;
    const timer = setInterval(() => {
      refresh(owner);
    }, REFRESH_MS);
    current.publishCadence(owner, Object.freeze({ visit: owner, timer }));
    refresh(owner);
    requestPublicationRevision();
  }, [current, refresh, requestPublicationRevision]);

  useLayoutEffect(() => {
    const activation = current.activateVisit(visit);
    if (!activation) return undefined;
    setStateVisit(visit);
    setItems(null);
    setNextBefore(null);
    setError(null);
    setListError(null);
    setRetrying(false);
    setLoadingMore(false);
    setNow(Date.now());
    if (activation === "replacement" && visit.predecessor === null) {
      startVisit(visit);
    }

    return () => retireVisit(visit);
  }, [current, retireVisit, startVisit, visit]);

  const stateVisitMatches =
    stateVisit === visit ||
    stateVisit === visit.predecessor ||
    (stateVisit.predecessor === null &&
      visit.predecessor === null &&
      stateVisit.session === visit.session &&
      stateVisit.documentId === visit.documentId &&
      stateVisit.onClose === visit.onClose);
  const presentationStateVisit = stateVisitMatches ? visit : stateVisit;
  const presentation = createActivityPresentation(mount, visit, {
    stateVisit: presentationStateVisit,
    items,
    nextBefore,
    error,
    listError,
    retrying,
    loadingMore,
    now,
    cadence: current.cadence(visit),
    refresh: current.refresh(visit),
    loadMore: current.loadMore(visit),
  });
  const publicationSet = createActivityPublication({
    presentation,
    coordinator,
    current,
    retireVisit,
    refresh,
    requestMore: loadMore,
    startVisit,
    requestPublicationSuccessor: requestPublicationRevision,
    requestVisitSuccessor,
  });
  const {
    establish,
    capturePanel,
    captureHeader,
    captureRefresh,
    captureClose,
    captureScroll,
    captureContent,
    captureListError,
    captureRetry,
    capturePageError,
    captureGroup,
    captureRow,
    captureLoadMore,
    manualRefresh,
    close,
    retry,
    loadMore: requestMore,
    navigateFromRefresh,
    navigateFromClose,
    navigateCaptureFromRefresh,
    navigateCaptureFromClose,
    navigateCaptureFromHeader,
    navigateFromHeader,
  } = publicationSet;

  useLayoutEffect(() => establish(), [establish]);

  return (
    <aside ref={capturePanel} className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2" data-testid="activity-panel">
      <div ref={captureHeader} className="flex h-12 items-center justify-between border-b border-line pl-4 pr-2" onKeyDownCapture={navigateCaptureFromHeader} onKeyDown={navigateFromHeader}>
        <span className="pane-label">Activity</span>
        {presentation.refreshAvailable && (
          <button
            ref={captureRefresh}
            type="button"
            className="icon-btn ml-auto h-8 w-8"
            onClick={manualRefresh}
            onKeyDownCapture={navigateCaptureFromRefresh}
            onKeyDown={navigateFromRefresh}
            disabled={presentation.refreshing}
            aria-label={
              presentation.refreshing
                ? "Refreshing activity"
                : "Refresh activity"
            }
          >
            <RefreshCw
              size={15}
              className={cn(presentation.refreshing && "animate-spin")}
            />
          </button>
        )}
        <button ref={captureClose} type="button" className="icon-btn h-8 w-8" onClick={close} onKeyDownCapture={navigateCaptureFromClose} onKeyDown={navigateFromClose} aria-label="Close activity">
          <X size={16} />
        </button>
      </div>
      <div ref={captureScroll} className="scrollbar-thin flex-1 overflow-y-auto p-3">
        <div ref={captureContent}>
          {presentation.listError && (
            <div ref={captureListError} className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
              <div>{presentation.listError}</div>
              <button ref={captureRetry} type="button" className="btn btn-outline btn-sm mt-2 gap-1.5" onClick={retry} disabled={presentation.retrying || presentation.refreshing}>
                {presentation.retrying && <Loader2 size={13} className="animate-spin" />}
                {presentation.retrying ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}
          {presentation.error && <div ref={capturePageError} className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40">{presentation.error}</div>}
          {presentation.contentMode === "loading" ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : presentation.contentMode === "empty" ? (
            <EmptyState icon={<ActivityIcon size={28} />} title="No activity yet">
              Edits, comments, versions and shares by people and agents show up here.
            </EmptyState>
          ) : presentation.contentMode === "list" ? (
            <>
              {presentation.groups.map((group, groupIndex) => (
                <div ref={captureGroup(groupIndex)} key={group.day} className="mb-4">
                  <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-4">{group.day}</div>
                  <ul className="flex flex-col gap-1">
                    {group.rows.map(({ item, index }) => (
                      <li
                        ref={captureRow(index)}
                        key={item.id}
                        className="flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-surface"
                        data-testid="activity-row"
                        data-action={item.action}
                        data-actor-kind={item.actorKind}
                      >
                        <ActorAvatar item={item} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-1.5 text-[13px] leading-5 text-ink-2">
                            <span className="font-medium text-ink">{item.actorName}</span>
                            {item.actorKind === "agent" && (
                              <span className="rounded bg-violet-100 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-violet-700" data-testid="activity-agent-chip">
                                agent
                              </span>
                            )}
                            <span className="break-words">{describeActivity(item)}</span>
                          </div>
                          <div className="mt-0.5 text-xs text-ink-3">
                            <time dateTime={item.createdAt} title={formatDateTime(item.createdAt)}>
                              {relativeTime(item.createdAt, presentation.now)}
                            </time>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {presentation.nextBefore && (
                <button ref={captureLoadMore} type="button" className={cn("btn btn-sm btn-ghost w-full justify-center gap-1.5")} onClick={requestMore} disabled={presentation.loadingMore} data-testid="activity-load-more">
                  {presentation.loadingMore && <Loader2 size={13} className="animate-spin" />}
                  Load more
                </button>
              )}
            </>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
