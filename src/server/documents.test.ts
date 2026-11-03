import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// duplicateDocument reads the live text through livedoc, whose registry pulls in the auth module.
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { and, eq, like, sql } = await import("drizzle-orm");
const { addVersion, createDocument, duplicateDocument, excerpt, isVersionNumberCollision, listVersions, setDocumentText } = await import("@/server/documents");
const { htmlToMarkdown } = await import("@/server/import-file");
const { putAsset } = await import("@/server/assets");

// 1x1 transparent PNG.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

/**
 * Make every `event` statement on `table` fail with a real database error (a trigger that raises), so
 * the same test runs unchanged against the unfixed code and the fix. Returns the undo.
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

/** The innermost message of an error chain (drizzle wraps the driver's error as `cause`). */
function rootMessage(err: unknown): string {
  let e = err;
  while (e && typeof e === "object" && "cause" in e && (e as { cause?: unknown }).cause) e = (e as { cause: unknown }).cause;
  return e instanceof Error ? e.message : String(e);
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

describe("excerpt (#158)", () => {
  it("keeps an image's alt text and drops its URL", () => {
    expect(excerpt("# Dropped doc\n\nHello ![pixel](./pixel.png) world.\n")).toBe("Hello pixel world.");
    expect(excerpt("# Dropped doc\n\nHello ![pixel](/api/assets/y7j816vpf1wvljmy) world.\n")).toBe("Hello pixel world.");
  });

  it("reads an imported HTML page as its rendered text: link text, no pipes, table cells joined by spaces", async () => {
    const md = await htmlToMarkdown(
      '<h1>HTML Title</h1><p>Para <strong>bold</strong> <a href="https://x.y">link</a></p><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>',
    );
    expect(excerpt(md)).toBe("Para bold link a b 1 2");
  });

  it("skips front matter, fenced code and headings and starts at the first real sentence", () => {
    const doc = [
      "",
      "---",
      "title: Notes",
      "tags: [a, b]",
      "---",
      "",
      "```js",
      "const hidden = '| not | shown |';",
      "```",
      "",
      "# Notes",
      "",
      "## Section",
      "",
      "> The first *real* sentence, with `code` and a <https://auto.link>.",
      "",
      "- [ ] a task",
    ].join("\n");
    expect(excerpt(doc)).toBe("The first real sentence, with code and a . a task");
  });

  it("falls back to heading text when the document has no prose, and is empty for an empty document", () => {
    expect(excerpt("# Only a title\n\n## And a section\n")).toBe("Only a title And a section");
    expect(excerpt("")).toBe("");
    expect(excerpt("\n\n")).toBe("");
  });

  it("is cut at 160 characters", () => {
    const long = "word ".repeat(100);
    const e = excerpt(long);
    expect(e.length).toBeLessThanOrEqual(160);
    expect(e.startsWith("word word")).toBe(true);
  });

  it("handles a 40k-`[` paragraph in well under 50 ms (#115 guard)", () => {
    const doc = `# Title\n\n${"[".repeat(40_000)}\n\nAfter the brackets.\n`;
    const t0 = performance.now();
    const e = excerpt(doc);
    const ms = performance.now() - t0;
    expect(e.startsWith("[[[")).toBe(true);
    expect(e.length).toBe(160);
    expect(ms).toBeLessThan(50);
  });
});

describe("create paths are transactional and addVersion survives the number race (audit #1202 F9 F11 G4)", () => {
  let ownerId: string;

  beforeAll(async () => {
    const db = await getDb();
    const [o] = await db.insert(schema.users).values({ name: "Tess", login: "tess", email: "tess-transactions@example.com" }).returning();
    ownerId = o.id;
  });

  it("creates a blank document with no persisted prompt when content is omitted", async () => {
    const doc = await createDocument({ ownerId });
    expect(doc.title).toBe("Untitled");
    expect(doc.content).toBe("");
  });

  it("duplicateDocument: when copying the assets fails, neither the copy nor its version exists (F9)", async () => {
    const source = await createDocument({ ownerId, title: "F9 source", content: "# F9 source\n\nplaceholder\n" });
    const asset = await putAsset({ documentId: source.id, userId: ownerId, name: "dot.png", mime: "image/png", bytes: PNG });
    await setDocumentText(source.id, `# F9 source\n\n![dot](${asset.url})\n`);

    const db = await getDb();
    const copies = () => db.select({ id: schema.documents.id }).from(schema.documents).where(and(eq(schema.documents.ownerId, ownerId), like(schema.documents.title, "Copy of F9 source%")));
    const copyVersions = () => db.select({ id: schema.versions.id }).from(schema.versions).where(eq(schema.versions.title, "Copied from F9 source"));
    expect(await copies()).toHaveLength(0);

    const undo = await failingStatements("asset", "insert");
    try {
      const err = await rejectionOf(duplicateDocument(source.id, ownerId));
      expect(rootMessage(err)).toMatch(/markdoc_test_fail: INSERT on asset/);
    } finally {
      await undo();
    }
    // Nothing changed: no "Copy of …" on the dashboard, no version for it. The retry then makes exactly one copy.
    expect(await copies(), "document rows for the failed copy").toHaveLength(0);
    expect(await copyVersions(), "version rows for the failed copy").toHaveLength(0);

    const copy = await duplicateDocument(source.id, ownerId);
    expect(await copies()).toEqual([{ id: copy.id }]);
    expect(await copyVersions()).toHaveLength(1);
    expect((await db.select().from(schema.assets).where(eq(schema.assets.documentId, copy.id))).map((a) => a.name)).toEqual(["dot.png"]);
  });

  it("createDocument (linked to GitHub): when recording the import version fails, no document row exists (F11)", async () => {
    const db = await getDb();
    const linked = () => db.select({ id: schema.documents.id }).from(schema.documents).where(eq(schema.documents.gistId, "gist-f11"));

    const undo = await failingStatements("version", "insert");
    try {
      const err = await rejectionOf(createDocument({ ownerId, content: "# F11 linked\n", storage: "gist", gistId: "gist-f11", gistFile: "linked.md" }));
      expect(rootMessage(err)).toMatch(/markdoc_test_fail: INSERT on version/);
    } finally {
      await undo();
    }
    expect(await linked(), "document rows for the failed linked import").toHaveLength(0);

    // The retry creates exactly one document with its "Imported from GitHub" version; the local path is unchanged.
    const doc = await createDocument({ ownerId, content: "# F11 linked\n", storage: "gist", gistId: "gist-f11", gistFile: "linked.md" });
    expect(await linked()).toEqual([{ id: doc.id }]);
    expect((await listVersions(doc.id)).map((v) => [v.number, v.kind, v.title])).toEqual([[1, "import", "Imported from GitHub"]]);
    const local = await createDocument({ ownerId, content: "# F11 local\n" });
    expect(await listVersions(local.id)).toHaveLength(0);
  });

  it("addVersion: two concurrent calls on one document both succeed with distinct consecutive numbers, 50 times (G4)", async () => {
    const doc = await createDocument({ ownerId, content: "# G4 race\n" });
    const runs = 50;
    const numbers: number[] = [];
    const rejections: string[] = [];
    for (let i = 0; i < runs; i++) {
      // Both read the same max before either inserts: on PGlite the two statement pairs interleave on the connection.
      const settled = await Promise.allSettled([
        addVersion({ documentId: doc.id, content: `agent ${i}\n`, kind: "named", title: `agent ${i}` }),
        addVersion({ documentId: doc.id, content: `auto ${i}\n`, kind: "auto" }),
      ]);
      for (const s of settled) {
        if (s.status === "fulfilled") numbers.push(s.value.number);
        else rejections.push(rootMessage(s.reason));
      }
    }
    expect(rejections, `${rejections.length} of ${runs * 2} calls rejected`).toEqual([]);
    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: runs * 2 }, (_, i) => i + 1));
    expect((await listVersions(doc.id)).map((v) => v.number)).toEqual(Array.from({ length: runs * 2 }, (_, i) => runs * 2 - i));
  });

  it("isVersionNumberCollision recognises the unique violation however the driver wraps it, and nothing else", () => {
    const pgStyle = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505", constraint: "version_doc_number_idx" });
    expect(isVersionNumberCollision(pgStyle)).toBe(true);
    expect(isVersionNumberCollision(new Error("Failed query", { cause: pgStyle }))).toBe(true);
    expect(isVersionNumberCollision(Object.assign(new Error("dup"), { code: "23505" }))).toBe(true);
    expect(isVersionNumberCollision(Object.assign(new Error("dup"), { code: "23505", constraint: "asset_document_sha_idx" }))).toBe(false);
    expect(isVersionNumberCollision(Object.assign(new Error("aborted"), { code: "25P02" }))).toBe(false);
    expect(isVersionNumberCollision(new Error("plain"))).toBe(false);
    expect(isVersionNumberCollision(null)).toBe(false);
  });
});
