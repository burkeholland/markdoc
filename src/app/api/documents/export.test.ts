import { describe, expect, it, beforeAll, beforeEach, vi } from "vitest";
import { distinctPng } from "@/server/assets.fixtures";

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
// What `next/headers` hands to the access check: nothing, unless a test sends a request with credentials of its own.
let requestHeaders = new Headers();
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const { renderPdf } = vi.hoisted(() => ({
  renderPdf: vi.fn<(source: string | (() => Promise<string>), options?: { signal?: AbortSignal; userId?: string }) => Promise<Uint8Array>>(),
}));
// The real Chromium renderer runs in pdf.test.ts's single-worker project; this file verifies the route contract.
vi.mock("@/server/export/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/export/pdf")>();
  return { ...actual, renderPdf };
});

const { eq } = await import("drizzle-orm");
const { getDb, schema } = await import("@/server/db");
const { createDocument, setDocumentText } = await import("@/server/documents");
const { REMOTE_ADDR_HEADER } = await import("@/server/rate-limit");
const { createApiToken } = await import("@/server/tokens");
const { mintSessionCookie } = await import("@/server/session-cookie");
const { putAsset } = await import("@/server/assets");
const { PdfBusyError, PdfCancelledError, PdfUnavailableError, PDF_RETRY_AFTER_SECONDS } = await import("@/server/export/pdf");
const { renderDocumentHtml } = await import("@/server/export/html");
const livedoc = await import("@/server/livedoc");
const { readDownloadFilename } = await import("@/lib/download-filename");
const { GET } = await import("./[id]/export/route");
const { GET: assetGET } = await import("../assets/[id]/route");
const { GET: healthGET } = await import("../health/route");

const MARKDOWN = "# Export Me\n\nA paragraph with **bold**.\n\n- [ ] task\n";
const PDF_BYTES = Uint8Array.from(Buffer.from("%PDF-1.7\nmock\n", "latin1"));

