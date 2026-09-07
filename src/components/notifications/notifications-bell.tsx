"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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

interface NotificationBellVisit {
  currentDocId: string | undefined;
  onOpen: (notification: NotificationDto) => void;
  ready: boolean;
}

interface NotificationDisclosureAuthority {
  visit: NotificationBellVisit;
}

interface NotificationDisclosureState {
  visit: NotificationBellVisit;
  authority: NotificationDisclosureAuthority | null;
  open: boolean;
}

interface NotificationItemProps {
  notification: NotificationDto;
  visit: NotificationBellVisit;
  disclosure: NotificationDisclosureAuthority;
  claimDisclosure: (authority: NotificationDisclosureAuthority) => boolean;
  closeDisclosure: (authority: NotificationDisclosureAuthority) => void;
}

function NotificationItem({ notification, visit, disclosure, claimDisclosure, closeDisclosure }: NotificationItemProps) {
  const row = useMemo(
    () => ({
      disclosure,
      visit,
      data: [
        notification.actorLogin,
        notification.actorName,
        notification.createdAt,
        notification.documentId,
        notification.documentTitle,
        notification.id,
        notification.kind,
        notification.readAt,
        notification.refId,
        notification.snippet,
      ],
    }),
    [
      disclosure,
      notification.actorLogin,
      notification.actorName,
      notification.createdAt,
      notification.documentId,
      notification.documentTitle,
      notification.id,
      notification.kind,
      notification.readAt,
      notification.refId,
      notification.snippet,
      visit,
    ],
  );
  const activeRowRef = useRef<typeof row | null>(null);

  useLayoutEffect(() => {
    activeRowRef.current = row;
    return () => {
      if (activeRowRef.current === row) activeRowRef.current = null;
    };
  }, [row]);

  const activate = useCallback(() => {
    if (activeRowRef.current !== row || !claimDisclosure(disclosure)) return;
    void markNotificationRead(notification.id);
    closeDisclosure(disclosure);
    visit.onOpen(notification);
  }, [claimDisclosure, closeDisclosure, disclosure, notification, row, visit]);

  return (
    <button
      type="button"
      className={cn("flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-surface-2", !notification.readAt && "bg-accent-soft/30")}
      onClick={activate}
      data-testid="notification-item"
      data-kind={notification.kind}
      data-unread={!notification.readAt}
    >
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-3">
        <KindIcon kind={notification.kind} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] leading-snug text-ink-2">
          <span className="font-medium text-ink">{actorLabel(notification)}</span> {sentence(notification)}
          {notification.kind !== "share" && notification.documentId !== visit.currentDocId && (
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
  const { items, unreadCount, loaded, loading, loadError, readAllPending, readError, readErrorPending } = useNotifications(ready);
  const visit = useMemo<NotificationBellVisit>(
    () => ({ currentDocId, onOpen, ready }),
    [currentDocId, onOpen, ready],
  );
  const activeVisitRef = useRef<NotificationBellVisit | null>(null);
  const currentDisclosureRef = useRef<NotificationDisclosureAuthority | null>(null);
  const claimedDisclosuresRef = useRef(new WeakSet<NotificationDisclosureAuthority>());
  const [disclosure, setDisclosure] = useState<NotificationDisclosureState>(() => ({
    visit,
    authority: null,
    open: false,
  }));
  const ownsDisclosure = disclosure.visit === visit;
  const renderedDisclosure = ownsDisclosure ? disclosure.authority : null;
  const open = ownsDisclosure && disclosure.open;

  const isCurrentDisclosure = useCallback(
    (authority: NotificationDisclosureAuthority) =>
      activeVisitRef.current === visit &&
      visit.ready &&
      currentDisclosureRef.current === authority,
    [visit],
  );

  const isActionableDisclosure = useCallback(
    (authority: NotificationDisclosureAuthority) =>
      isCurrentDisclosure(authority) && !claimedDisclosuresRef.current.has(authority),
    [isCurrentDisclosure],
  );

  const claimDisclosure = useCallback(
    (authority: NotificationDisclosureAuthority) => {
      if (!isActionableDisclosure(authority)) return false;
      claimedDisclosuresRef.current.add(authority);
      return true;
    },
    [isActionableDisclosure],
  );

  const closeDisclosure = useCallback(
    (authority: NotificationDisclosureAuthority) => {
      if (!isCurrentDisclosure(authority)) return;
      currentDisclosureRef.current = null;
      setDisclosure((current) =>
        current.visit === visit && current.authority === authority
          ? { visit, authority, open: false }
          : current,
      );
    },
    [isCurrentDisclosure, visit],
  );

  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (activeVisitRef.current !== visit || !visit.ready) return;
      if (!nextOpen) {
        const authority = currentDisclosureRef.current;
        if (authority?.visit === visit) closeDisclosure(authority);
        return;
      }
      if (currentDisclosureRef.current) return;
      const authority: NotificationDisclosureAuthority = { visit };
      currentDisclosureRef.current = authority;
      setDisclosure((current) =>
        activeVisitRef.current === visit && currentDisclosureRef.current === authority
          ? { visit, authority, open: true }
          : current,
      );
    },
    [closeDisclosure, visit],
  );

  useLayoutEffect(() => {
    activeVisitRef.current = visit;
    setDisclosure((current) =>
      current.visit === visit && current.authority === null && !current.open
        ? current
        : { visit, authority: null, open: false },
    );
    return () => {
      if (activeVisitRef.current === visit) activeVisitRef.current = null;
      if (currentDisclosureRef.current?.visit === visit) currentDisclosureRef.current = null;
    };
  }, [visit]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tip label="Notifications">
        <PopoverTrigger asChild>
          <button
            type="button"
            className="icon-btn relative"
            aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
            data-testid="notifications-bell"
            data-unread={unreadCount}
          >
            <Bell size={20} />
            {unreadCount > 0 && (
              <span
                className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-on-accent"
                data-testid="notifications-badge"
              >
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </button>
        </PopoverTrigger>
      </Tip>
      {ownsDisclosure && (
        <PopoverContent align="end" collisionPadding={8} className="w-[min(380px,calc(100vw-16px))] p-0" data-testid="notifications-popover">
          <div className="flex h-10 items-center justify-between border-b border-line px-3">
            <span className="text-sm font-semibold text-ink">Notifications</span>
            {unreadCount > 0 && <span className="text-xs text-ink-4">{unreadCount} unread</span>}
          </div>
          <ul className="scrollbar-thin max-h-[420px] overflow-y-auto py-1" aria-label="Notifications">
            {readError && (
              <li className="px-3 py-2">
                <div className="flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
                  <span>{readError.message}</span>
                  <button
                    type="button"
                    className="btn btn-outline h-7 shrink-0 px-2 text-xs"
                    disabled={readErrorPending}
                    onClick={() => {
                      if (renderedDisclosure && !readErrorPending && isActionableDisclosure(renderedDisclosure)) {
                        void retryNotificationRead(readError);
                      }
                    }}
                  >
                    {readErrorPending ? "Retrying…" : "Retry"}
                  </button>
                </div>
              </li>
            )}
            {!loaded && !loadError && loading && (
              <li className="px-3 py-8 text-center text-sm text-ink-4">Loading notifications…</li>
            )}
            {!loaded && loadError && (
              <li className="px-3 py-4">
                <div className="flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
                  <span>Couldn&apos;t load notifications.</span>
                  <button
                    type="button"
                    className="btn btn-outline h-7 shrink-0 px-2 text-xs"
                    disabled={loading}
                    onClick={() => {
                      if (renderedDisclosure && !loading && isActionableDisclosure(renderedDisclosure)) {
                        void refreshNotifications();
                      }
                    }}
                  >
                    {loading ? "Retrying…" : "Retry"}
                  </button>
                </div>
              </li>
            )}
            {loaded && items.length === 0 && (
              <li className="px-3 py-8 text-center text-sm text-ink-4">You&apos;re all caught up.</li>
            )}
            {renderedDisclosure &&
              items.map((notification) => (
                <li key={notification.id}>
                  <NotificationItem
                    notification={notification}
                    visit={visit}
                    disclosure={renderedDisclosure}
                    claimDisclosure={claimDisclosure}
                    closeDisclosure={closeDisclosure}
                  />
                </li>
              ))}
          </ul>
          <div className="flex h-10 items-center justify-end border-t border-line px-2">
            <button
              type="button"
              className="btn btn-ghost h-7 gap-1.5 px-2 text-xs"
              disabled={unreadCount === 0 || readAllPending}
              onClick={() => {
                if (renderedDisclosure && unreadCount > 0 && !readAllPending && isActionableDisclosure(renderedDisclosure)) {
                  void markAllNotificationsRead();
                }
              }}
              data-testid="notifications-read-all"
            >
              <CheckCheck size={14} /> {readAllPending ? "Marking all…" : "Mark all read"}
            </button>
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}
