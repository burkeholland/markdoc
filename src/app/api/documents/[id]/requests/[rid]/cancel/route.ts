import { handler, json, requireAccess, HttpError } from "@/server/http";
import { cancelRequest } from "@/server/agent-requests";

type Params = { params: Promise<{ id: string; rid: string }> };

/** The requester (or the document owner) withdraws a request. */
export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id, rid } = await params;
  const { user, role } = await requireAccess(id, "view");
  if (!user) throw new HttpError(401, "Sign in required");
  const request = await cancelRequest(id, rid, user, role);
  return json({ request });
});
