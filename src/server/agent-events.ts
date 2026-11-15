import { and, asc, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { createTwoFilesPatch } from "diff";
import { getDb, schema } from "@/server/db";
import { effectiveRoleSql } from "@/server/document-access";
import type { SessionUser } from "@/server/documents";
import { contentHash } from "@/server/export/html";
import { agentMentionSlug, parseAgentMentions } from "@/editor/collab/mentions";

// This module is loaded by both the custom server (Hocuspocus hooks wake waiters) and the Next.js route
// bundle (long-polls wait). They are separate module graphs in one process, so all state lives on globalThis,
// and nothing that drags `next/headers` into the custom server (http.ts, livedoc.ts) is imported statically.

/** Long-poll upper bound; clients loop. */
export const WAIT_MAX_S = 55;
/** A unified diff longer than this many lines is truncated (the agent can re-read the document). */
export const DIFF_MAX_LINES = 200;
const TEXT_CACHE_PER_DOC = 4;

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor");
  }
}

/**
 * Who caused an event. `self` is true when it was the polling token itself (its own append, comment,
 * review…); such events are dropped unless the watch asks for `includeSelf`. `kind` tells a person's
 * action from another agent's; `agent` is the token name when `kind` is "agent".
 */
export interface EventActor {
  /** User id, or `agent:<userId>:<tokenName>` for an agent; null when unknown. */
  id: string | null;
  name: string;
  login: string | null;
  kind: "user" | "agent";
  agent: string | null;
  self: boolean;
}

export type AgentEvent =
  | { type: "content.changed"; documentId: string; contentHash: string; previousHash: string | null; diff: string | null; truncated: boolean; actor: EventActor; at: string }
  | { type: "comment.added" | "comment.replied" | "comment.resolved"; documentId: string; threadId: string | null; author: string; authorKind: string; body: string; quote: string | null; actor: EventActor; at: string }
  | { type: "suggestion.accepted" | "suggestion.rejected"; documentId: string; threadId: string | null; replyId?: string; by: string; byKind: string; author: string | null; quote: string | null; actor: EventActor; at: string }
  | { type: "review.created"; documentId: string; reviewId: string; by: string; byKind: string; verdict: string; summary: string; comments: number; suggestions: number; threadIds: string[]; actor: EventActor; at: string }
  | { type: "mention"; documentId: string; documentTitle: string | null; refId: string; threadId: string | null; by: string | null; byLogin: string | null; snippet: string; agent: string | null; agents: string[]; actor: EventActor; at: string }
  | { type: "request.created"; documentId: string; documentTitle: string | null; requestId: string; by: string | null; mode: string; instruction: string; quote: string | null; threadId: string | null; agent: string | null; actor: EventActor; at: string }
  | { type: "activity"; documentId: string; action: string; actor: EventActor; actorName: string; actorKind: string; detail: Record<string, unknown>; at: string };

export interface WatchOptions {
  /** Deliver the polling token's own events too (default: they are skipped). */
  includeSelf?: boolean;
}

/** The actor id an agent token writes activity rows under (see activityActor in activity.ts). */
export function selfActorId(user: SessionUser & { agent?: string }): string | null {
  return user.agent ? `agent:${user.id}:${user.agent}` : null;
}

/** What the opaque cursor carries: activity/notification/request high-water marks plus the last seen content hash. */
interface CursorState {
  /** Epoch ms of the newest activity row returned (rows at exactly this instant are listed in `ids`). */
  a: number;
  ids: string[];
  /** Epoch ms of the newest notification returned. */
  n: number;
  /** Epoch ms of the newest agent request returned. */
  r: number;
  /** Clean-content hash at the last response (single-document watch only). */
  h: string | null;
}

export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined): CursorState | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorState>;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.a !== "number") throw new Error("shape");
    return {
      a: parsed.a,
      ids: Array.isArray(parsed.ids) ? parsed.ids.filter((x): x is string => typeof x === "string") : [],
      n: typeof parsed.n === "number" ? parsed.n : parsed.a,
      r: typeof parsed.r === "number" ? parsed.r : parsed.a,
      h: typeof parsed.h === "string" ? parsed.h : null,
    };
  } catch {
    throw new InvalidCursorError();
  }
}

