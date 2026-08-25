import { z } from "zod";
import { handler, json, requireUser, tokenAllowsDocument } from "@/server/http";
import { listNotifications, NOTIFICATION_KINDS, type NotificationItem } from "@/server/notifications";
import type { NotificationKind } from "@/server/db/schema";

export function toDto(n: NotificationItem) {
  return { ...n, createdAt: n.createdAt.toISOString(), readAt: n.readAt ? n.readAt.toISOString() : null };
}

const querySchema = z.object({
  unread: z.boolean(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  kind: z.enum(NOTIFICATION_KINDS as [NotificationKind, ...NotificationKind[]]).optional(),
});

/**
 * The current user's notifications, newest first, with the document title and the total unread count.
 * `?unread=1` keeps only unread ones; `?limit=` (1–100, default 20); `?kind=` filters by kind. Anything else is a `400`.
 */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  if (!user.login) return json({ items: [], unreadCount: 0 });
  const params = new URL(req.url).searchParams;
  const { unread, limit, kind } = querySchema.parse({
    unread: params.get("unread") === "1",
    limit: params.get("limit") || undefined,
    kind: params.get("kind") || undefined,
  });
  const page = await listNotifications(user.login, { unread, limit, kind });
  // A document-restricted token only hears about its documents.
  const items = page.items.filter((n) => tokenAllowsDocument(user, n.documentId)).map(toDto);
  return json({ items, unreadCount: user.documentIds?.length ? items.filter((n) => !n.readAt).length : page.unreadCount });
});
