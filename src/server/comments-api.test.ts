import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import * as Y from "yjs";
import { eq } from "drizzle-orm";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.RATE_LIMIT = "off";
delete process.env.DATABASE_URL;

// The route resolves the caller through next-auth and `next/headers`, neither of which
// runs outside a Next request; `actor` is whoever the next request comes from.
type TestActor = { id: string; login: string; name: string; image: null };
let actor: TestActor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// Wrapped so a test can make the activity insert or the request link fail after the comment is written.
vi.mock("@/server/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/activity")>();
  return { ...actual, recordActivity: vi.fn(actual.recordActivity) };
});
// Wrapped so a test can show a request was refused before the document was opened at all.
vi.mock("@/server/livedoc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/livedoc")>();
  return { ...actual, mutateLiveDoc: vi.fn(actual.mutateLiveDoc) };
});
vi.mock("@/server/agent-requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/agent-requests")>();
  return { ...actual, attachWork: vi.fn(actual.attachWork) };
});

const { getDb, schema } = await import("@/server/db");
const { createDocument, upsertCollaborator } = await import("@/server/documents");
const { createCollabServer, shutdownCollab, TEXT_KEY } = await import("@/server/collab/hocuspocus");
const { attachCollab } = await import("@/server/collab/ws");
const { signCollabToken } = await import("@/server/collab/token");
const { registerCollab } = await import("@/server/collab/registry");
const { mutateLiveDoc, readLiveDoc } = await import("@/server/livedoc");
const { listNotifications } = await import("@/server/notifications");
const { listActivity, recordActivity } = await import("@/server/activity");
const { attachWork, completeRequest, createRequest, listRequests } = await import("@/server/agent-requests");
const { CommentsModel } = await import("@/editor/collab/comments");
const { POST, GET } = await import("@/app/api/documents/[id]/comments/route");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (id: string, body: unknown) =>
  POST(new Request(`http://localhost:3700/api/documents/${id}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), params(id));
const get = (id: string) => GET(new Request(`http://localhost:3700/api/documents/${id}/comments`), params(id));

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

async function createUser(login: string, name: string): Promise<TestActor> {
  const db = await getDb();
  const [user] = await db.insert(schema.users).values({ name, login, email: `${login}@example.com` }).returning();
  return { id: user.id, login, name, image: null };
}

type SuggestionJson = { text: string; source: string; state: "pending" | "outdated" | "accepted" | "rejected"; by: string | null; at: string | null };
type ReplyJson = { id: string; body: string; author: string; authorId: string; suggestion: SuggestionJson | null };
type ThreadJson = {
  id: string;
  body: string;
  author: string;
  authorId: string;
  mentions: string[];
  quote: string | null;
  currentText: string | null;
  suggestion: SuggestionJson | null;
  replies: ReplyJson[];
};

describe("POST /api/documents/:id/comments as a commenter", () => {
  let server: Server;
  let url: string;
  let hocuspocus: ReturnType<typeof createCollabServer>;
  let alice: TestActor;
  let carol: TestActor;
  let victor: TestActor;
  let docId: string;
  // Alice keeps the document open over a WebSocket, like an editor in the browser.
  let aliceDoc: Y.Doc;
  let aliceProvider: HocuspocusProvider;
  let aliceSocket: HocuspocusProviderWebsocket;

  beforeAll(async () => {
    alice = await createUser("alice", "Alice");
    carol = await createUser("carol-commenter", "Carol");
    victor = await createUser("victor", "Victor");
    const doc = await createDocument({ ownerId: alice.id, content: "# Shared doc\n\nFirst paragraph.\n" });
    docId = doc.id;
    await upsertCollaborator(docId, carol.login, "commenter", alice.id);
    await upsertCollaborator(docId, victor.login, "viewer", alice.id);

    hocuspocus = createCollabServer();
    hocuspocus.configuration.debounce = 50;
    hocuspocus.configuration.maxDebounce = 100;
    registerCollab(hocuspocus);
    server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    attachCollab(server, hocuspocus, { path: "/collab" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/collab`;

    const token = await signCollabToken({ userId: alice.id, docId, role: "owner", name: alice.name, login: alice.login, avatar: null });
    aliceDoc = new Y.Doc();
    aliceSocket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket });
    aliceProvider = new HocuspocusProvider({ websocketProvider: aliceSocket, name: docId, document: aliceDoc, token });
    aliceProvider.attach();
    await waitFor(() => aliceDoc.getText(TEXT_KEY).toString().includes("First paragraph."));
  });

  afterAll(async () => {
    aliceProvider.destroy();
    aliceSocket.destroy();
    await shutdownCollab(hocuspocus);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("adds the comment to the live document, answers promptly and records the mention once", async () => {
    actor = carol;
    const started = Date.now();
    const res = await post(docId, { action: "add", quote: "First paragraph", body: "Nice section, @alice." });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);
    const { id } = (await res.json()) as { id: string };
    expect(id).toBeTruthy();

    // Alice, connected over the WebSocket, receives the thread from the server.
    await waitFor(() => aliceDoc.getMap("comments").has(id));
    const model = new CommentsModel(aliceDoc, aliceDoc.getText(TEXT_KEY));
    try {
      const thread = model.get(id);
      expect(thread?.body).toBe("Nice section, @alice.");
      expect(thread?.authorId).toBe(carol.id);
      expect(thread?.authorLogin).toBe(carol.login);
      expect(thread?.mentions).toEqual(["alice"]);
      expect(thread?.range).toEqual({ from: 14, to: 29 });
    } finally {
      model.destroy();
    }

    // The mention is stored exactly once even though both the live-document watcher and the route record it.
    const db = await getDb();
    const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.refId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ documentId: docId, kind: "mention", userLogin: "alice", actorLogin: carol.login });
    const unread = await listNotifications("alice", { unread: true });
    expect(unread.items.map((m) => m.refId)).toContain(id);

    // And the commenter can read it back through the API.
    const list = await get(docId);
    expect(list.status).toBe(200);
    const { comments } = (await list.json()) as { comments: ThreadJson[] };
    expect(comments.map((c) => c.id)).toContain(id);
    expect(comments.find((c) => c.id === id)).toMatchObject({ author: "Carol", authorId: carol.id, mentions: ["alice"], currentText: "First paragraph" });
  });

  it("lets the commenter reply to and edit their own comment but not others'", async () => {
    actor = alice;
    const aliceThread = (await (await post(docId, { action: "add", from: 0, to: 12, body: "Title looks good." })).json()) as { id: string };

    actor = carol;
    const reply = await post(docId, { action: "reply", threadId: aliceThread.id, body: "Agreed, @victor?" });
    expect(reply.status).toBe(200);
    const { id: replyId } = (await reply.json()) as { id: string };
    expect(replyId).toBeTruthy();

    const ownEdit = await post(docId, { action: "edit", threadId: aliceThread.id, replyId, body: "Agreed!" });
    expect(ownEdit.status).toBe(200);

    const othersEdit = await post(docId, { action: "edit", threadId: aliceThread.id, body: "Changed by Carol" });
    expect(othersEdit.status).toBe(403);
    const othersDelete = await post(docId, { action: "delete", threadId: aliceThread.id });
    expect(othersDelete.status).toBe(403);

    const { comments } = (await (await get(docId)).json()) as { comments: (ThreadJson & { replies: { id: string; body: string }[] })[] };
    const thread = comments.find((c) => c.id === aliceThread.id);
    expect(thread?.body).toBe("Title looks good.");
    expect(thread?.replies).toEqual([expect.objectContaining({ id: replyId, body: "Agreed!" })]);
  });

  it("accepts reply suggestions independently, persists their state, and targets activity and notifications to the reply", async () => {
    actor = alice;
    const root = (await (await post(docId, { action: "add", quote: "First paragraph.", body: "Could this be clearer?" })).json()) as { id: string };
    actor = carol;
    const first = (await (await post(docId, { action: "reply", threadId: root.id, body: "Yes.\n\n```suggestion\nOpening paragraph.\n```" })).json()) as { id: string };
    const second = (await (await post(docId, { action: "reply", threadId: root.id, body: "Another option.\n\n```suggestion\nIntroductory paragraph.\n```" })).json()) as { id: string };

    let comments = ((await (await get(docId)).json()) as { comments: ThreadJson[] }).comments;
    let thread = comments.find((item) => item.id === root.id)!;
    expect(thread.replies.map((reply) => reply.suggestion?.state)).toEqual(["pending", "pending"]);
    expect(thread.replies.map((reply) => reply.suggestion?.source)).toEqual(["First paragraph.", "First paragraph."]);

    actor = victor;
    expect((await post(docId, { action: "suggestion", threadId: root.id, replyId: first.id, decision: "accept" })).status).toBe(403);
    actor = carol;
    expect((await post(docId, { action: "suggestion", threadId: root.id, replyId: first.id, decision: "accept" })).status).toBe(403);

    actor = alice;
    const accepted = await post(docId, { action: "suggestion", threadId: root.id, replyId: first.id, decision: "accept" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, state: "accepted", replyId: first.id });
    await waitFor(() => aliceDoc.getText(TEXT_KEY).toString().includes("Opening paragraph."));

    comments = ((await (await get(docId)).json()) as { comments: ThreadJson[] }).comments;
    thread = comments.find((item) => item.id === root.id)!;
    expect(thread.replies[0].suggestion).toMatchObject({ state: "accepted", by: alice.id, source: "First paragraph." });
    expect(thread.replies[0].suggestion?.at).toBeTruthy();
    expect(thread.replies[1].suggestion).toMatchObject({ state: "pending", source: "Opening paragraph." });

    let activity = await listActivity(docId, { limit: 100 });
    expect(activity.items.filter((item) => item.action === "comment.suggestion.accepted" && item.detail.replyId === first.id)).toHaveLength(1);
    expect(activity.items.find((item) => item.detail.replyId === first.id)).toMatchObject({ detail: { threadId: root.id, replyId: first.id, author: "Carol" } });
    expect((await listNotifications(carol.login)).items.filter((item) => item.kind === "suggestion.accepted" && item.refId === first.id)).toHaveLength(1);

    expect((await post(docId, { action: "suggestion", threadId: root.id, replyId: first.id, decision: "accept" })).status).toBe(409);
    const acceptedSecond = await post(docId, { action: "suggestion", threadId: root.id, replyId: second.id, decision: "accept" });
    expect(acceptedSecond.status).toBe(200);
    await waitFor(() => aliceDoc.getText(TEXT_KEY).toString().includes("Introductory paragraph."));
    comments = ((await (await get(docId)).json()) as { comments: ThreadJson[] }).comments;
    thread = comments.find((item) => item.id === root.id)!;
    expect(thread.replies.map((reply) => reply.suggestion?.state)).toEqual(["accepted", "accepted"]);
    expect(thread.replies.map((reply) => reply.suggestion?.source)).toEqual(["First paragraph.", "Opening paragraph."]);
    activity = await listActivity(docId, { limit: 100 });
    expect(activity.items.filter((item) => item.action === "comment.suggestion.accepted" && [first.id, second.id].includes(String(item.detail.replyId)))).toHaveLength(2);
  });

  it("returns precise reply errors and lets commenters reject an outdated reply exactly once", async () => {
    actor = alice;
    const root = (await (await post(docId, { action: "add", quote: "# Shared doc", body: "Please revisit the title." })).json()) as { id: string };
    actor = carol;
    const plain = (await (await post(docId, { action: "reply", threadId: root.id, body: "No rewrite here." })).json()) as { id: string };
    const suggestion = (await (await post(docId, { action: "reply", threadId: root.id, body: "```suggestion\n# Updated doc\n```" })).json()) as { id: string };

    expect((await post(docId, { action: "suggestion", threadId: root.id, replyId: "missing", decision: "reject" })).status).toBe(404);
    expect((await post(docId, { action: "suggestion", threadId: root.id, replyId: plain.id, decision: "reject" })).status).toBe(400);

    await mutateLiveDoc(docId, { userId: alice.id, docId, role: "owner", name: alice.name, login: alice.login, avatar: null }, (doc) => {
      doc.getText(TEXT_KEY).insert(2, "Changed ");
    });
    await waitFor(() => aliceDoc.getText(TEXT_KEY).toString().includes("# Changed Shared doc"));
    actor = alice;
    const staleAccept = await post(docId, { action: "suggestion", threadId: root.id, replyId: suggestion.id, decision: "accept" });
    expect(staleAccept.status).toBe(409);
    expect((await staleAccept.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("outdated") });

    const unchanged = aliceDoc.getText(TEXT_KEY).toString();
    actor = carol;
    const rejected = await post(docId, { action: "suggestion", threadId: root.id, replyId: suggestion.id, decision: "reject" });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toEqual({ ok: true, state: "rejected", replyId: suggestion.id });
    expect((await post(docId, { action: "suggestion", threadId: root.id, replyId: suggestion.id, decision: "reject" })).status).toBe(409);
    expect(aliceDoc.getText(TEXT_KEY).toString()).toBe(unchanged);

    const comments = ((await (await get(docId)).json()) as { comments: ThreadJson[] }).comments;
    expect(comments.find((item) => item.id === root.id)!.replies.find((reply) => reply.id === suggestion.id)?.suggestion?.state).toBe("rejected");
    const activity = await listActivity(docId, { limit: 100 });
    expect(activity.items.filter((item) => item.action === "comment.suggestion.rejected" && item.detail.replyId === suggestion.id)).toHaveLength(1);
  });

  it("keeps an accepted root's source while a pending reply follows the advanced anchor", async () => {
    actor = alice;
    const root = (await (await post(docId, { action: "add", quote: "Introductory paragraph.", body: "```suggestion\nLead paragraph.\n```" })).json()) as { id: string };
    actor = carol;
    const reply = (await (await post(docId, { action: "reply", threadId: root.id, body: "```suggestion\nOpening paragraph.\n```" })).json()) as { id: string };

    actor = alice;
    expect((await post(docId, { action: "suggestion", threadId: root.id, decision: "accept" })).status).toBe(200);
    let comments = ((await (await get(docId)).json()) as { comments: ThreadJson[] }).comments;
    let thread = comments.find((item) => item.id === root.id)!;
    expect(thread.suggestion).toMatchObject({ state: "accepted", source: "Introductory paragraph." });
    expect(thread.replies[0].suggestion).toMatchObject({ state: "pending", source: "Lead paragraph." });

    const accepted = await post(docId, { action: "suggestion", threadId: root.id, replyId: reply.id, decision: "accept" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, state: "accepted", replyId: reply.id });
    comments = ((await (await get(docId)).json()) as { comments: ThreadJson[] }).comments;
    thread = comments.find((item) => item.id === root.id)!;
    expect(thread.suggestion?.source).toBe("Introductory paragraph.");
    expect(thread.replies[0].suggestion).toMatchObject({ state: "accepted", source: "Lead paragraph." });
  });

  it("returns 409 when accepted or rejected root and reply suggestion bodies are edited", async () => {
    const immutableDoc = await createDocument({ ownerId: alice.id, content: "Alpha beta gamma delta." });
    await upsertCollaborator(immutableDoc.id, carol.login, "commenter", alice.id);

    actor = alice;
    const acceptedRoot = (await (
      await post(immutableDoc.id, { action: "add", quote: "Alpha", body: "First draft.\n\n```suggestion\nALPHA\n```" })
    ).json()) as { id: string };
    const acceptedRootBody = "Updated draft.\n\n```suggestion\nALPHA\n```";
    expect((await post(immutableDoc.id, { action: "edit", threadId: acceptedRoot.id, body: acceptedRootBody })).status).toBe(200);
    expect((await post(immutableDoc.id, { action: "suggestion", threadId: acceptedRoot.id, decision: "accept" })).status).toBe(200);

    const rejectedRootBody = "Leave beta alone.\n\n```suggestion\nBETA\n```";
    const rejectedRoot = (await (await post(immutableDoc.id, { action: "add", quote: "beta", body: rejectedRootBody })).json()) as { id: string };
    expect((await post(immutableDoc.id, { action: "suggestion", threadId: rejectedRoot.id, decision: "reject" })).status).toBe(200);

    const acceptedParent = (await (await post(immutableDoc.id, { action: "add", quote: "gamma", body: "A reply can revise this." })).json()) as { id: string };
    actor = carol;
    const acceptedReplyBody = "Try this.\n\n```suggestion\nGAMMA\n```";
    const acceptedReply = (await (
      await post(immutableDoc.id, { action: "reply", threadId: acceptedParent.id, body: acceptedReplyBody })
    ).json()) as { id: string };
    actor = alice;
    expect((await post(immutableDoc.id, { action: "suggestion", threadId: acceptedParent.id, replyId: acceptedReply.id, decision: "accept" })).status).toBe(200);

    const rejectedParent = (await (await post(immutableDoc.id, { action: "add", quote: "delta", body: "Another reply can revise this." })).json()) as { id: string };
    actor = carol;
    const rejectedReplyBody = "Or this.\n\n```suggestion\nDELTA\n```";
    const rejectedReply = (await (
      await post(immutableDoc.id, { action: "reply", threadId: rejectedParent.id, body: rejectedReplyBody })
    ).json()) as { id: string };
    expect((await post(immutableDoc.id, { action: "suggestion", threadId: rejectedParent.id, replyId: rejectedReply.id, decision: "reject" })).status).toBe(200);

    const targets: { threadId: string; replyId?: string; state: "accepted" | "rejected"; editor: TestActor }[] = [
      { threadId: acceptedRoot.id, state: "accepted", editor: alice },
      { threadId: rejectedRoot.id, state: "rejected", editor: alice },
      { threadId: acceptedParent.id, replyId: acceptedReply.id, state: "accepted", editor: carol },
      { threadId: rejectedParent.id, replyId: rejectedReply.id, state: "rejected", editor: carol },
    ];
    for (const target of targets) {
      actor = target.editor;
      const response = await post(immutableDoc.id, { action: "edit", threadId: target.threadId, replyId: target.replyId, body: "Changed after the decision." });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: `Cannot edit a suggestion that was already ${target.state}` });
    }

    actor = alice;
    expect((await post(immutableDoc.id, { action: "edit", threadId: acceptedParent.id, replyId: acceptedReply.id, body: "Owner bypass." })).status).toBe(409);
    const comments = ((await (await get(immutableDoc.id)).json()) as { comments: ThreadJson[] }).comments;
    expect(comments.find((thread) => thread.id === acceptedRoot.id)?.body).toBe(acceptedRootBody);
    expect(comments.find((thread) => thread.id === rejectedRoot.id)?.body).toBe(rejectedRootBody);
    expect(comments.find((thread) => thread.id === acceptedParent.id)?.replies[0].body).toBe(acceptedReplyBody);
    expect(comments.find((thread) => thread.id === rejectedParent.id)?.replies[0].body).toBe(rejectedReplyBody);
  });

  it("answers 404 for a reply to an unknown thread and records nothing", async () => {
    actor = carol;
    const { comments: commentsBefore } = (await (await get(docId)).json()) as { comments: ThreadJson[] };
    const activityBefore = await listActivity(docId, { limit: 100 });

    const res = await post(docId, { action: "reply", threadId: "bogus", body: "ghost reply" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Comment not found" });

    // Same answer as the sibling actions for the same unknown thread.
    expect((await post(docId, { action: "edit", threadId: "bogus", body: "x" })).status).toBe(404);
    expect((await post(docId, { action: "delete", threadId: "bogus" })).status).toBe(404);

    const { comments } = (await (await get(docId)).json()) as { comments: ThreadJson[] };
    expect(comments).toEqual(commentsBefore);

    // No phantom comment.reply row (and no other activity) for the failed reply.
    const activity = await listActivity(docId, { limit: 100 });
    expect(activity.items).toHaveLength(activityBefore.items.length);
    expect(activity.items.filter((a) => a.action === "comment.reply" && (a.detail as { threadId?: string }).threadId === "bogus")).toEqual([]);

    const db = await getDb();
    const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.refId, "bogus"));
    expect(rows).toHaveLength(0);
  });

  it("rejects viewers and anonymous callers", async () => {
    actor = victor;
    expect((await post(docId, { action: "add", from: 0, to: 5, body: "Nope" })).status).toBe(403);
    actor = null;
    expect((await post(docId, { action: "add", from: 0, to: 5, body: "Nope" })).status).toBe(401);
  });

  describe("an anchor from the browser (#2258)", () => {
    /** The document as a commenter's browser holds it: a copy that may be behind the server's. */
    const browserCopy = () => {
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(aliceDoc));
      return copy;
    };
    const anchorOn = (copy: Y.Doc, quote: string) => {
      const text = copy.getText(TEXT_KEY);
      const from = text.toString().indexOf(quote);
      expect(from).toBeGreaterThanOrEqual(0);
      const to = from + quote.length;
      return {
        from,
        to,
        anchor: {
          start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, from, 0)),
          end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, to, -1)),
        },
      };
    };
    const threads = async () => ((await (await get(docId)).json()) as { comments: ThreadJson[] }).comments;
    const serverText = () => readLiveDoc(docId, (doc) => doc.getText(TEXT_KEY).toString());

    it("puts the comment on the text the commenter selected when keys landed on the server after the browser's copy", async () => {
      const copy = browserCopy();
      const selected = anchorOn(copy, "paragraph");
      // Keys the commenter's browser has not seen yet when Post is pressed.
      aliceDoc.getText(TEXT_KEY).insert(0, "Typed meanwhile. ");
      await expect.poll(serverText).toMatch(/^Typed meanwhile\. /);
      actor = carol;

      // The offsets alone, as the browser sent them before, land that many characters to the left.
      const byOffsets = await post(docId, { action: "add", from: selected.from, to: selected.to, body: "By the browser's offsets" });
      const stale = ((await byOffsets.json()) as { id: string }).id;
      expect((await threads()).find((thread) => thread.id === stale)?.quote).not.toBe("paragraph");

      const res = await post(docId, { action: "add", ...selected, body: "Anchored by the browser" });
      expect(res.status).toBe(200);
      const { id } = (await res.json()) as { id: string };
      expect((await threads()).find((thread) => thread.id === id)).toMatchObject({ quote: "paragraph", currentText: "paragraph" });
      copy.destroy();
    });

    it("still takes plain offsets and a quote, unchanged, for agents and other callers", async () => {
      actor = carol;
      const text = aliceDoc.getText(TEXT_KEY).toString();
      const from = text.indexOf("Shared");
      const byOffsets = (await (await post(docId, { action: "add", from, to: from + 6, body: "By offsets" })).json()) as { id: string };
      const byQuote = (await (await post(docId, { action: "add", quote: "Shared", body: "By quote" })).json()) as { id: string };
      const all = await threads();
      expect(all.find((thread) => thread.id === byOffsets.id)).toMatchObject({ quote: "Shared", currentText: "Shared" });
      expect(all.find((thread) => thread.id === byQuote.id)).toMatchObject({ quote: "Shared", currentText: "Shared" });
    });

    it.each([
      ["not an object", "garbage"],
      ["an end that is missing", { start: { tname: "content", assoc: -1 } }],
      ["an unknown key", { start: { tname: "content" }, end: { tname: "content" }, extra: true }],
      ["a key inside a position that is not a relative position's", { start: { tname: "content", evil: "x".repeat(100_000) }, end: { tname: "content" } }],
      ["another shared type by name", { start: { tname: "comments" }, end: { tname: "comments" } }],
      ["a nested type id", { start: { type: { client: 1, clock: 0 } }, end: { type: { client: 1, clock: 0 } } }],
      ["a clock that is not a whole number", { start: { item: { client: 1, clock: 1.5 } }, end: { item: { client: 1, clock: 2 } } }],
      ["a negative clock", { start: { item: { client: 1, clock: -1 } }, end: { item: { client: 1, clock: 2 } } }],
      ["a clock past the largest whole number", { start: { item: { client: 1, clock: 1e308 } }, end: { item: { client: 1, clock: 2 } } }],
      ["a client id past 32 bits", { start: { item: { client: 2 ** 40, clock: 1 } }, end: { item: { client: 1, clock: 2 } } }],
      ["a clock that is a string", { start: { item: { client: 1, clock: "7" } }, end: { item: { client: 1, clock: 2 } } }],
      ["an item that is an array", { start: { item: [1, 2] }, end: { item: [1, 3] } }],
      ["deep nesting where an item id belongs", { start: { item: { client: { client: { client: 1 } }, clock: { clock: 1 } } }, end: { tname: "content" } }],
      ["a wrong assoc", { start: { tname: "content", assoc: 7 }, end: { tname: "content", assoc: -1 } }],
    ])("refuses %s by its shape with 400, before the document is looked at, and writes nothing", async (_what, anchor) => {
      actor = carol;
      const before = (await threads()).length;
      vi.mocked(mutateLiveDoc).mockClear();
      const res = await post(docId, { action: "add", from: 0, to: 5, anchor, body: "Must not land" });
      expect(res.status).toBe(400);
      expect(mutateLiveDoc, "the document is not opened").not.toHaveBeenCalled();
      expect((await threads()).length).toBe(before);
      expect((await threads()).some((thread) => thread.body === "Must not land")).toBe(false);
    });

    /** A well-formed anchor that names nothing in the server's text: the request's own offsets are used, and the answer says so. */
    const fallsBack = async (anchor: unknown, body: string) => {
      actor = carol;
      const text = await serverText();
      const from = text.indexOf("Shared");
      const res = await post(docId, { action: "add", from, to: from + 6, anchor, body });
      expect(res.status).toBe(200);
      const answer = (await res.json()) as { id: string; anchored?: boolean };
      expect(answer.anchored).toBe(false);
      expect((await threads()).find((thread) => thread.id === answer.id)).toMatchObject({ quote: "Shared", currentText: "Shared" });
    };

    it("an anchor made on another document is not guessed at: the offsets of the same request are used", async () => {
      const other = new Y.Doc();
      other.getText(TEXT_KEY).insert(0, "# Another document\n\nFirst paragraph.\n");
      await fallsBack(anchorOn(other, "paragraph").anchor, "From another document");
      other.destroy();
    });

    it("an anchor whose items the server does not hold (a browser ahead of it, a restored document) falls back the same way", async () => {
      const ahead = browserCopy();
      ahead.getText(TEXT_KEY).insert(0, "Only in this browser. ");
      const text = ahead.getText(TEXT_KEY);
      const anchor = {
        start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 0, 0)),
        end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 4, -1)),
      };
      await fallsBack(anchor, "From a browser that is ahead");
      ahead.destroy();
      await fallsBack({ start: { item: { client: 1, clock: Number.MAX_SAFE_INTEGER } }, end: { item: { client: 1, clock: Number.MAX_SAFE_INTEGER } } }, "The largest clock there is");
    });

    it("an anchor whose start is after its end falls back the same way", async () => {
      const copy = browserCopy();
      const { anchor } = anchorOn(copy, "paragraph");
      copy.destroy();
      await fallsBack({ start: anchor.end, end: anchor.start }, "Inside out");
    });

    it("an item of this document that belongs to another shared type (a comment thread, the reactions map) is never a place in the text", async () => {
      actor = carol;
      const made = (await (await post(docId, { action: "add", quote: "Shared", body: "A thread to point at" })).json()) as { id: string };
      await waitFor(() => aliceDoc.getMap("comments").has(made.id));
      // The items Yjs made for that thread: the map entry and what is inside it.
      const comments = aliceDoc.getMap<Y.Map<unknown>>("comments");
      const ids = [comments._map.get(made.id)!.id, comments.get(made.id)!._map.get("body")!.id, comments.get(made.id)!._map.get("reactions")!.id];
      for (const id of ids) {
        const position = { item: { client: id.client, clock: id.clock } };
        await fallsBack({ start: { ...position, assoc: 0 }, end: { ...position, assoc: -1 } }, `Pointing at item ${id.client}:${id.clock} of the comments map`);
      }
    });

    it("an anchor that names nothing, in a request with no from/to to use instead, is refused and writes nothing", async () => {
      actor = carol;
      const before = (await threads()).length;
      const res = await post(docId, { action: "add", anchor: { start: { item: { client: 4242424242, clock: 3 } }, end: { item: { client: 4242424242, clock: 9 } } }, body: "Must not land" });
      expect(res.status).toBe(400);
      expect((await threads()).length).toBe(before);
    });

    it("the stored quote is the server's own text at the resolved range, whatever offsets came with the anchor", async () => {
      const copy = browserCopy();
      const { anchor } = anchorOn(copy, "paragraph");
      copy.destroy();
      actor = carol;
      // Offsets that point somewhere else entirely, and past the end: the anchor decides, the server reads its own text.
      const res = await post(docId, { action: "add", from: 0, to: 999_999, anchor, body: "The server quotes its own text" });
      expect(res.status).toBe(200);
      const answer = (await res.json()) as { id: string; anchored?: boolean };
      expect(answer).toEqual({ id: answer.id });
      await waitFor(() => aliceDoc.getMap("comments").has(answer.id));
      const model = new CommentsModel(aliceDoc, aliceDoc.getText(TEXT_KEY));
      try {
        const thread = model.get(answer.id)!;
        const text = await serverText();
        expect(thread.quote).toBe("paragraph");
        expect(text.slice(thread.range!.from, thread.range!.to)).toBe(thread.quote);
      } finally {
        model.destroy();
      }
    });

    it("an editor may send an anchor too, and it lands the same way", async () => {
      const copy = browserCopy();
      const selected = anchorOn(copy, "paragraph");
      copy.destroy();
      actor = alice;
      const res = await post(docId, { action: "add", ...selected, body: "From the owner" });
      expect(res.status).toBe(200);
      const answer = (await res.json()) as { id: string };
      expect(answer).toEqual({ id: answer.id });
      expect((await threads()).find((thread) => thread.id === answer.id)).toMatchObject({ quote: "paragraph", currentText: "paragraph" });
    });

    it("a collapsed range is still stored as a comment with an empty quote, from plain offsets as before and from an anchor alike", async () => {
      actor = carol;
      const text = await serverText();
      const at = text.indexOf("paragraph");
      const plain = (await (await post(docId, { action: "add", from: at, to: at, body: "At a point, by offsets" })).json()) as { id: string };
      const copy = browserCopy();
      const point = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(copy.getText(TEXT_KEY), at, 0));
      copy.destroy();
      const anchored = (await (await post(docId, { action: "add", from: at, to: at, anchor: { start: point, end: point }, body: "At a point, by anchor" })).json()) as { id: string };
      const all = await threads();
      expect(all.find((thread) => thread.id === plain.id)).toMatchObject({ quote: "", currentText: "" });
      expect(all.find((thread) => thread.id === anchored.id)).toMatchObject({ quote: "", currentText: "" });
    });

    it("refuses a body over the size limit before reading an anchor out of it", async () => {
      actor = carol;
      const before = (await threads()).length;
      const huge = { start: { tname: "content" }, end: { tname: "content" }, padding: "x".repeat(2_000_000) };
      const res = await post(docId, { action: "add", from: 0, to: 5, anchor: huge, body: "Must not land" });
      expect([400, 413]).toContain(res.status);
      expect((await threads()).length).toBe(before);
    });
    it("permissions are unchanged: a viewer and an anonymous caller cannot comment with an anchor either", async () => {
      const copy = browserCopy();
      const selected = anchorOn(copy, "paragraph");
      copy.destroy();
      actor = victor;
      expect((await post(docId, { action: "add", ...selected, body: "Nope" })).status).toBe(403);
      actor = null;
      expect((await post(docId, { action: "add", ...selected, body: "Nope" })).status).toBe(401);
    });
  });

  it("toggles reactions, persists them to the live document and never notifies", async () => {
    actor = alice;
    const { id } = (await (await post(docId, { action: "add", from: 0, to: 12, body: "React to me" })).json()) as { id: string };
    const { id: replyId } = (await (await post(docId, { action: "reply", threadId: id, body: "and to me" })).json()) as { id: string };

    actor = carol;
    let res = await post(docId, { action: "react", threadId: id, emoji: "👍" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reacted: true });
    actor = alice;
    expect(await (await post(docId, { action: "react", threadId: id, emoji: "👍" })).json()).toEqual({ ok: true, reacted: true });
    expect(await (await post(docId, { action: "react", threadId: id, replyId, emoji: "🎉" })).json()).toEqual({ ok: true, reacted: true });

    type ReactedThread = ThreadJson & { reactions: Record<string, string[]>; editedAt: string | null; replies: { id: string; reactions: Record<string, string[]> }[] };
    let { comments } = (await (await get(docId)).json()) as { comments: ReactedThread[] };
    let thread = comments.find((c) => c.id === id)!;
    expect(thread.reactions).toEqual({ "👍": expect.arrayContaining([carol.id, alice.id]) });
    expect(thread.reactions["👍"]).toHaveLength(2);
    expect(thread.replies[0].reactions).toEqual({ "🎉": [alice.id] });
    expect(thread.editedAt).toBeNull();

    // Alice's browser sees it live.
    await waitFor(() => {
      const model = new CommentsModel(aliceDoc, aliceDoc.getText(TEXT_KEY));
      try {
        return (model.get(id)?.reactions["👍"]?.length ?? 0) === 2;
      } finally {
        model.destroy();
      }
    });

    // Toggling again removes only the caller's reaction.
    actor = carol;
    res = await post(docId, { action: "react", threadId: id, emoji: "👍" });
    expect(await res.json()).toEqual({ ok: true, reacted: false });
    ({ comments } = (await (await get(docId)).json()) as { comments: ReactedThread[] });
    thread = comments.find((c) => c.id === id)!;
    expect(thread.reactions).toEqual({ "👍": [alice.id] });

    expect((await post(docId, { action: "react", threadId: "missing", emoji: "👍" })).status).toBe(404);
    expect((await post(docId, { action: "react", threadId: id, emoji: "" })).status).toBe(400);

    // Editing marks the body; reactions do not ring anyone's bell.
    actor = alice;
    expect((await post(docId, { action: "edit", threadId: id, body: "React to me, please" })).status).toBe(200);
    ({ comments } = (await (await get(docId)).json()) as { comments: ReactedThread[] });
    expect(comments.find((c) => c.id === id)!.editedAt).toBeTruthy();
    const db = await getDb();
    const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.refId, id));
    expect(rows).toHaveLength(0);

    actor = victor;
    expect((await post(docId, { action: "react", threadId: id, emoji: "👍" })).status).toBe(403);
    actor = null;
    expect((await post(docId, { action: "react", threadId: id, emoji: "👍" })).status).toBe(401);
  });

  /**
   * `docs/agents.md` promises that a non-2xx status means nothing changed, and a 2xx must not hide a gap: the
   * comment is broadcast to every editor the moment it is written, so the request is checked before that and
   * whatever fails after it (mention, activity row, request link) is reported as `warnings` on the 200.
   */
  describe("the non-2xx promise for request-linked comments", () => {
    // Its own document: the tests above rewrite the shared one's text.
    let reqDocId: string;
    const commentAdds = async (threadId: string) => (await listActivity(reqDocId, { limit: 100 })).items.filter((a) => a.action === "comment.add" && (a.detail as { threadId?: string }).threadId === threadId);
    /** Runs `fn` with console.error silenced; returns its result and the `[comments]`-prefixed lines it logged. */
    const quietly = async <T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await fn();
        return { result, logged: errors.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith("[comments]")) };
      } finally {
        errors.mockRestore();
      }
    };

    beforeAll(async () => {
      const doc = await createDocument({ ownerId: alice.id, content: "# Linked doc\n\nFirst paragraph.\n" });
      reqDocId = doc.id;
      await upsertCollaborator(reqDocId, carol.login, "commenter", alice.id);
    });
    afterEach(() => {
      // A failure armed with `...Once` and never consumed must not leak into the next test.
      vi.mocked(recordActivity).mockReset();
      vi.mocked(attachWork).mockReset();
    });

    it("refuses a done request before writing: 409 with no comment, no activity row and no mention notification", async () => {
      // Carol asks and works it herself: an unaddressed request is only for the requester's own agents (#1296).
      actor = carol;
      const request = await createRequest(reqDocId, carol, "commenter", { instruction: "Comment on the first paragraph", mode: "comment" });
      await completeRequest(reqDocId, request.id, carol, { summary: "Done elsewhere." });
      const { comments: before } = (await (await get(reqDocId)).json()) as { comments: ThreadJson[] };
      const activityBefore = (await listActivity(reqDocId, { limit: 100 })).items;
      const mentionsBefore = (await listNotifications("alice", { kind: "mention" })).items;

      actor = carol;
      const res = await post(reqDocId, { action: "add", quote: "First paragraph", body: "Late answer, @alice.", requestId: request.id });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "Request is done", status: "done" });

      const { comments: after } = (await (await get(reqDocId)).json()) as { comments: ThreadJson[] };
      expect(after).toEqual(before);
      const activity = (await listActivity(reqDocId, { limit: 100 })).items;
      expect(activity.filter((a) => a.action === "comment.add" && (a.detail as { requestId?: string }).requestId === request.id)).toEqual([]);
      expect(activity).toHaveLength(activityBefore.length);
      expect((await listNotifications("alice", { kind: "mention" })).items).toHaveLength(mentionsBefore.length);
      expect((await listRequests(reqDocId)).find((r) => r.id === request.id)).toMatchObject({ status: "done" });
    });

    it("keeps the comment and answers 200 with warnings when the activity row fails after the write", async () => {
      actor = carol;
      const request = await createRequest(reqDocId, carol, "commenter", { instruction: "Comment on the first paragraph", mode: "comment" });
      const { comments: before } = (await (await get(reqDocId)).json()) as { comments: ThreadJson[] };

      actor = carol;
      vi.mocked(recordActivity).mockRejectedValueOnce(new Error('Failed query: insert into "activity" ("id", "document_id") values ($1, $2) params: abc,secret-owner-uuid'));
      const { result: res, logged } = await quietly(() => post(reqDocId, { action: "add", quote: "First paragraph", body: "Recorded late, @alice.", requestId: request.id }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; warnings?: string[] };
      expect(body).toEqual({ id: expect.any(String), warnings: ["activity-not-recorded"] });
      // The driver's message (statement + parameters) stays in the log, logged once under the route's code.
      expect(JSON.stringify(body)).not.toContain("Failed query");
      expect(logged).toEqual([["[comments] activity-not-recorded", expect.any(Error)]]);

      // The comment is in the shared document.
      const { comments: after } = (await (await get(reqDocId)).json()) as { comments: ThreadJson[] };
      expect(after).toHaveLength(before.length + 1);
      expect(after.find((c) => c.id === body.id)).toMatchObject({ author: "Carol", mentions: ["alice"], currentText: "First paragraph" });
      // Everything that did not fail happened: the mention, and the request link (which now runs before the row).
      expect((await listNotifications("alice", { kind: "mention" })).items.find((n) => n.refId === body.id)).toBeTruthy();
      expect((await listRequests(reqDocId)).find((r) => r.id === request.id)).toMatchObject({ status: "claimed", result: { comments: 1, commentIds: [body.id] } });
      // And the one thing the warning names is really missing.
      expect(await commentAdds(body.id)).toEqual([]);
    });

    it("a request closed between the pre-check and the write: 200 with request-not-attached, the comment stays, its activity row carries no requestId", async () => {
      actor = carol;
      const request = await createRequest(reqDocId, carol, "commenter", { instruction: "Comment on the first paragraph", mode: "comment" });
      // The residual race: the request is completed after `requireAttachableRequest` passed and the comment is written.
      vi.mocked(attachWork).mockImplementationOnce(async (...args) => {
        await completeRequest(reqDocId, request.id, carol, { summary: "Closed meanwhile." });
        const actual = (await vi.importActual<typeof import("@/server/agent-requests")>("@/server/agent-requests")).attachWork;
        return actual(...args);
      });
      actor = carol;
      const { result: res, logged } = await quietly(() => post(reqDocId, { action: "add", quote: "First paragraph", body: "Just in time?", requestId: request.id }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; warnings?: string[] };
      expect(body).toEqual({ id: expect.any(String), warnings: ["request-not-attached"] });
      expect(logged).toEqual([["[comments] request-not-attached", expect.any(Error)]]);

      const { comments } = (await (await get(reqDocId)).json()) as { comments: ThreadJson[] };
      expect(comments.find((c) => c.id === body.id)).toMatchObject({ body: "Just in time?" });
      // The request refused the work, so nothing claims it: not the request's result, not the activity row.
      const row = (await listRequests(reqDocId)).find((r) => r.id === request.id);
      expect(row).toMatchObject({ status: "done" });
      expect((row?.result as { commentIds?: string[] } | null)?.commentIds ?? []).not.toContain(body.id);
      const adds = await commentAdds(body.id);
      expect(adds).toHaveLength(1);
      expect(adds[0].detail).not.toHaveProperty("requestId");
    });

    it("a successful add, reply or resolve carries no warnings", async () => {
      actor = alice;
      const added = await post(reqDocId, { action: "add", quote: "First paragraph", body: "Plain add." });
      expect(added.status).toBe(200);
      const { id, ...rest } = (await added.json()) as { id: string };
      expect(id).toEqual(expect.any(String));
      expect(rest).toEqual({});
      const replied = await post(reqDocId, { action: "reply", threadId: id, body: "Plain reply." });
      expect(replied.status).toBe(200);
      expect(await replied.json()).toEqual({ id: expect.any(String) });
      expect(await (await post(reqDocId, { action: "resolve", threadId: id, resolved: true })).json()).toEqual({ ok: true });
    });
  });
});

describe("POST /api/documents/:id/comments without a collaboration server", () => {
  let alice: TestActor;
  let carol: TestActor;
  let docId: string;

  beforeAll(async () => {
    const g = globalThis as typeof globalThis & { __markdocCollab?: unknown };
    delete g.__markdocCollab;
    alice = await createUser("alice-2", "Alice");
    carol = await createUser("carol-2", "Carol");
    const doc = await createDocument({ ownerId: alice.id, content: "# Solo doc\n\nSome text.\n" });
    docId = doc.id;
    await upsertCollaborator(docId, carol.login, "commenter", alice.id);
  });

  it("stores the comment and its mention directly in the database", async () => {
    actor = carol;
    const res = await post(docId, { action: "add", quote: "Some text", body: "Look here @alice-2" });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const db = await getDb();
    const [row] = await db.select({ ystate: schema.documents.ystate }).from(schema.documents).where(eq(schema.documents.id, docId));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row.ystate!);
    expect(doc.getMap("comments").has(id)).toBe(true);
    doc.destroy();

    const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.refId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].userLogin).toBe("alice-2");
  });
});
