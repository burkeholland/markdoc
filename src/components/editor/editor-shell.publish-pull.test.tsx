// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useLayoutEffect, type ComponentProps } from "react";
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
        sync: vi.fn(),
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
vi.mock("./github-dialog", async () => {
  const { useState } = await import("react");
  return {
    GitHubDialog: () => null,
    CommitDialog: (props: ComponentProps<typeof import("./github-dialog").CommitDialog>) => {
      commitProps = props;
      const [instance] = useState(() => ++commitDialogSequence);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState<string | null>(null);
      const [done, setDone] = useState(false);
      const run = async () => {
        setBusy(true);
        setError(null);
        try {
          await props.onCommit(`Stateful commit ${instance}`);
          setDone(true);
          setTimeout(() => props.onOpenChange(false), 900);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "Publish failed");
        } finally {
          setBusy(false);
        }
      };
      return (
        <div
          data-testid="commit-dialog"
          data-open={String(props.open)}
          data-document={props.doc.id}
          data-instance={instance}
          data-busy={String(busy)}
          data-error={error ?? "none"}
          data-done={String(done)}
        >
          <button
            type="button"
            data-testid="stateful-commit"
            disabled={busy || done}
            onClick={() => {
              const request = run();
              commitDialogRuns.push(request);
            }}
          >
            Commit
          </button>
        </div>
      );
    },
  };
});
vi.mock("./sync-dialog", async () => {
  const { useState } = await import("react");
  return {
    SyncDialog: (props: ComponentProps<typeof import("./sync-dialog").SyncDialog>) => {
      syncDialogProps = props;
      if (syncCompareProducers.at(-1) !== props.actions.compare) syncCompareProducers.push(props.actions.compare);
      const [instance] = useState(() => ++syncDialogSequence);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState<string | null>(null);
      const [done, setDone] = useState(false);
      const run = async () => {
        setBusy(true);
        setError(null);
        try {
          await props.actions.takeRemote();
          setDone(true);
          setTimeout(() => props.onOpenChange(false), 900);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "Sync failed");
        } finally {
          setBusy(false);
        }
      };
      return (
        <div
          data-testid="sync-dialog-mock"
          data-open={String(props.open)}
          data-document={props.doc.id}
          data-status={props.sync?.status ?? "none"}
          data-instance={instance}
          data-busy={String(busy)}
          data-error={error ?? "none"}
          data-done={String(done)}
        >
          <button
            type="button"
            data-testid="stateful-sync-take"
            disabled={busy || done}
            onClick={() => {
              const request = run();
              syncDialogRuns.push(request);
            }}
          >
            Take GitHub
          </button>
        </div>
      );
    },
  };
});
vi.mock("./versions-panel", () => ({
  VersionDiffView: (props: ComponentProps<typeof import("./versions-panel").VersionDiffView>) => {
    versionDiffProps = props;
    return (
      <div
        data-testid="version-diff-mock"
        data-document={props.session.docId}
        data-version={props.preview.version.id}
      >
        {props.preview.content}
      </div>
    );
  },
  VersionsPanel: (props: ComponentProps<typeof import("./versions-panel").VersionsPanel>) => {
    versionsRefresh = props.refreshKey;
    if (versionPreviewProducers.at(-1) !== props.onPreview) versionPreviewProducers.push(props.onPreview);
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
type VersionDiffProps = ComponentProps<typeof import("./versions-panel").VersionDiffView>;
type VersionPreview = VersionDiffProps["preview"];
type VersionPreviewProducer = ComponentProps<typeof import("./versions-panel").VersionsPanel>["onPreview"];
type CompareProducer = SyncDialogProps["actions"]["compare"];
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
let versionDiffProps: VersionDiffProps;
let versionsRefresh: number | null;
let versionPreviewProducers: VersionPreviewProducer[] = [];
let syncCompareProducers: CompareProducer[] = [];
let commitDialogSequence = 0;
let syncDialogSequence = 0;
let commitDialogRuns: Promise<void>[] = [];
let syncDialogRuns: Promise<void>[] = [];

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

function syncResponse(content: string, remote: SyncStatusDto["remote"] = REMOTE): SyncStatusDto {
  return {
    status: "diverged",
    remote,
    localChanged: true,
    remoteChanged: true,
    lines: { local: 2, remote: 3 },
    remoteContent: content,
    pollMs: 60_000,
  };
}

function versionPreview(content = "Version content"): VersionPreview {
  return {
    version: {
      id: "version-7",
      number: 7,
      title: "Version seven",
      kind: "named",
      createdBy: USER.id,
      createdByName: USER.name,
      commitSha: null,
      createdAt: "2026-09-06T12:00:00.000Z",
      size: content.length,
    },
    content,
  };
}

function shell(doc: DocumentDto = DOC, user: EditorUser = USER) {
  return <EditorShell doc={doc} role="owner" user={user} githubAvailable githubConfigured />;
}

function PassiveCleanupProbe({
  doc,
  user,
  session,
  onCleanup,
}: {
  doc: DocumentDto;
  user: EditorUser;
  session: CollabSession;
  onCleanup: () => void;
}) {
  useEffect(() => onCleanup, [doc, onCleanup, session, user]);
  return null;
}

const noPassiveCleanup = () => {};

function EditorBoundary({
  doc = DOC,
  user = USER,
  present = true,
  boundary = 0,
  onBoundary,
  onPassiveCleanup = noPassiveCleanup,
}: {
  doc?: DocumentDto;
  user?: EditorUser;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  const exactSession = session;
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? (
    <>
      {shell(doc, user)}
      <PassiveCleanupProbe doc={doc} user={user} session={exactSession} onCleanup={onPassiveCleanup} />
    </>
  ) : null;
}

async function mount(doc: DocumentDto = DOC, user: EditorUser = USER) {
  const view = render(shell(doc, user));
  await waitFor(() => expect(headerProps.doc.id).toBe(doc.id));
  fireEvent.click(screen.getByTestId("header-history"));
  await screen.findByTestId("versions-panel-mock");
  return view;
}

async function mountBoundary(
  doc: DocumentDto = DOC,
  user: EditorUser = USER,
  onPassiveCleanup: () => void = noPassiveCleanup,
) {
  const view = render(<EditorBoundary doc={doc} user={user} onPassiveCleanup={onPassiveCleanup} />);
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

function startCompare(producer: CompareProducer = syncDialogProps.actions.compare) {
  let pending!: Promise<void>;
  act(() => {
    pending = producer() as unknown as Promise<void>;
  });
  return pending;
}

type BackMouseHandler = (event: React.MouseEvent<HTMLButtonElement>) => void;

function backMouseEvent(currentTarget: HTMLButtonElement): React.MouseEvent<HTMLButtonElement> {
  return { currentTarget } as unknown as React.MouseEvent<HTMLButtonElement>;
}

function captureClick(element: HTMLButtonElement): BackMouseHandler {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the Back control");
  const props = (element as unknown as Record<string, { onClick?: BackMouseHandler } | undefined>)[propsKey];
  if (!props?.onClick) throw new Error("The Back control did not have an onClick handler");
  return props.onClick;
}

function expectEditingPanes() {
  expect(screen.queryByTestId("version-diff-mock")).toBeNull();
  expect(screen.getByTestId("code-column")).not.toHaveClass("hidden");
  expect(screen.getByTestId("rich-column")).not.toHaveClass("hidden");
}

beforeEach(() => {
  versionsRefresh = null;
  headerProps = undefined!;
  commitProps = undefined!;
  syncDialogProps = undefined!;
  syncPollingProps = undefined!;
  versionDiffProps = undefined!;
  versionPreviewProducers = [];
  syncCompareProducers = [];
  commitDialogSequence = 0;
  syncDialogSequence = 0;
  commitDialogRuns = [];
  syncDialogRuns = [];
  sessions = [];
  session = createSession(DOC);
  vi.mocked(api.documents.publish).mockReset();
  vi.mocked(api.documents.pull).mockReset();
  vi.mocked(api.documents.sync).mockReset();
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

  it("remounts Commit for a same-user session replacement and ignores the old success, finalizer, and close timer", async () => {
    const oldPublish = deferred<PublishResponse>();
    const currentPublish = deferred<PublishResponse>();
    vi.mocked(api.documents.publish).mockReturnValueOnce(oldPublish.promise).mockReturnValueOnce(currentPublish.promise);
    const view = await mount();
    await openCommit();
    const oldDialog = screen.getByTestId("commit-dialog");
    const oldInstance = oldDialog.getAttribute("data-instance");
    fireEvent.click(screen.getByTestId("stateful-commit"));
    const oldRun = commitDialogRuns.at(-1)!;
    expect(oldDialog).toHaveAttribute("data-busy", "true");
    expect(api.documents.publish).toHaveBeenCalledExactlyOnceWith(DOC.id, `Stateful commit ${oldInstance}`, { force: false });

    session = createSession(DOC, USER);
    view.rerender(shell(DOC, USER));
    const currentDialog = await screen.findByTestId("commit-dialog");
    vi.useFakeTimers();

    try {
      const currentInstance = currentDialog.getAttribute("data-instance");
      expect(currentInstance).not.toBe(oldInstance);
      expect(currentDialog).toHaveAttribute("data-open", "true");
      expect(currentDialog).toHaveAttribute("data-busy", "false");
      expect(currentDialog).toHaveAttribute("data-error", "none");
      expect(currentDialog).toHaveAttribute("data-done", "false");

      fireEvent.click(screen.getByTestId("stateful-commit"));
      const currentRun = commitDialogRuns.at(-1)!;
      expect(api.documents.publish).toHaveBeenNthCalledWith(2, DOC.id, `Stateful commit ${currentInstance}`, { force: false });
      expectPending(true);
      expect(screen.getByTestId("commit-dialog")).toHaveAttribute("data-busy", "true");

      await act(async () => {
        oldPublish.resolve(publishResponse({ ...DOC, title: "Obsolete publish" }));
        await oldRun;
      });
      act(() => vi.advanceTimersByTime(900));

      expect(headerProps.doc.title).toBe(DOC.title);
      expectPending(true);
      expect(screen.getByTestId("commit-dialog")).toHaveAttribute("data-open", "true");
      expect(screen.getByTestId("commit-dialog")).toHaveAttribute("data-busy", "true");
      expect(screen.getByTestId("commit-dialog")).toHaveAttribute("data-error", "none");
      expect(screen.getByTestId("commit-dialog")).toHaveAttribute("data-done", "false");
      expect(versionsRefresh).toBe(0);
      expect(syncPollingProps.refreshKey).toBe(0);
      expect(screen.queryByTestId("toast")).toBeNull();

      await act(async () => {
        currentPublish.resolve(publishResponse());
        await currentRun;
      });
      expect(screen.getByTestId("commit-dialog")).toHaveAttribute("data-busy", "false");
      expect(screen.getByTestId("commit-dialog")).toHaveAttribute("data-done", "true");
      act(() => vi.advanceTimersByTime(900));
      expect(screen.getByTestId("commit-dialog")).toHaveAttribute("data-open", "false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("remounts Sync for a same-user session replacement and ignores the old rejection and finalizer", async () => {
    const oldPull = deferred<PullResponse>();
    const currentPull = deferred<PullResponse>();
    vi.mocked(api.documents.pull).mockReturnValueOnce(oldPull.promise).mockReturnValueOnce(currentPull.promise);
    const view = await mount();
    await openSync();

    const oldDialog = screen.getByTestId("sync-dialog-mock");
    const oldInstance = oldDialog.getAttribute("data-instance");
    fireEvent.click(screen.getByTestId("stateful-sync-take"));
    const oldRun = syncDialogRuns.at(-1)!;
    expect(oldDialog).toHaveAttribute("data-busy", "true");
    expect(api.documents.pull).toHaveBeenCalledExactlyOnceWith(DOC.id, { force: true });

    session = createSession(DOC, USER);
    view.rerender(shell(DOC, USER));
    const currentDialog = await screen.findByTestId("sync-dialog-mock");
    expect(currentDialog.getAttribute("data-instance")).not.toBe(oldInstance);
    expect(currentDialog).toHaveAttribute("data-open", "true");
    expect(currentDialog).toHaveAttribute("data-busy", "false");
    expect(currentDialog).toHaveAttribute("data-error", "none");
    expect(currentDialog).toHaveAttribute("data-done", "false");

    fireEvent.click(screen.getByTestId("stateful-sync-take"));
    const currentRun = syncDialogRuns.at(-1)!;
    expect(api.documents.pull).toHaveBeenNthCalledWith(2, DOC.id, { force: true });
    expectPending(true);
    expect(screen.getByTestId("sync-dialog-mock")).toHaveAttribute("data-busy", "true");

    await act(async () => {
      oldPull.reject(new ApiError(503, "Obsolete sync failure"));
      await oldRun;
    });

    expectPending(true);
    expect(screen.getByTestId("sync-dialog-mock")).toHaveAttribute("data-open", "true");
    expect(screen.getByTestId("sync-dialog-mock")).toHaveAttribute("data-busy", "true");
    expect(screen.getByTestId("sync-dialog-mock")).toHaveAttribute("data-error", "none");
    expect(screen.getByTestId("sync-dialog-mock")).toHaveAttribute("data-done", "false");
    expect(versionsRefresh).toBe(0);
    expect(syncPollingProps.refreshKey).toBe(0);
    expect(screen.queryByTestId("toast")).toBeNull();

    await act(async () => {
      currentPull.resolve(pullResponse());
      await currentRun;
    });
    expectPending(false);
    expect(screen.getByTestId("sync-dialog-mock")).toHaveAttribute("data-busy", "false");
    expect(screen.getByTestId("sync-dialog-mock")).toHaveAttribute("data-error", "none");
    expect(screen.getByTestId("sync-dialog-mock")).toHaveAttribute("data-done", "true");
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

describe("EditorShell comparison preview ownership", () => {
  it("publishes current GitHub metadata and content once, then gives the exact Back control one clear", async () => {
    const request = deferred<SyncStatusDto>();
    vi.mocked(api.documents.sync).mockReturnValueOnce(request.promise);
    await mount();
    await openSync();

    const pending = startCompare();
    expect(api.documents.sync).toHaveBeenCalledExactlyOnceWith(DOC.id, { fresh: true, content: true });
    expect(screen.queryByTestId("version-diff-mock")).toBeNull();

    const remote = {
      ...REMOTE,
      sha: "remote-preview-sha",
      updatedAt: "2026-09-07T16:30:00.000Z",
    };
    await act(async () => {
      request.resolve(syncResponse("# GitHub copy\n", remote));
      await pending;
    });

    expect(versionDiffProps.session).toBe(session);
    expect(versionDiffProps.preview.content).toBe("# GitHub copy\n");
    expect(versionDiffProps.preview.version).toMatchObject({
      id: "github-remote",
      title: "GitHub",
      kind: "import",
      createdBy: null,
      createdByName: "GitHub",
      commitSha: remote.sha,
      createdAt: remote.updatedAt,
      size: 14,
    });
    expect(screen.getByTestId("sync-compare-bar")).toHaveTextContent("Comparing GitHub\\u2019s copy with this document.");
    expect(screen.getByTestId("version-diff-mock")).toHaveTextContent("# GitHub copy");

    const backControl = screen.getByTestId("sync-compare-close") as HTMLButtonElement;
    const back = captureClick(backControl);
    const focusOwner = document.createElement("button");
    document.body.append(focusOwner);
    focusOwner.focus();
    act(() => {
      back(backMouseEvent(backControl));
      back(backMouseEvent(backControl));
    });

    expectEditingPanes();
    expect(screen.queryByTestId("sync-compare-bar")).toBeNull();
    expect(focusOwner).toHaveFocus();
    focusOwner.remove();
  });

  it("requires the current Back handler's exact connected control inside its recorded preview root", async () => {
    vi.mocked(api.documents.sync).mockResolvedValueOnce(syncResponse("Control-bound preview"));
    const view = await mount();
    await openSync();
    await act(async () => {
      await startCompare();
    });

    const control = screen.getByTestId("sync-compare-close") as HTMLButtonElement;
    const back = captureClick(control);
    const root = screen.getByTestId("sync-compare-bar").parentElement;
    if (!(root instanceof HTMLDivElement)) throw new Error("The preview root was not rendered");
    const foreign = document.createElement("button");
    const sibling = document.createElement("button");
    const detached = document.createElement("button");
    const replacement = control.cloneNode(true) as HTMLButtonElement;
    const focusOwner = document.createElement("button");
    document.body.append(foreign, focusOwner);
    root.append(sibling);
    focusOwner.focus();

    try {
      const preview = versionDiffProps.preview;
      const markup = view.container.innerHTML;
      act(() => {
        back(backMouseEvent(foreign));
        back(backMouseEvent(sibling));
        back(backMouseEvent(detached));
      });
      expect(view.container.innerHTML).toBe(markup);
      expect(versionDiffProps.preview).toBe(preview);
      expect(screen.getByTestId("sync-compare-close")).toBe(control);
      expect(focusOwner).toHaveFocus();

      control.replaceWith(replacement);
      document.body.append(control);
      const replacedMarkup = view.container.innerHTML;
      act(() => {
        back(backMouseEvent(control));
        back(backMouseEvent(replacement));
      });
      expect(view.container.innerHTML).toBe(replacedMarkup);
      expect(versionDiffProps.preview).toBe(preview);
      expect(root.querySelector("[data-testid='sync-compare-close']")).toBe(replacement);
      expect(focusOwner).toHaveFocus();

      act(() => {
        replacement.replaceWith(control);
        back(backMouseEvent(control));
        back(backMouseEvent(control));
      });
      expectEditingPanes();
      const editingMarkup = view.container.innerHTML;
      act(() => {
        back(backMouseEvent(control));
        back(backMouseEvent(replacement));
      });
      expect(view.container.innerHTML).toBe(editingMarkup);
      expect(focusOwner).toHaveFocus();
    } finally {
      foreign.remove();
      sibling.remove();
      control.remove();
      replacement.remove();
      focusOwner.remove();
    }
  });

  it.each([
    ["stale before current", false],
    ["current before stale", true],
  ] as const)(
    "keeps equal-looking publications distinct when their Back handlers reuse the same element: %s",
    async (_name, currentFirst) => {
      const remote = { ...REMOTE, updatedAt: "2026-09-07T16:30:00.000Z" };
      vi.mocked(api.documents.sync)
        .mockResolvedValueOnce(syncResponse("Same-element preview", remote))
        .mockResolvedValueOnce(syncResponse("Same-element preview", remote));
      const view = await mount();
      await openSync();
      await act(async () => {
        await startCompare();
      });
      const staleControl = screen.getByTestId("sync-compare-close") as HTMLButtonElement;
      const staleBack = captureClick(staleControl);
      const stalePreview = versionDiffProps.preview;

      await act(async () => {
        await startCompare();
      });
      const currentControl = screen.getByTestId("sync-compare-close") as HTMLButtonElement;
      const currentBack = captureClick(currentControl);
      const currentPreview = versionDiffProps.preview;
      expect(currentControl).toBe(staleControl);
      expect(currentBack).not.toBe(staleBack);
      expect(currentPreview).toEqual(stalePreview);
      expect(currentPreview).not.toBe(stalePreview);

      const focusOwner = document.createElement("button");
      document.body.append(focusOwner);
      focusOwner.focus();
      const previewMarkup = view.container.innerHTML;
      const invokeStale = () => staleBack(backMouseEvent(currentControl));
      const invokeCurrent = () => currentBack(backMouseEvent(staleControl));

      if (currentFirst) {
        act(invokeCurrent);
        const editingMarkup = view.container.innerHTML;
        act(invokeStale);
        expect(view.container.innerHTML).toBe(editingMarkup);
      } else {
        act(invokeStale);
        expect(view.container.innerHTML).toBe(previewMarkup);
        expect(versionDiffProps.preview).toBe(currentPreview);
        act(invokeCurrent);
      }

      expectEditingPanes();
      const editingMarkup = view.container.innerHTML;
      act(() => {
        invokeStale();
        invokeCurrent();
      });
      expect(view.container.innerHTML).toBe(editingMarkup);
      expect(focusOwner).toHaveFocus();
      expect(api.documents.sync).toHaveBeenCalledTimes(2);
      focusOwner.remove();
    },
  );

  it("publishes and clears exact Version-panel values while replacing equal-looking publications by identity", async () => {
    await mount();
    const producer = versionPreviewProducers.at(-1)!;
    const first = versionPreview("Equal version content");
    const replacement = versionPreview("Equal version content");
    expect(replacement).toEqual(first);
    expect(replacement).not.toBe(first);
    expect(replacement.version).not.toBe(first.version);

    act(() => producer(first));
    await screen.findByTestId("version-diff-mock");
    expect(versionDiffProps.preview).toBe(first);
    expect(versionDiffProps.session).toBe(session);
    expect(screen.queryByTestId("sync-compare-bar")).toBeNull();
    expect(screen.queryByTestId("code-column")).toBeNull();
    expect(screen.queryByTestId("rich-column")).toBeNull();

    act(() => producer(replacement));
    expect(versionDiffProps.preview).toBe(replacement);
    expect(screen.getByTestId("version-diff-mock")).toHaveTextContent("Equal version content");

    act(() => {
      producer(null);
      producer(null);
    });
    expectEditingPanes();
  });

  it("keeps a current Compare rejection effect-free and leaves the visit able to publish a Version preview", async () => {
    const failure = new ApiError(503, "GitHub compare unavailable");
    vi.mocked(api.documents.sync).mockRejectedValueOnce(failure);
    await mount();
    await openSync();

    await act(async () => {
      await expect(startCompare()).rejects.toBe(failure);
    });
    expectEditingPanes();
    expect(screen.queryByTestId("sync-compare-bar")).toBeNull();

    const currentVersion = versionPreview("Still usable");
    act(() => versionPreviewProducers.at(-1)!(currentVersion));
    await screen.findByTestId("version-diff-mock");
    expect(versionDiffProps.preview).toBe(currentVersion);
    expect(api.documents.sync).toHaveBeenCalledExactlyOnceWith(DOC.id, { fresh: true, content: true });
  });

  it.each([
    ["stale before current", "stale-current"],
    ["current before stale", "current-stale"],
  ] as const)(
    "retires document, session, actions, producer, request, and rendered Back ownership before a replacement: %s",
    async (_name, order) => {
      const oldPending = deferred<SyncStatusDto>();
      vi.mocked(api.documents.sync)
        .mockResolvedValueOnce(syncResponse("Equal remote content"))
        .mockReturnValueOnce(oldPending.promise)
        .mockResolvedValueOnce(syncResponse("Equal remote content", { ...REMOTE, url: SECOND_DOC.githubUrl }));
      let passiveCleanups = 0;
      const countPassiveCleanup = () => {
        passiveCleanups++;
      };
      const view = await mountBoundary(DOC, USER, countPassiveCleanup);
      await openSync();
      const oldCompare = syncCompareProducers.at(-1)!;
      const oldProducer = versionPreviewProducers.at(-1)!;

      await act(async () => {
        await startCompare(oldCompare);
      });
      const oldBackControl = screen.getByTestId("sync-compare-close") as HTMLButtonElement;
      const oldBack = captureClick(oldBackControl);
      const retiredRequest = startCompare(oldCompare);
      expect(api.documents.sync).toHaveBeenCalledTimes(2);

      const focusOwner = document.createElement("button");
      document.body.append(focusOwner);
      focusOwner.focus();
      session = createSession(SECOND_DOC, SECOND_USER);
      act(() => {
        view.rerender(
          <EditorBoundary
            doc={SECOND_DOC}
            user={SECOND_USER}
            boundary={1}
            onPassiveCleanup={countPassiveCleanup}
            onBoundary={() => {
              expect(passiveCleanups).toBe(0);
              expect(screen.queryByTestId("version-diff-mock")).toBeNull();
              oldProducer(versionPreview("Equal remote content"));
              oldBack(backMouseEvent(oldBackControl));
              oldPending.resolve(syncResponse("Late old remote"));
            }}
          />,
        );
      });
      await act(async () => {
        await retiredRequest;
      });

      const currentCompare = syncCompareProducers.at(-1)!;
      const currentProducer = versionPreviewProducers.at(-1)!;
      expect(currentCompare).not.toBe(oldCompare);
      expect(currentProducer).not.toBe(oldProducer);
      expect(passiveCleanups).toBe(1);
      const currentRequest = startCompare(currentCompare);
      await act(async () => {
        await currentRequest;
      });
      expect(api.documents.sync).toHaveBeenNthCalledWith(3, SECOND_DOC.id, { fresh: true, content: true });
      expect(versionDiffProps.session).toBe(session);
      expect(versionDiffProps.preview.content).toBe("Equal remote content");
      const currentBackControl = screen.getByTestId("sync-compare-close") as HTMLButtonElement;
      const currentBack = captureClick(currentBackControl);
      expect(currentBackControl).not.toBe(oldBackControl);
      const currentPreview = versionDiffProps.preview;
      const previewMarkup = view.container.innerHTML;
      act(() => {
        oldBack(backMouseEvent(currentBackControl));
        currentBack(backMouseEvent(oldBackControl));
      });
      expect(view.container.innerHTML).toBe(previewMarkup);
      expect(versionDiffProps.preview).toBe(currentPreview);
      expect(focusOwner).toHaveFocus();

      const runStale = () => {
        const markup = view.container.innerHTML;
        const calls = vi.mocked(api.documents.sync).mock.calls.length;
        const focused = document.activeElement;
        oldProducer(versionPreview("Equal remote content"));
        oldProducer(null);
        oldBack(backMouseEvent(oldBackControl));
        oldBack(backMouseEvent(currentBackControl));
        currentBack(backMouseEvent(oldBackControl));
        void oldCompare();
        expect(view.container.innerHTML).toBe(markup);
        expect(api.documents.sync).toHaveBeenCalledTimes(calls);
        expect(document.activeElement).toBe(focused);
      };
      const runCurrent = () => {
        currentBack(backMouseEvent(currentBackControl));
        currentBack(backMouseEvent(currentBackControl));
      };

      act(() => {
        if (order === "stale-current") {
          runStale();
          expect(screen.getByTestId("version-diff-mock")).toHaveTextContent("Equal remote content");
          runCurrent();
        } else {
          runCurrent();
          runStale();
        }
      });

      expectEditingPanes();
      const editingMarkup = view.container.innerHTML;
      act(() => {
        oldBack(backMouseEvent(oldBackControl));
        oldBack(backMouseEvent(currentBackControl));
        currentBack(backMouseEvent(oldBackControl));
        currentBack(backMouseEvent(currentBackControl));
      });
      expect(view.container.innerHTML).toBe(editingMarkup);
      expect(api.documents.sync).toHaveBeenCalledTimes(3);
      expect(focusOwner).toHaveFocus();
      focusOwner.remove();
    },
  );

  it("retires a same-ID document object and changed destination facts before parent layout work", async () => {
    const oldPending = deferred<SyncStatusDto>();
    vi.mocked(api.documents.sync)
      .mockResolvedValueOnce(syncResponse("Same-looking preview"))
      .mockReturnValueOnce(oldPending.promise)
      .mockResolvedValueOnce(syncResponse("Same-looking preview"));
    let passiveCleanups = 0;
    const countPassiveCleanup = () => {
      passiveCleanups++;
    };
    const view = await mountBoundary(DOC, USER, countPassiveCleanup);
    await openSync();
    const oldCompare = syncCompareProducers.at(-1)!;
    const oldProducer = versionPreviewProducers.at(-1)!;
    await act(async () => {
      await startCompare(oldCompare);
    });
    const oldBackControl = screen.getByTestId("sync-compare-close") as HTMLButtonElement;
    const oldBack = captureClick(oldBackControl);
    const retiredRequest = startCompare(oldCompare);
    const replacementDoc: DocumentDto = {
      ...DOC,
      repoBranch: "preview-branch",
      repoPath: "renamed.md",
      githubUrl: "https://github.com/owner/repo/blob/preview-branch/renamed.md",
      updatedAt: "2026-09-07T17:00:00.000Z",
    };
    act(() => {
      view.rerender(
        <EditorBoundary
          doc={replacementDoc}
          boundary={1}
          onPassiveCleanup={countPassiveCleanup}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            expect(screen.queryByTestId("version-diff-mock")).toBeNull();
            oldProducer(versionPreview("Same-looking preview"));
            oldBack(backMouseEvent(oldBackControl));
            oldPending.reject(new ApiError(502, "Retired compare failed"));
          }}
        />,
      );
    });
    await act(async () => {
      await retiredRequest;
    });

    const currentCompare = syncCompareProducers.at(-1)!;
    const currentProducer = versionPreviewProducers.at(-1)!;
    expect(currentCompare).not.toBe(oldCompare);
    expect(currentProducer).not.toBe(oldProducer);
    expect(passiveCleanups).toBe(1);
    await act(async () => {
      await startCompare(currentCompare);
    });
    const currentBackControl = screen.getByTestId("sync-compare-close") as HTMLButtonElement;
    const currentBack = captureClick(currentBackControl);
    const markup = view.container.innerHTML;
    act(() => {
      oldProducer(versionPreview("Same-looking preview"));
      oldProducer(null);
      oldBack(backMouseEvent(oldBackControl));
      oldBack(backMouseEvent(currentBackControl));
      currentBack(backMouseEvent(oldBackControl));
    });
    expect(view.container.innerHTML).toBe(markup);
    expect(versionDiffProps.preview.content).toBe("Same-looking preview");

    act(() => {
      currentBack(backMouseEvent(currentBackControl));
      oldBack(backMouseEvent(oldBackControl));
    });
    expectEditingPanes();
    expect(api.documents.sync).toHaveBeenCalledTimes(3);
    expect(api.documents.sync).toHaveBeenLastCalledWith(DOC.id, { fresh: true, content: true });
  });

  it("retires a same-document session and EditorActions before a rejected Compare settles", async () => {
    const oldPending = deferred<SyncStatusDto>();
    vi.mocked(api.documents.sync)
      .mockResolvedValueOnce(syncResponse("Session preview"))
      .mockReturnValueOnce(oldPending.promise)
      .mockResolvedValueOnce(syncResponse("Current session preview"));
    const view = await mountBoundary();
    await openSync();
    const oldCompare = syncCompareProducers.at(-1)!;
    const oldProducer = versionPreviewProducers.at(-1)!;
    await act(async () => {
      await startCompare(oldCompare);
    });
    const oldBackControl = screen.getByTestId("sync-compare-close") as HTMLButtonElement;
    const oldBack = captureClick(oldBackControl);
    const retiredRequest = startCompare(oldCompare);
    let passiveCleanups = 0;

    session = createSession(DOC, SECOND_USER);
    act(() => {
      view.rerender(
        <EditorBoundary
          doc={DOC}
          user={SECOND_USER}
          boundary={1}
          onPassiveCleanup={() => {
            passiveCleanups++;
          }}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            oldProducer(versionPreview("Late session preview"));
            oldBack(backMouseEvent(oldBackControl));
            oldPending.reject(new ApiError(503, "Old session failed"));
          }}
        />,
      );
    });
    await act(async () => {
      await retiredRequest;
    });

    const currentCompare = syncCompareProducers.at(-1)!;
    expect(currentCompare).not.toBe(oldCompare);
    expect(versionPreviewProducers.at(-1)).not.toBe(oldProducer);
    await act(async () => {
      await startCompare(currentCompare);
    });
    expect(versionDiffProps.session).toBe(session);
    expect(versionDiffProps.preview.content).toBe("Current session preview");
    const currentBackControl = screen.getByTestId("sync-compare-close") as HTMLButtonElement;
    const currentBack = captureClick(currentBackControl);
    act(() => currentBack(backMouseEvent(currentBackControl)));
    expectEditingPanes();
    expect(api.documents.sync).toHaveBeenCalledTimes(3);
  });

  it("retires preview DOM and pending Compare work before removal and keeps every retained callback inert", async () => {
    const oldPending = deferred<SyncStatusDto>();
    vi.mocked(api.documents.sync)
      .mockResolvedValueOnce(syncResponse("Removed preview"))
      .mockReturnValueOnce(oldPending.promise);
    let passiveCleanups = 0;
    const countPassiveCleanup = () => {
      passiveCleanups++;
    };
    const view = await mountBoundary(DOC, USER, countPassiveCleanup);
    await openSync();
    const staleCompare = syncCompareProducers.at(-1)!;
    const staleProducer = versionPreviewProducers.at(-1)!;
    await act(async () => {
      await startCompare(staleCompare);
    });
    const staleBackControl = screen.getByTestId("sync-compare-close") as HTMLButtonElement;
    const staleBack = captureClick(staleBackControl);
    const retiredRequest = startCompare(staleCompare);
    const focusOwner = document.createElement("button");
    document.body.append(focusOwner);
    focusOwner.focus();

    act(() => {
      view.rerender(
        <EditorBoundary
          present={false}
          boundary={1}
          onPassiveCleanup={countPassiveCleanup}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            expect(view.container.innerHTML).toBe("");
            staleProducer(versionPreview("Boundary publication"));
            staleProducer(null);
            staleBack(backMouseEvent(staleBackControl));
            oldPending.reject(new ApiError(503, "Removed compare failed"));
          }}
        />,
      );
    });
    await act(async () => {
      await retiredRequest;
    });
    expect(passiveCleanups).toBe(1);

    const removedMarkup = view.container.innerHTML;
    const calls = vi.mocked(api.documents.sync).mock.calls.length;
    act(() => {
      staleProducer(versionPreview("After cleanup publication"));
      staleProducer(null);
      staleBack(backMouseEvent(staleBackControl));
      void staleCompare();
    });
    expect(view.container.innerHTML).toBe(removedMarkup);
    expect(api.documents.sync).toHaveBeenCalledTimes(calls);
    expect(api.documents.sync).toHaveBeenCalledTimes(2);
    expect(focusOwner).toHaveFocus();
    focusOwner.remove();
  });
});
