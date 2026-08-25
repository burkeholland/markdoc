import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// The routes resolve the caller through next-auth and `next/headers`; `actor` is whoever the next request comes from.
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// Wrapped so one test can make the activity insert fail like the database would.
vi.mock("@/server/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/activity")>();
  return { ...actual, recordActivity: vi.fn(actual.recordActivity) };
});

const { getDb, schema } = await import("@/server/db");
const { eq } = await import("drizzle-orm");
const { createDocument } = await import("@/server/documents");
const { recordActivity } = await import("@/server/activity");
const { nulPaths, NUL_MESSAGE } = await import("@/server/http");
const { decodeImportBytes, importFiles } = await import("@/server/import-file");
const documents = await import("@/app/api/documents/route");
const document = await import("@/app/api/documents/[id]/route");
const content = await import("@/app/api/documents/[id]/content/route");
const comments = await import("@/app/api/documents/[id]/comments/route");
const suggest = await import("@/app/api/documents/[id]/suggest/route");
const versions = await import("@/app/api/documents/[id]/versions/route");
const tokens = await import("@/app/api/tokens/route");
const importFile = await import("@/app/api/import/file/route");

const BASE = "http://localhost:3700";
const NUL = "\u0000";
type Route = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const sendJson = (route: Route, method: string, path: string, body: unknown, id = "") =>
  route(new Request(`${BASE}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), params(id));
const postForm = (form: FormData) => importFile.POST(new Request(`${BASE}/api/import/file`, { method: "POST", body: form }), params(""));

type Issue = { path: (string | number)[]; message: string };
/** Asserts the 400 shape the docs promise and returns the offending paths. */
async function expectNulRefused(res: Response): Promise<(string | number)[][]> {
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; issues: Issue[] };
  expect(body.error).toBe("Invalid request");
  expect(body.issues.length).toBeGreaterThan(0);
  for (const issue of body.issues) expect(issue.message).toBe(NUL_MESSAGE);
  return body.issues.map((i) => i.path);
}

let owner: Actor;
let docId: string;

beforeAll(async () => {
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ name: "Nula", login: "nula", email: "nula@example.com" }).returning();
  owner = { id: o.id, login: "nula", name: "Nula", image: null };
  docId = (await createDocument({ ownerId: owner.id, title: "Hi", content: "# Hi\n\nbefore after\n" })).id;
  actor = owner;
});

afterEach(() => {
  vi.mocked(recordActivity).mockClear();
});

describe("nulPaths", () => {
  it("finds every string with a NUL, at any depth", () => {
    expect(nulPaths({ a: "ok", b: `x${NUL}y`, c: [1, "fine", { d: NUL }], e: null })).toEqual([["b"], ["c", 2, "d"]]);
    expect(nulPaths("plain")).toEqual([]);
    expect(nulPaths(NUL)).toEqual([[]]);
  });
});

describe("a NUL in a JSON text field is a 400 naming the field, and nothing is written", () => {
  it("POST /api/documents (content and title)", async () => {
    const db = await getDb();
    const before = (await db.select().from(schema.documents)).length;
    expect(await expectNulRefused(await sendJson(documents.POST, "POST", "/api/documents", { title: "nul", content: `# Hi\n\nbefore${NUL}after\n` }))).toEqual([["content"]]);
    expect(await expectNulRefused(await sendJson(documents.POST, "POST", "/api/documents", { title: `t${NUL}t` }))).toEqual([["title"]]);
    expect((await db.select().from(schema.documents)).length).toBe(before);
  });

  it("PUT and PATCH /api/documents/:id/content leave the text as it was", async () => {
    expect(await expectNulRefused(await sendJson(content.PUT, "PUT", `/api/documents/${docId}/content`, { content: `# Hi\n\nx${NUL}y\n` }, docId))).toEqual([["content"]]);
    expect(await expectNulRefused(await sendJson(content.PUT, "PUT", `/api/documents/${docId}/content`, { content: "# Hi\n", message: `v${NUL}1` }, docId))).toEqual([["message"]]);
    expect(await expectNulRefused(await sendJson(content.PATCH, "PATCH", `/api/documents/${docId}/content`, { append: `tail${NUL}` }, docId))).toEqual([["append"]]);
    const res = await content.GET(new Request(`${BASE}/api/documents/${docId}/content`), params(docId));
    expect(((await res.json()) as { content: string }).content).toBe("# Hi\n\nbefore after\n");
    const db = await getDb();
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, docId));
    expect(row.content).toBe("# Hi\n\nbefore after\n");
    expect(await db.select().from(schema.versions).where(eq(schema.versions.documentId, docId))).toHaveLength(0);
  });

  it("PATCH /api/documents/:id (title)", async () => {
    expect(await expectNulRefused(await sendJson(document.PATCH, "PATCH", `/api/documents/${docId}`, { title: `t${NUL}t` }, docId))).toEqual([["title"]]);
    const db = await getDb();
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, docId));
    expect(row.title).toBe("Hi");
  });

  it("POST /api/documents/:id/comments: no thread is created", async () => {
    expect(await expectNulRefused(await sendJson(comments.POST, "POST", `/api/documents/${docId}/comments`, { action: "add", quote: "Hi", body: `c${NUL}d` }, docId))).toEqual([["body"]]);
    expect(await expectNulRefused(await sendJson(comments.POST, "POST", `/api/documents/${docId}/comments`, { action: "add", quote: `H${NUL}i`, body: "fine" }, docId))).toEqual([["quote"]]);
    const res = await comments.GET(new Request(`${BASE}/api/documents/${docId}/comments`), params(docId));
    expect(((await res.json()) as { comments: unknown[] }).comments).toEqual([]);
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("POST /api/documents/:id/suggest: no suggestion carries the NUL", async () => {
    expect(await expectNulRefused(await sendJson(suggest.POST, "POST", `/api/documents/${docId}/suggest`, { edits: [{ find: "before", replace: `be${NUL}fore` }] }, docId))).toEqual([["edits", 0, "replace"]]);
    expect(await expectNulRefused(await sendJson(suggest.POST, "POST", `/api/documents/${docId}/suggest`, { content: `# Hi\n\n${NUL}\n` }, docId))).toEqual([["content"]]);
    const res = await content.GET(new Request(`${BASE}/api/documents/${docId}/content`), params(docId));
    const live = (await res.json()) as { content: string; pendingSuggestions: number };
    expect(live.pendingSuggestions).toBe(0);
    expect(live.content).not.toContain(NUL);
  });

  it("POST /api/documents/:id/versions and POST /api/tokens (names)", async () => {
    expect(await expectNulRefused(await sendJson(versions.POST, "POST", `/api/documents/${docId}/versions`, { title: `v${NUL}` }, docId))).toEqual([["title"]]);
    expect(await expectNulRefused(await sendJson(tokens.POST, "POST", "/api/tokens", { name: `agent${NUL}` }))).toEqual([["name"]]);
    const db = await getDb();
    expect(await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, owner.id))).toHaveLength(0);
  });

  it("POST /api/import/file as JSON", async () => {
    const res = await importFile.POST(new Request(`${BASE}/api/import/file`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `# A${NUL}\n`, format: "markdown" }) }), params(""));
    expect(await expectNulRefused(res)).toEqual([["content"]]);
  });

  it("GET /api/documents?q= with a NUL", async () => {
    const res = await documents.GET(new Request(`${BASE}/api/documents?q=a%00b`), params(""));
    expect(await expectNulRefused(res)).toEqual([["q"]]);
  });
});

