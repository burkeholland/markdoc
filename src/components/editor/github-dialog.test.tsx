// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import type { DocumentDto } from "@/server/dto";
import { ApiError } from "@/lib/api";

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

import { GitHubDialog, GitHubPicker, GitHubSignInPrompt } from "./github-dialog";
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
    linkPreview: false,
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
  vi.restoreAllMocks();
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

/** jsdom stores event trust in an internal slot that production browser events set for dispatch. */
function markPickerEventTrusted(event: Event) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find(
      (candidate): candidate is { isTrusted: boolean } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "isTrusted" in candidate &&
        candidate.isTrusted === false,
    );
  const descriptor = implementation
    ? Object.getOwnPropertyDescriptor(implementation, "isTrusted")
    : undefined;
  if (!implementation || !descriptor?.writable) {
    throw new Error("Unable to set jsdom's internal picker event trust slot");
  }
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  if (!event.isTrusted) throw new Error("The picker event trust slot did not update");
}

function setPickerEventView(event: KeyboardEvent, view: Window) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find(
      (candidate): candidate is { view: Window | null } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "view" in candidate,
    );
  if (!implementation) {
    throw new Error("Unable to set jsdom's internal picker event view slot");
  }
  implementation.view = view;
}

function pickerKeyboardEvent(
  element: HTMLElement,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
  trusted = true,
) {
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The picker source has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  setPickerEventView(event, ownerWindow);
  if (trusted) markPickerEventTrusted(event);
  return event;
}

