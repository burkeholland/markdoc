import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { parseMarkdown } from "./parse";
import { schema } from "./schema";
import { serializeMarkdown } from "./serialize";

interface DestinationCase {
  name: string;
  destination: string;
  image: string;
  link: string;
  definition: string;
}

const destinations: DestinationCase[] = [
  {
    name: "plain address",
    destination: "target",
    image: '![alt](target "Title")',
    link: '[label](target "Title")',
    definition: '[asset]: target "Title"',
  },
  {
    name: "relative path",
    destination: "../images/photo.png",
    image: '![alt](../images/photo.png "Title")',
    link: '[label](../images/photo.png "Title")',
    definition: '[asset]: ../images/photo.png "Title"',
  },
  {
    name: "Unicode path",
    destination: "./caf\u00e9/\u{1f642}.png",
    image: '![alt](./caf\u00e9/\u{1f642}.png "Title")',
    link: '[label](./caf\u00e9/\u{1f642}.png "Title")',
    definition: '[asset]: ./caf\u00e9/\u{1f642}.png "Title"',
  },
  {
    name: "percent escapes",
    destination: "./a%5Cb%28c%29%22d%2f.png",
    image: '![alt](./a%5Cb%28c%29%22d%2f.png "Title")',
    link: '[label](./a%5Cb%28c%29%22d%2f.png "Title")',
    definition: '[asset]: ./a%5Cb%28c%29%22d%2f.png "Title"',
  },
  {
    name: "backslash before a letter",
    destination: String.raw`path\file`,
    image: String.raw`![alt](path\\file "Title")`,
    link: String.raw`[label](path\\file "Title")`,
    definition: String.raw`[asset]: path\\file "Title"`,
  },
  {
    name: "backslashes before punctuation",
    destination: String.raw`a\*b\!c`,
    image: String.raw`![alt](a\\*b\\!c "Title")`,
    link: String.raw`[label](a\\*b\\!c "Title")`,
    definition: String.raw`[asset]: a\\*b\\!c "Title"`,
  },
  {
    name: "doubled and repeated backslashes",
    destination: String.raw`a\\b\\\c`,
    image: String.raw`![alt](a\\\\b\\\\\\c "Title")`,
    link: String.raw`[label](a\\\\b\\\\\\c "Title")`,
    definition: String.raw`[asset]: a\\\\b\\\\\\c "Title"`,
  },
  {
    name: "trailing backslash",
    destination: "tail\\",
    image: String.raw`![alt](tail\\ "Title")`,
    link: String.raw`[label](tail\\ "Title")`,
    definition: String.raw`[asset]: tail\\ "Title"`,
  },
  {
    name: "backslashes immediately before parentheses and quote",
    destination: String.raw`a\(b\)c\"d`,
    image: String.raw`![alt](a\\\(b\\\)c\\\"d "Title")`,
    link: String.raw`[label](a\\\(b\\\)c\\\"d "Title")`,
    definition: String.raw`[asset]: a\\\(b\\\)c\\\"d "Title"`,
  },
  {
    name: "balanced nested parentheses",
    destination: "a(b(c)d)e",
    image: String.raw`![alt](a\(b\(c\)d\)e "Title")`,
    link: String.raw`[label](a\(b\(c\)d\)e "Title")`,
    definition: String.raw`[asset]: a\(b\(c\)d\)e "Title"`,
  },
  {
    name: "unmatched opening parenthesis",
    destination: "a(b",
    image: String.raw`![alt](a\(b "Title")`,
    link: String.raw`[label](a\(b "Title")`,
    definition: String.raw`[asset]: a\(b "Title"`,
  },
  {
    name: "unmatched closing parenthesis",
    destination: "a)b",
    image: String.raw`![alt](a\)b "Title")`,
    link: String.raw`[label](a\)b "Title")`,
    definition: String.raw`[asset]: a\)b "Title"`,
  },
  {
    name: "plain quote",
    destination: 'a"b',
    image: String.raw`![alt](a\"b "Title")`,
    link: String.raw`[label](a\"b "Title")`,
    definition: String.raw`[asset]: a\"b "Title"`,
  },
];

function paragraph(...content: PMNode[]) {
  return schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, content));
}

function singleInline(doc: PMNode): PMNode {
  expect(doc.childCount).toBe(1);
  expect(doc.child(0).type).toBe(schema.nodes.paragraph);
  expect(doc.child(0).childCount).toBe(1);
  return doc.child(0).child(0);
}

