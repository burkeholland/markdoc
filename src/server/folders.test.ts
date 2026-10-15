import { describe, expect, it, beforeAll, vi } from "vitest";

// deleteFolder trashes through deleteDocument, which evicts live editors via livedoc — and that
// registry pulls in the auth module. Same stubs as documents.test.ts.
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("./db");
const { createDocument, deleteDocument, listDocumentsForUser, listTrashForUser } = await import("./documents");
const {
  boundFolderName,
  createFolder,
  deleteFolder,
  FOLDER_NAME_MAX,
  getFolderForOwner,
  listFoldersForUser,
  moveDocumentsToFolder,
  renameFolder,
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
