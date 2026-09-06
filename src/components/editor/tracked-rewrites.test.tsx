// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import { EditorState as RichState } from "prosemirror-state";
import { EditorView as RichView } from "prosemirror-view";
import { EditorView as SourceView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  return {
    HocuspocusProvider: class {
      awareness: InstanceType<typeof Awareness>;
      constructor(options: { document: Y.Doc }) { this.awareness = new Awareness(options.document); }
      destroy() { this.awareness.destroy(); }
    },
  };
});
vi.mock("@/lib/api", () => ({
  api: {
    documents: {
      collaborators: vi.fn().mockResolvedValue({ owner: null, collaborators: [], agents: [] }),
      reviews: vi.fn().mockResolvedValue({ reviews: [] }),
    },
    tokens: { list: vi.fn().mockResolvedValue({ tokens: [] }) },
  },
}));
vi.mock("@/lib/notifications-store", () => ({ markRefsRead: vi.fn(), useUnreadRefs: () => new Set<string>() }));

import { CollabSession } from "@/editor/collab/session";
import { createAnchor, makeCollabUser } from "@/editor/collab/shared";
import { CommentsModel } from "@/editor/collab/comments";
import { SuggestionsModel } from "@/editor/collab/suggestions";
import { diffSuggestionEdits } from "@/editor/sync/suggestion-diff";
import { markdownBindingPlugin } from "@/editor/sync/markdown-binding";
import { collectHighlights, richHighlightsPlugin } from "@/editor/prosemirror/highlights";
import { sourceHighlights, setHighlights } from "@/editor/codemirror/highlights";
import { REWRITE_AFTER, REWRITE_AUTHOR, REWRITE_BEFORE, REWRITE_DOCUMENT, REWRITE_RESULT } from "@/editor/collab/rewrite.test-fixture";
import { CommentsPanel } from "./comments-panel";

let session: CollabSession | undefined;
let rich: RichView | undefined;
let source: SourceView | undefined;
let unsubscribe: (() => void) | undefined;

afterEach(() => {
  cleanup();
  unsubscribe?.();
  rich?.destroy();
  source?.destroy();
  session?.destroy();
  session = undefined;
  source = undefined;
  rich = undefined;
  document.body.replaceChildren();
});

function setup(before = REWRITE_DOCUMENT, after = REWRITE_RESULT) {
  Element.prototype.scrollIntoView ??= () => {};
  session = new CollabSession({ docId: "synthetic", user: makeCollabUser("human", "Reviewer"), role: "owner", autoConnect: false, getToken: async () => { throw new Error("No network in this fixture"); } });
  session.keepAlive();
  // Deliver the agent operation as a remote Yjs update, not as the reviewer's undo item.
  const remote = new Y.Doc();
  const text = remote.getText("content");
  text.insert(0, before);
  const suggestions = new SuggestionsModel(remote, text);
  const edit = diffSuggestionEdits(before, after)[0];
  const id = suggestions.propose(edit, makeCollabUser("agent:owner:run", REWRITE_AUTHOR));
  Y.applyUpdate(session.ydoc, Y.encodeStateAsUpdate(remote), "remote-agent");
  suggestions.destroy();
  remote.destroy();
  session.binding.releaseRemoteSync();
  return { session, id };
}

