import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;
delete process.env.GITHUB_MOCK;

// A hand-rolled GitHub: one repo file and one gist, mutable from the tests.
const remote = {
  repo: { content: "", sha: "sha-0", missing: false },
  gist: { content: "", revision: "rev-0" },
  reads: 0,
};
const bump = (s: string) => `${s.split("-")[0]}-${Number(s.split("-")[1]) + 1}`;

vi.mock("@/server/github", async () => ({
  isGitHubMock: () => false,
  githubClient: () => ({}),
  // The real class: `fetchRemote` tells a 404 from an oversized file with `instanceof`.
  GitHubFileTooLargeError: (await import("@/server/github/limits")).GitHubFileTooLargeError,
  readRepoFile: vi.fn(async () => {
    remote.reads++;
    if (remote.repo.missing) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { content: remote.repo.content, sha: remote.repo.sha, htmlUrl: "https://github.com/o/r/blob/main/doc.md", updatedAt: null };
  }),
  commitRepoFile: vi.fn(async (_o: unknown, input: { content: string; sha?: string | null }) => {
    if (input.sha && input.sha !== remote.repo.sha) throw new Error("unexpected 409 from GitHub: sha guard should have caught this");
    remote.repo = { content: input.content, sha: bump(remote.repo.sha), missing: false };
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
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// `updateDocument` / `addVersion` / `recordActivity` call through by default; a test makes one of them fail once
// to stand in for a database error after the GitHub write (the crash the atomicity audit is about).
vi.mock("@/server/documents", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/documents")>();
  return { ...mod, getGitHubToken: async () => "token", updateDocument: vi.fn(mod.updateDocument), addVersion: vi.fn(mod.addVersion) };
});
vi.mock("@/server/activity", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/activity")>();
  return { ...mod, recordActivity: vi.fn(mod.recordActivity) };
});

const { getDb, schema } = await import("@/server/db");
const { createDocument, updateDocument, addVersion, getDocumentAccess, getPublishedContent, listVersions } = await import("@/server/documents");
const { recordActivity, listActivity } = await import("@/server/activity");
const getDocument = async (id: string) => (await getDocumentAccess(id, user))?.doc ?? null;
const { readLiveText, replaceLiveText } = await import("@/server/livedoc");
const { syncStatus, pullDocument, publishDocument, mergeTexts, clearSyncCache } = await import("@/server/publish");
const { HttpError } = await import("@/server/http");
const { GET: syncGet } = await import("@/app/api/documents/[id]/sync/route");
const { POST: publishPost } = await import("@/app/api/documents/[id]/publish/route");
const { POST: pullPost } = await import("@/app/api/documents/[id]/pull/route");

type User = { id: string; login: string; name: string; image: null };
let user: User;
/** The signed-in user the route handlers see; set per test. */
let actor: User | null = null;
const ctx = () => ({ userId: user.id, docId: "", role: "owner" as const, name: "Ann", login: "ann", avatar: null });

const BASE = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";
const LOCAL = BASE.replace("First paragraph.", "First paragraph, edited locally.");
const REMOTE = BASE.replace("Third paragraph.", "Third paragraph, edited on GitHub.");

const post = (url: string, body?: unknown) => new Request(`http://localhost:3700${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const dbDown = () => new Error("database unavailable (test)");

async function repoDoc(opts: { local?: string; remote?: string | null } = {}) {
  const doc = await createDocument({ ownerId: user.id, content: BASE });
  remote.repo = opts.remote === null
    ? { content: "", sha: "sha-0", missing: true }
    : { content: opts.remote ?? BASE, sha: opts.remote && opts.remote !== BASE ? "sha-5" : "sha-1", missing: false };
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
  actor = user;
});

afterEach(() => {
  actor = null;
  // A rejection queued with `mockRejectedValueOnce` that a failing test did not consume must not leak into the next one.
  vi.mocked(updateDocument).mockReset();
  vi.mocked(addVersion).mockReset();
  vi.mocked(recordActivity).mockReset();
  vi.restoreAllMocks();
});

/** Silence and capture the one `console.error` a tolerated tail failure must write. */
const quietErrors = () => vi.spyOn(console, "error").mockImplementation(() => undefined);
const body = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
type SyncBody = { status: string; localChanged: boolean; remoteChanged: boolean; lines: { local: number; remote: number } };
type PublishBody = { result: { skipped?: boolean; status: string; commitSha: string | null; warnings?: string[] }; document: { hasUnpublishedChanges: boolean } | null; warnings?: string[] };
type PullBody = { result: { changed: boolean; status: string; merged?: boolean; warnings?: string[] }; warnings?: string[] };

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
    expect(s.lines).toEqual({ local: 1, remote: 1 });
  });
  it("still diverged when both sides rewrote the same line differently (the in-sync heal needs identical texts)", async () => {
    const mine = BASE.replace("First paragraph.", "First paragraph (mine).");
    const theirs = BASE.replace("First paragraph.", "First paragraph (theirs).");
    const s = await syncStatus(await repoDoc({ local: mine, remote: theirs }), user);
    expect(s.status).toBe("diverged");
    expect(s.localChanged).toBe(true);
    expect(s.remoteChanged).toBe(true);
    expect(s.lines).toEqual({ local: 1, remote: 1 });
  });
  it("in-sync when the base is stale but local equals remote (a publish or pull that crashed after the GitHub write)", async () => {
    // Base = BASE, live = LOCAL, GitHub = LOCAL: the texts agree, only the bookkeeping is behind.
    const doc = await repoDoc({ local: LOCAL, remote: LOCAL });
    const s = await syncStatus(doc, user);
    expect(s.status).toBe("in-sync");
    expect(s.localChanged).toBe(false);
    expect(s.remoteChanged).toBe(false);
    expect(s.lines).toEqual({ local: 0, remote: 0 });
    expect(s.remote.sha).toBe("sha-5");
    const res = await syncGet(new Request(`http://localhost:3700/api/documents/${doc.id}/sync?fresh=1`), params(doc.id));
    expect(res.status).toBe(200);
    expect(await body<SyncBody>(res)).toMatchObject({ status: "in-sync", localChanged: false, remoteChanged: false, lines: { local: 0, remote: 0 } });
  });
  // base / local / remote → status. `null` remote = the file is not on GitHub (404).
  it.each([
    ["BASE", "BASE", "BASE", "in-sync", 0, 0],
    ["BASE", "LOCAL", "BASE", "local-ahead", 1, 0],
    ["BASE", "BASE", "REMOTE", "remote-ahead", 0, 1],
    ["BASE", "LOCAL", "REMOTE", "diverged", 1, 1],
    ["BASE", "LOCAL", "LOCAL", "in-sync", 0, 0],
    ["BASE", "REMOTE", "REMOTE", "in-sync", 0, 0],
    ["BASE", "BASE", null, "in-sync", 0, 0],
    ["BASE", "LOCAL", null, "local-ahead", 1, 0],
  ] as const)("truth table: base %s, local %s, remote %s → %s (lines %i/%i)", async (_base, local, rem, status, localLines, remoteLines) => {
    const texts = { BASE, LOCAL, REMOTE } as const;
    const doc = await repoDoc({ local: texts[local], remote: rem === null ? null : texts[rem] });
    const s = await syncStatus(doc, user);
    expect(s.status).toBe(status);
    expect(s.lines).toEqual({ local: localLines, remote: remoteLines });
    expect(s.localChanged).toBe(localLines > 0);
    expect(s.remoteChanged).toBe(remoteLines > 0);
  });
  it("caches the remote read for 30 s and refreshes on demand", async () => {
    const doc = await repoDoc();
    await syncStatus(doc, user);
    expect(remote.reads).toBe(1);
    remote.repo = { content: REMOTE, sha: "sha-9", missing: false };
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
  it("in-sync with a stale base (local already equals GitHub) records the base and changes nothing else", async () => {
    const doc = await repoDoc({ local: REMOTE, remote: REMOTE });
    const versions = (await listVersions(doc.id)).length;
    const r = await pullDocument(doc, user);
    expect(r).toEqual({ changed: false, url: "https://github.com/o/r/blob/main/doc.md", status: "in-sync" });
    expect(await getPublishedContent(doc.id)).toBe(REMOTE);
    expect((await getDocument(doc.id))!.githubSha).toBe("sha-5");
    expect((await readLiveText(doc.id)).text).toBe(REMOTE);
    expect((await listVersions(doc.id)).length).toBe(versions);
  });
  it("POST /pull: a failed version row is a warning — the text is replaced and the base recorded", async () => {
    const doc = await repoDoc({ remote: REMOTE });
    const versions = (await listVersions(doc.id)).length;
    const errors = quietErrors();
    vi.mocked(addVersion).mockRejectedValueOnce(dbDown());
    const res = await pullPost(post(`/api/documents/${doc.id}/pull`), params(doc.id));
    expect(res.status).toBe(200);
    const b = await body<PullBody>(res);
    expect(b.warnings).toEqual(["version-not-saved"]);
    expect(b.result).toEqual({ changed: true, url: "https://github.com/o/r/blob/main/doc.md", status: "in-sync" });
    expect((await readLiveText(doc.id)).text).toBe(REMOTE);
    expect(await getPublishedContent(doc.id)).toBe(REMOTE);
    expect((await getDocument(doc.id))!.githubSha).toBe("sha-5");
    expect((await listVersions(doc.id)).length).toBe(versions);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toBe("[pull] version-not-saved");
    // The next pull has nothing to do.
    const again = await pullPost(post(`/api/documents/${doc.id}/pull`), params(doc.id));
    expect(again.status).toBe(200);
    const b2 = await body<PullBody>(again);
    expect(b2.result.changed).toBe(false);
    expect(b2.warnings).toBeUndefined();
  });
  it("POST /pull: a crashed base write answers 500, then status is in-sync and a plain retry heals the base", async () => {
    const doc = await repoDoc({ remote: REMOTE });
    const errors = quietErrors();
    // replaceLiveText and addVersion do not touch updateDocument, so the one rejection lands on recordBase().
    vi.mocked(updateDocument).mockRejectedValueOnce(dbDown());
    const crashed = await pullPost(post(`/api/documents/${doc.id}/pull`), params(doc.id));
    expect(crashed.status).toBe(500);
    expect((await readLiveText(doc.id)).text).toBe(REMOTE);
    expect(await getPublishedContent(doc.id)).toBe(BASE);
    expect((await getDocument(doc.id))!.githubSha).toBe("sha-1");
    expect(errors).toHaveBeenCalledTimes(1);

    const sync = await syncGet(new Request(`http://localhost:3700/api/documents/${doc.id}/sync?fresh=1`), params(doc.id));
    expect(await body<SyncBody>(sync)).toMatchObject({ status: "in-sync", lines: { local: 0, remote: 0 } });

    const retry = await pullPost(post(`/api/documents/${doc.id}/pull`), params(doc.id));
    expect(retry.status).toBe(200);
    const b = await body<PullBody>(retry);
    expect(b.result).toMatchObject({ changed: false, status: "in-sync" });
    expect(b.warnings).toBeUndefined();
    expect(await getPublishedContent(doc.id)).toBe(REMOTE);
    expect((await getDocument(doc.id))!.githubSha).toBe("sha-5");
  });
  it("merge: a failed version row is a warning, the merged text stays and the base is recorded", async () => {
    const doc = await repoDoc({ local: LOCAL, remote: REMOTE });
    const errors = quietErrors();
    vi.mocked(addVersion).mockRejectedValueOnce(dbDown());
    const r = await pullDocument(doc, user, { merge: true });
    expect(r).toMatchObject({ changed: true, merged: true, status: "local-ahead", warnings: ["version-not-saved"] });
    const text = (await readLiveText(doc.id)).text;
    expect(text).toContain("edited locally");
    expect(text).toContain("edited on GitHub");
    expect(await getPublishedContent(doc.id)).toBe(REMOTE);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toBe("[pull] version-not-saved");
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
  it("skipped publish with a stale base heals the base instead of committing again", async () => {
    const doc = await repoDoc({ local: LOCAL, remote: LOCAL });
    const commits = vi.mocked((await import("@/server/github")).commitRepoFile).mock.calls.length;
    const r = await publishDocument(doc, user);
    expect(r.skipped).toBe(true);
    expect(r.status).toBe("in-sync");
    expect(r.warnings).toBeUndefined();
    expect(vi.mocked((await import("@/server/github")).commitRepoFile).mock.calls.length).toBe(commits);
    expect(await getPublishedContent(doc.id)).toBe(LOCAL);
    expect((await getDocument(doc.id))!.githubSha).toBe("sha-5");
    expect((await syncStatus((await getDocument(doc.id))!, user, { fresh: true })).status).toBe("in-sync");
  });
  it("POST /publish: a crashed base write answers 500, GitHub has the text, and a plain retry is skipped and heals the base", async () => {
    const doc = await repoDoc({ local: LOCAL });
    const versions = (await listVersions(doc.id)).length;
    const errors = quietErrors();
    // The GitHub commit succeeds; the write of publishedContent/githubSha right after it fails.
    vi.mocked(updateDocument).mockRejectedValueOnce(dbDown());
    const crashed = await publishPost(post(`/api/documents/${doc.id}/publish`, { message: "Edit first paragraph" }), params(doc.id));
    expect(crashed.status).toBe(500);
    expect(await body(crashed)).toEqual({ error: "Unexpected error" });
    expect(remote.repo).toEqual({ content: LOCAL, sha: "sha-2", missing: false });
    expect(await getPublishedContent(doc.id)).toBe(BASE);
    expect((await getDocument(doc.id))!.githubSha).toBe("sha-1");
    expect((await listVersions(doc.id)).length).toBe(versions);
    expect(errors).toHaveBeenCalledTimes(1);

    const sync = await syncGet(new Request(`http://localhost:3700/api/documents/${doc.id}/sync?fresh=1`), params(doc.id));
    expect(await body<SyncBody>(sync)).toMatchObject({ status: "in-sync", lines: { local: 0, remote: 0 } });

    const retry = await publishPost(post(`/api/documents/${doc.id}/publish`, { message: "Edit first paragraph" }), params(doc.id));
    expect(retry.status).toBe(200);
    const b = await body<PublishBody>(retry);
    expect(b.result).toMatchObject({ skipped: true, status: "in-sync", commitSha: null });
    expect(b.warnings).toBeUndefined();
    expect(b.document?.hasUnpublishedChanges).toBe(false);
    // No second commit; the stored base now equals the remote.
    expect(remote.repo).toEqual({ content: LOCAL, sha: "sha-2", missing: false });
    expect(await getPublishedContent(doc.id)).toBe(LOCAL);
    expect((await getDocument(doc.id))!.githubSha).toBe("sha-2");
    expect((await listActivity(doc.id)).items.filter((a) => a.action === "publish")).toHaveLength(0);
  });
  it("POST /publish: a failed version row is a warning — the commit, base and activity stand", async () => {
    const doc = await repoDoc({ local: LOCAL });
    const versions = (await listVersions(doc.id)).length;
    const errors = quietErrors();
    vi.mocked(addVersion).mockRejectedValueOnce(dbDown());
    const res = await publishPost(post(`/api/documents/${doc.id}/publish`, { message: "Edit first paragraph" }), params(doc.id));
    expect(res.status).toBe(200);
    const b = await body<PublishBody>(res);
    expect(b.warnings).toEqual(["version-not-saved"]);
    expect(b.result).toMatchObject({ status: "in-sync", commitSha: "c-sha-2" });
    expect(b.result.skipped).toBeUndefined();
    expect(b.result.warnings).toBeUndefined();
    expect(remote.repo.content).toBe(LOCAL);
    expect(await getPublishedContent(doc.id)).toBe(LOCAL);
    expect((await getDocument(doc.id))!.githubSha).toBe("sha-2");
    expect((await listVersions(doc.id)).length).toBe(versions);
    const activity = (await listActivity(doc.id)).items.filter((a) => a.action === "publish");
    expect(activity).toHaveLength(1);
    expect(activity[0].detail).toMatchObject({ storage: "repo", commitSha: "c-sha-2", message: "Edit first paragraph" });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toBe("[publish] version-not-saved");
  });
  it("POST /publish: a failed activity row is a warning — the commit, base and version stand", async () => {
    const doc = await repoDoc({ local: LOCAL });
    const errors = quietErrors();
    vi.mocked(recordActivity).mockRejectedValueOnce(dbDown());
    const res = await publishPost(post(`/api/documents/${doc.id}/publish`), params(doc.id));
    expect(res.status).toBe(200);
    const b = await body<PublishBody>(res);
    expect(b.warnings).toEqual(["activity-not-recorded"]);
    expect(await getPublishedContent(doc.id)).toBe(LOCAL);
    expect((await listVersions(doc.id))[0].title).toBe("Committed to main");
    expect((await listActivity(doc.id)).items.filter((a) => a.action === "publish")).toHaveLength(0);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toBe("[publish] activity-not-recorded");
  });
  it("POST /publish: both tails failing list both codes, in order", async () => {
    const doc = await gistDoc({ local: LOCAL });
    quietErrors();
    vi.mocked(addVersion).mockRejectedValueOnce(dbDown());
    vi.mocked(recordActivity).mockRejectedValueOnce(dbDown());
    const res = await publishPost(post(`/api/documents/${doc.id}/publish`), params(doc.id));
    expect(res.status).toBe(200);
    expect((await body<PublishBody>(res)).warnings).toEqual(["version-not-saved", "activity-not-recorded"]);
    expect(remote.gist.content).toBe(LOCAL);
    expect((await getDocument(doc.id))!.githubSha).toBe("rev-2");
  });
  it("a failing GitHub write is still fatal and leaves the base alone", async () => {
    const doc = await repoDoc({ local: LOCAL });
    const { commitRepoFile } = await import("@/server/github");
    vi.mocked(commitRepoFile).mockRejectedValueOnce(Object.assign(new Error("Bad credentials"), { status: 401 }));
    await expect(publishDocument(doc, user)).rejects.toMatchObject({ message: "Bad credentials" });
    expect(await getPublishedContent(doc.id)).toBe(BASE);
    expect((await getDocument(doc.id))!.githubSha).toBe("sha-1");
    expect(remote.repo.content).toBe(BASE);
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
