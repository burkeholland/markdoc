import { Octokit } from "@octokit/rest";
import { HttpError } from "@/server/http";
import { isGitHubMock, mockGithub } from "./mock";

export { isGitHubMock } from "./mock";

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
  let content = file.content ?? "";
  if (file.truncated && file.raw_url) {
    const res = await fetch(file.raw_url);
    content = await res.text();
  }
  return {
    gistId: data.id!,
    filename: file.filename,
    content,
    description: data.description ?? null,
    htmlUrl: data.html_url ?? `https://gist.github.com/${data.id}`,
    isPublic: !!data.public,
    owner: data.owner?.login ?? null,
    // Gists have no per-file sha; the latest history entry is the remote revision (stored in `githubSha`).
    revision: gistRevision(data),
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

export async function readRepoFile(octokit: Octokit, owner: string, repo: string, path: string, ref: string) {
  if (isGitHubMock()) return mockGithub.readRepoFile(owner, repo, path, ref);
  const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(data) || data.type !== "file") throw new HttpError(400, "Path is not a file");
  const content = data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : data.content;
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
