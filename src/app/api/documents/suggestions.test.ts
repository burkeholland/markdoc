import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Same stand-ins as activity.test.ts: the routes resolve the caller through next-auth and
// `next/headers`, neither of which runs outside a Next request.
let actor: { id: string; login: string; name: string; image: null } | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { createDocument } = await import("@/server/documents");
const suggest = await import("@/app/api/documents/[id]/suggest/route");
const suggestions = await import("@/app/api/documents/[id]/suggestions/route");
const activity = await import("@/app/api/documents/[id]/activity/route");

type Pending = { id: string; type: string; text: string };

describe("POST /api/documents/[id]/suggestions", () => {
  let docId: string;

  beforeAll(async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Eve", login: "eve-sugg", email: "eve-sugg@example.com" }).returning();
    actor = { id: user.id, login: "eve-sugg", name: "Eve", image: null };
  });

  const ctx = () => ({ params: Promise.resolve({ id: docId }) });
  const post = (fn: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>, path: string, body: unknown) =>
    fn(new Request(`http://localhost:3700/api/documents/${docId}/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), ctx());
  const pending = async () => ((await (await suggestions.GET(new Request(`http://localhost:3700/api/documents/${docId}/suggestions`), ctx())).json()) as { suggestions: Pending[] }).suggestions;
  const activityActions = async () =>
    ((await (await activity.GET(new Request(`http://localhost:3700/api/documents/${docId}/activity`), ctx())).json()) as { items: { action: string }[] }).items.map((i) => i.action);

  /** A fresh document with one find → replace proposed on it (a deletion + an insertion). */
  const freshDoc = async () => {
    const doc = await createDocument({ ownerId: actor!.id, title: "shape", content: "# shape\n\nAlpha.\n" });
    docId = doc.id;
    const res = await post(suggest.POST, "suggest", { edits: [{ find: "Alpha", replace: "Beta" }] });
    expect(res.status).toBe(200);
    const { suggestionIds } = (await res.json()) as { suggestions: number; suggestionIds: string[] };
    expect(suggestionIds.length).toBe(2);
    return suggestionIds;
  };

  it("accept / reject without an id is a 400 and changes nothing", async () => {
    await freshDoc();
    for (const action of ["accept", "reject"]) {
      const res = await post(suggestions.POST, "suggestions", { action });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "`id` is required for accept/reject" });
    }
    expect((await pending()).length).toBe(2);
    expect(await activityActions()).toEqual(["suggestion.add"]);
  });

  it("accept / reject with an unknown id is a 404 and changes nothing", async () => {
    await freshDoc();
    for (const action of ["accept", "reject"]) {
      const res = await post(suggestions.POST, "suggestions", { action, id: "does-not-exist" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Suggestion not found" });
    }
    expect((await pending()).length).toBe(2);
    expect(await activityActions()).toEqual(["suggestion.add"]);
  });

  it("a valid id decides exactly that suggestion and says so; deciding it again is a 404", async () => {
    const [first, second] = await freshDoc();
    const res = await post(suggestions.POST, "suggestions", { action: "accept", id: first });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, decided: 1, id: first });
    const left = await pending();
    expect(left.map((s) => s.id)).toEqual([second]);
    expect(await activityActions()).toEqual(["suggestion.accept", "suggestion.add"]);

    const again = await post(suggestions.POST, "suggestions", { action: "accept", id: first });
    expect(again.status).toBe(404);
    expect((await pending()).length).toBe(1);

    const rejected = await post(suggestions.POST, "suggestions", { action: "reject", id: second });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toEqual({ ok: true, decided: 1, id: second });
    expect((await pending()).length).toBe(0);
  });

  it("acceptAll / rejectAll report how many were decided", async () => {
    await freshDoc();
    const res = await post(suggestions.POST, "suggestions", { action: "acceptAll" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, decided: 2 });
    expect((await pending()).length).toBe(0);

    const nothing = await post(suggestions.POST, "suggestions", { action: "rejectAll" });
    expect(nothing.status).toBe(200);
    expect(await nothing.json()).toEqual({ ok: true, decided: 0 });
  });

  it("rejects an unknown action", async () => {
    await freshDoc();
    expect((await post(suggestions.POST, "suggestions", { action: "approve" })).status).toBe(400);
  });
});
