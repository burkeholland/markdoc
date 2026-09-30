// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import * as Y from "yjs";

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  return {
    HocuspocusProvider: class {
      awareness: InstanceType<typeof Awareness>;
      constructor(opts: { document: Y.Doc }) { this.awareness = new Awareness(opts.document); }
      destroy() { this.awareness.destroy(); }
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./lazy-on-first-use", async () => {
  const { createElement, useEffect, useState } = await import("react");
  return {
    lazyOnFirstUse: <M, P extends object>(load: () => Promise<M>, pick: (mod: M) => React.ComponentType<P>, loading?: () => React.ReactElement | null) => {
      return function LazyTestComponent(props: P) {
        const [Component, setComponent] = useState<React.ComponentType<P> | null>(null);
        useEffect(() => {
          let live = true;
          void load().then((mod) => {
            if (live) setComponent(() => pick(mod));
          });
          return () => {
            live = false;
          };
        }, []);
        return Component ? createElement(Component, props) : (loading?.() ?? null);
      };
    },
  };
});
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      documents: {
        ...actual.api.documents,
        createVersion: vi.fn(),
      },
    },
  };
});
vi.mock("./use-session", async (importOriginal) => ({
  ...await importOriginal<typeof import("./use-session")>(),
  useCollabSession: () => session,
}));
vi.mock("@/lib/viewport-hooks", () => ({ useBreakpoint: () => "desktop" }));
vi.mock("./use-sync-polling", async (importOriginal) => ({
  ...await importOriginal<typeof import("./use-sync-polling")>(),
  useSyncPolling: () => {},
}));
vi.mock("./header", () => ({
  Header: (props: ComponentProps<typeof import("./header").Header>) => {
    headerProps = props;
    return (
      <div>
        <button type="button" data-testid="header-name-version" onClick={props.onNameVersion}>Name version</button>
        <button type="button" data-testid="header-history" onClick={props.onHistory}>History</button>
      </div>
    );
  },
}));
vi.mock("./versions-panel", () => ({
  VersionDiffView: () => null,
  VersionsPanel: (props: ComponentProps<typeof import("./versions-panel").VersionsPanel>) => {
    versionsRefresh = props.refreshKey;
    return <div data-testid="versions-panel-mock" data-refresh={props.refreshKey} />;
  },
}));
vi.mock("./dialogs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dialogs")>();
  return {
    ...actual,
    LinkDialog: () => null,
    ImageDialog: () => null,
    TableDialog: () => null,
    ShortcutsDialog: () => null,
  };
});
vi.mock("./github-dialog", () => ({ GitHubDialog: () => null, CommitDialog: () => null }));
vi.mock("./sync-dialog", () => ({ SyncDialog: () => null }));
vi.mock("./activity-panel", () => ({ ActivityPanel: () => null }));
vi.mock("./comments-panel", () => ({ CommentsPanel: () => null }));
vi.mock("./share-dialog", () => ({ ShareDialog: () => null }));
vi.mock("./file-drop-dialog", () => ({ FileDropDialog: () => null }));
vi.mock("./find-bar", () => ({ FindBar: () => null }));
vi.mock("./command-palette", () => ({ CommandPalette: () => null }));
vi.mock("./toolbar", () => ({ Toolbar: () => null }));
vi.mock("./code-pane", () => ({ CodePane: () => null }));
vi.mock("./status-bar", () => ({ StatusBar: () => null }));
vi.mock("./outline", () => ({ OutlinePanel: () => null }));
vi.mock("./selection-bubble", () => ({ SelectionBubble: () => null }));
vi.mock("./table-menu", () => ({ TableMenu: () => null }));
vi.mock("./slash-menu", () => ({ SlashMenu: () => null, useSlashMenuController: () => ({ handlers: undefined }) }));
vi.mock("./hint-bar", () => ({ HintBar: () => null }));
vi.mock("./follow-banner", () => ({ FollowBanner: () => null }));
vi.mock("./scroll-sync", () => ({ useScrollSync: () => {} }));
vi.mock("./panel-resize-handle", async (importOriginal) => ({
  ...await importOriginal<typeof import("./panel-resize-handle")>(),
  PanelResizeHandle: () => null,
}));
vi.mock("./agent-requests", () => ({
  claimerName: () => "Agent",
  describeResult: () => "done",
  useAgentRequests: () => [],
  useAgentRequestsDone: () => {},
}));

import { ApiError, api, type VersionSummary } from "@/lib/api";
import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import type { DocumentDto } from "@/server/dto";
import type { EditorUser } from "./use-session";
import { EditorShell } from "./editor-shell";

type HeaderProps = ComponentProps<typeof import("./header").Header>;
type CreateVersionResponse = Awaited<ReturnType<typeof api.documents.createVersion>>;

