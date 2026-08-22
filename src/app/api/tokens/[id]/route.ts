import { handler, json, requireUser, HttpError } from "@/server/http";
import { revokeApiToken } from "@/server/tokens";

type Params = { params: Promise<{ id: string }> };

export const DELETE = handler(async (_req: Request, { params }: Params) => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "API tokens can only be revoked from a signed-in browser session");
  const { id } = await params;
  const ok = await revokeApiToken(user.id, id);
  if (!ok) throw new HttpError(404, "Token not found");
  return json({ ok: true });
});
