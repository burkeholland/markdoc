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

// Counts how often an anchor is turned back into offsets, to show what a remote edit costs.
const resolves = vi.hoisted(() => ({ count: 0 }));
vi.mock("./shared", async (original) => {
  const shared = await original<typeof import("./shared")>();
  return {
    ...shared,
    resolveAnchor: (...args: Parameters<typeof shared.resolveAnchor>) => {
      resolves.count++;
      return shared.resolveAnchor(...args);
    },
  };
});

import { CollabSession } from "./session";
import { makeCollabUser } from "./shared";

const TEXT = "# Title\n\nIntro text.\n\nTarget paragraph.\n\nAfter text.\n";
const FROM = TEXT.indexOf("Target");
const TO = FROM + "Target".length;
const alice = makeCollabUser("alice", "Alice");

describe("CollabSession pending comment under edits (#2258)", () => {
  let session: CollabSession;

  beforeEach(() => {
    session = new CollabSession({ docId: "doc", user: alice, role: "owner", getToken: async () => "token", autoConnect: false });
    session.keepAlive();
    session.ytext.insert(0, TEXT);
    Object.defineProperty(session, "contentReady", { configurable: true, get: () => true });
    resolves.count = 0;
  });
  afterEach(() => {
    session.destroy();
  });

  /** An edit made by someone else: it arrives as an update, the way the socket delivers it. */
  function remoteEdit(from: number, to: number, insert = "") {
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(session.ydoc));
    const known = Y.encodeStateVector(session.ydoc);
    const text = remote.getText("content");
    if (to > from) text.delete(from, to - from);
    if (insert) text.insert(from, insert);
    Y.applyUpdate(session.ydoc, Y.encodeStateAsUpdate(remote, known));
    remote.destroy();
  }
  /** One's own typing in the rich pane: a local transaction made by the binding. */
  function localEdit(from: number, to: number, insert = "") {
    session.ydoc.transact(() => {
      if (to > from) session.ytext.delete(from, to - from);
      if (insert) session.ytext.insert(from, insert);
    }, session.binding);
  }
  const pendingText = () => {
    const pending = session.pendingComment!;
    return session.ytext.toString().slice(pending.from, pending.to);
  };
  const startOnTarget = () => session.setPendingComment({ from: FROM, to: TO });

  it("holds the range it was given, in the same shape, and null clears it", () => {
    expect(session.pendingComment).toBeNull();
    startOnTarget();
    expect(session.pendingComment).toEqual({ from: FROM, to: TO });
    expect(pendingText()).toBe("Target");
    session.setPendingComment(null);
    expect(session.pendingComment).toBeNull();
  });

  describe.each([
    ["a collaborator's", remoteEdit],
    ["one's own", localEdit],
  ] as const)("%s edit", (_who, edit) => {
    it("typed before the selection moves the range with the text", () => {
      startOnTarget();
      edit(7, 7, " wwww");
      expect(session.pendingComment).toEqual({ from: FROM + 5, to: TO + 5 });
      expect(pendingText()).toBe("Target");
      for (let i = 0; i < 40; i++) edit(7, 7, "w");
      expect(session.pendingComment).toEqual({ from: FROM + 45, to: TO + 45 });
      expect(pendingText()).toBe("Target");
    });

    it("typed right before the first selected character stays outside the range", () => {
      startOnTarget();
      edit(FROM, FROM, "Not ");
      expect(session.pendingComment).toEqual({ from: FROM + 4, to: TO + 4 });
      expect(pendingText()).toBe("Target");
    });

    it("typed right after the last selected character stays outside the range", () => {
      startOnTarget();
      edit(TO, TO, "ed");
      expect(session.pendingComment).toEqual({ from: FROM, to: TO });
      expect(pendingText()).toBe("Target");
    });

    it("typed after the selection leaves the range alone", () => {
      startOnTarget();
      const before = session.pendingComment;
      edit(TO + 3, TO + 3, "wwww");
      expect(session.pendingComment).toEqual({ from: FROM, to: TO });
      expect(session.pendingComment, "the same object while the range has not moved").toBe(before);
      expect(pendingText()).toBe("Target");
    });

    it("typed inside the selection grows the range around it", () => {
      startOnTarget();
      edit(FROM + 3, FROM + 3, "--");
      expect(session.pendingComment).toEqual({ from: FROM, to: TO + 2 });
      expect(pendingText()).toBe("Tar--get");
    });

    it("deleted before the selection moves the range with the text", () => {
      startOnTarget();
      edit(9, 15, "");
      expect(session.pendingComment).toEqual({ from: FROM - 6, to: TO - 6 });
      expect(pendingText()).toBe("Target");
    });

    it("deleted across the start of the selection keeps what is left of it", () => {
      startOnTarget();
      edit(FROM - 4, FROM + 3, "");
      expect(session.pendingComment).toEqual({ from: FROM - 4, to: TO - 7 });
      expect(pendingText()).toBe("get");
    });

    it("deleted across the end of the selection keeps what is left of it", () => {
      startOnTarget();
      edit(FROM + 3, TO + 4, "");
      expect(session.pendingComment).toEqual({ from: FROM, to: FROM + 3 });
      expect(pendingText()).toBe("Tar");
    });

    it("deleted with everything selected leaves an empty range where the text was", () => {
      startOnTarget();
      edit(FROM - 2, TO + 2, "");
      expect(session.pendingComment).toEqual({ from: FROM - 2, to: FROM - 2 });
      expect(pendingText()).toBe("");
    });

    it("a replacement of the selected text (delete and type) leaves an empty range before the new text", () => {
      startOnTarget();
      edit(FROM, TO, "Aim");
      const pending = session.pendingComment!;
      expect(pending.to).toBe(pending.from);
      expect(session.ytext.toString().slice(pending.from, pending.from + 3)).toBe("Aim");
    });
  });

  it("follows a long run of remote typing and deleting before it, one key at a time", () => {
    startOnTarget();
    for (let i = 0; i < 300; i++) {
      remoteEdit(7, 7, "w");
      if (i % 7 === 0) expect(pendingText()).toBe("Target");
    }
    for (let i = 0; i < 300; i++) remoteEdit(7 + 299 - i, 7 + 300 - i, "");
    expect(session.pendingComment).toEqual({ from: FROM, to: TO });
    expect(pendingText()).toBe("Target");
  });

  it("is the range a comment posted at the same moment has, after every kind of edit", () => {
    const edits: [number, number, string][] = [
      [7, 7, " wwww"],
      [0, 2, ""],
      [FROM + 5, FROM + 5, "inside"],
      [FROM + 2, FROM + 2, "X"],
      [FROM - 1, FROM + 6, ""],
      [3, 3, "\n\nNew paragraph.\n\n"],
    ];
    startOnTarget();
    const posted = session.comments.add({ from: FROM, to: TO, body: "posted at the same moment", author: alice });
    for (const [from, to, insert] of edits) {
      remoteEdit(from, to, insert);
      expect(session.pendingComment, `after ${JSON.stringify([from, to, insert])}`).toEqual(session.comments.get(posted)!.range);
    }
  });

  it("posting with the current range stores the selected text as the quote and anchors the thread to it", () => {
    startOnTarget();
    remoteEdit(7, 7, " typed by a collaborator");
    const { from, to } = session.pendingComment!;
    const id = session.comments.add({ from, to, body: "on Target", author: alice });
    remoteEdit(7, 7, " and more");
    const thread = session.comments.get(id)!;
    expect(thread.quote).toBe("Target");
    expect(session.ytext.toString().slice(thread.range!.from, thread.range!.to)).toBe("Target");
  });

  it("a comment on the whole document stays at the start whatever is typed there", () => {
    session.setPendingComment({ from: 0, to: 0 });
    remoteEdit(0, 0, "Before everything. ");
    localEdit(0, 5, "");
    expect(session.pendingComment).toEqual({ from: 0, to: 0 });
  });

  it("tells its listeners when a remote edit has moved the range", async () => {
    startOnTarget();
    await Promise.resolve();
    const listener = vi.fn();
    session.subscribe(listener);
    remoteEdit(7, 7, "w");
    await Promise.resolve();
    expect(listener).toHaveBeenCalled();
    expect(session.pendingComment).toEqual({ from: FROM + 1, to: TO + 1 });
  });

  it("every comment that is started has an id of its own: edits keep it, another comment or the same text again gets a new one, none has null", () => {
    expect(session.pendingCommentId).toBeNull();
    startOnTarget();
    const first = session.pendingCommentId;
    expect(first).not.toBeNull();
    remoteEdit(7, 7, " wwww");
    expect(pendingText()).toBe("Target");
    expect(session.pendingCommentId, "an edit that moves the range leaves the comment the same one").toBe(first);

    const intro = session.ytext.toString().indexOf("Intro");
    session.setPendingComment({ from: intro, to: intro + 5 });
    const second = session.pendingCommentId;
    expect(second).not.toBeNull();
    expect(second, "a comment started on other text is another comment").not.toBe(first);

    session.setPendingComment(null);
    expect(session.pendingCommentId).toBeNull();
    session.setPendingComment({ from: intro, to: intro + 5 });
    expect(session.pendingCommentId, "started again after it was cancelled, it is a new comment").not.toBeNull();
    expect([first, second]).not.toContain(session.pendingCommentId);
  });

  it("hands out snapshots: a range that was read is never changed afterwards, and a moved range is a new object", () => {
    const given = { from: FROM, to: TO };
    session.setPendingComment(given);
    given.from = 0;
    given.to = 1;
    const before = session.pendingComment!;
    expect(before, "the caller's object is not kept").toEqual({ from: FROM, to: TO });

    remoteEdit(7, 7, " wwww");
    const after = session.pendingComment!;
    expect(after).toEqual({ from: FROM + 5, to: TO + 5 });
    expect(after, "a moved range is a new object").not.toBe(before);
    expect(before, "what a reader holds from before the edit is as it was").toEqual({ from: FROM, to: TO });
    expect(session.pendingComment, "the same object while the range does not move again").toBe(after);
  });

  it("a second comment started on other text replaces the first, and edits move the new one", () => {
    startOnTarget();
    const intro = TEXT.indexOf("Intro");
    session.setPendingComment({ from: intro, to: intro + 5 });
    remoteEdit(0, 0, "!!");
    expect(pendingText()).toBe("Intro");
  });

  it("undo of one's own earlier typing takes only that back: the collaborator's text stays and the range still holds the selected text", () => {
    session.undoManager.stopCapturing();
    localEdit(7, 7, " mine");
    session.undoManager.stopCapturing();
    session.setPendingComment({ from: FROM + 5, to: TO + 5 });
    remoteEdit(7, 7, " theirs");
    expect(pendingText()).toBe("Target");
    session.undo();
    expect(session.ytext.toString()).toBe(TEXT.replace("# Title", "# Title theirs"));
    expect(pendingText()).toBe("Target");
    session.redo();
    expect(session.ytext.toString()).toContain("# Title theirs mine");
    expect(pendingText()).toBe("Target");
  });

  it("starting a comment adds nothing to the undo history", () => {
    const before = session.undoManager.undoStack.length;
    startOnTarget();
    remoteEdit(7, 7, "w");
    void session.pendingComment;
    session.setPendingComment(null);
    expect(session.undoManager.undoStack.length).toBe(before);
  });

  describe("what a remote edit costs", () => {
    it("nothing is resolved while no comment is pending", () => {
      for (let i = 0; i < 50; i++) remoteEdit(7, 7, "w");
      expect(session.pendingComment).toBeNull();
      expect(resolves.count).toBe(0);
    });

    it("with a comment pending, an edit only marks the range: it is resolved once, when it is next read", () => {
      startOnTarget();
      for (let i = 0; i < 50; i++) remoteEdit(7, 7, "w");
      expect(resolves.count).toBe(0);
      expect(session.pendingComment).toEqual({ from: FROM + 50, to: TO + 50 });
      expect(resolves.count).toBe(1);
      void session.pendingComment;
      void session.pendingComment;
      expect(resolves.count).toBe(1);
    });

    it("after the comment is posted or cancelled, edits resolve nothing again", () => {
      startOnTarget();
      remoteEdit(7, 7, "w");
      void session.pendingComment;
      session.setPendingComment(null);
      resolves.count = 0;
      for (let i = 0; i < 50; i++) remoteEdit(7, 7, "w");
      void session.pendingComment;
      expect(resolves.count).toBe(0);
    });
  });
});
