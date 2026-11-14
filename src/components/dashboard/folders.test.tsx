// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollaboratorDto, DocumentSummaryDto, FolderDto } from "@/lib/api";

type ListResponse = { folders: FolderDto[] };
type MoveResponse = { moved: string[] };
type FolderPeople = { owner: { login: string | null; name: string | null; image: string | null } | null; collaborators: CollaboratorDto[]; linkAccess?: FolderDto["linkAccess"]; exceptions?: Record<string, import("@/server/folders").FolderAccessException[]> };

const listFolders = vi.fn<() => Promise<ListResponse>>();
const createFolder = vi.fn<(name: string) => Promise<{ folder: FolderDto }>>();
const renameFolder = vi.fn<(id: string, name: string) => Promise<{ folder: FolderDto }>>();
const deleteFolder = vi.fn<(id: string) => Promise<{ ok: true; trashed: number }>>();
const listFolderCollaborators = vi.fn<(id: string) => Promise<FolderPeople>>();
const addFolderCollaborator = vi.fn<(id: string, login: string, role: "editor" | "commenter" | "viewer", options?: { change?: boolean }) => Promise<{ ok: true; login: string; role: string; pending: boolean }>>();
const removeFolderCollaborator = vi.fn<(id: string, login: string) => Promise<{ ok: true }>>();
const accessPreview = vi.fn();
const updateLinkAccess = vi.fn();
const moveDocuments = vi.fn<(ids: readonly string[], folderId: string | null) => Promise<MoveResponse>>();
const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() };

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/dashboard/notifications-strip", () => ({ NotificationsStrip: () => null }));
vi.mock("@/components/ui/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/lib/notice", () => ({ takePendingNotice: () => null }));
vi.mock("@/lib/sign-out", () => ({ signOutSafely: async () => true }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      documents: {
        ...actual.api.documents,
        search: async (query: string) => ({ query, documents: [] }),
        list: async () => ({ documents: [] }),
        move: (ids: readonly string[], folderId: string | null) => moveDocuments(ids, folderId),
      },
      folders: {
        accessPreview: (...args: unknown[]) => accessPreview(...args),
        updateLinkAccess: (...args: unknown[]) => updateLinkAccess(...args),
        list: () => listFolders(),
        create: (name: string) => createFolder(name),
        collaborators: (id: string) => listFolderCollaborators(id),
        addCollaborator: (id: string, login: string, role: "editor" | "commenter" | "viewer", options?: { change?: boolean }) =>
          addFolderCollaborator(id, login, role, options),
        removeCollaborator: (id: string, login: string) => removeFolderCollaborator(id, login),
        rename: (id: string, name: string) => renameFolder(id, name),
        delete: (id: string) => deleteFolder(id),
      },
    },
  };
});

const { Dashboard } = await import("./dashboard");
const { FolderShareDialog } = await import("./folders");

const USER = { id: "owner", name: "Owner", login: "owner", image: null };

function person(login: string, role: CollaboratorDto["role"]): CollaboratorDto {
  return { login, role, name: login === "bob" ? "Bob Example" : null, image: null, createdAt: "2026-09-01T12:00:00.000Z" };
}

function doc(id: string, title: string, folderId: string | null = null, ownerId = USER.id): DocumentSummaryDto {
  return {
    id,
    title,
    excerpt: "",
    storage: "local",
    updatedAt: "2026-09-07T12:00:00.000Z",
    createdAt: "2026-09-01T12:00:00.000Z",
    lastOpenedAt: null,
    deletedAt: null,
    ownerId,
    ownerName: ownerId === USER.id ? USER.name : "Someone else",
    ownerLogin: ownerId === USER.id ? USER.login : "other",
    role: ownerId === USER.id ? "owner" : "editor",
    repoOwner: null,
    repoName: null,
    repoPath: null,
    gistId: null,
    starred: false,
    folderId,
    folderName: null,
  };
}

function folder(id: string, name: string, documentCount = 0): FolderDto {
  return {
    id,
    name,
    documentCount,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    ownerId: USER.id,
    ownerName: USER.name,
    ownerLogin: USER.login,
    role: "owner",
    linkAccess: "private",
  };
}

/** Render the dashboard and wait for the folder fetch to settle, so the rail is populated. */
async function mount(documents: DocumentSummaryDto[]) {
  const result = render(
    <Dashboard user={USER} documents={documents} githubAvailable={false} githubConfigured={false} />,
  );
  await waitFor(() => expect(listFolders).toHaveBeenCalled());
  return result;
}

/**
 * Open a Radix dropdown. Its trigger opens on pointerdown, not click, so `fireEvent.click` alone
 * leaves the menu shut — the same helper shape the account-menu tests in dashboard.test.tsx use.
 */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

function cardTitles(): string[] {
  const list = screen.queryByTestId("document-list");
  if (!list) return [];
  return within(list)
    .getAllByTestId("document-card")
    .map((card) => within(card).getByRole("heading").textContent ?? "");
}

