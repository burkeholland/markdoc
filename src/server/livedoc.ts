import * as Y from "yjs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getCollab } from "@/server/collab/registry";
import { hydrateDoc, withDocument, META_KEY, TEXT_KEY, type CollabContext } from "@/server/collab/hocuspocus";
import { SuggestionsModel } from "@/editor/collab/suggestions";
import { CommentsModel } from "@/editor/collab/comments";
import { diffOps, applyOps } from "@/editor/sync/text-diff";
import { HttpError } from "@/server/http";
import { noteContentWrite, type WriterRef } from "@/server/agent-events";
import type { AgentActivity } from "@/server/agents";

export interface LiveText {
  /** Full Markdown including pending suggested insertions. */
  text: string;
  /** Markdown as it would read if every pending suggestion were rejected. */
  clean: string;
  title: string;
  pendingSuggestions: number;
  openComments: number;
}

async function loadFromDb(docId: string): Promise<Y.Doc> {
  const db = await getDb();
  const [row] = await db
    .select({ ystate: schema.documents.ystate, content: schema.documents.content, title: schema.documents.title })
    .from(schema.documents)
    .where(eq(schema.documents.id, docId));
  if (!row) throw new HttpError(404, "Document not found");
  const doc = new Y.Doc();
  hydrateDoc(doc, row.ystate ?? null, row.content, row.title);
  return doc;
}

function summarize(doc: Y.Doc): LiveText {
  const ytext = doc.getText(TEXT_KEY);
  const suggestions = new SuggestionsModel(doc, ytext);
  const comments = new CommentsModel(doc, ytext);
  try {
    const list = suggestions.list();
    return {
      text: ytext.toString(),
      clean: suggestions.cleanText(),
      title: String(doc.getMap("meta").get("title") ?? ""),
      pendingSuggestions: list.length,
      openComments: comments.list().filter((c) => !c.resolved).length,
    };
  } finally {
    suggestions.destroy();
    comments.destroy();
  }
}

/** Read the current text of a document, preferring the live in-memory copy. */
export async function readLiveText(docId: string): Promise<LiveText> {
  return readLiveDoc(docId, summarize);
}

/** Run a read-only function against the live document (or a copy loaded from the database). */
export async function readLiveDoc<T>(docId: string, fn: (doc: Y.Doc) => T): Promise<T> {
  const collab = getCollab();
  const live = collab?.documents.get(docId);
  if (live) return fn(live);
  const doc = await loadFromDb(docId);
  try {
    return fn(doc);
  } finally {
    doc.destroy();
  }
}

/** The Markdown as it would read with every pending suggestion rejected (what `content.changed` hashes). */
export function cleanTextOf(doc: Y.Doc): string {
  const model = new SuggestionsModel(doc, doc.getText(TEXT_KEY));
  try {
    return model.cleanText();
  } finally {
    model.destroy();
  }
}

/**
 * Run `fn` and tell the agent-events module who moved the clean text, so a token's watch can skip its own
 * writes. The writer is the agent that stamped `meta.agentActivity` during `fn` (recordAgentActivity does
 * that on every agent write), else the human behind `ctx`.
 */
function attributed(docId: string, ctx: CollabContext, fn: (doc: Y.Doc) => void): (doc: Y.Doc) => void {
  return (doc) => {
    const meta = doc.getMap(META_KEY);
    const stampBefore = meta.get("agentActivity");
    const before = cleanTextOf(doc);
    fn(doc);
    // Y.Map.get returns the very object recordAgentActivity stored, so a new reference means `fn` stamped
    // (two stamps within one millisecond would compare equal as JSON).
    const stamp = meta.get("agentActivity") as AgentActivity | undefined;
    const agent = stamp && stamp !== stampBefore ? stamp.name : null;
    const writer: WriterRef = agent ? { id: `agent:${ctx.userId}:${agent}`, name: agent, kind: "agent" } : { id: ctx.userId, name: ctx.name, kind: "user" };
    noteContentWrite(docId, writer, before, cleanTextOf(doc));
  };
}

/**
 * Mutate a document's shared state. Goes through the collaboration server when
 * it is running (so connected users see the change instantly); otherwise loads,
 * mutates and stores the document directly.
 */
export async function mutateLiveDoc(docId: string, ctx: CollabContext, fn: (doc: Y.Doc) => void): Promise<void> {
  const run = attributed(docId, ctx, fn);
  const collab = getCollab();
  if (collab) {
    await withDocument(collab, docId, ctx, run);
    return;
  }
  const doc = await loadFromDb(docId);
  try {
    doc.transact(() => run(doc), { source: "local", context: ctx });
    const db = await getDb();
    await db
      .update(schema.documents)
      .set({ ystate: Y.encodeStateAsUpdate(doc), content: doc.getText(TEXT_KEY).toString(), updatedAt: new Date(), lastEditedBy: ctx.userId })
      .where(eq(schema.documents.id, docId));
  } finally {
    doc.destroy();
  }
}

/** Stateless message sent to connected editors right before they are disconnected. */
export type EvictionReason = "trashed";

/**
 * Tell connected editors the document is gone (they navigate away), close their connections and
 * unload the live copy. No-op when the collaboration server is not running or the document is not loaded.
 */
export async function evictLiveDocument(docId: string, reason: EvictionReason): Promise<void> {
  const collab = getCollab();
  const live = collab?.documents.get(docId);
  if (!collab || !live) return;
  live.broadcastStateless(JSON.stringify({ type: reason }));
  collab.closeConnections(docId);
  await collab.unloadDocument(live).catch(() => undefined);
}

/** Replace the document text with `newText` using a minimal diff, keeping collaborators' positions stable. */
export async function replaceLiveText(docId: string, ctx: CollabContext, newText: string): Promise<boolean> {
  let changed = false;
  await mutateLiveDoc(docId, ctx, (doc) => {
    const ytext = doc.getText(TEXT_KEY);
    const ops = diffOps(ytext.toString(), newText, 0);
    if (ops.length > 0) {
      applyOps(ytext, ops);
      changed = true;
    }
  });
  return changed;
}
