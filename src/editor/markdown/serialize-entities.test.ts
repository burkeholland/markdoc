import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { parseMarkdown } from "./parse";
import { schema } from "./schema";
import { serializeMarkdown } from "./serialize";

interface AttributeCase {
  name: string;
  destination: string | number;
  title?: string | number | null;
  image: string;
  link: string;
  definition: string;
}

const attributes: AttributeCase[] = [
  {
    name: "named references in the destination alone",
    destination: "&amp;/&copy;",
    title: "Title",
    image: String.raw`![alt](\&amp;/\&copy; "Title")`,
    link: String.raw`[label](\&amp;/\&copy; "Title")`,
    definition: String.raw`[asset]: \&amp;/\&copy; "Title"`,
  },
  {
    name: "named references in the title alone",
    destination: "target",
    title: "&amp;/&copy;",
    image: String.raw`![alt](target "\&amp;/\&copy;")`,
    link: String.raw`[label](target "\&amp;/\&copy;")`,
    definition: String.raw`[asset]: target "\&amp;/\&copy;"`,
  },
  {
    name: "decimal and both hex forms in the destination alone",
    destination: "&#65;/&#x41;/&#X41;",
    title: "Title",
    image: String.raw`![alt](\&#65;/\&#x41;/\&#X41; "Title")`,
    link: String.raw`[label](\&#65;/\&#x41;/\&#X41; "Title")`,
    definition: String.raw`[asset]: \&#65;/\&#x41;/\&#X41; "Title"`,
  },
  {
    name: "decimal and both hex forms in the title alone",
    destination: "target",
    title: "&#65; &#x41; &#X41;",
    image: String.raw`![alt](target "\&#65; \&#x41; \&#X41;")`,
    link: String.raw`[label](target "\&#65; \&#x41; \&#X41;")`,
    definition: String.raw`[asset]: target "\&#65; \&#x41; \&#X41;"`,
  },
  {
    name: "adjacent references",
    destination: "&copy;&#65;&#x41;&#X41;&amp;",
    title: "&amp;&copy;&#65;&#x41;&#X41;",
    image: String.raw`![alt](\&copy;\&#65;\&#x41;\&#X41;\&amp; "\&amp;\&copy;\&#65;\&#x41;\&#X41;")`,
    link: String.raw`[label](\&copy;\&#65;\&#x41;\&#X41;\&amp; "\&amp;\&copy;\&#65;\&#x41;\&#X41;")`,
    definition: String.raw`[asset]: \&copy;\&#65;\&#x41;\&#X41;\&amp; "\&amp;\&copy;\&#65;\&#x41;\&#X41;"`,
  },
  {
    name: "entity-like query paths and unknown names",
    destination: "assets/&unknown42;.png?q=&copy;&next=1",
    title: "unknown &unknown42;",
    image: String.raw`![alt](assets/\&unknown42;.png?q=\&copy;&next=1 "unknown \&unknown42;")`,
    link: String.raw`[label](assets/\&unknown42;.png?q=\&copy;&next=1 "unknown \&unknown42;")`,
    definition: String.raw`[asset]: assets/\&unknown42;.png?q=\&copy;&next=1 "unknown \&unknown42;"`,
  },
  {
    name: "one original backslash before an entity ampersand",
    destination: String.raw`a\&copy;`,
    title: String.raw`\&#65;`,
    image: String.raw`![alt](a\\\&copy; "\\\&#65;")`,
    link: String.raw`[label](a\\\&copy; "\\\&#65;")`,
    definition: String.raw`[asset]: a\\\&copy; "\\\&#65;"`,
  },
  {
    name: "repeated original backslashes before entity ampersands",
    destination: String.raw`a\\&amp;/b\\\&#x41;`,
    title: String.raw`\\&#X41;`,
    image: String.raw`![alt](a\\\\\&amp;/b\\\\\\\&#x41; "\\\\\&#X41;")`,
    link: String.raw`[label](a\\\\\&amp;/b\\\\\\\&#x41; "\\\\\&#X41;")`,
    definition: String.raw`[asset]: a\\\\\&amp;/b\\\\\\\&#x41; "\\\\\&#X41;"`,
  },
  {
    name: "nearby backslashes quotes and parentheses",
    destination: String.raw`a\("&copy;")b`,
    title: String.raw`say\("&copy;")`,
    image: String.raw`![alt](a\\\(\"\&copy;\"\)b "say\\(\"\&copy;\")")`,
    link: String.raw`[label](a\\\(\"\&copy;\"\)b "say\\(\"\&copy;\")")`,
    definition: String.raw`[asset]: a\\\(\"\&copy;\"\)b "say\\(\"\&copy;\")"`,
  },
  {
    name: "mixed Unicode and literal percent spellings",
    destination: "caf\u00e9/%26copy;%2f&copy;/\u{1f642}",
    title: "\u00e9 %26copy;%2F &copy; \u{1f642}",
    image: '![alt](caf\u00e9/%26copy;%2f\\&copy;/\u{1f642} "\u00e9 %26copy;%2F \\&copy; \u{1f642}")',
    link: '[label](caf\u00e9/%26copy;%2f\\&copy;/\u{1f642} "\u00e9 %26copy;%2F \\&copy; \u{1f642}")',
    definition: '[asset]: caf\u00e9/%26copy;%2f\\&copy;/\u{1f642} "\u00e9 %26copy;%2F \\&copy; \u{1f642}"',
  },
  {
    name: "ordinary text",
    destination: "target",
    title: "plain text",
    image: '![alt](target "plain text")',
    link: '[label](target "plain text")',
    definition: '[asset]: target "plain text"',
  },
  {
    name: "bare ampersands and ordinary query separators",
    destination: "path&a?x=1&next=2",
    title: "A & B &next=2",
    image: '![alt](path&a?x=1&next=2 "A & B &next=2")',
    link: '[label](path&a?x=1&next=2 "A & B &next=2")',
    definition: '[asset]: path&a?x=1&next=2 "A & B &next=2"',
  },
  {
    name: "references without semicolons",
    destination: "path/&copy/&#65/&#x41/&#X41",
    title: "&copy &#65 &#x41 &#X41",
    image: '![alt](path/&copy/&#65/&#x41/&#X41 "&copy &#65 &#x41 &#X41")',
    link: '[label](path/&copy/&#65/&#x41/&#X41 "&copy &#65 &#x41 &#X41")',
    definition: '[asset]: path/&copy/&#65/&#x41/&#X41 "&copy &#65 &#x41 &#X41"',
  },
  {
    name: "malformed numeric and named references",
    destination: "path/&#;/&#x;/&#XG;/&#-65;/&1name;/&two-words;",
    title: "&#; &#x; &#XG; &#-65; &1name; &two-words;",
    image: '![alt](path/&#;/&#x;/&#XG;/&#-65;/&1name;/&two-words; "&#; &#x; &#XG; &#-65; &1name; &two-words;")',
    link: '[label](path/&#;/&#x;/&#XG;/&#-65;/&1name;/&two-words; "&#; &#x; &#XG; &#-65; &1name; &two-words;")',
    definition: '[asset]: path/&#;/&#x;/&#XG;/&#-65;/&1name;/&two-words; "&#; &#x; &#XG; &#-65; &1name; &two-words;"',
  },
  {
    name: "percent-encoded references without literal ampersands",
    destination: "a%26copy;%26%2365;%2f",
    title: "%26copy;%26%2365;%2F",
    image: '![alt](a%26copy;%26%2365;%2f "%26copy;%26%2365;%2F")',
    link: '[label](a%26copy;%26%2365;%2f "%26copy;%26%2365;%2F")',
    definition: '[asset]: a%26copy;%26%2365;%2f "%26copy;%26%2365;%2F"',
  },
  {
    name: "null title",
    destination: "asset&copy;",
    title: null,
    image: String.raw`![alt](asset\&copy;)`,
    link: String.raw`[label](asset\&copy;)`,
    definition: String.raw`[asset]: asset\&copy;`,
  },
  {
    name: "empty title",
    destination: "asset&copy;",
    title: "",
    image: String.raw`![alt](asset\&copy;)`,
    link: String.raw`[label](asset\&copy;)`,
    definition: String.raw`[asset]: asset\&copy;`,
  },
  {
    name: "omitted title",
    destination: "asset&copy;",
    image: String.raw`![alt](asset\&copy;)`,
    link: String.raw`[label](asset\&copy;)`,
    definition: String.raw`[asset]: asset\&copy;`,
  },
  {
    name: "numeric attribute String coercion",
    destination: 123,
    title: 456,
    image: '![alt](123 "456")',
    link: '[label](123 "456")',
    definition: '[asset]: 123 "456"',
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

function expectRoundTrips(original: PMNode, markdown: string, expected = original, definitionOnly = false): PMNode {
  const snapshot = original.toJSON();
  const serialized = serializeMarkdown(original);
  expect(serialized).toBe(markdown);
  expect(original.toJSON()).toEqual(snapshot);
  const { doc } = parseMarkdown(serialized);
  let stableMarkdown = markdown;
  // Only definition-only documents may gain the parser's phantom empty paragraph.
  if (definitionOnly && doc.childCount === 2) {
    expected = schema.nodes.doc.create(null, [expected.child(0), schema.nodes.paragraph.create()]);
    stableMarkdown += "\n\n";
  }
  expect(doc.eq(expected)).toBe(true);
  expect(serializeMarkdown(doc)).toBe(stableMarkdown);
  const reparsed = parseMarkdown(serializeMarkdown(doc)).doc;
  expect(reparsed.eq(expected)).toBe(true);
  expect(serializeMarkdown(reparsed)).toBe(stableMarkdown);
  expect(original.toJSON()).toEqual(snapshot);
  return doc;
}

describe("rich attribute entity spellings", () => {
  it.each(attributes)("preserves image attributes: $name", ({ destination, title, image: markdown }) => {
    const original = paragraph(schema.nodes.image.create({ src: destination, alt: "alt", title }));
    const expectedAttrs = { src: String(destination), alt: "alt", title: title ? String(title) : null };
    const expected = paragraph(schema.nodes.image.create(expectedAttrs));
    const image = singleInline(expectRoundTrips(original, markdown, expected));
    expect(image.type).toBe(schema.nodes.image);
    expect(image.isLeaf).toBe(true);
    expect(image.attrs).toEqual(expectedAttrs);
    expect(image.marks).toEqual([]);
  });

  it.each(attributes)("preserves bracketed link attributes: $name", ({ destination, title, link: markdown }) => {
    const original = paragraph(schema.text("label", [schema.marks.link.create({ href: destination, title })]));
    const expectedAttrs = { href: String(destination), title: title ? String(title) : null };
    const mark = schema.marks.link.create(expectedAttrs);
    const expected = paragraph(schema.text("label", [mark]));
    const link = singleInline(expectRoundTrips(original, markdown, expected));
    expect(link.isText).toBe(true);
    expect(link.text).toBe("label");
    expect(link.marks).toEqual([mark]);
    expect(link.marks[0].attrs).toEqual(expectedAttrs);
  });

  it.each(attributes)("preserves definition attributes: $name", ({ destination, title, definition: markdown }) => {
    const original = schema.nodes.doc.create(
      null,
      schema.nodes.link_definition.create({ label: "asset", url: destination, title }),
    );
    const expectedAttrs = { label: "asset", url: String(destination), title: title ? String(title) : null };
    const expected = schema.nodes.doc.create(null, schema.nodes.link_definition.create(expectedAttrs));
    const doc = expectRoundTrips(original, markdown, expected, true);
    expect(doc.child(0).type).toBe(schema.nodes.link_definition);
    expect(doc.child(0).attrs).toEqual(expectedAttrs);
    expect(doc.child(0).marks).toEqual([]);
  });

  it("resolves a used reference onto both a link and image and stably inlines their attributes", () => {
    const destination = String.raw`ref\&copy;(&#65;).png`;
    const title = String.raw`ref\\&amp; "&#X41;"`;
    const definition = schema.nodes.link_definition.create({ label: "asset", url: destination, title });
    const definitionSource = String.raw`[asset]: ref\\\&copy;\(\&#65;\).png "ref\\\\\&amp; \"\&#X41;\""`;
    const original = schema.nodes.doc.create(null, definition);
    const snapshot = original.toJSON();
    const serialized = serializeMarkdown(original);
    expect(serialized).toBe(definitionSource);
    expect(original.toJSON()).toEqual(snapshot);
    const source = serialized + "\n\nbefore [label][asset] and ![alt][asset] after";
    const { doc } = parseMarkdown(source);
    const mark = schema.marks.link.create({ href: destination, title });
    const expected = schema.nodes.doc.create(null, [
      definition,
      schema.nodes.paragraph.create(null, [
        schema.text("before "),
        schema.text("label", [mark]),
        schema.text(" and "),
        schema.nodes.image.create({ src: destination, alt: "alt", title }),
        schema.text(" after"),
      ]),
    ]);
    expect(doc.eq(expected)).toBe(true);
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).attrs).toEqual({ label: "asset", url: destination, title });
    const content = doc.child(1);
    expect(content.childCount).toBe(5);
    expect(content.child(1).marks).toEqual([mark]);
    expect(content.child(1).marks[0].attrs).toEqual({ href: destination, title });
    expect(content.child(3).attrs).toEqual({ src: destination, alt: "alt", title });
    expect(content.child(3).marks).toEqual([]);
    const markdown =
      definitionSource +
      "\n\n" +
      String.raw`before [label](ref\\\&copy;\(\&#65;\).png "ref\\\\\&amp; \"\&#X41;\"") and ![alt](ref\\\&copy;\(\&#65;\).png "ref\\\\\&amp; \"\&#X41;\"") after`;
    expectRoundTrips(doc, markdown, expected);
  });

  it("preserves distinct nested linked-image attributes and surrounding strong em and plain siblings", () => {
    const src = String.raw`image\&copy;("&#65;").png`;
    const href = String.raw`target\\&amp;(&#x41;)`;
    const imageTitle = String.raw`image\&amp; "&#65;"`;
    const linkTitle = String.raw`link\\&#X41; ("&copy;")`;
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
    const markdown = String.raw`before **bold** [![alt](image\\\&copy;\(\"\&#65;\"\).png "image\\\&amp; \"\&#65;\"")](target\\\\\&amp;\(\&#x41;\) "link\\\\\&#X41; (\"\&copy;\")") *after* end`;
    const content = expectRoundTrips(original, markdown).child(0);
    expect(content.childCount).toBe(7);
    expect(content.child(0).text).toBe("before ");
    expect(content.child(0).marks).toEqual([]);
    expect(content.child(1).marks).toEqual([strong]);
    expect(content.child(2).marks).toEqual([]);
    expect(content.child(3).type).toBe(schema.nodes.image);
    expect(content.child(3).attrs).toEqual({ src, alt: "alt", title: imageTitle });
    expect(content.child(3).marks).toEqual([link]);
    expect(content.child(3).marks[0].attrs).toEqual({ href, title: linkTitle });
    expect(content.child(4).marks).toEqual([]);
    expect(content.child(5).marks).toEqual([em]);
    expect(content.child(6).text).toBe(" end");
    expect(content.child(6).marks).toEqual([]);
  });

  it("keeps an ordinary same-text absolute URL in angle autolink syntax", () => {
    const href = "https://example.test/path?x=1&next=2";
    const mark = schema.marks.link.create({ href });
    const original = paragraph(schema.text(href, [mark]));
    const link = singleInline(expectRoundTrips(original, "<https://example.test/path?x=1&next=2>"));
    expect(link.text).toBe(href);
    expect(link.marks).toEqual([mark]);
  });

  it("keeps a titled same-text absolute URL bracketed while preserving its entity-like title", () => {
    const href = "https://example.test/path";
    const title = String.raw`title\&copy; ("&#65;")`;
    const mark = schema.marks.link.create({ href, title });
    const original = paragraph(schema.text(href, [mark]));
    const markdown = String.raw`[https://example.test/path](https://example.test/path "title\\\&copy; (\"\&#65;\")")`;
    const link = singleInline(expectRoundTrips(original, markdown));
    expect(link.text).toBe(href);
    expect(link.marks).toEqual([mark]);
    expect(link.marks[0].attrs).toEqual({ href, title });
  });
});
