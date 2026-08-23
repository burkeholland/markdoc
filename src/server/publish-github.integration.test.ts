import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { execSync } from "node:child_process";

// Real GitHub against the scratch repository (burkeholland/markdoc-scratch). Runs only when a token
// is available (GITHUB_TOKEN or `gh auth token`); the file it creates is deleted at the end.
process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;
delete process.env.GITHUB_MOCK;

function findToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync("gh auth token", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
const token = findToken();
if (token) process.env.GITHUB_TOKEN = token;
const [owner, repo] = (process.env.SCRATCH_REPO ?? "burkeholland/markdoc-scratch").split("/");

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const BASE = "# Integration\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";

describe.skipIf(!token)("GitHub sync against the scratch repository", () => {
  const path = `markdoc-sync-test/${Date.now()}-${process.pid}.md`;
  let user: { id: string; login: string; name: string; image: null };
  let octokit: import("@octokit/rest").Octokit;
  let fileSha: string | null = null;

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
    let linked = await linkDocument(doc, user, { storage: "repo", owner, repo, branch: "main", path });
    expect(linked.publishedContent).toBe(BASE);
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
});
