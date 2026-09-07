// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FailedImport, ImportedDocument, ImportBatch } from "@/lib/import-upload";

const uploadImportBatch = vi.fn();
vi.mock("@/lib/import-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/import-upload")>()),
  uploadImportBatch: (...args: unknown[]) => uploadImportBatch(...args),
}));

import { ApiError } from "@/lib/api";
import { ImportDialog, useFileImport } from "./import-dialog";

/** The dashboard's wiring in miniature: the hook drives the dialog; the button stands in for a drop or a pick. */
function Harness({
  batches,
  onError,
  onDone,
}: {
  batches: File[][];
  onError: (message: string) => void;
  onDone?: (documents: ImportedDocument[], failed: FailedImport[]) => void;
}) {
  const { items, ignored, open, setOpen, start, input } = useFileImport({ onError, onDone });
  return (
    <>
      {input}
      {batches.map((batch, index) => (
        <button key={index} type="button" onClick={() => void start(batch)}>
          Import batch {index + 1}
        </button>
      ))}
      <ImportDialog open={open} onOpenChange={setOpen} items={items} ignored={ignored} />
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    const file = new File(["# Notes"], "notes.md", { type: "text/markdown" });
    render(<Harness batches={[[file]]} onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));

    const item = await screen.findByTestId("import-item");
    expect(await screen.findByText("Import at most 20 files at a time")).toBeInTheDocument();
    expect(item).toHaveAttribute("data-status", "error");
    expect(screen.queryByText("Invalid request")).toBeNull();
    expect(onError).toHaveBeenCalledWith("Import at most 20 files at a time");
  });
});

describe("useFileImport · retrying failed files", () => {
  it("retries only failures with their image companions, locks while pending, and keeps the latest result in place", async () => {
    const first = new File(["# First"], "first.md", { type: "text/markdown" });
    const second = new File(["# Second"], "second.md", { type: "text/markdown" });
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    const ignored = new File(["archive"], "notes.pdf", { type: "application/pdf" });
    const retryFailure = deferred<ImportBatch>();
    const onDone = vi.fn();
    uploadImportBatch
      .mockResolvedValueOnce({
        documents: [{ id: "doc-first", title: "First", warnings: ["First warning"] }],
        failed: [{ index: 1, name: second.name, error: "First failure reason" }],
      })
      .mockReturnValueOnce(retryFailure.promise)
      .mockResolvedValueOnce({
        documents: [{ id: "doc-second", title: "Second", warnings: [] }],
        failed: [],
      });

    render(<Harness batches={[[first, second, image, ignored]]} onError={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));

    expect(await screen.findByText("First failure reason")).toBeInTheDocument();
    expect(screen.getByTestId("import-ignored")).toHaveTextContent("notes.pdf");
    const initialRows = screen.getAllByTestId("import-item");
    expect(initialRows.map((row) => row.querySelector("[title]")?.textContent)).toEqual(["First", "second.md"]);
    expect(initialRows[0]).toHaveAttribute("data-status", "done");
    expect(initialRows[1]).toHaveAttribute("data-status", "error");
    expect(within(initialRows[0]).getByTestId("import-open")).toHaveAttribute("href", "/d/doc-first");

    const retry = screen.getByRole("button", { name: "Retry failed" });
    fireEvent.click(retry);

    await waitFor(() => expect(retry).toBeDisabled());
    expect(screen.getAllByTestId("import-item")[0]).toHaveAttribute("data-status", "done");
    expect(screen.getAllByTestId("import-item")[1]).toHaveAttribute("data-status", "uploading");
    fireEvent.click(retry);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("import-dialog")).toBeInTheDocument();
    expect(uploadImportBatch).toHaveBeenCalledTimes(2);
    expect(uploadImportBatch).toHaveBeenNthCalledWith(1, [first, second], [image]);
    expect(uploadImportBatch).toHaveBeenNthCalledWith(2, [second], [image]);

    await act(async () => {
      retryFailure.resolve({
        documents: [],
        failed: [{ index: 0, name: second.name, error: "Second failure reason" }],
      });
    });
    expect(await screen.findByText("Second failure reason")).toBeInTheDocument();
    expect(screen.queryByText("First failure reason")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry failed" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));
    await waitFor(() => expect(screen.getAllByTestId("import-open")).toHaveLength(2));
    const links = screen.getAllByTestId("import-open");
    expect(uploadImportBatch).toHaveBeenCalledTimes(3);
    expect(uploadImportBatch).toHaveBeenNthCalledWith(3, [second], [image]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/d/doc-first", "/d/doc-second"]);
    expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull();
    expect(onDone).toHaveBeenLastCalledWith(
      [
        { id: "doc-first", title: "First", warnings: ["First warning"] },
        { id: "doc-second", title: "Second", warnings: [] },
      ],
      [],
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("import-dialog")).toBeNull());
  });

  it("replaces retry ownership when a new batch starts", async () => {
    const oldDocument = new File(["# Old"], "old.md", { type: "text/markdown" });
    const oldImage = new File(["old"], "old.png", { type: "image/png" });
    const newDocument = new File(["# New"], "new.md", { type: "text/markdown" });
    const newImage = new File(["new"], "new.png", { type: "image/png" });
    uploadImportBatch
      .mockResolvedValueOnce({
        documents: [],
        failed: [{ index: 0, name: oldDocument.name, error: "Old failure" }],
      })
      .mockResolvedValueOnce({
        documents: [],
        failed: [{ index: 0, name: newDocument.name, error: "New failure" }],
      })
      .mockResolvedValueOnce({
        documents: [{ id: "doc-new", title: "New", warnings: [] }],
        failed: [],
      });

    render(<Harness batches={[[oldDocument, oldImage], [newDocument, newImage]]} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
    expect(await screen.findByText("Old failure")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("import-file-input"), { target: { files: [newDocument, newImage] } });
    expect(await screen.findByText("New failure")).toBeInTheDocument();
    expect(screen.queryByText("Old failure")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));

    expect(await screen.findByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-new");
    expect(uploadImportBatch).toHaveBeenNthCalledWith(3, [newDocument], [newImage]);
    expect(uploadImportBatch.mock.calls.flatMap(([documents]) => documents as File[]).filter((file) => file === oldDocument)).toHaveLength(1);
  });
});
