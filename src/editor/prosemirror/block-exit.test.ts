import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Command, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { baseKeymap, chainCommands, createParagraphNear, exitCode, liftEmptyBlock, newlineInCode, splitBlock } from "prosemirror-commands";
import { goToNextCell } from "prosemirror-tables";
import { sinkListItem } from "prosemirror-schema-list";
import { parseMarkdown } from "../markdown/parse";
import { serializeMarkdown } from "../markdown/serialize";
import { schema } from "../markdown/schema";
import { markdownInputRules } from "./inputrules";
import {
  codeBlockToParagraphOnBackspace,
  exitCodeBlockOnTripleEnter,
  exitTableBelow,
  headingToParagraphOnBackspace,
  insertHardBreak,
  liftEmptyListItemOnBackspace,
  liftEmptyQuoteParagraph,
  liftFirstQuoteParagraphOnBackspace,
  splitListItemUnchecked,
  addRowOnEnterAtEnd,
  deleteEmptyTableOnBackspace,
} from "./commands";

/*
 * Entering and leaving blocks with the keyboard in the preview (task #415, Burke #1240). The
 * command chains below are the ones `setup.ts` binds; every row of the block matrix is driven
 * through `EditorState.apply` and asserted on the resulting Markdown.
 */

const enter = chainCommands(
  addRowOnEnterAtEnd,
  splitListItemUnchecked,
  liftEmptyQuoteParagraph,
  exitCodeBlockOnTripleEnter,
  newlineInCode,
  createParagraphNear,
  liftEmptyBlock,
  splitBlock,
);
const shiftEnter = chainCommands(exitCode, insertHardBreak(), enter);
const modEnter = chainCommands(exitCode, exitTableBelow, insertHardBreak());
const backspace = chainCommands(
  deleteEmptyTableOnBackspace,
  liftEmptyListItemOnBackspace,
  liftFirstQuoteParagraphOnBackspace,
  codeBlockToParagraphOnBackspace,
  headingToParagraphOnBackspace,
  baseKeymap.Backspace,
);

/** State with the caret at `offset` inside the text of the first block matching `type` (end when omitted). */
function caretIn(markdown: string, type: string, offset?: number, nth = 0): EditorState {
  const doc = parseMarkdown(markdown).doc;
  let found: { pos: number; size: number } | null = null;
  let seen = 0;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === type && node.isTextblock) {
      if (seen++ === nth) found = { pos: pos + 1, size: node.content.size };
      return false;
    }
    return true;
  });
  if (!found) throw new Error(`no ${type} in ${markdown}`);
  const { pos, size } = found as { pos: number; size: number };
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos + (offset ?? size)) });
}

function press(state: EditorState, command: Command): EditorState {
  let next = state;
  const ok = command(state, (tr) => {
    next = state.apply(tr);
  });
  expect(ok, "the key is handled by the editor").toBe(true);
  return next;
}

function type(state: EditorState, text: string): EditorState {
  return state.apply(state.tr.insertText(text));
}

const md = (state: EditorState) => serializeMarkdown(state.doc);
const caretBlock = (state: EditorState) => state.selection.$from.parent.type.name;
const caretPath = (state: EditorState) => {
  const $from = state.selection.$from;
  const path: string[] = [];
  for (let d = 1; d <= $from.depth; d++) path.push($from.node(d).type.name);
  return path.join(">");
};

