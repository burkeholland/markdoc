// @vitest-environment jsdom
import { StrictMode, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollabSession } from "@/editor/collab/session";
import { EMPTY_FORMAT, type EditorActions, type FormatState } from "./actions";
import { Toolbar, useEnterOnRelease, usePickOnRelease, usePlaceHold } from "./toolbar";

// Tooltips need a provider and are not what these tests cover; the Text style menu is the real Radix menu.
vi.mock("@/components/ui/primitives", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/primitives")>()),
  Tip: ({ children }: { children: ReactNode }) => children,
}));

class FakeSession {
  version = 0;
  canEdit = true;
  canUndo = true;
  canRedo = true;
  canComment = true;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Change permissions and tell subscribers, like a real role or history change. */
  publish(patch: Partial<Pick<FakeSession, "canEdit" | "canUndo" | "canRedo" | "canComment">>) {
    Object.assign(this, patch);
    this.version++;
    act(() => {
      for (const listener of this.listeners) listener();
    });
  }
}

function setup({
  strict = false,
  session = new FakeSession(),
  format = EMPTY_FORMAT,
}: { strict?: boolean; session?: FakeSession; format?: FormatState } = {}) {
  const actions = {
    focus: vi.fn(),
    setHeading: vi.fn(),
    toggleMark: vi.fn(),
    openLinkDialog: vi.fn(),
    toggleCodeBlock: vi.fn(),
    toggleList: vi.fn(),
    toggleQuote: vi.fn(),
    horizontalRule: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const onComment = vi.fn();
  const onImage = vi.fn();
  const onTable = vi.fn();
  const toolbar = (
    <Toolbar
      session={session as unknown as CollabSession}
      actions={actions as unknown as EditorActions}
      format={format}
      onComment={onComment}
      onImage={onImage}
      onTable={onTable}
    />
  );
  const result = render(strict ? <StrictMode>{toolbar}</StrictMode> : toolbar);
  return { ...result, session, actions, onComment, onImage, onTable };
}

const button = (name: string) => screen.getByRole("button", { name });
const heading = () => screen.getByTestId("heading-menu");
// The checked item's name starts with its check mark.
const radio = (name: string) => screen.getByRole("menuitemradio", { name: new RegExp(`${name}$`) });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Toolbar actions", () => {
  it.each([
    ["Bold", (a: ReturnType<typeof setup>) => expect(a.actions.toggleMark).toHaveBeenCalledExactlyOnceWith("strong")],
    ["Italic", (a: ReturnType<typeof setup>) => expect(a.actions.toggleMark).toHaveBeenCalledExactlyOnceWith("em")],
    ["Strikethrough", (a: ReturnType<typeof setup>) => expect(a.actions.toggleMark).toHaveBeenCalledExactlyOnceWith("strike")],
    ["Link", (a: ReturnType<typeof setup>) => expect(a.actions.openLinkDialog).toHaveBeenCalledOnce()],
    ["Inline code", (a: ReturnType<typeof setup>) => expect(a.actions.toggleMark).toHaveBeenCalledExactlyOnceWith("code")],
    ["Code block", (a: ReturnType<typeof setup>) => expect(a.actions.toggleCodeBlock).toHaveBeenCalledOnce()],
    ["Bulleted list", (a: ReturnType<typeof setup>) => expect(a.actions.toggleList).toHaveBeenCalledExactlyOnceWith("bullet")],
    ["Numbered list", (a: ReturnType<typeof setup>) => expect(a.actions.toggleList).toHaveBeenCalledExactlyOnceWith("ordered")],
    ["Task list", (a: ReturnType<typeof setup>) => expect(a.actions.toggleList).toHaveBeenCalledExactlyOnceWith("task")],
    ["Quote", (a: ReturnType<typeof setup>) => expect(a.actions.toggleQuote).toHaveBeenCalledOnce()],
    ["Image", (a: ReturnType<typeof setup>) => expect(a.onImage).toHaveBeenCalledOnce()],
    ["Table", (a: ReturnType<typeof setup>) => expect(a.onTable).toHaveBeenCalledOnce()],
    ["Horizontal rule", (a: ReturnType<typeof setup>) => expect(a.actions.horizontalRule).toHaveBeenCalledOnce()],
    ["Undo", (a: ReturnType<typeof setup>) => expect(a.actions.undo).toHaveBeenCalledOnce()],
    ["Redo", (a: ReturnType<typeof setup>) => expect(a.actions.redo).toHaveBeenCalledOnce()],
    ["Add comment", (a: ReturnType<typeof setup>) => expect(a.onComment).toHaveBeenCalledOnce()],
  ])("%s runs its action once per click, Enter and Space, in Strict Mode too", async (name, check) => {
    for (const strict of [false, true]) {
      for (const input of ["click", "{Enter}", " "] as const) {
        const t = setup({ strict });
        const target = name === "Add comment" ? screen.getByTestId("tb-comment") : button(name);
        if (input === "click") await userEvent.click(target);
        else {
          act(() => target.focus());
          await userEvent.keyboard(input);
        }
        check(t);
        cleanup();
        vi.clearAllMocks();
      }
    }
  });

  it("keeps the editor selection: mousedown on a button is prevented", () => {
    setup();
    for (const target of [button("Bold"), heading(), screen.getByTestId("tb-comment")]) {
      expect(fireEvent.mouseDown(target)).toBe(false);
    }
  });

  it("disables editing buttons for read-only users and hides Comment without comment rights", () => {
    const session = new FakeSession();
    Object.assign(session, { canEdit: false, canComment: false });
    setup({ session });
    for (const b of screen.getAllByRole("button")) expect(b).toBeDisabled();
    expect(screen.queryByTestId("tb-comment")).toBeNull();
  });

  it("lets a commenter comment but not edit", async () => {
    const session = new FakeSession();
    Object.assign(session, { canEdit: false, canComment: true });
    const t = setup({ session });
    expect(button("Bold")).toBeDisabled();
    expect(heading()).toBeDisabled();
    await userEvent.click(screen.getByTestId("tb-comment"));
    expect(t.onComment).toHaveBeenCalledOnce();
  });

  it("updates disabled state when permissions change", () => {
    const t = setup();
    expect(button("Undo")).toBeEnabled();
    expect(button("Undo")).not.toHaveAttribute("aria-disabled");
    t.session.publish({ canUndo: false, canRedo: false });
    // Nothing to undo or redo: off, but still real buttons (see the next test).
    expect(button("Undo")).toHaveAttribute("aria-disabled", "true");
    expect(button("Redo")).toHaveAttribute("aria-disabled", "true");
    expect(button("Undo")).toBeEnabled();
    t.session.publish({ canEdit: false });
    expect(button("Bold")).toBeDisabled();
    expect(button("Undo")).toBeDisabled();
    expect(button("Undo")).not.toHaveAttribute("aria-disabled");
    t.session.publish({ canEdit: true, canUndo: true });
    expect(button("Bold")).toBeEnabled();
    expect(button("Undo")).toBeEnabled();
    expect(button("Undo")).not.toHaveAttribute("aria-disabled");
  });

  it("an Undo with nothing to undo keeps the editor's focus on a click and does nothing on a click or a key", async () => {
    const session = new FakeSession();
    Object.assign(session, { canUndo: false, canRedo: false });
    const t = setup({ session });
    for (const name of ["Undo", "Redo"]) {
      expect(fireEvent.mouseDown(button(name)), "mousedown is still cancelled").toBe(false);
      await userEvent.click(button(name));
      act(() => button(name).focus());
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard(" ");
    }
    expect(t.actions.undo).not.toHaveBeenCalled();
    expect(t.actions.redo).not.toHaveBeenCalled();
  });

  it("gives the caret back to the editor when the focused button is disabled", () => {
    const t = setup();
    act(() => button("Bold").focus());
    t.session.publish({ canUndo: false });
    expect(t.actions.focus).not.toHaveBeenCalled();
    t.session.publish({ canEdit: false });
    expect(t.actions.focus).toHaveBeenCalledOnce();
  });

  it("Enter acts once, on release, however long it is held; Ctrl, Alt and Meta+Enter do nothing", () => {
    for (const strict of [false, true]) {
      const t = setup({ strict });
      const bold = button("Bold");
      act(() => bold.focus());
      expect(fireEvent.keyDown(bold, { key: "Enter" })).toBe(false);
      for (let i = 0; i < 5; i++) expect(fireEvent.keyDown(bold, { key: "Enter", repeat: true })).toBe(false);
      expect(t.actions.toggleMark).not.toHaveBeenCalled();
      fireEvent.keyUp(bold, { key: "Enter" });
      expect(t.actions.toggleMark).toHaveBeenCalledExactlyOnceWith("strong");

      for (const modifier of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
        fireEvent.keyDown(bold, { key: "Enter", ...modifier });
        fireEvent.keyUp(bold, { key: "Enter", ...modifier });
      }
      // Enter that went down on another button, and a release after focus left.
      fireEvent.keyDown(bold, { key: "Enter" });
      act(() => button("Italic").focus());
      fireEvent.keyUp(button("Italic"), { key: "Enter" });
      expect(t.actions.toggleMark).toHaveBeenCalledOnce();
      cleanup();
      vi.clearAllMocks();
    }
  });

  it.each([
    ["Bold", { canEdit: false }, (t: ReturnType<typeof setup>) => t.actions.toggleMark],
    ["Image", { canEdit: false }, (t: ReturnType<typeof setup>) => t.onImage],
    ["Table", { canEdit: false }, (t: ReturnType<typeof setup>) => t.onTable],
    ["Undo", { canUndo: false }, (t: ReturnType<typeof setup>) => t.actions.undo],
    ["Undo", { canEdit: false }, (t: ReturnType<typeof setup>) => t.actions.undo],
    ["Redo", { canRedo: false }, (t: ReturnType<typeof setup>) => t.actions.redo],
    ["Add comment", { canComment: false }, (t: ReturnType<typeof setup>) => t.onComment],
  ])("checks permission at click time: %s does nothing after %o lands before the re-render", (name, revoke, spy) => {
    const t = setup();
    // Change the session without notifying, so the button is still rendered enabled.
    Object.assign(t.session, revoke);
    const target = name === "Add comment" ? screen.getByTestId("tb-comment") : button(name);
    expect(target).toBeEnabled();
    fireEvent.click(target);
    expect(spy(t)).not.toHaveBeenCalled();
  });
});

