import { beforeAll, describe, expect, it } from "vitest";
import type { AssetContent } from "../assets";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

const { setAssetStore } = await import("../assets");
const { renderDocumentHtml, MAX_INLINE_ASSET_BYTES } = await import("./html");

const BASE = "https://docs.example.com";
const DOC = "budget-doc";
const ONE_MB = 1024 * 1024;
const ASSET_BUDGET_RENDER_TIMEOUT_MS = 60_000;

/**
 * A fake store: every id in `owned` is a 1 MB image belonging to DOC, every other id belongs to
 * someone else. Records which ids were read so the test can show the budget bounds I/O, not just output.
 */
const reads: { method: string; id: string }[] = [];
const owned = new Set(Array.from({ length: 100 }, (_, n) => `own${String(n).padStart(13, "0")}`));
const fill = (id: string) => Number.parseInt(id.slice(-2), 10) % 256;
const asset = (id: string, documentId: string): AssetContent => ({ mime: "image/png", bytes: new Uint8Array(ONE_MB).fill(fill(id)), size: ONE_MB, documentId, name: `${id}.png` });

beforeAll(() => {
  setAssetStore({
    async put() {
      throw new Error("not used");
    },
    async get(id) {
      reads.push({ method: "get", id });
      return asset(id, owned.has(id) ? DOC : "someone-else");
    },
    async getForDocument(documentId, id) {
      reads.push({ method: "getForDocument", id });
      const ownerId = owned.has(id) ? DOC : "someone-else";
      return ownerId === documentId ? asset(id, ownerId) : null;
    },
  });
});

describe("inline asset budget", () => {
  it("embeds at most MAX_INLINE_ASSET_BYTES of the document's own images and never reads the rest", async () => {
    reads.length = 0;
    const ids = [...owned];
    const markdown = ids.map((id, n) => `![img${n}](/api/assets/${id})`).join("\n\n");
    const html = await renderDocumentHtml({ title: "Budget", markdown, assetBaseUrl: BASE, inlineAssets: { documentId: DOC }, timeoutMs: ASSET_BUDGET_RENDER_TIMEOUT_MS });

    const inlined = html.match(/src="data:image\/png;base64,/g)?.length ?? 0;
    const budgetInImages = Math.floor(MAX_INLINE_ASSET_BYTES / ONE_MB);
    expect(inlined).toBe(budgetInImages);
    // The first images (document order) are embedded; everything past the budget keeps its URL.
    expect(html).toContain(`alt="img${budgetInImages - 1}"`);
    expect(html).toContain(`<img src="${BASE}/api/assets/${ids[budgetInImages]}" alt="img${budgetInImages}">`);
    expect(html).toContain(`<img src="${BASE}/api/assets/${ids[ids.length - 1]}" alt="img${ids.length - 1}">`);
    // The budget is an exact fit here, so nothing past it is read at all; in general at most one extra asset
    // (the one that would overflow) is read and dropped.
    expect(reads.length).toBe(budgetInImages);
    expect(reads.every((r) => r.method === "getForDocument")).toBe(true);
  }, ASSET_BUDGET_RENDER_TIMEOUT_MS);

  it("only ever asks the store for assets scoped to the exported document", async () => {
    reads.length = 0;
    const foreign = "theirs00000000000";
    const [mine] = owned;
    const html = await renderDocumentHtml({
      title: "Scope",
      markdown: `![a](/api/assets/${mine})\n\n![b](/api/assets/${foreign})`,
      assetBaseUrl: BASE,
      inlineAssets: { documentId: DOC },
      timeoutMs: ASSET_BUDGET_RENDER_TIMEOUT_MS,
    });
    expect(html).toContain('alt="a"');
    expect(html).toMatch(/<img src="data:image\/png;base64,[^"]+" alt="a">/);
    expect(html).toContain(`<img src="${BASE}/api/assets/${foreign}" alt="b">`);
    expect(reads.map((r) => r.method)).toEqual(["getForDocument", "getForDocument"]);
  });
});
