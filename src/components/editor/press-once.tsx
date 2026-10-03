"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * One press is one action, for the formatting toolbar, the selection bubble and the table menu.
 *
 * Their actions hand focus to the editor. A held key then keeps firing where focus went: a held Enter
 * on Bold formats the selection once and the repeats replace it with empty paragraphs. And the rest of
 * a double-click lands on whatever is under the pointer once a click has closed the menu or hidden the
 * control it was aimed at.
 */

export interface ReleasePress {
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onKeyUp: (event: KeyboardEvent<HTMLElement>) => void;
  onBlur: () => void;
}

/**
 * Enter clicks a button when the key is released, as Space already does. Put the handlers on the element
 * that holds the buttons.
 *
 * A native button clicks on every keydown of a held Enter. Here each Enter keydown on a button is
 * cancelled, and the keyup clicks the button if the press started on it and focus stayed on it. Enter
 * with Ctrl, Alt or Meta does nothing, and a click that comes with no key (a screen reader, voice
 * control) is not touched.
 */
export function useEnterOnRelease(): ReleasePress {
  const pressed = useRef<HTMLButtonElement | null>(null);
  return {
    onKeyDown(event) {
      const button = event.target;
      if (event.key !== "Enter" || event.defaultPrevented || event.nativeEvent.isComposing) return;
      if (!(button instanceof HTMLButtonElement) || !event.currentTarget.contains(button)) return;
      event.preventDefault();
      if (event.repeat) return;
      pressed.current = event.altKey || event.ctrlKey || event.metaKey ? null : button;
    },
    onKeyUp(event) {
      if (event.key !== "Enter") return;
      const button = pressed.current;
      pressed.current = null;
      if (button && button === event.target && button === document.activeElement) button.click();
    },
    onBlur() {
      pressed.current = null;
    },
  };
}

/** Radix collects typed characters for this long to find an item by name. */
const TYPEAHEAD_MS = 1000;

/**
 * Enter and Space pick a menu item when the key is released. Put `onMenuKeyDown` on the menu and the
 * other handlers on every item of it.
 *
 * Radix picks on keydown: the menu closes, focus goes back to the editor and the repeats of a held key
 * are typed there. A repeat that reaches an item, from a key held since before the menu opened, picks
 * nothing either. A space typed as part of an item's name ("heading 2") is left to Radix, wherever in
 * the menu the letters before it were typed: a menu opened with the pointer has focus on itself, not on
 * an item, until the first letter finds one.
 */
export function usePickOnRelease(): ReleasePress & { onMenuKeyDown: (event: KeyboardEvent<HTMLElement>) => void } {
  const pressed = useRef<{ item: HTMLElement; key: string } | null>(null);
  const typedAt = useRef(Number.NEGATIVE_INFINITY);
  return {
    onMenuKeyDown(event) {
      if (event.key.length !== 1 || event.key === " " || event.nativeEvent.isComposing) return;
      if (!(event.altKey || event.ctrlKey || event.metaKey)) typedAt.current = event.timeStamp;
    },
    onKeyDown(event) {
      if (event.defaultPrevented || event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.key === " " && event.timeStamp - typedAt.current < TYPEAHEAD_MS) return;
      event.preventDefault();
      if (!event.repeat) pressed.current = { item: event.currentTarget, key: event.key };
    },
    onKeyUp(event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      const press = pressed.current;
      pressed.current = null;
      if (press && press.key === event.key && press.item === event.currentTarget) press.item.click();
    },
    onBlur() {
      pressed.current = null;
    },
  };
}

/** Longer than the 500 ms within which Windows counts two clicks as a double-click. */
const HOLD_MS = 600;
/** A press that stays down on the box keeps it at most this long. */
const PRESS_CAP_MS = 10_000;

