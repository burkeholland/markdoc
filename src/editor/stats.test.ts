import { describe, expect, it } from "vitest";
import { computeStats, computeSelectionStats, EMPTY_STATS, goalProgress, minutesFor } from "./stats";

const FIXTURE = [
  "---",
  "title: Front matter",
  "tags: [a, b, c]",
  "---",
  "",
  "# Main heading",
  "",
  "First paragraph with **bold** and *emphasis*. It has two sentences!",
  "",
  "## Second heading",
  "",
  "- item one",
  "- item two with `inline code`",
  "",
  "A [link text](https://example.com/very/long/url-that-is-not-counted) here.",
  "",
  "![alt text that is not counted](https://example.com/image.png)",
  "",
  "```js",
  "const excluded = 'code fence words should not count';",
  "```",
  "",
  "Last paragraph without terminal punctuation",
  "",
].join("\n");

describe("computeStats", () => {
  it("counts prose words, excluding fences, front matter, images and URLs", () => {
    const s = computeStats(FIXTURE);
    // "Main heading" (2) + "First paragraph with bold and emphasis. It has two sentences!" (10)
    // + "Second heading" (2) + "item one item two with inline code" (7) + "A link text here." (4)
    // + "Last paragraph without terminal punctuation" (5)
    expect(s.words).toBe(30);
    expect(s.headings).toBe(2);
    // List block, paragraph, link paragraph, last paragraph.
    expect(s.paragraphs).toBe(4);
    // Two in the first paragraph, one in the link paragraph, one implied in the unpunctuated one,
    // and one implied for the list block.
    expect(s.sentences).toBe(5);
    expect(s.characters).toBeGreaterThan(s.charactersNoSpaces);
    expect(s.charactersNoSpaces).toBeGreaterThan(0);
  });

  it("drops words that only appear in excluded regions", () => {
    expect(computeStats("---\nonly: frontmatter\n---\n").words).toBe(0);
    expect(computeStats("```\ncode only\n```\n").words).toBe(0);
    expect(computeStats("![image](x.png)\n").words).toBe(0);
    expect(computeStats("[Click](https://example.com/path-with-words)").words).toBe(1);
    expect(computeStats("Use `npm ci` now.").words).toBe(4);
  });

  it("counts marked heading, prose, link and inline-code words without counting excluded regions", () => {
    const heading = "nai\u0308ve";
    const prose = "\u0915\u093F\u0924\u093E\u092C cafe\u0301 re\u0301sume\u0301.";
    const markdown = [
      "---",
      "title: nai\u0308ve",
      "---",
      "",
      `# ${heading}`,
      "",
      "\u0915\u093F\u0924\u093E\u092C [cafe\u0301](https://example.com/nai\u0308ve) `re\u0301sume\u0301`.",
      "",
      "![nai\u0308ve](image.png)",
      "",
      "```text",
      "nai\u0308ve re\u0301sume\u0301",
      "```",
      "",
      "~~~",
      "\u0915\u093F\u0924\u093E\u092C",
      "~~~",
    ].join("\n");

    expect(computeStats(markdown)).toEqual({
      words: 4,
      characters: heading.length + prose.length,
      charactersNoSpaces: heading.length + prose.replace(/ /g, "").length,
      sentences: 1,
      paragraphs: 1,
      headings: 1,
      readingMinutes: 1,
      speakingMinutes: 1,
    });
  });

  it("keeps source character lengths and distinct cache entries for equivalent accented spellings", () => {
    const composed = "na\u00EFve caf\u00E9";
    const decomposed = "nai\u0308ve cafe\u0301";
    const nfc = computeStats(composed);
    expect(computeStats(composed)).toBe(nfc);
    const nfd = computeStats(decomposed);
    expect(computeStats(decomposed)).toBe(nfd);
    expect(nfd).not.toBe(nfc);
    expect(nfc).toMatchObject({ words: 2, characters: 10, charactersNoSpaces: 9 });
    expect(nfd).toEqual({ ...nfc, characters: 12, charactersNoSpaces: 11 });
    expect(nfc.characters).toBe(composed.length);
    expect(nfd.characters).toBe(decomposed.length);
  });

  it("does not count isolated marks as prose words", () => {
    expect(computeStats("\u0301 \u093E \u20DD").words).toBe(0);
  });

  it("handles a tilde fence and text after it", () => {
    const s = computeStats("~~~\nignored words here\n~~~\n\nReal words.\n");
    expect(s.words).toBe(2);
  });

  it("returns empty stats for an empty document", () => {
    expect(computeStats("")).toBe(EMPTY_STATS);
    expect(computeStats("\n\n")).toEqual(EMPTY_STATS);
  });

  it("rounds reading and speaking minutes with a floor of one", () => {
    expect(minutesFor(0, 200)).toBe(0);
    expect(minutesFor(1, 200)).toBe(1);
    expect(minutesFor(299, 200)).toBe(1);
    expect(minutesFor(301, 200)).toBe(2);
    const words = Array.from({ length: 1300 }, (_, i) => `w${i}`).join(" ");
    const s = computeStats(words);
    expect(s.words).toBe(1300);
    expect(s.readingMinutes).toBe(7); // 6.5 rounds up
    expect(s.speakingMinutes).toBe(10);
    expect(computeStats("One word").readingMinutes).toBe(1);
  });

  it("memoises on the input string", () => {
    const a = computeStats(FIXTURE);
    const b = computeStats(FIXTURE);
    expect(b).toBe(a);
    computeStats("something else");
    expect(computeStats(FIXTURE)).not.toBe(a);
    expect(computeStats(FIXTURE)).toEqual(a);
  });

  it("stays fast on a 3,000-line document: fastest cold run within budget, fastest memoised call under 0.5 ms", { retry: 1 }, () => {
    // Same shape as scripts/perf-typing.mts builds.
    const section = (i: number) =>
      `## Section ${i}\n\nParagraph ${i} with **bold**, *emphasis*, a [link](https://example.com/${i}) and \`code\`. The quick brown fox jumps over the lazy dog again and again.\n\n- item one\n- item two\n- [ ] task ${i}\n\n\`\`\`js\nconst x${i} = ${i};\n\`\`\`\n\n`;
    const big = "# Big document\n\n" + Array.from({ length: 260 }, (_, i) => section(i)).join("");
    expect(big.split("\n").length).toBeGreaterThanOrEqual(3000);
    // Warm-up: JIT and the regexes. Each input differs so the size-1 memo never short-circuits.
    computeStats(big);
    computeStats(big + " ");
    computeStats(big + "  ");

    // Wall-clock bounds on a shared machine are noisy: with a dozen builds and suites saturating the box a
    // run is CPU-starved, not slow, and the median of 5 runs crossed the 10 ms budget in release preflights.
    // Load can only add time, so the assertions use the minimum of 9 runs — what the code costs when it
    // gets the CPU — which still catches a regression to tens of milliseconds. Measured (task #1143): idle
    // a cold run is 1.3–2 ms; with a busy thread per core the fastest of 9 was 2.9–5.5 ms while the median
    // of 5 reached 9.5 ms; with two busy threads per core on an already saturated box the median of 5
    // failed every time (12–28 ms) and the fastest of 9 stayed within budget in 19 of 20 runs. `retry: 1`
    // covers the pass in which not one of the 9 runs got the CPU.
    const RUNS = 9;
    const cold: number[] = [];
    const memoised: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const input = big + "!".repeat(i + 3);
      const t0 = performance.now();
      computeStats(input);
      cold.push(performance.now() - t0);
      const t1 = performance.now();
      computeStats(input);
      memoised.push(performance.now() - t1);
    }
    const fastest = (runs: number[]) => Math.min(...runs);
    const budgetMs = process.env.CI ? 25 : 10;
    expect(fastest(cold), `cold runs (ms): ${cold.map((r) => r.toFixed(2)).join(", ")}`).toBeLessThan(budgetMs);
    // The status bar re-reads stats on every render; the memo hit is the guarantee it relies on.
    expect(fastest(memoised), `memoised runs (ms): ${memoised.map((r) => r.toFixed(3)).join(", ")}`).toBeLessThan(0.5);
  });
});

