// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { toggleInlineMark, type InlineMarker } from "./commands";

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
