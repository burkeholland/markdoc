// @vitest-environment jsdom
import { useEffect, useLayoutEffect, type ChangeEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const primitiveCapture = vi.hoisted(() => ({ latest: new Map<string, unknown>() }));

vi.mock("@/components/ui/primitives", async () => {
  const React = await import("react");
  const handlerNames = ["onChange", "onClick", "onFocus", "onKeyDown", "onMouseEnter", "onMouseLeave", "onSubmit"] as const;

  const collectHandlers = (node: ReactNode, title: string) => {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement<Record<string, unknown>>(child)) return;
      const props = child.props;
      const children = props.children as ReactNode;
      const label = child.type === "form" ? "form" : props["data-testid"] ?? props["aria-label"] ?? (typeof children === "string" ? children : null);
      if (typeof label === "string") {
        for (const handlerName of handlerNames) {
          const handler = props[handlerName];
          if (typeof handler === "function") primitiveCapture.latest.set(`${title}.${label}.${handlerName}`, handler);
        }
      }
      collectHandlers(children, title);
    });
  };

  return {
    Dialog({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) {
      primitiveCapture.latest.set("dialog.onOpenChange", onOpenChange);
      return open ? React.createElement(React.Fragment, null, children) : null;
    },
    DialogContent({
      title,
      children,
      onClosed,
    }: {
      title: string;
      children: ReactNode;
      onClosed?: () => void;
    }) {
      collectHandlers(children, title);
      if (onClosed) primitiveCapture.latest.set(`${title}.onClosed`, onClosed);
      return React.createElement("div", { role: "dialog", "aria-label": title }, children);
    },
    Kbd({ children }: { children: ReactNode }) {
      return React.createElement("kbd", null, children);
    },
  };
});

import { ImageDialog, LinkDialog, TableDialog } from "./dialogs";

interface UploadResult {
  url: string;
  alt?: string;
}

interface LinkActions {
  onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  onSubmit: ReturnType<typeof vi.fn<(href: string, text: string) => void>>;
  onRemove: ReturnType<typeof vi.fn<() => void>>;
}

interface ImageActions {
  onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  onSubmit: ReturnType<typeof vi.fn<(src: string, alt: string) => void>>;
  onUpload: ReturnType<typeof vi.fn<(file: File) => Promise<UploadResult>>>;
}

