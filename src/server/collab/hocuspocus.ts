import {
  Hocuspocus,
  type connectedPayload,
  type onAuthenticatePayload,
  type onChangePayload,
  type onLoadDocumentPayload,
  type onStoreDocumentPayload,
} from "@hocuspocus/server";
import * as Y from "yjs";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getDb, schema } from "@/server/db";
import { collabTokenFailureMessage, isVerifiedCollabClaims, verifyCollabToken, type CollabClaims, type VerifiedCollabClaims } from "./token";
import { canEdit } from "@/server/documents";
import type { Role } from "@/server/db/schema";
import { addVersion, latestVersion } from "@/server/documents";
import { watchDocumentNotifications } from "@/server/notifications";
import { startActivityWatch, stopActivityWatch } from "@/server/activity";
import { publishAgentPresence } from "@/server/agent-presence";
import { CONTENT_AUTOSAVE_IDLE_MS } from "@/lib/document-persistence";
import { documentStoreSnapshot, installDocumentAutosave } from "./autosave";
import { hydrateDoc, revertDoubledSeed, META_KEY, TEXT_KEY } from "./seed";
import { installOriginAwareBroadcast } from "./broadcast";
import { Pace } from "@/server/pace";
import {
  collabConnectionOpened,
  collabMessageBegins,
  collabMessageEnds,
  collabSyncReceived,
  resolveStableCollabAccess,
  unauthorizedCollabError,
} from "./authorization";

export { hydrateDoc, META_KEY, TEXT_KEY };

export interface CollabPreAuthentication {
  accepted(): boolean;
  rejected(): void;
}

export type CollabContext = CollabClaims & {
  version?: 2;
  principal?: "user" | "token";
  preAuthentication?: CollabPreAuthentication;
  /** The role the token claimed: what the page was told when it fetched the token (see `collabConnectionOpened`). */
  tokenRole?: Role;
};

/** Interval after which a new automatic version snapshot is taken while editing. */
export const AUTO_VERSION_INTERVAL_MS = Number(process.env.AUTO_VERSION_INTERVAL_MS ?? 10 * 60 * 1000);

