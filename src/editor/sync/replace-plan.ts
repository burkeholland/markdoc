import type * as Y from "yjs";
import { applyOps, diffOps, type TextOp } from "./text-diff";

/**
 * How a whole-document replace becomes edits (#2341).
 *
 * `diffOps` (fast-diff, Myers) finds the shortest character edit. Its time grows with the PRODUCT of the
 * two lengths that changed, in one unbroken run: 4,000 characters replaced by 4,000 others took 0.4 s on
 * the server, 16,000 took 8 s, and 2,000,000 (the largest text the content route accepts) would take longer
 * than a day, with every other request waiting. So the character diff only ever runs on a passage whose
 * product is at most `maxExactProduct`, and all such runs of one replace together on at most `exactBudget`.
 *
 * A replace that changes more than that is first cut into passages by ANCHORS: pieces of text that occur
 * exactly once in the old text and exactly once in the new one, in the same order. Lines first; then, inside
 * a passage between two anchor lines, words. An anchor is not touched, so a caret or a comment on it stays
 * where it is. A passage between two anchors gets the character diff when it is small enough, and is
 * otherwise replaced whole (one delete and one insert).
 *
 * Everything but the character diff is linear in the two texts: the scan for what both ends have in
 * common, cutting into at most `maxPieces` pieces, one hash lookup per piece, and the longest run of
 * anchors in order (n log n in the number of anchors). When there are more natural pieces than the
 * bound, adjacent lines or words are grouped before anchor discovery instead of abandoning anchors.
 *
 * The edits always turn the old text into the new one exactly; only how finely they are cut differs. A
 * replace whose changed part is small (product at most `maxExactProduct`) gets `diffOps` of the two whole
 * texts, the edits it got before this module existed.
 */
export interface ReplaceLimits {
  /** Largest old length × new length, in characters, of one passage the character diff runs on. */
  maxExactProduct: number;
  /** Sum of those products one replace may spend on character diffs. */
  exactBudget: number;
  /** Most pieces (lines and words, old and new counted together) one replace is cut into. */
  maxPieces: number;
}

/**
 * 1,000 × 1,000 characters took 23 to 61 ms on a machine at 40 to 100 % load, so one replace spends at
 * most about two such runs on character diffs. 200,000 pieces are hashed in well under 100 ms.
 */
export const REPLACE_LIMITS: ReplaceLimits = { maxExactProduct: 1_000_000, exactBudget: 2_000_000, maxPieces: 200_000 };

export interface ReplacePlan {
  /** In document order, to apply one after the other (`applyOps`). */
  ops: TextOp[];
  /** Sum of old × new of the passages handed to the character diff. Never above `exactBudget`, except for the one whole-text run of a small change (at most `maxExactProduct`). */
  exactWork: number;
  /** Pieces the texts were cut into to look for anchors. Never above `maxPieces`. */
  pieces: number;
  /** Characters looked at one by one (common ends, cutting). Linear in the two texts. */
  scanned: number;
  /** Passages replaced whole because they were too large for the character diff. */
  blocks: number;
}

/** The character diff of one passage: `diffOps`, or a stand-in that counts in tests. */
export type ExactDiff = (oldText: string, newText: string, from: number) => TextOp[];

