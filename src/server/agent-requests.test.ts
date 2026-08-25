import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Same stand-ins as star.test.ts: routes resolve the caller through next-auth and `next/headers`.
// A bearer token in `requestHeaders` takes precedence (that is how agents call in).
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
let requestHeaders = new Headers();
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const { getDb, schema } = await import("@/server/db");
const { eq } = await import("drizzle-orm");
const { createDocument, upsertCollaborator } = await import("@/server/documents");
const { createApiToken } = await import("@/server/tokens");
const { listNotifications } = await import("@/server/notifications");
const { listActivity } = await import("@/server/activity");
const { createRequest, listRequests, listRequestsForUser, claimRequest, completeRequest, cancelRequest, attachWork, readMirror } = await import("@/server/agent-requests");
const { POST: POST_REQUESTS, GET: GET_REQUESTS } = await import("@/app/api/documents/[id]/requests/route");
const { POST: POST_CLAIM } = await import("@/app/api/documents/[id]/requests/[rid]/claim/route");
const { POST: POST_COMPLETE } = await import("@/app/api/documents/[id]/requests/[rid]/complete/route");
const { POST: POST_CANCEL } = await import("@/app/api/documents/[id]/requests/[rid]/cancel/route");
const { GET: GET_AGENT_REQUESTS } = await import("@/app/api/agent/requests/route");
const { POST: POST_SUGGEST } = await import("@/app/api/documents/[id]/suggest/route");
const { POST: POST_COMMENTS } = await import("@/app/api/documents/[id]/comments/route");

let owner: Actor;
let commenter: Actor;
let viewer: Actor;
let stranger: Actor;
let docId: string;
let ownerToken: string;
let strangerToken: string;

