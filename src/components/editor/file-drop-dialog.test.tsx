// @vitest-environment jsdom
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  type ReactNode,
  type RefCallback,
} from "react";
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

type OptionHandler = (event: { currentTarget: HTMLButtonElement }) => void;

interface CapturedOption {
  element: HTMLButtonElement;
  onClick: OptionHandler;
  ref: RefCallback<HTMLButtonElement>;
}

const directViews: DirectView[] = [];
const mutationObservers: MutationObserver[] = [];

interface DocumentListenerRecord {
  readonly type: string;
  readonly listener: EventListenerOrEventListenerObject;
  readonly capture: boolean;
  active: boolean;
}

function captureDocumentDismissalListeners() {
  const records: DocumentListenerRecord[] = [];
  const nativeAdd = document.addEventListener.bind(document);
  const nativeRemove = document.removeEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation(
    (type, listener, options) => {
      records.push({
        type,
        listener,
        capture:
          typeof options === "boolean"
            ? options
            : Boolean(options?.capture),
        active: true,
      });
      nativeAdd(type, listener, options);
    },
  );
  vi.spyOn(document, "removeEventListener").mockImplementation(
    (type, listener, options) => {
      const capture =
        typeof options === "boolean" ? options : Boolean(options?.capture);
      const record = records.findLast(
        (candidate) =>
          candidate.active &&
          candidate.type === type &&
          candidate.listener === listener &&
          candidate.capture === capture,
      );
      if (record) record.active = false;
      nativeRemove(type, listener, options);
    },
  );
  const active = (type: string) =>
    records.filter((record) => record.active && record.type === type);
  return {
    componentCapture() {
      const pointerListeners = active("pointerdown");
      const clickListeners = active("click");
      const record = active("keydown").find(
        ({ listener }) =>
          pointerListeners.some(
            (candidate) => candidate.listener === listener,
          ) &&
          clickListeners.some(
            (candidate) => candidate.listener === listener,
          ),
      );
      if (!record) {
        throw new Error(
          "Dropped-file document dismissal listener was not registered",
        );
      }
      return record.listener;
    },
    suspend(...types: string[]) {
      for (const record of records) {
        if (!record.active || !types.includes(record.type)) continue;
        nativeRemove(record.type, record.listener, record.capture);
        record.active = false;
      }
    },
  };
}

function invokeEventListener(
  listener: EventListenerOrEventListenerObject,
  event: Event,
) {
  if (typeof listener === "function") listener.call(document, event);
  else listener.handleEvent(event);
}

function renderDirect(node: ReactNode): DirectView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { host, root: createRoot(host) };
  directViews.push(view);
  act(() => view.root.render(node));
  return view;
}

