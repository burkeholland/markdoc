import { describe, expect, it, beforeAll, vi } from "vitest";
import * as Y from "yjs";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Same stand-ins as star.test.ts: the route resolves the caller through next-auth and `next/headers`.
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { eq, inArray, sql } = await import("drizzle-orm");
const { listVersions, updateDocument } = await import("@/server/documents");
const { getAsset } = await import("@/server/assets");
const { TEXT_KEY, hydrateDoc } = await import("@/server/collab/seed");
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
  validateImportFiles,
  IMPORT_EXTENSIONS,
  MAX_IMPORT_BYTES,
} = await import("@/server/import-file");
const { POST } = await import("@/app/api/import/file/route");
const { GET: listDocuments } = await import("@/app/api/documents/route");
const { DOCUMENT_TITLE_MAX } = await import("@/server/document-title");

// 1x1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const bytes = (s: string) => new TextEncoder().encode(s);

/** The text an editor would see: decoded from the authoritative `ystate`, not from `content`. */
function textFromYstate(ystate: Uint8Array | null, content: string, title: string): string {
  const doc = new Y.Doc();
  try {
    hydrateDoc(doc, ystate, content, title);
    return doc.getText(TEXT_KEY).toString();
  } finally {
    doc.destroy();
  }
}

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

  it.each<[string, string, string | null]>([
    ["four-backtick opener with a shorter inner fence", "````markdown\n```\n# Not the document title\n````\n# Real title\n", "Real title"],
    ["four-tilde opener with a shorter inner fence", "~~~~markdown\n~~~\n# Not the document title\n~~~~\n# Real title\n", "Real title"],
    ["shorter backticks without a real H1", "````\n```\n# Not the document title\n````\n", null],
    ["shorter tildes without a real H1", "~~~~\n~~~\n# Not the document title\n~~~~\n", null],
    ["tildes inside backticks", "```\n~~~~\n# Not the document title\n```\n# Real title\n", "Real title"],
    ["backticks inside tildes", "~~~\n````\n# Not the document title\n~~~\n# Real title\n", "Real title"],
    ["tildes cannot close unclosed backticks", "```\n~~~\n# Not the document title\n", null],
    ["backticks cannot close unclosed tildes", "~~~\n```\n# Not the document title\n", null],
    ["content after backticks is not a close", "```\n```markdown\n# Not the document title\n```\n# Real title\n", "Real title"],
    ["content after tildes is not a close", "~~~\n~~~ markdown\n# Not the document title\n~~~\n# Real title\n", "Real title"],
    ["content after longer backticks is not a close", "```\n```` \ttext\n# Not the document title\n", null],
    ["content after longer tildes is not a close", "~~~\n~~~~ \ttext\n# Not the document title\n", null],
    ["longer backtick close", "```\n# Not the document title\n````` \t\n# Real title\n", "Real title"],
    ["longer tilde close", "~~~\n# Not the document title\n~~~~~\t \n# Real title\n", "Real title"],
    ["unclosed backticks", "```markdown\n# Not the document title\n", null],
    ["unclosed tildes", "~~~ markdown\n# Not the document title\n", null],
    ["backtick info string", "``` \tmarkdown example ~~~\n# Not the document title\n```\n# Real title\n", "Real title"],
    ["tilde info string with backticks", "~~~ \tmarkdown `example`\n# Not the document title\n~~~\n# Real title\n", "Real title"],
    ["backticks invalidate an adjacent backtick info string", "```markdown`example\n# Real title\n", "Real title"],
    ["backticks invalidate a spaced backtick info string", "``` markdown ```\n# Real title\n", "Real title"],
    ["opening and closing indentation can differ", "   ```\n# Not the document title\n```\n# Real title\n", "Real title"],
    ["consecutive fences reset marker and length", "````markdown\n~~~\n# Not the document title\n````\n~~~\n```\n# Also not the title\n~~~~\n# Real title\n", "Real title"],
    ["front matter does not open a fence", "---\n````\n# Not the document title\n---\n# Real title\n", "Real title"],
    ["an empty stripped H1 still stops title search", "~~~\n# Not the document title\n~~~\n# **\n# Later heading\n", null],
  ])("chooses an H1 outside fenced code: %s", (_name, content, heading) => {
    expect(firstHeading(content)).toBe(heading);
    expect(titleForImport(content, "examples.md")).toBe(heading ?? "examples");
  });

  describe.each(["```", "~~~"])("%s fence whitespace", (marker) => {
    it.each([0, 1, 2, 3])("accepts %i leading spaces and trailing spaces/tabs", (spaces) => {
      const indent = " ".repeat(spaces);
      const content = `${indent}${marker}markdown\n# Not the document title\n${indent}${marker} \t\n# Real title\n`;
      expect(firstHeading(content)).toBe("Real title");
      expect(titleForImport(content, "examples.md")).toBe("Real title");
    });

    it.each([
      ["four spaces", "    "],
      ["tab", "\t"],
      ["space and tab", " \t"],
      ["two spaces and tab", "  \t"],
      ["three spaces and tab", "   \t"],
      ["non-breaking space", "\u00a0"],
      ["em space", "\u2003"],
    ])("does not open or close with %s indentation", (_name, indent) => {
      const invalidOpen = `${indent}${marker}\n# Real title\n`;
      expect(firstHeading(invalidOpen)).toBe("Real title");
      expect(titleForImport(invalidOpen, "examples.md")).toBe("Real title");
      const invalidClose = `${marker}\n${indent}${marker}\n# Not the document title\n`;
      expect(firstHeading(invalidClose)).toBeNull();
      expect(titleForImport(invalidClose, "examples.md")).toBe("examples");
    });

    it.each(["\u00a0", "\u2003", "\v"])("does not close with non-space/tab suffix %j", (suffix) => {
      const content = `${marker}\n${marker}${suffix}\n# Not the document title\n${marker}\n# Real title\n`;
      expect(firstHeading(content)).toBe("Real title");
      expect(titleForImport(content, "examples.md")).toBe("Real title");
    });
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

  describe("oversized titles are clipped to the document-title maximum", () => {
    const long = "A".repeat(10_000);
    const clipped = "A".repeat(DOCUMENT_TITLE_MAX);

    it("from a Markdown H1, keeping the full heading in the content", async () => {
      const text = `# ${long}\n\nbody\n`;
      expect(titleForImport(text, "notes.md")).toBe(clipped);
      const out = await convertImport({ name: "notes.md", text, format: "markdown" });
      expect(out.title).toBe(clipped);
      expect(out.content).toBe(text);
    });

    it("from YAML front matter", async () => {
      const text = `---\ntitle: ${long}\n---\n\n# Heading\n`;
      expect(titleForImport(text, "notes.md")).toBe(clipped);
      expect((await convertImport({ name: "notes.md", text, format: "markdown" })).title).toBe(clipped);
    });

    it("from an HTML <h1> and from <title>", async () => {
      const h1 = await convertImport({ name: "page.html", text: `<html><head><title>Short</title></head><body><h1>${long}</h1><p>x</p></body></html>`, format: "html" });
      expect(h1.title).toBe(clipped);
      expect(h1.content).toContain(`# ${long}`);
      const title = await convertImport({ name: "page.html", text: `<html><head><title>${long}</title></head><body><p>x</p></body></html>`, format: "html" });
      expect(title.title).toBe(clipped);
    });

    it("from the file name and from an explicit title", async () => {
      expect(titleForImport("just text\n", `${long}.md`)).toBe(clipped);
      expect((await convertImport({ name: `${long}.txt`, text: "x\n", format: "text" })).title).toBe(clipped);
      expect((await convertImport({ name: "x.md", text: "# H\n", format: "markdown", title: long })).title).toBe(clipped);
    });

    it("trims whitespace left at the cut, deterministically", async () => {
      const words = "word ".repeat(60); // the 200th character is a space
      const out = await convertImport({ name: "x.md", text: `# ${words}\n`, format: "markdown" });
      expect(out.title.length).toBeLessThanOrEqual(DOCUMENT_TITLE_MAX);
      expect(out.title).toBe(out.title.trimEnd());
      expect(out.title.endsWith("word")).toBe(true);
      expect((await convertImport({ name: "x.md", text: `# ${words}\n`, format: "markdown" })).title).toBe(out.title);
    });
  });
});

