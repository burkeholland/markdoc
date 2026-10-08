/**
 * The focus guard for card frames (#2338). A provider's embed page runs its own script inside the frame,
 * and no sandbox token stops that script from taking keyboard focus (`window.focus()` plus a field of its
 * own). Keys typed then go to the frame, not to the document. `inert` on the frame does not stop it either
 * (measured in Chromium: the frame still received every key). So this guard reacts: when focus moves into
 * a card's frame and the page did not see the person go there, it gives focus back to where it was. A
 * frame is turned off after `CARD_FOCUS_TRIES` such moves in a row, or after `CARD_FOCUS_TRIES_IN_WINDOW`
 * of them within `CARD_FOCUS_WINDOW_MS`, in a row or not: three in a row, or ten in a minute.
 *
 * A move of focus into a frame is meant when one of these holds:
 *  - focus was not in a place where text is typed (nothing to protect: a viewer, the published page);
 *  - it follows a Tab or Shift+Tab that the page saw and nothing in the page used for itself;
 *  - the pointer is on that frame, came there after the last key typed in the page, and that key is at
 *    least `CARD_FOCUS_QUIET_MS` old (a pointer that a palm moved onto the card between two keys is not
 *    a wish to leave the document);
 *  - the person pressed on the frame's cover (below), which the page sees itself.
 *
 * The page cannot see the pointer move or press inside a frame, only that it came onto the frame's box.
 * So when a key is typed in the page while the pointer rests on a frame, a see-through cover goes over
 * that frame: the next pointer movement there is seen by the page and takes the cover away again.
 *
 * A finger is different: for a touch the page gets no pointer event on a frame at all (measured), so the
 * third condition can never hold. After a touch press that the page saw, and with focus in a place where
 * text is typed, every move of focus into a frame is given back, also a tap in a player: the tap itself
 * still lands in the frame, so Play and Pause work, and the keyboard stays with the document. Such a move
 * counts against the frame only when a key was typed in the page in the last `CARD_FOCUS_QUIET_MS`; one
 * that does not count starts the count in a row again. Otherwise the third tap in a player would turn its
 * card off. A frame that takes the keyboard slowly enough is never three in a row then (measured: every
 * two seconds, while the person pauses five seconds between bursts of typing); the count per minute is
 * for that frame. It is not started again by anything but a new frame.
 *
 * It only uses the page's own events. It never listens to a message from a frame. Where a browser does
 * not send these events as Chromium does, nothing here runs and the frame behaves as it did before.
 */

/** A pointer on the frame is a wish to go in only when the last key typed in the page is this old. */
export const CARD_FOCUS_QUIET_MS = 1000;
/** After this many moves of focus in a row that were not meant, the frame is turned off. */
export const CARD_FOCUS_TRIES = 3;
/** Also after this many of them within `CARD_FOCUS_WINDOW_MS`, with moves that were meant or did not count in between. */
export const CARD_FOCUS_TRIES_IN_WINDOW = 10;
/** The window slides: it is the time before the move that is being judged, not a minute of the clock. */
export const CARD_FOCUS_WINDOW_MS = 60_000;
/** A Tab, or a press on the cover, moves focus into the frame at once; this is how fresh it must be to count. */
const MOVE_FRESH_MS = 250;

/** How long the words stay in the page's live region after they were said. */
const STATUS_STAYS_MS = 10_000;

export const CARD_TURNED_OFF_TEXT = "This card kept taking the keyboard away from your document, so it was turned off.";
export const CARD_LOAD_AGAIN_LABEL = "Load it again";

interface Guarded {
  frame: HTMLIFrameElement;
  turnOff: () => void;
  /** Moves of focus into this frame that were not meant, since the person last really went in. */
  tries: number;
  /** When each of the moves that counted happened, as far back as `CARD_FOCUS_WINDOW_MS`. Only a new frame starts this again. */
  counted: number[];
  pointerInside: boolean;
  /** When the page last saw the pointer on this frame (the time of that event). */
  pointerAt: number;
  cover: HTMLElement | null;
  stop: () => void;
}

