import { handler, json, requireUser, HttpError } from "@/server/http";
import { deleteWebhook } from "@/server/webhooks";

type Params = { params: Promise<{ id: string }> };

export const DELETE = handler(async (_req: Request, { params }: Params) => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "Webhooks can only be managed from a signed-in browser session");
  const { id } = await params;
  const ok = await deleteWebhook(user.id, id);
  if (!ok) throw new HttpError(404, "Webhook not found");
  return json({ ok: true });
});
