import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CommentsModel, DecidedSuggestionEditError } from "./comments";
import { hasSuggestionBlock, isSuggestionOutdated, parseSuggestionBlock, reviewSuggestionNote, reviewSummaryLabel, reviewVerdictLabel, suggestionBlockFor, suggestionOutdatedCause } from "./suggestion-block";
import { SuggestionsModel } from "./suggestions";

const alice = { id: "alice", name: "Alice", color: "#000", colorLight: "#fff", login: "alice" };
const bob = { id: "bob", name: "Bob", color: "#000", colorLight: "#fff", login: "bob" };

describe("parseSuggestionBlock", () => {
  it("extracts the fenced block and the surrounding prose", () => {
    const body = "Tighten this.\n\n```suggestion\nThe quick brown fox.\n```\n\nThanks!";
    expect(parseSuggestionBlock(body)).toEqual({ text: "The quick brown fox.", prose: "Tighten this.\n\nThanks!", warning: null });
  });

  it("accepts a block at the very start, CRLF line ends and multi-line content", () => {
    const body = "```suggestion\r\nline one\r\nline two\r\n```";
    expect(parseSuggestionBlock(body)).toEqual({ text: "line one\nline two", prose: "", warning: null });
  });

  it("an empty block proposes a deletion", () => {
    expect(parseSuggestionBlock("Drop it.\n```suggestion\n```")).toEqual({ text: "", prose: "Drop it.", warning: null });
  });

  it("uses only the first of several blocks and warns", () => {
    const body = "```suggestion\nA\n```\n\n```suggestion\nB\n```";
    const r = parseSuggestionBlock(body)!;
    expect(r.text).toBe("A");
    expect(r.warning).toMatch(/first of 2/);
    expect(r.prose).toContain("B");
  });

  it("returns null when there is no block (plain code fences are not suggestions)", () => {
    expect(parseSuggestionBlock("Just a note")).toBeNull();
    expect(parseSuggestionBlock("```js\nconsole.log(1)\n```")).toBeNull();
    expect(hasSuggestionBlock("```js\nx\n```")).toBe(false);
    expect(hasSuggestionBlock("```suggestion\nx\n```")).toBe(true);
  });

  it("suggestionBlockFor round-trips, escaping inner backtick runs", () => {
    const body = suggestionBlockFor("use ```code``` here", "Maybe:");
    expect(body.startsWith("Maybe:\n\n````suggestion")).toBe(true);
    expect(parseSuggestionBlock(body)?.text).toBe("use ```code``` here");
  });
});

describe("isSuggestionOutdated", () => {
  it("is fresh while the anchored text still reads as the quote, outdated after an edit or when the range is gone", () => {
    expect(isSuggestionOutdated({ quote: "brown", range: { from: 10, to: 15 } }, "The quick brown fox")).toBe(false);
    expect(isSuggestionOutdated({ quote: "brown", range: { from: 10, to: 15 } }, "The quick BROWN fox")).toBe(true);
    expect(isSuggestionOutdated({ quote: "brown", range: null }, "The quick fox")).toBe(true);
  });
});

describe("labels", () => {
  it("pluralises and names the verdict", () => {
    expect(reviewSummaryLabel(1, 0)).toBe("1 comment");
    expect(reviewSummaryLabel(3, 2)).toBe("3 comments · 2 suggestions");
    expect(reviewVerdictLabel("Copilot", "request_changes")).toBe("Copilot requested changes");
    expect(reviewVerdictLabel("Alice", "approve")).toBe("Alice approved");
    expect(reviewVerdictLabel("Bob", "comment")).toBe("Bob commented");
  });
});

