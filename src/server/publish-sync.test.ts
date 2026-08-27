import { describe, expect, it, beforeAll, beforeEach, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;
delete process.env.GITHUB_MOCK;

// A hand-rolled GitHub: one repo file and one gist, mutable from the tests.
const remote = {
  repo: { content: "", sha: "sha-0" },
  gist: { content: "", revision: "rev-0" },
  reads: 0,
};
const bump = (s: string) => `${s.split("-")[0]}-${Number(s.split("-")[1]) + 1}`;

vi.mock("@/server/github", () => ({
  isGitHubMock: () => false,
  githubClient: () => ({}),
  readRepoFile: vi.fn(async () => {
    remote.reads++;
    return { content: remote.repo.content, sha: remote.repo.sha, htmlUrl: "https://github.com/o/r/blob/main/doc.md", updatedAt: null };
  }),
  commitRepoFile: vi.fn(async (_o: unknown, input: { content: string; sha?: string | null }) => {
    if (input.sha && input.sha !== remote.repo.sha) throw new Error("unexpected 409 from GitHub: sha guard should have caught this");
    remote.repo = { content: input.content, sha: bump(remote.repo.sha) };
    return { sha: remote.repo.sha, commitSha: `c-${remote.repo.sha}`, htmlUrl: "https://github.com/o/r/blob/main/doc.md", commitUrl: null };
  }),
  readGistFile: vi.fn(async () => {
    remote.reads++;
    return { gistId: "g1", filename: "doc.md", content: remote.gist.content, description: null, htmlUrl: "https://gist.github.com/g1", isPublic: false, owner: "o", revision: remote.gist.revision, updatedAt: null };
  }),
  updateGist: vi.fn(async (_o: unknown, _id: string, _f: string, content: string) => {
    remote.gist = { content, revision: bump(remote.gist.revision) };
    return { htmlUrl: "https://gist.github.com/g1", updatedAt: "now", revision: remote.gist.revision };
  }),
  createGist: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/documents", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/documents")>();
  return { ...mod, getGitHubToken: async () => "token" };
});

const { getDb, schema } = await import("@/server/db");
const { createDocument, updateDocument, getDocumentAccess, getPublishedContent, listVersions } = await import("@/server/documents");
const getDocument = async (id: string) => (await getDocumentAccess(id, user))?.doc ?? null;
const { readLiveText, replaceLiveText } = await import("@/server/livedoc");
const { syncStatus, pullDocument, publishDocument, mergeTexts, clearSyncCache } = await import("@/server/publish");
const { HttpError } = await import("@/server/http");

type User = { id: string; login: string; name: string; image: null };
let user: User;
const ctx = () => ({ userId: user.id, docId: "", role: "owner" as const, name: "Ann", login: "ann", avatar: null });

const BASE = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";
const LOCAL = BASE.replace("First paragraph.", "First paragraph, edited locally.");
const REMOTE = BASE.replace("Third paragraph.", "Third paragraph, edited on GitHub.");

async function repoDoc(opts: { local?: string; remote?: string } = {}) {
  const doc = await createDocument({ ownerId: user.id, content: BASE });
  remote.repo = { content: opts.remote ?? BASE, sha: opts.remote && opts.remote !== BASE ? "sha-5" : "sha-1" };
  const saved = await updateDocument(doc.id, { storage: "repo", repoOwner: "o", repoName: "r", repoBranch: "main", repoPath: "doc.md", githubSha: "sha-1", publishedContent: BASE, publishedAt: new Date() });
  if (opts.local) await replaceLiveText(doc.id, { ...ctx(), docId: doc.id }, opts.local);
  return (await getDocument(doc.id)) ?? saved!;
}

async function gistDoc(opts: { local?: string; remote?: string } = {}) {
  const doc = await createDocument({ ownerId: user.id, content: BASE });
  remote.gist = { content: opts.remote ?? BASE, revision: opts.remote && opts.remote !== BASE ? "rev-5" : "rev-1" };
  const saved = await updateDocument(doc.id, { storage: "gist", gistId: "g1", gistFile: "doc.md", githubSha: "rev-1", publishedContent: BASE, publishedAt: new Date() });
  if (opts.local) await replaceLiveText(doc.id, { ...ctx(), docId: doc.id }, opts.local);
  return (await getDocument(doc.id)) ?? saved!;
}

const conflict = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    return e as InstanceType<typeof HttpError>;
  }
  throw new Error("expected a 409");
};

