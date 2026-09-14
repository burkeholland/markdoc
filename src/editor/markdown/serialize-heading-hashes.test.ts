import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { parseMarkdown } from "./parse";
import { schema } from "./schema";
import { serializeMarkdown } from "./serialize";

const heading = (level: number, ...content: PMNode[]) => schema.nodes.heading.create({ level }, content);
const paragraph = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const document = (...blocks: PMNode[]) => schema.nodes.doc.create(null, blocks);
const code = (text: string) => schema.text(text, [schema.marks.code.create()]);
const strong = (text: string) => schema.text(text, [schema.marks.strong.create()]);
const em = (text: string) => schema.text(text, [schema.marks.em.create()]);
const link = (text: string) =>
  schema.text(text, [schema.marks.link.create({ href: "/guide#part", title: "Guide #" })]);
const image = () => schema.nodes.image.create({ src: "/image.png#part", alt: "Image #", title: "Title #" });

function expectStable(original: PMNode, expectedMarkdown: string) {
  original.check();
  const originalJSON = JSON.stringify(original.toJSON());
  let current = original;
  for (let cycle = 0; cycle < 3; cycle++) {
    const markdown = serializeMarkdown(current);
    expect(markdown).toBe(expectedMarkdown);
    current = parseMarkdown(markdown).doc;
    current.check();
    expect(current.eq(original)).toBe(true);
    expect(JSON.stringify(current.toJSON())).toBe(originalJSON);
    expect(JSON.stringify(original.toJSON())).toBe(originalJSON);
  }
}

