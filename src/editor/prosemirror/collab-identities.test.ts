// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Plugin } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
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
import { createAnchor, makeCollabUser } from "../collab/shared";
import { markdownBindingPlugin } from "../sync/markdown-binding";
import { richHighlightsPlugin } from "./highlights";
import { remoteCursorsPlugin } from "./remote-cursors";
import { REFRESH_META } from "./refresh";

const SOURCE = "alpha beta gamma";
const localUser = makeCollabUser("local", "Local");
const remoteUser = makeCollabUser("remote", "Remote");

interface RemoteClient {
  doc: Y.Doc;
  text: Y.Text;
  awareness: Awareness;
}

describe("collaborative relative-position decorations", () => {
  const sessions: CollabSession[] = [];
  const views: EditorView[] = [];
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
    for (const view of views) view.destroy();
    for (const session of sessions) session.destroy();
    for (const remote of remotes) {
      remote.awareness.destroy();
      remote.doc.destroy();
    }
    vi.unstubAllGlobals();
  });

  function openSession(): CollabSession {
    const session = new CollabSession({
      docId: "relative-position-test",
      user: localUser,
      role: "owner",
      getToken: async () => "test-token",
      autoConnect: false,
    });
    session.keepAlive();
    session.binding.releaseRemoteSync();
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

  function applyRemoteText(session: CollabSession, remote: RemoteClient, edit: () => void) {
    const vector = Y.encodeStateVector(session.ydoc);
    remote.doc.transact(edit);
    Y.applyUpdate(session.ydoc, Y.encodeStateAsUpdate(remote.doc, vector));
  }

  function publishCursor(session: CollabSession, remote: RemoteClient, id: string, anchor: number, head: number) {
    remote.awareness.setLocalState({
      user: { ...remoteUser, id, name: id },
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

  it("does not invalidate relative positions for binding-owned pure insertions", () => {
    const session = openSession();
    const version = session.relativePositionVersion;

    session.ydoc.transact(() => session.ytext.insert(session.ytext.length, "!"), session.binding);
    expect(session.relativePositionVersion).toBe(version);

    session.ydoc.transact(() => session.ytext.delete(session.ytext.length - 1, 1), session.binding);
    expect(session.relativePositionVersion).toBe(version + 1);
  });
});
