// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", async (original) => ({ ...await original<typeof import("@/lib/clipboard")>(), copyText }));

import { ReaderCopyLink } from "./copy-link";

const DOC_ID = "doc-919";
const readerUrl = () => `${window.location.origin}/p/${DOC_ID}`;

beforeEach(() => {
  copyText.mockReset().mockResolvedValue(true);
});

afterEach(cleanup);

describe("ReaderCopyLink", () => {
  it("copies the absolute canonical reader URL and briefly exposes the Copied label", async () => {
    render(<ReaderCopyLink docId={DOC_ID} />);
    const button = screen.getByRole("button", { name: "Copy link" });
    await waitFor(() => expect(button).toBeEnabled());

    fireEvent.click(button);

    await waitFor(() => expect(copyText).toHaveBeenCalledWith(readerUrl()));
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Copied" })).toBe(button);
  });

  it("shows, focuses, and selects the exact URL when both copy paths fail", async () => {
    copyText.mockResolvedValue(false);
    render(<ReaderCopyLink docId={DOC_ID} />);
    const button = screen.getByRole("button", { name: "Copy link" });
    await waitFor(() => expect(button).toBeEnabled());

    fireEvent.click(button);

    const fallback = await screen.findByRole("textbox", { name: "Reader link" });
    expect(fallback).toHaveValue(readerUrl());
    expect(fallback).toHaveFocus();
    expect(fallback).toHaveProperty("selectionStart", 0);
    expect(fallback).toHaveProperty("selectionEnd", readerUrl().length);
    expect(copyText).toHaveBeenCalledTimes(1);
  });

  it("keeps an accessible name and a 44px icon-only phone target", async () => {
    render(<ReaderCopyLink docId={DOC_ID} />);
    const button = screen.getByRole("button", { name: "Copy link" });
    await waitFor(() => expect(button).toBeEnabled());

    expect(button).toHaveClass("h-11", "w-11", "sm:h-8", "sm:w-auto");
    expect(within(button).getByText("Copy link")).toHaveClass("hidden", "sm:inline");
    expect(button).toHaveAccessibleName("Copy link");
  });
});
