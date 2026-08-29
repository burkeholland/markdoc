import { Octokit } from "@octokit/rest";
import { HttpError } from "@/server/http";
import { isGitHubMock, mockGithub } from "./mock";
import { GITHUB_FILE_MAX_BYTES, GitHubFileTooLargeError, assertWithinBound } from "./limits";

export { isGitHubMock } from "./mock";
export { GITHUB_FILE_MAX_BYTES, GitHubFileTooLargeError } from "./limits";

export function githubClient(token: string): Octokit {
  // Under GITHUB_MOCK no request ever reaches the network; the client is a placeholder.
  if (isGitHubMock()) return { mock: true } as unknown as Octokit;
  return new Octokit({ auth: token, userAgent: "markdoc" });
}

export interface GistSummary {
  id: string;
  description: string | null;
  public: boolean;
  updatedAt: string;
  htmlUrl: string;
  files: { filename: string; language: string | null; size: number }[];
}

const MARKDOWN_RE = /\.(md|markdown|mdown|mkd|mdx)$/i;

/** How long the gist `raw_url` fetch may take before it is abandoned (`GITHUB_RAW_TIMEOUT_MS`). */
export const rawFetchTimeoutMs = () => Math.max(1, Number(process.env.GITHUB_RAW_TIMEOUT_MS) || 15_000);

/**
 * Download a raw text body with a deadline and a byte cap: GitHub serves a gist's `raw_url` without
 * the Contents API's 1 MB truncation (up to 10 MB), and a bare `fetch()` would neither time out nor
 * stop reading.
 */
async function fetchRawText(url: string, revision: string | null): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), rawFetchTimeoutMs());
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "markdoc" } });
    if (!res.ok) throw new HttpError(502, `GitHub answered ${res.status} for the gist file`);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > GITHUB_FILE_MAX_BYTES) throw new GitHubFileTooLargeError(declared, revision);
    if (!res.body) {
      const text = await res.text();
      assertWithinBound(text, revision);
      return text;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > GITHUB_FILE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new GitHubFileTooLargeError(null, revision);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (err) {
    if (controller.signal.aborted) throw new HttpError(408, `GitHub took longer than ${Math.round(rawFetchTimeoutMs() / 1000)} s to return the gist file. Try again.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function listMarkdownGists(octokit: Octokit): Promise<GistSummary[]> {
  const gists = await octokit.paginate(octokit.gists.list, { per_page: 100 });
  return gists
    .map((g) => ({
      id: g.id,
      description: g.description ?? null,
      public: g.public,
      updatedAt: g.updated_at,
      htmlUrl: g.html_url,
      files: Object.values(g.files ?? {})
        .filter((f): f is NonNullable<typeof f> => !!f && !!f.filename)
        .map((f) => ({ filename: f.filename!, language: f.language ?? null, size: f.size ?? 0 })),
    }))
    .filter((g) => g.files.some((f) => MARKDOWN_RE.test(f.filename) || f.language === "Markdown"))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function readGistFile(octokit: Octokit, gistId: string, filename?: string) {
  if (isGitHubMock()) return mockGithub.readGistFile(gistId, filename);
  const { data } = await octokit.gists.get({ gist_id: gistId });
  const files = Object.values(data.files ?? {}).filter((f): f is NonNullable<typeof f> => !!f);
  const file = filename
    ? files.find((f) => f.filename === filename)
    : (files.find((f) => MARKDOWN_RE.test(f.filename ?? "")) ?? files[0]);
  if (!file || !file.filename) throw new HttpError(404, "Gist file not found");
  const revision = gistRevision(data);
  // The API inlines up to 1 MB and marks the rest `truncated`; `raw_url` has the whole file.
  if (typeof file.size === "number" && file.size > GITHUB_FILE_MAX_BYTES) throw new GitHubFileTooLargeError(file.size, revision);
  let content = file.content ?? "";
  if (file.truncated && file.raw_url) content = await fetchRawText(file.raw_url, revision);
  assertWithinBound(content, revision);
  return {
    gistId: data.id!,
    filename: file.filename,
    content,
    description: data.description ?? null,
    htmlUrl: data.html_url ?? `https://gist.github.com/${data.id}`,
    isPublic: !!data.public,
    owner: data.owner?.login ?? null,
    // Gists have no per-file sha; the latest history entry is the remote revision (stored in `githubSha`).
    revision,
    updatedAt: data.updated_at ?? null,
  };
}

function gistRevision(data: { history?: { version?: string }[] | null; updated_at?: string | null }): string | null {
  return data.history?.[0]?.version ?? data.updated_at ?? null;
}

export async function createGist(octokit: Octokit, input: { filename: string; content: string; description?: string; isPublic: boolean }) {
  if (isGitHubMock()) return mockGithub.createGist(input);
  const { data } = await octokit.gists.create({
    description: input.description,
    public: input.isPublic,
    files: { [input.filename]: { content: input.content || "\n" } },
  });
  return { gistId: data.id!, htmlUrl: data.html_url!, filename: input.filename };
}

export async function updateGist(octokit: Octokit, gistId: string, filename: string, content: string, description?: string) {
  if (isGitHubMock()) return mockGithub.updateGist(gistId, filename, content, description);
  const { data } = await octokit.gists.update({
    gist_id: gistId,
    description,
    files: { [filename]: { content: content || "\n" } },
  });
  return { htmlUrl: data.html_url!, updatedAt: data.updated_at!, revision: gistRevision(data) };
}

export interface RepoSummary {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  htmlUrl: string;
  description: string | null;
}

export async function listRepos(octokit: Octokit): Promise<RepoSummary[]> {
  if (isGitHubMock()) return mockGithub.listRepos();
  const repos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
    per_page: 100,
    sort: "pushed",
    affiliation: "owner,collaborator,organization_member",
  });
  return repos.map((r) => ({
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
    pushedAt: r.pushed_at ?? null,
    htmlUrl: r.html_url,
    description: r.description ?? null,
  }));
}

