import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

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

import { DecidedSuggestionEditError, type CommentReply, type CommentThread } from "./comments";
import { CollabSession } from "./session";
import { makeCollabUser } from "./shared";

const TEXT = "The quick brown fox jumps.";
const alice = makeCollabUser("alice", "Alice");
const bob = makeCollabUser("bob", "Bob");

function rootState(thread: CommentThread) {
  return {
    anchor: thread.anchor,
    quote: thread.quote,
    suggestionState: thread.suggestionState,
    suggestionBy: thread.suggestionBy,
    suggestionAt: thread.suggestionAt,
    suggestionQuote: thread.suggestionQuote,
    resolved: thread.resolved,
    resolvedBy: thread.resolvedBy,
    resolvedAt: thread.resolvedAt,
  };
}

function rootMetadata(value: CommentThread | ReturnType<typeof rootState>) {
  const state = "body" in value ? rootState(value) : value;
  return {
    quote: state.quote,
    suggestionState: state.suggestionState,
    suggestionBy: state.suggestionBy,
    suggestionAt: state.suggestionAt,
    suggestionQuote: state.suggestionQuote,
    resolved: state.resolved,
    resolvedBy: state.resolvedBy,
    resolvedAt: state.resolvedAt,
  };
}

function replyState(reply: CommentReply) {
  return {
    suggestionState: reply.suggestionState,
    suggestionBy: reply.suggestionBy,
    suggestionAt: reply.suggestionAt,
    suggestionQuote: reply.suggestionQuote,
  };
}

