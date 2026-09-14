import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { parseMarkdown } from "./parse";
import { schema } from "./schema";
import { serializeMarkdown } from "./serialize";

const paragraph = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const document = (...blocks: PMNode[]) => schema.nodes.doc.create(null, blocks);

function paragraphs(doc: PMNode): PMNode[] {
  const result: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type === schema.nodes.paragraph) result.push(node);
  });
  return result;
}

function textMarks(doc: PMNode) {
  const result: { text: string; marks: string[] }[] = [];
  doc.descendants((node) => {
    if (node.isText) {
      result.push({
        text: node.textContent,
        marks: node.marks.map((mark) => JSON.stringify(mark.toJSON())),
      });
    }
  });
  return result;
}

function expectStable(doc: PMNode, expectedMarkdown: string, expectedParagraphs: PMNode[]) {
  doc.check();
  let current = doc;
  for (let cycle = 0; cycle < 3; cycle++) {
    const markdown = serializeMarkdown(current);
    expect(markdown).toBe(expectedMarkdown);
    expect(serializeMarkdown(current)).toBe(expectedMarkdown);
    const parsed = parseMarkdown(markdown).doc;
    parsed.check();
    expect(parsed.eq(doc)).toBe(true);
    expect(parsed.toJSON()).toEqual(doc.toJSON());
    expect(parsed.textContent).toBe(doc.textContent);
    expect(parsed.childCount).toBe(doc.childCount);
    const actualParagraphs = paragraphs(parsed);
    expect(actualParagraphs).toHaveLength(expectedParagraphs.length);
    expect(actualParagraphs.map((node) => node.textContent)).toEqual(expectedParagraphs.map((node) => node.textContent));
    expect(actualParagraphs.map((node) => node.toJSON())).toEqual(expectedParagraphs.map((node) => node.toJSON()));
    expect(textMarks(parsed)).toEqual(textMarks(doc));
    current = parsed;
  }
  expect(serializeMarkdown(current)).toBe(expectedMarkdown);
}

function expectPlain(text: string, expectedMarkdown: string) {
  const node = paragraph(text);
  expectStable(document(node), expectedMarkdown, [node]);
}