/**
 * What the person last did in the page. It is watched from the moment this code is loaded, not from the
 * first card: a person taps into the document, types, pastes a link, and the card that appears then must
 * already know that the last press was a finger and when the last key was typed. It also outlives the
 * cards: when the only card is turned off and loaded again, nothing is forgotten.
 */
interface Seen {
  /** The time of the last key typed in the page; -Infinity before the first. */
  lastKeyAt: number;
  /** The last key event the page saw, to ask later whether it was a Tab that nothing used. */
  lastKey: KeyboardEvent | null;
  /** The last press the page saw itself was a finger: the page cannot see that pointer on a frame. */
  touch: boolean;
}

const seenByPage = new WeakMap<Document, Seen>();

function seenIn(doc: Document): Seen {
  const existing = seenByPage.get(doc);
  if (existing) return existing;
  const seen: Seen = { lastKeyAt: -Infinity, lastKey: null, touch: false };
  // Two listeners for the life of the page, before anything in the page can keep the event to itself. They only write down.
  doc.addEventListener(
    "keydown",
    (event) => {
      seen.lastKey = event;
      seen.lastKeyAt = event.timeStamp;
    },
    true,
  );
  doc.addEventListener(
    "pointerdown",
    (event) => {
      seen.touch = event.pointerType === "touch";
    },
    true,
  );
  seenByPage.set(doc, seen);
  return seen;
}

if (typeof document !== "undefined") seenIn(document);

interface PageGuard {
  frames: Map<HTMLIFrameElement, Guarded>;
  /** Where focus was before it left the page: the last element of the page that had it. */
  focused: Element | null;
  /** The frame whose cover the person just pressed, and when: that move is the person's own. */
  entering: { frame: HTMLIFrameElement; at: number } | null;
  stop: () => void;
}

const guards = new WeakMap<Document, PageGuard>();

/** A place where text is typed, by what it is and not by which component made it. */
export function isTypingPlace(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const editable = element.getAttribute("contenteditable");
  if (element.isContentEditable || editable === "true" || editable === "" || editable === "plaintext-only") return true;
  // An editor that is shown read-only (a viewer's preview) still calls itself a text box. Nothing is typed there.
  if (editable === "false") return false;
  if (element.tagName === "TEXTAREA") return !(element as HTMLTextAreaElement).readOnly && !(element as HTMLTextAreaElement).disabled;
  if (element.tagName === "INPUT") {
    const input = element as HTMLInputElement;
    return !input.readOnly && !input.disabled && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(input.type);
  }
  const role = element.getAttribute("role");
  return (role === "textbox" || role === "searchbox" || role === "combobox") && element.getAttribute("aria-readonly") !== "true";
}

function removeCover(guarded: Guarded) {
  guarded.cover?.remove();
  guarded.cover = null;
}

/**
 * The page's one place that says aloud that a card was turned off. It is in the page from the first
 * guarded frame on, before any words arrive, as a live region must be, and it stays.
 */
function liveRegion(doc: Document): HTMLElement {
  const existing = doc.querySelector<HTMLElement>("[data-card-focus-status]");
  if (existing) return existing;
  const live = doc.createElement("div");
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("data-card-focus-status", "");
  live.style.cssText = "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";
  doc.body.appendChild(live);
  return live;
}

