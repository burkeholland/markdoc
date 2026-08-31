import type * as Y from "yjs";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/server/db";
import type { ActivityAction, AgentRequest, AgentRequestMode, AgentRequestResult, AgentRequestSelection, AgentRequestStatus, Role } from "@/server/db/schema";
import type { SessionUser } from "@/server/documents";
import { canComment, canEdit } from "@/server/documents";
import { HttpError, type Actor } from "@/server/http";
import { activityActor, clip, type ActivityActor, type ActivityDetail } from "@/server/activity";
import { wakeDocument } from "@/server/agent-events";
import { notify } from "@/server/notifications";
import { mutateLiveDoc, readLiveDoc } from "@/server/livedoc";
import { META_KEY } from "@/server/collab/hocuspocus";
import { newId } from "@/editor/collab/shared";

export const INSTRUCTION_MAX = 2000;
export const QUOTE_MAX = 2000;

/** Post-write side effects that can fail without taking the request's write back: reported as `warnings` on the 2xx (see docs/agents.md). */
export type RequestWarning = "notification-not-sent";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The activity row `recordActivity` would write, on the caller's transaction: it commits — or rolls back —
 * together with the request row it describes (`recordActivity` opens its own connection). The wake that
 * `recordActivity` performs is the caller's, after the commit.
 */
async function recordActivityIn(tx: Tx, docId: string, actor: ActivityActor, action: ActivityAction, detail: ActivityDetail): Promise<void> {
  await tx.insert(schema.activity).values({ id: newId(), documentId: docId, actorId: actor.id, actorName: actor.name, actorKind: actor.kind, action, detail, createdAt: new Date() });
}

export interface AgentRequestItem {
  id: string;
  documentId: string;
  /** Only on the cross-document listing agents use to find work. */
  documentTitle?: string;
  userId: string;
  /** Requester's display name / login (cross-document listing). */
  userName?: string | null;
  userLogin?: string | null;
  instruction: string;
  selection: AgentRequestSelection | null;
  /** Comment thread the request was made from; null for requests from the Ask-an-agent dialog. */
  threadId: string | null;
  mode: AgentRequestMode;
  status: AgentRequestStatus;
  claimedBy: string | null;
  result: AgentRequestResult | null;
  createdAt: string;
  updatedAt: string;
}

/** What the editor mirrors from `meta.agentRequests` so the presence stack updates in real time. */
export interface AgentRequestMirror {
  id: string;
  status: AgentRequestStatus;
  mode: AgentRequestMode;
  instruction: string;
  claimedBy: string | null;
  result: AgentRequestResult | null;
  userId: string;
  /** Comment thread the request belongs to, when it was made from a comment. Absent on mirrors written before #997. */
  threadId?: string | null;
  updatedAt: number;
}

export function toRequestItem(row: AgentRequest, extra: Partial<AgentRequestItem> = {}): AgentRequestItem {
  return {
    id: row.id,
    documentId: row.documentId,
    userId: row.userId,
    instruction: row.instruction,
    selection: row.selection ?? null,
    threadId: row.threadId ?? null,
    mode: row.mode,
    status: row.status,
    claimedBy: row.claimedBy ?? null,
    result: row.result ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...extra,
  };
}

export interface CreateRequestInput {
  instruction: string;
  selection?: AgentRequestSelection | null;
  mode?: AgentRequestMode;
  /** Comment thread this request comes from: must exist in the document; its Y.Map gets `requestId` stamped. */
  threadId?: string | null;
}

/** The minimum role a mode needs: commenting is enough to ask for comments; anything that changes text needs edit. */
export function modeAllowed(mode: AgentRequestMode, role: Role): boolean {
  return mode === "comment" ? canComment(role) : canEdit(role);
}

/** Agent (token) name, or the human's name when a person claims/completes directly. */
function agentName(actor: Actor): string {
  return actor.agent ?? actor.name ?? actor.login ?? "User";
}

