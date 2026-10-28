/**
 * The focus guard for card frames (#2338). A provider's embed page runs its own script inside the frame,
 * and no sandbox token stops that script from taking keyboard focus (`window.focus()` plus a field of its
 * own). Keys typed then go to the frame, not to the document. `inert` on the frame does not stop it either
 * (measured in Chromium: the frame still received every key). So this guard quarantines an unauthorized
 * focus target synchronously: it detaches the frame before input can be delivered, restores page focus,
 * then reinserts the frame after accounting for the move. Reinsertion reloads the provider page. A frame
 * is turned off after `CARD_FOCUS_TRIES` such moves in a row, or after `CARD_FOCUS_TRIES_IN_WINDOW` of
 * them within `CARD_FOCUS_WINDOW_MS`, in a row or not: three in a row, or ten in a minute.
 *
 * A move of focus into a frame is meant only when the parent page saw a fresh action for that exact
 * frame. A see-through button covers every guarded frame while the keyboard is in the page. Mouse, pen
 * and touch presses on it are consumed, then focus the frame. The same button is the frame's place in
 * sequential keyboard navigation: an unmodified, non-repeated Tab or Shift+Tab that focuses it
 * immediately enters that frame. Enter and Space on the focused button enter it; browser
 * accessibility activation uses the button click. The capability is tied to one guarded frame,
 * expires after `MOVE_FRESH_MS`, and is consumed by the first focus decision.
 *
 * Pointer presence, pointer movement, elapsed quiet time, and provider messages never authorize focus.
 * The first press is therefore a deliberate security cost: it gives the frame the keyboard but does not
 * reach the provider's control. A second press operates that control. This is the same for mouse, pen and
 * touch because the parent cannot securely forward an activation into a cross-origin frame.
 *
 * Touch still has its own counting rule for provider-initiated moves: one counts only when a key was
 * typed in the page in the last `CARD_FOCUS_QUIET_MS`, so idle focus churn after a touch does not turn an
 * honest card off. That distinction changes only counting, never authorization.
 *
 * It only uses the page's own events. It never listens to a message from a frame. Where a browser does
 * not send these events as Chromium does, nothing here runs and the frame behaves as it did before.
 */

/** An unauthorized move after touch counts only while the last page key is newer than this. */
export const CARD_FOCUS_QUIET_MS = 1000;
/** After this many moves of focus in a row that were not meant, the frame is turned off. */
export const CARD_FOCUS_TRIES = 3;
/** Also after this many of them within `CARD_FOCUS_WINDOW_MS`, with moves that were meant or did not count in between. */
export const CARD_FOCUS_TRIES_IN_WINDOW = 10;
/** The window slides: it is the time before the move that is being judged, not a minute of the clock. */
export const CARD_FOCUS_WINDOW_MS = 60_000;
/** A Tab, or a press on the cover, moves focus into the frame at once; this is how fresh it must be to count. */
const MOVE_FRESH_MS = 250;
export const CARD_ENTER_FRAME_LABEL = "Enter embedded content";

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
  cover: HTMLElement | null;
  originalTabIndex: string | null;
  reattach: ReturnType<typeof setTimeout> | null;
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
  /** The kind of the last press the page saw. It affects counting only, never authorization. */
  pointerType: string;
}

const seenByPage = new WeakMap<Document, Seen>();

function seenIn(doc: Document): Seen {
  const existing = seenByPage.get(doc);
  if (existing) return existing;
  const seen: Seen = { lastKeyAt: -Infinity, lastKey: null, pointerType: "" };
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
      seen.pointerType = event.pointerType;
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
  /** One short-lived, single-use permission for one exact guarded frame generation. */
  entering: { guarded: Guarded; at: number; kind: ActivationKind } | null;
  /** The last Tab event used or made unavailable by a newly created cover. */
  usedTab: KeyboardEvent | null;
  ensureCover: (guarded: Guarded) => void;
  stop: () => void;
}

