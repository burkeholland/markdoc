import type { NotificationItem } from "@/server/notifications";

export function toDto(n: NotificationItem) {
  return { ...n, createdAt: n.createdAt.toISOString(), readAt: n.readAt ? n.readAt.toISOString() : null };
}
