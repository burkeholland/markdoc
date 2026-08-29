import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// The route resolves the caller through next-auth and `next/headers`, neither of which
// runs outside a Next request. Stand in for them so the real access check still runs.
let actor: { id: string; login: string; name: string; image: null } | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { createDocument, setDocumentText } = await import("@/server/documents");
const { putAsset } = await import("@/server/assets");
const { closePdfBrowser } = await import("@/server/export/pdf");
const { renderDocumentHtml } = await import("@/server/export/html");
const { GET } = await import("./[id]/export/route");
const { GET: assetGET } = await import("../assets/[id]/route");
const { GET: healthGET } = await import("../health/route");

const MARKDOWN = "# Export Me\n\nA paragraph with **bold**.\n\n- [ ] task\n";

describe("GET /api/documents/[id]/export", () => {
  let docId: string;

  beforeAll(async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Eve", login: "eve", email: "eve@example.com" }).returning();
    actor = { id: user.id, login: "eve", name: "Eve", image: null };
    const doc = await createDocument({ ownerId: user.id, title: "Export Me", content: MARKDOWN });
    docId = doc.id;
  });

  afterAll(async () => {
    await closePdfBrowser();
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

    it("keeps /api/health fast while a large export is rendering", async () => {
      const content = Array.from({ length: 200 }, (_, i) => `## Section ${i}\n\n${"[a](b) **b** _c_ ~~d~~ ".repeat(60)}\n`).join("\n");
      const doc = await createDocument({ ownerId: actor!.id, title: "big", content });
      const exporting = exportOf(doc.id, "?format=html");
      await new Promise((r) => setTimeout(r, 50));
      const started = performance.now();
      const health = await healthGET(new Request("http://localhost/api/health"));
      const healthMs = performance.now() - started;
      expect(health.status).toBe(200);
      expect(healthMs).toBeLessThan(200);
      const res = await exporting;
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<h2 id="section-199">Section 199</h2>');
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
    const res = await call("?format=pdf&download=1");
    if (res.status === 503) {
      console.warn("Skipping PDF assertion: Chromium could not be launched in this environment.");
      expect(await res.json()).toEqual({ error: "PDF export is unavailable on this server" });
      return;
    }
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Export Me.pdf"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
  }, 60_000);
});