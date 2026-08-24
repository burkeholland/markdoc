import { and, asc, eq, gt, gte, inArray, or, sql } from "drizzle-orm";
import { createTwoFilesPatch } from "diff";
import { getDb, schema } from "@/server/db";
import type { SessionUser } from "@/server/documents";
import { contentHash } from "@/server/export/html";

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

export type AgentEvent =
  | { type: "content.changed"; documentId: string; contentHash: string; previousHash: string | null; diff: string | null; truncated: boolean; at: string }
  | { type: "comment.added" | "comment.replied" | "comment.resolved"; documentId: string; threadId: string | null; author: string; authorKind: string; body: string; quote: string | null; at: string }
  | { type: "mention"; documentId: string; documentTitle: string | null; refId: string; by: string | null; byLogin: string | null; snippet: string; at: string }
  | { type: "request.created"; documentId: string; documentTitle: string | null; requestId: string; by: string | null; mode: string; instruction: string; quote: string | null; at: string }
  | { type: "activity"; documentId: string; action: string; actor: string; actorKind: string; detail: Record<string, unknown>; at: string };

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
interface SharedState {
  seqs: Map<string, number>;
  waiters: Map<string, Set<() => void>>;
  textCache: Map<string, Map<string, string>>;
}
const g = globalThis as typeof globalThis & { __markdocAgentEvents?: SharedState };
const shared: SharedState = (g.__markdocAgentEvents ??= { seqs: new Map(), waiters: new Map(), textCache: new Map() });
const { seqs, waiters, textCache } = shared;

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

/** Unified diff of two texts, capped to `DIFF_MAX_LINES` lines. */
export function unifiedDiff(before: string, after: string, title = "document.md"): { diff: string; truncated: boolean } {
  const patch = createTwoFilesPatch(title, title, before, after, "before", "after", { context: 2 });
  const all = patch.split("\n");
  const firstHunk = all.findIndex((l) => l.startsWith("@@"));
  const lines = firstHunk === -1 ? [] : all.slice(firstHunk); // drop the Index/---/+++ file header
  if (lines.length <= DIFF_MAX_LINES) return { diff: lines.join("\n"), truncated: false };
  return { diff: lines.slice(0, DIFF_MAX_LINES).join("\n") + `\n… ${lines.length - DIFF_MAX_LINES} more lines`, truncated: true };
}

// --- Event collection ---------------------------------------------------------

function activityToEvent(row: typeof schema.activity.$inferSelect): AgentEvent | null {
  const d = (row.detail ?? {}) as Record<string, unknown>;
  const at = row.createdAt.toISOString();
  const base = { documentId: row.documentId, at };
  switch (row.action) {
    case "edit":
      return null; // content.changed carries the diff
    case "comment.add":
    case "comment.reply":
    case "comment.resolve": {
      const type = row.action === "comment.add" ? "comment.added" : row.action === "comment.reply" ? "comment.replied" : "comment.resolved";
      return { type, ...base, threadId: typeof d.threadId === "string" ? d.threadId : null, author: row.actorName, authorKind: row.actorKind, body: typeof d.quote === "string" ? d.quote : "", quote: typeof d.anchor === "string" ? d.anchor : null };
    }
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
      };
    default:
      return { type: "activity", ...base, action: row.action, actor: row.actorName, actorKind: row.actorKind, detail: d };
  }
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
export async function collectDocumentEvents(docId: string, user: SessionUser, cursor: CursorState | null, now = new Date()): Promise<EventsPage> {
  // Lazy: livedoc pulls in http.ts (next/headers), which must not load in the custom server's module graph.
  const { readLiveText } = await import("@/server/livedoc");
  const live = await readLiveText(docId);
  const hash = contentHash(live.clean);
  rememberText(docId, hash, live.clean);
  if (!cursor) return { cursor: encodeCursor({ a: now.getTime(), ids: [], n: now.getTime(), r: now.getTime(), h: hash }), events: [] };

  const db = await getDb();
  const events: AgentEvent[] = [];
  const next: CursorState = { ...cursor, ids: [...cursor.ids], h: hash };

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
    const ev = activityToEvent(row);
    if (ev) events.push(ev);
  }

  const login = user.login?.toLowerCase();
  if (login) {
    const mentions = await db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userLogin, login), eq(schema.notifications.documentId, docId), eq(schema.notifications.kind, "mention"), gt(schema.notifications.createdAt, new Date(cursor.n))))
      .orderBy(asc(schema.notifications.createdAt))
      .limit(200);
    for (const m of mentions) {
      next.n = Math.max(next.n, m.createdAt.getTime());
      events.push({ type: "mention", documentId: docId, documentTitle: live.title || null, refId: m.refId, by: m.actorName, byLogin: m.actorLogin, snippet: m.snippet, at: m.createdAt.toISOString() });
    }
  }

  if (cursor.h !== null && cursor.h !== hash) {
    const previous = textCache.get(docId)?.get(cursor.h) ?? null;
    const d = previous === null ? null : unifiedDiff(previous, live.clean, `${live.title || "document"}.md`);
    events.push({ type: "content.changed", documentId: docId, contentHash: hash, previousHash: cursor.h, diff: d?.diff ?? null, truncated: d?.truncated ?? false, at: now.toISOString() });
  }
  next.r = Math.max(next.r, now.getTime());
  events.sort((x, y) => x.at.localeCompare(y.at));
  return { cursor: encodeCursor(next), events };
}

