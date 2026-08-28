import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Routes resolve the caller through next-auth and `next/headers`; a bearer token in `requestHeaders` wins
// (that is how agents call in). No collaboration server here: writes go through the database path.
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
let requestHeaders = new Headers();
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const { getDb, schema } = await import("@/server/db");
const { createDocument, upsertCollaborator, updateDocument } = await import("@/server/documents");
const { createApiToken } = await import("@/server/tokens");
const { notify } = await import("@/server/notifications");
const events = await import("@/server/agent-events");
const { GET: GET_EVENTS } = await import("@/app/api/agent/documents/[id]/events/route");
const { GET: GET_ALL_EVENTS } = await import("@/app/api/agent/events/route");
const { PATCH: PATCH_CONTENT } = await import("@/app/api/documents/[id]/content/route");
const { POST: POST_COMMENTS } = await import("@/app/api/documents/[id]/comments/route");

interface EventActor {
  id: string | null;
  name: string;
  login: string | null;
  kind: string;
  agent: string | null;
  self: boolean;
}
interface Ev {
  type: string;
  documentId: string;
  actor: EventActor;
  diff?: string | null;
  body?: string;
  author?: string;
  snippet?: string;
  agent?: string | null;
}
interface Page {
  cursor: string;
  events: Ev[];
}

