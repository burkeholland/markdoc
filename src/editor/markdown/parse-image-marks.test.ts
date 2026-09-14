import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { parseMarkdown } from "./parse";
import { schema } from "./schema";
import { serializeMarkdown } from "./serialize";

interface ImageAttrs {
  src: string;
  alt: string | null;
  title: string | null;
}

interface ExpectedMark {
  type: string;
  attrs: Record<string, string | null>;
}

const imageAttrs: ImageAttrs = { src: "image.png", alt: "alt", title: null };
const link: ExpectedMark = { type: "link", attrs: { href: "target", title: "Link" } };
const em: ExpectedMark = { type: "em", attrs: {} };
const strong: ExpectedMark = { type: "strong", attrs: {} };
const strike: ExpectedMark = { type: "strikethrough", attrs: {} };

function imagesIn(doc: PMNode): PMNode[] {
  const images: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type === schema.nodes.image) images.push(node);
  });
  return images;
}

function expectImage(image: PMNode, attrs: ImageAttrs, marks: ExpectedMark[]) {
  expect(image.type).toBe(schema.nodes.image);
  expect(image.isInline).toBe(true);
  expect(image.isLeaf).toBe(true);
  expect(image.isAtom).toBe(true);
  expect(image.nodeSize).toBe(1);
  expect(image.attrs).toEqual(attrs);
  expect(image.marks.map((mark) => mark.type.name)).toEqual(marks.map((mark) => mark.type));
  expect(image.marks.map((mark) => ({ type: mark.type.name, attrs: mark.attrs }))).toEqual(marks);
}

function expectOnlyImage(doc: PMNode, attrs: ImageAttrs, marks: ExpectedMark[]) {
  const images = imagesIn(doc);
  expect(images).toHaveLength(1);
  expectImage(images[0], attrs, marks);
}

