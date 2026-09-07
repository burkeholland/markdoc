// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const signIn = vi.fn(() => new Promise<void>(() => {}));
vi.mock("next-auth/react", () => ({ signIn: (...args: unknown[]) => signIn(...(args as [])) }));

interface Gist {
  id: string;
  description: string | null;
  public: boolean;
  updatedAt: string;
  htmlUrl: string;
  files: { filename: string; language: string | null; size: number }[];
}

interface Repo {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  htmlUrl: string;
  description: string | null;
}

interface RepoFile {
  path: string;
  sha: string;
}

const gists = vi.fn<() => Promise<{ gists: Gist[] }>>();
const repos = vi.fn<() => Promise<{ repos: Repo[] }>>();
const branches = vi.fn<(owner: string, repo: string) => Promise<{ branches: string[] }>>();
const files = vi.fn<(owner: string, repo: string, branch: string) => Promise<{ files: RepoFile[] }>>();
const importDocument = vi.fn<(body: Record<string, unknown>) => Promise<{ document: { id: string; title: string } }>>();
const linkDocument = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      github: {
        ...actual.api.github,
        gists: () => gists(),
        repos: () => repos(),
        branches: (owner: string, repo: string) => branches(owner, repo),
        files: (owner: string, repo: string, branch: string) => files(owner, repo, branch),
      },
      import: (body: Record<string, unknown>) => importDocument(body),
      documents: {
        ...actual.api.documents,
        link: (...args: unknown[]) => linkDocument(...args),
      },
    },
  };
});

import { GitHubPicker } from "./github-dialog";
import { GITHUB_NOT_CONFIGURED } from "./labels";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function gist(id = "gist-current", filename = "current.md"): Gist {
  return {
    id,
    description: `${id} description`,
    public: false,
    updatedAt: "2026-09-07T12:00:00.000Z",
    htmlUrl: `https://gist.github.com/${id}`,
    files: [{ filename, language: "Markdown", size: 12 }],
  };
}

function repository(name = "current", defaultBranch = "main"): Repo {
  return {
    owner: "octo",
    name,
    fullName: `octo/${name}`,
    private: false,
    defaultBranch,
    pushedAt: "2026-09-07T12:00:00.000Z",
    htmlUrl: `https://github.com/octo/${name}`,
    description: `${name} repository`,
  };
}

function repoFile(path: string): RepoFile {
  return { path, sha: `sha-${path}` };
}

const currentRepo = repository();

beforeEach(() => {
  gists.mockReset().mockResolvedValue({ gists: [gist()] });
  repos.mockReset().mockResolvedValue({ repos: [currentRepo] });
  branches.mockReset().mockResolvedValue({ branches: ["main"] });
  files.mockReset().mockResolvedValue({ files: [repoFile("README.md")] });
  importDocument.mockReset().mockResolvedValue({ document: { id: "imported", title: "Imported" } });
  linkDocument.mockReset();
  signIn.mockClear();
});

afterEach(cleanup);

function renderPicker() {
  return render(<GitHubPicker mode="import" githubAvailable githubConfigured />);
}

async function selectRepository(name = currentRepo.fullName) {
  fireEvent.click(screen.getByTestId("picker-tab-repo"));
  const items = await screen.findAllByTestId("repo-item");
  const item = items.find((candidate) => candidate.textContent?.includes(name));
  expect(item).toBeDefined();
  fireEvent.click(item!);
}

// The empty state of the GitHub picker for an account without a GitHub token (#162): it used to be a
// sentence with no control, so every non-GitHub account dead-ended on Close.
describe("GitHubPicker without a GitHub token", () => {
  it("offers Sign in with GitHub that returns to the current page when the server has a GitHub OAuth app", () => {
    render(<GitHubPicker mode="import" githubAvailable={false} githubConfigured />);
    const button = screen.getByRole("button", { name: /Sign in with GitHub/ });
    expect(screen.queryByTestId("github-not-configured")).toBeNull();
    expect(screen.queryByTestId("github-picker")).toBeNull();

    fireEvent.click(button);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith("github", { redirectTo: window.location.href });
    expect(button).toBeDisabled();
  });

  it("says GitHub storage is not set up, with no sign-in button, when the server has no GitHub OAuth app", () => {
    render(<GitHubPicker mode="link" githubAvailable={false} githubConfigured={false} />);
    expect(screen.getByTestId("github-not-configured")).toHaveTextContent(GITHUB_NOT_CONFIGURED);
    expect(screen.getByTestId("github-not-configured")).toHaveTextContent("AUTH_GITHUB_ID");
    expect(screen.queryByRole("button")).toBeNull();
    expect(signIn).not.toHaveBeenCalled();
  });
});