describe("CommentsModel suggestions", () => {
  function setup(text: string) {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, text);
    const model = new CommentsModel(ydoc, ytext);
    return { ydoc, ytext, model };
  }

  it("accept replaces exactly the quoted range with the proposal, records the decision and resolves, in one undo step", () => {
    const { ydoc, ytext, model } = setup("The quick brown fox jumps.");
    const undo = new Y.UndoManager(ytext, { trackedOrigins: new Set([{ name: "comments" }]) });
    const id = model.add({ from: 4, to: 15, body: "```suggestion\nslow red\n```", author: alice });
    const origin = { name: "comments" };
    undo.addTrackedOrigin(origin);
    expect(model.acceptSuggestion(id, "slow red", bob, origin)).toBe(true);
    expect(ytext.toString()).toBe("The slow red fox jumps.");
    const t = model.get(id)!;
    expect(t.suggestionState).toBe("accepted");
    expect(t.suggestionBy).toBe("bob");
    expect(t.suggestionQuote).toBe("quick brown");
    expect(t.resolved).toBe(true);
    expect(t.resolvedBy).toBe("bob");
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(ytext.toString()).toBe("The quick brown fox jumps.");
    ydoc.destroy();
  });

  it("accept refuses an outdated suggestion and a second decision; reject never touches the text", () => {
    const { ytext, model } = setup("The quick brown fox jumps.");
    const id = model.add({ from: 4, to: 15, body: "```suggestion\nslow red\n```", author: alice });
    ytext.insert(10, "BIG ");
    expect(model.acceptSuggestion(id, "slow red", bob)).toBe(false);
    expect(ytext.toString()).toBe("The quick BIG brown fox jumps.");
    expect(model.rejectSuggestion(id, bob)).toBe(true);
    expect(model.get(id)!.suggestionState).toBe("rejected");
    expect(model.get(id)!.resolved).toBe(false);
    expect(model.rejectSuggestion(id, bob)).toBe(false);
    expect(model.acceptSuggestion(id, "x", bob)).toBe(false);
  });

  it("accept with an empty proposal deletes the quoted text", () => {
    const { ytext, model } = setup("Keep this. Remove this. Keep that.");
    const id = model.add({ from: 11, to: 24, body: "```suggestion\n```", author: alice });
    expect(model.acceptSuggestion(id, "", bob)).toBe(true);
    expect(ytext.toString()).toBe("Keep this. Keep that.");
  });

  it("accepts a reply suggestion in one undo step without deciding another reply or resolving the thread", () => {
    const { ytext, model } = setup("The quick brown fox jumps.");
    const id = model.add({ from: 4, to: 15, body: "Could this be clearer?", author: alice });
    const acceptedId = model.reply(id, "Yes.\n\n```suggestion\nslow red\n```", alice)!;
    const pendingId = model.reply(id, "Another option.\n\n```suggestion\nswift auburn\n```", alice)!;
    const origin = { name: "comments" };
    const undo = new Y.UndoManager(ytext, { trackedOrigins: new Set([origin]) });

    expect(model.acceptReplySuggestion(id, acceptedId, bob, origin)).toBe(true);
    expect(ytext.toString()).toBe("The slow red fox jumps.");
    const thread = model.get(id)!;
    expect(thread.replies.find((reply) => reply.id === acceptedId)).toMatchObject({
      suggestionState: "accepted",
      suggestionBy: "bob",
      suggestionQuote: "quick brown",
    });
    expect(thread.replies.find((reply) => reply.id === pendingId)?.suggestionState).toBeUndefined();
    expect(thread.suggestionState).toBeNull();
    expect(thread.resolved).toBe(false);
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(ytext.toString()).toBe("The quick brown fox jumps.");
  });

  it("rejects an outdated reply suggestion independently and refuses unknown, non-suggestion, or decided replies", () => {
    const { ytext, model } = setup("The quick brown fox jumps.");
    const id = model.add({ from: 4, to: 15, body: "Could this be clearer?", author: alice });
    const rejectedId = model.reply(id, "```suggestion\nslow red\n```", alice)!;
    const plainId = model.reply(id, "No rewrite here.", alice)!;
    ytext.insert(10, "BIG ");

    expect(model.acceptReplySuggestion(id, rejectedId, bob)).toBe(false);
    expect(model.rejectReplySuggestion(id, rejectedId, bob)).toBe(true);
    expect(model.get(id)!.replies.find((reply) => reply.id === rejectedId)).toMatchObject({
      suggestionState: "rejected",
      suggestionBy: "bob",
    });
    expect(model.rejectReplySuggestion(id, rejectedId, bob)).toBe(false);
    expect(model.acceptReplySuggestion(id, rejectedId, bob)).toBe(false);
    expect(model.rejectReplySuggestion(id, plainId, bob)).toBe(false);
    expect(model.rejectReplySuggestion(id, "missing", bob)).toBe(false);
    expect(ytext.toString()).toBe("The quick BIG brown fox jumps.");
  });

  it("re-anchors after each accepted reply so sibling reply suggestions stay pending and Accept all can decide each once", () => {
    const { ydoc, ytext, model } = setup("The quick brown fox jumps.");
    const id = model.add({ from: 4, to: 15, body: "Could this be clearer?", author: alice });
    const firstId = model.reply(id, "```suggestion\nslow red\n```", alice)!;
    const secondId = model.reply(id, "```suggestion\nswift auburn\n```", alice)!;

    expect(model.acceptReplySuggestion(id, firstId, bob)).toBe(true);
    let thread = model.get(id)!;
    expect(thread.quote).toBe("slow red");
    expect(thread.range && ytext.toString().slice(thread.range.from, thread.range.to)).toBe("slow red");
    expect(thread.replies.find((reply) => reply.id === secondId)?.suggestionState).toBeUndefined();
    expect(isSuggestionOutdated(thread, ytext.toString())).toBe(false);

    expect(model.acceptReplySuggestion(id, secondId, bob)).toBe(true);
    expect(model.acceptReplySuggestion(id, secondId, bob)).toBe(false);
    thread = model.get(id)!;
    expect(ytext.toString()).toBe("The swift auburn fox jumps.");
    expect(thread.replies.map((reply) => reply.suggestionState)).toEqual(["accepted", "accepted"]);
    expect(thread.replies.map((reply) => reply.suggestionQuote)).toEqual(["quick brown", "slow red"]);

    const reloaded = new CommentsModel(ydoc, ytext);
    expect(reloaded.get(id)!.replies.map((reply) => reply.suggestionQuote)).toEqual(["quick brown", "slow red"]);
    reloaded.destroy();
  });

  it("keeps a reply suggestion applicable when the root suggestion is accepted first", () => {
    const { ytext, model } = setup("The quick brown fox jumps.");
    const id = model.add({ from: 4, to: 15, body: "```suggestion\nslow red\n```", author: alice });
    const replyId = model.reply(id, "Another option.\n\n```suggestion\nswift auburn\n```", alice)!;

    expect(model.acceptSuggestion(id, "slow red", bob)).toBe(true);
    expect(model.get(id)).toMatchObject({ quote: "slow red", suggestionState: "accepted", suggestionQuote: "quick brown" });
    expect(model.acceptReplySuggestion(id, replyId, bob)).toBe(true);
    expect(ytext.toString()).toBe("The swift auburn fox jumps.");
    expect(model.get(id)!.replies[0]).toMatchObject({ suggestionState: "accepted", suggestionQuote: "slow red" });
    expect(model.get(id)!.suggestionQuote).toBe("quick brown");
  });

  it.each(["accepted", "rejected"] as const)("keeps %s root and reply suggestion bodies immutable", (state) => {
    const root = setup("Alpha text.");
    const rootBody = "Root proposal.\n\n```suggestion\nOmega text.\n```";
    const rootId = root.model.add({ from: 0, to: 10, body: rootBody, author: alice });
    if (state === "accepted") expect(root.model.acceptSuggestion(rootId, "Omega text.", bob)).toBe(true);
    else expect(root.model.rejectSuggestion(rootId, bob)).toBe(true);

    expect(() => root.model.editBody(rootId, "Changed after the decision.")).toThrow(new DecidedSuggestionEditError(state));
    expect(root.model.get(rootId)?.body).toBe(rootBody);

    const reply = setup("Beta text.");
    const threadId = reply.model.add({ from: 0, to: 9, body: "What do you think?", author: alice });
    const replyBody = "Reply proposal.\n\n```suggestion\nGamma text.\n```";
    const replyId = reply.model.reply(threadId, replyBody, alice)!;
    if (state === "accepted") expect(reply.model.acceptReplySuggestion(threadId, replyId, bob)).toBe(true);
    else expect(reply.model.rejectReplySuggestion(threadId, replyId, bob)).toBe(true);

    expect(() => reply.model.editBody(threadId, "Changed after the decision.", replyId)).toThrow(new DecidedSuggestionEditError(state));
    expect(reply.model.get(threadId)?.replies[0].body).toBe(replyBody);
  });
});

