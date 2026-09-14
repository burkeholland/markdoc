import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { parseMarkdown } from "./parse";
import { schema } from "./schema";
import { serializeMarkdown } from "./serialize";

const paragraph = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));

function expectStable(doc: PMNode, expectedMarkdown: string, expectedParagraphs: PMNode[]) {
  doc.check();
  let current = doc;
  for (let cycle = 0; cycle < 3; cycle++) {
    const markdown = serializeMarkdown(current);
    expect(markdown).toBe(expectedMarkdown);
    const parsed = parseMarkdown(markdown).doc;
    expect(parsed.eq(doc)).toBe(true);
    expect(parsed.toJSON()).toEqual(doc.toJSON());
    expect(parsed.childCount).toBe(doc.childCount);
    const paragraphs: PMNode[] = [];
    parsed.descendants((node) => {
      if (node.type === schema.nodes.paragraph) paragraphs.push(node);
    });
    expect(paragraphs).toHaveLength(expectedParagraphs.length);
    expect(paragraphs.map((node) => node.textContent)).toEqual(expectedParagraphs.map((node) => node.textContent));
    expect(paragraphs.map((node) => node.toJSON())).toEqual(expectedParagraphs.map((node) => node.toJSON()));
    current = parsed;
  }
}

describe("literal plus paragraph markers", () => {
  it.each([
    ["plus only", "+", "\\+"],
    ["ASCII space", "+ text", "\\+ text"],
    ["multiple ASCII spaces", "+   text", "\\+   text"],
    ["five ASCII spaces", "+     text", "\\+     text"],
    ["ASCII tab", "+\ttext", "\\+\ttext"],
    ["multiple ASCII tabs", "+\t\ttext", "\\+\t\ttext"],
    ["mixed ASCII whitespace", "+ \t text", "\\+ \t text"],
    ["supplementary text", "+\t\u{1f680}", "\\+\t\u{1f680}"],
    ["combining text", "+  e\u0301", "\\+  e\u0301"],
  ])("preserves a plain paragraph with %s", (_label, text, markdown) => {
    const p = paragraph(text);
    expectStable(schema.nodes.doc.create(null, p), markdown, [p]);
  });

  it.each([
    ["word", "+word", "+word"],
    ["digit", "+1", "+1"],
    ["underscore with existing escaping", "+_word", "+\\_word"],
    ["punctuation", "+,word", "+,word"],
    ["double plus", "++", "++"],
    ["triple plus", "+++", "+++"],
    ["nonbreaking space", "+\u00a0text", "+\u00a0text"],
    ["em space", "+\u2003text", "+\u2003text"],
    ["narrow nonbreaking space", "+\u202ftext", "+\u202ftext"],
    ["ideographic space", "+\u3000text", "+\u3000text"],
    ["midparagraph space", "before + text", "before + text"],
    ["midparagraph tab", "before +\ttext", "before +\ttext"],
  ])("does not add plus escaping before %s", (_label, text, markdown) => {
    const p = paragraph(text);
    expectStable(schema.nodes.doc.create(null, p), markdown, [p]);
  });

  it.each([
    ["plus only after ordinary text", "before", "+", "before\n\n\\+"],
    ["markers in both paragraphs", "+ text", "+\t\ttext", "\\+ text\n\n\\+\t\ttext"],
  ])("keeps two paragraphs with %s", (_label, first, second, markdown) => {
    const paragraphs = [paragraph(first), paragraph(second)];
    expectStable(schema.nodes.doc.create(null, paragraphs), markdown, paragraphs);
  });

  it("keeps marker paragraphs inside a blockquote", () => {
    const paragraphs = [paragraph("+"), paragraph("+  text"), paragraph("+\ttext")];
    const quote = schema.nodes.blockquote.create(null, paragraphs);
    expectStable(schema.nodes.doc.create(null, quote), "> \\+\n>\n> \\+  text\n>\n> \\+\ttext", paragraphs);
  });

  it("keeps bullet style, looseness and task-item attributes", () => {
    const paragraphs = [paragraph("+"), paragraph("+ \ttext"), paragraph("+  text")];
    const list = schema.nodes.bullet_list.create({ bullet: "+", tight: false }, [
      schema.nodes.list_item.create({ checked: null }, paragraphs[0]),
      schema.nodes.list_item.create({ checked: true }, paragraphs[1]),
      schema.nodes.list_item.create({ checked: false }, paragraphs[2]),
    ]);
    expectStable(schema.nodes.doc.create(null, list), "+ \\+\n\n+ [x] \\+ \ttext\n\n+ [ ] \\+  text", paragraphs);
  });

  it("keeps multiple paragraphs and ordered-list attributes inside an item", () => {
    const paragraphs = [paragraph("+"), paragraph("+\ttext")];
    const list = schema.nodes.ordered_list.create(
      { start: 7, delimiter: ")", tight: false },
      schema.nodes.list_item.create(null, paragraphs),
    );
    expectStable(schema.nodes.doc.create(null, list), "7) \\+\n\n   \\+\ttext", paragraphs);
  });

  it.each([
    ["plus only", "+", "`+`\n\n\\+"],
    ["plus and tab", "+\ttext", "`+\ttext`\n\n\\+\ttext"],
  ])("leaves code-marked %s untouched while escaping plain text", (_label, text, markdown) => {
    const code = schema.nodes.paragraph.create(null, schema.text(text, [schema.marks.code.create()]));
    const plain = paragraph(text);
    expectStable(schema.nodes.doc.create(null, [code, plain]), markdown, [code, plain]);
  });

  it("leaves plus markers and tabs inside a code block untouched", () => {
    const code = schema.nodes.code_block.create(null, schema.text("+\n+\ttext\n+  text"));
    const plain = paragraph("+\ttext");
    expectStable(
      schema.nodes.doc.create(null, [code, plain]),
      "```\n+\n+\ttext\n+  text\n```\n\n\\+\ttext",
      [plain],
    );
  });

  it.each([
    ["plus only", "+", "![+](+image.png \"+ title\")"],
    ["plus and tab", "+\ttext", "![+\ttext](+image.png \"+ title\")"],
  ])("leaves image-alt %s, destination and title untouched", (_label, alt, markdown) => {
    const p = schema.nodes.paragraph.create(
      null,
      schema.nodes.image.create({ src: "+image.png", alt, title: "+ title" }),
    );
    expectStable(schema.nodes.doc.create(null, p), markdown, [p]);
  });

  it("leaves a plus-only link destination and its title untouched", () => {
    const p = schema.nodes.paragraph.create(
      null,
      schema.text("label", [schema.marks.link.create({ href: "+", title: "+ title" })]),
    );
    expectStable(schema.nodes.doc.create(null, p), "[label](+ \"+ title\")", [p]);
  });

  it("leaves plus signs in an autolink address untouched", () => {
    const href = "https://example.com/+path";
    const p = schema.nodes.paragraph.create(null, schema.text(href, [schema.marks.link.create({ href })]));
    expectStable(schema.nodes.doc.create(null, p), "<https://example.com/+path>", [p]);
  });

  it("leaves a heading's plus and tab untouched", () => {
    const heading = schema.nodes.heading.create({ level: 2 }, schema.text("+\ttext"));
    expectStable(schema.nodes.doc.create(null, heading), "## +\ttext", []);
  });

  it("conservatively escapes a plus-only first text fragment", () => {
    const p = schema.nodes.paragraph.create(null, [
      schema.text("+"),
      schema.text("word", [schema.marks.code.create()]),
    ]);
    expectStable(schema.nodes.doc.create(null, p), "\\+`word`", [p]);
  });
});
