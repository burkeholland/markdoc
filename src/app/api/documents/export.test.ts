import { describe, expect, it, beforeAll, beforeEach, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;
// Render budget for this file (task #1190): `render-pool.ts` reads MARKDOWN_RENDER_TIMEOUT_MS once, at import,
// so the override has to be in place before any import of it; hoisting keeps that true even if the dynamic
// imports below ever become static. The 15 s default is right for production, but on a saturated shared box
// the render worker of the large-export test below was starved past it and the export answered 422. No test
// here depends on the default: the bracket test is refused by the guard before the worker is involved.
vi.hoisted(() => {
  process.env.MARKDOWN_RENDER_TIMEOUT_MS = "120000";
});

// The route resolves the caller through next-auth and `next/headers`, neither of which
// runs outside a Next request. Stand in for them so the real access check still runs.
let actor: { id: string; login: string; name: string; image: null } | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { renderPdf } = vi.hoisted(() => ({
  renderPdf: vi.fn<(html: string) => Promise<Uint8Array>>(),
}));
// The real Chromium renderer runs in pdf.test.ts's single-worker project; this file verifies the route contract.
vi.mock("@/server/export/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/export/pdf")>();
  return { ...actual, renderPdf };
});

const { getDb, schema } = await import("@/server/db");
const { createDocument, setDocumentText } = await import("@/server/documents");
const { putAsset } = await import("@/server/assets");
const { PdfUnavailableError } = await import("@/server/export/pdf");
const { renderDocumentHtml } = await import("@/server/export/html");
const { GET } = await import("./[id]/export/route");
const { GET: assetGET } = await import("../assets/[id]/route");
const { GET: healthGET } = await import("../health/route");

const MARKDOWN = "# Export Me\n\nA paragraph with **bold**.\n\n- [ ] task\n";
const PDF_BYTES = Uint8Array.from(Buffer.from("%PDF-1.7\nmock\n", "latin1"));

