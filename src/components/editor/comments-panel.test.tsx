// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as Y from "yjs";

// A provider that only supplies the awareness instance; tests drive presence by applying a remote client's
// awareness state to it and firing `onAwarenessChange`, as Hocuspocus does when the server relays one.
vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  class HocuspocusProvider {
    awareness: InstanceType<typeof Awareness>;
    static last: HocuspocusProvider | null = null;
    constructor(readonly opts: { document: Y.Doc; onAwarenessChange?: (e: { states: unknown[] }) => void }) {
      this.awareness = new Awareness(opts.document);
      HocuspocusProvider.last = this;
    }
    destroy() {
      this.awareness.destroy();
    }
  }
  return { HocuspocusProvider };
});

// The real module, with `claimerName` counted: the request chip must not be asked for a label when nothing about an
// agent changed (#1382).
vi.mock("./agent-requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-requests")>();
  return { ...actual, claimerName: vi.fn(actual.claimerName) };
});

vi.mock("@/editor/collab/suggestion-block", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/editor/collab/suggestion-block")>();
  return { ...actual, parseSuggestionBlock: vi.fn(actual.parseSuggestionBlock) };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      documents: {
        collaborators: vi.fn().mockResolvedValue({ owner: null, collaborators: [], agents: [] }),
        reviews: vi.fn().mockResolvedValue({ reviews: [] }),
        comment: vi.fn().mockResolvedValue({ id: "via-api" }),
        createRequest: vi.fn().mockResolvedValue({ request: { id: "req" } }),
      },
      tokens: {
        list: vi.fn().mockResolvedValue({ tokens: [] }),
      },
    },
  };
});

vi.mock("@/lib/notifications-store", () => ({
  markRefsRead: vi.fn(),
  useUnreadRefs: () => new Set<string>(),
}));

import { HocuspocusProvider } from "@hocuspocus/provider";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { api } from "@/lib/api";
import { AGENT_CONNECT_DISMISSED_KEY } from "@/lib/mcp";
import { parseSuggestionBlock } from "@/editor/collab/suggestion-block";
import type { AgentRequestMirror } from "@/server/agent-requests";
import type { ReviewDto } from "@/server/reviews";
import { TooltipProvider } from "@/components/ui/primitives";
import { claimerName, requestInstruction, waitForSynced } from "./agent-requests";
import { CommentsPanel, isReviewOpen, mentionedAgents, type CommentsPanelProps } from "./comments-panel";

/** The mocked provider of the session under test (see the `@hocuspocus/provider` mock above). */
type FakeProvider = { opts: { onAwarenessChange?: (e: { states: unknown[] }) => void } };
const lastProvider = () => (HocuspocusProvider as unknown as { last: FakeProvider | null }).last!;

