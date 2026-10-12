/** The nearest ancestor that scrolls `dom` vertically, or null when nothing above it overflows. */
export function owningVerticalScroller(dom: HTMLElement): HTMLElement | null {
  for (let element = dom.parentElement; element; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight) return element;
  }
  return null;
}