async function getRequest(docId: string, requestId: string): Promise<AgentRequest> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.agentRequests)
    .where(and(eq(schema.agentRequests.id, requestId), eq(schema.agentRequests.documentId, docId)));
  if (!row) throw new HttpError(404, "Request not found");
  return row;
}

/** The comment thread a request was made from (null for dialog requests); 404 when the request is unknown. */
export async function requestThreadId(docId: string, requestId: string): Promise<string | null> {
  return (await getRequest(docId, requestId)).threadId ?? null;
}

/** The shared comments map: thread id → thread Y.Map (same shape CommentsModel reads). */
function commentsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>("comments");
}

/**
 * Mirror the request's status into the shared document so connected editors update without polling.
 * With `stampThread`, the thread the request came from gets `requestId` in the same transaction (the
 * latest request on a thread wins), so the thread card can find its request without polling either.
 */
async function mirrorRequest(row: AgentRequest, actor: Actor | null, opts: { stampThread?: boolean } = {}) {
  const ctx = {
    userId: actor?.id ?? row.userId,
    docId: row.documentId,
    role: "editor" as const,
    name: actor ? agentName(actor) : "Markdoc",
    login: actor?.login ?? null,
    avatar: null,
  };
  try {
    await mutateLiveDoc(row.documentId, ctx, (doc) => {
      const meta = doc.getMap(META_KEY);
      const current = (meta.get("agentRequests") as Record<string, AgentRequestMirror> | undefined) ?? {};
      const next: Record<string, AgentRequestMirror> = {};
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      // Keep the map small: open/claimed requests plus finished ones from the last day (so the "done" toast can fire).
      for (const [id, r] of Object.entries(current)) {
        if (id === row.id) continue;
        if (r.status === "open" || r.status === "claimed" || r.updatedAt > cutoff) next[id] = r;
      }
      next[row.id] = {
        id: row.id,
        status: row.status,
        mode: row.mode,
        instruction: clip(row.instruction, 200),
        claimedBy: row.claimedBy ?? null,
        result: row.result ?? null,
        userId: row.userId,
        threadId: row.threadId ?? null,
        updatedAt: row.updatedAt.getTime(),
      };
      meta.set("agentRequests", next);
      if (opts.stampThread && row.threadId) commentsMap(doc).get(row.threadId)?.set("requestId", row.id);
    });
  } catch (err) {
    console.error("[agent-requests] mirror failed", err);
  }
}

/** Create a request. Callers must already have resolved access; `role` decides which modes are allowed. */
export async function createRequest(docId: string, actor: Actor, role: Role, input: CreateRequestInput): Promise<AgentRequestItem> {
  const mode = input.mode ?? "suggest";
  if (!modeAllowed(mode, role)) {
    throw new HttpError(403, mode === "comment" ? "Commenting access is required to ask for comments" : "Editing access is required to ask for changes");
  }
  const instruction = input.instruction.trim();
  if (!instruction) throw new HttpError(400, "Instruction is required");
  if (instruction.length > INSTRUCTION_MAX) throw new HttpError(400, `Instruction must be at most ${INSTRUCTION_MAX} characters`);
  let selection: AgentRequestSelection | null = null;
  if (input.selection) {
    const from = Math.max(0, Math.floor(input.selection.from));
    const to = Math.max(from, Math.floor(input.selection.to));
    selection = { from, to, quote: input.selection.quote.slice(0, QUOTE_MAX) };
  }
  const threadId = input.threadId?.trim() || null;
  // Same resolution as the comments route (`CommentsModel.ymap.get`): the thread must be in the live document.
  if (threadId && !(await readLiveDoc(docId, (doc) => commentsMap(doc).has(threadId)))) throw new HttpError(404, "Comment not found");
  const db = await getDb();
  const now = new Date();
  // One transaction: a request that exists without its `agent.request` row would be worked by agents while the
  // person, seeing no feedback, asks again — so a failed activity row takes the request back with it.
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.agentRequests)
      .values({ id: newId(), documentId: docId, userId: actor.id, instruction, selection, threadId, mode, status: "open", createdAt: now, updatedAt: now })
      .returning();
    await recordActivityIn(tx, docId, activityActor(actor), "agent.request", { requestId: inserted.id, mode, instruction: clip(instruction), quote: selection ? clip(selection.quote) : null, threadId });
    return inserted;
  });
  wakeDocument(docId);
  await mirrorRequest(row, actor, { stampThread: true });
  return toRequestItem(row);
}

