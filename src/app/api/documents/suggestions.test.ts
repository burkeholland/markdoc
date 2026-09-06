import { describe, expect, it, beforeAll, beforeEach, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Same stand-ins as activity.test.ts: the routes resolve the caller through next-auth and
// `next/headers`, neither of which runs outside a Next request.
let actor: { id: string; login: string; name: string; image: null } | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// Wrapped so a test can make the activity row or an author's notification fail after the decision is in the document.
vi.mock("@/server/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/activity")>();
  return { ...actual, recordActivity: vi.fn(actual.recordActivity) };
});
vi.mock("@/server/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/notifications")>();
  return { ...actual, notifySuggestionDecision: vi.fn(actual.notifySuggestionDecision) };
});

const { getDb, schema } = await import("@/server/db");
const { createDocument, upsertCollaborator } = await import("@/server/documents");
const { recordActivity } = await import("@/server/activity");
const { notifySuggestionDecision, listNotifications } = await import("@/server/notifications");
const { apiLimiter } = await import("@/server/rate-limit");
const suggest = await import("@/app/api/documents/[id]/suggest/route");
const suggestions = await import("@/app/api/documents/[id]/suggestions/route");
const activity = await import("@/app/api/documents/[id]/activity/route");
const content = await import("@/app/api/documents/[id]/content/route");

type Pending = { id: string; type: string; text: string };

const DB_FAILURE = new Error('Failed query: insert into "activity" ("id", "document_id") values ($1, $2) params: abc,secret-owner-uuid');

/** Runs `fn` with console.error silenced; returns its result and the `[suggestions]`-prefixed lines it logged. */
const quietly = async <T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await fn();
    return { result, logged: errors.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith("[suggestions]")) };
  } finally {
    errors.mockRestore();
  }
};

