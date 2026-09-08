// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  useEffect,
  useLayoutEffect,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { createRoot } from "react-dom/client";
import type { DocumentDto } from "@/server/dto";

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
const linkDocument = vi.fn<(id: string, body: Record<string, unknown>) => Promise<{ document: DocumentDto }>>();

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
        link: (id: string, body: Record<string, unknown>) => linkDocument(id, body),
      },
    },
  };
});

import { GitHubPicker, GitHubSignInPrompt } from "./github-dialog";
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
const unhandledRejections: unknown[] = [];

function recordUnhandledRejection(reason: unknown) {
  unhandledRejections.push(reason);
}

function documentDto(id = "doc-current", title = "Current document"): DocumentDto {
  return {
    id,
    title,
    storage: "local",
    linkAccess: "private",
    ownerId: "owner-current",
    gistId: null,
    gistFile: null,
    repoOwner: null,
    repoName: null,
    repoBranch: null,
    repoPath: null,
    publishedAt: null,
    hasUnpublishedChanges: false,
    githubUrl: null,
    createdAt: "2026-09-07T12:00:00.000Z",
    updatedAt: "2026-09-07T12:00:00.000Z",
  };
}

beforeEach(() => {
  gists.mockReset().mockResolvedValue({ gists: [gist()] });
  repos.mockReset().mockResolvedValue({ repos: [currentRepo] });
  branches.mockReset().mockResolvedValue({ branches: ["main"] });
  files.mockReset().mockResolvedValue({ files: [repoFile("README.md")] });
  importDocument.mockReset().mockResolvedValue({ document: { id: "imported", title: "Imported" } });
  linkDocument.mockReset().mockResolvedValue({ document: documentDto() });
  signIn.mockReset().mockImplementation(() => new Promise<void>(() => {}));
  unhandledRejections.length = 0;
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(() => {
  cleanup();
  process.off("unhandledRejection", recordUnhandledRejection);
});

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

function PickerLayoutBoundary({
  boundary = 0,
  onBoundary,
  children,
}: {
  boundary?: number;
  onBoundary?: () => void;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return children;
}

function PassiveCleanupProbe({ onCleanup }: { onCleanup: () => void }) {
  useEffect(() => onCleanup, [onCleanup]);
  return null;
}

function PickerSlot({ name, githubAvailable = true }: { name: string; githubAvailable?: boolean }) {
  return (
    <section data-testid={`picker-slot-${name}`}>
      <GitHubPicker mode="import" githubAvailable={githubAvailable} githubConfigured />
    </section>
  );
}

function pickerSlot(name: string) {
  return within(screen.getByTestId(`picker-slot-${name}`));
}

function reactProp<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const value = props?.[name];
  if (typeof value !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return value as T;
}

type PickerClickHandler = (event: ReactMouseEvent<HTMLButtonElement>) => void;
type PickerChangeHandler<T extends HTMLInputElement | HTMLSelectElement> = (event: ChangeEvent<T>) => void;

function nativePickerClick(control: HTMLButtonElement, target: EventTarget | null = control, type = "click") {
  const MouseEventConstructor = control.ownerDocument.defaultView?.MouseEvent;
  if (!MouseEventConstructor) throw new Error("The picker control has no owner-document MouseEvent");
  const event = new MouseEventConstructor(type, { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function directPickerClick(
  handler: PickerClickHandler,
  control: HTMLButtonElement,
  {
    currentTarget = control,
    target = control,
    nativeEvent = nativePickerClick(control, target),
  }: {
    currentTarget?: HTMLButtonElement;
    target?: EventTarget | null;
    nativeEvent?: Event;
  } = {},
) {
  handler({
    type: "click",
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented: false,
  } as unknown as ReactMouseEvent<HTMLButtonElement>);
}

function nativePickerChange(control: HTMLInputElement | HTMLSelectElement, target: EventTarget | null = control, type = "change") {
  const EventConstructor = control.ownerDocument.defaultView?.Event;
  if (!EventConstructor) throw new Error("The picker control has no owner-document Event");
  const event = new EventConstructor(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function directPickerChange<T extends HTMLInputElement | HTMLSelectElement>(
  handler: PickerChangeHandler<T>,
  control: T,
  {
    currentTarget = control,
    target = control,
    nativeEvent = nativePickerChange(control, target),
  }: {
    currentTarget?: T;
    target?: EventTarget | null;
    nativeEvent?: Event;
  } = {},
) {
  handler({
    type: "change",
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented: false,
  } as unknown as ChangeEvent<T>);
}

function dispatchPickerSubmit(form: HTMLFormElement, submitter: HTMLButtonElement) {
  const SubmitEventConstructor = form.ownerDocument.defaultView?.SubmitEvent;
  if (!SubmitEventConstructor) throw new Error("The picker form has no owner-document SubmitEvent");
  form.dispatchEvent(
    new SubmitEventConstructor("submit", {
      bubbles: true,
      cancelable: true,
      submitter,
    }),
  );
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

describe("GitHubSignInPrompt ownership", () => {
  it("starts one physical sign-in for two immediate activations", () => {
    const pending = deferred<void>();
    signIn.mockReturnValue(pending.promise);
    render(<GitHubSignInPrompt githubConfigured redirectTo="/documents/current" />);
    const button = screen.getByRole("button", { name: /Sign in with GitHub/ });

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith("github", { redirectTo: "/documents/current" });
    expect(button).toBeDisabled();
  });

  it("freezes the redirect input when the sign-in is claimed", () => {
    const pending = deferred<void>();
    signIn.mockReturnValue(pending.promise);
    const view = render(<GitHubSignInPrompt githubConfigured redirectTo="/documents/claimed" />);
    const button = screen.getByRole("button", { name: /Sign in with GitHub/ });

    fireEvent.click(button);
    view.rerender(<GitHubSignInPrompt githubConfigured redirectTo="/documents/replacement" />);

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith("github", { redirectTo: "/documents/claimed" });
    expect(button).toBeDisabled();
  });

  it("lets the exact current failure release one retry", async () => {
    const failed = deferred<void>();
    const retry = deferred<void>();
    signIn.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    render(<GitHubSignInPrompt githubConfigured redirectTo="/documents/retry" />);
    const button = screen.getByRole("button", { name: /Sign in with GitHub/ });

    fireEvent.click(button);
    expect(button).toBeDisabled();
    await act(async () => {
      failed.reject(new Error("GitHub sign-in failed"));
      await failed.promise.catch(() => undefined);
    });

    expect(button).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(button);
    expect(signIn).toHaveBeenCalledTimes(2);
    expect(signIn).toHaveBeenNthCalledWith(1, "github", { redirectTo: "/documents/retry" });
    expect(signIn).toHaveBeenNthCalledWith(2, "github", { redirectTo: "/documents/retry" });
    expect(button).toBeDisabled();
  });

  it("keeps a replacement prompt owned when the old failure arrives after layout cleanup", async () => {
    const oldAttempt = deferred<void>();
    const currentAttempt = deferred<void>();
    signIn.mockReturnValueOnce(oldAttempt.promise).mockReturnValueOnce(currentAttempt.promise);
    const view = render(<GitHubSignInPrompt key="old" githubConfigured redirectTo="/documents/old" />);
    fireEvent.click(screen.getByRole("button", { name: /Sign in with GitHub/ }));

    view.rerender(<GitHubSignInPrompt key="current" githubConfigured redirectTo="/documents/current" />);
    const currentButton = screen.getByRole("button", { name: /Sign in with GitHub/ });
    fireEvent.click(currentButton);
    expect(signIn).toHaveBeenCalledTimes(2);
    expect(signIn).toHaveBeenNthCalledWith(1, "github", { redirectTo: "/documents/old" });
    expect(signIn).toHaveBeenNthCalledWith(2, "github", { redirectTo: "/documents/current" });

    await act(async () => {
      oldAttempt.reject(new Error("Old GitHub sign-in failed"));
      await oldAttempt.promise.catch(() => undefined);
    });

    expect(signIn).toHaveBeenCalledTimes(2);
    expect(currentButton).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
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

  it("does not restart hidden child loads after leaving a repository and starts one fresh load per level on return", async () => {
    const oldBranches = deferred<{ branches: string[] }>();
    const oldFiles = deferred<{ files: RepoFile[] }>();
    const freshBranches = deferred<{ branches: string[] }>();
    const freshFiles = deferred<{ files: RepoFile[] }>();
    branches.mockReset().mockReturnValueOnce(oldBranches.promise).mockReturnValueOnce(freshBranches.promise);
    files.mockReset().mockReturnValueOnce(oldFiles.promise).mockReturnValueOnce(freshFiles.promise);

    renderPicker();
    await selectRepository();
    await waitFor(() => {
      expect(branches).toHaveBeenCalledTimes(1);
      expect(files).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByTestId("picker-tab-gist"));
    await act(async () => {
      oldBranches.resolve({ branches: ["legacy"] });
      oldFiles.reject(new Error("stale hidden file failure"));
      await Promise.allSettled([oldBranches.promise, oldFiles.promise]);
    });

    expect(branches).toHaveBeenCalledTimes(1);
    expect(files).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("legacy")).toBeNull();
    expect(screen.queryByText("stale hidden file failure")).toBeNull();

    fireEvent.click(screen.getByTestId("picker-tab-repo"));
    await waitFor(() => {
      expect(branches).toHaveBeenCalledTimes(2);
      expect(files).toHaveBeenCalledTimes(2);
    });
    freshBranches.resolve({ branches: ["main", "release"] });
    freshFiles.resolve({ files: [repoFile("fresh-current.md")] });

    expect(await screen.findByText("fresh-current.md")).toBeInTheDocument();
    expect(screen.getByTestId("branch-select")).toHaveValue("main");
    expect(screen.getByRole("option", { name: "release" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "legacy" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(branches).toHaveBeenCalledTimes(2);
    expect(files).toHaveBeenCalledTimes(2);
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

  it.each(["success", "failure"] as const)(
    "retires a replaced gist %s before the parent layout boundary and preserves the current owner",
    async (outcome) => {
      const oldGists = deferred<{ gists: Gist[] }>();
      const currentGists = deferred<{ gists: Gist[] }>();
      gists.mockReset().mockReturnValueOnce(oldGists.promise).mockReturnValueOnce(currentGists.promise);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let passiveCleanups = 0;
      let passiveCleanupsAtBoundary = -1;
      const recordPassiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        await act(async () => {
          root.render(
            <PickerLayoutBoundary>
              <PickerSlot key="old-gist-picker" name="old-gist" />
              <PickerSlot key="current-gist-picker" name="current-gist" />
              <PassiveCleanupProbe onCleanup={recordPassiveCleanup} />
            </PickerLayoutBoundary>,
          );
        });
        expect(gists.mock.calls).toEqual([[], []]);
        expect(repos).not.toHaveBeenCalled();
        expect(branches).not.toHaveBeenCalled();
        expect(files).not.toHaveBeenCalled();
        const currentFilter = pickerSlot("current-gist").getByPlaceholderText("Filter gists");
        currentFilter.focus();

        let boundaryReached!: () => void;
        const atBoundary = new Promise<void>((resolve) => {
          boundaryReached = resolve;
        });
        root.render(
          <PickerLayoutBoundary
            boundary={1}
            onBoundary={() => {
              passiveCleanupsAtBoundary = passiveCleanups;
              if (outcome === "success") {
                oldGists.resolve({ gists: [gist("retired-gist", "retired-gist.md")] });
              } else {
                oldGists.reject(new Error("Retired gist failure"));
              }
              boundaryReached();
            }}
          >
            <PickerSlot key="current-gist-picker" name="current-gist" />
          </PickerLayoutBoundary>,
        );
        await atBoundary;
        await act(async () => {
          await Promise.allSettled([oldGists.promise]);
          await Promise.resolve();
        });

        expect(passiveCleanupsAtBoundary).toBe(0);
        expect(gists.mock.calls).toEqual([[], []]);
        expect(pickerSlot("current-gist").getByTestId("gist-list").querySelector(".animate-spin")).not.toBeNull();
        expect(screen.queryByText("retired-gist.md")).toBeNull();
        expect(screen.queryByText("Retired gist failure")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
        expect(document.activeElement).toBe(currentFilter);
        fireEvent.click(pickerSlot("current-gist").getByTestId("picker-tab-gist"));
        fireEvent.click(pickerSlot("current-gist").getByTestId("picker-tab-gist"));
        expect(gists.mock.calls).toEqual([[], []]);

        await act(async () => {
          currentGists.resolve({ gists: [gist("current-gist", "current-gist.md")] });
          await currentGists.promise;
        });
        expect(pickerSlot("current-gist").getByText("current-gist.md")).toBeInTheDocument();
        expect(pickerSlot("current-gist").getByTestId("gist-list").querySelector(".animate-spin")).toBeNull();
        expect(gists.mock.calls).toEqual([[], []]);
        expect(unhandledRejections).toEqual([]);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["success", "failure"] as const)(
    "retires a repository %s when GitHub availability changes without releasing the current owner",
    async (outcome) => {
      const oldRepos = deferred<{ repos: Repo[] }>();
      const currentRepos = deferred<{ repos: Repo[] }>();
      gists.mockReset().mockResolvedValue({ gists: [] });
      repos.mockReset().mockReturnValueOnce(oldRepos.promise).mockReturnValueOnce(currentRepos.promise);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let passiveCleanups = 0;
      let passiveCleanupsAtBoundary = -1;
      const recordPassiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        await act(async () => {
          root.render(
            <PickerLayoutBoundary>
              <PickerSlot key="availability-picker" name="availability" />
              <PickerSlot key="current-repo-picker" name="current-repo" />
              <PassiveCleanupProbe onCleanup={recordPassiveCleanup} />
            </PickerLayoutBoundary>,
          );
        });
        fireEvent.click(pickerSlot("availability").getByTestId("picker-tab-repo"));
        fireEvent.click(pickerSlot("current-repo").getByTestId("picker-tab-repo"));
        await waitFor(() => expect(repos).toHaveBeenCalledTimes(2));
        expect(gists.mock.calls).toEqual([[], []]);
        expect(repos.mock.calls).toEqual([[], []]);
        expect(branches).not.toHaveBeenCalled();
        expect(files).not.toHaveBeenCalled();
        const currentFilter = pickerSlot("current-repo").getByPlaceholderText("Filter repositories");
        currentFilter.focus();

        let boundaryReached!: () => void;
        const atBoundary = new Promise<void>((resolve) => {
          boundaryReached = resolve;
        });
        root.render(
          <PickerLayoutBoundary
            boundary={1}
            onBoundary={() => {
              passiveCleanupsAtBoundary = passiveCleanups;
              if (outcome === "success") {
                oldRepos.resolve({ repos: [repository("retired-repository")] });
              } else {
                oldRepos.reject(new Error("Retired repository failure"));
              }
              boundaryReached();
            }}
          >
            <PickerSlot key="availability-picker" name="availability" githubAvailable={false} />
            <PickerSlot key="current-repo-picker" name="current-repo" />
          </PickerLayoutBoundary>,
        );
        await atBoundary;
        await act(async () => {
          await Promise.allSettled([oldRepos.promise]);
          await Promise.resolve();
        });

        expect(passiveCleanupsAtBoundary).toBe(0);
        expect(pickerSlot("availability").getByTestId("github-signin-prompt")).toBeInTheDocument();
        expect(pickerSlot("current-repo").getByTestId("repo-list").querySelector(".animate-spin")).not.toBeNull();
        expect(screen.queryByText("octo/retired-repository")).toBeNull();
        expect(screen.queryByText("Retired repository failure")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
        expect(document.activeElement).toBe(currentFilter);
        fireEvent.click(pickerSlot("current-repo").getByTestId("picker-tab-repo"));
        fireEvent.click(pickerSlot("current-repo").getByTestId("picker-tab-repo"));
        expect(repos.mock.calls).toEqual([[], []]);

        await act(async () => {
          currentRepos.resolve({ repos: [repository("current-repository")] });
          await currentRepos.promise;
        });
        expect(pickerSlot("current-repo").getByText("octo/current-repository")).toBeInTheDocument();
        expect(pickerSlot("current-repo").getByTestId("repo-list").querySelector(".animate-spin")).toBeNull();
        expect(repos.mock.calls).toEqual([[], []]);
        expect(unhandledRejections).toEqual([]);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("retires branch success and file failure at picker removal without disturbing current pending sources", async () => {
    const oldRepo = repository("retired-source");
    const replacementRepo = repository("replacement-source", "trunk");
    const oldBranches = deferred<{ branches: string[] }>();
    const currentBranches = deferred<{ branches: string[] }>();
    const oldFiles = deferred<{ files: RepoFile[] }>();
    const currentFiles = deferred<{ files: RepoFile[] }>();
    gists.mockReset().mockResolvedValue({ gists: [] });
    repos.mockReset().mockResolvedValueOnce({ repos: [oldRepo] }).mockResolvedValueOnce({ repos: [replacementRepo] });
    branches.mockImplementation((_owner, name) => (name === oldRepo.name ? oldBranches.promise : currentBranches.promise));
    files.mockImplementation((_owner, name) => (name === oldRepo.name ? oldFiles.promise : currentFiles.promise));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let passiveCleanups = 0;
    let passiveCleanupsAtBoundary = -1;
    const recordPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      await act(async () => {
        root.render(
          <PickerLayoutBoundary>
            <PickerSlot key="old-source-picker" name="old-source" />
            <PickerSlot key="replacement-source-picker" name="replacement-source" />
            <PassiveCleanupProbe onCleanup={recordPassiveCleanup} />
          </PickerLayoutBoundary>,
        );
      });
      fireEvent.click(pickerSlot("old-source").getByTestId("picker-tab-repo"));
      fireEvent.click(pickerSlot("replacement-source").getByTestId("picker-tab-repo"));
      const oldRepoItem = await pickerSlot("old-source").findByText(oldRepo.fullName);
      const currentRepoItem = await pickerSlot("replacement-source").findByText(replacementRepo.fullName);
      fireEvent.click(oldRepoItem);
      fireEvent.click(currentRepoItem);
      await waitFor(() => {
        expect(branches).toHaveBeenCalledTimes(2);
        expect(files).toHaveBeenCalledTimes(2);
      });
      expect(gists.mock.calls).toEqual([[], []]);
      expect(repos.mock.calls).toEqual([[], []]);
      expect(branches.mock.calls).toEqual([
        [oldRepo.owner, oldRepo.name],
        [replacementRepo.owner, replacementRepo.name],
      ]);
      expect(files.mock.calls).toEqual([
        [oldRepo.owner, oldRepo.name, oldRepo.defaultBranch],
        [replacementRepo.owner, replacementRepo.name, replacementRepo.defaultBranch],
      ]);
      const currentFilter = pickerSlot("replacement-source").getByPlaceholderText("Filter files");
      currentFilter.focus();

      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });
      root.render(
        <PickerLayoutBoundary
          boundary={1}
          onBoundary={() => {
            passiveCleanupsAtBoundary = passiveCleanups;
            oldBranches.resolve({ branches: ["legacy"] });
            oldFiles.reject(new Error("Retired file failure"));
            boundaryReached();
          }}
        >
          <PickerSlot key="replacement-source-picker" name="replacement-source" />
        </PickerLayoutBoundary>,
      );
      await atBoundary;
      await act(async () => {
        await Promise.allSettled([oldBranches.promise, oldFiles.promise]);
        await Promise.resolve();
      });

      expect(passiveCleanupsAtBoundary).toBe(0);
      expect(pickerSlot("replacement-source").getByTestId("branch-list").querySelector(".animate-spin")).not.toBeNull();
      expect(pickerSlot("replacement-source").getByTestId("file-list").querySelector(".animate-spin")).not.toBeNull();
      expect(screen.queryByRole("option", { name: "legacy" })).toBeNull();
      expect(screen.queryByText("Retired file failure")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
      expect(document.activeElement).toBe(currentFilter);
      expect(branches).toHaveBeenCalledTimes(2);
      expect(files).toHaveBeenCalledTimes(2);

      await act(async () => {
        currentBranches.resolve({ branches: ["trunk", "release"] });
        currentFiles.resolve({ files: [repoFile("docs/current.md")] });
        await Promise.all([currentBranches.promise, currentFiles.promise]);
      });
      expect(pickerSlot("replacement-source").getByTestId("branch-select")).toHaveValue("trunk");
      expect(pickerSlot("replacement-source").getByRole("option", { name: "release" })).toBeInTheDocument();
      expect(pickerSlot("replacement-source").getByText("docs/current.md")).toBeInTheDocument();
      expect(branches).toHaveBeenCalledTimes(2);
      expect(files).toHaveBeenCalledTimes(2);
      expect(unhandledRejections).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("GitHubPicker exact control publication", () => {
  it("uses one stable radio group per link picker and switches both destinations independently", async () => {
    render(
      <>
        <section data-testid="link-picker-a">
          <GitHubPicker mode="link" doc={documentDto("doc-a", "Document A")} githubAvailable githubConfigured />
        </section>
        <section data-testid="link-picker-b">
          <GitHubPicker mode="link" doc={documentDto("doc-b", "Document B")} githubAvailable githubConfigured />
        </section>
      </>,
    );
    const pickerA = within(screen.getByTestId("link-picker-a"));
    const pickerB = within(screen.getByTestId("link-picker-b"));
    const createA = pickerA.getByRole("radio", { name: "Create a new gist" }) as HTMLInputElement;
    const existingA = pickerA.getByRole("radio", { name: "Use an existing gist" }) as HTMLInputElement;
    const createB = pickerB.getByRole("radio", { name: "Create a new gist" }) as HTMLInputElement;
    const existingB = pickerB.getByRole("radio", { name: "Use an existing gist" }) as HTMLInputElement;

    expect(createA.name).toBe(existingA.name);
    expect(createB.name).toBe(existingB.name);
    expect(createA.name).not.toBe(createB.name);

    fireEvent.click(existingA);
    expect(existingA).toBeChecked();
    expect(createA).not.toBeChecked();
    expect(createB).toBeChecked();
    expect(existingB).not.toBeChecked();
    expect(await pickerA.findByTestId("gist-list")).toBeInTheDocument();

    fireEvent.click(createA);
    expect(createA).toBeChecked();
    expect(existingA).not.toBeChecked();
    expect(createB).toBeChecked();
    expect(existingB).not.toBeChecked();
    expect(pickerA.queryByTestId("gist-list")).toBeNull();

    fireEvent.click(existingB);
    expect(existingB).toBeChecked();
    expect(createB).not.toBeChecked();
    expect(createA).toBeChecked();
    expect(existingA).not.toBeChecked();
    expect(await pickerB.findByTestId("gist-list")).toBeInTheDocument();

    fireEvent.click(createB);
    expect(createB).toBeChecked();
    expect(existingB).not.toBeChecked();
    expect(createA).toBeChecked();
    expect(existingA).not.toBeChecked();
  });

  it("accepts the exact repository submit in a secondary document after rejecting foreign forms", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const secondaryDocument = frame.contentDocument;
    if (!secondaryDocument?.defaultView) throw new Error("The test iframe has no browsing context");
    const pickerHost = secondaryDocument.createElement("div");
    const foreignHost = secondaryDocument.createElement("div");
    secondaryDocument.body.append(pickerHost, foreignHost);
    const pickerView = render(
      <GitHubPicker mode="link" doc={documentDto()} githubAvailable githubConfigured />,
      { container: pickerHost },
    );
    const picker = within(pickerHost);

    try {
      fireEvent.click(picker.getByTestId("picker-tab-repo"));
      fireEvent.click(await picker.findByTestId("repo-item"));
      const path = (await picker.findByTestId("repo-path")) as HTMLInputElement;
      const form = path.form;
      const submit = picker.getByTestId("repo-link") as HTMLButtonElement;
      if (!form) throw new Error("The repository path is not attached to its form");
      fireEvent.change(path, { target: { value: "docs/secondary.md" } });
      const submitHandler = reactProp<(event: FormEvent<HTMLFormElement>) => void>(form, "onSubmit");

      const sameDocumentForeignView = render(
        <form onSubmit={submitHandler}>
          <button type="submit">Foreign submit</button>
        </form>,
        { container: foreignHost },
      );
      const crossDocumentForeignView = render(
        <form onSubmit={submitHandler}>
          <button type="submit">Cross-document submit</button>
        </form>,
      );
      try {
        const sameDocumentForeignForm = foreignHost.querySelector("form");
        const sameDocumentForeignSubmit = foreignHost.querySelector("button");
        const crossDocumentForeignForm = crossDocumentForeignView.container.querySelector("form");
        const crossDocumentForeignSubmit = crossDocumentForeignView.getByRole("button");
        if (
          !sameDocumentForeignForm ||
          !sameDocumentForeignSubmit ||
          !crossDocumentForeignForm ||
          !(crossDocumentForeignSubmit instanceof HTMLButtonElement)
        ) {
          throw new Error("A foreign submit fixture was not mounted");
        }

        act(() => dispatchPickerSubmit(sameDocumentForeignForm, sameDocumentForeignSubmit));
        act(() => dispatchPickerSubmit(crossDocumentForeignForm, crossDocumentForeignSubmit));
        expect(linkDocument).not.toHaveBeenCalled();
        expect(path).toHaveValue("docs/secondary.md");

        act(() => dispatchPickerSubmit(form, submit));
        expect(linkDocument).toHaveBeenCalledExactlyOnceWith(documentDto().id, {
          storage: "repo",
          owner: currentRepo.owner,
          repo: currentRepo.name,
          branch: "main",
          path: "docs/secondary.md",
        });
      } finally {
        sameDocumentForeignView.unmount();
        crossDocumentForeignView.unmount();
      }
    } finally {
      pickerView.unmount();
      frame.remove();
    }
  });

  it("rejects in-place gist mutation and DOM reorder without poisoning the restored exact row", async () => {
    const first = gist("gist-first", "first.md");
    const second = gist("gist-second", "second.md");
    const mutableGists = [first, second];
    const onImported = vi.fn();
    gists.mockResolvedValue({ gists: mutableGists });

    render(<GitHubPicker mode="import" githubAvailable githubConfigured onImported={onImported} />);
    const rows = await screen.findAllByTestId("gist-item");
    const firstRow = rows[0] as HTMLButtonElement;
    const list = firstRow.parentElement?.parentElement;
    const firstItem = firstRow.parentElement;
    const secondItem = rows[1]?.parentElement;
    expect(list).toBeInstanceOf(HTMLUListElement);
    expect(firstItem).toBeInstanceOf(HTMLLIElement);
    expect(secondItem).toBeInstanceOf(HTMLLIElement);

    first.id = "mutated";
    fireEvent.click(firstRow);
    expect(importDocument).not.toHaveBeenCalled();
    first.id = "gist-first";

    list!.append(firstItem!);
    fireEvent.click(firstRow);
    expect(importDocument).not.toHaveBeenCalled();
    list!.insertBefore(firstItem!, secondItem!);

    fireEvent.click(firstRow);
    expect(importDocument).toHaveBeenCalledExactlyOnceWith({
      source: "gist",
      gistId: "gist-first",
      filename: "first.md",
    });
    await waitFor(() => expect(onImported).toHaveBeenCalledExactlyOnceWith("imported"));
  });

  it("keeps a same-DOM callback replacement usable after late old refs and cross-generation handlers", async () => {
    const oldCallback = vi.fn();
    const currentCallback = vi.fn();
    const view = render(
      <GitHubPicker mode="import" githubAvailable githubConfigured onImported={oldCallback} />,
    );
    const oldRow = (await screen.findByTestId("gist-item")) as HTMLButtonElement;
    const oldHandler = reactProp<PickerClickHandler>(oldRow, "onClick");
    const oldRef = reactProp<RefCallback<HTMLButtonElement>>(oldRow, "ref");

    view.rerender(
      <GitHubPicker mode="import" githubAvailable githubConfigured onImported={currentCallback} />,
    );
    const currentRow = screen.getByTestId("gist-item") as HTMLButtonElement;
    expect(currentRow).toBe(oldRow);

    oldRef(currentRow);
    oldRef(null);
    directPickerClick(oldHandler, currentRow);
    expect(importDocument).not.toHaveBeenCalled();
    expect(oldCallback).not.toHaveBeenCalled();
    expect(currentCallback).not.toHaveBeenCalled();

    fireEvent.click(currentRow);
    await waitFor(() => expect(currentCallback).toHaveBeenCalledExactlyOnceWith("imported"));
    expect(oldCallback).not.toHaveBeenCalled();
    expect(importDocument).toHaveBeenCalledOnce();
  });

  it("isolates sibling visit handlers in both orders and accepts each exact visit once", async () => {
    const importedA = vi.fn();
    const importedB = vi.fn();
    render(
      <>
        <section data-testid="picker-visit-a">
          <GitHubPicker mode="import" githubAvailable githubConfigured onImported={importedA} />
        </section>
        <section data-testid="picker-visit-b">
          <GitHubPicker mode="import" githubAvailable githubConfigured onImported={importedB} />
        </section>
      </>,
    );
    const visitA = within(screen.getByTestId("picker-visit-a"));
    const visitB = within(screen.getByTestId("picker-visit-b"));
    const rowA = (await visitA.findByTestId("gist-item")) as HTMLButtonElement;
    const rowB = (await visitB.findByTestId("gist-item")) as HTMLButtonElement;
    const handlerA = reactProp<PickerClickHandler>(rowA, "onClick");
    const handlerB = reactProp<PickerClickHandler>(rowB, "onClick");

    directPickerClick(handlerA, rowB);
    directPickerClick(handlerB, rowA);
    expect(importDocument).not.toHaveBeenCalled();

    fireEvent.click(rowB);
    directPickerClick(handlerA, rowB);
    directPickerClick(handlerB, rowA);
    fireEvent.click(rowB);
    fireEvent.click(rowA);

    expect(importDocument).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(importedA).toHaveBeenCalledExactlyOnceWith("imported");
      expect(importedB).toHaveBeenCalledExactlyOnceWith("imported");
    });
  });

  it("retires a filtered repository row and ignores its late ref before selecting the exact visible row", async () => {
    const alpha = repository("alpha");
    const beta = repository("beta", "trunk");
    repos.mockResolvedValue({ repos: [alpha, beta] });
    renderPicker();

    fireEvent.click(screen.getByTestId("picker-tab-repo"));
    const repositoryButtons = (await screen.findAllByTestId("repo-item")) as HTMLButtonElement[];
    const alphaButton = repositoryButtons.find((button) => button.textContent?.includes(alpha.fullName))!;
    const oldHandler = reactProp<PickerClickHandler>(alphaButton, "onClick");
    const oldRef = reactProp<RefCallback<HTMLButtonElement>>(alphaButton, "ref");
    fireEvent.change(screen.getByPlaceholderText("Filter repositories"), { target: { value: "beta" } });

    const betaButton = (await screen.findByTestId("repo-item")) as HTMLButtonElement;
    expect(betaButton).toHaveTextContent(beta.fullName);
    oldRef(betaButton);
    oldRef(null);
    directPickerClick(oldHandler, betaButton);
    expect(branches).not.toHaveBeenCalled();

    fireEvent.click(betaButton);
    await waitFor(() => expect(branches).toHaveBeenCalledExactlyOnceWith(beta.owner, beta.name));
    expect(screen.getByText(beta.fullName)).toBeInTheDocument();
  });

  it("rejects fabricated field changes and mutable branch options while each restored control stays usable", async () => {
    const doc = documentDto();
    const linkView = render(
      <GitHubPicker mode="link" doc={doc} githubAvailable githubConfigured />,
    );
    const filename = screen.getByTestId("gist-filename") as HTMLInputElement;
    const filenameHandler = reactProp<PickerChangeHandler<HTMLInputElement>>(filename, "onChange");
    const foreign = document.createElement("input");
    document.body.append(foreign);

    try {
      filename.value = "fabricated.md";
      directPickerChange(filenameHandler, filename);
      filename.value = "current-document.md";
      directPickerChange(filenameHandler, filename, {
        currentTarget: foreign,
        target: foreign,
        nativeEvent: nativePickerChange(foreign),
      });
      expect(filename).toHaveValue("current-document.md");

      fireEvent.change(filename, { target: { value: "accepted.md" } });
      expect(screen.getByTestId("gist-filename")).toHaveValue("accepted.md");
    } finally {
      foreign.remove();
    }
    linkView.unmount();

    const mutableBranches = ["main", "next"];
    branches.mockResolvedValue({ branches: mutableBranches });
    renderPicker();
    await selectRepository();
    const branchSelect = (await screen.findByTestId("branch-select")) as HTMLSelectElement;
    await waitFor(() => expect(files).toHaveBeenCalledExactlyOnceWith(currentRepo.owner, currentRepo.name, "main"));

    mutableBranches[1] = "release";
    fireEvent.change(branchSelect, { target: { value: "next" } });
    expect(files).toHaveBeenCalledTimes(1);

    mutableBranches[1] = "next";
    branchSelect.value = "main";
    fireEvent.change(branchSelect, { target: { value: "next" } });
    await waitFor(() => expect(files).toHaveBeenCalledWith(currentRepo.owner, currentRepo.name, "next"));
    expect(screen.getByTestId("branch-select")).toHaveValue("next");
  });
});

describe("GitHubPicker action ownership", () => {
  it("turns immediate duplicate and mixed gist/repository activation into one physical import", async () => {
    const request = deferred<{ document: { id: string; title: string } }>();
    const onImported = vi.fn();
    importDocument.mockReturnValue(request.promise);

    render(<GitHubPicker mode="import" githubAvailable githubConfigured onImported={onImported} />);
    const gistItem = await screen.findByTestId("gist-item");
    const repoTab = screen.getByTestId("picker-tab-repo");

    fireEvent.click(gistItem);
    fireEvent.click(gistItem);
    fireEvent.click(repoTab);

    expect(importDocument).toHaveBeenCalledTimes(1);
    expect(importDocument).toHaveBeenCalledWith({ source: "gist", gistId: "gist-current", filename: "current.md" });
    expect(repos).not.toHaveBeenCalled();
    expect(repoTab).toBeDisabled();
    expect(screen.queryByTestId("repo-list")).toBeNull();

    await act(async () => {
      request.resolve({ document: { id: "imported-once", title: "Imported once" } });
      await request.promise;
    });

    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onImported).toHaveBeenCalledWith("imported-once");
    expect(repoTab).toBeEnabled();
    expect(screen.queryByTestId("github-action-error")).toBeNull();
  });

  it("releases a current failure for one retry and invokes the success callback once", async () => {
    const failed = deferred<{ document: { id: string; title: string } }>();
    const retried = deferred<{ document: { id: string; title: string } }>();
    const onImported = vi.fn();
    importDocument.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retried.promise);

    render(<GitHubPicker mode="import" githubAvailable githubConfigured onImported={onImported} />);
    fireEvent.click(await screen.findByTestId("gist-item"));
    await act(async () => {
      failed.reject(new Error("Import was rejected"));
      await Promise.allSettled([failed.promise]);
    });

    expect(screen.getByTestId("github-action-error")).toHaveTextContent("Import was rejected");
    expect(screen.getByTestId("gist-item")).toBeEnabled();
    expect(onImported).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("gist-item"));
    fireEvent.click(screen.getByTestId("gist-item"));
    expect(importDocument).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("github-action-error")).toBeNull();

    await act(async () => {
      retried.resolve({ document: { id: "retry-import", title: "Retry import" } });
      await retried.promise;
    });

    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onImported).toHaveBeenCalledWith("retry-import");
    expect(screen.getByTestId("gist-item")).toBeEnabled();
  });

  it("freezes a new-gist destination and locks its fields and alternate destination", async () => {
    const request = deferred<{ document: DocumentDto }>();
    const doc = documentDto();
    const linked = { ...doc, storage: "gist" as const, gistId: "created-gist", gistFile: "claimed.md" };
    const onLinked = vi.fn();
    linkDocument.mockReturnValue(request.promise);

    render(<GitHubPicker mode="link" doc={doc} githubAvailable githubConfigured onLinked={onLinked} />);
    const filename = screen.getByTestId("gist-filename");
    const visibility = screen.getByRole("checkbox", { name: "Public" });
    const existing = screen.getByRole("radio", { name: "Use an existing gist" });
    fireEvent.change(filename, { target: { value: "claimed.md" } });
    fireEvent.click(visibility);
    fireEvent.click(screen.getByTestId("gist-create"));

    expect(linkDocument).toHaveBeenCalledTimes(1);
    expect(linkDocument).toHaveBeenCalledWith(doc.id, {
      storage: "gist",
      gistId: undefined,
      filename: "claimed.md",
      isPublic: true,
      description: doc.title,
    });
    expect(screen.getByTestId("picker-tab-gist")).toBeDisabled();
    expect(screen.getByTestId("picker-tab-repo")).toBeDisabled();
    expect(screen.getByPlaceholderText("Filter gists")).toBeDisabled();
    expect(filename).toBeDisabled();
    expect(visibility).toBeDisabled();
    expect(existing).toBeDisabled();
    expect(screen.getByTestId("gist-create")).toBeDisabled();

    fireEvent.change(filename, { target: { value: "mutated.md" } });
    fireEvent.click(visibility);
    fireEvent.click(existing);
    fireEvent.click(screen.getByTestId("picker-tab-repo"));
    expect(filename).toHaveValue("claimed.md");
    expect(visibility).toBeChecked();
    expect(screen.queryByTestId("repo-list")).toBeNull();
    expect(linkDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve({ document: linked });
      await request.promise;
    });
    expect(onLinked).toHaveBeenCalledTimes(1);
    expect(onLinked).toHaveBeenCalledWith(linked);
  });

  it("freezes a repository destination and locks tab, back, branch, file, filter, path, and submit controls", async () => {
    const request = deferred<{ document: DocumentDto }>();
    const doc = documentDto();
    const linked = {
      ...doc,
      storage: "repo" as const,
      repoOwner: currentRepo.owner,
      repoName: currentRepo.name,
      repoBranch: "main",
      repoPath: "docs/claimed.md",
    };
    const onLinked = vi.fn();
    branches.mockResolvedValue({ branches: ["main", "next"] });
    files.mockResolvedValue({ files: [repoFile("README.md"), repoFile("docs/other.md")] });
    linkDocument.mockReturnValue(request.promise);

    render(<GitHubPicker mode="link" doc={doc} githubAvailable githubConfigured onLinked={onLinked} />);
    await selectRepository();
    const repoPath = await screen.findByTestId("repo-path");
    const branchSelect = await screen.findByTestId("branch-select");
    const fileChoice = (await screen.findAllByTestId("repo-file"))[0];
    fireEvent.change(repoPath, { target: { value: "docs/claimed.md" } });
    fireEvent.click(screen.getByTestId("repo-link"));

    expect(linkDocument).toHaveBeenCalledTimes(1);
    expect(linkDocument).toHaveBeenCalledWith(doc.id, {
      storage: "repo",
      owner: currentRepo.owner,
      repo: currentRepo.name,
      branch: "main",
      path: "docs/claimed.md",
    });
    expect(screen.getByTestId("picker-tab-gist")).toBeDisabled();
    expect(screen.getByTestId("picker-tab-repo")).toBeDisabled();
    expect(screen.getByPlaceholderText("Filter files")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Repositories/ })).toBeDisabled();
    expect(branchSelect).toBeDisabled();
    expect(fileChoice).toBeDisabled();
    expect(repoPath).toBeDisabled();
    expect(screen.getByTestId("repo-link")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Repositories/ }));
    fireEvent.change(branchSelect, { target: { value: "next" } });
    fireEvent.change(repoPath, { target: { value: "docs/mutated.md" } });
    fireEvent.click(fileChoice);
    fireEvent.click(screen.getByTestId("picker-tab-gist"));
    expect(branchSelect).toHaveValue("main");
    expect(repoPath).toHaveValue("docs/claimed.md");
    expect(screen.getByText(currentRepo.fullName)).toBeInTheDocument();
    expect(linkDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve({ document: linked });
      await request.promise;
    });
    expect(onLinked).toHaveBeenCalledTimes(1);
    expect(onLinked).toHaveBeenCalledWith(linked);
  });

  it("invalidates an import when the picker mode is replaced", async () => {
    const oldRequest = deferred<{ document: { id: string; title: string } }>();
    const onImported = vi.fn();
    const onLinked = vi.fn();
    importDocument.mockReturnValue(oldRequest.promise);
    const view = render(<GitHubPicker mode="import" githubAvailable githubConfigured onImported={onImported} />);

    fireEvent.click(await screen.findByTestId("gist-item"));
    expect(importDocument).toHaveBeenCalledTimes(1);
    view.rerender(<GitHubPicker mode="link" doc={documentDto()} githubAvailable githubConfigured onLinked={onLinked} />);
    expect(screen.getByTestId("gist-create")).toBeEnabled();

    await act(async () => {
      oldRequest.resolve({ document: { id: "stale-import", title: "Stale import" } });
      await oldRequest.promise;
    });

    expect(onImported).not.toHaveBeenCalled();
    expect(onLinked).not.toHaveBeenCalled();
    expect(screen.getByTestId("gist-create")).toBeEnabled();
    expect(screen.queryByTestId("github-action-error")).toBeNull();
  });

  it("ignores a pending action after unmount without affecting a new picker visit", async () => {
    const oldRequest = deferred<{ document: { id: string; title: string } }>();
    const oldCallback = vi.fn();
    const currentCallback = vi.fn();
    importDocument.mockReturnValue(oldRequest.promise);
    const oldView = render(<GitHubPicker mode="import" githubAvailable githubConfigured onImported={oldCallback} />);

    fireEvent.click(await screen.findByTestId("gist-item"));
    oldView.unmount();
    render(<GitHubPicker mode="import" githubAvailable githubConfigured onImported={currentCallback} />);
    expect(await screen.findByTestId("gist-item")).toBeEnabled();

    await act(async () => {
      oldRequest.reject(new Error("closed picker failure"));
      await Promise.allSettled([oldRequest.promise]);
    });

    expect(oldCallback).not.toHaveBeenCalled();
    expect(currentCallback).not.toHaveBeenCalled();
    expect(screen.queryByTestId("github-action-error")).toBeNull();
    expect(screen.getByTestId("gist-item")).toBeEnabled();
  });

  it("does not let an old document failure unlock or add feedback to the current action", async () => {
    const oldRequest = deferred<{ document: DocumentDto }>();
    const currentRequest = deferred<{ document: DocumentDto }>();
    const firstDoc = documentDto("doc-first", "First");
    const currentDoc = documentDto("doc-second", "Second");
    const onLinked = vi.fn();
    linkDocument.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(currentRequest.promise);
    const view = render(<GitHubPicker mode="link" doc={firstDoc} githubAvailable githubConfigured onLinked={onLinked} />);

    fireEvent.click(screen.getByTestId("gist-create"));
    view.rerender(<GitHubPicker mode="link" doc={currentDoc} githubAvailable githubConfigured onLinked={onLinked} />);
    fireEvent.click(screen.getByTestId("gist-create"));
    expect(linkDocument).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("gist-create")).toBeDisabled();

    await act(async () => {
      oldRequest.reject(new Error("stale document failure"));
      await Promise.allSettled([oldRequest.promise]);
    });
    expect(screen.queryByTestId("github-action-error")).toBeNull();
    expect(screen.getByTestId("gist-create")).toBeDisabled();

    await act(async () => {
      currentRequest.reject(new Error("current document failure"));
      await Promise.allSettled([currentRequest.promise]);
    });
    expect(screen.getByTestId("github-action-error")).toHaveTextContent("current document failure");
    expect(screen.getByTestId("gist-create")).toBeEnabled();
    expect(onLinked).not.toHaveBeenCalled();
  });

  it("keeps current failure feedback through an old success, then retries with one current callback", async () => {
    const oldRequest = deferred<{ document: DocumentDto }>();
    const failedCurrent = deferred<{ document: DocumentDto }>();
    const retriedCurrent = deferred<{ document: DocumentDto }>();
    const firstDoc = documentDto("doc-first", "First");
    const currentDoc = documentDto("doc-second", "Second");
    const linkedCurrent = { ...currentDoc, storage: "gist" as const, gistId: "new-gist", gistFile: "second.md" };
    const onLinked = vi.fn();
    linkDocument.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(failedCurrent.promise).mockReturnValueOnce(retriedCurrent.promise);
    const view = render(<GitHubPicker mode="link" doc={firstDoc} githubAvailable githubConfigured onLinked={onLinked} />);

    fireEvent.click(screen.getByTestId("gist-create"));
    view.rerender(<GitHubPicker mode="link" doc={currentDoc} githubAvailable githubConfigured onLinked={onLinked} />);
    fireEvent.click(screen.getByTestId("gist-create"));

    await act(async () => {
      failedCurrent.reject(new Error("retry this action"));
      await Promise.allSettled([failedCurrent.promise]);
    });
    expect(screen.getByTestId("github-action-error")).toHaveTextContent("retry this action");

    await act(async () => {
      oldRequest.resolve({ document: { ...firstDoc, storage: "gist", gistId: "old-gist", gistFile: "first.md" } });
      await oldRequest.promise;
    });
    expect(onLinked).not.toHaveBeenCalled();
    expect(screen.getByTestId("github-action-error")).toHaveTextContent("retry this action");
    expect(screen.getByTestId("gist-create")).toBeEnabled();

    fireEvent.click(screen.getByTestId("gist-create"));
    expect(linkDocument).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("github-action-error")).toBeNull();
    await act(async () => {
      retriedCurrent.resolve({ document: linkedCurrent });
      await retriedCurrent.promise;
    });
    expect(onLinked).toHaveBeenCalledTimes(1);
    expect(onLinked).toHaveBeenCalledWith(linkedCurrent);
  });

  it("surfaces invalid link context without claiming a busy owner", async () => {
    const missingDocView = render(<GitHubPicker mode="link" githubAvailable githubConfigured />);
    fireEvent.click(screen.getByTestId("gist-create"));
    expect(linkDocument).not.toHaveBeenCalled();
    expect(screen.getByTestId("github-action-error")).toHaveTextContent("Something went wrong");
    expect(screen.getByTestId("gist-create")).toBeEnabled();
    missingDocView.unmount();

    const invalidRepo = repository("missing-branch", "");
    repos.mockResolvedValue({ repos: [invalidRepo] });
    render(<GitHubPicker mode="link" doc={documentDto()} githubAvailable githubConfigured />);
    await selectRepository(invalidRepo.fullName);
    const repoPath = await screen.findByTestId("repo-path");
    fireEvent.change(repoPath, { target: { value: "docs/new.md" } });
    fireEvent.click(screen.getByTestId("repo-link"));

    expect(linkDocument).not.toHaveBeenCalled();
    expect(screen.getByTestId("github-action-error")).toHaveTextContent("Something went wrong");
    expect(repoPath).toBeEnabled();
    expect(screen.getByTestId("repo-link")).toBeEnabled();
  });
});
