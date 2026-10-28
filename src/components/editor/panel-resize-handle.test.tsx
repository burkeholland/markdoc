// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  PANEL_BIG_STEP,
  PANEL_MAX,
  PANEL_MIN,
  clampPanelWidth,
  panelMaxFor,
  parseStoredPanelWidth,
} from "./panel-resize-handle";

describe("panel width helpers", () => {
  it("uses 720 px or 60% of the viewport without dropping below the minimum", () => {
    expect(panelMaxFor(1440)).toBe(PANEL_MAX);
    expect(panelMaxFor(1200)).toBe(PANEL_MAX);
    expect(panelMaxFor(1199)).toBe(719);
    expect(panelMaxFor(1024)).toBe(614);
    expect(panelMaxFor(100)).toBe(PANEL_MIN);
  });

  it("rounds, clamps, and parses stored whole-pixel widths", () => {
    expect(clampPanelWidth(339.6, PANEL_MIN, PANEL_MAX)).toBe(340);
    expect(clampPanelWidth(10, PANEL_MIN, PANEL_MAX)).toBe(PANEL_MIN);
    expect(clampPanelWidth(5000, PANEL_MIN, PANEL_MAX)).toBe(PANEL_MAX);
    expect(parseStoredPanelWidth("500")).toBe(500);
    expect(parseStoredPanelWidth(" 420 ")).toBe(420);
    for (const invalid of [null, "", "abc", "500.5", "-300", "1e3", "{}"]) {
      expect(parseStoredPanelWidth(invalid)).toBeNull();
    }
    expect(PANEL_BIG_STEP).toBe(64);
  });
});
