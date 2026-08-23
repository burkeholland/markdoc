"use client";

import { useRouter } from "next/navigation";
import { Bell, CheckCheck, X } from "lucide-react";
import type { NotificationDto } from "@/lib/api";
import { markAllNotificationsRead, markNotificationRead, sentence, useNotifications } from "@/lib/notifications-store";
import { KindIcon, actorLabel } from "@/components/notifications/notifications-bell";
import { notificationHref } from "@/components/notifications/open";
import { RelativeTime } from "@/components/ui/relative-time";

/**
 * Unread notifications of the current user (mentions, replies, resolutions, suggestion decisions,
 * shares), shown at the top of the dashboard. Renders nothing when there is nothing to show.
 * Clicking one marks it read and opens the document on the relevant thread.
 */
export function NotificationsStrip() {
  const router = useRouter();
  const { items, unreadCount } = useNotifications();
  const unread = items.filter((n) => !n.readAt);
  if (unread.length === 0) return null;

  const open = (n: NotificationDto) => {
    void markNotificationRead(n.id);
    router.push(notificationHref(n));
  };

  return (
    <section className="mb-8 rounded-2xl border border-accent/40 bg-accent-soft/40 p-4" aria-label="Notifications" data-testid="notifications-strip">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Bell size={15} className="text-accent" /> Notifications
          <span className="text-ink-4">{unreadCount}</span>
        </h2>
        <button type="button" className="btn btn-ghost h-7 gap-1.5 px-2 text-xs" onClick={() => void markAllNotificationsRead()} data-testid="notifications-strip-read-all">
          <CheckCheck size={14} /> Mark all read
        </button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {unread.map((n) => (
          <li key={n.id} className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2 text-[13px] shadow-sm" data-testid="notification-item" data-kind={n.kind} data-notification-id={n.id}>
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-3">
              <KindIcon kind={n.kind} />
            </span>
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => open(n)} data-testid="notification-open">
              <span className="text-ink-2">
                <span className="font-medium text-ink">{actorLabel(n)}</span> {sentence(n)}
                {n.kind !== "share" && (
                  <>
                    {" "}
                    in{" "}
                    <span className="font-medium text-ink" data-testid="notification-doc-title">
                      {n.documentTitle}
                    </span>
                  </>
                )}
              </span>
              <RelativeTime date={n.createdAt} className="ml-2 text-xs text-ink-4" />
              {n.snippet && n.kind !== "share" && <span className="mt-0.5 block truncate text-ink-3">{n.snippet}</span>}
            </button>
            <button type="button" className="icon-btn h-7 w-7 shrink-0" aria-label="Mark as read" title="Mark as read" onClick={() => void markNotificationRead(n.id)} data-testid="notification-dismiss">
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