describe("POST /api/import/file with uploaded bytes", () => {
  it("refuses a binary renamed .md as 415 without importing anything", async () => {
    const db = await getDb();
    const before = (await db.select().from(schema.documents)).length;
    const form = new FormData();
    form.append("files", new File([new Uint8Array([0x23, 0x20, 0x61, 0x00, 0x62])], "nul.md", { type: "text/markdown" }));
    const res = await postForm(form);
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "“nul.md” is not a text file" });
    expect((await db.select().from(schema.documents)).length).toBe(before);
  });

  it("a binary second file leaves the first one unimported too", async () => {
    const db = await getDb();
    const before = (await db.select().from(schema.documents)).length;
    const form = new FormData();
    form.append("files", new File([new TextEncoder().encode("# Fine\n")], "fine.md", { type: "text/markdown" }));
    form.append("files", new File([new Uint8Array([0x00, 0x01, 0x02])], "bin.md", { type: "text/markdown" }));
    expect((await postForm(form)).status).toBe(415);
    expect((await db.select().from(schema.documents)).length).toBe(before);
  });

  it("decodes UTF-16 with a byte-order mark (both endiannesses) and imports it", async () => {
    const form = new FormData();
    form.append("files", new File([Buffer.from("\ufeff# Hello UTF-16\n\nBody", "utf16le")], "u16.md", { type: "text/markdown" }));
    const res = await postForm(form);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { documents: { id: string; title: string }[] };
    expect(body.documents[0].title).toBe("Hello UTF-16");
    const db = await getDb();
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, body.documents[0].id));
    expect(row.content).toBe("# Hello UTF-16\n\nBody\n");

    const be = Buffer.from("\ufeff# Big endian\n", "utf16le").swap16();
    expect(decodeImportBytes("be.md", new Uint8Array(be))).toBe("# Big endian\n");
    const [doc] = await importFiles({ ownerId: owner.id, files: [{ name: "be.md", bytes: new Uint8Array(be) }] });
    expect(doc.title).toBe("Big endian");
  });

  it("UTF-8 with a BOM and plain UTF-8 still import as before", async () => {
    expect(decodeImportBytes("a.md", new Uint8Array([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x41]))).toBe("# A");
    expect(decodeImportBytes("a.md", new TextEncoder().encode("# Ünïcødé\n"))).toBe("# Ünïcødé\n");
    expect(() => decodeImportBytes("x.md", new Uint8Array([0x61, 0x00]))).toThrow(/not a text file/);
  });
});