function expectStableRoundTrips(original: PMNode, markdown: string): PMNode {
  const snapshot = original.toJSON();
  const serialized = serializeMarkdown(original);
  expect(serialized).toBe(markdown);
  expect(original.toJSON()).toEqual(snapshot);
  const { doc } = parseMarkdown(serialized);
  expect(doc.eq(original)).toBe(true);
  expect(serializeMarkdown(doc)).toBe(markdown);
  const reparsed = parseMarkdown(serializeMarkdown(doc)).doc;
  expect(reparsed.eq(doc)).toBe(true);
  expect(serializeMarkdown(reparsed)).toBe(markdown);
  return doc;
}

function expectDefinition(doc: PMNode, destination: string) {
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
  expect(definitions[0].attrs).toEqual({ label: "asset", url: destination, title: "Title" });
  expect(definitions[0].marks).toEqual([]);
}

describe("rich destination delimiters", () => {
  it.each(destinations)("preserves an image address: $name", ({ destination, image: markdown }) => {
    const original = paragraph(schema.nodes.image.create({ src: destination, alt: "alt", title: "Title" }));
    const image = singleInline(expectStableRoundTrips(original, markdown));
    expect(image.type).toBe(schema.nodes.image);
    expect(image.isLeaf).toBe(true);
    expect(image.attrs).toEqual({ src: destination, alt: "alt", title: "Title" });
    expect(image.marks).toEqual([]);
  });

  it.each(destinations)("preserves a bracketed link address: $name", ({ destination, link: markdown }) => {
    const mark = schema.marks.link.create({ href: destination, title: "Title" });
    const original = paragraph(schema.text("label", [mark]));
    const link = singleInline(expectStableRoundTrips(original, markdown));
    expect(link.isText).toBe(true);
    expect(link.text).toBe("label");
    expect(link.marks).toEqual([mark]);
    expect(link.marks[0].attrs).toEqual({ href: destination, title: "Title" });
  });

  it.each(destinations)("preserves a definition address: $name", ({ destination, definition: markdown }) => {
    const original = schema.nodes.doc.create(
      null,
      schema.nodes.link_definition.create({ label: "asset", url: destination, title: "Title" }),
    );
    const snapshot = original.toJSON();
    const source = serializeMarkdown(original);
    expect(source).toBe(markdown);
    expect(original.toJSON()).toEqual(snapshot);
    const { doc } = parseMarkdown(source);
    expectDefinition(doc, destination);
    // Definition-only parsing may add an empty paragraph.
    const serialized = serializeMarkdown(doc);
    expect(serialized.trimEnd()).toBe(markdown);
    const reparsed = parseMarkdown(serialized).doc;
    expectDefinition(reparsed, destination);
    expect(reparsed.eq(doc)).toBe(true);
    expect(serializeMarkdown(reparsed)).toBe(serialized);
  });

  it("resolves an escaped definition onto a link and image and stably inlines both uses", () => {
    const destination = String.raw`ref\(asset\"end` + "\\";
    const title = String.raw`ref\*"quoted` + "\\";
    const definition = schema.nodes.link_definition.create({ label: "asset", url: destination, title });
    const definitionSource = String.raw`[asset]: ref\\\(asset\\\"end\\ "ref\\*\"quoted\\"`;
    const serialized = serializeMarkdown(schema.nodes.doc.create(null, definition));
    expect(serialized).toBe(definitionSource);
    const { doc } = parseMarkdown(serialized + "\n\nbefore [label][asset] and ![alt][asset] after");
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).eq(definition)).toBe(true);
    expect(doc.child(0).attrs).toEqual({ label: "asset", url: destination, title });
    const link = schema.marks.link.create({ href: destination, title });
    const expected = schema.nodes.doc.create(null, [
      definition,
      schema.nodes.paragraph.create(null, [
        schema.text("before "),
        schema.text("label", [link]),
        schema.text(" and "),
        schema.nodes.image.create({ src: destination, alt: "alt", title }),
        schema.text(" after"),
      ]),
    ]);
    expect(doc.eq(expected)).toBe(true);
    const content = doc.child(1);
    expect(content.childCount).toBe(5);
    expect(content.child(1).marks).toEqual([link]);
    expect(content.child(3).attrs).toEqual({ src: destination, alt: "alt", title });
    expect(content.child(3).marks).toEqual([]);
    const markdown =
      definitionSource +
      "\n\n" +
      String.raw`before [label](ref\\\(asset\\\"end\\ "ref\\*\"quoted\\") and ![alt](ref\\\(asset\\\"end\\ "ref\\*\"quoted\\") after`;
    expectStableRoundTrips(doc, markdown);
  });

  it("keeps distinct linked-image addresses and titles without touching surrounding text or marks", () => {
    const src = String.raw`images\("cover.png`;
    const href = "target\\)end\\";
    const imageTitle = String.raw`image\*"quoted`;
    const linkTitle = "link\\";
    const link = schema.marks.link.create({ href, title: linkTitle });
    const strong = schema.marks.strong.create();
    const em = schema.marks.em.create();
    const original = paragraph(
      schema.text("before "),
      schema.text("bold", [strong]),
      schema.text(" "),
      schema.nodes.image.create({ src, alt: "alt", title: imageTitle }, null, [link]),
      schema.text(" "),
      schema.text("after", [em]),
      schema.text(" end"),
    );
    const markdown = String.raw`before **bold** [![alt](images\\\(\"cover.png "image\\*\"quoted")](target\\\)end\\ "link\\") *after* end`;
    const content = expectStableRoundTrips(original, markdown).child(0);
    expect(content.childCount).toBe(7);
    expect(content.child(0).marks).toEqual([]);
    expect(content.child(1).marks).toEqual([strong]);
    expect(content.child(3).type).toBe(schema.nodes.image);
    expect(content.child(3).attrs).toEqual({ src, alt: "alt", title: imageTitle });
    expect(content.child(3).marks).toEqual([link]);
    expect(content.child(5).marks).toEqual([em]);
    expect(content.child(6).marks).toEqual([]);
  });

  it("keeps trailing backslashes before closing delimiters when titles are absent or empty", () => {
    const destination = "tail\\";
    const link = schema.marks.link.create({ href: destination });
    const original = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("label", [link]),
        schema.text(" "),
        schema.nodes.image.create({ src: destination, alt: "alt" }),
      ]),
      schema.nodes.link_definition.create({ label: "asset", url: destination }),
    ]);
    const markdown = String.raw`[label](tail\\) ![alt](tail\\)` + "\n\n" + String.raw`[asset]: tail\\`;
    expectStableRoundTrips(original, markdown);
    const emptyTitles = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("label", [schema.marks.link.create({ href: destination, title: "" })]),
        schema.text(" "),
        schema.nodes.image.create({ src: destination, alt: "alt", title: "" }),
      ]),
      schema.nodes.link_definition.create({ label: "asset", url: destination, title: "" }),
    ]);
    const snapshot = emptyTitles.toJSON();
    expect(serializeMarkdown(emptyTitles)).toBe(markdown);
    expect(emptyTitles.toJSON()).toEqual(snapshot);
    expect(parseMarkdown(serializeMarkdown(emptyTitles)).doc.eq(original)).toBe(true);
  });

  it("preserves destination String conversion without mutating attributes", () => {
    const original = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("label", [schema.marks.link.create({ href: 123 })]),
        schema.text(" "),
        schema.nodes.image.create({ src: 456, alt: "alt" }),
      ]),
      schema.nodes.link_definition.create({ label: "asset", url: 789 }),
    ]);
    const snapshot = original.toJSON();
    const serialized = serializeMarkdown(original);
    expect(serialized).toBe("[label](123) ![alt](456)\n\n[asset]: 789");
    expect(original.toJSON()).toEqual(snapshot);
    const expected = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("label", [schema.marks.link.create({ href: "123" })]),
        schema.text(" "),
        schema.nodes.image.create({ src: "456", alt: "alt" }),
      ]),
      schema.nodes.link_definition.create({ label: "asset", url: "789" }),
    ]);
    const { doc } = parseMarkdown(serialized);
    expect(doc.eq(expected)).toBe(true);
    expectStableRoundTrips(doc, serialized);
  });

  it("keeps an ordinary same-text absolute URL in angle autolink syntax", () => {
    const href = "https://example.test/path";
    const mark = schema.marks.link.create({ href });
    const original = paragraph(schema.text(href, [mark]));
    const link = singleInline(expectStableRoundTrips(original, "<https://example.test/path>"));
    expect(link.text).toBe(href);
    expect(link.marks).toEqual([mark]);
  });

  it("keeps a titled same-text absolute URL in bracketed syntax", () => {
    const href = "https://example.test/path";
    const mark = schema.marks.link.create({ href, title: "Title" });
    const original = paragraph(schema.text(href, [mark]));
    const markdown = '[https://example.test/path](https://example.test/path "Title")';
    const link = singleInline(expectStableRoundTrips(original, markdown));
    expect(link.text).toBe(href);
    expect(link.marks).toEqual([mark]);
  });
});
