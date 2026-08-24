import * as Y from "yjs";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import type { NotificationKind } from "@/server/db/schema";
import { parseMentions } from "@/editor/collab/mentions";
import { readReply, type CommentReply } from "@/editor/collab/comments";
import { resolveAnchor, newId } from "@/editor/collab/shared";
import type { Suggestion } from "@/editor/collab/suggestions";
import type { CollabClaims } from "@/server/collab/token";
import { wakeDocument } from "@/server/agent-events";

export const SNIPPET_MAX = 120;

export function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_MAX ? flat.slice(0, SNIPPET_MAX - 1) + "…" : flat;
}

export interface NotifyInput {
  /** Recipient's GitHub login (any case). */
  userLogin: string;
  documentId: string;
  kind: NotificationKind;
  actorLogin?: string | null;
  actorName?: string | null;
  /** Thread, reply or suggestion id; the document id for shares. */
  refId: string;
  snippet?: string;
}

/**
 * Record one notification. Idempotent per (user, kind, ref): re-running a producer never
 * duplicates. Notifying yourself is ignored. Returns true when a new row was written.
 */
export async function notify(input: NotifyInput): Promise<boolean> {
  const userLogin = input.userLogin.trim().toLowerCase();
  if (!userLogin) return false;
  if (input.actorLogin && input.actorLogin.toLowerCase() === userLogin) return false;
  const db = await getDb();
  const inserted = await db
    .insert(schema.notifications)
    .values({
      id: newId(),
      userLogin,
      documentId: input.documentId,
      kind: input.kind,
      actorLogin: input.actorLogin ?? null,
      actorName: input.actorName ?? input.actorLogin ?? null,
      refId: input.refId,
      snippet: snippetOf(input.snippet ?? ""),
    })
    .onConflictDoNothing({ target: [schema.notifications.userLogin, schema.notifications.kind, schema.notifications.refId] })
    .returning();
  if (inserted.length > 0) wakeDocument(input.documentId);
  return inserted.length > 0;
}

/** Notify several people about the same thing (duplicates and the actor are dropped). Returns the number of new rows. */
export async function notifyMany(logins: Iterable<string | null | undefined>, input: Omit<NotifyInput, "userLogin">): Promise<number> {
  const unique = new Set<string>();
  for (const l of logins) if (typeof l === "string" && l.trim()) unique.add(l.trim().toLowerCase());
  let n = 0;
  for (const userLogin of unique) if (await notify({ ...input, userLogin })) n++;
  return n;
}

/**
 * Record every `@login` in `body` as a mention notification about `commentId`.
 * Idempotent per (comment, mentioned login); mentioning yourself is ignored.
 * Returns the number of new rows.
 */
export async function recordMentions(docId: string, commentId: string, byLogin: string | null, body: string, byName?: string | null): Promise<number> {
  const logins = parseMentions(body);
  if (logins.length === 0) return 0;
  return notifyMany(logins, { documentId: docId, kind: "mention", actorLogin: byLogin, actorName: byName ?? byLogin, refId: commentId, snippet: body });
}

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  documentId: string;
  documentTitle: string;
  actorLogin: string | null;
  actorName: string | null;
  refId: string;
  snippet: string;
  createdAt: Date;
  readAt: Date | null;
}

export const NOTIFICATION_KINDS: NotificationKind[] = ["mention", "reply", "resolve", "reopen", "suggestion.accept", "suggestion.reject", "share", "request.done"];

/** Wire shape: dates as ISO strings. */
export function toNotificationDto(n: NotificationItem) {
  return { ...n, createdAt: n.createdAt.toISOString(), readAt: n.readAt ? n.readAt.toISOString() : null };
}

export interface NotificationPage {
  items: NotificationItem[];
  unreadCount: number;
}

const userWhere = (login: string) => eq(schema.notifications.userLogin, login.toLowerCase());

/** The user's notifications, newest first, plus their total unread count. */
export async function listNotifications(login: string, opts: { unread?: boolean; limit?: number; kind?: NotificationKind } = {}): Promise<NotificationPage> {
  const db = await getDb();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const conds = [userWhere(login)];
  if (opts.unread) conds.push(isNull(schema.notifications.readAt));
  if (opts.kind) conds.push(eq(schema.notifications.kind, opts.kind));
  const items = await db
    .select({
      id: schema.notifications.id,
      kind: schema.notifications.kind,
      documentId: schema.notifications.documentId,
      documentTitle: schema.documents.title,
      actorLogin: schema.notifications.actorLogin,
      actorName: schema.notifications.actorName,
      refId: schema.notifications.refId,
      snippet: schema.notifications.snippet,
      createdAt: schema.notifications.createdAt,
      readAt: schema.notifications.readAt,
    })
    .from(schema.notifications)
    .innerJoin(schema.documents, eq(schema.documents.id, schema.notifications.documentId))
    .where(and(...conds))
    .orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
    .limit(limit);
  return { items, unreadCount: await unreadCount(login, opts.kind) };
}