describe("an unexpected error", () => {
  it("answers exactly { error: \"Unexpected error\" } and a failed comment leaves no thread behind", async () => {
    vi.mocked(recordActivity).mockRejectedValueOnce(new Error('Failed query: insert into "activity" ("id", "document_id") values ($1, $2) params: abc,secret-owner-uuid'));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await sendJson(comments.POST, "POST", `/api/documents/${docId}/comments`, { action: "add", quote: "Hi", body: "looks fine" }, docId);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Unexpected error" });
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
    const list = await comments.GET(new Request(`${BASE}/api/documents/${docId}/comments`), params(docId));
    expect(((await list.json()) as { comments: unknown[] }).comments).toEqual([]);
    const live = await content.GET(new Request(`${BASE}/api/documents/${docId}/content`), params(docId));
    expect(((await live.json()) as { openComments: number }).openComments).toBe(0);
  });

  it("a failed reply is taken back out, the thread stays", async () => {
    const added = await sendJson(comments.POST, "POST", `/api/documents/${docId}/comments`, { action: "add", quote: "Hi", body: "thread" }, docId);
    expect(added.status).toBe(200);
    const { id: threadId } = (await added.json()) as { id: string };
    vi.mocked(recordActivity).mockRejectedValueOnce(new Error("boom"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await sendJson(comments.POST, "POST", `/api/documents/${docId}/comments`, { action: "reply", threadId, body: "reply" }, docId);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Unexpected error" });
    } finally {
      errors.mockRestore();
    }
    const list = await comments.GET(new Request(`${BASE}/api/documents/${docId}/comments`), params(docId));
    const threads = ((await list.json()) as { comments: { id: string; replies: unknown[] }[] }).comments;
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(threadId);
    expect(threads[0].replies).toEqual([]);
  });
});
