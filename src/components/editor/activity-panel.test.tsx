// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useEffect, useLayoutEffect, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
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
  instance = "activity",
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  session: CollabSession;
  onClose: () => void;
  present?: boolean;
  instance?: string;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? (
    <ActivityMount
      key={instance}
      session={session}
      onClose={onClose}
      onPassiveCleanup={onPassiveCleanup}
    />
  ) : null;
}

function ActivityMount({
  session,
  onClose,
  onPassiveCleanup,
}: {
  session: CollabSession;
  onClose: () => void;
  onPassiveCleanup?: () => void;
}) {
  useEffect(() => onPassiveCleanup, [onPassiveCleanup]);
  return <ActivityPanel session={session} onClose={onClose} />;
}

interface CapturedMouseEvent {
  type: string;
  currentTarget: EventTarget | null;
  target: EventTarget | null;
  nativeEvent: Event;
  defaultPrevented: boolean;
}

type ClickHandler = (event: CapturedMouseEvent) => void;
type ElementRef<T extends HTMLElement> = (element: T | null) => void;

interface CapturedControl {
  element: HTMLButtonElement;
  click: ClickHandler;
  ref: ElementRef<HTMLButtonElement>;
}

function reactProperty<T>(element: HTMLElement, name: string): T | undefined {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the element");
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  return props?.[name] as T | undefined;
}

function reactHandler<T extends (...args: never[]) => unknown>(
  element: HTMLElement,
  name: string,
): T {
  const handler = reactProperty<T>(element, name);
  if (typeof handler !== "function") throw new Error(`Element does not have an ${name} handler`);
  return handler;
}

function reactRef<T extends HTMLElement>(element: T): ElementRef<T> {
  const ref = reactProperty<ElementRef<T>>(element, "ref");
  if (typeof ref === "function") return ref;
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error("React fiber was not attached to the element");
  const fiber = (element as unknown as Record<string, { ref?: unknown }>)[fiberKey];
  if (typeof fiber.ref !== "function") throw new Error("Element does not have a callback ref");
  return fiber.ref as ElementRef<T>;
}

function captureControl(element: HTMLElement): CapturedControl {
  if (!(element instanceof HTMLButtonElement)) throw new Error("Expected a button control");
  return {
    element,
    click: reactHandler<ClickHandler>(element, "onClick"),
    ref: reactRef(element),
  };
}

function capturedMouseEvent(
  control: CapturedControl,
  source: EventTarget | null = control.element,
  target: EventTarget | null = source,
  nativeTarget: EventTarget | null = target,
): CapturedMouseEvent {
  const ownerDocument = source instanceof Node ? source.ownerDocument ?? document : document;
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  const nativeEvent = new MouseEventConstructor("click", { bubbles: true });
  Object.defineProperty(nativeEvent, "target", { configurable: true, value: nativeTarget });
  return {
    type: "click",
    currentTarget: source,
    target,
    nativeEvent,
    defaultPrevented: false,
  };
}

function invoke(
  control: CapturedControl,
  source: EventTarget | null = control.element,
  target: EventTarget | null = source,
) {
  control.click(capturedMouseEvent(control, source, target));
}

function captureClick(element: HTMLElement): () => void {
  const control = captureControl(element);
  return () => invoke(control);
}

const directRoots = new Set<Root>();

function createDirectActivity(
  props: ComponentProps<typeof ActivityVisitBoundary>,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  directRoots.add(root);
  act(() => root.render(<ActivityVisitBoundary {...props} />));
  return { host, root };
}

function renderDirectActivity(
  root: Root,
  props: ComponentProps<typeof ActivityVisitBoundary>,
) {
  act(() => root.render(<ActivityVisitBoundary {...props} />));
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
  for (const root of directRoots) act(() => root.unmount());
  directRoots.clear();
  document.body.replaceChildren();
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
      });
      const currentLoadMoreAfterRetry = captureClick(
        screen.getByRole("button", { name: "Load more" }),
      );
      act(() => currentLoadMoreAfterRetry());
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

