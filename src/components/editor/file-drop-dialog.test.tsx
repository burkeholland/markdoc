// @vitest-environment jsdom
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
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

type OptionHandler = (event: ReactMouseEvent<HTMLButtonElement>) => void;
type OptionKeyHandler = (
  event: ReactKeyboardEvent<HTMLButtonElement>,
) => void;

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

function setReactProp<T>(element: HTMLElement, name: string, value: T) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const attached = element as unknown as Record<string, Record<string, unknown> | undefined>;
  const props = attached[propsKey];
  if (!props) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  attached[propsKey] = { ...props, [name]: value };
}

function replaceReactProps(
  element: HTMLElement,
  replacements: Record<string, unknown>,
) {
  const propsKey = Object.keys(element).find((key) =>
    key.startsWith("__reactProps$"),
  );
  if (!propsKey) {
    throw new Error(
      `React props were not attached to ${element.dataset.testid ?? element.tagName}`,
    );
  }
  const attached = element as unknown as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const props = attached[propsKey];
  if (!props) {
    throw new Error(
      `React props were not attached to ${element.dataset.testid ?? element.tagName}`,
    );
  }
  const replacement = { ...props, ...replacements };
  attached[propsKey] = replacement;
  return () => {
    if (attached[propsKey] === replacement) attached[propsKey] = props;
  };
}

function markFileDropEventTrusted(event: Event) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map(
      (symbol) =>
        (event as unknown as Record<symbol, unknown>)[symbol],
    )
    .find(
      (candidate): candidate is { isTrusted: boolean } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "isTrusted" in candidate &&
        candidate.isTrusted === false,
    );
  const descriptor = implementation
    ? Object.getOwnPropertyDescriptor(implementation, "isTrusted")
    : undefined;
  if (!implementation || !descriptor?.writable) {
    throw new Error("Unable to set jsdom's dropped-file event trust slot");
  }
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  if (!event.isTrusted) {
    throw new Error("The dropped-file event trust slot did not update");
  }
}

function fileDropKeyEvent(
  source: HTMLButtonElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const ownerWindow = source.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The dropped-file option has no window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (trusted) markFileDropEventTrusted(event);
  return event;
}

function dispatchFileDropKey(
  source: HTMLButtonElement,
  keyOrEvent: string | KeyboardEvent,
  init: KeyboardEventInit = {},
) {
  const event =
    typeof keyOrEvent === "string"
      ? fileDropKeyEvent(source, keyOrEvent, init)
      : keyOrEvent;
  act(() => source.dispatchEvent(event));
  return event;
}

function replaceFileDropPathTerminal(
  event: Event,
  terminal: EventTarget,
) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map(
      (symbol) =>
        (event as unknown as Record<symbol, unknown>)[symbol],
    )
    .find((candidate): candidate is {
      _path: Array<{ item: Record<symbol, unknown> }>;
    } => {
      if (!candidate || typeof candidate !== "object") return false;
      return Array.isArray(
        (candidate as { _path?: unknown })._path,
      );
    });
  const entry = implementation?._path.at(-1);
  const original = event.composedPath().at(-1);
  const wrapper = entry
    ? Object.getOwnPropertySymbols(entry.item).find(
        (symbol) => entry.item[symbol] === original,
      )
    : undefined;
  if (!entry || !wrapper) {
    throw new Error(
      "Unable to replace jsdom's dropped-file path terminal",
    );
  }
  const item: Record<symbol, unknown> = {};
  Object.defineProperty(item, wrapper, { value: terminal });
  entry.item = item;
  if (event.composedPath().at(-1) !== terminal) {
    throw new Error("The dropped-file path terminal did not update");
  }
}

function fileDropOptions() {
  return {
    replace: screen.getByTestId("file-drop-replace") as HTMLButtonElement,
    insert: screen.getByTestId("file-drop-insert") as HTMLButtonElement,
    new: screen.getByTestId("file-drop-new") as HTMLButtonElement,
  };
}

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

