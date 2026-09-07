// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useLayoutEffect, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DocumentDto } from "@/server/dto";
import { api, ApiError, type SyncStatusDto } from "@/lib/api";
import { pollDocumentSync } from "./use-sync-polling";
import { PublishStatusButton } from "./header";
import { SyncDialog, type SyncActions } from "./sync-dialog";
import { SYNC_LABELS } from "./labels";

const REMOTE = {
  sha: "4ce1359b",
  revision: "4ce1359b",
  url: "https://github.com/o/r/blob/main/big.md",
  updatedAt: null,
};

const IN_SYNC: SyncStatusDto = {
  status: "in-sync",
  remote: REMOTE,
  localChanged: false,
  remoteChanged: false,
  lines: { local: 0, remote: 0 },
};

const unreadableError = () =>
  new ApiError(413, "The file on GitHub is 3.63 MB; Markdoc documents are limited to 2 MB", undefined, {
    status: "remote-unreadable",
    size: 3_800_000,
    limit: 2_097_152,
    remote: REMOTE,
  });

const DOC: DocumentDto = {
  id: "doc-1",
  title: "Oversized remote",
  storage: "repo",
  linkAccess: "private",
  ownerId: "owner-1",
  gistId: null,
  gistFile: null,
  repoOwner: "o",
  repoName: "r",
  repoBranch: "main",
  repoPath: "big.md",
  publishedAt: "2026-08-27T00:00:00.000Z",
  hasUnpublishedChanges: true,
  githubUrl: REMOTE.url,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

const DIVERGED: SyncStatusDto = {
  ...IN_SYNC,
  status: "diverged",
  localChanged: true,
  remoteChanged: true,
  lines: { local: 2, remote: 3 },
};

const SECOND_DOC: DocumentDto = {
  ...DOC,
  id: "doc-2",
  title: "Second document",
  repoPath: "second.md",
  githubUrl: "https://github.com/o/r/blob/main/second.md",
};

const RENAMED_DOC: DocumentDto = {
  ...DOC,
  repoPath: "renamed.md",
  githubUrl: "https://github.com/o/r/blob/main/renamed.md",
};

const UPDATED_SYNC: SyncStatusDto = {
  ...DIVERGED,
  localChanged: false,
  lines: { local: 0, remote: 8 },
  remote: {
    ...REMOTE,
    sha: "987654321",
    revision: "987654321",
    updatedAt: "2026-09-07T20:00:00.000Z",
  },
};

const UNREADABLE_SYNC: SyncStatusDto = {
  ...IN_SYNC,
  status: "remote-unreadable",
  size: 3_800_000,
  limit: 2_097_152,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function syncActions(overrides: Partial<SyncActions> = {}): SyncActions {
  return {
    merge: vi.fn(async () => 0),
    keepMine: vi.fn(async () => undefined),
    takeRemote: vi.fn(async () => undefined),
    compare: vi.fn(),
    ...overrides,
  };
}

function InitialSyncDialog(props: ComponentProps<typeof SyncDialog>) {
  return <SyncDialog {...props} />;
}

function ReplacementSyncDialog(props: ComponentProps<typeof SyncDialog>) {
  return <SyncDialog {...props} />;
}

function SyncBoundary({
  actions,
  onOpenChange,
  doc = DOC,
  sync = DIVERGED,
  open = true,
  present = true,
  mount = "initial",
  passiveVisit = 0,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  actions: SyncActions;
  onOpenChange: (open: boolean) => void;
  doc?: DocumentDto;
  sync?: SyncStatusDto | null;
  open?: boolean;
  present?: boolean;
  mount?: "initial" | "replacement";
  passiveVisit?: number;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => onPassiveCleanup, [onPassiveCleanup, passiveVisit]);

  if (!present) return null;
  const props = { open, onOpenChange, doc, sync, actions };
  return mount === "initial" ? <InitialSyncDialog {...props} /> : <ReplacementSyncDialog {...props} />;
}

interface DirectView {
  host: HTMLDivElement;
  root: Root;
}

const directViews: DirectView[] = [];
const mutationObservers: MutationObserver[] = [];

function renderDirect(node: ReactNode): DirectView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { host, root: createRoot(host) };
  directViews.push(view);
  act(() => view.root.render(node));
  return view;
}

function observeMutations(host: HTMLElement): MutationObserver {
  const observer = new MutationObserver(() => {});
  observer.observe(host, { attributes: true, characterData: true, childList: true, subtree: true });
  mutationObservers.push(observer);
  return observer;
}

function reactHandler<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return handler as T;
}

