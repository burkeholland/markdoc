import * as Y from "yjs";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { accessibleLoginsForDocument, effectiveRoleSql } from "@/server/document-access";
import type { NotificationKind } from "@/server/db/schema";
import { parseAgentMentions, parseMentions } from "@/editor/collab/mentions";
import { readReply, readReplySuggestionDecision, type CommentReply } from "@/editor/collab/comments";
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
  agentTargets?: string[];
  /**
   * Keep the row even when the actor is the recipient, but store it already read: the row reaches the
   * recipient's agents (they watch the notifications table) without ringing the human's bell.
   */
  selfAsRead?: boolean;
}

/**
 * Record one notification. Idempotent per (user, kind, ref): re-running a producer never
 * duplicates. Notifying yourself is ignored (unless `selfAsRead`). Returns true when a new row was written.
 */
export async function notify(input: NotifyInput): Promise<boolean> {
  const userLogin = input.userLogin.trim().toLowerCase();
  if (!userLogin) return false;
  const self = !!input.actorLogin && input.actorLogin.toLowerCase() === userLogin;
  if (self && !input.selfAsRead) return false;
  const db = await getDb();
  if (input.kind === "mention" && input.agentTargets) {
    const [existing] = await db
      .select({ id: schema.notifications.id, agentTargets: schema.notifications.agentTargets })
      .from(schema.notifications)
      .where(and(userWhere(userLogin), eq(schema.notifications.kind, "mention"), eq(schema.notifications.refId, input.refId)))
      .limit(1);
    const normalized = (targets: string[] | null) => (targets ?? []).map((target) => target.toLowerCase()).sort();
    if (existing) {
      if (JSON.stringify(normalized(existing.agentTargets)) === JSON.stringify(normalized(input.agentTargets))) return false;
      await db
        .update(schema.notifications)
        .set({
          actorLogin: input.actorLogin ?? null,
          actorName: input.actorName ?? input.actorLogin ?? null,
          snippet: snippetOf(input.snippet ?? ""),
          agentTargets: input.agentTargets,
          createdAt: new Date(),
          readAt: self ? new Date() : null,
        })
        .where(eq(schema.notifications.id, existing.id));
      wakeDocument(input.documentId);
      return true;
    }
  }
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
      agentTargets: input.agentTargets ?? null,
      readAt: self ? new Date() : null,
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

async function mentionRecipientsWithAccess(docId: string, logins: string[]): Promise<string[]> {
  if (logins.length === 0) return [];
  const allowed = await accessibleLoginsForDocument(docId, logins);
  return logins.filter((login) => allowed.has(login));
}

/**
 * Record every `@login` in `body` as a mention notification about `commentId`.
 * Only recipients who can open the document are notified. Idempotent per (comment,
 * mentioned login); mentioning yourself is ignored — except
 * `@you/Your-Agent`, which is stored already read so your agent's watch still gets it
 * (notifications are keyed on the token's user) without badging you.
 * Returns the number of new rows.
 */
export async function recordMentions(docId: string, commentId: string, byLogin: string | null, body: string, byName?: string | null): Promise<number> {
  const logins = [...new Set(parseMentions(body).map((login) => login.toLowerCase()))];
  const db = await getDb();
  const existing = await db
    .select({ id: schema.notifications.id, userLogin: schema.notifications.userLogin })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.documentId, docId), eq(schema.notifications.kind, "mention"), eq(schema.notifications.refId, commentId)));
  const recipients = await mentionRecipientsWithAccess(docId, logins);
  const current = new Set(recipients);
  const removed = existing.filter((notification) => !current.has(notification.userLogin));
  if (removed.length > 0) {
    await db.delete(schema.notifications).where(inArray(schema.notifications.id, removed.map((notification) => notification.id)));
    wakeDocument(docId);
  }
  if (recipients.length === 0) return 0;
  const agentTargets = new Map<string, string[]>();
  for (const mention of parseAgentMentions(body)) {
    const targets = agentTargets.get(mention.login) ?? [];
    if (!targets.some((target) => target.toLowerCase() === mention.agent.toLowerCase())) targets.push(mention.agent);
    agentTargets.set(mention.login, targets);
  }
  let n = 0;
  for (const login of recipients) {
    const targets = agentTargets.get(login) ?? [];
    const ok = await notify({ userLogin: login, documentId: docId, kind: "mention", actorLogin: byLogin, actorName: byName ?? byLogin, refId: commentId, snippet: body, agentTargets: targets, selfAsRead: targets.length > 0 });
    if (ok) n++;
  }
  return n;
}