function pageGuard(doc: Document): PageGuard | null {
  const existing = guards.get(doc);
  if (existing) return existing;
  const win = doc.defaultView;
  if (!win) return null;
  const live = liveRegion(doc);

  const seen = seenIn(doc);
  const guard: PageGuard = { frames: new Map(), focused: doc.activeElement, entering: null, stop: () => {} };

  const onKeyDown = () => {
    // The person is typing in the page. A pointer that rests on a frame is now invisible to the page: cover that frame.
    for (const guarded of guard.frames.values()) {
      if (!guarded.pointerInside || guarded.cover || doc.activeElement === guarded.frame) continue;
      const box = guarded.frame.parentElement;
      if (!box) continue;
      const cover = doc.createElement("div");
      cover.className = "md-link-card-cover";
      cover.setAttribute("data-card-cover", "");
      cover.setAttribute("aria-hidden", "true");
      const pointerSeen = (moved: PointerEvent) => {
        guarded.pointerInside = true;
        guarded.pointerAt = moved.timeStamp;
        removeCover(guarded);
      };
      cover.addEventListener("pointermove", pointerSeen);
      cover.addEventListener("pointerdown", (pressed) => {
        // A press the page sees itself: the person goes into the frame. The press is not passed on.
        pressed.preventDefault();
        pointerSeen(pressed);
        guard.entering = { frame: guarded.frame, at: pressed.timeStamp };
        guarded.frame.focus();
      });
      cover.addEventListener("pointerleave", () => {
        guarded.pointerInside = false;
        removeCover(guarded);
      });
      guarded.cover = cover;
      box.appendChild(cover);
    }
  };

  const onFocusIn = (event: FocusEvent) => {
    if (event.target instanceof Element && !(event.target instanceof win.HTMLIFrameElement)) guard.focused = event.target;
  };

  // Focus left an element for no other one. If it stays in the page (a click on the page's background),
  // the person is no longer in that place; if it went into a frame, that place is where to go back to.
  const onFocusOut = (event: FocusEvent) => {
    if (event.relatedTarget) return;
    const left = event.target;
    setTimeout(() => {
      if (guard.focused === left && doc.hasFocus() && (doc.activeElement === doc.body || doc.activeElement === null)) guard.focused = null;
    }, 0);
  };

  const meant = (guarded: Guarded, from: Element | null, now: number): boolean => {
    if (guard.entering && guard.entering.frame === guarded.frame && now - guard.entering.at <= MOVE_FRESH_MS) return true;
    if (!isTypingPlace(from)) return true;
    const key = seen.lastKey;
    if (key && key.key === "Tab" && !key.defaultPrevented && !key.ctrlKey && !key.altKey && !key.metaKey && now - key.timeStamp <= MOVE_FRESH_MS) return true;
    // After a press with a finger the page cannot know where the pointer is: it never says the person went in.
    if (seen.touch) return false;
    return guarded.pointerInside && !guarded.cover && guarded.pointerAt > seen.lastKeyAt && now - seen.lastKeyAt >= CARD_FOCUS_QUIET_MS;
  };

  const decide = (now: number) => {
    const active = doc.activeElement;
    const guarded = active instanceof win.HTMLIFrameElement ? guard.frames.get(active) : undefined;
    if (!guarded) return false;
    const from = guard.focused;
    const wasMeant = meant(guarded, from, now);
    guard.entering = null;
    if (wasMeant) {
      guarded.tries = 0;
      // Shows where the keyboard is while the frame has it.
      guarded.frame.parentElement?.setAttribute("data-has-keyboard", "");
      return true;
    }
    // With a finger a tap in a player comes here too. It counts only while the person is typing.
    if (seen.touch && now - seen.lastKeyAt >= CARD_FOCUS_QUIET_MS) guarded.tries = 0;
    else {
      guarded.tries++;
      guarded.counted.push(now);
    }
    guarded.counted = guarded.counted.filter((at) => now - at < CARD_FOCUS_WINDOW_MS);
    const off = guarded.tries >= CARD_FOCUS_TRIES || guarded.counted.length >= CARD_FOCUS_TRIES_IN_WINDOW;
    // Back to where the person was. An editor puts its own selection back when it gets focus again.
    win.focus();
    if (from instanceof win.HTMLElement && from.isConnected) from.focus({ preventScroll: true });
    else guarded.frame.blur();
    if (off) {
      guarded.turnOff();
      // Said once, and taken away again so that it is not found later by somebody reading the page.
      live.textContent = CARD_TURNED_OFF_TEXT;
      setTimeout(() => {
        if (live.textContent === CARD_TURNED_OFF_TEXT) live.textContent = "";
      }, STATUS_STAYS_MS);
    } else if (doc.activeElement === guarded.frame) {
      // The browser did not give focus back. Then at least the card shows where the keyboard is.
      guarded.frame.parentElement?.setAttribute("data-has-keyboard", "");
    }
    return true;
  };

  const onWindowBlur = (event: FocusEvent) => {
    if (event.target instanceof win.Node) return; // from an element of the page, not the window itself
    // Focus left the page. If it went into a guarded frame, that frame is the page's active element now.
    // The answer waits for the browser to finish this move: focus given back from inside the blur event
    // is undone by the move itself (measured in Chromium with a frame of another site).
    const at = event.timeStamp;
    setTimeout(() => {
      decide(at);
      // A frame that left the page without its owner saying so (the page's content was replaced) is forgotten here.
      for (const guarded of [...guard.frames.values()]) if (!guarded.frame.isConnected) guarded.stop();
    }, 0);
  };

  const onWindowFocus = (event: FocusEvent) => {
    if (event.target instanceof win.Node) return; // from an element of the page, not the window itself
    for (const guarded of guard.frames.values()) guarded.frame.parentElement?.removeAttribute("data-has-keyboard");
  };

  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("focusout", onFocusOut, true);
  win.addEventListener("blur", onWindowBlur);
  win.addEventListener("focus", onWindowFocus);
  guard.stop = () => {
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("focusin", onFocusIn, true);
    doc.removeEventListener("focusout", onFocusOut, true);
    win.removeEventListener("blur", onWindowBlur);
    win.removeEventListener("focus", onWindowFocus);
    if (guards.get(doc) === guard) guards.delete(doc);
  };
  guards.set(doc, guard);
  return guard;
}

