// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type FolderDto } from "@/lib/api";
import { FolderPageClient } from "./folder-client";
import { FolderShareDialog } from "@/components/dashboard/folders";

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

it("keeps a direct folder-page request visible after a failed read write and dismisses only after a confirmed retry", async () => {
  vi.spyOn(api.folders, "collaborators").mockResolvedValue({ owner: null, collaborators: [], exceptions: {}, linkAccess: "private" });
  vi.spyOn(api.folders, "accessPreview").mockResolvedValue({ login: "alice", role: "viewer", exceptions: [] });
  let release!: (value: { ok: true; changed: boolean }) => void;
  const pending = new Promise<{ ok: true; changed: boolean }>((resolve) => { release = resolve; });
  vi.spyOn(api.notifications, "read").mockRejectedValueOnce(new Error("read unavailable")).mockReturnValueOnce(pending);
  vi.spyOn(api.notifications, "list");
  vi.spyOn(api.folders, "addCollaborator");
  render(<FolderPageClient folder={folder} documents={documents} signedIn signInReturnPath="/f/planning" initialShare requestLogin="alice" notificationId="request-alice" />);
  const banner = await screen.findByTestId("folder-access-request");
  fireEvent.click(within(banner).getByRole("button", { name: "Dismiss request" }));
  expect(await within(banner).findByRole("alert")).toHaveTextContent("Could not dismiss this request. Try again.");
  expect(banner).toBeVisible();
  fireEvent.click(within(banner).getByRole("button", { name: "Retry dismissal" }));
  expect(within(banner).getByRole("button", { name: "Dismissing…" })).toBeDisabled();
  expect(banner).toBeVisible();
  await act(async () => release({ ok: true, changed: true }));
  await waitFor(() => expect(screen.queryByTestId("folder-access-request")).not.toBeInTheDocument());
  expect(api.notifications.read).toHaveBeenNthCalledWith(1, "request-alice");
  expect(api.notifications.read).toHaveBeenNthCalledWith(2, "request-alice");
  expect(api.notifications.list).not.toHaveBeenCalled();
  expect(api.folders.addCollaborator).not.toHaveBeenCalled();
});

it("preserves an explicitly saved folder grant when the notification write fails and retries dismissal without granting again", async () => {
  const alice = { login: "alice", role: "viewer" as const, name: null, image: null, createdAt: folder.createdAt };
  vi.spyOn(api.folders, "collaborators")
    .mockResolvedValueOnce({ owner: null, collaborators: [], exceptions: {}, linkAccess: "private" })
    .mockResolvedValue({ owner: null, collaborators: [alice], exceptions: {}, linkAccess: "private" });
  vi.spyOn(api.folders, "accessPreview").mockResolvedValue({ login: "alice", role: "viewer", exceptions: [] });
  vi.spyOn(api.folders, "addCollaborator").mockResolvedValue({ ok: true, login: "alice", role: "viewer", pending: false });
  vi.spyOn(api.notifications, "read").mockRejectedValueOnce(new Error("read unavailable")).mockResolvedValueOnce({ ok: true, changed: true });
  render(<FolderPageClient folder={folder} documents={documents} signedIn signInReturnPath="/f/planning" initialShare requestLogin="alice" notificationId="request-saved-alice" />);
  const add = await screen.findByTestId("folder-share-add");
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);
  const banner = screen.getByTestId("folder-access-request");
  expect(await within(banner).findByRole("alert")).toHaveTextContent("Could not dismiss this request.");
  expect(screen.getByRole("button", { name: "Remove alice" }).closest("li")).toHaveTextContent("Folder grant: View");
  expect(screen.getByTestId("share-login")).toHaveValue("");
  fireEvent.click(within(banner).getByRole("button", { name: "Retry dismissal" }));
  await waitFor(() => expect(screen.queryByTestId("folder-access-request")).not.toBeInTheDocument());
  expect(api.folders.addCollaborator).toHaveBeenCalledExactlyOnceWith("planning", "alice", "viewer");
  expect(api.notifications.read).toHaveBeenCalledTimes(2);
});

it.each([true, false])("ignores an old request's confirmed=%s completion after the pane changes to a different request", async (confirmed) => {
  vi.spyOn(api.folders, "collaborators").mockResolvedValue({ owner: null, collaborators: [], exceptions: {}, linkAccess: "private" });
  vi.spyOn(api.folders, "accessPreview").mockResolvedValue({ login: "alice", role: "viewer", exceptions: [] });
  let release!: () => void;
  const pending = new Promise<{ ok: true; changed: boolean }>((resolve, reject) => {
    release = () => confirmed ? resolve({ ok: true, changed: true }) : reject(new Error("old read failure"));
  });
  vi.spyOn(api.notifications, "read").mockReturnValueOnce(pending);
  const resolved = vi.fn();
  const view = render(<FolderShareDialog folder={folder} onOpenChange={vi.fn()} accessRequest={{ login: "alice", notificationId: "old-request" }} onRequestResolved={resolved} />);
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss request" }));
  view.rerender(<FolderShareDialog folder={folder} onOpenChange={vi.fn()} accessRequest={{ login: "bob", notificationId: "new-request" }} onRequestResolved={resolved} />);
  await act(async () => { release(); await pending.catch(() => {}); });
  expect(screen.getByTestId("folder-access-request")).toHaveTextContent("@bob");
  expect(within(screen.getByTestId("folder-access-request")).queryByRole("alert")).not.toBeInTheDocument();
  expect(resolved).not.toHaveBeenCalled();
});
