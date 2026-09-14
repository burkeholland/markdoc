import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { parseMarkdown } from "./parse";
import { schema } from "./schema";
import { serializeMarkdown } from "./serialize";

interface TitleCase {
  name: string;
  title: string | null;
  image: string;
  link: string;
  definition: string;
}

const titles: TitleCase[] = [
  {
    name: "one backslash",
    title: "\\",
    image: String.raw`![alt](image.png "\\")`,
    link: String.raw`[label](target "\\")`,
    definition: String.raw`[asset]: target "\\"`,
  },
  {
    name: "two backslashes",
    title: String.raw`\\`,
    image: String.raw`![alt](image.png "\\\\")`,
    link: String.raw`[label](target "\\\\")`,
    definition: String.raw`[asset]: target "\\\\"`,
  },
  {
    name: "multiple backslash runs",
    title: String.raw`one\\\two\\three\four`,
    image: String.raw`![alt](image.png "one\\\\\\two\\\\three\\four")`,
    link: String.raw`[label](target "one\\\\\\two\\\\three\\four")`,
    definition: String.raw`[asset]: target "one\\\\\\two\\\\three\\four"`,
  },
  {
    name: "backslash before a letter",
    title: String.raw`path\file`,
    image: String.raw`![alt](image.png "path\\file")`,
    link: String.raw`[label](target "path\\file")`,
    definition: String.raw`[asset]: target "path\\file"`,
  },
  {
    name: "backslashes before punctuation",
    title: String.raw`a\*b\!c\)d`,
    image: String.raw`![alt](image.png "a\\*b\\!c\\)d")`,
    link: String.raw`[label](target "a\\*b\\!c\\)d")`,
    definition: String.raw`[asset]: target "a\\*b\\!c\\)d"`,
  },
  {
    name: "quote preceded by a backslash",
    title: String.raw`a\"b`,
    image: String.raw`![alt](image.png "a\\\"b")`,
    link: String.raw`[label](target "a\\\"b")`,
    definition: String.raw`[asset]: target "a\\\"b"`,
  },
  {
    name: "trailing backslash",
    title: "tail\\",
    image: String.raw`![alt](image.png "tail\\")`,
    link: String.raw`[label](target "tail\\")`,
    definition: String.raw`[asset]: target "tail\\"`,
  },
  {
    name: "Unicode adjacent to a backslash",
    title: "\u00e9\\\u{1f642}",
    image: '![alt](image.png "\u00e9\\\\\u{1f642}")',
    link: '[label](target "\u00e9\\\\\u{1f642}")',
    definition: '[asset]: target "\u00e9\\\\\u{1f642}"',
  },
  {
    name: "ordinary title",
    title: "Title",
    image: '![alt](image.png "Title")',
    link: '[label](target "Title")',
    definition: '[asset]: target "Title"',
  },
  {
    name: "plain quotes",
    title: 'say "hello"',
    image: String.raw`![alt](image.png "say \"hello\"")`,
    link: String.raw`[label](target "say \"hello\"")`,
    definition: String.raw`[asset]: target "say \"hello\""`,
  },
  {
    name: "quote only",
    title: '"',
    image: String.raw`![alt](image.png "\"")`,
    link: String.raw`[label](target "\"")`,
    definition: String.raw`[asset]: target "\""`,
  },
  {
    name: "null title",
    title: null,
    image: "![alt](image.png)",
    link: "[label](target)",
    definition: "[asset]: target",
  },
  {
    name: "empty title",
    title: "",
    image: "![alt](image.png)",
    link: "[label](target)",
    definition: "[asset]: target",
  },
];

function paragraph(...content: PMNode[]) {
  return schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, content));
}

function expectSingleInline(doc: PMNode): PMNode {
  expect(doc.childCount).toBe(1);
  expect(doc.child(0).type).toBe(schema.nodes.paragraph);
  expect(doc.child(0).childCount).toBe(1);
  return doc.child(0).child(0);
}

function expectImage(node: PMNode, title: string | null, src = "image.png") {
  expect(node.type).toBe(schema.nodes.image);
  expect(node.isLeaf).toBe(true);
  expect(node.attrs).toEqual({ src, alt: "alt", title });
}

function expectLink(node: PMNode, title: string | null) {
  expect(node.isText).toBe(true);
  expect(node.text).toBe("label");
  expect(node.marks).toEqual([schema.marks.link.create({ href: "target", title })]);
}

function expectDefinition(doc: PMNode, title: string | null) {
  const definitions: PMNode[] = [];
  doc.forEach((node) => {
    if (node.type === schema.nodes.link_definition) {
      definitions.push(node);
    } else {
      expect(node.type).toBe(schema.nodes.paragraph);
      expect(node.childCount).toBe(0);
    }
  });
  expect(definitions).toHaveLength(1);
  expect(definitions[0].attrs).toEqual({ label: "asset", url: "target", title });
  expect(definitions[0].marks).toEqual([]);
}

