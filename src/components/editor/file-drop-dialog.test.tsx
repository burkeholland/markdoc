// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const uploadImportFiles = vi.fn();
vi.mock("@/lib/import-upload", () => ({
  uploadImportFiles: (...args: unknown[]) => uploadImportFiles(...args),
}));

import { FileDropDialog, type FileDropDialogProps, type PendingFileDrop } from "./file-drop-dialog";

class ControlledFileReader {
  static reads: Array<{ file: Blob; reader: ControlledFileReader }> = [];

  result: string | null = null;
  error: Error | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsText(file: Blob) {
    ControlledFileReader.reads.push({ file, reader: this });
  }

  resolve(text: string) {
    this.result = text;
    this.onload?.();
  }

  reject(error: Error) {
    this.error = error;
    this.onerror?.();
  }
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

function dropped(name: string, at: number): PendingFileDrop {
  return { file: new File(["unused"], name, { type: "text/markdown" }), at };
}

function callbacks(): Pick<FileDropDialogProps, "onClose" | "onReplace" | "onInsert" | "onError"> {
  return {
    onClose: vi.fn(),
    onReplace: vi.fn(),
    onInsert: vi.fn(),
    onError: vi.fn(),
  };
}

function dialog(pending: PendingFileDrop | null, handlers: ReturnType<typeof callbacks>) {
  return <FileDropDialog pending={pending} canEdit onClose={handlers.onClose} onReplace={handlers.onReplace} onInsert={handlers.onInsert} onError={handlers.onError} />;
}

function activateBeforeCommit(...testIds: string[]) {
  act(() => {
    for (const testId of testIds) fireEvent.click(screen.getByTestId(testId));
  });
}

async function resolveRead(index: number, text: string) {
  await act(async () => ControlledFileReader.reads[index].reader.resolve(text));
}

async function rejectRead(index: number, error: Error) {
  await act(async () => ControlledFileReader.reads[index].reader.reject(error));
}

beforeEach(() => {
  ControlledFileReader.reads = [];
  vi.stubGlobal("FileReader", ControlledFileReader);
  push.mockReset();
  uploadImportFiles.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FileDropDialog action ownership", () => {
  it("reads and replaces once when Replace is activated twice before React commits", async () => {
    const pending = dropped("replace.md", 4);
    const handlers = callbacks();
    render(dialog(pending, handlers));

    activateBeforeCommit("file-drop-replace", "file-drop-replace");
    expect(ControlledFileReader.reads).toHaveLength(1);
    expect(ControlledFileReader.reads[0].file).toBe(pending.file);

    await resolveRead(0, "\uFEFF# One\r\nTwo\rThree");
    expect(handlers.onReplace).toHaveBeenCalledTimes(1);
    expect(handlers.onReplace).toHaveBeenCalledWith("# One\nTwo\nThree");
    expect(handlers.onInsert).not.toHaveBeenCalled();
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("reads and inserts once when Insert and another choice are activated before React commits", async () => {
    const pending = dropped("insert.md", 17);
    const handlers = callbacks();
    render(dialog(pending, handlers));

    activateBeforeCommit("file-drop-insert", "file-drop-insert", "file-drop-replace");
    expect(ControlledFileReader.reads).toHaveLength(1);

    await resolveRead(0, "Inserted\r\ntext");
    expect(handlers.onInsert).toHaveBeenCalledTimes(1);
    expect(handlers.onInsert).toHaveBeenCalledWith("Inserted\ntext", 17);
    expect(handlers.onReplace).not.toHaveBeenCalled();
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("imports, navigates and closes once when Open as new document is activated rapidly", async () => {
    const pending = dropped("new.md", 0);
    const handlers = callbacks();
    const upload = deferred<Array<{ id: string; title: string; warnings: string[] }>>();
    uploadImportFiles.mockReturnValue(upload.promise);
    render(dialog(pending, handlers));

    activateBeforeCommit("file-drop-new", "file-drop-new", "file-drop-insert");
    expect(uploadImportFiles).toHaveBeenCalledTimes(1);
    expect(uploadImportFiles).toHaveBeenCalledWith([pending.file]);

    await act(async () => upload.resolve([{ id: "doc-new", title: "New", warnings: [] }]));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/d/doc-new");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(ControlledFileReader.reads).toHaveLength(0);
  });

  it("blocks closing while current work is pending, reports one failure, and allows one successful retry", async () => {
    const pending = dropped("retry.md", 2);
    const handlers = callbacks();
    render(dialog(pending, handlers));

    activateBeforeCommit("file-drop-replace", "file-drop-replace");
    for (const action of ["replace", "insert", "new"]) expect(screen.getByTestId(`file-drop-${action}`)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(handlers.onClose).not.toHaveBeenCalled();

    await rejectRead(0, new Error("Could not read retry.md"));
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(handlers.onError).toHaveBeenCalledWith("Could not read retry.md");
    expect(screen.getByTestId("file-drop-dialog")).toBeInTheDocument();
    for (const action of ["replace", "insert", "new"]) expect(screen.getByTestId(`file-drop-${action}`)).toBeEnabled();

    activateBeforeCommit("file-drop-replace", "file-drop-replace");
    expect(ControlledFileReader.reads).toHaveLength(2);
    await resolveRead(1, "Recovered");
    expect(handlers.onReplace).toHaveBeenCalledTimes(1);
    expect(handlers.onReplace).toHaveBeenCalledWith("Recovered");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(handlers.onError).toHaveBeenCalledTimes(1);
  });

  it("keeps replacement file B owned when stale file A read success and finalizer arrive", async () => {
    const first = dropped("first.md", 3);
    const second = dropped("second.md", 29);
    const handlers = callbacks();
    const view = render(dialog(first, handlers));
    fireEvent.click(screen.getByTestId("file-drop-replace"));

    view.rerender(dialog(second, handlers));
    expect(screen.getByText(/second\.md/)).toBeInTheDocument();
    expect(screen.getByTestId("file-drop-insert")).toBeEnabled();
    fireEvent.click(screen.getByTestId("file-drop-insert"));
    expect(ControlledFileReader.reads).toHaveLength(2);

    await resolveRead(0, "Stale first");
    expect(handlers.onReplace).not.toHaveBeenCalled();
    expect(handlers.onInsert).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
    for (const action of ["replace", "insert", "new"]) expect(screen.getByTestId(`file-drop-${action}`)).toBeDisabled();
    fireEvent.click(screen.getByTestId("file-drop-replace"));
    expect(ControlledFileReader.reads).toHaveLength(2);

    await resolveRead(1, "Current second");
    expect(handlers.onInsert).toHaveBeenCalledTimes(1);
    expect(handlers.onInsert).toHaveBeenCalledWith("Current second", 29);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("does not report stale file A read errors or let their finalizer unlock file B", async () => {
    const first = dropped("first-error.md", 1);
    const second = dropped("second-after-error.md", 8);
    const handlers = callbacks();
    const view = render(dialog(first, handlers));
    fireEvent.click(screen.getByTestId("file-drop-replace"));

    view.rerender(dialog(second, handlers));
    fireEvent.click(screen.getByTestId("file-drop-insert"));
    await rejectRead(0, new Error("Stale read failed"));
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(screen.getByTestId("file-drop-insert")).toBeDisabled();
    fireEvent.click(screen.getByTestId("file-drop-new"));
    expect(uploadImportFiles).not.toHaveBeenCalled();

    await resolveRead(1, "Second survives");
    expect(handlers.onInsert).toHaveBeenCalledTimes(1);
    expect(handlers.onInsert).toHaveBeenCalledWith("Second survives", 8);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps replacement file B owned when stale file A import success and finalizer arrive", async () => {
    const first = dropped("first-import.md", 0);
    const second = dropped("second-import.md", 0);
    const firstUpload = deferred<Array<{ id: string; title: string; warnings: string[] }>>();
    const secondUpload = deferred<Array<{ id: string; title: string; warnings: string[] }>>();
    uploadImportFiles.mockReturnValueOnce(firstUpload.promise).mockReturnValueOnce(secondUpload.promise);
    const handlers = callbacks();
    const view = render(dialog(first, handlers));
    fireEvent.click(screen.getByTestId("file-drop-new"));

    view.rerender(dialog(second, handlers));
    fireEvent.click(screen.getByTestId("file-drop-new"));
    expect(uploadImportFiles).toHaveBeenCalledTimes(2);
    await act(async () => firstUpload.resolve([{ id: "doc-stale", title: "Stale", warnings: [] }]));
    expect(push).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("file-drop-new")).toBeDisabled();
    fireEvent.click(screen.getByTestId("file-drop-replace"));
    expect(ControlledFileReader.reads).toHaveLength(0);

    await act(async () => secondUpload.resolve([{ id: "doc-current", title: "Current", warnings: [] }]));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/d/doc-current");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("ignores an import error after its pending file is cleared", async () => {
    const pending = dropped("cleared-import.md", 0);
    const upload = deferred<Array<{ id: string; title: string; warnings: string[] }>>();
    uploadImportFiles.mockReturnValue(upload.promise);
    const handlers = callbacks();
    const view = render(dialog(pending, handlers));
    fireEvent.click(screen.getByTestId("file-drop-new"));

    view.rerender(dialog(null, handlers));
    await act(async () => upload.reject(new Error("Stale import failed")));
    expect(screen.queryByTestId("file-drop-dialog")).toBeNull();
    expect(push).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("invalidates deferred reads and imports on unmount", async () => {
    const readHandlers = callbacks();
    const readView = render(dialog(dropped("unmounted-read.md", 0), readHandlers));
    fireEvent.click(screen.getByTestId("file-drop-replace"));
    readView.unmount();
    await resolveRead(0, "Too late");
    expect(readHandlers.onReplace).not.toHaveBeenCalled();
    expect(readHandlers.onClose).not.toHaveBeenCalled();
    expect(readHandlers.onError).not.toHaveBeenCalled();

    const importHandlers = callbacks();
    const upload = deferred<Array<{ id: string; title: string; warnings: string[] }>>();
    uploadImportFiles.mockReturnValue(upload.promise);
    const importView = render(dialog(dropped("unmounted-import.md", 0), importHandlers));
    fireEvent.click(screen.getByTestId("file-drop-new"));
    importView.unmount();
    await act(async () => upload.reject(new Error("Too late")));
    expect(push).not.toHaveBeenCalled();
    expect(importHandlers.onClose).not.toHaveBeenCalled();
    expect(importHandlers.onError).not.toHaveBeenCalled();
  });
});
