"use client";

import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AtSign, Bell, Bot, CheckCheck, KeyRound, CircleCheck, ClipboardCheck, Reply, RotateCcw, ThumbsDown, ThumbsUp, UserPlus, WebhookOff } from "lucide-react";
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
import { clamp, cn } from "@/lib/utils";

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
  "access.request": KeyRound,
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
  /** Called after opening the item; unread access requests stay unread until the owner responds. */
  onOpen: (n: NotificationDto) => void;
  /** False while the page is still opening: the bell renders without fetching or polling yet. */
  ready?: boolean;
}

/** Rows PageDown and PageUp move by. */
const PAGE_ROWS = 10;

const ROW_SELECTOR = '[data-testid="notification-item"]';

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

/**
 * One press is one action. A held Enter repeats its keydown, and the browser presses whichever button
 * has focus by then: a row closes the popover, focus returns to the bell, the next repeat opens the
 * bell again and the one after opens its first row. Cancelling the repeats stops those presses; the
 * first keydown, and Space, which presses on release, are left to the button.
 */
export function cancelHeldPress(event: ReactKeyboardEvent) {
  if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
}

/**
 * Focuses a row without letting the browser scroll anything, then scrolls the list, and only the
 * list, just far enough to show the row. The page and the popover stay where they are.
 */
function focusRow(row: HTMLElement | undefined) {
  const list = row?.closest("ul");
  if (!row || !list) return;
  row.focus({ preventScroll: true });
  const view = list.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  if (box.top < view.top) list.scrollTop -= view.top - box.top;
  else if (box.bottom > view.bottom) list.scrollTop += box.bottom - view.bottom;
}

/** The row a list key moves focus to, or null when the key does not move focus. */
function rowMovement(key: string, index: number, count: number): number | null {
  if (index < 0 || index >= count) return null;
  if (key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "PageDown" || key === "PageUp") {
    const next = clamp(index + (key === "PageDown" ? PAGE_ROWS : -PAGE_ROWS), 0, count - 1);
    return next === index ? null : next;
  }
  return null;
}

function NotificationItem({
  notification,
  currentDocId,
  onOpen,
}: {
  notification: NotificationDto;
  currentDocId: string | undefined;
  onOpen: (notification: NotificationDto) => void;
}) {
  return (
    <button
      type="button"
      className={cn("flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-surface-2", !notification.readAt && "bg-accent-soft/30")}
      onClick={() => onOpen(notification)}
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
          {notification.kind !== "share" && notification.kind !== "access.request" && notification.documentId !== currentDocId && (
            <>
              {" "}
              in <span className="font-medium text-ink">{notification.documentTitle}</span>
            </>
          )}
        </span>
        {notification.snippet && notification.kind !== "share" && (
          <span className="mt-0.5 block truncate text-xs text-ink-3" title={notification.snippet}>{notification.snippet}</span>
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
  const titleId = useId();
  const [open, setOpen] = useState(false);
  // The rows are worded for the document that is open, so the popover closes when another one is opened in place.
  const [listedDocId, setListedDocId] = useState(currentDocId);
  if (listedDocId !== currentDocId) {
    setListedDocId(currentDocId);
    setOpen(false);
  }
  const contentRef = useRef<HTMLDivElement>(null);
  // The element inside the popover that last took focus.
  const lastFocused = useRef<EventTarget | null>(null);
  // Set by ArrowDown/ArrowUp on the closed bell: the row that takes focus when the popover opens.
  const focusOnOpen = useRef<"first" | "last" | null>(null);

  const rows = () => Array.from(contentRef.current?.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR) ?? []);

  // A button that disables itself while focused (Mark all read, either Retry) cannot keep focus: the
  // browser drops it on <body>, outside the popover, or leaves it on a dead control. Hand it to the
  // popover instead, so the keyboard carries on from where the user was and closing returns focus to the bell.
  useLayoutEffect(() => {
    const content = contentRef.current;
    const last = lastFocused.current;
    const active = document.activeElement;
    if (
      content &&
      last instanceof HTMLButtonElement &&
      last.disabled &&
      content.contains(last) &&
      (active === last || active === document.body || !active)
    ) {
      content.focus({ preventScroll: true });
    }
  });

  // Closing on the click removes the rows, so one notification is opened once; the store also shares one
  // in-flight request per notification.
  const openNotification = (notification: NotificationDto) => {
    if (notification.kind !== "access.request" || notification.readAt || !notification.actorLogin) {
      void markNotificationRead(notification.id);
    }
    setOpen(false);
    onOpen(notification);
  };

  const onBellKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    cancelHeldPress(event);
    if (open || !isPlainKey(event) || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    focusOnOpen.current = event.key === "ArrowDown" ? "first" : "last";
    setOpen(true);
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (!isPlainKey(event)) return;
    const list = rows();
    const next = rowMovement(event.key, list.indexOf(event.target as HTMLButtonElement), list.length);
    if (next === null) return;
    event.preventDefault();
    focusRow(list[next]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label="Notifications">
        <PopoverTrigger asChild>
          <button
            type="button"
            className="icon-btn relative tap-target editor-header-action"
            aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
            data-testid="notifications-bell"
            data-unread={unreadCount}
            onKeyDown={onBellKeyDown}
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
      <PopoverContent
        ref={contentRef}
        align="end"
        collisionPadding={8}
        className="w-[min(380px,calc(100vw-16px))] p-0"
        aria-labelledby={titleId}
        data-testid="notifications-popover"
        onKeyDown={cancelHeldPress}
        onFocus={(event) => {
          lastFocused.current = event.target;
        }}
        onOpenAutoFocus={(event) => {
          const edge = focusOnOpen.current;
          focusOnOpen.current = null;
          if (!edge) return;
          // Opened with an arrow key: focus the first or last row, or stay on the bell when there is none.
          event.preventDefault();
          const list = rows();
          focusRow(edge === "first" ? list[0] : list[list.length - 1]);
        }}
      >
        <div className="flex h-10 items-center justify-between border-b border-line px-3">
          <span id={titleId} className="text-sm font-semibold text-ink">Notifications</span>
          {unreadCount > 0 && (
            <span className="text-xs text-ink-4" data-testid="notifications-unread-count">
              {unreadCount} unread
            </span>
          )}
        </div>
        <ul className="scrollbar-thin max-h-[420px] overflow-y-auto py-1" aria-label="Notifications" onKeyDown={onListKeyDown}>
          {readError && (
            <li className="px-3 py-2">
              <div className="flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
                <span className="min-w-0 wrap-anywhere">{readError.message}</span>
                <button
                  type="button"
                  className="btn btn-outline h-7 shrink-0 px-2 text-xs"
                  disabled={readErrorPending}
                  onClick={() => void retryNotificationRead(readError)}
                  data-testid="notifications-read-retry"
                >
                  {readErrorPending ? "Retrying…" : "Retry"}
                </button>
              </div>
            </li>
          )}
          {/* Not loaded and no error: still loading, or the page is not ready and nothing was asked for yet. */}
          {!loaded && !loadError && (
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
                  onClick={() => void refreshNotifications()}
                  data-testid="notifications-load-retry"
                >
                  {loading ? "Retrying…" : "Retry"}
                </button>
              </div>
            </li>
          )}
          {loaded && items.length === 0 && (
            <li className="px-3 py-8 text-center text-sm text-ink-4">You&apos;re all caught up.</li>
          )}
          {items.map((notification) => (
            <li key={notification.id}>
              <NotificationItem notification={notification} currentDocId={currentDocId} onOpen={openNotification} />
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
