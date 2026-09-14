// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/primitives";

const calls = vi.hoisted(() => ({
  starred: vi.fn(),
  star: vi.fn(),
  unstar: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      documents: {
        ...actual.api.documents,
        starred: (...args: unknown[]) => calls.starred(...args),
        star: (...args: unknown[]) => calls.star(...args),
        unstar: (...args: unknown[]) => calls.unstar(...args),
      },
    },
  };
});

import { HeaderStar } from "./header";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function star(docId: string, ready = true) {
  return (
    <TooltipProvider>
      <HeaderStar docId={docId} ready={ready} />
    </TooltipProvider>
  );
}

function HeaderStarBoundary({
  docId,
  ready = true,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  docId: string;
  ready?: boolean;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? star(docId, ready) : null;
}

const toggleCases = [
  {
    action: "star" as const,
    initial: false,
    next: true,
    actionLabel: "Star document",
    pendingLabel: "Starring document…",
    retryLabel: "Retry star document",
    confirmedLabel: "Unstar document",
  },
  {
    action: "unstar" as const,
    initial: true,
    next: false,
    actionLabel: "Unstar document",
    pendingLabel: "Unstarring document…",
    retryLabel: "Retry unstar document",
    confirmedLabel: "Star document",
  },
];

let unhandled: unknown[];
const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);

beforeEach(() => {
  calls.starred.mockReset();
  calls.star.mockReset();
  calls.unstar.mockReset();
  unhandled = [];
  window.addEventListener("unhandledrejection", onUnhandled);
});

afterEach(() => {
  cleanup();
  window.removeEventListener("unhandledrejection", onUnhandled);
});

