import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import * as Y from "yjs";
import { eq } from "drizzle-orm";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// The route resolves the caller through next-auth and `next/headers`, neither of which
// runs outside a Next request; `actor` is whoever the next request comes from.
type TestActor = { id: string; login: string; name: string; image: null };
let actor: TestActor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { createDocument, upsertCollaborator } = await import("@/server/documents");
const { createCollabServer, shutdownCollab, TEXT_KEY } = await import("@/server/collab/hocuspocus");
const { attachCollab } = await import("@/server/collab/ws");
const { signCollabToken } = await import("@/server/collab/token");
const { registerCollab } = await import("@/server/collab/registry");
const { listNotifications } = await import("@/server/notifications");
const { listActivity } = await import("@/server/activity");
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

type ThreadJson = { id: string; body: string; author: string; authorId: string; mentions: string[]; quote: string | null; currentText: string | null };

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
