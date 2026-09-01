import { afterEach, describe, expect, it, beforeAll, vi } from "vitest";
import type * as Y from "yjs";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
// The routes are called with no socket address, so the file's 31 POSTs share one `write:ip:unknown` bucket
// (burst 30, refill 2/s): whether the last one is a 429 depends on elapsed time. Off, as in comments-api.test.ts.
process.env.RATE_LIMIT = "off";
delete process.env.DATABASE_URL;

// Same stand-ins as star.test.ts: routes resolve the caller through next-auth and `next/headers`.
// A bearer token in `requestHeaders` takes precedence (that is how agents call in).
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
let requestHeaders = new Headers();
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
// Wrapped so a test can make the activity step or the requester's notification fail at the right moment. The
// request functions write their activity row on their own transaction (not through `recordActivity`, which
// opens its own connection), so the activity step is failed at the row's actor mapping, `activityActor`.
vi.mock("@/server/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/activity")>();
  return { ...actual, activityActor: vi.fn(actual.activityActor) };
});
vi.mock("@/server/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/notifications")>();
  return { ...actual, notify: vi.fn(actual.notify) };
});
// `attachWork` fetches the connection between its pre-check and its update: the seam for the cancel race.
vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  return { ...actual, getDb: vi.fn(actual.getDb) };
});

const { getDb, schema } = await import("@/server/db");
const { eq } = await import("drizzle-orm");
const { createDocument, upsertCollaborator } = await import("@/server/documents");
const { createApiToken, setCollaboratorsMayAsk } = await import("@/server/tokens");
const { listNotifications, notify } = await import("@/server/notifications");
const { listActivity, activityActor } = await import("@/server/activity");
const { createRequest, listRequests, listRequestsForUser, claimRequest, completeRequest, cancelRequest, attachWork, readMirror } = await import("@/server/agent-requests");
const { pollEvents } = await import("@/server/agent-events");
const { readLiveDoc } = await import("@/server/livedoc");
const { POST: POST_REQUESTS, GET: GET_REQUESTS } = await import("@/app/api/documents/[id]/requests/route");
const { POST: POST_CLAIM } = await import("@/app/api/documents/[id]/requests/[rid]/claim/route");
const { POST: POST_COMPLETE } = await import("@/app/api/documents/[id]/requests/[rid]/complete/route");
const { POST: POST_CANCEL } = await import("@/app/api/documents/[id]/requests/[rid]/cancel/route");
const { GET: GET_AGENT_REQUESTS } = await import("@/app/api/agent/requests/route");
const { POST: POST_SUGGEST } = await import("@/app/api/documents/[id]/suggest/route");
const { POST: POST_COMMENTS, GET: GET_COMMENTS } = await import("@/app/api/documents/[id]/comments/route");

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
  const minted = await createApiToken(owner.id, "Copilot CLI");
  ownerToken = minted.token;
  // Olive lets collaborators address her agent (#1296): Cam's requests below are addressed to `@olive/copilot-cli`.
  await setCollaboratorsMayAsk(owner.id, minted.id, true);
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

    const { request: done, ...completion } = await completeRequest(docId, created.id, agentActor(), { summary: "Shortened the sentence." });
    expect(done).toMatchObject({ status: "done", claimedBy: "Copilot CLI" });
    expect(done.result).toMatchObject({ suggestions: 2, comments: 0, summary: "Shortened the sentence.", suggestionIds: ["s1", "s2"] });
    // The success shape carries no `warnings` key.
    expect(completion).toEqual({ notified: true, alreadyDone: false });
    expect((await readMirror(docId))[created.id]).toMatchObject({ status: "done", result: { suggestions: 2 } });

    const activity = await listActivity(docId);
    const asked = activity.items.find((i) => i.action === "agent.request" && i.detail.requestId === created.id);
    const finished = activity.items.find((i) => i.action === "agent.request.done" && i.detail.requestId === created.id);
    expect(asked).toMatchObject({ actorKind: "user", actorName: "Olive", detail: { mode: "suggest", instruction: "Tighten this" } });
    expect(finished).toMatchObject({ actorKind: "agent", actorName: "Copilot CLI", detail: { suggestions: 2, comments: 0, summary: "Shortened the sentence." } });

    // The requester hears about it even though the agent acts on their behalf.
    const page = await listNotifications("olive", { kind: "request.done" });
    expect(page.items.find((n) => n.refId === created.id)).toMatchObject({ kind: "request.done", actorName: "Copilot CLI", snippet: "Shortened the sentence." });

    // Completing twice writes nothing (`alreadyDone`), the notification is still there once; cancelling a done request is a 409.
    expect(await completeRequest(docId, created.id, agentActor())).toEqual({ request: expect.objectContaining({ status: "done" }), notified: true, alreadyDone: true });
    expect((await listNotifications("olive", { kind: "request.done" })).items.filter((n) => n.refId === created.id)).toHaveLength(1);
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
    // Cam's own agent hears the status (409); an outsider is refused first (403), the state stays private (#1296).
    const camBot = { ...commenter, agent: "Cam bot" };
    await expect(claimRequest(docId, byCommenter.id, camBot)).rejects.toMatchObject({ status: 409 });
    await expect(completeRequest(docId, byCommenter.id, camBot)).rejects.toMatchObject({ status: 409 });
    await expect(claimRequest(docId, byCommenter.id, agentActor())).rejects.toMatchObject({ status: 403, message: "Request can only be worked by Cam's own agents" });
    await expect(completeRequest(docId, byCommenter.id, agentActor())).rejects.toMatchObject({ status: 403 });

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

    // Unaddressed requests go to the requester's own agents: a commenter collaborator no longer sees the owner's
    // (#1296); a stranger only sees their own.
    expect((await listRequestsForUser(commenter)).map((r) => r.id)).not.toContain(mine.id);
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
    const doneBody = (await complete.json()) as { request: { status: string; result: { suggestions: number; comments: number; summary: string; suggestionIds: string[]; commentIds: string[] } }; notified: boolean; alreadyDone: boolean; warnings?: string[] };
    expect(doneBody.request.status).toBe("done");
    expect(doneBody.request.result).toMatchObject({ suggestions: suggested.suggestions, comments: 1, summary: "Tightened.", commentIds: [threadId] });
    expect(doneBody.request.result.suggestionIds).toEqual(suggested.suggestionIds);
    expect(doneBody).toEqual({ request: expect.any(Object), notified: true, alreadyDone: false });

    expect((await as(null, () => POST_SUGGEST(jsonReq(`/api/documents/${docId}/suggest`, { edits: [{ find: "quick", replace: "fast" }], requestId: request.id }), params(docId)), ownerToken)).status).toBe(409);
    // Empty body completes too (idempotent): nothing is written, the body says so.
    const again = await as(null, () => POST_COMPLETE(new Request(`http://localhost:3700/api/documents/${docId}/requests/${request.id}/complete`, { method: "POST" }), params(docId, request.id)), ownerToken);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ request: expect.objectContaining({ status: "done" }), notified: true, alreadyDone: true });

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

