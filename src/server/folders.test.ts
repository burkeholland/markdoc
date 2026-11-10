import { describe, expect, it, beforeAll, vi } from "vitest";

// deleteFolder trashes through deleteDocument, which evicts live editors via livedoc — and that
// registry pulls in the auth module. Same stubs as documents.test.ts.
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("./db");
const { createDocument, deleteDocument, getDocumentAccess, listDocumentsForUser, listTrashForUser, updateDocument, recordDocumentOpen } = await import("./documents");
const {
  addFolderCollaborator,
  boundFolderName,
  createFolder,
  deleteFolder,
  FOLDER_NAME_MAX,
  getFolderCollaboratorRole,
  getFolderForOwner,
  listFoldersForUser,
  moveDocumentsToFolder,
  removeFolderCollaborator,
  renameFolder,
  getFolderAccess,
  listDocumentsInFolder,
  setFolderLinkAccess,
  folderAccessExceptions,
} = await import("./folders");

let alice = "";
let bob = "";

async function newFolder(ownerId: string, name: string): Promise<string> {
  const result = await createFolder(ownerId, name);
  if (result.outcome !== "ok") throw new Error(`could not create folder: ${result.outcome}`);
  return result.folder.id;
}

async function newDoc(ownerId: string, title: string): Promise<string> {
  const doc = await createDocument({ ownerId, title, content: `# ${title}\n` });
  return doc.id;
}

beforeAll(async () => {
  const db = await getDb();
  const [a] = await db.insert(schema.users).values({ name: "Alice", login: "alice", email: "alice@example.com" }).returning();
  const [b] = await db.insert(schema.users).values({ name: "Bob", login: "bob", email: "bob@example.com" }).returning();
  alice = a.id;
  bob = b.id;
});

describe("boundFolderName", () => {
  it("trims and leaves an ordinary name alone", () => {
    expect(boundFolderName("  Recipes  ")).toBe("Recipes");
  });

  it("clips a long name to the bound", () => {
    expect(boundFolderName("x".repeat(FOLDER_NAME_MAX + 50))).toHaveLength(FOLDER_NAME_MAX);
  });

  it("does not cut a surrogate pair in half", () => {
    // An emoji straddling the bound is dropped whole, so the name stays valid text.
    const name = "a".repeat(FOLDER_NAME_MAX - 1) + "😀";
    const bounded = boundFolderName(name);
    expect(bounded).toBe("a".repeat(FOLDER_NAME_MAX - 1));
    expect([...bounded]).toHaveLength(FOLDER_NAME_MAX - 1);
  });
});

describe("creating folders", () => {
  it("creates one and reports it with a zero count", async () => {
    const id = await newFolder(alice, "Drafts");
    const folders = await listFoldersForUser(alice);
    expect(folders.find((f) => f.id === id)).toMatchObject({ name: "Drafts", documentCount: 0 });
  });

  it("refuses a name that is only whitespace", async () => {
    expect(await createFolder(alice, "   ")).toEqual({ outcome: "empty-name" });
  });

  it("refuses a duplicate name, ignoring case", async () => {
    await newFolder(alice, "Travel");
    expect(await createFolder(alice, "TRAVEL")).toEqual({ outcome: "duplicate-name" });
    expect(await createFolder(alice, "  travel  ")).toEqual({ outcome: "duplicate-name" });
  });

  it("lets a different owner reuse a name", async () => {
    await newFolder(alice, "Shared name");
    const result = await createFolder(bob, "Shared name");
    expect(result.outcome).toBe("ok");
  });
});