export async function unreadCount(login: string, kind?: NotificationKind): Promise<number> {
  const db = await getDb();
  const conds = [userWhere(login), isNull(schema.notifications.readAt)];
  if (kind) conds.push(eq(schema.notifications.kind, kind));
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.notifications)
    .where(and(...conds));
  return row?.n ?? 0;
}

/** Mark one notification read. Only its recipient may; returns false if nothing changed. */
export async function markNotificationRead(id: string, login: string): Promise<boolean> {
  const db = await getDb();
  const updated = await db
    .update(schema.notifications)
    .set({ readAt: new Date() })
    .where(and(eq(schema.notifications.id, id), userWhere(login), isNull(schema.notifications.readAt)))
    .returning();
  return updated.length > 0;
}

/** True when the notification exists and is addressed to `login`, whether or not it has been read. */
export async function notificationBelongsTo(id: string, login: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.id, id), userWhere(login)))
    .limit(1);
  return Boolean(row);
}

/** Mark all of the user's unread notifications read. Returns how many changed. */
export async function markAllNotificationsRead(login: string): Promise<number> {
  const db = await getDb();
  const updated = await db
    .update(schema.notifications)
    .set({ readAt: new Date() })
    .where(and(userWhere(login), isNull(schema.notifications.readAt)))
    .returning();
  return updated.length;
}

/** Mark read every unread notification of the user that points at one of `refIds` (a thread and its replies, say). */
export async function markRefsRead(login: string, documentId: string, refIds: string[]): Promise<number> {
  if (refIds.length === 0) return 0;
  const db = await getDb();
  const updated = await db
    .update(schema.notifications)
    .set({ readAt: new Date() })
    .where(and(userWhere(login), eq(schema.notifications.documentId, documentId), isNull(schema.notifications.readAt), inArray(schema.notifications.refId, refIds)))
    .returning();
  return updated.length;
}

/** Login for a collab author id (user ids map through the user table; agent ids have no login). */
export async function loginForUserId(userId: string | null | undefined): Promise<string | null> {
  if (!userId || userId.startsWith("agent:")) return null;
  const db = await getDb();
  const [row] = await db.select({ login: schema.users.login }).from(schema.users).where(eq(schema.users.id, userId));
  return row?.login ?? null;
}

// --- Thread helpers ----------------------------------------------------------

type ThreadMap = Y.Map<unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export interface ThreadInfo {
  id: string;
  body: string;
  authorLogin: string | null;
  replies: CommentReply[];
}

export function readThread(map: ThreadMap): ThreadInfo | null {
  const id = str(map.get("id"));
  if (!id) return null;
  const raw = map.get("replies");
  const replies = raw instanceof Y.Array ? (raw.toArray() as Parameters<typeof readReply>[0][]).map((r) => readReply(r)) : [];
  return { id, body: str(map.get("body")) ?? "", authorLogin: str(map.get("authorLogin")), replies };
}

/** Everyone who wrote in a thread (author first, then repliers), as logins. */
export function threadParticipants(thread: ThreadInfo): string[] {
  const out: string[] = [];
  if (thread.authorLogin) out.push(thread.authorLogin);
  for (const r of thread.replies) if (r.authorLogin) out.push(r.authorLogin);
  return out;
}

interface Actor {
  login: string | null;
  name: string | null;
}

const log = (what: string) => (err: unknown) => console.error(`[notifications] ${what} failed`, err);

/** `reply`: thread author and everyone who replied before, except the replier. */
export async function notifyReply(docId: string, thread: ThreadInfo, reply: CommentReply): Promise<number> {
  const earlier = thread.replies.filter((r) => r.id !== reply.id && r.createdAt <= reply.createdAt);
  const recipients = [thread.authorLogin, ...earlier.map((r) => r.authorLogin)];
  const actor = reply.authorLogin ?? null;
  if (!actor) return 0;
  return notifyMany(recipients, { documentId: docId, kind: "reply", actorLogin: actor, actorName: reply.authorName, refId: reply.id, snippet: reply.body });
}

/** `resolve` / `reopen`: every participant of the thread except the actor. */
export async function notifyResolved(docId: string, thread: ThreadInfo, resolved: boolean, actor: Actor): Promise<number> {
  if (!actor.login) return 0;
  return notifyMany(threadParticipants(thread), {
    documentId: docId,
    kind: resolved ? "resolve" : "reopen",
    actorLogin: actor.login,
    actorName: actor.name,
    refId: thread.id,
    snippet: thread.body,
  });
}

