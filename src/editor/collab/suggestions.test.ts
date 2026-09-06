import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { SuggestionsModel, SuggestionConflictError, SUGGESTIONS_ORIGIN } from "./suggestions";
import { CommentsModel } from "./comments";
import { makeCollabUser } from "./shared";
import { diffSuggestionEdits } from "../sync/suggestion-diff";
import { LONG_PASSAGE_PREFIX, LONG_PASSAGE_SUFFIX, REWRITE_AFTER, REWRITE_AUTHOR, REWRITE_BEFORE, REWRITE_DOCUMENT, REWRITE_PREFIX, REWRITE_RESULT, REWRITE_SUFFIX } from "./rewrite.test-fixture";

const agent = makeCollabUser("agent:owner:synthetic-run", REWRITE_AUTHOR);
const human = makeCollabUser("human", "Reviewer");
const docs: Y.Doc[] = [];

function setup(text = REWRITE_DOCUMENT) {
  const doc = new Y.Doc();
  docs.push(doc);
  const ytext = doc.getText("content");
  ytext.insert(0, text);
  const model = new SuggestionsModel(doc, ytext);
  return { doc, ytext, model };
}

function propose(model: SuggestionsModel, text = REWRITE_RESULT) {
  return diffSuggestionEdits(model.ytext.toString(), text).reverse().map((edit) => model.propose(edit, agent));
}

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

