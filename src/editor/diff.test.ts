import { describe, expect, it } from "vitest";
import { collapseUnchanged, detectMoves, hunkCounter, hunks, wordDiff, type DiffSegment } from "./diff";

const seg = (value: string, flags: Partial<DiffSegment> = {}): DiffSegment => ({ value, added: false, removed: false, ...flags });
const ins = (value: string) => seg(value, { added: true });
const del = (value: string) => seg(value, { removed: true });

describe("hunks", () => {
  it("groups changes separated by at most two unchanged line breaks", () => {
    const segs = [seg("a "), del("x"), ins("y"), seg(" b\n\nc "), ins("z"), seg(" tail")];
    expect(hunks(segs)).toEqual([{ start: 1, end: 4, kind: "replace" }]);
  });

  it("starts a new hunk after three or more unchanged line breaks", () => {
    const segs = [seg("a "), del("x"), seg(" b\n\n\nc "), ins("z"), seg(" tail")];
    expect(hunks(segs)).toEqual([
      { start: 1, end: 1, kind: "delete" },
      { start: 3, end: 3, kind: "insert" },
    ]);
  });

  it("counts the gap across several unchanged segments and ignores leading/trailing context", () => {
    const segs = [seg("one\n\n\n\n"), ins("x"), seg("\n"), seg("\n"), seg("\n"), del("y"), seg("\n\n\n\n")];
    expect(hunks(segs)).toEqual([
      { start: 1, end: 1, kind: "insert" },
      { start: 5, end: 5, kind: "delete" },
    ]);
    expect(hunks([seg("nothing changed")])).toEqual([]);
  });

  it("a moved block is its own hunk kind and absorbs neighbouring edits", () => {
    const segs = [seg("a\n"), seg("b ", { moved: true }), ins("c")];
    expect(hunks(segs)).toEqual([{ start: 1, end: 2, kind: "moved" }]);
  });
});

describe("detectMoves", () => {
  const para = "Alpha paragraph with some distinct wording here, long enough.";

  it("renders a paragraph that moved from top to bottom once, as moved, at its new position", () => {
    const a = `# Title\n\n${para}\n\nBeta section talks about other unrelated matters entirely.\n\nGamma closing remarks finish the document nicely.\n`;
    const b = `# Title\n\nBeta section talks about other unrelated matters entirely.\n\nGamma closing remarks finish the document nicely.\n\n${para}\n`;
    const segs = detectMoves(wordDiff(a, b));
    expect(segs.filter((s) => s.removed)).toEqual([]);
    expect(segs.filter((s) => s.added)).toEqual([]);
    const moved = segs.filter((s) => s.moved);
    expect(moved).toHaveLength(1);
    expect(moved[0].value.trim()).toBe(para);
    expect(segs.indexOf(moved[0])).toBe(segs.length - 1);
    expect(hunks(segs)).toEqual([{ start: segs.length - 1, end: segs.length - 1, kind: "moved" }]);
  });

  it("requires an exact match after trimming: one changed character is a delete + insert", () => {
    const segs = detectMoves([seg("# T\n\n"), del(`${para}\n\n`), seg("middle text\n\n"), ins(`${para.replace("long", "lonf")}\n`)]);
    expect(segs.some((s) => s.moved)).toBe(false);
    expect(segs.filter((s) => s.removed)).toHaveLength(1);
    expect(segs.filter((s) => s.added)).toHaveLength(1);
  });

  it("ignores short blocks (< 40 chars) even when they match exactly", () => {
    const short = "Short line, thirty chars or so.";
    expect(short.length).toBeLessThan(40);
    const segs = detectMoves([seg("a\n\n"), del(`${short}\n\n`), seg("b\n\n"), ins(`${short}\n`)]);
    expect(segs.some((s) => s.moved)).toBe(false);
    expect(segs).toHaveLength(4);
  });

  it("accepts a block of exactly 40 chars and pairs each removal with one insertion", () => {
    const forty = "x".repeat(40);
    expect(forty).toHaveLength(40);
    const segs = detectMoves([del(`${forty}\n`), seg("mid\n"), ins(`  ${forty}\n`), ins(`${forty}\n`)]);
    expect(segs.filter((s) => s.moved)).toHaveLength(1);
    expect(segs.filter((s) => s.added)).toHaveLength(1);
    expect(segs.filter((s) => s.removed)).toHaveLength(0);
  });
});

describe("hunkCounter", () => {
  it("reads 'N of M changes', singular for one, and 'No changes' when empty", () => {
    expect(hunkCounter(2, 14)).toBe("3 of 14 changes");
    expect(hunkCounter(0, 1)).toBe("1 of 1 change");
    expect(hunkCounter(0, 0)).toBe("No changes");
    expect(hunkCounter(99, 3)).toBe("3 of 3 changes");
  });
});

describe("collapseUnchanged", () => {
  it("keeps moved segments and shortens only long unchanged stretches", () => {
    const long = Array.from({ length: 120 }, (_, i) => `w${i}`).join(" ");
    const out = collapseUnchanged([ins("a"), seg(long), seg("moved block", { moved: true })], 10);
    expect(out[0]).toEqual(ins("a"));
    expect(out.some((c) => "collapsed" in c)).toBe(true);
    expect(out[out.length - 1]).toEqual(seg("moved block", { moved: true }));
  });
});
