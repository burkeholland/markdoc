import { describe, expect, it } from "vitest";
import type { NotificationDto } from "@/lib/api";
import { notificationHref } from "./open";

type AccessRequest = Pick<NotificationDto, "kind" | "documentId" | "refId" | "id" | "actorLogin" | "readAt">;

const request: AccessRequest = {
  id: "notification-1",
  kind: "access.request",
  documentId: "document-1",
  refId: "document-1:alice",
  actorLogin: "alice",
  readAt: null,
};

describe("notificationHref", () => {
  it("preserves the requester and notification context for an unread access request", () => {
    expect(notificationHref(request)).toBe("/d/document-1?accessRequest=alice&notification=notification-1");
  });

  it.each([
    ["read", { ...request, readAt: "2026-09-07T12:10:00.000Z" }],
    ["without a requester login", { ...request, actorLogin: null }],
  ] as const)("opens an access request %s in the generic share dialog", (_label, notification) => {
    expect(notificationHref(notification)).toBe("/d/document-1?share=1");
  });
});
