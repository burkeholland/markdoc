"use client";

import { useCallback, useLayoutEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, X } from "lucide-react";
import type { NotificationDto } from "@/lib/api";
import { markAllNotificationsRead, markNotificationRead, sentence, useNotifications } from "@/lib/notifications-store";
import { KindIcon, actorLabel } from "@/components/notifications/notifications-bell";
import { notificationHref } from "@/components/notifications/open";
import { RelativeTime } from "@/components/ui/relative-time";

type NotificationSnapshot = ReturnType<typeof useNotifications>;
type NotificationRouter = ReturnType<typeof useRouter>;

interface NotificationRowAuthority {
  readonly index: number;
  readonly source: NotificationDto;
  readonly notification: Readonly<NotificationDto>;
  readonly href: string;
}

interface NotificationStripAuthority {
  readonly mount: symbol;
  readonly snapshot: NotificationSnapshot;
  readonly items: NotificationSnapshot["items"];
  readonly router: NotificationRouter;
  readonly push: NotificationRouter["push"];
  readonly markRead: typeof markNotificationRead;
  readonly markAllRead: typeof markAllNotificationsRead;
  readonly unreadCount: number;
  readonly rows: readonly NotificationRowAuthority[];
}

type NotificationActionKind = "read-all" | "open" | "dismiss";

interface NotificationActionPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly kind: NotificationActionKind;
  readonly rowIndex: number | null;
}

interface NotificationRowPublication {
  readonly identity: symbol;
  readonly authority: NotificationRowAuthority;
  readonly item: HTMLLIElement;
  readonly open: HTMLButtonElement;
  readonly dismiss: HTMLButtonElement;
  readonly openAction: NotificationActionPublication;
  readonly dismissAction: NotificationActionPublication;
}

interface NotificationDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly NotificationDomSnapshot[];
}

interface NotificationStripPublication {
  readonly identity: symbol;
  readonly authority: NotificationStripAuthority;
  readonly section: HTMLElement;
  readonly sectionParent: Node;
  readonly readAll: HTMLButtonElement;
  readonly list: HTMLUListElement;
  readonly rows: readonly NotificationRowPublication[];
  readonly readAllAction: NotificationActionPublication;
  readonly ownerDocument: Document;
  readonly dom: NotificationDomSnapshot;
}

interface ElementOwnerView {
  readonly element: () => HTMLElement | null;
}

interface RefReplay {
  readonly owner: ElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface NotificationReplay {
  readonly source: NotificationStripPublication;
  readonly dom: NotificationDomSnapshot;
}

interface NotificationPublicationRuntime {
  readonly publication: NotificationStripPublication;
  readonly publish: (owners: readonly ElementOwnerView[]) => boolean;
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
}

interface NotificationStripPublicationSet {
  readonly captureSection: (element: HTMLElement | null) => void;
  readonly captureReadAll: (element: HTMLButtonElement | null) => void;
  readonly captureList: (element: HTMLUListElement | null) => void;
  readonly rows: readonly {
    readonly authority: NotificationRowAuthority;
    readonly captureItem: (element: HTMLLIElement | null) => void;
    readonly captureOpen: (element: HTMLButtonElement | null) => void;
    readonly captureDismiss: (element: HTMLButtonElement | null) => void;
  }[];
  readonly establish: () => (() => void) | undefined;
  readonly onReadAll: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onOpen: (row: NotificationRowAuthority, event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onDismiss: (row: NotificationRowAuthority, event: ReactMouseEvent<HTMLButtonElement>) => void;
}

class NotificationStripCoordinator {
  readonly #mount: symbol;
  #active: NotificationStripPublication | null = null;
  #successorOf: NotificationStripPublication | null = null;
  #replay: NotificationReplay | null = null;
  #retired = new WeakSet<NotificationStripPublication>();
  #claimedPublications = new WeakSet<NotificationStripPublication>();
  #claimedActions = new WeakSet<NotificationActionPublication>();
  #claimedRows = new WeakSet<NotificationRowPublication>();
  #claimedEvents = new WeakSet<object>();

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  replay() {
    return this.#replay;
  }

  acceptsSuccessorOf(publication: NotificationStripPublication) {
    return (
      this.#active === null &&
      this.#successorOf === publication &&
      this.#retired.has(publication) &&
      !this.#claimedPublications.has(publication)
    );
  }

