import type { Connection, Document, Hocuspocus, onStatelessPayload, onStoreDocumentPayload } from "@hocuspocus/server";
import { shouldSkipStoreHooks } from "@hocuspocus/server";
import * as Y from "yjs";
import type { PersistenceMessage, PersistenceRequest, SavedDocumentVersion } from "@/lib/document-persistence";
import { boundTitle } from "@/server/document-title";
import { contentHash } from "@/server/export/html";
import { collabAccessChangeBlocks } from "./authorization";
import { DocumentSaveQueue } from "./save-queue";

export interface DocumentStoreSnapshot {
  content: string;
  title: string;
  ystate: Uint8Array;
  snapshot: number[];
  savedAt: Date;
}

const STORE_SNAPSHOT = Symbol("document-store-snapshot");
type StorePayload = onStoreDocumentPayload & { [STORE_SNAPSHOT]?: DocumentStoreSnapshot };

export function captureDocumentStore(document: Y.Doc): DocumentStoreSnapshot {
  const title = document.getMap("meta").get("title");
  return {
    content: document.getText("content").toString(),
    title: typeof title === "string" && title.trim() ? boundTitle(title) : "",
    ystate: Y.encodeStateAsUpdate(document),
    snapshot: Array.from(Y.encodeSnapshot(Y.snapshot(document))),
    savedAt: new Date(),
  };
}

export function documentStoreSnapshot(payload: onStoreDocumentPayload): DocumentStoreSnapshot {
  return (payload as StorePayload)[STORE_SNAPSHOT] ?? captureDocumentStore(payload.document);
}

interface SavedSnapshot {
  saved: SavedDocumentVersion;
  snapshot: number[];
}

interface Entry {
  document: Document;
  epoch: string;
  sequence: number;
  payload: onStoreDocumentPayload | null;
  queue: DocumentSaveQueue<SavedSnapshot>;
  composing: Set<Connection>;
}

/**
 * Replaces only Hocuspocus's store scheduling, keeping its live document, hooks and save mutex.
 * The debouncer facade also preserves authorization barriers, direct REST writers and shutdown.
 */
