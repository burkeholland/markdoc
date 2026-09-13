// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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

function StrictPickerReplayProbe({
  onReplay,
  children,
}: {
  onReplay: () => void;
  children: ReactNode;
}) {
  const layouts = useRef(0);
  useLayoutEffect(() => {
    layouts.current++;
    if (layouts.current === 2) onReplay();
  }, [onReplay]);
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
  const props = reactProps(element);
  const value = props[name];
  if (typeof value !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return value as T;
}

function reactProps(element: HTMLElement): Record<string, unknown> {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  if (!props) throw new Error(`React props were empty on ${element.dataset.testid ?? element.tagName}`);
  return props;
}

function replaceReactProp(element: HTMLElement, name: string, value: unknown) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const record = element as unknown as Record<string, Record<string, unknown> | undefined>;
  const original = record[propsKey];
  if (!original) throw new Error(`React props were empty on ${element.dataset.testid ?? element.tagName}`);
  record[propsKey] = { ...original, [name]: value };
  return () => {
    record[propsKey] = original;
  };
}

function clonePickerSyntheticEvent<T extends object>(
  event: T,
  overrides: Partial<T> = {},
  syntheticConstructor?: new () => object,
): T {
  const prototype = syntheticConstructor
    ? Object.create(Object.getPrototypeOf(event), {
        constructor: { value: syntheticConstructor },
      })
    : Object.getPrototypeOf(event);
  return Object.assign(Object.create(prototype) as T, event, overrides);
}