describe("GET /api/documents/[id]/export", () => {
  let docId: string;

  beforeEach(() => {
    // Like the real renderer, the stand-in builds the page first, so a document the page builder refuses
    // fails with the builder's own error.
    renderPdf.mockReset().mockImplementation(async (source) => {
      if (typeof source === "function") await source();
      throw new Error("PDF renderer mock was not configured");
    });
  });

  /** The page the route asked the renderer to print (the route hands over a builder, #2290). */
  const pageOf = (nthCall = 0) => (renderPdf.mock.calls[nthCall][0] as () => Promise<string>)();

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

  describe("download filenames", () => {
    const formats = ["md", "html", "pdf"] as const;
    const titles = [
      { title: "Renamed document", basename: "Renamed document", ascii: "Renamed document" },
      { title: "Caf\u00e9 r\u00e9sum\u00e9", basename: "Caf\u00e9 r\u00e9sum\u00e9", ascii: "Caf rsum" },
      { title: "\u8a08\u753b \u6587\u66f8", basename: "\u8a08\u753b \u6587\u66f8", ascii: "document" },
      { title: "\ud83d\ude80 \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb", basename: "\ud83d\ude80 \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb", ascii: "document" },
      { title: "  Current / title  ", basename: "Current  title", ascii: "Current  title" },
      { title: "", basename: "Export Me", ascii: "Export Me" },
    ];

    it.each(formats.flatMap((format) => titles.map((title) => ({ format, ...title }))))(
      "uses one current-title snapshot for $format: $title",
      async ({ format, title, basename, ascii }) => {
        const snapshot = { title, clean: "# Current body\n", text: "# Current body with suggestions\n", pendingSuggestions: 1, openComments: 0 };
        const live = vi.spyOn(livedoc, "readLiveText").mockResolvedValueOnce(snapshot);
        renderPdf.mockResolvedValueOnce(PDF_BYTES);
        try {
          const res = await call(`?format=${format}&download=1`);
          const disposition = `attachment; filename="${ascii}.${format}"` +
            (basename === ascii ? "" : `; filename*=UTF-8''${encodeURIComponent(`${basename}.${format}`)}`);
          expect(res.status).toBe(200);
          expect(res.headers.get("Content-Disposition")).toBe(disposition);
          expect(readDownloadFilename(res.headers.get("Content-Disposition"))).toBe(`${basename}.${format}`);
          expect(res.headers.get("Cache-Control")).toBe("no-store");
          expect(live).toHaveBeenCalledExactlyOnceWith(docId);
          if (format === "md") {
            expect(await res.text()).toBe(snapshot.clean);
            expect(renderPdf).not.toHaveBeenCalled();
          } else {
            const html = format === "html" ? await res.text() : await pageOf();
            expect(html).toContain(`<title>${title || "Export Me"}</title>`);
            expect(html).toContain('<h1 id="current-body">Current body</h1>');
            expect(html).not.toContain("with suggestions");
            if (format === "pdf") {
              expect(renderPdf).toHaveBeenCalledOnce();
              expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF_BYTES);
            } else {
              expect(renderPdf).not.toHaveBeenCalled();
            }
          }
        } finally {
          live.mockRestore();
        }
      },
    );

    it.each([
      { title: '  \u8a08\u753b "50%"; Bob\'s (v2)* /\\.\r\n ', basename: "\u8a08\u753b 50 Bobs v2" },
      { title: "\ud800Caf\u00e9\udfff\u0000\u0085", basename: "Caf\u00e9" },
      { title: "../\\;\r\n\u0000\u007f\ud800", basename: "document" },
      { title: " \t\r\n ", basename: "document" },
    ])("emits a safe native header for malformed/unsafe titles: $basename", async ({ title, basename }) => {
      const snapshot = { title, clean: "Clean", text: "With suggestions", pendingSuggestions: 1, openComments: 0 };
      const live = vi.spyOn(livedoc, "readLiveText").mockResolvedValueOnce(snapshot);
      try {
        const res = await call("?format=md&download=1&suggestions=1");
        expect(res.status).toBe(200);
        expect(readDownloadFilename(res.headers.get("Content-Disposition"))).toBe(`${basename}.md`);
        expect([...res.headers.keys()].sort()).toEqual([
          "cache-control", "content-disposition", "content-type", "x-ratelimit-limit", "x-ratelimit-remaining",
        ]);
        expect(await res.text()).toBe(snapshot.text);
        expect(live).toHaveBeenCalledExactlyOnceWith(docId);
      } finally {
        live.mockRestore();
      }
    });

    it.each(formats)("does not add an attachment to direct Unicode %s responses", async (format) => {
      const snapshot = { title: "Caf\u00e9", clean: "Clean", text: "With suggestions", pendingSuggestions: 1, openComments: 0 };
      const live = vi.spyOn(livedoc, "readLiveText").mockResolvedValueOnce(snapshot);
      renderPdf.mockResolvedValueOnce(PDF_BYTES);
      try {
        const res = await call(`?format=${format}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Disposition")).toBeNull();
        expect(live).toHaveBeenCalledExactlyOnceWith(docId);
      } finally {
        live.mockRestore();
      }
    });
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
      // Refused before the renderer is asked for: such a document takes no place in its queue and waits for no turn (#2290).
      expect(renderPdf).not.toHaveBeenCalled();
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
    const SECRET_B64 = Buffer.from(distinctPng("alice-secret-png-bytes")).toString("base64");

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
    // The route hands over a builder, not the page: the page is made once the request has the renderer (#2290).
    expect(typeof renderPdf.mock.calls[0][0]).toBe("function");
    expect(await pageOf()).toContain("<title>Export Me</title>");
  });

  it("passes the request's own abort signal to the renderer, so a caller that goes away is not rendered", async () => {
    renderPdf.mockResolvedValueOnce(PDF_BYTES);
    const caller = new AbortController();
    const req = new Request(`http://localhost:3700/api/documents/${docId}/export?format=pdf`, { signal: caller.signal });

    await GET(req, { params: Promise.resolve({ id: docId }) });

    const signal = renderPdf.mock.calls[0][1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    caller.abort();
    expect(signal?.aborted, "the renderer's signal follows the request").toBe(true);
  });

  describe("a caller that goes away while its pictures are embedded (#2290)", () => {
    let picturesId: string;
    const PICTURE_B64 = Buffer.from(distinctPng("a-picture-of-a-caller-that-leaves")).toString("base64");
    const ask = (query: string, signal?: AbortSignal) => GET(new Request(`http://localhost:3700/api/documents/${picturesId}/export${query}`, { signal }), { params: Promise.resolve({ id: picturesId }) });

    beforeAll(async () => {
      picturesId = (await createDocument({ ownerId: actor!.id, title: "Pictures", content: "# Pictures\n" })).id;
      const stored = await putAsset({ documentId: picturesId, userId: actor!.id, name: "a.png", mime: "image/png", bytes: Uint8Array.from(Buffer.from(PICTURE_B64, "base64")) });
      await setDocumentText(picturesId, `![a](/api/assets/${stored.id})\n`);
    });

    it("hands the request's signal to the page builder too: nothing is read for a PDF whose caller is gone", async () => {
      const caller = new AbortController();
      let built: unknown = "the builder was not asked";
      // The renderer as it is when the caller leaves right after it got its turn: the page is asked for, then the caller is answered as gone.
      renderPdf.mockImplementationOnce(async (source) => {
        caller.abort();
        built = await (source as () => Promise<string>)().then(() => "a page was built for nobody", (error: unknown) => error);
        throw new PdfCancelledError();
      });

      const res = await ask("?format=pdf", caller.signal);

      expect(res.status).toBe(499);
      expect(built, "the builder stopped with the reason the request's signal carries").toBe(caller.signal.reason);
    });

    it("builds the same page as before for a caller that stays", async () => {
      renderPdf.mockResolvedValueOnce(PDF_BYTES);
      const caller = new AbortController();

      expect((await ask("?format=pdf", caller.signal)).status).toBe(200);

      expect(await pageOf()).toContain(`<img src="data:image/png;base64,${PICTURE_B64}" alt="a">`);
      const download = await ask("?format=html&download=1", caller.signal);
      expect(download.status).toBe(200);
      expect(await download.text()).toContain(`<img src="data:image/png;base64,${PICTURE_B64}" alt="a">`);
    });

    it("answers an HTML download quietly when its caller is gone, and logs no error for it", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const caller = new AbortController();
      caller.abort();

      const res = await ask("?format=html&download=1", caller.signal);

      expect(res.status).toBe(499);
      expect(await res.json()).toEqual({ error: "The request was cancelled" });
      expect(error).not.toHaveBeenCalled();
      // The page in the browser embeds nothing, so it reads nothing and has nothing to give up.
      expect((await ask("?format=html", caller.signal)).status).toBe(200);
      error.mockRestore();
    });
  });

  describe("who the renderer is shared between (#2290)", () => {
    let sharedId: string;
    const anonymously = async (headers: Record<string, string> = {}) => {
      const saved = actor;
      actor = null;
      requestHeaders = new Headers(headers);
      try {
        return await GET(new Request(`http://localhost:3700/api/documents/${sharedId}/export?format=pdf`, { headers }), { params: Promise.resolve({ id: sharedId }) });
      } finally {
        actor = saved;
        requestHeaders = new Headers();
      }
    };

    beforeAll(async () => {
      const doc = await createDocument({ ownerId: actor!.id, title: "Shared by link", content: "# Shared\n" });
      sharedId = doc.id;
      const db = await getDb();
      await db.update(schema.documents).set({ linkAccess: "view" }).where(eq(schema.documents.id, sharedId));
    });

    it("names a signed-in caller by the user the access check found", async () => {
      renderPdf.mockResolvedValueOnce(PDF_BYTES);

      expect((await call("?format=pdf")).status).toBe(200);

      expect(renderPdf.mock.calls[0][1]?.userId).toBe(actor!.id);
    });

    it("names a caller without a session by nothing at all", async () => {
      renderPdf.mockResolvedValueOnce(PDF_BYTES);

      expect((await anonymously()).status).toBe(200);

      expect(renderPdf.mock.calls[0][1]).toEqual({ signal: expect.any(AbortSignal), userId: undefined });
    });

    it("does not let made-up credentials or an address turn a caller without a session into another caller", async () => {
      // Each of these gives the rate limiter's raw-header key a new value; none of them is a session or a token.
      const attempts: Array<Record<string, string>> = [
        { authorization: "Bearer made-up-1" },
        { authorization: "Bearer made-up-2" },
        { cookie: "authjs.session-token=made-up" },
        { cookie: "__Secure-authjs.session-token=made-up-too" },
        { "x-forwarded-for": "203.0.113.9" },
        { "x-real-ip": "203.0.113.10" },
        { [REMOTE_ADDR_HEADER]: "198.51.100.4" },
      ];
      for (const headers of attempts) {
        renderPdf.mockResolvedValueOnce(PDF_BYTES);
        expect((await anonymously(headers)).status, JSON.stringify(headers)).toBe(200);
      }

      expect(renderPdf.mock.calls.map((args) => args[1])).toEqual(attempts.map(() => ({ signal: expect.any(AbortSignal), userId: undefined })));
    });

    it("counts every API token of a user, and an embedded session that rests on one, as that user", async () => {
      // Real tokens through the real lookup: nothing here stands in for the access check but the absent browser session.
      const first = await createApiToken(actor!.id, "First script");
      const second = await createApiToken(actor!.id, "Second script");
      const readOnly = await createApiToken(actor!.id, "Reader", { scope: "read" });
      const oneDocument = await createApiToken(actor!.id, "One document", { documentIds: [sharedId] });
      const embed = await mintSessionCookie({ id: actor!.id, login: actor!.login, name: actor!.name, image: null, embedTokenId: first.id, embedDocumentId: sharedId, embedParentOrigin: "http://127.0.0.1:4100" }, false);
      const attempts: Array<Record<string, string>> = [
        { authorization: `Bearer ${first.token}` },
        { authorization: `Bearer ${second.token}` },
        { authorization: `Bearer ${readOnly.token}` },
        { authorization: `Bearer ${oneDocument.token}` },
        { cookie: `${embed.name}=${embed.value}` },
      ];
      for (const headers of attempts) {
        renderPdf.mockResolvedValueOnce(PDF_BYTES);
        expect((await anonymously(headers)).status, Object.keys(headers)[0]).toBe(200);
      }

      // One user is one caller however it asks: minting tokens does not multiply a share of the renderer,
      // and a token does not turn its user into one of the callers without a session.
      expect(renderPdf.mock.calls.map((args) => args[1]?.userId)).toEqual(attempts.map(() => actor!.id));
    });

    it("takes the caller from the access check alone: with a made-up value in every header a request can carry, nobody is still nobody and a user is still that user", async () => {
      const madeUp = (name: string) => `made-up ${name}`;
      const ask = async () => {
        const request = new Request(`http://localhost:3700/api/documents/${sharedId}/export?format=pdf`);
        vi.spyOn(request.headers, "get").mockImplementation(madeUp);
        const all = new Headers();
        vi.spyOn(all, "get").mockImplementation(madeUp);
        requestHeaders = all;
        renderPdf.mockResolvedValueOnce(PDF_BYTES);
        try {
          return await GET(request, { params: Promise.resolve({ id: sharedId }) });
        } finally {
          requestHeaders = new Headers();
        }
      };
      const user = actor!;

      expect((await ask()).status).toBe(200);
      actor = null;
      try {
        expect((await ask()).status).toBe(200);
      } finally {
        actor = user;
      }

      expect(renderPdf.mock.calls.map((args) => args[1]?.userId)).toEqual([user.id, undefined]);
    });
  });

  it("answers 503 with Retry-After when the renderer has no room, gave this caller's place to another, or the wait was too long", async () => {
    for (const reason of ["queue-full", "place-given", "queue-wait"] as const) {
      renderPdf.mockRejectedValueOnce(new PdfBusyError(reason));

      const res = await call("?format=pdf");

      expect(res.status, reason).toBe(503);
      expect(res.headers.get("Retry-After"), reason).toBe(String(PDF_RETRY_AFTER_SECONDS));
      expect(res.headers.get("Content-Type"), reason).toContain("application/json");
      expect(await res.json(), reason).toEqual({ error: "PDF export is busy. Try again in a few seconds" });
    }
  });

  it("answers 503 without Retry-After when the render ran past its time limit", async () => {
    renderPdf.mockRejectedValueOnce(new PdfBusyError("render-timeout"));

    const res = await call("?format=pdf");

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(await res.json()).toEqual({ error: "This PDF took longer than 60 seconds to make and was stopped" });
  });

  it("answers quietly when the caller went away", async () => {
    renderPdf.mockRejectedValueOnce(new PdfCancelledError());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await call("?format=pdf");

      expect(res.status).toBe(499);
      expect(error, "a caller that left is not a server error").not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });


  describe("an upload whose bytes are not what it was stored as (#2290)", () => {
    // A row as uploads were stored before the upload rule compared bytes with the declared type:
    // text with an <svg> root, kept under image/png.
    const OLD_SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="teal"/></svg>');
    const OLD_SVG_B64 = Buffer.from(OLD_SVG).toString("base64");
    let oldDocId: string;

    beforeAll(async () => {
      const db = await getDb();
      oldDocId = (await createDocument({ ownerId: actor!.id, title: "Old upload", content: "# Old upload\n" })).id;
      await db.insert(schema.assets).values({ id: "oldupload0001", documentId: oldDocId, userId: actor!.id, name: "drawing.png", mime: "image/png", size: OLD_SVG.byteLength, sha256: "0".repeat(64), data: OLD_SVG });
      await setDocumentText(oldDocId, "# Old upload\n\n![the drawing](/api/assets/oldupload0001)\n");
    });

    const exportOld = (query: string) => GET(new Request(`http://localhost:3700/api/documents/${oldDocId}/export${query}`), { params: Promise.resolve({ id: oldDocId }) });

    it("is left out of the page that goes to Chromium and shows as its alt text", async () => {
      renderPdf.mockResolvedValueOnce(PDF_BYTES);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect((await exportOld("?format=pdf")).status).toBe(200);
        const page = await pageOf();

        expect(page).toContain('<span class="image-left-out">the drawing</span>');
        expect(page).not.toContain(OLD_SVG_B64);
        expect(page).not.toContain("<img");
        expect(warn).toHaveBeenCalledWith("[pdf] 1 image(s) left out: content is not an allowed image type; 0 inlined under the type its bytes are");
      } finally {
        warn.mockRestore();
      }
    });

    it("stays as it was in the HTML download and in the HTML export for browsers", async () => {
      const download = await (await exportOld("?format=html&download=1")).text();
      expect(download).toContain(`<img src="data:image/png;base64,${OLD_SVG_B64}" alt="the drawing">`);

      const inBrowser = await (await exportOld("?format=html")).text();
      expect(inBrowser).toContain('<img src="http://localhost:3700/api/assets/oldupload0001" alt="the drawing">');
      expect(renderPdf).not.toHaveBeenCalled();
    });
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