describe("GET /api/documents/[id]/export", () => {
  let docId: string;

  beforeEach(() => {
    renderPdf.mockReset().mockRejectedValue(new Error("PDF renderer mock was not configured"));
  });

  beforeAll(async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Eve", login: "eve", email: "eve@example.com" }).returning();
    actor = { id: user.id, login: "eve", name: "Eve", image: null };
    const doc = await createDocument({ ownerId: user.id, title: "Export Me", content: MARKDOWN });
    docId = doc.id;
  });

  const call = (query = "") => GET(new Request(`http://localhost:3700/api/documents/${docId}/export${query}`), { params: Promise.resolve({ id: docId }) });

  it("returns Markdown by default, exactly as before", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBeNull();
    expect(await res.text()).toBe(MARKDOWN);

    const dl = await call("?download=1");
    expect(dl.headers.get("Content-Disposition")).toBe('attachment; filename="Export Me.md"');
  });

  it("rejects unknown formats with 400 instead of silently falling back to Markdown", async () => {
    const res = await call("?format=docx");
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Unknown format", format: "docx", formats: ["md", "html", "pdf"] });
    // An empty `format=` still means the default.
    expect((await call("?format=")).headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
  });

  it("returns a standalone HTML page for format=html", async () => {
    const res = await call("?format=html");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBeNull();
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Export Me</title>");
    expect(html).toContain('<h1 id="export-me">Export Me</h1>');
    expect(html).toContain("<strong>bold</strong>");

    const dl = await call("?format=html&download=1");
    expect(dl.headers.get("Content-Disposition")).toBe('attachment; filename="Export Me.html"');
  });

  describe("pathological documents (#115)", () => {
    const exportOf = (id: string, query: string) => GET(new Request(`http://localhost:3700/api/documents/${id}/export${query}`), { params: Promise.resolve({ id }) });

    it("answers 422 within 2 s for 80 KB of unbalanced brackets instead of parsing for ~40 s", async () => {
      const doc = await createDocument({ ownerId: actor!.id, title: "brackets", content: "[".repeat(40_000) + "a" + "]".repeat(40_000) });
      for (const format of ["html", "pdf"]) {
        const started = performance.now();
        const res = await exportOf(doc.id, `?format=${format}`);
        expect(performance.now() - started).toBeLessThan(2_000);
        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({ error: "Document is not renderable", reason: "brackets" });
      }
      // Markdown export is untouched: the text itself is fine to hand out.
      expect((await exportOf(doc.id, "")).status).toBe(200);
    });

    it("keeps /api/health fast while a large export is rendering", { retry: 1 }, async () => {
      expect((await import("@/server/export/render-pool")).RENDER_TIMEOUT_MS).toBe(120_000);
      const content = Array.from({ length: 200 }, (_, i) => `## Section ${i}\n\n${"[a](b) **b** _c_ ~~d~~ ".repeat(60)}\n`).join("\n");
      const doc = await createDocument({ ownerId: actor!.id, title: "big", content });

      // One health probe as the platform sees it: it arrives `afterMs` from now (a timer, since a request
      // reaches the server through the event loop) and is measured from that arrival to its response. A probe
      // that arrives while the loop is blocked cannot start until the block ends, so measured from the
      // moment it *starts* every probe looks fast; measured from arrival it shows the wait the probe spent
      // queued, which is what the liveness probe would have seen.
      const probeHealth = (afterMs: number) =>
        new Promise<number>((resolve, reject) => {
          const arrival = performance.now() + afterMs;
          setTimeout(async () => {
            try {
              const health = await healthGET(new Request("http://localhost/api/health"));
              expect(health.status).toBe(200);
              resolve(performance.now() - arrival);
            } catch (err) {
              reject(err);
            }
          }, afterMs);
        });
      const fmt = (samples: number[]) => samples.map((ms) => ms.toFixed(1)).join(", ");

      // Baseline: what a health round trip costs on this machine right now, fastest of three.
      const baseline = [await probeHealth(0), await probeHealth(0), await probeHealth(0)];
      const baselineMs = Math.min(...baseline);

      // Three probes spread over the export's render (≥ 0.8 s even on a fast idle machine; longer under load,
      // since the worker is starved along with everything else). The assertion is on the *fastest* of them
      // (task #1190): load can only slow a probe down, and three probes 150 ms apart give three chances for
      // one to get the CPU, while a render on this thread delays all three by about the remaining render
      // time — well over the bound. The old single sample `< 200 ms` failed on a saturated box.
      const exporting = exportOf(doc.id, "?format=html");
      const during = await Promise.all([probeHealth(50), probeHealth(200), probeHealth(350)]);
      const res = await exporting;
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<h2 id="section-199">Section 199</h2>');
      const detail = `health during export ${fmt(during)} ms; baseline ${fmt(baseline)} ms`;
      expect(Math.min(...during), detail).toBeLessThan(Math.max(200, 4 * baselineMs));
    });
  });

  it("rejects callers without access", async () => {
    const saved = actor;
    actor = null;
    try {
      const res = await call("?format=html");
      expect(res.status).toBe(401);
    } finally {
      actor = saved;
    }
  });

  describe("asset inlining respects the asset's own document (security)", () => {
    // Alice owns a private document with an image; Mallory, who cannot see it, names the asset id in her own document.
    let mallory: { id: string; login: string; name: string; image: null };
    let malloryDocId: string;
    let secretDocId: string;
    let secretAssetId: string;
    const SECRET_B64 = Buffer.from("alice-secret-png-bytes").toString("base64");

    beforeAll(async () => {
      const db = await getDb();
      const alice = actor!;
      secretDocId = (await createDocument({ ownerId: alice.id, title: "Secret", content: "# Secret\n" })).id;
      const stored = await putAsset({ documentId: secretDocId, userId: alice.id, name: "secret.png", mime: "image/png", bytes: Uint8Array.from(Buffer.from(SECRET_B64, "base64")) });
      secretAssetId = stored.id;

      const [user] = await db.insert(schema.users).values({ name: "Mallory", login: "mallory", email: "mallory@example.com" }).returning();
      mallory = { id: user.id, login: "mallory", name: "Mallory", image: null };
      malloryDocId = (await createDocument({ ownerId: mallory.id, title: "Mine", content: `![x](/api/assets/${secretAssetId})\n` })).id;
    });

    const asMallory = async <T>(fn: () => Promise<T>) => {
      const saved = actor;
      actor = mallory;
      try {
        return await fn();
      } finally {
        actor = saved;
      }
    };

    it("still refuses the asset itself to someone without access to its document", async () => {
      const res = await asMallory(() => assetGET(new Request(`http://localhost:3700/api/assets/${secretAssetId}`), { params: Promise.resolve({ id: secretAssetId }) }));
      expect(res.status).toBe(404);
    });

    it("does not inline another document's asset into an HTML download; the URL is kept for the reader's own access check", async () => {
      const res = await asMallory(() => GET(new Request(`http://localhost:3700/api/documents/${malloryDocId}/export?format=html&download=1`), { params: Promise.resolve({ id: malloryDocId }) }));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("data:image");
      expect(html).not.toContain(SECRET_B64);
      expect(html).toContain(`<img src="http://localhost:3700/api/assets/${secretAssetId}" alt="x">`);
    });

    it("takes the same path for PDF (asserted on the intermediate HTML)", async () => {
      const html = await renderDocumentHtml({ title: "Mine", markdown: `![x](/api/assets/${secretAssetId})\n`, assetBaseUrl: "http://localhost:3700", inlineAssets: { documentId: malloryDocId } });
      expect(html).not.toContain("data:image");
      expect(html).toContain(`<img src="http://localhost:3700/api/assets/${secretAssetId}" alt="x">`);
    });

    it("still inlines the owner's own asset in the owner's export", async () => {
      // Same owner, but a different document: ownership is per document, not per user.
      const aliceOtherDocId = (await createDocument({ ownerId: actor!.id, title: "Own", content: `![s](/api/assets/${secretAssetId})\n` })).id;
      const other = await GET(new Request(`http://localhost:3700/api/documents/${aliceOtherDocId}/export?format=html&download=1`), { params: Promise.resolve({ id: aliceOtherDocId }) });
      expect(other.status).toBe(200);
      expect(await other.text()).not.toContain("data:image");

      await setDocumentText(secretDocId, `![s](/api/assets/${secretAssetId})\n`);
      const own = await GET(new Request(`http://localhost:3700/api/documents/${secretDocId}/export?format=html&download=1`), { params: Promise.resolve({ id: secretDocId }) });
      expect(own.status).toBe(200);
      expect(await own.text()).toContain(`<img src="data:image/png;base64,${SECRET_B64}" alt="s">`);
    });
  });

  it("returns a PDF for format=pdf", async () => {
    renderPdf.mockResolvedValueOnce(PDF_BYTES);

    const res = await call("?format=pdf&download=1");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Export Me.pdf"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(renderPdf).toHaveBeenCalledOnce();
    expect(renderPdf).toHaveBeenCalledWith(expect.stringContaining("<title>Export Me</title>"));
  });

  it("returns the explicit unavailable response only for a Chromium launch failure", async () => {
    const launchError = new Error("test Chromium launch failure");
    renderPdf.mockRejectedValueOnce(new PdfUnavailableError(launchError));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await call("?format=pdf");

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "PDF export is unavailable on this server" });
      expect(error).toHaveBeenCalledWith("PDF export unavailable:", launchError);
    } finally {
      error.mockRestore();
    }
  });

  it("keeps unexpected PDF renderer failures visible as route errors", async () => {
    const pageError = new Error("test page.pdf failure");
    renderPdf.mockRejectedValueOnce(pageError);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await call("?format=pdf");

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Unexpected error" });
      expect(error).toHaveBeenCalledWith(pageError);
    } finally {
      error.mockRestore();
    }
  });
});