import { describe, expect, it } from "vitest";
import { lintMarkdown } from "./lint";

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
});