describe("renaming folders", () => {
  it("renames a folder its owner owns", async () => {
    const id = await newFolder(alice, "Old name");
    expect(await renameFolder(id, alice, "New name")).toMatchObject({ outcome: "ok" });
    expect((await getFolderForOwner(id, alice))?.name).toBe("New name");
  });

  it("accepts a rename to the name it already has", async () => {
    const id = await newFolder(alice, "Same name");
    expect(await renameFolder(id, alice, "Same name")).toMatchObject({ outcome: "ok" });
  });

  it("refuses a name another of this owner's folders already uses", async () => {
    await newFolder(alice, "Taken");
    const id = await newFolder(alice, "Free");
    expect(await renameFolder(id, alice, "taken")).toEqual({ outcome: "duplicate-name" });
  });

  it("reports not-found for someone else's folder, and leaves it alone", async () => {
    const id = await newFolder(alice, "Alice only");
    expect(await renameFolder(id, bob, "Bob's now")).toEqual({ outcome: "not-found" });
    expect((await getFolderForOwner(id, alice))?.name).toBe("Alice only");
  });
});

describe("sharing folders", () => {
  it("applies every folder link mode to current and future documents without globally discovering them", async () => {
    const folder = await newFolder(alice, "Link inheritance");
    const current = await newDoc(alice, "Link current");
    const bobUser = { id: bob, login: "bob", name: "Bob", image: null };
    await moveDocumentsToFolder([current], folder, alice);
    for (const [mode, role] of [["view", "viewer"], ["comment", "commenter"], ["edit", "editor"]] as const) {
      await setFolderLinkAccess(folder, alice, mode);
      expect(await getFolderAccess(folder, null)).toMatchObject({ role: "viewer" });
      expect(await getFolderAccess(folder, bobUser)).toMatchObject({ role });
      expect(await getDocumentAccess(current, null)).toMatchObject({ role: "viewer", source: "folder-link" });
      expect(await getDocumentAccess(current, bobUser)).toMatchObject({ role, source: "folder-link" });
      expect(await listDocumentsInFolder(folder, bobUser)).toContainEqual(expect.objectContaining({ id: current, role, source: "folder-link" }));
    }
    expect((await listFoldersForUser(bob, "bob")).some((item) => item.id === folder)).toBe(false);
    expect((await listDocumentsForUser(bobUser)).some((item) => item.id === current)).toBe(false);
    await recordDocumentOpen(bob, current);
    expect((await listDocumentsForUser(bobUser)).find((item) => item.id === current)).toMatchObject({ role: "editor", folderId: folder, folderName: "Link inheritance" });
    const future = await newDoc(alice, "Link future");
    await moveDocumentsToFolder([future], folder, alice);
    expect(await getDocumentAccess(future, bobUser)).toMatchObject({ role: "editor", source: "folder-link" });
    await moveDocumentsToFolder([current], null, alice);
    expect(await getDocumentAccess(current, bobUser)).toBeNull();
    expect((await listDocumentsForUser(bobUser)).some((item) => item.id === current)).toBe(false);
    await setFolderLinkAccess(folder, alice, "private");
    expect(await getFolderAccess(folder, bobUser)).toBeNull();
    expect(await getDocumentAccess(future, bobUser)).toBeNull();
  });

  it("matches SQL and direct resolution for the highest explicit and link grants, retaining direct access after revocation", async () => {
    const folder = await newFolder(alice, "Highest links");
    const direct = await newDoc(alice, "Budget");
    const documentLink = await newDoc(alice, "Roadmap");
    const inherited = await newDoc(alice, "Notes");
    await moveDocumentsToFolder([direct, documentLink, inherited], folder, alice);
    const db = await getDb();
    await db.insert(schema.collaborators).values({ documentId: direct, login: "bob", role: "editor" });
    await updateDocument(documentLink, { linkAccess: "edit" });
    await addFolderCollaborator(folder, "bob", "viewer", alice);
    await setFolderLinkAccess(folder, alice, "comment");
    const bobUser = { id: bob, login: "bob", name: "Bob", image: null };
    for (const [id, role, source] of [[direct, "editor", "collaborator"], [documentLink, "editor", "link"], [inherited, "commenter", "folder-link"]] as const) {
      expect(await getDocumentAccess(id, bobUser)).toMatchObject({ role, source });
      expect((await listDocumentsInFolder(folder, bobUser)).find((item) => item.id === id)).toMatchObject({ role, source });
      expect((await listDocumentsForUser(bobUser)).find((item) => item.id === id)).toMatchObject({ role });
    }
    const ownerFolder = await getFolderForOwner(folder, alice);
    expect(await folderAccessExceptions(ownerFolder!, [{ login: "@BOB", role: "viewer" }])).toEqual({
      bob: [
        { documentId: direct, documentTitle: "Budget", role: "editor", source: "collaborator" },
        { documentId: inherited, documentTitle: "Notes", role: "commenter", source: "folder-link" },
        { documentId: documentLink, documentTitle: "Roadmap", role: "editor", source: "link" },
      ],
    });
    await setFolderLinkAccess(folder, alice, "private");
    await removeFolderCollaborator(folder, "bob");
    expect(await getDocumentAccess(direct, bobUser)).toMatchObject({ role: "editor", source: "collaborator" });
    expect(await getDocumentAccess(documentLink, bobUser)).toMatchObject({ role: "editor", source: "link" });
    expect(await getDocumentAccess(inherited, bobUser)).toBeNull();
    expect(await getFolderAccess(folder, bobUser)).toBeNull();
    expect((await listDocumentsForUser(bobUser)).find((item) => item.id === direct)).toMatchObject({ folderId: null, folderName: null });
  });

  it("grants access to current and future documents, and moving a document out revokes it", async () => {
    const folder = await newFolder(alice, "Shared work");
    const current = await newDoc(alice, "Current");
    await moveDocumentsToFolder([current], folder, alice);
    expect(await addFolderCollaborator(folder, " @BOB ", "commenter", alice)).toEqual({ outcome: "written" });
    const bobUser = { id: bob, login: "bob", name: "Bob", image: null };

    expect(await getFolderCollaboratorRole(folder, "bob")).toBe("commenter");
    expect(await getDocumentAccess(current, bobUser)).toMatchObject({ role: "commenter", source: "folder" });
    expect((await listFoldersForUser(bob, "bob")).find((item) => item.id === folder)).toMatchObject({
      ownerId: alice,
      ownerLogin: "alice",
      role: "commenter",
      documentCount: 1,
    });
    expect((await listDocumentsForUser(bobUser)).find((item) => item.id === current)).toMatchObject({
      role: "commenter",
      folderId: folder,
      folderName: "Shared work",
    });

    const future = await newDoc(alice, "Future");
    await moveDocumentsToFolder([future], folder, alice);
    expect(await getDocumentAccess(future, bobUser)).toMatchObject({ role: "commenter", source: "folder" });

    await moveDocumentsToFolder([current], null, alice);
    expect(await getDocumentAccess(current, bobUser)).toBeNull();
    expect((await listDocumentsForUser(bobUser)).some((item) => item.id === current)).toBe(false);
    expect((await listDocumentsForUser(bobUser)).find((item) => item.id === future)?.folderName).toBe("Shared work");
  });

  it("keeps the strongest direct role, and does not expose a folder to direct-only collaborators", async () => {
    const folder = await newFolder(alice, "Folder role isolation");
    const inFolder = await newDoc(alice, "In folder");
    const folderStronger = await newDoc(alice, "Folder role is stronger");
    const directOnly = await newDoc(alice, "Direct only");
    await moveDocumentsToFolder([inFolder, folderStronger], folder, alice);
    await updateDocument(directOnly, { linkAccess: "edit" });
    const db = await getDb();
    await db.insert(schema.collaborators).values([
      { documentId: inFolder, login: "bob", role: "editor" },
      { documentId: folderStronger, login: "bob", role: "viewer" },
      { documentId: directOnly, login: "bob", role: "viewer" },
    ]);
    await addFolderCollaborator(folder, "bob", "commenter", alice);

    expect(await getDocumentAccess(inFolder, { id: bob, login: "bob" })).toMatchObject({ role: "editor", source: "collaborator" });
    expect(await getDocumentAccess(folderStronger, { id: bob, login: "bob" })).toMatchObject({ role: "commenter", source: "folder" });
    expect(await getDocumentAccess(directOnly, { id: bob, login: "bob" })).toMatchObject({ role: "editor", source: "link" });
    const summaries = await listDocumentsForUser({ id: bob, login: "bob", name: "Bob", image: null });
    expect(summaries.find((item) => item.id === inFolder)).toMatchObject({ folderId: folder, folderName: "Folder role isolation" });
    expect(summaries.find((item) => item.id === folderStronger)).toMatchObject({ role: "commenter", folderId: folder, folderName: "Folder role isolation" });
    expect(summaries.find((item) => item.id === directOnly)).toMatchObject({ folderId: null, folderName: null });

    expect(await addFolderCollaborator(folder, "bob", "editor", alice)).toEqual({ outcome: "refused", role: "commenter" });
    expect(await addFolderCollaborator(folder, "bob", "editor", alice, { change: true })).toEqual({ outcome: "written" });
    expect(await getDocumentAccess(inFolder, { id: bob, login: "bob" })).toMatchObject({ role: "editor", source: "collaborator" });
    expect(await getDocumentAccess(folderStronger, { id: bob, login: "bob" })).toMatchObject({ role: "editor", source: "folder" });
    expect(await removeFolderCollaborator(folder, "bob")).toBe(true);
    expect(await getDocumentAccess(inFolder, { id: bob, login: "bob" })).toMatchObject({ role: "editor", source: "collaborator" });
    expect(await getDocumentAccess(folderStronger, { id: bob, login: "bob" })).toMatchObject({ role: "viewer", source: "collaborator" });
    const afterRemoval = await listDocumentsForUser({ id: bob, login: "bob", name: "Bob", image: null });
    expect(afterRemoval.find((item) => item.id === inFolder)).toMatchObject({ folderId: null, folderName: null });
    expect(afterRemoval.find((item) => item.id === folderStronger)).toMatchObject({ folderId: null, folderName: null });
  });
});

