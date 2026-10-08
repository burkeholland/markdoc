// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CARD_FOCUS_QUIET_MS, CARD_FOCUS_TRIES, CARD_LOAD_AGAIN_LABEL, CARD_TURNED_OFF_TEXT, createTurnedOffNotice, guardCardFrame, isTypingPlace } from "./link-card-focus-guard";

/** The page's window. (In this test environment the global object is not the document's window.) */
const page = document.defaultView!;

/** An event that happened at this time on the page's clock. */
function at<E extends Event>(event: E, ms: number): E {
  Object.defineProperty(event, "timeStamp", { value: ms });
  return event;
}
const key = (target: Element, name: string, ms: number, init: KeyboardEventInit = {}) => target.dispatchEvent(at(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }), ms));
const pointer = (target: Element, type: string, ms: number) => {
  const event = at(new MouseEvent(type, { bubbles: type !== "pointerenter" && type !== "pointerleave", cancelable: true }), ms);
  target.dispatchEvent(event);
  return event;
};

interface Card {
  box: HTMLElement;
  frame: HTMLIFrameElement;
  turnOff: ReturnType<typeof vi.fn>;
  stop: () => void;
}

function card(): Card {
  const box = document.createElement("div");
  box.className = "md-link-card-frame";
  const frame = document.createElement("iframe");
  box.append(frame);
  document.body.append(box);
  const turnOff = vi.fn(() => frame.remove());
  return { box, frame, turnOff, stop: guardCardFrame(frame, turnOff) };
}

/** The frame's own script takes the keyboard: the frame becomes the page's active element and the window loses focus. */
function grab(frame: HTMLIFrameElement, ms: number) {
  frame.focus();
  expect(document.activeElement).toBe(frame);
  page.dispatchEvent(at(new FocusEvent("blur"), ms));
  vi.runOnlyPendingTimers();
}

const live = () => document.querySelector<HTMLElement>("[data-card-focus-status]");
const cover = (box: HTMLElement) => box.querySelector<HTMLElement>(".md-link-card-cover");

