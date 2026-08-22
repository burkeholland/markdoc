import { describe, expect, it, beforeAll } from "vitest";
import * as Y from "yjs";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("./db");
const { recordMentions, listUnreadMentions, markMentionRead, watchDocumentMentions } = await import("./mentions");
const { CommentsModel } = await import("@/editor/collab/comments");
const { makeCollabUser } = await import("@/editor/collab/shared");

async function seedDocument(id: string, title: string) {
  const db = await getDb();
  const [user] = await db.insert(schema.users).values({ name: "Owner " + id, login: "owner-" + id, email: `${id}@example.com` }).returning();
  await db.insert(schema.documents).values({ id, title, ownerId: user.id, content: "# " + title });
}

const until = async (check: () => Promise<boolean>, ms = 5000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};

describe("mentions", () => {
  beforeAll(async () => {
    await seedDocument("m-doc1", "Launch plan");
    await seedDocument("m-doc2", "Release notes");
  });

  it("records mentions idempotently per comment and mentioned login", async () => {
    expect(await recordMentions("m-doc1", "c1", "alice", "hi @Bob and @carol, see a@b.com")).toBe(2);
    expect(await recordMentions("m-doc1", "c1", "alice", "hi @bob and @carol (edited)")).toBe(0);
    expect(await recordMentions("m-doc1", "c1", "alice", "hi @bob, @carol and now @dave")).toBe(1);
    // Mentioning yourself and plain text are ignored.
    expect(await recordMentions("m-doc1", "c2", "alice", "note to self @alice")).toBe(0);
    expect(await recordMentions("m-doc1", "c3", "alice", "no mentions here")).toBe(0);
  });

  it("lists unread mentions per user with the document title", async () => {
    await recordMentions("m-doc2", "c9", "erin", "@bob please review");
    const bob = await listUnreadMentions("Bob");
    expect(bob.map((m) => m.documentTitle).sort()).toEqual(["Launch plan", "Release notes"]);
    const fromErin = bob.find((m) => m.documentId === "m-doc2")!;
    expect(fromErin).toMatchObject({ commentId: "c9", byLogin: "erin", snippet: "@bob please review" });
    expect(await listUnreadMentions("carol")).toHaveLength(1);
    expect(await listUnreadMentions("alice")).toHaveLength(0);
    expect(await listUnreadMentions("nobody")).toHaveLength(0);
  });

  it("marks a mention read only for the mentioned user", async () => {
    const [m] = await listUnreadMentions("carol");
    expect(await markMentionRead(m.id, "bob")).toBe(false);
    expect(await listUnreadMentions("carol")).toHaveLength(1);
    expect(await markMentionRead(m.id, "carol")).toBe(true);
    expect(await listUnreadMentions("carol")).toHaveLength(0);
    expect(await markMentionRead(m.id, "carol")).toBe(false);
  });

  it("truncates long bodies into a snippet", async () => {
    await recordMentions("m-doc1", "c-long", "alice", "@frank " + "x".repeat(500));
    const [m] = await listUnreadMentions("frank");
    expect(m.snippet.length).toBeLessThanOrEqual(200);
    expect(m.snippet.endsWith("…")).toBe(true);
  });

  it("watches a live document and records mentions from new threads, replies and edits", async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "Some text to comment on");
    const stop = watchDocumentMentions(doc, "m-doc2");
    const model = new CommentsModel(doc, ytext);
    const alice = makeCollabUser("u-alice", "Alice", null, "alice");
    const threadId = model.add({ from: 0, to: 4, body: "@gina what do you think?", author: alice });
    const replyId = model.reply(threadId, "also @hank", alice)!;
    model.editBody(threadId, "@gina and @ivy what do you think?");
    await until(async () => (await listUnreadMentions("ivy")).length === 1);
    expect((await listUnreadMentions("gina")).map((m) => m.commentId)).toEqual([threadId]);
    expect((await listUnreadMentions("hank")).map((m) => m.commentId)).toEqual([replyId]);
    expect((await listUnreadMentions("ivy")).map((m) => m.commentId)).toEqual([threadId]);
    stop();
    model.add({ from: 0, to: 4, body: "@jon unwatched", author: alice });
    await new Promise((r) => setTimeout(r, 100));
    expect(await listUnreadMentions("jon")).toHaveLength(0);
    model.destroy();
  });
});
