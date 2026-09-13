// @vitest-environment jsdom
import {
  Suspense,
  StrictMode,
  startTransition,
  useCallback,
  useLayoutEffect,
  useState,
  type ChangeEvent,
  type ChangeEventHandler,
  type FormEvent,
  type FormEventHandler,
  type ReactNode,
  type RefCallback,
  type SyntheticEvent,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import { ImageDialog } from "./dialogs";

const PRE_RENDER_EVENT_PREVENT_DEFAULT = Event.prototype.preventDefault;

interface UploadResult {
  url: string;
  alt?: string;
}

interface DirectView {
  host: HTMLDivElement;
  root: Root;
  render: (node: ReactNode) => Promise<void>;
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

const directViews: DirectView[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function Harness({
  onUpload,
  onSubmit,
  initiallyOpen = true,
}: {
  onUpload: (file: File) => Promise<UploadResult>;
  onSubmit?: (src: string, alt: string) => void;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open image dialog
      </button>
      <ImageDialog open={open} onOpenChange={setOpen} onUpload={onUpload} onSubmit={onSubmit ?? vi.fn()} />
    </>
  );
}

function SubmitHarness({
  onOpenChange,
  onSubmit,
}: {
  onOpenChange: (open: boolean) => void;
  onSubmit: (src: string, alt: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const setDialogOpen = useCallback(
    (nextOpen: boolean) => {
      onOpenChange(nextOpen);
      setOpen(nextOpen);
    },
    [onOpenChange],
  );
  return (
    <ImageDialog
      open={open}
      onOpenChange={setDialogOpen}
      onSubmit={onSubmit}
    />
  );
}

function choose(file: File) {
  fireEvent.change(screen.getByTestId("image-file"), { target: { files: [file] } });
}

function setInputValue(input: HTMLInputElement, value: string) {
  Object.defineProperty(input, "value", { configurable: true, writable: true, value });
}

function armDirtyFileTypeRead(
  input: HTMLInputElement,
  onRead: () => void,
) {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "type",
  );
  if (!descriptor?.get || !descriptor.set) {
    throw new Error("HTMLInputElement.type accessors are unavailable");
  }
  Object.defineProperty(input, "type", {
    configurable: true,
    get() {
      Reflect.deleteProperty(input, "type");
      onRead();
      return descriptor.get?.call(input);
    },
    set(value: string) {
      descriptor.set?.call(input, value);
    },
  });
}

function reactProp<T>(element: Element, name: string): T {
  const key = Object.getOwnPropertyNames(element).find((candidate) =>
    candidate.startsWith("__reactProps$"),
  );
  if (!key) throw new Error("React props were not attached to the element");
  const props = (element as unknown as Record<string, Record<string, unknown>>)[
    key
  ];
  const value = props?.[name];
  if (typeof value !== "function") {
    throw new Error(`${name} was not attached to the element`);
  }
  return value as T;
}

async function chooseFromCommittedSuccessor(
  file: File,
  settledInput: HTMLInputElement,
) {
  const upload = screen.getByTestId("image-upload");
  await userEvent.setup().hover(upload);
  expect(screen.getByTestId("image-file")).toBe(settledInput);
  expect(screen.getByTestId("image-upload-error")).toBeVisible();
  expect(settledInput).toBeEnabled();
  expect(settledInput).toHaveValue("");
  expect(upload).toBeEnabled();
  fireEvent.change(settledInput, { target: { files: [file] } });
}

function reactAncestorHandlers<T extends (...args: never[]) => unknown>(
  element: Element,
  name: string,
) {
  const key = Object.getOwnPropertyNames(element).find((candidate) =>
    candidate.startsWith("__reactFiber$"),
  );
  if (!key) throw new Error("React fiber was not attached to the element");
  let fiber = (element as unknown as Record<string, unknown>)[key] as
    | {
        memoizedProps?: Record<string, unknown>;
        return?: unknown;
      }
    | null;
  const handlers: T[] = [];
  while (fiber) {
    const handler = fiber.memoizedProps?.[name];
    if (
      typeof handler === "function" &&
      !handlers.includes(handler as T)
    ) {
      handlers.push(handler as T);
    }
    fiber = fiber.return as typeof fiber;
  }
  return handlers;
}

function setReactProp<T>(element: Element, name: string, value: T) {
  const key = Object.getOwnPropertyNames(element).find((candidate) =>
    candidate.startsWith("__reactProps$"),
  );
  if (!key) throw new Error("React props were not attached to the element");
  const target = element as unknown as Record<
    string,
    Record<string, unknown>
  >;
  target[key] = { ...target[key], [name]: value };
}

async function renderStrictRoot(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const renderNode = async (next: ReactNode) => {
    await act(async () => {
      root.render(<StrictMode>{next}</StrictMode>);
    });
  };
  const view = { host, root, render: renderNode };
  directViews.push(view);
  await renderNode(node);
  return view;
}

function submitEvent() {
  return typeof window.SubmitEvent === "function"
    ? new SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
        submitter: null,
      })
    : new Event("submit", { bubbles: true, cancelable: true });
}

function dialogContent() {
  return screen.getByRole("dialog") as HTMLDivElement;
}

function imageForm() {
  const form = screen.getByTestId("image-url").closest("form");
  if (!(form instanceof HTMLFormElement)) {
    throw new Error("Image form was not rendered");
  }
  return form;
}

async function submitCleanSuccess(
  view: DirectView,
  onOpenChange: (open: boolean) => void,
  onSubmit: (src: string, alt: string) => void,
  url: string,
) {
  await view.render(
    <SubmitHarness onOpenChange={onOpenChange} onSubmit={onSubmit} />,
  );
  fireEvent.change(screen.getByTestId("image-url"), {
    target: { value: url },
  });
  await act(async () => {});
  const submit = submitEvent();
  let dispatched = true;
  act(() => {
    dispatched = imageForm().dispatchEvent(submit);
  });
  expect(dispatched).toBe(false);
  expect(submit.defaultPrevented).toBe(true);
  expect(onOpenChange).toHaveBeenCalledOnce();
  expect(onOpenChange).toHaveBeenCalledWith(false);
  await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  expect(onSubmit).toHaveBeenCalledWith(url, "");
}

beforeEach(() => {
  vi.stubGlobal("PointerEvent", ControlledPointerEvent);
});

afterEach(async () => {
  cleanup();
  for (const view of directViews.splice(0)) {
    await act(async () => view.root.unmount());
    view.host.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ImageDialog upload lifecycle", () => {
  it("releases a canceled pending upload and its native form guard", async () => {
    const pending = deferred<UploadResult>();
    const retry = deferred<UploadResult>();
    const onUpload = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockReturnValueOnce(retry.promise);
    const onSubmit = vi.fn();
    await renderStrictRoot(
      <Harness onUpload={onUpload} onSubmit={onSubmit} />,
    );
    const selected = new File(["selected"], "selected.png", {
      type: "image/png",
    });
    choose(selected);
    const oldForm = imageForm();
    const oldInput = screen.getByTestId("image-file");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const staleListener = vi.fn();
    oldForm.addEventListener("submit", staleListener, { once: true });
    const staleSubmit = submitEvent();
    expect(oldForm.dispatchEvent(staleSubmit)).toBe(true);
    expect(staleSubmit.defaultPrevented).toBe(false);
    expect(staleListener).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();

    const readUrl = vi.fn(() => "/api/assets/stale");
    const staleResult = {} as UploadResult;
    Object.defineProperty(staleResult, "url", { get: readUrl });
    await act(async () => {
      pending.resolve(staleResult);
      await pending.promise;
    });
    expect(readUrl).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Open image dialog" }),
    );
    const currentInput = screen.getByTestId("image-file");
    expect(currentInput).not.toBe(oldInput);
    const currentFile = new File(["current"], "current.png", {
      type: "image/png",
    });
    choose(currentFile);
    expect(onUpload).toHaveBeenCalledTimes(2);
    expect(onUpload).toHaveBeenLastCalledWith(currentFile);
    await act(async () => {
      retry.resolve({ url: "/api/assets/current" });
      await retry.promise;
    });
    expect(screen.getByTestId("image-url")).toHaveValue(
      "/api/assets/current",
    );
  });

  it("releases an inserted form guard and reopens with distinct controls", async () => {
    const onSubmit = vi.fn();
    await renderStrictRoot(
      <Harness onUpload={vi.fn()} onSubmit={onSubmit} />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/first.png" },
    });
    await act(async () => {});
    const oldForm = imageForm();
    const oldInput = screen.getByTestId("image-url");
    const firstSubmit = submitEvent();
    expect(oldForm.dispatchEvent(firstSubmit)).toBe(false);
    expect(firstSubmit.defaultPrevented).toBe(true);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const staleListener = vi.fn();
    oldForm.addEventListener("submit", staleListener, { once: true });
    const staleSubmit = submitEvent();
    expect(oldForm.dispatchEvent(staleSubmit)).toBe(true);
    expect(staleSubmit.defaultPrevented).toBe(false);
    expect(staleListener).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", { name: "Open image dialog" }),
    );
    expect(screen.getByTestId("image-url")).not.toBe(oldInput);
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/second.png" },
    });
    await act(async () => {});
    expect(imageForm().dispatchEvent(submitEvent())).toBe(false);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith(
      "https://example.com/second.png",
      "",
    );
  });

  it("suppresses synchronous duplicate choices and blocks insertion of an older URL while pending", async () => {
    const pending = deferred<UploadResult>();
    const first = new File(["first"], "first.png", { type: "image/png" });
    const duplicate = new File(["duplicate"], "duplicate.png", { type: "image/png" });
    const onUpload = vi.fn(() => pending.promise);
    const onSubmit = vi.fn();
    render(<Harness onUpload={onUpload} onSubmit={onSubmit} initiallyOpen={false} />);
    const opener = screen.getByRole("button", { name: "Open image dialog" });
    act(() => opener.focus());
    fireEvent.click(opener);

    fireEvent.change(screen.getByTestId("image-url"), { target: { value: "https://example.com/older.png" } });
    choose(first);
    choose(duplicate);

    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(onUpload).toHaveBeenCalledWith(first);
    expect(screen.getByTestId("image-upload")).toBeDisabled();
    expect(screen.getByTestId("image-upload")).toHaveTextContent("Uploading…");
    fireEvent.submit(screen.getByTestId("image-submit").closest("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await act(async () => pending.resolve({ url: "/api/assets/current", alt: "Returned description" }));
    expect(screen.getByTestId("image-url")).toHaveValue("/api/assets/current");
    expect(screen.getByTestId("image-alt")).toHaveValue("Returned description");
    expect(screen.getByTestId("image-upload")).toBeEnabled();

    fireEvent.change(screen.getByTestId("image-url"), { target: { value: " https://example.com/final.png " } });
    fireEvent.change(screen.getByTestId("image-alt"), { target: { value: " Final description " } });
    fireEvent.submit(screen.getByTestId("image-submit").closest("form")!);

    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith("https://example.com/final.png", "Final description");
  });

  it("does not replace alt text edited while the current upload is pending", async () => {
    const pending = deferred<UploadResult>();
    render(<Harness onUpload={() => pending.promise} />);

    choose(new File(["photo"], "photo.jpeg", { type: "image/jpeg" }));
    fireEvent.change(screen.getByTestId("image-alt"), { target: { value: "A description I typed" } });
    await act(async () => pending.resolve({ url: "/api/assets/photo", alt: "Generated description" }));

    expect(screen.getByTestId("image-url")).toHaveValue("/api/assets/photo");
    expect(screen.getByTestId("image-alt")).toHaveValue("A description I typed");
  });

  it("shows the current API reason, clears pending once, and issues one upload for a new-file retry", async () => {
    const failed = deferred<UploadResult>();
    const retry = deferred<UploadResult>();
    const first = new File(["bad"], "bad.png", { type: "image/png" });
    const second = new File(["good"], "retry-shot.webp", { type: "image/webp" });
    const onUpload = vi.fn().mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    render(<Harness onUpload={onUpload} />);

    const input = screen.getByTestId("image-file") as HTMLInputElement;
    choose(first);
    setInputValue(input, "first-selection");
    await act(async () => failed.reject(new ApiError(400, "Invalid request", [{ message: "The image is larger than 5 MB" }])));

    expect(screen.getByRole("alert")).toHaveTextContent("The image is larger than 5 MB");
    expect(screen.getByTestId("image-upload")).toBeEnabled();
    expect(input.value).toBe("");

    choose(second);
    choose(first);
    expect(onUpload).toHaveBeenCalledTimes(2);
    expect(onUpload).toHaveBeenNthCalledWith(2, second);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("image-upload")).toBeDisabled();

    await act(async () => retry.resolve({ url: "/api/assets/retry" }));
    expect(screen.getByTestId("image-url")).toHaveValue("/api/assets/retry");
    expect(screen.getByTestId("image-alt")).toHaveValue("retry-shot");
    expect(screen.getByTestId("image-upload")).toBeEnabled();
  });

  it.each(["url", "alt", "error"] as const)(
    "terminally settles a current upload when its %s getter throws",
    async (getter) => {
      const failed = deferred<UploadResult>();
      const retry = deferred<UploadResult>();
      const onUpload = vi
        .fn()
        .mockReturnValueOnce(failed.promise)
        .mockReturnValueOnce(retry.promise);
      await renderStrictRoot(<Harness onUpload={onUpload} />);

      const input = screen.getByTestId("image-file") as HTMLInputElement;
      const failedFile = new File(["failed"], "failed.png", {
        type: "image/png",
      });
      choose(failedFile);
      expect(onUpload).toHaveBeenCalledOnce();
      expect(onUpload).toHaveBeenCalledWith(failedFile);
      expect(onUpload.mock.results[0]?.value).toBe(failed.promise);
      expect(screen.getByTestId("image-file")).toBe(input);
      expect(input).toBeDisabled();
      setInputValue(input, "failed-selection");
      const getterFailure =
        getter === "url"
          ? "URL result getter failed"
          : getter === "alt"
            ? "Alt result getter failed"
            : "Error message getter failed";
      const readHostileGetter = vi.fn(() => {
        throw new Error(getterFailure);
      });

      if (getter === "error") {
        const error = new Error();
        Object.defineProperty(error, "message", {
          get: readHostileGetter,
        });
        await act(async () => {
          failed.reject(error);
          await failed.promise.catch(() => undefined);
          await Promise.resolve();
        });
      } else {
        const result = {
          alt: "Unread Alt",
          url: "/api/assets/unread",
        } as UploadResult;
        Object.defineProperty(result, getter, {
          get: readHostileGetter,
        });
        await act(async () => {
          failed.resolve(result);
          await failed.promise;
          await Promise.resolve();
        });
      }

      expect(screen.getByRole("alert")).toHaveTextContent(
        getter === "url"
          ? "URL result getter failed"
          : getter === "alt"
            ? "Alt result getter failed"
            : "Upload failed",
      );
      expect(readHostileGetter).toHaveBeenCalledOnce();
      expect(screen.getByTestId("image-upload")).toBeEnabled();
      expect(screen.getByTestId("image-file")).toBe(input);
      expect(input).toBeEnabled();
      expect(input.value).toBe("");

      const retryFile = new File(["retry"], "retry.png", {
        type: "image/png",
      });
      await chooseFromCommittedSuccessor(retryFile, input);
      expect(onUpload).toHaveBeenCalledTimes(2);
      expect(onUpload).toHaveBeenLastCalledWith(retryFile);
      expect(onUpload.mock.results[1]?.value).toBe(retry.promise);
      expect(input).toBeDisabled();
      await act(async () => {
        retry.resolve({ url: "/api/assets/retry", alt: "Retry Alt" });
        await retry.promise;
      });
      await act(async () => {
        if (getter === "error") {
          failed.reject(new Error("Late failure"));
        } else {
          failed.resolve({ url: "/api/assets/late", alt: "Late Alt" });
        }
        await Promise.resolve();
      });
      expect(readHostileGetter).toHaveBeenCalledOnce();
      expect(onUpload).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("image-url")).toHaveValue(
        "/api/assets/retry",
      );
      expect(screen.getByTestId("image-alt")).toHaveValue("Retry Alt");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(input).toBeEnabled();
    },
  );

  it("assimilates a hostile upload promise and remains retryable", async () => {
    const hostile = Promise.resolve<UploadResult>({
      url: "/api/assets/unreachable",
    });
    Object.defineProperty(hostile, "then", {
      get() {
        throw new Error("Upload then getter failed");
      },
    });
    const retry = deferred<UploadResult>();
    const onUpload = vi
      .fn()
      .mockReturnValueOnce(hostile)
      .mockReturnValueOnce(retry.promise);
    await renderStrictRoot(<Harness onUpload={onUpload} />);

    const input = screen.getByTestId("image-file") as HTMLInputElement;
    const hostileFile = new File(["hostile"], "hostile.png", {
      type: "image/png",
    });
    choose(hostileFile);
    expect(onUpload).toHaveBeenCalledOnce();
    expect(onUpload).toHaveBeenCalledWith(hostileFile);
    expect(onUpload.mock.results[0]?.value).toBe(hostile);
    expect(screen.getByTestId("image-file")).toBe(input);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Upload then getter failed",
      ),
    );
    expect(screen.getByTestId("image-upload")).toBeEnabled();
    expect(screen.getByTestId("image-file")).toBe(input);
    expect(input).toBeEnabled();

    const retryFile = new File(["retry"], "retry.png", {
      type: "image/png",
    });
    await chooseFromCommittedSuccessor(retryFile, input);
    expect(onUpload).toHaveBeenCalledTimes(2);
    expect(onUpload).toHaveBeenLastCalledWith(retryFile);
    expect(onUpload.mock.results[1]?.value).toBe(retry.promise);
    await act(async () => {
      retry.resolve({ url: "/api/assets/retry" });
      await retry.promise;
    });
    expect(screen.getByTestId("image-url")).toHaveValue(
      "/api/assets/retry",
    );
  });

  it("clears upload ownership when resetting the current file input throws", async () => {
    const failed = deferred<UploadResult>();
    const retry = deferred<UploadResult>();
    const onUpload = vi
      .fn()
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retry.promise);
    await renderStrictRoot(<Harness onUpload={onUpload} />);
    const input = screen.getByTestId("image-file") as HTMLInputElement;

    choose(new File(["failed"], "failed.png", { type: "image/png" }));
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => "failed-selection",
      set: () => {
        Reflect.deleteProperty(input, "value");
        throw new Error("File reset failed");
      },
    });
    await act(async () => {
      failed.resolve({ url: "/api/assets/failed" });
      await failed.promise;
    });

    expect(screen.getByRole("alert")).toHaveTextContent("File reset failed");
    expect(screen.getByTestId("image-upload")).toBeEnabled();

    const retryFile = new File(["retry"], "retry.webp", {
      type: "image/webp",
    });
    await chooseFromCommittedSuccessor(retryFile, input);
    expect(onUpload).toHaveBeenCalledTimes(2);
    expect(onUpload).toHaveBeenLastCalledWith(retryFile);
    await act(async () => {
      retry.resolve({ url: "/api/assets/reset-retry" });
      await retry.promise;
    });
    expect(screen.getByTestId("image-url")).toHaveValue(
      "/api/assets/reset-retry",
    );
  });

  it.each(["returns", "throws"] as const)(
    "rejects an upload outcome when the file reset %s after arming dirty final validation and permits retry",
    async (behavior) => {
      const failed = deferred<UploadResult>();
      const retry = deferred<UploadResult>();
      const onUpload = vi
        .fn()
        .mockReturnValueOnce(failed.promise)
        .mockReturnValueOnce(retry.promise);
      await renderStrictRoot(<Harness onUpload={onUpload} />);
      const input = screen.getByTestId("image-file") as HTMLInputElement;
      choose(new File(["failed"], "failed.png", { type: "image/png" }));
      const content = dialogContent();
      const dirty = vi.fn(() => {
        const className = content.className;
        content.className = "mutated-during-file-reset";
        content.className = className;
      });

      Object.defineProperty(input, "value", {
        configurable: true,
        get: () => "failed-selection",
        set() {
          if (behavior === "returns") {
            armDirtyFileTypeRead(input, dirty);
            return;
          }
          const error = new Error();
          Object.defineProperty(error, "message", {
            get() {
              armDirtyFileTypeRead(input, dirty);
              return "Untrusted reset failure";
            },
          });
          throw error;
        },
      });
      await act(async () => {
        failed.resolve({
          url: "/api/assets/untrusted",
          alt: "Untrusted Alt",
        });
        await failed.promise;
      });

      expect(dirty).toHaveBeenCalledOnce();
      await waitFor(() =>
        expect(screen.getByTestId("image-upload")).toBeEnabled(),
      );
      expect(screen.getByTestId("image-url")).toHaveValue("");
      expect(screen.getByTestId("image-alt")).toHaveValue("");
      expect(screen.queryByRole("alert")).toBeNull();

      delete (input as unknown as { value?: string }).value;
      const retryFile = new File(["retry"], "retry.png", {
        type: "image/png",
      });
      choose(retryFile);
      expect(onUpload).toHaveBeenCalledTimes(2);
      expect(onUpload).toHaveBeenLastCalledWith(retryFile);
      await act(async () => {
        retry.resolve({ url: "/api/assets/retry", alt: "Retry Alt" });
        await retry.promise;
      });
      expect(screen.getByTestId("image-url")).toHaveValue(
        "/api/assets/retry",
      );
      expect(screen.getByTestId("image-alt")).toHaveValue("Retry Alt");
    },
  );

  it("abandons a current upload invalidated before terminal settlement and permits retry", async () => {
    const failed = deferred<UploadResult>();
    const retry = deferred<UploadResult>();
    const onUpload = vi
      .fn()
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retry.promise);
    await renderStrictRoot(<Harness onUpload={onUpload} />);
    choose(new File(["failed"], "failed.png", { type: "image/png" }));
    const content = dialogContent();
    const className = content.className;
    content.className = "mutated-before-terminal-settlement";
    content.className = className;
    await act(async () => {});
    const readUrl = vi.fn(() => "/api/assets/untrusted");
    const result = { alt: "Untrusted Alt" } as UploadResult;
    Object.defineProperty(result, "url", { get: readUrl });

    await act(async () => {
      failed.resolve(result);
      await failed.promise;
    });
    expect(readUrl).not.toHaveBeenCalled();
    expect(screen.getByTestId("image-upload")).toBeEnabled();
    expect(screen.getByTestId("image-url")).toHaveValue("");
    expect(screen.getByTestId("image-alt")).toHaveValue("");
    expect(screen.queryByRole("alert")).toBeNull();

    const retryFile = new File(["retry"], "retry.png", {
      type: "image/png",
    });
    choose(retryFile);
    expect(onUpload).toHaveBeenCalledTimes(2);
    expect(onUpload).toHaveBeenLastCalledWith(retryFile);
    await act(async () => {
      retry.resolve({ url: "/api/assets/retry" });
      await retry.promise;
    });
    expect(screen.getByTestId("image-url")).toHaveValue(
      "/api/assets/retry",
    );
  });

  it("keeps stale success and finalizer work out of a reopened visit with a newer upload", async () => {
    const stale = deferred<UploadResult>();
    const current = deferred<UploadResult>();
    const onUpload = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    render(<Harness onUpload={onUpload} />);

    choose(new File(["old"], "old.png", { type: "image/png" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Open image dialog" }));
    fireEvent.change(screen.getByTestId("image-url"), { target: { value: "https://example.com/current.png" } });
    fireEvent.change(screen.getByTestId("image-alt"), { target: { value: "Current description" } });
    choose(new File(["new"], "new.png", { type: "image/png" }));
    const currentInput = screen.getByTestId("image-file") as HTMLInputElement;
    setInputValue(currentInput, "current-selection");

    await act(async () => stale.resolve({ url: "/api/assets/stale", alt: "Stale description" }));

    expect(onUpload).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("image-url")).toHaveValue("https://example.com/current.png");
    expect(screen.getByTestId("image-alt")).toHaveValue("Current description");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("image-upload")).toBeDisabled();
    expect(currentInput.value).toBe("current-selection");
    expect(screen.getByTestId("image-url").closest("form")!.querySelector("img")).toHaveAttribute("src", "https://example.com/current.png");

    await act(async () => current.resolve({ url: "/api/assets/current", alt: "New generated description" }));
    expect(screen.getByTestId("image-url")).toHaveValue("/api/assets/current");
    expect(screen.getByTestId("image-alt")).toHaveValue("Current description");
    expect(screen.getByTestId("image-upload")).toBeEnabled();
    expect(currentInput.value).toBe("");
  });

  it("keeps stale errors and finalizers from clearing a reopened visit's pending upload", async () => {
    const stale = deferred<UploadResult>();
    const current = deferred<UploadResult>();
    const onUpload = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    render(<Harness onUpload={onUpload} />);

    choose(new File(["old"], "old.gif", { type: "image/gif" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Open image dialog" }));
    fireEvent.change(screen.getByTestId("image-url"), { target: { value: "https://example.com/current.gif" } });
    fireEvent.change(screen.getByTestId("image-alt"), { target: { value: "Current GIF" } });
    choose(new File(["current"], "current.gif", { type: "image/gif" }));
    const currentInput = screen.getByTestId("image-file") as HTMLInputElement;
    setInputValue(currentInput, "current-selection");

    await act(async () => stale.reject(new Error("Stale upload failed")));

    expect(onUpload).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("image-url")).toHaveValue("https://example.com/current.gif");
    expect(screen.getByTestId("image-alt")).toHaveValue("Current GIF");
    expect(screen.getByTestId("image-upload")).toBeDisabled();
    expect(currentInput.value).toBe("current-selection");

    await act(async () => current.resolve({ url: "/api/assets/current-gif" }));
    expect(screen.getByTestId("image-url")).toHaveValue("/api/assets/current-gif");
    expect(screen.getByTestId("image-alt")).toHaveValue("Current GIF");
    expect(screen.getByTestId("image-upload")).toBeEnabled();
  });

  it("does not consume success or error settlements after unmount", async () => {
    const success = deferred<UploadResult>();
    const readUrl = vi.fn(() => "/api/assets/stale");
    const readAlt = vi.fn(() => "Stale description");
    const result = {} as UploadResult;
    Object.defineProperty(result, "url", { get: readUrl });
    Object.defineProperty(result, "alt", { get: readAlt });
    const first = render(<ImageDialog open onOpenChange={vi.fn()} onSubmit={vi.fn()} onUpload={() => success.promise} />);

    choose(new File(["old"], "old.svg", { type: "image/svg+xml" }));
    first.unmount();
    await act(async () => success.resolve(result));
    expect(readUrl).not.toHaveBeenCalled();
    expect(readAlt).not.toHaveBeenCalled();

    const failure = deferred<UploadResult>();
    const readMessage = vi.fn(() => "Stale failure");
    const error = new Error();
    Object.defineProperty(error, "message", { get: readMessage });
    const second = render(<ImageDialog open onOpenChange={vi.fn()} onSubmit={vi.fn()} onUpload={() => failure.promise} />);

    choose(new File(["old"], "old.svg", { type: "image/svg+xml" }));
    second.unmount();
    await act(async () => failure.reject(error));
    expect(readMessage).not.toHaveBeenCalled();
  });
});

describe("ImageDialog exact Strict Mode ownership", () => {
  it("accepts current URL, Alt, upload, and deferred Insert once after direct-root replay", async () => {
    const upload = deferred<UploadResult>();
    const onUpload = vi.fn(() => upload.promise);
    const onSubmit = vi.fn();
    await renderStrictRoot(
      <Harness onUpload={onUpload} onSubmit={onSubmit} />,
    );

    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/before-upload.png" },
    });
    await act(async () => {});
    fireEvent.change(screen.getByTestId("image-alt"), {
      target: { value: "Before upload" },
    });
    choose(new File(["strict"], "strict.png", { type: "image/png" }));
    expect(onUpload).toHaveBeenCalledOnce();

    await act(async () => {
      upload.resolve({ url: "/api/assets/strict", alt: "Generated" });
      await upload.promise;
    });
    expect(screen.getByTestId("image-url")).toHaveValue("/api/assets/strict");
    expect(screen.getByTestId("image-alt")).toHaveValue("Before upload");

    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: " /api/assets/final " },
    });
    fireEvent.change(screen.getByTestId("image-alt"), {
      target: { value: " Final Alt " },
    });
    const submit = submitEvent();
    act(() => imageForm().dispatchEvent(submit));

    expect(submit.defaultPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith("/api/assets/final", "Final Alt");
  });

  it("retains the open close callback through the closed render and consumes it once", async () => {
    const onSubmit = vi.fn();
    await renderStrictRoot(
      <Harness onUpload={vi.fn()} onSubmit={onSubmit} />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/open-close-token.png" },
    });
    await act(async () => {});
    const openClose = reactAncestorHandlers<() => void>(
      imageForm(),
      "onClosed",
    )[0];
    if (!openClose) throw new Error("Image close callback was not published");

    const submit = submitEvent();
    act(() => imageForm().dispatchEvent(submit));

    expect(submit.defaultPrevented).toBe(true);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith(
      "https://example.com/open-close-token.png",
      "",
    );
    act(() => openClose());
    expect(onSubmit).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Open image dialog" }));
    act(() => openClose());
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("claims a repeated Upload chooser event and its file choice once", async () => {
    const upload = deferred<UploadResult>();
    const onUpload = vi.fn(() => upload.promise);
    await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    const chooser = screen.getByTestId("image-file") as HTMLInputElement;
    const openChooser = vi.spyOn(chooser, "click").mockImplementation(() => {});
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });

    act(() => {
      screen.getByTestId("image-upload").dispatchEvent(click);
      screen.getByTestId("image-upload").dispatchEvent(click);
    });
    expect(openChooser).toHaveBeenCalledOnce();

    choose(new File(["owned"], "owned.webp", { type: "image/webp" }));
    choose(new File(["repeated"], "repeated.webp", { type: "image/webp" }));
    expect(onUpload).toHaveBeenCalledOnce();

    await act(async () => {
      upload.resolve({ url: "/api/assets/owned" });
      await upload.promise;
    });
    expect(screen.getByTestId("image-url")).toHaveValue("/api/assets/owned");
  });

  it("claims an authenticated file change before one mutable selection read", async () => {
    const pending = deferred<UploadResult>();
    let fileAtUpload: File | null = null;
    let readsAtUpload = -1;
    let selectionReads = 0;
    const selected = new File(["selected"], "selected.png", {
      type: "image/png",
    });
    const swapped = new File(["swapped"], "swapped.png", {
      type: "image/png",
    });
    const onUpload = vi.fn((file: File) => {
      fileAtUpload = file;
      readsAtUpload = selectionReads;
      return pending.promise;
    });
    await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    const input = screen.getByTestId("image-file") as HTMLInputElement;
    const handler =
      reactProp<ChangeEventHandler<HTMLInputElement>>(input, "onChange");
    let fabricatedReads = 0;
    handler({
      target: {
        get files() {
          fabricatedReads += 1;
          return [selected];
        },
      },
    } as unknown as ChangeEvent<HTMLInputElement>);
    expect(fabricatedReads).toBe(0);
    expect(onUpload).not.toHaveBeenCalled();

    Object.defineProperty(input, "files", {
      configurable: true,
      get() {
        selectionReads += 1;
        if (selectionReads === 1) {
          input.dispatchEvent(
            new Event("change", { bubbles: true, cancelable: true }),
          );
          return [selected] as unknown as FileList;
        }
        return [swapped] as unknown as FileList;
      },
    });
    act(() => {
      input.dispatchEvent(
        new Event("change", { bubbles: true, cancelable: true }),
      );
    });

    expect(onUpload).toHaveBeenCalledOnce();
    expect(onUpload).toHaveBeenCalledWith(selected);
    expect(fileAtUpload).toBe(selected);
    expect(readsAtUpload).toBe(1);
  });

  it.each(["files", "index", "name"] as const)(
    "retires a claimed file choice when its %s getter throws and recovers freshly",
    async (getter) => {
      const pending = deferred<UploadResult>();
      const onUpload = vi.fn(() => pending.promise);
      const view = await renderStrictRoot(
        <ImageDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      const input = screen.getByTestId("image-file") as HTMLInputElement;
      const selected = new File(["selected"], "selected.png", {
        type: "image/png",
      });

      if (getter === "files") {
        Object.defineProperty(input, "files", {
          configurable: true,
          get() {
            throw new Error("FileList getter failed");
          },
        });
      } else if (getter === "index") {
        const files = new Proxy(
          { length: 1, item: () => selected },
          {
            get(target, property, receiver) {
              if (property === "0") throw new Error("File index getter failed");
              return Reflect.get(target, property, receiver);
            },
          },
        );
        Object.defineProperty(input, "files", {
          configurable: true,
          value: files,
        });
      } else {
        Object.defineProperty(selected, "name", {
          configurable: true,
          get() {
            throw new Error("File name getter failed");
          },
        });
        Object.defineProperty(input, "files", {
          configurable: true,
          value: [selected],
        });
      }
      act(() => {
        input.dispatchEvent(
          new Event("change", { bubbles: true, cancelable: true }),
        );
      });
      expect(onUpload).not.toHaveBeenCalled();

      await act(async () => {});
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [],
      });
      await view.render(
        <ImageDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      const currentInput = screen.getByTestId(
        "image-file",
      ) as HTMLInputElement;
      const recovered = new File(["recovered"], "recovered.png", {
        type: "image/png",
      });
      fireEvent.change(currentInput, { target: { files: [recovered] } });
      expect(onUpload).toHaveBeenCalledOnce();
      expect(onUpload).toHaveBeenCalledWith(recovered);
    },
  );

  it.each(["files", "index", "name"] as const)(
    "rejects a claimed file choice when its %s getter arms dirty final validation and recovers freshly",
    async (getter) => {
      const pending = deferred<UploadResult>();
      const onUpload = vi.fn(() => pending.promise);
      const view = await renderStrictRoot(
        <ImageDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      const input = screen.getByTestId("image-file") as HTMLInputElement;
      const selected = new File(["selected"], "selected.png", {
        type: "image/png",
      });
      const content = dialogContent();
      const dirty = vi.fn(() => {
        const className = content.className;
        content.className = "mutated-during-file-read";
        content.className = className;
      });

      if (getter === "files") {
        Object.defineProperty(input, "files", {
          configurable: true,
          get() {
            armDirtyFileTypeRead(input, dirty);
            return [selected] as unknown as FileList;
          },
        });
      } else if (getter === "index") {
        const files = new Proxy(
          { length: 1, item: () => selected },
          {
            get(target, property, receiver) {
              if (property === "0") {
                armDirtyFileTypeRead(input, dirty);
                return selected;
              }
              return Reflect.get(target, property, receiver);
            },
          },
        );
        Object.defineProperty(input, "files", {
          configurable: true,
          value: files,
        });
      } else {
        Object.defineProperty(selected, "name", {
          configurable: true,
          get() {
            armDirtyFileTypeRead(input, dirty);
            return "selected.png";
          },
        });
        Object.defineProperty(input, "files", {
          configurable: true,
          value: [selected],
        });
      }
      act(() => {
        input.dispatchEvent(
          new Event("change", { bubbles: true, cancelable: true }),
        );
      });
      expect(dirty).toHaveBeenCalled();
      expect(onUpload).not.toHaveBeenCalled();

      Object.defineProperty(input, "files", {
        configurable: true,
        value: [],
      });
      await view.render(
        <ImageDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      const recovered = new File(["recovered"], "recovered.png", {
        type: "image/png",
      });
      fireEvent.change(screen.getByTestId("image-file"), {
        target: { files: [recovered] },
      });
      expect(onUpload).toHaveBeenCalledOnce();
      expect(onUpload).toHaveBeenCalledWith(recovered);
    },
  );

  it.each(["close", "cancel", "escape", "outside"] as const)(
    "claims one current %s dismissal after replay",
    async (kind) => {
      const onOpenChange = vi.fn();
      await renderStrictRoot(
        <ImageDialog
          open
          onOpenChange={onOpenChange}
          onSubmit={vi.fn()}
          onUpload={vi.fn()}
        />,
      );

      if (kind === "close" || kind === "cancel") {
        const button = screen.getByRole("button", {
          name: kind === "close" ? "Close" : "Cancel",
        });
        fireEvent.click(button);
        fireEvent.click(button);
      } else if (kind === "escape") {
        fireEvent.keyDown(dialogContent(), { key: "Escape" });
        fireEvent.keyDown(dialogContent(), { key: "Escape" });
      } else {
        const overlay = document.querySelector(".dialog-overlay");
        if (!(overlay instanceof HTMLDivElement)) {
          throw new Error("Image overlay was not rendered");
        }
        act(() => {
          for (let index = 0; index < 2; index += 1) {
            overlay.dispatchEvent(
              new ControlledPointerEvent("pointerdown", {
                bubbles: true,
                cancelable: true,
                button: 0,
                pointerId: 7,
              }),
            );
            overlay.dispatchEvent(
              new ControlledPointerEvent("click", {
                bubbles: true,
                cancelable: true,
                button: 0,
                pointerId: 7,
              }),
            );
          }
        });
      }

      expect(onOpenChange).toHaveBeenCalledOnce();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    },
  );

  it.each([
    "attributes",
    "style",
    "replacement",
    "reorder",
    "bridge-attributes",
    "bridge-ancestor",
    "portal-ancestor",
  ] as const)(
    "retires restored %s history and accepts a fresh successor",
    async (transition) => {
      const staleClose = vi.fn();
      const currentClose = vi.fn();
      const onUpload = vi.fn();
      const view = await renderStrictRoot(
        <ImageDialog
          open
          onOpenChange={staleClose}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      const content = dialogContent();
      const cancel = screen.getByRole("button", {
        name: "Cancel",
      }) as HTMLButtonElement;

      if (transition === "attributes") {
        const className = content.className;
        content.className = "mutated";
        content.className = className;
      } else if (transition === "style") {
        content.style.display = "none";
        content.style.removeProperty("display");
      } else if (transition === "replacement") {
        const input = screen.getByTestId("image-url");
        const replacement = input.cloneNode(true);
        const parent = input.parentNode;
        if (!parent) throw new Error("Image URL input was not attached");
        parent.replaceChild(replacement, input);
        parent.replaceChild(input, replacement);
      } else if (transition === "reorder") {
        const parent = cancel.parentElement;
        const insert = screen.getByTestId("image-submit");
        if (!parent) throw new Error("Image actions were not attached");
        parent.append(cancel);
        parent.insertBefore(cancel, insert);
      } else if (transition === "bridge-attributes") {
        const bridge = view.host.querySelector(".contents");
        if (!(bridge instanceof HTMLDivElement)) {
          throw new Error("Image bridge was not rendered");
        }
        bridge.className = "mutated";
        bridge.className = "contents";
      } else if (transition === "bridge-ancestor") {
        const next = view.host.nextSibling;
        view.host.remove();
        document.body.insertBefore(view.host, next);
      } else {
        const body = document.body;
        const parent = body.parentNode;
        const next = body.nextSibling;
        if (!parent) throw new Error("Document body was not attached");
        parent.removeChild(body);
        parent.insertBefore(body, next);
      }

      fireEvent.click(cancel);
      expect(staleClose).not.toHaveBeenCalled();

      await view.render(
        <ImageDialog
          open
          onOpenChange={currentClose}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(staleClose).not.toHaveBeenCalled();
      expect(currentClose).toHaveBeenCalledOnce();
    },
  );

  it("retires restored content mutation queued before passive settlement", async () => {
    const staleClose = vi.fn();
    const currentClose = vi.fn();
    const onUpload = vi.fn();
    const NativeObserver = window.MutationObserver;
    let mutationQueued = false;
    class PrePassiveMutationObserver extends NativeObserver {
      override observe(target: Node, options?: MutationObserverInit) {
        super.observe(target, options);
        if (
          !mutationQueued &&
          target instanceof HTMLDivElement &&
          target.classList.contains("dialog")
        ) {
          mutationQueued = true;
          const className = target.className;
          target.className = "mutated-before-passive";
          target.className = className;
        }
      }
    }
    vi.stubGlobal("MutationObserver", PrePassiveMutationObserver);

    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    expect(mutationQueued).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(staleClose).not.toHaveBeenCalled();

    await view.render(
      <ImageDialog
        open
        onOpenChange={currentClose}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(staleClose).not.toHaveBeenCalled();
    expect(currentClose).toHaveBeenCalledOnce();
  });

  it.each(["radix", "controlled"] as const)(
    "retires a restored %s reconciliation shape after settlement",
    async (kind) => {
      const staleClose = vi.fn();
      const currentClose = vi.fn();
      const onUpload = vi.fn();
      const view = await renderStrictRoot(
        <ImageDialog
          open
          onOpenChange={staleClose}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      await act(
        async () =>
          new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
      );

      if (kind === "radix") {
        const content = dialogContent();
        const labelledBy = content.getAttribute("aria-labelledby");
        if (!labelledBy) throw new Error("Image dialog was not labelled");
        content.removeAttribute("aria-labelledby");
        content.setAttribute("aria-labelledby", labelledBy);
      } else {
        const input = screen.getByTestId("image-url");
        input.setAttribute("name", "");
        input.removeAttribute("name");
      }
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(staleClose).not.toHaveBeenCalled();

      await view.render(
        <ImageDialog
          open
          onOpenChange={currentClose}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(staleClose).not.toHaveBeenCalled();
      expect(currentClose).toHaveBeenCalledOnce();
    },
  );

  it("invalidates an Escape proof when another native event intervenes", async () => {
    const onOpenChange = vi.fn();
    const listeners: Array<{
      type: string;
      listener: EventListenerOrEventListenerObject;
    }> = [];
    const nativeAdd = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation(
      (type, listener, options) => {
        listeners.push({ type, listener });
        nativeAdd(type, listener, options);
      },
    );
    await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={onOpenChange}
        onSubmit={vi.fn()}
        onUpload={vi.fn()}
      />,
    );
    const content = dialogContent();
    const componentListener = listeners.find(
      (record) =>
        record.type === "keydown" &&
        listeners.some(
          (candidate) =>
            candidate.type === "pointerdown" &&
            candidate.listener === record.listener,
        ) &&
        listeners.some(
          (candidate) =>
            candidate.type === "click" &&
            candidate.listener === record.listener,
        ),
    )?.listener;
    if (!componentListener) {
      throw new Error("Image dismissal listener was not registered");
    }
    const invoke = (key: string) => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
      });
      Object.defineProperties(event, {
        target: { configurable: true, value: content },
        eventPhase: {
          configurable: true,
          value: Event.CAPTURING_PHASE,
        },
        composedPath: {
          configurable: true,
          value: () => [
            content,
            document.body,
            document.documentElement,
            document,
            window,
          ],
        },
      });
      if (typeof componentListener === "function") {
        componentListener.call(document, event);
      } else {
        componentListener.handleEvent(event);
      }
    };
    invoke("Escape");
    invoke("Enter");
    const radixOpenChange = reactAncestorHandlers<
      (open: boolean) => void
    >(content, "onOpenChange").find(
      (handler) => handler !== onOpenChange,
    );
    if (!radixOpenChange) {
      throw new Error("Radix open-change handler was not published");
    }

    act(() => radixOpenChange(false));
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.keyDown(content, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps Escape ahead of Radix after a draft successor publishes", async () => {
    const onOpenChange = vi.fn();
    await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={onOpenChange}
        onSubmit={vi.fn()}
        onUpload={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/escape.png" },
    });
    await act(async () => {});

    fireEvent.keyDown(dialogContent(), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the committed authority live when a callback replacement suspends", async () => {
    const committedClose = vi.fn();
    const pendingClose = vi.fn();
    const onSubmit = vi.fn();
    const upload = deferred<UploadResult>();
    const onUpload = vi.fn(() => upload.promise);
    const never = new Promise<never>(() => {});
    const pendingRender = vi.fn();
    const pendingCommit = vi.fn();
    let begin = () => {};

    function PendingCommitProbe() {
      useLayoutEffect(() => {
        pendingCommit();
      }, []);
      return null;
    }

    function PendingRender(): ReactNode {
      pendingRender();
      throw never;
    }

    function ConcurrentHarness() {
      const [pending, setPending] = useState(false);
      useLayoutEffect(() => {
        begin = () => {
          startTransition(() => setPending(true));
        };
      }, []);
      return (
        <Suspense fallback={null}>
          <ImageDialog
            open
            onOpenChange={pending ? pendingClose : committedClose}
            onSubmit={onSubmit}
            onUpload={onUpload}
          />
          {pending && (
            <>
              <PendingCommitProbe />
              <PendingRender />
            </>
          )}
        </Suspense>
      );
    }

    await renderStrictRoot(<ConcurrentHarness />);
    choose(new File(["current"], "current.png", { type: "image/png" }));
    expect(onUpload).toHaveBeenCalledOnce();
    const committedCancel = screen.getByRole("button", {
      name: "Cancel",
    }) as HTMLButtonElement;
    await act(async () => begin());
    expect(pendingRender).toHaveBeenCalled();
    expect(pendingCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBe(
      committedCancel,
    );
    await act(async () => {
      upload.resolve({ url: "/api/assets/concurrent", alt: "Concurrent Alt" });
      await upload.promise;
    });
    await waitFor(() => {
      expect(screen.getByTestId("image-url")).toHaveValue(
        "/api/assets/concurrent",
      );
      expect(screen.getByTestId("image-alt")).toHaveValue("Concurrent Alt");
    });
    expect(pendingRender).toHaveBeenCalled();
    expect(pendingCommit).not.toHaveBeenCalled();
    const currentCancel = screen.getByRole("button", {
      name: "Cancel",
    }) as HTMLButtonElement;
    expect(currentCancel).toBe(committedCancel);
    expect(currentCancel).toBeEnabled();
    fireEvent.click(currentCancel);

    expect(committedClose).toHaveBeenCalledOnce();
    expect(committedClose).toHaveBeenCalledWith(false);
    expect(pendingClose).not.toHaveBeenCalled();
    expect(pendingCommit).not.toHaveBeenCalled();
  });

  it("rejects stale, crossed, and fabricated changes without poisoning current controls", async () => {
    const onOpenChangeA = vi.fn();
    const onOpenChangeB = vi.fn();
    const onSubmit = vi.fn();
    const onUpload = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={onOpenChangeA}
        onSubmit={onSubmit}
        onUpload={onUpload}
      />,
    );
    const staleUrl = screen.getByTestId("image-url");
    const staleChange =
      reactProp<ChangeEventHandler<HTMLInputElement>>(staleUrl, "onChange");

    await view.render(
      <ImageDialog
        open
        onOpenChange={onOpenChangeB}
        onSubmit={onSubmit}
        onUpload={onUpload}
      />,
    );
    const url = screen.getByTestId("image-url") as HTMLInputElement;
    const alt = screen.getByTestId("image-alt") as HTMLInputElement;
    const currentUrl =
      reactProp<ChangeEventHandler<HTMLInputElement>>(url, "onChange");
    const currentAlt =
      reactProp<ChangeEventHandler<HTMLInputElement>>(alt, "onChange");

    staleChange({
      currentTarget: url,
      target: url,
      nativeEvent: new Event("change", {
        bubbles: true,
        cancelable: true,
      }),
    } as ChangeEvent<HTMLInputElement>);
    url.value = "";
    currentAlt({
      currentTarget: url,
      target: url,
      nativeEvent: new Event("change", {
        bubbles: true,
        cancelable: true,
      }),
    } as ChangeEvent<HTMLInputElement>);
    currentUrl({
      currentTarget: url,
      target: url,
      nativeEvent: new Event("change", {
        bubbles: true,
        cancelable: true,
      }),
    } as ChangeEvent<HTMLInputElement>);

    setReactProp(url, "onChange", currentUrl);
    fireEvent.change(url, {
      target: { value: "https://example.com/current.png" },
    });
    await act(async () => {});
    fireEvent.change(alt, { target: { value: "Current Alt" } });

    expect(url).toHaveValue("https://example.com/current.png");
    expect(alt).toHaveValue("Current Alt");
    expect(onOpenChangeA).not.toHaveBeenCalled();
    expect(onOpenChangeB).not.toHaveBeenCalled();
  });

  it("prevents an invalidated genuine submit and leaves foreign provenance untouched", async () => {
    const staleSubmit = vi.fn();
    const currentSubmit = vi.fn();
    const onUpload = vi.fn();
    const view = await renderStrictRoot(
      <Harness onSubmit={staleSubmit} onUpload={onUpload} />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/stale.png" },
    });
    await act(async () => {});
    const content = dialogContent();
    content.setAttribute("data-intervening", "true");
    content.removeAttribute("data-intervening");
    const invalidated = submitEvent();
    act(() => imageForm().dispatchEvent(invalidated));

    expect(invalidated.defaultPrevented).toBe(true);
    expect(staleSubmit).not.toHaveBeenCalled();

    await view.render(
      <Harness onSubmit={currentSubmit} onUpload={onUpload} />,
    );
    const form = imageForm();
    const handler = reactProp<FormEventHandler<HTMLFormElement>>(
      form,
      "onSubmit",
    );
    const preventDefault = vi.fn();
    handler({
      currentTarget: form,
      target: form,
      nativeEvent: new Event("submit", {
        bubbles: true,
        cancelable: true,
      }),
      preventDefault,
    } as unknown as FormEvent<HTMLFormElement>);
    expect(preventDefault).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/current.png" },
    });
    await act(async () => {});
    const current = submitEvent();
    act(() => imageForm().dispatchEvent(current));
    expect(current.defaultPrevented).toBe(true);
    await waitFor(() => expect(currentSubmit).toHaveBeenCalledOnce());
    expect(staleSubmit).not.toHaveBeenCalled();
  });

  it("keeps late result getters and file clearing out of an equal-looking reopened visit", async () => {
    const stale = deferred<UploadResult>();
    const current = deferred<UploadResult>();
    const onUpload = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    await renderStrictRoot(<Harness onUpload={onUpload} />);

    choose(new File(["stale"], "stale.png", { type: "image/png" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Open image dialog" }));
    choose(new File(["current"], "current.png", { type: "image/png" }));
    const input = screen.getByTestId("image-file") as HTMLInputElement;
    setInputValue(input, "current-selection");
    const readUrl = vi.fn(() => "/api/assets/stale");
    const readAlt = vi.fn(() => "Stale Alt");
    const staleResult = {} as UploadResult;
    Object.defineProperties(staleResult, {
      url: { get: readUrl },
      alt: { get: readAlt },
    });

    await act(async () => {
      stale.resolve(staleResult);
      await stale.promise;
    });
    expect(readUrl).not.toHaveBeenCalled();
    expect(readAlt).not.toHaveBeenCalled();
    expect(input.value).toBe("current-selection");
    expect(screen.getByTestId("image-upload")).toBeDisabled();

    await act(async () => {
      current.resolve({ url: "/api/assets/current", alt: "Current Alt" });
      await current.promise;
    });
    expect(screen.getByTestId("image-url")).toHaveValue("/api/assets/current");
    expect(input.value).toBe("");
  });

  it("keeps a late error getter and finalizer out of the reopened pending upload", async () => {
    const stale = deferred<UploadResult>();
    const current = deferred<UploadResult>();
    const onUpload = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    await renderStrictRoot(<Harness onUpload={onUpload} />);

    choose(new File(["stale"], "stale.gif", { type: "image/gif" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Open image dialog" }));
    fireEvent.change(screen.getByTestId("image-alt"), {
      target: { value: "Current GIF" },
    });
    choose(new File(["current"], "current.gif", { type: "image/gif" }));
    const input = screen.getByTestId("image-file") as HTMLInputElement;
    setInputValue(input, "current-selection");
    const readMessage = vi.fn(() => "Stale failure");
    const error = new Error();
    Object.defineProperty(error, "message", { get: readMessage });

    await act(async () => {
      stale.reject(error);
      await stale.promise.catch(() => undefined);
    });
    expect(readMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("image-alt")).toHaveValue("Current GIF");
    expect(screen.getByTestId("image-upload")).toBeDisabled();
    expect(input.value).toBe("current-selection");

    await act(async () => {
      current.resolve({ url: "/api/assets/current-gif" });
      await current.promise;
    });
    expect(screen.getByTestId("image-url")).toHaveValue(
      "/api/assets/current-gif",
    );
    expect(screen.getByTestId("image-alt")).toHaveValue("Current GIF");
    expect(input.value).toBe("");
  });

  it("rejects a retired partial action and keeps fresh authority usable", async () => {
    const onOpenChange = vi.fn();
    const onUpload = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={onOpenChange}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    const input = screen.getByTestId("image-url") as HTMLInputElement;
    const staleChange =
      reactProp<ChangeEventHandler<HTMLInputElement>>(input, "onChange");
    const ref = reactProp<RefCallback<HTMLInputElement>>(input, "ref");

    act(() => {
      ref(null);
      ref(input);
    });
    staleChange({
      currentTarget: input,
      target: input,
      nativeEvent: new Event("change", {
        bubbles: true,
        cancelable: true,
      }),
    } as ChangeEvent<HTMLInputElement>);
    await view.render(
      <ImageDialog
        open
        onOpenChange={onOpenChange}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    fireEvent.change(input, {
      target: { value: "https://example.com/recovered.png" },
    });
    expect(input).toHaveValue("https://example.com/recovered.png");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("does not recover a partial replay after an unexpected ref replay", async () => {
    const staleClose = vi.fn();
    const currentClose = vi.fn();
    const onUpload = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    const input = screen.getByTestId("image-url") as HTMLInputElement;
    const inputRef = reactProp<RefCallback<HTMLInputElement>>(input, "ref");
    const alt = screen.getByTestId("image-alt") as HTMLInputElement;
    const altRef = reactProp<RefCallback<HTMLInputElement>>(alt, "ref");
    const foreign = document.createElement("input");
    document.body.append(foreign);

    inputRef(null);
    inputRef(input);
    await Promise.resolve();
    act(() => {
      altRef(null);
      altRef(foreign);
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(staleClose).not.toHaveBeenCalled();

    try {
      await view.render(
        <ImageDialog
          open
          onOpenChange={currentClose}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(staleClose).not.toHaveBeenCalled();
      expect(currentClose).toHaveBeenCalledOnce();
    } finally {
      foreign.remove();
    }
  });

  it("keeps staged partial replay mutation history live until publication", async () => {
    const staleClose = vi.fn();
    const currentClose = vi.fn();
    const onUpload = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    const input = screen.getByTestId("image-url") as HTMLInputElement;
    const inputRef = reactProp<RefCallback<HTMLInputElement>>(input, "ref");

    inputRef(null);
    inputRef(input);
    await Promise.resolve();
    const content = dialogContent();
    const className = content.className;
    content.className = "mutated-after-partial-stage";
    content.className = className;
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(staleClose).not.toHaveBeenCalled();

    await view.render(
      <ImageDialog
        open
        onOpenChange={currentClose}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(staleClose).not.toHaveBeenCalled();
    expect(currentClose).toHaveBeenCalledOnce();
  });

  it("rejects the source authority when dirty history aborts partial recovery", async () => {
    const staleClose = vi.fn();
    const currentClose = vi.fn();
    const onSubmit = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/quarantined.png" },
    });
    await act(async () => {});
    const input = screen.getByTestId("image-url") as HTMLInputElement;
    const inputRef = reactProp<RefCallback<HTMLInputElement>>(input, "ref");
    const originalCancel = screen.getByRole("button", { name: "Cancel" });

    inputRef(null);
    inputRef(input);
    const content = dialogContent();
    const className = content.className;
    content.className = "mutated-before-partial-recovery";
    content.className = className;
    await act(async () => {});

    const form = imageForm();
    const poison = vi.fn((event: Event) => {
      Object.defineProperties(event, {
        bubbles: { configurable: true, value: false },
        cancelable: { configurable: true, value: false },
        composedPath: {
          configurable: true,
          value: () => {
            throw new Error("Shadowed composedPath must not run");
          },
        },
        defaultPrevented: { configurable: true, value: true },
        eventPhase: { configurable: true, value: Event.NONE },
        preventDefault: {
          configurable: true,
          value: () => {
            throw new Error("Shadowed preventDefault must not run");
          },
        },
        submitter: {
          configurable: true,
          get: () => {
            throw new Error("Shadowed submitter must not run");
          },
        },
        target: {
          configurable: true,
          get: () => {
            throw new Error("Shadowed target must not run");
          },
        },
        type: { configurable: true, value: "click" },
      });
    });
    form.addEventListener("submit", poison, { capture: true, once: true });
    const submit = submitEvent();
    let dispatched = true;
    act(() => {
      dispatched = form.dispatchEvent(submit);
    });
    expect(poison).toHaveBeenCalledOnce();
    expect(dispatched).toBe(false);
    Reflect.deleteProperty(submit, "defaultPrevented");
    expect(submit.defaultPrevented).toBe(true);
    fireEvent.click(originalCancel);
    expect(staleClose).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    function RecoveryDialog() {
      const [open, setOpen] = useState(true);
      const close = useCallback((nextOpen: boolean) => {
        currentClose(nextOpen);
        setOpen(nextOpen);
      }, []);
      return (
        <ImageDialog
          open={open}
          onOpenChange={close}
          onSubmit={onSubmit}
        />
      );
    }
    await view.render(<RecoveryDialog />);
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/recovered.png" },
    });
    await act(async () => {});
    const recovered = submitEvent();
    act(() => imageForm().dispatchEvent(recovered));
    expect(recovered.defaultPrevented).toBe(true);
    expect(staleClose).not.toHaveBeenCalled();
    expect(currentClose).toHaveBeenCalledOnce();
    expect(currentClose).toHaveBeenCalledWith(false);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith(
      "https://example.com/recovered.png",
      "",
    );
  });

  it("stops inherited submit poison before React bubble extraction", async () => {
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn();
    function ControlledDialog() {
      const [open, setOpen] = useState(true);
      const close = useCallback((nextOpen: boolean) => {
        onOpenChange(nextOpen);
        setOpen(nextOpen);
      }, []);
      return (
        <ImageDialog
          open={open}
          onOpenChange={close}
          onSubmit={onSubmit}
        />
      );
    }
    await renderStrictRoot(<ControlledDialog />);
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/canonical.png" },
    });
    await act(async () => {});
    const form = imageForm();
    const poison = vi.fn((event: Event) => {
      const poisonedPrototype = Object.create(Object.getPrototypeOf(event), {
        composedPath: {
          configurable: true,
          get: () => {
            throw new Error("Inherited composedPath must not run");
          },
        },
        submitter: {
          configurable: true,
          get: () => {
            throw new Error("Inherited submitter must not run");
          },
        },
        target: {
          configurable: true,
          get: () => {
            throw new Error("Inherited target must not run");
          },
        },
        type: {
          configurable: true,
          get: () => {
            throw new Error("Inherited type must not run");
          },
        },
      });
      Object.setPrototypeOf(event, poisonedPrototype);
    });
    const uncaught = vi.fn((event: ErrorEvent) => event.preventDefault());
    form.addEventListener("submit", poison, { capture: true, once: true });
    window.addEventListener("error", uncaught);
    const poisoned = submitEvent();
    let dispatched = true;
    try {
      act(() => {
        dispatched = form.dispatchEvent(poisoned);
      });
    } finally {
      window.removeEventListener("error", uncaught);
    }

    expect(poison).toHaveBeenCalledOnce();
    expect(dispatched).toBe(false);
    expect(poisoned.defaultPrevented).toBe(true);
    expect(uncaught).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    const clean = submitEvent();
    act(() => {
      dispatched = form.dispatchEvent(clean);
    });
    expect(dispatched).toBe(false);
    expect(clean.defaultPrevented).toBe(true);
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith(
      "https://example.com/canonical.png",
      "",
    );
  });

  it("delivers before a later form bubble listener can poison submit", async () => {
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn();
    function ControlledDialog() {
      const [open, setOpen] = useState(true);
      const close = useCallback((nextOpen: boolean) => {
        onOpenChange(nextOpen);
        setOpen(nextOpen);
      }, []);
      return (
        <ImageDialog
          open={open}
          onOpenChange={close}
          onSubmit={onSubmit}
        />
      );
    }
    await renderStrictRoot(<ControlledDialog />);
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/terminal.png" },
    });
    await act(async () => {});
    const form = imageForm();
    const latePoison = vi.fn((event: Event) => {
      Object.setPrototypeOf(
        event,
        Object.create(Object.getPrototypeOf(event), {
          target: {
            configurable: true,
            get: () => {
              throw new Error("Late inherited target must not run");
            },
          },
        }),
      );
    });
    const uncaught = vi.fn((event: ErrorEvent) => event.preventDefault());
    form.addEventListener("submit", latePoison);
    window.addEventListener("error", uncaught);
    const submit = submitEvent();
    let dispatched = true;
    try {
      act(() => {
        dispatched = form.dispatchEvent(submit);
      });
    } finally {
      window.removeEventListener("error", uncaught);
    }

    expect(dispatched).toBe(false);
    expect(submit.defaultPrevented).toBe(true);
    expect(latePoison).not.toHaveBeenCalled();
    expect(uncaught).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith(
      "https://example.com/terminal.png",
      "",
    );
  });

  it("rejects submit poisoned and stopped before the terminal guard", async () => {
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn();
    const earlyPoison = vi.fn((event: Event) => {
      event.stopPropagation();
      Object.setPrototypeOf(
        event,
        Object.create(Object.getPrototypeOf(event), {
          composedPath: {
            configurable: true,
            get: () => {
              throw new Error("Early inherited composedPath must not run");
            },
          },
          submitter: {
            configurable: true,
            get: () => {
              throw new Error("Early inherited submitter must not run");
            },
          },
          target: {
            configurable: true,
            get: () => {
              throw new Error("Early inherited target must not run");
            },
          },
          type: {
            configurable: true,
            get: () => {
              throw new Error("Early inherited type must not run");
            },
          },
        }),
      );
    });
    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    const formAddEventListener = Object.getOwnPropertyDescriptor(
      HTMLFormElement.prototype,
      "addEventListener",
    );
    let installed = false;
    Object.defineProperty(HTMLFormElement.prototype, "addEventListener", {
      configurable: true,
      value: function (
        this: HTMLFormElement,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (type === "submit" && !installed) {
          installed = true;
          nativeAddEventListener.call(this, type, earlyPoison, { once: true });
        }
        nativeAddEventListener.call(this, type, listener, options);
      },
    });
    try {
      await renderStrictRoot(
        <ImageDialog
          open
          onOpenChange={onOpenChange}
          onSubmit={onSubmit}
        />,
      );
    } finally {
      if (formAddEventListener) {
        Object.defineProperty(
          HTMLFormElement.prototype,
          "addEventListener",
          formAddEventListener,
        );
      } else {
        Reflect.deleteProperty(
          HTMLFormElement.prototype,
          "addEventListener",
        );
      }
    }
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/rejected.png" },
    });
    await act(async () => {});
    const form = imageForm();
    const uncaught = vi.fn((event: ErrorEvent) => event.preventDefault());
    window.addEventListener("error", uncaught);
    const poisoned = submitEvent();
    let dispatched = true;
    try {
      act(() => {
        dispatched = form.dispatchEvent(poisoned);
      });
    } finally {
      window.removeEventListener("error", uncaught);
    }

    expect(earlyPoison).toHaveBeenCalledOnce();
    expect(dispatched).toBe(false);
    expect(poisoned.defaultPrevented).toBe(true);
    expect(uncaught).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("suppresses requestSubmit after Insert is rehomed and recovers freshly", async () => {
    const staleClose = vi.fn();
    const staleSubmit = vi.fn();
    const currentClose = vi.fn();
    const currentSubmit = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={staleSubmit}
      />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/rehomed.png" },
    });
    await act(async () => {});
    const form = imageForm();
    const insert = screen.getByTestId("image-submit");
    const parent = insert.parentNode;
    const next = insert.nextSibling;
    if (!parent) throw new Error("Insert parent was not rendered");
    let nativeSubmit: Event | null = null;
    const observeSubmit = (event: Event) => {
      nativeSubmit = event;
    };
    const later = vi.fn();
    form.addEventListener("submit", observeSubmit, {
      capture: true,
      once: true,
    });
    form.addEventListener("submit", later, { once: true });
    document.body.append(insert);
    try {
      act(() => form.requestSubmit());
    } finally {
      parent.insertBefore(insert, next);
    }

    expect(nativeSubmit).not.toBeNull();
    expect((nativeSubmit as Event | null)?.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();

    await submitCleanSuccess(
      view,
      currentClose,
      currentSubmit,
      "https://example.com/rehomed-recovery.png",
    );
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();
  });

  it("suppresses requestSubmit after the owned form leaves its content", async () => {
    const staleClose = vi.fn();
    const staleSubmit = vi.fn();
    const currentClose = vi.fn();
    const currentSubmit = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={staleSubmit}
      />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/rehomed-form.png" },
    });
    await act(async () => {});
    const form = imageForm();
    const parent = form.parentNode;
    const next = form.nextSibling;
    if (!parent) throw new Error("Form parent was not rendered");
    let nativeSubmit: Event | null = null;
    const observeSubmit = (event: Event) => {
      nativeSubmit = event;
    };
    const later = vi.fn();
    form.addEventListener("submit", observeSubmit, {
      capture: true,
      once: true,
    });
    form.addEventListener("submit", later, { once: true });
    document.body.append(form);
    try {
      act(() => form.requestSubmit());
    } finally {
      parent.insertBefore(form, next);
    }

    expect(nativeSubmit).not.toBeNull();
    expect((nativeSubmit as Event | null)?.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();

    await submitCleanSuccess(
      view,
      currentClose,
      currentSubmit,
      "https://example.com/rehomed-form-recovery.png",
    );
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();
  });

  it("natively suppresses an owned form outside React delegation", async () => {
    const staleClose = vi.fn();
    const staleSubmit = vi.fn();
    const rejectedClose = vi.fn();
    const rejectedSubmit = vi.fn();
    const currentClose = vi.fn();
    const currentSubmit = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={staleSubmit}
      />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/proofless-form.png" },
    });
    await act(async () => {});
    const form = imageForm();
    const parent = form.parentNode;
    const next = form.nextSibling;
    if (!parent) throw new Error("Form parent was not rendered");
    const later = vi.fn();
    form.addEventListener("submit", later, { once: true });
    document.documentElement.append(form);
    const submit = submitEvent();
    const afterRender = submitEvent();
    let dispatched = true;
    let dispatchedAfterRender = true;
    try {
      act(() => {
        dispatched = form.dispatchEvent(submit);
      });
      await view.render(
        <ImageDialog
          open
          onOpenChange={rejectedClose}
          onSubmit={rejectedSubmit}
        />,
      );
      act(() => {
        dispatchedAfterRender = form.dispatchEvent(afterRender);
      });
    } finally {
      parent.insertBefore(form, next);
    }

    expect(dispatched).toBe(false);
    expect(submit.defaultPrevented).toBe(true);
    expect(dispatchedAfterRender).toBe(false);
    expect(afterRender.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();
    expect(rejectedClose).not.toHaveBeenCalled();
    expect(rejectedSubmit).not.toHaveBeenCalled();

    await submitCleanSuccess(
      view,
      currentClose,
      currentSubmit,
      "https://example.com/proofless-form-recovery.png",
    );
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();
    expect(rejectedClose).not.toHaveBeenCalled();
    expect(rejectedSubmit).not.toHaveBeenCalled();
  });

  it("natively suppresses an owned form adopted by another document", async () => {
    const staleClose = vi.fn();
    const staleSubmit = vi.fn();
    const rejectedClose = vi.fn();
    const rejectedSubmit = vi.fn();
    const currentClose = vi.fn();
    const currentSubmit = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={staleSubmit}
      />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/adopted-form.png" },
    });
    await act(async () => {});
    const form = imageForm();
    const parent = form.parentNode;
    const next = form.nextSibling;
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignBody = frame.contentDocument?.body;
    if (!parent || !foreignBody) {
      throw new Error("Cross-document form target was unavailable");
    }
    const later = vi.fn();
    form.addEventListener("submit", later, { once: true });
    foreignBody.append(form);
    const submit = submitEvent();
    const afterRender = submitEvent();
    let dispatched = true;
    let dispatchedAfterRender = true;
    try {
      act(() => {
        dispatched = form.dispatchEvent(submit);
      });
      await view.render(
        <ImageDialog
          open
          onOpenChange={rejectedClose}
          onSubmit={rejectedSubmit}
        />,
      );
      act(() => {
        dispatchedAfterRender = form.dispatchEvent(afterRender);
      });
    } finally {
      parent.insertBefore(form, next);
      frame.remove();
    }

    expect(dispatched).toBe(false);
    expect(submit.defaultPrevented).toBe(true);
    expect(dispatchedAfterRender).toBe(false);
    expect(afterRender.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();
    expect(rejectedClose).not.toHaveBeenCalled();
    expect(rejectedSubmit).not.toHaveBeenCalled();

    await submitCleanSuccess(
      view,
      currentClose,
      currentSubmit,
      "https://example.com/adopted-form-recovery.png",
    );
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();
    expect(rejectedClose).not.toHaveBeenCalled();
    expect(rejectedSubmit).not.toHaveBeenCalled();
  });

  it("terminally stops a submit canceled at document capture without applying it", async () => {
    const staleClose = vi.fn();
    const staleSubmit = vi.fn();
    const currentClose = vi.fn();
    const currentSubmit = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={staleSubmit}
      />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/pre-canceled.png" },
    });
    await act(async () => {});
    const form = imageForm();
    const preCancel = vi.fn((event: Event) => event.preventDefault());
    const later = vi.fn();
    document.addEventListener("submit", preCancel, {
      capture: true,
      once: true,
    });
    form.addEventListener("submit", later, { once: true });
    const submit = submitEvent();
    let dispatched = true;
    try {
      act(() => {
        dispatched = form.dispatchEvent(submit);
      });
    } finally {
      document.removeEventListener("submit", preCancel, true);
    }

    expect(preCancel).toHaveBeenCalledOnce();
    expect(dispatched).toBe(false);
    expect(submit.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();

    await submitCleanSuccess(
      view,
      currentClose,
      currentSubmit,
      "https://example.com/pre-canceled-recovery.png",
    );
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();
  });

  it.each(["public", "captured intrinsic"] as const)(
    "rejects a %s form-capture cancellation after root staging",
    async (kind) => {
      const staleClose = vi.fn();
      const staleSubmit = vi.fn();
      const currentClose = vi.fn();
      const currentSubmit = vi.fn();
      const view = await renderStrictRoot(
        <ImageDialog
          open
          onOpenChange={staleClose}
          onSubmit={staleSubmit}
        />,
      );
      fireEvent.change(screen.getByTestId("image-url"), {
        target: { value: "https://example.com/form-veto.png" },
      });
      await act(async () => {});
      const form = imageForm();
      const veto = vi.fn((event: Event) => {
        if (kind === "public") event.preventDefault();
        else Reflect.apply(PRE_RENDER_EVENT_PREVENT_DEFAULT, event, []);
      });
      const later = vi.fn();
      form.addEventListener("submit", veto, { capture: true, once: true });
      form.addEventListener("submit", later, { once: true });
      const submit = submitEvent();
      let dispatched = true;
      act(() => {
        dispatched = form.dispatchEvent(submit);
      });

      expect(veto).toHaveBeenCalledOnce();
      expect(dispatched).toBe(false);
      expect(submit.defaultPrevented).toBe(true);
      expect(later).not.toHaveBeenCalled();
      expect(staleClose).not.toHaveBeenCalled();
      expect(staleSubmit).not.toHaveBeenCalled();

      await submitCleanSuccess(
        view,
        currentClose,
        currentSubmit,
        `https://example.com/${kind.replace(" ", "-")}-recovery.png`,
      );
      expect(staleClose).not.toHaveBeenCalled();
      expect(staleSubmit).not.toHaveBeenCalled();
    },
  );

  it("rejects form-capture propagation stop without losing cancellation", async () => {
    const staleClose = vi.fn();
    const staleSubmit = vi.fn();
    const currentClose = vi.fn();
    const currentSubmit = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={staleSubmit}
      />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/form-stop.png" },
    });
    await act(async () => {});
    const form = imageForm();
    const stop = vi.fn((event: Event) => event.stopPropagation());
    const later = vi.fn();
    form.addEventListener("submit", stop, { capture: true, once: true });
    form.addEventListener("submit", later, { once: true });
    const submit = submitEvent();
    let dispatched = true;
    act(() => {
      dispatched = form.dispatchEvent(submit);
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(dispatched).toBe(false);
    expect(submit.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();

    await submitCleanSuccess(
      view,
      currentClose,
      currentSubmit,
      "https://example.com/form-stop-recovery.png",
    );
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();
  });

  it("cancels before form-capture immediate propagation stop", async () => {
    const staleClose = vi.fn();
    const staleSubmit = vi.fn();
    const currentClose = vi.fn();
    const currentSubmit = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={staleSubmit}
      />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/form-immediate-stop.png" },
    });
    await act(async () => {});
    const form = imageForm();
    const intrinsicStopImmediate = Object.getOwnPropertyDescriptor(
      Event.prototype,
      "stopImmediatePropagation",
    )?.value;
    if (typeof intrinsicStopImmediate !== "function") {
      throw new Error(
        "Event.stopImmediatePropagation intrinsic is unavailable",
      );
    }
    const stop = vi.fn((event: Event) => {
      Reflect.apply(intrinsicStopImmediate, event, []);
    });
    const later = vi.fn();
    form.addEventListener("submit", stop, { capture: true, once: true });
    form.addEventListener("submit", later, { once: true });
    const submit = submitEvent();
    let dispatched = true;
    act(() => {
      dispatched = form.dispatchEvent(submit);
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(dispatched).toBe(false);
    expect(submit.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();

    await submitCleanSuccess(
      view,
      currentClose,
      currentSubmit,
      "https://example.com/form-immediate-stop-recovery.png",
    );
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();
  });

  it("keeps an outer finalizer through a nested canceled submit", async () => {
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn();
    function ControlledDialog() {
      const [open, setOpen] = useState(true);
      const close = useCallback((nextOpen: boolean) => {
        onOpenChange(nextOpen);
        setOpen(nextOpen);
      }, []);
      return (
        <ImageDialog
          open={open}
          onOpenChange={close}
          onSubmit={onSubmit}
        />
      );
    }
    await renderStrictRoot(<ControlledDialog />);
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/outer-submit.png" },
    });
    await act(async () => {});
    const form = imageForm();
    const nested = submitEvent();
    nested.preventDefault();
    const dispatchNested = vi.fn(() => {
      form.dispatchEvent(nested);
    });
    form.addEventListener("submit", dispatchNested, {
      capture: true,
      once: true,
    });
    const outer = submitEvent();
    let dispatched = true;
    act(() => {
      dispatched = form.dispatchEvent(outer);
    });

    expect(dispatchNested).toHaveBeenCalledOnce();
    expect(nested.defaultPrevented).toBe(true);
    expect(dispatched).toBe(false);
    expect(outer.defaultPrevented).toBe(true);
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith(
      "https://example.com/outer-submit.png",
      "",
    );
  });

  it.each([
    ["parentElement", "throwing"],
    ["parentElement", "deceptive"],
    ["ownerDocument", "throwing"],
    ["ownerDocument", "deceptive"],
    ["isConnected", "throwing"],
    ["isConnected", "deceptive"],
    ["contains", "throwing"],
    ["contains", "deceptive"],
  ] as const)(
    "does not invoke a %s own %s relation while establishing provenance",
    async (relation, kind) => {
      const staleClose = vi.fn();
      const staleSubmit = vi.fn();
      const rejectedClose = vi.fn();
      const rejectedSubmit = vi.fn();
      const currentClose = vi.fn();
      const currentSubmit = vi.fn();
      const view = await renderStrictRoot(
        <ImageDialog
          open
          onOpenChange={staleClose}
          onSubmit={staleSubmit}
        />,
      );
      fireEvent.change(screen.getByTestId("image-url"), {
        target: { value: "https://example.com/instrumented-provenance.png" },
      });
      await act(async () => {});
      const form = imageForm();
      const cancel = screen.getByRole("button", { name: "Cancel" });
      const deceptiveValue =
        relation === "parentElement"
          ? form.parentElement
          : relation === "ownerDocument"
            ? document
            : relation === "isConnected"
              ? true
              : Node.prototype.contains;
      const readRelation = vi.fn(() => {
        if (kind === "throwing") {
          throw new Error(`Instrumented ${relation} must not run`);
        }
        return deceptiveValue;
      });
      Object.defineProperty(form, relation, {
        configurable: true,
        get: readRelation,
      });
      let submit: Event | null = null;
      let dispatched = true;
      const later = vi.fn();
      try {
        await view.render(
          <ImageDialog
            open
            onOpenChange={rejectedClose}
            onSubmit={rejectedSubmit}
          />,
        );
        form.addEventListener("submit", later, { once: true });
        const stagedSubmit = submitEvent();
        submit = stagedSubmit;
        act(() => {
          dispatched = form.dispatchEvent(stagedSubmit);
        });
        fireEvent.click(cancel);
      } finally {
        Reflect.deleteProperty(form, relation);
      }

      expect(readRelation).not.toHaveBeenCalled();
      expect(dispatched).toBe(false);
      expect(submit?.defaultPrevented).toBe(true);
      expect(later).not.toHaveBeenCalled();
      expect(staleClose).not.toHaveBeenCalled();
      expect(staleSubmit).not.toHaveBeenCalled();
      expect(rejectedClose).not.toHaveBeenCalled();
      expect(rejectedSubmit).not.toHaveBeenCalled();

      await submitCleanSuccess(
        view,
        currentClose,
        currentSubmit,
        `https://example.com/${relation}-${kind}-recovery.png`,
      );
      expect(staleClose).not.toHaveBeenCalled();
      expect(staleSubmit).not.toHaveBeenCalled();
      expect(rejectedClose).not.toHaveBeenCalled();
      expect(rejectedSubmit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ownerDocument", "throwing"],
    ["ownerDocument", "deceptive"],
    ["contains", "throwing"],
    ["contains", "deceptive"],
  ] as const)(
    "does not invoke a %s derived %s relation while replaying the shared journal",
    async (relation, kind) => {
      const staleClose = vi.fn();
      const staleSubmit = vi.fn();
      const rejectedClose = vi.fn();
      const rejectedSubmit = vi.fn();
      const currentClose = vi.fn();
      const currentSubmit = vi.fn();
      const view = await renderStrictRoot(
        <ImageDialog
          open
          onOpenChange={staleClose}
          onSubmit={staleSubmit}
        />,
      );
      fireEvent.change(screen.getByTestId("image-url"), {
        target: { value: "https://example.com/derived-provenance.png" },
      });
      await act(async () => {});
      const form = imageForm();
      const cancel = screen.getByRole("button", { name: "Cancel" });
      const nativePrototype = Object.getPrototypeOf(form) as object;
      const derivedPrototype = Object.create(nativePrototype) as object;
      const deceptiveValue = relation === "ownerDocument"
        ? document
        : Node.prototype.contains;
      const readRelation = vi.fn(() => {
        if (kind === "throwing") {
          throw new Error(`Instrumented ${relation} must not run`);
        }
        return deceptiveValue;
      });
      Object.defineProperty(derivedPrototype, relation, {
        configurable: true,
        get: readRelation,
      });
      Object.setPrototypeOf(form, derivedPrototype);
      let submit: Event | null = null;
      let dispatched = true;
      const later = vi.fn();
      try {
        await view.render(
          <ImageDialog
            open
            onOpenChange={rejectedClose}
            onSubmit={rejectedSubmit}
          />,
        );
        form.addEventListener("submit", later, { once: true });
        const stagedSubmit = submitEvent();
        submit = stagedSubmit;
        act(() => {
          dispatched = form.dispatchEvent(stagedSubmit);
        });
        fireEvent.click(cancel);
      } finally {
        Object.setPrototypeOf(form, nativePrototype);
      }

      expect(readRelation).not.toHaveBeenCalled();
      expect(dispatched).toBe(false);
      expect(submit?.defaultPrevented).toBe(true);
      expect(later).not.toHaveBeenCalled();
      expect(staleClose).not.toHaveBeenCalled();
      expect(staleSubmit).not.toHaveBeenCalled();
      expect(rejectedClose).not.toHaveBeenCalled();
      expect(rejectedSubmit).not.toHaveBeenCalled();

      await submitCleanSuccess(
        view,
        currentClose,
        currentSubmit,
        `https://example.com/${relation}-${kind}-derived-recovery.png`,
      );
      expect(staleClose).not.toHaveBeenCalled();
      expect(staleSubmit).not.toHaveBeenCalled();
      expect(rejectedClose).not.toHaveBeenCalled();
      expect(rejectedSubmit).not.toHaveBeenCalled();
    },
  );

  it("rejects a document defaultView shadow installed after root capture", async () => {
    const staleClose = vi.fn();
    const staleSubmit = vi.fn();
    const currentClose = vi.fn();
    const currentSubmit = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={staleSubmit}
      />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/shadowed-document.png" },
    });
    await act(async () => {});
    const form = imageForm();
    const defaultViewDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "defaultView",
    );
    const readDefaultView = vi.fn(() => window);
    const instrument = vi.fn(() => {
      Object.defineProperty(document, "defaultView", {
        configurable: true,
        get: readDefaultView,
      });
    });
    const later = vi.fn();
    form.addEventListener("submit", instrument, {
      capture: true,
      once: true,
    });
    form.addEventListener("submit", later, { once: true });
    const submit = submitEvent();
    let dispatched = true;
    try {
      act(() => {
        dispatched = form.dispatchEvent(submit);
      });
    } finally {
      if (defaultViewDescriptor) {
        Object.defineProperty(
          document,
          "defaultView",
          defaultViewDescriptor,
        );
      } else {
        Reflect.deleteProperty(document, "defaultView");
      }
    }

    expect(instrument).toHaveBeenCalledOnce();
    expect(readDefaultView).not.toHaveBeenCalled();
    expect(dispatched).toBe(false);
    expect(submit.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();

    await submitCleanSuccess(
      view,
      currentClose,
      currentSubmit,
      "https://example.com/shadowed-document-recovery.png",
    );
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();
  });

  it("rejects allowlisted mutation after root submit capture", async () => {
    const staleClose = vi.fn();
    const staleSubmit = vi.fn();
    const currentClose = vi.fn();
    const currentSubmit = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={staleSubmit}
      />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/mutated-submit.png" },
    });
    const form = imageForm();
    const content = dialogContent();
    const mutate = vi.fn(() => {
      const style = content.getAttribute("style");
      content.setAttribute(
        "style",
        content.style.pointerEvents === "auto"
          ? ""
          : "pointer-events: auto;",
      );
      if (style === null) content.removeAttribute("style");
      else content.setAttribute("style", style);
    });
    form.addEventListener("submit", mutate, { capture: true, once: true });
    const submit = submitEvent();
    let dispatched = true;
    act(() => {
      dispatched = form.dispatchEvent(submit);
    });

    expect(mutate).toHaveBeenCalledOnce();
    expect(dispatched).toBe(false);
    expect(submit.defaultPrevented).toBe(true);
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();

    await submitCleanSuccess(
      view,
      currentClose,
      currentSubmit,
      "https://example.com/mutation-recovery.png",
    );
    expect(staleClose).not.toHaveBeenCalled();
    expect(staleSubmit).not.toHaveBeenCalled();
  });

  it.each(["throwing", "deceptive"] as const)(
    "rejects a %s own Insert.form getter before application",
    async (kind) => {
      const staleClose = vi.fn();
      const staleSubmit = vi.fn();
      const currentClose = vi.fn();
      const currentSubmit = vi.fn();
      const view = await renderStrictRoot(
        <ImageDialog
          open
          onOpenChange={staleClose}
          onSubmit={staleSubmit}
        />,
      );
      fireEvent.change(screen.getByTestId("image-url"), {
        target: { value: "https://example.com/instrumented.png" },
      });
      await act(async () => {});
      const form = imageForm();
      const insert = screen.getByTestId("image-submit");
      const readForm = vi.fn(() => {
        if (kind === "throwing") {
          throw new Error("Instrumented Insert.form must not run");
        }
        return form;
      });
      const instrument = vi.fn(() => {
        Object.defineProperty(insert, "form", {
          configurable: true,
          get: readForm,
        });
      });
      const uncaught = vi.fn((event: ErrorEvent) => event.preventDefault());
      form.addEventListener("submit", instrument, {
        capture: true,
        once: true,
      });
      window.addEventListener("error", uncaught);
      const submit = submitEvent();
      let dispatched = true;
      try {
        act(() => {
          dispatched = form.dispatchEvent(submit);
        });
      } finally {
        window.removeEventListener("error", uncaught);
        Reflect.deleteProperty(insert, "form");
      }

      expect(instrument).toHaveBeenCalledOnce();
      expect(readForm).not.toHaveBeenCalled();
      expect(dispatched).toBe(false);
      expect(submit.defaultPrevented).toBe(true);
      expect(uncaught).not.toHaveBeenCalled();
      expect(staleClose).not.toHaveBeenCalled();
      expect(staleSubmit).not.toHaveBeenCalled();

      await submitCleanSuccess(
        view,
        currentClose,
        currentSubmit,
        `https://example.com/${kind}-recovery.png`,
      );
      expect(staleClose).not.toHaveBeenCalled();
      expect(staleSubmit).not.toHaveBeenCalled();
    },
  );

  it("suppresses a genuine submit after staged replay rejection and recovers freshly", async () => {
    const staleClose = vi.fn();
    const currentClose = vi.fn();
    const onSubmit = vi.fn();
    const onUpload = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={onSubmit}
        onUpload={onUpload}
      />,
    );
    const input = screen.getByTestId("image-url") as HTMLInputElement;
    const inputRef = reactProp<RefCallback<HTMLInputElement>>(input, "ref");

    inputRef(null);
    inputRef(input);
    await Promise.resolve();
    const content = dialogContent();
    const className = content.className;
    content.className = "invalidated-before-successor";
    content.className = className;
    await act(async () => {});

    const submit = submitEvent();
    act(() => imageForm().dispatchEvent(submit));
    expect(submit.defaultPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();

    await view.render(
      <ImageDialog
        open
        onOpenChange={currentClose}
        onSubmit={onSubmit}
        onUpload={onUpload}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(staleClose).not.toHaveBeenCalled();
    expect(currentClose).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("applies one upload outcome that settles during a staged replay gap", async () => {
    const pending = deferred<UploadResult>();
    const readUrl = vi.fn(() => "/api/assets/replayed");
    const readAlt = vi.fn(() => "Replayed Alt");
    const result = {} as UploadResult;
    Object.defineProperties(result, {
      url: { get: readUrl },
      alt: { get: readAlt },
    });
    await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onUpload={() => pending.promise}
      />,
    );
    choose(new File(["replayed"], "replayed.png", { type: "image/png" }));
    const input = screen.getByTestId("image-url") as HTMLInputElement;
    const inputRef = reactProp<RefCallback<HTMLInputElement>>(input, "ref");

    await act(async () => {
      inputRef(null);
      inputRef(input);
      pending.resolve(result);
      await pending.promise;
    });

    expect(readUrl).toHaveBeenCalledOnce();
    expect(readAlt).toHaveBeenCalledOnce();
    expect(screen.getByTestId("image-url")).toHaveValue(
      "/api/assets/replayed",
    );
    expect(screen.getByTestId("image-alt")).toHaveValue("Replayed Alt");
    expect(screen.getByTestId("image-upload")).toBeEnabled();
  });

  it("abandons a deferred outcome when staged replay is rejected and permits retry", async () => {
    const failed = deferred<UploadResult>();
    const retry = deferred<UploadResult>();
    const readUrl = vi.fn(() => "/api/assets/untrusted");
    const result = {} as UploadResult;
    Object.defineProperty(result, "url", { get: readUrl });
    const onUpload = vi
      .fn()
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retry.promise);
    const view = await renderStrictRoot(
      <Harness onUpload={onUpload} onSubmit={vi.fn()} />,
    );
    choose(new File(["failed"], "failed.png", { type: "image/png" }));
    const input = screen.getByTestId("image-url") as HTMLInputElement;
    const inputRef = reactProp<RefCallback<HTMLInputElement>>(input, "ref");

    inputRef(null);
    inputRef(input);
    await Promise.resolve();
    failed.resolve(result);
    await failed.promise;
    await Promise.resolve();
    expect(readUrl).not.toHaveBeenCalled();
    const content = dialogContent();
    const className = content.className;
    content.className = "invalidated-deferred-replay";
    await act(async () => {});

    expect(readUrl).not.toHaveBeenCalled();
    expect(screen.getByTestId("image-upload")).toBeEnabled();
    expect(screen.getByTestId("image-url")).toHaveValue("");
    expect(screen.queryByRole("alert")).toBeNull();

    content.className = className;
    await view.render(
      <Harness onUpload={onUpload} onSubmit={vi.fn()} />,
    );
    const retryFile = new File(["retry"], "retry.png", {
      type: "image/png",
    });
    choose(retryFile);
    expect(onUpload).toHaveBeenCalledTimes(2);
    expect(onUpload).toHaveBeenLastCalledWith(retryFile);
    await act(async () => {
      retry.resolve({ url: "/api/assets/retry" });
      await retry.promise;
    });
    expect(screen.getByTestId("image-url")).toHaveValue(
      "/api/assets/retry",
    );
  });

  it.each(["url", "alt"] as const)(
    "clears a deferred upload when its %s getter arms dirty final validation and permits a fresh retry",
    async (getter) => {
      const failed = deferred<UploadResult>();
      const retry = deferred<UploadResult>();
      const onUpload = vi
        .fn()
        .mockReturnValueOnce(failed.promise)
        .mockReturnValueOnce(retry.promise);
      await renderStrictRoot(
        <ImageDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      choose(new File(["failed"], "failed.png", { type: "image/png" }));
      const input = screen.getByTestId("image-url") as HTMLInputElement;
      const inputRef = reactProp<RefCallback<HTMLInputElement>>(input, "ref");
      const content = dialogContent();
      const retireSuccessor = vi.fn(() => {
        const className = content.className;
        content.className = "mutated-during-terminal-read";
        content.className = className;
      });

      await act(async () => {
        inputRef(null);
        inputRef(input);
        const result = {
          url: "/api/assets/untrusted",
          alt: "Untrusted Alt",
        } as UploadResult;
        Object.defineProperty(result, getter, {
          get() {
            armDirtyFileTypeRead(
              screen.getByTestId("image-file") as HTMLInputElement,
              retireSuccessor,
            );
            return getter === "url"
              ? "/api/assets/untrusted"
              : "Untrusted Alt";
          },
        });
        failed.resolve(result);
        await failed.promise;
      });

      await waitFor(() => expect(retireSuccessor).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(screen.getByTestId("image-upload")).toBeEnabled(),
      );
      expect(screen.getByTestId("image-url")).toHaveValue("");
      expect(screen.getByTestId("image-alt")).toHaveValue("");
      expect(screen.queryByRole("alert")).toBeNull();

      const retryFile = new File(["retry"], "retry.webp", {
        type: "image/webp",
      });
      choose(retryFile);
      expect(onUpload).toHaveBeenCalledTimes(2);
      expect(onUpload).toHaveBeenLastCalledWith(retryFile);
      await act(async () => {
        retry.resolve({ url: "/api/assets/retry", alt: "Retry Alt" });
        await retry.promise;
      });
      expect(screen.getByTestId("image-url")).toHaveValue(
        "/api/assets/retry",
      );
      expect(screen.getByTestId("image-alt")).toHaveValue("Retry Alt");
      expect(screen.getByTestId("image-upload")).toBeEnabled();
    },
  );

  it("clears a current upload when error extraction arms dirty final validation and permits retry", async () => {
    const failed = deferred<UploadResult>();
    const retry = deferred<UploadResult>();
    const onUpload = vi
      .fn()
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retry.promise);
    await renderStrictRoot(<Harness onUpload={onUpload} />);
    choose(new File(["failed"], "failed.png", { type: "image/png" }));
    const input = screen.getByTestId("image-file") as HTMLInputElement;
    const content = dialogContent();
    const dirty = vi.fn(() => {
      const className = content.className;
      content.className = "mutated-during-error-validation";
      content.className = className;
    });
    const error = new Error();
    Object.defineProperty(error, "message", {
      get() {
        armDirtyFileTypeRead(input, dirty);
        return "Untrusted failure";
      },
    });

    await act(async () => {
      failed.reject(error);
      await failed.promise.catch(() => undefined);
    });
    await waitFor(() => expect(dirty).toHaveBeenCalledOnce());
    expect(screen.getByTestId("image-upload")).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("image-url")).toHaveValue("");

    const retryFile = new File(["retry"], "retry.png", {
      type: "image/png",
    });
    choose(retryFile);
    expect(onUpload).toHaveBeenCalledTimes(2);
    expect(onUpload).toHaveBeenLastCalledWith(retryFile);
    await act(async () => {
      retry.resolve({ url: "/api/assets/retry" });
      await retry.promise;
    });
    expect(screen.getByTestId("image-url")).toHaveValue(
      "/api/assets/retry",
    );
  });

  it("makes a released unstaged guard permanently ineligible for delayed replay", async () => {
    const staleClose = vi.fn();
    const currentClose = vi.fn();
    const onUpload = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    const input = screen.getByTestId("image-url") as HTMLInputElement;
    const inputRef = reactProp<RefCallback<HTMLInputElement>>(input, "ref");

    inputRef(null);
    await Promise.resolve();
    const content = dialogContent();
    const className = content.className;
    content.className = "mutated-after-release";
    content.className = className;
    inputRef(input);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(staleClose).not.toHaveBeenCalled();

    await view.render(
      <ImageDialog
        open
        onOpenChange={currentClose}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(staleClose).not.toHaveBeenCalled();
    expect(currentClose).toHaveBeenCalledOnce();
  });

  it.each([
    ["url", "throw"],
    ["url", "retire"],
    ["alt", "throw"],
    ["alt", "retire"],
  ] as const)(
    "rejects a claimed %s value getter that can %s and keeps a fresh control usable",
    async (kind, behavior) => {
      await renderStrictRoot(
        <ImageDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          onUpload={vi.fn()}
        />,
      );
      const input = screen.getByTestId(
        kind === "url" ? "image-url" : "image-alt",
      ) as HTMLInputElement;
      const inputRef = reactProp<RefCallback<HTMLInputElement>>(input, "ref");
      const poisoned =
        kind === "url"
          ? "https://example.com/poisoned.png"
          : "Poisoned Alt";
      const recovered =
        kind === "url"
          ? "https://example.com/recovered.png"
          : "Recovered Alt";
      let reads = 0;

      await act(async () => {
        Object.defineProperty(input, "value", {
          configurable: true,
          get() {
            reads += 1;
            if (reads === 1) return "react-change-tracker";
            if (reads === 2) {
              if (behavior === "throw") throw new Error("Value getter failed");
              inputRef(null);
              return poisoned;
            }
            return "";
          },
          set() {},
        });
        input.dispatchEvent(
          new Event("change", { bubbles: true, cancelable: true }),
        );
        delete (input as unknown as { value?: string }).value;
      });

      expect(reads).toBeGreaterThanOrEqual(2);
      expect(input).not.toHaveValue(poisoned);
      await act(async () => {});
      fireEvent.change(input, { target: { value: recovered } });
      expect(input).toHaveValue(recovered);
    },
  );

  it("keeps preview errors bound to the exact preview publication", async () => {
    const onOpenChangeA = vi.fn();
    const onOpenChangeB = vi.fn();
    const onUpload = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={onOpenChangeA}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/a.png" },
    });
    await act(async () => {});
    const stalePreview = imageForm().querySelector("img");
    if (!(stalePreview instanceof HTMLImageElement)) {
      throw new Error("Image preview was not rendered");
    }
    const staleError = reactProp<
      (event: SyntheticEvent<HTMLImageElement>) => void
    >(stalePreview, "onError");

    await view.render(
      <ImageDialog
        open
        onOpenChange={onOpenChangeB}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/b.png" },
    });
    await act(async () => {});
    const currentPreview = imageForm().querySelector("img");
    if (!(currentPreview instanceof HTMLImageElement)) {
      throw new Error("Current image preview was not rendered");
    }
    const currentError = reactProp<
      (event: SyntheticEvent<HTMLImageElement>) => void
    >(currentPreview, "onError");

    setReactProp(currentPreview, "onError", staleError);
    fireEvent.error(currentPreview);
    expect(currentPreview.style.display).toBe("");
    setReactProp(currentPreview, "onError", currentError);
    fireEvent.error(currentPreview);
    expect(currentPreview.style.display).toBe("none");
  });

  it.each([
    "url",
    "alt",
    "upload",
    "file",
    "preview",
    "cancel",
    "close",
    "escape",
  ] as const)(
    "rejects a current %s event whose native provenance mutates restored DOM",
    async (kind) => {
      const staleClose = vi.fn();
      const currentClose = vi.fn();
      const onUpload = vi.fn(() =>
        Promise.resolve({ url: "/api/assets/untrusted" }),
      );
      const view = await renderStrictRoot(
        <ImageDialog
          open
          onOpenChange={staleClose}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      if (kind === "preview") {
        fireEvent.change(screen.getByTestId("image-url"), {
          target: { value: "https://example.com/preview.png" },
        });
        await act(async () => {});
      }
      const content = dialogContent();
      const dirty = vi.fn(() => {
        const className = content.className;
        content.className = "mutated-during-native-provenance";
        content.className = className;
      });
      let event: Event;
      let target: HTMLElement;
      let uploadClick: ReturnType<typeof vi.spyOn> | null = null;
      if (kind === "url" || kind === "alt") {
        target = screen.getByTestId(
          kind === "url" ? "image-url" : "image-alt",
        );
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(
          target,
          kind === "url"
            ? "https://example.com/untrusted.png"
            : "Untrusted Alt",
        );
        event = new Event("change", { bubbles: true, cancelable: true });
      } else if (kind === "file") {
        target = screen.getByTestId("image-file");
        Object.defineProperty(target, "files", {
          configurable: true,
          value: [
            new File(["untrusted"], "untrusted.png", { type: "image/png" }),
          ],
        });
        event = new Event("change", { bubbles: true, cancelable: true });
      } else if (kind === "preview") {
        const preview = imageForm().querySelector("img");
        if (!(preview instanceof HTMLImageElement)) {
          throw new Error("Image preview was not rendered");
        }
        target = preview;
        event = new Event("error");
      } else if (kind === "escape") {
        target = content;
        event = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        });
      } else {
        target = screen.getByRole("button", {
          name:
            kind === "close"
                ? "Close"
                : "Cancel",
        });
        if (kind === "upload") {
          target = screen.getByTestId("image-upload");
          uploadClick = vi.spyOn(
            screen.getByTestId("image-file") as HTMLInputElement,
            "click",
          );
        }
        event = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
        });
      }
      const composedPath = event.composedPath.bind(event);
      Object.defineProperty(event, "composedPath", {
        configurable: true,
        value: () => {
          dirty();
          return composedPath();
        },
      });

      act(() => target.dispatchEvent(event));
      expect(dirty).toHaveBeenCalled();
      expect(staleClose).not.toHaveBeenCalled();
      expect(onUpload).not.toHaveBeenCalled();
      if (uploadClick) expect(uploadClick).not.toHaveBeenCalled();
      if (kind === "preview") {
        expect(target.style.display).toBe("");
      }

      await act(async () => {});
      await view.render(
        <ImageDialog
          open
          onOpenChange={currentClose}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(staleClose).not.toHaveBeenCalled();
      expect(currentClose).toHaveBeenCalledOnce();
    },
  );

  it.each(["url", "alt"] as const)(
    "rejects a %s change when final validation reentrantly replays its ref",
    async (kind) => {
      const view = await renderStrictRoot(
        <ImageDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          onUpload={vi.fn()}
        />,
      );
      const input = screen.getByTestId(
        kind === "url" ? "image-url" : "image-alt",
      ) as HTMLInputElement;
      const ref = reactProp<RefCallback<HTMLInputElement>>(input, "ref");
      const file = screen.getByTestId("image-file") as HTMLInputElement;
      const replay = vi.fn(() => {
        ref(null);
        ref(input);
      });
      armDirtyFileTypeRead(file, replay);

      fireEvent.change(input, {
        target: {
          value:
            kind === "url"
              ? "https://example.com/untrusted.png"
              : "Untrusted Alt",
        },
      });
      expect(replay).toHaveBeenCalledOnce();
      await act(async () => {});
      expect(input).toHaveValue("");

      await view.render(
        <ImageDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          onUpload={vi.fn()}
        />,
      );
      fireEvent.change(input, {
        target: {
          value:
            kind === "url"
              ? "https://example.com/recovered.png"
              : "Recovered Alt",
        },
      });
      expect(input).toHaveValue(
        kind === "url"
          ? "https://example.com/recovered.png"
          : "Recovered Alt",
      );
    },
  );

  it.each(["result", "error", "reset"] as const)(
    "abandons a current upload when %s validation reentrantly replays a ref",
    async (kind) => {
      const failed = deferred<UploadResult>();
      const retry = deferred<UploadResult>();
      const onUpload = vi
        .fn()
        .mockReturnValueOnce(failed.promise)
        .mockReturnValueOnce(retry.promise);
      await renderStrictRoot(<Harness onUpload={onUpload} />);
      choose(new File(["failed"], "failed.png", { type: "image/png" }));
      const input = screen.getByTestId("image-file") as HTMLInputElement;
      const ref = reactProp<RefCallback<HTMLInputElement>>(input, "ref");
      const replay = vi.fn(() => {
        ref(null);
        ref(input);
      });

      if (kind === "reset") {
        Object.defineProperty(input, "value", {
          configurable: true,
          get: () => "failed-selection",
          set() {
            armDirtyFileTypeRead(input, replay);
          },
        });
      }
      await act(async () => {
        if (kind === "error") {
          const error = new Error();
          Object.defineProperty(error, "message", {
            get() {
              armDirtyFileTypeRead(input, replay);
              return "Untrusted failure";
            },
          });
          failed.reject(error);
          await failed.promise.catch(() => undefined);
        } else {
          const result = {
            url: "/api/assets/untrusted",
            alt: "Untrusted Alt",
          } as UploadResult;
          if (kind === "result") {
            Object.defineProperty(result, "url", {
              get() {
                armDirtyFileTypeRead(input, replay);
                return "/api/assets/untrusted";
              },
            });
          }
          failed.resolve(result);
          await failed.promise;
        }
      });

      expect(replay).toHaveBeenCalledOnce();
      await waitFor(() =>
        expect(screen.getByTestId("image-upload")).toBeEnabled(),
      );
      expect(screen.getByTestId("image-url")).toHaveValue("");
      expect(screen.getByTestId("image-alt")).toHaveValue("");
      expect(screen.queryByRole("alert")).toBeNull();

      delete (input as unknown as { value?: string }).value;
      const retryFile = new File(["retry"], "retry.png", {
        type: "image/png",
      });
      choose(retryFile);
      expect(onUpload).toHaveBeenCalledTimes(2);
      expect(onUpload).toHaveBeenLastCalledWith(retryFile);
      await act(async () => {
        retry.resolve({ url: "/api/assets/retry" });
        await retry.promise;
      });
      expect(screen.getByTestId("image-url")).toHaveValue(
        "/api/assets/retry",
      );
    },
  );

  it.each(["ancestor", "files"] as const)(
    "keeps the replay guard alive while reading successor %s",
    async (kind) => {
      const staleClose = vi.fn();
      const currentClose = vi.fn();
      const onUpload = vi.fn();
      const dirty = vi.fn(() => {
        const content = document.querySelector('[role="dialog"]');
        if (!(content instanceof HTMLDivElement)) return;
        const className = content.className;
        content.className = "mutated-during-successor-construction";
        content.className = className;
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const renderNode = async (node: ReactNode) => {
        await act(async () => {
          root.render(<StrictMode>{node}</StrictMode>);
        });
      };
      const view = { host, root, render: renderNode };
      directViews.push(view);
      let reads = 0;
      const filesDescriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "files",
      );
      const parent = host.parentNode;
      if (!filesDescriptor?.get || !parent) {
        throw new Error("DOM accessors were not available");
      }
      if (kind === "files") {
        Object.defineProperty(HTMLInputElement.prototype, "files", {
          ...filesDescriptor,
          get() {
            reads += 1;
            if (reads === 4) dirty();
            return filesDescriptor.get?.call(this);
          },
        });
      } else {
        Object.defineProperty(host, "parentNode", {
          configurable: true,
          get() {
            reads += 1;
            if (reads === 5) dirty();
            return parent;
          },
        });
      }
      try {
        await renderNode(
          <ImageDialog
            open
            onOpenChange={staleClose}
            onSubmit={vi.fn()}
            onUpload={onUpload}
          />,
        );
      } finally {
        Object.defineProperty(
          HTMLInputElement.prototype,
          "files",
          filesDescriptor,
        );
        Reflect.deleteProperty(host, "parentNode");
      }
      expect(dirty).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(staleClose).not.toHaveBeenCalled();

      await view.render(
        <ImageDialog
          open
          onOpenChange={currentClose}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(staleClose).not.toHaveBeenCalled();
      expect(currentClose).toHaveBeenCalledOnce();
    },
  );

  it.each(["mutation", "unexpected-ref"] as const)(
    "abandons a deferred outcome when partial recovery aborts for %s",
    async (kind) => {
      const failed = deferred<UploadResult>();
      const retry = deferred<UploadResult>();
      const readUrl = vi.fn(() => "/api/assets/untrusted");
      const result = {} as UploadResult;
      Object.defineProperty(result, "url", { get: readUrl });
      const onUpload = vi
        .fn()
        .mockReturnValueOnce(failed.promise)
        .mockReturnValueOnce(retry.promise);
      const view = await renderStrictRoot(<Harness onUpload={onUpload} />);
      choose(new File(["failed"], "failed.png", { type: "image/png" }));
      const url = screen.getByTestId("image-url") as HTMLInputElement;
      const urlRef = reactProp<RefCallback<HTMLInputElement>>(url, "ref");
      const content = dialogContent();
      const foreign = document.createElement("input");
      document.body.append(foreign);

      try {
        failed.resolve(result);
        urlRef(null);
        urlRef(url);
        if (kind === "mutation") {
          const className = content.className;
          content.className = "mutated-before-partial-recovery";
          content.className = className;
        } else {
          const alt = screen.getByTestId("image-alt") as HTMLInputElement;
          const altRef = reactProp<RefCallback<HTMLInputElement>>(alt, "ref");
          altRef(null);
          altRef(foreign);
        }
        await act(async () => {
          await failed.promise;
          await Promise.resolve();
        });

        expect(readUrl).not.toHaveBeenCalled();
        expect(screen.getByTestId("image-upload")).toBeEnabled();
        expect(screen.getByTestId("image-url")).toHaveValue("");

        await view.render(
          <Harness onUpload={onUpload} onSubmit={vi.fn()} />,
        );
        const retryFile = new File(["retry"], "retry.png", {
          type: "image/png",
        });
        choose(retryFile);
        expect(onUpload).toHaveBeenCalledTimes(2);
        expect(onUpload).toHaveBeenLastCalledWith(retryFile);
        await act(async () => {
          retry.resolve({ url: "/api/assets/retry" });
          await retry.promise;
        });
        expect(screen.getByTestId("image-url")).toHaveValue(
          "/api/assets/retry",
        );
      } finally {
        foreign.remove();
      }
    },
  );

  it("suppresses a genuine form while full DOM eligibility stays null", async () => {
    const staleSubmit = vi.fn();
    const currentClose = vi.fn();
    const onUpload = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={staleSubmit}
        onUpload={onUpload}
      />,
    );
    const file = screen.getByTestId("image-file") as HTMLInputElement;
    const type = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "type",
    );
    Object.defineProperty(file, "type", {
      configurable: true,
      get: () => "text",
      set: type?.set,
    });
    await view.render(
      <ImageDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={staleSubmit}
        onUpload={onUpload}
      />,
    );

    const submit = submitEvent();
    act(() => imageForm().dispatchEvent(submit));
    expect(submit.defaultPrevented).toBe(true);
    expect(staleSubmit).not.toHaveBeenCalled();
    const form = imageForm();
    const handler = reactProp<FormEventHandler<HTMLFormElement>>(
      form,
      "onSubmit",
    );
    const preventDefault = vi.fn();
    handler({
      currentTarget: form,
      target: form,
      nativeEvent: new Event("submit", {
        bubbles: true,
        cancelable: true,
      }),
      preventDefault,
    } as unknown as FormEvent<HTMLFormElement>);
    expect(preventDefault).not.toHaveBeenCalled();

    Reflect.deleteProperty(file, "type");
    await view.render(
      <ImageDialog
        open
        onOpenChange={currentClose}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(currentClose).toHaveBeenCalledOnce();
    expect(staleSubmit).not.toHaveBeenCalled();
  });

  it("suppresses navigation but rejects insertion after submit provenance replays a ref", async () => {
    const staleSubmit = vi.fn();
    const currentClose = vi.fn();
    const onUpload = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={staleSubmit}
        onUpload={onUpload}
      />,
    );
    fireEvent.change(screen.getByTestId("image-url"), {
      target: { value: "https://example.com/untrusted.png" },
    });
    await act(async () => {});
    const form = imageForm();
    const ref = reactProp<RefCallback<HTMLFormElement>>(form, "ref");
    const submit = submitEvent();
    const composedPath = submit.composedPath.bind(submit);
    Object.defineProperty(submit, "composedPath", {
      configurable: true,
      value: () => {
        ref(null);
        ref(form);
        return composedPath();
      },
    });

    act(() => form.dispatchEvent(submit));
    expect(submit.defaultPrevented).toBe(true);
    expect(staleSubmit).not.toHaveBeenCalled();

    await view.render(
      <ImageDialog
        open
        onOpenChange={currentClose}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(currentClose).toHaveBeenCalledOnce();
  });

  it("rechecks deferred ownership after replay history getters publish a successor", async () => {
    const failed = deferred<UploadResult>();
    const retry = deferred<UploadResult>();
    const readUrl = vi.fn(() => "/api/assets/untrusted");
    const result = {} as UploadResult;
    Object.defineProperty(result, "url", { get: readUrl });
    const onUpload = vi
      .fn()
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retry.promise);
    const onSubmit = vi.fn();
    const nextClose = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        onUpload={onUpload}
      />,
    );
    choose(new File(["failed"], "failed.png", { type: "image/png" }));
    const url = screen.getByTestId("image-url") as HTMLInputElement;
    const ref = reactProp<RefCallback<HTMLInputElement>>(url, "ref");
    const file = screen.getByTestId("image-file") as HTMLInputElement;
    const type = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "type",
    );
    if (!type?.get || !type.set) {
      throw new Error("HTMLInputElement.type accessors are unavailable");
    }

    failed.resolve(result);
    ref(null);
    ref(url);
    file.setAttribute("name", "");
    file.setAttribute("type", "file");
    file.removeAttribute("name");
    Object.defineProperty(file, "type", {
      configurable: true,
      get() {
        Reflect.deleteProperty(file, "type");
        flushSync(() => {
          view.root.render(
            <StrictMode>
              <ImageDialog
                open
                onOpenChange={nextClose}
                onSubmit={onSubmit}
                onUpload={onUpload}
              />
            </StrictMode>,
          );
        });
        return type.get?.call(file);
      },
      set(value: string) {
        type.set?.call(file, value);
      },
    });
    await act(async () => {
      await failed.promise;
      await Promise.resolve();
    });

    expect(readUrl).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("image-upload")).toBeEnabled(),
    );
    const retryFile = new File(["retry"], "retry.png", {
      type: "image/png",
    });
    choose(retryFile);
    expect(onUpload).toHaveBeenCalledTimes(2);
    expect(onUpload).toHaveBeenLastCalledWith(retryFile);
    await act(async () => {
      retry.resolve({ url: "/api/assets/retry" });
      await retry.promise;
    });
    expect(screen.getByTestId("image-url")).toHaveValue(
      "/api/assets/retry",
    );
  });

  it.each(["value", "files"] as const)(
    "rejects a candidate when its file %s getter detaches a required ref",
    async (property) => {
      const staleClose = vi.fn();
      const currentClose = vi.fn();
      const onUpload = vi.fn();
      const prototype = HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      if (!descriptor?.get) {
        throw new Error(`HTMLInputElement.${property} getter is unavailable`);
      }
      const detach = vi.fn();
      Object.defineProperty(prototype, property, {
        ...descriptor,
        get(this: HTMLInputElement) {
          const value = descriptor.get?.call(this);
          if (
            detach.mock.calls.length === 0 &&
            this.type === "file" &&
            this.isConnected
          ) {
            detach();
            reactProp<RefCallback<HTMLInputElement>>(this, "ref")(null);
          }
          return value;
        },
      });

      let view: DirectView;
      try {
        view = await renderStrictRoot(
          <ImageDialog
            open
            onOpenChange={staleClose}
            onSubmit={vi.fn()}
            onUpload={onUpload}
          />,
        );
      } finally {
        Object.defineProperty(prototype, property, descriptor);
      }
      expect(detach).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(staleClose).not.toHaveBeenCalled();

      await view.render(
        <ImageDialog
          open
          onOpenChange={currentClose}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(staleClose).not.toHaveBeenCalled();
      expect(currentClose).toHaveBeenCalledOnce();
    },
  );

  it("rejects replay when source release enqueues restored mutation history", async () => {
    const failed = deferred<UploadResult>();
    const retry = deferred<UploadResult>();
    const readUrl = vi.fn(() => "/api/assets/untrusted");
    const result = {} as UploadResult;
    Object.defineProperty(result, "url", { get: readUrl });
    const onUpload = vi
      .fn()
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retry.promise);
    const NativeObserver = window.MutationObserver;
    const nativeType = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "type",
    );
    if (!nativeType?.get || !nativeType.set) {
      throw new Error("HTMLInputElement.type accessors are unavailable");
    }
    const nativeTypeGetter = nativeType.get;
    const nativeTypeSetter = nativeType.set;
    let armSuccessor = false;
    let injected = false;
    const dirty = vi.fn();
    class ReleaseMutationObserver extends NativeObserver {
      override observe(target: Node, options?: MutationObserverInit) {
        super.observe(target, options);
        if (
          armSuccessor &&
          !injected &&
          target instanceof HTMLDivElement &&
          target.getAttribute("role") === "dialog"
        ) {
          const file = target.querySelector('[data-testid="image-file"]');
          if (!(file instanceof HTMLInputElement)) {
            throw new Error("Image file input was not rendered");
          }
          injected = true;
          Object.defineProperty(file, "type", {
            configurable: true,
            get() {
              Reflect.deleteProperty(file, "type");
              dirty();
              const className = target.className;
              target.className = "mutated-during-source-release";
              target.className = className;
              return nativeTypeGetter.call(file);
            },
            set(value: string) {
              nativeTypeSetter.call(file, value);
            },
          });
          file.setAttribute("name", "");
          file.setAttribute("type", "file");
          file.removeAttribute("name");
        }
      }
    }
    vi.stubGlobal("MutationObserver", ReleaseMutationObserver);
    const view = await renderStrictRoot(
      <Harness onUpload={onUpload} onSubmit={vi.fn()} />,
    );
    choose(new File(["failed"], "failed.png", { type: "image/png" }));
    const url = screen.getByTestId("image-url") as HTMLInputElement;
    const ref = reactProp<RefCallback<HTMLInputElement>>(url, "ref");

    armSuccessor = true;
    await act(async () => {
      ref(null);
      ref(url);
      failed.resolve(result);
      await failed.promise;
      await Promise.resolve();
    });

    expect(injected).toBe(true);
    expect(dirty).toHaveBeenCalledOnce();
    expect(readUrl).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("image-upload")).toBeEnabled(),
    );
    expect(screen.getByTestId("image-url")).toHaveValue("");

    await view.render(
      <Harness onUpload={onUpload} onSubmit={vi.fn()} />,
    );
    const retryFile = new File(["retry"], "retry.png", {
      type: "image/png",
    });
    choose(retryFile);
    expect(onUpload).toHaveBeenCalledTimes(2);
    expect(onUpload).toHaveBeenLastCalledWith(retryFile);
    await act(async () => {
      retry.resolve({ url: "/api/assets/retry" });
      await retry.promise;
    });
    expect(screen.getByTestId("image-url")).toHaveValue(
      "/api/assets/retry",
    );
  });

  it("retires an action when a ref connectivity getter restores DOM after the prior drain", async () => {
    const staleClose = vi.fn();
    const currentClose = vi.fn();
    const onUpload = vi.fn();
    const view = await renderStrictRoot(
      <ImageDialog
        open
        onOpenChange={staleClose}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    const cancel = screen.getByRole("button", {
      name: "Cancel",
    }) as HTMLButtonElement;
    const connected = Object.getOwnPropertyDescriptor(
      Node.prototype,
      "isConnected",
    );
    if (!connected?.get) {
      throw new Error("Node.isConnected getter is unavailable");
    }
    const dirty = vi.fn(() => {
      const content = dialogContent();
      const className = content.className;
      content.className = "mutated-during-connectivity-read";
      content.className = className;
    });
    Object.defineProperty(cancel, "isConnected", {
      configurable: true,
      get() {
        Reflect.deleteProperty(cancel, "isConnected");
        dirty();
        return connected.get?.call(cancel);
      },
    });

    fireEvent.click(cancel);
    expect(dirty).toHaveBeenCalledOnce();
    expect(staleClose).not.toHaveBeenCalled();

    await view.render(
      <ImageDialog
        open
        onOpenChange={currentClose}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(staleClose).not.toHaveBeenCalled();
    expect(currentClose).toHaveBeenCalledOnce();
  });
});
