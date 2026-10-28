// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DocumentDto } from "@/server/dto";

vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));
const api = vi.hoisted(() => ({
  gists: vi.fn(),
  repos: vi.fn(),
  branches: vi.fn(),
  files: vi.fn(),
  importDocument: vi.fn(),
  link: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      github: { gists: api.gists, repos: api.repos, branches: api.branches, files: api.files },
      import: api.importDocument,
      documents: { ...actual.api.documents, link: api.link },
    },
  };
});

import { GitHubPicker } from "./github-dialog";

const gist = {
  id: "g1",
  description: "Notes",
  public: true,
  updatedAt: new Date().toISOString(),
  htmlUrl: "https://gist.github.com/g1",
  files: [{ filename: "notes.md", language: "Markdown", size: 1 }],
};
const repo = {
  owner: "me",
  name: "docs",
  fullName: "me/docs",
  private: false,
  defaultBranch: "main",
  pushedAt: null,
  htmlUrl: "https://github.com/me/docs",
  description: null,
};
const doc = { id: "doc1", title: "My Doc", storage: "local" } as DocumentDto;

beforeEach(() => {
  api.gists.mockResolvedValue({ gists: [gist] });
  api.repos.mockResolvedValue({ repos: [repo] });
  api.branches.mockResolvedValue({ branches: ["main", "dev"] });
  api.files.mockResolvedValue({ files: [{ path: "README.md", sha: "1" }] });
  api.importDocument.mockResolvedValue({ document: { id: "new1" } });
  api.link.mockResolvedValue({ document: { ...doc, storage: "repo" } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Synthetic events (isTrusted === false) must be honored like real input: issue #2222.
describe("GitHubPicker honors ordinary input events", () => {
  it("imports a gist file from a userEvent click, once for a double click", async () => {
    let finish!: (value: { document: { id: string } }) => void;
    api.importDocument.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const onImported = vi.fn();
    render(<GitHubPicker mode="import" githubAvailable githubConfigured onImported={onImported} />);
    const row = await screen.findByTestId("gist-item");
    await userEvent.dblClick(row);
    finish({ document: { id: "new1" } });
    await waitFor(() => expect(onImported).toHaveBeenCalledWith("new1"));
    expect(api.importDocument).toHaveBeenCalledOnce();
    expect(api.importDocument).toHaveBeenCalledWith({ source: "gist", gistId: "g1", filename: "notes.md" });
  });

  it("filters, switches source, picks a repository and branch, and connects a typed path", async () => {
    const onLinked = vi.fn();
    render(<GitHubPicker mode="link" doc={doc} githubAvailable githubConfigured onLinked={onLinked} />);
    await userEvent.click(screen.getByTestId("picker-tab-repo"));
    expect(screen.getByTestId("picker-tab-repo")).toHaveAttribute("aria-pressed", "true");
    await userEvent.type(screen.getByPlaceholderText("Filter repositories"), "docs");
    await userEvent.click(await screen.findByTestId("repo-item"));
    const select = await screen.findByTestId("branch-select");
    fireEvent.change(select, { target: { value: "dev" } });
    await waitFor(() => expect(api.files).toHaveBeenLastCalledWith("me", "docs", "dev"));
    await userEvent.type(screen.getByTestId("repo-path"), "guide.md{Enter}");
    await waitFor(() => expect(onLinked).toHaveBeenCalledOnce());
    expect(api.link).toHaveBeenCalledWith("doc1", { storage: "repo", owner: "me", repo: "docs", branch: "dev", path: "guide.md" });
  });

  it("creates a new gist with typed name and Public toggled", async () => {
    render(<GitHubPicker mode="link" doc={doc} githubAvailable githubConfigured onLinked={vi.fn()} />);
    const name = screen.getByTestId("gist-filename");
    await userEvent.clear(name);
    await userEvent.type(name, "x.md");
    await userEvent.click(screen.getByLabelText("Public"));
    await userEvent.click(screen.getByTestId("gist-create"));
    await waitFor(() =>
      expect(api.link).toHaveBeenCalledWith("doc1", { storage: "gist", gistId: undefined, filename: "x.md", isPublic: true, description: "My Doc" }),
    );
  });

  it("moves focus between source buttons with arrow keys without selecting", async () => {
    render(<GitHubPicker mode="import" githubAvailable githubConfigured />);
    const gistTab = screen.getByTestId("picker-tab-gist");
    const repoTab = screen.getByTestId("picker-tab-repo");
    gistTab.focus();
    fireEvent.keyDown(gistTab, { key: "ArrowRight" });
    expect(repoTab).toHaveFocus();
    expect(gistTab).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(repoTab, { key: "Home" });
    expect(gistTab).toHaveFocus();
    await screen.findByTestId("gist-item");
  });

  it("retries a failed list load from a fireEvent click", async () => {
    api.gists.mockRejectedValueOnce(new Error("boom"));
    render(<GitHubPicker mode="import" githubAvailable githubConfigured />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("gist-item")).toBeInTheDocument();
    expect(api.gists).toHaveBeenCalledTimes(2);
  });
});