const params = (id: string, rid?: string) => ({ params: Promise.resolve(rid ? { id, rid } : { id }) }) as { params: Promise<{ id: string; rid: string }> };
const jsonReq = (url: string, body?: unknown, method = "POST") =>
  new Request(`http://localhost:3700${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const as = async <T>(who: Actor | null, fn: () => Promise<T>, token?: string) => {
  const saved = actor;
  const savedHeaders = requestHeaders;
  actor = who;
  requestHeaders = token ? new Headers({ authorization: ["Bearer", token].join(" ") }) : new Headers();
  try {
    return await fn();
  } finally {
    actor = saved;
    requestHeaders = savedHeaders;
  }
};
const ownerActor = () => ({ id: owner.id, login: owner.login, name: owner.name, image: null });
const agentActor = (name = "Copilot CLI") => ({ ...ownerActor(), agent: name });

beforeAll(async () => {
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ name: "Olive", login: "olive", email: "olive@example.com" }).returning();
  const [c] = await db.insert(schema.users).values({ name: "Cam", login: "cam", email: "cam@example.com" }).returning();
  const [v] = await db.insert(schema.users).values({ name: "Vic", login: "vic", email: "vic@example.com" }).returning();
  const [s] = await db.insert(schema.users).values({ name: "Sam", login: "sam", email: "sam@example.com" }).returning();
  owner = { id: o.id, login: "olive", name: "Olive", image: null };
  commenter = { id: c.id, login: "cam", name: "Cam", image: null };
  viewer = { id: v.id, login: "vic", name: "Vic", image: null };
  stranger = { id: s.id, login: "sam", name: "Sam", image: null };
  const doc = await createDocument({ ownerId: owner.id, title: "Asked", content: "# Asked\n\nThe quick brown fox jumps over the lazy dog.\n" });
  docId = doc.id;
  await upsertCollaborator(docId, "cam", "commenter", owner.id);
  await upsertCollaborator(docId, "vic", "viewer", owner.id);
  ownerToken = (await createApiToken(owner.id, "Copilot CLI")).token;
  strangerToken = (await createApiToken(stranger.id, "Sam's agent")).token;
});

describe("agent requests (server module)", () => {
  it("runs the lifecycle: create → claim → work → complete, with activity, notification and the live mirror", async () => {
    const created = await createRequest(docId, ownerActor(), "owner", { instruction: "Tighten this", selection: { from: 10, to: 53, quote: "The quick brown fox jumps over the lazy dog." }, mode: "suggest" });
    expect(created).toMatchObject({ status: "open", mode: "suggest", claimedBy: null, result: null, userId: owner.id });
    expect(created.selection).toEqual({ from: 10, to: 53, quote: "The quick brown fox jumps over the lazy dog." });
    expect((await readMirror(docId))[created.id]).toMatchObject({ status: "open", instruction: "Tighten this" });

    const claimed = await claimRequest(docId, created.id, agentActor());
    expect(claimed).toMatchObject({ status: "claimed", claimedBy: "Copilot CLI" });
    // Idempotent for the same agent, 409 for another.
    expect((await claimRequest(docId, created.id, agentActor())).status).toBe("claimed");
    await expect(claimRequest(docId, created.id, agentActor("Other bot"))).rejects.toMatchObject({ status: 409 });
    expect((await readMirror(docId))[created.id]).toMatchObject({ status: "claimed", claimedBy: "Copilot CLI" });

    const worked = await attachWork(docId, created.id, agentActor(), { suggestions: 2, suggestionIds: ["s1", "s2"] });
    expect(worked.result).toMatchObject({ suggestions: 2, comments: 0, suggestionIds: ["s1", "s2"] });

    const done = await completeRequest(docId, created.id, agentActor(), { summary: "Shortened the sentence." });
    expect(done).toMatchObject({ status: "done", claimedBy: "Copilot CLI" });
    expect(done.result).toMatchObject({ suggestions: 2, comments: 0, summary: "Shortened the sentence.", suggestionIds: ["s1", "s2"] });
    expect((await readMirror(docId))[created.id]).toMatchObject({ status: "done", result: { suggestions: 2 } });

    const activity = await listActivity(docId);
    const asked = activity.items.find((i) => i.action === "agent.request" && i.detail.requestId === created.id);
    const finished = activity.items.find((i) => i.action === "agent.request.done" && i.detail.requestId === created.id);
    expect(asked).toMatchObject({ actorKind: "user", actorName: "Olive", detail: { mode: "suggest", instruction: "Tighten this" } });
    expect(finished).toMatchObject({ actorKind: "agent", actorName: "Copilot CLI", detail: { suggestions: 2, comments: 0, summary: "Shortened the sentence." } });

    // The requester hears about it even though the agent acts on their behalf.
    const page = await listNotifications("olive", { kind: "request.done" });
    expect(page.items.find((n) => n.refId === created.id)).toMatchObject({ kind: "request.done", actorName: "Copilot CLI", snippet: "Shortened the sentence." });

    // Completing twice is a no-op; cancelling a done request is a 409.
    expect((await completeRequest(docId, created.id, agentActor())).status).toBe("done");
    await expect(cancelRequest(docId, created.id, ownerActor(), "owner")).rejects.toMatchObject({ status: 409 });
  });

  it("enforces modes by role and lets only the requester or owner cancel", async () => {
    await expect(createRequest(docId, { ...viewer }, "viewer", { instruction: "Fix it", mode: "suggest" })).rejects.toMatchObject({ status: 403 });
    await expect(createRequest(docId, { ...viewer }, "viewer", { instruction: "Fix it", mode: "comment" })).rejects.toMatchObject({ status: 403 });
    await expect(createRequest(docId, { ...commenter }, "commenter", { instruction: "Fix it", mode: "rewrite" })).rejects.toMatchObject({ status: 403 });
    const byCommenter = await createRequest(docId, { ...commenter }, "commenter", { instruction: "Any thoughts?", mode: "comment" });
    expect(byCommenter.status).toBe("open");
    await expect(createRequest(docId, ownerActor(), "owner", { instruction: "   ", mode: "suggest" })).rejects.toMatchObject({ status: 400 });
    await expect(createRequest(docId, ownerActor(), "owner", { instruction: "x".repeat(2001), mode: "suggest" })).rejects.toMatchObject({ status: 400 });

    // A viewer cannot cancel someone else's request; the requester and the owner can.
    await expect(cancelRequest(docId, byCommenter.id, { ...viewer }, "viewer")).rejects.toMatchObject({ status: 403 });
    const cancelled = await cancelRequest(docId, byCommenter.id, { ...commenter }, "commenter");
    expect(cancelled.status).toBe("cancelled");
    expect((await readMirror(docId))[byCommenter.id]).toMatchObject({ status: "cancelled" });
    await expect(claimRequest(docId, byCommenter.id, agentActor())).rejects.toMatchObject({ status: 409 });
    await expect(completeRequest(docId, byCommenter.id, agentActor())).rejects.toMatchObject({ status: 409 });

    const open = await listRequests(docId, { status: "open" });
    expect(open.find((r) => r.id === byCommenter.id)).toBeUndefined();
    const all = await listRequests(docId);
    expect(all.find((r) => r.id === byCommenter.id)?.status).toBe("cancelled");
  });

  it("scopes the cross-document listing to documents the token's user can see", async () => {
    const other = await createDocument({ ownerId: stranger.id, title: "Sam's", content: "Private\n" });
    const mine = await createRequest(docId, ownerActor(), "owner", { instruction: "Please review", mode: "comment" });
    const theirs = await createRequest(other.id, { ...stranger }, "owner", { instruction: "Secret", mode: "suggest" });

    const forOwner = await listRequestsForUser(owner);
    expect(forOwner.map((r) => r.id)).toContain(mine.id);
    expect(forOwner.map((r) => r.id)).not.toContain(theirs.id);
    expect(forOwner.find((r) => r.id === mine.id)).toMatchObject({ documentTitle: "Asked", userLogin: "olive", status: "open" });

    // Commenter collaborators see the document's requests too; a stranger only sees their own.
    expect((await listRequestsForUser(commenter)).map((r) => r.id)).toContain(mine.id);
    const forStranger = await listRequestsForUser(stranger);
    expect(forStranger.map((r) => r.id)).toEqual([theirs.id]);

    await cancelRequest(docId, mine.id, ownerActor(), "owner");
    await cancelRequest(other.id, theirs.id, { ...stranger }, "owner");
  });
});

describe("agent request routes", () => {
  it("POST /requests needs comment access and the right mode; strangers get 404; GET lists for viewers", async () => {
    expect((await as(null, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Hi" }), params(docId)))).status).toBe(401);
    expect((await as(stranger, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Hi" }), params(docId)))).status).toBe(404);
    expect((await as(stranger, () => GET_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, undefined, "GET"), params(docId)))).status).toBe(404);
    expect((await as(viewer, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Hi", mode: "suggest" }), params(docId)))).status).toBe(403);
    expect((await as(commenter, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Hi", mode: "suggest" }), params(docId)))).status).toBe(403);
    expect((await as(owner, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "" }), params(docId)))).status).toBe(400);

    const res = await as(commenter, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Thoughts?", mode: "comment" }), params(docId)));
    expect(res.status).toBe(201);
    const { request } = (await res.json()) as { request: { id: string; status: string } };
    expect(request.status).toBe("open");

    const list = await as(viewer, () => GET_REQUESTS(jsonReq(`/api/documents/${docId}/requests?status=open`, undefined, "GET"), params(docId)));
    expect(list.status).toBe(200);
    const { requests } = (await list.json()) as { requests: { id: string }[] };
    expect(requests.map((r) => r.id)).toContain(request.id);

    // Cancel: a viewer who did not ask cannot; the requester can.
    expect((await as(viewer, () => POST_CANCEL(jsonReq(`/api/documents/${docId}/requests/${request.id}/cancel`), params(docId, request.id)))).status).toBe(403);
    const cancel = await as(commenter, () => POST_CANCEL(jsonReq(`/api/documents/${docId}/requests/${request.id}/cancel`), params(docId, request.id)));
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as { request: { status: string } }).request.status).toBe("cancelled");
  });

  it("runs the agent loop over REST: token lists → claim → suggest with requestId → comment with requestId → complete", async () => {
    const created = await as(owner, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Tighten this", mode: "suggest", selection: { from: 10, to: 53, quote: "The quick brown fox jumps over the lazy dog." } }), params(docId)));
    const { request } = (await created.json()) as { request: { id: string } };

    // The inbox is token-only.
    expect((await as(owner, () => GET_AGENT_REQUESTS(jsonReq("/api/agent/requests", undefined, "GET")))).status).toBe(403);
    expect((await as(null, () => GET_AGENT_REQUESTS(jsonReq("/api/agent/requests", undefined, "GET")))).status).toBe(401);
    const inbox = await as(null, () => GET_AGENT_REQUESTS(jsonReq("/api/agent/requests?status=open", undefined, "GET")), ownerToken);
    expect(inbox.status).toBe(200);
    const inboxBody = (await inbox.json()) as { agent: string; requests: { id: string; documentId: string; documentTitle: string }[] };
    expect(inboxBody.agent).toBe("Copilot CLI");
    expect(inboxBody.requests.find((r) => r.id === request.id)).toMatchObject({ documentId: docId, documentTitle: "Asked" });
    // Sam's token cannot see Olive's document.
    const strangerInbox = (await (await as(null, () => GET_AGENT_REQUESTS(jsonReq("/api/agent/requests", undefined, "GET")), strangerToken)).json()) as { requests: { id: string }[] };
    expect(strangerInbox.requests.map((r) => r.id)).not.toContain(request.id);
    expect((await as(null, () => POST_CLAIM(jsonReq(`/api/documents/${docId}/requests/${request.id}/claim`), params(docId, request.id)), strangerToken)).status).toBe(404);

    const claim = await as(null, () => POST_CLAIM(jsonReq(`/api/documents/${docId}/requests/${request.id}/claim`), params(docId, request.id)), ownerToken);
    expect(claim.status).toBe(200);
    expect(((await claim.json()) as { request: { status: string; claimedBy: string } }).request).toMatchObject({ status: "claimed", claimedBy: "Copilot CLI" });

    const suggest = await as(null, () => POST_SUGGEST(jsonReq(`/api/documents/${docId}/suggest`, { edits: [{ find: "jumps over", replace: "leaps over" }], requestId: request.id }), params(docId)), ownerToken);
    expect(suggest.status).toBe(200);
    const suggested = (await suggest.json()) as { suggestions: number; suggestionIds: string[] };
    expect(suggested.suggestions).toBeGreaterThan(0);
    expect(suggested.suggestionIds).toHaveLength(suggested.suggestions);

    const comment = await as(null, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "add", quote: "lazy dog", body: "Consider a livelier dog.", requestId: request.id }), params(docId)), ownerToken);
    expect(comment.status).toBe(200);
    const { id: threadId } = (await comment.json()) as { id: string };

    // Unknown request ids are rejected, finished ones too (checked below).
    expect((await as(null, () => POST_SUGGEST(jsonReq(`/api/documents/${docId}/suggest`, { edits: [{ find: "quick", replace: "fast" }], requestId: "nope" }), params(docId)), ownerToken)).status).toBe(404);

    const complete = await as(null, () => POST_COMPLETE(jsonReq(`/api/documents/${docId}/requests/${request.id}/complete`, { summary: "Tightened." }), params(docId, request.id)), ownerToken);
    expect(complete.status).toBe(200);
    const doneBody = (await complete.json()) as { request: { status: string; result: { suggestions: number; comments: number; summary: string; suggestionIds: string[]; commentIds: string[] } } };
    expect(doneBody.request.status).toBe("done");
    expect(doneBody.request.result).toMatchObject({ suggestions: suggested.suggestions, comments: 1, summary: "Tightened.", commentIds: [threadId] });
    expect(doneBody.request.result.suggestionIds).toEqual(suggested.suggestionIds);

    expect((await as(null, () => POST_SUGGEST(jsonReq(`/api/documents/${docId}/suggest`, { edits: [{ find: "quick", replace: "fast" }], requestId: request.id }), params(docId)), ownerToken)).status).toBe(409);
    // Empty body completes too (idempotent).
    expect((await as(null, () => POST_COMPLETE(new Request(`http://localhost:3700/api/documents/${docId}/requests/${request.id}/complete`, { method: "POST" }), params(docId, request.id)), ownerToken)).status).toBe(200);

    const db = await getDb();
    const [row] = await db.select().from(schema.agentRequests).where(eq(schema.agentRequests.id, request.id));
    expect(row.status).toBe("done");
    const notifications = await listNotifications("olive", { kind: "request.done" });
    expect(notifications.items.find((n) => n.refId === request.id)).toMatchObject({ actorName: "Copilot CLI", snippet: "Tightened." });
    const activity = await listActivity(docId);
    expect(activity.items.some((i) => i.action === "suggestion.add" && i.detail.requestId === request.id)).toBe(true);
    expect(activity.items.some((i) => i.action === "agent.request.done" && i.detail.requestId === request.id)).toBe(true);
  });
});

