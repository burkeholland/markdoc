import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
// Many POSTs from one unknown address, as in agent-requests.test.ts.
process.env.RATE_LIMIT = "off";
delete process.env.DATABASE_URL;

/**
 * Requests are addressed (#1296): a request goes to one agent — the `@login/slug` mentioned — or to none (the
 * requester's own agents). Only that agent's owner-token lists, claims and completes it; everyone else is told
 * whose it is. Asking another user's agent needs the owner's `collaboratorsMayAsk` switch.
 */
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
let requestHeaders = new Headers();
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const { getDb, schema } = await import("@/server/db");
const { eq } = await import("drizzle-orm");
const { createDocument, upsertCollaborator } = await import("@/server/documents");
const { createApiToken, revokeApiToken, setCollaboratorsMayAsk } = await import("@/server/tokens");
const { listNotifications } = await import("@/server/notifications");
const { createRequest, listRequests, listRequestsForUser, claimRequest, completeRequest, attachWork, readMirror, requireAttachableRequest } = await import("@/server/agent-requests");
const { pollEvents } = await import("@/server/agent-events");
const { newId } = await import("@/editor/collab/shared");
const { POST: POST_REQUESTS } = await import("@/app/api/documents/[id]/requests/route");
const { POST: POST_CLAIM } = await import("@/app/api/documents/[id]/requests/[rid]/claim/route");
const { POST: POST_COMPLETE } = await import("@/app/api/documents/[id]/requests/[rid]/complete/route");
const { GET: GET_AGENT_REQUESTS } = await import("@/app/api/agent/requests/route");
const { POST: POST_COMMENTS, GET: GET_COMMENTS } = await import("@/app/api/documents/[id]/comments/route");
const { POST: POST_SUGGEST } = await import("@/app/api/documents/[id]/suggest/route");

let alice: Actor;
let bob: Actor;
let docId: string;
/** Bearer secrets by `<login>/<slug>`. */
const secrets: Record<string, string> = {};
/** Token ids by `<login>/<slug>`. */
const tokenIds: Record<string, string> = {};

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
/** The actor a token resolves to: its user plus the token name as `agent`. */
const agent = (user: Actor, name: "Copilot" | "Claude") => ({ ...user, agent: name });
const rowOf = async (id: string) => (await (await getDb()).select().from(schema.agentRequests).where(eq(schema.agentRequests.id, id)))[0];
const doneNotifications = async (login: string, id: string) => (await listNotifications(login, { kind: "request.done" })).items.filter((n) => n.refId === id);
type Err = { error: string; code?: string; agent?: string | null };

beforeAll(async () => {
  const db = await getDb();
  const [a] = await db.insert(schema.users).values({ name: "Alice", login: "Alice", email: "alice-1296@example.com" }).returning();
  const [b] = await db.insert(schema.users).values({ name: "Bob", login: "bob", email: "bob-1296@example.com" }).returning();
  // Alice's login is stored mixed-case: the addressee compares lower-cased on both sides.
  alice = { id: a.id, login: "Alice", name: "Alice", image: null };
  bob = { id: b.id, login: "bob", name: "Bob", image: null };
  const doc = await createDocument({ ownerId: alice.id, title: "Shared", content: "# Shared\n\nThe quick brown fox jumps over the lazy dog.\n" });
  docId = doc.id;
  await upsertCollaborator(docId, "bob", "editor", alice.id);
  for (const user of [alice, bob]) {
    for (const name of ["Copilot", "Claude"] as const) {
      const minted = await createApiToken(user.id, name);
      secrets[`${user.login.toLowerCase()}/${name.toLowerCase()}`] = minted.token;
      tokenIds[`${user.login.toLowerCase()}/${name.toLowerCase()}`] = minted.id;
    }
  }
});

