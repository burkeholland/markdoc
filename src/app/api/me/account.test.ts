import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { unzipSync, strFromU8 } from "fflate";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.RATE_LIMIT = "off";
delete process.env.DATABASE_URL;

type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
let requestHeaders = new Headers();
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("@/server/session-cookie", () => ({ decodeEmbedSession: async () => null }));

const { getDb, schema } = await import("@/server/db");
const { createDocument } = await import("@/server/documents");
const { createFolder, moveDocumentsToFolder } = await import("@/server/folders");
const { createApiToken } = await import("@/server/tokens");
const { exportPaths, sanitizePathSegment } = await import("@/server/account");
const me = await import("@/app/api/me/route");
const exportAll = await import("@/app/api/me/export/route");

let sequence = 0;
async function makeUser(login = `account-user-${++sequence}`): Promise<Actor> {
  const db = await getDb();
  const [row] = await db.insert(schema.users).values({ login, name: "Person", email: `${login}@example.com` }).returning();
  return { id: row.id, login: row.login!, name: row.name!, image: null };
}

const del = (body: unknown) =>
  me.DELETE(new Request("http://localhost:3700/api/me", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  actor = null;
  requestHeaders = new Headers();
});

describe("export paths", () => {
  it("sanitizes names and keeps them unique case-insensitively", () => {
    expect(sanitizePathSegment('a/b:c*?"<>|', "x")).toBe("abc");
    expect(sanitizePathSegment("  ..  ", "Untitled")).toBe("Untitled");
    expect(sanitizePathSegment("CON", "x")).toBe("CON_");
    expect(exportPaths([
      { title: "Notes", folder: null },
      { title: "notes", folder: null },
      { title: "Notes", folder: "Work/Q1" },
      { title: "", folder: null },
    ])).toEqual(["Notes.md", "notes (2).md", "WorkQ1/Notes.md", "Untitled.md"]);
  });
});

describe("GET /api/me/export", () => {
  it("requires sign-in", async () => {
    expect((await exportAll.GET()).status).toBe(401);
  });

  it("zips the caller's own non-trashed documents with folders as directories", async () => {
    actor = await makeUser();
    const someoneElse = await makeUser();
    const a = await createDocument({ ownerId: actor.id, title: "Alpha", content: "# Alpha\n" });
    const b = await createDocument({ ownerId: actor.id, title: "Beta", content: "beta body\n" });
    const trashed = await createDocument({ ownerId: actor.id, title: "Gone", content: "gone\n" });
    await createDocument({ ownerId: someoneElse.id, title: "Theirs", content: "theirs\n" });
    const db = await getDb();
    await db.update(schema.documents).set({ deletedAt: new Date() }).where(eq(schema.documents.id, trashed.id));
    const folder = await createFolder(actor.id, "Work");
    if (folder.outcome !== "ok") throw new Error("folder not created");
    await moveDocumentsToFolder([b.id], folder.folder.id, actor.id);

    const res = await exportAll.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="markdoc-export-\d{4}-\d{2}-\d{2}\.zip"$/);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["Alpha.md", "Work/Beta.md"]);
    expect(strFromU8(files["Alpha.md"])).toContain("# Alpha");
    expect(strFromU8(files["Work/Beta.md"])).toContain("beta body");
    expect(a.id).toBeTruthy();
  });

  it("refuses API-token callers", async () => {
    const owner = await makeUser();
    const { token } = await createApiToken(owner.id, "Script");
    requestHeaders = new Headers({ authorization: `Bearer ${token}` });
    const res = await exportAll.GET();
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/me", () => {
  it("requires the login typed as confirmation", async () => {
    actor = await makeUser();
    expect((await del({})).status).toBe(400);
    expect((await del({ confirm: "someone-else" })).status).toBe(400);
    const db = await getDb();
    expect(await db.select().from(schema.users).where(eq(schema.users.id, actor.id))).toHaveLength(1);
  });

  it("deletes the user, their documents and login-keyed rows", async () => {
    actor = await makeUser();
    const other = await makeUser();
    const mine = await createDocument({ ownerId: actor.id, title: "Mine", content: "x" });
    const theirs = await createDocument({ ownerId: other.id, title: "Theirs", content: "y" });
    const db = await getDb();
    await db.insert(schema.collaborators).values({ documentId: theirs.id, login: actor.login.toUpperCase(), role: "editor" });
    await db.insert(schema.notifications).values({ id: `n-${sequence}`, userLogin: actor.login, documentId: theirs.id, kind: "share", refId: theirs.id });

    const res = await del({ confirm: ` ${actor.login.toUpperCase()} ` });
    expect(res.status).toBe(200);
    expect(await db.select().from(schema.users).where(eq(schema.users.id, actor.id))).toHaveLength(0);
    expect(await db.select().from(schema.documents).where(eq(schema.documents.id, mine.id))).toHaveLength(0);
    expect(await db.select().from(schema.documents).where(eq(schema.documents.id, theirs.id))).toHaveLength(1);
    expect(await db.select().from(schema.collaborators).where(eq(schema.collaborators.documentId, theirs.id))).toHaveLength(0);
    expect(await db.select().from(schema.notifications).where(eq(schema.notifications.userLogin, actor.login))).toHaveLength(0);
  });

  it("refuses the shared demo account", async () => {
    actor = await makeUser("markdoc-demo");
    const res = await del({ confirm: "markdoc-demo" });
    expect(res.status).toBe(403);
  });

  it("refuses API-token callers even with the right confirmation", async () => {
    const owner = await makeUser();
    const { token } = await createApiToken(owner.id, "Script");
    requestHeaders = new Headers({ authorization: `Bearer ${token}` });
    const res = await me.DELETE(new Request("http://localhost:3700/api/me", {
      method: "DELETE", headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ confirm: owner.login }),
    }));
    expect(res.status).toBe(403);
    const db = await getDb();
    expect(await db.select().from(schema.users).where(eq(schema.users.id, owner.id))).toHaveLength(1);
  });

  it("refuses cross-site requests", async () => {
    actor = await makeUser();
    const res = await me.DELETE(new Request("http://localhost:3700/api/me", {
      method: "DELETE", headers: { "Content-Type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ confirm: actor.login }),
    }));
    expect(res.status).toBe(403);
  });
});
