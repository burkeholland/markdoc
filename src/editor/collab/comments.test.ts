import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CommentsModel, isDocumentRange } from "./comments";
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

describe("CommentsModel snapshots", () => {
  it("decodes each thread once across repeated list/get and selection-only reads", () => {
    const { ydoc, model, id } = setup();
    const map = model.ymap.get(id)!;
    const get = vi.spyOn(map, "get");
    try {
      const initial = model.list();
      get.mockClear();
      for (let index = 0; index < 100; index++) {
        expect(model.list()).toBe(initial);
        expect(model.get(id)).toBe(initial[0]);
      }
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      model.destroy();
      ydoc.destroy();
    }
  });

  it("retains unchanged cards and metadata while insert/delete/undo move their ranges", () => {
    const { ydoc, ytext, model, id } = setup();
    const undo = new Y.UndoManager(ytext);
    const original = model.get(id)!;
    const get = vi.spyOn(model.ymap.get(id)!, "get");
    try {
      ytext.insert(ytext.length, "!");
      expect(model.get(id)).toBe(original);
      undo.stopCapturing();
      ytext.insert(0, "__");
      const moved = model.get(id)!;
      expect(moved.range).toEqual({ from: 8, to: 13 });
      expect(moved.replies).toBe(original.replies);
      expect(original.range).toEqual({ from: 6, to: 11 });
      expect(get).not.toHaveBeenCalled();
      undo.undo();
      expect(model.get(id)!.range).toEqual(original.range);
      ytext.delete(6, 5);
      expect(model.get(id)!.range).toEqual({ from: 6, to: 6 });
    } finally {
      get.mockRestore();
      undo.destroy();
      model.destroy();
      ydoc.destroy();
    }
  });

  it("invalidates remote text identities, reanchors, replies and resolution", () => {
    const { ydoc, ytext, model, id } = setup();
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    const other = new CommentsModel(remote, remote.getText("content"));
    try {
      const first = model.list();
      other.ytext.insert(0, "Remote ");
      other.reply(id, "A reply", bob);
      other.setResolved(id, true, bob);
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote));
      const thread = model.list()[0];
      expect(thread).not.toBe(first[0]);
      expect(thread.range).toEqual({ from: 13, to: 18 });
      expect(thread.replies[0].body).toBe("A reply");
      expect(thread.resolved).toBe(true);
      model.ymap.get(id)!.set("anchor", createAnchor(ytext, 0, 6));
      expect(model.get(id)!.range).toEqual({ from: 0, to: 6 });
      model.ymap.delete(id);
      expect(model.list()).toEqual([]);
      expect(model.get(id)).toBeNull();
    } finally {
      other.destroy();
      remote.destroy();
      model.destroy();
      ydoc.destroy();
    }
  });

  it("reads successive writes inside a transaction without caching unfinished state", () => {
    const { ydoc, ytext, model, id } = setup();
    try {
      const original = model.list();
      ydoc.transact(() => {
        ytext.insert(0, "_");
        expect(model.get(id)!.range).toEqual({ from: 7, to: 12 });
        model.ymap.get(id)!.set("body", "Changed");
        expect(model.list()[0].body).toBe("Changed");
        ytext.insert(0, "_");
        expect(model.get(id)!.range).toEqual({ from: 8, to: 13 });
      });
      expect(model.get(id)!.body).toBe("Changed");
      expect(model.get(id)!.range).toEqual({ from: 8, to: 13 });
      expect(original[0].body).toBe("Too dramatic?");
    } finally {
      model.destroy();
      ydoc.destroy();
    }
  });

  it("starts safely inside an existing transaction and releases its observers on destroy", () => {
    const { ydoc, ytext, model, id } = setup();
    try {
      ydoc.transact(() => {
        const inside = new CommentsModel(ydoc, ytext);
        try {
          expect(inside.get(id)!.range).toEqual({ from: 6, to: 11 });
          ytext.insert(0, "_");
          expect(inside.get(id)!.range).toEqual({ from: 7, to: 12 });
          ytext.insert(0, "_");
          expect(inside.list()[0].range).toEqual({ from: 8, to: 13 });
        } finally {
          inside.destroy();
        }
      });
      const initial = model.list();
      ydoc.transact(() => {});
      expect(model.list()).toBe(initial);
    } finally {
      model.destroy();
      ydoc.destroy();
    }
  });
});

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

