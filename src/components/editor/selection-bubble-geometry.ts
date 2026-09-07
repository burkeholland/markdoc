import { clampToBox, insetBox, intersectBoxes, type Box, type Insets } from "@/lib/viewport";

export const SELECTION_BUBBLE_WIDTH = 232;
export const SELECTION_BUBBLE_HEIGHT = 40;
export const SELECTION_BUBBLE_GAP = 10;
export const SELECTION_BUBBLE_MARGIN = 8;
// One full 32px action plus the scroller's two 4px padding edges.
export const SELECTION_BUBBLE_MIN_WIDTH = 40;
export const SELECTION_BUBBLE_ARROW_SIZE = 10;
export const SELECTION_BUBBLE_ARROW_RADIUS = SELECTION_BUBBLE_ARROW_SIZE / Math.sqrt(2);
export const SELECTION_BUBBLE_BORDER = 1;

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
export function selectionClientBox(start: Box, end: Box, fragments: readonly Box[] = []): Box {
  const boxes = [start, end, ...fragments];
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));
  return { left, top, width: right - left, height: bottom - top };
}

export function selectionIntersectsBounds(selection: Box, bounds: Box): boolean {
  return (
    (selection.width === 0 ? selection.left >= bounds.left : selection.left + selection.width > bounds.left) &&
    selection.left < bounds.left + bounds.width &&
    (selection.height === 0 ? selection.top >= bounds.top : selection.top + selection.height > bounds.top) &&
    selection.top < bounds.top + bounds.height
  );
}

/** Invert the layer's translation/scale, keeping actions and the arrow in client pixels. */
export function selectionBubbleLayerPosition(position: SelectionBubblePosition, layer: Box, width: number, height: number) {
  if (width <= 0 || height <= 0 || layer.width <= 0 || layer.height <= 0) return null;
  const scaleX = layer.width / width;
  const scaleY = layer.height / height;
  return {
    left: (position.left - layer.left) / scaleX,
    top: (position.top - layer.top) / scaleY,
    scaleX: 1 / scaleX,
    scaleY: 1 / scaleY,
  };
}

/** Place the bubble wholly inside `bounds`, or hide it when the selection or available area is outside. */
export function placeSelectionBubble(selection: Box, bounds: Box, coarsePointer: boolean): SelectionBubblePosition | null {
  if (
    bounds.width < SELECTION_BUBBLE_MIN_WIDTH + SELECTION_BUBBLE_MARGIN * 2 ||
    bounds.height < SELECTION_BUBBLE_HEIGHT + SELECTION_BUBBLE_MARGIN * 2 ||
    !selectionIntersectsBounds(selection, bounds)
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
  if (box.height < SELECTION_BUBBLE_HEIGHT || box.width < SELECTION_BUBBLE_MIN_WIDTH) return null;
  const arrowMargin = Math.max(12, SELECTION_BUBBLE_ARROW_RADIUS + SELECTION_BUBBLE_BORDER);
  const arrowLeft = Math.min(Math.max(centerX - box.left, arrowMargin), box.width - arrowMargin);
  return { ...box, below, arrowLeft };
}
