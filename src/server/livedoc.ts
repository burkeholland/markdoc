import * as Y from "yjs";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getCollab } from "@/server/collab/registry";
import { withDocument, type CollabContext } from "@/server/collab/hocuspocus";
import { hydrateDoc, META_KEY, TEXT_KEY } from "@/server/collab/seed";
import { SuggestionsModel } from "@/editor/collab/suggestions";
import { CommentsModel } from "@/editor/collab/comments";
import { replaceText } from "@/editor/sync/replace-plan";
import { HttpError } from "@/server/http";
import { noteContentWrite, rememberCleanText, cachedCleanText, unifiedDiff, type WriterRef } from "@/server/agent-events";
import { contentHash } from "@/server/export/html";
import type { AgentActivity } from "@/server/agents";

/** The longest text a write through the API may leave in a document, in characters (`PUT` and `PATCH /content`). */
export const MAX_TEXT_CHARS = 2_000_000;

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
    return {
      text: ytext.toString(),
      clean: suggestions.cleanText(),
      title: String(doc.getMap("meta").get("title") ?? ""),
      pendingSuggestions: suggestions.count,
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

/**
 * The thread each comment ref belongs to: a thread id maps to itself, a reply id to the thread holding it,
 * anything else (deleted thread, foreign id) to null. Thread ids are answered from the comments map's keys;
 * the reply index is built once, and only when some ref is not a thread id.
 */
export function commentThreadIds(doc: Y.Doc, refIds: Iterable<string>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(refIds)];
  if (ids.length === 0) return out;
  const comments = doc.getMap<Y.Map<unknown>>("comments");
  let byReply: Map<string, string> | null = null;
  for (const refId of ids) {
    if (comments.has(refId)) {
      out.set(refId, refId);
      continue;
    }
    if (!byReply) {
      const index = new Map<string, string>();
      comments.forEach((thread, threadId) => {
        const replies = thread.get("replies");
        if (!(replies instanceof Y.Array)) return;
        for (const reply of replies.toArray() as { id?: unknown }[]) {
          if (reply && typeof reply.id === "string") index.set(reply.id, threadId);
        }
      });
      byReply = index;
    }
    out.set(refId, byReply.get(refId) ?? null);
  }
  return out;
}

/** `readLiveText` plus `commentThreadIds` for `refIds`, from the same read of the document. */
export async function readLiveTextWithThreads(docId: string, refIds: Iterable<string>): Promise<LiveText & { threads: Map<string, string | null> }> {
  return readLiveDoc(docId, (doc) => ({ ...summarize(doc), threads: commentThreadIds(doc, refIds) }));
}

/** `commentThreadIds` against the live document; every ref is null when the document cannot be read (gone). */
export async function resolveCommentThreads(docId: string, refIds: Iterable<string>): Promise<Map<string, string | null>> {
  const ids = [...new Set(refIds)];
  if (ids.length === 0) return new Map();
  try {
    return await readLiveDoc(docId, (doc) => commentThreadIds(doc, ids));
  } catch {
    return new Map(ids.map((id) => [id, null]));
  }
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

// --- Optimistic concurrency -----------------------------------------------------

/**
 * Body field shared by the conditional write routes: the `contentHash` from `GET /content`. Any string
 * is accepted here — a malformed value (wrong length, stray characters) is not a schema error but a
 * precondition that cannot match, so the caller gets the documented 409 with the current hash and its
 * retry loop works instead of stalling on a 400.
 */
export const ifContentHashSchema = z.string().trim().optional();

/** A weak `If-Match` validator, which RFC 9110 §13.1.1 says must never match. Never equal to a hex hash. */
const WEAK_PREFIX = "w/";

/**
 * The clean-text hash a write is conditional on: the body's `ifContentHash`, else the `If-Match`
 * header (`"<hash>"`, quotes tolerated; `*` means unconditional); null when the caller sent neither.
 * A weak tag (`W/"<hash>"`) is kept with its `w/` prefix so it never compares equal to the current hash.
 */
export function readPrecondition(req: Request, body?: { ifContentHash?: string | null } | null): string | null {
  const bodyHash = body?.ifContentHash?.trim();
  if (bodyHash) return bodyHash.toLowerCase();
  const header = req.headers.get("if-match");
  if (!header) return null;
  const trimmed = header.trim();
  const weak = /^W\//i.test(trimmed);
  const raw = trimmed
    .replace(/^W\//i, "")
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .trim();
  if (!raw) return null;
  if (!weak && raw === "*") return null;
  return (weak ? WEAK_PREFIX : "") + raw.toLowerCase();
}

/**
 * Refuse a write when the document's clean text no longer hashes to what the caller read. Call it
 * inside the `mutateLiveDoc` callback (so the check and the write see the same state) before touching
 * the text. The 409 body carries the current hash and, when the text at `expected` is still cached
 * (`GET /content`, the events route and every API write remember it), a unified diff of what moved.
 * Returns the current hash.
 */
export function assertContentUnchanged(docId: string, doc: Y.Doc, expected: string | null): string {
  const clean = cleanTextOf(doc);
  const current = contentHash(clean);
  if (expected === null || expected === current) return current;
  const known = cachedCleanText(docId, expected);
  const change = known === null ? null : unifiedDiff(known, clean);
  rememberCleanText(docId, clean);
  throw new HttpError(409, "Document changed since you read it", {
    contentHash: current,
    diff: change?.diff ?? null,
    truncated: change?.truncated ?? false,
  });
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

/**
 * Replace the document text with `newText`, as edits that keep what did not change in place (and with it
 * collaborators' carets and comments). The edits are planned in bounded time (`planReplace`, #2341).
 */
export async function replaceLiveText(docId: string, ctx: CollabContext, newText: string): Promise<boolean> {
  let changed = false;
  await mutateLiveDoc(docId, ctx, (doc) => {
    changed = replaceText(doc.getText(TEXT_KEY), newText).length > 0;
  });
  return changed;
}
