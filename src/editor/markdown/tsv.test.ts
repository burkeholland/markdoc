import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./parse";
import { schema } from "./schema";
import { serializeMarkdown } from "./serialize";
import { parseTsv, tsvToMarkdownTable } from "./tsv";

const TSV = "Name\tQty\tPrice\nApple\t3\t1.20\nPear\t5\t0.80\n";

describe("parseTsv", () => {
  it("splits rows of equal tab count into trimmed cells", () => {
    expect(parseTsv(TSV)).toEqual([
      ["Name", "Qty", "Price"],
      ["Apple", "3", "1.20"],
      ["Pear", "5", "0.80"],
    ]);
    expect(parseTsv(" a \t b \r\n c \t d ")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("rejects a single line, lines without tabs and ragged rows", () => {
    expect(parseTsv("a\tb")).toBeNull();
    expect(parseTsv("a\tb\n")).toBeNull();
    expect(parseTsv("one\ntwo")).toBeNull();
    expect(parseTsv("a\tb\nc\td\te")).toBeNull();
    expect(parseTsv("a\tb\nc")).toBeNull();
  });

  it("keeps empty cells so a blank value stays in its column", () => {
    expect(parseTsv("a\t\tc\n\tb\t")).toEqual([
      ["a", "", "c"],
      ["", "b", ""],
    ]);
  });
});

describe("tsvToMarkdownTable", () => {
  it("renders a GFM table with the first row as header", () => {
    expect(tsvToMarkdownTable(TSV)).toBe(
      ["| Name  | Qty | Price |", "| ----- | --- | ----- |", "| Apple | 3   | 1.20  |", "| Pear  | 5   | 0.80  |"].join("\n"),
    );
  });

  it("escapes pipes and Markdown syntax inside cells", () => {
    expect(tsvToMarkdownTable("a|b\t*x*\nc\td")).toBe(["| a\\|b | \\*x\\* |", "| ---- | ----- |", "| c    | d     |"].join("\n"));
  });

  it("returns null for text that is not TSV", () => {
    expect(tsvToMarkdownTable("Name\tQty\tPrice")).toBeNull();
    expect(tsvToMarkdownTable("a\tb\nc\td\te")).toBeNull();
    expect(tsvToMarkdownTable("# Title\n\n- a")).toBeNull();
  });
});

describe("quoted TSV cells", () => {
  it.each([
    {
      name: "ordinary quoted fields",
      input: '"Name"\t"Qty"\n"Apple"\t"3"',
      rows: [["Name", "Qty"], ["Apple", "3"]],
    },
    {
      name: "doubled quotes and adjacent quoted fields",
      input: '"Say ""hi"""\t""""\n"""start"\t"end"""',
      rows: [['Say "hi"', '"'], ['"start', 'end"']],
    },
    {
      name: "embedded tabs",
      input: '"first\tlast"\tCount\n"one\ttwo\tthree"\t2',
      rows: [["first\tlast", "Count"], ["one\ttwo\tthree", "2"]],
    },
    {
      name: "mixed quoted and unquoted Unicode fields",
      input: '"caf\u00e9"\t\u65e5\u672c\t"say ""\u{1f34e}"""\n\u96ea\t"\u{1f600}"\tplain',
      rows: [["caf\u00e9", "\u65e5\u672c", 'say "\u{1f34e}"'], ["\u96ea", "\u{1f600}", "plain"]],
    },
    {
      name: "trimmed quoted contents with internal whitespace",
      input: '" \t Name \n "\t" Qty "\n"\n a \t b \n c \t"\t" \t\n "',
      rows: [["Name", "Qty"], ["a \t b \n c", ""]],
    },
    {
      name: "quoted empty and trailing cells",
      input: '""\t"b"\t""\n"x"\t""\t',
      rows: [["", "b", ""], ["x", "", ""]],
    },
    {
      name: "unquoted embedded quotes and backslashes",
      input: 'a"b\tc\\d\nsay "hi"\t\\n\\t\\"',
      rows: [['a"b', "c\\d"], ['say "hi"', '\\n\\t\\"']],
    },
    {
      name: "leading spaces before literal quotes",
      input: ' "a"\t b \n "unclosed\t d ',
      rows: [['"a"', "b"], ['"unclosed', "d"]],
    },
    {
      name: "unquoted empty columns and tab-containing empty records",
      input: "\na\t\tc\t\n\t\t\t\nx\t y \t\t\n\n",
      rows: [["a", "", "c", ""], ["", "", "", ""], ["x", "y", "", ""]],
    },
    {
      name: "quoted tables with newline-only padding",
      input: '\r\n\r"A"\t"B"\r\n"C"\t"D"\r\r\n',
      rows: [["A", "B"], ["C", "D"]],
    },
    {
      name: "a final quoted cell without a record terminator",
      input: 'A\tB\nC\t"D"',
      rows: [["A", "B"], ["C", "D"]],
    },
  ])("decodes $name", ({ input, rows }) => {
    expect(parseTsv(input)).toEqual(rows);
  });

  it.each(["\n", "\r\n", "\r"])("normalizes quoted header and body line endings %j", (ending) => {
    const input = `"Header${ending}continued"\tOther${ending}"first${ending}${ending}last"\tvalue${ending}`;
    expect(parseTsv(input)).toEqual([
      ["Header\ncontinued", "Other"],
      ["first\n\nlast", "value"],
    ]);
  });

  it.each([
    ["unexpected closing quote suffix", '"A"x\tB\nC\tD'],
    ["space after a closing quote", '"A" \tB\nC\tD'],
    ["backslash after a closing quote", '"A"\\\tB\nC\tD'],
    ["unterminated header", '"A\tB\nC\tD'],
    ["unterminated body after valid rows", 'A\tB\nC\tD\n"E\tF'],
    ["escaped quote without a closing quote", 'A\tB\n"C""\tD'],
    ["malformed final cell after valid rows", 'A\tB\nC\tD\nE\t"F"x'],
    ["ragged logical rows", 'A\tB\n"C\nD"\tE\tF'],
    ["short logical row with an embedded tab", 'A\tB\n"C\tD"'],
    ["single quoted row", '"A"\t"B"\n'],
    ["one logical row with a multiline cell", '"A\nB"\tC'],
    ["single column", '"A"\n"B"'],
    ["multiline single column", '"A\nB"\n"C\nD"'],
    ["only quoted embedded tabs", '"A\tB"\n"C\tD"'],
    ["a single multiline value with embedded tabs", '"A\tB\nC\tD"'],
    ["interior blank record", 'A\tB\n\n"C"\t"D"'],
    ["interior whitespace-only record", 'A\tB\n \n"C"\t"D"'],
    ["empty text", ""],
    ["newline-only padding", "\r\n\n\r"],
    ["comma-separated text", '"A","B"\n"C","D"'],
  ])("rejects %s without producing a partial table", (_name, input) => {
    expect(parseTsv(input)).toBeNull();
    expect(tsvToMarkdownTable(input)).toBeNull();
  });
});

describe("quoted TSV tables", () => {
  function expectTable(input: string, rows: string[][]) {
    const markdown = tsvToMarkdownTable(input);
    expect(markdown).not.toBeNull();
    if (markdown === null) throw new Error("Expected a TSV table");
    expect(markdown).toBe(markdown.trim());
    expect(markdown.split("\n")).toHaveLength(rows.length + 1);
    const { doc } = parseMarkdown(markdown);
    expect(doc.childCount).toBe(1);
    const table = doc.child(0);
    expect(table.type).toBe(schema.nodes.table);
    expect(table.childCount).toBe(rows.length);
    table.forEach((row, _rowOffset, rowIndex) => {
      expect(row.type).toBe(schema.nodes.table_row);
      expect(row.childCount).toBe(rows[rowIndex].length);
      row.forEach((cell, _cellOffset, columnIndex) => {
        const cellType = rowIndex === 0 ? schema.nodes.table_header : schema.nodes.table_cell;
        const content = rows[rowIndex][columnIndex].split("\n").flatMap((segment, index) => [
          ...(index > 0 ? [schema.nodes.hard_break.create()] : []),
          ...(segment ? [schema.text(segment)] : []),
        ]);
        expect(cell.eq(cellType.create(null, content))).toBe(true);
      });
    });
    return { markdown, doc };
  }

  it("removes transport quotes while keeping literal quotes and a tab in their cells", () => {
    const { markdown } = expectTable('"A"\t"B"\n"""x"""\t"c\td"\n', [["A", "B"], ['"x"', "c\td"]]);
    expect(markdown).toBe(['| A   | B   |', '| --- | --- |', '| "x" | c\td |'].join("\n"));
  });

  it("renders multiline headers and body cells as hard breaks, not additional rows", () => {
    const { markdown } = expectTable('"H\nI"\tB\n"C\nD"\tE\n', [["H\nI", "B"], ["C\nD", "E"]]);
    expect(markdown).toBe(["| H<br>I | B   |", "| ------ | --- |", "| C<br>D | E   |"].join("\n"));
  });

  it("keeps pipe, star and backslash escaping literal after decoding quotes", () => {
    const { markdown } = expectTable('"a|b"\t"*x*"\n"c\\d"\t"""q"""', [["a|b", "*x*"], ["c\\d", '"q"']]);
    expect(markdown).toBe(['| a\\|b | \\*x\\* |', '| ---- | ----- |', '| c\\\\d | "q"   |'].join("\n"));
  });

  it.each(["\n", "\r\n", "\r"])("keeps repeated hard breaks and tabs with line ending %j", (ending) => {
    expectTable(`"H${ending}I"\tOther${ending}"a\tb${ending}${ending}c"\t"say ""hi"""${ending}`, [
      ["H\nI", "Other"],
      ["a\tb\n\nc", 'say "hi"'],
    ]);
  });

  it("trims decoded contents without removing internal whitespace", () => {
    expectTable('" \t H \n "\t" Other "\n"\n a \t b \n c \t"\t" \t\n "', [
      ["H", "Other"],
      ["a \t b \n c", ""],
    ]);
  });

  it("preserves empty cells, trailing columns, blank padding and tab-containing rows", () => {
    expectTable('\n"A"\t""\tC\t\n\t\t\t\n""\t"B"\t\t\n\n', [
      ["A", "", "C", ""],
      ["", "", "", ""],
      ["", "B", "", ""],
    ]);
  });

  it("keeps mixed Unicode cells and ordinary unquoted quotes and backslashes literal", () => {
    expectTable('"caf\u00e9"\t\u65e5\u672c\na"b\t"say ""\u{1f34e}"""\n "c"\t\\n\\t', [
      ["caf\u00e9", "\u65e5\u672c"],
      ['a"b', 'say "\u{1f34e}"'],
      ['"c"', "\\n\\t"],
    ]);
  });

  it.each([
    {
      name: "ordinary quoted cells",
      input: '"A"\t"B"\n"""x"""\t"c\td"',
      rows: [["A", "B"], ['"x"', "c\td"]],
    },
    {
      name: "multiline and escaped Markdown cells",
      input: '"H\nI"\t"*x*"\n"a|b\nc\\d"\t"value"',
      rows: [["H\nI", "*x*"], ["a|b\nc\\d", "value"]],
    },
    {
      name: "empty columns",
      input: '"A"\t""\tC\n""\t"B"\t""',
      rows: [["A", "", "C"], ["", "B", ""]],
    },
  ])("reparses and serializes stable supported tables with $name", ({ input, rows }) => {
    const { markdown, doc } = expectTable(input, rows);
    const serialized = serializeMarkdown(doc).trim();
    expect(serialized).toBe(markdown);
    expect(parseMarkdown(serialized).doc.eq(doc)).toBe(true);
  });
});
