// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/server/http", () => ({ currentUser: vi.fn() }));
vi.mock("@/server/folders", () => ({ getFolderAccess: vi.fn(), listDocumentsInFolder: vi.fn() }));
vi.mock("@/server/publish", () => ({ githubUrlFor: vi.fn() }));

import { currentUser } from "@/server/http";
import { getFolderAccess, listDocumentsInFolder } from "@/server/folders";
import FolderPage from "./page";

beforeEach(() => {
  vi.mocked(currentUser).mockResolvedValue(null);
  vi.mocked(getFolderAccess).mockResolvedValue({
    folder: {
      id: "planning", name: "Public planning", ownerId: "owner", ownerName: "Owner", ownerLogin: "owner",
      role: "viewer", linkAccess: "view", documentCount: 0,
      createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
    }, role: "viewer", source: "link",
  });
  vi.mocked(listDocumentsInFolder).mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each<{ search: Record<string, string | string[]>; expected: string }>([
  { search: {}, expected: "/f/planning" },
  { search: { share: "1" }, expected: "/f/planning?share=1" },
  { search: { accessRequest: "alice", notification: "request-id" }, expected: "/f/planning?accessRequest=alice&notification=request-id" },
  {
    search: { share: "1", accessRequest: "alice", notification: "request-id", redirect: "https://untrusted.example" },
    expected: "/f/planning?share=1&accessRequest=alice&notification=request-id",
  },
  { search: { share: ["1", "0"], accessRequest: "a".repeat(101), notification: ["request-id"] }, expected: "/f/planning" },
])("preserves only bounded scalar Share context in a public folder's sign-in link: $expected", async ({ search, expected }) => {
  render(await FolderPage({ params: Promise.resolve({ id: "planning" }), searchParams: Promise.resolve(search) }));
  expect(screen.getByRole("link", { name: "Sign in to comment or edit when allowed" }))
    .toHaveAttribute("href", `/login?next=${encodeURIComponent(expected)}`);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByTestId("folder-page-share")).not.toBeInTheDocument();
  expect(getFolderAccess).toHaveBeenCalledExactlyOnceWith("planning", null);
});