describe("visibility matrix (e): four tokens, six requests", () => {
  it("each token lists exactly its addressed request plus its owner's unaddressed one — 8 rows across the four, none for another slug or owner", async () => {
    const tokens = [agent(alice, "Copilot"), agent(alice, "Claude"), agent(bob, "Copilot"), agent(bob, "Claude")];
    const cursors = new Map<string, string>();
    for (const t of tokens) cursors.set(`${t.login}/${t.agent}`, (await pollEvents(null, t, null, 0)).cursor);

    const toAliceCopilot = await createRequest(docId, alice, "owner", { instruction: "For Alice's Copilot", mode: "suggest", agent: "alice/copilot" });
    const toAliceClaude = await createRequest(docId, alice, "owner", { instruction: "For Alice's Claude", mode: "suggest", agent: "Alice/Claude" });
    const toBobCopilot = await createRequest(docId, bob, "editor", { instruction: "For Bob's Copilot", mode: "suggest", agent: "@bob/copilot" });
    const toBobClaude = await createRequest(docId, bob, "editor", { instruction: "For Bob's Claude", mode: "suggest", agent: "bob/claude" });
    const aliceOwn = await createRequest(docId, alice, "owner", { instruction: "Alice, unaddressed", mode: "suggest" });
    const bobOwn = await createRequest(docId, bob, "editor", { instruction: "Bob, unaddressed", mode: "suggest" });
    expect(toAliceCopilot.agent).toEqual({ login: "alice", slug: "copilot" });
    expect(toAliceClaude.agent).toEqual({ login: "alice", slug: "claude" });
    expect(toBobCopilot.agent).toEqual({ login: "bob", slug: "copilot" });
    expect(aliceOwn.agent).toBeNull();

    const expected: Record<string, { addressed: string; own: string }> = {
      "Alice/Copilot": { addressed: toAliceCopilot.id, own: aliceOwn.id },
      "Alice/Claude": { addressed: toAliceClaude.id, own: aliceOwn.id },
      "bob/Copilot": { addressed: toBobCopilot.id, own: bobOwn.id },
      "bob/Claude": { addressed: toBobClaude.id, own: bobOwn.id },
    };
    let total = 0;
    for (const t of tokens) {
      const key = `${t.login}/${t.agent}`;
      const { addressed, own } = expected[key];
      const listed = await listRequestsForUser(t);
      expect(listed.map((r) => r.id).sort(), key).toEqual([addressed, own].sort());
      expect(listed, key).toHaveLength(2);
      total += listed.length;
      // The addressed row names the token it is for; the unaddressed one names nobody.
      expect(listed.find((r) => r.agent)?.agentName, key).toBe(t.agent);
      expect(listed.find((r) => !r.agent)?.agentName, key).toBeNull();
      // Same rows from the inbox watch.
      const page = await pollEvents(null, t, cursors.get(key)!, 0);
      const created = page.events.filter((e) => e.type === "request.created") as { requestId: string; agent: string | null }[];
      expect(created.map((e) => e.requestId).sort(), key).toEqual([addressed, own].sort());
      expect(created.find((e) => e.requestId === addressed)?.agent, key).toBe(`${t.login.toLowerCase()}/${t.agent.toLowerCase()}`);
      expect(created.find((e) => e.requestId === own)?.agent, key).toBeNull();
    }
    expect(total).toBe(8);
    // A person (no token) sees only their own unaddressed request; the document listing still shows every request.
    expect((await listRequestsForUser(alice)).map((r) => r.id)).toEqual([aliceOwn.id]);
    expect((await listRequests(docId, { status: "open" })).map((r) => r.id).sort()).toEqual([toAliceCopilot.id, toAliceClaude.id, toBobCopilot.id, toBobClaude.id, aliceOwn.id, bobOwn.id].sort());

    // Over REST, with the bearer tokens: same two rows, the addressed one printed with the token's name.
    const inbox = (await (await as(null, () => GET_AGENT_REQUESTS(jsonReq("/api/agent/requests", undefined, "GET")), secrets["alice/copilot"])).json()) as { requests: { id: string; agent: unknown; agentName: string | null }[] };
    expect(inbox.requests.map((r) => r.id).sort()).toEqual([toAliceCopilot.id, aliceOwn.id].sort());
    expect(inbox.requests.find((r) => r.id === toAliceCopilot.id)).toMatchObject({ agent: { login: "alice", slug: "copilot" }, agentName: "Copilot" });
  });
});