describe("indented literal paragraph markers", () => {
  it.each([
    [" +", " \\+"],
    [" + text", " \\+ text"],
    [" +\ttext", " \\+\ttext"],
    ["  +", "  \\+"],
    ["  + \u{1f680}e\u0301", "  \\+ \u{1f680}e\u0301"],
    ["  +\ttext", "  \\+\ttext"],
    ["   +", "   \\+"],
    ["   + text", "   \\+ text"],
    ["   +\ttext", "   \\+\ttext"],
    [" -", " \\-"],
    [" - text", " \\- text"],
    [" -\ttext", " \\-\ttext"],
    ["  -", "  \\-"],
    ["  - text", "  \\- text"],
    ["  -\ttext", "  \\-\ttext"],
    ["   -", "   \\-"],
    ["   - text", "   \\- text"],
    ["   -\t\u{1f680}e\u0301", "   \\-\t\u{1f680}e\u0301"],
    [" >", " \\>"],
    [" > text", " \\> text"],
    [" >\ttext", " \\>\ttext"],
    ["  >", "  \\>"],
    ["  > text", "  \\> text"],
    ["  >\ttext", "  \\>\ttext"],
    ["   >", "   \\>"],
    ["   > \u{1f680}e\u0301", "   \\> \u{1f680}e\u0301"],
    ["   >\ttext", "   \\>\ttext"],
  ])("preserves bounded leading spaces and literal marker case %#", expectPlain);

  it.each([
    ["+ text", "\\+ text"],
    ["-word", "\\-word"],
    [">word", "\\>word"],
  ])("retains unindented marker output case %#", expectPlain);

  it.each([
    ["  -word", "  \\-word"],
    ["   >word", "   \\>word"],
  ])("retains unconditional dash and greater-than escaping case %#", expectPlain);

  it.each([
    [" +word", " +word"],
    ["  +123", "  +123"],
    ["   ++", "   ++"],
    ["  +\u00a0word", "  +\u00a0word"],
  ])("does not broaden the plus delimiter policy case %#", expectPlain);

  it("preserves neighboring paragraphs and their exact order", () => {
    const nodes = [
      paragraph("before"),
      paragraph(" + first"),
      paragraph("between"),
      paragraph("  - second"),
      paragraph("   > third"),
      paragraph("after"),
    ];
    expectStable(document(...nodes), "before\n\n \\+ first\n\nbetween\n\n  \\- second\n\n   \\> third\n\nafter", nodes);
  });

  it("preserves indented escaped paragraphs originating in Markdown source", () => {
    const source = " \\+\tfirst\n\n  \\-\n\n   \\> e\u0301\u{1f680}";
    const nodes = [paragraph(" +\tfirst"), paragraph("  -"), paragraph("   > e\u0301\u{1f680}")];
    const parsed = parseMarkdown(source).doc;
    parsed.check();
    expect(parsed.eq(document(...nodes))).toBe(true);
    expect(parsed.toJSON()).toEqual(document(...nodes).toJSON());
    expectStable(parsed, source, nodes);
  });

  it("keeps existing backslash and star escaping without doubling it", () => {
    const nodes = [
      paragraph(" \\+ text"),
      paragraph("  \\- text"),
      paragraph("   \\> text"),
      paragraph(" * text"),
      paragraph("  **text**"),
      paragraph("   + *text* \\tail"),
    ];
    expectStable(
      document(...nodes),
      " \\\\+ text\n\n  \\\\- text\n\n   \\\\> text\n\n \\* text\n\n  \\*\\*text\\*\\*\n\n   \\+ \\*text\\* \\\\tail",
      nodes,
    );
  });

  it("does not escape markers after text or a preceding marked fragment", () => {
    const marked = schema.nodes.paragraph.create(null, [
      schema.text("before", [schema.marks.strong.create()]),
      schema.text("  + text - text > text"),
    ]);
    const nodes = [paragraph("text  + literal"), paragraph("  text - literal > literal"), marked];
    expectStable(document(...nodes), "text  + literal\n\n  text - literal > literal\n\n**before**  + text - text > text", nodes);
  });

  it.each([
    {
      nodes: ["    + text", "    - text", "    > text", "     + text"],
      markdown: "    + text\n\n    - text\n\n    > text\n\n     + text",
    },
    {
      nodes: ["\t+ text", " \t- text", "\t  > text"],
      markdown: "\t+ text\n\n \t- text\n\n\t  > text",
    },
    {
      nodes: ["\u00a0+ text", " \u2003- text", "\u2003  > text"],
      markdown: "\u00a0+ text\n\n \u2003- text\n\n\u2003  > text",
    },
  ])("leaves excluded indentation output unchanged case %#", ({ nodes, markdown }) => {
    const doc = document(...nodes.map(paragraph));
    doc.check();
    // These inherited inputs can parse as code; only their serializer output is in scope.
    expect(serializeMarkdown(doc)).toBe(markdown);
    expect(serializeMarkdown(doc)).toBe(markdown);
  });

  it("does not escape indented markers in code marks", () => {
    const nodes = [" + text", "  - text", "   > text"].map((text) =>
      schema.nodes.paragraph.create(null, schema.text(text, [schema.marks.code.create()])),
    );
    expectStable(document(...nodes), "` + text`\n\n`  - text`\n\n`   > text`", nodes);
  });

  it("does not escape indented markers in a fenced code block", () => {
    const block = schema.nodes.code_block.create(
      { language: "text", meta: null },
      schema.text(" + text\n  - text\n   > text"),
    );
    expectStable(document(block), "```text\n + text\n  - text\n   > text\n```", []);
  });

  it("keeps heading output outside paragraph-prefix escaping", () => {
    const doc = document(
      schema.nodes.heading.create({ level: 2 }, schema.text(" + text")),
      schema.nodes.heading.create({ level: 3 }, schema.text("  - text")),
      schema.nodes.heading.create({ level: 4 }, schema.text("   > text #")),
    );
    doc.check();
    expect(serializeMarkdown(doc)).toBe("##  + text\n\n###   - text\n\n####    > text \\#");
  });

  it("keeps image alt text, destination and title escaping unchanged", () => {
    const node = schema.nodes.paragraph.create(null, schema.nodes.image.create({
      src: "/+image.png",
      alt: "  + alt",
      title: "   > title",
    }));
    expectStable(document(node), '![  + alt](/+image.png "   > title")', [node]);
  });

  it("keeps link labels, destinations and titles unchanged", () => {
    const node = schema.nodes.paragraph.create(null, schema.text("  + label", [
      schema.marks.link.create({ href: "/+link", title: " - title" }),
    ]));
    expectStable(document(node), '[  + label](/+link " - title")', [node]);
  });

  it("retains genuine container syntax without assuming nested whitespace round trips", () => {
    const listed = paragraph("listed");
    const quoted = paragraph("quoted");
    const numbered = paragraph("numbered");
    const doc = document(
      schema.nodes.bullet_list.create({ bullet: "+", tight: true }, schema.nodes.list_item.create(null, listed)),
      schema.nodes.blockquote.create(null, quoted),
      schema.nodes.ordered_list.create(
        { start: 3, delimiter: ")", tight: true },
        schema.nodes.list_item.create(null, numbered),
      ),
    );
    expectStable(doc, "+ listed\n\n> quoted\n\n3) numbered", [listed, quoted, numbered]);

    const padded = document(
      schema.nodes.bullet_list.create({ bullet: "-", tight: true }, schema.nodes.list_item.create(null, paragraph(" + text"))),
      schema.nodes.blockquote.create(null, paragraph("  > text")),
    );
    padded.check();
    expect(serializeMarkdown(padded)).toBe("-  \\+ text\n\n>   \\> text");
  });

  it("conservatively escapes a first-fragment plus before marked text", () => {
    const nodes = [1, 2, 3].map((indent) => schema.nodes.paragraph.create(null, [
      schema.text(" ".repeat(indent) + "+"),
      schema.text("word", [schema.marks.strong.create()]),
    ]));
    expectStable(document(...nodes), " \\+**word**\n\n  \\+**word**\n\n   \\+**word**", nodes);
  });
});
