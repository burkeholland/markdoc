import { describe, expect, it } from "vitest";
import type { Node } from "prosemirror-model";
import { parseMarkdown, extractHeadings } from "./parse";
import { serializeMarkdown } from "./serialize";
import { schema } from "./schema";

const SAMPLE = `# Project Notes

Welcome to the **Project Notes** document. Use this space to plan, track progress, and capture important decisions. See the [project roadmap](https://example.com/roadmap) for context.

## Goals
- Deliver value to our users
- Maintain code quality
- Ship consistently

## Tasks
- [x] Define project scope
- [x] Set up repository
- [ ] Implement core features
- [ ] Write documentation

## Example
Here's a simple JavaScript function:

\`\`\`js
function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`
`;

describe("parseMarkdown", () => {
  it("parses headings, lists, tasks and code", () => {
    const { doc, headings } = parseMarkdown(SAMPLE);
    expect(doc.childCount).toBe(9);
    expect(doc.child(0).type.name).toBe("heading");
    expect(doc.child(0).attrs.level).toBe(1);
    expect(headings.map((h) => h.text)).toEqual(["Project Notes", "Goals", "Tasks", "Example"]);
    expect(headings.map((h) => h.line)).toEqual([1, 5, 10, 16]);
    const tasks = doc.child(5);
    expect(tasks.type.name).toBe("bullet_list");
    expect(tasks.child(0).attrs.checked).toBe(true);
    expect(tasks.child(2).attrs.checked).toBe(false);
    const code = doc.child(8);
    expect(code.type.name).toBe("code_block");
    expect(code.attrs.language).toBe("js");
    expect(code.textContent).toBe("function greet(name) {\n  return `Hello, ${name}!`;\n}");
  });

  it("parses inline marks and links", () => {
    const { doc } = parseMarkdown("Some **bold** and *em* and ~~gone~~ and `code` and [link](https://x.y \"T\").");
    const p = doc.child(0);
    const marks = (i: number) => p.child(i).marks.map((m) => m.type.name);
    expect(p.child(1).text).toBe("bold");
    expect(marks(1)).toEqual(["strong"]);
    expect(marks(3)).toEqual(["em"]);
    expect(marks(5)).toEqual(["strikethrough"]);
    expect(marks(7)).toEqual(["code"]);
    expect(marks(9)).toEqual(["link"]);
    expect(p.child(9).marks[0].attrs).toEqual({ href: "https://x.y", title: "T" });
  });

  it("parses tables with alignment", () => {
    const { doc } = parseMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |\n");
    const table = doc.child(0);
    expect(table.type.name).toBe("table");
    expect(table.childCount).toBe(2);
    expect(table.child(0).child(0).type.name).toBe("table_header");
    expect(table.child(0).child(0).attrs.align).toBe("left");
    expect(table.child(0).child(1).attrs.align).toBe("right");
    expect(table.child(1).child(1).textContent).toBe("2");
  });

  it("keeps html, front matter, and link definitions", () => {
    const src = `---\ntitle: Hi\n---\n\n<div align="center">x</div>\n\n[ref]: https://example.com "Ex"\n\nSee [the ref][ref] and [^1].\n\n[^1]: A note.\n`;
    const { doc } = parseMarkdown(src);
    const types = [] as string[];
    doc.forEach((n) => types.push(n.type.name));
    expect(types).toEqual(["frontmatter", "html_block", "link_definition", "paragraph", "footnote_definition"]);
    expect(doc.child(0).textContent).toBe("title: Hi");
    const para = doc.child(3);
    expect(para.child(1).marks[0].attrs.href).toBe("https://example.com");
    expect(para.child(3).type.name).toBe("footnote_reference");
  });

  it("pads ragged table rows to the header width", () => {
    const { doc } = parseMarkdown("| a | b |\n|---|---|\n| 1 |\n");
    const table = doc.child(0);
    expect(table.child(1).childCount).toBe(2);
    expect(table.child(1).child(1).textContent).toBe("");
  });

  it("treats an empty task marker as an unchecked task item", () => {
    const { doc } = parseMarkdown("- [ ] Real task\n- [ ] \n");
    const list = doc.child(0);
    expect(list.child(1).attrs.checked).toBe(false);
    expect(list.child(1).textContent).toBe("");
    expect(serializeMarkdown(doc)).toBe("- [ ] Real task\n- [ ] ");
  });

  it("produces an empty paragraph for an empty document", () => {
    const { doc, map } = parseMarkdown("");
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).type.name).toBe("paragraph");
    expect(map.blocks).toEqual([{ from: 0, to: 0 }]);
  });

  it("extracts headings cheaply", () => {
    expect(extractHeadings("# A\n\ntext\n\n### C").map((h) => [h.level, h.text, h.id])).toEqual([
      [1, "A", "a"],
      [3, "C", "c"],
    ]);
  });
});

