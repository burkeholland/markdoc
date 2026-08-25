import { describe, expect, it } from "vitest";
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