function cloneSyntheticClick(
  event: ReactMouseEvent<HTMLButtonElement>,
  overrides: Partial<ReactMouseEvent<HTMLButtonElement>> = {},
  syntheticConstructor?: new () => object,
) {
  const prototype = syntheticConstructor
    ? Object.create(Object.getPrototypeOf(event), {
        constructor: { value: syntheticConstructor },
      })
    : Object.getPrototypeOf(event);
  return Object.assign(
    Object.create(prototype) as ReactMouseEvent<HTMLButtonElement>,
    event,
    overrides,
  );
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
  option.onClick({ currentTarget } as ReactMouseEvent<HTMLButtonElement>);
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

  it("accepts an exact synthetic click after its constructor name is production-mangled", async () => {
    const handlers = callbacks();
    renderStrict(
      propsFor(dropped("strict-minified-click.md", 0), handlers),
    );
    const option = captureOption("replace");
    const mangledConstructor = class a {};
    setReactProp<OptionHandler>(option.element, "onClick", (event) => {
      const syntheticClick = cloneSyntheticClick(
        event,
        {},
        mangledConstructor,
      );
      expect(Object.getPrototypeOf(syntheticClick).constructor.name).toBe("a");
      option.onClick(syntheticClick);
    });

    activate(option);

    expect(ControlledFileReader.reads).toHaveLength(1);
    await resolveRead(0, "Production click");
    expect(handlers.onReplace).toHaveBeenCalledExactlyOnceWith(
      "Production click",
    );
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it("rejects a synthetic-looking click without the complete React event structure", () => {
    const handlers = callbacks();
    renderStrict(
      propsFor(dropped("strict-fabricated-structure.md", 0), handlers),
    );
    const option = captureOption("replace");
    setReactProp<OptionHandler>(option.element, "onClick", (event) => {
      option.onClick(
        cloneSyntheticClick(event, {
          persist: undefined,
        }),
      );
    });

    activate(option);

    expect(ControlledFileReader.reads).toHaveLength(0);
    expect(uploadImportFiles).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

    describe("FileDropDialog keyboard navigation", () => {
      it.each([
        ["replace", "ArrowDown", "insert"],
        ["replace", "ArrowRight", "insert"],
        ["new", "ArrowUp", "insert"],
        ["new", "ArrowLeft", "insert"],
        ["new", "Home", "replace"],
        ["replace", "End", "new"],
        ["insert", "Home", "replace"],
        ["insert", "End", "new"],
      ] as const)(
        "moves from %s with %s to %s exactly once without activating anything",
        (from, key, to) => {
          const preventDefault = vi.spyOn(
            Event.prototype,
            "preventDefault",
          );
          const focus = vi.spyOn(HTMLElement.prototype, "focus");
          const handlers = callbacks();
          renderStrict(propsFor(dropped(`navigation-${key}.md`, 13), handlers));
          const options = fileDropOptions();
          const source = options[from];
          const destination = options[to];
          const root = screen.getByTestId("file-drop-dialog");
          const markup = root.outerHTML;
          const order = [...root.querySelectorAll("button")];
          const scroll = { x: window.scrollX, y: window.scrollY };
          source.focus();
          preventDefault.mockClear();
          focus.mockClear();

          const event = dispatchFileDropKey(source, key);

          expect(event.isTrusted).toBe(true);
          expect(event.defaultPrevented).toBe(true);
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(focus).toHaveBeenCalledExactlyOnceWith({
            preventScroll: true,
          });
          expect(focus.mock.contexts[0]).toBe(destination);
          expect(destination).toHaveFocus();
          expect([...root.querySelectorAll("button")]).toEqual(order);
          expect(root.outerHTML).toBe(markup);
          expect(order.map((button) => button.tabIndex)).toEqual([0, 0, 0]);
          expect({ x: window.scrollX, y: window.scrollY }).toEqual(scroll);
          expectNoFileDropAction(handlers);
        },
      );

      it.each([
        ["replace", "ArrowDown", "Numpad2", "insert"],
        ["replace", "ArrowRight", "Numpad6", "insert"],
        ["new", "ArrowUp", "Numpad8", "insert"],
        ["new", "ArrowLeft", "Numpad4", "insert"],
        ["new", "Home", "Numpad7", "replace"],
        ["replace", "End", "Numpad1", "new"],
      ] as const)(
        "moves from %s with numpad %s (%s) to %s without activating anything",
        (from, key, code, to) => {
          const preventDefault = vi.spyOn(
            Event.prototype,
            "preventDefault",
          );
          const focus = vi.spyOn(HTMLElement.prototype, "focus");
          const handlers = callbacks();
          renderStrict(propsFor(dropped(`numpad-${key}.md`, 13), handlers));
          const options = fileDropOptions();
          const source = options[from];
          const destination = options[to];
          const root = screen.getByTestId("file-drop-dialog");
          const markup = root.outerHTML;
          const order = [...root.querySelectorAll("button")];
          const scroll = { x: window.scrollX, y: window.scrollY };
          source.focus();
          preventDefault.mockClear();
          focus.mockClear();

          const event = dispatchFileDropKey(source, key, {
            code,
            location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
          });

          expect(event.isTrusted).toBe(true);
          expect(event.key).toBe(key);
          expect(event.code).toBe(code);
          expect(event.location).toBe(
            KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
          );
          expect(event.defaultPrevented).toBe(true);
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(focus).toHaveBeenCalledExactlyOnceWith({
            preventScroll: true,
          });
          expect(focus.mock.contexts[0]).toBe(destination);
          expect(destination).toHaveFocus();
          expect([...root.querySelectorAll("button")]).toEqual(order);
          expect(root.outerHTML).toBe(markup);
          expect(order.map((button) => button.tabIndex)).toEqual([0, 0, 0]);
          expect({ x: window.scrollX, y: window.scrollY }).toEqual(scroll);
          expectNoFileDropAction(handlers);
        },
      );

      it.each([
        ["replace", "ArrowUp"],
        ["replace", "ArrowLeft"],
        ["replace", "Home"],
        ["new", "ArrowDown"],
        ["new", "ArrowRight"],
        ["new", "End"],
      ] as const)(
        "leaves the %s boundary for %s unprevented and inert when no move exists",
        (from, key) => {
          const preventDefault = vi.spyOn(
            Event.prototype,
            "preventDefault",
          );
          const focus = vi.spyOn(HTMLElement.prototype, "focus");
          const handlers = callbacks();
          renderStrict(propsFor(dropped(`boundary-${key}.md`, 0), handlers));
          const source = fileDropOptions()[from];
          source.focus();
          preventDefault.mockClear();
          focus.mockClear();

          const event = dispatchFileDropKey(source, key);

          expect(event.defaultPrevented).toBe(false);
          expect(preventDefault).not.toHaveBeenCalled();
          expect(focus).not.toHaveBeenCalled();
          expect(source).toHaveFocus();
          expectNoFileDropAction(handlers);
        },
      );

      it("skips all disabled choices in readonly and busy publications", () => {
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const readonlyHandlers = callbacks();
        const readonlyView = renderStrict(
          propsFor(dropped("readonly-navigation.md", 4), readonlyHandlers, false),
        );
        let options = fileDropOptions();
        expect(options.replace).toBeDisabled();
        expect(options.insert).toBeDisabled();
        expect(options.new).toBeEnabled();
        options.new.focus();
        preventDefault.mockClear();
        focus.mockClear();

        for (const key of [
          "ArrowDown",
          "ArrowRight",
          "ArrowUp",
          "ArrowLeft",
          "Home",
          "End",
        ]) {
          const event = dispatchFileDropKey(options.new, key);
          expect(event.defaultPrevented).toBe(false);
        }
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(options.new).toHaveFocus();
        expectNoFileDropAction(readonlyHandlers);

        act(() => readonlyView.root.render(null));
        const busyHandlers = callbacks();
        renderStrict(propsFor(dropped("busy-navigation.md", 7), busyHandlers));
        options = fileDropOptions();
        options.replace.focus();
        fireEvent.click(options.replace);
        expect(ControlledFileReader.reads).toHaveLength(1);
        expect(options.replace).toBeDisabled();
        expect(options.insert).toBeDisabled();
        expect(options.new).toBeDisabled();
        preventDefault.mockClear();
        focus.mockClear();

        const busyEvent = dispatchFileDropKey(options.replace, "ArrowDown");

        expect(busyEvent.defaultPrevented).toBe(false);
        expect(ControlledFileReader.reads).toHaveLength(1);
        expect(uploadImportFiles).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(busyHandlers.onReplace).not.toHaveBeenCalled();
        expect(busyHandlers.onInsert).not.toHaveBeenCalled();
        expect(busyHandlers.onClose).not.toHaveBeenCalled();
        expect(busyHandlers.onError).not.toHaveBeenCalled();
      });

      it("accepts distinct capture and bubble wrappers and cancels through the exact bubble wrapper", () => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const handlers = callbacks();
        renderStrict(propsFor(dropped("wrapper-delivery.md", 9), handlers));
        const options = fileDropOptions();
        const source = options.replace;
        const root = screen.getByTestId("file-drop-dialog");
        const ownerWindow = source.ownerDocument.defaultView;
        if (!ownerWindow) throw new Error("The option has no owner window");
        const rootCapture = reactProp<
          (event: ReactKeyboardEvent<HTMLDivElement>) => void
        >(root, "onKeyDownCapture");
        const optionCapture = reactProp<OptionKeyHandler>(
          source,
          "onKeyDownCapture",
        );
        const optionBubble = reactProp<OptionKeyHandler>(
          source,
          "onKeyDown",
        );
        const rootBubble = reactProp<
          (event: ReactKeyboardEvent<HTMLDivElement>) => void
        >(root, "onKeyDown");
        const nativePreventDefault =
          ownerWindow.Event.prototype.preventDefault;
        const capturePrototype = Object.create(null);
        const bubblePrototype = Object.create(null);
        const capturePreventDefault = vi.fn(function (
          this: ReactKeyboardEvent<HTMLElement>,
        ) {
          return undefined;
        });
        const captureIsDefaultPrevented = vi.fn(function (
          this: ReactKeyboardEvent<HTMLElement>,
        ) {
          return false;
        });
        const captureIsPropagationStopped = vi.fn(function (
          this: ReactKeyboardEvent<HTMLElement>,
        ) {
          return false;
        });
        const bubblePrevented = vi.fn(function (
          this: ReactKeyboardEvent<HTMLElement>,
        ) {
          return true;
        });
        const bubblePreventDefault = vi.fn(function (
          this: ReactKeyboardEvent<HTMLElement>,
        ) {
          Reflect.apply(nativePreventDefault, this.nativeEvent, []);
          Object.defineProperties(this, {
            defaultPrevented: {
              configurable: true,
              enumerable: true,
              value: true,
              writable: true,
            },
            isDefaultPrevented: {
              configurable: true,
              enumerable: true,
              value: bubblePrevented,
              writable: true,
            },
          });
        });
        const bubbleIsDefaultPrevented = vi.fn(function (
          this: ReactKeyboardEvent<HTMLElement>,
        ) {
          return false;
        });
        const bubbleIsPropagationStopped = vi.fn(function (
          this: ReactKeyboardEvent<HTMLElement>,
        ) {
          return false;
        });
        const createWrapper = (
          event: ReactKeyboardEvent<HTMLElement>,
          prototype: object,
          methods: {
            preventDefault: () => void;
            isDefaultPrevented: () => boolean;
            isPropagationStopped: () => boolean;
          },
        ) =>
          Object.assign(Object.create(prototype), event, methods) as
            ReactKeyboardEvent<HTMLElement>;
        const setCurrentTarget = (
          event: ReactKeyboardEvent<HTMLElement>,
          currentTarget: HTMLElement,
        ) => {
          if (!Reflect.set(event, "currentTarget", currentTarget)) {
            throw new Error("Unable to set the test wrapper currentTarget");
          }
        };
        let captureWrapper: ReactKeyboardEvent<HTMLElement> | null = null;
        let bubbleWrapper: ReactKeyboardEvent<HTMLElement> | null = null;
        const boundaries: {
          name: string;
          wrapper: object;
          preventDefault: () => void;
          isDefaultPrevented: () => boolean;
          isPropagationStopped: () => boolean;
          defaultPrevented: boolean;
          propagationStopped: boolean;
        }[] = [];
        const record = (
          name: string,
          event: ReactKeyboardEvent<HTMLElement>,
        ) => {
          boundaries.push({
            name,
            wrapper: event,
            preventDefault: event.preventDefault,
            isDefaultPrevented: event.isDefaultPrevented,
            isPropagationStopped: event.isPropagationStopped,
            defaultPrevented: event.isDefaultPrevented(),
            propagationStopped: event.isPropagationStopped(),
          });
        };
        const restoreRoot = replaceReactProps(root, {
          onKeyDownCapture: (event: ReactKeyboardEvent<HTMLDivElement>) => {
            captureWrapper = createWrapper(
              event,
              capturePrototype,
              {
                preventDefault: capturePreventDefault,
                isDefaultPrevented: captureIsDefaultPrevented,
                isPropagationStopped: captureIsPropagationStopped,
              },
            );
            setCurrentTarget(captureWrapper, root);
            record("root capture", captureWrapper);
            rootCapture(
              captureWrapper as ReactKeyboardEvent<HTMLDivElement>,
            );
          },
          onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
            if (!bubbleWrapper) {
              throw new Error("The bubble wrapper was not created");
            }
            setCurrentTarget(bubbleWrapper, root);
            record("root bubble", bubbleWrapper);
            rootBubble(
              bubbleWrapper as ReactKeyboardEvent<HTMLDivElement>,
            );
          },
        });
        const restoreOption = replaceReactProps(source, {
          onKeyDownCapture: (
            _event: ReactKeyboardEvent<HTMLButtonElement>,
          ) => {
            if (!captureWrapper) {
              throw new Error("The capture wrapper was not created");
            }
            setCurrentTarget(captureWrapper, source);
            record("option capture", captureWrapper);
            optionCapture(
              captureWrapper as ReactKeyboardEvent<HTMLButtonElement>,
            );
          },
          onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
            bubbleWrapper = createWrapper(
              event,
              bubblePrototype,
              {
                preventDefault: bubblePreventDefault,
                isDefaultPrevented: bubbleIsDefaultPrevented,
                isPropagationStopped: bubbleIsPropagationStopped,
              },
            );
            setCurrentTarget(bubbleWrapper, source);
            record("option bubble", bubbleWrapper);
            optionBubble(
              bubbleWrapper as ReactKeyboardEvent<HTMLButtonElement>,
            );
          },
        });
        const nativeEvent = fileDropKeyEvent(source, "ArrowRight");
        const currentTargetGetter = Object.getOwnPropertyDescriptor(
          ownerWindow.Event.prototype,
          "currentTarget",
        )?.get;
        const composedPath = ownerWindow.Event.prototype.composedPath;
        if (!currentTargetGetter) {
          throw new Error("Event.currentTarget has no intrinsic getter");
        }
        const nativeDelivery: {
          receiver?: EventTarget;
          currentTarget?: EventTarget | null;
          terminal?: EventTarget;
        } = {};
        const observe = function (this: EventTarget, event: Event) {
          if (event !== nativeEvent) return;
          nativeDelivery.receiver = this;
          nativeDelivery.currentTarget = Reflect.apply(
            currentTargetGetter,
            event,
            [],
          ) as EventTarget | null;
          nativeDelivery.terminal = Reflect.apply(
            composedPath,
            event,
            [],
          ).at(-1);
        };
        ownerWindow.addEventListener("keydown", observe, true);
        source.focus();
        focus.mockClear();

        try {
          act(() => source.dispatchEvent(nativeEvent));
        } finally {
          ownerWindow.removeEventListener("keydown", observe, true);
          restoreOption();
          restoreRoot();
        }

        expect(boundaries.map(({ name }) => name)).toEqual([
          "root capture",
          "option capture",
          "option bubble",
          "root bubble",
        ]);
        expect(boundaries[0]!.wrapper).toBe(boundaries[1]!.wrapper);
        expect(boundaries[2]!.wrapper).toBe(boundaries[3]!.wrapper);
        expect(boundaries[0]!.wrapper).not.toBe(boundaries[2]!.wrapper);
        expect(Object.getPrototypeOf(boundaries[0]!.wrapper)).toBe(
          capturePrototype,
        );
        expect(Object.getPrototypeOf(boundaries[2]!.wrapper)).toBe(
          bubblePrototype,
        );
        expect(boundaries[0]!.preventDefault).toBe(
          boundaries[1]!.preventDefault,
        );
        expect(boundaries[2]!.preventDefault).toBe(
          boundaries[3]!.preventDefault,
        );
        expect(boundaries[0]!.preventDefault).not.toBe(
          boundaries[2]!.preventDefault,
        );
        expect(boundaries[0]!.isDefaultPrevented).toBe(
          boundaries[1]!.isDefaultPrevented,
        );
        expect(boundaries[2]!.isDefaultPrevented).toBe(
          boundaries[3]!.isDefaultPrevented,
        );
        expect(boundaries[0]!.isDefaultPrevented).not.toBe(
          boundaries[2]!.isDefaultPrevented,
        );
        expect(boundaries[0]!.isPropagationStopped).toBe(
          boundaries[1]!.isPropagationStopped,
        );
        expect(boundaries[2]!.isPropagationStopped).toBe(
          boundaries[3]!.isPropagationStopped,
        );
        expect(boundaries[0]!.isPropagationStopped).not.toBe(
          boundaries[2]!.isPropagationStopped,
        );
        expect(
          boundaries.every(
            ({ defaultPrevented, propagationStopped }) =>
              !defaultPrevented && !propagationStopped,
          ),
        ).toBe(true);
        expect(nativeDelivery.receiver).toBe(nativeDelivery.currentTarget);
        expect(nativeDelivery.receiver).toBe(nativeDelivery.terminal);
        expect(capturePreventDefault).not.toHaveBeenCalled();
        expect(bubblePreventDefault).toHaveBeenCalledOnce();
        expect(bubblePreventDefault.mock.contexts[0]).toBe(bubbleWrapper);
        expect(nativeEvent.defaultPrevented).toBe(true);
        expect(bubbleWrapper?.defaultPrevented).toBe(true);
        expect(bubbleWrapper?.isDefaultPrevented()).toBe(true);
        expect(bubbleWrapper?.isPropagationStopped()).toBe(false);
        expect(options.insert).toHaveFocus();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expectNoFileDropAction(handlers);
      });

      it("exposes public cancellation to a same-root ancestor without fallback work", () => {
        const preventDefault = vi.spyOn(
          Event.prototype,
          "preventDefault",
        );
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const fallback = vi.fn();
        const observed: Array<{
          defaultPrevented: boolean;
          isDefaultPrevented: boolean;
        }> = [];
        const handlers = callbacks();
        renderDirect(
          <StrictMode>
            <div
              onKeyDown={(event) => {
                const cancellation = {
                  defaultPrevented: event.defaultPrevented,
                  isDefaultPrevented: event.isDefaultPrevented(),
                };
                observed.push(cancellation);
                if (
                  !cancellation.defaultPrevented ||
                  !cancellation.isDefaultPrevented
                ) {
                  fallback();
                }
              }}
            >
              <FileDropDialog
                {...propsFor(
                  dropped("same-root-cancellation.md", 12),
                  handlers,
                )}
              />
            </div>
          </StrictMode>,
        );
        const options = fileDropOptions();
        const scroll = { x: window.scrollX, y: window.scrollY };
        options.replace.focus();
        preventDefault.mockClear();
        focus.mockClear();

        const event = dispatchFileDropKey(
          options.replace,
          "ArrowRight",
        );

        expect(event.defaultPrevented).toBe(true);
        expect(observed).toEqual([
          {
            defaultPrevented: true,
            isDefaultPrevented: true,
          },
        ]);
        expect(fallback).not.toHaveBeenCalled();
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(focus.mock.contexts[0]).toBe(options.insert);
        expect(options.insert).toHaveFocus();
        expect({ x: window.scrollX, y: window.scrollY }).toEqual(
          scroll,
        );
        expectNoFileDropAction(handlers);
      });

      it.each([
        ["capture", "preventDefault"],
        ["capture", "isDefaultPrevented"],
        ["capture", "isPropagationStopped"],
        ["bubble", "preventDefault"],
        ["bubble", "isDefaultPrevented"],
        ["bubble", "isPropagationStopped"],
      ] as const)(
        "rejects %s wrapper %s identity drift before clean recovery",
        (phase, method) => {
          const preventDefault = vi.spyOn(
            Event.prototype,
            "preventDefault",
          );
          const focus = vi.spyOn(HTMLElement.prototype, "focus");
          const handlers = callbacks();
          renderStrict(propsFor(dropped(`method-${phase}-${method}.md`, 0), handlers));
          const options = fileDropOptions();
          const source = options.replace;
          const root = screen.getByTestId("file-drop-dialog");
          const element = phase === "capture" ? source : root;
          const property =
            phase === "capture" ? "onKeyDownCapture" : "onKeyDown";
          const original = reactProp<
            (event: ReactKeyboardEvent<HTMLElement>) => void
          >(element, property);
          const restore = replaceReactProps(element, {
            [property]: (event: ReactKeyboardEvent<HTMLElement>) => {
              Object.defineProperty(event, method, {
                configurable: true,
                value: () => false,
              });
              original(event);
            },
          });
          source.focus();
          preventDefault.mockClear();
          focus.mockClear();

          const rejected = dispatchFileDropKey(source, "ArrowRight");
          restore();

          expect(rejected.defaultPrevented).toBe(false);
          expect(preventDefault).not.toHaveBeenCalled();
          expect(focus).not.toHaveBeenCalled();
          expect(source).toHaveFocus();
          expectNoFileDropAction(handlers);

          const accepted = dispatchFileDropKey(source, "ArrowRight");
          expect(accepted.defaultPrevented).toBe(true);
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(focus).toHaveBeenCalledExactlyOnceWith({
            preventScroll: true,
          });
          expect(options.insert).toHaveFocus();
          expectNoFileDropAction(handlers);
        },
      );

      it.each(["present", "absent", "mutated"] as const)(
        "does not use %s private React metadata for keyboard authority",
        (state) => {
          const focus = vi.spyOn(HTMLElement.prototype, "focus");
          const handlers = callbacks();
          renderStrict(propsFor(dropped(`private-${state}.md`, 0), handlers));
          const options = fileDropOptions();
          const source = options.replace;
          const root = screen.getByTestId("file-drop-dialog");
          const original = reactProp<
            (event: ReactKeyboardEvent<HTMLDivElement>) => void
          >(root, "onKeyDownCapture");
          const restore = replaceReactProps(root, {
            onKeyDownCapture: (
              event: ReactKeyboardEvent<HTMLDivElement>,
            ) => {
              const wrapper = event as ReactKeyboardEvent<HTMLDivElement> & {
                _reactName?: unknown;
              };
              if (state === "absent") {
                expect(Reflect.deleteProperty(wrapper, "_reactName")).toBe(
                  true,
                );
              } else {
                wrapper._reactName =
                  state === "present" ? "onKeyDown" : "not-keyboard";
              }
              original(event);
            },
          });
          source.focus();
          focus.mockClear();

          try {
            expect(
              dispatchFileDropKey(source, "ArrowRight").defaultPrevented,
            ).toBe(true);
          } finally {
            restore();
          }
          expect(options.insert).toHaveFocus();
          expect(focus).toHaveBeenCalledExactlyOnceWith({
            preventScroll: true,
          });
          expectNoFileDropAction(handlers);
        },
      );

      it("rejects a structural Window terminal and then accepts a clean delivery", () => {
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const handlers = callbacks();
        renderStrict(propsFor(dropped("structural-window.md", 0), handlers));
        const options = fileDropOptions();
        const source = options.replace;
        const ownerWindow = source.ownerDocument.defaultView;
        if (!ownerWindow) throw new Error("The option has no owner window");
        const structural = Object.create(
          ownerWindow.Window.prototype,
        ) as EventTarget;
        Object.defineProperties(structural, {
          document: { value: source.ownerDocument },
          Window: { value: ownerWindow.Window },
          Event: { value: ownerWindow.Event },
          EventTarget: { value: ownerWindow.EventTarget },
          KeyboardEvent: { value: ownerWindow.KeyboardEvent },
          Node: { value: ownerWindow.Node },
          Object: { value: ownerWindow.Object },
          Reflect: { value: ownerWindow.Reflect },
          UIEvent: { value: ownerWindow.UIEvent },
          window: { value: structural },
          self: { value: structural },
        });
        const rejected = fileDropKeyEvent(source, "ArrowRight");
        const observation: {
          receiver?: EventTarget;
          currentTarget?: EventTarget | null;
          originalTerminal?: EventTarget;
        } = {};
        const stage = function (this: EventTarget, event: Event) {
          if (event !== rejected) return;
          observation.receiver = this;
          observation.currentTarget = event.currentTarget;
          observation.originalTerminal = event.composedPath().at(-1);
          replaceFileDropPathTerminal(event, structural);
        };
        ownerWindow.addEventListener("keydown", stage, {
          capture: true,
          once: true,
        });
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();

        act(() => source.dispatchEvent(rejected));

        expect(observation.receiver).toBe(observation.currentTarget);
        expect(observation.receiver).toBe(observation.originalTerminal);
        expect(observation.receiver).not.toBe(structural);
        expect(rejected.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(source).toHaveFocus();
        expectNoFileDropAction(handlers);

        const accepted = dispatchFileDropKey(source, "ArrowRight");
        expect(accepted.defaultPrevented).toBe(true);
        expect(options.insert).toHaveFocus();
      });

      it("rejects modified, repeated, composing, canceled, stopped, untrusted, unsupported, and wrong-focus input", () => {
        const nativePreventDefault = Event.prototype.preventDefault;
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const handlers = callbacks();
        renderStrict(propsFor(dropped("rejected-input.md", 0), handlers));
        const options = fileDropOptions();
        const source = options.replace;
        const rejected = [
          fileDropKeyEvent(source, "PageDown"),
          fileDropKeyEvent(source, "ArrowRight", { altKey: true }),
          fileDropKeyEvent(source, "ArrowRight", { ctrlKey: true }),
          fileDropKeyEvent(source, "ArrowRight", { metaKey: true }),
          fileDropKeyEvent(source, "ArrowRight", { shiftKey: true }),
          fileDropKeyEvent(source, "ArrowRight", { repeat: true }),
          fileDropKeyEvent(source, "ArrowRight", { isComposing: true }),
          fileDropKeyEvent(source, "ArrowRight", { bubbles: false }),
          fileDropKeyEvent(source, "ArrowRight", { cancelable: false }),
          fileDropKeyEvent(source, "ArrowRight", {}, false),
        ];
        for (const event of rejected) {
          source.focus();
          preventDefault.mockClear();
          focus.mockClear();
          dispatchFileDropKey(source, event);
          expect(event.defaultPrevented).toBe(false);
          expect(preventDefault).not.toHaveBeenCalled();
          expect(focus).not.toHaveBeenCalled();
          expect(source).toHaveFocus();
        }

        const canceled = fileDropKeyEvent(source, "ArrowRight");
        Reflect.apply(nativePreventDefault, canceled, []);
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();
        dispatchFileDropKey(source, canceled);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();

        const stopped = fileDropKeyEvent(source, "ArrowRight");
        stopped.stopPropagation();
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();
        dispatchFileDropKey(source, stopped);
        expect(stopped.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();

        const otherFocus = closeButton();
        otherFocus.focus();
        preventDefault.mockClear();
        focus.mockClear();
        const unfocused = dispatchFileDropKey(source, "ArrowRight");
        expect(unfocused.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(otherFocus).toHaveFocus();
        expectNoFileDropAction(handlers);

        source.focus();
        preventDefault.mockClear();
        focus.mockClear();
        const accepted = dispatchFileDropKey(source, "ArrowRight");
        expect(accepted.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(options.insert).toHaveFocus();
        expectNoFileDropAction(handlers);
      });

      it("rejects fabricated, proxied, crossed, and foreign React/native deliveries before recovery", () => {
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const handlers = callbacks();
        renderStrict(propsFor(dropped("delivery-integrity.md", 0), handlers));
        const options = fileDropOptions();
        const source = options.replace;
        const handler = reactProp<OptionKeyHandler>(source, "onKeyDown");
        const fabricatedPreventDefault = vi.fn();
        handler({
          type: "keydown",
          key: "ArrowRight",
          currentTarget: source,
          target: source,
          preventDefault: fabricatedPreventDefault,
        } as unknown as ReactKeyboardEvent<HTMLButtonElement>);
        expect(fabricatedPreventDefault).not.toHaveBeenCalled();

        const proxied = fileDropKeyEvent(source, "ArrowRight");
        const restoreProxy = replaceReactProps(source, {
          onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) =>
            handler(
              new Proxy(event, {
                get(target, property, receiver) {
                  return Reflect.get(target, property, receiver);
                },
              }),
            ),
        });
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();
        dispatchFileDropKey(source, proxied);
        restoreProxy();
        expect(proxied.defaultPrevented).toBe(false);

        const crossedNative = fileDropKeyEvent(source, "ArrowRight");
        const crossedDelivery = fileDropKeyEvent(source, "ArrowRight");
        const restoreCrossed = replaceReactProps(source, {
          onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) =>
            handler(
              new Proxy(event, {
                get(target, property, receiver) {
                  return property === "nativeEvent"
                    ? crossedNative
                    : Reflect.get(target, property, receiver);
                },
              }),
            ),
        });
        dispatchFileDropKey(source, crossedDelivery);
        restoreCrossed();
        expect(crossedDelivery.defaultPrevented).toBe(false);

        const frame = document.createElement("iframe");
        document.body.append(frame);
        try {
          const foreignWindow = frame.contentWindow as
            | (Window & typeof globalThis)
            | null;
          if (!foreignWindow) throw new Error("The foreign window was not created");
          const foreignEvent = new foreignWindow.KeyboardEvent("keydown", {
            key: "ArrowRight",
            code: "ArrowRight",
            bubbles: true,
            cancelable: true,
          });
          markFileDropEventTrusted(foreignEvent);
          const localDelivery = fileDropKeyEvent(source, "ArrowRight");
          const restoreForeign = replaceReactProps(source, {
            onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) =>
              handler(
                new Proxy(event, {
                  get(target, property, receiver) {
                    return property === "nativeEvent"
                      ? foreignEvent
                      : Reflect.get(target, property, receiver);
                  },
                }),
              ),
          });
          dispatchFileDropKey(source, localDelivery);
          restoreForeign();
          expect(localDelivery.defaultPrevented).toBe(false);
        } finally {
          frame.remove();
        }

        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(source).toHaveFocus();
        expectNoFileDropAction(handlers);

        const accepted = dispatchFileDropKey(source, "ArrowRight");
        expect(accepted.defaultPrevented).toBe(true);
        expect(options.insert).toHaveFocus();
      });

      it("permanently rejects restored DOM history and accepts a distinct clean successor", () => {
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const pending = dropped("restored-dom.md", 0);
        const firstHandlers = callbacks();
        const view = renderStrict(propsFor(pending, firstHandlers));
        const stale = fileDropOptions();
        const root = screen.getByTestId("file-drop-dialog");
        const parent = root.parentNode;
        if (!parent) throw new Error("The options root has no parent");
        const className = stale.replace.className;
        stale.replace.className = "mutated";
        stale.replace.className = className;
        root.remove();
        parent.append(root);
        root.insertBefore(stale.insert, stale.replace);
        root.insertBefore(stale.replace, stale.insert);
        stale.replace.focus();
        preventDefault.mockClear();
        focus.mockClear();

        const rejected = dispatchFileDropKey(stale.replace, "ArrowRight");

        expect(rejected.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(stale.replace).toHaveFocus();
        expectNoFileDropAction(firstHandlers);

        const secondHandlers = callbacks();
        act(() =>
          view.root.render(
            <StrictMode>
              <FileDropDialog {...propsFor(pending, secondHandlers)} />
            </StrictMode>,
          ),
        );
        const current = fileDropOptions();
        current.replace.focus();
        preventDefault.mockClear();
        focus.mockClear();
        const accepted = dispatchFileDropKey(current.replace, "ArrowRight");
        expect(accepted.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(current.insert).toHaveFocus();
        expectNoFileDropAction(secondHandlers);
      });

      it("rejects stale facts and an already consumed native event while a clean successor remains usable", () => {
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const pending = dropped("stale-navigation.md", 18);
        const firstHandlers = callbacks();
        const view = renderStrict(propsFor(pending, firstHandlers));
        const stale = fileDropOptions();
        const staleHandler = reactProp<OptionKeyHandler>(
          stale.replace,
          "onKeyDown",
        );
        const secondHandlers = callbacks();
        act(() =>
          view.root.render(
            <StrictMode>
              <FileDropDialog {...propsFor(pending, secondHandlers)} />
            </StrictMode>,
          ),
        );
        const current = fileDropOptions();
        const restore = replaceReactProps(current.replace, {
          onKeyDown: staleHandler,
        });
        current.replace.focus();
        preventDefault.mockClear();
        focus.mockClear();
        const staleEvent = dispatchFileDropKey(
          current.replace,
          "ArrowRight",
        );
        restore();
        expect(staleEvent.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();

        const accepted = fileDropKeyEvent(current.replace, "ArrowRight");
        dispatchFileDropKey(current.replace, accepted);
        expect(accepted.defaultPrevented).toBe(true);
        expect(current.insert).toHaveFocus();
        const focusCount = focus.mock.calls.length;
        dispatchFileDropKey(current.insert, accepted);
        expect(focus).toHaveBeenCalledTimes(focusCount);
        expect(current.insert).toHaveFocus();
        expectNoFileDropAction(firstHandlers);
        expectNoFileDropAction(secondHandlers);

        const recovered = dispatchFileDropKey(current.insert, "ArrowRight");
        expect(recovered.defaultPrevented).toBe(true);
        expect(current.new).toHaveFocus();
      });

      it("claims navigation before focus reentrancy and removes its exact Window listener on cleanup", () => {
        const active = new Set<EventListenerOrEventListenerObject>();
        const add = window.addEventListener.bind(window);
        const remove = window.removeEventListener.bind(window);
        vi.spyOn(window, "addEventListener").mockImplementation(
          (type, listener, options) => {
            if (type === "keydown" && listener) active.add(listener);
            add(type, listener, options);
          },
        );
        vi.spyOn(window, "removeEventListener").mockImplementation(
          (type, listener, options) => {
            if (type === "keydown" && listener) active.delete(listener);
            remove(type, listener, options);
          },
        );
        const nativeFocus = HTMLElement.prototype.focus;
        const focus = vi
          .spyOn(HTMLElement.prototype, "focus")
          .mockImplementation(function (
            this: HTMLElement,
            options?: FocusOptions,
          ) {
            Reflect.apply(nativeFocus, this, [options]);
            if (
              this instanceof HTMLButtonElement &&
              this.dataset.testid === "file-drop-insert"
            ) {
              this.dispatchEvent(
                fileDropKeyEvent(this, "ArrowRight"),
              );
            }
          });
        const handlers = callbacks();
        const view = renderStrict(propsFor(dropped("reentrant.md", 0), handlers));
        const options = fileDropOptions();
        expect(active.size).toBe(1);
        options.replace.focus();
        focus.mockClear();

        const event = dispatchFileDropKey(options.replace, "ArrowRight");

        expect(event.defaultPrevented).toBe(true);
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(options.insert).toHaveFocus();
        expectNoFileDropAction(handlers);

        const staleHandler = reactProp<OptionKeyHandler>(
          options.replace,
          "onKeyDown",
        );
        act(() => view.root.render(null));
        expect(active.size).toBe(0);
        const fabricatedPreventDefault = vi.fn();
        staleHandler({
          type: "keydown",
          key: "ArrowRight",
          currentTarget: options.replace,
          target: options.replace,
          preventDefault: fabricatedPreventDefault,
        } as unknown as ReactKeyboardEvent<HTMLButtonElement>);
        expect(fabricatedPreventDefault).not.toHaveBeenCalled();
        expectNoFileDropAction(handlers);
      });

      it("invalidates listener method drift until a clean publication is created", () => {
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const pending = dropped("listener-method.md", 0);
        const firstHandlers = callbacks();
        const view = renderStrict(propsFor(pending, firstHandlers));
        let options = fileDropOptions();
        const addSpy = vi.spyOn(window, "addEventListener");
        options.replace.focus();
        preventDefault.mockClear();
        focus.mockClear();

        const rejected = dispatchFileDropKey(options.replace, "ArrowRight");
        addSpy.mockRestore();

        expect(rejected.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(options.replace).toHaveFocus();
        expectNoFileDropAction(firstHandlers);

        const stillRejected = dispatchFileDropKey(
          options.replace,
          "ArrowRight",
        );
        expect(stillRejected.defaultPrevented).toBe(false);

        const secondHandlers = callbacks();
        act(() =>
          view.root.render(
            <StrictMode>
              <FileDropDialog {...propsFor(pending, secondHandlers)} />
            </StrictMode>,
          ),
        );
        options = fileDropOptions();
        options.replace.focus();
        preventDefault.mockClear();
        focus.mockClear();
        const accepted = dispatchFileDropKey(options.replace, "ArrowRight");
        expect(accepted.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(options.insert).toHaveFocus();
        expectNoFileDropAction(secondHandlers);
      });

      it("retains pointer activation and leaves Enter, Space, and Tab native until activation", async () => {
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const handlers = callbacks();
        renderStrict(propsFor(dropped("retained-activation.md", 22), handlers));
        const options = fileDropOptions();
        expect([options.replace, options.insert, options.new].map(
          (option) => option.tabIndex,
        )).toEqual([0, 0, 0]);
        options.insert.focus();
        preventDefault.mockClear();
        focus.mockClear();

        for (const key of ["Enter", " ", "Tab"]) {
          const event = dispatchFileDropKey(options.insert, key);
          expect(event.defaultPrevented).toBe(false);
        }
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expectNoFileDropAction(handlers);

        fireEvent.click(options.insert);
        expect(ControlledFileReader.reads).toHaveLength(1);
        await resolveRead(0, "Keyboard activation retained");
        expect(handlers.onInsert).toHaveBeenCalledExactlyOnceWith(
          "Keyboard activation retained",
          22,
        );
        expect(handlers.onClose).toHaveBeenCalledOnce();
      });
    });

  it("rejects a synthetic-looking click without the exact dispatched native event", () => {
    const handlers = callbacks();
    renderStrict(
      propsFor(dropped("strict-fabricated-native.md", 0), handlers),
    );
    const option = captureOption("replace");
    setReactProp<OptionHandler>(option.element, "onClick", (event) => {
      option.onClick(
        cloneSyntheticClick(event, {
          nativeEvent: new MouseEvent("click", {
            bubbles: true,
            button: 0,
          }),
        }),
      );
    });

    activate(option);

    expect(ControlledFileReader.reads).toHaveLength(0);
    expect(uploadImportFiles).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

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
