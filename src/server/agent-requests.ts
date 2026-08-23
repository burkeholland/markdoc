import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import type { AgentRequest, AgentRequestMode, AgentRequestResult, AgentRequestSelection, AgentRequestStatus, Role } from "@/server/db/schema";
import type { SessionUser } from "@/server/documents";
import { canComment, canEdit } from "@/server/documents";
import { HttpError, type Actor } from "@/server/http";
import { activityActor, clip, recordActivity } from "@/server/activity";
import { notify } from "@/server/notifications";
import { mutateLiveDoc, readLiveDoc } from "@/server/livedoc";
import { META_KEY } from "@/server/collab/hocuspocus";
import { newId } from "@/editor/collab/shared";

export const INSTRUCTION_MAX = 2000;
export const QUOTE_MAX = 2000;

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
  mode: AgentRequestMode;
  status: AgentRequestStatus;
  claimedBy: string | null;
  result: AgentRequestResult | null;
  createdAt: string;
  updatedAt: string;
}

/** What the editor mirrors from `meta.agentRequests` so the pill updates in real time. */
export interface AgentRequestMirror {
  id: string;
  status: AgentRequestStatus;
  mode: AgentRequestMode;
  instruction: string;
  claimedBy: string | null;
  result: AgentRequestResult | null;
  userId: string;
  updatedAt: number;
}

export function toRequestItem(row: AgentRequest, extra: Partial<AgentRequestItem> = {}): AgentRequestItem {
  return {
    id: row.id,
    documentId: row.documentId,
    userId: row.userId,
    instruction: row.instruction,
    selection: row.selection ?? null,
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

/** Mirror the request's status into the shared document so connected editors update without polling. */
async function mirrorRequest(row: AgentRequest, actor: Actor | null) {
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
        updatedAt: row.updatedAt.getTime(),
      };
      meta.set("agentRequests", next);
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
  const db = await getDb();
  const now = new Date();
  const [row] = await db
    .insert(schema.agentRequests)
    .values({ id: newId(), documentId: docId, userId: actor.id, instruction, selection, mode, status: "open", createdAt: now, updatedAt: now })
    .returning();
  await recordActivity(docId, activityActor(actor), "agent.request", { requestId: row.id, mode, instruction: clip(instruction), quote: selection ? clip(selection.quote) : null });
  await mirrorRequest(row, actor);
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

/**
 * Count work done against a request (called by the suggest/comment routes when `requestId` is given).
 * Also claims an open request implicitly so the pill shows who is working on it.
 */
export async function attachWork(docId: string, requestId: string, actor: Actor, work: { suggestions?: number; comments?: number; suggestionIds?: string[]; commentIds?: string[] }): Promise<AgentRequestItem> {
  const row = await getRequest(docId, requestId);
  if (row.status === "done" || row.status === "cancelled") throw new HttpError(409, `Request is ${row.status}`, { status: row.status });
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
    .where(eq(schema.agentRequests.id, requestId))
    .returning();
  await mirrorRequest(updated, actor);
  return toRequestItem(updated);
}

export interface CompleteInput {
  summary?: string;
  /** Override the counted totals (agents that did the work elsewhere). */
  suggestions?: number;
  comments?: number;
}

/** Mark a request done: records `agent.request.done` activity and notifies the requester (`request.done`). */
export async function completeRequest(docId: string, requestId: string, actor: Actor, input: CompleteInput = {}): Promise<AgentRequestItem> {
  const row = await getRequest(docId, requestId);
  if (row.status === "done") return toRequestItem(row);
  if (row.status === "cancelled") throw new HttpError(409, "Request was cancelled", { status: row.status });
  const prev = row.result ?? { suggestions: 0, comments: 0 };
  const result: AgentRequestResult = {
    ...prev,
    suggestions: input.suggestions ?? prev.suggestions,
    comments: input.comments ?? prev.comments,
  };
  const summary = input.summary?.trim();
  if (summary) result.summary = clip(summary, 500);
  const name = row.claimedBy ?? agentName(actor);
  const db = await getDb();
  const [updated] = await db
    .update(schema.agentRequests)
    .set({ status: "done", claimedBy: name, result, updatedAt: new Date() })
    .where(eq(schema.agentRequests.id, requestId))
    .returning();
  await recordActivity(docId, activityActor(actor), "agent.request.done", {
    requestId,
    mode: row.mode,
    suggestions: result.suggestions,
    comments: result.comments,
    summary: result.summary ?? null,
    instruction: clip(row.instruction),
  });
  const [requester] = await db.select({ login: schema.users.login }).from(schema.users).where(eq(schema.users.id, row.userId));
  if (requester?.login) {
    // The agent acts for a user: when that user is the requester the actor check in notify() would drop
    // the row, so attribute the notification to the agent itself (no login) — the human still wants to hear.
    await notify({
      userLogin: requester.login,
      documentId: docId,
      kind: "request.done",
      actorLogin: null,
      actorName: name,
      refId: requestId,
      snippet: result.summary ?? summarizeResult(result) ?? clip(row.instruction),
    });
  }
  await mirrorRequest(updated, actor);
  return toRequestItem(updated);
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