beforeAll(async () => {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ name: "Ann", login: "ann", email: "ann-sync@example.com" }).returning();
  user = { id: u.id, login: "ann", name: "Ann", image: null };
});

beforeEach(() => {
  clearSyncCache();
  remote.reads = 0;
});

describe("syncStatus", () => {
  it("in-sync when nothing moved", async () => {
    const doc = await repoDoc();
    const s = await syncStatus(doc, user);
    expect(s.status).toBe("in-sync");
    expect(s.localChanged).toBe(false);
    expect(s.remoteChanged).toBe(false);
    expect(s.remote.sha).toBe("sha-1");
    expect(s.remote.url).toContain("github.com/o/r");
  });
  it("local-ahead when only the document changed", async () => {
    const s = await syncStatus(await repoDoc({ local: LOCAL }), user);
    expect(s.status).toBe("local-ahead");
    expect(s.lines.local).toBe(1);
    expect(s.lines.remote).toBe(0);
  });
  it("remote-ahead when only GitHub changed", async () => {
    const s = await syncStatus(await repoDoc({ remote: REMOTE }), user);
    expect(s.status).toBe("remote-ahead");
    expect(s.remoteChanged).toBe(true);
    expect(s.lines.remote).toBe(1);
  });
  it("diverged when both changed", async () => {
    const s = await syncStatus(await repoDoc({ local: LOCAL, remote: REMOTE }), user);
    expect(s.status).toBe("diverged");
    expect(s.localChanged && s.remoteChanged).toBe(true);
  });
  it("caches the remote read for 30 s and refreshes on demand", async () => {
    const doc = await repoDoc();
    await syncStatus(doc, user);
    expect(remote.reads).toBe(1);
    remote.repo = { content: REMOTE, sha: "sha-9" };
    const cached = await syncStatus(doc, user);
    expect(remote.reads).toBe(1);
    expect(cached.status).toBe("in-sync");
    const fresh = await syncStatus(doc, user, { fresh: true });
    expect(remote.reads).toBe(2);
    expect(fresh.status).toBe("remote-ahead");
  });
  it("gist: compares content and reports the history revision", async () => {
    const s = await syncStatus(await gistDoc({ remote: REMOTE }), user);
    expect(s.status).toBe("remote-ahead");
    expect(s.remote.revision).toBe("rev-5");
  });
});

describe("pullDocument", () => {
  it("refuses on local-ahead: 409, text and versions untouched", async () => {
    const doc = await repoDoc({ local: LOCAL });
    const before = (await listVersions(doc.id)).length;
    const err = await conflict(pullDocument(doc, user));
    expect(err.status).toBe(409);
    expect(err.details?.status).toBe("local-ahead");
    expect(err.details?.remoteContent).toBe(BASE);
    expect((await readLiveText(doc.id)).text).toBe(LOCAL);
    expect((await listVersions(doc.id)).length).toBe(before);
  });
  it("refuses on diverged without merge/force", async () => {
    const err = await conflict(pullDocument(await repoDoc({ local: LOCAL, remote: REMOTE }), user));
    expect(err.details?.status).toBe("diverged");
  });
  it("pulls when remote-ahead and records the new base", async () => {
    const doc = await repoDoc({ remote: REMOTE });
    const r = await pullDocument(doc, user);
    expect(r.changed).toBe(true);
    expect(r.status).toBe("in-sync");
    expect((await readLiveText(doc.id)).text).toBe(REMOTE);
    const after = (await getDocument(doc.id))!;
    expect(await getPublishedContent(doc.id)).toBe(REMOTE);
    expect(after.githubSha).toBe("sha-5");
    expect((await listVersions(doc.id))[0].title).toBe("Pulled from GitHub");
  });
  it("force pulls over local edits", async () => {
    const doc = await repoDoc({ local: LOCAL, remote: REMOTE });
    const r = await pullDocument(doc, user, { force: true });
    expect(r.changed).toBe(true);
    expect((await readLiveText(doc.id)).text).toBe(REMOTE);
    expect((await listVersions(doc.id))[0].title).toBe("Force-pulled from GitHub");
  });
  it("merges cleanly when both sides edited different paragraphs", async () => {
    const doc = await repoDoc({ local: LOCAL, remote: REMOTE });
    const r = await pullDocument(doc, user, { merge: true });
    expect(r.merged).toBe(true);
    expect(r.status).toBe("local-ahead");
    const text = (await readLiveText(doc.id)).text;
    expect(text).toContain("edited locally");
    expect(text).toContain("edited on GitHub");
    expect(text).not.toContain("<<<<<<<");
    expect((await listVersions(doc.id))[0].title).toBe("Merged from GitHub");
    const after = (await getDocument(doc.id))!;
    expect(await getPublishedContent(doc.id)).toBe(REMOTE);
    expect((await syncStatus(after, user, { fresh: true })).status).toBe("local-ahead");
  });
  it("reports conflicts with markers when the same line changed", async () => {
    const local = BASE.replace("First paragraph.", "First paragraph (mine).");
    const theirs = BASE.replace("First paragraph.", "First paragraph (theirs).");
    const doc = await repoDoc({ local, remote: theirs });
    const err = await conflict(pullDocument(doc, user, { merge: true }));
    expect(err.status).toBe(409);
    expect(err.details?.status).toBe("conflict");
    expect(err.details?.conflicts).toBe(1);
    const merged = err.details?.merged as string;
    expect(merged).toContain("<<<<<<< local\nFirst paragraph (mine).\n=======\nFirst paragraph (theirs).\n>>>>>>> github");
    expect((await readLiveText(doc.id)).text).toBe(local);
  });
  it("gist: pull stores the remote revision in githubSha", async () => {
    const doc = await gistDoc({ remote: REMOTE });
    await pullDocument(doc, user);
    expect((await getDocument(doc.id))!.githubSha).toBe("rev-5");
  });
});

