// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useLayoutEffect, useState, type ReactNode, type RefCallback } from "react";
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
}: {
  label?: string;
  batches: File[][];
  onError: (message: string) => void;
  onDone?: (documents: ImportedDocument[], failed: FailedImport[]) => void;
  captureStart?: (start: ReturnType<typeof useFileImport>["start"]) => void;
  captureRetry?: (retry: (() => void) | undefined) => void;
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
      <ImportDialog open={open} onOpenChange={setOpen} items={items} ignored={ignored} />
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

interface ResultMouseEvent<T extends HTMLElement> {
  currentTarget: T;
  target: T;
  defaultPrevented: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  nativeEvent: { which: number };
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

function invokeResultControl<T extends HTMLElement>(
  control: CapturedResultControl<T>,
  currentTarget: T = control.element,
): ResultMouseEvent<T> {
  const event: ResultMouseEvent<T> = {
    currentTarget,
    target: currentTarget,
    defaultPrevented: false,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    nativeEvent: { which: 1 },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  control.onClick(event);
  return event;
}

function resultItems(retry: () => void): ImportItem[] {
  return [
    {
      name: "first.md",
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

describe("ImportDialog result publications", () => {
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
    expect(initialRows.map((row) => row.querySelector("[title]")?.textContent)).toEqual(["First", "second.md"]);
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
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("import-dialog")).toBeInTheDocument();
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
