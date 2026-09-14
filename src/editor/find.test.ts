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

  describe.each([
    { mode: "literal", regex: false },
    { mode: "regex", regex: true },
  ])("whole word boundaries in $mode mode", ({ regex }) => {
    const wholeWord = { ...opts, regex, wholeWord: true };

    it.each([
      {
        name: "decomposed Latin prefix",
        text: "nai\u0308ve nai",
        query: "nai",
        whole: [{ from: 7, to: 10 }],
        substrings: [{ from: 0, to: 3 }, { from: 7, to: 10 }],
      },
      {
        name: "decomposed Latin suffix",
        text: "nai\u0308ve ve",
        query: "ve",
        whole: [{ from: 7, to: 9 }],
        substrings: [{ from: 4, to: 6 }, { from: 7, to: 9 }],
      },
      {
        name: "combining spacing vowel mark on either side",
        text: "\u0915\u093e \u0915 \u093e\u0915",
        query: "\u0915",
        whole: [{ from: 3, to: 4 }],
        substrings: [{ from: 0, to: 1 }, { from: 3, to: 4 }, { from: 6, to: 7 }],
      },
      {
        name: "enclosing mark on either side",
        text: "a\u20dd a \u20dda",
        query: "a",
        whole: [{ from: 3, to: 4 }],
        substrings: [{ from: 0, to: 1 }, { from: 3, to: 4 }, { from: 6, to: 7 }],
      },
      {
        name: "supplementary spacing mark on either side",
        text: "a\u{1D165} a \u{1D165}a",
        query: "a",
        whole: [{ from: 4, to: 5 }],
        substrings: [{ from: 0, to: 1 }, { from: 4, to: 5 }, { from: 8, to: 9 }],
      },
      {
        name: "supplementary nonspacing mark on either side",
        text: "a\u{1E000} a \u{1E000}a",
        query: "a",
        whole: [{ from: 4, to: 5 }],
        substrings: [{ from: 0, to: 1 }, { from: 4, to: 5 }, { from: 8, to: 9 }],
      },
      {
        name: "multiple marks on either side",
        text: "\u0308\u0301a a a\u0308\u0301",
        query: "a",
        whole: [{ from: 4, to: 5 }],
        substrings: [{ from: 2, to: 3 }, { from: 4, to: 5 }, { from: 6, to: 7 }],
      },
      {
        name: "adjacent marked and unmarked words",
        text: "a\u0308,a;\u0308a!a",
        query: "a",
        whole: [{ from: 3, to: 4 }, { from: 8, to: 9 }],
        substrings: [{ from: 0, to: 1 }, { from: 3, to: 4 }, { from: 6, to: 7 }, { from: 8, to: 9 }],
      },
    ])("excludes parts touching $name only with whole word selected", ({ text, query, whole, substrings }) => {
      const matches = findMatches(text, query, wholeWord);
      expect(matches).toEqual(whole);
      expect(matches.map(({ from, to }) => text.slice(from, to))).toEqual(whole.map(() => query));

      const partials = findMatches(text, query, { ...wholeWord, wholeWord: false });
      expect(partials).toEqual(substrings);
      expect(partials.map(({ from, to }) => text.slice(from, to))).toEqual(substrings.map(() => query));
    });

    it.each([
      { name: "decomposed Latin", word: "nai\u0308ve", units: 6 },
      { name: "spacing vowel mark", word: "\u0915\u093e", units: 2 },
      { name: "enclosing mark", word: "a\u20dd", units: 2 },
      { name: "supplementary spacing mark", word: "a\u{1D165}", units: 3 },
      { name: "supplementary nonspacing mark", word: "a\u{1E000}", units: 3 },
      { name: "multiple marks", word: "a\u0308\u0301", units: 3 },
    ])("matches complete $name words at ordinary boundaries", ({ word, units }) => {
      const text = `${word}, ${word} ${word}`;
      const matches = findMatches(text, word, wholeWord);
      expect(matches).toEqual([
        { from: 0, to: units },
        { from: units + 2, to: 2 * units + 2 },
        { from: 2 * units + 3, to: 3 * units + 3 },
      ]);
      expect(matches.map(({ from, to }) => text.slice(from, to))).toEqual([word, word, word]);
    });

    it("keeps case matching independent of marked-word boundaries", () => {
      const text = "NAI\u0308VE nai\u0308ve NAI nai Nai";
      const insensitive = findMatches(text, "nai", wholeWord);
      expect(insensitive).toEqual([{ from: 14, to: 17 }, { from: 18, to: 21 }, { from: 22, to: 25 }]);
      expect(insensitive.map(({ from, to }) => text.slice(from, to))).toEqual(["NAI", "nai", "Nai"]);
      expect(findMatches(text, "nai", { ...wholeWord, matchCase: true })).toEqual([{ from: 18, to: 21 }]);
      expect(findMatches(text, "nai\u0308ve", wholeWord)).toEqual([{ from: 0, to: 6 }, { from: 7, to: 13 }]);
      expect(findMatches(text, "nai\u0308ve", { ...wholeWord, matchCase: true })).toEqual([{ from: 7, to: 13 }]);
    });

    it.each([
      { name: "Latin letter", boundary: "a", blocked: true },
      { name: "Greek letter", boundary: "\u03b1", blocked: true },
      { name: "supplementary letter", boundary: "\u{10400}", blocked: true },
      { name: "digit", boundary: "2", blocked: true },
      { name: "underscore", boundary: "_", blocked: true },
      { name: "punctuation", boundary: ".", blocked: false },
      { name: "apostrophe", boundary: "'", blocked: false },
      { name: "hyphen", boundary: "-", blocked: false },
      { name: "zero-width non-joiner", boundary: "\u200c", blocked: false },
      { name: "zero-width joiner", boundary: "\u200d", blocked: false },
    ])("preserves existing $name boundaries", ({ boundary, blocked }) => {
      const text = `${boundary}cat cat${boundary} cat`;
      const units = boundary.length;
      const standalone = { from: 2 * units + 8, to: 2 * units + 11 };
      const matches = findMatches(text, "cat", wholeWord);
      expect(matches).toEqual(blocked ? [standalone] : [
        { from: units, to: units + 3 },
        { from: units + 4, to: units + 7 },
        standalone,
      ]);
      expect(matches.map(({ from, to }) => text.slice(from, to))).toEqual(blocked ? ["cat"] : ["cat", "cat", "cat"]);
    });

    it.each([
      { name: "NFC query against NFD source", text: "cafe\u0301", query: "caf\u00e9" },
      { name: "NFD query against NFC source", text: "caf\u00e9", query: "cafe\u0301" },
    ])("does not normalize $name", ({ text, query }) => {
      expect(findMatches(text, query, wholeWord)).toEqual([]);
      expect(findMatches(text, query, { ...wholeWord, wholeWord: false })).toEqual([]);
      expect(findMatches(text, text, wholeWord)).toEqual([{ from: 0, to: text.length }]);
    });
  });

  it("applies whole word boundaries to every regex alternative", () => {
    const text = "nai\u0308ve nai ve";
    const matches = findMatches(text, "nai|ve", { ...opts, regex: true, wholeWord: true });
    expect(matches).toEqual([{ from: 7, to: 10 }, { from: 11, to: 13 }]);
    expect(matches.map(({ from, to }) => text.slice(from, to))).toEqual(["nai", "ve"]);
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

  it("preserves numbered groups and full matches for whole marked words", () => {
    const text = "\uD83D\uDE00 nai\u0308ve!";
    const query = "(nai)(\u0308)(ve)";
    const options = { ...opts, regex: true, wholeWord: true };
    const match = { from: 3, to: 9 };
    expect(findMatches(text, query, options)).toEqual([match]);
    expect(text.slice(match.from, match.to)).toBe("nai\u0308ve");
    expect(expandReplacement(text, match, query, options, "$3|$2|$1|$&|$$")).toBe("ve|\u0308|nai|nai\u0308ve|$");
  });
});
