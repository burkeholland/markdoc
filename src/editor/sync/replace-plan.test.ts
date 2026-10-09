import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { planReplace, replaceText, REPLACE_LIMITS, type ExactDiff } from "./replace-plan";
import { applyOps, diffOps, type TextOp } from "./text-diff";

/** The largest text the content route accepts. */
const LARGEST = 2_000_000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const ASCII = "abcdefghijklmnopqrstuvwxyz";
const CJK = "文字漢語日本中国章書読話聞見食水火木金土山川田人大小上下左右";

/** Prose with a known seed: words, a line every 14 words, a blank line every 56. Exactly `chars` long. */
function prose(chars: number, seed: number, alphabet = ASCII): string {
  const r = rng(seed);
  const out: string[] = [];
  let n = 0;
  let words = 0;
  while (n < chars) {
    let w = "";
    for (let i = 2 + Math.floor(r() * 8); i > 0; i--) w += alphabet[Math.floor(r() * alphabet.length)];
    words++;
    const sep = words % 14 === 0 ? (words % 56 === 0 ? "\n\n" : "\n") : " ";
    out.push(w + sep);
    n += w.length + sep.length;
  }
  return out.join("").slice(0, chars);
}

/** Change, drop or add `edits` words of `text`. */
function edited(text: string, edits: number, seed: number, mark = "X"): string {
  const r = rng(seed);
  const parts = text.split(/(\s+)/);
  for (let i = 0; i < edits; i++) {
    const k = Math.floor(r() * parts.length) & ~1;
    parts[k] = r() < 0.2 ? "" : parts[k] + mark + Math.floor(r() * 1000);
  }
  return parts.join("");
}

/** What the edits make of `text`, on a real shared text, the way the server applies them. */
function applied(text: string, ops: TextOp[]): string {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, text);
  doc.transact(() => applyOps(ytext, ops));
  const result = ytext.toString();
  doc.destroy();
  return result;
}

/** A character diff that only counts: what it is asked to do, never how long it takes. */
function counting() {
  const calls: { product: number; whole: boolean }[] = [];
  const exact: ExactDiff = (oldText, newText, from) => {
    calls.push({ product: oldText.length * newText.length, whole: from === 0 });
    return [{ index: from, deleteCount: oldText.length, insert: newText }];
  };
  return { calls, exact };
}

describe("planReplace: the edits turn the old text into the new one", () => {
  const A = prose(30_000, 1);
  const cases: [string, string, string][] = [
    ["nothing changed", A, A],
    ["one word changed in the middle", A, A.slice(0, 15_000) + "CHANGED" + A.slice(15_007)],
    ["5 words changed", A, edited(A, 5, 2)],
    ["400 words changed", A, edited(A, 400, 3)],
    ["every word another one", A, prose(30_000, 99)],
    ["into Chinese letters", A, prose(30_000, 4, CJK)],
    ["Chinese letters, 300 words changed", prose(30_000, 5, CJK), edited(prose(30_000, 5, CJK), 300, 6, "文")],
    ["from nothing", "", A],
    ["to nothing", A, ""],
    ["a small text to a large one", "Start\n", A],
    ["a large text to a small one", A, "Start\n"],
    ["text added at the end", A, A + "\n\nOne more paragraph.\n"],
    ["text added at the start", A, "# Title\n\n" + A],
    ["the two halves swapped", A, A.slice(15_000) + A.slice(0, 15_000)],
    ["one line without a line feed, 60 words changed", A.replace(/\n/g, " "), edited(A.replace(/\n/g, " "), 60, 7)],
    ["lines that all repeat", "same line\n".repeat(3_000), "same line\n".repeat(1_500) + "other line\n".repeat(1_500)],
    ["only line feeds to letters", "\n".repeat(20_000), "a\n".repeat(10_000)],
    ["the same two letters the other way round", "ab".repeat(15_000), "ba".repeat(15_000)],
    ["Windows line ends", A.replace(/\n/g, "\r\n"), edited(A, 50, 8).replace(/\n/g, "\r\n")],
  ];
  it.each(cases)("%s", (_name, oldText, newText) => {
    const plan = planReplace(oldText, newText);
    expect(applied(oldText, plan.ops)).toBe(newText);
    // In document order, each after the one before it: `applyOps` needs no sorting.
    for (let i = 1; i < plan.ops.length; i++) expect(plan.ops[i].index).toBeGreaterThanOrEqual(plan.ops[i - 1].index + plan.ops[i - 1].insert.length);
  });

  it("200 random pairs, small and large changes mixed", () => {
    const r = rng(2341);
    for (let i = 0; i < 200; i++) {
      const alphabet = i % 4 === 0 ? CJK : ASCII;
      const base = prose(200 + Math.floor(r() * 12_000), i + 10, alphabet);
      const next = i % 7 === 0 ? prose(200 + Math.floor(r() * 12_000), i + 5_000, alphabet) : edited(base, 1 + Math.floor(r() * 80), i + 9_000);
      expect(applied(base, planReplace(base, next).ops), `pair ${i}`).toBe(next);
    }
  });

  it("with limits so small that every tier is used on a short text", () => {
    const limits = { maxExactProduct: 64, exactBudget: 640, maxPieces: 4_000 };
    const r = rng(7);
    for (let i = 0; i < 100; i++) {
      const base = prose(300 + Math.floor(r() * 3_000), i + 1);
      const next = edited(base, 1 + Math.floor(r() * 40), i + 100);
      const plan = planReplace(base, next, limits);
      expect(applied(base, plan.ops), `pair ${i}`).toBe(next);
      expect(plan.exactWork).toBeLessThanOrEqual(limits.exactBudget);
      expect(plan.pieces).toBeLessThanOrEqual(limits.maxPieces);
    }
  });
});

