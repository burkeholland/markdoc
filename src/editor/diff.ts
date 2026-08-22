import { diffWords, diffLines, type Change } from "diff";

export interface DiffStats {
  added: number;
  removed: number;
}

/** Word-level diff for rendering (old → new). */
export function wordDiff(oldText: string, newText: string): Change[] {
  return diffWords(oldText, newText);
}

export function lineDiff(oldText: string, newText: string): Change[] {
  return diffLines(oldText, newText);
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

/** Collapse long unchanged stretches in a word diff to keep the view focused on changes. */
export function collapseUnchanged(changes: Change[], context = 40): (Change | { collapsed: number })[] {
  const out: (Change | { collapsed: number })[] = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (c.added || c.removed) {
      out.push(c);
      continue;
    }
    const words = c.value.split(/(\s+)/);
    if (words.length <= context * 2 + 1) {
      out.push(c);
      continue;
    }
    const isFirst = i === 0;
    const isLast = i === changes.length - 1;
    const head = isFirst ? "" : words.slice(0, context).join("");
    const tail = isLast ? "" : words.slice(-context).join("");
    const hidden = words.length - (isFirst ? 0 : context) - (isLast ? 0 : context);
    if (head) out.push({ value: head, count: context, added: false, removed: false });
    out.push({ collapsed: Math.max(1, Math.round(hidden / 2)) });
    if (tail) out.push({ value: tail, count: context, added: false, removed: false });
  }
  return out;
}

