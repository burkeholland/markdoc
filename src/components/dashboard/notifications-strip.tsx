"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, X } from "lucide-react";
import type { NotificationDto } from "@/lib/api";
import { markAllNotificationsRead, markNotificationRead, sentence, useNotifications } from "@/lib/notifications-store";
import { KindIcon, actorLabel, cancelHeldPress } from "@/components/notifications/notifications-bell";
import { notificationHref } from "@/components/notifications/open";
import { RelativeTime } from "@/components/ui/relative-time";

const OPEN_SELECTOR = '[data-testid="notification-open"]';
const DISMISS_SELECTOR = '[data-testid="notification-dismiss"]';

/**
 * How long the strip waits at most for an opened document. Normally the page changes long before, and
 * the strip goes with it. The limit is for a navigation that ends on the dashboard itself.
 */
const OPEN_HOLD_MS = 30_000;
/**
 * The same, once the browser has started loading the document as a whole new page. That load can be
 * stopped (the Stop button, Escape) and nothing tells the page.
 */
const PAGE_LOAD_HOLD_MS = 8_000;
/**
 * How long the emptied strip keeps its box, counted from the last press on it. Longer than the slowest
 * double-click or double tap the system counts as one (0.9 s on Windows).
 */
const EMPTY_HOLD_MS = 1_000;
/** How long the box waits at most for the end of a press on it, in case that end never arrives. */
const EMPTY_PRESS_MS = 10_000;

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
 * The second or third click of a double or triple click (or tap). A row that is marked read leaves the
 * list at once and the next row moves up under the pointer, so the rest of the gesture would act on a
 * row the user never aimed at. A click from the keyboard has `detail` 0.
 */
function isRepeatedClick(event: ReactMouseEvent) {
  return event.detail > 1;
}

/** A click made with a mouse, a finger or a pen. A click from the keyboard has `detail` 0. */
function isPointerClick(event: ReactMouseEvent) {
  return event.detail > 0;
}

/**
 * Unread notifications of the current user (mentions, replies, resolutions, suggestion decisions,
 * shares), shown at the top of the dashboard. Renders nothing when there is nothing to show.
 * Clicking one marks it read and opens the relevant document or thread. Access requests stay unread until answered.
 *
 * One gesture is one action: a repeated click and the repeats of a held Enter or Space are ignored. The
 * store shares one in-flight request per notification.
 *
 * Nothing moves under the pointer because of the strip. While a row's document is opening the strip
 * stays as it was, the opened row included, and does nothing. When a click or a tap empties the strip,
 * an empty box keeps its place for a moment, so the rest of a double-click does not land on the
 * dashboard that would have moved up.
 */
