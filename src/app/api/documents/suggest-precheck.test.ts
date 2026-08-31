import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Same stand-ins as suggestions.test.ts: the routes resolve the caller through next-auth and
// `next/headers`, neither of which runs outside a Next request.
let actor: { id: string; login: string; name: string; image: null } | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// Wrapped so a test can make the activity insert or the request link fail after the suggestions are written.
vi.mock("@/server/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/activity")>();
  return { ...actual, recordActivity: vi.fn(actual.recordActivity) };
});
vi.mock("@/server/agent-requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/agent-requests")>();
  return { ...actual, attachWork: vi.fn(actual.attachWork) };
});

const { getDb, schema } = await import("@/server/db");
const { createDocument } = await import("@/server/documents");
const { recordActivity } = await import("@/server/activity");
const { createRequest, cancelRequest, completeRequest, attachWork } = await import("@/server/agent-requests");
const suggest = await import("@/app/api/documents/[id]/suggest/route");
const content = await import("@/app/api/documents/[id]/content/route");
const activity = await import("@/app/api/documents/[id]/activity/route");
const requests = await import("@/app/api/documents/[id]/requests/route");

type ContentBody = { content: string; clean: string; contentHash: string; pendingSuggestions: number };
type ActivityItem = { action: string; detail: Record<string, unknown> };
type RequestItem = { id: string; status: string; claimedBy: string | null; result: { suggestions: number; comments: number; suggestionIds?: string[] } | null };
type SuggestBody = { ok: boolean; suggestions: number; suggestionIds: string[]; contentHash: string; warnings?: string[] };

const TEXT = "# shape\n\nAlpha.\n";
const EDITS = [{ find: "Alpha", replace: "Beta" }];

/** Runs `fn` with console.error silenced; returns its result and the `[suggest]`-prefixed lines it logged. */
const quietly = async <T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await fn();
    return { result, logged: errors.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith("[suggest]")) };
  } finally {
    errors.mockRestore();
  }
};

/**
 * `docs/agents.md` promises that a non-2xx status from a write route means nothing changed. With a
 * bad `requestId` the suggest route used to apply the suggestions and record `suggestion.add` first
 * and only then fail in `attachWork`; the request is now validated before the write.
 */
