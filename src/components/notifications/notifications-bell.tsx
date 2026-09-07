"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
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
  established: boolean;
  layoutPassed: boolean;
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

function isNodeFromDocument(value: EventTarget | null, document: Document): value is Node {
  const NodeConstructor = document.defaultView?.Node;
  return Boolean(NodeConstructor && value instanceof NodeConstructor);
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
  #elementOwners = new WeakMap<HTMLElement, BellElementOwner>();
  #proof: DisclosureProof | null = null;
  #triggerEvents = new WeakSet<Event>();
  #dismissEvents = new WeakSet<Event>();

  bindElement<Role extends BellElementRole>(
    publication: NotificationPublication,
    role: Role,
    element: BellElements[Role],
  ) {
    const previous = publication.elements[role];
    if (!element) {
      const needsClosedSuccessor =
        role === "root" &&
        publication.layoutPassed &&
        !publication.open &&
        !publication.successorRequested;
      if (previous) {
        const owner = this.#elementOwners.get(previous);
        if (
          owner?.publication === publication &&
          owner.publicationIdentity === publication.identity &&
          owner.role === role
        ) {
          this.#elementOwners.delete(previous);
        }
      }
      publication.elements[role] = null;
      this.retire(publication);
      if (needsClosedSuccessor) this.requestSuccessor(publication);
      return;
    }
    if (publication.retired || (publication.established && previous !== element)) {
      this.requestSuccessor(publication);
      return;
    }
    if (previous && previous !== element) {
      const owner = this.#elementOwners.get(previous);
      if (
        owner?.publication === publication &&
        owner.publicationIdentity === publication.identity &&
        owner.role === role
      ) {
        this.#elementOwners.delete(previous);
      }
    }
    this.#elementOwners.set(element, {
      publication,
      publicationIdentity: publication.identity,
      role,
    });
    publication.elements[role] = element;
    if (publication.layoutPassed && !publication.established) this.requestSuccessor(publication);
  }

  bindAction(action: NotificationAction, element: HTMLButtonElement | null) {
    const publication = action.publication;
    const previous = action.element;
    if (!element) {
      if (previous) {
        const owner = this.#elementOwners.get(previous);
        if (
          owner?.publication === publication &&
          owner.publicationIdentity === publication.identity &&
          owner.action === action &&
          owner.actionIdentity === action.identity
        ) {
          this.#elementOwners.delete(previous);
        }
      }
      action.element = null;
      this.retire(publication);
      return;
    }
    if (publication.retired || (publication.established && previous !== element)) {
      this.requestSuccessor(publication);
      return;
    }
    if (previous && previous !== element) {
      const owner = this.#elementOwners.get(previous);
      if (
        owner?.publication === publication &&
        owner.publicationIdentity === publication.identity &&
        owner.action === action &&
        owner.actionIdentity === action.identity
      ) {
        this.#elementOwners.delete(previous);
      }
    }
    this.#elementOwners.set(element, {
      publication,
      publicationIdentity: publication.identity,
      role: "action",
      action,
      actionIdentity: action.identity,
    });
    action.element = element;
    if (publication.layoutPassed && !publication.established) this.requestSuccessor(publication);
  }

  requestSuccessor(publication: NotificationPublication) {
    if (publication.successorRequested) return;
    publication.successorRequested = true;
    publication.requestSuccessor();
  }

  retire(publication: NotificationPublication | null) {
    if (!publication || publication.retired) return;
    publication.retired = true;
    if (this.#current === publication) this.#current = null;
    if (this.#proof?.publication === publication) this.#proof = null;
  }

  retireDisclosure(disclosure: NotificationDisclosureAuthority) {
    if (this.#current?.disclosure === disclosure) this.retire(this.#current);
  }

  clear() {
    this.retire(this.#current);
    this.#current = null;
    this.#proof = null;
  }

  factsMatch(publication: NotificationPublication) {
    const { source, facts, visit } = publication;
    return (
      !publication.retired &&
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
      trigger.disabled ||
      !this.ownsElement(publication, "trigger", trigger)
    ) {
      return false;
    }
    const { presentation } = publication.facts;
    const badge = trigger.querySelector<HTMLElement>('[data-testid="notifications-badge"]');
    return (
      trigger.getAttribute("aria-label") === presentation.triggerLabel &&
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
      (action.kind === "read-all" ? root.lastElementChild?.contains(element) : list.contains(element)) &&
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
      list.parentElement !== root ||
      root.children.length !== 3 ||
      root.children[1] !== list ||
      content.dataset.state !== "open" ||
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
    const rowElements = [...list.querySelectorAll<HTMLButtonElement>('[data-testid="notification-item"]')];
    if (rowElements.length !== publication.rows.length) return false;
    return publication.rows.every((action, index) => {
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
    });
  }

  canPublish(publication: NotificationPublication) {
    if (!this.factsMatch(publication) || !this.triggerMatches(publication)) return false;
    const hasContent = publication.elements.content !== null;
    if (publication.open) return hasContent && this.contentMatches(publication);
    if (!hasContent) return true;
    return false;
  }

  publish(publication: NotificationPublication) {
    if (!this.canPublish(publication)) return false;
    publication.established = true;
    this.#current = publication;
    return true;
  }

  establish(publication: NotificationPublication) {
    publication.layoutPassed = true;
    this.publish(publication);
  }

  matches(publication: NotificationPublication) {
    return (
      this.#current === publication &&
      publication.established &&
      this.factsMatch(publication) &&
      this.triggerMatches(publication) &&
      (!publication.open || this.contentMatches(publication))
    );
  }

  mintTrigger(publication: NotificationPublication, event: ReactMouseEvent<HTMLButtonElement>) {
    const trigger = publication.elements.trigger;
    const document = trigger?.ownerDocument;
    const MouseEventConstructor = document?.defaultView?.MouseEvent;
    const nativeEvent = event.nativeEvent;
    if (
      !trigger ||
      !document ||
      !MouseEventConstructor ||
      !(nativeEvent instanceof MouseEventConstructor) ||
      this.#triggerEvents.has(nativeEvent) ||
      event.currentTarget !== trigger ||
      nativeEvent.target !== event.target ||
      !isNodeFromDocument(event.target, document) ||
      !trigger.contains(event.target) ||
      !this.matches(publication)
    ) {
      return;
    }
    this.#triggerEvents.add(nativeEvent);
    this.#proof = {
      publication,
      nextOpen: !publication.open,
      event: nativeEvent,
    };
  }

  mintEscape(publication: NotificationPublication, event: KeyboardEvent) {
    const { content, trigger } = publication.elements;
    const document = content?.ownerDocument;
    if (
      !content ||
      !trigger ||
      !document ||
      event.key !== "Escape" ||
      this.#dismissEvents.has(event) ||
      event.currentTarget !== document ||
      !isNodeFromDocument(event.target, document) ||
      !this.matches(publication) ||
      !publication.open
    ) {
      return;
    }
    this.#dismissEvents.add(event);
    this.#proof = { publication, nextOpen: false, event };
  }

  mintOutside(publication: NotificationPublication, event: OutsideInteractionEvent) {
    const { content, trigger } = publication.elements;
    const document = content?.ownerDocument;
    const originalEvent = event.detail?.originalEvent;
    const target = originalEvent?.target ?? null;
    if (
      !content ||
      !trigger ||
      !document ||
      !originalEvent ||
      this.#dismissEvents.has(event) ||
      event.target !== target ||
      event.currentTarget !== target ||
      !isNodeFromDocument(target, document) ||
      content.contains(target) ||
      trigger.contains(target) ||
      !this.matches(publication) ||
      !publication.open
    ) {
      return;
    }
    this.#dismissEvents.add(event);
    this.#proof = { publication, nextOpen: false, event };
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
      event.currentTarget !== element ||
      action.claimed ||
      publication.rowClaimed ||
      !publication.open ||
      !this.matches(publication) ||
      !this.actionMatches(publication, action)
    ) {
      return false;
    }
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
    established: false,
    layoutPassed: false,
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
    return () => {
      coordinator.clear();
      current.clear();
    };
  }, [coordinator, current]);

  useLayoutEffect(() => {
    current.publishVisit(visit);
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
  }, [coordinator, current, visit]);

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
    coordinator.establish(publication);
    return () => coordinator.retire(publication);
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
        </PopoverContent>
      )}
    </Popover>
  );
}