beforeEach(() => {
  listFolders.mockReset().mockResolvedValue({ folders: [] });
  createFolder.mockReset();
  renameFolder.mockReset();
  deleteFolder.mockReset();
  listFolderCollaborators.mockReset().mockResolvedValue({ owner: null, collaborators: [] });
  addFolderCollaborator.mockReset().mockResolvedValue({ ok: true, login: "bob", role: "commenter", pending: false });
  removeFolderCollaborator.mockReset().mockResolvedValue({ ok: true });
  accessPreview.mockReset().mockResolvedValue({ login: "bob", role: "commenter", exceptions: [] });
  updateLinkAccess.mockReset().mockResolvedValue({ folder: folder("f1", "Recipes") });
  moveDocuments.mockReset();
  for (const fn of Object.values(router)) fn.mockReset();
});

afterEach(cleanup);

describe("the folder rail", () => {
  it("shows a retryable access-check failure and higher document access before and after saving a View folder grant", async () => {
    const exception = { documentId: "budget", documentTitle: "Budget", role: "editor" as const, source: "collaborator" as const };
    listFolders.mockResolvedValue({ folders: [folder("f1", "Planning")] });
    accessPreview.mockRejectedValueOnce(new Error("Access check unavailable")).mockResolvedValue({ exceptions: [exception] });
    await mount([]);
    openMenu(screen.getByTestId("folder-menu"));
    fireEvent.click(await screen.findByText("Share…"));
    expect(await screen.findByTestId("folder-share-warning")).toHaveTextContent("including documents added or moved into it later");
    fireEvent.change(screen.getByRole("combobox", { name: "Role for new folder collaborator" }), { target: { value: "viewer" } });
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "carol" } });
    expect(screen.getByTestId("folder-share-add")).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Retry access check" })).toBeVisible();
    expect(addFolderCollaborator).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry access check" }));
    expect(await screen.findByTestId("folder-access-exceptions")).toHaveTextContent("Edit on Budget via direct document grant");
    await waitFor(() => expect(screen.getByTestId("folder-share-add")).toBeEnabled());
    listFolderCollaborators.mockResolvedValue({ owner: null, collaborators: [person("carol", "viewer")], exceptions: { carol: [exception] } });
    addFolderCollaborator.mockResolvedValue({ ok: true, login: "carol", role: "viewer", pending: false });
    fireEvent.click(screen.getByTestId("folder-share-add"));
    await waitFor(() => expect(addFolderCollaborator).toHaveBeenCalledWith("f1", "carol", "viewer", undefined));
    expect(await screen.findByText("@carol")).toBeVisible();
    expect(screen.getByTestId("folder-access-exceptions")).toHaveTextContent("Folder grant: View for @carol");
    expect(screen.getByTestId("folder-access-exceptions")).toHaveTextContent("Edit on Budget via direct document grant");
  });

  it("ignores an old person's access preview after changing the query", async () => {
    let resolveOld!: (result: { exceptions: { documentId: string; documentTitle: string; role: string; source: string }[] }) => void;
    accessPreview.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue({ exceptions: [] });
    listFolders.mockResolvedValue({ folders: [folder("f1", "Preview races")] });
    await mount([]);
    openMenu(screen.getByTestId("folder-menu"));
    fireEvent.click(await screen.findByText("Share…"));
    fireEvent.change(screen.getByRole("combobox", { name: "Role for new folder collaborator" }), { target: { value: "viewer" } });
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "old-person" } });
    await waitFor(() => expect(accessPreview).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "new-person" } });
    expect(screen.getByTestId("folder-share-add")).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId("folder-share-add")).toBeEnabled());
    await act(async () => resolveOld({ exceptions: [{ documentId: "old", documentTitle: "Old person's document", role: "editor", source: "link" }] }));
    expect(screen.queryByText("Old person's document")).not.toBeInTheDocument();
    expect(addFolderCollaborator).not.toHaveBeenCalled();
  });

  it("sets a usable folder link and reflects its persisted access option", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Linked folder")] });
    await mount([]);
    openMenu(screen.getByTestId("folder-menu"));
    fireEvent.click(await screen.findByText("Share…"));
    await waitFor(() => expect(screen.getByTestId("folder-link-access")).toBeEnabled());
    listFolderCollaborators.mockResolvedValue({ owner: null, collaborators: [], linkAccess: "edit" });
    fireEvent.change(screen.getByTestId("folder-link-access"), { target: { value: "edit" } });
    await waitFor(() => expect(updateLinkAccess).toHaveBeenCalledWith("f1", "edit"));
    await waitFor(() => expect(screen.getByTestId("folder-link-access")).toHaveValue("edit"));
    expect(screen.getByTestId("folder-share-url")).toHaveTextContent("/f/f1");
    expect(screen.getByText(/Signed-out visitors can only view/)).toBeVisible();
  });

  it.each([
    { from: "private", to: "view" },
    { from: "view", to: "private" },
  ] as const)("keeps confirmed $from -> $to folder link access when its refresh fails, without repeating the mutation", async ({ from, to }) => {
    const target = { ...folder("f1", "Confirmed link"), linkAccess: from };
    const exception = { documentId: "budget", documentTitle: "Budget", role: "editor" as const, source: "collaborator" as const };
    const people = { owner: { login: "owner", name: "Owner", image: null }, collaborators: [person("bob", "viewer")], exceptions: { bob: [exception] } };
    let rejectRefresh!: (reason: Error) => void;
    listFolders.mockResolvedValue({ folders: [target] });
    listFolderCollaborators
      .mockResolvedValueOnce({ ...people, linkAccess: from })
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }))
      .mockResolvedValue({ ...people, linkAccess: to });
    updateLinkAccess.mockResolvedValue({ folder: { ...target, linkAccess: to } });
    await mount([]);
    openMenu(screen.getByTestId("folder-menu"));
    fireEvent.click(await screen.findByText("Share…"));
    await waitFor(() => expect(screen.getByTestId("folder-link-access")).toBeEnabled());

    fireEvent.change(screen.getByTestId("folder-link-access"), { target: { value: to } });
    await waitFor(() => expect(listFolderCollaborators).toHaveBeenCalledTimes(2));
    expect(screen.getByText("@bob")).toBeVisible();
    expect(screen.getByTestId("folder-access-exceptions")).toHaveTextContent("Edit on Budget via direct document grant");
    await act(async () => rejectRefresh(new Error("Folder access unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Folder access unavailable");
    expect(screen.getByTestId("folder-link-access")).toHaveValue(to);
    expect(screen.getByTestId("folder-link-access")).toBeDisabled();
    expect(updateLinkAccess).toHaveBeenCalledExactlyOnceWith("f1", to);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("folder-link-access")).toBeEnabled());
    expect(screen.getByTestId("folder-link-access")).toHaveValue(to);
    expect(screen.getByText("@bob")).toBeVisible();
    expect(screen.getByTestId("folder-access-exceptions")).toHaveTextContent("Edit on Budget via direct document grant");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByTestId("folder-share-dialog")).not.toBeInTheDocument());
    openMenu(screen.getByTestId("folder-menu"));
    fireEvent.click(await screen.findByText("Share…"));
    await waitFor(() => expect(screen.getByTestId("folder-link-access")).toBeEnabled());
    expect(screen.getByTestId("folder-link-access")).toHaveValue(to);
    expect(listFolderCollaborators).toHaveBeenCalledTimes(4);
    expect(updateLinkAccess).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous folder link setting when the PATCH fails", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Unchanged link")] });
    listFolderCollaborators.mockResolvedValue({ owner: null, collaborators: [], linkAccess: "private" });
    updateLinkAccess.mockRejectedValue(new Error("Link update unavailable"));
    await mount([]);
    openMenu(screen.getByTestId("folder-menu"));
    fireEvent.click(await screen.findByText("Share…"));
    await waitFor(() => expect(screen.getByTestId("folder-link-access")).toBeEnabled());
    fireEvent.change(screen.getByTestId("folder-link-access"), { target: { value: "view" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Link update unavailable");
    expect(screen.getByTestId("folder-link-access")).toHaveValue("private");
    expect(screen.getByTestId("folder-link-access")).toBeEnabled();
    expect(listFolderCollaborators).toHaveBeenCalledTimes(1);
    expect(updateLinkAccess).toHaveBeenCalledExactlyOnceWith("f1", "view");
  });

  it("drops a confirmed link change after switching to another folder", async () => {
    let finishPatch!: (result: { folder: FolderDto }) => void;
    updateLinkAccess.mockImplementationOnce(() => new Promise((resolve) => { finishPatch = resolve; }));
    listFolderCollaborators.mockImplementation(async (id) => ({
      owner: null, collaborators: [], linkAccess: id === "f1" ? "private" : "comment",
    }));
    const onOpenChange = vi.fn();
    const { rerender } = render(<FolderShareDialog folder={folder("f1", "First")} onOpenChange={onOpenChange} />);
    await waitFor(() => expect(screen.getByTestId("folder-link-access")).toBeEnabled());
    fireEvent.change(screen.getByTestId("folder-link-access"), { target: { value: "edit" } });
    await waitFor(() => expect(updateLinkAccess).toHaveBeenCalledExactlyOnceWith("f1", "edit"));
    rerender(<FolderShareDialog folder={{ ...folder("f2", "Second"), linkAccess: "comment" }} onOpenChange={onOpenChange} />);
    await waitFor(() => expect(screen.getByTestId("folder-link-access")).toHaveValue("comment"));
    await act(async () => finishPatch({ folder: { ...folder("f1", "First"), linkAccess: "edit" } }));
    expect(screen.getByTestId("folder-link-access")).toHaveValue("comment");
    expect(screen.getByTestId("folder-link-access")).toBeEnabled();
    expect(listFolderCollaborators.mock.calls).toEqual([["f1"], ["f2"]]);
  });

  it.each([
    { from: "private", to: "edit" },
    { from: "edit", to: "private" },
  ] as const)("ignores an older Add refresh after a confirmed $from -> $to link change", async ({ from, to }) => {
    const target = { ...folder("f1", "Refresh ordering"), linkAccess: from };
    const direct = { documentId: "budget", documentTitle: "Budget", role: "editor" as const, source: "collaborator" as const };
    const inherited = { documentId: "roadmap", documentTitle: "Roadmap", role: "editor" as const, source: "folder-link" as const };
    const people = { owner: null, collaborators: [person("bob", "viewer")] };
    const old = { ...people, linkAccess: from, exceptions: { bob: from === "edit" ? [direct, inherited] : [direct] } };
    const latest = { ...people, linkAccess: to, exceptions: { bob: to === "edit" ? [direct, inherited] : [direct] } };
    let finishOld!: (result: FolderPeople) => void;
    listFolderCollaborators.mockResolvedValueOnce({ owner: null, collaborators: [], linkAccess: from })
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue(latest);
    addFolderCollaborator.mockResolvedValue({ ok: true, login: "bob", role: "viewer", pending: false });
    updateLinkAccess.mockResolvedValue({ folder: { ...target, linkAccess: to } });
    render(<FolderShareDialog folder={target} onOpenChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("folder-link-access")).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "Role for new folder collaborator" }), { target: { value: "viewer" } });
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "bob" } });
    await waitFor(() => expect(screen.getByTestId("folder-share-add")).toBeEnabled());
    fireEvent.click(screen.getByTestId("folder-share-add"));
    await waitFor(() => expect(listFolderCollaborators).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByTestId("folder-link-access"), { target: { value: to } });
    await waitFor(() => expect(listFolderCollaborators).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByTestId("folder-link-access")).toBeEnabled());
    expect(screen.getByTestId("folder-link-access")).toHaveValue(to);

    await act(async () => finishOld(old));
    expect(screen.getByTestId("folder-link-access")).toHaveValue(to);
    expect(screen.getByText("@bob")).toBeVisible();
    expect(screen.getByTestId("folder-access-exceptions")).toHaveTextContent("Edit on Budget via direct document grant");
    if (to === "edit") expect(screen.getByTestId("folder-access-exceptions")).toHaveTextContent("Edit on Roadmap via folder link");
    else expect(screen.queryByText("Roadmap")).not.toBeInTheDocument();
    expect(addFolderCollaborator).toHaveBeenCalledExactlyOnceWith("f1", "bob", "viewer", undefined);
    expect(updateLinkAccess).toHaveBeenCalledExactlyOnceWith("f1", to);
  });

  it.each(["success", "failure"] as const)("keeps the latest refresh error when an older Add refresh finishes with $0", async (outcome) => {
    let finishOld!: () => void;
    listFolderCollaborators.mockResolvedValueOnce({ owner: null, collaborators: [], linkAccess: "private" })
      .mockImplementationOnce(() => new Promise((resolve, reject) => {
        finishOld = () => outcome === "success"
          ? resolve({ owner: null, collaborators: [person("bob", "editor")], linkAccess: "private" })
          : reject(new Error("Obsolete access error"));
      }))
      .mockRejectedValueOnce(new Error("Latest access refresh unavailable"))
      .mockResolvedValue({ owner: null, collaborators: [person("bob", "editor")], linkAccess: "view" });
    updateLinkAccess.mockResolvedValue({ folder: { ...folder("f1", "Refresh errors"), linkAccess: "view" } });
    render(<FolderShareDialog folder={folder("f1", "Refresh errors")} onOpenChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("folder-link-access")).toBeEnabled());
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "bob" } });
    fireEvent.click(screen.getByTestId("folder-share-add"));
    await waitFor(() => expect(listFolderCollaborators).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByTestId("folder-link-access"), { target: { value: "view" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Latest access refresh unavailable");
    await act(async () => finishOld());
    expect(screen.getByRole("alert")).toHaveTextContent("Latest access refresh unavailable");
    expect(screen.getByTestId("folder-link-access")).toHaveValue("view");
    expect(screen.getByTestId("folder-link-access")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("folder-link-access")).toBeEnabled());
    expect(screen.getByTestId("folder-link-access")).toHaveValue("view");
    expect(screen.getByText("@bob")).toBeVisible();
    expect(addFolderCollaborator).toHaveBeenCalledTimes(1);
    expect(updateLinkAccess).toHaveBeenCalledTimes(1);
  });

  it.each(["initial load", "Retry"] as const)("ignores an older $0 response after a newer collaborator refresh", async (load) => {
    let finishOld!: (result: FolderPeople) => void;
    if (load === "Retry") listFolderCollaborators.mockRejectedValueOnce(new Error("Initial access unavailable"));
    listFolderCollaborators.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue({ owner: null, collaborators: [person("bob", "editor")], linkAccess: "view" });
    render(<FolderShareDialog folder={folder("f1", "Load ordering")} onOpenChange={vi.fn()} />);
    if (load === "Retry") fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(listFolderCollaborators).toHaveBeenCalledTimes(load === "Retry" ? 2 : 1));
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "bob" } });
    fireEvent.click(screen.getByTestId("folder-share-add"));
    await waitFor(() => expect(listFolderCollaborators).toHaveBeenCalledTimes(load === "Retry" ? 3 : 2));
    expect(await screen.findByText("@bob")).toBeVisible();
    expect(screen.getByTestId("folder-link-access")).toBeEnabled();
    await act(async () => finishOld({ owner: null, collaborators: [], linkAccess: "private" }));
    expect(await screen.findByText("@bob")).toBeVisible();
    expect(screen.getByTestId("folder-link-access")).toHaveValue("view");
    expect(screen.getByTestId("folder-link-access")).toBeEnabled();
    expect(addFolderCollaborator).toHaveBeenCalledTimes(1);
  });

  it("does not restore a removed collaborator from an older Add refresh", async () => {
    let finishOld!: (result: FolderPeople) => void;
    listFolderCollaborators.mockResolvedValueOnce({ owner: null, collaborators: [person("bob", "viewer")], linkAccess: "private" })
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue({ owner: null, collaborators: [person("carol", "editor")], linkAccess: "private" });
    addFolderCollaborator.mockResolvedValue({ ok: true, login: "carol", role: "editor", pending: false });
    render(<FolderShareDialog folder={folder("f1", "Independent grants")} onOpenChange={vi.fn()} />);
    await screen.findByText("@bob");
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "carol" } });
    fireEvent.click(screen.getByTestId("folder-share-add"));
    await waitFor(() => expect(listFolderCollaborators).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Remove bob" }));
    await waitFor(() => expect(screen.queryByText("@bob")).not.toBeInTheDocument());
    await act(async () => finishOld({ owner: null, collaborators: [person("bob", "viewer"), person("carol", "editor")], linkAccess: "private" }));
    expect(screen.queryByText("@bob")).not.toBeInTheDocument();
    expect(await screen.findByText("@carol")).toBeVisible();
    expect(addFolderCollaborator).toHaveBeenCalledExactlyOnceWith("f1", "carol", "editor", undefined);
    expect(removeFolderCollaborator).toHaveBeenCalledExactlyOnceWith("f1", "bob");
  });

  it("lists the folders with their counts", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes", 2), folder("f2", "Travel", 0)] });
    await mount([doc("d1", "One")]);
    await waitFor(() => expect(screen.getAllByTestId("folder-chip")).toHaveLength(2));
    const [recipes, travel] = screen.getAllByTestId("folder-chip");
    expect(recipes).toHaveTextContent("Recipes");
    expect(recipes).toHaveTextContent("2");
    expect(travel).toHaveTextContent("Travel");
  });

  it("lists shared folders without offering owner actions", async () => {
    const shared = { ...folder("shared", "Planning", 1), ownerId: "alice", ownerName: "Alice", ownerLogin: "alice", role: "viewer" as const };
    listFolders.mockResolvedValue({ folders: [shared] });
    await mount([doc("shared-doc", "Roadmap", "shared", "alice")]);

    const chip = await screen.findByTestId("shared-folder-chip");
    expect(chip).toHaveTextContent("Planning");
    expect(chip).toHaveAttribute("title", "Shared by @alice · viewer");
    expect(screen.getAllByText("Shared with me")).toHaveLength(2);
    expect(screen.queryByTestId("folder-menu")).not.toBeInTheDocument();

    fireEvent.click(chip);
    expect(cardTitles()).toEqual(["Roadmap"]);
  });

  it("manages the roles on every document from an owner's folder menu", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes")] });
    listFolderCollaborators.mockResolvedValue({
      owner: { login: "owner", name: "Owner", image: null },
      collaborators: [person("bob", "viewer")],
    });
    await mount([]);

    openMenu(screen.getByTestId("folder-menu"));
    fireEvent.click(await screen.findByText("Share…"));
    expect(await screen.findByTestId("folder-share-dialog")).toBeInTheDocument();
    expect(screen.getByText("Everyone you add gets this role on every document in the folder, including new ones.")).toBeInTheDocument();
    expect(await screen.findByText("@bob")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Role for bob" }), { target: { value: "commenter" } });
    expect(addFolderCollaborator).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save folder role" })).toBeEnabled());
    listFolderCollaborators.mockResolvedValue({ owner: null, collaborators: [person("bob", "commenter")] });
    fireEvent.click(screen.getByRole("button", { name: "Save folder role" }));
    await waitFor(() => expect(addFolderCollaborator).toHaveBeenCalledWith("f1", "bob", "commenter", { change: true }));
    expect(screen.getByRole("combobox", { name: "Role for bob" })).toHaveValue("commenter");

    listFolderCollaborators.mockResolvedValue({ owner: null, collaborators: [] });
    fireEvent.click(screen.getByRole("button", { name: "Remove bob" }));
    await waitFor(() => expect(removeFolderCollaborator).toHaveBeenCalledWith("f1", "bob"));
    expect(screen.queryByText("@bob")).not.toBeInTheDocument();
  });

  it("clears a pending invitation note after removing that collaborator and reopening the dialog", async () => {
    const login = "dogfood-no-such-user-918273";
    const note = `@${login} gets access on their first sign-in. Check the spelling.`;
    const owner = { login: "owner", name: "Owner", image: null };
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes")] });
    listFolderCollaborators
      .mockResolvedValueOnce({ owner, collaborators: [] })
      .mockResolvedValueOnce({ owner, collaborators: [person(login, "editor")] });
    addFolderCollaborator.mockResolvedValue({ ok: true, login, role: "editor", pending: true });
    await mount([]);

    openMenu(screen.getByTestId("folder-menu"));
    fireEvent.click(await screen.findByText("Share…"));
    const shareDialog = await screen.findByTestId("folder-share-dialog");
    fireEvent.change(within(shareDialog).getByRole("combobox", { name: "GitHub handle" }), { target: { value: login } });
    fireEvent.click(within(shareDialog).getByRole("button", { name: "Add" }));
    expect(await screen.findByText(note)).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: `Remove ${login}` }));
    await waitFor(() => expect(screen.queryByText(note)).not.toBeInTheDocument());

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("folder-share-dialog")).not.toBeInTheDocument());
    openMenu(screen.getByTestId("folder-menu"));
    fireEvent.click(await screen.findByText("Share…"));
    expect(within(await screen.findByTestId("folder-share-dialog")).queryByText(note)).not.toBeInTheDocument();
  });

  it("counts only the owner's unfiled documents under 'Not in a folder'", async () => {
    await mount([
      doc("mine-unfiled", "Mine"),
      doc("mine-filed", "Filed", "f1"),
      // A document shared with this person is never in one of their folders, but it is not theirs
      // to file either, so it does not inflate the unfiled count.
      doc("theirs", "Theirs", null, "someone"),
    ]);
    expect(screen.getByTestId("folder-unfiled")).toHaveTextContent("1");
    expect(screen.getByTestId("filter-all")).toHaveTextContent("3");
  });

  it("keeps the shared keyboard focus outline on folder controls and sorting", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes")] });
    await mount([doc("d1", "Soup")]);
    await waitFor(() => expect(screen.getByTestId("folder-menu")).toBeInTheDocument());

    const controls = [
      screen.getByTestId("folder-unfiled"),
      screen.getByTestId("folder-chip"),
      screen.getByTestId("sort-select"),
    ];
    for (const control of controls) {
      expect(control).toHaveClass("focus-visible:border-accent");
      expect(control).not.toHaveClass("outline-none");
    }
    for (const control of [screen.getByTestId("folder-menu"), screen.getByTestId("new-folder")]) {
      expect(control).not.toHaveClass("outline-none");
    }
  });

  it("shows only that folder's documents once a chip is picked", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes", 1)] });
    await mount([doc("d1", "Soup", "f1"), doc("d2", "Loose")]);
    await waitFor(() => expect(screen.getAllByTestId("folder-chip")).toHaveLength(1));

    expect(cardTitles()).toEqual(expect.arrayContaining(["Soup", "Loose"]));
    fireEvent.click(screen.getByTestId("folder-chip"));
    expect(cardTitles()).toEqual(["Soup"]);

    fireEvent.click(screen.getByTestId("folder-unfiled"));
    expect(cardTitles()).toEqual(["Loose"]);

    fireEvent.click(screen.getByTestId("filter-all"));
    expect(cardTitles()).toHaveLength(2);
  });

  it("selects a newly created folder and explains how to add documents", async () => {
    createFolder.mockResolvedValue({ folder: folder("new", "Ideas") });
    await mount([doc("d1", "One"), doc("d2", "Two")]);

    fireEvent.click(screen.getByTestId("new-folder"));
    fireEvent.change(screen.getByTestId("folder-name-input"), { target: { value: "  Ideas  " } });
    fireEvent.submit(screen.getByTestId("folder-name-form"));

    await waitFor(() => expect(createFolder).toHaveBeenCalledWith("Ideas"));
    await waitFor(() => expect(screen.getByTestId("folder-chip")).toHaveTextContent("Ideas"));
    expect(screen.getByTestId("folder-chip")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("filter-all")).not.toHaveAttribute("aria-current");
    expect(cardTitles()).toEqual([]);
    expect(screen.getByTestId("empty-state")).toHaveTextContent("This folder is empty");
    expect(screen.getByTestId("empty-state")).toHaveTextContent(
      "Create a document, then move it here from its row menu, or drag an existing row onto this folder.",
    );
    expect(screen.getByTestId("empty-state")).not.toHaveTextContent("Try a different search");
  });

  it("will not submit a name that is only whitespace", async () => {
    await mount([]);
    fireEvent.click(screen.getByTestId("new-folder"));
    fireEvent.change(screen.getByTestId("folder-name-input"), { target: { value: "   " } });
    expect(screen.getByTestId("folder-name-submit")).toBeDisabled();
    expect(createFolder).not.toHaveBeenCalled();
  });

  it("renames a folder", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Old")] });
    renameFolder.mockResolvedValue({ folder: folder("f1", "New") });
    await mount([]);
    await waitFor(() => expect(screen.getByTestId("folder-menu")).toBeInTheDocument());

    openMenu(screen.getByTestId("folder-menu"));
    fireEvent.click(await screen.findByText("Rename…"));
    fireEvent.change(screen.getByTestId("folder-name-input"), { target: { value: "New" } });
    fireEvent.submit(screen.getByTestId("folder-name-form"));

    await waitFor(() => expect(renameFolder).toHaveBeenCalledWith("f1", "New"));
    await waitFor(() => expect(screen.getByTestId("folder-chip")).toHaveTextContent("New"));
  });

  it("says what deleting a folder does to its documents, and only deletes once confirmed", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Doomed", 3)] });
    deleteFolder.mockResolvedValue({ ok: true, trashed: 3 });
    await mount([]);
    await waitFor(() => expect(screen.getByTestId("folder-menu")).toBeInTheDocument());

    openMenu(screen.getByTestId("folder-menu"));
    fireEvent.click(await screen.findByText("Delete folder…"));
    expect(await screen.findByText(/3 documents go to the trash/)).toBeInTheDocument();
    expect(deleteFolder).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("delete-folder-submit"));
    await waitFor(() => expect(deleteFolder).toHaveBeenCalledWith("f1"));
    await waitFor(() => expect(screen.queryByTestId("folder-chip")).not.toBeInTheDocument());
  });

  it("keeps no folder marked as current in the trash", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes")] });
    await mount([doc("d1", "One")]);
    await waitFor(() => expect(screen.getAllByTestId("folder-chip")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("folder-chip"));
    expect(screen.getByTestId("folder-chip")).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByTestId("filter-trash"));
    expect(screen.getByTestId("folder-chip")).not.toHaveAttribute("aria-current");
  });
});

