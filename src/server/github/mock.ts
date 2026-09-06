import { createHash } from "node:crypto";
import { HttpError } from "@/server/http";
import { GITHUB_FILE_MAX_BYTES, GitHubFileTooLargeError } from "./limits";

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
  /** Bytes GitHub would report; defaults to the content's length. A fixture over the bound stands in for a 1–100 MB file. */
  size: number;
}

interface MockState {
  repos: Map<string, FakeFile>;
  gists: Map<string, { files: Map<string, string>; revision: string; description: string | null; updatedAt: string; isPublic: boolean }>;
  counter: number;
}

// Next routes and the custom-server worker have separate module graphs in the same process.
const globalMock = globalThis as typeof globalThis & { __markdocGithubMock?: MockState };
const state: MockState = globalMock.__markdocGithubMock ??= { repos: new Map(), gists: new Map(), counter: 0 };
const { repos, gists } = state;

const blobSha = (content: string) => createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
const repoKey = (owner: string, repo: string, branch: string, path: string) => `${owner}/${repo}@${branch}:${path}`;
const nextRevision = () => `rev-${++state.counter}-${Date.now().toString(36)}`;

export function mockReset() {
  repos.clear();
  gists.clear();
  state.counter = 0;
}

export function mockSetRepoFile(owner: string, repo: string, branch: string, path: string, content: string, size?: number) {
  const file: FakeFile = { content, sha: blobSha(content), updatedAt: new Date().toISOString(), size: size ?? Buffer.byteLength(content, "utf8") };
  repos.set(repoKey(owner, repo, branch, path), file);
  return file;
}

export function mockGetRepoFile(owner: string, repo: string, branch: string, path: string) {
  return repos.get(repoKey(owner, repo, branch, path)) ?? null;
}

export function mockSetGistFile(gistId: string, filename: string, content: string) {
  const gist = gists.get(gistId) ?? { files: new Map<string, string>(), revision: nextRevision(), description: null, updatedAt: new Date().toISOString(), isPublic: false };
  gist.files.set(filename, content);
  gist.revision = nextRevision();
  gist.updatedAt = new Date().toISOString();
  gists.set(gistId, gist);
  return gist;
}

export function mockGetGist(gistId: string) {
  return gists.get(gistId) ?? null;
}

/** GitHub accounts the fake knows for user search; more than eight `octo…` logins so the eight-suggestion cap is observable. */
const MOCK_USERS = ["octocat", "octodog", "octofox", "octopus", "octoling", "octobot", "octonaut", "octopod", "octoprint", "monalisa", "hubot", "defunkt", "mojombo"];

export const mockGithub = {
  async readRepoFile(owner: string, repo: string, path: string, ref: string) {
    const file = repos.get(repoKey(owner, repo, ref, path));
    if (!file) throw new HttpError(404, "Not Found");
    // Like GitHub past 1 MB: the sha is known, the text is not readable into a document.
    if (file.size > GITHUB_FILE_MAX_BYTES) throw new GitHubFileTooLargeError(file.size, file.sha);
    return { content: file.content, sha: file.sha, htmlUrl: `https://github.com/${owner}/${repo}/blob/${ref}/${path}`, updatedAt: file.updatedAt };
  },
  async commitRepoFile(input: { owner: string; repo: string; path: string; branch: string; content: string; message: string; sha?: string | null }) {
    const key = repoKey(input.owner, input.repo, input.branch, input.path);
    const existing = repos.get(key);
    if (existing && input.sha && existing.sha !== input.sha) {
      throw new HttpError(409, "The file changed on GitHub since it was last pulled. Pull the latest version first.");
    }
    const file = mockSetRepoFile(input.owner, input.repo, input.branch, input.path, input.content);
    const commitSha = createHash("sha1").update(`${key}:${file.sha}:${++state.counter}`).digest("hex");
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
    const name = filename ?? [...gist.files.keys()][0];
    if (!name || !gist.files.has(name)) throw new HttpError(404, "Gist file not found");
    return {
      gistId,
      filename: name,
      content: gist.files.get(name)!,
      description: gist.description,
      htmlUrl: `https://gist.github.com/${gistId}`,
      isPublic: gist.isPublic,
      owner: "mock",
      revision: gist.revision,
      updatedAt: gist.updatedAt,
    };
  },
  async createGist(input: { filename: string; content: string; description?: string; isPublic: boolean }) {
    const gistId = `mockgist${++state.counter}`;
    const gist = mockSetGistFile(gistId, input.filename, input.content);
    gist.description = input.description ?? null;
    gist.isPublic = input.isPublic;
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
      .map(([key, file]) => ({ path: key.slice(prefix.length), type: "file" as const, size: file.size, sha: file.sha }));
  },
  /** Fixed accounts for the Share dialog's handle autocomplete, matched on the login prefix (case-insensitive), at most 8. */
  searchUsers(prefix: string) {
    const needle = prefix.toLowerCase();
    return MOCK_USERS.filter((login) => login.toLowerCase().startsWith(needle))
      .slice(0, 8)
      .map((login) => ({ login, name: null, avatarUrl: `https://avatars.githubusercontent.com/${login}?s=40` }));
  },
};
