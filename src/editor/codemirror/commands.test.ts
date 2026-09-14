// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { ensureSyntaxTree } from "@codemirror/language";
import type { Node as PMNode } from "prosemirror-model";
import { parseMarkdown } from "../markdown/parse";
import { serializeMarkdown } from "../markdown/serialize";
import { insertCodeBlock, insertImage, insertLink, setHeading, toggleInlineMark, toggleLinePrefix, type InlineMarker, type LinePrefixKind } from "./commands";
import * as codeMirrorLanguage from "@codemirror/language";
import { Parser, Tree } from "@lezer/common";
import { pathologicalParagraphs } from "./pathological";
import { formatStateAt, type SourceFormatState } from "./commands";

function withEditor(
  doc: string,
  selection: EditorSelection,
  run: (view: EditorView) => void,
  extensions: Extension[] = [],
) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  try {
    const view = new EditorView({
      state: EditorState.create({ doc, selection, extensions }),
      parent,
    });
    try {
      run(view);
    } finally {
      view.destroy();
    }
  } finally {
    parent.remove();
  }
}

function expectSelection(view: EditorView, from: number, text: string, index = 0) {
  const range = view.state.selection.ranges[index];
  expect({ from: range.from, to: range.to }).toEqual({ from, to: from + text.length });
  expect(view.state.sliceDoc(range.from, range.to)).toBe(text);
}

const markedWord = "nai\u0308ve";
const supplementaryWord = "\u{10400}\u{10428}\u{10401}";
const markers: InlineMarker[] = ["**", "*", "`", "~~"];
const representativeWords = [
  { name: "decomposed Latin", word: markedWord, caret: 3 },
  { name: "supplementary letters", word: supplementaryWord, caret: 2 },
];

