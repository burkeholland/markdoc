import { diffArrays, diffWordsWithSpace, type Change } from "diff";
import type { EditInput } from "../collab/suggestions";

const MAX_WORD_DIFF_LENGTH = 32_000;

export class SuggestionPlanError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 422) {
    super(message);
    this.name = "SuggestionPlanError";
  }
}

/** Unlike TextOp, these ranges all refer to the original text, not intermediate edits. */
function editsFromParts(parts: Change[], from: number): EditInput[] {
  const edits: EditInput[] = [];
  let pos = from;
  let pending: EditInput | undefined;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      if (pending) edits.push(pending);
      pending = undefined;
      pos += part.value.length;
      continue;
    }
    pending ??= { from: pos, to: pos, insert: "" };
    if (part.removed) {
      pos += part.value.length;
      pending.to = pos;
    } else {
      pending.insert += part.value;
    }
  }
  if (pending) edits.push(pending);
  return edits;
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function narrowPassage(oldText: string, newText: string, from: number): EditInput {
  let start = 0;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (start < oldEnd && start < newEnd && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;
  if (splitsSurrogatePair(oldText, start) || splitsSurrogatePair(newText, start)) start--;
  while (oldEnd > start && newEnd > start && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  if (splitsSurrogatePair(oldText, oldEnd) || splitsSurrogatePair(newText, newEnd)) {
    oldEnd++;
    newEnd++;
  }
  return { from: from + start, to: from + oldEnd, insert: newText.slice(start, newEnd) };
}

function passageEdits(oldText: string, newText: string, from: number, targeted: boolean): EditInput[] {
  if (oldText === newText) return [];
  // Headings, fences and surrounding lines may share a blank-line-delimited block
  // with the passage. Do not include equal leading/trailing lines in its review.
  while (true) {
    const end = oldText.indexOf("\n") + 1;
    if (!end || oldText.slice(0, end) !== newText.slice(0, end)) break;
    oldText = oldText.slice(end);
    newText = newText.slice(end);
    from += end;
  }
  while (oldText.includes("\n") && newText.includes("\n")) {
    const oldStart = oldText.lastIndexOf("\n", oldText.length - 2) + 1;
    const newStart = newText.lastIndexOf("\n", newText.length - 2) + 1;
    if (!oldStart || !newStart || oldText.slice(oldStart) !== newText.slice(newStart)) break;
    oldText = oldText.slice(0, oldStart);
    newText = newText.slice(0, newStart);
  }
  // Keep shared line endings outside a replacement, including CRLF. This also keeps
  // the next block from inheriting a paragraph's tracked-change decoration.
  const oldEnding = oldText.match(/[\r\n]+$/)?.[0] ?? "";
  const newEnding = newText.match(/[\r\n]+$/)?.[0] ?? "";
  if (oldEnding && oldEnding === newEnding && !oldText.slice(0, -oldEnding.length).includes("\n") && !newText.slice(0, -newEnding.length).includes("\n")) {
    oldText = oldText.slice(0, -oldEnding.length);
    newText = newText.slice(0, -newEnding.length);
  }
  // Trim identical edges in linear time before the size fallback, so a small edit
  // in a long line does not become a whole-document replacement.
  if (oldText.length + newText.length > MAX_WORD_DIFF_LENGTH) {
    const middle = narrowPassage(oldText, newText, from);
    oldText = oldText.slice(middle.from - from, middle.to - from);
    newText = middle.insert;
    from = middle.from;
  }
  const whole = [{ from, to: from + oldText.length, insert: newText }];
  if (!oldText || !newText) return whole;
  // Word matching is useful for typos, but incidental shared words must not turn a
  // substantive rewrite into dozens of alternating insert/delete islands.
  const parts = oldText.length + newText.length <= MAX_WORD_DIFF_LENGTH
    ? diffWordsWithSpace(oldText, newText, { maxEditLength: 512 })
    : undefined;
  if (!parts) throw new SuggestionPlanError("Passage is too large to group safely; submit smaller targeted edits", 422);
  const edits = editsFromParts(parts, from);
  const changed = edits.reduce((size, edit) => size + edit.to - edit.from + edit.insert.length, 0);
  const replacement = edits.some((edit) => edit.to > edit.from) && edits.some((edit) => edit.insert);
  if (replacement && edits.length >= 3 && changed >= (oldText.length + newText.length) / 3) return whole;
  if (targeted && edits.length > 1) {
    const first = edits[0].from;
    const last = edits[edits.length - 1].to;
    const shift = edits.reduce((delta, edit) => delta + edit.insert.length - (edit.to - edit.from), 0);
    return [{ from: first, to: last, insert: newText.slice(first - from, last - from + shift) }];
  }
  return edits;
}

/**
 * Agent-only review granularity. Unchanged blocks are hard boundaries; inside a
 * changed passage retain small edits, but display substantial rewrites as a pair.
 * Ordinary CRDT editing and history diffs deliberately do not use this function.
 */
export function diffSuggestionEdits(oldText: string, newText: string, from = 0, options: { targeted?: boolean } = {}): EditInput[] {
  if (oldText === newText) return [];
  const blocks = (text: string) => text.split(/((?:\r?\n[ \t]*){2,})/).filter(Boolean);
  const parts = diffArrays(blocks(oldText), blocks(newText), { maxEditLength: 2_000 });
  if (!parts) throw new SuggestionPlanError("Revision is too large to group safely; submit smaller targeted edits", 422);
  return editsFromParts(parts.map((part) => ({ ...part, value: part.value.join("") })), from).flatMap((edit) =>
    passageEdits(oldText.slice(edit.from - from, edit.to - from), edit.insert, edit.from, options.targeted ?? false),
  );
}

export interface TargetedSuggestionEdit {
  find: string;
  replace: string;
  all?: boolean;
}

/** Validate the entire batch before writing, retaining each find/replace boundary. */
export function targetedSuggestionEdits(current: string, edits: TargetedSuggestionEdit[]): EditInput[] {
  let proposed = current;
  const targets: EditInput[] = [];
  for (const edit of edits) {
    if (!edit.find) throw new SuggestionPlanError("Find text must not be empty", 400);
    const matches: number[] = [];
    for (let pos = proposed.indexOf(edit.find); pos !== -1; pos = proposed.indexOf(edit.find, pos + edit.find.length)) {
      matches.push(pos);
    }
    if (!matches.length) throw new SuggestionPlanError(`Text not found: ${JSON.stringify(edit.find.slice(0, 80))}`, 400);
    if (matches.length > 1 && !edit.all) {
      throw new SuggestionPlanError(`Text occurs ${matches.length} times; add "all": true or make it unique: ${JSON.stringify(edit.find.slice(0, 80))}`, 400);
    }
    if (edit.find === edit.replace) continue;
    for (const pos of matches.reverse()) {
      const end = pos + edit.find.length;
      let shift = 0;
      for (const target of targets) {
        const start = target.from + shift;
        const stop = start + target.insert.length;
        if ((pos < stop && end > start) || (start === stop && pos < start && end > start)) {
          throw new SuggestionPlanError("Overlapping replacements must be submitted as one edit", 409);
        }
        if (stop <= pos) shift += target.insert.length - (target.to - target.from);
        else break;
      }
      targets.push({ from: pos - shift, to: end - shift, insert: edit.replace });
      targets.sort((a, b) => a.from - b.from);
      proposed = proposed.slice(0, pos) + edit.replace + proposed.slice(end);
    }
  }
  return targets.flatMap((target) =>
    diffSuggestionEdits(current.slice(target.from, target.to), target.insert, target.from, { targeted: true }),
  );
}
