"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { AtSign, Bell, Bot, CheckCheck, CircleCheck, ClipboardCheck, Reply, RotateCcw, ThumbsDown, ThumbsUp, UserPlus, WebhookOff } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/primitives";
import { RelativeTime } from "@/components/ui/relative-time";
import type { NotificationDto } from "@/lib/api";
import type { NotificationKind } from "@/server/db/schema";
import {
  markAllNotificationsRead,
  markNotificationRead,
  refreshNotifications,
  retryNotificationRead,
  useNotifications,
  sentence,
  type NotificationReadError,
} from "@/lib/notifications-store";
import { cn } from "@/lib/utils";

const ICONS: Record<NotificationKind, React.ComponentType<{ size?: number; className?: string }>> = {
  mention: AtSign,
  reply: Reply,
  resolve: CircleCheck,
  reopen: RotateCcw,
  "suggestion.accept": ThumbsUp,
  "suggestion.reject": ThumbsDown,
  "suggestion.accepted": CheckCheck,
  review: ClipboardCheck,
  share: UserPlus,
  "request.done": Bot,
  "webhook.disabled": WebhookOff,
};

export function KindIcon({ kind, size = 14, className }: { kind: NotificationKind; size?: number; className?: string }) {
  const Icon = ICONS[kind];
  return <Icon size={size} className={className} />;
}

export function actorLabel(n: Pick<NotificationDto, "actorName" | "actorLogin">): string {
  return n.actorName ?? (n.actorLogin ? `@${n.actorLogin}` : "Someone");
}

export interface NotificationsBellProps {
  /** Document currently open, so same-document items can be opened in place. */
  currentDocId?: string;
  /** Called after the item is marked read; the caller navigates or opens the thread. */
  onOpen: (n: NotificationDto) => void;
  /** False while the page is still opening: the bell renders without fetching or polling yet. */
  ready?: boolean;
}

type NotificationState = ReturnType<typeof useNotifications>;
type BellElementRole = "trigger" | "content" | "root" | "list";
type BellActionKind = "read-retry" | "load-retry" | "read-all" | "row";
type BellLayoutDomain = "trigger" | "portal";
type BellRetirement = "element" | "layout" | "mutation" | "other";

interface NotificationBellVisit {
  identity: symbol;
  currentDocId: string | undefined;
  onOpen: (notification: NotificationDto) => void;
  ready: boolean;
}

interface NotificationDisclosureAuthority {
  identity: symbol;
  visit: NotificationBellVisit;
}

interface NotificationDisclosureState {
  visit: NotificationBellVisit;
  authority: NotificationDisclosureAuthority | null;
  open: boolean;
}

interface NotificationPresentation {
  triggerLabel: string;
  badgeText: string | null;
  unreadLabel: string | null;
  readRetryLabel: string | null;
  loadRetryLabel: string | null;
  readAllLabel: string;
}

interface NotificationFacts {
  ready: boolean;
  unreadCount: number;
  loaded: boolean;
  loading: boolean;
  loadError: boolean;
  readAllPending: boolean;
  readError: NotificationReadError | null;
  readErrorPending: boolean;
  rows: readonly NotificationDto[];
  presentation: NotificationPresentation;
}

interface BellElements {
  trigger: HTMLButtonElement | null;
  content: HTMLDivElement | null;
  root: HTMLDivElement | null;
  list: HTMLUListElement | null;
}

interface NotificationAction {
  identity: symbol;
  publication: NotificationPublication;
  kind: BellActionKind;
  enabled: boolean;
  rowIndex: number | null;
  element: HTMLButtonElement | null;
  claimed: boolean;
}

interface NotificationPublication {
  identity: symbol;
  visit: NotificationBellVisit;
  disclosure: NotificationDisclosureAuthority | null;
  open: boolean;
  source: NotificationState;
  facts: NotificationFacts;
  elements: BellElements;
  readRetry: NotificationAction | null;
  loadRetry: NotificationAction | null;
  readAll: NotificationAction | null;
  rows: readonly NotificationAction[];
  retired: boolean;
  retirement: BellRetirement | null;
  established: boolean;
  consumed: boolean;
  layoutEstablished: Set<BellLayoutDomain>;
  layoutRetired: Set<BellLayoutDomain>;
  invalidReplay: Set<BellLayoutDomain>;
  replayRefs: BellRefReplay[];
  triggerDom: BellDomSnapshot | null;
  triggerPlacement: BellPlacement | null;
  contentDom: BellDomSnapshot | null;
  contentPlacement: BellPlacement | null;
  domGuard: BellDomGuard | null;
  successorRequested: boolean;
  rowClaimed: boolean;
  requestSuccessor: () => void;
  current: NotificationBellCurrent;
}

interface BellElementOwner {
  publication: NotificationPublication;
  publicationIdentity: symbol;
  role: BellElementRole | "action";
  action?: NotificationAction;
  actionIdentity?: symbol;
}

interface DisclosureProof {
  publication: NotificationPublication;
  nextOpen: boolean;
  event: Event;
}

interface BellDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly BellDomSnapshot[];
}

