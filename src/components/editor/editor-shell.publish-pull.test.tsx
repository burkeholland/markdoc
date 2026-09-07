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
        publish: vi.fn(),
        pull: vi.fn(),
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
  useSyncPolling: (props: Parameters<typeof import("./use-sync-polling").useSyncPolling>[0]) => {
    syncPollingProps = props;
  },
}));
vi.mock("./header", () => ({
  Header: (props: ComponentProps<typeof import("./header").Header>) => {
    headerProps = props;
    return (
      <div>
        <div data-testid="header-state" data-document={props.doc.id} data-publishing={String(props.publishing)}>{props.doc.title}</div>
        <button type="button" data-testid="header-publish" onClick={props.onPublishNow}>Publish</button>
        <button type="button" data-testid="header-pull" onClick={props.onPull}>Pull</button>
        <button type="button" data-testid="header-sync" onClick={props.onSync}>Sync</button>
        <button type="button" data-testid="header-history" onClick={props.onHistory}>History</button>
      </div>
    );
  },
}));
vi.mock("./github-dialog", () => ({
  GitHubDialog: () => null,
  CommitDialog: (props: ComponentProps<typeof import("./github-dialog").CommitDialog>) => {
    commitProps = props;
    return <div data-testid="commit-dialog" data-open={String(props.open)} data-document={props.doc.id} />;
  },
}));
vi.mock("./sync-dialog", () => ({
  SyncDialog: (props: ComponentProps<typeof import("./sync-dialog").SyncDialog>) => {
    syncDialogProps = props;
    return <div data-testid="sync-dialog-mock" data-open={String(props.open)} data-document={props.doc.id} data-status={props.sync?.status ?? "none"} />;
  },
}));
vi.mock("./versions-panel", () => ({
  VersionDiffView: () => null,
  VersionsPanel: (props: ComponentProps<typeof import("./versions-panel").VersionsPanel>) => {
    versionsRefresh = props.refreshKey;
    return <div data-testid="versions-panel-mock" data-refresh={props.refreshKey} />;
  },
}));
vi.mock("./activity-panel", () => ({ ActivityPanel: () => null }));
vi.mock("./comments-panel", () => ({ CommentsPanel: () => null }));
vi.mock("./share-dialog", () => ({ ShareDialog: () => null }));
vi.mock("./dialogs", () => ({
  LinkDialog: () => null,
  ImageDialog: () => null,
  TableDialog: () => null,
  NameVersionDialog: () => null,
  ShortcutsDialog: () => null,
}));
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

import { ApiError, api, type SyncStatusDto } from "@/lib/api";
import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import type { DocumentDto } from "@/server/dto";
import type { EditorUser } from "./use-session";
import { EditorShell } from "./editor-shell";

type HeaderProps = ComponentProps<typeof import("./header").Header>;
type CommitProps = ComponentProps<typeof import("./github-dialog").CommitDialog>;
type SyncDialogProps = ComponentProps<typeof import("./sync-dialog").SyncDialog>;
type SyncPollingProps = Parameters<typeof import("./use-sync-polling").useSyncPolling>[0];
type PublishResponse = Awaited<ReturnType<typeof api.documents.publish>>;
type PullResponse = Awaited<ReturnType<typeof api.documents.pull>>;

const USER: EditorUser = { id: "owner-1", name: "Owner One", login: "owner-one", image: null };
const SECOND_USER: EditorUser = { id: "owner-2", name: "Owner Two", login: "owner-two", image: null };
const DOC: DocumentDto = {
  id: "doc-1",
  title: "First document",
  storage: "repo",
  linkAccess: "private",
  ownerId: USER.id,
  gistId: null,
  gistFile: null,
  repoOwner: "owner",
  repoName: "repo",
  repoBranch: "main",
  repoPath: "first.md",
  publishedAt: "2026-09-01T00:00:00.000Z",
  hasUnpublishedChanges: true,
  githubUrl: "https://github.com/owner/repo/blob/main/first.md",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};
