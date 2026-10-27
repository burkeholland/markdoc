// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const closed = vi.hoisted(() => new Map<string, () => void>());

vi.mock("@/components/ui/primitives", async () => {
  const React = await import("react");
  return {
    Dialog({ open, children }: { open: boolean; children: ReactNode }) {
      return open ? React.createElement(React.Fragment, null, children) : null;
    },
    DialogContent({ title, children, onClosed }: { title: string; children: ReactNode; onClosed?: () => void }) {
      if (onClosed) closed.set(title, onClosed);
      return React.createElement("div", { role: "dialog", "aria-label": title }, children);
    },
    Kbd({ children }: { children: ReactNode }) {
      return React.createElement("kbd", null, children);
    },
  };
});

import { ImageDialog, LinkDialog, NameVersionDialog, ShortcutsDialog, TableDialog, type NameVersionVisit } from "./dialogs";

afterEach(() => {
  cleanup();
  closed.clear();
});

const finishClose = (title: string) => act(() => closed.get(title)?.());

describe("LinkDialog real input", () => {
  it("submits a normalized URL and trimmed text after the dialog closes", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn();
    render(<LinkDialog open onOpenChange={onOpenChange} initial={null} onSubmit={onSubmit} />);
    expect(screen.getByTestId("link-submit")).toBeDisabled();
    await user.type(screen.getByTestId("link-url"), "example.com/a");
    await user.type(screen.getByTestId("link-text"), "  hi  ");
    await user.click(screen.getByTestId("link-submit"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSubmit).not.toHaveBeenCalled();
    finishClose("Insert link");
    expect(onSubmit).toHaveBeenCalledWith("https://example.com/a", "hi");
    finishClose("Insert link");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("submits with Enter and handles Remove and Cancel clicks", async () => {
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn();
    const onRemove = vi.fn();
    const { rerender } = render(
      <LinkDialog open onOpenChange={onOpenChange} initial={{ href: "/a", text: "A" }} onSubmit={onSubmit} onRemove={onRemove} />,
    );
    expect(screen.getByRole("dialog", { name: "Edit link" })).toBeTruthy();
    fireEvent.submit(screen.getByTestId("link-url").closest("form")!);
    finishClose("Edit link");
    expect(onSubmit).toHaveBeenCalledWith("/a", "A");
    rerender(<LinkDialog open onOpenChange={onOpenChange} initial={{ href: "/b", text: "B" }} onSubmit={onSubmit} onRemove={onRemove} />);
    expect(screen.getByTestId("link-url")).toHaveProperty("value", "/b");
    fireEvent.click(screen.getByRole("button", { name: "Remove link" }));
    finishClose("Edit link");
    expect(onRemove).toHaveBeenCalledTimes(1);
    onOpenChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("ImageDialog real input", () => {
  it("uploads a chosen file, fills URL and alt, and inserts after close", async () => {
    const user = userEvent.setup();
    let resolve!: (value: { url: string }) => void;
    const onUpload = vi.fn(() => new Promise<{ url: string }>((r) => { resolve = r; }));
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    render(<ImageDialog open onOpenChange={onOpenChange} onSubmit={onSubmit} onUpload={onUpload} />);
    const file = new File(["x"], "cat.png", { type: "image/png" });
    await user.upload(screen.getByTestId("image-file") as HTMLInputElement, file);
    expect(onUpload).toHaveBeenCalledWith(file);
    expect(screen.getByTestId("image-upload").textContent).toBe("Uploading…");
    expect(screen.getByTestId("image-submit")).toBeDisabled();
    await act(async () => resolve({ url: "https://x/cat.png" }));
    expect(screen.getByTestId("image-url")).toHaveProperty("value", "https://x/cat.png");
    expect(screen.getByTestId("image-alt")).toHaveProperty("value", "cat");
    await user.click(screen.getByTestId("image-submit"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    finishClose("Insert image");
    expect(onSubmit).toHaveBeenCalledWith("https://x/cat.png", "cat");
  });

  it("shows upload errors and drops a late result after closing", async () => {
    const user = userEvent.setup();
    let reject!: (e: unknown) => void;
    let resolve!: (value: { url: string }) => void;
    const onUpload = vi
      .fn<(file: File) => Promise<{ url: string }>>()
      .mockImplementationOnce(() => new Promise((_, no) => { reject = no; }))
      .mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    const props = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onUpload };
    const { rerender } = render(<ImageDialog open {...props} />);
    await user.upload(screen.getByTestId("image-file") as HTMLInputElement, new File(["x"], "a.png", { type: "image/png" }));
    await act(async () => reject(new Error("boom")));
    expect(screen.getByTestId("image-upload-error")).toBeTruthy();
    await user.upload(screen.getByTestId("image-file") as HTMLInputElement, new File(["x"], "b.png", { type: "image/png" }));
    rerender(<ImageDialog open={false} {...props} />);
    rerender(<ImageDialog open {...props} />);
    await act(async () => resolve({ url: "https://late" }));
    expect(screen.getByTestId("image-url")).toHaveProperty("value", "");
  });

  it("opens the file picker from the Upload button", async () => {
    const user = userEvent.setup();
    render(<ImageDialog open onOpenChange={vi.fn()} onSubmit={vi.fn()} onUpload={vi.fn()} />);
    const click = vi.spyOn(screen.getByTestId("image-file") as HTMLInputElement, "click");
    await user.click(screen.getByTestId("image-upload"));
    expect(click).toHaveBeenCalled();
  });
});

describe("TableDialog real input", () => {
  it("moves with arrow keys, Home/End and Ctrl+End, and inserts on click", async () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    render(<TableDialog open onOpenChange={onOpenChange} onSubmit={onSubmit} />);
    const cell = (r: number, c: number) => screen.getByRole("button", { name: `${r} by ${c}` });
    cell(1, 1).focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(cell(1, 2));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(cell(2, 2));
    expect(screen.getByTestId("table-grid-label").textContent).toBe("2 rows × 2 columns");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(cell(2, 8));
    fireEvent.keyDown(document.activeElement!, { key: "End", ctrlKey: true });
    expect(document.activeElement).toBe(cell(6, 8));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(cell(6, 1));
    expect(cell(6, 1).tabIndex).toBe(0);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight", shiftKey: true });
    expect(document.activeElement).toBe(cell(6, 1));
    fireEvent.mouseEnter(cell(3, 4));
    expect(screen.getByTestId("table-grid-label").textContent).toBe("3 rows × 4 columns");
    fireEvent.click(cell(3, 4));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    finishClose("Insert table");
    expect(onSubmit).toHaveBeenCalledWith(3, 4);
  });
});

describe("NameVersionDialog real input", () => {
  const visit: NameVersionVisit = { id: 1, editor: {}, documentId: "d" };

  it("saves once, closes on success, and moves between actions with arrows", async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const onSubmit = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const onOpenChange = vi.fn();
    render(<NameVersionDialog open visit={visit} onOpenChange={onOpenChange} nextOperationId={() => 7} onSubmit={onSubmit} />);
    await user.type(screen.getByTestId("version-name"), " Draft ");
    const save = screen.getByTestId("version-name-submit");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "ArrowRight" });
    expect(document.activeElement).toBe(save);
    fireEvent.keyDown(save, { key: "Home" });
    expect(document.activeElement).toBe(cancel);
    const form = save.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ title: "Draft", operationId: 7, visit }));
    await act(async () => resolve());
    expect(onOpenChange).toHaveBeenCalledWith(visit, false);
  });

  it("shows save errors", async () => {
    const user = userEvent.setup();
    render(
      <NameVersionDialog open visit={visit} onOpenChange={vi.fn()} nextOperationId={() => 1} onSubmit={() => Promise.reject(new Error("nope"))} />,
    );
    await user.type(screen.getByTestId("version-name"), "x{Enter}");
    expect(await screen.findByTestId("version-name-error")).toBeTruthy();
  });
});

describe("ShortcutsDialog", () => {
  it("renders shortcut groups", () => {
    render(<ShortcutsDialog open onOpenChange={vi.fn()} />);
    expect(screen.getByText("Formatting")).toBeTruthy();
  });
});
