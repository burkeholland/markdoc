import { describe, expect, it } from "vitest";
import { carryActiveIndex, DEFAULT_FIND_OPTIONS, expandReplacement, findMatches, matchIndexAfter } from "./find";

const opts = DEFAULT_FIND_OPTIONS;

describe("findMatches", () => {
  it("finds case-insensitive literal matches by default", () => {
    expect(findMatches("Cat cat CAT scat", "cat", opts)).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
      { from: 8, to: 11 },
      { from: 13, to: 16 },
    ]);
  });

  it("respects match case and whole word", () => {
    expect(findMatches("Cat cat CAT scat", "cat", { ...opts, matchCase: true })).toEqual([
      { from: 4, to: 7 },
      { from: 13, to: 16 },
    ]);
    expect(findMatches("Cat cat CAT scat cat_x", "cat", { ...opts, wholeWord: true })).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
      { from: 8, to: 11 },
    ]);
  });

  it("treats the query literally unless regex mode is on", () => {
    expect(findMatches("a.c abc", "a.c", opts)).toEqual([{ from: 0, to: 3 }]);
    expect(findMatches("a.c abc", "a.c", { ...opts, regex: true })).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
    ]);
  });

  it("ignores empty, invalid and zero-width patterns", () => {
    expect(findMatches("abc", "", opts)).toEqual([]);
    expect(findMatches("abc", "(", { ...opts, regex: true })).toEqual([]);
    expect(findMatches("aab", "a*", { ...opts, regex: true })).toEqual([{ from: 0, to: 2 }]);
  });
});

describe("navigation helpers", () => {
  const matches = [
    { from: 2, to: 4 },
    { from: 10, to: 12 },
    { from: 20, to: 22 },
  ];
  it("finds the next match after an offset, wrapping around", () => {
    expect(matchIndexAfter(matches, 0)).toBe(0);
    expect(matchIndexAfter(matches, 5)).toBe(1);
    expect(matchIndexAfter(matches, 21)).toBe(0);
    expect(matchIndexAfter([], 0)).toBe(-1);
  });

  it("carries the active match across text changes", () => {
    expect(carryActiveIndex(matches, null)).toBe(0);
    expect(carryActiveIndex(matches, { from: 10, to: 12 })).toBe(1);
    expect(carryActiveIndex(matches, { from: 11, to: 13 })).toBe(2);
    expect(carryActiveIndex(matches, { from: 30, to: 31 })).toBe(0);
  });
});

describe("expandReplacement", () => {
  it("is literal outside regex mode and expands groups inside it", () => {
    const text = "price: 42 dollars";
    expect(expandReplacement(text, { from: 7, to: 9 }, "42", opts, "$1-$&")).toBe("$1-$&");
    const rx = { ...opts, regex: true };
    expect(expandReplacement(text, { from: 7, to: 9 }, "(\\d+)", rx, "[$1] was $&, $$")).toBe("[42] was 42, $");
  });
});
