import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetContent } from "../assets";
import { GIF, JPEG, PNG, SVG, SVG_TEXT, WEBP } from "../assets.fixtures";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

const { setAssetStore } = await import("../assets");
const { renderDocumentHtml } = await import("./html");

/**
 * The byte check on the page the server's Chromium prints (#2290). Uploads stored before the upload rule
 * (`assetTypeFor`) existed carry the type their client declared, so the store here is a fake that holds any
 * bytes under any type, the way such rows are.
 */

const BASE = "https://docs.example.com";
const DOC = "verify-doc";
const text = (value: string) => new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const stored = new Map<string, { mime: string; bytes: Uint8Array<ArrayBuffer> }>();
const put = (id: string, mime: string, bytes: Uint8Array<ArrayBuffer>) => (stored.set(id, { mime, bytes }), id);

beforeAll(() => {
  setAssetStore({
    async put() {
      throw new Error("not used");
    },
    async get() {
      throw new Error("not used");
    },
    async getForDocument(documentId, id): Promise<AssetContent | null> {
      const row = stored.get(id);
      return row && documentId === DOC ? { mime: row.mime, bytes: row.bytes, size: row.bytes.byteLength, documentId, name: id } : null;
    },
  });
});

const forChromium = (markdown: string) => renderDocumentHtml({ title: "Verify", markdown, assetBaseUrl: BASE, inlineAssets: { documentId: DOC, verifyBytes: true } });
const forDownload = (markdown: string) => renderDocumentHtml({ title: "Verify", markdown, assetBaseUrl: BASE, inlineAssets: { documentId: DOC } });
const image = (alt: string, id: string) => `![${alt}](/api/assets/${id})`;

