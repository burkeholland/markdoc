import { handler, json, requireAccess, HttpError } from "@/server/http";
import { clampWait, pollEvents, parseIncludeSelf, InvalidCursorError, WAIT_MAX_S } from "@/server/agent-events";

type Params = { params: Promise<{ id: string }> };

/**
 * Long-poll for what happened on a document: `?since=<cursor>&wait=<seconds, max 55>`. Without `since` the
 * current cursor is returned with no events (start watching from now). Events: `content.changed` (hash +
 * unified diff of the clean text), `comment.added|replied|resolved`, `mention` (of the token's user),
 * `request.created` (Ask an agent), and `activity` for anything else in the feed. Every event carries
 * `actor` (`{ id, name, login, kind, agent, self }`); the token's own events are skipped unless
 * `includeSelf=1`. Token-only.
 */
export const GET = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user } = await requireAccess(id, "view");
  if (!user?.agent) throw new HttpError(403, "This endpoint is for API tokens (agents). Create one at /settings");
  const q = new URL(req.url).searchParams;
  const page = await pollEvents(id, user, q.get("since"), clampWait(q.get("wait")), { includeSelf: parseIncludeSelf(q.get("includeSelf")) }).catch((err) => {
    if (err instanceof InvalidCursorError) throw new HttpError(400, err.message);
    throw err;
  });
  return json({ ...page, documentId: id, waitMax: WAIT_MAX_S });
});

export const dynamic = "force-dynamic";