export function installDocumentAutosave<Context>(server: Hocuspocus<Context>) {
  const entries = new Map<string, Entry>();
  const originalDebouncer = server.debouncer;
  const entryForKey = (key: string) => key.startsWith("onStoreDocument-") ? entries.get(key.slice("onStoreDocument-".length)) : undefined;

  function releaseComposition(entry: Entry, connection: Connection) {
    entry.composing.delete(connection);
    entry.queue.composition(connection, false);
  }

  function releaseBlockedCompositions(entry: Entry) {
    for (const connection of entry.composing) {
      if (connection.readOnly || collabAccessChangeBlocks(connection)) releaseComposition(entry, connection);
    }
  }

  function flush(entry: Entry) {
    // Authorization gates connections before calling the existing store-flush facade.
    releaseBlockedCompositions(entry);
    return entry.queue.flush();
  }

  function message(entry: Entry, includeSaved = false, requestId?: string): PersistenceMessage {
    // The origin-aware broadcaster buffers deltas. A snapshot must not overtake its updates.
    if (includeSaved && entry.queue.saved) entry.document.flush();
    return {
      type: "document-persistence",
      docId: entry.document.name,
      epoch: entry.epoch,
      sequence: ++entry.sequence,
      revision: entry.queue.revision,
      savedRevision: entry.queue.savedRevision,
      state: entry.queue.state,
      // Do not expose database errors, connection strings or query parameters to clients.
      error: entry.queue.error ? "Changes could not be saved. Retry saving." : null,
      ...(requestId ? { requestId } : {}),
      ...(includeSaved && entry.queue.saved ? entry.queue.saved : {}),
    };
  }

  server.debouncer = {
    debounce: originalDebouncer.debounce,
    isDebounced: (key) => entryForKey(key)?.queue.dirty ?? originalDebouncer.isDebounced(key),
    isCurrentlyExecuting: (key) => entryForKey(key)?.queue.inFlight ?? originalDebouncer.isCurrentlyExecuting(key),
    executeNow: (key) => {
      const entry = entryForKey(key);
      return entry ? flush(entry) : originalDebouncer.executeNow(key);
    },
  };

  server.storeDocumentHooks = (document, payload, immediately) => {
    const entry = entries.get(document.name);
    if (!entry || entry.document !== document) return Promise.reject(new Error("Document persistence is not initialized"));
    if (!immediately || !entry.payload) entry.payload = payload;
    // The update listener queues real CRDT changes. A no-op direct disconnect adds no write.
    return immediately ? flush(entry) : Promise.resolve();
  };

  server.flushPendingStores = () => {
    for (const entry of entries.values()) {
      if (entry.queue.dirty) {
        void flush(entry).catch((error: unknown) => console.error("[collab] document flush failed", error));
      }
    }
  };

  function track(document: Document, updatedAt: Date, title = "") {
    const epoch = crypto.randomUUID();
    const baseline = captureDocumentStore(document);
    baseline.title ||= title;
    const entry: Entry = {
      document,
      epoch,
      sequence: 0,
      payload: null,
      composing: new Set(),
      queue: new DocumentSaveQueue<SavedSnapshot>(
        async (revision) => {
          if (!entry.payload) throw new Error("Document store has no transaction context");
          // Capture everything before awaiting the mutex/database: newer edits remain pending.
          const snapshot = captureDocumentStore(document);
          snapshot.title ||= entry.queue.saved?.saved.title ?? "";
          const payload: StorePayload = { ...entry.payload, [STORE_SNAPSHOT]: snapshot };
          await document.saveMutex.runExclusive(async () => {
            await server.hooks("onStoreDocument", payload);
            await server.hooks("afterStoreDocument", payload);
          });
          return {
            saved: {
              docId: document.name,
              version: `${epoch}:${revision}`,
              contentHash: contentHash(snapshot.content),
              title: snapshot.title,
              savedAt: snapshot.savedAt.toISOString(),
            },
            snapshot: snapshot.snapshot,
          };
        },
        (committed) => {
          document.broadcastStateless(JSON.stringify(message(entry, committed)));
          if (committed) {
            // Hocuspocus rechecks the queue and its mutex before unloading.
            setTimeout(() => void server.unloadDocument(document), 0);
          }
        },
        () => server.configuration.debounce,
      ),
    };
    entry.queue.saved = {
      saved: {
        docId: document.name,
        version: `${epoch}:0`,
        contentHash: contentHash(baseline.content),
        title: baseline.title,
        savedAt: updatedAt.toISOString(),
      },
      snapshot: baseline.snapshot,
    };
    entries.set(document.name, entry);
    document.on("update", (_update: Uint8Array, origin: unknown, _document: Y.Doc, transaction: Y.Transaction) => {
      if (document.isLoading || shouldSkipStoreHooks(origin)) return;
      const changedTypes: ReadonlyMap<unknown, unknown> = transaction.changed;
      releaseBlockedCompositions(entry);
      entry.queue.edit(changedTypes.size === 1 && changedTypes.has(document.getText("content")));
    });
  }

  const composingConnections = new WeakSet<Connection>();
  function onStateless({ connection, document, documentName, payload }: onStatelessPayload) {
    let request: Partial<PersistenceRequest>;
    try {
      request = JSON.parse(payload) as Partial<PersistenceRequest>;
    } catch {
      return;
    }
    if (!request || request.docId !== documentName) return;
    const entry = entries.get(documentName);
    if (!entry || entry.document !== document) return;
    if (request.type === "document-composition") {
      if (typeof request.active !== "boolean") return;
      if (!request.active) {
        releaseComposition(entry, connection);
        return;
      }
      if (connection.readOnly || collabAccessChangeBlocks(connection)) return;
      entry.composing.add(connection);
      entry.queue.composition(connection, true);
      if (!composingConnections.has(connection)) {
        composingConnections.add(connection);
        connection.onClose(() => releaseComposition(entry, connection));
      }
      return;
    }
    if (
      (request.type !== "document-persistence-status" && request.type !== "document-persistence-flush") ||
      typeof request.requestId !== "string" || request.requestId.length > 100
    ) return;
    if (request.type === "document-persistence-flush") {
      if (connection.readOnly || collabAccessChangeBlocks(connection)) {
        connection.sendStateless(JSON.stringify({
          ...message(entry, false, request.requestId),
          state: "error",
          error: "You do not have permission to save this document.",
        }));
        return;
      }
      // Do not hold the connection's inbound-message queue behind database IO.
      const requestId = request.requestId;
      const reply = () => connection.sendStateless(JSON.stringify(message(entry, true, requestId)));
      void flush(entry).then(reply, reply);
      return;
    }
    connection.sendStateless(JSON.stringify(message(entry, true, request.requestId)));
  }

  return { track, onStateless, untrack: (documentName: string) => entries.delete(documentName) };
}