describe("CollabSession accepted comment suggestion undo", () => {
  let session: CollabSession | null = null;

  function open(user = bob) {
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    return session;
  }

  function setup() {
    const current = open();
    current.ytext.insert(0, TEXT);
    return current;
  }

  function reload(user = bob) {
    const update = Y.encodeStateAsUpdate(session!.ydoc);
    session!.destroy();
    const current = open(user);
    Y.applyUpdate(current.ydoc, update);
    return current;
  }

  function durableTransitions(current: CollabSession) {
    return current.ydoc.getMap("commentSuggestionTransitions");
  }

  function applyRemoteTextEdit(current: CollabSession, from: number, to: number, text: string) {
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(current.ydoc));
    const currentState = Y.encodeStateVector(current.ydoc);
    const remoteText = remote.getText("content");
    remoteText.delete(from, to - from);
    remoteText.insert(from, text);
    Y.applyUpdate(current.ydoc, Y.encodeStateAsUpdate(remote, currentState));
    remote.destroy();
  }

  function assertCurrentText(current: CollabSession, threadId: string, expected: string) {
    const thread = current.comments.get(threadId)!;
    expect(thread.range).not.toBeNull();
    expect(current.ytext.toString().slice(thread.range!.from, thread.range!.to)).toBe(expected);
  }

  afterEach(() => {
    session?.destroy();
    session = null;
  });

  it("reconstructs root Undo and Redo across repeated serialized Y.Doc reloads", () => {
    let current = setup();
    const body = "Tighten this.\n\n```suggestion\nslow red\n```";
    const threadId = current.comments.add({ from: 4, to: 15, body, author: alice });
    current.comments.setResolved(threadId, true, alice);
    const before = rootState(current.comments.get(threadId)!);
    const textBefore = current.ytext.toString();

    expect(current.acceptCommentSuggestion(threadId, "slow red")).toBe(true);
    const accepted = rootState(current.comments.get(threadId)!);
    const acceptedAt = accepted.suggestionAt;
    expect(durableTransitions(current).size).toBe(1);

    current = reload();
    expect(current.undoManager.undoStack).toHaveLength(0);
    expect(current.canUndo).toBe(true);
    expect(current.canRedo).toBe(false);
    current.undo();
    expect(current.ytext.toString()).toBe(textBefore);
    expect(rootMetadata(current.comments.get(threadId)!)).toEqual(rootMetadata(before));
    assertCurrentText(current, threadId, "quick brown");
    expect(current.canRedo).toBe(true);

    current = reload();
    expect(current.canRedo).toBe(true);
    current.redo();
    expect(current.ytext.toString()).toBe("The slow red fox jumps.");
    expect(rootMetadata(current.comments.get(threadId)!)).toEqual(rootMetadata(accepted));
    expect(current.comments.get(threadId)?.suggestionAt).toBe(acceptedAt);
    assertCurrentText(current, threadId, "slow red");

    current = reload();
    expect(current.canUndo).toBe(true);
    current.undo();
    expect(current.ytext.toString()).toBe(textBefore);
    expect(rootMetadata(current.comments.get(threadId)!)).toEqual(rootMetadata(before));
    expect(current.canRedo).toBe(true);
  });

  it("reconstructs reply Redo after normal Undo and preserves sibling decisions across reloads", () => {
    let current = setup();
    const threadId = current.comments.add({ from: 4, to: 15, body: "Could this be clearer?", author: alice });
    const targetId = current.comments.reply(threadId, "Yes.\n\n```suggestion\nslow red\n```", alice)!;
    const siblingId = current.comments.reply(threadId, "Another option.\n\n```suggestion\nswift auburn\n```", alice)!;
    expect(current.comments.rejectReplySuggestion(threadId, siblingId, alice)).toBe(true);
    const before = current.comments.get(threadId)!;
    const beforeRoot = rootState(before);
    const beforeTarget = replyState(before.replies.find((reply) => reply.id === targetId)!);
    const siblingDecision = replyState(before.replies.find((reply) => reply.id === siblingId)!);

    expect(current.acceptCommentSuggestion(threadId, "slow red", targetId)).toBe(true);
    const accepted = current.comments.get(threadId)!;
    const acceptedRoot = rootState(accepted);
    const acceptedTarget = replyState(accepted.replies.find((reply) => reply.id === targetId)!);
    current.undo();
    expect(current.ytext.toString()).toBe(TEXT);

    current = reload();
    expect(current.undoManager.redoStack).toHaveLength(0);
    expect(current.canRedo).toBe(true);
    current.redo();
    expect(current.ytext.toString()).toBe("The slow red fox jumps.");
    expect(rootMetadata(current.comments.get(threadId)!)).toEqual(rootMetadata(acceptedRoot));
    expect(replyState(current.comments.get(threadId)!.replies.find((reply) => reply.id === targetId)!)).toEqual(acceptedTarget);
    expect(replyState(current.comments.get(threadId)!.replies.find((reply) => reply.id === siblingId)!)).toEqual(siblingDecision);
    assertCurrentText(current, threadId, "slow red");

    current = reload();
    expect(current.canUndo).toBe(true);
    current.undo();
    const undone = current.comments.get(threadId)!;
    expect(current.ytext.toString()).toBe(TEXT);
    expect(rootMetadata(undone)).toEqual(rootMetadata(beforeRoot));
    expect(replyState(undone.replies.find((reply) => reply.id === targetId)!)).toEqual(beforeTarget);
    expect(replyState(undone.replies.find((reply) => reply.id === siblingId)!)).toEqual(siblingDecision);

    current = reload();
    expect(current.canRedo).toBe(true);
    current.redo();
    expect(replyState(current.comments.get(threadId)!.replies.find((reply) => reply.id === targetId)!)).toEqual(acceptedTarget);
  });

  it("invalidates a reconstructed action without changing text or decisions when remote text is stale", () => {
    let current = setup();
    const threadId = current.comments.add({
      from: 4,
      to: 15,
      body: "Tighten this.\n\n```suggestion\nslow red\n```",
      author: alice,
    });
    expect(current.acceptCommentSuggestion(threadId, "slow red")).toBe(true);
    current = reload();
    applyRemoteTextEdit(current, 4, 12, "stale");
    const text = current.ytext.toString();
    const comment = rootState(current.comments.get(threadId)!);

    expect(current.canUndo).toBe(false);
    expect(durableTransitions(current).size).toBe(0);
    current.undo();
    expect(current.ytext.toString()).toBe(text);
    expect(rootState(current.comments.get(threadId)!)).toEqual(comment);
  });

  it("invalidates a transient suggestion Undo before it can overwrite remotely edited text", () => {
    const current = setup();
    const threadId = current.comments.add({
      from: 4,
      to: 15,
      body: "Tighten this.\n\n```suggestion\nslow red\n```",
      author: alice,
    });
    expect(current.acceptCommentSuggestion(threadId, "slow red")).toBe(true);
    applyRemoteTextEdit(current, 4, 12, "stale");
    const text = current.ytext.toString();
    const comment = rootState(current.comments.get(threadId)!);

    expect(current.canUndo).toBe(false);
    current.undo();
    expect(current.ytext.toString()).toBe(text);
    expect(rootState(current.comments.get(threadId)!)).toEqual(comment);
    expect(durableTransitions(current).size).toBe(0);
  });

  it("invalidates a reconstructed root action when its resolution snapshot changed", () => {
    let current = setup();
    const threadId = current.comments.add({
      from: 4,
      to: 15,
      body: "Tighten this.\n\n```suggestion\nslow red\n```",
      author: alice,
    });
    expect(current.acceptCommentSuggestion(threadId, "slow red")).toBe(true);
    current = reload();
    current.comments.setResolved(threadId, false, alice);
    const text = current.ytext.toString();

    expect(current.canUndo).toBe(false);
    current.undo();
    expect(current.ytext.toString()).toBe(text);
    expect(current.comments.get(threadId)?.suggestionState).toBe("accepted");
    expect(current.comments.get(threadId)?.resolved).toBe(false);
  });

  it("invalidates reconstructed Redo after a new local edit", () => {
    let current = setup();
    const threadId = current.comments.add({ from: 4, to: 15, body: "Could this be clearer?", author: alice });
    const replyId = current.comments.reply(threadId, "Yes.\n\n```suggestion\nslow red\n```", alice)!;
    expect(current.acceptCommentSuggestion(threadId, "slow red", replyId)).toBe(true);
    current = reload();
    current.undo();
    expect(current.canRedo).toBe(true);

    current.replaceSource([{ from: TEXT.length, to: TEXT.length, text: "!" }]);
    expect(current.ytext.toString()).toBe(`${TEXT}!`);
    expect(current.canRedo).toBe(false);
    expect(durableTransitions(current).size).toBe(0);
  });

  it.each(["root", "reply"] as const)("invalidates reconstructed Redo when the pending %s suggestion is edited", (target) => {
    let current = setup();
    const originalBody = "Tighten this.\n\n```suggestion\nslow red\n```";
    const editedBody = "Tighten this differently.\n\n```suggestion\nswift auburn\n```";
    const threadId = current.comments.add({
      from: 4,
      to: 15,
      body: target === "root" ? originalBody : "Could this be clearer?",
      author: alice,
    });
    const replyId = target === "reply" ? current.comments.reply(threadId, originalBody, alice)! : undefined;
    expect(current.acceptCommentSuggestion(threadId, "slow red", replyId)).toBe(true);
    current = reload();
    current.undo();
    expect(current.canRedo).toBe(true);

    current.comments.editBody(threadId, editedBody, replyId);
    expect(current.canRedo).toBe(false);
    expect(durableTransitions(current).size).toBe(0);
    current.redo();
    expect(current.ytext.toString()).toBe(TEXT);
    expect(replyId ? current.comments.get(threadId)?.replies[0].suggestionState : current.comments.get(threadId)?.suggestionState).not.toBe("accepted");
  });

  it("replays an older durable suggestion before redoing a newer session-local edit", () => {
    let current = setup();
    const threadId = current.comments.add({
      from: 4,
      to: 15,
      body: "Tighten this.\n\n```suggestion\nslow red\n```",
      author: alice,
    });
    expect(current.acceptCommentSuggestion(threadId, "slow red")).toBe(true);
    current = reload();
    current.replaceSource([{ from: current.ytext.length, to: current.ytext.length, text: "!" }]);

    current.undo();
    expect(current.ytext.toString()).toBe("The slow red fox jumps.");
    current.undo();
    expect(current.ytext.toString()).toBe(TEXT);

    current.redo();
    expect(current.ytext.toString()).toBe("The slow red fox jumps.");
    expect(current.comments.get(threadId)?.suggestionState).toBe("accepted");
    current.redo();
    expect(current.ytext.toString()).toBe("The slow red fox jumps.!");
  });

  it("preserves transient Redo order when an earlier edit predates the accepted suggestion", () => {
    const current = setup();
    current.replaceSource([{ from: current.ytext.length, to: current.ytext.length, text: "!" }]);
    const threadId = current.comments.add({
      from: 4,
      to: 15,
      body: "Tighten this.\n\n```suggestion\nslow red\n```",
      author: alice,
    });
    expect(current.acceptCommentSuggestion(threadId, "slow red")).toBe(true);

    current.undo();
    expect(current.ytext.toString()).toBe(`${TEXT}!`);
    current.undo();
    expect(current.ytext.toString()).toBe(TEXT);

    current.redo();
    expect(current.ytext.toString()).toBe(`${TEXT}!`);
    expect(current.comments.get(threadId)?.suggestionState).toBeNull();
    current.redo();
    expect(current.ytext.toString()).toBe("The slow red fox jumps.!");
    expect(current.comments.get(threadId)?.suggestionState).toBe("accepted");
  });

  it("defers suggestion validation until a prerequisite transient edit has been redone", () => {
    const current = setup();
    current.replaceSource([{ from: 4, to: 9, text: "brisk" }]);
    const threadId = current.comments.add({
      from: 4,
      to: 15,
      body: "Tighten this.\n\n```suggestion\nslow red\n```",
      author: alice,
    });
    expect(current.acceptCommentSuggestion(threadId, "slow red")).toBe(true);

    current.undo();
    expect(current.ytext.toString()).toBe("The brisk brown fox jumps.");
    current.undo();
    expect(current.ytext.toString()).toBe(TEXT);

    expect(current.canRedo).toBe(true);
    current.redo();
    expect(current.ytext.toString()).toBe("The brisk brown fox jumps.");
    expect(current.comments.get(threadId)?.suggestionState).toBeNull();
    current.redo();
    expect(current.ytext.toString()).toBe("The slow red fox jumps.");
    expect(current.comments.get(threadId)?.suggestionState).toBe("accepted");
  });

  it("refuses an acceptance from a stale render after the suggestion body changes", () => {
    const current = setup();
    const threadId = current.comments.add({
      from: 4,
      to: 15,
      body: "Tighten this.\n\n```suggestion\nslow red\n```",
      author: alice,
    });
    current.comments.editBody(threadId, "Tighten this differently.\n\n```suggestion\nswift auburn\n```");

    expect(current.acceptCommentSuggestion(threadId, "slow red")).toBe(false);
    expect(current.ytext.toString()).toBe(TEXT);
    expect(current.comments.get(threadId)?.suggestionState).toBeNull();
    expect(durableTransitions(current).size).toBe(0);
  });

  it("does not expose another actor's durable suggestion history", () => {
    const current = setup();
    const threadId = current.comments.add({
      from: 4,
      to: 15,
      body: "Tighten this.\n\n```suggestion\nslow red\n```",
      author: alice,
    });
    expect(current.acceptCommentSuggestion(threadId, "slow red")).toBe(true);
    const text = current.ytext.toString();
    const accepted = rootState(current.comments.get(threadId)!);
    const otherUser = reload(alice);

    expect(durableTransitions(otherUser).size).toBe(1);
    expect(otherUser.canUndo).toBe(false);
    expect(otherUser.canRedo).toBe(false);
    otherUser.undo();
    expect(otherUser.ytext.toString()).toBe(text);
    expect(rootState(otherUser.comments.get(threadId)!)).toEqual(accepted);
  });

  it("undoes and redoes root text, decision, anchor, quote, and the prior resolved state as one step", () => {
    const current = setup();
    const body = "Tighten this.\n\n```suggestion\nslow red\n```";
    const threadId = current.comments.add({ from: 4, to: 15, body, author: alice });
    const pendingReplyId = current.comments.reply(threadId, "Another option.\n\n```suggestion\nswift auburn\n```", alice)!;
    current.comments.setResolved(threadId, true, alice);
    current.replaceSource([{ from: TEXT.length, to: TEXT.length, text: "!" }]);
    const before = rootState(current.comments.get(threadId)!);
    const textBefore = current.ytext.toString();
    const undoStackLengthBefore = current.undoManager.undoStack.length;
    const undoStackItemBefore = current.undoManager.undoStack.at(-1);

    expect(current.acceptCommentSuggestion(threadId, "slow red")).toBe(true);
    expect(current.undoManager.undoStack).toHaveLength(undoStackLengthBefore + 1);
    expect(current.undoManager.undoStack.at(-1)).not.toBe(undoStackItemBefore);
    expect(current.ytext.toString()).toBe("The slow red fox jumps.!");
    const accepted = rootState(current.comments.get(threadId)!);
    expect(accepted).toMatchObject({
      quote: "slow red",
      suggestionState: "accepted",
      suggestionBy: bob.id,
      suggestionQuote: "quick brown",
      resolved: true,
      resolvedBy: bob.id,
    });
    expect(() => current.comments.editBody(threadId, body)).toThrow(DecidedSuggestionEditError);

    current.undo();
    const undone = current.comments.get(threadId)!;
    expect(current.ytext.toString()).toBe(textBefore);
    expect(rootState(undone)).toEqual(before);
    expect(undone.replies.find((reply) => reply.id === pendingReplyId)?.suggestionState).toBeUndefined();
    expect(() => current.comments.editBody(threadId, body)).not.toThrow();

    current.redo();
    expect(current.ytext.toString()).toBe("The slow red fox jumps.!");
    expect(rootState(current.comments.get(threadId)!)).toEqual(accepted);
    expect(() => current.comments.editBody(threadId, body)).toThrow(DecidedSuggestionEditError);
  });

  it("undoes and redoes only the accepted reply decision while preserving a rejected sibling", () => {
    const current = setup();
    const threadId = current.comments.add({ from: 4, to: 15, body: "Could this be clearer?", author: alice });
    const targetBody = "Yes.\n\n```suggestion\nslow red\n```";
    const targetId = current.comments.reply(threadId, targetBody, alice)!;
    const siblingBody = "Another option.\n\n```suggestion\nswift auburn\n```";
    const siblingId = current.comments.reply(threadId, siblingBody, alice)!;
    expect(current.comments.rejectReplySuggestion(threadId, siblingId, alice)).toBe(true);
    current.replaceSource([{ from: TEXT.length, to: TEXT.length, text: "!" }]);
    const before = current.comments.get(threadId)!;
    const beforeTarget = replyState(before.replies.find((reply) => reply.id === targetId)!);
    const siblingDecision = replyState(before.replies.find((reply) => reply.id === siblingId)!);
    const textBefore = current.ytext.toString();
    const undoStackLengthBefore = current.undoManager.undoStack.length;
    const undoStackItemBefore = current.undoManager.undoStack.at(-1);

    expect(current.acceptCommentSuggestion(threadId, "slow red", targetId)).toBe(true);
    expect(current.undoManager.undoStack).toHaveLength(undoStackLengthBefore + 1);
    expect(current.undoManager.undoStack.at(-1)).not.toBe(undoStackItemBefore);
    expect(current.ytext.toString()).toBe("The slow red fox jumps.!");
    const accepted = current.comments.get(threadId)!;
    const acceptedTarget = replyState(accepted.replies.find((reply) => reply.id === targetId)!);
    expect(acceptedTarget).toMatchObject({
      suggestionState: "accepted",
      suggestionBy: bob.id,
      suggestionQuote: "quick brown",
    });
    expect(replyState(accepted.replies.find((reply) => reply.id === siblingId)!)).toEqual(siblingDecision);
    expect(() => current.comments.editBody(threadId, targetBody, targetId)).toThrow(DecidedSuggestionEditError);

    current.undo();
    const undone = current.comments.get(threadId)!;
    expect(current.ytext.toString()).toBe(textBefore);
    expect(undone.anchor).toEqual(before.anchor);
    expect(undone.quote).toBe(before.quote);
    expect(replyState(undone.replies.find((reply) => reply.id === targetId)!)).toEqual(beforeTarget);
    expect(replyState(undone.replies.find((reply) => reply.id === siblingId)!)).toEqual(siblingDecision);
    expect(() => current.comments.editBody(threadId, targetBody, targetId)).not.toThrow();
    expect(() => current.comments.editBody(threadId, siblingBody, siblingId)).toThrow(DecidedSuggestionEditError);

    current.redo();
    const redone = current.comments.get(threadId)!;
    expect(current.ytext.toString()).toBe("The slow red fox jumps.!");
    expect(redone.anchor).toEqual(accepted.anchor);
    expect(redone.quote).toBe(accepted.quote);
    expect(replyState(redone.replies.find((reply) => reply.id === targetId)!)).toEqual(acceptedTarget);
    expect(replyState(redone.replies.find((reply) => reply.id === siblingId)!)).toEqual(siblingDecision);
  });

  it.each(["root", "reply"] as const)("rejects an identical %s suggestion without touching prior undo history", (target) => {
    const current = setup();
    current.replaceSource([{ from: TEXT.length, to: TEXT.length, text: "!" }]);
    const undoStackItem = current.undoManager.undoStack.at(-1)!;
    const undoStackMetaSize = undoStackItem.meta.size;
    const body = "Keep this wording.\n\n```suggestion\nquick brown\n```";
    const threadId = current.comments.add({
      from: 4,
      to: 15,
      body: target === "root" ? body : "Could this be clearer?",
      author: alice,
    });
    const replyId = target === "reply" ? current.comments.reply(threadId, body, alice)! : undefined;

    expect(current.acceptCommentSuggestion(threadId, "quick brown", replyId)).toBe(false);
    expect(current.ytext.toString()).toBe(`${TEXT}!`);
    expect(current.undoManager.undoStack).toEqual([undoStackItem]);
    expect(undoStackItem.meta.size).toBe(undoStackMetaSize);
    expect(durableTransitions(current).size).toBe(0);
    const pending = current.comments.get(threadId)!;
    if (replyId) {
      expect(pending.replies.find((reply) => reply.id === replyId)?.suggestionState).toBeUndefined();
    } else {
      expect(pending.suggestionState).toBeNull();
    }

    current.undo();
    expect(current.ytext.toString()).toBe(TEXT);
    const afterUndo = current.comments.get(threadId)!;
    if (replyId) {
      expect(afterUndo.replies.find((reply) => reply.id === replyId)?.suggestionState).toBeUndefined();
    } else {
      expect(afterUndo.suggestionState).toBeNull();
    }
  });
});
