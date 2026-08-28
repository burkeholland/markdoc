// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { MarkdownBinding, markdownBindingPlugin } from "../sync/markdown-binding";
import { minimalVerticalScroll, undoSelectionPlugin, type UndoSelectionSession } from "./setup";

describe("minimalVerticalScroll", () => {
  const viewport = { top: 100, bottom: 500 };

  it("does not move a viewport when the restored caret is visible", () => {
    expect(minimalVerticalScroll(viewport, { top: 250, bottom: 270 })).toBe(0);
    expect(minimalVerticalScroll(viewport, { top: 100, bottom: 500 })).toBe(0);
  });

  it("moves only enough to reveal a caret outside either edge", () => {
    expect(minimalVerticalScroll(viewport, { top: 75, bottom: 95 })).toBe(-25);
    expect(minimalVerticalScroll(viewport, { top: 510, bottom: 530 })).toBe(30);
  });
});

describe("undoSelectionPlugin", () => {
  it("tracks the final caret when several keystrokes merge into one undo item", async () => {
    const original =
      ["# Fixture", ...Array.from({ length: 43 }, (_, index) => `Paragraph ${index + 1} long document text`), "## Heading anchor-045 long document text", "Final paragraph"].join(
        "\n\n",
      ) + "\n";
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, original);
    const binding = new MarkdownBinding(ytext);
    const undoManager = new Y.UndoManager(ytext, { captureTimeout: 400, trackedOrigins: new Set() });
    undoManager.addTrackedOrigin(binding);
    const session: UndoSelectionSession = {
      activeSurface: "rich",
      binding,
      ydoc,
      ytext,
      undoManager,
    };
    const state = EditorState.create({
      doc: binding.initialDoc(),
      plugins: [markdownBindingPlugin(binding), undoSelectionPlugin(session)],
    });
    const host = document.body.appendChild(document.createElement("div"));
    const view = new EditorView(host, { state });
    const sourcePosition = original.indexOf("anchor-045") + "anchor-045".length;
    const position = binding.getSourceMap().srcToPm(sourcePosition);
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)));

    for (const character of "TOKEN") view.dispatch(view.state.tr.insertText(character));
    expect(undoManager.undoStack).toHaveLength(1);
    await Promise.resolve();
    undoManager.undo();
    await Promise.resolve();

    expect(ytext.toString()).toBe(original);
    expect(view.state.selection.head).toBe(position);
    expect(
      Array.from(undoManager.redoStack.at(-1)?.meta.values() ?? []).some(
        (value) => typeof value === "object" && value !== null && "undo" in value && "redo" in value,
      ),
    ).toBe(true);
    undoManager.redo();
    await Promise.resolve();
    expect(ytext.toString()).toBe(original.replace("anchor-045", "anchor-045TOKEN"));
    expect(view.state.selection.head).toBe(position + "TOKEN".length);
    view.destroy();
    binding.destroy();
    undoManager.destroy();
    host.remove();
    ydoc.destroy();
  });
});
