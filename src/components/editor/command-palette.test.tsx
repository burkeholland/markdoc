// @vitest-environment jsdom
import { useCallback, useEffect, useLayoutEffect, useState, type ChangeEventHandler, type KeyboardEventHandler, type MouseEventHandler } from "react";
import { createRoot } from "react-dom/client";
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

function reactProps<T extends object>(element: Element): T {
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactProps$"));
  if (!key) throw new Error("React props were not published on the element");
  return (element as unknown as Record<string, unknown>)[key] as T;
}

function exactEvent<T extends HTMLElement>(currentTarget: T, extra: Record<string, unknown> = {}) {
  return { currentTarget, preventDefault: vi.fn(), ...extra };
}

interface RowHandlerProps {
  onClick: MouseEventHandler<HTMLDivElement>;
  onMouseEnter: MouseEventHandler<HTMLDivElement>;
}

interface ButtonHandlerProps {
  onClick: MouseEventHandler<HTMLButtonElement>;
}

interface InputHandlerProps {
  onChange: ChangeEventHandler<HTMLInputElement>;
  onKeyDown: KeyboardEventHandler<HTMLInputElement>;
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

function PassiveCleanupProbe({ onCleanup }: { onCleanup: () => void }) {
  useEffect(() => onCleanup, [onCleanup]);
  return null;
}

function ControlledPaletteMount({
  items,
  onPassiveCleanup,
}: {
  items: Command[];
  onPassiveCleanup: () => void;
}) {
  const commands = useCallback(() => items, [items]);
  return (
    <>
      <CommandPalette open onOpenChange={() => {}} commands={commands} />
      <PassiveCleanupProbe onCleanup={onPassiveCleanup} />
    </>
  );
}

function StatefulPaletteMount({ items, onPassiveCleanup }: { items: Command[]; onPassiveCleanup: () => void }) {
  return (
    <>
      <Harness items={items} initiallyOpen={false} />
      <PassiveCleanupProbe onCleanup={onPassiveCleanup} />
    </>
  );
}

function PaletteBoundary({
  instance,
  items,
  present = true,
  stateful = false,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  instance: string;
  items: Command[];
  present?: boolean;
  stateful?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  if (!present) return null;
  return stateful ? (
    <StatefulPaletteMount key={instance} items={items} onPassiveCleanup={onPassiveCleanup} />
  ) : (
    <ControlledPaletteMount key={instance} items={items} onPassiveCleanup={onPassiveCleanup} />
  );
}

function SameMountBoundary({
  items,
  revision,
  onBoundary,
}: {
  items: Command[];
  revision: number;
  onBoundary?: () => void;
}) {
  const commands = useCallback(() => items, [items]);
  useLayoutEffect(() => {
    if (revision > 0) onBoundary?.();
  }, [revision, onBoundary]);
  return <CommandPalette open onOpenChange={() => {}} commands={commands} />;
}

let originalScrollIntoView: typeof Element.prototype.scrollIntoView;
const unhandledRejections: unknown[] = [];
const recordUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(reason);
};

beforeEach(() => {
  localStorage.clear();
  originalScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  unhandledRejections.length = 0;
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  process.off("unhandledRejection", recordUnhandledRejection);
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.clearAllTimers();
  vi.useRealTimers();
  expect(unhandledRejections).toEqual([]);
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

  it.each(
    (["replacement", "removal"] as const).flatMap((transition) =>
      (["resolve", "reject"] as const).map((settlement) => ({ transition, settlement })),
    ),
  )(
    "retires an old child $settlement at the parent-layout $transition boundary while the current visit stays usable",
    async ({ transition, settlement }) => {
      vi.useFakeTimers();
      const oldPending = deferred<Command[]>();
      const currentPending = deferred<Command[]>();
      const oldProvider = vi.fn(() => oldPending.promise);
      const currentProvider = vi.fn(() => currentPending.promise);
      const oldItems = [childCommand("old-child", "Old child…", oldProvider)];
      const currentItems = [childCommand("current-child", "Current child…", currentProvider)];
      const host = document.createElement("div");
      const focusOwner = document.createElement("button");
      focusOwner.textContent = "Persistent focus owner";
      document.body.append(focusOwner, host);
      const root = createRoot(host);
      let passiveCleanups = 0;
      let passiveCleanupsAtBoundary = -1;
      const recordPassiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        focusOwner.focus();
        await act(async () => {
          root.render(
            <PaletteBoundary instance="old" items={oldItems} onPassiveCleanup={recordPassiveCleanup} />,
          );
        });
        const oldInput = screen.getByTestId("palette-input");
        expect(oldInput).toHaveFocus();
        fireEvent.click(screen.getByTestId("palette-item-old-child"));
        await act(async () => {});
        expect(oldProvider).toHaveBeenCalledOnce();
        expect(screen.getByRole("status")).toHaveTextContent("Loading…");

        let boundaryReached!: () => void;
        const atBoundary = new Promise<void>((resolve) => {
          boundaryReached = resolve;
        });
        root.render(
          <PaletteBoundary
            instance={transition === "replacement" ? "current" : "old"}
            items={transition === "replacement" ? currentItems : oldItems}
            present={transition === "replacement"}
            boundary={1}
            onBoundary={() => {
              passiveCleanupsAtBoundary = passiveCleanups;
              if (transition === "removal") focusOwner.focus();
              if (settlement === "resolve") oldPending.resolve([command("stale-child", "Stale child")]);
              else oldPending.reject(new Error("Retired child failed"));
              boundaryReached();
            }}
            onPassiveCleanup={recordPassiveCleanup}
          />,
        );
        await atBoundary;
        await act(async () => {
          await Promise.allSettled([oldPending.promise]);
          await Promise.resolve();
        });

        expect(passiveCleanupsAtBoundary).toBe(0);
        expect(oldProvider).toHaveBeenCalledOnce();
        expect(screen.queryByTestId("palette-item-stale-child")).toBeNull();
        expect(screen.queryByText("Retired child failed")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();

        if (transition === "replacement") {
          expect(screen.getByTestId("palette-item-current-child")).toBeInTheDocument();
          expect(screen.getByTestId("palette-input")).toHaveFocus();
        } else {
          expect(screen.queryByTestId("command-palette")).toBeNull();
          expect(focusOwner).toHaveFocus();
          await act(async () => {
            root.render(
              <PaletteBoundary
                instance="current"
                items={currentItems}
                boundary={2}
                onPassiveCleanup={recordPassiveCleanup}
              />,
            );
          });
        }

        const currentInput = screen.getByTestId("palette-input");
        expect(currentInput).toHaveFocus();
        fireEvent.click(screen.getByTestId("palette-item-current-child"));
        await act(async () => {});
        expect(oldProvider).toHaveBeenCalledOnce();
        expect(currentProvider).toHaveBeenCalledOnce();
        expect(screen.getByRole("status")).toHaveTextContent("Loading…");
        expect(screen.getByTestId("palette-item-current-child")).toHaveAttribute("aria-disabled", "true");
        expect(screen.queryByRole("alert")).toBeNull();

        await act(async () => {
          currentPending.resolve([command("current-result", "Current result")]);
          await currentPending.promise;
        });
        expect(screen.queryByRole("status")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByTestId("palette-item-current-result")).toBeInTheDocument();
        expect(screen.queryByTestId("palette-item-stale-child")).toBeNull();
        expect(currentInput).toHaveFocus();
        expect(oldProvider).toHaveBeenCalledOnce();
        expect(currentProvider).toHaveBeenCalledOnce();
        expect(unhandledRejections).toEqual([]);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        focusOwner.remove();
      }
    },
  );

  it("retires a pending Retry at replacement without publishing its result into the current visit", async () => {
    vi.useFakeTimers();
    const oldRetry = deferred<Command[]>();
    const currentPending = deferred<Command[]>();
    const oldProvider = vi.fn().mockRejectedValueOnce(new Error("Old child failed")).mockReturnValueOnce(oldRetry.promise);
    const currentProvider = vi.fn(() => currentPending.promise);
    const oldItems = [childCommand("old-child", "Old child…", oldProvider)];
    const currentItems = [childCommand("current-child", "Current child…", currentProvider)];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let passiveCleanups = 0;
    let passiveCleanupsAtBoundary = -1;
    const recordPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      await act(async () => {
        root.render(<PaletteBoundary instance="old" items={oldItems} onPassiveCleanup={recordPassiveCleanup} />);
      });
      fireEvent.click(screen.getByTestId("palette-item-old-child"));
      await act(async () => {});
      expect(screen.getByRole("alert")).toHaveTextContent("Old child failed");
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await act(async () => {});
      expect(oldProvider).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });
      root.render(
        <PaletteBoundary
          instance="current"
          items={currentItems}
          boundary={1}
          onBoundary={() => {
            passiveCleanupsAtBoundary = passiveCleanups;
            oldRetry.resolve([command("stale-retry", "Stale Retry result")]);
            boundaryReached();
          }}
          onPassiveCleanup={recordPassiveCleanup}
        />,
      );
      await atBoundary;
      await act(async () => {
        await oldRetry.promise;
      });

      expect(passiveCleanupsAtBoundary).toBe(0);
      expect(oldProvider).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId("palette-item-stale-retry")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTestId("palette-item-current-child")).toBeInTheDocument();
      expect(screen.getByTestId("palette-input")).toHaveFocus();

      fireEvent.click(screen.getByTestId("palette-item-current-child"));
      await act(async () => {});
      expect(currentProvider).toHaveBeenCalledOnce();
      expect(screen.getByRole("status")).toHaveTextContent("Loading…");
      await act(async () => {
        currentPending.resolve([command("current-retry-result", "Current Retry result")]);
        await currentPending.promise;
      });
      expect(screen.getByTestId("palette-item-current-retry-result")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTestId("palette-input")).toHaveFocus();
      expect(oldProvider).toHaveBeenCalledTimes(2);
      expect(currentProvider).toHaveBeenCalledOnce();
      expect(unhandledRejections).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("CommandPalette command ownership", () => {
  it.each(["replacement", "removal"] as const)(
    "cancels a retired command timer on $transition and runs only the current palette command after focus restoration",
    async (transition) => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const oldRun = vi.fn();
      let focusAtCurrentRun: Element | null = null;
      const currentRun = vi.fn(() => {
        focusAtCurrentRun = document.activeElement;
      });
      const oldItems = [command("old-command", "Old command", oldRun)];
      const currentItems = [command("current-command", "Current command", currentRun)];
      const host = document.createElement("div");
      const focusOwner = document.createElement("button");
      focusOwner.textContent = "Persistent focus owner";
      document.body.append(focusOwner, host);
      const root = createRoot(host);
      let passiveCleanups = 0;
      let passiveCleanupsAtBoundary = -1;
      let timersAtBoundary = -1;
      let oldTimerClearedAtBoundary = false;
      const recordPassiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        await act(async () => {
          root.render(
            <PaletteBoundary
              instance="old"
              items={oldItems}
              stateful
              onPassiveCleanup={recordPassiveCleanup}
            />,
          );
        });
        const oldOpener = screen.getByRole("button", { name: "Open palette" });
        oldOpener.focus();
        fireEvent.click(oldOpener);
        await act(async () => {});
        expect(screen.getByTestId("palette-input")).toHaveFocus();
        fireEvent.click(screen.getByTestId("palette-item-old-command"));
        await act(async () => {});
        expect(screen.queryByTestId("command-palette")).toBeNull();
        await act(async () => {
          await vi.advanceTimersToNextTimerAsync();
        });
        expect(oldOpener).toHaveFocus();
        const oldCommandTimer = setTimeoutSpy.mock.results.at(-1)?.value;
        const timersBeforeRetirement = vi.getTimerCount();
        expect(oldCommandTimer).toBeDefined();
        expect(timersBeforeRetirement).toBeGreaterThanOrEqual(1);
        expect(oldRun).not.toHaveBeenCalled();

        let boundaryReached!: () => void;
        const atBoundary = new Promise<void>((resolve) => {
          boundaryReached = resolve;
        });
        root.render(
          <PaletteBoundary
            instance={transition === "replacement" ? "current" : "old"}
            items={transition === "replacement" ? currentItems : oldItems}
            present={transition === "replacement"}
            stateful
            boundary={1}
            onBoundary={() => {
              passiveCleanupsAtBoundary = passiveCleanups;
              timersAtBoundary = vi.getTimerCount();
              oldTimerClearedAtBoundary = clearTimeoutSpy.mock.calls.some(([timer]) => timer === oldCommandTimer);
              focusOwner.focus();
              boundaryReached();
            }}
            onPassiveCleanup={recordPassiveCleanup}
          />,
        );
        await atBoundary;
        await act(async () => {});

        expect(passiveCleanupsAtBoundary).toBe(0);
        expect(oldTimerClearedAtBoundary).toBe(true);
        expect(timersAtBoundary).toBeLessThan(timersBeforeRetirement);
        expect(focusOwner).toHaveFocus();
        await act(async () => {
          await vi.runAllTimersAsync();
        });
        expect(vi.getTimerCount()).toBe(0);
        expect(oldRun).not.toHaveBeenCalled();
        expect(currentRun).not.toHaveBeenCalled();

        if (transition === "removal") {
          await act(async () => {
            root.render(
              <PaletteBoundary
                instance="current"
                items={currentItems}
                stateful
                boundary={2}
                onPassiveCleanup={recordPassiveCleanup}
              />,
            );
          });
        }

        const currentOpener = screen.getByRole("button", { name: "Open palette" });
        currentOpener.focus();
        fireEvent.click(currentOpener);
        await act(async () => {});
        expect(screen.getByTestId("palette-input")).toHaveFocus();
        fireEvent.click(screen.getByTestId("palette-item-current-command"));
        await act(async () => {});
        expect(screen.queryByTestId("command-palette")).toBeNull();
        await act(async () => {
          await vi.advanceTimersToNextTimerAsync();
        });
        expect(currentOpener).toHaveFocus();
        expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
        expect(oldRun).not.toHaveBeenCalled();
        expect(currentRun).not.toHaveBeenCalled();

        await act(async () => {
          await vi.runAllTimersAsync();
        });
        expect(oldRun).not.toHaveBeenCalled();
        expect(currentRun).toHaveBeenCalledOnce();
        expect(focusAtCurrentRun).toBe(currentOpener);
        expect(vi.getTimerCount()).toBe(0);
        expect(unhandledRejections).toEqual([]);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        focusOwner.remove();
      }
    },
  );

  it.each(["stale-first", "current-first"] as const)(
    "binds an equal-looking same-open command/provider/prop replacement in $order order",
    async (order) => {
      const pending = deferred<Command[]>();
      const oldProvider = vi.fn(() => [command("old-result", "Old result")]);
      const currentProvider = vi.fn(() => pending.promise);
      const oldOpenChange = vi.fn();
      const currentOpenChange = vi.fn();
      const oldCommands = () => [childCommand("shared", "Shared child…", oldProvider)];
      const currentCommands = () => [childCommand("shared", "Shared child…", currentProvider)];
      const rendered = render(
        <CommandPalette open onOpenChange={oldOpenChange} commands={oldCommands} groupOrder={["Old"]} placeholder="Old placeholder" />,
      );
      const staleClick = reactProps<RowHandlerProps>(await screen.findByTestId("palette-item-shared")).onClick;

      rendered.rerender(
        <CommandPalette
          open
          onOpenChange={currentOpenChange}
          commands={currentCommands}
          groupOrder={["Current"]}
          placeholder="Current placeholder"
        />,
      );
      const input = screen.getByTestId("palette-input");
      const currentRow = await screen.findByTestId("palette-item-shared");
      const currentClick = reactProps<RowHandlerProps>(currentRow).onClick;
      const staleEvent = exactEvent(currentRow);
      const currentEvent = exactEvent(currentRow);

      await act(async () => {
        const stale = () => staleClick(staleEvent as unknown as React.MouseEvent<HTMLDivElement>);
        const current = () => currentClick(currentEvent as unknown as React.MouseEvent<HTMLDivElement>);
        if (order === "stale-first") {
          stale();
          current();
        } else {
          current();
          stale();
        }
        await Promise.resolve();
      });

      expect(input).toHaveAttribute("placeholder", "Current placeholder");
      expect(staleEvent.preventDefault).not.toHaveBeenCalled();
      expect(oldProvider).not.toHaveBeenCalled();
      expect(currentProvider).toHaveBeenCalledOnce();
      expect(oldOpenChange).not.toHaveBeenCalled();
      expect(currentOpenChange).not.toHaveBeenCalled();

      await settle(pending, "resolve", [command("current-result", "Current result")]);
      expect(screen.getByTestId("palette-item-current-result")).toBeInTheDocument();
      expect(input).toHaveFocus();
    },
  );

  it("withholds a same-mount command replacement until its exact state commits past the parent layout boundary", async () => {
    const pending = deferred<Command[]>();
    const oldProvider = vi.fn(() => [command("old-result", "Old result")]);
    const currentProvider = vi.fn(() => pending.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let boundaryAttempts = 0;

    try {
      await act(async () => {
        root.render(<SameMountBoundary items={[childCommand("shared", "Shared…", oldProvider)]} revision={0} />);
      });
      expect(screen.getByTestId("palette-item-shared")).toBeInTheDocument();

      await act(async () => {
        root.render(
          <SameMountBoundary
            items={[childCommand("shared", "Shared…", currentProvider)]}
            revision={1}
            onBoundary={() => {
              const row = screen.getByTestId("palette-item-shared");
              const click = reactProps<RowHandlerProps>(row).onClick;
              click(exactEvent(row) as unknown as React.MouseEvent<HTMLDivElement>);
              boundaryAttempts++;
            }}
          />,
        );
      });
      expect(boundaryAttempts).toBe(1);
      expect(oldProvider).not.toHaveBeenCalled();
      expect(currentProvider).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("palette-item-shared"));
      await act(async () => {});
      expect(currentProvider).toHaveBeenCalledOnce();
      await settle(pending, "resolve", [command("current-result", "Current result")]);
      expect(screen.getByTestId("palette-item-current-result")).toBeInTheDocument();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("binds Escape and outside dismissal to each exact visit and restores its opener", async () => {
    render(<Harness items={[command("leaf", "Leaf")]} initiallyOpen={false} />);
    const opener = screen.getByRole("button", { name: "Open palette" });
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);

    try {
      opener.focus();
      fireEvent.click(opener);
      await screen.findByTestId("palette-input");
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
      await waitFor(() => expect(opener).toHaveFocus());

      fireEvent.click(opener);
      await screen.findByTestId("palette-input");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
      fireEvent.click(outside);
      await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
      await waitFor(() => expect(opener).toHaveFocus());
    } finally {
      outside.remove();
    }
  });

  it("rejects wrong, foreign, and detached row currentTargets without claiming the current row", async () => {
    const pending = deferred<Command[]>();
    const children = vi.fn(() => pending.promise);
    render(<Harness items={[childCommand("first", "First…", children), command("second", "Second")]} />);
    const first = await screen.findByTestId("palette-item-first");
    const second = screen.getByTestId("palette-item-second");
    const clickFirst = reactProps<RowHandlerProps>(first).onClick;
    const foreign = document.createElement("div");
    const detached = document.createElement("div");
    document.body.append(foreign);

    try {
      await act(async () => {
        clickFirst(exactEvent(second) as unknown as React.MouseEvent<HTMLDivElement>);
        clickFirst(exactEvent(foreign) as unknown as React.MouseEvent<HTMLDivElement>);
        clickFirst(exactEvent(detached) as unknown as React.MouseEvent<HTMLDivElement>);
        await Promise.resolve();
      });
      expect(children).not.toHaveBeenCalled();
      expect(screen.queryByRole("status")).toBeNull();

      await act(async () => {
        clickFirst(exactEvent(first) as unknown as React.MouseEvent<HTMLDivElement>);
        await Promise.resolve();
      });
      expect(children).toHaveBeenCalledOnce();
      expect(screen.getByRole("status")).toHaveTextContent("Loading…");
      await settle(pending, "resolve", [command("result", "Result")]);
      expect(screen.getByTestId("palette-item-result")).toBeInTheDocument();
    } finally {
      foreign.remove();
    }
  });

  it("keeps Back and row publications disjoint and leaves the current Back usable", async () => {
    const run = vi.fn();
    render(<Harness items={[childCommand("parent", "Parent…", () => [command("leaf", "Leaf", run)])]} />);
    fireEvent.click(await screen.findByTestId("palette-item-parent"));
    const leaf = await screen.findByTestId("palette-item-leaf");
    const back = screen.getByRole("button", { name: "Back" });
    const leafClick = reactProps<RowHandlerProps>(leaf).onClick;
    const backClick = reactProps<ButtonHandlerProps>(back).onClick;

    act(() => {
      leafClick(exactEvent(back) as unknown as React.MouseEvent<HTMLDivElement>);
      backClick(exactEvent(leaf) as unknown as React.MouseEvent<HTMLButtonElement>);
    });
    expect(screen.getByTestId("palette-item-leaf")).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();

    act(() => backClick(exactEvent(back) as unknown as React.MouseEvent<HTMLButtonElement>));
    expect(screen.getByTestId("palette-item-parent")).toBeInTheDocument();
    act(() => backClick(exactEvent(back) as unknown as React.MouseEvent<HTMLButtonElement>));
    expect(screen.getByTestId("palette-item-parent")).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps Retry and row publications disjoint and leaves the current Retry usable once", async () => {
    const retry = deferred<Command[]>();
    const children = vi.fn().mockRejectedValueOnce(new Error("Try again")).mockReturnValueOnce(retry.promise);
    render(<Harness items={[childCommand("parent", "Parent…", children), command("other", "Other")]} />);
    fireEvent.click(await screen.findByTestId("palette-item-parent"));
    const alert = await screen.findByRole("alert");
    const retryButton = within(alert).getByRole("button", { name: "Retry" });
    const other = screen.getByTestId("palette-item-other");
    const retryClick = reactProps<ButtonHandlerProps>(retryButton).onClick;
    const otherClick = reactProps<RowHandlerProps>(other).onClick;

    act(() => {
      retryClick(exactEvent(other) as unknown as React.MouseEvent<HTMLButtonElement>);
      otherClick(exactEvent(retryButton) as unknown as React.MouseEvent<HTMLDivElement>);
    });
    expect(children).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("Try again");

    await act(async () => {
      const retryEvent = exactEvent(retryButton);
      retryClick(retryEvent as unknown as React.MouseEvent<HTMLButtonElement>);
      retryClick(retryEvent as unknown as React.MouseEvent<HTMLButtonElement>);
      await Promise.resolve();
    });
    expect(children).toHaveBeenCalledTimes(2);
    await settle(retry, "resolve", [command("result", "Result")]);
    expect(screen.getByTestId("palette-item-result")).toBeInTheDocument();
  });

  it("retires query/input/row DOM publications and accepts only their replacements", async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      render(<Harness items={[command("leaf", "Leaf", run)]} />);
      await act(async () => {});
      const input = screen.getByTestId("palette-input");
      const oldRow = screen.getByTestId("palette-item-leaf");
      const oldRowClick = reactProps<RowHandlerProps>(oldRow).onClick;
      const oldInputChange = reactProps<InputHandlerProps>(input).onChange;

      fireEvent.change(input, { target: { value: "missing" } });
      expect(screen.getByTestId("palette-empty")).toBeInTheDocument();
      act(() => oldInputChange(exactEvent(input) as unknown as React.ChangeEvent<HTMLInputElement>));
      expect(screen.getByTestId("palette-empty")).toBeInTheDocument();

      fireEvent.change(input, { target: { value: "" } });
      const replacement = screen.getByTestId("palette-item-leaf");
      act(() => {
        oldRowClick(exactEvent(oldRow) as unknown as React.MouseEvent<HTMLDivElement>);
        oldRowClick(exactEvent(replacement) as unknown as React.MouseEvent<HTMLDivElement>);
      });
      expect(run).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();

      fireEvent.click(replacement);
      await act(async () => vi.runAllTimersAsync());
      expect(setItem).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledOnce();
    } finally {
      setItem.mockRestore();
    }
  });

  it("consumes each exact keyboard event once and freezes every navigation destination", async () => {
    vi.useFakeTimers();
    const firstRun = vi.fn();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      render(
        <Harness
          initiallyOpen={false}
          items={[command("first", "First", firstRun), command("second", "Second"), command("third", "Third")]}
        />,
      );
      const opener = screen.getByRole("button", { name: "Open palette" });
      opener.focus();
      fireEvent.click(opener);
      await act(async () => {});
      const input = screen.getByTestId("palette-input");
      const endHandler = reactProps<InputHandlerProps>(input).onKeyDown;
      const endEvent = exactEvent(input, { key: "End" });

      act(() => {
        endHandler(endEvent as unknown as React.KeyboardEvent<HTMLInputElement>);
        endHandler(endEvent as unknown as React.KeyboardEvent<HTMLInputElement>);
      });
      expect(endEvent.preventDefault).toHaveBeenCalledOnce();
      expect(input).toHaveAttribute("aria-activedescendant", "palette-item-third");
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

      fireEvent.keyDown(input, { key: "Home" });
      expect(input).toHaveAttribute("aria-activedescendant", "palette-item-first");
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input).toHaveAttribute("aria-activedescendant", "palette-item-third");
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(input).toHaveAttribute("aria-activedescendant", "palette-item-first");

      const enterHandler = reactProps<InputHandlerProps>(input).onKeyDown;
      const enterEvent = exactEvent(input, { key: "Enter" });
      act(() => {
        enterHandler(enterEvent as unknown as React.KeyboardEvent<HTMLInputElement>);
        enterHandler(enterEvent as unknown as React.KeyboardEvent<HTMLInputElement>);
      });
      await act(async () => vi.runAllTimersAsync());
      expect(enterEvent.preventDefault).toHaveBeenCalledOnce();
      expect(setItem).toHaveBeenCalledOnce();
      expect(firstRun).toHaveBeenCalledOnce();
      expect(opener).toHaveFocus();
    } finally {
      setItem.mockRestore();
    }
  });
});
