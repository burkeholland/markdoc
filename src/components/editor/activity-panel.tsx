"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Activity as ActivityIcon, Bot, Loader2, X } from "lucide-react";
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
type ActivityActionKind = "close" | "retry" | "load-more";

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
  readonly retrying: boolean;
  readonly loadingMore: boolean;
  readonly now: number;
  readonly groups: readonly ActivityGroupFacts[];
  readonly contentMode: ActivityContentMode;
}

interface ActivityPublication {
  readonly identity: symbol;
  readonly presentation: ActivityPresentation;
  readonly ownerDocument: Document;
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
  readonly captureClose: (element: HTMLButtonElement | null) => void;
  readonly captureScroll: (element: HTMLDivElement | null) => void;
  readonly captureContent: (element: HTMLDivElement | null) => void;
  readonly captureListError: (element: HTMLDivElement | null) => void;
  readonly captureRetry: (element: HTMLButtonElement | null) => void;
  readonly capturePageError: (element: HTMLDivElement | null) => void;
  readonly captureGroup: (index: number) => (element: HTMLDivElement | null) => void;
  readonly captureRow: (index: number) => (element: HTMLLIElement | null) => void;
  readonly captureLoadMore: (element: HTMLButtonElement | null) => void;
  readonly close: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly retry: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly loadMore: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

interface ActivityPublicationRuntime {
  readonly publication: ActivityPublication;
  readonly publish: () => boolean;
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
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
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
    event: object,
    nativeEvent: Event,
  ) {
    return (
      this.#claimedVisits.get(visit) === publication ||
      this.#claimedPublications.has(publication) ||
      this.#claimedActions.has(action) ||
      this.#claimedEvents.has(event) ||
      this.#claimedEvents.has(nativeEvent)
    );
  }

  claim(
    visit: ActivityVisit,
    publication: ActivityPublication,
    action: ActivityAction,
    event: object,
    nativeEvent: Event,
  ) {
    if (
      !this.isCurrent(publication) ||
      this.hasClaimed(visit, publication, action, event, nativeEvent)
    ) {
      return false;
    }
    this.#claimedVisits.set(visit, publication);
    this.#claimedPublications.add(publication);
    this.#claimedActions.add(action);
    this.#claimedEvents.add(event);
    this.#claimedEvents.add(nativeEvent);
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
  const parent = node.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: node.ownerDocument,
    parent,
    previousSibling: node.previousSibling,
    nextSibling: node.nextSibling,
  });
}

function activityPlacementMatches(node: HTMLElement, placement: ActivityPlacement) {
  return (
    node.ownerDocument === placement.document &&
    node.parentNode === placement.parent &&
    node.previousSibling === placement.previousSibling &&
    node.nextSibling === placement.nextSibling
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
       if (record.type !== "childList" || record.target !== placement.parent) {
         return false;
       }
       if (
         record.previousSibling === root ||
         record.nextSibling === root
       ) {
         return true;
       }
       return [...record.addedNodes, ...record.removedNodes].some(
         (node) =>
           node === root ||
           (node.nodeType === 1 && (node as Element).contains(root)),
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
    retry: Object.freeze({ identity: Symbol("activity-retry"), kind: "retry" }),
    "load-more": Object.freeze({
      identity: Symbol("activity-load-more"),
      kind: "load-more",
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

  const exactDomIsCurrent = () => {
    const panelElement = panel.element();
    const headerElement = header.element();
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
      headerElement.children.length !== 2 ||
      headerElement.children.item(1) !== closeElement ||
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
        retryElement.disabled !== presentation.retrying ||
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
    kind: ActivityActionKind,
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
        event,
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
    const placement = panelElement
      ? captureActivityPlacement(panelElement)
      : null;
    if (!panelElement || !placement) return null;
    const dom = snapshotActivityDom(panelElement);
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let invalidReplay = false;
    let replayRefs: ActivityRefReplay[] = [];
    let domGuard: ActivityDomGuard | null = null;
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
    const retire = (reason: Retirement) => {
      if (retired) return false;
      retired = true;
      retirement = reason;
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
        return true;
      },
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
    captureClose: close.capture,
    captureScroll: scroll.capture,
    captureContent: content.capture,
    captureListError: listError.capture,
    captureRetry: retry.capture,
    capturePageError: pageError.capture,
    captureGroup: (index: number) => groups[index]?.capture ?? (() => {}),
    captureRow: (index: number) => rows[index]?.capture ?? (() => {}),
    captureLoadMore: loadMore.capture,
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
    captureClose,
    captureScroll,
    captureContent,
    captureListError,
    captureRetry,
    capturePageError,
    captureGroup,
    captureRow,
    captureLoadMore,
    close,
    retry,
    loadMore: requestMore,
  } = publicationSet;

  useLayoutEffect(() => establish(), [establish]);

  return (
    <aside ref={capturePanel} className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2" data-testid="activity-panel">
      <div ref={captureHeader} className="flex h-12 items-center justify-between border-b border-line pl-4 pr-2">
        <span className="pane-label">Activity</span>
        <button ref={captureClose} type="button" className="icon-btn h-8 w-8" onClick={close} aria-label="Close activity">
          <X size={16} />
        </button>
      </div>
      <div ref={captureScroll} className="scrollbar-thin flex-1 overflow-y-auto p-3">
        <div ref={captureContent}>
          {presentation.listError && (
            <div ref={captureListError} className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
              <div>{presentation.listError}</div>
              <button ref={captureRetry} type="button" className="btn btn-outline btn-sm mt-2 gap-1.5" onClick={retry} disabled={presentation.retrying}>
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