interface NotificationBase {
  id: string;
  kind: NotificationKind;
  actorLogin: string | null;
  actorName: string | null;
  refId: string;
  snippet: string;
  agentTargets: string[] | null;
  createdAt: Date;
  readAt: Date | null;
}
export type NotificationItem = NotificationBase & (
  | { resource?: "document"; documentId: string; documentTitle: string; folderId?: never; folderName?: never }
  | { resource: "folder"; documentId: null; documentTitle: null; folderId: string; folderName: string }
);

export const NOTIFICATION_KINDS: NotificationKind[] = ["mention", "reply", "resolve", "reopen", "suggestion.accept", "suggestion.reject", "suggestion.accepted", "review", "share", "access.request", "request.done", "webhook.disabled"];

/** Wire shape: dates as ISO strings. */
export function toNotificationDto(n: NotificationItem) {
  return { ...n, createdAt: n.createdAt.toISOString(), readAt: n.readAt ? n.readAt.toISOString() : null };
}

export interface NotificationPage {
  items: NotificationItem[];
  unreadCount: number;
}

const userWhere = (login: string) => eq(schema.notifications.userLogin, login.toLowerCase());

const mentionDocumentAccessWhere = (login: string) => {
  const access = effectiveRoleSql(schema.documents, { login, signedIn: true });
  return sql`${access.role} is not null`;
};

const visibleNotificationWhere = (login: string) =>
  and(isNull(schema.documents.deletedAt), or(ne(schema.notifications.kind, "mention"), mentionDocumentAccessWhere(login)));

const folderUserWhere = (login: string) => eq(schema.folderNotifications.userLogin, login.toLowerCase());
const visibleFolderNotificationWhere = (login: string) => {
  const owner = sql`${schema.folders.ownerId} in (select ${schema.users.id} from ${schema.users} where lower(${schema.users.login}) = ${login.toLowerCase()})`;
  const collaborator = sql`exists (select 1 from ${schema.folderCollaborators} where ${schema.folderCollaborators.folderId} = ${schema.folders.id} and lower(${schema.folderCollaborators.login}) = ${login.toLowerCase()})`;
  return or(owner, and(eq(schema.folderNotifications.kind, "share"), or(ne(schema.folders.linkAccess, "private"), collaborator)));
};

/** The user's notifications, newest first, plus their total unread count. */
export async function listNotifications(login: string, opts: { unread?: boolean; limit?: number; kind?: NotificationKind } = {}): Promise<NotificationPage> {
  const db = await getDb();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const conds = [userWhere(login), visibleNotificationWhere(login)];
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
      agentTargets: schema.notifications.agentTargets,
      createdAt: schema.notifications.createdAt,
      readAt: schema.notifications.readAt,
    })
    .from(schema.notifications)
    .innerJoin(schema.documents, eq(schema.documents.id, schema.notifications.documentId))
    .where(and(...conds))
    .orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
    .limit(limit);
  const folderConds = [folderUserWhere(login), visibleFolderNotificationWhere(login)];
  if (opts.unread) folderConds.push(isNull(schema.folderNotifications.readAt));
  if (opts.kind) folderConds.push(sql`${schema.folderNotifications.kind} = ${opts.kind}`);
  const folderItems = await db.select({
    id: schema.folderNotifications.id, kind: schema.folderNotifications.kind,
    folderId: schema.folderNotifications.folderId, folderName: schema.folders.name,
    actorLogin: schema.folderNotifications.actorLogin, actorName: schema.folderNotifications.actorName,
    refId: schema.folderNotifications.refId, snippet: schema.folderNotifications.snippet,
    createdAt: schema.folderNotifications.createdAt, readAt: schema.folderNotifications.readAt,
  }).from(schema.folderNotifications).innerJoin(schema.folders, eq(schema.folders.id, schema.folderNotifications.folderId))
    .where(and(...folderConds)).orderBy(desc(schema.folderNotifications.createdAt), desc(schema.folderNotifications.id)).limit(limit);
  const merged: NotificationItem[] = [...items, ...folderItems.map((item) => ({
    ...item, resource: "folder" as const, documentId: null, documentTitle: null, agentTargets: null,
  }))];
  merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  return { items: merged.slice(0, limit), unreadCount: await unreadCount(login, opts.kind) };
}