const SECOND_DOC: DocumentDto = {
  ...DOC,
  id: "doc-2",
  title: "Second document",
  ownerId: SECOND_USER.id,
  repoPath: "second.md",
  githubUrl: "https://github.com/owner/repo/blob/main/second.md",
};
const GIST_DOC: DocumentDto = {
  ...DOC,
  id: "gist-1",
  title: "Gist document",
  storage: "gist",
  gistId: "gist-id",
  gistFile: "gist.md",
  repoOwner: null,
  repoName: null,
  repoBranch: null,
  repoPath: null,
  githubUrl: "https://gist.github.com/owner/gist-id",
};
const REMOTE = { sha: "abc1234", revision: "abc1234", url: DOC.githubUrl!, updatedAt: null };
const DIVERGED: Partial<SyncStatusDto> = {
  status: "diverged",
  remote: REMOTE,
  localChanged: true,
  remoteChanged: true,
  lines: { local: 2, remote: 3 },
};

let session: CollabSession;
let sessions: CollabSession[] = [];
let headerProps: HeaderProps;
let commitProps: CommitProps;
let syncDialogProps: SyncDialogProps;
let syncPollingProps: SyncPollingProps;
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

function createSession(doc: DocumentDto, user: EditorUser = USER) {
  const created = new CollabSession({
    docId: doc.id,
    user: makeCollabUser(user.id, user.name, user.image, user.login),
    role: "owner",
    autoConnect: false,
    getToken: async () => { throw new Error("No provider connection permitted"); },
  });
  created.keepAlive();
  created.localLoaded = true;
  created.ytext.insert(0, `Text for ${doc.id}`);
  sessions.push(created);
  return created;
}

function publishResponse(document: DocumentDto | null = null, skipped = false): PublishResponse {
  return {
    document,
    result: {
      url: "https://github.com/owner/repo/commit/abc1234",
      commitSha: "abc1234",
      publishedAt: "2026-09-07T00:00:00.000Z",
      skipped,
      status: "in-sync",
    },
  };
}

function pullResponse(document: DocumentDto | null = null, options: { changed?: boolean; merged?: boolean } = {}): PullResponse {
  return {
    document,
    result: {
      changed: options.changed ?? true,
      merged: options.merged,
      url: document?.githubUrl ?? DOC.githubUrl,
      status: "in-sync",
    },
  };
}

function shell(doc: DocumentDto = DOC, user: EditorUser = USER) {
  return <EditorShell doc={doc} role="owner" user={user} githubAvailable githubConfigured />;
}

async function mount(doc: DocumentDto = DOC, user: EditorUser = USER) {
  const view = render(shell(doc, user));
  await waitFor(() => expect(headerProps.doc.id).toBe(doc.id));
  fireEvent.click(screen.getByTestId("header-history"));
  await screen.findByTestId("versions-panel-mock");
  return view;
}

async function openCommit() {
  fireEvent.click(screen.getByTestId("header-publish"));
  await waitFor(() => expect(commitProps.open).toBe(true));
}

async function openSync() {
  fireEvent.click(screen.getByTestId("header-sync"));
  await waitFor(() => expect(syncDialogProps.open).toBe(true));
}

function expectPending(pending: boolean) {
  expect(screen.getByTestId("header-state")).toHaveAttribute("data-publishing", String(pending));
}

function start<T>(operation: () => Promise<T>) {
  let pending!: Promise<T>;
  act(() => {
    pending = operation();
  });
  return pending;
}

beforeEach(() => {
  versionsRefresh = null;
  headerProps = undefined!;
  commitProps = undefined!;
  syncDialogProps = undefined!;
  syncPollingProps = undefined!;
  sessions = [];
  session = createSession(DOC);
  vi.mocked(api.documents.publish).mockReset();
  vi.mocked(api.documents.pull).mockReset();
});

