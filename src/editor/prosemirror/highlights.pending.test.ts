// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { EditorState as CodeState } from "@codemirror/state";
import { EditorView as CodeView } from "@codemirror/view";
import { EditorState as RichState } from "prosemirror-state";
import { EditorView as RichView } from "prosemirror-view";

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

import { CollabSession } from "../collab/session";
import { makeCollabUser } from "../collab/shared";
import { setHighlights, sourceHighlights } from "../codemirror/highlights";
import { markdownBindingPlugin } from "../sync/markdown-binding";
import { collectHighlights, refreshRichHighlights, richHighlightsPlugin } from "./highlights";

const TEXT = "# Title\n\nIntro text.\n\nTarget paragraph.\n\nAfter text.\n";
const FROM = TEXT.indexOf("Target");
const TO = FROM + "Target".length;

/** The pending comment's highlight in both panes while edits land around it (#2258). */
describe("pending comment highlight under edits", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    document.body.replaceChildren();
  });

  function open() {
    const session = new CollabSession({
      docId: "pending-highlight",
      user: makeCollabUser("alice", "Alice"),
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
      deferLocal: true,
    });
    session.keepAlive();
    session.ytext.insert(0, TEXT);
    const richDoc = session.binding.initialDoc();
    session.binding.releaseRemoteSync();
    const rich = new RichView(document.body.appendChild(document.createElement("div")), {
      state: RichState.create({ doc: richDoc, plugins: [markdownBindingPlugin(session.binding), richHighlightsPlugin(session)] }),
    });
    const code = new CodeView({
      state: CodeState.create({ doc: session.ytext.toString(), extensions: [sourceHighlights()] }),
      parent: document.body.appendChild(document.createElement("div")),
    });
    // The Markdown pane follows the shared text (the collaboration extension does this in the app).
    const follow = (event: Y.YTextEvent) => {
      let index = 0;
      const changes: { from: number; to?: number; insert?: string }[] = [];
      for (const part of event.delta) {
        if (part.retain) index += part.retain;
        else if (part.delete) {
          changes.push({ from: index, to: index + part.delete });
          index += part.delete;
        } else if (typeof part.insert === "string") changes.push({ from: index, insert: part.insert });
      }
      code.dispatch({ changes });
    };
    session.ytext.observe(follow);
    cleanups.push(() => {
      session.ytext.unobserve(follow);
      rich.destroy();
      code.destroy();
      session.destroy();
    });
    /** What the session's listeners do after a change: the panes draw the highlights again. */
    const redraw = () => {
      refreshRichHighlights(rich);
      code.dispatch({ effects: setHighlights.of(collectHighlights(session, null)) });
    };
    const drawn = (view: { dom: HTMLElement }) => Array.from(view.dom.querySelectorAll('[data-highlight-id="pending"]'), (el) => el.textContent).join("");
    const remoteEdit = (from: number, to: number, insert = "") => {
      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(session.ydoc));
      const known = Y.encodeStateVector(session.ydoc);
      const text = remote.getText("content");
      if (to > from) text.delete(from, to - from);
      if (insert) text.insert(from, insert);
      Y.applyUpdate(session.ydoc, Y.encodeStateAsUpdate(remote, known));
      remote.destroy();
    };
    return { session, rich, code, redraw, drawn, remoteEdit };
  }

  it("is drawn on the selected text in both panes", () => {
    const { session, rich, code, redraw, drawn } = open();
    session.setPendingComment({ from: FROM, to: TO });
    redraw();
    expect(drawn(rich)).toBe("Target");
    expect(drawn(code)).toBe("Target");
  });

  it.each([
    ["typed at the end of the title", 7, 7, " wwww wwww", "Target"],
    ["typed in the paragraph above", 20, 20, " More intro.", "Target"],
    ["typed in the same paragraph right before it", FROM, FROM, "Not the ", "Target"],
    ["typed after it", TO + 3, TO + 3, "wwww", "Target"],
    ["deleted before it", 9, 15, "", "Target"],
    ["typed inside it", FROM + 3, FROM + 3, "--", "Tar--get"],
    ["deleted across its start", FROM - 2, FROM + 3, "", "get"],
    ["deleted across its end", FROM + 3, TO + 4, "", "Tar"],
  ])("stays on the selected text when a collaborator has %s", (_what, from, to, insert, expected) => {
    const { session, rich, code, redraw, drawn, remoteEdit } = open();
    session.setPendingComment({ from: FROM, to: TO });
    redraw();
    remoteEdit(from, to, insert);
    redraw();
    const pending = collectHighlights(session, null).find((highlight) => highlight.id === "pending")!;
    expect(session.ytext.toString().slice(pending.from, pending.to), "the highlight the panes are given").toBe(expected);
    expect(drawn(rich), "preview").toBe(expected);
    expect(drawn(code), "Markdown pane").toBe(expected);
  });

  it("stays on the selected text through a run of remote keys, redrawn after each", () => {
    const { session, rich, code, redraw, drawn, remoteEdit } = open();
    session.setPendingComment({ from: FROM, to: TO });
    redraw();
    for (let i = 0; i < 60; i++) {
      remoteEdit(7 + i, 7 + i, i % 5 === 4 ? " " : "w");
      redraw();
      expect(drawn(rich), `preview after ${i + 1} keys`).toBe("Target");
      expect(drawn(code), `Markdown pane after ${i + 1} keys`).toBe("Target");
    }
  });

  it("draws nothing once the selected text is wholly deleted, and nothing for a comment on the whole document", () => {
    const { session, rich, code, redraw, drawn, remoteEdit } = open();
    session.setPendingComment({ from: FROM, to: TO });
    redraw();
    remoteEdit(FROM - 2, TO + 2);
    redraw();
    expect(collectHighlights(session, null).some((highlight) => highlight.id === "pending")).toBe(false);
    expect(drawn(rich)).toBe("");
    expect(drawn(code)).toBe("");
    session.setPendingComment({ from: 0, to: 0 });
    redraw();
    expect(collectHighlights(session, null).some((highlight) => highlight.id === "pending")).toBe(false);
  });
});
