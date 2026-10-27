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
  optimisticIds: Set<string>;
  cacheRevision: number;
  superseded: boolean;
  fullyConfirmed: boolean;
  retryErrorId: number | null;
  optimisticAt: string;
  promise: Promise<void>;
  notificationId?: string;
  documentId?: string;
  refIds?: string[];
  localChanged: number;
}

type ReadOperationInit = Omit<
  ReadOperation,
  "id" | "cacheRevision" | "superseded" | "fullyConfirmed" | "retryErrorId" | "optimisticAt" | "promise"
>;

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
  return op.optimisticIds.has(notification.id);
}

function isPending(error: NotificationReadError | null): boolean {
  return error !== null && operations().some((operation) => operation.retryErrorId === error.id);
}

function publish(next: Partial<State> = {}) {
  const active = operations().filter((operation) => !operation.superseded);
  let changed = 0;
  const items = cache.items.map((notification) => {
    if (notification.readAt) return notification;
    const owner = active.find((op) => affects(op, notification));
    if (!owner) return notification;
    changed++;
    return { ...notification, readAt: owner.optimisticAt };
  });
  const unreadCount = readAll && !readAll.superseded ? 0 : Math.max(0, cache.unreadCount - changed);
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
      for (const operation of operations()) {
        if (operation.id < owner.id) operation.superseded = true;
        else if (!operation.superseded) operation.cacheRevision = cacheRevision;
      }
      const readError = state.readError && state.readError.operationId > owner.id ? state.readError : null;
      publish({ loaded: true, loadError: false, readError });
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

function scopeIncludes(scope: OperationScope, notification: NotificationDto): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "ids") return scope.ids.has(notification.id);
  return notification.documentId === scope.documentId && scope.refIds.has(notification.refId);
}

function reconcileOperation(operation: ReadOperation, confirmed: OperationScope) {
  for (const notification of cache.items) {
    if (scopeIncludes(confirmed, notification)) operation.optimisticIds.delete(notification.id);
  }

  if (confirmed.kind === "all") {
    operation.fullyConfirmed = true;
    if (operation.scope.kind === "ids") operation.scope.ids.clear();
    if (operation.scope.kind === "refs") operation.scope.refIds.clear();
    return;
  }
  if (operation.scope.kind === "ids") {
    if (confirmed.kind === "ids") {
      for (const id of confirmed.ids) operation.scope.ids.delete(id);
    } else {
      for (const notification of cache.items) {
        if (scopeIncludes(confirmed, notification)) operation.scope.ids.delete(notification.id);
      }
    }
    return;
  }
  if (operation.scope.kind === "refs" && confirmed.kind === "refs" && operation.scope.documentId === confirmed.documentId) {
    for (const refId of confirmed.refIds) operation.scope.refIds.delete(refId);
  }
}

function reconcileError(error: NotificationReadError | null, confirmed: OperationScope): NotificationReadError | null {
  if (!error) return null;
  if (error.operation === "all") {
    return confirmed.kind === "all" || cache.unreadCount === 0 ? null : error;
  }
  if (error.operation === "single") {
    if (confirmed.kind === "all" || (confirmed.kind === "ids" && confirmed.ids.has(error.notificationId))) return null;
    if (confirmed.kind === "refs") {
      const notification = cache.items.find((item) => item.id === error.notificationId);
      if (notification && scopeIncludes(confirmed, notification)) return null;
    }
    return error;
  }
  if (confirmed.kind === "all") return null;
  if (confirmed.kind !== "refs" || confirmed.documentId !== error.documentId) return error;
  const refIds = error.refIds.filter((refId) => !confirmed.refIds.has(refId));
  if (refIds.length === 0) return null;
  return refIds.length === error.refIds.length ? error : { ...error, refIds };
}

function hasRemainingEffect(operation: ReadOperation): boolean {
  if (operation.fullyConfirmed) return false;
  if (operation.scope.kind === "all") return cache.unreadCount > 0;
  if (operation.scope.kind === "ids") return operation.scope.ids.size > 0;
  return operation.scope.refIds.size > 0 && (operation.optimisticIds.size > 0 || cache.unreadCount > 0);
}

