// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { createRoot } from "react-dom/client";
import type { FailedImport, ImportedDocument, ImportBatch } from "@/lib/import-upload";

const uploadImportBatch = vi.fn();
vi.mock("@/lib/import-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/import-upload")>()),
  uploadImportBatch: (...args: unknown[]) => uploadImportBatch(...args),
}));

import { ApiError } from "@/lib/api";
import { ImportDialog, type ImportItem, useFileImport } from "./import-dialog";

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

function reactRef<T extends HTMLElement>(element: T): RefCallback<T> {
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error(`React fiber was not attached to ${element.tagName}`);
  const fiber = (element as unknown as Record<string, { ref?: unknown } | undefined>)[fiberKey];
  if (typeof fiber?.ref !== "function") throw new Error(`A callback ref was not attached to ${element.tagName}`);
  return fiber.ref as RefCallback<T>;
}

function captureResultOpen(index = 0): CapturedResultControl<HTMLAnchorElement> {
  const element = screen.getAllByTestId("import-open")[index] as HTMLAnchorElement | undefined;
  if (!element) throw new Error(`Open control ${index} was not rendered`);
  return { element, onClick: reactProp<ResultClick<HTMLAnchorElement>>(element, "onClick") };
}

function captureResultRetry(): CapturedResultControl<HTMLButtonElement> {
  const element = screen.getByTestId("import-retry") as HTMLButtonElement;
  return { element, onClick: reactProp<ResultClick<HTMLButtonElement>>(element, "onClick") };
}

function captureResultRowRetry(index = 0): CapturedResultControl<HTMLButtonElement> {
  const element = screen.getAllByTestId("import-row-retry")[index] as HTMLButtonElement | undefined;
  if (!element) throw new Error(`Row Retry control ${index} was not rendered`);
  return { element, onClick: reactProp<ResultClick<HTMLButtonElement>>(element, "onClick") };
}

type ResultKeyDown = (
  event: ReactKeyboardEvent<HTMLElement>,
) => void;

interface CapturedResultNavigationControl {
  readonly element: HTMLElement;
  readonly onKeyDownCapture: ResultKeyDown;
  readonly onKeyDown: ResultKeyDown;
}

function captureResultNavigationControls(
  container: ParentNode = document,
): CapturedResultNavigationControl[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-testid="import-open"], [data-testid="import-row-retry"], [data-testid="import-retry"]',
    ),
  ).map((element) => ({
    element,
    onKeyDownCapture: reactProp<ResultKeyDown>(
      element,
      "onKeyDownCapture",
    ),
    onKeyDown: reactProp<ResultKeyDown>(element, "onKeyDown"),
  }));
}

function markResultKeyTrusted(event: KeyboardEvent) {
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
    throw new Error("Unable to set jsdom's internal event trust slot");
  }
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  if (!event.isTrusted) {
    throw new Error("The jsdom event trust slot did not update");
  }
}

function dispatchResultKey(
  source: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
  focus = true,
) {
  if (focus) source.focus();
  const ownerWindow = source.ownerDocument.defaultView;
  if (!ownerWindow) {
    throw new Error("The import result action has no owner window");
  }
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code: key,
    key,
    ...init,
  });
  if (trusted) markResultKeyTrusted(event);
  let allowed = true;
  act(() => {
    allowed = source.dispatchEvent(event);
  });
  return { allowed, event };
}

function dispatchResultKeyWithBoundaryProbe(
  source: HTMLElement,
  key: string,
  alter?: (
    phase: "capture-before" | "capture-after" | "bubble-before",
    event: ReactKeyboardEvent<HTMLElement>,
  ) => void,
  focus = true,
) {
  const propsKey = Object.keys(source).find((key) =>
    key.startsWith("__reactProps$"));
  if (!propsKey) {
    throw new Error(`React props were not attached to ${source.tagName}`);
  }
  const record = source as unknown as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const props = record[propsKey];
  const captureHandler = props?.onKeyDownCapture;
  const bubbleHandler = props?.onKeyDown;
  if (
    !props ||
    typeof captureHandler !== "function" ||
    typeof bubbleHandler !== "function"
  ) {
    throw new Error("Both result keyboard boundaries must be attached");
  }
  const pair: {
    capture?: ReactKeyboardEvent<HTMLElement>;
    bubble?: ReactKeyboardEvent<HTMLElement>;
  } = {};
  const replacement = {
    ...props,
    onKeyDownCapture: (event: ReactKeyboardEvent<HTMLElement>) => {
      pair.capture = event;
      alter?.("capture-before", event);
      (captureHandler as ResultKeyDown)(event);
      alter?.("capture-after", event);
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      pair.bubble = event;
      alter?.("bubble-before", event);
      (bubbleHandler as ResultKeyDown)(event);
    },
  };
  record[propsKey] = replacement;
  if (focus) source.focus();
  const ownerWindow = source.ownerDocument.defaultView;
  if (!ownerWindow) {
    throw new Error("The import result action has no owner window");
  }
  const nativeEvent = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code: key,
    key,
  });
  markResultKeyTrusted(nativeEvent);
  try {
    act(() => {
      source.dispatchEvent(nativeEvent);
    });
  } finally {
    if (record[propsKey] === replacement) record[propsKey] = props;
  }
  if (!pair.capture || !pair.bubble) {
    throw new Error("The key did not cross both result boundaries");
  }
  return {
    nativeEvent,
    capture: pair.capture,
    bubble: pair.bubble,
  };
}

function interceptResultKeyDown(
  element: HTMLElement,
  invoke: (
    original: ResultKeyDown,
    event: ReactKeyboardEvent<HTMLElement>,
  ) => void,
) {
  const propsKey = Object.keys(element).find((key) =>
    key.startsWith("__reactProps$"));
  if (!propsKey) {
    throw new Error(`React props were not attached to ${element.tagName}`);
  }
  const record = element as unknown as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const props = record[propsKey];
  const original = props?.onKeyDown;
  if (!props || typeof original !== "function") {
    throw new Error(`onKeyDown was not attached to ${element.tagName}`);
  }
  record[propsKey] = {
    ...props,
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) =>
      invoke(original as ResultKeyDown, event),
  };
  return () => {
    record[propsKey] = props;
  };
}

interface CapturedResultControlView {
  element: HTMLElement;
  onClick: ResultClick<HTMLAnchorElement> | ResultClick<HTMLButtonElement>;
  invoke: (currentTarget?: HTMLElement) => ResultMouseEvent<HTMLElement>;
}