describe("requests made from a comment thread (#997)", () => {
  type Thread = { id: string; replies: { id: string; body: string; author: string }[] };
  const threads = async () => (await (await as(owner, () => GET_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, undefined, "GET"), params(docId)))).json()) as { comments: Thread[] };
  const replyNotifications = async (login: string) => (await listNotifications(login, { kind: "reply" })).items;
  const stampedRequestId = (threadId: string) => readLiveDoc(docId, (doc) => (doc.getMap("comments").get(threadId) as Y.Map<unknown> | undefined)?.get("requestId"));

  it("stores threadId, stamps requestId on the thread map, mirrors it and carries it on request.created; null without", async () => {
    const add = await as(commenter, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "add", quote: "brown fox", body: "Is this the right animal?" }), params(docId)));
    expect(add.status).toBe(200);
    const { id: threadId } = (await add.json()) as { id: string };
    const { cursor } = await pollEvents(docId, agentActor(), null, 0);
    const { cursor: inboxCursor } = await pollEvents(null, agentActor(), null, 0);

    const fromThread = await createRequest(docId, { ...commenter }, "commenter", { instruction: "Check the animal", mode: "comment", threadId, agent: "olive/copilot-cli" });
    expect(fromThread.threadId).toBe(threadId);
    expect((await listRequests(docId)).find((r) => r.id === fromThread.id)?.threadId).toBe(threadId);
    expect((await listRequestsForUser(agentActor())).find((r) => r.id === fromThread.id)?.threadId).toBe(threadId);
    expect((await readMirror(docId))[fromThread.id]).toMatchObject({ status: "open", threadId });
    expect(await stampedRequestId(threadId)).toBe(fromThread.id);
    const asked = (await listActivity(docId)).items.find((i) => i.action === "agent.request" && i.detail.requestId === fromThread.id);
    expect(asked?.detail.threadId).toBe(threadId);

    const fromDialog = await createRequest(docId, ownerActor(), "owner", { instruction: "Tighten this", mode: "suggest" });
    expect(fromDialog.threadId).toBeNull();
    expect((await readMirror(docId))[fromDialog.id]).toMatchObject({ threadId: null });

    // Both watches (per document from the activity row, inbox from the request row) carry the field.
    const page = await pollEvents(docId, agentActor(), cursor, 0);
    const created = page.events.filter((e) => e.type === "request.created") as { requestId: string; threadId: string | null }[];
    expect(created.find((e) => e.requestId === fromThread.id)?.threadId).toBe(threadId);
    expect(created.find((e) => e.requestId === fromDialog.id)?.threadId).toBeNull();
    const inbox = await pollEvents(null, agentActor(), inboxCursor, 0);
    const inboxCreated = inbox.events.filter((e) => e.type === "request.created") as { requestId: string; threadId: string | null }[];
    expect(inboxCreated.find((e) => e.requestId === fromThread.id)?.threadId).toBe(threadId);
    expect(inboxCreated.find((e) => e.requestId === fromDialog.id)?.threadId).toBeNull();

    // A later request on the same thread takes over the stamp (the card shows the latest).
    const again = await createRequest(docId, ownerActor(), "owner", { instruction: "And the colour?", mode: "comment", threadId });
    expect(await stampedRequestId(threadId)).toBe(again.id);

    await cancelRequest(docId, fromThread.id, ownerActor(), "owner");
    await cancelRequest(docId, fromDialog.id, ownerActor(), "owner");
    await cancelRequest(docId, again.id, ownerActor(), "owner");
  });

  it("refuses a threadId that is not a thread of the document (nothing stored)", async () => {
    const before = (await listRequests(docId)).length;
    await expect(createRequest(docId, ownerActor(), "owner", { instruction: "Hi", mode: "comment", threadId: "no-such-thread" })).rejects.toMatchObject({ status: 404 });
    expect((await listRequests(docId)).length).toBe(before);
    const res = await as(owner, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Hi", mode: "comment", threadId: "no-such-thread" }), params(docId)));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("Comment not found");
  });

  it("counts a reply with requestId as work and records the reply id; the thread starter gets no reply notification", async () => {
    // Cam starts the thread and asks; Olive's agent answers in it. Cam would normally hear `reply` from Olive.
    const add = await as(commenter, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "add", quote: "lazy dog", body: "Too lazy?" }), params(docId)));
    const { id: threadId } = (await add.json()) as { id: string };
    const res = await as(commenter, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Is the dog too lazy?", mode: "comment", threadId, agent: "@olive/copilot-cli" }), params(docId)));
    expect(res.status).toBe(201);
    const { request } = (await res.json()) as { request: { id: string; threadId: string | null; agent: { login: string; slug: string } | null } };
    expect(request.threadId).toBe(threadId);
    expect(request.agent).toEqual({ login: "olive", slug: "copilot-cli" });
    const camBefore = (await replyNotifications("cam")).length;
    // Cam's own agent watches the document and the inbox; the mention in the agent's reply reaches both.
    const cam = { id: commenter.id, login: commenter.login, name: commenter.name, image: null };
    const { cursor: camDocCursor } = await pollEvents(docId, cam, null, 0);
    const { cursor: camInboxCursor } = await pollEvents(null, cam, null, 0);
    await new Promise((r) => setTimeout(r, 20));

    expect((await as(null, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "reply", threadId, body: "It is fine.", requestId: "nope" }), params(docId)), ownerToken)).status).toBe(404);
    const reply = await as(null, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "reply", threadId, body: "The dog is fine, @cam.", requestId: request.id }), params(docId)), ownerToken);
    expect(reply.status).toBe(200);
    const { id: replyId } = (await reply.json()) as { id: string };
    const thread = (await threads()).comments.find((t) => t.id === threadId)!;
    expect(thread.replies.map((r) => r.id)).toEqual([replyId]);
    // The 404 above wrote nothing.
    expect(thread.replies).toHaveLength(1);

    const worked = (await listRequests(docId)).find((r) => r.id === request.id)!;
    expect(worked).toMatchObject({ status: "claimed", claimedBy: "Copilot CLI", claimedByLogin: "olive", result: { suggestions: 0, comments: 1, commentIds: [replyId] } });
    expect((await listActivity(docId)).items.find((i) => i.action === "comment.reply" && i.detail.replyId === replyId)?.detail.requestId).toBe(request.id);

    // No `reply` for the request-linked answer; the mention inside it still reaches Cam.
    expect((await replyNotifications("cam")).length).toBe(camBefore);
    expect((await listNotifications("cam", { kind: "mention" })).items.find((n) => n.refId === replyId)).toMatchObject({ actorName: "Copilot CLI" });
    // As an event, the reply mention names the thread it sits in (`refId` is the reply), on the document watch and in the inbox.
    const camDocPage = await pollEvents(docId, cam, camDocCursor, 0);
    expect(camDocPage.events.filter((e) => e.type === "mention")).toEqual([expect.objectContaining({ refId: replyId, threadId, by: "Copilot CLI", byLogin: "olive", snippet: "The dog is fine, @cam." })]);
    const camInboxPage = await pollEvents(null, cam, camInboxCursor, 0);
    expect(camInboxPage.events.filter((e) => e.type === "mention")).toEqual([expect.objectContaining({ documentId: docId, refId: replyId, threadId })]);

    // A plain reply (no requestId) notifies as today.
    const plain = await as(null, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "reply", threadId, body: "Also: nice fox." }), params(docId)), ownerToken);
    const { id: plainId } = (await plain.json()) as { id: string };
    const camAfter = await replyNotifications("cam");
    expect(camAfter.length).toBe(camBefore + 1);
    expect(camAfter.find((n) => n.refId === plainId)).toBeTruthy();
    expect((await listRequests(docId)).find((r) => r.id === request.id)?.result).toMatchObject({ comments: 1 });

    const done = await as(null, () => POST_COMPLETE(jsonReq(`/api/documents/${docId}/requests/${request.id}/complete`, { summary: "Answered in the thread." }), params(docId, request.id)), ownerToken);
    expect(((await done.json()) as { request: { result: { comments: number } } }).request.result.comments).toBe(1);
  });

  it("folds `add` + requestId into the request's thread as a reply (quote ignored, no new thread, no reply notification)", async () => {
    const add = await as(commenter, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "add", quote: "quick", body: "@olive/copilot-cli Quick enough?" }), params(docId)));
    const { id: threadId } = (await add.json()) as { id: string };
    // No `agent` given: the thread's root comment mentions `@olive/copilot-cli`, which addresses the request.
    const fromThread = await createRequest(docId, { ...commenter }, "commenter", { instruction: "Quick enough?", mode: "comment", threadId });
    expect(fromThread.agent).toEqual({ login: "olive", slug: "copilot-cli" });
    const before = (await threads()).comments.length;
    const camBefore = (await replyNotifications("cam")).length;

    // Legacy agent: `add` with a quote, but the request came from Cam's thread → a reply there, quote ignored.
    const folded = await as(null, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "add", quote: "quick", body: "Yes, quick is right.", requestId: fromThread.id }), params(docId)), ownerToken);
    expect(folded.status).toBe(200);
    const foldedBody = (await folded.json()) as { id: string; threadId?: string; folded?: boolean };
    expect(foldedBody).toEqual({ id: expect.any(String), threadId, folded: true });
    const after = await threads();
    expect(after.comments).toHaveLength(before);
    expect(after.comments.find((t) => t.id === threadId)?.replies.map((r) => [r.id, r.body, r.author])).toEqual([[foldedBody.id, "Yes, quick is right.", "Copilot CLI"]]);
    expect((await listRequests(docId)).find((r) => r.id === fromThread.id)).toMatchObject({ status: "claimed", result: { comments: 1, commentIds: [foldedBody.id] } });
    const activity = await listActivity(docId);
    expect(activity.items.find((i) => i.action === "comment.reply" && i.detail.replyId === foldedBody.id)?.detail).toMatchObject({ threadId, requestId: fromThread.id });
    expect(activity.items.some((i) => i.action === "comment.add" && i.detail.requestId === fromThread.id)).toBe(false);
    expect((await replyNotifications("cam")).length).toBe(camBefore);

    // A done request refuses more work: the pre-check answers 409 before anything is written, so the thread
    // keeps its one reply (since #1229 nothing is written and then taken back out).
    await completeRequest(docId, fromThread.id, agentActor());
    const refused = await as(null, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "add", body: "Late answer.", requestId: fromThread.id }), params(docId)), ownerToken);
    expect(refused.status).toBe(409);
    expect((await threads()).comments.find((t) => t.id === threadId)?.replies).toHaveLength(1);
  });

  it("leaves `add` + requestId unchanged for a request without threadId: a new thread on the quote, `{ id }` only", async () => {
    const fromDialog = await createRequest(docId, ownerActor(), "owner", { instruction: "Comment on the dog", mode: "comment", selection: { from: 40, to: 48, quote: "lazy dog" } });
    const before = (await threads()).comments.length;
    const twin = await as(null, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "add", quote: "lazy dog", body: "Consider a livelier dog.", requestId: fromDialog.id }), params(docId)), ownerToken);
    expect(twin.status).toBe(200);
    const twinBody = (await twin.json()) as { id: string; folded?: boolean };
    expect(twinBody).toEqual({ id: expect.any(String) });
    const now = await threads();
    expect(now.comments).toHaveLength(before + 1);
    expect(now.comments.find((t) => t.id === twinBody.id)?.replies).toEqual([]);
    expect((await listRequests(docId)).find((r) => r.id === fromDialog.id)?.result).toMatchObject({ comments: 1, commentIds: [twinBody.id] });
    expect((await listActivity(docId)).items.some((i) => i.action === "comment.add" && i.detail.requestId === fromDialog.id && i.detail.threadId === twinBody.id)).toBe(true);
    await completeRequest(docId, fromDialog.id, agentActor());
  });

  it("GET /api/agent/requests serialises threadId (null for dialog requests)", async () => {
    const add = await as(owner, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "add", quote: "jumps", body: "Or leaps?" }), params(docId)));
    const { id: threadId } = (await add.json()) as { id: string };
    const fromThread = await createRequest(docId, ownerActor(), "owner", { instruction: "Or leaps?", mode: "comment", threadId });
    const fromDialog = await createRequest(docId, ownerActor(), "owner", { instruction: "Whole document", mode: "comment" });
    const inbox = (await (await as(null, () => GET_AGENT_REQUESTS(jsonReq("/api/agent/requests?status=open", undefined, "GET")), ownerToken)).json()) as { requests: { id: string; threadId: string | null }[] };
    expect(inbox.requests.find((r) => r.id === fromThread.id)).toMatchObject({ threadId });
    const dialogItem = inbox.requests.find((r) => r.id === fromDialog.id)!;
    expect("threadId" in dialogItem).toBe(true);
    expect(dialogItem.threadId).toBeNull();
    await cancelRequest(docId, fromThread.id, ownerActor(), "owner");
    await cancelRequest(docId, fromDialog.id, ownerActor(), "owner");
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