export async function unreadCount(login: string, kind?: NotificationKind): Promise<number> {
  const db = await getDb();
  const conds = [userWhere(login), isNull(schema.notifications.readAt), visibleNotificationWhere(login)];
  if (kind) conds.push(eq(schema.notifications.kind, kind));
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.notifications)
    .innerJoin(schema.documents, eq(schema.documents.id, schema.notifications.documentId))
    .where(and(...conds));
  const [folderRow] = await db.select({ n: sql<number>`count(*)::int` })
    .from(schema.folderNotifications).innerJoin(schema.folders, eq(schema.folders.id, schema.folderNotifications.folderId))
    .where(and(folderUserWhere(login), isNull(schema.folderNotifications.readAt), visibleFolderNotificationWhere(login),
      kind ? sql`${schema.folderNotifications.kind} = ${kind}` : undefined));
  return (row?.n ?? 0) + (folderRow?.n ?? 0);
}

/** Mark one notification read. Only its recipient may; returns false if nothing changed. */
export async function markNotificationRead(id: string, login: string, documentIds?: string[] | null): Promise<boolean> {
  if (documentIds && documentIds.length === 0) return false;
  const db = await getDb();
  const updated = await db
    .update(schema.notifications)
    .set({ readAt: new Date() })
    .where(and(eq(schema.notifications.id, id), userWhere(login), isNull(schema.notifications.readAt), documentIds ? inArray(schema.notifications.documentId, documentIds) : undefined))
    .returning();
  if (updated.length > 0) return true;
  if (documentIds) return false;
  const folderUpdated = await db.update(schema.folderNotifications).set({ readAt: new Date() })
    .where(and(eq(schema.folderNotifications.id, id), folderUserWhere(login), isNull(schema.folderNotifications.readAt))).returning();
  return folderUpdated.length > 0;
}

/** True when the notification exists and is addressed to `login`, whether or not it has been read. */
export async function notificationBelongsTo(id: string, login: string, documentIds?: string[] | null): Promise<boolean> {
  if (documentIds && documentIds.length === 0) return false;
  const db = await getDb();
  const [row] = await db
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.id, id), userWhere(login), documentIds ? inArray(schema.notifications.documentId, documentIds) : undefined))
    .limit(1);
  if (row) return true;
  if (documentIds) return false;
  const [folderRow] = await db.select({ id: schema.folderNotifications.id }).from(schema.folderNotifications)
    .where(and(eq(schema.folderNotifications.id, id), folderUserWhere(login))).limit(1);
  return Boolean(folderRow);
}

