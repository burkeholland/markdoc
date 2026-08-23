import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError } from "@/server/http";
import { listAgentPresence, setAgentPresence, AGENT_PRESENCE_TTL_MS, STATUS_MAX } from "@/server/agent-presence";

type Params = { params: Promise<{ id: string }> };

const schema = z.object({
  state: z.enum(["active", "idle", "left"]),
  /** Free text shown next to the agent in the presence list: "reading", "drafting the summary". */
  status: z.string().trim().max(STATUS_MAX).nullable().optional(),
  /** Offsets in the clean Markdown the agent is looking at (optional; shown as its cursor later). */
  cursor: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).nullable().optional(),
});

/**
 * Agent heartbeat. Token-only: the agent shows up in the document's presence list (bot avatar + status) for
 * 90 s after the last heartbeat or write, or until it sends `left`. Writes through the API mark the agent
 * active implicitly; this endpoint is for "reading"/"thinking" and for idle/left.
 */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user } = await requireAccess(id, "view");
  if (!user?.agent) throw new HttpError(403, "This endpoint is for API tokens (agents). Create one at /settings");
  const body = await readJson(req, (d) => schema.parse(d));
  const presence = setAgentPresence(id, user, { state: body.state, status: body.status, cursor: body.cursor });
  return json({ ok: true, presence, ttlMs: AGENT_PRESENCE_TTL_MS });
});

/** Agents currently present on the document. */
export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  await requireAccess(id, "view");
  return json({ agents: listAgentPresence(id), ttlMs: AGENT_PRESENCE_TTL_MS });
});