describe("moving a document from its card menu", () => {
  it("files it and shows it under the folder straight away", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes")] });
    moveDocuments.mockResolvedValue({ moved: ["d1"] });
    await mount([doc("d1", "Soup")]);
    await waitFor(() => expect(screen.getAllByTestId("folder-chip")).toHaveLength(1));

    openMenu(screen.getByTestId("document-menu"));
    fireEvent.click(await screen.findByTestId("move-to-folder"));
    await waitFor(() => expect(moveDocuments).toHaveBeenCalledWith(["d1"], "f1"));

    // The page was server-rendered with the old folder, so the move has to show from local state.
    fireEvent.click(screen.getByTestId("folder-chip"));
    await waitFor(() => expect(cardTitles()).toEqual(["Soup"]));
  });

  it("does not offer the folder the document is already in", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes")] });
    await mount([doc("d1", "Soup", "f1")]);
    await waitFor(() => expect(screen.getAllByTestId("folder-chip")).toHaveLength(1));

    openMenu(screen.getByTestId("document-menu"));
    expect(await screen.findByTestId("move-to-folder")).toHaveAttribute("data-disabled");
    expect(screen.getByTestId("move-to-top-level")).not.toHaveAttribute("data-disabled");
  });

  it("offers someone else's document only Open and Star, with no select box", async () => {
    await mount([doc("theirs", "Theirs", null, "someone")]);
    openMenu(screen.getByTestId("document-menu"));
    expect(await screen.findByText("Open")).toBeInTheDocument();
    expect(screen.queryByTestId("document-share")).not.toBeInTheDocument();
    expect(screen.queryByTestId("move-to-folder")).not.toBeInTheDocument();
    expect(screen.queryByTestId("document-delete")).not.toBeInTheDocument();
    expect(screen.queryByTestId("select-document")).not.toBeInTheDocument();
  });

  it("keeps Share in the document menu and off the row", async () => {
    await mount([doc("d1", "Soup")]);
    expect(screen.getByTestId("document-list")).not.toHaveTextContent("Share");
    openMenu(screen.getByTestId("document-menu"));
    expect(await screen.findByTestId("document-share")).toBeInTheDocument();
  });

  it("leaves the card alone when the server moved nothing", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes")] });
    moveDocuments.mockResolvedValue({ moved: [] });
    await mount([doc("d1", "Soup")]);
    await waitFor(() => expect(screen.getAllByTestId("folder-chip")).toHaveLength(1));

    openMenu(screen.getByTestId("document-menu"));
    fireEvent.click(await screen.findByTestId("move-to-folder"));
    await waitFor(() => expect(moveDocuments).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("folder-chip"));
    expect(cardTitles()).toEqual([]);
  });
});

