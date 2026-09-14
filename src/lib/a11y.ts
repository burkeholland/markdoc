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

export interface GridCell {
  row: number;
  col: number;
}

/**
 * Cell the arrow/Home/End keys should focus next in a `rows × cols` roving-tabindex grid (the insert-table
 * size picker), or null if `key` is not a navigation key. Arrows clamp at the edges; Home/End go to the
 * first/last cell of the current row and, with `ctrl`, to the first/last cell of the grid (the WAI-ARIA
 * grid pattern). An off-grid `current` is clamped before moving.
 */
export function gridCell(key: string, current: GridCell, rows: number, cols: number, { ctrl = false }: { ctrl?: boolean } = {}): GridCell | null {
  if (rows <= 0 || cols <= 0) return null;
  const row = Math.max(0, Math.min(rows - 1, current.row));
  const col = Math.max(0, Math.min(cols - 1, current.col));
  switch (key) {
    case "ArrowRight":
      return { row, col: Math.min(cols - 1, col + 1) };
    case "ArrowLeft":
      return { row, col: Math.max(0, col - 1) };
    case "ArrowDown":
      return { row: Math.min(rows - 1, row + 1), col };
    case "ArrowUp":
      return { row: Math.max(0, row - 1), col };
    case "Home":
      return { row: ctrl ? 0 : row, col: 0 };
    case "End":
      return { row: ctrl ? rows - 1 : row, col: cols - 1 };
    default:
      return null;
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
 * First element inside `root` a Tab press could land on: enabled, non-inert, visible, not `tabindex="-1"`, and rendered
 * (display:none controls such as a hidden file input have no client rects). Elements inside a
 * `[data-focus-skip]` ancestor are passed over — the dialog header uses it so its Close button never
 * takes the opening focus ahead of the form, and a dialog body can opt out the same way when its first
 * control is an action Enter should not fire by accident.
 */
export function firstTabbable(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  for (const el of root.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (el.closest("[data-focus-skip], [inert]")) continue;
    if (el.matches(":disabled") || el.tabIndex < 0) continue;
    if (el.getClientRects().length === 0) continue;
    const visibility = el.ownerDocument.defaultView?.getComputedStyle(el).visibility;
    if (visibility === "hidden" || visibility === "collapse") continue;
    return el;
  }
  return null;
}

/** `document.activeElement` as an HTMLElement, or null when focus is on <body> or nothing. */
export function focusedElement(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/**
 * The element a dialog opened right now should hand focus back to when it closes: whatever has focus,
 * except that a menu item resolves to the menu's trigger. A dropdown item that opens a dialog is gone by
 * the time the dialog closes (the ⋮ menu unmounts in the same commit the dialog mounts), so focusing it
 * later would fall through to <body>; its trigger button stays in the header. Radix wires the trigger to
 * the menu with `aria-controls` while open and `aria-labelledby` on the menu; either finds it. Must be
 * called before that commit — a lazy `useState` initializer in the dialog's render is early enough, an
 * effect is not. Null when focus is on <body>.
 */
export function focusReturnTarget(): HTMLElement | null {
  const active = focusedElement();
  if (!active) return null;
  const menu = active.closest<HTMLElement>('[role="menu"]');
  if (!menu) return active;
  return menuTrigger(menu) ?? active;
}

function menuTrigger(menu: HTMLElement): HTMLElement | null {
  if (menu.id) {
    const controller = document.querySelector<HTMLElement>(`[aria-controls="${menu.id}"]`);
    if (controller) return controller;
  }
  const labelledBy = menu.getAttribute("aria-labelledby");
  const label = labelledBy ? document.getElementById(labelledBy) : null;
  return label instanceof HTMLElement && label !== menu && !menu.contains(label) ? label : null;
}
