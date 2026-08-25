import { z } from "zod";
import { handler, json, requireUser, tokenAllowsDocument, HttpError } from "@/server/http";
import { listRequestsForUser } from "@/server/agent-requests";
import type { AgentRequestStatus } from "@/server/db/schema";

const STATUSES = ["open", "claimed", "done", "cancelled"] as const satisfies readonly AgentRequestStatus[];

const querySchema = z.object({
  status: z.array(z.enum(STATUSES)).min(1).default(["open"]),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * The agent's inbox: requests across every document the token's user owns or collaborates on.
 * Token-only — this is how an agent (Copilot CLI via MCP) finds work that humans asked for in the editor.
 * `?status=open` (default) or a comma-separated list of `open | claimed | done | cancelled`; `?limit=` 1–200
 * (default 50). Anything else is a `400`.
 */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  if (!user.agent) throw new HttpError(403, "This endpoint is for API tokens (agents). Create one at /settings");
  const q = new URL(req.url).searchParams;
  // `open,,claimed` keeps its empty member so the schema names it in `issues` instead of dropping it.
  const { status, limit } = querySchema.parse({ status: q.get("status")?.split(",").map((s) => s.trim()), limit: q.get("limit") || undefined });
  const requests = (await listRequestsForUser(user, { status, limit })).filter((r) => tokenAllowsDocument(user, r.documentId));
  return json({ requests, agent: user.agent });
});
