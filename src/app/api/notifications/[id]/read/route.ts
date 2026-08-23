import { handler, json, requireUser, HttpError } from "@/server/http";
import { markNotificationRead } from "@/server/notifications";

type Params = { params: Promise<{ id: string }> };

/** Mark one of the current user's notifications as read. */
export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  if (!user.login) throw new HttpError(404, "Notification not found");
  const ok = await markNotificationRead(id, user.login);
  if (!ok) throw new HttpError(404, "Notification not found");
  return json({ ok: true });
});
