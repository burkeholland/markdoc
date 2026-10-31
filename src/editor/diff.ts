import { diffWords, type Change } from "diff";

export interface DiffStats {
  added: number;
  removed: number;
}

/** Word-level diff for rendering (old → new). */
export function wordDiff(oldText: string, newText: string): Change[] {
  return diffWords(oldText, newText);
}

export function diffStats(changes: Change[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    if (c.added) added += c.count ?? c.value.length;
    else if (c.removed) removed += c.count ?? c.value.length;
  }
  return { added, removed };
}

export type Collapsed = { collapsed: number };

/**
 * Shorten one unchanged segment: keep `context` words on each side that touches a change
 * (none on the edge of the document) and replace the middle with a `{ collapsed }` marker.
 */
export function collapseSegment<T extends Change>(c: T, isFirst: boolean, isLast: boolean, context = 40): (T | Collapsed)[] {
  const words = c.value.split(/(\s+)/);
  if (words.length <= context * 2 + 1) return [c];
  const head = isFirst ? "" : words.slice(0, context).join("");
  const tail = isLast ? "" : words.slice(-context).join("");
  const hidden = words.length - (isFirst ? 0 : context) - (isLast ? 0 : context);
  const out: (T | Collapsed)[] = [];
  if (head) out.push({ ...c, value: head, count: context });
  out.push({ collapsed: Math.max(1, Math.round(hidden / 2)) });
  if (tail) out.push({ ...c, value: tail, count: context });
  return out;
}

/** Collapse long unchanged stretches in a word diff to keep the view focused on changes. */
export function collapseUnchanged<T extends Change>(changes: T[], context = 40): (T | Collapsed)[] {
  const out: (T | Collapsed)[] = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (isChanged(c)) {
      out.push(c);
      continue;
    }
    out.push(...collapseSegment(c, i === 0, i === changes.length - 1, context));
  }
  return out;
}

/** A diff segment; `moved` marks a block that left one place and reappeared verbatim in another. */
export type DiffSegment = Change & { moved?: boolean };

export function isChanged(c: DiffSegment): boolean {
  return Boolean(c.added || c.removed || c.moved);
}

export interface Hunk {
  /** Index into the segment array of the first changed segment. */
  start: number;
  /** Index of the last changed segment (inclusive); unchanged gaps in between belong to the hunk. */
  end: number;
  kind: "insert" | "delete" | "replace" | "moved";
}

/** Maximum number of unchanged line breaks between two changes that still count as one hunk. */
export const HUNK_GAP_LINES = 2;

const countLines = (s: string) => (s.match(/\n/g) ?? []).length;

/**
 * Group consecutive changed segments into hunks. Two changes separated only by unchanged text with
 * at most `HUNK_GAP_LINES` line breaks are one hunk; a longer unchanged stretch starts a new one.
 */
export function hunks(changes: DiffSegment[]): Hunk[] {
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  let gap = 0;
  const kindOf = (c: DiffSegment): Hunk["kind"] => (c.moved ? "moved" : c.added ? "insert" : "delete");
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (!isChanged(c)) {
      gap += countLines(c.value);
      continue;
    }
    const k = kindOf(c);
    if (cur && gap <= HUNK_GAP_LINES) {
      cur.end = i;
      if (cur.kind !== k) cur.kind = cur.kind === "moved" || k === "moved" ? "moved" : "replace";
    } else {
      cur = { start: i, end: i, kind: k };
      out.push(cur);
    }
    gap = 0;
  }
  return out;
}

/** Smallest block (after trimming) that can be recognised as a moved paragraph. */
export const MOVE_MIN_CHARS = 40;

/**
 * Moved-paragraph detection: a removed block of at least `MOVE_MIN_CHARS` that reappears verbatim
 * (exact match after trim) as an added block elsewhere is emitted once, at its new position, with
 * `moved: true`; the removal is dropped. Everything else passes through unchanged.
 */
export function detectMoves(changes: Change[], minChars = MOVE_MIN_CHARS): DiffSegment[] {
  const removedByText = new Map<string, number[]>();
  changes.forEach((c, i) => {
    if (!c.removed) return;
    const key = c.value.trim();
    if (key.length < minChars) return;
    const list = removedByText.get(key);
    if (list) list.push(i);
    else removedByText.set(key, [i]);
  });
  if (removedByText.size === 0) return changes;
  const dropped = new Set<number>();
  const movedTo = new Set<number>();
  changes.forEach((c, i) => {
    if (!c.added) return;
    const key = c.value.trim();
    const sources = removedByText.get(key);
    const src = sources?.find((s) => !dropped.has(s));
    if (src === undefined) return;
    dropped.add(src);
    movedTo.add(i);
  });
  if (dropped.size === 0) return changes;
  const out: DiffSegment[] = [];
  changes.forEach((c, i) => {
    if (dropped.has(i)) return;
    if (movedTo.has(i)) out.push({ ...c, added: false, removed: false, moved: true });
    else out.push(c);
  });
  return out;
}

/** "3 of 14 changes" for the hunk navigator (`active` is 0-based). */
export function hunkCounter(active: number, total: number): string {
  if (total === 0) return "No changes";
  return `${Math.min(active, total - 1) + 1} of ${total} ${total === 1 ? "change" : "changes"}`;
}
