// @vitest-environment jsdom
import { useEffect, useLayoutEffect, type ReactNode, type RefCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
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

type OptionHandler = (event: { currentTarget: HTMLButtonElement }) => void;

interface CapturedOption {
  element: HTMLButtonElement;
  onClick: OptionHandler;
  ref: RefCallback<HTMLButtonElement>;
}

const directViews: DirectView[] = [];
const mutationObservers: MutationObserver[] = [];

function renderDirect(node: ReactNode): DirectView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { host, root: createRoot(host) };
  directViews.push(view);
  act(() => view.root.render(node));
  return view;
}

function observeMutations(target: Node = document.body): MutationObserver {
  const observer = new MutationObserver(() => {});
  observer.observe(target, { attributes: true, characterData: true, childList: true, subtree: true });
  mutationObservers.push(observer);
  return observer;
}

function reactProp<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const value = props?.[name];
  if (typeof value !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return value as T;
}

function captureOption(action: "replace" | "insert" | "new"): CapturedOption {
  const element = screen.getByTestId(`file-drop-${action}`) as HTMLButtonElement;
  return {
    element,
    onClick: reactProp<OptionHandler>(element, "onClick"),
    ref: reactProp<RefCallback<HTMLButtonElement>>(element, "ref"),
  };
}

function captureOpenChange() {
  const handler = dialogOpenChanges.at(-1);
  if (!handler) throw new Error("Dialog onOpenChange was not captured");
  return handler;
}

function invoke(option: CapturedOption, currentTarget = option.element) {
  option.onClick({ currentTarget });
}

function InitialDialog(props: FileDropDialogProps) {
  return <FileDropDialog {...props} />;
}

function ReplacementDialog(props: FileDropDialogProps) {
  return <FileDropDialog {...props} />;
}

function DialogBoundary({
  dialogProps,
  mount = "initial",
  present = true,
  passiveVisit = 0,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  dialogProps: FileDropDialogProps;
  mount?: "initial" | "replacement";
  present?: boolean;
  passiveVisit?: number;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => onPassiveCleanup, [onPassiveCleanup, passiveVisit]);
  if (!present) return null;
  return mount === "initial" ? <InitialDialog {...dialogProps} /> : <ReplacementDialog {...dialogProps} />;
}

function resetMock(mock: Mock) {
  mock.mockReset();
}