export function createCollabServer() {
  // Documents seeded from a legacy row during this process lifetime, by id → seed text, until their
  // first incoming change. A client still holding an IndexedDB mirror of the *previous* (never
  // persisted) seed merges it with this one into the text twice; that exact shape is reverted.
  const freshlySeeded = new Map<string, string>();
  const tokenExpiryTimers = new WeakMap<connectedPayload<CollabContext>["connection"], ReturnType<typeof setTimeout>>();

  const armTokenExpiry = (connection: connectedPayload<CollabContext>["connection"], expiresAt: number | null | undefined) => {
    const current = tokenExpiryTimers.get(connection);
    if (current) clearTimeout(current);
    if (!expiresAt) return;
    const schedule = () => {
      const remaining = expiresAt - Date.now();
      const timer = setTimeout(() => {
        if (remaining > 2_147_000_000) {
          schedule();
          return;
        }
        connection.readOnly = true;
        connection.close({ code: 4401, reason: "Unauthorized" });
      }, Math.max(0, Math.min(remaining, 2_147_000_000)));
      timer.unref?.();
      tokenExpiryTimers.set(connection, timer);
    };
    connection.onClose(() => {
      const timer = tokenExpiryTimers.get(connection);
      if (timer) clearTimeout(timer);
      tokenExpiryTimers.delete(connection);
    });
    schedule();
  };

  const hocuspocus = new Hocuspocus<CollabContext>({
    name: "markdoc",
    quiet: true,
    debounce: CONTENT_AUTOSAVE_IDLE_MS,
    maxDebounce: Number.POSITIVE_INFINITY,
    unloadImmediately: false,
    // Outgoing fan-out is handled per document by installOriginAwareBroadcast (see collab/broadcast.ts):
    // no buffering here, so every update / awareness change reaches it with its origin still known.
    flushDelay: false,

    async onAuthenticate({ token, documentName, connectionConfig, context }: onAuthenticatePayload<CollabContext>) {
      try {
        let claims: VerifiedCollabClaims;
        try {
          claims = await verifyCollabToken(token);
        } catch (err) {
          // Hocuspocus logs this message as `[onAuthenticate] …`; the client only ever receives
          // `permission-denied` (it then fetches a fresh token), so the reason is for the server log alone.
          throw new Error(collabTokenFailureMessage(err));
        }
        if (claims.docId !== documentName) throw new Error("Token does not match document");
        const current = await resolveStableCollabAccess(claims);
        if (!current) throw unauthorizedCollabError();
        if (context.preAuthentication && !context.preAuthentication.accepted()) throw unauthorizedCollabError();
        connectionConfig.readOnly = !canEdit(current.role);
        return { ...current, tokenRole: claims.role };
      } catch (error) {
        context.preAuthentication?.rejected();
        throw error;
      } finally {
        delete context.preAuthentication;
      }
    },

    async connected({ connection, context }: connectedPayload<CollabContext>) {
      // Seal the small race between authentication and adding the connection to the live document:
      // a concurrent share change either sees this connection or this hook waits for that change.
      const { tokenRole } = context;
      if (!isVerifiedCollabClaims(context)) {
        connection.readOnly = true;
        connection.close({ code: 4401, reason: "Unauthorized" });
        return;
      }
      const current = await resolveStableCollabAccess(context);
      if (!current) {
        connection.readOnly = true;
        collabConnectionOpened(connection, tokenRole, null);
        connection.close({ code: 4401, reason: "Unauthorized" });
        return;
      }
      connection.context = current;
      connection.readOnly = !canEdit(current.role);
      collabConnectionOpened(connection, tokenRole, current.role);
      armTokenExpiry(connection, current.tokenExpiresAt);
    },

    async beforeHandleMessage({ connection }) {
      // Access changes, token revocation, and token expiry are pushed to live connections.
      // Do not query here: steady-state Yjs/awareness traffic must not add database round trips
      // per message. While an access change has this connection paused, its messages wait here
      // (they are not refused) and go on under the access the connection has afterwards.
      await collabMessageBegins(connection);
    },

    async afterHandleMessage({ connection }) {
      collabMessageEnds(connection);
    },

    async beforeSync({ connection, type, payload }) {
      collabSyncReceived(connection, type, payload);
    },

    async beforeHandleAwareness(payload) {
      // A message that waited out an access change and finds its connection closed (removed for good, or the
      // tab closed meanwhile) must not put that person's presence back.
      const { connection } = payload as typeof payload & { connection?: connectedPayload<CollabContext>["connection"] };
      if (connection && !connection.document.hasConnection(connection)) payload.states.clear();
    },

    async onLoadDocument({ document, documentName }: onLoadDocumentPayload<CollabContext>) {
      installOriginAwareBroadcast(document);
      const db = await getDb();
      const [row] = await db
        .select({ ystate: schema.documents.ystate, content: schema.documents.content, title: schema.documents.title, updatedAt: schema.documents.updatedAt })
        .from(schema.documents)
        .where(eq(schema.documents.id, documentName));
      if (!row) throw new Error("Document not found");
      const seeded = hydrateDoc(document, row.ystate ?? null, row.content, row.title);
      if (seeded) {
        // The row predates creation-time `ystate` (or lost it). Persist the seed now, before any
        // client sees it: `onStoreDocument` only runs after an edit, so an opened-but-never-edited
        // document would otherwise be re-seeded with fresh CRDT ids on its next load and any client
        // holding this seed in IndexedDB would merge the two into doubled text. `content` is unchanged.
        await db
          .update(schema.documents)
          .set({ ystate: Y.encodeStateAsUpdate(document) })
          .where(eq(schema.documents.id, documentName));
        freshlySeeded.set(documentName, row.content);
      }
      autosave.track(document, row.updatedAt, row.title);
      watchDocumentNotifications(document, documentName);
      startActivityWatch(document, documentName);
      publishAgentPresence(document, documentName);
      return document;
    },

    async onChange({ document, documentName, context }: onChangePayload<CollabContext>) {
      const seed = freshlySeeded.get(documentName);
      if (seed === undefined) return;
      // Only the first change after seeding can be the mirror artefact; anything later is an edit.
      freshlySeeded.delete(documentName);
      if (revertDoubledSeed(document, seed, { source: "local", context })) {
        console.warn(`[collab] ${documentName}: reverted doubled text from a stale IndexedDB mirror of a pre-persistence seed`);
      }
    },

    async afterUnloadDocument({ documentName }) {
      autosave.untrack(documentName);
      freshlySeeded.delete(documentName);
      await stopActivityWatch(documentName);
    },

    async onStateless(payload) {
      await autosave.onStateless(payload);
    },

    async onStoreDocument(payload: onStoreDocumentPayload<CollabContext>) {
      try {
        const { documentName, lastContext } = payload;
        const { content, title, ystate, savedAt } = documentStoreSnapshot(payload);
        const db = await getDb();
        const patch: Partial<typeof schema.documents.$inferInsert> = {
          ystate,
          content,
          updatedAt: savedAt,
          lastEditedBy: lastContext?.userId ?? null,
        };
        if (title) patch.title = title;
        // The statements of one store answer in this thread on the embedded database: between two that took
        // long the pace lets other requests in. Only the id comes back: the row holds the whole text twice.
        const pace = new Pace();
        // Both drivers build this statement alike; TypeScript cannot pick an overload of `returning` on the union of the two.
        const stored = await pace.step(() => (db as NodePgDatabase<typeof schema>).update(schema.documents).set(patch).where(eq(schema.documents.id, documentName)).returning({ id: schema.documents.id }));
        if (stored.length !== 1) throw new Error("Document no longer exists");
        await maybeAutoVersion(documentName, content, lastContext ?? null, pace);
      } catch {
        // Hocuspocus logs hook messages; keep database and document details out of that diagnostic.
        throw new Error("Document persistence failed");
      }
    },
  });
  const autosave = installDocumentAutosave(hocuspocus);

  return hocuspocus;
}