describe("publishDocument", () => {
  it("refuses on remote-ahead", async () => {
    const doc = await repoDoc({ remote: REMOTE });
    const err = await conflict(publishDocument(doc, user, { message: "x" }));
    expect(err.status).toBe(409);
    expect(err.details?.status).toBe("remote-ahead");
    expect(remote.repo.content).toBe(REMOTE);
  });
  it("refuses on diverged", async () => {
    const err = await conflict(publishDocument(await repoDoc({ local: LOCAL, remote: REMOTE }), user));
    expect(err.details?.status).toBe("diverged");
  });
  it("publishes when local-ahead", async () => {
    const doc = await repoDoc({ local: LOCAL });
    const r = await publishDocument(doc, user, "Edit first paragraph");
    expect(r.skipped).toBeUndefined();
    expect(remote.repo.content).toBe(LOCAL);
    expect((await getDocument(doc.id))!.githubSha).toBe("sha-2");
    expect((await syncStatus((await getDocument(doc.id))!, user)).status).toBe("in-sync");
  });
  it("force publish overwrites a diverged remote", async () => {
    const doc = await repoDoc({ local: LOCAL, remote: REMOTE });
    const r = await publishDocument(doc, user, { force: true });
    expect(r.status).toBe("in-sync");
    expect(remote.repo.content).toBe(LOCAL);
    expect((await listVersions(doc.id))[0].title).toBe("Force-published");
  });
  it("gist: refuses when the gist moved, force writes and stores the new revision", async () => {
    const doc = await gistDoc({ local: LOCAL, remote: REMOTE });
    const err = await conflict(publishDocument(doc, user));
    expect(err.details?.status).toBe("diverged");
    await publishDocument(doc, user, { force: true });
    expect(remote.gist.content).toBe(LOCAL);
    expect((await getDocument(doc.id))!.githubSha).toBe("rev-6");
  });
  it("skips when already in sync", async () => {
    const r = await publishDocument(await repoDoc(), user);
    expect(r.skipped).toBe(true);
  });
});

describe("mergeTexts", () => {
  it("joins non-overlapping edits", () => {
    const m = mergeTexts("a\nb\nc", "A\nb\nc", "a\nb\nC");
    expect(m).toEqual({ text: "A\nb\nC", conflicts: 0 });
  });
  it("marks overlapping edits", () => {
    const m = mergeTexts("a\nb\nc", "a\nX\nc", "a\nY\nc");
    expect(m.conflicts).toBe(1);
    expect(m.text).toBe("a\n<<<<<<< local\nX\n=======\nY\n>>>>>>> github\nc");
  });
  it("treats identical edits on both sides as no conflict", () => {
    expect(mergeTexts("a\nb", "a\nZ", "a\nZ")).toEqual({ text: "a\nZ", conflicts: 0 });
  });
});
