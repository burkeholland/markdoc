import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { createDocument, upsertCollaborator } = await import("@/server/documents");
const { POST } = await import("./[id]/access-request/route");
const { and, eq } = await import("drizzle-orm");

let owner: Actor;
let viewer: Actor;
let stranger: Actor;
let docId: string;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (who: Actor | null, id: string) => {
  actor = who;
  return POST(new Request(`http://localhost:3700/api/documents/${id}/access-request`, { method: "POST" }), params(id));
};
const ownerRequests = async () => {
  const db = await getDb();
  return db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userLogin, "olive"), eq(schema.notifications.kind, "access.request")));
};

beforeAll(async () => {
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ name: "Olive", login: "olive", email: "olive@example.com" }).returning();
  const [v] = await db.insert(schema.users).values({ name: "Vic", login: "vic", email: "vic@example.com" }).returning();
  const [s] = await db.insert(schema.users).values({ name: "Sam", login: "sam", email: "sam@example.com" }).returning();
  owner = { id: o.id, login: "olive", name: "Olive", image: null };
  viewer = { id: v.id, login: "vic", name: "Vic", image: null };
  stranger = { id: s.id, login: "sam", name: "Sam", image: null };
  docId = (await createDocument({ ownerId: owner.id, title: "Private plan" })).id;
  await upsertCollaborator(docId, "vic", "viewer", owner.id);
});

describe("POST /api/documents/:id/access-request", () => {
  it("requires a signed-in caller (401)", async () => {
    expect((await post(null, docId)).status).toBe(401);
  });

  it("answers identically for a missing document and notifies no one", async () => {
    const missing = await post(stranger, "doesnotexist123");
    const real = await post(stranger, docId);
    expect(missing.status).toBe(202);
    expect(real.status).toBe(202);
    expect(await missing.json()).toEqual(await real.json());
  });

  it("notifies the owner once per requester", async () => {
    await post(stranger, docId);
    const rows = await ownerRequests();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ documentId: docId, actorLogin: "sam", actorName: "Sam", refId: `${docId}:sam`, readAt: null });
  });

  it("is a silent no-op for someone who already has access", async () => {
    const res = await post(viewer, docId);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ requested: true });
    expect((await ownerRequests()).map((r) => r.actorLogin)).toEqual(["sam"]);
  });
});
