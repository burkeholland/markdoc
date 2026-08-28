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

  function setup() {
    session = new CollabSession({
      docId: "doc",
      user: bob,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    session.ytext.insert(0, TEXT);
    return session;
  }

  afterEach(() => {
    session?.destroy();
    session = null;
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
