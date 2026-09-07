// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CollabSession } from "@/editor/collab/session";
import type { ActivityItemDto, ActivityPageDto } from "@/lib/api";

const activity = vi.fn();
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
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("ActivityPanel list recovery", () => {
  it("replaces an initial failure with an unfocused retry that makes one request and reaches the empty state", async () => {
    const retry = deferred<ActivityPageDto>();
    const onClose = vi.fn();
    activity.mockRejectedValueOnce("offline").mockReturnValueOnce(retry.promise);

    render(<ActivityPanel session={session("activity-retry-empty")} onClose={onClose} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load activity");
    expect(screen.getByTestId("activity-panel").querySelector(".animate-spin")).toBeNull();
    const retryButton = screen.getByRole("button", { name: "Retry" });
    expect(alert).not.toHaveFocus();
    expect(retryButton).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Close activity" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Close activity" }));
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(activity).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    retry.resolve({ items: [], nextBefore: null });
    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(activity).toHaveBeenNthCalledWith(2, "activity-retry-empty", { limit: 50 });
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
});