/** Requests on one document, newest first (optionally filtered by status). */
export async function listRequests(docId: string, opts: { status?: AgentRequestStatus | AgentRequestStatus[] } = {}): Promise<AgentRequestItem[]> {
  const db = await getDb();
  const statuses = opts.status ? (Array.isArray(opts.status) ? opts.status : [opts.status]) : null;
  const where = statuses ? and(eq(schema.agentRequests.documentId, docId), inArray(schema.agentRequests.status, statuses)) : eq(schema.agentRequests.documentId, docId);
  const rows = await db.select().from(schema.agentRequests).where(where).orderBy(desc(schema.agentRequests.createdAt), desc(schema.agentRequests.id));
  return rows.map((r) => toRequestItem(r));
}

/**
 * Requests across every document the user owns or collaborates on (link-shared documents are not
 * included: an agent only works where its human is a member). This is how agents find work.
 */
export async function listRequestsForUser(user: SessionUser, opts: { status?: AgentRequestStatus | AgentRequestStatus[]; limit?: number } = {}): Promise<AgentRequestItem[]> {
  const db = await getDb();
  const login = user.login?.toLowerCase() ?? "";
  const statuses: AgentRequestStatus[] = opts.status ? (Array.isArray(opts.status) ? opts.status : [opts.status]) : ["open"];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      request: schema.agentRequests,
      documentTitle: schema.documents.title,
      userName: schema.users.name,
      userLogin: schema.users.login,
    })
    .from(schema.agentRequests)
    .innerJoin(schema.documents, eq(schema.documents.id, schema.agentRequests.documentId))
    .leftJoin(schema.users, eq(schema.users.id, schema.agentRequests.userId))
    .leftJoin(schema.collaborators, and(eq(schema.collaborators.documentId, schema.documents.id), eq(schema.collaborators.login, login)))
    .where(
      and(
        inArray(schema.agentRequests.status, statuses),
        sql`${schema.documents.deletedAt} is null`,
        or(eq(schema.documents.ownerId, user.id), sql`${schema.collaborators.login} is not null`),
      ),
    )
    .orderBy(desc(schema.agentRequests.createdAt), desc(schema.agentRequests.id))
    .limit(limit);
  return rows.map((r) => toRequestItem(r.request, { documentTitle: r.documentTitle, userName: r.userName, userLogin: r.userLogin }));
}

/** Claim an open request. Re-claiming by the same agent is a no-op; another agent's claim is a 409. */
export async function claimRequest(docId: string, requestId: string, actor: Actor): Promise<AgentRequestItem> {
  const row = await getRequest(docId, requestId);
  const name = agentName(actor);
  if (row.status === "claimed" && row.claimedBy === name) return toRequestItem(row);
  if (row.status !== "open") throw new HttpError(409, `Request is ${row.status}`, { status: row.status, claimedBy: row.claimedBy });
  const db = await getDb();
  const [updated] = await db
    .update(schema.agentRequests)
    .set({ status: "claimed", claimedBy: name, updatedAt: new Date() })
    .where(and(eq(schema.agentRequests.id, requestId), eq(schema.agentRequests.status, "open")))
    .returning();
  if (!updated) throw new HttpError(409, "Request was just claimed by someone else");
  await mirrorRequest(updated, actor);
  return toRequestItem(updated);
}

/** The request `attachWork` will accept, or the 404/409 it would throw — call it before writing anything. */
export async function requireAttachableRequest(docId: string, requestId: string): Promise<AgentRequest> {
  const row = await getRequest(docId, requestId);
  if (row.status === "done" || row.status === "cancelled") throw new HttpError(409, `Request is ${row.status}`, { status: row.status });
  return row;
}

