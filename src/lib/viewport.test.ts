import { describe, expect, it } from "vitest";
import { clampToViewport, defaultLayout, effectiveLayout } from "./viewport";

describe("clampToViewport", () => {
  const vp = { width: 390, height: 844 };

  it("leaves a box that already fits untouched", () => {
    expect(clampToViewport({ left: 50, top: 100, width: 232, height: 40 }, vp)).toEqual({ left: 50, top: 100, width: 232, height: 40 });
  });

  it("pulls a box back inside the right and bottom edges", () => {
    const r = clampToViewport({ left: 300, top: 830, width: 232, height: 40 }, vp);
    expect(r.left + r.width).toBe(390 - 8);
    expect(r.top + r.height).toBe(844 - 8);
    expect(r.width).toBe(232);
  });

  it("pushes a box off the left/top edges back to the margin", () => {
    const r = clampToViewport({ left: -40, top: -10, width: 232, height: 40 }, vp, 8);
    expect(r.left).toBe(8);
    expect(r.top).toBe(8);
  });

  it("shrinks a box wider than the viewport instead of overflowing", () => {
    const r = clampToViewport({ left: 0, top: 0, width: 500, height: 1000 }, vp, 8);
    expect(r).toEqual({ left: 8, top: 8, width: 390 - 16, height: 844 - 16 });
  });

  it("honours a custom margin", () => {
    const r = clampToViewport({ left: 1000, top: 0, width: 100, height: 20 }, { width: 800, height: 600 }, 20);
    expect(r.left).toBe(800 - 20 - 100);
    expect(r.top).toBe(20);
  });
});

describe("defaultLayout", () => {
  it("opens the preview on a phone when nothing is stored", () => {
    expect(defaultLayout(390, null)).toBe("rich");
    expect(defaultLayout(767, undefined)).toBe("rich");
  });

  it("never splits on a phone, even when split was stored", () => {
    expect(defaultLayout(390, "split")).toBe("rich");
  });

  it("remembers Markdown-only on a phone", () => {
    expect(defaultLayout(390, "code")).toBe("code");
  });

  it("defaults to split on tablets and desktops", () => {
    expect(defaultLayout(768, null)).toBe("split");
    expect(defaultLayout(1440, null)).toBe("split");
  });

  it("honours the stored choice on wide windows and ignores junk", () => {
    expect(defaultLayout(1440, "code")).toBe("code");
    expect(defaultLayout(1440, "rich")).toBe("rich");
    expect(defaultLayout(1440, "bogus")).toBe("split");
  });
});

describe("effectiveLayout", () => {
  it("collapses split to the preview on phones only", () => {
    expect(effectiveLayout("split", 390)).toBe("rich");
    expect(effectiveLayout("code", 390)).toBe("code");
    expect(effectiveLayout("split", 900)).toBe("split");
  });
});
