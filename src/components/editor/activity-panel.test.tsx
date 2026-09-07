// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import type { CollabSession } from "@/editor/collab/session";
import type { ActivityItemDto, ActivityPageDto } from "@/lib/api";

const activity = vi.fn();
const unhandledRejections: unknown[] = [];
const recordUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(reason);
};

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    documents: {
      activity: (...args: unknown[]) => activity(...args),
    },
  },
}));

import { ActivityPanel } from "./activity-panel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function session(docId: string): CollabSession {
  return { docId } as unknown as CollabSession;
}

function ActivityBoundary({
  documentId,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  documentId: string;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <ActivityPanel session={session(documentId)} onClose={() => {}} /> : null;
}

function ActivityVisitBoundary({
  session,
  onClose,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  session: CollabSession;
  onClose: () => void;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <ActivityPanel session={session} onClose={onClose} /> : null;
}

function captureClick(element: HTMLElement): () => void {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the element");
  const props = (element as unknown as Record<string, { onClick?: () => void }>)[propsKey];
  if (!props.onClick) throw new Error("Element does not have an onClick handler");
  return props.onClick;
}

function row(id: string, actorName: string): ActivityItemDto {
  return {
    id,
    actorId: `user-${id}`,
    actorName,
    actorKind: "user",
    action: "edit",
    detail: {},
    createdAt: "2026-09-01T09:00:00.000Z",
  };
}

beforeEach(() => {
  activity.mockReset();
  unhandledRejections.length = 0;
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  process.off("unhandledRejection", recordUnhandledRejection);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(unhandledRejections).toEqual([]);
});

describe("ActivityPanel list recovery", () => {
  it("replaces an initial failure with an unfocused retry that makes one request and reaches the empty state", async () => {
    const retry = deferred<ActivityPageDto>();
    activity.mockRejectedValueOnce("offline").mockReturnValueOnce(retry.promise);

    render(<ActivityPanel session={session("activity-retry-empty")} onClose={vi.fn()} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load activity");
    expect(screen.getByTestId("activity-panel").querySelector(".animate-spin")).toBeNull();
    const retryButton = screen.getByRole("button", { name: "Retry" });
    expect(alert).not.toHaveFocus();
    expect(retryButton).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Close activity" })).toBeEnabled();

    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(activity).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    retry.resolve({ items: [], nextBefore: null });
    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(activity).toHaveBeenNthCalledWith(2, "activity-retry-empty", { limit: 50 });
  });

  it("keeps one first-page request through pending ticks and refreshes at the next tick after settlement", async () => {
    vi.useFakeTimers();
    const initial = deferred<ActivityPageDto>();
    const later = deferred<ActivityPageDto>();
    activity.mockReturnValueOnce(initial.promise).mockReturnValueOnce(later.promise);

    render(<ActivityPanel session={session("activity-coalesced")} onClose={vi.fn()} />);
    expect(activity).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(activity).toHaveBeenCalledTimes(1);

    initial.resolve({ items: [row("initial", "Initial editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.getByText("Initial editor")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(activity).toHaveBeenCalledTimes(2);
    expect(activity).toHaveBeenNthCalledWith(1, "activity-coalesced", { limit: 50 });
    expect(activity).toHaveBeenNthCalledWith(2, "activity-coalesced", { limit: 50 });

    later.resolve({ items: [row("later", "Later editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.getByText("Later editor")).toBeInTheDocument();
  });

  it.each(["stale-first", "current-first"] as const)(
    "gives a same-document replacement sole authority when %s work settles first",
    async (settlementOrder) => {
      const intervalCallbacks: Array<() => void> = [];
      const reusedHandle = 41 as unknown as ReturnType<typeof setInterval>;
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((handler) => {
        intervalCallbacks.push(handler as () => void);
        return reusedHandle;
      });
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
      const sharedPage = { items: [row("shared", "Shared editor")], nextBefore: "shared-cursor" };
      const failedRefresh = deferred<ActivityPageDto>();
      const retiredRetry = deferred<ActivityPageDto>();
      const retiredPage = deferred<ActivityPageDto>();
      const currentRefresh = deferred<ActivityPageDto>();
      const currentPage = deferred<ActivityPageDto>();
      const responses = [
        Promise.resolve(sharedPage),
        failedRefresh.promise,
        retiredRetry.promise,
        retiredPage.promise,
        currentRefresh.promise,
        currentPage.promise,
      ];
      activity.mockImplementation(() => {
        const response = responses.shift();
        if (!response) throw new Error("Unexpected activity request");
        return response;
      });
      const firstSession = session("same-document");
      const currentSession = session("same-document");
      const firstClose = vi.fn();
      const currentClose = vi.fn();

      const rendered = render(<ActivityVisitBoundary session={firstSession} onClose={firstClose} />);
      await act(async () => {});
      const oldClose = captureClick(screen.getByRole("button", { name: "Close activity" }));
      const oldLoadMore = captureClick(screen.getByRole("button", { name: "Load more" }));

      await act(async () => {
        intervalCallbacks[0]();
        failedRefresh.reject("refresh unavailable");
      });
      const oldRetry = captureClick(screen.getByRole("button", { name: "Retry" }));
      act(() => {
        oldRetry();
        oldLoadMore();
      });
      expect(activity).toHaveBeenCalledTimes(4);

      let clearsAtBoundary = -1;
      let intervalsAtBoundary = -1;
      rendered.rerender(
        <ActivityVisitBoundary
          session={currentSession}
          onClose={currentClose}
          boundary={1}
          onBoundary={() => {
            clearsAtBoundary = clearIntervalSpy.mock.calls.length;
            intervalsAtBoundary = setIntervalSpy.mock.calls.length;
          }}
        />,
      );

      expect(clearsAtBoundary).toBe(1);
      expect(intervalsAtBoundary).toBe(2);
      expect(activity).toHaveBeenCalledTimes(5);
      expect(screen.queryByText("Shared editor")).toBeNull();
      expect(screen.getByTestId("activity-panel").querySelector(".animate-spin")).not.toBeNull();

      intervalCallbacks[0]();
      oldRetry();
      oldLoadMore();
      oldClose();
      expect(activity).toHaveBeenCalledTimes(5);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(firstClose).not.toHaveBeenCalled();

      await act(async () => {
        intervalCallbacks[1]();
        intervalCallbacks[1]();
      });
      expect(activity).toHaveBeenCalledTimes(5);

      const settleRetired = async () => {
        retiredRetry.resolve(sharedPage);
        retiredPage.resolve(sharedPage);
        await Promise.all([retiredRetry.promise, retiredPage.promise]);
      };

      if (settlementOrder === "stale-first") {
        const beforeRetiredSettlements = screen.getByTestId("activity-panel").innerHTML;
        await act(settleRetired);
        expect(screen.getByTestId("activity-panel").innerHTML).toBe(beforeRetiredSettlements);
        currentRefresh.resolve(sharedPage);
        await act(async () => {});
      } else {
        currentRefresh.resolve(sharedPage);
        await act(async () => {});
        const beforeRetiredSettlements = screen.getByTestId("activity-panel").innerHTML;
        await act(settleRetired);
        expect(screen.getByTestId("activity-panel").innerHTML).toBe(beforeRetiredSettlements);
      }

      expect(screen.getByText("Shared editor")).toBeInTheDocument();
      const currentLoadMore = captureClick(screen.getByRole("button", { name: "Load more" }));
      act(() => {
        currentLoadMore();
        currentLoadMore();
      });
      expect(activity).toHaveBeenCalledTimes(6);
      expect(activity).toHaveBeenLastCalledWith("same-document", { before: "shared-cursor", limit: 50 });
      expect(screen.getByTestId("activity-load-more")).toBeDisabled();

      oldRetry();
      oldLoadMore();
      oldClose();
      intervalCallbacks[0]();
      expect(activity).toHaveBeenCalledTimes(6);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("activity-load-more")).toBeDisabled();

      currentPage.resolve({
        items: [row("older", "Earlier editor"), row("shared", "Duplicate shared editor")],
        nextBefore: null,
      });
      await act(async () => {});
      expect(screen.getAllByTestId("activity-row")).toHaveLength(2);
      expect(screen.getByText("Earlier editor")).toBeInTheDocument();
      expect(screen.queryByText("Duplicate shared editor")).toBeNull();

      const closeCurrent = captureClick(screen.getByRole("button", { name: "Close activity" }));
      closeCurrent();
      closeCurrent();
      intervalCallbacks[1]();
      expect(currentClose).toHaveBeenCalledOnce();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
      expect(clearIntervalSpy).toHaveBeenNthCalledWith(1, reusedHandle);
      expect(clearIntervalSpy).toHaveBeenNthCalledWith(2, reusedHandle);
      expect(activity).toHaveBeenCalledTimes(6);

      rendered.unmount();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    },
  );

  it("retires a callback-only visit before its replacement reaches the parent layout boundary", async () => {
    const intervalCallbacks: Array<() => void> = [];
    const reusedHandle = 73 as unknown as ReturnType<typeof setInterval>;
    vi.spyOn(globalThis, "setInterval").mockImplementation((handler) => {
      intervalCallbacks.push(handler as () => void);
      return reusedHandle;
    });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    const retiredRequest = deferred<ActivityPageDto>();
    const currentRequest = deferred<ActivityPageDto>();
    activity.mockReturnValueOnce(retiredRequest.promise).mockReturnValueOnce(currentRequest.promise);
    const stableSession = session("callback-replacement");
    const retiredClose = vi.fn();
    const currentClose = vi.fn();

    const rendered = render(<ActivityVisitBoundary session={stableSession} onClose={retiredClose} />);
    const oldClose = captureClick(screen.getByRole("button", { name: "Close activity" }));
    let clearsAtBoundary = -1;
    rendered.rerender(
      <ActivityVisitBoundary
        session={stableSession}
        onClose={currentClose}
        boundary={1}
        onBoundary={() => {
          clearsAtBoundary = clearIntervalSpy.mock.calls.length;
        }}
      />,
    );

    expect(clearsAtBoundary).toBe(1);
    expect(intervalCallbacks).toHaveLength(2);
    expect(activity).toHaveBeenCalledTimes(2);
    oldClose();
    intervalCallbacks[0]();
    expect(retiredClose).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    currentRequest.resolve({ items: [row("current", "Current editor")], nextBefore: null });
    await act(async () => {});
    const currentPublication = screen.getByTestId("activity-panel").innerHTML;
    retiredRequest.resolve({ items: [row("retired", "Retired editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.getByTestId("activity-panel").innerHTML).toBe(currentPublication);

    const closeCurrent = captureClick(screen.getByRole("button", { name: "Close activity" }));
    closeCurrent();
    closeCurrent();
    expect(currentClose).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    rendered.unmount();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps expanded rows through a refresh failure and a successful retry", async () => {
    vi.useFakeTimers();
    activity
      .mockResolvedValueOnce({ items: [row("recent", "Recent editor")], nextBefore: "older-than-recent" })
      .mockResolvedValueOnce({ items: [row("older", "Earlier editor")], nextBefore: null })
      .mockRejectedValueOnce("refresh unavailable")
      .mockResolvedValueOnce({ items: [row("fresh", "Newest editor")], nextBefore: null });

    render(<ActivityPanel session={session("activity-expanded")} onClose={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByText("Recent editor")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {});
    expect(screen.getByText("Earlier editor")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load activity");
    expect(screen.getByText("Recent editor")).toBeInTheDocument();
    expect(screen.getByText("Earlier editor")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Newest editor")).toBeInTheDocument();
    expect(screen.getByText("Recent editor")).toBeInTheDocument();
    expect(screen.getByText("Earlier editor")).toBeInTheDocument();
  });

  it("starts one page request for rapid activation and keeps the cursor retryable after failure", async () => {
    vi.useFakeTimers();
    const initial = deferred<ActivityPageDto>();
    const failedPage = deferred<ActivityPageDto>();
    const failedRefresh = deferred<ActivityPageDto>();
    const retriedPage = deferred<ActivityPageDto>();
    activity
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(failedPage.promise)
      .mockReturnValueOnce(failedRefresh.promise)
      .mockReturnValueOnce(retriedPage.promise);

    render(<ActivityPanel session={session("activity-page-retry")} onClose={vi.fn()} />);
    initial.resolve({ items: [row("recent", "Recent editor")], nextBefore: "older-cursor" });
    await act(async () => {});

    const loadMore = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);
    fireEvent.click(loadMore);
    expect(activity).toHaveBeenCalledTimes(2);
    expect(activity).toHaveBeenNthCalledWith(2, "activity-page-retry", { before: "older-cursor", limit: 50 });

    failedPage.reject("page unavailable");
    await act(async () => {});
    expect(screen.getByText("Failed to load more")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(activity).toHaveBeenCalledTimes(3);
    failedRefresh.reject("refresh unavailable");
    await act(async () => {});
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load activity");

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(activity).toHaveBeenCalledTimes(4);
    expect(activity).toHaveBeenNthCalledWith(4, "activity-page-retry", { before: "older-cursor", limit: 50 });

    retriedPage.resolve({ items: [row("older", "Earlier editor"), row("recent", "Duplicate recent editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.queryByText("Failed to load more")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load activity");
    expect(screen.getByText("Recent editor")).toBeInTheDocument();
    expect(screen.getByText("Earlier editor")).toBeInTheDocument();
    expect(screen.queryByText("Duplicate recent editor")).toBeNull();
    expect(screen.getAllByTestId("activity-row")).toHaveLength(2);
  });

  it("ignores an old-cursor success without appending, advancing, expanding, or unlocking the current page", async () => {
    vi.useFakeTimers();
    const oldPage = deferred<ActivityPageDto>();
    const currentPage = deferred<ActivityPageDto>();
    const laterPage = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({ items: [row("initial", "Initial editor")], nextBefore: "old-cursor" })
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ items: [row("fresh", "Fresh editor")], nextBefore: "current-cursor" })
      .mockReturnValueOnce(currentPage.promise)
      .mockReturnValueOnce(laterPage.promise);

    render(<ActivityPanel session={session("activity-stale-page-success")} onClose={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(activity).toHaveBeenNthCalledWith(4, "activity-stale-page-success", { before: "current-cursor", limit: 50 });
    expect(screen.getByTestId("activity-load-more")).toBeDisabled();

    oldPage.resolve({ items: [row("stale", "Stale editor")], nextBefore: "stale-next" });
    await act(async () => {});
    expect(screen.queryByText("Stale editor")).toBeNull();
    expect(screen.getByText("Fresh editor")).toBeInTheDocument();
    expect(screen.getByTestId("activity-load-more")).toBeDisabled();
    fireEvent.click(screen.getByTestId("activity-load-more"));
    expect(activity).toHaveBeenCalledTimes(4);

    currentPage.resolve({ items: [row("current", "Current older editor"), row("fresh", "Duplicate fresh editor")], nextBefore: "later-cursor" });
    await act(async () => {});
    expect(screen.getByText("Current older editor")).toBeInTheDocument();
    expect(screen.queryByText("Duplicate fresh editor")).toBeNull();
    expect(screen.getByTestId("activity-load-more")).toBeEnabled();
    expect(screen.getAllByTestId("activity-row")).toHaveLength(2);

    fireEvent.click(screen.getByTestId("activity-load-more"));
    expect(activity).toHaveBeenCalledTimes(5);
    expect(activity).toHaveBeenNthCalledWith(5, "activity-stale-page-success", { before: "later-cursor", limit: 50 });
    laterPage.resolve({ items: [row("last", "Last editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.getByText("Last editor")).toBeInTheDocument();
    expect(screen.queryByTestId("activity-load-more")).toBeNull();
  });

  it("ignores an old-cursor failure and finalizer while the current page is pending", async () => {
    vi.useFakeTimers();
    const oldPage = deferred<ActivityPageDto>();
    const currentPage = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({ items: [row("initial", "Initial editor")], nextBefore: "old-cursor" })
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ items: [row("fresh", "Fresh editor")], nextBefore: "current-cursor" })
      .mockReturnValueOnce(currentPage.promise);

    render(<ActivityPanel session={session("activity-stale-page-failure")} onClose={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    oldPage.reject("stale failure");
    await act(async () => {});
    expect(screen.queryByText("Failed to load more")).toBeNull();
    expect(screen.getByTestId("activity-load-more")).toBeDisabled();

    currentPage.reject("current failure");
    await act(async () => {});
    expect(screen.getByText("Failed to load more")).toBeInTheDocument();
    expect(screen.getByTestId("activity-load-more")).toBeEnabled();
  });

  it("ignores an older document response after the panel switches documents", async () => {
    const oldRequest = deferred<ActivityPageDto>();
    activity.mockImplementation((docId: string) =>
      docId === "activity-old"
        ? oldRequest.promise
        : Promise.resolve({ items: [row("new", "New document editor")], nextBefore: null }),
    );

    const rendered = render(<ActivityPanel session={session("activity-old")} onClose={vi.fn()} />);
    await waitFor(() => expect(activity).toHaveBeenCalledWith("activity-old", { limit: 50 }));
    rendered.rerender(<ActivityPanel session={session("activity-new")} onClose={vi.fn()} />);
    expect(await screen.findByText("New document editor")).toBeInTheDocument();

    oldRequest.resolve({ items: [row("old", "Old document editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.getByText("New document editor")).toBeInTheDocument();
    expect(screen.queryByText("Old document editor")).toBeNull();
  });

  it.each(["success", "failure"] as const)(
    "retires an old document before its deferred %s settles at the replacement layout boundary",
    async (outcome) => {
      vi.useFakeTimers();
      const oldRequest = deferred<ActivityPageDto>();
      const currentRequest = deferred<ActivityPageDto>();
      const laterRequest = deferred<ActivityPageDto>();
      activity
        .mockReturnValueOnce(oldRequest.promise)
        .mockReturnValueOnce(currentRequest.promise)
        .mockReturnValueOnce(laterRequest.promise);

      const rendered = render(<ActivityBoundary documentId="activity-boundary-old" />);
      expect(activity).toHaveBeenCalledTimes(1);

      rendered.rerender(
        <ActivityBoundary
          documentId="activity-boundary-current"
          boundary={1}
          onBoundary={() => {
            if (outcome === "success") {
              oldRequest.resolve({ items: [row("retired", "Retired document editor")], nextBefore: "retired-cursor" });
            } else {
              oldRequest.reject("retired document failure");
            }
          }}
        />,
      );
      await act(async () => {
        await Promise.allSettled([oldRequest.promise]);
      });

      expect(activity).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Retired document editor")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTestId("activity-panel").querySelector(".animate-spin")).not.toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
      expect(activity).toHaveBeenCalledTimes(2);

      currentRequest.resolve({ items: [row("current", "Current document editor")], nextBefore: null });
      await act(async () => {});
      expect(screen.getByText("Current document editor")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(activity).toHaveBeenCalledTimes(3);
      expect(activity).toHaveBeenNthCalledWith(3, "activity-boundary-current", { limit: 50 });
      laterRequest.resolve({ items: [row("later", "Later current editor")], nextBefore: null });
      await act(async () => {});
      expect(screen.getByText("Later current editor")).toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(1);
    },
  );

  it("invalidates pending work synchronously when Close is activated", async () => {
    vi.useFakeTimers();
    const pending = deferred<ActivityPageDto>();
    const onClose = vi.fn();
    activity.mockReturnValueOnce(pending.promise);

    render(<ActivityPanel session={session("activity-close")} onClose={onClose} />);
    expect(vi.getTimerCount()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Close activity" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(activity).toHaveBeenCalledOnce();

    pending.resolve({ items: [row("late", "Late editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.queryByText("Late editor")).toBeNull();
  });

  it("retires page, refresh, and cadence work before settlements at the removal layout boundary", async () => {
    vi.useFakeTimers();
    const page = deferred<ActivityPageDto>();
    const refresh = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({ items: [row("initial", "Initial editor")], nextBefore: "older-cursor" })
      .mockReturnValueOnce(page.promise)
      .mockReturnValueOnce(refresh.promise);

    const rendered = render(<ActivityBoundary documentId="activity-boundary-removal" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(activity).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    let timersAtBoundary = -1;

    rendered.rerender(
      <ActivityBoundary
        documentId="activity-boundary-removal"
        present={false}
        boundary={1}
        onBoundary={() => {
          timersAtBoundary = vi.getTimerCount();
          page.resolve({ items: [row("retired-page", "Retired page editor")], nextBefore: "retired-next" });
          refresh.reject("retired refresh failure");
        }}
      />,
    );
    await act(async () => {
      await Promise.allSettled([page.promise, refresh.promise]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });

    expect(timersAtBoundary).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(activity).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("activity-panel")).toBeNull();
    expect(screen.queryByText("Retired page editor")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(unhandledRejections).toEqual([]);
  });

  it("handles late page resolution and refresh rejection after unmount without committing", async () => {
    vi.useFakeTimers();
    const page = deferred<ActivityPageDto>();
    const refresh = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({ items: [row("initial", "Initial editor")], nextBefore: "older-cursor" })
      .mockReturnValueOnce(page.promise)
      .mockReturnValueOnce(refresh.promise);

    const rendered = render(<ActivityPanel session={session("activity-unmount")} onClose={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(activity).toHaveBeenCalledTimes(3);

    rendered.unmount();
    page.resolve({ items: [row("late-page", "Late page editor")], nextBefore: null });
    refresh.reject("late refresh failure");
    await act(async () => {});
    expect(screen.queryByTestId("activity-panel")).toBeNull();
    expect(unhandledRejections).toEqual([]);
  });
});