describe("planReplace: never half a character", () => {
  // 😀 (U+1F600) and 😁 share their first half (D83D); 😀 and U+1FA00 share their second half (DE00).
  const SAME_END = "\u{1FA00}";
  it("the two characters of the cases really share a half", () => {
    expect("😀".charCodeAt(0)).toBe("😁".charCodeAt(0));
    expect("😀".charCodeAt(1)).toBe(SAME_END.charCodeAt(1));
    expect("😀".charCodeAt(0)).not.toBe(SAME_END.charCodeAt(0));
  });
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const cases: [string, string, string][] = [
    ["the first halves are the same", "before 😀 after", "before 😁 after"],
    ["the second halves are the same", "before 😀 after", `before ${SAME_END} after`],
    ["a long text, emoji changed at both ends of the change", "😀" + prose(3_000, 1) + "😀", "😁" + prose(3_000, 2) + SAME_END],
    ["a long text, the second halves the same at the start and the first halves at the end", "😀" + prose(3_000, 3) + "😀", SAME_END + prose(3_000, 4) + "😁"],
    ["a text of emoji only", "😀😁".repeat(2_000), "😁😀".repeat(2_000)],
  ];
  it.each(cases)("%s", (_name, oldText, newText) => {
    for (const limits of [REPLACE_LIMITS, { maxExactProduct: 4, exactBudget: 8, maxPieces: 1_000 }]) {
      const plan = planReplace(oldText, newText, limits);
      expect(applied(oldText, plan.ops)).toBe(newText);
      let text = oldText;
      for (const op of plan.ops) {
        // What stays on either side of an edit, what goes and what comes are each whole characters.
        expect(lone.test(text.slice(0, op.index)), "text before the edit").toBe(false);
        expect(lone.test(text.slice(op.index, op.index + op.deleteCount)), "text removed").toBe(false);
        expect(lone.test(op.insert), "text added").toBe(false);
        text = text.slice(0, op.index) + op.insert + text.slice(op.index + op.deleteCount);
      }
    }
  });
});

