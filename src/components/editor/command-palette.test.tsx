// @vitest-environment jsdom
import { useCallback, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./command-palette";
import type { Command } from "./commands";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function command(id: string, title: string, run = vi.fn()): Command {
  return { id, title, keywords: [], group: "Test", run };
}

function childCommand(id: string, title: string, children: Command["children"]): Command {
  return { ...command(id, title), children };
}

async function settle<T>(pending: ReturnType<typeof deferred<T>>, kind: "resolve", value: T): Promise<void>;
async function settle<T>(pending: ReturnType<typeof deferred<T>>, kind: "reject", value: unknown): Promise<void>;
async function settle<T>(pending: ReturnType<typeof deferred<T>>, kind: "resolve" | "reject", value: T | unknown) {
  await act(async () => {
    if (kind === "resolve") pending.resolve(value as T);
    else pending.reject(value);
    await pending.promise.catch(() => undefined);
  });
}

function Harness({ items, initiallyOpen = true }: { items: Command[]; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const commands = useCallback(() => items, [items]);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} commands={commands} />
    </>
  );
}

let originalScrollIntoView: typeof Element.prototype.scrollIntoView;

beforeEach(() => {
  localStorage.clear();
  originalScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe("CommandPalette child loading", () => {
  it("announces a failed load and retries once without duplicate click or Enter requests", async () => {
    const first = deferred<Command[]>();
    const retry = deferred<Command[]>();
    const children = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    const recent = childCommand("recent", "Recent documents…", children);
    const unhandled = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener("unhandledrejection", unhandled);

    try {
      localStorage.setItem("markdoc:paletteRecent", JSON.stringify(["recent"]));
      render(<Harness items={[recent, command("other", "Other command")]} />);
      const input = await screen.findByTestId("palette-input");
      const recentOption = screen.getByTestId("palette-item-recent");

      fireEvent.click(recentOption);
      fireEvent.click(recentOption);
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.change(input, { target: { value: "recent" } });
      fireEvent.click(screen.getByTestId("palette-item-recent"));
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(children).toHaveBeenCalledOnce());
      expect(screen.getByRole("status")).toHaveTextContent("Loading…");
      expect(recentOption).toHaveAttribute("aria-disabled", "true");

      await settle(first, "reject", new Error("Recent documents are unavailable."));

      const alert = screen.getByRole("alert");
      expect(alert).toHaveAttribute("aria-atomic", "true");
      expect(alert).toHaveTextContent("Recent documents are unavailable.");
      expect(within(alert).getAllByRole("button", { name: "Retry" })).toHaveLength(1);
      fireEvent.change(input, { target: { value: "" } });
      expect(screen.getByTestId("palette-item-other")).toBeInTheDocument();
      expect(unhandled).not.toHaveBeenCalled();

      const retryButton = within(alert).getByRole("button", { name: "Retry" });
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);

      await waitFor(() => expect(children).toHaveBeenCalledTimes(2));
      expect(within(alert).getByRole("button", { name: "Retrying…" })).toBeDisabled();

      await settle(retry, "resolve", [command("recent-one", "Recent one")]);

      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTestId("palette-item-recent-one")).toBeInTheDocument();
      expect(screen.getByText("Recent documents")).toBeInTheDocument();
      expect(input).toHaveFocus();
      expect(children).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });

  it("ignores a child resolution from before the palette was closed and reopened", async () => {
    const stale = deferred<Command[]>();
    const current = deferred<Command[]>();
    const children = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const recent = childCommand("recent", "Recent documents…", children);
    const commands = () => [recent];
    const onOpenChange = vi.fn();
    const rendered = render(<CommandPalette open onOpenChange={onOpenChange} commands={commands} />);

    fireEvent.click(await screen.findByTestId("palette-item-recent"));
    await waitFor(() => expect(children).toHaveBeenCalledOnce());

    rendered.rerender(<CommandPalette open={false} onOpenChange={onOpenChange} commands={commands} />);
    rendered.rerender(<CommandPalette open onOpenChange={onOpenChange} commands={commands} />);

    await settle(stale, "resolve", [command("stale", "Stale result")]);

    expect(screen.queryByTestId("palette-item-stale")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("palette-item-recent")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Enter" });
    await waitFor(() => expect(children).toHaveBeenCalledTimes(2));
    await settle(current, "resolve", [command("current", "Current result")]);
    expect(screen.getByTestId("palette-item-current")).toBeInTheDocument();
  });

  it("lets a different child supersede pending work without a stale error or focus change", async () => {
    const stale = deferred<Command[]>();
    const current = deferred<Command[]>();
    const first = childCommand("first", "First child…", vi.fn(() => stale.promise));
    const second = childCommand("second", "Second child…", vi.fn(() => current.promise));
    const parent = childCommand("parent", "Parent…", () => [first, second]);

    render(<Harness items={[parent]} />);
    fireEvent.click(await screen.findByTestId("palette-item-parent"));
    await screen.findByTestId("palette-item-first");

    fireEvent.click(screen.getByTestId("palette-item-first"));
    fireEvent.click(screen.getByTestId("palette-item-second"));
    const back = screen.getByRole("button", { name: "Back" });
    back.focus();

    await settle(stale, "reject", new Error("Stale child failed."));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("palette-item-stale")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(back).toHaveFocus();

    await settle(current, "resolve", [command("second-result", "Second result")]);

    expect(screen.getByTestId("palette-item-second-result")).toBeInTheDocument();
    expect(screen.queryByText("Stale child failed.")).toBeNull();
    expect(screen.getByTestId("palette-input")).toHaveFocus();
  });

  it("invalidates nested work on Back and preserves keyboard execution and focus restoration", async () => {
    const stale = deferred<Command[]>();
    const run = vi.fn();
    const nested = childCommand("nested", "Nested child…", vi.fn(() => stale.promise));
    const parent = childCommand("parent", "Parent…", () => [nested]);

    render(<Harness items={[parent, command("ordinary", "Ordinary command", run)]} initiallyOpen={false} />);
    const opener = screen.getByRole("button", { name: "Open palette" });
    opener.focus();
    fireEvent.click(opener);

    const input = await screen.findByTestId("palette-input");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByTestId("palette-item-nested");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("palette-item-parent")).toBeInTheDocument();
    await settle(stale, "resolve", [command("stale", "Stale result")]);
    expect(screen.queryByTestId("palette-item-stale")).toBeNull();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "palette-item-ordinary");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(opener).toHaveFocus();
  });
});