describe("moving several documents at once", () => {
  it("moves the whole selection and then clears it", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes")] });
    moveDocuments.mockResolvedValue({ moved: ["d1", "d2"] });
    await mount([doc("d1", "One"), doc("d2", "Two"), doc("d3", "Three")]);
    await waitFor(() => expect(screen.getAllByTestId("folder-chip")).toHaveLength(1));

    const boxes = screen.getAllByTestId("select-document");
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    expect(screen.getByTestId("selection-bar")).toHaveTextContent("2 selected");

    openMenu(screen.getByTestId("selection-move"));
    fireEvent.click(await screen.findByTestId("move-to-folder"));

    await waitFor(() => expect(moveDocuments).toHaveBeenCalledWith(["d1", "d2"], "f1"));
    await waitFor(() => expect(screen.queryByTestId("selection-bar")).not.toBeInTheDocument());
  });

  it("offers every folder for a selection, since it may span folders", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes")] });
    await mount([doc("d1", "One", "f1"), doc("d2", "Two")]);
    await waitFor(() => expect(screen.getAllByTestId("folder-chip")).toHaveLength(1));

    for (const box of screen.getAllByTestId("select-document")) fireEvent.click(box);
    openMenu(screen.getByTestId("selection-move"));
    // Nothing is ticked off, because the two documents are not in the same place.
    expect(await screen.findByTestId("move-to-folder")).not.toHaveAttribute("data-disabled");
    expect(screen.getByTestId("move-to-top-level")).not.toHaveAttribute("data-disabled");
  });

  it("clears the selection on demand", async () => {
    await mount([doc("d1", "One")]);
    fireEvent.click(screen.getByTestId("select-document"));
    expect(screen.getByTestId("selection-bar")).toHaveTextContent("1 selected");
    fireEvent.click(screen.getByTestId("selection-clear"));
    expect(screen.queryByTestId("selection-bar")).not.toBeInTheDocument();
  });
});

