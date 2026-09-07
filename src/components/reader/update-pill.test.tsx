// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatePill } from "./update-pill";

const DOC_ID = "doc-919";
const INITIAL_HASH = "hash-before";
const REPLACEMENT_DOC_ID = "doc-920";
const REPLACEMENT_HASH = "replacement-hash";
const POLL_MS = 1000;
const fetchMock = vi.fn<typeof fetch>();

const response = (contentHash: string, ok = true) =>
  ({
    ok,
    json: vi.fn().mockResolvedValue({ contentHash }),
  }) as unknown as Response;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function ReaderBoundary({
  docId = DOC_ID,
  initialHash = INITIAL_HASH,
  show = true,
  visit = "initial",
  onLayout,
}: {
  docId?: string;
  initialHash?: string;
  show?: boolean;
  visit?: "initial" | "replacement";
  onLayout?: () => void;
}) {
  useLayoutEffect(() => {
    onLayout?.();
  }, [docId, initialHash, show, visit, onLayout]);

  if (!show) return null;
  const props = { docId, initialHash, pollMs: POLL_MS };
  return visit === "initial" ? <InitialReaderVisit {...props} /> : <ReplacementReaderVisit {...props} />;
}

function InitialReaderVisit(props: { docId: string; initialHash: string; pollMs: number }) {
  return <UpdatePill {...props} />;
}

function ReplacementReaderVisit(props: { docId: string; initialHash: string; pollMs: number }) {
  return <UpdatePill {...props} />;
}

function captureClick(element: HTMLElement) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the Refresh button");
  const props = (element as unknown as Record<string, { onClick?: () => void } | undefined>)[propsKey];
  if (!props?.onClick) throw new Error("The Refresh button did not have an onClick handler");
  return props.onClick;
}

function trackVisibilityListeners() {
  const active = new Set<EventListenerOrEventListenerObject>();
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "visibilitychange") active.add(listener);
    add(type, listener, options);
  });
  vi.spyOn(document, "removeEventListener").mockImplementation((type, listener, options) => {
    if (type === "visibilitychange") active.delete(listener);
    remove(type, listener, options);
  });
  return active;
}

function createNavigationSpies() {
  return {
    reload: vi.fn(),
    assign: vi.fn(),
    replace: vi.fn(),
  };
}

function invokeRefreshes(navigation: ReturnType<typeof createNavigationSpies>, ...callbacks: Array<() => void>) {
  const browserWindow = window;
  vi.stubGlobal("window", { location: navigation });
  try {
    for (const callback of callbacks) callback();
  } finally {
    vi.stubGlobal("window", browserWindow);
  }
}

