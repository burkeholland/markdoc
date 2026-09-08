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
  session: CollabSession;
  documentId: string;
  onClose: () => void;
};

type CadenceOperation = {
  visit: ActivityVisit;
  timer: ReturnType<typeof setInterval>;
  cleared: boolean;
};

type RefreshOperation = {
  visit: ActivityVisit;
  id: number;
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
  readonly presentation: ActivityPresentation;
  readonly retire: () => boolean;
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
  readonly publish: (snapshot: ActivityDomSnapshot) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
}

interface ActivityDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly ActivityDomSnapshot[];
}

class ActivityPublicationCoordinator {
  #active: ActivityPublication | null = null;
  #successorOf: ActivityPublication | null = null;
  #claimedEvents = new WeakSet<Event>();

  active() {
    return this.#active;
  }

  publish(publication: ActivityPublication) {
    this.#active = publication;
    this.#successorOf = null;
  }

  retire(publication: ActivityPublication) {
    if (this.#active !== publication) return;
    this.#active = null;
    this.#successorOf = publication;
  }

  acceptsSuccessorOf(publication: ActivityPublication) {
    return this.#active === null && this.#successorOf === publication;
  }

  hasClaimed(event: Event) {
    return this.#claimedEvents.has(event);
  }

  claim(event: Event) {
    this.#claimedEvents.add(event);
  }
}

class ActivityCurrent {
  #activeVisit: ActivityVisit | null = null;
  #retiredVisits = new WeakSet<ActivityVisit>();
  #cadenceOperations = new Map<ActivityVisit, CadenceOperation>();
  #refreshOperations = new Map<ActivityVisit, RefreshOperation>();
  #loadMoreOperations = new Map<ActivityVisit, LoadMoreOperation>();
  #cursors = new Map<ActivityVisit, string | null>();
  #expandedVisits = new WeakSet<ActivityVisit>();
  #refreshSequence = 0;
  #loadMoreSequence = 0;

