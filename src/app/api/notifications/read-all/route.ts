import { handler, json, requireUser } from "@/server/http";
import { markAllNotificationsRead } from "@/server/notifications";

/** Mark every unread notification of the current user as read. Returns how many changed. */
export const POST = handler(async () => {
  const user = await requireUser();
  if (!user.login) return json({ ok: true, count: 0 });
  const count = await markAllNotificationsRead(user.login);
  return json({ ok: true, count });
});