describe("Markdown title backslashes", () => {
  it.each(titles)("preserves image titles: $name", ({ title, image: markdown }) => {
    const original = paragraph(schema.nodes.image.create({ src: "image.png", alt: "alt", title }));
    expect(serializeMarkdown(original)).toBe(markdown);
    const { doc } = parseMarkdown(markdown);
    const image = expectSingleInline(doc);
    expectImage(image, title || null);
    expect(image.marks).toEqual([]);
    expect(serializeMarkdown(doc)).toBe(markdown);
    const reparsed = parseMarkdown(serializeMarkdown(doc)).doc;
    expectImage(expectSingleInline(reparsed), title || null);
    expect(reparsed.eq(doc)).toBe(true);
  });

  it.each(titles)("preserves link titles: $name", ({ title, link: markdown }) => {
    const link = schema.marks.link.create({ href: "target", title });
    const original = paragraph(schema.text("label", [link]));
    expect(serializeMarkdown(original)).toBe(markdown);
    const { doc } = parseMarkdown(markdown);
    expectLink(expectSingleInline(doc), title || null);
    expect(serializeMarkdown(doc)).toBe(markdown);
    const reparsed = parseMarkdown(serializeMarkdown(doc)).doc;
    expectLink(expectSingleInline(reparsed), title || null);
    expect(reparsed.eq(doc)).toBe(true);
  });

  it.each(titles)("preserves definition titles: $name", ({ title, definition: markdown }) => {
    const original = schema.nodes.doc.create(
      null,
      schema.nodes.link_definition.create({ label: "asset", url: "target", title }),
    );
    expect(serializeMarkdown(original)).toBe(markdown);
    const { doc } = parseMarkdown(markdown);
    expectDefinition(doc, title || null);
    // A definition-only parse may add an empty paragraph; keep that existing normalization.
    const serialized = serializeMarkdown(doc);
    expect(serialized.trimEnd()).toBe(markdown);
    const reparsed = parseMarkdown(serialized).doc;
    expectDefinition(reparsed, title || null);
    expect(reparsed.eq(doc)).toBe(true);
    expect(serializeMarkdown(reparsed)).toBe(serialized);
  });

  it("resolves an escaped definition title onto a reference link and image", () => {
    const title = String.raw`ref\*"quoted` + "\\";
    const definition = schema.nodes.link_definition.create({ label: "asset", url: "target", title });
    const definitionSource = String.raw`[asset]: target "ref\\*\"quoted\\"`;
    expect(serializeMarkdown(schema.nodes.doc.create(null, definition))).toBe(definitionSource);
    const source = definitionSource + "\n\nbefore [label][asset] and ![alt][asset] after";
    const { doc } = parseMarkdown(source);
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).eq(definition)).toBe(true);
    const content = doc.child(1);
    expect(content.type).toBe(schema.nodes.paragraph);
    expect(content.childCount).toBe(5);
    expectLink(content.child(1), title);
    expectImage(content.child(3), title, "target");
    expect(content.child(3).marks).toEqual([]);
    const expected = schema.nodes.paragraph.create(null, [
      schema.text("before "),
      schema.text("label", [schema.marks.link.create({ href: "target", title })]),
      schema.text(" and "),
      schema.nodes.image.create({ src: "target", alt: "alt", title }),
      schema.text(" after"),
    ]);
    expect(content.eq(expected)).toBe(true);
    const markdown =
      definitionSource +
      "\n\n" +
      String.raw`before [label](target "ref\\*\"quoted\\") and ![alt](target "ref\\*\"quoted\\") after`;
    expect(serializeMarkdown(doc)).toBe(markdown);
    const reparsed = parseMarkdown(markdown).doc;
    expect(reparsed.eq(doc)).toBe(true);
    expectLink(reparsed.child(1).child(1), title);
    expectImage(reparsed.child(1).child(3), title, "target");
    expect(serializeMarkdown(reparsed)).toBe(markdown);
  });

  it("keeps different image and enclosing link titles without touching neighboring text", () => {
    const imageTitle = String.raw`image\*"quoted`;
    const linkTitle = "link\\";
    const link = schema.marks.link.create({ href: "target", title: linkTitle });
    const original = paragraph(
      schema.text("before "),
      schema.nodes.image.create({ src: "image.png", alt: "alt", title: imageTitle }, null, [link]),
      schema.text(" after"),
    );
    const markdown = String.raw`before [![alt](image.png "image\\*\"quoted")](target "link\\") after`;
    expect(serializeMarkdown(original)).toBe(markdown);
    const { doc } = parseMarkdown(markdown);
    expect(doc.childCount).toBe(1);
    const content = doc.child(0);
    expect(content.childCount).toBe(3);
    expect(content.child(0).text).toBe("before ");
    expect(content.child(0).marks).toEqual([]);
    expectImage(content.child(1), imageTitle);
    expect(content.child(1).marks).toEqual([link]);
    expect(content.child(2).text).toBe(" after");
    expect(content.child(2).marks).toEqual([]);
    expect(doc.eq(original)).toBe(true);
    expect(serializeMarkdown(doc)).toBe(markdown);
    const reparsed = parseMarkdown(serializeMarkdown(doc)).doc;
    expectImage(reparsed.child(0).child(1), imageTitle);
    expect(reparsed.child(0).child(1).marks).toEqual([link]);
    expect(reparsed.eq(original)).toBe(true);
    expect(serializeMarkdown(reparsed)).toBe(markdown);
  });
});