const guards = new WeakMap<Document, PageGuard>();
type ActivationKind = "keyboard" | "mouse" | "pen" | "touch";

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
  const guard: PageGuard = { frames: new Map(), focused: doc.activeElement, entering: null, usedTab: seen.lastKey, ensureCover: () => {}, stop: () => {} };

  function enter(guarded: Guarded, at: number, kind: ActivationKind, keepCover = false) {
    guard.entering = { guarded, at, kind };
    if (!keepCover) removeCover(guarded);
    guarded.frame.focus();
    if (doc.activeElement !== guarded.frame) {
      guard.entering = null;
      ensureCover(guarded);
    }
  }

  function ensureCover(guarded: Guarded) {
    if (guarded.cover || doc.activeElement === guarded.frame || !guarded.frame.isConnected) return;
    const box = guarded.frame.parentElement;
    if (!box) return;
    const cover = doc.createElement("button");
    cover.type = "button";
    cover.className = "md-link-card-cover";
    cover.setAttribute("data-card-cover", "");
    cover.setAttribute("aria-label", CARD_ENTER_FRAME_LABEL);
    cover.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (event.pointerType !== "mouse" && event.pointerType !== "pen" && event.pointerType !== "touch") return;
      enter(guarded, event.timeStamp, event.pointerType, true);
    });
    cover.addEventListener("pointerup", (event) => {
      event.preventDefault();
      setTimeout(() => {
        if (doc.activeElement === guarded.frame) removeCover(guarded);
      }, 0);
    });
    cover.addEventListener("keydown", (event) => {
      const wasPrevented = event.defaultPrevented;
      if (wasPrevented || event.repeat || event.ctrlKey || event.altKey || event.metaKey || doc.activeElement !== cover) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      // ProseMirror prevents the later native button click while the event bubbles. Activate at the
      // button itself, before that editor handling, and prevent Space from scrolling the page.
      event.preventDefault();
      enter(guarded, event.timeStamp, "keyboard");
    });
    cover.addEventListener("click", (event) => {
      const wasPrevented = event.defaultPrevented;
      event.preventDefault();
      if (doc.activeElement === guarded.frame) {
        removeCover(guarded);
        return;
      }
      // Browser accessibility activation is a click with no pointer click count.
      if (wasPrevented || event.detail !== 0 || event.ctrlKey || event.altKey || event.metaKey || doc.activeElement !== cover) return;
      enter(guarded, event.timeStamp, "keyboard");
    });
    cover.addEventListener("focus", (event) => {
      const key = seen.lastKey;
      if (!key || key === guard.usedTab) return;
      guard.usedTab = key;
      const age = key ? event.timeStamp - key.timeStamp : Infinity;
      if (key.key !== "Tab" || key.repeat || key.defaultPrevented || key.ctrlKey || key.altKey || key.metaKey || age < 0 || age > MOVE_FRESH_MS) return;
      enter(guarded, event.timeStamp, "keyboard");
    });
    guarded.cover = cover;
    // A Tab that happened before this proxy existed cannot become its authorization later.
    guard.usedTab = seen.lastKey;
    box.appendChild(cover);
  }
  guard.ensureCover = ensureCover;

  const onFocusIn = (event: FocusEvent) => {
    if (!(event.target instanceof Element) || event.target instanceof win.HTMLIFrameElement || event.target.hasAttribute("data-card-cover")) return;
    guard.entering = null;
    guard.focused = event.target;
    for (const guarded of guard.frames.values()) ensureCover(guarded);
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

  const meant = (guarded: Guarded, now: number): boolean => {
    const entering = guard.entering;
    guard.entering = null;
    if (entering?.guarded !== guarded) return false;
    const age = now - entering.at;
    return age >= 0 && age <= MOVE_FRESH_MS;
  };

  const accept = (guarded: Guarded) => {
    guarded.tries = 0;
    // Shows where the keyboard is while the frame has it.
    guarded.frame.parentElement?.setAttribute("data-has-keyboard", "");
  };

  const restore = (guarded: Guarded, from: Element | null) => {
    win.focus();
    if (from instanceof win.HTMLElement && from.isConnected) from.focus({ preventScroll: true });
    if (doc.activeElement === guarded.frame) guarded.frame.blur();
  };

  const recordRejection = (guarded: Guarded, now: number) => {
    // After touch, idle provider focus churn does not turn an honest card off. This does not authorize it.
    if (seen.pointerType === "touch" && now - seen.lastKeyAt >= CARD_FOCUS_QUIET_MS) guarded.tries = 0;
    else {
      guarded.tries++;
      guarded.counted.push(now);
    }
    guarded.counted = guarded.counted.filter((at) => now - at < CARD_FOCUS_WINDOW_MS);
    const off = guarded.tries >= CARD_FOCUS_TRIES || guarded.counted.length >= CARD_FOCUS_TRIES_IN_WINDOW;
    if (off) {
      guarded.turnOff();
      // Said once, and taken away again so that it is not found later by somebody reading the page.
      live.textContent = CARD_TURNED_OFF_TEXT;
      setTimeout(() => {
        if (live.textContent === CARD_TURNED_OFF_TEXT) live.textContent = "";
      }, STATUS_STAYS_MS);
    }
    return off;
  };

  const quarantine = (guarded: Guarded, from: Element | null, now: number) => {
    const parent = guarded.frame.parentNode;
    const next = guarded.frame.nextSibling;
    if (!parent) {
      restore(guarded, from);
      guarded.stop();
      return;
    }
    // Focus restoration from inside the blur event is otherwise undone by the focus move itself. Remove
    // the unauthorized target synchronously so it cannot receive input during this task.
    guarded.frame.remove();
    restore(guarded, from);
    guarded.reattach = setTimeout(() => {
      guarded.reattach = null;
      if (guard.frames.get(guarded.frame) !== guarded) return;
      if (!(parent instanceof win.Node) || !parent.isConnected) {
        guarded.stop();
        return;
      }
      if (recordRejection(guarded, now) || guard.frames.get(guarded.frame) !== guarded) return;
      parent.insertBefore(guarded.frame, next?.parentNode === parent ? next : null);
      // The browser may finish the original focus transition after the synchronous restore. Reassert it
      // after reinsertion, without scrolling or changing the editor's selection.
      restore(guarded, from);
      ensureCover(guarded);
    }, 0);
  };

  const decide = (now: number) => {
    const active = doc.activeElement;
    const guarded = active instanceof win.HTMLIFrameElement ? guard.frames.get(active) : undefined;
    if (!guarded) return false;
    const from = guard.focused;
    const wasMeant = meant(guarded, now);
    guard.entering = null;
    if (wasMeant) accept(guarded);
    else quarantine(guarded, from, now);
    return true;
  };

  const onWindowBlur = (event: FocusEvent) => {
    if (event.target instanceof win.Node) return; // from an element of the page, not the window itself
    const at = event.timeStamp;
    // Chromium exposes the active frame here. Decide synchronously so an unauthorized frame is detached
    // before the next key, paste, composition, beforeinput, or input event can be delivered.
    if (decide(at)) return;
    // Other focus destinations, and browsers that expose the target later, are checked after the move.
    setTimeout(() => {
      decide(at);
      // A frame that left the page without its owner saying so (the page's content was replaced) is forgotten here.
      for (const guarded of [...guard.frames.values()]) if (!guarded.frame.isConnected) guarded.stop();
    }, 0);
  };

  const onWindowFocus = (event: FocusEvent) => {
    if (event.target instanceof win.Node) return; // from an element of the page, not the window itself
    for (const guarded of guard.frames.values()) {
      guarded.frame.parentElement?.removeAttribute("data-has-keyboard");
      ensureCover(guarded);
    }
  };

  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("focusout", onFocusOut, true);
  win.addEventListener("blur", onWindowBlur);
  win.addEventListener("focus", onWindowFocus);
  guard.stop = () => {
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
  const guarded: Guarded = {
    frame,
    turnOff,
    tries: 0,
    counted: [],
    cover: null,
    originalTabIndex: frame.getAttribute("tabindex"),
    reattach: null,
    stop: () => {},
  };
  frame.tabIndex = -1;
  guarded.stop = () => {
    if (guard.frames.get(frame) !== guarded) return;
    if (guard.entering?.guarded === guarded) guard.entering = null;
    if (guarded.reattach !== null) clearTimeout(guarded.reattach);
    guarded.reattach = null;
    removeCover(guarded);
    if (guarded.originalTabIndex === null) frame.removeAttribute("tabindex");
    else frame.setAttribute("tabindex", guarded.originalTabIndex);
    frame.parentElement?.removeAttribute("data-has-keyboard");
    guard.frames.delete(frame);
    if (guard.frames.size === 0) guard.stop();
  };
  guard.frames.set(frame, guarded);
  guard.ensureCover(guarded);
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
