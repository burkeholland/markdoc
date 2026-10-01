// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import * as Y from "yjs";

const routerPush = vi.hoisted(() => vi.fn());

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
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));
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
        delete: vi.fn(),
        duplicate: vi.fn(),
      },
    },
  };
});
vi.mock("@/lib/notice", () => ({
  setPendingNotice: vi.fn(),
  takePendingNotice: vi.fn(),
}));
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
    const pending = props.documentMutation !== null;
    return (
      <div>
        <div data-testid="header-state" data-document={props.doc.id} data-mutation={props.documentMutation ?? "none"} />
        <button
          type="button"
          data-testid="header-duplicate"
          disabled={pending}
          aria-busy={props.documentMutation === "duplicate" || undefined}
          onClick={props.onDuplicate}
        >
          Duplicate
        </button>
        <button
          type="button"
          data-testid="header-delete"
          disabled={pending}
          aria-busy={props.documentMutation === "delete" || undefined}
          onClick={props.onDelete}
        >
          Delete
        </button>
      </div>
    );
  },
}));
vi.mock("./versions-panel", () => ({ VersionDiffView: () => null, VersionsPanel: () => null }));
vi.mock("./dialogs", () => ({
  LinkDialog: () => null,
  ImageDialog: () => null,
  TableDialog: () => null,
  NameVersionDialog: () => null,
  ShortcutsDialog: () => null,
}));
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

import { api } from "@/lib/api";
import { setPendingNotice, takePendingNotice } from "@/lib/notice";
import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import type { DocumentDto } from "@/server/dto";
import type { EditorUser } from "./use-session";
import { EditorShell } from "./editor-shell";

type HeaderProps = ComponentProps<typeof import("./header").Header>;
type DeleteResponse = Awaited<ReturnType<typeof api.documents.delete>>;
type DuplicateResponse = Awaited<ReturnType<typeof api.documents.duplicate>>;

const USER: EditorUser = { id: "owner-1", name: "Owner One", login: "owner-one", image: null };
const DOC: DocumentDto = {
  id: "doc-1",
  title: "Frozen source",
  storage: "repo",
  linkAccess: "private",
  linkPreview: false,
  ownerId: USER.id,
  gistId: null,
  gistFile: null,
  repoOwner: "owner",
  repoName: "repo",
  repoBranch: "main",
  repoPath: "source.md",
  publishedAt: "2026-09-01T00:00:00.000Z",
  hasUnpublishedChanges: false,
  githubUrl: "https://github.com/owner/repo/blob/main/source.md",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

let session: CollabSession;
let sessions: CollabSession[] = [];
let headerProps: HeaderProps;

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
  vi.spyOn(created, "clearLocal").mockResolvedValue();
  sessions.push(created);
  return created;
}

function shell() {
  return <EditorShell doc={DOC} role="owner" user={USER} githubAvailable githubConfigured />;
}

async function mount() {
  const view = render(shell());
  await waitFor(() => expect(headerProps.doc.id).toBe(DOC.id));
  return view;
}

function activate(...actions: Array<() => void>) {
  act(() => {
    for (const action of actions) action();
  });
}

async function resolve<T>(pending: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => {
    pending.resolve(value);
    await pending.promise;
    await Promise.resolve();
  });
}

async function reject<T>(pending: ReturnType<typeof deferred<T>>, reason: unknown) {
  await act(async () => {
    pending.reject(reason);
    await pending.promise.catch(() => undefined);
    await Promise.resolve();
  });
}

function expectMutation(action: "delete" | "duplicate" | null) {
  const duplicate = screen.getByTestId("header-duplicate");
  const remove = screen.getByTestId("header-delete");
  expect(screen.getByTestId("header-state")).toHaveAttribute("data-mutation", action ?? "none");
  if (action) {
    expect(duplicate).toBeDisabled();
    expect(remove).toBeDisabled();
  } else {
    expect(duplicate).toBeEnabled();
    expect(remove).toBeEnabled();
  }
  if (action === "duplicate") expect(duplicate).toHaveAttribute("aria-busy", "true");
  else expect(duplicate).not.toHaveAttribute("aria-busy");
  if (action === "delete") expect(remove).toHaveAttribute("aria-busy", "true");
  else expect(remove).not.toHaveAttribute("aria-busy");
}

const deleted = (): DeleteResponse => ({ ok: true, permanent: false });
const duplicated = (id: string, title: string): DuplicateResponse => ({ id, title });