// --- Wake-ups -----------------------------------------------------------------

const GLOBAL = "*";
/** A writer as known at write time: an activity actor id/name/kind (the token's `agent:<userId>:<name>` id for agents). */
export interface WriterRef {
  id: string | null;
  name: string;
  kind: "user" | "agent";
}
/** One API write that moved the clean-text hash of a document. */
interface ContentWrite {
  from: string;
  to: string;
  writer: WriterRef;
}
interface SharedState {
  seqs: Map<string, number>;
  waiters: Map<string, Set<() => void>>;
  textCache: Map<string, Map<string, string>>;
  /** Recent hash transitions caused by API writes, oldest first. */
  writes: Map<string, ContentWrite[]>;
  /** The last person seen typing in the editor (WebSocket), per document. */
  typists: Map<string, WriterRef>;
}
const g = globalThis as typeof globalThis & { __markdocAgentEvents?: SharedState };
const shared: SharedState = (g.__markdocAgentEvents ??= { seqs: new Map(), waiters: new Map(), textCache: new Map(), writes: new Map(), typists: new Map() });
shared.writes ??= new Map();
shared.typists ??= new Map();
const { seqs, waiters, textCache, writes, typists } = shared;
const WRITES_PER_DOC = 32;

function bump(key: string) {
  seqs.set(key, (seqs.get(key) ?? 0) + 1);
  const set = waiters.get(key);
  if (!set) return;
  waiters.delete(key);
  for (const resolve of set) resolve();
}

/** Something happened on a document: wake long-polls on it and the cross-document ones. Cheap; safe to call often. */
export function wakeDocument(docId: string) {
  bump(docId);
  bump(GLOBAL);
}

export function wakeSeq(docId: string | null): number {
  return seqs.get(docId ?? GLOBAL) ?? 0;
}

/** Documents whose wake sequence differs from `known` (or all woken documents when `known` is empty), with the current seqs. */
export function wokenDocuments(known: ReadonlyMap<string, number>): { changed: string[]; seqs: Map<string, number> } {
  const snapshot = new Map(seqs);
  snapshot.delete(GLOBAL);
  const changed: string[] = [];
  for (const [docId, seq] of snapshot) if (known.get(docId) !== seq) changed.push(docId);
  return { changed, seqs: snapshot };
}

/** Resolves when the document (or any document) is woken after `seq`, or after `timeoutMs`. Never rejects. */
export function waitForWake(docId: string | null, seq: number, timeoutMs: number): Promise<void> {
  const key = docId ?? GLOBAL;
  if (wakeSeq(docId) !== seq || timeoutMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let set = waiters.get(key);
    if (!set) {
      set = new Set();
      waiters.set(key, set);
    }
    const done = () => {
      clearTimeout(timer);
      waiters.get(key)?.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    set.add(done);
  });
}

export function clampWait(raw: string | null | undefined): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), WAIT_MAX_S);
}

// --- Content diffs ------------------------------------------------------------

function rememberText(docId: string, hash: string, text: string) {
  let m = textCache.get(docId);
  if (!m) {
    m = new Map();
    textCache.set(docId, m);
  }
  m.delete(hash);
  m.set(hash, text);
  while (m.size > TEXT_CACHE_PER_DOC) m.delete(m.keys().next().value!);
}

/**
 * Remember the clean text a caller just read under its hash, so a later write that sends that hash back
 * (`ifContentHash` / `If-Match`) can be answered with a diff of what moved in between.
 */
export function rememberCleanText(docId: string, text: string): string {
  const hash = contentHash(text);
  rememberText(docId, hash, text);
  return hash;
}

/** The clean text last seen under `hash` on this document, if it is still cached. */
export function cachedCleanText(docId: string, hash: string): string | null {
  return textCache.get(docId)?.get(hash) ?? null;
}

/**
 * Most changed lines (removed and added counted together) a diff is worked out for. The line diff's time
 * grows with the square of that count: for two texts of 2,000,000 characters with no line in common the
 * server's one thread gave no answer in 30 s (the run was stopped then), and anybody who may write could ask
 * for it with an old hash, an agent's watch with a read token too (#2341). Up to 1,000 it took about 150 ms
 * on a machine at full load. A diff of more changed lines would be cut to `DIFF_MAX_LINES` anyway.
 */
