import { handler, json, requireUser, tokenAllowsDocument } from "@/server/http";
import { listNotifications } from "@/server/notifications";
import { toDto } from "@/app/api/notifications/route";

/** @deprecated Alias kept for one release: unread notifications of kind `mention`. Use GET /api/notifications?unread=1&kind=mention. */
export const GET = handler(async () => {
  const user = await requireUser();
  if (!user.login) return json({ items: [], unreadCount: 0, mentions: [] });
  const page = await listNotifications(user.login, { unread: true, kind: "mention" });
  const items = page.items.filter((n) => tokenAllowsDocument(user, n.documentId)).map(toDto);
  return json({ items, unreadCount: user.documentIds?.length ? items.length : page.unreadCount, mentions: items.map((n) => ({ ...n, commentId: n.refId, byLogin: n.actorLogin })) });
});