describe("ActivityPanel exact action publications", () => {
  it("keeps current actions usable after Strict Mode replay while retired refs and handlers stay inert", async () => {
    const loadPage = deferred<ActivityPageDto>();
    activity.mockImplementation((documentId: string, options: { before?: string }) => {
      if (documentId === "strict-close") {
        return Promise.resolve({ items: [], nextBefore: null });
      }
      if (documentId === "strict-retry") {
        return Promise.reject("offline");
      }
      if (documentId === "strict-load") {
        return options.before
          ? loadPage.promise
          : Promise.resolve({
              items: [row("strict-row", "Strict editor")],
              nextBefore: "strict-cursor",
            });
      }
      throw new Error(`Unexpected document: ${documentId}`);
    });
    const closeSession = session("strict-close");
    const retrySession = session("strict-retry");
    const loadSession = session("strict-load");
    const retiredClose = vi.fn();
    const currentClose = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    directRoots.add(root);
    const renderPanels = (instance: string, onClose: () => void) => (
      <StrictMode>
        <section key={instance}>
          <ActivityPanel session={closeSession} onClose={onClose} />
          <ActivityPanel session={retrySession} onClose={() => {}} />
          <ActivityPanel session={loadSession} onClose={() => {}} />
        </section>
      </StrictMode>
    );

    act(() => root.render(renderPanels("A", retiredClose)));
    await act(async () => {});
    const retiredPanels = screen.getAllByTestId("activity-panel");
    const retiredCloseControl = captureControl(
      within(retiredPanels[0]!).getByRole("button", { name: "Close activity" }),
    );
    const retiredRetryControl = captureControl(
      within(retiredPanels[1]!).getByRole("button", { name: "Retry" }),
    );
    const retiredLoadControl = captureControl(
      within(retiredPanels[2]!).getByRole("button", { name: "Load more" }),
    );

    act(() => root.render(renderPanels("B", currentClose)));
    await act(async () => {});
    const currentPanels = screen.getAllByTestId("activity-panel");
    const currentCloseControl = captureControl(
      within(currentPanels[0]!).getByRole("button", { name: "Close activity" }),
    );
    const currentRetryControl = captureControl(
      within(currentPanels[1]!).getByRole("button", { name: "Retry" }),
    );
    const currentLoadControl = captureControl(
      within(currentPanels[2]!).getByRole("button", { name: "Load more" }),
    );
    expect(currentCloseControl.element).not.toBe(retiredCloseControl.element);
    expect(currentRetryControl.element).not.toBe(retiredRetryControl.element);
    expect(currentLoadControl.element).not.toBe(retiredLoadControl.element);
    expect(currentCloseControl.ref).not.toBe(retiredCloseControl.ref);
    expect(currentRetryControl.ref).not.toBe(retiredRetryControl.ref);
    expect(currentLoadControl.ref).not.toBe(retiredLoadControl.ref);
    const callsBeforeActions = activity.mock.calls.length;

    act(() => {
      retiredCloseControl.ref(currentCloseControl.element);
      retiredRetryControl.ref(currentRetryControl.element);
      retiredLoadControl.ref(currentLoadControl.element);
      retiredLoadControl.ref(null);
      retiredRetryControl.ref(null);
      retiredCloseControl.ref(null);
      invoke(retiredCloseControl, currentCloseControl.element);
      invoke(retiredRetryControl, currentRetryControl.element);
      invoke(retiredLoadControl, currentLoadControl.element);
      invoke(currentCloseControl, retiredCloseControl.element);
      invoke(currentRetryControl, retiredRetryControl.element);
      invoke(currentLoadControl, retiredLoadControl.element);
    });
    expect(activity).toHaveBeenCalledTimes(callsBeforeActions);
    expect(retiredClose).not.toHaveBeenCalled();
    expect(currentClose).not.toHaveBeenCalled();

    const closeEvent = capturedMouseEvent(currentCloseControl);
    const retryEvent = capturedMouseEvent(currentRetryControl);
    const loadEvent = capturedMouseEvent(currentLoadControl);
    act(() => {
      currentCloseControl.click(closeEvent);
      currentCloseControl.click(closeEvent);
      currentRetryControl.click(retryEvent);
      currentRetryControl.click(retryEvent);
      currentLoadControl.click(loadEvent);
      currentLoadControl.click(loadEvent);
    });

    expect(retiredClose).not.toHaveBeenCalled();
    expect(currentClose).toHaveBeenCalledOnce();
    expect(activity).toHaveBeenCalledTimes(callsBeforeActions + 2);
    expect(activity).toHaveBeenNthCalledWith(callsBeforeActions + 1, "strict-retry", {
      limit: 50,
    });
    expect(activity).toHaveBeenNthCalledWith(callsBeforeActions + 2, "strict-load", {
      before: "strict-cursor",
      limit: 50,
    });
  });

  it("rejects foreign, detached, disabled, replaced, wrong-action, and fabricated sources before exact controls claim once", async () => {
    const retryRequest = deferred<ActivityPageDto>();
    const pageRequest = deferred<ActivityPageDto>();
    let retryReentry: CapturedControl | null = null;
    let pageReentry: CapturedControl | null = null;
    let retryCloseReentry: CapturedControl | null = null;
    let pageCloseReentry: CapturedControl | null = null;
    const retryClose = vi.fn(() => {
      if (retryCloseReentry) invoke(retryCloseReentry);
    });
    const pageClose = vi.fn(() => {
      if (pageCloseReentry) invoke(pageCloseReentry);
    });
    let retryCalls = 0;
    let pageCalls = 0;
    activity.mockImplementation((documentId: string) => {
      if (documentId === "exact-retry") {
        retryCalls += 1;
        if (retryCalls === 1) return Promise.reject("offline");
        if (retryReentry) invoke(retryReentry);
        return retryRequest.promise;
      }
      if (documentId === "exact-page") {
        pageCalls += 1;
        if (pageCalls === 1) {
          return Promise.resolve({
            items: [row("page-row", "Page editor")],
            nextBefore: "page-cursor",
          });
        }
        if (pageReentry) invoke(pageReentry);
        return pageRequest.promise;
      }
      throw new Error(`Unexpected document: ${documentId}`);
    });

    render(
      <>
        <ActivityPanel session={session("exact-retry")} onClose={retryClose} />
        <ActivityPanel session={session("exact-page")} onClose={pageClose} />
      </>,
    );
    await act(async () => {});
    const panels = screen.getAllByTestId("activity-panel");
    const retryPanel = panels[0];
    const pagePanel = panels[1];
    if (!retryPanel || !pagePanel) throw new Error("Expected two activity panels");
    const retryControl = captureControl(within(retryPanel).getByRole("button", { name: "Retry" }));
    const retryCloseControl = captureControl(
      within(retryPanel).getByRole("button", { name: "Close activity" }),
    );
    const loadControl = captureControl(within(pagePanel).getByRole("button", { name: "Load more" }));
    const pageCloseControl = captureControl(
      within(pagePanel).getByRole("button", { name: "Close activity" }),
    );
    retryReentry = retryControl;
    pageReentry = loadControl;
    const detached = document.createElement("button");
    const sibling = document.createElement("button");
    document.body.append(sibling);
    const foreignDocument = document.implementation.createHTMLDocument("foreign");
    const foreign = foreignDocument.createElement("button");
    foreignDocument.body.append(foreign);
    const replacement = retryControl.element.cloneNode(true);
    if (!(replacement instanceof HTMLButtonElement)) throw new Error("Expected a replacement button");
    const focused = document.activeElement;

    const fabricated = {
      ...capturedMouseEvent(retryControl),
      nativeEvent: new Event("click"),
    };
    const wrongType = {
      ...capturedMouseEvent(loadControl),
      type: "pointerdown",
    };
    const mismatchedTarget = capturedMouseEvent(
      retryControl,
      retryControl.element,
      retryControl.element,
      sibling,
    );

    act(() => {
      invoke(retryControl, loadControl.element);
      invoke(loadControl, retryControl.element);
      invoke(retryCloseControl, pageCloseControl.element);
      invoke(retryControl, detached);
      invoke(retryControl, sibling);
      invoke(retryControl, foreign);
      retryControl.click(fabricated);
      loadControl.click(wrongType);
      retryControl.click(mismatchedTarget);
      retryControl.element.disabled = true;
      invoke(retryControl);
      retryControl.element.disabled = false;
    });

    const injected = document.createElement("span");
    retryControl.element.append(injected);
    act(() => invoke(retryControl, retryControl.element, injected));
    injected.remove();

    const retryParent = retryControl.element.parentElement;
    if (!retryParent) throw new Error("Retry has no parent");
    const alert = within(retryPanel).getByRole("alert");
    const alertParent = alert.parentElement;
    const alertReplacement = alert.cloneNode(true);
    if (!alertParent) throw new Error("Alert has no parent");
    alertParent.replaceChild(alertReplacement, alert);
    act(() => invoke(retryControl));
    alertParent.replaceChild(alert, alertReplacement);

    retryParent.replaceChild(replacement, retryControl.element);
    act(() => {
      invoke(retryControl);
      invoke(retryControl, replacement);
    });
    retryParent.replaceChild(retryControl.element, replacement);

    const closeParent = retryCloseControl.element.parentElement;
    const closeReplacement = retryCloseControl.element.cloneNode(true);
    if (!closeParent) throw new Error("Close has no parent");
    closeParent.replaceChild(closeReplacement, retryCloseControl.element);
    act(() => {
      invoke(retryCloseControl);
      invoke(retryCloseControl, closeReplacement);
    });
    closeParent.replaceChild(retryCloseControl.element, closeReplacement);

    expect(activity).toHaveBeenCalledTimes(2);
    expect(retryClose).not.toHaveBeenCalled();
    expect(pageClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(focused);
    expect(fabricated.defaultPrevented).toBe(false);
    expect(wrongType.defaultPrevented).toBe(false);
    expect(mismatchedTarget.defaultPrevented).toBe(false);

    const retryEvent = capturedMouseEvent(retryControl);
    const loadEvent = capturedMouseEvent(loadControl);
    act(() => {
      retryControl.click(retryEvent);
      retryControl.click(retryEvent);
      loadControl.click(loadEvent);
      loadControl.click(loadEvent);
    });
    expect(activity).toHaveBeenCalledTimes(4);
    expect(activity).toHaveBeenNthCalledWith(3, "exact-retry", { limit: 50 });
    expect(activity).toHaveBeenNthCalledWith(4, "exact-page", {
      before: "page-cursor",
      limit: 50,
    });

    const currentRetryClose = captureControl(
      within(retryPanel).getByRole("button", { name: "Close activity" }),
    );
    const currentPageClose = captureControl(
      within(pagePanel).getByRole("button", { name: "Close activity" }),
    );
    retryCloseReentry = currentRetryClose;
    pageCloseReentry = currentPageClose;
    act(() => {
      invoke(currentRetryClose);
      invoke(currentRetryClose);
      invoke(currentPageClose);
      invoke(currentPageClose);
    });
    expect(retryClose).toHaveBeenCalledOnce();
    expect(pageClose).toHaveBeenCalledOnce();
    expect(activity).toHaveBeenCalledTimes(4);
    sibling.remove();
  });

  it.each([
    ["stale before current", false],
    ["current before stale", true],
  ] as const)(
    "retires a same-DOM row mutation and reorder before the parent layout boundary, %s",
    async (_label, currentFirst) => {
      const items = [row("first", "First editor"), row("second", "Second editor")];
      const page = deferred<ActivityPageDto>();
      activity
        .mockResolvedValueOnce({ items, nextBefore: "mutable-cursor" })
        .mockReturnValueOnce(page.promise);
      const stableSession = session("mutable-list");
      const onClose = vi.fn();
      const view = createDirectActivity({ session: stableSession, onClose });
      await act(async () => {});
      const stale = captureControl(screen.getByRole("button", { name: "Load more" }));
      const staleRows = screen.getAllByTestId("activity-row");

      items[0]!.actorName = "Mutated first editor";
      items.reverse();
      let current!: CapturedControl;
      renderDirectActivity(view.root, {
        session: stableSession,
        onClose,
        boundary: 1,
        onBoundary: () => {
          current = captureControl(screen.getByRole("button", { name: "Load more" }));
          expect(current.element).toBe(stale.element);
          expect(screen.getAllByTestId("activity-row")[1]).toBe(staleRows[0]);
        },
      });

      act(() => {
        if (currentFirst) invoke(current);
        invoke(stale, current.element);
        if (!currentFirst) invoke(current);
      });
      expect(activity).toHaveBeenCalledTimes(2);
      expect(activity).toHaveBeenLastCalledWith("mutable-list", {
        before: "mutable-cursor",
        limit: 50,
      });
      expect(screen.getByText("Mutated first editor")).toBeInTheDocument();
      expect(screen.getAllByTestId("activity-row")[0]).toHaveTextContent("Second editor");
    },
  );

  it.each([
    ["A first", false],
    ["B first", true],
  ] as const)(
    "isolates equal-looking remount callbacks, late refs, and passive cleanup, %s",
    async (_label, currentFirst) => {
      const pending = deferred<ActivityPageDto>();
      activity
        .mockRejectedValueOnce("first failure")
        .mockRejectedValueOnce("second failure")
        .mockReturnValueOnce(pending.promise);
      const stableSession = session("equal-remount");
      const onClose = vi.fn();
      const passiveCleanup = vi.fn();
      const view = createDirectActivity({
        session: stableSession,
        onClose,
        instance: "A",
        onPassiveCleanup: passiveCleanup,
      });
      await act(async () => {});
      const stalePanel = screen.getByTestId("activity-panel");
      const staleRetry = captureControl(screen.getByRole("button", { name: "Retry" }));
      const stalePanelRef = reactRef(stalePanel);
      let currentPanel!: HTMLElement;
      let cleanupAtBoundary = -1;

      renderDirectActivity(view.root, {
        session: stableSession,
        onClose,
        instance: "B",
        boundary: 1,
        onBoundary: () => {
          cleanupAtBoundary = passiveCleanup.mock.calls.length;
          currentPanel = screen.getByTestId("activity-panel");
          expect(currentPanel).not.toBe(stalePanel);
          expect(stalePanel.isConnected).toBe(false);
          invoke(staleRetry);
        },
      });
      await act(async () => {});
      expect(cleanupAtBoundary).toBe(0);
      expect(passiveCleanup).toHaveBeenCalledOnce();
      const current = captureControl(screen.getByRole("button", { name: "Retry" }));
      expect(current.element).not.toBe(staleRetry.element);

      act(() => {
        stalePanelRef(currentPanel);
        staleRetry.ref(current.element);
        staleRetry.ref(null);
        stalePanelRef(null);
        invoke(staleRetry, staleRetry.element);
        invoke(staleRetry, current.element);
        invoke(current, staleRetry.element);
        if (currentFirst) invoke(current);
        invoke(staleRetry, current.element);
        if (!currentFirst) invoke(current);
      });

      expect(activity).toHaveBeenCalledTimes(3);
      expect(activity).toHaveBeenLastCalledWith("equal-remount", { limit: 50 });
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it("rejects every replaced publication region and recovers only with the exact restored DOM", async () => {
    const page = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({
        items: [row("dom-row", "DOM editor")],
        nextBefore: "dom-cursor",
      })
      .mockReturnValueOnce(page.promise);
    render(<ActivityPanel session={session("dom-replacement")} onClose={vi.fn()} />);
    await act(async () => {});
    const panel = screen.getByTestId("activity-panel");
    const header = panel.firstElementChild;
    const scroll = panel.lastElementChild;
    const content = scroll?.firstElementChild;
    const group = content?.firstElementChild;
    const rowElement = screen.getByTestId("activity-row");
    const load = captureControl(screen.getByRole("button", { name: "Load more" }));
    if (
      !header ||
      !scroll ||
      !content ||
      !group ||
      !(rowElement instanceof HTMLLIElement)
    ) {
      throw new Error("Expected the complete activity publication");
    }
    const regions = [header, scroll, content, group, rowElement, load.element];

    for (const region of regions) {
      const parent = region.parentElement;
      const replacement = region.cloneNode(true);
      if (!parent) throw new Error("Publication region has no parent");
      parent.replaceChild(replacement, region);
      act(() => invoke(load));
      parent.replaceChild(region, replacement);
    }
    const panelParent = panel.parentElement;
    const panelReplacement = panel.cloneNode(true);
    if (!panelParent) throw new Error("Panel has no parent");
    panelParent.replaceChild(panelReplacement, panel);
    act(() => invoke(load));
    panelParent.replaceChild(panel, panelReplacement);

    expect(activity).toHaveBeenCalledOnce();
    act(() => {
      invoke(load);
      invoke(load);
    });
    expect(activity).toHaveBeenCalledTimes(2);
    expect(activity).toHaveBeenLastCalledWith("dom-replacement", {
      before: "dom-cursor",
      limit: 50,
    });
  });

  it("retires a mutated session before replacement and gives only the new document control authority", async () => {
    activity.mockImplementation((documentId: string) =>
      Promise.resolve({
        items: [row(documentId, `${documentId} editor`)],
        nextBefore: null,
      }));
    const mutableSession = session("session-A");
    const oldClose = vi.fn();
    const newClose = vi.fn();
    const view = createDirectActivity({ session: mutableSession, onClose: oldClose });
    await act(async () => {});
    const stale = captureControl(screen.getByRole("button", { name: "Close activity" }));

    (mutableSession as { docId: string }).docId = "session-B";
    act(() => invoke(stale));
    expect(oldClose).not.toHaveBeenCalled();

    let currentPanel!: HTMLElement;
    renderDirectActivity(view.root, {
      session: mutableSession,
      onClose: newClose,
      boundary: 1,
      onBoundary: () => {
        currentPanel = screen.getByTestId("activity-panel");
        invoke(stale);
      },
    });
    await act(async () => {});
    const current = captureControl(
      within(currentPanel).getByRole("button", { name: "Close activity" }),
    );
    act(() => {
      invoke(stale, current.element);
      invoke(current, stale.element);
      invoke(current);
      invoke(current);
    });
    expect(oldClose).not.toHaveBeenCalled();
    expect(newClose).toHaveBeenCalledOnce();
    expect(activity).toHaveBeenCalledTimes(2);
    expect(activity).toHaveBeenNthCalledWith(1, "session-A", { limit: 50 });
    expect(activity).toHaveBeenNthCalledWith(2, "session-B", { limit: 50 });
  });
});
