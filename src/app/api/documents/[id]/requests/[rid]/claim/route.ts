import { handler, json, requireAccess, HttpError } from "@/server/http";
import { claimRequest } from "@/server/agent-requests";

type Params = { params: Promise<{ id: string; rid: string }> };

/** An agent takes an open request. Requires comment access (the work itself is checked by the suggest/comment routes). */
export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id, rid } = await params;
  const { user } = await requireAccess(id, "comment");
  if (!user) throw new HttpError(401, "Sign in required");
  const request = await claimRequest(id, rid, user);
  return json({ request });
});
