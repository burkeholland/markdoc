import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { ensureSyntaxTree } from "@codemirror/language";
import { formatStateAt, type SourceFormatState } from "./commands";

const plain: SourceFormatState = {
  strong: false,
  em: false,
  code: false,
  strike: false,
  link: false,
  heading: 0,
  bullet: false,
  ordered: false,
  task: false,
  quote: false,
  codeBlock: false,
};
const codeBlock: SourceFormatState = { ...plain, codeBlock: true };
const literalLines = ["# heading", "- bullet", "- [ ] todo", "1. ordered", "> quote"];
const fences = [
  { name: "backticks", open: "```", close: "```" },
  { name: "backticks with info", open: "```text", close: "```" },
  { name: "tildes", open: "~~~", close: "~~~" },
  { name: "tildes with info", open: "~~~text", close: "~~~" },
];

function parsedState(doc: string, selection: EditorSelection) {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
    ],
  });
  expect(ensureSyntaxTree(state, state.doc.length, 1000)).not.toBeNull();
  return state;
}

function expectCodeContext(state: EditorState, kind: "FencedCode" | "CodeBlock", head = state.selection.main.head) {
  const tree = ensureSyntaxTree(state, state.doc.length, 1000);
  expect(tree).not.toBeNull();
  let node = tree!.resolveInner(head, -1);
  while (node.parent && node.name !== kind) node = node.parent;
  expect(node.name).toBe(kind);
  return node;
}

function expectFormat(state: EditorState, expected: SourceFormatState, range?: SelectionRange) {
  const doc = state.doc;
  const text = doc.toString();
  const selection = state.selection;
  const selectionJson = selection.toJSON();
  expect(formatStateAt(state, range)).toEqual(expected);
  expect(state.doc).toBe(doc);
  expect(state.doc.toString()).toBe(text);
  expect(state.selection).toBe(selection);
  expect(state.selection.toJSON()).toEqual(selectionJson);
}

