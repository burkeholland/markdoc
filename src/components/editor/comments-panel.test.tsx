// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { CommentsPanel, type CommentsPanelProps } from "./comments-panel";

describe("CommentsPanel accepted suggestion toast", () => {
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
});
