// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CARD_ENTER_FRAME_LABEL, CARD_FOCUS_QUIET_MS, CARD_FOCUS_TRIES, CARD_FOCUS_TRIES_IN_WINDOW, CARD_FOCUS_WINDOW_MS, CARD_LOAD_AGAIN_LABEL, CARD_TURNED_OFF_TEXT } from "./link-card-focus-guard";

// The code keeps what the page saw (the last key, the last press) for the life of a page, from the moment
// it is loaded. So each test loads it anew: a test starts on a page where nobody has typed or pressed yet.
type Guard = typeof import("./link-card-focus-guard");
let guardCardFrame: Guard["guardCardFrame"];
let createTurnedOffNotice: Guard["createTurnedOffNotice"];

/** The page's window. (In this test environment the global object is not the document's window.) */
const page = document.defaultView!;

/** An event that happened at this time on the page's clock. */
function at<E extends Event>(event: E, ms: number): E {
  Object.defineProperty(event, "timeStamp", { value: ms });
  return event;
}
const key = (target: Element, name: string, ms: number, init: KeyboardEventInit = {}) => target.dispatchEvent(at(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }), ms));
const pointer = (target: Element, type: string, ms: number, pointerType = "mouse") => {
  const event = at(new PointerEvent(type, { pointerType, bubbles: type !== "pointerenter" && type !== "pointerleave", cancelable: true }), ms);
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
function enterByCover(card: Pick<Card, "box" | "frame">, ms: number, pointerType: "mouse" | "pen" | "touch" = "mouse") {
  const entry = cover(card.box)!;
  const pressed = pointer(entry, "pointerdown", ms, pointerType);
  expect(document.activeElement).toBe(card.frame);
  pointer(entry, "pointerup", ms + 1, pointerType);
  entry.dispatchEvent(at(new MouseEvent("click", { bubbles: true, cancelable: true }), ms + 1));
  page.dispatchEvent(at(new FocusEvent("blur"), ms + 1));
  vi.runOnlyPendingTimers();
  return pressed;
}
function enterByTab(card: Pick<Card, "box" | "frame">, from: Element, ms: number, shiftKey = false) {
  key(from, "Tab", ms, { shiftKey });
  cover(card.box)!.dispatchEvent(at(new FocusEvent("focus"), ms + 1));
  expect(document.activeElement).toBe(card.frame);
  page.dispatchEvent(at(new FocusEvent("blur"), ms + 2));
  vi.runOnlyPendingTimers();
}

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

  beforeEach(async () => {
    vi.resetModules();
    ({ guardCardFrame, createTurnedOffNotice } = await import("./link-card-focus-guard"));
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

    it("the window is asked to take the keyboard back, and then the place where the person was", () => {
      const { frame } = make();
      editor.focus();
      const order: string[] = [];
      vi.spyOn(page, "focus").mockImplementation(() => void order.push("window"));
      const original = editor.focus.bind(editor);
      vi.spyOn(editor, "focus").mockImplementation((options) => {
        order.push("editor");
        original(options);
      });
      grab(frame, 1000);
      expect(order).toEqual(["window", "editor", "window", "editor"]);
    });

    it("the unauthorized target is detached and page focus is restored inside the blur event, before the next input can be delivered", () => {
      const { frame, box } = make();
      editor.focus();
      frame.focus();
      page.dispatchEvent(at(new FocusEvent("blur"), 1000));
      expect(frame.isConnected).toBe(false);
      expect(document.activeElement).toBe(editor);
      vi.runOnlyPendingTimers();
      expect(frame.isConnected).toBe(true);
      expect(frame.parentElement).toBe(box);
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
      const made = make();
      const { frame, turnOff } = made;
      editor.focus();
      grab(frame, 1000);
      grab(frame, 1100);
      enterByTab(made, editor, 2000);
      expect(document.activeElement).toBe(frame);
      editor.focus();
      grab(frame, 3000);
      grab(frame, 3100);
      expect(turnOff).not.toHaveBeenCalled();
      grab(frame, 3200);
      expect(turnOff).toHaveBeenCalledTimes(1);
    });

    it("the place the person was in is gone: quarantine still removes focus from the frame without throwing", () => {
      const { frame } = make();
      editor.focus();
      editor.remove();
      grab(frame, 1000);
      expect(document.activeElement).not.toBe(frame);
    });

    it("the browser does not give focus back: the quarantined frame still cannot keep the keyboard", () => {
      const { frame, box } = make();
      editor.focus();
      vi.spyOn(editor, "focus").mockImplementation(() => {});
      vi.spyOn(frame, "blur").mockImplementation(() => {});
      grab(frame, 1000);
      expect(document.activeElement).not.toBe(frame);
      expect(box.hasAttribute("data-has-keyboard")).toBe(false);
      expect(cover(box)).not.toBeNull();
    });

    it("a browser that still reports the detached frame as active is explicitly asked to blur it", () => {
      const { frame } = make();
      editor.focus();
      const actualRemove = frame.remove.bind(frame);
      let detached = false;
      vi.spyOn(frame, "remove").mockImplementation(() => {
        actualRemove();
        detached = true;
      });
      const active = Object.getOwnPropertyDescriptor(Document.prototype, "activeElement")!.get!.bind(document);
      vi.spyOn(document, "activeElement", "get").mockImplementation(() => (detached ? frame : active()));
      const blur = vi.spyOn(frame, "blur").mockImplementation(() => {});
      grab(frame, 1000);
      expect(blur).toHaveBeenCalled();
    });
  });

  describe("only a fresh action observed by the parent authorizes the exact frame", () => {
    it("provider focus is rejected even when focus came from a button or the page background", () => {
      const { frame, box, turnOff } = make();
      button.focus();
      grab(frame, 1000);
      expect(document.activeElement).toBe(button);
      expect(box.hasAttribute("data-has-keyboard")).toBe(false);
      expect(turnOff).not.toHaveBeenCalled();
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      editor.focus();
      editor.blur();
      expect(document.activeElement).toBe(document.body);
      vi.runOnlyPendingTimers();
      grab(frame, 1100);
      expect(document.activeElement).toBe(document.body);
    });

    it("Tab and Shift+Tab enter through this frame's parent-owned cover", () => {
      const made = make();
      editor.focus();
      enterByTab(made, editor, 1000);
      expect(document.activeElement).toBe(made.frame);
      editor.focus();
      enterByTab(made, editor, 2000, true);
      expect(document.activeElement).toBe(made.frame);
    });

    it("one Tab transition can be used only once, and a repeated Tab never authorizes", () => {
      const first = make();
      const second = make();
      editor.focus();
      key(editor, "Tab", 1000);
      cover(first.box)!.dispatchEvent(at(new FocusEvent("focus"), 1001));
      page.dispatchEvent(at(new FocusEvent("blur"), 1002));
      vi.runOnlyPendingTimers();
      expect(document.activeElement).toBe(first.frame);
      editor.focus();
      cover(second.box)!.dispatchEvent(at(new FocusEvent("focus"), 1003));
      grab(second.frame, 1004);
      expect(document.activeElement).toBe(editor);

      key(editor, "Tab", 2000, { repeat: true });
      cover(second.box)!.dispatchEvent(at(new FocusEvent("focus"), 2001));
      grab(second.frame, 2002);
      expect(document.activeElement).toBe(editor);
    });

    it("a Tab observed before a replacement proxy exists cannot activate that proxy", () => {
      const made = make();
      editor.focus();
      enterByCover(made, 1000);
      expect(cover(made.box)).toBeNull();
      key(editor, "Tab", 2000);
      editor.focus();
      expect(cover(made.box)).not.toBeNull();
      cover(made.box)!.dispatchEvent(at(new FocusEvent("focus"), 2001));
      expect(document.activeElement).toBe(editor);
    });

    it.each([
      ["a Tab the page used for itself (an editor that indents)", () => editor.addEventListener("keydown", (event) => event.preventDefault()), "Tab", {}, 10],
      ["a Tab that is too old", () => {}, "Tab", {}, 251],
      ["Ctrl+Tab", () => {}, "Tab", { ctrlKey: true }, 10],
      ["Alt+Tab", () => {}, "Tab", { altKey: true }, 10],
      ["Meta+Tab (Cmd+Tab)", () => {}, "Tab", { metaKey: true }, 10],
      ["a repeated Tab", () => {}, "Tab", { repeat: true }, 10],
      ["another key", () => {}, "Enter", {}, 10],
    ])("not: %s", (_name, prepare, name, init, later) => {
      const made = make();
      prepare();
      editor.focus();
      key(editor, name, 1000, init);
      cover(made.box)!.dispatchEvent(at(new FocusEvent("focus"), 1000 + later));
      grab(made.frame, 1000 + later + 1);
      expect(document.activeElement).toBe(editor);
    });

    it(`mouse and pen hover never authorize, before, at, or after ${CARD_FOCUS_QUIET_MS} ms`, () => {
      expect(CARD_FOCUS_QUIET_MS).toBe(1000);
      for (const pointerType of ["mouse", "pen"]) {
        const { frame } = make();
        editor.focus();
        key(editor, "a", 1000);
        pointer(frame, "pointerenter", 1500, pointerType);
        for (const at of [1999, 2000, 9000]) {
          grab(frame, at);
          expect(document.activeElement).toBe(editor);
        }
      }
    });

    it("hover does not authorize when nobody has typed, on another card, or after pointer movement", () => {
      const first = make();
      const second = make();
      editor.focus();
      pointer(first.frame, "pointerenter", 10);
      pointer(cover(first.box)!, "pointermove", 20);
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

  describe("a finger: the page gets no pointer event on a frame for a touch", () => {
    const press = (target: Element, kind: string, ms: number) => target.dispatchEvent(at(new PointerEvent("pointerdown", { pointerType: kind, bubbles: true, cancelable: true }), ms));

    it("after a touch press in the page, every move into a frame is given back, also long after the last key, and such a move never counts", () => {
      const { frame, box, turnOff } = make();
      editor.focus();
      press(editor, "touch", 500);
      key(editor, "a", 1000);
      for (let tap = 0; tap < CARD_FOCUS_TRIES * 3; tap++) {
        grab(frame, 1000 + CARD_FOCUS_QUIET_MS + tap * 700);
        expect(document.activeElement).toBe(editor);
        expect(box.hasAttribute("data-has-keyboard")).toBe(false);
      }
      expect(turnOff).not.toHaveBeenCalled();
      expect(live()!.textContent).toBe("");
    });

    it("nobody has typed at all: given back, not counted", () => {
      const { frame, turnOff } = make();
      editor.focus();
      press(editor, "touch", 500);
      for (let tap = 0; tap < CARD_FOCUS_TRIES + 1; tap++) grab(frame, 600 + tap * 10);
      expect(document.activeElement).toBe(editor);
      expect(turnOff).not.toHaveBeenCalled();
    });

    it("focus goes back without scrolling the page", () => {
      const { frame } = make();
      editor.focus();
      press(editor, "touch", 500);
      const focus = vi.spyOn(editor, "focus");
      grab(frame, 5000);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    });

    it(`a move counts when a key was typed in the last ${CARD_FOCUS_QUIET_MS} ms: ${CARD_FOCUS_TRIES} in a row turn the card off`, () => {
      const { frame, turnOff } = make();
      editor.focus();
      press(editor, "touch", 500);
      for (let n = 0; n < CARD_FOCUS_TRIES; n++) {
        key(editor, "a", 1000 + n * 100);
        expect(turnOff).not.toHaveBeenCalled();
        grab(frame, 1050 + n * 100);
        expect(document.activeElement).toBe(editor);
      }
      expect(turnOff).toHaveBeenCalledTimes(1);
      expect(live()!.textContent).toBe(CARD_TURNED_OFF_TEXT);
    });

    it("the window is the same second: one millisecond before its end a move counts, at its end it does not", () => {
      const { frame, turnOff } = make();
      editor.focus();
      press(editor, "touch", 500);
      key(editor, "a", 1000);
      for (let n = 0; n < CARD_FOCUS_TRIES; n++) grab(frame, 1000 + CARD_FOCUS_QUIET_MS);
      expect(turnOff).not.toHaveBeenCalled();
      for (let n = 0; n < CARD_FOCUS_TRIES; n++) grab(frame, 1000 + CARD_FOCUS_QUIET_MS - 1);
      expect(turnOff).toHaveBeenCalledTimes(1);
    });

    it("a move that does not count starts the count again: only moves in a row turn the card off", () => {
      const { frame, turnOff } = make();
      editor.focus();
      press(editor, "touch", 500);
      let now = 1000;
      for (let round = 0; round < 4; round++) {
        for (let n = 0; n < CARD_FOCUS_TRIES - 1; n++) {
          key(editor, "a", now);
          grab(frame, now + 50);
          now += 100;
        }
        now += CARD_FOCUS_QUIET_MS;
        grab(frame, now);
        expect(document.activeElement).toBe(editor);
      }
      expect(turnOff).not.toHaveBeenCalled();
    });

    it("touch does not authorize provider focus, even outside a typing place", () => {
      const { frame, box } = make();
      button.focus();
      press(button, "touch", 500);
      grab(frame, 600);
      expect(document.activeElement).toBe(button);
      expect(box.hasAttribute("data-has-keyboard")).toBe(false);
    });

    it("Tab from a keyboard that is attached still goes into the frame", () => {
      const made = make();
      editor.focus();
      press(editor, "touch", 500);
      enterByTab(made, editor, 1000);
      expect(document.activeElement).toBe(made.frame);
    });

    it("a touch press, then the mouse moves onto the frame: the rule follows the last press, so the move is still given back and not counted", () => {
      const { frame, turnOff } = make();
      editor.focus();
      press(editor, "touch", 500);
      key(editor, "a", 1000);
      pointer(frame, "pointerenter", 1500);
      for (let n = 0; n < CARD_FOCUS_TRIES + 1; n++) {
        grab(frame, 3000 + n * 500);
        expect(document.activeElement).toBe(editor);
      }
      expect(turnOff).not.toHaveBeenCalled();
    });

    it.each(["mouse", "pen"] as const)("a touch press, then a %s cover press authorizes only that frame and restores normal counting", (kind) => {
      const first = make();
      const second = make();
      editor.focus();
      press(editor, "touch", 500);
      press(editor, kind, 600);
      key(editor, "a", 1000);
      enterByCover(first, 1500, kind);
      expect(document.activeElement).toBe(first.frame);
      editor.focus();
      for (let n = 0; n < CARD_FOCUS_TRIES; n++) {
        grab(second.frame, 9000 + n * 2000);
        expect(document.activeElement).toBe(editor);
      }
      expect(second.turnOff).toHaveBeenCalledTimes(1);
    });

    it.each(["mouse", "pen"])("a %s press, then a touch press: the finger's rule holds (the pointer that was left on the frame no longer says the person went in, and nothing counts)", (kind) => {
      const { frame, box, turnOff } = make();
      editor.focus();
      press(editor, kind, 400);
      key(editor, "a", 1000);
      pointer(frame, "pointerenter", 1500);
      press(editor, "touch", 2000);
      for (let n = 0; n < CARD_FOCUS_TRIES + 1; n++) {
        grab(frame, 3000 + n * 500);
        expect(document.activeElement).toBe(editor);
        expect(box.hasAttribute("data-has-keyboard")).toBe(false);
      }
      expect(turnOff).not.toHaveBeenCalled();
    });

    it("the press is seen before anything in the page can keep it to itself", () => {
      const { frame, turnOff } = make();
      editor.addEventListener("pointerdown", (event) => event.stopPropagation());
      editor.focus();
      press(editor, "touch", 500);
      for (let n = 0; n < CARD_FOCUS_TRIES; n++) grab(frame, 5000 + n);
      expect(turnOff).not.toHaveBeenCalled();
    });
  });

  describe(`a frame that takes the keyboard slowly: ${CARD_FOCUS_TRIES_IN_WINDOW} moves that count within ${CARD_FOCUS_WINDOW_MS / 1000} s turn it off, in a row or not`, () => {
    const press = (target: Element, kind: string, ms: number) => target.dispatchEvent(at(new PointerEvent("pointerdown", { pointerType: kind, bubbles: true, cancelable: true }), ms));
    /** With a finger: a move right after a key counts. */
    const counted = (frame: HTMLIFrameElement, ms: number) => {
      key(editor, "a", ms - 50);
      grab(frame, ms);
    };
    /** With a finger: a move this long after the last key does not count, and starts "in a row" again. */
    const notCounted = (frame: HTMLIFrameElement, afterCounted: number) => grab(frame, afterCounted + CARD_FOCUS_QUIET_MS);

    it("the numbers: three in a row, or ten in a minute", () => {
      expect(CARD_FOCUS_TRIES).toBe(3);
      expect(CARD_FOCUS_TRIES_IN_WINDOW).toBe(10);
      expect(CARD_FOCUS_WINDOW_MS).toBe(60_000);
    });

    it(`with a finger, never two in a row: ${CARD_FOCUS_TRIES_IN_WINDOW - 1} are not enough, the next one turns the card off, with the same words`, () => {
      const { frame, turnOff } = make();
      editor.focus();
      press(editor, "touch", 500);
      let now = 1000;
      for (let n = 1; n <= CARD_FOCUS_TRIES_IN_WINDOW; n++) {
        expect(turnOff, `before move ${n}`).not.toHaveBeenCalled();
        counted(frame, now);
        expect(document.activeElement).toBe(editor);
        if (n < CARD_FOCUS_TRIES_IN_WINDOW) notCounted(frame, now);
        now += 2000;
      }
      expect(turnOff).toHaveBeenCalledTimes(1);
      expect(live()!.textContent).toBe(CARD_TURNED_OFF_TEXT);
    });

    it("moves that do not count are not among the ten, however many there are", () => {
      const { frame, turnOff } = make();
      editor.focus();
      press(editor, "touch", 500);
      key(editor, "a", 1000);
      for (let n = 0; n < CARD_FOCUS_TRIES_IN_WINDOW * 3; n++) grab(frame, 1000 + CARD_FOCUS_QUIET_MS + n * 500);
      expect(turnOff).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(editor);
    });

    /** Nine moves that count, none in a row, the first at `first` and the others five seconds apart after it. */
    const nine = (frame: HTMLIFrameElement, first: number) => {
      for (let n = 0; n < CARD_FOCUS_TRIES_IN_WINDOW - 1; n++) {
        counted(frame, first + n * 5000);
        notCounted(frame, first + n * 5000);
      }
    };

    it("the edge of the minute: the tenth move one millisecond inside it turns the card off", () => {
      const { frame, turnOff } = make();
      editor.focus();
      press(editor, "touch", 500);
      nine(frame, 2000);
      expect(turnOff).not.toHaveBeenCalled();
      counted(frame, 2000 + CARD_FOCUS_WINDOW_MS - 1);
      expect(turnOff).toHaveBeenCalledTimes(1);
    });

    it("the edge of the minute: a full minute after the first, that first one is forgotten; and the minute slides, it does not start again", () => {
      const { frame, turnOff } = make();
      editor.focus();
      press(editor, "touch", 500);
      nine(frame, 2000);
      counted(frame, 2000 + CARD_FOCUS_WINDOW_MS);
      // Nine in the last minute: the second to the tenth.
      expect(turnOff).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(editor);
      notCounted(frame, 2000 + CARD_FOCUS_WINDOW_MS);
      // A minute of the clock that began at the tenth move would hold two moves now. The last sixty seconds hold ten.
      counted(frame, 2000 + CARD_FOCUS_WINDOW_MS + 2000);
      expect(turnOff).toHaveBeenCalledTimes(1);
    });

    it("a long time later the count is at nothing again", () => {
      const { frame, turnOff } = make();
      editor.focus();
      press(editor, "touch", 500);
      nine(frame, 2000);
      nine(frame, 2000 + 8 * 5000 + CARD_FOCUS_WINDOW_MS);
      expect(turnOff).not.toHaveBeenCalled();
    });

    it.each(["mouse", "pen"] as const)("with a %s every unauthorized move counts; a cover press starts only the count in a row again", (kind) => {
      const made = make();
      const { frame, turnOff } = made;
      editor.focus();
      press(editor, kind, 500);
      key(editor, "a", 1000);
      let now = 1000;
      const rounds = CARD_FOCUS_TRIES_IN_WINDOW / (CARD_FOCUS_TRIES - 1);
      for (let round = 1; round <= rounds; round++) {
        for (let n = 0; n < CARD_FOCUS_TRIES - 1; n++) {
          expect(turnOff, `round ${round}`).not.toHaveBeenCalled();
          grab(frame, (now += 100));
          expect(document.activeElement).toBe(editor);
        }
        if (round === rounds) break;
        // The person enters through this frame's cover.
        enterByCover(made, (now += 100), kind);
        expect(document.activeElement).toBe(frame);
        now += 100;
        editor.focus();
      }
      expect(now).toBeLessThan(CARD_FOCUS_WINDOW_MS);
      expect(turnOff).toHaveBeenCalledTimes(1);
      expect(live()!.textContent).toBe(CARD_TURNED_OFF_TEXT);
    });

    it("a frame that is loaded again starts both counts at nothing", () => {
      const first = make();
      editor.focus();
      press(editor, "touch", 500);
      nine(first.frame, 2000);
      const then = 2000 + 8 * 5000 + 2000;
      counted(first.frame, then);
      expect(first.turnOff).toHaveBeenCalledTimes(1);
      first.stop();
      // "Load it again": a new frame, in the same minute. The first card was the only one: the page still knows the finger.
      const second = make();
      editor.focus();
      for (let n = 0; n < CARD_FOCUS_TRIES - 1; n++) counted(second.frame, then + 1000 + n * 100);
      notCounted(second.frame, then + 1100);
      const more = CARD_FOCUS_TRIES_IN_WINDOW - 1 - (CARD_FOCUS_TRIES - 1);
      for (let n = 0; n < more; n++) {
        counted(second.frame, then + 3000 + n * 2000);
        notCounted(second.frame, then + 3000 + n * 2000);
      }
      // Two in a row and nine in the minute: neither count came over from the frame before.
      expect(second.turnOff).not.toHaveBeenCalled();
      counted(second.frame, then + 3000 + more * 2000);
      expect(second.turnOff).toHaveBeenCalledTimes(1);
    });

    it("each frame has its own count", () => {
      const first = make();
      const second = make();
      editor.focus();
      press(editor, "touch", 500);
      nine(first.frame, 2000);
      counted(second.frame, 2000 + 8 * 5000 + 2000);
      expect(first.turnOff).not.toHaveBeenCalled();
      expect(second.turnOff).not.toHaveBeenCalled();
    });
  });

  describe("what the page saw before there was a card, and between two cards", () => {
    const press = (target: Element, kind: string, ms: number) => target.dispatchEvent(at(new PointerEvent("pointerdown", { pointerType: kind, bubbles: true, cancelable: true }), ms));

    it("keys and presses are written down from the moment the code is loaded: two listeners on the document, none on the window", async () => {
      const onDocument = vi.spyOn(document, "addEventListener");
      const onWindow = vi.spyOn(page, "addEventListener");
      vi.resetModules();
      await import("./link-card-focus-guard");
      expect(onDocument.mock.calls.map((call) => [call[0], call[2]])).toEqual([
        ["keydown", true],
        ["pointerdown", true],
      ]);
      expect(onWindow).not.toHaveBeenCalled();
    });

    it("a finger pressed the page before the first card came (tap, type, paste a link): the card's frame is under the finger's rule from its first moment", () => {
      editor.focus();
      press(editor, "touch", 500);
      key(editor, "a", 1000);
      const { frame, turnOff } = make();
      for (let tap = 0; tap < CARD_FOCUS_TRIES + 1; tap++) {
        grab(frame, 1000 + CARD_FOCUS_QUIET_MS + tap * 700);
        expect(document.activeElement).toBe(editor);
      }
      expect(turnOff).not.toHaveBeenCalled();
    });

    it("a pointer on a newly made frame never becomes a wish to go in", () => {
      editor.focus();
      key(editor, "a", 1000);
      const { frame, box } = make();
      pointer(frame, "pointerenter", 1100);
      grab(frame, 1000 + CARD_FOCUS_QUIET_MS - 1);
      expect(document.activeElement).toBe(editor);
      expect(box.hasAttribute("data-has-keyboard")).toBe(false);
      grab(frame, 1000 + CARD_FOCUS_QUIET_MS);
      expect(document.activeElement).toBe(editor);
    });

    it("a Tab pressed before the card existed cannot authorize it", () => {
      editor.focus();
      key(editor, "Tab", 1000);
      const { frame } = make();
      grab(frame, 1010);
      expect(document.activeElement).toBe(editor);
    });

    it("the only card goes and another comes: the last key and the last press are still known", () => {
      const first = make();
      editor.focus();
      press(editor, "touch", 500);
      key(editor, "a", 1000);
      first.stop();
      const second = make();
      for (let tap = 0; tap < CARD_FOCUS_TRIES + 1; tap++) grab(second.frame, 1000 + CARD_FOCUS_QUIET_MS + tap * 700);
      expect(document.activeElement).toBe(editor);
      expect(second.turnOff).not.toHaveBeenCalled();
      // And the key: with a mouse now, pointer presence still never authorizes the replacement frame.
      const third = make();
      press(editor, "mouse", 9000);
      key(editor, "b", 9100);
      second.stop();
      third.stop();
      const fourth = make();
      pointer(fourth.frame, "pointerenter", 9200);
      grab(fourth.frame, 9100 + CARD_FOCUS_QUIET_MS - 1);
      expect(document.activeElement).toBe(editor);
      grab(fourth.frame, 9100 + CARD_FOCUS_QUIET_MS);
      expect(document.activeElement).toBe(editor);
    });
  });

  describe("the parent-owned activation cover", () => {
    it("covers every guarded frame immediately and replaces its direct Tab stop", () => {
      const first = make();
      const second = make();
      for (const made of [first, second]) {
        expect(made.frame.tabIndex).toBe(-1);
        expect(made.box.querySelectorAll(".md-link-card-cover")).toHaveLength(1);
        expect(cover(made.box)!.tagName).toBe("BUTTON");
        expect(cover(made.box)!.getAttribute("aria-label")).toBe(CARD_ENTER_FRAME_LABEL);
        expect(cover(made.box)!.previousElementSibling).toBe(made.frame);
      }
    });

    it("hover, movement, leaving, and elapsed quiet time never remove the cover or authorize focus", () => {
      const made = make();
      editor.focus();
      pointer(made.frame, "pointerenter", 1000);
      pointer(cover(made.box)!, "pointermove", 1500);
      pointer(cover(made.box)!, "pointerleave", 2000);
      expect(cover(made.box)).not.toBeNull();
      for (const now of [2001, 3000, 9000]) {
        grab(made.frame, now);
        expect(document.activeElement).toBe(editor);
      }
    });

    it.each(["mouse", "pen", "touch"] as const)("a fresh %s press authorizes this frame, is consumed, and is not passed on", (pointerType) => {
      const made = make();
      editor.focus();
      const pressed = enterByCover(made, 2100, pointerType);
      expect(pressed.defaultPrevented).toBe(true);
      expect(cover(made.box)).toBeNull();
      expect(document.activeElement).toBe(made.frame);
      expect(made.box.hasAttribute("data-has-keyboard")).toBe(true);
      editor.focus();
      expect(cover(made.box)).not.toBeNull();
      grab(made.frame, 2150);
      expect(document.activeElement).toBe(editor);
    });

    it("a verified activation is single-use even while the frame keeps focus", () => {
      const made = make();
      editor.focus();
      pointer(cover(made.box)!, "pointerdown", 2100, "mouse");
      page.dispatchEvent(at(new FocusEvent("blur"), 2101));
      vi.runOnlyPendingTimers();
      expect(document.activeElement).toBe(made.frame);
      page.dispatchEvent(at(new FocusEvent("blur"), 2102));
      vi.runOnlyPendingTimers();
      expect(document.activeElement).toBe(editor);
    });

    it.each([
      ["too old", 251],
      ["from the future", -1],
    ])("a cover activation that is %s is rejected", (_name, age) => {
      const made = make();
      editor.focus();
      pointer(cover(made.box)!, "pointerdown", 2100, "mouse");
      page.dispatchEvent(at(new FocusEvent("blur"), 2100 + age));
      vi.runOnlyPendingTimers();
      expect(document.activeElement).toBe(editor);
    });

    it("ordinary page focus invalidates a pending activation", () => {
      const made = make();
      editor.focus();
      pointer(cover(made.box)!, "pointerdown", 2100, "mouse");
      editor.focus();
      made.frame.focus();
      page.dispatchEvent(at(new FocusEvent("blur"), 2101));
      vi.runOnlyPendingTimers();
      expect(document.activeElement).toBe(editor);
    });

    it("stopping another guard does not invalidate this frame's activation", () => {
      const first = make();
      const second = make();
      editor.focus();
      pointer(cover(first.box)!, "pointerdown", 2100, "mouse");
      second.stop();
      page.dispatchEvent(at(new FocusEvent("blur"), 2101));
      vi.runOnlyPendingTimers();
      expect(document.activeElement).toBe(first.frame);
    });

    it("a press on one frame cannot authorize another frame", () => {
      const first = make();
      const second = make();
      editor.focus();
      pointer(cover(first.box)!, "pointerdown", 2100, "mouse");
      grab(second.frame, 2110);
      expect(document.activeElement).toBe(editor);
      expect(second.box.hasAttribute("data-has-keyboard")).toBe(false);
    });

    it("an unsupported pointer type cannot authorize a frame", () => {
      const made = make();
      editor.focus();
      const pressed = pointer(cover(made.box)!, "pointerdown", 2100, "");
      expect(pressed.defaultPrevented).toBe(true);
      grab(made.frame, 2110);
      expect(document.activeElement).toBe(editor);
    });

    it("a press whose focus failed is invalid immediately, not available to the frame later", () => {
      const made = make();
      editor.focus();
      vi.spyOn(made.frame, "focus").mockImplementationOnce(() => {});
      pointer(cover(made.box)!, "pointerdown", 2100, "mouse");
      expect(cover(made.box)).not.toBeNull();
      grab(made.frame, 2110);
      expect(document.activeElement).toBe(editor);
    });

    it("script click on a directly focused proxy cannot authorize the frame", () => {
      const made = make();
      editor.focus();
      cover(made.box)!.focus();
      cover(made.box)!.click();
      expect(document.activeElement).toBe(cover(made.box));
      grab(made.frame, 2110);
      expect(document.activeElement).toBe(editor);
    });

    it("a Tab capability is exact: another frame racing it is rejected", () => {
      const first = make();
      const second = make();
      editor.focus();
      key(editor, "Tab", 1000);
      cover(first.box)!.dispatchEvent(at(new FocusEvent("focus"), 1001));
      grab(second.frame, 1002);
      expect(document.activeElement).toBe(editor);
      grab(first.frame, 1003);
      expect(document.activeElement).toBe(editor);
    });

    it("modified, default-prevented, stale, and unrelated keys cannot activate the cover", () => {
      const cases: Array<[string, KeyboardEventInit, number, boolean]> = [
        ["Tab", { ctrlKey: true }, 1, false],
        ["Tab", { altKey: true }, 1, false],
        ["Tab", { metaKey: true }, 1, false],
        ["Enter", {}, 1, false],
        ["Tab", {}, -1, false],
        ["Tab", {}, 251, false],
        ["Tab", {}, 1, true],
      ];
      for (const [name, init, later, prevent] of cases) {
        const made = make();
        editor.focus();
        const stop = prevent ? (() => editor.addEventListener("keydown", (event) => event.preventDefault(), { once: true })) : () => {};
        stop();
        key(editor, name, 1000, init);
        cover(made.box)!.dispatchEvent(at(new FocusEvent("focus"), 1000 + later));
        grab(made.frame, 1000 + later + 1);
        expect(document.activeElement).toBe(editor);
      }
    });
  });

  describe("ending, and failing safe", () => {
    it("stopping while an unauthorized frame is quarantined cancels reinsertion and removes the cover", () => {
      const made = make();
      editor.focus();
      made.frame.focus();
      page.dispatchEvent(at(new FocusEvent("blur"), 2100));
      expect(made.frame.isConnected).toBe(false);
      const pending = vi.getTimerCount();
      expect(pending).toBeGreaterThan(0);
      made.stop();
      expect(vi.getTimerCount()).toBe(pending - 1);
      vi.runOnlyPendingTimers();
      expect(made.frame.isConnected).toBe(false);
      expect(cover(made.box)).toBeNull();
    });

    it("the guard of a frame ends: no cover, no ring, and the frame is no longer watched", () => {
      const made = make();
      const { frame, box, stop, turnOff } = made;
      const other = make();
      button.focus();
      enterByCover(made, 1100);
      expect(box.hasAttribute("data-has-keyboard")).toBe(true);
      editor.focus();
      expect(cover(box)).not.toBeNull();
      stop();
      expect(cover(box)).toBeNull();
      expect(frame.getAttribute("tabindex")).toBeNull();
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
      expect(added.sort()).toEqual(["document focusin", "document focusout", "window blur", "window focus"]);
      first.stop();
      expect(removed).toEqual([]);
      second.stop();
      expect(removed.sort()).toEqual(["document focusin", "document focusout", "window blur", "window focus"]);
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
      expect(cover(box)).not.toBeNull();
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
      expect(removed.mock.calls.map((call) => call[0]).sort()).toEqual(["focusin", "focusout"]);
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
