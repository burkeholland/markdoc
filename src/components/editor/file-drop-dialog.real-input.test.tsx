// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const uploadImportFiles = vi.fn();
vi.mock("@/lib/import-upload", () => ({ uploadImportFiles: (...args: unknown[]) => uploadImportFiles(...args) }));

import { FileDropDialog } from "./file-drop-dialog";

function setup(canEdit = true) {
  const props = { onClose: vi.fn(), onReplace: vi.fn(), onInsert: vi.fn(), onError: vi.fn() };
  const pending = { file: new File(["# Hi\r\nthere"], "hi.md", { type: "text/markdown" }), at: 7 };
  render(<FileDropDialog pending={pending} canEdit={canEdit} {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Synthetic events (isTrusted === false) must be honored like real input: issue #2222.
describe("FileDropDialog honors ordinary input events", () => {
  it("replaces from a fireEvent click", async () => {
    const props = setup();
    fireEvent.click(screen.getByTestId("file-drop-replace"));
    await waitFor(() => expect(props.onReplace).toHaveBeenCalledWith("# Hi\nthere"));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("inserts at the drop offset from a userEvent click", async () => {
    const props = setup();
    await userEvent.click(screen.getByTestId("file-drop-insert"));
    await waitFor(() => expect(props.onInsert).toHaveBeenCalledWith("# Hi\nthere", 7));
  });

  it("opens as a new document once for a double click when it cannot edit", async () => {
    uploadImportFiles.mockResolvedValue([{ id: "d1" }]);
    const props = setup(false);
    expect(screen.getByTestId("file-drop-replace")).toBeDisabled();
    const open = screen.getByTestId("file-drop-new");
    fireEvent.click(open);
    fireEvent.click(open);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/d/d1"));
    expect(uploadImportFiles).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("moves focus between enabled choices with arrow keys, Home and End", () => {
    setup();
    const [replace, insert, open] = ["replace", "insert", "new"].map((a) => screen.getByTestId(`file-drop-${a}`));
    replace.focus();
    fireEvent.keyDown(replace, { key: "ArrowDown" });
    expect(insert).toHaveFocus();
    fireEvent.keyDown(insert, { key: "End" });
    expect(open).toHaveFocus();
    fireEvent.keyDown(open, { key: "ArrowDown" });
    expect(open).toHaveFocus();
    fireEvent.keyDown(open, { key: "Home" });
    expect(replace).toHaveFocus();
  });

  it("closes on Escape and on the Close button, but not while work is pending", async () => {
    const props = setup();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();
    cleanup();

    uploadImportFiles.mockReturnValue(new Promise(() => {}));
    const busy = setup();
    fireEvent.click(screen.getByTestId("file-drop-new"));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(busy.onClose).not.toHaveBeenCalled();
  });
});