function commitRead(pred: (notification: NotificationDto) => boolean, scope: OperationScope, all = false): NotificationReadError | null {
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
    if (operation.superseded) continue;
    reconcileOperation(operation, scope);
    operation.cacheRevision = cacheRevision;
  }
  return reconcileError(state.readError, scope);
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
    const refIds = operation.scope.kind === "refs" ? [...operation.scope.refIds].sort() : operation.refIds!;
    return {
      id,
      operationId: operation.id,
      operation: "refs",
      message: "Couldn't mark these notifications as read.",
      documentId: operation.documentId!,
      refIds,
    };
  }
  return { id, operationId: operation.id, operation: "all", message: "Couldn't mark all notifications as read." };
}

function beginRead<T>(
  operation: ReadOperationInit,
  register: (owner: ReadOperation) => void,
  request: () => Promise<T>,
  onSuccess: (result: T, owner: ReadOperation) => NotificationReadError | null,
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
    fullyConfirmed: false,
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
        const readError = onSuccess(result, owner);
        publish({ readError });
      },
      () => {
        if (!isOwner(owner) || owner.superseded || owner.cacheRevision !== cacheRevision) return;
        if (!hasRemainingEffect(owner)) return;
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
  const ids = idsFor((notification) => notification.id === id);
  const scope: OperationScope = { kind: "ids", ids: new Set(ids) };
  return beginRead(
    { key: id, operation: "single", scope, optimisticIds: ids, notificationId: id, localChanged: ids.size },
    (owner) => singleReads.set(id, owner),
    () => api.notifications.read(id),
    () => commitRead((notification) => notification.id === id, { kind: "ids", ids: new Set([id]) }),
  );
}

export function markAllNotificationsRead(): Promise<void> {
  if (readAll) return readAll.promise;
  const optimisticIds = idsFor(() => true);
  return beginRead(
    { key: "all", operation: "all", scope: { kind: "all" }, optimisticIds, localChanged: state.unreadCount },
    (owner) => {
      readAll = owner;
    },
    () => api.notifications.readAll(),
    () => commitRead(() => true, { kind: "all" }, true),
  );
}

/** Mark read everything about a thread (its id and its replies' ids) in a document. */
function markRefsReadOwned(documentId: string, refIds: string[], retry: boolean): Promise<void> {
  if (refIds.length === 0) return Promise.resolve();
  const normalizedRefs = [...new Set(refIds)].sort();
  const key = refKey(documentId, normalizedRefs);
  const current = refReads.get(key);
  if (current) return current.promise;
  const failed = state.readError;
  // Active thread effects see rollback as unread again; only the explicit Retry may reclaim a failed scope.
  if (
    !retry &&
    failed?.operation === "refs" &&
    failed.documentId === documentId &&
    normalizedRefs.some((refId) => failed.refIds.includes(refId))
  ) {
    return Promise.resolve();
  }
  const requestedRefs = new Set(normalizedRefs);
  const pred = (notification: NotificationDto) => notification.documentId === documentId && requestedRefs.has(notification.refId);
  // Unread rows beyond the loaded page may exist; ask the server regardless of the local view.
  const optimisticIds = idsFor(pred);
  if (optimisticIds.size === 0 && state.loaded && state.unreadCount === 0) return Promise.resolve();
  const scope: OperationScope = { kind: "refs", documentId, refIds: new Set(requestedRefs) };
  return beginRead(
    { key, operation: "refs", scope, optimisticIds, documentId, refIds: normalizedRefs, localChanged: optimisticIds.size },
    (owner) => refReads.set(key, owner),
    () => api.notifications.readRefs(documentId, normalizedRefs),
    (result, owner) => {
      const readError = commitRead(pred, { kind: "refs", documentId, refIds: new Set(normalizedRefs) });
      if (result.count > owner.localChanged) void refreshNotifications();
      return readError;
    },
  );
}

export function markRefsRead(documentId: string, refIds: string[]): Promise<void> {
  return markRefsReadOwned(documentId, refIds, false);
}

export function retryNotificationRead(error: NotificationReadError): Promise<void> {
  if (state.readError?.id !== error.id) return Promise.resolve();
  if (error.operation === "single") return markNotificationRead(error.notificationId);
  if (error.operation === "refs") return markRefsReadOwned(error.documentId, error.refIds, true);
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
    case "access.request":
      return `requested access to \u2018${n.documentTitle}\u2019`;
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
  "access.request": "Access request",
  "request.done": "Agent done",
  "webhook.disabled": "Webhook disabled",
};