  stageReplay(publication: NotificationStripPublication, dom: NotificationDomSnapshot) {
    if (!this.acceptsSuccessorOf(publication)) return false;
    this.#replay = Object.freeze({ source: publication, dom });
    return true;
  }

  abandonReplay(publication: NotificationStripPublication) {
    if (this.#replay?.source === publication) this.#replay = null;
    if (this.#successorOf === publication) this.#successorOf = null;
  }

  publish(publication: NotificationStripPublication) {
    if (
      publication.authority.mount !== this.#mount ||
      this.#retired.has(publication)
    ) {
      return false;
    }
    const previous = this.#active;
    if (previous && previous !== publication) this.retire(previous);
    this.#active = publication;
    this.#successorOf = null;
    this.#replay = null;
    return true;
  }

  retire(publication: NotificationStripPublication) {
    if (this.#retired.has(publication)) return false;
    this.#retired.add(publication);
    if (this.#active === publication) {
      this.#active = null;
      this.#successorOf = publication;
    }
    return true;
  }

  isCurrent(publication: NotificationStripPublication) {
    return this.#active === publication && !this.#retired.has(publication);
  }

  hasClaimed(
    publication: NotificationStripPublication,
    action: NotificationActionPublication,
    event: object,
    nativeEvent: Event,
  ) {
    const row = action.rowIndex === null ? null : publication.rows[action.rowIndex];
    return (
      this.#claimedActions.has(action) ||
      (row !== null && this.#claimedRows.has(row)) ||
      this.#claimedEvents.has(event) ||
      this.#claimedEvents.has(nativeEvent)
    );
  }

  claim(
    publication: NotificationStripPublication,
    action: NotificationActionPublication,
    event: object,
    nativeEvent: Event,
  ) {
    if (
      !this.isCurrent(publication) ||
      action.publicationIdentity !== publication.identity ||
      this.hasClaimed(publication, action, event, nativeEvent)
    ) {
      return false;
    }
    const row = action.rowIndex === null ? null : publication.rows[action.rowIndex];
    if (
      action.kind === "read-all"
        ? action !== publication.readAllAction || row !== null
        : !row ||
          (action.kind === "open"
            ? action !== row.openAction
            : action !== row.dismissAction)
    ) {
      return false;
    }
    this.#claimedActions.add(action);
    this.#claimedPublications.add(publication);
    if (row) this.#claimedRows.add(row);
    this.#claimedEvents.add(event);
    this.#claimedEvents.add(nativeEvent);
    return true;
  }
}

class ElementOwner<T extends HTMLElement> implements ElementOwnerView {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: ElementOwnerView,
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

function captureNotification(notification: NotificationDto): Readonly<NotificationDto> {
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

function notificationFactsMatch(source: NotificationDto, captured: Readonly<NotificationDto>) {
  return (
    source.id === captured.id &&
    source.kind === captured.kind &&
    source.documentId === captured.documentId &&
    source.documentTitle === captured.documentTitle &&
    source.actorLogin === captured.actorLogin &&
    source.actorName === captured.actorName &&
    source.refId === captured.refId &&
    source.snippet === captured.snippet &&
    source.createdAt === captured.createdAt &&
    source.readAt === captured.readAt
  );
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotNotificationDom(node: Node): NotificationDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotNotificationDom)),
  });
}

function notificationDomMatches(snapshot: NotificationDomSnapshot, ownerDocument: Document): boolean {
  const { node } = snapshot;
  if (
    !node.isConnected ||
    node.ownerDocument !== ownerDocument ||
    node.nodeValue !== snapshot.nodeValue
  ) {
    return false;
  }
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
        node.childNodes.item(index) === child.node &&
        notificationDomMatches(child, ownerDocument),
    )
  );
}

function isEffectivelyEnabled(button: HTMLButtonElement) {
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

function authoritiesMatch(
  previous: NotificationStripAuthority,
  current: NotificationStripAuthority,
) {
  return (
    previous.mount === current.mount &&
    previous.snapshot === current.snapshot &&
    previous.items === current.items &&
    previous.router === current.router &&
    previous.push === current.push &&
    previous.markRead === current.markRead &&
    previous.markAllRead === current.markAllRead &&
    previous.unreadCount === current.unreadCount &&
    previous.rows.length === current.rows.length &&
    previous.rows.every((row, index) => {
      const candidate = current.rows[index];
      return Boolean(
        candidate &&
          row.index === candidate.index &&
          row.source === candidate.source &&
          row.href === candidate.href &&
          notificationFactsMatch(row.source, row.notification) &&
          notificationFactsMatch(candidate.source, candidate.notification) &&
          notificationFactsMatch(row.notification, candidate.notification),
      );
    })
  );
}

function createNotificationStripPublication(
  authority: NotificationStripAuthority,
  coordinator: NotificationStripCoordinator,
  requestSuccessor: () => void,
): NotificationStripPublicationSet {
  let currentRuntime: NotificationPublicationRuntime | null = null;
  let lastRuntime: NotificationPublicationRuntime | null = null;
  let successorRequested = false;
  const snapshot = authority.snapshot;
  const items = authority.items;
  const router = authority.router;
  const push = authority.push;
  const markRead = authority.markRead;
  const markAllRead = authority.markAllRead;
  const unreadCount = authority.unreadCount;
  const rows = authority.rows;
  const onElementChange = (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (element !== null && last !== null && element !== last)) {
      currentRuntime?.retireForElement();
    }
    if (
      runtime?.isExactElementReplay() &&
      coordinator.acceptsSuccessorOf(runtime.publication)
    ) {
      requestReplaySuccessor(runtime);
    }
  };
  const sectionOwner = new ElementOwner<HTMLElement>(onElementChange);
  const readAllOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
  const listOwner = new ElementOwner<HTMLUListElement>(onElementChange);
  const rowOwners = Object.freeze(
    rows.map((row) => {
      const itemOwner = new ElementOwner<HTMLLIElement>(onElementChange);
      const openOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
      const dismissOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
      return Object.freeze({
        authority: row,
        captureItem: itemOwner.capture,
        captureOpen: openOwner.capture,
        captureDismiss: dismissOwner.capture,
        itemOwner,
        openOwner,
        dismissOwner,
      });
    }),
  );
  const expectedOwners = () =>
    Object.freeze([
      sectionOwner,
      readAllOwner,
      listOwner,
      ...rowOwners.flatMap(({ itemOwner, openOwner, dismissOwner }) => [
        itemOwner,
        openOwner,
        dismissOwner,
      ]),
    ]);

  const factsAreCurrent = () => {
    if (
      authority.snapshot !== snapshot ||
      authority.items !== items ||
      authority.router !== router ||
      authority.push !== push ||
      authority.markRead !== markRead ||
      authority.markAllRead !== markAllRead ||
      markNotificationRead !== markRead ||
      markAllNotificationsRead !== markAllRead ||
      authority.unreadCount !== unreadCount ||
      authority.rows !== rows ||
      snapshot.items !== items ||
      snapshot.unreadCount !== unreadCount ||
      router.push !== push
    ) {
      return false;
    }

    const currentRows = items.filter((notification) => !notification.readAt);
    if (currentRows.length !== rows.length) return false;
    return rows.every(
      (row, index) =>
        row.index === index &&
        rows[index] === row &&
        currentRows[index] === row.source &&
        notificationFactsMatch(row.source, row.notification) &&
        notificationHref(row.notification) === row.href,
    );
  };

  const exactDomIsCurrent = () => {
    const section = sectionOwner.element();
    const readAll = readAllOwner.element();
    const list = listOwner.element();
    const ownerDocument = section?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (
      !section ||
      !section.isConnected ||
      !section.parentNode ||
      !ownerDocument ||
      !ownerWindow ||
      section.tagName !== "SECTION" ||
      section.dataset.testid !== "notifications-strip" ||
      section.getAttribute("aria-label") !== "Notifications" ||
      !readAll ||
      !readAll.isConnected ||
      readAll.ownerDocument !== ownerDocument ||
      readAll.type !== "button" ||
      !isEffectivelyEnabled(readAll) ||
      readAll.dataset.testid !== "notifications-strip-read-all" ||
      readAll.textContent?.trim() !== "Mark all read" ||
      !list ||
      !list.isConnected ||
      list.ownerDocument !== ownerDocument ||
      list.tagName !== "UL" ||
      list.parentElement !== section ||
      section.children.length !== 2 ||
      section.children.item(1) !== list ||
      list.children.length !== rowOwners.length
    ) {
      return false;
    }

    const header = section.children.item(0);
    if (
      !(header instanceof ownerWindow.HTMLDivElement) ||
      header.children.length !== 2 ||
      header.children.item(1) !== readAll ||
      readAll.parentElement !== header
    ) {
      return false;
    }

    return rowOwners.every((owned, index) => {
      const row = owned.authority;
      const item = owned.itemOwner.element();
      const open = owned.openOwner.element();
      const dismiss = owned.dismissOwner.element();
      return (
        rows[index] === row &&
        item instanceof ownerWindow.HTMLLIElement &&
        item.isConnected &&
        item.ownerDocument === ownerDocument &&
        item.parentElement === list &&
        list.children.item(index) === item &&
        item.dataset.testid === "notification-item" &&
        item.dataset.kind === row.notification.kind &&
        item.dataset.notificationId === row.notification.id &&
        item.children.length === 3 &&
        open instanceof ownerWindow.HTMLButtonElement &&
        open.isConnected &&
        open.ownerDocument === ownerDocument &&
        open.parentElement === item &&
        item.children.item(1) === open &&
        open.type === "button" &&
        isEffectivelyEnabled(open) &&
        open.dataset.testid === "notification-open" &&
        dismiss instanceof ownerWindow.HTMLButtonElement &&
        dismiss.isConnected &&
        dismiss.ownerDocument === ownerDocument &&
        dismiss.parentElement === item &&
        item.children.item(2) === dismiss &&
        dismiss.type === "button" &&
        isEffectivelyEnabled(dismiss) &&
        dismiss.dataset.testid === "notification-dismiss" &&
        dismiss.getAttribute("aria-label") === "Mark as read" &&
        dismiss.title === "Mark as read"
      );
    });
  };

  const requestReplaySuccessor = (runtime: NotificationPublicationRuntime) => {
    if (
      successorRequested ||
      !coordinator.acceptsSuccessorOf(runtime.publication) ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches() ||
      !coordinator.stageReplay(runtime.publication, runtime.publication.dom)
    ) {
      return;
    }
    successorRequested = true;
    requestSuccessor();
  };

  const createRuntime = (
    section: HTMLElement,
    readAll: HTMLButtonElement,
    list: HTMLUListElement,
    dom: NotificationDomSnapshot,
  ): NotificationPublicationRuntime => {
    type Retirement = "element" | "layout";
    const identity = Symbol("notification-strip-publication");
    const action = (
      kind: NotificationActionKind,
      rowIndex: number | null,
    ): NotificationActionPublication =>
      Object.freeze({
        identity: Symbol(`notification-strip-${kind}`),
        publicationIdentity: identity,
        kind,
        rowIndex,
      });
    const publishedRows = Object.freeze(
      rowOwners.map((owned, index) => {
        const item = owned.itemOwner.element();
        const open = owned.openOwner.element();
        const dismiss = owned.dismissOwner.element();
        if (!item || !open || !dismiss) {
          throw new Error("Cannot publish a notification row without every committed ref");
        }
        return Object.freeze({
          identity: Symbol("notification-strip-row"),
          authority: owned.authority,
          item,
          open,
          dismiss,
          openAction: action("open", index),
          dismissAction: action("dismiss", index),
        });
      }),
    );
    const publication: NotificationStripPublication = Object.freeze({
      identity,
      authority,
      section,
      sectionParent: section.parentNode!,
      readAll,
      list,
      rows: publishedRows,
      readAllAction: action("read-all", null),
      ownerDocument: section.ownerDocument,
      dom,
    });
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let invalidReplay = false;
    let replayRefs: RefReplay[] = [];
    const retire = (reason: Retirement) => {
      if (retired) return false;
      retired = true;
      retirement = reason;
      coordinator.retire(publication);
      if (currentRuntime?.publication === publication) currentRuntime = null;
      return true;
    };
    const publishedDomMatches = () =>
      section === dom.node &&
      section.parentNode === publication.sectionParent &&
      notificationDomMatches(dom, publication.ownerDocument);
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
    const runtime: NotificationPublicationRuntime = Object.freeze({
      publication,
      publish: (owners: readonly ElementOwnerView[]) => {
        established = true;
        replayRefs = owners.map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error("Cannot publish a notification strip without every committed ref");
          }
          return { owner, element, detached: false, reattached: false };
        });
        return coordinator.publish(publication);
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
    });
    return runtime;
  };

