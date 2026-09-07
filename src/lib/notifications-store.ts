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
  loading: boolean;
  loadError: boolean;
  readAllPending: boolean;
  readError: NotificationReadError | null;
  readErrorPending: boolean;
}

export type NotificationReadError =
  | { id: number; operationId: number; operation: "single"; message: string; notificationId: string }
  | { id: number; operationId: number; operation: "all"; message: string }
  | { id: number; operationId: number; operation: "refs"; message: string; documentId: string; refIds: string[] };

type OperationScope =
  | { kind: "all" }
  | { kind: "ids"; ids: Set<string> }
  | { kind: "refs"; documentId: string; refIds: Set<string> };

interface ReadOperation {
  id: number;
  key: string;
  operation: NotificationReadError["operation"];
  scope: OperationScope;
  cacheRevision: number;
  superseded: boolean;
  retryErrorId: number | null;
  optimisticAt: string;
  promise: Promise<void>;
  notificationId?: string;
  documentId?: string;
  refIds?: string[];
  localChanged: number;
}

type ReadOperationInit = Omit<ReadOperation, "id" | "cacheRevision" | "superseded" | "retryErrorId" | "optimisticAt" | "promise">;

interface RefreshOperation {
  id: number;
  cacheRevision: number;
  promise: Promise<void>;
}

/**
 * One shared, polled copy of the signed-in user's notifications for every bell, strip and
 * comment card on the page. Polls while the tab is visible and at least one component is mounted.
 */
let cache = { items: [] as NotificationDto[], unreadCount: 0 };
let state: State = {
  items: [],
  unreadCount: 0,
  loaded: false,
  loading: true,
  loadError: false,
  readAllPending: false,
  readError: null,
  readErrorPending: false,
};
const listeners = new Set<() => void>();
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: RefreshOperation | null = null;
let enabled = true;
let cacheRevision = 0;
let nextOperationId = 0;
let nextErrorId = 0;
const singleReads = new Map<string, ReadOperation>();
const refReads = new Map<string, ReadOperation>();
let readAll: ReadOperation | null = null;

function operations(): ReadOperation[] {
  return [...singleReads.values(), ...refReads.values(), ...(readAll ? [readAll] : [])];
}

function affects(op: ReadOperation, notification: NotificationDto): boolean {
  if (op.scope.kind === "all") return true;
  if (op.scope.kind === "ids") return op.scope.ids.has(notification.id);
  return notification.documentId === op.scope.documentId && op.scope.refIds.has(notification.refId);
}

function isPending(error: NotificationReadError | null): boolean {
  if (!error) return false;
  if (error.operation === "all") return readAll?.retryErrorId === error.id;
  if (error.operation === "single") return singleReads.get(error.notificationId)?.retryErrorId === error.id;
  return refReads.get(refKey(error.documentId, error.refIds))?.retryErrorId === error.id;
}

function publish(next: Partial<State> = {}) {
  const active = operations();
  let changed = 0;
  const items = cache.items.map((notification) => {
    if (notification.readAt) return notification;
    const owner = active.find((op) => affects(op, notification));
    if (!owner) return notification;
    changed++;
    return { ...notification, readAt: owner.optimisticAt };
  });
  const unreadCount = readAll ? 0 : Math.max(0, cache.unreadCount - changed);
  const readError = Object.prototype.hasOwnProperty.call(next, "readError") ? (next.readError ?? null) : state.readError;
  state = {
    ...state,
    ...next,
    items,
    unreadCount,
    readAllPending: readAll !== null,
    readError,
    readErrorPending: isPending(readError),
  };
  for (const l of listeners) l();
}

export function refreshNotifications(): Promise<void> {
  if (!enabled) return Promise.resolve();
  if (inflight) return inflight.promise;

  let resolveOwner!: () => void;
  let rejectOwner!: (reason?: unknown) => void;
  const shared = new Promise<void>((resolve, reject) => {
    resolveOwner = resolve;
    rejectOwner = reject;
  });
  const owner: RefreshOperation = {
    id: ++nextOperationId,
    cacheRevision,
    promise: shared,
  };
  inflight = owner;
  publish({ loading: true });

  let request: ReturnType<typeof api.notifications.list>;
  try {
    request = api.notifications.list({ limit: PAGE });
  } catch (error) {
    request = Promise.reject(error);
  }

  const settlement = request
    .then((page) => {
      if (inflight !== owner || owner.cacheRevision !== cacheRevision) return;
      cache = { items: page.items, unreadCount: page.unreadCount };
      cacheRevision++;
      for (const operation of operations()) operation.superseded = true;
      publish({ loaded: true, loadError: false, readError: null });
    })
    .catch((err: unknown) => {
      if (inflight !== owner || owner.cacheRevision !== cacheRevision) return;
      // Anonymous link visitors have no notifications; stop asking.
      if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 401) {
        enabled = false;
        publish({ loadError: false });
        return;
      }
      publish({ loadError: !state.loaded });
    })
    .finally(() => {
      if (inflight !== owner) return;
      inflight = null;
      publish({ loading: false });
    });
  void settlement.then(resolveOwner, rejectOwner);
  return owner.promise;
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
const SERVER: State = {
  items: [],
  unreadCount: 0,
  loaded: false,
  loading: false,
  loadError: false,
  readAllPending: false,
  readError: null,
  readErrorPending: false,
};
const getServerSnapshot = () => SERVER;

