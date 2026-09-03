import type { Mark, Node as ProseMirrorNode } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { describe, expect, it } from "vitest";
import { schema } from "../markdown/schema";
import { markdownInputRules } from "./inputrules";

function stateFor(block: ProseMirrorNode, offset: number): EditorState {
  const doc = schema.nodes.doc.create(null, [block]);
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1 + offset),
    plugins: [markdownInputRules()],
  });
}

function paragraphState(text = "", marks: readonly Mark[] = [], offset = text.length): EditorState {
  const content = text ? [schema.text(text, marks)] : [];
  return stateFor(schema.nodes.paragraph.create(null, content), offset);
}

function typeWithRules(initial: EditorState, text: string): EditorState {
  let state = initial;
  const rules = state.plugins[0];
  for (const character of text) {
    const { from, to } = state.selection;
    const view = {
      state,
      composing: false,
      dispatch: (transaction: Transaction) => void (state = state.apply(transaction)),
    } as unknown as EditorView;
    const handled =
      (rules.props.handleTextInput as (this: unknown, view: EditorView, from: number, to: number, text: string) => boolean).call(
        rules,
        view,
        from,
        to,
        character,
      ) ?? false;
    if (!handled) state = state.apply(state.tr.insertText(character));
  }
  return state;
}

function textRuns(state: EditorState): Array<{ text: string; marks: string[] }> {
  const runs: Array<{ text: string; marks: string[] }> = [];
  state.doc.descendants((node) => {
    if (node.isText) runs.push({ text: node.text!, marks: node.marks.map((mark) => mark.type.name) });
  });
  return runs;
}

describe("Markdown emphasis input rules", () => {
  it.each([
    {
      name: "at the start of a paragraph",
      before: "",
      after: "word",
      runs: [{ text: "word", marks: ["em"] }],
    },
    {
      name: "after whitespace",
      before: "Before ",
      after: "Before word",
      runs: [
        { text: "Before ", marks: [] },
        { text: "word", marks: ["em"] },
      ],
    },
    {
      name: "after punctuation",
      before: "Before (",
      after: "Before (word",
      runs: [
        { text: "Before (", marks: [] },
        { text: "word", marks: ["em"] },
      ],
    },
  ])("turns _word_ into exactly one emphasis mark $name", ({ before, after, runs }) => {
    const state = typeWithRules(paragraphState(before), "_word_");
    expect(state.doc.textContent).toBe(after);
    expect(textRuns(state)).toEqual(runs);
  });

  it.each(["snake_case", "snake_case_", "_ word_", "_word _", "__word__"])("keeps %s literal and unmarked", (text) => {
    const state = typeWithRules(paragraphState(), text);
    expect(state.doc.textContent).toBe(text);
    expect(textRuns(state)).toEqual([{ text, marks: [] }]);
  });

  it("keeps underscore syntax literal in inline and block code", () => {
    const code = schema.marks.code.create();
    const inline = typeWithRules(paragraphState("xy", [code], 1), "_word_");
    expect(inline.doc.textContent).toBe("x_word_y");
    expect(textRuns(inline)).toEqual([{ text: "x_word_y", marks: ["code"] }]);

    const block = typeWithRules(stateFor(schema.nodes.code_block.create(null, [schema.text("code")]), 4), "_word_");
    expect(block.doc.textContent).toBe("code_word_");
    expect(textRuns(block)).toEqual([{ text: "code_word_", marks: [] }]);
  });

  it.each([
    { syntax: "*word*", mark: "em" },
    { syntax: "**word**", mark: "strong" },
  ])("preserves the existing $syntax input rule", ({ syntax, mark }) => {
    const state = typeWithRules(paragraphState(), syntax);
    expect(state.doc.textContent).toBe("word");
    expect(textRuns(state)).toEqual([{ text: "word", marks: [mark] }]);
  });
});
