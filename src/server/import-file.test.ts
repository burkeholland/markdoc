import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Same stand-ins as star.test.ts: the route resolves the caller through next-auth and `next/headers`.
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { eq } = await import("drizzle-orm");
const { listVersions } = await import("@/server/documents");
const { getAsset } = await import("@/server/assets");
const {
  convertImport,
  firstHeading,
  frontMatterTitle,
  htmlToMarkdown,
  importFiles,
  importFormatFor,
  importText,
  normalizeLineEndings,
  rewriteRelativeImages,
  titleForImport,
  MAX_IMPORT_BYTES,
} = await import("@/server/import-file");
const { POST } = await import("@/app/api/import/file/route");

// 1x1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const bytes = (s: string) => new TextEncoder().encode(s);

let owner: Actor;

beforeAll(async () => {
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ name: "Ingrid", login: "ingrid", email: "ingrid-import@example.com" }).returning();
  owner = { id: o.id, login: "ingrid", name: "Ingrid", image: null };
});

describe("titles", () => {
  it("prefers front matter, then the first H1, then the file name", () => {
    expect(titleForImport("---\ntitle: From Front Matter\n---\n\n# Heading\n", "notes.md")).toBe("From Front Matter");
    expect(titleForImport('---\ntitle: "Quoted"\n---\n# Heading\n', "notes.md")).toBe("Quoted");
    expect(titleForImport("intro\n\n# The *Real* Title\n\ntext", "notes.md")).toBe("The Real Title");
    expect(titleForImport("just text\n", "meeting-notes.md")).toBe("meeting-notes");
    expect(titleForImport("", "C:\\Users\\x\\plan.txt")).toBe("plan");
  });

  it("ignores H1-looking lines inside fenced code and missing front-matter titles", () => {
    expect(firstHeading("```\n# not a title\n```\n\n# Yes\n")).toBe("Yes");
    expect(frontMatterTitle("---\ndate: 2024-01-01\n---\n# H\n")).toBeNull();
    expect(frontMatterTitle("# H\n")).toBeNull();
  });

  it("maps extensions to formats", () => {
    expect(importFormatFor("a.md")).toBe("markdown");
    expect(importFormatFor("a.MARKDOWN")).toBe("markdown");
    expect(importFormatFor("a.txt")).toBe("text");
    expect(importFormatFor("a.html")).toBe("html");
    expect(importFormatFor("a.htm")).toBe("html");
    expect(importFormatFor("a.docx")).toBeNull();
    expect(importFormatFor("noext")).toBeNull();
  });
});

describe("convertImport", () => {
  it("normalises CRLF and BOM to LF and keeps front matter in the body", async () => {
    expect(normalizeLineEndings("\uFEFFa\r\nb\rc\n")).toBe("a\nb\nc\n");
    const out = await convertImport({ name: "x.md", text: "---\r\ntitle: T\r\n---\r\n# H\r\n\r\nbody", format: "markdown" });
    expect(out.title).toBe("T");
    expect(out.content).toBe("---\ntitle: T\n---\n# H\n\nbody\n");
  });

  it("wraps plain text as-is with paragraphs preserved", async () => {
    const out = await convertImport({ name: "todo.txt", text: "First paragraph.\n\nSecond one.\n", format: "text" });
    expect(out.title).toBe("todo");
    expect(out.content).toBe("First paragraph.\n\nSecond one.\n");
  });

  it("converts HTML to GFM Markdown", async () => {
    const html = `<!doctype html><html><head><title>Page Title</title><script>alert(1)</script><style>p{}</style></head><body>
      <h1>Hello <em>World</em></h1>
      <p>A <a href="https://example.com">link</a> and <strong>bold</strong> and <del>gone</del>.</p>
      <ul><li>one</li><li>two</li></ul>
      <ol><li>first</li><li>second</li></ol>
      <ul><li><input type="checkbox" checked disabled> done</li><li><input type="checkbox" disabled> open</li></ul>
      <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
      <img src="shot.png" alt="Shot">
      <pre><code class="language-js">const x = 1;</code></pre>
      <p onclick="evil()">safe</p>
      </body></html>`;
    const md = await htmlToMarkdown(html);
    expect(md).toContain("# Hello _World_");
    expect(md).toContain("[link](https://example.com)");
    expect(md).toContain("**bold**");
    expect(md).toContain("~~gone~~");
    expect(md).toContain("- one\n- two");
    expect(md).toContain("1. first\n2. second");
    expect(md).toContain("- [x] done");
    expect(md).toContain("- [ ] open");
    expect(md).toMatch(/\| A\s*\| B\s*\|\n\| -+ \| -+ \|\n\| 1\s*\| 2\s*\|/);
    expect(md).toContain("![Shot](shot.png)");
    expect(md).toContain("```js\nconst x = 1;\n```");
    expect(md).toContain("safe");
    expect(md).not.toContain("alert(1)");
    expect(md).not.toContain("<script");
    expect(md).not.toContain("onclick");
    expect(md).not.toContain("p{}");

    const out = await convertImport({ name: "page.html", text: html, format: "html" });
    expect(out.title).toBe("Hello World");
    const untitled = await convertImport({ name: "page.html", text: "<html><head><title>Only Title</title></head><body><p>x</p></body></html>", format: "html" });
    expect(untitled.title).toBe("Only Title");
  });
});

