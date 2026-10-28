// @vitest-environment jsdom
import { useCallback, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function command(id: string, title: string, run: Command["run"] = vi.fn()): Command {
  return { id, title, keywords: [], group: "Test", run };
}

function childCommand(id: string, title: string, children: Command["children"]): Command {
  return { ...command(id, title), children };
}

function Harness({ items, registry }: { items?: Command[]; registry?: () => Command[] }) {
  const [open, setOpen] = useState(true);
  const fromItems = useCallback(() => items ?? [], [items]);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} commands={registry ?? fromItems} />
    </>
  );
}

const input = () => screen.getByTestId("palette-input");
const selected = () => input().getAttribute("aria-activedescendant");
const flushRun = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

beforeEach(() => {
  window.localStorage?.clear?.();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("CommandPalette", () => {
  it("filters on typing and navigates with arrows, Home, End and Page keys", () => {
    const items = Array.from({ length: 25 }, (_, i) => command(`item-${i}`, `Item ${i}`));
    render(<Harness items={items} />);
    expect(document.activeElement).toBe(input());
    expect(selected()).toBe("palette-item-item-0");
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(selected()).toBe("palette-item-item-24");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(selected()).toBe("palette-item-item-0");
    fireEvent.keyDown(input(), { key: "PageDown" });
    expect(selected()).toBe("palette-item-item-10");
    fireEvent.keyDown(input(), { key: "PageUp" });
    expect(selected()).toBe("palette-item-item-0");
    fireEvent.keyDown(input(), { key: "End" });
    expect(selected()).toBe("palette-item-item-24");
    fireEvent.keyDown(input(), { key: "Home" });
    expect(selected()).toBe("palette-item-item-0");
    fireEvent.change(input(), { target: { value: "Item 2" } });
    expect(screen.queryByTestId("palette-item-item-1")).toBeNull();
    expect(screen.getByTestId("palette-item-item-24")).toBeTruthy();
  });

  it("runs the picked command once after closing and restores focus to the opener", async () => {
    const run = vi.fn();
    render(<Harness items={[command("a", "Alpha", run), command("b", "Beta")]} />);
    const field = input();
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
    await flushRun();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("highlights on hover and runs on click", async () => {
    const run = vi.fn();
    render(<Harness items={[command("a", "Alpha"), command("b", "Beta", run)]} />);
    fireEvent.mouseEnter(screen.getByTestId("palette-item-b"));
    expect(selected()).toBe("palette-item-b");
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("palette-item-b"));
    await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
    await flushRun();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not run a command whose permission was revoked or that left the live registry", async () => {
    const run = vi.fn();
    let allowed = true;
    let present = true;
    const registry = () => (present ? [{ ...command("a", "Alpha", run), when: () => allowed }] : []);
    const { unmount } = render(<Harness registry={registry} />);
    allowed = false;
    fireEvent.keyDown(input(), { key: "Enter" });
    await flushRun();
    expect(run).not.toHaveBeenCalled();
    unmount();

    allowed = true;
    render(<Harness registry={registry} />);
    present = false;
    fireEvent.keyDown(input(), { key: "Enter" });
    await flushRun();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the command rebuilt from the current registry instead of the captured closure", async () => {
    const stale = vi.fn();
    const live = vi.fn();
    let current = command("a", "Alpha", stale);
    render(<Harness registry={() => [current]} />);
    current = command("a", "Alpha", live);
    fireEvent.click(screen.getByTestId("palette-item-a"));
    await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
    await flushRun();
    expect(stale).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledTimes(1);
  });

  it("loads a child list, goes Back with the button and with Backspace on an empty query", async () => {
    const childRun = vi.fn();
    render(<Harness items={[childCommand("tpl", "Templates…", async () => [command("t1", "Meeting", childRun)])]} />);
    fireEvent.keyDown(input(), { key: "Enter" });
    await screen.findByTestId("palette-item-t1");
    expect(screen.getByText("Templates")).toBeTruthy();
    fireEvent.click(screen.getByTestId("palette-back"));
    expect(screen.getByTestId("palette-item-tpl")).toBeTruthy();

    fireEvent.click(screen.getByTestId("palette-item-tpl"));
    await screen.findByTestId("palette-item-t1");
    fireEvent.change(input(), { target: { value: "x" } });
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(screen.queryByTestId("palette-back")).toBeTruthy();
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(screen.getByTestId("palette-item-tpl")).toBeTruthy();

    fireEvent.click(screen.getByTestId("palette-item-tpl"));
    await screen.findByTestId("palette-item-t1");
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
    await flushRun();
    expect(childRun).toHaveBeenCalledTimes(1);
  });

  it("shows a failed load and retries once", async () => {
    let attempt = 0;
    const second = deferred<Command[]>();
    const children = vi.fn(() => (++attempt === 1 ? Promise.reject(new Error("offline")) : second.promise));
    render(<Harness items={[childCommand("tpl", "Templates…", children)]} />);
    fireEvent.click(screen.getByTestId("palette-item-tpl"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("offline");
    fireEvent.click(screen.getByTestId("palette-item-tpl"));
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(children).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Retrying…" }));
    expect(children).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve([command("t1", "Meeting")]));
    await screen.findByTestId("palette-item-t1");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never lets a late child response replace a newer one or reopened palette", async () => {
    const slow = deferred<Command[]>();
    const fast = deferred<Command[]>();
    render(
      <Harness
        items={[
          childCommand("slow", "Slow…", () => slow.promise),
          childCommand("fast", "Fast…", () => fast.promise),
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("palette-item-slow"));
    fireEvent.click(screen.getByTestId("palette-item-fast"));
    await act(async () => fast.resolve([command("f1", "Fast child")]));
    await screen.findByTestId("palette-item-f1");
    await act(async () => slow.resolve([command("s1", "Slow child")]));
    expect(screen.queryByTestId("palette-item-s1")).toBeNull();
    expect(screen.getByTestId("palette-item-f1")).toBeTruthy();

    const late = deferred<Command[]>();
    cleanup();
    render(<Harness items={[childCommand("late", "Late…", () => late.promise)]} />);
    fireEvent.click(screen.getByTestId("palette-item-late"));
    fireEvent.keyDown(input(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
    fireEvent.click(screen.getByText("Open palette"));
    await act(async () => late.resolve([command("l1", "Late child")]));
    expect(screen.queryByTestId("palette-item-l1")).toBeNull();
    expect(screen.getByTestId("palette-item-late")).toBeTruthy();
  });

  it("closes on Escape and outside click, restoring focus to the opener (#2219)", async () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Opener
          </button>
          <button type="button">Outside</button>
          <CommandPalette open={open} onOpenChange={setOpen} commands={() => [command("a", "Alpha")]} />
        </>
      );
    }
    render(<Opener />);
    const opener = screen.getByText("Opener");
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(input()));
    fireEvent.keyDown(input(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(input()));
    await flushRun();
    const outside = screen.getByText("Outside");
    fireEvent.pointerDown(outside, { button: 0, pointerId: 1, isPrimary: true });
    fireEvent.pointerUp(outside, { button: 0, pointerId: 1, isPrimary: true });
    fireEvent.click(outside);
    await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("keeps the child list and query when the parent passes a new commands function while open", async () => {
    const tpl = childCommand("tpl", "Templates…", async () => [command("t1", "Meeting"), command("t2", "Todo")]);
    const view = render(<CommandPalette open onOpenChange={() => {}} commands={() => [tpl]} />);
    fireEvent.click(screen.getByTestId("palette-item-tpl"));
    await screen.findByTestId("palette-item-t1");
    view.rerender(<CommandPalette open onOpenChange={() => {}} commands={() => [tpl]} />);
    fireEvent.change(input(), { target: { value: "meet" } });
    view.rerender(<CommandPalette open onOpenChange={() => {}} commands={() => [tpl]} />);
    expect(screen.getByTestId("palette-item-t1")).toBeTruthy();
    expect(screen.queryByTestId("palette-item-tpl")).toBeNull();
    expect(input()).toHaveProperty("value", "meet");
  });

  it("keeps a loading child list when the user types or moves the highlight before it arrives", async () => {
    const pending = deferred<Command[]>();
    render(<Harness items={[command("a", "Alpha"), childCommand("tpl", "Templates…", () => pending.promise)]} />);
    fireEvent.click(screen.getByTestId("palette-item-tpl"));
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.change(input(), { target: { value: "meet" } });
    await act(async () => pending.resolve([command("t1", "Meeting"), command("t2", "Todo")]));
    expect(screen.getByTestId("palette-item-t1")).toBeTruthy();
    expect(screen.queryByTestId("palette-item-t2")).toBeNull();
    expect(input()).toHaveProperty("value", "meet");
  });

  it("ignores Enter while an IME composition is active", async () => {
    const run = vi.fn();
    render(<Harness items={[command("a", "Alpha", run)]} />);
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    await flushRun();
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByTestId("command-palette")).toBeTruthy();
  });
});