  activateVisit(visit: ActivityVisit) {
    this.#retiredVisits.delete(visit);
    this.#activeVisit = visit;
    this.#cursors.set(visit, null);
    this.#expandedVisits.delete(visit);
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

  publishCadence(visit: ActivityVisit, operation: CadenceOperation) {
    this.#cadenceOperations.set(visit, operation);
  }

  hasRefresh(visit: ActivityVisit) {
    return this.#refreshOperations.has(visit);
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

class ActivityElementOwner<T extends HTMLElement> {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly onChange: (
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
    this.onChange(element, previous, last);
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

function createActivityPublication({
  presentation,
  coordinator,
  current,
  retireVisit,
  refresh,
  requestMore,
  requestSuccessor,
}: {
  presentation: ActivityPresentation;
  coordinator: ActivityPublicationCoordinator;
  current: ActivityCurrent;
  retireVisit: (visit: ActivityVisit) => void;
  refresh: (visit: ActivityVisit, isRetry: boolean) => void;
  requestMore: (visit: ActivityVisit, cursor: string) => void;
  requestSuccessor: () => void;
}): ActivityPublicationSet {
  let layoutPassed = false;
  let currentRuntime: ActivityPublicationRuntime | null = null;
  let lastRuntime: ActivityPublicationRuntime | null = null;
  let successorRequested = false;
  const claimedActions = new Set<ActivityActionKind>();
  const retireForElementChange = (
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    if (element === null || (layoutPassed && element !== previous) || (element && last && element !== last)) {
      currentRuntime?.retireForElement();
    }
    // Strict Mode can replay a newly mounted callback ref after layout effects.
    const runtime = lastRuntime;
    if (
      !successorRequested &&
      runtime?.isExactElementReplay() &&
      coordinator.acceptsSuccessorOf(runtime.publication) &&
      factsAreCurrent() &&
      exactDomIsCurrent()
    ) {
      successorRequested = true;
      requestSuccessor();
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

  const factsAreCurrent = () => {
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
      current.ownsVisit(visit) &&
      current.cursor(visit) === presentation.nextBefore &&
      current.hasLoadMore(visit) === presentation.loadingMore
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

  const claim = (
    kind: ActivityActionKind,
    event: ReactMouseEvent<HTMLButtonElement>,
  ): ActivityPublication | null => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    if (
      !runtime ||
      !publication ||
      runtime.isRetired() ||
      !event ||
      typeof event !== "object" ||
      claimedActions.has(kind)
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
      coordinator.active() !== publication ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches() ||
      coordinator.hasClaimed(nativeEvent)
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
    coordinator.claim(nativeEvent);
    claimedActions.add(kind);
    return publication;
  };

  const createRuntime = (): ActivityPublicationRuntime => {
    type Retirement = "element" | "layout" | "other";
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let domSnapshot: ActivityDomSnapshot | null = null;
    const retire = (reason: Retirement) => {
      if (retired) return false;
      retired = true;
      retirement = reason;
      coordinator.retire(publication);
      if (currentRuntime?.publication === publication) currentRuntime = null;
      return true;
    };
    const publication: ActivityPublication = Object.freeze({
      presentation,
      retire: () => retire("other"),
    });
    const publishedDomMatches = () => {
      const panelElement = panel.element();
      return Boolean(
        domSnapshot &&
        panelElement &&
        panelElement === domSnapshot.node &&
        panelElement.isConnected &&
        activityDomMatches(domSnapshot)
      );
    };
    const runtime: ActivityPublicationRuntime = Object.freeze({
      publication,
      publish: (snapshot: ActivityDomSnapshot) => {
        established = true;
        domSnapshot = snapshot;
        coordinator.publish(publication);
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        retire("layout");
      },
      isRetired: () => retired,
      publishedDomMatches,
      isExactElementReplay: () =>
        retired && retirement === "element" && established && publishedDomMatches(),
      isExactLayoutReplay: () =>
        retired && retirement === "layout" && established && publishedDomMatches(),
    });
    return runtime;
  };

  return Object.freeze({
    establish: () => {
      layoutPassed = true;
      if (
        (lastRuntime && !lastRuntime.isExactLayoutReplay()) ||
        !factsAreCurrent() ||
        !exactDomIsCurrent()
      ) {
        return undefined;
      }
      const panelElement = panel.element();
      if (!panelElement) return undefined;
      const runtime = createRuntime();
      const publication = runtime.publication;
      const previous = coordinator.active();
      if (previous && previous !== publication) previous.retire();
      currentRuntime = runtime;
      lastRuntime = runtime;
      runtime.publish(snapshotActivityDom(panelElement));
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
  const visit = useMemo<ActivityVisit>(
    () => Object.freeze({
      session,
      documentId,
      onClose,
    }),
    [session, documentId, onClose],
  );
  const [mount] = useState(() => Symbol("activity-panel"));
  const [coordinator] = useState(() => new ActivityPublicationCoordinator());
  const [current] = useState(() => new ActivityCurrent());
  const [, setPublicationRevision] = useState(0);
  const [stateVisit, setStateVisit] = useState(visit);
  const [items, setItems] = useState<ActivityItemDto[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);

  const clearCadence = useCallback((operation: CadenceOperation) => {
    if (operation.cleared) return;
    operation.cleared = true;
    clearInterval(operation.timer);
  }, []);

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
    const operation = { visit: owner, id: current.nextRefreshId() };
    current.publishRefresh(operation);
    if (isRetry) setRetrying(true);

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
      }
    })();
  }, [current, ownsRefresh, ownsVisit]);

  const loadMore = useCallback((owner: ActivityVisit, cursor: string) => {
    if (
      !ownsVisit(owner) ||
      current.cursor(owner) !== cursor ||
      current.hasLoadMore(owner)
    ) {
      return;
    }
    const operation = { visit: owner, id: current.nextLoadMoreId(), cursor };
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

  useLayoutEffect(() => {
    current.activateVisit(visit);

    setStateVisit(visit);
    setItems(null);
    setNextBefore(null);
    setError(null);
    setListError(null);
    setRetrying(false);
    setLoadingMore(false);
    setNow(Date.now());

    const timer = setInterval(() => {
      refresh(visit);
    }, REFRESH_MS);
    current.publishCadence(visit, { visit, timer, cleared: false });
    refresh(visit);

    return () => retireVisit(visit);
  }, [current, refresh, retireVisit, visit]);

  const presentation = createActivityPresentation(mount, visit, {
    stateVisit,
    items,
    nextBefore,
    error,
    listError,
    retrying,
    loadingMore,
    now,
  });
  const publicationSet = createActivityPublication({
    presentation,
    coordinator,
    current,
    retireVisit,
    refresh,
    requestMore: loadMore,
    requestSuccessor: requestPublicationSuccessor,
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