/**
 * Guard one card frame. `turnOff` is called when the frame took focus without the person
 * `CARD_FOCUS_TRIES` times in a row, or `CARD_FOCUS_TRIES_IN_WINDOW` times within `CARD_FOCUS_WINDOW_MS`:
 * the owner then takes the frame out and shows the notice. Returns the function that ends the guard for
 * this frame (the card is gone, or its frame is replaced). A frame that is loaded again is a new frame
 * and is guarded anew, so both counts start at nothing.
 */
export function guardCardFrame(frame: HTMLIFrameElement, turnOff: () => void): () => void {
  const doc = frame.ownerDocument;
  const guard = pageGuard(doc);
  if (!guard) return () => {};
  const guarded: Guarded = { frame, turnOff, tries: 0, counted: [], pointerInside: false, pointerAt: -Infinity, cover: null, stop: () => {} };
  const onEnter = (event: PointerEvent) => {
    guarded.pointerInside = true;
    guarded.pointerAt = event.timeStamp;
  };
  // (The cover going on under the pointer also fires this. Nothing depends on it: while the cover is on,
  // the cover itself says where the pointer is.)
  const onLeave = () => {
    guarded.pointerInside = false;
  };
  frame.addEventListener("pointerenter", onEnter);
  frame.addEventListener("pointerleave", onLeave);
  guarded.stop = () => {
    if (guard.frames.get(frame) !== guarded) return;
    frame.removeEventListener("pointerenter", onEnter);
    frame.removeEventListener("pointerleave", onLeave);
    removeCover(guarded);
    frame.parentElement?.removeAttribute("data-has-keyboard");
    guard.frames.delete(frame);
    if (guard.frames.size === 0) guard.stop();
  };
  guard.frames.set(frame, guarded);
  return guarded.stop;
}

/**
 * What a card shows in place of a frame that was turned off: the words and a button that loads the frame
 * again. The words here are for the eye; the page's live region has already said them once.
 */
export function createTurnedOffNotice(onLoadAgain: () => void, doc: Document = document): HTMLElement {
  const notice = doc.createElement("div");
  notice.className = "md-link-card-off";
  notice.setAttribute("data-testid", "link-card-off");
  const words = doc.createElement("p");
  words.textContent = CARD_TURNED_OFF_TEXT;
  const again = doc.createElement("button");
  again.type = "button";
  again.className = "md-link-card-load";
  again.textContent = CARD_LOAD_AGAIN_LABEL;
  again.setAttribute("data-testid", "link-card-load-again");
  again.addEventListener("click", (event) => {
    event.preventDefault();
    onLoadAgain();
  });
  notice.append(words, again);
  return notice;
}
