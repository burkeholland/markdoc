// @vitest-environment jsdom
import { StrictMode, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentDto } from "@/server/dto";
import { ApiError } from "@/lib/api";

vi.mock("./gist-auto-update", () => ({
  GistAutoUpdateControl: ({ doc, isOwner }: { doc: DocumentDto; isOwner: boolean }) =>
    isOwner && doc.storage === "gist" && doc.gistId && doc.gistFile && doc.githubUrl && doc.publishedAt ? (
      <div data-testid="gist-auto-update-stub" data-document={doc.id} />
    ) : null,
}));

import { CommitDialog } from "./github-dialog";

const REPO_DOC: DocumentDto = {
  id: "doc-1",
  title: "Notes",
  storage: "repo",
  linkAccess: "private",
  linkPreview: false,
  ownerId: "owner-1",
  gistId: null,
  gistFile: null,
  repoOwner: "octo",
  repoName: "notes",
  repoBranch: "main",
  repoPath: "docs/notes.md",
  publishedAt: null,
  hasUnpublishedChanges: true,
  githubUrl: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};
const GIST_DOC: DocumentDto = {
  ...REPO_DOC,
  id: "doc-gist",
  storage: "gist",
  repoOwner: null,
  repoName: null,
  repoBranch: null,
  repoPath: null,
  gistId: "abc123",
  gistFile: "notes.md",
  githubUrl: "https://gist.github.com/octo/abc123",
  publishedAt: "2026-08-28T00:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Props = ComponentProps<typeof CommitDialog>;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe.each([
  ["without Strict Mode", false],
  ["in Strict Mode", true],
])("CommitDialog %s", (_name, strict) => {
  function open(overrides: Partial<Props> = {}) {
    const onCommit = vi.fn<(message: string) => Promise<void>>(async () => undefined);
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const props: Props = { open: true, onOpenChange, doc: REPO_DOC, onCommit, isOwner: true, ...overrides };
    const view = render(<CommitDialog {...props} />, { wrapper: strict ? StrictMode : undefined });
    const update = (next: Partial<Props>) => {
      Object.assign(props, next);
      view.rerender(<CommitDialog {...props} />);
    };
    return { onCommit: props.onCommit as typeof onCommit, onOpenChange: props.onOpenChange as typeof onOpenChange, update, view };
  }
  const field = () => screen.getByTestId("commit-message") as HTMLInputElement;
  const submit = () => screen.getByTestId("commit-submit") as HTMLButtonElement;
  const cancel = () => screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
  const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
  /** One full press of Enter in the message field. */
  const pressEnterInField = () => {
    const down = fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.keyUp(field(), { key: "Enter" });
    return down;
  };
  const settle = async (run: () => void) => {
    await act(async () => {
      run();
      await Promise.resolve();
    });
  };

  it("names the repository destination and starts with the default message in a labelled field", () => {
    open();
    const dialog = screen.getByRole("dialog", { name: "Commit to GitHub" });
    expect(dialog).toHaveTextContent("Creates a commit on main in octo/notes.");
    expect(screen.getByLabelText("Commit message")).toBe(field());
    expect(field()).toHaveValue("Update docs/notes.md");
    expect(field()).toHaveFocus();
    expect(submit()).toHaveTextContent("Commit");
    expect(submit()).toHaveAttribute("type", "submit");
    expect(cancel()).toHaveAttribute("type", "button");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("gist-auto-update-stub")).toBeNull();
  });

  it("words a gist as Update gist with a Description and shows the owner's auto-update control", () => {
    open({ doc: GIST_DOC });
    expect(screen.getByRole("dialog", { name: "Update gist" })).toHaveTextContent("Publishes the current text to the gist.");
    expect(screen.getByLabelText("Description")).toHaveValue("Update notes.md");
    expect(submit()).toHaveTextContent("Update gist");
    expect(screen.getByTestId("gist-auto-update-stub")).toHaveAttribute("data-document", "doc-gist");
  });

  it("sends the typed message once, trimmed, when Commit is clicked", async () => {
    const { onCommit } = open();
    type("  Ship it  ");
    expect(field()).toHaveValue("  Ship it  ");
    await settle(() => fireEvent.click(submit()));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Ship it");
  });

  it("Enter in the field sends on release, once; a repeat, a release without a press, a modified Enter and an IME Enter send nothing", async () => {
    const { onCommit } = open();
    type("From the keyboard");
    // A key held since before the dialog opened: only repeats and the release arrive here.
    expect(fireEvent.keyDown(field(), { key: "Enter", repeat: true })).toBe(false);
    fireEvent.keyUp(field(), { key: "Enter" });
    fireEvent.keyUp(field(), { key: "Enter" });
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(fireEvent.keyDown(field(), { key: "Enter", [modifier]: true })).toBe(false);
      fireEvent.keyUp(field(), { key: "Enter", [modifier]: true });
    }
    // The Enter that ends an IME composition is left to the browser.
    expect(fireEvent.keyDown(field(), { key: "Enter", isComposing: true })).toBe(true);
    fireEvent.keyUp(field(), { key: "Enter" });
    expect(fireEvent.keyDown(field(), { key: "Enter", keyCode: 229 })).toBe(true);
    fireEvent.keyUp(field(), { key: "Enter", keyCode: 229 });
    // A press that leaves the field before the release.
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.blur(field());
    fireEvent.keyUp(field(), { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();

    // The press itself does nothing; its repeats do nothing; the release sends.
    expect(fireEvent.keyDown(field(), { key: "Enter" })).toBe(false);
    fireEvent.keyDown(field(), { key: "Enter", repeat: true });
    fireEvent.keyDown(field(), { key: "Enter", repeat: true });
    expect(onCommit).not.toHaveBeenCalled();
    await settle(() => fireEvent.keyUp(field(), { key: "Enter" }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("From the keyboard");
  });

  it.each(["", " \t "])("a blank message %j is sent as an empty string by Enter and by the button, and the form never submits natively", async (text) => {
    const pending = deferred<void>();
    const { onCommit } = open({ onCommit: vi.fn(() => pending.promise) });
    type(text);
    await settle(() => {
      expect(pressEnterInField()).toBe(false);
    });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("");
    // A submit event from any source is cancelled, so the browser never navigates.
    expect(fireEvent.submit(field().form!)).toBe(false);
    expect(onCommit).toHaveBeenCalledOnce();
    await settle(() => pending.reject(new Error("no")));

    await settle(() => fireEvent.click(submit()));
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith("");
  });

  it("while the request runs Commit is aria-disabled, never disabled, and more presses send nothing", async () => {
    const pending = deferred<void>();
    const { onCommit, onOpenChange } = open({ onCommit: vi.fn(() => pending.promise) });
    submit().focus();
    await settle(() => fireEvent.click(submit()));
    expect(submit()).toHaveAttribute("aria-disabled", "true");
    expect(submit()).not.toBeDisabled();
    expect(submit()).toHaveFocus();
    expect(submit().querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(submit());
    fireEvent.submit(field().form!);
    pressEnterInField();
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalled();
    await settle(() => pending.resolve());
  });

  it("success shows Published and closes once, 900 ms later", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const { onCommit, onOpenChange } = open({ onCommit: vi.fn(() => pending.promise) });
    fireEvent.click(submit());
    await settle(() => pending.resolve());
    expect(submit()).toHaveTextContent("Published");
    expect(submit()).toHaveAttribute("aria-disabled", "true");
    // Published is the end of this visit: nothing more is sent.
    fireEvent.click(submit());
    pressEnterInField();
    act(() => void vi.advanceTimersByTime(899));
    expect(onOpenChange).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    act(() => void vi.advanceTimersByTime(5_000));
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("a failure is shown word for word below the buttons, stays during the retry, and goes when the retry succeeds", async () => {
    const long = `${"GitHub refused this commit <b>because</b> ".repeat(8)}${"x".repeat(200)}`;
    const first = deferred<void>();
    const second = deferred<void>();
    const third = deferred<void>();
    const onCommit = vi.fn<(message: string) => Promise<void>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    open({ onCommit });
    fireEvent.click(submit());
    await settle(() => first.reject(new ApiError(502, long)));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(long);
    expect(alert).toHaveClass("wrap-anywhere");
    // After the action row, so a long reason cannot push Cancel and Commit.
    expect(submit().compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.parentElement).toBe(field().form);
    expect(alert.nextElementSibling).toBeNull();
    expect(submit()).not.toHaveAttribute("aria-disabled");
    expect(submit()).toHaveTextContent("Commit");

    fireEvent.click(submit());
    expect(screen.getByRole("alert").textContent).toBe(long);
    await settle(() => second.reject(new Error("Second reason")));
    expect(screen.getByRole("alert").textContent).toBe("Second reason");

    fireEvent.click(submit());
    await settle(() => third.resolve());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(submit()).toHaveTextContent("Published");
    expect(onCommit).toHaveBeenCalledTimes(3);
  });

  it("a failure without a reason falls back to Publish failed", async () => {
    open({ onCommit: vi.fn(() => Promise.reject({})) });
    await settle(() => fireEvent.click(submit()));
    expect(screen.getByRole("alert")).toHaveTextContent("Publish failed");
  });

  it("the second click of a double-click sends nothing, also when the first one has already failed", async () => {
    const onCommit = vi.fn<(message: string) => Promise<void>>(() => Promise.reject(new Error("Refused")));
    open({ onCommit });
    await settle(() => fireEvent.click(submit(), { detail: 1 }));
    expect(screen.getByRole("alert")).toHaveTextContent("Refused");
    await settle(() => fireEvent.click(submit(), { detail: 2 }));
    await settle(() => fireEvent.click(submit(), { detail: 3 }));
    expect(onCommit).toHaveBeenCalledOnce();
    // A new press is a retry.
    await settle(() => fireEvent.click(submit(), { detail: 1 }));
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("Cancel closes once; closing while the request runs lets go of it, and the next visit starts clean", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const { onCommit, onOpenChange, update } = open({ onCommit: vi.fn(() => pending.promise) });
    type("Draft that is thrown away");
    fireEvent.click(submit());
    fireEvent.click(cancel());
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    update({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();

    update({ open: true });
    expect(field()).toHaveValue("Update docs/notes.md");
    expect(submit()).not.toHaveAttribute("aria-disabled");
    // The old request ends now: it neither shows Published here nor closes this visit.
    await settle(() => pending.resolve());
    expect(submit()).toHaveTextContent("Commit");
    act(() => void vi.advanceTimersByTime(5_000));
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("a failure that lands after close and reopen is not shown, and a failure shown before is gone after reopen", async () => {
    const pending = deferred<void>();
    const onCommit = vi.fn<(message: string) => Promise<void>>().mockReturnValueOnce(Promise.reject(new Error("Shown"))).mockReturnValueOnce(pending.promise);
    const { update } = open({ onCommit });
    await settle(() => fireEvent.click(submit()));
    expect(screen.getByRole("alert")).toHaveTextContent("Shown");
    update({ open: false });
    update({ open: true });
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(submit());
    update({ open: false });
    update({ open: true });
    await settle(() => pending.reject(new Error("Late")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(submit()).not.toHaveAttribute("aria-disabled");
  });

  it("a refresh of the same destination keeps the draft, the running request and Published; a new destination starts over", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const { onCommit, onOpenChange, update } = open({ onCommit: vi.fn(() => pending.promise) });
    type("My draft");
    // The title changes and the first publication's metadata arrives: same file, same visit.
    update({ doc: { ...REPO_DOC, title: "Renamed", hasUnpublishedChanges: false } });
    expect(field()).toHaveValue("My draft");
    fireEvent.click(submit());
    update({ doc: { ...REPO_DOC, title: "Renamed", publishedAt: "2026-09-01T00:00:00.000Z", githubUrl: "https://github.com/octo/notes/blob/main/docs/notes.md" } });
    expect(submit()).toHaveAttribute("aria-disabled", "true");
    await settle(() => pending.resolve());
    expect(submit()).toHaveTextContent("Published");
    update({ doc: { ...REPO_DOC, title: "Renamed again", publishedAt: "2026-09-01T00:00:01.000Z" } });
    expect(submit()).toHaveTextContent("Published");
    act(() => void vi.advanceTimersByTime(900));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("My draft");

    // Another file: the form starts over and the old visit's timer and result are gone.
    onOpenChange.mockClear();
    type("Draft for the old file");
    update({ doc: { ...REPO_DOC, repoPath: "docs/other.md" } });
    expect(field()).toHaveValue("Update docs/other.md");
    expect(submit()).toHaveTextContent("Commit");
    expect(submit()).not.toHaveAttribute("aria-disabled");
    act(() => void vi.advanceTimersByTime(5_000));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("a gist's first publication keeps Published while its owner control appears", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const unpublished: DocumentDto = { ...GIST_DOC, publishedAt: null };
    const { onOpenChange, update } = open({ doc: unpublished, onCommit: vi.fn(() => pending.promise) });
    expect(screen.queryByTestId("gist-auto-update-stub")).toBeNull();
    type("First gist publication");
    fireEvent.click(submit());
    await settle(() => pending.resolve());
    update({ doc: { ...GIST_DOC } });
    expect(screen.getByTestId("gist-auto-update-stub")).toBeInTheDocument();
    expect(submit()).toHaveTextContent("Published");
    expect(field()).toHaveValue("First gist publication");
    act(() => void vi.advanceTimersByTime(900));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("after a failed Enter in the field, Enter in the field and Enter on Commit each retry once", async () => {
    const onCommit = vi.fn<(message: string) => Promise<void>>(() => Promise.reject(new Error("Refused")));
    open({ onCommit });
    await settle(() => void pressEnterInField());
    expect(screen.getByRole("alert")).toHaveTextContent("Refused");
    expect(field()).toHaveFocus();
    await settle(() => void pressEnterInField());
    expect(onCommit).toHaveBeenCalledTimes(2);
    submit().focus();
    fireEvent.keyDown(submit(), { key: "Enter" });
    await settle(() => fireEvent.keyUp(submit(), { key: "Enter" }));
    expect(onCommit).toHaveBeenCalledTimes(3);
  });

  it("the close after Published uses the newest onOpenChange and is cancelled by an unmount", async () => {
    vi.useFakeTimers();
    const first = open({ onCommit: vi.fn(async () => undefined) });
    await settle(() => fireEvent.click(submit()));
    const newer = vi.fn<(open: boolean) => void>();
    first.update({ onOpenChange: newer });
    act(() => void vi.advanceTimersByTime(900));
    expect(first.onOpenChange).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledExactlyOnceWith(false);
    cleanup();

    const second = open({ onCommit: vi.fn(async () => undefined) });
    await settle(() => fireEvent.click(submit()));
    second.view.unmount();
    act(() => void vi.advanceTimersByTime(5_000));
    expect(second.onOpenChange).not.toHaveBeenCalled();
  });

  it("arrow keys, Home and End move between Cancel and Commit, stop at the ends and never land on Commit while it is off", async () => {
    const pending = deferred<void>();
    const { onCommit, onOpenChange } = open({ onCommit: vi.fn(() => pending.promise) });
    const press = (from: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
      from.focus();
      return fireEvent.keyDown(from, { key, ...init });
    };
    for (const key of ["ArrowRight", "ArrowDown", "End"]) {
      expect(press(cancel(), key)).toBe(false);
      expect(submit()).toHaveFocus();
    }
    for (const key of ["ArrowLeft", "ArrowUp", "Home"]) {
      expect(press(submit(), key)).toBe(false);
      expect(cancel()).toHaveFocus();
    }
    // The ends, a modified key and a key in the field are left alone.
    for (const key of ["ArrowLeft", "ArrowUp", "Home"]) expect(press(cancel(), key)).toBe(true);
    for (const key of ["ArrowRight", "ArrowDown", "End"]) expect(press(submit(), key)).toBe(true);
    expect(press(cancel(), "ArrowRight", { shiftKey: true })).toBe(true);
    expect(cancel()).toHaveFocus();
    // An arrow key that belongs to an IME composition is not navigation.
    expect(press(cancel(), "ArrowRight", { isComposing: true })).toBe(true);
    expect(cancel()).toHaveFocus();
    expect(press(field(), "ArrowRight")).toBe(true);
    expect(field()).toHaveFocus();
    expect(onCommit).not.toHaveBeenCalled();

    await settle(() => fireEvent.click(submit()));
    expect(press(cancel(), "ArrowRight")).toBe(true);
    expect(cancel()).toHaveFocus();
    expect(onOpenChange).not.toHaveBeenCalled();
    await settle(() => pending.resolve());
  });

  it("Enter on Cancel and on Commit acts when the key is released, and a repeat never acts", async () => {
    const { onCommit, onOpenChange } = open();
    // Repeats and a release that reach a button from a press that started elsewhere (the X, a menu).
    for (const button of [cancel(), submit()]) {
      button.focus();
      expect(fireEvent.keyDown(button, { key: "Enter", repeat: true })).toBe(false);
      fireEvent.keyUp(button, { key: "Enter" });
    }
    expect(onCommit).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();

    submit().focus();
    expect(fireEvent.keyDown(submit(), { key: "Enter" })).toBe(false);
    fireEvent.keyDown(submit(), { key: "Enter", repeat: true });
    expect(onCommit).not.toHaveBeenCalled();
    await settle(() => fireEvent.keyUp(submit(), { key: "Enter" }));
    expect(onCommit).toHaveBeenCalledOnce();

    cancel().focus();
    expect(fireEvent.keyDown(cancel(), { key: "Enter" })).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.keyUp(cancel(), { key: "Enter" });
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("Escape and the Close button ask to close, also while the request runs", async () => {
    const pending = deferred<void>();
    const { onOpenChange } = open({ onCommit: vi.fn(() => pending.promise) });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    fireEvent.click(submit());
    fireEvent.keyDown(submit(), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledTimes(3);
    expect(onOpenChange.mock.calls.every(([next]) => next === false)).toBe(true);
    await settle(() => pending.resolve());
  });
});