interface BellPlacement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface BellDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface BellReplay {
  readonly source: NotificationPublication;
  readonly triggerDom: BellDomSnapshot;
  readonly triggerPlacement: BellPlacement;
  readonly contentDom: BellDomSnapshot | null;
  readonly contentPlacement: BellPlacement | null;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface BellRefReplay {
  readonly key: BellElementRole | NotificationAction;
  readonly domain: BellLayoutDomain;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

type OutsideInteractionEvent = CustomEvent<{ originalEvent: Event }>;

function freezeNotification(notification: NotificationDto): NotificationDto {
  return Object.freeze({
    id: notification.id,
    kind: notification.kind,
    documentId: notification.documentId,
    documentTitle: notification.documentTitle,
    actorLogin: notification.actorLogin,
    actorName: notification.actorName,
    refId: notification.refId,
    snippet: notification.snippet,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
  });
}

function freezeReadError(error: NotificationReadError | null): NotificationReadError | null {
  if (!error) return null;
  if (error.operation === "single") {
    return Object.freeze({
      id: error.id,
      operationId: error.operationId,
      operation: error.operation,
      message: error.message,
      notificationId: error.notificationId,
    });
  }
  if (error.operation === "refs") {
    const refIds = [...error.refIds];
    Object.freeze(refIds);
    return Object.freeze({
      id: error.id,
      operationId: error.operationId,
      operation: error.operation,
      message: error.message,
      documentId: error.documentId,
      refIds,
    });
  }
  return Object.freeze({
    id: error.id,
    operationId: error.operationId,
    operation: error.operation,
    message: error.message,
  });
}

function createFacts(source: NotificationState, ready: boolean): NotificationFacts {
  const rows = source.items.map(freezeNotification);
  Object.freeze(rows);
  const readError = freezeReadError(source.readError);
  const presentation = Object.freeze({
    triggerLabel: source.unreadCount > 0 ? `Notifications, ${source.unreadCount} unread` : "Notifications",
    badgeText: source.unreadCount > 0 ? (source.unreadCount > 9 ? "9+" : String(source.unreadCount)) : null,
    unreadLabel: source.unreadCount > 0 ? `${source.unreadCount} unread` : null,
    readRetryLabel: readError ? (source.readErrorPending ? "Retrying…" : "Retry") : null,
    loadRetryLabel: !source.loaded && source.loadError ? (source.loading ? "Retrying…" : "Retry") : null,
    readAllLabel: source.readAllPending ? "Marking all…" : "Mark all read",
  });
  return Object.freeze({
    ready,
    unreadCount: source.unreadCount,
    loaded: source.loaded,
    loading: source.loading,
    loadError: source.loadError,
    readAllPending: source.readAllPending,
    readError,
    readErrorPending: source.readErrorPending,
    rows,
    presentation,
  });
}

function notificationsMatch(source: readonly NotificationDto[], rows: readonly NotificationDto[]) {
  return source.length === rows.length && source.every((notification, index) => {
    const row = rows[index];
    return Boolean(
      row &&
      notification.id === row.id &&
      notification.kind === row.kind &&
      notification.documentId === row.documentId &&
      notification.documentTitle === row.documentTitle &&
      notification.actorLogin === row.actorLogin &&
      notification.actorName === row.actorName &&
      notification.refId === row.refId &&
      notification.snippet === row.snippet &&
      notification.createdAt === row.createdAt &&
      notification.readAt === row.readAt
    );
  });
}

function errorsMatch(source: NotificationReadError | null, frozen: NotificationReadError | null) {
  if (!source || !frozen) return source === frozen;
  if (
    source.id !== frozen.id ||
    source.operationId !== frozen.operationId ||
    source.operation !== frozen.operation ||
    source.message !== frozen.message
  ) {
    return false;
  }
  if (source.operation === "single" && frozen.operation === "single") {
    return source.notificationId === frozen.notificationId;
  }
  if (source.operation === "refs" && frozen.operation === "refs") {
    return (
      source.documentId === frozen.documentId &&
      source.refIds.length === frozen.refIds.length &&
      source.refIds.every((refId, index) => refId === frozen.refIds[index])
    );
  }
  return source.operation === "all" && frozen.operation === "all";
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotBellDom(node: Node): BellDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotBellDom)),
  });
}

function bellDomMatches(snapshot: BellDomSnapshot): boolean {
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
        node.childNodes.item(index) === child.node && bellDomMatches(child),
    )
  );
}

function captureBellPlacement(element: HTMLElement): BellPlacement | null {
  const parent = element.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: element.ownerDocument,
    parent,
    previousSibling: element.previousSibling,
    nextSibling: element.nextSibling,
  });
}

function bellPlacementMatches(element: HTMLElement, placement: BellPlacement) {
  return (
    element.ownerDocument === placement.document &&
    element.parentNode === placement.parent &&
    element.previousSibling === placement.previousSibling &&
    element.nextSibling === placement.nextSibling
  );
}

