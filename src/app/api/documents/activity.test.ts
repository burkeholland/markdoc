import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// The routes resolve the caller through next-auth and `next/headers`, neither of which
// runs outside a Next request. Stand in for them so the real access check still runs.
// `bearer` makes the request carry a real API token, so the agent path is exercised end to end.
let actor: { id: string; login: string; name: string; image: null } | null = null;
let bearer: string | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(bearer ? { authorization: `Bearer ${bearer}` } : {}) }));

const { getDb, schema } = await import("@/server/db");
const { createDocument, addVersion } = await import("@/server/documents");
const { createApiToken } = await import("@/server/tokens");
const { recordActivity } = await import("@/server/activity");
const { GET } = await import("@/app/api/documents/[id]/activity/route");
const versions = await import("@/app/api/documents/[id]/versions/route");
const version = await import("@/app/api/documents/[id]/versions/[vid]/route");
const suggest = await import("@/app/api/documents/[id]/suggest/route");
const suggestions = await import("@/app/api/documents/[id]/suggestions/route");
const comments = await import("@/app/api/documents/[id]/comments/route");

type Item = { action: string; actorName: string; actorKind: string; detail: Record<string, unknown>; createdAt: string };

describe("GET /api/documents/[id]/activity", () => {
  let docId: string;
  let eve: { id: string; login: string; name: string; image: null };

  beforeAll(async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Eve", login: "eve", email: "eve@example.com" }).returning();
    eve = { id: user.id, login: "eve", name: "Eve", image: null };
    actor = eve;
    const doc = await createDocument({ ownerId: user.id, title: "Feed", content: "# Feed\n\nWe ship Friday.\n" });
    docId = doc.id;
  });

  const get = (query = "") => GET(new Request(`http://localhost:3700/api/documents/${docId}/activity${query}`), { params: Promise.resolve({ id: docId }) });
  const post = (fn: (req: Request, ctx: { params: Promise<{ id: string; vid: string }> }) => Promise<Response>, path: string, body: unknown, vid = "") =>
    fn(new Request(`http://localhost:3700/api/documents/${docId}/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), {
      params: Promise.resolve({ id: docId, vid }),
    });

  it("requires view access", async () => {
    actor = null;
    try {
      expect((await get()).status).toBe(401);
    } finally {
      actor = eve;
    }
    const db = await getDb();
    const [stranger] = await db.insert(schema.users).values({ name: "Sam", login: "sam", email: "sam@example.com" }).returning();
    actor = { id: stranger.id, login: "sam", name: "Sam", image: null };
    try {
      expect((await get()).status).toBe(404);
    } finally {
      actor = eve;
    }
  });

  it("returns rows newest first and pages with nextBefore", async () => {
    const base = Date.parse("2026-03-01T12:00:00Z");
    const me = { id: eve.id, name: "Eve", kind: "user" as const };
    await recordActivity(docId, me, "share.add", { login: "drew", role: "editor" }, new Date(base));
    await recordActivity(docId, me, "version.save", { number: 2, title: "Draft" }, new Date(base + 1000));
    await recordActivity(docId, me, "edit", { chars: 42 }, new Date(base + 2000));

    const res = await get("?limit=2");
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: Item[]; nextBefore: string | null };
    expect(page.items.map((i) => i.action)).toEqual(["edit", "version.save"]);
    expect(page.nextBefore).toBe(page.items[1].createdAt);

    const next = (await (await get(`?limit=2&before=${encodeURIComponent(page.nextBefore!)}`)).json()) as { items: Item[]; nextBefore: string | null };
    expect(next.items.map((i) => i.action)).toEqual(["share.add"]);
    expect(next.nextBefore).toBeNull();

    expect((await get("?before=garbage")).status).toBe(400);
  });

  it("records version.save and version.restore through the versions routes", async () => {
    const saved = await post(versions.POST, "versions", { title: "Before review" });
    expect(saved.status).toBe(201);
    const { version: v } = (await saved.json()) as { version: { id: string; number: number } };

    const older = await addVersion({ documentId: docId, content: "# Feed\n\nOld text.\n", kind: "named", title: "Old" });
    const restored = await post(version.POST, `versions/${older.id}`, { action: "restore" }, older.id);
    expect(restored.status).toBe(200);

    const { items } = (await (await get()).json()) as { items: Item[] };
    expect(items[0].action).toBe("version.restore");
    expect(items[0].detail).toMatchObject({ number: older.number, title: "Old" });
    expect(items[1]).toMatchObject({ action: "version.save", actorName: "Eve", actorKind: "user", detail: { number: v.number, title: "Before review" } });
  });

  it("records agent suggestions and their review as separate actors", async () => {
    const token = await createApiToken(eve.id, "Copilot CLI");
    bearer = token.token;
    try {
      const res = await post(suggest.POST, "suggest", { edits: [{ find: "Old text", replace: "New text" }] });
      expect(res.status).toBe(200);
      const commented = await post(comments.POST, "comments", { action: "add", quote: "Feed", body: "Heads up: " + "z".repeat(300) });
      expect(commented.status).toBe(200);
    } finally {
      bearer = null;
    }
    const reviewed = await post(suggestions.POST, "suggestions", { action: "acceptAll" });
    expect(reviewed.status).toBe(200);

    const { items } = (await (await get()).json()) as { items: Item[] };
    expect(items[0]).toMatchObject({ action: "suggestion.accept", actorKind: "user", actorName: "Eve" });
    expect(Number(items[0].detail.count)).toBeGreaterThan(0);
    expect(items[1]).toMatchObject({ action: "comment.add", actorKind: "agent", actorName: "Copilot CLI" });
    expect(String(items[1].detail.quote)).toHaveLength(120);
    expect(items[2]).toMatchObject({ action: "suggestion.add", actorKind: "agent", actorName: "Copilot CLI" });
    expect(Number(items[2].detail.count)).toBeGreaterThan(0);
  });
});
