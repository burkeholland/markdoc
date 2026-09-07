// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", async (original) => ({ ...await original<typeof import("@/lib/clipboard")>(), copyText }));

import { ReaderCopyLink } from "./copy-link";

const DOC_ID = "doc-919";
const NEXT_DOC_ID = "doc-920";
const readerUrl = (docId = DOC_ID) => `${window.location.origin}/p/${docId}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function ReaderBoundary({
  docId = DOC_ID,
  show = true,
  boundary = 0,
  onLayout,
}: {
  docId?: string;
  show?: boolean;
  boundary?: number;
  onLayout?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onLayout?.();
  }, [boundary, onLayout]);
  return show ? <ReaderCopyLink docId={docId} /> : null;
}

async function enabledCopyButton() {
  const button = screen.getByRole("button", { name: "Copy link" });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

beforeEach(() => {
  copyText.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ReaderCopyLink", () => {
  it("copies the absolute canonical reader URL and briefly exposes the Copied label", async () => {
    render(<ReaderCopyLink docId={DOC_ID} />);
    const button = await enabledCopyButton();

    fireEvent.click(button);

    await waitFor(() => expect(copyText).toHaveBeenCalledWith(readerUrl()));
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Copied" })).toBe(button);
  });

  it("shows, focuses, and selects the exact URL when both copy paths fail", async () => {
    copyText.mockResolvedValue(false);
    render(<ReaderCopyLink docId={DOC_ID} />);
    const button = await enabledCopyButton();

    fireEvent.click(button);

    const fallback = await screen.findByRole("textbox", { name: "Reader link" });
    expect(fallback).toHaveValue(readerUrl());
    expect(fallback).toHaveFocus();
    expect(fallback).toHaveProperty("selectionStart", 0);
    expect(fallback).toHaveProperty("selectionEnd", readerUrl().length);
    expect(copyText).toHaveBeenCalledTimes(1);
  });

  it("removes document A's fallback before document B's parent layout boundary", async () => {
    copyText.mockResolvedValue(false);
    const select = vi.spyOn(HTMLInputElement.prototype, "select");
    const { rerender } = render(<ReaderBoundary />);
    fireEvent.click(await enabledCopyButton());
    const oldFallback = await screen.findByRole("textbox", { name: "Reader link" });
    expect(oldFallback).toHaveValue(readerUrl());
    expect(oldFallback).toHaveFocus();
    select.mockClear();
    let fallbackValueAtBoundary: string | null | undefined;
    let oldFallbackFocusedAtBoundary: boolean | undefined;
    let labelAtBoundary: string | null | undefined;

    rerender(
      <ReaderBoundary
        docId={NEXT_DOC_ID}
        boundary={1}
        onLayout={() => {
          fallbackValueAtBoundary = screen.queryByRole<HTMLInputElement>("textbox", { name: "Reader link" })?.value ?? null;
          oldFallbackFocusedAtBoundary = document.activeElement === oldFallback;
          labelAtBoundary = screen.getByTestId("reader-copy-link").getAttribute("aria-label");
        }}
      />,
    );

    expect(fallbackValueAtBoundary).toBeNull();
    expect(oldFallbackFocusedAtBoundary).toBe(false);
    expect(labelAtBoundary).toBe("Copy link");
    expect(oldFallback).not.toBeInTheDocument();
    expect(oldFallback).toHaveValue(readerUrl());
    expect(select).not.toHaveBeenCalled();
  });

  it("retires document A at replacement and lets the same component copy and select document B's URL", async () => {
    const oldAttempt = deferred<boolean>();
    const currentAttempt = deferred<boolean>();
    copyText.mockReturnValueOnce(oldAttempt.promise).mockReturnValueOnce(currentAttempt.promise);
    const { rerender } = render(<ReaderBoundary />);
    fireEvent.click(await enabledCopyButton());
    expect(copyText).toHaveBeenCalledExactlyOnceWith(readerUrl());
    let labelAtBoundary: string | null | undefined;

    rerender(
      <ReaderBoundary
        docId={NEXT_DOC_ID}
        boundary={1}
        onLayout={() => {
          labelAtBoundary = screen.getByTestId("reader-copy-link").getAttribute("aria-label");
          oldAttempt.resolve(true);
        }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(labelAtBoundary).toBe("Copy link");

    fireEvent.click(await enabledCopyButton());
    expect(copyText).toHaveBeenNthCalledWith(2, readerUrl(NEXT_DOC_ID));
    await act(async () => {
      currentAttempt.resolve(false);
      await Promise.resolve();
    });

    const fallback = await screen.findByRole("textbox", { name: "Reader link" });
    expect(fallback).toHaveValue(readerUrl(NEXT_DOC_ID));
    expect(fallback).toHaveFocus();
    expect(fallback).toHaveProperty("selectionStart", 0);
    expect(fallback).toHaveProperty("selectionEnd", readerUrl(NEXT_DOC_ID).length);
  });

  it("retires a rejected copy on removal and gives a remounted document independent fallback", async () => {
    const oldAttempt = deferred<boolean>();
    copyText.mockReturnValueOnce(oldAttempt.promise).mockResolvedValueOnce(false);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const { rerender } = render(<ReaderBoundary />);

    try {
      fireEvent.click(await enabledCopyButton());
      let buttonAtBoundary: HTMLElement | null | undefined;
      rerender(
        <ReaderBoundary
          show={false}
          boundary={1}
          onLayout={() => {
            buttonAtBoundary = screen.queryByTestId("reader-copy-link");
            oldAttempt.reject(new Error("removed copy failed"));
          }}
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });

      expect(buttonAtBoundary).toBeNull();
      expect(screen.queryByTestId("reader-copy-link-fallback")).not.toBeInTheDocument();
      expect(unhandled).toEqual([]);

      rerender(<ReaderBoundary docId={NEXT_DOC_ID} boundary={2} />);
      fireEvent.click(await enabledCopyButton());
      expect(copyText).toHaveBeenNthCalledWith(2, readerUrl(NEXT_DOC_ID));
      const fallback = await screen.findByRole("textbox", { name: "Reader link" });
      expect(fallback).toHaveValue(readerUrl(NEXT_DOC_ID));
      expect(fallback).toHaveFocus();
      expect(fallback).toHaveProperty("selectionEnd", readerUrl(NEXT_DOC_ID).length);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps an accessible name and a 44px icon-only phone target", async () => {
    render(<ReaderCopyLink docId={DOC_ID} />);
    const button = await enabledCopyButton();

    expect(button).toHaveClass("h-11", "w-11", "sm:h-8", "sm:w-auto");
    expect(within(button).getByText("Copy link")).toHaveClass("hidden", "sm:inline");
    expect(button).toHaveAccessibleName("Copy link");
  });
});
