// @vitest-environment jsdom
import {
  StrictMode,
  useState,
  type ChangeEvent,
  type ChangeEventHandler,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { compile } from "tailwindcss";
import { ApiError } from "@/lib/api";
import { ImageDialog } from "./dialogs";
import { IMAGE_TOO_LARGE_MESSAGE, MAX_IMAGE_BYTES } from "@/lib/image-limits";

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

function choose(file: File) {
  fireEvent.change(screen.getByTestId("image-file"), { target: { files: [file] } });
}

function setInputValue(input: HTMLInputElement, value: string) {
  Object.defineProperty(input, "value", { configurable: true, writable: true, value });
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

describe("ImageDialog error wrapping", () => {
  const failures = [
    { kind: "unbroken", message: "U".repeat(256) },
    { kind: "ordinary", message: `  ${"The image could not be uploaded. Please choose another file. ".repeat(5)} ` },
    { kind: "literal markup", message: '<button tabindex="0">Retry</button> & <a href="/upload">Upload</a> <img src="invalid" />'.repeat(4) },
  ];

  function expectError(message: string) {
    const error = screen.getByTestId("image-upload-error");
    expect(message.length).toBeGreaterThanOrEqual(240);
    expect(error.tagName).toBe("DIV");
    expect(error.textContent).toBe(message);
    expect(error.children).toHaveLength(0);
    expect(error.childNodes).toHaveLength(1);
    expect(error.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(Object.fromEntries([...error.attributes].map(({ name, value }) => [name, value]))).toEqual({
      class: "text-sm text-danger wrap-anywhere",
      role: "alert",
      "data-testid": "image-upload-error",
    });
    expect(error.parentElement).toBe(imageForm());
    expect(error).toBeVisible();
    expect(error.tabIndex).toBe(-1);
    expect(screen.getAllByRole("alert")).toEqual([error]);
    return error;
  }

  it.each(failures)("preserves complete $kind upload failures without new controls", async ({ message }) => {
    const pending = deferred<UploadResult>();
    const onUpload = vi.fn(() => pending.promise);
    const onSubmit = vi.fn();
    await renderStrictRoot(<Harness onUpload={onUpload} onSubmit={onSubmit} />);
    const controls = [...dialogContent().querySelectorAll<HTMLElement>("*")].filter((element) => element.tabIndex >= 0);
    const file = new File(["image"], "photo.png", { type: "image/png" });
    choose(file);
    await act(async () => pending.reject(new ApiError(400, "Invalid request", [{ message }])));

    expectError(message);
    expect([...dialogContent().querySelectorAll<HTMLElement>("*")].filter((element) => element.tabIndex >= 0)).toEqual(controls);
    expect(screen.getByTestId("image-file")).toHaveValue("");
    expect(screen.getByTestId("image-file")).toBeEnabled();
    expect(screen.getByTestId("image-upload")).toBeEnabled();
    expect(screen.getByTestId("image-submit")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
    expect(onUpload).toHaveBeenCalledExactlyOnceWith(file);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("replaces a wrapped failure, admits one explicit upload retry and recovers the preview", async () => {
    const first = deferred<UploadResult>();
    const second = deferred<UploadResult>();
    const retry = deferred<UploadResult>();
    const onUpload = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(retry.promise);
    const onSubmit = vi.fn();
    await renderStrictRoot(<Harness onUpload={onUpload} onSubmit={onSubmit} />);
    choose(new File(["first"], "first.png", { type: "image/png" }));
    await act(async () => first.reject(new ApiError(400, failures[0].message)));
    const firstError = expectError(failures[0].message);

    choose(new File(["second"], "second.png", { type: "image/png" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(firstError).not.toBeInTheDocument();
    await act(async () => second.reject(new ApiError(400, failures[2].message)));
    expectError(failures[2].message);
    expect(dialogContent().textContent).not.toContain(failures[0].message);

    const file = new File(["retry"], "retry.png", { type: "image/png" });
    choose(file);
    choose(file);
    expect(onUpload).toHaveBeenCalledTimes(3);
    expect(onUpload).toHaveBeenLastCalledWith(file);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("image-upload")).toBeDisabled();
    await act(async () => retry.resolve({ url: "/api/assets/retry", alt: "Uploaded image" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("image-url")).toHaveValue("/api/assets/retry");
    expect(screen.getByTestId("image-alt")).toHaveValue("Uploaded image");
    expect(screen.getByRole("presentation")).toHaveAttribute("src", "/api/assets/retry");
    expect(screen.getByTestId("image-upload")).toBeEnabled();
    expect(screen.getByTestId("image-submit")).toBeEnabled();
    fireEvent.submit(imageForm());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledExactlyOnceWith("/api/assets/retry", "Uploaded image"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("discards a wrapped failure on close and reopen", async () => {
    const pending = deferred<UploadResult>();
    const onUpload = vi.fn(() => pending.promise);
    const onSubmit = vi.fn();
    await renderStrictRoot(<Harness onUpload={onUpload} onSubmit={onSubmit} />);
    choose(new File(["image"], "photo.png", { type: "image/png" }));
    await act(async () => pending.reject(new ApiError(400, failures[0].message)));
    const error = expectError(failures[0].message);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open image dialog" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(error).not.toBeInTheDocument();
    expect(screen.getByTestId("image-url")).toHaveValue("");
    expect(screen.getByTestId("image-alt")).toHaveValue("");
    expect(screen.getByTestId("image-upload")).toBeEnabled();
    expect(onUpload).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("discards a wrapped failure when document callbacks change and only calls the current upload", async () => {
    const pending = deferred<UploadResult>();
    const oldUpload = vi.fn(() => pending.promise);
    const oldSubmit = vi.fn();
    const current = deferred<UploadResult>();
    const currentUpload = vi.fn(() => current.promise);
    const currentSubmit = vi.fn();
    const view = await renderStrictRoot(<Harness onUpload={oldUpload} onSubmit={oldSubmit} />);
    choose(new File(["old"], "old.png", { type: "image/png" }));
    await act(async () => pending.reject(new ApiError(400, failures[0].message)));
    expectError(failures[0].message);
    await view.render(<Harness onUpload={currentUpload} onSubmit={currentSubmit} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("image-url")).toHaveValue("");
    const file = new File(["current"], "current.png", { type: "image/png" });
    choose(file);
    expect(currentUpload).toHaveBeenCalledExactlyOnceWith(file);
    await act(async () => current.resolve({ url: "/api/assets/current" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("image-url")).toHaveValue("/api/assets/current");
    expect(oldUpload).toHaveBeenCalledOnce();
    expect(oldSubmit).not.toHaveBeenCalled();
    expect(currentSubmit).not.toHaveBeenCalled();
  });

  it("does no request, focus, mutation or scheduling work during settled passive inspection", async () => {
    const pending = deferred<UploadResult>();
    const onUpload = vi.fn(() => pending.promise);
    const onSubmit = vi.fn();
    await renderStrictRoot(<Harness onUpload={onUpload} onSubmit={onSubmit} />);
    choose(new File(["image"], "photo.png", { type: "image/png" }));
    await act(async () => pending.reject(new ApiError(400, failures[0].message)));
    await act(async () => {});
    const active = document.activeElement;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const fetch = vi.spyOn(globalThis, "fetch");
    const timeout = vi.spyOn(window, "setTimeout");
    const interval = vi.spyOn(window, "setInterval");
    const frame = vi.spyOn(window, "requestAnimationFrame");
    const microtask = vi.spyOn(window, "queueMicrotask");
    const observer = new MutationObserver(() => {});
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      expectError(failures[0].message);
      expectError(failures[0].message);
      expect(document.activeElement).toBe(active);
      expect(observer.takeRecords()).toHaveLength(0);
      for (const effect of [focus, fetch, timeout, interval, frame, microtask, onSubmit]) {
        expect(effect).not.toHaveBeenCalled();
      }
      expect(onUpload).toHaveBeenCalledOnce();
    } finally {
      observer.disconnect();
    }
  });

  it("emits anywhere overflow wrapping for both error surfaces from installed Tailwind", async () => {
    const { build } = await compile("@tailwind utilities;");
    const css = build(["wrap-anywhere"]);
    expect(css).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
    expect(css).not.toMatch(/word-break:|text-overflow:|overflow:\s*(hidden|auto|scroll)/);
  });
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

  it.each(["close", "cancel", "escape", "outside"] as const)(
    "delivers every %s dismissal to the owner, also after the owner kept the dialog open",
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

      expect(onOpenChange.mock.calls).toEqual([[false], [false]]);
    },
  );

  it("recovers controls after restored content mutation queued before passive settlement", async () => {
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
    expect(staleClose).toHaveBeenCalledExactlyOnceWith(false);

    await view.render(
      <ImageDialog
        open
        onOpenChange={currentClose}
        onSubmit={vi.fn()}
        onUpload={onUpload}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(staleClose).toHaveBeenCalledOnce();
    expect(currentClose).toHaveBeenCalledOnce();
  });

  it.each(["radix", "controlled"] as const)(
    "closes on Cancel after a restored %s reconciliation shape, and again for a fresh owner",
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
      expect(staleClose).toHaveBeenCalledExactlyOnceWith(false);

      await view.render(
        <ImageDialog
          open
          onOpenChange={currentClose}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(staleClose).toHaveBeenCalledOnce();
      expect(currentClose).toHaveBeenCalledExactlyOnceWith(false);
    },
  );

  it("closes on Escape after a draft successor publishes", async () => {
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

});

describe("ImageDialog dismissal (#2223)", () => {
  const dismissals = ["escape", "close", "cancel", "outside"] as const;

  // Focusing the toolbar's Image button with the keyboard shows its tooltip, portaled to <body>, and
  // the tooltip is removed a moment after the dialog opens. The dialog's controls watch their place in
  // <body> and retire when it changes; a dismissal used to be dropped until the next render.
  async function openBesideTooltip(node: ReactNode) {
    await renderStrictRoot(node);
    const tooltip = document.createElement("div");
    tooltip.setAttribute("data-radix-popper-content-wrapper", "");
    document.body.append(tooltip);
    fireEvent.click(screen.getByRole("button", { name: "Open image dialog" }));
    await act(async () => {});
    expect(tooltip.nextElementSibling).not.toBeNull();
    return tooltip;
  }

  function dismissBy(kind: (typeof dismissals)[number]) {
    if (kind === "escape") {
      fireEvent.keyDown(screen.getByTestId("image-url"), { key: "Escape" });
    } else if (kind === "outside") {
      const overlay = document.querySelector(".dialog-overlay");
      if (!(overlay instanceof HTMLDivElement)) throw new Error("Image overlay was not rendered");
      act(() => {
        for (const type of ["pointerdown", "click"]) {
          overlay.dispatchEvent(new ControlledPointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 3 }));
        }
      });
    } else {
      fireEvent.click(screen.getByRole("button", { name: kind === "close" ? "Close" : "Cancel" }));
    }
  }

  async function closed() {
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The shared dialog runs onClosed one task after it unmounts.
    await act(async () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)));
  }

  it.each(dismissals)(
    "closes on %s right after a sibling of the dialog leaves <body>, inserts nothing and reopens empty",
    async (kind) => {
      const onSubmit = vi.fn();
      const tooltip = await openBesideTooltip(<Harness initiallyOpen={false} onUpload={vi.fn()} onSubmit={onSubmit} />);
      fireEvent.change(screen.getByTestId("image-url"), { target: { value: "https://example.com/typed.png" } });
      fireEvent.change(screen.getByTestId("image-alt"), { target: { value: "Typed alt" } });
      await act(async () => {});

      tooltip.remove();
      dismissBy(kind);
      await closed();
      expect(onSubmit).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Open image dialog" }));
      expect(screen.getByTestId("image-url")).toHaveValue("");
      expect(screen.getByTestId("image-alt")).toHaveValue("");

      // One Insert still adds exactly one image.
      fireEvent.change(screen.getByTestId("image-url"), { target: { value: "https://example.com/inserted.png" } });
      await act(async () => {});
      expect(imageForm().dispatchEvent(submitEvent())).toBe(false);
      await closed();
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith("https://example.com/inserted.png", "");
    },
  );

  // Not "outside": Radix starts listening for outside pointers one task after the dialog mounts.
  it.each(["escape", "close", "cancel"] as const)(
    "closes on %s the moment the dialog has opened, before its controls have settled",
    async (kind) => {
      const onSubmit = vi.fn();
      await renderStrictRoot(<Harness initiallyOpen={false} onUpload={vi.fn()} onSubmit={onSubmit} />);
      fireEvent.click(screen.getByRole("button", { name: "Open image dialog" }));

      dismissBy(kind);
      await closed();
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );

  it.each(dismissals.flatMap((kind) => (["success", "failure"] as const).map((settlement) => ({ kind, settlement }))))(
    "closes on $kind during an upload right after a sibling leaves <body>; its late $settlement is dropped and a reopened dialog starts clean",
    async ({ kind, settlement }) => {
      const pending = deferred<UploadResult>();
      const retry = deferred<UploadResult>();
      const onUpload = vi.fn().mockReturnValueOnce(pending.promise).mockReturnValueOnce(retry.promise);
      const onSubmit = vi.fn();
      const tooltip = await openBesideTooltip(<Harness initiallyOpen={false} onUpload={onUpload} onSubmit={onSubmit} />);
      choose(new File(["selected"], "selected.png", { type: "image/png" }));
      expect(onUpload).toHaveBeenCalledOnce();
      expect(screen.getByTestId("image-upload")).toHaveTextContent("Uploading…");

      tooltip.remove();
      dismissBy(kind);
      await closed();

      const readUrl = vi.fn(() => "/api/assets/stale");
      const staleResult = {} as UploadResult;
      Object.defineProperty(staleResult, "url", { get: readUrl });
      const readMessage = vi.fn(() => "Stale upload failed");
      const staleError = new Error();
      Object.defineProperty(staleError, "message", { get: readMessage });
      await act(async () => {
        if (settlement === "success") pending.resolve(staleResult);
        else pending.reject(staleError);
        await pending.promise.catch(() => undefined);
      });
      expect(readUrl).not.toHaveBeenCalled();
      expect(readMessage).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Open image dialog" }));
      expect(screen.getByTestId("image-url")).toHaveValue("");
      expect(screen.getByTestId("image-alt")).toHaveValue("");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTestId("image-upload")).toHaveTextContent("Upload…");
      expect(screen.getByTestId("image-upload")).toBeEnabled();

      const currentFile = new File(["current"], "current.png", { type: "image/png" });
      choose(currentFile);
      expect(onUpload).toHaveBeenCalledTimes(2);
      expect(onUpload).toHaveBeenLastCalledWith(currentFile);
      await act(async () => {
        retry.resolve({ url: "/api/assets/current" });
        await retry.promise;
      });
      expect(screen.getByTestId("image-url")).toHaveValue("/api/assets/current");
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );
});

describe("ImageDialog size check (#2345)", () => {
  it("says a picture over 5 MB is too large at once and does not upload it", async () => {
    const onUpload = vi.fn(() => new Promise<UploadResult>(() => {}));
    await renderStrictRoot(<Harness onUpload={onUpload} />);
    choose(new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "big.png", { type: "image/png" }));
    expect(screen.getByTestId("image-upload-error")).toHaveTextContent(IMAGE_TOO_LARGE_MESSAGE);
    expect(onUpload).not.toHaveBeenCalled();
    expect(screen.getByTestId("image-upload")).toBeEnabled();
    expect(screen.getByTestId("image-file")).toHaveValue("");

    const exact = new File([new Uint8Array(MAX_IMAGE_BYTES)], "exact.png", { type: "image/png" });
    choose(exact);
    expect(onUpload).toHaveBeenCalledExactlyOnceWith(exact);
  });
});
