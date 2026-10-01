import { describe, expect, it } from "vitest";
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import type { ElementContent, RootContent } from "hast";
import { findUnrenderable } from "@/editor/markdown/renderable";
import { renderMarkdownFragment } from "./export/render-markdown";
import { PREVIEW_SOURCE_LIMIT, previewText } from "./preview-text";

// What someone without access sees in a link preview must be text the reader page shows as prose.
// Every row of the review of #2194 (anonymous og:description) plus the cases that already held.
const REVIEW_ROWS: [string, string, string][] = [
  ["a comment over several lines", "<!--\nSECRET do not share\n-->\n\nVisible opening line.", "Visible opening line."],
  ["a comment with > inside", "<!-- a > b SECRET -->\n\nVisible opening line.", "Visible opening line."],
  ["an inline comment over two lines", "Visible start <!-- SECRET\nstill hidden --> visible end.", "Visible start visible end."],
  ["TOML front matter", '+++\nsecret = "SECRET"\n+++\n\nVisible opening line.', "Visible opening line."],
  ["a link URL with parentheses", "Visible [wiki](https://en.wikipedia.org/wiki/Foo_(bar)?token=SECRET) line.", "Visible wiki line."],
  ["a link URL with an escaped )", "Visible [text](https://example.test/a\\)?token=SECRET) line.", "Visible text line."],
  ["a link URL on the next line", "Visible [text](\nhttps://example.test/x?token=SECRET) line.", "Visible text line."],
  ["a definition with its URL on the next line", "Visible [ref] line.\n\n[ref]:\n  https://example.test/x?token=SECRET", "Visible ref line."],
  ["a definition with its title on the next line", 'Visible [ref] line.\n\n[ref]: https://example.test/x\n  "SECRET internal"', "Visible ref line."],
  // An HTML block is hidden whole: its text cannot be told apart from its attributes without rendering it.
  ["a tag whose attributes span lines", '<div data-token="SECRET"\n  class="x">Visible opening line.</div>', ""],
];

const HELD: [string, string, string][] = [
  ["a one-line comment", "<!-- SECRET -->\n\nVisible opening line.", "Visible opening line."],
  ["YAML front matter", "---\nsecret: SECRET\n---\n\nVisible opening line.", "Visible opening line."],
  ["YAML front matter with a blank line", "---\na: 1\n\nsecret: SECRET\n---\n\nVisible opening line.", "Visible opening line."],
  ["a plain link", "Visible [text](https://example.test/x?token=SECRET) line.", "Visible text line."],
  ["an image, keeping its alt text", 'Visible ![a chart](https://example.test/c.png?token=SECRET "SECRET title") line.', "Visible a chart line."],
  ["the [//]: # comment trick", "[//]: # (SECRET note)\n\nVisible opening line.", "Visible opening line."],
  ["a footnote", "Visible line.[^1]\n\n[^1]: SECRET", "Visible line."],
];

describe("previewText hides what the document hides", () => {
  it.each(REVIEW_ROWS)("%s", (_, markdown, expected) => {
    const text = previewText(markdown);
    expect(text).toBe(expected);
    expect(text).not.toContain("SECRET");
  });

  it.each(HELD)("%s", (_, markdown, expected) => {
    const text = previewText(markdown);
    expect(text).toBe(expected);
    expect(text).not.toContain("SECRET");
  });

  it("drops inline tags and their attributes but keeps the text between them", () => {
    expect(previewText('Visible <span title="SECRET">inside</span> text.')).toBe("Visible inside text.");
  });

  it("leaves out an image alt that carries inline HTML", () => {
    expect(previewText("Visible ![a <!-- SECRET --> b](x.png) line.")).toBe("Visible line.");
  });

  it("hides front matter after a byte order mark", () => {
    expect(previewText("\uFEFF---\nsecret: SECRET\n---\n\nVisible opening line.")).toBe("Visible opening line.");
  });
});