beforeEach(() => {
  ControlledFileReader.reads = [];
  vi.stubGlobal("FileReader", ControlledFileReader);
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

  it.each(["replace", "insert", "new"] as const)(
    "accepts %s only from its exact current button and rejects competing controls synchronously",
    async (action) => {
      const pending = dropped(`${action}.md`, 23);
      const handlers = callbacks();
      const upload = deferred<Array<{ id: string; title: string; warnings: string[] }>>();
      uploadImportFiles.mockReturnValue(upload.promise);
      render(dialog(pending, handlers));
      const options = {
        replace: captureOption("replace"),
        insert: captureOption("insert"),
        new: captureOption("new"),
      };
      const selected = options[action];
      const competitors = Object.values(options).filter((option) => option !== selected);
      const foreign = document.createElement("button");
      document.body.append(foreign);

      act(() => {
        for (const option of competitors) invoke(selected, option.element);
        invoke(selected, foreign);
      });
      expect(ControlledFileReader.reads).toHaveLength(0);
      expect(uploadImportFiles).not.toHaveBeenCalled();

      act(() => {
        invoke(selected);
        invoke(selected);
        for (const option of competitors) invoke(option);
      });
      if (action === "new") {
        expect(uploadImportFiles).toHaveBeenCalledExactlyOnceWith([pending.file]);
        expect(ControlledFileReader.reads).toHaveLength(0);
        await act(async () => upload.resolve([{ id: "exact-new", title: "New", warnings: [] }]));
        expect(push).toHaveBeenCalledExactlyOnceWith("/d/exact-new");
      } else {
        expect(ControlledFileReader.reads).toHaveLength(1);
        expect(ControlledFileReader.reads[0].file).toBe(pending.file);
        expect(uploadImportFiles).not.toHaveBeenCalled();
        await resolveRead(0, action === "replace" ? "Exact replace" : "Exact insert");
      }

      if (action === "replace") {
        expect(handlers.onReplace).toHaveBeenCalledExactlyOnceWith("Exact replace");
        expect(handlers.onInsert).not.toHaveBeenCalled();
      } else if (action === "insert") {
        expect(handlers.onInsert).toHaveBeenCalledExactlyOnceWith("Exact insert", 23);
        expect(handlers.onReplace).not.toHaveBeenCalled();
      } else {
        expect(handlers.onReplace).not.toHaveBeenCalled();
        expect(handlers.onInsert).not.toHaveBeenCalled();
      }
      expect(handlers.onClose).toHaveBeenCalledOnce();
      expect(handlers.onError).not.toHaveBeenCalled();
      foreign.remove();
    },
  );

  it("rejects retained disabled Replace and Insert handlers while Open remains usable", async () => {
    const pending = dropped("readonly.md", 9);
    const handlers = callbacks();
    const upload = deferred<Array<{ id: string; title: string; warnings: string[] }>>();
    uploadImportFiles.mockReturnValue(upload.promise);
    render(<FileDropDialog {...propsFor(pending, handlers, false)} />);
    const replace = captureOption("replace");
    const insert = captureOption("insert");
    const open = captureOption("new");

    expect(replace.element).toBeDisabled();
    expect(insert.element).toBeDisabled();
    act(() => {
      invoke(replace);
      invoke(insert);
    });
    expect(ControlledFileReader.reads).toHaveLength(0);
    expect(uploadImportFiles).not.toHaveBeenCalled();

    act(() => invoke(open));
    expect(uploadImportFiles).toHaveBeenCalledExactlyOnceWith([pending.file]);
    await act(async () => upload.resolve([{ id: "readonly-new", title: "Readonly", warnings: [] }]));
    expect(push).toHaveBeenCalledExactlyOnceWith("/d/readonly-new");
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it.each(["callbacks", "router", "canEdit", "pending", "file", "offset"] as const)(
    "retires a retained publication at the parent layout boundary when %s changes",
    async (replacement) => {
      const firstFile = new File(["unused"], "facts.md", { type: "text/markdown" });
      const pending = { file: firstFile, at: 7 };
      const firstHandlers = callbacks();
      let currentHandlers = firstHandlers;
      let currentPending = pending;
      let currentCanEdit = true;
      let currentPush = push;
      let passiveCleanups = 0;
      const view = renderDirect(
        <DialogBoundary
          dialogProps={propsFor(pending, firstHandlers)}
          onPassiveCleanup={() => passiveCleanups++}
        />,
      );
      const stale = captureOption("replace");
      const staleClose = captureOpenChange();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const observer = observeMutations();
      const upload = deferred<Array<{ id: string; title: string; warnings: string[] }>>();
      uploadImportFiles.mockReturnValue(upload.promise);

      if (replacement === "callbacks") {
        currentHandlers = callbacks();
      } else if (replacement === "router") {
        currentHandlers = callbacks();
        currentPush = vi.fn();
        navigation.router = { push: currentPush };
      } else if (replacement === "canEdit") {
        currentCanEdit = false;
      } else if (replacement === "pending") {
        currentPending = { file: firstFile, at: pending.at };
      } else if (replacement === "file") {
        currentHandlers = callbacks();
        pending.file = new File(["unused"], "changed-file.md", { type: "text/markdown" });
      } else {
        currentHandlers = callbacks();
        pending.at = 41;
      }

      act(() => {
        view.root.render(
          <DialogBoundary
            dialogProps={propsFor(currentPending, currentHandlers, currentCanEdit)}
            passiveVisit={1}
            boundary={1}
            onPassiveCleanup={() => passiveCleanups++}
            onBoundary={() => {
              expect(passiveCleanups).toBe(0);
              const currentElement = screen.getByTestId("file-drop-new") as HTMLButtonElement;
              observer.takeRecords();
              focus.mockClear();
              invoke(stale);
              invoke(stale, currentElement);
              stale.ref(currentElement);
              stale.ref(null);
              staleClose(false);
            }}
          />,
        );
      });

      expect(passiveCleanups).toBe(1);
      expect(ControlledFileReader.reads).toHaveLength(0);
      expect(uploadImportFiles).not.toHaveBeenCalled();
      expect(firstHandlers.onClose).not.toHaveBeenCalled();
      expect(currentHandlers.onClose).not.toHaveBeenCalled();
      expect(observer.takeRecords()).toHaveLength(0);
      expect(focus).not.toHaveBeenCalled();

      const current = captureOption("new");
      act(() => {
        invoke(stale);
        invoke(stale, current.element);
        staleClose(false);
      });
      expect(ControlledFileReader.reads).toHaveLength(0);
      expect(uploadImportFiles).not.toHaveBeenCalled();
      expect(observer.takeRecords()).toHaveLength(0);
      expect(focus).not.toHaveBeenCalled();

      act(() => invoke(current));
      expect(uploadImportFiles).toHaveBeenCalledExactlyOnceWith([currentPending.file]);
      await act(async () => upload.resolve([{ id: `current-${replacement}`, title: "Current", warnings: [] }]));
      expect(currentPush).toHaveBeenCalledExactlyOnceWith(`/d/current-${replacement}`);
      expect(currentHandlers.onClose).toHaveBeenCalledOnce();
      expect(currentHandlers.onError).not.toHaveBeenCalled();
    },
  );

  it("uses only replacement callbacks when the same pending destination changes during a read", async () => {
    const pending = dropped("same-pending-callbacks.md", 31);
    const firstHandlers = callbacks();
    const secondHandlers = callbacks();
    const view = renderDirect(<FileDropDialog {...propsFor(pending, firstHandlers)} />);
    const staleReplace = captureOption("replace");
    act(() => invoke(staleReplace));
    expect(ControlledFileReader.reads).toHaveLength(1);

    act(() => view.root.render(<FileDropDialog {...propsFor(pending, secondHandlers)} />));
    const currentInsert = captureOption("insert");
    act(() => invoke(currentInsert));
    expect(ControlledFileReader.reads).toHaveLength(2);

    await resolveRead(0, "Retired success");
    expect(firstHandlers.onReplace).not.toHaveBeenCalled();
    expect(firstHandlers.onClose).not.toHaveBeenCalled();
    expect(firstHandlers.onError).not.toHaveBeenCalled();
    expect(secondHandlers.onReplace).not.toHaveBeenCalled();
    expect(secondHandlers.onInsert).not.toHaveBeenCalled();
    expect(screen.getByTestId("file-drop-insert")).toBeDisabled();
    act(() => invoke(staleReplace, currentInsert.element));
    expect(ControlledFileReader.reads).toHaveLength(2);

    await resolveRead(1, "Current insert");
    expect(secondHandlers.onInsert).toHaveBeenCalledExactlyOnceWith("Current insert", 31);
    expect(secondHandlers.onClose).toHaveBeenCalledOnce();
    expect(secondHandlers.onError).not.toHaveBeenCalled();
  });

  it("does not report a retired same-pending error or let its finalizer release current work", async () => {
    const pending = dropped("same-pending-error.md", 12);
    const firstHandlers = callbacks();
    const secondHandlers = callbacks();
    const view = renderDirect(<FileDropDialog {...propsFor(pending, firstHandlers)} />);
    act(() => invoke(captureOption("replace")));

    act(() => view.root.render(<FileDropDialog {...propsFor(pending, secondHandlers)} />));
    const current = captureOption("insert");
    act(() => invoke(current));
    await rejectRead(0, new Error("Retired failure"));
    expect(firstHandlers.onError).not.toHaveBeenCalled();
    expect(secondHandlers.onError).not.toHaveBeenCalled();
    expect(screen.getByTestId("file-drop-insert")).toBeDisabled();
    act(() => invoke(captureOption("new")));
    expect(uploadImportFiles).not.toHaveBeenCalled();

    await resolveRead(1, "Still current");
    expect(secondHandlers.onInsert).toHaveBeenCalledExactlyOnceWith("Still current", 12);
    expect(secondHandlers.onClose).toHaveBeenCalledOnce();
  });

  it.each(["distinct method", "reused method"] as const)(
    "freezes an Open destination across router replacement with a %s",
    async (methodKind) => {
      const pending = dropped("router.md", 0);
      const handlers = callbacks();
      const firstPush = vi.fn();
      navigation.router = { push: firstPush };
      const firstUpload = deferred<Array<{ id: string; title: string; warnings: string[] }>>();
      const secondUpload = deferred<Array<{ id: string; title: string; warnings: string[] }>>();
      uploadImportFiles.mockReturnValueOnce(firstUpload.promise).mockReturnValueOnce(secondUpload.promise);
      const view = renderDirect(<FileDropDialog {...propsFor(pending, handlers)} />);
      const stale = captureOption("new");
      act(() => invoke(stale));

      const secondPush = methodKind === "reused method" ? firstPush : vi.fn();
      navigation.router = { push: secondPush };
      act(() => view.root.render(<FileDropDialog {...propsFor(pending, handlers, false)} />));
      const current = captureOption("new");
      act(() => invoke(current));
      expect(uploadImportFiles).toHaveBeenCalledTimes(2);

      await act(async () => firstUpload.resolve([{ id: "retired-router", title: "Retired", warnings: [] }]));
      expect(firstPush).not.toHaveBeenCalled();
      expect(handlers.onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId("file-drop-new")).toBeDisabled();

      await act(async () => secondUpload.resolve([{ id: "current-router", title: "Current", warnings: [] }]));
      expect(secondPush).toHaveBeenCalledExactlyOnceWith("/d/current-router");
      expect(handlers.onClose).toHaveBeenCalledOnce();
      expect(handlers.onError).not.toHaveBeenCalled();
    },
  );

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "isolates an equal-looking remount with reused facts in %s order",
    async (order) => {
      const pending = dropped("remount.md", 5);
      const handlers = callbacks();
      let passiveCleanups = 0;
      const view = renderDirect(
        <DialogBoundary
          dialogProps={propsFor(pending, handlers)}
          onPassiveCleanup={() => passiveCleanups++}
        />,
      );
      const stale = captureOption("replace");
      const staleClose = captureOpenChange();

      act(() => {
        view.root.render(
          <DialogBoundary
            dialogProps={propsFor(pending, handlers)}
            mount="replacement"
            passiveVisit={1}
            boundary={1}
            onPassiveCleanup={() => passiveCleanups++}
            onBoundary={() => {
              expect(passiveCleanups).toBe(0);
              invoke(stale);
              staleClose(false);
            }}
          />,
        );
      });
      expect(passiveCleanups).toBe(1);
      expect(ControlledFileReader.reads).toHaveLength(0);
      expect(handlers.onClose).not.toHaveBeenCalled();
      const current = captureOption("replace");
      expect(current.element).not.toBe(stale.element);
      const invokeStale = () => {
        invoke(stale);
        invoke(stale, current.element);
        stale.ref(current.element);
        stale.ref(null);
        staleClose(false);
      };
      act(() => {
        if (order === "stale-before-current") {
          invokeStale();
          invoke(current);
        } else {
          invoke(current);
          invokeStale();
        }
      });

      expect(ControlledFileReader.reads).toHaveLength(1);
      await resolveRead(0, "Current remount");
      expect(handlers.onReplace).toHaveBeenCalledExactlyOnceWith("Current remount");
      expect(handlers.onClose).toHaveBeenCalledOnce();
      expect(handlers.onError).not.toHaveBeenCalled();
    },
  );

  it("binds close to its exact publication, locks it during work, and calls the replacement once", async () => {
    const pending = dropped("close.md", 3);
    const firstHandlers = callbacks();
    const secondHandlers = callbacks();
    const view = renderDirect(<FileDropDialog {...propsFor(pending, firstHandlers)} />);
    const staleOption = captureOption("replace");
    const staleClose = captureOpenChange();
    act(() => {
      invoke(staleOption);
      staleClose(false);
    });
    expect(firstHandlers.onClose).not.toHaveBeenCalled();

    act(() => view.root.render(<FileDropDialog {...propsFor(pending, secondHandlers)} />));
    const currentOption = captureOption("insert");
    const currentClose = captureOpenChange();
    act(() => {
      staleClose(false);
      currentClose(false);
      currentClose(false);
      invoke(staleOption, currentOption.element);
      invoke(currentOption);
    });
    expect(firstHandlers.onClose).not.toHaveBeenCalled();
    expect(secondHandlers.onClose).toHaveBeenCalledOnce();
    expect(ControlledFileReader.reads).toHaveLength(1);

    await resolveRead(0, "Retired close");
    expect(firstHandlers.onReplace).not.toHaveBeenCalled();
    expect(firstHandlers.onError).not.toHaveBeenCalled();
    expect(secondHandlers.onInsert).not.toHaveBeenCalled();
    expect(secondHandlers.onError).not.toHaveBeenCalled();
    expect(secondHandlers.onClose).toHaveBeenCalledOnce();
  });

  it.each(["read", "import"] as const)(
    "retires a removed %s operation before the parent layout boundary and ignores settlement",
    async (kind) => {
      const pending = dropped(`removed-${kind}.md`, 14);
      const handlers = callbacks();
      const upload = deferred<Array<{ id: string; title: string; warnings: string[] }>>();
      uploadImportFiles.mockReturnValue(upload.promise);
      let passiveCleanups = 0;
      const view = renderDirect(
        <DialogBoundary
          dialogProps={propsFor(pending, handlers)}
          onPassiveCleanup={() => passiveCleanups++}
        />,
      );
      const stale = captureOption(kind === "read" ? "replace" : "new");
      const staleClose = captureOpenChange();
      act(() => invoke(stale));
      expect(kind === "read" ? ControlledFileReader.reads.length : uploadImportFiles.mock.calls.length).toBe(1);
      const observer = observeMutations();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");

      act(() => {
        view.root.render(
          <DialogBoundary
            dialogProps={propsFor(pending, handlers)}
            present={false}
            passiveVisit={1}
            boundary={1}
            onPassiveCleanup={() => passiveCleanups++}
            onBoundary={() => {
              expect(passiveCleanups).toBe(0);
              expect(screen.queryByTestId("file-drop-dialog")).toBeNull();
              observer.takeRecords();
              focus.mockClear();
              invoke(stale);
              stale.ref(null);
              staleClose(false);
              if (kind === "read") ControlledFileReader.reads[0].reader.resolve("Removed");
              else upload.resolve([{ id: "removed", title: "Removed", warnings: [] }]);
            }}
          />,
        );
      });
      await act(async () => {});

      expect(passiveCleanups).toBe(1);
      expect(ControlledFileReader.reads).toHaveLength(kind === "read" ? 1 : 0);
      expect(uploadImportFiles).toHaveBeenCalledTimes(kind === "import" ? 1 : 0);
      expect(handlers.onReplace).not.toHaveBeenCalled();
      expect(handlers.onInsert).not.toHaveBeenCalled();
      expect(handlers.onClose).not.toHaveBeenCalled();
      expect(handlers.onError).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      expect(observer.takeRecords()).toHaveLength(0);
      expect(focus).not.toHaveBeenCalled();

      act(() => {
        invoke(stale);
        staleClose(false);
      });
      expect(ControlledFileReader.reads).toHaveLength(kind === "read" ? 1 : 0);
      expect(uploadImportFiles).toHaveBeenCalledTimes(kind === "import" ? 1 : 0);
      expect(observer.takeRecords()).toHaveLength(0);
      expect(focus).not.toHaveBeenCalled();
    },
  );
});