describe("byte check when a page is built for the server's Chromium", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stored.clear();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("embeds each allowed type whose bytes match, exactly as the HTML download does, and logs nothing", async () => {
    const rows: Array<[string, string, Uint8Array<ArrayBuffer>]> = [
      ["png0001", "image/png", PNG],
      ["jpeg001", "image/jpeg", JPEG],
      ["gif0001", "image/gif", GIF],
      ["webp001", "image/webp", WEBP],
      ["svg0001", "image/svg+xml", SVG],
    ];
    for (const [id, mime, bytes] of rows) put(id, mime, bytes);
    const markdown = rows.map(([id]) => image(`picture ${id}`, id)).join("\n\n");

    const page = await forChromium(markdown);

    for (const [id, mime, bytes] of rows) expect(page).toContain(`<img src="data:${mime};base64,${b64(bytes)}" alt="picture ${id}">`);
    expect(page, "byte-identical to the page without the check").toBe(await forDownload(markdown));
    expect(warn).not.toHaveBeenCalled();
  });

  it("embeds a raster image under the type its bytes are, not the type it was stored under", async () => {
    put("old0001", "image/png", JPEG);
    put("old0002", "image/jpeg", WEBP);
    put("fine001", "image/gif", GIF);

    const page = await forChromium([image("a", "old0001"), image("b", "old0002"), image("c", "fine001")].join("\n\n"));

    expect(page).toContain(`<img src="data:image/jpeg;base64,${b64(JPEG)}" alt="a">`);
    expect(page).toContain(`<img src="data:image/webp;base64,${b64(WEBP)}" alt="b">`);
    expect(page).toContain(`<img src="data:image/gif;base64,${b64(GIF)}" alt="c">`);
    expect(page).not.toContain("data:image/png");
    expect(warn.mock.calls).toEqual([["[pdf] 0 image(s) left out: content is not an allowed image type; 2 inlined under the type its bytes are"]]);
  });

  it("leaves out SVG bytes stored as a raster type, and raster bytes stored as SVG, and shows their alt text", async () => {
    put("svgaspng", "image/png", SVG);
    put("pngassvg", "image/svg+xml", PNG);
    put("fine001", "image/png", PNG);

    const page = await forChromium(["Before", image("a drawing", "svgaspng"), image("a photo", "pngassvg"), image("kept", "fine001"), "After"].join("\n\n"));

    expect(page).toContain('<p><span class="image-left-out">a drawing</span></p>');
    expect(page).toContain('<p><span class="image-left-out">a photo</span></p>');
    expect(page).toContain(`<img src="data:image/png;base64,${b64(PNG)}" alt="kept">`);
    expect(page).not.toContain(b64(SVG));
    expect(page).not.toContain("data:image/svg+xml");
    expect(page, "no image element is left for what was not embedded").not.toMatch(/<img[^>]*(svgaspng|pngassvg)/);
    expect(page).not.toContain("/api/assets/");
    expect(warn.mock.calls).toEqual([["[pdf] 2 image(s) left out: content is not an allowed image type; 0 inlined under the type its bytes are"]]);
  });

  it("leaves out bytes that are no allowed image at all, under any stored type", async () => {
    const notImages: Array<[string, string, Uint8Array<ArrayBuffer>]> = [
      ["text001", "image/png", text("just some words, not a picture")],
      ["page001", "image/svg+xml", text("<html><body><p>a page</p></body></html>")],
      ["page002", "image/jpeg", text("<!DOCTYPE html><html><body>a page</body></html>")],
      ["zip0001", "image/webp", Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0])],
      ["bmp0001", "image/gif", Uint8Array.from([0x42, 0x4d, 0x3a, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, 0x28, 0, 0, 0])],
      ["empty01", "image/png", new Uint8Array(0)],
    ];
    for (const [id, mime, bytes] of notImages) put(id, mime, bytes);

    const page = await forChromium(notImages.map(([id]) => image(`alt ${id}`, id)).join("\n\n"));

    for (const [id] of notImages) expect(page).toContain(`<span class="image-left-out">alt ${id}</span>`);
    expect(page).not.toContain("data:");
    expect(page).not.toContain("<img");
    expect(warn.mock.calls).toEqual([[`[pdf] ${notImages.length} image(s) left out: content is not an allowed image type; 0 inlined under the type its bytes are`]]);
  });

  it("leaves out an SVG that the upload rule refuses for what it contains", async () => {
    // `foreignObject` is one of the things the existing rule (`isUnsafeSvg`) refuses.
    put("svgrule1", "image/svg+xml", text(SVG_TEXT.replace("</svg>", '<foreignObject width="1" height="1"></foreignObject></svg>')));

    const page = await forChromium(image("chart", "svgrule1"));

    expect(page).toContain('<span class="image-left-out">chart</span>');
    expect(page).not.toContain("data:image/svg+xml");
  });

  it("keeps the alt text as text, whatever characters it holds, and handles an image used twice or inside a link", async () => {
    put("svgaspng", "image/png", SVG);

    const page = await forChromium([
      image('x > y & "z"', "svgaspng"),
      `[${image("linked", "svgaspng")}](https://example.com/target)`,
      image("", "svgaspng"),
    ].join("\n\n"));

    const spans = [...page.matchAll(/<span class="image-left-out">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(spans).toHaveLength(3);
    expect(spans[0]).toMatch(/^x (&gt;|&#x3E;) y (&amp;|&#x26;) (&quot;|&#x22;)z(&quot;|&#x22;)$/);
    expect(spans[1]).toBe("linked");
    expect(spans[2]).toBe("");
    expect(page).toContain('<a href="https://example.com/target"><span class="image-left-out">linked</span></a>');
    expect(page).not.toContain("<img");
    // One asset, used three times: counted once.
    expect(warn.mock.calls).toEqual([["[pdf] 1 image(s) left out: content is not an allowed image type; 0 inlined under the type its bytes are"]]);
  });

  it("does not count a left-out image against the embedding budget", async () => {
    put("notimg1", "image/png", text("x".repeat(600)));
    put("fine001", "image/png", PNG);

    const page = await renderDocumentHtml({
      title: "Budget",
      markdown: [image("not a picture", "notimg1"), image("kept", "fine001")].join("\n\n"),
      assetBaseUrl: BASE,
      inlineAssets: { documentId: DOC, verifyBytes: true, maxBytes: 600 },
    });

    expect(page).toContain(`<img src="data:image/png;base64,${b64(PNG)}" alt="kept">`);
  });

  it("changes nothing for the HTML download: stored type and bytes go in as before, without a log line", async () => {
    put("svgaspng", "image/png", SVG);
    put("old0001", "image/png", JPEG);

    const page = await forDownload([image("a drawing", "svgaspng"), image("a", "old0001")].join("\n\n"));

    expect(page).toContain(`<img src="data:image/png;base64,${b64(SVG)}" alt="a drawing">`);
    expect(page).toContain(`<img src="data:image/png;base64,${b64(JPEG)}" alt="a">`);
    expect(page).not.toContain("image-left-out");
    expect(warn).not.toHaveBeenCalled();
  });
});
