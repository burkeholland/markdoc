import * as Y from "yjs";
import { and, desc, eq, lt, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import type { Activity, ActivityAction, ActorKind } from "@/server/db/schema";
import type { Actor } from "@/server/http";
import { newId } from "@/editor/collab/shared";
import { META_KEY, TEXT_KEY } from "@/server/collab/hocuspocus";
import type { CollabClaims } from "@/server/collab/token";
import { wakeDocument } from "@/server/agent-events";

/** Edits by the same actor within this window are merged into one activity row. */
export const EDIT_COALESCE_WINDOW_MS = Number(process.env.ACTIVITY_EDIT_WINDOW_MS ?? 10 * 60 * 1000);
/** How long the live-document watcher waits for typing to pause before writing an edit row. */
export const EDIT_FLUSH_MS = Number(process.env.ACTIVITY_EDIT_FLUSH_MS ?? 1500);
/** Quotes stored in `detail` are clipped to this many characters; full content is never stored. */
export const QUOTE_MAX = 120;

export interface ActivityActor {
  id: string | null;
  name: string;
  kind: ActorKind;
}

export type ActivityDetail = Record<string, unknown>;

export interface ActivityItem {
  id: string;
  actorId: string | null;
  actorName: string;
  actorKind: ActorKind;
  action: ActivityAction;
  detail: ActivityDetail;
  createdAt: string;
}

export function clip(text: string, max = QUOTE_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** The acting identity for an API caller: agents are attributed to the token name, not the human. */
export function activityActor(actor: Actor): ActivityActor {
  if (actor.agent) return { id: `agent:${actor.id}:${actor.agent}`, name: actor.agent, kind: "agent" };
  return { id: actor.id, name: actor.name ?? actor.login ?? "User", kind: "user" };
}

/** Identity from a comment/suggestion author stored in the shared document (see collabIdentity). */
export function activityActorFromCollab(authorId: string | null | undefined, authorName: string | null | undefined): ActivityActor {
  const id = authorId ?? null;
  const kind: ActorKind = id?.startsWith("agent:") ? "agent" : "user";
  return { id, name: authorName ?? "Someone", kind };
}

function activityActorFromClaims(claims: CollabClaims | null | undefined): ActivityActor | null {
  if (!claims?.userId) return null;
  return { id: claims.userId, name: claims.name ?? claims.login ?? "User", kind: "user" };
}

function toItem(row: Activity): ActivityItem {
  return {
    id: row.id,
    actorId: row.actorId,
    actorName: row.actorName,
    actorKind: row.actorKind,
    action: row.action,
    detail: row.detail ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

/** Append one activity row. `detail` is free-form but must stay small (no document text). */
export async function recordActivity(docId: string, actor: ActivityActor, action: ActivityAction, detail: ActivityDetail = {}, now = new Date()): Promise<ActivityItem> {
  const db = await getDb();
  const [row] = await db
    .insert(schema.activity)
    .values({ id: newId(), documentId: docId, actorId: actor.id, actorName: actor.name, actorKind: actor.kind, action, detail, createdAt: now })
    .returning();
  wakeDocument(docId);
  return toItem(row);
}

/**
 * Record an edit, merging it into the actor's previous edit row when that row is
 * younger than the coalescing window: `detail.chars` is summed and `created_at`
 * moves forward, so a typing session shows as one line in the feed.
 *
 * The window closes as soon as any other kind of row (a comment, a version, a
 * share…) is recorded for the document: moving the edit forward past it would
 * reorder the newest-first feed, so the next keystrokes start a fresh edit row
 * instead. Other users' edits do not close the window.
 */
export async function recordEdit(docId: string, actor: ActivityActor, chars: number, now = new Date()): Promise<ActivityItem> {
  const db = await getDb();
  const since = new Date(now.getTime() - EDIT_COALESCE_WINDOW_MS);
  const actorMatch = actor.id ? eq(schema.activity.actorId, actor.id) : eq(schema.activity.actorName, actor.name);
  const [latest] = await db
    .select()
    .from(schema.activity)
    .where(and(eq(schema.activity.documentId, docId), or(ne(schema.activity.action, "edit"), actorMatch)))
    .orderBy(desc(schema.activity.createdAt), desc(schema.activity.id))
    .limit(1);
  if (latest && latest.action === "edit" && latest.createdAt >= since) {
    const previous = Number((latest.detail as { chars?: unknown })?.chars ?? 0) || 0;
    const [row] = await db
      .update(schema.activity)
      .set({ detail: { ...latest.detail, chars: previous + chars }, createdAt: now, actorName: actor.name })
      .where(eq(schema.activity.id, latest.id))
      .returning();
    wakeDocument(docId);
    return toItem(row);
  }
  return recordActivity(docId, actor, "edit", { chars }, now);
}

export interface ActivityPage {
  items: ActivityItem[];
  /** Pass as `before` to fetch the next (older) page; null when there is no more. */
  nextBefore: string | null;
}

/** Newest first. `before` excludes rows at or after that instant. */
export async function listActivity(docId: string, opts: { before?: Date | null; limit?: number } = {}): Promise<ActivityPage> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const db = await getDb();
  const where = opts.before
    ? and(eq(schema.activity.documentId, docId), lt(schema.activity.createdAt, opts.before))
    : eq(schema.activity.documentId, docId);
  const rows = await db
    .select()
    .from(schema.activity)
    .where(where)
    .orderBy(desc(schema.activity.createdAt), desc(schema.activity.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const items = page.map(toItem);
  return { items, nextBefore: rows.length > limit ? items[items.length - 1].createdAt : null };
}

/** Number of activity rows for a document (tests and diagnostics). */
export async function countActivity(docId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.activity).where(eq(schema.activity.documentId, docId));
  return row?.n ?? 0;
}

// --- Live document watcher ---------------------------------------------------

type Origin = { source?: string; connection?: { context?: CollabClaims }; context?: CollabClaims } | null | undefined;

/** The human behind a WebSocket transaction. Server-side (REST) mutations return null: their routes record themselves. */
function actorFromOrigin(origin: unknown): ActivityActor | null {
  const o = origin as Origin;
  if (!o || typeof o !== "object") return null;
  if (o.source === "connection") return activityActorFromClaims(o.connection?.context);
  return null;
}

interface PendingEdit {
  actor: ActivityActor;
  chars: number;
}

const log = (what: string) => (err: unknown) => console.error(`[activity] ${what} failed`, err);

/**
 * Watch a live document for in-editor activity: typing (coalesced per user), title
 * changes, and comments added or resolved in the UI. Everything is fire-and-forget
 * so the editing path is never slowed down. Returns an unsubscribe that also flushes
 * pending edits and resolves once they are written.
 */
export function watchDocumentActivity(doc: Y.Doc, docId: string): () => Promise<void> {
  const ytext = doc.getText(TEXT_KEY);
  const meta = doc.getMap(META_KEY);
  const comments = doc.getMap<Y.Map<unknown>>("comments");
  const pending = new Map<string, PendingEdit>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Edit writes are chained so two flushes for the same actor never race (a race would
  // create two rows where one coalesced row is expected).
  let writes: Promise<void> = Promise.resolve();

  const flush = () => {
    timer = null;
    const edits = [...pending.values()];
    pending.clear();
    for (const edit of edits) {
      writes = writes.then(() => recordEdit(docId, edit.actor, edit.chars).then(() => undefined, log("edit")));
    }
    return writes;
  };

  const onText = (event: Y.YTextEvent, txn: Y.Transaction) => {
    // Agents long-polling the document are woken on every text change, whoever made it.
    wakeDocument(docId);
    const actor = actorFromOrigin(txn.origin);
    if (!actor) return;
    let chars = 0;
    for (const d of event.delta) {
      if (typeof d.insert === "string") chars += d.insert.length;
      if (typeof d.delete === "number") chars += d.delete;
    }
    if (chars === 0) return;
    const key = actor.id ?? actor.name;
    const entry = pending.get(key);
    if (entry) entry.chars += chars;
    else pending.set(key, { actor, chars });
    if (!timer) timer = setTimeout(flush, EDIT_FLUSH_MS);
  };

  const onMeta = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    if (!event.keysChanged.has("title")) return;
    const actor = actorFromOrigin(txn.origin);
    if (!actor) return;
    const title = meta.get("title");
    if (typeof title !== "string") return;
    void recordActivity(docId, actor, "title.change", { title: clip(title) }).catch(log("title"));
  };

  const onComments = (events: Y.YEvent<Y.AbstractType<unknown>>[], txn: Y.Transaction) => {
    const byOrigin = actorFromOrigin(txn.origin);
    if (!byOrigin) return;
    for (const event of events) {
      if (event.target === comments) {
        event.changes.keys.forEach((change, key) => {
          if (change.action !== "add") return;
          const map = comments.get(key);
          if (!map) return;
          const body = map.get("body");
          const author = activityActorFromCollab(map.get("authorId") as string | undefined, map.get("authorName") as string | undefined);
          void recordActivity(docId, author.id ? author : byOrigin, "comment.add", { threadId: key, quote: clip(typeof body === "string" ? body : "") }).catch(log("comment"));
        });
      } else if (event.target instanceof Y.Map && event.target.parent === comments && event.changes.keys.has("suggestionState")) {
        const map = event.target as Y.Map<unknown>;
        const state = map.get("suggestionState");
        if (state !== "accepted" && state !== "rejected") continue;
        void recordActivity(docId, byOrigin, state === "accepted" ? "comment.suggestion.accepted" : "comment.suggestion.rejected", { threadId: map.get("id"), author: map.get("authorName"), quote: clip(typeof map.get("quote") === "string" ? (map.get("quote") as string) : "") }).catch(log("suggestion"));
        // Accepting also resolves the thread in the same transaction; the resolve row below covers that.
        if (!event.changes.keys.has("resolved") || map.get("resolved") !== true) continue;
        const body = map.get("body");
        void recordActivity(docId, byOrigin, "comment.resolve", { threadId: map.get("id"), quote: clip(typeof body === "string" ? body : "") }).catch(log("resolve"));
      } else if (event.target instanceof Y.Map && event.target.parent === comments && event.changes.keys.has("resolved")) {
        const map = event.target as Y.Map<unknown>;
        if (map.get("resolved") !== true) continue;
        const body = map.get("body");
        void recordActivity(docId, byOrigin, "comment.resolve", { threadId: map.get("id"), quote: clip(typeof body === "string" ? body : "") }).catch(log("resolve"));
      } else if (event.target instanceof Y.Array && event.target.parent instanceof Y.Map && event.target.parent.parent === comments) {
        const threadId = (event.target.parent as Y.Map<unknown>).get("id");
        for (const d of event.changes.delta) {
          if (!Array.isArray(d.insert)) continue;
          for (const item of d.insert) {
            const reply = item as Y.Map<unknown> | Record<string, unknown>;
            const get = (k: string) => (reply instanceof Y.Map ? reply.get(k) : reply[k]);
            // Edited replies are re-inserted with the same id and an `editedAt`; only fresh replies count.
            if (get("editedAt")) continue;
            const body = get("body");
            const author = activityActorFromCollab(get("authorId") as string | undefined, get("authorName") as string | undefined);
            void recordActivity(docId, author.id ? author : byOrigin, "comment.reply", { threadId, replyId: get("id"), quote: clip(typeof body === "string" ? body : "") }).catch(log("reply"));
          }
        }
      }
    }
  };

  ytext.observe(onText);
  meta.observe(onMeta);
  comments.observeDeep(onComments);
  return () => {
    ytext.unobserve(onText);
    meta.unobserve(onMeta);
    comments.unobserveDeep(onComments);
    if (timer) clearTimeout(timer);
    return flush();
  };
}

const watchers = new Map<string, () => Promise<void>>();

/** Start watching a loaded document (idempotent per document id). */
export function startActivityWatch(doc: Y.Doc, docId: string) {
  void watchers.get(docId)?.();
  watchers.set(docId, watchDocumentActivity(doc, docId));
}

/** Stop watching when a document unloads; resolves once pending edits are written. */
export async function stopActivityWatch(docId: string): Promise<void> {
  const stop = watchers.get(docId);
  watchers.delete(docId);
  await stop?.();
}