describe("code fence length", () => {
  it.each([
    { name: "plain text", text: "const n = 1;", lang: "TypeScript", fenceLength: 3, expected: "```TypeScript\nconst n = 1;\n```\n" },
    { name: "single backticks", text: "`value`", lang: "", fenceLength: 3, expected: "```\n`value`\n```\n" },
    { name: "double backticks", text: "``value``", lang: "", fenceLength: 3, expected: "```\n``value``\n```\n" },
    { name: "three-backtick line", text: "before\n```\nafter", lang: "md", fenceLength: 4, expected: "````md\nbefore\n```\nafter\n````\n" },
    { name: "four-backtick line", text: "before\n````\nafter", lang: "", fenceLength: 5, expected: "`````\nbefore\n````\nafter\n`````\n" },
    { name: "longer backtick line", text: "```````", lang: "text", fenceLength: 8, expected: "````````text\n```````\n````````\n" },
    { name: "longest run before the last", text: "``````\n```\n````", lang: "", fenceLength: 7, expected: "```````\n``````\n```\n````\n```````\n" },
    { name: "inline run", text: "left````right", lang: "", fenceLength: 5, expected: "`````\nleft````right\n`````\n" },
    { name: "indented run", text: "    `````", lang: "", fenceLength: 6, expected: "``````\n    `````\n``````\n" },
    { name: "nonclosing run", text: "```tail", lang: "", fenceLength: 4, expected: "````\n```tail\n````\n" },
    { name: "tildes", text: "~~~\n~value~\n~~~~", lang: "", fenceLength: 3, expected: "```\n~~~\n~value~\n~~~~\n```\n" },
    {
      name: "literal Unicode, backslashes and spaces", text: "  \u{10400}nai\u0308ve\\path ~~~~ ```  \n  end  ", lang: "text", fenceLength: 4,
      expected: "````text\n  \u{10400}nai\u0308ve\\path ~~~~ ```  \n  end  \n````\n",
    },
    { name: "one trailing newline", text: "```\n", lang: "md", fenceLength: 4, expected: "````md\n```\n\n````\n" },
    { name: "two trailing newlines", text: "````\n\n", lang: "", fenceLength: 5, expected: "`````\n````\n\n\n`````\n" },
    { name: "empty source", text: "", lang: "", fenceLength: 3, expected: "```\n\n```\n" },
    { name: "empty source with a language", text: "", lang: "js", fenceLength: 3, expected: "```js\n\n```\n" },
  ])("wraps $name without changing the body", ({ text, lang, fenceLength, expected }) => {
    const transactions: Transaction[] = [];
    withEditor(text, EditorSelection.single(0, text.length), (view) => {
      expect(insertCodeBlock(view, lang)).toBe(true);
      const source = view.state.doc.toString();
      expect(source).toBe(expected);
      const lines = source.split("\n");
      expect(lines[0].match(/^`+/)?.[0].length).toBe(fenceLength);
      expect(lines.at(-2)?.length).toBe(fenceLength);
      expect(view.state.selection.eq(EditorSelection.single(fenceLength + 1 + lang.length + text.length))).toBe(true);
      const { doc } = parseMarkdown(source);
      expect(doc.childCount).toBe(1);
      expect(doc.child(0).type.name).toBe("code_block");
      expect(doc.child(0).textContent).toBe(text);
      expect(doc.child(0).attrs.language).toBe(lang || null);
      expect(transactions).toHaveLength(1);
      expect(transactions[0].annotation(Transaction.userEvent)).toBe("input.format");
      expect(transactions[0].scrollIntoView).toBe(true);
      expect(transactions[0].docChanged).toBe(true);
      expect(view.hasFocus).toBe(true);
    }, [EditorView.updateListener.of((update) => transactions.push(...update.transactions))]);
  });

  it.each([
    { name: "forward with a language", anchor: 6, head: 19, lang: "ts", cursor: 29, expected: "Before\n\n`````ts\n```\nbody\n````\n`````\n\nAfter" },
    { name: "reversed without a language", anchor: 19, head: 6, lang: "", cursor: 27, expected: "Before\n\n`````\n```\nbody\n````\n`````\n\nAfter" },
  ])("keeps surrounding paragraphs for a $name selection", ({ anchor, head, lang, cursor, expected }) => {
    withEditor("Before```\nbody\n````After", EditorSelection.single(anchor, head), (view) => {
      expect(insertCodeBlock(view, lang)).toBe(true);
      expect(view.state.doc.toString()).toBe(expected);
      expect(view.state.selection.eq(EditorSelection.single(cursor))).toBe(true);
      const { doc } = parseMarkdown(view.state.doc.toString());
      expect(doc.childCount).toBe(3);
      expect([doc.child(0).type.name, doc.child(0).textContent]).toEqual(["paragraph", "Before"]);
      expect([doc.child(1).type.name, doc.child(1).textContent, doc.child(1).attrs.language]).toEqual(["code_block", "```\nbody\n````", lang || null]);
      expect([doc.child(2).type.name, doc.child(2).textContent]).toEqual(["paragraph", "After"]);
    });
  });

  it("only wraps the main selection and ignores longer unselected runs", () => {
    const selection = EditorSelection.create([EditorSelection.range(11, 19), EditorSelection.range(24, 21)], 1);
    withEditor("unselected ````````\n\n```", selection, (view) => {
      expect(insertCodeBlock(view, "text")).toBe(true);
      expect(view.state.doc.toString()).toBe("unselected ````````\n\n````text\n```\n````\n");
      expect(view.state.selection.eq(EditorSelection.single(33))).toBe(true);
      const { doc } = parseMarkdown(view.state.doc.toString());
      expect(doc.childCount).toBe(2);
      expect([doc.child(0).type.name, doc.child(0).textContent]).toEqual(["paragraph", "unselected ````````"]);
      expect([doc.child(1).type.name, doc.child(1).textContent, doc.child(1).attrs.language]).toEqual(["code_block", "```", "text"]);
    }, [EditorState.allowMultipleSelections.of(true)]);
  });

  it("keeps an empty caret inside the blank body with the default language", () => {
    withEditor("BeforeAfter", EditorSelection.single(6), (view) => {
      expect(insertCodeBlock(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("Before\n\n```\n\n```\n\nAfter");
      expect(view.state.selection.eq(EditorSelection.single(12))).toBe(true);
      const { doc } = parseMarkdown(view.state.doc.toString());
      expect(doc.childCount).toBe(3);
      expect([doc.child(0).type.name, doc.child(0).textContent]).toEqual(["paragraph", "Before"]);
      expect([doc.child(1).type.name, doc.child(1).textContent, doc.child(1).attrs.language]).toEqual(["code_block", "", null]);
      expect([doc.child(2).type.name, doc.child(2).textContent]).toEqual(["paragraph", "After"]);
    });
  });

  it("undoes a longer fence and restores the exact reversed selection", () => {
    const source = "Before```\nbody\n````After";
    const selection = EditorSelection.single(19, 6);
    const transactions: Transaction[] = [];
    withEditor(source, selection, (view) => {
      expect(insertCodeBlock(view, "ts")).toBe(true);
      expect(view.state.doc.toString()).toBe("Before\n\n`````ts\n```\nbody\n````\n`````\n\nAfter");
      expect(view.state.selection.eq(EditorSelection.single(29))).toBe(true);
      expect(transactions).toHaveLength(1);
      expect(transactions[0].annotation(Transaction.userEvent)).toBe("input.format");
      expect(transactions[0].scrollIntoView).toBe(true);
      expect(view.hasFocus).toBe(true);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(source);
      expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
    }, [history(), EditorView.updateListener.of((update) => transactions.push(...update.transactions))]);
  });
});

describe("inline selection direction", () => {
  const plain = "pre\n(\u{10400}a\u0308) tail";
  const content = "\u{10400}a\u0308";
  type SelectionCase = {
    branch: "wrap" | "outside" | "contained";
    anchor: number;
    head: number;
    expected: [number, number, number, number];
  };
  const formats: { marker: InlineMarker; formatted: string; selections: SelectionCase[] }[] = [
    {
      marker: "**",
      formatted: "pre\n(**\u{10400}a\u0308**) tail",
      selections: [
        { branch: "wrap", anchor: 5, head: 9, expected: [7, 11, 7, 11] },
        { branch: "wrap", anchor: 9, head: 5, expected: [11, 7, 7, 11] },
        { branch: "outside", anchor: 7, head: 11, expected: [5, 9, 5, 9] },
        { branch: "outside", anchor: 11, head: 7, expected: [9, 5, 5, 9] },
        { branch: "contained", anchor: 5, head: 13, expected: [5, 9, 5, 9] },
        { branch: "contained", anchor: 13, head: 5, expected: [9, 5, 5, 9] },
      ],
    },
    {
      marker: "*",
      formatted: "pre\n(*\u{10400}a\u0308*) tail",
      selections: [
        { branch: "wrap", anchor: 5, head: 9, expected: [6, 10, 6, 10] },
        { branch: "wrap", anchor: 9, head: 5, expected: [10, 6, 6, 10] },
        { branch: "outside", anchor: 6, head: 10, expected: [5, 9, 5, 9] },
        { branch: "outside", anchor: 10, head: 6, expected: [9, 5, 5, 9] },
        { branch: "contained", anchor: 5, head: 11, expected: [5, 9, 5, 9] },
        { branch: "contained", anchor: 11, head: 5, expected: [9, 5, 5, 9] },
      ],
    },
    {
      marker: "`",
      formatted: "pre\n(`\u{10400}a\u0308`) tail",
      selections: [
        { branch: "wrap", anchor: 5, head: 9, expected: [6, 10, 6, 10] },
        { branch: "wrap", anchor: 9, head: 5, expected: [10, 6, 6, 10] },
        { branch: "outside", anchor: 6, head: 10, expected: [5, 9, 5, 9] },
        { branch: "outside", anchor: 10, head: 6, expected: [9, 5, 5, 9] },
        { branch: "contained", anchor: 5, head: 11, expected: [5, 9, 5, 9] },
        { branch: "contained", anchor: 11, head: 5, expected: [9, 5, 5, 9] },
      ],
    },
    {
      marker: "~~",
      formatted: "pre\n(~~\u{10400}a\u0308~~) tail",
      selections: [
        { branch: "wrap", anchor: 5, head: 9, expected: [7, 11, 7, 11] },
        { branch: "wrap", anchor: 9, head: 5, expected: [11, 7, 7, 11] },
        { branch: "outside", anchor: 7, head: 11, expected: [5, 9, 5, 9] },
        { branch: "outside", anchor: 11, head: 7, expected: [9, 5, 5, 9] },
        { branch: "contained", anchor: 5, head: 13, expected: [5, 9, 5, 9] },
        { branch: "contained", anchor: 13, head: 5, expected: [9, 5, 5, 9] },
      ],
    },
  ];

  describe.each(formats)("$marker", ({ marker, formatted, selections }) => {
    it.each(selections)("$branch from $anchor to $head", ({ branch, anchor, head, expected }) => {
      withEditor(branch === "wrap" ? plain : formatted, EditorSelection.single(anchor, head), (view) => {
        expect(toggleInlineMark(marker)(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(branch === "wrap" ? formatted : plain);
        const range = view.state.selection.main;
        expect([range.anchor, range.head, range.from, range.to]).toEqual(expected);
        expect(view.state.sliceDoc(range.from, range.to)).toBe(content);
        if (branch === "wrap") {
          expect(toggleInlineMark(marker)(view)).toBe(true);
          expect(view.state.doc.toString()).toBe(plain);
          const restored = view.state.selection.main;
          expect([restored.anchor, restored.head, restored.from, restored.to]).toEqual([anchor, head, 5, 9]);
          expect(view.state.sliceDoc(restored.from, restored.to)).toBe(content);
        }
      });
    });
  });

  it.each([
    {
      name: "partial word", doc: "pre\n(hello) tail", anchor: 9, head: 6,
      formatted: "pre\n(h**ell**o) tail", expected: [11, 8, 8, 11], text: "ell",
    },
    {
      name: "combining mark", doc: plain, anchor: 9, head: 8,
      formatted: "pre\n(\u{10400}a**\u0308**) tail", expected: [11, 10, 10, 11], text: "\u0308",
    },
    {
      name: "single surrogate unit", doc: plain, anchor: 6, head: 5,
      formatted: "pre\n(**\ud801**\udc00a\u0308) tail", expected: [8, 7, 7, 8], text: "\ud801",
    },
  ])("keeps a reversed explicit $name selection exact", ({ doc, anchor, head, formatted, expected, text }) => {
    withEditor(doc, EditorSelection.single(anchor, head), (view) => {
      toggleInlineMark("**")(view);
      expect(view.state.doc.toString()).toBe(formatted);
      const range = view.state.selection.main;
      expect([range.anchor, range.head, range.from, range.to]).toEqual(expected);
      expect(view.state.sliceDoc(range.from, range.to)).toBe(text);
      toggleInlineMark("**")(view);
      expect(view.state.doc.toString()).toBe(doc);
      expect(view.state.selection.eq(EditorSelection.single(anchor, head))).toBe(true);
    });
  });

  it("maps mixed directions and an empty caret across all branches with a non-first main range", () => {
    const doc = "one **two** **six** !";
    const selection = EditorSelection.create([
      EditorSelection.range(0, 3),
      EditorSelection.range(9, 6),
      EditorSelection.range(19, 12),
      EditorSelection.cursor(20),
    ], 2);
    withEditor(doc, selection, (view) => {
      expect(toggleInlineMark("**")(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("**one** two six ****!");
      expect(view.state.selection.ranges.map(({ anchor, head }) => [anchor, head]))
        .toEqual([[2, 5], [11, 8], [15, 12], [18, 18]]);
      expect(view.state.selection.mainIndex).toBe(2);
      expect(view.state.selection.ranges.map(({ from, to }) => view.state.sliceDoc(from, to)))
        .toEqual(["one", "two", "six", ""]);
      expect(toggleInlineMark("**")(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
      expect(view.state.selection.ranges.map(({ anchor, head }) => [anchor, head]))
        .toEqual([[0, 3], [9, 6], [17, 14], [20, 20]]);
      expect(view.state.selection.mainIndex).toBe(2);
      expect(view.state.selection.ranges.map(({ from, to }) => view.state.sliceDoc(from, to)))
        .toEqual(["one", "two", "six", ""]);
    }, [EditorState.allowMultipleSelections.of(true)]);
  });

  it.each([
    { name: "empty source", doc: "", anchor: 0, head: 0, formatted: "****", expected: [2, 2, 2, 2], text: "" },
    {
      name: "punctuation caret", doc: "pre\n(!) tail", anchor: 5, head: 5,
      formatted: "pre\n(****!) tail", expected: [7, 7, 7, 7], text: "",
    },
    {
      name: "whole word caret", doc: plain, anchor: 8, head: 8,
      formatted: "pre\n(**\u{10400}a\u0308**) tail", expected: [7, 11, 7, 11], text: content,
    },
    {
      name: "forward markers only", doc: "pre\n(****) tail", anchor: 5, head: 9,
      formatted: "pre\n() tail", expected: [5, 5, 5, 5], text: "",
    },
    {
      name: "reverse markers only", doc: "pre\n(****) tail", anchor: 9, head: 5,
      formatted: "pre\n() tail", expected: [5, 5, 5, 5], text: "",
    },
  ])("preserves the existing $name behavior", ({ doc, anchor, head, formatted, expected, text }) => {
    withEditor(doc, EditorSelection.single(anchor, head), (view) => {
      expect(toggleInlineMark("**")(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(formatted);
      const range = view.state.selection.main;
      expect([range.anchor, range.head, range.from, range.to]).toEqual(expected);
      expect(view.state.sliceDoc(range.from, range.to)).toBe(text);
    });
  });

  it.each([
    { name: "wrap", doc: plain, anchor: 9, head: 5, formatted: "pre\n(**\u{10400}a\u0308**) tail", expected: [11, 7] },
    { name: "outside unwrap", doc: "pre\n(**\u{10400}a\u0308**) tail", anchor: 11, head: 7, formatted: plain, expected: [9, 5] },
    { name: "contained unwrap", doc: "pre\n(**\u{10400}a\u0308**) tail", anchor: 13, head: 5, formatted: plain, expected: [9, 5] },
  ])("undoes a reversed $name including its original selection", ({ doc, anchor, head, formatted, expected }) => {
    const selection = EditorSelection.single(anchor, head);
    const transactions: Transaction[] = [];
    withEditor(doc, selection, (view) => {
      expect(toggleInlineMark("**")(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(formatted);
      expect([view.state.selection.main.anchor, view.state.selection.main.head]).toEqual(expected);
      expect(transactions).toHaveLength(1);
      expect(transactions[0].annotation(Transaction.userEvent)).toBe("input.format");
      expect(transactions[0].scrollIntoView).toBe(true);
      expect(transactions[0].docChanged).toBe(true);
      expect(view.hasFocus).toBe(true);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
      expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
    }, [
      history(),
      EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
    ]);
  });
});

describe("toggleInlineMark: word at an empty caret", () => {
  it.each([
    { name: "decomposed Latin", word: markedWord, carets: [0, 2, 3, 4, 6] },
    { name: "spacing mark", word: "\u0915\u093e\u092e", carets: [0, 1, 2, 3] },
    { name: "enclosing mark", word: "a\u20ddbc", carets: [1, 2, 4] },
    { name: "multiple marks", word: "a\u0308\u0301bc", carets: [1, 2, 3, 5] },
    { name: "supplementary mark", word: "a\u{1d165}b", carets: [1, 3, 4] },
    { name: "supplementary letters", word: supplementaryWord, carets: [0, 2, 4, 6] },
    { name: "mixed letters", word: "a\u{10428}b\u{10400}9", carets: [0, 1, 3, 4, 6, 7] },
    { name: "supplementary numbers", word: "\u{1d7d9}\u{1d7da}x", carets: [0, 2, 4, 5] },
    { name: "composed Latin", word: "caf\u00e9", carets: [0, 2, 4] },
    { name: "BMP numbers", word: "a\u0661\u0662b", carets: [0, 2, 4] },
  ])("selects the complete $name word at its boundaries and interior", ({ word, carets }) => {
    const prefix = "before\n(";
    const suffix = "), after\nlast";
    for (const caret of carets) {
      withEditor(prefix + word + suffix, EditorSelection.single(prefix.length + caret), (view) => {
        expect(toggleInlineMark("**")(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(prefix + "**" + word + "**" + suffix);
        expectSelection(view, prefix.length + 2, word);
      });
    }
  });

  describe.each(markers)("marker %s", (marker) => {
    it.each(representativeWords)("wraps and unwraps the complete $name word", ({ word, caret }) => {
      const prefix = "lead (";
      const suffix = ") tail";
      const source = prefix + word + suffix;
      withEditor(source, EditorSelection.single(prefix.length + caret), (view) => {
        expect(toggleInlineMark(marker)(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(prefix + marker + word + marker + suffix);
        expectSelection(view, prefix.length + marker.length, word);
        expect(toggleInlineMark(marker)(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(source);
        expectSelection(view, prefix.length, word);
      });
    });

    it.each(representativeWords)("unwraps $name from an empty caret", ({ word, caret }) => {
      const prefix = "lead (";
      const suffix = ") tail";
      withEditor(
        prefix + marker + word + marker + suffix,
        EditorSelection.single(prefix.length + marker.length + caret),
        (view) => {
          expect(toggleInlineMark(marker)(view)).toBe(true);
          expect(view.state.doc.toString()).toBe(prefix + word + suffix);
          expectSelection(view, prefix.length, word);
        },
      );
    });

    it.each([
      { name: "empty document", doc: "", caret: 0 },
      { name: "whitespace", doc: " \t ", caret: 1 },
      { name: "emoji and punctuation", doc: "\u{1f600}!", caret: 2 },
      { name: "empty line", doc: "left\n\nright", caret: 5 },
    ])("inserts paired markers and an inner cursor in $name", ({ doc, caret }) => {
      withEditor(doc, EditorSelection.single(caret), (view) => {
        expect(toggleInlineMark(marker)(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(doc.slice(0, caret) + marker + marker + doc.slice(caret));
        expectSelection(view, caret + marker.length, "");
        expect(view.state.selection.main.empty).toBe(true);
        expect(view.state.selection.main.head).toBe(caret + marker.length);
      });
    });
  });

  it.each([
    { name: "space", separator: " " },
    { name: "tab", separator: "\t" },
    { name: "period", separator: "." },
    { name: "comma", separator: "," },
    { name: "slash", separator: "/" },
    { name: "curly apostrophe", separator: "\u2019" },
    { name: "emoji", separator: "\u{1f600}" },
    { name: "line break", separator: "\n" },
  ])("does not cross a neighboring $name", ({ separator }) => {
    const word = "a\u0308\u{10428}b";
    const prefix = "left" + separator;
    const suffix = separator + "right";
    for (const caret of [0, word.length]) {
      withEditor(prefix + word + suffix, EditorSelection.single(prefix.length + caret), (view) => {
        expect(toggleInlineMark("**")(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(prefix + "**" + word + "**" + suffix);
        expectSelection(view, prefix.length + 2, word);
      });
    }
  });

  it.each(["hello", "12345", "snake_case", "can't", "well-known", "a1_b'c-2"])(
    "preserves the ASCII source token %s",
    (word) => {
      for (const caret of [0, Math.floor(word.length / 2), word.length]) {
        withEditor(word, EditorSelection.single(caret), (view) => {
          expect(toggleInlineMark("**")(view)).toBe(true);
          expect(view.state.doc.toString()).toBe("**" + word + "**");
          expectSelection(view, 2, word);
        });
      }
    },
  );
});

describe("toggleInlineMark: explicit selections and transactions", () => {
  describe.each(["forward", "reversed"])("%s selection", (direction) => {
    it.each([
      { name: "partial marked word", word: markedWord, from: 1, to: 3 },
      { name: "only the combining mark", word: markedWord, from: 3, to: 4 },
      { name: "partial supplementary word", word: supplementaryWord, from: 2, to: 4 },
      { name: "one explicit surrogate unit", word: supplementaryWord, from: 1, to: 2 },
    ])("formats exactly the $name selection without expanding it", ({ word, from, to }) => {
      const selection = direction === "forward"
        ? EditorSelection.single(from, to)
        : EditorSelection.single(to, from);
      withEditor(word, selection, (view) => {
        const selected = word.slice(from, to);
        expect(toggleInlineMark("**")(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(word.slice(0, from) + "**" + selected + "**" + word.slice(to));
        expectSelection(view, from + 2, selected);
        expect(toggleInlineMark("**")(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(word);
        expectSelection(view, from, selected);
      });
    });
  });

  it("maps UTF-16 selections for disjoint marked and supplementary words", () => {
    const prefix = "\u{1f600} ";
    const separator = " / ";
    const suffix = "!";
    const secondFrom = prefix.length + markedWord.length + separator.length;
    const source = prefix + markedWord + separator + supplementaryWord + suffix;
    const selection = EditorSelection.create([
      EditorSelection.cursor(prefix.length + 3),
      EditorSelection.cursor(secondFrom + 2),
    ], 1);
    withEditor(source, selection, (view) => {
      expect(toggleInlineMark("**")(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(
        prefix + "**" + markedWord + "**" + separator + "**" + supplementaryWord + "**" + suffix,
      );
      expect(view.state.selection.ranges).toHaveLength(2);
      expect(view.state.selection.mainIndex).toBe(1);
      expectSelection(view, prefix.length + 2, markedWord, 0);
      expectSelection(view, secondFrom + 6, supplementaryWord, 1);
      expect(toggleInlineMark("**")(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(source);
      expect(view.state.selection.ranges).toHaveLength(2);
      expectSelection(view, prefix.length, markedWord, 0);
      expectSelection(view, secondFrom, supplementaryWord, 1);
    }, [EditorState.allowMultipleSelections.of(true)]);
  });

  it("keeps normal formatting transactions, focus, and history undo", () => {
    const source = "before " + markedWord + " after";
    const selection = EditorSelection.single("before ".length + 3);
    const transactions: Transaction[] = [];
    withEditor(source, selection, (view) => {
      expect(toggleInlineMark("**")(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("before **" + markedWord + "** after");
      expectSelection(view, "before **".length, markedWord);
      expect(transactions).toHaveLength(1);
      expect(transactions[0].annotation(Transaction.userEvent)).toBe("input.format");
      expect(transactions[0].scrollIntoView).toBe(true);
      expect(view.hasFocus).toBe(true);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(source);
      expect(view.state.selection.eq(selection)).toBe(true);
    }, [
      history(),
      EditorView.updateListener.of((update) => {
        transactions.push(...update.transactions);
      }),
    ]);
  });
});

describe("selected line boundaries", () => {
  const prefixes: { kind: LinePrefixKind; marker: string }[] = [
    { kind: "bullet", marker: "- " },
    { kind: "ordered", marker: "1. " },
    { kind: "task", marker: "- [ ] " },
    { kind: "quote", marker: "> " },
  ];
  const commands = [
    { name: "heading", command: setHeading(2), markers: ["## ", "## ", "## "] },
    { name: "ordered", command: toggleLinePrefix("ordered"), markers: ["1. ", "2. ", "3. "] },
  ];

  describe.each(["forward", "reversed"])("%s selection ending at the next line start", (direction) => {
    function selection(from: number, to: number) {
      return direction === "forward" ? EditorSelection.single(from, to) : EditorSelection.single(to, from);
    }

    it.each([
      { action: "add", level: 2, doc: "lead\none\ntwo\nlast", from: 6, to: 9, expected: "lead\n## one\ntwo\nlast" },
      { action: "change", level: 2, doc: "lead\n  # one\n### two\nlast", from: 10, to: 13, expected: "lead\n## one\n### two\nlast" },
      { action: "clear", level: 0, doc: "lead\n  ## one\n### two\nlast", from: 11, to: 14, expected: "lead\none\n### two\nlast" },
    ])("heading $action touches only the partially selected later line", ({ level, doc, from, to, expected }) => {
      withEditor(doc, selection(from, to), (view) => {
        expect(view.state.selection.main.from).toBe(from);
        expect(view.state.selection.main.to).toBe(to);
        expect(setHeading(level)(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(expected);
      });
    });

    it.each(prefixes)("adds $kind only to the partially selected later line", ({ kind, marker }) => {
      withEditor("lead\n  one\ntwo\nlast", selection(8, 11), (view) => {
        expect(toggleLinePrefix(kind)(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(`lead\n  ${marker}one\ntwo\nlast`);
      });
    });

    it.each(prefixes)("removes $kind despite the unmarked excluded next line", ({ kind, marker }) => {
      const doc = `${marker}one\ntwo`;
      withEditor(doc, selection(0, marker.length + 4), (view) => {
        expect(toggleLinePrefix(kind)(view)).toBe(true);
        expect(view.state.doc.toString()).toBe("one\ntwo");
      });
    });
  });

  it("numbers three selected lines together without converting the excluded trailing line", () => {
    const transactions: Transaction[] = [];
    withEditor("lead\n  - one\n> two\n9. three\nlast\nend", EditorSelection.single(8, 28), (view) => {
      expect(toggleLinePrefix("ordered")(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("lead\n  1. one\n2. two\n3. three\nlast\nend");
      expect(transactions).toHaveLength(1);
      const changedFrom: number[] = [];
      transactions[0].changes.iterChanges((from) => changedFrom.push(from));
      expect(changedFrom).toEqual([5, 13, 19]);
    }, [
      EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
    ]);
  });

  describe.each(commands)("$name caret, newline, and EOF boundaries", ({ command, markers: [first, second] }) => {
    it.each([
      { name: "ordinary line-start caret", doc: "one\ntwo\nlast", from: 4, to: 4, expected: `one\n${first}two\nlast` },
      { name: "final empty-line caret", doc: "one\n", from: 4, to: 4, expected: `one\n${first}` },
      { name: "empty document caret", doc: "", from: 0, to: 0, expected: first },
      { name: "end inside the next line", doc: "one\ntwo\nlast", from: 1, to: 5, expected: `${first}one\n${second}two\nlast` },
      { name: "complete first line and newline", doc: "one\ntwo", from: 0, to: 4, expected: `${first}one\ntwo` },
      { name: "whole document without final newline", doc: "one\ntwo", from: 0, to: 7, expected: `${first}one\n${second}two` },
      { name: "whole document with final newline", doc: "one\ntwo\n", from: 0, to: 8, expected: `${first}one\n${second}two\n` },
      { name: "selected blank line newline only", doc: "one\n\ntwo", from: 4, to: 5, expected: `one\n${first}\ntwo` },
      { name: "selected nonblank line newline only", doc: "one\ntwo", from: 3, to: 4, expected: `${first}one\ntwo` },
    ])("includes only intersected lines for $name [$from, $to)", ({ doc, from, to, expected }) => {
      withEditor(doc, EditorSelection.single(from, to), (view) => {
        expect(command(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(expected);
      });
    });
  });

  it.each(commands)("$name includes independently selected end lines and deduplicates shared touched lines", ({ command, markers }) => {
    const transactions: Transaction[] = [];
    const selection = EditorSelection.create([
      EditorSelection.range(0, 4),
      EditorSelection.cursor(5),
      EditorSelection.range(8, 14),
      EditorSelection.cursor(16),
    ], 2);
    withEditor("one\ntwo words\nlast\nend", selection, (view) => {
      expect(view.state.selection.ranges.map(({ from, to }) => [from, to])).toEqual([[0, 4], [5, 5], [8, 14], [16, 16]]);
      expect(command(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(`${markers[0]}one\n${markers[1]}two words\n${markers[2]}last\nend`);
      expect(view.state.selection.ranges).toHaveLength(4);
      expect(view.state.selection.mainIndex).toBe(2);
      expect(transactions).toHaveLength(1);
      const changedFrom: number[] = [];
      transactions[0].changes.iterChanges((from) => changedFrom.push(from));
      expect(changedFrom).toEqual([0, 4, 14]);
    }, [
      EditorState.allowMultipleSelections.of(true),
      EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
    ]);
  });

  it.each(commands)("$name preserves mapped selection, formatting transaction, focus, and undo", ({ command, markers }) => {
    const doc = "lead\none\ntwo\nlast";
    const selection = EditorSelection.single(9, 6);
    const transactions: Transaction[] = [];
    withEditor(doc, selection, (view) => {
      expect(command(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(`lead\n${markers[0]}one\ntwo\nlast`);
      expect(view.state.selection.eq(EditorSelection.single(12, 9))).toBe(true);
      expect(transactions).toHaveLength(1);
      expect(transactions[0].annotation(Transaction.userEvent)).toBe("input.format");
      expect(transactions[0].scrollIntoView).toBe(true);
      expect(view.hasFocus).toBe(true);
      const changes: number[][] = [];
      transactions[0].changes.iterChanges((fromA, toA, fromB, toB) => changes.push([fromA, toA, fromB, toB]));
      expect(changes).toEqual([[5, 5, 5, 8]]);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
      expect(view.state.selection.eq(selection)).toBe(true);
    }, [
      history(),
      EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
    ]);
  });

  it("returns false without dispatch when only the excluded next line has a heading to clear", () => {
    const transactions: Transaction[] = [];
    const selection = EditorSelection.single(0, 4);
    withEditor("one\n# two", selection, (view) => {
      expect(setHeading(0)(view)).toBe(false);
      expect(view.state.doc.toString()).toBe("one\n# two");
      expect(view.state.selection.eq(selection)).toBe(true);
      expect(transactions).toHaveLength(0);
    }, [
      EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
    ]);
  });
});

describe("source destination delimiters", () => {
  const commands = [
    { name: "link", command: insertLink, scrollIntoView: true },
    { name: "image", command: insertImage, scrollIntoView: false },
  ] as const;

  function expectDestination(node: PMNode, kind: "link" | "image", url: string) {
    expect(node.childCount).toBe(0);
    if (kind === "link") {
      expect(node.type.name).toBe("text");
      expect(node.text).toBe("Guide");
      expect(node.marks).toHaveLength(1);
      expect(node.marks[0].type.name).toBe("link");
      expect(node.marks[0].attrs.href).toBe(url);
    } else {
      expect(node.type.name).toBe("image");
      expect(node.attrs.src).toBe(url);
      expect(node.attrs.alt).toBe("Guide");
      expect(node.marks).toHaveLength(0);
    }
  }

  describe.each(commands)("$name", ({ name, command, scrollIntoView }) => {
    it.each([
      {
        name: "simple HTTPS",
        url: "https://example.com/guide",
        link: "[Guide](https://example.com/guide)",
        image: "![Guide](https://example.com/guide)",
      },
      {
        name: "relative Unicode",
        url: "../caf\u00e9#intro",
        link: "[Guide](../caf\u00e9#intro)",
        image: "![Guide](../caf\u00e9#intro)",
      },
      {
        name: "Unicode fragment",
        url: "#r\u00e9sum\u00e9",
        link: "[Guide](#r\u00e9sum\u00e9)",
        image: "![Guide](#r\u00e9sum\u00e9)",
      },
      {
        name: "percent-encoded delimiters and controls",
        url: "/guide%28chapter%29%5C%20%0A%00",
        link: "[Guide](/guide%28chapter%29%5C%20%0A%00)",
        image: "![Guide](/guide%28chapter%29%5C%20%0A%00)",
      },
      {
        name: "balanced parentheses",
        url: "/guide(chapter)",
        link: String.raw`[Guide](/guide\(chapter\))`,
        image: String.raw`![Guide](/guide\(chapter\))`,
      },
      {
        name: "unmatched opening parenthesis",
        url: "/guide(chapter",
        link: String.raw`[Guide](/guide\(chapter)`,
        image: String.raw`![Guide](/guide\(chapter)`,
      },
      {
        name: "unmatched closing parenthesis",
        url: "/guide)chapter",
        link: String.raw`[Guide](/guide\)chapter)`,
        image: String.raw`![Guide](/guide\)chapter)`,
      },
      {
        name: "repeated parentheses",
        url: "/guide))chapter((",
        link: String.raw`[Guide](/guide\)\)chapter\(\()`,
        image: String.raw`![Guide](/guide\)\)chapter\(\()`,
      },
      {
        name: "nested parentheses",
        url: "/guide((chapter)part)",
        link: String.raw`[Guide](/guide\(\(chapter\)part\))`,
        image: String.raw`![Guide](/guide\(\(chapter\)part\))`,
      },
      {
        name: "backslash before opening parenthesis",
        url: String.raw`/guide\(chapter`,
        link: String.raw`[Guide](/guide\\\(chapter)`,
        image: String.raw`![Guide](/guide\\\(chapter)`,
      },
      {
        name: "backslash before closing parenthesis",
        url: String.raw`/guide\)chapter`,
        link: String.raw`[Guide](/guide\\\)chapter)`,
        image: String.raw`![Guide](/guide\\\)chapter)`,
      },
      {
        name: "backslash before ordinary punctuation",
        url: String.raw`/guide\!chapter`,
        link: String.raw`[Guide](/guide\\!chapter)`,
        image: String.raw`![Guide](/guide\\!chapter)`,
      },
      {
        name: "doubled backslash",
        url: String.raw`/guide\\chapter`,
        link: String.raw`[Guide](/guide\\\\chapter)`,
        image: String.raw`![Guide](/guide\\\\chapter)`,
      },
      {
        name: "combined backslashes and parentheses",
        url: String.raw`/guide\(one\\two\))`,
        link: String.raw`[Guide](/guide\\\(one\\\\two\\\)\))`,
        image: String.raw`![Guide](/guide\\\(one\\\\two\\\)\))`,
      },
      {
        name: "trailing backslash",
        url: "/guide\\",
        link: String.raw`[Guide](/guide\\)`,
        image: String.raw`![Guide](/guide\\)`,
      },
      {
        name: "absolute URL with parentheses",
        url: "https://example.com/guide(chapter)",
        link: String.raw`[Guide](https://example.com/guide\(chapter\))`,
        image: String.raw`![Guide](https://example.com/guide\(chapter\))`,
      },
    ])("preserves $name as exactly one parsed destination", (fixture) => {
      withEditor("", EditorSelection.single(0), (view) => {
        expect(command(view, fixture.url, "Guide")).toBe(true);
        expect(view.state.doc.toString()).toBe(fixture[name]);
        expect(view.state.doc.length).toBe(fixture[name].length);
        expect(view.state.selection.eq(EditorSelection.single(fixture[name].length))).toBe(true);
        const { doc } = parseMarkdown(view.state.doc.toString());
        expect(doc.childCount).toBe(1);
        expect(doc.child(0).type.name).toBe("paragraph");
        expect(doc.child(0).childCount).toBe(1);
        expectDestination(doc.child(0).child(0), name, fixture.url);
      });
    });

    it.each(["forward", "reversed", "collapsed"])(
      "preserves surrounding paragraphs, transaction, cursor, focus, and undo for a %s selection",
      (direction) => {
        const prefix = "Before\n\nlead ";
        const suffix = " tail\n\nAfter";
        const selected = direction === "collapsed" ? "" : "old";
        const source = prefix + selected + suffix;
        const from = prefix.length;
        const to = from + selected.length;
        const selection = direction === "reversed"
          ? EditorSelection.single(to, from)
          : EditorSelection.single(from, to);
        const url = String.raw`/guide\(part\))`;
        const emitted = name === "link"
          ? String.raw`[Guide](/guide\\\(part\\\)\))`
          : String.raw`![Guide](/guide\\\(part\\\)\))`;
        const transactions: Transaction[] = [];
        withEditor(source, selection, (view) => {
          expect(command(view, url, "Guide")).toBe(true);
          expect(view.state.doc.toString()).toBe(prefix + emitted + suffix);
          expect(view.state.doc.length).toBe(source.length - selected.length + emitted.length);
          expect(view.state.selection.eq(EditorSelection.single(from + emitted.length))).toBe(true);
          expect(transactions).toHaveLength(1);
          expect(transactions[0].annotation(Transaction.userEvent)).toBe("input.format");
          expect(transactions[0].scrollIntoView).toBe(scrollIntoView);
          const changes: { fromA: number; toA: number; fromB: number; toB: number; text: string }[] = [];
          transactions[0].changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
            changes.push({ fromA, toA, fromB, toB, text: inserted.toString() });
          });
          expect(changes).toEqual([{ fromA: from, toA: to, fromB: from, toB: from + emitted.length, text: emitted }]);
          expect(view.hasFocus).toBe(true);
          const { doc } = parseMarkdown(view.state.doc.toString());
          expect(doc.childCount).toBe(3);
          expect(doc.child(0).textContent).toBe("Before");
          expect(doc.child(2).textContent).toBe("After");
          const paragraph = doc.child(1);
          expect(paragraph.type.name).toBe("paragraph");
          expect(paragraph.childCount).toBe(3);
          expect(paragraph.child(0).text).toBe("lead ");
          expect(paragraph.child(0).marks).toHaveLength(0);
          expectDestination(paragraph.child(1), name, url);
          expect(paragraph.child(2).text).toBe(" tail");
          expect(paragraph.child(2).marks).toHaveLength(0);
          expect(undo(view)).toBe(true);
          expect(view.state.doc.toString()).toBe(source);
          expect(view.state.selection.eq(selection)).toBe(true);
        }, [
          history(),
          EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
        ]);
      },
    );

    it("replaces only the main selection and retains the existing single-cursor result", () => {
      const selection = EditorSelection.create([
        EditorSelection.range(0, 4),
        EditorSelection.range(10, 7),
      ], 1);
      withEditor("left / old / right", selection, (view) => {
        expect(command(view, "/guide)chapter", "Guide")).toBe(true);
        const expected = name === "link"
          ? String.raw`left / [Guide](/guide\)chapter) / right`
          : String.raw`left / ![Guide](/guide\)chapter) / right`;
        expect(view.state.doc.toString()).toBe(expected);
        expect(view.state.selection.eq(EditorSelection.single(expected.length - " / right".length))).toBe(true);
      }, [EditorState.allowMultipleSelections.of(true)]);
    });

    it.each([
      {
        name: "selected source",
        selected: "Selected",
        text: undefined,
        link: String.raw`[Selected](/guide\\\(part\))`,
        image: String.raw`![](/guide\\\(part\))`,
      },
      {
        name: "selected Markdown without new label escaping",
        selected: "[part] **bold** <i>text</i>",
        text: undefined,
        link: String.raw`[[part] **bold** <i>text</i>](/guide\\\(part\))`,
        image: String.raw`![](/guide\\\(part\))`,
      },
      {
        name: "explicit text overriding the selection",
        selected: "Selected",
        text: "Guide",
        link: String.raw`[Guide](/guide\\\(part\))`,
        image: String.raw`![Guide](/guide\\\(part\))`,
      },
      {
        name: "explicit empty text overriding the selection",
        selected: "Selected",
        text: "",
        link: String.raw`[](/guide\\\(part\))`,
        image: String.raw`![](/guide\\\(part\))`,
      },
      {
        name: "unescaped URL fallback for links and empty default image alt",
        selected: "",
        text: undefined,
        link: String.raw`[/guide\(part)](/guide\\\(part\))`,
        image: String.raw`![](/guide\\\(part\))`,
      },
      {
        name: "explicit Markdown without new label or alt escaping",
        selected: "Selected",
        text: "[part] **bold** <i>text</i>",
        link: String.raw`[[part] **bold** <i>text</i>](/guide\\\(part\))`,
        image: String.raw`![[part] **bold** <i>text</i>](/guide\\\(part\))`,
      },
    ])("preserves the source policy for $name", (fixture) => {
      withEditor(fixture.selected, EditorSelection.single(0, fixture.selected.length), (view) => {
        expect(command(view, String.raw`/guide\(part)`, fixture.text)).toBe(true);
        expect(view.state.doc.toString()).toBe(fixture[name]);
        expect(view.state.selection.eq(EditorSelection.single(fixture[name].length))).toBe(true);
      });
    });
  });
});

describe("clear source Setext headings", () => {
  const language = markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false });
  type Heading = { level: number; from: number; to: number; parents: string[] };
  const heading = (level: number, from: number, to: number, parents = ["Document"]): Heading =>
    ({ level, from, to, parents });

  function parsed(view: EditorView) {
    const tree = ensureSyntaxTree(view.state, view.state.doc.length, 1000);
    expect(tree).not.toBeNull();
    const headings: Heading[] = [];
    const containers: string[] = [];
    tree!.iterate({
      enter(node) {
        if (["Blockquote", "BulletList", "OrderedList", "ListItem"].includes(node.name)) {
          containers.push(node.name);
        }
        if (node.name !== "SetextHeading1" && node.name !== "SetextHeading2") return;
        const mark = node.node.getChild("HeaderMark");
        expect(mark).not.toBeNull();
        expect(mark!.parent?.from).toBe(node.from);
        expect(mark!.parent?.name).toBe(node.name);
        const parents: string[] = [];
        for (let parent = node.node.parent; parent; parent = parent.parent) parents.push(parent.name);
        headings.push(heading(node.name === "SetextHeading1" ? 1 : 2, mark!.from, mark!.to, parents));
        return false;
      },
    });
    return { tree: tree!, headings, containers };
  }

  function expectChanges(transaction: Transaction, deleted: [number, number][]) {
    const actual: { from: number; to: number; mappedFrom: number; mappedTo: number; text: string }[] = [];
    transaction.changes.iterChanges((from, to, mappedFrom, mappedTo, inserted) => {
      actual.push({ from, to, mappedFrom, mappedTo, text: inserted.toString() });
    });
    let removed = 0;
    const expected = deleted.map(([from, to]) => {
      const mappedFrom = from - removed;
      removed += to - from;
      return { from, to, mappedFrom, mappedTo: mappedFrom, text: "" };
    });
    expect(actual).toEqual(expected);
  }

  function clears({
    source, selection, expected, headings, deleted = headings.map(({ from, to }) => [from, to]),
    remaining = [], after,
  }: {
    source: string;
    selection: EditorSelection;
    expected: string;
    headings: Heading[];
    deleted?: [number, number][];
    remaining?: Heading[];
    after?: (view: EditorView) => void;
  }) {
    const transactions: Transaction[] = [];
    withEditor(source, selection, (view) => {
      const before = parsed(view);
      expect(before.headings).toEqual(headings);
      const focus = vi.spyOn(view, "focus");
      expect(setHeading(0)(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(expected);
      expect(transactions).toHaveLength(1);
      const transaction = transactions[0];
      expect(transaction.docChanged).toBe(true);
      expect(transaction.annotation(Transaction.userEvent)).toBe("input.format");
      expect(transaction.scrollIntoView).toBe(true);
      expectChanges(transaction, deleted);
      expect(view.state.selection.toJSON()).toEqual(selection.map(transaction.changes).toJSON());
      expect(view.state.selection.mainIndex).toBe(selection.mainIndex);
      expect(focus).toHaveBeenCalledTimes(1);
      expect(view.hasFocus).toBe(true);
      const reparsed = parsed(view);
      expect(reparsed.headings).toEqual(remaining);
      expect(reparsed.containers).toEqual(before.containers);
      after?.(view);

      view.contentDOM.blur();
      const state = view.state;
      expect(setHeading(0)(view)).toBe(false);
      expect(view.state).toBe(state);
      expect(transactions).toHaveLength(1);
      expect(focus).toHaveBeenCalledTimes(1);
      expect(view.hasFocus).toBe(false);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(source);
      expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
      expect(parsed(view).headings).toEqual(headings);
      focus.mockRestore();
    }, [
      language,
      history(),
      EditorState.allowMultipleSelections.of(true),
      EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
    ]);
  }

  describe.each([
    { level: 1, mark: "===" },
    { level: 2, mark: "---" },
  ])("level $level", ({ level, mark }) => {
    it.each([
      { name: "text start", head: 0 },
      { name: "text middle", head: 2 },
      { name: "text end", head: 5 },
      { name: "underline start", head: 6 },
      { name: "underline middle", head: 7 },
      { name: "underline end at EOF", head: 9 },
    ])("clears from $name without deleting the line separator", ({ head }) => {
      clears({
        source: `Title\n${mark}`, selection: EditorSelection.single(head),
        expected: "Title\n", headings: [heading(level, 6, 9)],
        after(view) {
          const { doc } = parseMarkdown(view.state.doc.toString());
          expect(doc.childCount).toBe(1);
          expect([doc.child(0).type.name, doc.child(0).textContent]).toEqual(["paragraph", "Title"]);
        },
      });
    });

    it("keeps a final newline when the caret is at the underline end", () => {
      clears({
        source: `Title\n${mark}\n`, selection: EditorSelection.single(9),
        expected: "Title\n\n", headings: [heading(level, 6, 9)],
      });
    });

    it("leaves a blank line before the following paragraph", () => {
      clears({
        source: `Title\n${mark}\nAfter`, selection: EditorSelection.single(2),
        expected: "Title\n\nAfter", headings: [heading(level, 6, 9)],
        after(view) {
          const { doc } = parseMarkdown(view.state.doc.toString());
          expect(doc.childCount).toBe(2);
          expect([doc.child(0).type.name, doc.child(0).textContent]).toEqual(["paragraph", "Title"]);
          expect([doc.child(1).type.name, doc.child(1).textContent]).toEqual(["paragraph", "After"]);
        },
      });
    });

    it.each([
      { name: "text indentation", head: 0 },
      { name: "underline indentation", head: 8 },
      { name: "underline trailing whitespace", head: 15 },
    ])("preserves whitespace and the following paragraph from $name", ({ head }) => {
      clears({
        source: `  Title\n   ${mark}  \nAfter`, selection: EditorSelection.single(head),
        expected: "  Title\n     \nAfter", headings: [heading(level, 11, 14)],
        after(view) {
          const { doc } = parseMarkdown(view.state.doc.toString());
          expect(doc.childCount).toBe(2);
          expect([doc.child(0).type.name, doc.child(0).textContent]).toEqual(["paragraph", "  Title"]);
          expect([doc.child(1).type.name, doc.child(1).textContent]).toEqual(["paragraph", "After"]);
        },
      });
    });

    it("clears a multiline heading once when all its lines are selected", () => {
      clears({
        source: `First\nsecond\n${mark}\nAfter`, selection: EditorSelection.single(0, 16),
        expected: "First\nsecond\n\nAfter", headings: [heading(level, 13, 16)],
      });
    });

    it("keeps supplementary, combining and inline-mark content unchanged", () => {
      const text = "**\u{10400}Cafe\u0301** and *soft* and `code`";
      clears({
        source: `${text}\n${mark}`, selection: EditorSelection.single(text.length - 2, 3),
        expected: `${text}\n`, headings: [heading(level, text.length + 1, text.length + 4)],
        after(view) {
          const { doc } = parseMarkdown(view.state.doc.toString());
          const paragraph = doc.child(0);
          expect(paragraph.type.name).toBe("paragraph");
          expect(paragraph.textContent).toBe("\u{10400}Cafe\u0301 and soft and code");
          expect(paragraph.child(0).marks.map((mark) => mark.type.name)).toEqual(["strong"]);
          expect(paragraph.child(2).marks.map((mark) => mark.type.name)).toEqual(["em"]);
          expect(paragraph.child(4).marks.map((mark) => mark.type.name)).toEqual(["code"]);
        },
      });
    });

    it.each([
      {
        name: "quote", textPrefix: "> ", underlinePrefix: ">   ",
        parents: ["Blockquote", "Document"], richContainer: "blockquote",
      },
      {
        name: "bullet", textPrefix: "- ", underlinePrefix: "    ",
        parents: ["ListItem", "BulletList", "Document"], richContainer: "bullet_list",
      },
      {
        name: "ordered item", textPrefix: "1. ", underlinePrefix: "     ",
        parents: ["ListItem", "OrderedList", "Document"], richContainer: "ordered_list",
      },
    ])("clears from either $name prefix while retaining the marker-only line", ({ textPrefix, underlinePrefix, parents, richContainer }) => {
      const text = `${textPrefix}Title`;
      const markFrom = text.length + 1 + underlinePrefix.length;
      for (const head of [0, text.length + 1]) {
        clears({
          source: `${text}\n${underlinePrefix}${mark}  \n\nAfter`,
          selection: EditorSelection.single(head),
          expected: `${text}\n${underlinePrefix}  \n\nAfter`,
          headings: [heading(level, markFrom, markFrom + mark.length, parents)],
          after(view) {
            const { doc } = parseMarkdown(view.state.doc.toString());
            expect(doc.childCount).toBe(2);
            expect([doc.child(0).type.name, doc.child(0).textContent]).toEqual([richContainer, "Title"]);
            expect([doc.child(1).type.name, doc.child(1).textContent]).toEqual(["paragraph", "After"]);
          },
        });
      }
    });
  });

  it.each(["forward", "reversed"])("clears the heading when a %s selection excludes its underline line", (direction) => {
    clears({
      source: "First\nsecond\n===\nAfter",
      selection: direction === "forward" ? EditorSelection.single(6, 13) : EditorSelection.single(13, 6),
      expected: "First\nsecond\n\nAfter", headings: [heading(1, 13, 16)],
    });
  });

  it.each(["forward", "reversed"])("leaves the next heading untouched at a %s exclusive endpoint", (direction) => {
    clears({
      source: "First\n===\n\nSecond\n---",
      selection: direction === "forward" ? EditorSelection.single(0, 11) : EditorSelection.single(11, 0),
      expected: "First\n\n\nSecond\n---",
      headings: [heading(1, 6, 9), heading(2, 18, 21)], deleted: [[6, 9]],
      remaining: [heading(2, 15, 18)],
    });
  });

  it("includes the next heading when a caret is at its first-line start", () => {
    clears({
      source: "First\n===\n\nSecond\n---", selection: EditorSelection.single(11),
      expected: "First\n===\n\nSecond\n",
      headings: [heading(1, 6, 9), heading(2, 18, 21)], deleted: [[18, 21]],
      remaining: [heading(1, 6, 9)],
    });
  });

  it("clears multiple headings and ATX lines in source order without changing prose", () => {
    const source = "# Before\n\nFirst\n===\n\nordinary\n\nSecond\n---\n\n## After";
    const first = source.indexOf("===");
    const second = source.indexOf("---");
    const atx = source.indexOf("##");
    clears({
      source, selection: EditorSelection.single(source.length, 0),
      expected: "Before\n\nFirst\n\n\nordinary\n\nSecond\n\n\nAfter",
      headings: [heading(1, first, first + 3), heading(2, second, second + 3)],
      deleted: [[0, 2], [first, first + 3], [second, second + 3], [atx, atx + 3]],
    });
  });

  it("deduplicates shared headings across distinct ranges and keeps a nonzero main index", () => {
    const source = "First\nsecond\n===\n\nNext\n---";
    const selection = EditorSelection.create([
      EditorSelection.range(3, 0),
      EditorSelection.range(9, 11),
      EditorSelection.cursor(14),
      EditorSelection.range(24, 20),
    ], 1);
    clears({
      source, selection, expected: "First\nsecond\n\n\nNext\n",
      headings: [heading(1, 13, 16), heading(2, 23, 26)],
      after(view) {
        expect(view.state.selection.toJSON()).toEqual(EditorSelection.create([
          EditorSelection.range(3, 0),
          EditorSelection.range(9, 11),
          EditorSelection.cursor(13),
          EditorSelection.range(20, 17),
        ], 1).toJSON());
      },
    });
  });

  it("preserves nested quote/list prefixes and a minimally sized underline", () => {
    clears({
      source: "> - Title\n>   =\n>   \n>   After", selection: EditorSelection.single(10),
      expected: "> - Title\n>   \n>   \n>   After",
      headings: [heading(1, 14, 15, ["ListItem", "BulletList", "Blockquote", "Document"])],
      after(view) {
        const { doc } = parseMarkdown(view.state.doc.toString());
        expect(doc.child(0).type.name).toBe("blockquote");
        const list = doc.child(0).child(0);
        expect(list.type.name).toBe("bullet_list");
        const item = list.child(0);
        expect(item.childCount).toBe(2);
        expect([item.child(0).type.name, item.child(0).textContent]).toEqual(["paragraph", "Title"]);
        expect([item.child(1).type.name, item.child(1).textContent]).toEqual(["paragraph", "After"]);
      },
    });
  });

  it("does not scan a genuine heading's tab-indented continuation for ATX-like text", () => {
    const source = "Title\n\t# literal\n===";
    const selection = EditorSelection.single(6, 17);
    const transactions: Transaction[] = [];
    withEditor(source, selection, (view) => {
      expect(parsed(view).headings).toEqual([heading(1, 17, 20)]);
      expect(setHeading(0)(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("Title\n\t# literal\n");
      expect(transactions).toHaveLength(1);
      expectChanges(transactions[0], [[17, 20]]);
      expect(parsed(view).headings).toEqual([]);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(source);
      expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
    }, [language, history(), EditorView.updateListener.of((update) => transactions.push(...update.transactions))]);
  });

  it.each([
    { name: "standalone thematic break", source: "---", kind: "HorizontalRule" },
    { name: "separated thematic break", source: "Title\n\n---", kind: "HorizontalRule" },
    { name: "plain prose", source: "Title\nordinary", kind: "Paragraph" },
    { name: "escaped dashes", source: "Title\n\\---", kind: "Paragraph" },
    { name: "escaped equals", source: "Title\n\\===", kind: "Paragraph" },
    { name: "fenced code", source: "```\nTitle\n===\n```", kind: "FencedCode" },
    { name: "indented code", source: "    Title\n    ---", kind: "CodeBlock" },
    { name: "final empty line", source: "Title\n===\n", kind: "SetextHeading1", selection: EditorSelection.single(10) },
    { name: "exclusive forward endpoint", source: "Before\n\nTitle\n===", kind: "SetextHeading1", selection: EditorSelection.single(0, 8) },
    { name: "exclusive reversed endpoint", source: "Before\n\nTitle\n===", kind: "SetextHeading1", selection: EditorSelection.single(8, 0) },
  ])("does not dispatch or focus for $name", ({ source, kind, selection = EditorSelection.single(0, source.length) }) => {
    const transactions: Transaction[] = [];
    withEditor(source, selection, (view) => {
      const before = parsed(view);
      const names: string[] = [];
      before.tree.iterate({ enter(node) { names.push(node.name); } });
      expect(names).toContain(kind);
      expect(before.headings).toHaveLength(kind === "SetextHeading1" ? 1 : 0);
      const state = view.state;
      const focus = vi.spyOn(view, "focus");
      expect(setHeading(0)(view)).toBe(false);
      expect(view.state).toBe(state);
      expect(view.state.doc.toString()).toBe(source);
      expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
      expect(transactions).toHaveLength(0);
      expect(focus).not.toHaveBeenCalled();
      expect(view.hasFocus).toBe(false);
      focus.mockRestore();
    }, [language, EditorView.updateListener.of((update) => transactions.push(...update.transactions))]);
  });

  it.each([1, 2, 3, 4, 5, 6])("keeps the existing positive level %i ATX-line operation", (level) => {
    const source = "Title\n===\n\n## Existing";
    withEditor(source, EditorSelection.single(0, source.length), (view) => {
      expect(parsed(view).headings).toEqual([heading(1, 6, 9)]);
      expect(setHeading(level)(view)).toBe(true);
      const prefix = "#".repeat(level) + " ";
      expect(view.state.doc.toString()).toBe(`${prefix}Title\n${prefix}===\n${prefix}\n${prefix}Existing`);
    }, [language]);
  });

  it.each([
    { name: "ATX heading with closing marks", source: "  ## Title ##", expected: "Title ##", deleted: [0, 5] },
    { name: "ATX-like fenced content", source: "```\n# literal\n```", expected: "```\nliteral\n```", deleted: [4, 6] },
    { name: "tab-indented ATX-like paragraph continuation", source: "Title\n\t# literal", expected: "Title\nliteral", deleted: [6, 9] },
  ])("retains existing clearing for $name on non-Setext lines", ({ source, expected, deleted: [from, to] }) => {
    clears({
      source, selection: EditorSelection.single(0, source.length), expected,
      headings: [], deleted: [[from, to]],
    });
  });
});

describe("source destination entity spellings", () => {
  const commands = [
    { name: "link", command: insertLink, scrollIntoView: true },
    { name: "image", command: insertImage, scrollIntoView: false },
  ] as const;

  function expectDestination(node: PMNode, kind: "link" | "image", url: string, label: string) {
    expect(node.childCount).toBe(0);
    if (kind === "link") {
      expect(node.type.name).toBe("text");
      expect(node.text).toBe(label);
      expect(node.marks).toHaveLength(1);
      expect(node.marks[0].type.name).toBe("link");
      expect(node.marks[0].attrs).toEqual({ href: url, title: null });
    } else {
      expect(node.type.name).toBe("image");
      expect(node.attrs).toEqual({ src: url, alt: label, title: null });
      expect(node.marks).toHaveLength(0);
    }
  }

  describe.each(commands)("$name", ({ name, command, scrollIntoView }) => {
    it.each([
      {
        name: "named ampersand", url: "/&amp;",
        link: String.raw`[Guide](/\&amp;)`, image: String.raw`![Guide](/\&amp;)`,
      },
      {
        name: "named copyright", url: "/&copy;",
        link: String.raw`[Guide](/\&copy;)`, image: String.raw`![Guide](/\&copy;)`,
      },
      {
        name: "uppercase named reference", url: "/&AMP;",
        link: String.raw`[Guide](/\&AMP;)`, image: String.raw`![Guide](/\&AMP;)`,
      },
      {
        name: "decimal reference", url: "/&#65;",
        link: String.raw`[Guide](/\&#65;)`, image: String.raw`![Guide](/\&#65;)`,
      },
      {
        name: "decimal leading zeroes", url: "/&#0065;",
        link: String.raw`[Guide](/\&#0065;)`, image: String.raw`![Guide](/\&#0065;)`,
      },
      {
        name: "lowercase hexadecimal", url: "/&#x41;",
        link: String.raw`[Guide](/\&#x41;)`, image: String.raw`![Guide](/\&#x41;)`,
      },
      {
        name: "uppercase hexadecimal", url: "/&#X4A;",
        link: String.raw`[Guide](/\&#X4A;)`, image: String.raw`![Guide](/\&#X4A;)`,
      },
      {
        name: "mixed-case hexadecimal digits", url: "/&#x1f4Af;",
        link: String.raw`[Guide](/\&#x1f4Af;)`, image: String.raw`![Guide](/\&#x1f4Af;)`,
      },
      {
        name: "adjacent references", url: "/&amp;&copy;&#65;&#x41;&#X4A;",
        link: String.raw`[Guide](/\&amp;\&copy;\&#65;\&#x41;\&#X4A;)`,
        image: String.raw`![Guide](/\&amp;\&copy;\&#65;\&#x41;\&#X4A;)`,
      },
      {
        name: "query-embedded references", url: "/find?q=&copy;&page=2&value=&#65;",
        link: String.raw`[Guide](/find?q=\&copy;&page=2&value=\&#65;)`,
        image: String.raw`![Guide](/find?q=\&copy;&page=2&value=\&#65;)`,
      },
      {
        name: "path-embedded reference", url: "https://example.com/pre&copy;post/guide",
        link: String.raw`[Guide](https://example.com/pre\&copy;post/guide)`,
        image: String.raw`![Guide](https://example.com/pre\&copy;post/guide)`,
      },
      {
        name: "unknown alphanumeric name", url: "/&notARealEntity42;",
        link: String.raw`[Guide](/\&notARealEntity42;)`,
        image: String.raw`![Guide](/\&notARealEntity42;)`,
      },
      {
        name: "single-letter unknown name", url: "/&a;",
        link: String.raw`[Guide](/\&a;)`, image: String.raw`![Guide](/\&a;)`,
      },
      {
        name: "Unicode and percent mix", url: "../caf\u00e9/\u{10400}a\u0308%26copy;&copy;%5C",
        link: "[Guide](../caf\u00e9/\u{10400}a\u0308%26copy;\\&copy;%5C)",
        image: "![Guide](../caf\u00e9/\u{10400}a\u0308%26copy;\\&copy;%5C)",
      },
      {
        name: "one original backslash", url: String.raw`/\&copy;`,
        link: String.raw`[Guide](/\\\&copy;)`, image: String.raw`![Guide](/\\\&copy;)`,
      },
      {
        name: "two original backslashes", url: String.raw`/\\&#65;`,
        link: String.raw`[Guide](/\\\\\&#65;)`, image: String.raw`![Guide](/\\\\\&#65;)`,
      },
      {
        name: "three original backslashes", url: String.raw`/\\\&#X41;`,
        link: String.raw`[Guide](/\\\\\\\&#X41;)`, image: String.raw`![Guide](/\\\\\\\&#X41;)`,
      },
      {
        name: "balanced parentheses nearby", url: "/(&copy;)(part)",
        link: String.raw`[Guide](/\(\&copy;\)\(part\))`,
        image: String.raw`![Guide](/\(\&copy;\)\(part\))`,
      },
      {
        name: "unmatched opening parenthesis nearby", url: "/(&amp;",
        link: String.raw`[Guide](/\(\&amp;)`, image: String.raw`![Guide](/\(\&amp;)`,
      },
      {
        name: "unmatched closing parenthesis nearby", url: "/&#x41;)",
        link: String.raw`[Guide](/\&#x41;\))`, image: String.raw`![Guide](/\&#x41;\))`,
      },
      {
        name: "combined backslashes and parentheses", url: String.raw`/\&copy;(\&#65;)\)`,
        link: String.raw`[Guide](/\\\&copy;\(\\\&#65;\)\\\))`,
        image: String.raw`![Guide](/\\\&copy;\(\\\&#65;\)\\\))`,
      },
      {
        name: "bare ampersand", url: "/&",
        link: "[Guide](/&)", image: "![Guide](/&)",
      },
      {
        name: "ordinary query separators", url: "/find?a=1&b=2&c=3",
        link: "[Guide](/find?a=1&b=2&c=3)", image: "![Guide](/find?a=1&b=2&c=3)",
      },
      {
        name: "named reference missing semicolon", url: "/&copy",
        link: "[Guide](/&copy)", image: "![Guide](/&copy)",
      },
      {
        name: "decimal reference missing semicolon", url: "/&#65",
        link: "[Guide](/&#65)", image: "![Guide](/&#65)",
      },
      {
        name: "hexadecimal reference missing semicolon", url: "/&#x41",
        link: "[Guide](/&#x41)", image: "![Guide](/&#x41)",
      },
      {
        name: "empty name", url: "/&;",
        link: "[Guide](/&;)", image: "![Guide](/&;)",
      },
      {
        name: "name starting with a digit", url: "/&1copy;",
        link: "[Guide](/&1copy;)", image: "![Guide](/&1copy;)",
      },
      {
        name: "name starting with an underscore", url: "/&_copy;",
        link: "[Guide](/&_copy;)", image: "![Guide](/&_copy;)",
      },
      {
        name: "name containing punctuation", url: "/&co-py;",
        link: "[Guide](/&co-py;)", image: "![Guide](/&co-py;)",
      },
      {
        name: "non-ASCII name", url: "/&cop\u00e9;",
        link: "[Guide](/&cop\u00e9;)", image: "![Guide](/&cop\u00e9;)",
      },
      {
        name: "decimal reference without digits", url: "/&#;",
        link: "[Guide](/&#;)", image: "![Guide](/&#;)",
      },
      {
        name: "signed decimal reference", url: "/&#-65;",
        link: "[Guide](/&#-65;)", image: "![Guide](/&#-65;)",
      },
      {
        name: "decimal reference with a letter", url: "/&#6A;",
        link: "[Guide](/&#6A;)", image: "![Guide](/&#6A;)",
      },
      {
        name: "lowercase hexadecimal without digits", url: "/&#x;",
        link: "[Guide](/&#x;)", image: "![Guide](/&#x;)",
      },
      {
        name: "uppercase hexadecimal without digits", url: "/&#X;",
        link: "[Guide](/&#X;)", image: "![Guide](/&#X;)",
      },
      {
        name: "invalid hexadecimal digit", url: "/&#x4G;",
        link: "[Guide](/&#x4G;)", image: "![Guide](/&#x4G;)",
      },
      {
        name: "plain address", url: "/guide",
        link: "[Guide](/guide)", image: "![Guide](/guide)",
      },
      {
        name: "percent-only escapes", url: "/%26copy;%26%2365;%26%23x41;%28%29%5C",
        link: "[Guide](/%26copy;%26%2365;%26%23x41;%28%29%5C)",
        image: "![Guide](/%26copy;%26%2365;%26%23x41;%28%29%5C)",
      },
      {
        name: "backslash before an ordinary ampersand", url: String.raw`/\&query=1`,
        link: String.raw`[Guide](/\\&query=1)`, image: String.raw`![Guide](/\\&query=1)`,
      },
    ])("preserves $name in source and repeated rich address round trips", (fixture) => {
      withEditor("", EditorSelection.single(0), (view) => {
        expect(command(view, fixture.url, "Guide")).toBe(true);
        expect(view.state.doc.toString()).toBe(fixture[name]);
        expect(view.state.doc.length).toBe(fixture[name].length);
        expect(view.state.selection.eq(EditorSelection.single(fixture[name].length))).toBe(true);
        let { doc } = parseMarkdown(view.state.doc.toString());
        expect(doc.childCount).toBe(1);
        expect(doc.child(0).type.name).toBe("paragraph");
        expect(doc.child(0).childCount).toBe(1);
        expectDestination(doc.child(0).child(0), name, fixture.url, "Guide");
        const initial = doc.toJSON();
        for (let cycle = 0; cycle < 3; cycle++) {
          doc = parseMarkdown(serializeMarkdown(doc)).doc;
          expect(doc.toJSON()).toEqual(initial);
          expectDestination(doc.child(0).child(0), name, fixture.url, "Guide");
        }
      });
    });

    it.each(["forward", "reversed", "collapsed"])(
      "preserves UTF-16 positions, paragraphs, formatting transaction, focus and undo for a %s selection",
      (direction) => {
        const prefix = "Before \u{10400}\n\nlead a\u0308 ";
        const suffix = " tail\n\nAfter";
        const selected = direction === "collapsed" ? "" : "old \u{10400}";
        const source = prefix + selected + suffix;
        const from = prefix.length;
        const to = from + selected.length;
        const selection = direction === "reversed"
          ? EditorSelection.single(to, from)
          : EditorSelection.single(from, to);
        const url = "../\u{10400}a\u0308/\\&copy;(part)&#65;)";
        const emitted = name === "link"
          ? "[Guide](../\u{10400}a\u0308/\\\\\\&copy;\\(part\\)\\&#65;\\))"
          : "![Guide](../\u{10400}a\u0308/\\\\\\&copy;\\(part\\)\\&#65;\\))";
        const transactions: Transaction[] = [];
        withEditor(source, selection, (view) => {
          expect(command(view, url, "Guide")).toBe(true);
          expect(view.state.doc.toString()).toBe(prefix + emitted + suffix);
          expect(view.state.doc.length).toBe(source.length - selected.length + emitted.length);
          expect(view.state.selection.eq(EditorSelection.single(from + emitted.length))).toBe(true);
          expect(transactions).toHaveLength(1);
          expect(transactions[0].annotation(Transaction.userEvent)).toBe("input.format");
          expect(transactions[0].scrollIntoView).toBe(scrollIntoView);
          expect(transactions[0].docChanged).toBe(true);
          const changes: { fromA: number; toA: number; fromB: number; toB: number; text: string }[] = [];
          transactions[0].changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
            changes.push({ fromA, toA, fromB, toB, text: inserted.toString() });
          });
          expect(changes).toEqual([{ fromA: from, toA: to, fromB: from, toB: from + emitted.length, text: emitted }]);
          expect(view.hasFocus).toBe(true);
          const { doc } = parseMarkdown(view.state.doc.toString());
          expect(doc.childCount).toBe(3);
          expect([doc.child(0).type.name, doc.child(0).textContent]).toEqual(["paragraph", "Before \u{10400}"]);
          expect([doc.child(2).type.name, doc.child(2).textContent]).toEqual(["paragraph", "After"]);
          const paragraph = doc.child(1);
          expect(paragraph.type.name).toBe("paragraph");
          expect(paragraph.childCount).toBe(3);
          expect(paragraph.child(0).text).toBe("lead a\u0308 ");
          expect(paragraph.child(0).marks).toHaveLength(0);
          expectDestination(paragraph.child(1), name, url, "Guide");
          expect(paragraph.child(2).text).toBe(" tail");
          expect(paragraph.child(2).marks).toHaveLength(0);
          expect(undo(view)).toBe(true);
          expect(view.state.doc.toString()).toBe(source);
          expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
          expect(undo(view)).toBe(false);
        }, [history(), EditorView.updateListener.of((update) => transactions.push(...update.transactions))]);
      },
    );

    it("replaces only a nonzero main selection and undoes the single-cursor result", () => {
      const source = "left / old / right";
      const selection = EditorSelection.create([
        EditorSelection.range(0, 4),
        EditorSelection.range(10, 7),
        EditorSelection.cursor(source.length),
      ], 1);
      const emitted = name === "link"
        ? String.raw`[Guide](/\\\&copy;\))`
        : String.raw`![Guide](/\\\&copy;\))`;
      const transactions: Transaction[] = [];
      withEditor(source, selection, (view) => {
        expect(view.state.selection.mainIndex).toBe(1);
        expect(command(view, String.raw`/\&copy;)`, "Guide")).toBe(true);
        expect(view.state.doc.toString()).toBe("left / " + emitted + " / right");
        expect(view.state.selection.eq(EditorSelection.single(7 + emitted.length))).toBe(true);
        expect(transactions).toHaveLength(1);
        expect(transactions[0].annotation(Transaction.userEvent)).toBe("input.format");
        expect(transactions[0].scrollIntoView).toBe(scrollIntoView);
        const changes: { from: number; to: number; text: string }[] = [];
        transactions[0].changes.iterChanges((from, to, _fromB, _toB, inserted) => {
          changes.push({ from, to, text: inserted.toString() });
        });
        expect(changes).toEqual([{ from: 7, to: 10, text: emitted }]);
        expect(view.hasFocus).toBe(true);
        const { doc } = parseMarkdown(view.state.doc.toString());
        expect(doc.childCount).toBe(1);
        expect(doc.child(0).type.name).toBe("paragraph");
        expect(doc.child(0).childCount).toBe(3);
        expectDestination(doc.child(0).child(1), name, String.raw`/\&copy;)`, "Guide");
        expect(undo(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(source);
        expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
        expect(undo(view)).toBe(false);
      }, [
        EditorState.allowMultipleSelections.of(true),
        history(),
        EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
      ]);
    });

    it.each([
      {
        name: "explicit benign text", selected: "Selected", text: "Guide",
        link: String.raw`[Guide](/\&copy;\&#65;)`, image: String.raw`![Guide](/\&copy;\&#65;)`,
        linkLabel: "Guide", imageAlt: "Guide",
      },
      {
        name: "selected default text", selected: "Selected", text: undefined,
        link: String.raw`[Selected](/\&copy;\&#65;)`, image: String.raw`![](/\&copy;\&#65;)`,
        linkLabel: "Selected", imageAlt: "",
      },
      {
        name: "raw URL fallback and default empty image alt", selected: "", text: undefined,
        link: String.raw`[/&copy;&#65;](/\&copy;\&#65;)`, image: String.raw`![](/\&copy;\&#65;)`,
        linkLabel: "/\u00a9A", imageAlt: "",
      },
      {
        name: "explicit empty text overriding a selection", selected: "Selected", text: "",
        link: String.raw`[](/\&copy;\&#65;)`, image: String.raw`![](/\&copy;\&#65;)`,
        linkLabel: "", imageAlt: "",
      },
      {
        name: "explicit empty text overriding URL fallback", selected: "", text: "",
        link: String.raw`[](/\&copy;\&#65;)`, image: String.raw`![](/\&copy;\&#65;)`,
        linkLabel: "", imageAlt: "",
      },
      {
        name: "entity-looking explicit text decoded only in the label", selected: "Selected", text: "&copy;&#65;&#x41;",
        link: String.raw`[&copy;&#65;&#x41;](/\&copy;\&#65;)`,
        image: String.raw`![&copy;&#65;&#x41;](/\&copy;\&#65;)`,
        linkLabel: "\u00a9AA", imageAlt: "\u00a9AA",
      },
      {
        name: "entity-looking selected source", selected: "&copy;&#65;&#x41;", text: undefined,
        link: String.raw`[&copy;&#65;&#x41;](/\&copy;\&#65;)`, image: String.raw`![](/\&copy;\&#65;)`,
        linkLabel: "\u00a9AA", imageAlt: "",
      },
      {
        name: "backslash-escaped entity-looking explicit text", selected: "Selected", text: String.raw`\&copy;`,
        link: String.raw`[\&copy;](/\&copy;\&#65;)`, image: String.raw`![\&copy;](/\&copy;\&#65;)`,
        linkLabel: "&copy;", imageAlt: "&copy;",
      },
    ])("keeps the raw source policy for $name", (fixture) => {
      const url = "/&copy;&#65;";
      withEditor(fixture.selected, EditorSelection.single(0, fixture.selected.length), (view) => {
        expect(command(view, url, fixture.text)).toBe(true);
        expect(view.state.doc.toString()).toBe(fixture[name]);
        expect(view.state.selection.eq(EditorSelection.single(fixture[name].length))).toBe(true);
        const { doc, tree } = parseMarkdown(view.state.doc.toString());
        expect(doc.childCount).toBe(1);
        expect(doc.child(0).type.name).toBe("paragraph");
        if (name === "link" && fixture.linkLabel === "") {
          // An empty link has no text node to carry a ProseMirror link mark.
          expect(doc.child(0).childCount).toBe(0);
          expect(tree).toMatchObject({
            children: [{ type: "paragraph", children: [{ type: "link", url, children: [] }] }],
          });
        } else {
          expect(doc.child(0).childCount).toBe(1);
          expectDestination(doc.child(0).child(0), name, url, name === "link" ? fixture.linkLabel : fixture.imageAlt);
        }
      });
    });

    it.each([
      {
        name: "explicit Markdown", selected: "Selected", text: "**Guide**",
        link: String.raw`[**Guide**](/\&copy;)`, image: String.raw`![**Guide**](/\&copy;)`,
      },
      {
        name: "selected Markdown", selected: "**Guide**", text: undefined,
        link: String.raw`[**Guide**](/\&copy;)`, image: String.raw`![](/\&copy;)`,
      },
    ])("does not add escaping to $name labels or alt text", (fixture) => {
      withEditor(fixture.selected, EditorSelection.single(0, fixture.selected.length), (view) => {
        expect(command(view, "/&copy;", fixture.text)).toBe(true);
        expect(view.state.doc.toString()).toBe(fixture[name]);
        const { doc } = parseMarkdown(view.state.doc.toString());
        expect(doc.childCount).toBe(1);
        expect(doc.child(0).type.name).toBe("paragraph");
        expect(doc.child(0).childCount).toBe(1);
        const node = doc.child(0).child(0);
        if (name === "link") {
          expect(node.type.name).toBe("text");
          expect(node.text).toBe("Guide");
          expect(node.marks).toHaveLength(2);
          expect(node.marks.map((mark) => mark.type.name).sort()).toEqual(["link", "strong"]);
          expect(node.marks.find((mark) => mark.type.name === "link")?.attrs.href).toBe("/&copy;");
        } else {
          expectDestination(node, name, "/&copy;", fixture.text === undefined ? "" : "Guide");
        }
      });
    });
  });
});

describe("source inline code delimiter fidelity", () => {
  function expectCodeParagraph(source: string, text: string) {
    const { doc } = parseMarkdown(source);
    expect(doc.childCount).toBe(1);
    const paragraph = doc.child(0);
    expect(paragraph.type.name).toBe("paragraph");
    expect(paragraph.childCount).toBe(3);
    expect(paragraph.child(0).toJSON()).toEqual({ type: "text", text: "before (" });
    const code = paragraph.child(1);
    expect(code.type.name).toBe("text");
    expect(code.text).toBe(text);
    expect(code.attrs).toEqual({});
    expect(code.marks).toHaveLength(1);
    expect(code.marks[0].type.name).toBe("code");
    expect(code.marks[0].attrs).toEqual({});
    expect(paragraph.child(2).toJSON()).toEqual({ type: "text", text: ") after" });
  }

  it.each([
    { name: "plain text", text: "plain", offset: 1, expected: "before (`plain`) after" },
    { name: "single interior tick", text: "left`right", offset: 3, expected: "before (`` left`right ``) after" },
    { name: "double interior ticks", text: "left``right", offset: 4, expected: "before (``` left``right ```) after" },
    { name: "long interior run", text: "left`````right", offset: 7, expected: "before (`````` left`````right ``````) after" },
    { name: "mixed interior runs", text: "left`mid```end``tail", offset: 5, expected: "before (```` left`mid```end``tail ````) after" },
    { name: "leading unmatched tick", text: "`value", offset: 3, expected: "before (`` `value ``) after" },
    { name: "trailing unmatched tick", text: "value`", offset: 3, expected: "before (`` value` ``) after" },
    { name: "leading unmatched double run", text: "``value", offset: 4, expected: "before (``` ``value ```) after" },
    { name: "trailing unmatched long run", text: "value````", offset: 6, expected: "before (````` value```` `````) after" },
    { name: "unequal edge runs", text: "`value``", offset: 4, expected: "before (``` `value`` ```) after" },
    { name: "only a literal tick", text: "`", offset: 3, expected: "before (`` ` ``) after" },
    { name: "only a literal run", text: "````", offset: 6, expected: "before (````` ```` `````) after" },
    { name: "entity spellings", text: "&copy;&#65;&#x41;&amp;", offset: 1, expected: "before (`&copy;&#65;&#x41;&amp;`) after" },
    { name: "original backslashes", text: "C:\\path\\leaf \\* \\&copy;", offset: 1, expected: "before (`C:\\path\\leaf \\* \\&copy;`) after" },
    { name: "backslash before a literal tick", text: "\\`value", offset: 3, expected: "before (`` \\`value ``) after" },
    { name: "strong-looking text", text: "**bold**", offset: 1, expected: "before (`**bold**`) after" },
    { name: "Markdown punctuation", text: "*a* ~~b~~ [c](d) & + <x>", offset: 1, expected: "before (`*a* ~~b~~ [c](d) & + <x>`) after" },
    { name: "supplementary and combining Unicode", text: "\u{10400}nai\u0308ve \u{1f642}", offset: 1, expected: "before (`\u{10400}nai\u0308ve \u{1f642}`) after" },
    { name: "one leading ASCII space", text: " value", offset: 1, expected: "before (` value`) after" },
    { name: "one trailing ASCII space", text: "value ", offset: 1, expected: "before (`value `) after" },
    { name: "both edge ASCII spaces", text: " value ", offset: 2, expected: "before (`  value  `) after" },
    { name: "multiple edge ASCII spaces", text: "  value   ", offset: 2, expected: "before (`   value    `) after" },
    { name: "one ASCII space only", text: " ", offset: 1, expected: "before (` `) after" },
    { name: "all ASCII spaces", text: "   ", offset: 1, expected: "before (`   `) after" },
    { name: "edge tabs", text: "\tvalue\t", offset: 1, expected: "before (`\tvalue\t`) after" },
    { name: "space tab space", text: " \t ", offset: 2, expected: "before (`  \t  `) after" },
    { name: "space NBSP space", text: " \u00a0 ", offset: 2, expected: "before (`  \u00a0  `) after" },
    { name: "edge NBSPs", text: "\u00a0value\u00a0", offset: 1, expected: "before (`\u00a0value\u00a0`) after" },
    { name: "spaces with an unmatched tick", text: " `value ", offset: 3, expected: "before (``  `value  ``) after" },
  ])("wraps and immediately unwraps $name literally in both directions", ({ text, offset, expected }) => {
    const source = "before (" + text + ") after";
    for (const reversed of [false, true]) {
      const selection = reversed ? EditorSelection.single(8 + text.length, 8) : EditorSelection.single(8, 8 + text.length);
      const transactions: Transaction[] = [];
      withEditor(source, selection, (view) => {
        expect(toggleInlineMark("`")(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(expected);
        const range = view.state.selection.main;
        expect([range.anchor, range.head]).toEqual([selection.main.anchor + offset, selection.main.head + offset]);
        expect(view.state.sliceDoc(range.from, range.to)).toBe(text);
        expectCodeParagraph(view.state.doc.toString(), text);
        expect(transactions).toHaveLength(1);
        expect(transactions[0].annotation(Transaction.userEvent)).toBe("input.format");
        expect(transactions[0].scrollIntoView).toBe(true);
        expect(transactions[0].docChanged).toBe(true);
        expect(view.hasFocus).toBe(true);
        expect(toggleInlineMark("`")(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(source);
        expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
        expect(transactions).toHaveLength(2);
        expect(transactions[1].annotation(Transaction.userEvent)).toBe("input.format");
        expect(transactions[1].scrollIntoView).toBe(true);
        expect(view.hasFocus).toBe(true);
      }, [markdown(), EditorView.updateListener.of((update) => transactions.push(...update.transactions))]);
    }
  });

  it.each([
    { name: "whole double-tick span", source: "before (`` left`right ``) after", from: 8, to: 24, text: "left`right", expected: "before (left`right) after" },
    { name: "complete raw double-tick content", source: "before (`` left`right ``) after", from: 10, to: 22, text: "left`right", expected: "before (left`right) after" },
    { name: "complete double-tick payload", source: "before (`` left`right ``) after", from: 11, to: 21, text: "left`right", expected: "before (left`right) after" },
    { name: "unpadded double-tick span", source: "before (``left`right``) after", from: 8, to: 22, text: "left`right", expected: "before (left`right) after" },
    { name: "unpadded double-tick content", source: "before (``left`right``) after", from: 10, to: 20, text: "left`right", expected: "before (left`right) after" },
    { name: "whole triple-tick span with edge ticks", source: "before (``` `value`` ```) after", from: 8, to: 24, text: "`value``", expected: "before (`value``) after" },
    { name: "triple-tick payload with edge ticks", source: "before (``` `value`` ```) after", from: 12, to: 20, text: "`value``", expected: "before (`value``) after" },
    { name: "meaningful spaces in raw content", source: "before (`  value  `) after", from: 9, to: 18, text: " value ", expected: "before ( value ) after" },
    { name: "all-space content without trimming", source: "before (`   `) after", from: 9, to: 12, text: "   ", expected: "before (   ) after" },
    { name: "a synthetic pair around a tab", source: "before (` \t `) after", from: 8, to: 13, text: "\t", expected: "before (\t) after" },
  ])("removes $name and only its synthetic padding", ({ source, from, to, text, expected }) => {
    for (const reversed of [false, true]) {
      const selection = reversed ? EditorSelection.single(to, from) : EditorSelection.single(from, to);
      const transactions: Transaction[] = [];
      withEditor(source, selection, (view) => {
        expectCodeParagraph(source, text);
        expect(toggleInlineMark("`")(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(expected);
        expect(view.state.selection.eq(reversed ? EditorSelection.single(8 + text.length, 8) : EditorSelection.single(8, 8 + text.length))).toBe(true);
        expect(transactions).toHaveLength(1);
        expect(transactions[0].annotation(Transaction.userEvent)).toBe("input.format");
        expect(transactions[0].scrollIntoView).toBe(true);
        expect(view.hasFocus).toBe(true);
        expect(undo(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(source);
        expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
      }, [markdown(), history(), EditorView.updateListener.of((update) => transactions.push(...update.transactions))]);
    }
  });

  it.each([
    { name: "plain word", source: "before (plain) after", caret: 10, expected: "before (`plain`) after", from: 9, to: 14 },
    { name: "one-tick formatted word", source: "before (`plain`) after", caret: 11, expected: "before (plain) after", from: 8, to: 13 },
  ])("retains the caret selection policy for a $name", ({ source, caret, expected, from, to }) => {
    withEditor(source, EditorSelection.single(caret), (view) => {
      expect(toggleInlineMark("`")(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(expected);
      expect(view.state.selection.eq(EditorSelection.single(from, to))).toBe(true);
      expect(view.state.sliceDoc(from, to)).toBe("plain");
    }, [markdown()]);
  });

  it.each([
    { name: "empty source", source: "", caret: 0, expected: "``", selected: 1 },
    { name: "punctuation", source: "before (!) after", caret: 8, expected: "before (``!) after", selected: 9 },
    { name: "an existing empty pair", source: "before (``) after", caret: 9, expected: "before () after", selected: 8 },
  ])("keeps the exact empty-caret marker-pair behavior in $name", ({ source, caret, expected, selected }) => {
    withEditor(source, EditorSelection.single(caret), (view) => {
      expect(toggleInlineMark("`")(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(expected);
      expect(view.state.selection.eq(EditorSelection.single(selected))).toBe(true);
    }, [markdown()]);
  });

  it.each(["toggle off", "undo"] as const)("maps different fences and reversed ranges through one transaction and %s", (off) => {
    const source = "before (plain / a`b / c``d /  e ) after";
    const selection = EditorSelection.create([
      EditorSelection.range(8, 13),
      EditorSelection.range(19, 16),
      EditorSelection.range(22, 26),
      EditorSelection.range(32, 29),
    ], 2);
    const transactions: Transaction[] = [];
    withEditor(source, selection, (view) => {
      expect(toggleInlineMark("`")(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("before (`plain` / `` a`b `` / ``` c``d ``` / `  e  `) after");
      expect(view.state.selection.ranges.map(({ anchor, head }) => [anchor, head])).toEqual([
        [9, 14], [24, 21], [34, 38], [50, 47],
      ]);
      expect(view.state.selection.mainIndex).toBe(2);
      expect(view.state.selection.ranges.map(({ from, to }) => view.state.sliceDoc(from, to))).toEqual(["plain", "a`b", "c``d", " e "]);
      const { doc } = parseMarkdown(view.state.doc.toString());
      expect(doc.childCount).toBe(1);
      expect(doc.child(0).type.name).toBe("paragraph");
      expect(doc.child(0).content.toJSON()).toEqual([
        { type: "text", text: "before (" },
        { type: "text", marks: [{ type: "code" }], text: "plain" },
        { type: "text", text: " / " },
        { type: "text", marks: [{ type: "code" }], text: "a`b" },
        { type: "text", text: " / " },
        { type: "text", marks: [{ type: "code" }], text: "c``d" },
        { type: "text", text: " / " },
        { type: "text", marks: [{ type: "code" }], text: " e " },
        { type: "text", text: ") after" },
      ]);
      expect(transactions).toHaveLength(1);
      expect(transactions[0].annotation(Transaction.userEvent)).toBe("input.format");
      expect(transactions[0].scrollIntoView).toBe(true);
      expect(transactions[0].docChanged).toBe(true);
      expect(view.hasFocus).toBe(true);
      expect(off === "undo" ? undo(view) : toggleInlineMark("`")(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(source);
      expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
    }, [markdown(), history(), EditorState.allowMultipleSelections.of(true), EditorView.updateListener.of((update) => transactions.push(...update.transactions))]);
  });

  it.for(["no language", "configured Markdown"] as const)("reuses guarded syntax within the command budget with %s", (mode, { task }) => {
    const soup = "[".repeat(40_000) + "a" + "]".repeat(40_000);
    const prefix = soup + "\n\n";
    const paragraph = "before (a`b / c``d) after";
    const selection = EditorSelection.create([
      EditorSelection.range(prefix.length + 8, prefix.length + 11),
      EditorSelection.range(prefix.length + 18, prefix.length + 14),
    ], 1);
    const transactions: Transaction[] = [];
    const measurements: { milliseconds: number; syntaxTrees: number; rangeLookups: number; fallbackParses: number }[] = [];
    withEditor(prefix + paragraph, selection, (view) => {
      const parse = vi.spyOn(Parser.prototype, "parse");
      const resolve = vi.spyOn(Tree.prototype, "resolveInner");
      let fallbackParser: Parser | undefined;
      try {
        for (const invocation of [1, 2]) {
          const original = view.state;
          const start = performance.now();
          const changed = toggleInlineMark("`")(view);
          const milliseconds = performance.now() - start;
          const rangeTrees = resolve.mock.contexts.filter((tree, index): tree is Tree =>
            tree instanceof Tree && tree.length === original.doc.length && resolve.mock.calls[index][1] === 1 &&
            original.selection.ranges.some((range) => range.from === resolve.mock.calls[index][0]));
          measurements.push({ milliseconds, syntaxTrees: new Set(rangeTrees).size, rangeLookups: rangeTrees.length, fallbackParses: parse.mock.calls.length });
          expect(changed).toBe(true);
          expect(milliseconds).toBeLessThan(500);
          expect(rangeTrees).toHaveLength(2);
          expect(rangeTrees[0]).toBe(rangeTrees[1]);
          expect(parse).toHaveBeenCalledTimes(mode === "no language" ? 1 : 0);
          expect(rangeTrees[0].length).toBe(original.doc.length);
          expect(rangeTrees[0].topNode.firstChild?.name).toBe("UnrenderableParagraph");
          if (mode === "no language") {
            const parser = parse.mock.contexts[0];
            if (!(parser instanceof Parser)) throw new Error("Expected the real fallback parser");
            expect(parse.mock.results[0].type).toBe("return");
            expect(parse.mock.results[0].value).toBe(rangeTrees[0]);
            expect(parser).not.toBe(markdownLanguage.parser);
            if (fallbackParser) expect(parser).toBe(fallbackParser);
            fallbackParser = parser;
            expect(parse).toHaveBeenCalledWith(original.doc.toString());
          } else {
            // Completing the configured parse may extend the state's partial tree.
            expect(rangeTrees[0].type).toBe(codeMirrorLanguage.syntaxTree(original).type);
          }
          expect(transactions).toHaveLength(invocation);
          expect(transactions[invocation - 1].annotation(Transaction.userEvent)).toBe("input.format");
          expect(transactions[invocation - 1].scrollIntoView).toBe(true);
          expect(view.hasFocus).toBe(true);
          expect(view.state.doc.sliceString(0, prefix.length)).toBe(prefix);
          if (invocation === 1) {
            expect(view.state.doc.sliceString(prefix.length)).toBe("before (`` a`b `` / ``` c``d ```) after");
            expect(view.state.selection.ranges.map(({ anchor, head }) => [anchor - prefix.length, head - prefix.length]))
              .toEqual([[11, 14], [28, 24]]);
            expect(view.state.selection.mainIndex).toBe(1);
            const { doc } = parseMarkdown(view.state.doc.sliceString(prefix.length));
            expect(doc.childCount).toBe(1);
            expect(doc.child(0).type.name).toBe("paragraph");
            expect(doc.child(0).content.toJSON()).toEqual([
              { type: "text", text: "before (" },
              { type: "text", marks: [{ type: "code" }], text: "a`b" },
              { type: "text", text: " / " },
              { type: "text", marks: [{ type: "code" }], text: "c``d" },
              { type: "text", text: ") after" },
            ]);
            expect(view.state.selection.ranges.map(({ from, to }) => view.state.sliceDoc(from, to))).toEqual(["a`b", "c``d"]);
          } else {
            expect(view.state.doc.sliceString(prefix.length)).toBe(paragraph);
            expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
          }
          resolve.mockClear();
          parse.mockClear();
        }
      } finally {
        resolve.mockRestore();
        parse.mockRestore();
      }
    }, [
      ...(mode === "configured Markdown" ? [markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false, extensions: [pathologicalParagraphs] })] : []),
      EditorState.allowMultipleSelections.of(true),
      EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
    ]);
    Object.assign(task.meta, { inlineCodeCommands: measurements });
  });

  it.each(["no language", "configured Markdown"] as const)("retains opaque-paragraph legacy behavior with %s", (mode) => {
    const prefix = "[".repeat(40_000) + "a" + "]".repeat(40_000) + " ";
    const source = prefix + "a`b";
    const selection = EditorSelection.single(source.length, prefix.length);
    withEditor(source, selection, (view) => {
      expect(toggleInlineMark("`")(view)).toBe(true);
      expect(view.state.doc.sliceString(0, prefix.length)).toBe(prefix);
      expect(view.state.doc.sliceString(prefix.length)).toBe("`a`b`");
      expect(view.state.selection.eq(EditorSelection.single(source.length + 1, prefix.length + 1))).toBe(true);
      expect(toggleInlineMark("`")(view)).toBe(true);
      expect(view.state.doc.sliceString(prefix.length)).toBe("a`b");
      expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
    }, mode === "configured Markdown" ? [markdown({ base: markdownLanguage, extensions: [pathologicalParagraphs] })] : []);
  });

  it.each([
    { name: "GFM table", source: "| a`b | tail |\n| --- | --- |", from: 2, to: 5, expected: "| `a`b` | tail |\n| --- | --- |" },
    { name: "fenced code", source: "```\na`b\n```", from: 4, to: 7, expected: "```\n`a`b`\n```" },
    { name: "container fenced code", source: "> ```\n> a`b\n> ```", from: 8, to: 11, expected: "> ```\n> `a`b`\n> ```" },
    { name: "indented code", source: "    a`b", from: 4, to: 7, expected: "    `a`b`" },
  ])("preserves enclosing $name legacy context with or without a language", ({ source, from, to, expected }) => {
    for (const configured of [false, true]) {
      const selection = EditorSelection.single(to, from);
      withEditor(source, selection, (view) => {
        expect(toggleInlineMark("`")(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(expected);
        expect(view.state.selection.eq(EditorSelection.single(to + 1, from + 1))).toBe(true);
        expect(toggleInlineMark("`")(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(source);
        expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
      }, configured ? [markdown({ base: markdownLanguage, extensions: [pathologicalParagraphs] })] : []);
    }
  });
});

describe("bare source ATX headings", () => {
  const language = markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false });
  const plain: SourceFormatState = {
    strong: false, em: false, code: false, strike: false, link: false, heading: 0,
    bullet: false, ordered: false, task: false, quote: false, codeBlock: false,
  };

  function expectEmptyHeading(source: string, level: number) {
    const { doc } = parseMarkdown(source);
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).type.name).toBe("heading");
    expect(doc.child(0).attrs.level).toBe(level);
    expect(doc.child(0).textContent).toBe("");
    expect(doc.child(0).childCount).toBe(0);
    expect(doc.child(0).content.size).toBe(0);
  }

  function edits({
    source, selection, level, expected, changes, mapped, before, after,
  }: {
    source: string;
    selection: EditorSelection;
    level: number;
    expected: string;
    changes: [number, number, string][];
    mapped?: EditorSelection;
    before?: (view: EditorView) => void;
    after?: (view: EditorView) => void;
  }) {
    const transactions: Transaction[] = [];
    withEditor(source, selection, (view) => {
      expect(ensureSyntaxTree(view.state, view.state.doc.length, 1000)).not.toBeNull();
      before?.(view);
      const focus = vi.spyOn(view, "focus");
      try {
        expect(setHeading(level)(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(expected);
        expect(transactions).toHaveLength(1);
        const transaction = transactions[0];
        expect(transaction.annotation(Transaction.userEvent)).toBe("input.format");
        expect(transaction.scrollIntoView).toBe(true);
        expect(transaction.docChanged).toBe(true);
        const actual: [number, number, string][] = [];
        transaction.changes.iterChanges((from, to, _mappedFrom, _mappedTo, inserted) => {
          actual.push([from, to, inserted.toString()]);
        });
        expect(actual).toEqual(changes);
        expect(view.state.selection.toJSON()).toEqual(selection.map(transaction.changes).toJSON());
        if (mapped) expect(view.state.selection.toJSON()).toEqual(mapped.toJSON());
        expect(view.state.selection.mainIndex).toBe(selection.mainIndex);
        expect(focus).toHaveBeenCalledTimes(1);
        expect(view.hasFocus).toBe(true);
        expect(ensureSyntaxTree(view.state, view.state.doc.length, 1000)).not.toBeNull();
        after?.(view);
        expect(undo(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(source);
        expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
      } finally {
        focus.mockRestore();
      }
    }, [
      language, history(), EditorState.allowMultipleSelections.of(true),
      EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
    ]);
  }

  it.each([
    { level: 1, source: "#", indented: " #", normalized: "# ", target: 2, changed: "## ", cleared: "" },
    { level: 2, source: "##", indented: "  ##", normalized: "## ", target: 3, changed: "### ", cleared: "" },
    { level: 3, source: "###", indented: "   ###", normalized: "### ", target: 4, changed: "#### ", cleared: "" },
    { level: 4, source: "####", indented: " ####", normalized: "#### ", target: 5, changed: "##### ", cleared: "" },
    { level: 5, source: "#####", indented: "  #####", normalized: "##### ", target: 6, changed: "###### ", cleared: "" },
    { level: 6, source: "######", indented: "   ######", normalized: "###### ", target: 1, changed: "# ", cleared: "" },
    { level: 1, source: "#\n", indented: " #\n", normalized: "# \n", target: 2, changed: "## \n", cleared: "\n" },
    { level: 2, source: "##\n", indented: "  ##\n", normalized: "## \n", target: 3, changed: "### \n", cleared: "\n" },
    { level: 3, source: "###\n", indented: "   ###\n", normalized: "### \n", target: 4, changed: "#### \n", cleared: "\n" },
    { level: 4, source: "####\n", indented: " ####\n", normalized: "#### \n", target: 5, changed: "##### \n", cleared: "\n" },
    { level: 5, source: "#####\n", indented: "  #####\n", normalized: "##### \n", target: 6, changed: "###### \n", cleared: "\n" },
    { level: 6, source: "######\n", indented: "   ######\n", normalized: "###### \n", target: 1, changed: "# \n", cleared: "\n" },
  ])("clears, replaces and normalizes level $level in $source with or without indentation", (fixture) => {
    for (const source of [fixture.source, fixture.indented]) {
      const end = source.endsWith("\n") ? source.length - 1 : source.length;
      for (const { level, expected } of [
        { level: 0, expected: fixture.cleared },
        { level: fixture.target, expected: fixture.changed },
        { level: fixture.level, expected: fixture.normalized },
      ]) {
        edits({
          source, selection: EditorSelection.single(end), level, expected,
          changes: [[0, end, expected.endsWith("\n") ? expected.slice(0, -1) : expected]],
          before: (view) => {
            expectEmptyHeading(source, fixture.level);
            expect(formatStateAt(view.state)).toEqual({ ...plain, heading: fixture.level });
          },
          after: (view) => {
            if (level === 0) {
              const { doc } = parseMarkdown(view.state.doc.toString());
              expect(doc.toJSON()).toEqual(parseMarkdown("").doc.toJSON());
              expect(doc.childCount).toBe(1);
              expect(doc.child(0).type.name).toBe("paragraph");
              expect(doc.child(0).content.size).toBe(0);
              expect(formatStateAt(view.state)).toEqual(plain);
            } else {
              expectEmptyHeading(view.state.doc.toString(), level);
              expect(formatStateAt(view.state)).toEqual({ ...plain, heading: level });
            }
          },
        });
      }
    }
  });

  it.each([
    { name: "forward replacement", selection: EditorSelection.single(8, 13), level: 3, expected: "Before\n\n### \n### \n\nAfter", mapped: EditorSelection.single(8, 18), changes: [[8, 9, "### "], [10, 12, "### "]] },
    { name: "reversed replacement", selection: EditorSelection.single(13, 8), level: 3, expected: "Before\n\n### \n### \n\nAfter", mapped: EditorSelection.single(18, 8), changes: [[8, 9, "### "], [10, 12, "### "]] },
    { name: "forward clear with selected unaffected lines", selection: EditorSelection.single(0, 14), level: 0, expected: "Before\n\n\n\n\nAfter", mapped: EditorSelection.single(0, 11), changes: [[8, 9, ""], [10, 12, ""]] },
    { name: "reversed clear with selected unaffected lines", selection: EditorSelection.single(14, 0), level: 0, expected: "Before\n\n\n\n\nAfter", mapped: EditorSelection.single(11, 0), changes: [[8, 9, ""], [10, 12, ""]] },
    { name: "caret at line start", selection: EditorSelection.single(8), level: 3, expected: "Before\n\n### \n##\n\nAfter", mapped: EditorSelection.single(8), changes: [[8, 9, "### "]] },
    { name: "caret at marker end", selection: EditorSelection.single(9), level: 0, expected: "Before\n\n\n##\n\nAfter", mapped: EditorSelection.single(8), changes: [[8, 9, ""]] },
    { name: "exclusive next-heading endpoint", selection: EditorSelection.single(8, 10), level: 3, expected: "Before\n\n### \n##\n\nAfter", mapped: EditorSelection.single(8, 13), changes: [[8, 9, "### "]] },
    { name: "reversed exclusive next-heading endpoint", selection: EditorSelection.single(10, 8), level: 0, expected: "Before\n\n\n##\n\nAfter", mapped: EditorSelection.single(9, 8), changes: [[8, 9, ""]] },
  ] satisfies { name: string; selection: EditorSelection; level: number; expected: string; mapped: EditorSelection; changes: [number, number, string][] }[])(
    "preserves neighboring paragraphs, mapped selection and undo for $name",
    (fixture) => edits({
      source: "Before\n\n#\n##\n\nAfter", ...fixture,
      after: (view) => {
        const { doc } = parseMarkdown(view.state.doc.toString());
        expect([doc.firstChild?.type.name, doc.firstChild?.textContent]).toEqual(["paragraph", "Before"]);
        expect([doc.lastChild?.type.name, doc.lastChild?.textContent]).toEqual(["paragraph", "After"]);
      },
    }),
  );

  it.each([
    { level: 0, expected: "Before\n\n\nkeep\n\n\nAfter", mapped: [8, 14], changes: [[8, 9, ""], [15, 19, ""]] },
    { level: 3, expected: "Before\n\n### \nkeep\n### \n\nAfter", mapped: [12, 22], changes: [[8, 9, "### "], [15, 19, "### "]] },
  ] satisfies { level: number; expected: string; mapped: number[]; changes: [number, number, string][] }[])(
    "formats disjoint bare headings at level $level with nonzero mainIndex",
    ({ mapped, ...fixture }) => edits({
      source: "Before\n\n#\nkeep\n  ##\n\nAfter",
      selection: EditorSelection.create([EditorSelection.cursor(9), EditorSelection.cursor(19)], 1),
      mapped: EditorSelection.create(mapped.map((pos) => EditorSelection.cursor(pos)), 1),
      ...fixture,
      after: (view) => {
        expect(formatStateAt(view.state)).toEqual({ ...plain, heading: fixture.level });
      },
    }),
  );

  it.each([
    { name: "empty line", source: "", expected: "## " },
    { name: "seven hashes", source: "#######", expected: "## #######" },
    { name: "long hash run", source: " ########", expected: "##  ########" },
    { name: "overlong run with a delimiter", source: "####### text", expected: "## ####### text" },
    { name: "attached word", source: "###word", expected: "## ###word" },
    { name: "escaped hash", source: "\\#", expected: "## \\#" },
  ])("does not strip a false heading prefix from $name", ({ source, expected }) => {
    const transactions: Transaction[] = [];
    withEditor(source, EditorSelection.single(source.length), (view) => {
      expect(ensureSyntaxTree(view.state, view.state.doc.length, 1000)).not.toBeNull();
      const focus = vi.spyOn(view, "focus");
      try {
        const state = view.state;
        expect(formatStateAt(state)).toEqual(plain);
        expect(setHeading(0)(view)).toBe(false);
        expect(view.state).toBe(state);
        expect(view.state.doc.toString()).toBe(source);
        expect(transactions).toHaveLength(0);
        expect(focus).not.toHaveBeenCalled();
      } finally {
        focus.mockRestore();
      }
    }, [language, EditorView.updateListener.of((update) => transactions.push(...update.transactions))]);
    edits({
      source, selection: EditorSelection.single(source.length), level: 2, expected,
      changes: [[0, 0, "## "]],
    });
  });

  it.each([
    { source: "  ## text", expected: "#### text", end: 5 },
    { source: " ###\t\ttext", expected: "#### text", end: 6 },
  ])("retains whitespace consumption for nonempty $source", ({ source, expected, end }) => {
    edits({
      source, selection: EditorSelection.single(source.length), level: 4, expected,
      changes: [[0, end, "#### "]],
      after: (view) => expect(formatStateAt(view.state)).toEqual({ ...plain, heading: 4 }),
    });
    edits({
      source, selection: EditorSelection.single(source.length), level: 0, expected: "text",
      changes: [[0, end, ""]],
      after: (view) => expect(formatStateAt(view.state)).toEqual(plain),
    });
  });
});

describe("bare source list markers", () => {
      const language = markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false });

      function expectList(source: string, kind: "bullet" | "ordered", attrs: Record<string, unknown>, text = "", checked: boolean | null = null) {
        const { doc } = parseMarkdown(source);
        expect(doc.childCount).toBe(1);
        const list = doc.child(0);
        expect(list.type.name).toBe(kind === "bullet" ? "bullet_list" : "ordered_list");
        expect(list.attrs).toEqual(attrs);
        expect(list.childCount).toBe(1);
        const item = list.child(0);
        expect(item.type.name).toBe("list_item");
        expect(item.attrs).toEqual({ checked });
        expect(item.childCount).toBe(1);
        expect(item.child(0).type.name).toBe("paragraph");
        expect(item.textContent).toBe(text);
        if (!text) expect(item.child(0).content.size).toBe(0);
      }

      function edits({
        source, selection, kind, expected, mapped, before, after,
      }: {
        source: string;
        selection: EditorSelection;
        kind: LinePrefixKind;
        expected: string;
        mapped?: EditorSelection;
        before?: (view: EditorView) => void;
        after?: (view: EditorView) => void;
      }) {
        const transactions: Transaction[] = [];
        withEditor(source, selection, (view) => {
          expect(ensureSyntaxTree(view.state, view.state.doc.length, 1000)).not.toBeNull();
          before?.(view);
          const focus = vi.spyOn(view, "focus");
          try {
            expect(toggleLinePrefix(kind)(view)).toBe(true);
            expect(view.state.doc.toString()).toBe(expected);
            expect(transactions).toHaveLength(1);
            const transaction = transactions[0];
            expect(transaction.docChanged).toBe(true);
            expect(transaction.annotation(Transaction.userEvent)).toBe("input.format");
            expect(transaction.scrollIntoView).toBe(true);
            expect(view.state.selection.toJSON()).toEqual(selection.map(transaction.changes).toJSON());
            if (mapped) expect(view.state.selection.toJSON()).toEqual(mapped.toJSON());
            expect(view.state.selection.mainIndex).toBe(selection.mainIndex);
            expect(focus).toHaveBeenCalledTimes(1);
            expect(view.hasFocus).toBe(true);
            expect(ensureSyntaxTree(view.state, view.state.doc.length, 1000)).not.toBeNull();
            expect(parseMarkdown(view.state.doc.toString()).doc.toJSON()).toEqual(parseMarkdown(expected).doc.toJSON());
            after?.(view);
            expect(undo(view)).toBe(true);
            expect(view.state.doc.toString()).toBe(source);
            expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
            expect(undo(view)).toBe(false);
          } finally {
            focus.mockRestore();
          }
        }, [
          language, history(), EditorState.allowMultipleSelections.of(true),
          EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
        ]);
      }

      it.each([
        { marker: "-", kind: "bullet" as const, attrs: { bullet: "-", tight: true } },
        { marker: "*", kind: "bullet" as const, attrs: { bullet: "*", tight: true } },
        { marker: "+", kind: "bullet" as const, attrs: { bullet: "+", tight: true } },
        { marker: "1.", kind: "ordered" as const, attrs: { start: 1, delimiter: ".", tight: true } },
        { marker: "2)", kind: "ordered" as const, attrs: { start: 2, delimiter: ")", tight: true } },
        { marker: "0.", kind: "ordered" as const, attrs: { start: 0, delimiter: ".", tight: true } },
        { marker: "7)", kind: "ordered" as const, attrs: { start: 7, delimiter: ")", tight: true } },
        { marker: "1234567.", kind: "ordered" as const, attrs: { start: 1234567, delimiter: ".", tight: true } },
        { marker: "123456789)", kind: "ordered" as const, attrs: { start: 123456789, delimiter: ")", tight: true } },
      ])("clears an empty $kind marker $marker without clearing indentation", ({ marker, kind, attrs }) => {
        for (const indent of ["", " ", "  ", "   "]) {
          for (const newline of ["", "\n"]) {
            const source = indent + marker + newline;
            const end = indent.length + marker.length;
            edits({
              source, selection: EditorSelection.single(end), kind, expected: indent + newline,
              mapped: EditorSelection.single(indent.length),
              before: (view) => {
                expectList(source, kind, attrs);
                const names: string[] = [];
                let node = ensureSyntaxTree(view.state, source.length, 1000)!.resolveInner(end, -1);
                for (;;) {
                  names.push(node.name);
                  if (!node.parent) break;
                  node = node.parent;
                }
                expect(names).toContain("ListItem");
                expect(names).toContain(kind === "bullet" ? "BulletList" : "OrderedList");
              },
              after: (view) => {
                expect(parseMarkdown(view.state.doc.toString()).doc.toJSON()).toEqual(parseMarkdown("").doc.toJSON());
              },
            });
          }
        }
      });

      it.each([
        { source: " *", kind: "ordered" as const, expected: " 1. ", beforeKind: "bullet_list", afterKind: "ordered_list" },
        { source: " 2)", kind: "bullet" as const, expected: " - ", beforeKind: "ordered_list", afterKind: "bullet_list" },
        { source: "+", kind: "task" as const, expected: "- [ ] ", beforeKind: "bullet_list", afterKind: "bullet_list" },
        { source: "7.", kind: "task" as const, expected: "- [ ] ", beforeKind: "ordered_list", afterKind: "bullet_list" },
        { source: "  -", kind: "quote" as const, expected: "  > ", beforeKind: "bullet_list", afterKind: "blockquote" },
        { source: "0)", kind: "quote" as const, expected: "> ", beforeKind: "ordered_list", afterKind: "blockquote" },
        { source: "- [x] done", kind: "bullet" as const, expected: "- done", beforeKind: "bullet_list", afterKind: "bullet_list" },
        { source: "+ [ ] work", kind: "ordered" as const, expected: "1. work", beforeKind: "bullet_list", afterKind: "ordered_list" },
        { source: "* [X] done", kind: "quote" as const, expected: "> done", beforeKind: "bullet_list", afterKind: "blockquote" },
        { source: "> ", kind: "bullet" as const, expected: "- ", beforeKind: "blockquote", afterKind: "bullet_list" },
        { source: "> text", kind: "ordered" as const, expected: "1. text", beforeKind: "blockquote", afterKind: "ordered_list" },
        { source: "- [ ] work", kind: "task" as const, expected: "work", beforeKind: "bullet_list", afterKind: "paragraph" },
      ])("replaces one complete prefix for $kind from $source", ({ source, kind, expected, beforeKind, afterKind }) => {
        edits({
          source, selection: EditorSelection.single(source.length), kind, expected,
          mapped: EditorSelection.single(expected.length),
          before: () => {
            const block = parseMarkdown(source).doc.child(0);
            expect(block.type.name).toBe(beforeKind);
            if (source.includes("[x]") || source.includes("[X]")) expect(block.child(0).attrs.checked).toBe(true);
            if (source.includes("[ ]")) expect(block.child(0).attrs.checked).toBe(false);
          },
          after: () => {
            const block = parseMarkdown(expected).doc.child(0);
            expect(block.type.name).toBe(afterKind);
            if (afterKind === "ordered_list") {
              expectList(expected, "ordered", { start: 1, delimiter: ".", tight: true }, block.textContent);
            } else if (afterKind === "bullet_list") {
              expectList(expected, "bullet", { bullet: "-", tight: true }, kind === "task" ? "" : block.textContent, kind === "task" ? false : null);
            }
          },
        });
      });

      it.each(["forward", "reverse"] as const)("numbers mixed selected lines once with a %s exclusive endpoint", (direction) => {
        const source = "before\n\n-\n+ text\n2)\nuntouched\n\nafter";
        const expected = "before\n\n1. \n2. text\n3. \nuntouched\n\nafter";
        const start = source.indexOf("-");
        const end = source.indexOf("untouched");
        const selection = direction === "forward" ? EditorSelection.single(start, end) : EditorSelection.single(end, start);
        const mappedEnd = expected.indexOf("untouched");
        edits({
          source, selection, kind: "ordered", expected,
          mapped: direction === "forward" ? EditorSelection.single(start, mappedEnd) : EditorSelection.single(mappedEnd, start),
          after: (view) => {
            const { doc } = parseMarkdown(view.state.doc.toString());
            expect(doc.child(0).textContent).toBe("before");
            expect(doc.lastChild?.textContent).toBe("after");
            expect(doc.child(1).type.name).toBe("ordered_list");
            expect(doc.child(1).attrs).toEqual({ start: 1, delimiter: ".", tight: true });
            expect(doc.child(1).childCount).toBe(3);
          },
        });
      });

      it("deduplicates overlapping selected lines with a nonzero main range", () => {
        const source = "- text\n\n+\n\n2)\n\nkeep";
        const expected = "> text\n\n> \n\n> \n\nkeep";
        const selection = EditorSelection.create([
          EditorSelection.range(2, 3), EditorSelection.range(5, 6),
          EditorSelection.cursor(9), EditorSelection.range(13, 11),
        ], 2);
        edits({
          source, selection, kind: "quote", expected,
          mapped: EditorSelection.create([
            EditorSelection.range(2, 3), EditorSelection.range(5, 6),
            EditorSelection.cursor(10), EditorSelection.range(14, 12),
          ], 2),
        });
      });

      it.each([
        { category: "attached text", sources: ["-word", "*word", "+word", "1.word", "2)word"], kind: "paragraph" },
        { category: "wrong punctuation", sources: ["1:", "2]", "1..", "2))"], kind: "paragraph" },
        { category: "plain numbers", sources: ["0", "7", "123456789"], kind: "paragraph" },
        { category: "repeated markers", sources: ["--", "**", "++"], kind: "paragraph" },
        { category: "escaped markers", sources: ["\\-", "\\*", "\\+", "1\\.", "2\\)"], kind: "paragraph" },
        { category: "unspaced thematic breaks", sources: ["---", "***", "___"], kind: "horizontal_rule" },
      ])("preserves the inherited lexical treatment of $category", ({ sources, kind }) => {
        for (const source of sources) {
          edits({
            source, selection: EditorSelection.single(source.length), kind: "bullet", expected: "- " + source,
            before: () => expect(parseMarkdown(source).doc.child(0).type.name).toBe(kind),
          });
        }
      });

      it("keeps lexical stripping distinct from parser thematic-break and nested-list recognition", () => {
        for (const { source, expected, block } of [
          { source: "- - -", expected: "- -", block: "horizontal_rule" },
          { source: "* * *", expected: "* *", block: "horizontal_rule" },
          { source: "+ +", expected: "+", block: "bullet_list" },
        ]) {
          edits({
            source, selection: EditorSelection.single(source.length), kind: "bullet", expected,
            before: () => expect(parseMarkdown(source).doc.child(0).type.name).toBe(block),
          });
        }
      });

      it("retains whitespace, bare-checkbox, leading-zero and broad numeric/indent policies", () => {
        for (const { source, kind, expected } of [
          { source: "- text", kind: "bullet" as const, expected: "text" },
          { source: "+\ttext", kind: "bullet" as const, expected: "text" },
          { source: "2)\ttext", kind: "ordered" as const, expected: "text" },
          { source: "- [x]\ttext", kind: "task" as const, expected: "text" },
          { source: "- [ ]", kind: "bullet" as const, expected: "[ ]" },
          { source: "- [x]", kind: "task" as const, expected: "- [ ] [x]" },
          { source: "0007)", kind: "ordered" as const, expected: "" },
          { source: "1234567890.", kind: "ordered" as const, expected: "" },
          { source: "\t-", kind: "bullet" as const, expected: "\t" },
          { source: "    7)", kind: "ordered" as const, expected: "    " },
        ]) {
          edits({ source, selection: EditorSelection.single(source.length), kind, expected });
        }
      });
    });