function captureResultControl(kind: "Open" | "Retry"): CapturedResultControlView {
  if (kind === "Open") {
    const control = captureResultOpen();
    return {
      element: control.element,
      onClick: control.onClick,
      invoke: (currentTarget = control.element) => {
        if (!(currentTarget instanceof HTMLAnchorElement)) {
          throw new Error("Open requires an anchor target");
        }
        return invokeResultControl(control, currentTarget);
      },
    };
  }
  const control = captureResultRetry();
  return {
    element: control.element,
    onClick: control.onClick,
    invoke: (currentTarget = control.element) => {
      if (!(currentTarget instanceof HTMLButtonElement)) {
        throw new Error("Retry requires a button target");
      }
      return invokeResultControl(control, currentTarget);
    },
  };
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

function StatefulResultDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <ImportDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        setOpen(next);
      }}
      items={[
        {
          name: "native.md",
          status: "done",
          id: "native-document",
          title: "Native",
          warnings: [],
        },
      ]}
      ignored={[]}
    />
  );
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
    expect(warning.className).toBe("import-warning");
    expect(warning.textContent).toBe(" Kept warning");
    const open = captureResultOpen();
    expect(open.element.tagName).toBe("A");
    expect(open.element.className).toBe("import-open");
    expect(open.element.textContent).toBe("Open");
    expect(open.element).toHaveAttribute("href", "/d/notes");
    for (let attempt = 0; attempt < 2; attempt++) {
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
    expect(uploadImportBatch).toHaveBeenCalledExactlyOnceWith([first, second, third], []);
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
    expect(warning.className).toBe("import-warning");
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
    const originalRetry = captureResultRowRetry();
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
      invokeResultControl(originalRetry, captureResultRowRetry().element);
      expect(retry).not.toHaveBeenCalled();
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
    invokeResultControl(originalRetry, captureResultRowRetry().element);
    expect(retry).not.toHaveBeenCalled();
    const current = captureResultRowRetry();
    invokeResultControl(current);
    invokeResultControl(current);
    expect(retry).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(uploadImportBatch).not.toHaveBeenCalled();
  });

  it.each(["close", "replacement"] as const)("retires wrapped-row actions across %s without affecting the next row", (change) => {
    const oldRetry = vi.fn();
    const nextRetry = vi.fn();
    const onOpenChange = vi.fn();
    const [success, failed] = resultItems(oldRetry);
    const oldItem = { ...failed, error: "o".repeat(300) };
    const dialog = (open: boolean, item: ImportItem) => (
      <StrictMode>
        <ImportDialog key={item.name} open={open} onOpenChange={onOpenChange} items={[success, item]} ignored={[]} />
      </StrictMode>
    );
    const view = render(dialog(true, oldItem));
    const rows = screen.getAllByTestId("import-item");
    const neighborHtml = rows[0].outerHTML;
    expectImportError(rows[1], oldItem.error);
    const retired = captureResultRowRetry();
    const nextItem = { ...failed, name: change === "replacement" ? "replacement.md" : failed.name, error: "n".repeat(300), retry: nextRetry };
    if (change === "close") {
      view.rerender(dialog(false, oldItem));
      expect(screen.queryByTestId("import-dialog")).toBeNull();
      invokeResultControl(retired);
      expect(oldRetry).not.toHaveBeenCalled();
    }
    view.rerender(dialog(true, nextItem));
    const currentRows = screen.getAllByTestId("import-item");
    expect(rows[1]).not.toBeInTheDocument();
    expect(currentRows[0].outerHTML).toBe(neighborHtml);
    expectImportError(currentRows[1], nextItem.error);
    const current = captureResultRowRetry();
    invokeResultControl(retired);
    invokeResultControl(retired, current.element);
    expect(oldRetry).not.toHaveBeenCalled();
    expect(nextRetry).not.toHaveBeenCalled();
    invokeResultControl(current);
    invokeResultControl(current);
    expect(nextRetry).toHaveBeenCalledOnce();
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

describe("ImportDialog result action keyboard navigation", () => {
  const navigationItems = (
    retry: () => void,
    retryAll: () => void,
  ): ImportItem[] => [
    {
      name: "opened.md",
      status: "done",
      id: "opened",
      warnings: [],
    },
    {
      name: "failed.md",
      status: "error",
      error: "Failed",
      retry,
      retryAll,
      warnings: [],
    },
    {
      name: "finished.md",
      status: "done",
      id: "finished",
      warnings: [],
    },
  ];

  it("pairs distinct genuine React capture and bubble wrappers for one native key", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const retry = vi.fn();
    const retryAll = vi.fn();
    try {
      act(() => {
        root.render(
          <StrictMode>
            <ImportDialog
              open
              onOpenChange={vi.fn()}
              items={navigationItems(retry, retryAll)}
              ignored={[]}
            />
          </StrictMode>,
        );
      });
      const controls = captureResultNavigationControls();
      const source = controls[0]!.element;
      const pair = dispatchResultKeyWithBoundaryProbe(
        source,
        "ArrowDown",
      );

      expect(pair.capture).not.toBe(pair.bubble);
      expect(pair.capture.nativeEvent).toBe(pair.nativeEvent);
      expect(pair.bubble.nativeEvent).toBe(pair.nativeEvent);
      expect(pair.capture.isDefaultPrevented()).toBe(false);
      expect(pair.bubble.isDefaultPrevented()).toBe(true);
      expect(pair.nativeEvent.defaultPrevented).toBe(true);
      expect(controls[1]!.element).toHaveFocus();
      expect(retry).not.toHaveBeenCalled();
      expect(retryAll).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("accepts legitimate distinct wrappers with different prototype identities", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const retry = vi.fn();
    const retryAll = vi.fn();
    try {
      act(() => {
        root.render(
          <StrictMode>
            <ImportDialog
              open
              onOpenChange={vi.fn()}
              items={navigationItems(retry, retryAll)}
              ignored={[]}
            />
          </StrictMode>,
        );
      });
      const controls = captureResultNavigationControls();
      const pair = dispatchResultKeyWithBoundaryProbe(
        controls[0]!.element,
        "ArrowDown",
        (phase, event) => {
          if (phase.endsWith("before")) {
            Object.setPrototypeOf(
              event,
              Object.create(Object.getPrototypeOf(event)),
            );
          }
        },
      );

      expect(pair.capture).not.toBe(pair.bubble);
      expect(Object.getPrototypeOf(pair.capture)).not.toBe(
        Object.getPrototypeOf(pair.bubble),
      );
      expect(pair.capture.nativeEvent).toBe(pair.nativeEvent);
      expect(pair.bubble.nativeEvent).toBe(pair.nativeEvent);
      expect(pair.nativeEvent.defaultPrevented).toBe(true);
      expect(controls[1]!.element).toHaveFocus();
      expect(retry).not.toHaveBeenCalled();
      expect(retryAll).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it.each([
    ["capture", "capture-after", "isDefaultPrevented"],
  ] as const)(
    "rejects %s predicate-method drift before claim and admits a clean successor",
    (_boundary, alteredPhase, property) => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const retry = vi.fn();
      const retryAll = vi.fn();
      try {
        act(() => {
          root.render(
            <StrictMode>
              <ImportDialog
                open
                onOpenChange={vi.fn()}
                items={navigationItems(retry, retryAll)}
                ignored={[]}
              />
            </StrictMode>,
          );
        });
        const controls = captureResultNavigationControls();
        const source = controls[0]!.element;
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();
        const rejected = dispatchResultKeyWithBoundaryProbe(
          source,
          "ArrowDown",
          (phase, event) => {
            if (phase !== alteredPhase) return;
            Object.defineProperty(event, property, {
              configurable: true,
              enumerable: true,
              value: () => false,
              writable: true,
            });
          },
          false,
        );

        expect(rejected.nativeEvent.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(source).toHaveFocus();

        const accepted = dispatchResultKey(
          source,
          "ArrowDown",
          {},
          true,
          false,
        );
        expect(accepted.allowed).toBe(false);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledOnce();
        expect(controls[1]!.element).toHaveFocus();
        expect(retry).not.toHaveBeenCalled();
        expect(retryAll).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        host.remove();
        preventDefault.mockRestore();
        focus.mockRestore();
      }
    },
  );

  it("accepts independent public phase methods, scalar accessors, and irrelevant private fields", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const retry = vi.fn();
    const retryAll = vi.fn();
    const methodIdentities = new Map<
      string,
      Record<
        "preventDefault" | "isDefaultPrevented" | "isPropagationStopped",
        (...args: never[]) => unknown
      >
    >();
    const receivers: object[] = [];
    try {
      act(() => {
        root.render(
          <StrictMode>
            <ImportDialog
              open
              onOpenChange={vi.fn()}
              items={navigationItems(retry, retryAll)}
              ignored={[]}
            />
          </StrictMode>,
        );
      });
      const controls = captureResultNavigationControls();
      const pair = dispatchResultKeyWithBoundaryProbe(
        controls[0]!.element,
        "ArrowDown",
        (phase, event) => {
          if (!phase.endsWith("before")) return;
          const key = event.key;
          const code = event.code;
          Object.defineProperties(event, {
            key: {
              configurable: true,
              enumerable: true,
              get: () => key,
            },
            code: {
              configurable: true,
              enumerable: true,
              get: () => code,
            },
            _reactName: {
              configurable: true,
              value: null,
            },
            persist: {
              configurable: true,
              value: "not a function",
            },
            isPersistent: {
              configurable: true,
              value: undefined,
            },
            stopPropagation: {
              configurable: true,
              value: { ignored: true },
            },
          });
          const originals = {
            preventDefault: event.preventDefault,
            isDefaultPrevented: event.isDefaultPrevented,
            isPropagationStopped: event.isPropagationStopped,
          };
          const replacements = Object.fromEntries(
            Object.entries(originals).map(([name, original]) => [
              name,
              function (this: object) {
                receivers.push(this);
                return Reflect.apply(original, this, []);
              },
            ]),
          ) as Record<
            keyof typeof originals,
            (...args: never[]) => unknown
          >;
          for (const [name, replacement] of Object.entries(replacements)) {
            Object.defineProperty(event, name, {
              configurable: true,
              enumerable: true,
              value: replacement,
              writable: true,
            });
          }
          methodIdentities.set(phase, replacements);
        },
      );

      expect(methodIdentities.get("capture-before")).toBeDefined();
      expect(methodIdentities.get("bubble-before")).toBeDefined();
      expect(methodIdentities.get("capture-before")?.preventDefault).not.toBe(
        methodIdentities.get("bubble-before")?.preventDefault,
      );
      expect(receivers.length).toBeGreaterThanOrEqual(5);
      expect(
        receivers.every(
          (receiver) => receiver === pair.capture || receiver === pair.bubble,
        ),
      ).toBe(true);
      expect(pair.nativeEvent.defaultPrevented).toBe(true);
      expect(controls[1]!.element).toHaveFocus();
      expect(retry).not.toHaveBeenCalled();
      expect(retryAll).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it.each([
    ["capture query", "capture-before", "isDefaultPrevented"],
    ["bubble query", "bubble-before", "isDefaultPrevented"],
    ["prevention", "bubble-before", "preventDefault"],
  ] as const)(
    "rejects a throwing public %s without poisoning a clean successor",
    (_attempt, alteredPhase, property) => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        act(() => {
          root.render(
            <StrictMode>
              <ImportDialog
                open
                onOpenChange={vi.fn()}
                items={navigationItems(vi.fn(), vi.fn())}
                ignored={[]}
              />
            </StrictMode>,
          );
        });
        const controls = captureResultNavigationControls();
        const source = controls[0]!.element;
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();
        const rejected = dispatchResultKeyWithBoundaryProbe(
          source,
          "ArrowDown",
          (phase, event) => {
            if (phase !== alteredPhase) return;
            Object.defineProperty(event, property, {
              configurable: true,
              enumerable: true,
              value: () => {
                throw new Error("hostile public method");
              },
              writable: true,
            });
          },
          false,
        );

        expect(rejected.nativeEvent.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(source).toHaveFocus();

        const accepted = dispatchResultKey(
          source,
          "ArrowDown",
          {},
          true,
          false,
        );
        expect(accepted.allowed).toBe(false);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledOnce();
        expect(controls[1]!.element).toHaveFocus();
      } finally {
        act(() => root.unmount());
        host.remove();
        preventDefault.mockRestore();
        focus.mockRestore();
      }
    },
  );

  it.each(["preventDefault", "isPropagationStopped"] as const)(
    "rejects %s identity drift during public prevention before focus",
    (property) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        act(() => {
          root.render(
            <StrictMode>
              <ImportDialog
                open
                onOpenChange={vi.fn()}
                items={navigationItems(vi.fn(), vi.fn())}
                ignored={[]}
              />
            </StrictMode>,
          );
        });
        const controls = captureResultNavigationControls();
        const source = controls[0]!.element;
        source.focus();
        focus.mockClear();
        const rejected = dispatchResultKeyWithBoundaryProbe(
          source,
          "ArrowDown",
          (phase, event) => {
            if (phase !== "bubble-before") return;
            const originalPreventDefault = event.preventDefault;
            Object.defineProperty(event, "preventDefault", {
              configurable: true,
              enumerable: true,
              value: function (this: ReactKeyboardEvent<HTMLElement>) {
                Reflect.apply(originalPreventDefault, this, []);
                Object.defineProperty(this, property, {
                  configurable: true,
                  enumerable: true,
                  value: () => false,
                  writable: true,
                });
              },
              writable: true,
            });
          },
          false,
        );

        expect(rejected.nativeEvent.defaultPrevented).toBe(true);
        expect(focus).not.toHaveBeenCalled();
        expect(source).toHaveFocus();

        const accepted = dispatchResultKey(
          source,
          "ArrowDown",
          {},
          true,
          false,
        );
        expect(accepted.allowed).toBe(false);
        expect(focus).toHaveBeenCalledOnce();
        expect(controls[1]!.element).toHaveFocus();
      } finally {
        act(() => root.unmount());
        host.remove();
        focus.mockRestore();
      }
    },
  );

  it("keeps an exact pair across nested microtask checkpoints between React phases", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let checkpoint: ReturnType<typeof vi.spyOn> | null = null;
    try {
      act(() => {
        root.render(
          <StrictMode>
            <ImportDialog
              open
              onOpenChange={vi.fn()}
              items={navigationItems(vi.fn(), vi.fn())}
              ignored={[]}
            />
          </StrictMode>,
        );
      });
      checkpoint = vi
        .spyOn(window, "queueMicrotask")
        .mockImplementation((callback: VoidFunction) => callback());
      const controls = captureResultNavigationControls();
      const pair = dispatchResultKeyWithBoundaryProbe(
        controls[0]!.element,
        "ArrowDown",
        (phase) => {
          if (phase !== "capture-after") return;
          window.queueMicrotask(() => {
            window.queueMicrotask(() => undefined);
          });
        },
      );

      expect(checkpoint.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(pair.nativeEvent.defaultPrevented).toBe(true);
      expect(controls[1]!.element).toHaveFocus();
    } finally {
      act(() => root.unmount());
      host.remove();
      checkpoint?.mockRestore();
    }
  });

  it("accepts the real Window backing receiver and rejects a receiver lookalike", () => {
    const additions = vi.spyOn(window, "addEventListener");
    const removals = vi.spyOn(window, "removeEventListener");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const retry = vi.fn();
    const retryAll = vi.fn();
    try {
      act(() => {
        root.render(
          <StrictMode>
            <ImportDialog
              open
              onOpenChange={vi.fn()}
              items={navigationItems(retry, retryAll)}
              ignored={[]}
            />
          </StrictMode>,
        );
      });
      const listener = additions.mock.calls
        .filter(
          ([type, candidate, options]) =>
            type === "keydown" &&
            options === true &&
            typeof candidate === "function" &&
            !removals.mock.calls.some(
              ([removedType, removedCandidate, removedOptions]) =>
                removedType === type &&
                removedCandidate === candidate &&
                removedOptions === options,
            ),
        )
        .map(([, candidate]) => candidate)
        .at(-1);
      if (typeof listener !== "function") {
        throw new Error("No import result Window capture listener was added");
      }
      const controls = captureResultNavigationControls();
      const source = controls[0]!.element;
      const lookalike = Object.create(
        Object.getPrototypeOf(window),
      ) as Record<string, unknown>;
      Object.defineProperties(lookalike, {
        document: { configurable: true, value: document },
        self: { configurable: true, value: lookalike },
        window: { configurable: true, value: lookalike },
      });
      const rejected = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "ArrowDown",
        key: "ArrowDown",
      });
      markResultKeyTrusted(rejected);
      source.focus();
      act(() => {
        Reflect.apply(listener, lookalike, [rejected]);
      });
      expect(rejected.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();

      const receivers: EventTarget[] = [];
      let intrinsicCurrentTarget: EventTarget | null = null;
      let originalTerminal: EventTarget | null = null;
      function observeBackingReceiver(
        this: EventTarget,
        event: Event,
      ) {
        receivers.push(this);
        intrinsicCurrentTarget = event.currentTarget;
        originalTerminal = event.composedPath().at(-1) ?? null;
      }
      window.addEventListener("keydown", observeBackingReceiver, true);
      try {
        const accepted = dispatchResultKey(
          source,
          "ArrowDown",
          {},
          true,
          false,
        );
        expect(accepted.allowed).toBe(false);
      } finally {
        window.removeEventListener(
          "keydown",
          observeBackingReceiver,
          true,
        );
      }
      expect(receivers).toHaveLength(1);
      expect(receivers[0]).toBe(intrinsicCurrentTarget);
      expect(receivers[0]).toBe(originalTerminal);
      expect(controls[1]!.element).toHaveFocus();
      expect(retry).not.toHaveBeenCalled();
      expect(retryAll).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
      removals.mockRestore();
      additions.mockRestore();
    }
  });

  it.each(["structural", "same-prototype", "window-self"] as const)(
    "rejects a %s composed-path terminal lookalike by identity",
    (kind) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        Event.prototype,
        "composedPath",
      );
      if (!descriptor || typeof descriptor.value !== "function") {
        throw new Error("Event.prototype.composedPath is unavailable");
      }
      const nativeComposedPath = descriptor.value as Event["composedPath"];
      const lookalike =
        kind === "same-prototype"
          ? (Object.create(
              Object.getPrototypeOf(window),
            ) as Record<string, unknown>)
          : {};
      Object.defineProperty(lookalike, "document", {
        configurable: true,
        value: document,
      });
      if (kind === "window-self") {
        Object.defineProperties(lookalike, {
          self: { configurable: true, value: lookalike },
          window: { configurable: true, value: lookalike },
        });
      }
      Object.defineProperty(Event.prototype, "composedPath", {
        ...descriptor,
        value: function (this: Event) {
          const path = Reflect.apply(nativeComposedPath, this, []);
          return path.length > 0
            ? [
                ...path.slice(0, -1),
                lookalike as unknown as EventTarget,
              ]
            : path;
        },
      });
      const hostileHost = document.createElement("div");
      document.body.append(hostileHost);
      const hostileRoot = createRoot(hostileHost);
      try {
        act(() => {
          hostileRoot.render(
            <StrictMode>
              <ImportDialog
                open
                onOpenChange={vi.fn()}
                items={navigationItems(vi.fn(), vi.fn())}
                ignored={[]}
              />
            </StrictMode>,
          );
        });
        const hostileControls = captureResultNavigationControls();
        const source = hostileControls[0]!.element;
        const rejected = dispatchResultKey(source, "ArrowDown");
        expect(rejected.allowed).toBe(true);
        expect(rejected.event.defaultPrevented).toBe(false);
        expect(source).toHaveFocus();
      } finally {
        act(() => hostileRoot.unmount());
        hostileHost.remove();
        Object.defineProperty(
          Event.prototype,
          "composedPath",
          descriptor,
        );
      }

      const cleanHost = document.createElement("div");
      document.body.append(cleanHost);
      const cleanRoot = createRoot(cleanHost);
      try {
        act(() => {
          cleanRoot.render(
            <StrictMode>
              <ImportDialog
                open
                onOpenChange={vi.fn()}
                items={navigationItems(vi.fn(), vi.fn())}
                ignored={[]}
              />
            </StrictMode>,
          );
        });
        const cleanControls = captureResultNavigationControls();
        const accepted = dispatchResultKey(
          cleanControls[0]!.element,
          "ArrowDown",
        );
        expect(accepted.allowed).toBe(false);
        expect(cleanControls[1]!.element).toHaveFocus();
      } finally {
        act(() => cleanRoot.unmount());
        cleanHost.remove();
      }
    },
  );

  it.each([
    ["ArrowDown", 0, 1],
    ["ArrowUp", 2, 1],
    ["Home", 2, 0],
    ["End", 0, 3],
  ] as const)(
    "moves one exact direct-root Strict Mode action with %s from %i to %i",
    (key, sourceIndex, destinationIndex) => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const retry = vi.fn();
      const retryAll = vi.fn();
      const onOpenChange = vi.fn();
      const beforeScroll = [window.scrollX, window.scrollY];
      try {
        act(() => {
          root.render(
            <StrictMode>
              <ImportDialog
                open
                onOpenChange={onOpenChange}
                items={navigationItems(retry, retryAll)}
                ignored={["skip.pdf"]}
                footer={<button type="button">Done</button>}
              />
            </StrictMode>,
          );
        });
        const controls = captureResultNavigationControls();
        expect(controls.map(({ element }) => element.textContent?.trim())).toEqual([
          "Open",
          "Retry failed.md",
          "Open",
          "Retry failed",
        ]);
        const source = controls[sourceIndex]!.element;
        const destination = controls[destinationIndex]!.element;
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();

        const result = dispatchResultKey(source, key, {}, true, false);

        expect(result.allowed).toBe(false);
        expect(result.event.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledOnce();
        expect(focus.mock.instances[0]).toBe(destination);
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(destination).toHaveFocus();
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(retry).not.toHaveBeenCalled();
        expect(retryAll).not.toHaveBeenCalled();
        expect([window.scrollX, window.scrollY]).toEqual(beforeScroll);
        expect(
          controls.map(({ element }) => element.tabIndex),
        ).toEqual([0, 0, 0, 0]);
      } finally {
        act(() => root.unmount());
        host.remove();
        preventDefault.mockRestore();
        focus.mockRestore();
      }
    },
  );

  it.each([
    ["ArrowDown", 3],
    ["ArrowUp", 0],
    ["Home", 0],
    ["End", 3],
  ] as const)(
    "leaves the %s boundary at action %i unclaimed and inert",
    (key, sourceIndex) => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const retry = vi.fn();
      const retryAll = vi.fn();
      try {
        act(() => {
          root.render(
            <StrictMode>
              <ImportDialog
                open
                onOpenChange={vi.fn()}
                items={navigationItems(retry, retryAll)}
                ignored={[]}
              />
            </StrictMode>,
          );
        });
        const controls = captureResultNavigationControls();
        const source = controls[sourceIndex]!.element;
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();

        const result = dispatchResultKey(source, key, {}, true, false);

        expect(result.allowed).toBe(true);
        expect(result.event.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(source).toHaveFocus();
        expect(retry).not.toHaveBeenCalled();
        expect(retryAll).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        host.remove();
        preventDefault.mockRestore();
        focus.mockRestore();
      }
    },
  );

  it("skips every disabled Retry in committed DOM order and preserves later activation", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const retry = vi.fn();
    const retryAll = vi.fn();
    const onOpenChange = vi.fn();
    const items: ImportItem[] = [
      {
        name: "first.md",
        status: "done",
        id: "first",
        warnings: [],
      },
      {
        name: "failed.md",
        status: "error",
        retry,
        retryAll,
        warnings: [],
      },
      {
        name: "pending.md",
        status: "uploading",
        warnings: [],
      },
      {
        name: "last.md",
        status: "done",
        id: "last",
        warnings: [],
      },
    ];
    try {
      act(() => {
        root.render(
          <StrictMode>
            <ImportDialog
              open
              onOpenChange={onOpenChange}
              items={items}
              ignored={[]}
            />
          </StrictMode>,
        );
      });
      const controls = captureResultNavigationControls();
      expect(controls.map(({ element }) => element.textContent?.trim())).toEqual([
        "Open",
        "Retry failed.md",
        "Open",
        "Retry failed",
      ]);
      expect(controls[1]!.element).toBeDisabled();
      expect(controls[3]!.element).toBeDisabled();
      controls[0]!.element.focus();
      preventDefault.mockClear();
      focus.mockClear();

      const result = dispatchResultKey(
        controls[0]!.element,
        "ArrowDown",
        {},
        true,
        false,
      );

      expect(result.allowed).toBe(false);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
      expect(controls[2]!.element).toHaveFocus();
      expect(retry).not.toHaveBeenCalled();
      expect(retryAll).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();

      invokeResultControl(captureResultOpen(1));
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(retry).not.toHaveBeenCalled();
      expect(retryAll).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
      preventDefault.mockRestore();
      focus.mockRestore();
    }
  });

  it.each([
    ["untrusted", {}, false],
    ["Control-modified", { ctrlKey: true }, true],
    ["Alt-modified", { altKey: true }, true],
    ["Meta-modified", { metaKey: true }, true],
    ["Shift-modified", { shiftKey: true }, true],
    ["repeated", { repeat: true }, true],
    ["composing", { isComposing: true }, true],
  ] as const)(
    "rejects %s input without poisoning a distinct clean successor",
    (_name, init, trusted) => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const retry = vi.fn();
      const retryAll = vi.fn();
      try {
        act(() => {
          root.render(
            <StrictMode>
              <ImportDialog
                open
                onOpenChange={vi.fn()}
                items={navigationItems(retry, retryAll)}
                ignored={[]}
              />
            </StrictMode>,
          );
        });
        const controls = captureResultNavigationControls();
        const source = controls[0]!.element;
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();

        const rejected = dispatchResultKey(
          source,
          "ArrowDown",
          init,
          trusted,
          false,
        );

        expect(rejected.allowed).toBe(true);
        expect(rejected.event.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(source).toHaveFocus();
        expect(retry).not.toHaveBeenCalled();
        expect(retryAll).not.toHaveBeenCalled();

        const accepted = dispatchResultKey(
          source,
          "ArrowDown",
          {},
          true,
          false,
        );
        expect(accepted.allowed).toBe(false);
        expect(controls[1]!.element).toHaveFocus();
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledOnce();
      } finally {
        act(() => root.unmount());
        host.remove();
        preventDefault.mockRestore();
        focus.mockRestore();
      }
    },
  );

  it("leaves a lone enabled action and native activation behavior unchanged", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onOpenChange = vi.fn();
    try {
      act(() => {
        root.render(
          <StrictMode>
            <ImportDialog
              open
              onOpenChange={onOpenChange}
              items={[
                {
                  name: "only.md",
                  status: "done",
                  id: "only",
                  warnings: [],
                },
              ]}
              ignored={[]}
            />
          </StrictMode>,
        );
      });
      const [only] = captureResultNavigationControls();
      if (!only) throw new Error("The lone Open action was not rendered");
      only.element.focus();
      preventDefault.mockClear();
      focus.mockClear();

      for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
        const result = dispatchResultKey(
          only.element,
          key,
          {},
          true,
          false,
        );
        expect(result.allowed).toBe(true);
        expect(result.event.defaultPrevented).toBe(false);
      }
      const enter = dispatchResultKey(
        only.element,
        "Enter",
        {},
        true,
        false,
      );
      expect(enter.allowed).toBe(true);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();

      const tab = dispatchResultKey(
        only.element,
        "Tab",
        {},
        true,
        false,
      );
      expect(tab.allowed).toBe(false);
      expect(tab.event.defaultPrevented).toBe(true);
      expect(onOpenChange).not.toHaveBeenCalled();

      dispatchResultKey(
        only.element,
        "Escape",
        {},
        true,
        false,
      );
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      onOpenChange.mockClear();

      invokeResultControl(captureResultOpen());
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      act(() => root.unmount());
      host.remove();
      preventDefault.mockRestore();
      focus.mockRestore();
    }
  });

  it("leaves Space and the focused row Retry activation unchanged after navigation", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const retry = vi.fn();
    const retryAll = vi.fn();
    const onOpenChange = vi.fn();
    try {
      act(() => {
        root.render(
          <StrictMode>
            <ImportDialog
              open
              onOpenChange={onOpenChange}
              items={navigationItems(retry, retryAll)}
              ignored={[]}
            />
          </StrictMode>,
        );
      });
      const controls = captureResultNavigationControls();
      const moved = dispatchResultKey(
        controls[0]!.element,
        "ArrowDown",
      );
      expect(moved.allowed).toBe(false);
      expect(controls[1]!.element).toHaveFocus();

      const space = dispatchResultKey(
        controls[1]!.element,
        " ",
        {},
        true,
        false,
      );
      expect(space.allowed).toBe(true);
      expect(space.event.defaultPrevented).toBe(false);
      expect(retry).not.toHaveBeenCalled();
      expect(retryAll).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();

      invokeResultControl(captureResultRowRetry());
      expect(retry).toHaveBeenCalledOnce();
      expect(retryAll).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("rejects canceled, wrong-focus, fabricated, and foreign-realm delivery before clean recovery", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const retry = vi.fn();
    const retryAll = vi.fn();
    try {
      act(() => {
        root.render(
          <StrictMode>
            <ImportDialog
              open
              onOpenChange={vi.fn()}
              items={navigationItems(retry, retryAll)}
              ignored={[]}
              footer={
                <button type="button" data-testid="navigation-sentinel">
                  Sentinel
                </button>
              }
            />
          </StrictMode>,
        );
      });
      const controls = captureResultNavigationControls();
      const source = controls[0]!.element;
      const sentinel = screen.getByTestId("navigation-sentinel");
      const cancel = (event: KeyboardEvent) => event.preventDefault();
      source.addEventListener("keydown", cancel, {
        capture: true,
        once: true,
      });
      source.focus();
      preventDefault.mockClear();
      focus.mockClear();
      const canceled = dispatchResultKey(
        source,
        "ArrowDown",
        {},
        true,
        false,
      );
      expect(canceled.event.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).not.toHaveBeenCalled();
      expect(source).toHaveFocus();
      preventDefault.mockClear();

      sentinel.focus();
      focus.mockClear();
      const unfocused = dispatchResultKey(
        source,
        "ArrowDown",
        {},
        true,
        false,
      );
      expect(unfocused.allowed).toBe(true);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(sentinel).toHaveFocus();

      controls[0]!.onKeyDown({
        type: "keydown",
        key: "ArrowDown",
        currentTarget: source,
        target: source,
        nativeEvent: new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "ArrowDown",
          key: "ArrowDown",
        }),
      } as unknown as ReactKeyboardEvent<HTMLElement>);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(sentinel).toHaveFocus();

      const iframe = document.createElement("iframe");
      document.body.append(iframe);
      const foreignWindow = iframe.contentWindow as
        | (Window & typeof globalThis)
        | null;
      if (!foreignWindow) throw new Error("The foreign realm was not created");
      const foreign = new foreignWindow.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "ArrowDown",
        key: "ArrowDown",
      });
      markResultKeyTrusted(foreign);
      source.focus();
      focus.mockClear();
      let foreignAllowed = false;
      act(() => {
        foreignAllowed = source.dispatchEvent(foreign);
      });
      expect(foreignAllowed).toBe(true);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(source).toHaveFocus();
      iframe.remove();

      const recovered = dispatchResultKey(
        source,
        "ArrowDown",
        {},
        true,
        false,
      );
      expect(recovered.allowed).toBe(false);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
      expect(controls[1]!.element).toHaveFocus();
      expect(retry).not.toHaveBeenCalled();
      expect(retryAll).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
      preventDefault.mockRestore();
      focus.mockRestore();
    }
  });

  it("rejects altered React delivery and a replayed native event while permitting distinct successors", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const retry = vi.fn();
    const retryAll = vi.fn();
    try {
      act(() => {
        root.render(
          <StrictMode>
            <ImportDialog
              open
              onOpenChange={vi.fn()}
              items={navigationItems(retry, retryAll)}
              ignored={[]}
            />
          </StrictMode>,
        );
      });
      const controls = captureResultNavigationControls();
      const source = controls[0]!.element;
      source.focus();
      preventDefault.mockClear();
      focus.mockClear();
      const restore = interceptResultKeyDown(
        source,
        (original, event) => {
          original(
            new Proxy(event, {
              get(target, property, receiver) {
                if (property === "key") return "ArrowUp";
                return Reflect.get(target, property, receiver);
              },
            }),
          );
        },
      );
      try {
        const altered = dispatchResultKey(
          source,
          "ArrowDown",
          {},
          true,
          false,
        );
        expect(altered.allowed).toBe(true);
      } finally {
        restore();
      }
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(source).toHaveFocus();

      const accepted = dispatchResultKey(
        source,
        "ArrowDown",
        {},
        true,
        false,
      );
      expect(accepted.allowed).toBe(false);
      expect(controls[1]!.element).toHaveFocus();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();

      source.focus();
      preventDefault.mockClear();
      focus.mockClear();
      let replayAllowed = true;
      act(() => {
        replayAllowed = source.dispatchEvent(accepted.event);
      });
      expect(replayAllowed).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(source).toHaveFocus();

      const successor = dispatchResultKey(
        source,
        "ArrowDown",
        {},
        true,
        false,
      );
      expect(successor.allowed).toBe(false);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
      expect(controls[1]!.element).toHaveFocus();
      expect(retry).not.toHaveBeenCalled();
      expect(retryAll).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
      preventDefault.mockRestore();
      focus.mockRestore();
    }
  });

  it("rejects reentrant input during prevention and accepts the next clean action", () => {
    const nativePreventDefault = Event.prototype.preventDefault;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const retry = vi.fn();
    const retryAll = vi.fn();
    let source: HTMLElement | null = null;
    let nestedEvent: KeyboardEvent | null = null;
    let nestedAllowed = false;
    const preventDefault = vi
      .spyOn(Event.prototype, "preventDefault")
      .mockImplementation(function (this: Event) {
        if (source && nestedEvent) {
          const event = nestedEvent;
          nestedEvent = null;
          nestedAllowed = source.dispatchEvent(event);
        }
        nativePreventDefault.call(this);
      });
    try {
      act(() => {
        root.render(
          <StrictMode>
            <ImportDialog
              open
              onOpenChange={vi.fn()}
              items={navigationItems(retry, retryAll)}
              ignored={[]}
            />
          </StrictMode>,
        );
      });
      const controls = captureResultNavigationControls();
      source = controls[0]!.element;
      source.focus();
      preventDefault.mockClear();
      focus.mockClear();
      nestedEvent = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "ArrowDown",
        key: "ArrowDown",
      });
      markResultKeyTrusted(nestedEvent);

      const result = dispatchResultKey(
        source,
        "ArrowDown",
        {},
        true,
        false,
      );

      expect(result.allowed).toBe(false);
      expect(nestedAllowed).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
      expect(controls[1]!.element).toHaveFocus();
      expect(retry).not.toHaveBeenCalled();
      expect(retryAll).not.toHaveBeenCalled();

      preventDefault.mockClear();
      focus.mockClear();
      const successor = dispatchResultKey(
        controls[1]!.element,
        "ArrowDown",
        {},
        true,
        false,
      );
      expect(successor.allowed).toBe(false);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
      expect(controls[2]!.element).toHaveFocus();
    } finally {
      act(() => root.unmount());
      host.remove();
      preventDefault.mockRestore();
      focus.mockRestore();
    }
  });

  it.each([
    "attribute restore",
    "detach and restore",
    "order restore",
  ] as const)(
    "retires %s history before focus work and publishes a clean recovery",
    (change) => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const retry = vi.fn();
      const retryAll = vi.fn();
      const items = navigationItems(retry, retryAll);
      const renderDialog = () => (
        <StrictMode>
          <ImportDialog
            open
            onOpenChange={vi.fn()}
            items={items}
            ignored={[]}
          />
        </StrictMode>
      );
      try {
        act(() => root.render(renderDialog()));
        const stale = captureResultNavigationControls();
        const source = stale[0]!.element;
        const row = source.parentElement;
        const list = row?.parentElement;
        if (!row || !list) throw new Error("The Open action had no result row");
        if (change === "attribute restore") {
          const className = source.className;
          source.className = `${className} changed`;
          source.className = className;
        } else if (change === "detach and restore") {
          const next = source.nextSibling;
          source.remove();
          row.insertBefore(source, next);
        } else {
          const nextRow = row.nextSibling;
          list.append(row);
          list.insertBefore(row, nextRow);
        }
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();

        const rejected = dispatchResultKey(
          source,
          "ArrowDown",
          {},
          true,
          false,
        );
        expect(rejected.allowed).toBe(true);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(source).toHaveFocus();

        act(() => root.render(renderDialog()));
        const current = captureResultNavigationControls();
        current[0]!.element.focus();
        preventDefault.mockClear();
        focus.mockClear();
        const recovered = dispatchResultKey(
          current[0]!.element,
          "ArrowDown",
          {},
          true,
          false,
        );
        expect(recovered.allowed).toBe(false);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledOnce();
        expect(current[1]!.element).toHaveFocus();
        expect(retry).not.toHaveBeenCalled();
        expect(retryAll).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        host.remove();
        preventDefault.mockRestore();
        focus.mockRestore();
      }
    },
  );

  it("rejects stale facts without letting crossed handlers consume or cleanup replay authority", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const staleRetry = vi.fn();
    const retryAll = vi.fn();
    const staleItems = navigationItems(staleRetry, retryAll);
    let rootUnmounted = false;
    try {
      act(() => {
        root.render(
          <ImportDialog
            open
            onOpenChange={vi.fn()}
            items={staleItems}
            ignored={[]}
          />,
        );
      });
      const stale = captureResultNavigationControls();
      const staleHandler = stale[0]!.onKeyDown;
      staleItems[0]!.id = "changed";
      stale[0]!.element.focus();
      preventDefault.mockClear();
      focus.mockClear();
      expect(
        dispatchResultKey(
          stale[0]!.element,
          "ArrowDown",
          {},
          true,
          false,
        ).allowed,
      ).toBe(true);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();

      staleItems[0]!.id = "opened";
      const currentRetry = vi.fn();
      act(() => {
        root.render(
          <ImportDialog
            open
            onOpenChange={vi.fn()}
            items={navigationItems(currentRetry, retryAll)}
            ignored={[]}
          />,
        );
      });
      const current = captureResultNavigationControls();
      const restore = interceptResultKeyDown(
        current[0]!.element,
        (currentHandler, event) => {
          staleHandler(event);
          currentHandler(event);
        },
      );
      current[0]!.element.focus();
      preventDefault.mockClear();
      focus.mockClear();
      try {
        expect(
          dispatchResultKey(
            current[0]!.element,
            "ArrowDown",
            {},
            true,
            false,
          ).allowed,
        ).toBe(false);
      } finally {
        restore();
      }
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
      expect(current[1]!.element).toHaveFocus();

      const recovered = dispatchResultKey(
        current[0]!.element,
        "ArrowDown",
        {},
        true,
        true,
      );
      expect(recovered.allowed).toBe(false);
      expect(current[1]!.element).toHaveFocus();
      expect(staleRetry).not.toHaveBeenCalled();
      expect(currentRetry).not.toHaveBeenCalled();
      expect(retryAll).not.toHaveBeenCalled();

      const removedRoot = screen.getByTestId("import-dialog");
      const removedHandler = current[1]!.onKeyDown;
      act(() => root.unmount());
      rootUnmounted = true;
      document.body.append(removedRoot);
      const sentinel = document.createElement("button");
      document.body.append(sentinel);
      sentinel.focus();
      preventDefault.mockClear();
      focus.mockClear();
      removedHandler({
        type: "keydown",
        key: "ArrowDown",
        currentTarget: current[1]!.element,
        target: current[1]!.element,
        nativeEvent: new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "ArrowDown",
          key: "ArrowDown",
        }),
      } as unknown as ReactKeyboardEvent<HTMLElement>);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(sentinel).toHaveFocus();
      expect(staleRetry).not.toHaveBeenCalled();
      expect(currentRetry).not.toHaveBeenCalled();
      expect(retryAll).not.toHaveBeenCalled();
      sentinel.remove();
      removedRoot.remove();
    } finally {
      if (!rootUnmounted) act(() => root.unmount());
      host.remove();
      preventDefault.mockRestore();
      focus.mockRestore();
    }
  });
});

