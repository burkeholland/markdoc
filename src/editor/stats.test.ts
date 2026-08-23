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

  it("runs under 5 ms on a 3,000-line document after warm-up", () => {
    // Same shape as scripts/perf-typing.mts builds.
    const section = (i: number) =>
      `## Section ${i}\n\nParagraph ${i} with **bold**, *emphasis*, a [link](https://example.com/${i}) and \`code\`. The quick brown fox jumps over the lazy dog again and again.\n\n- item one\n- item two\n- [ ] task ${i}\n\n\`\`\`js\nconst x${i} = ${i};\n\`\`\`\n\n`;
    const big = "# Big document\n\n" + Array.from({ length: 260 }, (_, i) => section(i)).join("");
    expect(big.split("\n").length).toBeGreaterThanOrEqual(3000);
    computeStats(big);
    computeStats(big + " ");
    computeStats(big + "  ");
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const input = big + "!".repeat(i + 3);
      const t0 = performance.now();
      computeStats(input);
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    expect(runs[Math.floor(runs.length / 2)]).toBeLessThan(5);
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

  it("memoises the last range", () => {
    const a = computeSelectionStats(FIXTURE, 10, 60);
    expect(computeSelectionStats(FIXTURE, 10, 60)).toBe(a);
  });
});

describe("goalProgress", () => {
  const stats = { ...EMPTY_STATS, words: 120, readingMinutes: 1 };
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