export const DIFF_MAX_CHANGED_LINES = 1_000;

/**
 * Unified diff of two texts, capped to `DIFF_MAX_LINES` lines. `diff` is null (and `truncated` true) when
 * more than `DIFF_MAX_CHANGED_LINES` lines changed: the reader is better off reading the text again.
 */
export function unifiedDiff(before: string, after: string, title = "document.md"): { diff: string | null; truncated: boolean } {
  const patch = createTwoFilesPatch(title, title, before, after, "before", "after", { context: 2, maxEditLength: DIFF_MAX_CHANGED_LINES });
  if (patch === undefined) return { diff: null, truncated: true };
  const all = patch.split("\n");
  const firstHunk = all.findIndex((l) => l.startsWith("@@"));
  const lines = firstHunk === -1 ? [] : all.slice(firstHunk); // drop the Index/---/+++ file header
  if (lines.length <= DIFF_MAX_LINES) return { diff: lines.join("\n"), truncated: false };
  return { diff: lines.slice(0, DIFF_MAX_LINES).join("\n") + `\n… ${lines.length - DIFF_MAX_LINES} more lines`, truncated: true };
}

// --- Who wrote what ------------------------------------------------------------

/**
 * An API write landed (see mutateLiveDoc): remember that `writer` moved the clean text from `before` to
 * `after`, so a watch can tell its own edits from everyone else's. Text changes that do not move the hash
 * (comments, pending suggestions) are ignored. Both texts are cached for diffs.
 */
export function noteContentWrite(docId: string, writer: WriterRef, before: string, after: string) {
  const from = contentHash(before);
  const to = contentHash(after);
  if (from === to) return;
  rememberText(docId, from, before);
  rememberText(docId, to, after);
  let list = writes.get(docId);
  if (!list) {
    list = [];
    writes.set(docId, list);
  }
  list.push({ from, to, writer });
  while (list.length > WRITES_PER_DOC) list.shift();
}

/** Someone typed in the editor over WebSocket: remembered as the likely author of content changes no API write explains. */
export function noteTypist(docId: string, writer: WriterRef) {
  typists.set(docId, writer);
}

/**
 * Who changed the clean text from `fromHash` to `toHash`, as far as API writes tell: `{ selfOnly: true }`
 * when every recorded transition between the two was made by `selfId`; otherwise the most recent writer
 * that was not self — falling back to the last person seen typing when a change has no API record.
 */
function explainContentChange(docId: string, fromHash: string, toHash: string, selfId: string | null): { selfOnly: boolean; writer: WriterRef | null } {
  const list = writes.get(docId) ?? [];
  const seen = new Set<string>();
  let hash = toHash;
  for (let i = list.length - 1; i >= 0 && hash !== fromHash; i--) {
    const w = list[i];
    if (w.to !== hash || seen.has(hash)) continue;
    seen.add(hash);
    if (selfId === null || w.writer.id !== selfId) return { selfOnly: false, writer: w.writer };
    hash = w.from;
  }
  if (hash === fromHash) return { selfOnly: true, writer: null };
  return { selfOnly: false, writer: typists.get(docId) ?? null };
}

// --- Event collection ---------------------------------------------------------

/** The agent slug when the snippet mentions one of `login`'s agents (`@login/Agent`), else null. */
function mentionedAgent(snippet: string, login: string): string | null {
  return parseAgentMentions(snippet).find((m) => m.login === login)?.agent ?? null;
}

/** Actor id → user id: plain ids are users, agents are `agent:<userId>:<name>`. */
function userIdOf(actorId: string | null): string | null {
  if (!actorId) return null;
  const m = /^agent:([^:]+):/.exec(actorId);
  return m ? m[1] : actorId;
}

function agentOf(actorId: string | null, kind: string): string | null {
  if (kind !== "agent") return null;
  const m = /^agent:[^:]+:(.+)$/.exec(actorId ?? "");
  return m ? m[1] : null;
}