describe("coherent tracked replacements", () => {
  it("counts groups and reuses a supplied snapshot without serializing the document", () => {
    const { ytext, model } = setup();
    propose(model);
    model.applyEdit({ from: ytext.length, to: ytext.length, insert: "A human addition." }, human);
    const snapshot = ytext.toString();
    const expected = model.groups();
    const original = ytext.toString.bind(ytext);
    const serialize = vi.fn(original);
    ytext.toString = serialize;
    expect(model.count).toBe(2);
    expect(model.groups(snapshot)).toEqual(expected);
    expect(serialize).not.toHaveBeenCalled();
    ytext.toString = original;
  });

  it("does not serialize the document when there are no suggestions", () => {
    const { ytext, model } = setup();
    const original = ytext.toString.bind(ytext);
    const serialize = vi.fn(original);
    ytext.toString = serialize;
    expect(model.count).toBe(0);
    expect(model.groups()).toEqual([]);
    expect(serialize).not.toHaveBeenCalled();
    ytext.toString = original;
  });

  it.each(["accept", "reject"] as const)("%s decides one exact passage, with two render runs and one author", (action) => {
    const { ytext, model } = setup();
    const [id] = propose(model);
    expect(model.count).toBe(1);
    expect(model.groups()).toEqual([expect.objectContaining({ id, type: "replace", before: REWRITE_BEFORE, after: REWRITE_AFTER, authorId: agent.id, authorName: REWRITE_AUTHOR, outdated: false })]);
    expect(model.list().map((s) => [s.type, ytext.toString().slice(s.from, s.to), s.groupId])).toEqual([
      ["insert", REWRITE_AFTER, id],
      ["delete", REWRITE_BEFORE, id],
    ]);
    expect(model.cleanText()).toBe(REWRITE_DOCUMENT);
    expect(model[action](id)).toBe(1);
    expect(ytext.toString()).toBe(action === "accept" ? REWRITE_RESULT : REWRITE_DOCUMENT);
    expect(model.count).toBe(0);
  });

  it("preserves subsequent independent collaborator edits and comments", () => {
    const { doc, ytext, model } = setup();
    const comments = new CommentsModel(doc, ytext);
    const thread = comments.add({ from: 2, to: 13, body: "Keep the heading.", author: human });
    const [id] = propose(model);
    doc.transact(() => {
      ytext.insert(0, "Human introduction.\n\n");
      ytext.insert(ytext.length, "\nHuman conclusion.");
      comments.reply(thread, "A later reply.", human);
    }, "human");
    expect(model.reject(id)).toBe(1);
    expect(ytext.toString()).toBe("Human introduction.\n\n" + REWRITE_DOCUMENT + "\nHuman conclusion.");
    const saved = comments.get(thread)!;
    expect(saved.authorId).toBe(human.id);
    expect(saved.replies.map((reply) => reply.body)).toEqual(["A later reply."]);
    expect(ytext.toString().slice(saved.range!.from, saved.range!.to)).toBe("Garden plan");
    comments.destroy();
  });

  it.each(["accept", "reject"] as const)("%s keeps anchors inside the removed copy on the surviving passage", (action) => {
    const { doc, ytext, model } = setup();
    const [id] = propose(model);
    const comments = new CommentsModel(doc, ytext);
    const group = model.groups()[0];
    const removed = group.members.find((s) => s.type === (action === "accept" ? "delete" : "insert"))!;
    const start = removed.from + removed.text.indexOf("the weather");
    const thread = comments.add({ from: start, to: start + "the weather".length, body: "Use these observations.", author: human });
    model[action](id);
    const saved = comments.get(thread)!;
    expect(saved.quote).toBe("the weather");
    expect(ytext.toString().slice(saved.range!.from, saved.range!.to)).toBe("the weather");
    comments.destroy();
  });

  it("keeps distinct calls, adjacent operations and authors separate", () => {
    const { ytext, model } = setup("red blue\n\norange purple");
    const a = model.propose({ from: 0, to: 3, insert: "pink" }, agent);
    const blue = ytext.toString().indexOf("blue");
    const b = model.propose({ from: blue, to: blue + 4, insert: "green" }, agent);
    const orange = ytext.toString().indexOf("orange");
    const c = model.propose({ from: orange, to: orange + 6, insert: "gold" }, human);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(model.groups().map((group) => group.authorId)).toEqual([agent.id, agent.id, human.id]);
    model.accept(b);
    expect(model.groups().map((group) => group.id)).toEqual([a, c]);
    model.reject(a);
    model.reject(c);
    expect(ytext.toString()).toBe("red green\n\norange purple");
  });

  it.each(["insert", "delete"] as const)("refuses a stale %s range rather than deleting a collaborator's change", (type) => {
    const { ytext, model } = setup();
    const [id] = propose(model);
    const range = model.list().find((s) => s.type === type)!;
    ytext.insert(range.from + 5, "HUMAN");
    const before = ytext.toString();
    expect(model.groups()[0].outdated).toBe(true);
    expect(() => model.accept(id)).toThrow(SuggestionConflictError);
    expect(() => model.reject(id)).toThrow(SuggestionConflictError);
    expect(() => model.acceptAll()).toThrow(SuggestionConflictError);
    expect(ytext.toString()).toBe(before);
    expect(model.count).toBe(1);
  });

  it("does not hide overlapping human annotations or silently decide a missing half", () => {
    const { ytext, model } = setup();
    const [id] = propose(model);
    model.applyEdit({ from: REWRITE_PREFIX.length + 1, to: REWRITE_PREFIX.length + 4, insert: "" }, human);
    expect(model.count).toBe(2);
    expect(model.groups().find((group) => group.id === id)?.outdated).toBe(true);
    expect(() => model.accept(id)).toThrow(SuggestionConflictError);
    const deletion = model.list().find((s) => s.groupId === id && s.type === "delete")!;
    ytext.delete(deletion.from, deletion.to - deletion.from);
    model.prune();
    expect(model.ymap.has(deletion.id)).toBe(true);
    expect(() => model.reject(id)).toThrow(SuggestionConflictError);
  });

  it.each([
    ["A smal typo.", "A small typo."],
    ["A path.", "A quiet path."],
    ["A quiet path.", "A path."],
    ["Before\n\n- one\n- two\n\nAfter\n", "Before\n\n- revised one\n- revised two\n\nAfter\n"],
    ["```js\none();\n```\n", "```ts\nconst value = 1;\nuse(value);\n```\n"],
    ["\u6c34 \ud83c\udf31 e\u0301", "\u6c34 \ud83c\udf33 \u00e9"],
  ])("keeps exact accepted/rejected Markdown for %j", (before, after) => {
    for (const action of ["acceptAll", "rejectAll"] as const) {
      const { ytext, model } = setup(before);
      propose(model, after);
      model[action]();
      expect(ytext.toString()).toBe(action === "acceptAll" ? after : before);
    }
  });

  it("retains independent text inserted exactly between old and new runs", () => {
    const { ytext, model } = setup();
    const [id] = propose(model);
    const deletion = model.list().find((s) => s.type === "delete")!;
    ytext.insert(deletion.from, " HUMAN NOTE ");
    model.reject(id);
    expect(ytext.toString()).toBe(REWRITE_PREFIX + " HUMAN NOTE " + REWRITE_BEFORE + REWRITE_SUFFIX);
  });

  it("keeps concurrent overlapping operations distinct and requires a fresh review", () => {
    const { doc, model } = setup();
    const other = new Y.Doc();
    docs.push(other);
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const otherModel = new SuggestionsModel(other, other.getText("content"));
    const edit = diffSuggestionEdits(REWRITE_DOCUMENT, REWRITE_RESULT)[0];
    const first = model.propose(edit, agent);
    const second = otherModel.propose({ ...edit, insert: "A colleague's alternative paragraph." }, human);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    expect(model.groups().map((group) => group.id).sort()).toEqual([first, second].sort());
    expect(model.groups().every((group) => group.outdated)).toBe(true);
    expect(new Set(model.groups().map((group) => group.authorId))).toEqual(new Set([agent.id, human.id]));
    const before = model.ytext.toString();
    expect(() => model.acceptAll()).toThrow(SuggestionConflictError);
    expect(model.ytext.toString()).toBe(before);
    otherModel.destroy();
  });

  it("preflights the complete operation batch before any Yjs update", () => {
    const { doc, model, ytext } = setup("one two three");
    let updates = 0;
    doc.on("update", () => updates++);
    expect(() => model.proposeEdits([{ from: 0, to: 3, insert: "first" }, { from: 4, to: 50, insert: "bad range" }], agent)).toThrow(RangeError);
    expect(updates).toBe(0);
    expect(ytext.toString()).toBe("one two three");
    expect(model.count).toBe(0);
  });

  it.each([
    ["replacement", "\ud83c\udf31", "\ud83c\udf33"],
    ["insertion", "", "x"],
    ["deletion", "x", ""],
  ])("keeps an oversized passage's small %s review and undo independent of other suggestions and typing", (_kind, oldMiddle, newMiddle) => {
    const before = LONG_PASSAGE_PREFIX + oldMiddle + LONG_PASSAGE_SUFFIX;
    const after = LONG_PASSAGE_PREFIX + newMiddle + LONG_PASSAGE_SUFFIX;
    for (const action of ["accept", "reject"] as const) {
      const { ytext, model } = setup(before);
      model.applyEdit({ from: 2, to: 4, insert: "" }, human);
      const [independent] = model.list();
      const [id] = model.proposeEdits(diffSuggestionEdits(before, after), agent);
      expect(model.count).toBe(2);
      const group = model.groups().find((item) => item.id === id)!;
      expect(group.to - group.from).toBe(oldMiddle.length + newMiddle.length);
      expect(group).toMatchObject({ before: oldMiddle, after: newMiddle, authorId: agent.id, outdated: false });
      const undo = new Y.UndoManager([ytext, model.ymap], { trackedOrigins: new Set([SUGGESTIONS_ORIGIN]) });
      ytext.insert(5, "Human introduction.");
      ytext.insert(ytext.length - 5, "Human conclusion.");
      expect(model.groups().every((item) => !item.outdated)).toBe(true);
      const proposed = ytext.toString();
      expect(model[action](id)).toBe(1);
      expect(model.count).toBe(1);
      expect(model.list()).toEqual([independent]);
      const expected =
        LONG_PASSAGE_PREFIX.slice(0, 5) + "Human introduction." + LONG_PASSAGE_PREFIX.slice(5) +
        (action === "accept" ? newMiddle : oldMiddle) +
        LONG_PASSAGE_SUFFIX.slice(0, -5) + "Human conclusion." + LONG_PASSAGE_SUFFIX.slice(-5);
      expect(ytext.toString()).toBe(expected);
      expect(undo.undoStack).toHaveLength(1);
      undo.undo();
      expect(ytext.toString()).toBe(proposed);
      expect(model.count).toBe(2);
      expect(model.groups().find((item) => item.id === id)?.outdated).toBe(false);
      expect(model.list().find((item) => item.id === independent.id)).toEqual(independent);
      undo.redo();
      expect(ytext.toString()).toBe(expected);
      expect(model.list()).toEqual([independent]);
      undo.destroy();
    }
  });
});