describe("previewText reads prose", () => {
  it("takes paragraphs, list items, quotes and table cells in order, and skips headings, code and rules", () => {
    const md = [
      "# Title",
      "",
      "First *para* with `code` and &amp; an entity.",
      "",
      "- item **one**",
      "- [x] done",
      "",
      "> quoted",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```js",
      "const hidden = 1;",
      "```",
      "",
      "---",
      "",
      "Last.",
    ].join("\n");
    expect(previewText(md)).toBe("First para with code and & an entity. item one done quoted a b 1 2 Last.");
  });

  it("falls back to the headings when there is no prose", () => {
    expect(previewText("# Only a heading\n\n## And another\n")).toBe("Only a heading And another");
  });

  it("is empty for an empty document and for one the guard refuses", () => {
    expect(previewText("")).toBe("");
    expect(previewText("   \n\n")).toBe("");
    expect(previewText(`Visible ${"[a]".repeat(1001)}`)).toBe("");
  });

  it("is cut at 160 characters without splitting a character", () => {
    const words = previewText("word ".repeat(100));
    expect(words.length).toBeLessThanOrEqual(160);
    expect(words.startsWith("word word")).toBe(true);
    // A thumbs-up with a skin tone is four code units: it does not fit after 159 letters and is not split.
    expect(previewText(`${"a".repeat(159)}\u{1F44D}\u{1F3FD} tail`)).toBe("a".repeat(159));
  });

  it("keeps an image's alt text apart from the words next to it, as the page shows the image", () => {
    expect(previewText("![logo](l.png)Acme and ![a chart](c.png)")).toBe("logo Acme and a chart");
  });

  it("is empty when the guard refuses any part of the document: the reader page then shows none of it", () => {
    const doc = `Visible opening line.\n\n${"More words here.\n\n".repeat(300)}${"[a]".repeat(1001)}\n`;
    expect(doc.indexOf("[a]")).toBeGreaterThan(PREVIEW_SOURCE_LIMIT);
    expect(previewText(doc)).toBe("");
  });
  // Quotes nested deeper than the main thread's call stack are read on the worker: see document-metadata.test.ts.
});

// The parser keeps body cells past the header's columns; the reader page drops them (the re-review of #2194).
describe("previewText shows only the table cells the reader page shows", () => {
  it.each([
    ["an extra cell in a one-column table", "| Header |\n| --- |\n| Visible | SECRET_TABLE_2194 |", "Header Visible"],
    ["a third cell in a two-column table", "| A | B |\n| --- | --- |\n| 1 | 2 | SECRET_TABLE_2194 |", "A B 1 2"],
    ["an extra cell in a table in a quote", "> | Header |\n> | --- |\n> | Visible | SECRET_TABLE_2194 |", "Header Visible"],
  ])("%s", (_, markdown, expected) => {
    expect(previewText(markdown)).toBe(expected);
  });

  it("drops an extra cell in a table near the start of a document longer than it reads", () => {
    const doc = `| Header |\n| --- |\n| Visible | SECRET_TABLE_2194 |\n\n${"More words here.\n\n".repeat(300)}`;
    expect(doc.length).toBeGreaterThan(PREVIEW_SOURCE_LIMIT);
    const text = previewText(doc, 100_000);
    expect(text.startsWith("Header Visible More words here.")).toBe(true);
    expect(text).not.toContain("SECRET");
  });

  it("keeps each row's cells up to the header's columns, however the table is written", () => {
    expect(previewText("| a | b | c |\n| - | - | - |\n| 1 |\n| 2 | 3 |")).toBe("a b c 1 2 3");
    expect(previewText("a | b\n--- | ---\n1 | 2 | SECRET")).toBe("a b 1 2");
    expect(previewText("| a | b |\n| :- | -: |\n| 1 | 2 | SECRET |")).toBe("a b 1 2");
    expect(previewText("| a \\| b | c |\n| - | - |\n| 1 \\| 2 | 3 | SECRET |")).toBe("a | b c 1 | 2 3");
    expect(previewText("- | H |\n  | - |\n  | v | SECRET |")).toBe("H v");
    expect(previewText("| H |\n| - |\n| v | [SECRET](https://example.test/SECRET) | ![SECRET](x.png) | `SECRET` |")).toBe("H v");
  });

  it("reads a header and delimiter row that do not match as the paragraph the reader page shows", () => {
    expect(previewText("| a | b |\n| - |\n| 1 | 2 | 3 |")).toBe("| a | b | | - | | 1 | 2 | 3 |");
  });
});

/**
 * A document longer than the limit whose cut (after the last full line within it) falls right after
 * `beforeCut`: `head`, a code block that fills the space (code never shows), `beforeCut`, `afterCut`.
 */
