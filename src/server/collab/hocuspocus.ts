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
import { getDb, schema } from "@/server/db";
import { verifyCollabToken, type CollabClaims } from "./token";
import { canEdit } from "@/server/documents";
import { addVersion, latestVersion } from "@/server/documents";
import { watchDocumentNotifications } from "@/server/notifications";
import { startActivityWatch, stopActivityWatch } from "@/server/activity";
import { publishAgentPresence } from "@/server/agent-presence";
import { hydrateDoc, revertDoubledSeed, META_KEY, TEXT_KEY } from "./seed";
import { installOriginAwareBroadcast } from "./broadcast";
import {
  collabAccessChangeBlocks,
  resolveStableCollabAccess,
  unauthorizedCollabError,
} from "./authorization";

export { hydrateDoc, META_KEY, TEXT_KEY };

export type CollabContext = CollabClaims;

/** Interval after which a new automatic version snapshot is taken while editing. */
export const AUTO_VERSION_INTERVAL_MS = Number(process.env.AUTO_VERSION_INTERVAL_MS ?? 10 * 60 * 1000);

export function createCollabServer() {
  // Documents seeded from a legacy row during this process lifetime, by id → seed text, until their
  // first incoming change. A client still holding an IndexedDB mirror of the *previous* (never
  // persisted) seed merges it with this one into the text twice; that exact shape is reverted.
  const freshlySeeded = new Map<string, string>();

  const hocuspocus = new Hocuspocus<CollabContext>({
    name: "markdoc",
    quiet: true,
    debounce: 1500,
    maxDebounce: 8000,
    unloadImmediately: false,
    // Outgoing fan-out is handled per document by installOriginAwareBroadcast (see collab/broadcast.ts):
    // no buffering here, so every update / awareness change reaches it with its origin still known.
    flushDelay: false,

    async onAuthenticate({ token, documentName, connectionConfig }: onAuthenticatePayload<CollabContext>) {
      let claims: CollabClaims;
      try {
        claims = await verifyCollabToken(token);
      } catch {
        throw new Error("Invalid token");
      }
      if (claims.docId !== documentName) throw new Error("Token does not match document");
      const current = await resolveStableCollabAccess(claims);
      if (!current) throw unauthorizedCollabError();
      connectionConfig.readOnly = !canEdit(current.role);
      return current;
    },

    async connected({ connection, context }: connectedPayload<CollabContext>) {
      // Seal the small race between authentication and adding the connection to the live document:
      // a concurrent share change either sees this connection or this hook waits for that change.
      const current = await resolveStableCollabAccess(context);
      if (!current) {
        connection.readOnly = true;
        connection.close({ code: 4401, reason: "Unauthorized" });
        return;
      }
      connection.context = current;
      connection.readOnly = !canEdit(current.role);
    },

    async beforeHandleMessage({ connection }) {
      if (collabAccessChangeBlocks(connection)) connection.readOnly = true;
    },

    async onLoadDocument({ document, documentName }: onLoadDocumentPayload<CollabContext>) {
      installOriginAwareBroadcast(document);
      const db = await getDb();
      const [row] = await db
        .select({ ystate: schema.documents.ystate, content: schema.documents.content, title: schema.documents.title })
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
      freshlySeeded.delete(documentName);
      await stopActivityWatch(documentName);
    },

    async onStoreDocument({ document, documentName, lastContext }: onStoreDocumentPayload<CollabContext>) {
      const db = await getDb();
      const content = document.getText(TEXT_KEY).toString();
      const metaTitle = document.getMap(META_KEY).get("title");
      const ystate = Y.encodeStateAsUpdate(document);
      const patch: Partial<typeof schema.documents.$inferInsert> = {
        ystate,
        content,
        updatedAt: new Date(),
        lastEditedBy: lastContext?.userId ?? null,
      };
      if (typeof metaTitle === "string" && metaTitle.trim()) patch.title = metaTitle.trim().slice(0, 200);
      await db.update(schema.documents).set(patch).where(eq(schema.documents.id, documentName));
      await maybeAutoVersion(documentName, content, lastContext ?? null);
    },
  });

  return hocuspocus;
}

async function maybeAutoVersion(docId: string, content: string, ctx: CollabContext | null) {
  const latest = await latestVersion(docId);
  if (!latest) {
    await addVersion({ documentId: docId, content, kind: "auto", createdBy: ctx?.userId, createdByName: ctx?.name });
    return;
  }
  if (latest.content === content) return;
  if (Date.now() - latest.createdAt.getTime() < AUTO_VERSION_INTERVAL_MS) return;
  await addVersion({ documentId: docId, content, kind: "auto", createdBy: ctx?.userId, createdByName: ctx?.name });
}

/** Close all connections, flush pending stores, and wait for documents to unload. */
export async function shutdownCollab(hocuspocus: Hocuspocus<CollabContext>, timeoutMs = 5000): Promise<void> {
  hocuspocus.closeConnections();
  hocuspocus.flushPendingStores();
  const start = Date.now();
  while (hocuspocus.getDocumentsCount() > 0 && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await hocuspocus.hooks("onDestroy", { instance: hocuspocus });
}

/**
 * Apply a change to a live document (or load it, change, and store it) without
 * a WebSocket connection. Used by REST endpoints such as version restore and
 * comments from users who cannot edit the text.
 */
export async function withDocument<T>(
  hocuspocus: Hocuspocus<CollabContext>,
  docId: string,
  ctx: CollabContext,
  fn: (doc: Y.Doc) => T,
): Promise<T> {
  const connection = await hocuspocus.openDirectConnection(docId, ctx);
  try {
    let result!: T;
    await connection.transact((doc) => {
      result = fn(doc);
    });
    return result;
  } finally {
    await connection.disconnect();
  }
}