  const nativeClick = (
    publication: NotificationStripPublication,
    source: HTMLButtonElement,
    event: ReactMouseEvent<HTMLButtonElement>,
  ): MouseEvent | null => {
    if (!event || typeof event !== "object") return null;
    const ownerWindow = publication.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    const reactEvent = event as ReactMouseEvent<HTMLButtonElement> & {
      _reactName?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
      persist?: unknown;
    };
    const reactEventPrototype = Object.getPrototypeOf(event) as {
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
      event.currentTarget !== source ||
      target !== nativeEvent.target ||
      !(target instanceof ownerWindow.Node) ||
      target.ownerDocument !== publication.ownerDocument ||
      !source.contains(target) ||
      !nativeEvent.composedPath().includes(source) ||
      !nativeEvent.composedPath().includes(publication.section) ||
      reactEventPrototype?.constructor?.name !== "SyntheticBaseEvent" ||
      reactEvent._reactName !== "onClick" ||
      typeof reactEvent.isDefaultPrevented !== "function" ||
      typeof reactEvent.isPropagationStopped !== "function" ||
      typeof reactEvent.persist !== "function"
    ) {
      return null;
    }
    const targetWasCommitted = (snapshot: NotificationDomSnapshot): boolean =>
      snapshot.node === target ||
      snapshot.children.some(targetWasCommitted);
    return targetWasCommitted(publication.dom) ? nativeEvent : null;
  };

