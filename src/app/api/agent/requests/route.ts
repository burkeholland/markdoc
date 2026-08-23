import { handler, json, requireUser, HttpError } from "@/server/http";
import { listRequestsForUser } from "@/server/agent-requests";
import type { AgentRequestStatus } from "@/server/db/schema";

const STATUSES: AgentRequestStatus[] = ["open", "claimed", "done", "cancelled"];

/**
 * The agent's inbox: requests across every document the token's user owns or collaborates on.
 * Token-only — this is how an agent (Copilot CLI via MCP) finds work that humans asked for in the editor.
 * `?status=open` (default) or a comma-separated list; `?limit=`.
 */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  if (!user.agent) throw new HttpError(403, "This endpoint is for API tokens (agents). Create one at /settings");
  const q = new URL(req.url).searchParams;
  const raw = q.get("status");
  const status = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is AgentRequestStatus => (STATUSES as string[]).includes(s))
    : ["open" as const];
  const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
  const requests = await listRequestsForUser(user, { status: status.length ? status : ["open"], limit: Number.isFinite(limit) ? limit : undefined });
  return json({ requests, agent: user.agent });
});
