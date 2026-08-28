import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
let requestHeaders = new Headers();
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const { getDb, schema } = await import("@/server/db");
const { createDocument, upsertCollaborator } = await import("@/server/documents");
const { createApiToken } = await import("@/server/tokens");
const { createCollabServer, shutdownCollab } = await import("@/server/collab/hocuspocus");
const { attachCollab } = await import("@/server/collab/ws");
const { registerCollab } = await import("@/server/collab/registry");
const { signCollabToken } = await import("@/server/collab/token");
const { recordActivity, activityActor } = await import("@/server/activity");
const { notify } = await import("@/server/notifications");
const { createRequest } = await import("@/server/agent-requests");
const presence = await import("@/server/agent-presence");
const events = await import("@/server/agent-events");
const { recordAgentActivity } = await import("@/server/agents");
const { POST: POST_PRESENCE, GET: GET_PRESENCE } = await import("@/app/api/agent/documents/[id]/presence/route");
const { GET: GET_EVENTS } = await import("@/app/api/agent/documents/[id]/events/route");
const { GET: GET_ALL_EVENTS } = await import("@/app/api/agent/events/route");
const { POST: POST_COMMENTS } = await import("@/app/api/documents/[id]/comments/route");
const { PUT: PUT_CONTENT } = await import("@/app/api/documents/[id]/content/route");
const { POST: POST_SUGGEST } = await import("@/app/api/documents/[id]/suggest/route");
const { GET: GET_COLLABORATORS } = await import("@/app/api/documents/[id]/collaborators/route");
const { GET: GET_NOTIFICATIONS } = await import("@/app/api/notifications/route");

