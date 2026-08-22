import { describe, expect, it, beforeEach } from "vitest";
import * as Y from "yjs";
import { SuggestionsModel, cleanTextWith } from "./suggestions";
import { CommentsModel } from "./comments";
import { makeCollabUser } from "./shared";

const alice = makeCollabUser("a", "Alice");
const bob = makeCollabUser("b", "Bob");

describe("SuggestionsModel", () => {
  let ydoc: Y.Doc;
  let ytext: Y.Text;
  let model: SuggestionsModel;

  beforeEach(() => {
    ydoc = new Y.Doc();
    ytext = ydoc.getText("content");
    ytext.insert(0, "The quick brown fox.");
    model = new SuggestionsModel(ydoc, ytext);
  });

  it("records insertions and extends them while typing", () => {
    model.applyEdit({ from: 4, to: 4, insert: "v" }, alice);
    model.applyEdit({ from: 5, to: 5, insert: "ery " }, alice);
    expect(ytext.toString()).toBe("The very quick brown fox.");
    const list = model.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: "insert", from: 4, to: 9, text: "very ", authorId: "a" });
  });

  it("turns deletions into delete suggestions and keeps the text", () => {
    const result = model.applyEdit({ from: 4, to: 10, insert: "" }, alice);
    expect(ytext.toString()).toBe("The quick brown fox.");
    expect(result.kept).toBe(6);
    expect(result.cursor).toBe(4);
    const [s] = model.list();
    expect(s).toMatchObject({ type: "delete", from: 4, to: 10, text: "quick " });
  });

  it("merges adjacent delete suggestions by the same author (backspacing)", () => {
    model.applyEdit({ from: 9, to: 10, insert: "" }, alice);
    model.applyEdit({ from: 8, to: 9, insert: "" }, alice);
    model.applyEdit({ from: 7, to: 8, insert: "" }, alice);
    const list = model.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: "delete", from: 7, to: 10 });
  });

  it("really deletes inside the author's own pending insertion", () => {
    model.applyEdit({ from: 4, to: 4, insert: "very " }, alice);
    // Backspace the trailing space of "very ".
    model.applyEdit({ from: 8, to: 9, insert: "" }, alice);
    expect(ytext.toString()).toBe("The veryquick brown fox.");
    expect(model.list()).toEqual([expect.objectContaining({ type: "insert", from: 4, to: 8, text: "very" })]);
    // Deleting everything of the insertion removes the record entirely.
    model.applyEdit({ from: 4, to: 8, insert: "" }, alice);
    expect(ytext.toString()).toBe("The quick brown fox.");
    expect(model.list()).toHaveLength(0);
  });

  it("treats other people's insertions as regular text", () => {
    model.applyEdit({ from: 4, to: 4, insert: "very " }, alice);
    model.applyEdit({ from: 4, to: 9, insert: "" }, bob);
    expect(ytext.toString()).toBe("The very quick brown fox.");
    const list = model.list();
    expect(list.map((s) => [s.type, s.authorId, s.from, s.to])).toEqual([
      ["insert", "a", 4, 9],
      ["delete", "b", 4, 9],
    ]);
  });

  it("replaces a selection: deletion suggestion plus insertion", () => {
    const r = model.applyEdit({ from: 4, to: 9, insert: "slow" }, alice);
    expect(ytext.toString()).toBe("The slowquick brown fox.");
    expect(r.cursor).toBe(8);
    const list = model.list();
    expect(list.map((s) => [s.type, s.from, s.to])).toEqual([
      ["insert", 4, 8],
      ["delete", 8, 13],
    ]);
  });

  it("splits a delete suggestion when inserting inside it", () => {
    model.applyEdit({ from: 4, to: 9, insert: "" }, alice);
    model.applyEdit({ from: 6, to: 6, insert: "XX" }, bob);
    expect(ytext.toString()).toBe("The quXXick brown fox.");
    const list = model.list();
    expect(list.map((s) => [s.type, s.authorId, s.from, s.to])).toEqual([
      ["delete", "a", 4, 6],
      ["insert", "b", 6, 8],
      ["delete", "a", 8, 11],
    ]);
  });

  it("accepts and rejects", () => {
    model.applyEdit({ from: 4, to: 10, insert: "slow " }, alice);
    const [ins, del] = model.list();
    model.accept(del.id);
    expect(ytext.toString()).toBe("The slow brown fox.");
    model.reject(ins.id);
    expect(ytext.toString()).toBe("The brown fox.");
    expect(model.list()).toHaveLength(0);
  });

  it("computes clean text for export", () => {
    model.applyEdit({ from: 4, to: 10, insert: "slow " }, alice);
    expect(model.cleanText()).toBe("The quick brown fox.");
    expect(cleanTextWith("abc", [])).toBe("abc");
  });

  it("survives concurrent edits through relative positions", () => {
    model.applyEdit({ from: 10, to: 15, insert: "" }, alice); // "brown"
    ytext.insert(0, "Look! ");
    const [s] = model.list();
    expect(s).toMatchObject({ from: 16, to: 21 });
    expect(ytext.toString().slice(s.from, s.to)).toBe("brown");
  });

  it("accepts all and rejects all", () => {
    model.applyEdit({ from: 0, to: 3, insert: "A" }, alice);
    model.applyEdit({ from: 17, to: 20, insert: "cat" }, bob);
    expect(ytext.toString()).toBe("AThe quick brown catfox.");
    const snapshot = Y.encodeStateAsUpdate(ydoc);
    model.acceptAll();
    expect(ytext.toString()).toBe("A quick brown cat.");
    const other = new Y.Doc();
    Y.applyUpdate(other, snapshot);
    const otherModel = new SuggestionsModel(other, other.getText("content"));
    otherModel.rejectAll();
    expect(other.getText("content").toString()).toBe("The quick brown fox.");
  });
});

describe("CommentsModel", () => {
  it("adds, replies, resolves and tracks ranges", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "Hello brave new world");
    const model = new CommentsModel(ydoc, ytext);
    const id = model.add({ from: 6, to: 11, body: "Too dramatic?", author: alice });
    let [thread] = model.list();
    expect(thread.quote).toBe("brave");
    expect(thread.range).toEqual({ from: 6, to: 11 });
    model.reply(id, "I like it", bob);
    ytext.insert(0, "Oh. ");
    [thread] = model.list();
    expect(thread.range).toEqual({ from: 10, to: 15 });
    expect(thread.replies).toHaveLength(1);
    expect(thread.replies[0].authorName).toBe("Bob");
    model.setResolved(id, true, bob);
    expect(model.get(id)?.resolved).toBe(true);
    expect(model.get(id)?.resolvedBy).toBe("b");
    model.remove(id);
    expect(model.list()).toHaveLength(0);
  });

  it("notifies subscribers", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    const model = new CommentsModel(ydoc, ytext);
    let calls = 0;
    const off = model.subscribe(() => calls++);
    model.add({ from: 0, to: 0, body: "x", author: alice });
    expect(calls).toBe(1);
    off();
    model.add({ from: 0, to: 0, body: "y", author: alice });
    expect(calls).toBe(1);
  });
});
