import { handler, json, requireUser } from "@/server/http";
import { listNotifications, type NotificationItem } from "@/server/notifications";
import type { NotificationKind } from "@/server/db/schema";

const KINDS: NotificationKind[] = ["mention", "reply", "resolve", "reopen", "suggestion.accept", "suggestion.reject", "share"];

export function toDto(n: NotificationItem) {
  return { ...n, createdAt: n.createdAt.toISOString(), readAt: n.readAt ? n.readAt.toISOString() : null };
}

/**
 * The current user's notifications, newest first, with the document title and the total unread count.
 * `?unread=1` keeps only unread ones; `?limit=` (1–100, default 20); `?kind=` filters by kind.
 */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  if (!user.login) return json({ items: [], unreadCount: 0 });
  const url = new URL(req.url);
  const unread = url.searchParams.get("unread") === "1";
  const limit = Number(url.searchParams.get("limit") ?? 20) || 20;
  const kindParam = url.searchParams.get("kind");
  const kind = kindParam && (KINDS as string[]).includes(kindParam) ? (kindParam as NotificationKind) : undefined;
  const page = await listNotifications(user.login, { unread, limit, kind });
  return json({ items: page.items.map(toDto), unreadCount: page.unreadCount });
});