describe("GitHubPicker list recovery", () => {
  it("replaces a gist failure with its API reason and one guarded retry that reaches the empty state", async () => {
    const retry = deferred<{ gists: Gist[] }>();
    gists.mockReset().mockRejectedValueOnce(new Error("GitHub refused the gist request")).mockReturnValueOnce(retry.promise);

    renderPicker();

    const alert = await screen.findByTestId("gist-load-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert).toHaveTextContent("Could not load gists. GitHub refused the gist request");
    expect(screen.getByTestId("gist-list").querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByText("No Markdown gists found.")).toBeNull();

    const retryButton = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(gists).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    retry.resolve({ gists: [] });
    expect(await screen.findByText("No Markdown gists found.")).toBeInTheDocument();
    expect(screen.queryByTestId("gist-load-error")).toBeNull();
  });

  it("replaces a repository failure with a fallback and retries once to populated results", async () => {
    const retry = deferred<{ repos: Repo[] }>();
    repos.mockReset().mockRejectedValueOnce("offline").mockReturnValueOnce(retry.promise);

    renderPicker();
    fireEvent.click(screen.getByTestId("picker-tab-repo"));

    const alert = await screen.findByTestId("repo-load-error");
    expect(alert).toHaveTextContent("Could not load repositories.");
    expect(screen.getByTestId("repo-list").querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByText("No repositories found.")).toBeNull();

    const retryButton = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(repos).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    retry.resolve({ repos: [currentRepo] });
    expect(await screen.findByText(currentRepo.fullName)).toBeInTheDocument();
    expect(screen.queryByTestId("repo-load-error")).toBeNull();
  });

  it("keeps loaded files usable while a branch failure retries to the real empty state", async () => {
    const retry = deferred<{ branches: string[] }>();
    branches.mockReset().mockRejectedValueOnce(new Error("Branch endpoint timed out")).mockReturnValueOnce(retry.promise);

    renderPicker();
    await selectRepository();

    const alert = await screen.findByTestId("branch-load-error");
    expect(alert).toHaveTextContent(`Could not load branches for ${currentRepo.fullName}. Branch endpoint timed out`);
    expect(screen.getByTestId("branch-list").querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByTestId("branch-empty")).toBeNull();
    expect(await screen.findByText("README.md")).toBeInTheDocument();

    const retryButton = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(branches).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    retry.resolve({ branches: [] });
    expect(await screen.findByTestId("branch-empty")).toHaveTextContent("No branches found.");
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.queryByTestId("branch-load-error")).toBeNull();
  });

  it("keeps the branch selector usable while a file failure retries once to populated results", async () => {
    const retry = deferred<{ files: RepoFile[] }>();
    files.mockReset().mockRejectedValueOnce(new Error("Tree request failed")).mockReturnValueOnce(retry.promise);

    renderPicker();
    await selectRepository();

    const alert = await screen.findByTestId("file-load-error");
    expect(alert).toHaveTextContent(`Could not load files from ${currentRepo.fullName} on main. Tree request failed`);
    expect(screen.getByTestId("file-list").querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByText("No Markdown files on this branch.")).toBeNull();
    expect(await screen.findByTestId("branch-select")).toHaveValue("main");

    const retryButton = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(files).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    retry.resolve({ files: [repoFile("docs/recovered.md")] });
    expect(await screen.findByText("docs/recovered.md")).toBeInTheDocument();
    expect(screen.getByTestId("branch-select")).toHaveValue("main");
    expect(screen.queryByTestId("file-load-error")).toBeNull();
  });

  it("isolates late gist errors and repository successes across tab switches", async () => {
    const oldGists = deferred<{ gists: Gist[] }>();
    const oldRepos = deferred<{ repos: Repo[] }>();
    const freshRepo = repository("fresh", "trunk");
    gists.mockReset().mockReturnValueOnce(oldGists.promise).mockResolvedValueOnce({ gists: [gist("fresh-gist", "fresh.md")] });
    repos.mockReset().mockReturnValueOnce(oldRepos.promise).mockResolvedValueOnce({ repos: [freshRepo] });

    renderPicker();
    await waitFor(() => expect(gists).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("picker-tab-repo"));
    await waitFor(() => expect(repos).toHaveBeenCalledTimes(1));

    await act(async () => {
      oldGists.reject(new Error("stale gist failure"));
      await Promise.allSettled([oldGists.promise]);
    });
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByTestId("picker-tab-gist"));
    expect(await screen.findByText("fresh.md")).toBeInTheDocument();
    expect(gists).toHaveBeenCalledTimes(2);

    await act(async () => {
      oldRepos.resolve({ repos: [repository("stale")] });
      await oldRepos.promise;
    });
    fireEvent.click(screen.getByTestId("picker-tab-repo"));
    expect(await screen.findByText(freshRepo.fullName)).toBeInTheDocument();
    expect(screen.queryByText("octo/stale")).toBeNull();
    expect(repos).toHaveBeenCalledTimes(2);
  });

  it("isolates late branch success and file error after choosing another repository", async () => {
    const firstRepo = repository("first");
    const nextRepo = repository("next", "release");
    const oldBranches = deferred<{ branches: string[] }>();
    const oldFiles = deferred<{ files: RepoFile[] }>();
    repos.mockReset().mockResolvedValue({ repos: [firstRepo, nextRepo] });
    branches.mockImplementation((_owner, name) => (name === firstRepo.name ? oldBranches.promise : Promise.resolve({ branches: ["release"] })));
    files.mockImplementation((_owner, name) => (name === firstRepo.name ? oldFiles.promise : Promise.resolve({ files: [repoFile("next.md")] })));

    renderPicker();
    await selectRepository(firstRepo.fullName);
    await waitFor(() => expect(files).toHaveBeenCalledWith(firstRepo.owner, firstRepo.name, "main"));
    fireEvent.click(screen.getByRole("button", { name: /Repositories/ }));
    const nextItem = (await screen.findAllByTestId("repo-item")).find((candidate) => candidate.textContent?.includes(nextRepo.fullName));
    fireEvent.click(nextItem!);

    expect(await screen.findByText("next.md")).toBeInTheDocument();
    expect(screen.getByTestId("branch-select")).toHaveValue("release");
    await act(async () => {
      oldBranches.resolve({ branches: ["legacy"] });
      oldFiles.reject(new Error("stale file failure"));
      await Promise.allSettled([oldBranches.promise, oldFiles.promise]);
    });

    expect(screen.getByTestId("branch-select")).toHaveValue("release");
    expect(screen.queryByRole("option", { name: "legacy" })).toBeNull();
    expect(screen.getByText("next.md")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not let a late file success replace the selected branch", async () => {
    const oldFiles = deferred<{ files: RepoFile[] }>();
    branches.mockReset().mockResolvedValue({ branches: ["main", "next"] });
    files.mockImplementation((_owner, _repo, branch) => (branch === "main" ? oldFiles.promise : Promise.resolve({ files: [repoFile("next-branch.md")] })));

    renderPicker();
    await selectRepository();
    const branchSelect = await screen.findByTestId("branch-select");
    await waitFor(() => expect(files).toHaveBeenCalledWith(currentRepo.owner, currentRepo.name, "main"));
    fireEvent.change(branchSelect, { target: { value: "next" } });

    expect(await screen.findByText("next-branch.md")).toBeInTheDocument();
    expect(branchSelect).toHaveValue("next");
    await act(async () => {
      oldFiles.resolve({ files: [repoFile("stale-main.md")] });
      await oldFiles.promise;
    });

    expect(branchSelect).toHaveValue("next");
    expect(screen.getByText("next-branch.md")).toBeInTheDocument();
    expect(screen.queryByText("stale-main.md")).toBeNull();
  });

  it("keeps import errors separate while a repository list fails and recovers", async () => {
    const retry = deferred<{ repos: Repo[] }>();
    importDocument.mockRejectedValueOnce(new Error("Import was rejected"));
    repos.mockReset().mockRejectedValueOnce(new Error("Repository API unavailable")).mockReturnValueOnce(retry.promise);

    renderPicker();
    fireEvent.click(await screen.findByTestId("gist-item"));
    expect(await screen.findByTestId("github-action-error")).toHaveTextContent("Import was rejected");

    fireEvent.click(screen.getByTestId("picker-tab-repo"));
    expect(await screen.findByTestId("repo-load-error")).toHaveTextContent("Could not load repositories. Repository API unavailable");
    expect(screen.getByTestId("github-action-error")).toHaveTextContent("Import was rejected");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(repos).toHaveBeenCalledTimes(2);
    retry.resolve({ repos: [] });
    expect(await screen.findByText("No repositories found.")).toBeInTheDocument();
    expect(screen.queryByTestId("repo-load-error")).toBeNull();
    expect(screen.getByTestId("github-action-error")).toHaveTextContent("Import was rejected");
    expect(importDocument).toHaveBeenCalledTimes(1);
  });
});