describe("computeSelectionStats", () => {
  it("counts only the selected range", () => {
    const text = "Hello big world. Another sentence here.";
    const s = computeSelectionStats(text, 0, 16);
    expect(s.words).toBe(3);
    expect(s.sentences).toBe(1);
    expect(computeSelectionStats(text, 16, 0).words).toBe(3);
    expect(computeSelectionStats(text, 5, 5)).toBe(EMPTY_STATS);
    expect(computeSelectionStats(text, -10, 1000).words).toBe(6);
  });

  it("uses source offsets and lengths for a marked range in either direction", () => {
    const selected = "nai\u0308ve cafe\u0301";
    const text = `Before \u{1F600} ${selected} after.`;
    const from = text.indexOf(selected);
    const to = from + selected.length;
    const forward = computeSelectionStats(text, from, to);
    expect(forward).toMatchObject({ words: 2, characters: 12, charactersNoSpaces: 11 });
    expect(computeSelectionStats(text, to, from)).toEqual(forward);
    expect(computeSelectionStats(text, -10, text.length + 10)).toEqual(computeStats(text));
    const mark = text.indexOf("\u0308");
    expect(computeSelectionStats(text, mark, mark + 1).words).toBe(0);
  });

  it("memoises the last range", () => {
    const a = computeSelectionStats(FIXTURE, 10, 60);
    expect(computeSelectionStats(FIXTURE, 10, 60)).toBe(a);
  });
});

describe("goalProgress", () => {
  const stats = { ...EMPTY_STATS, words: 120, readingMinutes: 1 };

  it("derives times and word-goal states from 200 decomposed words", () => {
    const marked = computeStats(Array.from({ length: 200 }, () => "nai\u0308ve").join(" "));
    expect(marked).toMatchObject({ words: 200, readingMinutes: 1, speakingMinutes: 2 });
    for (const mode of ["min", "max"] as const) {
      expect(goalProgress(marked, { kind: "words", mode, value: 200, setBy: null, setAt: 0 }))
        .toEqual({ current: 200, target: 200, fraction: 1, state: "reached" });
    }
  });

  it("tracks a minimum word goal", () => {
    const p = goalProgress(stats, { kind: "words", mode: "min", value: 200, setBy: null, setAt: 0 });
    expect(p).toMatchObject({ current: 120, target: 200, state: "progress" });
    expect(p.fraction).toBeCloseTo(0.6);
    expect(goalProgress(stats, { kind: "words", mode: "min", value: 100, setBy: null, setAt: 0 }).state).toBe("reached");
  });
  it("flags an exceeded maximum", () => {
    expect(goalProgress(stats, { kind: "words", mode: "max", value: 100, setBy: null, setAt: 0 }).state).toBe("exceeded");
    expect(goalProgress(stats, { kind: "words", mode: "max", value: 120, setBy: null, setAt: 0 }).state).toBe("reached");
    expect(goalProgress(stats, { kind: "minutes", mode: "min", value: 3, setBy: null, setAt: 0 })).toMatchObject({ current: 1, target: 3, state: "progress" });
  });
});