/** Build the actor of an event from an activity-style writer; `login` is filled in later by `resolveLogins`. */
function eventActor(writer: WriterRef | null, selfId: string | null, login: string | null = null): EventActor {
  if (!writer) return { id: null, name: "someone", login: null, kind: "user", agent: null, self: false };
  const kind = writer.kind === "agent" ? "agent" : "user";
  return { id: writer.id, name: writer.name, login, kind, agent: agentOf(writer.id, kind), self: selfId !== null && writer.id === selfId };
}

/** Fill `actor.login` on events whose actor is a known user or an agent of one, with one lookup. */
async function resolveLogins(events: AgentEvent[]) {
  const ids = new Set<string>();
  for (const e of events) {
    const uid = e.actor.login === null ? userIdOf(e.actor.id) : null;
    if (uid) ids.add(uid);
  }
  if (ids.size === 0) return;
  const db = await getDb();
  const users = await db.select({ id: schema.users.id, login: schema.users.login }).from(schema.users).where(inArray(schema.users.id, [...ids]));
  const byId = new Map(users.map((u) => [u.id, u.login ?? null]));
  for (const e of events) {
    if (e.actor.login !== null) continue;
    const uid = userIdOf(e.actor.id);
    if (uid && byId.has(uid)) e.actor.login = byId.get(uid) ?? null;
  }
}

function activityToEvent(row: typeof schema.activity.$inferSelect, selfId: string | null): AgentEvent | null {
  const d = (row.detail ?? {}) as Record<string, unknown>;
  const at = row.createdAt.toISOString();
  const actor = eventActor({ id: row.actorId, name: row.actorName, kind: row.actorKind }, selfId);
  const base = { documentId: row.documentId, actor, at };
  switch (row.action) {
    case "edit":
      return null; // content.changed carries the diff
    case "comment.add":
    case "comment.reply":
    case "comment.resolve": {
      const type = row.action === "comment.add" ? "comment.added" : row.action === "comment.reply" ? "comment.replied" : "comment.resolved";
      return { type, ...base, threadId: typeof d.threadId === "string" ? d.threadId : null, author: row.actorName, authorKind: row.actorKind, body: typeof d.quote === "string" ? d.quote : "", quote: typeof d.anchor === "string" ? d.anchor : null };
    }
    case "comment.suggestion.accepted":
    case "comment.suggestion.rejected":
      return {
        type: row.action === "comment.suggestion.accepted" ? "suggestion.accepted" : "suggestion.rejected",
        ...base,
        threadId: typeof d.threadId === "string" ? d.threadId : null,
        ...(typeof d.replyId === "string" ? { replyId: d.replyId } : {}),
        by: row.actorName,
        byKind: row.actorKind,
        author: typeof d.author === "string" ? d.author : null,
        quote: typeof d.quote === "string" ? d.quote : null,
      };
    case "review.create":
      return {
        type: "review.created",
        ...base,
        reviewId: typeof d.reviewId === "string" ? d.reviewId : "",
        by: row.actorName,
        byKind: row.actorKind,
        verdict: typeof d.verdict === "string" ? d.verdict : "comment",
        summary: typeof d.quote === "string" ? d.quote : "",
        comments: typeof d.comments === "number" ? d.comments : 0,
        suggestions: typeof d.suggestions === "number" ? d.suggestions : 0,
        threadIds: Array.isArray(d.threadIds) ? d.threadIds.filter((x): x is string => typeof x === "string") : [],
      };
    case "agent.request":
      return {
        type: "request.created",
        ...base,
        documentTitle: null,
        requestId: typeof d.requestId === "string" ? d.requestId : "",
        by: row.actorName,
        mode: typeof d.mode === "string" ? d.mode : "suggest",
        instruction: typeof d.instruction === "string" ? d.instruction : "",
        quote: typeof d.quote === "string" ? d.quote : null,
        // The comment thread the request was made from; null for dialog requests and rows from before 0018.
        threadId: typeof d.threadId === "string" ? d.threadId : null,
        // `login/slug` the request is addressed to; null when unaddressed (and on rows from before 0019).
        agent: typeof d.agent === "string" ? d.agent : null,
      };
    default:
      return { type: "activity", ...base, action: row.action, actorName: row.actorName, actorKind: row.actorKind, detail: d };
  }
}

/**
 * The actor of a mention notification. Mentions are stored under the author's login with the author's
 * display name — the token name when an agent wrote the comment — so the token's own comments are `self`.
 */
