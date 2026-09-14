// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import type { Node as PMNode } from "prosemirror-model";
import { parseMarkdown } from "../markdown/parse";
import { insertImage, insertLink, setHeading, toggleInlineMark, toggleLinePrefix, type InlineMarker, type LinePrefixKind } from "./commands";

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
