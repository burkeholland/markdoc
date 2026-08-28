import { handler, json, requireScope, requireUser } from "@/server/http";
import { markAllNotificationsRead } from "@/server/notifications";

/** Mark every unread notification of the current user as read. Returns how many changed. */
export const POST = handler(async () => {
  const user = await requireUser();
  requireScope(user, "comment", "mark notifications read");
  if (!user.login) return json({ ok: true, count: 0 });
  const count = await markAllNotificationsRead(user.login, user.documentIds);
  return json({ ok: true, count });
});
