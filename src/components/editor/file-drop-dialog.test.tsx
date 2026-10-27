// @vitest-environment jsdom
import { type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn() } }));
const dialogOpenChanges = vi.hoisted(() => [] as Array<(open: boolean) => void>);
const push = navigation.router.push;
vi.mock("next/navigation", () => ({ useRouter: () => navigation.router }));

vi.mock("@/components/ui/primitives", async (original) => {
  const actual = await original<typeof import("@/components/ui/primitives")>();
  const React = await import("react");
  return {
    ...actual,
    Dialog: (props: Parameters<typeof actual.Dialog>[0]) => {
      if (props.onOpenChange) dialogOpenChanges.push(props.onOpenChange);
      return React.createElement(actual.Dialog, props);
    },
  };
});

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

interface ControlledPointerEventInit extends MouseEventInit {
  pointerId?: number;
  pointerType?: string;
  isPrimary?: boolean;
}

class ControlledPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;

  constructor(type: string, init: ControlledPointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
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

function propsFor(
  pending: PendingFileDrop | null,
  handlers: ReturnType<typeof callbacks>,
  canEdit = true,
): FileDropDialogProps {
  return { pending, canEdit, ...handlers };
}

function dialog(pending: PendingFileDrop | null, handlers: ReturnType<typeof callbacks>) {
  return <FileDropDialog {...propsFor(pending, handlers)} />;
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

interface DirectView {
  host: HTMLDivElement;
  root: Root;
}

const directViews: DirectView[] = [];
const mutationObservers: MutationObserver[] = [];

function expectNoFileDropAction(
  handlers: ReturnType<typeof callbacks>,
) {
  expect(ControlledFileReader.reads).toHaveLength(0);
  expect(uploadImportFiles).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  expect(handlers.onReplace).not.toHaveBeenCalled();
  expect(handlers.onInsert).not.toHaveBeenCalled();
  expect(handlers.onClose).not.toHaveBeenCalled();
  expect(handlers.onError).not.toHaveBeenCalled();
}

function resetMock(mock: Mock) {
  mock.mockReset();
}

beforeEach(() => {
  ControlledFileReader.reads = [];
  vi.stubGlobal("FileReader", ControlledFileReader);
  vi.stubGlobal("PointerEvent", ControlledPointerEvent);
  navigation.router = { push };
  resetMock(push);
  dialogOpenChanges.length = 0;
  uploadImportFiles.mockReset();
});

afterEach(() => {
  cleanup();
  for (const view of directViews.splice(0)) {
    act(() => view.root.unmount());
    view.host.remove();
  }
  for (const observer of mutationObservers.splice(0)) observer.disconnect();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FileDropDialog metadata", () => {
  it.each([
    [0, "0 bytes"],
    [1, "1 byte"],
    [1023, "1023 bytes"],
    [1024, "1 KiB"],
    [1025, "1 KiB"],
    [1126, "1.1 KiB"],
    [1536, "1.5 KiB"],
    [1048576, "1 MiB"],
  ] as const)("describes %i bytes as %s without starting an action", (bytes, size) => {
    const pending = {
      file: new File([new Uint8Array(bytes)], "metadata.md"),
      at: 0,
    };
    const handlers = callbacks();
    render(dialog(pending, handlers));

    const content = screen.getByRole("dialog", { name: "Dropped file" });
    const description = screen.getByText(
      `What should happen with “metadata.md” (${size})?`,
    );
    expect(content).toHaveAccessibleDescription(description.textContent);
    expect(content).toHaveAttribute("aria-describedby", description.id);
    expect(content.querySelectorAll("p")).toHaveLength(1);
    expect(description).toBeVisible();
    expect(description).not.toHaveAttribute("tabindex");
    expect(content.querySelector("[aria-live]")).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    expectNoFileDropAction(handlers);
  });

  it.each([
    [1024 ** 3, "1 GiB"],
    [1.5 * 1024 ** 3, "1.5 GiB"],
  ] as const)("formats %i bytes of File.size metadata as %s", (bytes, size) => {
    const pending = dropped("large.md", 0);
    vi.spyOn(pending.file, "size", "get").mockReturnValue(bytes);
    const handlers = callbacks();
    render(dialog(pending, handlers));

    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      `What should happen with “large.md” (${size})?`,
    );
    expectNoFileDropAction(handlers);
  });

  it("renders special-character filenames as literal text without extra HTML", () => {
    const name = '<img src=x onerror="alert(1)"> & <b>notes</b>.md';
    const pending = { file: new File(["x"], name), at: 0 };
    const handlers = callbacks();
    render(dialog(pending, handlers));

    const content = screen.getByRole("dialog");
    const expected = `What should happen with “${name}” (1 byte)?`;
    const description = screen.getByText(expected);
    expect(content).toHaveAccessibleDescription(expected);
    expect(description.textContent).toBe(expected);
    expect(description.children).toHaveLength(0);
    expect(content.querySelector("img, b, script")).toBeNull();
    expectNoFileDropAction(handlers);
  });

  it("replaces the pending name and size, including a new file with the same name", () => {
    const handlers = callbacks();
    const view = render(
      dialog({ file: new File([], "first.md"), at: 0 }, handlers),
    );
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "What should happen with “first.md” (0 bytes)?",
    );

    view.rerender(
      dialog({ file: new File([new Uint8Array(1536)], "second.md"), at: 0 }, handlers),
    );
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "What should happen with “second.md” (1.5 KiB)?",
    );
    expect(screen.queryByText(/first\.md/)).toBeNull();

    view.rerender(
      dialog({ file: new File(["x"], "second.md"), at: 0 }, handlers),
    );
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "What should happen with “second.md” (1 byte)?",
    );
    expect(screen.queryByText(/1\.5 KiB/)).toBeNull();
    expectNoFileDropAction(handlers);
  });
});

describe("FileDropDialog action ownership", () => {
  it("reads and replaces once when Replace is activated twice before React commits", async () => {
    const pending = dropped("replace.md", 4);
    const handlers = callbacks();
    render(dialog(pending, handlers));

    activateBeforeCommit("file-drop-replace", "file-drop-replace");
    expect(ControlledFileReader.reads).toHaveLength(1);
    expect(ControlledFileReader.reads[0].file).toBe(pending.file);
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "What should happen with “replace.md” (6 bytes)?",
    );

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
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "What should happen with “insert.md” (6 bytes)?",
    );

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
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "What should happen with “new.md” (6 bytes)?",
    );

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
    const second = {
      file: new File([new Uint8Array(1536)], "second.md", { type: "text/markdown" }),
      at: 29,
    };
    const handlers = callbacks();
    const view = render(dialog(first, handlers));
    fireEvent.click(screen.getByTestId("file-drop-replace"));

    view.rerender(dialog(second, handlers));
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "What should happen with “second.md” (1.5 KiB)?",
    );
    expect(screen.queryByText(/first\.md/)).toBeNull();
    expect(screen.getByTestId("file-drop-insert")).toBeEnabled();
    fireEvent.click(screen.getByTestId("file-drop-insert"));
    expect(ControlledFileReader.reads).toHaveLength(2);

    await resolveRead(0, "Stale first");
    expect(handlers.onReplace).not.toHaveBeenCalled();
    expect(handlers.onInsert).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(screen.getByText(
      "What should happen with “second.md” (1.5 KiB)?",
    )).toBeVisible();
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