/** `suggestion.accept` / `suggestion.reject`: the suggestion's author, unless they decided themselves. */
export async function notifySuggestionDecision(docId: string, suggestion: Pick<Suggestion, "id" | "authorId" | "text" | "type">, accepted: boolean, actor: Actor): Promise<boolean> {
  if (!actor.login) return false;
  const login = await loginForUserId(suggestion.authorId);
  if (!login) return false;
  const verb = suggestion.type === "delete" ? "Delete " : "";
  return notify({
    userLogin: login,
    documentId: docId,
    kind: accepted ? "suggestion.accept" : "suggestion.reject",
    actorLogin: actor.login,
    actorName: actor.name,
    refId: suggestion.id,
    snippet: verb + JSON.stringify(suggestion.text ?? ""),
  });
}

/** `share`: the person a document was just shared with. */
export async function notifyShare(docId: string, login: string, role: string, actor: Actor): Promise<boolean> {
  return notify({ userLogin: login, documentId: docId, kind: "share", actorLogin: actor.login, actorName: actor.name, refId: `${docId}:${login.toLowerCase()}`, snippet: role });
}

// --- Live document watcher -----------------------------------------------------

type Origin = { source?: string; connection?: { context?: CollabClaims } } | null | undefined;

/** The signed-in human behind a WebSocket transaction; null for server-side (REST) mutations, whose routes notify themselves. */
function actorFromOrigin(origin: unknown): Actor | null {
  const o = origin as Origin;
  if (!o || typeof o !== "object" || o.source !== "connection") return null;
  const claims = o.connection?.context;
  if (!claims?.userId) return null;
  return { login: claims.login ?? null, name: claims.name ?? claims.login ?? null };
}

function recordThreadMentions(docId: string, map: ThreadMap) {
  const thread = readThread(map);
  if (!thread || !thread.body) return;
  void recordMentions(docId, thread.id, thread.authorLogin, thread.body, str(map.get("authorName"))).catch(log("mention"));
}

/**
 * Watch the shared comments and suggestions of a live document and produce
 * notifications as things happen: mentions in new or edited bodies, replies,
 * threads resolved or re-opened in the UI, suggestions accepted or rejected in
 * the UI. REST routes perform the same calls themselves (everything is
 * idempotent, so overlap is harmless). Returns an unsubscribe function.
 */
export function watchDocumentNotifications(doc: Y.Doc, docId: string): () => void {
  const comments = doc.getMap<ThreadMap>("comments");
  const suggestions = doc.getMap<Suggestion>("suggestions");
  const ytext = doc.getText("content");

  const onComments = (events: Y.YEvent<Y.AbstractType<unknown>>[], txn: Y.Transaction) => {
    const actor = actorFromOrigin(txn.origin);
    for (const event of events) {
      if (event.target === comments) {
        event.changes.keys.forEach((change, key) => {
          if (change.action !== "add") return;
          const map = comments.get(key);
          if (map) recordThreadMentions(docId, map);
        });
      } else if (event.target instanceof Y.Map && event.target.parent === comments) {
        const map = event.target as ThreadMap;
        if (event.changes.keys.has("body")) recordThreadMentions(docId, map);
        if (event.changes.keys.has("resolved") && actor) {
          const thread = readThread(map);
          if (thread) void notifyResolved(docId, thread, map.get("resolved") === true, actor).catch(log("resolve"));
        }
      } else if (event.target instanceof Y.Array) {
        const parent = event.target.parent;
        const thread = parent instanceof Y.Map ? readThread(parent as ThreadMap) : null;
        for (const d of event.changes.delta) {
          if (!d.insert || !Array.isArray(d.insert)) continue;
          for (const item of d.insert) {
            if (!item || typeof item !== "object") continue;
            const reply = readReply(item as Parameters<typeof readReply>[0]);
            if (typeof reply.id !== "string" || typeof reply.body !== "string") continue;
            void recordMentions(docId, reply.id, reply.authorLogin ?? null, reply.body, reply.authorName).catch(log("mention"));
            // Edited replies are re-inserted with the same id; idempotency keeps this a no-op for them.
            if (thread) void notifyReply(docId, thread, reply).catch(log("reply"));
          }
        }
      }
    }
  };

  const onSuggestions = (event: Y.YMapEvent<Suggestion>, txn: Y.Transaction) => {
    const actor = actorFromOrigin(txn.origin);
    if (!actor) return;
    event.changes.keys.forEach((change, key) => {
      if (change.action !== "delete") return;
      const old = change.oldValue as Suggestion | undefined;
      if (!old || typeof old !== "object" || !old.anchor) return;
      // Accepting keeps an insertion's text / removes a deletion's; rejecting does the opposite.
      const range = resolveAnchor(ytext, old.anchor);
      const textRemains = !!range && range.to > range.from;
      const accepted = old.type === "insert" ? textRemains : !textRemains;
      void notifySuggestionDecision(docId, { ...old, id: key }, accepted, actor).catch(log("suggestion"));
    });
  };

  comments.observeDeep(onComments);
  suggestions.observe(onSuggestions);
  return () => {
    comments.unobserveDeep(onComments);
    suggestions.unobserve(onSuggestions);
  };
}
