// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { setHeading, toggleInlineMark, toggleLinePrefix, type InlineMarker, type LinePrefixKind } from "./commands";

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
