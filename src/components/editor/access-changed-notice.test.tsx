// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessChange } from "@/editor/collab/session";
import { ACCESS_CHANGED_TITLE, ACCESS_UNSAVED_TEXT, AccessChangedNotice, QUIET_MS, accessChangedText } from "./access-changed-notice";

/**
 * Issue #2269: what the editor shell shows when the session has learned that the page's own access changed.
 */

const lowered = (role: AccessChange["role"] = "viewer", unsaved = false): AccessChange => ({ role, kind: "lowered", unsaved });
const removed = (unsaved = false): AccessChange => ({ role: null, kind: "removed", unsaved });
const raised = (role: AccessChange["role"] = "editor"): AccessChange => ({ role, kind: "raised", unsaved: false });

describe("the words", () => {
  it.each([
    [lowered("viewer"), "The owner changed your access to this document to Viewer. Reload to continue."],
    [lowered("commenter"), "The owner changed your access to this document to Commenter. Reload to continue."],
    // Lowered first and raised again since: the page stays blocked and names the role the server holds now.
    [lowered("editor"), "The owner changed your access to this document to Editor. Reload to continue."],
    [removed(), "You no longer have access to this document."],
    [raised("editor"), "You can now edit this document."],
    [raised("commenter"), "You can now comment on this document."],
  ])("%j", (change, text) => {
    expect(accessChangedText(change)).toBe(text);
    expect(ACCESS_CHANGED_TITLE).toBe("Your access changed");
    expect(ACCESS_UNSAVED_TEXT).toBe("Changes you made in the last moments were not saved.");
  });
});