async function maybeAutoVersion(docId: string, content: string, ctx: CollabContext | null, pace: Pace) {
  const latest = await pace.step(() => latestVersion(docId));
  if (!latest) {
    await addVersion({ documentId: docId, content, kind: "auto", createdBy: ctx?.userId, createdByName: ctx?.name });
    return;
  }
  if (latest.content === content) return;
  if (Date.now() - latest.createdAt.getTime() < AUTO_VERSION_INTERVAL_MS) return;
  await addVersion({ documentId: docId, content, kind: "auto", createdBy: ctx?.userId, createdByName: ctx?.name });
}

function settleBeforeDeadline(work: Promise<void>, deadline: number, failure: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      complete();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(failure))),
      Math.max(0, deadline - Date.now()),
    );
    work.then(
      () => finish(resolve),
      () => finish(() => reject(new Error(failure))),
    );
  });
}

/** Close all connections, await pending stores, and require every document to unload. */
export async function shutdownCollab(hocuspocus: Hocuspocus<CollabContext>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  hocuspocus.closeConnections();
  const stores = settleBeforeDeadline((async () => {
    do {
      await hocuspocus.flushPendingStores();
      if (hocuspocus.getDocumentsCount() > 0) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } while (hocuspocus.getDocumentsCount() > 0);
  })(), deadline, "Collaboration stores did not settle");
  const documents = settleBeforeDeadline((async () => {
    while (hocuspocus.getDocumentsCount() > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })(), deadline, "Collaboration documents did not drain");
  const results = await Promise.allSettled([stores, documents]);
  const destroyed = await Promise.resolve()
    .then(() => hocuspocus.hooks("onDestroy", { instance: hocuspocus }))
    .then(
      () => ({ status: "fulfilled" as const }),
      () => ({ status: "rejected" as const, reason: new Error("Collaboration cleanup failed") }),
    );
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (destroyed.status === "rejected") failures.push(destroyed.reason);
  if (failures.length) throw new AggregateError(failures, "Collaboration shutdown failed");
}

/**
 * Apply a change to a live document (or load it, change, and store it) without
 * a WebSocket connection. Used by REST endpoints such as version restore and
 * comments from users who cannot edit the text.
 *
 * Loading, changing and storing a large document each keep this thread for a while on the embedded
 * database; the pace lets other requests in between them (#2341). On PostgreSQL it never waits.
 */
export async function withDocument<T>(
  hocuspocus: Hocuspocus<CollabContext>,
  docId: string,
  ctx: CollabContext,
  fn: (doc: Y.Doc) => T,
): Promise<T> {
  const pace = new Pace();
  const connection = await pace.step(() => hocuspocus.openDirectConnection(docId, ctx));
  try {
    let result!: T;
    await pace.step(() =>
      connection.transact((doc) => {
        result = fn(doc);
      }),
    );
    return result;
  } finally {
    await pace.step(() => connection.disconnect());
  }
}
