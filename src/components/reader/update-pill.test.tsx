// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatePill } from "./update-pill";

const DOC_ID = "doc-919";
const INITIAL_HASH = "hash-before";
const POLL_MS = 1000;
const fetchMock = vi.fn<typeof fetch>();

const response = (contentHash: string, ok = true) =>
  ({
    ok,
    json: vi.fn().mockResolvedValue({ contentHash }),
  }) as unknown as Response;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("UpdatePill polling", () => {
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    fetchMock.mockReset().mockResolvedValue(response(INITIAL_HASH));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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
