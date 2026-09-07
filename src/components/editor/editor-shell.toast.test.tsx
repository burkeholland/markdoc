// @vitest-environment jsdom
import { act, cleanup, screen } from "@testing-library/react";
import { useEffect, useLayoutEffect, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const router = {
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
};

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  return {
    HocuspocusProvider: class {
      awareness: InstanceType<typeof Awareness>;
      constructor(opts: { document: Y.Doc }) {
        this.awareness = new Awareness(opts.document);
      }
      destroy() {
        this.awareness.destroy();
      }
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./lazy-on-first-use", () => ({ lazyOnFirstUse: () => () => null }));
vi.mock("@/lib/notice", () => ({
  setPendingNotice: vi.fn(),
  takePendingNotice: vi.fn(),
}));
vi.mock("./use-session", async (importOriginal) => ({
  ...await importOriginal<typeof import("./use-session")>(),
  useCollabSession: () => currentSession,
}));
vi.mock("@/lib/viewport-hooks", () => ({ useBreakpoint: () => "desktop" }));
vi.mock("./use-sync-polling", async (importOriginal) => ({
  ...await importOriginal<typeof import("./use-sync-polling")>(),
  useSyncPolling: () => {},
}));
vi.mock("./header", () => ({ Header: () => null }));
vi.mock("./toolbar", () => ({ Toolbar: () => null }));
vi.mock("./status-bar", () => ({ StatusBar: () => null }));
vi.mock("./outline", () => ({ OutlinePanel: () => null }));
vi.mock("./rich-pane", () => ({
  RichPane: (props: ComponentProps<typeof import("./rich-pane").RichPane>) => {
    richPaneProps = props;
    return <div data-testid="rich-pane-probe" />;
  },
}));
vi.mock("./selection-bubble", () => ({ SelectionBubble: () => null }));
vi.mock("./table-menu", () => ({ TableMenu: () => null }));
vi.mock("./slash-menu", () => ({
  SlashMenu: () => null,
  useSlashMenuController: () => ({ handlers: undefined }),
}));
vi.mock("./follow-banner", () => ({ FollowBanner: () => null }));
vi.mock("./hint-bar", () => ({ HintBar: () => null }));
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

import { takePendingNotice, type PendingNotice } from "@/lib/notice";
import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import type { DocumentDto } from "@/server/dto";
import type { Role } from "@/server/db/schema";
import type { NoticeAction } from "@/editor/markdown/tsv";
import type { EditorUser } from "./use-session";
import { EditorShell } from "./editor-shell";

type RichPaneProps = ComponentProps<typeof import("./rich-pane").RichPane>;

interface ToastTimerRecord {
  readonly callback: () => void;
  readonly delay: 4500 | 8000;
  readonly handle: ReturnType<typeof setTimeout>;
  pending: boolean;
  cleared: boolean;
}

const USER: EditorUser = {
  id: "toast-owner-a",
  name: "Toast owner A",
  login: "toast-owner-a",
  image: null,
};

const DOC_A: DocumentDto = {
  id: "toast-document-a",
  title: "Toast document A",
  storage: "local",
  linkAccess: "private",
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

const DOC_B: DocumentDto = {
  ...DOC_A,
  id: "toast-document-b",
  title: "Toast document B",
};

let currentSession: CollabSession;
let richPaneProps: RichPaneProps;
let sessions: CollabSession[] = [];

function createSession(doc: DocumentDto, user: EditorUser, role: Role) {
  const session = new CollabSession({
    docId: doc.id,
    user: makeCollabUser(user.id, user.name, user.image, user.login),
    role,
    autoConnect: false,
    getToken: async () => {
      throw new Error("No provider connection permitted");
    },
  });
  session.keepAlive();
  session.localLoaded = true;
  session.ytext.insert(0, "Toast ownership test");
  sessions.push(session);
  return session;
}

function PassiveCleanupProbe({ onCleanup }: { onCleanup: () => void }) {
  useEffect(() => onCleanup, [onCleanup]);
  return null;
}

function EditorBoundary({
  doc,
  user,
  role = "owner",
  present = true,
  boundary = 0,
  onBoundary,
  onPassiveCleanup = () => {},
}: {
  doc: DocumentDto;
  user: EditorUser;
  role?: Role;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? (
    <>
      <EditorShell
        doc={doc}
        role={role}
        user={user}
        githubAvailable={false}
        githubConfigured={false}
      />
      <PassiveCleanupProbe
        key={`${doc.id}:${user.id}:${role}`}
        onCleanup={onPassiveCleanup}
      />
    </>
  ) : null;
}

function captureClick(element: HTMLElement) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the toast control");
  const props = (element as unknown as Record<string, { onClick?: () => void } | undefined>)[propsKey];
  if (!props?.onClick) throw new Error("The toast control did not have an onClick handler");
  return props.onClick;
}

function publish(message: string, action?: NoticeAction) {
  const producer = richPaneProps.onNotice;
  if (!producer) throw new Error("The rich pane did not receive the toast producer");
  act(() => producer(message, action));
}

function trackToastTimers(reuseHandle = false) {
  const records: ToastTimerRecord[] = [];
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const reused = 3111 as unknown as ReturnType<typeof setTimeout>;

  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if ((delay !== 4500 && delay !== 8000) || typeof callback !== "function") {
      return nativeSetTimeout(callback, delay, ...args);
    }
    const handle = reuseHandle
      ? reused
      : (3111 + records.length) as unknown as ReturnType<typeof setTimeout>;
    records.push({
      callback: () => callback(...args),
      delay,
      handle,
      pending: true,
      cleared: false,
    });
    return handle;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    const record = records.findLast((candidate) => candidate.pending && candidate.handle === handle);
    if (!record) {
      nativeClearTimeout(handle);
      return;
    }
    record.pending = false;
    record.cleared = true;
  });

  return {
    records,
    fire(record: ToastTimerRecord) {
      record.pending = false;
      record.callback();
    },
    pending() {
      return records.filter((record) => record.pending);
    },
  };
}

function createHost() {
  const host = document.createElement("div");
  document.body.append(host);
  return { host, root: createRoot(host) };
}

async function mount(
  root: Root,
  doc: DocumentDto = DOC_A,
  user: EditorUser = USER,
  role: Role = "owner",
) {
  currentSession = createSession(doc, user, role);
  await act(async () => {
    root.render(<EditorBoundary doc={doc} user={user} role={role} />);
  });
}

beforeEach(() => {
  richPaneProps = undefined!;
  sessions = [];
  vi.mocked(takePendingNotice).mockReset().mockReturnValue(null);
  for (const method of Object.values(router)) method.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const session of sessions) session.destroy();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("EditorShell toast visit ownership", () => {
  it.each([
    ["stale before current", "stale-current"],
    ["current before stale", "current-stale"],
  ] as const)(
    "keeps an equal-looking replacement publication authoritative with a reused timer handle: %s",
    async (_name, order) => {
      const timers = trackToastTimers(true);
      const sharedAction = vi.fn();
      const focusOwner = document.createElement("button");
      focusOwner.textContent = "Persistent focus";
      document.body.append(focusOwner);
      focusOwner.focus();
      const { host, root } = createHost();
      let passiveCleanups = 0;

      try {
        await mount(root);
        publish("Same publication", { label: "Undo", onClick: sharedAction });
        const oldToast = screen.getByTestId("toast");
        const oldActionHandler = captureClick(screen.getByTestId("toast-action"));
        const oldDismiss = captureClick(oldToast.querySelector('[aria-label="Dismiss"]')!);
        const oldTimer = timers.records[0];
        expect(timers.pending()).toEqual([oldTimer]);

        currentSession = createSession(DOC_B, USER, "owner");
        act(() => {
          root.render(
            <EditorBoundary
              doc={DOC_B}
              user={USER}
              boundary={1}
              onPassiveCleanup={() => {
                passiveCleanups++;
              }}
              onBoundary={() => {
                expect(passiveCleanups).toBe(0);
                expect(timers.pending()).toHaveLength(0);
                expect(oldTimer.cleared).toBe(true);
                expect(screen.queryByTestId("toast")).toBeNull();
              }}
            />,
          );
        });

        publish("Same publication", { label: "Undo", onClick: sharedAction });
        const currentToast = screen.getByTestId("toast");
        const currentActionHandler = captureClick(screen.getByTestId("toast-action"));
        const currentDismiss = captureClick(currentToast.querySelector('[aria-label="Dismiss"]')!);
        const currentTimer = timers.records[1];
        expect(currentTimer.handle).toBe(oldTimer.handle);
        expect(timers.pending()).toEqual([currentTimer]);

        const runStale = () => {
          const markupBeforeStale = host.innerHTML;
          const pendingBeforeStale = timers.pending();
          const actionCallsBeforeStale = sharedAction.mock.calls.length;
          timers.fire(oldTimer);
          oldActionHandler();
          oldDismiss();
          expect(host.innerHTML).toBe(markupBeforeStale);
          expect(timers.pending()).toEqual(pendingBeforeStale);
          expect(sharedAction).toHaveBeenCalledTimes(actionCallsBeforeStale);
          expect(focusOwner).toHaveFocus();
          expect(router.push).not.toHaveBeenCalled();
          expect(router.refresh).not.toHaveBeenCalled();
        };
        const runCurrent = () => {
          currentActionHandler();
          currentActionHandler();
          currentDismiss();
          timers.fire(currentTimer);
        };

        act(() => {
          if (order === "stale-current") {
            runStale();
            runCurrent();
          } else {
            runCurrent();
            runStale();
          }
        });

        expect(sharedAction).toHaveBeenCalledOnce();
        expect(screen.queryByTestId("toast")).toBeNull();
        expect(currentTimer.cleared).toBe(true);
        expect(timers.pending()).toHaveLength(0);
        expect(focusOwner).toHaveFocus();
      } finally {
        await act(async () => root.unmount());
        host.remove();
        focusOwner.remove();
      }
    },
  );

  it("retires every old-user timer and leaves the replacement user's current Dismiss usable", async () => {
    const timers = trackToastTimers();
    const replacementUser: EditorUser = {
      id: "toast-owner-b",
      name: "Toast owner B",
      login: "toast-owner-b",
      image: null,
    };
    const { host, root } = createHost();
    let passiveCleanups = 0;

    try {
      await mount(root);
      publish("First old-user publication");
      publish("Second old-user publication");
      const staleDismiss = captureClick(screen.getAllByRole("button", { name: "Dismiss" })[0]);
      const oldTimers = [...timers.records];
      expect(oldTimers).toHaveLength(2);
      expect(screen.getAllByTestId("toast").map((toast) => toast.textContent)).toEqual([
        "First old-user publication",
        "Second old-user publication",
      ]);

      currentSession = createSession(DOC_A, replacementUser, "editor");
      act(() => {
        root.render(
          <EditorBoundary
            doc={DOC_A}
            user={replacementUser}
            role="editor"
            boundary={1}
            onPassiveCleanup={() => {
              passiveCleanups++;
            }}
            onBoundary={() => {
              expect(passiveCleanups).toBe(0);
              expect(timers.pending()).toHaveLength(0);
              expect(oldTimers.every((timer) => timer.cleared)).toBe(true);
              expect(screen.queryByTestId("toast")).toBeNull();
            }}
          />,
        );
      });

      publish("Replacement user's publication");
      const currentDismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));
      const currentTimer = timers.records[2];
      expect(timers.pending()).toEqual([currentTimer]);

      act(() => {
        currentDismiss();
        currentDismiss();
        staleDismiss();
        oldTimers.forEach((timer) => timers.fire(timer));
      });

      expect(screen.queryByTestId("toast")).toBeNull();
      expect(currentTimer.cleared).toBe(true);
      expect(timers.pending()).toHaveLength(0);
      expect(router.push).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("snapshots callback action values and admits the exact publication action only once", async () => {
    const timers = trackToastTimers();
    const originalAction = vi.fn();
    const replacementAction = vi.fn();
    const action = { label: "Original action", onClick: originalAction };
    const { host, root } = createHost();

    try {
      await mount(root);
      publish("Immutable publication", action);
      action.label = "Mutated action";
      action.onClick = replacementAction;

      expect(screen.getByTestId("toast-action")).toHaveTextContent("Original action");
      const activate = captureClick(screen.getByTestId("toast-action"));
      const dismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));
      const timer = timers.records[0];

      act(() => {
        activate();
        activate();
        dismiss();
        timers.fire(timer);
      });

      expect(originalAction).toHaveBeenCalledOnce();
      expect(replacementAction).not.toHaveBeenCalled();
      expect(screen.queryByTestId("toast")).toBeNull();
      expect(timer.cleared).toBe(true);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("physically retires a removed visit before the parent layout boundary and makes retained controls inert", async () => {
    const timers = trackToastTimers();
    const staleAction = vi.fn();
    const focusOwner = document.createElement("button");
    focusOwner.textContent = "Removal focus owner";
    document.body.append(focusOwner);
    focusOwner.focus();
    const { host, root } = createHost();
    let passiveCleanups = 0;

    try {
      await mount(root);
      publish("Removed publication", { label: "Undo", onClick: staleAction });
      const staleActionHandler = captureClick(screen.getByTestId("toast-action"));
      const staleDismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));
      const staleProducer = richPaneProps.onNotice!;
      const staleTimer = timers.records[0];

      act(() => {
        root.render(
          <EditorBoundary
            doc={DOC_A}
            user={USER}
            present={false}
            boundary={1}
            onPassiveCleanup={() => {
              passiveCleanups++;
            }}
            onBoundary={() => {
              expect(passiveCleanups).toBe(0);
              expect(timers.pending()).toHaveLength(0);
              expect(staleTimer.cleared).toBe(true);
              expect(screen.queryByTestId("toast")).toBeNull();
            }}
          />,
        );
      });
      const removedMarkup = host.innerHTML;

      act(() => {
        staleProducer("Late publication", { label: "Late action", onClick: staleAction });
        staleActionHandler();
        staleDismiss();
        timers.fire(staleTimer);
      });

      expect(host.innerHTML).toBe(removedMarkup);
      expect(staleAction).not.toHaveBeenCalled();
      expect(timers.records).toHaveLength(1);
      expect(focusOwner).toHaveFocus();
      expect(takePendingNotice).toHaveBeenCalledOnce();
      expect(router.push).not.toHaveBeenCalled();
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      focusOwner.remove();
    }
  });

  it("consumes and publishes a pending notice at most once for each exact current visit", async () => {
    const pending: PendingNotice = { message: "Previous page notice", kind: "success" };
    vi.mocked(takePendingNotice)
      .mockReset()
      .mockReturnValueOnce(pending)
      .mockReturnValueOnce({ ...pending });
    const timers = trackToastTimers(true);
    const { host, root } = createHost();

    try {
      await mount(root);
      expect(takePendingNotice).toHaveBeenCalledOnce();
      expect(screen.getByTestId("toast")).toHaveTextContent(pending.message);
      const staleDismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));
      const staleProducer = richPaneProps.onNotice!;
      const staleTimer = timers.records[0];

      await act(async () => {
        root.render(<EditorBoundary doc={DOC_A} user={USER} boundary={1} />);
      });
      expect(takePendingNotice).toHaveBeenCalledOnce();

      currentSession = createSession(DOC_B, USER, "owner");
      await act(async () => {
        root.render(<EditorBoundary doc={DOC_B} user={USER} boundary={2} />);
      });
      expect(takePendingNotice).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("toast")).toHaveTextContent(pending.message);
      const currentTimer = timers.records[1];
      expect(currentTimer.handle).toBe(staleTimer.handle);
      expect(timers.pending()).toEqual([currentTimer]);

      act(() => {
        staleProducer("Retired visit notice");
        staleDismiss();
        timers.fire(staleTimer);
      });

      expect(takePendingNotice).toHaveBeenCalledTimes(2);
      expect(timers.records).toHaveLength(2);
      expect(timers.pending()).toEqual([currentTimer]);
      expect(screen.getByTestId("toast")).toHaveTextContent(pending.message);
      expect(screen.queryByText("Retired visit notice")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each([
    ["info", 4500],
    ["success", 4500],
    ["error", 8000],
  ] as const)(
    "keeps an exact %s publication until one millisecond before its %d ms deadline",
    async (kind, duration) => {
      vi.useFakeTimers();
      vi.mocked(takePendingNotice)
        .mockReset()
        .mockReturnValueOnce({ message: `${kind} deadline`, kind });
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const { host, root } = createHost();

      try {
        await mount(root);
        expect(
          setTimeoutSpy.mock.calls.filter(([, delay]) => delay === duration),
        ).toHaveLength(1);
        expect(screen.getByTestId("toast")).toHaveTextContent(`${kind} deadline`);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(duration - 1);
        });
        expect(screen.getByTestId("toast")).toHaveTextContent(`${kind} deadline`);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
        expect(screen.queryByTestId("toast")).toBeNull();
        expect(router.push).not.toHaveBeenCalled();
        expect(router.refresh).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );
});