describe("ImportDialog result publications", () => {
  it("binds repeated and crossed row retries to one exact current failed row", () => {
    const firstRetry = vi.fn();
    const secondRetry = vi.fn();
    const retryAll = vi.fn();
    const items: ImportItem[] = [
      {
        name: "first.md",
        status: "error",
        warnings: [],
        error: "First failed",
        retry: firstRetry,
        retryAll,
      },
      {
        name: "second.md",
        status: "error",
        warnings: [],
        error: "Second failed",
        retry: secondRetry,
        retryAll,
      },
    ];
    const view = render(
      <StrictMode>
        <ImportDialog open onOpenChange={vi.fn()} items={items} ignored={[]} />
      </StrictMode>,
    );
    const staleFirst = captureResultRowRetry(0);
    const staleSecond = captureResultRowRetry(1);
    const staleAll = captureResultRetry();

    invokeResultControl(staleFirst, staleSecond.element);
    invokeResultControl(staleSecond, staleFirst.element);
    expect(firstRetry).not.toHaveBeenCalled();
    expect(secondRetry).not.toHaveBeenCalled();

    invokeResultControl(staleFirst);
    invokeResultControl(staleFirst);
    invokeResultControl(staleSecond);
    invokeResultControl(staleAll);
    expect(firstRetry).toHaveBeenCalledOnce();
    expect(secondRetry).not.toHaveBeenCalled();
    expect(retryAll).not.toHaveBeenCalled();

    view.rerender(
      <StrictMode>
        <ImportDialog open onOpenChange={vi.fn()} items={items} ignored={[]} />
      </StrictMode>,
    );
    const currentSecond = captureResultRowRetry(1);
    invokeResultControl(staleSecond, currentSecond.element);
    expect(secondRetry).not.toHaveBeenCalled();
    invokeResultControl(currentSecond);
    expect(secondRetry).toHaveBeenCalledOnce();
  });

  it("retires a restored row retry before a clean successor publication", () => {
    const retry = vi.fn();
    const items: ImportItem[] = [
      {
        name: "failed.md",
        status: "error",
        warnings: [],
        error: "Failed",
        retry,
      },
    ];
    const view = render(
      <StrictMode>
        <ImportDialog open onOpenChange={vi.fn()} items={items} ignored={[]} />
      </StrictMode>,
    );
    const stale = captureResultRowRetry();
    const row = stale.element.parentElement;
    if (!row) throw new Error("Row Retry had no owner row");
    stale.element.remove();
    row.append(stale.element);

    invokeResultControl(stale);
    expect(retry).not.toHaveBeenCalled();

    view.rerender(
      <StrictMode>
        <ImportDialog open onOpenChange={vi.fn()} items={items} ignored={[]} />
      </StrictMode>,
    );
    invokeResultControl(captureResultRowRetry());
    expect(retry).toHaveBeenCalledOnce();
  });

  it("claims each current Open and Retry action once and gives an equal-looking successor fresh claims", () => {
    const onOpenChange = vi.fn();
    const retry = vi.fn();
    const items = resultItems(retry);
    const view = render(<ImportDialog open onOpenChange={onOpenChange} items={items} ignored={[]} />);
    const firstOpen = captureResultOpen();
    const firstRetry = captureResultRetry();

    for (let attempt = 0; attempt < 2; attempt++) {
      const openEvent = invokeResultControl(firstOpen);
      const retryEvent = invokeResultControl(firstRetry);
      expect(openEvent.preventDefault).not.toHaveBeenCalled();
      expect(openEvent.stopPropagation).not.toHaveBeenCalled();
      expect(retryEvent.preventDefault).not.toHaveBeenCalled();
      expect(retryEvent.stopPropagation).not.toHaveBeenCalled();
    }
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(retry).toHaveBeenCalledOnce();

    view.rerender(<ImportDialog open onOpenChange={onOpenChange} items={items} ignored={[]} />);
    const successorOpen = captureResultOpen();
    const successorRetry = captureResultRetry();
    expect(successorOpen.element).toBe(firstOpen.element);
    expect(successorRetry.element).toBe(firstRetry.element);

    invokeResultControl(firstOpen, successorOpen.element);
    invokeResultControl(firstRetry, successorRetry.element);
    invokeResultControl(successorOpen);
    invokeResultControl(successorRetry);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("keeps Open as an unchanged native link and closes its exact current dialog once", () => {
    const onOpenChange = vi.fn();
    render(<StatefulResultDialog onOpenChange={onOpenChange} />);
    const open = captureResultOpen();
    expect(open.element.tagName).toBe("A");
    expect(open.element).toHaveAttribute("href", "/d/native-document");
    let event!: ResultMouseEvent<HTMLAnchorElement>;

    act(() => {
      event = invokeResultControl(open);
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(screen.queryByTestId("import-dialog")).toBeNull();
  });

  it.each(["Open", "Retry"] as const)(
    "keeps exact %s usable once after direct-root Strict Mode replay",
    (kind) => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const onOpenChange = vi.fn();
      const retry = vi.fn();
      const layouts: Array<{
        control: CapturedResultControlView;
        rootRef: RefCallback<HTMLElement>;
      }> = [];
      let current: CapturedResultControlView | undefined;
      const capture = () => {
        layouts.push({
          control: captureResultControl(kind),
          rootRef: reactRef(screen.getByTestId("import-dialog")),
        });
      };
      const footer = <ResultLayoutCapture capture={capture}>{null}</ResultLayoutCapture>;

      if (kind === "Open") {
        onOpenChange.mockImplementation(() => current?.element.click());
      } else {
        retry.mockImplementation(() => current?.element.click());
      }

      try {
        act(() => {
          root.render(
            <StrictMode>
              <ImportDialog
                open
                onOpenChange={onOpenChange}
                items={resultItems(retry)}
                ignored={["same.pdf"]}
                footer={footer}
              />
            </StrictMode>,
          );
        });
        const retiredByReplay = layouts[0];
        const currentControl = captureResultControl(kind);
        current = currentControl;
        if (!retiredByReplay) throw new Error("Strict Mode did not publish its first layout");
        expect(retiredByReplay.control.element).toBe(currentControl.element);
        expect(retiredByReplay.control.onClick).not.toBe(currentControl.onClick);

        retiredByReplay.rootRef(screen.getByTestId("import-dialog"));
        retiredByReplay.rootRef(null);
        retiredByReplay.control.invoke(currentControl.element);
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(retry).not.toHaveBeenCalled();

        currentControl.element.click();
        currentControl.element.click();
        if (kind === "Open") {
          expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
          expect(retry).not.toHaveBeenCalled();
        } else {
          expect(onOpenChange).not.toHaveBeenCalled();
          expect(retry).toHaveBeenCalledOnce();
        }
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );

  it.each([
    "partial ref replay",
    "root detach and reinsert",
    "root replacement and restore",
    "list replacement and restore",
    "row replacement and restore",
    "row reorder and restore",
    "href drift and restore",
    "status drift and restore",
    "retry drift and restore",
    "descendant mutation and restore",
  ] as const)("rejects Strict Mode replay after %s without poisoning a fresh result", (change) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const staleOpenChange = vi.fn();
    const currentOpenChange = vi.fn();
    const staleRetry = vi.fn();
    const currentRetry = vi.fn();
    const replacementRetry = vi.fn();
    const items = resultItems(staleRetry);
    let staleOpen: CapturedResultControl<HTMLAnchorElement> | undefined;
    let staleRetryControl: CapturedResultControl<HTMLButtonElement> | undefined;
    let staleRootRef: RefCallback<HTMLElement> | undefined;
    let layoutSetups = 0;
    const perturbReplay = () => {
      layoutSetups++;
      const resultRoot = screen.getByTestId("import-dialog");
      const list = screen.getByTestId("import-list");
      const rows = screen.getAllByTestId("import-item");
      const open = screen.getAllByTestId("import-open")[0] as HTMLAnchorElement | undefined;
      const retry = screen.getByTestId("import-retry") as HTMLButtonElement;
      if (!open) throw new Error("Strict replay had no Open control");
      if (layoutSetups === 1) {
        staleOpen = captureResultOpen();
        staleRetryControl = captureResultRetry();
        staleRootRef = reactRef(resultRoot);
        return;
      }
      if (layoutSetups !== 2) return;

      if (change === "partial ref replay") {
        staleRootRef?.(null);
      } else if (change === "root detach and reinsert") {
        const parent = resultRoot.parentNode;
        const next = resultRoot.nextSibling;
        if (!parent) throw new Error("Import result root had no parent");
        resultRoot.remove();
        parent.insertBefore(resultRoot, next);
      } else if (change === "root replacement and restore") {
        const replacement = resultRoot.cloneNode(true);
        const parent = resultRoot.parentNode;
        if (!parent) throw new Error("Import result root had no parent");
        parent.replaceChild(replacement, resultRoot);
        parent.replaceChild(resultRoot, replacement);
      } else if (change === "list replacement and restore") {
        const replacement = list.cloneNode(true);
        const parent = list.parentNode;
        if (!parent) throw new Error("Import result list had no parent");
        parent.replaceChild(replacement, list);
        parent.replaceChild(list, replacement);
      } else if (change === "row replacement and restore") {
        const replacement = rows[0].cloneNode(true);
        const parent = rows[0].parentNode;
        if (!parent) throw new Error("Import result row had no parent");
        parent.replaceChild(replacement, rows[0]);
        parent.replaceChild(rows[0], replacement);
      } else if (change === "row reorder and restore") {
        list.append(rows[0]);
        list.insertBefore(rows[0], rows[1]);
      } else if (change === "href drift and restore") {
        open.setAttribute("href", "/d/changed");
        open.setAttribute("href", "/d/doc-first");
      } else if (change === "status drift and restore") {
        items[0].status = "error";
        rows[0].dataset.status = "error";
        items[0].status = "done";
        rows[0].dataset.status = "done";
      } else if (change === "retry drift and restore") {
        items[1].retry = replacementRetry;
        retry.disabled = true;
        items[1].retry = staleRetry;
        retry.disabled = false;
      } else {
        const label = open.parentElement?.querySelector("span.truncate.text-sm");
        if (!label) throw new Error("Strict replay Open row had no title");
        label.textContent = "Changed";
        label.textContent = "First";
      }
    };
    const footer = <ResultLayoutCapture capture={perturbReplay}>{null}</ResultLayoutCapture>;

    try {
      act(() => {
        root.render(
          <StrictMode>
            <ImportDialog
              open
              onOpenChange={staleOpenChange}
              items={items}
              ignored={["same.pdf"]}
              footer={footer}
            />
          </StrictMode>,
        );
      });
      if (!staleOpen || !staleRetryControl) {
        throw new Error("Strict Mode did not publish its first result");
      }
      const rejectedOpen = invokeResultControl(staleOpen);
      const rejectedRetry = invokeResultControl(staleRetryControl);
      expect(rejectedOpen.preventDefault).not.toHaveBeenCalled();
      expect(rejectedOpen.stopPropagation).not.toHaveBeenCalled();
      expect(rejectedRetry.preventDefault).not.toHaveBeenCalled();
      expect(rejectedRetry.stopPropagation).not.toHaveBeenCalled();
      expect(staleOpenChange).not.toHaveBeenCalled();
      expect(staleRetry).not.toHaveBeenCalled();
      expect(replacementRetry).not.toHaveBeenCalled();

      act(() => {
        root.render(
          <ImportDialog
            open
            onOpenChange={currentOpenChange}
            items={resultItems(currentRetry)}
            ignored={["same.pdf"]}
          />,
        );
      });
      invokeResultControl(staleOpen, captureResultOpen().element);
      invokeResultControl(staleRetryControl, captureResultRetry().element);
      invokeResultControl(captureResultOpen());
      invokeResultControl(captureResultRetry());
      expect(staleOpenChange).not.toHaveBeenCalled();
      expect(staleRetry).not.toHaveBeenCalled();
      expect(currentOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(currentRetry).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it.each(["Open", "Retry"] as const)(
    "keeps a newly placed %s exact after a direct-root Strict Mode upload commit",
    async (kind) => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const initialUpload = deferred<ImportBatch>();
      const retryUpload = deferred<ImportBatch>();
      const onDialogOpenChange = vi.fn();
      const layouts: Array<{
        control: CapturedResultControlView;
        rootRef: RefCallback<HTMLElement>;
      }> = [];
      let current: CapturedResultControlView | undefined;
      const capture = () => {
        const target = screen.queryByTestId(
          kind === "Open" ? "import-open" : "import-retry",
        );
        if (!target) return;
        layouts.push({
          control: captureResultControl(kind),
          rootRef: reactRef(screen.getByTestId("import-dialog")),
        });
      };
      if (kind === "Open") {
        onDialogOpenChange.mockImplementation(() => current?.element.click());
      }
      uploadImportBatch.mockReturnValueOnce(initialUpload.promise);
      if (kind === "Retry") {
        uploadImportBatch.mockImplementationOnce(() => {
          current?.element.click();
          return retryUpload.promise;
        });
      }

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <Harness
                batches={[[new File(["# New"], "new.md", { type: "text/markdown" })]]}
                onError={vi.fn()}
                onDialogOpenChange={onDialogOpenChange}
                captureResultLayout={capture}
              />
            </StrictMode>,
          );
        });
        act(() => screen.getByRole("button", { name: "Import batch 1" }).click());
        await act(async () => {
          initialUpload.resolve(
            kind === "Open"
              ? {
                  documents: [
                    { id: "new-document", title: "New", warnings: [] },
                  ],
                  failed: [],
                }
              : {
                  documents: [],
                  failed: [{ index: 0, name: "new.md", error: "Failed" }],
                },
          );
        });

        const stale = layouts.at(-1);
        current = captureResultControl(kind);
        if (!stale) throw new Error("The upload commit did not publish a result layout");
        expect(stale.control.element).toBe(current.element);
        expect(stale.control.onClick).not.toBe(current.onClick);

        stale.rootRef(null);
        stale.rootRef(screen.getByTestId("import-dialog"));
        stale.rootRef(null);
        stale.control.invoke(current.element);
        expect(onDialogOpenChange).not.toHaveBeenCalled();
        expect(uploadImportBatch).toHaveBeenCalledOnce();

        current.element.click();
        current.element.click();
        if (kind === "Open") {
          expect(onDialogOpenChange).toHaveBeenCalledExactlyOnceWith(false);
          expect(uploadImportBatch).toHaveBeenCalledOnce();
        } else {
          expect(onDialogOpenChange).not.toHaveBeenCalled();
          expect(uploadImportBatch).toHaveBeenCalledTimes(2);
          await act(async () => {
            retryUpload.resolve({
              documents: [
                { id: "retried-document", title: "Retried", warnings: [] },
              ],
              failed: [],
            });
          });
        }
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each([
    ["Open", "mutation"],
    ["Open", "detach"],
    ["Retry", "mutation"],
    ["Retry", "detach"],
  ] as const)(
    "rejects a newly placed %s after replay %s and leaves the next upload exact",
    async (kind, change) => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const firstUpload = deferred<ImportBatch>();
      const secondUpload = deferred<ImportBatch>();
      const retryUpload = deferred<ImportBatch>();
      const onDialogOpenChange = vi.fn();
      let firstLayoutSetups = 0;
      let perturbed = false;
      let stale: CapturedResultControlView | undefined;
      let current: CapturedResultControlView | undefined;
      const capture = () => {
        const target = screen.queryByTestId(
          kind === "Open" ? "import-open" : "import-retry",
        );
        if (!(target instanceof HTMLElement) || perturbed) return;
        firstLayoutSetups++;
        stale ??= captureResultControl(kind);
        if (firstLayoutSetups !== 2) return;
        perturbed = true;
        if (change === "mutation") {
          if (target instanceof HTMLAnchorElement) {
            target.setAttribute("href", "/d/changed");
            target.setAttribute("href", "/d/first-result");
          } else if (target instanceof HTMLButtonElement) {
            target.disabled = true;
            target.disabled = false;
          }
          return;
        }
        const parent = target.parentNode;
        const next = target.nextSibling;
        if (!parent) throw new Error("The replayed result control had no parent");
        target.remove();
        parent.insertBefore(target, next);
      };
      if (kind === "Open") {
        onDialogOpenChange.mockImplementation(() => current?.element.click());
      }
      uploadImportBatch
        .mockReturnValueOnce(firstUpload.promise)
        .mockReturnValueOnce(secondUpload.promise);
      if (kind === "Retry") {
        uploadImportBatch.mockImplementationOnce(() => {
          current?.element.click();
          return retryUpload.promise;
        });
      }
      const result = (id: string): ImportBatch =>
        kind === "Open"
          ? {
              documents: [{ id, title: id, warnings: [] }],
              failed: [],
            }
          : {
              documents: [],
              failed: [{ index: 0, name: `${id}.md`, error: "Failed" }],
            };

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <Harness
                batches={[
                  [new File(["# First"], "first.md", { type: "text/markdown" })],
                  [new File(["# Second"], "second.md", { type: "text/markdown" })],
                ]}
                onError={vi.fn()}
                onDialogOpenChange={onDialogOpenChange}
                captureResultLayout={capture}
              />
            </StrictMode>,
          );
        });
        act(() => screen.getByRole("button", { name: "Import batch 1" }).click());
        await act(async () => firstUpload.resolve(result("first-result")));
        expect(firstLayoutSetups).toBe(2);
        if (!stale) throw new Error("The first upload did not expose its replay handler");

        captureResultControl(kind).element.click();
        expect(onDialogOpenChange).not.toHaveBeenCalled();
        expect(uploadImportBatch).toHaveBeenCalledOnce();

        act(() => screen.getByText("Import batch 2").click());
        await act(async () => secondUpload.resolve(result("second-result")));
        current = captureResultControl(kind);
        stale.invoke(current.element);
        expect(onDialogOpenChange).not.toHaveBeenCalled();
        expect(uploadImportBatch).toHaveBeenCalledTimes(2);

        current.element.click();
        current.element.click();
        if (kind === "Open") {
          expect(onDialogOpenChange).toHaveBeenCalledExactlyOnceWith(false);
          expect(uploadImportBatch).toHaveBeenCalledTimes(2);
        } else {
          expect(onDialogOpenChange).not.toHaveBeenCalled();
          expect(uploadImportBatch).toHaveBeenCalledTimes(3);
          await act(async () => {
            retryUpload.resolve({
              documents: [
                { id: "retry-result", title: "Retried", warnings: [] },
              ],
              failed: [],
            });
          });
        }
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["Open", "Retry"] as const)(
    "rejects fabricated or inconsistent native events for %s without poisoning its exact control",
    (kind) => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const onOpenChange = vi.fn();
      const retry = vi.fn();

      try {
        act(() => {
          root.render(<ImportDialog open onOpenChange={onOpenChange} items={resultItems(retry)} ignored={[]} />);
        });
        const exerciseControl = <T extends HTMLElement>(control: CapturedResultControl<T>) => {
          const focusOwner = document.createElement("button");
          const foreignTarget = document.createElement("span");
          document.body.append(focusOwner);
          focusOwner.focus();

          const attempts: Array<() => ResultMouseEvent<T>> = [
            () =>
              invokeResultControl(control, control.element, {
                nativeEvent: { type: "click", target: control.element },
              }),
            () => invokeResultControl(control, control.element, { type: "pointerup" }),
            () => invokeResultControl(control, control.element, { nativeType: "mousedown" }),
            () => invokeResultControl(control, control.element, { nativeTarget: foreignTarget }),
          ];

          for (const attempt of attempts) {
            const activeElement = document.activeElement;
            const markup = document.body.innerHTML;
            const event = attempt();
            expect(onOpenChange).not.toHaveBeenCalled();
            expect(retry).not.toHaveBeenCalled();
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(event.stopPropagation).not.toHaveBeenCalled();
            expect(document.activeElement).toBe(activeElement);
            expect(document.body.innerHTML).toBe(markup);
          }

          const event = invokeResultControl(control);
          expect(event.nativeEvent).toBeInstanceOf(control.element.ownerDocument.defaultView!.MouseEvent);
          expect(event.preventDefault).not.toHaveBeenCalled();
          expect(event.stopPropagation).not.toHaveBeenCalled();
          if (kind === "Open") {
            expect(control.element.tagName).toBe("A");
            expect(control.element).toHaveAttribute("href", "/d/doc-first");
            expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
            expect(retry).not.toHaveBeenCalled();
          } else {
            expect(onOpenChange).not.toHaveBeenCalled();
            expect(retry).toHaveBeenCalledOnce();
          }
          focusOwner.remove();
        };

        if (kind === "Open") exerciseControl(captureResultOpen());
        else exerciseControl(captureResultRetry());
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );

  it("rejects sibling, wrong-row, cross-row and foreign Open controls without poisoning the exact link", () => {
    const onOpenChange = vi.fn();
    const focusOwner = document.createElement("button");
    const foreign = document.createElement("a");
    document.body.append(focusOwner, foreign);
    render(
      <ImportDialog
        open
        onOpenChange={onOpenChange}
        items={[
          { name: "first.md", status: "done", id: "first", warnings: [] },
          { name: "second.md", status: "done", id: "second", warnings: [] },
        ]}
        ignored={[]}
      />,
    );
    const first = captureResultOpen(0);
    const second = captureResultOpen(1);
    focusOwner.focus();
    const activeElement = document.activeElement;
    const markup = document.body.innerHTML;

    const rejected = [
      invokeResultControl(first, second.element),
      invokeResultControl(second, first.element),
      invokeResultControl(first, foreign),
    ];
    for (const event of rejected) {
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(activeElement);
    expect(document.body.innerHTML).toBe(markup);

    invokeResultControl(first);
    invokeResultControl(second);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    foreign.remove();
    focusOwner.remove();
  });

  it.each([
    "detached anchor",
    "replacement anchor",
    "detached row",
    "replacement list",
    "replacement root",
    "moved root",
    "reordered rows",
    "wrong destination",
  ] as const)("rejects an Open handler when its publication has a %s", (change) => {
    const onOpenChange = vi.fn();
    render(
      <ImportDialog
        open
        onOpenChange={onOpenChange}
        items={[
          { name: "first.md", status: "done", id: "first", warnings: [] },
          { name: "second.md", status: "done", id: "second", warnings: [] },
        ]}
        ignored={[]}
      />,
    );
    const open = captureResultOpen();
    const root = screen.getByTestId("import-dialog");
    const list = screen.getByTestId("import-list");
    const rows = screen.getAllByTestId("import-item");
    let source = open.element;
    let restore = () => {};

    if (change === "detached anchor") {
      const row = open.element.parentElement!;
      open.element.remove();
      restore = () => row.append(open.element);
    } else if (change === "replacement anchor") {
      const row = open.element.parentElement!;
      const replacement = open.element.cloneNode(true) as HTMLAnchorElement;
      row.replaceChild(replacement, open.element);
      source = replacement;
      restore = () => row.replaceChild(open.element, replacement);
    } else if (change === "detached row") {
      rows[0].remove();
      restore = () => list.insertBefore(rows[0], rows[1]);
    } else if (change === "replacement list") {
      const replacement = list.cloneNode(true);
      root.replaceChild(replacement, list);
      restore = () => root.replaceChild(list, replacement);
    } else if (change === "replacement root") {
      const parent = root.parentElement!;
      const replacement = root.cloneNode(true);
      parent.replaceChild(replacement, root);
      restore = () => parent.replaceChild(root, replacement);
    } else if (change === "moved root") {
      const parent = root.parentElement!;
      const foreign = document.createElement("div");
      document.body.append(foreign);
      foreign.append(root);
      restore = () => {
        parent.append(root);
        foreign.remove();
      };
    } else if (change === "reordered rows") {
      list.append(rows[0]);
      restore = () => list.insertBefore(rows[0], rows[1]);
    } else {
      open.element.setAttribute("href", "/d/wrong");
      restore = () => open.element.setAttribute("href", "/d/first");
    }

    const activeElement = document.activeElement;
    const markup = document.body.innerHTML;
    const event = invokeResultControl(open, source);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(activeElement);
    expect(document.body.innerHTML).toBe(markup);
    restore();
  });

  it.each(["stale first", "current first"] as const)(
    "rejects A-handler/B-control and B-handler/A-control after DOM replacement with %s ordering",
    (order) => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const staleOpenChange = vi.fn();
      const currentOpenChange = vi.fn();
      const staleRetry = vi.fn();
      const currentRetry = vi.fn();

      try {
        act(() => {
          root.render(
            <ImportLayoutBoundary>
              <ImportDialog
                key="A"
                open
                onOpenChange={staleOpenChange}
                items={resultItems(staleRetry)}
                ignored={[]}
              />
            </ImportLayoutBoundary>,
          );
        });
        const staleOpen = captureResultOpen();
        const staleRetryControl = captureResultRetry();

        act(() => {
          root.render(
            <ImportLayoutBoundary
              boundary={1}
              onBoundary={() => {
                invokeResultControl(staleOpen);
                invokeResultControl(staleRetryControl);
                expect(staleOpenChange).not.toHaveBeenCalled();
                expect(staleRetry).not.toHaveBeenCalled();
              }}
            >
              <ImportDialog
                key="B"
                open
                onOpenChange={currentOpenChange}
                items={resultItems(currentRetry)}
                ignored={[]}
              />
            </ImportLayoutBoundary>,
          );
        });

        const currentOpen = captureResultOpen();
        const currentRetryControl = captureResultRetry();
        expect(currentOpen.element).not.toBe(staleOpen.element);
        expect(currentRetryControl.element).not.toBe(staleRetryControl.element);
        expect(staleOpen.element.isConnected).toBe(false);
        expect(staleRetryControl.element.isConnected).toBe(false);
        const staleAttempts = () => {
          invokeResultControl(staleOpen);
          invokeResultControl(staleOpen, currentOpen.element);
          invokeResultControl(staleRetryControl);
          invokeResultControl(staleRetryControl, currentRetryControl.element);
          invokeResultControl(currentOpen, staleOpen.element);
          invokeResultControl(currentRetryControl, staleRetryControl.element);
        };
        const currentAttempts = () => {
          invokeResultControl(currentOpen);
          invokeResultControl(currentRetryControl);
        };
        if (order === "stale first") {
          staleAttempts();
          currentAttempts();
        } else {
          currentAttempts();
          staleAttempts();
        }
        expect(staleOpenChange).not.toHaveBeenCalled();
        expect(staleRetry).not.toHaveBeenCalled();
        expect(currentOpenChange).toHaveBeenCalledExactlyOnceWith(false);
        expect(currentRetry).toHaveBeenCalledOnce();
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["stale first", "current first"] as const)(
    "rebinds reused DOM to replacement callbacks and equal-looking rows before the parent layout with %s ordering",
    (order) => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const staleOpenChange = vi.fn();
      const currentOpenChange = vi.fn();
      const staleRetry = vi.fn();
      const currentRetry = vi.fn();

      try {
        act(() => {
          root.render(
            <ImportLayoutBoundary>
              <ImportDialog
                open
                onOpenChange={staleOpenChange}
                items={resultItems(staleRetry)}
                ignored={["same.pdf"]}
              />
            </ImportLayoutBoundary>,
          );
        });
        const staleRoot = screen.getByTestId("import-dialog");
        const staleRootRef = reactRef(staleRoot);
        const staleOpen = captureResultOpen();
        const staleRetryControl = captureResultRetry();

        act(() => {
          root.render(
            <ImportLayoutBoundary
              boundary={1}
              onBoundary={() => {
                const currentRoot = screen.getByTestId("import-dialog");
                const currentOpen = captureResultOpen();
                const currentRetryControl = captureResultRetry();
                expect(currentRoot).toBe(staleRoot);
                expect(currentOpen.element).toBe(staleOpen.element);
                expect(currentRetryControl.element).toBe(staleRetryControl.element);

                staleRootRef(currentRoot);
                staleRootRef(null);
                if (order === "stale first") {
                  invokeResultControl(staleOpen, currentOpen.element);
                  invokeResultControl(staleRetryControl, currentRetryControl.element);
                  invokeResultControl(currentOpen);
                  invokeResultControl(currentRetryControl);
                } else {
                  invokeResultControl(currentOpen);
                  invokeResultControl(currentRetryControl);
                  invokeResultControl(staleOpen, currentOpen.element);
                  invokeResultControl(staleRetryControl, currentRetryControl.element);
                }
              }}
            >
              <ImportDialog
                open
                onOpenChange={currentOpenChange}
                items={resultItems(currentRetry)}
                ignored={["same.pdf"]}
              />
            </ImportLayoutBoundary>,
          );
        });

        expect(staleOpenChange).not.toHaveBeenCalled();
        expect(staleRetry).not.toHaveBeenCalled();
        expect(currentOpenChange).toHaveBeenCalledExactlyOnceWith(false);
        expect(currentRetry).toHaveBeenCalledOnce();
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );

  it("retires removed result controls before parent layout and leaves a later publication usable", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const staleOpenChange = vi.fn();
    const currentOpenChange = vi.fn();
    const staleRetry = vi.fn();
    const currentRetry = vi.fn();

    try {
      act(() => {
        root.render(
          <ImportLayoutBoundary>
            <ImportDialog open onOpenChange={staleOpenChange} items={resultItems(staleRetry)} ignored={[]} />
          </ImportLayoutBoundary>,
        );
      });
      const staleOpen = captureResultOpen();
      const staleRetryControl = captureResultRetry();
      const staleRootRef = reactRef(screen.getByTestId("import-dialog"));

      act(() => {
        root.render(
          <ImportLayoutBoundary
            boundary={1}
            onBoundary={() => {
              invokeResultControl(staleOpen);
              invokeResultControl(staleRetryControl);
              staleRootRef(null);
            }}
          >
            {null}
          </ImportLayoutBoundary>,
        );
      });
      expect(staleOpenChange).not.toHaveBeenCalled();
      expect(staleRetry).not.toHaveBeenCalled();

      act(() => {
        root.render(
          <ImportLayoutBoundary boundary={2}>
            <ImportDialog open onOpenChange={currentOpenChange} items={resultItems(currentRetry)} ignored={[]} />
          </ImportLayoutBoundary>,
        );
      });
      invokeResultControl(captureResultOpen());
      invokeResultControl(captureResultRetry());
      expect(currentOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(currentRetry).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it.each([
    "item order",
    "row identity",
    "name",
    "status",
    "id",
    "title",
    "error",
    "warnings",
    "warnings array",
    "retry callback",
    "ignored names",
  ] as const)("rejects exact controls after an in-place %s mutation", (mutation) => {
    const onOpenChange = vi.fn();
    const retry = vi.fn();
    const replacementRetry = vi.fn();
    const items = resultItems(retry);
    const ignored = ["skip.pdf"];
    render(<ImportDialog open onOpenChange={onOpenChange} items={items} ignored={ignored} />);
    const open = captureResultOpen();
    const retryControl = captureResultRetry();
    let restore = () => {};

    if (mutation === "item order") {
      items.reverse();
      restore = () => items.reverse();
    } else if (mutation === "row identity") {
      const original = items[0];
      items[0] = { ...original };
      restore = () => {
        items[0] = original;
      };
    } else if (mutation === "name") {
      items[0].name = "changed.md";
      restore = () => {
        items[0].name = "first.md";
      };
    } else if (mutation === "status") {
      items[0].status = "uploading";
      restore = () => {
        items[0].status = "done";
      };
    } else if (mutation === "id") {
      items[0].id = "changed";
      restore = () => {
        items[0].id = "doc-first";
      };
    } else if (mutation === "title") {
      items[0].title = "Changed";
      restore = () => {
        items[0].title = "First";
      };
    } else if (mutation === "error") {
      items[1].error = "Changed failure";
      restore = () => {
        items[1].error = "Second failed";
      };
    } else if (mutation === "warnings") {
      items[0].warnings.push("Changed warning");
      restore = () => {
        items[0].warnings.pop();
      };
    } else if (mutation === "warnings array") {
      const original = items[0].warnings;
      items[0].warnings = [...original];
      restore = () => {
        items[0].warnings = original;
      };
    } else if (mutation === "retry callback") {
      items[1].retry = replacementRetry;
      restore = () => {
        items[1].retry = retry;
      };
    } else {
      ignored.push("changed.zip");
      restore = () => {
        ignored.pop();
      };
    }

    const activeElement = document.activeElement;
    const markup = document.body.innerHTML;
    const openEvent = invokeResultControl(open);
    const retryEvent = invokeResultControl(retryControl);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(replacementRetry).not.toHaveBeenCalled();
    expect(openEvent.preventDefault).not.toHaveBeenCalled();
    expect(openEvent.stopPropagation).not.toHaveBeenCalled();
    expect(retryEvent.preventDefault).not.toHaveBeenCalled();
    expect(retryEvent.stopPropagation).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(activeElement);
    expect(document.body.innerHTML).toBe(markup);
    restore();
  });

  it.each(["sibling", "foreign", "detached", "replacement", "moved", "disabled"] as const)(
    "rejects a %s Retry control without invoking or poisoning the current callback",
    (source) => {
      const retry = vi.fn();
      const foreign = document.createElement("button");
      document.body.append(foreign);
      const view = render(
        <ImportDialog
          open
          onOpenChange={vi.fn()}
          items={resultItems(retry)}
          ignored={[]}
          footer={
            <button type="button" data-testid="import-footer-button">
              Footer
            </button>
          }
        />,
      );
      const control = captureResultRetry();
      const root = screen.getByTestId("import-dialog");
      const sibling = screen.getByTestId("import-footer-button") as HTMLButtonElement;
      const parent = control.element.parentElement!;
      let currentTarget = source === "sibling" ? sibling : foreign;
      let restore = () => {};
      let needsSuccessor = false;

      if (source === "detached") {
        currentTarget = control.element;
        control.element.remove();
        restore = () => parent.insertBefore(control.element, sibling);
        needsSuccessor = true;
      } else if (source === "replacement") {
        const replacement = control.element.cloneNode(true) as HTMLButtonElement;
        parent.replaceChild(replacement, control.element);
        currentTarget = replacement;
        restore = () => parent.replaceChild(control.element, replacement);
        needsSuccessor = true;
      } else if (source === "moved") {
        currentTarget = control.element;
        foreign.append(control.element);
        restore = () => parent.insertBefore(control.element, sibling);
        needsSuccessor = true;
      } else if (source === "disabled") {
        currentTarget = control.element;
        control.element.disabled = true;
        restore = () => {
          control.element.disabled = false;
        };
        needsSuccessor = true;
      }

      const activeElement = document.activeElement;
      const markup = document.body.innerHTML;
      const event = invokeResultControl(control, currentTarget);
      expect(retry).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(activeElement);
      expect(document.body.innerHTML).toBe(markup);
      restore();

      if (needsSuccessor) {
        view.rerender(
          <ImportDialog
            open
            onOpenChange={vi.fn()}
            items={resultItems(retry)}
            ignored={[]}
            footer={
              <button type="button" data-testid="import-footer-button">
                Footer
              </button>
            }
          />,
        );
      }
      invokeResultControl(needsSuccessor ? captureResultRetry() : control);
      expect(retry).toHaveBeenCalledOnce();
      expect(screen.getByTestId("import-dialog")).toBe(root);
      foreign.remove();
    },
  );

  it("keeps Retry disabled while the exact batch is busy and enables the successor result", () => {
    const retry = vi.fn();
    const items = resultItems(retry);
    items.push({ name: "pending.md", status: "uploading", warnings: [] });
    const view = render(<ImportDialog open onOpenChange={vi.fn()} items={items} ignored={[]} />);
    const busyRetry = captureResultRetry();
    expect(busyRetry.element).toBeDisabled();
    invokeResultControl(busyRetry);
    expect(retry).not.toHaveBeenCalled();

    items[2] = { name: "pending.md", status: "done", id: "pending", warnings: [] };
    view.rerender(<ImportDialog open onOpenChange={vi.fn()} items={items} ignored={[]} />);
    const enabledRetry = captureResultRetry();
    expect(enabledRetry.element).toBeEnabled();
    invokeResultControl(busyRetry, enabledRetry.element);
    expect(retry).not.toHaveBeenCalled();
    invokeResultControl(enabledRetry);
    expect(retry).toHaveBeenCalledOnce();
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
    expect(uploadImportBatch).toHaveBeenNthCalledWith(1, [first, second], [image]);
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
