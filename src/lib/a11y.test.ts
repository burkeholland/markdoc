import { describe, expect, it } from "vitest";
import { rovingIndex } from "./a11y";

describe("rovingIndex", () => {
  it("ignores non-navigation keys and empty lists", () => {
    expect(rovingIndex("a", 0, 5)).toBe(-1);
    expect(rovingIndex("Enter", 0, 5)).toBe(-1);
    expect(rovingIndex("ArrowDown", 0, 0)).toBe(-1);
    expect(rovingIndex("Home", 0, 0)).toBe(-1);
  });

  it("vertical without wrap clamps at both ends (outline)", () => {
    expect(rovingIndex("ArrowDown", 0, 3)).toBe(1);
    expect(rovingIndex("ArrowDown", 2, 3)).toBe(2);
    expect(rovingIndex("ArrowUp", 2, 3)).toBe(1);
    expect(rovingIndex("ArrowUp", 0, 3)).toBe(0);
    expect(rovingIndex("ArrowLeft", 1, 3)).toBe(-1);
    expect(rovingIndex("ArrowRight", 1, 3)).toBe(-1);
    // Focus not on any item yet: both arrows land on the first item.
    expect(rovingIndex("ArrowDown", -1, 3)).toBe(0);
    expect(rovingIndex("ArrowUp", -1, 3)).toBe(0);
  });

  it("horizontal with wrap cycles (toolbar)", () => {
    const opts = { orientation: "horizontal", wrap: true } as const;
    expect(rovingIndex("ArrowRight", 0, 3, opts)).toBe(1);
    expect(rovingIndex("ArrowRight", 2, 3, opts)).toBe(0);
    expect(rovingIndex("ArrowLeft", 0, 3, opts)).toBe(2);
    expect(rovingIndex("ArrowLeft", 1, 3, opts)).toBe(0);
    expect(rovingIndex("ArrowDown", 1, 3, opts)).toBe(-1);
    expect(rovingIndex("ArrowUp", 1, 3, opts)).toBe(-1);
    expect(rovingIndex("ArrowRight", -1, 3, opts)).toBe(0);
    expect(rovingIndex("ArrowLeft", -1, 3, opts)).toBe(2);
  });

  it("Home and End jump regardless of orientation", () => {
    expect(rovingIndex("Home", 2, 4)).toBe(0);
    expect(rovingIndex("End", 0, 4)).toBe(3);
    expect(rovingIndex("Home", 2, 4, { orientation: "horizontal", wrap: true })).toBe(0);
    expect(rovingIndex("End", 0, 4, { orientation: "horizontal", wrap: true })).toBe(3);
  });
});
