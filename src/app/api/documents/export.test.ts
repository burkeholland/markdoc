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

  it("ignores unknown formats and falls back to Markdown", async () => {
    const res = await call("?format=docx");
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
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