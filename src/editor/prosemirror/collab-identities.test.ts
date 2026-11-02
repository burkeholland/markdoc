// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness: MockAwareness } = await import("y-protocols/awareness");
  class HocuspocusProvider {
    awareness: InstanceType<typeof MockAwareness>;
    constructor(opts: { document: Y.Doc }) {
      this.awareness = new MockAwareness(opts.document);
    }
    destroy() {
      this.awareness.destroy();
    }
  }
  return { HocuspocusProvider };
});

import { CollabSession } from "../collab/session";
import { CommentsModel } from "../collab/comments";
import { createAnchor, makeCollabUser } from "../collab/shared";
import { markdownBindingPlugin } from "../sync/markdown-binding";
import { richHighlightsPlugin } from "./highlights";
import { remoteCursorsPlugin } from "./remote-cursors";
import { REFRESH_META } from "./refresh";
import { createRichEditorState } from "./setup";
import { EditorState as CodeEditorState } from "@codemirror/state";
import { EditorView as CodeEditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import { remoteCaretInteractions } from "../codemirror/remote-cursors";

const SOURCE = "alpha beta gamma";
const localUser = makeCollabUser("local", "Local");
const remoteUser = makeCollabUser("remote", "Remote");

function normalizedColor(color: string): string {
  const element = document.createElement("span");
  element.style.backgroundColor = color;
  return element.style.backgroundColor;
}

interface RemoteClient {
  doc: Y.Doc;
  text: Y.Text;
  awareness: Awareness;
}

describe("collaborative relative-position decorations", () => {
  const sessions: CollabSession[] = [];
  const views: EditorView[] = [];
  const codeViews: CodeEditorView[] = [];
  const remotes: RemoteClient[] = [];
  let frames: { id: number; callback: FrameRequestCallback }[];
  let nextFrame: number;

  beforeEach(() => {
    frames = [];
    nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.push({ id, callback });
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames = frames.filter((frame) => frame.id !== id);
    });
  });

  afterEach(() => {
    for (const view of codeViews) view.destroy();
    for (const view of views) view.destroy();
    for (const session of sessions) session.destroy();
    for (const remote of remotes) {
      remote.awareness.destroy();
      remote.doc.destroy();
    }
    vi.unstubAllGlobals();
  });

  function openSession(held = false, user = localUser): CollabSession {
    const session = new CollabSession({
      docId: "relative-position-test",
      user,
      role: "owner",
      getToken: async () => "test-token",
      autoConnect: false,
    });
    session.keepAlive();
    if (!held) session.binding.releaseRemoteSync();
    session.ytext.insert(0, SOURCE);
    sessions.push(session);
    return session;
  }

  function join(session: CollabSession): RemoteClient {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(session.ydoc));
    const remote = { doc, text: doc.getText("content"), awareness: new Awareness(doc) };
    remotes.push(remote);
    return remote;
  }

  function addRemoteComment(session: CollabSession, from: number, to: number, body: string): string {
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(session.ydoc));
    const vector = Y.encodeStateVector(session.ydoc);
    const comments = new CommentsModel(remote, remote.getText("content"));
    const id = comments.add({ from, to, body, author: localUser });
    Y.applyUpdate(session.ydoc, Y.encodeStateAsUpdate(remote, vector));
    comments.destroy();
    remote.destroy();
    return id;
  }

  function applyRemoteText(session: CollabSession, remote: RemoteClient, edit: () => void) {
    const vector = Y.encodeStateVector(session.ydoc);
    remote.doc.transact(edit);
    Y.applyUpdate(session.ydoc, Y.encodeStateAsUpdate(remote.doc, vector));
  }

  function publishCursor(
    session: CollabSession,
    remote: RemoteClient,
    id: string,
    anchor: number,
    head: number,
    name = id,
    color = remoteUser.color,
  ) {
    remote.awareness.setLocalState({
      user: { ...remoteUser, id, name, color },
      cursor: {
        anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(remote.text, anchor)),
        head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(remote.text, head)),
      },
    });
    applyAwarenessUpdate(session.awareness, encodeAwarenessUpdate(remote.awareness, [remote.doc.clientID]), remote);
  }

  function createView(
    session: CollabSession,
    plugins: Plugin[],
  ): { view: EditorView; refreshes: { count: number } } {
    const refreshes = { count: 0 };
    const countRefreshes = new Plugin({
      state: {
        init: () => null,
        apply(transaction) {
          if (transaction.getMeta(REFRESH_META)) refreshes.count++;
          return null;
        },
      },
    });
    const state = EditorState.create({
      doc: session.binding.initialDoc(),
      plugins: [markdownBindingPlugin(session.binding), ...plugins, countRefreshes],
    });
    const view = new EditorView(document.createElement("div"), { state });
    views.push(view);
    return { view, refreshes };
  }

  async function flushRefreshes() {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    while (frames.length > 0) {
      const pending = frames;
      frames = [];
      for (const frame of pending) frame.callback(performance.now());
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
  }

  function highlightedText(view: EditorView, selector: string): string[] {
    return Array.from(view.dom.querySelectorAll<HTMLElement>(selector), (element) => element.textContent ?? "");
  }

  function caretPosition(view: EditorView, userId: string): number | null {
    const caret = view.dom.querySelector<HTMLElement>(`.md-remote-caret[data-user-id="${userId}"]`);
    return caret ? view.posAtDOM(caret, 0) : null;
  }

  it("does not materialize a long document's text for placeholder updates on typing or selection", () => {
    const session = openSession();
    session.ytext.delete(0, session.ytext.length);
    session.ytext.insert(0, Array.from({ length: 1000 }, (_, i) => `Paragraph ${i}`).join("\n\n"));
    const view = new EditorView(document.createElement("div"), { state: createRichEditorState(session) });
    views.push(view);
    const content = vi.spyOn(PMNode.prototype, "textContent", "get");
    try {
      for (let index = 0; index < 10; index++) {
        view.dispatch(view.state.tr.insertText("x", 1));
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
      }
      expect(content.mock.instances.filter((node) => node instanceof PMNode && node.type.name === "doc")).toHaveLength(0);
      expect(view.dom.classList.contains("md-has-content")).toBe(true);
    } finally {
      content.mockRestore();
    }
  });

  it.each(["", "one paragraph", "\n\n"])("preserves placeholder state for short source %j", (source) => {
    const session = openSession();
    session.ytext.delete(0, session.ytext.length);
    if (source) session.ytext.insert(0, source);
    const view = new EditorView(document.createElement("div"), { state: createRichEditorState(session) });
    views.push(view);
    const doc = view.state.doc;
    expect(view.dom.classList.contains("md-has-content")).toBe(doc.textContent.length > 0 || doc.childCount > 1);
  });

  it("refreshes ordinary comment ownership when same-text Yjs identities move", async () => {
    const session = openSession();
    const threadId = session.comments.add({ from: 6, to: 10, body: "Comment", author: localUser });
    session.ydoc.transact(() => session.suggestions.recordInserted(11, 5, localUser));
    const { view, refreshes } = createView(session, [richHighlightsPlugin(session)]);
    await flushRefreshes();
    refreshes.count = 0;
    expect(highlightedText(view, ".md-comment")).toEqual(["beta"]);
    expect(highlightedText(view, ".md-suggest-insert")).toEqual(["gamma"]);
    const initialDoc = view.state.doc.toJSON();

    const remote = join(session);
    applyRemoteText(session, remote, () => {
      remote.text.delete(9, 1);
      remote.text.insert(9, "a");
    });

    await flushRefreshes();

    expect(session.ytext.toString()).toBe(SOURCE);
    expect(view.state.doc.toJSON()).toEqual(initialDoc);
    expect(session.comments.get(threadId)?.range).toEqual({ from: 6, to: 9 });
    expect(highlightedText(view, ".md-comment")).toEqual(["bet"]);
    expect(highlightedText(view, ".md-suggest-insert")).toEqual(["gamma"]);
    expect(refreshes.count).toBe(1);

    applyRemoteText(session, remote, () => {
      remote.text.delete(6, 4);
      remote.text.insert(6, "beta");
    });
    await flushRefreshes();

    expect(session.ytext.toString()).toBe(SOURCE);
    expect(session.comments.get(threadId)?.range).toEqual({ from: 6, to: 6 });
    expect(highlightedText(view, ".md-comment")).toEqual([]);
    expect(highlightedText(view, ".md-suggest-insert")).toEqual(["gamma"]);

    const map = session.comments.ymap.get(threadId)!;
    map.set("anchor", createAnchor(session.ytext, 0, 5));
    await flushRefreshes();
    expect(session.comments.get(threadId)?.range).toEqual({ from: 0, to: 5 });
    expect(highlightedText(view, ".md-comment")).toEqual(["alpha"]);
  });

  it("restores loaded comment highlights after held initial text is rebuilt", async () => {
    const session = openSession(true);
    addRemoteComment(session, 6, 10, "Loaded comment");
    const { view, refreshes } = createView(session, [richHighlightsPlugin(session)]);
    await flushRefreshes();
    expect(session.binding.hasHeldSync).toBe(true);
    expect(highlightedText(view, ".md-comment")).toEqual([]);
    refreshes.count = 0;

    session.binding.releaseRemoteSync();
    await vi.waitFor(() => expect(session.binding.hasHeldSync).toBe(false));
    await flushRefreshes();
    expect(highlightedText(view, ".md-comment")).toEqual(["beta"]);
    expect(refreshes.count).toBe(1);

    refreshes.count = 0;
    view.dispatch(view.state.tr.insertText("x", 1));
    await flushRefreshes();
    expect(highlightedText(view, ".md-comment")).toEqual(["beta"]);
    expect(refreshes.count).toBe(0);
  });

  it("re-resolves unchanged collapsed and range awareness after a complete same-text replacement", async () => {
    const session = openSession();
    const collapsed = join(session);
    const range = join(session);
    publishCursor(session, collapsed, "remote-collapsed", 10, 10);
    publishCursor(session, range, "remote-range", 6, 10);
    const publishedHead = JSON.stringify(collapsed.awareness.getLocalState()?.cursor);
    const { view, refreshes } = createView(session, [remoteCursorsPlugin(session)]);
    await flushRefreshes();
    refreshes.count = 0;

    expect(caretPosition(view, "remote-collapsed")).toBe(11);
    expect(caretPosition(view, "remote-range")).toBe(11);
    expect(highlightedText(view, ".md-remote-selection")).toEqual(["beta"]);

    applyRemoteText(session, collapsed, () => {
      collapsed.text.delete(0, SOURCE.length);
      collapsed.text.insert(0, SOURCE);
    });
    await flushRefreshes();

    expect(session.ytext.toString()).toBe(SOURCE);
    expect(JSON.stringify(collapsed.awareness.getLocalState()?.cursor)).toBe(publishedHead);
    expect(caretPosition(view, "remote-collapsed")).toBe(1);
    expect(caretPosition(view, "remote-range")).toBe(1);
    expect(highlightedText(view, ".md-remote-selection")).toEqual([]);
    expect(refreshes.count).toBe(1);
  });

  it("re-resolves a same-text partial replacement and cleans up cursor listeners", async () => {
    const session = openSession();
    const remote = join(session);
    publishCursor(session, remote, "remote-partial", 10, 8);
    const { view } = createView(session, [remoteCursorsPlugin(session), richHighlightsPlugin(session)]);
    await flushRefreshes();
    expect(caretPosition(view, "remote-partial")).toBe(9);
    expect(highlightedText(view, ".md-remote-selection")).toEqual(["ta"]);

    applyRemoteText(session, remote, () => {
      remote.text.delete(6, 4);
      remote.text.insert(6, "beta");
    });
    await flushRefreshes();

    expect(caretPosition(view, "remote-partial")).toBe(7);
    expect(highlightedText(view, ".md-remote-selection")).toEqual(["beta"]);

    removeAwarenessStates(session.awareness, [remote.doc.clientID], "disconnect");
    await flushRefreshes();
    expect(caretPosition(view, "remote-partial")).toBeNull();

    view.destroy();
    expect(session["listeners"].size).toBe(0);
    const scheduledBefore = frames.length;
    applyRemoteText(session, remote, () => {
      remote.text.insert(remote.text.length, "!");
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(frames).toHaveLength(scheduledBefore);
  });

  it("deduplicates same-account presence without dropping either tab cursor", async () => {
    const session = openSession();
    const firstTab = join(session);
    const secondTab = join(session);
    publishCursor(session, firstTab, localUser.id, 4, 4, localUser.name, localUser.color);
    publishCursor(session, secondTab, localUser.id, 11, 11, localUser.name, localUser.color);

    expect(session.presence()).toHaveLength(1);
    expect(session.presence()[0]).toMatchObject({ id: localUser.id, isLocal: true });

    const { view } = createView(session, [remoteCursorsPlugin(session)]);
    await flushRefreshes();
    const richCarets = Array.from(view.dom.querySelectorAll<HTMLElement>(".md-remote-caret"));
    expect(richCarets).toHaveLength(2);
    expect(richCarets.map((caret) => view.posAtDOM(caret, 0))).toEqual([5, 12]);
    expect(richCarets.map((caret) => caret.querySelector(".md-remote-caret-label")?.textContent)).toEqual([
      "Local (you in another tab)",
      "Local (you in another tab)",
    ]);
    expect(richCarets.map((caret) => caret.hasAttribute("data-same-account"))).toEqual([true, true]);
    const follow = vi.spyOn(session, "follow");
    richCarets[0].querySelector(".md-remote-caret-label")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(follow).not.toHaveBeenCalled();

    const codeView = new CodeEditorView({
      state: CodeEditorState.create({
        doc: SOURCE,
        extensions: [
          yCollab(session.ytext, session.awareness, { undoManager: session.undoManager }),
          remoteCaretInteractions(session),
        ],
      }),
      parent: document.createElement("div"),
    });
    codeViews.push(codeView);
    codeView.dispatch({ selection: { anchor: 1 } });
    await flushRefreshes();
    const codeCarets = Array.from(codeView.dom.querySelectorAll<HTMLElement>(".cm-ySelectionCaret"));
    expect(codeCarets).toHaveLength(2);
    expect(codeCarets.map((caret) => caret.querySelector(".cm-ySelectionInfo")?.textContent)).toEqual([
      "Local (you in another tab)",
      "Local (you in another tab)",
    ]);
    expect(codeCarets.map((caret) => caret.hasAttribute("data-same-account"))).toEqual([true, true]);
  });

  it("keeps anonymous collaborators separate and their cursors followable", async () => {
    const localAnonymous = makeCollabUser("anonymous-local", "Anonymous");
    const firstGuest = makeCollabUser("anonymous-first-guest", "Anonymous");
    const secondGuest = makeCollabUser("anonymous-second-guest", "Anonymous");
    const expectedGuestByColor = new Map([
      [normalizedColor(firstGuest.color), firstGuest.id],
      [normalizedColor(secondGuest.color), secondGuest.id],
    ]);
    expect(expectedGuestByColor.size).toBe(2);

    const session = openSession(false, localAnonymous);
    const firstRemote = join(session);
    const secondRemote = join(session);
    publishCursor(session, firstRemote, firstGuest.id, 4, 4, firstGuest.name, firstGuest.color);
    publishCursor(session, secondRemote, secondGuest.id, 12, 12, secondGuest.name, secondGuest.color);

    expect(session.presence()).toHaveLength(3);

    const { view } = createView(session, [remoteCursorsPlugin(session)]);
    await flushRefreshes();
    const richCarets = Array.from(view.dom.querySelectorAll<HTMLElement>(".md-remote-caret"));
    expect(richCarets).toHaveLength(2);
    expect(richCarets.map((caret) => caret.querySelector(".md-remote-caret-label")?.textContent)).toEqual([
      "Anonymous",
      "Anonymous",
    ]);
    expect(richCarets.map((caret) => caret.dataset.userId).sort()).toEqual([firstGuest.id, secondGuest.id].sort());
    expect(richCarets.map((caret) => caret.hasAttribute("data-same-account"))).toEqual([false, false]);
    const follow = vi.spyOn(session, "follow");
    for (const caret of richCarets) {
      follow.mockClear();
      caret.querySelector(".md-remote-caret-label")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(follow).toHaveBeenCalledWith(caret.dataset.userId);
    }

    const codeView = new CodeEditorView({
      state: CodeEditorState.create({
        doc: SOURCE,
        extensions: [
          yCollab(session.ytext, session.awareness, { undoManager: session.undoManager }),
          remoteCaretInteractions(session),
        ],
      }),
      parent: document.createElement("div"),
    });
    codeViews.push(codeView);
    codeView.dispatch({ selection: { anchor: 1 } });
    await flushRefreshes();
    const codeCarets = Array.from(codeView.dom.querySelectorAll<HTMLElement>(".cm-ySelectionCaret"));
    expect(codeCarets).toHaveLength(2);
    expect(codeCarets.map((caret) => caret.querySelector(".cm-ySelectionInfo")?.textContent)).toEqual([
      "Anonymous",
      "Anonymous",
    ]);
    expect(codeCarets.map((caret) => caret.hasAttribute("data-same-account"))).toEqual([false, false]);
    for (const caret of codeCarets) {
      const expectedId = expectedGuestByColor.get(normalizedColor(caret.style.backgroundColor));
      expect(expectedId).toBeDefined();
      expect(caret.dataset.userId).toBe(expectedId);
      follow.mockClear();
      caret.querySelector(".cm-ySelectionInfo")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(follow).toHaveBeenCalledWith(expectedId);
    }
  });

  it("does not invalidate relative positions for binding-owned pure insertions", () => {
    const session = openSession();
    const version = session.relativePositionVersion;

    session.ydoc.transact(() => session.ytext.insert(session.ytext.length, "!"), session.binding);
    expect(session.relativePositionVersion).toBe(version);

    session.ydoc.transact(() => session.ytext.delete(session.ytext.length - 1, 1), session.binding);
    expect(session.relativePositionVersion).toBe(version + 1);
  });
});