function pickerKey(
  element: HTMLElement,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
) {
  const event = pickerKeyboardEvent(element, key, init);
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

async function renderStrictPicker(children: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<StrictMode>{children}</StrictMode>);
  });
  return {
    host,
    root,
    picker: within(host),
    rerender: async (children: ReactNode) => {
      await act(async () => {
        root.render(<StrictMode>{children}</StrictMode>);
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

async function selectStrictRepository(host: HTMLElement, name = currentRepo.fullName) {
  const picker = within(host);
  fireEvent.click(picker.getByTestId("picker-tab-repo"));
  const items = await picker.findAllByTestId("repo-item");
  const item = items.find((candidate) => candidate.textContent?.includes(name));
  expect(item).toBeDefined();
  await act(async () => {});
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

// The prompt is a plain button. The earlier click checks watched every element above it up to the
// document and went dead when any of them changed, which an opening dialog and a closing menu both
// do to <body> (#2222).
describe("GitHubSignInPrompt", () => {
  const button = () => screen.getByRole<HTMLButtonElement>("button", { name: /Sign in with GitHub/ });

  it("starts one sign-in for a double-click", () => {
    const pending = deferred<void>();
    signIn.mockReturnValue(pending.promise);
    render(<GitHubSignInPrompt githubConfigured redirectTo="/documents/current" />);

    act(() => {
      button().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith("github", { redirectTo: "/documents/current" });
    expect(button()).toBeDisabled();
  });

  it("still starts sign-in after the page above and beside it has changed", async () => {
    const pending = deferred<void>();
    signIn.mockReturnValue(pending.promise);
    render(
      <div data-testid="dialog">
        <GitHubSignInPrompt githubConfigured redirectTo="/documents/changed" />
      </div>,
    );
    const dialog = screen.getByTestId("dialog");
    const prompt = screen.getByTestId("github-signin-prompt");
    const bodyStyle = document.body.getAttribute("style");
    const guard = document.createElement("span");
    const portal = document.createElement("div");
    try {
      // What Radix does while a dialog opens over a closing menu: a scroll lock and pointer-events on
      // <body>, focus guards at both ends of it, ids on the dialog, the menu's portal removed.
      document.body.setAttribute("data-scroll-locked", "1");
      document.body.style.pointerEvents = "none";
      document.body.prepend(guard);
      document.body.append(portal);
      dialog.setAttribute("aria-describedby", "radix-description");
      dialog.style.pointerEvents = "auto";
      prompt.before(document.createElement("p"));
      prompt.after(document.createElement("p"));
      await act(async () => {});
      portal.remove();
      guard.remove();
      document.body.removeAttribute("data-scroll-locked");
      document.body.style.pointerEvents = "";
      await act(async () => {});

      fireEvent.click(button());
      expect(signIn).toHaveBeenCalledExactlyOnceWith("github", { redirectTo: "/documents/changed" });
      expect(button()).toBeDisabled();
    } finally {
      portal.remove();
      guard.remove();
      document.body.removeAttribute("data-scroll-locked");
      if (bodyStyle === null) document.body.removeAttribute("style");
      else document.body.setAttribute("style", bodyStyle);
    }
  });

  it("works under Strict Mode", async () => {
    const pending = deferred<void>();
    signIn.mockReturnValue(pending.promise);
    const view = await renderStrictPicker(<GitHubSignInPrompt githubConfigured redirectTo="/documents/strict" />);
    try {
      const strictButton = view.picker.getByRole<HTMLButtonElement>("button", { name: /Sign in with GitHub/ });
      expect(strictButton).toBeEnabled();
      fireEvent.click(strictButton);
      fireEvent.click(strictButton);
      expect(signIn).toHaveBeenCalledExactlyOnceWith("github", { redirectTo: "/documents/strict" });
      expect(strictButton).toBeDisabled();
    } finally {
      await view.unmount();
    }
  });

  it("keeps the redirect it had at the click", () => {
    const pending = deferred<void>();
    signIn.mockReturnValue(pending.promise);
    const view = render(<GitHubSignInPrompt githubConfigured redirectTo="/documents/claimed" />);

    fireEvent.click(button());
    view.rerender(<GitHubSignInPrompt githubConfigured redirectTo="/documents/replacement" />);

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith("github", { redirectTo: "/documents/claimed" });
    expect(button()).toBeDisabled();
  });

  it("uses a new redirect for a click after the prop changes", () => {
    const pending = deferred<void>();
    signIn.mockReturnValue(pending.promise);
    const view = render(<GitHubSignInPrompt githubConfigured redirectTo="/documents/a" />);
    view.rerender(<GitHubSignInPrompt githubConfigured redirectTo="/documents/b" />);

    fireEvent.click(button());
    expect(signIn).toHaveBeenCalledExactlyOnceWith("github", { redirectTo: "/documents/b" });
  });

  it.each(["rejects", "throws"] as const)("gives the button back for one retry when sign-in %s", async (failure) => {
    const failed = deferred<void>();
    const retry = deferred<void>();
    if (failure === "rejects") signIn.mockReturnValueOnce(failed.promise);
    else signIn.mockImplementationOnce(() => { throw new Error("GitHub sign-in failed"); });
    signIn.mockReturnValueOnce(retry.promise);
    render(<GitHubSignInPrompt githubConfigured redirectTo="/documents/retry" />);

    fireEvent.click(button());
    await act(async () => {
      failed.reject(new Error("GitHub sign-in failed"));
      await failed.promise.catch(() => undefined);
    });

    expect(button()).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(button());
    expect(signIn).toHaveBeenCalledTimes(2);
    expect(signIn).toHaveBeenNthCalledWith(1, "github", { redirectTo: "/documents/retry" });
    expect(signIn).toHaveBeenNthCalledWith(2, "github", { redirectTo: "/documents/retry" });
    expect(button()).toBeDisabled();
    expect(unhandledRejections).toEqual([]);
  });

  it("is not released by the outcome of prompts it replaced", async () => {
    const staleSuccess = deferred<void>();
    const staleFailure = deferred<void>();
    const current = deferred<void>();
    signIn
      .mockReturnValueOnce(staleSuccess.promise)
      .mockReturnValueOnce(staleFailure.promise)
      .mockReturnValueOnce(current.promise);
    const view = render(<GitHubSignInPrompt key="success" githubConfigured redirectTo="/documents/success" />);
    fireEvent.click(button());
    view.rerender(<GitHubSignInPrompt key="failure" githubConfigured redirectTo="/documents/failure" />);
    fireEvent.click(button());
    view.rerender(<GitHubSignInPrompt key="current" githubConfigured redirectTo="/documents/current" />);
    fireEvent.click(button());
    expect(signIn).toHaveBeenNthCalledWith(3, "github", { redirectTo: "/documents/current" });

    await act(async () => {
      staleSuccess.resolve();
      staleFailure.reject(new Error("Stale GitHub failure"));
      await Promise.all([staleSuccess.promise, staleFailure.promise.catch(() => undefined)]);
    });

    expect(signIn).toHaveBeenCalledTimes(3);
    expect(button()).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(unhandledRejections).toEqual([]);
  });

  it("keeps two prompts independent", () => {
    const pending = deferred<void>();
    signIn.mockReturnValue(pending.promise);
    render(
      <>
        <GitHubSignInPrompt githubConfigured redirectTo="/documents/first" />
        <GitHubSignInPrompt githubConfigured redirectTo="/documents/second" />
      </>,
    );
    const [first, second] = screen.getAllByRole<HTMLButtonElement>("button", { name: /Sign in with GitHub/ });
    if (!first || !second) throw new Error("Expected two sign-in prompts");

    fireEvent.click(second);
    expect(signIn).toHaveBeenCalledExactlyOnceWith("github", { redirectTo: "/documents/second" });
    expect(first).toBeEnabled();
    expect(second).toBeDisabled();
  });

  it("ignores a failure that arrives after it is removed", async () => {
    const pending = deferred<void>();
    signIn.mockReturnValue(pending.promise);
    const view = render(<GitHubSignInPrompt githubConfigured redirectTo="/documents/unmounted" />);
    fireEvent.click(button());
    view.unmount();

    await act(async () => {
      pending.reject(new Error("Unmounted GitHub failure"));
      await pending.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(screen.queryByTestId("github-signin-prompt")).toBeNull();
    expect(unhandledRejections).toEqual([]);
  });
});

describe("GitHubDialog connection presentation", () => {
  const unbroken = "destination-detail-".repeat(16);
  const filename = ` \t${unbroken}<b title="literal">file</b>.md\n `;
  const branch = ` \trelease-${unbroken}<i>branch</i>\n `;
  const path = `docs/${unbroken}<a href="literal">path</a>.md\n `;
  const effects = [gists, repos, branches, files, importDocument, linkDocument, signIn];
  const callCounts = () => effects.map((effect) => effect.mock.calls.length);

  function linkedDocument(storage: "gist" | "repo"): DocumentDto {
    const doc = documentDto();
    return storage === "gist"
      ? { ...doc, storage, gistId: "linked-gist", gistFile: filename, githubUrl: "https://gist.github.com/linked-gist" }
      : {
          ...doc, storage, repoOwner: "octo", repoName: "notes", repoBranch: branch, repoPath: path,
          githubUrl: "https://github.com/octo/notes",
        };
  }

  function connection(doc: DocumentDto, onDocChange = vi.fn(), onOpenChange = vi.fn()) {
    return <GitHubDialog open doc={doc} onDocChange={onDocChange} onOpenChange={onOpenChange} githubAvailable githubConfigured isOwner />;
  }

  function expectDestination(text: string) {
    const destination = screen.getByTitle(text, { normalizer: (value) => value });
    expect(destination.tagName).toBe("DIV");
    expect(destination.textContent).toBe(text);
    expect(destination.title).toBe(text);
    expect(Object.fromEntries([...destination.attributes].map(({ name, value }) => [name, value]))).toEqual({
      class: "truncate font-medium text-ink",
      title: text,
    });
    expect(destination.children).toHaveLength(0);
    expect(destination.childNodes).toHaveLength(1);
    expect(destination.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(destination.tabIndex).toBe(-1);
    const metadata = destination.parentElement!;
    const card = metadata.parentElement!;
    expect(metadata.className).toBe("min-w-0 flex-1 text-sm");
    expect([...metadata.children]).toEqual([destination, destination.nextElementSibling]);
    expect(destination.nextElementSibling?.className).toBe("text-xs text-ink-3");
    expect([...card.children].map((child) => child.tagName.toLowerCase())).toEqual(["svg", "div", "a", "button"]);
    expect(card.querySelectorAll("svg")).toHaveLength(3);
    expect(card.querySelector("svg")).toHaveAttribute("width", "18");
    expect(card.querySelectorAll("input, select, textarea, [tabindex]")).toHaveLength(0);
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("rel", "noopener noreferrer");
    return destination;
  }

  function expectPassive(element: HTMLElement, onDocChange: ReturnType<typeof vi.fn>, onOpenChange: ReturnType<typeof vi.fn>) {
    const dialog = screen.getByRole("dialog");
    const controls = [...dialog.querySelectorAll<HTMLElement>("*")].filter((node) => node.tabIndex >= 0);
    const focus = document.activeElement;
    const before = callCounts();
    const observer = new MutationObserver(() => {});
    observer.observe(dialog, { subtree: true, childList: true, attributes: true, characterData: true });
    const spies = [
      vi.spyOn(HTMLElement.prototype, "focus"),
      vi.spyOn(globalThis, "setTimeout"),
      vi.spyOn(globalThis, "setInterval"),
      vi.spyOn(window, "requestAnimationFrame"),
      vi.spyOn(globalThis, "queueMicrotask"),
      vi.spyOn(globalThis, "fetch"),
    ];
    try {
      fireEvent.mouseOver(element);
      fireEvent.mouseMove(element);
      fireEvent.mouseOut(element);
      expect(observer.takeRecords()).toHaveLength(0);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(callCounts()).toEqual(before);
      expect(onDocChange).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(focus);
      expect([...dialog.querySelectorAll<HTMLElement>("*")].filter((node) => node.tabIndex >= 0)).toEqual(controls);
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      observer.disconnect();
      vi.restoreAllMocks();
    }
  }

  it.each(["gist", "repo"] as const)("exposes exact long %s destination text and replaces metadata without adding controls", async (storage) => {
    expect(unbroken.length).toBeGreaterThanOrEqual(240);
    expect(unbroken).not.toMatch(/\s/);
    const doc = { ...linkedDocument(storage), hasUnpublishedChanges: true };
    const onDocChange = vi.fn();
    const onOpenChange = vi.fn();
    const view = render(connection(doc, onDocChange, onOpenChange));
    await screen.findByTestId("gist-filename");
    await act(async () => {});
    const text = storage === "gist" ? `Gist · ${filename}` : `octo/notes · ${branch} · ${path}`;
    const destination = expectDestination(text);
    expect(destination.nextElementSibling?.textContent).toBe("Not published yet · unpublished changes");
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", doc.githubUrl);
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
    const input = screen.getByTestId("gist-filename");
    fireEvent.change(input, { target: { value: "keep-draft.md" } });
    await act(async () => {});
    expectPassive(destination, onDocChange, onOpenChange);
    expect(input).toHaveValue("keep-draft.md");

    const updated = {
      ...doc, gistFile: " \tUpdated <img src='literal'>.md\n ",
      repoOwner: "new-owner", repoName: "new-repo", repoBranch: "next-branch", repoPath: " \tnew/<b>path</b>.md\n ",
      hasUnpublishedChanges: false,
    };
    view.rerender(connection(updated, onDocChange, onOpenChange));
    const nextText = storage === "gist" ? `Gist · ${updated.gistFile}` : `new-owner/new-repo · next-branch · ${updated.repoPath}`;
    expect(expectDestination(nextText)).toBe(destination);
    expect(screen.queryByTitle(text, { normalizer: (value) => value })).toBeNull();
    expect(destination.nextElementSibling?.textContent).toBe("Not published yet");
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", doc.githubUrl);
    expect(linkDocument).not.toHaveBeenCalled();
    expect(onDocChange).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();

    view.rerender(connection(documentDto(doc.id), onDocChange, onOpenChange));
    expect(screen.getByRole("dialog", { name: "Connect to GitHub" })).toBeInTheDocument();
    expect(screen.queryByTitle(nextText, { normalizer: (value) => value })).toBeNull();
    expect(destination).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(screen.getByTestId("github-picker")).toBeInTheDocument();
  });

  it.each([null, "", " \t \n "])("preserves destination interpolation without a fallback for %j", async (value) => {
    const doc = { ...linkedDocument("gist"), gistFile: value };
    const view = render(connection(doc));
    await screen.findByTestId("gist-filename");
    expectDestination(`Gist · ${value}`);
    view.rerender(connection({
      ...linkedDocument("repo"), repoOwner: value, repoName: value, repoBranch: value, repoPath: value,
    }));
    expectDestination(`${value}/${value} · ${value} · ${value}`);
  });

  const failures = [
    { kind: "unbroken", error: new Error(unbroken), text: unbroken },
    { kind: "ordinary", error: new Error("GitHub could not disconnect this document."), text: "GitHub could not disconnect this document." },
    { kind: "literal markup", error: new Error(`<a href="literal">Reason</a>${unbroken}`), text: `<a href="literal">Reason</a>${unbroken}` },
    { kind: "whitespace", error: new Error(` \tFirst reason\n\n${unbroken}\t last reason \n `), text: ` \tFirst reason\n\n${unbroken}\t last reason \n ` },
    { kind: "whitespace only", error: new Error(" \t \n "), text: " \t \n " },
    { kind: "validation issue", error: new ApiError(400, "Invalid request", [{ message: unbroken }]), text: unbroken },
    { kind: "fallback", error: undefined, text: "Could not disconnect the gist." },
  ];

  function expectUnlinkError(text: string) {
    const error = screen.getByRole("alert");
    expect(error.tagName).toBe("P");
    expect(error.textContent).toBe(text);
    expect(Object.fromEntries([...error.attributes].map(({ name, value }) => [name, value]))).toEqual({
      role: "alert",
      class: "mb-3 text-sm text-danger wrap-anywhere",
    });
    expect(error.childNodes).toHaveLength(1);
    expect(error.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(error.children).toHaveLength(0);
    expect(error.tabIndex).toBe(-1);
    expect(error).toBeVisible();
    expect(error.parentElement).toBe(screen.getByRole("dialog"));
    expect(error.previousElementSibling).toBe(screen.getByRole("button", { name: "Disconnect" }).parentElement);
    expect(error.nextElementSibling).toBe(screen.getByTestId("github-picker"));
    expect(screen.getAllByRole("alert")).toEqual([error]);
    return error;
  }

  it.each(failures)("wraps $kind unlink failures with normal disabled recovery and unchanged fields", async ({ error: reason, text }) => {
    expect(unbroken.length).toBeGreaterThanOrEqual(240);
    expect(unbroken).not.toMatch(/\s/);
    const first = deferred<{ document: DocumentDto }>();
    const second = deferred<{ document: DocumentDto }>();
    const recovered = deferred<{ document: DocumentDto }>();
    linkDocument.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(recovered.promise);
    const doc = linkedDocument("repo");
    const onDocChange = vi.fn();
    const onOpenChange = vi.fn();
    const view = render(connection(doc, onDocChange, onOpenChange));
    await screen.findByTestId("gist-filename");
    const destinationText = `octo/notes · ${branch} · ${path}`;
    const destination = expectDestination(destinationText);
    const input = screen.getByTestId("gist-filename");
    const visibility = screen.getByRole("checkbox", { name: "Public" });
    fireEvent.change(input, { target: { value: "keep-draft.md" } });
    const disconnect = screen.getByRole("button", { name: "Disconnect" });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(disconnect);
    expect(disconnect).toBeDisabled();
    expect(linkDocument).toHaveBeenCalledExactlyOnceWith(doc.id, { storage: "local" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input).toBeEnabled();
    expect(visibility).toBeEnabled();
    await act(async () => {
      first.reject(reason);
      await Promise.allSettled([first.promise]);
    });
    const error = expectUnlinkError(text);
    expect(disconnect).toBeEnabled();
    expect(input).toHaveValue("keep-draft.md");
    expect(visibility).not.toBeChecked();
    expect(expectDestination(destinationText)).toBe(destination);
    await act(async () => {});
    expectPassive(error, onDocChange, onOpenChange);

    fireEvent.click(disconnect);
    expect(disconnect).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(error).not.toBeInTheDocument();
    expect(linkDocument.mock.calls).toEqual(Array.from({ length: 2 }, () => [doc.id, { storage: "local" }]));
    const replacement = ` \tReplacement <b>reason</b>\n${unbroken} `;
    await act(async () => {
      second.reject(new ApiError(400, "Invalid request", [{ message: replacement }]));
      await Promise.allSettled([second.promise]);
    });
    expectUnlinkError(replacement);
    expect(disconnect).toBeEnabled();
    expect(input).toHaveValue("keep-draft.md");
    expect(onDocChange).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(disconnect);
    expect(disconnect).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(linkDocument.mock.calls).toEqual(Array.from({ length: 3 }, () => [doc.id, { storage: "local" }]));
    const local = documentDto(doc.id);
    await act(async () => {
      recovered.resolve({ document: local });
      await recovered.promise;
    });
    expect(disconnect).toBeEnabled();
    expect(onDocChange).toHaveBeenCalledExactlyOnceWith(local);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("keep-draft.md");
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(connection(local, onDocChange, onOpenChange));
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(destination).not.toBeInTheDocument();
    expect(importDocument).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    expect(unhandledRejections).toEqual([]);
  });

  it("keeps an empty normalized unlink error absent and releases the Disconnect button", async () => {
    linkDocument.mockRejectedValueOnce(new Error(""));
    render(connection(linkedDocument("repo")));
    await screen.findByTestId("gist-filename");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
    expect(linkDocument).toHaveBeenCalledExactlyOnceWith("doc-current", { storage: "local" });
  });
});

// A managed account (Enterprise Managed Users, `handle_shortcode`) has no gists and GitHub lets it create none.
describe("GitHubPicker for a managed account", () => {
  const NOTE = "GitHub does not let company-managed accounts create gists. Use a repository instead.";

  it("opens on Repository, says why, and never asks GitHub for gists", async () => {
    render(<GitHubPicker mode="link" doc={documentDto()} githubAvailable githubConfigured managedAccount />);
    expect(screen.getByTestId("managed-account-gists-note")).toHaveTextContent(NOTE);
    expect(screen.getByTestId("picker-tab-repo")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("picker-tab-gist")).toHaveAttribute("aria-pressed", "false");
    await screen.findByTestId("repo-item");
    expect(repos).toHaveBeenCalledTimes(1);
    expect(gists).not.toHaveBeenCalled();
    expect(screen.queryByTestId("gist-create")).toBeNull();
  });

  it("imports a repository file with the note in place", async () => {
    const onImported = vi.fn();
    render(<GitHubPicker mode="import" githubAvailable githubConfigured managedAccount onImported={onImported} />);
    fireEvent.click(await screen.findByTestId("repo-item"));
    fireEvent.click(await screen.findByTestId("repo-file"));
    expect(importDocument).toHaveBeenCalledExactlyOnceWith({ source: "repo", owner: currentRepo.owner, repo: currentRepo.name, branch: "main", path: "README.md" });
    await waitFor(() => expect(onImported).toHaveBeenCalledExactlyOnceWith("imported"));
    expect(screen.getByTestId("managed-account-gists-note")).toHaveTextContent(NOTE);
  });

  it("can still look at the Gist tab, where the note stays", async () => {
    gists.mockResolvedValue({ gists: [] });
    render(<GitHubPicker mode="import" githubAvailable githubConfigured managedAccount />);
    await screen.findByTestId("repo-item");
    fireEvent.click(screen.getByTestId("picker-tab-gist"));
    await screen.findByTestId("gist-list");
    expect(screen.getByTestId("picker-tab-gist")).toHaveAttribute("aria-pressed", "true");
    expect(gists).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("managed-account-gists-note")).toHaveTextContent(NOTE);
  });

  it("says nothing to an ordinary account, which opens on Gist as before", async () => {
    renderPicker();
    await screen.findByTestId("gist-item");
    expect(screen.queryByTestId("managed-account-gists-note")).toBeNull();
    expect(screen.getByTestId("picker-tab-gist")).toHaveAttribute("aria-pressed", "true");
    expect(repos).not.toHaveBeenCalled();
  });

  it("says nothing next to the sign-in prompt", () => {
    render(<GitHubPicker mode="import" githubAvailable={false} githubConfigured managedAccount />);
    expect(screen.queryByTestId("managed-account-gists-note")).toBeNull();
    expect(screen.getByRole("button", { name: /Sign in with GitHub/ })).toBeInTheDocument();
  });
});

describe("GitHubPicker metadata titles", () => {
  const primaryClass = "truncate text-sm font-medium text-ink";
  const secondaryClass = "truncate text-xs text-ink-3";
  const pathClass = "truncate font-mono text-[13px] text-ink-2";
  const filename = `${"long-filename-".repeat(18)}<b title="quoted">literal</b>.md`;
  const description = `${"Long description ".repeat(15)}<img src="literal" alt='quoted'>`;
  const fullName = `octo/${"long-repository-".repeat(16)}<i title="quoted">literal</i>`;
  const path = `docs/${"long-path-".repeat(23)}<a href="literal">quoted</a>.md`;

  function expectMetadata(element: HTMLElement, value: string, tag: string, className: string) {
    expect(element.tagName).toBe(tag);
    expect(element.className).toBe(className);
    expect(element.textContent).toBe(value);
    expect(element.title).toBe(value);
    expect(element.getAttributeNames().sort()).toEqual(["class", "title"]);
    expect(element.children).toHaveLength(0);
    expect(element.childNodes).toHaveLength(1);
    expect(element.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(element.tabIndex).toBe(-1);
  }

  async function hoverMetadata(elements: HTMLElement[], onImported: ReturnType<typeof vi.fn>) {
    const sources = [gists, repos, branches, files];
    const calls = sources.map((source) => source.mock.calls.length);
    const picker = screen.getByTestId("github-picker");
    const focus = document.activeElement;
    for (const element of elements) {
      fireEvent.mouseOver(element);
      fireEvent.mouseMove(element);
      fireEvent.mouseOut(element);
    }
    await act(async () => {});
    expect(sources.map((source) => source.mock.calls.length)).toEqual(calls);
    expect(importDocument).not.toHaveBeenCalled();
    expect(linkDocument).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    expect(picker).toBeInTheDocument();
    expect(document.activeElement).toBe(focus);
    expect(screen.queryByRole("tooltip")).toBeNull();
  }

  it("keeps long literal gist metadata, names and icons intact through hover and one explicit import", async () => {
    expect(filename.length).toBeGreaterThanOrEqual(200);
    expect(description.length).toBeGreaterThanOrEqual(200);
    const item = { ...gist("literal-gist", filename), description };
    gists.mockResolvedValue({ gists: [item] });
    const request = deferred<{ document: { id: string; title: string } }>();
    importDocument.mockReturnValue(request.promise);
    const onImported = vi.fn();
    render(<GitHubPicker mode="import" githubAvailable githubConfigured onImported={onImported} />);
    const row = await screen.findByTestId("gist-item");
    const name = within(row).getByTitle(filename);
    const detail = within(row).getByTitle(description);
    expectMetadata(name, filename, "DIV", primaryClass);
    expectMetadata(detail, description, "DIV", secondaryClass);
    expect(Array.from(row.children, (child) => child.tagName.toLowerCase())).toEqual(["svg", "div", "span"]);
    expect(name.parentElement?.children).toHaveLength(2);
    expect(name.nextElementSibling).toBe(detail);
    expect(row.querySelectorAll("svg")).toHaveLength(2);
    expect(row.querySelector("svg")).toHaveAttribute("width", "16");
    expect(row.querySelector(".lucide-lock")).toHaveAttribute("width", "12");
    expect(row.querySelectorAll("button, a, input, select, textarea, [tabindex]")).toHaveLength(0);
    expect(row).toHaveClass("hover:bg-surface-2", "disabled:opacity-50");
    expect(row).toHaveAccessibleName(`${filename} ${description} ${row.lastElementChild?.textContent}`);
    expect(row).toBeEnabled();

    await hoverMetadata([name, detail], onImported);
    expect(screen.getByTestId("gist-item")).toBe(row);
    expect(screen.getByTestId("picker-tab-gist")).toHaveAttribute("aria-pressed", "true");
    expect(row).toBeEnabled();
    fireEvent.click(name);
    expect(importDocument).toHaveBeenCalledExactlyOnceWith({
      source: "gist", gistId: item.id, filename,
    });
    expect(row).toBeDisabled();
    expectMetadata(name, filename, "DIV", primaryClass);
    expectMetadata(detail, description, "DIV", secondaryClass);
    await act(async () => {
      request.resolve({ document: { id: "literal-import", title: "Imported" } });
      await request.promise;
    });
    expect(onImported).toHaveBeenCalledExactlyOnceWith("literal-import");
    expect(row).toBeEnabled();
  });

  it("keeps long repository and file metadata passive until their existing selections", async () => {
    expect(fullName.length).toBeGreaterThanOrEqual(200);
    expect(path.length).toBeGreaterThanOrEqual(200);
    const repo = { ...repository(), fullName, description, private: true };
    repos.mockResolvedValue({ repos: [repo] });
    files.mockResolvedValue({ files: [repoFile(path)] });
    const request = deferred<{ document: { id: string; title: string } }>();
    importDocument.mockReturnValue(request.promise);
    const onImported = vi.fn();
    render(<GitHubPicker mode="import" githubAvailable githubConfigured onImported={onImported} />);
    await screen.findByTestId("gist-item");
    fireEvent.click(screen.getByTestId("picker-tab-repo"));
    const row = await screen.findByTestId("repo-item");
    const name = within(row).getByTitle(fullName);
    const detail = within(row).getByTitle(description);
    expectMetadata(name, fullName, "DIV", primaryClass);
    expectMetadata(detail, description, "DIV", secondaryClass);
    expect(Array.from(row.children, (child) => child.tagName.toLowerCase())).toEqual(["svg", "div", "span"]);
    expect(name.parentElement?.children).toHaveLength(2);
    expect(name.nextElementSibling).toBe(detail);
    expect(row.querySelectorAll("svg")).toHaveLength(2);
    expect(row.querySelector("svg")).toHaveAttribute("width", "16");
    expect(row.querySelector(".lucide-lock")).toHaveAttribute("width", "12");
    expect(row.querySelectorAll("button, a, input, select, textarea, [tabindex]")).toHaveLength(0);
    expect(row).toHaveAccessibleName(`${fullName} ${description} ${row.lastElementChild?.textContent}`);
    expect(row).toBeEnabled();
    await hoverMetadata([name, detail], onImported);
    expect(screen.getByTestId("repo-item")).toBe(row);
    expect(screen.queryByTestId("branch-list")).toBeNull();
    fireEvent.click(name);
    const file = await screen.findByTestId("repo-file");
    await screen.findByTestId("branch-select");
    expect(branches).toHaveBeenCalledExactlyOnceWith(repo.owner, repo.name);
    expect(files).toHaveBeenCalledExactlyOnceWith(repo.owner, repo.name, repo.defaultBranch);
    const filePath = within(file).getByTitle(path);
    expectMetadata(filePath, path, "SPAN", pathClass);
    expect(Array.from(file.children, (child) => child.tagName.toLowerCase())).toEqual(["svg", "span", "span"]);
    expect(file.querySelectorAll("svg")).toHaveLength(1);
    expect(file.querySelector("svg")).toHaveAttribute("width", "15");
    expect(file.querySelectorAll("button, a, input, select, textarea, [tabindex]")).toHaveLength(0);
    expect(file.lastElementChild?.textContent).toBe("Open");
    expect(file).toHaveAccessibleName(`${path}Open`);
    expect(file).toBeEnabled();
    await hoverMetadata([filePath], onImported);
    expect(screen.getByTestId("branch-select")).toHaveValue("main");
    expect(screen.getByTestId("repo-file")).toBe(file);
    fireEvent.click(filePath);
    expect(importDocument).toHaveBeenCalledExactlyOnceWith({
      source: "repo", owner: repo.owner, repo: repo.name, branch: "main", path,
    });
    expect(file).toBeDisabled();
    expectMetadata(filePath, path, "SPAN", pathClass);
    await act(async () => {
      request.resolve({ document: { id: "file-import", title: "Imported" } });
      await request.promise;
    });
    expect(onImported).toHaveBeenCalledExactlyOnceWith("file-import");
    expect(file).toBeEnabled();
  });

  it.each([null, "", "   "])("preserves fallback and optional-description truthiness for %j", async (value) => {
    const item = { ...gist(), description: value };
    const repo = { ...repository(), description: value };
    gists.mockResolvedValue({ gists: [item] });
    repos.mockResolvedValue({ repos: [repo] });
    renderPicker();
    const gistRow = await screen.findByTestId("gist-item");
    expectMetadata(
      within(gistRow).getByTitle(value || item.id, { normalizer: (text) => text }),
      value || item.id, "DIV", secondaryClass,
    );
    fireEvent.click(screen.getByTestId("picker-tab-repo"));
    const repoRow = await screen.findByTestId("repo-item");
    const name = within(repoRow).getByTitle(repo.fullName);
    expect(name.parentElement?.children).toHaveLength(value ? 2 : 1);
    if (value) {
      expectMetadata(within(repoRow).getByTitle(value, { normalizer: (text) => text }), value, "DIV", secondaryClass);
    } else {
      expect(name.nextElementSibling).toBeNull();
      expect(repoRow.querySelectorAll("[title]")).toHaveLength(1);
    }
  });

  it("retains same-row titles during search and tabs, then updates the same gist key on picker replacement", async () => {
    const item = gist("same-gist", filename);
    const updated = { ...item, description };
    gists.mockResolvedValueOnce({ gists: [item] }).mockResolvedValueOnce({ gists: [updated] });
    const view = renderPicker();
    const row = await screen.findByTestId("gist-item");
    const name = within(row).getByTitle(filename);
    fireEvent.change(screen.getByPlaceholderText("Filter gists"), { target: { value: "long-filename" } });
    expect(screen.getByTestId("gist-item")).toBe(row);
    expectMetadata(name, filename, "DIV", primaryClass);
    fireEvent.change(screen.getByPlaceholderText("Filter gists"), { target: { value: "no-match" } });
    expect(screen.queryByTitle(filename)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Filter gists"), { target: { value: "" } });
    expectMetadata(screen.getByTitle(filename), filename, "DIV", primaryClass);
    fireEvent.click(screen.getByTestId("picker-tab-repo"));
    await screen.findByTestId("repo-item");
    expect(screen.queryByTitle(filename)).toBeNull();
    expect(screen.queryByTitle(item.description!)).toBeNull();
    fireEvent.click(screen.getByTestId("picker-tab-gist"));
    expectMetadata(screen.getByTitle(item.description!), item.description!, "DIV", secondaryClass);
    expect(gists).toHaveBeenCalledOnce();
    view.rerender(<GitHubPicker key="refreshed" mode="import" githubAvailable githubConfigured />);
    const replacement = await screen.findByTitle(description);
    expectMetadata(replacement, description, "DIV", secondaryClass);
    expectMetadata(screen.getByTitle(filename), filename, "DIV", primaryClass);
    expect(screen.queryByTitle(item.description!)).toBeNull();
    expect(gists).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(screen.queryByTitle(filename)).toBeNull();
    expect(screen.queryByTitle(description)).toBeNull();
  });

  it("replaces titles across branches, file search, repository selection and picker removal", async () => {
    const nextPath = "release/current.md";
    const nextRepo = repository("replacement", "trunk");
    repos.mockResolvedValue({ repos: [currentRepo, nextRepo] });
    branches.mockResolvedValue({ branches: ["main", "release", "trunk"] });
    files.mockResolvedValueOnce({ files: [repoFile(path)] })
      .mockResolvedValueOnce({ files: [repoFile(nextPath)] })
      .mockResolvedValueOnce({ files: [repoFile("replacement.md")] });
    const view = renderPicker();
    await selectRepository();
    await screen.findByTitle(path);
    const branch = await screen.findByTestId("branch-select");
    fireEvent.change(branch, { target: { value: "release" } });
    expect(screen.queryByTitle(path)).toBeNull();
    expectMetadata(await screen.findByTitle(nextPath), nextPath, "SPAN", pathClass);
    fireEvent.change(screen.getByPlaceholderText("Filter files"), { target: { value: "no-match" } });
    expect(screen.queryByTitle(nextPath)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Filter files"), { target: { value: "" } });
    expectMetadata(screen.getByTitle(nextPath), nextPath, "SPAN", pathClass);
    expect(files.mock.calls).toEqual([
      [currentRepo.owner, currentRepo.name, "main"],
      [currentRepo.owner, currentRepo.name, "release"],
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Repositories/ }));
    expect(screen.queryByTitle(nextPath)).toBeNull();
    expectMetadata(await screen.findByTitle(nextRepo.fullName), nextRepo.fullName, "DIV", primaryClass);
    expectMetadata(screen.getByTitle(nextRepo.description!), nextRepo.description!, "DIV", secondaryClass);
    expect(screen.getByTitle(currentRepo.fullName)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Filter repositories"), { target: { value: "no-match" } });
    expect(screen.queryByTitle(nextRepo.fullName)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Filter repositories"), { target: { value: "replacement" } });
    expect(screen.queryByTitle(currentRepo.fullName)).toBeNull();
    fireEvent.click(screen.getByTitle(nextRepo.fullName));
    expectMetadata(await screen.findByTitle("replacement.md"), "replacement.md", "SPAN", pathClass);
    expect(files).toHaveBeenLastCalledWith(nextRepo.owner, nextRepo.name, "trunk");
    expect(importDocument).not.toHaveBeenCalled();
    expect(linkDocument).not.toHaveBeenCalled();
    view.unmount();
    expect(screen.queryByTitle("replacement.md")).toBeNull();
  });
});

describe("GitHubPicker wrapped failures", () => {
  const listSurfaces = ["gist", "repo", "branch", "file"] as const;
  type ListSurface = (typeof listSurfaces)[number];
  type Surface = ListSurface | "action";
  const surfaces: Surface[] = [...listSurfaces, "action"];
  const unbroken = "provider-reason-".repeat(20);
  const messages = [
    { kind: "unbroken", message: unbroken },
    { kind: "ordinary", message: "GitHub could not complete this request. Please try again." },
    { kind: "literal markup", message: `<a href="literal">Not a link</a><img src="literal">${unbroken}` },
    { kind: "whitespace", message: ` \t First reason\n\n${unbroken}\t last reason \n ` },
    { kind: "whitespace only", message: " \t \n  " },
  ];
  const alertClass = "rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40";
  const effects = [gists, repos, branches, files, importDocument, linkDocument, signIn];
  const callCounts = () => effects.map((effect) => effect.mock.calls.length);
  const errorId = (surface: Surface) => surface === "action" ? "github-action-error" : `${surface}-load-error`;

  function source(surface: Surface) {
    switch (surface) {
      case "gist": return gists;
      case "repo": return repos;
      case "branch": return branches;
      case "file": return files;
      case "action": return importDocument;
    }
  }

  function prefix(surface: Surface, repo = currentRepo, branch = "main") {
    switch (surface) {
      case "gist": return "Could not load gists. ";
      case "repo": return "Could not load repositories. ";
      case "branch": return `Could not load branches for ${repo.fullName}. `;
      case "file": return `Could not load files from ${repo.fullName} on ${branch}. `;
      case "action": return "";
    }
  }

  async function openSurface(surface: Surface) {
    const view = renderPicker();
    if (surface !== "gist") await screen.findByTestId("gist-item");
    if (surface === "repo") fireEvent.click(screen.getByTestId("picker-tab-repo"));
    if (surface === "branch" || surface === "file") {
      await selectRepository();
      await screen.findByTestId(surface === "branch" ? "repo-file" : "branch-select");
    }
    if (surface === "action") fireEvent.click(screen.getByTestId("gist-item"));
    await screen.findByTestId(errorId(surface));
    await act(async () => {});
    return view;
  }

  function expectFailure(surface: Surface, message: string, repo = currentRepo, branch = "main") {
    const alert = screen.getByTestId(errorId(surface));
    expect(alert.tagName).toBe("DIV");
    expect(Object.fromEntries([...alert.attributes].map(({ name, value }) => [name, value]))).toEqual({
      class: `${alertClass}${surface === "action" ? " wrap-anywhere" : ""}`,
      role: "alert",
      "aria-atomic": "true",
      "data-testid": errorId(surface),
    });
    const text = surface === "action" ? alert : alert.firstElementChild;
    if (!(text instanceof HTMLDivElement)) throw new Error("Picker failure text must remain in its existing div");
    expect(text.textContent).toBe(prefix(surface, repo, branch) + message);
    expect(text.childNodes).toHaveLength(1);
    expect(text.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(text.children).toHaveLength(0);
    expect(text.tabIndex).toBe(-1);
    expect(alert.tabIndex).toBe(-1);
    expect(alert).toBeVisible();
    if (surface === "action") {
      const picker = screen.getByTestId("github-picker");
      expect(alert.parentElement).toBe(picker);
      expect(picker.children.item(1)).toBe(alert);
      expect(picker.children).toHaveLength(3);
      expect(alert.querySelectorAll("button")).toHaveLength(0);
    } else {
      expect(text.getAttributeNames()).toEqual(["class"]);
      expect(text.className).toBe("wrap-anywhere");
      const retry = within(alert).getByRole("button", { name: "Retry" });
      expect([...alert.children].map((element) => element.tagName)).toEqual(["DIV", "BUTTON"]);
      expect(alert.childNodes).toHaveLength(2);
      expect(text.nextElementSibling).toBe(retry);
      expect(retry.parentElement).toBe(alert);
      expect(Object.fromEntries([...retry.attributes].map(({ name, value }) => [name, value]))).toEqual({
        type: "button",
        class: "btn btn-outline btn-sm mt-2 gap-1.5",
      });
      expect(retry.textContent).toBe("Retry");
      expect(retry.childNodes).toHaveLength(1);
      expect(retry.children).toHaveLength(0);
      expect(retry).toBeEnabled();
      expect(screen.getAllByRole("button", { name: "Retry" })).toEqual([retry]);
      expect(alert.parentElement).toBe(screen.getByTestId(`${surface}-list`));
      expect(alert.parentElement?.querySelector(".animate-spin")).toBeNull();
    }
    expect(alert.querySelectorAll("a, input, select, textarea, [tabindex], [contenteditable], [title]")).toHaveLength(0);
    return { alert, text };
  }

  function holdListAttempt(surface: ListSurface) {
    const pending = deferred<void>();
    switch (surface) {
      case "gist":
        gists.mockImplementationOnce(async () => { await pending.promise; return { gists: [] }; });
        break;
      case "repo":
        repos.mockImplementationOnce(async () => { await pending.promise; return { repos: [currentRepo] }; });
        break;
      case "branch":
        branches.mockImplementationOnce(async () => { await pending.promise; return { branches: [] }; });
        break;
      case "file":
        files.mockImplementationOnce(async () => { await pending.promise; return { files: [repoFile("recovered.md")] }; });
        break;
    }
    return pending;
  }



  it.each(surfaces.flatMap((surface) => messages.map((message) => ({ surface, ...message }))))(
    "keeps $kind $surface failures complete and passive in the existing message div",
    async ({ surface, message }) => {
      expect(unbroken.length).toBeGreaterThanOrEqual(240);
      expect(unbroken).not.toMatch(/\s/);
      source(surface).mockRejectedValueOnce(new Error(message));
      await openSurface(surface);
      const { alert, text } = expectFailure(surface, message);
      expect(screen.getAllByRole("alert")).toEqual([alert]);
      expect(source(surface)).toHaveBeenCalledOnce();
      expect(linkDocument).not.toHaveBeenCalled();
      expect(signIn).not.toHaveBeenCalled();
      if (surface === "action") {
        expect(importDocument).toHaveBeenCalledExactlyOnceWith({
          source: "gist", gistId: "gist-current", filename: "current.md",
        });
        expect(screen.getByTestId("gist-item")).toBeEnabled();
      } else {
        expect(importDocument).not.toHaveBeenCalled();
      }
      if (surface === "branch") expect(screen.getByTestId("repo-file")).toBeEnabled();
      if (surface === "file") expect(screen.getByTestId("branch-select")).toHaveValue("main");

      const picker = screen.getByTestId("github-picker");
      const controls = [...picker.querySelectorAll<HTMLElement>("*")].filter((element) => element.tabIndex >= 0);
      const focus = screen.getByTestId(`picker-tab-${surface === "gist" || surface === "action" ? "gist" : "repo"}`);
      act(() => focus.focus());
      const counts = callCounts();
      const observer = new MutationObserver(() => {});
      observer.observe(picker, { subtree: true, childList: true, attributes: true, characterData: true });
      const spies = [
        vi.spyOn(HTMLElement.prototype, "focus"),
        vi.spyOn(globalThis, "setTimeout"),
        vi.spyOn(globalThis, "setInterval"),
        vi.spyOn(window, "requestAnimationFrame"),
        vi.spyOn(globalThis, "queueMicrotask"),
        vi.spyOn(globalThis, "fetch"),
      ];
      try {
        expectFailure(surface, message);
        expectFailure(surface, message);
        fireEvent.mouseOver(text);
        fireEvent.mouseMove(text);
        fireEvent.mouseOut(text);
        expect(observer.takeRecords()).toHaveLength(0);
        expect(callCounts()).toEqual(counts);
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(focus);
        expect([...picker.querySelectorAll<HTMLElement>("*")].filter((element) => element.tabIndex >= 0)).toEqual(controls);
        expect(screen.queryByRole("tooltip")).toBeNull();
      } finally {
        observer.disconnect();
        vi.restoreAllMocks();
      }
    },
  );

  it.each(listSurfaces)("replaces repeated %s failures in the same div and admits one current Retry to recovery", async (surface) => {
    source(surface).mockRejectedValueOnce(new Error(unbroken));
    const view = await openSurface(surface);
    const original = expectFailure(surface, unbroken);
    const retry = screen.getByRole<HTMLButtonElement>("button", { name: "Retry" });
    const repeated = holdListAttempt(surface);
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(source(surface)).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBe(retry);
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute("aria-busy", "true");
    expect(retry.querySelectorAll(".animate-spin")).toHaveLength(1);
    expect(original.text.textContent).toBe(prefix(surface) + unbroken);
    await act(async () => {
      repeated.reject(new Error(messages[2].message));
      await Promise.allSettled([repeated.promise]);
    });
    const replacement = expectFailure(surface, messages[2].message);
    expect(replacement.alert).toBe(original.alert);
    expect(replacement.text).toBe(original.text);
    expect(screen.getByRole("button", { name: "Retry" })).toBe(retry);

    const recovered = holdListAttempt(surface);
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(source(surface)).toHaveBeenCalledTimes(3);
    await act(async () => {
      recovered.resolve();
      await recovered.promise;
    });
    expect(screen.queryByTestId(errorId(surface))).toBeNull();
    expect(original.alert).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    if (surface === "gist") expect(screen.getByText("No Markdown gists found.")).toBeInTheDocument();
    if (surface === "repo") expect(screen.getByTestId("repo-item")).toBeEnabled();
    if (surface === "branch") {
      expect(screen.getByTestId("branch-empty")).toHaveTextContent("No branches found.");
      expect(screen.getByTestId("repo-file")).toBeEnabled();
    }
    if (surface === "file") {
      expect(screen.getByText("recovered.md")).toBeInTheDocument();
      expect(screen.getByTestId("branch-select")).toHaveValue("main");
    }
    view.unmount();
    expect(importDocument).not.toHaveBeenCalled();
    expect(linkDocument).not.toHaveBeenCalled();
  });

  it.each(listSurfaces)("retires hidden %s Retry handlers while retaining the cached failure on tab return", async (surface) => {
    source(surface).mockRejectedValueOnce(new Error(unbroken));
    const view = await openSurface(surface);
    const original = expectFailure(surface, unbroken);
    fireEvent.click(screen.getByTestId(`picker-tab-${surface === "gist" ? "repo" : "gist"}`));
    await screen.findByTestId(surface === "gist" ? "repo-item" : "gist-item");
    expect(original.alert).not.toBeInTheDocument();
    expect(screen.queryByTestId(errorId(surface))).toBeNull();
    fireEvent.click(screen.getByTestId(`picker-tab-${surface === "gist" ? "gist" : "repo"}`));
    expectFailure(surface, unbroken);
    expect(source(surface)).toHaveBeenCalledOnce();
    const recovered = holdListAttempt(surface);
    const current = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(current);
    fireEvent.click(current);
    expect(source(surface)).toHaveBeenCalledTimes(2);
    await act(async () => { recovered.resolve(); await recovered.promise; });
    expect(screen.queryByTestId(errorId(surface))).toBeNull();
    view.unmount();
  });

  it.each(["branch", "file"] as const)("replaces %s reasons and retires Retry when choosing another repository", async (surface) => {
    const nextRepo = repository("replacement", "release");
    repos.mockResolvedValue({ repos: [currentRepo, nextRepo] });
    source(surface).mockRejectedValueOnce(new Error(unbroken)).mockRejectedValueOnce(new Error(messages[3].message));
    await openSurface(surface);
    const original = expectFailure(surface, unbroken);
    fireEvent.click(screen.getByRole("button", { name: /Repositories/ }));
    expect(original.alert).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle(nextRepo.fullName));
    await screen.findByTestId(errorId(surface));
    await act(async () => {});
    expectFailure(surface, messages[3].message, nextRepo, "release");
    const recovered = holdListAttempt(surface);
    const current = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(current);
    fireEvent.click(current);
    expect(source(surface).mock.calls).toEqual(surface === "branch"
      ? [["octo", "current"], ["octo", "replacement"], ["octo", "replacement"]]
      : [["octo", "current", "main"], ["octo", "replacement", "release"], ["octo", "replacement", "release"]]);
    await act(async () => { recovered.resolve(); await recovered.promise; });
    expect(screen.queryByTestId(errorId(surface))).toBeNull();
    expect(repos).toHaveBeenCalledOnce();
  });

  it("replaces file failure text and retires its Retry when the branch changes", async () => {
    branches.mockResolvedValue({ branches: ["main", "release"] });
    files.mockRejectedValueOnce(new Error(unbroken)).mockRejectedValueOnce(new Error(messages[2].message));
    await openSurface("file");
    const original = expectFailure("file", unbroken);
    fireEvent.change(screen.getByTestId("branch-select"), { target: { value: "release" } });
    await screen.findByTestId("file-load-error");
    await act(async () => {});
    expectFailure("file", messages[2].message, currentRepo, "release");
    expect(original.alert).not.toBeInTheDocument();
    const recovered = holdListAttempt("file");
    const current = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(current);
    fireEvent.click(current);
    expect(files.mock.calls).toEqual([
      ["octo", "current", "main"], ["octo", "current", "release"], ["octo", "current", "release"],
    ]);
    await act(async () => { recovered.resolve(); await recovered.promise; });
    expect(screen.queryByTestId("file-load-error")).toBeNull();
    expect(screen.getByTestId("branch-select")).toHaveValue("release");
    expect(screen.getByText("recovered.md")).toBeInTheDocument();
  });

  it("keeps wrapped action feedback separate from list recovery and clears repeated action errors on success", async () => {
    importDocument.mockRejectedValueOnce(new Error(unbroken));
    repos.mockRejectedValueOnce(new Error(messages[2].message));
    const onImported = vi.fn();
    const view = render(<GitHubPicker mode="import" githubAvailable githubConfigured onImported={onImported} />);
    fireEvent.click(await screen.findByTestId("gist-item"));
    await screen.findByTestId("github-action-error");
    const original = expectFailure("action", unbroken);
    fireEvent.click(screen.getByTestId("picker-tab-repo"));
    await screen.findByTestId("repo-load-error");
    expectFailure("repo", messages[2].message);
    expect(expectFailure("action", unbroken).alert).toBe(original.alert);
    const recovered = holdListAttempt("repo");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => { recovered.resolve(); await recovered.promise; });
    expect(screen.queryByTestId("repo-load-error")).toBeNull();
    expect(expectFailure("action", unbroken).alert).toBe(original.alert);
    fireEvent.click(screen.getByTestId("picker-tab-gist"));
    const repeated = deferred<{ document: { id: string; title: string } }>();
    importDocument.mockReturnValueOnce(repeated.promise);
    const row = screen.getByTestId("gist-item");
    fireEvent.click(row);
    fireEvent.click(row);
    expect(importDocument).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("github-action-error")).toBeNull();
    expect(original.alert).not.toBeInTheDocument();
    await act(async () => {
      repeated.reject(new Error(messages[3].message));
      await Promise.allSettled([repeated.promise]);
    });
    expectFailure("action", messages[3].message);
    const success = deferred<{ document: { id: string; title: string } }>();
    importDocument.mockReturnValueOnce(success.promise);
    fireEvent.click(row);
    fireEvent.click(row);
    expect(importDocument).toHaveBeenCalledTimes(3);
    expect(row).toBeDisabled();
    expect(screen.queryByTestId("github-action-error")).toBeNull();
    await act(async () => {
      success.resolve({ document: { id: "wrapped-recovery", title: "Recovered" } });
      await success.promise;
    });
    expect(onImported).toHaveBeenCalledExactlyOnceWith("wrapped-recovery");
    expect(row).toBeEnabled();
    expect(screen.queryByTestId("github-action-error")).toBeNull();
    view.unmount();
    expect(linkDocument).not.toHaveBeenCalled();
  });

  it("retires wrapped document failures and actions without letting an old success replace current feedback", async () => {
    const firstDoc = documentDto("doc-first", "First");
    const currentDoc = documentDto("doc-second", "Second");
    const oldRequest = deferred<{ document: DocumentDto }>();
    const currentRequest = deferred<{ document: DocumentDto }>();
    const success = deferred<{ document: DocumentDto }>();
    const onLinked = vi.fn();
    linkDocument.mockRejectedValueOnce(new Error(unbroken))
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise)
      .mockReturnValueOnce(success.promise);
    const view = render(<GitHubPicker mode="link" doc={firstDoc} githubAvailable githubConfigured onLinked={onLinked} />);
    fireEvent.click(screen.getByTestId("gist-create"));
    await screen.findByTestId("github-action-error");
    const original = expectFailure("action", unbroken);
    const oldButton = screen.getByTestId<HTMLButtonElement>("gist-create");
    fireEvent.click(oldButton);
    fireEvent.click(oldButton);
    expect(linkDocument).toHaveBeenCalledTimes(2);
    expect(original.alert).not.toBeInTheDocument();
    view.rerender(<GitHubPicker mode="link" doc={currentDoc} githubAvailable githubConfigured onLinked={onLinked} />);
    expect(screen.queryByTestId("github-action-error")).toBeNull();
    const current = screen.getByTestId<HTMLButtonElement>("gist-create");
    fireEvent.click(current);
    fireEvent.click(current);
    expect(linkDocument).toHaveBeenCalledTimes(3);
    await act(async () => {
      currentRequest.reject(new Error(messages[2].message));
      await Promise.allSettled([currentRequest.promise]);
    });
    const feedback = expectFailure("action", messages[2].message);
    await act(async () => {
      oldRequest.resolve({ document: { ...firstDoc, storage: "gist", gistId: "old", gistFile: "first.md" } });
      await oldRequest.promise;
    });
    expect(expectFailure("action", messages[2].message).alert).toBe(feedback.alert);
    expect(onLinked).not.toHaveBeenCalled();
    fireEvent.click(current);
    fireEvent.click(current);
    expect(linkDocument.mock.calls.map(([id]) => id)).toEqual([firstDoc.id, firstDoc.id, currentDoc.id, currentDoc.id]);
    expect(current).toBeDisabled();
    expect(screen.queryByTestId("github-action-error")).toBeNull();
    const linked = { ...currentDoc, storage: "gist" as const, gistId: "current", gistFile: "second.md" };
    await act(async () => { success.resolve({ document: linked }); await success.promise; });
    expect(onLinked).toHaveBeenCalledExactlyOnceWith(linked);
    expect(current).toBeEnabled();
    view.unmount();
    expect(screen.queryByTestId("github-action-error")).toBeNull();
    expect(importDocument).not.toHaveBeenCalled();
  });

  it.each(surfaces)("retires visible %s failures and their controls on removal before a fresh picker recovers", async (surface) => {
    source(surface).mockRejectedValueOnce(new Error(unbroken)).mockRejectedValueOnce(new Error(messages[1].message));
    const view = await openSurface(surface);
    const original = expectFailure(surface, unbroken);
    view.unmount();
    expect(original.alert).not.toBeInTheDocument();
    expect(screen.queryByTestId(errorId(surface))).toBeNull();
    const fresh = await openSurface(surface);
    expectFailure(surface, messages[1].message);
    expect(screen.getByTestId("github-picker").textContent).not.toContain(unbroken);
    const pending = surface === "action" ? deferred<void>() : holdListAttempt(surface);
    if (surface === "action") {
      importDocument.mockImplementationOnce(async () => {
        await pending.promise;
        return { document: { id: "fresh-import", title: "Fresh" } };
      });
    }
    const current = surface === "action"
      ? screen.getByTestId("gist-item")
      : screen.getByRole("button", { name: "Retry" });
    fireEvent.click(current);
    fireEvent.click(current);
    expect(source(surface)).toHaveBeenCalledTimes(3);
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(screen.queryByTestId(errorId(surface))).toBeNull();
    fresh.unmount();
  });

  it("clears visible action feedback on document replacement and permits only the current document action", async () => {
    const firstDoc = documentDto("doc-first", "First");
    const currentDoc = documentDto("doc-second", "Second");
    linkDocument.mockRejectedValueOnce(new Error(unbroken)).mockRejectedValueOnce(new Error(messages[1].message));
    const onLinked = vi.fn();
    const view = render(<GitHubPicker mode="link" doc={firstDoc} githubAvailable githubConfigured onLinked={onLinked} />);
    fireEvent.click(screen.getByTestId("gist-create"));
    await screen.findByTestId("github-action-error");
    const original = expectFailure("action", unbroken);
    view.rerender(<GitHubPicker mode="link" doc={currentDoc} githubAvailable githubConfigured onLinked={onLinked} />);
    expect(screen.queryByTestId("github-action-error")).toBeNull();
    expect(original.alert).not.toBeInTheDocument();
    const current = screen.getByTestId("gist-create");
    fireEvent.click(current);
    fireEvent.click(current);
    expect(linkDocument.mock.calls.map(([id]) => id)).toEqual([firstDoc.id, currentDoc.id]);
    await screen.findByTestId("github-action-error");
    expectFailure("action", messages[1].message);
    expect(screen.getByTestId("github-picker").textContent).not.toContain(unbroken);
    expect(current).toBeEnabled();
    expect(onLinked).not.toHaveBeenCalled();
    view.unmount();
    expect(screen.queryByTestId("github-action-error")).toBeNull();
  });

  it("compiles the installed wrapping utility without claiming browser line-break coverage", async () => {
    const { compile } = await import("tailwindcss");
    const { build } = await compile("@tailwind utilities;");
    expect(build(["wrap-anywhere"])).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
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

describe("GitHubPicker under Strict Mode", () => {
  it("accepts one exact filter change after direct-root Strict Mode replay", async () => {
    gists.mockResolvedValue({ gists: [gist("gist-alpha", "alpha.md"), gist("gist-beta", "beta.md")] });
    const view = await renderStrictPicker(
      <GitHubPicker mode="import" githubAvailable githubConfigured />,
    );

    try {
      expect(await view.picker.findAllByTestId("gist-item")).toHaveLength(2);
      const filter = view.picker.getByPlaceholderText("Filter gists");
      fireEvent.change(filter, { target: { value: "beta" } });

      expect(filter).toHaveValue("beta");
      expect(view.picker.getAllByTestId("gist-item")).toHaveLength(1);
      expect(view.picker.getByText("beta.md")).toBeInTheDocument();
    } finally {
      await view.unmount();
    }
  });

  it("accepts one exact gist-choice change after direct-root Strict Mode replay", async () => {
    const view = await renderStrictPicker(
      <GitHubPicker mode="link" doc={documentDto()} githubAvailable githubConfigured />,
    );

    try {
      const existing = view.picker.getByRole("radio", { name: "Use an existing gist" });
      fireEvent.click(existing);

      expect(existing).toBeChecked();
      expect(view.picker.getByRole("radio", { name: "Create a new gist" })).not.toBeChecked();
      expect(await view.picker.findByTestId("gist-list")).toBeInTheDocument();
    } finally {
      await view.unmount();
    }
  });

  it("accepts one exact gist row after direct-root Strict Mode replay", async () => {
    const onImported = vi.fn();
    const view = await renderStrictPicker(
      <GitHubPicker mode="import" githubAvailable githubConfigured onImported={onImported} />,
    );

    try {
      fireEvent.click(await view.picker.findByTestId("gist-item"));

      expect(importDocument).toHaveBeenCalledExactlyOnceWith({
        source: "gist",
        gistId: "gist-current",
        filename: "current.md",
      });
      await waitFor(() => expect(onImported).toHaveBeenCalledExactlyOnceWith("imported"));
    } finally {
      await view.unmount();
    }
  });

  it("accepts one exact repository row after direct-root Strict Mode replay", async () => {
    const view = await renderStrictPicker(
      <GitHubPicker mode="import" githubAvailable githubConfigured />,
    );

    try {
      await selectStrictRepository(view.host);

      await waitFor(() => {
        expect(branches).toHaveBeenCalledExactlyOnceWith(currentRepo.owner, currentRepo.name);
        expect(files).toHaveBeenCalledExactlyOnceWith(
          currentRepo.owner,
          currentRepo.name,
          currentRepo.defaultBranch,
        );
      });
    } finally {
      await view.unmount();
    }
  });

  it("accepts one exact branch option after direct-root Strict Mode replay", async () => {
    branches.mockResolvedValue({ branches: ["main", "next"] });
    const view = await renderStrictPicker(
      <GitHubPicker mode="import" githubAvailable githubConfigured />,
    );

    try {
      await selectStrictRepository(view.host);
      const branch = await view.picker.findByTestId("branch-select");
      await waitFor(() =>
        expect(files).toHaveBeenCalledExactlyOnceWith(currentRepo.owner, currentRepo.name, "main"),
      );
      await act(async () => {});
      fireEvent.change(branch, { target: { value: "next" } });

      await waitFor(() => expect(files).toHaveBeenCalledTimes(2));
      expect(files).toHaveBeenLastCalledWith(currentRepo.owner, currentRepo.name, "next");
      expect(branch).toHaveValue("next");
    } finally {
      await view.unmount();
    }
  });

  it("accepts one exact file row after direct-root Strict Mode replay", async () => {
    const onImported = vi.fn();
    const view = await renderStrictPicker(
      <GitHubPicker mode="import" githubAvailable githubConfigured onImported={onImported} />,
    );

    try {
      await selectStrictRepository(view.host);
      const file = await view.picker.findByTestId("repo-file");
      await act(async () => {});
      fireEvent.click(file);

      expect(importDocument).toHaveBeenCalledExactlyOnceWith({
        source: "repo",
        owner: currentRepo.owner,
        repo: currentRepo.name,
        branch: "main",
        path: "README.md",
      });
      await waitFor(() => expect(onImported).toHaveBeenCalledExactlyOnceWith("imported"));
    } finally {
      await view.unmount();
    }
  });

  it("accepts one implicit repository submit after direct-root Strict Mode replay", async () => {
    const doc = documentDto();
    const view = await renderStrictPicker(
      <GitHubPicker mode="link" doc={doc} githubAvailable githubConfigured />,
    );

    try {
      await selectStrictRepository(view.host);
      await view.picker.findByTestId("repo-path");
      await act(async () => {});
      const path = view.picker.getByTestId("repo-path") as HTMLInputElement;
      fireEvent.change(path, { target: { value: "docs/strict.md" } });
      await act(async () => {});

      const currentPath = view.picker.getByTestId("repo-path") as HTMLInputElement;
      const currentForm = currentPath.form;
      const currentSubmit = view.picker.getByTestId("repo-link") as HTMLButtonElement;
      if (!currentForm) throw new Error("The Strict Mode repository path has no form");
      expect(currentPath).toHaveValue("docs/strict.md");
      expect(currentSubmit.form).toBe(currentForm);
      expect(currentSubmit).toBeEnabled();
      expect(linkDocument).not.toHaveBeenCalled();

      act(() => currentForm.requestSubmit());

      expect(linkDocument).toHaveBeenCalledExactlyOnceWith(doc.id, {
        storage: "repo",
        owner: currentRepo.owner,
        repo: currentRepo.name,
        branch: "main",
        path: "docs/strict.md",
      });
    } finally {
      await view.unmount();
    }
  });

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

});

describe("GitHubPicker source focus navigation", () => {
  it.each([
    ["ArrowRight", "Numpad6", 3, "picker-tab-gist", "picker-tab-repo"],
    ["ArrowDown", "Numpad2", 3, "picker-tab-gist", "picker-tab-repo"],
    ["End", "Numpad1", 3, "picker-tab-gist", "picker-tab-repo"],
    ["ArrowLeft", "Numpad4", 3, "picker-tab-repo", "picker-tab-gist"],
    ["ArrowUp", "Numpad8", 3, "picker-tab-repo", "picker-tab-gist"],
    ["Home", "Numpad7", 3, "picker-tab-repo", "picker-tab-gist"],
  ] as const)(
    "moves %s (%s/%s) focus from %s to %s once without selecting, loading, acting, or scrolling",
    async (key, code, location, fromId, toId) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const view = await renderStrictPicker(
        <GitHubPicker mode="import" githubAvailable githubConfigured />,
      );
      try {
        await view.picker.findByTestId("gist-list");
        const group = view.picker.getByRole("group", {
          name: "GitHub source",
        });
        const gistTab = view.picker.getByTestId(
          "picker-tab-gist",
        ) as HTMLButtonElement;
        const repoTab = view.picker.getByTestId(
          "picker-tab-repo",
        ) as HTMLButtonElement;
        const source = view.picker.getByTestId(fromId) as HTMLButtonElement;
        const destination = view.picker.getByTestId(toId) as HTMLButtonElement;
        expect(Array.from(group.children)).toEqual([gistTab, repoTab]);
        expect(gistTab.tabIndex).toBe(0);
        expect(repoTab.tabIndex).toBe(0);
        expect(gistTab).toHaveAttribute("aria-pressed", "true");
        expect(repoTab).toHaveAttribute("aria-pressed", "false");

        source.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const setTimeout = vi.spyOn(window, "setTimeout");
        const setInterval = vi.spyOn(window, "setInterval");
        destination.focus({ preventScroll: true });
        const focusTimeouts = setTimeout.mock.calls.length;
        const focusIntervals = setInterval.mock.calls.length;
        source.focus();
        setTimeout.mockClear();
        setInterval.mockClear();
        focus.mockClear();
        const calls = {
          gists: gists.mock.calls.length,
          repos: repos.mock.calls.length,
          branches: branches.mock.calls.length,
          files: files.mock.calls.length,
          imports: importDocument.mock.calls.length,
          links: linkDocument.mock.calls.length,
        };
        const markup = view.picker.getByTestId("github-picker").innerHTML;
        const filter = view.picker.getByPlaceholderText(
          "Filter gists",
        ) as HTMLInputElement;
        const scroll = [window.scrollX, window.scrollY, group.scrollTop];

        const event = pickerKeyboardEvent(source, key, { code, location });
        source.dispatchEvent(event);

        expect(setTimeout).toHaveBeenCalledTimes(focusTimeouts);
        expect(setInterval).toHaveBeenCalledTimes(focusIntervals);
        expect(event.defaultPrevented).toBe(true);
        expect(destination).toHaveFocus();
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
        expect(focus.mock.instances[0]).toBe(destination);
        expect(view.picker.getByTestId("github-picker").innerHTML).toBe(markup);
        expect(filter).toHaveValue("");
        expect(gistTab).toHaveAttribute("aria-pressed", "true");
        expect(repoTab).toHaveAttribute("aria-pressed", "false");
        expect([window.scrollX, window.scrollY, group.scrollTop]).toEqual(scroll);
        expect(gists).toHaveBeenCalledTimes(calls.gists);
        expect(repos).toHaveBeenCalledTimes(calls.repos);
        expect(branches).toHaveBeenCalledTimes(calls.branches);
        expect(files).toHaveBeenCalledTimes(calls.files);
        expect(importDocument).toHaveBeenCalledTimes(calls.imports);
        expect(linkDocument).toHaveBeenCalledTimes(calls.links);
      } finally {
        await view.unmount();
      }
    },
  );

  it.each([
    ["ArrowLeft", "picker-tab-gist"],
    ["ArrowUp", "picker-tab-gist"],
    ["Home", "picker-tab-gist"],
    ["ArrowRight", "picker-tab-repo"],
    ["ArrowDown", "picker-tab-repo"],
    ["End", "picker-tab-repo"],
    ["Tab", "picker-tab-gist"],
    ["Enter", "picker-tab-gist"],
    [" ", "picker-tab-gist"],
  ] as const)("leaves bounded or non-navigation %s unprevented", async (key, id) => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const view = await renderStrictPicker(
      <GitHubPicker mode="import" githubAvailable githubConfigured />,
    );
    try {
      const source = view.picker.getByTestId(id) as HTMLButtonElement;
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const event = pickerKey(source, key);

      expect(event.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(repos).not.toHaveBeenCalled();
      expect(importDocument).not.toHaveBeenCalled();
      expect(linkDocument).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  it.each(["Enter", " "] as const)(
    "retains %s activation after focus-only navigation",
    async (key) => {
      const view = await renderStrictPicker(
        <GitHubPicker mode="import" githubAvailable githubConfigured />,
      );
      try {
        const gistTab = view.picker.getByTestId(
          "picker-tab-gist",
        ) as HTMLButtonElement;
        const repoTab = view.picker.getByTestId(
          "picker-tab-repo",
        ) as HTMLButtonElement;
        gistTab.focus();
        const navigation = pickerKey(gistTab, "ArrowRight");
        expect(navigation.defaultPrevented).toBe(true);
        expect(repoTab).toHaveFocus();

        const activationKey = pickerKey(repoTab, key);
        expect(activationKey.defaultPrevented).toBe(false);
        fireEvent.click(repoTab);

        expect(await view.picker.findByTestId("repo-list")).toBeInTheDocument();
        expect(repoTab).toHaveAttribute("aria-pressed", "true");
        expect(gistTab).toHaveAttribute("aria-pressed", "false");
        expect(repos).toHaveBeenCalledOnce();
      } finally {
        await view.unmount();
      }
    },
  );

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
