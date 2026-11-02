import type { NotificationDto } from "@/lib/api";

/** Where a notification leads: its document, with a thread or access request to activate when needed. */
export function notificationHref(n: Pick<NotificationDto, "kind" | "documentId" | "refId" | "id" | "actorLogin" | "readAt">): string {
  if (n.kind === "share") return `/d/${n.documentId}`;
  if (n.kind === "access.request") {
    if (!n.readAt && n.actorLogin) {
      const params = new URLSearchParams({ accessRequest: n.actorLogin, notification: n.id });
      return `/d/${n.documentId}?${params.toString()}`;
    }
    return `/d/${n.documentId}?share=1`;
  }
  return `/d/${n.documentId}?thread=${encodeURIComponent(n.refId)}`;
}
