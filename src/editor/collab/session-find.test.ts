import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// A CollabSession normally opens a WebSocket through Hocuspocus; stand in a provider
// that only supplies the awareness instance so the model can be exercised offline.
vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  class HocuspocusProvider {
    awareness: InstanceType<typeof Awareness>;
    constructor(opts: { document: Y.Doc }) {
      this.awareness = new Awareness(opts.document);
    }
    destroy() {
      this.awareness.destroy();
    }
  }
  return { HocuspocusProvider };
});

import { CollabSession } from "./session";
import { makeCollabUser } from "./shared";
import { DEFAULT_FIND_OPTIONS } from "../find";

const TEXT = "The cat sat. The cat ran. A dog barked at the cat.";

function makeSession(role: "owner" | "viewer" = "owner"): CollabSession {
  const session = new CollabSession({ docId: "doc", user: makeCollabUser("a", "Alice"), role, getToken: async () => "token" });
  session.ytext.insert(0, TEXT);
  return session;
}

describe("CollabSession find & replace", () => {
  let session: CollabSession;
  beforeEach(() => {
    session = makeSession();
  });
  afterEach(() => {
    session.destroy();
  });

  it("setFind computes matches from the start and closeFind clears them", () => {
    expect(session.find).toBeNull();
    session.setFind("cat");
    expect(session.find).not.toBeNull();
    expect(session.find!.matches.map((m) => TEXT.slice(m.from, m.to))).toEqual(["cat", "cat", "cat"]);
    expect(session.find!.active).toBe(0);
    expect(session.find!.options).toEqual(DEFAULT_FIND_OPTIONS);

    session.setFind("Cat", { ...DEFAULT_FIND_OPTIONS, matchCase: true });
    expect(session.find!.matches).toEqual([]);
    expect(session.find!.active).toBe(-1);

    session.closeFind();
    expect(session.find).toBeNull();
  });

  it("stepFind moves forward and backward with wrap-around", () => {
    session.setFind("cat");
    expect(session.stepFind(1)).toEqual(session.find!.matches[1]);
    expect(session.find!.active).toBe(1);
    session.stepFind(1);
    expect(session.find!.active).toBe(2);
    expect(session.stepFind(1)).toEqual(session.find!.matches[0]);
    expect(session.find!.active).toBe(0);
    expect(session.stepFind(-1)).toEqual(session.find!.matches[2]);
    expect(session.find!.active).toBe(2);

    session.setFind("zebra");
    expect(session.stepFind(1)).toBeNull();
  });

  it("refreshes matches live when the text changes underneath", () => {
    session.setFind("cat");
    session.stepFind(1);
    const before = session.find!.matches[1];
    // A "remote" edit before the active match shifts everything right and adds a match.
    session.ytext.insert(0, "cat! ");
    expect(session.find!.matches).toHaveLength(4);
    expect(session.find!.matches[session.find!.active]).toEqual({ from: before.from + 5, to: before.to + 5 });
  });

  it("replaceActive replaces one match and advances to the next (editing mode)", () => {
    session.setFind("cat");
    const next = session.replaceActive("kitten");
    expect(session.ytext.toString()).toBe("The kitten sat. The cat ran. A dog barked at the cat.");
    expect(session.find!.matches).toHaveLength(2);
    expect(next).toEqual(session.find!.matches[0]);
    expect(session.ytext.toString().slice(next!.from, next!.to)).toBe("cat");
    expect(next!.from).toBe("The kitten sat. The ".length);

    // Replacing the last match wraps the active index back to the first remaining one.
    session.stepFind(1);
    session.replaceActive("kitten");
    expect(session.ytext.toString()).toBe("The kitten sat. The cat ran. A dog barked at the kitten.");
    expect(session.find!.active).toBe(0);
    expect(session.canUndo).toBe(true);
  });

  it("replaceAll replaces every match as one undoable step (editing mode)", () => {
    session.setFind("the", { ...DEFAULT_FIND_OPTIONS, wholeWord: true });
    expect(session.find!.matches).toHaveLength(3);
    expect(session.replaceAll("a")).toBe(3);
    expect(session.ytext.toString()).toBe("a cat sat. a cat ran. A dog barked at a cat.");
    expect(session.find!.matches).toEqual([]);
    expect(session.find!.active).toBe(-1);
    session.undo();
    expect(session.ytext.toString()).toBe(TEXT);
    expect(session.find!.matches).toHaveLength(3);
  });

  it("expands regex groups in replacements", () => {
    session.setFind("(c)(at)", { ...DEFAULT_FIND_OPTIONS, regex: true });
    session.replaceAll("$2$1");
    expect(session.ytext.toString()).toBe("The atc sat. The atc ran. A dog barked at the atc.");
  });

  it("replaceAll in suggesting mode produces tracked changes instead of edits", () => {
    session.setMode("suggesting");
    session.setFind("cat");
    expect(session.replaceAll("dog")).toBe(3);
    // The original text is kept (marked deleted) and the replacement inserted as a suggestion.
    expect(session.suggestions.cleanText()).toBe(TEXT);
    expect(session.ytext.toString()).toBe("The dogcat sat. The dogcat ran. A dog barked at the dogcat.");
    const list = session.suggestions.list();
    expect(list).toHaveLength(6);
    expect(list.filter((s) => s.type === "insert").map((s) => s.text)).toEqual(["dog", "dog", "dog"]);
    expect(list.filter((s) => s.type === "delete").map((s) => s.text)).toEqual(["cat", "cat", "cat"]);
    expect(list.every((s) => s.authorId === "a")).toBe(true);
    // The search still sees the (pending-deletion) originals.
    expect(session.find!.matches).toHaveLength(3);
  });

  it("replaceActive in suggesting mode advances past the suggested pair", () => {
    session.setMode("suggesting");
    session.setFind("cat");
    const next = session.replaceActive("dog");
    expect(session.ytext.toString()).toBe("The dogcat sat. The cat ran. A dog barked at the cat.");
    expect(next).toEqual({ from: "The dogcat sat. The ".length, to: "The dogcat sat. The cat".length });
    expect(session.find!.active).toBe(1);
  });

  it("refuses to replace when the user cannot edit", () => {
    const viewer = makeSession("viewer");
    try {
      viewer.setFind("cat");
      expect(viewer.find!.matches).toHaveLength(3);
      expect(viewer.replaceActive("x")).toBeNull();
      expect(viewer.replaceAll("x")).toBe(0);
      expect(viewer.ytext.toString()).toBe(TEXT);
    } finally {
      viewer.destroy();
    }
  });
});
