import type * as Y from "yjs";
import { diffOps, type TextOp } from "../sync/text-diff";
import { createAnchor, resolveAnchor, type TextAnchor } from "./shared";

export const SUGGESTION_ANCHORS_META = Symbol("suggestionCommentAnchors");

export interface CommentAnchorChange {
  threadId: string;
  before: TextAnchor;
  after: TextAnchor;
}

interface Passage {
  from: number;
  to: number;
  text: string;
}

function mapOffset(offset: number, ops: TextOp[], end: boolean): number {
  for (const op of ops) {
    if (offset < op.index) break;
    if (offset >= op.index + op.deleteCount) offset += op.insert.length - op.deleteCount;
    else offset = op.index + (end ? op.insert.length : 0);
  }
  return offset;
}

/**
 * A paired replacement removes one copy of a passage. Move only affected comment
 * endpoints to the surviving copy, leaving quotes, replies and decisions alone.
 * The session carries these exact anchor changes through the existing undo stack.
 */
export function retargetReplacementComments(
  ydoc: Y.Doc,
  ytext: Y.Text,
  pairs: { removed: Passage; kept: Passage }[],
): CommentAnchorChange[] {
  if (!pairs.length) return [];
  const comments = ydoc.getMap<Y.Map<unknown>>("comments");
  const changes = new Map<string, CommentAnchorChange>();
  for (const { removed, kept } of pairs) {
    let ops: TextOp[] | undefined;
    comments.forEach((thread, threadId) => {
      const before = thread.get("anchor") as TextAnchor | undefined;
      if (!before) return;
      const range = resolveAnchor(ytext, before);
      if (!range || range.from >= removed.to || range.to <= removed.from) return;
      const contained = range.from >= removed.from && range.to <= removed.to;
      const quote = contained ? removed.text.slice(range.from - removed.from, range.to - removed.from) : "";
      const match = quote ? kept.text.indexOf(quote) : -1;
      // A rewrite may reorder sentences: an unambiguous retained quote is a better
      // anchor than whichever incidental common words the character diff aligns.
      if (match !== -1 && kept.text.lastIndexOf(quote) === match && removed.text.indexOf(quote) === removed.text.lastIndexOf(quote)) {
        const after = createAnchor(ytext, kept.from + match, kept.from + match + quote.length);
        changes.set(threadId, { threadId, before: changes.get(threadId)?.before ?? before, after });
        thread.set("anchor", after);
        return;
      }
      const bounded = removed.text.length + kept.text.length <= 32_000;
      if (bounded) ops ??= diffOps(removed.text, kept.text);
      const endpoint = (pos: number, end: boolean) => {
        if (pos < removed.from || pos > removed.to) return pos;
        if (!bounded) return end ? kept.to : kept.from;
        return kept.from + mapOffset(pos - removed.from, ops!, end);
      };
      let from = endpoint(range.from, false);
      let to = endpoint(range.to, true);
      if (from === to && contained) {
        from = kept.from;
        to = kept.to;
      }
      const after = createAnchor(ytext, Math.min(from, to), Math.max(from, to));
      changes.set(threadId, { threadId, before: changes.get(threadId)?.before ?? before, after });
      thread.set("anchor", after);
    });
  }
  return [...changes.values()];
}

export function restoreReplacementComments(ydoc: Y.Doc, changes: CommentAnchorChange[], undo: boolean): CommentAnchorChange[] {
  const comments = ydoc.getMap<Y.Map<unknown>>("comments");
  const restored: CommentAnchorChange[] = [];
  for (const change of changes) {
    const thread = comments.get(change.threadId);
    const expected = undo ? change.after : change.before;
    // A collaborator's subsequent re-anchoring is not part of this undo step.
    if (!thread || JSON.stringify(thread.get("anchor")) !== JSON.stringify(expected)) continue;
    thread.set("anchor", undo ? change.before : change.after);
    restored.push(change);
  }
  return restored;
}