describe("POST /api/documents/[id]/suggest validates requestId before writing", () => {
  let docId: string;

  beforeAll(async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Eve", login: "eve-precheck", email: "eve-precheck@example.com" }).returning();
    actor = { id: user.id, login: "eve-precheck", name: "Eve", image: null };
  });

  const ctx = () => ({ params: Promise.resolve({ id: docId }) });
  const url = (path: string) => `http://localhost:3700/api/documents/${docId}/${path}`;
  const postSuggest = (body: unknown) => suggest.POST(new Request(url("suggest"), { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), ctx());
  const read = async () => (await (await content.GET(new Request(url("content")), ctx())).json()) as ContentBody;
  const activityItems = async () => ((await (await activity.GET(new Request(url("activity")), ctx())).json()) as { items: ActivityItem[] }).items;
  const listed = async () => ((await (await requests.GET(new Request(url("requests")), ctx())).json()) as { requests: RequestItem[] }).requests;

  const freshDoc = async () => {
    const doc = await createDocument({ ownerId: actor!.id, title: "shape", content: TEXT });
    docId = doc.id;
    const before = await read();
    expect(before.content).toBe(TEXT);
    expect(before.pendingSuggestions).toBe(0);
    return before;
  };

  /** The document text, pending-suggestion count, clean hash and activity log are all as before the call (soft: report every broken invariant at once). */
  const expectNothingChanged = async (before: ContentBody) => {
    const after = await read();
    expect.soft(after.content).toBe(before.content);
    expect.soft(after.pendingSuggestions).toBe(0);
    expect.soft(after.contentHash).toBe(before.contentHash);
    expect.soft((await activityItems()).map((i) => i.action)).not.toContain("suggestion.add");
  };

  it("unknown request: 404 and nothing changed (no suggestions in the text, no suggestion.add row)", async () => {
    const before = await freshDoc();
    const res = await postSuggest({ edits: EDITS, requestId: "nope" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Request not found" });
    await expectNothingChanged(before);
  });

  it("a request on another document is unknown here too: 404 and nothing changed", async () => {
    const elsewhere = await createDocument({ ownerId: actor!.id, title: "other", content: "Other text.\n" });
    const foreign = await createRequest(elsewhere.id, actor!, "owner", { instruction: "Tighten this", mode: "suggest" });
    const before = await freshDoc();
    const res = await postSuggest({ edits: EDITS, requestId: foreign.id });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Request not found" });
    await expectNothingChanged(before);
  });

  it("cancelled request: 409 with status and nothing changed", async () => {
    const before = await freshDoc();
    const request = await createRequest(docId, actor!, "owner", { instruction: "Tighten this", mode: "suggest" });
    await cancelRequest(docId, request.id, actor!, "owner");
    const res = await postSuggest({ edits: EDITS, requestId: request.id });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Request is cancelled", status: "cancelled" });
    await expectNothingChanged(before);
    expect((await listed()).find((r) => r.id === request.id)).toMatchObject({ status: "cancelled", result: null });
  });

  it("done request: 409 with status and nothing changed", async () => {
    const before = await freshDoc();
    const request = await createRequest(docId, actor!, "owner", { instruction: "Tighten this", mode: "suggest" });
    await completeRequest(docId, request.id, actor!, { summary: "Did it elsewhere." });
    const res = await postSuggest({ edits: EDITS, requestId: request.id });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Request is done", status: "done" });
    await expectNothingChanged(before);
  });

  it("open request: 200, suggestions applied and counted against the request (claimed, result.suggestions)", async () => {
    const before = await freshDoc();
    const request = await createRequest(docId, actor!, "owner", { instruction: "Tighten this", mode: "suggest" });
    const res = await postSuggest({ edits: EDITS, requestId: request.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuggestBody;
    expect(body).toMatchObject({ ok: true, suggestions: 2 });
    expect(body.suggestionIds).toHaveLength(2);
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const after = await read();
    expect(after.content).not.toBe(before.content);
    expect(after.content).toContain("Beta");
    expect(after.pendingSuggestions).toBe(2);
    expect(after.contentHash).toBe(body.contentHash);

    const added = (await activityItems()).filter((i) => i.action === "suggestion.add");
    expect(added).toHaveLength(1);
    expect(added[0].detail).toEqual({ count: 2, requestId: request.id });

    const row = (await listed()).find((r) => r.id === request.id);
    expect(row).toMatchObject({ status: "claimed", claimedBy: "Eve" });
    expect(row?.result).toMatchObject({ suggestions: 2, comments: 0, suggestionIds: body.suggestionIds });
  });

  it("without requestId: unchanged behaviour, 200 with the suggestions applied", async () => {
    await freshDoc();
    const res = await postSuggest({ edits: EDITS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, suggestions: 2, suggestionIds: [expect.any(String), expect.any(String)], contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await read()).pendingSuggestions).toBe(2);
    expect((await activityItems()).map((i) => i.action)).toEqual(["suggestion.add"]);
  });

  /**
   * Once the suggestions are in the shared document they are on every editor's screen, so a side effect that
   * fails after that (activity row, request link) is reported as `warnings` on the 200 — a 500 would claim nothing
   * changed while the tracked changes stay, and the agent's retry could not be idempotent (`edits` no longer match).
   */
  describe("keeps the write and reports a failed tail as warnings", () => {
    afterEach(() => {
      // A failure armed with `...Once` and never consumed must not leak into the next test.
      vi.mocked(recordActivity).mockReset();
      vi.mocked(attachWork).mockReset();
    });

    it("attachWork failing: 200 with the suggestions in the document, warnings: [request-not-attached], the request untouched", async () => {
      const before = await freshDoc();
      const request = await createRequest(docId, actor!, "owner", { instruction: "Tighten this", mode: "suggest" });
      vi.mocked(attachWork).mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
      const { result: res, logged } = await quietly(() => postSuggest({ edits: EDITS, requestId: request.id }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as SuggestBody;
      expect(body).toMatchObject({ ok: true, suggestions: 2, warnings: ["request-not-attached"] });
      expect(body.suggestionIds).toHaveLength(2);
      expect(logged).toEqual([["[suggest] request-not-attached", expect.any(Error)]]);

      const after = await read();
      expect(after.content).toContain("Beta");
      expect(after.pendingSuggestions).toBe(2);
      // Pending suggestions do not move the clean-text hash; the response carries the current one.
      expect(after.contentHash).toBe(body.contentHash);
      expect(after.contentHash).toBe(before.contentHash);
      // The link is attempted before the activity row; the row is still written, but without `requestId`, since the
      // request did not count the work. The request itself was not touched.
      const added = (await activityItems()).filter((i) => i.action === "suggestion.add");
      expect(added).toHaveLength(1);
      expect(added[0].detail).toEqual({ count: 2 });
      expect((await listed()).find((r) => r.id === request.id)).toMatchObject({ status: "open", claimedBy: null, result: null });
    });

    it("recordActivity failing: 200 with the suggestions in the document, warnings: [activity-not-recorded], counted against the request", async () => {
      await freshDoc();
      const request = await createRequest(docId, actor!, "owner", { instruction: "Tighten this", mode: "suggest" });
      vi.mocked(recordActivity).mockRejectedValueOnce(new Error('Failed query: insert into "activity" ("id", "document_id") values ($1, $2) params: abc,secret-owner-uuid'));
      const { result: res, logged } = await quietly(() => postSuggest({ edits: EDITS, requestId: request.id }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as SuggestBody;
      expect(body).toMatchObject({ ok: true, suggestions: 2, warnings: ["activity-not-recorded"] });
      // The driver's message (statement + parameters) stays in the log, logged once under the route's code.
      expect(JSON.stringify(body)).not.toContain("Failed query");
      expect(logged).toEqual([["[suggest] activity-not-recorded", expect.any(Error)]]);

      expect((await read()).pendingSuggestions).toBe(2);
      expect((await activityItems()).map((i) => i.action)).not.toContain("suggestion.add");
      const row = (await listed()).find((r) => r.id === request.id);
      expect(row).toMatchObject({ status: "claimed", claimedBy: "Eve" });
      expect(row?.result).toMatchObject({ suggestions: 2, comments: 0, suggestionIds: body.suggestionIds });
    });

    it("the residual race — request completed between the pre-check and the write — is request-not-attached on a 200, not a 409 with the suggestions kept", async () => {
      await freshDoc();
      const request = await createRequest(docId, actor!, "owner", { instruction: "Tighten this", mode: "suggest" });
      vi.mocked(attachWork).mockImplementationOnce(async (...args) => {
        await completeRequest(docId, request.id, actor!, { summary: "Closed meanwhile." });
        const actual = (await vi.importActual<typeof import("@/server/agent-requests")>("@/server/agent-requests")).attachWork;
        return actual(...args);
      });
      const { result: res, logged } = await quietly(() => postSuggest({ edits: EDITS, requestId: request.id }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, suggestions: 2, warnings: ["request-not-attached"] });
      expect(logged).toEqual([["[suggest] request-not-attached", expect.any(Error)]]);
      expect((await read()).pendingSuggestions).toBe(2);
      expect((await listed()).find((r) => r.id === request.id)).toMatchObject({ status: "done", result: { suggestions: 0 } });
      // The row is written for the feed and the event stream, but claims nothing for the request that refused the work.
      const added = (await activityItems()).filter((i) => i.action === "suggestion.add");
      expect(added).toHaveLength(1);
      expect(added[0].detail).toEqual({ count: 2 });
    });
  });
});
