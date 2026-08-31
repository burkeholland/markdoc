import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { count } from "drizzle-orm";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;
delete process.env.GITHUB_MOCK;

/**
 * GitHub's Contents API inlines a file's base64 content only up to 1 MB; from 1 to 100 MB it answers
 * `content: "", encoding: "none"` (verified live against nodejs/node deps/amaro/dist/index.js:
 * `3801362 none 0 file`). Nothing here may read that as an empty file: import, link, sync, pull and
 * publish all see a 413 naming the size and the 2 MB bound, and a 1–2 MB file is read as a raw blob.
 */

// Real `@/server/github` (readRepoFile / readGistFile) over a hand-rolled Octokit.
const gh = {
  repos: { getContent: vi.fn(), createOrUpdateFileContents: vi.fn() },
  git: { getBlob: vi.fn() },
  gists: { get: vi.fn() },
};
vi.mock("@/server/github", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/github")>();
  return { ...mod, githubClient: () => gh };
});
vi.mock("@/server/documents", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/documents")>();
  return { ...mod, getGitHubToken: async () => "token" };
});

type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { createDocument, updateDocument, getDocumentAccess, getPublishedContent, listVersions } = await import("@/server/documents");
const { readLiveText, replaceLiveText } = await import("@/server/livedoc");
const { readRepoFile, readGistFile, GITHUB_FILE_MAX_BYTES, GitHubFileTooLargeError } = await import("@/server/github");
const { linkDocument, clearSyncCache } = await import("@/server/publish");
const { POST: importPost } = await import("@/app/api/import/route");
const { GET: syncGet } = await import("@/app/api/documents/[id]/sync/route");
const { POST: pullPost } = await import("@/app/api/documents/[id]/pull/route");
const { POST: publishPost } = await import("@/app/api/documents/[id]/publish/route");

const octokit = gh as unknown as import("@octokit/rest").Octokit;
const BIG_SHA = "4ce1359bb25926e4aade7ee616fc5443ec451515";
const BIG_SIZE = 3_801_362;
const MID_SIZE = 1_500_000;
const MID_TEXT = `# Mid\n\n${"x".repeat(MID_SIZE - 8)}\n`;
const BASE = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
const LOCAL = BASE.replace("First paragraph.", "First paragraph, edited locally.");

/** What `repos.getContent` answers for a file of `size` bytes: inlined base64 up to 1 MB, `encoding: "none"` past it. */
function contentsAnswer(text: string, size = Buffer.byteLength(text), sha = BIG_SHA) {
  const inlined = size <= 1024 * 1024;
  return {
    data: {
      type: "file",
      encoding: inlined ? "base64" : "none",
      content: inlined ? Buffer.from(text, "utf8").toString("base64") : "",
      size,
      sha,
      html_url: "https://github.com/o/r/blob/main/doc.md",
    },
  };
}

function gistAnswer(file: { content?: string; size?: number; truncated?: boolean; raw_url?: string }) {
  return {
    data: {
      id: "g1",
      html_url: "https://gist.github.com/g1",
      public: false,
      description: null,
      owner: { login: "o" },
      history: [{ version: "rev-7" }],
      updated_at: "2026-08-27T00:00:00Z",
      files: { "doc.md": { filename: "doc.md", raw_url: "https://gist.githubusercontent.com/o/g1/raw/doc.md", truncated: false, ...file } },
    },
  };
}

