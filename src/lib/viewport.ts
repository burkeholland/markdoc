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

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
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

/** The common client-coordinate area of every box. Empty intersections keep a zero width or height. */
export function intersectBoxes(...boxes: Box[]): Box {
  if (boxes.length === 0) return { left: 0, top: 0, width: 0, height: 0 };
  const left = Math.max(...boxes.map((box) => box.left));
  const top = Math.max(...boxes.map((box) => box.top));
  const right = Math.min(...boxes.map((box) => box.left + box.width));
  const bottom = Math.min(...boxes.map((box) => box.top + box.height));
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Remove per-edge insets from a client-coordinate box without allowing negative dimensions. */
export function insetBox(box: Box, insets: Insets): Box {
  return {
    left: box.left + insets.left,
    top: box.top + insets.top,
    width: Math.max(0, box.width - insets.left - insets.right),
    height: Math.max(0, box.height - insets.top - insets.bottom),
  };
}

/** Move and, when needed, shrink `box` to fit within an arbitrary client-coordinate rectangle. */
export function clampToBox(box: Box, bounds: Box, margin = 8): Box {
  const inner = insetBox(bounds, { top: margin, right: margin, bottom: margin, left: margin });
  const width = Math.min(box.width, inner.width);
  const height = Math.min(box.height, inner.height);
  const left = Math.min(Math.max(box.left, inner.left), inner.left + inner.width - width);
  const top = Math.min(Math.max(box.top, inner.top), inner.top + inner.height - height);
  return { left, top, width, height };
}

/**
 * Move `box` so it sits inside `viewport` with `margin` px to spare on every side. The size is
 * kept unless the box is larger than the available space, in which case it is shrunk to fit.
 * Coordinates are in the same space as the viewport (usually window/client pixels).
 */
export function clampToViewport(box: Box, viewport: Viewport, margin = 8): Box {
  return clampToBox(box, { left: 0, top: 0, width: viewport.width, height: viewport.height }, margin);
}