function createBellDomGuard(
  roots: readonly HTMLElement[],
  placements: readonly BellPlacement[],
  onMutation: () => void,
): BellDomGuard | null {
  const document = placements[0]?.document;
  const MutationObserverConstructor = document?.defaultView?.MutationObserver;
  if (!document || !MutationObserverConstructor) return null;
  let changed = false;
  const relevant = (record: MutationRecord) => {
    if (roots.some((root) => record.target === root || root.contains(record.target))) {
      return true;
    }
    if (
      record.type === "attributes" &&
      (record.attributeName === "inert" ||
        record.attributeName === "aria-disabled" ||
        record.attributeName === "disabled") &&
      roots.some(
        (root) =>
          record.target instanceof Element &&
          record.target.contains(root),
      )
    ) {
      return true;
    }
    if (record.type !== "childList") return false;
    return roots.some((root, index) => {
      const placement = placements[index];
      if (!placement) return false;
      if (
        record.target === placement.parent &&
        (record.previousSibling === root || record.nextSibling === root)
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
  const record = (records: readonly MutationRecord[]) => {
    if (!changed && records.some(relevant)) {
      changed = true;
      onMutation();
    }
  };
  const observer = new MutationObserverConstructor(record);
  observer.observe(document, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  return Object.freeze({
    isClean: () => {
      record(observer.takeRecords());
      return !changed;
    },
    release: () => {
      record(observer.takeRecords());
      observer.disconnect();
    },
  });
}

function isNodeFromDocument(value: EventTarget | null, document: Document): value is Node {
  const NodeConstructor = document.defaultView?.Node;
  return Boolean(
    NodeConstructor &&
      value instanceof NodeConstructor &&
      value.ownerDocument === document,
  );
}

function isOwnerPointerEvent(
  event: Event,
  ownerWindow: Window & typeof globalThis,
): event is MouseEvent {
  const PointerEventConstructor = ownerWindow.PointerEvent;
  return PointerEventConstructor
    ? event instanceof PointerEventConstructor
    : event instanceof ownerWindow.MouseEvent;
}

function isEffectivelyEnabled(element: HTMLElement) {
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

class NotificationBellCurrent {
  #visit: NotificationBellVisit | null = null;
  #disclosure: NotificationDisclosureAuthority | null = null;

  publishVisit(visit: NotificationBellVisit) {
    this.#visit = visit;
  }

  retireVisit(visit: NotificationBellVisit) {
    if (this.#visit === visit) this.#visit = null;
    if (this.#disclosure?.visit === visit) this.#disclosure = null;
  }

  ownsVisit(visit: NotificationBellVisit) {
    return this.#visit === visit;
  }

  disclosure() {
    return this.#disclosure;
  }

  publishDisclosure(disclosure: NotificationDisclosureAuthority) {
    if (this.#visit !== disclosure.visit || this.#disclosure) return false;
    this.#disclosure = disclosure;
    return true;
  }

  retireDisclosure(disclosure: NotificationDisclosureAuthority) {
    if (this.#visit !== disclosure.visit || this.#disclosure !== disclosure) return false;
    this.#disclosure = null;
    return true;
  }

  ownsDisclosure(disclosure: NotificationDisclosureAuthority | null) {
    return disclosure !== null && this.#visit === disclosure.visit && this.#disclosure === disclosure;
  }

  clear() {
    this.#visit = null;
    this.#disclosure = null;
  }
}

class NotificationPublicationCoordinator {
  #current: NotificationPublication | null = null;
  #successorOf: NotificationPublication | null = null;
  #replay: BellReplay | null = null;
  #lease = 0;
  #elementOwners = new WeakMap<HTMLElement, BellElementOwner>();
  #proof: DisclosureProof | null = null;
  #claimedEvents = new WeakSet<Event>();
  #currentOutsideEvents = new WeakMap<Event, Event>();

  beginLease() {
    this.#lease += 1;
    return this.#lease;
  }

  endLease(lease: number) {
    queueMicrotask(() => {
      if (this.#lease !== lease) return;
      this.#current?.domGuard?.release();
      this.#replay?.release();
      this.#current = null;
      this.#successorOf = null;
      this.#replay = null;
      this.#proof = null;
    });
  }

  bindElement<Role extends BellElementRole>(
    publication: NotificationPublication,
    role: Role,
    element: BellElements[Role],
  ) {
    const previous = publication.elements[role];
    if (publication.established) {
      const replayAccepted = this.noteRef(publication, role, element, previous);
      if (!element) {
        this.releaseElementOwner(publication, role, previous);
        publication.elements[role] = null;
        this.retire(publication, "element");
        this.maybeRequestClosedSuccessor(publication);
        return;
      }
      if (publication.retired) {
        if (replayAccepted) publication.elements[role] = element;
        return;
      }
      if (previous !== element) {
        publication.invalidReplay.add(role === "trigger" ? "trigger" : "portal");
        this.retire(publication, "element");
        return;
      }
    }
    if (!element) {
      this.releaseElementOwner(publication, role, previous);
      publication.elements[role] = null;
      this.maybeRequestClosedSuccessor(publication);
      return;
    }
    this.releaseElementOwner(publication, role, previous);
    this.#elementOwners.set(element, {
      publication,
      publicationIdentity: publication.identity,
      role,
    });
    publication.elements[role] = element;
  }

  bindAction(action: NotificationAction, element: HTMLButtonElement | null) {
    const publication = action.publication;
    const previous = action.element;
    if (publication.established) {
      const replayAccepted = this.noteRef(publication, action, element, previous);
      if (!element) {
        this.releaseActionOwner(publication, action, previous);
        action.element = null;
        this.retire(publication, "element");
        this.maybeRequestClosedSuccessor(publication);
        return;
      }
      if (publication.retired) {
        if (replayAccepted) action.element = element;
        return;
      }
      if (previous !== element) {
        publication.invalidReplay.add("portal");
        this.retire(publication, "element");
        return;
      }
    }
    if (!element) {
      this.releaseActionOwner(publication, action, previous);
      action.element = null;
      this.maybeRequestClosedSuccessor(publication);
      return;
    }
    this.releaseActionOwner(publication, action, previous);
    this.#elementOwners.set(element, {
      publication,
      publicationIdentity: publication.identity,
      role: "action",
      action,
      actionIdentity: action.identity,
    });
    action.element = element;
  }

  releaseElementOwner(
    publication: NotificationPublication,
    role: BellElementRole,
    element: HTMLElement | null,
  ) {
    if (!element) return;
    const owner = this.#elementOwners.get(element);
    if (
      owner?.publication === publication &&
      owner.publicationIdentity === publication.identity &&
      owner.role === role
    ) {
      this.#elementOwners.delete(element);
    }
  }

  releaseActionOwner(
    publication: NotificationPublication,
    action: NotificationAction,
    element: HTMLElement | null,
  ) {
    if (!element) return;
    const owner = this.#elementOwners.get(element);
    if (
      owner?.publication === publication &&
      owner.publicationIdentity === publication.identity &&
      owner.action === action &&
      owner.actionIdentity === action.identity
    ) {
      this.#elementOwners.delete(element);
    }
  }

  noteRef(
    publication: NotificationPublication,
    key: BellElementRole | NotificationAction,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) {
    const proof = publication.replayRefs.find((entry) => entry.key === key);
    const domain = typeof key === "string" && key === "trigger" ? "trigger" : "portal";
    if (!proof) {
      publication.invalidReplay.add(domain);
      return false;
    }
    if (
      element === null &&
      previous === proof.element &&
      proof.element.isConnected &&
      !proof.detached &&
      !proof.reattached
    ) {
      proof.detached = true;
      return true;
    }
    if (
      element === proof.element &&
      previous === null &&
      proof.detached &&
      !proof.reattached &&
      proof.element.isConnected
    ) {
      proof.reattached = true;
      return true;
    }
    if (element !== previous) publication.invalidReplay.add(proof.domain);
    return false;
  }

  maybeRequestClosedSuccessor(publication: NotificationPublication) {
    if (
      publication.open ||
      !publication.visit.ready ||
      publication.established ||
      !publication.layoutEstablished.has("trigger") ||
      publication.elements.content ||
      publication.elements.root ||
      publication.elements.list ||
      publication.readRetry?.element ||
      publication.loadRetry?.element ||
      publication.readAll?.element ||
      publication.rows.some((action) => action.element)
    ) {
      return;
    }
    this.requestSuccessor(publication);
  }

  requestSuccessor(publication: NotificationPublication) {
    if (publication.successorRequested) return;
    publication.successorRequested = true;
    publication.requestSuccessor();
  }

  retire(
    publication: NotificationPublication | null,
    reason: BellRetirement = "other",
    domain?: BellLayoutDomain,
  ) {
    if (!publication) return false;
    if (reason === "layout" && domain) publication.layoutRetired.add(domain);
    if (publication.retired) return false;
    publication.retired = true;
    publication.retirement = reason;
    const wasCurrent = this.#current === publication;
    if (wasCurrent) {
      this.#current = null;
      this.#successorOf = publication;
    }
    if (this.#proof?.publication === publication) this.#proof = null;
    if (reason !== "layout") publication.domGuard?.release();
    if (reason === "mutation" && wasCurrent) this.requestSuccessor(publication);
    if (reason === "layout") {
      queueMicrotask(() => {
        if (this.#replay?.source !== publication) publication.domGuard?.release();
      });
    }
    return wasCurrent;
  }

  retireDisclosure(disclosure: NotificationDisclosureAuthority) {
    if (this.#current?.disclosure === disclosure) this.retire(this.#current, "other");
  }

  factsMatch(publication: NotificationPublication) {
    const { source, facts, visit } = publication;
    return (
      publication.current.ownsVisit(visit) &&
      visit.ready &&
      facts.ready === visit.ready &&
      source.unreadCount === facts.unreadCount &&
      source.loaded === facts.loaded &&
      source.loading === facts.loading &&
      source.loadError === facts.loadError &&
      source.readAllPending === facts.readAllPending &&
      source.readErrorPending === facts.readErrorPending &&
      errorsMatch(source.readError, facts.readError) &&
      notificationsMatch(source.items, facts.rows)
    );
  }

  factsEqual(left: NotificationFacts, right: NotificationFacts) {
    return (
      left.ready === right.ready &&
      left.unreadCount === right.unreadCount &&
      left.loaded === right.loaded &&
      left.loading === right.loading &&
      left.loadError === right.loadError &&
      left.readAllPending === right.readAllPending &&
      left.readErrorPending === right.readErrorPending &&
      errorsMatch(left.readError, right.readError) &&
      notificationsMatch(left.rows, right.rows) &&
      left.presentation.triggerLabel === right.presentation.triggerLabel &&
      left.presentation.badgeText === right.presentation.badgeText &&
      left.presentation.unreadLabel === right.presentation.unreadLabel &&
      left.presentation.readRetryLabel === right.presentation.readRetryLabel &&
      left.presentation.loadRetryLabel === right.presentation.loadRetryLabel &&
      left.presentation.readAllLabel === right.presentation.readAllLabel
    );
  }

  sameGeneration(previous: NotificationPublication, next: NotificationPublication) {
    return (
      previous.visit === next.visit &&
      previous.disclosure === next.disclosure &&
      previous.open === next.open &&
      previous.source === next.source &&
      previous.current === next.current &&
      this.factsEqual(previous.facts, next.facts)
    );
  }

  ownsElement(publication: NotificationPublication, role: BellElementRole, element: HTMLElement) {
    const owner = this.#elementOwners.get(element);
    return (
      owner?.publication === publication &&
      owner.publicationIdentity === publication.identity &&
      owner.role === role &&
      publication.elements[role] === element
    );
  }

  ownsAction(publication: NotificationPublication, action: NotificationAction, element: HTMLButtonElement) {
    const owner = this.#elementOwners.get(element);
    return (
      action.publication === publication &&
      owner?.publication === publication &&
      owner.publicationIdentity === publication.identity &&
      owner.action === action &&
      owner.actionIdentity === action.identity &&
      action.element === element
    );
  }

  triggerMatches(publication: NotificationPublication) {
    const { trigger } = publication.elements;
    if (
      !trigger ||
      !trigger.isConnected ||
      trigger.type !== "button" ||
      !isEffectivelyEnabled(trigger) ||
      !this.ownsElement(publication, "trigger", trigger)
    ) {
      return false;
    }
    const { presentation } = publication.facts;
    const badge = trigger.querySelector<HTMLElement>('[data-testid="notifications-badge"]');
    return (
      trigger.getAttribute("aria-label") === presentation.triggerLabel &&
      trigger.dataset.testid === "notifications-bell" &&
      trigger.dataset.unread === String(publication.facts.unreadCount) &&
      (presentation.badgeText === null
        ? badge === null
        : badge?.textContent === presentation.badgeText && badge.parentElement === trigger)
    );
  }

  actionMatches(publication: NotificationPublication, action: NotificationAction) {
    const { content, root, list, trigger } = publication.elements;
    const element = action.element;
    return Boolean(
      element &&
      content &&
      root &&
      list &&
      trigger &&
      element.isConnected &&
      element.ownerDocument === trigger.ownerDocument &&
      this.ownsAction(publication, action, element) &&
      content.contains(element) &&
      root.contains(element) &&
      element.type === "button" &&
      isEffectivelyEnabled(element) === action.enabled &&
      (action.kind === "read-all"
        ? element.parentElement === root.lastElementChild
        : action.kind === "row"
          ? element.parentElement?.parentElement === list
          : element.parentElement?.parentElement?.parentElement === list) &&
      element.disabled === !action.enabled
    );
  }

  contentMatches(publication: NotificationPublication) {
    const { trigger, content, root, list } = publication.elements;
    if (
      !trigger ||
      !content ||
      !root ||
      !list ||
      !content.isConnected ||
      !root.isConnected ||
      !list.isConnected ||
      content.ownerDocument !== trigger.ownerDocument ||
      root.ownerDocument !== trigger.ownerDocument ||
      list.ownerDocument !== trigger.ownerDocument ||
      !this.ownsElement(publication, "content", content) ||
      !this.ownsElement(publication, "root", root) ||
      !this.ownsElement(publication, "list", list) ||
      root.parentElement !== content ||
      content.children.length !== 1 ||
      content.firstElementChild !== root ||
      list.parentElement !== root ||
      root.children.length !== 3 ||
      root.children[1] !== list ||
      root.firstElementChild?.children.length !==
        (publication.facts.presentation.unreadLabel ? 2 : 1) ||
      root.lastElementChild?.children.length !== 1 ||
      content.dataset.state !== "open" ||
      content.dataset.testid !== "notifications-popover" ||
      !publication.disclosure ||
      !publication.readAll ||
      !publication.current.ownsDisclosure(publication.disclosure)
    ) {
      return false;
    }
    const expectedActions = [
      publication.readRetry,
      publication.loadRetry,
      publication.readAll,
      ...publication.rows,
    ].filter((action): action is NotificationAction => action !== null);
    const elements = new Set<HTMLButtonElement>();
    for (const action of expectedActions) {
      if (!this.actionMatches(publication, action) || !action.element || elements.has(action.element)) return false;
      elements.add(action.element);
    }
    if (
      (!publication.readRetry && content.querySelector('[data-testid="notifications-read-retry"]')) ||
      (!publication.loadRetry && content.querySelector('[data-testid="notifications-load-retry"]'))
    ) {
      return false;
    }
    if (
      publication.readRetry &&
      (publication.readRetry.element?.dataset.testid !== "notifications-read-retry" ||
        publication.readRetry.element.textContent?.trim() !== publication.facts.presentation.readRetryLabel)
    ) {
      return false;
    }
    if (
      publication.loadRetry &&
      (publication.loadRetry.element?.dataset.testid !== "notifications-load-retry" ||
        publication.loadRetry.element.textContent?.trim() !== publication.facts.presentation.loadRetryLabel)
    ) {
      return false;
    }
    if (
      publication.readAll.element?.dataset.testid !== "notifications-read-all" ||
      publication.readAll.element.textContent?.trim() !== publication.facts.presentation.readAllLabel
    ) {
      return false;
    }
    const rowElements = [...list.querySelectorAll<HTMLButtonElement>('[data-testid="notification-item"]')];
    if (rowElements.length !== publication.rows.length) return false;
    if (!publication.rows.every((action, index) => {
      const element = action.element;
      const row = action.rowIndex === null ? null : publication.facts.rows[action.rowIndex];
      return Boolean(
        element &&
        row &&
        rowElements[index] === element &&
        element.parentElement?.parentElement === list &&
        element.dataset.notificationId === row.id &&
        element.dataset.documentId === row.documentId &&
        element.dataset.refId === row.refId &&
        element.dataset.kind === row.kind &&
        element.dataset.unread === String(!row.readAt)
      );
    })) {
      return false;
    }
    const orderedListActions = [
      publication.readRetry?.element,
      publication.loadRetry?.element,
      ...publication.rows.map((action) => action.element),
    ].filter((element): element is HTMLButtonElement => element !== null && element !== undefined);
    const renderedListActions = [
      ...list.querySelectorAll<HTMLButtonElement>(
        '[data-testid="notifications-read-retry"], [data-testid="notifications-load-retry"], [data-testid="notification-item"]',
      ),
    ];
    return (
      orderedListActions.length === renderedListActions.length &&
      orderedListActions.every((element, index) => renderedListActions[index] === element)
    );
  }

  canPublish(publication: NotificationPublication) {
    if (!this.factsMatch(publication) || !this.triggerMatches(publication)) return false;
    const hasContent = publication.elements.content !== null;
    if (publication.open) return hasContent && this.contentMatches(publication);
    if (!hasContent) return true;
    return false;
  }

  publicationDomMatches(publication: NotificationPublication) {
    const { trigger, content } = publication.elements;
    return Boolean(
      publication.domGuard?.isClean() &&
      trigger &&
      publication.triggerDom &&
      publication.triggerPlacement &&
      trigger === publication.triggerDom.node &&
      trigger.isConnected &&
      bellPlacementMatches(trigger, publication.triggerPlacement) &&
      bellDomMatches(publication.triggerDom) &&
      (publication.open
        ? content &&
          publication.contentDom &&
          publication.contentPlacement &&
          content === publication.contentDom.node &&
          content.isConnected &&
          bellPlacementMatches(content, publication.contentPlacement) &&
          bellDomMatches(publication.contentDom)
        : !content && !publication.contentDom && !publication.contentPlacement)
    );
  }

  initializePublication(publication: NotificationPublication) {
    const { trigger, content } = publication.elements;
    const triggerPlacement = trigger ? captureBellPlacement(trigger) : null;
    const contentPlacement = content ? captureBellPlacement(content) : null;
    if (
      !trigger ||
      !triggerPlacement ||
      (publication.open && (!content || !contentPlacement))
    ) {
      return false;
    }
    const roots = publication.open && content ? [trigger, content] : [trigger];
    const placements = publication.open && contentPlacement
      ? [triggerPlacement, contentPlacement]
      : [triggerPlacement];
    const mutationGuard = createBellDomGuard(roots, placements, () => {
      this.retire(publication, "mutation");
    });
    if (!mutationGuard) return false;
    const document = trigger.ownerDocument;
    const ownerWindow = document.defaultView;
    let guardReleased = false;
    let deferredPointerEvent: Event | null = null;
    const activateOutsideEvent = (originalEvent: Event, provenanceEvent: Event) => {
      this.#currentOutsideEvents.set(originalEvent, provenanceEvent);
      queueMicrotask(() => {
        if (this.#currentOutsideEvents.get(originalEvent) === provenanceEvent) {
          this.#currentOutsideEvents.delete(originalEvent);
        }
      });
    };
    const notePointerDown = (event: Event) => {
      if (ownerWindow && event instanceof ownerWindow.MouseEvent && event.button === 0) {
        deferredPointerEvent = event;
        return;
      }
      deferredPointerEvent = null;
      activateOutsideEvent(event, event);
    };
    const noteClick = (event: Event) => {
      const originalEvent = deferredPointerEvent;
      deferredPointerEvent = null;
      if (originalEvent) activateOutsideEvent(originalEvent, event);
    };
    const noteFocus = (event: Event) => {
      activateOutsideEvent(event, event);
    };
    const cancelDeferredPointer = () => {
      deferredPointerEvent = null;
    };
    document.addEventListener("pointerdown", notePointerDown, true);
    document.addEventListener("pointercancel", cancelDeferredPointer, true);
    document.addEventListener("click", noteClick, true);
    document.addEventListener("focusin", noteFocus, true);
    const guard: BellDomGuard = Object.freeze({
      isClean: mutationGuard.isClean,
      release: () => {
        if (guardReleased) return;
        guardReleased = true;
        deferredPointerEvent = null;
        document.removeEventListener("pointerdown", notePointerDown, true);
        document.removeEventListener("pointercancel", cancelDeferredPointer, true);
        document.removeEventListener("click", noteClick, true);
        document.removeEventListener("focusin", noteFocus, true);
        mutationGuard.release();
      },
    });
    publication.triggerDom = snapshotBellDom(trigger);
    publication.triggerPlacement = triggerPlacement;
    publication.contentDom = content ? snapshotBellDom(content) : null;
    publication.contentPlacement = contentPlacement;
    publication.domGuard = guard;
    const portalRefs: [BellElementRole | NotificationAction, HTMLElement][] = [];
    const addPortalRef = (
      key: BellElementRole | NotificationAction | null,
      element: HTMLElement | null | undefined,
    ) => {
      if (key && element) portalRefs.push([key, element]);
    };
    if (publication.open) {
      addPortalRef("content", content);
      addPortalRef("root", publication.elements.root);
      addPortalRef("list", publication.elements.list);
      addPortalRef(publication.readRetry, publication.readRetry?.element);
      addPortalRef(publication.loadRetry, publication.loadRetry?.element);
      addPortalRef(publication.readAll, publication.readAll?.element);
      for (const action of publication.rows) addPortalRef(action, action.element);
    }
    publication.replayRefs = [
      {
        key: "trigger",
        domain: "trigger",
        element: trigger,
        detached: false,
        reattached: false,
      },
      ...portalRefs.map(([key, element]) => ({
        key,
        domain: "portal" as const,
        element,
        detached: false,
        reattached: false,
      })),
    ];
    return true;
  }

  exactRefReplay(publication: NotificationPublication, domain: BellLayoutDomain) {
    const refs = publication.replayRefs.filter((entry) => entry.domain === domain);
    return (
      !publication.invalidReplay.has(domain) &&
      refs.length > 0 &&
      refs.every(
        (entry) =>
          entry.detached &&
          entry.reattached &&
          (entry.key === "trigger"
            ? publication.elements.trigger === entry.element
            : entry.key === "content"
              ? publication.elements.content === entry.element
              : entry.key === "root"
                ? publication.elements.root === entry.element
                : entry.key === "list"
                  ? publication.elements.list === entry.element
                  : entry.key.element === entry.element),
      )
    );
  }

  replayDomMatches(replay: BellReplay) {
    const trigger = replay.triggerDom.node;
    const content = replay.contentDom?.node ?? null;
    return Boolean(
      trigger instanceof HTMLElement &&
      trigger.isConnected &&
      bellPlacementMatches(trigger, replay.triggerPlacement) &&
      bellDomMatches(replay.triggerDom) &&
      (replay.contentDom
        ? content instanceof HTMLElement &&
          content.isConnected &&
          replay.contentPlacement &&
          bellPlacementMatches(content, replay.contentPlacement) &&
          bellDomMatches(replay.contentDom)
        : !replay.contentPlacement) &&
      replay.historyIsClean()
    );
  }

  stageReplay(publication: NotificationPublication, domain: BellLayoutDomain) {
    if (
      this.#successorOf !== publication ||
      this.#replay ||
      publication.consumed ||
      !publication.layoutRetired.has(domain) ||
      !this.exactRefReplay(publication, domain) ||
      !publication.triggerDom ||
      !publication.triggerPlacement ||
      !publication.domGuard?.isClean() ||
      !this.factsMatch(publication)
    ) {
      return;
    }
    this.#replay = Object.freeze({
      source: publication,
      triggerDom: publication.triggerDom,
      triggerPlacement: publication.triggerPlacement,
      contentDom: publication.contentDom,
      contentPlacement: publication.contentPlacement,
      historyIsClean: publication.domGuard.isClean,
      release: publication.domGuard.release,
    });
    this.requestSuccessor(publication);
  }

  publish(publication: NotificationPublication) {
    const replay = this.#replay;
    if (!this.canPublish(publication)) {
      if (replay) {
        this.#replay = null;
        replay.release();
        if (this.#successorOf === replay.source) this.#successorOf = null;
      }
      return false;
    }
    if (replay) {
      const sameGeneration = this.sameGeneration(replay.source, publication);
      const exactReplay =
        sameGeneration &&
        this.#successorOf === replay.source &&
        replay.source.retired &&
        !replay.source.consumed &&
        this.replayDomMatches(replay) &&
        publication.elements.trigger === replay.triggerDom.node &&
        publication.elements.content === (replay.contentDom?.node ?? null);
      this.#replay = null;
      replay.release();
      if (this.#successorOf === replay.source) this.#successorOf = null;
      if (sameGeneration && !exactReplay) {
        publication.retired = true;
        publication.retirement = "other";
        this.requestSuccessor(publication);
        return false;
      }
    }
    const previous = this.#current;
    if (previous && previous !== publication) this.retire(previous, "other");
    publication.established = true;
    if (!this.initializePublication(publication)) {
      publication.retired = true;
      publication.retirement = "other";
      return false;
    }
    this.#current = publication;
    this.#successorOf = null;
    return true;
  }

  establish(publication: NotificationPublication, domain: BellLayoutDomain) {
    publication.layoutEstablished.add(domain);
    if (publication.retired) {
      this.stageReplay(publication, domain);
      return;
    }
    const requiredDomains: BellLayoutDomain[] = publication.open
      ? ["trigger", "portal"]
      : ["trigger"];
    if (requiredDomains.every((required) => publication.layoutEstablished.has(required))) {
      this.publish(publication);
    }
  }

  retireLayout(publication: NotificationPublication, domain: BellLayoutDomain) {
    this.retire(publication, "layout", domain);
  }

  matches(publication: NotificationPublication) {
    const current =
      this.#current === publication &&
      publication.established &&
      !publication.retired;
    const factsMatch = this.factsMatch(publication);
    if (current && !factsMatch) {
      this.retire(publication, "mutation");
      return false;
    }
    return (
      current &&
      factsMatch &&
      this.triggerMatches(publication) &&
      (!publication.open || this.contentMatches(publication)) &&
      this.publicationDomMatches(publication)
    );
  }

  nativeReactClick(
    publication: NotificationPublication,
    element: HTMLButtonElement,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) {
    const document = element.ownerDocument;
    const ownerWindow = document.defaultView;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    const reactEvent = event as ReactMouseEvent<HTMLButtonElement> & {
      _reactName?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
      persist?: unknown;
    };
    const prototype = Object.getPrototypeOf(event) as {
      constructor?: { name?: unknown };
    } | null;
    if (
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      event.type !== "click" ||
      event.button !== 0 ||
      !event.bubbles ||
      event.currentTarget !== element ||
      nativeEvent.target !== target ||
      !isNodeFromDocument(target, document) ||
      !element.contains(target) ||
      !nativeEvent.composedPath().includes(element) ||
      event.defaultPrevented ||
      nativeEvent.defaultPrevented ||
      prototype?.constructor?.name !== "SyntheticBaseEvent" ||
      reactEvent._reactName !== "onClick" ||
      typeof reactEvent.isDefaultPrevented !== "function" ||
      typeof reactEvent.isPropagationStopped !== "function" ||
      typeof reactEvent.persist !== "function" ||
      this.#claimedEvents.has(nativeEvent) ||
      !this.matches(publication)
    ) {
      return null;
    }
    return nativeEvent;
  }

  mintTrigger(publication: NotificationPublication, event: ReactMouseEvent<HTMLButtonElement>) {
    const trigger = publication.elements.trigger;
    if (!trigger) return;
    const nativeEvent = this.nativeReactClick(publication, trigger, event);
    if (!nativeEvent) return;
    this.#claimedEvents.add(nativeEvent);
    publication.consumed = true;
    this.#proof = {
      publication,
      nextOpen: !publication.open,
      event: nativeEvent,
    };
  }

  mintEscape(publication: NotificationPublication, event: KeyboardEvent) {
    const { content, trigger } = publication.elements;
    const document = content?.ownerDocument;
    const ownerWindow = document?.defaultView;
    if (
      !content ||
      !trigger ||
      !document ||
      !ownerWindow ||
      !(event instanceof ownerWindow.KeyboardEvent) ||
      event.type !== "keydown" ||
      event.key !== "Escape" ||
      event.eventPhase === ownerWindow.Event.NONE ||
      event.defaultPrevented ||
      this.#claimedEvents.has(event) ||
      event.currentTarget !== document ||
      !isNodeFromDocument(event.target, document) ||
      !content.contains(event.target) ||
      !event.composedPath().includes(content) ||
      !event.composedPath().includes(document) ||
      !this.matches(publication) ||
      !publication.open
    ) {
      return;
    }
    this.#claimedEvents.add(event);
    publication.consumed = true;
    this.#proof = { publication, nextOpen: false, event };
  }

  mintOutside(publication: NotificationPublication, event: OutsideInteractionEvent) {
    const { content, trigger } = publication.elements;
    const document = content?.ownerDocument;
    const ownerWindow = document?.defaultView;
    const originalEvent = event.detail?.originalEvent;
    const target = originalEvent?.target ?? null;
    const provenanceEvent = originalEvent
      ? this.#currentOutsideEvents.get(originalEvent)
      : undefined;
    const pointerEvent =
      ownerWindow &&
      originalEvent &&
      isOwnerPointerEvent(originalEvent, ownerWindow)
        ? originalEvent
        : null;
    const focusEvent =
      ownerWindow && originalEvent instanceof ownerWindow.FocusEvent
        ? originalEvent
        : null;
    const eventTypeMatches =
      (pointerEvent &&
        event.type === "dismissableLayer.pointerDownOutside" &&
        originalEvent?.type === "pointerdown") ||
      (focusEvent &&
        event.type === "dismissableLayer.focusOutside" &&
        originalEvent?.type === "focusin");
    if (
      !content ||
      !trigger ||
      !document ||
      !ownerWindow ||
      !originalEvent ||
      !eventTypeMatches ||
      !provenanceEvent ||
      !(event instanceof ownerWindow.CustomEvent) ||
      event.eventPhase === ownerWindow.Event.NONE ||
      event.defaultPrevented ||
      originalEvent.defaultPrevented ||
      provenanceEvent.eventPhase === ownerWindow.Event.NONE ||
      provenanceEvent.currentTarget !== document ||
      provenanceEvent.defaultPrevented ||
      (pointerEvent &&
        (provenanceEvent === originalEvent
          ? pointerEvent.button === 0
          : !(provenanceEvent instanceof ownerWindow.MouseEvent) ||
            provenanceEvent.type !== "click" ||
            provenanceEvent.button !== 0)) ||
      (focusEvent && provenanceEvent !== originalEvent) ||
      this.#claimedEvents.has(originalEvent) ||
      event.target !== target ||
      event.currentTarget !== target ||
      !isNodeFromDocument(target, document) ||
      !target.isConnected ||
      !event.composedPath().includes(target) ||
      !event.composedPath().includes(document) ||
      content.contains(target) ||
      trigger.contains(target) ||
      !this.matches(publication) ||
      !publication.open
    ) {
      return;
    }
    this.#claimedEvents.add(originalEvent);
    publication.consumed = true;
    this.#proof = { publication, nextOpen: false, event: originalEvent };
  }

  consumeProof(publication: NotificationPublication, nextOpen: boolean) {
    const proof = this.#proof;
    if (!proof || proof.publication !== publication || proof.nextOpen !== nextOpen) return false;
    this.#proof = null;
    return this.matches(publication);
  }

  claimAction(
    publication: NotificationPublication,
    action: NotificationAction,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) {
    const element = action.element;
    if (
      !element ||
      action.claimed ||
      publication.rowClaimed ||
      !publication.open ||
      !this.actionMatches(publication, action)
    ) {
      return false;
    }
    const nativeEvent = this.nativeReactClick(publication, element, event);
    if (!nativeEvent) return false;
    this.#claimedEvents.add(nativeEvent);
    publication.consumed = true;
    action.claimed = true;
    if (action.kind === "row") publication.rowClaimed = true;
    return true;
  }
}

function createPublication({
  coordinator,
  visit,
  disclosure,
  open,
  source,
  requestSuccessor,
  current,
}: {
  coordinator: NotificationPublicationCoordinator;
  visit: NotificationBellVisit;
  disclosure: NotificationDisclosureAuthority | null;
  open: boolean;
  source: NotificationState;
  requestSuccessor: () => void;
  current: NotificationBellCurrent;
}) {
  const facts = createFacts(source, visit.ready);
  const publication: NotificationPublication = {
    identity: Symbol("notification-publication"),
    visit,
    disclosure,
    open,
    source,
    facts,
    elements: {
      trigger: null,
      content: null,
      root: null,
      list: null,
    },
    readRetry: null,
    loadRetry: null,
    readAll: null,
    rows: [],
    retired: false,
    retirement: null,
    established: false,
    consumed: false,
    layoutEstablished: new Set<BellLayoutDomain>(),
    layoutRetired: new Set<BellLayoutDomain>(),
    invalidReplay: new Set<BellLayoutDomain>(),
    replayRefs: [],
    triggerDom: null,
    triggerPlacement: null,
    contentDom: null,
    contentPlacement: null,
    domGuard: null,
    successorRequested: false,
    rowClaimed: false,
    requestSuccessor,
    current,
  };
  const action = (kind: BellActionKind, enabled: boolean, rowIndex: number | null): NotificationAction => ({
    identity: Symbol(`notification-${kind}`),
    publication,
    kind,
    enabled,
    rowIndex,
    element: null,
    claimed: false,
  });
  publication.readRetry = facts.readError
    ? action("read-retry", !facts.readErrorPending, null)
    : null;
  publication.loadRetry = !facts.loaded && facts.loadError
    ? action("load-retry", !facts.loading, null)
    : null;
  const readAll = action("read-all", facts.unreadCount > 0 && !facts.readAllPending, null);
  publication.readAll = readAll;
  publication.rows = Object.freeze(facts.rows.map((_, index) => action("row", true, index)));

  return {
    publication,
    readAll,
    captureTrigger: (element: HTMLButtonElement | null) => coordinator.bindElement(publication, "trigger", element),
    captureRoot: (element: HTMLDivElement | null) => {
      if (!element) {
        coordinator.bindElement(publication, "root", null);
        coordinator.bindElement(publication, "content", null);
        return;
      }
      const content = element.parentElement;
      coordinator.bindElement(
        publication,
        "content",
        content instanceof HTMLDivElement ? content : null,
      );
      coordinator.bindElement(publication, "root", element);
    },
    captureList: (element: HTMLUListElement | null) => coordinator.bindElement(publication, "list", element),
    captureAction: (owned: NotificationAction) => (element: HTMLButtonElement | null) =>
      coordinator.bindAction(owned, element),
  };
}

interface NotificationItemProps {
  notification: NotificationDto;
  currentDocId: string | undefined;
  captureButton: (element: HTMLButtonElement | null) => void;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

function NotificationItem({ notification, currentDocId, captureButton, onClick }: NotificationItemProps) {
  return (
    <button
      ref={captureButton}
      type="button"
      className={cn("flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-surface-2", !notification.readAt && "bg-accent-soft/30")}
      onClick={onClick}
      data-testid="notification-item"
      data-notification-id={notification.id}
      data-document-id={notification.documentId}
      data-ref-id={notification.refId}
      data-kind={notification.kind}
      data-unread={!notification.readAt}
    >
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-3">
        <KindIcon kind={notification.kind} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] leading-snug text-ink-2">
          <span className="font-medium text-ink">{actorLabel(notification)}</span> {sentence(notification)}
          {notification.kind !== "share" && notification.documentId !== currentDocId && (
            <>
              {" "}
              in <span className="font-medium text-ink">{notification.documentTitle}</span>
            </>
          )}
        </span>
        {notification.snippet && notification.kind !== "share" && (
          <span className="mt-0.5 block truncate text-xs text-ink-3">{notification.snippet}</span>
        )}
        <RelativeTime date={notification.createdAt} className="mt-0.5 block text-[11px] text-ink-4" />
      </span>
      {!notification.readAt && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" data-testid="notification-unread-dot" />}
    </button>
  );
}

function NotificationPortalLayout({
  coordinator,
  publication,
  children,
}: {
  coordinator: NotificationPublicationCoordinator;
  publication: NotificationPublication;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    coordinator.establish(publication, "portal");
    return () => coordinator.retireLayout(publication, "portal");
  }, [coordinator, publication]);
  return children;
}

/** Bell with an unread badge; the popover lists the latest notifications. */
export function NotificationsBell({ currentDocId, onOpen, ready = true }: NotificationsBellProps) {
  const notificationState = useNotifications(ready);
  const visit = useMemo<NotificationBellVisit>(
    () => Object.freeze({
      identity: Symbol("notification-visit"),
      currentDocId,
      onOpen,
      ready,
    }),
    [currentDocId, onOpen, ready],
  );
  const [coordinator] = useState(() => new NotificationPublicationCoordinator());
  const [current] = useState(() => new NotificationBellCurrent());
  const [, setPublicationRevision] = useState(0);
  const [disclosureState, setDisclosureState] = useState<NotificationDisclosureState>(() => ({
    visit,
    authority: null,
    open: false,
  }));
  const ownsDisclosure = disclosureState.visit === visit;
  const renderedDisclosure = ownsDisclosure && disclosureState.open
    ? disclosureState.authority
    : null;
  const open = Boolean(renderedDisclosure);

  const requestSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);

  useLayoutEffect(() => {
    const lease = coordinator.beginLease();
    return () => coordinator.endLease(lease);
  }, [coordinator]);

  useLayoutEffect(() => {
    current.publishVisit(visit);
    if (renderedDisclosure && !current.disclosure()) {
      current.publishDisclosure(renderedDisclosure);
    }
    setDisclosureState((current) =>
      current.visit === visit
        ? current
        : { visit, authority: null, open: false },
    );
    return () => {
      const disclosure = current.disclosure();
      if (disclosure?.visit === visit) coordinator.retireDisclosure(disclosure);
      current.retireVisit(visit);
    };
  }, [coordinator, current, renderedDisclosure, visit]);

  const closeDisclosure = useCallback(
    (authority: NotificationDisclosureAuthority) => {
      if (authority.visit !== visit || !current.retireDisclosure(authority)) return false;
      coordinator.retireDisclosure(authority);
      setDisclosureState((current) =>
        current.visit === visit && current.authority === authority && current.open
          ? { visit, authority: null, open: false }
          : current,
      );
      return true;
    },
    [coordinator, current, visit],
  );

  const publicationSet = createPublication({
    coordinator,
    visit,
    disclosure: renderedDisclosure,
    open,
    source: notificationState,
    requestSuccessor,
    current,
  });
  const {
    publication,
    readAll,
    captureTrigger,
    captureRoot,
    captureList,
    captureAction,
  } = publicationSet;

  const onOpenChange = (nextOpen: boolean) => {
    if (!coordinator.consumeProof(publication, nextOpen)) return;
    if (nextOpen) {
      if (current.disclosure() || publication.open) return;
      const authority = Object.freeze({
        identity: Symbol("notification-disclosure"),
        visit,
      });
      if (!current.publishDisclosure(authority)) return;
      setDisclosureState({ visit, authority, open: true });
      return;
    }
    if (publication.disclosure) closeDisclosure(publication.disclosure);
  };

  const activate = (
    action: NotificationAction,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    if (!coordinator.claimAction(publication, action, event)) return;
    if (action.kind === "read-retry") {
      if (publication.facts.readError) void retryNotificationRead(publication.facts.readError);
      return;
    }
    if (action.kind === "load-retry") {
      void refreshNotifications();
      return;
    }
    if (action.kind === "read-all") {
      void markAllNotificationsRead();
      return;
    }
    const row = action.rowIndex === null ? null : publication.facts.rows[action.rowIndex];
    const authority = publication.disclosure;
    if (!row || !authority) return;
    void markNotificationRead(row.id);
    if (!closeDisclosure(authority)) return;
    visit.onOpen(row);
  };

  useLayoutEffect(() => {
    coordinator.establish(publication, "trigger");
    return () => coordinator.retireLayout(publication, "trigger");
  }, [coordinator, publication]);

  const { facts } = publication;
  const { presentation } = facts;
  const readRetry = publication.readRetry;
  const loadRetry = publication.loadRetry;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tip label="Notifications">
        <PopoverTrigger asChild>
          <button
            ref={captureTrigger}
            type="button"
            className="icon-btn relative"
            aria-label={presentation.triggerLabel}
            data-testid="notifications-bell"
            data-unread={facts.unreadCount}
            onClick={(event) => coordinator.mintTrigger(publication, event)}
          >
            <Bell size={20} />
            {presentation.badgeText !== null && (
              <span
                className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-on-accent"
                data-testid="notifications-badge"
              >
                {presentation.badgeText}
              </span>
            )}
          </button>
        </PopoverTrigger>
      </Tip>
      {ownsDisclosure && (
        <PopoverContent
          align="end"
          collisionPadding={8}
          className="w-[min(380px,calc(100vw-16px))] p-0"
          data-testid="notifications-popover"
          onEscapeKeyDown={(event) => coordinator.mintEscape(publication, event)}
          onInteractOutside={(event) => coordinator.mintOutside(publication, event)}
        >
          <NotificationPortalLayout
            coordinator={coordinator}
            publication={publication}
          >
            <div ref={captureRoot}>
            <div className="flex h-10 items-center justify-between border-b border-line px-3">
              <span className="text-sm font-semibold text-ink">Notifications</span>
              {presentation.unreadLabel && (
                <span className="text-xs text-ink-4" data-testid="notifications-unread-count">
                  {presentation.unreadLabel}
                </span>
              )}
            </div>
            <ul ref={captureList} className="scrollbar-thin max-h-[420px] overflow-y-auto py-1" aria-label="Notifications">
              {facts.readError && readRetry && (
                <li className="px-3 py-2">
                  <div className="flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
                    <span>{facts.readError.message}</span>
                    <button
                      ref={captureAction(readRetry)}
                      type="button"
                      className="btn btn-outline h-7 shrink-0 px-2 text-xs"
                      disabled={!readRetry.enabled}
                      onClick={(event) => activate(readRetry, event)}
                      data-testid="notifications-read-retry"
                    >
                      {presentation.readRetryLabel}
                    </button>
                  </div>
                </li>
              )}
              {!facts.loaded && !facts.loadError && facts.loading && (
                <li className="px-3 py-8 text-center text-sm text-ink-4">Loading notifications…</li>
              )}
              {!facts.loaded && facts.loadError && loadRetry && (
                <li className="px-3 py-4">
                  <div className="flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
                    <span>Couldn&apos;t load notifications.</span>
                    <button
                      ref={captureAction(loadRetry)}
                      type="button"
                      className="btn btn-outline h-7 shrink-0 px-2 text-xs"
                      disabled={!loadRetry.enabled}
                      onClick={(event) => activate(loadRetry, event)}
                      data-testid="notifications-load-retry"
                    >
                      {presentation.loadRetryLabel}
                    </button>
                  </div>
                </li>
              )}
              {facts.loaded && facts.rows.length === 0 && (
                <li className="px-3 py-8 text-center text-sm text-ink-4">You&apos;re all caught up.</li>
              )}
              {publication.rows.map((action, index) => {
                const notification = facts.rows[index];
                return notification ? (
                  <li key={notification.id}>
                    <NotificationItem
                      notification={notification}
                      currentDocId={visit.currentDocId}
                      captureButton={captureAction(action)}
                      onClick={(event) => activate(action, event)}
                    />
                  </li>
                ) : null;
              })}
            </ul>
            <div className="flex h-10 items-center justify-end border-t border-line px-2">
              <button
                ref={captureAction(readAll)}
                type="button"
                className="btn btn-ghost h-7 gap-1.5 px-2 text-xs"
                disabled={!readAll.enabled}
                onClick={(event) => activate(readAll, event)}
                data-testid="notifications-read-all"
              >
                <CheckCheck size={14} /> {presentation.readAllLabel}
              </button>
            </div>
            </div>
          </NotificationPortalLayout>
        </PopoverContent>
      )}
    </Popover>
  );
}
