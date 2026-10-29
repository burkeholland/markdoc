// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import type { FailedImport, ImportedDocument, ImportBatch } from "@/lib/import-upload";

const uploadImportBatch = vi.fn();
vi.mock("@/lib/import-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/import-upload")>()),
  uploadImportBatch: (...args: unknown[]) => uploadImportBatch(...args),
}));

import { ApiError } from "@/lib/api";
import { ImportDialog, type ImportItem, shouldOpenImported, useFileImport } from "./import-dialog";

function Harness({
  label = "Import",
  batches,
  onError,
  onDone,
  captureStart,
  captureRetry,
  captureResultLayout,
  onDialogOpenChange,
}: {
  label?: string;
  batches: File[][];
  onError: (message: string) => void;
  onDone?: (documents: ImportedDocument[], failed: FailedImport[]) => void;
  captureStart?: (start: ReturnType<typeof useFileImport>["start"]) => void;
  captureRetry?: (retry: (() => void) | undefined) => void;
  captureResultLayout?: () => void;
  onDialogOpenChange?: (open: boolean) => void;
}) {
  const { items, ignored, open, setOpen, start, input } = useFileImport({ onError, onDone });
  captureStart?.(start);
  captureRetry?.(items.find((item) => item.retry)?.retry);
  return (
    <>
      {input}
      {batches.map((batch, index) => (
        <button key={index} type="button" onClick={() => void start(batch)}>
          {label} batch {index + 1}
        </button>
      ))}
      <ImportDialog
        open={open}
        onOpenChange={
          onDialogOpenChange
            ? (next) => {
                onDialogOpenChange(next);
                setOpen(next);
              }
            : setOpen
        }
        items={items}
        ignored={ignored}
        footer={
          captureResultLayout &&
          items.some((item) => item.status !== "uploading") ? (
            <ResultLayoutCapture capture={() => captureResultLayout()}>
              {null}
            </ResultLayoutCapture>
          ) : undefined
        }
      />
    </>
  );
}

function ImportLayoutBoundary({
  boundary = 0,
  onBoundary,
  children,
}: {
  boundary?: number;
  onBoundary?: () => void;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return children;
}

function PassiveCleanupProbe({ onCleanup }: { onCleanup: () => void }) {
  useEffect(() => onCleanup, [onCleanup]);
  return null;
}

function ResultLayoutCapture({
  capture,
  children,
}: {
  capture: () => void;
  children: ReactNode;
}) {
  useLayoutEffect(capture, [capture]);
  return children;
}

interface ResultMouseEvent<T extends HTMLElement> {
  type: string;
  currentTarget: T;
  target: EventTarget;
  defaultPrevented: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  nativeEvent: unknown;
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
}

type ResultClick<T extends HTMLElement> = (event: ResultMouseEvent<T>) => void;

interface CapturedResultControl<T extends HTMLElement> {
  element: T;
  onClick: ResultClick<T>;
}

function reactProp<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const value = props?.[name];
  if (typeof value !== "function") throw new Error(`${name} was not attached to ${element.tagName}`);
  return value as T;
}

function captureResultOpen(index = 0): CapturedResultControl<HTMLAnchorElement> {
  const element = screen.getAllByTestId("import-open")[index] as HTMLAnchorElement | undefined;
  if (!element) throw new Error(`Open control ${index} was not rendered`);
  return { element, onClick: reactProp<ResultClick<HTMLAnchorElement>>(element, "onClick") };
}

function captureResultRowRetry(index = 0): CapturedResultControl<HTMLButtonElement> {
  const element = screen.getAllByTestId("import-row-retry")[index] as HTMLButtonElement | undefined;
  if (!element) throw new Error(`Row Retry control ${index} was not rendered`);
  return { element, onClick: reactProp<ResultClick<HTMLButtonElement>>(element, "onClick") };
}

interface ResultEventOverrides {
  type?: string;
  target?: EventTarget;
  nativeEvent?: unknown;
  nativeType?: string;
  nativeTarget?: HTMLElement;
}

function resultNativeMouseEvent(target: HTMLElement, type = "click"): MouseEvent {
  const MouseEventConstructor = target.ownerDocument.defaultView?.MouseEvent;
  if (!MouseEventConstructor) throw new Error("The result control has no owner-document MouseEvent");
  const event = new MouseEventConstructor(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function invokeResultControl<T extends HTMLElement>(
  control: CapturedResultControl<T>,
  currentTarget: T = control.element,
  overrides: ResultEventOverrides = {},
): ResultMouseEvent<T> {
  const nativeEvent =
    overrides.nativeEvent ?? resultNativeMouseEvent(overrides.nativeTarget ?? currentTarget, overrides.nativeType);
  const event: ResultMouseEvent<T> = {
    type: overrides.type ?? "click",
    currentTarget,
    target: overrides.target ?? currentTarget,
    defaultPrevented: false,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    nativeEvent,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  control.onClick(event);
  return event;
}

function resultItems(retry: () => void): ImportItem[] {
  return [
    {
      name: "first.md ",
      status: "done",
      id: "doc-first",
      title: "First",
      warnings: ["First warning"],
    },
    {
      name: "second.md",
      status: "error",
      warnings: [],
      error: "Second failed",
      retry,
    },
  ];
}

function expectImportError(row: HTMLElement, error: string) {
  const messages = row.querySelectorAll("div.text-red-600");
  expect(messages).toHaveLength(1);
  const message = messages[0];
  expect(message.tagName).toBe("DIV");
  expect(Array.from(message.attributes, ({ name, value }) => [name, value])).toEqual([
    ["class", "mt-0.5 text-xs text-red-600 wrap-anywhere"],
  ]);
  expect(message.textContent).toBe(error);
  expect(message.childNodes).toHaveLength(1);
  expect(message.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  expect(message.childElementCount).toBe(0);
  expect(message.parentElement).toBe(row.children[1]);
  expect(message.previousElementSibling).toBe(row.children[1].firstElementChild);
  return message;
}

const WINDOW_DRAG_TYPES = ["dragenter", "dragover", "dragleave", "drop"] as const;
type WindowDragType = (typeof WINDOW_DRAG_TYPES)[number];

function DragHarness({
  instance,
  onError,
  onDone,
}: {
  instance: string;
  onError: (message: string) => void;
  onDone?: (documents: ImportedDocument[], failed: FailedImport[]) => void;
}) {
  const { items, ignored, open, setOpen, dragging, pick, input } = useFileImport({ onError, onDone });
  return (
    <>
      <output data-testid={`dragging-${instance}`} data-active={dragging} />
      <button type="button" onClick={pick}>
        {instance} pick
      </button>
      {input}
      <ImportDialog open={open} onOpenChange={setOpen} items={items} ignored={ignored} />
    </>
  );
}

function DragImportBoundary({
  instance,
  present = true,
  boundary = 0,
  onBoundary,
  onError,
  onDone,
}: {
  instance: string;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onError: (message: string) => void;
  onDone?: (documents: ImportedDocument[], failed: FailedImport[]) => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <DragHarness key={instance} instance={instance} onError={onError} onDone={onDone} /> : null;
}

function trackWindowDragListeners() {
  const active: Record<WindowDragType, Set<EventListenerOrEventListenerObject>> = {
    dragenter: new Set(),
    dragover: new Set(),
    dragleave: new Set(),
    drop: new Set(),
  };
  const added: Record<WindowDragType, EventListenerOrEventListenerObject[]> = {
    dragenter: [],
    dragover: [],
    dragleave: [],
    drop: [],
  };
  const removed: Record<WindowDragType, EventListenerOrEventListenerObject[]> = {
    dragenter: [],
    dragover: [],
    dragleave: [],
    drop: [],
  };
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  const isDragType = (type: string): type is WindowDragType =>
    WINDOW_DRAG_TYPES.includes(type as WindowDragType);

  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    if (isDragType(type)) {
      active[type].add(listener);
      added[type].push(listener);
    }
    add(type, listener, options);
  });
  vi.spyOn(window, "removeEventListener").mockImplementation((type, listener, options) => {
    if (isDragType(type)) {
      active[type].delete(listener);
      removed[type].push(listener);
    }
    remove(type, listener, options);
  });

  return { active, added, removed };
}

type DragListenerTracker = ReturnType<typeof trackWindowDragListeners>;
type CapturedDragOwner = Record<WindowDragType, EventListener>;

function captureDragOwner(tracker: DragListenerTracker, index: number): CapturedDragOwner {
  const listener = (type: WindowDragType) => {
    const captured = tracker.added[type][index];
    if (typeof captured !== "function") throw new Error(`Missing ${type} listener at index ${index}`);
    return captured;
  };
  return {
    dragenter: listener("dragenter"),
    dragover: listener("dragover"),
    dragleave: listener("dragleave"),
    drop: listener("drop"),
  };
}

function trackedDragEvent(type: WindowDragType, files: File[] = [], hasFiles = true) {
  const preventDefault = vi.fn();
  const dropEffectWrites: string[] = [];
  let dropEffect = "none";
  const dataTransfer = {
    types: hasFiles ? ["Files"] : ["text/plain"],
    files,
    get dropEffect() {
      return dropEffect;
    },
    set dropEffect(value: string) {
      dropEffect = value;
      dropEffectWrites.push(value);
    },
  } as unknown as DataTransfer;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    preventDefault: { value: preventDefault },
  });
  return { event: event as DragEvent, preventDefault, dropEffectWrites };
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

function invokeAsyncRetry(retry: () => void): Promise<void> {
  return (retry as unknown as () => Promise<void>)();
}

async function rejectedValue(promise: Promise<void>): Promise<{ rejected: boolean; value?: unknown }> {
  try {
    await promise;
    return { rejected: false };
  } catch (value) {
    return { rejected: true, value };
  }
}

function importDocumentResult(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-recovered",
    title: "Recovered",
    warnings: [],
    ...overrides,
  };
}

function failureResultWithAccessor(property: "index" | "name" | "error") {
  const failure: Record<string, unknown> = {
    index: 0,
    name: "failed.md",
    error: "Still failed",
  };
  const values = { index: 0, name: "failed.md", error: "Still failed" };
  Object.defineProperty(failure, property, {
    configurable: true,
    enumerable: true,
    get: () => values[property],
  });
  return { documents: [], failed: [failure] };
}

function failureResultWithChangingDescriptor(property: "index" | "name" | "error") {
  const failure: Record<string, unknown> = {
    index: 0,
    name: "failed.md",
    error: "Still failed",
  };
  const changed = { index: 1, name: "other.md", error: "Changed failure" };
  let reads = 0;
  const proxy = new Proxy(failure, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (!descriptor || key !== property || !("value" in descriptor)) return descriptor;
      reads++;
      return { ...descriptor, value: reads === 1 ? descriptor.value : changed[property] };
    },
  });
  return { documents: [], failed: [proxy] };
}

function dropFiles(files: File[]) {
  fireEvent.drop(window, { dataTransfer: { types: ["Files"], files } });
}

function dispatchDropFiles(files: File[]) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files } });
  window.dispatchEvent(event);
}

function dispatchPickedFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const unhandledRejections: unknown[] = [];
function recordUnhandledRejection(reason: unknown) {
  unhandledRejections.push(reason);
}

