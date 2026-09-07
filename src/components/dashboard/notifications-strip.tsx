"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  notification: Readonly<NotificationDto>;
}

interface NotificationStripAuthority {
  mount: symbol;
  snapshot: NotificationSnapshot;
  router: NotificationRouter;
  rows: readonly NotificationRowAuthority[];
  claimedRows: WeakSet<NotificationRowAuthority>;
  readAllClaimed: boolean;
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

/**
 * Unread notifications of the current user (mentions, replies, resolutions, suggestion decisions,
 * shares), shown at the top of the dashboard. Renders nothing when there is nothing to show.
 * Clicking one marks it read and opens the document on the relevant thread.
 */
export function NotificationsStrip() {
  const router = useRouter();
  const snapshot = useNotifications();
  const [mount] = useState(() => Symbol("notifications-strip"));
  const authority = useMemo<NotificationStripAuthority>(() => {
    const rows = snapshot.items
      .filter((notification) => !notification.readAt)
      .map((notification) => ({ notification: captureNotification(notification) }));
    return {
      mount,
      snapshot,
      router,
      rows,
      claimedRows: new WeakSet(),
      readAllClaimed: false,
    };
  }, [mount, router, snapshot]);
  const activeAuthorityRef = useRef<NotificationStripAuthority | null>(null);

  useLayoutEffect(() => {
    activeAuthorityRef.current = authority;
    return () => {
      if (activeAuthorityRef.current === authority) activeAuthorityRef.current = null;
    };
  }, [authority]);

  const claimRow = useCallback((candidate: NotificationStripAuthority, row: NotificationRowAuthority) => {
    if (activeAuthorityRef.current !== candidate || !candidate.rows.includes(row) || candidate.claimedRows.has(row)) return false;
    candidate.claimedRows.add(row);
    return true;
  }, []);

  const claimReadAll = useCallback((candidate: NotificationStripAuthority) => {
    if (activeAuthorityRef.current !== candidate || candidate.rows.length === 0 || candidate.readAllClaimed) return false;
    candidate.readAllClaimed = true;
    return true;
  }, []);

  if (authority.rows.length === 0) return null;

  return (
    <section className="mb-8 rounded-2xl border border-accent/40 bg-accent-soft/40 p-4" aria-label="Notifications" data-testid="notifications-strip">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Bell size={15} className="text-accent" /> Notifications
          <span className="text-ink-4">{authority.snapshot.unreadCount}</span>
        </h2>
        <button
          type="button"
          className="btn btn-ghost h-7 gap-1.5 px-2 text-xs"
          onClick={() => {
            if (claimReadAll(authority)) void markAllNotificationsRead();
          }}
          data-testid="notifications-strip-read-all"
        >
          <CheckCheck size={14} /> Mark all read
        </button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {authority.rows.map((row) => {
          const notification = row.notification;
          return (
            <li
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
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  if (!claimRow(authority, row)) return;
                  void markNotificationRead(notification.id);
                  authority.router.push(notificationHref(notification));
                }}
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
                type="button"
                className="icon-btn h-7 w-7 shrink-0"
                aria-label="Mark as read"
                title="Mark as read"
                onClick={() => {
                  if (claimRow(authority, row)) void markNotificationRead(notification.id);
                }}
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