describe("heading terminal hash fidelity", () => {
  it.each([
    [1, "# Title \\#"],
    [2, "## Title \\#"],
    [3, "### Title \\#"],
    [4, "#### Title \\#"],
    [5, "##### Title \\#"],
    [6, "###### Title \\#"],
  ] as const)("preserves level %i and its literal terminal hash", (level, markdown) => {
    expectStable(document(heading(level, schema.text("Title #"))), markdown);
  });

  it.each([
    ["two hashes", "Title ##", "## Title \\##"],
    ["long hash run", "Title ##########", "## Title \\##########"],
    ["hash only", "#", "## \\#"],
    ["hash run only", "###", "## \\###"],
    ["multiple ASCII spaces", "Title   ##", "## Title   \\##"],
    ["ASCII tab", "Title\t#", "## Title\t\\#"],
    ["mixed ASCII whitespace", "Title \t \t###", "## Title \t \t\\###"],
    ["supplementary content", "\u{1f680} #", "## \u{1f680} \\#"],
    ["combining content", "cafe\u0301 ##", "## cafe\u0301 \\##"],
    ["literal backslash before a space", "Title \\ #", "## Title \\\\ \\#"],
    ["literal backslashes before a tab", "Title \\\\\t##", "## Title \\\\\\\\\t\\##"],
    ["Markdown-looking plaintext", "[link](dest) *bold* `code` #", "## \\[link](dest) \\*bold\\* \\`code\\` \\#"],
    ["named entity plaintext", "&copy; &amp; #", "## \\&copy; \\&amp; \\#"],
    ["an earlier hash run", "Title # ##", "## Title # \\##"],
  ])("protects %s without changing the content", (_label, text, markdown) => {
    expectStable(document(heading(2, schema.text(text))), markdown);
  });

  it.each([
    ["ordinary heading", "Title", "## Title"],
    ["attached hash", "C#", "## C#"],
    ["attached hash run", "Title###", "## Title###"],
    ["hash then word", "#word", "## #word"],
    ["interior hash run", "Title ## suffix", "## Title ## suffix"],
    ["literal backslash touching a hash", "Title \\#", "## Title \\\\#"],
    ["plus only", "+", "## +"],
    ["plus marker and tab", "+\ttext", "## +\ttext"],
    ["NBSP before a hash", "Title\u00a0#", "## Title\u00a0#"],
    ["em space before hashes", "Title\u2003##", "## Title\u2003##"],
    ["narrow NBSP before a hash", "Title\u202f#", "## Title\u202f#"],
    ["non-ASCII whitespace after a hash", "Title #\u00a0suffix", "## Title #\u00a0suffix"],
  ])("keeps the prior source bytes for %s", (_label, text, markdown) => {
    expectStable(document(heading(2, schema.text(text))), markdown);
  });

  it.each([
    ["code", [code("Title #")], "# `Title #`"],
    ["strong", [strong("Title #")], "# **Title #**"],
    ["emphasis", [em("Title #")], "# *Title #*"],
    ["link", [link("Title #")], '# [Title #](/guide#part "Guide #")'],
    ["image", [image()], '# ![Image #](/image.png#part "Title #")'],
    ["plain hash then code", [schema.text("#"), code("##")], "# #`##`"],
    ["plain hash then strong", [schema.text("# "), strong("Title #")], "# # **Title #**"],
    ["plain hash then emphasis", [schema.text("# "), em("Title #")], "# # *Title #*"],
    ["plain hash then link", [schema.text("# "), link("#")], '# # [#](/guide#part "Guide #")'],
    ["plain hash then image", [schema.text("# "), image()], '# # ![Image #](/image.png#part "Title #")'],
    ["padded code with ticks", [code(" `#` ")], "# ``  `#`  ``"],
  ] satisfies [string, PMNode[], string][])("does not escape hashes protected by %s", (_label, content, markdown) => {
    expectStable(document(heading(1, ...content)), markdown);
  });

  it("preserves supported marks and image attributes before terminal plain hashes", () => {
    expectStable(
      document(
        heading(
          3,
          strong("Bold #"),
          schema.text(" "),
          em("Em #"),
          schema.text(" "),
          code("Code #"),
          schema.text(" "),
          link("Link #"),
          schema.text(" "),
          image(),
          schema.text(" ##"),
        ),
      ),
      '### **Bold #** *Em #* `Code #` [Link #](/guide#part "Guide #") ![Image #](/image.png#part "Title #") \\##',
    );
  });

  it("preserves code inside a link without changing either mark", () => {
    const marks = schema.marks.code.create().addToSet([
      schema.marks.link.create({ href: "/guide#part", title: "Guide #" }),
    ]);
    expectStable(document(heading(1, schema.text("#", marks))), '# [`#`](/guide#part "Guide #")');
  });

  it("preserves a terminal autolink and its fragment", () => {
    const href = "https://example.com/guide#part";
    expectStable(
      document(heading(1, schema.text(href, [schema.marks.link.create({ href })]))),
      "# <https://example.com/guide#part>",
    );
  });

  it("leaves an empty heading's opening marker and empty content alone", () => {
    expectStable(document(heading(1)), "# ");
  });

  it("does not alter prior headings, empty headings or neighboring paragraphs", () => {
    expectStable(
      document(
        paragraph("Before #"),
        heading(1, schema.text("Title #")),
        heading(2),
        heading(6, schema.text("###")),
        paragraph("After ##"),
      ),
      "Before #\n\n# Title \\#\n\n## \n\n###### \\###\n\nAfter ##",
    );
  });

  it("preserves heading and paragraph boundaries inside a quote", () => {
    expectStable(
      document(
        schema.nodes.blockquote.create(null, [
          paragraph("Before #"),
          heading(4, schema.text("Title ##")),
          heading(2),
          paragraph("After #"),
        ]),
      ),
      "> Before #\n>\n> #### Title \\##\n>\n> ## \n>\n> After #",
    );
  });

  it("preserves a heading inside a loose bullet list and its neighboring item", () => {
    expectStable(
      document(
        schema.nodes.bullet_list.create({ bullet: "-", tight: false }, [
          schema.nodes.list_item.create(null, [paragraph("Before #"), heading(2, schema.text("Title #"))]),
          schema.nodes.list_item.create(null, paragraph("After #")),
        ]),
      ),
      "- Before #\n\n  ## Title \\#\n\n- After #",
    );
  });

  it("preserves ordered-list attributes and a nested quote's heading prefix", () => {
    expectStable(
      document(
        schema.nodes.ordered_list.create(
          { start: 7, delimiter: ")", tight: false },
          schema.nodes.list_item.create(null, [
            paragraph("Before #"),
            schema.nodes.blockquote.create(null, [heading(3, schema.text("###")), paragraph("After #")]),
          ]),
        ),
      ),
      "7) Before #\n\n   > ### \\###\n   >\n   > After #",
    );
  });

  it("keeps trailing hashes in paragraphs and fenced code unchanged", () => {
    expectStable(
      document(
        paragraph("Title #"),
        schema.nodes.code_block.create(null, schema.text("# Title #\n###")),
        heading(1, schema.text("#")),
      ),
      "Title #\n\n```\n# Title #\n###\n```\n\n# \\#",
    );
  });

  it.each([
    ["spaces", "Title ##  ", "# Title \\##  "],
    ["tabs", "Title #\t\t", "# Title \\#\t\t"],
  ])("protects a closing run before trailing %s and preserves the existing whitespace restoration", (_label, text, markdown) => {
    expectStable(document(heading(1, schema.text(text))), markdown);
  });
});