describe("addressee resolution (a)–(d)", () => {
  it("(a) takes the first @login/slug of the thread's root comment; other mentioned agents are not addressees", async () => {
    const add = await as(alice, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "add", quote: "brown fox", body: "@Alice/Copilot and @bob/copilot: is this the right animal?" }), params(docId)));
    expect(add.status).toBe(200);
    const { id: threadId } = (await add.json()) as { id: string };
    const fromThread = await createRequest(docId, alice, "owner", { instruction: "Right animal?", mode: "comment", threadId });
    expect(fromThread.agent).toEqual({ login: "alice", slug: "copilot" });
    expect(await rowOf(fromThread.id)).toMatchObject({ agentLogin: "alice", agentSlug: "copilot", claimedBy: null, claimedByLogin: null });
    expect((await readMirror(docId))[fromThread.id]).toMatchObject({ agent: { login: "alice", slug: "copilot" }, claimedByLogin: null });
    expect((await listRequestsForUser(agent(bob, "Copilot"))).map((r) => r.id)).not.toContain(fromThread.id);
    expect((await listRequestsForUser(agent(alice, "Copilot"))).map((r) => r.id)).toContain(fromThread.id);
  });

  it("(b) input.agent beats the thread body", async () => {
    const add = await as(alice, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "add", quote: "lazy dog", body: "@alice/copilot too lazy?" }), params(docId)));
    const { id: threadId } = (await add.json()) as { id: string };
    const res = await as(alice, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Too lazy?", mode: "comment", threadId, agent: "alice/claude" }), params(docId)));
    expect(res.status).toBe(201);
    const { request } = (await res.json()) as { request: { id: string; agent: unknown; claimedByLogin: unknown } };
    expect(request.agent).toEqual({ login: "alice", slug: "claude" });
    expect(request.claimedByLogin).toBeNull();
  });

  it("(c) an unknown, revoked or expired slug is 400 unknown-agent; nothing is stored", async () => {
    const db = await getDb();
    const before = (await listRequests(docId)).length;
    const revoked = await createApiToken(alice.id, "Temp");
    await revokeApiToken(alice.id, revoked.id);
    const expired = await createApiToken(alice.id, "Old", { expiresInDays: 1 });
    await db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.apiTokens.id, expired.id));

    for (const mention of ["alice/nobody", "nobody/copilot", "alice/temp", "alice/old", "@alice/old", "not-a-mention"]) {
      const res = await as(alice, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Hi", mode: "comment", agent: mention }), params(docId)));
      expect(res.status, mention).toBe(400);
      const body = (await res.json()) as Err;
      expect(body.code, mention).toBe("unknown-agent");
      expect(body.error, mention).toBe(`Unknown agent @${mention.replace(/^@/, "")}`);
    }
    // The same for a mention read from the thread body.
    const add = await as(alice, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "add", quote: "jumps", body: "@alice/temp or leaps?" }), params(docId)));
    const { id: threadId } = (await add.json()) as { id: string };
    await expect(createRequest(docId, alice, "owner", { instruction: "Leaps?", mode: "comment", threadId })).rejects.toMatchObject({ status: 400, details: { code: "unknown-agent", agent: "alice/temp" } });
    expect((await listRequests(docId)).length).toBe(before);
  });

  it("(d) Bob asking @alice/copilot is 403 agent-owner-only naming Alice — until Alice switches collaboratorsMayAsk on, then 201 and it lands in her Copilot's inbox", async () => {
    const refused = await as(bob, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Summarise", mode: "suggest", agent: "alice/copilot" }), params(docId)));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "Alice's Copilot only takes requests from Alice", code: "agent-owner-only", agent: "alice/copilot" });
    expect((await listRequests(docId)).find((r) => r.instruction === "Summarise")).toBeUndefined();
    // Same from a thread body mention, and the switch on Alice's other token does not open this one.
    await setCollaboratorsMayAsk(alice.id, tokenIds["alice/claude"], true);
    const add = await as(bob, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "add", quote: "quick", body: "@alice/copilot summarise" }), params(docId)));
    const { id: threadId } = (await add.json()) as { id: string };
    await expect(createRequest(docId, bob, "editor", { instruction: "Summarise", mode: "suggest", threadId })).rejects.toMatchObject({ status: 403, message: "Alice's Copilot only takes requests from Alice", details: { code: "agent-owner-only" } });

    const { cursor } = await pollEvents(null, agent(alice, "Copilot"), null, 0);
    expect(await setCollaboratorsMayAsk(alice.id, tokenIds["alice/copilot"], true)).toMatchObject({ id: tokenIds["alice/copilot"], collaboratorsMayAsk: true });
    const accepted = await as(bob, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Summarise", mode: "suggest", threadId }), params(docId)));
    expect(accepted.status).toBe(201);
    const { request } = (await accepted.json()) as { request: { id: string; userId: string; agent: unknown } };
    expect(request).toMatchObject({ userId: bob.id, agent: { login: "alice", slug: "copilot" } });
    const mine = await listRequestsForUser(agent(alice, "Copilot"));
    expect(mine.find((r) => r.id === request.id)).toMatchObject({ userLogin: "bob", userName: "Bob", agentName: "Copilot" });
    expect((await listRequestsForUser(agent(bob, "Copilot"))).map((r) => r.id)).not.toContain(request.id);
    const page = await pollEvents(null, agent(alice, "Copilot"), cursor, 0);
    expect(page.events.filter((e) => e.type === "request.created").map((e) => (e as { requestId: string }).requestId)).toEqual([request.id]);
    // Alice's own ask of her agent never needed the switch.
    await setCollaboratorsMayAsk(alice.id, tokenIds["alice/copilot"], false);
    await setCollaboratorsMayAsk(alice.id, tokenIds["alice/claude"], false);
    expect((await createRequest(docId, alice, "owner", { instruction: "Mine", mode: "suggest", agent: "alice/copilot" })).agent).toEqual({ login: "alice", slug: "copilot" });
  });
});

