import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { execSync } from "node:child_process";
import type { DocumentMeta } from "@/server/documents";

// Real GitHub against the scratch repository (burkeholland/markdoc-scratch): opt-in, not part of an
// ordinary `npm test`. Runs only with MARKDOC_GITHUB_INTEGRATION=1 *and* a token (GITHUB_TOKEN, else
// `gh auth token`, which is read only when the flag is set so a plain run never spawns `gh`); the
// release preflight runs it as `MARKDOC_GITHUB_INTEGRATION=1 npm run test:github`. The files it
// creates are deleted at the end.
process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;
delete process.env.GITHUB_MOCK;

const integrationEnvironmentName = "MARKDOC_GITHUB_INTEGRATION";
const enabled = Boolean(process.env[integrationEnvironmentName]);

function findToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync("gh auth token", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
const token = enabled ? findToken() : null;
if (token) process.env.GITHUB_TOKEN = token;
const [owner, repo] = (process.env.SCRATCH_REPO ?? "burkeholland/markdoc-scratch").split("/");

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const BASE = "# Integration\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";

describe.skipIf(!enabled || !token)("GitHub sync against the scratch repository", () => {
  const path = `markdoc-sync-test/${Date.now()}-${process.pid}.md`;
  let user: { id: string; login: string; name: string; image: null };
  let octokit: import("@octokit/rest").Octokit;
  let fileSha: string | null = null;
  /** Extra files committed by a test, deleted at the end. */
  const extra: { path: string; sha: string }[] = [];

  beforeAll(async () => {
    const { getDb, schema } = await import("@/server/db");
    const { githubClient, commitRepoFile } = await import("@/server/github");
    const db = await getDb();
    const [u] = await db.insert(schema.users).values({ name: "Integ", login: "integ", email: "integ-sync@example.com" }).returning();
    user = { id: u.id, login: "integ", name: "Integ", image: null };
    octokit = githubClient(token!);
    const created = await commitRepoFile(octokit, { owner, repo, path, branch: "main", content: BASE, message: "markdoc sync test: create" });
    fileSha = created.sha;
  }, 60_000);

  afterAll(async () => {
    for (const f of extra) {
      await octokit.repos.deleteFile({ owner, repo, path: f.path, branch: "main", sha: f.sha, message: "markdoc sync test: clean up" }).catch(() => undefined);
    }
    if (!fileSha) return;
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref: "main" }).catch(() => ({ data: null }));
    const sha = data && !Array.isArray(data) && data.type === "file" ? data.sha : fileSha;
    await octokit.repos.deleteFile({ owner, repo, path, branch: "main", sha, message: "markdoc sync test: clean up" }).catch(() => undefined);
  }, 60_000);

  it("classifies diverged, merges different paragraphs and publishes the merge", async () => {
    const { createDocument, getDocumentAccess } = await import("@/server/documents");
    const { replaceLiveText, readLiveText } = await import("@/server/livedoc");
    const { linkDocument, syncStatus, pullDocument, publishDocument, clearSyncCache } = await import("@/server/publish");
    const { commitRepoFile, readRepoFile } = await import("@/server/github");
    const fresh = async (id: string) => (await getDocumentAccess(id, user))!.doc;

    const doc = await createDocument({ ownerId: user.id, content: BASE });
    const linkedRow = await linkDocument(doc, user, { storage: "repo", owner, repo, branch: "main", path });
    expect(linkedRow.publishedContent).toBe(BASE);
    let linked: DocumentMeta = linkedRow;
    expect(linked.githubSha).toBe(fileSha);
    expect((await syncStatus(linked, user, { fresh: true })).status).toBe("in-sync");

    // Someone else commits; we edit a different paragraph.
    const remote = BASE.replace("Third paragraph.", "Third paragraph, edited on GitHub.");
    const committed = await commitRepoFile(octokit, { owner, repo, path, branch: "main", content: remote, message: "markdoc sync test: remote edit", sha: fileSha });
    fileSha = committed.sha;
    const ctx = { userId: user.id, docId: doc.id, role: "owner" as const, name: "Integ", login: "integ", avatar: null };
    await replaceLiveText(doc.id, ctx, BASE.replace("First paragraph.", "First paragraph, edited locally."));
    clearSyncCache(doc.id);
    linked = await fresh(doc.id);
    const status = await syncStatus(linked, user, { fresh: true });
    expect(status.status).toBe("diverged");
    expect(status.remote.sha).toBe(fileSha);

    // Publish refuses; plain pull refuses; merge joins both.
    await expect(publishDocument(linked, user)).rejects.toMatchObject({ status: 409, details: { status: "diverged" } });
    await expect(pullDocument(linked, user)).rejects.toMatchObject({ status: 409, details: { status: "diverged" } });
    const merged = await pullDocument(linked, user, { merge: true });
    expect(merged.merged).toBe(true);
    const text = (await readLiveText(doc.id)).text;
    expect(text).toContain("edited locally");
    expect(text).toContain("edited on GitHub");

    linked = await fresh(doc.id);
    const published = await publishDocument(linked, user, "markdoc sync test: merged");
    expect(published.status).toBe("in-sync");
    fileSha = (await fresh(doc.id)).githubSha;
    const onGitHub = await readRepoFile(octokit, owner, repo, path, "main");
    expect(onGitHub.content).toBe(text);
    expect(onGitHub.sha).toBe(fileSha);
  }, 120_000);

  // The Contents API inlines base64 only up to 1 MB; past that it answers `content: "", encoding: "none"`.
  it("reads a 1–2 MB file whole through the raw blob and refuses one over 2 MB with a 413", async () => {
    const { commitRepoFile, readRepoFile, GITHUB_FILE_MAX_BYTES } = await import("@/server/github");
    const { createDocument, getDocumentAccess } = await import("@/server/documents");
    const { linkDocument, syncStatus, pullDocument } = await import("@/server/publish");
    const { readLiveText } = await import("@/server/livedoc");
    const stamp = `${Date.now()}-${process.pid}`;

    const midPath = `markdoc-sync-test/${stamp}-mid.md`;
    const mid = `# Mid\n\n${"The quick brown fox jumps over the lazy dog. ".repeat(26_000)}\nEND\n`; // ~1.2 MB
    expect(Buffer.byteLength(mid)).toBeGreaterThan(1024 * 1024);
    const midCommit = await commitRepoFile(octokit, { owner, repo, path: midPath, branch: "main", content: mid, message: "markdoc sync test: 1.2 MB file" });
    extra.push({ path: midPath, sha: midCommit.sha! });
    const { data: meta } = await octokit.repos.getContent({ owner, repo, path: midPath, ref: "main" });
    expect(!Array.isArray(meta) && meta.type === "file" && meta.encoding).toBe("none");
    const read = await readRepoFile(octokit, owner, repo, midPath, "main");
    expect(read.content).toBe(mid);
    expect(read.sha).toBe(midCommit.sha);

    const bigPath = `markdoc-sync-test/${stamp}-big.md`;
    const big = `# Big\n\n${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(40_000)}\n`; // ~2.3 MB
    expect(Buffer.byteLength(big)).toBeGreaterThan(GITHUB_FILE_MAX_BYTES);
    const bigCommit = await commitRepoFile(octokit, { owner, repo, path: bigPath, branch: "main", content: big, message: "markdoc sync test: 2.3 MB file" });
    extra.push({ path: bigPath, sha: bigCommit.sha! });
    const err = await readRepoFile(octokit, owner, repo, bigPath, "main").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 413, revision: bigCommit.sha });
    expect((err as Error).message).toMatch(/^The file on GitHub is 2\.\d+ MB; Markdoc documents are limited to 2 MB$/);

    // A document already linked to the oversized file: status is a 413, pull leaves the text alone.
    const doc = await createDocument({ ownerId: user.id, content: BASE });
    await expect(linkDocument(doc, user, { storage: "repo", owner, repo, branch: "main", path: bigPath })).rejects.toMatchObject({ status: 413 });
    const { updateDocument } = await import("@/server/documents");
    await updateDocument(doc.id, { storage: "repo", repoOwner: owner, repoName: repo, repoBranch: "main", repoPath: bigPath, githubSha: "stale", publishedContent: BASE, publishedAt: new Date() });
    const linked = (await getDocumentAccess(doc.id, user))!.doc;
    await expect(syncStatus(linked, user, { fresh: true })).rejects.toMatchObject({ status: 413, details: { status: "remote-unreadable" } });
    await expect(pullDocument(linked, user, { force: true })).rejects.toMatchObject({ status: 413 });
    expect((await readLiveText(doc.id)).text).toBe(BASE);
  }, 180_000);
});
