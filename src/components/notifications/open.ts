import type { NotificationDto } from "@/lib/api";

type NotificationDestination = Pick<NotificationDto, "kind" | "refId" | "id" | "actorLogin" | "readAt"> & (
  | { resource?: "document"; documentId: string }
  | { resource: "folder"; documentId: null; folderId: string }
);

/** Requests open the exact resource's Share pane; thread notifications keep their document context. */
export function notificationHref(n: NotificationDestination): string {
  const target = n.resource === "folder" ? `/f/${n.folderId}` : `/d/${n.documentId}`;
  if (n.kind === "share") return target;
  if (n.kind === "access.request") {
    if (!n.readAt && n.actorLogin) {
      const params = new URLSearchParams({ accessRequest: n.actorLogin, notification: n.id });
      return `${target}?${params.toString()}`;
    }
    return `${target}?share=1`;
  }
  return `${target}?thread=${encodeURIComponent(n.refId)}`;
}
