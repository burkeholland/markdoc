import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { parseMarkdown } from "../markdown/parse";
import { schema } from "../markdown/schema";
import { editablePlugin, escapeFloatingUi, isTableMenuHidden, tableMenuPlugin } from "./setup";

const DOC = "Select these words.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter.";

function make(canEdit = true): EditorState {
  const doc = parseMarkdown(DOC).doc;
  return EditorState.create({ doc, plugins: [editablePlugin(canEdit), tableMenuPlugin()] });
}

/** Position at the start of the text of the first body cell (cells hold inline content directly). */
function firstBodyCellPos(state: EditorState): number {
  let pos = -1;
  state.doc.descendants((node, offset) => {
    if (pos < 0 && node.type === schema.nodes.table_cell) pos = offset + 1;
    return pos < 0;
  });
  return pos;
}

function run(state: EditorState, command: Command): { state: EditorState; ok: boolean } {
  let next = state;
  const ok = command(state, (tr) => {
    next = state.apply(tr);
  });
  return { state: next, ok };
}

const select = (state: EditorState, anchor: number, head = anchor) => state.apply(state.tr.setSelection(TextSelection.create(state.doc, anchor, head)));

describe("Esc in the rich pane (issue #163)", () => {
  it("collapses a non-empty selection to its head and leaves the menu state alone", () => {
    const { state, ok } = run(select(make(), 1, 7), escapeFloatingUi);
    expect(ok).toBe(true);
    expect(state.selection.empty).toBe(true);
    expect(state.selection.head).toBe(7);
    expect(isTableMenuHidden(state)).toBe(false);
  });

  it("collapses a backwards selection to its head too", () => {
    const { state } = run(select(make(), 7, 1), escapeFloatingUi);
    expect(state.selection.empty).toBe(true);
    expect(state.selection.head).toBe(1);
  });

  it("with the caret in a table hides the menu until the selection moves", () => {
    const start = make();
    const inCell = select(start, firstBodyCellPos(start));
    const first = run(inCell, escapeFloatingUi);
    expect(first.ok).toBe(true);
    expect(isTableMenuHidden(first.state)).toBe(true);
    expect(first.state.selection.head).toBe(inCell.selection.head);
    // Typing in the cell keeps it hidden only while the selection is not set explicitly (insertText sets it).
    const typed = first.state.apply(first.state.tr.insertText("x"));
    expect(isTableMenuHidden(typed)).toBe(false);
    // A second Esc with the menu already hidden is not handled.
    expect(run(first.state, escapeFloatingUi).ok).toBe(false);
    // A caret move (past the cell's one character) shows the menu again.
    const moved = select(first.state, firstBodyCellPos(first.state) + 1);
    expect(isTableMenuHidden(moved)).toBe(false);
    expect(moved.selection.$head.parent.type).toBe(schema.nodes.table_cell);
  });

  it("is not handled outside a table with a collapsed selection", () => {
    expect(run(select(make(), 3), escapeFloatingUi).ok).toBe(false);
  });

  it("does not hide a menu the read-only editor never shows, but still collapses a commenter's selection", () => {
    const ro = make(false);
    expect(run(select(ro, firstBodyCellPos(ro)), escapeFloatingUi).ok).toBe(false);
    const { state, ok } = run(select(ro, 1, 7), escapeFloatingUi);
    expect(ok).toBe(true);
    expect(state.selection.empty).toBe(true);
  });
});