/**
 * Count work done against a request (called by the suggest/comment routes when `requestId` is given).
 * Also claims an open request implicitly so the presence stack shows who is working on it. A request
 * completed or cancelled between the pre-check and the update is never written back to `claimed`: the
 * update is conditional and answers the same 409 the pre-check would have.
 */
export async function attachWork(docId: string, requestId: string, actor: Actor, work: { suggestions?: number; comments?: number; suggestionIds?: string[]; commentIds?: string[] }): Promise<AgentRequestItem> {
  const row = await requireAttachableRequest(docId, requestId);
  const prev = row.result ?? { suggestions: 0, comments: 0 };
  const prevIds = (prev as { suggestionIds?: string[]; commentIds?: string[] }) ?? {};
  const result: AgentRequestResult & { suggestionIds?: string[]; commentIds?: string[] } = {
    ...prev,
    suggestions: prev.suggestions + (work.suggestions ?? 0),
    comments: prev.comments + (work.comments ?? 0),
  };
  if (work.suggestionIds?.length || prevIds.suggestionIds?.length) result.suggestionIds = [...(prevIds.suggestionIds ?? []), ...(work.suggestionIds ?? [])];
  if (work.commentIds?.length || prevIds.commentIds?.length) result.commentIds = [...(prevIds.commentIds ?? []), ...(work.commentIds ?? [])];
  const db = await getDb();
  const [updated] = await db
    .update(schema.agentRequests)
    .set({ result, status: "claimed", claimedBy: row.claimedBy ?? agentName(actor), updatedAt: new Date() })
    .where(and(eq(schema.agentRequests.id, requestId), ne(schema.agentRequests.status, "cancelled"), ne(schema.agentRequests.status, "done")))
    .returning();
  if (!updated) {
    const now = await getRequest(docId, requestId);
    throw new HttpError(409, `Request is ${now.status}`, { status: now.status });
  }
  await mirrorRequest(updated, actor);
  return toRequestItem(updated);
}

export interface CompleteInput {
  summary?: string;
  /** Override the counted totals (agents that did the work elsewhere). */
  suggestions?: number;
  comments?: number;
}

export interface CompleteResult {
  request: AgentRequestItem;
  /**
   * The requester holds a `request.done` notification for this request — written by this call or an earlier
   * one. False when the requester has no login to notify, or when writing it failed (`warnings` says so).
   */
  notified: boolean;
  /** The request was done before this call: nothing was written; the notification was attempted again (idempotent). */
  alreadyDone: boolean;
  warnings?: RequestWarning[];
}

