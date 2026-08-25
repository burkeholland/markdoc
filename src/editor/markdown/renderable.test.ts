import { describe, expect, it } from "vitest";
import { findUnrenderable, MAX_ATTENTION_MARKERS_PER_PARAGRAPH, MAX_LABEL_ENDS_PER_PARAGRAPH } from "./renderable";
import { computeStats } from "../stats";

describe("findUnrenderable", () => {
  it("accepts ordinary documents, big tables and bracket-heavy code blocks", () => {
    const doc = [
      "# Title",
      "",
      "Some [link](x) with **bold**, _it_ and a footnote[^1].",
      "",
      "| a | b |",
      "|---|---|",
      ...Array.from({ length: 3000 }, () => "| [x](y) | **b** |"),
      "",
      "```json",
      "]".repeat(5000),
      "```",
      "",
      "[^1]: note",
    ].join("\n");
    expect(findUnrenderable(doc)).toBeNull();
  });

  it("refuses the #115 repro: 40k `[` + a + 40k `]` in one paragraph", () => {
    expect(findUnrenderable("[".repeat(40_000) + "a" + "]".repeat(40_000))).toBe("brackets");
  });

  it("counts per paragraph: the same brackets spread over blank-line separated paragraphs are fine", () => {
    const para = "a]".repeat(MAX_LABEL_ENDS_PER_PARAGRAPH);
    expect(findUnrenderable(Array.from({ length: 40 }, () => para).join("\n\n"))).toBeNull();
    expect(findUnrenderable(para + "]")).toBe("brackets");
    // Soft line breaks keep a paragraph together.
    expect(findUnrenderable(para + "\n]")).toBe("brackets");
  });

  it("refuses alternating emphasis markers past the limit", () => {
    expect(findUnrenderable("*a".repeat(MAX_ATTENTION_MARKERS_PER_PARAGRAPH))).toBeNull();
    expect(findUnrenderable("*a".repeat(MAX_ATTENTION_MARKERS_PER_PARAGRAPH + 1))).toBe("emphasis");
    expect(findUnrenderable("_a".repeat(MAX_ATTENTION_MARKERS_PER_PARAGRAPH + 1))).toBe("emphasis");
  });

  it("is linear: 2 MB of brackets is classified in milliseconds", () => {
    const started = performance.now();
    expect(findUnrenderable("[".repeat(1_000_000) + "a" + "]".repeat(1_000_000))).toBe("brackets");
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("computeStats on bracket soup (#115)", () => {
  it("stays linear on unmatched `[` and `![` runs", () => {
    const started = performance.now();
    computeStats("[".repeat(40_000) + "a" + "]".repeat(40_000));
    computeStats("![a".repeat(40_000));
    computeStats("[a".repeat(40_000));
    computeStats("<".repeat(40_000) + "a>");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("still strips links, images and tags the same way", () => {
    const s = computeStats("See [the docs](https://x.y) and ![pic](/img.png) and [ref][r] and <b>tag</b> ![i][r]. [[a]](b)");
    // "See the docs and and ref and tag . [[a]](b)" → words: See the docs and and ref and tag a b
    expect(s.words).toBe(10);
  });
});