export function NotificationsStrip() {
  const router = useRouter();
  const { items, unreadCount } = useNotifications();
  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  // The height of the strip a click or a tap has just emptied. Every press on the box starts the time again,
  // and while that press is down the box stays: its second starts when the press ends.
  const [emptyBox, setEmptyBox] = useState<{ height: number; pressed?: boolean } | null>(null);
  useEffect(() => {
    if (!emptyBox) return;
    const timer = window.setTimeout(() => setEmptyBox(null), emptyBox.pressed ? EMPTY_PRESS_MS : EMPTY_HOLD_MS);
    if (!emptyBox.pressed) return () => window.clearTimeout(timer);
    // The press can end anywhere: a mouse is released outside the box, a touch becomes a scroll.
    const pressEnded = () => setEmptyBox({ height: emptyBox.height });
    window.addEventListener("pointerup", pressEnded, true);
    window.addEventListener("pointercancel", pressEnded, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerup", pressEnded, true);
      window.removeEventListener("pointercancel", pressEnded, true);
    };
  }, [emptyBox]);
  // The strip as it was when a row was opened, from that activation until the page changes. The page
  // normally changes, and this component goes with it. This is plain state, not a transition around
  // `router.push`: the app router keeps a transition pending for ever once it has fallen back to
  // loading the page as a whole, so "pending" could not say when the wait is over.
  const [opened, setOpened] = useState<{ rows: NotificationDto[]; unreadCount: number } | null>(null);
  const opening = opened !== null;
  useEffect(() => {
    if (!opening) return;
    // The strip follows the list again. If that empties it, its box stays for a moment, as after a click.
    const release = () => {
      setEmptyBox({ height: sectionRef.current?.getBoundingClientRect().height ?? 0 });
      setOpened(null);
    };
    let timer = window.setTimeout(release, OPEN_HOLD_MS);
    // The browser starts loading another page. This page stays until that one answers, or for good.
    const pageLoadStarted = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(release, PAGE_LOAD_HOLD_MS);
    };
    window.addEventListener("beforeunload", pageLoadStarted);
    // Back or Forward ends the navigation here. A `pageshow` that is `persisted`: this page is shown
    // again after the browser had kept it for Back. Every ordinary page load ends with a `pageshow` too.
    const shownAgain = (event: PageTransitionEvent) => {
      if (event.persisted) release();
    };
    window.addEventListener("popstate", release);
    window.addEventListener("pageshow", shownAgain);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("beforeunload", pageLoadStarted);
      window.removeEventListener("popstate", release);
      window.removeEventListener("pageshow", shownAgain);
    };
  }, [opening]);

  // The user emptied the strip while focus was in it. The control that had focus is gone, so a status
  // line takes the strip's place and the focus, and stays until focus moves on.
  const [emptied, setEmptied] = useState(false);
  useLayoutEffect(() => {
    if (emptied) statusRef.current?.focus({ preventScroll: true });
  }, [emptied]);
  const unread = items.filter((notification) => !notification.readAt);
  const rows = opening ? opened.rows : unread;
  if (rows.length === 0 && !emptied && !emptyBox) return null;

  const open = (notification: NotificationDto, event: ReactMouseEvent) => {
    if (opening || isRepeatedClick(event)) return;
    setOpened({ rows: unread, unreadCount });
    if (notification.kind !== "access.request" || !notification.actorLogin) {
      void markNotificationRead(notification.id);
    }
    router.push(notificationHref(notification));
  };

  const keepBox = () => setEmptyBox({ height: sectionRef.current?.getBoundingClientRect().height ?? 0 });

  // The row leaves the list. If focus is in it, hand focus to the next row (or the previous one)
  // instead of letting it fall to <body>, so the keyboard stays in the list; after the last row, to
  // the status line.
  const dismiss = (notification: NotificationDto, control: HTMLButtonElement, pointer = false) => {
    if (opening) return;
    const row = control.closest("li");
    const focused = row?.contains(document.activeElement) ?? false;
    const neighbour = focused ? (row?.nextElementSibling ?? row?.previousElementSibling) : null;
    if (pointer && rows.length === 1) keepBox();
    void markNotificationRead(notification.id);
    if (neighbour) neighbour.querySelector<HTMLButtonElement>(OPEN_SELECTOR)?.focus({ preventScroll: true });
    else if (focused) setEmptied(true);
  };

  const readAll = (event: ReactMouseEvent) => {
    if (opening) return;
    if (isPointerClick(event)) keepBox();
    if (sectionRef.current?.contains(document.activeElement)) setEmptied(true);
    void markAllNotificationsRead();
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

  const strip = rows.length > 0 && (
    <section
      ref={sectionRef}
      className="mb-8 rounded-2xl border border-accent/40 bg-accent-soft/40 p-4"
      aria-label="Notifications"
      data-testid="notifications-strip"
      onKeyDown={cancelHeldPress}
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Bell size={15} className="text-accent" /> Notifications
          <span className="text-ink-4">{opening ? opened.unreadCount : unreadCount}</span>
        </h2>
        <button
          type="button"
          className="btn btn-ghost h-7 gap-1.5 px-2 text-xs"
          onClick={readAll}
          data-testid="notifications-strip-read-all"
        >
          <CheckCheck size={14} /> Mark all read
        </button>
      </div>
      <ul ref={listRef} className="flex flex-col gap-1.5">
        {rows.map((notification) => (
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
              onClick={(event) => open(notification, event)}
              onKeyDown={(event) => onOpenKeyDown(notification, event)}
              data-testid="notification-open"
            >
              <span className="text-ink-2">
                <span className="font-medium text-ink">{actorLabel(notification)}</span> {sentence(notification)}
                {notification.kind !== "share" && notification.kind !== "access.request" && (
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
              {notification.snippet && notification.kind !== "share" && notification.kind !== "access.request" && <span className="mt-0.5 block truncate text-ink-3" title={notification.snippet}>{notification.snippet}</span>}
            </button>
            <button
              type="button"
              className="icon-btn h-7 w-7 shrink-0"
              aria-label="Mark as read"
              title="Mark as read"
              onClick={(event) => {
                if (!isRepeatedClick(event)) dismiss(notification, event.currentTarget, isPointerClick(event));
              }}
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

  // Visible to assistive technology only. It says nothing if rows come back under it (a failed request).
  const status = emptied && (
    <p
      ref={statusRef}
      tabIndex={-1}
      role="status"
      className="sr-only"
      // The window losing focus blurs it too, but it stays the active element then.
      onBlur={(event) => {
        if (document.activeElement !== event.currentTarget) setEmptied(false);
      }}
      data-testid="notifications-strip-status"
    >
      {rows.length === 0 && "No unread notifications"}
    </p>
  );

  // The emptied strip's box: nothing to read, nothing to focus, nothing to press. Rows that come back
  // (a failed request) take its place.
  const box = emptyBox && (
    <div
      className="mb-8"
      style={{ height: emptyBox.height }}
      onPointerDown={() => setEmptyBox({ height: emptyBox.height, pressed: true })}
      data-testid="notifications-strip-emptied"
    >
      <div inert className="h-full rounded-2xl border border-accent/40 bg-accent-soft/40" />
    </div>
  );

  // Each keeps its place in the fragment, so the status line keeps its focus when rows come back.
  return (
    <>
      {status}
      {strip || box}
    </>
  );
}
