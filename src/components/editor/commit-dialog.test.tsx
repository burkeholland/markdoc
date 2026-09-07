// @vitest-environment jsdom
import { useEffect, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { DocumentDto } from "@/server/dto";

vi.mock("./gist-auto-update", () => ({
  GistAutoUpdateControl: ({ doc, isOwner }: { doc: DocumentDto; isOwner: boolean }) => (
    <div data-testid="gist-auto-update-stub" data-document={doc.id} data-owner={isOwner} />
  ),
}));

import { CommitDialog } from "./github-dialog";

interface CommitActions {
  onCommit: ReturnType<typeof vi.fn<(message: string) => Promise<void>>>;
  onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
}

interface CommitBoundaryProps {
  visit: string;
  doc: DocumentDto;
  actions: CommitActions;
  open?: boolean;
  present?: boolean;
  isOwner?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function repoDocument(id: string, path: string): DocumentDto {
  return {
    id,
    title: id,
    storage: "repo",
    linkAccess: "private",
    ownerId: "owner",
    gistId: null,
    gistFile: null,
    repoOwner: "octo",
    repoName: "notes",
    repoBranch: "main",
    repoPath: path,
    publishedAt: "2026-09-07T12:00:00.000Z",
    hasUnpublishedChanges: true,
    githubUrl: `https://github.com/octo/notes/blob/main/${path}`,
    createdAt: "2026-09-07T11:00:00.000Z",
    updatedAt: "2026-09-07T12:00:00.000Z",
  };
}

function actions(...answers: Promise<void>[]): CommitActions {
  const onCommit = vi.fn<(message: string) => Promise<void>>();
  for (const answer of answers) onCommit.mockReturnValueOnce(answer);
  return { onCommit, onOpenChange: vi.fn() };
}

function CommitBoundary({
  visit,
  doc,
  actions: currentActions,
  open = true,
  present = true,
  isOwner = true,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: CommitBoundaryProps) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => () => onPassiveCleanup?.(), [onPassiveCleanup, visit]);
  return present ? (
    <CommitDialog
      open={open}
      onOpenChange={currentActions.onOpenChange}
      doc={doc}
      onCommit={currentActions.onCommit}
      isOwner={isOwner}
    />
  ) : null;
}

function createHost() {
  const host = document.createElement("div");
  document.body.append(host);
  return { host, root: createRoot(host) };
}

async function render(root: Root, props: CommitBoundaryProps) {
  await act(async () => {
    root.render(<CommitBoundary {...props} />);
  });
}

function message() {
  return screen.getByTestId<HTMLInputElement>("commit-message");
}

function submit() {
  fireEvent.submit(screen.getByTestId("commit-submit").closest("form")!);
}

async function resolve(pending: ReturnType<typeof deferred<void>>) {
  await act(async () => {
    pending.resolve();
    await pending.promise;
  });
}

async function reject(pending: ReturnType<typeof deferred<void>>, text: string) {
  await act(async () => {
    pending.reject(new Error(text));
    await pending.promise.catch(() => undefined);
  });
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function commitTimerCall(spy: MockInstance<typeof setTimeout>, index = 0) {
  const matches = spy.mock.calls
    .map((call, callIndex) => ({ call, callIndex }))
    .filter(({ call }) => call[1] === 900);
  const match = matches[index];
  expect(match).toBeDefined();
  const callback = match!.call[0];
  expect(callback).toBeTypeOf("function");
  return {
    callback: callback as () => void,
    handle: spy.mock.results[match!.callIndex].value as ReturnType<typeof setTimeout>,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CommitDialog visit authority", () => {
  it("claims one trimmed submit and closes its exact current success once at 900 ms", async () => {
    const pending = deferred<void>();
    const current = actions(pending.promise);
    const doc = repoDocument("doc-current", "docs/current.md");
    const { host, root } = createHost();

    try {
      await render(root, { visit: "current", doc, actions: current });
      await advance(0);
      expect(message()).toHaveValue("Update docs/current.md");
      expect(message()).toHaveFocus();
      fireEvent.change(message(), { target: { value: "  Publish current draft  " } });

      act(() => {
        submit();
        submit();
      });

      expect(current.onCommit).toHaveBeenCalledExactlyOnceWith("Publish current draft");
      expect(screen.getByTestId("commit-submit")).toBeDisabled();
      await resolve(pending);
      expect(screen.getByRole("button", { name: "Published" })).toBeDisabled();

      await advance(899);
      expect(current.onOpenChange).not.toHaveBeenCalled();
      await advance(1);
      expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);

      submit();
      expect(current.onCommit).toHaveBeenCalledTimes(1);
      await advance(5_000);
      expect(current.onOpenChange).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["success", "rejection"] as const)(
    "keeps a reopened visit pending and clean through the retired visit's late $stale",
    async (stale) => {
      const oldPending = deferred<void>();
      const currentPending = deferred<void>();
      const retryPending = deferred<void>();
      const current = actions(oldPending.promise, currentPending.promise, retryPending.promise);
      const doc = repoDocument("doc-reopen", "docs/reopen.md");
      const { host, root } = createHost();

      try {
        await render(root, { visit: "old", doc, actions: current });
        fireEvent.change(message(), { target: { value: "Old draft" } });
        submit();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);

        await render(root, { visit: "closed", doc, actions: current, open: false });
        await render(root, { visit: "current", doc, actions: current });
        expect(message()).toHaveValue("Update docs/reopen.md");
        expect(screen.getByTestId("commit-submit")).toBeEnabled();
        fireEvent.change(message(), { target: { value: "  Current pending  " } });
        submit();
        expect(current.onCommit).toHaveBeenNthCalledWith(2, "Current pending");
        expect(screen.getByTestId("commit-submit")).toBeDisabled();

        if (stale === "success") await resolve(oldPending);
        else await reject(oldPending, "Old publish failed");
        expect(message()).toHaveValue("  Current pending  ");
        expect(screen.getByTestId("commit-submit")).toBeDisabled();
        expect(screen.queryByText("Old publish failed")).toBeNull();
        expect(screen.queryByRole("button", { name: "Published" })).toBeNull();
        expect(current.onOpenChange).toHaveBeenCalledTimes(1);

        fireEvent.change(message(), { target: { value: "  Current retry  " } });
        await reject(currentPending, "Current publish failed");
        expect(screen.getByText("Current publish failed")).toBeInTheDocument();
        expect(screen.getByTestId("commit-submit")).toBeEnabled();
        submit();
        expect(current.onCommit).toHaveBeenNthCalledWith(3, "Current retry");
        await resolve(retryPending);
        expect(screen.getByRole("button", { name: "Published" })).toBeDisabled();
        await advance(900);
        expect(current.onOpenChange).toHaveBeenCalledTimes(2);
        expect(current.onOpenChange).toHaveBeenLastCalledWith(false);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["different-document", "same-document-callback", "removal"] as const)(
    "retires a successful timer before parent layout on $transition and leaves the next visit usable",
    async (transition) => {
      const timeout = vi.spyOn(globalThis, "setTimeout");
      const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
      const oldPending = deferred<void>();
      const currentPending = deferred<void>();
      const oldActions = actions(oldPending.promise);
      const currentActions = actions(currentPending.promise);
      const oldDoc = repoDocument("doc-old", "docs/old.md");
      const currentDoc = transition === "same-document-callback" ? oldDoc : repoDocument("doc-current", "docs/current.md");
      const { host, root } = createHost();
      let passiveCleanups = 0;
      const onPassiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        await render(root, { visit: "old", doc: oldDoc, actions: oldActions, onPassiveCleanup });
        await advance(0);
        fireEvent.change(message(), { target: { value: "Old content" } });
        submit();
        await resolve(oldPending);
        const oldTimer = commitTimerCall(timeout);
        expect(screen.getByRole("button", { name: "Published" })).toBeDisabled();

        let boundaryReached!: () => void;
        const atBoundary = new Promise<void>((done) => {
          boundaryReached = done;
        });
        let passiveAtBoundary = -1;
        let oldTimerClearedAtBoundary = false;
        let oldCloseCallsAtBoundary = -1;
        let currentCloseCallsAtBoundary = -1;
        root.render(
          <CommitBoundary
            visit="current"
            doc={currentDoc}
            actions={currentActions}
            present={transition !== "removal"}
            boundary={1}
            onPassiveCleanup={onPassiveCleanup}
            onBoundary={() => {
              passiveAtBoundary = passiveCleanups;
              oldTimerClearedAtBoundary = clearTimeout.mock.calls.some(([handle]) => handle === oldTimer.handle);
              oldTimer.callback();
              oldCloseCallsAtBoundary = oldActions.onOpenChange.mock.calls.length;
              currentCloseCallsAtBoundary = currentActions.onOpenChange.mock.calls.length;
              boundaryReached();
            }}
          />,
        );
        await atBoundary;

        expect(passiveAtBoundary).toBe(0);
        expect(oldTimerClearedAtBoundary).toBe(true);
        expect(oldCloseCallsAtBoundary).toBe(0);
        expect(currentCloseCallsAtBoundary).toBe(0);
        await act(async () => {});

        if (transition === "removal") {
          expect(screen.queryByRole("dialog")).toBeNull();
          await render(root, { visit: "current-mounted", doc: currentDoc, actions: currentActions, boundary: 2, onPassiveCleanup });
        }

        expect(message()).toHaveValue(`Update ${currentDoc.repoPath}`);
        expect(screen.getByTestId("commit-submit")).toBeEnabled();
        expect(screen.queryByRole("button", { name: "Published" })).toBeNull();
        fireEvent.change(message(), { target: { value: "  Current content  " } });
        submit();
        expect(currentActions.onCommit).toHaveBeenCalledExactlyOnceWith("Current content");
        await resolve(currentPending);
        oldTimer.callback();
        expect(oldActions.onOpenChange).not.toHaveBeenCalled();
        expect(currentActions.onOpenChange).not.toHaveBeenCalled();
        await advance(900);
        expect(currentActions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "isolates pending replacement settlement and finalizer order: $order",
    async (order) => {
      const oldPending = deferred<void>();
      const currentPending = deferred<void>();
      const oldActions = actions(oldPending.promise);
      const currentActions = actions(currentPending.promise);
      const doc = repoDocument("doc-shared", "docs/shared.md");
      const { host, root } = createHost();

      try {
        await render(root, { visit: "old", doc, actions: oldActions });
        fireEvent.change(message(), { target: { value: "Old pending" } });
        submit();
        await render(root, { visit: "current", doc, actions: currentActions });
        fireEvent.change(message(), { target: { value: "Current pending" } });
        submit();
        expect(screen.getByTestId("commit-submit")).toBeDisabled();

        if (order === "stale-before-current") {
          await reject(oldPending, "Retired failure");
          expect(screen.getByTestId("commit-submit")).toBeDisabled();
          expect(screen.queryByText("Retired failure")).toBeNull();
          await resolve(currentPending);
        } else {
          await resolve(currentPending);
          expect(screen.getByRole("button", { name: "Published" })).toBeDisabled();
          await reject(oldPending, "Retired failure");
        }

        expect(message()).toHaveValue("Current pending");
        expect(screen.getByRole("button", { name: "Published" })).toBeDisabled();
        expect(screen.queryByText("Retired failure")).toBeNull();
        expect(oldActions.onOpenChange).not.toHaveBeenCalled();
        await advance(900);
        expect(currentActions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "keeps a reused current timer handle owned in $order callback order",
    async (order) => {
      const fakeSetTimeout = globalThis.setTimeout;
      const sharedHandle = { shared: true } as unknown as ReturnType<typeof setTimeout>;
      const closeCallbacks: Array<() => void> = [];
      const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay === 900) {
          closeCallbacks.push(callback as () => void);
          return sharedHandle;
        }
        return fakeSetTimeout(callback, delay, ...args);
      }) as typeof setTimeout);
      const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
      const oldPending = deferred<void>();
      const currentPending = deferred<void>();
      const oldActions = actions(oldPending.promise);
      const currentActions = actions(currentPending.promise);
      const doc = repoDocument("doc-timer", "docs/timer.md");
      const { host, root } = createHost();

      try {
        await render(root, { visit: "old", doc, actions: oldActions });
        submit();
        await resolve(oldPending);
        expect(closeCallbacks).toHaveLength(1);

        await render(root, { visit: "current", doc, actions: currentActions });
        expect(clearTimeout).toHaveBeenCalledExactlyOnceWith(sharedHandle);
        submit();
        await resolve(currentPending);
        expect(closeCallbacks).toHaveLength(2);

        if (order === "stale-before-current") {
          act(() => closeCallbacks[0]());
          expect(currentActions.onOpenChange).not.toHaveBeenCalled();
          expect(clearTimeout).toHaveBeenCalledTimes(1);
          act(() => closeCallbacks[1]());
        } else {
          act(() => closeCallbacks[1]());
          act(() => closeCallbacks[0]());
        }

        expect(oldActions.onOpenChange).not.toHaveBeenCalled();
        expect(currentActions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
        expect(clearTimeout).toHaveBeenCalledTimes(1);
        expect(timeout.mock.calls.filter((call) => call[1] === 900)).toHaveLength(2);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("binds the owner-only gist control and Cancel to the replacement visit", async () => {
    const oldActions = actions();
    const currentActions = actions();
    const oldDoc = repoDocument("doc-old-owner", "docs/old-owner.md");
    const currentDoc = {
      ...repoDocument("doc-current-owner", "docs/current-owner.md"),
      storage: "gist" as const,
      gistId: "gist-current",
      gistFile: "current.md",
      repoOwner: null,
      repoName: null,
      repoBranch: null,
      repoPath: null,
      githubUrl: "https://gist.github.com/gist-current",
    };
    const { host, root } = createHost();

    try {
      await render(root, { visit: "old", doc: oldDoc, actions: oldActions, isOwner: false });
      await render(root, { visit: "current", doc: currentDoc, actions: currentActions, isOwner: true });
      expect(screen.getByTestId("gist-auto-update-stub")).toHaveAttribute("data-document", currentDoc.id);
      expect(screen.getByTestId("gist-auto-update-stub")).toHaveAttribute("data-owner", "true");
      expect(message()).toHaveValue("Update current.md");
      fireEvent.change(message(), { target: { value: "Manual gist description" } });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(oldActions.onOpenChange).not.toHaveBeenCalled();
      expect(currentActions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
