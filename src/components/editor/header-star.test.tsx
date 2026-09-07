// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function star(docId: string) {
  return (
    <TooltipProvider>
      <HeaderStar docId={docId} ready />
    </TooltipProvider>
  );
}

beforeEach(() => {
  calls.starred.mockReset();
  calls.star.mockReset();
  calls.unstar.mockReset();
});

afterEach(() => cleanup());

describe("editor header star recovery", () => {
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

  it("reverts a failed toggle and lets the same action be retried", async () => {
    const failed = deferred<{ starred: true }>();
    calls.starred.mockResolvedValue({ starred: false });
    calls.star.mockReturnValueOnce(failed.promise).mockResolvedValueOnce({ starred: true });

    render(star("toggle-document"));
    const button = await screen.findByRole("button", { name: "Star document" });
    fireEvent.click(button);
    expect(button).toHaveAttribute("data-starred", "true");
    expect(button).toBeDisabled();

    await act(async () => failed.reject(new Error("Could not save star")));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save star");
    const retryButton = screen.getByRole("button", { name: "Retry star document" });
    expect(retryButton).toHaveAttribute("data-starred", "false");

    fireEvent.click(retryButton);
    await waitFor(() => expect(calls.star).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Unstar document" })).toHaveAttribute("data-starred", "true");
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
});