describe("Toolbar roving focus", () => {
  it("is one tab stop and moves with arrows (held too), Home and End, wrapping and skipping disabled buttons", async () => {
    const session = new FakeSession();
    Object.assign(session, { canUndo: false, canRedo: false });
    setup({ session });
    const stops = screen.getAllByRole("button").filter((b) => b.tabIndex === 0);
    expect(stops).toEqual([heading()]);

    await userEvent.tab();
    expect(heading()).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(button("Bold")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight>3/}");
    expect(button("Link")).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByTestId("tb-comment")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(heading()).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByTestId("tb-comment")).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(button("Horizontal rule")).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(heading()).toHaveFocus();
  });

  it("returns Tab to the last-used button", async () => {
    render(<button type="button">Before</button>);
    setup();
    await userEvent.tab();
    await userEvent.tab();
    expect(heading()).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(button("Italic")).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(button("Before")).toHaveFocus();
    await userEvent.tab();
    expect(button("Italic")).toHaveFocus();
    expect(screen.getAllByRole("button").filter((b) => b.tabIndex === 0)).toEqual([button("Before"), button("Italic")]);
  });

  it("moves the tab stop off a button that becomes disabled", () => {
    const t = setup();
    act(() => button("Undo").focus());
    expect(button("Undo").tabIndex).toBe(0);
    t.session.publish({ canUndo: false });
    expect(button("Undo").tabIndex).toBe(-1);
    expect(heading().tabIndex).toBe(0);
  });

  it("keeps focus on an Undo that switches off under it, and the arrows move on from its place", async () => {
    const t = setup();
    act(() => button("Undo").focus());
    t.session.publish({ canUndo: false });
    expect(button("Undo")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(button("Redo")).toHaveFocus();
    act(() => button("Undo").focus());
    await userEvent.keyboard("{ArrowLeft}");
    expect(button("Horizontal rule")).toHaveFocus();

    t.session.publish({ canRedo: false });
    act(() => button("Redo").focus());
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByTestId("tb-comment")).toHaveFocus();
    act(() => button("Redo").focus());
    await userEvent.keyboard("{Home}");
    expect(heading()).toHaveFocus();
  });

  it.each([
    { key: "ArrowRight", altKey: true },
    { key: "ArrowRight", ctrlKey: true },
    { key: "ArrowRight", metaKey: true },
    { key: "ArrowRight", shiftKey: true },
    { key: "ArrowRight", isComposing: true },
    { key: "a" },
  ])("ignores %o", (init) => {
    setup();
    act(() => button("Bold").focus());
    expect(fireEvent.keyDown(button("Bold"), init)).toBe(true);
    expect(button("Bold")).toHaveFocus();
  });

  it("ignores a key another handler already handled", () => {
    setup();
    act(() => button("Bold").focus());
    button("Bold").addEventListener("keydown", (e) => e.preventDefault(), { once: true });
    fireEvent.keyDown(button("Bold"), { key: "ArrowRight" });
    expect(button("Bold")).toHaveFocus();
  });
});

