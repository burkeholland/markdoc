import { describe, expect, it } from "vitest";
import type { NotificationDto } from "@/lib/api";
import { shareReturnPath } from "@/lib/share-target";
import { notificationHref } from "./open";

type AccessRequest = Pick<Extract<NotificationDto, { documentId: string }>, "kind" | "documentId" | "refId" | "id" | "actorLogin" | "readAt">;

it("opens the exact folder Share pane for an unread or read access request", () => {
  const request = { id: "folder-request", kind: "access.request" as const, resource: "folder" as const, folderId: "requested-folder", documentId: null, actorLogin: "carol", refId: "requested-folder:carol", readAt: null };
  expect(notificationHref(request)).toBe("/f/requested-folder?accessRequest=carol&notification=folder-request");
  expect(notificationHref({ ...request, readAt: "2026-09-01" })).toBe("/f/requested-folder?share=1");
});

it("preserves document and folder Share destinations across sign-in without forwarding unrelated parameters", () => {
  for (const resource of ["d", "f"]) {
    expect(shareReturnPath(`/${resource}/target`, { accessRequest: "carol", notification: "request-id", redirect: "https://untrusted.example" }))
      .toBe(`/${resource}/target?accessRequest=carol&notification=request-id`);
    expect(shareReturnPath(`/${resource}/target`, { share: "1" })).toBe(`/${resource}/target?share=1`);
  }
});

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