describe("CommentsModel document comments (#1025)", () => {
  const suggestion = "Tighten the opening.\n\n```suggestion\nHello bold new world\n```";

  it("a {0,0} thread stays at {0,0} with an empty quote after inserting 200 characters at 0", () => {
    const { model, ytext } = setup();
    const id = model.add({ from: 0, to: 0, body: "Overall: looks good", author: alice });
    let thread = model.get(id)!;
    expect(thread.range).toEqual({ from: 0, to: 0 });
    expect(thread.quote).toBe("");
    expect(isDocumentRange(thread.range)).toBe(true);

    ytext.insert(0, "x".repeat(200));
    thread = model.get(id)!;
    expect(thread.range).toEqual({ from: 0, to: 0 });
    // The anchor never moves for typing anywhere else, nor for deleting the whole text.
    ytext.insert(ytext.length, " and more");
    ytext.delete(0, ytext.length);
    expect(model.get(id)!.range).toEqual({ from: 0, to: 0 });
    // A selection comment created after the fact is unaffected by the document thread's anchor rule.
    ytext.insert(0, "Hello brave new world");
    const other = model.add({ from: 6, to: 11, body: "still anchored", author: bob });
    ytext.insert(0, "__");
    expect(model.get(other)!.range).toEqual({ from: 8, to: 13 });
    expect(model.get(id)!.range).toEqual({ from: 0, to: 0 });
  });

  it("stays {0,0} in an empty document and after a full sync to a second Y.Doc", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    const model = new CommentsModel(ydoc, ytext);
    const id = model.add({ from: 0, to: 0, body: "First!", author: alice });
    expect(model.get(id)!.range).toEqual({ from: 0, to: 0 });
    ytext.insert(0, "# Title\n\nBody.\n");
    expect(model.get(id)!.range).toEqual({ from: 0, to: 0 });
    // With createAnchor the start would have followed the first character to the end of the text.
    expect(createAnchor(ytext, 0, 0).start).not.toEqual(model.get(id)!.anchor.start);

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    const mirror = new CommentsModel(remote, remote.getText("content"));
    expect(mirror.get(id)!.range).toEqual({ from: 0, to: 0 });
    expect(mirror.get(id)!.quote).toBe("");
  });

  it("refuses to accept a suggestion on a document thread (root and reply) but still rejects it", () => {
    const { model, ytext } = setup();
    const id = model.add({ from: 0, to: 0, body: suggestion, author: alice });
    expect(model.acceptSuggestion(id, "Hello bold new world", bob)).toBe(false);
    expect(ytext.toString()).toBe("Hello brave new world");
    expect(model.get(id)!.suggestionState).toBeNull();
    const replyId = model.reply(id, suggestion, bob)!;
    expect(model.acceptReplySuggestion(id, replyId, alice)).toBe(false);
    expect(ytext.toString()).toBe("Hello brave new world");
    expect(model.rejectReplySuggestion(id, replyId, alice)).toBe(true);
    expect(model.rejectSuggestion(id, bob)).toBe(true);
    expect(model.get(id)!.suggestionState).toBe("rejected");
  });

  it("isDocumentRange is only true for exactly {0,0}", () => {
    expect(isDocumentRange(null)).toBe(false);
    expect(isDocumentRange(undefined)).toBe(false);
    expect(isDocumentRange({ from: 0, to: 1 })).toBe(false);
    expect(isDocumentRange({ from: 3, to: 3 })).toBe(false);
    expect(isDocumentRange({ from: 0, to: 0 })).toBe(true);
  });
});
