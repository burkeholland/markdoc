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

/** "Load video", "Load post": the button on a card past the page's limit of frames. */
export function cardLoadLabel(card: LinkCard): string {
  return card.kind === "video" ? "Load video" : "Load post";
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