describe("parsed image marks", () => {
  it("retains the enclosing direct link and both independent titles", () => {
    const { doc } = parseMarkdown('[![alt](image.png "Image")](target "Link")');
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).type).toBe(schema.nodes.paragraph);
    expect(doc.child(0).childCount).toBe(1);
    expectOnlyImage(doc, { src: "image.png", alt: "alt", title: "Image" }, [link]);
  });

  it.each([
    {
      name: "full image reference inside a direct link",
      source: '[![alt][asset]](target "Link")\n\n[asset]: image.png "Image"',
    },
    {
      name: "collapsed image reference inside a direct link",
      source: '[![alt][]](target "Link")\n\n[alt]: image.png "Image"',
    },
    {
      name: "shortcut image reference inside a direct link",
      source: '[![alt]](target "Link")\n\n[alt]: image.png "Image"',
    },
    {
      name: "inline image inside a link reference",
      source: '[![alt](image.png "Image")][destination]\n\n[destination]: target "Link"',
    },
    {
      name: "full image reference inside a link reference",
      source: '[![alt][asset]][destination]\n\n[asset]: image.png "Image"\n[destination]: target "Link"',
    },
    {
      name: "collapsed image reference inside a link reference",
      source: '[![alt][]][destination]\n\n[alt]: image.png "Image"\n[destination]: target "Link"',
    },
    {
      name: "shortcut image reference with case-insensitive nested resolution",
      source: '[![alt]][Destination]\n\n[ALT]: image.png "Image"\n[destination]: target "Link"',
    },
  ])("retains marks on $name", ({ source }) => {
    const { doc } = parseMarkdown(source);
    expect(doc.child(0).type).toBe(schema.nodes.paragraph);
    expect(doc.child(0).childCount).toBe(1);
    expectOnlyImage(doc, { src: "image.png", alt: "alt", title: "Image" }, [link]);
  });

  it.each([
    { source: "![alt](image.png)", attrs: imageAttrs },
    { source: "![](image.png)", attrs: { src: "image.png", alt: "", title: null } },
    { source: '![alt](image.png "")', attrs: { src: "image.png", alt: "alt", title: null } },
    { source: "![]()", attrs: { src: "", alt: "", title: null } },
    { source: "![alt][asset]\n\n[asset]: image.png", attrs: imageAttrs },
    { source: '![][asset]\n\n[asset]: image.png ""', attrs: { src: "image.png", alt: "", title: null } },
  ])("keeps unmarked image attributes for $source", ({ source, attrs }) => {
    expectOnlyImage(parseMarkdown(source).doc, attrs, []);
  });

  it.each([
    { source: "![alt][missing]", text: "![alt][missing]", marks: [] },
    { source: "![missing][]", text: "![missing][]", marks: [] },
    { source: "![missing]", text: "![missing]", marks: [] },
    { source: "**![alt][missing]**", text: "![alt][missing]", marks: [strong] },
    { source: '[![alt][missing]](target "Link")', text: "![alt][missing]", marks: [link] },
  ])("keeps unresolved syntax as marked or plain text for $source", ({ source, text, marks }) => {
    const { doc } = parseMarkdown(source);
    expect(imagesIn(doc)).toHaveLength(0);
    expect(doc.childCount).toBe(1);
    const paragraph = doc.child(0);
    expect(paragraph.type).toBe(schema.nodes.paragraph);
    expect(paragraph.childCount).toBe(1);
    expect(paragraph.child(0).isText).toBe(true);
    expect(paragraph.child(0).text).toBe(text);
    expect(paragraph.child(0).attrs).toEqual({});
    expect(paragraph.child(0).marks.map((mark) => ({ type: mark.type.name, attrs: mark.attrs }))).toEqual(marks);
  });

  it.each([
    { source: "*![alt](image.png)*", marks: [em] },
    { source: "**![alt](image.png)**", marks: [strong] },
    { source: "~~![alt](image.png)~~", marks: [strike] },
    { source: '[*![alt](image.png)*](target "Link")', marks: [link, em] },
    { source: '**[![alt](image.png)](target "Link")**', marks: [link, strong] },
    { source: '~~**[*![alt](image.png)*](target "Link")**~~', marks: [link, em, strong, strike] },
    { source: '***[~~![alt](image.png)~~](target "Link")***', marks: [link, em, strong, strike] },
    { source: "*outer _![alt](image.png)_ end*", marks: [em] },
    { source: "**outer __![alt](image.png)__ end**", marks: [strong] },
    {
      source: '~~**[*![alt][asset]*][destination]**~~\n\n[asset]: image.png\n[destination]: target "Link"',
      marks: [link, em, strong, strike],
    },
  ])("retains canonical accumulated marks for $source", ({ source, marks }) => {
    expectOnlyImage(parseMarkdown(source).doc, imageAttrs, marks);
  });

  it("keeps marked text exact without leaking image marks to differently marked or plain siblings", () => {
    const { doc } = parseMarkdown(
      'plain **bold ![strong](strong.png)** [*em ![linked](linked.png)*](target "Link")~~![gone][asset]~~![plain](plain.png) tail\n\n[asset]: gone.png "Image"',
    );
    const paragraph = doc.child(0);
    const linkMark = schema.marks.link.create({ href: "target", title: "Link" });
    const emMark = schema.marks.em.create();
    const strongMark = schema.marks.strong.create();
    const strikeMark = schema.marks.strikethrough.create();
    const expected = schema.nodes.paragraph.create(null, [
      schema.text("plain "),
      schema.text("bold ", [strongMark]),
      schema.nodes.image.create({ src: "strong.png", alt: "strong", title: null }, null, [strongMark]),
      schema.text(" "),
      schema.text("em ", [linkMark, emMark]),
      schema.nodes.image.create({ src: "linked.png", alt: "linked", title: null }, null, [linkMark, emMark]),
      schema.nodes.image.create({ src: "gone.png", alt: "gone", title: "Image" }, null, [strikeMark]),
      schema.nodes.image.create({ src: "plain.png", alt: "plain", title: null }),
      schema.text(" tail"),
    ]);
    expect(paragraph.eq(expected)).toBe(true);
    const images = imagesIn(doc);
    expect(images).toHaveLength(4);
    expectImage(images[0], { src: "strong.png", alt: "strong", title: null }, [strong]);
    expectImage(images[1], { src: "linked.png", alt: "linked", title: null }, [link, em]);
    expectImage(images[2], { src: "gone.png", alt: "gone", title: "Image" }, [strike]);
    expectImage(images[3], { src: "plain.png", alt: "plain", title: null }, []);
  });

  it.each([
    {
      name: "linked inline image after Unicode in one paragraph",
      source: "\u00e9\u{1f642} [![alt](image.png)](target) ![plain](plain.png)",
      positions: [5, 7],
      marks: [{ type: "link", attrs: { href: "target", title: null } }],
      segments: [
        { srcFrom: 5, srcTo: 22, pmFrom: 5, pmTo: 6 },
        { srcFrom: 32, srcTo: 51, pmFrom: 7, pmTo: 8 },
      ],
    },
    {
      name: "linked strong reference image after Unicode in two paragraphs",
      source: "\u{1f642}\n\n\u00e9 **[![alt][asset]](target)** ![plain](plain.png)\n\n[asset]: image.png",
      positions: [7, 9],
      marks: [{ type: "link", attrs: { href: "target", title: null } }, strong],
      segments: [
        { srcFrom: 9, srcTo: 22, pmFrom: 7, pmTo: 8 },
        { srcFrom: 34, srcTo: 53, pmFrom: 9, pmTo: 10 },
      ],
    },
    {
      name: "unmarked inline image after Unicode",
      source: "\u00e9\u{1f642} ![alt](image.png)",
      positions: [5],
      marks: [],
      segments: [{ srcFrom: 4, srcTo: 21, pmFrom: 5, pmTo: 6 }],
    },
  ])("preserves atom identity and exact source segments for $name", ({ source, positions, marks, segments }) => {
    const { doc, map } = parseMarkdown(source);
    const actualPositions: number[] = [];
    doc.descendants((node, pos) => {
      if (node.type === schema.nodes.image) actualPositions.push(pos);
    });
    expect(actualPositions).toEqual(positions);
    const images = imagesIn(doc);
    expect(images).toHaveLength(positions.length);
    expectImage(images[0], imageAttrs, marks);
    if (images.length === 2) {
      expectImage(images[1], { src: "plain.png", alt: "plain", title: null }, []);
    }
    expect(map.segments.filter((segment) => doc.nodeAt(segment.pmFrom)?.type === schema.nodes.image)).toEqual(segments);
    for (const segment of segments) {
      expect(map.srcToPm(segment.srcFrom)).toBe(segment.pmFrom);
      expect(map.srcToPm(segment.srcTo)).toBe(segment.pmTo);
      expect(map.pmToSrc(segment.pmFrom)).toBe(segment.srcFrom);
    }
  });

  it("serializes the basic linked image exactly and reparses its actual link mark", () => {
    const { doc } = parseMarkdown("[![alt](image.png)](target)");
    const source = serializeMarkdown(doc);
    expect(source).toBe("[![alt](image.png)](target)");
    const reparsed = parseMarkdown(source).doc;
    expectOnlyImage(doc, imageAttrs, [{ type: "link", attrs: { href: "target", title: null } }]);
    expectOnlyImage(reparsed, imageAttrs, [{ type: "link", attrs: { href: "target", title: null } }]);
    expect(reparsed.eq(doc)).toBe(true);
  });

  it.each([
    { source: 'before [![alt](image.png "Image")](target "Link") after', marks: [link] },
    { source: 'before [***![alt](image.png "Image")***](target "Link") after', marks: [link, em, strong] },
    { source: 'before ~~[**![alt](image.png "Image")**](target "Link")~~ after', marks: [link, strong, strike] },
  ])("round-trips image attributes, marks and surrounding text for $source", ({ source, marks }) => {
    const { doc } = parseMarkdown(source);
    const reparsed = parseMarkdown(serializeMarkdown(doc)).doc;
    const attrs = { src: "image.png", alt: "alt", title: "Image" };
    expectOnlyImage(doc, attrs, marks);
    expectOnlyImage(reparsed, attrs, marks);
    expect(doc.textContent).toBe("before  after");
    expect(reparsed.textContent).toBe("before  after");
    expect(reparsed.eq(doc)).toBe(true);
  });
});
