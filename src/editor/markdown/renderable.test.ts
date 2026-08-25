import { describe, expect, it } from "vitest";
import { decideInsert, findUnrenderable, findUnrenderableRanges, MAX_ATTENTION_MARKERS_PER_PARAGRAPH, MAX_LABEL_ENDS_PER_PARAGRAPH, wrapInCodeFence } from "./renderable";
import { parseMarkdown } from "./parse";
import { serializeMarkdown } from "./serialize";
import { reparseRange, textChangeSpan } from "./incremental";
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

describe("findUnrenderableRanges / decideInsert / wrapInCodeFence (client guard, #115)", () => {
  const soup = "[".repeat(40_000) + "a" + "]".repeat(40_000);

  it("reports nothing for ordinary text and the exact paragraph otherwise", () => {
    expect(findUnrenderableRanges("# Hi\n\nSome [link](x).\n")).toEqual([]);
    const doc = `# Title\n\nintro\n\n${soup}\n\nafter\n`;
    const from = "# Title\n\nintro\n\n".length;
    expect(findUnrenderableRanges(doc)).toEqual([{ from, to: from + soup.length, reason: "brackets", count: 40_000 }]);
  });

  it("keeps the soft-wrapped paragraph together and reports several paragraphs in order", () => {
    const one = "a]".repeat(MAX_LABEL_ENDS_PER_PARAGRAPH) + "\n]";
    const two = "*a".repeat(MAX_ATTENTION_MARKERS_PER_PARAGRAPH + 1);
    const ranges = findUnrenderableRanges(`${one}\n\nfine\n\n${two}`);
    expect(ranges.map((r) => r.reason)).toEqual(["brackets", "emphasis"]);
    expect(ranges[0]).toMatchObject({ from: 0, to: one.length });
    expect(ranges[1]).toMatchObject({ from: one.length + "\n\nfine\n\n".length, to: one.length + "\n\nfine\n\n".length + two.length });
  });

  it("ignores fenced code and table rows like findUnrenderable", () => {
    expect(findUnrenderableRanges("```\n" + soup + "\n```\n")).toEqual([]);
    expect(findUnrenderableRanges("| " + "]".repeat(5000) + " |\n")).toEqual([]);
  });

  it("decideInsert lets Markdown through and turns bracket soup into a code block with the toast text", () => {
    expect(decideInsert("# Hi\n\n- a\n- b\n")).toEqual({ kind: "markdown" });
    const d = decideInsert(soup);
    expect(d.kind).toBe("code");
    if (d.kind === "code") {
      expect(d.count).toBe(40_000);
      expect(d.message).toBe("Pasted text contains 40,000 unbalanced brackets in one paragraph and cannot be rendered — inserted as a code block");
    }
    const e = decideInsert("*a".repeat(2001), "Imported file");
    expect(e.kind === "code" && e.message.startsWith("Imported file contains 2,001 emphasis markers")).toBe(true);
  });

  it("wrapInCodeFence uses a fence longer than any backtick run inside and the result passes the guard", () => {
    expect(wrapInCodeFence("x")).toBe("```\nx\n```");
    expect(wrapInCodeFence("a ```` b")).toBe("`````\na ```` b\n`````");
    expect(wrapInCodeFence("\n\n" + soup + "\n")).toBe("```\n" + soup + "\n```");
    expect(findUnrenderable(wrapInCodeFence(soup))).toBeNull();
    expect(decideInsert(wrapInCodeFence(soup))).toEqual({ kind: "markdown" });
  });
});

describe("parseMarkdown with pathological paragraphs", () => {
  const soup = "[".repeat(40_000) + "a" + "]".repeat(40_000);

  it("renders a placeholder for the bad paragraph, keeps the rest, and round-trips the source", () => {
    const src = `# Title\n\nintro\n\n${soup}\n\nafter *em*\n`;
    const started = performance.now();
    const { doc, map, headings } = parseMarkdown(src);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(doc.childCount).toBe(4);
    expect(doc.child(0).type.name).toBe("heading");
    expect(doc.child(2).type.name).toBe("unrenderable");
    expect(doc.child(2).attrs.src).toBe(soup);
    expect(doc.child(3).textContent).toBe("after em");
    expect(headings).toHaveLength(1);
    const from = "# Title\n\nintro\n\n".length;
    expect(map.blocks[2]).toEqual({ from, to: from + soup.length });
    expect(map.blocks[3].from).toBe(from + soup.length + 2);
    expect(serializeMarkdown(doc)).toBe(src.trimEnd());
  });

  it("a whole document of bracket soup becomes one placeholder and the tree hides it as raw html", () => {
    const { doc, tree } = parseMarkdown(soup);
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).type.name).toBe("unrenderable");
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].type).toBe("html");
  });

  it("the incremental parser keeps working around a placeholder", () => {
    const src = `intro\n\n${soup}\n\nafter\n`;
    const next = `intro!\n\n${soup}\n\nafter\n`;
    const prev = parseMarkdown(src);
    const inc = reparseRange(prev, src, next, textChangeSpan(src, next)!);
    expect(inc).not.toBeNull();
    expect(inc!.doc.child(0).textContent).toBe("intro!");
    expect(inc!.doc.child(1).type.name).toBe("unrenderable");
    expect(inc!.doc.eq(parseMarkdown(next).doc)).toBe(true);
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