function reviewDto(id: string, threadIds: string[], documentId = "doc"): ReviewDto {
  return {
    id,
    documentId,
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

type ReviewsResponse = Awaited<ReturnType<typeof api.documents.reviews>>;
type CommentResponse = Awaited<ReturnType<typeof api.documents.comment>>;
type CollaboratorsResponse = Awaited<ReturnType<typeof api.documents.collaborators>>;
type TokensResponse = Awaited<ReturnType<typeof api.tokens.list>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function reviewSession(docId: string) {
  const user = makeCollabUser("alice", "Alice");
  const session = new CollabSession({ docId, user, role: "owner", getToken: async () => "token", autoConnect: false });
  session.keepAlive();
  return { session, user };
}

describe("CommentsPanel", () => {
  let session: CollabSession | null = null;
  let auxiliarySessions: CollabSession[] = [];

  afterEach(() => {
    cleanup();
    session?.destroy();
    for (const extra of auxiliarySessions) extra.destroy();
    session = null;
    auxiliarySessions = [];
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
    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);

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

    // Tab leaves the tablist for the "Comment on the document" button beside it, then the empty state's agent line.
    const keyboard = userEvent.setup();
    await keyboard.tab();
    expect(screen.getByTestId("comment-document")).toHaveFocus();
    expect(screen.getByRole("tablist").contains(screen.getByTestId("comment-document"))).toBe(false);
    await keyboard.tab();
    expect(screen.getByTestId("comments-empty-agent")).toHaveFocus();
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

  describe("review metadata loading", () => {
    it("keeps live comments visible behind one neutral initial status until a successful empty result", async () => {
      const initial = deferred<ReviewsResponse>();
      vi.mocked(api.documents.reviews).mockReset().mockReturnValueOnce(initial.promise);
      const created = reviewSession("reviews-loading");
      session = created.session;
      session.ytext.insert(0, "A live comment.");
      session.comments.add({ from: 0, to: 1, body: "Still available.", author: created.user });

      render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);

      expect(screen.getByTestId("reviews-loading")).toHaveTextContent("Loading review details…");
      expect(screen.getByTestId("comment-thread")).toHaveTextContent("Still available.");
      expect(screen.queryByText("No open comments")).toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: "Resolved" }));
      expect(screen.getAllByTestId("reviews-loading")).toHaveLength(1);
      expect(screen.queryByText("Nothing resolved yet")).toBeNull();

      await act(async () => {
        initial.resolve({ reviews: [] });
        await initial.promise;
      });

      expect(await screen.findByText("Nothing resolved yet")).toBeInTheDocument();
      expect(screen.queryByTestId("reviews-loading")).toBeNull();
      expect(api.documents.reviews).toHaveBeenCalledOnce();
      expect(api.documents.reviews).toHaveBeenCalledWith("reviews-loading");
    });

    it("retries a first-load failure once and guards repeated activation until genuine empty success", async () => {
      const retry = deferred<ReviewsResponse>();
      vi.mocked(api.documents.reviews)
        .mockReset()
        .mockRejectedValueOnce(new Error("offline"))
        .mockReturnValueOnce(retry.promise);
      session = reviewSession("reviews-retry").session;

      render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Couldn’t load review details.");
      expect(within(alert).getAllByRole("button", { name: "Retry" })).toHaveLength(1);
      expect(screen.queryByText("No open comments")).toBeNull();

      const retryButton = within(alert).getByRole("button", { name: "Retry" });
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);

      expect(api.documents.reviews).toHaveBeenCalledTimes(2);
      expect(within(alert).getByRole("button", { name: "Retrying…" })).toBeDisabled();
      await act(async () => {
        retry.resolve({ reviews: [] });
        await retry.promise;
      });

      expect(await screen.findByText("No open comments")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(api.documents.reviews).toHaveBeenNthCalledWith(2, "reviews-retry");
    });

    it("keeps cached review cards and live comments visible when a thread-count refresh fails", async () => {
      const refresh = deferred<ReviewsResponse>();
      vi.mocked(api.documents.reviews).mockReset();
      const created = reviewSession("reviews-cached");
      session = created.session;
      session.ytext.insert(0, "Review this text.");
      const reviewThread = session.comments.add({ from: 0, to: 6, body: "Review finding.", author: created.user });
      const cached = reviewDto("cached", [reviewThread], session.docId);
      vi.mocked(api.documents.reviews)
        .mockResolvedValueOnce({ reviews: [cached] })
        .mockReturnValueOnce(refresh.promise);

      render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);
      expect(await screen.findByText("Review cached.")).toBeInTheDocument();

      act(() => {
        session!.comments.add({ from: 7, to: 11, body: "A live follow-up.", author: created.user });
      });

      expect(await screen.findByTestId("reviews-loading")).toHaveTextContent("Refreshing review details…");
      expect(screen.getByText("Review cached.")).toBeInTheDocument();
      await act(async () => {
        refresh.reject(new Error("refresh unavailable"));
        try {
          await refresh.promise;
        } catch {}
      });

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Review details may be out of date.");
      expect(screen.getByText("Review cached.")).toBeInTheDocument();
      expect(screen.getByText("Review finding.")).toBeInTheDocument();
      expect(screen.getByText("A live follow-up.")).toBeInTheDocument();
      expect(screen.getAllByTestId("review-card")).toHaveLength(1);
      expect(api.documents.reviews).toHaveBeenCalledTimes(2);
    });

    it("coalesces a burst of thread-count changes during pending work into one current refresh", async () => {
      const stale = deferred<ReviewsResponse>();
      const current = deferred<ReviewsResponse>();
      vi.mocked(api.documents.reviews).mockReset().mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
      const created = reviewSession("reviews-coalesced");
      session = created.session;
      session.ytext.insert(0, "One two.");

      render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);
      fireEvent.click(screen.getByRole("tab", { name: "Resolved" }));
      act(() => {
        session!.comments.add({ from: 0, to: 3, body: "First.", author: created.user });
      });
      await act(async () => {});
      act(() => {
        session!.comments.add({ from: 4, to: 7, body: "Second.", author: created.user });
      });
      await act(async () => {});
      expect(api.documents.reviews).toHaveBeenCalledOnce();

      await act(async () => {
        stale.resolve({ reviews: [reviewDto("stale", [], session!.docId)] });
        await stale.promise;
      });

      await waitFor(() => expect(api.documents.reviews).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId("reviews-loading")).toHaveTextContent("Loading review details…");
      expect(screen.queryByText("Review stale.")).toBeNull();

      await act(async () => {
        current.resolve({ reviews: [] });
        await current.promise;
      });

      expect(await screen.findByText("Nothing resolved yet")).toBeInTheDocument();
      expect(api.documents.reviews).toHaveBeenCalledTimes(2);
    });

    it.each(["resolve", "reject"] as const)("isolates an old document’s stale Retry %s before loading the current document", async (outcome) => {
      const oldRequest = deferred<ReviewsResponse>();
      const newRequest = deferred<ReviewsResponse>();
      let oldCalls = 0;
      vi.mocked(api.documents.reviews).mockReset().mockImplementation((docId) => {
        if (docId !== "reviews-old") return newRequest.promise;
        oldCalls += 1;
        return oldCalls === 1 ? Promise.reject(new Error("old initial failure")) : oldRequest.promise;
      });
      const old = reviewSession("reviews-old");
      const next = reviewSession("reviews-new");
      session = next.session;

      const rendered = render(<CommentsPanel session={old.session} onClose={() => {}} onReveal={() => {}} />);
      const oldAlert = await screen.findByRole("alert");
      fireEvent.click(within(oldAlert).getByRole("button", { name: "Retry" }));
      expect(api.documents.reviews).toHaveBeenCalledTimes(2);
      rendered.rerender(<CommentsPanel session={next.session} onClose={() => {}} onReveal={() => {}} />);
      fireEvent.click(screen.getByRole("tab", { name: "Resolved" }));
      expect(api.documents.reviews).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("reviews-loading")).toBeInTheDocument();

      await act(async () => {
        if (outcome === "resolve") oldRequest.resolve({ reviews: [reviewDto("old", [], old.session.docId)] });
        else oldRequest.reject(new Error("old failure"));
        try {
          await oldRequest.promise;
        } catch {}
      });

      await waitFor(() => expect(api.documents.reviews).toHaveBeenCalledTimes(3));
      expect(api.documents.reviews).toHaveBeenNthCalledWith(3, "reviews-new");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("Review old.")).toBeNull();

      await act(async () => {
        newRequest.resolve({ reviews: [reviewDto("new", [], next.session.docId)] });
        await newRequest.promise;
      });

      expect(await screen.findByText("Review new.")).toBeInTheDocument();
      expect(screen.queryByText("Review old.")).toBeNull();
      old.session.destroy();
    });

    it.each(["resolve", "reject"] as const)("drops a queued refresh and late %s settlement after unmount", async (outcome) => {
      const pending = deferred<ReviewsResponse>();
      vi.mocked(api.documents.reviews).mockReset().mockReturnValue(pending.promise);
      const created = reviewSession(`reviews-unmount-${outcome}`);
      session = created.session;
      const rendered = render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);
      expect(api.documents.reviews).toHaveBeenCalledOnce();
      act(() => {
        session!.comments.add({ from: 0, to: 0, body: "Queue a refresh.", author: created.user });
      });
      await act(async () => {});

      rendered.unmount();
      await act(async () => {
        if (outcome === "resolve") pending.resolve({ reviews: [] });
        else pending.reject(new Error("late failure"));
        try {
          await pending.promise;
        } catch {}
      });

      expect(api.documents.reviews).toHaveBeenCalledOnce();
    });
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
    const mount = (opts: { removed?: boolean; reply?: boolean } = {}) => {
      // jsdom has no scrollIntoView; the active card scrolls itself into view with it.
      Element.prototype.scrollIntoView ??= () => {};
      const user = makeCollabUser("alice", "Alice");
      session = new CollabSession({ docId: "doc", user, role: "owner", getToken: async () => "token", autoConnect: false });
      session.keepAlive();
      session.ytext.insert(0, "Intro text. The quick brown fox jumps.");
      const threadId = session.comments.add({ from: 16, to: 27, body: "See [the docs](https://example.com) first.", author: user });
      if (opts.reply) session.comments.reply(threadId, "Following up.", user);
      // A thread whose Y.Map lost its anchor is what the UI renders as "(original text removed)".
      if (opts.removed) session.comments.ymap.get(threadId)!.delete("anchor");
      const onReveal = vi.fn<CommentsPanelProps["onReveal"]>();
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      // The panel lives inside the editor shell's TooltipProvider; the composer's Save / send button carries a tooltip.
      render(
        <TooltipProvider>
          <CommentsPanel session={session} onClose={() => {}} onReveal={onReveal} onToast={onToast} />
        </TooltipProvider>,
      );
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

    it("sizes only the standalone Reply as a centered 24px target and still opens its composer", () => {
      mount({ reply: true });
      const targets = screen.getAllByTestId("comment-reply");
      const button = targets.find((target) => target.tagName === "BUTTON")!;
      const replyRow = targets.find((target) => target.hasAttribute("data-reply-id"))!;

      expect(button).toHaveClass("min-h-6", "items-center");
      expect(replyRow).not.toHaveClass("min-h-6");
      fireEvent.click(button);
      expect(screen.getByPlaceholderText("Reply…")).toBeInTheDocument();
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

  describe("API-backed row action ownership", () => {
    interface ActionFixture {
      session: CollabSession;
      user: ReturnType<typeof makeCollabUser>;
      threadIds: [string, string];
      replyIds: [string, string];
    }

    const response = {} as CommentResponse;

    const makeApiSession = (docId: string, source?: CollabSession): ActionFixture => {
      const user = makeCollabUser("alice", "Alice", null, "alice");
      const next = new CollabSession({ docId, user, role: "commenter", getToken: async () => "token", autoConnect: false });
      next.keepAlive();
      if (source) {
        Y.applyUpdate(next.ydoc, Y.encodeStateAsUpdate(source.ydoc));
      } else {
        next.ytext.insert(0, "Alpha beta gamma delta epsilon.");
        const first = next.comments.add({ from: 0, to: 5, body: "First root.", author: user });
        const second = next.comments.add({ from: 6, to: 10, body: "Second root.", author: user });
        const firstReply = next.comments.reply(first, "First reply.", user)!;
        const secondReply = next.comments.reply(second, "Second reply.", user)!;
        next.comments.toggleReaction(first, null, "👍", user);
        next.comments.toggleReaction(first, firstReply, "👍", user);
        next.comments.toggleReaction(second, null, "👍", user);
        next.comments.toggleReaction(second, secondReply, "👍", user);
      }
      const threads = next.comments.list();
      session = next;
      return {
        session: next,
        user,
        threadIds: [threads[0].id, threads[1].id],
        replyIds: [threads[0].replies[0].id, threads[1].replies[0].id],
      };
    };

    const panel = (current: CollabSession) => (
      <TooltipProvider>
        <CommentsPanel session={current} onClose={() => {}} onReveal={() => {}} />
      </TooltipProvider>
    );

    const card = (threadId: string) => document.querySelector<HTMLElement>(`[data-testid="comment-thread"][data-thread-id="${threadId}"]`)!;
    const reply = (threadId: string, replyId: string) => card(threadId).querySelector<HTMLElement>(`[data-testid="comment-reply"][data-reply-id="${replyId}"]`)!;
    const rootReactionRow = (threadId: string) => within(card(threadId)).getAllByTestId("reaction-row")[0];
    const replyReactionRow = (threadId: string, replyId: string) => within(reply(threadId, replyId)).getByTestId("reaction-row");
    const reactionChip = (row: HTMLElement, emoji = "👍") => within(row).getAllByTestId("reaction-chip").find((item) => item.getAttribute("data-emoji") === emoji)!;
    const openRootDelete = async (threadId: string) => {
      fireEvent.pointerDown(within(card(threadId)).getByRole("button", { name: "Comment actions" }), { button: 0 });
      return await screen.findByRole("menuitem", { name: "Delete thread" });
    };
    const invokeRoot = async (kind: "resolve" | "delete" | "reaction", threadId: string) => {
      if (kind === "resolve") fireEvent.click(within(card(threadId)).getByTestId("comment-resolve"));
      else if (kind === "reaction") fireEvent.click(reactionChip(rootReactionRow(threadId)));
      else fireEvent.click(await openRootDelete(threadId));
    };
    const expectRootControlsDisabled = (threadId: string) => {
      expect(within(card(threadId)).getByTestId("comment-resolve")).toBeDisabled();
      expect(within(card(threadId)).getByRole("button", { name: "Comment actions" })).toBeDisabled();
      expect(reactionChip(rootReactionRow(threadId))).toBeDisabled();
      expect(within(rootReactionRow(threadId)).getByRole("button", { name: "Add reaction" })).toBeDisabled();
    };
    const settle = async (request: ReturnType<typeof deferred<CommentResponse>>, outcome: "resolve" | "reject", reason = "request failed") => {
      await act(async () => {
        if (outcome === "resolve") request.resolve(response);
        else request.reject(new Error(reason));
        await request.promise.catch(() => {});
      });
    };

    beforeEach(() => {
      vi.mocked(api.documents.comment).mockReset().mockResolvedValue(response);
      vi.mocked(parseSuggestionBlock).mockClear();
    });

    afterEach(() => {
      vi.mocked(api.documents.comment).mockReset().mockResolvedValue({ id: "via-api" } as never);
    });

    it.each(["resolve", "delete", "reaction"] as const)("accepts one immediate duplicate %s, freezes its exact payload, and disables every competing root control", async (kind) => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const fixture = makeApiSession(`duplicate-${kind}`);
      render(panel(fixture.session));
      const [threadId] = fixture.threadIds;

      let control: HTMLElement;
      if (kind === "resolve") control = within(card(threadId)).getByTestId("comment-resolve");
      else if (kind === "reaction") control = reactionChip(rootReactionRow(threadId));
      else control = await openRootDelete(threadId);
      act(() => {
        control.click();
        control.click();
      });

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      const [documentId, payload] = vi.mocked(api.documents.comment).mock.calls[0];
      expect(documentId).toBe(`duplicate-${kind}`);
      expect(payload).toEqual(
        kind === "resolve"
          ? { action: "resolve", threadId, resolved: true }
          : kind === "delete"
            ? { action: "delete", threadId, replyId: undefined }
            : { action: "react", threadId, replyId: undefined, emoji: "👍" },
      );
      expect(Object.isFrozen(payload)).toBe(true);
      const status = within(card(threadId)).getByTestId("comment-action-pending");
      expect(status).toHaveAttribute("data-action", kind === "reaction" ? "react" : kind);
      expect(status).toHaveTextContent(kind === "resolve" ? "Resolving comment…" : kind === "delete" ? "Deleting comment…" : "Removing 👍 reaction…");
      expectRootControlsDisabled(threadId);

      await settle(pending, "resolve");
      expect(within(card(threadId)).queryByTestId("comment-action-pending")).toBeNull();
      expect(within(card(threadId)).getByTestId("comment-resolve")).toBeEnabled();
      expect(api.documents.comment).toHaveBeenCalledTimes(1);
    });

    it("lets the first mixed root action own the target before React commits pending UI", async () => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const fixture = makeApiSession("mixed-root");
      render(panel(fixture.session));
      const [threadId] = fixture.threadIds;
      const menuDelete = await openRootDelete(threadId);
      const resolve = within(card(threadId)).getByTestId("comment-resolve");
      const reaction = reactionChip(rootReactionRow(threadId));

      act(() => {
        resolve.click();
        reaction.click();
        menuDelete.click();
      });

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(api.documents.comment).toHaveBeenCalledWith("mixed-root", { action: "resolve", threadId, resolved: true });
      expectRootControlsDisabled(threadId);
      expect(within(card(threadId)).getAllByTestId("comment-action-pending")).toHaveLength(1);
      await settle(pending, "resolve");
    });

    it("keeps the panel visit’s owner when its row unmounts for a tab switch", async () => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const fixture = makeApiSession("tab-switch-owner");
      render(panel(fixture.session));
      const [threadId] = fixture.threadIds;
      await invokeRoot("resolve", threadId);

      fireEvent.click(screen.getByRole("tab", { name: "Resolved" }));
      expect(document.querySelector(`[data-thread-id="${threadId}"]`)).toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: /Open/ }));
      expect(within(card(threadId)).getByTestId("comment-action-pending")).toHaveTextContent("Resolving comment…");
      act(() => {
        within(card(threadId)).getByTestId("comment-resolve").click();
      });
      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      await settle(pending, "resolve");
    });

    it("runs independent root, reply, and separate-thread targets concurrently without hiding untouched controls", async () => {
      const requests = [deferred<CommentResponse>(), deferred<CommentResponse>(), deferred<CommentResponse>()];
      vi.mocked(api.documents.comment)
        .mockReturnValueOnce(requests[0].promise)
        .mockReturnValueOnce(requests[1].promise)
        .mockReturnValueOnce(requests[2].promise);
      const fixture = makeApiSession("independent-targets");
      render(panel(fixture.session));
      const [first, second] = fixture.threadIds;
      const [firstReply, secondReply] = fixture.replyIds;
      const firstResolve = within(card(first)).getByTestId("comment-resolve");
      const firstReplyReaction = reactionChip(replyReactionRow(first, firstReply));
      const secondReaction = reactionChip(rootReactionRow(second));

      act(() => {
        firstResolve.click();
        firstReplyReaction.click();
        secondReaction.click();
      });

      expect(api.documents.comment).toHaveBeenCalledTimes(3);
      expect(vi.mocked(api.documents.comment).mock.calls).toEqual([
        ["independent-targets", { action: "resolve", threadId: first, resolved: true }],
        ["independent-targets", { action: "react", threadId: first, replyId: firstReply, emoji: "👍" }],
        ["independent-targets", { action: "react", threadId: second, replyId: undefined, emoji: "👍" }],
      ]);
      expect(within(card(first)).getAllByTestId("comment-action-pending")).toHaveLength(2);
      expect(within(card(second)).getAllByTestId("comment-action-pending")).toHaveLength(1);
      expect(reactionChip(replyReactionRow(second, secondReply))).toBeEnabled();

      await settle(requests[0], "resolve");
      expect(within(card(first)).getByTestId("comment-resolve")).toBeEnabled();
      expect(reactionChip(replyReactionRow(first, firstReply))).toBeDisabled();
      expect(reactionChip(rootReactionRow(second))).toBeDisabled();
      await settle(requests[1], "resolve");
      await settle(requests[2], "resolve");
    });

    it("does not race a reply owner with a root delete that would remove it", async () => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const fixture = makeApiSession("delete-reply-conflict");
      render(panel(fixture.session));
      const [threadId] = fixture.threadIds;
      const [replyId] = fixture.replyIds;
      const rootDelete = await openRootDelete(threadId);
      const replyReaction = reactionChip(replyReactionRow(threadId, replyId));

      act(() => {
        replyReaction.click();
        rootDelete.click();
      });

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(api.documents.comment).toHaveBeenCalledWith("delete-reply-conflict", {
        action: "react",
        threadId,
        replyId,
        emoji: "👍",
      });
      await settle(pending, "resolve");
    });

    it.each(["resolve", "delete", "reaction"] as const)("shows one current %s failure and clears it for a same-action retry", async (kind) => {
      const first = deferred<CommentResponse>();
      const retry = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
      const fixture = makeApiSession(`retry-${kind}`);
      render(panel(fixture.session));
      const [threadId] = fixture.threadIds;

      await invokeRoot(kind, threadId);
      expectRootControlsDisabled(threadId);
      await settle(first, "reject", `${kind} unavailable`);

      const alert = within(card(threadId)).getByRole("alert");
      expect(alert).toHaveTextContent(`${kind} unavailable. Try again.`);
      expect(within(card(threadId)).getAllByRole("alert")).toHaveLength(1);
      expect(within(card(threadId)).getByTestId("comment-resolve")).toBeEnabled();
      expect(reactionChip(rootReactionRow(threadId))).toBeEnabled();

      await invokeRoot(kind, threadId);
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
      expect(within(card(threadId)).queryByRole("alert")).toBeNull();
      expect(within(card(threadId)).getByTestId("comment-action-pending")).toBeVisible();
      await settle(retry, "resolve");
      expect(within(card(threadId)).queryByTestId("comment-action-pending")).toBeNull();
      expect(within(card(threadId)).queryByRole("alert")).toBeNull();
    });

    it.each(["resolve", "reject"] as const)("keeps a replacement document’s same-id owner locked through old %s and finalizer settlement", async (oldOutcome) => {
      const oldRequest = deferred<CommentResponse>();
      const currentRequest = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(currentRequest.promise);
      const old = makeApiSession("old-document");
      const rendered = render(panel(old.session));
      const [threadId] = old.threadIds;
      await invokeRoot("resolve", threadId);

      auxiliarySessions.push(old.session);
      const current = makeApiSession("current-document", old.session);
      expect(current.threadIds[0]).toBe(threadId);
      rendered.rerender(panel(current.session));
      await invokeRoot("resolve", threadId);
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
      expect(within(card(threadId)).getByTestId("comment-action-pending")).toHaveTextContent("Resolving comment…");

      await settle(oldRequest, oldOutcome);
      expect(within(card(threadId)).getByTestId("comment-action-pending")).toHaveTextContent("Resolving comment…");
      expect(within(card(threadId)).queryByRole("alert")).toBeNull();
      act(() => {
        within(card(threadId)).getByTestId("comment-resolve").click();
      });
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
      expect(vi.mocked(api.documents.comment).mock.calls.map(([documentId]) => documentId)).toEqual(["old-document", "current-document"]);

      await settle(currentRequest, "resolve");
      expect(within(card(threadId)).queryByTestId("comment-action-pending")).toBeNull();
      expect(within(card(threadId)).queryByTestId("comment-resolved-state")).toBeNull();
    });

    it.each(["resolve", "reject"] as const)("does not let old %s replace or clear a newer same-id error", async (oldOutcome) => {
      const oldRequest = deferred<CommentResponse>();
      const currentRequest = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(currentRequest.promise);
      const old = makeApiSession("retired-error-document");
      const rendered = render(panel(old.session));
      const [threadId] = old.threadIds;
      await invokeRoot("reaction", threadId);

      auxiliarySessions.push(old.session);
      const current = makeApiSession("new-error-document", old.session);
      rendered.rerender(panel(current.session));
      await invokeRoot("reaction", threadId);
      await settle(currentRequest, "reject", "current reaction failed");
      expect(within(card(threadId)).getByRole("alert")).toHaveTextContent("current reaction failed. Try again.");

      await settle(oldRequest, oldOutcome, "old reaction failed");
      expect(within(card(threadId)).getAllByRole("alert")).toHaveLength(1);
      expect(within(card(threadId)).getByRole("alert")).toHaveTextContent("current reaction failed. Try again.");
      expect(within(card(threadId)).getByRole("alert")).not.toHaveTextContent("old reaction failed");
    });

    it.each([
      ["root", "resolve"],
      ["reply", "reject"],
    ] as const)("retires a removed %s target before a late %s settlement", async (target, outcome) => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const fixture = makeApiSession(`removed-${target}`);
      render(panel(fixture.session));
      const [threadId] = fixture.threadIds;
      const [replyId] = fixture.replyIds;
      if (target === "root") await invokeRoot("resolve", threadId);
      else fireEvent.click(reactionChip(replyReactionRow(threadId, replyId)));
      expect(api.documents.comment).toHaveBeenCalledTimes(1);

      act(() => {
        if (target === "root") fixture.session.comments.remove(threadId);
        else fixture.session.comments.deleteReply(threadId, replyId);
      });
      if (target === "root") await waitFor(() => expect(document.querySelector(`[data-thread-id="${threadId}"]`)).toBeNull());
      else await waitFor(() => expect(card(threadId).querySelector(`[data-reply-id="${replyId}"]`)).toBeNull());

      await settle(pending, outcome, "removed target failed");
      expect(screen.queryByText(/removed target failed/i)).toBeNull();
      expect(screen.queryByTestId("comment-action-pending")).toBeNull();
      expect(api.documents.comment).toHaveBeenCalledTimes(1);
    });

    it.each(["resolve", "reject"] as const)("handles a late %s after panel unmount with zero unhandled rejections", async (outcome) => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const fixture = makeApiSession(`unmounted-action-${outcome}`);
      const rendered = render(panel(fixture.session));
      const [threadId] = fixture.threadIds;
      const unhandled: unknown[] = [];
      const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
      window.addEventListener("unhandledrejection", onUnhandled);
      try {
        await invokeRoot("delete", threadId);
        rendered.unmount();
        await settle(pending, outcome, "late action failure");
        await act(async () => {});
        expect(unhandled).toEqual([]);
        expect(screen.queryByRole("alert")).toBeNull();
        expect(api.documents.comment).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener("unhandledrejection", onUnhandled);
      }
    });

    it("keeps unrelated memoised cards at zero renders while one target publishes pending and success", async () => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const fixture = makeApiSession("render-isolation");
      render(panel(fixture.session));
      const [first, second] = fixture.threadIds;

      vi.mocked(parseSuggestionBlock).mockClear();
      fireEvent.click(within(card(first)).getByTestId("comment-resolve"));
      expect(vi.mocked(parseSuggestionBlock).mock.calls.filter(([body]) => body === "First reply.")).toHaveLength(1);
      expect(vi.mocked(parseSuggestionBlock).mock.calls.filter(([body]) => body === "Second reply.")).toHaveLength(0);

      await settle(pending, "resolve");
      expect(vi.mocked(parseSuggestionBlock).mock.calls.filter(([body]) => body === "First reply.")).toHaveLength(2);
      expect(vi.mocked(parseSuggestionBlock).mock.calls.filter(([body]) => body === "Second reply.")).toHaveLength(0);
      expect(within(card(second)).getByTestId("comment-resolve")).toBeEnabled();
    });
  });

  describe("bulk review action ownership", () => {
    interface BatchFixture {
      session: CollabSession;
      user: ReturnType<typeof makeCollabUser>;
      threadIds: string[];
    }

    const response = {} as CommentResponse;
    const words = ["Alpha", "beta", "gamma", "delta"];

    const makeBatchSession = (docId: string, count = 2, source?: CollabSession, suggestions = true): BatchFixture => {
      const user = makeCollabUser("alice", "Alice", null, "alice");
      const next = new CollabSession({ docId, user, role: "owner", getToken: async () => "token", autoConnect: false });
      next.keepAlive();
      if (source) {
        Y.applyUpdate(next.ydoc, Y.encodeStateAsUpdate(source.ydoc));
      } else {
        const text = "Alpha beta gamma delta.";
        next.ytext.insert(0, text);
        const agent = makeCollabUser("agent:alice:Copilot", "Copilot");
        for (const [index, word] of words.slice(0, count).entries()) {
          next.comments.add({
            from: text.indexOf(word),
            to: text.indexOf(word) + word.length,
            body: suggestions ? `Finding ${index + 1}.\n\n\`\`\`suggestion\n${word.toUpperCase()}\n\`\`\`` : `Finding ${index + 1}.`,
            author: agent,
          });
        }
      }
      vi.spyOn(next, "commentsViaApi", "get").mockReturnValue(true);
      session = next;
      return { session: next, user, threadIds: next.comments.list().map((thread) => thread.id) };
    };

    const batchPanel = (current: CollabSession, onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>(), onClose = () => {}) => (
      <TooltipProvider>
        <CommentsPanel session={current} onClose={onClose} onReveal={() => {}} onToast={onToast} />
      </TooltipProvider>
    );
    const reviewCard = (reviewId: string) => document.querySelector<HTMLElement>(`[data-testid="review-card"][data-review-id="${reviewId}"]`)!;
    const reviewControl = (reviewId: string, testId: string) => within(reviewCard(reviewId)).getByTestId(testId);
    const threadCard = (threadId: string) => document.querySelector<HTMLElement>(`[data-testid="comment-thread"][data-thread-id="${threadId}"]`)!;
    const settleBatch = async (request: ReturnType<typeof deferred<CommentResponse>>, outcome: "resolve" | "reject", reason = "request failed") => {
      await act(async () => {
        if (outcome === "resolve") request.resolve(response);
        else request.reject(new Error(reason));
        await request.promise.catch(() => {});
      });
    };

    beforeEach(() => {
      vi.mocked(api.documents.comment).mockReset().mockResolvedValue(response);
      vi.mocked(api.documents.reviews).mockReset().mockResolvedValue({ reviews: [] } as ReviewsResponse);
    });

    afterEach(() => {
      vi.mocked(api.documents.comment).mockReset().mockResolvedValue({ id: "via-api" } as never);
      vi.mocked(api.documents.reviews).mockReset().mockResolvedValue({ reviews: [] } as ReviewsResponse);
    });

    it.each(["accept", "reject"] as const)("gives the first immediate review %s activation one frozen ordered batch", async (action) => {
      const requests = [deferred<CommentResponse>(), deferred<CommentResponse>()];
      vi.mocked(api.documents.comment).mockReturnValueOnce(requests[0].promise).mockReturnValueOnce(requests[1].promise);
      const fixture = makeBatchSession(`review-${action}`);
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(fixture.session, onToast));
      const primary = await screen.findByTestId(`review-${action}-all`);
      const mixed = screen.getByTestId(`review-${action === "accept" ? "reject" : "accept"}-all`);

      act(() => {
        primary.click();
        primary.click();
        mixed.click();
      });

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(api.documents.comment).toHaveBeenLastCalledWith(fixture.session.docId, {
        action: "suggestion",
        threadId: fixture.threadIds[0],
        replyId: undefined,
        decision: action,
      });
      expect(primary).toBeDisabled();
      expect(mixed).toBeDisabled();
      expect(primary).toHaveTextContent(action === "accept" ? "Accepting…" : "Rejecting…");
      expect(within(threadCard(fixture.threadIds[0])).getByTestId("comment-resolve")).toBeDisabled();
      expect(within(threadCard(fixture.threadIds[0])).getByTestId("comment-batch-pending")).toHaveTextContent(
        action === "accept" ? "Accepting suggestion…" : "Rejecting suggestion…",
      );

      await settleBatch(requests[0], "resolve");
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
      expect(api.documents.comment).toHaveBeenLastCalledWith(fixture.session.docId, {
        action: "suggestion",
        threadId: fixture.threadIds[1],
        replyId: undefined,
        decision: action,
      });
      await settleBatch(requests[1], "resolve");

      expect(vi.mocked(api.documents.comment).mock.calls.map(([, payload]) => payload.threadId)).toEqual(fixture.threadIds);
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledWith(`${action === "accept" ? "Accepted" : "Rejected"} 2 suggestions from Copilot.`, "success");
    });

    it("gives immediate duplicate Resolve all activation one owner and one current summary", async () => {
      const requests = [deferred<CommentResponse>(), deferred<CommentResponse>()];
      vi.mocked(api.documents.comment).mockReturnValueOnce(requests[0].promise).mockReturnValueOnce(requests[1].promise);
      const fixture = makeBatchSession("review-resolve", 2, undefined, false);
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(fixture.session, onToast));
      const control = await screen.findByTestId("review-resolve-all");

      act(() => {
        control.click();
        control.click();
      });

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(api.documents.comment).toHaveBeenCalledWith("review-resolve", {
        action: "resolve",
        threadId: fixture.threadIds[0],
        resolved: true,
      });
      expect(control).toBeDisabled();
      expect(control).toHaveTextContent("Resolving…");
      await settleBatch(requests[0], "resolve");
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
      await settleBatch(requests[1], "resolve");
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledWith("Resolved 2 comments from Copilot.", "success");
    });

    it.each(["accept", "reject"] as const)("owns Suggestions-tab %s all before immediate duplicate or mixed activation", async (action) => {
      const requests = [deferred<CommentResponse>(), deferred<CommentResponse>()];
      vi.mocked(api.documents.comment).mockReturnValueOnce(requests[0].promise).mockReturnValueOnce(requests[1].promise);
      const fixture = makeBatchSession(`suggestions-${action}`);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(fixture.session, onToast));
      fireEvent.click(screen.getByRole("tab", { name: /Suggestions/ }));
      const primary = screen.getByTestId(`${action}-all`);
      const mixed = screen.getByTestId(`${action === "accept" ? "reject" : "accept"}-all`);

      act(() => {
        primary.click();
        primary.click();
        mixed.click();
      });

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(primary).toBeDisabled();
      expect(mixed).toBeDisabled();
      expect(primary).toHaveTextContent(action === "accept" ? "Accepting…" : "Rejecting…");
      await settleBatch(requests[0], "resolve");
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
      await settleBatch(requests[1], "resolve");
      expect(vi.mocked(api.documents.comment).mock.calls).toEqual(
        fixture.threadIds.map((threadId) => [
          fixture.session.docId,
          { action: "suggestion", threadId, replyId: undefined, decision: action },
        ]),
      );
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledWith(`${action === "accept" ? "Accepted" : "Rejected"} 2 suggestions.`, "success");
    });

    it("keeps local Suggestions-tab bulk review in one text-and-annotation undo step", async () => {
      const created = reviewSession("local-suggestion-batch");
      session = created.session;
      const original = "Alpha beta gamma.";
      session.ytext.insert(0, original);
      const agent = makeCollabUser("agent:alice:Copilot", "Copilot");
      session.suggestions.proposeEdits(
        [
          { from: 0, to: 5, insert: "ALPHA" },
          { from: 6, to: 10, insert: "BETA" },
        ],
        agent,
      );
      session.undoManager.clear();
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(session, onToast));
      fireEvent.click(screen.getByRole("tab", { name: /Suggestions/ }));
      fireEvent.click(screen.getByTestId("accept-all"));

      await waitFor(() => expect(screen.queryByTestId("suggestion-card")).toBeNull());
      expect(session.ytext.toString()).toBe("ALPHA BETA gamma.");
      expect(session.undoManager.undoStack).toHaveLength(1);
      act(() => session!.undo());
      expect(session.suggestions.groups(session.ytext.toString())).toHaveLength(2);
      expect(session.suggestions.cleanText()).toBe(original);
      expect(onToast).toHaveBeenCalledOnce();
      expect(onToast).toHaveBeenCalledWith("Accepted 2 suggestions.", "success");
    });

    it("runs two non-overlapping review owners independently while a row owner excludes its review batch", async () => {
      const requests = [deferred<CommentResponse>(), deferred<CommentResponse>(), deferred<CommentResponse>()];
      vi.mocked(api.documents.comment)
        .mockReturnValueOnce(requests[0].promise)
        .mockReturnValueOnce(requests[1].promise)
        .mockReturnValueOnce(requests[2].promise);
      const fixture = makeBatchSession("independent-reviews");
      const reviews = [
        reviewDto("r1", [fixture.threadIds[0]], fixture.session.docId),
        reviewDto("r2", [fixture.threadIds[1]], fixture.session.docId),
      ];
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews } as ReviewsResponse);
      render(batchPanel(fixture.session));
      await waitFor(() => expect(screen.getAllByTestId("review-reject-all")).toHaveLength(2));

      fireEvent.click(reviewControl("r1", "review-reject-all"));
      expect(reviewControl("r2", "review-reject-all")).toBeEnabled();
      fireEvent.click(reviewControl("r2", "review-reject-all"));
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
      expect(vi.mocked(api.documents.comment).mock.calls.map(([, payload]) => payload.threadId)).toEqual(fixture.threadIds);
      await settleBatch(requests[1], "resolve");
      expect(reviewControl("r1", "review-reject-all")).toBeDisabled();
      await settleBatch(requests[0], "resolve");

      fireEvent.click(within(threadCard(fixture.threadIds[0])).getByTestId("comment-resolve"));
      expect(api.documents.comment).toHaveBeenCalledTimes(3);
      expect(reviewControl("r1", "review-reject-all")).toBeDisabled();
      fireEvent.click(reviewControl("r1", "review-reject-all"));
      expect(api.documents.comment).toHaveBeenCalledTimes(3);
      await settleBatch(requests[2], "resolve");
      expect(reviewControl("r1", "review-reject-all")).toBeEnabled();
    });

    it("reports exact partial counts, releases the owner, and retries only the failed target", async () => {
      const requests = [deferred<CommentResponse>(), deferred<CommentResponse>(), deferred<CommentResponse>(), deferred<CommentResponse>()];
      vi.mocked(api.documents.comment)
        .mockReturnValueOnce(requests[0].promise)
        .mockReturnValueOnce(requests[1].promise)
        .mockReturnValueOnce(requests[2].promise)
        .mockReturnValueOnce(requests[3].promise);
      const fixture = makeBatchSession("partial-retry", 3);
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(fixture.session, onToast));
      fireEvent.click(await screen.findByTestId("review-reject-all"));

      act(() => fixture.session.comments.rejectSuggestion(fixture.threadIds[0], fixture.user));
      await settleBatch(requests[0], "resolve");
      await settleBatch(requests[1], "reject", "second failed");
      act(() => fixture.session.comments.rejectSuggestion(fixture.threadIds[2], fixture.user));
      await settleBatch(requests[2], "resolve");

      expect(onToast).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenLastCalledWith("Rejected 2 suggestions from Copilot (2 done, 1 failed, 0 outdated skipped).", "error");
      const retry = await screen.findByTestId("review-reject-all");
      expect(retry).toBeEnabled();
      fireEvent.click(retry);
      expect(api.documents.comment).toHaveBeenCalledTimes(4);
      expect(api.documents.comment).toHaveBeenLastCalledWith("partial-retry", {
        action: "suggestion",
        threadId: fixture.threadIds[1],
        replyId: undefined,
        decision: "reject",
      });
      act(() => fixture.session.comments.rejectSuggestion(fixture.threadIds[1], fixture.user));
      await settleBatch(requests[3], "resolve");
      expect(onToast).toHaveBeenCalledTimes(2);
      expect(onToast).toHaveBeenLastCalledWith("Rejected 1 suggestion from Copilot.", "success");
    });

    it("freezes proposed replacement text and dispatches local accepts in captured order", async () => {
      const requests = [deferred<boolean>(), deferred<boolean>()];
      const fixture = makeBatchSession("frozen-proposals");
      vi.spyOn(fixture.session, "commentsViaApi", "get").mockReturnValue(false);
      const accept = vi
        .spyOn(fixture.session, "acceptCommentSuggestion")
        .mockImplementationOnce(() => requests[0].promise as unknown as boolean)
        .mockImplementationOnce(() => requests[1].promise as unknown as boolean);
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      render(batchPanel(fixture.session));
      fireEvent.click(await screen.findByTestId("review-accept-all"));

      expect(accept).toHaveBeenCalledTimes(1);
      expect(accept).toHaveBeenLastCalledWith(fixture.threadIds[0], "ALPHA", undefined);
      await act(async () => {
        requests[0].resolve(true);
        await requests[0].promise;
      });
      expect(accept).toHaveBeenCalledTimes(2);
      expect(accept).toHaveBeenLastCalledWith(fixture.threadIds[1], "BETA", undefined);
      await act(async () => {
        requests[1].resolve(true);
        await requests[1].promise;
      });
    });

    it("counts a newly outdated target without dispatching it and publishes one current summary", async () => {
      const request = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(request.promise);
      const fixture = makeBatchSession("outdated-count");
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(fixture.session, onToast));
      const control = await screen.findByTestId("review-accept-all");
      fireEvent.click(control);
      act(() => fixture.session.ytext.insert(7, "!"));
      await settleBatch(request, "resolve");

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledWith("Accepted 1 suggestion from Copilot (1 done, 0 failed, 1 outdated skipped).", "success");
    });

    it("stops every later dispatch when a captured target is removed mid-loop", async () => {
      const request = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(request.promise);
      const fixture = makeBatchSession("removed-mid-loop", 3);
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(fixture.session, onToast));
      fireEvent.click(await screen.findByTestId("review-reject-all"));
      act(() => fixture.session.comments.remove(fixture.threadIds[1]));
      await settleBatch(request, "resolve");

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledWith("Rejected 1 suggestion from Copilot (1 done, 0 failed, 2 outdated skipped).", "success");
    });

    it("retires a removed review before settlement without dispatching or publishing anything later", async () => {
      const request = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(request.promise);
      const fixture = makeBatchSession("removed-review");
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews)
        .mockResolvedValueOnce({ reviews: [review] } as ReviewsResponse)
        .mockResolvedValueOnce({ reviews: [] } as ReviewsResponse);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(fixture.session, onToast));
      fireEvent.click(await screen.findByTestId("review-reject-all"));
      act(() => fixture.session.comments.add({ from: 0, to: 0, body: "Refresh reviews.", author: fixture.user }));
      await waitFor(() => expect(screen.queryByTestId("review-card")).toBeNull());
      await settleBatch(request, "resolve");

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(onToast).not.toHaveBeenCalled();
      expect(within(threadCard(fixture.threadIds[0])).getByTestId("comment-resolve")).toBeEnabled();
    });

    it("keeps replacement-session ownership independent when old and new settlements arrive out of order", async () => {
      const oldRequest = deferred<CommentResponse>();
      const currentRequest = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(currentRequest.promise);
      const old = makeBatchSession("old-batch-document", 1);
      const reviewFor = (current: CollabSession) => reviewDto("same-review", [current.comments.list()[0].id], current.docId);
      vi.mocked(api.documents.reviews).mockImplementation(async (documentId) => {
        const current = documentId === old.session.docId ? old.session : session!;
        return { reviews: [reviewFor(current)] } as ReviewsResponse;
      });
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      const rendered = render(batchPanel(old.session, onToast));
      fireEvent.click(await screen.findByTestId("review-reject-all"));

      auxiliarySessions.push(old.session);
      const current = makeBatchSession("new-batch-document", 1, old.session);
      rendered.rerender(batchPanel(current.session, onToast));
      fireEvent.click(await screen.findByTestId("review-reject-all"));
      expect(vi.mocked(api.documents.comment).mock.calls.map(([documentId]) => documentId)).toEqual(["old-batch-document", "new-batch-document"]);

      await settleBatch(currentRequest, "resolve");
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("review-reject-all")).toBeEnabled();
      await settleBatch(oldRequest, "reject", "old failure");
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("review-reject-all")).toBeEnabled();
      expect(screen.queryByText(/old failure/i)).toBeNull();
    });

    it.each(["close", "unmount"] as const)("retires on %s with no later dispatch, toast, or unhandled rejection", async (retirement) => {
      const request = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(request.promise);
      const fixture = makeBatchSession(`batch-${retirement}`);
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      const rendered = render(batchPanel(fixture.session, onToast));
      fireEvent.click(await screen.findByTestId("review-reject-all"));
      const unhandled: unknown[] = [];
      const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
      window.addEventListener("unhandledrejection", onUnhandled);
      try {
        if (retirement === "close") fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
        else rendered.unmount();
        await settleBatch(request, "reject", "late batch failure");
        await act(async () => {});
        expect(api.documents.comment).toHaveBeenCalledTimes(1);
        expect(onToast).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
      } finally {
        window.removeEventListener("unhandledrejection", onUnhandled);
      }
    });

    it("keeps unrelated cards at zero render effects while one review publishes ownership and settlement", async () => {
      const request = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(request.promise);
      const fixture = makeBatchSession("batch-render-isolation");
      const reviews = [
        reviewDto("r1", [fixture.threadIds[0]], fixture.session.docId),
        reviewDto("r2", [fixture.threadIds[1]], fixture.session.docId),
      ];
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews } as ReviewsResponse);
      render(batchPanel(fixture.session));
      await waitFor(() => expect(screen.getAllByTestId("review-reject-all")).toHaveLength(2));
      await act(async () => {});

      vi.mocked(parseSuggestionBlock).mockClear();
      fireEvent.click(reviewControl("r1", "review-reject-all"));
      expect(vi.mocked(parseSuggestionBlock).mock.calls.filter(([body]) => body.includes("Finding 1."))).not.toHaveLength(0);
      expect(vi.mocked(parseSuggestionBlock).mock.calls.filter(([body]) => body.includes("Finding 2."))).toHaveLength(0);
      await settleBatch(request, "resolve");
      expect(vi.mocked(parseSuggestionBlock).mock.calls.filter(([body]) => body.includes("Finding 2."))).toHaveLength(0);
    });
  });

  describe("composer submission ownership", () => {
    const TEXT = "Intro text. The quick brown fox jumps.";
    const AGENTS = [
      { name: "First agent", login: "alice/First", ownerLogin: "alice", ownerName: "Alice", present: false, collaboratorsMayAsk: false },
      { name: "Second agent", login: "alice/Second", ownerLogin: "alice", ownerName: "Alice", present: false, collaboratorsMayAsk: false },
    ];

    const mountComposer = async (
      opts: {
        documentComposer?: CommentsPanelProps["documentComposer"];
        onClose?: () => void;
      } = {},
    ) => {
      Element.prototype.scrollIntoView ??= () => {};
      const user = makeCollabUser("alice", "Alice", null, "alice");
      session = new CollabSession({ docId: "composer-doc", user, role: "owner", getToken: async () => "token", autoConnect: false });
      session.keepAlive();
      session.synced = true;
      session.ytext.insert(0, TEXT);
      vi.mocked(api.documents.collaborators).mockResolvedValue({
        owner: { login: "alice", name: "Alice", image: null },
        collaborators: [],
        agents: AGENTS,
      } as unknown as CollaboratorsResponse);
      const add = vi.spyOn(session.comments, "add");
      const onPendingDone = vi.fn();
      const props = (documentComposer: CommentsPanelProps["documentComposer"]) => (
        <TooltipProvider>
          <CommentsPanel
            session={session!}
            onClose={opts.onClose ?? (() => {})}
            onReveal={() => {}}
            onPendingDone={onPendingDone}
            documentComposer={documentComposer}
          />
        </TooltipProvider>
      );
      const view = render(props(opts.documentComposer ?? null));
      if (!opts.documentComposer) act(() => session!.setPendingComment({ from: 0, to: 5 }));
      const box = (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
      return {
        add,
        box,
        onPendingDone,
        user,
        view,
        setDocumentComposer: (next: CommentsPanelProps["documentComposer"]) => view.rerender(props(next)),
      };
    };

    const invokeSubmitHandler = (button: HTMLElement): Promise<void> => {
      const propsKey = Object.keys(button).find((key) => key.startsWith("__reactProps$"));
      if (!propsKey) throw new Error("React props were not attached to the submit button");
      const props = (button as unknown as Record<string, { onClick?: () => Promise<void> } | undefined>)[propsKey];
      const result = props?.onClick?.();
      if (!result) throw new Error("The submit button did not return its submission");
      return result;
    };

    afterEach(() => {
      vi.mocked(api.documents.createRequest).mockReset().mockResolvedValue({ request: { id: "req" } } as never);
      vi.mocked(api.documents.collaborators).mockResolvedValue({ owner: null, collaborators: [], agents: [] } as unknown as CollaboratorsResponse);
    });

    it("claims mixed Enter/click activation once and freezes body, mode and ordered agent intent while pending", async () => {
      const request = deferred<string>();
      const { add, box, onPendingDone, user } = await mountComposer();
      add.mockReturnValue(request.promise as unknown as string);
      const submitted = "  @alice/First @alice/Second draft  ";
      fireEvent.change(box, { target: { value: submitted } });
      await screen.findByTestId("composer-agent-row");
      fireEvent.click(screen.getByTestId("composer-mode-rewrite"));
      expect(screen.getByTestId("composer-mode-rewrite")).toHaveAttribute("aria-checked", "true");

      const submit = screen.getByTestId("comment-submit");
      const cancel = screen.getByRole("button", { name: "Cancel" });
      const suggestion = screen.getByTestId("comment-suggest-change");
      const chip = screen.getAllByTestId("composer-chip")[0];
      act(() => {
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        submit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        fireEvent.change(box, { target: { value: "changed after claim" } });
        screen.getByTestId("composer-mode-comment").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        suggestion.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        cancel.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });

      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith({ from: 0, to: 5, body: submitted.trim(), author: user });
      expect(box).toHaveValue(submitted);
      expect(box).toBeDisabled();
      expect(submit).toBeDisabled();
      expect(cancel).toBeDisabled();
      expect(suggestion).toBeDisabled();
      expect(chip).toBeDisabled();
      expect(screen.getByTestId("composer-mode-comment")).toBeDisabled();
      expect(screen.getByTestId("composer-mode-rewrite")).toHaveAttribute("aria-checked", "true");
      expect(onPendingDone).not.toHaveBeenCalled();

      await act(async () => request.resolve("thread-1"));
      await waitFor(() =>
        expect(api.documents.createRequest).toHaveBeenCalledWith("composer-doc", {
          mode: "rewrite",
          instruction: "draft",
          selection: { from: 0, to: 5, quote: "Intro" },
          threadId: "thread-1",
          agent: "alice/First",
        }),
      );
      expect(onPendingDone).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("pending-comment")).toBeNull();
    });

    it("claims two immediate clicks as one physical submission and clears current work once", async () => {
      const request = deferred<string>();
      const { add, box, onPendingDone, user } = await mountComposer();
      add.mockReturnValue(request.promise as unknown as string);
      fireEvent.change(box, { target: { value: "@ali" } });
      await screen.findByTestId("mention-suggestions");
      const submit = screen.getByTestId("comment-submit");
      const mention = screen.getAllByTestId("mention-option")[0];

      act(() => {
        submit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        submit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        mention.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });

      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith({ from: 0, to: 5, body: "@ali", author: user });
      expect(box).toHaveValue("@ali");
      expect(onPendingDone).not.toHaveBeenCalled();
      await act(async () => request.resolve("thread-1"));
      expect(onPendingDone).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("pending-comment")).toBeNull();
    });

    it("retains a current failed draft, releases its controls and allows one deliberate retry", async () => {
      const first = deferred<string>();
      const retry = deferred<string>();
      const failure = new Error("submit failed");
      const unhandled: unknown[] = [];
      const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
      window.addEventListener("unhandledrejection", onUnhandled);
      try {
        const { add, box, onPendingDone, user } = await mountComposer();
        add.mockReturnValueOnce(first.promise as unknown as string).mockReturnValueOnce(retry.promise as unknown as string);
        fireEvent.change(box, { target: { value: "retry this" } });
        let currentSubmission!: Promise<void>;
        act(() => {
          currentSubmission = invokeSubmitHandler(screen.getByTestId("comment-submit"));
        });
        expect(add).toHaveBeenCalledTimes(1);

        await act(async () => {
          const rejection = expect(currentSubmission).rejects.toBe(failure);
          first.reject(failure);
          await rejection;
        });
        await waitFor(() => expect(screen.getByTestId("comment-submit")).toBeEnabled());
        expect(box).toBeEnabled();
        expect(box).toHaveValue("retry this");
        expect(onPendingDone).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId("comment-submit"));
        expect(add).toHaveBeenCalledTimes(2);
        expect(add).toHaveBeenNthCalledWith(1, { from: 0, to: 5, body: "retry this", author: user });
        expect(add).toHaveBeenNthCalledWith(2, { from: 0, to: 5, body: "retry this", author: user });
        await act(async () => retry.resolve("thread-2"));
        expect(onPendingDone).toHaveBeenCalledTimes(1);
        expect(unhandled).toEqual([]);
      } finally {
        window.removeEventListener("unhandledrejection", onUnhandled);
      }
    });

    it("keeps a keyed replacement draft locked until its own later success when the old success settles first", async () => {
      const oldRequest = deferred<string>();
      const currentRequest = deferred<string>();
      const { add, box: oldBox, onPendingDone, setDocumentComposer } = await mountComposer({ documentComposer: { mention: false, nonce: 1 } });
      add.mockReturnValueOnce(oldRequest.promise as unknown as string).mockReturnValueOnce(currentRequest.promise as unknown as string);
      fireEvent.change(oldBox, { target: { value: "old draft" } });
      fireEvent.click(screen.getByTestId("comment-submit"));

      setDocumentComposer({ mention: false, nonce: 2 });
      const currentBox = (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
      expect(currentBox).not.toBe(oldBox);
      fireEvent.change(currentBox, { target: { value: "current draft" } });
      fireEvent.click(screen.getByTestId("comment-submit"));
      expect(add).toHaveBeenCalledTimes(2);

      await act(async () => oldRequest.resolve("old-thread"));
      expect(currentBox).toHaveValue("current draft");
      expect(currentBox).toBeDisabled();
      expect(screen.getByTestId("comment-submit")).toBeDisabled();
      expect(onPendingDone).not.toHaveBeenCalled();

      await act(async () => currentRequest.resolve("current-thread"));
      expect(onPendingDone).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("pending-comment")).toBeNull();
    });

    it("lets current replacement success retire first, then consumes the old rejection without stale or unhandled effects", async () => {
      const oldRequest = deferred<string>();
      const currentRequest = deferred<string>();
      const unhandled: unknown[] = [];
      const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
      window.addEventListener("unhandledrejection", onUnhandled);
      try {
        const { add, box: oldBox, onPendingDone, setDocumentComposer } = await mountComposer({ documentComposer: { mention: false, nonce: 1 } });
        add.mockReturnValueOnce(oldRequest.promise as unknown as string).mockReturnValueOnce(currentRequest.promise as unknown as string);
        fireEvent.change(oldBox, { target: { value: "old draft" } });
        fireEvent.click(screen.getByTestId("comment-submit"));
        setDocumentComposer({ mention: false, nonce: 2 });
        const currentBox = (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
        fireEvent.change(currentBox, { target: { value: "current draft" } });
        fireEvent.click(screen.getByTestId("comment-submit"));

        await act(async () => currentRequest.resolve("current-thread"));
        expect(onPendingDone).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId("pending-comment")).toBeNull();
        await act(async () => {
          oldRequest.reject(new Error("old failure"));
          await Promise.allSettled([oldRequest.promise]);
        });
        expect(onPendingDone).toHaveBeenCalledTimes(1);
        expect(unhandled).toEqual([]);
      } finally {
        window.removeEventListener("unhandledrejection", onUnhandled);
      }
    });

    it.each(["removal", "close", "layout unmount"] as const)("retires pending ownership on %s before a late rejection", async (retirement) => {
      const request = deferred<string>();
      const unhandled: unknown[] = [];
      const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
      window.addEventListener("unhandledrejection", onUnhandled);
      let removePanel = () => {};
      try {
        const mounted = await mountComposer({ onClose: () => removePanel() });
        removePanel = () => mounted.view.unmount();
        mounted.add.mockReturnValue(request.promise as unknown as string);
        fireEvent.change(mounted.box, { target: { value: "retired draft" } });
        fireEvent.click(screen.getByTestId("comment-submit"));

        if (retirement === "removal") {
          act(() => session!.setPendingComment(null));
          await waitFor(() => expect(screen.queryByTestId("pending-comment")).toBeNull());
        }
        else if (retirement === "close") fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
        else mounted.view.unmount();

        if (retirement === "removal") {
          act(() => session!.setPendingComment({ from: 0, to: 5 }));
          const replacement = (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
          fireEvent.change(replacement, { target: { value: "replacement draft" } });
          expect(replacement).toBeEnabled();
          await act(async () => {
            request.reject(new Error("removed failure"));
            await Promise.allSettled([request.promise]);
          });
          expect(replacement).toHaveValue("replacement draft");
          expect(replacement).toBeEnabled();
        } else {
          await act(async () => {
            request.reject(new Error("unmounted failure"));
            await Promise.allSettled([request.promise]);
          });
          expect(screen.queryByTestId("comments-panel")).toBeNull();
        }
        expect(mounted.add).toHaveBeenCalledTimes(1);
        expect(mounted.onPendingDone).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
      } finally {
        window.removeEventListener("unhandledrejection", onUnhandled);
      }
    });
  });

  describe("agent requests from comments (#1024)", () => {
    // As the collaborators route lists it (#1296): whose it is, and — off by default — whether others may ask it.
    const AGENT = { name: "Copilot CLI", login: "alice/Copilot-CLI", ownerLogin: "alice", ownerName: "Alice", present: false, collaboratorsMayAsk: false };
    const TEXT = "Intro text. The quick brown fox jumps.";

    type Role = "owner" | "editor" | "commenter";
    type ListedAgent = Awaited<ReturnType<typeof api.documents.collaborators>>["agents"][number];
    const mount = (opts: { role?: Role; viewing?: boolean; me?: { id: string; name: string; login: string }; agents?: ListedAgent[]; onCancelRequest?: (id: string) => void } = {}) => {
      Element.prototype.scrollIntoView ??= () => {};
      const me = opts.me ?? { id: "alice", name: "Alice", login: "alice" };
      const user = makeCollabUser(me.id, me.name, null, me.login);
      session = new CollabSession({ docId: "doc", user, role: opts.role ?? "owner", getToken: async () => "token", autoConnect: false });
      session.keepAlive();
      // The provider is mocked: nothing is ever unsynced, and a synced session lets waitForSynced resolve at once.
      session.synced = true;
      if (opts.viewing) session.setMode("viewing");
      session.ytext.insert(0, TEXT);
      vi.mocked(api.documents.collaborators).mockResolvedValue({
        owner: { login: "alice", name: "Alice", image: null },
        collaborators: [{ login: "bob", name: "Bob", image: null }],
        agents: opts.agents ?? [AGENT],
      } as unknown as Awaited<ReturnType<typeof api.documents.collaborators>>);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(
        <TooltipProvider>
          <CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} onToast={onToast} onCancelRequest={opts.onCancelRequest} />
        </TooltipProvider>,
      );
      return { onToast, user };
    };
    /** Opens the new-comment composer on "quick brown" and waits for the picker to know the agent. */
    const openComposer = async () => {
      act(() => session!.setPendingComment({ from: 16, to: 27 }));
      const box = await screen.findByPlaceholderText(/Add a comment/);
      await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
      return box as HTMLTextAreaElement;
    };
    const type = async (box: HTMLTextAreaElement, text: string) => {
      box.focus();
      await userEvent.setup().paste(text);
    };
    const mirror = (over: Partial<AgentRequestMirror> & { id: string }): AgentRequestMirror => ({
      status: "open",
      mode: "suggest",
      instruction: "Tighten this",
      claimedBy: null,
      result: null,
      userId: "alice",
      threadId: null,
      updatedAt: Date.now(),
      ...over,
    });
    const setMirrors = (list: AgentRequestMirror[]) => {
      act(() => session!.meta.set("agentRequests", Object.fromEntries(list.map((r) => [r.id, r]))));
    };

    afterEach(() => {
      // Reset, not clear: a rejecting implementation must never outlive the test that set it (#1082).
      vi.mocked(api.documents.createRequest).mockReset().mockResolvedValue({ request: { id: "req" } } as never);
      vi.mocked(api.documents.comment).mockClear();
      vi.mocked(api.tokens.list).mockClear().mockResolvedValue({ tokens: [] } as never);
      vi.mocked(api.documents.collaborators).mockResolvedValue({ owner: null, collaborators: [], agents: [] } as unknown as Awaited<ReturnType<typeof api.documents.collaborators>>);
    });

    it("shows the mode row only while the body mentions an agent the picker knows", async () => {
      mount();
      const box = await openComposer();
      expect(screen.queryByTestId("composer-agent-row")).toBeNull();
      await type(box, "@alice/Copilot-CLI tighten this");
      const row = await screen.findByTestId("composer-agent-row");
      // Controls only: nothing under the box reads as hint text.
      expect(Array.from(row.querySelectorAll("*")).filter((el) => el.childElementCount === 0 && !el.closest("button"))).toEqual([]);
      const group = screen.getByRole("radiogroup", { name: "How should Copilot CLI answer?" });
      const radios = within(group).getAllByRole("radio");
      expect(radios.map((r) => r.textContent)).toEqual(["Tracked changes", "Comment only", "Rewrite directly"]);
      expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
      expect(radios.map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
      expect(screen.getAllByTestId("composer-chip").length).toBeGreaterThan(0);
      // A human mention alone is just a comment.
      fireEvent.change(box, { target: { value: "@bob what do you think?" } });
      await waitFor(() => expect(screen.queryByTestId("composer-agent-row")).toBeNull());
      // An agent the document does not know is not a request either (the row must never guess).
      fireEvent.change(box, { target: { value: "@carol/Some-Bot help" } });
      expect(screen.queryByTestId("composer-agent-row")).toBeNull();
    });

    it("radios: click and arrow keys choose a mode; the choice is what the request is posted with", async () => {
      mount();
      const box = await openComposer();
      await type(box, "@alice/Copilot-CLI shorter please");
      await screen.findByTestId("composer-agent-row");
      expect(box).toHaveFocus();
      fireEvent.click(screen.getByTestId("composer-mode-comment"));
      expect(screen.getByTestId("composer-mode-comment")).toHaveAttribute("aria-checked", "true");
      expect(screen.getByTestId("composer-mode-suggest")).toHaveAttribute("aria-checked", "false");
      screen.getByTestId("composer-mode-comment").focus();
      await userEvent.setup().keyboard("{ArrowRight}");
      expect(screen.getByTestId("composer-mode-rewrite")).toHaveFocus();
      expect(screen.getByTestId("composer-mode-rewrite")).toHaveAttribute("aria-checked", "true");
      await userEvent.setup().keyboard("{ArrowRight}");
      expect(screen.getByTestId("composer-mode-suggest")).toHaveAttribute("aria-checked", "true");
      await userEvent.setup().keyboard("{ArrowLeft}");
      expect(screen.getByTestId("composer-mode-rewrite")).toHaveAttribute("aria-checked", "true");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
      expect(vi.mocked(api.documents.createRequest).mock.calls[0][1].mode).toBe("rewrite");
    });

    it("a commenter can only ask for comments: the other modes are disabled with a tooltip and Comment only is preselected", async () => {
      // Alice opened her agent to collaborators (#1296); otherwise Carol could not send at all (see the locked-agent tests).
      mount({ role: "commenter", me: { id: "carol", name: "Carol", login: "carol" }, agents: [{ ...AGENT, collaboratorsMayAsk: true }] });
      const box = await openComposer();
      await type(box, "@alice/Copilot-CLI is this right?");
      await screen.findByTestId("composer-agent-row");
      expect(screen.queryByTestId("agent-owner-only")).toBeNull();
      // Someone else's agent is named with its owner.
      expect(screen.getByRole("radiogroup", { name: "How should Alice's Copilot CLI answer?" })).toBeInTheDocument();
      const suggest = screen.getByTestId("composer-mode-suggest");
      const rewrite = screen.getByTestId("composer-mode-rewrite");
      const comment = screen.getByTestId("composer-mode-comment");
      expect(suggest).toHaveAttribute("aria-disabled", "true");
      expect(rewrite).toHaveAttribute("aria-disabled", "true");
      expect(comment).not.toHaveAttribute("aria-disabled");
      expect(comment).toHaveAttribute("aria-checked", "true");
      // Disabled radios are not `disabled`: they can take focus, and then say why.
      fireEvent.click(suggest);
      expect(comment).toHaveAttribute("aria-checked", "true");
      act(() => suggest.focus());
      expect(await screen.findByRole("tooltip")).toHaveTextContent("Needs edit access");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
      const [, payload] = vi.mocked(api.documents.createRequest).mock.calls[0];
      expect(payload.mode).toBe("comment");
      expect(payload.threadId).toBe("via-api");
    });

    it("an editor in viewing mode is treated like a commenter (session.canEdit is mode-aware)", async () => {
      mount({ role: "editor", viewing: true });
      const box = await openComposer();
      await type(box, "@alice/Copilot-CLI ok?");
      await screen.findByTestId("composer-agent-row");
      expect(screen.getByTestId("composer-mode-suggest")).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByTestId("composer-mode-comment")).toHaveAttribute("aria-checked", "true");
    });

    it("posting a comment that mentions an agent creates exactly one request with the thread, quote, range and cleaned instruction — and no 'Sent to agents' toast", async () => {
      const { onToast } = mount();
      const box = await openComposer();
      await type(box, "@alice/Copilot-CLI   @bob  tighten this\nplease  ");
      await screen.findByTestId("composer-agent-row");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
      const threads = session!.comments.list();
      expect(threads).toHaveLength(1);
      expect(threads[0].body).toBe("@alice/Copilot-CLI   @bob  tighten this\nplease");
      expect(api.documents.createRequest).toHaveBeenCalledWith("doc", {
        mode: "suggest",
        instruction: "@bob tighten this please",
        selection: { from: 16, to: 27, quote: "quick brown" },
        threadId: threads[0].id,
        // The first agent mention is the addressee (#1296); the server verifies it against a live token.
        agent: "alice/Copilot-CLI",
      });
      expect(onToast).not.toHaveBeenCalled();
      // The composer closed as it always does.
      expect(screen.queryByTestId("pending-comment")).toBeNull();
    });

    it("a mention that is nothing but the mention still carries an instruction", () => {
      expect(requestInstruction("@alice/Copilot-CLI")).toBe("Please take a look at this.");
      expect(requestInstruction("  @alice/Copilot-CLI \n ")).toBe("Please take a look at this.");
      expect(requestInstruction("@bob and @alice/Copilot-CLI: check  the  numbers")).toBe("@bob and : check the numbers");
    });

    it("a comment without an agent mention never posts a request", async () => {
      mount();
      const box = await openComposer();
      await type(box, "@bob looks fine to me");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(session!.comments.list()).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(api.documents.createRequest).not.toHaveBeenCalled();
    });

    it("retries a 404 while the server catches up, and says so (comment kept) when the request never lands", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { onToast } = mount();
        const box = await openComposer();
        await type(box, "@alice/Copilot-CLI hi");
        await screen.findByTestId("composer-agent-row");
        const notFound = Object.assign(new Error("Comment not found"), { status: 404 });
        vi.mocked(api.documents.createRequest).mockRejectedValueOnce(notFound).mockRejectedValueOnce(notFound).mockResolvedValueOnce({ request: { id: "r" } } as never);
        fireEvent.click(screen.getByTestId("comment-submit"));
        await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
        await act(() => vi.advanceTimersByTimeAsync(300));
        expect(api.documents.createRequest).toHaveBeenCalledTimes(2);
        await act(() => vi.advanceTimersByTimeAsync(600));
        expect(api.documents.createRequest).toHaveBeenCalledTimes(3);
        await act(() => vi.advanceTimersByTimeAsync(1500));
        expect(api.documents.createRequest).toHaveBeenCalledTimes(3);
        expect(onToast).not.toHaveBeenCalled();
        expect(session!.comments.list()).toHaveLength(1);

        // Four 404s in a row: give up, keep the comment, tell the user. Exactly four (one per attempt) so nothing
        // rejecting is left on the mock for later tests; the fake clock runs every retry inside this test.
        vi.mocked(api.documents.createRequest).mockClear().mockRejectedValueOnce(notFound).mockRejectedValueOnce(notFound).mockRejectedValueOnce(notFound).mockRejectedValueOnce(notFound);
        act(() => session!.setPendingComment({ from: 0, to: 5 }));
        const again = (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
        await type(again, "@alice/Copilot-CLI again");
        await screen.findByTestId("composer-agent-row");
        fireEvent.click(screen.getByTestId("comment-submit"));
        await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
        await act(() => vi.advanceTimersByTimeAsync(2000));
        expect(api.documents.createRequest).toHaveBeenCalledTimes(4);
        expect(onToast).toHaveBeenCalledWith("The comment is posted, but the request did not reach the agent — mention them again.", "error");
        expect(session!.comments.list()).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a refused request (403 agent-owner-only, 400 unknown-agent) shows the server's sentence and keeps the comment; no retry (#1296)", async () => {
      const { onToast } = mount();
      const box = await openComposer();
      await type(box, "@alice/Copilot-CLI summarise");
      await screen.findByTestId("composer-agent-row");
      const locked = Object.assign(new Error("Alice's Copilot CLI only takes requests from Alice"), { status: 403 });
      vi.mocked(api.documents.createRequest).mockRejectedValueOnce(locked);
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(onToast).toHaveBeenCalledWith("The comment is posted, but the request was refused: Alice's Copilot CLI only takes requests from Alice", "error"));
      expect(api.documents.createRequest).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.documents.createRequest).mock.calls[0][1]).toMatchObject({ agent: "alice/Copilot-CLI", instruction: "summarise" });
      expect(session!.comments.list()).toHaveLength(1);

      const unknown = Object.assign(new Error("Unknown agent @alice/copilot-cli"), { status: 400 });
      vi.mocked(api.documents.createRequest).mockClear().mockRejectedValueOnce(unknown);
      act(() => session!.setPendingComment({ from: 0, to: 5 }));
      const again = (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
      await type(again, "@alice/Copilot-CLI again");
      await screen.findByTestId("composer-agent-row");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(onToast).toHaveBeenCalledWith("The comment is posted, but the request was refused: Unknown agent @alice/copilot-cli", "error"));
      expect(api.documents.createRequest).toHaveBeenCalledTimes(1);
      expect(session!.comments.list()).toHaveLength(2);
    });

    it("does not post before the session is synced", async () => {
      mount();
      session!.synced = false;
      const waited = waitForSynced(session!, 200);
      let settled = false;
      void waited.then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 30));
      expect(settled).toBe(false);
      session!.synced = true;
      act(() => session!.setMode("editing"));
      await waited;
      expect(settled).toBe(true);
    });

    it("shows the thread's latest request as a chip: waiting → working → done (with detail), and nothing once cancelled", async () => {
      const { user } = mount();
      const threadId = session!.comments.add({ from: 16, to: 27, body: "@alice/Copilot-CLI shorter", author: user });
      expect(screen.queryByTestId("comment-request-chip")).toBeNull();
      setMirrors([mirror({ id: "r1", threadId, status: "open" })]);
      const chip = await screen.findByTestId("comment-request-chip");
      expect(chip).toHaveAttribute("data-status", "open");
      expect(chip).toHaveTextContent("Waiting for an agent");
      // The chip is in the header row, before the ⋯ actions.
      const card = screen.getByTestId("comment-thread");
      const order = Array.from(card.querySelectorAll("[data-testid]")).map((el) => el.getAttribute("data-testid"));
      expect(order.indexOf("comment-timestamp")).toBeLessThan(order.indexOf("comment-request-chip"));
      expect(order.indexOf("comment-request-chip")).toBeLessThan(order.indexOf("comment-resolve"));
      setMirrors([mirror({ id: "r1", threadId, status: "claimed", claimedBy: "Copilot CLI" })]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveTextContent("Copilot CLI is working…"));
      // A newer request on the same thread wins.
      setMirrors([
        mirror({ id: "r1", threadId, status: "done", result: { suggestions: 2, comments: 0 }, updatedAt: Date.now() - 1000 }),
        mirror({ id: "r2", threadId, status: "claimed", claimedBy: "Copilot CLI", updatedAt: Date.now() }),
      ]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveAttribute("data-request-id", "r2"));
      setMirrors([mirror({ id: "r2", threadId, status: "done", result: { suggestions: 2, comments: 1 } })]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveTextContent("Done: 2 suggestions, 1 comment"));
      // Detail is for the first minute; older done requests collapse to a plain Done.
      setMirrors([mirror({ id: "r2", threadId, status: "done", result: { suggestions: 2, comments: 1 }, updatedAt: Date.now() - 120_000 })]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveTextContent(/^Done$/));
      setMirrors([mirror({ id: "r2", threadId, status: "cancelled" })]);
      await waitFor(() => expect(screen.queryByTestId("comment-request-chip")).toBeNull());
    });

    it("falls back to the requestId the server stamped on the thread when the mirror has no threadId", async () => {
      const { user } = mount();
      const threadId = session!.comments.add({ from: 16, to: 27, body: "@alice/Copilot-CLI shorter", author: user });
      act(() => session!.comments.ymap.get(threadId)!.set("requestId", "legacy"));
      setMirrors([mirror({ id: "legacy", status: "claimed", claimedBy: "Copilot CLI", threadId: undefined })]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveAttribute("data-request-id", "legacy"));
    });

    it("the chip names someone else's agent with its owner — 'Alice's Copilot CLI is working…' — and the owner's own plainly (#1296)", async () => {
      const { user } = mount({ role: "editor", me: { id: "drew", name: "Drew", login: "drew" } });
      const threadId = session!.comments.add({ from: 16, to: 27, body: "@alice/Copilot-CLI shorter", author: user });
      await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
      setMirrors([mirror({ id: "r1", threadId, status: "claimed", claimedBy: "Copilot CLI", claimedByLogin: "alice", userId: "drew" })]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveTextContent("Alice's Copilot CLI is working…"));
      // A mirror from before #1296 has no claimedByLogin: nobody knows whose it is, so the bare name stays.
      setMirrors([mirror({ id: "r1", threadId, status: "claimed", claimedBy: "Copilot CLI", userId: "drew" })]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveTextContent(/^Copilot CLI is working…/));
      cleanup();
      session!.destroy();

      mount();
      const ownThread = session!.comments.add({ from: 16, to: 27, body: "@alice/Copilot-CLI shorter", author: makeCollabUser("alice", "Alice", null, "alice") });
      setMirrors([mirror({ id: "r2", threadId: ownThread, status: "claimed", claimedBy: "Copilot CLI", claimedByLogin: "alice" })]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveTextContent(/^Copilot CLI is working…/));
    });

    describe("the request chip only re-renders for an agent's name (#1382)", () => {
      const remotes: Awareness[] = [];
      afterEach(() => {
        for (const a of remotes.splice(0)) a.destroy();
        vi.mocked(claimerName).mockClear();
        window.localStorage.removeItem(AGENT_CONNECT_DISMISSED_KEY);
      });
      /** How often the chips asked for a claimer's label so far: one call per RequestChip render of a claimed request. */
      const labelCalls = () => vi.mocked(claimerName).mock.calls.length;
      /**
       * Another browser or an agent, as the server relays it: `join` publishes its awareness state into the session's
       * awareness (a person: `login`; an agent: `isAgent` with its owner's `userLogin`/`userName`, the shape
       * src/server/agent-presence.ts writes) and `leave` removes it; each then fires the provider's awareness callback
       * (what Hocuspocus does) and waits a tick so the session's microtask notification and React's render are done.
       */
      const remote = () => {
        const doc = new Y.Doc();
        const awareness = new Awareness(doc);
        remotes.push(awareness);
        const relay = async (change: () => void) => {
          await act(async () => {
            change();
            lastProvider().opts.onAwarenessChange?.({ states: [] });
            await new Promise((r) => setTimeout(r, 0));
          });
        };
        return {
          join: (user: Record<string, unknown>) =>
            relay(() => {
              awareness.setLocalState({ user: { color: "#2563eb", colorLight: "#2563eb33", avatar: null, role: "editor", ...user }, lastActive: Date.now() });
              applyAwarenessUpdate(session!.awareness, encodeAwarenessUpdate(awareness, [doc.clientID]), "server");
            }),
          leave: () => relay(() => removeAwarenessStates(session!.awareness, [doc.clientID], "server")),
        };
      };
      const agentUser = (name: string, ownerLogin: string, ownerName: string | null) => ({ id: `agent:${ownerLogin}:${name}`, name, login: null, role: null, isAgent: true, status: "reading", userLogin: ownerLogin, userName: ownerName });
      // Listed by the collaborators route without its owner's name (Olive is in no one's collaborator list here): the
      // login stands in on the chip until Olive's agent shows up in presence carrying `userName`.
      const SCRIBE = { name: "Scribe", login: "olive/Scribe", ownerLogin: "olive", ownerName: null, present: false, collaboratorsMayAsk: true };
      const chips = () => screen.getAllByTestId("comment-request-chip").map((c) => [c.getAttribute("data-status"), c.getAttribute("data-request-id"), c.textContent]);

      it("does not render unchanged comment cards when document text changes outside their anchors", async () => {
        const { user } = mount({ role: "editor", me: { id: "drew", name: "Drew", login: "drew" }, agents: [AGENT, SCRIBE] });
        const ids = Array.from({ length: 20 }, () => session!.comments.add({ from: 0, to: 5, body: "@olive/Scribe shorter", author: user }));
        setMirrors(ids.map((threadId, index) => mirror({
          id: `r${index}`, threadId, status: "claimed", claimedBy: "Scribe", claimedByLogin: "olive", userId: "drew",
        })));
        await waitFor(() => expect(chips()).toHaveLength(20));
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        const before = labelCalls();
        const original = session!.comments.list();
        await act(async () => {
          session!.ytext.insert(session!.ytext.length, "!");
          session!.setMode("suggesting");
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(session!.comments.list().every((thread, index) => thread === original[index])).toBe(true);
        expect(labelCalls() - before).toBe(0);
        expect(chips()).toHaveLength(20);
      });

      it("a person joining or leaving presence never re-renders a claimed chip; an agent's owner name arriving does", async () => {
        const { user } = mount({ role: "editor", me: { id: "drew", name: "Drew", login: "drew" }, agents: [AGENT, SCRIBE] });
        const first = session!.comments.add({ from: 0, to: 5, body: "@olive/Scribe shorter", author: user });
        const second = session!.comments.add({ from: 16, to: 27, body: "@olive/Scribe and this", author: user });
        setMirrors([
          mirror({ id: "r1", threadId: first, status: "claimed", claimedBy: "Scribe", claimedByLogin: "olive", userId: "drew" }),
          mirror({ id: "r2", threadId: second, status: "claimed", claimedBy: "Scribe", claimedByLogin: "olive", userId: "drew" }),
        ]);
        await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
        await waitFor(() => expect(chips().map((c) => c[2])).toEqual(["olive's Scribe is working…", "olive's Scribe is working…"]));
        // Let a tick pass so the collaborators fetch and the first renders are behind us.
        await act(() => new Promise((r) => setTimeout(r, 20)));
        const chipsBefore = chips();
        const before = labelCalls();
        expect(before).toBeGreaterThan(0);

        // A person joins and leaves: the picker's candidate list changes twice, the chips have nothing new to say.
        const carol = remote();
        await carol.join({ id: "carol", name: "Carol", login: "carol" });
        expect(session!.presence().map((u) => u.login)).toContain("carol");
        expect.soft(labelCalls() - before).toBe(0);
        await carol.leave();
        expect(session!.presence().map((u) => u.login)).not.toContain("carol");
        expect.soft(labelCalls() - before).toBe(0);
        expect(chips()).toEqual(chipsBefore);

        // The same channel does reach the chips when it carries an agent's name.
        const scribe = remote();
        await scribe.join(agentUser("Scribe", "olive", "Olive"));
        await waitFor(() => expect(chips().map((c) => c[2])).toEqual(["Olive's Scribe is working…", "Olive's Scribe is working…"]));
        expect(labelCalls() - before).toBeGreaterThanOrEqual(2);
      });

      it("your own agent stays bare, also once it is present carrying your name", async () => {
        const { user } = mount({ role: "editor", me: { id: "drew", name: "Drew", login: "drew" }, agents: [AGENT, SCRIBE] });
        const theirs = session!.comments.add({ from: 0, to: 5, body: "@olive/Scribe shorter", author: user });
        const mine = session!.comments.add({ from: 16, to: 27, body: "@drew/Copilot-CLI and this", author: user });
        setMirrors([
          mirror({ id: "r1", threadId: theirs, status: "claimed", claimedBy: "Scribe", claimedByLogin: "olive", userId: "drew" }),
          mirror({ id: "r2", threadId: mine, status: "claimed", claimedBy: "Copilot CLI", claimedByLogin: "drew", userId: "drew" }),
        ]);
        await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
        await waitFor(() => expect(chips().map((c) => c[2])).toEqual(["olive's Scribe is working…", "Copilot CLI is working…"]));
        const own = remote();
        await own.join(agentUser("Copilot CLI", "drew", "Drew"));
        const scribe = remote();
        await scribe.join(agentUser("Scribe", "olive", "Olive"));
        await waitFor(() => expect(chips().map((c) => c[2])).toEqual(["Olive's Scribe is working…", "Copilot CLI is working…"]));
      });

      it("the picker's own-token fetch and the 'Connect an agent' row appearing and being dismissed never re-render a claimed chip", async () => {
        const { user } = mount({ role: "editor", me: { id: "drew", name: "Drew", login: "drew" } });
        const threadId = session!.comments.add({ from: 30, to: 35, body: "@alice/Copilot-CLI shorter", author: user });
        setMirrors([mirror({ id: "r1", threadId, status: "claimed", claimedBy: "Copilot CLI", claimedByLogin: "alice", userId: "drew" })]);
        await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveTextContent("Alice's Copilot CLI is working…"));
        await act(() => new Promise((r) => setTimeout(r, 20)));
        const before = labelCalls();
        // A new-comment composer (outside the card) opens its picker: the panel fetches Drew's tokens, finds none, and
        // `connect.due` flips on; dismissing the row flips it off. Neither concerns the card's chip.
        const box = await openComposer();
        await type(box, "@");
        await screen.findByTestId("mention-connect-row");
        await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));
        await act(() => new Promise((r) => setTimeout(r, 20)));
        expect.soft(labelCalls() - before).toBe(0);
        fireEvent.click(screen.getByTestId("mention-connect-dismiss"));
        await waitFor(() => expect(screen.queryByTestId("mention-connect-row")).toBeNull());
        await act(() => new Promise((r) => setTimeout(r, 20)));
        expect.soft(labelCalls() - before).toBe(0);
        expect(screen.getByTestId("comment-request-chip")).toHaveTextContent("Alice's Copilot CLI is working…");
      });
    });

    it("the picker greys out an agent its owner keeps to themself; picking it still mentions, but the composer refuses to send (#1296)", async () => {
      mount({ role: "editor", me: { id: "drew", name: "Drew", login: "drew" } });
      const box = await openComposer();
      await type(box, "@");
      const options = await screen.findAllByTestId("mention-option");
      expect(options.map((o) => o.getAttribute("data-login"))).toEqual(["alice", "bob", "alice/Copilot-CLI"]);
      const [alice, bob, agent] = options;
      expect(alice).not.toHaveAttribute("aria-disabled");
      expect(bob).not.toHaveAttribute("aria-disabled");
      expect(agent).toHaveAttribute("aria-disabled", "true");
      expect(agent).toHaveAttribute("data-locked");
      expect(agent).toHaveAttribute("title", "Only Alice can ask this agent");
      expect(agent).toHaveTextContent("Alice's Copilot CLI");
      expect(agent).toHaveTextContent("owner only");
      expect(screen.getAllByTestId("mention-option").filter((o) => o.hasAttribute("data-locked"))).toHaveLength(1);

      fireEvent.click(agent);
      await waitFor(() => expect(box.value).toBe("@alice/Copilot-CLI "));
      await type(box, "tighten this");
      await screen.findByTestId("composer-agent-row");
      const notice = screen.getByTestId("agent-owner-only");
      expect(notice).toHaveTextContent("Alice's Copilot CLI only takes requests from Alice.");
      // A sibling after the row, not inside it: the row stays controls only.
      expect(screen.getByTestId("composer-agent-row").contains(notice)).toBe(false);
      expect(screen.getByTestId("composer-agent-row").nextElementSibling).toBe(notice);
      expect(screen.getByTestId("comment-submit")).toBeDisabled();
      // Enter does nothing either: no comment, no request, no 403 round trip.
      fireEvent.keyDown(box, { key: "Enter" });
      fireEvent.click(screen.getByTestId("comment-submit"));
      await new Promise((r) => setTimeout(r, 30));
      expect(session!.comments.list()).toHaveLength(0);
      expect(api.documents.createRequest).not.toHaveBeenCalled();
      // Take the agent out of the body: the notice goes and the send comes back.
      fireEvent.change(box, { target: { value: "@bob tighten this" } });
      await waitFor(() => expect(screen.queryByTestId("agent-owner-only")).toBeNull());
      expect(screen.getByTestId("comment-submit")).toBeEnabled();
    });

    it("an agent whose owner switched 'Collaborators may ask' on is an ordinary row for others, and the owner's own is never locked (#1296)", async () => {
      mount({ role: "editor", me: { id: "drew", name: "Drew", login: "drew" }, agents: [{ ...AGENT, collaboratorsMayAsk: true }] });
      let box = await openComposer();
      await type(box, "@ali");
      let options = await screen.findAllByTestId("mention-option");
      let agent = options.find((o) => o.getAttribute("data-login") === AGENT.login)!;
      expect(agent).not.toHaveAttribute("aria-disabled");
      expect(agent).not.toHaveAttribute("data-locked");
      expect(agent).toHaveTextContent("Alice's Copilot CLI");
      fireEvent.click(agent);
      await screen.findByTestId("composer-agent-row");
      expect(screen.queryByTestId("agent-owner-only")).toBeNull();
      expect(screen.getByTestId("comment-submit")).toBeEnabled();
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
      expect(vi.mocked(api.documents.createRequest).mock.calls[0][1]).toMatchObject({ agent: "alice/Copilot-CLI" });
      cleanup();
      session!.destroy();

      mount();
      box = await openComposer();
      await type(box, "@ali");
      options = await screen.findAllByTestId("mention-option");
      agent = options.find((o) => o.getAttribute("data-login") === AGENT.login)!;
      expect(agent).not.toHaveAttribute("aria-disabled");
      expect(agent).toHaveTextContent(/^Copilot CLIagent$/);
    });

    it.each([
      ["the requester", { id: "carol", name: "Carol", login: "carol" }, "commenter" as Role, true],
      ["the document owner", { id: "alice", name: "Alice", login: "alice" }, "owner" as Role, true],
      ["another collaborator", { id: "bob", name: "Bob", login: "bob" }, "editor" as Role, false],
    ])("the × cancels for %s", async (_who, me, role, canCancel) => {
      const onCancelRequest = vi.fn();
      const { user } = mount({ role, me, onCancelRequest });
      const threadId = session!.comments.add({ from: 16, to: 27, body: "@alice/Copilot-CLI shorter", author: user });
      setMirrors([mirror({ id: "r1", threadId, status: "open", userId: "carol" })]);
      await screen.findByTestId("comment-request-chip");
      const cancel = screen.queryByTestId("comment-request-cancel");
      if (!canCancel) {
        expect(cancel).toBeNull();
        return;
      }
      expect(cancel).toHaveAccessibleName("Cancel request");
      fireEvent.click(cancel!);
      expect(onCancelRequest).toHaveBeenCalledWith("r1");
      // Optimistic: the chip is gone at once and the card was not "revealed" by the click.
      expect(screen.queryByTestId("comment-request-chip")).toBeNull();
      setMirrors([mirror({ id: "r1", threadId, status: "cancelled", userId: "carol" })]);
      await new Promise((r) => setTimeout(r, 10));
      expect(screen.queryByTestId("comment-request-chip")).toBeNull();
    });

    it("no × once the request is done", async () => {
      const { user } = mount({ onCancelRequest: vi.fn() });
      const threadId = session!.comments.add({ from: 16, to: 27, body: "@alice/Copilot-CLI shorter", author: user });
      setMirrors([mirror({ id: "r1", threadId, status: "done", result: { suggestions: 1, comments: 0 } })]);
      await screen.findByTestId("comment-request-chip");
      expect(screen.queryByTestId("comment-request-cancel")).toBeNull();
    });

    it("a reply that mentions an agent asks on the thread, preselecting the thread's last mode", async () => {
      const { user } = mount();
      const threadId = session!.comments.add({ from: 16, to: 27, body: "First thoughts", author: user });
      setMirrors([mirror({ id: "r1", threadId, status: "done", mode: "comment", result: { suggestions: 0, comments: 1 } })]);
      await screen.findByTestId("comment-request-chip");
      fireEvent.click(screen.getByTestId("comment-reply"));
      const box = (await screen.findByPlaceholderText("Reply…")) as HTMLTextAreaElement;
      await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
      await type(box, "@alice/Copilot-CLI and the numbers?");
      await screen.findByTestId("composer-agent-row");
      expect(screen.getByTestId("composer-mode-comment")).toHaveAttribute("aria-checked", "true");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
      expect(api.documents.createRequest).toHaveBeenCalledWith("doc", {
        mode: "comment",
        instruction: "and the numbers?",
        selection: { from: 16, to: 27, quote: "quick brown" },
        threadId,
        agent: "alice/Copilot-CLI",
      });
      expect(session!.comments.list()[0].replies).toHaveLength(1);
    });

    it("quick-instruction chips insert after the mention and keep the caret in the box", async () => {
      mount();
      const box = await openComposer();
      await type(box, "@alice/Copilot-CLI");
      await screen.findByTestId("composer-agent-row");
      const chips = screen.getAllByTestId("composer-chip");
      const first = chips[0].textContent!;
      fireEvent.click(chips[0]);
      await waitFor(() => expect(box.value).toBe(`@alice/Copilot-CLI ${first}`));
      await waitFor(() => expect(box).toHaveFocus());
      expect(box.selectionStart).toBe(box.value.length);
      // With text past the mention the chip goes at the caret, spaced.
      box.setSelectionRange(box.value.length, box.value.length);
      const second = chips[1].textContent!;
      fireEvent.click(chips[1]);
      await waitFor(() => expect(box.value).toBe(`@alice/Copilot-CLI ${first} ${second}`));
      expect(screen.getByTestId("composer-agent-row")).toBeInTheDocument();
    });

    it("the edit composer never offers the row", async () => {
      const { user } = mount();
      session!.comments.add({ from: 16, to: 27, body: "@alice/Copilot-CLI shorter", author: user });
      // The lazily mounted menu arms and opens on pointer down.
      fireEvent.pointerDown(await screen.findByRole("button", { name: "Comment actions" }), { button: 0 });
      fireEvent.click(await screen.findByText("Edit"));
      const box = (await screen.findByDisplayValue("@alice/Copilot-CLI shorter")) as HTMLTextAreaElement;
      await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
      fireEvent.change(box, { target: { value: "@alice/Copilot-CLI shorter still" } });
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByTestId("composer-agent-row")).toBeNull();
    });

    it("mentionedAgents matches the picker's agents case-insensitively, once each, in order", () => {
      const candidates = [
        { login: "bob", name: "Bob", image: null },
        { login: "alice/Copilot-CLI", name: "Copilot CLI", image: null, agent: { ownerLogin: "alice", canAsk: true } },
        { login: "bob/Reviewer", name: "Reviewer", image: null, agent: { ownerLogin: "bob", canAsk: true } },
      ];
      expect(mentionedAgents("@bob/reviewer then @ALICE/copilot-cli and @bob/Reviewer again", candidates).map((c) => c.name)).toEqual(["Reviewer", "Copilot CLI"]);
      expect(mentionedAgents("@bob only, and @alice/Other-Bot", candidates)).toEqual([]);
    });

    it("the picker lists the user's own tokens once it opens, marked as not here yet", async () => {
      vi.mocked(api.tokens.list).mockClear().mockResolvedValue({ tokens: [{ id: "t1", name: "Copilot CLI" }, { id: "t2", name: "Night Shift" }] } as never);
      mount();
      const box = await openComposer();
      await new Promise((r) => setTimeout(r, 20));
      // Not on panel mount, nor on opening a composer: only once a picker opens.
      expect(api.tokens.list).not.toHaveBeenCalled();
      await type(box, "@");
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));
      const options = await screen.findAllByTestId("mention-option");
      const logins = options.map((o) => o.getAttribute("data-login"));
      expect(logins).toEqual(["bob", "alice/Copilot-CLI", "alice/Night-Shift"]);
      // The document already knows Copilot CLI (activity): its entry is the ordinary one, not the own-token hint.
      expect(options[1]).not.toHaveAttribute("data-own");
      expect(options[2]).toHaveAttribute("data-own");
      expect(options[2]).toHaveTextContent("your agent · not here yet");
      // Choosing the own token makes the row appear: it is a request too.
      fireEvent.click(options[2]);
      await screen.findByTestId("composer-agent-row");
      expect(screen.getByRole("radiogroup", { name: "How should Night Shift answer?" })).toBeInTheDocument();
    });
  });

  describe("mention candidate identity lifecycle", () => {
    const ownedSessions = new Set<CollabSession>();
    const remoteAwareness = new Set<Awareness>();

    const collaboratorResponse = (opts: {
      owner?: { login: string; name: string; image: null } | null;
      collaborators?: { login: string; name: string; image: null }[];
      agents?: CollaboratorsResponse["agents"];
    } = {}) =>
      ({
        owner: opts.owner ?? null,
        collaborators: opts.collaborators ?? [],
        agents: opts.agents ?? [],
      }) as CollaboratorsResponse;

    const tokenResponse = (...names: string[]) =>
      ({
        tokens: names.map((name, index) => ({ id: `token-${index}`, name })),
      }) as TokensResponse;

    const makeSession = (docId: string, name: string, login: string | null) => {
      const user = makeCollabUser(`${docId}-${login ?? "anonymous"}`, name, null, login);
      const next = new CollabSession({ docId, user, role: "owner", getToken: async () => "token", autoConnect: false });
      next.keepAlive();
      next.setPendingComment({ from: 0, to: 0 });
      ownedSessions.add(next);
      session = next;
      return next;
    };

    const addPresence = (target: CollabSession, user: Record<string, unknown>) => {
      const doc = new Y.Doc();
      const awareness = new Awareness(doc);
      remoteAwareness.add(awareness);
      awareness.setLocalState({ user: { color: "#2563eb", colorLight: "#2563eb33", avatar: null, role: "editor", ...user }, lastActive: Date.now() });
      applyAwarenessUpdate(target.awareness, encodeAwarenessUpdate(awareness, [doc.clientID]), "server");
    };

    const panel = (current: CollabSession) => (
      <TooltipProvider>
        <CommentsPanel session={current} onClose={() => {}} onReveal={() => {}} onCreateToken={() => {}} />
      </TooltipProvider>
    );

    const mountPanel = (initial: CollabSession) => {
      const view = render(panel(initial));
      return {
        replace(next: CollabSession) {
          session = next;
          view.rerender(panel(next));
        },
        unmount: view.unmount,
      };
    };

    const openPicker = async () => {
      const box = (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
      box.focus();
      await userEvent.setup().paste("@");
      return box;
    };

    const option = (login: string) => screen.queryAllByTestId("mention-option").find((row) => row.getAttribute("data-login") === login);

    beforeEach(() => {
      vi.mocked(api.tokens.list).mockReset().mockResolvedValue({ tokens: [] } as never);
      vi.mocked(api.documents.collaborators).mockReset().mockResolvedValue({ owner: null, collaborators: [], agents: [] } as never);
    });

    afterEach(() => {
      for (const awareness of remoteAwareness) awareness.destroy();
      remoteAwareness.clear();
      for (const owned of ownedSessions) owned.destroy();
      ownedSessions.clear();
      session = null;
      window.localStorage.removeItem(AGENT_CONNECT_DISMISSED_KEY);
      vi.mocked(api.tokens.list).mockReset().mockResolvedValue({ tokens: [] } as never);
      vi.mocked(api.documents.collaborators).mockReset().mockResolvedValue({ owner: null, collaborators: [], agents: [] } as never);
    });

    it("shows only current presence while replacement viewer requests settle, then publishes only current collaborators, agents, permissions, and tokens", async () => {
      const oldCollaborators = deferred<CollaboratorsResponse>();
      const currentCollaborators = deferred<CollaboratorsResponse>();
      const oldTokens = deferred<TokensResponse>();
      const currentTokens = deferred<TokensResponse>();
      vi.mocked(api.documents.collaborators).mockImplementationOnce(() => oldCollaborators.promise).mockImplementationOnce(() => currentCollaborators.promise);
      vi.mocked(api.tokens.list).mockImplementationOnce(() => oldTokens.promise).mockImplementationOnce(() => currentTokens.promise);

      const oldSession = makeSession("old-doc", "Alice", "Alice");
      const view = mountPanel(oldSession);
      await openPicker();
      await waitFor(() => {
        expect(api.documents.collaborators).toHaveBeenCalledTimes(1);
        expect(api.tokens.list).toHaveBeenCalledTimes(1);
      });

      const currentSession = makeSession("current-doc", "Carol", "CAROL");
      addPresence(currentSession, { id: "live", name: "Live Person", login: "live" });
      addPresence(currentSession, {
        id: "agent:old-owner:Shared Agent",
        name: "Shared Agent",
        login: null,
        isAgent: true,
        status: "reading",
        userLogin: "old-owner",
        userName: "Old Owner",
      });
      view.replace(currentSession);
      await waitFor(() => {
        expect(api.documents.collaborators).toHaveBeenCalledTimes(2);
        expect(api.tokens.list).toHaveBeenCalledTimes(2);
        expect(option("live")).toBeVisible();
      });
      expect(option("old-owner/Shared-Agent")).toHaveAttribute("data-locked");

      await act(async () => {
        oldCollaborators.resolve(
          collaboratorResponse({
            collaborators: [{ login: "retired", name: "Retired Person", image: null }],
            agents: [
              { name: "Retired Agent", login: "alice/Retired-Agent", ownerLogin: "alice", ownerName: "Alice", present: false, collaboratorsMayAsk: true },
              { name: "Shared Agent", login: "old-owner/Shared-Agent", ownerLogin: "old-owner", ownerName: "Old Owner", present: false, collaboratorsMayAsk: true },
            ],
          }),
        );
        oldTokens.resolve(tokenResponse("Old Token"));
        await Promise.all([oldCollaborators.promise, oldTokens.promise]);
      });
      expect(option("retired")).toBeUndefined();
      expect(option("alice/Retired-Agent")).toBeUndefined();
      expect(option("alice/Old-Token")).toBeUndefined();
      expect(option("old-owner/Shared-Agent")).toHaveAttribute("data-locked");

      await act(async () => {
        currentCollaborators.resolve(
          collaboratorResponse({
            owner: { login: "carol", name: "Carol", image: null },
            collaborators: [{ login: "current", name: "Current Person", image: null }],
            agents: [{ name: "Current Agent", login: "drew/Current-Agent", ownerLogin: "drew", ownerName: "Drew", present: false, collaboratorsMayAsk: true }],
          }),
        );
        currentTokens.resolve(tokenResponse("Current Token"));
        await Promise.all([currentCollaborators.promise, currentTokens.promise]);
      });
      await waitFor(() => {
        expect(option("current")).toBeVisible();
        expect(option("drew/Current-Agent")).not.toHaveAttribute("data-locked");
        expect(option("CAROL/Current-Token")).toHaveAttribute("data-own");
      });
      expect(option("retired")).toBeUndefined();
      expect(api.documents.collaborators).toHaveBeenCalledTimes(2);
      expect(api.tokens.list).toHaveBeenCalledTimes(2);
    });

    it("keeps a same-viewer replacement session empty until its own evidence settles, including the Connect-an-agent decision", async () => {
      const oldCollaborators = deferred<CollaboratorsResponse>();
      const currentCollaborators = deferred<CollaboratorsResponse>();
      const oldTokens = deferred<TokensResponse>();
      const currentTokens = deferred<TokensResponse>();
      vi.mocked(api.documents.collaborators).mockImplementationOnce(() => oldCollaborators.promise).mockImplementationOnce(() => currentCollaborators.promise);
      vi.mocked(api.tokens.list).mockImplementationOnce(() => oldTokens.promise).mockImplementationOnce(() => currentTokens.promise);

      const view = mountPanel(makeSession("first-doc", "Alice", "Alice"));
      await openPicker();
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));

      const replacement = makeSession("second-doc", "Alice", "alice");
      addPresence(replacement, { id: "current-live", name: "Current Live", login: "current-live" });
      view.replace(replacement);
      await waitFor(() => {
        expect(api.documents.collaborators).toHaveBeenCalledTimes(2);
        expect(api.tokens.list).toHaveBeenCalledTimes(2);
        expect(option("current-live")).toBeVisible();
      });

      await act(async () => {
        oldCollaborators.resolve(collaboratorResponse({ collaborators: [{ login: "first-doc-person", name: "First Doc Person", image: null }] }));
        oldTokens.resolve(tokenResponse());
        await Promise.all([oldCollaborators.promise, oldTokens.promise]);
      });
      expect(option("first-doc-person")).toBeUndefined();
      expect(screen.queryByTestId("mention-connect-row")).toBeNull();

      await act(async () => {
        currentCollaborators.resolve(collaboratorResponse({ collaborators: [{ login: "second-doc-person", name: "Second Doc Person", image: null }] }));
        currentTokens.resolve(tokenResponse());
        await Promise.all([currentCollaborators.promise, currentTokens.promise]);
      });
      expect(await screen.findByTestId("mention-connect-row")).toBeVisible();
      expect(option("second-doc-person")).toBeVisible();
      expect(api.documents.collaborators).toHaveBeenCalledTimes(2);
      expect(api.tokens.list).toHaveBeenCalledTimes(2);
    });

    it("does not let an old picker opening eagerly load tokens for a closed replacement session", async () => {
      vi.mocked(api.documents.collaborators).mockResolvedValue(collaboratorResponse({ collaborators: [{ login: "person", name: "Person", image: null }] }));
      vi.mocked(api.tokens.list).mockResolvedValue(tokenResponse("Agent"));

      const oldSession = makeSession("old-doc", "Alice", "alice");
      const view = mountPanel(oldSession);
      await openPicker();
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));
      act(() => oldSession.setPendingComment(null));
      await waitFor(() => expect(screen.queryByTestId("comment-composer")).toBeNull());

      const replacement = makeSession("replacement-doc", "Carol", "carol");
      replacement.setPendingComment(null);
      view.replace(replacement);
      await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalledTimes(2));
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(api.tokens.list).toHaveBeenCalledTimes(1);

      act(() => replacement.setPendingComment({ from: 0, to: 0 }));
      await openPicker();
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(2));
    });

    it("publishes no old viewer result or failure after replacement with a null-login viewer", async () => {
      const oldCollaborators = deferred<CollaboratorsResponse>();
      const currentCollaborators = deferred<CollaboratorsResponse>();
      const oldTokens = deferred<TokensResponse>();
      vi.mocked(api.documents.collaborators).mockImplementationOnce(() => oldCollaborators.promise).mockImplementationOnce(() => currentCollaborators.promise);
      vi.mocked(api.tokens.list).mockImplementationOnce(() => oldTokens.promise);
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

      const view = mountPanel(makeSession("old-doc", "Alice", "alice"));
      await openPicker();
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));

      const anonymous = makeSession("anonymous-doc", "Anonymous", null);
      addPresence(anonymous, { id: "anonymous-live", name: "Anonymous Live", login: "anonymous-live" });
      view.replace(anonymous);
      await waitFor(() => {
        expect(api.documents.collaborators).toHaveBeenCalledTimes(2);
        expect(option("anonymous-live")).toBeVisible();
      });
      expect(api.tokens.list).toHaveBeenCalledTimes(1);

      await act(async () => {
        currentCollaborators.resolve(collaboratorResponse({ collaborators: [{ login: "anonymous-current", name: "Anonymous Current", image: null }] }));
        oldCollaborators.reject(new Error("old collaborators failed"));
        oldTokens.reject(new Error("old tokens failed"));
        await Promise.allSettled([currentCollaborators.promise, oldCollaborators.promise, oldTokens.promise]);
      });
      expect(option("anonymous-current")).toBeVisible();
      expect(screen.queryByTestId("mention-connect-row")).toBeNull();
      expect(debug).not.toHaveBeenCalled();
      expect(api.tokens.list).toHaveBeenCalledTimes(1);
    });

    it("ignores collaborator success and token failure after unmount", async () => {
      const collaborators = deferred<CollaboratorsResponse>();
      const tokens = deferred<TokensResponse>();
      vi.mocked(api.documents.collaborators).mockImplementationOnce(() => collaborators.promise);
      vi.mocked(api.tokens.list).mockImplementationOnce(() => tokens.promise);
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

      const view = mountPanel(makeSession("unmounted-doc", "Alice", "alice"));
      await openPicker();
      await waitFor(() => {
        expect(api.documents.collaborators).toHaveBeenCalledTimes(1);
        expect(api.tokens.list).toHaveBeenCalledTimes(1);
      });
      view.unmount();

      await act(async () => {
        collaborators.resolve(collaboratorResponse({ collaborators: [{ login: "late", name: "Late Person", image: null }] }));
        tokens.reject(new Error("late tokens failed"));
        await Promise.allSettled([collaborators.promise, tokens.promise]);
      });
      expect(screen.queryByTestId("mention-option")).toBeNull();
      expect(screen.queryByTestId("mention-connect-row")).toBeNull();
      expect(debug).not.toHaveBeenCalled();
      expect(api.documents.collaborators).toHaveBeenCalledTimes(1);
      expect(api.tokens.list).toHaveBeenCalledTimes(1);
    });
  });

  describe("document comments, empty state and the connect row (#1025)", () => {
    const AGENT = { name: "Copilot CLI", login: "alice/Copilot-CLI", ownerLogin: "alice", present: false };
    const TEXT = "Intro text. The quick brown fox jumps.";
    const DISMISSED_KEY = "markdoc:agent-connect-dismissed";

    const mount = (opts: { role?: "owner" | "editor" | "commenter"; documentComposer?: CommentsPanelProps["documentComposer"]; onCreateToken?: () => void; collaborators?: boolean } = {}) => {
      Element.prototype.scrollIntoView ??= () => {};
      const user = makeCollabUser("alice", "Alice", null, "alice");
      session = new CollabSession({ docId: "doc", user, role: opts.role ?? "owner", getToken: async () => "token", autoConnect: false });
      session.keepAlive();
      session.synced = true;
      session.ytext.insert(0, TEXT);
      vi.mocked(api.documents.collaborators).mockResolvedValue(
        (opts.collaborators === false
          ? { owner: null, collaborators: [], agents: [] }
          : { owner: { login: "alice", name: "Alice", image: null }, collaborators: [{ login: "bob", name: "Bob", image: null }], agents: [AGENT] }) as unknown as Awaited<
          ReturnType<typeof api.documents.collaborators>
        >,
      );
      const onReveal = vi.fn<(offset: number) => void>();
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      const props = (documentComposer: CommentsPanelProps["documentComposer"]) => (
        <TooltipProvider>
          <CommentsPanel session={session!} onClose={() => {}} onReveal={onReveal} onToast={onToast} onCreateToken={opts.onCreateToken} documentComposer={documentComposer} />
        </TooltipProvider>
      );
      const view = render(props(opts.documentComposer ?? null));
      return { onReveal, onToast, user, setDocumentComposer: (next: CommentsPanelProps["documentComposer"]) => view.rerender(props(next)) };
    };
    const composer = async () => (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
    const paste = async (box: HTMLTextAreaElement, text: string) => {
      box.focus();
      await userEvent.setup().paste(text);
    };

    afterEach(() => {
      window.localStorage.removeItem(DISMISSED_KEY);
      vi.mocked(api.documents.createRequest).mockReset().mockResolvedValue({ request: { id: "req" } } as never);
      vi.mocked(api.tokens.list).mockClear().mockResolvedValue({ tokens: [] } as never);
      vi.mocked(api.documents.collaborators).mockResolvedValue({ owner: null, collaborators: [], agents: [] } as unknown as Awaited<ReturnType<typeof api.documents.collaborators>>);
    });

    it("the header button opens a composer on the whole document; the posted card says Whole document, anchors at {0,0} and reveals offset 0", async () => {
      const { onReveal } = mount();
      expect(screen.queryByTestId("pending-comment")).toBeNull();
      fireEvent.click(screen.getByTestId("comment-document"));
      const pending = await screen.findByTestId("pending-comment");
      expect(session!.pendingComment).toEqual({ from: 0, to: 0 });
      expect(within(pending).getByTestId("comment-quote-document")).toHaveTextContent("Whole document");
      expect(within(pending).queryByTestId("comment-quote")).toBeNull();
      // No anchored text: nothing to turn into a ```suggestion block.
      expect(within(pending).queryByTestId("comment-suggest-change")).toBeNull();
      const box = await composer();
      await waitFor(() => expect(box).toHaveFocus());
      expect(box.value).toBe("");
      await paste(box, "Overall: reads well, but the intro is long.");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(session!.comments.list()).toHaveLength(1));
      const [thread] = session!.comments.list();
      expect(thread.range).toEqual({ from: 0, to: 0 });
      expect(thread.quote).toBe("");
      const card = await screen.findByTestId("comment-thread");
      expect(within(card).getByTestId("comment-quote-document")).toHaveTextContent("Whole document");
      expect(within(card).queryByTestId("comment-quote")).toBeNull();
      // Typing at the start of the document does not move it: the anchor is the document, not its first character.
      act(() => session!.ytext.insert(0, "x".repeat(200)));
      expect(session!.comments.list()[0].range).toEqual({ from: 0, to: 0 });
      fireEvent.click(card);
      expect(onReveal).toHaveBeenCalledWith(0);
      // No agent was mentioned: no request.
      await new Promise((r) => setTimeout(r, 20));
      expect(api.documents.createRequest).not.toHaveBeenCalled();
    });

    it("the empty state's 'Comment and mention an agent' seeds `@`, opens the picker at once and posts a request with selection: null", async () => {
      mount();
      expect(screen.queryByText(/Ask an agent/)).toBeNull();
      fireEvent.click(await screen.findByTestId("comments-empty-agent"));
      const box = await composer();
      await waitFor(() => expect(box).toHaveFocus());
      expect(box.value).toBe("@");
      expect(box.selectionStart).toBe(1);
      expect(box.selectionEnd).toBe(1);
      // The picker is up before anything else is typed, and it fetched the user's own tokens.
      await screen.findByTestId("mention-suggestions", {}, { timeout: 300 });
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));
      const options = await screen.findAllByTestId("mention-option");
      fireEvent.click(options.find((o) => o.getAttribute("data-login") === AGENT.login)!);
      await screen.findByTestId("composer-agent-row");
      await paste(box, "review the whole thing");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
      const [thread] = session!.comments.list();
      expect(thread.range).toEqual({ from: 0, to: 0 });
      expect(api.documents.createRequest).toHaveBeenCalledWith("doc", {
        mode: "suggest",
        instruction: "review the whole thing",
        selection: null,
        threadId: thread.id,
        agent: "alice/Copilot-CLI",
      });
    });

    it("a reply that mentions an agent on a document thread also asks with selection: null", async () => {
      mount();
      const user = makeCollabUser("alice", "Alice", null, "alice");
      const id = session!.comments.add({ from: 0, to: 0, body: "Overall thoughts?", author: user });
      const card = await screen.findByTestId("comment-thread");
      fireEvent.click(within(card).getByTestId("comment-reply"));
      const box = (await screen.findByPlaceholderText(/Reply/)) as HTMLTextAreaElement;
      // No "Suggest a change" on a document thread's reply composer either.
      expect(screen.queryByTestId("comment-suggest-change")).toBeNull();
      await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
      await paste(box, `@${AGENT.login} what do you think?`);
      await screen.findByTestId("composer-agent-row");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
      expect(vi.mocked(api.documents.createRequest).mock.calls[0][1]).toMatchObject({ selection: null, threadId: id });
    });

    it("the shell's documentComposer request opens the composer (seeded when asked), and a later plain one starts empty", async () => {
      const { setDocumentComposer } = mount();
      setDocumentComposer({ mention: true, nonce: 1 });
      let box = await composer();
      await waitFor(() => expect(box.value).toBe("@"));
      await screen.findByTestId("mention-suggestions");
      // Esc with the picker open closes the picker; a second Esc cancels the composer.
      fireEvent.keyDown(box, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("mention-suggestions")).toBeNull());
      fireEvent.keyDown(box, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("pending-comment")).toBeNull());
      expect(session!.pendingComment).toBeNull();
      setDocumentComposer({ mention: false, nonce: 2 });
      box = await composer();
      expect(box.value).toBe("");
      expect(screen.getByTestId("comment-quote-document")).toHaveTextContent("Whole document");
    });

    it("a panel that mounts with documentComposer already set (the hint bar opens the panel and asks at once) is seeded too", async () => {
      mount({ documentComposer: { mention: true, nonce: 7 } });
      const box = await composer();
      await waitFor(() => expect(box.value).toBe("@"));
      expect(session!.pendingComment).toEqual({ from: 0, to: 0 });
      await screen.findByTestId("mention-suggestions");
      expect(screen.getByTestId("comment-quote-document")).toHaveTextContent("Whole document");
    });

    it("a suggestion on a document thread can be rejected but never accepted", async () => {
      mount({ role: "owner" });
      const user = makeCollabUser("alice", "Alice", null, "alice");
      session!.comments.add({ from: 0, to: 0, body: "Try this.\n\n```suggestion\nA whole new intro\n```", author: user });
      const card = await screen.findByTestId("comment-thread");
      expect(within(card).getByTestId("suggestion-box")).toHaveAttribute("data-state", "pending");
      expect(within(card).queryByTestId("suggestion-accept-comment")).toBeNull();
      expect(within(card).getByTestId("suggestion-reject-comment")).toBeVisible();
      fireEvent.click(within(card).getByTestId("suggestion-reject-comment"));
      await waitFor(() => expect(session!.comments.list()[0].suggestionState).toBe("rejected"));
      expect(session!.ytext.toString()).toBe(TEXT);
    });

    it("the `@` picker shows 'Connect an agent' for a user with no token, once, until dismissed — and never with a token", async () => {
      const onCreateToken = vi.fn();
      mount({ onCreateToken });
      act(() => session!.setPendingComment({ from: 16, to: 27 }));
      let box = await composer();
      await paste(box, "@");
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));
      const row = await screen.findByTestId("mention-connect-row");
      expect(row).toHaveTextContent("No agent connected yet");
      // The options are still listed above it.
      expect(screen.getAllByTestId("mention-option").length).toBeGreaterThan(0);
      expect(screen.getByTestId("mention-connect-docs")).toHaveAttribute("href", "https://github.com/burkeholland/markdoc/blob/main/docs/agents.md");
      expect(screen.getByTestId("mention-connect-docs")).toHaveAttribute("target", "_blank");
      fireEvent.click(screen.getByTestId("mention-connect-agent"));
      expect(onCreateToken).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId("mention-connect-dismiss"));
      await waitFor(() => expect(screen.queryByTestId("mention-connect-row")).toBeNull());
      expect(window.localStorage.getItem(DISMISSED_KEY)).toBe("1");
      // The list is still there; only the footer went.
      expect(screen.getAllByTestId("mention-option").length).toBeGreaterThan(0);

      // A fresh panel remembers the dismissal.
      cleanup();
      session!.destroy();
      mount({ onCreateToken });
      act(() => session!.setPendingComment({ from: 16, to: 27 }));
      box = await composer();
      await paste(box, "@");
      await screen.findAllByTestId("mention-option");
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByTestId("mention-connect-row")).toBeNull();

      // With a token the row is never due.
      cleanup();
      session!.destroy();
      window.localStorage.removeItem(DISMISSED_KEY);
      vi.mocked(api.tokens.list).mockClear().mockResolvedValue({ tokens: [{ id: "t1", name: "Copilot CLI" }] } as never);
      mount({ onCreateToken });
      act(() => session!.setPendingComment({ from: 16, to: 27 }));
      box = await composer();
      await paste(box, "@");
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));
      await screen.findAllByTestId("mention-option");
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByTestId("mention-connect-row")).toBeNull();
    });

    it("with nobody to mention, `@` still opens the picker for the connect row alone; without onCreateToken only the docs link is offered", async () => {
      mount({ collaborators: false });
      act(() => session!.setPendingComment({ from: 16, to: 27 }));
      const box = await composer();
      await paste(box, "@");
      const popover = await screen.findByTestId("mention-suggestions");
      expect(within(popover).queryByRole("listbox")).toBeNull();
      expect(within(popover).getByTestId("mention-connect-row")).toBeVisible();
      expect(within(popover).queryByTestId("mention-connect-agent")).toBeNull();
      expect(within(popover).getByTestId("mention-connect-docs")).toBeVisible();
      // Arrow keys and Enter with no options do nothing odd: Enter sends the comment as usual.
      fireEvent.keyDown(box, { key: "ArrowDown" });
      fireEvent.keyDown(box, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("mention-suggestions")).toBeNull());
      expect(box.value).toBe("@");
    });

    it("a viewer sees neither the header button nor the empty-state line", async () => {
      const user = makeCollabUser("vic", "Vic", null, "vic");
      session = new CollabSession({ docId: "doc", user, role: "viewer", getToken: async () => "token", autoConnect: false });
      session.keepAlive();
      render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);
      expect(screen.queryByTestId("comment-document")).toBeNull();
      expect(screen.queryByTestId("comments-empty-agent")).toBeNull();
      expect(await screen.findByText("No open comments")).toBeInTheDocument();
    });
  });
});