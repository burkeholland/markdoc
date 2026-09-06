import { defaultSchema } from "rehype-sanitize";
import { isMac } from "@/lib/utils";

/** The same href protocols as the reader/export sanitizer, checked after URL resolution. */
export function resolveLinkHref(href: unknown, base: string): string | null {
  if (typeof href !== "string" || !href.trim() || !URL.canParse(href, base)) return null;
  const url = new URL(href, base);
  return defaultSchema.protocols?.href?.includes(url.protocol.slice(0, -1)) ? url.href : null;
}

/** Keep relative hrefs in the DOM; resolution at activation uses the current document base. */
export function safeLinkHref(href: unknown): string | undefined {
  return typeof href === "string" && resolveLinkHref(href, "https://markdoc.invalid/") ? href : undefined;
}

function isOpenClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.altKey && !event.shiftKey &&
    (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

function consume(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Claim modified link gestures before either editor changes selection or handles highlights.
 * Opening happens only on click, not mousedown; a drag instead selects text.
 */
export function installLinkInteractions(
  dom: HTMLElement,
  hrefAt: (event: MouseEvent) => string | null,
  selectDragged: (start: MouseEvent, current: MouseEvent) => void,
): () => void {
  const owner = dom.ownerDocument;
  let pending: { start: MouseEvent; dragged: boolean } | null = null;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  const resolve = (event: MouseEvent) => {
    if (!isOpenClick(event)) return null;
    return resolveLinkHref(hrefAt(event), owner.baseURI);
  };
  const stopTracking = () => {
    owner.removeEventListener("mousemove", move, true);
    owner.removeEventListener("mouseup", up, true);
  };
  const clear = () => {
    stopTracking();
    clearTimeout(clearTimer);
    pending = null;
  };
  const move = (event: MouseEvent) => {
    if (!pending) return;
    if (event.type === "mousemove" && !(event.buttons & 1)) {
      clear();
      return;
    }
    const { start } = pending;
    if (Math.abs(start.clientX - event.clientX) > 4 || Math.abs(start.clientY - event.clientY) > 4) pending.dragged = true;
    if (pending.dragged) {
      selectDragged(start, event);
      consume(event);
    }
  };
  const up = (event: MouseEvent) => {
    if (event.button !== 0) return;
    move(event);
    stopTracking();
    // A native click follows mouseup in the same task. Do not retain a cancelled gesture.
    clearTimer = setTimeout(clear, 0);
  };
  const down = (event: MouseEvent) => {
    clear();
    if (event.defaultPrevented || !resolve(event)) return;
    pending = { start: event, dragged: false };
    owner.addEventListener("mousemove", move, true);
    owner.addEventListener("mouseup", up, true);
    consume(event);
  };
  const click = (event: MouseEvent) => {
    const dragged = pending?.dragged;
    clear();
    if (event.defaultPrevented) return;
    if (dragged && event.button === 0) {
      consume(event);
      return;
    }
    const href = resolve(event);
    if (!href) return;
    consume(event);
    window.open(href, "_blank", "noopener");
  };

  dom.addEventListener("mousedown", down, true);
  dom.addEventListener("click", click, true);
  owner.defaultView?.addEventListener("blur", clear);
  return () => {
    clear();
    dom.removeEventListener("mousedown", down, true);
    dom.removeEventListener("click", click, true);
    owner.defaultView?.removeEventListener("blur", clear);
  };
}