function mentionActor(n: { actorLogin: string | null; actorName: string | null }, user: SessionUser & { agent?: string }): EventActor {
  const self = !!user.agent && !!n.actorLogin && n.actorLogin.toLowerCase() === (user.login ?? "").toLowerCase() && n.actorName === user.agent;
  return { id: self ? selfActorId(user) : null, name: n.actorName ?? n.actorLogin ?? "someone", login: n.actorLogin, kind: self ? "agent" : "user", agent: self ? user.agent! : null, self };
}

type MentionRow = typeof schema.notifications.$inferSelect;

/**
 * A `mention` event from its notification row. `refId` is the mentioned comment or reply; `threadId` is the
 * thread that conversation belongs to (the ref itself for a top-level comment, the containing thread for a
 * reply), resolved from the live document by the caller — null when the thread is gone or the ref is unknown.
 */
function mentionEvent(n: MentionRow, documentTitle: string | null, threadId: string | null, login: string, user: SessionUser & { agent?: string }): AgentEvent {
  const agents = n.agentTargets ?? parseAgentMentions(n.snippet).filter((mention) => mention.login === login).map((mention) => mention.agent);
  return {
    type: "mention",
    documentId: n.documentId,
    documentTitle,
    refId: n.refId,
    threadId,
    by: n.actorName,
    byLogin: n.actorLogin,
    snippet: n.snippet,
    agent: agents[0] ?? mentionedAgent(n.snippet, login),
    agents,
    actor: mentionActor(n, user),
    at: n.createdAt.toISOString(),
  };
}

function keep(events: AgentEvent[], opts: WatchOptions): AgentEvent[] {
  return opts.includeSelf ? events : events.filter((e) => !e.actor.self);
}

export interface EventsPage {
  cursor: string;
  events: AgentEvent[];
}

/**
 * Events on one document since `cursor`: activity rows (comments, requests, the rest), mentions of the
 * token's user, and a `content.changed` with a diff when the clean text hash moved. With no cursor, only
 * the current cursor is returned so the caller can start watching from "now".
 */
export async function collectDocumentEvents(docId: string, user: SessionUser & { agent?: string }, cursor: CursorState | null, opts: WatchOptions = {}, now = new Date()): Promise<EventsPage> {
  // Lazy: livedoc pulls in http.ts (next/headers), which must not load in the custom server's module graph.
  const { readLiveText, readLiveTextWithThreads } = await import("@/server/livedoc");
  if (!cursor) {
    const live = await readLiveText(docId);
    const hash = contentHash(live.clean);
    rememberText(docId, hash, live.clean);
    return { cursor: encodeCursor({ a: now.getTime(), ids: [], n: now.getTime(), r: now.getTime(), h: hash }), events: [] };
  }

  const db = await getDb();
  const selfId = selfActorId(user);
  const events: AgentEvent[] = [];
  const next: CursorState = { ...cursor, ids: [...cursor.ids] };

  const rows = await db
    .select()
    .from(schema.activity)
    .where(and(eq(schema.activity.documentId, docId), gte(schema.activity.createdAt, new Date(cursor.a))))
    .orderBy(asc(schema.activity.createdAt), asc(schema.activity.id))
    .limit(500);
  for (const row of rows) {
    const ms = row.createdAt.getTime();
    if (ms === cursor.a && cursor.ids.includes(row.id)) continue;
    if (ms > next.a) {
      next.a = ms;
      next.ids = [row.id];
    } else if (ms === next.a && !next.ids.includes(row.id)) next.ids.push(row.id);
    const ev = activityToEvent(row, selfId);
    if (ev) events.push(ev);
  }

  const login = user.login?.toLowerCase();
  const mentions = login
    ? await db
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.userLogin, login), eq(schema.notifications.documentId, docId), eq(schema.notifications.kind, "mention"), gt(schema.notifications.createdAt, new Date(cursor.n))))
        .orderBy(asc(schema.notifications.createdAt))
        .limit(200)
    : [];

  // One read of the document: the clean text for `content.changed` and, when the page has mentions, the thread
  // each mentioned comment or reply sits in (a reply's `refId` alone does not name its conversation).
  const live = await readLiveTextWithThreads(docId, mentions.map((m) => m.refId));
  const hash = contentHash(live.clean);
  rememberText(docId, hash, live.clean);
  next.h = hash;
  for (const m of mentions) {
    next.n = Math.max(next.n, m.createdAt.getTime());
    events.push(mentionEvent(m, live.title || null, live.threads.get(m.refId) ?? null, login!, user));
  }

  if (cursor.h !== null && cursor.h !== hash) {
    // Own API writes move the hash too; when nothing but the token's writes explain the move, it is `self`.
    const who = explainContentChange(docId, cursor.h, hash, selfId);
    const actor = who.selfOnly ? eventActor({ id: selfId, name: user.agent ?? "you", kind: "agent" }, selfId) : eventActor(who.writer, selfId);
    const previous = textCache.get(docId)?.get(cursor.h) ?? null;
    const d = previous === null ? null : unifiedDiff(previous, live.clean, `${live.title || "document"}.md`);
    events.push({ type: "content.changed", documentId: docId, contentHash: hash, previousHash: cursor.h, diff: d?.diff ?? null, truncated: d?.truncated ?? false, actor, at: now.toISOString() });
  }
  next.r = Math.max(next.r, now.getTime());
  const kept = keep(events, opts);
  await resolveLogins(kept);
  kept.sort((x, y) => x.at.localeCompare(y.at));
  return { cursor: encodeCursor(next), events: kept };
}

