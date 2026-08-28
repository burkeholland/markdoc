import { describe, expect, it, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as Y from "yjs";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

vi.mock("@/server/livedoc", () => ({ evictLiveDocument: vi.fn() }));

const { getDb, schema } = await import("./db");
const {
  recordMentions,
  listNotifications,
  unreadCount,
  markNotificationRead,
  notificationBelongsTo,
  markAllNotificationsRead,
  markRefsRead,
  notify,
  notifyShare,
  watchDocumentNotifications,
} = await import("./notifications");
const { deleteDocument, restoreDocument } = await import("./documents");
const { CommentsModel } = await import("@/editor/collab/comments");
const { SuggestionsModel } = await import("@/editor/collab/suggestions");
const { makeCollabUser } = await import("@/editor/collab/shared");

async function seedUser(login: string, name: string) {
  const db = await getDb();
  const [user] = await db.insert(schema.users).values({ name, login, email: `${login}@example.com` }).returning();
  return user;
}

async function seedDocument(id: string, title: string, ownerId: string, linkAccess: "private" | "comment" = "private") {
  const db = await getDb();
  await db.insert(schema.documents).values({ id, title, ownerId, content: "# " + title, linkAccess });
}

const until = async (check: () => Promise<boolean>, ms = 5000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};
const settle = () => new Promise((r) => setTimeout(r, 150));

const unread = async (login: string) => (await listNotifications(login, { unread: true })).items;
const origin = (userId: string, name: string) => ({ source: "connection", connection: { context: { userId, docId: "n-doc1", role: "editor", name, login: name.toLowerCase(), avatar: null } } });

describe("notifications", () => {
  let ownerId: string;
  let aliceId: string;
  let bobId: string;
  beforeAll(async () => {
    const owner = await seedUser("owner", "Owner");
    ownerId = owner.id;
    aliceId = (await seedUser("alice", "Alice")).id;
    bobId = (await seedUser("bob", "Bob")).id;
    const carol = await seedUser("carol", "Carol");
    const mallory = await seedUser("mallory", "Mallory");
    await seedDocument("n-doc1", "Launch plan", owner.id, "comment");
    await seedDocument("n-doc2", "Release notes", owner.id);
    await seedDocument("n-private", "Mallory private plan", mallory.id);
    await seedDocument("n-link", "Mallory linked plan", mallory.id, "comment");
    const db = await getDb();
    await db.insert(schema.collaborators).values({ documentId: "n-private", login: carol.login!, role: "commenter", addedBy: mallory.id });
  });

  it("records mentions idempotently per comment and mentioned login, never yourself", async () => {
    expect(await recordMentions("n-doc1", "c1", "alice", "hi @Bob and @carol, see a@b.com")).toBe(2);
    expect(await recordMentions("n-doc1", "c1", "alice", "hi @bob and @carol (edited)")).toBe(0);
    expect(await recordMentions("n-doc1", "c1", "alice", "hi @bob, @carol and now @dave")).toBe(1);
    expect(await recordMentions("n-doc1", "c2", "alice", "note to self @alice")).toBe(0);
    expect(await recordMentions("n-doc1", "c3", "alice", "no mentions here")).toBe(0);
    const bob = await unread("Bob");
    expect(bob).toHaveLength(1);
    expect(bob[0]).toMatchObject({ kind: "mention", refId: "c1", actorLogin: "alice", documentTitle: "Launch plan", snippet: "hi @Bob and @carol, see a@b.com" });
  });

  it("updates persisted agent targets when a comment mention is edited", async () => {
    expect(await recordMentions("n-doc1", "agent-edit", "alice", "@owner/Agent-A please check")).toBe(1);
    expect(await recordMentions("n-doc1", "agent-edit", "alice", "@owner/Agent-B please check")).toBe(1);
    const item = (await listNotifications("owner", { kind: "mention" })).items.find((notification) => notification.refId === "agent-edit");
    expect(item?.agentTargets).toEqual(["Agent-B"]);
  });

  it("retracts stale recipients when an edited comment replaces or removes mentions", async () => {
    await recordMentions("n-doc1", "agent-remove", "alice", "@owner/Agent-A and @bob please check");
    await recordMentions("n-doc1", "agent-remove", "alice", "@carol/Agent-B please check");
    expect((await listNotifications("owner", { kind: "mention" })).items.some((item) => item.refId === "agent-remove")).toBe(false);
    expect((await listNotifications("bob", { kind: "mention" })).items.some((item) => item.refId === "agent-remove")).toBe(false);
    expect((await listNotifications("carol", { kind: "mention" })).items.find((item) => item.refId === "agent-remove")?.agentTargets).toEqual(["Agent-B"]);
    await recordMentions("n-doc1", "agent-remove", "alice", "No one is mentioned now");
    expect((await listNotifications("carol", { kind: "mention" })).items.some((item) => item.refId === "agent-remove")).toBe(false);
  });

  it("is idempotent per (user, kind, ref) and ignores self-notifications", async () => {
    const input = { userLogin: "Carol", documentId: "n-doc2", kind: "share" as const, actorLogin: "owner", actorName: "Owner", refId: "n-doc2:carol", snippet: "editor" };
    expect(await notify(input)).toBe(true);
    expect(await notify(input)).toBe(false);
    expect(await notify({ ...input, userLogin: "owner" })).toBe(false);
    expect(await notify({ ...input, userLogin: "  " })).toBe(false);
    expect(await notifyShare("n-doc2", "dave", "viewer", { login: "owner", name: "Owner" })).toBe(true);
    expect(await notifyShare("n-doc2", "dave", "viewer", { login: "owner", name: "Owner" })).toBe(false);
    expect(await notifyShare("n-doc2", "owner", "viewer", { login: "owner", name: "Owner" })).toBe(false);
  });

  it("clips snippets to 120 characters", async () => {
    await recordMentions("n-doc1", "c-long", "alice", "@frank " + "x".repeat(500));
    const [n] = await unread("frank");
    expect(n.snippet.length).toBe(120);
    expect(n.snippet.endsWith("…")).toBe(true);
  });

  it("lists newest first with the unread count, and marks read only for the recipient", async () => {
    const page = await listNotifications("carol");
    expect(page.unreadCount).toBe(2);
    expect(page.items.map((n) => n.kind)).toEqual(["share", "mention"]);
    expect(page.items.map((n) => n.documentTitle)).toEqual(["Release notes", "Launch plan"]);
    expect((await listNotifications("carol", { kind: "mention" })).items).toHaveLength(1);
    expect((await listNotifications("carol", { limit: 1 })).items).toHaveLength(1);

    const [m] = await unread("carol");
    expect(await markNotificationRead(m.id, "bob")).toBe(false);
    expect(await unreadCount("carol")).toBe(2);
    expect(await markNotificationRead(m.id, "carol")).toBe(true);
    expect(await unreadCount("carol")).toBe(1);
    expect(await markNotificationRead(m.id, "carol")).toBe(false);
    // The owner check used by the read route: a read row is still theirs; other users and unknown ids are not.
    expect(await notificationBelongsTo(m.id, "carol")).toBe(true);
    expect(await notificationBelongsTo(m.id, "bob")).toBe(false);
    expect(await notificationBelongsTo("nope", "carol")).toBe(false);
    // Read items still list unless `unread` is requested.
    expect((await listNotifications("carol")).items).toHaveLength(2);
    expect(await unread("carol")).toHaveLength(1);
  });

  it("hides a trashed document's notifications without deleting them and restores their visibility", async () => {
    await seedDocument("n-trash", "Temporary plan", ownerId, "comment");
    await notify({ userLogin: "trash-reader", documentId: "n-trash", kind: "share", actorLogin: "owner", refId: "n-trash:trash-reader" });
    await notify({ userLogin: "trash-reader", documentId: "n-trash", kind: "mention", actorLogin: "owner", refId: "trash-comment" });

    expect((await listNotifications("trash-reader")).items.map((item) => item.documentId)).toEqual(["n-trash", "n-trash"]);
    expect((await listNotifications("trash-reader", { unread: true })).items).toHaveLength(2);
    expect(await unreadCount("trash-reader")).toBe(2);

    await deleteDocument("n-trash");
    expect((await listNotifications("trash-reader")).items).toEqual([]);
    expect((await listNotifications("trash-reader", { unread: true })).items).toEqual([]);
    expect(await unreadCount("trash-reader")).toBe(0);
    const db = await getDb();
    expect(await db.select().from(schema.notifications).where(eq(schema.notifications.documentId, "n-trash"))).toHaveLength(2);

    await restoreDocument("n-trash");
    expect((await listNotifications("trash-reader")).items).toHaveLength(2);
    expect((await listNotifications("trash-reader", { unread: true })).items).toHaveLength(2);
    expect(await unreadCount("trash-reader")).toBe(2);
  });

  it("read-all only touches the caller's rows", async () => {
    expect(await unreadCount("bob")).toBe(1);
    expect(await unreadCount("dave")).toBe(2);
    expect(await markAllNotificationsRead("dave")).toBe(2);
    expect(await unreadCount("dave")).toBe(0);
    expect(await unreadCount("bob")).toBe(1);
    expect(await markAllNotificationsRead("dave")).toBe(0);
  });

  it("scopes read-all to the documents bound to a token", async () => {
    await notify({ userLogin: "scoped-reader", documentId: "n-doc1", kind: "reply", actorLogin: "bob", refId: "scoped-r1" });
    await notify({ userLogin: "scoped-reader", documentId: "n-doc2", kind: "reply", actorLogin: "bob", refId: "scoped-r2" });
    expect(await markAllNotificationsRead("scoped-reader", ["n-doc1"])).toBe(1);
    expect((await unread("scoped-reader")).map((item) => item.documentId)).toEqual(["n-doc2"]);
  });

  it("marks every notification about a set of refs read (opening a thread)", async () => {
    await notify({ userLogin: "erin", documentId: "n-doc1", kind: "reply", actorLogin: "bob", refId: "r1" });
    await notify({ userLogin: "erin", documentId: "n-doc1", kind: "resolve", actorLogin: "bob", refId: "t1" });
    await notify({ userLogin: "erin", documentId: "n-doc2", kind: "reply", actorLogin: "bob", refId: "r9" });
    expect(await markRefsRead("erin", "n-doc1", [])).toBe(0);
    expect(await markRefsRead("erin", "n-doc1", ["t1", "r1", "missing"])).toBe(2);
    expect((await unread("erin")).map((n) => n.refId)).toEqual(["r9"]);
  });

  it("watches a live document: mentions, replies and resolutions from comments", async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "Some text to comment on");
    const stop = watchDocumentNotifications(doc, "n-doc1");
    const model = new CommentsModel(doc, ytext);
    const alice = makeCollabUser(aliceId, "Alice", null, "alice");
    const bob = makeCollabUser(bobId, "Bob", null, "bob");
    const carol = makeCollabUser("u-carol", "Carol", null, "carol");
    const anon = makeCollabUser("u-anon", "Anonymous", null, null);

    const threadId = model.add({ from: 0, to: 4, body: "@gina what do you think?", author: alice });
    const ownReply = model.reply(threadId, "also @hank", alice)!;
    const bobReply = model.reply(threadId, "I think so", bob)!;
    const carolReply = model.reply(threadId, "Agreed", carol)!;
    model.editBody(threadId, "@gina and @ivy what do you think?");
    await until(async () => (await unread("ivy")).length === 1);
    await settle();

    expect((await unread("gina")).map((n) => [n.kind, n.refId])).toEqual([["mention", threadId]]);
    expect((await unread("hank")).map((n) => [n.kind, n.refId])).toEqual([["mention", ownReply]]);
    // Alice replying to her own thread notifies nobody; Bob's reply reaches Alice; Carol's reaches Alice and Bob.
    const aliceItems = await unread("alice");
    const byActor = (a: unknown[], b: unknown[]) => String(a[2]).localeCompare(String(b[2]));
    expect(aliceItems.map((n) => [n.kind, n.refId, n.actorLogin]).sort(byActor)).toEqual([
      ["reply", bobReply, "bob"],
      ["reply", carolReply, "carol"],
    ]);
    expect(aliceItems.find((n) => n.refId === bobReply)).toMatchObject({ actorName: "Bob", snippet: "I think so", documentTitle: "Launch plan" });
    expect((await unread("bob")).filter((n) => n.kind === "reply").map((n) => n.refId)).toEqual([carolReply]);
    expect((await unread("carol")).filter((n) => n.kind === "reply")).toHaveLength(0);

    // Editing a reply re-inserts it with the same id: no duplicate.
    model.editBody(threadId, "I think so!", bobReply);
    await settle();
    expect((await unread("alice")).filter((n) => n.refId === bobReply)).toHaveLength(1);

    // Anonymous replies (no login) never notify.
    model.reply(threadId, "drive-by", anon);
    await settle();
    expect((await unread("alice")).filter((n) => n.kind === "reply")).toHaveLength(2);

    // Resolving through a connection notifies every participant but the actor; server-side origins are left to the route.
    const map = model.ymap.get(threadId)!;
    doc.transact(() => map.set("resolved", true), origin(bobId, "Bob"));
    await settle();
    expect((await unread("alice")).filter((n) => n.kind === "resolve").map((n) => n.refId)).toEqual([threadId]);
    expect((await unread("carol")).filter((n) => n.kind === "resolve").map((n) => n.refId)).toEqual([threadId]);
    expect((await unread("bob")).filter((n) => n.kind === "resolve")).toHaveLength(0);
    doc.transact(() => map.set("resolved", false), origin(aliceId, "Alice"));
    await settle();
    expect((await unread("bob")).filter((n) => n.kind === "reopen").map((n) => n.refId)).toEqual([threadId]);
    expect((await unread("alice")).filter((n) => n.kind === "reopen")).toHaveLength(0);
    model.setResolved(threadId, true, bob); // local origin: ignored by the watcher
    await settle();
    expect((await unread("alice")).filter((n) => n.kind === "resolve")).toHaveLength(1);

    stop();
    model.add({ from: 0, to: 4, body: "@jon unwatched", author: alice });
    await settle();
    expect(await unread("jon")).toHaveLength(0);
    model.destroy();
  });

  it("notifies the exact reply author when their suggestion is accepted", async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "Some text to improve");
    const stop = watchDocumentNotifications(doc, "n-doc1");
    const model = new CommentsModel(doc, ytext);
    const alice = makeCollabUser(aliceId, "Alice", null, "alice");
    const bob = makeCollabUser(bobId, "Bob", null, "bob");
    const threadId = model.add({ from: 0, to: 4, body: "Could this be clearer?", author: alice });
    const acceptedId = model.reply(threadId, "```suggestion\nThat\n```", alice)!;
    const rejectedId = model.reply(threadId, "```suggestion\nThis\n```", alice)!;

    expect(model.acceptReplySuggestion(threadId, acceptedId, bob, origin(bobId, "Bob"))).toBe(true);
    expect(model.rejectReplySuggestion(threadId, rejectedId, bob, origin(bobId, "Bob"))).toBe(true);
    await until(async () => (await unread("alice")).some((item) => item.kind === "suggestion.accepted" && item.refId === acceptedId));
    await settle();

    const replyDecisions = (await unread("alice")).filter((item) => item.refId === acceptedId || item.refId === rejectedId);
    expect(replyDecisions.map((item) => [item.kind, item.refId, item.actorLogin])).toEqual([["suggestion.accepted", acceptedId, "bob"]]);

    stop();
    model.destroy();
    doc.destroy();
  });

  it("watches a live document: suggestions accepted or rejected notify their author", async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "Hello brave new world");
    const stop = watchDocumentNotifications(doc, "n-doc2");
    const model = new SuggestionsModel(doc, ytext);
    const alice = makeCollabUser(aliceId, "Alice", null, "alice");
    const agent = makeCollabUser("agent:x:Bot", "Bot", null, null);

    model.applyEdit({ from: 6, to: 6, insert: "very " }, alice); // insert "very "
    model.applyEdit({ from: 11, to: 16, insert: "" }, alice); // delete "brave"
    model.applyEdit({ from: ytext.length, to: ytext.length, insert: "!" }, alice); // insert "!"
    model.applyEdit({ from: 0, to: 5, insert: "" }, agent); // agent suggests deleting "Hello"
    const list = model.list();
    expect(list).toHaveLength(4);
    const ins = list.find((s) => s.type === "insert" && s.text === "very ")!;
    const del = list.find((s) => s.type === "delete" && s.text === "brave")!;
    const bang = list.find((s) => s.text === "!")!;
    const agentDel = list.find((s) => s.text === "Hello")!;

    model.accept(ins.id, origin(bobId, "Bob"));
    model.reject(del.id, origin(bobId, "Bob"));
    model.reject(bang.id, origin(bobId, "Bob"));
    model.accept(agentDel.id, origin(bobId, "Bob"));
    const isTrackedSuggestionDecision = (kind: string) => kind === "suggestion.accept" || kind === "suggestion.reject";
    await until(async () => (await unread("alice")).filter((n) => isTrackedSuggestionDecision(n.kind)).length === 3);
    const items = (await unread("alice")).filter((n) => isTrackedSuggestionDecision(n.kind));
    expect(items.map((n) => [n.kind, n.refId, n.actorLogin]).sort()).toEqual(
      [
        ["suggestion.accept", ins.id, "bob"],
        ["suggestion.reject", del.id, "bob"],
        ["suggestion.reject", bang.id, "bob"],
      ].sort(),
    );
    expect(items.find((n) => n.refId === del.id)?.snippet).toBe('Delete "brave"');
    expect(ytext.toString()).toBe(" very brave new world");

    // Deciding on your own suggestion, or a server-side decision, notifies nobody from the watcher.
    model.applyEdit({ from: 0, to: 0, insert: "Oh " }, alice);
    const own = model.list().find((s) => s.text === "Oh ")!;
    model.accept(own.id, origin(aliceId, "Alice"));
    model.applyEdit({ from: 0, to: 0, insert: "Ah " }, alice);
    const local = model.list().find((s) => s.text === "Ah ")!;
    model.accept(local.id);
    await settle();
    expect((await unread("alice")).filter((n) => isTrackedSuggestionDecision(n.kind))).toHaveLength(3);
    stop();
    model.destroy();
  });

  it("only delivers mentions to people who can open the document", async () => {
    const aliceBefore = await unreadCount("alice", "mention");

    expect(await recordMentions("n-private", "private-denied", "mallory", "@alice hi")).toBe(0);
    expect(await unreadCount("alice", "mention")).toBe(aliceBefore);
    expect((await listNotifications("alice", { kind: "mention" })).items.some((item) => item.refId === "private-denied")).toBe(false);

    // Read-time filtering also protects against inaccessible rows created before this check existed.
    expect(await notify({ userLogin: "alice", documentId: "n-private", kind: "mention", actorLogin: "mallory", refId: "legacy-private", snippet: "@alice old mention" })).toBe(true);
    const db = await getDb();
    expect(await db.select().from(schema.notifications).where(eq(schema.notifications.refId, "legacy-private"))).toHaveLength(1);
    expect(await unreadCount("alice", "mention")).toBe(aliceBefore);
    expect((await listNotifications("alice", { kind: "mention" })).items.some((item) => item.refId === "legacy-private")).toBe(false);

    expect(await recordMentions("n-link", "link-allowed", "mallory", "@alice hi")).toBe(1);
    expect(await unreadCount("alice", "mention")).toBe(aliceBefore + 1);
    expect((await listNotifications("alice", { kind: "mention" })).items.some((item) => item.refId === "link-allowed")).toBe(true);

    expect(await recordMentions("n-private", "collaborator-allowed", "mallory", "@carol hi")).toBe(1);
    expect((await listNotifications("carol", { kind: "mention" })).items.some((item) => item.refId === "collaborator-allowed")).toBe(true);

    expect(await recordMentions("n-private", "owner-allowed", "carol", "@mallory hi")).toBe(1);
    expect((await listNotifications("mallory", { kind: "mention" })).items.some((item) => item.refId === "owner-allowed")).toBe(true);
  });

  it("migration 0008 copies legacy mention rows and drops the old table", () => {
    const sql = readFileSync(join(process.cwd(), "drizzle", "0008_notifications.sql"), "utf8");
    expect(sql).toMatch(/CREATE TABLE "notification"/);
    expect(sql).toMatch(/INSERT INTO "notification"[\s\S]*SELECT[\s\S]*FROM "mention"/);
    expect(sql).toMatch(/DROP TABLE "mention"/);
    expect(sql.indexOf("INSERT INTO")).toBeLessThan(sql.indexOf("DROP TABLE"));
  });
});
