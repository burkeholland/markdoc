import { describe, expect, it, beforeAll, vi } from "vitest";
import { eq } from "drizzle-orm";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Same stand-ins as content.test.ts: the route resolves the caller through next-auth and `next/headers`,
// neither of which runs outside a Next request.
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// Wrapped so one test can make the `title.change` insert fail after the live rename has landed.
vi.mock("@/server/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/activity")>();
  return { ...actual, recordActivity: vi.fn(actual.recordActivity) };
});

const { getDb, schema } = await import("@/server/db");
const { createDocument } = await import("@/server/documents");
const { META_KEY } = await import("@/server/collab/hocuspocus");
const { readLiveDoc } = await import("@/server/livedoc");
const { listActivity, recordActivity } = await import("@/server/activity");
const { PATCH } = await import("./[id]/route");

type PatchBody = { document: { id: string; title: string; linkAccess: string; updatedAt: string }; warnings?: string[] };

let owner: Actor;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://localhost:3700/api/documents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), params(id));
/** `meta.title` of the live document (here: of the stored state, no collaboration server runs): what `GET /content` and every store read. */
const liveTitle = (id: string) => readLiveDoc(id, (doc) => doc.getMap(META_KEY).get("title"));
const row = async (id: string) => {
  const db = await getDb();
  const [stored] = await db.select().from(schema.documents).where(eq(schema.documents.id, id));
  return stored;
};
const titleChanges = async (id: string) => (await listActivity(id)).items.filter((item) => item.action === "title.change");
/** Runs `fn` with console.error silenced; returns its result and the `[documents]`-prefixed lines it logged. */
const quietly = async <T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await fn();
    return { result, logged: errors.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith("[documents]")) };
  } finally {
    errors.mockRestore();
  }
};
const DB_FAILURE = new Error('Failed query: insert into "activity" ("id", "document_id") values ($1, $2) params: abc,secret-owner-uuid');

beforeAll(async () => {
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ name: "Rena", login: "rena", email: "rena-rename@example.com" }).returning();
  owner = { id: o.id, login: "rena", name: "Rena", image: null };
  actor = owner;
});

/**
 * PATCH /api/documents/:id joins the warnings convention (docs/agents.md §3): the rename is in the live document
 * before its `title.change` row is written, so a failed row is `200 { document, warnings: ["activity-not-recorded"] }`
 * — not a 5xx claiming nothing changed, and not a silent log line the caller never sees.
 */
describe("PATCH /api/documents/:id: the title.change row is a warning tail", () => {
  it("a rename whose activity row cannot be written is a 200 with activity-not-recorded: live title and column renamed, the driver's message stays in the log", async () => {
    const doc = await createDocument({ ownerId: owner.id, title: "Original", content: "Rename me" });
    vi.mocked(recordActivity).mockRejectedValueOnce(DB_FAILURE);
    const { result: res, logged } = await quietly(() => patch(doc.id, { title: "Renamed by API" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchBody;
    expect(body).toEqual({ document: expect.objectContaining({ id: doc.id, title: "Renamed by API" }), warnings: ["activity-not-recorded"] });
    expect(body.warnings).toHaveLength(1);
    // The driver's message (statement + parameters) stays in the log, logged once under the route's scope.
    expect(JSON.stringify(body)).not.toContain("Failed query");
    expect(logged).toEqual([["[documents] activity-not-recorded", expect.any(Error)]]);

    // The rename stands on both sides; the one thing the warning names is really missing.
    expect(await liveTitle(doc.id)).toBe("Renamed by API");
    expect((await row(doc.id)).title).toBe("Renamed by API");
    expect(await titleChanges(doc.id)).toHaveLength(0);
  });

  it("a rename whose row is written has no warnings key and exactly one title.change row", async () => {
    const doc = await createDocument({ ownerId: owner.id, title: "Original", content: "Rename me" });
    const { result: res, logged } = await quietly(() => patch(doc.id, { title: "Renamed by API" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchBody;
    expect(body.document.title).toBe("Renamed by API");
    expect(body).not.toHaveProperty("warnings");
    expect(logged).toEqual([]);

    expect(await liveTitle(doc.id)).toBe("Renamed by API");
    expect((await row(doc.id)).title).toBe("Renamed by API");
    const changes = await titleChanges(doc.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ actorName: "Rena", actorKind: "user", detail: { title: "Renamed by API" } });
  });

  it("the current title again is a no-op: 200 { document } only, no row, updatedAt unchanged", async () => {
    const doc = await createDocument({ ownerId: owner.id, title: "Same title", content: "Same" });
    const before = await row(doc.id);
    const calls = vi.mocked(recordActivity).mock.calls.length;
    const res = await patch(doc.id, { title: "  Same title  " });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchBody;
    expect(Object.keys(body)).toEqual(["document"]);
    expect(body.document.title).toBe("Same title");
    expect(body.document.updatedAt).toBe(before.updatedAt.toISOString());

    expect(vi.mocked(recordActivity).mock.calls).toHaveLength(calls);
    expect(await titleChanges(doc.id)).toHaveLength(0);
    const after = await row(doc.id);
    expect(after.title).toBe("Same title");
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("{ linkAccess } alone runs no activity tail: 200 { document } without a warnings key", async () => {
    const doc = await createDocument({ ownerId: owner.id, title: "Shared", content: "Share me" });
    const calls = vi.mocked(recordActivity).mock.calls.length;
    const res = await patch(doc.id, { linkAccess: "view" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchBody;
    expect(Object.keys(body)).toEqual(["document"]);
    expect(body.document.linkAccess).toBe("view");

    expect(vi.mocked(recordActivity).mock.calls).toHaveLength(calls);
    expect(await titleChanges(doc.id)).toHaveLength(0);
    expect((await row(doc.id)).linkAccess).toBe("view");
  });
});
