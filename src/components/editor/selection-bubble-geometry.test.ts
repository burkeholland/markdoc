import { describe, expect, it } from "vitest";
import {
  placeSelectionBubble,
  selectionBubbleBounds,
  selectionBubbleLayerPosition,
  selectionClientBox,
  selectionIntersectsBounds,
  SELECTION_BUBBLE_ARROW_RADIUS,
  SELECTION_BUBBLE_BORDER,
  SELECTION_BUBBLE_MIN_WIDTH,
  SELECTION_BUBBLE_MARGIN,
} from "./selection-bubble-geometry";

describe("selection bubble geometry", () => {
  it("intersects the pane, layout viewport, offset visual viewport and safe area", () => {
    expect(
      selectionBubbleBounds({
        host: { left: 50, top: 100, width: 300, height: 500 },
        layoutViewport: { left: 0, top: 0, width: 360, height: 800 },
        visualViewport: { offsetLeft: 20, offsetTop: 40, width: 180, height: 300 },
        safeArea: { top: 10, right: 12, bottom: 14, left: 16 },
      }),
    ).toEqual({ left: 50, top: 100, width: 138, height: 226 });
  });

  it("keeps reverse and multiline endpoint geometry in one client box", () => {
    expect(
      selectionClientBox(
        { left: 280, top: 160, width: 1, height: 20 },
        { left: 80, top: 100, width: 1, height: 20 },
      ),
    ).toEqual({ left: 80, top: 100, width: 201, height: 80 });
  });

  it("uses the clamped width and pane-owned position in a narrow visible area", () => {
    const position = placeSelectionBubble(
      { left: 120, top: 250, width: 20, height: 20 },
      { left: 50, top: 100, width: 180, height: 400 },
      false,
    );
    expect(position).toMatchObject({ left: 58, top: 200, width: 164, height: 40, below: false });
    expect(position!.arrowLeft).toBe(72);
  });

  it("preserves a partly visible selection and coarse-pointer below placement", () => {
    expect(
      placeSelectionBubble(
        { left: 100, top: 90, width: 100, height: 20 },
        { left: 0, top: 100, width: 360, height: 500 },
        true,
      ),
    ).toMatchObject({ top: 120, below: true });
  });

  it("hides wholly outside selections and rectangles with no usable area", () => {
    const bounds = { left: 20, top: 100, width: 320, height: 500 };
    expect(placeSelectionBubble({ left: 30, top: 70, width: 100, height: 30 }, bounds, false)).toBeNull();
    expect(placeSelectionBubble({ left: 30, top: 600, width: 100, height: 30 }, bounds, false)).toBeNull();
    expect(placeSelectionBubble({ left: -100, top: 200, width: 100, height: 30 }, bounds, false)).toBeNull();
    expect(placeSelectionBubble({ left: 30, top: 200, width: 100, height: 30 }, { ...bounds, width: 0 }, false)).toBeNull();
  });

  it.each([0, 1, 8, 16, 17, 24, 39, 40, 55])("hides a %ipx intersection rather than clipping an action or arrow", (width) => {
    expect(placeSelectionBubble(
      { left: 10, top: 100, width: 2, height: 20 },
      { left: 0, top: 0, width, height: 300 },
      false,
    )).toBeNull();
  });

  it("fits a full action and the rotated arrow plus border at the exact minimum in either direction", () => {
    const bounds = { left: 20, top: 100, width: SELECTION_BUBBLE_MIN_WIDTH + 2 * SELECTION_BUBBLE_MARGIN, height: 56 };
    for (const coarse of [false, true]) {
      for (const [left, top] of [[20, 120], [40, 155], [75, 120]]) {
        const pos = placeSelectionBubble({ left, top, width: 0, height: 20 }, bounds, coarse)!;
        expect(pos.width).toBe(SELECTION_BUBBLE_MIN_WIDTH);
        const arrowX = pos.left + pos.arrowLeft;
        const arrowY = pos.below ? pos.top + 1 : pos.top + pos.height - 1;
        const radius = SELECTION_BUBBLE_ARROW_RADIUS + SELECTION_BUBBLE_BORDER;
        expect(arrowX - radius).toBeGreaterThanOrEqual(bounds.left);
        expect(arrowX + radius).toBeLessThanOrEqual(bounds.left + bounds.width);
        expect(arrowY - radius).toBeGreaterThanOrEqual(bounds.top);
        expect(arrowY + radius).toBeLessThanOrEqual(bounds.top + bounds.height);
      }
    }
  });

  it("keeps zero-width caret endpoints and wrapped middle fragments visible", () => {
    const bounds = { left: 100, top: 100, width: 200, height: 200 };
    const start = { left: 350, top: 90, width: 0, height: 20 };
    const end = { left: 50, top: 200, width: 0, height: 20 };
    const middle = { left: 110, top: 140, width: 160, height: 20 };
    expect(selectionClientBox(start, end, [middle])).toEqual({ left: 50, top: 90, width: 300, height: 130 });
    expect(selectionIntersectsBounds(middle, bounds)).toBe(true);
    expect(selectionIntersectsBounds({ left: 100, top: 120, width: 0, height: 20 }, bounds)).toBe(true);
    expect(selectionIntersectsBounds({ left: 300, top: 120, width: 0, height: 20 }, bounds)).toBe(false);
  });

  it.each([[1, 1], [0.5, 0.75], [2, 2]])("inverts a translated portal scaled by %s/%s without scaling targets", (scaleX, scaleY) => {
    const position = { left: 90, top: 110, width: 232, height: 40, below: false, arrowLeft: 60 };
    const layer = { left: 30, top: 50, width: 800 * scaleX, height: 600 * scaleY };
    const local = selectionBubbleLayerPosition(position, layer, 800, 600)!;
    expect(layer.left + local.left * scaleX).toBe(position.left);
    expect(layer.top + local.top * scaleY).toBe(position.top);
    expect(position.width * local.scaleX * scaleX).toBe(position.width);
    expect(32 * local.scaleY * scaleY).toBe(32);
    expect(selectionBubbleLayerPosition(position, { ...layer, width: 0 }, 800, 600)).toBeNull();
  });
});