describe("editor header star recovery", () => {
  it("admits one initial load and confirms only its controlled success", async () => {
    const load = deferred<{ starred: boolean }>();
    calls.starred.mockReturnValue(load.promise);

    const view = render(star("load-document"));
    expect(calls.starred).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("header-star")).toBeNull();

    view.rerender(star("load-document"));
    expect(calls.starred).toHaveBeenCalledTimes(1);

    await act(async () => load.resolve({ starred: true }));
    expect(screen.getByRole("button", { name: "Unstar document" })).toHaveAttribute("data-starred", "true");
    expect(unhandled).toEqual([]);
  });

  it("releases only a controlled load failure and guards failed and successful load retries", async () => {
    const initial = deferred<{ starred: boolean }>();
    const failedRetry = deferred<{ starred: boolean }>();
    const successfulRetry = deferred<{ starred: boolean }>();
    calls.starred
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(failedRetry.promise)
      .mockReturnValueOnce(successfulRetry.promise);

    render(star("controlled-retry-document"));
    await act(async () => initial.reject(new Error("Controlled load failed")));
    expect(screen.getByRole("alert")).toHaveTextContent("Controlled load failed");

    const firstRetry = screen.getByRole("button", { name: "Retry star status" });
    fireEvent.click(firstRetry);
    fireEvent.click(firstRetry);
    expect(calls.starred).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying star status" })).toBeDisabled();

    await act(async () => failedRetry.reject(new Error("Controlled retry failed")));
    expect(screen.getByRole("alert")).toHaveTextContent("Controlled retry failed");
    const secondRetry = screen.getByRole("button", { name: "Retry star status" });
    fireEvent.click(secondRetry);
    fireEvent.click(secondRetry);
    expect(calls.starred).toHaveBeenCalledTimes(3);

    await act(async () => successfulRetry.resolve({ starred: false }));
    expect(screen.getByRole("button", { name: "Star document" })).toHaveAttribute("data-starred", "false");
    expect(unhandled).toEqual([]);
  });

  it("shows a retry after the initial load fails and prevents duplicate retry requests", async () => {
    const retry = deferred<{ starred: boolean }>();
    calls.starred.mockRejectedValueOnce(new Error("Star service unavailable")).mockReturnValueOnce(retry.promise);

    render(star("retry-document"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Star service unavailable");
    const retryButton = screen.getByRole("button", { name: "Retry star status" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    expect(calls.starred).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying star status" })).toBeDisabled();

    await act(async () => retry.resolve({ starred: false }));
    expect(screen.getByRole("button", { name: "Star document" })).toHaveAttribute("data-starred", "false");
  });

  it.each(toggleCases)("admits one immediate $action activation and confirms its controlled success", async (testCase) => {
    const update = deferred<{ starred: boolean }>();
    const request = testCase.action === "star" ? calls.star : calls.unstar;
    calls.starred.mockResolvedValue({ starred: testCase.initial });
    request.mockReturnValue(update.promise);

    render(star(`${testCase.action}-success-document`));
    const button = await screen.findByRole("button", { name: testCase.actionLabel });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(`${testCase.action}-success-document`);
    expect(screen.getByRole("button", { name: testCase.pendingLabel })).toBeDisabled();
    expect(screen.getByRole("button", { name: testCase.pendingLabel })).toHaveAttribute("data-starred", String(testCase.next));

    await act(async () => update.resolve({ starred: testCase.next }));
    expect(screen.getByRole("button", { name: testCase.confirmedLabel })).toHaveAttribute("data-starred", String(testCase.next));
    expect(unhandled).toEqual([]);
  });

  it.each(toggleCases)("rolls back controlled $action and action-Retry failures before one successful retry", async (testCase) => {
    const failedAction = deferred<{ starred: boolean }>();
    const failedRetry = deferred<{ starred: boolean }>();
    const successfulRetry = deferred<{ starred: boolean }>();
    const request = testCase.action === "star" ? calls.star : calls.unstar;
    calls.starred.mockResolvedValue({ starred: testCase.initial });
    request
      .mockReturnValueOnce(failedAction.promise)
      .mockReturnValueOnce(failedRetry.promise)
      .mockReturnValueOnce(successfulRetry.promise);

    render(star(`${testCase.action}-failure-document`));
    fireEvent.click(await screen.findByRole("button", { name: testCase.actionLabel }));
    await act(async () => failedAction.reject(new Error(`Controlled ${testCase.action} failed`)));
    expect(screen.getByRole("alert")).toHaveTextContent(`Controlled ${testCase.action} failed`);
    expect(screen.getByRole("button", { name: testCase.retryLabel })).toHaveAttribute("data-starred", String(testCase.initial));

    const firstRetry = screen.getByRole("button", { name: testCase.retryLabel });
    fireEvent.click(firstRetry);
    fireEvent.click(firstRetry);
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => failedRetry.reject(new Error(`Controlled ${testCase.action} retry failed`)));
    expect(screen.getByRole("alert")).toHaveTextContent(`Controlled ${testCase.action} retry failed`);
    expect(screen.getByRole("button", { name: testCase.retryLabel })).toHaveAttribute("data-starred", String(testCase.initial));

    const secondRetry = screen.getByRole("button", { name: testCase.retryLabel });
    fireEvent.click(secondRetry);
    fireEvent.click(secondRetry);
    expect(request).toHaveBeenCalledTimes(3);
    await act(async () => successfulRetry.resolve({ starred: testCase.next }));
    expect(screen.getByRole("button", { name: testCase.confirmedLabel })).toHaveAttribute("data-starred", String(testCase.next));
    expect(unhandled).toEqual([]);
  });

  it("reverts a failed toggle and lets the same action be retried", async () => {
    const failed = deferred<{ starred: true }>();
    const retry = deferred<{ starred: true }>();
    calls.starred.mockResolvedValue({ starred: false });
    calls.star.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);

    render(star("toggle-document"));
    const button = await screen.findByRole("button", { name: "Star document" });
    fireEvent.click(button);
    expect(calls.star).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("data-starred", "true");
    expect(button).toBeDisabled();

    await act(async () => failed.reject(new Error("Could not save star")));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save star");
    const retryButton = screen.getByRole("button", { name: "Retry star document" });
    expect(retryButton).toHaveAttribute("data-starred", "false");
    expect(retryButton).toBeEnabled();

    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(calls.star).toHaveBeenCalledTimes(2);
    expect(calls.star.mock.calls).toEqual([["toggle-document"], ["toggle-document"]]);
    const pendingButton = screen.getByRole("button", { name: "Starring document…" });
    expect(pendingButton).toBeDisabled();
    expect(pendingButton).toHaveAttribute("aria-busy", "true");
    expect(pendingButton).toHaveAttribute("data-starred", "true");

    await act(async () => retry.resolve({ starred: true }));
    const confirmedButton = screen.getByRole("button", { name: "Unstar document" });
    expect(confirmedButton).toHaveAttribute("data-starred", "true");
    expect(confirmedButton).toHaveAttribute("data-state", "ready");
    expect(confirmedButton).toBeEnabled();
    expect(confirmedButton).not.toHaveAttribute("aria-busy");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls.star).toHaveBeenCalledTimes(2);
    expect(calls.unstar).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it("ignores a star-status response from the previously open document", async () => {
    const oldLoad = deferred<{ starred: boolean }>();
    const newLoad = deferred<{ starred: boolean }>();
    calls.starred.mockReturnValueOnce(oldLoad.promise).mockReturnValueOnce(newLoad.promise);

    const view = render(star("old-document"));
    view.rerender(star("new-document"));
    await waitFor(() => expect(calls.starred).toHaveBeenCalledTimes(2));

    await act(async () => newLoad.resolve({ starred: false }));
    expect(screen.getByRole("button", { name: "Star document" })).toHaveAttribute("data-starred", "false");

    await act(async () => oldLoad.resolve({ starred: true }));
    expect(screen.getByRole("button", { name: "Star document" })).toHaveAttribute("data-starred", "false");
  });

  it("does not let a failed toggle from the previous document change the current document", async () => {
    const oldWrite = deferred<{ starred: true }>();
    calls.starred.mockResolvedValueOnce({ starred: false }).mockResolvedValueOnce({ starred: true });
    calls.star.mockReturnValue(oldWrite.promise);

    const view = render(star("old-document"));
    fireEvent.click(await screen.findByRole("button", { name: "Star document" }));
    expect(calls.star).toHaveBeenCalledWith("old-document");

    view.rerender(star("new-document"));
    expect(await screen.findByRole("button", { name: "Unstar document" })).toHaveAttribute("data-starred", "true");

    await act(async () => oldWrite.reject(new Error("Old document failed")));
    expect(screen.getByRole("button", { name: "Unstar document" })).toHaveAttribute("data-starred", "true");
    expect(screen.queryByText("Old document failed")).toBeNull();
  });

  it.each(["success", "failure"] as const)(
    "retires an old load $settlement at the replacement layout boundary without disturbing the new owner",
    async (settlement) => {
      const oldLoad = deferred<{ starred: boolean }>();
      const newLoad = deferred<{ starred: boolean }>();
      const retry = deferred<{ starred: boolean }>();
      calls.starred.mockReturnValueOnce(oldLoad.promise).mockReturnValueOnce(newLoad.promise).mockReturnValueOnce(retry.promise);

      const view = render(<HeaderStarBoundary docId="boundary-old-load" />);
      expect(calls.starred).toHaveBeenCalledTimes(1);
      view.rerender(
        <HeaderStarBoundary
          docId="boundary-new-load"
          boundary={1}
          onBoundary={() => {
            expect(calls.starred).toHaveBeenCalledTimes(1);
            if (settlement === "success") oldLoad.resolve({ starred: true });
            else oldLoad.reject(new Error("Retired load failed"));
          }}
        />,
      );
      await act(async () => {
        await Promise.allSettled([oldLoad.promise]);
        await Promise.resolve();
      });

      expect(calls.starred).toHaveBeenCalledTimes(2);
      expect(calls.starred.mock.calls.map(([id]) => id)).toEqual(["boundary-old-load", "boundary-new-load"]);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("header-star")).toBeNull();

      await act(async () => newLoad.reject(new Error("Current load failed")));
      expect(screen.getByRole("alert")).toHaveTextContent("Current load failed");
      const retryButton = screen.getByRole("button", { name: "Retry star status" });
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
      expect(calls.starred).toHaveBeenCalledTimes(3);
      expect(calls.starred).toHaveBeenLastCalledWith("boundary-new-load");

      await act(async () => retry.resolve({ starred: false }));
      expect(screen.getByRole("button", { name: "Star document" })).toHaveAttribute("data-state", "ready");
      expect(unhandled).toEqual([]);
    },
  );

  it.each(toggleCases.flatMap((testCase) => (["success", "failure"] as const).map((settlement) => ({ ...testCase, settlement }))))(
    "retires old $action $settlement at replacement while the new document remains independently usable",
    async (testCase) => {
      const oldWrite = deferred<{ starred: boolean }>();
      const newLoad = deferred<{ starred: boolean }>();
      const newWrite = deferred<{ starred: boolean }>();
      const request = testCase.action === "star" ? calls.star : calls.unstar;
      calls.starred.mockResolvedValueOnce({ starred: testCase.initial }).mockReturnValueOnce(newLoad.promise);
      request.mockReturnValueOnce(oldWrite.promise).mockReturnValueOnce(newWrite.promise);

      const view = render(<HeaderStarBoundary docId="boundary-old-action" />);
      fireEvent.click(await screen.findByRole("button", { name: testCase.actionLabel }));
      view.rerender(
        <HeaderStarBoundary
          docId="boundary-new-action"
          boundary={1}
          onBoundary={() => {
            expect(calls.starred).toHaveBeenCalledTimes(1);
            if (testCase.settlement === "success") oldWrite.resolve({ starred: testCase.next });
            else oldWrite.reject(new Error("Retired action failed"));
          }}
        />,
      );
      await act(async () => {
        await Promise.allSettled([oldWrite.promise]);
        await Promise.resolve();
      });

      expect(calls.starred).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("header-star")).toBeNull();

      await act(async () => newLoad.resolve({ starred: testCase.initial }));
      const currentButton = screen.getByRole("button", { name: testCase.actionLabel });
      expect(currentButton).toHaveAttribute("data-starred", String(testCase.initial));
      fireEvent.click(currentButton);
      fireEvent.click(currentButton);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenLastCalledWith("boundary-new-action");

      await act(async () => newWrite.resolve({ starred: testCase.next }));
      expect(screen.getByRole("button", { name: testCase.confirmedLabel })).toHaveAttribute("data-state", "ready");
      expect(unhandled).toEqual([]);
    },
  );

  it.each(["success", "failure"] as const)(
    "retires an old load $settlement when ready becomes false, then admits one fresh load",
    async (settlement) => {
      const oldLoad = deferred<{ starred: boolean }>();
      const freshLoad = deferred<{ starred: boolean }>();
      calls.starred.mockReturnValueOnce(oldLoad.promise).mockReturnValueOnce(freshLoad.promise);

      const view = render(<HeaderStarBoundary docId="ready-document" />);
      view.rerender(
        <HeaderStarBoundary
          docId="ready-document"
          ready={false}
          boundary={1}
          onBoundary={() => {
            if (settlement === "success") oldLoad.resolve({ starred: true });
            else oldLoad.reject(new Error("Retired not-ready load failed"));
          }}
        />,
      );
      await act(async () => {
        await Promise.allSettled([oldLoad.promise]);
        await Promise.resolve();
      });

      expect(calls.starred).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("header-star")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();

      view.rerender(<HeaderStarBoundary docId="ready-document" ready boundary={2} />);
      expect(calls.starred).toHaveBeenCalledTimes(2);
      await act(async () => freshLoad.resolve({ starred: false }));
      expect(screen.getByRole("button", { name: "Star document" })).toHaveAttribute("data-state", "ready");
      expect(unhandled).toEqual([]);
    },
  );

  it.each(["success", "failure"] as const)(
    "retires an old load $settlement before the parent removal layout boundary",
    async (settlement) => {
      const oldLoad = deferred<{ starred: boolean }>();
      calls.starred.mockReturnValue(oldLoad.promise);

      const view = render(<HeaderStarBoundary docId="removed-document" />);
      view.rerender(
        <HeaderStarBoundary
          docId="removed-document"
          present={false}
          boundary={1}
          onBoundary={() => {
            if (settlement === "success") oldLoad.resolve({ starred: true });
            else oldLoad.reject(new Error("Retired removed load failed"));
          }}
        />,
      );
      await act(async () => {
        await Promise.allSettled([oldLoad.promise]);
        await Promise.resolve();
      });

      expect(calls.starred).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("header-star")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(unhandled).toEqual([]);
    },
  );
});
