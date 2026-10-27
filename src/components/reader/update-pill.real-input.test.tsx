// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatePill } from "./update-pill";

const DOC_ID = "doc-1";
const INITIAL_HASH = "hash-before";
const POLL_MS = 1000;
const fetchMock = vi.fn<typeof fetch>();
const response = (contentHash: unknown, ok = true) =>
  ({ ok, json: vi.fn().mockResolvedValue({ contentHash }) }) as unknown as Response;

let visibility: DocumentVisibilityState;
const reload = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  fetchMock.mockReset().mockResolvedValue(response(INITIAL_HASH));
  vi.stubGlobal("fetch", fetchMock);
  reload.mockReset();
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as Location);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
});

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const mount = (props: Partial<{ docId: string; initialHash: string }> = {}) =>
  render(
    <StrictMode>
      <UpdatePill docId={props.docId ?? DOC_ID} initialHash={props.initialHash ?? INITIAL_HASH} pollMs={POLL_MS} />
    </StrictMode>,
  );
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  fireEvent(document, new Event("visibilitychange"));
};

describe("UpdatePill polling", () => {
  it("checks on mount and on every interval, never overlapping requests", async () => {
    mount();
    await advance(0);
    const initial = fetchMock.mock.calls.length;
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/documents/${DOC_ID}/content`, expect.objectContaining({ cache: "no-store" }));
    let resolve!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise((done) => (resolve = done)));
    await advance(POLL_MS);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(initial + 1);
    resolve(response(INITIAL_HASH));
    await advance(0);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
  });

  it("aborts on hide, ignores the stale response, and checks again when visible", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    mount();
    await advance(0);
    const signal = fetchMock.mock.calls.at(-1)![1]!.signal!;
    setVisibility("hidden");
    expect(signal.aborted).toBe(true);
    const calls = fetchMock.mock.calls.length;
    await advance(POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    fetchMock.mockResolvedValue(response("hash-after"));
    setVisibility("visible");
    await advance(0);
    expect(screen.getByTestId("reader-updated")).toBeInTheDocument();
  });

  it("shows a failure notice and retries on a plain click", async () => {
    fetchMock.mockResolvedValue(response(INITIAL_HASH, false));
    mount();
    await advance(0);
    const retry = screen.getByRole("button", { name: "Retry now" });
    fetchMock.mockResolvedValue(response("hash-after"));
    const calls = fetchMock.mock.calls.length;
    fireEvent.click(retry);
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(calls + 1);
    expect(screen.queryByTestId("reader-update-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("reader-updated")).toBeInTheDocument();
  });

  it("treats malformed hashes and network errors as failures", async () => {
    fetchMock.mockResolvedValue(response(""));
    mount();
    await advance(0);
    expect(screen.getByTestId("reader-update-error")).toBeInTheDocument();
    fetchMock.mockRejectedValue(new Error("offline"));
    await advance(POLL_MS);
    expect(screen.getByTestId("reader-update-error")).toBeInTheDocument();
  });
});

describe("UpdatePill real input", () => {
  it("reloads once when Refresh is clicked", async () => {
    fetchMock.mockResolvedValue(response("hash-after"));
    mount();
    await advance(0);
    const refresh = screen.getByRole("button", { name: /Refresh/ });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("dismisses, suppresses that hash, and shows a later one", async () => {
    fetchMock.mockResolvedValue(response("hash-after"));
    mount();
    await advance(0);
    const calls = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(calls + 1);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    fetchMock.mockResolvedValue(response("hash-later"));
    await advance(POLL_MS);
    expect(screen.getByTestId("reader-updated")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("moves focus between Refresh and Dismiss with arrow keys and leaves Enter native", async () => {
    fetchMock.mockResolvedValue(response("hash-after"));
    mount();
    await advance(0);
    const refresh = screen.getByRole("button", { name: /Refresh/ });
    const dismiss = screen.getByRole("button", { name: "Dismiss update notice" });
    refresh.focus();
    expect(fireEvent.keyDown(refresh, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(refresh, { key: "ArrowRight" })).toBe(false);
    expect(dismiss).toHaveFocus();
    fireEvent.keyDown(dismiss, { key: "Home" });
    expect(refresh).toHaveFocus();
    fireEvent.keyDown(refresh, { key: "End" });
    expect(dismiss).toHaveFocus();
    fireEvent.click(dismiss);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
  });

  it("does not carry a dismissal into a different document", async () => {
    fetchMock.mockResolvedValue(response("hash-after"));
    const view = mount();
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    view.rerender(
      <StrictMode>
        <UpdatePill docId="doc-2" initialHash={INITIAL_HASH} pollMs={POLL_MS} />
      </StrictMode>,
    );
    await advance(0);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/documents/doc-2/content", expect.anything());
    expect(screen.getByTestId("reader-updated")).toBeInTheDocument();
  });
});