/**
 * Cross-document inbox: @mentions on every document the token's user can open, plus reviews and new
 * agent requests (made by mentioning an agent in a comment thread, `threadId`, or over the API without one)
 * on documents they own or collaborate on. Content changes are not included.
 */
export async function collectUserEvents(user: SessionUser & { agent?: string }, cursor: CursorState | null, opts: WatchOptions = {}, now = new Date()): Promise<EventsPage> {
  if (!cursor) return { cursor: encodeCursor({ a: now.getTime(), ids: [], n: now.getTime(), r: now.getTime(), h: null }), events: [] };
  const db = await getDb();
  const events: AgentEvent[] = [];
  const next: CursorState = { ...cursor, h: null };
  const login = user.login?.toLowerCase() ?? "";
  const memberAccess = effectiveRoleSql(schema.documents, { id: user.id, login, signedIn: true }, { includeLink: false });
  const mentionAccess = effectiveRoleSql(schema.documents, { id: user.id, login, signedIn: true });

  if (login) {
    const mentions = await db
      .select({ n: schema.notifications, title: schema.documents.title })
      .from(schema.notifications)
      .innerJoin(schema.documents, eq(schema.documents.id, schema.notifications.documentId))
      .where(
        and(
          eq(schema.notifications.userLogin, login),
          eq(schema.notifications.kind, "mention"),
          gt(schema.notifications.createdAt, new Date(cursor.n)),
          isNull(schema.documents.deletedAt),
          sql`${mentionAccess.role} is not null`,
        ),
      )
      .orderBy(asc(schema.notifications.createdAt))
      .limit(200);
    // The thread behind each mentioned comment or reply: one read per distinct document on the page, nothing cached.
    const refsByDoc = new Map<string, string[]>();
    for (const { n } of mentions) refsByDoc.set(n.documentId, [...(refsByDoc.get(n.documentId) ?? []), n.refId]);
    const threads = new Map<string, Map<string, string | null>>();
    if (refsByDoc.size > 0) {
      // Lazy for the same reason as in collectDocumentEvents.
      const { resolveCommentThreads } = await import("@/server/livedoc");
      for (const [documentId, refIds] of refsByDoc) threads.set(documentId, await resolveCommentThreads(documentId, refIds));
    }
    for (const { n, title } of mentions) {
      next.n = Math.max(next.n, n.createdAt.getTime());
      events.push(mentionEvent(n, title, threads.get(n.documentId)?.get(n.refId) ?? null, login, user));
    }
  }

  const selfId = selfActorId(user);
  const reviews = await db
    .select({ activity: schema.activity })
    .from(schema.activity)
    .innerJoin(schema.documents, eq(schema.documents.id, schema.activity.documentId))
    .where(
      and(
        eq(schema.activity.action, "review.create"),
        gte(schema.activity.createdAt, new Date(cursor.a)),
        isNull(schema.documents.deletedAt),
        sql`${memberAccess.role} is not null`,
      ),
    )
    .orderBy(asc(schema.activity.createdAt), asc(schema.activity.id))
    .limit(500);
  for (const { activity } of reviews) {
    const ms = activity.createdAt.getTime();
    if (ms === cursor.a && cursor.ids.includes(activity.id)) continue;
    if (ms > next.a) {
      next.a = ms;
      next.ids = [activity.id];
    } else if (ms === next.a && !next.ids.includes(activity.id)) next.ids.push(activity.id);
    const event = activityToEvent(activity, selfId);
    if (event) events.push(event);
  }

  // Addressed to the polling token (`@login/slug`), or unaddressed and asked by the token's own user (#1296).
  const ownUnaddressed = and(isNull(schema.agentRequests.agentLogin), eq(schema.agentRequests.userId, user.id));
  const addressedToMe = user.agent && login ? and(eq(schema.agentRequests.agentLogin, login), eq(schema.agentRequests.agentSlug, agentMentionSlug(user.agent).toLowerCase())) : null;
  const requests = await db
    .select({ request: schema.agentRequests, title: schema.documents.title, userName: schema.users.name, userLogin: schema.users.login })
    .from(schema.agentRequests)
    .innerJoin(schema.documents, eq(schema.documents.id, schema.agentRequests.documentId))
    .leftJoin(schema.users, eq(schema.users.id, schema.agentRequests.userId))
    .where(
      and(
        gt(schema.agentRequests.createdAt, new Date(cursor.r)),
        inArray(schema.agentRequests.status, ["open", "claimed"]),
        sql`${schema.documents.deletedAt} is null`,
        sql`${memberAccess.role} is not null`,
        addressedToMe ? or(ownUnaddressed, addressedToMe) : ownUnaddressed,
      ),
    )
    .orderBy(asc(schema.agentRequests.createdAt))
    .limit(200);
  for (const { request, title, userName, userLogin } of requests) {
    next.r = Math.max(next.r, request.createdAt.getTime());
    events.push({
      type: "request.created",
      documentId: request.documentId,
      documentTitle: title,
      requestId: request.id,
      by: userName ?? userLogin ?? null,
      mode: request.mode,
      instruction: request.instruction,
      quote: request.selection?.quote ?? null,
      threadId: request.threadId ?? null,
      agent: request.agentLogin && request.agentSlug ? `${request.agentLogin}/${request.agentSlug}` : null,
      // Requests are asked by people in the editor; a token never asks itself.
      actor: { id: request.userId ?? null, name: userName ?? userLogin ?? "someone", login: userLogin ?? null, kind: "user", agent: null, self: false },
      at: request.createdAt.toISOString(),
    });
  }
  if (reviews.length < 500 && next.a < now.getTime()) {
    next.a = now.getTime();
    next.ids = [];
  }
  const kept = keep(events, opts);
  await resolveLogins(kept);
  kept.sort((x, y) => x.at.localeCompare(y.at));
  return { cursor: encodeCursor(next), events: kept };
}

/**
 * Long-poll: collect events; when there are none and `waitS` > 0, sleep until the document (or any
 * document) is woken by an activity insert, a notification or a text change, then collect again. The
 * token's own events do not count as "something happened" unless `opts.includeSelf` is set.
 */
export async function pollEvents(docId: string | null, user: SessionUser & { agent?: string }, since: string | null, waitS: number, opts: WatchOptions = {}): Promise<EventsPage> {
  const cursor = decodeCursor(since);
  const deadline = Date.now() + waitS * 1000;
  const collect = () => (docId ? collectDocumentEvents(docId, user, cursor, opts) : collectUserEvents(user, cursor, opts));
  for (;;) {
    const seq = wakeSeq(docId);
    const page = await collect();
    if (page.events.length > 0 || !cursor) return page;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return page;
    await waitForWake(docId, seq, remaining);
    if (Date.now() >= deadline) return collect();
  }
}

/** `includeSelf` query parameter: `1`, `true` or `yes` turn own events on. */
export function parseIncludeSelf(raw: string | null | undefined): boolean {
  return raw !== null && raw !== undefined && ["1", "true", "yes"].includes(raw.trim().toLowerCase());
}
