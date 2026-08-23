import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Same stand-ins as templates.test.ts: the routes resolve the caller through next-auth and `next/headers`.
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { createDocument, recordDocumentOpen, upsertCollaborator } = await import("@/server/documents");
const { GET: GET_STAR, PUT, DELETE } = await import("./[id]/star/route");
const { GET: GET_LIST } = await import("./route");

let owner: Actor;
let viewer: Actor;
let stranger: Actor;
let docId: string;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, id: string) => new Request(`http://localhost:3700/api/documents/${id}/star`, { method });
const as = async <T>(who: Actor | null, fn: () => Promise<T>) => {
  const saved = actor;
  actor = who;
  try {
    return await fn();
  } finally {
    actor = saved;
  }
};

beforeAll(async () => {
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ name: "Olive", login: "olive", email: "olive@example.com" }).returning();
  const [v] = await db.insert(schema.users).values({ name: "Vic", login: "vic", email: "vic@example.com" }).returning();
  const [s] = await db.insert(schema.users).values({ name: "Sam", login: "sam", email: "sam@example.com" }).returning();
  owner = { id: o.id, login: "olive", name: "Olive", image: null };
  viewer = { id: v.id, login: "vic", name: "Vic", image: null };
  stranger = { id: s.id, login: "sam", name: "Sam", image: null };
  const doc = await createDocument({ ownerId: owner.id, title: "Starrable" });
  docId = doc.id;
  await upsertCollaborator(docId, "vic", "viewer", owner.id);
});

describe("PUT/DELETE /api/documents/:id/star", () => {
  it("requires a signed-in caller (401)", async () => {
    expect((await as(null, () => PUT(req("PUT", docId), params(docId)))).status).toBe(401);
    expect((await as(null, () => DELETE(req("DELETE", docId), params(docId)))).status).toBe(401);
  });

  it("hides the document from strangers (404)", async () => {
    expect((await as(stranger, () => PUT(req("PUT", docId), params(docId)))).status).toBe(404);
    expect((await as(stranger, () => DELETE(req("DELETE", docId), params(docId)))).status).toBe(404);
    expect((await as(stranger, () => GET_STAR(req("GET", docId), params(docId)))).status).toBe(404);
  });

  it("lets a viewer star and unstar (200), visible only to them", async () => {
    const put = await as(viewer, () => PUT(req("PUT", docId), params(docId)));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ starred: true });
    expect(await (await as(viewer, () => GET_STAR(req("GET", docId), params(docId)))).json()).toEqual({ starred: true });
    expect(await (await as(owner, () => GET_STAR(req("GET", docId), params(docId)))).json()).toEqual({ starred: false });

    const del = await as(viewer, () => DELETE(req("DELETE", docId), params(docId)));
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ starred: false });
    expect(await (await as(viewer, () => GET_STAR(req("GET", docId), params(docId)))).json()).toEqual({ starred: false });
  });
});

describe("GET /api/documents", () => {
  it("returns starred and lastOpenedAt per document, and filters with ?starred=1", async () => {
    const other = await createDocument({ ownerId: owner.id, title: "Other" });
    await as(owner, () => PUT(req("PUT", docId), params(docId)));
    const openedAt = new Date("2026-04-01T12:00:00Z");
    await recordDocumentOpen(owner.id, docId, openedAt);

    const res = await as(owner, () => GET_LIST(new Request("http://localhost:3700/api/documents")));
    expect(res.status).toBe(200);
    const { documents } = (await res.json()) as { documents: { id: string; starred: boolean; lastOpenedAt: string | null }[] };
    const starred = documents.find((d) => d.id === docId);
    const plain = documents.find((d) => d.id === other.id);
    expect(starred).toMatchObject({ starred: true, lastOpenedAt: openedAt.toISOString() });
    expect(plain).toMatchObject({ starred: false, lastOpenedAt: null });
    // Opened document first, never-opened after.
    expect(documents.findIndex((d) => d.id === docId)).toBeLessThan(documents.findIndex((d) => d.id === other.id));

    const only = await as(owner, () => GET_LIST(new Request("http://localhost:3700/api/documents?starred=1")));
    const body = (await only.json()) as { documents: { id: string; starred: boolean }[] };
    expect(body.documents.map((d) => d.id)).toEqual([docId]);
  });
});