describe("source code block format state", () => {
  it.each(fences)("ignores literal block markers inside $name", ({ open, close }) => {
    const doc = [open, ...literalLines, close].join("\n");
    for (const line of literalLines) {
      const head = doc.indexOf(line) + line.length - 2;
      const state = parsedState(doc, EditorSelection.single(head));
      expectCodeContext(state, "FencedCode");
      expectFormat(state, codeBlock);
    }
  });

  it.each(fences)("retains code context on opening and closing $name", ({ open, close }) => {
    const doc = [open, "ordinary body", close].join("\n");
    for (const head of [2, doc.length - 1]) {
      const state = parsedState(doc, EditorSelection.single(head));
      expectCodeContext(state, "FencedCode");
      expectFormat(state, codeBlock);
    }
  });

  it.each([...literalLines, "ordinary body"])("reports indented code for %s", (line) => {
    const doc = `    ${line}`;
    const state = parsedState(doc, EditorSelection.single(doc.length - 2));
    expectCodeContext(state, "CodeBlock");
    expectFormat(state, codeBlock);
  });

  it.each([
    { name: "blockquote", prefix: "> ", parent: "", container: "Blockquote", task: false, expected: { ...codeBlock, quote: true } },
    { name: "plain bullet", prefix: "  ", parent: "- parent\n\n", container: "BulletList", task: false, expected: { ...codeBlock, bullet: true } },
    { name: "ordered list", prefix: "   ", parent: "1. parent\n\n", container: "OrderedList", task: false, expected: { ...codeBlock, ordered: true } },
    { name: "unchecked task", prefix: "  ", parent: "- [ ] parent\n\n", container: "BulletList", task: true, expected: { ...codeBlock, task: true } },
    { name: "checked task", prefix: "  ", parent: "- [x] parent\n\n", container: "BulletList", task: true, expected: { ...codeBlock, task: true } },
    { name: "ordered task", prefix: "   ", parent: "1. [ ] parent\n\n", container: "OrderedList", task: true, expected: { ...codeBlock, ordered: true, task: true } },
    { name: "plain item after a task", prefix: "  ", parent: "- [ ] previous\n- parent\n\n", container: "BulletList", task: false, expected: { ...codeBlock, bullet: true } },
  ])("preserves the real outer $name without reading code markers as containers", ({ prefix, parent, container, task, expected }) => {
    const doc = parent + ["```", ...literalLines, "```"].map((line) => prefix + line).join("\n");
    for (const line of literalLines) {
      const state = parsedState(doc, EditorSelection.single(doc.indexOf(line) + line.length - 2));
      const code = expectCodeContext(state, "FencedCode");
      if (container === "Blockquote") {
        expect(code.parent?.name).toBe(container);
      } else {
        expect(code.parent?.name).toBe("ListItem");
        expect(code.parent?.parent?.name).toBe(container);
        expect(code.parent?.getChild("Task") !== null).toBe(task);
      }
      expectFormat(state, expected);
    }
  });

  it.each([
    { name: "heading", doc: "## heading", token: "heading", expected: { ...plain, heading: 2 } },
    { name: "bullet", doc: "- bullet", token: "bullet", expected: { ...plain, bullet: true } },
    { name: "unchecked task", doc: "- [ ] todo", token: "todo", expected: { ...plain, task: true } },
    { name: "checked task", doc: "- [X] done", token: "done", expected: { ...plain, task: true } },
    { name: "ordered list", doc: "1. ordered", token: "ordered", expected: { ...plain, ordered: true } },
    { name: "blockquote", doc: "> quote", token: "quote", expected: { ...plain, quote: true } },
    { name: "plain prose", doc: "ordinary prose", token: "ordinary", expected: plain },
    { name: "strong emphasis", doc: "**strong**", token: "strong", expected: { ...plain, strong: true } },
    { name: "emphasis", doc: "*emphasis*", token: "emphasis", expected: { ...plain, em: true } },
    { name: "strikethrough", doc: "~~strike~~", token: "strike", expected: { ...plain, strike: true } },
    { name: "inline code", doc: "`inline`", token: "inline", expected: { ...plain, code: true } },
    { name: "link", doc: "[label](destination)", token: "label", expected: { ...plain, link: true } },
  ])("keeps existing $name state outside code", ({ doc, token, expected }) => {
    const state = parsedState(doc, EditorSelection.single(doc.indexOf(token) + 2));
    expectFormat(state, expected);
  });

  it.each([
    { name: "forward into code", doc: "# outside\n\n```\n- literal\n```", anchorToken: "outside", headToken: "literal", expected: codeBlock },
    { name: "reversed out of code", doc: "# outside\n\n```\n- literal\n```", anchorToken: "literal", headToken: "outside", expected: { ...plain, heading: 1 } },
    { name: "forward out of code", doc: "```\n- literal\n```\n\n# outside", anchorToken: "literal", headToken: "outside", expected: { ...plain, heading: 1 } },
    { name: "reversed into code", doc: "```\n- literal\n```\n\n# outside", anchorToken: "outside", headToken: "literal", expected: codeBlock },
  ])("uses the active head for a selection $name", ({ doc, anchorToken, headToken, expected }) => {
    const state = parsedState(doc, EditorSelection.single(doc.indexOf(anchorToken) + 2, doc.indexOf(headToken) + 2));
    if (expected.codeBlock) expectCodeContext(state, "FencedCode");
    expectFormat(state, expected);
  });

  it("uses an explicit range instead of the main selection without changing either", () => {
    const doc = "# outside\n\n```\n- literal\n```";
    const outside = doc.indexOf("outside") + 2;
    const inside = doc.indexOf("literal") + 2;
    const state = parsedState(doc, EditorSelection.single(outside));
    const range = EditorSelection.range(outside, inside);
    expectCodeContext(state, "FencedCode", range.head);
    expectFormat(state, codeBlock, range);
    expectFormat(state, { ...plain, heading: 1 });
    expect(range.anchor).toBe(outside);
    expect(range.head).toBe(inside);
  });

  it("uses the main index of multiple selections and honors an explicit non-main range", () => {
    const doc = "# outside\n\n```\n- literal\n```";
    const selection = EditorSelection.create([
      EditorSelection.cursor(doc.indexOf("outside") + 2),
      EditorSelection.cursor(doc.indexOf("literal") + 2),
    ], 1);
    const state = parsedState(doc, selection);
    expectCodeContext(state, "FencedCode");
    expectFormat(state, codeBlock);
    expectFormat(state, { ...plain, heading: 1 }, state.selection.ranges[0]);
    expect(state.selection.mainIndex).toBe(1);
  });
});
