import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { CellSelection } from "prosemirror-tables";
import { parseMarkdown } from "../markdown/parse";
import { serializeMarkdown } from "../markdown/serialize";
import { schema } from "../markdown/schema";
import {
  addRowAfter,
  addRowBefore,
  addColumnAfter,
  addColumnBefore,
  deleteRow,
  deleteColumn,
  deleteTable,
  setColumnAlign,
  columnAlignAt,
  addRowOnEnterAtEnd,
  deleteEmptyTableOnBackspace,
} from "./commands";

const TABLE = "| a | b |\n| --- | --- |\n| 1 | 2 |";

/** Editor state with the cursor inside the text of the given cell (row/col, 0-based). */
function stateAt(markdown: string, row: number, col: number): EditorState {
  const doc = parseMarkdown(markdown).doc;
  let tablePos = -1;
  let table = doc.firstChild!;
  doc.forEach((node, offset) => {
    if (node.type === schema.nodes.table && tablePos < 0) {
      tablePos = offset;
      table = node;
    }
  });
  let pos = tablePos + 1;
  for (let r = 0; r < row; r++) pos += table.child(r).nodeSize;
  pos += 1; // into the row
  for (let c = 0; c < col; c++) pos += table.child(row).child(c).nodeSize;
  pos += 1; // into the cell
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos + table.child(row).child(col).content.size) });
}

function run(state: EditorState, command: Command): { state: EditorState; ok: boolean } {
  let next = state;
  const ok = command(state, (tr) => {
    next = state.apply(tr);
  });
  return { state: next, ok };
}

const md = (state: EditorState) => serializeMarkdown(state.doc).trimEnd();
const lines = (state: EditorState) => md(state).split("\n");
const tableNode = (state: EditorState) => state.doc.firstChild!;

