import { describe, expect, it } from "vitest";
import { PREVIEW_SOURCE_LIMIT, previewText } from "./preview-text";

// What someone without access sees in a link preview must be text the reader page shows as prose.
// Every row of the review of #2194 (anonymous og:description) plus the cases that already held.
describe("previewText hides what the document hides", () => {
  const rows: [string, string, string][] = [
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

  it.each(rows)("%s", (_, markdown, expected) => {
    const text = previewText(markdown);
    expect(text).toBe(expected);
    expect(text).not.toContain("SECRET");
  });

  const held: [string, string, string][] = [
    ["a one-line comment", "<!-- SECRET -->\n\nVisible opening line.", "Visible opening line."],
    ["YAML front matter", "---\nsecret: SECRET\n---\n\nVisible opening line.", "Visible opening line."],
    ["YAML front matter with a blank line", "---\na: 1\n\nsecret: SECRET\n---\n\nVisible opening line.", "Visible opening line."],
    ["a plain link", "Visible [text](https://example.test/x?token=SECRET) line.", "Visible text line."],
    ["an image, keeping its alt text", 'Visible ![a chart](https://example.test/c.png?token=SECRET "SECRET title") line.', "Visible a chart line."],
    ["the [//]: # comment trick", "[//]: # (SECRET note)\n\nVisible opening line.", "Visible opening line."],
    ["a footnote", "Visible line.[^1]\n\n[^1]: SECRET", "Visible line."],
  ];

  it.each(held)("%s", (_, markdown, expected) => {
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

  // The parser nests 4,000 quotes without recursing; reading its tree must not recurse either.
  it("reads quotes nested deeper than the call stack goes", () => {
    expect(previewText(`${">".repeat(4000)} Deep quote.`)).toBe("Deep quote.");
  }, 30_000);
});

/**
 * A document longer than the limit whose cut (after the last full line within it) falls right after
 * `beforeCut`: `head`, a code block that fills the space (code never shows), `beforeCut`, `afterCut`.
 */
function cutAfter(head: string, beforeCut: string, afterCut: string): string {
  const fill = PREVIEW_SOURCE_LIMIT - head.length - beforeCut.length - "```\n\n```\n\n".length;
  const doc = `${head}\`\`\`\n${"x".repeat(fill)}\n\`\`\`\n\n${beforeCut}${afterCut}`;
  expect(beforeCut.endsWith("\n")).toBe(true);
  expect(doc.lastIndexOf("\n", PREVIEW_SOURCE_LIMIT - 1) + 1).toBe(doc.length - afterCut.length);
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