describe("moving documents", () => {
  it("files a document and counts it", async () => {
    const folder = await newFolder(alice, "Counting");
    const doc = await newDoc(alice, "Filed");
    expect(await moveDocumentsToFolder([doc], folder, alice)).toEqual({ outcome: "ok", moved: [doc] });
    const folders = await listFoldersForUser(alice);
    expect(folders.find((f) => f.id === folder)?.documentCount).toBe(1);
  });

  it("moves several at once and back to the top level", async () => {
    const folder = await newFolder(alice, "Batch");
    const docs = [await newDoc(alice, "One"), await newDoc(alice, "Two"), await newDoc(alice, "Three")];
    const into = await moveDocumentsToFolder(docs, folder, alice);
    expect(into.outcome === "ok" && into.moved.sort()).toEqual([...docs].sort());

    const out = await moveDocumentsToFolder(docs, null, alice);
    expect(out.outcome === "ok" && out.moved.sort()).toEqual([...docs].sort());
    const folders = await listFoldersForUser(alice);
    expect(folders.find((f) => f.id === folder)?.documentCount).toBe(0);
  });

  it("skips a document owned by someone else rather than refusing the whole move", async () => {
    const folder = await newFolder(alice, "Mixed");
    const mine = await newDoc(alice, "Mine");
    const theirs = await newDoc(bob, "Theirs");
    expect(await moveDocumentsToFolder([mine, theirs], folder, alice)).toEqual({ outcome: "ok", moved: [mine] });
    // Bob's document is untouched, and still at his top level.
    const bobDocs = await listDocumentsForUser({ id: bob, login: "bob", name: "Bob", image: null });
    expect(bobDocs.find((d) => d.id === theirs)?.folderId).toBeNull();
  });

  it("skips a trashed document", async () => {
    const folder = await newFolder(alice, "No trash");
    const doc = await newDoc(alice, "Gone");
    await deleteDocument(doc);
    expect(await moveDocumentsToFolder([doc], folder, alice)).toEqual({ outcome: "ok", moved: [] });
  });

  it("refuses a folder the caller does not own", async () => {
    const bobsFolder = await newFolder(bob, "Bob's folder");
    const doc = await newDoc(alice, "Alice's doc");
    expect(await moveDocumentsToFolder([doc], bobsFolder, alice)).toEqual({ outcome: "no-folder" });
  });

  it("refuses an unknown folder id", async () => {
    const doc = await newDoc(alice, "Nowhere");
    expect(await moveDocumentsToFolder([doc], "nosuchfolder", alice)).toEqual({ outcome: "no-folder" });
  });

  it("accepts an empty list without touching anything", async () => {
    expect(await moveDocumentsToFolder([], null, alice)).toEqual({ outcome: "ok", moved: [] });
  });
});