describe("planReplace: a small change gets the edits it always got", () => {
  it("is diffOps of the two whole texts, edit for edit, while the changed part is small", () => {
    const r = rng(11);
    for (let i = 0; i < 300; i++) {
      const base = prose(500 + Math.floor(r() * 60_000), i + 1, i % 3 ? ASCII : CJK);
      const at = Math.floor(r() * (base.length - 400));
      // One passage of up to 400 characters rewritten: at most 400 × 500 = 200,000, under the limit.
      const next = base.slice(0, at) + edited(base.slice(at, at + 400), 1 + Math.floor(r() * 12), i + 77) + base.slice(at + 400);
      expect(planReplace(base, next).ops, `pair ${i}`).toEqual(diffOps(base, next, 0));
    }
  });

  it("hands the two WHOLE texts to the character diff, once", () => {
    const base = prose(50_000, 3);
    const next = base.slice(0, 20_000) + "one new sentence " + base.slice(20_000);
    const { calls, exact } = counting();
    planReplace(base, next, REPLACE_LIMITS, exact);
    expect(calls).toEqual([{ product: base.length * next.length, whole: true }]);
  });

  it("at the limit still does; one character over it does not", () => {
    const side = Math.sqrt(REPLACE_LIMITS.maxExactProduct);
    const at = counting();
    planReplace("a".repeat(side), "b".repeat(side), REPLACE_LIMITS, at.exact);
    expect(at.calls).toEqual([{ product: REPLACE_LIMITS.maxExactProduct, whole: true }]);
    const over = counting();
    const plan = planReplace("a".repeat(side + 1), "b".repeat(side), REPLACE_LIMITS, over.exact);
    expect(over.calls).toEqual([]);
    expect(plan.ops).toEqual([{ index: 0, deleteCount: side + 1, insert: "b".repeat(side) }]);
  });
});

describe("planReplace: anchors keep what did not change", () => {
  it("edits in 20 lines of a long text touch those lines only", () => {
    const base = prose(400_000, 21);
    const next = edited(base, 20, 22);
    const plan = planReplace(base, next);
    expect(applied(base, plan.ops)).toBe(next);
    expect(plan.blocks).toBe(0);
    expect(plan.ops.length).toBeLessThanOrEqual(20);
    // Each edit is as small as the word it changed.
    for (const op of plan.ops) expect(op.deleteCount + op.insert.length).toBeLessThan(40);
  });

  it("two distant changes stay local when the natural line count is above maxPieces", () => {
    const lines = Array.from({ length: 110_000 }, (_, i) => `line ${i}\n`);
    const changed = [...lines];
    changed[500] = `changed A ${"x".repeat(1_200)}\n`;
    changed[109_000] = `changed B ${"y".repeat(1_200)}\n`;
    const base = lines.join("");
    const next = changed.join("");
    const plan = planReplace(base, next);
    expect(applied(base, plan.ops)).toBe(next);
    expect(plan.pieces).toBeLessThanOrEqual(REPLACE_LIMITS.maxPieces);
    expect(plan.blocks).toBe(0);
    expect(plan.ops.reduce((n, op) => n + op.deleteCount + op.insert.length, 0)).toBeLessThan(5_000);
    expect(plan.ops.every((op) => op.deleteCount < 2_000 && op.insert.length < 2_000)).toBe(true);
  });

  it("a line that moved does not cost the lines around it", () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => `Line ${i} ${prose(600, i + 1).replace(/\n/g, " ")}\n`);
    const base = lines.join("");
    const moved = [...lines];
    moved.splice(1_500, 0, ...moved.splice(100, 1));
    // Two lines rewritten too, so that the change is too large for one character diff.
    moved[400] = `Line 400 ${prose(600, 9_001).replace(/\n/g, " ")}\n`;
    moved[1_800] = `Line 1800 ${prose(600, 9_002).replace(/\n/g, " ")}\n`;
    const next = moved.join("");
    const plan = planReplace(base, next);
    expect(applied(base, plan.ops)).toBe(next);
    const touched = plan.ops.reduce((n, op) => n + op.deleteCount + op.insert.length, 0);
    // The moved line goes and comes (2 × about 610), two lines are rewritten (4 × about 610): nothing else.
    expect(touched).toBeLessThan(6 * 700);
  });

  it("inside one long line, words are the anchors", () => {
    const base = prose(60_000, 31).replace(/\n/g, " ");
    const next = edited(base, 12, 32);
    const plan = planReplace(base, next);
    expect(applied(base, plan.ops)).toBe(next);
    expect(plan.blocks).toBe(0);
    for (const op of plan.ops) expect(op.deleteCount + op.insert.length).toBeLessThan(60);
  });

  it("in Chinese text, clauses are the anchors", () => {
    const clauses = Array.from({ length: 3_000 }, (_, i) => prose(20, i + 1, CJK).replace(/\s/g, "") + "，");
    const base = clauses.join("");
    const changed = [...clauses];
    for (const k of [10, 700, 1_400, 2_900]) changed[k] = prose(20, k + 50_000, CJK).replace(/\s/g, "") + "，";
    const next = changed.join("");
    const plan = planReplace(base, next);
    expect(applied(base, plan.ops)).toBe(next);
    expect(plan.blocks).toBe(0);
    expect(plan.ops.reduce((n, op) => n + op.deleteCount + op.insert.length, 0)).toBeLessThan(4 * 2 * 22);
  });

  it("a word is cut with the white space after it: a run of spaces does not make pieces of its own", () => {
    // 1 line each (2 pieces), then 3 words each (6 pieces): 8 pieces looked at in all.
    const plan = planReplace("one   two   three", "uno   two   tres", { maxExactProduct: 1, exactBudget: 100, maxPieces: 100 });
    expect(plan.pieces).toBe(8);
    expect(applied("one   two   three", plan.ops)).toBe("uno   two   tres");
    // "two" and its spaces are the anchor: only the words around it are replaced.
    expect(plan.ops).toEqual([
      { index: 0, deleteCount: 3, insert: "uno" },
      // "three" and "tres" both start with t: that letter stays too.
      { index: 13, deleteCount: 4, insert: "res" },
    ]);
  });
  it("a passage too large for the character diff is replaced whole: one delete and one insert", () => {
    const head = "# Title\n\n";
    const tail = "\n\nThe end.\n";
    const before = prose(5_000, 41).replace(/\s/g, "x");
    const after = prose(5_000, 42).replace(/\s/g, "y");
    const plan = planReplace(head + before + tail, head + after + tail);
    expect(plan.ops).toEqual([{ index: head.length, deleteCount: 5_000, insert: after }]);
    expect(plan.blocks).toBe(1);
  });
});

