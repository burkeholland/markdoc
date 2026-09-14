import { describe, expect, it } from "vitest";
import { exportContentDisposition, readDownloadFilename } from "./download-filename";

const formats = ["md", "html", "pdf"] as const;

describe("exportContentDisposition", () => {
  it.each(formats)("retains exact legacy ASCII headers for %s", (extension) => {
    for (const [title, basename] of [
      ["Export Me", "Export Me"],
      ["  a_b-C  ", "a_b-C"],
      [' A "quote"; 50% of Bob\'s (plan)* /\\.\r\n ', "A quote 50 of Bobs plan"],
      ["", "document"],
      [" \t\r\n ", "document"],
      ['../\\;"%\'\u0000\u007f', "document"],
      ["\ud800 \udfff", "document"],
    ]) {
      expect(exportContentDisposition(title, extension)).toBe(`attachment; filename="${basename}.${extension}"`);
    }
  });

  it.each(formats)("round-trips safe Unicode basenames with the %s suffix", (extension) => {
    for (const [title, basename, ascii] of [
      ["Caf\u00e9 r\u00e9sum\u00e9", "Caf\u00e9 r\u00e9sum\u00e9", "Caf rsum"],
      ["\u8a08\u753b \u6587\u66f8", "\u8a08\u753b \u6587\u66f8", "document"],
      ["\ud83d\ude80 \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb", "\ud83d\ude80 \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb", "document"],
      ["Cafe\u0301", "Cafe\u0301", "Cafe"],
      ["\ud83c\uddfa\ud83c\uddf8", "\ud83c\uddfa\ud83c\uddf8", "document"],
      ["  \u8a08\u753b \"50%\"; Bob's (v2)* /\\.\r\n ", "\u8a08\u753b 50 Bobs v2", "50 Bobs v2"],
      ["\ud800Caf\u00e9\udfff\u0085\u2028\u2029", "Caf\u00e9", "Caf"],
    ]) {
      const disposition = exportContentDisposition(title, extension);
      expect(disposition).toBe(`attachment; filename="${ascii}.${extension}"; filename*=UTF-8''${encodeURIComponent(`${basename}.${extension}`)}`);
      const headers = new Headers({ "Content-Disposition": disposition });
      expect([...headers]).toHaveLength(1);
      expect(readDownloadFilename(headers.get("Content-Disposition"))).toBe(`${basename}.${extension}`);
    }
  });

  it("does not normalize or truncate long Unicode titles", () => {
    const title = "Cafe\u0301 ".repeat(100).trim();
    expect(readDownloadFilename(exportContentDisposition(title, "pdf"))).toBe(`${title}.pdf`);
  });
});

describe("readDownloadFilename", () => {
  it.each([
    'attachment; filename="legacy.pdf"; filename*=UTF-8\'\'Caf%C3%A9.pdf',
    'attachment; filename*=UTF-8\'\'Caf%C3%A9.pdf; filename="legacy.pdf"',
    'attachment; FILENAME* = utf-8\'fr\'Caf%C3%A9.pdf; filename="legacy.pdf"',
  ])("prefers supported UTF-8 regardless of parameter order: %s", (header) => {
    expect(readDownloadFilename(header)).toBe("Caf\u00e9.pdf");
  });

  it.each([
    "UTF-8''bad%",
    "UTF-8''bad%GG.pdf",
    "UTF-8''bad%C3.pdf",
    "UTF-8''bad%ED%A0%80.pdf",
    "UTF-8''",
    "UTF-8''%20",
    "ISO-8859-1''Caf%E9.pdf",
    "UTF-16''%00A.pdf",
    "UTF-8''raw\u00e9.pdf",
    "UTF-8''unencoded apostrophe's.pdf",
    '"UTF-8\'\'quoted.pdf"',
    "UTF-8''..%2Foutside.pdf",
    "UTF-8''..%5Coutside.pdf",
    "UTF-8''%22quoted.pdf",
    "UTF-8''bad%0D%0AX-Injected%3Ayes.pdf",
    "UTF-8''.",
    "UTF-8''..",
  ])("uses the quoted fallback for invalid/unsafe extended values: %s", (value) => {
    for (const header of [
      `attachment; filename="legacy.pdf"; filename*=${value}`,
      `attachment; filename*=${value}; filename="legacy.pdf"`,
    ]) {
      expect(readDownloadFilename(header)).toBe("legacy.pdf");
    }
  });

  it("decodes reserved punctuation once, leaving encoded-looking filename text alone", () => {
    expect(readDownloadFilename("attachment; filename*=UTF-8''Caf%C3%A9%20%3B%25%27%28plan%29%252F.pdf"))
      .toBe("Caf\u00e9 ;%'(plan)%2F.pdf");
    expect(readDownloadFilename('attachment; filename="literal%20name.pdf"')).toBe("literal%20name.pdf");
  });

  it("does not interpret text inside another quoted parameter as a filename", () => {
    expect(readDownloadFilename('attachment; note="; filename*=UTF-8\'\'wrong.pdf"; filename="right.pdf"')).toBe("right.pdf");
  });

  it.each([
    null,
    "",
    "attachment",
    "attachment; filename=unquoted.pdf",
    'attachment; filename=""',
    'attachment; filename="../outside.pdf"',
    'attachment; filename="..\\outside.pdf"',
    'attachment; filename="bad\u0000.pdf"',
    'attachment; filename="bad\r\nX-Injected:yes.pdf"',
    'attachment; filename="bad\\"quote.pdf"',
    "attachment; filename*=UTF-8''bad%",
    "attachment; filename*=ISO-8859-1''name.pdf",
  ])("leaves the existing consumer default to handle unusable headers: %s", (header) => {
    expect(readDownloadFilename(header)).toBeNull();
  });
});