/** Mark all of the user's unread notifications read, optionally within a token's document boundary. */
export async function markAllNotificationsRead(login: string, documentIds?: string[] | null): Promise<number> {
  if (documentIds && documentIds.length === 0) return 0;
  const db = await getDb();
  const updated = await db
    .update(schema.notifications)
    .set({ readAt: new Date() })
    .where(and(userWhere(login), isNull(schema.notifications.readAt), documentIds ? inArray(schema.notifications.documentId, documentIds) : undefined))
    .returning();
  if (documentIds) return updated.length;
  const foldersUpdated = await db.update(schema.folderNotifications).set({ readAt: new Date() })
    .where(and(folderUserWhere(login), isNull(schema.folderNotifications.readAt))).returning();
  return updated.length + foldersUpdated.length;
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

/**
 * `reply`: thread author and everyone who replied before, except the replier. A reply posted against an
 * agent request (`requestId` on the reply) notifies nobody here: the requester hears `request.done` when
 * the agent completes, and a second bell for the same answer would be noise. Mentions in it still notify.
 */
export async function notifyReply(docId: string, thread: ThreadInfo, reply: CommentReply): Promise<number> {
  if (reply.requestId) return 0;
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

async function notifyFolder(folderId: string, login: string, kind: "share" | "access.request", actor: { login?: string | null; name?: string | null }, snippet = ""): Promise<boolean> {
  const userLogin = login.trim().toLowerCase();
  if (!userLogin || actor.login?.toLowerCase() === userLogin) return false;
  const db = await getDb();
  const rows = await db.insert(schema.folderNotifications).values({
    id: newId(), folderId, userLogin, kind,
    actorLogin: actor.login ?? null, actorName: actor.name ?? actor.login ?? null,
    refId: `${folderId}:${kind === "share" ? userLogin : actor.login?.toLowerCase()}`, snippet: snippetOf(snippet),
  }).onConflictDoNothing({ target: [schema.folderNotifications.userLogin, schema.folderNotifications.kind, schema.folderNotifications.refId] }).returning();
  return rows.length > 0;
}

export async function notifyFolderShare(folderId: string, login: string, role: string, actor: { login?: string | null; name?: string | null }): Promise<boolean> {
  return notifyFolder(folderId, login, "share", actor, role);
}

export async function notifyFolderAccessRequest(folderId: string, actor: { login?: string | null; name?: string | null }): Promise<boolean> {
  if (!actor.login) return false;
  const db = await getDb();
  const [owner] = await db.select({ login: schema.users.login }).from(schema.folders)
    .innerJoin(schema.users, eq(schema.users.id, schema.folders.ownerId)).where(eq(schema.folders.id, folderId)).limit(1);
  return owner?.login ? notifyFolder(folderId, owner.login, "access.request", actor) : false;
}

/**
 * `access.request`: the owner of a document someone without access asked to join. Silently a no-op
 * (false) when the document is missing or trashed, or the requester has no login, so callers can answer
 * identically either way and never reveal whether the document exists. Idempotent per requester.
 */
export async function notifyAccessRequest(docId: string, actor: { login?: string | null; name?: string | null }): Promise<boolean> {
  if (!actor.login) return false;
  const db = await getDb();
  const [row] = await db
    .select({ ownerLogin: schema.users.login })
    .from(schema.documents)
    .innerJoin(schema.users, eq(schema.users.id, schema.documents.ownerId))
    .where(and(eq(schema.documents.id, docId), isNull(schema.documents.deletedAt)))
    .limit(1);
  if (!row?.ownerLogin) return false;
  return notify({ userLogin: row.ownerLogin, documentId: docId, kind: "access.request", actorLogin: actor.login, actorName: actor.name, refId: `${docId}:${actor.login.toLowerCase()}` });
}

/** `suggestion.accepted`: the author of a comment or reply whose suggestion was applied, unless they did it themselves. */
export async function notifySuggestionAccepted(
  docId: string,
  target: { id: string; authorId: string; authorLogin: string | null },
  quote: string,
  actor: Actor,
): Promise<boolean> {
  if (!actor.login) return false;
  // Agents' collab ids are `agent:<userId>:<token>`; the notification goes to the human behind the token.
  const login = target.authorLogin ?? (await loginForUserId(target.authorId.startsWith("agent:") ? target.authorId.split(":")[1] : target.authorId));
  if (!login) return false;
  return notify({ userLogin: login, documentId: docId, kind: "suggestion.accepted", actorLogin: actor.login, actorName: actor.name, refId: target.id, snippet: quote });
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
        if (event.changes.keys.has("suggestionState") && actor && map.get("suggestionState") === "accepted") {
          const thread = readThread(map);
          const authorId = str(map.get("authorId"));
          if (thread && authorId) {
            void notifySuggestionAccepted(docId, { id: thread.id, authorId, authorLogin: thread.authorLogin }, str(map.get("quote")) ?? "", actor).catch(log("suggestion.accepted"));
          }
        }
      } else if (event.target instanceof Y.Map && event.target.parent instanceof Y.Map && event.target.parent.parent === comments && event.target.parent.get("replySuggestions") === event.target) {
        if (!actor) continue;
        const decisions = event.target as Y.Map<unknown>;
        const thread = readThread(decisions.parent as ThreadMap);
        event.changes.keys.forEach((_change, replyId) => {
          const decision = readReplySuggestionDecision(replyId, decisions.get(replyId));
          const reply = thread?.replies.find((item) => item.id === replyId);
          if (decision?.suggestionState !== "accepted" || !reply) return;
          void notifySuggestionAccepted(
            docId,
            { id: reply.id, authorId: reply.authorId, authorLogin: reply.authorLogin ?? null },
            decision.quote,
            actor,
          ).catch(log("reply suggestion.accepted"));
        });
      } else if (event.target instanceof Y.Array) {
        const parent = event.target.parent;
        const thread = parent instanceof Y.Map ? readThread(parent as ThreadMap) : null;
        for (const d of event.changes.delta) {
          if (!d.insert || !Array.isArray(d.insert)) continue;
          for (const item of d.insert) {
            if (!item || typeof item !== "object") continue;
            const reply = readReply(item as Parameters<typeof readReply>[0]);
            if (typeof reply.id !== "string" || typeof reply.body !== "string") continue;
            if (reply.suggestionState === "accepted" || reply.suggestionState === "rejected") continue;
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
      // The primary record is the insertion (or the sole deletion): a paired
      // replacement produces one decision notification, just like its review card.
      if (old.groupId && old.groupId !== key) return;
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