describe("the focus guard of a card's frame (#2338)", () => {
  let editor: HTMLElement;
  let field: HTMLInputElement;
  let button: HTMLButtonElement;
  const stops: Array<() => void> = [];
  const make = () => {
    const made = card();
    stops.push(made.stop);
    return made;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    document.body.innerHTML = `<div id="editor" contenteditable="true" tabindex="0">text</div><input id="field"><button id="button" type="button">A button</button>`;
    editor = document.getElementById("editor")!;
    field = document.getElementById("field") as HTMLInputElement;
    button = document.getElementById("button") as HTMLButtonElement;
  });
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  describe("a place where text is typed is told by what it is", () => {
    const element = (html: string) => {
      const holder = document.createElement("div");
      holder.innerHTML = html;
      return holder.firstElementChild;
    };
    it.each([
      [`<div contenteditable="true"></div>`],
      [`<div contenteditable=""></div>`],
      [`<div contenteditable="plaintext-only"></div>`],
      [`<textarea></textarea>`],
      [`<input>`],
      [`<input type="text">`],
      [`<input type="search">`],
      [`<input type="email">`],
      [`<input type="password">`],
      [`<input type="number">`],
      [`<div role="textbox"></div>`],
      [`<div role="searchbox"></div>`],
      [`<div role="combobox"></div>`],
      [`<div role="textbox" contenteditable="true" aria-multiline="true"></div>`],
    ])("typed in: %s", (html) => {
      expect(isTypingPlace(element(html))).toBe(true);
    });
    it.each([
      [`<div></div>`],
      [`<button type="button">b</button>`],
      [`<a href="/x">a</a>`],
      [`<iframe></iframe>`],
      [`<input type="checkbox">`],
      [`<input type="radio">`],
      [`<input type="button">`],
      [`<input type="submit">`],
      [`<input type="range">`],
      [`<input type="file">`],
      [`<input type="color">`],
      [`<input readonly>`],
      [`<input disabled>`],
      [`<textarea readonly></textarea>`],
      [`<textarea disabled></textarea>`],
      [`<div role="textbox" aria-readonly="true"></div>`],
      // A viewer's preview: the editor is there and calls itself a text box, but nobody can type in it.
      [`<div role="textbox" contenteditable="false" aria-multiline="true"></div>`],
      [`<div contenteditable="false"></div>`],
      [`<div role="button"></div>`],
    ])("not typed in: %s", (html) => {
      expect(isTypingPlace(element(html))).toBe(false);
    });
    it("nothing, and a thing that is not an element of a page, are not typed in", () => {
      expect(isTypingPlace(null)).toBe(false);
      expect(isTypingPlace(document.createElementNS("http://www.w3.org/2000/svg", "svg"))).toBe(false);
    });
  });

  describe("a frame that takes the keyboard by itself", () => {
    it("from the editor: focus goes back to the editor, each time", () => {
      const { frame, turnOff, box } = make();
      editor.focus();
      grab(frame, 1000);
      expect(document.activeElement).toBe(editor);
      grab(frame, 1200);
      expect(document.activeElement).toBe(editor);
      expect(turnOff).not.toHaveBeenCalled();
      expect(box.hasAttribute("data-has-keyboard")).toBe(false);
    });

    it("from a text field anywhere on the page: the same", () => {
      const { frame } = make();
      field.focus();
      grab(frame, 1000);
      expect(document.activeElement).toBe(field);
    });

    it("the answer waits for the browser to finish the move: nothing happens inside the blur event itself", () => {
      const { frame } = make();
      editor.focus();
      frame.focus();
      page.dispatchEvent(at(new FocusEvent("blur"), 1000));
      expect(document.activeElement).toBe(frame);
      vi.runOnlyPendingTimers();
      expect(document.activeElement).toBe(editor);
    });

    it(`after ${CARD_FOCUS_TRIES} tries the frame is turned off, once, and the page says so once`, () => {
      expect(CARD_FOCUS_TRIES).toBe(3);
      const { frame, turnOff } = make();
      const region = live()!;
      // The live region is in the page before there is anything to say, and it is polite.
      expect(region.getAttribute("aria-live")).toBe("polite");
      expect(region.getAttribute("role")).toBe("status");
      expect(region.textContent).toBe("");
      editor.focus();
      grab(frame, 1000);
      grab(frame, 1100);
      expect(turnOff).not.toHaveBeenCalled();
      expect(region.textContent).toBe("");
      frame.focus();
      page.dispatchEvent(at(new FocusEvent("blur"), 1200));
      vi.advanceTimersByTime(0);
      expect(turnOff).toHaveBeenCalledTimes(1);
      // Focus stays in the document.
      expect(document.activeElement).toBe(editor);
      expect(region.textContent).toBe(CARD_TURNED_OFF_TEXT);
      expect(CARD_TURNED_OFF_TEXT).toBe("This card kept taking the keyboard away from your document, so it was turned off.");
      // The words do not stay for somebody to find later.
      vi.advanceTimersByTime(9_999);
      expect(region.textContent).toBe(CARD_TURNED_OFF_TEXT);
      vi.advanceTimersByTime(1);
      expect(region.textContent).toBe("");
    });

    it("each frame has its own count, and the page has one live region", () => {
      const first = make();
      const second = make();
      expect(document.querySelectorAll("[data-card-focus-status]")).toHaveLength(1);
      editor.focus();
      grab(first.frame, 1000);
      grab(second.frame, 1100);
      grab(first.frame, 1200);
      grab(second.frame, 1300);
      expect(first.turnOff).not.toHaveBeenCalled();
      expect(second.turnOff).not.toHaveBeenCalled();
      grab(first.frame, 1400);
      expect(first.turnOff).toHaveBeenCalledTimes(1);
      expect(second.turnOff).not.toHaveBeenCalled();
    });

    it("a move the person made in between starts the count again", () => {
      const { frame, turnOff } = make();
      editor.focus();
      grab(frame, 1000);
      grab(frame, 1100);
      // The person goes in with Tab.
      key(editor, "Tab", 2000);
      grab(frame, 2010);
      expect(document.activeElement).toBe(frame);
      editor.focus();
      grab(frame, 3000);
      grab(frame, 3100);
      expect(turnOff).not.toHaveBeenCalled();
      grab(frame, 3200);
      expect(turnOff).toHaveBeenCalledTimes(1);
    });

    it("the place the person was in is gone: the frame loses focus, and nothing throws", () => {
      const { frame } = make();
      editor.focus();
      editor.remove();
      const blur = vi.spyOn(frame, "blur");
      grab(frame, 1000);
      expect(blur).toHaveBeenCalledTimes(1);
    });

    it("the browser does not give focus back: the card at least shows where the keyboard is", () => {
      const { frame, box } = make();
      editor.focus();
      vi.spyOn(editor, "focus").mockImplementation(() => {});
      grab(frame, 1000);
      expect(document.activeElement).toBe(frame);
      expect(box.hasAttribute("data-has-keyboard")).toBe(true);
    });
  });

  describe("a move the person made is left alone", () => {
    it("focus was not in a place where text is typed (a button, the page itself): the frame keeps the keyboard and its card shows the ring", () => {
      const { frame, box, turnOff } = make();
      button.focus();
      for (let n = 0; n < 5; n++) grab(frame, 1000 + n * 100);
      expect(document.activeElement).toBe(frame);
      expect(box.hasAttribute("data-has-keyboard")).toBe(true);
      expect(turnOff).not.toHaveBeenCalled();
      // The page has the keyboard again: the ring goes.
      page.dispatchEvent(new FocusEvent("focus"));
      expect(box.hasAttribute("data-has-keyboard")).toBe(false);
    });

    it("the person clicked on the page's background before: that is not a typing place any more", () => {
      const { frame } = make();
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      editor.focus();
      editor.blur();
      expect(document.activeElement).toBe(document.body);
      vi.runOnlyPendingTimers();
      grab(frame, 1000);
      expect(document.activeElement).toBe(frame);
    });

    it("Tab or Shift+Tab that nothing in the page used, just before the move", () => {
      const { frame } = make();
      editor.focus();
      key(editor, "Tab", 1000);
      grab(frame, 1250);
      expect(document.activeElement).toBe(frame);
      editor.focus();
      key(editor, "Tab", 2000, { shiftKey: true });
      grab(frame, 2001);
      expect(document.activeElement).toBe(frame);
    });

    it.each([
      ["a Tab the page used for itself (an editor that indents)", () => editor.addEventListener("keydown", (event) => event.preventDefault()), "Tab", {}, 10],
      ["a Tab that is too old", () => {}, "Tab", {}, 251],
      ["Ctrl+Tab", () => {}, "Tab", { ctrlKey: true }, 10],
      ["Alt+Tab", () => {}, "Tab", { altKey: true }, 10],
      ["another key", () => {}, "Enter", {}, 10],
    ])("not: %s", (_name, prepare, name, init, later) => {
      const { frame } = make();
      prepare();
      editor.focus();
      key(editor, name, 1000, init);
      grab(frame, 1000 + later);
      expect(document.activeElement).toBe(editor);
    });

    it(`the pointer is on the frame and no key was typed in the last ${CARD_FOCUS_QUIET_MS} ms`, () => {
      expect(CARD_FOCUS_QUIET_MS).toBe(1000);
      const { frame, box } = make();
      editor.focus();
      key(editor, "a", 1000);
      pointer(frame, "pointerenter", 1500);
      grab(frame, 2000);
      expect(document.activeElement).toBe(frame);
      expect(box.hasAttribute("data-has-keyboard")).toBe(true);
    });

    it("the pointer is on the frame and nobody has typed at all", () => {
      const { frame } = make();
      editor.focus();
      pointer(frame, "pointerenter", 10);
      grab(frame, 20);
      expect(document.activeElement).toBe(frame);
    });

    it("not: a key was typed less than a second before (a hand that brushed the pointer onto the card)", () => {
      const { frame } = make();
      editor.focus();
      key(editor, "a", 1000);
      pointer(frame, "pointerenter", 1500);
      grab(frame, 1999);
      expect(document.activeElement).toBe(editor);
    });

    it("not: the pointer is somewhere else, or on another card's frame, or has left again", () => {
      const first = make();
      const second = make();
      editor.focus();
      grab(first.frame, 5000);
      expect(document.activeElement).toBe(editor);
      pointer(second.frame, "pointerenter", 6000);
      grab(first.frame, 7000);
      expect(document.activeElement).toBe(editor);
      pointer(second.frame, "pointerleave", 7500);
      grab(second.frame, 8000);
      expect(document.activeElement).toBe(editor);
    });
  });

  describe("the cover: the pointer rests on a frame while the person types", () => {
    it("a key typed in the page puts a see-through cover over that frame, and one only", () => {
      const { frame, box } = make();
      const other = make();
      editor.focus();
      pointer(frame, "pointerenter", 1000);
      expect(cover(box)).toBeNull();
      key(editor, "a", 2000);
      key(editor, "b", 2100);
      expect(box.querySelectorAll(".md-link-card-cover")).toHaveLength(1);
      expect(cover(box)!.getAttribute("aria-hidden")).toBe("true");
      expect(cover(box)!.previousElementSibling).toBe(frame);
      // Only where the pointer is.
      expect(cover(other.box)).toBeNull();
    });

    it("under the cover a move of focus into the frame is not the person's, however long ago the last key was", () => {
      const { frame, box } = make();
      editor.focus();
      pointer(frame, "pointerenter", 1000);
      key(editor, "a", 2000);
      // The cover going on tells the frame that the pointer left it. It did not.
      pointer(frame, "pointerleave", 2001);
      expect(cover(box)).not.toBeNull();
      grab(frame, 9000);
      expect(document.activeElement).toBe(editor);
    });

    it("the next movement of the pointer takes the cover away; a click after a quiet second then goes in", () => {
      const { frame, box } = make();
      editor.focus();
      pointer(frame, "pointerenter", 1000);
      key(editor, "a", 2000);
      pointer(cover(box)!, "pointermove", 2500);
      expect(cover(box)).toBeNull();
      grab(frame, 2999);
      expect(document.activeElement).toBe(editor);
      grab(frame, 3000);
      expect(document.activeElement).toBe(frame);
    });

    it("a press on the cover is the person's own move into the frame, and is not passed on", () => {
      const { frame, box } = make();
      editor.focus();
      pointer(frame, "pointerenter", 1000);
      key(editor, "a", 2000);
      const press = pointer(cover(box)!, "pointerdown", 2100);
      expect(press.defaultPrevented).toBe(true);
      expect(cover(box)).toBeNull();
      expect(document.activeElement).toBe(frame);
      page.dispatchEvent(at(new FocusEvent("blur"), 2101));
      vi.runOnlyPendingTimers();
      expect(document.activeElement).toBe(frame);
      expect(box.hasAttribute("data-has-keyboard")).toBe(true);
    });

    it("that press does not excuse a later move by the frame's script", () => {
      const { frame, box } = make();
      editor.focus();
      pointer(frame, "pointerenter", 1000);
      key(editor, "a", 2000);
      vi.spyOn(frame, "focus").mockImplementationOnce(() => {});
      pointer(cover(box)!, "pointerdown", 2100);
      // The frame was not focused by the press (a browser that refuses). Half a second later its script takes focus.
      pointer(frame, "pointerleave", 2200);
      grab(frame, 2600);
      expect(document.activeElement).toBe(editor);
    });

    it("the pointer leaves the cover: the cover goes, and the pointer is no longer on the frame", () => {
      const { frame, box } = make();
      editor.focus();
      pointer(frame, "pointerenter", 1000);
      key(editor, "a", 2000);
      pointer(cover(box)!, "pointerleave", 2500);
      expect(cover(box)).toBeNull();
      grab(frame, 9000);
      expect(document.activeElement).toBe(editor);
      // And no cover for a pointer that is not there.
      key(editor, "b", 9500);
      expect(cover(box)).toBeNull();
    });

    it("no cover over the frame that has the keyboard, and none for a key typed inside another frame's card", () => {
      const { frame, box } = make();
      button.focus();
      pointer(frame, "pointerenter", 1000);
      grab(frame, 1100);
      expect(document.activeElement).toBe(frame);
      key(document.body, "a", 2000);
      expect(cover(box)).toBeNull();
    });
  });

  describe("ending, and failing safe", () => {
    it("the guard of a frame ends: no cover, no ring, and the frame is no longer watched", () => {
      const { frame, box, stop, turnOff } = make();
      const other = make();
      button.focus();
      pointer(frame, "pointerenter", 1000);
      grab(frame, 1100);
      expect(box.hasAttribute("data-has-keyboard")).toBe(true);
      editor.focus();
      pointer(frame, "pointerenter", 1500);
      key(editor, "a", 2000);
      expect(cover(box)).not.toBeNull();
      stop();
      expect(cover(box)).toBeNull();
      expect(box.hasAttribute("data-has-keyboard")).toBe(false);
      for (let n = 0; n < 5; n++) grab(frame, 3000 + n * 100);
      expect(turnOff).not.toHaveBeenCalled();
      // The other frame is still guarded.
      editor.focus();
      grab(other.frame, 5000);
      expect(document.activeElement).toBe(editor);
      // Ending twice does nothing.
      expect(() => stop()).not.toThrow();
    });

    it("the page listens to its own keys, focus and pointer only, never to a message, and stops listening with the last frame", () => {
      const added: string[] = [];
      const removed: string[] = [];
      for (const target of [page, document]) {
        const add = target.addEventListener.bind(target);
        const remove = target.removeEventListener.bind(target);
        vi.spyOn(target, "addEventListener").mockImplementation((type: string, ...rest: unknown[]) => {
          added.push(`${target === page ? "window" : "document"} ${type}`);
          return (add as (...args: unknown[]) => void)(type, ...rest);
        });
        vi.spyOn(target, "removeEventListener").mockImplementation((type: string, ...rest: unknown[]) => {
          removed.push(`${target === page ? "window" : "document"} ${type}`);
          return (remove as (...args: unknown[]) => void)(type, ...rest);
        });
      }
      const first = card();
      const second = card();
      expect(added.sort()).toEqual(["document focusin", "document focusout", "document keydown", "window blur", "window focus"]);
      first.stop();
      expect(removed).toEqual([]);
      second.stop();
      expect(removed.sort()).toEqual(["document focusin", "document focusout", "document keydown", "window blur", "window focus"]);
      // A frame guarded after that starts the page's guard again.
      const third = make();
      editor.focus();
      grab(third.frame, 1000);
      expect(document.activeElement).toBe(editor);
    });

    it("a frame that is guarded again keeps its new guard when the old one ends", () => {
      const { frame, stop } = make();
      const turnOff = vi.fn();
      stops.push(guardCardFrame(frame, turnOff));
      stop();
      editor.focus();
      for (let n = 0; n < 3; n++) {
        frame.focus();
        page.dispatchEvent(at(new FocusEvent("blur"), 1000 + n * 100));
        vi.runOnlyPendingTimers();
      }
      expect(turnOff).toHaveBeenCalledTimes(1);
    });

    it("the window loses focus to something that is not a card's frame (another window, another frame): nothing is done", () => {
      const { turnOff } = make();
      const stranger = document.createElement("iframe");
      document.body.append(stranger);
      editor.focus();
      const focus = vi.spyOn(editor, "focus");
      page.dispatchEvent(at(new FocusEvent("blur"), 1000));
      vi.runOnlyPendingTimers();
      stranger.focus();
      page.dispatchEvent(at(new FocusEvent("blur"), 1100));
      vi.runOnlyPendingTimers();
      expect(document.activeElement).toBe(stranger);
      expect(focus).not.toHaveBeenCalled();
      expect(turnOff).not.toHaveBeenCalled();
    });

    it("a browser that sends no blur event: nothing is done, the frame behaves as it did without the guard", () => {
      const { frame, turnOff, box } = make();
      editor.focus();
      frame.focus();
      vi.runOnlyPendingTimers();
      expect(document.activeElement).toBe(frame);
      expect(turnOff).not.toHaveBeenCalled();
      expect(cover(box)).toBeNull();
    });

    it("a blur event that bubbles up from an element is not the window losing focus", () => {
      const { frame } = make();
      editor.focus();
      frame.focus();
      editor.dispatchEvent(at(new FocusEvent("blur", { bubbles: true }), 1000));
      vi.runOnlyPendingTimers();
      expect(document.activeElement).toBe(frame);
    });

    it("a frame whose page content was replaced is forgotten at the next move of focus", () => {
      const removed = vi.spyOn(document, "removeEventListener");
      const { frame, box } = card();
      box.remove();
      page.dispatchEvent(at(new FocusEvent("blur"), 1000));
      vi.runOnlyPendingTimers();
      expect(removed.mock.calls.map((call) => call[0]).sort()).toEqual(["focusin", "focusout", "keydown"]);
      expect(frame.isConnected).toBe(false);
    });

    it("a page with no window is not guarded, and nothing throws", () => {
      const detached = document.implementation.createHTMLDocument("");
      const frame = detached.createElement("iframe");
      detached.body.append(frame);
      const stop = guardCardFrame(frame, () => {});
      expect(() => stop()).not.toThrow();
      expect(detached.querySelector("[data-card-focus-status]")).toBeNull();
    });
  });

  describe("what the card shows in place of a frame that was turned off", () => {
    it("the words, and a button that loads the frame again", () => {
      const again = vi.fn();
      const notice = createTurnedOffNotice(again);
      expect(notice.className).toBe("md-link-card-off");
      expect(notice.querySelector("p")!.textContent).toBe(CARD_TURNED_OFF_TEXT);
      // The words are said by the page's live region, once. Here they are not live.
      expect(notice.querySelector("[aria-live], [role=status], [role=alert]")).toBeNull();
      const button = notice.querySelector("button")!;
      expect(button.type).toBe("button");
      expect(button.textContent).toBe(CARD_LOAD_AGAIN_LABEL);
      expect(CARD_LOAD_AGAIN_LABEL).toBe("Load it again");
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      button.dispatchEvent(click);
      expect(again).toHaveBeenCalledTimes(1);
      expect(click.defaultPrevented).toBe(true);
    });
  });
});
