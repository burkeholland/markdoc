// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type FolderDto } from "@/lib/api";
import { FolderPageClient } from "./folder-client";

const folder: FolderDto = {
  id: "planning", name: "Planning", ownerId: "owner", ownerName: "Owner", ownerLogin: "owner", role: "owner", linkAccess: "private",
  documentCount: 2, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const documents = [
  { id: "budget", title: "Budget", role: "owner" as const, updatedAt: folder.updatedAt },
  { id: "schedule", title: "Schedule", role: "owner" as const, updatedAt: folder.updatedAt },
];
beforeEach(() => {
  vi.spyOn(api.documents, "get").mockResolvedValue({
    document: {
      id: "schedule", title: "Schedule", ownerId: "owner", storage: "local", linkAccess: "private", linkPreview: true,
      gistId: null, gistFile: null, repoOwner: null, repoName: null, repoBranch: null, repoPath: null,
      publishedAt: null, hasUnpublishedChanges: false, githubUrl: null, createdAt: folder.createdAt, updatedAt: folder.updatedAt,
    }, role: "owner",
  });
  vi.spyOn(api.documents, "collaborators").mockResolvedValue({
    owner: { login: "owner", name: "Owner", image: null }, collaborators: [], agents: [], folder: null, linkAccess: "private",
  });
  vi.spyOn(api.documents, "addCollaborator").mockResolvedValue({ ok: true, login: "fixture", role: "viewer", pending: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("opens the selected document's existing Share pane rather than the folder's, without navigating or granting access", async () => {
  render(<FolderPageClient folder={folder} documents={documents} signedIn signInReturnPath="/f/planning" initialShare={false} requestLogin={null} notificationId={null} />);
  const location = window.location.href;
  fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for Schedule" }), { button: 0, ctrlKey: false });
  fireEvent.click(within(screen.getByRole("menu")).getByTestId("document-share"));
  await screen.findByTestId("share-presentation");
  expect(screen.getByRole("dialog", { name: "Share “Schedule”" })).toBeVisible();
  expect(api.documents.get).toHaveBeenCalledExactlyOnceWith("schedule", expect.objectContaining({ cache: "no-store" }));
  expect(api.documents.addCollaborator).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(window.location.href).toBe(location);
  expect(screen.getByRole("heading", { name: "Planning" })).toBeVisible();
  expect(screen.getAllByTestId("folder-document-row")).toHaveLength(2);
});

it("does not offer document management actions to a folder visitor with edit access", () => {
  render(<FolderPageClient folder={{ ...folder, role: "editor" }} documents={documents.map((document) => ({ ...document, role: "editor" }))} signedIn signInReturnPath="/f/planning" initialShare={false} requestLogin={null} notificationId={null} />);
  expect(screen.queryByTestId("document-menu")).not.toBeInTheDocument();
  expect(screen.queryByTestId("folder-page-share")).not.toBeInTheDocument();
  expect(api.documents.get).not.toHaveBeenCalled();
});