type SyncClickHandler = (event: { currentTarget: HTMLButtonElement; defaultPrevented: boolean }) => void;
type SyncChangeHandler = (event: { currentTarget: HTMLInputElement }) => void;

interface CapturedSyncCallbacks {
  mergeElement: HTMLButtonElement | null;
  merge: SyncClickHandler | null;
  keepElement: HTMLButtonElement;
  keep: SyncClickHandler;
  takeElement: HTMLButtonElement | null;
  take: SyncClickHandler | null;
  compareElement: HTMLButtonElement | null;
  compare: SyncClickHandler | null;
  inputElement: HTMLInputElement;
  change: SyncChangeHandler;
  closeElement: HTMLButtonElement;
  close: SyncClickHandler;
}

function optionalClick(testId: string) {
  const element = screen.queryByTestId(testId) as HTMLButtonElement | null;
  return {
    element,
    handler: element ? reactHandler<SyncClickHandler>(element, "onClick") : null,
  };
}

function captureSyncCallbacks(): CapturedSyncCallbacks {
  const merge = optionalClick("sync-merge");
  const keepElement = screen.getByTestId("sync-keep-mine") as HTMLButtonElement;
  const take = optionalClick("sync-take-remote");
  const compare = optionalClick("sync-compare");
  const inputElement = screen.getByTestId("commit-message") as HTMLInputElement;
  const closeElement = screen.getByRole("button", { name: "Close" }) as HTMLButtonElement;
  return {
    mergeElement: merge.element,
    merge: merge.handler,
    keepElement,
    keep: reactHandler<SyncClickHandler>(keepElement, "onClick"),
    takeElement: take.element,
    take: take.handler,
    compareElement: compare.element,
    compare: compare.handler,
    inputElement,
    change: reactHandler<SyncChangeHandler>(inputElement, "onChange"),
    closeElement,
    close: reactHandler<SyncClickHandler>(closeElement, "onClick"),
  };
}

function invokeCapturedCallbacks(callbacks: CapturedSyncCallbacks) {
  const originalValue = Object.getOwnPropertyDescriptor(callbacks.inputElement, "value");
  const readValue = vi.fn(() => "stale message");
  Object.defineProperty(callbacks.inputElement, "value", { configurable: true, get: readValue });
  try {
    callbacks.change({ currentTarget: callbacks.inputElement });
  } finally {
    if (originalValue) Object.defineProperty(callbacks.inputElement, "value", originalValue);
    else delete (callbacks.inputElement as unknown as Record<string, unknown>).value;
  }
  callbacks.merge?.({ currentTarget: callbacks.mergeElement!, defaultPrevented: false });
  callbacks.keep({ currentTarget: callbacks.keepElement, defaultPrevented: false });
  callbacks.take?.({ currentTarget: callbacks.takeElement!, defaultPrevented: false });
  callbacks.compare?.({ currentTarget: callbacks.compareElement!, defaultPrevented: false });
  callbacks.close({ currentTarget: callbacks.closeElement, defaultPrevented: false });
  return readValue;
}

