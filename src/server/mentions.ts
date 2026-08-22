import * as Y from "yjs";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { parseMentions } from "@/editor/collab/mentions";
import { readReply, type CommentReply } from "@/editor/collab/comments";
import { newId } from "@/editor/collab/shared";

const SNIPPET_MAX = 200;

/**
 * Record every `@login` in `body` as a mention of that person in `commentId`.
 * Idempotent per (comment, mentioned login); mentioning yourself is ignored.
 * Returns the number of new mention rows.
 */
export async function recordMentions(docId: string, commentId: string, byLogin: string | null, body: string): Promise<number> {
  const logins = parseMentions(body).filter((l) => l !== byLogin?.toLowerCase());
  if (logins.length === 0) return 0;
  const db = await getDb();
  const snippet = body.length > SNIPPET_MAX ? body.slice(0, SNIPPET_MAX - 1) + "…" : body;
  const inserted = await db
    .insert(schema.mentions)
    .values(logins.map((login) => ({ id: newId(), documentId: docId, commentId, mentionedLogin: login, byLogin, snippet })))
    .onConflictDoNothing({ target: [schema.mentions.commentId, schema.mentions.mentionedLogin] })
    .returning();
  return inserted.length;
}

export interface UnreadMention {
  id: string;
  documentId: string;
  documentTitle: string;
  commentId: string;
  byLogin: string | null;
  snippet: string;
  createdAt: Date;
}

/** Unread mentions of `login`, newest first, with the document title. */
export async function listUnreadMentions(login: string, limit = 20): Promise<UnreadMention[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: schema.mentions.id,
      documentId: schema.mentions.documentId,
      documentTitle: schema.documents.title,
      commentId: schema.mentions.commentId,
      byLogin: schema.mentions.byLogin,
      snippet: schema.mentions.snippet,
      createdAt: schema.mentions.createdAt,
    })
    .from(schema.mentions)
    .innerJoin(schema.documents, eq(schema.documents.id, schema.mentions.documentId))
    .where(and(eq(schema.mentions.mentionedLogin, login.toLowerCase()), isNull(schema.mentions.readAt)))
    .orderBy(desc(schema.mentions.createdAt))
    .limit(limit);
  return rows;
}

/** Mark a mention as read. Only the mentioned person may do so; returns false if nothing changed. */
export async function markMentionRead(id: string, login: string): Promise<boolean> {
  const db = await getDb();
  const updated = await db
    .update(schema.mentions)
    .set({ readAt: new Date() })
    .where(and(eq(schema.mentions.id, id), eq(schema.mentions.mentionedLogin, login.toLowerCase()), isNull(schema.mentions.readAt)))
    .returning();
  return updated.length > 0;
}

type ThreadMap = Y.Map<unknown>;

function recordThread(docId: string, map: ThreadMap) {
  const id = map.get("id");
  const body = map.get("body");
  if (typeof id !== "string" || typeof body !== "string") return;
  const by = map.get("authorLogin");
  void recordMentions(docId, id, typeof by === "string" ? by : null, body).catch((err) => console.error("[mentions] record failed", err));
}

function recordReply(docId: string, raw: unknown) {
  if (!raw || typeof raw !== "object") return;
  const reply: CommentReply = readReply(raw as Parameters<typeof readReply>[0]);
  if (typeof reply.id !== "string" || typeof reply.body !== "string") return;
  void recordMentions(docId, reply.id, reply.authorLogin ?? null, reply.body).catch((err) => console.error("[mentions] record failed", err));
}

/**
 * Watch the shared comments map of a live document and record mentions as new
 * threads and replies arrive (or bodies are edited). Call once per loaded
 * document, after it has been hydrated; returns an unsubscribe function.
 */
export function watchDocumentMentions(doc: Y.Doc, docId: string): () => void {
  const comments = doc.getMap<ThreadMap>("comments");
  const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    for (const event of events) {
      if (event.target === comments) {
        event.changes.keys.forEach((change, key) => {
          if (change.action !== "add") return;
          const map = comments.get(key);
          if (map) recordThread(docId, map);
        });
      } else if (event.target instanceof Y.Map) {
        if (event.changes.keys.has("body")) recordThread(docId, event.target as ThreadMap);
      } else if (event.target instanceof Y.Array) {
        for (const d of event.changes.delta) {
          if (d.insert && Array.isArray(d.insert)) for (const item of d.insert) recordReply(docId, item);
        }
      }
    }
  };
  comments.observeDeep(handler);
  return () => comments.unobserveDeep(handler);
}