type PickerClickHandler = (event: ReactMouseEvent<HTMLButtonElement>) => void;
type PickerChangeHandler<T extends HTMLInputElement | HTMLSelectElement> = (event: ChangeEvent<T>) => void;
type PickerSubmitHandler = (event: FormEvent<HTMLFormElement>) => void;
type SignInRootClickHandler = (event: ReactMouseEvent<HTMLDivElement>) => void;
type PickerKeyHandler<T extends HTMLElement> = (
  event: ReactKeyboardEvent<T>,
) => void;

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
  const event = new SubmitEventConstructor("submit", {
    bubbles: true,
    cancelable: true,
    submitter,
  });
  form.dispatchEvent(event);
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

  it("binds prop and key replacements to their exact current redirect despite late old refs", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    signIn.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(
      <GitHubSignInPrompt
        key="mount-a"
        githubConfigured
        redirectTo="/documents/a"
      />,
    );
    const staleButton = screen.getByRole<HTMLButtonElement>("button", {
      name: /Sign in with GitHub/,
    });
    const staleRoot = screen.getByTestId(
      "github-signin-prompt",
    ) as HTMLDivElement;
    const staleClick = reactProp<PickerClickHandler>(staleButton, "onClick");
    const staleRootRef = reactProp<RefCallback<HTMLDivElement>>(
      staleRoot,
      "ref",
    );
    const staleButtonRef = reactProp<RefCallback<HTMLButtonElement>>(
      staleButton,
      "ref",
    );

    view.rerender(
      <GitHubSignInPrompt
        key="mount-a"
        githubConfigured
        redirectTo="/documents/b"
      />,
    );
    const propButton = screen.getByRole<HTMLButtonElement>("button", {
      name: /Sign in with GitHub/,
    });
    const propRoot = screen.getByTestId(
      "github-signin-prompt",
    ) as HTMLDivElement;
    act(() => {
      staleRootRef(propRoot);
      staleButtonRef(propButton);
      staleButtonRef(null);
      staleRootRef(null);
    });
    await act(async () => Promise.resolve());
    directPickerClick(staleClick, propButton);
    fireEvent.click(propButton);
    expect(signIn).toHaveBeenCalledExactlyOnceWith("github", {
      redirectTo: "/documents/b",
    });

    const propClick = reactProp<PickerClickHandler>(propButton, "onClick");
    view.rerender(
      <GitHubSignInPrompt
        key="mount-b"
        githubConfigured
        redirectTo="/documents/c"
      />,
    );
    const keyedButton = screen.getByRole<HTMLButtonElement>("button", {
      name: /Sign in with GitHub/,
    });
    directPickerClick(propClick, keyedButton);
    staleButton.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
    fireEvent.click(keyedButton);

    expect(signIn).toHaveBeenCalledTimes(2);
    expect(signIn).toHaveBeenNthCalledWith(2, "github", {
      redirectTo: "/documents/c",
    });
    expect(keyedButton).toBeDisabled();
  });

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "rejects a current native event crossed through a stale handler in %s order",
    (order) => {
      const pending = deferred<void>();
      signIn.mockReturnValue(pending.promise);
      const view = render(
        <GitHubSignInPrompt
          githubConfigured
          redirectTo="/documents/stale"
        />,
      );
      const button = screen.getByRole<HTMLButtonElement>("button", {
        name: /Sign in with GitHub/,
      });
      const staleClick = reactProp<PickerClickHandler>(button, "onClick");
      view.rerender(
        <GitHubSignInPrompt
          githubConfigured
          redirectTo="/documents/current"
        />,
      );
      const current = screen.getByRole<HTMLButtonElement>("button", {
        name: /Sign in with GitHub/,
      });
      const host = view.container;
      const attack = (nativeEvent: Event) => {
        if (!(nativeEvent instanceof MouseEvent)) return;
        directPickerClick(staleClick, current, { nativeEvent });
      };
      if (order === "stale-before-current") {
        current.addEventListener("click", attack, {
          capture: true,
          once: true,
        });
      } else {
        host.addEventListener("click", attack, { once: true });
      }

      current.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
      expect(signIn).not.toHaveBeenCalled();
      expect(current).toBeEnabled();

      fireEvent.click(current);
      expect(signIn).toHaveBeenCalledExactlyOnceWith("github", {
        redirectTo: "/documents/current",
      });
      expect(current).toBeDisabled();
    },
  );

  it("keeps an exact sibling prompt usable without borrowing its event", () => {
    const pending = deferred<void>();
    signIn.mockReturnValue(pending.promise);
    render(
      <>
        <GitHubSignInPrompt
          githubConfigured
          redirectTo="/documents/first"
        />
        <GitHubSignInPrompt
          githubConfigured
          redirectTo="/documents/second"
        />
      </>,
    );
    const [first, second] = screen.getAllByRole<HTMLButtonElement>("button", {
      name: /Sign in with GitHub/,
    });
    if (!first || !second) throw new Error("Expected two sign-in prompts");

    fireEvent.click(second);
    expect(signIn).toHaveBeenCalledExactlyOnceWith("github", {
      redirectTo: "/documents/second",
    });
    expect(first).toBeEnabled();
    expect(second).toBeDisabled();
  });

  it("rejects fabricated, sibling, foreign, and incomplete-ref deliveries before a clean successor", () => {
    const pending = deferred<void>();
    signIn.mockReturnValue(pending.promise);
    const view = render(
      <GitHubSignInPrompt
        githubConfigured
        redirectTo="/documents/current"
      />,
    );
    const root = screen.getByTestId("github-signin-prompt");
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: /Sign in with GitHub/,
    });
    const click = reactProp<PickerClickHandler>(button, "onClick");
    const rootCapture = reactProp<SignInRootClickHandler>(
      root,
      "onClickCapture",
    );
    const buttonRef = reactProp<RefCallback<HTMLButtonElement>>(button, "ref");
    const sibling = document.createElement("button");
    sibling.type = "button";
    root.append(sibling);
    const foreign = document.createElement("button");
    foreign.type = "button";
    document.body.append(foreign);

    directPickerClick(click, button);
    directPickerClick(click, sibling);
    directPickerClick(click, foreign);
    rootCapture({
      type: "click",
      currentTarget: root,
      target: button,
      nativeEvent: nativePickerClick(button),
    } as unknown as ReactMouseEvent<HTMLDivElement>);
    act(() => {
      buttonRef(null);
      buttonRef(button);
    });
    sibling.remove();
    fireEvent.click(button);
    expect(signIn).not.toHaveBeenCalled();
    foreign.remove();

    view.rerender(
      <GitHubSignInPrompt
        githubConfigured
        redirectTo="/documents/successor"
      />,
    );
    const successor = screen.getByRole<HTMLButtonElement>("button", {
      name: /Sign in with GitHub/,
    });
    fireEvent.click(successor);
    expect(signIn).toHaveBeenCalledExactlyOnceWith("github", {
      redirectTo: "/documents/successor",
    });
  });

  it("publishes one exact successor after direct-root Strict Mode ref and layout replay", async () => {
    const pending = deferred<void>();
    signIn.mockReturnValue(pending.promise);
    const view = await renderStrictPicker(
      <GitHubSignInPrompt
        githubConfigured
        redirectTo="/documents/strict"
      />,
    );
    try {
      const button = view.picker.getByRole<HTMLButtonElement>("button", {
        name: /Sign in with GitHub/,
      });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      fireEvent.click(button);
      expect(signIn).toHaveBeenCalledExactlyOnceWith("github", {
        redirectTo: "/documents/strict",
      });
      expect(button).toBeDisabled();
    } finally {
      await view.unmount();
    }
  });

  it.each([
    "label mutation",
    "placement mutation",
    "detach and reattach",
  ] as const)(
    "permanently retires a restored %s and leaves a clean successor usable",
    (change) => {
      const pending = deferred<void>();
      signIn.mockReturnValue(pending.promise);
      const view = render(
        <GitHubSignInPrompt
          githubConfigured
          redirectTo="/documents/restored"
        />,
      );
      const root = screen.getByTestId("github-signin-prompt");
      const button = screen.getByRole<HTMLButtonElement>("button", {
        name: /Sign in with GitHub/,
      });
      const parent = root.parentNode;
      if (!parent) throw new Error("The sign-in prompt has no parent");

      if (change === "label mutation") {
        const label = button.lastChild;
        if (!label) throw new Error("The sign-in prompt has no label");
        const value = label.nodeValue;
        label.nodeValue = " Changed";
        label.nodeValue = value;
      } else if (change === "placement mutation") {
        const sibling = document.createElement("span");
        parent.insertBefore(sibling, root);
        sibling.remove();
      } else {
        const next = root.nextSibling;
        root.remove();
        parent.insertBefore(root, next);
      }

      fireEvent.click(button);
      expect(signIn).not.toHaveBeenCalled();
      expect(button).toBeEnabled();

      view.rerender(
        <GitHubSignInPrompt
          githubConfigured
          redirectTo="/documents/fresh"
        />,
      );
      const successor = screen.getByRole<HTMLButtonElement>("button", {
        name: /Sign in with GitHub/,
      });
      fireEvent.click(successor);
      expect(signIn).toHaveBeenCalledExactlyOnceWith("github", {
        redirectTo: "/documents/fresh",
      });
    },
  );

  it("retires owner-document adoption and keeps a distinct clean owner usable", async () => {
    const pending = deferred<void>();
    signIn.mockReturnValue(pending.promise);
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const ownerDocument = frame.contentDocument;
    const ownerWindow = frame.contentWindow;
    if (!ownerDocument || !ownerWindow) {
      throw new Error("The test iframe has no document");
    }
    const host = ownerDocument.createElement("div");
    ownerDocument.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(
          <GitHubSignInPrompt
            githubConfigured
            redirectTo="/documents/foreign"
          />,
        );
      });
      const prompt = within(host).getByTestId("github-signin-prompt");
      const button = within(host).getByRole<HTMLButtonElement>("button", {
        name: /Sign in with GitHub/,
      });
      const parent = prompt.parentNode;
      if (!parent) throw new Error("The foreign prompt has no parent");
      document.adoptNode(prompt);
      ownerDocument.adoptNode(prompt);
      parent.append(prompt);
      const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent;
      if (!MouseEventConstructor) {
        throw new Error("The test iframe has no MouseEvent");
      }
      button.dispatchEvent(
        new MouseEventConstructor("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
      expect(signIn).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      frame.remove();
    }

    render(
      <GitHubSignInPrompt
        githubConfigured
        redirectTo="/documents/local"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Sign in with GitHub/ }),
    );
    expect(signIn).toHaveBeenCalledExactlyOnceWith("github", {
      redirectTo: "/documents/local",
    });
  });

  it("keeps stale success and failure inert after later keyed successors", async () => {
    const staleSuccess = deferred<void>();
    const staleFailure = deferred<void>();
    const current = deferred<void>();
    signIn
      .mockReturnValueOnce(staleSuccess.promise)
      .mockReturnValueOnce(staleFailure.promise)
      .mockReturnValueOnce(current.promise);
    const view = render(
      <GitHubSignInPrompt
        key="success"
        githubConfigured
        redirectTo="/documents/success"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Sign in with GitHub/ }),
    );
    view.rerender(
      <GitHubSignInPrompt
        key="failure"
        githubConfigured
        redirectTo="/documents/failure"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Sign in with GitHub/ }),
    );
    view.rerender(
      <GitHubSignInPrompt
        key="current"
        githubConfigured
        redirectTo="/documents/current"
      />,
    );
    const currentButton = screen.getByRole<HTMLButtonElement>("button", {
      name: /Sign in with GitHub/,
    });
    fireEvent.click(currentButton);

    await act(async () => {
      staleSuccess.resolve();
      staleFailure.reject(new Error("Stale GitHub failure"));
      await Promise.all([
        staleSuccess.promise,
        staleFailure.promise.catch(() => undefined),
      ]);
    });

    expect(signIn).toHaveBeenCalledTimes(3);
    expect(currentButton).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(unhandledRejections).toEqual([]);
  });

  it("rejects a reused native event after failure before one fresh retry", async () => {
    const failed = deferred<void>();
    const retry = deferred<void>();
    signIn
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retry.promise);
    render(
      <GitHubSignInPrompt
        githubConfigured
        redirectTo="/documents/reused"
      />,
    );
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: /Sign in with GitHub/,
    });
    const reused = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    act(() => {
      button.dispatchEvent(reused);
    });
    expect(signIn).toHaveBeenCalledTimes(1);

    await act(async () => {
      failed.reject(new Error("GitHub sign-in failed"));
      await failed.promise.catch(() => undefined);
    });
    expect(button).toBeEnabled();
    act(() => {
      button.dispatchEvent(reused);
    });
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(signIn).toHaveBeenCalledTimes(2);
    expect(signIn).toHaveBeenNthCalledWith(2, "github", {
      redirectTo: "/documents/reused",
    });
    expect(button).toBeDisabled();
  });

  it.each(["unavailable", "poisoned"] as const)(
    "fails configured activation closed when MutationObserver is %s without breaking informational copy",
    (state) => {
      const Observer = window.MutationObserver;
      const takeRecords =
        state === "poisoned"
          ? vi
              .spyOn(Observer.prototype, "takeRecords")
              .mockImplementation(() => {
                throw new Error("poisoned MutationObserver");
              })
          : null;
      if (state === "unavailable") {
        Object.defineProperty(window, "MutationObserver", {
          configurable: true,
          value: undefined,
        });
      }
      try {
        const view = render(
          <GitHubSignInPrompt
            githubConfigured
            redirectTo="/documents/no-platform"
          />,
        );
        const button = screen.getByRole<HTMLButtonElement>("button", {
          name: /Sign in with GitHub/,
        });
        expect(button).toBeEnabled();
        fireEvent.click(button);
        expect(signIn).not.toHaveBeenCalled();

        view.rerender(
          <GitHubSignInPrompt
            githubConfigured={false}
            redirectTo="/documents/no-platform"
          />,
        );
        expect(screen.queryByRole("button")).toBeNull();
        expect(screen.getByTestId("github-not-configured")).toHaveTextContent(
          GITHUB_NOT_CONFIGURED,
        );
      } finally {
        takeRecords?.mockRestore();
        if (state === "unavailable") {
          Object.defineProperty(window, "MutationObserver", {
            configurable: true,
            value: Observer,
          });
        }
      }
    },
  );

  it("releases native and mutation ownership on terminal cleanup and ignores its late failure", async () => {
    const pending = deferred<void>();
    signIn.mockReturnValue(pending.promise);
    const disconnect = vi.spyOn(
      MutationObserver.prototype,
      "disconnect",
    );
    const remove = vi.spyOn(document, "removeEventListener");
    const view = render(
      <GitHubSignInPrompt
        githubConfigured
        redirectTo="/documents/unmounted"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Sign in with GitHub/ }),
    );
    view.unmount();

    await act(async () => {
      pending.reject(new Error("Unmounted GitHub failure"));
      await pending.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(
      remove.mock.calls.some(
        ([type, listener]) =>
          type === "click" && typeof listener === "function",
      ),
    ).toBe(true);
    expect(disconnect).toHaveBeenCalled();
    expect(screen.queryByTestId("github-signin-prompt")).toBeNull();
    expect(unhandledRejections).toEqual([]);
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
  it("accepts each production-mangled React event family once while rejecting invalid provenance", async () => {
    const doc = documentDto();
    const mangledConstructor = class a {};
    branches.mockResolvedValue({ branches: ["main", "next"] });
    const view = render(
      <GitHubPicker mode="link" doc={doc} githubAvailable githubConfigured />,
    );
    const foreignButton = document.createElement("button");
    const foreignSelect = document.createElement("select");
    const foreignForm = document.createElement("form");
    document.body.append(foreignButton, foreignSelect, foreignForm);

    try {
      const repoTab = view.getByTestId("picker-tab-repo") as HTMLButtonElement;
      const click = reactProp<PickerClickHandler>(repoTab, "onClick");
      replaceReactProp(repoTab, "onClick", (event: ReactMouseEvent<HTMLButtonElement>) => {
        click(clonePickerSyntheticEvent(event, { persist: undefined }, mangledConstructor));
        click(clonePickerSyntheticEvent(event, { currentTarget: foreignButton }, mangledConstructor));
        click(
          clonePickerSyntheticEvent(
            event,
            { nativeEvent: nativePickerClick(repoTab) },
            mangledConstructor,
          ),
        );
      });

      fireEvent.click(repoTab);
      expect(repos).not.toHaveBeenCalled();
      expect(view.queryByTestId("repo-list")).toBeNull();

      replaceReactProp(repoTab, "onClick", (event: ReactMouseEvent<HTMLButtonElement>) => {
        const structuralEvent = clonePickerSyntheticEvent(event, {}, mangledConstructor);
        expect(Object.getPrototypeOf(structuralEvent).constructor.name).toBe("a");
        click(structuralEvent);
        click(structuralEvent);
      });
      fireEvent.click(repoTab);
      expect(await view.findByTestId("repo-list")).toBeInTheDocument();
      expect(repos).toHaveBeenCalledOnce();

      fireEvent.click(await view.findByTestId("repo-item"));
      const branch = (await view.findByTestId("branch-select")) as HTMLSelectElement;
      await waitFor(() =>
        expect(files).toHaveBeenCalledExactlyOnceWith(currentRepo.owner, currentRepo.name, "main"),
      );
      const change = reactProp<PickerChangeHandler<HTMLSelectElement>>(branch, "onChange");
      replaceReactProp(branch, "onChange", (event: ChangeEvent<HTMLSelectElement>) => {
        change(clonePickerSyntheticEvent(event, { persist: undefined }, mangledConstructor));
        change(clonePickerSyntheticEvent(event, { currentTarget: foreignSelect }, mangledConstructor));
        change(
          clonePickerSyntheticEvent(
            event,
            { nativeEvent: nativePickerChange(branch) },
            mangledConstructor,
          ),
        );
      });

      fireEvent.change(branch, { target: { value: "next" } });
      expect(files).toHaveBeenCalledOnce();

      branch.value = "main";
      replaceReactProp(branch, "onChange", (event: ChangeEvent<HTMLSelectElement>) => {
        const structuralEvent = clonePickerSyntheticEvent(event, {}, mangledConstructor);
        expect(Object.getPrototypeOf(structuralEvent).constructor.name).toBe("a");
        change(structuralEvent);
        change(structuralEvent);
      });
      fireEvent.change(branch, { target: { value: "next" } });
      await waitFor(() => expect(files).toHaveBeenCalledTimes(2));
      expect(files).toHaveBeenLastCalledWith(currentRepo.owner, currentRepo.name, "next");

      const path = view.getByTestId("repo-path") as HTMLInputElement;
      fireEvent.change(path, { target: { value: "docs/production.md" } });
      const form = path.form;
      const submit = view.getByTestId("repo-link") as HTMLButtonElement;
      if (!form) throw new Error("The production-mangled repository path has no form");
      const submitHandler = reactProp<PickerSubmitHandler>(form, "onSubmit");
      replaceReactProp(form, "onSubmit", (event: FormEvent<HTMLFormElement>) => {
        submitHandler(clonePickerSyntheticEvent(event, { persist: undefined }, mangledConstructor));
        submitHandler(clonePickerSyntheticEvent(event, { currentTarget: foreignForm }, mangledConstructor));
        const SubmitEventConstructor = form.ownerDocument.defaultView?.SubmitEvent;
        if (!SubmitEventConstructor) throw new Error("The picker form has no owner-document SubmitEvent");
        submitHandler(
          clonePickerSyntheticEvent(
            event,
            {
              nativeEvent: new SubmitEventConstructor("submit", {
                bubbles: true,
                cancelable: true,
                submitter: submit,
              }),
            },
            mangledConstructor,
          ),
        );
      });

      const rejectedSubmit = dispatchPickerSubmit(form, submit);
      expect(rejectedSubmit.defaultPrevented).toBe(true);
      expect(linkDocument).not.toHaveBeenCalled();

      replaceReactProp(form, "onSubmit", (event: FormEvent<HTMLFormElement>) => {
        const structuralEvent = clonePickerSyntheticEvent(event, {}, mangledConstructor);
        expect(Object.getPrototypeOf(structuralEvent).constructor.name).toBe("a");
        submitHandler(structuralEvent);
        submitHandler(structuralEvent);
      });
      const acceptedSubmit = dispatchPickerSubmit(form, submit);

      expect(acceptedSubmit.defaultPrevented).toBe(true);
      expect(linkDocument).toHaveBeenCalledExactlyOnceWith(doc.id, {
        storage: "repo",
        owner: currentRepo.owner,
        repo: currentRepo.name,
        branch: "next",
        path: "docs/production.md",
      });
    } finally {
      foreignButton.remove();
      foreignSelect.remove();
      foreignForm.remove();
    }
  });

  it("retires the first Strict Mode publication before an exact successor handles the replayed tab", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onReplay = vi.fn(() => {
      const tab = host.querySelector<HTMLButtonElement>('[data-testid="picker-tab-repo"]');
      if (!tab) throw new Error("The replayed picker has no repository tab");
      const MouseEventConstructor = tab.ownerDocument.defaultView?.MouseEvent;
      if (!MouseEventConstructor) throw new Error("The replayed tab has no owner-document MouseEvent");
      tab.dispatchEvent(new MouseEventConstructor("click", { bubbles: true, cancelable: true, button: 0 }));
    });

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <StrictPickerReplayProbe onReplay={onReplay}>
              <GitHubPicker mode="import" githubAvailable githubConfigured />
            </StrictPickerReplayProbe>
          </StrictMode>,
        );
      });

      expect(onReplay).toHaveBeenCalledOnce();
      expect(repos).not.toHaveBeenCalled();
      expect(host.querySelector('[data-testid="picker-tab-gist"]')).toBeInTheDocument();
      expect(host.querySelector('[data-testid="repo-list"]')).toBeNull();

      const currentTab = host.querySelector<HTMLButtonElement>('[data-testid="picker-tab-repo"]');
      if (!currentTab) throw new Error("The exact successor has no repository tab");
      fireEvent.click(currentTab);
      await waitFor(() => expect(repos).toHaveBeenCalledOnce());
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

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

  it("prevents a retired implicit repository submit before a fresh picker submits once", async () => {
    const doc = documentDto();
    const picker = (key: string) => (
      <GitHubPicker
        key={key}
        mode="link"
        doc={doc}
        githubAvailable
        githubConfigured
      />
    );
    const view = await renderStrictPicker(picker("retired-form"));

    try {
      await selectStrictRepository(view.host);
      const stalePath = (await view.picker.findByTestId("repo-path")) as HTMLInputElement;
      const staleForm = stalePath.form;
      if (!staleForm) throw new Error("The retired repository path has no form");
      fireEvent.change(stalePath, { target: { value: "docs/retired.md" } });
      await act(async () => {});
      stalePath.setAttribute("name", "transient");
      stalePath.removeAttribute("name");

      fireEvent.keyDown(stalePath, { key: "Enter", code: "Enter" });
      const SubmitEventConstructor = staleForm.ownerDocument.defaultView?.SubmitEvent;
      if (!SubmitEventConstructor) throw new Error("The retired form has no owner-document SubmitEvent");
      const staleSubmit = new SubmitEventConstructor("submit", {
        bubbles: true,
        cancelable: true,
        submitter: null,
      });
      const preventDefault = vi.spyOn(staleSubmit, "preventDefault");
      let dispatched = true;
      act(() => {
        dispatched = staleForm.dispatchEvent(staleSubmit);
      });

      expect(dispatched).toBe(false);
      expect(staleSubmit.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(linkDocument).not.toHaveBeenCalled();

      await act(async () => {
        view.root.render(<StrictMode>{picker("fresh-form")}</StrictMode>);
      });
      await selectStrictRepository(view.host);
      await view.picker.findByTestId("repo-path");
      await act(async () => {});
      const path = view.picker.getByTestId("repo-path") as HTMLInputElement;
      fireEvent.change(path, { target: { value: "docs/current.md" } });
      await act(async () => {});

      const currentPath = view.picker.getByTestId("repo-path") as HTMLInputElement;
      const currentForm = currentPath.form;
      const currentSubmit = view.picker.getByTestId("repo-link") as HTMLButtonElement;
      if (!currentForm) throw new Error("The fresh repository path has no form");
      expect(currentPath).toHaveValue("docs/current.md");
      expect(currentSubmit.form).toBe(currentForm);
      expect(currentSubmit).toBeEnabled();
      expect(linkDocument).not.toHaveBeenCalled();

      act(() => currentForm.requestSubmit());

      expect(linkDocument).toHaveBeenCalledExactlyOnceWith(doc.id, {
        storage: "repo",
        owner: currentRepo.owner,
        repo: currentRepo.name,
        branch: "main",
        path: "docs/current.md",
      });
    } finally {
      await view.unmount();
    }
  });

  it("rejects Strict Mode mutation, detach, stale crossing, repetition, and reentry without poisoning a remount", async () => {
    const onImported = vi.fn();
    const picker = (key: string) => (
      <StrictMode>
        <GitHubPicker
          key={key}
          mode="import"
          githubAvailable
          githubConfigured
          onImported={onImported}
        />
      </StrictMode>
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(picker("A")));
      const staleRow = (await within(host).findByTestId("gist-item")) as HTMLButtonElement;
      const staleHandler = reactProp<PickerClickHandler>(staleRow, "onClick");
      const staleRef = reactProp<RefCallback<HTMLButtonElement>>(staleRow, "ref");

      const staleFilter = within(host).getByPlaceholderText("Filter gists");
      staleFilter.setAttribute("name", "transient");
      staleFilter.removeAttribute("name");
      fireEvent.click(staleRow);
      expect(importDocument).not.toHaveBeenCalled();

      await act(async () => root.render(picker("B")));
      const detachedRow = (await within(host).findByTestId("gist-item")) as HTMLButtonElement;
      const detachedItem = detachedRow.parentElement;
      const detachedList = detachedItem?.parentElement;
      const detachedNext = detachedItem?.nextSibling ?? null;
      if (!detachedItem || !detachedList) throw new Error("The detachable Strict Mode row has no list");
      detachedItem.remove();
      detachedList.insertBefore(detachedItem, detachedNext);
      fireEvent.click(detachedRow);
      expect(importDocument).not.toHaveBeenCalled();

      await act(async () => root.render(picker("A")));
      const currentRow = (await within(host).findByTestId("gist-item")) as HTMLButtonElement;
      staleRef(currentRow);
      const restoreCurrentHandler = replaceReactProp(currentRow, "onClick", staleHandler);
      fireEvent.click(currentRow);
      restoreCurrentHandler();
      staleRef(null);
      expect(importDocument).not.toHaveBeenCalled();

      importDocument.mockImplementationOnce(() => {
        const tab = within(host).getByTestId("picker-tab-repo") as HTMLButtonElement;
        const MouseEventConstructor = tab.ownerDocument.defaultView?.MouseEvent;
        if (!MouseEventConstructor) throw new Error("The reentrant tab has no owner-document MouseEvent");
        tab.dispatchEvent(
          new MouseEventConstructor("click", {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        );
        return Promise.resolve({ document: { id: "imported", title: "Imported" } });
      });
      const MouseEventConstructor = currentRow.ownerDocument.defaultView?.MouseEvent;
      if (!MouseEventConstructor) throw new Error("The repeated row has no owner-document MouseEvent");
      const repeatedEvent = new MouseEventConstructor("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      act(() => {
        currentRow.dispatchEvent(repeatedEvent);
        currentRow.dispatchEvent(repeatedEvent);
      });

      expect(importDocument).toHaveBeenCalledExactlyOnceWith({
        source: "gist",
        gistId: "gist-current",
        filename: "current.md",
      });
      expect(repos).not.toHaveBeenCalled();
      await waitFor(() => expect(onImported).toHaveBeenCalledExactlyOnceWith("imported"));
    } finally {
      await act(async () => root.unmount());
      host.remove();
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

  it("keeps a restored mutated or reordered gist publication retired while a fresh picker works", async () => {
    const first = gist("gist-first", "first.md");
    const second = gist("gist-second", "second.md");
    const mutableGists = [first, second];
    const onImported = vi.fn();
    gists.mockResolvedValue({ gists: mutableGists });

    const view = render(
      <GitHubPicker key="gist-a" mode="import" githubAvailable githubConfigured onImported={onImported} />,
    );
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
    expect(importDocument).not.toHaveBeenCalled();

    view.rerender(
      <GitHubPicker key="gist-b" mode="import" githubAvailable githubConfigured onImported={onImported} />,
    );
    const currentRow = (await screen.findAllByTestId("gist-item"))[0] as HTMLButtonElement;
    fireEvent.click(currentRow);
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

  it("rejects fabricated field changes and keeps restored branch facts retired until a fresh picker", async () => {
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
    const branchView = render(
      <GitHubPicker key="branch-a" mode="import" githubAvailable githubConfigured />,
    );
    await selectRepository();
    const branchSelect = (await screen.findByTestId("branch-select")) as HTMLSelectElement;
    await waitFor(() => expect(files).toHaveBeenCalledExactlyOnceWith(currentRepo.owner, currentRepo.name, "main"));

    mutableBranches[1] = "release";
    fireEvent.change(branchSelect, { target: { value: "next" } });
    expect(files).toHaveBeenCalledTimes(1);

    mutableBranches[1] = "next";
    branchSelect.value = "main";
    fireEvent.change(branchSelect, { target: { value: "next" } });
    expect(files).toHaveBeenCalledTimes(1);

    branchView.rerender(
      <GitHubPicker key="branch-b" mode="import" githubAvailable githubConfigured />,
    );
    await selectRepository();
    const currentBranch = (await screen.findByTestId("branch-select")) as HTMLSelectElement;
    await waitFor(() => expect(files).toHaveBeenCalledTimes(2));
    fireEvent.change(currentBranch, { target: { value: "next" } });
    await waitFor(() => expect(files).toHaveBeenCalledTimes(3));
    expect(files).toHaveBeenLastCalledWith(currentRepo.owner, currentRepo.name, "next");
    expect(screen.getByTestId("branch-select")).toHaveValue("next");
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

  it("uses distinct capture and bubble wrappers, ignores persist compatibility drift, and calls public prevention once", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const nativePreventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const view = await renderStrictPicker(
      <GitHubPicker mode="import" githubAvailable githubConfigured />,
    );
    try {
      const group = view.picker.getByRole("group", {
        name: "GitHub source",
      });
      const gistTab = view.picker.getByTestId(
        "picker-tab-gist",
      ) as HTMLButtonElement;
      const repoTab = view.picker.getByTestId(
        "picker-tab-repo",
      ) as HTMLButtonElement;
      const groupCapture = reactProp<PickerKeyHandler<HTMLDivElement>>(
        group,
        "onKeyDownCapture",
      );
      const buttonCapture = reactProp<PickerKeyHandler<HTMLButtonElement>>(
        gistTab,
        "onKeyDownCapture",
      );
      const buttonBubble = reactProp<PickerKeyHandler<HTMLButtonElement>>(
        gistTab,
        "onKeyDown",
      );
      const groupBubble = reactProp<PickerKeyHandler<HTMLDivElement>>(
        group,
        "onKeyDown",
      );
      let captureWrapper: ReactKeyboardEvent<HTMLElement> | null = null;
      let bubbleWrapper: ReactKeyboardEvent<HTMLElement> | null = null;
      const publicPreventDefaults: Array<ReturnType<typeof vi.fn>> = [];
      const reentrantEvents: KeyboardEvent[] = [];
      const capturePersist = vi.fn();
      const bubblePersist = vi.fn();
      const incompatiblePersist = Object.freeze({ compatibility: false });
      const persistValues: unknown[] = [];
      let trackedNativeEvent: Event | null = null;
      const replacePersist = (
        event: ReactKeyboardEvent<HTMLElement>,
        value: unknown,
      ) => {
        trackedNativeEvent ??= event.nativeEvent;
        Object.defineProperty(event, "persist", {
          configurable: true,
          writable: true,
          value,
        });
        if (event.nativeEvent === trackedNativeEvent) {
          persistValues.push(
            (event as unknown as { persist?: unknown }).persist,
          );
        }
      };
      replaceReactProp(
        group,
        "onKeyDownCapture",
        (event: ReactKeyboardEvent<HTMLDivElement>) => {
          replacePersist(event, undefined);
          captureWrapper = event;
          groupCapture(event);
        },
      );
      replaceReactProp(
        gistTab,
        "onKeyDownCapture",
        (event: ReactKeyboardEvent<HTMLButtonElement>) => {
          expect(event).toBe(captureWrapper);
          replacePersist(event, capturePersist);
          buttonCapture(event);
        },
      );
      replaceReactProp(
        gistTab,
        "onKeyDown",
        (event: ReactKeyboardEvent<HTMLButtonElement>) => {
          replacePersist(event, incompatiblePersist);
          bubbleWrapper = event;
          const original = event.preventDefault;
          const publicPreventDefault = vi.fn(function (
            this: ReactKeyboardEvent<HTMLButtonElement>,
          ) {
            const result = original.call(this);
            const reentrantEvent = pickerKeyboardEvent(gistTab, "ArrowRight");
            reentrantEvents.push(reentrantEvent);
            gistTab.dispatchEvent(reentrantEvent);
            return result;
          });
          publicPreventDefaults.push(publicPreventDefault);
          Object.defineProperty(event, "preventDefault", {
            configurable: true,
            writable: true,
            value: publicPreventDefault,
          });
          buttonBubble(event);
        },
      );
      replaceReactProp(
        group,
        "onKeyDown",
        (event: ReactKeyboardEvent<HTMLDivElement>) => {
          expect(event).toBe(bubbleWrapper);
          replacePersist(event, bubblePersist);
          groupBubble(event);
        },
      );
      gistTab.focus();
      focus.mockClear();
      nativePreventDefault.mockClear();

      const event = pickerKey(gistTab, "ArrowRight");

      expect(captureWrapper).not.toBeNull();
      expect(bubbleWrapper).not.toBeNull();
      expect(captureWrapper).not.toBe(bubbleWrapper);
      expect(persistValues).toEqual([
        undefined,
        capturePersist,
        incompatiblePersist,
        bubblePersist,
      ]);
      expect(publicPreventDefaults).toHaveLength(2);
      expect(publicPreventDefaults[0]).toHaveBeenCalledOnce();
      expect(publicPreventDefaults[1]).not.toHaveBeenCalled();
      expect(reentrantEvents).toHaveLength(1);
      expect(reentrantEvents[0]?.defaultPrevented).toBe(false);
      expect(nativePreventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(event.defaultPrevented).toBe(true);
      expect(repoTab).toHaveFocus();
    } finally {
      await view.unmount();
    }
  });

  it.each([
    "preventDefault",
    "stopPropagation",
    "isDefaultPrevented",
    "isPropagationStopped",
  ] as const)(
    "rejects retained %s drift and admits a clean successor",
    async (method) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const view = await renderStrictPicker(
        <GitHubPicker mode="import" githubAvailable githubConfigured />,
      );
      try {
        const group = view.picker.getByRole("group", {
          name: "GitHub source",
        });
        const source = view.picker.getByTestId(
          "picker-tab-gist",
        ) as HTMLButtonElement;
        const destination = view.picker.getByTestId(
          "picker-tab-repo",
        ) as HTMLButtonElement;
        const groupCapture = reactProp<PickerKeyHandler<HTMLDivElement>>(
          group,
          "onKeyDownCapture",
        );
        let drift = true;
        replaceReactProp(
          group,
          "onKeyDownCapture",
          (event: ReactKeyboardEvent<HTMLDivElement>) => {
            groupCapture(event);
            if (!drift) return;
            Object.defineProperty(event, method, {
              configurable: true,
              writable: true,
              value: vi.fn(() =>
                method.startsWith("is") ? false : undefined,
              ),
            });
          },
        );
        source.focus();
        focus.mockClear();
        preventDefault.mockClear();

        const rejected = pickerKey(source, "ArrowRight");

        expect(rejected.defaultPrevented).toBe(false);
        expect(source).toHaveFocus();
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();

        drift = false;
        const accepted = pickerKey(source, "ArrowRight");

        expect(accepted.defaultPrevented).toBe(true);
        expect(destination).toHaveFocus();
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
      } finally {
        await view.unmount();
      }
    },
  );

  it("accepts the genuine Window receiver while rejecting an exact structural facade", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const view = await renderStrictPicker(
      <GitHubPicker mode="import" githubAvailable githubConfigured />,
    );
    try {
      const source = view.picker.getByTestId(
        "picker-tab-gist",
      ) as HTMLButtonElement;
      const destination = view.picker.getByTestId(
        "picker-tab-repo",
      ) as HTMLButtonElement;
      const ownerWindow = source.ownerDocument.defaultView;
      if (!ownerWindow) throw new Error("The picker has no owner Window");
      const event = pickerKeyboardEvent(source, "ArrowRight");
      const observation: {
        receiver?: EventTarget;
        currentTarget?: EventTarget | null;
        terminal?: EventTarget;
      } = {};
      const observeReceiver = function (
        this: EventTarget,
        nativeEvent: Event,
      ) {
        if (nativeEvent !== event) return;
        observation.receiver = this;
        observation.currentTarget = nativeEvent.currentTarget;
        observation.terminal = nativeEvent.composedPath().at(-1);
        setPickerEventView(event, this as Window);
      };
      ownerWindow.addEventListener("keydown", observeReceiver, true);
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      try {
        act(() => {
          source.dispatchEvent(event);
        });
      } finally {
        ownerWindow.removeEventListener("keydown", observeReceiver, true);
      }

      expect(observation.receiver).toBe(observation.currentTarget);
      expect(observation.receiver).toBe(observation.terminal);
      expect(event.view).toBe(observation.receiver);
      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();

      const structural = Object.create(
        ownerWindow.Window.prototype,
      ) as Window;
      Object.defineProperties(structural, {
        document: { value: source.ownerDocument },
        Window: { value: ownerWindow.Window },
        Event: { value: ownerWindow.Event },
        UIEvent: { value: ownerWindow.UIEvent },
        EventTarget: { value: ownerWindow.EventTarget },
        KeyboardEvent: { value: ownerWindow.KeyboardEvent },
        HTMLElement: { value: ownerWindow.HTMLElement },
        Object: { value: ownerWindow.Object },
        Reflect: { value: ownerWindow.Reflect },
        window: { value: structural },
        self: { value: structural },
      });
      const facadeEvent = pickerKeyboardEvent(source, "ArrowRight");
      setPickerEventView(facadeEvent, structural);
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();

      act(() => {
        source.dispatchEvent(facadeEvent);
      });

      expect(facadeEvent.view).toBe(structural);
      expect(facadeEvent.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();

      const recovered = pickerKey(source, "ArrowRight");
      expect(recovered.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
    } finally {
      await view.unmount();
    }
  });

  it("rejects stale source callbacks after a same-DOM replacement and lets the current callbacks recover", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const view = await renderStrictPicker(
      <GitHubPicker
        mode="import"
        githubAvailable
        githubConfigured
        onImported={vi.fn()}
      />,
    );
    try {
      const staleGroup = view.picker.getByRole("group", {
        name: "GitHub source",
      });
      const staleSource = view.picker.getByTestId(
        "picker-tab-gist",
      ) as HTMLButtonElement;
      const staleHandlers = {
        groupCapture: reactProp<PickerKeyHandler<HTMLDivElement>>(
          staleGroup,
          "onKeyDownCapture",
        ),
        sourceCapture: reactProp<PickerKeyHandler<HTMLButtonElement>>(
          staleSource,
          "onKeyDownCapture",
        ),
        sourceBubble: reactProp<PickerKeyHandler<HTMLButtonElement>>(
          staleSource,
          "onKeyDown",
        ),
        groupBubble: reactProp<PickerKeyHandler<HTMLDivElement>>(
          staleGroup,
          "onKeyDown",
        ),
      };
      await view.rerender(
        <GitHubPicker
          mode="import"
          githubAvailable
          githubConfigured
          onImported={vi.fn()}
        />,
      );
      const group = view.picker.getByRole("group", {
        name: "GitHub source",
      });
      const source = view.picker.getByTestId(
        "picker-tab-gist",
      ) as HTMLButtonElement;
      const destination = view.picker.getByTestId(
        "picker-tab-repo",
      ) as HTMLButtonElement;
      expect(group).toBe(staleGroup);
      expect(source).toBe(staleSource);
      const restorers = [
        replaceReactProp(
          group,
          "onKeyDownCapture",
          staleHandlers.groupCapture,
        ),
        replaceReactProp(
          source,
          "onKeyDownCapture",
          staleHandlers.sourceCapture,
        ),
        replaceReactProp(source, "onKeyDown", staleHandlers.sourceBubble),
        replaceReactProp(group, "onKeyDown", staleHandlers.groupBubble),
      ];
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const staleEvent = pickerKey(source, "ArrowRight");
      for (const restore of restorers.reverse()) restore();

      expect(staleEvent.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();

      const recovered = pickerKey(source, "ArrowRight");
      expect(recovered.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
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

  it("keeps busy, detached, restored, and Strict replay sources inert before a clean successor moves", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const replayEvents: KeyboardEvent[] = [];
    const onReplay = vi.fn(() => {
      const source = document.querySelector<HTMLButtonElement>(
        '[data-testid="picker-tab-gist"]',
      );
      if (!source) throw new Error("The replayed picker has no gist source");
      source.focus();
      const event = pickerKeyboardEvent(source, "ArrowRight");
      replayEvents.push(event);
      source.dispatchEvent(event);
    });
    const replayView = await renderStrictPicker(
      <StrictPickerReplayProbe onReplay={onReplay}>
        <GitHubPicker mode="import" githubAvailable githubConfigured />
      </StrictPickerReplayProbe>,
    );
    let retiredSource: HTMLButtonElement;
    try {
      expect(onReplay).toHaveBeenCalledOnce();
      expect(replayEvents[0]?.defaultPrevented).toBe(false);
      const source = replayView.picker.getByTestId(
        "picker-tab-gist",
      ) as HTMLButtonElement;
      retiredSource = source;
      const destination = replayView.picker.getByTestId(
        "picker-tab-repo",
      ) as HTMLButtonElement;
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const accepted = pickerKey(source, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
    } finally {
      await replayView.unmount();
    }
    const cleanupEvent = pickerKeyboardEvent(retiredSource!, "ArrowRight");
    retiredSource!.dispatchEvent(cleanupEvent);
    expect(cleanupEvent.defaultPrevented).toBe(false);

    const request = deferred<{
      document: { id: string; title: string };
    }>();
    importDocument.mockReturnValue(request.promise);
    const busyView = renderPicker();
    const busySource = busyView.getByTestId(
      "picker-tab-gist",
    ) as HTMLButtonElement;
    busySource.focus();
    fireEvent.click(await busyView.findByTestId("gist-item"));
    expect(busySource).toBeDisabled();
    const busyEvent = pickerKeyboardEvent(busySource, "ArrowRight");
    act(() => {
      busySource.dispatchEvent(busyEvent);
    });
    expect(busyEvent.defaultPrevented).toBe(false);
    expect(repos).not.toHaveBeenCalled();
    await act(async () => {
      request.resolve({ document: { id: "busy", title: "Busy" } });
      await request.promise;
    });
    busyView.unmount();

    const restoredView = await renderStrictPicker(
      <GitHubPicker mode="import" githubAvailable githubConfigured />,
    );
    try {
      const group = restoredView.picker.getByRole("group", {
        name: "GitHub source",
      });
      const source = restoredView.picker.getByTestId(
        "picker-tab-gist",
      ) as HTMLButtonElement;
      const destination = restoredView.picker.getByTestId(
        "picker-tab-repo",
      ) as HTMLButtonElement;
      destination.remove();
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const missingEvent = pickerKey(source, "ArrowRight");
      await act(async () => {});
      expect(missingEvent.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();

      group.append(destination);
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const restoredEvent = pickerKey(source, "ArrowRight");
      await act(async () => {});

      expect(restoredEvent.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
    } finally {
      await restoredView.unmount();
    }
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
