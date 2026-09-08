"use client";

import { useLayoutEffect, useState, type MouseEvent } from "react";
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
  readonly unreadCount: number;
  readonly rows: readonly NotificationRowAuthority[];
}

interface PublicationCells {
  readonly active: { current: NotificationStripPublication | null };
  readonly claimedEvents: WeakSet<object>;
}

class ElementOwner<T extends HTMLElement> {
  private current: T | null = null;
  private last: T | null = null;

  constructor(private readonly onReplacement: () => void) {}

  readonly element = () => this.current;
  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    const replaced = element !== null && this.last !== null && this.last !== element;
    this.current = element;
    if (element) this.last = element;
    if (replaced || element === null) this.onReplacement();
  };
}

interface NotificationRowPublication {
  readonly authority: NotificationRowAuthority;
  readonly captureItem: (element: HTMLLIElement | null) => void;
  readonly captureOpen: (element: HTMLButtonElement | null) => void;
  readonly captureDismiss: (element: HTMLButtonElement | null) => void;
  readonly item: () => HTMLLIElement | null;
  readonly open: () => HTMLButtonElement | null;
  readonly dismiss: () => HTMLButtonElement | null;
}

interface NotificationStripPublication {
  readonly authority: NotificationStripAuthority;
  readonly rows: readonly NotificationRowPublication[];
  readonly captureSection: (element: HTMLElement | null) => void;
  readonly captureReadAll: (element: HTMLButtonElement | null) => void;
  readonly captureList: (element: HTMLUListElement | null) => void;
  readonly establish: () => void;
  readonly retire: () => boolean;
  readonly onReadAll: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onOpen: (row: NotificationRowAuthority, event: MouseEvent<HTMLButtonElement>) => void;
  readonly onDismiss: (row: NotificationRowAuthority, event: MouseEvent<HTMLButtonElement>) => void;
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

function createNotificationStripPublication(
  authority: NotificationStripAuthority,
  cells: PublicationCells,
): NotificationStripPublication {
  const mount = authority.mount;
  const snapshot = authority.snapshot;
  const items = authority.items;
  const router = authority.router;
  const push = authority.push;
  const unreadCount = authority.unreadCount;
  const rows = authority.rows;
  const retireForReplacement = () => publication.retire();
  const sectionOwner = new ElementOwner<HTMLElement>(retireForReplacement);
  const readAllOwner = new ElementOwner<HTMLButtonElement>(retireForReplacement);
  const listOwner = new ElementOwner<HTMLUListElement>(retireForReplacement);
  const claimedRows = new WeakSet<NotificationRowAuthority>();
  let readAllClaimed = false;

  const publishedRows = Object.freeze(
    rows.map((row) => {
      const itemOwner = new ElementOwner<HTMLLIElement>(retireForReplacement);
      const openOwner = new ElementOwner<HTMLButtonElement>(retireForReplacement);
      const dismissOwner = new ElementOwner<HTMLButtonElement>(retireForReplacement);
      return Object.freeze({
        authority: row,
        captureItem: itemOwner.capture,
        captureOpen: openOwner.capture,
        captureDismiss: dismissOwner.capture,
        item: itemOwner.element,
        open: openOwner.element,
        dismiss: dismissOwner.element,
      });
    }),
  );

  const factsAreCurrent = () => {
    if (
      authority.mount !== mount ||
      authority.snapshot !== snapshot ||
      authority.items !== items ||
      authority.router !== router ||
      authority.push !== push ||
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
    if (
      !section ||
      !section.isConnected ||
      section.tagName !== "SECTION" ||
      section.dataset.testid !== "notifications-strip" ||
      section.getAttribute("aria-label") !== "Notifications" ||
      !readAll ||
      !readAll.isConnected ||
      readAll.type !== "button" ||
      readAll.disabled ||
      readAll.dataset.testid !== "notifications-strip-read-all" ||
      readAll.textContent?.trim() !== "Mark all read" ||
      !list ||
      !list.isConnected ||
      list.tagName !== "UL" ||
      list.parentElement !== section ||
      section.children.length !== 2 ||
      section.children.item(1) !== list ||
      list.children.length !== publishedRows.length
    ) {
      return false;
    }

    const header = section.children.item(0);
    if (
      !(header instanceof HTMLDivElement) ||
      header.children.length !== 2 ||
      header.children.item(1) !== readAll ||
      readAll.parentElement !== header
    ) {
      return false;
    }

    return publishedRows.every((published, index) => {
      const row = published.authority;
      const item = published.item();
      const open = published.open();
      const dismiss = published.dismiss();
      return (
        rows[index] === row &&
        item instanceof HTMLLIElement &&
        item.isConnected &&
        item.parentElement === list &&
        list.children.item(index) === item &&
        item.dataset.testid === "notification-item" &&
        item.dataset.kind === row.notification.kind &&
        item.dataset.notificationId === row.notification.id &&
        item.children.length === 3 &&
        open instanceof HTMLButtonElement &&
        open.isConnected &&
        open.parentElement === item &&
        item.children.item(1) === open &&
        open.type === "button" &&
        !open.disabled &&
        open.dataset.testid === "notification-open" &&
        dismiss instanceof HTMLButtonElement &&
        dismiss.isConnected &&
        dismiss.parentElement === item &&
        item.children.item(2) === dismiss &&
        dismiss.type === "button" &&
        !dismiss.disabled &&
        dismiss.dataset.testid === "notification-dismiss" &&
        dismiss.getAttribute("aria-label") === "Mark as read" &&
        dismiss.title === "Mark as read"
      );
    });
  };

  const ownsAuthority = () =>
    cells.active.current === publication &&
    publication.authority === authority &&
    factsAreCurrent() &&
    exactDomIsCurrent();
  const publishedRow = (row: NotificationRowAuthority) => {
    if (rows[row.index] !== row) return null;
    const published = publishedRows[row.index];
    return published?.authority === row ? published : null;
  };
  const ownsRowButton = (
    row: NotificationRowAuthority,
    source: HTMLButtonElement,
    action: "open" | "dismiss",
  ) => {
    const published = publishedRow(row);
    if (!published || published[action]() !== source) return false;
    return ownsAuthority() && source.isConnected && !source.disabled;
  };
  const claimEvent = (event: object) => {
    if (cells.claimedEvents.has(event)) return false;
    cells.claimedEvents.add(event);
    return true;
  };
  const establish = () => {
    const previous = cells.active.current;
    if (previous && previous !== publication) previous.retire();
    if (factsAreCurrent() && exactDomIsCurrent()) cells.active.current = publication;
  };
  const retire = () => {
    if (cells.active.current !== publication) return false;
    cells.active.current = null;
    return true;
  };
  const onReadAll = (event: MouseEvent<HTMLButtonElement>) => {
    const source = event.currentTarget;
    if (
      readAllClaimed ||
      readAllOwner.element() !== source ||
      !ownsAuthority() ||
      !source.isConnected ||
      source.disabled ||
      !claimEvent(event)
    ) {
      return;
    }
    readAllClaimed = true;
    void markAllNotificationsRead();
  };
  const onOpen = (row: NotificationRowAuthority, event: MouseEvent<HTMLButtonElement>) => {
    if (claimedRows.has(row) || !ownsRowButton(row, event.currentTarget, "open") || !claimEvent(event)) return;
    claimedRows.add(row);
    void markNotificationRead(row.notification.id);
    push(row.href);
  };
  const onDismiss = (row: NotificationRowAuthority, event: MouseEvent<HTMLButtonElement>) => {
    if (claimedRows.has(row) || !ownsRowButton(row, event.currentTarget, "dismiss") || !claimEvent(event)) return;
    claimedRows.add(row);
    void markNotificationRead(row.notification.id);
  };

  const publication: NotificationStripPublication = Object.freeze({
    authority,
    rows: publishedRows,
    captureSection: sectionOwner.capture,
    captureReadAll: readAllOwner.capture,
    captureList: listOwner.capture,
    establish,
    retire,
    onReadAll,
    onOpen,
    onDismiss,
  });
  return publication;
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
  const [cells] = useState<PublicationCells>(() => ({
    active: { current: null },
    claimedEvents: new WeakSet<object>(),
  }));
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
    unreadCount: snapshot.unreadCount,
    rows,
  });
  const publication = createNotificationStripPublication(authority, cells);

  useLayoutEffect(() => {
    publication.establish();
    return () => {
      publication.retire();
    };
  }, [publication]);

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