interface TableActions {
  onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  onSubmit: ReturnType<typeof vi.fn<(rows: number, cols: number) => void>>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function captured<T>(key: string): T {
  const value = primitiveCapture.latest.get(key);
  expect(value, `captured handler ${key}`).toBeTypeOf("function");
  return value as T;
}

function inputChange(value: string): ChangeEvent<HTMLInputElement> {
  return { target: { value } } as ChangeEvent<HTMLInputElement>;
}

function fileChange(file: File): ChangeEvent<HTMLInputElement> {
  return { target: { files: [file] } } as unknown as ChangeEvent<HTMLInputElement>;
}

function formSubmit(): FormEvent<HTMLFormElement> {
  return { preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>;
}

function keyDown(key: string): KeyboardEvent<HTMLDivElement> {
  return { key, ctrlKey: false, metaKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLDivElement>;
}

function PassiveCleanupProbe({ visit, onCleanup }: { visit: string; onCleanup: () => void }) {
  useEffect(() => onCleanup, [onCleanup, visit]);
  return null;
}

function ParentLayoutBoundary({
  visit,
  present = true,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
  children,
}: {
  visit: string;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup: () => void;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  if (!present) return null;
  return (
    <>
      {children}
      <PassiveCleanupProbe visit={visit} onCleanup={onPassiveCleanup} />
    </>
  );
}

function link(actions: LinkActions, initial: { href: string; text: string } | null = null) {
  return <LinkDialog open initial={initial} {...actions} />;
}

function image(actions: ImageActions) {
  return <ImageDialog open {...actions} />;
}

function table(actions: TableActions) {
  return <TableDialog open {...actions} />;
}

function setFileInputValue(value: string) {
  Object.defineProperty(screen.getByTestId("image-file"), "value", { configurable: true, writable: true, value });
}

const unhandledRejections: unknown[] = [];
const recordUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(reason);
};

beforeEach(() => {
  primitiveCapture.latest.clear();
  unhandledRejections.length = 0;
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  process.off("unhandledRejection", recordUnhandledRejection);
  expect(unhandledRejections).toEqual([]);
});

describe("LinkDialog editor-action visits", () => {
  it.each(["replacement", "removal"] as const)("retires a closing visit before parent layout $transition and keeps the current link usable", async (transition) => {
    const oldActions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
    const currentActions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let passiveCleanups = 0;
    let passiveCleanupsAtBoundary = -1;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      await act(async () => {
        root.render(
          <ParentLayoutBoundary visit="old" onPassiveCleanup={onPassiveCleanup}>
            {link(oldActions, { href: "https://old.example/initial", text: "Old initial" })}
          </ParentLayoutBoundary>,
        );
      });
      fireEvent.change(screen.getByTestId("link-url"), { target: { value: "old.example/draft" } });
      fireEvent.change(screen.getByTestId("link-text"), { target: { value: "Old draft text" } });
      const oldUrlChange = captured<(event: ChangeEvent<HTMLInputElement>) => void>("Edit link.link-url.onChange");
      const oldSubmit = captured<(event: FormEvent<HTMLFormElement>) => void>("Edit link.form.onSubmit");
      const oldRemove = captured<() => void>("Edit link.Remove link.onClick");
      const oldClose = captured<(open: boolean) => void>("dialog.onOpenChange");
      const oldClosed = captured<() => void>("Edit link.onClosed");
      fireEvent.submit(screen.getByTestId("link-submit").closest("form")!);
      expect(oldActions.onOpenChange).toHaveBeenCalledOnce();
      expect(oldActions.onSubmit).not.toHaveBeenCalled();

      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });
      root.render(
        <ParentLayoutBoundary
          visit="current"
          present={transition === "replacement"}
          boundary={1}
          onBoundary={() => {
            passiveCleanupsAtBoundary = passiveCleanups;
            boundaryReached();
          }}
          onPassiveCleanup={onPassiveCleanup}
        >
          {link(currentActions)}
        </ParentLayoutBoundary>,
      );
      await atBoundary;

      expect(passiveCleanupsAtBoundary).toBe(0);
      if (transition === "replacement") {
        expect(screen.getByTestId("link-url")).toHaveValue("");
        expect(screen.getByTestId("link-text")).toHaveValue("");
      } else {
        expect(screen.queryByRole("dialog")).toBeNull();
      }

      await act(async () => {
        oldUrlChange(inputChange("https://stale.example"));
        oldSubmit(formSubmit());
        oldRemove();
        oldClose(false);
        oldClosed();
      });
      expect(oldActions.onOpenChange).toHaveBeenCalledOnce();
      expect(oldActions.onSubmit).not.toHaveBeenCalled();
      expect(oldActions.onRemove).not.toHaveBeenCalled();
      expect(currentActions.onOpenChange).not.toHaveBeenCalled();
      expect(currentActions.onSubmit).not.toHaveBeenCalled();
      expect(currentActions.onRemove).not.toHaveBeenCalled();

      if (transition === "removal") {
        await act(async () => {
          root.render(
            <ParentLayoutBoundary visit="current" boundary={2} onPassiveCleanup={onPassiveCleanup}>
              {link(currentActions)}
            </ParentLayoutBoundary>,
          );
        });
      }
      fireEvent.change(screen.getByTestId("link-url"), { target: { value: " current.example/path " } });
      fireEvent.change(screen.getByTestId("link-text"), { target: { value: " Current text " } });
      fireEvent.submit(screen.getByTestId("link-submit").closest("form")!);
      expect(currentActions.onSubmit).not.toHaveBeenCalled();
      captured<() => void>("Insert link.onClosed")();
      expect(currentActions.onSubmit).toHaveBeenCalledOnce();
      expect(currentActions.onSubmit).toHaveBeenCalledWith("https://current.example/path", "Current text");
      expect(currentActions.onOpenChange).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("loads changed initial values in the same visit without erasing input on ordinary rerenders and still removes once", () => {
    const actions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
    const view = render(link(actions, { href: "https://first.example", text: "First" }));
    fireEvent.change(screen.getByTestId("link-url"), { target: { value: "https://typed.example" } });
    fireEvent.change(screen.getByTestId("link-text"), { target: { value: "Typed" } });

    view.rerender(link(actions, { href: "https://first.example", text: "First" }));
    expect(screen.getByTestId("link-url")).toHaveValue("https://typed.example");
    expect(screen.getByTestId("link-text")).toHaveValue("Typed");

    view.rerender(link(actions, { href: "https://second.example", text: "Second" }));
    expect(screen.getByTestId("link-url")).toHaveValue("https://second.example");
    expect(screen.getByTestId("link-text")).toHaveValue("Second");

    fireEvent.click(screen.getByRole("button", { name: "Remove link" }));
    expect(actions.onRemove).not.toHaveBeenCalled();
    captured<() => void>("Edit link.onClosed")();
    expect(actions.onRemove).toHaveBeenCalledOnce();
  });
});

describe("ImageDialog editor-action visits", () => {
  it.each(
    (["replacement", "removal"] as const).flatMap((transition) =>
      (["success", "failure"] as const).map((settlement) => ({ transition, settlement })),
    ),
  )("retires an old upload $settlement before parent layout $transition without touching the current upload", async ({ transition, settlement }) => {
    const oldPending = deferred<UploadResult>();
    const currentPending = deferred<UploadResult>();
    const oldActions: ImageActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onUpload: vi.fn(() => oldPending.promise) };
    const currentActions: ImageActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onUpload: vi.fn(() => currentPending.promise) };
    const oldFile = new File(["old"], "old.png", { type: "image/png" });
    const currentFile = new File(["current"], "current.webp", { type: "image/webp" });
    const readOldUrl = vi.fn(() => "/api/assets/old");
    const readOldAlt = vi.fn(() => "Old upload");
    const oldResult = {} as UploadResult;
    Object.defineProperties(oldResult, {
      url: { get: readOldUrl },
      alt: { get: readOldAlt },
    });
    const readOldError = vi.fn(() => "Old upload failed");
    const oldError = new Error();
    Object.defineProperty(oldError, "message", { get: readOldError });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let passiveCleanups = 0;
    let passiveCleanupsAtBoundary = -1;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      await act(async () => {
        root.render(
          <ParentLayoutBoundary visit="old" onPassiveCleanup={onPassiveCleanup}>
            {image(oldActions)}
          </ParentLayoutBoundary>,
        );
      });
      fireEvent.change(screen.getByTestId("image-url"), { target: { value: "https://old.example/draft.png" } });
      fireEvent.change(screen.getByTestId("image-alt"), { target: { value: "Old alt draft" } });
      fireEvent.change(screen.getByTestId("image-file"), { target: { files: [oldFile] } });
      expect(oldActions.onUpload).toHaveBeenCalledOnce();
      expect(screen.getByTestId("image-upload")).toHaveTextContent("Uploading…");
      const oldUrlChange = captured<(event: ChangeEvent<HTMLInputElement>) => void>("Insert image.image-url.onChange");
      const oldAltChange = captured<(event: ChangeEvent<HTMLInputElement>) => void>("Insert image.image-alt.onChange");
      const oldFileChange = captured<(event: ChangeEvent<HTMLInputElement>) => void>("Insert image.image-file.onChange");
      const oldSubmit = captured<(event: FormEvent<HTMLFormElement>) => void>("Insert image.form.onSubmit");
      const oldClose = captured<(open: boolean) => void>("dialog.onOpenChange");
      const oldClosed = captured<() => void>("Insert image.onClosed");

      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });
      root.render(
        <ParentLayoutBoundary
          visit="current"
          present={transition === "replacement"}
          boundary={1}
          onBoundary={() => {
            passiveCleanupsAtBoundary = passiveCleanups;
            if (transition === "replacement") {
              const currentFileChange = captured<(event: ChangeEvent<HTMLInputElement>) => void>("Insert image.image-file.onChange");
              setFileInputValue("current-selection");
              currentFileChange(fileChange(currentFile));
            }
            if (settlement === "success") oldPending.resolve(oldResult);
            else oldPending.reject(oldError);
            boundaryReached();
          }}
          onPassiveCleanup={onPassiveCleanup}
        >
          {image(currentActions)}
        </ParentLayoutBoundary>,
      );
      await atBoundary;
      await act(async () => {
        await Promise.allSettled([oldPending.promise]);
        await Promise.resolve();
      });

      expect(passiveCleanupsAtBoundary).toBe(0);
      expect(readOldUrl).not.toHaveBeenCalled();
      expect(readOldAlt).not.toHaveBeenCalled();
      expect(readOldError).not.toHaveBeenCalled();
      expect(oldActions.onSubmit).not.toHaveBeenCalled();
      expect(oldActions.onOpenChange).not.toHaveBeenCalled();

      if (transition === "replacement") {
        expect(currentActions.onUpload).toHaveBeenCalledOnce();
        expect(screen.getByTestId("image-url")).toHaveValue("");
        expect(screen.getByTestId("image-alt")).toHaveValue("");
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByTestId("image-upload")).toHaveTextContent("Uploading…");
        expect(screen.getByTestId("image-file")).toHaveValue("current-selection");
      } else {
        expect(screen.queryByRole("dialog")).toBeNull();
      }

      await act(async () => {
        oldUrlChange(inputChange("https://stale.example/result.png"));
        oldAltChange(inputChange("Stale alt"));
        oldFileChange(fileChange(oldFile));
        oldSubmit(formSubmit());
        oldClose(false);
        oldClosed();
      });
      expect(oldActions.onUpload).toHaveBeenCalledOnce();
      expect(oldActions.onSubmit).not.toHaveBeenCalled();
      expect(oldActions.onOpenChange).not.toHaveBeenCalled();
      expect(currentActions.onOpenChange).not.toHaveBeenCalled();

      if (transition === "removal") {
        await act(async () => {
          root.render(
            <ParentLayoutBoundary visit="current" boundary={2} onPassiveCleanup={onPassiveCleanup}>
              {image(currentActions)}
            </ParentLayoutBoundary>,
          );
        });
        fireEvent.change(screen.getByTestId("image-file"), { target: { files: [currentFile] } });
        expect(currentActions.onUpload).toHaveBeenCalledOnce();
      }

      const currentInput = screen.getByTestId("image-file") as HTMLInputElement;
      if (transition === "removal") setFileInputValue("current-selection");
      await act(async () => currentPending.resolve({ url: "/api/assets/current", alt: "Current upload" }));
      expect(screen.getByTestId("image-url")).toHaveValue("/api/assets/current");
      expect(screen.getByTestId("image-alt")).toHaveValue("Current upload");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTestId("image-upload")).toBeEnabled();
      expect(currentInput.value).toBe("");

