import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.BACKUP_TOKEN = "test-backup-token";
delete process.env.DATABASE_URL;

// The route only uses the HttpError/handler helpers, but `@/server/http` pulls in next-auth,
// which does not load outside a Next request. Stand in for it like the other route tests do.
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { createDocument } = await import("@/server/documents");
const { GET } = await import("./backup/route");

const call = (init?: RequestInit, query = "") => GET(new Request(`http://localhost:3700/api/admin/backup${query}`, init));

describe("GET /api/admin/backup", () => {
  beforeAll(async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Bob", login: "bob", email: "bob@example.com" }).returning();
    await createDocument({ ownerId: user.id, title: "Backed up", content: "# Backed up\n" });
    await createDocument({ ownerId: user.id, title: "Also backed up", content: "# Also\n" });
  });

  it("401 without a token, 401 with the wrong one", async () => {
    expect((await call()).status).toBe(401);
    expect((await call({ headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await call({ headers: { "x-backup-token": "test-backup-tokeN" } })).status).toBe(401);
  });

  it("503 when BACKUP_TOKEN is unset", async () => {
    const saved = process.env.BACKUP_TOKEN;
    delete process.env.BACKUP_TOKEN;
    try {
      expect((await call({ headers: { authorization: "Bearer " } })).status).toBe(503);
    } finally {
      process.env.BACKUP_TOKEN = saved;
    }
  });

  it("?meta=1 reports live document and user counts", async () => {
    const res = await call({ headers: { authorization: "Bearer test-backup-token" } }, "?meta=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: number; users: number };
    expect(body.documents).toBeGreaterThanOrEqual(2);
    expect(body.users).toBeGreaterThanOrEqual(1);
  });

  it("200 + gzip magic bytes with the token, and the tarball restores through loadDataDir", async () => {
    const res = await call({ headers: { "x-backup-token": "test-backup-token" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/gzip");
    expect(res.headers.get("Content-Disposition")).toContain("markdoc-pglite.tar.gz");
    const docsHeader = Number(res.headers.get("X-Markdoc-Documents"));
    expect(docsHeader).toBeGreaterThanOrEqual(2);

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(1024);
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);

    // The restore side: PGlite's own loader, which is what scripts/live/restore-data.mjs uses.
    const { PGlite } = await import("@electric-sql/pglite");
    const restored = new PGlite({ loadDataDir: new Blob([bytes], { type: "application/gzip" }) });
    await restored.waitReady;
    const rows = await restored.query<{ n: number }>('select count(*)::int as n from "document" where deleted_at is null');
    expect(rows.rows[0].n).toBe(docsHeader);
    const titles = await restored.query<{ title: string }>('select title from "document" order by title');
    expect(titles.rows.map((r) => r.title)).toEqual(["Also backed up", "Backed up"]);
    await restored.close();
  }, 60_000);
});
