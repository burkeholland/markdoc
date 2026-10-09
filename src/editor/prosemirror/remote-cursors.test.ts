import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../markdown/parse";
import { caretPosition } from "./remote-cursors";

describe("where another person's caret is drawn", () => {
  const TABLE = "| a | b |\n| --- | --- |\n| 1 | 2 |";

  it("is in text: never between the cells or the rows of a table, where its element would be a cell of its own", () => {
    const doc = parseMarkdown(`Intro\n\n${TABLE}\n\nOutro`).doc;
    for (let pos = 0; pos <= doc.content.size; pos++) {
      const caret = caretPosition(doc, pos);
      expect(caret, `position ${pos}`).not.toBeNull();
      expect(doc.resolve(caret!).parent.inlineContent, `position ${pos}`).toBe(true);
      if (doc.resolve(pos).parent.inlineContent) expect(caret).toBe(pos);
    }
  });

  it("takes the end of the cell before a position between two cells, and the first text of a document that starts with a table", () => {
    const doc = parseMarkdown(TABLE).doc;
    const first = doc.child(0).child(0).child(0);
    // Between the two header cells: 1 (table) + 1 (row) + the first cell.
    expect(caretPosition(doc, 2 + first.nodeSize)).toBe(2 + first.nodeSize - 1);
    expect(caretPosition(doc, 0)).toBe(3);
  });

  it("is nowhere in a document without text", () => {
    const doc = parseMarkdown("---").doc;
    expect(doc.child(0).type.name).toBe("horizontal_rule");
    expect(caretPosition(doc, 0)).toBeNull();
  });
});