describe("query validation (#186)", () => {
  type Err = { error: string; issues?: { path: (string | number)[]; message: string }[] };
  const inbox = (qs: string) => as(null, () => GET_AGENT_REQUESTS(jsonReq(`/api/agent/requests${qs}`, undefined, "GET")), ownerToken);
  const onDoc = (qs: string) => as(owner, () => GET_REQUESTS(jsonReq(`/api/documents/${docId}/requests${qs}`, undefined, "GET"), params(docId)));
  const expectInvalid = async (res: Response, path: string) => {
    expect(res.status).toBe(400);
    const body = (await res.json()) as Err;
    expect(body.error).toBe("Invalid request");
    expect(body.issues?.[0]?.path[0]).toBe(path);
  };

  it("GET /api/agent/requests rejects unknown or empty status members and a limit outside 1–200", async () => {
    for (const status of ["bogus", "claimd", "open,,claimed", "open,bogus", "", "OPEN"]) await expectInvalid(await inbox(`?status=${status}`), "status");
    for (const limit of ["0", "abc", "-5", "100000", "201", "1.5"]) await expectInvalid(await inbox(`?limit=${limit}`), "limit");
    // Both wrong: the first issue names the first bad field, as for the other routes.
    await expectInvalid(await inbox("?status=bogus&limit=abc"), "status");
  });

  it("GET /api/agent/requests still honours a valid status list and limit", async () => {
    for (let i = 0; i < 3; i++) await createRequest(docId, ownerActor(), "owner", { instruction: `Filler ${i}`, mode: "comment" });
    const claimed = await createRequest(docId, ownerActor(), "owner", { instruction: "Claim me", mode: "comment" });
    await claimRequest(docId, claimed.id, agentActor());

    const res = await inbox("?status=open,claimed&limit=2");
    expect(res.status).toBe(200);
    const { requests } = (await res.json()) as { requests: { status: string }[] };
    expect(requests.length).toBeLessThanOrEqual(2);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(["open", "claimed"]).toContain(r.status);

    const done = (await (await inbox("?status=done")).json()) as { requests: { status: string }[] };
    for (const r of done.requests) expect(r.status).toBe("done");
    expect(done.requests.length).toBeGreaterThan(0);

    const only = (await (await inbox("?status=claimed&limit=200")).json()) as { requests: { id: string; status: string }[] };
    expect(only.requests.map((r) => r.id)).toContain(claimed.id);
    for (const r of only.requests) expect(r.status).toBe("claimed");

    const dflt = (await (await inbox("")).json()) as { requests: { status: string }[] };
    for (const r of dflt.requests) expect(r.status).toBe("open");
  });

  it("GET /api/documents/:id/requests rejects an unknown status and filters a valid one", async () => {
    for (const status of ["bogus", "open,,claimed", "done,nope", ""]) await expectInvalid(await onDoc(`?status=${status}`), "status");

    const all = (await (await onDoc("")).json()) as { requests: { status: string }[] };
    const statuses = new Set(all.requests.map((r) => r.status));
    expect(statuses.size).toBeGreaterThan(1);

    const some = (await (await onDoc("?status=open,claimed")).json()) as { requests: { status: string }[] };
    expect(some.requests.length).toBeGreaterThan(0);
    expect(some.requests.length).toBeLessThan(all.requests.length);
    for (const r of some.requests) expect(["open", "claimed"]).toContain(r.status);
  });
});
