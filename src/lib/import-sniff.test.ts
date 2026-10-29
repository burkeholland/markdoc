import { describe, expect, it } from "vitest";
import { looksBinary } from "./import-sniff";

const enc = (s: string) => new TextEncoder().encode(s);

describe("looksBinary", () => {
  it.each([
    ["PNG signature", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...enc("notreally")])],
    ["PDF", enc("%PDF-1.7\n1 0 obj\n")],
    ["ZIP / DOCX", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])],
    ["NUL byte", enc("# A\u0000b")],
    ["mostly invalid UTF-8", new Uint8Array(Array.from({ length: 200 }, (_, i) => 0x80 + (i % 64)))],
    ["control characters", enc("\u0001\u0002\u0003\u0004 text")],
  ])("refuses %s", (_, bytes) => {
    expect(looksBinary(bytes)).toBe(true);
  });

  it.each([
    ["Markdown", enc("# Title\n\nSome *text* with ünïcødé, emoji 🎉 and a\ttab.\r\n")],
    ["empty", new Uint8Array()],
    ["UTF-8 BOM", new Uint8Array([0xef, 0xbb, 0xbf, ...enc("# A")])],
    ["UTF-16LE with BOM", new Uint8Array([0xff, 0xfe, 0x23, 0x00, 0x20, 0x00, 0x41, 0x00])],
    ["one stray Latin-1 byte in a long file", new Uint8Array([...enc("caf"), 0xe9, ...enc(" ".repeat(100))])],
  ])("accepts %s", (_, bytes) => {
    expect(looksBinary(bytes)).toBe(false);
  });
});
