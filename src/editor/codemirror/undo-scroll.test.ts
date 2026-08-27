import { describe, expect, it } from "vitest";
import { shouldSuppressInactiveScroll } from "./undo-scroll";

describe("preserveInactiveUndoScroll", () => {
  const nearest = { x: "nearest", y: "nearest", xMargin: 5, yMargin: 5 } as const;

  it("suppresses CodeMirror's default selection reveal while source is inactive", () => {
    expect(shouldSuppressInactiveScroll(false, nearest)).toBe(true);
  });

  it("keeps CodeMirror's minimal reveal when source owns the undo", () => {
    expect(shouldSuppressInactiveScroll(true, nearest)).toBe(false);
  });

  it("does not suppress a scroll-only request used to synchronize panes", () => {
    expect(shouldSuppressInactiveScroll(false, { ...nearest, y: "start", yMargin: 0 })).toBe(false);
  });
});