describe("deleting a folder", () => {
  it("sends its documents to the trash and removes the folder", async () => {
    const folder = await newFolder(alice, "Doomed");
    const docs = [await newDoc(alice, "A"), await newDoc(alice, "B")];
    await moveDocumentsToFolder(docs, folder, alice);

    expect(await deleteFolder(folder, alice)).toBe(2);
    expect(await getFolderForOwner(folder, alice)).toBeNull();

    const trashed = await listTrashForUser({ id: alice, login: "alice", name: "Alice", image: null });
    for (const id of docs) expect(trashed.some((d) => d.id === id)).toBe(true);
    // And they are gone from the live list, rather than sitting at the top level.
    const live = await listDocumentsForUser({ id: alice, login: "alice", name: "Alice", image: null });
    for (const id of docs) expect(live.some((d) => d.id === id)).toBe(false);
  });

  it("deletes an empty folder and reports nothing trashed", async () => {
    const folder = await newFolder(alice, "Empty");
    expect(await deleteFolder(folder, alice)).toBe(0);
  });

  it("refuses someone else's folder and leaves its documents alone", async () => {
    const folder = await newFolder(alice, "Not yours");
    const doc = await newDoc(alice, "Still here");
    await moveDocumentsToFolder([doc], folder, alice);

    expect(await deleteFolder(folder, bob)).toBeNull();
    expect(await getFolderForOwner(folder, alice)).not.toBeNull();
    const live = await listDocumentsForUser({ id: alice, login: "alice", name: "Alice", image: null });
    expect(live.find((d) => d.id === doc)?.folderId).toBe(folder);
  });

  it("frees the name, so the same one can be used again", async () => {
    const first = await newFolder(alice, "Reusable");
    await deleteFolder(first, alice);
    const again = await createFolder(alice, "Reusable");
    expect(again.outcome).toBe("ok");
  });
});

describe("folderId on a document summary", () => {
  it("is reported to the owner but not to a collaborator", async () => {
    const folder = await newFolder(alice, "Private filing");
    const doc = await newDoc(alice, "Shared doc");
    await moveDocumentsToFolder([doc], folder, alice);
    const db = await getDb();
    await db.insert(schema.collaborators).values({ documentId: doc, login: "bob", role: "editor" });

    const forAlice = await listDocumentsForUser({ id: alice, login: "alice", name: "Alice", image: null });
    expect(forAlice.find((d) => d.id === doc)?.folderId).toBe(folder);

    // Bob can see the document, but which of Alice's folders it sits in is none of his business.
    const forBob = await listDocumentsForUser({ id: bob, login: "bob", name: "Bob", image: null });
    expect(forBob.find((d) => d.id === doc)?.folderId).toBeNull();
  });
});
