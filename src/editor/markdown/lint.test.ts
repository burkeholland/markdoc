import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { lintMarkdown } from "./lint";
import { parseMarkdown, parseMdast } from "./parse";
import { reparseRange, textChangeSpan } from "./incremental";
import { MarkdownBinding } from "../sync/markdown-binding";
import { LONG_DOC } from "../../../e2e/fixtures/burke-scale";

const FIXTURES = [
  "# Title\n\nSome text with a [link](https://example.com).\n\n## Section\n\n- item\n",
  "# A\n\n### Jump\n\n# A\n",
  "See [docs][missing] and [here]().",
  "text \n\n```js\nlet a = 1;\n",
  "| a | b |\n|---|---|\n| 1 |\n",
  "# T\n\n<<<<<<< local\nmine\n=======\ntheirs\n>>>>>>> github\n\nok\n",
  "Title\n=====\n\ntext\n",
  "![](x.png) and a [ref][nowhere] and a footnote[^gone] and [a b](http://x y).\n\n[ok]: https://example.com\n\n# One\n\n#\n\n# Two\n",
  LONG_DOC,
];

describe("lintMarkdown", () => {
  it("returns no issues for a clean document", () => {
    const src = "# Title\n\nSome text with a [link](https://example.com).\n\n## Section\n\n- item\n";
    expect(lintMarkdown(src)).toEqual([]);
  });

  it("flags heading jumps, duplicates, and multiple h1s", () => {
    const src = "# A\n\n### Jump\n\n# A\n";
    const rules = lintMarkdown(src).map((i) => i.rule);
    expect(rules).toContain("heading-increment");
    expect(rules).toContain("duplicate-heading");
    expect(rules).toContain("multiple-h1");
  });

  it("flags undefined references and empty links", () => {
    const issues = lintMarkdown("See [docs][missing] and [here]().");
    expect(issues.map((i) => i.rule).sort()).toEqual(["empty-link", "undefined-reference"]);
    expect(issues[0].line).toBe(1);
  });

  it("flags unclosed fences and trailing whitespace", () => {
    const issues = lintMarkdown("text \n\n```js\nlet a = 1;\n");
    expect(issues.map((i) => i.rule).sort()).toEqual(["trailing-space", "unclosed-fence"]);
    expect(issues.find((i) => i.rule === "unclosed-fence")?.severity).toBe("error");
  });

  it("flags table rows with the wrong number of cells", () => {
    const issues = lintMarkdown("| a | b |\n|---|---|\n| 1 |\n");
    expect(issues.map((i) => i.rule)).toEqual(["table-columns"]);
  });

  it("flags merge-conflict markers as errors, one per marker line", () => {
    const src = "# T\n\n<<<<<<< local\nmine\n=======\ntheirs\n>>>>>>> github\n\nok\n";
    const issues = lintMarkdown(src).filter((i) => i.rule === "merge-conflict");
    expect(issues.map((i) => i.line)).toEqual([3, 5, 7]);
    expect(issues.every((i) => i.severity === "error")).toBe(true);
    expect(issues[0].offset).toBe(src.indexOf("<<<<<<<"));
    // A setext heading underline is not a marker, and `=======` inside a fence still is (it cannot be intended there either).
    expect(lintMarkdown("Title\n=====\n\ntext\n").filter((i) => i.rule === "merge-conflict")).toEqual([]);
    expect(lintMarkdown("a\n========\nb\n").filter((i) => i.rule === "merge-conflict")).toEqual([]);
  });

  it("gives the same issues from an existing tree as from the text (fixtures + the Burke-scale hero doc)", () => {
    for (const src of FIXTURES) {
      const fromText = lintMarkdown(src);
      expect(lintMarkdown(src, parseMdast(src))).toEqual(fromText);
      expect(lintMarkdown(src, parseMarkdown(src).tree)).toEqual(fromText);
    }
    // The hero doc is clean (the snapshot of its issues list before and after this change is `[]`);
    // the edits in the next test give it issues so non-empty lists are compared too.
    expect(lintMarkdown(LONG_DOC)).toEqual([]);
  });

  // 60 s (task #1190): the slowest test here — 2.2 s alone on a box already at 100 % CPU, 9.8 s with four files
  // in parallel — hit the global 20 s timeout in a saturated release preflight (#1145). Its four edits are
  // independent, but each already pays a full parse of LONG_DOC, so `it.each` rows would split the time, not
  // reduce it; the keystroke chain below depends on the previous incremental result and cannot be split.
  it("gives the same issues from an incrementally re-parsed tree after typing at the end and in the middle", { timeout: 60_000 }, () => {
    const mid = LONG_DOC.indexOf("## 20.");
    const edits = [
      { at: LONG_DOC.length, insert: " zqxa" },
      { at: LONG_DOC.length, insert: "\n\nA [dangling][ref] and ![](i.png) \n" },
      { at: LONG_DOC.indexOf("\n", mid) , insert: " typed" },
      { at: mid, insert: "#" },
    ];
    let withIssues = 0;
    for (const edit of edits) {
      const next = LONG_DOC.slice(0, edit.at) + edit.insert + LONG_DOC.slice(edit.at);
      const inc = reparseRange(parseMarkdown(LONG_DOC), LONG_DOC, next, textChangeSpan(LONG_DOC, next)!);
      expect(inc, JSON.stringify(edit.insert)).not.toBeNull();
      const issues = lintMarkdown(next);
      if (issues.length > 0) withIssues++;
      expect(lintMarkdown(next, inc!.tree), JSON.stringify(edit.insert)).toEqual(issues);
    }
    expect(withIssues).toBeGreaterThan(0);
    // Consecutive keystrokes, each building on the previous incremental result, as the binding does.
    let text = LONG_DOC;
    let result = parseMarkdown(text);
    for (const ch of "zqxa more words ") {
      const next = text + ch;
      const inc = reparseRange(result, text, next, textChangeSpan(text, next)!);
      expect(inc).not.toBeNull();
      expect(lintMarkdown(next, inc!.tree)).toEqual(lintMarkdown(next));
      text = next;
      result = inc!;
    }
  });

  it("lints from the binding's tree (the status bar path) without a second parse", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, LONG_DOC);
    const binding = new MarkdownBinding(ytext);
    binding.initialDoc();
    const before = lintMarkdown(LONG_DOC);
    let { text, tree } = binding.getTree();
    expect(text).toBe(LONG_DOC);
    expect(lintMarkdown(text, tree)).toEqual(before);
    // Typing at the end: the tree comes from the incremental parse, and lint still matches a full parse.
    ytext.insert(ytext.length, " zqxa [nowhere]");
    ({ text, tree } = binding.getTree());
    expect(text).toBe(LONG_DOC + " zqxa [nowhere]");
    expect(lintMarkdown(text, tree)).toEqual(lintMarkdown(text));
    binding.destroy();
  });
});

