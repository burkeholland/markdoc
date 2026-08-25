import { isTransactionOrigin, OutgoingMessage, type Connection, type Document } from "@hocuspocus/server";
import * as Y from "yjs";

/**
 * Origin-aware fan-out for a Hocuspocus document.
 *
 * Hocuspocus 4.x broadcasts every document update and every awareness change to *all*
 * connections, including the one it came from. A Yjs client has already applied its own
 * update (and owns its own awareness state), so for the typist that echo is pure waste: on
 * top of the `SyncStatus` ack the provider needs, it received its update back plus its own
 * caret. This module replaces the document's outgoing buffer with one that remembers which
 * connection each update / awareness change came from and leaves that connection out.
 *
 * Awareness is additionally throttled to one broadcast per {@link AWARENESS_THROTTLE_MS}
 * per document: carets moving on every keystroke must not double a collaborator's inbound
 * message rate, and a caret 50 ms late is invisible.
 *
 * Wiring: the server is configured with `flushDelay: false`, so Hocuspocus hands each
 * update / awareness change straight to `broadcastUpdate` / `broadcastAwarenessUpdate`,
 * which are overridden here per instance to buffer instead. The origin is learned from
 * the document's own `update` / awareness `update` events: Hocuspocus registered its
 * listeners in the constructor, ours run right after in the same emit, before the flush
 * (setImmediate) that sends anything. Document updates still coalesce per event-loop turn
 * like Hocuspocus's own `flushDelay: 0`.
 */

export const AWARENESS_THROTTLE_MS = 50;

/** Hocuspocus marks these `private` in its types; at runtime they are ordinary methods. */
interface BroadcastHooks {
  broadcastUpdate(update: Uint8Array): void;
  broadcastAwarenessUpdate(changedClients: number[]): void;
}

type Origin = Connection | null;

function connectionOf(origin: unknown): Origin {
  return isTransactionOrigin(origin) && origin.source === "connection" ? origin.connection : null;
}

export interface OriginAwareBroadcast {
  /** Send everything buffered now (awareness too, ignoring the throttle). */
  flush(): void;
}

export function installOriginAwareBroadcast(document: Document): OriginAwareBroadcast {
  const hooks = document as unknown as BroadcastHooks;
  const originalFlush = document.flush.bind(document);

  let pendingUpdates: Uint8Array[] = [];
  const updateOrigins = new WeakMap<Uint8Array, Origin>();
  let pendingAwareness = new Map<number, Origin>();
  let lastAwarenessSentAt = 0;
  let immediate: ReturnType<typeof setImmediate> | null = null;
  let awarenessTimer: ReturnType<typeof setTimeout> | null = null;

  // Origins: Yjs passes the same `update` array to every listener, so the buffered entry can be
  // resolved by identity; awareness changes are keyed by client id (one origin per client per window).
  document.on("update", (update: Uint8Array, origin: unknown) => {
    updateOrigins.set(update, connectionOf(origin));
  });
  document.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const connection = connectionOf(origin);
    for (const id of [...added, ...updated, ...removed]) if (pendingAwareness.has(id)) pendingAwareness.set(id, connection);
  });

  const schedule = () => {
    if (immediate) return;
    immediate = setImmediate(() => {
      immediate = null;
      flushUpdates();
      flushAwareness(false);
    });
  };

  hooks.broadcastUpdate = (update) => {
    // While loading (hydrating from the database) nothing is connected; the buffered state would
    // otherwise reach the first connection a second time, right after it got it as sync step 2.
    if (document.isLoading) return;
    pendingUpdates.push(update);
    schedule();
  };

  hooks.broadcastAwarenessUpdate = (changedClients) => {
    for (const id of changedClients) pendingAwareness.set(id, null);
    schedule();
  };

  function flushUpdates() {
    if (pendingUpdates.length === 0) return;
    const batch = pendingUpdates.map((update) => ({ update, origin: updateOrigins.get(update) ?? null }));
    pendingUpdates = [];

    // One merge for everyone who sent nothing this turn, one per connection that did (usually just the typist).
    const merged = new Map<Origin, Uint8Array | null>();
    const payloadExcluding = (connection: Connection): Uint8Array | null => {
      const key = batch.some((e) => e.origin === connection) ? connection : null;
      if (!merged.has(key)) {
        const rest = key ? batch.filter((e) => e.origin !== connection) : batch;
        merged.set(key, rest.length === 0 ? null : rest.length === 1 ? rest[0].update : Y.mergeUpdates(rest.map((e) => e.update)));
      }
      return merged.get(key)!;
    };

    for (const connection of document.getConnections()) {
      const update = payloadExcluding(connection);
      if (!update) continue;
      connection.send(new OutgoingMessage(connection.messageAddress).createSyncMessage().writeUpdate(update).toUint8Array());
    }
  }

  function flushAwareness(force: boolean) {
    if (pendingAwareness.size === 0) return;
    const wait = lastAwarenessSentAt + AWARENESS_THROTTLE_MS - Date.now();
    if (!force && wait > 0) {
      if (!awarenessTimer) {
        awarenessTimer = setTimeout(() => {
          awarenessTimer = null;
          flushAwareness(true);
        }, wait);
      }
      return;
    }
    if (awarenessTimer) {
      clearTimeout(awarenessTimer);
      awarenessTimer = null;
    }
    const batch = pendingAwareness;
    pendingAwareness = new Map();
    lastAwarenessSentAt = Date.now();
    for (const connection of document.getConnections()) {
      const clients = [...batch].filter(([, origin]) => origin !== connection).map(([id]) => id);
      if (clients.length === 0) continue;
      connection.send(new OutgoingMessage(connection.messageAddress).createAwarenessUpdateMessage(document.awareness, clients).toUint8Array());
    }
  }

  const flush = () => {
    if (immediate) {
      clearImmediate(immediate);
      immediate = null;
    }
    flushUpdates();
    flushAwareness(true);
  };

  document.flush = () => {
    flush();
    return originalFlush();
  };

  return { flush };
}
