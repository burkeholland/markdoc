// @vitest-environment jsdom
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import { NameVersionDialog, type NameVersionSaveOwner, type NameVersionVisit } from "./dialogs";

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
  editor,
  documentId,
  onSubmit,
  onOpenChange = vi.fn(),
}: {
  editor: object;
  documentId: string;
  onSubmit: (owner: NameVersionSaveOwner) => Promise<void>;
  onOpenChange?: (open: boolean) => void;
}) {
  const visitSequence = useRef(1);
  const operationSequence = useRef(0);
  const makeVisit = (id: number): NameVersionVisit => ({ id, editor, documentId });
  const [visit, setVisit] = useState(() => makeVisit(1));
  const [open, setOpen] = useState(true);
  const changeOpen = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    setOpen(nextOpen);
  };
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setVisit(makeVisit(++visitSequence.current));
          setOpen(true);
        }}
      >
        Open version dialog
      </button>
      <NameVersionDialog
        open={open}
        visit={visit}
        onOpenChange={(_visit, nextOpen) => changeOpen(nextOpen)}
        nextOperationId={() => ++operationSequence.current}
        onSubmit={onSubmit}
      />
    </>
  );
}

function form() {
  return screen.getByTestId("version-name-submit").closest("form")!;
}

function submitImmediatelyTwice() {
  const submit = new Event("submit", { bubbles: true, cancelable: true });
  const duplicate = new Event("submit", { bubbles: true, cancelable: true });
  act(() => {
    form().dispatchEvent(submit);
    form().dispatchEvent(duplicate);
  });
}

afterEach(cleanup);

describe("NameVersionDialog save ownership", () => {
  it("takes one synchronous owner with the exact trimmed snapshot and closes once on current success", async () => {
    const pending = deferred<void>();
    const editor = {};
    const onSubmit = vi.fn<(owner: NameVersionSaveOwner) => Promise<void>>(() => pending.promise);
    const onOpenChange = vi.fn();
    render(<Harness editor={editor} documentId="doc-1" onSubmit={onSubmit} onOpenChange={onOpenChange} />);

    const input = screen.getByTestId("version-name");
    fireEvent.change(input, { target: { value: "  Draft sent for review  " } });
    submitImmediatelyTwice();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const owner = onSubmit.mock.calls[0][0];
    expect(owner).toMatchObject({
      editor,
      documentId: "doc-1",
      operationId: 1,
      title: "Draft sent for review",
      visit: { id: 1, editor, documentId: "doc-1" },
    });
    expect(input).toBeDisabled();
    expect(screen.getByTestId("version-name-submit")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("does not cancel the version already being saved");

    fireEvent.change(input, { target: { value: "A forced late edit" } });
    fireEvent.submit(form());
    expect(input).toHaveValue("  Draft sent for review  ");
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("formats the current API failure inline, preserves the title, and admits one intentional retry", async () => {
    const failed = deferred<void>();
    const retry = deferred<void>();
    const onSubmit = vi.fn().mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    const onOpenChange = vi.fn();
    render(<Harness editor={{}} documentId="doc-1" onSubmit={onSubmit} onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Release candidate" } });
    fireEvent.submit(form());
    await act(async () => failed.reject(new ApiError(400, "Invalid request", [{ message: "Version names must be unique" }])));

    expect(screen.getByRole("alert")).toHaveTextContent("Version names must be unique");
    expect(screen.getByTestId("version-name")).toHaveValue("Release candidate");
    expect(screen.getByTestId("version-name")).toBeEnabled();
    expect(screen.getByTestId("version-name-submit")).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    submitImmediatelyTwice();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[1][0]).toMatchObject({ operationId: 2, title: "Release candidate" });
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => retry.resolve());
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("retires Cancel before an old success and keeps newer same-document work current", async () => {
    const stale = deferred<void>();
    const current = deferred<void>();
    const onSubmit = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const onOpenChange = vi.fn();
    render(<Harness editor={{}} documentId="doc-1" onSubmit={onSubmit} onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Old visit" } });
    fireEvent.submit(form());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Open version dialog" }));
    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Current visit" } });
    fireEvent.submit(form());
    expect(screen.getByTestId("version-name")).toBeDisabled();

    await act(async () => stale.resolve());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("version-name")).toHaveValue("Current visit");
    expect(screen.getByTestId("version-name")).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onOpenChange).toHaveBeenCalledTimes(1);

    await act(async () => current.resolve());
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("retires the actual Dialog close before an old failure can change a reopened visit", async () => {
    const stale = deferred<void>();
    const onSubmit = vi.fn<(owner: NameVersionSaveOwner) => Promise<void>>(() => stale.promise);
    const onOpenChange = vi.fn();
    render(<Harness editor={{}} documentId="doc-1" onSubmit={onSubmit} onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Old visit" } });
    fireEvent.submit(form());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Open version dialog" }));
    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Replacement title" } });

    await act(async () => stale.reject(new Error("Obsolete failure")));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("version-name")).toHaveValue("Replacement title");
    expect(screen.getByTestId("version-name")).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("routes Escape and overlay dismissal through the same retiring close boundary", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const second = deferred<void>();
    const onSubmit = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onOpenChange = vi.fn();
    render(<Harness editor={{}} documentId="doc-1" onSubmit={onSubmit} onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Escape save" } });
    fireEvent.submit(form());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Open version dialog" }));
    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Overlay save" } });
    fireEvent.submit(form());
    const overlay = document.querySelector(".dialog-overlay")!;
    await user.click(overlay);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve();
      second.reject(new Error("Closed failure"));
      await Promise.allSettled([first.promise, second.promise]);
    });
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it("retires ownership on unmount and consumes late rejection without reading or reporting it", async () => {
    const pending = deferred<void>();
    const readMessage = vi.fn(() => "Too late");
    const error = new Error();
    Object.defineProperty(error, "message", { get: readMessage });
    const unhandled = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener("unhandledrejection", unhandled);
    const view = render(<Harness editor={{}} documentId="doc-1" onSubmit={() => pending.promise} />);

    fireEvent.change(screen.getByTestId("version-name"), { target: { value: "Unmounted save" } });
    fireEvent.submit(form());
    view.unmount();
    await act(async () => {
      pending.reject(error);
      await pending.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(readMessage).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});
