import { describe, expect, it, beforeAll } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("../db");
const { putAsset } = await import("../assets");
const { renderDocumentHtml } = await import("./html");

// Smallest valid PNG (1x1 transparent pixel).
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Uint8Array.from(Buffer.from(PNG_B64, "base64"));

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
    expect(html).toContain('<input type="checkbox" checked disabled>');
    expect(html).toContain('<input type="checkbox" disabled>');
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

    beforeAll(async () => {
      const db = await getDb();
      const [user] = await db.insert(schema.users).values({ name: "Exp", login: "exp", email: "exp@example.com" }).returning();
      await db.insert(schema.documents).values({ id: "export-doc", title: "Export", ownerId: user.id, content: "" });
      const stored = await putAsset({ documentId: "export-doc", userId: user.id, name: "dot.png", mime: "image/png", bytes: PNG });
      assetId = stored.id;
    });

    it("embeds stored images as data: URIs when inlineAssets is set", async () => {
      const html = await render(`![dot](/api/assets/${assetId})\n\n![missing](/api/assets/nope)`, { inlineAssets: true });
      expect(html).toContain(`<img src="data:image/png;base64,${PNG_B64}" alt="dot">`);
      expect(html).toContain(`<img src="${BASE}/api/assets/nope" alt="missing">`);
    });
  });
});