describe("working a request (f)–(i)", () => {
  it("(f) claim: the wrong slug of the same owner and the other owner get 403 not-addressee; the addressee claims with claimedBy + claimedByLogin", async () => {
    const req = await createRequest(docId, alice, "owner", { instruction: "Claim me", mode: "suggest", agent: "alice/copilot" });
    await expect(claimRequest(docId, req.id, agent(alice, "Claude"))).rejects.toMatchObject({ status: 403, message: "Request is addressed to @alice/copilot", details: { code: "not-addressee", agent: "alice/copilot" } });
    await expect(claimRequest(docId, req.id, agent(bob, "Copilot"))).rejects.toMatchObject({ status: 403, details: { code: "not-addressee", agent: "alice/copilot" } });
    // Alice herself (no token) is not the addressee either: the request went to her agent.
    await expect(claimRequest(docId, req.id, alice)).rejects.toMatchObject({ status: 403, details: { code: "not-addressee" } });
    expect(await rowOf(req.id)).toMatchObject({ status: "open", claimedBy: null, claimedByLogin: null });

    const over = await as(null, () => POST_CLAIM(jsonReq(`/api/documents/${docId}/requests/${req.id}/claim`), params(docId, req.id)), secrets["bob/copilot"]);
    expect(over.status).toBe(403);
    expect(await over.json()).toEqual({ error: "Request is addressed to @alice/copilot", code: "not-addressee", agent: "alice/copilot" });

    const claimed = await claimRequest(docId, req.id, agent(alice, "Copilot"));
    expect(claimed).toMatchObject({ status: "claimed", claimedBy: "Copilot", claimedByLogin: "alice", agent: { login: "alice", slug: "copilot" } });
    expect((await readMirror(docId))[req.id]).toMatchObject({ claimedBy: "Copilot", claimedByLogin: "alice" });
    // The addressee check comes before the status check: a non-addressee is told nothing about the claim.
    await expect(claimRequest(docId, req.id, agent(bob, "Copilot"))).rejects.toMatchObject({ status: 403 });
    // Two "Copilot" tokens: Bob's is told whose the request is even though it carries the same name.
    await expect(completeRequest(docId, req.id, agent(bob, "Copilot"))).rejects.toMatchObject({ status: 403 });
  });

  it("(g) attachWork and completeRequest refuse a non-addressee before writing: row unchanged, no request.done notification", async () => {
    const req = await createRequest(docId, alice, "owner", { instruction: "Work me", mode: "suggest", agent: "alice/claude" });
    const before = await rowOf(req.id);
    for (const who of [agent(alice, "Copilot"), agent(bob, "Claude"), agent(bob, "Copilot")]) {
      await expect(requireAttachableRequest(docId, req.id, who)).rejects.toMatchObject({ status: 403, details: { code: "not-addressee", agent: "alice/claude" } });
      await expect(attachWork(docId, req.id, who, { suggestions: 1, suggestionIds: ["s-x"] })).rejects.toMatchObject({ status: 403, details: { code: "not-addressee" } });
      await expect(completeRequest(docId, req.id, who, { summary: "Not mine." })).rejects.toMatchObject({ status: 403, details: { code: "not-addressee" } });
    }
    expect(await rowOf(req.id)).toEqual(before);
    expect(await doneNotifications("alice", req.id)).toEqual([]);
    // Over REST: Bob's Claude cannot attach work by suggesting or commenting with the requestId, nor complete.
    const suggest = await as(null, () => POST_SUGGEST(jsonReq(`/api/documents/${docId}/suggest`, { edits: [{ find: "quick", replace: "swift" }], requestId: req.id }), params(docId)), secrets["bob/claude"]);
    expect(suggest.status).toBe(403);
    expect(((await suggest.json()) as Err).code).toBe("not-addressee");
    const comment = await as(null, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "add", quote: "quick", body: "Mine?", requestId: req.id }), params(docId)), secrets["bob/claude"]);
    expect(comment.status).toBe(403);
    const complete = await as(null, () => POST_COMPLETE(jsonReq(`/api/documents/${docId}/requests/${req.id}/complete`, { summary: "Done." }), params(docId, req.id)), secrets["alice/copilot"]);
    expect(complete.status).toBe(403);
    expect(await complete.json()).toEqual({ error: "Request is addressed to @alice/claude", code: "not-addressee", agent: "alice/claude" });
    expect(await rowOf(req.id)).toEqual(before);

    // The addressee's work is counted, the implicit claim carries the owner login, completion notifies Alice.
    const worked = await attachWork(docId, req.id, agent(alice, "Claude"), { suggestions: 1, suggestionIds: ["s-1"] });
    expect(worked).toMatchObject({ status: "claimed", claimedBy: "Claude", claimedByLogin: "alice", result: { suggestions: 1 } });
    const done = await as(null, () => POST_COMPLETE(jsonReq(`/api/documents/${docId}/requests/${req.id}/complete`, { summary: "Swift now." }), params(docId, req.id)), secrets["alice/claude"]);
    expect(done.status).toBe(200);
    expect(((await done.json()) as { request: { claimedBy: string; claimedByLogin: string } }).request).toMatchObject({ claimedBy: "Claude", claimedByLogin: "alice" });
    expect(await doneNotifications("alice", req.id)).toHaveLength(1);
  });

  it("(h) unaddressed: the requester's own tokens (and the requester) may work it; other users' tokens get 403", async () => {
    const req = await createRequest(docId, bob, "editor", { instruction: "Bob's own", mode: "suggest" });
    expect(req.agent).toBeNull();
    for (const who of [agent(alice, "Copilot"), agent(alice, "Claude")]) {
      await expect(claimRequest(docId, req.id, who)).rejects.toMatchObject({ status: 403, message: "Request can only be worked by Bob's own agents", details: { code: "not-addressee", agent: null } });
      await expect(attachWork(docId, req.id, who, { comments: 1 })).rejects.toMatchObject({ status: 403 });
      await expect(completeRequest(docId, req.id, who)).rejects.toMatchObject({ status: 403 });
    }
    const over = await as(null, () => POST_CLAIM(jsonReq(`/api/documents/${docId}/requests/${req.id}/claim`), params(docId, req.id)), secrets["alice/copilot"]);
    expect(over.status).toBe(403);
    expect(await over.json()).toEqual({ error: "Request can only be worked by Bob's own agents", code: "not-addressee", agent: null });
    expect(await rowOf(req.id)).toMatchObject({ status: "open", claimedBy: null, claimedByLogin: null });

    const claimed = await claimRequest(docId, req.id, agent(bob, "Claude"));
    expect(claimed).toMatchObject({ status: "claimed", claimedBy: "Claude", claimedByLogin: "bob", agent: null });
    // Bob's other token is another agent of the same owner: the usual 409, not a 403.
    await expect(claimRequest(docId, req.id, agent(bob, "Copilot"))).rejects.toMatchObject({ status: 409 });
    // Bob in person may complete his own request; the claim stays with the token that did the work.
    const done = await completeRequest(docId, req.id, bob, { summary: "Done by hand." });
    expect(done.request).toMatchObject({ status: "done", claimedBy: "Claude", claimedByLogin: "bob" });
  });

  it("(i) a row from before 0019 (null addressee columns) behaves as unaddressed", async () => {
    const db = await getDb();
    const now = new Date();
    const id = newId();
    await db.insert(schema.agentRequests).values({ id, documentId: docId, userId: alice.id, instruction: "Legacy", mode: "comment", status: "open", createdAt: now, updatedAt: now });
    const legacy = await rowOf(id);
    expect(legacy).toMatchObject({ agentLogin: null, agentSlug: null, claimedByLogin: null });
    expect((await listRequestsForUser(agent(alice, "Copilot"))).find((r) => r.id === id)).toMatchObject({ agent: null, agentName: null, claimedByLogin: null });
    expect((await listRequestsForUser(agent(alice, "Claude"))).map((r) => r.id)).toContain(id);
    expect((await listRequestsForUser(agent(bob, "Copilot"))).map((r) => r.id)).not.toContain(id);
    await expect(claimRequest(docId, id, agent(bob, "Copilot"))).rejects.toMatchObject({ status: 403, details: { code: "not-addressee", agent: null } });
    // A legacy claimed row (claimedBy set, claimedByLogin null) keeps null rather than guessing an owner.
    await db.update(schema.agentRequests).set({ status: "claimed", claimedBy: "Copilot" }).where(eq(schema.agentRequests.id, id));
    const done = await completeRequest(docId, id, agent(alice, "Copilot"));
    expect(done.request).toMatchObject({ status: "done", claimedBy: "Copilot", claimedByLogin: null, agent: null });
  });
});