function cutAfter(head: string, beforeCut: string, afterCut: string): string {
  const fill = PREVIEW_SOURCE_LIMIT - head.length - beforeCut.length - "```\n\n```\n\n".length;
  const doc = `${head}\`\`\`\n${"x".repeat(fill)}\n\`\`\`\n\n${beforeCut}${afterCut}`;
  if (!beforeCut.endsWith("\n") || doc.lastIndexOf("\n", PREVIEW_SOURCE_LIMIT - 1) + 1 !== doc.length - afterCut.length) {
    throw new Error(`The cut does not fall right after ${JSON.stringify(beforeCut)}`);
  }
  return doc;
}

describe("previewText on a document longer than it reads", () => {
  const head = "Visible opening line.\n\n";

  it("reads only the start", () => {
    const doc = `${head}${"More words here.\n\n".repeat(300)}SECRET past the limit.\n`;
    expect(doc.length).toBeGreaterThan(PREVIEW_SOURCE_LIMIT);
    const text = previewText(doc, 100_000);
    expect(text.startsWith("Visible opening line. More words here.")).toBe(true);
    expect(text).not.toContain("SECRET");
    expect(previewText(doc)).toHaveLength(160);
  });

  it("hides everything when front matter is still open at the cut", () => {
    // Blank lines inside front matter are fine, so without the rule its first entries would read as settled paragraphs.
    for (const start of ["---", "+++", "\uFEFF---"]) {
      const fence = start.replace("\uFEFF", "");
      const doc = `${start}\n${"key: SECRET value\n\n".repeat(300)}${fence}\n\nVisible opening line.\n`;
      expect(previewText(doc, 100_000), start).toBe("");
    }
  });

  it("leaves out a comment or code block still open at the cut, and everything after it", () => {
    expect(previewText(`${head}<!--\n${"SECRET line\n".repeat(500)}-->\n\nAfter.\n`, 100_000)).toBe("Visible opening line.");
    expect(previewText(`${head}\`\`\`\n${"const SECRET = 1;\n".repeat(300)}\`\`\`\n\nAfter.\n`, 100_000)).toBe("Visible opening line.");
    expect(previewText(cutAfter(head, "Intro.\n<!-- SECRET\n", "still SECRET -->\n\nAfter.\n"), 100_000)).toBe("Visible opening line. Intro.");
    expect(previewText(cutAfter(head, "Intro.\n\n```\nconst SECRET = 1;\n", "```\n\nAfter.\n"), 100_000)).toBe("Visible opening line. Intro.");
  });

  it("leaves out the block the cut falls in: an inline comment, link or definition title that closes past it", () => {
    expect(previewText(cutAfter(head, "More text <!-- SECRET\n", "still SECRET --> visible end.\n"), 100_000)).toBe("Visible opening line.");
    expect(previewText(cutAfter(head, "See [text](https://example.test/x?token=SECRET\n", ") now.\n"), 100_000)).toBe("Visible opening line.");
    expect(previewText(cutAfter(head, '[ref]: https://example.test/x "SECRET\n', 'title"\n'), 100_000)).toBe("Visible opening line.");
  });

  it("keeps the settled blocks of a quote or list the cut falls in", () => {
    expect(previewText(cutAfter(head, "> quoted\n>\n> More <!-- SECRET\n", "> SECRET -->\n"), 100_000)).toBe("Visible opening line. quoted");
    expect(previewText(cutAfter(head, "- one\n- two [x](https://example.test/?token=SECRET\n", ")\n"), 100_000)).toBe("Visible opening line. one");
  });

  it("leaves out a table the cut falls in, and drops the extra cells of a settled one", () => {
    expect(previewText(cutAfter(head, "| H |\n| - |\n| v |\n", "| w | SECRET |\n"), 100_000)).toBe("Visible opening line.");
    expect(previewText(cutAfter(head, "| H |\n| - |\n| v | SECRET |\n\nEnd.\n", "More.\n"), 100_000)).toBe("Visible opening line. H v");
  });

  it("leaves out a block a definition past the cut could change: a footnote call, or a ] that closed no link", () => {
    const definedPastCut: [string, string][] = [
      ["Visible [text][SECRET-label] line.\n\n", "[SECRET-label]: https://example.test/x\n"],
      ["Visible ![alt][SECRET-label] line.\n\n", "[SECRET-label]: https://example.test/x.png\n"],
      ["Visible line.[^SECRET]\n\n", "[^SECRET]: A note.\n"],
      ["| a | b |\n| - | - |\n| [x][SECRET] | 2 |\n\n", "[SECRET]: https://example.test/x\n"],
      // Defined, `[text][label]` is the link and "(SECRET-URL)" plain text; here `[label](SECRET-URL)` is the link.
      ["Intro [text][label](SECRET-URL) outro.\n\n", "[label]: https://example.test/x\n"],
      // Defined, `[^x]` is a footnote call shown as a number and "(SECRET-URL)" plain text.
      ["Visible [^x](SECRET-URL) line.\n\n", "[^x]: A note.\n"],
      ["Visible [text] line.\n\n", "[text]: https://example.test/?token=SECRET\n"],
    ];
    for (const [block, definition] of definedPastCut) {
      expect(previewText(cutAfter(`${block}Kept.\n\n`, "End.\n", definition), 100_000), block).toBe("Kept.");
    }
    // Headings show only without prose, and the only paragraph here ("End.") is the last block.
    expect(previewText(cutAfter("# Heading [^SECRET]\n\n## Kept\n\n", "End.\n", "[^SECRET]: A note.\n"), 100_000)).toBe("Kept");
  });

  it("does not show what the whole document hides when a link in it parses differently without a later definition", () => {
    // With `[b]` defined, `[b]` is the link, so the outer brackets link nothing and the <span> tag hides SECRET.
    const block = "See [a [b] c](x \"<span t='\") SECRET '> end.\n\n";
    const definition = "[b]: https://example.test/b\n";
    expect(previewText(`${block}${definition}`)).toBe("See [a b c](x \" end.");
    // Without it, the outer brackets are a link titled "<span t='" and SECRET would be plain text.
    expect(previewText(block)).toBe("See a [b] c SECRET '> end.");
    expect(previewText(cutAfter(`${block}Kept.\n\n`, "End.\n", definition), 100_000)).toBe("Kept.");
  });

  it("does not use a definition on the last line it reads, which a table past the cut can take over", () => {
    // Past the cut, `| --- |` makes the last line a table's header row, so the whole document defines no
    // `x<span t='`: the reader shows the brackets and hides SECRET inside the <span> tag.
    const blocks = ["Intro [text][x<span t='] SECRET '> outro.\n\n", "Intro ![alt [b][x<span t='] SECRET '>](https://example.test/i.png) outro.\n\n"];
    const lastLines: [string, string][] = [
      ["[x<span t=']: https://example.test/x\n", "| --- |\n"],
      ["[x<span t=']: https://example.test/x\r\n", "| --- |\r\n"],
      ["[x<span t=']:\nhttps://example.test/x\n", "| --- |\n"],
      ["> [x<span t=']: https://example.test/x\n", "> | --- |\n"],
    ];
    for (const block of blocks) {
      for (const [beforeCut, afterCut] of lastLines) {
        const whole = `${block}${beforeCut}${afterCut}`;
        expect(previewText(whole), whole).not.toContain("SECRET");
        expect(previewText(cutAfter(`${block}Kept.\n\n`, beforeCut, afterCut), 100_000), whole).toBe("Kept.");
      }
    }
  });

  it("keeps using a definition above the last line it reads", () => {
    const doc = cutAfter("See [the guide][g].\n\n[g]: https://example.test/g\n\n", "End.\n", "More.\n");
    expect(previewText(doc, 100_000)).toBe("See the guide.");
    const lastLine = cutAfter("See [the guide][g].\n\nKept.\n\n", "[g]: https://example.test/g\n", "More.\n");
    expect(previewText(lastLine, 100_000)).toBe("Kept.");
  });

  it("keeps blocks whose links close whatever is defined later", () => {
    const doc = cutAfter("See [the docs](https://example.test/?token=SECRET) and [the guide][g].\n\n[g]: https://example.test/g\n\n", "End.\n", "[docs]: https://example.test/d\n");
    expect(previewText(doc, 100_000)).toBe("See the docs and the guide.");
  });

  it("cuts at a carriage return too, and shows nothing when the first line alone is longer than it reads", () => {
    const doc = `Visible opening line.\r\r${"More words here.\r\r".repeat(300)}`;
    expect(previewText(doc, 100_000).startsWith("Visible opening line. More words here.")).toBe(true);
    expect(previewText(`Visible ${"word ".repeat(1000)}\n\nNext.\n`)).toBe("");
  });
});

