import { handler, json, requireScope, requireUser, HttpError } from "@/server/http";
import { markNotificationRead, notificationBelongsTo } from "@/server/notifications";

type Params = { params: Promise<{ id: string }> };

/**
 * Mark one of the current user's notifications as read. Idempotent: the bell marks the clicked row
 * read and opens its thread, which marks the same row read by ref (`thread-read`); whichever request
 * lands second finds nothing to change and must still succeed, otherwise the browser logs a 404.
 */
export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  requireScope(user, "comment", "mark notifications read");
  if (!user.login) throw new HttpError(404, "Notification not found");
  const changed = await markNotificationRead(id, user.login, user.documentIds);
  if (!changed && !(await notificationBelongsTo(id, user.login, user.documentIds))) throw new HttpError(404, "Notification not found");
  return json({ ok: true, changed });
});
