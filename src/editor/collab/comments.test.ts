import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CommentsModel } from "./comments";
import { createAnchor, makeCollabUser } from "./shared";

const alice = makeCollabUser("a", "Alice");
const bob = makeCollabUser("b", "Bob");

function setup() {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.insert(0, "Hello brave new world");
  const model = new CommentsModel(ydoc, ytext);
  const id = model.add({ from: 6, to: 11, body: "Too dramatic?", author: alice });
  return { ydoc, ytext, model, id };
}

describe("CommentsModel reactions", () => {
  it("toggles a reaction on and off for one user", () => {
    const { model, id } = setup();
    expect(model.get(id)?.reactions).toEqual({});
    expect(model.toggleReaction(id, null, "👍", alice)).toBe(true);
    expect(model.get(id)?.reactions).toEqual({ "👍": [alice.id] });
    expect(model.get(id)?.reactorNames).toEqual({ [alice.id]: "Alice" });
    expect(model.toggleReaction(id, null, "👍", alice)).toBe(false);
    expect(model.get(id)?.reactions).toEqual({});
  });

  it("counts two users on the same emoji and keeps the quick-picker order", () => {
    const { model, id } = setup();
    model.toggleReaction(id, null, "🚀", bob);
    model.toggleReaction(id, null, "👍", alice);
    model.toggleReaction(id, null, "👍", bob);
    expect(model.get(id)?.reactions).toEqual({ "👍": [alice.id, bob.id], "🚀": [bob.id] });
    expect(Object.keys(model.get(id)!.reactions)).toEqual(["👍", "🚀"]);
    model.toggleReaction(id, null, "👍", alice);
    expect(model.get(id)?.reactions).toEqual({ "👍": [bob.id], "🚀": [bob.id] });
  });

  it("reacts to a reply independently of the thread and drops them with the reply", () => {
    const { model, id } = setup();
    const replyId = model.reply(id, "I like it", bob)!;
    expect(model.toggleReaction(id, replyId, "❤️", alice)).toBe(true);
    expect(model.toggleReaction(id, "nope", "❤️", alice)).toBeNull();
    expect(model.toggleReaction("nope", null, "❤️", alice)).toBeNull();
    let thread = model.get(id)!;
    expect(thread.reactions).toEqual({});
    expect(thread.replies[0].reactions).toEqual({ "❤️": [alice.id] });
    expect(thread.reactorNames).toEqual({ [alice.id]: "Alice" });
    model.deleteReply(id, replyId);
    thread = model.get(id)!;
    expect(thread.replies).toEqual([]);
    expect(thread.reactorNames).toEqual({});
  });

  it("survives being applied to a second Y.Doc and merges concurrent reactions", () => {
    const { ydoc, model, id } = setup();
    const replyId = model.reply(id, "I like it", bob)!;
    model.toggleReaction(id, null, "👍", alice);
    model.toggleReaction(id, replyId, "🎉", alice);

    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
    const mirror = new CommentsModel(other, other.getText("content"));
    expect(mirror.get(id)?.reactions).toEqual({ "👍": [alice.id] });
    expect(mirror.get(id)?.replies[0].reactions).toEqual({ "🎉": [alice.id] });

    // Both sides react concurrently; after syncing, nothing is lost.
    mirror.toggleReaction(id, null, "👍", bob);
    model.toggleReaction(id, null, "👀", alice);
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(other));
    Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
    expect(model.get(id)?.reactions).toEqual({ "👍": [alice.id, bob.id], "👀": [alice.id] });
    expect(mirror.get(id)?.reactions).toEqual(model.get(id)?.reactions);
    expect(mirror.get(id)?.reactorNames).toEqual({ [alice.id]: "Alice", [bob.id]: "Bob" });
  });

  it("works on threads created before reactions existed", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "Hello");
    const legacy = new Y.Map<unknown>();
    legacy.set("id", "old");
    legacy.set("anchor", createAnchor(ytext, 0, 5));
    legacy.set("body", "old one");
    legacy.set("authorId", alice.id);
    legacy.set("authorName", alice.name);
    legacy.set("createdAt", 1);
    legacy.set("replies", new Y.Array());
    ydoc.getMap("comments").set("old", legacy);
    const model = new CommentsModel(ydoc, ytext);
    expect(model.get("old")?.reactions).toEqual({});
    expect(model.toggleReaction("old", null, "👍", bob)).toBe(true);
    expect(model.get("old")?.reactions).toEqual({ "👍": [bob.id] });
  });
});

describe("CommentsModel editedAt", () => {
  it("is unset until the body changes, on threads and replies", () => {
    const { model, id } = setup();
    const replyId = model.reply(id, "I like it", bob)!;
    let thread = model.get(id)!;
    expect(thread.editedAt).toBeNull();
    expect(thread.replies[0].editedAt).toBeNull();

    model.editBody(id, "Too dramatic?"); // same text: not an edit
    expect(model.get(id)?.editedAt).toBeNull();

    const before = Date.now();
    model.editBody(id, "Too dramatic? @bob");
    model.editBody(id, "I love it", replyId);
    thread = model.get(id)!;
    expect(thread.editedAt).toBeGreaterThanOrEqual(before);
    expect(thread.mentions).toEqual(["bob"]);
    expect(thread.replies[0].editedAt).toBeGreaterThanOrEqual(before);
    expect(thread.replies[0].body).toBe("I love it");
  });
});
