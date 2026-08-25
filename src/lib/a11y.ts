/** Keyboard and focus helpers shared by the roving-tabindex widgets (outline list, toolbar) and the dialogs. */

export interface RovingOptions {
  /** Which arrow pair moves focus. Default `"vertical"` (↑/↓). */
  orientation?: "horizontal" | "vertical";
  /** Wrap from the last item to the first and back. Default `false` (clamp at the ends). */
  wrap?: boolean;
}

/**
 * Index the arrow/Home/End keys should focus next, or -1 if `key` is not a navigation key (or
 * there is nothing to focus). `current` is -1 when focus is not on any item yet.
 */
export function rovingIndex(key: string, current: number, count: number, { orientation = "vertical", wrap = false }: RovingOptions = {}): number {
  if (count === 0) return -1;
  const [prevKey, nextKey] = orientation === "horizontal" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  switch (key) {
    case nextKey:
      return wrap ? (current < 0 ? 0 : (current + 1) % count) : Math.min(count - 1, current + 1);
    case prevKey:
      return wrap ? (current < 0 ? count - 1 : (current - 1 + count) % count) : Math.max(0, current - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return -1;
  }
}

/**
 * Move focus back to `el` (captured before a dialog or palette took focus) unless something else already
 * has it. Radix's modal content returns focus to its Trigger on close; dialogs opened from state have
 * none, so focus would otherwise fall to <body>. Leaves focus alone when the closing handler already
 * focused something (e.g. the editor after inserting a link). Returns whether `el` ended up focused.
 */
export function restoreFocus(el: HTMLElement | null): boolean {
  if (!el || !el.isConnected) return false;
  const active = document.activeElement;
  if (active && active !== document.body && active !== document.documentElement) return false;
  el.focus({ preventScroll: true });
  return document.activeElement === el;
}

const TABBABLE = 'input:not([type="hidden"]), select, textarea, button, a[href], [tabindex], [contenteditable="true"]';

/**
 * First element inside `root` a Tab press could land on: enabled, not `tabindex="-1"`, and rendered
 * (display:none controls such as a hidden file input have no client rects). Elements inside a
 * `[data-focus-skip]` ancestor are passed over — the dialog header uses it so its Close button never
 * takes the opening focus ahead of the form.
 */
export function firstTabbable(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  for (const el of root.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (el.closest("[data-focus-skip]")) continue;
    if ((el as HTMLButtonElement).disabled || el.tabIndex < 0) continue;
    if (el.getClientRects().length === 0) continue;
    return el;
  }
  return null;
}

/** `document.activeElement` as an HTMLElement, or null when focus is on <body> or nothing. */
export function focusedElement(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}
