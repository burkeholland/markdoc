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
 *
 * ## The mirror epoch
 *
 * One hole remains after the server fix: a browser that still holds a mirror of an
 * *old, never-persisted* seed (written before the server started persisting seeds)
 * would merge it with the now-persisted seed on its first open and push the doubled
 * text to the server. Such a mirror is unsalvageable — its CRDT ids never existed on
 * the server — so the only safe move is to throw away every `markdoc:*` database once.
 *
 * `markdoc:idb-epoch` (localStorage) records which generation of server-side seed
 * identity this browser's mirrors belong to. When it differs from {@link IDB_EPOCH}
 * every local mirror is deleted before any y-indexeddb provider is created, then the
 * epoch is written. Bump {@link IDB_EPOCH} only when the identity of the state the
 * server hands out changes (a re-seed, a storage migration that re-mints CRDT ids);
 * never for ordinary releases — the wipe also discards edits made offline and not yet
 * synced, which there is no persisted marker to protect.
 */

export const LOCAL_DB_PREFIX = "markdoc:";

/**
 * Generation of the server-side seed identity the local mirrors are compatible with.
 * 1: seeds re-minted on every load (pre-fix); 2: seeds minted once and persisted as `ystate`.
 */
export const IDB_EPOCH = 2;
export const IDB_EPOCH_KEY = "markdoc:idb-epoch";
/** localStorage registry of mirrored doc ids, for runtimes without `indexedDB.databases()`. */
export const IDB_REGISTRY_KEY = "markdoc:idb-docs";

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

function storage(): Storage | null {
  try {
    const s = typeof localStorage === "undefined" ? null : localStorage;
    return s && typeof s.getItem === "function" ? s : null;
  } catch {
    return null;
  }
}

function readRegistry(): string[] {
  try {
    const raw = storage()?.getItem(IDB_REGISTRY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeRegistry(ids: string[]) {
  try {
    storage()?.setItem(IDB_REGISTRY_KEY, JSON.stringify(ids));
  } catch {
    // Quota or disabled storage: the registry is only a fallback for listing databases.
  }
}

function rememberLocalDoc(docId: string) {
  const ids = readRegistry();
  if (ids.includes(docId)) return;
  ids.push(docId);
  writeRegistry(ids);
}

function forgetLocalDoc(docId: string) {
  const ids = readRegistry();
  if (!ids.includes(docId)) return;
  writeRegistry(ids.filter((id) => id !== docId));
}

/** Names of every `markdoc:*` IndexedDB database this browser holds. */
async function listLocalDbNames(): Promise<string[]> {
  const idb = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
  if (typeof idb.databases === "function") {
    try {
      const all = await idb.databases();
      return all.map((d) => d.name ?? "").filter((n) => n.startsWith(LOCAL_DB_PREFIX));
    } catch {
      // Fall through to the registry.
    }
  }
  return readRegistry().map(localDbName);
}

/** The epoch the stored mirrors belong to, or null when nothing was ever recorded. */
export function storedIdbEpoch(): number | null {
  const raw = storage()?.getItem(IDB_EPOCH_KEY);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

let epochCheck: Promise<boolean> | null = null;

/**
 * Make sure the local mirrors belong to the current {@link IDB_EPOCH}; when they do
 * not, delete every `markdoc:*` database and record the new epoch. Must complete before
 * any {@link openLocalPersistence} call so a stale mirror is never applied to a document.
 *
 * Resolves true when mirrors may be opened. Resolves false when the wipe did not finish
 * within {@link LOCAL_LOAD_TIMEOUT_MS} (a database held open by another tab blocks its
 * deletion): the caller must then not open a mirror this session, and the epoch stays
 * unwritten so the next load tries again.
 */
export function ensureLocalEpoch(): Promise<boolean> {
  if (!hasIndexedDB()) return Promise.resolve(true);
  if (storedIdbEpoch() === IDB_EPOCH) return Promise.resolve(true);
  if (epochCheck) return epochCheck;
  epochCheck = (async () => {
    const wipe = (async () => {
      const names = await listLocalDbNames();
      await Promise.all(
        names.map(async (name) => {
          try {
            await clearDocument(name);
          } catch {
            // Best effort; a failed delete leaves the database for the next attempt.
          }
        }),
      );
      return names.length;
    })();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), LOCAL_LOAD_TIMEOUT_MS);
    });
    try {
      const wiped = await Promise.race([wipe, timeout]);
      if (wiped === null) {
        console.warn(`[markdoc] local mirror reset did not finish in ${LOCAL_LOAD_TIMEOUT_MS}ms; not opening IndexedDB this session`);
        return false;
      }
      writeRegistry([]);
      try {
        storage()?.setItem(IDB_EPOCH_KEY, String(IDB_EPOCH));
      } catch {
        // Without localStorage the wipe repeats on the next load; harmless for a doc that just synced.
      }
      if (wiped > 0) console.info(`[markdoc] local mirrors reset to epoch ${IDB_EPOCH} (${wiped} database${wiped === 1 ? "" : "s"} removed)`);
      return true;
    } finally {
      if (timer) clearTimeout(timer);
      epochCheck = null;
    }
  })();
  return epochCheck;
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
  rememberLocalDoc(docId);
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
      forgetLocalDoc(docId);
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
  forgetLocalDoc(docId);
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
