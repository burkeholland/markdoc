import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { distinctPng } from "../assets.fixtures";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("../db");
const { putAsset } = await import("../assets");
const { renderDocumentHtml, MAX_INLINE_ASSET_BYTES } = await import("./html");
const { UnrenderableDocumentError } = await import("@/editor/markdown/renderable");

// Smallest valid PNG (1x1 transparent pixel).
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Uint8Array.from(Buffer.from(PNG_B64, "base64"));
// Distinct bytes standing in for another user's private image.
const SECRET_PNG_B64 = Buffer.from(distinctPng("PNG-secret-bytes-that-must-not-leak")).toString("base64");
const SECRET_PNG = Uint8Array.from(Buffer.from(SECRET_PNG_B64, "base64"));

const BASE = "https://docs.example.com";

const render = (markdown: string, extra: Partial<Parameters<typeof renderDocumentHtml>[0]> = {}) =>
  renderDocumentHtml({ title: "Test <Doc>", markdown, assetBaseUrl: BASE, ...extra });

describe("renderDocumentHtml", () => {
  it("produces a full standalone document with a title and embedded styles", async () => {
    const html = await render("# Hello");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain("<title>Test &lt;Doc&gt;</title>");
    expect(html).toContain("<style>");
    expect(html).toContain("@media print");
    expect(html).toContain("</html>");
    expect(html).not.toMatch(/<link[^>]+href="http/);
  });

  it("renders headings, lists, tables, task lists, code and strikethrough like the editor", async () => {
    const md = [
      "---",
      "title: front",
      "---",
      "# Title",
      "",
      "Some ~~old~~ text and https://example.com autolink.",
      "",
      "- one",
      "- two",
      "",
      "Tasks:",
      "",
      "- [x] done",
      "- [ ] todo",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```ts",
      "const x: number = 1;",
      "```",
      "",
      "Inline `code` here.",
    ].join("\n");
    const html = await render(md);
    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain("<del>old</del>");
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
    expect(html).toMatch(/<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
    expect(html).toContain('<input type="checkbox" checked disabled aria-label="done">');
    expect(html).toContain('<input type="checkbox" disabled aria-label="todo">');
    expect(html).toMatch(/<table>[\s\S]*<th>A<\/th>[\s\S]*<td>2<\/td>[\s\S]*<\/table>/);
    expect(html).toMatch(/<pre><code class="[^"]*language-ts[^"]*">/);
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain("<code>code</code>");
    expect(html).not.toContain("title: front");
  });

  it("strips scripts and event handlers", async () => {
    const md = [
      "# Safe",
      "",
      '<script>alert("x")</script>',
      "",
      '<img src="https://example.com/a.png" onerror="alert(1)">',
      "",
      '<a href="javascript:alert(1)">click</a>',
      "",
      '<p onclick="evil()">para</p>',
    ].join("\n");
    const html = await render(md);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(");
    expect(html).not.toMatch(/onerror|onclick/);
    expect(html).not.toContain("javascript:");
  });

  it("rewrites asset URLs to absolute URLs by default", async () => {
    const html = await render("![shot](/api/assets/abc123)\n\n![ext](https://cdn.example.com/x.png)");
    expect(html).toContain(`<img src="${BASE}/api/assets/abc123" alt="shot">`);
    expect(html).toContain('<img src="https://cdn.example.com/x.png" alt="ext">');
  });

  describe("inline assets", () => {
    let assetId: string;
    let foreignAssetId: string;

    beforeAll(async () => {
      const db = await getDb();
      const [user] = await db.insert(schema.users).values({ name: "Exp", login: "exp", email: "exp@example.com" }).returning();
      await db.insert(schema.documents).values({ id: "export-doc", title: "Export", ownerId: user.id, content: "" });
      const stored = await putAsset({ documentId: "export-doc", userId: user.id, name: "dot.png", mime: "image/png", bytes: PNG });
      assetId = stored.id;

      // Another user's private document with its own image: referencing its id must not leak the bytes.
      const [other] = await db.insert(schema.users).values({ name: "Other", login: "other", email: "other@example.com" }).returning();
      await db.insert(schema.documents).values({ id: "secret-doc", title: "Secret", ownerId: other.id, content: "" });
      const secret = await putAsset({ documentId: "secret-doc", userId: other.id, name: "secret.png", mime: "image/png", bytes: SECRET_PNG });
      foreignAssetId = secret.id;
    });

    it("embeds stored images as data: URIs when inlineAssets is set", async () => {
      const html = await render(`![dot](/api/assets/${assetId})\n\n![missing](/api/assets/nope)`, { inlineAssets: { documentId: "export-doc" } });
      expect(html).toContain(`<img src="data:image/png;base64,${PNG_B64}" alt="dot">`);
      expect(html).toContain(`<img src="${BASE}/api/assets/nope" alt="missing">`);
    });

    it("leaves another document's asset as a URL instead of inlining bytes the exporter may not view", async () => {
      const html = await render(`![mine](/api/assets/${assetId})\n\n![theirs](/api/assets/${foreignAssetId})`, { inlineAssets: { documentId: "export-doc" } });
      expect(html).toContain(`<img src="data:image/png;base64,${PNG_B64}" alt="mine">`);
      expect(html).toContain(`<img src="${BASE}/api/assets/${foreignAssetId}" alt="theirs">`);
      expect(html).not.toContain(SECRET_PNG_B64);
      // The same id *is* inlined when the owning document exports.
      const own = await render(`![theirs](/api/assets/${foreignAssetId})`, { inlineAssets: { documentId: "secret-doc" } });
      expect(own).toContain(`<img src="data:image/png;base64,${SECRET_PNG_B64}" alt="theirs">`);
    });

    it("stops embedding at the byte budget and keeps the remaining images as URLs", async () => {
      const db = await getDb();
      const [user] = await db.select().from(schema.users).where(eq(schema.users.login, "exp"));
      await db.insert(schema.documents).values({ id: "budget-doc", title: "Budget", ownerId: user.id, content: "" });
      const blobs = ["a", "b", "c"].map((c) => distinctPng(c.repeat(13)));
      const ids: string[] = [];
      for (const [i, bytes] of blobs.entries()) {
        ids.push((await putAsset({ documentId: "budget-doc", userId: user.id, name: `${i}.png`, mime: "image/png", bytes })).id);
      }
      const markdown = ids.map((id, i) => `![img${i}](/api/assets/${id})`).join("\n\n");
      const html = await render(markdown, { inlineAssets: { documentId: "budget-doc", maxBytes: 250 } });
      expect(html).toContain(`<img src="data:image/png;base64,${Buffer.from(blobs[0]).toString("base64")}" alt="img0">`);
      expect(html).toContain(`<img src="data:image/png;base64,${Buffer.from(blobs[1]).toString("base64")}" alt="img1">`);
      expect(html).toContain(`<img src="${BASE}/api/assets/${ids[2]}" alt="img2">`);
      expect(MAX_INLINE_ASSET_BYTES).toBe(64 * 1024 * 1024);
    });
  });

  describe("pathological input (#115)", () => {
    const BRACKETS = "[".repeat(40_000) + "a" + "]".repeat(40_000);

    it("refuses 40k unbalanced brackets in well under 2 s instead of parsing them for ~40 s", async () => {
      const started = performance.now();
      await expect(render(BRACKETS)).rejects.toBeInstanceOf(UnrenderableDocumentError);
      expect(performance.now() - started).toBeLessThan(2_000);
    });

    it("refuses 40k alternating emphasis markers", async () => {
      await expect(render("*a".repeat(40_000))).rejects.toMatchObject({ reason: "emphasis" });
    });

    it("keeps the event loop free while a document renders", { retry: 1 }, async () => {
      // A big but legal document: many paragraphs, each under the guard's limits.
      const md = Array.from({ length: 200 }, (_, i) => `## Section ${i}\n\n${"[a](b) **b** _c_ ".repeat(60)}\n`).join("\n");
      let worstGap = 0;
      let last = performance.now();
      const ticker = setInterval(() => {
        const now = performance.now();
        worstGap = Math.max(worstGap, now - last);
        last = now;
      }, 5);
      const started = performance.now();
      let renderMs = 0;
      try {
        const html = await render(md);
        renderMs = performance.now() - started;
        expect(html).toContain('<h2 id="section-199">Section 199</h2>');
      } finally {
        clearInterval(ticker);
        // Close the measurement at the moment the render resolved: a render that held the loop until it
        // finished never let the ticker fire, so this last stretch (≈ renderMs) is the gap that matters.
        worstGap = Math.max(worstGap, performance.now() - last);
      }
      // Two bounds (task #1190; the old absolute `< 100 ms` failed on a saturated box with a 208 ms gap that
      // was the test process being starved, not the render holding the loop):
      // - relative: a render on this thread gives worstGap ≈ renderMs, so it fails; a starved-but-free loop
      //   gives gaps far below half the render (idle 5–20 ms against a 1–2 s render);
      // - absolute cap: no starvation gap reaches 2 s, and a blocked loop cannot stay under it for a document
      //   this size, so it stays meaningful should the relative bound ever be loosened.
      const detail = `worst gap ${worstGap.toFixed(1)} ms during a ${renderMs.toFixed(0)} ms render`;
      expect(worstGap, detail).toBeLessThan(Math.max(100, renderMs / 2));
      expect(worstGap, detail).toBeLessThan(2_000);
    });

    it("gives up on a render that exceeds its time budget", async () => {
      // Bypass the guard: split the brackets over paragraphs so no single one exceeds the limit, but
      // ask for an impossible budget. The worker is terminated and a fresh one serves the next render.
      const md = Array.from({ length: 50 }, () => "[".repeat(900) + "a" + "]".repeat(900)).join("\n\n");
      await expect(render(md, { timeoutMs: 1 })).rejects.toMatchObject({ reason: "timeout" });
      expect(await render("# After")).toContain('<h1 id="after">After</h1>');
    });
  });
});
