// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
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
  onLayout,
}: {
  docId?: string;
  initialHash?: string;
  show?: boolean;
  onLayout?: () => void;
}) {
  useLayoutEffect(() => {
    onLayout?.();
  }, [docId, initialHash, show, onLayout]);

  return show ? <UpdatePill docId={docId} initialHash={initialHash} pollMs={POLL_MS} /> : null;
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
});