beforeEach(() => {
  uploadImportBatch.mockReset();
  unhandledRejections.length = 0;
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(() => {
  cleanup();
  process.off("unhandledRejection", recordUnhandledRejection);
  vi.restoreAllMocks();
});

describe("ImportDialog result hover labels", () => {
  function expectLabels(row: HTMLElement, primaryText: string, filename?: string) {
    const labels = row.querySelectorAll<HTMLSpanElement>("span.truncate");
    expect(labels).toHaveLength(filename === undefined ? 1 : 2);
    const primary = labels[0];
    if (!primary) throw new Error("The import row has no primary label");
    expect(primary.className).toBe("truncate text-sm text-ink");
    expect(primary.textContent).toBe(primaryText);
    expect(primary).toHaveAttribute("title", primaryText);
    if (filename !== undefined) {
      const secondary = labels[1];
      expect(secondary.className).toBe("truncate text-xs text-ink-4");
      expect(secondary.textContent).toBe(filename);
      expect(secondary).toHaveAttribute("title", filename);
    }
    for (const label of labels) {
      expect(label.childElementCount).toBe(0);
      expect(label).not.toHaveAttribute("tabindex");
      expect(label).not.toHaveAttribute("role");
    }
    return labels;
  }

  it.each([
    { kind: "absent", title: undefined, displayed: "notes.md", filename: undefined },
    { kind: "same as filename", title: "notes.md", displayed: "notes.md", filename: undefined },
    { kind: "empty", title: "", displayed: "", filename: undefined },
    { kind: "distinct", title: "Imported notes", displayed: "Imported notes", filename: "notes.md" },
  ])("matches displayed text for a $kind title without changing Open", ({ title, displayed, filename }) => {
    const onOpenChange = vi.fn();
    render(
      <ImportDialog
        open
        onOpenChange={onOpenChange}
        items={[{ name: "notes.md", title, status: "done", id: "notes", warnings: ["Kept warning"] }]}
        ignored={[]}
      />,
    );
    const row = screen.getByTestId("import-item");
    expectLabels(row, displayed, filename);
    expect(row.className).toBe("import-item");
    expect(row).toHaveAttribute("data-status", "done");
    expect(within(row).getByLabelText("Imported")).toHaveClass("text-emerald-600");
    expect(row.children[1].className).toBe("min-w-0 flex-1");
    expect(row.children[1].firstElementChild?.className).toBe("flex items-center gap-2");
    const warning = within(row).getByTestId("import-warning");
    expect(warning.className).toBe("import-warning wrap-anywhere");
    expect(warning.textContent).toBe(" Kept warning");
    const open = captureResultOpen();
    expect(open.element.tagName).toBe("A");
    expect(open.element.className).toBe("import-open");
    expect(open.element.textContent).toBe("Open");
    expect(open.element).toHaveAttribute("href", "/d/notes");
    for (let attempt = 0; attempt < 1; attempt++) {
      const event = invokeResultControl(open);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("keeps long title and filename labels literal and hover work-free after setup", () => {
    const title = '  <img src="x"> & "quoted" '.padEnd(198, "t") + "  ";
    const name = '<svg data-file="literal"> & '.padEnd(220, "f") + ".md";
    expect(title).toHaveLength(200);
    expect(name.length).toBeGreaterThanOrEqual(200);
    const onOpenChange = vi.fn();
    const retry = vi.fn();
    const retryAll = vi.fn();
    render(
      <ImportDialog
        open
        onOpenChange={onOpenChange}
        items={[
          { name, title, status: "done", id: "long-labels", warnings: [] },
          { name: "failed.md", status: "error", error: "Import failed", warnings: [], retry, retryAll },
        ]}
        ignored={[]}
      />,
    );
    const labels = expectLabels(screen.getAllByTestId("import-item")[0], title, name);
    expect(screen.queryByRole("tooltip")).toBeNull();
    const focusBefore = document.activeElement;
    const domBefore = document.body.innerHTML;
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected hover request"));
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    const microtask = vi.spyOn(globalThis, "queueMicrotask");
    const animationFrame = vi.spyOn(window, "requestAnimationFrame");

    // Stay synchronous: jsdom checks native title semantics, not tooltip paint or timing.
    for (const label of labels) {
      fireEvent.pointerOver(label);
      fireEvent.pointerMove(label);
      fireEvent.mouseOver(label);
      fireEvent.mouseMove(label);
      fireEvent.mouseOut(label);
      fireEvent.pointerOut(label);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(uploadImportBatch).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(retryAll).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    expect(microtask).not.toHaveBeenCalled();
    expect(animationFrame).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(focusBefore);
    expect(document.body.innerHTML).toBe(domBefore);
  });

  it("updates both labels and removes obsolete filenames when results change", () => {
    const onOpenChange = vi.fn();
    const item: ImportItem = {
      name: "original.md",
      title: "Original title",
      status: "done",
      id: "original",
      warnings: [],
    };
    const view = render(<ImportDialog open onOpenChange={onOpenChange} items={[item]} ignored={[]} />);
    const originalRow = screen.getByTestId("import-item");
    const originalLabel = expectLabels(originalRow, "Original title", "original.md")[0];
    for (const title of ["Updated title", "", "original.md", undefined]) {
      view.rerender(
        <ImportDialog open onOpenChange={onOpenChange} items={[{ ...item, title }]} ignored={[]} />,
      );
      const row = screen.getByTestId("import-item");
      expect(row).toBe(originalRow);
      expectLabels(row, title ?? item.name, title && title !== item.name ? item.name : undefined);
      expect(row.querySelector("span.truncate")).toBe(originalLabel);
    }
    view.rerender(
      <ImportDialog
        open
        onOpenChange={onOpenChange}
        items={[{ ...item, name: "replacement.md", title: "Replacement title", id: "replacement" }]}
        ignored={[]}
      />,
    );
    expectLabels(screen.getByTestId("import-item"), "Replacement title", "replacement.md");
    expect(originalRow).not.toBeInTheDocument();
    expect(screen.queryByTitle("Original title")).toBeNull();
    expect(screen.queryByTitle("original.md")).toBeNull();
    const open = captureResultOpen();
    expect(open.element).toHaveAttribute("href", "/d/replacement");
    expect(invokeResultControl(open).preventDefault).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("refreshes completion and retry labels with one request per row or batch retry", async () => {
    const first = new File(["# First"], "first.md", { type: "text/markdown" });
    const second = new File(["# Second"], "second.md", { type: "text/markdown" });
    const third = new File(["# Third"], "third.md", { type: "text/markdown" });
    const initial = deferred<ImportBatch>();
    const rowRetry = deferred<ImportBatch>();
    const batchRetry = deferred<ImportBatch>();
    const onDone = vi.fn();
    const onError = vi.fn();
    uploadImportBatch
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(rowRetry.promise)
      .mockReturnValueOnce(batchRetry.promise);
    render(
      <StrictMode>
        <Harness batches={[[first, second, third]]} onDone={onDone} onError={onError} />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
    expect(uploadImportBatch).toHaveBeenCalledExactlyOnceWith([first, second, third], [], expect.any(Function));
    for (const [index, row] of screen.getAllByTestId("import-item").entries()) {
      expectLabels(row, [first, second, third][index].name);
      expect(row).toHaveAttribute("data-status", "uploading");
      expect(within(row).getByLabelText("Importing")).toHaveClass("animate-spin", "text-ink-3");
    }
    await act(async () => {
      initial.resolve({
        documents: [{ id: "first", title: "First imported", warnings: ["First warning"] }],
        failed: [
          { index: 1, name: second.name, error: "s".repeat(300) },
          { index: 2, name: third.name, error: "Third failed" },
        ],
      });
    });
    const rows = screen.getAllByTestId("import-item");
    expectLabels(rows[0], "First imported", first.name);
    expectLabels(rows[1], second.name);
    expectLabels(rows[2], third.name);
    expect(within(rows[0]).getByTestId("import-warning").textContent).toBe(" First warning");
    expect(within(rows[1]).getByLabelText("Failed")).toHaveClass("text-red-600");
    const secondError = expectImportError(rows[1], "s".repeat(300));
    expectImportError(rows[2], "Third failed");
    const firstHtml = rows[0].outerHTML;
    const thirdDetails = rows[2].children[1].outerHTML;
    const retiredRetry = captureResultRowRetry();
    expect(onDone).toHaveBeenCalledOnce();
    const retry = within(rows[1]).getByRole("button", { name: "Retry second.md" });
    expect(retry.className).toBe("btn btn-sm btn-outline shrink-0");
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(uploadImportBatch).toHaveBeenCalledTimes(2);
    expect(uploadImportBatch).toHaveBeenNthCalledWith(2, [second], []);
    expectLabels(screen.getAllByTestId("import-item")[1], second.name);
    expect(screen.getAllByTestId("import-item")[1]).toHaveAttribute("data-status", "uploading");
    expect(secondError).not.toBeInTheDocument();
    expect(rows[1].querySelector("div.text-red-600")).toBeNull();
    expect(rows[0].outerHTML).toBe(firstHtml);
    expect(rows[2].children[1].outerHTML).toBe(thirdDetails);
    expect(screen.getByTestId("import-retry")).toBeDisabled();
    expect(within(rows[2]).getByTestId("import-row-retry")).toBeDisabled();
    await act(async () => {
      rowRetry.resolve({
        documents: [{ id: "second", title: "Second recovered", warnings: [] }],
        failed: [],
      });
    });
    const afterRowRetry = screen.getAllByTestId("import-item");
    expectLabels(afterRowRetry[0], "First imported", first.name);
    expectLabels(afterRowRetry[1], "Second recovered", second.name);
    expectLabels(afterRowRetry[2], third.name);
    expect(afterRowRetry[1]).toBe(rows[1]);
    expect(afterRowRetry[1].querySelector("div.text-red-600")).toBeNull();
    expect(afterRowRetry[0].outerHTML).toBe(firstHtml);
    expect(afterRowRetry[2].children[1].outerHTML).toBe(thirdDetails);
    invokeResultControl(retiredRetry);
    expect(uploadImportBatch).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledTimes(2);
    const retryAll = screen.getByRole("button", { name: "Retry failed" });
    expect(retryAll.className).toBe("btn btn-sm btn-outline mt-4");
    fireEvent.click(retryAll);
    fireEvent.click(retryAll);
    expect(uploadImportBatch).toHaveBeenCalledTimes(3);
    expect(uploadImportBatch).toHaveBeenNthCalledWith(3, [third], []);
    await act(async () => {
      batchRetry.resolve({
        documents: [{ id: "third", title: "Third recovered", warnings: [] }],
        failed: [],
      });
    });
    const completed = screen.getAllByTestId("import-item");
    expectLabels(completed[0], "First imported", first.name);
    expectLabels(completed[1], "Second recovered", second.name);
    expectLabels(completed[2], "Third recovered", third.name);
    expect(completed.map((row) => row.dataset.status)).toEqual(["done", "done", "done"]);
    expect(screen.getAllByTestId("import-open").map((link) => link.getAttribute("href"))).toEqual([
      "/d/first",
      "/d/second",
      "/d/third",
    ]);
    expect(screen.queryByTestId("import-row-retry")).toBeNull();
    expect(screen.queryByTestId("import-retry")).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();
    expect(uploadImportBatch).toHaveBeenCalledTimes(3);
  });
});

describe("ImportDialog failed-import reason wrapping", () => {
  it.each([
    { kind: "unbroken", error: "e".repeat(300) },
    { kind: "ordinary", error: "The document could not be imported. Please try again." },
    { kind: "literal HTML, quotes, and whitespace", error: ' \t<img src="x"><b>failed</b> & "quoted" \'reason\'\n  ' },
  ])("keeps $kind reasons in the existing rows without changing surrounding content", ({ kind, error }) => {
    if (kind === "unbroken") {
      expect(error.length).toBeGreaterThanOrEqual(240);
      expect(error).not.toMatch(/\s/);
    }
    const retry = vi.fn();
    const otherRetry = vi.fn();
    const retryAll = vi.fn();
    const onOpenChange = vi.fn();
    const [success, failed] = resultItems(retry);
    const items: ImportItem[] = [
      success,
      { ...failed, title: "Failed document", error, warnings: ["Kept warning"], retryAll },
      { name: "third.md", status: "error", error: "Another failure", warnings: [], retry: otherRetry, retryAll },
    ];
    const footer = <p data-testid="reason-footer">Unchanged footer</p>;
    render(<ImportDialog open onOpenChange={onOpenChange} items={items} ignored={["skipped.pdf"]} footer={footer} />);
    const rows = screen.getAllByTestId("import-item");
    expect(rows.map((row) => row.dataset.status)).toEqual(["done", "error", "error"]);
    expect(screen.getByTestId("import-list").children).toHaveLength(3);
    expect(rows[1].tagName).toBe("LI");
    expect(Array.from(rows[1].attributes, ({ name, value }) => [name, value])).toEqual([
      ["class", "import-item"], ["data-testid", "import-item"], ["data-status", "error"],
    ]);
    expect(Array.from(rows[1].children, (child) => child.tagName.toLowerCase())).toEqual(["svg", "div", "button"]);
    expect(within(rows[1]).getByLabelText("Failed")).toHaveClass("text-red-600");
    const details = rows[1].children[1];
    expect(details.className).toBe("min-w-0 flex-1");
    expect(details.children).toHaveLength(3);
    const labels = details.firstElementChild;
    expect(labels?.className).toBe("flex items-center gap-2");
    expect(labels?.children).toHaveLength(3);
    expect(within(rows[1]).getByTitle("Failed document").outerHTML).toBe(
      '<span class="truncate text-sm text-ink" title="Failed document">Failed document</span>',
    );
    expect(within(rows[1]).getByTitle(failed.name).outerHTML).toBe(
      '<span class="truncate text-xs text-ink-4" title="second.md">second.md</span>',
    );
    const message = expectImportError(rows[1], error);
    expectImportError(rows[2], "Another failure");
    expect(rows[0].querySelector("div.text-red-600")).toBeNull();
    const warning = within(rows[1]).getByTestId("import-warning");
    expect(warning).toBe(message.nextElementSibling);
    expect(warning.className).toBe("import-warning wrap-anywhere");
    expect(warning.textContent).toBe(" Kept warning");
    expect(warning.children).toHaveLength(1);
    expect(warning.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(screen.getAllByTestId("import-warning")).toHaveLength(2);
    expect(screen.getAllByTestId("import-row-retry")).toHaveLength(2);
    const rowRetry = within(rows[1]).getByRole("button", { name: "Retry second.md" });
    expect(rowRetry.className).toBe("btn btn-sm btn-outline shrink-0");
    expect(rowRetry).toHaveAttribute("type", "button");
    expect(rowRetry).toBeEnabled();
    expect(screen.getByTestId("import-retry").className).toBe("btn btn-sm btn-outline mt-4");
    expect(screen.getByTestId("import-retry")).toBeEnabled();
    expect(screen.getByTestId("import-dialog").querySelectorAll("button, a, input, textarea, select")).toHaveLength(4);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByTestId("import-dialog").querySelectorAll("img, b")).toHaveLength(0);
    expect(screen.getByTestId("import-ignored").textContent).toBe(
      "Skipped 1 file that is not Markdown, text, HTML or an image: skipped.pdf",
    );
    expect(screen.getByTestId("import-dialog").lastElementChild).toBe(screen.getByTestId("reason-footer"));
    const open = captureResultOpen();
    expect(open.element.outerHTML).toBe('<a class="import-open" data-testid="import-open" href="/d/doc-first">Open</a>');
    expect(invokeResultControl(open).preventDefault).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(retry).not.toHaveBeenCalled();
    expect(otherRetry).not.toHaveBeenCalled();
    expect(retryAll).not.toHaveBeenCalled();
    expect(uploadImportBatch).not.toHaveBeenCalled();
  });

  it("updates a same-key reason in place and omits null, undefined, or empty messages", () => {
    const retry = vi.fn();
    const onOpenChange = vi.fn();
    const [success, failed] = resultItems(retry);
    const renderItems = (item: ImportItem) => (
      <ImportDialog open onOpenChange={onOpenChange} items={[success, item]} ignored={[]} />
    );
    const view = render(renderItems(failed));
    const [neighbor, row] = screen.getAllByTestId("import-item");
    const neighborHtml = neighbor.outerHTML;
    const message = expectImportError(row, "Second failed");
    const originalShape = row.cloneNode(true);
    for (const error of ["r".repeat(300), ' \n<em title="literal">Different</em> & "quotes"\t ']) {
      view.rerender(renderItems({ ...failed, error }));
      expect(screen.getAllByTestId("import-item")[1]).toBe(row);
      expect(expectImportError(row, error)).toBe(message);
      if (!(originalShape instanceof HTMLElement)) throw new Error("Expected a cloned import row");
      const clonedMessage = originalShape.querySelector("div.text-red-600");
      if (!clonedMessage) throw new Error("Expected a cloned import reason");
      clonedMessage.textContent = error;
      expect(row.outerHTML).toBe(originalShape.outerHTML);
      expect(neighbor.outerHTML).toBe(neighborHtml);
    }
    for (const error of [undefined, "", null]) {
      const item = { ...failed };
      // Null is a runtime omission case, not an expansion of the typed import contract.
      Object.defineProperty(item, "error", { value: error });
      view.rerender(renderItems(item));
      expect(screen.getAllByTestId("import-item")[1]).toBe(row);
      expect(row.querySelector("div.text-red-600")).toBeNull();
      expect(row.children[1].children).toHaveLength(1);
      expect(row.children).toHaveLength(3);
      expect(neighbor.outerHTML).toBe(neighborHtml);
    }
    view.rerender(renderItems({ ...failed, error: "Current failure" }));
    expectImportError(row, "Current failure");
    const current = captureResultRowRetry();
    invokeResultControl(current);
    expect(retry).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(uploadImportBatch).not.toHaveBeenCalled();
  });

  it("keeps wrapped-reason pointer activity passive after settled setup", async () => {
    const retry = vi.fn();
    const onOpenChange = vi.fn();
    const items = resultItems(retry);
    items[1] = { ...items[1], error: "p".repeat(300) };
    render(<ImportDialog open onOpenChange={onOpenChange} items={items} ignored={[]} />);
    await act(async () => {});
    const message = expectImportError(screen.getAllByTestId("import-item")[1], "p".repeat(300));
    const domBefore = document.body.innerHTML;
    const activeBefore = document.activeElement;
    const spies = [
      vi.spyOn(globalThis, "fetch"),
      vi.spyOn(HTMLElement.prototype, "focus"),
      vi.spyOn(globalThis, "setTimeout"),
      vi.spyOn(globalThis, "setInterval"),
      vi.spyOn(globalThis, "queueMicrotask"),
      vi.spyOn(window, "requestAnimationFrame"),
    ];
    try {
      fireEvent.pointerOver(message);
      fireEvent.pointerMove(message);
      fireEvent.mouseOver(message);
      fireEvent.mouseMove(message);
      fireEvent.mouseOut(message);
      fireEvent.pointerOut(message);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(document.body.innerHTML).toBe(domBefore);
      expect(document.activeElement).toBe(activeBefore);
      expect(retry).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(uploadImportBatch).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("compiles the installed wrapping utility to overflow-wrap anywhere, not word-break all", async () => {
    const { compile } = await import("tailwindcss");
    const { build } = await compile("@tailwind utilities;");
    const css = build(["wrap-anywhere"]);
    expect(css).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
    expect(css).not.toMatch(/word-break:\s*break-all/);
  });
});

describe("ImportDialog asset warning wrapping", () => {
  const assetName = `${"asset".repeat(52)}.png`;
  const longWarning = `Could not import image "${assetName}": Unsupported image type.`;
  const ordinaryWarning = 'Could not import image "diagram.png": The image is too large.';
  const literalWarning = 'Could not import image "<img src=\'x\'><b>diagram</b>.png": Keep  "quotes"\tand\ninternal whitespace.';

  function expectWarnings(row: HTMLElement, expected: readonly string[]) {
    const warnings = within(row).queryAllByTestId("import-warning");
    expect(warnings).toHaveLength(expected.length);
    expect(warnings.map((warning) => warning.textContent)).toEqual(expected.map((text) => ` ${text}`));
    for (const [index, warning] of warnings.entries()) {
      expect(warning.tagName).toBe("DIV");
      expect(Array.from(warning.attributes, ({ name, value }) => [name, value])).toEqual([
        ["class", "import-warning wrap-anywhere"],
        ["data-testid", "import-warning"],
      ]);
      expect(warning.parentElement).toBe(row.children[1]);
      expect(warning.children).toHaveLength(1);
      expect(Array.from(warning.childNodes, (node) => node.nodeType)).toEqual([
        Node.ELEMENT_NODE, Node.TEXT_NODE, Node.TEXT_NODE,
      ]);
      expect(warning.childNodes[1].nodeValue).toBe(" ");
      expect(warning.childNodes[2].nodeValue).toBe(expected[index]);
      const icon = warning.firstElementChild;
      expect(icon?.tagName.toLowerCase()).toBe("svg");
      expect(icon).toHaveAttribute("width", "12");
      expect(icon).toHaveAttribute("height", "12");
      expect(icon).toHaveClass("shrink-0");
      expect(warning.querySelectorAll("svg")).toHaveLength(1);
      expect(warning.querySelectorAll("span, img, b, a, button, input, [tabindex], [role], [title]")).toHaveLength(0);
    }
    return warnings;
  }

  it.each([
    { kind: "long unbroken asset name", warning: longWarning },
    { kind: "ordinary asset failure", warning: ordinaryWarning },
    { kind: "literal HTML, quotes, and internal whitespace", warning: literalWarning },
  ])("preserves $kind warnings and their existing success and error row structure", ({ warning }) => {
    expect(assetName.length).toBeGreaterThanOrEqual(240);
    expect(assetName).not.toMatch(/\s/);
    expect(longWarning).toContain(assetName);
    const onOpenChange = vi.fn();
    const retry = vi.fn();
    const retryAll = vi.fn();
    const otherRetry = vi.fn();
    const [success, failed] = resultItems(retry);
    const warnings = [warning, ordinaryWarning];
    render(
      <ImportDialog
        open
        onOpenChange={onOpenChange}
        items={[
          { ...success, warnings },
          { ...failed, warnings: [warning], retryAll },
          { ...failed, name: "third.md", retry: otherRetry, retryAll },
        ]}
        ignored={["skipped.pdf"]}
        footer={<p data-testid="warning-footer">Unchanged footer</p>}
      />,
    );
    const rows = screen.getAllByTestId("import-item");
    expect(screen.getByTestId("import-list").children).toHaveLength(3);
    expect(rows.map((row) => row.dataset.status)).toEqual(["done", "error", "error"]);
    for (const [index, row] of rows.entries()) {
      expect(row.tagName).toBe("LI");
      expect(row.className).toBe("import-item");
      expect(Array.from(row.children, (child) => child.tagName.toLowerCase())).toEqual([
        "svg", "div", index === 0 ? "a" : "button",
      ]);
      expect(row.children[1].className).toBe("min-w-0 flex-1");
      expect(row.children[1].firstElementChild?.className).toBe("flex items-center gap-2");
      expect(row.children[1].children).toHaveLength(index === 2 ? 2 : 3);
    }
    expect(within(rows[0]).getByLabelText("Imported")).toHaveClass("text-emerald-600");
    expect(within(rows[1]).getByLabelText("Failed")).toHaveClass("text-red-600");
    const successWarnings = expectWarnings(rows[0], warnings);
    expect(successWarnings[0].previousElementSibling).toBe(rows[0].children[1].firstElementChild);
    expect(successWarnings[1].previousElementSibling).toBe(successWarnings[0]);
    expect(expectWarnings(rows[1], [warning])[0].previousElementSibling).toBe(expectImportError(rows[1], "Second failed"));
    expectWarnings(rows[2], []);
    expect(screen.getAllByTestId("import-warning")).toHaveLength(3);
    expect(screen.getByTestId("import-dialog").querySelectorAll("button, a, input, textarea, select")).toHaveLength(4);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByTestId("import-dialog").querySelectorAll("img, b")).toHaveLength(0);
    expect(screen.getByTestId("import-ignored").textContent).toBe(
      "Skipped 1 file that is not Markdown, text, HTML or an image: skipped.pdf",
    );
    expect(screen.getByTestId("import-dialog").lastElementChild).toBe(screen.getByTestId("warning-footer"));
    const open = captureResultOpen();
    const rowRetry = captureResultRowRetry();
    expect(open.element.outerHTML).toBe('<a class="import-open" data-testid="import-open" href="/d/doc-first">Open</a>');
    expect(rowRetry.element.className).toBe("btn btn-sm btn-outline shrink-0");
    expect(rowRetry.element).toHaveAttribute("type", "button");
    expect(rowRetry.element).toBeEnabled();
    expect(screen.getByTestId("import-retry").className).toBe("btn btn-sm btn-outline mt-4");
    for (let attempt = 0; attempt < 1; attempt++) {
      for (const event of [invokeResultControl(open), invokeResultControl(rowRetry)]) {
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.stopPropagation).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
      }
    }
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(retry).toHaveBeenCalledOnce();
    expect(otherRetry).not.toHaveBeenCalled();
    expect(retryAll).not.toHaveBeenCalled();
    expect(uploadImportBatch).not.toHaveBeenCalled();
  });

  it.each(["Strict", "ordinary"])("replaces and removes same-key warnings with repeated action recovery in %s mode", (mode) => {
    const onOpenChange = vi.fn();
    const retry = vi.fn();
    const [success, failed] = resultItems(retry);
    const neighbor = { ...success, name: "neighbor.md", id: "neighbor", warnings: [ordinaryWarning] };
    const dialog = (warnings: string[]) => {
      const content = (
        <ImportDialog
          open
          onOpenChange={onOpenChange}
          items={[{ ...success, warnings }, { ...failed, warnings }, neighbor]}
          ignored={[]}
        />
      );
      return mode === "Strict" ? <StrictMode>{content}</StrictMode> : content;
    };
    const view = render(dialog([longWarning, ordinaryWarning]));
    const root = screen.getByTestId("import-dialog");
    const rows = screen.getAllByTestId("import-item");
    const neighborHtml = rows[2].outerHTML;
    const neighborNodes = Array.from(rows[2].querySelectorAll("*"));
    const originalWarnings = rows.slice(0, 2).map((row) => expectWarnings(row, [longWarning, ordinaryWarning]));
    const retiredOpens = [captureResultOpen()];
    const retiredRetries = [captureResultRowRetry()];
    for (const [index, warnings] of [[literalWarning], [], [longWarning, ordinaryWarning]].entries()) {
      view.rerender(dialog(warnings));
      expect(screen.getByTestId("import-dialog")).toBe(root);
      const currentRows = screen.getAllByTestId("import-item");
      currentRows.forEach((row, rowIndex) => expect(row).toBe(rows[rowIndex]));
      expect(rows[2].outerHTML).toBe(neighborHtml);
      Array.from(rows[2].querySelectorAll("*")).forEach((node, nodeIndex) => expect(node).toBe(neighborNodes[nodeIndex]));
      for (const [rowIndex, row] of rows.slice(0, 2).entries()) {
        const currentWarnings = expectWarnings(row, warnings);
        expect(row.children[1].children).toHaveLength(1 + rowIndex + warnings.length);
        if (index === 0) {
          expect(currentWarnings[0]).toBe(originalWarnings[rowIndex][0]);
          expect(originalWarnings[rowIndex][1]).not.toBeInTheDocument();
        } else {
          for (const original of originalWarnings[rowIndex]) expect(original).not.toBeInTheDocument();
        }
      }
      const currentOpen = captureResultOpen();
      const currentRetry = captureResultRowRetry();
      expect(currentOpen.element).toBe(retiredOpens[0].element);
      expect(currentRetry.element).toBe(retiredRetries[0].element);
      expect(onOpenChange).toHaveBeenCalledTimes(index);
      expect(retry).toHaveBeenCalledTimes(index);
      for (let attempt = 0; attempt < 1; attempt++) {
        expect(invokeResultControl(currentOpen).preventDefault).not.toHaveBeenCalled();
        invokeResultControl(currentRetry);
      }
      expect(onOpenChange).toHaveBeenCalledTimes(index + 1);
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
      expect(retry).toHaveBeenCalledTimes(index + 1);
      retiredOpens.push(currentOpen);
      retiredRetries.push(currentRetry);
    }
    expect(uploadImportBatch).not.toHaveBeenCalled();
  });

  it.each(["Strict", "ordinary"])("keeps replacement warning actions usable through actual close and reopen in %s mode", (mode) => {
    const onOpenChange = vi.fn();
    const oldRetry = vi.fn();
    const nextRetry = vi.fn();
    const [success, failed] = resultItems(oldRetry);
    const neighbor = { ...success, name: "neighbor.md", id: "neighbor", warnings: [ordinaryWarning] };
    function ReopenableDialog({ items }: { items: ImportItem[] }) {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Reopen results</button>
          <ImportDialog
            open={open}
            onOpenChange={(next) => {
              onOpenChange(next);
              setOpen(next);
            }}
            items={items}
            ignored={[]}
          />
        </>
      );
    }
    const dialog = (items: ImportItem[]) => {
      const content = <ReopenableDialog items={items} />;
      return mode === "Strict" ? <StrictMode>{content}</StrictMode> : content;
    };
    const view = render(dialog([
      { ...success, warnings: [longWarning] },
      { ...failed, warnings: [longWarning] },
      neighbor,
    ]));
    const oldRows = screen.getAllByTestId("import-item");
    const root = screen.getByTestId("import-dialog");
    const dialogElement = screen.getByRole("dialog");
    const neighborHtml = oldRows[2].outerHTML;
    const neighborNodes = Array.from(oldRows[2].querySelectorAll("*"));
    view.rerender(dialog([
      { ...success, name: "replacement.md", id: "replacement", warnings: [literalWarning, longWarning] },
      { ...failed, name: "replacement-error.md", retry: nextRetry, warnings: [longWarning, ordinaryWarning] },
      neighbor,
    ]));
    const rows = screen.getAllByTestId("import-item");
    expect(screen.getByTestId("import-dialog")).toBe(root);
    expect(screen.getByRole("dialog")).toBe(dialogElement);
    expect(oldRows[0]).not.toBeInTheDocument();
    expect(oldRows[1]).not.toBeInTheDocument();
    expect(rows[2]).toBe(oldRows[2]);
    expect(rows[2].outerHTML).toBe(neighborHtml);
    Array.from(rows[2].querySelectorAll("*")).forEach((node, index) => expect(node).toBe(neighborNodes[index]));
    expectWarnings(rows[0], [literalWarning, longWarning]);
    expectWarnings(rows[1], [longWarning, ordinaryWarning]);
    for (let cycle = 0; cycle < 2; cycle++) {
      const currentOpen = captureResultOpen();
      const currentRetry = captureResultRowRetry();
      expect(currentOpen.element).toHaveAttribute("href", "/d/replacement");
      expect(oldRetry).not.toHaveBeenCalled();
      expect(nextRetry).toHaveBeenCalledTimes(cycle);
      expect(onOpenChange).toHaveBeenCalledTimes(cycle);
      invokeResultControl(currentRetry);
      expect(nextRetry).toHaveBeenCalledTimes(cycle + 1);
      act(() => {
        const event = invokeResultControl(currentOpen);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.stopPropagation).not.toHaveBeenCalled();
      });
      expect(onOpenChange).toHaveBeenCalledTimes(cycle + 1);
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
      expect(screen.queryByTestId("import-dialog")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Reopen results" }));
      const reopenedRows = screen.getAllByTestId("import-item");
      expectWarnings(reopenedRows[0], [literalWarning, longWarning]);
      expectWarnings(reopenedRows[1], [longWarning, ordinaryWarning]);
      expectWarnings(reopenedRows[2], [ordinaryWarning]);
      expect(reopenedRows[2].outerHTML).toBe(neighborHtml);
    }
    expect(oldRetry).not.toHaveBeenCalled();
    expect(uploadImportBatch).not.toHaveBeenCalled();
  });

  it("keeps wrapped-warning pointer activity passive after settled setup", async () => {
    const retry = vi.fn();
    const onOpenChange = vi.fn();
    const items = resultItems(retry).map((item) => ({ ...item, warnings: [longWarning, literalWarning] }));
    render(<ImportDialog open onOpenChange={onOpenChange} items={items} ignored={[]} />);
    await act(async () => {});
    const warnings = screen.getAllByTestId("import-warning");
    const domBefore = document.body.innerHTML;
    const activeBefore = document.activeElement;
    const spies = [
      vi.spyOn(globalThis, "fetch"),
      vi.spyOn(HTMLElement.prototype, "focus"),
      vi.spyOn(globalThis, "setTimeout"),
      vi.spyOn(globalThis, "setInterval"),
      vi.spyOn(globalThis, "queueMicrotask"),
      vi.spyOn(window, "requestAnimationFrame"),
    ];
    try {
      for (const warning of warnings) {
        for (const target of [warning, warning.firstElementChild!]) {
          fireEvent.pointerOver(target);
          fireEvent.pointerMove(target);
          fireEvent.mouseOver(target);
          fireEvent.mouseMove(target);
          fireEvent.mouseOut(target);
          fireEvent.pointerOut(target);
        }
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(document.body.innerHTML).toBe(domBefore);
      expect(document.activeElement).toBe(activeBefore);
      expect(retry).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(uploadImportBatch).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("compiles installed warning wrapping and icon shrink utilities", async () => {
    const { compile } = await import("tailwindcss");
    const { build } = await compile("@tailwind utilities;");
    const css = build(["wrap-anywhere", "shrink-0"]);
    expect(css).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
    expect(css).toMatch(/\.shrink-0\s*\{\s*flex-shrink:\s*0;\s*\}/);
    expect(css).not.toMatch(/word-break:\s*break-all/);
  });
});

describe("useFileImport - initial batch ownership", () => {
  it("accepts one direct start synchronously and permits a fresh exact batch after it settles", async () => {
    const first = new File(["# First"], "first.md", { type: "text/markdown" });
    const firstImage = new File(["first image"], "first.png", { type: "image/png" });
    const firstIgnored = new File(["first ignored"], "first.pdf", { type: "application/pdf" });
    const second = new File(["# Second"], "second.md", { type: "text/markdown" });
    const secondImage = new File(["second image"], "second.png", { type: "image/png" });
    const secondIgnored = new File(["second ignored"], "second.zip", { type: "application/zip" });
    const firstUpload = deferred<ImportBatch>();
    const onDone = vi.fn();
    const onError = vi.fn();
    uploadImportBatch
      .mockReturnValueOnce(firstUpload.promise)
      .mockResolvedValueOnce({ documents: [{ id: "doc-second", title: "Second", warnings: [] }], failed: [] });

    render(
      <Harness
        batches={[
          [first, firstImage, firstIgnored],
          [second, secondImage, secondIgnored],
        ]}
        onError={onError}
        onDone={onDone}
      />,
    );
    const firstButton = screen.getByRole("button", { name: "Import batch 1" });
    const secondButton = screen.getByRole("button", { name: "Import batch 2" });
    fireEvent.click(firstButton);
    fireEvent.click(secondButton);

    expect(uploadImportBatch).toHaveBeenCalledTimes(1);
    expect(uploadImportBatch).toHaveBeenNthCalledWith(1, [first], [firstImage]);
    expect(screen.getByTestId("import-item")).toHaveTextContent("first.md");
    expect(screen.getByTestId("import-item")).toHaveAttribute("data-status", "uploading");
    expect(screen.getByTestId("import-ignored")).toHaveTextContent("first.pdf");
    expect(screen.getByTestId("import-ignored")).not.toHaveTextContent("second.zip");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("import-dialog")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    await act(async () => {
      firstUpload.resolve({ documents: [{ id: "doc-first", title: "First", warnings: ["First warning"] }], failed: [] });
    });
    expect(await screen.findByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-first");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenLastCalledWith([{ id: "doc-first", title: "First", warnings: ["First warning"] }], []);

    fireEvent.click(secondButton);
    await waitFor(() => expect(uploadImportBatch).toHaveBeenCalledTimes(2));
    expect(uploadImportBatch).toHaveBeenNthCalledWith(2, [second], [secondImage]);
    expect(await screen.findByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-second");
    expect(screen.getByTestId("import-ignored")).toHaveTextContent("second.zip");
    expect(onDone).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps a picker batch when an immediate drop tries to replace it", async () => {
    const picked = new File(["# Picked"], "picked.md", { type: "text/markdown" });
    const pickedImage = new File(["picked image"], "picked.png", { type: "image/png" });
    const pickedIgnored = new File(["picked ignored"], "picked.pdf", { type: "application/pdf" });
    const dropped = new File(["# Dropped"], "dropped.md", { type: "text/markdown" });
    const droppedImage = new File(["dropped image"], "dropped.png", { type: "image/png" });
    const upload = deferred<ImportBatch>();
    const onDone = vi.fn();
    uploadImportBatch.mockReturnValueOnce(upload.promise);
    render(<Harness batches={[]} onError={vi.fn()} onDone={onDone} />);

    fireEvent.change(screen.getByTestId("import-file-input"), {
      target: { files: [picked, pickedImage, pickedIgnored] },
    });
    dropFiles([dropped, droppedImage]);

    expect(uploadImportBatch).toHaveBeenCalledTimes(1);
    expect(uploadImportBatch).toHaveBeenCalledWith([picked], [pickedImage]);
    expect(screen.getByTestId("import-item")).toHaveTextContent("picked.md");
    expect(screen.getByTestId("import-ignored")).toHaveTextContent("picked.pdf");
    expect(screen.queryByText("dropped.md")).toBeNull();

    await act(async () => {
      upload.resolve({ documents: [{ id: "doc-picked", title: "Picked", warnings: [] }], failed: [] });
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith([{ id: "doc-picked", title: "Picked", warnings: [] }], []);
  });

  it("keeps a drop batch when an immediate picker change tries to replace it", async () => {
    const dropped = new File(["# Dropped"], "dropped.md", { type: "text/markdown" });
    const droppedImage = new File(["dropped image"], "dropped.png", { type: "image/png" });
    const droppedIgnored = new File(["dropped ignored"], "dropped.pdf", { type: "application/pdf" });
    const picked = new File(["# Picked"], "picked.md", { type: "text/markdown" });
    const pickedImage = new File(["picked image"], "picked.png", { type: "image/png" });
    const upload = deferred<ImportBatch>();
    const onDone = vi.fn();
    uploadImportBatch.mockReturnValueOnce(upload.promise);
    render(<Harness batches={[]} onError={vi.fn()} onDone={onDone} />);

    dropFiles([dropped, droppedImage, droppedIgnored]);
    fireEvent.change(screen.getByTestId("import-file-input"), {
      target: { files: [picked, pickedImage] },
    });

    expect(uploadImportBatch).toHaveBeenCalledTimes(1);
    expect(uploadImportBatch).toHaveBeenCalledWith([dropped], [droppedImage]);
    expect(screen.getByTestId("import-item")).toHaveTextContent("dropped.md");
    expect(screen.getByTestId("import-ignored")).toHaveTextContent("dropped.pdf");
    expect(screen.queryByText("picked.md")).toBeNull();

    await act(async () => {
      upload.resolve({ documents: [{ id: "doc-dropped", title: "Dropped", warnings: [] }], failed: [] });
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith([{ id: "doc-dropped", title: "Dropped", warnings: [] }], []);
  });

  it("preserves ignored-only feedback without issuing an upload", async () => {
    const ignored = new File(["archive"], "notes.pdf", { type: "application/pdf" });
    const onError = vi.fn();
    render(<Harness batches={[[ignored]]} onError={onError} />);

    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));

    expect(uploadImportBatch).not.toHaveBeenCalled();
    expect(await screen.findByTestId("import-ignored")).toHaveTextContent("notes.pdf");
    expect(screen.queryAllByTestId("import-item")).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain(".md, .markdown");
  });
});

describe("useFileImport - retry ownership", () => {
  it("retries one of three failed rows with the original images and preserves every other row", async () => {
    const first = new File(["# First"], "first.md", { type: "text/markdown" });
    const second = new File(["# Second"], "second.md", { type: "text/markdown" });
    const third = new File(["# Third"], "third.md", { type: "text/markdown" });
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    const ignored = new File(["archive"], "notes.pdf", { type: "application/pdf" });
    const retryUpload = deferred<ImportBatch>();
    const onDone = vi.fn();
    uploadImportBatch
      .mockResolvedValueOnce({
        documents: [],
        failed: [
          { index: 0, name: first.name, error: "First failed" },
          { index: 1, name: second.name, error: "Second failed" },
          { index: 2, name: third.name, error: "Third failed" },
        ],
      })
      .mockReturnValueOnce(retryUpload.promise);

    render(
      <StrictMode>
        <Harness
          batches={[[first, second, third, image, ignored]]}
          onError={vi.fn()}
          onDone={onDone}
        />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
    expect(await screen.findAllByTestId("import-row-retry")).toHaveLength(3);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry second.md" }));

    expect(uploadImportBatch).toHaveBeenCalledTimes(2);
    expect(uploadImportBatch).toHaveBeenNthCalledWith(2, [second], [image]);
    expect(screen.getAllByTestId("import-item").map((row) => row.dataset.status)).toEqual([
      "error",
      "uploading",
      "error",
    ]);
    for (const retry of [
      ...screen.getAllByTestId("import-row-retry"),
      screen.getByRole("button", { name: "Retry failed" }),
    ]) {
      expect(retry).toBeDisabled();
    }
    expect(screen.getByTestId("import-ignored")).toHaveTextContent("notes.pdf");

    await act(async () => {
      retryUpload.resolve({
        documents: [{ id: "doc-second", title: "Second imported", warnings: ["Second warning"] }],
        failed: [],
      });
    });

    const rows = screen.getAllByTestId("import-item");
    expect(rows.map((row) => row.querySelector("span.truncate.text-sm")?.getAttribute("title"))).toEqual([
      "first.md",
      "Second imported",
      "third.md",
    ]);
    expect(rows.map((row) => row.dataset.status)).toEqual(["error", "done", "error"]);
    expect(within(rows[1]).getByTestId("import-open")).toHaveAttribute("href", "/d/doc-second");
    expect(within(rows[1]).getByTestId("import-warning")).toHaveTextContent("Second warning");
    expect(screen.getAllByTestId("import-row-retry")).toHaveLength(2);
    expect(onDone).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenLastCalledWith(
      [{ id: "doc-second", title: "Second imported", warnings: ["Second warning"] }],
      [
        { index: 0, name: "first.md", error: "First failed" },
        { index: 2, name: "third.md", error: "Third failed" },
      ],
    );
  });

  it("replaces one failed row beside an existing success and leaves one failure retryable", async () => {
    const first = new File(["# First"], "first.md", { type: "text/markdown" });
    const second = new File(["# Second"], "second.md", { type: "text/markdown" });
    const third = new File(["# Third"], "third.md", { type: "text/markdown" });
    const onDone = vi.fn();
    uploadImportBatch
      .mockResolvedValueOnce({
        documents: [{ id: "doc-first", title: "First imported", warnings: ["First warning"] }],
        failed: [
          { index: 1, name: second.name, error: "Second failed" },
          { index: 2, name: third.name, error: "Third failed" },
        ],
      })
      .mockResolvedValueOnce({
        documents: [{ id: "doc-second", title: "Second imported", warnings: [] }],
        failed: [],
      });

    render(
      <StrictMode>
        <Harness batches={[[first, second, third]]} onError={vi.fn()} onDone={onDone} />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
    await screen.findByRole("button", { name: "Retry second.md" });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Retry second.md" }));

    await waitFor(() => expect(screen.getAllByTestId("import-open")).toHaveLength(2));
    const rows = screen.getAllByTestId("import-item");
    expect(rows.map((row) => row.dataset.status)).toEqual(["done", "done", "error"]);
    expect(screen.getByRole("button", { name: "Retry third.md" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Retry second.md" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry failed" })).toBeEnabled();
    expect(screen.getAllByTestId("import-open").map((link) => link.getAttribute("href"))).toEqual([
      "/d/doc-first",
      "/d/doc-second",
    ]);
    expect(onDone).toHaveBeenLastCalledWith(
      [
        { id: "doc-first", title: "First imported", warnings: ["First warning"] },
        { id: "doc-second", title: "Second imported", warnings: [] },
      ],
      [{ index: 2, name: "third.md", error: "Third failed" }],
    );
  });

  it("exposes a fresh individual retry after rejection and keeps global retry scoped to remaining failures", async () => {
    const first = new File(["# First"], "first.md", { type: "text/markdown" });
    const second = new File(["# Second"], "second.md", { type: "text/markdown" });
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    const onDone = vi.fn();
    const onError = vi.fn();
    const initialReason = "f".repeat(300);
    const repeatedReason = `Retry unavailable: ${"r".repeat(300)}`;
    uploadImportBatch
      .mockResolvedValueOnce({
        documents: [],
        failed: [
          { index: 0, name: first.name, error: initialReason },
          { index: 1, name: second.name, error: "Second failed" },
        ],
      })
      .mockRejectedValueOnce(new Error(repeatedReason))
      .mockResolvedValueOnce({
        documents: [{ id: "doc-first", title: "First", warnings: [] }],
        failed: [],
      })
      .mockResolvedValueOnce({
        documents: [{ id: "doc-second", title: "Second", warnings: [] }],
        failed: [],
      });

    render(
      <StrictMode>
        <Harness batches={[[first, second, image]]} onError={onError} onDone={onDone} />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
    await screen.findByRole("button", { name: "Retry first.md" });
    await act(async () => {});
    const [firstRow, neighbor] = screen.getAllByTestId("import-item");
    expectImportError(firstRow, initialReason);
    const neighborDetails = neighbor.children[1].outerHTML;
    const initialRetry = captureResultRowRetry();
    fireEvent.click(screen.getByRole("button", { name: "Retry first.md" }));
    expect(firstRow).toHaveAttribute("data-status", "uploading");
    expect(firstRow.querySelector("div.text-red-600")).toBeNull();
    expect(neighbor.children[1].outerHTML).toBe(neighborDetails);
    expect(uploadImportBatch).toHaveBeenCalledTimes(2);
    expect(uploadImportBatch).toHaveBeenNthCalledWith(2, [first], [image]);

    expect(await screen.findByText(repeatedReason)).toBeInTheDocument();
    expect(screen.getAllByTestId("import-item")[0]).toBe(firstRow);
    expectImportError(firstRow, repeatedReason);
    expect(neighbor.children[1].outerHTML).toBe(neighborDetails);
    expect(screen.getByRole("button", { name: "Retry first.md" })).toBeEnabled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(repeatedReason);
    expect(onDone).toHaveBeenCalledTimes(2);
    const repeatedRetry = captureResultRowRetry();
    invokeResultControl(initialRetry, repeatedRetry.element);
    expect(uploadImportBatch).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Retry first.md" }));
    expect(firstRow).toHaveAttribute("data-status", "uploading");
    expect(firstRow.querySelector("div.text-red-600")).toBeNull();
    await waitFor(() => expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-first"));
    expect(firstRow).toHaveAttribute("data-status", "done");
    expect(firstRow.querySelector("div.text-red-600")).toBeNull();
    expect(neighbor.children[1].outerHTML).toBe(neighborDetails);
    invokeResultControl(repeatedRetry);
    expect(uploadImportBatch).toHaveBeenCalledTimes(3);
    expect(uploadImportBatch).toHaveBeenNthCalledWith(3, [first], [image]);
    expect(screen.queryByRole("button", { name: "Retry first.md" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry second.md" })).toBeEnabled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));
    await waitFor(() => expect(screen.getAllByTestId("import-open")).toHaveLength(2));
    expect(uploadImportBatch).toHaveBeenNthCalledWith(4, [second], [image]);
    expect(uploadImportBatch).toHaveBeenCalledTimes(4);
    expect(screen.queryByTestId("import-row-retry")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(4);
    expect(onDone).toHaveBeenLastCalledWith(
      [
        { id: "doc-first", title: "First", warnings: [] },
        { id: "doc-second", title: "Second", warnings: [] },
      ],
      [],
    );
  });

  it("keeps a successful row settled when its exact onDone callback throws", async () => {
    const failed = new File(["# Failed"], "failed.md", { type: "text/markdown" });
    const onDone = vi.fn();
    const onError = vi.fn();
    let retry: (() => void) | undefined;
    uploadImportBatch
      .mockResolvedValueOnce({
        documents: [],
        failed: [{ index: 0, name: failed.name, error: "Initial failure" }],
      })
      .mockResolvedValueOnce({
        documents: [{ id: "doc-failed", title: "Recovered", warnings: ["Recovered warning"] }],
        failed: [],
      });

    render(
      <StrictMode>
        <Harness
          batches={[[failed]]}
          onError={onError}
          onDone={onDone}
          captureRetry={(current) => {
            retry = current;
          }}
        />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
    await screen.findByRole("button", { name: "Retry failed.md" });
    await act(async () => {});
    const exactRetry = retry;
    if (!exactRetry) throw new Error("The failed row did not publish a retry");
    const callbackError = new Error("Consumer onDone failed");
    onDone.mockImplementationOnce(() => {
      throw callbackError;
    });

    await act(async () => {
      await expect(invokeAsyncRetry(exactRetry)).rejects.toBe(callbackError);
    });

    const row = screen.getByTestId("import-item");
    expect(row).toHaveAttribute("data-status", "done");
    expect(within(row).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-failed");
    expect(within(row).getByTestId("import-warning")).toHaveTextContent("Recovered warning");
    expect(screen.queryByTestId("import-row-retry")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(2);

    await act(async () => {
      await invokeAsyncRetry(exactRetry);
    });
    expect(uploadImportBatch).toHaveBeenCalledTimes(2);
    expect(unhandledRejections).toEqual([]);
  });

  it("delivers whole-batch onDone once and restores retry when onError throws", async () => {
    const failed = new File(["# Failed"], "failed.md", { type: "text/markdown" });
    const callbackError = new Error("Consumer onError failed");
    const onDone = vi.fn();
    const onError = vi.fn(() => {
      throw callbackError;
    });
    let retry: (() => void) | undefined;
    uploadImportBatch
      .mockResolvedValueOnce({
        documents: [],
        failed: [{ index: 0, name: failed.name, error: "Initial failure" }],
      })
      .mockRejectedValueOnce(new Error("Retry request failed"));

    render(
      <StrictMode>
        <Harness
          batches={[[failed]]}
          onError={onError}
          onDone={onDone}
          captureRetry={(current) => {
            retry = current;
          }}
        />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
    await screen.findByRole("button", { name: "Retry failed.md" });
    await act(async () => {});
    const exactRetry = retry;
    if (!exactRetry) throw new Error("The failed row did not publish a retry");

    await act(async () => {
      await expect(invokeAsyncRetry(exactRetry)).rejects.toBe(callbackError);
    });

    const row = screen.getByTestId("import-item");
    expect(row).toHaveAttribute("data-status", "error");
    expect(row).toHaveTextContent("Retry request failed");
    expect(screen.getByRole("button", { name: "Retry failed.md" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Retry failed" })).toBeEnabled();
    expect(onError).toHaveBeenCalledExactlyOnceWith("Retry request failed");
    expect(onDone).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenLastCalledWith(
      [],
      [{ index: 0, name: failed.name, error: "Retry request failed" }],
    );
    expect(unhandledRejections).toEqual([]);
  });

  it.each(["start", "unmount"] as const)(
    "finishes old failure callbacks when onError performs a reentrant %s",
    async (reentry) => {
      const failed = new File(["# Failed"], "failed.md", { type: "text/markdown" });
      const fresh = new File(["# Fresh"], "fresh.md", { type: "text/markdown" });
      const freshUpload = deferred<ImportBatch>();
      const onDone = vi.fn();
      let start!: ReturnType<typeof useFileImport>["start"];
      let retry: (() => void) | undefined;
      const onError = vi.fn((message: string) => {
        if (message !== "Retry request failed") return;
        if (reentry === "start") void start([fresh]);
        else view.unmount();
      });
      uploadImportBatch
        .mockResolvedValueOnce({
          documents: [],
          failed: [{ index: 0, name: failed.name, error: "Initial failure" }],
        })
        .mockRejectedValueOnce(new Error("Retry request failed"))
        .mockReturnValueOnce(freshUpload.promise);

      const view = render(
        <StrictMode>
          <Harness
            batches={[[failed]]}
            onError={onError}
            onDone={onDone}
            captureStart={(current) => {
              start = current;
            }}
            captureRetry={(current) => {
              retry = current;
            }}
          />
        </StrictMode>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
      await screen.findByRole("button", { name: "Retry failed.md" });
      await act(async () => {});
      onDone.mockClear();
      const exactRetry = retry;
      if (!exactRetry) throw new Error("The failed row did not publish a retry");

      await act(async () => {
        await invokeAsyncRetry(exactRetry);
      });

      expect(onError).toHaveBeenCalledExactlyOnceWith("Retry request failed");
      expect(onDone).toHaveBeenCalledExactlyOnceWith(
        [],
        [{ index: 0, name: failed.name, error: "Retry request failed" }],
      );
      if (reentry === "unmount") {
        expect(screen.queryByTestId("import-dialog")).toBeNull();
        expect(uploadImportBatch).toHaveBeenCalledTimes(2);
        return;
      }

      expect(uploadImportBatch).toHaveBeenCalledTimes(3);
      expect(uploadImportBatch).toHaveBeenNthCalledWith(3, [fresh], []);
      expect(screen.getByTestId("import-item")).toHaveTextContent(fresh.name);
      expect(screen.getByTestId("import-item")).toHaveAttribute("data-status", "uploading");
      await act(async () => {
        freshUpload.resolve({
          documents: [{ id: "doc-fresh", title: "Fresh", warnings: [] }],
          failed: [],
        });
      });
      expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-fresh");
      expect(onDone).toHaveBeenCalledTimes(2);
      expect(onDone).toHaveBeenLastCalledWith(
        [{ id: "doc-fresh", title: "Fresh", warnings: [] }],
        [],
      );
    },
  );

  it.each(
    ([
      { label: "undefined", value: undefined },
      { label: "null", value: null },
      { label: "false", value: false },
      { label: "Error", value: new Error("Callback failed") },
    ] as const).flatMap(({ label, value }) =>
      (["onError", "onDone", "both"] as const).map((callbacks) => ({
        name: `${callbacks} throwing ${label}`,
        callbacks,
        value,
      })),
    ),
  )("surfaces $name after preserving failed retry settlement", async ({ callbacks, value }) => {
    const failed = new File(["# Failed"], "failed.md", { type: "text/markdown" });
    const onDone = vi.fn();
    const onError = vi.fn();
    let retry: (() => void) | undefined;
    uploadImportBatch
      .mockResolvedValueOnce({
        documents: [],
        failed: [{ index: 0, name: failed.name, error: "Initial failure" }],
      })
      .mockRejectedValueOnce(new Error("Retry request failed"));

    render(
      <StrictMode>
        <Harness
          batches={[[failed]]}
          onError={onError}
          onDone={onDone}
          captureRetry={(current) => {
            retry = current;
          }}
        />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
    await screen.findByRole("button", { name: "Retry failed.md" });
    await act(async () => {});
    onDone.mockClear();
    onError.mockClear();
    if (callbacks === "onError" || callbacks === "both") {
      onError.mockImplementation(() => {
        throw value;
      });
    }
    if (callbacks === "onDone" || callbacks === "both") {
      onDone.mockImplementation(() => {
        throw value;
      });
    }
    const exactRetry = retry;
    if (!exactRetry) throw new Error("The failed row did not publish a retry");

    let rejection!: Awaited<ReturnType<typeof rejectedValue>>;
    await act(async () => {
      rejection = await rejectedValue(invokeAsyncRetry(exactRetry));
    });

    expect(rejection.rejected).toBe(true);
    if (callbacks === "both") {
      expect(rejection.value).toBeInstanceOf(AggregateError);
      expect((rejection.value as AggregateError).errors).toHaveLength(2);
      expect(Object.is((rejection.value as AggregateError).errors[0], value)).toBe(true);
      expect(Object.is((rejection.value as AggregateError).errors[1], value)).toBe(true);
    } else {
      expect(Object.is(rejection.value, value)).toBe(true);
    }
    expect(onError).toHaveBeenCalledExactlyOnceWith("Retry request failed");
    expect(onDone).toHaveBeenCalledExactlyOnceWith(
      [],
      [{ index: 0, name: failed.name, error: "Retry request failed" }],
    );
    expect(screen.getByTestId("import-item")).toHaveAttribute("data-status", "error");
    expect(screen.getByRole("button", { name: "Retry failed.md" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Retry failed" })).toBeEnabled();
    expect(unhandledRejections).toEqual([]);
  });

  it("freezes callback identity for a pending retry and uses the replacement only for fresh work", async () => {
    const failed = new File(["# Failed"], "failed.md", { type: "text/markdown" });
    const fresh = new File(["# Fresh"], "fresh.md", { type: "text/markdown" });
    const retryUpload = deferred<ImportBatch>();
    const oldOnDone = vi.fn();
    const oldOnError = vi.fn();
    const newOnDone = vi.fn();
    const newOnError = vi.fn();
    uploadImportBatch
      .mockResolvedValueOnce({
        documents: [],
        failed: [{ index: 0, name: failed.name, error: "Initial failure" }],
      })
      .mockReturnValueOnce(retryUpload.promise)
      .mockResolvedValueOnce({
        documents: [{ id: "doc-fresh", title: "Fresh", warnings: [] }],
        failed: [],
      });
    const view = render(
      <StrictMode>
        <Harness
          batches={[[failed], [fresh]]}
          onError={oldOnError}
          onDone={oldOnDone}
        />
      </StrictMode>,
    );
    const freshBatch = screen.getByRole("button", { name: "Import batch 2" });
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
    await screen.findByRole("button", { name: "Retry failed.md" });
    await act(async () => {});
    oldOnDone.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Retry failed.md" }));
    view.rerender(
      <StrictMode>
        <Harness
          batches={[[failed], [fresh]]}
          onError={newOnError}
          onDone={newOnDone}
        />
      </StrictMode>,
    );
    await act(async () => {
      retryUpload.resolve({
        documents: [{ id: "doc-failed", title: "Recovered", warnings: [] }],
        failed: [],
      });
    });

    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-failed");
    expect(oldOnDone).toHaveBeenCalledExactlyOnceWith(
      [{ id: "doc-failed", title: "Recovered", warnings: [] }],
      [],
    );
    expect(newOnDone).not.toHaveBeenCalled();
    expect(oldOnError).not.toHaveBeenCalled();
    expect(newOnError).not.toHaveBeenCalled();

    fireEvent.click(freshBatch);
    await waitFor(() => expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-fresh"));
    expect(newOnDone).toHaveBeenCalledExactlyOnceWith(
      [{ id: "doc-fresh", title: "Fresh", warnings: [] }],
      [],
    );
    expect(oldOnDone).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "omitted outcomes",
      scope: "individual" as const,
      result: { documents: [], failed: [] },
    },
    {
      name: "extra outcomes",
      scope: "individual" as const,
      result: {
        documents: [
          { id: "doc-extra-a", title: "Extra A", warnings: [] },
          { id: "doc-extra-b", title: "Extra B", warnings: [] },
        ],
        failed: [],
      },
    },
    {
      name: "duplicate failure indices",
      scope: "global" as const,
      result: {
        documents: [],
        failed: [
          { index: 0, name: "first.md", error: "First duplicate" },
          { index: 0, name: "first.md", error: "Second duplicate" },
        ],
      },
    },
    {
      name: "out-of-range failure indices",
      scope: "individual" as const,
      result: {
        documents: [],
        failed: [{ index: 1, name: "second.md", error: "Out of range" }],
      },
    },
    {
      name: "wrong failure names",
      scope: "individual" as const,
      result: {
        documents: [],
        failed: [{ index: 0, name: "wrong.md", error: "Wrong name" }],
      },
    },
    {
      name: "inconsistent success and failure counts",
      scope: "global" as const,
      result: {
        documents: [{ id: "doc-inconsistent", title: "Inconsistent", warnings: [] }],
        failed: [
          { index: 0, name: "first.md", error: "First inconsistent" },
          { index: 1, name: "second.md", error: "Second inconsistent" },
        ],
      },
    },
  ])("rejects $name before associating retry rows and admits a clean successor", async ({ scope, result }) => {
    const first = new File(["# First"], "first.md", { type: "text/markdown" });
    const second = new File(["# Second"], "second.md", { type: "text/markdown" });
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    const onDone = vi.fn();
    const onError = vi.fn();
    const recovery =
      scope === "individual"
        ? {
            documents: [
              { id: "doc-first", title: "First", warnings: [] },
              { id: "doc-second", title: "Second", warnings: [] },
            ],
            failed: [],
          }
        : {
            documents: [{ id: "doc-second", title: "Second", warnings: [] }],
            failed: [],
          };
    uploadImportBatch
      .mockResolvedValueOnce({
        documents: [],
        failed: [
          { index: 0, name: first.name, error: "First failed" },
          { index: 1, name: second.name, error: "Second failed" },
        ],
      })
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce(recovery);

    render(
      <StrictMode>
        <Harness batches={[[first, second, image]]} onError={onError} onDone={onDone} />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
    await screen.findByRole("button", { name: "Retry first.md" });
    await act(async () => {});

    fireEvent.click(
      screen.getByRole("button", {
        name: scope === "individual" ? "Retry first.md" : "Retry failed",
      }),
    );
    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith("Import returned an invalid result"));

    expect(uploadImportBatch).toHaveBeenNthCalledWith(
      2,
      scope === "individual" ? [first] : [first, second],
      [image],
    );
    expect(screen.queryByTestId("import-open")).toBeNull();
    expect(screen.getAllByTestId("import-item").map((row) => row.dataset.status)).toEqual(["error", "error"]);
    expect(screen.getAllByTestId("import-row-retry")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Retry failed" })).toBeEnabled();
    expect(onDone).toHaveBeenCalledTimes(2);

    fireEvent.click(
      screen.getByRole("button", {
        name: scope === "individual" ? "Retry failed" : "Retry second.md",
      }),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("import-open")).toHaveLength(scope === "individual" ? 2 : 1),
    );

    expect(uploadImportBatch).toHaveBeenNthCalledWith(
      3,
      scope === "individual" ? [first, second] : [second],
      [image],
    );
    const rows = screen.getAllByTestId("import-item");
    if (scope === "individual") {
      expect(rows.map((row) => row.dataset.status)).toEqual(["done", "done"]);
      expect(screen.queryByTestId("import-row-retry")).toBeNull();
    } else {
      expect(rows.map((row) => row.dataset.status)).toEqual(["error", "done"]);
      expect(screen.getByRole("button", { name: "Retry first.md" })).toBeEnabled();
      expect(within(rows[1]).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-second");
    }
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      name: "an array as the result record",
      result: () => [importDocumentResult()],
    },
    {
      name: "a non-array documents collection",
      result: () => ({ documents: {}, failed: [] }),
    },
    {
      name: "a non-array failures collection",
      result: () => ({ documents: [importDocumentResult()], failed: {} }),
    },
    {
      name: "an accessor-backed result collection",
      result: () => {
        const raw: Record<string, unknown> = { failed: [] };
        Object.defineProperty(raw, "documents", {
          configurable: true,
          enumerable: true,
          get: () => [importDocumentResult()],
        });
        return raw;
      },
    },
    {
      name: "a result proxy whose descriptor trap throws",
      result: () =>
        new Proxy(
          { documents: [importDocumentResult()], failed: [] },
          {
            getOwnPropertyDescriptor() {
              throw undefined;
            },
          },
        ),
    },
    {
      name: "a transparent result proxy",
      result: () => new Proxy({ documents: [importDocumentResult()], failed: [] }, {}),
    },
    {
      name: "a missing created document record",
      result: () => ({ documents: [{}], failed: [] }),
    },
    {
      name: "a non-string created document id",
      result: () => ({ documents: [importDocumentResult({ id: 42 })], failed: [] }),
    },
    {
      name: "a non-string created document title",
      result: () => ({ documents: [importDocumentResult({ title: null })], failed: [] }),
    },
    {
      name: "a non-array created document warning list",
      result: () => ({ documents: [importDocumentResult({ warnings: "warning" })], failed: [] }),
    },
    {
      name: "a non-string created document warning",
      result: () => ({ documents: [importDocumentResult({ warnings: [false] })], failed: [] }),
    },
    {
      name: "an oversized created document warning list",
      result: () => ({
        documents: [importDocumentResult({ warnings: Array.from({ length: 1_001 }, () => "warning") })],
        failed: [],
      }),
    },
    {
      name: "an accessor-backed failure index",
      result: () => failureResultWithAccessor("index"),
    },
    {
      name: "an accessor-backed failure name",
      result: () => failureResultWithAccessor("name"),
    },
    {
      name: "an accessor-backed failure error",
      result: () => failureResultWithAccessor("error"),
    },
    {
      name: "a changing failure index descriptor",
      result: () => failureResultWithChangingDescriptor("index"),
    },
    {
      name: "a changing failure name descriptor",
      result: () => failureResultWithChangingDescriptor("name"),
    },
    {
      name: "a changing failure error descriptor",
      result: () => failureResultWithChangingDescriptor("error"),
    },
    {
      name: "a changing array length descriptor",
      result: () => {
        let reads = 0;
        const documents = new Proxy([importDocumentResult()], {
          getOwnPropertyDescriptor(target, key) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
            if (!descriptor || key !== "length" || !("value" in descriptor)) return descriptor;
            reads++;
            return { ...descriptor, value: reads === 1 ? 1 : 0 };
          },
        });
        return { documents, failed: [] };
      },
    },
  ])("fails closed for $name and recovers with the same exact row", async ({ result }) => {
    const failed = new File(["# Failed"], "failed.md", { type: "text/markdown" });
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    const onDone = vi.fn();
    const onError = vi.fn();
    uploadImportBatch
      .mockResolvedValueOnce({
        documents: [],
        failed: [{ index: 0, name: failed.name, error: "Initial failure" }],
      })
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce({
        documents: [{ id: "doc-recovered", title: "Recovered", warnings: [] }],
        failed: [],
      });

    render(
      <StrictMode>
        <Harness batches={[[failed, image]]} onError={onError} onDone={onDone} />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
    await screen.findByRole("button", { name: "Retry failed.md" });
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Retry failed.md" }));
    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith("Import returned an invalid result"));

    expect(uploadImportBatch).toHaveBeenNthCalledWith(2, [failed], [image]);
    expect(screen.queryByTestId("import-open")).toBeNull();
    expect(screen.getByTestId("import-item")).toHaveAttribute("data-status", "error");
    expect(screen.getByTestId("import-item")).toHaveTextContent("Import returned an invalid result");
    expect(screen.getByRole("button", { name: "Retry failed.md" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Retry failed" })).toBeEnabled();
    expect(onDone).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Retry failed.md" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-recovered"));

    expect(uploadImportBatch).toHaveBeenNthCalledWith(3, [failed], [image]);
    expect(screen.getByTestId("import-item")).toHaveAttribute("data-status", "done");
    expect(screen.queryByTestId("import-row-retry")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(3);
    expect(onDone).toHaveBeenLastCalledWith(
      [{ id: "doc-recovered", title: "Recovered", warnings: [] }],
      [],
    );
  });

  it.each(["resolve", "reject"] as const)(
    "retires an individual retry on close, ignores its late %s, and admits a fresh batch",
    async (outcome) => {
      const oldDocument = new File(["# Old"], "old.md", { type: "text/markdown" });
      const oldImage = new File(["old image"], "old.png", { type: "image/png" });
      const freshDocument = new File(["# Fresh"], "fresh.md", { type: "text/markdown" });
      const freshImage = new File(["fresh image"], "fresh.png", { type: "image/png" });
      const lateRetry = deferred<ImportBatch>();
      const onDone = vi.fn();
      const onError = vi.fn();
      uploadImportBatch
        .mockResolvedValueOnce({
          documents: [],
          failed: [{ index: 0, name: oldDocument.name, error: "Old failed" }],
        })
        .mockReturnValueOnce(lateRetry.promise)
        .mockResolvedValueOnce({
          documents: [{ id: "doc-fresh", title: "Fresh", warnings: [] }],
          failed: [],
        });

      render(
        <StrictMode>
          <Harness
            batches={[
              [oldDocument, oldImage],
              [freshDocument, freshImage],
            ]}
            onError={onError}
            onDone={onDone}
          />
        </StrictMode>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
      await screen.findByRole("button", { name: "Retry old.md" });
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Retry old.md" }));
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByTestId("import-dialog")).toBeNull());

      fireEvent.click(screen.getByRole("button", { name: "Import batch 2" }));
      expect(await screen.findByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-fresh");
      expect(uploadImportBatch).toHaveBeenNthCalledWith(3, [freshDocument], [freshImage]);

      await act(async () => {
        if (outcome === "resolve") {
          lateRetry.resolve({
            documents: [{ id: "doc-old", title: "Old", warnings: [] }],
            failed: [],
          });
        } else {
          lateRetry.reject(new Error("Late retry failure"));
        }
      });

      expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-fresh");
      expect(screen.queryByText("Old")).toBeNull();
      expect(onDone).toHaveBeenCalledTimes(2);
      expect(onDone).toHaveBeenLastCalledWith(
        [{ id: "doc-fresh", title: "Fresh", warnings: [] }],
        [],
      );
      expect(onError).not.toHaveBeenCalled();
      expect(unhandledRejections).toEqual([]);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "retires an individual retry during Strict Mode cleanup before a late %s",
    async (outcome) => {
      const file = new File(["# Failed"], "failed.md", { type: "text/markdown" });
      const image = new File(["image"], "failed.png", { type: "image/png" });
      const lateRetry = deferred<ImportBatch>();
      const onDone = vi.fn();
      const onError = vi.fn();
      uploadImportBatch
        .mockResolvedValueOnce({
          documents: [],
          failed: [{ index: 0, name: file.name, error: "Failed" }],
        })
        .mockReturnValueOnce(lateRetry.promise);
      const view = render(
        <StrictMode>
          <Harness batches={[[file, image]]} onError={onError} onDone={onDone} />
        </StrictMode>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
      await screen.findByRole("button", { name: "Retry failed.md" });
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Retry failed.md" }));
      onDone.mockClear();

      view.unmount();
      await act(async () => {
        if (outcome === "resolve") {
          lateRetry.resolve({
            documents: [{ id: "doc-late", title: "Late", warnings: [] }],
            failed: [],
          });
        } else {
          lateRetry.reject(new Error("Late cleanup failure"));
        }
      });

      expect(onDone).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(uploadImportBatch).toHaveBeenCalledTimes(2);
      expect(unhandledRejections).toEqual([]);
    },
  );

  it("retries only failures with their image companions and rejects initial work while retry is pending", async () => {
    const first = new File(["# First"], "first.md", { type: "text/markdown" });
    const second = new File(["# Second"], "second.md", { type: "text/markdown" });
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    const ignored = new File(["archive"], "notes.pdf", { type: "application/pdf" });
    const replacement = new File(["# Replacement"], "replacement.md", { type: "text/markdown" });
    const replacementImage = new File(["replacement image"], "replacement.png", { type: "image/png" });
    const retryFailure = deferred<ImportBatch>();
    const onDone = vi.fn();
    const onError = vi.fn();
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

    render(
      <Harness
        batches={[
          [first, second, image, ignored],
          [replacement, replacementImage],
        ]}
        onError={onError}
        onDone={onDone}
      />,
    );
    const firstBatch = screen.getByRole("button", { name: "Import batch 1" });
    const replacementBatch = screen.getByRole("button", { name: "Import batch 2" });
    fireEvent.click(firstBatch);

    expect(await screen.findByText("First failure reason")).toBeInTheDocument();
    expect(screen.getByTestId("import-ignored")).toHaveTextContent("notes.pdf");
    const initialRows = screen.getAllByTestId("import-item");
    expect(initialRows.map((row) => row.querySelector("span.truncate.text-sm")?.textContent)).toEqual(["First", "second.md"]);
    expect(initialRows[0]).toHaveAttribute("data-status", "done");
    expect(initialRows[1]).toHaveAttribute("data-status", "error");
    expect(within(initialRows[0]).getByTestId("import-open")).toHaveAttribute("href", "/d/doc-first");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenLastCalledWith(
      [{ id: "doc-first", title: "First", warnings: ["First warning"] }],
      [{ index: 1, name: "second.md", error: "First failure reason" }],
    );

    const retry = screen.getByRole("button", { name: "Retry failed" });
    fireEvent.click(retry);

    await waitFor(() => expect(retry).toBeDisabled());
    expect(screen.getAllByTestId("import-item")[0]).toHaveAttribute("data-status", "done");
    expect(screen.getAllByTestId("import-item")[1]).toHaveAttribute("data-status", "uploading");
    fireEvent.click(retry);
    fireEvent.click(replacementBatch);
    expect(uploadImportBatch).toHaveBeenCalledTimes(2);
    expect(uploadImportBatch).toHaveBeenNthCalledWith(1, [first, second], [image], expect.any(Function));
    expect(uploadImportBatch).toHaveBeenNthCalledWith(2, [second], [image]);
    expect(screen.queryByText("replacement.md")).toBeNull();
    expect(screen.getByTestId("import-ignored")).toHaveTextContent("notes.pdf");

    await act(async () => {
      retryFailure.resolve({
        documents: [],
        failed: [{ index: 0, name: second.name, error: "Second failure reason" }],
      });
    });
    expect(await screen.findByText("Second failure reason")).toBeInTheDocument();
    expect(screen.queryByText("First failure reason")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry failed" })).toBeEnabled();
    expect(onDone).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenLastCalledWith(
      [{ id: "doc-first", title: "First", warnings: ["First warning"] }],
      [{ index: 1, name: "second.md", error: "Second failure reason" }],
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));
    await waitFor(() => expect(screen.getAllByTestId("import-open")).toHaveLength(2));
    const links = screen.getAllByTestId("import-open");
    expect(uploadImportBatch).toHaveBeenCalledTimes(3);
    expect(uploadImportBatch).toHaveBeenNthCalledWith(3, [second], [image]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/d/doc-first", "/d/doc-second"]);
    expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(3);
    expect(onDone).toHaveBeenLastCalledWith(
      [
        { id: "doc-first", title: "First", warnings: ["First warning"] },
        { id: "doc-second", title: "Second", warnings: [] },
      ],
      [],
    );
    expect(onError).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("import-dialog")).toBeNull());
  });

  it("rejects a stale Retry action while a new initial batch owns the upload", async () => {
    const failed = new File(["# Failed"], "failed.md", { type: "text/markdown" });
    const failedImage = new File(["failed image"], "failed.png", { type: "image/png" });
    const fresh = new File(["# Fresh"], "fresh.md", { type: "text/markdown" });
    const freshImage = new File(["fresh image"], "fresh.png", { type: "image/png" });
    const freshUpload = deferred<ImportBatch>();
    const onDone = vi.fn();
    let start!: ReturnType<typeof useFileImport>["start"];
    uploadImportBatch
      .mockResolvedValueOnce({
        documents: [],
        failed: [{ index: 0, name: failed.name, error: "Initial failure" }],
      })
      .mockReturnValueOnce(freshUpload.promise);

    render(
      <Harness
        batches={[[failed, failedImage]]}
        onError={vi.fn()}
        onDone={onDone}
        captureStart={(current) => {
          start = current;
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
    const staleRetry = await screen.findByRole("button", { name: "Retry failed" });

    act(() => {
      void start([fresh, freshImage]);
      staleRetry.click();
    });

    expect(uploadImportBatch).toHaveBeenCalledTimes(2);
    expect(uploadImportBatch).toHaveBeenNthCalledWith(1, [failed], [failedImage]);
    expect(uploadImportBatch).toHaveBeenNthCalledWith(2, [fresh], [freshImage]);
    expect(screen.getByTestId("import-item")).toHaveTextContent("fresh.md");
    expect(screen.getByTestId("import-item")).toHaveAttribute("data-status", "uploading");
    expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("import-dialog")).toBeInTheDocument();

    await act(async () => {
      freshUpload.resolve({ documents: [{ id: "doc-fresh", title: "Fresh", warnings: [] }], failed: [] });
    });
    expect(await screen.findByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-fresh");
    expect(onDone).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenLastCalledWith([{ id: "doc-fresh", title: "Fresh", warnings: [] }], []);
  });
});

describe("useFileImport - stale and independent operations", () => {
  it.each(["resolve", "reject"] as const)(
    "retires an initial %s at the parent layout boundary without releasing the replacement upload",
    async (outcome) => {
      const oldDocument = new File(["# Old"], "old.md", { type: "text/markdown" });
      const oldImage = new File(["old image"], "old.png", { type: "image/png" });
      const newDocument = new File(["# New"], "new.md", { type: "text/markdown" });
      const newImage = new File(["new image"], "new.png", { type: "image/png" });
      const duplicatePick = new File(["# Pick"], "duplicate-pick.md", { type: "text/markdown" });
      const duplicateDrop = new File(["# Drop"], "duplicate-drop.md", { type: "text/markdown" });
      const oldUpload = deferred<ImportBatch>();
      const newUpload = deferred<ImportBatch>();
      const oldOnDone = vi.fn();
      const oldOnError = vi.fn();
      const newOnDone = vi.fn();
      const newOnError = vi.fn();
      uploadImportBatch.mockReturnValueOnce(oldUpload.promise).mockReturnValueOnce(newUpload.promise);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let passiveCleanups = 0;
      let passiveCleanupsAtBoundary = -1;
      const recordPassiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        await act(async () => {
          root.render(
            <ImportLayoutBoundary>
              <Harness
                key="old"
                label="Old"
                batches={[[oldDocument, oldImage]]}
                onError={oldOnError}
                onDone={oldOnDone}
              />
              <Harness
                key="new"
                label="New"
                batches={[[newDocument, newImage]]}
                onError={newOnError}
                onDone={newOnDone}
              />
              <PassiveCleanupProbe onCleanup={recordPassiveCleanup} />
            </ImportLayoutBoundary>,
          );
        });
        const oldBatch = screen.getByRole("button", { name: "Old batch 1" });
        const newBatch = screen.getByRole("button", { name: "New batch 1" });
        fireEvent.click(oldBatch);
        newBatch.click();
        expect(uploadImportBatch).toHaveBeenNthCalledWith(1, [oldDocument], [oldImage]);
        expect(uploadImportBatch).toHaveBeenNthCalledWith(2, [newDocument], [newImage]);

        let boundaryReached!: () => void;
        const atBoundary = new Promise<void>((resolve) => {
          boundaryReached = resolve;
        });
        root.render(
          <ImportLayoutBoundary
            boundary={1}
            onBoundary={() => {
              passiveCleanupsAtBoundary = passiveCleanups;
              if (outcome === "resolve") {
                oldUpload.resolve({ documents: [{ id: "doc-old", title: "Old", warnings: [] }], failed: [] });
              } else {
                oldUpload.reject(new Error("Late old failure"));
              }
              boundaryReached();
            }}
          >
            <Harness
              key="new"
              label="New"
              batches={[[newDocument, newImage]]}
              onError={newOnError}
              onDone={newOnDone}
            />
          </ImportLayoutBoundary>,
        );
        await atBoundary;

        expect(passiveCleanupsAtBoundary).toBe(0);
        expect(uploadImportBatch).toHaveBeenNthCalledWith(2, [newDocument], [newImage]);
        newBatch.click();
        dispatchPickedFiles(screen.getByTestId("import-file-input") as HTMLInputElement, [duplicatePick]);
        dispatchDropFiles([duplicateDrop]);
        expect(uploadImportBatch).toHaveBeenCalledTimes(2);

        await act(async () => {});
        expect(oldOnDone).toHaveBeenCalledTimes(0);
        expect(oldOnError).toHaveBeenCalledTimes(0);
        expect(newOnDone).toHaveBeenCalledTimes(0);
        expect(newOnError).toHaveBeenCalledTimes(0);
        expect(screen.getAllByTestId("import-item")).toHaveLength(1);
        expect(screen.getByTestId("import-item")).toHaveTextContent("new.md");
        expect(screen.getByTestId("import-item")).toHaveAttribute("data-status", "uploading");
        expect(screen.queryByText("Old")).toBeNull();
        expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(screen.getByTestId("import-dialog")).toBeInTheDocument();

        await act(async () => {
          newUpload.resolve({ documents: [{ id: "doc-new", title: "New", warnings: [] }], failed: [] });
        });
        expect(await screen.findByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-new");
        expect(newOnDone).toHaveBeenCalledTimes(1);
        expect(newOnDone).toHaveBeenCalledWith([{ id: "doc-new", title: "New", warnings: [] }], []);
        expect(uploadImportBatch).toHaveBeenCalledTimes(2);
        expect(unhandledRejections).toEqual([]);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "retires a failed-row Retry %s at the parent layout boundary without publishing stale ownership",
    async (outcome) => {
      const oldDocument = new File(["# Old"], "old.md", { type: "text/markdown" });
      const oldImage = new File(["old image"], "old.png", { type: "image/png" });
      const newDocument = new File(["# New"], "new.md", { type: "text/markdown" });
      const newImage = new File(["new image"], "new.png", { type: "image/png" });
      const duplicatePick = new File(["# Pick"], "duplicate-pick.md", { type: "text/markdown" });
      const duplicateDrop = new File(["# Drop"], "duplicate-drop.md", { type: "text/markdown" });
      const oldRetryUpload = deferred<ImportBatch>();
      const newUpload = deferred<ImportBatch>();
      const oldOnDone = vi.fn();
      const oldOnError = vi.fn();
      const newOnDone = vi.fn();
      const newOnError = vi.fn();
      let oldRetry: (() => void) | undefined;
      uploadImportBatch
        .mockResolvedValueOnce({
          documents: [],
          failed: [{ index: 0, name: oldDocument.name, error: "Initial failure" }],
        })
        .mockReturnValueOnce(oldRetryUpload.promise)
        .mockReturnValueOnce(newUpload.promise);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let passiveCleanups = 0;
      let passiveCleanupsAtBoundary = -1;
      const recordPassiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        await act(async () => {
          root.render(
            <ImportLayoutBoundary>
              <Harness
                key="old"
                label="Old"
                batches={[[oldDocument, oldImage]]}
                onError={oldOnError}
                onDone={oldOnDone}
                captureRetry={(retry) => {
                  oldRetry = retry;
                }}
              />
              <Harness
                key="new"
                label="New"
                batches={[[newDocument, newImage]]}
                onError={newOnError}
                onDone={newOnDone}
              />
              <PassiveCleanupProbe onCleanup={recordPassiveCleanup} />
            </ImportLayoutBoundary>,
          );
        });
        const oldBatch = screen.getByRole("button", { name: "Old batch 1" });
        const newBatch = screen.getByRole("button", { name: "New batch 1" });
        fireEvent.click(oldBatch);
        const retryButton = await screen.findByRole("button", { name: "Retry failed" });
        expect(oldRetry).toBeTypeOf("function");
        fireEvent.click(retryButton);
        expect(uploadImportBatch).toHaveBeenCalledTimes(2);
        newBatch.click();
        expect(uploadImportBatch).toHaveBeenNthCalledWith(3, [newDocument], [newImage]);
        oldOnDone.mockClear();
        oldOnError.mockClear();

        let boundaryReached!: () => void;
        const atBoundary = new Promise<void>((resolve) => {
          boundaryReached = resolve;
        });
        root.render(
          <ImportLayoutBoundary
            boundary={1}
            onBoundary={() => {
              passiveCleanupsAtBoundary = passiveCleanups;
              if (outcome === "resolve") {
                oldRetryUpload.resolve({
                  documents: [{ id: "doc-old", title: "Old", warnings: [] }],
                  failed: [],
                });
              } else {
                oldRetryUpload.reject(new Error("Late old Retry failure"));
              }
              boundaryReached();
            }}
          >
            <Harness
              key="new"
              label="New"
              batches={[[newDocument, newImage]]}
              onError={newOnError}
              onDone={newOnDone}
            />
          </ImportLayoutBoundary>,
        );
        await atBoundary;

        expect(passiveCleanupsAtBoundary).toBe(0);
        expect(uploadImportBatch).toHaveBeenNthCalledWith(3, [newDocument], [newImage]);
        oldRetry?.();
        newBatch.click();
        dispatchPickedFiles(screen.getByTestId("import-file-input") as HTMLInputElement, [duplicatePick]);
        dispatchDropFiles([duplicateDrop]);
        expect(uploadImportBatch).toHaveBeenCalledTimes(3);

        await act(async () => {});
        expect(oldOnDone).toHaveBeenCalledTimes(0);
        expect(oldOnError).toHaveBeenCalledTimes(0);
        expect(newOnDone).toHaveBeenCalledTimes(0);
        expect(newOnError).toHaveBeenCalledTimes(0);
        expect(screen.getAllByTestId("import-item")).toHaveLength(1);
        expect(screen.getByTestId("import-item")).toHaveTextContent("new.md");
        expect(screen.getByTestId("import-item")).toHaveAttribute("data-status", "uploading");
        expect(screen.queryByText("Old")).toBeNull();
        expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull();

        await act(async () => {
          newUpload.resolve({ documents: [{ id: "doc-new", title: "New", warnings: [] }], failed: [] });
        });
        expect(await screen.findByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-new");
        expect(newOnDone).toHaveBeenCalledTimes(1);
        expect(newOnDone).toHaveBeenCalledWith([{ id: "doc-new", title: "New", warnings: [] }], []);
        expect(uploadImportBatch).toHaveBeenCalledTimes(3);
        expect(unhandledRejections).toEqual([]);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("allows separate hook instances to own concurrent exact batches", async () => {
    const first = new File(["# First"], "first.md", { type: "text/markdown" });
    const firstImage = new File(["first image"], "first.png", { type: "image/png" });
    const second = new File(["# Second"], "second.md", { type: "text/markdown" });
    const secondImage = new File(["second image"], "second.png", { type: "image/png" });
    const firstUpload = deferred<ImportBatch>();
    const secondUpload = deferred<ImportBatch>();
    const firstDone = vi.fn();
    const secondDone = vi.fn();
    uploadImportBatch.mockReturnValueOnce(firstUpload.promise).mockReturnValueOnce(secondUpload.promise);

    render(
      <>
        <Harness label="First" batches={[[first, firstImage]]} onError={vi.fn()} onDone={firstDone} />
        <Harness label="Second" batches={[[second, secondImage]]} onError={vi.fn()} onDone={secondDone} />
      </>,
    );
    const firstBatch = screen.getByRole("button", { name: "First batch 1" });
    const secondBatch = screen.getByRole("button", { name: "Second batch 1" });
    fireEvent.click(firstBatch);
    fireEvent.click(secondBatch);

    expect(uploadImportBatch).toHaveBeenCalledTimes(2);
    expect(uploadImportBatch).toHaveBeenNthCalledWith(1, [first], [firstImage]);
    expect(uploadImportBatch).toHaveBeenNthCalledWith(2, [second], [secondImage]);
    expect(screen.getAllByTestId("import-item").map((row) => row.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("first.md"), expect.stringContaining("second.md")]),
    );
    for (const close of screen.getAllByRole("button", { name: "Close" })) fireEvent.click(close);
    expect(screen.getAllByTestId("import-dialog")).toHaveLength(2);

    await act(async () => {
      firstUpload.resolve({ documents: [{ id: "doc-first", title: "First", warnings: [] }], failed: [] });
    });
    expect(firstDone).toHaveBeenCalledTimes(1);
    expect(secondDone).not.toHaveBeenCalled();
    fireEvent.click(secondBatch);
    expect(uploadImportBatch).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId("import-item").some((row) => row.getAttribute("data-status") === "uploading")).toBe(true);

    await act(async () => {
      secondUpload.resolve({ documents: [{ id: "doc-second", title: "Second", warnings: [] }], failed: [] });
    });
    expect(secondDone).toHaveBeenCalledTimes(1);
    expect(firstDone).toHaveBeenCalledWith([{ id: "doc-first", title: "First", warnings: [] }], []);
    expect(secondDone).toHaveBeenCalledWith([{ id: "doc-second", title: "Second", warnings: [] }], []);
  });
});

describe("useFileImport - window drag listener ownership", () => {
  it.each([
    { name: "stale before current", order: ["stale", "current"] as const },
    { name: "current before stale", order: ["current", "stale"] as const },
  ])("accepts one replacement drop with $name callback order", async ({ order }) => {
    const tracker = trackWindowDragListeners();
    const file = new File(["# Current"], "current.md", { type: "text/markdown" });
    const oldOnDone = vi.fn();
    const oldOnError = vi.fn();
    const currentOnDone = vi.fn();
    const currentOnError = vi.fn();
    uploadImportBatch.mockResolvedValueOnce({
      documents: [{ id: "doc-current", title: "Current", warnings: [] }],
      failed: [],
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<DragImportBoundary instance="A" onError={oldOnError} onDone={oldOnDone} />);
      });
      const stale = captureDragOwner(tracker, 0);
      for (const type of WINDOW_DRAG_TYPES) {
        expect(tracker.added[type]).toHaveLength(1);
        expect(tracker.active[type]).toEqual(new Set([stale[type]]));
      }

      let staleActiveAtBoundary: boolean[] = [];
      await act(async () => {
        root.render(
          <DragImportBoundary
            instance="B"
            boundary={1}
            onBoundary={() => {
              staleActiveAtBoundary = WINDOW_DRAG_TYPES.map((type) => tracker.active[type].has(stale[type]));
            }}
            onError={currentOnError}
            onDone={currentOnDone}
          />,
        );
      });
      const current = captureDragOwner(tracker, 1);

      expect(staleActiveAtBoundary).toEqual([false, false, false, false]);
      for (const type of WINDOW_DRAG_TYPES) {
        expect(tracker.added[type]).toEqual([stale[type], current[type]]);
        expect(tracker.removed[type]).toEqual([stale[type]]);
        expect(tracker.active[type]).toEqual(new Set([current[type]]));
      }

      const dropped = trackedDragEvent("drop", [file]);
      await act(async () => {
        for (const callback of order) {
          if (callback === "stale") stale.drop(dropped.event);
          else current.drop(dropped.event);
        }
        await Promise.resolve();
      });

      expect(dropped.preventDefault).toHaveBeenCalledTimes(1);
      expect(dropped.dropEffectWrites).toEqual([]);
      expect(uploadImportBatch).toHaveBeenCalledTimes(1);
      expect(uploadImportBatch).toHaveBeenCalledWith([file], []);
      expect(oldOnDone).not.toHaveBeenCalled();
      expect(oldOnError).not.toHaveBeenCalled();
      expect(currentOnError).not.toHaveBeenCalled();
      expect(currentOnDone).toHaveBeenCalledOnce();
      expect(currentOnDone).toHaveBeenCalledWith([{ id: "doc-current", title: "Current", warnings: [] }], []);
      expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/d/doc-current");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }

    for (const type of WINDOW_DRAG_TYPES) {
      expect(tracker.active[type].size).toBe(0);
      expect(tracker.removed[type]).toEqual(tracker.added[type]);
      expect(new Set(tracker.added[type]).size).toBe(2);
    }
  });

  it("routes a boundary drop to B and preserves B listeners, depth, options, and picker ownership", async () => {
    const tracker = trackWindowDragListeners();
    const dropped = new File(["# Dropped"], "dropped.md", { type: "text/markdown" });
    const picked = new File(["# Picked"], "picked.md", { type: "text/markdown" });
    const duplicate = new File(["# Duplicate"], "duplicate.md", { type: "text/markdown" });
    const oldOnDone = vi.fn();
    const oldOnError = vi.fn();
    const firstCurrentOnDone = vi.fn();
    const firstCurrentOnError = vi.fn();
    const latestOnDone = vi.fn();
    const latestOnError = vi.fn();
    uploadImportBatch.mockResolvedValueOnce({
      documents: [{ id: "doc-dropped", title: "Dropped", warnings: [] }],
      failed: [],
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<DragImportBoundary instance="A" onError={oldOnError} onDone={oldOnDone} />);
      });
      const stale = captureDragOwner(tracker, 0);
      const boundaryDrop = trackedDragEvent("drop", [dropped]);
      let staleActiveAtBoundary: boolean[] = [];

      await act(async () => {
        root.render(
          <DragImportBoundary
            instance="B"
            boundary={1}
            onBoundary={() => {
              staleActiveAtBoundary = WINDOW_DRAG_TYPES.map((type) => tracker.active[type].has(stale[type]));
              window.dispatchEvent(boundaryDrop.event);
            }}
            onError={firstCurrentOnError}
            onDone={firstCurrentOnDone}
          />,
        );
        await Promise.resolve();
      });
      const current = captureDragOwner(tracker, 1);

      expect(staleActiveAtBoundary).toEqual([false, false, false, false]);
      expect(boundaryDrop.preventDefault).toHaveBeenCalledOnce();
      expect(uploadImportBatch).toHaveBeenCalledTimes(1);
      expect(uploadImportBatch).toHaveBeenNthCalledWith(1, [dropped], []);
      expect(firstCurrentOnDone).toHaveBeenCalledWith([{ id: "doc-dropped", title: "Dropped", warnings: [] }], []);
      expect(oldOnDone).not.toHaveBeenCalled();
      expect(oldOnError).not.toHaveBeenCalled();
      for (const type of WINDOW_DRAG_TYPES) {
        expect(tracker.active[type]).toEqual(new Set([current[type]]));
      }

      const fileOver = trackedDragEvent("dragover", [dropped]);
      act(() => {
        window.dispatchEvent(fileOver.event);
      });
      expect(fileOver.preventDefault).toHaveBeenCalledOnce();
      expect(fileOver.dropEffectWrites).toEqual(["copy"]);

      const firstEnter = trackedDragEvent("dragenter", [dropped]);
      act(() => {
        window.dispatchEvent(firstEnter.event);
      });
      expect(screen.getByTestId("dragging-B")).toHaveAttribute("data-active", "true");

      const callsBeforeNonFiles = uploadImportBatch.mock.calls.length;
      for (const type of ["dragenter", "dragover", "dragleave"] as const) {
        const nonFile = trackedDragEvent(type, [], false);
        act(() => {
          window.dispatchEvent(nonFile.event);
        });
        expect(nonFile.preventDefault).not.toHaveBeenCalled();
        expect(nonFile.dropEffectWrites).toEqual([]);
        expect(screen.getByTestId("dragging-B")).toHaveAttribute("data-active", "true");
      }
      const nonFileDrop = trackedDragEvent("drop", [], false);
      act(() => {
        window.dispatchEvent(nonFileDrop.event);
      });
      expect(nonFileDrop.preventDefault).not.toHaveBeenCalled();
      expect(nonFileDrop.dropEffectWrites).toEqual([]);
      expect(uploadImportBatch).toHaveBeenCalledTimes(callsBeforeNonFiles);
      expect(screen.getByTestId("dragging-B")).toHaveAttribute("data-active", "false");

      act(() => {
        window.dispatchEvent(trackedDragEvent("dragenter", [dropped]).event);
        window.dispatchEvent(trackedDragEvent("dragenter", [dropped]).event);
      });
      expect(screen.getByTestId("dragging-B")).toHaveAttribute("data-active", "true");

      await act(async () => {
        root.render(
          <DragImportBoundary
            instance="B"
            boundary={2}
            onError={latestOnError}
            onDone={latestOnDone}
          />,
        );
      });
      for (const type of WINDOW_DRAG_TYPES) {
        expect(tracker.added[type]).toEqual([stale[type], current[type]]);
        expect(tracker.active[type]).toEqual(new Set([current[type]]));
      }
      expect(screen.getByTestId("dragging-B")).toHaveAttribute("data-active", "true");

      act(() => {
        window.dispatchEvent(trackedDragEvent("dragleave", [dropped]).event);
      });
      expect(screen.getByTestId("dragging-B")).toHaveAttribute("data-active", "true");
      act(() => {
        window.dispatchEvent(trackedDragEvent("dragleave", [dropped]).event);
      });
      expect(screen.getByTestId("dragging-B")).toHaveAttribute("data-active", "false");

      const pickerUpload = deferred<ImportBatch>();
      uploadImportBatch.mockReturnValueOnce(pickerUpload.promise);
      act(() => {
        dispatchPickedFiles(screen.getByTestId("import-file-input") as HTMLInputElement, [picked]);
      });
      expect(uploadImportBatch).toHaveBeenCalledTimes(2);
      expect(uploadImportBatch).toHaveBeenNthCalledWith(2, [picked], []);
      for (const type of WINDOW_DRAG_TYPES) {
        expect(tracker.added[type]).toHaveLength(2);
        expect(tracker.active[type]).toEqual(new Set([current[type]]));
      }

      const duplicateDrop = trackedDragEvent("drop", [duplicate]);
      act(() => {
        window.dispatchEvent(duplicateDrop.event);
      });
      expect(duplicateDrop.preventDefault).toHaveBeenCalledOnce();
      expect(uploadImportBatch).toHaveBeenCalledTimes(2);

      await act(async () => {
        pickerUpload.resolve({
          documents: [{ id: "doc-picked", title: "Picked", warnings: [] }],
          failed: [],
        });
      });
      expect(latestOnDone).toHaveBeenCalledOnce();
      expect(latestOnDone).toHaveBeenCalledWith([{ id: "doc-picked", title: "Picked", warnings: [] }], []);
      expect(latestOnError).not.toHaveBeenCalled();
      expect(firstCurrentOnDone).toHaveBeenCalledOnce();
      expect(firstCurrentOnError).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }

    for (const type of WINDOW_DRAG_TYPES) {
      expect(tracker.active[type].size).toBe(0);
      expect(tracker.removed[type]).toEqual(tracker.added[type]);
    }
  });

  it("retires removed callbacks before the boundary without disturbing a remounted owner", async () => {
    const tracker = trackWindowDragListeners();
    const file = new File(["# Notes"], "notes.md", { type: "text/markdown" });
    const oldOnDone = vi.fn();
    const oldOnError = vi.fn();
    const currentOnDone = vi.fn();
    const currentOnError = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<DragImportBoundary instance="A" onError={oldOnError} onDone={oldOnDone} />);
      });
      const stale = captureDragOwner(tracker, 0);
      let staleActiveAtBoundary: boolean[] = [];

      await act(async () => {
        root.render(
          <DragImportBoundary
            instance="A"
            present={false}
            boundary={1}
            onBoundary={() => {
              staleActiveAtBoundary = WINDOW_DRAG_TYPES.map((type) => tracker.active[type].has(stale[type]));
            }}
            onError={oldOnError}
            onDone={oldOnDone}
          />,
        );
      });
      expect(staleActiveAtBoundary).toEqual([false, false, false, false]);
      for (const type of WINDOW_DRAG_TYPES) {
        expect(tracker.active[type].size).toBe(0);
        expect(tracker.removed[type]).toEqual([stale[type]]);
      }

      await act(async () => {
        root.render(
          <DragImportBoundary
            instance="B"
            boundary={2}
            onError={currentOnError}
            onDone={currentOnDone}
          />,
        );
      });
      const current = captureDragOwner(tracker, 1);
      act(() => {
        current.dragenter(trackedDragEvent("dragenter", [file]).event);
        current.dragenter(trackedDragEvent("dragenter", [file]).event);
      });
      expect(screen.getByTestId("dragging-B")).toHaveAttribute("data-active", "true");

      const staleEnter = trackedDragEvent("dragenter", [file]);
      const staleOver = trackedDragEvent("dragover", [file]);
      const staleLeave = trackedDragEvent("dragleave", [file]);
      const staleDrop = trackedDragEvent("drop", [file]);
      act(() => {
        stale.dragenter(staleEnter.event);
        stale.dragover(staleOver.event);
        stale.dragleave(staleLeave.event);
        stale.drop(staleDrop.event);
      });

      for (const event of [staleEnter, staleOver, staleLeave, staleDrop]) {
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.dropEffectWrites).toEqual([]);
      }
      expect(uploadImportBatch).not.toHaveBeenCalled();
      expect(oldOnDone).not.toHaveBeenCalled();
      expect(oldOnError).not.toHaveBeenCalled();
      expect(currentOnDone).not.toHaveBeenCalled();
      expect(currentOnError).not.toHaveBeenCalled();
      expect(screen.getByTestId("dragging-B")).toHaveAttribute("data-active", "true");
      for (const type of WINDOW_DRAG_TYPES) {
        expect(tracker.active[type]).toEqual(new Set([current[type]]));
      }

      act(() => {
        current.dragleave(trackedDragEvent("dragleave", [file]).event);
      });
      expect(screen.getByTestId("dragging-B")).toHaveAttribute("data-active", "true");
      act(() => {
        current.dragleave(trackedDragEvent("dragleave", [file]).event);
      });
      expect(screen.getByTestId("dragging-B")).toHaveAttribute("data-active", "false");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }

    for (const type of WINDOW_DRAG_TYPES) {
      expect(tracker.active[type].size).toBe(0);
      expect(tracker.removed[type]).toEqual(tracker.added[type]);
    }
  });
});

describe("useFileImport - request errors", () => {
  it("shows the server validation reason on the row and in the callback", async () => {
    uploadImportBatch.mockRejectedValueOnce(
      new ApiError(400, "Invalid request", [{ path: ["files"], message: "Import at most 20 files at a time" }]),
    );
    const onError = vi.fn();
    const file = new File(["# Notes"], "notes.md", { type: "text/markdown" });
    render(<Harness batches={[[file]]} onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));

    const item = await screen.findByTestId("import-item");
    expect(await screen.findByText("Import at most 20 files at a time")).toBeInTheDocument();
    expect(item).toHaveAttribute("data-status", "error");
    expect(screen.queryByText("Invalid request")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry failed" })).toBeEnabled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("Import at most 20 files at a time");
  });
});

describe("useFileImport - per-file progress (#2340)", () => {
  it("settles each row as its own request answers, before the batch finishes", async () => {
    const first = new File(["# First"], "first.md", { type: "text/markdown" });
    const second = new File(["# Second"], "second.md", { type: "text/markdown" });
    const rest = deferred<ImportBatch>();
    let progress: ((index: number, outcome: { document: ImportedDocument } | { error: unknown }) => void) | undefined;
    uploadImportBatch.mockImplementationOnce((_docs: File[], _images: File[], onProgress: typeof progress) => {
      progress = onProgress;
      return rest.promise;
    });
    render(<Harness batches={[[first, second]]} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Import batch 1" }));
    const document = { id: "first", title: "First", warnings: [] };
    act(() => progress?.(0, { document }));
    const [firstRow, secondRow] = screen.getAllByTestId("import-item");
    expect(firstRow).toHaveAttribute("data-status", "done");
    expect(secondRow).toHaveAttribute("data-status", "uploading");
    await act(async () => {
      rest.resolve({ documents: [document], failed: [{ index: 1, name: second.name, error: "Too big" }] });
    });
    expect(screen.getAllByTestId("import-item")[1]).toHaveAttribute("data-status", "error");
  });
});

describe("shouldOpenImported (#2292)", () => {
  const document = (warnings: string[] = []): ImportedDocument => ({ id: "d", title: "D", warnings });
  it("opens one imported file without warnings straight away", () => {
    expect(shouldOpenImported([document()], [])).toBe(true);
  });
  it("keeps the dialog with the warning when the one file lost an image", () => {
    expect(shouldOpenImported([document(["“beach.png”: Images must be 5 MB or smaller"])], [])).toBe(false);
  });
  it("keeps the dialog for several files or a failure", () => {
    expect(shouldOpenImported([document(), document()], [])).toBe(false);
    expect(shouldOpenImported([document()], [{ index: 1, name: "b.md", error: "x" }])).toBe(false);
  });
});