describe("POST /api/documents/[id]/suggestions", () => {
  let docId: string;
  beforeEach(() => apiLimiter.reset());

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

  /** A fresh document with one find -> replace review group (two anchored runs). */
  const freshDoc = async () => {
    const doc = await createDocument({ ownerId: actor!.id, title: "shape", content: "# shape\n\nAlpha.\n" });
    docId = doc.id;
    const res = await post(suggest.POST, "suggest", { edits: [{ find: "Alpha", replace: "Beta" }] });
    expect(res.status).toBe(200);
    const { suggestionIds } = (await res.json()) as { suggestions: number; suggestionIds: string[] };
    expect(suggestionIds.length).toBe(1);
    return suggestionIds;
  };

  it("accept / reject without an id is a 400 and changes nothing", async () => {
    await freshDoc();
    for (const action of ["accept", "reject"]) {
      const res = await post(suggestions.POST, "suggestions", { action });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "`id` is required for accept/reject" });
    }
    expect((await pending()).length).toBe(1);
    expect(await activityActions()).toEqual(["suggestion.add"]);
  });

  it("accept / reject with an unknown id is a 404 and changes nothing", async () => {
    await freshDoc();
    for (const action of ["accept", "reject"]) {
      const res = await post(suggestions.POST, "suggestions", { action, id: "does-not-exist" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Suggestion not found" });
    }
    expect((await pending()).length).toBe(1);
    expect(await activityActions()).toEqual(["suggestion.add"]);
  });

  it("a valid id decides exactly that suggestion and says so; deciding it again is a 404", async () => {
    const [first] = await freshDoc();
    const res = await post(suggestions.POST, "suggestions", { action: "accept", id: first });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, decided: 1, id: first });
    const left = await pending();
    expect(left).toEqual([]);
    expect(await activityActions()).toEqual(["suggestion.accept", "suggestion.add"]);

    const again = await post(suggestions.POST, "suggestions", { action: "accept", id: first });
    expect(again.status).toBe(404);
    expect((await pending()).length).toBe(0);

    const [second] = await freshDoc();
    const rejected = await post(suggestions.POST, "suggestions", { action: "reject", id: second });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toEqual({ ok: true, decided: 1, id: second });
    expect((await pending()).length).toBe(0);
  });

  it("acceptAll / rejectAll report how many were decided", async () => {
    await freshDoc();
    const res = await post(suggestions.POST, "suggestions", { action: "acceptAll" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, decided: 1 });
    expect((await pending()).length).toBe(0);

    const nothing = await post(suggestions.POST, "suggestions", { action: "rejectAll" });
    expect(nothing.status).toBe(200);
    expect(await nothing.json()).toEqual({ ok: true, decided: 0 });
  });

  it("rejects an unknown action", async () => {
    await freshDoc();
    expect((await post(suggestions.POST, "suggestions", { action: "approve" })).status).toBe(400);
  });

  /**
   * `docs/agents.md` promises that a non-2xx status means nothing changed. The decision is applied in the
   * shared document (text changed on accept, suggestions cleared on reject) before the activity row and the
   * authors' notifications; a failure there used to answer 500 for a decision that had happened, and the retry
   * then answered `404 Suggestion not found` (single) or `decided: 0` (all). Audit #1202 F17.
   */
  describe("post-write failures are warnings on the 200", () => {
    const clean = async () => ((await (await content.GET(new Request(`http://localhost:3700/api/documents/${docId}/content`), ctx())).json()) as { clean: string }).clean;

    it("accept with recordActivity failing: 200 { ok, decided: 1, id, warnings: [activity-not-recorded] }, the text changed, the author notified", async () => {
      await freshDoc();
      const before = await pending();
      const insertion = before.find((s) => s.type === "replace")!.id;
      expect(await clean()).toBe("# shape\n\nAlpha.\n");
      vi.mocked(recordActivity).mockRejectedValueOnce(DB_FAILURE);
      vi.mocked(notifySuggestionDecision).mockClear();
      const { result: res, logged } = await quietly(() => post(suggestions.POST, "suggestions", { action: "accept", id: insertion }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, decided: 1, id: insertion, warnings: ["activity-not-recorded"] });
      // The driver's message (statement + parameters) stays in the log, logged once under the route's code.
      expect(JSON.stringify(body)).not.toContain("Failed query");
      expect(logged).toEqual([["[suggestions] activity-not-recorded", expect.any(Error)]]);

      // One decision keeps the insertion and removes the old passage.
      expect(await clean()).toBe("# shape\n\nBeta.\n");
      expect(await pending()).toEqual([]);
      expect(await activityActions()).toEqual(["suggestion.add"]);
      expect(vi.mocked(notifySuggestionDecision)).toHaveBeenCalledTimes(1);

      // Deciding it again is the honest 404 — the caller already got its 200.
      const again = await post(suggestions.POST, "suggestions", { action: "accept", id: insertion });
      expect(again.status).toBe(404);
      expect((await pending()).length).toBe(0);
    });

    it("acceptAll with an author's notification failing: the one group is decided and the activity row stands", async () => {
      await freshDoc();
      vi.mocked(notifySuggestionDecision).mockRejectedValueOnce(DB_FAILURE);
      const { result: res, logged } = await quietly(() => post(suggestions.POST, "suggestions", { action: "acceptAll" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, decided: 1, warnings: ["notification-not-sent"] });
      expect(logged).toEqual([["[suggestions] notification-not-sent", expect.any(Error)]]);

      expect(await clean()).toBe("# shape\n\nBeta.\n");
      expect((await pending()).length).toBe(0);
      expect(await activityActions()).toEqual(["suggestion.accept", "suggestion.add"]);

      // Nothing left to decide: `decided: 0` now describes the world correctly.
      const nothing = await post(suggestions.POST, "suggestions", { action: "acceptAll" });
      expect(await nothing.json()).toEqual({ ok: true, decided: 0 });
    });

    it("reject with both failing: 200 with both codes in write order, the suggestion is gone", async () => {
      await freshDoc();
      const deletion = (await pending()).find((s) => s.type === "replace")!.id;
      vi.mocked(recordActivity).mockRejectedValueOnce(DB_FAILURE);
      vi.mocked(notifySuggestionDecision).mockRejectedValueOnce(DB_FAILURE);
      const { result: res, logged } = await quietly(() => post(suggestions.POST, "suggestions", { action: "reject", id: deletion }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, decided: 1, id: deletion, warnings: ["activity-not-recorded", "notification-not-sent"] });
      expect(logged).toEqual([
        ["[suggestions] activity-not-recorded", expect.any(Error)],
        ["[suggestions] notification-not-sent", expect.any(Error)],
      ]);
      expect((await pending()).map((s) => s.id)).toHaveLength(0);
      expect((await post(suggestions.POST, "suggestions", { action: "reject", id: deletion })).status).toBe(404);
    });

    it("a decision that changes nothing runs no tail and stays the plain shape", async () => {
      await freshDoc();
      await post(suggestions.POST, "suggestions", { action: "rejectAll" });
      vi.mocked(recordActivity).mockClear();
      vi.mocked(notifySuggestionDecision).mockClear();
      const nothing = await post(suggestions.POST, "suggestions", { action: "rejectAll" });
      expect(nothing.status).toBe(200);
      expect(await nothing.json()).toEqual({ ok: true, decided: 0 });
      expect(vi.mocked(recordActivity)).not.toHaveBeenCalled();
      expect(vi.mocked(notifySuggestionDecision)).not.toHaveBeenCalled();
    });

    /**
     * #1233 decision 1 left the authors' notifications in one tail, so a failure for the first author skipped every
     * later author. Each author is its own tail now: the second author is notified, the code is reported once.
     */
    it("acceptAll over two authors with the first author's notification failing: the second author is still notified, the code appears once", async () => {
      const eve = actor!;
      const db = await getDb();
      const [fay] = await db.insert(schema.users).values({ name: "Fay", login: "fay-sugg", email: "fay-sugg@example.com" }).returning();
      const [gus] = await db.insert(schema.users).values({ name: "Gus", login: "gus-sugg", email: "gus-sugg@example.com" }).returning();
      const doc = await createDocument({ ownerId: eve.id, title: "authors", content: "# authors\n\nAlpha.\n\nOmega.\n" });
      docId = doc.id;
      await upsertCollaborator(docId, "fay-sugg", "editor", eve.id);
      await upsertCollaborator(docId, "gus-sugg", "editor", eve.id);
      // One pure insertion each, Fay's first in the text: `decided` is ordered by position, so Fay's notification runs first.
      const propose = async (who: typeof actor, find: string, replace: string) => {
        actor = who;
        const res = await post(suggest.POST, "suggest", { edits: [{ find, replace }] });
        expect(res.status).toBe(200);
        const { suggestionIds } = (await res.json()) as { suggestionIds: string[] };
        expect(suggestionIds).toHaveLength(1);
        return suggestionIds[0];
      };
      const fays = await propose({ id: fay.id, login: "fay-sugg", name: "Fay", image: null }, "Alpha.", "Alpha. More.");
      const guss = await propose({ id: gus.id, login: "gus-sugg", name: "Gus", image: null }, "Omega.", "Omega. Extra.");
      actor = eve;
      expect((await pending()).map((s) => s.id)).toEqual([fays, guss]);

      vi.mocked(notifySuggestionDecision).mockClear();
      vi.mocked(notifySuggestionDecision).mockRejectedValueOnce(DB_FAILURE);
      const { result: res, logged } = await quietly(() => post(suggestions.POST, "suggestions", { action: "acceptAll" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, decided: 2, warnings: ["notification-not-sent"] });
      expect(logged).toEqual([["[suggestions] notification-not-sent", expect.any(Error)]]);
      expect(await clean()).toBe("# authors\n\nAlpha. More.\n\nOmega. Extra.\n");

      // Fay's notification is the one that failed; Gus's ran and reached him.
      expect(vi.mocked(notifySuggestionDecision)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(notifySuggestionDecision).mock.calls.map((c) => c[1].id)).toEqual([fays, guss]);
      expect((await listNotifications("gus-sugg", { kind: "suggestion.accept" })).items.map((n) => n.refId)).toEqual([guss]);
      expect((await listNotifications("fay-sugg", { kind: "suggestion.accept" })).items).toEqual([]);
    });
  });
});
