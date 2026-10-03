// @vitest-environment jsdom
import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEnterOnRelease, usePickOnRelease, usePlaceHold } from "./press-once";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    <div role="menu" tabIndex={-1} onKeyDown={pick.onMenuKeyDown}>
      {["One", "Two"].map((name) => (
        <div key={name} role="menuitem" tabIndex={-1} onKeyDown={pick.onKeyDown} onKeyUp={pick.onKeyUp} onBlur={pick.onBlur} onClick={() => onPick(name)}>
          <span tabIndex={-1}>{name}</span>
        </div>
      ))}
    </div>
  );
}

describe("usePickOnRelease", () => {
  const setup = () => {
    const onPick = vi.fn();
    render(<Items onPick={onPick} />);
    const [one, two] = screen.getAllByRole("menuitem");
    return { onPick, one, two };
  };

  it.each(["Enter", " "])("picks once when %o is released, however long it was held", (key) => {
    const { onPick, one } = setup();
    act(() => one.focus());
    expect(fireEvent.keyDown(one, { key })).toBe(false);
    for (let i = 0; i < 5; i++) expect(fireEvent.keyDown(one, { key, repeat: true })).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyUp(one, { key });
    expect(onPick).toHaveBeenCalledExactlyOnceWith("One");
  });

  it("picks nothing for a key that was already down when focus reached the item", () => {
    const { onPick, one } = setup();
    act(() => one.focus());
    // The menu was opened with this key: the item only sees its repeats and its release.
    expect(fireEvent.keyDown(one, { key: "Enter", repeat: true })).toBe(false);
    fireEvent.keyUp(one, { key: "Enter" });
    fireEvent.keyUp(one, { key: " " });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("picks nothing when the key is released on another item, or after focus left", () => {
    const { onPick, one, two } = setup();
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
    const { onPick, one } = setup();
    act(() => one.focus());
    expect(fireEvent.keyDown(one, { key: "t" })).toBe(true);
    expect(fireEvent.keyDown(one, { key: " " }), "the space is not cancelled").toBe(true);
    fireEvent.keyUp(one, { key: " " });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("counts a letter typed on the menu itself, where focus is after the pointer opened it", () => {
    const { onPick, one } = setup();
    const clock = vi.spyOn(Event.prototype, "timeStamp", "get");
    // The letter goes to the menu and its search moves focus to an item; the space follows on that item.
    clock.mockReturnValue(1_000);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "o" });
    act(() => one.focus());
    clock.mockReturnValue(1_900);
    expect(fireEvent.keyDown(one, { key: " " }), "within a second: part of the name").toBe(true);
    fireEvent.keyUp(one, { key: " " });
    expect(onPick).not.toHaveBeenCalled();

    // A second after the last letter the search is over, and Space picks again.
    clock.mockReturnValue(2_100);
    expect(fireEvent.keyDown(one, { key: " " })).toBe(false);
    fireEvent.keyUp(one, { key: " " });
    expect(onPick).toHaveBeenCalledExactlyOnceWith("One");
  });

  it("does not take a shortcut, a space or an arrow for a typed letter", () => {
    const { onPick, one } = setup();
    act(() => one.focus());
    for (const init of [{ key: "a", ctrlKey: true }, { key: "a", altKey: true }, { key: "a", metaKey: true }, { key: " " }, { key: "ArrowDown" }]) {
      fireEvent.keyDown(screen.getByRole("menu"), init);
    }
    expect(fireEvent.keyDown(one, { key: " " }), "Space still picks").toBe(false);
    fireEvent.keyUp(one, { key: " " });
    expect(onPick).toHaveBeenCalledExactlyOnceWith("One");
  });

  it("leaves keys from inside an item and handled keys alone", () => {
    const { onPick, one } = setup();
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
          {/* The control goes a moment after the click, as the table menu does: a frame after its table. */}
          <button type="button" onClick={(event) => hold.arm(event, event.currentTarget.parentElement)}>
            close later
          </button>
          <button
            type="button"
            onClick={(event) => {
              hold.arm(event, event.currentTarget.parentElement);
              hold.disarm();
            }}
          >
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
  const setup = () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ ...BOX, right: 240, bottom: 92, x: 40, y: 60, toJSON: () => BOX } as DOMRect);
    const onAction = vi.fn();
    const view = render(<Hold onAction={onAction} />);
    return { onAction, ...view };
  };
  const shield = () => screen.queryByTestId("place-hold");
  const pointerClose = () => fireEvent.click(screen.getByRole("button", { name: "close" }), { detail: 1 });
  const reopen = () => act(() => screen.getByRole("button", { name: "reopen" }).click());
  /** The control goes without a pointer click of its own. */
  const hide = () => fireEvent.click(screen.getByTestId("hide"), { detail: 0 });

  it("puts an empty box where the control was after a pointer click removed it, and takes it away 600 ms later", () => {
    setup();
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

  it("cancels its own mousedown and the end of a touch, so focus and selection stay, and keeps its press from the page", () => {
    setup();
    const onDocument = vi.fn();
    document.addEventListener("pointerdown", onDocument);
    try {
      pointerClose();
      expect(fireEvent.mouseDown(shield()!)).toBe(false);
      expect(fireEvent.touchEnd(shield()!), "a tap on the box sends no click to what is under it").toBe(false);
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
    const { onAction } = setup();
    fireEvent.click(screen.getByRole("button", { name: "close" }), { detail: 0 });
    expect(onAction).toHaveBeenCalledOnce();
    expect(shield()).toBeNull();
  });

  it("shows nothing while the control is still there, and forgets the click after 600 ms", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "close later" }), { detail: 1 });
    expect(shield()).toBeNull();
    act(() => vi.advanceTimersByTime(600));
    hide();
    expect(shield()).toBeNull();
  });

  it("counts the 600 ms from the click, not from the moment the control went", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "close later" }), { detail: 1 });
    act(() => vi.advanceTimersByTime(400));
    hide();
    expect(shield()).not.toBeNull();
    act(() => vi.advanceTimersByTime(199));
    expect(shield()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(shield(), "600 ms after the click, 200 ms after the control went").toBeNull();
  });

  it("gives the place up when the click turned out to leave the control where it is", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "stay" }), { detail: 1 });
    hide();
    expect(shield(), "the control went later, for another reason").toBeNull();
  });

  it("does not start the 600 ms again for a press on it", () => {
    setup();
    pointerClose();
    act(() => vi.advanceTimersByTime(400));
    fireEvent.pointerDown(shield()!);
    fireEvent.pointerUp(shield()!);
    fireEvent.click(shield()!, { detail: 2 });
    act(() => vi.advanceTimersByTime(199));
    expect(shield()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(shield(), "600 ms after the click that armed it").toBeNull();
  });

  it("stays while a pointer is still pressed on it, until that press ends, and at most 10 s", () => {
    setup();
    pointerClose();
    act(() => vi.advanceTimersByTime(500));
    fireEvent.pointerDown(shield()!);
    act(() => vi.advanceTimersByTime(5_000));
    expect(shield(), "a press that is still down keeps it").not.toBeNull();
    // Leaving the box with the pointer down does not end the press.
    fireEvent.pointerLeave(shield()!);
    fireEvent.pointerOut(shield()!);
    expect(shield()).not.toBeNull();
    fireEvent.pointerUp(shield()!);
    expect(shield(), "the 600 ms are over: it goes when the press ends").toBeNull();

    // A press that ends inside the 600 ms changes nothing.
    reopen();
    pointerClose();
    fireEvent.pointerDown(shield()!);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.pointerUp(shield()!);
    expect(shield()).not.toBeNull();
    act(() => vi.advanceTimersByTime(500));
    expect(shield()).toBeNull();

    reopen();
    pointerClose();
    act(() => vi.advanceTimersByTime(300));
    fireEvent.pointerDown(shield()!);
    act(() => vi.advanceTimersByTime(9_999));
    expect(shield()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(shield(), "the cap for a press that never ends").toBeNull();
  });

  it("waits for the last of two fingers", () => {
    setup();
    pointerClose();
    fireEvent.pointerDown(shield()!, { pointerId: 1 });
    fireEvent.pointerDown(shield()!, { pointerId: 2 });
    act(() => vi.advanceTimersByTime(700));
    fireEvent.pointerUp(shield()!, { pointerId: 1 });
    expect(shield()).not.toBeNull();
    // A pointer that never pressed the box ends nothing.
    fireEvent.pointerUp(document.body, { pointerId: 3 });
    expect(shield()).not.toBeNull();
    fireEvent.pointerUp(shield()!, { pointerId: 2 });
    expect(shield()).toBeNull();
  });

  it("a press that ends outside the box, or is cancelled, still ends", () => {
    setup();
    pointerClose();
    fireEvent.pointerDown(shield()!);
    act(() => vi.advanceTimersByTime(700));
    expect(shield()).not.toBeNull();
    fireEvent.pointerCancel(document.body);
    expect(shield()).toBeNull();
  });

  it("leaves at once when the pointer presses anything else", () => {
    setup();
    pointerClose();
    fireEvent.pointerDown(screen.getByRole("button", { name: "reopen" }));
    expect(shield()).toBeNull();
  });

  it("leaves when the control comes back, and does not return when it goes again without a pointer", () => {
    setup();
    pointerClose();
    reopen();
    expect(shield()).toBeNull();
    act(() => screen.getByTestId("hide").click());
    expect(shield()).toBeNull();
  });

  it("removes the box, its timers and its listeners on unmount", () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const { unmount } = setup();
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
