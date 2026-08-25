import { z } from "zod";
import { handler, json, requireUser } from "@/server/http";
import { listNotifications, type NotificationItem } from "@/server/notifications";
import type { NotificationKind } from "@/server/db/schema";

const KINDS: NotificationKind[] = ["mention", "reply", "resolve", "reopen", "suggestion.accept", "suggestion.reject", "share", "request.done"];

export function toDto(n: NotificationItem) {
  return { ...n, createdAt: n.createdAt.toISOString(), readAt: n.readAt ? n.readAt.toISOString() : null };
}

const querySchema = z.object({
  unread: z.boolean(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  kind: z.enum(KINDS as [NotificationKind, ...NotificationKind[]]).optional(),
});

/**
 * The current user's notifications, newest first, with the document title and the total unread count.
 * `?unread=1` keeps only unread ones; `?limit=` (1–100, default 20; anything else is a `400`); `?kind=` filters by kind.
 */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  if (!user.login) return json({ items: [], unreadCount: 0 });
  const params = new URL(req.url).searchParams;
  const kindParam = params.get("kind");
  const { unread, limit, kind } = querySchema.parse({
    unread: params.get("unread") === "1",
    limit: params.get("limit") || undefined,
    // An unknown kind is ignored (no filter), as before.
    kind: kindParam && (KINDS as string[]).includes(kindParam) ? kindParam : undefined,
  });
  const page = await listNotifications(user.login, { unread, limit, kind });
  return json({ items: page.items.map(toDto), unreadCount: page.unreadCount });
});