interface Planning extends ReplacePlan {
  limits: ReplaceLimits;
  exact: ExactDiff;
  /** By how much the edits so far moved everything behind them. */
  shift: number;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Length of what `a[ai, aEnd)` and `b[bi, bEnd)` start with in common. Never ends between the two halves
 * of a surrogate pair: a shared text that splits a pair would leave half a character on each side.
 */
function commonStart(a: string, ai: number, aEnd: number, b: string, bi: number, bEnd: number): number {
  const max = Math.min(aEnd - ai, bEnd - bi);
  let n = 0;
  while (n < max && a.charCodeAt(ai + n) === b.charCodeAt(bi + n)) n++;
  if (n > 0 && isHighSurrogate(a.charCodeAt(ai + n - 1))) n--;
  return n;
}

/** Length of what the two ranges end with in common; like `commonStart`, never splits a surrogate pair. */
function commonEnd(a: string, ai: number, aEnd: number, b: string, bi: number, bEnd: number): number {
  const max = Math.min(aEnd - ai, bEnd - bi);
  let n = 0;
  while (n < max && a.charCodeAt(aEnd - 1 - n) === b.charCodeAt(bEnd - 1 - n)) n++;
  if (n > 0 && isLowSurrogate(a.charCodeAt(aEnd - n))) n--;
  return n;
}

/** White space, and the marks that end a clause in Chinese and Japanese (text without spaces between words). */
function endsWord(code: number): boolean {
  return code <= 0x20 || code === 0xa0 || code === 0x3000 || code === 0x3001 || code === 0x3002 || code === 0xff0c || code === 0xff01 || code === 0xff1f || code === 0xff1b;
}

/**
 * Number of natural pieces in `text[from, to)`: lines (tier 0, a piece ends after its line feed) or words
 * (tier 1, a piece is a word with the white space after it).
 */
function countPieces(text: string, from: number, to: number, tier: number): number {
  let count = 1;
  if (tier === 0) {
    for (let at = text.indexOf("\n", from); at !== -1 && at + 1 < to; at = text.indexOf("\n", at + 1)) count++;
  } else {
    let ended = false;
    for (let at = from; at < to; at++) {
      const ends = endsWord(text.charCodeAt(at));
      if (ended && !ends) count++;
      ended = ends;
    }
  }
  return count;
}

/**
 * Where grouped pieces begin, plus `to` at the end. `stride` adjacent natural pieces become one bounded
 * piece, preserving anchor discovery when the natural line or word count is above `maxPieces`.
 */
function pieceHash(text: string, from: number, to: number): number {
  let hash = 2166136261;
  for (let at = from; at < to; at++) hash = Math.imul(hash ^ text.charCodeAt(at), 16777619);
  return hash >>> 0;
}

function cut(text: string, from: number, to: number, tier: number, stride: number, most: number): number[] | null {
  const starts = [from];
  const least = Math.max(1, Math.floor(stride / 2));
  const greatest = Math.max(least, stride * 2);
  let naturalStart = from;
  let grouped = 0;
  const boundary = (at: number) => {
    const hash = pieceHash(text, naturalStart, at);
    naturalStart = at;
    grouped++;
    if (grouped < least || (grouped < greatest && hash % stride !== 0)) return true;
    if (starts.length >= most) return false;
    starts.push(at);
    grouped = 0;
    return true;
  };
  if (tier === 0) {
    for (let at = text.indexOf("\n", from); at !== -1 && at + 1 < to; at = text.indexOf("\n", at + 1)) {
      if (!boundary(at + 1)) return null;
    }
  } else {
    let ended = false;
    for (let at = from; at < to; at++) {
      const ends = endsWord(text.charCodeAt(at));
      if (ended && !ends && !boundary(at)) return null;
      ended = ends;
    }
  }
  starts.push(to);
  return starts;
}

/**
 * The anchors of two cut texts: pairs `[old piece, new piece]` of pieces that are equal, occur once on
 * each side, and are in the same order on both. Of the pieces that qualify, the longest run in order is
 * kept (patience sorting), so one moved line does not cost the anchors around it.
 */
function findAnchors(oldText: string, oldCuts: number[], newText: string, newCuts: number[]): [number, number][] {
  // piece -> its index on the old side, or -1 when it occurs there more than once
  const inOld = new Map<string, number>();
  for (let i = 0; i + 1 < oldCuts.length; i++) {
    const piece = oldText.slice(oldCuts[i], oldCuts[i + 1]);
    inOld.set(piece, inOld.has(piece) ? -1 : i);
  }
  const inNew = new Map<string, number>();
  for (let j = 0; j + 1 < newCuts.length; j++) {
    const piece = newText.slice(newCuts[j], newCuts[j + 1]);
    if ((inOld.get(piece) ?? -1) < 0) continue;
    inNew.set(piece, inNew.has(piece) ? -1 : j);
  }
  const pairs: [number, number][] = [];
  for (const [piece, j] of inNew) if (j >= 0) pairs.push([inOld.get(piece)!, j]);
  pairs.sort((x, y) => x[0] - y[0]);
  // Longest run that also rises on the new side. `tails[n]` is the pair that ends the best run of length n + 1.
  const tails: number[] = [];
  const before = new Int32Array(pairs.length);
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < pairs[k][1]) lo = mid + 1;
      else hi = mid;
    }
    before[k] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = k;
  }
  const run: [number, number][] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k !== -1; k = before[k]) run.push(pairs[k]);
  return run.reverse();
}

function emit(plan: Planning, ops: TextOp[]) {
  for (const op of ops) {
    plan.ops.push(op);
    plan.shift += op.insert.length - op.deleteCount;
  }
}