describe("Toolbar Text style menu", () => {
  it("opens with a click and runs the picked style once, then gives the caret back to the editor", async () => {
    for (const strict of [false, true]) {
      const t = setup({ strict });
      await userEvent.click(heading());
      await userEvent.click(await screen.findByRole("menuitemradio", { name: "Heading 2" }));
      expect(t.actions.setHeading).toHaveBeenCalledExactlyOnceWith(2);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(t.actions.focus).toHaveBeenCalled();
      expect(heading()).not.toHaveFocus();
      cleanup();
      vi.clearAllMocks();
    }
  });

  it("opens on Enter, Space and ArrowDown at the first item and picks with Enter", async () => {
    for (const key of ["{Enter}", " ", "{ArrowDown}"]) {
      const t = setup();
      act(() => heading().focus());
      await userEvent.keyboard(key);
      await waitFor(() => expect(radio("Paragraph")).toHaveFocus());
      await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
      expect(t.actions.setHeading).toHaveBeenCalledExactlyOnceWith(2);
      cleanup();
      vi.clearAllMocks();
    }
  });

  it("opens on ArrowUp at the last item", async () => {
    const t = setup();
    act(() => heading().focus());
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(radio("Heading 6")).toHaveFocus());
    await userEvent.keyboard("{ArrowUp}{Enter}");
    expect(t.actions.setHeading).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("keeps arrow keys inside the open menu instead of moving the toolbar", async () => {
    setup();
    act(() => heading().focus());
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(radio("Paragraph")).toHaveFocus());
    await userEvent.keyboard("{ArrowRight}{End}");
    expect(radio("Heading 6")).toHaveFocus();
    // The open modal menu hides the rest of the page from the accessibility tree.
    expect(screen.getByRole("button", { name: "Bold", hidden: true })).not.toHaveFocus();
  });

  it("closes on Escape and the first toolbar action after it runs", async () => {
    const t = setup();
    await userEvent.click(heading());
    await screen.findByRole("menu");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(t.actions.focus).toHaveBeenCalled();
    await userEvent.click(button("Bold"));
    expect(t.actions.toggleMark).toHaveBeenCalledExactlyOnceWith("strong");
  });

  it("does not open or pick a style once editing is revoked, even before the re-render", async () => {
    const t = setup();
    act(() => heading().focus());
    Object.assign(t.session, { canEdit: false });
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(heading());
    expect(screen.queryByRole("menu")).toBeNull();

    Object.assign(t.session, { canEdit: true });
    await userEvent.click(heading());
    const item = await screen.findByRole("menuitemradio", { name: "Heading 1" });
    Object.assign(t.session, { canEdit: false });
    await userEvent.click(item);
    expect(t.actions.setHeading).not.toHaveBeenCalled();
  });

  it("shows the current heading level in a place that is always there", () => {
    const level = () => heading().querySelector("span");
    const plain = setup();
    expect(level()).toBeEmptyDOMElement();
    const className = level()!.className;
    plain.unmount();
    setup({ format: { ...EMPTY_FORMAT, heading: 3 } });
    expect(heading()).toHaveTextContent("3");
    expect(level()!.className).toBe(className);
  });

  it("a held Enter, Space or arrow opens the menu once and picks nothing", async () => {
    for (const key of ["Enter", " ", "ArrowDown"]) {
      const t = setup();
      act(() => heading().focus());
      fireEvent.keyDown(heading(), { key });
      await waitFor(() => expect(radio("Paragraph")).toHaveFocus());
      // The repeats that still reach the trigger do not close the menu again.
      for (let i = 0; i < 3; i++) expect(fireEvent.keyDown(heading(), { key, repeat: true })).toBe(false);
      expect(screen.getByRole("menu")).toBeInTheDocument();
      if (key !== "ArrowDown") {
        // The ones that reach the first item, and the release there, pick nothing.
        for (let i = 0; i < 3; i++) fireEvent.keyDown(radio("Paragraph"), { key, repeat: true });
        fireEvent.keyUp(radio("Paragraph"), { key });
        expect(screen.getByRole("menu")).toBeInTheDocument();
      }
      expect(t.actions.setHeading).not.toHaveBeenCalled();
      cleanup();
      vi.clearAllMocks();
    }
  });

  it.each(["Enter", " "])("picks an item once when %o is released, however long it is held", async (key) => {
    const t = setup();
    await userEvent.click(heading());
    const item = await screen.findByRole("menuitemradio", { name: "Heading 2" });
    act(() => item.focus());
    fireEvent.keyDown(item, { key });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(item, { key, repeat: true });
    expect(t.actions.setHeading).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyUp(item, { key });
    expect(t.actions.setHeading).toHaveBeenCalledExactlyOnceWith(2);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("still finds an item by its typed name, space included, without picking it", async () => {
    const t = setup();
    act(() => heading().focus());
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(radio("Paragraph")).toHaveFocus());
    await userEvent.keyboard("heading 3");
    await waitFor(() => expect(radio("Heading 3")).toHaveFocus());
    expect(t.actions.setHeading).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("picks an item on a click that comes with no key or pointer, as a screen reader sends", async () => {
    const t = setup();
    await userEvent.click(heading());
    act(() => screen.getByRole("menuitemradio", { name: "Heading 4" }).click());
    expect(t.actions.setHeading).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("keeps the menu's place after a pointer pick, and not after a keyboard pick", async () => {
    const t = setup();
    await userEvent.click(heading());
    const menu = await screen.findByRole("menu");
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(new DOMRect(12, 60, 224, 280));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Heading 2" }));
    expect(t.actions.setHeading).toHaveBeenCalledExactlyOnceWith(2);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const box = screen.getByTestId("place-hold");
    expect(box).toHaveStyle({ left: "12px", top: "60px", width: "224px", height: "280px" });
    expect(fireEvent.mouseDown(box)).toBe(false);
    fireEvent.click(box, { detail: 2 });
    expect(t.actions.setHeading).toHaveBeenCalledOnce();

    // Opening the menu again takes the box away; a keyboard pick leaves none.
    act(() => heading().focus());
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(radio("Paragraph")).toHaveFocus());
    expect(screen.queryByTestId("place-hold")).toBeNull();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(t.actions.setHeading).toHaveBeenLastCalledWith(1);
    expect(screen.queryByTestId("place-hold")).toBeNull();
  });
});

function Buttons({ onA, onB }: { onA: () => void; onB: () => void }) {
  const enter = useEnterOnRelease();
  return (
    <>
      <div data-testid="bar" onKeyDown={enter.onKeyDown} onKeyUp={enter.onKeyUp} onBlur={enter.onBlur}>
        <button type="button" onClick={onA}>
          A
        </button>
        <button type="button" onClick={onB}>
          B
        </button>
        <span tabIndex={0}>not a button</span>
      </div>
      <button type="button">outside</button>
    </>
  );
}

function setupButtons(strict = false) {
  const onA = vi.fn();
  const onB = vi.fn();
  render(strict ? <StrictMode><Buttons onA={onA} onB={onB} /></StrictMode> : <Buttons onA={onA} onB={onB} />);
  const a = screen.getByRole("button", { name: "A" });
  const b = screen.getByRole("button", { name: "B" });
  return { onA, onB, a, b };
}

describe("useEnterOnRelease", () => {
  it("clicks once when Enter is released, however long it was held, in Strict Mode too", () => {
    for (const strict of [false, true]) {
      const { onA, a } = setupButtons(strict);
      act(() => a.focus());
      expect(fireEvent.keyDown(a, { key: "Enter" }), "the keydown is cancelled, so the browser does not click").toBe(false);
      for (let i = 0; i < 5; i++) expect(fireEvent.keyDown(a, { key: "Enter", repeat: true })).toBe(false);
      expect(onA).not.toHaveBeenCalled();
      fireEvent.keyUp(a, { key: "Enter" });
      expect(onA).toHaveBeenCalledOnce();
      fireEvent.keyUp(a, { key: "Enter" });
      expect(onA).toHaveBeenCalledOnce();
      cleanup();
    }
  });

  it("works with a real key press, and with Shift held", async () => {
    const { onA, a } = setupButtons();
    act(() => a.focus());
    await userEvent.keyboard("{Enter}");
    expect(onA).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onA).toHaveBeenCalledTimes(2);
  });

  it("does nothing when Enter went down somewhere else", () => {
    const { onA, onB, a, b } = setupButtons();
    act(() => a.focus());
    fireEvent.keyUp(a, { key: "Enter" });
    expect(onA).not.toHaveBeenCalled();

    // Down on A, released on B.
    fireEvent.keyDown(a, { key: "Enter" });
    act(() => b.focus());
    fireEvent.keyUp(b, { key: "Enter" });
    expect(onA).not.toHaveBeenCalled();
    expect(onB).not.toHaveBeenCalled();

    // A press that began as a repeat (the key was already down when focus arrived).
    fireEvent.keyDown(b, { key: "Enter", repeat: true });
    fireEvent.keyUp(b, { key: "Enter" });
    expect(onB).not.toHaveBeenCalled();
  });

  it("does nothing when focus left the button before the release, even if it came back", () => {
    const { onA, a } = setupButtons();
    act(() => a.focus());
    fireEvent.keyDown(a, { key: "Enter" });
    act(() => screen.getByRole("button", { name: "outside" }).focus());
    fireEvent.keyUp(screen.getByRole("button", { name: "outside" }), { key: "Enter" });
    expect(onA).not.toHaveBeenCalled();

    act(() => a.focus());
    fireEvent.keyDown(a, { key: "Enter" });
    act(() => screen.getByRole("button", { name: "outside" }).focus());
    act(() => a.focus());
    fireEvent.keyUp(a, { key: "Enter" });
    expect(onA).not.toHaveBeenCalled();
  });

  it.each([{ ctrlKey: true }, { altKey: true }, { metaKey: true }])("does nothing for Enter with %o", (modifier) => {
    const { onA, a } = setupButtons();
    act(() => a.focus());
    expect(fireEvent.keyDown(a, { key: "Enter", ...modifier })).toBe(false);
    fireEvent.keyUp(a, { key: "Enter", ...modifier });
    expect(onA).not.toHaveBeenCalled();
  });

  it("leaves other keys, other elements, handled keys and IME composition alone", () => {
    const { onA, a } = setupButtons();
    act(() => a.focus());
    expect(fireEvent.keyDown(a, { key: " " })).toBe(true);
    expect(fireEvent.keyDown(a, { key: "ArrowRight" })).toBe(true);
    expect(fireEvent.keyDown(a, { key: "Enter", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(screen.getByText("not a button"), { key: "Enter" })).toBe(true);
    a.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    fireEvent.keyDown(a, { key: "Enter" });
    fireEvent.keyUp(a, { key: "Enter" });
    expect(onA).not.toHaveBeenCalled();
  });

  it("does not touch a click that comes with no key, as a screen reader or voice control sends", () => {
    const { onA, a } = setupButtons();
    fireEvent.click(a, { detail: 0 });
    a.click();
    expect(onA).toHaveBeenCalledTimes(2);
  });

  it("does not click a button that was disabled while the key was down", () => {
    const { onA, a } = setupButtons();
    act(() => a.focus());
    fireEvent.keyDown(a, { key: "Enter" });
    (a as HTMLButtonElement).disabled = true;
    fireEvent.keyUp(a, { key: "Enter" });
    expect(onA).not.toHaveBeenCalled();
  });
});

function Items({ onPick }: { onPick: (name: string) => void }) {
  const pick = usePickOnRelease();
  return (
    <div role="menu">
      {["One", "Two"].map((name) => (
        <div key={name} role="menuitem" tabIndex={-1} onKeyDown={pick.onKeyDown} onKeyUp={pick.onKeyUp} onBlur={pick.onBlur} onClick={() => onPick(name)}>
          <span tabIndex={-1}>{name}</span>
        </div>
      ))}
    </div>
  );
}

describe("usePickOnRelease", () => {
  const setupItems = () => {
    const onPick = vi.fn();
    render(<Items onPick={onPick} />);
    const [one, two] = screen.getAllByRole("menuitem");
    return { onPick, one, two };
  };

  it.each(["Enter", " "])("picks once when %o is released, however long it was held", (key) => {
    const { onPick, one } = setupItems();
    act(() => one.focus());
    expect(fireEvent.keyDown(one, { key })).toBe(false);
    for (let i = 0; i < 5; i++) expect(fireEvent.keyDown(one, { key, repeat: true })).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyUp(one, { key });
    expect(onPick).toHaveBeenCalledExactlyOnceWith("One");
  });

  it("picks nothing for a key that was already down when focus reached the item", () => {
    const { onPick, one } = setupItems();
    act(() => one.focus());
    // The menu was opened with this key: the item only sees its repeats and its release.
    expect(fireEvent.keyDown(one, { key: "Enter", repeat: true })).toBe(false);
    fireEvent.keyUp(one, { key: "Enter" });
    fireEvent.keyUp(one, { key: " " });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("picks nothing when the key is released on another item, or after focus left", () => {
    const { onPick, one, two } = setupItems();
    act(() => one.focus());
    fireEvent.keyDown(one, { key: "Enter" });
    act(() => two.focus());
    fireEvent.keyUp(two, { key: "Enter" });
    fireEvent.keyDown(one, { key: " " });
    fireEvent.keyUp(one, { key: "Enter" });
    fireEvent.keyUp(one, { key: " " });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("leaves a space typed as part of an item's name to the menu's own search", () => {
    const { onPick, one } = setupItems();
    act(() => one.focus());
    expect(fireEvent.keyDown(one, { key: "t" })).toBe(true);
    expect(fireEvent.keyDown(one, { key: " " }), "the space is not cancelled").toBe(true);
    fireEvent.keyUp(one, { key: " " });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("leaves keys from inside an item and handled keys alone", () => {
    const { onPick, one } = setupItems();
    expect(fireEvent.keyDown(screen.getByText("One"), { key: "Enter" })).toBe(true);
    fireEvent.keyUp(screen.getByText("One"), { key: "Enter" });
    one.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    fireEvent.keyDown(one, { key: "Enter" });
    fireEvent.keyUp(one, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });
});

function Hold({ onAction }: { onAction: () => void }) {
  const [open, setOpen] = useState(true);
  const hold = usePlaceHold(!open);
  return (
    <>
      {open && (
        <div data-testid="control">
          <button
            type="button"
            onClick={(event) => {
              hold.arm(event, event.currentTarget.parentElement);
              onAction();
              setOpen(false);
            }}
          >
            close
          </button>
          <button type="button" onClick={(event) => hold.arm(event, event.currentTarget.parentElement)}>
            stay
          </button>
        </div>
      )}
      <button type="button" onClick={() => setOpen(true)}>
        reopen
      </button>
      <button type="button" data-testid="hide" onClick={() => setOpen(false)}>
        hide
      </button>
      {hold.shield}
    </>
  );
}

describe("usePlaceHold", () => {
  const BOX = { left: 40, top: 60, width: 200, height: 32 };
  const setupHold = () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ ...BOX, right: 240, bottom: 92, x: 40, y: 60, toJSON: () => BOX } as DOMRect);
    const onAction = vi.fn();
    const view = render(<Hold onAction={onAction} />);
    return { onAction, ...view };
  };
  const shield = () => screen.queryByTestId("place-hold");
  const pointerClose = () => fireEvent.click(screen.getByRole("button", { name: "close" }), { detail: 1 });

  it("puts an empty box where the control was after a pointer click removed it, and takes it away 600 ms later", () => {
    setupHold();
    pointerClose();
    const box = shield()!;
    expect(box).not.toBeNull();
    expect(box).toHaveStyle({ position: "fixed", left: "40px", top: "60px", width: "200px", height: "32px" });
    expect(box).toBeEmptyDOMElement();
    expect(box).toHaveAttribute("aria-hidden", "true");
    expect(box).not.toHaveAttribute("tabindex");
    expect(box.tabIndex).toBe(-1);
    act(() => vi.advanceTimersByTime(599));
    expect(shield()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(shield()).toBeNull();
  });

  it("cancels the box's own mousedown, so focus and selection stay, and keeps its press from the page", () => {
    setupHold();
    const onDocument = vi.fn();
    document.addEventListener("pointerdown", onDocument);
    try {
      pointerClose();
      expect(fireEvent.mouseDown(shield()!)).toBe(false);
      fireEvent.pointerDown(shield()!);
      expect(onDocument, "a layer that closes on an outside press does not hear it").not.toHaveBeenCalled();
      expect(shield()).not.toBeNull();
      fireEvent.pointerDown(document.body);
      expect(onDocument).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener("pointerdown", onDocument);
    }
  });

  it("never arms on a click from the keyboard or from assistive technology", () => {
    const { onAction } = setupHold();
    fireEvent.click(screen.getByRole("button", { name: "close" }), { detail: 0 });
    expect(onAction).toHaveBeenCalledOnce();
    expect(shield()).toBeNull();
  });

  it("shows nothing while the control is still there, and forgets the click after 600 ms", () => {
    setupHold();
    fireEvent.click(screen.getByRole("button", { name: "stay" }), { detail: 1 });
    expect(shield()).toBeNull();
    act(() => vi.advanceTimersByTime(600));
    fireEvent.click(screen.getByTestId("hide"), { detail: 0 });
    expect(shield()).toBeNull();
  });

  it("stays while a pointer is pressed on it, for 600 ms after the release, and at most 10 s", () => {
    setupHold();
    pointerClose();
    act(() => vi.advanceTimersByTime(400));
    fireEvent.pointerDown(shield()!);
    act(() => vi.advanceTimersByTime(5_000));
    expect(shield(), "a press that is still down keeps it").not.toBeNull();
    // A touch fires pointerleave right after pointerup; neither that nor pointerout ends the hold early.
    fireEvent.pointerUp(shield()!);
    fireEvent.pointerLeave(shield()!);
    fireEvent.pointerOut(shield()!);
    act(() => vi.advanceTimersByTime(599));
    expect(shield()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(shield()).toBeNull();

    act(() => screen.getByRole("button", { name: "reopen" }).click());
    pointerClose();
    fireEvent.pointerDown(shield()!);
    act(() => vi.advanceTimersByTime(9_999));
    expect(shield()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(shield(), "the cap for a press that never ends").toBeNull();
  });

  it("a press that ends outside the box, or is cancelled, still ends", () => {
    setupHold();
    pointerClose();
    fireEvent.pointerDown(shield()!);
    fireEvent.pointerCancel(document.body);
    act(() => vi.advanceTimersByTime(600));
    expect(shield()).toBeNull();
  });

  it("leaves at once when the pointer presses anything else", () => {
    setupHold();
    pointerClose();
    fireEvent.pointerDown(screen.getByRole("button", { name: "reopen" }));
    expect(shield()).toBeNull();
  });

  it("leaves when the control comes back, and does not return when it goes again without a pointer", () => {
    setupHold();
    pointerClose();
    act(() => screen.getByRole("button", { name: "reopen" }).click());
    expect(shield()).toBeNull();
    act(() => screen.getByTestId("hide").click());
    expect(shield()).toBeNull();
  });

  it("removes the box, its timer and its listeners on unmount", () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const { unmount } = setupHold();
    pointerClose();
    fireEvent.pointerDown(shield()!);
    unmount();
    expect(shield()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const pointer = (calls: unknown[][]) => calls.filter(([type]) => typeof type === "string" && type.startsWith("pointer")).length;
    expect(pointer(added.mock.calls)).toBeGreaterThan(0);
    expect(pointer(removed.mock.calls)).toBe(pointer(added.mock.calls));
  });
});
