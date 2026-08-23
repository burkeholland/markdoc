import { describe, expect, it, beforeAll } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("@/server/db");
const { eq } = await import("drizzle-orm");
const { createDocument, isStarred, listDocumentsForUser, recordDocumentOpen, searchDocumentsForUser, starDocument, unstarDocument, upsertCollaborator } = await import(
  "@/server/documents"
);
type SessionUser = import("@/server/documents").SessionUser;

let alice: SessionUser;
let bob: SessionUser;

beforeAll(async () => {
  const db = await getDb();
  const [a] = await db.insert(schema.users).values({ name: "Alice", login: "alice", email: "alice-stars@example.com" }).returning();
  const [b] = await db.insert(schema.users).values({ name: "Bob", login: "bob", email: "bob-stars@example.com" }).returning();
  alice = { id: a.id, login: "alice", name: "Alice" };
  bob = { id: b.id, login: "bob", name: "Bob" };
});

const idsOf = (docs: { id: string }[]) => docs.map((d) => d.id);

describe("stars", () => {
  it("star and unstar are idempotent", async () => {
    const doc = await createDocument({ ownerId: alice.id, title: "Starry" });
    expect(await isStarred(alice.id, doc.id)).toBe(false);
    await starDocument(alice.id, doc.id);
    await starDocument(alice.id, doc.id);
    expect(await isStarred(alice.id, doc.id)).toBe(true);
    await unstarDocument(alice.id, doc.id);
    await unstarDocument(alice.id, doc.id);
    expect(await isStarred(alice.id, doc.id)).toBe(false);
  });

  it("shows the starred flag only to the user who starred, in list and search", async () => {
    const doc = await createDocument({ ownerId: alice.id, title: "Shared quasar notes", content: "# Shared quasar notes\n\nbody" });
    await upsertCollaborator(doc.id, "bob", "viewer", alice.id);
    await starDocument(bob.id, doc.id);

    const forBob = (await listDocumentsForUser(bob)).find((d) => d.id === doc.id);
    const forAlice = (await listDocumentsForUser(alice)).find((d) => d.id === doc.id);
    expect(forBob?.starred).toBe(true);
    expect(forAlice?.starred).toBe(false);

    const searchBob = await searchDocumentsForUser(bob, "quasar");
    const searchAlice = await searchDocumentsForUser(alice, "quasar");
    expect(searchBob.find((d) => d.id === doc.id)?.starred).toBe(true);
    expect(searchAlice.find((d) => d.id === doc.id)?.starred).toBe(false);
  });

  it("lists only starred documents when asked", async () => {
    const starred = await createDocument({ ownerId: alice.id, title: "Keep" });
    await createDocument({ ownerId: alice.id, title: "Drop" });
    await starDocument(alice.id, starred.id);
    const docs = await listDocumentsForUser(alice, { starred: true });
    expect(idsOf(docs)).toContain(starred.id);
    expect(docs.every((d) => d.starred)).toBe(true);
  });
});

describe("recents", () => {
  it("upserts opened_at per user and document", async () => {
    const doc = await createDocument({ ownerId: alice.id, title: "Opened" });
    const first = new Date("2026-01-01T10:00:00Z");
    const second = new Date("2026-01-02T10:00:00Z");
    await recordDocumentOpen(alice.id, doc.id, first);
    expect((await listDocumentsForUser(alice)).find((d) => d.id === doc.id)?.lastOpenedAt?.toISOString()).toBe(first.toISOString());
    await recordDocumentOpen(alice.id, doc.id, second);
    const rows = await (await getDb()).select().from(schema.recents);
    expect(rows.filter((r) => r.userId === alice.id && r.documentId === doc.id)).toHaveLength(1);
    expect((await listDocumentsForUser(alice)).find((d) => d.id === doc.id)?.lastOpenedAt?.toISOString()).toBe(second.toISOString());
    // Bob never opened it.
    await upsertCollaborator(doc.id, "bob", "viewer", alice.id);
    expect((await listDocumentsForUser(bob)).find((d) => d.id === doc.id)?.lastOpenedAt).toBeNull();
  });

  it("sorts by lastOpenedAt desc with never-opened documents last (by updatedAt)", async () => {
    const db = await getDb();
    const [c] = await db.insert(schema.users).values({ name: "Cara", login: "cara", email: "cara-stars@example.com" }).returning();
    const cara: SessionUser = { id: c.id, login: "cara", name: "Cara" };
    const older = await createDocument({ ownerId: cara.id, title: "Never opened, older" });
    const newer = await createDocument({ ownerId: cara.id, title: "Never opened, newer" });
    const openedEarly = await createDocument({ ownerId: cara.id, title: "Opened early" });
    const openedLate = await createDocument({ ownerId: cara.id, title: "Opened late" });
    await db.update(schema.documents).set({ updatedAt: new Date("2026-03-01T00:00:00Z") }).where(eq(schema.documents.id, older.id));
    await db.update(schema.documents).set({ updatedAt: new Date("2026-03-02T00:00:00Z") }).where(eq(schema.documents.id, newer.id));
    await recordDocumentOpen(cara.id, openedEarly.id, new Date("2026-02-01T00:00:00Z"));
    await recordDocumentOpen(cara.id, openedLate.id, new Date("2026-02-05T00:00:00Z"));

    const docs = await listDocumentsForUser(cara);
    expect(idsOf(docs)).toEqual([openedLate.id, openedEarly.id, newer.id, older.id]);
  });
});