/** A `request.done` row for this request exists for the requester (whoever wrote it). */
async function hasDoneNotification(userLogin: string, requestId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userLogin, userLogin.trim().toLowerCase()), eq(schema.notifications.kind, "request.done"), eq(schema.notifications.refId, requestId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Mark a request done: the status update and the `agent.request.done` activity row commit together (a
 * retry after a failure finds the request still `claimed`), then the requester is notified
 * (`request.done`) — a failure there is `warnings: ["notification-not-sent"]` on the completed request,
 * never a non-2xx for a request that is done. Completing a done request writes nothing but attempts
 * the notification again (`notify` dedupes), so a retry after a crash still delivers the toast.
 */
export async function completeRequest(docId: string, requestId: string, actor: Actor, input: CompleteInput = {}): Promise<CompleteResult> {
  const row = await getRequest(docId, requestId);
  if (row.status === "cancelled") throw new HttpError(409, "Request was cancelled", { status: row.status });
  const failed: RequestWarning[] = [];
  const tail = async (code: RequestWarning, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (err) {
      console.error(`[requests] ${code}`, err);
      failed.push(code);
      return false;
    }
  };
  const db = await getDb();
  // Everything after the commit that can fail is a warning on the completed request, never a non-2xx.
  const notifyRequester = async (done: AgentRequest): Promise<boolean> => {
    let notified = false;
    await tail("notification-not-sent", async () => {
      const [requester] = await db.select({ login: schema.users.login }).from(schema.users).where(eq(schema.users.id, done.userId));
      const login = requester?.login;
      if (!login) return;
      const result = done.result ?? { suggestions: 0, comments: 0 };
      // The agent acts for a user: when that user is the requester the actor check in notify() would drop
      // the row, so attribute the notification to the agent itself (no login) — the human still wants to hear.
      const inserted = await notify({
        userLogin: login,
        documentId: docId,
        kind: "request.done",
        actorLogin: null,
        actorName: done.claimedBy ?? agentName(actor),
        refId: requestId,
        snippet: result.summary ?? summarizeResult(result) ?? clip(done.instruction),
      });
      // `notify` answers false for a row that already exists (an earlier attempt got through): the truth is the row.
      notified = inserted || (await hasDoneNotification(login, requestId));
    });
    return notified;
  };
  const respond = (done: AgentRequest, notified: boolean, alreadyDone: boolean): CompleteResult => {
    const body: CompleteResult = { request: toRequestItem(done), notified, alreadyDone };
    return failed.length ? { ...body, warnings: failed } : body;
  };
  if (row.status === "done") return respond(row, await notifyRequester(row), true);

  const prev = row.result ?? { suggestions: 0, comments: 0 };
  const result: AgentRequestResult = {
    ...prev,
    suggestions: input.suggestions ?? prev.suggestions,
    comments: input.comments ?? prev.comments,
  };
  const summary = input.summary?.trim();
  if (summary) result.summary = clip(summary, 500);
  const name = row.claimedBy ?? agentName(actor);
  const updated = await db.transaction(async (tx) => {
    const [done] = await tx
      .update(schema.agentRequests)
      .set({ status: "done", claimedBy: name, result, updatedAt: new Date() })
      .where(eq(schema.agentRequests.id, requestId))
      .returning();
    await recordActivityIn(tx, docId, activityActor(actor), "agent.request.done", {
      requestId,
      mode: row.mode,
      suggestions: result.suggestions,
      comments: result.comments,
      summary: result.summary ?? null,
      instruction: clip(row.instruction),
    });
    return done;
  });
  wakeDocument(docId);
  const notified = await notifyRequester(updated);
  await mirrorRequest(updated, actor);
  return respond(updated, notified, false);
}

export function summarizeResult(result: AgentRequestResult | null): string | null {
  if (!result) return null;
  const parts: string[] = [];
  if (result.suggestions) parts.push(`${result.suggestions} suggestion${result.suggestions === 1 ? "" : "s"}`);
  if (result.comments) parts.push(`${result.comments} comment${result.comments === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : null;
}

/** Cancel an open or claimed request. Only the requester or the document owner may cancel. */
export async function cancelRequest(docId: string, requestId: string, actor: Actor, role: Role): Promise<AgentRequestItem> {
  const row = await getRequest(docId, requestId);
  if (row.userId !== actor.id && role !== "owner") throw new HttpError(403, "Only the requester or the document owner can cancel a request");
  if (row.status === "cancelled") return toRequestItem(row);
  if (row.status === "done") throw new HttpError(409, "Request is already done", { status: row.status });
  const db = await getDb();
  const [updated] = await db.update(schema.agentRequests).set({ status: "cancelled", updatedAt: new Date() }).where(eq(schema.agentRequests.id, requestId)).returning();
  await mirrorRequest(updated, actor);
  return toRequestItem(updated);
}

/** The mirrored map as currently held in the live document (tests and diagnostics). */
export async function readMirror(docId: string): Promise<Record<string, AgentRequestMirror>> {
  return readLiveDoc(docId, (doc) => ((doc.getMap(META_KEY).get("agentRequests") as Record<string, AgentRequestMirror> | undefined) ?? {}));
}