describe("Markdown encoding of empty paragraphs inside a quote", () => {
  const roundTrip = (text: string) => serializeMarkdown(parseMarkdown(text).doc);
  const shape = (text: string) => parseMarkdown(text).doc.firstChild!.content.content.map((n) => `${n.type.name}${n.content.size ? "" : "(empty)"}`);

  it("one marker-only line is a separator or padding, every further one is an empty paragraph", () => {
    expect(shape("> A\n>")).toEqual(["paragraph"]);
    expect(shape("> A\n> ")).toEqual(["paragraph"]);
    expect(shape("> A\n>\n>")).toEqual(["paragraph", "paragraph(empty)"]);
    expect(shape(">\n>\n> A")).toEqual(["paragraph(empty)", "paragraph"]);
    expect(shape("> A\n>\n> B")).toEqual(["paragraph", "paragraph"]);
    expect(shape("> A\n>\n>\n> B")).toEqual(["paragraph", "paragraph(empty)", "paragraph"]);
    expect(shape(">")).toEqual(["paragraph(empty)"]);
    expect(shape("> - a\n> - b\n>\n> p")).toEqual(["bullet_list", "paragraph"]);
    expect(shape("> - a\n> - b\n>\n>\n> p")).toEqual(["bullet_list", "paragraph(empty)", "paragraph"]);
    expect(shape("> - a\n>\n>")).toEqual(["bullet_list", "paragraph(empty)"]);
  });

  it("serializes an empty quote paragraph as one extra marker line and reads it back", () => {
    const bq = (...children: ("" | string)[]) =>
      schema.nodes.doc.create(null, [schema.nodes.blockquote.create(null, children.map((t) => (t ? schema.nodes.paragraph.create(null, schema.text(t)) : schema.nodes.paragraph.create())))]);
    expect(serializeMarkdown(bq("A", ""))).toBe("> A\n>\n>");
    expect(serializeMarkdown(bq("", "A"))).toBe(">\n>\n> A");
    expect(serializeMarkdown(bq("A", "", "B"))).toBe("> A\n>\n>\n> B");
    expect(serializeMarkdown(bq("A", "", ""))).toBe("> A\n>\n>\n>");
    expect(serializeMarkdown(bq(""))).toBe(">");
    for (const text of ["> A\n>\n>", ">\n>\n> A", "> A\n>\n>\n> B", "> A\n>\n>\n>", ">", "> A\n>\n> B", "> A\n>\n>\n\n# Next", "> > B\n> >\n> >", "> - a\n>\n>"]) {
      expect(roundTrip(text), text).toBe(text);
      expect(parseMarkdown(roundTrip(text)).doc.eq(parseMarkdown(text).doc), `${text} keeps its shape`).toBe(true);
    }
  });

  it("does not change ordinary quotes", () => {
    for (const text of ["> A", "> A\n>\n> B", "> # Title\n>\n> Body", "> - a\n> - b"]) expect(roundTrip(text), text).toBe(text);
    expect(roundTrip("> A\n>")).toBe("> A");
  });
});

describe("heading", () => {
  it("Enter at the end starts a paragraph, not another heading", () => {
    for (const level of [1, 2, 3]) {
      const hashes = "#".repeat(level);
      let s = press(caretIn(`${hashes} Title\n\nBody.`, "heading"), enter);
      expect(caretBlock(s)).toBe("paragraph");
      s = type(s, "After heading");
      expect(md(s)).toBe(`${hashes} Title\n\nAfter heading\n\nBody.`);
    }
  });

  it("Shift+Enter cannot break a heading line: it acts like Enter", () => {
    let s = press(caretIn("# Title\n\nBody.", "heading"), shiftEnter);
    expect(caretBlock(s)).toBe("paragraph");
    s = type(s, "x");
    expect(md(s)).toBe("# Title\n\nx\n\nBody.");
    expect(s.doc.firstChild!.textContent).toBe("Title");
  });

  it("Backspace at the start merges into the previous paragraph / becomes a paragraph at the top", () => {
    const merged = press(caretIn("Intro.\n\n## Title", "heading", 0), backspace);
    expect(md(merged)).toBe("Intro.Title");
    const top = press(caretIn("# Title\n\nBody.", "heading", 0), backspace);
    expect(md(top)).toBe("Title\n\nBody.");
  });
});

