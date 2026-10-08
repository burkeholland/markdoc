import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { createDocument } = await import("@/server/documents");
const { createCollabServer, shutdownCollab, withDocument } = await import("./hocuspocus");

/**
 * After a store the server asks, one turn of the event loop later, to unload the copy of the document it
 * stored. A write that had no connected editor has unloaded that copy itself by then. When the next write
 * has loaded the document again before that turn came, the late request used to find a document of that
 * NAME, remove it from the server and forget how to store it: the write that was using the new copy was
 * lost and answered `500` ("Document persistence is not initialized").
 *
 * On main the event loop never turned between loading and storing on the embedded database, so the late
 * request came after everything. A write now steps aside after loading a large document (#2341), and the
 * turn can come exactly there.
 */
describe("a late unload of an old copy of a document", () => {
  let hocuspocus: ReturnType<typeof createCollabServer>;
  let userId: string;
  const context = (docId: string) => ({ userId, docId, role: "editor" as const, name: "Ann", login: "ann-stale", avatar: null });

  beforeAll(async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Ann", login: "ann-stale", email: "ann-stale@example.com" }).returning();
    userId = user.id;
    hocuspocus = createCollabServer();
  });

  afterAll(async () => {
    await shutdownCollab(hocuspocus);
  });

  /** What the stored document holds under `key` of its `marks` map. */
  async function stored(docId: string, key: string): Promise<unknown> {
    const db = await getDb();
    const [row] = await db.select({ ystate: schema.documents.ystate }).from(schema.documents).where(eq(schema.documents.id, docId));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row.ystate!);
    return doc.getMap("marks").get(key);
  }

  it("does not remove the copy the next write has loaded: that write is stored", async () => {
    const doc = await createDocument({ ownerId: userId, content: "# Title\n\nA paragraph.\n" });
    const ctx = context(doc.id);

    // The first write: loaded, changed, stored and unloaded without the event loop turning in between
    // (the embedded database answers in this thread). Its store leaves the late unload request behind.
    const first = await hocuspocus.openDirectConnection(doc.id, ctx);
    await first.transact((live) => void live.getMap("marks").set("first", 1));
    await first.disconnect();
    expect(hocuspocus.documents.has(doc.id)).toBe(false);

    // The second write loads the document again, then steps aside as after loading a large document.
    const second = await hocuspocus.openDirectConnection(doc.id, ctx);
    const loaded = hocuspocus.documents.get(doc.id);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(hocuspocus.documents.get(doc.id)).toBe(loaded);

    await second.transact((live) => void live.getMap("marks").set("second", 2));
    await second.disconnect();
    expect(await stored(doc.id, "first")).toBe(1);
    expect(await stored(doc.id, "second")).toBe(2);
  });

  it("two writes through withDocument, back to back, are both stored", async () => {
    const doc = await createDocument({ ownerId: userId, content: "# Title\n\nA paragraph.\n" });
    const ctx = context(doc.id);
    await withDocument(hocuspocus, doc.id, ctx, (live) => void live.getMap("marks").set("first", 1));
    await withDocument(hocuspocus, doc.id, ctx, (live) => void live.getMap("marks").set("second", 2));
    expect(await stored(doc.id, "first")).toBe(1);
    expect(await stored(doc.id, "second")).toBe(2);
  });
});