afterEach(() => {
  for (const view of directViews.splice(0)) {
    act(() => view.root.unmount());
    view.host.remove();
  }
  for (const observer of mutationObservers.splice(0)) observer.disconnect();
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("remote-unreadable sync status", () => {
  it("turns the first 413 poll into a labeled status chip that opens Sync", async () => {
    vi.spyOn(api.documents, "sync").mockRejectedValue(unreadableError());
    const sync = await pollDocumentSync(DOC.id, false);
    const onSync = vi.fn();
    const onPublishNow = vi.fn();

    render(<PublishStatusButton sync={sync} publishing={false} onPublishNow={onPublishNow} onPull={vi.fn()} onSync={onSync} />);

    const chip = screen.getByTestId("publish-status");
    expect(chip).toHaveAttribute("data-status", "remote-unreadable");
    expect(chip).toHaveTextContent(SYNC_LABELS["remote-unreadable"]);
    expect(chip).not.toHaveTextContent("Up to date");
    expect(chip).not.toHaveTextContent(/^Publish$/);
    expect(screen.getByTestId("publish-button")).toHaveAttribute("title", "GitHub file too large");
    expect(api.documents.sync).toHaveBeenCalledWith(DOC.id, { fresh: false });

    fireEvent.click(screen.getByTestId("publish-button"));
    expect(onSync).toHaveBeenCalledOnce();
    expect(onPublishNow).not.toHaveBeenCalled();
  });

  it("replaces an in-sync result with remote-unreadable on the next poll", async () => {
    vi.spyOn(api.documents, "sync").mockResolvedValueOnce(IN_SYNC).mockRejectedValueOnce(unreadableError());

    expect((await pollDocumentSync(DOC.id, false)).status).toBe("in-sync");
    expect((await pollDocumentSync(DOC.id, false)).status).toBe("remote-unreadable");
  });

  it("keeps the 413 body's pollMs, so the header polls again at SYNC_POLL_MS rather than in a minute", async () => {
    const error = unreadableError();
    error.body = { ...error.body, pollMs: 2000 };
    vi.spyOn(api.documents, "sync").mockRejectedValue(error);

    const sync = await pollDocumentSync(DOC.id, false);
    expect(sync.status).toBe("remote-unreadable");
    expect(sync.pollMs).toBe(2000);
    expect(sync.size).toBe(3_800_000);
  });

  it("explains the size limit and leaves only force-publish available", () => {
    const actions: SyncActions = {
      merge: vi.fn(),
      keepMine: vi.fn(),
      takeRemote: vi.fn(),
      compare: vi.fn(),
    };
    const sync: SyncStatusDto = {
      ...IN_SYNC,
      status: "remote-unreadable",
      size: 3_800_000,
      limit: 2_097_152,
    };

    render(<SyncDialog open onOpenChange={vi.fn()} doc={DOC} sync={sync} actions={actions} />);

    expect(screen.getByTestId("sync-remote-unreadable")).toHaveTextContent("3.63 MB");
    expect(screen.getByTestId("sync-remote-unreadable")).toHaveTextContent("2 MB");
    expect(screen.getByTestId("sync-keep-mine")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-merge")).toBeNull();
    expect(screen.queryByTestId("sync-take-remote")).toBeNull();
    expect(screen.queryByTestId("sync-compare")).toBeNull();
  });
});

describe("Sync dialog action lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each([
    "document-object",
    "document-facts",
    "sync-snapshot",
    "sync-eligibility",
    "actions-object",
    "actions-method",
    "open-callback",
    "equal-value-remount",
    "removal",
  ] as const)("retires every callback publication before the parent layout boundary on %s replacement", async (replacement) => {
    const currentKeep = deferred<void>();
    const sharedMerge = vi.fn(async () => 0);
    const sharedTake = vi.fn(async () => undefined);
    const sharedCompare = vi.fn();
    const oldKeep = vi.fn(async () => undefined);
    const currentKeepAction = vi.fn(() => currentKeep.promise);
    const actionsA = syncActions({
      merge: sharedMerge,
      keepMine: replacement === "actions-method" ? oldKeep : currentKeepAction,
      takeRemote: sharedTake,
      compare: sharedCompare,
    });
    let actionsB = actionsA;
    let docB = DOC;
    let syncB: SyncStatusDto | null = DIVERGED;
    const onOpenA = vi.fn();
    let onOpenB = onOpenA;
    let mount: "initial" | "replacement" = "initial";
    let present = true;

    switch (replacement) {
      case "document-object":
        docB = { ...DOC };
        break;
      case "document-facts":
        docB = RENAMED_DOC;
        break;
      case "sync-snapshot":
        syncB = UPDATED_SYNC;
        break;
      case "sync-eligibility":
        syncB = UNREADABLE_SYNC;
        break;
      case "actions-object":
        actionsB = { ...actionsA };
        break;
      case "actions-method":
        syncB = { ...DIVERGED };
        break;
      case "open-callback":
        onOpenB = vi.fn();
        break;
      case "equal-value-remount":
        mount = "replacement";
        break;
      case "removal":
        present = false;
        break;
    }

    let passiveCleanups = 0;
    const view = renderDirect(
      <SyncBoundary actions={actionsA} onOpenChange={onOpenA} onPassiveCleanup={() => passiveCleanups++} />,
    );
    const stale = captureSyncCallbacks();
    if (replacement === "actions-method") actionsA.keepMine = currentKeepAction;
    const staleInput = stale.inputElement;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const observer = observeMutations(document.body);
    let boundaryValueRead!: ReturnType<typeof vi.fn>;
    let boundaryTimersBefore = -1;
    let boundaryTimersAfter = -1;
    let boundaryMutations = -1;
    let boundaryFocusBefore = -1;
    let boundaryFocusAfter = -1;

    act(() => {
      view.root.render(
        <SyncBoundary
          actions={actionsB}
          onOpenChange={onOpenB}
          doc={docB}
          sync={syncB}
          mount={mount}
          present={present}
          passiveVisit={1}
          boundary={1}
          onPassiveCleanup={() => passiveCleanups++}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            observer.takeRecords();
            focus.mockClear();
            boundaryTimersBefore = vi.getTimerCount();
            boundaryFocusBefore = focus.mock.calls.length;
            boundaryValueRead = invokeCapturedCallbacks(stale);
            boundaryTimersAfter = vi.getTimerCount();
            boundaryFocusAfter = focus.mock.calls.length;
            boundaryMutations = observer.takeRecords().length;
          }}
        />,
      );
    });

    expect(passiveCleanups).toBe(1);
    expect(boundaryValueRead).not.toHaveBeenCalled();
    expect(boundaryTimersAfter).toBe(boundaryTimersBefore);
    expect(boundaryFocusAfter).toBe(boundaryFocusBefore);
    expect(boundaryMutations).toBe(0);
    expect(sharedMerge).not.toHaveBeenCalled();
    expect(sharedTake).not.toHaveBeenCalled();
    expect(sharedCompare).not.toHaveBeenCalled();
    expect(oldKeep).not.toHaveBeenCalled();
    expect(currentKeepAction).not.toHaveBeenCalled();
    expect(onOpenA).not.toHaveBeenCalled();
    expect(onOpenB).not.toHaveBeenCalled();

    observer.takeRecords();
    focus.mockClear();
    let laterValueRead!: ReturnType<typeof vi.fn>;
    const laterTimersBefore = vi.getTimerCount();
    act(() => {
      laterValueRead = invokeCapturedCallbacks(stale);
    });
    expect(laterValueRead).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(observer.takeRecords()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(laterTimersBefore);
    expect(sharedMerge).not.toHaveBeenCalled();
    expect(sharedTake).not.toHaveBeenCalled();
    expect(sharedCompare).not.toHaveBeenCalled();
    expect(oldKeep).not.toHaveBeenCalled();
    expect(currentKeepAction).not.toHaveBeenCalled();
    expect(onOpenA).not.toHaveBeenCalled();
    expect(onOpenB).not.toHaveBeenCalled();

    if (!present) {
      expect(screen.queryByTestId("sync-dialog")).toBeNull();
      return;
    }

    const currentInput = screen.getByTestId("commit-message") as HTMLInputElement;
    if (replacement === "equal-value-remount") expect(currentInput).not.toBe(staleInput);
    else expect(currentInput).toBe(staleInput);
    if (replacement === "document-facts") expect(currentInput).toHaveValue("Update renamed.md");
    if (replacement === "sync-snapshot") {
      expect(screen.getByTestId("sync-local-lines")).toHaveTextContent("No changes");
      expect(screen.getByTestId("sync-remote-lines")).toHaveTextContent("8 lines changed");
      expect(screen.getByText(/updated /)).toBeInTheDocument();
    }
    if (replacement === "sync-eligibility") {
      expect(screen.getByTestId("sync-dialog")).toHaveAttribute("data-status", "remote-unreadable");
      expect(screen.queryByTestId("sync-merge")).toBeNull();
      expect(screen.queryByTestId("sync-take-remote")).toBeNull();
      expect(screen.queryByTestId("sync-compare")).toBeNull();
    }

    const beforeMessage = captureSyncCallbacks();
    act(() => {
      beforeMessage.inputElement.value = "  Current presentation message  ";
      beforeMessage.change({ currentTarget: beforeMessage.inputElement });
    });
    expect(screen.getByTestId("commit-message")).toHaveValue("  Current presentation message  ");
    const current = captureSyncCallbacks();
    act(() => {
      current.keep({ currentTarget: current.keepElement, defaultPrevented: false });
      current.keep({ currentTarget: current.keepElement, defaultPrevented: false });
      invokeCapturedCallbacks(stale);
    });

    expect(currentKeepAction).toHaveBeenCalledExactlyOnceWith("Current presentation message");
    expect(sharedMerge).not.toHaveBeenCalled();
    expect(sharedTake).not.toHaveBeenCalled();
    expect(sharedCompare).not.toHaveBeenCalled();
    expect(oldKeep).not.toHaveBeenCalled();
    expect(onOpenA).not.toHaveBeenCalled();
    expect(onOpenB).not.toHaveBeenCalled();
    expect(screen.getByTestId("commit-message")).toHaveValue("  Current presentation message  ");

    await act(async () => {
      currentKeep.resolve();
    });
    act(() => vi.advanceTimersByTime(899));
    expect(onOpenB).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onOpenB).toHaveBeenCalledExactlyOnceWith(false);
    if (onOpenA !== onOpenB) expect(onOpenA).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(900));
    expect(onOpenB).toHaveBeenCalledTimes(1);
  });

  it("binds message publications to the current input and Keep mine control", () => {
    const pending = deferred<void>();
    const keepMine = vi.fn(() => pending.promise);
    renderDirect(<SyncDialog open onOpenChange={vi.fn()} doc={DOC} sync={DIVERGED} actions={syncActions({ keepMine })} />);
    const old = captureSyncCallbacks();

    act(() => {
      old.inputElement.value = "  Fresh message  ";
      old.change({ currentTarget: old.inputElement });
    });
    expect(screen.getByTestId("commit-message")).toHaveValue("  Fresh message  ");

    const readOldValue = invokeCapturedCallbacks({
      ...old,
      merge: null,
      take: null,
      compare: null,
      close: () => {},
    });
    expect(readOldValue).not.toHaveBeenCalled();
    expect(keepMine).not.toHaveBeenCalled();
    expect(screen.getByTestId("commit-message")).toHaveValue("  Fresh message  ");

    const current = captureSyncCallbacks();
    act(() => {
      current.keep({ currentTarget: current.keepElement, defaultPrevented: false });
      current.keep({ currentTarget: current.keepElement, defaultPrevented: false });
    });
    expect(keepMine).toHaveBeenCalledExactlyOnceWith("Fresh message");
  });

  it("claims the exact current Close once and leaves all captured controls inert", () => {
    const actions = syncActions();
    const onOpenChange = vi.fn();
    renderDirect(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    const current = captureSyncCallbacks();
    const timersBefore = vi.getTimerCount();

    act(() => {
      fireEvent.click(current.closeElement);
      current.close({ currentTarget: current.closeElement, defaultPrevented: false });
      invokeCapturedCallbacks(current);
    });

    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(actions.merge).not.toHaveBeenCalled();
    expect(actions.keepMine).not.toHaveBeenCalled();
    expect(actions.takeRemote).not.toHaveBeenCalled();
    expect(actions.compare).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it("keeps the current Radix Escape close bound to its presentation", () => {
    const onOpenChange = vi.fn();
    renderDirect(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={syncActions()} />);

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("claims Compare synchronously, invokes it once, then closes through its frozen callback", () => {
    const order: string[] = [];
    const captured: CapturedSyncCallbacks[] = [];
    const onOpenChange = vi.fn(() => order.push("close"));
    const compare = vi.fn(() => {
      const callbacks = captured[0]!;
      order.push("compare");
      callbacks.compare?.({ currentTarget: callbacks.compareElement!, defaultPrevented: false });
      callbacks.close({ currentTarget: callbacks.closeElement, defaultPrevented: false });
    });
    const actions = syncActions({ compare });
    renderDirect(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    captured.push(captureSyncCallbacks());
    const callbacks = captured[0]!;
    const timersBefore = vi.getTimerCount();

    act(() => {
      callbacks.compare?.({ currentTarget: callbacks.compareElement!, defaultPrevented: false });
      callbacks.compare?.({ currentTarget: callbacks.compareElement!, defaultPrevented: false });
    });

    expect(order).toEqual(["compare", "close"]);
    expect(compare).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(actions.merge).not.toHaveBeenCalled();
    expect(actions.keepMine).not.toHaveBeenCalled();
    expect(actions.takeRemote).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it("synchronously admits only one action and exposes its pending state", () => {
    const pending = deferred<number>();
    const actions = syncActions({
      merge: vi.fn(() => {
        const takeButton = screen.getByTestId("sync-take-remote") as HTMLButtonElement;
        takeButton.click();
        takeButton.click();
        return pending.promise;
      }),
    });

    render(<SyncDialog open onOpenChange={vi.fn()} doc={DOC} sync={DIVERGED} actions={actions} />);

    fireEvent.click(screen.getByTestId("sync-merge"));

    expect(actions.merge).toHaveBeenCalledOnce();
    expect(actions.takeRemote).not.toHaveBeenCalled();
    expect(screen.getByTestId("sync-merge")).toBeDisabled();
    expect(screen.getByTestId("sync-keep-mine")).toBeDisabled();
    expect(screen.getByTestId("sync-take-remote")).toBeDisabled();
    expect(screen.getByTestId("sync-compare")).toBeDisabled();
    expect(screen.getByTestId("sync-merge").querySelector(".animate-spin")).not.toBeNull();
  });

  it("keeps a specific failure visible and admits exactly one same-action retry", async () => {
    const retry = deferred<number>();
    const merge = vi
      .fn<SyncActions["merge"]>()
      .mockRejectedValueOnce(new ApiError(409, "GitHub rejected this merge"))
      .mockImplementationOnce(() => {
        (screen.getByTestId("sync-merge") as HTMLButtonElement).click();
        return retry.promise;
      });
    const actions = syncActions({ merge });

    render(<SyncDialog open onOpenChange={vi.fn()} doc={DOC} sync={DIVERGED} actions={actions} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-merge"));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("GitHub rejected this merge");
    expect(screen.getByTestId("sync-merge")).toBeEnabled();
    expect(merge).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByTestId("sync-merge"));
    expect(merge).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      retry.resolve(2);
    });
    expect(merge).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("sync-done")).toHaveTextContent("2 conflicts to resolve in the editor");
  });

  it("ignores stale success and error settlements after close and reopen", async () => {
    const oldSuccess = deferred<number>();
    const oldFailure = deferred<number>();
    const merge = vi
      .fn<SyncActions["merge"]>()
      .mockImplementationOnce(() => oldSuccess.promise)
      .mockImplementationOnce(() => oldFailure.promise);
    const actions = syncActions({ merge });
    const onOpenChange = vi.fn();
    const view = render(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);

    fireEvent.click(screen.getByTestId("sync-merge"));
    view.rerender(<SyncDialog open={false} onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    view.rerender(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    await act(async () => {
      oldSuccess.resolve(3);
    });
    expect(screen.queryByTestId("sync-done")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByTestId("sync-merge"));
    view.rerender(<SyncDialog open={false} onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    view.rerender(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    await act(async () => {
      oldFailure.reject(new ApiError(409, "Stale GitHub failure"));
    });
    act(() => vi.advanceTimersByTime(900));

    expect(merge).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("sync-done")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("sync-merge")).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("isolates document state and a current pending action from an old finalizer", async () => {
    const oldMerge = deferred<number>();
    const currentKeep = deferred<void>();
    const actions = syncActions({
      merge: vi.fn(() => oldMerge.promise),
      keepMine: vi.fn(() => currentKeep.promise),
    });
    const view = render(<SyncDialog open onOpenChange={vi.fn()} doc={DOC} sync={DIVERGED} actions={actions} />);

    fireEvent.change(screen.getByTestId("commit-message"), { target: { value: "Old document message" } });
    fireEvent.click(screen.getByTestId("sync-merge"));
    view.rerender(<SyncDialog open onOpenChange={vi.fn()} doc={SECOND_DOC} sync={DIVERGED} actions={actions} />);

    expect(screen.getByTestId("commit-message")).toHaveValue("Update second.md");
    fireEvent.click(screen.getByTestId("sync-keep-mine"));
    expect(actions.keepMine).toHaveBeenCalledWith("Update second.md");

    await act(async () => {
      oldMerge.resolve(4);
    });
    expect(screen.getByTestId("commit-message")).toHaveValue("Update second.md");
    expect(screen.queryByTestId("sync-done")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("sync-keep-mine")).toBeDisabled();
    expect(screen.getByTestId("sync-keep-mine").querySelector(".animate-spin")).not.toBeNull();

    await act(async () => {
      currentKeep.resolve();
    });
    expect(screen.getByTestId("sync-done")).toHaveTextContent("Published your version");
  });

  it.each(["success", "failure"] as const)(
    "retires an old action %s before a same-id path replacement and cannot let its finalizer unlock newer work",
    async (outcome) => {
      const oldMerge = deferred<number>();
      const currentKeep = deferred<void>();
      const actions = syncActions({
        merge: vi.fn(() => oldMerge.promise),
        keepMine: vi.fn(() => currentKeep.promise),
      });
      const onOpenChange = vi.fn();
      const view = render(<SyncBoundary actions={actions} onOpenChange={onOpenChange} />);

      fireEvent.click(screen.getByTestId("sync-merge"));
      fireEvent.click(screen.getByTestId("sync-merge"));
      view.rerender(
        <SyncBoundary
          actions={actions}
          onOpenChange={onOpenChange}
          doc={RENAMED_DOC}
          boundary={1}
          onBoundary={() => {
            if (outcome === "success") oldMerge.resolve(3);
            else oldMerge.reject(new ApiError(503, "Obsolete GitHub failure"));
          }}
        />,
      );
      fireEvent.click(screen.getByTestId("sync-keep-mine"));
      await act(async () => {
        await Promise.resolve();
      });

      expect(actions.merge).toHaveBeenCalledTimes(1);
      expect(actions.keepMine).toHaveBeenCalledExactlyOnceWith("Update renamed.md");
      expect(screen.getByTestId("commit-message")).toHaveValue("Update renamed.md");
      expect(screen.queryByTestId("sync-done")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTestId("sync-keep-mine")).toBeDisabled();
      expect(screen.getByTestId("sync-keep-mine").querySelector(".animate-spin")).not.toBeNull();
      expect(onOpenChange).not.toHaveBeenCalled();

      await act(async () => {
        currentKeep.resolve();
      });
      expect(screen.getByTestId("sync-done")).toHaveTextContent("Published your version");
    },
  );

  it.each([
    { label: "close", open: false, present: true, outcome: "success" },
    { label: "unmount", open: true, present: false, outcome: "failure" },
  ] as const)("retires a pending action before the parent layout boundary on $label", async ({ open, present, outcome }) => {
    const pending = deferred<number>();
    const readMessage = vi.fn(() => "Obsolete GitHub failure");
    const failure = new Error();
    Object.defineProperty(failure, "message", { get: readMessage });
    const actions = syncActions({ merge: vi.fn(() => pending.promise) });
    const onOpenChange = vi.fn();
    const view = render(<SyncBoundary actions={actions} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByTestId("sync-merge"));
    view.rerender(
      <SyncBoundary
        actions={actions}
        onOpenChange={onOpenChange}
        open={open}
        present={present}
        boundary={1}
        onBoundary={() => {
          if (outcome === "success") pending.resolve(1);
          else pending.reject(failure);
        }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(900));

    expect(actions.merge).toHaveBeenCalledTimes(1);
    expect(readMessage).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears an old success-close timer before a replacement parent layout and only the newer visit closes", async () => {
    const currentKeep = deferred<void>();
    const actions = syncActions({ keepMine: vi.fn(() => currentKeep.promise) });
    const onOpenChange = vi.fn();
    const view = render(<SyncBoundary actions={actions} onOpenChange={onOpenChange} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-merge"));
    });
    const timersWithOldClose = vi.getTimerCount();
    expect(timersWithOldClose).toBeGreaterThan(0);

    let timersAtBoundary = -1;
    view.rerender(
      <SyncBoundary
        actions={actions}
        onOpenChange={onOpenChange}
        doc={RENAMED_DOC}
        boundary={1}
        onBoundary={() => {
          timersAtBoundary = vi.getTimerCount();
        }}
      />,
    );
    expect(timersAtBoundary).toBe(timersWithOldClose - 1);

    fireEvent.click(screen.getByTestId("sync-keep-mine"));
    expect(actions.keepMine).toHaveBeenCalledExactlyOnceWith("Update renamed.md");
    act(() => vi.advanceTimersByTime(900));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("sync-keep-mine")).toBeDisabled();

    await act(async () => {
      currentKeep.resolve();
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => vi.advanceTimersByTime(899));
    expect(onOpenChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    act(() => vi.advanceTimersByTime(900));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("invalidates an old close timer and closes exactly once for the current success", async () => {
    const currentKeep = deferred<void>();
    const actions = syncActions({ keepMine: vi.fn(() => currentKeep.promise) });
    const onOpenChange = vi.fn();
    const view = render(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-merge"));
    });
    expect(screen.getByTestId("sync-done")).toHaveTextContent("Merged — review, then publish");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    view.rerender(<SyncDialog open={false} onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    view.rerender(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    fireEvent.click(screen.getByTestId("sync-keep-mine"));

    act(() => vi.advanceTimersByTime(900));
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(screen.getByTestId("sync-keep-mine").querySelector(".animate-spin")).not.toBeNull();

    await act(async () => {
      currentKeep.resolve();
    });
    act(() => vi.advanceTimersByTime(899));
    expect(onOpenChange).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(1));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    act(() => vi.advanceTimersByTime(900));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it("invalidates pending settlements and delayed closes on unmount", async () => {
    const pending = deferred<number>();
    const onOpenChange = vi.fn();
    const pendingView = render(
      <SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={syncActions({ merge: vi.fn(() => pending.promise) })} />,
    );

    fireEvent.click(screen.getByTestId("sync-merge"));
    pendingView.unmount();
    await act(async () => {
      pending.resolve(1);
    });
    act(() => vi.advanceTimersByTime(900));
    expect(onOpenChange).not.toHaveBeenCalled();

    const timerView = render(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={syncActions()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-merge"));
    });
    timerView.unmount();
    act(() => vi.advanceTimersByTime(900));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("preserves Compare without starting a Sync action", () => {
    const actions = syncActions();
    const onOpenChange = vi.fn();
    render(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);

    fireEvent.click(screen.getByTestId("sync-compare"));

    expect(actions.compare).toHaveBeenCalledOnce();
    expect(actions.merge).not.toHaveBeenCalled();
    expect(actions.keepMine).not.toHaveBeenCalled();
    expect(actions.takeRemote).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