export async function listBranches(octokit: Octokit, owner: string, repo: string): Promise<string[]> {
  if (isGitHubMock()) return mockGithub.listBranches(owner, repo);
  const branches = await octokit.paginate(octokit.repos.listBranches, { owner, repo, per_page: 100 });
  return branches.map((b) => b.name);
}

export interface TreeEntry {
  path: string;
  type: "file" | "dir";
  size?: number;
  sha: string;
}

/** Markdown files in a repository tree (recursive). */
export async function listMarkdownFiles(octokit: Octokit, owner: string, repo: string, ref: string): Promise<TreeEntry[]> {
  if (isGitHubMock()) return mockGithub.listMarkdownFiles(owner, repo, ref);
  const { data } = await octokit.git.getTree({ owner, repo, tree_sha: ref, recursive: "1" });
  return (data.tree ?? [])
    .filter((e) => e.type === "blob" && e.path && MARKDOWN_RE.test(e.path))
    .map((e) => ({ path: e.path!, type: "file" as const, size: e.size, sha: e.sha! }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The file's text and blob sha. The Contents API inlines base64 content only up to 1 MB; between 1 and
 * 100 MB it answers `content: "", encoding: "none"`, which must never be mistaken for an empty file.
 * Files up to `GITHUB_FILE_MAX_BYTES` are then fetched as a raw blob by sha; larger ones are a `413`.
 */
export async function readRepoFile(octokit: Octokit, owner: string, repo: string, path: string, ref: string) {
  if (isGitHubMock()) return mockGithub.readRepoFile(owner, repo, path, ref);
  const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(data) || data.type !== "file") throw new HttpError(400, "Path is not a file");
  if (data.size > GITHUB_FILE_MAX_BYTES) throw new GitHubFileTooLargeError(data.size, data.sha);
  let content: string;
  if (data.encoding === "base64" && (data.content || data.size === 0)) {
    content = Buffer.from(data.content, "base64").toString("utf8");
  } else {
    // `encoding: "none"` (or anything but base64): the body was not inlined, read the blob itself.
    const blob = await octokit.git.getBlob({ owner, repo, file_sha: data.sha, mediaType: { format: "raw" } });
    const raw: unknown = blob.data;
    if (typeof raw === "string") content = raw;
    else if (raw && typeof raw === "object" && typeof (raw as { content?: unknown }).content === "string") {
      const b = raw as { content: string; encoding?: string };
      content = b.encoding === "base64" ? Buffer.from(b.content, "base64").toString("utf8") : b.content;
    } else throw new HttpError(502, "GitHub returned the file in an unexpected format");
  }
  assertWithinBound(content, data.sha);
  return { content, sha: data.sha, htmlUrl: data.html_url ?? `https://github.com/${owner}/${repo}/blob/${ref}/${path}`, updatedAt: null as string | null };
}

export async function commitRepoFile(
  octokit: Octokit,
  input: { owner: string; repo: string; path: string; branch: string; content: string; message: string; sha?: string | null },
) {
  if (isGitHubMock()) return mockGithub.commitRepoFile(input);
  try {
    const { data } = await octokit.repos.createOrUpdateFileContents({
      owner: input.owner,
      repo: input.repo,
      path: input.path,
      branch: input.branch,
      message: input.message,
      content: Buffer.from(input.content, "utf8").toString("base64"),
      sha: input.sha ?? undefined,
    });
    return {
      sha: data.content?.sha ?? null,
      commitSha: data.commit.sha ?? null,
      htmlUrl: data.content?.html_url ?? null,
      commitUrl: data.commit.html_url ?? null,
    };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 409 || status === 422) {
      throw new HttpError(409, "The file changed on GitHub since it was last pulled. Pull the latest version first.");
    }
    throw err;
  }
}

export async function currentGitHubLogin(octokit: Octokit): Promise<string> {
  const { data } = await octokit.users.getAuthenticated();
  return data.login;
}

export interface GitHubUserSummary {
  login: string;
  /** Search results carry no display name; the UI shows `@login`. */
  name: string | null;
  avatarUrl: string;
}

export interface UserSearchResult {
  users: GitHubUserSummary[];
  /** GitHub refused the search (403/429 — the search API allows 30 calls a minute); the list is empty, not an error. */
  limited: boolean;
}

/** How many suggestions a login prefix search returns (one autocomplete list). */
export const USER_SEARCH_LIMIT = 8;

/**
 * GitHub accounts whose login matches `prefix`, for the Share dialog's handle autocomplete. Only
 * user accounts (an organization cannot sign in, so it can never be a collaborator). A rate-limited
 * search is reported as `limited` with no users so that adding by exact handle keeps working.
 */
export async function searchUsers(octokit: Octokit, prefix: string): Promise<UserSearchResult> {
  if (isGitHubMock()) return { users: mockGithub.searchUsers(prefix), limited: false };
  try {
    const { data } = await octokit.search.users({ q: `${prefix} in:login type:user`, per_page: USER_SEARCH_LIMIT });
    return {
      users: data.items.slice(0, USER_SEARCH_LIMIT).map((u) => ({ login: u.login, name: null, avatarUrl: u.avatar_url })),
      limited: false,
    };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403 || status === 429) return { users: [], limited: true };
    throw err;
  }
}