describe("source map", () => {
  it("maps source offsets to document positions and back", () => {
    const src = "# Title\n\nHello **world** there.\n";
    const { doc, map } = parseMarkdown(src);
    // "Title" starts at offset 2 in the source; in the doc it's at position 1 (inside heading).
    expect(map.srcToPm(2)).toBe(1);
    expect(map.srcToPm(7)).toBe(6);
    expect(map.pmToSrc(1)).toBe(2);
    expect(map.pmToSrc(6)).toBe(7);
    // "world" is at offset 17 in src. In the doc: heading (7) + paragraph open (1) + "Hello " (6) => 14.
    const worldSrc = src.indexOf("world");
    const worldPm = map.srcToPm(worldSrc);
    expect(doc.textBetween(worldPm, worldPm + 5)).toBe("world");
    expect(map.pmToSrc(worldPm)).toBe(worldSrc);
    // Positions in the middle of markdown syntax ("**") snap to the adjacent text.
    expect(map.srcToPm(worldSrc - 1)).toBe(worldPm);
  });

  it("reports block ranges for top-level nodes", () => {
    const src = "# A\n\npara one\n\n- x\n- y\n";
    const { map } = parseMarkdown(src);
    expect(map.blocks).toEqual([
      { from: 0, to: 3 },
      { from: 5, to: 13 },
      { from: 15, to: 22 },
    ]);
    expect(map.blockIndexAt(0)).toBe(0);
    expect(map.blockIndexAt(4)).toBe(1);
  });

  it("starts an indented paragraph's block range at its indentation, which the node keeps (task #475)", () => {
    // mdast starts the paragraph at "s"; the node text is " s", so the range must cover the space too,
    // or the binding doubles the indentation on the next keystroke and re-serializes the whole document.
    const { doc, map } = parseMarkdown("A\n\n s\n\n   three\n\n    code");
    expect(doc.child(1).textContent).toBe(" s");
    expect(doc.child(2).textContent).toBe("   three");
    expect(doc.child(3).type.name).toBe("code_block");
    expect(map.blocks.slice(0, 3)).toEqual([
      { from: 0, to: 1 },
      { from: 3, to: 5 },
      { from: 7, to: 15 },
    ]);
  });

  it("maps positions inside code blocks", () => {
    const src = "```js\nlet a = 1;\n```\n";
    const { doc, map } = parseMarkdown(src);
    const pm = map.srcToPm(src.indexOf("a = 1"));
    expect(doc.textBetween(pm, pm + 5)).toBe("a = 1");
    expect(map.pmToSrc(pm)).toBe(src.indexOf("a = 1"));
  });
});

