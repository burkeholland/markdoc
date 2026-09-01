import { describe, expect, it } from "vitest";
import { FORMAT_BY_EXTENSION, IMPORT_ACCEPT, IMPORT_EXTENSIONS, IMPORT_EXTENSIONS_LIST, fileExtension, importFormatFor, listInProse } from "./import-extensions";

const EIGHT = [".md", ".markdown", ".mdown", ".mkd", ".txt", ".text", ".html", ".htm"];

describe("import extensions", () => {
  it("lists the eight importable extensions in map order", () => {
    expect(IMPORT_EXTENSIONS).toEqual(EIGHT);
    expect(IMPORT_EXTENSIONS).toEqual(Object.keys(FORMAT_BY_EXTENSION));
  });

  it("names every extension in the 415 sentence as a whole token", () => {
    // Whole tokens, so ".md" is not satisfied by ".mdown" nor ".htm" by ".html".
    const listed = IMPORT_EXTENSIONS_LIST.split(/[\s,]+/);
    for (const ext of IMPORT_EXTENSIONS) expect(listed, `sentence lists ${ext}`).toContain(ext);
    expect(IMPORT_EXTENSIONS_LIST).toBe("only .md, .markdown, .mdown, .mkd, .txt, .text, .html and .htm files can be imported");
    // The dashboard toast is the same sentence with a capital.
    expect(`${IMPORT_EXTENSIONS_LIST[0].toUpperCase()}${IMPORT_EXTENSIONS_LIST.slice(1)}.`).toBe(
      "Only .md, .markdown, .mdown, .mkd, .txt, .text, .html and .htm files can be imported.",
    );
  });

  it("joins a list in prose without an Oxford comma", () => {
    expect(listInProse([])).toBe("");
    expect(listInProse([".md"])).toBe(".md");
    expect(listInProse([".md", ".txt"])).toBe(".md and .txt");
    expect(listInProse([".md", ".txt", ".html"])).toBe(".md, .txt and .html");
  });

  it("accepts the eight extensions and then any image", () => {
    const parts = IMPORT_ACCEPT.split(",");
    expect(parts.slice(0, EIGHT.length)).toEqual(EIGHT);
    expect(parts[parts.length - 1]).toBe("image/*");
    expect(parts).toHaveLength(EIGHT.length + 1);
  });

  it("maps a file name to its format case-insensitively, null for anything else", () => {
    expect(importFormatFor("A.MKD")).toBe("markdown");
    expect(importFormatFor("notes.md")).toBe("markdown");
    expect(importFormatFor("plain.TEXT")).toBe("text");
    expect(importFormatFor("page.Htm")).toBe("html");
    expect(importFormatFor("archive.tar.md")).toBe("markdown");
    expect(importFormatFor("x.rst")).toBeNull();
    expect(importFormatFor("noext")).toBeNull();
    expect(importFormatFor("")).toBeNull();
  });

  it("takes the last extension, lower-cased, ignoring surrounding whitespace", () => {
    expect(fileExtension("README.MD")).toBe(".md");
    expect(fileExtension(" notes.txt ")).toBe(".txt");
    expect(fileExtension("a.b.html")).toBe(".html");
    expect(fileExtension("Makefile")).toBe("");
    expect(fileExtension("trailing.")).toBe("");
  });
});
