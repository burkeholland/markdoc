import { Hocuspocus, type onAuthenticatePayload, type onLoadDocumentPayload, type onStoreDocumentPayload } from "@hocuspocus/server";
import * as Y from "yjs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { verifyCollabToken, type CollabClaims } from "./token";
import { canEdit } from "@/server/documents";
import { addVersion, latestVersion } from "@/server/documents";
import { watchDocumentMentions } from "@/server/mentions";

export type CollabContext = CollabClaims;

/** Interval after which a new automatic version snapshot is taken while editing. */
export const AUTO_VERSION_INTERVAL_MS = Number(process.env.AUTO_VERSION_INTERVAL_MS ?? 10 * 60 * 1000);

export const TEXT_KEY = "content";
export const META_KEY = "meta";

/** Populate a fresh Y.Doc from stored state or plain Markdown. */
export function hydrateDoc(doc: Y.Doc, ystate: Uint8Array | null, content: string, title: string) {
  if (ystate && ystate.byteLength > 0) {
    Y.applyUpdate(doc, ystate);
  } else {
    doc.transact(() => {
      const text = doc.getText(TEXT_KEY);
      if (text.length === 0 && content) text.insert(0, content);
    });
  }
  const meta = doc.getMap(META_KEY);
  if (!meta.has("title")) meta.set("title", title);
}

export function createCollabServer() {
  const hocuspocus = new Hocuspocus<CollabContext>({
    name: "markdoc",
    quiet: true,
    debounce: 1500,
    maxDebounce: 8000,
    unloadImmediately: false,

    async onAuthenticate({ token, documentName, connectionConfig }: onAuthenticatePayload<CollabContext>) {
      let claims: CollabClaims;
      try {
        claims = await verifyCollabToken(token);
      } catch {
        throw new Error("Invalid token");
      }
      if (claims.docId !== documentName) throw new Error("Token does not match document");
      if (!canEdit(claims.role)) connectionConfig.readOnly = true;
      return claims;
    },

    async onLoadDocument({ document, documentName }: onLoadDocumentPayload<CollabContext>) {
      const db = await getDb();
      const [row] = await db
        .select({ ystate: schema.documents.ystate, content: schema.documents.content, title: schema.documents.title })
        .from(schema.documents)
        .where(eq(schema.documents.id, documentName));
      if (!row) throw new Error("Document not found");
      hydrateDoc(document, row.ystate ?? null, row.content, row.title);
      watchDocumentMentions(document, documentName);
      return document;
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


