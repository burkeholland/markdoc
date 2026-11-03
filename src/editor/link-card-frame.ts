/**
 * The one place a frame is made (#2317). The editor's card and the published page both come here, with a
 * card from `matchLinkCard`: the address is the provider's fixed host plus a path built from an id, and
 * the attributes are the ones `link-cards.ts` names. No script from another site runs in a Markdoc page;
 * the provider's page runs inside this frame, in its own origin, and the page never listens to it.
 */
import { CARD_FRAME_ALLOW, CARD_FRAME_HOSTS, CARD_FRAME_REFERRER_POLICY, cardFrameTitle, MAX_CARD_FRAMES, type LinkCard } from "./markdown/link-cards";

/**
 * A frame to the card's embed page, not yet in the document, or null when there must not be one: the
 * address is not on a listed host, or that host is this page's own origin (a frame with the page's own
 * origin and scripts could lift its sandbox).
 */
export function createCardFrame(card: LinkCard, url: string, doc: Document = document): HTMLIFrameElement | null {
  const host = CARD_FRAME_HOSTS.find((origin) => card.frameUrl.startsWith(`${origin}/`));
  if (!host || host === doc.defaultView?.location.origin) return null;
  const frame = doc.createElement("iframe");
  // The limits first, the address last: a frame starts to load as soon as it has an address and a document.
  frame.setAttribute("sandbox", card.sandbox);
  frame.setAttribute("allow", CARD_FRAME_ALLOW);
  frame.setAttribute("referrerpolicy", CARD_FRAME_REFERRER_POLICY);
  frame.setAttribute("loading", "lazy");
  frame.setAttribute("title", cardFrameTitle(card, url));
  frame.className = "md-link-card-iframe";
  frame.setAttribute("src", card.frameUrl);
  return frame;
}

const CARD_FRAME_PROBE_TIMEOUT_MS = 5_000;
const CARD_FRAME_PROBE_ROOT_MARGIN = "300px 0px";
const loadedCardFrames = new WeakSet<HTMLIFrameElement>();

async function cardFrameHostResponds(frameUrl: string, signal: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CARD_FRAME_PROBE_TIMEOUT_MS);
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    await fetch(frameUrl, { method: "HEAD", mode: "no-cors", signal: controller.signal });
    return true;
  } catch (error) {
    if (
      signal.aborted ||
      error instanceof TypeError ||
      (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      return false;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

/**
 * Browsers disagree on whether a failed iframe fires `load`. Check a lazy video when it nears the
 * viewport as well, and keep it hidden until a lightweight request confirms that its host is reachable.
 */
export function watchCardFrameAvailability(
  frame: HTMLIFrameElement,
  card: LinkCard,
  box: HTMLElement,
  onUnavailable: () => void,
): () => void {
  if (card.kind !== "video") return () => {};
  let stopped = false;
  let checked = false;
  let generation = 0;
  let request: AbortController | null = null;
  let observer: IntersectionObserver | null = null;
  box.setAttribute("data-checking", "");

  const unavailable = () => {
    if (stopped || !frame.isConnected) return;
    stopped = true;
    generation++;
    observer?.disconnect();
    request?.abort();
    request = null;
    box.removeAttribute("data-checking");
    onUnavailable();
  };
  const check = () => {
    if (stopped || checked || request || !frame.isConnected) return;
    observer?.disconnect();
    const current = ++generation;
    const controller = new AbortController();
    request = controller;
    void cardFrameHostResponds(card.frameUrl, controller.signal).then((reachable) => {
      if (stopped || controller.signal.aborted || current !== generation || !frame.isConnected) return;
      request = null;
      if (reachable) {
        checked = true;
        box.removeAttribute("data-checking");
      } else unavailable();
    }).catch((error: unknown) => {
      if (stopped || controller.signal.aborted || current !== generation || !frame.isConnected) return;
      request = null;
      console.error("Could not verify the video embed host.", error);
      unavailable();
    });
  };
  const onLoad = () => {
    loadedCardFrames.add(frame);
    check();
  };
  const onError = () => unavailable();

  frame.addEventListener("load", onLoad);
  frame.addEventListener("error", onError);
  if (typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) check();
    }, { rootMargin: CARD_FRAME_PROBE_ROOT_MARGIN });
    observer.observe(box);
  } else {
    queueMicrotask(check);
  }
  if (loadedCardFrames.has(frame)) check();
  return () => {
    stopped = true;
    generation++;
    observer?.disconnect();
    request?.abort();
    request = null;
    frame.removeEventListener("load", onLoad);
    frame.removeEventListener("error", onError);
    box.removeAttribute("data-checking");
  };
}

/** "Load video", "Load post": the button on a card past the page's limit of frames. */
export function cardLoadLabel(card: LinkCard): string {
  return card.kind === "video" ? "Load video" : "Load post";
}

export function createCardUnavailableNotice(onRetry: () => void, doc: Document = document): HTMLElement {
  const notice = doc.createElement("div");
  notice.className = "md-link-card-off";
  notice.setAttribute("data-testid", "link-card-unavailable");
  const words = doc.createElement("p");
  words.textContent = "This video couldn't load.";
  const retry = doc.createElement("button");
  retry.type = "button";
  retry.className = "md-link-card-load";
  retry.textContent = "Try again";
  retry.setAttribute("data-testid", "link-card-retry");
  retry.addEventListener("click", (event) => {
    event.preventDefault();
    onRetry();
  });
  notice.append(words, retry);
  return notice;
}

const loaded = new WeakMap<object, number>();

/**
 * Take one of a page's `MAX_CARD_FRAMES` places for a frame that loads by itself. False when they are
 * all taken: that card shows a button instead, and a frame loaded by that button takes no place.
 */
export function claimCardFrame(page: object): boolean {
  const count = loaded.get(page) ?? 0;
  if (count >= MAX_CARD_FRAMES) return false;
  loaded.set(page, count + 1);
  return true;
}

/** Give a place back when its card goes away. */
export function releaseCardFrame(page: object): void {
  const count = loaded.get(page) ?? 0;
  if (count > 0) loaded.set(page, count - 1);
}
