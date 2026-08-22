import { handler, json, requireUser, HttpError } from "@/server/http";
import { markMentionRead } from "@/server/mentions";

type Params = { params: Promise<{ id: string }> };

/** Mark one of the current user's mentions as read. */
export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  if (!user.login) throw new HttpError(404, "Mention not found");
  const ok = await markMentionRead(id, user.login);
  if (!ok) throw new HttpError(404, "Mention not found");
  return json({ ok: true });
});