/** Plan `oldText[a, b)` → `newText[c, d)`; the edits before it are already in `plan`. */
function passage(plan: Planning, oldText: string, a: number, b: number, newText: string, c: number, d: number, tier: number) {
  const start = commonStart(oldText, a, b, newText, c, d);
  a += start;
  c += start;
  const end = commonEnd(oldText, a, b, newText, c, d);
  b -= end;
  d -= end;
  plan.scanned += start + end + 2;
  const removed = b - a;
  const added = d - c;
  if (removed === 0 && added === 0) return;
  const at = a + plan.shift;
  if (removed === 0 || added === 0) {
    emit(plan, [{ index: at, deleteCount: removed, insert: newText.slice(c, d) }]);
    return;
  }
  const product = removed * added;
  if (product <= plan.limits.maxExactProduct && plan.exactWork + product <= plan.limits.exactBudget) {
    plan.exactWork += product;
    emit(plan, plan.exact(oldText.slice(a, b), newText.slice(c, d), at));
    return;
  }
  for (let t = tier; t <= 1; t++) {
    const left = plan.limits.maxPieces - plan.pieces;
    if (left < 2) break;
    const oldNatural = countPieces(oldText, a, b, t);
    const newNatural = countPieces(newText, c, d, t);
    plan.scanned += removed + added;
    let stride = Math.max(1, Math.ceil((oldNatural + newNatural) / left));
    let oldCuts: number[] | null = null;
    let newCuts: number[] | null = null;
    for (;;) {
      oldCuts = cut(oldText, a, b, t, stride, left);
      newCuts = oldCuts && cut(newText, c, d, t, stride, left - (oldCuts.length - 1));
      if (oldCuts && newCuts) break;
      if (stride >= Math.max(oldNatural, newNatural)) break;
      stride = Math.min(Math.max(oldNatural, newNatural), stride * 2);
    }
    plan.scanned += removed + added;
    if (!oldCuts || !newCuts) break;
    plan.pieces += oldCuts.length - 1 + newCuts.length - 1;
    const anchors = findAnchors(oldText, oldCuts, newText, newCuts);
    if (anchors.length === 0) continue;
    let i = 0;
    let j = 0;
    for (const [oi, nj] of anchors) {
      passage(plan, oldText, oldCuts[i], oldCuts[oi], newText, newCuts[j], newCuts[nj], t + 1);
      i = oi + 1;
      j = nj + 1;
    }
    passage(plan, oldText, oldCuts[i], b, newText, newCuts[j], d, t + 1);
    return;
  }
  plan.blocks++;
  emit(plan, [{ index: at, deleteCount: removed, insert: newText.slice(c, d) }]);
}

/**
 * The edits that turn `oldText` into `newText`, found in time that is bounded by `limits` whatever the two
 * texts are. See the top of this file for how.
 */
export function planReplace(oldText: string, newText: string, limits: ReplaceLimits = REPLACE_LIMITS, exact: ExactDiff = diffOps): ReplacePlan {
  const plan: Planning = { ops: [], exactWork: 0, pieces: 0, scanned: 0, blocks: 0, limits, exact, shift: 0 };
  if (oldText !== newText) {
    const start = commonStart(oldText, 0, oldText.length, newText, 0, newText.length);
    const end = commonEnd(oldText, start, oldText.length, newText, start, newText.length);
    plan.scanned += start + end + 2;
    const product = (oldText.length - start - end) * (newText.length - start - end);
    if (product <= limits.maxExactProduct) {
      // A small change: the edits of the two whole texts, exactly as before this module existed.
      plan.exactWork = product;
      plan.ops = exact(oldText, newText, 0);
    } else {
      passage(plan, oldText, start, oldText.length - end, newText, start, newText.length - end, 0);
    }
  }
  return { ops: plan.ops, exactWork: plan.exactWork, pieces: plan.pieces, scanned: plan.scanned, blocks: plan.blocks };
}

/**
 * Make the shared text read `newText`, with the edits `planReplace` finds. Must be called inside a
 * transaction. Returns the edits that were applied, in document order.
 *
 * The text is compared with `newText` afterwards. Should the edits ever not add up (a fault in the plan),
 * the whole text is replaced instead and the fault is logged: what is stored is `newText` in every case.
 */
export function replaceText(ytext: Y.Text, newText: string, plan: (oldText: string, newText: string) => { ops: TextOp[] } = planReplace): TextOp[] {
  const oldText = ytext.toString();
  const { ops } = plan(oldText, newText);
  if (ops.length === 0 && oldText === newText) return ops;
  applyOps(ytext, ops);
  if (ytext.toString() === newText) return ops;
  console.error(`[replace] the planned edits did not make the new text (${ops.length} edits, ${oldText.length} to ${newText.length} characters); the whole text was replaced instead`);
  const now = ytext.length;
  if (now > 0) ytext.delete(0, now);
  if (newText) ytext.insert(0, newText);
  return [{ index: 0, deleteCount: now, insert: newText }];
}