describe("convertImport", () => {
  it("normalises CRLF and BOM to LF and keeps front matter in the body", async () => {
    expect(normalizeLineEndings("\uFEFFa\r\nb\rc\n")).toBe("a\nb\nc\n");
    const out = await convertImport({ name: "x.md", text: "---\r\ntitle: T\r\n---\r\n# H\r\n\r\nbody", format: "markdown" });
    expect(out.title).toBe("T");
    expect(out.content).toBe("---\ntitle: T\n---\n# H\n\nbody\n");
  });

  it.each([
    ["shorter inner backticks", "````markdown\n```\n# Not the document title\n````\n# Real *title*\n", "Real title"],
    ["opposite marker and content-bearing close", "~~~markdown\n```\n~~~~ example\n# Not the document title\n~~~\n# Real title\n", "Real title"],
    ["unclosed code", "````markdown\n```\n# Not the document title\n", "examples"],
  ])("preserves the body with %s across LF and BOM/CRLF input", async (_name, content, title) => {
    for (const text of [content, "\uFEFF" + content.replace(/\n/g, "\r\n").trimEnd()]) {
      const out = await convertImport({ name: "examples.md", text, format: "markdown" });
      expect(out.title).toBe(title);
      expect(out.content).toBe(content);
      expect(out.warnings).toEqual([]);
    }
  });

  it("keeps explicit and front-matter title precedence over the unfenced H1", async () => {
    const content = "---\ntitle: Front matter title\n---\n````markdown\n```\n# Not the document title\n````\n# Real title\n";
    expect(titleForImport(content, "examples.md")).toBe("Front matter title");
    for (const [title, expected] of [["Explicit title", "Explicit title"], [" \t", "Front matter title"]]) {
      const out = await convertImport({ name: "examples.md", text: content, format: "markdown", title });
      expect(out.title).toBe(expected);
      expect(out.content).toBe(content);
    }
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

  it("names every importable extension in the 415 message", async () => {
    // Derived from IMPORT_EXTENSIONS, so an extension that is accepted can never be missing from the list.
    expect(IMPORT_EXTENSIONS.length).toBeGreaterThan(0);
    let error: unknown;
    try {
      validateImportFiles([{ name: "notes.rst", size: 1 }]);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ status: 415 });
    const message = (error as Error).message;
    expect(message).toContain("“notes.rst”");
    // Whole tokens, so ".md" is not satisfied by ".mdown" nor ".htm" by ".html".
    const listed = message.split(/[\s,]+/);
    for (const ext of IMPORT_EXTENSIONS) expect(listed, `415 message lists ${ext}`).toContain(ext);
    await expect(importFiles({ ownerId: owner.id, files: [{ name: "notes.rst", bytes: bytes("x") }] })).rejects.toMatchObject({ status: 415, message });
  });

  it("uploads matching images as assets, rewrites them and warns about the rest", async () => {
    const md = "# Trip\n\n![Beach](./photos/beach.png)\n\n![Lost](missing.png) ![Also](other/gone.jpg)\n";
    const {
      documents: [doc],
    } = await importFiles({
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
    // ystate is what the editor actually shows; the rewrite must land there too (regression from #288).
    const shown = textFromYstate(row.ystate ?? null, row.content, row.title);
    expect(shown).toBe(row.content);
    expect(shown).toContain(`![Beach](${m![1]})`);
    expect(shown).not.toContain("beach.png");
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

  it("updateDocument refuses a content write that leaves ystate behind", async () => {
    const doc = await importText({ ownerId: owner.id, content: "# Guarded\n", format: "markdown" });
    await expect(updateDocument(doc.id, { content: "# Changed\n" })).rejects.toThrow(/ystate/);
    // Other fields still go through.
    await expect(updateDocument(doc.id, { title: "Renamed" })).resolves.toMatchObject({ title: "Renamed" });
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

  it("stores a bounded title for a huge H1 and never lists it unbounded", async () => {
    actor = owner;
    try {
      const long = "A".repeat(10_000);
      const content = `# ${long}\n\nbody\n`;
      const res = await POST(
        new Request("http://localhost:3700/api/import/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "markdown", content }),
        }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { documents: { id: string; title: string }[] };
      const [imported] = body.documents;
      expect(imported.title).toBe("A".repeat(DOCUMENT_TITLE_MAX));

      // The body keeps the full heading; only the metadata is clipped.
      const db = await getDb();
      const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, imported.id));
      expect(row.title).toHaveLength(DOCUMENT_TITLE_MAX);
      expect(row.content).toBe(content);

      // The multipart path goes through the same rule.
      const form = new FormData();
      form.append("files", new File([bytes(content)], `${long}.md`, { type: "text/markdown" }));
      const upload = await post(form);
      expect(upload.status).toBe(201);
      const uploaded = (await upload.json()) as { documents: { id: string; title: string }[] };
      expect(uploaded.documents[0].title).toHaveLength(DOCUMENT_TITLE_MAX);

      for (const url of ["http://localhost:3700/api/documents", "http://localhost:3700/api/documents?q=AAAA"]) {
        const list = await listDocuments(new Request(url));
        expect(list.status).toBe(200);
        const listed = (await list.json()) as { documents: { id: string; title: string }[] };
        const mine = listed.documents.filter((d) => d.id === imported.id || d.id === uploaded.documents[0].id);
        expect(mine).toHaveLength(2);
        for (const d of listed.documents) expect(d.title.length).toBeLessThanOrEqual(DOCUMENT_TITLE_MAX);
      }
    } finally {
      actor = null;
    }
  });
});

/**
 * Make every `event` statement on `table` fail with a real database error (a trigger that raises), so the
 * same test runs unchanged against the unfixed code and the fix. Returns the undo.
 */
async function failingStatements(table: string, event: "insert" | "update", when?: string): Promise<() => Promise<void>> {
  const db = await getDb();
  await db.execute(sql.raw(`create or replace function markdoc_test_fail() returns trigger language plpgsql as $$ begin raise exception 'markdoc_test_fail: % on %', tg_op, tg_table_name; end $$`));
  const trigger = `markdoc_test_fail_${table}_${event}`;
  await db.execute(sql.raw(`create trigger ${trigger} before ${event} on "${table}" for each row ${when ? `when (${when}) ` : ""}execute function markdoc_test_fail()`));
  return async () => {
    await db.execute(sql.raw(`drop trigger ${trigger} on "${table}"`));
  };
}

describe("POST /api/import/file reports per-file failures and never leaves a half-made document (audit #1202 F10)", () => {
  const post = (form: FormData) => POST(new Request("http://localhost:3700/api/import/file", { method: "POST", body: form }));
  const file = (name: string, text: string) => new File([bytes(text)], name, { type: "text/markdown" });
  type Body = { documents: { id: string; title: string; warnings: string[] }[]; failed: { index: number; name: string; error: string }[] };

  async function rowsTitled(titles: string[]) {
    const db = await getDb();
    return db.select({ id: schema.documents.id, title: schema.documents.title }).from(schema.documents).where(inArray(schema.documents.title, titles));
  }

  it("creates the files it can, lists the one it could not in `failed`, and the retry of that file is a clean start", async () => {
    actor = owner;
    const titles = ["F10 one", "F10 two", "F10 three"];
    // The second document's text rewrite (setDocumentText, after its asset was stored) fails.
    const undo = await failingStatements("document", "update", "new.title = 'F10 two'");
    try {
      const form = new FormData();
      for (const [i, title] of titles.entries()) form.append("files", file(`f10-${i + 1}.md`, `# ${title}\n\n![dot](dot.png)\n`));
      form.append("images", new File([PNG], "dot.png", { type: "image/png" }));
      const res = await post(form);
      expect(res.status).toBe(201);
      const body = (await res.json()) as Body;
      expect(body.documents.map((d) => d.title)).toEqual(["F10 one", "F10 three"]);
      expect(body.failed).toEqual([{ index: 1, name: "f10-2.md", error: "Unexpected error" }]);

      // Exactly the two reported documents exist, each with its rewritten text, asset and version; the failed one left nothing.
      const rows = await rowsTitled(titles);
      expect(rows.map((r) => r.title).sort()).toEqual(["F10 one", "F10 three"]);
      const db = await getDb();
      for (const d of body.documents) {
        const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, d.id));
        expect(row.content).toMatch(/!\[dot\]\(\/api\/assets\/[a-z0-9]+\)/);
        expect(await db.select().from(schema.assets).where(eq(schema.assets.documentId, d.id))).toHaveLength(1);
        expect((await listVersions(d.id)).map((v) => v.title)).toEqual([`Imported from ${d.title === "F10 one" ? "f10-1.md" : "f10-3.md"}`]);
      }
    } finally {
      await undo();
      actor = null;
    }

    actor = owner;
    try {
      const form = new FormData();
      form.append("files", file("f10-2.md", "# F10 two\n\n![dot](dot.png)\n"));
      form.append("images", new File([PNG], "dot.png", { type: "image/png" }));
      const res = await post(form);
      expect(res.status).toBe(201);
      const body = (await res.json()) as Body;
      expect(body.failed).toEqual([]);
      expect(body.documents.map((d) => d.title)).toEqual(["F10 two"]);
      expect((await rowsTitled(["F10 two"])).map((r) => r.id)).toEqual([body.documents[0].id]);
    } finally {
      actor = null;
    }
  });

  it("answers 500 and creates nothing when no file could be imported (multipart and JSON alike)", async () => {
    actor = owner;
    const undo = await failingStatements("version", "insert");
    try {
      const form = new FormData();
      form.append("files", file("all-a.md", "# F10 all a\n"));
      form.append("files", file("all-b.md", "# F10 all b\n"));
      const res = await post(form);
      expect(res.status).toBe(500);
      expect(await rowsTitled(["F10 all a", "F10 all b"]), "documents left behind by an import that answered 500").toEqual([]);

      const json = await POST(
        new Request("http://localhost:3700/api/import/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "# F10 all json\n", format: "markdown" }),
        }),
      );
      expect(json.status).toBe(500);
      expect(await rowsTitled(["F10 all json"]), "document left behind by a JSON import that answered 500").toEqual([]);
    } finally {
      await undo();
      actor = null;
    }
  });
});