interface Held {
  control: Element;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PlaceHold {
  /** In the click handler, before the action: remembers where the control is. */
  arm: (event: MouseEvent, control: Element | null | undefined) => void;
  /** After the action, when it turned out to leave the control in place. */
  disarm: () => void;
  shield: ReactNode;
}

/**
 * Keeps the place of a control for the rest of the pointer gesture that removed it.
 *
 * `arm` goes in the click handler of a button whose own action takes the control away: a menu item, a
 * button that hides its bubble, a delete that removes what the menu belongs to. A button that leaves the
 * control in place never arms. While `gone` is true, `shield` is an empty box over the place the
 * control had at the click, so the second click of a double-click, or a second tap, lands on the box and
 * not on what was under the control. The box does nothing: it cancels its own mousedown, so focus and
 * selection stay where the action left them, keeps its press from the rest of the page, and cancels the
 * end of a touch, so a tap that outlasts the box sends no click to what is under it. It is not
 * focusable and not announced.
 *
 * The box leaves HOLD_MS after the click that armed it. Nothing restarts that time: not the control
 * hiding, not a press on the box. A press that is still down on the box then keeps it until the press
 * ends, PRESS_CAP_MS at most. It leaves at once when the pointer presses anything else, and when the
 * control comes back. A click from the keyboard never arms it.
 */
export function usePlaceHold(gone: boolean): PlaceHold {
  const [held, setHeld] = useState<Held | null>(null);
  const shieldRef = useRef<HTMLDivElement | null>(null);
  const wasGone = useRef(false);

  useEffect(() => {
    if (!held) return;
    if (gone) wasGone.current = true;
    else if (wasGone.current) setHeld(null);
  }, [held, gone]);

  // One clock per arming click: `held` is a new object for each, and only that restarts this effect.
  useEffect(() => {
    if (!held) return;
    const leave = () => setHeld(null);
    const presses = new Set<number>();
    let over = false;
    let cap: number | undefined;
    const timer = window.setTimeout(() => {
      over = true;
      if (!presses.size) leave();
    }, HOLD_MS);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target === shieldRef.current) {
        presses.add(event.pointerId);
        window.clearTimeout(cap);
        cap = window.setTimeout(leave, PRESS_CAP_MS);
      } else if (!(target instanceof Node && held.control.contains(target))) leave();
    };
    // A press that went down on the box can end anywhere; a touch ends with pointercancel when it scrolls.
    const onPointerEnd = (event: PointerEvent) => {
      if (!presses.delete(event.pointerId) || presses.size) return;
      window.clearTimeout(cap);
      if (over) leave();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerEnd, true);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(cap);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
    };
  }, [held]);

  const arm = (event: MouseEvent, control: Element | null | undefined) => {
    // A click from the keyboard, or one sent by assistive technology, has no pointer and `detail` 0.
    if (event.detail === 0 || !control) return;
    const { left, top, width, height } = control.getBoundingClientRect();
    wasGone.current = false;
    setHeld({ control, left, top, width, height });
  };
  const disarm = () => setHeld(null);

  // The top layer puts the box over everything, as the bubble and an open dialog are. A press on the box
  // goes no further: the comment sheet a phone opens for Comment closes on a press outside it, and its
  // listener is on the document, where React's own handlers run too late to keep the press from it.
  const attach = useCallback((element: HTMLDivElement | null) => {
    shieldRef.current = element;
    if (!element) return;
    element.addEventListener("pointerdown", (event) => event.stopPropagation());
    // The browser sends a tap's mouse events and its click after the touch has ended, to whatever is
    // under the finger by then.
    element.addEventListener("touchend", (event) => event.preventDefault(), { passive: false });
    if (typeof element.showPopover === "function" && !element.matches(":popover-open")) element.showPopover();
  }, []);

  const shield =
    held && gone
      ? createPortal(
          <div
            ref={attach}
            popover="manual"
            aria-hidden="true"
            data-testid="place-hold"
            onMouseDown={(event) => event.preventDefault()}
            style={{
              position: "fixed",
              inset: "auto",
              left: held.left,
              top: held.top,
              width: held.width,
              height: held.height,
              margin: 0,
              border: 0,
              padding: 0,
              overflow: "hidden",
              background: "transparent",
              pointerEvents: "auto",
              zIndex: 2147483647,
            }}
          />,
          document.body,
        )
      : null;

  return { arm, disarm, shield };
}