const json = (url: string, body: unknown, method = "POST") => new Request(`http://localhost:3700${url}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const docCount = async () => Number((await (await getDb()).select({ n: count() }).from(schema.documents))[0].n);

let user: Actor;
const ctx = (docId: string) => ({ userId: user.id, docId, role: "owner" as const, name: "Ann", login: "ann", avatar: null });

/** A document linked to o/r:doc.md with `BASE` as merge base, optionally edited locally. */
async function linkedDoc(local?: string) {
  const doc = await createDocument({ ownerId: user.id, content: BASE });
  await updateDocument(doc.id, { storage: "repo", repoOwner: "o", repoName: "r", repoBranch: "main", repoPath: "doc.md", githubSha: "sha-base", publishedContent: BASE, publishedAt: new Date() });
  if (local) await replaceLiveText(doc.id, ctx(doc.id), local);
  return (await getDocumentAccess(doc.id, user))!.doc;
}

beforeAll(async () => {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ name: "Ann", login: "ann", email: "ann-oversized@example.com" }).returning();
  user = { id: u.id, login: "ann", name: "Ann", image: null };
});

beforeEach(() => {
  clearSyncCache();
  gh.repos.getContent.mockReset();
  gh.repos.createOrUpdateFileContents.mockReset();
  gh.git.getBlob.mockReset();
  gh.gists.get.mockReset();
  actor = user;
});

afterEach(() => {
  actor = null;
  vi.unstubAllGlobals();
  delete process.env.GITHUB_RAW_TIMEOUT_MS;
});

describe("readRepoFile", () => {
  it("a 1–100 MB file (encoding none) over the bound is a 413 naming the size and the limit, never an empty file", async () => {
    gh.repos.getContent.mockResolvedValue(contentsAnswer("", BIG_SIZE));
    const err = await readRepoFile(octokit, "o", "r", "doc.md", "main").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubFileTooLargeError);
    const e = err as InstanceType<typeof GitHubFileTooLargeError>;
    expect(e.status).toBe(413);
    expect(e.message).toBe("The file on GitHub is 3.63 MB; Markdoc documents are limited to 2 MB");
    expect(e.details).toEqual({ size: BIG_SIZE, limit: GITHUB_FILE_MAX_BYTES });
    expect(e.revision).toBe(BIG_SHA);
    expect(gh.git.getBlob).not.toHaveBeenCalled();
  });

  it("a file between 1 MB and the bound is read as a raw blob by sha", async () => {
    gh.repos.getContent.mockResolvedValue(contentsAnswer(MID_TEXT, MID_SIZE, "mid-sha"));
    gh.git.getBlob.mockResolvedValue({ data: MID_TEXT, headers: { "content-type": "text/plain; charset=utf-8" } });
    const file = await readRepoFile(octokit, "o", "r", "doc.md", "main");
    expect(file.content).toBe(MID_TEXT);
    expect(file.sha).toBe("mid-sha");
    expect(gh.git.getBlob).toHaveBeenCalledWith({ owner: "o", repo: "r", file_sha: "mid-sha", mediaType: { format: "raw" } });
  });

  it("still decodes the inlined base64 of a file under 1 MB (and an empty file) without a second request", async () => {
    gh.repos.getContent.mockResolvedValue(contentsAnswer(BASE, undefined, "small-sha"));
    expect((await readRepoFile(octokit, "o", "r", "doc.md", "main")).content).toBe(BASE);
    gh.repos.getContent.mockResolvedValue(contentsAnswer("", 0, "empty-sha"));
    expect((await readRepoFile(octokit, "o", "r", "doc.md", "main")).content).toBe("");
    expect(gh.git.getBlob).not.toHaveBeenCalled();
  });

  it("a blob whose text turns out over the bound is a 413 as well", async () => {
    gh.repos.getContent.mockResolvedValue(contentsAnswer("", MID_SIZE, "lying-sha"));
    gh.git.getBlob.mockResolvedValue({ data: "y".repeat(GITHUB_FILE_MAX_BYTES + 1) });
    await expect(readRepoFile(octokit, "o", "r", "doc.md", "main")).rejects.toMatchObject({ status: 413 });
  });
});

describe("POST /api/import (repo)", () => {
  it("answers 413 with the size and the limit and creates no document", async () => {
    gh.repos.getContent.mockResolvedValue(contentsAnswer("", BIG_SIZE));
    const before = await docCount();
    const res = await importPost(json("/api/import", { source: "repo", owner: "o", repo: "r", branch: "main", path: "big.md" }));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; size: number; limit: number };
    expect(body.error).toBe("The file on GitHub is 3.63 MB; Markdoc documents are limited to 2 MB");
    expect(body.size).toBe(BIG_SIZE);
    expect(body.limit).toBe(GITHUB_FILE_MAX_BYTES);
    expect(await docCount()).toBe(before);
  });

  it("imports the real text of a 1–2 MB file through the raw blob", async () => {
    gh.repos.getContent.mockResolvedValue(contentsAnswer(MID_TEXT, MID_SIZE, "mid-sha"));
    gh.git.getBlob.mockResolvedValue({ data: MID_TEXT });
    const res = await importPost(json("/api/import", { source: "repo", owner: "o", repo: "r", branch: "main", path: "mid.md" }));
    expect(res.status).toBe(201);
    const { document } = (await res.json()) as { document: { id: string; title: string } };
    expect(document.title).toBe("Mid");
    const access = (await getDocumentAccess(document.id, user))!;
    expect(access.doc.githubSha).toBe("mid-sha");
    expect((await readLiveText(document.id)).text).toBe(MID_TEXT);
  });
});

describe("linked document whose GitHub file grew past the bound", () => {
  beforeEach(() => {
    gh.repos.getContent.mockResolvedValue(contentsAnswer("", BIG_SIZE));
  });

  it("GET /sync is a 413 remote-unreadable, not remote-ahead", async () => {
    const doc = await linkedDoc();
    const res = await syncGet(new Request(`http://localhost:3700/api/documents/${doc.id}/sync?fresh=1`), params(doc.id));
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("remote-unreadable");
    expect(body.error).toContain("3.63 MB");
    expect(body.remote).toMatchObject({ sha: BIG_SHA, revision: BIG_SHA });
    expect(body.size).toBe(BIG_SIZE);
  });

  it("GET /sync's 413 carries pollMs (SYNC_POLL_MS) like the 200 does, so the header keeps polling at that rate", async () => {
    const previous = process.env.SYNC_POLL_MS;
    process.env.SYNC_POLL_MS = "2000";
    try {
      const doc = await linkedDoc();
      const res = await syncGet(new Request(`http://localhost:3700/api/documents/${doc.id}/sync?fresh=1`), params(doc.id));
      expect(res.status).toBe(413);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.pollMs).toBe(2000);
      expect(body).toMatchObject({ status: "remote-unreadable", size: BIG_SIZE, limit: GITHUB_FILE_MAX_BYTES, remote: { sha: BIG_SHA, revision: BIG_SHA } });

      // The file shrinks back under the bound: the 200 has the same pollMs.
      gh.repos.getContent.mockResolvedValue(contentsAnswer(BASE, undefined, "sha-base"));
      const ok = await syncGet(new Request(`http://localhost:3700/api/documents/${doc.id}/sync?fresh=1`), params(doc.id));
      expect(ok.status).toBe(200);
      expect((await ok.json()) as Record<string, unknown>).toMatchObject({ status: "in-sync", pollMs: 2000 });
    } finally {
      if (previous === undefined) delete process.env.SYNC_POLL_MS;
      else process.env.SYNC_POLL_MS = previous;
    }
  });

  it("POST /pull with and without force is a 413 and leaves the live text and versions alone", async () => {
    const doc = await linkedDoc(LOCAL);
    const versions = (await listVersions(doc.id)).length;
    for (const q of ["", "?force=1", "?merge=1"]) {
      const res = await pullPost(new Request(`http://localhost:3700/api/documents/${doc.id}/pull${q}`, { method: "POST" }), params(doc.id));
      expect(res.status, q).toBe(413);
      expect(((await res.json()) as { status: string }).status).toBe("remote-unreadable");
    }
    expect((await readLiveText(doc.id)).text).toBe(LOCAL);
    expect(await getPublishedContent(doc.id)).toBe(BASE);
    expect((await listVersions(doc.id)).length).toBe(versions);
    expect((await getDocumentAccess(doc.id, user))!.doc.githubSha).toBe("sha-base");
  });

  it("POST /publish refuses without force and commits the local text over the oversized blob with force", async () => {
    const doc = await linkedDoc(LOCAL);
    const refused = await publishPost(json(`/api/documents/${doc.id}/publish`, { message: "x" }), params(doc.id));
    expect(refused.status).toBe(413);
    expect(((await refused.json()) as { status: string }).status).toBe("remote-unreadable");
    expect(gh.repos.createOrUpdateFileContents).not.toHaveBeenCalled();

    gh.repos.createOrUpdateFileContents.mockResolvedValue({ data: { content: { sha: "new-sha", html_url: "https://github.com/o/r/blob/main/doc.md" }, commit: { sha: "c1", html_url: null } } });
    const forced = await publishPost(json(`/api/documents/${doc.id}/publish?force=1`, { message: "take mine" }), params(doc.id));
    expect(forced.status).toBe(200);
    expect(gh.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(1);
    const call = gh.repos.createOrUpdateFileContents.mock.calls[0][0] as { sha: string; content: string };
    expect(call.sha).toBe(BIG_SHA);
    expect(Buffer.from(call.content, "base64").toString("utf8")).toBe(LOCAL);
    const after = (await getDocumentAccess(doc.id, user))!.doc;
    expect(after.githubSha).toBe("new-sha");
    expect(await getPublishedContent(doc.id)).toBe(LOCAL);
    expect((await listVersions(doc.id))[0].title).toBe("Force-published");
    // The forced write is now the remote: status reads again.
    const sync = await syncGet(new Request(`http://localhost:3700/api/documents/${doc.id}/sync`), params(doc.id));
    expect(sync.status).toBe(200);
    expect(((await sync.json()) as { status: string }).status).toBe("in-sync");
  });

  it("linking a document to an oversized file is a 413 and the document stays unlinked", async () => {
    const doc = await createDocument({ ownerId: user.id, content: BASE });
    await expect(linkDocument(doc, user, { storage: "repo", owner: "o", repo: "r", branch: "main", path: "big.md" })).rejects.toMatchObject({ status: 413 });
    const after = (await getDocumentAccess(doc.id, user))!.doc;
    expect(after.storage).toBe("local");
    expect(after.repoPath).toBeNull();
  });

  it("a missing file still links with no base (404 stays a fresh link)", async () => {
    gh.repos.getContent.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    const doc = await createDocument({ ownerId: user.id, content: BASE });
    const linked = await linkDocument(doc, user, { storage: "repo", owner: "o", repo: "r", branch: "main", path: "new.md" });
    expect(linked.storage).toBe("repo");
    expect(linked.githubSha).toBeNull();
  });
});