describe("suggestionOutdatedCause (#2327)", () => {
  const agent = { id: "agent:alice:Copilot", name: "Copilot", color: "#000", colorLight: "#fff", login: "alice" };
  function world(text: string, quote: string) {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, text);
    const comments = new CommentsModel(doc, ytext);
    const tracked = new SuggestionsModel(doc, ytext);
    const from = text.indexOf(quote);
    const id = comments.add({ from, to: from + quote.length, body: "```suggestion\nnew words\n```", author: alice });
    const insertions = () => tracked.list().filter((s) => s.type === "insert");
    const cause = () => suggestionOutdatedCause(comments.get(id)!, ytext.toString(), insertions());
    const replace = (find: string, insert: string) => {
      const at = ytext.toString().indexOf(find);
      return tracked.proposeEdits([{ from: at, to: at + find.length, insert }], agent);
    };
    return { ytext, comments, tracked, id, cause, replace };
  }

  it("is null while the quoted text reads as it did, also inside a pending tracked insertion", () => {
    const plain = world("The plan is strong today.", "is strong");
    expect(plain.cause()).toBeNull();

    // The quote sits in text that only a pending tracked suggestion put there: applicable, before and after it is accepted.
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "Intro. Draft goes here. End.");
    const tracked = new SuggestionsModel(doc, ytext);
    const ids = tracked.proposeEdits([{ from: 7, to: 23, insert: "The new draft is strong." }], agent);
    const comments = new CommentsModel(doc, ytext);
    const at = ytext.toString().indexOf("is strong");
    const id = comments.add({ from: at, to: at + 9, body: "```suggestion\nis solid\n```", author: alice });
    const cause = () => suggestionOutdatedCause(comments.get(id)!, ytext.toString(), tracked.list().filter((s) => s.type === "insert"));
    expect(cause()).toBeNull();
    for (const suggestion of ids) tracked.accept(suggestion);
    expect(ytext.toString()).toBe("Intro. The new draft is strong. End.");
    expect(cause()).toBeNull();
  });

  it("names a pending tracked suggestion as the cause, and only while rejecting it would give the quote back", () => {
    const pending = world("The plan is strong today.", "is strong");
    const ids = pending.replace("strong", "solid");
    expect(pending.ytext.toString()).toBe("The plan is solidstrong today.");
    expect(isSuggestionOutdated(pending.comments.get(pending.id)!, pending.ytext.toString())).toBe(true);
    expect(pending.cause()).toBe("pending-suggestion");
    // Without the pending insertions the same text is simply changed.
    expect(suggestionOutdatedCause(pending.comments.get(pending.id)!, pending.ytext.toString(), [])).toBe("changed");

    // Rejected: the quote reads as before, the suggestion applies again.
    for (const id of ids) pending.tracked.reject(id);
    expect(pending.ytext.toString()).toBe("The plan is strong today.");
    expect(pending.cause()).toBeNull();

    // Accepted: the words are gone for good.
    const accepted = world("The plan is strong today.", "is strong");
    for (const id of accepted.replace("strong", "solid")) accepted.tracked.accept(id);
    expect(accepted.ytext.toString()).toBe("The plan is solid today.");
    expect(accepted.cause()).toBe("changed");
  });

  it("is 'changed' when the text was edited, the anchor is gone, or a pending insertion is not what differs", () => {
    const edited = world("The plan is strong today.", "is strong");
    const at = edited.ytext.toString().indexOf("strong");
    edited.ytext.delete(at, 6);
    edited.ytext.insert(at, "weak");
    expect(edited.cause()).toBe("changed");

    // A pending insertion in the range AND a real edit: rejecting the insertion would not give the quote back.
    const both = world("The plan is strong today.", "is strong");
    both.replace("strong", "solid");
    const is = both.ytext.toString().indexOf("is ");
    both.ytext.delete(is, 2);
    both.ytext.insert(is, "was");
    expect(both.cause()).toBe("changed");

    // A pending insertion somewhere else does not explain an edit here.
    const elsewhere = world("The plan is strong today.", "is strong");
    elsewhere.replace("today", "now");
    const strong = elsewhere.ytext.toString().indexOf("strong");
    elsewhere.ytext.delete(strong, 6);
    elsewhere.ytext.insert(strong, "weak");
    expect(elsewhere.cause()).toBe("changed");

    expect(suggestionOutdatedCause({ quote: "is strong", range: null }, "anything", [{ from: 0, to: 3 }])).toBe("changed");
  });

  it("takes several pending insertions out of one quoted range, in any order", () => {
    const quote = "one two three";
    const text = "one ONEtwo TWOthree";
    const thread = { quote, range: { from: 0, to: text.length } };
    const first = { from: 4, to: 7 };
    const second = { from: 11, to: 14 };
    expect(suggestionOutdatedCause(thread, text, [first, second])).toBe("pending-suggestion");
    expect(suggestionOutdatedCause(thread, text, [second, first])).toBe("pending-suggestion");
    expect(suggestionOutdatedCause(thread, text, [first])).toBe("changed");
    // An insertion that only partly lies in the range is cut at the range's edge.
    expect(suggestionOutdatedCause({ quote: "two", range: { from: 5, to: 10 } }, "one ONEtwo TWOthree", [{ from: 4, to: 7 }])).toBe("pending-suggestion");
  });
});

