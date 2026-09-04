import { describe, expect, it } from "vitest";
import { placeSelectionBubble, selectionBubbleBounds, selectionClientBox } from "./selection-bubble-geometry";

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
});
