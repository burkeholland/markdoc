"use client";

import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, X } from "lucide-react";
import type { NotificationDto } from "@/lib/api";
import { markAllNotificationsRead, markNotificationRead, sentence, useNotifications } from "@/lib/notifications-store";
import { KindIcon, actorLabel } from "@/components/notifications/notifications-bell";
import { notificationHref } from "@/components/notifications/open";
import { RelativeTime } from "@/components/ui/relative-time";

const OPEN_SELECTOR = '[data-testid="notification-open"]';
const DISMISS_SELECTOR = '[data-testid="notification-dismiss"]';

/** A plain key press: no modifier held and no IME composition in progress. */
function isPlainKey(event: ReactKeyboardEvent) {
  return !(
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.nativeEvent.isComposing
  );
}

/** The row ArrowDown, ArrowUp, Home or End moves to, or null for any other key. */
function rowMovement(key: string, index: number, count: number): number | null {
  if (index < 0 || index >= count) return null;
  if (key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/**
 * Unread notifications of the current user (mentions, replies, resolutions, suggestion decisions,
 * shares), shown at the top of the dashboard. Renders nothing when there is nothing to show.
 * Clicking one marks it read and opens the document on the relevant thread.
 *
 * Marking a notification read takes it out of the store's unread list at once, so its row (or, for
 * "Mark all read", the whole strip) is gone before a second click can land, and the store shares one
 * in-flight request per notification.
 */
export function NotificationsStrip() {
  const router = useRouter();
  const { items, unreadCount } = useNotifications();
  const listRef = useRef<HTMLUListElement>(null);
  const unread = items.filter((notification) => !notification.readAt);
  if (unread.length === 0) return null;

  const open = (notification: NotificationDto) => {
    void markNotificationRead(notification.id);
    router.push(notificationHref(notification));
  };

  // The row leaves the list. If focus is in it, hand focus to the next row (or the previous one)
  // instead of letting it fall to <body>, so the keyboard stays in the list.
  const dismiss = (notification: NotificationDto, control: HTMLButtonElement) => {
    const row = control.closest("li");
    const neighbour = row?.contains(document.activeElement) ? (row.nextElementSibling ?? row.previousElementSibling) : null;
    void markNotificationRead(notification.id);
    neighbour?.querySelector<HTMLButtonElement>(OPEN_SELECTOR)?.focus({ preventScroll: true });
  };

  // On a row: the arrows, Home and End move between rows, ArrowRight reaches its "Mark as read"
  // button, and Delete marks it read.
  const onOpenKeyDown = (notification: NotificationDto, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!isPlainKey(event)) return;
    const button = event.currentTarget;
    if (event.key === "Delete") {
      if (event.repeat) return;
      event.preventDefault();
      dismiss(notification, button);
      return;
    }
    let destination: HTMLButtonElement | null | undefined;
    if (event.key === "ArrowRight") {
      destination = button.closest("li")?.querySelector<HTMLButtonElement>(DISMISS_SELECTOR);
    } else {
      const controls = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(OPEN_SELECTOR) ?? []);
      const next = rowMovement(event.key, controls.indexOf(button), controls.length);
      destination = next === null ? null : controls[next];
    }
    if (!destination) return;
    // A list key is always the list's: on a single row, or at the end Home or End points to, focus
    // stays and the page does not scroll.
    event.preventDefault();
    destination.focus({ preventScroll: true });
  };

  // On "Mark as read": ArrowLeft, ArrowUp and Home go back to the row.
  const onDismissKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!isPlainKey(event) || (event.key !== "ArrowLeft" && event.key !== "ArrowUp" && event.key !== "Home")) return;
    const destination = event.currentTarget.closest("li")?.querySelector<HTMLButtonElement>(OPEN_SELECTOR);
    if (!destination) return;
    event.preventDefault();
    destination.focus({ preventScroll: true });
  };

  return (
    <section
      className="mb-8 rounded-2xl border border-accent/40 bg-accent-soft/40 p-4"
      aria-label="Notifications"
      data-testid="notifications-strip"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Bell size={15} className="text-accent" /> Notifications
          <span className="text-ink-4">{unreadCount}</span>
        </h2>
        <button
          type="button"
          className="btn btn-ghost h-7 gap-1.5 px-2 text-xs"
          onClick={() => void markAllNotificationsRead()}
          data-testid="notifications-strip-read-all"
        >
          <CheckCheck size={14} /> Mark all read
        </button>
      </div>
      <ul ref={listRef} className="flex flex-col gap-1.5">
        {unread.map((notification) => (
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
              onClick={() => open(notification)}
              onKeyDown={(event) => onOpenKeyDown(notification, event)}
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
              {notification.snippet && notification.kind !== "share" && <span className="mt-0.5 block truncate text-ink-3" title={notification.snippet}>{notification.snippet}</span>}
            </button>
            <button
              type="button"
              className="icon-btn h-7 w-7 shrink-0"
              aria-label="Mark as read"
              title="Mark as read"
              onClick={(event) => dismiss(notification, event.currentTarget)}
              onKeyDown={onDismissKeyDown}
              data-testid="notification-dismiss"
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
