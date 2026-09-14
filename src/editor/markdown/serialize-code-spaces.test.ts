import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { parseMarkdown } from "./parse";
import { schema } from "./schema";
import { serializeMarkdown } from "./serialize";

function code(text: string) {
  return schema.text(text, [schema.marks.code.create()]);
}

function paragraph(...content: PMNode[]) {
  return schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, content));
}

function expectCode(node: PMNode, text: string) {
  expect(node.isText).toBe(true);
  expect(node.text).toBe(text);
  expect(node.marks).toEqual([schema.marks.code.create()]);
}

function expectSingleCode(doc: PMNode, text: string) {
  expect(doc.childCount).toBe(1);
  expect(doc.child(0).type).toBe(schema.nodes.paragraph);
  expect(doc.child(0).childCount).toBe(1);
  expectCode(doc.child(0).child(0), text);
}

describe("inline code edge spaces", () => {
  it.each([
    ["one space at each edge", " padded ", "`  padded  `"],
    ["multiple spaces at each edge", "   padded   ", "`    padded    `"],
    ["unequal edge spaces", "  padded    ", "`   padded     `"],
    ["internal spaces", " two  words ", "`  two  words  `"],
    ["supplementary and combining text", " \u{1f642} cafe\u0301 ", "`  \u{1f642} cafe\u0301  `"],
    ["a tab between ASCII spaces", " \t ", "`  \t  `"],
    ["NBSP between ASCII spaces", " \u00a0 ", "`  \u00a0  `"],
    ["mixed inner whitespace", " \tword\u00a0 ", "`  \tword\u00a0  `"],
  ])("protects %s", (_label, text, markdown) => {
    const original = paragraph(code(text));
    expect(serializeMarkdown(original)).toBe(markdown);
    const { doc } = parseMarkdown(markdown);
    expectSingleCode(doc, text);
    expect(doc.eq(original)).toBe(true);
  });

  it.each([
    ["one ASCII space", " ", "` `"],
    ["several ASCII spaces", "    ", "`    `"],
    ["leading space only", " padded", "` padded`"],
    ["trailing space only", "padded ", "`padded `"],
    ["multiple leading spaces only", "   padded", "`   padded`"],
    ["multiple trailing spaces only", "padded   ", "`padded   `"],
    ["ordinary text", "code", "`code`"],
    ["inner-only spaces", "two  words", "`two  words`"],
    ["NBSP edges", "\u00a0padded\u00a0", "`\u00a0padded\u00a0`"],
    ["NBSP only", "\u00a0\u00a0", "`\u00a0\u00a0`"],
    ["tab edges", "\tpadded\t", "`\tpadded\t`"],
    ["tab only", "\t", "`\t`"],
    ["multiple tabs", "\t\t", "`\t\t`"],
    ["ASCII space and NBSP edges", " padded\u00a0", "` padded\u00a0`"],
    ["NBSP and ASCII space edges", "\u00a0padded ", "`\u00a0padded `"],
    ["ASCII space and tab edges", " padded\t", "` padded\t`"],
    ["tab and ASCII space edges", "\tpadded ", "`\tpadded `"],
  ])("keeps the existing source for %s", (_label, text, markdown) => {
    const original = paragraph(code(text));
    expect(serializeMarkdown(original)).toBe(markdown);
    const { doc } = parseMarkdown(markdown);
    expectSingleCode(doc, text);
    expect(doc.eq(original)).toBe(true);
  });

  it.each([
    ["one internal tick", "a`b", "`` a`b ``"],
    ["multiple internal ticks", "a``b", "``` a``b ```"],
    ["different tick runs", "a`b```c", "```` a`b```c ````"],
    ["leading tick", "`code", "`` `code ``"],
    ["trailing tick", "code`", "`` code` ``"],
    ["ticks at both edges", "``code``", "``` ``code`` ```"],
    ["only ticks", "```", "```` ``` ````"],
    ["spaced tick content", " a`b ", "``  a`b  ``"],
    ["multiple spaced edges with ticks", "  a``b   ", "```   a``b    ```"],
  ])("preserves delimiter length and padding for %s", (_label, text, markdown) => {
    const original = paragraph(code(text));
    expect(serializeMarkdown(original)).toBe(markdown);
    const { doc } = parseMarkdown(markdown);
    expectSingleCode(doc, text);
    expect(doc.eq(original)).toBe(true);
  });

  it("preserves surrounding plain text and code boundaries", () => {
    const original = paragraph(schema.text("before "), code(" padded "), schema.text(" after"));
    const markdown = "before `  padded  ` after";
    expect(serializeMarkdown(original)).toBe(markdown);
    const { doc } = parseMarkdown(markdown);
    expect(doc.childCount).toBe(1);
    const content = doc.child(0);
    expect(content.childCount).toBe(3);
    expect(content.child(0).text).toBe("before ");
    expect(content.child(0).marks).toEqual([]);
    expectCode(content.child(1), " padded ");
    expect(content.child(2).text).toBe(" after");
    expect(content.child(2).marks).toEqual([]);
    expect(doc.eq(original)).toBe(true);
  });

  it.each([
    ["padded then unpadded", " padded ", "plain", "`  padded  ` and `plain`"],
    ["unpadded then padded", "plain", " padded ", "`plain` and `  padded  `"],
  ])("does not leak padding between separated spans: %s", (_label, first, second, markdown) => {
    const original = paragraph(code(first), schema.text(" and "), code(second));
    expect(serializeMarkdown(original)).toBe(markdown);
    const { doc } = parseMarkdown(markdown);
    expect(doc.childCount).toBe(1);
    const content = doc.child(0);
    expect(content.childCount).toBe(3);
    expectCode(content.child(0), first);
    expect(content.child(1).text).toBe(" and ");
    expect(content.child(1).marks).toEqual([]);
    expectCode(content.child(2), second);
    expect(doc.eq(original)).toBe(true);
  });

  it("preserves enclosing link and code marks", () => {
    const link = schema.marks.link.create({ href: "/guide", title: "Guide" });
    const marks = schema.marks.code.create().addToSet([link]);
    const original = paragraph(schema.text(" padded ", marks));
    const markdown = '[`  padded  `](/guide "Guide")';
    expect(serializeMarkdown(original)).toBe(markdown);
    const { doc } = parseMarkdown(markdown);
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).childCount).toBe(1);
    const content = doc.child(0).child(0);
    expect(content.isText).toBe(true);
    expect(content.text).toBe(" padded ");
    expect(content.marks).toEqual(marks);
    expect(schema.marks.link.isInSet(content.marks)?.attrs).toEqual({ href: "/guide", title: "Guide" });
    expect(doc.eq(original)).toBe(true);
  });

  it.each([
    ["one edge-space pair", " padded ", "`  padded  `"],
    ["multiple edge spaces", "   two  words  ", "`    two  words   `"],
    ["Unicode", " \u{1f642} e\u0301 ", "`  \u{1f642} e\u0301  `"],
    ["space-tab-space", " \t ", "`  \t  `"],
    ["all spaces", "   ", "`   `"],
    ["spaced backticks", " a``b ", "```  a``b  ```"],
  ])("stays stable across repeated round trips for %s", (_label, text, markdown) => {
    const original = paragraph(code(text));
    let current = original;
    for (let cycle = 0; cycle < 5; cycle++) {
      const source = serializeMarkdown(current);
      expect(source).toBe(markdown);
      current = parseMarkdown(source).doc;
      expectSingleCode(current, text);
      expect(current.eq(original)).toBe(true);
    }
  });

  it("preserves an empty document without creating empty text", () => {
    const original = paragraph();
    expect(serializeMarkdown(original)).toBe("");
    const { doc } = parseMarkdown("");
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).type).toBe(schema.nodes.paragraph);
    expect(doc.child(0).childCount).toBe(0);
    expect(doc.eq(original)).toBe(true);
  });
});
