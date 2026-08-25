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
const { createDocument } = await import("@/server/documents");
const { closePdfBrowser } = await import("@/server/export/pdf");
const { GET } = await import("./[id]/export/route");
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
      const health = await healthGET();
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