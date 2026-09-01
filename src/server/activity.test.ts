import { describe, expect, it, beforeAll } from "vitest";
import * as Y from "yjs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.ACTIVITY_EDIT_FLUSH_MS = "30";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("./db");
const { createDocument } = await import("./documents");
const { wakeSeq } = await import("./agent-events");
const { recordActivity, recordEdit, listActivity, countActivity, activityActor, activityActorFromCollab, clip, watchDocumentActivity, EDIT_COALESCE_WINDOW_MS } =
  await import("./activity");
const { TEXT_KEY, META_KEY, hydrateDoc, createCollabServer, shutdownCollab } = await import("./collab/hocuspocus");
const { attachCollab } = await import("./collab/ws");
const { signCollabToken } = await import("./collab/token");
const { CommentsModel } = await import("@/editor/collab/comments");
const { makeCollabUser } = await import("@/editor/collab/shared");

const alice = { id: "", name: "Alice", kind: "user" as const };
const bob = { id: "", name: "Bob", kind: "user" as const };

async function newDoc(ownerId: string) {
  const doc = await createDocument({ ownerId, title: "Feed", content: "# Feed\n\nHello.\n" });
  return doc.id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("activity feed", () => {
  let ownerId: string;

  beforeAll(async () => {
    const db = await getDb();
    const [a] = await db.insert(schema.users).values({ name: "Alice", login: "alice", email: "alice@example.com" }).returning();
    const [b] = await db.insert(schema.users).values({ name: "Bob", login: "bob", email: "bob@example.com" }).returning();
    alice.id = a.id;
    bob.id = b.id;
    ownerId = a.id;
  });

  it("records rows and lists them newest first with pagination", async () => {
    const docId = await newDoc(ownerId);
    const base = Date.parse("2026-01-01T10:00:00Z");
    for (let i = 0; i < 7; i++) {
      await recordActivity(docId, alice, "comment.add", { quote: `c${i}` }, { now: new Date(base + i * 60_000) });
    }
    const first = await listActivity(docId, { limit: 3 });
    expect(first.items.map((i) => i.detail.quote)).toEqual(["c6", "c5", "c4"]);
    expect(first.nextBefore).toBe(first.items[2].createdAt);

    const second = await listActivity(docId, { before: new Date(first.nextBefore!), limit: 3 });
    expect(second.items.map((i) => i.detail.quote)).toEqual(["c3", "c2", "c1"]);
    expect(second.nextBefore).not.toBeNull();

    const third = await listActivity(docId, { before: new Date(second.nextBefore!), limit: 3 });
    expect(third.items.map((i) => i.detail.quote)).toEqual(["c0"]);
    expect(third.nextBefore).toBeNull();
    expect(await countActivity(docId)).toBe(7);
  });

  it("coalesces a user's edits within the window and splits by user and by time", async () => {
    const docId = await newDoc(ownerId);
    const t0 = new Date("2026-02-01T09:00:00Z");
    const t1 = new Date(t0.getTime() + 2 * 60_000);
    const t2 = new Date(t0.getTime() + 3 * 60_000);
    const t3 = new Date(t1.getTime() + EDIT_COALESCE_WINDOW_MS + 1000);

    const a1 = await recordEdit(docId, alice, 100, t0);
    const a2 = await recordEdit(docId, alice, 140, t1);
    expect(a2.id).toBe(a1.id);
    expect(a2.detail.chars).toBe(240);
    expect(a2.createdAt).toBe(t1.toISOString());
    expect(await countActivity(docId)).toBe(1);

    const b1 = await recordEdit(docId, bob, 5, t2);
    expect(b1.id).not.toBe(a1.id);
    expect(await countActivity(docId)).toBe(2);

    const a3 = await recordEdit(docId, alice, 7, t3);
    expect(a3.id).not.toBe(a1.id);
    expect(a3.detail.chars).toBe(7);
    expect(await countActivity(docId)).toBe(3);

    const { items } = await listActivity(docId);
    expect(items.map((i) => [i.actorName, i.detail.chars])).toEqual([
      ["Alice", 7],
      ["Bob", 5],
      ["Alice", 240],
    ]);
  });

  it("closes the edit window when another kind of row lands, so the feed stays in order", async () => {
    const docId = await newDoc(ownerId);
    const t = (s: number) => new Date(Date.parse("2026-03-01T12:00:00Z") + s * 1000);

    // Alice types, comments, then keeps typing: the later keystrokes must not drag the
    // first edit row above the comment.
    const e1 = await recordEdit(docId, alice, 20, t(0));
    await recordActivity(docId, alice, "comment.add", { quote: "Shorter?" }, { now: t(5) });
    const e2 = await recordEdit(docId, alice, 13, t(6));
    expect(e2.id).not.toBe(e1.id);
    expect(e2.detail.chars).toBe(13);

    // Once open, the new window coalesces as usual; Bob's edit in between does not close it.
    const e3 = await recordEdit(docId, alice, 7, t(30));
    expect(e3.id).toBe(e2.id);
    expect(e3.detail.chars).toBe(20);
    await recordEdit(docId, bob, 3, t(40));
    const e4 = await recordEdit(docId, alice, 1, t(50));
    expect(e4.id).toBe(e2.id);
    expect(e4.detail.chars).toBe(21);

    // A row by someone else (an agent's version through the API) closes it too.
    const agent = activityActor({ id: bob.id, login: "bob", name: "Bob", image: null, agent: "Review Bot" });
    await recordActivity(docId, agent, "version.save", { number: 2, title: "Draft" }, { now: t(60) });
    const e5 = await recordEdit(docId, alice, 2, t(61));
    expect(e5.id).not.toBe(e2.id);

    const { items } = await listActivity(docId);
    expect(items.map((i) => [i.action, i.actorName, i.detail.chars ?? null])).toEqual([
      ["edit", "Alice", 2],
      ["version.save", "Review Bot", null],
      ["edit", "Alice", 21],
      ["edit", "Bob", 3],
      ["comment.add", "Alice", null],
      ["edit", "Alice", 20],
    ]);
    expect(await countActivity(docId)).toBe(6);
  });

  it("attributes API calls through a token to the agent", async () => {
    const docId = await newDoc(ownerId);
    const agent = activityActor({ id: alice.id, login: "alice", name: "Alice", image: null, agent: "Copilot CLI" });
    expect(agent).toEqual({ id: `agent:${alice.id}:Copilot CLI`, name: "Copilot CLI", kind: "agent" });
    const human = activityActor({ id: alice.id, login: "alice", name: "Alice", image: null });
    expect(human).toEqual({ id: alice.id, name: "Alice", kind: "user" });
    expect(activityActorFromCollab("agent:x:Bot", "Bot").kind).toBe("agent");
    expect(activityActorFromCollab(alice.id, "Alice").kind).toBe("user");

    // Explicit timestamps: ids are random, so three rows in the same millisecond would come back in random order.
    const t = (s: number) => new Date(Date.parse("2026-03-01T12:00:00Z") + s * 1000);
    await recordActivity(docId, agent, "suggestion.add", { count: 3 }, { now: t(0) });
    await recordActivity(docId, human, "suggestion.accept", { count: 3 }, { now: t(1) });
    await recordActivity(docId, human, "version.restore", { number: 4, title: "Before review" }, { now: t(2) });
    const { items } = await listActivity(docId);
    expect(items.map((i) => [i.action, i.actorKind, i.actorName])).toEqual([
      ["version.restore", "user", "Alice"],
      ["suggestion.accept", "user", "Alice"],
      ["suggestion.add", "agent", "Copilot CLI"],
    ]);
    expect(items[2].detail).toEqual({ count: 3 });
    expect(items[0].detail).toEqual({ number: 4, title: "Before review" });
  });

  it("joins the caller's transaction with `opts.tx`: the row rolls back with it, commits with it, and the document is woken by the caller, not here", async () => {
    const docId = await newDoc(ownerId);
    const db = await getDb();
    const before = await countActivity(docId);

    // Rolled back: the caller's own write fails after the activity row was inserted → no row.
    const seqBeforeRollback = wakeSeq(docId);
    await expect(
      db.transaction(async (tx) => {
        await recordActivity(docId, alice, "agent.request", { requestId: "r1" }, { tx });
        throw new Error("caller's write failed");
      }),
    ).rejects.toThrow("caller's write failed");
    expect(await countActivity(docId)).toBe(before);
    expect(wakeSeq(docId)).toBe(seqBeforeRollback);

    // Committed: exactly one row, the item is the row as inserted, and nothing woke the document from inside.
    const item = await db.transaction((tx) => recordActivity(docId, alice, "agent.request.done", { requestId: "r1" }, { tx, now: new Date("2026-04-01T00:00:00Z") }));
    expect(await countActivity(docId)).toBe(before + 1);
    expect(item).toMatchObject({ action: "agent.request.done", actorName: "Alice", detail: { requestId: "r1" }, createdAt: "2026-04-01T00:00:00.000Z" });
    expect(wakeSeq(docId)).toBe(seqBeforeRollback);
    const { items } = await listActivity(docId);
    expect(items.map((i) => i.id)).toEqual([item.id]);

    // Without `tx` the plain path still wakes the document itself.
    await recordActivity(docId, alice, "comment.add", { quote: "plain" });
    expect(wakeSeq(docId)).toBeGreaterThan(seqBeforeRollback);
  });

  it("clips quotes so detail never carries document text", () => {
    expect(clip("a  b\n\nc")).toBe("a b c");
    const long = "x".repeat(500);
    expect(clip(long)).toHaveLength(120);
    expect(clip(long).endsWith("…")).toBe(true);
  });

  it("watches a live document: typing is coalesced per user, comments and title changes are recorded", async () => {
    const docId = await newDoc(ownerId);
    const doc = new Y.Doc();
    hydrateDoc(doc, null, "Hello.", "Feed");
    const stop = watchDocumentActivity(doc, docId);
    const origin = (userId: string, name: string) => ({ source: "connection", connection: { context: { userId, docId, role: "editor", name, login: name.toLowerCase(), avatar: null } } });
    const ytext = doc.getText(TEXT_KEY);

    doc.transact(() => ytext.insert(ytext.length, " Alice typed"), origin(alice.id, "Alice"));
    doc.transact(() => ytext.insert(ytext.length, " more"), origin(alice.id, "Alice"));
    doc.transact(() => ytext.delete(0, 2), origin(bob.id, "Bob"));
    // Server-side mutations (REST routes) are recorded by the routes themselves, not the watcher.
    doc.transact(() => ytext.insert(ytext.length, " via API"), { source: "local", context: {} });
    doc.transact(() => doc.getMap(META_KEY).set("title", "Renamed feed"), origin(bob.id, "Bob"));

    const comments = doc.getMap<Y.Map<unknown>>("comments");
    doc.transact(() => {
      const thread = new Y.Map<unknown>();
      thread.set("id", "t1");
      thread.set("body", "Looks good to me, " + "y".repeat(200));
      thread.set("authorId", `agent:${alice.id}:Reviewer Bot`);
      thread.set("authorName", "Reviewer Bot");
      thread.set("resolved", false);
      comments.set("t1", thread);
    }, origin(alice.id, "Alice"));
    doc.transact(() => comments.get("t1")!.set("resolved", true), origin(bob.id, "Bob"));

    await sleep(150);
    await stop();

    const { items } = await listActivity(docId);
    const edits = items.filter((i) => i.action === "edit");
    expect(edits).toHaveLength(2);
    expect(edits.find((e) => e.actorName === "Alice")?.detail.chars).toBe(" Alice typed more".length);
    expect(edits.find((e) => e.actorName === "Bob")?.detail.chars).toBe(2);

    const title = items.find((i) => i.action === "title.change");
    expect(title?.actorName).toBe("Bob");
    expect(title?.detail.title).toBe("Renamed feed");

    const comment = items.find((i) => i.action === "comment.add");
    expect(comment?.actorKind).toBe("agent");
    expect(comment?.actorName).toBe("Reviewer Bot");
    expect(String(comment?.detail.quote)).toHaveLength(120);
    expect(comment?.detail.threadId).toBe("t1");

    const resolve = items.find((i) => i.action === "comment.resolve");
    expect(resolve?.actorName).toBe("Bob");
    doc.destroy();
  });

  it("counts inserted and deleted characters gross, per actor, including edits merged from another client", async () => {
    const docId = await newDoc(ownerId);
    const doc = new Y.Doc();
    hydrateDoc(doc, null, "Hello brave new world.", "Feed");
    const stop = watchDocumentActivity(doc, docId);
    const origin = (userId: string, name: string) => ({ source: "connection", connection: { context: { userId, docId, role: "editor", name, login: name.toLowerCase(), avatar: null } } });
    const ytext = doc.getText(TEXT_KEY);

    // Delete 3 and insert 7 in one transaction: 10, not the net 4.
    doc.transact(() => {
      ytext.delete(0, 3);
      ytext.insert(0, "abcdefg");
    }, origin(alice.id, "Alice"));
    // Text inserted and deleted again inside one transaction never existed for the feed.
    doc.transact(() => {
      ytext.insert(ytext.length, "gone");
      ytext.delete(ytext.length - 4, 4);
    }, origin(alice.id, "Alice"));
    // Bob's editor holds its own Y.Doc; its update reaches the server as one transaction with Bob's connection as origin.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    other.getText(TEXT_KEY).insert(0, "twelve chars");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)), origin(bob.id, "Bob"));
    // Comment threads and the title share the document but are not typing.
    doc.transact(() => {
      doc.getMap(META_KEY).set("title", "Other");
      const thread = new Y.Map<unknown>();
      thread.set("id", "t9");
      thread.set("body", "not text");
      doc.getMap<Y.Map<unknown>>("comments").set("t9", thread);
    }, origin(bob.id, "Bob"));

    await sleep(150);
    await stop();

    const { items } = await listActivity(docId);
    const edits = items.filter((i) => i.action === "edit");
    expect(edits.find((e) => e.actorName === "Alice")?.detail.chars).toBe(10);
    expect(edits.find((e) => e.actorName === "Bob")?.detail.chars).toBe(12);
    expect(edits).toHaveLength(2);
    other.destroy();
    doc.destroy();
  });

  it("costs the same per keystroke whatever the document size (no O(document) walk per transaction)", async () => {
    const docId = await newDoc(ownerId);
    const doc = new Y.Doc();
    const ytext = doc.getText(TEXT_KEY);
    // 20 000 one-character items: inserting at the front keeps every character its own item.
    for (let i = 0; i < 20_000; i++) ytext.insert(0, "x");
    const stop = watchDocumentActivity(doc, docId);
    const origin = { source: "connection", connection: { context: { userId: alice.id, docId, role: "editor", name: "Alice", login: "alice", avatar: null } } };

    const t0 = performance.now();
    for (let i = 0; i < 2_000; i++) doc.transact(() => ytext.insert(0, "y"), origin);
    const elapsed = performance.now() - t0;
    // Reading `event.delta` here took seconds (each keystroke walked all 20 000+ items); the clock-based
    // count is a few milliseconds. The bound leaves a wide margin for a loaded CI machine.
    expect(elapsed).toBeLessThan(200);

    await sleep(150);
    await stop();
    const { items } = await listActivity(docId);
    expect(items.filter((i) => i.action === "edit").map((i) => i.detail.chars)).toEqual([2_000]);
    doc.destroy();
  });

  it("records a reply suggestion decision once with the exact reply target", async () => {
    const docId = await newDoc(ownerId);
    const doc = new Y.Doc();
    hydrateDoc(doc, null, "Hello brave world.", "Feed");
    const stop = watchDocumentActivity(doc, docId);
    const model = new CommentsModel(doc, doc.getText(TEXT_KEY));
    const aliceUser = makeCollabUser(alice.id, "Alice", null, "alice");
    const bobUser = makeCollabUser(bob.id, "Bob", null, "bob");
    const threadId = model.add({ from: 6, to: 11, body: "Could this be clearer?", author: aliceUser });
    const replyId = model.reply(threadId, "Yes.\n\n```suggestion\nbold\n```", aliceUser)!;

    expect(model.acceptReplySuggestion(threadId, replyId, bobUser, { source: "connection", connection: { context: { userId: bob.id, docId, role: "editor", name: "Bob", login: "bob", avatar: null } } })).toBe(true);
    await sleep(150);
    await stop();

    const { items } = await listActivity(docId, { limit: 100 });
    const decisions = items.filter((item) => item.action === "comment.suggestion.accepted" && item.detail.replyId === replyId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ actorName: "Bob", detail: { threadId, replyId, author: "Alice", quote: "brave" } });
    expect(items.filter((item) => item.action === "comment.reply" && item.detail.replyId === replyId)).toHaveLength(0);

    model.destroy();
    doc.destroy();
  });

  it("records edits typed through a real collaboration connection", async () => {
    const docId = await newDoc(ownerId);
    const hocuspocus = createCollabServer();
    hocuspocus.configuration.debounce = 50;
    hocuspocus.configuration.maxDebounce = 100;
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    attachCollab(server, hocuspocus, { path: "/collab" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    const token = await signCollabToken({ userId: alice.id, docId, role: "owner", name: "Alice", login: "alice", avatar: null });
    const ydoc = new Y.Doc();
    const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collab`, WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket });
    const provider = new HocuspocusProvider({ websocketProvider: socket, name: docId, document: ydoc, token });
    provider.attach();
    try {
      const start = Date.now();
      while (!provider.isSynced && Date.now() - start < 5000) await sleep(20);
      expect(provider.isSynced).toBe(true);
      const text = ydoc.getText(TEXT_KEY);
      text.insert(text.length, " typed live");
      text.insert(text.length, "!");
      let items: Awaited<ReturnType<typeof listActivity>>["items"] = [];
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        items = (await listActivity(docId)).items;
        if (items.some((i) => i.action === "edit")) break;
        await sleep(50);
      }
      const edit = items.find((i) => i.action === "edit");
      expect(edit?.actorName).toBe("Alice");
      expect(edit?.actorId).toBe(alice.id);
      expect(edit?.detail.chars).toBe(" typed live!".length);
      expect(items.filter((i) => i.action === "edit")).toHaveLength(1);
    } finally {
      provider.destroy();
      socket.destroy();
      await shutdownCollab(hocuspocus);
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