describe("blockquote", () => {
  const QUOTE = "# H1\n\n> A quote line.\n\n## Heading two";

  it("Enter at the end of a quoted line stays inside the quote; Enter again leaves it", () => {
    let s = press(caretIn(QUOTE, "paragraph"), enter);
    expect(caretPath(s)).toBe("blockquote>paragraph");
    expect(md(s)).toBe("# H1\n\n> A quote line.\n>\n>\n\n## Heading two");
    // The intermediate state round-trips (no binding fallback, no caret jump).
    expect(parseMarkdown(md(s)).doc.eq(s.doc)).toBe(true);
    s = press(s, enter);
    expect(caretPath(s)).toBe("paragraph");
    s = type(s, "After quote");
    expect(md(s)).toBe("# H1\n\n> A quote line.\n\nAfter quote\n\n## Heading two");
  });

  it("Enter on an empty first or middle paragraph lifts it out in one keystroke", () => {
    const first = press(caretIn(">\n>\n> A", "paragraph", 0), enter);
    expect(md(type(first, "x"))).toBe("x\n\n> A");
    const middle = press(caretIn("> A\n>\n>\n> B", "paragraph", 0, 1), enter);
    expect(md(type(middle, "x"))).toBe("> A\n\nx\n\n> B");
  });

  it("Shift+Enter is a line break inside the quote", () => {
    const s = type(press(caretIn("> A", "paragraph"), shiftEnter), "B");
    expect(md(s)).toBe("> A\\\n> B");
    expect(caretPath(s)).toBe("blockquote>paragraph");
  });

  it("Backspace at the start of the first paragraph lifts it out of the quote", () => {
    const s = press(caretIn("> A\n>\n> B", "paragraph", 0), backspace);
    expect(md(s)).toBe("A\n\n> B");
    expect(caretPath(s)).toBe("paragraph");
  });
});

describe("lists", () => {
  for (const [name, text, item] of [
    ["bullet", "- one\n- two", "- "],
    ["ordered", "1. one\n2. two", "3. "],
    ["task", "- [ ] one\n- [x] two", "- [ ] "],
  ] as const) {
    it(`${name}: Enter makes an item, Enter on the empty item leaves the list`, () => {
      let s = press(caretIn(text, "paragraph", undefined, 1), enter);
      expect(caretPath(s)).toMatch(/_list>list_item>paragraph$/);
      expect(md(s)).toBe(`${text}\n${item}`);
      // The empty item round-trips, so the binding keeps it (and the caret) as is.
      expect(parseMarkdown(md(s)).doc.eq(s.doc)).toBe(true);
      s = press(s, enter);
      expect(caretPath(s)).toBe("paragraph");
      s = type(s, "After list");
      expect(md(s)).toBe(`${text}\n\nAfter list`);
    });

    it(`${name}: Shift+Enter breaks the line inside the item; Backspace at the start of the first item outdents`, () => {
      const broken = type(press(caretIn(text, "paragraph", undefined, 0), shiftEnter), "more");
      expect(caretPath(broken)).toMatch(/list_item>paragraph$/);
      expect(md(broken)).toContain("one\\\n");
      const lifted = press(caretIn(text, "paragraph", 0, 0), backspace);
      expect(caretPath(lifted)).toBe("paragraph");
      expect(md(lifted).split("\n")[0]).toBe("one");
    });
  }
});

describe("code block", () => {
  const CODE = "```ts\nconst a = 1;\n```\n\nAfter.";

  it("Enter is a newline inside; three Enters on empty trailing lines leave the block", () => {
    let s = press(caretIn(CODE, "code_block"), enter);
    expect(caretBlock(s)).toBe("code_block");
    s = press(s, enter);
    expect(caretBlock(s)).toBe("code_block");
    expect(s.doc.firstChild!.textContent).toBe("const a = 1;\n\n");
    s = press(s, enter);
    expect(caretBlock(s)).toBe("paragraph");
    s = type(s, "Out");
    expect(md(s)).toBe("```ts\nconst a = 1;\n```\n\nOut\n\nAfter.");
  });

  it("Mod+Enter / Shift+Enter leave the block immediately", () => {
    for (const key of [modEnter, shiftEnter]) {
      const s = type(press(caretIn(CODE, "code_block"), key), "Out");
      expect(md(s)).toBe("```ts\nconst a = 1;\n```\n\nOut\n\nAfter.");
    }
  });

  it("Backspace at the start turns the block into a paragraph", () => {
    const s = press(caretIn("Intro.\n\n```\ncode\n```", "code_block", 0), backspace);
    expect(md(s)).toBe("Intro.\n\ncode");
  });
});