let owner: Actor;
let cam: Actor;
let alice: Actor;
let docId: string;
let token: string;
let scribe: string;
let aliceToken: string;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (url: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  new Request(`http://localhost:3700${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const as = async <T>(who: Actor | null, fn: () => Promise<T>, bearer?: string) => {
  const saved = actor;
  const savedHeaders = requestHeaders;
  actor = who;
  requestHeaders = bearer ? new Headers({ authorization: ["Bearer", bearer].join(" ") }) : new Headers();
  try {
    return await fn();
  } finally {
    actor = saved;
    requestHeaders = savedHeaders;
  }
};
const asAgent = <T>(fn: () => Promise<T>, bearer = token) => as(null, fn, bearer);
const watch = async (query = "", bearer = token): Promise<Page> => {
  const res = await asAgent(() => GET_EVENTS(req(`/api/agent/documents/${docId}/events${query}`), params(docId)), bearer);
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
};
const cursorNow = async (bearer = token) => (await watch("", bearer)).cursor;
const append = (who: Actor | null, markdown: string, bearer?: string) =>
  as(who, () => PATCH_CONTENT(req(`/api/documents/${docId}/content`, { append: markdown }, "PATCH"), params(docId)), bearer);

beforeAll(async () => {
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ name: "Olive", login: "olive", email: "olive@example.com" }).returning();
  const [c] = await db.insert(schema.users).values({ name: "Cam", login: "cam", email: "cam@example.com" }).returning();
  const [a] = await db.insert(schema.users).values({ name: "Alice", login: "alice", email: "alice@example.com" }).returning();
  owner = { id: o.id, login: "olive", name: "Olive", image: null };
  cam = { id: c.id, login: "cam", name: "Cam", image: null };
  alice = { id: a.id, login: "alice", name: "Alice", image: null };
  docId = (await createDocument({ ownerId: owner.id, title: "Watched", content: "# Watched\n\nFirst paragraph.\n" })).id;
  await upsertCollaborator(docId, "cam", "editor", owner.id);
  token = (await createApiToken(owner.id, "Copilot CLI")).token;
  scribe = (await createApiToken(owner.id, "Scribe")).token;
  aliceToken = (await createApiToken(alice.id, "Alice Agent")).token;
});

describe("GET /api/agent/documents/:id/events — own writes", () => {
  it("does not wake on the token's own append; includeSelf=1 shows it as (you)", async () => {
    const cursor = await cursorNow();
    expect((await append(null, "\nself append\n", token)).status).toBe(200);

    const t = Date.now();
    const page = await watch(`?since=${cursor}&wait=1`);
    expect(page.events).toEqual([]);
    // The poll kept waiting instead of returning at once with the agent's own change.
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
    // …and the cursor moved past the change: nothing is reported later either.
    expect((await watch(`?since=${page.cursor}`)).events).toEqual([]);

    const mine = await watch(`?since=${cursor}&includeSelf=1`);
    expect(mine.events.map((e) => e.type)).toEqual(["content.changed"]);
    expect(mine.events[0].actor).toEqual({ id: `agent:${owner.id}:Copilot CLI`, name: "Copilot CLI", login: "olive", kind: "agent", agent: "Copilot CLI", self: true });
    expect(mine.events[0].diff).toContain("+self append");
  });

  it("delivers another person's append with actor.self === false and who they are", async () => {
    const cursor = await cursorNow();
    expect((await append(cam, "\nCam wrote this.\n")).status).toBe(200);
    const page = await watch(`?since=${cursor}&wait=5`);
    expect(page.events.map((e) => e.type)).toEqual(["content.changed"]);
    expect(page.events[0].actor).toMatchObject({ id: cam.id, login: "cam", kind: "user", agent: null, self: false });
    expect(page.events[0].diff).toContain("+Cam wrote this.");
  });

  it("tells another agent of the same user apart from itself", async () => {
    const cursor = await cursorNow();
    expect((await append(null, "\nScribe wrote this.\n", scribe)).status).toBe(200);
    const page = await watch(`?since=${cursor}&wait=5`);
    expect(page.events.map((e) => e.type)).toEqual(["content.changed"]);
    expect(page.events[0].actor).toEqual({ id: `agent:${owner.id}:Scribe`, name: "Scribe", login: "olive", kind: "agent", agent: "Scribe", self: false });
    // From Scribe's point of view the same change is its own.
    expect((await watch(`?since=${cursor}&wait=1`, scribe)).events).toEqual([]);
  });

  it("still reports a change when someone else wrote in between the token's own writes", async () => {
    const cursor = await cursorNow();
    await append(null, "\nmine 1\n", token);
    await append(cam, "\ntheirs\n");
    await append(null, "\nmine 2\n", token);
    const page = await watch(`?since=${cursor}&wait=5`);
    expect(page.events.map((e) => e.type)).toEqual(["content.changed"]);
    expect(page.events[0].actor).toMatchObject({ login: "cam", self: false });
    expect(page.events[0].diff).toContain("+theirs");
  });

  it("skips the token's own comments and mentions, keeps a person's, and stamps actor on both", async () => {
    const cursor = await cursorNow();
    const inbox = ((await (await asAgent(() => GET_ALL_EVENTS(req(`/api/agent/events`)))).json()) as Page).cursor;
    const own = await asAgent(() => POST_COMMENTS(req(`/api/documents/${docId}/comments`, { action: "add", quote: "First paragraph", body: "note to self, @olive/Copilot-CLI" }), params(docId)));
    expect(own.status).toBe(200);
    const quiet = await watch(`?since=${cursor}&wait=1`);
    expect(quiet.events).toEqual([]);
    expect(((await (await asAgent(() => GET_ALL_EVENTS(req(`/api/agent/events?since=${inbox}`)))).json()) as Page).events).toEqual([]);

    const mine = await watch(`?since=${cursor}&includeSelf=1`);
    expect(mine.events.map((e) => e.type).sort()).toEqual(["comment.added", "mention"]);
    for (const e of mine.events) expect(e.actor).toMatchObject({ login: "olive", kind: "agent", agent: "Copilot CLI", self: true });
    const myInbox = ((await (await asAgent(() => GET_ALL_EVENTS(req(`/api/agent/events?since=${inbox}&includeSelf=1`)))).json()) as Page).events;
    expect(myInbox.map((e) => e.type)).toEqual(["mention"]);
    expect(myInbox[0].actor.self).toBe(true);

    const human = await as(owner, () => POST_COMMENTS(req(`/api/documents/${docId}/comments`, { action: "add", quote: "First paragraph", body: "@olive/Copilot-CLI please tighten this" }), params(docId)));
    expect(human.status).toBe(200);
    const page = await watch(`?since=${quiet.cursor}&wait=5`);
    expect(page.events.map((e) => e.type).sort()).toEqual(["comment.added", "mention"]);
    expect(page.events.find((e) => e.type === "comment.added")!.actor).toMatchObject({ id: owner.id, name: "Olive", login: "olive", kind: "user", agent: null, self: false });
    expect(page.events.find((e) => e.type === "mention")!.actor).toMatchObject({ login: "olive", kind: "user", self: false });
    expect(page.events.find((e) => e.type === "mention")!.agent).toBe("Copilot-CLI");
  });

  it("only returns cross-document mentions for documents the token user can open", async () => {
    const privateDoc = await createDocument({ ownerId: owner.id, title: "Private instructions" });
    const linkedDoc = await createDocument({ ownerId: owner.id, title: "Linked instructions" });
    const sharedDoc = await createDocument({ ownerId: owner.id, title: "Shared instructions" });
    await updateDocument(linkedDoc.id, { linkAccess: "comment" });
    await upsertCollaborator(sharedDoc.id, alice.login, "viewer", owner.id);

    const initial = (await (await asAgent(() => GET_ALL_EVENTS(req("/api/agent/events")), aliceToken)).json()) as Page;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await notify({ userLogin: alice.login, documentId: privateDoc.id, kind: "mention", actorLogin: owner.login, refId: "private-legacy", snippet: "@alice private" });
    await notify({ userLogin: alice.login, documentId: linkedDoc.id, kind: "mention", actorLogin: owner.login, refId: "linked-mention", snippet: "@alice linked" });
    await notify({ userLogin: alice.login, documentId: sharedDoc.id, kind: "mention", actorLogin: owner.login, refId: "shared-mention", snippet: "@alice shared" });

    const response = await asAgent(() => GET_ALL_EVENTS(req(`/api/agent/events?since=${initial.cursor}`)), aliceToken);
    expect(response.status).toBe(200);
    const page = (await response.json()) as Page;
    expect(page.events.filter((event) => event.type === "mention").map((event) => event.documentId).sort()).toEqual([linkedDoc.id, sharedDoc.id].sort());
    expect(page.events.some((event) => event.documentId === privateDoc.id)).toBe(false);
  });

  it("parses includeSelf and explains content changes from recorded writes", () => {
    expect(events.parseIncludeSelf("1")).toBe(true);
    expect(events.parseIncludeSelf("true")).toBe(true);
    expect(events.parseIncludeSelf("0")).toBe(false);
    expect(events.parseIncludeSelf(null)).toBe(false);
    expect(events.selfActorId({ id: "u1", login: "x", name: null, image: null, agent: "Bot" })).toBe("agent:u1:Bot");
    expect(events.selfActorId({ id: "u1", login: "x", name: null, image: null })).toBeNull();
  });
});
