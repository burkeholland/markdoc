// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    activity
      .mockResolvedValueOnce({ items: [row("initial", "Initial editor")], nextBefore: "old-cursor" })
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ items: [row("fresh", "Fresh editor")], nextBefore: "current-cursor" })
      .mockReturnValueOnce(currentPage.promise);

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

    currentPage.resolve({ items: [row("current", "Current older editor"), row("fresh", "Duplicate fresh editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.getByText("Current older editor")).toBeInTheDocument();
    expect(screen.queryByText("Duplicate fresh editor")).toBeNull();
    expect(screen.queryByTestId("activity-load-more")).toBeNull();
    expect(screen.getAllByTestId("activity-row")).toHaveLength(2);
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

  it("invalidates pending work synchronously when Close is activated", async () => {
    const pending = deferred<ActivityPageDto>();
    const onClose = vi.fn();
    activity.mockReturnValueOnce(pending.promise);

    render(<ActivityPanel session={session("activity-close")} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close activity" }));
    expect(onClose).toHaveBeenCalledOnce();

    pending.resolve({ items: [row("late", "Late editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.queryByText("Late editor")).toBeNull();
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