const USER: EditorUser = { id: "owner-1", name: "Owner One", login: "owner-one", image: null };
const DOC: DocumentDto = {
  id: "doc-1",
  title: "First document",
  storage: "local",
  linkAccess: "private",
  linkPreview: false,
  ownerId: USER.id,
  gistId: null,
  gistFile: null,
  repoOwner: null,
  repoName: null,
  repoBranch: null,
  repoPath: null,
  publishedAt: null,
  hasUnpublishedChanges: false,
  githubUrl: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

let session: CollabSession;
let sessions: CollabSession[] = [];
let headerProps: HeaderProps;
let versionsRefresh: number | null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createSession() {
  const created = new CollabSession({
    docId: DOC.id,
    user: makeCollabUser(USER.id, USER.name, USER.image, USER.login),
    role: "owner",
    autoConnect: false,
    getToken: async () => { throw new Error("No provider connection permitted"); },
  });
  created.keepAlive();
  created.localLoaded = true;
  created.ytext.insert(0, "Document text");
  sessions.push(created);
  return created;
}

function versionResponse(title: string): CreateVersionResponse {
  const version: VersionSummary = {
    id: `version-${title}`,
    number: 1,
    title,
    kind: "named",
    createdBy: USER.id,
    createdByName: USER.name,
    commitSha: null,
    createdAt: "2026-09-07T00:00:00.000Z",
    size: 13,
  };
  return { version };
}

function shell() {
  return <EditorShell doc={DOC} role="owner" user={USER} githubAvailable githubConfigured />;
}

async function mount() {
  const view = render(shell());
  await waitFor(() => expect(headerProps.doc.id).toBe(DOC.id));
  fireEvent.click(screen.getByTestId("header-history"));
  await screen.findByTestId("versions-panel-mock");
  return view;
}

async function openNameVersion() {
  fireEvent.click(screen.getByTestId("header-name-version"));
  return screen.findByTestId("version-name");
}

function form() {
  return screen.getByTestId("version-name-submit").closest("form")!;
}

function submitImmediatelyTwice() {
  const first = new Event("submit", { bubbles: true, cancelable: true });
  const second = new Event("submit", { bubbles: true, cancelable: true });
  act(() => {
    form().dispatchEvent(first);
    form().dispatchEvent(second);
  });
}

beforeEach(() => {
  versionsRefresh = null;
  headerProps = undefined!;
  sessions = [];
  session = createSession();
  vi.mocked(api.documents.createVersion).mockReset();
});

afterEach(() => {
  cleanup();
  for (const item of sessions) item.destroy();
  vi.restoreAllMocks();
});

describe("EditorShell named-version ownership", () => {
  it("creates one physical version from two immediate submits and applies one exact current success", async () => {
    const pending = deferred<CreateVersionResponse>();
    vi.mocked(api.documents.createVersion).mockReturnValue(pending.promise);
    await mount();
    const input = await openNameVersion();

    fireEvent.change(input, { target: { value: "  Stable title  " } });
    submitImmediatelyTwice();
    fireEvent.change(input, { target: { value: "Forced replacement" } });
    fireEvent.submit(form());

    expect(api.documents.createVersion).toHaveBeenCalledExactlyOnceWith(DOC.id, "Stable title");
    expect(input).toHaveValue("  Stable title  ");
    expect(input).toBeDisabled();
    expect(screen.getByTestId("version-name-submit")).toBeDisabled();
    expect(versionsRefresh).toBe(0);
    expect(screen.queryByTestId("toast")).toBeNull();

    await act(async () => pending.resolve(versionResponse("Stable title")));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(versionsRefresh).toBe(1);
    expect(screen.getAllByTestId("toast")).toHaveLength(1);
    expect(screen.getByTestId("toast")).toHaveTextContent("Saved version “Stable title”.");
  });

  it("keeps a current API failure inline and admits exactly one retry with the preserved title", async () => {
    const failed = deferred<CreateVersionResponse>();
    const retry = deferred<CreateVersionResponse>();
    vi.mocked(api.documents.createVersion).mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    await mount();
    await openNameVersion();

    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Retry title" } });
    fireEvent.submit(form());
    await act(async () => failed.reject(new ApiError(409, "Conflict", [{ message: "That version name is already in use" }])));

    expect(screen.getByRole("alert")).toHaveTextContent("That version name is already in use");
    expect(screen.getByTestId("version-name")).toHaveValue("Retry title");
    expect(screen.getByTestId("version-name")).toBeEnabled();
    expect(screen.getByTestId("version-name-submit")).toBeEnabled();
    expect(versionsRefresh).toBe(0);
    expect(screen.queryByTestId("toast")).toBeNull();

    submitImmediatelyTwice();
    expect(api.documents.createVersion).toHaveBeenCalledTimes(2);
    expect(api.documents.createVersion).toHaveBeenNthCalledWith(2, DOC.id, "Retry title");
    await act(async () => retry.resolve(versionResponse("Retry title")));
    expect(versionsRefresh).toBe(1);
    expect(screen.getAllByTestId("toast")).toHaveLength(1);
  });

  it("gives post-Cancel success and post-Dialog-close failure no shell effects", async () => {
    const closedSuccess = deferred<CreateVersionResponse>();
    const closedFailure = deferred<CreateVersionResponse>();
    const current = deferred<CreateVersionResponse>();
    vi.mocked(api.documents.createVersion)
      .mockReturnValueOnce(closedSuccess.promise)
      .mockReturnValueOnce(closedFailure.promise)
      .mockReturnValueOnce(current.promise);
    await mount();
    await openNameVersion();

    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Cancelled save" } });
    fireEvent.submit(form());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => closedSuccess.resolve(versionResponse("Cancelled save")));
    expect(versionsRefresh).toBe(0);
    expect(screen.queryByTestId("toast")).toBeNull();

    await openNameVersion();
    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Closed save" } });
    fireEvent.submit(form());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => {
      closedFailure.reject(new Error("Closed failure"));
      await closedFailure.promise.catch(() => undefined);
    });
    expect(versionsRefresh).toBe(0);
    expect(screen.queryByTestId("toast")).toBeNull();

    await openNameVersion();
    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Current save" } });
    fireEvent.submit(form());
    await act(async () => current.resolve(versionResponse("Current save")));
    expect(api.documents.createVersion).toHaveBeenNthCalledWith(3, DOC.id, "Current save");
    expect(versionsRefresh).toBe(1);
    expect(screen.getAllByTestId("toast")).toHaveLength(1);
  });

  it("remounts for same-user session replacements and ignores old work settled out of order", async () => {
    const oldest = deferred<CreateVersionResponse>();
    const middle = deferred<CreateVersionResponse>();
    const current = deferred<CreateVersionResponse>();
    vi.mocked(api.documents.createVersion)
      .mockReturnValueOnce(oldest.promise)
      .mockReturnValueOnce(middle.promise)
      .mockReturnValueOnce(current.promise);
    const view = await mount();
    await openNameVersion();

    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Old session" } });
    fireEvent.submit(form());
    session = createSession();
    view.rerender(shell());
    await waitFor(() => {
      expect(screen.getByTestId("version-name")).toHaveValue("");
      expect(screen.getByTestId("version-name")).toBeEnabled();
    });
    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Middle session" } });
    fireEvent.submit(form());

    await act(async () => oldest.resolve(versionResponse("Old session")));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("version-name")).toHaveValue("Middle session");
    expect(screen.getByTestId("version-name")).toBeDisabled();
    expect(versionsRefresh).toBe(0);
    expect(screen.queryByTestId("toast")).toBeNull();

    session = createSession();
    view.rerender(shell());
    await waitFor(() => {
      expect(screen.getByTestId("version-name")).toHaveValue("");
      expect(screen.getByTestId("version-name")).toBeEnabled();
    });
    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Current session" } });
    fireEvent.submit(form());

    await act(async () => {
      middle.reject(new ApiError(503, "Obsolete failure"));
      await middle.promise.catch(() => undefined);
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("version-name")).toHaveValue("Current session");
    expect(screen.getByTestId("version-name")).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(versionsRefresh).toBe(0);
    expect(screen.queryByTestId("toast")).toBeNull();

    await act(async () => current.resolve(versionResponse("Current session")));
    expect(api.documents.createVersion).toHaveBeenCalledTimes(3);
    expect(api.documents.createVersion).toHaveBeenNthCalledWith(1, DOC.id, "Old session");
    expect(api.documents.createVersion).toHaveBeenNthCalledWith(2, DOC.id, "Middle session");
    expect(api.documents.createVersion).toHaveBeenNthCalledWith(3, DOC.id, "Current session");
    expect(versionsRefresh).toBe(1);
    expect(screen.getAllByTestId("toast")).toHaveLength(1);
    expect(screen.getByTestId("toast")).toHaveTextContent("Saved version “Current session”.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("retires shell ownership on unmount and consumes late success and rejection without effects", async () => {
    const lateSuccess = deferred<CreateVersionResponse>();
    const lateFailure = deferred<CreateVersionResponse>();
    vi.mocked(api.documents.createVersion).mockReturnValueOnce(lateSuccess.promise).mockReturnValueOnce(lateFailure.promise);
    const unhandled = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener("unhandledrejection", unhandled);

    const successView = await mount();
    await openNameVersion();
    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Late success" } });
    fireEvent.submit(form());
    successView.unmount();
    await act(async () => lateSuccess.resolve(versionResponse("Late success")));

    session = createSession();
    const failureView = await mount();
    await openNameVersion();
    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Late failure" } });
    fireEvent.submit(form());
    failureView.unmount();
    await act(async () => {
      lateFailure.reject(new Error("Late failure"));
      await lateFailure.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(api.documents.createVersion).toHaveBeenCalledTimes(2);
    expect(versionsRefresh).toBe(0);
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});