function scopesOverlap(left: OperationScope, right: OperationScope): boolean {
  if (left.kind === "all" || right.kind === "all") return true;
  if (left.kind === "refs" && right.kind === "refs") {
    if (left.documentId !== right.documentId) return false;
    for (const refId of left.refIds) {
      if (right.refIds.has(refId)) return true;
    }
    return false;
  }
  if (left.kind === "ids" && right.kind === "ids") {
    for (const id of left.ids) {
      if (right.ids.has(id)) return true;
    }
    return false;
  }
  const ids = left.kind === "ids" ? left.ids : right.kind === "ids" ? right.ids : new Set<string>();
  const refs = left.kind === "refs" ? left : right.kind === "refs" ? right : null;
  return refs !== null && cache.items.some((notification) => ids.has(notification.id) && notification.documentId === refs.documentId && refs.refIds.has(notification.refId));
}

function commitRead(owner: ReadOperation, pred: (notification: NotificationDto) => boolean, scope: OperationScope, all = false) {
  const now = new Date().toISOString();
  let changed = 0;
  const items = cache.items.map((notification) => {
    if (notification.readAt || !pred(notification)) return notification;
    changed++;
    return { ...notification, readAt: now };
  });
  cache = {
    items,
    unreadCount: all ? 0 : Math.max(0, cache.unreadCount - changed),
  };
  cacheRevision++;

  for (const operation of operations()) {
    if (operation === owner) {
      operation.cacheRevision = cacheRevision;
    } else if (scopesOverlap(operation.scope, scope)) {
      operation.superseded = true;
    } else if (!operation.superseded) {
      operation.cacheRevision = cacheRevision;
    }
  }
}

function isOwner(operation: ReadOperation): boolean {
  if (operation.operation === "all") return readAll === operation;
  if (operation.operation === "single") return singleReads.get(operation.key) === operation;
  return refReads.get(operation.key) === operation;
}

function unregister(operation: ReadOperation) {
  if (operation.operation === "all") {
    if (readAll === operation) readAll = null;
  } else if (operation.operation === "single") {
    if (singleReads.get(operation.key) === operation) singleReads.delete(operation.key);
  } else if (refReads.get(operation.key) === operation) {
    refReads.delete(operation.key);
  }
}

function failureMatches(error: NotificationReadError | null, operation: Pick<ReadOperation, "operation" | "notificationId" | "key">): boolean {
  if (!error || error.operation !== operation.operation) return false;
  if (error.operation === "all") return true;
  if (error.operation === "single") return error.notificationId === operation.notificationId;
  return refKey(error.documentId, error.refIds) === operation.key;
}

function failureFor(operation: ReadOperation): NotificationReadError {
  const id = ++nextErrorId;
  if (operation.operation === "single") {
    return {
      id,
      operationId: operation.id,
      operation: "single",
      message: "Couldn't mark this notification as read.",
      notificationId: operation.notificationId!,
    };
  }
  if (operation.operation === "refs") {
    return {
      id,
      operationId: operation.id,
      operation: "refs",
      message: "Couldn't mark these notifications as read.",
      documentId: operation.documentId!,
      refIds: operation.refIds!,
    };
  }
  return { id, operationId: operation.id, operation: "all", message: "Couldn't mark all notifications as read." };
}

