import { describe, expect, it, vi } from "vitest";
import { carryActiveIndex, compileFindRegex, DEFAULT_FIND_OPTIONS, expandReplacement, findMatches, matchIndexAfter, type FindMatch } from "./find";

const opts = DEFAULT_FIND_OPTIONS;

function expectBoundedRegexMatches(text: string, query: string, expected: FindMatch[]) {
  const nativeExec = RegExp.prototype.exec;
  const budget = 8 * (text.length + 1);
  let calls = 0;
  // A timeout cannot interrupt a synchronous loop; bound only this search's native calls.
  const exec = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, input: string) {
    const result = nativeExec.call(this, input);
    if (this.source === query && this.flags === "giu" && input === text && ++calls > budget) {
      throw new Error("Find exceeded its native RegExp.exec call budget");
    }
    return result;
  });
  try {
    expect(findMatches(text, query, { ...opts, regex: true })).toEqual(expected);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(budget);
  } finally {
    exec.mockRestore();
  }
}

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

  it("distinguishes invalid regex syntax from empty and literal queries", () => {
    expect(compileFindRegex("", { ...opts, regex: true })).toEqual({ regex: null, invalid: false });
    expect(compileFindRegex("(", { ...opts, regex: true })).toEqual({ regex: null, invalid: true });

    const literal = compileFindRegex("(", opts);
    expect(literal.invalid).toBe(false);
    expect(literal.regex?.exec("(")?.[0]).toBe("(");
  });

  it.each([
    {
      name: "zero-or-more matches around adjacent supplementary characters",
      text: "\uD83D\uDE00a\uD83D\uDE03\uD83D\uDE04aa\uD801\uDC00a",
      query: "a*",
      expected: [{ from: 2, to: 3 }, { from: 7, to: 9 }, { from: 11, to: 12 }],
    },
    {
      name: "zero-or-more matches after supplementary letters",
      text: "\uD801\uDC00a\uD801\uDC01aa",
      query: "a*",
      expected: [{ from: 2, to: 3 }, { from: 5, to: 7 }],
    },
    {
      name: "nonempty supplementary matches after skipped supplementary letters",
      text: "\uD801\uDC00\uD83D\uDE00\uD801\uDC01\uD83D\uDE00\uD83D\uDE00",
      query: "(?:\\u{1F600})*",
      expected: [{ from: 2, to: 4 }, { from: 6, to: 10 }],
    },
    {
      name: "empty groups among real matches",
      text: "\uD83D\uDE00a\uD801\uDC00aa",
      query: "a+|()",
      expected: [{ from: 2, to: 3 }, { from: 5, to: 7 }],
    },
    {
      name: "lookahead advances at the actual matched cursor",
      text: "\u03B2\uD83D\uDE00a\uD801\uDC00aa",
      query: "(?=\\u{1F600})|a+",
      expected: [{ from: 3, to: 4 }, { from: 6, to: 8 }],
    },
    {
      name: "lookahead skips supplementary letters without losing later matches",
      text: "\uD83D\uDE00\uD801\uDC00aa\uD83D\uDE03a",
      query: "(?=\\u{10400})|a+",
      expected: [{ from: 4, to: 6 }, { from: 8, to: 9 }],
    },
    {
      name: "empty groups on adjacent surrogate pairs",
      text: "\uD83D\uDE00\uD801\uDC00\uD83D\uDE03",
      query: "()",
      expected: [],
    },
    {
      name: "lookahead-only matches on supplementary characters",
      text: "\uD83D\uDE00\uD801\uDC00",
      query: "(?=.)",
      expected: [],
    },
    {
      name: "zero-or-more with no real matches",
      text: "\uD83D\uDE00\uD801\uDC00",
      query: "a*",
      expected: [],
    },
    {
      name: "start-only matches before an emoji",
      text: "\uD83D\uDE00",
      query: "^",
      expected: [],
    },
    {
      name: "end-only matches after an emoji",
      text: "\uD83D\uDE00",
      query: "$",
      expected: [],
    },
    {
      name: "start and end matches around adjacent pairs",
      text: "\uD83D\uDE00\uD801\uDC00",
      query: "^|$",
      expected: [],
    },
    {
      name: "anchors do not discard real matches between them",
      text: "\uD83D\uDE00a\uD801\uDC00aa",
      query: "^|a+|$",
      expected: [{ from: 2, to: 3 }, { from: 5, to: 7 }],
    },
    {
      name: "BMP characters advance one code unit",
      text: "\u03B2a\u03B3aa",
      query: "a*",
      expected: [{ from: 1, to: 2 }, { from: 3, to: 5 }],
    },
    {
      name: "lone high surrogates advance one code unit",
      text: "\uD83Da\uD801aa\uD83D",
      query: "a*",
      expected: [{ from: 1, to: 2 }, { from: 3, to: 5 }],
    },
    {
      name: "lone low surrogates advance one code unit",
      text: "\uDE00a\uDC00aa\uDE03",
      query: "a*",
      expected: [{ from: 1, to: 2 }, { from: 3, to: 5 }],
    },
    {
      name: "reversed surrogates are not treated as a pair",
      text: "\uDE00\uD83Da",
      query: "a*",
      expected: [{ from: 2, to: 3 }],
    },
    {
      name: "empty groups on BMP text",
      text: "\u03B2\u03B3",
      query: "()",
      expected: [],
    },
    {
      name: "empty groups on a lone high surrogate",
      text: "\uD83D",
      query: "()",
      expected: [],
    },
    {
      name: "empty groups on a lone low surrogate",
      text: "\uDE00",
      query: "()",
      expected: [],
    },
    {
      name: "empty groups on empty text progress past the end",
      text: "",
      query: "()",
      expected: [],
    },
  ])("$name", ({ text, query, expected }) => {
    expectBoundedRegexMatches(text, query, expected);
  });

  it("keeps the 5000 nonempty match cap with and without skipped empty matches", () => {
    expect(findMatches("a".repeat(5002), "a", opts)).toEqual(
      Array.from({ length: 5000 }, (_, i) => ({ from: i, to: i + 1 })),
    );
    expectBoundedRegexMatches(
      "\uD83D\uDE00a".repeat(5002),
      "a*",
      Array.from({ length: 5000 }, (_, i) => ({ from: i * 3 + 2, to: i * 3 + 3 })),
    );
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
