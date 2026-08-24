"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api, type NotificationDto } from "@/lib/api";
import type { NotificationKind } from "@/server/db/schema";

export const NOTIFICATIONS_POLL_MS = 30_000;
const PAGE = 20;

interface State {
  items: NotificationDto[];
  unreadCount: number;
  loaded: boolean;
}

/**
 * One shared, polled copy of the signed-in user's notifications for every bell, strip and
 * comment card on the page. Polls while the tab is visible and at least one component is mounted.
 */
let state: State = { items: [], unreadCount: 0, loaded: false };
const listeners = new Set<() => void>();
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
let enabled = true;

function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function refreshNotifications(): Promise<void> {
  if (!enabled) return Promise.resolve();
  if (inflight) return inflight;
  inflight = api.notifications
    .list({ limit: PAGE })
    .then((page) => set({ items: page.items, unreadCount: page.unreadCount, loaded: true }))
    .catch((err) => {
      // Anonymous link visitors have no notifications; stop asking.
      if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 401) enabled = false;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function start() {
  if (timer !== null || typeof document === "undefined") return;
  if (document.visibilityState !== "visible") return;
  timer = setInterval(() => void refreshNotifications(), NOTIFICATIONS_POLL_MS);
}

function stop() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

function onVisibility() {
  if (document.visibilityState === "visible") {
    void refreshNotifications();
    start();
  } else stop();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (subscribers++ === 0) {
    void refreshNotifications();
    start();
    document.addEventListener("visibilitychange", onVisibility);
  }
  return () => {
    listeners.delete(listener);
    if (--subscribers === 0) {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

const getSnapshot = () => state;
const SERVER: State = { items: [], unreadCount: 0, loaded: false };
const getServerSnapshot = () => SERVER;

function markLocal(pred: (n: NotificationDto) => boolean) {
  const now = new Date().toISOString();
  let changed = 0;
  const items = state.items.map((n) => {
    if (n.readAt || !pred(n)) return n;
    changed++;
    return { ...n, readAt: now };
  });
  if (changed) set({ items, unreadCount: Math.max(0, state.unreadCount - changed) });
  return changed;
}

export async function markNotificationRead(id: string) {
  markLocal((n) => n.id === id);
  try {
    await api.notifications.read(id);
  } catch {
    // Already read or gone.
  }
}

export async function markAllNotificationsRead() {
  markLocal(() => true);
  set({ unreadCount: 0 });
  try {
    await api.notifications.readAll();
  } catch {
    // Transient; the next poll reconciles.
  }
}

/** Mark read everything about a thread (its id and its replies' ids) in a document. */
export async function markRefsRead(documentId: string, refIds: string[]) {
  if (refIds.length === 0) return;
  const refs = new Set(refIds);
  // Unread rows beyond the loaded page may exist; ask the server regardless of the local view.
  const local = markLocal((n) => n.documentId === documentId && refs.has(n.refId));
  if (local === 0 && state.loaded && state.unreadCount === 0) return;
  try {
    const res = await api.notifications.readRefs(documentId, refIds);
    if (res.count > local) void refreshNotifications();
  } catch {
    // Transient; the next poll reconciles.
  }
}

export function useNotifications(): State {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// Lets tests (and the console) pull instead of waiting for the next poll, like `__markdocSession`.
if (typeof window !== "undefined") {
  (window as unknown as { __markdocNotificationsRefresh?: () => Promise<void> }).__markdocNotificationsRefresh = refreshNotifications;
}

/** Unread notifications about a document keyed by ref id (thread, reply or suggestion id). */
export function useUnreadRefs(documentId: string): Set<string> {
  const { items } = useNotifications();
  const key = items
    .filter((n) => !n.readAt && n.documentId === documentId)
    .map((n) => n.refId)
    .join("\u0000");
  return new Set(key ? key.split("\u0000") : []);
}

/** Re-fetch soon after something that probably produced a notification for someone else (no-op for the actor, cheap). */
export function useNotificationsRefresh() {
  return useCallback(() => void refreshNotifications(), []);
}

/** Mount once per page to keep polling alive even when no bell is rendered (e.g. the dashboard). */
export function useNotificationsPolling() {
  useEffect(() => subscribe(() => {}), []);
}

export function sentence(n: Pick<NotificationDto, "kind" | "documentTitle" | "snippet">): string {
  switch (n.kind) {
    case "mention":
      return "mentioned you";
    case "reply":
      return "replied to your comment";
    case "resolve":
      return "resolved your thread";
    case "reopen":
      return "re-opened your thread";
    case "suggestion.accept":
      return "accepted your suggestion";
    case "suggestion.reject":
      return "rejected your suggestion";
    case "suggestion.accepted":
      return `accepted your suggested change${n.snippet ? ` to \u2018${n.snippet}\u2019` : ""}`;
    case "review":
      return `reviewed \u2018${n.documentTitle}\u2019${n.snippet ? ` \u2014 ${n.snippet}` : ""}`;
    case "share":
      return `shared \u2018${n.documentTitle}\u2019 with you${n.snippet ? ` as ${n.snippet}` : ""}`;
    case "request.done":
      return `finished your request${n.snippet ? `: ${n.snippet}` : ""}`;
  }
}

export const KIND_LABEL: Record<NotificationKind, string> = {
  mention: "Mention",
  reply: "Reply",
  resolve: "Resolved",
  reopen: "Re-opened",
  "suggestion.accept": "Accepted",
  "suggestion.reject": "Rejected",
  "suggestion.accepted": "Suggestion accepted",
  review: "Review",
  share: "Shared",
  "request.done": "Agent done",
};