/**
 * `docs/agents.md` promises that a non-2xx status means nothing changed (audit #1202 F13 / F14 / Q5): the request's
 * status and its activity row are one write, the requester's notification is a warning code when it fails and is
 * attempted again on a retry, a request is never written back to `claimed` once it was cancelled or completed.
 */
describe("the non-2xx promise for requests (#1232)", () => {
  let reqDocId: string;
  const rowOf = async (id: string) => (await (await getDb()).select().from(schema.agentRequests).where(eq(schema.agentRequests.id, id)))[0];
  const doneRows = async (id: string) => (await listActivity(reqDocId, { limit: 100 })).items.filter((a) => a.action === "agent.request.done" && a.detail.requestId === id);
  const askedRows = async (id: string) => (await listActivity(reqDocId, { limit: 100 })).items.filter((a) => a.action === "agent.request" && a.detail.requestId === id);
  const doneNotifications = async (id: string) => (await listNotifications("olive", { kind: "request.done" })).items.filter((n) => n.refId === id);
  /** Runs `fn` with console.error silenced; returns its result and the `[requests]`-prefixed lines it logged. */
  const quietly = async <T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await fn();
      return { result, logged: errors.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith("[requests]")) };
    } finally {
      errors.mockRestore();
    }
  };
  const failActivityStep = () =>
    vi.mocked(activityActor).mockImplementationOnce(() => {
      throw new Error('Failed query: insert into "activity" ("id", "document_id") values ($1, $2) params: abc,secret-owner-uuid');
    });

  beforeAll(async () => {
    const doc = await createDocument({ ownerId: owner.id, title: "Atomic", content: "# Atomic\n\nA sentence to tighten.\n" });
    reqDocId = doc.id;
  });
  afterEach(() => {
    // A failure armed with `...Once` and never consumed must not leak into the next test.
    vi.mocked(activityActor).mockReset();
    vi.mocked(notify).mockReset();
    vi.mocked(getDb).mockReset();
  });

  it("completeRequest: the activity row failing rolls the status back — the request is still claimed, nothing was notified", async () => {
    const created = await createRequest(reqDocId, ownerActor(), "owner", { instruction: "Tighten this", mode: "suggest" });
    await claimRequest(reqDocId, created.id, agentActor());
    failActivityStep();
    await expect(completeRequest(reqDocId, created.id, agentActor(), { summary: "Tightened." })).rejects.toThrow(/Failed query/);
    expect(await rowOf(created.id)).toMatchObject({ status: "claimed", claimedBy: "Copilot CLI", result: null });
    expect(await doneRows(created.id)).toEqual([]);
    expect(await doneNotifications(created.id)).toEqual([]);
    // The retry an agent makes after the 500 completes it for real.
    const retried = await completeRequest(reqDocId, created.id, agentActor(), { summary: "Tightened." });
    expect(retried).toEqual({ request: expect.objectContaining({ status: "done", result: { suggestions: 0, comments: 0, summary: "Tightened." } }), notified: true, alreadyDone: false });
    expect(await doneRows(created.id)).toHaveLength(1);
    expect(await doneNotifications(created.id)).toHaveLength(1);
  });

  it("completeRequest: the notification failing is a warning on the completed request, notified: false, logged once", async () => {
    const created = await createRequest(reqDocId, ownerActor(), "owner", { instruction: "Tighten this", mode: "suggest" });
    vi.mocked(notify).mockRejectedValueOnce(new Error("notifications table is away"));
    const { result, logged } = await quietly(() => completeRequest(reqDocId, created.id, agentActor(), { summary: "Tightened." }));
    expect(result).toEqual({ request: expect.objectContaining({ status: "done", claimedBy: "Copilot CLI" }), notified: false, alreadyDone: false, warnings: ["notification-not-sent"] });
    expect(logged).toEqual([["[requests] notification-not-sent", expect.any(Error)]]);
    expect(await rowOf(created.id)).toMatchObject({ status: "done" });
    expect(await doneRows(created.id)).toHaveLength(1);
    expect(await doneNotifications(created.id)).toEqual([]);
    // The route carries the same body.
    const res = await as(null, () => POST_COMPLETE(jsonReq(`/api/documents/${reqDocId}/requests/${created.id}/complete`), params(reqDocId, created.id)), ownerToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ request: expect.objectContaining({ status: "done" }), notified: true, alreadyDone: true });
    expect(await doneNotifications(created.id)).toHaveLength(1);
  });

  it("completeRequest on a done request writes nothing but delivers the notification a crashed first call never sent — exactly once", async () => {
    const created = await createRequest(reqDocId, ownerActor(), "owner", { instruction: "Tighten this", mode: "suggest" });
    await claimRequest(reqDocId, created.id, agentActor());
    // A crash right after the commit: the row says done, no notification exists.
    const db = await getDb();
    await db.update(schema.agentRequests).set({ status: "done", result: { suggestions: 1, comments: 0, summary: "Crashed after commit." }, updatedAt: new Date() }).where(eq(schema.agentRequests.id, created.id));
    expect(await doneNotifications(created.id)).toEqual([]);

    const first = await completeRequest(reqDocId, created.id, agentActor());
    expect(first).toEqual({ request: expect.objectContaining({ status: "done", result: { suggestions: 1, comments: 0, summary: "Crashed after commit." } }), notified: true, alreadyDone: true });
    expect(await doneNotifications(created.id)).toEqual([expect.objectContaining({ actorName: "Copilot CLI", snippet: "Crashed after commit." })]);
    // Second retry: still one row, still notified: true (the row exists), nothing written.
    const second = await completeRequest(reqDocId, created.id, agentActor(), { summary: "Ignored on a done request." });
    expect(second).toEqual({ request: expect.objectContaining({ status: "done", result: { suggestions: 1, comments: 0, summary: "Crashed after commit." } }), notified: true, alreadyDone: true });
    expect(await doneNotifications(created.id)).toHaveLength(1);
    expect(await doneRows(created.id)).toEqual([]);
  });

  it("completeRequest: a requester without a login is notified: false without a warning", async () => {
    const db = await getDb();
    const [ghost] = await db.insert(schema.users).values({ name: "Ghost", login: null, email: "ghost-1232@example.com" }).returning();
    const created = await createRequest(reqDocId, { id: ghost.id, login: null, name: "Ghost", image: null }, "owner", { instruction: "Tighten this", mode: "suggest" });
    // Unaddressed: only the requester's own agents may complete it.
    const { result, logged } = await quietly(() => completeRequest(reqDocId, created.id, { id: ghost.id, login: null, name: "Ghost", image: null, agent: "Ghost bot" }));
    expect(result).toEqual({ request: expect.objectContaining({ status: "done" }), notified: false, alreadyDone: false });
    expect(logged).toEqual([]);
  });

  it("createRequest: the activity row failing leaves no request row behind", async () => {
    const before = (await listRequests(reqDocId)).length;
    failActivityStep();
    await expect(createRequest(reqDocId, ownerActor(), "owner", { instruction: "Never asked", mode: "suggest" })).rejects.toThrow(/Failed query/);
    const after = await listRequests(reqDocId);
    expect(after).toHaveLength(before);
    expect(after.find((r) => r.instruction === "Never asked")).toBeUndefined();
    expect((await listActivity(reqDocId, { limit: 100 })).items.filter((a) => a.action === "agent.request" && a.detail.instruction === "Never asked")).toEqual([]);
    // The retry creates it once, with its row.
    const retried = await createRequest(reqDocId, ownerActor(), "owner", { instruction: "Never asked", mode: "suggest" });
    expect(retried.status).toBe("open");
    expect(await askedRows(retried.id)).toHaveLength(1);
    await cancelRequest(reqDocId, retried.id, ownerActor(), "owner");
  });

  /**
   * Lands `race` between `attachWork`'s pre-check and its update: `getRequest` takes the first `getDb()` (the
   * pre-check passes on the still-claimed row), `attachWork`'s own `getDb()` is the second and runs `race` first.
   */
  const betweenPreCheckAndUpdate = async (race: () => Promise<unknown>) => {
    const actualGetDb = (await vi.importActual<typeof import("@/server/db")>("@/server/db")).getDb;
    vi.mocked(getDb)
      .mockImplementationOnce(actualGetDb)
      .mockImplementationOnce(async () => {
        await race();
        return actualGetDb();
      });
  };

  it("attachWork: a request cancelled between the pre-check and the update is not resurrected — 409, the row stays cancelled", async () => {
    const created = await createRequest(reqDocId, ownerActor(), "owner", { instruction: "Tighten this", mode: "suggest" });
    await claimRequest(reqDocId, created.id, agentActor());
    await betweenPreCheckAndUpdate(() => cancelRequest(reqDocId, created.id, ownerActor(), "owner"));
    await expect(attachWork(reqDocId, created.id, agentActor(), { suggestions: 1, suggestionIds: ["s-late"] })).rejects.toMatchObject({ status: 409, message: "Request is cancelled", details: { status: "cancelled" } });
    expect(await rowOf(created.id)).toMatchObject({ status: "cancelled", result: null });
    expect((await readMirror(reqDocId))[created.id]).toMatchObject({ status: "cancelled" });
  });

  it("attachWork: a request completed between the pre-check and the update answers 409 Request is done and keeps the result", async () => {
    const created = await createRequest(reqDocId, ownerActor(), "owner", { instruction: "Tighten this", mode: "suggest" });
    await claimRequest(reqDocId, created.id, agentActor());
    await betweenPreCheckAndUpdate(() => completeRequest(reqDocId, created.id, agentActor(), { summary: "Closed meanwhile." }));
    await expect(attachWork(reqDocId, created.id, agentActor(), { comments: 1, commentIds: ["c-late"] })).rejects.toMatchObject({ status: 409, message: "Request is done", details: { status: "done" } });
    expect(await rowOf(created.id)).toMatchObject({ status: "done", result: { suggestions: 0, comments: 0, summary: "Closed meanwhile." } });
  });
});