  const claim = (
    kind: NotificationActionKind,
    row: NotificationRowAuthority,
    event: ReactMouseEvent<HTMLButtonElement>,
  ): NotificationStripPublication | null => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const publishedRow =
      publication && rows[row.index] === row
        ? publication.rows[row.index]
        : null;
    const action =
      kind === "open"
        ? publishedRow?.openAction
        : publishedRow?.dismissAction;
    const source = event?.currentTarget;
    const expectedSource =
      kind === "open"
        ? publishedRow?.open
        : publishedRow?.dismiss;
    if (
      !runtime ||
      !publication ||
      runtime.isRetired() ||
      publication.authority !== authority ||
      publishedRow?.authority !== row ||
      !action ||
      !source ||
      source !== expectedSource ||
      !source.isConnected ||
      !isEffectivelyEnabled(source) ||
      !coordinator.isCurrent(publication) ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches()
    ) {
      return null;
    }
    const nativeEvent = nativeClick(publication, source, event);
    if (
      !nativeEvent ||
      coordinator.hasClaimed(publication, action, event, nativeEvent) ||
      !coordinator.claim(publication, action, event, nativeEvent)
    ) {
      return null;
    }
    return publication;
  };

  const claimReadAll = (
    event: ReactMouseEvent<HTMLButtonElement>,
  ): NotificationStripPublication | null => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const source = event?.currentTarget;
    const action = publication?.readAllAction;
    if (
      !runtime ||
      !publication ||
      runtime.isRetired() ||
      publication.authority !== authority ||
      !action ||
      !source ||
      source !== publication.readAll ||
      !source.isConnected ||
      !isEffectivelyEnabled(source) ||
      !coordinator.isCurrent(publication) ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches()
    ) {
      return null;
    }
    const nativeEvent = nativeClick(publication, source, event);
    if (
      !nativeEvent ||
      coordinator.hasClaimed(publication, action, event, nativeEvent) ||
      !coordinator.claim(publication, action, event, nativeEvent)
    ) {
      return null;
    }
    return publication;
  };

  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() ||
          lastRuntime.isExactElementReplay()) &&
        coordinator.acceptsSuccessorOf(lastRuntime.publication)
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!factsAreCurrent() || !exactDomIsCurrent()) return undefined;
    const section = sectionOwner.element();
    const readAll = readAllOwner.element();
    const list = listOwner.element();
    if (!section || !readAll || !list) return undefined;
    const replay = coordinator.replay();
    if (
      replay &&
      (
        !coordinator.acceptsSuccessorOf(replay.source) ||
        !authoritiesMatch(replay.source.authority, authority) ||
        replay.dom.node !== section ||
        !notificationDomMatches(replay.dom, section.ownerDocument)
      )
    ) {
      coordinator.abandonReplay(replay.source);
    }
    const runtime = createRuntime(
      section,
      readAll,
      list,
      snapshotNotificationDom(section),
    );
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish(expectedOwners())) {
      runtime.retireForElement();
      return undefined;
    }
    return runtime.retireForLayout;
  };

  const onReadAll = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const publication = claimReadAll(event);
    if (!publication) return;
    void publication.authority.markAllRead();
  };
  const onOpen = (
    row: NotificationRowAuthority,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    const publication = claim("open", row, event);
    if (!publication) return;
    void publication.authority.markRead(row.notification.id);
    publication.authority.push(row.href);
  };
  const onDismiss = (
    row: NotificationRowAuthority,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    const publication = claim("dismiss", row, event);
    if (!publication) return;
    void publication.authority.markRead(row.notification.id);
  };

  return Object.freeze({
    captureSection: sectionOwner.capture,
    captureReadAll: readAllOwner.capture,
    captureList: listOwner.capture,
    rows: rowOwners,
    establish,
    onReadAll,
    onOpen,
    onDismiss,
  });
}

