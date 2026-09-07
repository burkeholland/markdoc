// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
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

function SyncBoundary({
  actions,
  onOpenChange,
  doc = DOC,
  open = true,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  actions: SyncActions;
  onOpenChange: (open: boolean) => void;
  doc?: DocumentDto;
  open?: boolean;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);

  return present ? <SyncDialog open={open} onOpenChange={onOpenChange} doc={doc} sync={DIVERGED} actions={actions} /> : null;
}

afterEach(() => {
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
