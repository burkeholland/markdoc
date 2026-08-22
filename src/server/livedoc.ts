import * as Y from "yjs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getCollab } from "@/server/collab/registry";
import { hydrateDoc, withDocument, TEXT_KEY, type CollabContext } from "@/server/collab/hocuspocus";
import { SuggestionsModel } from "@/editor/collab/suggestions";
import { CommentsModel } from "@/editor/collab/comments";
import { diffOps, applyOps } from "@/editor/sync/text-diff";
import { HttpError } from "@/server/http";

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
  const collab = getCollab();
  const live = collab?.documents.get(docId);
  if (live) return summarize(live);
  const doc = await loadFromDb(docId);
  try {
    return summarize(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Mutate a document's shared state. Goes through the collaboration server when
 * it is running (so connected users see the change instantly); otherwise loads,
 * mutates and stores the document directly.
 */
export async function mutateLiveDoc(docId: string, ctx: CollabContext, fn: (doc: Y.Doc) => void): Promise<void> {
  const collab = getCollab();
  if (collab) {
    await withDocument(collab, docId, ctx, fn);
    return;
  }
  const doc = await loadFromDb(docId);
  try {
    doc.transact(() => fn(doc), { source: "local", context: ctx });
    const db = await getDb();
    await db
      .update(schema.documents)
      .set({ ystate: Y.encodeStateAsUpdate(doc), content: doc.getText(TEXT_KEY).toString(), updatedAt: new Date(), lastEditedBy: ctx.userId })
      .where(eq(schema.documents.id, docId));
  } finally {
    doc.destroy();
  }
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
