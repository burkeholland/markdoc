import { describe, expect, it, beforeAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Same stand-ins as star.test.ts: the routes resolve the caller through next-auth and `next/headers`.
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { createDocument, listCollaborators, removeCollaborator, upsertCollaborator } = await import("@/server/documents");
const { DELETE } = await import("./[id]/collaborators/route");

let owner: Actor;
let docId: string;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const del = (login: string) =>
  DELETE(
    new Request(`http://localhost:3700/api/documents/${docId}/collaborators`, {
      method: "DELETE",
      body: JSON.stringify({ login }),
      headers: { "Content-Type": "application/json" },
    }),
    params(docId),
  );
const shareRemovals = async () => {
  const db = await getDb();
  return db
    .select()
    .from(schema.activity)
    .where(and(eq(schema.activity.documentId, docId), eq(schema.activity.action, "share.remove")));
};
const notificationsFor = async (login: string) => {
  const db = await getDb();
  return db.select().from(schema.notifications).where(eq(schema.notifications.userLogin, login));
};

beforeAll(async () => {
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ name: "Olive", login: "olive", email: "olive@example.com" }).returning();
  owner = { id: o.id, login: "olive", name: "Olive", image: null };
  actor = owner;
  const doc = await createDocument({ ownerId: owner.id, title: "Shared" });
  docId = doc.id;
});

describe("removeCollaborator()", () => {
  it("reports whether a row was removed, normalizing case and a leading @", async () => {
    await upsertCollaborator(docId, "Helper", "viewer", owner.id);
    expect(await removeCollaborator(docId, "nobody")).toBe(false);
    expect(await removeCollaborator(docId, "@HELPER")).toBe(true);
    expect(await removeCollaborator(docId, "helper")).toBe(false);
    expect((await listCollaborators(docId)).map((c) => c.login)).not.toContain("helper");
  });
});

describe("DELETE /api/documents/:id/collaborators", () => {
  it("removes an existing collaborator once (200), then 404s without recording more activity", async () => {
    await upsertCollaborator(docId, "vic", "editor", owner.id);
    expect(await shareRemovals()).toHaveLength(0);

    const first = await del("vic");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect((await listCollaborators(docId)).map((c) => c.login)).not.toContain("vic");
    const after = await shareRemovals();
    expect(after).toHaveLength(1);
    expect(after[0].detail).toEqual({ login: "vic" });

    const again = await del("vic");
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "Collaborator not found" });
    expect(await shareRemovals()).toHaveLength(1);
    expect(await notificationsFor("vic")).toHaveLength(0);
  });

  it("returns 404 for a login that was never shared and records nothing", async () => {
    const before = (await shareRemovals()).length;
    const res = await del("never-shared");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Collaborator not found" });
    expect(await shareRemovals()).toHaveLength(before);
    expect(await notificationsFor("never-shared")).toHaveLength(0);
  });

  it("matches the stored login regardless of case and a leading @", async () => {
    await upsertCollaborator(docId, "Mixed-Case", "commenter", owner.id);
    const before = (await shareRemovals()).length;

    const res = await del("@MIXED-case");
    expect(res.status).toBe(200);
    expect((await listCollaborators(docId)).map((c) => c.login)).not.toContain("mixed-case");
    const after = await shareRemovals();
    expect(after).toHaveLength(before + 1);
    expect(after[after.length - 1].detail).toEqual({ login: "mixed-case" });

    expect((await del("mixed-case")).status).toBe(404);
    expect(await shareRemovals()).toHaveLength(before + 1);
  });

  it("still requires ownership (401 signed out, 404 for a stranger)", async () => {
    await upsertCollaborator(docId, "vic", "editor", owner.id);
    const db = await getDb();
    const [s] = await db.insert(schema.users).values({ name: "Sam", login: "sam", email: "sam@example.com" }).returning();
    const stranger: Actor = { id: s.id, login: "sam", name: "Sam", image: null };
    const before = (await shareRemovals()).length;

    actor = null;
    try {
      expect((await del("vic")).status).toBe(401);
    } finally {
      actor = owner;
    }
    actor = stranger;
    try {
      expect((await del("vic")).status).toBe(404);
    } finally {
      actor = owner;
    }
    expect((await listCollaborators(docId)).map((c) => c.login)).toContain("vic");
    expect(await shareRemovals()).toHaveLength(before);
  });
});