describe("dragging cards onto a folder", () => {
  /** A DataTransfer good enough for jsdom, which does not implement one. */
  function transfer(): DataTransfer {
    const store = new Map<string, string>();
    return {
      setData: (type: string, value: string) => void store.set(type, value),
      getData: (type: string) => store.get(type) ?? "",
      get types() {
        return [...store.keys()];
      },
      dropEffect: "none",
      effectAllowed: "none",
    } as unknown as DataTransfer;
  }

  it("moves the dragged document into the folder it is dropped on", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes")] });
    moveDocuments.mockResolvedValue({ moved: ["d1"] });
    await mount([doc("d1", "Soup")]);
    await waitFor(() => expect(screen.getAllByTestId("folder-chip")).toHaveLength(1));

    const dataTransfer = transfer();
    const card = screen.getAllByTestId("document-card")[0].closest("li")!;
    fireEvent.dragStart(card, { dataTransfer });
    const chip = screen.getByTestId("folder-chip");
    fireEvent.dragOver(chip, { dataTransfer });
    fireEvent.drop(chip, { dataTransfer });

    await waitFor(() => expect(moveDocuments).toHaveBeenCalledWith(["d1"], "f1"));
  });

  it("takes the whole selection when a selected card is dragged", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes")] });
    moveDocuments.mockResolvedValue({ moved: ["d1", "d2"] });
    await mount([doc("d1", "One"), doc("d2", "Two")]);
    await waitFor(() => expect(screen.getAllByTestId("folder-chip")).toHaveLength(1));

    for (const box of screen.getAllByTestId("select-document")) fireEvent.click(box);
    const dataTransfer = transfer();
    fireEvent.dragStart(screen.getAllByTestId("document-card")[0].closest("li")!, { dataTransfer });
    fireEvent.drop(screen.getByTestId("folder-chip"), { dataTransfer });

    await waitFor(() => expect(moveDocuments).toHaveBeenCalledWith(["d1", "d2"], "f1"));
  });

  it("takes only the dragged card when it is not part of the selection", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes")] });
    moveDocuments.mockResolvedValue({ moved: ["d2"] });
    await mount([doc("d1", "One"), doc("d2", "Two")]);
    await waitFor(() => expect(screen.getAllByTestId("folder-chip")).toHaveLength(1));

    fireEvent.click(screen.getAllByTestId("select-document")[0]);
    const dataTransfer = transfer();
    fireEvent.dragStart(screen.getAllByTestId("document-card")[1].closest("li")!, { dataTransfer });
    fireEvent.drop(screen.getByTestId("folder-chip"), { dataTransfer });

    await waitFor(() => expect(moveDocuments).toHaveBeenCalledWith(["d2"], "f1"));
  });

  it("sends a document dropped on 'Not in a folder' back to the top level", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes", 1)] });
    moveDocuments.mockResolvedValue({ moved: ["d1"] });
    await mount([doc("d1", "Soup", "f1")]);
    await waitFor(() => expect(screen.getAllByTestId("folder-chip")).toHaveLength(1));

    const dataTransfer = transfer();
    fireEvent.dragStart(screen.getAllByTestId("document-card")[0].closest("li")!, { dataTransfer });
    fireEvent.drop(screen.getByTestId("folder-unfiled"), { dataTransfer });

    await waitFor(() => expect(moveDocuments).toHaveBeenCalledWith(["d1"], null));
  });

  it("ignores a drop that carries no documents, such as a file from the desktop", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes")] });
    await mount([doc("d1", "Soup")]);
    await waitFor(() => expect(screen.getAllByTestId("folder-chip")).toHaveLength(1));

    const dataTransfer = transfer();
    dataTransfer.setData("text/plain", "not a document");
    fireEvent.drop(screen.getByTestId("folder-chip"), { dataTransfer });

    expect(moveDocuments).not.toHaveBeenCalled();
  });

  it("does not let a document owned by someone else be dragged", async () => {
    await mount([doc("theirs", "Theirs", null, "someone")]);
    const card = screen.getAllByTestId("document-card")[0].closest("li")!;
    expect(card).not.toHaveAttribute("draggable", "true");
  });
});