describe("table", () => {
  const TABLE = "| a | b |\n| --- | --- |\n| 1 | 2 |";

  it("Mod+Enter leaves the table into the block below, or into a new paragraph", () => {
    const withNext = press(caretIn(`${TABLE}\n\nAfter.`, "table_cell", undefined, 1), modEnter);
    expect(caretBlock(withNext)).toBe("paragraph");
    expect(withNext.selection.$from.parent.textContent).toBe("After.");
    const last = type(press(caretIn(TABLE, "table_cell", undefined, 1), modEnter), "Out");
    expect(md(last)).toBe("| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\nOut");
  });

  it("Tab in the bottom-right cell adds a row (Tab elsewhere moves to the next cell)", () => {
    const tab = chainCommands(goToNextCell(1), addRowOnEnterAtEnd, sinkListItem(schema.nodes.list_item));
    const moved = press(caretIn(TABLE, "table_cell", undefined, 0), tab);
    expect(md(moved)).toBe("| a   | b   |\n| --- | --- |\n| 1   | 2   |");
    expect(moved.selection.$from.parent.textContent).toBe("2");
    const grown = type(press(caretIn(TABLE, "table_cell", undefined, 1), tab), "3");
    expect(md(grown)).toBe("| a   | b   |\n| --- | --- |\n| 1   | 2   |\n| 3   |     |");
  });

  it("Shift+Enter is a line break in the cell; Backspace in an empty first cell is a no-op", () => {
    const broken = type(press(caretIn(TABLE, "table_cell", undefined, 0), shiftEnter), "x");
    expect(md(broken)).toContain("| 1<br>x |");
    expect(parseMarkdown(md(broken)).doc.eq(broken.doc), "the <br> reads back as the same hard break").toBe(true);
    const state = caretIn("| a | b |\n| --- | --- |\n|  | 2 |", "table_cell", 0, 0);
    expect(backspace(state, undefined)).toBe(false);
  });
});

describe("end of document", () => {
  it("Enter after the last paragraph always gives a new paragraph", () => {
    const s = type(press(caretIn("Last.", "paragraph"), enter), "New");
    expect(md(s)).toBe("Last.\n\nNew");
  });
});

describe("Markdown input rules in the preview (task #437)", () => {
  const rules = markdownInputRules();
  /** Type `text` one character at a time through the input-rule plugin, the way handleTextInput sees it. */
  function typeWithRules(start: EditorState, text: string): EditorState {
    let state = start;
    for (const ch of text) {
      const { from, to } = state.selection;
      const view = { state, composing: false, dispatch: (tr: Transaction) => void (state = state.apply(tr)) } as unknown as EditorView;
      const handled = (rules.props.handleTextInput as (this: unknown, v: EditorView, from: number, to: number, text: string) => boolean).call(rules, view, from, to, ch);
      if (!handled) state = state.apply(state.tr.insertText(ch));
    }
    return state;
  }

  it("\"---\" on an empty paragraph becomes a rule with the caret in a new paragraph below it, not in the next block", () => {
    const s = typeWithRules(press(caretIn("Target paragraph.\n\nAfter text.", "paragraph", undefined, 0), enter), "---");
    expect(md(s)).toBe("Target paragraph.\n\n---\n\nAfter text.");
    expect(caretBlock(s)).toBe("paragraph");
    expect(s.selection.$from.parent.content.size, "the caret is in the empty paragraph under the rule").toBe(0);
    expect(md(type(s, "Below"))).toBe("Target paragraph.\n\n---\n\nBelow\n\nAfter text.");
  });

  it("typing ~~x~~ strikes x through and the intermediate sources read back unchanged", () => {
    let s = caretIn("Target paragraph.", "paragraph");
    for (const ch of " ~~typed~") {
      s = typeWithRules(s, ch);
      expect(parseMarkdown(md(s)).doc.eq(s.doc), `after typing ${JSON.stringify(ch)}: ${md(s)}`).toBe(true);
    }
    s = typeWithRules(s, "~");
    expect(md(s)).toBe("Target paragraph. ~~typed~~");
    expect(md(type(s, " plain"))).toBe("Target paragraph. ~~typed~~ plain");
  });
});