afterEach(() => {
  cleanup();
  for (const item of sessions) item.destroy();
  vi.restoreAllMocks();
});

describe("EditorShell publish and pull ownership", () => {
  it("admits one immediate Publish and gives only its current success the document, ticks, link, notice, and finalizer", async () => {
    const request = deferred<PublishResponse>();
    vi.mocked(api.documents.publish).mockReturnValue(request.promise);
    await mount();
    await openCommit();

    let accepted!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      accepted = commitProps.onCommit("Ship this");
      duplicate = commitProps.onCommit("Duplicate");
    });

    await expect(duplicate).rejects.toThrow("Another publish or pull is already in progress.");
    expect(api.documents.publish).toHaveBeenCalledExactlyOnceWith(DOC.id, "Ship this", { force: false });
    expectPending(true);
    expect(versionsRefresh).toBe(0);
    expect(syncPollingProps.refreshKey).toBe(0);

    const updated = { ...DOC, title: "Published document", hasUnpublishedChanges: false };
    await act(async () => {
      request.resolve(publishResponse(updated));
      await accepted;
    });

    expectPending(false);
    expect(headerProps.doc).toEqual(updated);
    expect(versionsRefresh).toBe(1);
    expect(syncPollingProps.refreshKey).toBe(1);
    expect(screen.getByTestId("toast")).toHaveTextContent("Committed to GitHub.");
    expect(screen.getByRole("link", { name: "View" })).toHaveAttribute("href", "https://github.com/owner/repo/commit/abc1234");
  });

  it("admits one immediate Pull and blocks mixed Publish/Pull activation in both directions", async () => {
    const firstPull = deferred<PullResponse>();
    vi.mocked(api.documents.pull).mockReturnValueOnce(firstPull.promise);
    await mount();
    await openCommit();

    act(() => {
      headerProps.onPull();
      headerProps.onPull();
    });
    const blockedPublish = start(() => commitProps.onCommit("Blocked by pull"));
    await expect(blockedPublish).rejects.toThrow("Another publish or pull is already in progress.");
    expect(api.documents.pull).toHaveBeenCalledExactlyOnceWith(DOC.id, {});
    expect(api.documents.publish).not.toHaveBeenCalled();
    expectPending(true);

    await act(async () => {
      firstPull.resolve(pullResponse(null, { changed: false }));
      await firstPull.promise;
    });
    expectPending(false);
    expect(screen.getByTestId("toast")).toHaveTextContent("Already up to date.");

    const publish = deferred<PublishResponse>();
    vi.mocked(api.documents.publish).mockReturnValueOnce(publish.promise);
    const acceptedPublish = start(() => commitProps.onCommit("Current publish"));
    act(() => {
      headerProps.onPull();
      headerProps.onPull();
    });
    expect(api.documents.publish).toHaveBeenCalledTimes(1);
    expect(api.documents.pull).toHaveBeenCalledTimes(1);
    expectPending(true);

    await act(async () => {
      publish.resolve(publishResponse());
      await acceptedPublish;
    });
    expectPending(false);
  });

  it("shares ownership with force Publish, force Pull, and merge Pull from Sync", async () => {
    await mount();
    await openSync();

    const forcePublish = deferred<PublishResponse>();
    vi.mocked(api.documents.publish).mockReturnValueOnce(forcePublish.promise);
    const keep = start(() => syncDialogProps.actions.keepMine("Keep mine"));
    expect(api.documents.publish).toHaveBeenCalledExactlyOnceWith(DOC.id, "Keep mine", { force: true });
    expectPending(true);
    await act(async () => {
      forcePublish.resolve(publishResponse());
      await keep;
    });

    const forcePull = deferred<PullResponse>();
    vi.mocked(api.documents.pull).mockReturnValueOnce(forcePull.promise);
    const take = start(() => syncDialogProps.actions.takeRemote());
    expect(api.documents.pull).toHaveBeenLastCalledWith(DOC.id, { force: true });
    expectPending(true);
    await act(async () => {
      forcePull.resolve(pullResponse());
      await take;
    });

    const mergePull = deferred<PullResponse>();
    vi.mocked(api.documents.pull).mockReturnValueOnce(mergePull.promise);
    const merge = start(() => syncDialogProps.actions.merge());
    expect(api.documents.pull).toHaveBeenLastCalledWith(DOC.id, { merge: true });
    expectPending(true);
    await act(async () => {
      mergePull.resolve(pullResponse(null, { merged: true }));
      await expect(merge).resolves.toBe(0);
    });

    expectPending(false);
    expect(api.documents.publish).toHaveBeenCalledTimes(1);
    expect(api.documents.pull).toHaveBeenCalledTimes(2);
    expect(versionsRefresh).toBe(3);
    expect(syncPollingProps.refreshKey).toBe(3);
    expect(screen.getAllByTestId("toast").at(-1)).toHaveTextContent("Merged GitHub’s changes — review, then publish.");
  });

  it("keeps current ordinary failures rejected, visible, effect-free, and retryable", async () => {
    const failure = new ApiError(502, "GitHub unavailable");
    vi.mocked(api.documents.pull).mockRejectedValueOnce(failure);
    await mount();

    act(() => headerProps.onPull());
    await waitFor(() => expectPending(false));
    expect(screen.getByTestId("toast")).toHaveTextContent("GitHub unavailable");
    expect(versionsRefresh).toBe(0);
    expect(syncPollingProps.refreshKey).toBe(0);

    vi.mocked(api.documents.pull).mockResolvedValueOnce(pullResponse());
    act(() => headerProps.onPull());
    await waitFor(() => expect(api.documents.pull).toHaveBeenCalledTimes(2));
    await waitFor(() => expectPending(false));
    expect(versionsRefresh).toBe(1);
  });

  it("routes a current Publish 409 to Sync and closes Commit without a generic failure notice", async () => {
    const conflict = new ApiError(409, "GitHub moved", undefined, DIVERGED);
    vi.mocked(api.documents.publish).mockRejectedValueOnce(conflict);
    await mount();
    await openCommit();

    await act(async () => {
      await expect(commitProps.onCommit("Diverged")).rejects.toBe(conflict);
    });
    await waitFor(() => expect(syncDialogProps.open).toBe(true));

    expect(commitProps.open).toBe(false);
    expect(syncDialogProps.sync?.status).toBe("diverged");
    expect(screen.queryByTestId("toast")).toBeNull();
    expectPending(false);
    expect(versionsRefresh).toBe(0);
    expect(syncPollingProps.refreshKey).toBe(0);
  });

  it("opens Sync for a current non-conflict Pull 409 and leaves a plain conflict to its caller", async () => {
    const divergence = new ApiError(409, "Local edits would be lost", undefined, DIVERGED);
    vi.mocked(api.documents.pull).mockRejectedValueOnce(divergence);
    await mount();

    act(() => headerProps.onPull());
    await waitFor(() => expect(syncDialogProps.open).toBe(true));
    expect(syncDialogProps.sync?.status).toBe("diverged");
    expect(screen.queryByTestId("toast")).toBeNull();
    expectPending(false);

    act(() => syncDialogProps.onOpenChange(false));
    await waitFor(() => expect(syncDialogProps.open).toBe(false));
    const plainConflict = new ApiError(409, "Merge conflict", undefined, { ...DIVERGED, status: "conflict", merged: "<<<<<<< local\n=======\n>>>>>>> remote", conflicts: 1 });
    vi.mocked(api.documents.pull).mockRejectedValueOnce(plainConflict);
    act(() => headerProps.onPull());
    await waitFor(() => expect(api.documents.pull).toHaveBeenCalledTimes(2));
    await waitFor(() => expectPending(false));
    expect(syncDialogProps.open).toBe(false);
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(session.ytext.toString()).not.toContain("<<<<<<<");
  });

  it("applies a current merge conflict to the current session and returns its exact count", async () => {
    const marked = "<<<<<<< local\nMine\n=======\nTheirs\n>>>>>>> remote";
    const conflict = new ApiError(409, "Resolve conflicts", undefined, { ...DIVERGED, status: "conflict", merged: marked, conflicts: 2 });
    vi.mocked(api.documents.pull).mockRejectedValueOnce(conflict);
    const activeSurface = vi.spyOn(session, "setActiveSurface");
    await mount();
    await openSync();

    await act(async () => {
      await expect(syncDialogProps.actions.merge()).resolves.toBe(2);
    });

    expect(api.documents.pull).toHaveBeenCalledExactlyOnceWith(DOC.id, { merge: true });
    expect(session.ytext.toString()).toBe(marked);
    expect(activeSurface).toHaveBeenCalledWith("code");
    expect(screen.getByTestId("toast")).toHaveTextContent("Merged with 2 conflicts — resolve the marked lines, then publish.");
    expectPending(false);
    expect(versionsRefresh).toBe(0);
    expect(syncPollingProps.refreshKey).toBe(0);
  });

  it("invalidates an old success and finalizer on document change while a newer operation owns pending UI", async () => {
    const oldPull = deferred<PullResponse>();
    const currentPublish = deferred<PublishResponse>();
    vi.mocked(api.documents.pull).mockReturnValueOnce(oldPull.promise);
    vi.mocked(api.documents.publish).mockReturnValueOnce(currentPublish.promise);
    const view = await mount();

    act(() => headerProps.onPull());
    expectPending(true);

    session = createSession(SECOND_DOC, SECOND_USER);
    view.rerender(shell(SECOND_DOC, SECOND_USER));
    await waitFor(() => expect(headerProps.doc.id).toBe(SECOND_DOC.id));
    await waitFor(() => expectPending(false));
    await openCommit();
    const current = start(() => commitProps.onCommit("Second publish"));
    expect(api.documents.publish).toHaveBeenCalledExactlyOnceWith(SECOND_DOC.id, "Second publish", { force: false });
    expectPending(true);

    await act(async () => {
      oldPull.resolve(pullResponse({ ...DOC, title: "Obsolete pull" }));
      await oldPull.promise;
    });
    expect(headerProps.doc.id).toBe(SECOND_DOC.id);
    expect(headerProps.doc.title).toBe(SECOND_DOC.title);
    expectPending(true);
    expect(versionsRefresh).toBe(0);
    expect(syncPollingProps.refreshKey).toBe(0);
    expect(screen.queryByTestId("toast")).toBeNull();

    const updated = { ...SECOND_DOC, title: "Current publish" };
    await act(async () => {
      currentPublish.resolve(publishResponse(updated));
      await current;
    });
    expect(headerProps.doc).toEqual(updated);
    expectPending(false);
    expect(versionsRefresh).toBe(1);
    expect(syncPollingProps.refreshKey).toBe(1);
  });

  it("gives an old error no effects and lets a newer operation survive same-document session replacement", async () => {
    const oldPublish = deferred<PublishResponse>();
    const currentPull = deferred<PullResponse>();
    vi.mocked(api.documents.publish).mockReturnValueOnce(oldPublish.promise);
    vi.mocked(api.documents.pull).mockReturnValueOnce(currentPull.promise);
    const view = await mount();
    await openCommit();

    const obsolete = start(() => commitProps.onCommit("Old session"));
    expectPending(true);
    session = createSession(DOC, SECOND_USER);
    view.rerender(shell(DOC, SECOND_USER));
    await waitFor(() => expectPending(false));
    act(() => headerProps.onPull());
    expectPending(true);

    const staleError = new ApiError(503, "Obsolete failure");
    await act(async () => {
      oldPublish.reject(staleError);
      await expect(obsolete).rejects.toBe(staleError);
    });
    expectPending(true);
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(screen.queryByTestId("sync-dialog-mock")).toBeNull();
    expect(versionsRefresh).toBe(0);
    expect(syncPollingProps.refreshKey).toBe(0);

    await act(async () => {
      currentPull.resolve(pullResponse());
      await currentPull.promise;
    });
    expectPending(false);
    expect(versionsRefresh).toBe(1);
    expect(syncPollingProps.refreshKey).toBe(1);
  });

  it("never applies an obsolete merge conflict and does not let its finalizer unlock current force work", async () => {
    const oldMerge = deferred<PullResponse>();
    const currentForce = deferred<PullResponse>();
    vi.mocked(api.documents.pull).mockReturnValueOnce(oldMerge.promise).mockReturnValueOnce(currentForce.promise);
    const oldSession = session;
    const replaceOld = vi.spyOn(oldSession, "replaceSource");
    const view = await mount();
    await openSync();

    const obsolete = start(() => syncDialogProps.actions.merge());
    session = createSession(SECOND_DOC, SECOND_USER);
    const replaceCurrent = vi.spyOn(session, "replaceSource");
    view.rerender(shell(SECOND_DOC, SECOND_USER));
    await waitFor(() => expect(syncDialogProps.doc.id).toBe(SECOND_DOC.id));
    const current = start(() => syncDialogProps.actions.takeRemote());
    expect(api.documents.pull).toHaveBeenNthCalledWith(2, SECOND_DOC.id, { force: true });
    expectPending(true);

    const marked = "<<<<<<< local\nold\n=======\nremote\n>>>>>>> remote";
    const conflict = new ApiError(409, "Old conflict", undefined, { ...DIVERGED, status: "conflict", merged: marked, conflicts: 1 });
    await act(async () => {
      oldMerge.reject(conflict);
      await expect(obsolete).rejects.toBe(conflict);
    });
    expect(replaceOld).not.toHaveBeenCalled();
    expect(replaceCurrent).not.toHaveBeenCalled();
    expect(oldSession.ytext.toString()).not.toContain("<<<<<<<");
    expect(session.ytext.toString()).not.toContain("<<<<<<<");
    expect(screen.queryByTestId("toast")).toBeNull();
    expectPending(true);

    await act(async () => {
      currentForce.resolve(pullResponse(SECOND_DOC));
      await current;
    });
    expectPending(false);
    expect(versionsRefresh).toBe(1);
    expect(syncPollingProps.refreshKey).toBe(1);
  });

  it("absorbs late header resolve and reject settlements after unmount without effects or unhandled rejection", async () => {
    const latePublish = deferred<PublishResponse>();
    const latePull = deferred<PullResponse>();
    vi.mocked(api.documents.publish).mockReturnValueOnce(latePublish.promise);
    vi.mocked(api.documents.pull).mockReturnValueOnce(latePull.promise);
    const unhandled = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener("unhandledrejection", unhandled);

    session = createSession(GIST_DOC);
    const publishView = await mount(GIST_DOC);
    act(() => headerProps.onPublishNow());
    expectPending(true);
    publishView.unmount();
    await act(async () => {
      latePublish.resolve(publishResponse({ ...GIST_DOC, title: "Too late" }));
      await latePublish.promise;
    });

    session = createSession(DOC);
    const pullView = await mount(DOC);
    act(() => headerProps.onPull());
    expectPending(true);
    pullView.unmount();
    await act(async () => {
      latePull.reject(new ApiError(502, "Too late"));
      await latePull.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(unhandled).not.toHaveBeenCalled();
    expect(api.documents.publish).toHaveBeenCalledTimes(1);
    expect(api.documents.pull).toHaveBeenCalledTimes(1);
    expect(versionsRefresh).toBe(0);
    expect(syncPollingProps.refreshKey).toBe(0);
    window.removeEventListener("unhandledrejection", unhandled);
  });
});