beforeEach(() => {
  headerProps = undefined!;
  sessions = [];
  session = createSession();
  routerPush.mockReset();
  vi.mocked(api.documents.delete).mockReset();
  vi.mocked(api.documents.duplicate).mockReset();
  vi.mocked(setPendingNotice).mockReset();
  vi.mocked(takePendingNotice).mockReset().mockReturnValue(null);
  vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(() => {
  cleanup();
  for (const item of sessions) item.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("EditorShell document mutation ownership", () => {
  it("admits one rapid duplicate across duplicate and mixed activation, then publishes its frozen-source success", async () => {
    const pending = deferred<DuplicateResponse>();
    vi.mocked(api.documents.duplicate).mockReturnValue(pending.promise);
    await mount();

    activate(headerProps.onDuplicate, headerProps.onDuplicate, headerProps.onDelete);

    expect(api.documents.duplicate).toHaveBeenCalledExactlyOnceWith(DOC.id);
    expect(api.documents.delete).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expectMutation("duplicate");
    expect(setPendingNotice).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();

    await resolve(pending, duplicated("copy-1", "Copy of Frozen source"));

    expectMutation(null);
    expect(setPendingNotice).toHaveBeenCalledExactlyOnceWith(
      "Created “Copy of Frozen source” as a Markdoc document. The copy is not connected to GitHub.",
      "success",
    );
    expect(routerPush).toHaveBeenCalledExactlyOnceWith("/d/copy-1");
    expect(session.clearLocal).not.toHaveBeenCalled();
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("claims nothing when trash confirmation is declined", async () => {
    const pending = deferred<DuplicateResponse>();
    vi.mocked(confirm).mockReturnValueOnce(false);
    vi.mocked(api.documents.duplicate).mockReturnValue(pending.promise);
    await mount();

    activate(headerProps.onDelete);

    expect(confirm).toHaveBeenCalledExactlyOnceWith("Move “Frozen source” to trash? You can restore it from the dashboard for 30 days.");
    expect(api.documents.delete).not.toHaveBeenCalled();
    expectMutation(null);

    activate(headerProps.onDuplicate);
    expect(api.documents.duplicate).toHaveBeenCalledExactlyOnceWith(DOC.id);
    expectMutation("duplicate");
    await resolve(pending, duplicated("copy-after-decline", "Copy after decline"));
  });

  it("keeps both actions pending through Delete API success and local cleanup, then navigates once", async () => {
    const request = deferred<DeleteResponse>();
    const clear = deferred<void>();
    vi.mocked(api.documents.delete).mockReturnValue(request.promise);
    vi.mocked(session.clearLocal).mockReturnValue(clear.promise);
    await mount();

    activate(headerProps.onDelete, headerProps.onDuplicate, headerProps.onDelete);

    expect(api.documents.delete).toHaveBeenCalledExactlyOnceWith(DOC.id);
    expect(api.documents.duplicate).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    expectMutation("delete");

    await resolve(request, deleted());

    expect(setPendingNotice).toHaveBeenCalledExactlyOnceWith("“Frozen source” was moved to the trash.", "success");
    expect(session.clearLocal).toHaveBeenCalledTimes(1);
    expect(routerPush).not.toHaveBeenCalled();
    expectMutation("delete");
    activate(headerProps.onDuplicate);
    expect(api.documents.duplicate).not.toHaveBeenCalled();

    await resolve(clear, undefined);

    expect(routerPush).toHaveBeenCalledExactlyOnceWith("/");
    expectMutation(null);
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("releases a current Delete failure for one deliberate retry without admitting rapid repeats", async () => {
    const failed = deferred<DeleteResponse>();
    const retry = deferred<DeleteResponse>();
    vi.mocked(api.documents.delete).mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    await mount();

    activate(headerProps.onDelete);
    await reject(failed, null);

    expectMutation(null);
    expect(screen.getByTestId("toast")).toHaveTextContent("Could not move to trash");
    expect(setPendingNotice).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();

    activate(headerProps.onDelete, headerProps.onDelete, headerProps.onDuplicate);
    expect(api.documents.delete).toHaveBeenCalledTimes(2);
    expect(api.documents.duplicate).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(2);
    expectMutation("delete");

    await resolve(retry, deleted());

    expect(session.clearLocal).toHaveBeenCalledTimes(1);
    expect(setPendingNotice).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledExactlyOnceWith("/");
    expect(screen.getAllByTestId("toast")).toHaveLength(1);
    expectMutation(null);
  });

  it("releases a current Duplicate failure for one deliberate retry and one exact success", async () => {
    const failed = deferred<DuplicateResponse>();
    const retry = deferred<DuplicateResponse>();
    vi.mocked(api.documents.duplicate).mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    await mount();

    activate(headerProps.onDuplicate);
    await reject(failed, null);

    expectMutation(null);
    expect(screen.getByTestId("toast")).toHaveTextContent("Could not make a copy");
    expect(setPendingNotice).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();

    activate(headerProps.onDuplicate, headerProps.onDuplicate, headerProps.onDelete);
    expect(api.documents.duplicate).toHaveBeenCalledTimes(2);
    expect(api.documents.delete).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expectMutation("duplicate");

    await resolve(retry, duplicated("copy-retry", "Retry copy"));

    expect(setPendingNotice).toHaveBeenCalledExactlyOnceWith(
      "Created “Retry copy” as a Markdoc document. The copy is not connected to GitHub.",
      "success",
    );
    expect(routerPush).toHaveBeenCalledExactlyOnceWith("/d/copy-retry");
    expect(screen.getAllByTestId("toast")).toHaveLength(1);
    expectMutation(null);
  });

  it("retires same-document session work synchronously and cannot let old settlements unlock the replacement", async () => {
    const staleDuplicate = deferred<DuplicateResponse>();
    const currentDelete = deferred<DeleteResponse>();
    const staleClear = deferred<void>();
    const currentDuplicate = deferred<DuplicateResponse>();
    vi.mocked(api.documents.duplicate)
      .mockReturnValueOnce(staleDuplicate.promise)
      .mockReturnValueOnce(currentDuplicate.promise);
    vi.mocked(api.documents.delete).mockReturnValue(currentDelete.promise);
    const firstSession = session;
    const view = await mount();

    activate(headerProps.onDuplicate);
    expectMutation("duplicate");

    session = createSession();
    vi.mocked(session.clearLocal).mockReturnValue(staleClear.promise);
    view.rerender(shell());
    await waitFor(() => expectMutation(null));
    activate(headerProps.onDelete);
    await resolve(currentDelete, deleted());
    expectMutation("delete");
    expect(setPendingNotice).toHaveBeenCalledExactlyOnceWith("“Frozen source” was moved to the trash.", "success");
    expect(routerPush).not.toHaveBeenCalled();

    await resolve(staleDuplicate, duplicated("stale-copy", "Stale copy"));
    expectMutation("delete");
    expect(setPendingNotice).toHaveBeenCalledTimes(1);
    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(firstSession.clearLocal).not.toHaveBeenCalled();

    const secondSession = session;
    session = createSession();
    view.rerender(shell());
    await waitFor(() => expectMutation(null));
    activate(headerProps.onDuplicate);
    expectMutation("duplicate");

    await resolve(staleClear, undefined);
    expectMutation("duplicate");
    expect(routerPush).not.toHaveBeenCalled();
    expect(secondSession.clearLocal).toHaveBeenCalledTimes(1);

    await resolve(currentDuplicate, duplicated("current-copy", "Current copy"));

    expect(api.documents.duplicate).toHaveBeenCalledTimes(2);
    expect(api.documents.delete).toHaveBeenCalledTimes(1);
    expect(setPendingNotice).toHaveBeenCalledTimes(2);
    expect(setPendingNotice).toHaveBeenLastCalledWith(
      "Created “Current copy” as a Markdoc document. The copy is not connected to GitHub.",
      "success",
    );
    expect(routerPush).toHaveBeenCalledExactlyOnceWith("/d/current-copy");
    expect(session.clearLocal).not.toHaveBeenCalled();
    expectMutation(null);
  });

  it("retires ownership on unmount and consumes late success and failure without effects", async () => {
    const lateSuccess = deferred<DuplicateResponse>();
    const lateFailure = deferred<DeleteResponse>();
    vi.mocked(api.documents.duplicate).mockReturnValue(lateSuccess.promise);
    vi.mocked(api.documents.delete).mockReturnValue(lateFailure.promise);
    const unhandled = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener("unhandledrejection", unhandled);

    const successView = await mount();
    const successSession = session;
    activate(headerProps.onDuplicate);
    successView.unmount();
    await resolve(lateSuccess, duplicated("late-copy", "Late copy"));

    session = createSession();
    const failureView = await mount();
    const failureSession = session;
    activate(headerProps.onDelete);
    failureView.unmount();
    await reject(lateFailure, null);

    expect(api.documents.duplicate).toHaveBeenCalledTimes(1);
    expect(api.documents.delete).toHaveBeenCalledTimes(1);
    expect(setPendingNotice).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(successSession.clearLocal).not.toHaveBeenCalled();
    expect(failureSession.clearLocal).not.toHaveBeenCalled();
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});