describe("UpdatePill polling", () => {
  let visibility: DocumentVisibilityState;
  let unhandledRejection: (event: PromiseRejectionEvent) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    fetchMock.mockReset().mockResolvedValue(response(INITIAL_HASH));
    vi.stubGlobal("fetch", fetchMock);
    unhandledRejection = vi.fn();
    window.addEventListener("unhandledrejection", unhandledRejection);
  });

  afterEach(() => {
    cleanup();
    window.removeEventListener("unhandledrejection", unhandledRejection);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  });

  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  const setVisibility = (state: DocumentVisibilityState) => {
    visibility = state;
    fireEvent(document, new Event("visibilitychange"));
  };

  const mount = () => render(<UpdatePill docId={DOC_ID} initialHash={INITIAL_HASH} pollMs={POLL_MS} />);

  const requestSignal = (index: number) => fetchMock.mock.calls[index]?.[1]?.signal as AbortSignal;

  it("checks immediately on a visible mount, then keeps the configured interval cadence", async () => {
    mount();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(0);
    await advance(POLL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(0);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("suppresses interval ticks while a request is in flight", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    mount();

    await advance(POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pending.resolve(response(INITIAL_HASH));
    await advance(0);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts on hide, ignores the old response, and checks immediately when visible again", async () => {
    const oldRequest = deferred<Response>();
    const freshRequest = deferred<Response>();
    fetchMock.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(freshRequest.promise).mockResolvedValue(response(INITIAL_HASH));
    mount();
    const oldSignal = requestSignal(0);

    setVisibility("hidden");
    expect(oldSignal.aborted).toBe(true);
    await advance(POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const freshSignal = requestSignal(1);

    oldRequest.resolve(response("hash-from-aborted-request"));
    await advance(0);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    expect(freshSignal.aborted).toBe(false);

    freshRequest.resolve(response(INITIAL_HASH));
    await advance(0);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("aborts the owned request and clears the timer on unmount", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    const { unmount } = mount();
    const signal = requestSignal(0);

    unmount();
    expect(signal.aborted).toBe(true);
    await advance(POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pending.resolve(response("hash-after-unmount"));
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retires document A before its changed response settles in document B's parent layout effect", async () => {
    const oldRequest = deferred<Response>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockReturnValueOnce(oldRequest.promise).mockResolvedValue(response(REPLACEMENT_HASH));
    const { rerender } = render(<ReaderBoundary />);
    const oldSignal = requestSignal(0);
    let abortedAtBoundary = false;

    rerender(
      <ReaderBoundary
        docId={REPLACEMENT_DOC_ID}
        initialHash={REPLACEMENT_HASH}
        onLayout={() => {
          abortedAtBoundary = oldSignal.aborted;
          oldRequest.resolve(response("changed-after-replacement"));
        }}
      />,
    );
    await advance(0);

    expect(abortedAtBoundary).toBe(true);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/documents/${REPLACEMENT_DOC_ID}/content`);
    expect(consoleError).not.toHaveBeenCalled();
    expect(unhandledRejection).not.toHaveBeenCalled();
  });

  it("keeps document B's request and cadence usable when document A rejects at the replacement boundary", async () => {
    const oldRequest = deferred<Response>();
    const currentRequest = deferred<Response>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise)
      .mockResolvedValue(response(REPLACEMENT_HASH));
    const { rerender } = render(<ReaderBoundary />);
    const oldSignal = requestSignal(0);
    let abortedAtBoundary = false;

    rerender(
      <ReaderBoundary
        docId={REPLACEMENT_DOC_ID}
        initialHash={REPLACEMENT_HASH}
        onLayout={() => {
          abortedAtBoundary = oldSignal.aborted;
          oldRequest.reject(new TypeError("retired request failed"));
        }}
      />,
    );
    await advance(0);

    expect(abortedAtBoundary).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestSignal(1).aborted).toBe(false);
    await advance(POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    currentRequest.resolve(response(REPLACEMENT_HASH));
    await advance(0);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
    expect(unhandledRejection).not.toHaveBeenCalled();
  });

  it("retires polling before a changed response settles at the parent layout boundary after removal", async () => {
    const oldRequest = deferred<Response>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockReturnValue(oldRequest.promise);
    const { rerender } = render(<ReaderBoundary />);
    const oldSignal = requestSignal(0);
    let abortedAtBoundary = false;

    rerender(
      <ReaderBoundary
        show={false}
        onLayout={() => {
          abortedAtBoundary = oldSignal.aborted;
          oldRequest.resolve(response("changed-after-removal"));
        }}
      />,
    );
    await advance(0);
    await advance(POLL_MS * 4);

    expect(abortedAtBoundary).toBe(true);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
    expect(unhandledRejection).not.toHaveBeenCalled();
  });

  it("retires polling before a rejection settles at the parent layout boundary after removal", async () => {
    const oldRequest = deferred<Response>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockReturnValue(oldRequest.promise);
    const { rerender } = render(<ReaderBoundary />);
    const oldSignal = requestSignal(0);
    let abortedAtBoundary = false;

    rerender(
      <ReaderBoundary
        show={false}
        onLayout={() => {
          abortedAtBoundary = oldSignal.aborted;
          oldRequest.reject(new TypeError("retired request failed"));
        }}
      />,
    );
    await advance(0);
    await advance(POLL_MS * 4);

    expect(abortedAtBoundary).toBe(true);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
    expect(unhandledRejection).not.toHaveBeenCalled();
  });

  it("does not let document A's finalizer clear document B's pending request", async () => {
    const oldRequest = deferred<Response>();
    const currentRequest = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise)
      .mockResolvedValue(response(REPLACEMENT_HASH));
    const { rerender } = render(<ReaderBoundary />);
    const oldSignal = requestSignal(0);

    rerender(<ReaderBoundary docId={REPLACEMENT_DOC_ID} initialHash={REPLACEMENT_HASH} />);
    expect(oldSignal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    oldRequest.resolve(response("changed-after-current-request-started"));
    await advance(0);
    await advance(POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();

    currentRequest.resolve(response(REPLACEMENT_HASH));
    await advance(0);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("clears document A's stale presentation and starts document B immediately", async () => {
    const currentRequest = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response("changed-before-replacement"))
      .mockReturnValueOnce(currentRequest.promise);
    const { rerender } = render(<ReaderBoundary />);
    await advance(0);
    expect(screen.getByTestId("reader-updated")).toBeInTheDocument();

    rerender(<ReaderBoundary docId={REPLACEMENT_DOC_ID} initialHash={REPLACEMENT_HASH} />);

    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/documents/${REPLACEMENT_DOC_ID}/content`);
  });

  it("retries transient and non-2xx failures on following interval ticks", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(response(INITIAL_HASH, false)).mockResolvedValue(response(INITIAL_HASH));
    mount();

    await advance(0);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await advance(0);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("shows the refresh action and stops polling after detecting a changed hash", async () => {
    fetchMock.mockResolvedValue(response("hash-after"));
    mount();
    await advance(0);

    expect(screen.getByRole("button", { name: /Updated.*Refresh/ })).toBeInTheDocument();
    await advance(POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets the exact current Refresh publication reload only once without other changes", async () => {
    const activeListeners = trackVisibilityListeners();
    const focusOwner = document.createElement("button");
    focusOwner.textContent = "Persistent focus owner";
    document.body.append(focusOwner);
    focusOwner.focus();
    fetchMock.mockResolvedValue(response("hash-after"));

    try {
      mount();
      await advance(0);
      const pill = screen.getByTestId("reader-updated");
      const refresh = captureClick(screen.getByRole("button", { name: /Updated.*Refresh/ }));
      const markup = pill.outerHTML;
      const timers = vi.getTimerCount();

      const navigation = createNavigationSpies();
      invokeRefreshes(navigation, refresh, refresh);

      expect(navigation.reload).toHaveBeenCalledOnce();
      expect(navigation.assign).not.toHaveBeenCalled();
      expect(navigation.replace).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(timers);
      expect(activeListeners.size).toBe(0);
      expect(pill.outerHTML).toBe(markup);
      expect(focusOwner).toHaveFocus();
    } finally {
      focusOwner.remove();
    }
  });

  it("retires a removed Refresh publication before the parent layout boundary", async () => {
    const activeListeners = trackVisibilityListeners();
    const focusOwner = document.createElement("button");
    focusOwner.textContent = "Persistent focus owner";
    const host = document.createElement("div");
    document.body.append(focusOwner, host);
    const root = createRoot(host);
    focusOwner.focus();
    fetchMock.mockResolvedValue(response("hash-after"));

    try {
      await act(async () => root.render(<ReaderBoundary />));
      await advance(0);
      const staleRefresh = captureClick(screen.getByRole("button", { name: /Updated.*Refresh/ }));
      const fetches = fetchMock.mock.calls.length;
      const timers = vi.getTimerCount();
      const listeners = activeListeners.size;
      let boundaryMarkup: string | null = null;
      let boundaryFetches = -1;
      let boundaryTimers = -1;
      let boundaryListeners = -1;
      let boundaryFocused = false;
      const boundaryNavigation = createNavigationSpies();
      let reachBoundary!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        reachBoundary = resolve;
      });

      root.render(
        <ReaderBoundary
          show={false}
          onLayout={() => {
            boundaryMarkup = host.innerHTML;
            boundaryFetches = fetchMock.mock.calls.length;
            boundaryTimers = vi.getTimerCount();
            boundaryListeners = activeListeners.size;
            boundaryFocused = document.activeElement === focusOwner;
            invokeRefreshes(boundaryNavigation, staleRefresh);
            reachBoundary();
          }}
        />,
      );
      await atBoundary;
      await act(async () => {});

      expect(boundaryMarkup).toBe("");
      expect(boundaryFetches).toBe(fetches);
      expect(boundaryTimers).toBe(timers);
      expect(boundaryListeners).toBe(listeners);
      expect(boundaryFocused).toBe(true);
      expect(boundaryNavigation.reload).not.toHaveBeenCalled();
      expect(boundaryNavigation.assign).not.toHaveBeenCalled();
      expect(boundaryNavigation.replace).not.toHaveBeenCalled();

      const afterBoundaryNavigation = createNavigationSpies();
      invokeRefreshes(afterBoundaryNavigation, staleRefresh);
      expect(afterBoundaryNavigation.reload).not.toHaveBeenCalled();
      expect(afterBoundaryNavigation.assign).not.toHaveBeenCalled();
      expect(afterBoundaryNavigation.replace).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(fetches);
      expect(vi.getTimerCount()).toBe(timers);
      expect(activeListeners.size).toBe(listeners);
      expect(host.innerHTML).toBe("");
      expect(focusOwner).toHaveFocus();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      focusOwner.remove();
    }
  });

  it.each([
    {
      name: "different document values with stale before current",
      docId: REPLACEMENT_DOC_ID,
      initialHash: REPLACEMENT_HASH,
      visit: "initial" as const,
      staleFirst: true,
    },
    {
      name: "an equal-value distinct visit with current before stale",
      docId: DOC_ID,
      initialHash: INITIAL_HASH,
      visit: "replacement" as const,
      staleFirst: false,
    },
  ])("keeps B usable after replacing A with $name", async ({ docId, initialHash, visit, staleFirst }) => {
    const activeListeners = trackVisibilityListeners();
    const focusOwner = document.createElement("button");
    focusOwner.textContent = "Persistent focus owner";
    const host = document.createElement("div");
    document.body.append(focusOwner, host);
    const root = createRoot(host);
    focusOwner.focus();
    fetchMock.mockResolvedValueOnce(response("changed-a")).mockResolvedValueOnce(response("changed-b"));

    try {
      await act(async () => root.render(<ReaderBoundary />));
      await advance(0);
      const staleRefresh = captureClick(screen.getByRole("button", { name: /Updated.*Refresh/ }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(activeListeners.size).toBe(0);

      let boundaryMarkup: string | null = null;
      let boundaryFetches = -1;
      let boundaryTimers = -1;
      let boundaryListeners = -1;
      let boundaryFocused = false;
      const boundaryNavigation = createNavigationSpies();
      let layoutCalls = 0;
      let reachBoundary!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        reachBoundary = resolve;
      });

      root.render(
        <ReaderBoundary
          docId={docId}
          initialHash={initialHash}
          visit={visit}
          onLayout={() => {
            layoutCalls++;
            boundaryMarkup = host.innerHTML;
            boundaryFetches = fetchMock.mock.calls.length;
            boundaryTimers = vi.getTimerCount();
            boundaryListeners = activeListeners.size;
            boundaryFocused = document.activeElement === focusOwner;
            invokeRefreshes(boundaryNavigation, staleRefresh);
            reachBoundary();
          }}
        />,
      );
      await atBoundary;
      await act(async () => {});
      await advance(0);

      expect(boundaryMarkup).toBe("");
      expect(boundaryFetches).toBe(1);
      expect(boundaryTimers).toBe(0);
      expect(boundaryListeners).toBe(0);
      expect(boundaryFocused).toBe(true);
      expect(boundaryNavigation.reload).not.toHaveBeenCalled();
      expect(boundaryNavigation.assign).not.toHaveBeenCalled();
      expect(boundaryNavigation.replace).not.toHaveBeenCalled();
      expect(layoutCalls).toBe(1);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `/api/documents/${DOC_ID}/content`,
        `/api/documents/${docId}/content`,
      ]);
      expect(requestSignal(1)).not.toBe(requestSignal(0));
      expect(requestSignal(1).aborted).toBe(false);
      const currentPill = screen.getByTestId("reader-updated");
      const currentRefresh = captureClick(screen.getByRole("button", { name: /Updated.*Refresh/ }));
      const currentMarkup = currentPill.outerHTML;
      const fetches = fetchMock.mock.calls.length;
      const timers = vi.getTimerCount();
      const listeners = activeListeners.size;

      const callbacks = staleFirst ? [staleRefresh, currentRefresh] : [currentRefresh, staleRefresh];
      const navigation = createNavigationSpies();
      invokeRefreshes(navigation, ...callbacks);
      expect(navigation.reload).toHaveBeenCalledOnce();
      expect(navigation.assign).not.toHaveBeenCalled();
      expect(navigation.replace).not.toHaveBeenCalled();

      const repeatedNavigation = createNavigationSpies();
      invokeRefreshes(repeatedNavigation, staleRefresh, currentRefresh);
      expect(repeatedNavigation.reload).not.toHaveBeenCalled();
      expect(repeatedNavigation.assign).not.toHaveBeenCalled();
      expect(repeatedNavigation.replace).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(fetches);
      expect(vi.getTimerCount()).toBe(timers);
      expect(activeListeners.size).toBe(listeners);
      expect(currentPill.outerHTML).toBe(currentMarkup);
      expect(focusOwner).toHaveFocus();
      expect(layoutCalls).toBe(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      focusOwner.remove();
    }
  });
});