describe("rewriteRelativeImages", () => {
  it("rewrites relative paths by basename and reports the rest", () => {
    const urls = new Map([
      ["a.png", "/api/assets/aaa"],
      ["B.jpg", "/api/assets/bbb"],
    ]);
    const md = '![one](./a.png) ![two](images/b.jpg "cap") ![three](c.png) ![abs](/x/a.png) ![web](https://h/a.png) ![data](data:image/png;base64,AAA) ![again](c.png) ![d](sub/d.gif)';
    const { content, missing } = rewriteRelativeImages(md, urls);
    expect(content).toBe(
      '![one](/api/assets/aaa) ![two](/api/assets/bbb "cap") ![three](c.png) ![abs](/x/a.png) ![web](https://h/a.png) ![data](data:image/png;base64,AAA) ![again](c.png) ![d](sub/d.gif)',
    );
    expect(missing).toEqual(["c.png", "d.gif"]);
  });
});

describe("importFiles", () => {
  it("rejects unsupported types, oversize files and empty batches", async () => {
    await expect(importFiles({ ownerId: owner.id, files: [] })).rejects.toMatchObject({ status: 400 });
    await expect(importFiles({ ownerId: owner.id, files: [{ name: "doc.docx", bytes: bytes("x") }] })).rejects.toMatchObject({ status: 415 });
    await expect(importFiles({ ownerId: owner.id, files: [{ name: "big.md", bytes: new Uint8Array(MAX_IMPORT_BYTES + 1) }] })).rejects.toMatchObject({ status: 413 });
    await expect(importText({ ownerId: owner.id, content: "x".repeat(MAX_IMPORT_BYTES + 1), format: "text" })).rejects.toMatchObject({ status: 413 });
  });

  it("uploads matching images as assets, rewrites them and warns about the rest", async () => {
    const md = "# Trip\n\n![Beach](./photos/beach.png)\n\n![Lost](missing.png) ![Also](other/gone.jpg)\n";
    const [doc] = await importFiles({
      ownerId: owner.id,
      files: [{ name: "trip.md", bytes: bytes(md) }],
      images: [
        { name: "beach.png", mime: "image/png", bytes: PNG },
        { name: "unused.png", mime: "image/png", bytes: PNG },
      ],
    });
    expect(doc.title).toBe("Trip");
    expect(doc.warnings).toEqual(["2 images not found: missing.png, gone.jpg"]);

    const db = await getDb();
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    const m = /!\[Beach\]\((\/api\/assets\/[a-z0-9]+)\)/.exec(row.content);
    expect(m).not.toBeNull();
    expect(row.content).toContain("![Lost](missing.png)");
    const asset = await getAsset(m![1].split("/").pop()!);
    expect(asset?.documentId).toBe(doc.id);
    expect(Buffer.from(asset!.bytes).equals(PNG)).toBeTruthy();
    // Only referenced images become assets.
    const assets = await db.select().from(schema.assets).where(eq(schema.assets.documentId, doc.id));
    expect(assets).toHaveLength(1);

    const versions = await listVersions(doc.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].kind).toBe("import");
    expect(versions[0].title).toBe("Imported from trip.md");
  });

  it("importText creates a document from HTML with a given title", async () => {
    const doc = await importText({ ownerId: owner.id, title: "Given", content: "<h2>Sub</h2><p>para</p>", format: "html" });
    expect(doc.title).toBe("Given");
    const db = await getDb();
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(row.content).toBe("## Sub\n\npara\n");
    expect(row.ownerId).toBe(owner.id);
  });
});

describe("POST /api/import/file", () => {
  const post = (form: FormData) => POST(new Request("http://localhost:3700/api/import/file", { method: "POST", body: form }));

  it("requires sign in", async () => {
    actor = null;
    const form = new FormData();
    form.append("files", new File([bytes("# A\n")], "a.md", { type: "text/markdown" }));
    const res = await post(form);
    expect(res.status).toBe(401);
  });

  it("imports two files as two documents owned by the caller", async () => {
    actor = owner;
    try {
      const form = new FormData();
      form.append("files", new File([bytes("# First\n\nhello\r\n")], "first.md", { type: "text/markdown" }));
      form.append("files", new File([bytes("plain text\n")], "second.txt", { type: "text/plain" }));
      const res = await post(form);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { documents: { id: string; title: string; warnings: string[] }[] };
      expect(body.documents.map((d) => d.title)).toEqual(["First", "second"]);
      const db = await getDb();
      for (const d of body.documents) {
        const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, d.id));
        expect(row.ownerId).toBe(owner.id);
      }
      const [first] = await db.select().from(schema.documents).where(eq(schema.documents.id, body.documents[0].id));
      expect(first.content).toBe("# First\n\nhello\n");
    } finally {
      actor = null;
    }
  });

  it("rejects unsupported types and non-multipart bodies, and imports JSON text", async () => {
    actor = owner;
    try {
      const form = new FormData();
      form.append("files", new File([bytes("x")], "a.pdf", { type: "application/pdf" }));
      expect((await post(form)).status).toBe(415);
      const plain = await POST(new Request("http://localhost:3700/api/import/file", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" }));
      expect(plain.status).toBe(415);
      const res = await POST(
        new Request("http://localhost:3700/api/import/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "<h1>Agent Page</h1><p>hi</p>", format: "html" }),
        }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { documents: { id: string; title: string }[] };
      expect(body.documents[0].title).toBe("Agent Page");
    } finally {
      actor = null;
    }
  });
});
