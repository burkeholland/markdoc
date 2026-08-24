import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError } from "@/server/http";
import { listAgentPresence, resolveAgentCursor, setAgentPresence, AGENT_PRESENCE_TTL_MS, STATUS_MAX, type AgentCursor } from "@/server/agent-presence";
import { readLiveDoc } from "@/server/livedoc";

type Params = { params: Promise<{ id: string }> };

const schema = z.object({
  state: z.enum(["active", "idle", "left"]),
  /** Free text shown next to the agent in the presence list: "reading", "drafting the summary". */
  status: z.string().trim().max(STATUS_MAX).nullable().optional(),
  /** Offsets in the clean Markdown (as `markdoc_read_document` with `clean: true` returns it) the agent is looking at; drawn as its caret. `null` hides it. */
  cursor: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).nullable().optional(),
  /** Alternative to `cursor`: the first occurrence of this text (like a comment's `quote`). */
  anchor: z.string().min(1).max(2000).optional(),
});

/**
 * Agent heartbeat. Token-only: the agent shows up in the document's presence list (bot avatar + status) for
 * 90 s after the last heartbeat or write, or until it sends `left`. Writes through the API mark the agent
 * active implicitly; this endpoint is for "reading"/"thinking" and for idle/left, and for placing its caret.
 */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user } = await requireAccess(id, "view");
  if (!user?.agent) throw new HttpError(403, "This endpoint is for API tokens (agents). Create one at /settings");
  const body = await readJson(req, (d) => schema.parse(d));
  let cursor: AgentCursor | null | undefined;
  if (body.state !== "left" && (body.anchor !== undefined || body.cursor)) {
    const input = body.anchor !== undefined ? { anchor: body.anchor } : body.cursor!;
    cursor = await readLiveDoc(id, (doc) => resolveAgentCursor(doc, input));
    if (!cursor) throw new HttpError(400, `Text not found: ${JSON.stringify(body.anchor!.slice(0, 80))}`);
  } else if (body.cursor === null) {
    cursor = null;
  }
  const presence = setAgentPresence(id, user, { state: body.state, status: body.status, cursor });
  return json({ ok: true, presence, ttlMs: AGENT_PRESENCE_TTL_MS });
});

/** Agents currently present on the document. */
export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  await requireAccess(id, "view");
  return json({ agents: listAgentPresence(id), ttlMs: AGENT_PRESENCE_TTL_MS });
});
