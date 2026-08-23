import { createHash } from "node:crypto";
import { HttpError } from "@/server/http";

/**
 * In-memory stand-in for GitHub, enabled with `GITHUB_MOCK=1` (dev/e2e only). The same function
 * signatures as `@/server/github` are served from two maps; `POST /api/github/mock` lets a test
 * edit the "remote" file to simulate another committer.
 */
export const isGitHubMock = () => process.env.GITHUB_MOCK === "1" && process.env.NODE_ENV !== "production";

interface FakeFile {
  content: string;
  sha: string;
  updatedAt: string;
}

const repos = new Map<string, FakeFile>(); // key: owner/repo@branch:path
const gists = new Map<string, { files: Map<string, string>; revision: string; description: string | null; updatedAt: string }>();
let counter = 0;

const blobSha = (content: string) => createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
const repoKey = (owner: string, repo: string, branch: string, path: string) => `${owner}/${repo}@${branch}:${path}`;
const nextRevision = () => `rev-${++counter}-${Date.now().toString(36)}`;

export function mockReset() {
  repos.clear();
  gists.clear();
  counter = 0;
}

export function mockSetRepoFile(owner: string, repo: string, branch: string, path: string, content: string) {
  const file: FakeFile = { content, sha: blobSha(content), updatedAt: new Date().toISOString() };
  repos.set(repoKey(owner, repo, branch, path), file);
  return file;
}

export function mockGetRepoFile(owner: string, repo: string, branch: string, path: string) {
  return repos.get(repoKey(owner, repo, branch, path)) ?? null;
}

export function mockSetGistFile(gistId: string, filename: string, content: string) {
  const gist = gists.get(gistId) ?? { files: new Map<string, string>(), revision: nextRevision(), description: null, updatedAt: new Date().toISOString() };
  gist.files.set(filename, content);
  gist.revision = nextRevision();
  gist.updatedAt = new Date().toISOString();
  gists.set(gistId, gist);
  return gist;
}

export function mockGetGist(gistId: string) {
  return gists.get(gistId) ?? null;
}

export const mockGithub = {
  async readRepoFile(owner: string, repo: string, path: string, ref: string) {
    const file = repos.get(repoKey(owner, repo, ref, path));
    if (!file) throw new HttpError(404, "Not Found");
    return { content: file.content, sha: file.sha, htmlUrl: `https://github.com/${owner}/${repo}/blob/${ref}/${path}`, updatedAt: file.updatedAt };
  },
  async commitRepoFile(input: { owner: string; repo: string; path: string; branch: string; content: string; message: string; sha?: string | null }) {
    const key = repoKey(input.owner, input.repo, input.branch, input.path);
    const existing = repos.get(key);
    if (existing && input.sha && existing.sha !== input.sha) {
      throw new HttpError(409, "The file changed on GitHub since it was last pulled. Pull the latest version first.");
    }
    const file = mockSetRepoFile(input.owner, input.repo, input.branch, input.path, input.content);
    const commitSha = createHash("sha1").update(`${key}:${file.sha}:${++counter}`).digest("hex");
    return {
      sha: file.sha,
      commitSha,
      htmlUrl: `https://github.com/${input.owner}/${input.repo}/blob/${input.branch}/${input.path}`,
      commitUrl: `https://github.com/${input.owner}/${input.repo}/commit/${commitSha}`,
    };
  },
  async readGistFile(gistId: string, filename?: string) {
    const gist = gists.get(gistId);
    if (!gist) throw new HttpError(404, "Gist file not found");
    const name = filename && gist.files.has(filename) ? filename : [...gist.files.keys()][0];
    if (!name) throw new HttpError(404, "Gist file not found");
    return {
      gistId,
      filename: name,
      content: gist.files.get(name)!,
      description: gist.description,
      htmlUrl: `https://gist.github.com/${gistId}`,
      isPublic: false,
      owner: "mock",
      revision: gist.revision,
      updatedAt: gist.updatedAt,
    };
  },
  async createGist(input: { filename: string; content: string; description?: string; isPublic: boolean }) {
    const gistId = `mockgist${++counter}`;
    const gist = mockSetGistFile(gistId, input.filename, input.content);
    gist.description = input.description ?? null;
    return { gistId, htmlUrl: `https://gist.github.com/${gistId}`, filename: input.filename };
  },
  async updateGist(gistId: string, filename: string, content: string, description?: string) {
    const gist = mockSetGistFile(gistId, filename, content);
    if (description !== undefined) gist.description = description;
    return { htmlUrl: `https://gist.github.com/${gistId}`, updatedAt: gist.updatedAt, revision: gist.revision };
  },
  async listRepos() {
    const seen = new Map<string, { owner: string; name: string }>();
    for (const key of repos.keys()) {
      const [owner, rest] = key.split("/");
      const name = rest.split("@")[0];
      seen.set(`${owner}/${name}`, { owner, name });
    }
    return [...seen.values()].map((r) => ({
      owner: r.owner,
      name: r.name,
      fullName: `${r.owner}/${r.name}`,
      private: true,
      defaultBranch: "main",
      pushedAt: null,
      htmlUrl: `https://github.com/${r.owner}/${r.name}`,
      description: "GITHUB_MOCK repository",
    }));
  },
  async listBranches(owner: string, repo: string) {
    const out = new Set<string>();
    for (const key of repos.keys()) if (key.startsWith(`${owner}/${repo}@`)) out.add(key.slice(key.indexOf("@") + 1, key.indexOf(":")));
    return [...out];
  },
  async listMarkdownFiles(owner: string, repo: string, ref: string) {
    const prefix = `${owner}/${repo}@${ref}:`;
    return [...repos.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, file]) => ({ path: key.slice(prefix.length), type: "file" as const, size: file.content.length, sha: file.sha }));
  },
};
