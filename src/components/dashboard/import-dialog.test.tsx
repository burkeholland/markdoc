// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const uploadImportBatch = vi.fn();
vi.mock("@/lib/import-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/import-upload")>()),
  uploadImportBatch: (...args: unknown[]) => uploadImportBatch(...args),
}));

import { ApiError } from "@/lib/api";
import { ImportDialog, useFileImport } from "./import-dialog";

/** The dashboard's wiring in miniature: the hook drives the dialog; the button stands in for a drop or a pick. */
function Harness({ onError }: { onError: (message: string) => void }) {
  const { items, ignored, open, setOpen, start } = useFileImport({ onError });
  return (
    <>
      <button type="button" onClick={() => void start([new File(["# Notes"], "notes.md", { type: "text/markdown" })])}>
        Import a file
      </button>
      <ImportDialog open={open} onOpenChange={setOpen} items={items} ignored={ignored} />
    </>
  );
}

beforeEach(() => {
  uploadImportBatch.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useFileImport · the request is rejected", () => {
  it("shows the server's validation reason, not the bare 'Invalid request', on the file row and in the toast", async () => {
    uploadImportBatch.mockRejectedValueOnce(new ApiError(400, "Invalid request", [{ path: ["files"], message: "Import at most 20 files at a time" }]));
    const onError = vi.fn();
    render(<Harness onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "Import a file" }));

    const item = await screen.findByTestId("import-item");
    expect(await screen.findByText("Import at most 20 files at a time")).toBeInTheDocument();
    expect(item).toHaveAttribute("data-status", "error");
    expect(screen.queryByText("Invalid request")).toBeNull();
    expect(onError).toHaveBeenCalledWith("Import at most 20 files at a time");
  });
});
