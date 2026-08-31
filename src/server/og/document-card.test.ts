import { afterEach, describe, expect, it, vi } from "vitest";
import { CARD_CACHE_CONTROL, CARD_SIZE, cardMetaLine, loadCardFonts, renderDocumentCard, titleFontSize, type DocumentCardInput } from "./document-card";

const INPUT: DocumentCardInput = {
  title: "Release notes for the evening build",
  ownerName: "Alice Example",
  readingMinutes: 4,
  updatedAt: new Date("2026-08-31T21:00:00Z"),
};

/** The PNG signature and the IHDR chunk that follows it: width and height are bytes 16–24. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(bytes.toString("latin1", 12, 16)).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function render(input: DocumentCardInput, fonts?: Awaited<ReturnType<typeof loadCardFonts>> | null): Promise<{ res: Response; bytes: Buffer }> {
  const res = await renderDocumentCard(input, fonts);
  return { res, bytes: Buffer.from(await res.arrayBuffer()) };
}

describe("renderDocumentCard", () => {
  it("answers a 1200×630 PNG with the five-minute cache header", async () => {
    const { res, bytes } = await render(INPUT);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(CARD_CACHE_CONTROL);
    expect(bytes.length).toBeGreaterThanOrEqual(10_000);
    expect(pngSize(bytes)).toEqual({ width: CARD_SIZE.width, height: CARD_SIZE.height });
  }, 30_000);

  it("renders a 300-character title (clamped to three lines) without throwing", async () => {
    const title = Array.from({ length: 30 }, (_, i) => `Segment${i + 1}xx`).join(" ").slice(0, 300);
    expect(title).toHaveLength(300);
    const { res, bytes } = await render({ ...INPUT, title });
    expect(res.status).toBe(200);
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
  }, 30_000);

  it("renders an unbroken 300-character word, an empty title and a document without owner or prose", async () => {
    for (const input of [
      { ...INPUT, title: "x".repeat(300) },
      { ...INPUT, title: "   " },
      { ...INPUT, ownerName: null, readingMinutes: 0 },
    ]) {
      const { res, bytes } = await render(input);
      expect(res.status).toBe(200);
      expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
    }
  }, 60_000);

  it("keeps rendering in the bundled face when the vendored fonts are not passed", async () => {
    const { res, bytes } = await render(INPUT, null);
    expect(res.status).toBe(200);
    expect(bytes.length).toBeGreaterThanOrEqual(10_000);
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
  }, 30_000);
});

describe("loadCardFonts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the vendored Fraunces 600 and Inter 500 subsets once", async () => {
    const fonts = await loadCardFonts();
    expect(fonts?.map((f) => [f.name, f.weight, f.style])).toEqual([
      ["Fraunces", 600, "normal"],
      ["Inter", 500, "normal"],
    ]);
    for (const font of fonts!) {
      const bytes = font.data as Buffer;
      expect(bytes.length).toBeGreaterThan(40_000);
      // TrueType table directory: sfnt version 0x00010000, more than eight tables (cmap, glyf, GPOS…).
      expect(bytes.readUInt32BE(0)).toBe(0x00010000);
      expect(bytes.readUInt16BE(4)).toBeGreaterThan(8);
    }
    expect(await loadCardFonts()).toBe(fonts);
  });

  it("falls back to undefined and logs once when the directory is missing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadCardFonts("Z:\\no\\such\\fonts")).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe("[og] fonts");
  });
});

describe("cardMetaLine", () => {
  const now = new Date("2026-09-01T00:00:00Z");

  it("joins owner, reading time and the update date with middle dots", () => {
    expect(cardMetaLine(INPUT, now)).toBe("by Alice Example · 4 min read · Updated Aug 31");
  });

  it("leaves out an unknown owner and a zero reading time", () => {
    expect(cardMetaLine({ ...INPUT, ownerName: null, readingMinutes: 0 }, now)).toBe("Updated Aug 31");
  });

  it("adds the year only when the document was last updated in another year", () => {
    expect(cardMetaLine({ ...INPUT, updatedAt: new Date("2025-02-03T12:00:00Z") }, now)).toBe("by Alice Example · 4 min read · Updated Feb 3, 2025");
  });
});

describe("titleFontSize", () => {
  it("steps down as the title grows", () => {
    expect(titleFontSize("Short")).toBe(76);
    expect(titleFontSize("a".repeat(36))).toBe(76);
    expect(titleFontSize("a".repeat(37))).toBe(64);
    expect(titleFontSize("a".repeat(72))).toBe(64);
    expect(titleFontSize("a".repeat(73))).toBe(54);
  });
});