describe("planReplace: the work is bounded at the largest text the route accepts (#2341)", () => {
  const A = prose(LARGEST, 11);
  const one = A.replace(/\n/g, " ");
  const hostile: [string, string, string][] = [
    ["2,000,000 characters replaced by 2,000,000 others", A, prose(LARGEST, 23)],
    ["2,000,000 Chinese characters replaced by 2,000,000 others", prose(LARGEST, 11, CJK), prose(LARGEST, 23, CJK)],
    ["one letter 2,000,000 times replaced by another", "a".repeat(LARGEST), "文".repeat(LARGEST)],
    ["50,000 words changed all over the text", A, edited(A, 50_000, 7)],
    ["one line of 2,000,000 characters replaced by another", one, prose(LARGEST, 23).replace(/\n/g, " ")],
    ["one line of 2,000,000 characters, 2,000 words changed", one, edited(one, 2_000, 9)],
    ["two letters taking turns, the other way round", "ab".repeat(LARGEST / 2), "ba".repeat(LARGEST / 2)],
    ["2,000,000 line feeds replaced by 1,000,000 short lines", "\n".repeat(LARGEST), "a\n".repeat(LARGEST / 2)],
    ["250,000 lines in the opposite order", Array.from({ length: 250_000 }, (_, i) => "x" + i).join("\n"), Array.from({ length: 250_000 }, (_, i) => "x" + (249_999 - i)).join("\n")],
    ["a small text replaced by the largest", "Start\n", A],
    ["the largest text replaced by a small one", A, "Start\n"],
    ["every second line changed", A, A.split("\n").map((line, i) => (i % 2 ? line + "!" : line)).join("\n")],
  ];
  it.each(hostile)("%s", (_name, oldText, newText) => {
    const { calls, exact } = counting();
    const plan = planReplace(oldText, newText, REPLACE_LIMITS, exact);
    // The character diff is the only step whose time is not linear. It is never asked for more than this:
    for (const call of calls) expect(call.product).toBeLessThanOrEqual(REPLACE_LIMITS.maxExactProduct);
    expect(calls.reduce((n, call) => n + call.product, 0)).toBeLessThanOrEqual(REPLACE_LIMITS.exactBudget);
    expect(plan.exactWork).toBe(calls.reduce((n, call) => n + call.product, 0));
    // Everything else is counted too: pieces hashed, characters looked at.
    expect(plan.pieces).toBeLessThanOrEqual(REPLACE_LIMITS.maxPieces);
    expect(plan.scanned).toBeLessThanOrEqual(5 * (oldText.length + newText.length) + 16);
    // And the stand-in's edits (a passage replaced whole) still make the new text.
    let text = oldText;
    const out: string[] = [];
    let read = 0;
    let shift = 0;
    for (const op of plan.ops) {
      const at = op.index - shift;
      out.push(text.slice(read, at), op.insert);
      read = at + op.deleteCount;
      shift += op.insert.length - op.deleteCount;
    }
    out.push(text.slice(read));
    text = out.join("");
    expect(text === newText).toBe(true);
  });

  it("with the real character diff, each of them is planned in well under a second", () => {
    for (const [name, oldText, newText] of hostile) {
      const started = performance.now();
      const plan = planReplace(oldText, newText);
      const ms = performance.now() - started;
      // Measured: 10 to 90 ms on a machine at 90 % load. Unbounded, the first one alone would take over a day.
      expect(ms, name).toBeLessThan(2_000);
      expect(plan.exactWork, name).toBeLessThanOrEqual(REPLACE_LIMITS.exactBudget);
    }
  });
});

