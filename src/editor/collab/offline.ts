import type * as Y from "yjs";
import { IndexeddbPersistence, clearDocument } from "y-indexeddb";

/**
 * Local persistence for open documents. Every Yjs update is mirrored into an
 * IndexedDB database named `markdoc:<docId>`, so edits made while offline
 * survive a refresh or a closed tab and are sent to the server on reconnect.
 *
 * The mirror is applied before the socket opens (offline-first) and merged with
 * whatever the server sends. That merge is only safe because the server's state
 * for a document is stable across loads: the Yjs seed of a document is minted
 * exactly once (at creation, or on the first load of a legacy row) and stored as
 * `ystate` (see src/server/collab/seed.ts). Before that was the case, an opened but
 * never-edited document was re-seeded with fresh CRDT ids on every server load and
 * the mirror of the previous seed merged with the new one into doubled text.
 *
 * There is deliberately no client-side heuristic for that hazard: a "never synced"
 * flag in the mirror cannot distinguish it (the first session *did* sync before the
 * reload), and "server wins when both sides have text" would discard edits typed
 * while offline. The provider applies the server's state before this module could
 * inspect it, so the fix has to be — and is — on the server.
 */

export const LOCAL_DB_PREFIX = "markdoc:";

/** How long to wait for IndexedDB before the UI stops waiting on it. */
export const LOCAL_LOAD_TIMEOUT_MS = 1500;

export function localDbName(docId: string): string {
  return `${LOCAL_DB_PREFIX}${docId}`;
}

/** True when the runtime exposes a usable IndexedDB (not SSR, not a bare test runtime). */
export function hasIndexedDB(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null && typeof indexedDB.open === "function";
  } catch {
    return false;
  }
}

export interface LocalPersistence {
  /** Resolves once the stored state has been applied to the document (or load gave up). */
  readonly whenLoaded: Promise<void>;
  /** Whether {@link whenLoaded} has settled. */
  readonly loaded: boolean;
  /** Stop mirroring updates and close the database. */
  destroy(): Promise<void>;
  /** Stop mirroring updates and delete the database. */
  clear(): Promise<void>;
}

/**
 * Mirror `ydoc` into IndexedDB. Returns null when IndexedDB is unavailable, in which
 * case the caller should behave as if the local state had loaded (empty) at once.
 * Failures to open the database (private mode, quota) are swallowed: the document
 * still works, it just is not persisted locally.
 */
export function openLocalPersistence(docId: string, ydoc: Y.Doc): LocalPersistence | null {
  if (!hasIndexedDB()) return null;
  let persistence: IndexeddbPersistence;
  try {
    persistence = new IndexeddbPersistence(localDbName(docId), ydoc);
  } catch {
    return null;
  }
  let loaded = false;
  let destroyed = false;
  const whenLoaded = new Promise<void>((resolve) => {
    const done = () => {
      if (loaded) return;
      loaded = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, LOCAL_LOAD_TIMEOUT_MS);
    persistence.whenSynced.then(done, done);
    // `_db` is the open request; a rejection here means persistence is unavailable.
    (persistence as unknown as { _db: Promise<unknown> })._db.catch(done);
  });
  const destroy = async () => {
    if (destroyed) return;
    destroyed = true;
    try {
      await persistence.destroy();
    } catch {
      // Closing an already-failed database is not an error worth surfacing.
    }
  };
  return {
    whenLoaded,
    get loaded() {
      return loaded;
    },
    destroy,
    clear: async () => {
      if (destroyed) {
        await clearLocalDocument(docId);
        return;
      }
      destroyed = true;
      try {
        await persistence.clearData();
      } catch {
        // Best effort: the database may already be gone.
      }
    },
  };
}

/** Delete the local copy of a document without needing a live persistence instance. */
export async function clearLocalDocument(docId: string): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    await clearDocument(localDbName(docId));
  } catch {
    // Best effort.
  }
}

export type ConnectionPhase = "saved" | "saving" | "offline" | "connecting" | "reconnecting" | "error";

/** Human-readable label for the header's save-state chip. */
export function saveStateLabel(state: ConnectionPhase, unsyncedChanges: number, recovered = false): string {
  switch (state) {
    case "saved":
      return recovered ? "All changes saved" : "Saved";
    case "saving":
      return "Saving…";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "offline":
      if (unsyncedChanges > 0) return `Offline — ${unsyncedChanges} unsaved ${unsyncedChanges === 1 ? "change" : "changes"}`;
      return "Offline — changes will sync";
    case "error":
      return "Not connected";
  }
}
