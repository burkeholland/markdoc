import { describe, expect, it, beforeAll } from "vitest";
import { eq, sql } from "drizzle-orm";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

describe("database", () => {
  let db: Awaited<ReturnType<typeof import("./index").getDb>>;
  let schema: typeof import("./schema");

  beforeAll(async () => {
    const mod = await import("./index");
    db = await mod.getDb();
    schema = mod.schema;
  });

  it("migrates and stores documents with binary state", async () => {
    const [user] = await db.insert(schema.users).values({ name: "Alice", login: "alice", email: "a@example.com" }).returning();
    const state = new Uint8Array([1, 2, 3, 250]);
    await db.insert(schema.documents).values({ id: "doc1", title: "Hello", ownerId: user.id, content: "# Hello", ystate: state });
    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, "doc1"));
    expect(doc.title).toBe("Hello");
    expect(Array.from(doc.ystate!)).toEqual([1, 2, 3, 250]);
    await db.insert(schema.versions).values({ id: "v1", documentId: "doc1", number: 1, content: "# Hello", kind: "auto" });
    const rows = await db.select().from(schema.versions).where(eq(schema.versions.documentId, "doc1"));
    expect(rows).toHaveLength(1);
  });

  it("returns the same instance for repeated calls", async () => {
    const mod = await import("./index");
    expect(await mod.getDb()).toBe(db);
  });

  it("indexes collaborator by login for login-first lookups", async () => {
    const rows = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where tablename = 'collaborator' and indexname = 'collaborator_login_idx'`,
    );
    const list = Array.isArray(rows) ? rows : rows.rows;
    expect(list).toHaveLength(1);
    expect(list[0].indexdef).toMatch(/\("login"\)|\(login\)/);
  });
});