describe("replaceText: the shared text reads the new text afterwards, whatever the plan did", () => {
  const shared = (text: string) => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, text);
    return { doc, ytext };
  };

  it("applies the planned edits and returns them", () => {
    const base = prose(20_000, 1);
    const next = edited(base, 30, 2);
    const { doc, ytext } = shared(base);
    let ops: TextOp[] = [];
    doc.transact(() => (ops = replaceText(ytext, next)));
    expect(ytext.toString()).toBe(next);
    expect(ops).toEqual(planReplace(base, next).ops);
    expect(ops.length).toBeGreaterThan(0);
  });

  it("the same text again: no edit, and the shared document is not touched", () => {
    const { doc, ytext } = shared("Nothing changes.\n");
    const before = Y.encodeStateAsUpdate(doc);
    let ops: TextOp[] = [{ index: 0, deleteCount: 0, insert: "x" }];
    doc.transact(() => (ops = replaceText(ytext, "Nothing changes.\n")));
    expect(ops).toEqual([]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each([
    ["edits that leave a wrong text", (): { ops: TextOp[] } => ({ ops: [{ index: 0, deleteCount: 3, insert: "WRONG" }] })],
    ["no edits although the text changed", (): { ops: TextOp[] } => ({ ops: [] })],
  ])("a plan with %s: the whole text is replaced instead, and the fault is logged", (_name, faulty) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { doc, ytext } = shared("The old text of the document.\n");
      let ops: TextOp[] = [];
      doc.transact(() => (ops = replaceText(ytext, "What the caller sent.\n", faulty)));
      expect(ytext.toString()).toBe("What the caller sent.\n");
      expect(ops).toHaveLength(1);
      expect(ops[0].insert).toBe("What the caller sent.\n");
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain("[replace] the planned edits did not make the new text");
      // Sizes only: no text of the document goes to the log.
      expect(String(error.mock.calls[0][0])).not.toContain("old text");
    } finally {
      error.mockRestore();
    }
  });

  it("to an empty text and from an empty text", () => {
    const a = shared("Some text.\n");
    a.doc.transact(() => replaceText(a.ytext, ""));
    expect(a.ytext.toString()).toBe("");
    const b = shared("");
    b.doc.transact(() => replaceText(b.ytext, "Some text.\n"));
    expect(b.ytext.toString()).toBe("Some text.\n");
  });
});