import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CommentsModel } from "./comments";
import { hasSuggestionBlock, isSuggestionOutdated, parseSuggestionBlock, reviewSummaryLabel, reviewVerdictLabel, suggestionBlockFor } from "./suggestion-block";

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
});