describe("readGistFile raw_url fetch", () => {
  /** A fetch stub that streams `chunks` (or hangs until aborted when `hang`). */
  function stubFetch(opts: { chunks?: string[]; contentLength?: number; hang?: boolean; status?: number }) {
    const calls: RequestInit[] = [];
    const impl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      if (opts.hang) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        });
      }
      const chunks = [...(opts.chunks ?? [])];
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks.shift();
          if (next === undefined) controller.close();
          else controller.enqueue(new TextEncoder().encode(next));
        },
      });
      const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
      if (opts.contentLength !== undefined) headers.set("Content-Length", String(opts.contentLength));
      return Promise.resolve(new Response(body, { status: opts.status ?? 200, headers }));
    });
    vi.stubGlobal("fetch", impl);
    return { impl, calls };
  }

  it("a gist file GitHub reports over the bound is a 413 before anything is fetched", async () => {
    gh.gists.get.mockResolvedValue(gistAnswer({ content: "", size: BIG_SIZE, truncated: true }));
    const { impl } = stubFetch({ chunks: ["never"] });
    const err = await readGistFile(octokit, "g1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubFileTooLargeError);
    expect((err as InstanceType<typeof GitHubFileTooLargeError>).revision).toBe("rev-7");
    expect(impl).not.toHaveBeenCalled();
  });

  it("a truncated file within the bound is fetched whole from raw_url with an abort signal", async () => {
    const text = "# Gist\n\n" + "g".repeat(1_200_000);
    gh.gists.get.mockResolvedValue(gistAnswer({ content: text.slice(0, 1024 * 1024), size: Buffer.byteLength(text), truncated: true }));
    const { calls } = stubFetch({ chunks: [text.slice(0, 700_000), text.slice(700_000)], contentLength: Buffer.byteLength(text) });
    const file = await readGistFile(octokit, "g1");
    expect(file.content).toBe(text);
    expect(file.revision).toBe("rev-7");
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a body over the bound — by Content-Length, or while streaming when the header is missing", async () => {
    // `size` as reported is fine, the body is not.
    gh.gists.get.mockResolvedValue(gistAnswer({ content: "", size: 10, truncated: true }));
    stubFetch({ chunks: ["x"], contentLength: GITHUB_FILE_MAX_BYTES + 1 });
    await expect(readGistFile(octokit, "g1")).rejects.toMatchObject({ status: 413, details: { size: GITHUB_FILE_MAX_BYTES + 1 } });

    const chunk = "z".repeat(512 * 1024);
    stubFetch({ chunks: [chunk, chunk, chunk, chunk, "one more byte"] });
    const err = (await readGistFile(octokit, "g1").catch((e: unknown) => e)) as InstanceType<typeof GitHubFileTooLargeError>;
    expect(err.status).toBe(413);
    expect(err.message).toBe("The file on GitHub is larger than 2 MB; Markdoc documents are limited to 2 MB");
  });

  it("gives up after GITHUB_RAW_TIMEOUT_MS with a 408", async () => {
    process.env.GITHUB_RAW_TIMEOUT_MS = "40";
    gh.gists.get.mockResolvedValue(gistAnswer({ content: "", size: 10, truncated: true }));
    stubFetch({ hang: true });
    const started = Date.now();
    await expect(readGistFile(octokit, "g1")).rejects.toMatchObject({ status: 408 });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("POST /api/import (gist) answers 4xx for an oversized body and for a timeout, creating nothing", async () => {
    const before = await docCount();
    gh.gists.get.mockResolvedValue(gistAnswer({ content: "", size: BIG_SIZE, truncated: true }));
    const big = await importPost(json("/api/import", { source: "gist", gistId: "g1" }));
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toContain("3.63 MB");

    process.env.GITHUB_RAW_TIMEOUT_MS = "40";
    gh.gists.get.mockResolvedValue(gistAnswer({ content: "", size: 10, truncated: true }));
    stubFetch({ hang: true });
    const slow = await importPost(json("/api/import", { source: "gist", gistId: "g1" }));
    expect(slow.status).toBe(408);
    expect(await docCount()).toBe(before);
  });
});