describe("tracked passage review UI and history", () => {
  it("reuses the panel's text snapshot and keeps review state current after typing", async () => {
    const { session } = setup();
    const groups = vi.spyOn(session.suggestions, "groups");
    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} focusTab={{ tab: "suggestions", nonce: 1 }} />);
    await waitFor(() => expect(screen.getByTestId("suggestion-accept")).toBeEnabled());
    expect(groups).toHaveBeenCalledWith(session.ytext.toString());
    groups.mockClear();
    act(() => session.ytext.insert(0, "A human introduction.\n\n"));
    await waitFor(() => expect(screen.getByTestId("suggestion-accept")).toBeEnabled());
    expect(groups).toHaveBeenCalledWith(session.ytext.toString());
    expect(groups.mock.calls.every(([text]) => typeof text === "string")).toBe(true);
    expect(screen.getByTestId("suggestion-before").textContent).toBe(REWRITE_BEFORE);
    expect(screen.getByTestId("suggestion-after").textContent).toBe(REWRITE_AFTER);
    groups.mockRestore();
  });

  it.each(["accept", "reject"] as const)("one %s control decides both runs and Undo restores the same group", async (action) => {
    const { session, id } = setup();
    const onReveal = vi.fn();
    render(<CommentsPanel session={session} onClose={() => {}} onReveal={onReveal} focusTab={{ tab: "suggestions", nonce: 1 }} />);
    await waitFor(() => expect(screen.getAllByTestId("suggestion-card")).toHaveLength(1));
    expect(screen.getAllByTestId("suggestion-accept")).toHaveLength(1);
    expect(screen.getAllByTestId("suggestion-reject")).toHaveLength(1);
    expect(screen.getByTestId("suggestion-before").textContent).toBe(REWRITE_BEFORE);
    expect(screen.getByTestId("suggestion-after").textContent).toBe(REWRITE_AFTER);
    expect(screen.getByTestId("suggestion-card")).toHaveTextContent(REWRITE_AUTHOR);
    expect(screen.getByTestId("comments-tab-suggestions")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("suggestion-card"));
    expect(session.activeSuggestionId).toBe(id);
    expect(onReveal).toHaveBeenCalledWith(session.suggestions.groups()[0].from);
    fireEvent.click(screen.getByTestId(`suggestion-${action}`));
    await waitFor(() => expect(screen.queryByTestId("suggestion-card")).toBeNull());
    expect(session.ytext.toString()).toBe(action === "accept" ? REWRITE_RESULT : REWRITE_DOCUMENT);
    expect(session.undoManager.undoStack).toHaveLength(1);
    act(() => session.undo());
    await waitFor(() => expect(screen.getAllByTestId("suggestion-card")).toHaveLength(1));
    expect(session.suggestions.groups()[0]).toMatchObject({ id, outdated: false, before: REWRITE_BEFORE, after: REWRITE_AFTER });
    act(() => session.redo());
    expect(session.ytext.toString()).toBe(action === "accept" ? REWRITE_RESULT : REWRITE_DOCUMENT);
    await waitFor(() => expect(screen.queryByTestId("suggestion-card")).toBeNull());
  });

  it("rich and source render only one old/new run with a shared navigation identity", async () => {
    const { session, id } = setup();
    await waitFor(() => expect(session.binding.hasHeldSync).toBe(false));
    const richHost = document.body.appendChild(document.createElement("div"));
    const sourceHost = document.body.appendChild(document.createElement("div"));
    rich = new RichView(richHost, {
      state: RichState.create({ doc: session.binding.initialDoc(), plugins: [markdownBindingPlugin(session.binding), richHighlightsPlugin(session)] }),
    });
    source = new SourceView({
      doc: session.ytext.toString(),
      extensions: [yCollab(session.ytext, session.awareness, { undoManager: session.undoManager }), sourceHighlights()],
      parent: sourceHost,
    });
    const refresh = () => source!.dispatch({ effects: setHighlights.of(collectHighlights(session, null)) });
    unsubscribe = session.subscribe(refresh);
    refresh();
    for (const host of [richHost, sourceHost]) {
      const old = host.querySelectorAll(".md-suggest-delete");
      const next = host.querySelectorAll(".md-suggest-insert");
      expect(old).toHaveLength(1);
      expect(next).toHaveLength(1);
      expect(old[0].textContent).toBe(REWRITE_BEFORE);
      expect(next[0].textContent).toBe(REWRITE_AFTER);
      expect(old[0].getAttribute("data-highlight-id")).toBe(id);
      expect(next[0].getAttribute("data-highlight-id")).toBe(id);
    }
    session.setActiveSuggestion(session.suggestions.list().find((s) => s.type === "delete")!.id);
    expect(session.activeSuggestionId).toBe(id);
    expect(collectHighlights(session, null).filter((h) => h.id === id).every((h) => h.active)).toBe(true);
    session.reviewSuggestion("accept", id);
    await waitFor(() => {
      expect(source!.state.doc.toString()).toBe(REWRITE_RESULT);
      expect(richHost.querySelectorAll(".md-suggest-delete, .md-suggest-insert")).toHaveLength(0);
      expect(sourceHost.querySelectorAll(".md-suggest-delete, .md-suggest-insert")).toHaveLength(0);
    });
    expect(rich!.state.doc.textContent).toContain(REWRITE_AFTER);
    expect(rich!.state.doc.textContent).not.toContain(REWRITE_BEFORE);
  });

  it.each(["accept", "reject"] as const)("%s, undo and redo keep comment anchors and concurrent replies", (action) => {
    const { session, id } = setup();
    const removed = session.suggestions.list().find((s) => s.type === (action === "accept" ? "delete" : "insert"))!;
    const from = removed.from + removed.text.indexOf("the weather");
    const thread = session.comments.add({ from, to: from + 11, body: "Keep the observations.", author: session.user });
    session.reviewSuggestion(action, id);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(session.ydoc));
    const remoteText = remote.getText("content");
    const comments = remote.getMap<Y.Map<unknown>>("comments");
    const replies = comments.get(thread)!.get("replies") as Y.Array<unknown>;
    const remoteState = Y.encodeStateVector(remote);
    remoteText.insert(0, "Human preface.\n\n");
    replies.push([{ id: "later-reply", authorId: "other-human", authorName: "Colleague", body: "A later reply.", createdAt: 1 }]);
    Y.applyUpdate(session.ydoc, Y.encodeStateAsUpdate(remote, remoteState), "other-human");
    remote.destroy();
    const expectAnchor = () => {
      const saved = session.comments.get(thread)!;
      expect(session.ytext.toString().slice(saved.range!.from, saved.range!.to)).toBe("the weather");
      expect(saved.authorName).toBe("Reviewer");
      expect(saved.replies[0].body).toBe("A later reply.");
    };
    expectAnchor();
    session.undo();
    expect(session.suggestions.groups()[0]).toMatchObject({ id, outdated: false });
    expectAnchor();
    session.redo();
    expectAnchor();
    expect(session.ytext.toString()).toBe("Human preface.\n\n" + (action === "accept" ? REWRITE_RESULT : REWRITE_DOCUMENT));
  });

  it("shows a newer overlapping edit rather than offering a destructive stale decision", async () => {
    const { session } = setup();
    session.ytext.insert(session.suggestions.list()[0].from + 3, "human change");
    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} focusTab={{ tab: "suggestions", nonce: 1 }} />);
    await waitFor(() => expect(screen.getByTestId("suggestion-accept")).toBeDisabled());
    expect(screen.getByTestId("suggestion-reject")).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("overlaps a newer edit");
  });

  it.each(["accept", "reject"] as const)("%s history keeps a later explicit reanchor in the cached comment snapshot", (action) => {
    const { session, id } = setup();
    const removed = session.suggestions.list().find((s) => s.type === (action === "accept" ? "delete" : "insert"))!;
    const from = removed.from + removed.text.indexOf("the weather");
    const thread = session.comments.add({ from, to: from + 11, body: "Keep the observations.", author: session.user });
    const before = session.comments.get(thread)!;
    expect(session.comments.list()).toContain(before);
    session.reviewSuggestion(action, id);
    expect(session.comments.get(thread)).not.toBe(before);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(session.ydoc));
    const state = Y.encodeStateVector(remote);
    const text = remote.getText("content");
    const comments = new CommentsModel(remote, text);
    text.insert(0, "Human preface.\n\n");
    const target = text.toString().indexOf("closing");
    const anchor = createAnchor(text, target, target + 7);
    remote.transact(() => {
      comments.ymap.get(thread)!.set("anchor", anchor);
      comments.ymap.get(thread)!.set("quote", "closing");
      comments.reply(thread, "Please use this passage instead.", makeCollabUser("other-human", "Colleague"));
    });
    Y.applyUpdate(session.ydoc, Y.encodeStateAsUpdate(remote, state), "other-human");
    comments.destroy();
    remote.destroy();
    const expectCurrent = () => {
      const current = session.comments.get(thread)!;
      expect(session.comments.get(thread)).toBe(current);
      expect(session.comments.list()).toContain(current);
      expect(session.comments.ymap.get(thread)!.get("anchor")).toEqual(anchor);
      expect(session.ytext.toString().slice(current.range!.from, current.range!.to)).toBe("closing");
      expect(current).toMatchObject({ quote: "closing", body: before.body, authorName: before.authorName });
      expect(current.replies).toHaveLength(1);
      expect(current.replies[0]).toMatchObject({ body: "Please use this passage instead.", authorName: "Colleague" });
    };
    expectCurrent();
    session.undo();
    expect(session.suggestions.groups()[0]).toMatchObject({ id, outdated: false });
    expectCurrent();
    session.redo();
    expectCurrent();
    expect(session.ytext.toString()).toBe("Human preface.\n\n" + (action === "accept" ? REWRITE_RESULT : REWRITE_DOCUMENT));
  });

  it("does not undo another nearby decision with the selected group", () => {
    const { session, id } = setup();
    const from = session.ytext.toString().indexOf("closing");
    const other = session.suggestions.propose({ from, to: from + 7, insert: "ending" }, makeCollabUser("other", "Other author"), {});
    session.reviewSuggestion("accept", id);
    session.reviewSuggestion("accept", other);
    session.undo();
    expect(session.suggestions.groups().map((group) => group.id)).toEqual([other]);
    expect(session.ytext.toString()).toContain(REWRITE_AFTER);
    expect(session.ytext.toString()).not.toContain(REWRITE_BEFORE);
  });

  it.each(["accept", "reject"] as const)("%s history never removes a subsequent edit inside the surviving copy", (action) => {
    const { session, id } = setup();
    session.reviewSuggestion(action, id);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(session.ydoc));
    const state = Y.encodeStateVector(remote);
    const text = remote.getText("content");
    text.insert(text.toString().indexOf("garden") + 3, "HUMAN");
    Y.applyUpdate(session.ydoc, Y.encodeStateAsUpdate(remote, state), "other-human");
    remote.destroy();
    const after = session.ytext.toString();
    session.undo();
    expect(session.ytext.toString()).toContain("HUMAN");
    expect(session.suggestions.groups()[0]).toMatchObject({ id, outdated: true });
    session.redo();
    expect(session.ytext.toString()).toBe(after);
  });

  it.each([["", "Inserted text."], ["Deleted text.", ""], ["A smal typo.", "A small typo."]])("preserves single-action history for %j -> %j", (before, after) => {
    const { session, id } = setup(before, after);
    expect(session.suggestions.count).toBe(1);
    session.reviewSuggestion("accept", id);
    expect(session.ytext.toString()).toBe(after);
    expect(session.suggestions.count).toBe(0);
    expect(session.undoManager.undoStack).toHaveLength(1);
    session.undo();
    expect(session.suggestions.groups()[0]).toMatchObject({ id, outdated: false });
    expect(session.suggestions.cleanText()).toBe(before);
    session.redo();
    expect(session.ytext.toString()).toBe(after);
    expect(session.suggestions.count).toBe(0);
  });
});