describe("reviewSuggestionNote (#2327)", () => {
  it.each([
    // undecided, applicable, waiting, sentence
    [4, 4, 0, null],
    [1, 1, 0, null],
    [0, 0, 0, null],
    [4, 0, 0, "None of the 4 suggestions can be applied: the text they quote has changed."],
    [2, 0, 0, "None of the 2 suggestions can be applied: the text they quote has changed."],
    [1, 0, 0, "The suggestion cannot be applied: the text it quotes has changed."],
    [4, 0, 4, "None of the 4 suggestions can be applied: a pending suggestion changes the text they quote. They apply again if it is rejected."],
    [1, 0, 1, "The suggestion cannot be applied: a pending suggestion changes the text it quotes. It applies again if the pending suggestion is rejected."],
    [4, 0, 2, "None of the 4 suggestions can be applied: the text they quote has changed, for 2 of them by a pending suggestion. Those apply again if it is rejected."],
    [4, 0, 1, "None of the 4 suggestions can be applied: the text they quote has changed, for 1 of them by a pending suggestion. That one applies again if it is rejected."],
    [4, 2, 0, "2 of 4 suggestions can be applied; 2 quote text that has changed."],
    [3, 2, 0, "2 of 3 suggestions can be applied; 1 quotes text that has changed."],
    [3, 1, 0, "1 of 3 suggestions can be applied; 2 quote text that has changed."],
    [4, 2, 2, "2 of 4 suggestions can be applied; 2 quote text that a pending suggestion changes."],
    [2, 1, 1, "1 of 2 suggestions can be applied; 1 quotes text that a pending suggestion changes."],
    [4, 1, 1, "1 of 4 suggestions can be applied; 3 quote text that has changed, 1 of them by a pending suggestion."],
  ] as const)("%i undecided, %i applicable, %i waiting", (undecided, applicable, waiting, sentence) => {
    expect(reviewSuggestionNote({ undecided, applicable, waiting })).toBe(sentence);
  });
});