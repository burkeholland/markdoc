"use client";

import { useState } from "react";
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

/** Bell with an unread badge; the popover lists the latest notifications. */
export function NotificationsBell({ currentDocId, onOpen, ready = true }: NotificationsBellProps) {
  const { items, unreadCount, loaded, loading, loadError, readAllPending, readError, readErrorPending } = useNotifications(ready);
  const [open, setOpen] = useState(false);

  const openItem = (n: NotificationDto) => {
    void markNotificationRead(n.id);
    setOpen(false);
    onOpen(n);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
                  onClick={() => void retryNotificationRead(readError)}
                >
                  {readErrorPending ? "Retrying…" : "Retry"}
                </button>
              </div>
            </li>
          )}
          {!loaded && !loadError && loading && <li className="px-3 py-8 text-center text-sm text-ink-4">Loading notifications…</li>}
          {!loaded && loadError && (
            <li className="px-3 py-4">
              <div className="flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
                <span>Couldn&apos;t load notifications.</span>
                <button
                  type="button"
                  className="btn btn-outline h-7 shrink-0 px-2 text-xs"
                  disabled={loading}
                  onClick={() => void refreshNotifications()}
                >
                  {loading ? "Retrying…" : "Retry"}
                </button>
              </div>
            </li>
          )}
          {loaded && items.length === 0 && <li className="px-3 py-8 text-center text-sm text-ink-4">You&apos;re all caught up.</li>}
          {items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className={cn("flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-surface-2", !n.readAt && "bg-accent-soft/30")}
                onClick={() => openItem(n)}
                data-testid="notification-item"
                data-kind={n.kind}
                data-unread={!n.readAt}
              >
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-3">
                  <KindIcon kind={n.kind} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] leading-snug text-ink-2">
                    <span className="font-medium text-ink">{actorLabel(n)}</span> {sentence(n)}
                    {n.kind !== "share" && n.documentId !== currentDocId && (
                      <>
                        {" "}
                        in <span className="font-medium text-ink">{n.documentTitle}</span>
                      </>
                    )}
                  </span>
                  {n.snippet && n.kind !== "share" && <span className="mt-0.5 block truncate text-xs text-ink-3">{n.snippet}</span>}
                  <RelativeTime date={n.createdAt} className="mt-0.5 block text-[11px] text-ink-4" />
                </span>
                {!n.readAt && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" data-testid="notification-unread-dot" />}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex h-10 items-center justify-end border-t border-line px-2">
          <button
            type="button"
            className="btn btn-ghost h-7 gap-1.5 px-2 text-xs"
            disabled={unreadCount === 0 || readAllPending}
            onClick={() => void markAllNotificationsRead()}
            data-testid="notifications-read-all"
          >
            <CheckCheck size={14} /> {readAllPending ? "Marking all…" : "Mark all read"}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