/**
 * Cross-document inbox: @mentions of the token's user and new "Ask an agent" requests on every document
 * they own or collaborate on. Content changes are not included (watch a document for those).
 */
export async function collectUserEvents(user: SessionUser, cursor: CursorState | null, now = new Date()): Promise<EventsPage> {
  if (!cursor) return { cursor: encodeCursor({ a: now.getTime(), ids: [], n: now.getTime(), r: now.getTime(), h: null }), events: [] };
  const db = await getDb();
  const events: AgentEvent[] = [];
  const next: CursorState = { ...cursor, h: null };
  const login = user.login?.toLowerCase() ?? "";

  if (login) {
    const mentions = await db
      .select({ n: schema.notifications, title: schema.documents.title })
      .from(schema.notifications)
      .innerJoin(schema.documents, eq(schema.documents.id, schema.notifications.documentId))
      .where(and(eq(schema.notifications.userLogin, login), eq(schema.notifications.kind, "mention"), gt(schema.notifications.createdAt, new Date(cursor.n))))
      .orderBy(asc(schema.notifications.createdAt))
      .limit(200);
    for (const { n, title } of mentions) {
      next.n = Math.max(next.n, n.createdAt.getTime());
      events.push({ type: "mention", documentId: n.documentId, documentTitle: title, refId: n.refId, by: n.actorName, byLogin: n.actorLogin, snippet: n.snippet, at: n.createdAt.toISOString() });
    }
  }

  const requests = await db
    .select({ request: schema.agentRequests, title: schema.documents.title, userName: schema.users.name, userLogin: schema.users.login })
    .from(schema.agentRequests)
    .innerJoin(schema.documents, eq(schema.documents.id, schema.agentRequests.documentId))
    .leftJoin(schema.users, eq(schema.users.id, schema.agentRequests.userId))
    .leftJoin(schema.collaborators, and(eq(schema.collaborators.documentId, schema.documents.id), eq(schema.collaborators.login, login)))
    .where(
      and(
        gt(schema.agentRequests.createdAt, new Date(cursor.r)),
        inArray(schema.agentRequests.status, ["open", "claimed"]),
        sql`${schema.documents.deletedAt} is null`,
        or(eq(schema.documents.ownerId, user.id), sql`${schema.collaborators.login} is not null`),
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
      at: request.createdAt.toISOString(),
    });
  }
  next.a = Math.max(next.a, now.getTime());
  next.ids = [];
  events.sort((x, y) => x.at.localeCompare(y.at));
  return { cursor: encodeCursor(next), events };
}

/**
 * Long-poll: collect events; when there are none and `waitS` > 0, sleep until the document (or any
 * document) is woken by an activity insert, a notification or a text change, then collect again.
 */
export async function pollEvents(docId: string | null, user: SessionUser, since: string | null, waitS: number): Promise<EventsPage> {
  const cursor = decodeCursor(since);
  const deadline = Date.now() + waitS * 1000;
  for (;;) {
    const seq = wakeSeq(docId);
    const page = docId ? await collectDocumentEvents(docId, user, cursor) : await collectUserEvents(user, cursor);
    if (page.events.length > 0 || !cursor) return page;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return page;
    await waitForWake(docId, seq, remaining);
    if (Date.now() >= deadline) return docId ? collectDocumentEvents(docId, user, cursor) : collectUserEvents(user, cursor);
  }
}

/** Tests only. */
export function resetAgentEvents() {
  seqs.clear();
  waiters.clear();
  textCache.clear();
}
