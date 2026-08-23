/**
 * Viewport helpers shared by the floating menus (selection bubble, table menu, slash menu) and
 * the editor shell's responsive layout. Pure functions live here so they can be unit-tested;
 * the React hooks are in ./viewport-hooks.ts.
 */

export type Layout = "split" | "code" | "rich";

/** Tailwind's `md` and `lg` breakpoints, in CSS pixels. */
export const PHONE_MAX = 768;
export const TABLET_MAX = 1024;

export const LAYOUT_STORAGE_KEY = "markdoc:layout";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export function isLayout(value: unknown): value is Layout {
  return value === "split" || value === "code" || value === "rich";
}

/**
 * Layout to use when the editor opens. Phones only ever show one pane: a stored "split" (or
 * nothing) becomes "rich" there. Wider windows honour the stored choice and default to split.
 */
export function defaultLayout(width: number, stored: string | null | undefined): Layout {
  const remembered = isLayout(stored) ? stored : null;
  if (width < PHONE_MAX) return remembered === "code" ? "code" : "rich";
  return remembered ?? "split";
}

/** The layout actually rendered for a window width: split collapses to the preview on phones. */
export function effectiveLayout(layout: Layout, width: number): Layout {
  return width < PHONE_MAX && layout === "split" ? "rich" : layout;
}

/**
 * Move `box` so it sits inside `viewport` with `margin` px to spare on every side. The size is
 * kept unless the box is larger than the available space, in which case it is shrunk to fit.
 * Coordinates are in the same space as the viewport (usually window/client pixels).
 */
export function clampToViewport(box: Box, viewport: Viewport, margin = 8): Box {
  const maxWidth = Math.max(0, viewport.width - margin * 2);
  const maxHeight = Math.max(0, viewport.height - margin * 2);
  const width = Math.min(box.width, maxWidth);
  const height = Math.min(box.height, maxHeight);
  const left = Math.min(Math.max(box.left, margin), viewport.width - margin - width);
  const top = Math.min(Math.max(box.top, margin), viewport.height - margin - height);
  return { left, top, width, height };
}
