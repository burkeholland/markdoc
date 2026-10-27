// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportDialog, type ImportItem } from "./import-dialog";

afterEach(cleanup);

function items(retry: () => void, retryAll: () => void): ImportItem[] {
  return [
    { name: "a.md", status: "done", id: "a", warnings: [] },
    { name: "b.md", status: "error", error: "nope", warnings: [], retry, retryAll },
    { name: "c.md", status: "done", id: "c", warnings: [] },
  ];
}

describe("ImportDialog honors real input", () => {
  it("closes on a synthetic click on Open", () => {
    const onOpenChange = vi.fn();
    render(<ImportDialog open onOpenChange={onOpenChange} items={items(vi.fn(), vi.fn())} ignored={[]} />);
    fireEvent.click(screen.getAllByTestId("import-open")[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("runs row Retry and Retry failed on userEvent clicks", async () => {
    const retry = vi.fn();
    const retryAll = vi.fn();
    render(<ImportDialog open onOpenChange={vi.fn()} items={items(retry, retryAll)} ignored={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry b.md" }));
    expect(retry).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Retry failed" }));
    expect(retryAll).toHaveBeenCalledOnce();
  });

  it("moves focus between actions with ArrowDown/ArrowUp/Home/End without wrapping", () => {
    render(<ImportDialog open onOpenChange={vi.fn()} items={items(vi.fn(), vi.fn())} ignored={[]} />);
    const [openA, openC] = screen.getAllByTestId("import-open");
    const rowRetry = screen.getByTestId("import-row-retry");
    const retryAll = screen.getByTestId("import-retry");
    openA.focus();
    expect(fireEvent.keyDown(openA, { key: "ArrowDown" })).toBe(false);
    expect(document.activeElement).toBe(rowRetry);
    fireEvent.keyDown(rowRetry, { key: "ArrowDown" });
    expect(document.activeElement).toBe(openC);
    fireEvent.keyDown(openC, { key: "End" });
    expect(document.activeElement).toBe(retryAll);
    expect(fireEvent.keyDown(retryAll, { key: "ArrowDown" })).toBe(true);
    expect(document.activeElement).toBe(retryAll);
    fireEvent.keyDown(retryAll, { key: "Home" });
    expect(document.activeElement).toBe(openA);
    fireEvent.keyDown(openA, { key: "ArrowUp" });
    expect(document.activeElement).toBe(openA);
    expect(fireEvent.keyDown(openA, { key: "ArrowDown", shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(openA);
  });

  it("skips disabled Retry controls while a batch is busy", () => {
    const list: ImportItem[] = [
      ...items(vi.fn(), vi.fn()),
      { name: "d.md", status: "uploading", warnings: [] },
    ];
    render(<ImportDialog open onOpenChange={vi.fn()} items={list} ignored={[]} />);
    const [openA, openC] = screen.getAllByTestId("import-open");
    expect(screen.getByTestId("import-row-retry")).toBeDisabled();
    openA.focus();
    fireEvent.keyDown(openA, { key: "ArrowDown" });
    expect(document.activeElement).toBe(openC);
  });
});