/**
 * An agent only works where its human is a member (`listRequestsForUser`): a request addressed to an agent whose
 * owner is neither the document's owner nor a collaborator would be created and never listed by anyone (#1351).
 * Such a request is refused at creation, before the `collaboratorsMayAsk` check — the picker never offers it,
 * but the API does not depend on the picker.
 */
describe("the addressee's owner must be in the document (j)–(l)", () => {
  let dana: Actor;
  const threads = async () => (await (await as(alice, () => GET_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, undefined, "GET"), params(docId)))).json()) as { comments: { id: string; body: string }[] };

  beforeAll(async () => {
    const db = await getDb();
    // Mixed-case login: the membership predicate lower-cases the owner's login like `upsertCollaborator` does.
    const [d] = await db.insert(schema.users).values({ name: "Dana", login: "Dana", email: "dana-1351@example.com" }).returning();
    dana = { id: d.id, login: "Dana", name: "Dana", image: null };
    // Scribe is open to collaborators, Quill is not; Dana is a member of nothing yet.
    const scribe = await createApiToken(dana.id, "Scribe");
    await setCollaboratorsMayAsk(dana.id, scribe.id, true);
    await createApiToken(dana.id, "Quill");
  });

  it("(j) @dana/scribe — a live token open to collaborators, its owner not in the document — is 400 agent-not-in-document; nothing stored, the comment stands", async () => {
    const before = (await listRequests(docId)).length;
    const add = await as(alice, () => POST_COMMENTS(jsonReq(`/api/documents/${docId}/comments`, { action: "add", quote: "brown fox", body: "@dana/scribe transcribe this" }), params(docId)));
    expect(add.status).toBe(200);
    const { id: threadId } = (await add.json()) as { id: string };

    const refused = await as(alice, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Transcribe this", mode: "comment", threadId }), params(docId)));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Dana's Scribe is not in this document", code: "agent-not-in-document", agent: { login: "dana", slug: "scribe" } });
    // The same for an explicit `agent`, however it is spelled, and from Bob, an editor.
    for (const [who, role, mention] of [[alice, "owner", "Dana/Scribe"], [alice, "owner", "@dana/scribe"], [bob, "editor", "dana/scribe"]] as const) {
      await expect(createRequest(docId, who, role, { instruction: "Transcribe this", mode: "comment", agent: mention })).rejects.toMatchObject({
        status: 400,
        message: "Dana's Scribe is not in this document",
        details: { code: "agent-not-in-document", agent: { login: "dana", slug: "scribe" } },
      });
    }
    expect((await listRequests(docId)).length).toBe(before);
    expect((await listRequestsForUser({ ...dana, agent: "Scribe" })).map((r) => r.documentId)).not.toContain(docId);
    // The comment that mentioned her is posted all the same — the request was refused, not the comment.
    expect((await threads()).comments.find((t) => t.id === threadId)?.body).toBe("@dana/scribe transcribe this");
    // A slug nobody has is still `unknown-agent` first: the membership check never speaks for an agent that does not exist.
    const unknown = (await (await as(alice, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Hi", mode: "comment", agent: "dana/nobody" }), params(docId)))).json()) as { code?: string };
    expect(unknown.code).toBe("unknown-agent");
  });

  it("(k) the membership check comes before the switch: a locked agent whose owner is not here is also agent-not-in-document, not agent-owner-only", async () => {
    const refused = await as(alice, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Write this up", mode: "comment", agent: "dana/quill" }), params(docId)));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Dana's Quill is not in this document", code: "agent-not-in-document", agent: { login: "dana", slug: "quill" } });
  });

  it("(l) once Dana is a commenter, @dana/scribe is 201 as before and lands in Scribe's inbox; her locked Quill is the usual 403 agent-owner-only", async () => {
    await upsertCollaborator(docId, "dana", "commenter", alice.id);
    const accepted = await as(alice, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Transcribe this", mode: "comment", agent: "dana/scribe" }), params(docId)));
    expect(accepted.status).toBe(201);
    const { request } = (await accepted.json()) as { request: { id: string; agent: unknown } };
    expect(request.agent).toEqual({ login: "dana", slug: "scribe" });
    expect((await listRequestsForUser({ ...dana, agent: "Scribe" })).find((r) => r.id === request.id)).toMatchObject({ documentId: docId, userLogin: "Alice", agentName: "Scribe" });

    const locked = await as(alice, () => POST_REQUESTS(jsonReq(`/api/documents/${docId}/requests`, { instruction: "Write this up", mode: "comment", agent: "dana/quill" }), params(docId)));
    expect(locked.status).toBe(403);
    expect(await locked.json()).toEqual({ error: "Dana's Quill only takes requests from Dana", code: "agent-owner-only", agent: "dana/quill" });
    // Dana asking her own locked agent needs no switch — and she is in the document now.
    expect((await createRequest(docId, dana, "commenter", { instruction: "Mine", mode: "comment", agent: "dana/quill" })).agent).toEqual({ login: "dana", slug: "quill" });
  });
});