let owner: Actor;
let docId: string;
let otherDocId: string;
let token: string;
let server: Server;
let url: string;
let hocuspocus: ReturnType<typeof createCollabServer>;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (url: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  new Request(`http://localhost:3700${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const asAgent = async <T>(fn: () => Promise<T>, t = token) => {
  requestHeaders = new Headers({ authorization: ["Bearer", t].join(" ") });
  try {
    return await fn();
  } finally {
    requestHeaders = new Headers();
  }
};
const asHuman = async <T>(fn: () => Promise<T>) => {
  actor = owner;
  const saved = requestHeaders;
  requestHeaders = new Headers();
  try {
    return await fn();
  } finally {
    actor = null;
    requestHeaders = saved;
  }
};
const agentActor = (name = "Copilot") => ({ ...owner, agent: name });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error("timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

beforeAll(async () => {
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ name: "Olive", login: "olive", email: "olive@example.com" }).returning();
  const [c] = await db.insert(schema.users).values({ name: "Cam", login: "cam", email: "cam@example.com" }).returning();
  owner = { id: o.id, login: "olive", name: "Olive", image: null };
  docId = (await createDocument({ ownerId: owner.id, title: "Watched", content: "# Watched\n\nFirst paragraph.\n\nSecond paragraph.\n" })).id;
  otherDocId = (await createDocument({ ownerId: c.id, title: "Cam's", content: "# Cam\n" })).id;
  await upsertCollaborator(otherDocId, "olive", "editor", c.id);
  token = (await createApiToken(owner.id, "Copilot")).token;

  hocuspocus = createCollabServer();
  hocuspocus.configuration.debounce = 50;
  hocuspocus.configuration.maxDebounce = 100;
  server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  attachCollab(server, hocuspocus, { path: "/collab" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
  registerCollab(hocuspocus);
});

afterAll(async () => {
  presence.resetAgentPresence();
  await shutdownCollab(hocuspocus);
  await new Promise<void>((r) => server.close(() => r()));
});

async function connectHuman(id = docId) {
  const ydoc = new Y.Doc();
  const t = await signCollabToken({ userId: owner.id, docId: id, role: "owner", name: "Olive", login: "olive", avatar: null });
  const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: id, document: ydoc, token: t });
  provider.attach();
  await waitFor(() => provider.isSynced);
  const agents = () =>
    [...provider.awareness!.getStates().values()].map((s) => s.user as { id: string; name: string; isAgent?: boolean; status?: string | null }).filter((u) => u?.isAgent);
  return { ydoc, provider, socket, agents, close: () => (provider.destroy(), socket.destroy()) };
}

describe("agent presence", () => {
  it("expires 90 s after the last heartbeat and is removed on left", () => {
    presence.resetAgentPresence();
    const t0 = 1_000_000;
    const p = presence.setAgentPresence("doc-a", agentActor(), { state: "active", status: "drafting" }, t0);
    expect(p).toMatchObject({ name: "Copilot", state: "active", status: "drafting", id: `agent:${owner.id}:Copilot` });
    expect(p!.expiresAt).toBe(t0 + presence.AGENT_PRESENCE_TTL_MS);
    presence.setAgentPresence("doc-a", agentActor(), { state: "idle" }, t0);
    expect(presence.listAgentPresence("doc-a", t0)[0]).toMatchObject({ state: "idle", status: "drafting" });
    expect(presence.listAgentPresence("doc-a", t0 + presence.AGENT_PRESENCE_TTL_MS - 1)).toHaveLength(1);
    // Reading past the TTL drops the entry.
    expect(presence.listAgentPresence("doc-a", t0 + presence.AGENT_PRESENCE_TTL_MS)).toHaveLength(0);

    presence.setAgentPresence("doc-a", agentActor(), { state: "active" }, t0);
    expect(presence.listAgentPresence("doc-a", t0)).toHaveLength(1);
    expect(presence.setAgentPresence("doc-a", agentActor(), { state: "left" }, t0)).toBeNull();
    expect(presence.listAgentPresence("doc-a", t0)).toHaveLength(0);
    // Humans never have presence entries.
    expect(presence.setAgentPresence("doc-a", owner, { state: "active" }, t0)).toBeNull();
  });

  it("marks the agent active implicitly on writes, without overriding a fresh explicit status", () => {
    presence.resetAgentPresence();
    const t0 = 2_000_000;
    expect(presence.touchAgentPresence("doc-b", agentActor(), "editing", undefined, t0)).toMatchObject({ state: "active", status: "editing" });
    presence.setAgentPresence("doc-b", agentActor(), { state: "idle", status: "waiting for Burke" }, t0 + 1000);
    // Within the TTL of the explicit status, a write flips the state but keeps the agent's own words.
    expect(presence.touchAgentPresence("doc-b", agentActor(), "commenting", undefined, t0 + 2000)).toMatchObject({ state: "active", status: "waiting for Burke" });
    // Once the explicit status is stale, the verb wins.
    expect(presence.touchAgentPresence("doc-b", agentActor(), "commenting", undefined, t0 + 2000 + presence.AGENT_PRESENCE_TTL_MS)).toMatchObject({ status: "commenting" });

    // recordAgentActivity (called by every write route) marks presence when the doc is a live Hocuspocus document.
    const live = Object.assign(new Y.Doc(), { name: "doc-c" });
    recordAgentActivity(live, agentActor("Reviewer"), "suggested");
    expect(presence.listAgentPresence("doc-c", Date.now())).toEqual([expect.objectContaining({ name: "Reviewer", status: "suggesting" })]);
    recordAgentActivity(new Y.Doc(), agentActor("Detached"), "edited");
    expect(presence.listAgentPresence("doc-c", Date.now())).toHaveLength(1);
    presence.resetAgentPresence();
  });

  it("publishes agents into the document's awareness so browsers see a bot avatar, and removes them on left/expiry", async () => {
    presence.resetAgentPresence();
    const human = await connectHuman();
    try {
      const res = await asAgent(() => POST_PRESENCE(req(`/api/agent/documents/${docId}/presence`, { state: "active", status: "drafting the summary" }), params(docId)));
      expect(res.status).toBe(200);
      await waitFor(() => human.agents().length === 1);
      expect(human.agents()[0]).toMatchObject({ name: "Copilot", isAgent: true, status: "drafting the summary" });

      // Visible through the REST listing too (humans may read it).
      const list = (await (await asHuman(() => GET_PRESENCE(req(`/api/agent/documents/${docId}/presence`), params(docId)))).json()) as { agents: { name: string }[] };
      expect(list.agents.map((a) => a.name)).toEqual(["Copilot"]);

      // A write by another agent shows up implicitly with an "editing" status.
      const other = (await createApiToken(owner.id, "Scribe")).token;
      await asAgent(() => PUT_CONTENT(req(`/api/documents/${docId}/content`, { content: "# Watched\n\nFirst paragraph, revised.\n\nSecond paragraph.\n" }, "PUT"), params(docId)), other);
      await waitFor(() => human.agents().length === 2);
      expect(human.agents().find((a) => a.name === "Scribe")).toMatchObject({ status: "editing" });

      await asAgent(() => POST_PRESENCE(req(`/api/agent/documents/${docId}/presence`, { state: "left" }), params(docId)));
      await waitFor(() => human.agents().length === 1);
      expect(human.agents()[0].name).toBe("Scribe");

      // Re-joining right after `left` is visible at once: the awareness clock keeps growing past the removal clients saw.
      await asAgent(() => POST_PRESENCE(req(`/api/agent/documents/${docId}/presence`, { state: "active", status: "back" }), params(docId)));
      await waitFor(() => human.agents().some((a) => a.name === "Copilot" && a.status === "back"), 1000);
      await asAgent(() => POST_PRESENCE(req(`/api/agent/documents/${docId}/presence`, { state: "left" }), params(docId)));
      await waitFor(() => human.agents().length === 1);

      // Expiry through the sweeper removes the rest.
      presence.sweep(Date.now() + presence.AGENT_PRESENCE_TTL_MS + 1);
      await waitFor(() => human.agents().length === 0);

      // Humans cannot post presence.
      const forbidden = await asHuman(() => POST_PRESENCE(req(`/api/agent/documents/${docId}/presence`, { state: "active" }), params(docId)));
      expect(forbidden.status).toBe(403);
    } finally {
      human.close();
    }
  });
});

describe("agent caret", () => {
  it("places the caret from an anchor or clean offsets and publishes it as relative positions browsers resolve", async () => {
    presence.resetAgentPresence();
    const human = await connectHuman();
    try {
      const text = human.ydoc.getText("content").toString();
      const res = await asAgent(() => POST_PRESENCE(req(`/api/agent/documents/${docId}/presence`, { state: "active", status: "reading", anchor: "Second paragraph" }), params(docId)));
      expect(res.status).toBe(200);
      const { presence: p } = (await res.json()) as { presence: { cursor: { from: number; to: number } } };
      const cleanIdx = text.indexOf("Second paragraph");
      expect(p.cursor).toEqual({ from: cleanIdx, to: cleanIdx + "Second paragraph".length });

      await waitFor(() => human.agents().length === 1);
      const state = [...human.provider.awareness!.getStates().values()].find((s) => (s.user as { isAgent?: boolean })?.isAgent) as { cursor?: { anchor: unknown; head: unknown }; user: { userLogin?: string } };
      expect(state.cursor?.anchor).toBeTruthy();
      expect(state.user.userLogin).toBe("olive");
      const ytext = human.ydoc.getText("content");
      const abs = (rel: unknown) => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel as Parameters<typeof Y.createRelativePositionFromJSON>[0]), human.ydoc)!;
      expect(abs(state.cursor!.anchor).index).toBe(ytext.toString().indexOf("Second paragraph"));
      expect(abs(state.cursor!.head).index).toBe(ytext.toString().indexOf("Second paragraph") + "Second paragraph".length);

      // An anchor that does not occur is a 400; offsets are clamped to the clean text.
      const missing = await asAgent(() => POST_PRESENCE(req(`/api/agent/documents/${docId}/presence`, { state: "active", anchor: "nowhere to be found" }), params(docId)));
      expect(missing.status).toBe(400);
      const far = (await (await asAgent(() => POST_PRESENCE(req(`/api/agent/documents/${docId}/presence`, { state: "active", cursor: { from: 5, to: 10_000 } }), params(docId)))).json()) as { presence: { cursor: { from: number; to: number } } };
      expect(far.presence.cursor).toEqual({ from: 5, to: text.length });

      // A suggestion moves the caret to the end of the first edit (raw offsets: the insertion lands before the struck text).
      const sres = await asAgent(() => POST_SUGGEST(req(`/api/documents/${docId}/suggest`, { edits: [{ find: "First paragraph", replace: "Opening paragraph" }] }), params(docId)));
      expect(sres.status).toBe(200);
      await waitFor(() => {
        const s = [...human.provider.awareness!.getStates().values()].find((s) => (s.user as { isAgent?: boolean })?.isAgent) as { cursor?: { head: unknown } } | undefined;
        return !!s?.cursor && abs(s.cursor.head).index !== ytext.toString().indexOf("Second paragraph") + "Second paragraph".length;
      });
      const moved = [...human.provider.awareness!.getStates().values()].find((s) => (s.user as { isAgent?: boolean })?.isAgent) as { cursor: { head: unknown } };
      const raw = ytext.toString();
      // Word diff: "First" → "Opening" is the first edit; its end is right after the kept (struck) "First".
      const end = abs(moved.cursor.head).index;
      expect(raw.slice(0, end)).toContain("Opening");
      expect(end).toBeLessThanOrEqual(raw.indexOf(" paragraph"));
      const listed = presence.listAgentPresence(docId)[0];
      // In clean offsets the pending insertion does not count.
      expect(listed.cursor!.from).toBe(text.indexOf("First") + "First".length);

      // `cursor: null` hides it.
      await asAgent(() => POST_PRESENCE(req(`/api/agent/documents/${docId}/presence`, { state: "idle", cursor: null }), params(docId)));
      await waitFor(() => {
        const s = [...human.provider.awareness!.getStates().values()].find((s) => (s.user as { isAgent?: boolean })?.isAgent) as { cursor?: unknown } | undefined;
        return !!s && s.cursor === undefined;
      });
      await asAgent(() => POST_PRESENCE(req(`/api/agent/documents/${docId}/presence`, { state: "left" }), params(docId)));
    } finally {
      human.close();
    }
  });
});

describe("agents in the @-mention picker", () => {
  it("lists present agents and agents active in the last 30 days, not expired ones", async () => {
    presence.resetAgentPresence();
    const t0 = Date.now();
    presence.setAgentPresence(docId, agentActor("Copilot CLI"), { state: "active" }, t0);
    // An agent that only wrote here (activity row) in the past month, and one whose activity is older.
    await recordActivity(docId, activityActor(agentActor("Scribe")), "suggestion.add", { count: 1 });
    await recordActivity(docId, activityActor(agentActor("Old Bot")), "comment.add", {}, new Date(t0 - 31 * 24 * 60 * 60 * 1000));
    const res = await asHuman(() => GET_COLLABORATORS(req(`/api/documents/${docId}/collaborators`), params(docId)));
    expect(res.status).toBe(200);
    const { agents } = (await res.json()) as { agents: { name: string; login: string; ownerLogin: string; present: boolean }[] };
    // Present agents first, then the recently active ones; "Old Bot" (31 days) is out.
    expect(agents[0]).toMatchObject({ name: "Copilot CLI", login: "olive/Copilot-CLI", ownerLogin: "olive", present: true });
    expect(agents.find((a) => a.name === "Scribe")).toMatchObject({ login: "olive/Scribe", present: false });
    expect(agents.map((a) => a.name)).not.toContain("Old Bot");

    // Once the presence expires, the present one is gone too (it has no activity rows).
    presence.sweep(t0 + presence.AGENT_PRESENCE_TTL_MS + 1);
    const later = (await (await asHuman(() => GET_COLLABORATORS(req(`/api/documents/${docId}/collaborators`), params(docId)))).json()) as { agents: { name: string }[] };
    expect(later.agents.map((a) => a.name)).not.toContain("Copilot CLI");
    expect(later.agents.map((a) => a.name)).toContain("Scribe");
  });

  it("@owner/Agent by the owner returns every named agent target without badging the owner", async () => {
    const { cursor } = (await (await asAgent(() => GET_EVENTS(req(`/api/agent/documents/${docId}/events`), params(docId)))).json()) as { cursor: string };
    const before = (await (await asHuman(() => GET_NOTIFICATIONS(req(`/api/notifications?unread=1`)))).json()) as { unreadCount: number };
    const waiting = asAgent(() => GET_EVENTS(req(`/api/agent/documents/${docId}/events?since=${cursor}&wait=20`), params(docId)));
    await sleep(100);
    const body = `@olive/Other-agent ${"context ".repeat(20)}@olive/Copilot tighten this`;
    const add = await asHuman(() => POST_COMMENTS(req(`/api/documents/${docId}/comments`, { action: "add", quote: "Second paragraph", body }), params(docId)));
    expect(add.status).toBe(200);
    const started = Date.now();
    const page = (await (await waiting).json()) as { events: { type: string; snippet?: string; agent?: string | null; agents?: string[]; byLogin?: string | null }[] };
    expect(Date.now() - started).toBeLessThan(2000);
    const mention = page.events.find((e) => e.type === "mention");
    expect(mention).toMatchObject({ agent: "Other-agent", agents: ["Other-agent", "Copilot"], byLogin: "olive" });
    expect(mention?.snippet).not.toContain("@olive/Copilot");
    // Pre-read for the owner: no new unread notification.
    const after = (await (await asHuman(() => GET_NOTIFICATIONS(req(`/api/notifications?unread=1`)))).json()) as { unreadCount: number };
    expect(after.unreadCount).toBe(before.unreadCount);
    // A plain self-mention is still dropped entirely.
    const self = await asHuman(() => POST_COMMENTS(req(`/api/documents/${docId}/comments`, { action: "add", quote: "Second paragraph", body: "note to @olive" }), params(docId)));
    expect(self.status).toBe(200);
    const all = (await (await asHuman(() => GET_NOTIFICATIONS(req(`/api/notifications?kind=mention&limit=100`)))).json()) as { items: { snippet: string }[] };
    expect(all.items.some((i) => i.snippet === "note to @olive")).toBe(false);
  });
});

describe("agent events (watch)", () => {
  it("returns only a cursor without since, clamps wait, rejects bad cursors", async () => {
    const res = await asAgent(() => GET_EVENTS(req(`/api/agent/documents/${docId}/events`), params(docId)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cursor: string; events: unknown[]; waitMax: number };
    expect(body.events).toEqual([]);
    expect(typeof body.cursor).toBe("string");
    expect(body.waitMax).toBe(55);
    expect(events.clampWait("120")).toBe(55);
    expect(events.clampWait("abc")).toBe(0);
    expect(events.clampWait("-3")).toBe(0);
    expect(events.clampWait("7.9")).toBe(7);
    const bad = await asAgent(() => GET_EVENTS(req(`/api/agent/documents/${docId}/events?since=%%%`), params(docId)));
    expect(bad.status).toBe(400);
    const human = await asHuman(() => GET_EVENTS(req(`/api/agent/documents/${docId}/events`), params(docId)));
    expect(human.status).toBe(403);
  });

  it("wakes a waiter when a comment is added and reports replies, resolves, mentions and requests", async () => {
    const { cursor } = (await (await asAgent(() => GET_EVENTS(req(`/api/agent/documents/${docId}/events`), params(docId)))).json()) as { cursor: string };

    const started = Date.now();
    const waiting = asAgent(() => GET_EVENTS(req(`/api/agent/documents/${docId}/events?since=${cursor}&wait=20`), params(docId)));
    await sleep(150);
    const add = await asHuman(() => POST_COMMENTS(req(`/api/documents/${docId}/comments`, { action: "add", quote: "First paragraph", body: "Is this right, @olive?" }), params(docId)));
    expect(add.status).toBe(200);
    const { id: threadId } = (await add.json()) as { id: string };
    const page = (await (await waiting).json()) as { cursor: string; events: { type: string; threadId?: string; body?: string; author?: string }[] };
    expect(Date.now() - started).toBeLessThan(5000);
    expect(page.events.map((e) => e.type)).toContain("comment.added");
    expect(page.events.find((e) => e.type === "comment.added")).toMatchObject({ threadId, author: "Olive", body: "Is this right, @olive?" });
    // The mention from the human to the token's user is not a self-mention: olive commented, so no row.
    expect(page.events.filter((e) => e.type === "mention")).toHaveLength(0);

    // Reply (REST) + resolve + a mention by someone else + an Ask-an-agent request.
    await asHuman(() => POST_COMMENTS(req(`/api/documents/${docId}/comments`, { action: "reply", threadId, body: "Yes." }), params(docId)));
    await asHuman(() => POST_COMMENTS(req(`/api/documents/${docId}/comments`, { action: "resolve", threadId, resolved: true }), params(docId)));
    await notify({ userLogin: "olive", documentId: docId, kind: "mention", actorLogin: "cam", actorName: "Cam", refId: "reply-x", snippet: "@olive take a look" });
    const request = await createRequest(docId, owner, "owner", { instruction: "Tighten the intro", mode: "suggest" });

    const next = (await (await asAgent(() => GET_EVENTS(req(`/api/agent/documents/${docId}/events?since=${page.cursor}`), params(docId)))).json()) as {
      cursor: string;
      events: { type: string; requestId?: string; snippet?: string; threadId?: string }[];
    };
    const types = next.events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["comment.replied", "comment.resolved", "mention", "request.created"]));
    expect(next.events.find((e) => e.type === "request.created")).toMatchObject({ requestId: request.id });
    expect(next.events.find((e) => e.type === "mention")).toMatchObject({ snippet: "@olive take a look" });
    // Nothing is returned twice.
    const again = (await (await asAgent(() => GET_EVENTS(req(`/api/agent/documents/${docId}/events?since=${next.cursor}`), params(docId)))).json()) as { events: unknown[] };
    expect(again.events).toEqual([]);
  });

  it("produces a unified diff of the clean text when the content changes", async () => {
    const { cursor } = (await (await asAgent(() => GET_EVENTS(req(`/api/agent/documents/${docId}/events`), params(docId)))).json()) as { cursor: string };
    const waiting = asAgent(() => GET_EVENTS(req(`/api/agent/documents/${docId}/events?since=${cursor}&wait=20`), params(docId)));
    await sleep(100);
    const human = await connectHuman();
    try {
      const ytext = human.ydoc.getText("content");
      ytext.insert(ytext.length, "\nA brand new closing line.\n");
      const page = (await (await waiting).json()) as { events: { type: string; diff?: string | null; contentHash?: string; previousHash?: string }[] };
      const changed = page.events.find((e) => e.type === "content.changed");
      expect(changed).toBeTruthy();
      expect(changed!.previousHash).not.toBe(changed!.contentHash);
      expect(changed!.diff).toContain("+A brand new closing line.");
      expect(changed!.diff).not.toContain("+++ ");
    } finally {
      human.close();
    }
  });

  it("caps diffs and truncates long ones", () => {
    const before = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const after = Array.from({ length: 400 }, (_, i) => `line ${i} changed`).join("\n");
    const d = events.unifiedDiff(before, after);
    expect(d.truncated).toBe(true);
    expect(d.diff.split("\n").length).toBeLessThanOrEqual(events.DIFF_MAX_LINES + 1);
    expect(events.unifiedDiff("a\nb\n", "a\nc\n")).toEqual({ diff: expect.stringContaining("-b\n+c"), truncated: false });
  });

  it("times out with no events when nothing happens", async () => {
    const { cursor } = (await (await asAgent(() => GET_EVENTS(req(`/api/agent/documents/${docId}/events`), params(docId)))).json()) as { cursor: string };
    const t = Date.now();
    const page = (await (await asAgent(() => GET_EVENTS(req(`/api/agent/documents/${docId}/events?since=${cursor}&wait=1`), params(docId)))).json()) as { events: unknown[] };
    expect(page.events).toEqual([]);
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
  });

  it("cross-document watch wakes on a request in any document the user can see", async () => {
    const { cursor } = (await (await asAgent(() => GET_ALL_EVENTS(req(`/api/agent/events`)))).json()) as { cursor: string };
    const waiting = asAgent(() => GET_ALL_EVENTS(req(`/api/agent/events?since=${cursor}&wait=20`)));
    await sleep(100);
    const request = await createRequest(otherDocId, owner, "editor", { instruction: "Summarize", mode: "comment" });
    const page = (await (await waiting).json()) as { cursor: string; events: { type: string; requestId?: string; documentId?: string; documentTitle?: string }[] };
    expect(page.events).toEqual([expect.objectContaining({ type: "request.created", requestId: request.id, documentId: otherDocId, documentTitle: "Cam's" })]);
    // Activity on a document is ignored by the inbox (it only carries mentions and requests).
    await recordActivity(docId, activityActor(owner), "version.save", { number: 1 });
    const quiet = (await (await asAgent(() => GET_ALL_EVENTS(req(`/api/agent/events?since=${page.cursor}`)))).json()) as { events: unknown[] };
    expect(quiet.events).toEqual([]);
  });
});