/**
 * Unread notifications of the current user (mentions, replies, resolutions, suggestion decisions,
 * shares), shown at the top of the dashboard. Renders nothing when there is nothing to show.
 * Clicking one marks it read and opens the document on the relevant thread.
 */
export function NotificationsStrip() {
  const router = useRouter();
  const snapshot = useNotifications();
  const [mount] = useState(() => Symbol("notifications-strip"));
  const [coordinator] = useState(() => new NotificationStripCoordinator(mount));
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const rows = Object.freeze(
    snapshot.items
      .filter((notification) => !notification.readAt)
      .map((source, index) => {
        const notification = captureNotification(source);
        return Object.freeze({
          index,
          source,
          notification,
          href: notificationHref(notification),
        });
      }),
  );
  const authority: NotificationStripAuthority = Object.freeze({
    mount,
    snapshot,
    items: snapshot.items,
    router,
    push: router.push,
    markRead: markNotificationRead,
    markAllRead: markAllNotificationsRead,
    unreadCount: snapshot.unreadCount,
    rows,
  });
  const publication = createNotificationStripPublication(
    authority,
    coordinator,
    requestPublicationSuccessor,
  );

  useLayoutEffect(() => publication.establish(), [publication]);

  if (authority.rows.length === 0) return null;
  const {
    captureSection,
    captureReadAll,
    captureList,
    rows: publishedRows,
    onReadAll,
    onOpen,
    onDismiss,
  } = publication;

  return (
    <section
      ref={captureSection}
      className="mb-8 rounded-2xl border border-accent/40 bg-accent-soft/40 p-4"
      aria-label="Notifications"
      data-testid="notifications-strip"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Bell size={15} className="text-accent" /> Notifications
          <span className="text-ink-4">{authority.unreadCount}</span>
        </h2>
        <button
          ref={captureReadAll}
          type="button"
          className="btn btn-ghost h-7 gap-1.5 px-2 text-xs"
          onClick={onReadAll}
          data-testid="notifications-strip-read-all"
        >
          <CheckCheck size={14} /> Mark all read
        </button>
      </div>
      <ul ref={captureList} className="flex flex-col gap-1.5">
        {publishedRows.map((published) => {
          const row = published.authority;
          const notification = row.notification;
          return (
            <li
              ref={published.captureItem}
              key={notification.id}
              className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2 text-[13px] shadow-sm"
              data-testid="notification-item"
              data-kind={notification.kind}
              data-notification-id={notification.id}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-3">
                <KindIcon kind={notification.kind} />
              </span>
              <button
                ref={published.captureOpen}
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={(event) => onOpen(row, event)}
                data-testid="notification-open"
              >
                <span className="text-ink-2">
                  <span className="font-medium text-ink">{actorLabel(notification)}</span> {sentence(notification)}
                  {notification.kind !== "share" && (
                    <>
                      {" "}
                      in{" "}
                      <span className="font-medium text-ink" data-testid="notification-doc-title">
                        {notification.documentTitle}
                      </span>
                    </>
                  )}
                </span>
                <RelativeTime date={notification.createdAt} className="ml-2 text-xs text-ink-4" />
                {notification.snippet && notification.kind !== "share" && <span className="mt-0.5 block truncate text-ink-3">{notification.snippet}</span>}
              </button>
              <button
                ref={published.captureDismiss}
                type="button"
                className="icon-btn h-7 w-7 shrink-0"
                aria-label="Mark as read"
                title="Mark as read"
                onClick={(event) => onDismiss(row, event)}
                data-testid="notification-dismiss"
              >
                <X size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
