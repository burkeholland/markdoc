import { clampToBox, insetBox, intersectBoxes, type Box, type Insets } from "@/lib/viewport";

export const SELECTION_BUBBLE_WIDTH = 232;
export const SELECTION_BUBBLE_HEIGHT = 40;
export const SELECTION_BUBBLE_GAP = 10;
export const SELECTION_BUBBLE_MARGIN = 8;

export interface VisualViewportBox {
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
}

export interface SelectionBubblePosition extends Box {
  below: boolean;
  arrowLeft: number;
}

/** Rectangle where client-coordinate floating UI may render inside the rich pane. */
export function selectionBubbleBounds({
  host,
  layoutViewport,
  visualViewport,
  safeArea,
}: {
  host: Box;
  layoutViewport: Box;
  visualViewport: VisualViewportBox | null;
  safeArea: Insets;
}): Box {
  const visual = visualViewport
    ? {
        left: visualViewport.offsetLeft,
        top: visualViewport.offsetTop,
        width: visualViewport.width,
        height: visualViewport.height,
      }
    : layoutViewport;
  const safe = insetBox(visual, safeArea);
  return intersectBoxes(host, layoutViewport, visual, safe);
}

/** Union of the first and last selection caret rectangles, valid for forward, reverse and multiline ranges. */
export function selectionClientBox(start: Box, end: Box): Box {
  const left = Math.min(start.left, end.left);
  const top = Math.min(start.top, end.top);
  const right = Math.max(start.left + start.width, end.left + end.width);
  const bottom = Math.max(start.top + start.height, end.top + end.height);
  return { left, top, width: right - left, height: bottom - top };
}

/** Place the bubble wholly inside `bounds`, or hide it when the selection or available area is outside. */
export function placeSelectionBubble(selection: Box, bounds: Box, coarsePointer: boolean): SelectionBubblePosition | null {
  if (
    bounds.width <= SELECTION_BUBBLE_MARGIN * 2 ||
    bounds.height < SELECTION_BUBBLE_HEIGHT + SELECTION_BUBBLE_MARGIN * 2 ||
    selection.left + selection.width <= bounds.left ||
    selection.left >= bounds.left + bounds.width ||
    selection.top + selection.height <= bounds.top ||
    selection.top >= bounds.top + bounds.height
  ) {
    return null;
  }

  const roomAbove = selection.top - bounds.top;
  const roomBelow = bounds.top + bounds.height - (selection.top + selection.height);
  const needed = SELECTION_BUBBLE_HEIGHT + SELECTION_BUBBLE_GAP;
  let below = coarsePointer || roomAbove < needed;
  if (below && roomBelow < needed && roomAbove >= needed) below = false;
  else if (!below && roomAbove < needed && roomBelow >= needed) below = true;

  const centerX = selection.left + selection.width / 2;
  const requestedTop = below
    ? selection.top + selection.height + SELECTION_BUBBLE_GAP
    : selection.top - SELECTION_BUBBLE_HEIGHT - SELECTION_BUBBLE_GAP;
  const box = clampToBox(
    {
      left: centerX - SELECTION_BUBBLE_WIDTH / 2,
      top: requestedTop,
      width: SELECTION_BUBBLE_WIDTH,
      height: SELECTION_BUBBLE_HEIGHT,
    },
    bounds,
    SELECTION_BUBBLE_MARGIN,
  );
  if (box.height < SELECTION_BUBBLE_HEIGHT || box.width <= 0) return null;
  const arrowMargin = Math.min(12, box.width / 2);
  const arrowLeft = Math.min(Math.max(centerX - box.left, arrowMargin), box.width - arrowMargin);
  return { ...box, below, arrowLeft };
}