      fireEvent.submit(screen.getByTestId("image-submit").closest("form")!);
      expect(currentActions.onSubmit).not.toHaveBeenCalled();
      if (transition === "replacement") oldClosed();
      captured<() => void>("Insert image.onClosed")();
      expect(currentActions.onSubmit).toHaveBeenCalledOnce();
      expect(currentActions.onSubmit).toHaveBeenCalledWith("/api/assets/current", "Current upload");
      expect(currentActions.onOpenChange).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["replacement", "removal"] as const)("retires a deferred image insert while closing at $transition", async (transition) => {
    const oldActions: ImageActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onUpload: vi.fn() };
    const currentActions: ImageActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onUpload: vi.fn() };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onPassiveCleanup = vi.fn();

    try {
      await act(async () => {
        root.render(
          <ParentLayoutBoundary visit="old" onPassiveCleanup={onPassiveCleanup}>
            {image(oldActions)}
          </ParentLayoutBoundary>,
        );
      });
      fireEvent.change(screen.getByTestId("image-url"), { target: { value: " https://old.example/image.png " } });
      fireEvent.change(screen.getByTestId("image-alt"), { target: { value: " Old image " } });
      fireEvent.submit(screen.getByTestId("image-submit").closest("form")!);
      const oldClosed = captured<() => void>("Insert image.onClosed");
      expect(oldActions.onOpenChange).toHaveBeenCalledOnce();

      await act(async () => {
        root.render(
          <ParentLayoutBoundary visit="current" present={transition === "replacement"} boundary={1} onPassiveCleanup={onPassiveCleanup}>
            {image(currentActions)}
          </ParentLayoutBoundary>,
        );
      });
      oldClosed();
      expect(oldActions.onSubmit).not.toHaveBeenCalled();

      if (transition === "removal") {
        await act(async () => {
          root.render(
            <ParentLayoutBoundary visit="current" boundary={2} onPassiveCleanup={onPassiveCleanup}>
              {image(currentActions)}
            </ParentLayoutBoundary>,
          );
        });
      }
      expect(screen.getByTestId("image-url")).toHaveValue("");
      expect(screen.getByTestId("image-alt")).toHaveValue("");
      fireEvent.change(screen.getByTestId("image-url"), { target: { value: " /current.png " } });
      fireEvent.submit(screen.getByTestId("image-submit").closest("form")!);
      captured<() => void>("Insert image.onClosed")();
      expect(currentActions.onSubmit).toHaveBeenCalledOnce();
      expect(currentActions.onSubmit).toHaveBeenCalledWith("/current.png", "");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("TableDialog editor-action visits", () => {
  it.each(["replacement", "removal"] as const)("retires hover, focus, cell, close, and after-close handlers at parent layout $transition", async (transition) => {
    const oldActions: TableActions = { onOpenChange: vi.fn(), onSubmit: vi.fn() };
    const currentActions: TableActions = { onOpenChange: vi.fn(), onSubmit: vi.fn() };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let passiveCleanups = 0;
    let passiveCleanupsAtBoundary = -1;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      await act(async () => {
        root.render(
          <ParentLayoutBoundary visit="old" onPassiveCleanup={onPassiveCleanup}>
            {table(oldActions)}
          </ParentLayoutBoundary>,
        );
      });
      fireEvent.mouseEnter(screen.getByRole("button", { name: "5 by 6" }));
      expect(screen.getByTestId("table-grid-label")).toHaveTextContent("5 rows × 6 columns");
      const oldHover = captured<() => void>("Insert table.5 by 6.onMouseEnter");
      const oldFocus = captured<() => void>("Insert table.5 by 6.onFocus");
      const oldCell = captured<() => void>("Insert table.5 by 6.onClick");
      const oldKey = captured<(event: KeyboardEvent<HTMLDivElement>) => void>("Insert table.table-grid.onKeyDown");
      const oldClose = captured<(open: boolean) => void>("dialog.onOpenChange");
      const oldClosed = captured<() => void>("Insert table.onClosed");
      fireEvent.click(screen.getByRole("button", { name: "5 by 6" }));
      expect(oldActions.onOpenChange).toHaveBeenCalledOnce();

      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });
      root.render(
        <ParentLayoutBoundary
          visit="current"
          present={transition === "replacement"}
          boundary={1}
          onBoundary={() => {
            passiveCleanupsAtBoundary = passiveCleanups;
            boundaryReached();
          }}
          onPassiveCleanup={onPassiveCleanup}
        >
          {table(currentActions)}
        </ParentLayoutBoundary>,
      );
      await atBoundary;

      expect(passiveCleanupsAtBoundary).toBe(0);
      if (transition === "replacement") {
        expect(screen.getByTestId("table-grid-label")).toHaveTextContent("1 rows × 1 columns");
        expect(screen.getAllByRole("gridcell")).toHaveLength(48);
        expect(screen.getAllByRole("button").filter((button) => button.tabIndex === 0)).toHaveLength(1);
      } else {
        expect(screen.queryByRole("dialog")).toBeNull();
      }

      await act(async () => {
        oldHover();
        oldFocus();
        oldKey(keyDown("ArrowRight"));
        oldCell();
        oldClose(false);
        oldClosed();
      });
      expect(oldActions.onOpenChange).toHaveBeenCalledOnce();
      expect(oldActions.onSubmit).not.toHaveBeenCalled();
      expect(currentActions.onOpenChange).not.toHaveBeenCalled();
      expect(currentActions.onSubmit).not.toHaveBeenCalled();

      if (transition === "removal") {
        await act(async () => {
          root.render(
            <ParentLayoutBoundary visit="current" boundary={2} onPassiveCleanup={onPassiveCleanup}>
              {table(currentActions)}
            </ParentLayoutBoundary>,
          );
        });
      }
      fireEvent.focus(screen.getByRole("button", { name: "3 by 4" }));
      expect(screen.getByTestId("table-grid-label")).toHaveTextContent("3 rows × 4 columns");
      fireEvent.click(screen.getByRole("button", { name: "3 by 4" }));
      expect(currentActions.onSubmit).not.toHaveBeenCalled();
      captured<() => void>("Insert table.onClosed")();
      expect(currentActions.onSubmit).toHaveBeenCalledOnce();
      expect(currentActions.onSubmit).toHaveBeenCalledWith(3, 4);
      expect(currentActions.onOpenChange).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
