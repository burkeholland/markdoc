import type { NotificationDto } from "@/lib/api";

/** Where a notification leads: the document, with the thread or suggestion to activate as `?thread=`. */
export function notificationHref(n: Pick<NotificationDto, "kind" | "documentId" | "refId">): string {
  if (n.kind === "share") return `/d/${n.documentId}`;
  if (n.kind === "access.request") return `/d/${n.documentId}?share=1`;
  return `/d/${n.documentId}?thread=${encodeURIComponent(n.refId)}`;
}