describe("serializeMarkdown", () => {
  const roundTrip = (src: string) => serializeMarkdown(parseMarkdown(src).doc);

  it("round-trips the sample document (normalizing blank lines between blocks)", () => {
    const normalized = SAMPLE.replace(/^(## .*)\n(?=\S)/gm, "$1\n\n").trimEnd();
    expect(roundTrip(SAMPLE)).toBe(normalized);
    expect(roundTrip(normalized)).toBe(normalized);
  });

  it("round-trips ordered lists, blockquotes, and nested lists", () => {
    const src = "1. one\n2. two\n   - nested\n   - more\n3. three\n\n> quote\n> continues\n\n---";
    // Soft line breaks inside a paragraph are normalized to spaces.
    expect(roundTrip(src)).toBe(src.replace("> quote\n> continues", "> quote continues"));
  });

  it("round-trips loose lists", () => {
    const src = "- one\n\n- two\n\n- three";
    expect(roundTrip(src)).toBe(src);
  });

  it("round-trips tables", () => {
    const src = "| Name | Qty |\n|:-----|----:|\n| Apple | 3 |\n| Kiwi | 12 |";
    const out = roundTrip(src);
    expect(parseMarkdown(out).doc.eq(parseMarkdown(src).doc)).toBe(true);
    expect(out.split("\n")[1]).toMatch(/^\| :-+ \| -+: \|$/);
    expect(out.split("\n")[0]).toBe("| Name  | Qty |");
  });

  it("round-trips html, front matter, footnotes and link definitions", () => {
    const src = `---\ntitle: Hi\n---\n\n<div align="center">x</div>\n\n[ref]: https://example.com "Ex"\n\nSee [the ref](https://example.com "Ex") and [^1].\n\n[^1]: A note.`;
    expect(roundTrip(src)).toBe(src);
  });

  it("escapes characters that would change meaning", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text("2 * 3 = 6 and snake_case stays, but _this_ is escaped")]),
      schema.nodes.paragraph.create(null, [schema.text("# not a heading")]),
      schema.nodes.paragraph.create(null, [schema.text("1. not a list")]),
    ]);
    const out = serializeMarkdown(doc);
    expect(out).toBe("2 \\* 3 = 6 and snake_case stays, but \\_this\\_ is escaped\n\n\\# not a heading\n\n1\\. not a list");
    expect(parseMarkdown(out).doc.eq(doc)).toBe(true);
  });

  it("escapes every tilde of a one- or two-tilde run that touches text, since GFM strikes through with either (task #437)", () => {
    // Typing `~~typed~` in the preview, one key at a time: each intermediate doc must come back as the same plain text.
    for (const text of ["Target ~", "Target ~~", "Target ~~t", "Target ~~typed~", "~/.bashrc and ~/.zshrc", "about ~5 minutes"]) {
      const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, [schema.text(text)])]);
      const out = serializeMarkdown(doc);
      expect(parseMarkdown(out).doc.eq(doc), `${JSON.stringify(text)} -> ${JSON.stringify(out)}`).toBe(true);
    }
    const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, [schema.text("Target ~~typed~ and ~ alone and ~~~ three")])]);
    expect(serializeMarkdown(doc)).toBe("Target \\~\\~typed\\~ and ~ alone and ~~~ three");
  });

  it("keeps bullet and delimiter styles", () => {
    expect(roundTrip("* a\n* b")).toBe("* a\n* b");
    expect(roundTrip("1) a\n2) b")).toBe("1) a\n2) b");
    expect(roundTrip("3. a\n4. b")).toBe("3. a\n4. b");
  });

  it("serializes hard breaks and images", () => {
    const src = "line one\\\nline two ![alt](https://img/x.png \"T\")";
    expect(roundTrip(src)).toBe(src);
  });

  describe("hard break at the end of a quote line, list item or table cell (task #434)", () => {
    const p = (...content: ReturnType<typeof schema.text>[]) => schema.nodes.paragraph.create(null, content);
    const br = () => schema.nodes.hard_break.create();
    const stable = (src: string) => {
      const out = roundTrip(src);
      expect(out, src).toBe(src);
      expect(parseMarkdown(out).doc.eq(parseMarkdown(src).doc), `${src} keeps its shape`).toBe(true);
    };

    it("a break between two lines is a trailing backslash in quotes and list items, <br> in cells", () => {
      for (const src of ["> A quote line.\\\n> second line", "- one\\\n  two", "1. one\\\n   two", "- [ ] one\\\n  two", "> - a\\\n>   b"]) stable(src);
      stable("| a      | b   |\n| ------ | --- |\n| 1<br>2 | 3   |");
    });

    it("a break that ends the block (Shift+Enter before the next line is typed) is <br>, which reads back as the same node", () => {
      // CommonMark has no trailing hard break: `\` at the end of a paragraph is a literal backslash.
      const quote = schema.nodes.doc.create(null, [schema.nodes.blockquote.create(null, [p(schema.text("A quote line."), br())])]);
      expect(serializeMarkdown(quote)).toBe("> A quote line.<br>");
      expect(parseMarkdown("> A quote line.<br>").doc.eq(quote)).toBe(true);
      const item = schema.nodes.doc.create(null, [
        schema.nodes.bullet_list.create({ bullet: "-", tight: true }, [schema.nodes.list_item.create(null, [p(schema.text("one"), br())])]),
      ]);
      expect(serializeMarkdown(item)).toBe("- one<br>");
      expect(parseMarkdown("- one<br>").doc.eq(item)).toBe(true);
      const cell = parseMarkdown("| a | b |\n| --- | --- |\n| 1<br> | <br> |").doc;
      expect(cell.child(0).child(1).child(0).lastChild!.type.name).toBe("hard_break");
      expect(cell.child(0).child(1).child(1).childCount).toBe(1);
      expect(serializeMarkdown(cell)).toBe("| a     | b    |\n| ----- | ---- |\n| 1<br> | <br> |");
      // Typing after the break turns it into the backslash form.
      const typed = schema.nodes.doc.create(null, [schema.nodes.blockquote.create(null, [p(schema.text("A quote line."), br(), schema.text("second line"))])]);
      expect(serializeMarkdown(typed)).toBe("> A quote line.\\\n> second line");
      for (const src of ["A<br>", "A<br><br>", "> A<br>", "- a<br>\n- b", "A<br> ", "<br>A", "\\\nA", "> \\\n> A"]) stable(src);
    });

    it("keeps a <br> between text as inline HTML and a paragraph of breaks alone has no form", () => {
      expect(parseMarkdown("A<br>B").doc.child(0).child(1).type.name).toBe("html_inline");
      expect(parseMarkdown("<br>").doc.child(0).type.name).toBe("html_block");
      expect(serializeMarkdown(schema.nodes.doc.create(null, [p(br())]))).toBe("");
    });
  });

  describe("code fence length", () => {
    it.each([
      { name: "plain text", text: "const n = 1;", language: "ts", fenceLength: 3, expected: "```ts\nconst n = 1;\n```" },
      { name: "single and double backticks", text: "`one` ``two``", language: null, fenceLength: 3, expected: "```\n`one` ``two``\n```" },
      { name: "three-backtick line", text: "```", language: "md", fenceLength: 4, expected: "````md\n```\n````" },
      { name: "longest run before the last", text: "``````\n```\n````", language: null, fenceLength: 7, expected: "```````\n``````\n```\n````\n```````" },
      { name: "inline and indented runs", text: "left````right\n    ```", language: "text", fenceLength: 5, expected: "`````text\nleft````right\n    ```\n`````" },
      { name: "tildes", text: "~~~~\n~value~", language: null, fenceLength: 3, expected: "```\n~~~~\n~value~\n```" },
      { name: "one trailing newline", text: "```\n", language: "ts", fenceLength: 4, expected: "````ts\n```\n\n````" },
      { name: "two trailing newlines", text: "````\n\n", language: null, fenceLength: 5, expected: "`````\n````\n\n\n`````" },
      { name: "empty code", text: "", language: "js", fenceLength: 3, expected: "```js\n```" },
    ])("preserves the existing serializer policy for $name", ({ text, language, fenceLength, expected }) => {
      const original = schema.nodes.doc.create(null, [
        schema.nodes.code_block.create({ language }, text ? [schema.text(text)] : []),
      ]);
      const source = serializeMarkdown(original);
      expect(source).toBe(expected);
      const lines = source.split("\n");
      expect(lines[0].match(/^`+/)?.[0].length).toBe(fenceLength);
      expect(lines.at(-1)?.length).toBe(fenceLength);
      const { doc } = parseMarkdown(source);
      expect(doc.childCount).toBe(1);
      expect(doc.child(0).type.name).toBe("code_block");
      expect(doc.child(0).textContent).toBe(text);
      expect(doc.child(0).attrs.language).toBe(language);
      expect(doc.eq(original)).toBe(true);
    });
  });

  describe("trailing newlines in a fenced code block (task #434)", () => {
    const code = (text: string) => schema.nodes.doc.create(null, [schema.nodes.code_block.create({ language: "ts" }, text ? [schema.text(text)] : [])]);

    it("keeps 0, 1, 2 and 3 trailing newlines through serialize → parse", () => {
      for (const tail of ["", "\n", "\n\n", "\n\n\n"]) {
        const doc = code("const a = 1;" + tail);
        const md = serializeMarkdown(doc);
        expect(md, JSON.stringify(tail)).toBe("```ts\nconst a = 1;" + tail + "\n```");
        expect(parseMarkdown(md).doc.eq(doc), JSON.stringify(tail)).toBe(true);
        expect(roundTrip(md)).toBe(md);
      }
      expect(serializeMarkdown(code(""))).toBe("```ts\n```");
      expect(serializeMarkdown(code("\n"))).toBe("```ts\n\n\n```");
      expect(parseMarkdown("```ts\n\n\n```").doc.firstChild!.textContent).toBe("\n");
    });

    it("also inside a quote", () => {
      const src = "> ```\n> a\n> \n> ```";
      expect(roundTrip(src)).toBe(src);
      expect(parseMarkdown(src).doc.firstChild!.firstChild!.textContent).toBe("a\n");
    });
  });

  it("preserves trailing spaces in paragraphs", () => {
    expect(roundTrip("hello ")).toBe("hello ");
  });

  describe("a mark broken up by another mark right before whitespace (prosemirror-markdown 1.13.6, task #1363)", () => {
    // When an outer mark closes, the inner one has to close with it and reopen for the rest of its run. If that
    // rest starts with whitespace, the reopened delimiter must stay outside of it: `**f*oo**** bar*` reads back as
    // bold "f", bold-italic "oo" and the literal text "* bar*", so every save changed what the next load showed.
    // Markdown has no way to mark a space at that boundary, so the expected document carries it unmarked.
    const m = (text: string, ...names: string[]) =>
      schema.text(
        text,
        names.map((name) => (name === "link" ? schema.marks.link.create({ href: "https://x.y" }) : schema.marks[name].create())),
      );
    const para = (...content: ReturnType<typeof schema.text>[]) => schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, content)]);
    const cases: [name: string, doc: Node, expected: Node, markdown: string][] = [
      [
        "em opened inside strong and continuing after it (the upstream test case)",
        para(m("f", "strong"), m("oo", "strong", "em"), m(" bar", "em")),
        para(m("f", "strong"), m("oo", "strong", "em"), m(" "), m("bar", "em")),
        "**f*oo*** *bar*",
      ],
      [
        "strong broken by em ending before a space",
        para(m("f", "em"), m("oo", "em", "strong"), m(" bar", "strong")),
        para(m("f", "em"), m("oo", "em", "strong"), m(" "), m("bar", "strong")),
        "*f**oo*** **bar**",
      ],
      [
        "strong broken by a link ending before a space",
        para(m("f", "link"), m("oo", "link", "strong"), m(" bar", "strong")),
        para(m("f", "link"), m("oo", "link", "strong"), m(" "), m("bar", "strong")),
        "[f**oo**](https://x.y) **bar**",
      ],
      [
        "em opened inside strikethrough and continuing after it",
        para(m("f", "strikethrough"), m("oo", "strikethrough", "em"), m(" bar", "em")),
        para(m("f", "strikethrough"), m("oo", "strikethrough", "em"), m(" "), m("bar", "em")),
        "~~f*oo*~~ *bar*",
      ],
    ];

    it.each(cases)("%s", (_name, doc, expected, markdown) => {
      const out = serializeMarkdown(doc);
      const back = parseMarkdown(out).doc;
      // An orphan delimiter (`* bar*`, `** bar**`) is one the parser could not pair, so it survives as literal text.
      expect(back.textContent, out).toBe(doc.textContent);
      expect(back.eq(expected), out).toBe(true);
      expect(out).toBe(markdown);
      expect(roundTrip(out)).toBe(out);
    });

    it("a code mark is always innermost, so it never breaks the mark around it", () => {
      const doc = para(m("f", "strong"), m("oo", "strong", "code"), m(" bar", "strong"));
      expect(serializeMarkdown(doc)).toBe("**f`oo` bar**");
      expect(parseMarkdown("**f`oo` bar**").doc.eq(doc)).toBe(true);
    });
  });
});
