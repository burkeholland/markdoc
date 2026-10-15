// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentSummaryDto, FolderDto } from "@/lib/api";

type ListResponse = { folders: FolderDto[] };
type MoveResponse = { moved: string[] };

const listFolders = vi.fn<() => Promise<ListResponse>>();
const createFolder = vi.fn<(name: string) => Promise<{ folder: FolderDto }>>();
const renameFolder = vi.fn<(id: string, name: string) => Promise<{ folder: FolderDto }>>();
const deleteFolder = vi.fn<(id: string) => Promise<{ ok: true; trashed: number }>>();
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
        list: () => listFolders(),
        create: (name: string) => createFolder(name),
        rename: (id: string, name: string) => renameFolder(id, name),
        delete: (id: string) => deleteFolder(id),
      },
    },
  };
});

const { Dashboard } = await import("./dashboard");

const USER = { id: "owner", name: "Owner", login: "owner", image: null };

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
  };
}

function folder(id: string, name: string, documentCount = 0): FolderDto {
  return { id, name, documentCount, createdAt: "2026-09-01T12:00:00.000Z", updatedAt: "2026-09-01T12:00:00.000Z" };
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
  moveDocuments.mockReset();
  for (const fn of Object.values(router)) fn.mockReset();
});

afterEach(cleanup);

describe("the folder rail", () => {
  it("lists the folders with their counts", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes", 2), folder("f2", "Travel", 0)] });
    await mount([doc("d1", "One")]);
    await waitFor(() => expect(screen.getAllByTestId("folder-chip")).toHaveLength(2));
    const [recipes, travel] = screen.getAllByTestId("folder-chip");
    expect(recipes).toHaveTextContent("Recipes");
    expect(recipes).toHaveTextContent("2");
    expect(travel).toHaveTextContent("Travel");
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
    expect(screen.getByTestId("folder-all")).toHaveTextContent("3");
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

    fireEvent.click(screen.getByTestId("folder-all"));
    expect(cardTitles()).toHaveLength(2);
  });

  it("creates a folder from the dialog, trimming the name, and leaves the view where it was", async () => {
    createFolder.mockResolvedValue({ folder: folder("new", "Ideas") });
    await mount([doc("d1", "One"), doc("d2", "Two")]);

    fireEvent.click(screen.getByTestId("new-folder"));
    fireEvent.change(screen.getByTestId("folder-name-input"), { target: { value: "  Ideas  " } });
    fireEvent.submit(screen.getByTestId("folder-name-form"));

    await waitFor(() => expect(createFolder).toHaveBeenCalledWith("Ideas"));
    await waitFor(() => expect(screen.getByTestId("folder-chip")).toHaveTextContent("Ideas"));
    // The documents stay on screen: a folder is made in order to put things in it, and jumping into
    // the empty folder would replace the list with "No matches".
    expect(cardTitles()).toEqual(["One", "Two"]);
    expect(screen.getByTestId("folder-all")).toHaveAttribute("aria-pressed", "true");
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

  it("is out of the way in the trash", async () => {
    await mount([doc("d1", "One")]);
    expect(screen.getByTestId("folder-rail")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("filter-trash"));
    expect(screen.queryByTestId("folder-rail")).not.toBeInTheDocument();
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

  it("offers no menu on a document owned by someone else", async () => {
    await mount([doc("theirs", "Theirs", null, "someone")]);
    expect(screen.queryByTestId("document-menu")).not.toBeInTheDocument();
    expect(screen.queryByTestId("select-document")).not.toBeInTheDocument();
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
    expect(screen.getByTestId("selection-bar")).toHaveTextContent("2 documents selected");

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
    expect(screen.getByTestId("selection-bar")).toHaveTextContent("1 document selected");
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
