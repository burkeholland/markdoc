// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@/lib/api";
import { ImageDialog } from "./dialogs";

interface UploadResult {
  url: string;
  alt?: string;
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

afterEach(cleanup);

describe("ImageDialog upload lifecycle", () => {
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