describe("table commands", () => {
  it("addRowAfter appends an empty body row", () => {
    const { state, ok } = run(stateAt(TABLE, 1, 0), addRowAfter);
    expect(ok).toBe(true);
    expect(lines(state)).toEqual(["| a   | b   |", "| --- | --- |", "| 1   | 2   |", "|     |     |"]);
    expect(tableNode(state).child(2).child(0).type.name).toBe("table_cell");
  });

  it("addRowBefore on a body row inserts above it", () => {
    const { state } = run(stateAt(TABLE, 1, 0), addRowBefore);
    expect(lines(state)).toEqual(["| a   | b   |", "| --- | --- |", "|     |     |", "| 1   | 2   |"]);
  });

  it("addRowBefore on the header row inserts a body row below the header", () => {
    const { state } = run(stateAt(TABLE, 0, 1), addRowBefore);
    expect(lines(state)).toEqual(["| a   | b   |", "| --- | --- |", "|     |     |", "| 1   | 2   |"]);
    const table = tableNode(state);
    expect(table.child(0).child(0).type.name).toBe("table_header");
    expect(table.child(1).child(0).type.name).toBe("table_cell");
  });

  it("addRowAfter from the header row keeps the header first", () => {
    const { state } = run(stateAt(TABLE, 0, 0), addRowAfter);
    expect(lines(state)).toEqual(["| a   | b   |", "| --- | --- |", "|     |     |", "| 1   | 2   |"]);
    expect(tableNode(state).child(1).child(0).type.name).toBe("table_cell");
  });

  it("addColumnAfter / addColumnBefore add header and body cells", () => {
    const after = run(stateAt(TABLE, 1, 1), addColumnAfter).state;
    expect(lines(after)).toEqual(["| a   | b   |     |", "| --- | --- | --- |", "| 1   | 2   |     |"]);
    expect(tableNode(after).child(0).child(2).type.name).toBe("table_header");
    expect(tableNode(after).child(1).child(2).type.name).toBe("table_cell");

    const before = run(stateAt(TABLE, 1, 0), addColumnBefore).state;
    expect(lines(before)).toEqual(["|     | a   | b   |", "| --- | --- | --- |", "|     | 1   | 2   |"]);
  });

  it("deleteRow removes a body row and refuses to remove the header", () => {
    const removed = run(stateAt(TABLE, 1, 1), deleteRow);
    expect(removed.ok).toBe(true);
    expect(lines(removed.state)).toEqual(["| a   | b   |", "| --- | --- |"]);

    const refused = run(stateAt(TABLE, 0, 0), deleteRow);
    expect(refused.ok).toBe(false);
    expect(md(refused.state)).toBe(md(stateAt(TABLE, 0, 0)));
  });

  it("deleteRow on a header-only table deletes the table", () => {
    const { state, ok } = run(stateAt("| a | b |\n| --- | --- |", 0, 0), deleteRow);
    expect(ok).toBe(true);
    expect(state.doc.childCount).toBe(1);
    expect(state.doc.firstChild!.type.name).toBe("paragraph");
  });

  it("deleteColumn removes the column in every row", () => {
    const { state } = run(stateAt(TABLE, 1, 0), deleteColumn);
    expect(lines(state)).toEqual(["| b   |", "| --- |", "| 2   |"]);
  });

  it("deleteColumn on the last remaining column deletes the table", () => {
    const { state } = run(stateAt("| a |\n| --- |\n| 1 |", 1, 0), deleteColumn);
    expect(state.doc.firstChild!.type.name).toBe("paragraph");
    expect(md(state)).not.toContain("|");
  });

  it("deleteTable leaves an empty paragraph when it was the only block", () => {
    const { state, ok } = run(stateAt(TABLE, 1, 1), deleteTable);
    expect(ok).toBe(true);
    expect(state.doc.childCount).toBe(1);
    expect(state.doc.firstChild!.type.name).toBe("paragraph");
    expect(state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("deleteTable removes only the table from a larger document", () => {
    const { state } = run(stateAt(`# Title\n\n${TABLE}\n\nAfter.`, 1, 0), deleteTable);
    expect(md(state)).toBe("# Title\n\nAfter.");
  });

  it("setColumnAlign writes the GFM alignment row", () => {
    let state = run(stateAt(TABLE, 1, 0), setColumnAlign("left")).state;
    state = EditorState.create({ doc: state.doc, selection: stateAt(md(state), 0, 1).selection });
    state = run(state, setColumnAlign("right")).state;
    expect(lines(state)[1]).toBe("| :-- | --: |");
    expect(columnAlignAt(state)).toBe("right");
    const table = tableNode(state);
    expect(table.child(0).child(0).attrs.align).toBe("left");
    expect(table.child(1).child(0).attrs.align).toBe("left");
    expect(table.child(0).child(1).attrs.align).toBe("right");
    expect(table.child(1).child(1).attrs.align).toBe("right");

    state = run(state, setColumnAlign("center")).state;
    expect(lines(state)[1]).toBe("| :-- | :-: |");
    state = run(state, setColumnAlign(null)).state;
    expect(lines(state)[1]).toBe("| :-- | --- |");
  });

  it("setColumnAlign applies to every column of a cell selection", () => {
    const base = stateAt(TABLE, 1, 0);
    const table = tableNode(base);
    const header = base.doc.resolve(1 + 1); // first header cell
    const last = base.doc.resolve(1 + table.child(0).nodeSize + 1 + table.child(1).child(0).nodeSize);
    const state = run(EditorState.create({ doc: base.doc, selection: new CellSelection(header, last) }), setColumnAlign("center")).state;
    expect(lines(state)[1]).toBe("| :-: | :-: |");
  });

  it("Enter in the last cell adds a row and moves into it", () => {
    const notLast = run(stateAt(TABLE, 1, 0), addRowOnEnterAtEnd);
    expect(notLast.ok).toBe(false);
    const { state, ok } = run(stateAt(TABLE, 1, 1), addRowOnEnterAtEnd);
    expect(ok).toBe(true);
    expect(lines(state)).toHaveLength(4);
    expect(state.selection.$from.node(-1).type.name).toBe("table_row");
    expect(state.selection.$from.index(-2)).toBe(2);
    expect(state.selection.$from.index(-1)).toBe(0);
  });

  it("Backspace removes a table whose cells are all empty", () => {
    const kept = run(stateAt(TABLE, 1, 1), deleteEmptyTableOnBackspace);
    expect(kept.ok).toBe(false);
    const { state, ok } = run(stateAt("|  |  |\n| --- | --- |\n|  |  |", 1, 1), deleteEmptyTableOnBackspace);
    expect(ok).toBe(true);
    expect(state.doc.firstChild!.type.name).toBe("paragraph");
  });

  it("commands are no-ops outside a table", () => {
    const state = stateAt("Hello\n\n" + TABLE, 1, 0);
    const outside = EditorState.create({ doc: state.doc, selection: TextSelection.create(state.doc, 1) });
    for (const cmd of [addRowAfter, addRowBefore, addColumnAfter, addColumnBefore, deleteRow, deleteColumn, deleteTable, setColumnAlign("center"), addRowOnEnterAtEnd, deleteEmptyTableOnBackspace]) {
      expect(run(outside, cmd).ok).toBe(false);
    }
  });
});

describe("table alignment round trip", () => {
  it("parses alignment markers into cell attrs and serializes them back", () => {
    const src = "| a | b |\n|:---|---:|\n| 1 | 2 |";
    const doc = parseMarkdown(src).doc;
    const table = doc.firstChild!;
    expect(table.child(0).child(0).attrs.align).toBe("left");
    expect(table.child(0).child(1).attrs.align).toBe("right");
    expect(table.child(1).child(0).attrs.align).toBe("left");
    expect(table.child(1).child(1).attrs.align).toBe("right");
    const out = serializeMarkdown(doc).trimEnd();
    expect(out).toBe("| a   |   b |\n| :-- | --: |\n| 1   |   2 |");
    expect(serializeMarkdown(parseMarkdown(out).doc).trimEnd()).toBe(out);
  });
});