describe.each([
  ["Strict Mode off", false],
  ["Strict Mode on", true],
])("the notice (%s)", (_name, strict) => {
  const discardLocal = vi.fn(async () => undefined);
  const onDocuments = vi.fn();
  const onReload = vi.fn();

  function show(change: AccessChange | null) {
    const ui = (next: AccessChange | null) => {
      const notice = <AccessChangedNotice change={next} discardLocal={discardLocal} onDocuments={onDocuments} onReload={onReload} />;
      return strict ? <StrictMode>{notice}</StrictMode> : notice;
    };
    const view = render(
      <>
        <textarea aria-label="editor" />
        {ui(change)}
      </>,
    );
    return {
      change: (next: AccessChange | null) =>
        view.rerender(
          <>
            <textarea aria-label="editor" />
            {ui(next)}
          </>,
        ),
    };
  }
  const button = () => screen.getByTestId("access-changed-action");
  const quiet = (ms = QUIET_MS) => act(() => void vi.advanceTimersByTime(ms));
  /** Lets the promises that are already settled run. */
  const settle = () => act(async () => void (await Promise.resolve()));
  const pressKey = (key: string) => {
    fireEvent.keyDown(button(), { key });
    fireEvent.keyUp(button(), { key });
  };
  const pointerClick = () => {
    fireEvent.pointerDown(button());
    fireEvent.mouseDown(button());
    fireEvent.pointerUp(button());
    fireEvent.mouseUp(button());
    fireEvent.click(button(), { detail: 1 });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    discardLocal.mockClear();
    onDocuments.mockClear();
    onReload.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("nothing to say: nothing is rendered", () => {
    show(null);
    expect(screen.queryByTestId("access-changed-dialog")).toBeNull();
    expect(screen.queryByTestId("access-raised-notice")).toBeNull();
    expect(discardLocal).not.toHaveBeenCalled();
  });

  describe("lowered", () => {
    it("a dialog with the title, the sentence, one button that has focus, and no way out but the button", async () => {
      show(lowered("commenter"));
      const dialog = screen.getByRole("dialog", { name: "Your access changed" });
      expect(dialog).toHaveAccessibleDescription("The owner changed your access to this document to Commenter. Reload to continue.");
      expect(screen.getAllByRole("button")).toEqual([button()]);
      expect(button()).toHaveTextContent("Reload");
      expect(button()).toHaveFocus();
      expect(screen.queryByTestId("access-changed-unsaved")).toBeNull();

      fireEvent.keyDown(document, { key: "Escape" });
      fireEvent.keyDown(button(), { key: "Escape" });
      fireEvent.pointerDown(document.body);
      fireEvent.mouseDown(document.body);
      fireEvent.click(document.body);
      await settle();
      expect(screen.getByTestId("access-changed-dialog")).toBeInTheDocument();
      expect(onReload).not.toHaveBeenCalled();
    });

    it("says that changes were not saved only when the session knows of some", () => {
      const view = show(lowered("viewer", true));
      expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
        "The owner changed your access to this document to Viewer. Reload to continue. Changes you made in the last moments were not saved.",
      );
      view.change(lowered("viewer", false));
      expect(screen.queryByTestId("access-changed-unsaved")).toBeNull();
    });

    it("a comment that was being written counts as unsaved work", () => {
      const panel = document.createElement("div");
      panel.setAttribute("data-testid", "comments-panel");
      const draft = document.createElement("textarea");
      draft.value = "half a comment";
      panel.append(draft);
      document.body.append(panel);
      try {
        show(lowered("viewer", false));
        expect(screen.getByTestId("access-changed-unsaved")).toHaveTextContent("Changes you made in the last moments were not saved.");
      } finally {
        panel.remove();
      }
    });

    it("an empty comment box does not", () => {
      const panel = document.createElement("div");
      panel.setAttribute("data-testid", "comments-panel");
      const empty = document.createElement("textarea");
      empty.value = "  \n";
      panel.append(empty);
      document.body.append(panel);
      try {
        show(lowered("viewer", false));
        expect(screen.queryByTestId("access-changed-unsaved")).toBeNull();
      } finally {
        panel.remove();
      }
    });

    it("the local copy is deleted once, and only when the dialog is on screen", async () => {
      const view = show(null);
      expect(discardLocal).not.toHaveBeenCalled();
      view.change(lowered());
      expect(screen.getByTestId("access-changed-dialog")).toBeInTheDocument();
      await settle();
      expect(discardLocal).toHaveBeenCalledTimes(1);
      view.change(lowered("commenter"));
      view.change(removed());
      await settle();
      expect(discardLocal).toHaveBeenCalledTimes(1);
    });

    it("the text follows the newest role, and a removal changes the button", () => {
      const view = show(lowered("viewer"));
      view.change(lowered("editor"));
      expect(screen.getByTestId("access-changed-text")).toHaveTextContent("The owner changed your access to this document to Editor. Reload to continue.");
      expect(button()).toHaveTextContent("Reload");
      view.change(removed());
      expect(screen.getByTestId("access-changed-text")).toHaveTextContent("You no longer have access to this document.");
      expect(button()).toHaveTextContent("Go to your documents");
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(button()).toHaveFocus();
    });

    it("focus that goes nowhere comes back to the button", async () => {
      show(lowered());
      act(() => button().blur());
      await settle();
      expect(button()).toHaveFocus();
    });
  });

  describe("the button acts only on a press that is meant for it", () => {
    it("not before the page has been quiet: a key, a click and a click without a pointer all do nothing", async () => {
      show(lowered());
      expect(button()).toHaveAttribute("data-armed", "false");
      expect(button()).toHaveAttribute("aria-disabled", "true");
      pressKey("Enter");
      pressKey(" ");
      pointerClick();
      fireEvent.click(button(), { detail: 0 });
      await settle();
      expect(onReload).not.toHaveBeenCalled();
    });

    it("every key and every pointer press starts the wait again, wherever it lands", () => {
      show(lowered());
      const editor = screen.getByLabelText("editor");
      for (const fire of [
        () => fireEvent.keyDown(editor, { key: "a" }),
        () => fireEvent.keyUp(editor, { key: "a" }),
        () => fireEvent.keyDown(button(), { key: "Enter", repeat: true }),
        () => fireEvent.pointerDown(button()),
        () => fireEvent.pointerUp(document.body),
        () => fireEvent.mouseDown(document.body),
        () => fireEvent.mouseUp(button()),
        () => fireEvent.touchStart(document.body, { touches: [{ clientX: 1, clientY: 1 }], changedTouches: [{ clientX: 1, clientY: 1 }] }),
        () => fireEvent.touchEnd(document.body, { touches: [], changedTouches: [{ clientX: 1, clientY: 1 }] }),
      ]) {
        quiet(QUIET_MS - 1);
        fire();
        expect(button()).toHaveAttribute("data-armed", "false");
      }
      quiet(QUIET_MS - 1);
      expect(button()).toHaveAttribute("data-armed", "false");
      quiet(1);
      expect(button()).toHaveAttribute("data-armed", "true");
      expect(button()).toHaveAttribute("aria-disabled", "false");
    });

    it("once armed it stays armed", () => {
      show(lowered());
      quiet();
      fireEvent.keyDown(button(), { key: "a" });
      fireEvent.pointerDown(document.body);
      expect(button()).toHaveAttribute("data-armed", "true");
    });

    it.each(["Enter", " "])("%j acts once, when it is released; its repeats do nothing and are cancelled", async (key) => {
      show(lowered());
      quiet();
      expect(fireEvent.keyDown(button(), { key }), "the keydown is cancelled, so the browser does not click").toBe(false);
      for (let i = 0; i < 5; i++) expect(fireEvent.keyDown(button(), { key, repeat: true })).toBe(false);
      await settle();
      expect(onReload).not.toHaveBeenCalled();
      expect(fireEvent.keyUp(button(), { key })).toBe(false);
      await settle();
      expect(onReload).toHaveBeenCalledTimes(1);
      fireEvent.keyUp(button(), { key });
      await settle();
      expect(onReload).toHaveBeenCalledTimes(1);
    });

    it.each(["Enter", " "])("a %j that was held before the button could act presses nothing when it is released later", async (key) => {
      show(lowered());
      // Held since before the dialog: only repeats reach the button, and they keep it unarmed.
      for (let i = 0; i < 40; i++) {
        quiet(30);
        fireEvent.keyDown(button(), { key, repeat: true });
      }
      fireEvent.keyUp(button(), { key });
      quiet();
      expect(button()).toHaveAttribute("data-armed", "true");
      await settle();
      expect(onReload).not.toHaveBeenCalled();
    });

    it("a release without its press on the button, a press that ends elsewhere, and a press with Ctrl, Alt or Meta do nothing", async () => {
      show(lowered());
      quiet();
      fireEvent.keyUp(button(), { key: "Enter" });
      fireEvent.keyDown(button(), { key: "Enter" });
      act(() => button().blur());
      fireEvent.keyUp(button(), { key: "Enter" });
      fireEvent.keyDown(button(), { key: "Enter" });
      fireEvent.keyUp(button(), { key: " " });
      for (const modifier of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
        fireEvent.keyDown(button(), { key: "Enter", ...modifier });
        fireEvent.keyUp(button(), { key: "Enter", ...modifier });
      }
      await settle();
      expect(onReload).not.toHaveBeenCalled();
    });

    it("a pointer click acts when the pointer went down on the button; a click that only ends on it (a drag, the rest of a gesture) does not", async () => {
      show(lowered());
      quiet();
      fireEvent.click(button(), { detail: 1 });
      await settle();
      expect(onReload).not.toHaveBeenCalled();
      pointerClick();
      await settle();
      expect(onReload).toHaveBeenCalledTimes(1);
    });

    it("a click without a pointer (a screen reader, voice control) acts", async () => {
      show(lowered());
      quiet();
      fireEvent.click(button(), { detail: 0 });
      await settle();
      expect(onReload).toHaveBeenCalledTimes(1);
    });
  });

  describe("leaving", () => {
    it("Reload waits until the local copy is gone", async () => {
      let gone!: () => void;
      discardLocal.mockImplementationOnce(() => new Promise<undefined>((resolve) => (gone = () => resolve(undefined))));
      show(lowered());
      quiet();
      pressKey("Enter");
      await settle();
      expect(onReload).not.toHaveBeenCalled();
      gone();
      await settle();
      await settle();
      expect(onReload).toHaveBeenCalledTimes(1);
    });

    it("but not for ever, and not when deleting fails", async () => {
      discardLocal.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
      show(lowered());
      quiet();
      pressKey("Enter");
      await settle();
      expect(onReload).not.toHaveBeenCalled();
      await act(async () => void (await vi.advanceTimersByTimeAsync(2_000)));
      expect(onReload).toHaveBeenCalledTimes(1);

      cleanup();
      onReload.mockClear();
      discardLocal.mockImplementationOnce(async () => {
        throw new Error("IndexedDB is gone");
      });
      show(lowered());
      quiet();
      pressKey("Enter");
      await settle();
      await settle();
      expect(onReload).toHaveBeenCalledTimes(1);
    });

    it("removed: the button leads to the documents, never to a reload", async () => {
      show(removed(true));
      expect(screen.getByRole("dialog")).toHaveAccessibleDescription("You no longer have access to this document. Changes you made in the last moments were not saved.");
      expect(button()).toHaveTextContent("Go to your documents");
      await settle();
      expect(discardLocal).toHaveBeenCalledTimes(1);
      quiet();
      pressKey("Enter");
      await settle();
      await settle();
      expect(onDocuments).toHaveBeenCalledTimes(1);
      expect(onReload).not.toHaveBeenCalled();
    });
  });

  describe("raised", () => {
    it("a quiet bar: no dialog, focus stays where it was, nothing is deleted", async () => {
      const view = show(null);
      const editor = screen.getByLabelText("editor");
      editor.focus();
      view.change(raised("editor"));
      const bar = screen.getByRole("status");
      expect(bar).toHaveTextContent("You can now edit this document.");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(editor).toHaveFocus();
      expect(button()).toHaveTextContent("Reload");
      await settle();
      expect(discardLocal).not.toHaveBeenCalled();
      view.change(raised("commenter"));
      expect(screen.getByRole("status")).toHaveTextContent("You can now comment on this document.");
    });

    it("its Reload is guarded the same way, then reloads at once", async () => {
      show(raised());
      pointerClick();
      await settle();
      expect(onReload).not.toHaveBeenCalled();
      quiet();
      pointerClick();
      expect(onReload).toHaveBeenCalledTimes(1);
    });

    it("goes away when there is nothing to say any more, and a lowering after it brings the dialog with a button that is not armed yet", () => {
      const view = show(raised());
      quiet();
      expect(button()).toHaveAttribute("data-armed", "true");
      view.change(null);
      expect(screen.queryByRole("status")).toBeNull();
      view.change(raised());
      view.change(lowered());
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(button()).toHaveAttribute("data-armed", "false");
    });
  });
});