function beginRead<T>(
  operation: ReadOperationInit,
  register: (owner: ReadOperation) => void,
  request: () => Promise<T>,
  onSuccess: (result: T, owner: ReadOperation) => void,
): Promise<void> {
  const retryError = state.readError;
  let resolveOwner!: () => void;
  let rejectOwner!: (reason?: unknown) => void;
  const shared = new Promise<void>((resolve, reject) => {
    resolveOwner = resolve;
    rejectOwner = reject;
  });
  const owner: ReadOperation = {
    ...operation,
    id: ++nextOperationId,
    cacheRevision,
    superseded: false,
    retryErrorId: retryError && failureMatches(retryError, operation) ? retryError.id : null,
    optimisticAt: new Date().toISOString(),
    promise: shared,
  };
  register(owner);
  publish();

  let pending: Promise<T>;
  try {
    pending = request();
  } catch (error) {
    pending = Promise.reject(error);
  }

  const settlement = pending
    .then(
      (result) => {
        if (!isOwner(owner) || owner.superseded || owner.cacheRevision !== cacheRevision) return;
        onSuccess(result, owner);
        const readError = state.readError?.id === owner.retryErrorId ? null : state.readError;
        publish({ readError });
      },
      () => {
        if (!isOwner(owner) || owner.superseded || owner.cacheRevision !== cacheRevision) return;
        const current = state.readError;
        if (current && current.operationId > owner.id) return;
        publish({ readError: failureFor(owner) });
      },
    )
    .finally(() => {
      if (!isOwner(owner)) return;
      unregister(owner);
      publish();
    });
  void settlement.then(resolveOwner, rejectOwner);
  return owner.promise;
}

function idsFor(pred: (notification: NotificationDto) => boolean): Set<string> {
  return new Set(cache.items.filter((notification) => !notification.readAt && pred(notification)).map((notification) => notification.id));
}

function refKey(documentId: string, refIds: string[]): string {
  return JSON.stringify([documentId, [...new Set(refIds)].sort()]);
}

export function markNotificationRead(id: string): Promise<void> {
  const current = singleReads.get(id);
  if (current) return current.promise;
  const scope: OperationScope = { kind: "ids", ids: idsFor((notification) => notification.id === id) };
  return beginRead(
    { key: id, operation: "single", scope, notificationId: id, localChanged: scope.ids.size },
    (owner) => singleReads.set(id, owner),
    () => api.notifications.read(id),
    (_result, owner) => commitRead(owner, (notification) => notification.id === id, { kind: "ids", ids: new Set([id]) }),
  );
}

export function markAllNotificationsRead(): Promise<void> {
  if (readAll) return readAll.promise;
  return beginRead(
    { key: "all", operation: "all", scope: { kind: "all" }, localChanged: state.unreadCount },
    (owner) => {
      readAll = owner;
    },
    () => api.notifications.readAll(),
    (_result, owner) => commitRead(owner, () => true, { kind: "all" }, true),
  );
}

/** Mark read everything about a thread (its id and its replies' ids) in a document. */
export function markRefsRead(documentId: string, refIds: string[]): Promise<void> {
  if (refIds.length === 0) return Promise.resolve();
  const normalizedRefs = [...new Set(refIds)].sort();
  const key = refKey(documentId, normalizedRefs);
  const current = refReads.get(key);
  if (current) return current.promise;
  const refs = new Set(normalizedRefs);
  const pred = (notification: NotificationDto) => notification.documentId === documentId && refs.has(notification.refId);
  // Unread rows beyond the loaded page may exist; ask the server regardless of the local view.
  const local = state.items.filter((notification) => !notification.readAt && pred(notification)).length;
  if (local === 0 && state.loaded && state.unreadCount === 0) return Promise.resolve();
  const scope: OperationScope = { kind: "refs", documentId, refIds: refs };
  return beginRead(
    { key, operation: "refs", scope, documentId, refIds: normalizedRefs, localChanged: local },
    (owner) => refReads.set(key, owner),
    () => api.notifications.readRefs(documentId, normalizedRefs),
    (result, owner) => {
      commitRead(owner, pred, scope);
      if (result.count > owner.localChanged) void refreshNotifications();
    },
  );
}

export function retryNotificationRead(error: NotificationReadError): Promise<void> {
  if (state.readError?.id !== error.id) return Promise.resolve();
  if (error.operation === "single") return markNotificationRead(error.notificationId);
  if (error.operation === "refs") return markRefsRead(error.documentId, error.refIds);
  return markAllNotificationsRead();
}

const noopSubscribe = () => () => {};

/**
 * Live notifications. `ready: false` renders the empty snapshot without subscribing (so nothing is
 * fetched yet); the editor passes it until the document is synced so the first poll does not
 * compete with the open (#118).
 */
export function useNotifications(ready = true): State {
  return useSyncExternalStore(ready ? subscribe : noopSubscribe, ready ? getSnapshot : getServerSnapshot, getServerSnapshot);
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
    case "webhook.disabled":
      return `disabled your webhook after 20 failed deliveries${n.snippet ? ` (${n.snippet})` : ""} \u2014 enable the existing hook in Settings`;
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
  "webhook.disabled": "Webhook disabled",
};
