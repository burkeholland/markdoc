import { handler, json, requireUser, HttpError } from "@/server/http";
import { clampWait, pollEvents, parseIncludeSelf, InvalidCursorError, WAIT_MAX_S } from "@/server/agent-events";

/**
 * Cross-document long-poll for an idle agent: @mentions of the token's user and new "Ask an agent" requests
 * on every document they own or collaborate on. `?since=<cursor>&wait=<seconds, max 55>`; no `since` returns
 * the current cursor only. Mentions written by the token itself are skipped unless `includeSelf=1`. Token-only.
 */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  if (!user.agent) throw new HttpError(403, "This endpoint is for API tokens (agents). Create one at /settings");
  const q = new URL(req.url).searchParams;
  const page = await pollEvents(null, user, q.get("since"), clampWait(q.get("wait")), { includeSelf: parseIncludeSelf(q.get("includeSelf")) }).catch((err) => {
    if (err instanceof InvalidCursorError) throw new HttpError(400, err.message);
    throw err;
  });
  return json({ ...page, agent: user.agent, waitMax: WAIT_MAX_S });
});

export const dynamic = "force-dynamic";