function renderStrict(props: FileDropDialogProps) {
  return renderDirect(
    <StrictMode>
      <FileDropDialog {...props} />
    </StrictMode>,
  );
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

function activate(option: CapturedOption) {
  fireEvent.click(option.element);
}

function closeButton() {
  return screen.getByRole("button", { name: "Close" });
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

      act(() => {
        for (const option of competitors) invoke(selected, option.element);
        invoke(selected, foreign);
      });
      expect(ControlledFileReader.reads).toHaveLength(0);
      expect(uploadImportFiles).not.toHaveBeenCalled();

      act(() => {
        activate(selected);
        activate(selected);
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

    act(() => activate(open));
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

      act(() => activate(current));
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
    act(() => activate(staleReplace));
    expect(ControlledFileReader.reads).toHaveLength(1);

    act(() => view.root.render(<FileDropDialog {...propsFor(pending, secondHandlers)} />));
    const currentInsert = captureOption("insert");
    act(() => activate(currentInsert));
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
    act(() => activate(captureOption("replace")));

    act(() => view.root.render(<FileDropDialog {...propsFor(pending, secondHandlers)} />));
    const current = captureOption("insert");
    act(() => activate(current));
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
      act(() => activate(stale));

      const secondPush = methodKind === "reused method" ? firstPush : vi.fn();
      navigation.router = { push: secondPush };
      act(() => view.root.render(<FileDropDialog {...propsFor(pending, handlers, false)} />));
      const current = captureOption("new");
      act(() => activate(current));
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
          activate(current);
        } else {
          activate(current);
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
      activate(staleOption);
      staleClose(false);
    });
    expect(firstHandlers.onClose).not.toHaveBeenCalled();

    act(() => view.root.render(<FileDropDialog {...propsFor(pending, secondHandlers)} />));
    const currentOption = captureOption("insert");
    const currentClose = captureOpenChange();
    act(() => {
      staleClose(false);
      currentClose(false);
      fireEvent.click(closeButton());
      fireEvent.click(closeButton());
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
      act(() => activate(stale));
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

describe("FileDropDialog Strict Mode publication ownership", () => {
  it.each(["replace", "insert", "new"] as const)(
    "publishes one permanent successor for %s",
    async (action) => {
      const pending = dropped(`strict-${action}.md`, 37);
      const handlers = callbacks();
      const upload =
        deferred<Array<{ id: string; title: string; warnings: string[] }>>();
      uploadImportFiles.mockReturnValue(upload.promise);
      renderStrict(propsFor(pending, handlers));

      const staleClose = dialogOpenChanges[0];
      staleClose?.(false);
      activateBeforeCommit(
        `file-drop-${action}`,
        `file-drop-${action}`,
        `file-drop-${action === "replace" ? "insert" : "replace"}`,
      );

      if (action === "new") {
        expect(uploadImportFiles).toHaveBeenCalledExactlyOnceWith([
          pending.file,
        ]);
        await act(async () =>
          upload.resolve([
            { id: "strict-new", title: "Strict", warnings: [] },
          ]),
        );
        expect(push).toHaveBeenCalledExactlyOnceWith("/d/strict-new");
      } else {
        expect(ControlledFileReader.reads).toHaveLength(1);
        await resolveRead(0, `Strict ${action}`);
      }

      if (action === "replace") {
        expect(handlers.onReplace).toHaveBeenCalledExactlyOnceWith(
          "Strict replace",
        );
        expect(handlers.onInsert).not.toHaveBeenCalled();
      } else if (action === "insert") {
        expect(handlers.onInsert).toHaveBeenCalledExactlyOnceWith(
          "Strict insert",
          37,
        );
        expect(handlers.onReplace).not.toHaveBeenCalled();
      } else {
        expect(handlers.onReplace).not.toHaveBeenCalled();
        expect(handlers.onInsert).not.toHaveBeenCalled();
      }
      expect(handlers.onClose).toHaveBeenCalledOnce();
      expect(handlers.onError).not.toHaveBeenCalled();
    },
  );

  it.each(["close", "escape", "outside"] as const)(
    "publishes one permanent successor for %s dismissal",
    async (dismissal) => {
      const handlers = callbacks();
      renderStrict(
        propsFor(dropped(`strict-${dismissal}.md`, 0), handlers),
      );
      const staleClose = dialogOpenChanges[0];
      staleClose?.(false);
      await act(
        () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
      );

      if (dismissal === "close") {
        fireEvent.click(closeButton());
        fireEvent.click(closeButton());
      } else if (dismissal === "escape") {
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      } else {
        const outside = document.querySelector(".dialog-overlay");
        if (!(outside instanceof HTMLDivElement)) {
          throw new Error("Dialog overlay was not rendered");
        }
        outside.dispatchEvent(
          new ControlledPointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
          }),
        );
        await act(async () => {});
        outside.dispatchEvent(
          new ControlledPointerEvent("click", {
            bubbles: true,
            button: 0,
          }),
        );
        outside.dispatchEvent(
          new ControlledPointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
          }),
        );
        outside.dispatchEvent(
          new ControlledPointerEvent("click", {
            bubbles: true,
            button: 0,
          }),
        );
      }

      expect(handlers.onClose).toHaveBeenCalledOnce();
      expect(ControlledFileReader.reads).toHaveLength(0);
      expect(uploadImportFiles).not.toHaveBeenCalled();
    },
  );

  it("keeps Escape authority through a browser microtask before Radix handles it", async () => {
    const nativeDismissal = captureDocumentDismissalListeners();
    const handlers = callbacks();
    renderStrict(
      propsFor(dropped("strict-delayed-escape.md", 0), handlers),
    );
    const authorize = nativeDismissal.componentCapture();
    nativeDismissal.suspend("keydown");
    const content = screen.getByRole("dialog");
    const openChange = captureOpenChange();
    content.addEventListener(
      "keydown",
      (event) => invokeEventListener(authorize, event),
      { once: true },
    );

    content.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Escape",
      }),
    );
    await Promise.resolve();
    act(() => openChange(false));

    expect(handlers.onClose).toHaveBeenCalledOnce();
    expect(ControlledFileReader.reads).toHaveLength(0);
    expect(uploadImportFiles).not.toHaveBeenCalled();
  });

  it("keeps linked PointerEvent authority through a browser microtask before Radix handles it", async () => {
    const nativeDismissal = captureDocumentDismissalListeners();
    const handlers = callbacks();
    renderStrict(
      propsFor(dropped("strict-delayed-outside.md", 0), handlers),
    );
    await act(
      () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
    );
    const overlay = document.querySelector(".dialog-overlay");
    if (!(overlay instanceof HTMLDivElement)) {
      throw new Error("Dialog overlay was not rendered");
    }
    const authorize = nativeDismissal.componentCapture();
    nativeDismissal.suspend("pointerdown", "click");
    const openChange = captureOpenChange();
    overlay.addEventListener(
      "pointerdown",
      (event) => invokeEventListener(authorize, event),
      { once: true },
    );
    overlay.addEventListener(
      "click",
      (event) => invokeEventListener(authorize, event),
      { once: true },
    );

    overlay.dispatchEvent(
      new ControlledPointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 17,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    overlay.dispatchEvent(
      new ControlledPointerEvent("click", {
        bubbles: true,
        button: 0,
        pointerId: 17,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    await Promise.resolve();
    act(() => openChange(false));

    expect(handlers.onClose).toHaveBeenCalledOnce();
    expect(ControlledFileReader.reads).toHaveLength(0);
    expect(uploadImportFiles).not.toHaveBeenCalled();
  });

  it("leaves the current options usable after unconsumed dismissal authority expires", async () => {
    const nativeDismissal = captureDocumentDismissalListeners();
    const handlers = callbacks();
    renderStrict(
      propsFor(dropped("strict-failed-dismissal.md", 8), handlers),
    );
    const authorize = nativeDismissal.componentCapture();
    nativeDismissal.suspend("keydown");
    const content = screen.getByRole("dialog");
    const openChange = captureOpenChange();
    content.addEventListener(
      "keydown",
      (event) => invokeEventListener(authorize, event),
      { once: true },
    );
    content.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Escape",
      }),
    );
    await act(
      () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
    );

    act(() => openChange(false));
    expect(handlers.onClose).not.toHaveBeenCalled();

    const overlay = document.querySelector(".dialog-overlay");
    if (!(overlay instanceof HTMLDivElement)) {
      throw new Error("Dialog overlay was not rendered");
    }
    nativeDismissal.suspend("pointerdown", "click");
    overlay.addEventListener(
      "pointerdown",
      (event) => invokeEventListener(authorize, event),
      { once: true },
    );
    overlay.addEventListener(
      "click",
      (event) => invokeEventListener(authorize, event),
      { once: true },
    );
    overlay.dispatchEvent(
      new ControlledPointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 31,
      }),
    );
    overlay.dispatchEvent(
      new ControlledPointerEvent("click", {
        bubbles: true,
        button: 0,
        pointerId: 32,
      }),
    );
    act(() => openChange(false));
    expect(handlers.onClose).not.toHaveBeenCalled();

    activate(captureOption("replace"));
    expect(ControlledFileReader.reads).toHaveLength(1);
    await resolveRead(0, "Still usable");
    expect(handlers.onReplace).toHaveBeenCalledExactlyOnceWith(
      "Still usable",
    );
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it.each(["attributes", "detach", "replacement", "reorder"] as const)(
    "permanently rejects a publication after restored %s mutation",
    (mutation) => {
      const handlers = callbacks();
      renderStrict(
        propsFor(dropped(`strict-mutated-${mutation}.md`, 11), handlers),
      );
      const option = captureOption("replace");
      const root = screen.getByTestId("file-drop-dialog");

      if (mutation === "attributes") {
        const className = option.element.className;
        option.element.className = "mutated";
        option.element.className = className;
      } else if (mutation === "detach") {
        const parent = root.parentNode;
        if (!parent) throw new Error("Dialog options were not attached");
        root.remove();
        parent.append(root);
      } else if (mutation === "replacement") {
        const replacement = option.element.cloneNode(true);
        if (!(replacement instanceof HTMLButtonElement)) {
          throw new Error("Cloned option was not a button");
        }
        option.element.replaceWith(replacement);
        replacement.replaceWith(option.element);
      } else {
        const insert = screen.getByTestId("file-drop-insert");
        root.insertBefore(insert, option.element);
        root.insertBefore(option.element, insert);
      }

      act(() => {
        invoke(option);
        activate(option);
        captureOpenChange()(false);
      });
      fireEvent.click(closeButton());
      expect(ControlledFileReader.reads).toHaveLength(0);
      expect(uploadImportFiles).not.toHaveBeenCalled();
      expect(handlers.onClose).not.toHaveBeenCalled();
    },
  );

  it("accepts an exact ref replay only through a fresh successor and ignores late retired refs", async () => {
    const pending = dropped("strict-ref-replay.md", 19);
    const handlers = callbacks();
    renderStrict(propsFor(pending, handlers));
    const retired = captureOption("replace");

    act(() => {
      retired.ref(null);
      retired.ref(retired.element);
    });
    const current = captureOption("insert");
    act(() => {
      retired.ref(null);
      retired.ref(current.element);
      invoke(retired, current.element);
      activate(current);
    });

    expect(ControlledFileReader.reads).toHaveLength(1);
    await resolveRead(0, "Fresh successor");
    expect(handlers.onInsert).toHaveBeenCalledExactlyOnceWith(
      "Fresh successor",
      19,
    );
    expect(handlers.onReplace).not.toHaveBeenCalled();
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it("consumes a reused native event and a nested reentry once", async () => {
    const handlers = callbacks();
    renderStrict(propsFor(dropped("strict-consumed.md", 0), handlers));
    const option = captureOption("replace");
    const click = new MouseEvent("click", {
      bubbles: true,
      button: 0,
    });
    const reentry = new MouseEvent("click", {
      bubbles: true,
      button: 0,
    });
    let reentered = false;
    option.element.addEventListener("click", (event) => {
      if (event !== click || reentered) return;
      reentered = true;
      option.element.dispatchEvent(reentry);
    });

    act(() => {
      option.element.dispatchEvent(click);
      option.element.dispatchEvent(reentry);
    });
    expect(ControlledFileReader.reads).toHaveLength(1);
    await resolveRead(0, "Consumed once");
    expect(handlers.onReplace).toHaveBeenCalledExactlyOnceWith(
      "Consumed once",
    );
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it("publishes a fresh actionable successor after a failed operation", async () => {
    const handlers = callbacks();
    renderStrict(propsFor(dropped("strict-retry.md", 6), handlers));
    const retired = captureOption("replace");
    activate(retired);
    await rejectRead(0, new Error("Strict read failed"));
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(
      "Strict read failed",
    );

    const current = captureOption("insert");
    act(() => {
      invoke(retired, current.element);
      activate(current);
      activate(current);
    });
    expect(ControlledFileReader.reads).toHaveLength(2);
    await resolveRead(1, "Strict recovery");
    expect(handlers.onInsert).toHaveBeenCalledExactlyOnceWith(
      "Strict recovery",
      6,
    );
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it.each(["read", "upload"] as const)(
    "ignores late retired %s settlement without poisoning the current operation",
    async (kind) => {
      const first = dropped(`strict-late-first-${kind}.md`, 3);
      const second = dropped(`strict-late-second-${kind}.md`, 29);
      const handlers = callbacks();
      const firstUpload =
        deferred<Array<{ id: string; title: string; warnings: string[] }>>();
      const secondUpload =
        deferred<Array<{ id: string; title: string; warnings: string[] }>>();
      uploadImportFiles
        .mockReturnValueOnce(firstUpload.promise)
        .mockReturnValueOnce(secondUpload.promise);
      const view = renderStrict(propsFor(first, handlers));

      activate(captureOption(kind === "read" ? "replace" : "new"));
      act(() =>
        view.root.render(
          <StrictMode>
            <FileDropDialog {...propsFor(second, handlers)} />
          </StrictMode>,
        ),
      );
      activate(captureOption(kind === "read" ? "insert" : "new"));

      if (kind === "read") {
        expect(ControlledFileReader.reads).toHaveLength(2);
        await resolveRead(0, "Retired read");
        expect(handlers.onReplace).not.toHaveBeenCalled();
        expect(handlers.onInsert).not.toHaveBeenCalled();
        await resolveRead(1, "Current read");
        expect(handlers.onInsert).toHaveBeenCalledExactlyOnceWith(
          "Current read",
          29,
        );
      } else {
        expect(uploadImportFiles).toHaveBeenCalledTimes(2);
        await act(async () =>
          firstUpload.resolve([
            { id: "retired-upload", title: "Retired", warnings: [] },
          ]),
        );
        expect(push).not.toHaveBeenCalled();
        expect(handlers.onClose).not.toHaveBeenCalled();
        await act(async () =>
          secondUpload.resolve([
            { id: "current-upload", title: "Current", warnings: [] },
          ]),
        );
        expect(push).toHaveBeenCalledExactlyOnceWith("/d/current-upload");
      }

      expect(handlers.onClose).toHaveBeenCalledOnce();
      expect(handlers.onError).not.toHaveBeenCalled();
    },
  );
});
