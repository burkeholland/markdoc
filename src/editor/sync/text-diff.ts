import diff from "fast-diff";
import { diffWordsWithSpace } from "diff";
import type * as Y from "yjs";

export interface TextOp {
  /** Absolute index in the text where the op applies. */
  index: number;
  /** Number of characters removed at `index` (applied before the insert). */
  deleteCount: number;
  insert: string;
}

/**
 * Compute a minimal list of edit operations turning `oldText` into `newText`
 * for the range [from, to) of a larger document. Operations are returned in
 * document order and are meant to be applied sequentially (each op's index is
 * already adjusted for previous ops).
 */
export function diffOps(oldText: string, newText: string, from = 0, cursor?: number): TextOp[] {
  if (oldText === newText) return [];
  const parts = diff(oldText, newText, cursor);
  const ops: TextOp[] = [];
  let pos = from;
  let pendingDelete: TextOp | null = null;
  for (const [kind, text] of parts) {
    if (kind === diff.EQUAL) {
      if (pendingDelete) {
        ops.push(pendingDelete);
        pendingDelete = null;
      }
      pos += text.length;
    } else if (kind === diff.DELETE) {
      if (pendingDelete) {
        ops.push(pendingDelete);
        pendingDelete = null;
      }
      pendingDelete = { index: pos, deleteCount: text.length, insert: "" };
    } else {
      if (pendingDelete) {
        // A delete directly followed by an insert becomes a single replace op.
        pendingDelete.insert = text;
        ops.push(pendingDelete);
        pendingDelete = null;
      } else {
        ops.push({ index: pos, deleteCount: 0, insert: text });
      }
      pos += text.length;
    }
  }
  if (pendingDelete) ops.push(pendingDelete);
  return ops;
}

/** Apply ops produced by {@link diffOps} to a Y.Text. Must be called inside a transaction. */
export function applyOps(ytext: Y.Text, ops: TextOp[]) {
  for (const op of ops) {
    if (op.deleteCount > 0) ytext.delete(op.index, op.deleteCount);
    if (op.insert) ytext.insert(op.index, op.insert);
  }
}

/**
 * Word-level edit operations, for changes people review (suggestions). Whole words are
 * replaced instead of the shortest character edit, so "Second" → "Improved" reads as one
 * deletion and one insertion rather than a sprinkle of letters.
 */
export function diffOpsWords(oldText: string, newText: string, from = 0): TextOp[] {
  if (oldText === newText) return [];
  const parts = diffWordsWithSpace(oldText, newText);
  const ops: TextOp[] = [];
  let pos = from;
  let pending: TextOp | null = null;
  const flush = () => {
    if (pending) {
      ops.push(pending);
      pending = null;
    }
  };
  for (const part of parts) {
    if (part.added) {
      if (pending && pending.insert === "") pending.insert = part.value;
      else if (pending) pending.insert += part.value;
      else pending = { index: pos, deleteCount: 0, insert: part.value };
      pos += part.value.length;
    } else if (part.removed) {
      if (pending && pending.insert === "") pending.deleteCount += part.value.length;
      else if (pending) {
        // insertion already collected before this deletion: keep the replace shape by
        // extending the deletion (text order: deleted text follows the insertion point)
        pending.deleteCount += part.value.length;
      } else pending = { index: pos, deleteCount: part.value.length, insert: "" };
    } else {
      flush();
      pos += part.value.length;
    }
  }
  flush();
  return ops;
}

