import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;
delete process.env.GITHUB_MOCK;

/**
 * `POST /api/documents/:id/link` with `{ storage: "gist" }` and no `gistId` creates a gist and then
 * writes the link and a version row. Audit #1202 F7: the version row must not decide whether the
 * link exists — a failure there used to answer 500 with the document still `local` and an orphan
 * gist in the user's account, and the retry created a second one.
 */

// A hand-rolled GitHub that remembers every gist it was asked to create.
const gists = new Map<string, { filename: string; content: string }>();
vi.mock("@/server/github", () => ({
  isGitHubMock: () => false,
  githubClient: () => ({}),
  createGist: vi.fn(async (_o: unknown, input: { filename: string; content: string }) => {
    const gistId = `g${gists.size + 1}`;
    gists.set(gistId, { filename: input.filename, content: input.content });
    return { gistId, htmlUrl: `https://gist.github.com/${gistId}`, filename: input.filename };
  }),
  readGistFile: vi.fn(async (_o: unknown, gistId: string) => {
    const gist = gists.get(gistId);
    if (!gist) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { gistId, filename: gist.filename, content: gist.content, description: null, htmlUrl: `https://gist.github.com/${gistId}`, isPublic: false, owner: "o", revision: `${gistId}-rev`, updatedAt: null };
  }),
  updateGist: vi.fn(),
  readRepoFile: vi.fn(),
  commitRepoFile: vi.fn(),
}));
vi.mock("@/server/documents", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/documents")>();
  return { ...mod, getGitHubToken: async () => "token", updateDocument: vi.fn(mod.updateDocument), addVersion: vi.fn(mod.addVersion) };
});

type User = { id: string; login: string; name: string; image: null };
let user: User;
let actor: User | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { createDocument, updateDocument, addVersion, getDocumentAccess, getPublishedContent, listVersions } = await import("@/server/documents");
const { createGist } = await import("@/server/github");
const { linkDocument } = await import("@/server/publish");
const { POST: linkPost } = await import("@/app/api/documents/[id]/link/route");

const TEXT = "# Notes\n\nA paragraph.\n";
const post = (url: string, body: unknown) => new Request(`http://localhost:3700${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const dbDown = () => new Error("database unavailable (test)");
type LinkBody = { document: { storage: string; gistId: string | null; gistFile: string | null; githubUrl: string | null; hasUnpublishedChanges: boolean }; warnings?: string[]; error?: string };
const body = async (res: Response) => (await res.json()) as LinkBody;
const stored = async (id: string) => (await getDocumentAccess(id, user))!.doc;

beforeAll(async () => {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ name: "Ann", login: "ann", email: "ann-link@example.com" }).returning();
  user = { id: u.id, login: "ann", name: "Ann", image: null };
});

beforeEach(() => {
  actor = user;
  gists.clear();
  vi.mocked(createGist).mockClear();
});

afterEach(() => {
  actor = null;
  vi.mocked(updateDocument).mockReset();
  vi.mocked(addVersion).mockReset();
  vi.restoreAllMocks();
});

describe("POST /link to a new gist", () => {
  it("links, records the base and a 'Published to new gist' version; no warnings key", async () => {
    const doc = await createDocument({ ownerId: user.id, content: TEXT, title: "Notes" });
    const res = await linkPost(post(`/api/documents/${doc.id}/link`, { storage: "gist", isPublic: false }), params(doc.id));
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.warnings).toBeUndefined();
    expect(b.document).toMatchObject({ storage: "gist", gistId: "g1", gistFile: "notes.md", githubUrl: "https://gist.github.com/g1", hasUnpublishedChanges: false });
    expect(createGist).toHaveBeenCalledTimes(1);
    expect(gists.get("g1")).toEqual({ filename: "notes.md", content: TEXT });
    expect(await getPublishedContent(doc.id)).toBe(TEXT);
    const versions = await listVersions(doc.id);
    expect(versions[0]).toMatchObject({ title: "Published to new gist", kind: "publish" });
  });

  it("writes the link before the version row", async () => {
    const doc = await createDocument({ ownerId: user.id, content: TEXT });
    vi.mocked(updateDocument).mockClear();
    vi.mocked(addVersion).mockClear();
    await linkDocument(doc, user, { storage: "gist" });
    const linkWrite = vi.mocked(updateDocument).mock.invocationCallOrder[0];
    const versionWrite = vi.mocked(addVersion).mock.invocationCallOrder[0];
    expect(linkWrite).toBeDefined();
    expect(versionWrite).toBeDefined();
    expect(linkWrite).toBeLessThan(versionWrite);
  });

  it("a failed version row is a warning: 200, the document is linked to the one gist that was created", async () => {
    const doc = await createDocument({ ownerId: user.id, content: TEXT, title: "Notes" });
    const versions = (await listVersions(doc.id)).length;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(addVersion).mockRejectedValueOnce(dbDown());
    const res = await linkPost(post(`/api/documents/${doc.id}/link`, { storage: "gist", filename: "doc.md" }), params(doc.id));
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.warnings).toEqual(["version-not-saved"]);
    expect(b.document).toMatchObject({ storage: "gist", gistId: "g1", gistFile: "doc.md" });
    expect(createGist).toHaveBeenCalledTimes(1);
    expect(gists.size).toBe(1);
    const after = await stored(doc.id);
    expect(after.storage).toBe("gist");
    expect(after.gistId).toBe("g1");
    expect(after.githubSha).toBeNull();
    expect(await getPublishedContent(doc.id)).toBe(TEXT);
    expect((await listVersions(doc.id)).length).toBe(versions);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toBe("[link] version-not-saved");

    // Existing behaviour, unchanged: `link` does not refuse an already linked document — a second
    // `{ storage: "gist" }` call creates another gist and repoints the document at it.
    const again = await linkPost(post(`/api/documents/${doc.id}/link`, { storage: "gist", filename: "doc.md" }), params(doc.id));
    expect(again.status).toBe(200);
    const b2 = await body(again);
    expect(b2.warnings).toBeUndefined();
    expect(b2.document).toMatchObject({ storage: "gist", gistId: "g2" });
    expect(createGist).toHaveBeenCalledTimes(2);
    expect((await listVersions(doc.id))[0].title).toBe("Published to new gist");
  });

  it("a failed link write is still fatal: 500, the document stays local (the gist already exists on GitHub)", async () => {
    const doc = await createDocument({ ownerId: user.id, content: TEXT });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(updateDocument).mockRejectedValueOnce(dbDown());
    const res = await linkPost(post(`/api/documents/${doc.id}/link`, { storage: "gist" }), params(doc.id));
    expect(res.status).toBe(500);
    expect((await body(res)).error).toBe("Unexpected error");
    expect((await stored(doc.id)).storage).toBe("local");
    expect(createGist).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("an existing gist links with its content as the base, creates nothing and adds no version", async () => {
    gists.set("g9", { filename: "old.md", content: "# Old\n" });
    const doc = await createDocument({ ownerId: user.id, content: TEXT });
    const versions = (await listVersions(doc.id)).length;
    const res = await linkPost(post(`/api/documents/${doc.id}/link`, { storage: "gist", gistId: "g9" }), params(doc.id));
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.warnings).toBeUndefined();
    expect(b.document).toMatchObject({ storage: "gist", gistId: "g9", gistFile: "old.md", hasUnpublishedChanges: true });
    expect(createGist).not.toHaveBeenCalled();
    expect(await getPublishedContent(doc.id)).toBe("# Old\n");
    expect((await listVersions(doc.id)).length).toBe(versions);
  });
});