describe("previewText on a whole document", () => {
  it("resolves references exactly as the reader does", () => {
    expect(previewText("Visible [text][SECRET-label] line.\n\n[SECRET-label]: https://example.test/x")).toBe("Visible text line.");
    expect(previewText("Visible [text][] line.\n\n[text]: https://example.test/?token=SECRET")).toBe("Visible text line.");
    // Defined nowhere: the reader shows the brackets and the link text, and hides the URL.
    expect(previewText("Intro [text][label](https://example.test/?token=SECRET) outro.")).toBe("Intro [text]label outro.");
    expect(previewText("Visible [^x](https://example.test/?token=SECRET) line.")).toBe("Visible ^x line.");
  });
});

const htmlParser = unified().use(rehypeParse, { fragment: true });
/** Elements the page shows inline, running into the words next to them; every other element stands apart. */
const READER_INLINE: ReadonlySet<string> = new Set(["a", "em", "strong", "del", "code", "span", "input"]);

/**
 * The words the reader page shows for `markdown`, in order: the text of the HTML the reader's own renderer
 * builds, parsed back, with each image as its alt text. Footnote numbers are left out: they run into the
 * word before them, and a preview never shows them.
 */
async function readerWords(markdown: string): Promise<string[]> {
  // The reader page shows a note in place of a document the guard refuses (`renderMarkdownBody`).
  if (findUnrenderable(markdown)) return [];
  const { html } = await renderMarkdownFragment(markdown, { assetBaseUrl: "" });
  let text = "";
  const read = (nodes: readonly (RootContent | ElementContent)[]) => {
    for (const node of nodes) {
      if (node.type === "text") text += node.value;
      if (node.type !== "element" || node.tagName === "sup") continue;
      if (node.tagName === "img") {
        text += ` ${String(node.properties.alt ?? "")} `;
      } else if (READER_INLINE.has(node.tagName)) {
        read(node.children);
      } else {
        text += " ";
        read(node.children);
        text += " ";
      }
    }
  };
  read(htmlParser.parse(html).children);
  return text.split(/\s+/).filter(Boolean);
}

