// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

vi.mock("@/lib/api", () => ({
  api: {
    documents: {
      collaborators: vi.fn().mockResolvedValue({ owner: null, collaborators: [], agents: [] }),
      reviews: vi.fn().mockResolvedValue({ reviews: [] }),
    },
  },
}));

vi.mock("@/lib/notifications-store", () => ({
  markRefsRead: vi.fn(),
  useUnreadRefs: () => new Set<string>(),
}));

import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { api } from "@/lib/api";
import type { ReviewDto } from "@/server/reviews";
import { CommentsPanel, isReviewOpen, type CommentsPanelProps } from "./comments-panel";

function reviewDto(id: string, threadIds: string[]): ReviewDto {
  return {
    id,
    documentId: "doc",
    authorId: "alice",
    authorName: "Copilot",
    collabAuthorId: "agent:alice:Copilot",
    agent: "Copilot",
    verdict: "request_changes",
    summary: `Review ${id}.`,
    threadIds,
    createdAt: new Date().toISOString(),
  };
}

describe("CommentsPanel", () => {
  let session: CollabSession | null = null;

  afterEach(() => {
    cleanup();
    session?.destroy();
    session = null;
    vi.restoreAllMocks();
  });

  it("uses the canonical session undo action and restores pending reply controls", async () => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    session.ytext.insert(0, "The quick brown fox jumps.");
    const threadId = session.comments.add({ from: 4, to: 15, body: "Could this be clearer?", author: user });
    session.comments.reply(threadId, "Try this.\n\n```suggestion\nslow red\n```", user);

    let action: Parameters<NonNullable<CommentsPanelProps["onToast"]>>[2];
    const onToast: NonNullable<CommentsPanelProps["onToast"]> = (_message, _kind, nextAction) => {
      action = nextAction;
    };
    const undo = vi.spyOn(session, "undo");
    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} onToast={onToast} />);
    const reply = () => document.querySelector<HTMLElement>('[data-testid="comment-reply"][data-reply-id]')!;

    fireEvent.click(screen.getByTestId("suggestion-accept-comment"));
    await waitFor(() => expect(session!.ytext.toString()).toBe("The slow red fox jumps."));
    expect(reply()).toHaveAttribute("data-state", "accepted");
    expect(action?.label).toBe("Undo");

    act(() => action?.onClick?.());
    expect(undo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(session!.ytext.toString()).toBe("The quick brown fox jumps."));
    expect(reply()).toHaveAttribute("data-state", "pending");
    expect(screen.getByTestId("suggestion-accept-comment")).toBeVisible();
    expect(screen.getByTestId("suggestion-reject-comment")).toBeVisible();
  });

  it.each(["root", "reply"] as const)("does not offer Undo for an identical %s suggestion", async (target) => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    const text = "The quick brown fox jumps.";
    session.ytext.insert(0, text);
    session.replaceSource([{ from: text.length, to: text.length, text: "!" }]);
    const undoStackItem = session.undoManager.undoStack.at(-1)!;
    const body = "Keep this wording.\n\n```suggestion\nquick brown\n```";
    const threadId = session.comments.add({
      from: 4,
      to: 15,
      body: target === "root" ? body : "Could this be clearer?",
      author: user,
    });
    const replyId = target === "reply" ? session.comments.reply(threadId, body, user)! : undefined;
    const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} onToast={onToast} />);

    fireEvent.click(screen.getByTestId("suggestion-accept-comment"));
    await waitFor(() => expect(onToast).toHaveBeenCalled());

    expect(onToast.mock.lastCall?.[1]).toBe("error");
    expect(onToast.mock.lastCall?.[2]).toBeUndefined();
    expect(session.undoManager.undoStack).toEqual([undoStackItem]);
    const pending = session.comments.get(threadId)!;
    if (replyId) {
      expect(pending.replies.find((reply) => reply.id === replyId)?.suggestionState).toBeUndefined();
    } else {
      expect(pending.suggestionState).toBeNull();
    }
  });

  it.each(["root", "reply"] as const)("renders a pending %s suggestion as the proposed text with no diff markup", (target) => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    session.ytext.insert(0, "The quick brown fox jumps.");
    const body = "Try this.\n\n```suggestion\nslow red\n```";
    const threadId = session.comments.add({ from: 4, to: 15, body: target === "root" ? body : "Could this be clearer?", author: user });
    if (target === "reply") session.comments.reply(threadId, body, user);

    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);

    const box = screen.getByTestId("suggestion-box");
    expect(box).toHaveAttribute("data-state", "pending");
    expect(screen.getByTestId("suggestion-text").textContent).toBe("slow red");
    expect(box.querySelectorAll("ins, del")).toHaveLength(0);
    expect(screen.queryByTestId("suggestion-deletes")).toBeNull();
    expect(screen.getByTestId("suggestion-accept-comment")).toBeEnabled();
    expect(screen.getByTestId("suggestion-reject-comment")).toBeEnabled();
  });

  it.each(["root", "reply"] as const)("renders an empty %s suggestion as 'Deletes the highlighted text'", (target) => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    session.ytext.insert(0, "The quick brown fox jumps.");
    const body = "Drop it.\n\n```suggestion\n```";
    const threadId = session.comments.add({ from: 4, to: 15, body: target === "root" ? body : "Is this needed?", author: user });
    if (target === "reply") session.comments.reply(threadId, body, user);

    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);

    const box = screen.getByTestId("suggestion-box");
    expect(box).toHaveAttribute("data-state", "pending");
    const deletes = screen.getByTestId("suggestion-deletes");
    expect(deletes).toHaveTextContent("Deletes the highlighted text");
    expect(screen.getByTestId("suggestion-text")).toContainElement(deletes);
    expect(screen.getByTestId("suggestion-text").textContent).toBe("Deletes the highlighted text");
    expect(box.querySelectorAll("ins, del")).toHaveLength(0);
  });

  it("uses one roving tab stop and activates tabs with arrow, Home, and End keys", async () => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} onAskAgent={() => {}} />);

    const tabs = screen.getAllByRole("tab");
    const open = screen.getByRole("tab", { name: "Open" });
    const resolved = screen.getByRole("tab", { name: "Resolved" });
    const suggestions = screen.getByRole("tab", { name: "Suggestions" });
    const tabpanel = screen.getByRole("tabpanel");

    expect(tabs.filter((item) => item.tabIndex === 0)).toEqual([open]);
    expect(resolved).toHaveAttribute("tabindex", "-1");
    expect(suggestions).toHaveAttribute("tabindex", "-1");

    open.focus();
    fireEvent.keyDown(open, { key: "ArrowLeft" });
    expect(suggestions).toHaveFocus();
    expect(suggestions).toHaveAttribute("aria-selected", "true");
    expect(suggestions).toHaveAttribute("tabindex", "0");
    expect(open).toHaveAttribute("tabindex", "-1");
    expect(tabpanel).toHaveAttribute("aria-labelledby", "comments-tab-suggestions");

    fireEvent.keyDown(suggestions, { key: "ArrowRight" });
    expect(open).toHaveFocus();
    expect(open).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(open, { key: "End" });
    expect(suggestions).toHaveFocus();
    fireEvent.keyDown(suggestions, { key: "Home" });
    expect(open).toHaveFocus();

    await userEvent.setup().tab();
    expect(screen.getByTestId("comments-empty-ask-agent-button")).toHaveFocus();
  });

  it("tones resolved card backgrounds without dimming their metadata", () => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    session.ytext.insert(0, "The quick brown fox jumps.");
    const threadId = session.comments.add({ from: 4, to: 15, body: "@bob This is resolved.", author: user });
    session.comments.reply(threadId, "Thanks.", user);
    session.comments.setResolved(threadId, true, user);

    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} focusTab={{ tab: "resolved", nonce: 1 }} />);

    const thread = screen.getByTestId("comment-thread");
    expect(thread).toHaveClass("bg-surface/80");
    expect(thread).not.toHaveClass("opacity-80");
    expect(screen.getAllByTestId("comment-timestamp")).toHaveLength(2);
    expect(screen.getByTestId("comment-resolved-state")).toHaveTextContent("Resolved");
    expect(screen.getByTestId("mention-chip")).toHaveTextContent("@bob");
  });

  it("moves focus to the selected tab only when opening focus is requested", async () => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();

    const Harness = ({ open, focusOnMount = false }: { open: boolean; focusOnMount?: boolean }) => (
      <>
        <button type="button">Editor control</button>
        {open && <CommentsPanel session={session!} onClose={() => {}} onReveal={() => {}} focusOnMount={focusOnMount} />}
      </>
    );
    const view = render(<Harness open={false} />);
    const editorControl = screen.getByRole("button", { name: "Editor control" });

    editorControl.focus();
    view.rerender(<Harness open />);
    expect(editorControl).toHaveFocus();

    view.rerender(<Harness open={false} />);
    editorControl.focus();
    view.rerender(<Harness open focusOnMount />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Open" })).toHaveFocus());
  });

  it("keeps a review in Open until every suggestion is decided and every thread resolved; Resolve all clears it", async () => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    const text = "The quick brown fox jumps over the lazy dog. The end is near.";
    session.ytext.insert(0, text);
    const agent = makeCollabUser("agent:alice:Copilot", "Copilot");
    const suggest = (quote: string, proposed: string) =>
      session!.comments.add({ from: text.indexOf(quote), to: text.indexOf(quote) + quote.length, body: `Tighter.\n\n\`\`\`suggestion\n${proposed}\n\`\`\``, author: agent });
    const pendingIds = [suggest("quick", "fast"), suggest("brown", "red"), suggest("lazy", "sleepy")];
    // A second review whose only thread is already resolved, and a third whose thread was deleted.
    const resolvedId = session.comments.add({ from: text.indexOf("The end"), to: text.indexOf("The end") + 7, body: "Good close.", author: agent });
    session.comments.setResolved(resolvedId, true, user);
    const deletedId = session.comments.add({ from: 0, to: 3, body: "Gone soon.", author: agent });
    session.comments.remove(deletedId);
    const reviews = [reviewDto("r-pending", pendingIds), reviewDto("r-resolved", [resolvedId]), reviewDto("r-deleted", [deletedId])];
    vi.mocked(api.documents.reviews).mockResolvedValue({ reviews } as Awaited<ReturnType<typeof api.documents.reviews>>);

    const threads = () => session!.comments.list();
    expect(isReviewOpen(reviews[0], threads(), text)).toBe(true);
    expect(isReviewOpen(reviews[1], threads(), text)).toBe(false);
    expect(isReviewOpen(reviews[2], threads(), text)).toBe(false);

    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} onToast={() => {}} />);
    const cards = () => screen.queryAllByTestId("review-card").map((card) => card.getAttribute("data-review-id"));
    await waitFor(() => expect(cards()).toEqual(["r-pending"]));
    expect(screen.getByRole("tab", { name: /Open/ })).toHaveAttribute("aria-selected", "true");

    // Reject all: the suggestions are decided but the threads stay open, so the card stays and offers Resolve all.
    fireEvent.click(screen.getByTestId("review-reject-all"));
    await waitFor(() => expect(screen.getByTestId("review-resolve-all")).toBeVisible());
    expect(screen.queryByTestId("review-accept-all")).toBeNull();
    expect(cards()).toEqual(["r-pending"]);
    expect(threads().filter((t) => pendingIds.includes(t.id)).every((t) => t.suggestionState === "rejected" && !t.resolved)).toBe(true);

    fireEvent.click(screen.getByTestId("review-resolve-all"));
    await waitFor(() => expect(cards()).toEqual([]));
    expect(threads().filter((t) => pendingIds.includes(t.id)).every((t) => t.resolved)).toBe(true);
    expect(isReviewOpen(reviews[0], threads(), text)).toBe(false);

    // Resolved lists the decided reviews first, then the resolved threads.
    fireEvent.click(screen.getByRole("tab", { name: /Resolved/ }));
    await waitFor(() => expect(cards()).toEqual(["r-pending", "r-resolved", "r-deleted"]));
    expect(screen.queryByTestId("review-accept-all")).toBeNull();
    expect(screen.queryByTestId("review-reject-all")).toBeNull();
    expect(screen.queryByTestId("review-resolve-all")).toBeNull();
    expect(screen.getAllByTestId("comment-thread")).toHaveLength(4);
  });

  it("accepting every suggestion of a review resolves its threads, so the card leaves Open at once", async () => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    const text = "The quick brown fox.";
    session.ytext.insert(0, text);
    const agent = makeCollabUser("agent:alice:Copilot", "Copilot");
    const a = session.comments.add({ from: 4, to: 9, body: "```suggestion\nfast\n```", author: agent });
    const b = session.comments.add({ from: 10, to: 15, body: "```suggestion\nred\n```", author: agent });
    const reviews = [reviewDto("r1", [a, b])];
    vi.mocked(api.documents.reviews).mockResolvedValue({ reviews } as Awaited<ReturnType<typeof api.documents.reviews>>);

    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} onToast={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("review-accept-all")).toBeVisible());
    fireEvent.click(screen.getByTestId("review-accept-all"));
    await waitFor(() => expect(session!.ytext.toString()).toBe("The fast red fox."));
    await waitFor(() => expect(screen.queryAllByTestId("review-card")).toHaveLength(0));
    expect(screen.queryByTestId("review-resolve-all")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Resolved/ }));
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(1));
  });

  describe("card reveal (#992)", () => {
    const mount = (opts: { removed?: boolean } = {}) => {
      // jsdom has no scrollIntoView; the active card scrolls itself into view with it.
      Element.prototype.scrollIntoView ??= () => {};
      const user = makeCollabUser("alice", "Alice");
      session = new CollabSession({ docId: "doc", user, role: "owner", getToken: async () => "token", autoConnect: false });
      session.keepAlive();
      session.ytext.insert(0, "Intro text. The quick brown fox jumps.");
      const threadId = session.comments.add({ from: 16, to: 27, body: "See [the docs](https://example.com) first.", author: user });
      // A thread whose Y.Map lost its anchor is what the UI renders as "(original text removed)".
      if (opts.removed) session.comments.ymap.get(threadId)!.delete("anchor");
      const onReveal = vi.fn<CommentsPanelProps["onReveal"]>();
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(<CommentsPanel session={session} onClose={() => {}} onReveal={onReveal} onToast={onToast} />);
      return { threadId, onReveal, onToast, card: screen.getByTestId("comment-thread") };
    };

    it("reveals the commented text and activates the thread when the card is clicked", () => {
      const { threadId, onReveal, onToast, card } = mount();
      expect(card).toHaveAttribute("tabindex", "0");
      expect(card).toHaveAccessibleName("Comment by Alice");
      fireEvent.click(card);
      expect(onReveal).toHaveBeenCalledWith(16);
      expect(session!.activeCommentId).toBe(threadId);
      expect(onToast).not.toHaveBeenCalled();
    });

    it("reveals from the quote line and the body, but not from controls inside the card", () => {
      const { onReveal, card } = mount();
      fireEvent.click(screen.getByTitle("quick brown"));
      expect(onReveal).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByText("See", { exact: false }));
      expect(onReveal).toHaveBeenCalledTimes(2);
      const link = card.querySelector("a")!;
      expect(link).toHaveAttribute("href", "https://example.com");
      fireEvent.click(link);
      fireEvent.click(screen.getByTestId("comment-reply"));
      expect(onReveal).toHaveBeenCalledTimes(2);
    });

    it.each(["{Enter}", " "])("reveals when %j is pressed on a focused card", async (key) => {
      const { threadId, onReveal, card } = mount();
      card.focus();
      expect(card).toHaveFocus();
      await userEvent.setup().keyboard(key);
      expect(onReveal).toHaveBeenCalledWith(16);
      expect(session!.activeCommentId).toBe(threadId);
    });

    it("keeps Enter and Space for controls inside the card", async () => {
      const { onReveal } = mount();
      const reply = screen.getByTestId("comment-reply");
      reply.focus();
      await userEvent.setup().keyboard("{Enter}");
      expect(screen.getByTestId("comment-submit")).toBeInTheDocument();
      expect(onReveal).not.toHaveBeenCalled();
    });

    it("activates a thread whose text was removed and says why nothing moved", () => {
      const { threadId, onReveal, onToast, card } = mount({ removed: true });
      expect(card).toHaveTextContent("(original text removed)");
      fireEvent.click(card);
      expect(onReveal).not.toHaveBeenCalled();
      expect(session!.activeCommentId).toBe(threadId);
      expect(onToast).toHaveBeenCalledTimes(1);
      const [message, kind] = onToast.mock.calls[0];
      expect(message).toMatch(/removed/i);
      expect(message.length).toBeLessThanOrEqual(60);
      expect(kind).toBe("info");
    });
  });
});