const HEAD = "Visible opening line.\n\n";

/** Every case above and more, from the review rows to the cut: what a preview shows must be on the page. */
const CORPUS: [string, string][] = [
  ...[...REVIEW_ROWS, ...HELD].map(([name, markdown]): [string, string] => [name, markdown]),
  ["inline tags", 'Visible <span title="SECRET">inside</span> <b>bold</b> <!-- SECRET --> <?SECRET?> <![CDATA[SECRET]]> <!SECRET> end.'],
  ["an alt with a comment", "Visible ![a <!-- SECRET --> b](x.png) line."],
  ["front matter after a byte order mark", "\uFEFF---\nsecret: SECRET\n---\n\nVisible opening line."],
  ["an extra cell in a one-column table", "| Header |\n| --- |\n| Visible | SECRET_TABLE_2194 |"],
  ["a third cell in a two-column table", "| A | B |\n| --- | --- |\n| 1 | 2 | SECRET_TABLE_2194 |"],
  ["an extra cell in a table in a quote", "> | Header |\n> | --- |\n> | Visible | SECRET_TABLE_2194 |"],
  ["an extra cell in a table near the start of a long document", `| Header |\n| --- |\n| Visible | SECRET_TABLE_2194 |\n\n${"More words here.\n\n".repeat(300)}`],
  ["rows with fewer cells", "| a | b | c |\n| - | - | - |\n| 1 |\n| 2 | 3 |"],
  ["a table without outer pipes", "a | b\n--- | ---\n1 | 2 | SECRET"],
  ["a delimiter row that reads as a list item", "a | b\n- | -\n1 | 2 | 3"],
  ["an aligned table", "| a | b |\n| :- | -: |\n| 1 | 2 | SECRET |"],
  ["escaped pipes", "| a \\| b | c |\n| - | - |\n| 1 \\| 2 | 3 | SECRET |"],
  ["a table in a list item", "- | H |\n  | - |\n  | v | SECRET |"],
  ["a table in a quote in a list", "- > | H |\n  > | - |\n  > | v | SECRET |"],
  ["extra cells holding a link, an image and code", "| H |\n| - |\n| v | [SECRET](https://example.test/SECRET) | ![SECRET](x.png) | `SECRET` |"],
  ["an empty header cell", "| |\n| - |\n| x | SECRET |"],
  ["a comment in a cell", "| H |\n| - |\n| a <!-- SECRET --> b |"],
  ["a footnote in a cell", "| H |\n| - |\n| a[^1] |\n\n[^1]: note"],
  ["a row without pipes after a table", "| H | I |\n| - | - |\n| v | w |\nplain row\n\nAfter."],
  ["a header and delimiter row that do not match", "| a | b |\n| - |\n| 1 | 2 | 3 |"],
  ["a footnote in a sentence", "Text[^a] more.\n\n[^a]: Footnote SECRET text."],
  ["a footnote with an indented body", "Text[^a].\n\n[^a]:\n    Indented SECRET body."],
  ["a footnote defined first", "[^a]: Defined first SECRET\n\nText[^a]."],
  ["an unreferenced footnote", "Text.\n\n[^u]: Unreferenced SECRET"],
  ["a footnote holding a table", "Text[^a].\n\n[^a]: Note\n\n    | H |\n    | - |\n    | v | SECRET |"],
  ["undefined footnote calls", "Visible [^x] and [^y](https://example.test/?token=SECRET) line."],
  ["a script block", "<script>SECRET()</script>\n\nVisible."],
  ["a pre block", "<pre>\nSECRET\n\n</pre>\n\nVisible."],
  ["a style block", "<style>p { /* SECRET */ }</style>\n\nVisible."],
  ["a textarea block", "<textarea>\nSECRET\n\n</textarea>\n\nVisible."],
  ["a processing instruction", "<?php echo 'SECRET'; ?>\n\nVisible."],
  ["a declaration", "<!DOCTYPE SECRET>\n\nVisible."],
  ["a CDATA section", "<![CDATA[\nSECRET\n]]>\n\nVisible."],
  ["a div block", "<div>\nSECRET\n</div>\n\nVisible."],
  ["details with Markdown inside", "<details>\n<summary>SECRET summary</summary>\n\nVisible inside details.\n\n</details>"],
  ["a custom tag alone on its line", '<custom-tag data-x="SECRET">\n\nVisible.'],
  ["a closing tag block", "</div>\nSECRET\n\nVisible."],
  ["autolinks", "See <https://example.test/visible-path> and <visible@example.test> and www.example.test/path and https://example.test/bare now."],
  ["full, collapsed and shortcut references", '[full][ref], [collapsed][] and [shortcut].\n\n[ref]: https://example.test/SECRET\n[collapsed]: https://example.test/SECRET "SECRET"\n[shortcut]: <https://example.test/SECRET>'],
  ["an image in a link", '[![alt text](i.png "SECRET")](https://example.test/SECRET) after.'],
  ["an image reference", '![alt text][img] after.\n\n[img]: https://example.test/SECRET.png "SECRET"'],
  ["a link with a title", 'A [link](https://example.test/SECRET "SECRET title") here.'],
  ["an angle-bracket destination", "A [link](<https://example.test/a b SECRET>) here."],
  ["nested brackets", "See [a [b] c](https://example.test/SECRET) end."],
  ["setext headings", "Title\n=====\n\nBody text.\n\nSub\n---\n\nMore."],
  ["task lists", "- [ ] open task\n- [x] done task\n  - [ ] nested task\n\n1. [x] numbered"],
  ["a loose list", "- one\n\n- two\n\n  second paragraph\n- three"],
  ["a tight list item with a code block and comments", "- a\n  ```\n  SECRET\n  ```\n- b <!-- SECRET -->\n- c\n  <!-- SECRET -->\n  d"],
  ["CRLF line endings", "First line.\r\n\r\n- item\r\n\r\n> quote\r\n\r\n| a |\r\n| - |\r\n| 1 | SECRET |\r\n"],
  ["entities", "&copy; &#169; &#xA9; &nbsp;x &amp;lt; &unknown; &#0; end"],
  ["hard breaks", "one  \ntwo\\\nthree"],
  ["emphasis and strikethrough", "*em* **strong** ~~gone~~ ***both*** _u_ intra**word**s"],
  ["inline code", "Run `npm <!-- test -->` and ``a ` b`` now."],
  ["[//]: # variants", '[//]: # "SECRET"\n[//]: <> (SECRET)\n[comment]: <> (SECRET)\n\nVisible.'],
  ["only headings", "# One\n\n## Two\n\n### Three"],
  ["only hidden text", "<!-- SECRET -->\n\n---\n\n```\nSECRET\n```\n\n[x]: https://example.test/SECRET"],
  ["an indented code block", "Para.\n\n    SECRET code\n\nAfter."],
  ["a rule and a quote holding a list", "Para.\n\n***\n\n> - a\n>   b\n> - c"],
  ["a heading with closing hashes", "# Title #\n\nBody."],
  ["a guard refusal", `Visible ${"[a]".repeat(1001)}`],
  ["a guard refusal past the cut", `${HEAD}${"More words here.\n\n".repeat(300)}${"[a]".repeat(1001)}\n`],
  ["a comment open at the cut", `${HEAD}<!--\n${"SECRET line\n".repeat(500)}-->\n\nAfter.\n`],
  ["a code block open at the cut", `${HEAD}\`\`\`\n${"const SECRET = 1;\n".repeat(300)}\`\`\`\n\nAfter.\n`],
  ["front matter open at the cut", `---\n${"key: SECRET value\n\n".repeat(300)}---\n\nVisible opening line.\n`],
  ["a comment opening at the cut", cutAfter(HEAD, "Intro.\n<!-- SECRET\n", "still SECRET -->\n\nAfter.\n")],
  ["an inline comment open at the cut", cutAfter(HEAD, "More text <!-- SECRET\n", "still SECRET --> visible end.\n")],
  ["a link open at the cut", cutAfter(HEAD, "See [text](https://example.test/x?token=SECRET\n", ") now.\n")],
  ["a definition title open at the cut", cutAfter(HEAD, '[ref]: https://example.test/x "SECRET\n', 'title"\n')],
  ["a quote the cut falls in", cutAfter(HEAD, "> quoted\n>\n> More <!-- SECRET\n", "> SECRET -->\n")],
  ["a list the cut falls in", cutAfter(HEAD, "- one\n- two [x](https://example.test/?token=SECRET\n", ")\n")],
  ["a table the cut falls in", cutAfter(HEAD, "| H |\n| - |\n| v |\n", "| w | SECRET |\n")],
  ["a table before the cut", cutAfter(HEAD, "| H |\n| - |\n| v | SECRET |\n\nEnd.\n", "More.\n")],
  ["a footnote defined past the cut", cutAfter("Visible line.[^SECRET]\n\nKept.\n\n", "End.\n", "[^SECRET]: A note.\n")],
  ["a reference defined past the cut", cutAfter("Visible [text][SECRET-label] line.\n\nKept.\n\n", "End.\n", "[SECRET-label]: https://example.test/x\n")],
  ["a table taking over a definition past the cut", cutAfter("Intro [text][x<span t='] SECRET '> outro.\n\nKept.\n\n", "[x<span t=']: https://example.test/x\n", "| --- |\n")],
  ["a link that parses differently once defined", cutAfter("See [a [b] c](x \"<span t='\") SECRET '> end.\n\nKept.\n\n", "End.\n", "[b]: https://example.test/b\n")],
  ["a heading with a footnote defined past the cut", cutAfter("# Heading [^SECRET]\n\n## Kept\n\n", "End.\n", "[^SECRET]: A note.\n")],
  ["carriage returns", `Visible opening line.\r\r${"More words here.\r\r".repeat(300)}`],
  ["a first line longer than the cut", `Visible ${"word ".repeat(1000)}\n\nNext.\n`],
];

// The reader page is built by the real renderer; each word a preview shows must be there, in the same order.
describe("previewText shows only words the reader page shows", () => {
  it.each(CORPUS)("%s", async (_, markdown) => {
    const preview = previewText(markdown, 100_000);
    const reader = await readerWords(markdown);
    let from = 0;
    for (const word of preview.split(" ").filter(Boolean)) {
      const at = reader.indexOf(word, from);
      expect(at, `"${word}" of "${preview}" is not on the page after: ${reader.slice(from, from + 40).join(" ")}`).toBeGreaterThanOrEqual(0);
      from = at + 1;
    }
    expect(preview.startsWith(previewText(markdown))).toBe(true);
  });
});
