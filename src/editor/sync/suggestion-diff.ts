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

interface Span {
  from: number;
  to: number;
}

interface TableSpan extends Span {
  /** The delimiter row (`| --- | --- |`): the header is the line above it, the body rows follow it. */
  delimiter: Span;
}

/** The lines a replacement is widened to; `blocks` when its two versions must be separate blocks, not only separate lines. */
interface Widened extends Span {
  blocks: boolean;
}

const TABLE_DELIMITER = /^(?:>[ \t]*)*\|?[ \t]*:?-+:?(?:[ \t]*\|[ \t]*:?-+:?)*[ \t]*\|?$/;
/** A line break or an unescaped pipe: what separates the rows and the cells of a table. */
const TABLE_STRUCTURE = /\n|(?:^|[^\\])\|/;

/** The lines of `text`, without their line breaks. */
function lineSpans(text: string): Span[] {
  const lines: Span[] = [];
  for (let from = 0; ; ) {
    const end = text.indexOf("\n", from);
    const to = end === -1 ? text.length : end;
    lines.push({ from, to: to > from && text[to - 1] === "\r" ? to - 1 : to });
    if (end === -1) return lines;
    from = end + 1;
  }
}

/**
 * The GFM tables in `text`: a line with a pipe, the delimiter row under it and every line down to the
 * next blank one. Lines only, no parse: a table quoted in a code block is found too, and all that does
 * is keep its lines whole as well.
 */
function tableSpans(text: string, lines: Span[]): TableSpan[] {
  const tables: TableSpan[] = [];
  const line = (index: number) => text.slice(lines[index].from, lines[index].to);
  for (let index = 1; index < lines.length; index++) {
    const delimiter = line(index);
    if (!delimiter.includes("|") || !TABLE_DELIMITER.test(delimiter.trim()) || !line(index - 1).includes("|")) continue;
    let last = index;
    while (last + 1 < lines.length && /\S/.test(line(last + 1))) last++;
    tables.push({ from: lines[index - 1].from, to: lines[last].to, delimiter: lines[index] });
    index = last;
  }
  return tables;
}

const hasTable = (text: string) => text.includes("|") && tableSpans(text, lineSpans(text)).length > 0;

/** Start of the blank lines that end right before the line at `offset`; `offset` when there are none. */
function blankLinesBefore(text: string, offset: number, floor: number): number {
  let start = offset;
  while (start > floor && /[ \t\r\n]/.test(text[start - 1])) start--;
  const run = text.slice(start, offset);
  const first = run.search(/\r?\n/);
  return first !== -1 && run.indexOf("\n", run.indexOf("\n", first) + 1) !== -1 ? start + first : offset;
}

/** End of the blank lines that start at the line end `offset`; `offset` when there are none. */
function blankLinesAfter(text: string, offset: number, ceiling: number): number {
  let end = offset;
  while (end < ceiling && /[ \t\r\n]/.test(text[end])) end++;
  const run = text.slice(offset, end);
  const last = run.lastIndexOf("\n");
  return last > run.indexOf("\n") ? offset + last + 1 : offset;
}

/**
 * The range to replace so that the two versions of `span` do not share a line: its lines and the line
 * break after them (before them when the text ends there), or the blank lines when they must be blocks.
 * The break is in the replaced text and in the new text alike, so accepting or rejecting gives exactly
 * the text asked for. After is preferred: the review card shows both versions as written, and one that
 * starts with a line break starts with an empty line. Stays between `floor` and `ceiling`, where the
 * neighbouring edits are.
 */
function apart(text: string, span: Widened, floor: number, ceiling: number): Span {
  if (span.blocks) {
    const after = blankLinesAfter(text, span.to, ceiling);
    if (after > span.to) return { from: span.from, to: after };
    const before = blankLinesBefore(text, span.from, floor);
    if (before < span.from) return { from: before, to: span.to };
  }
  const after = text.startsWith("\r\n", span.to) ? 2 : text[span.to] === "\n" ? 1 : 0;
  if (after && span.to + after <= ceiling) return { from: span.from, to: span.to + after };
  if (span.from > floor && text[span.from - 1] === "\n") {
    return { from: span.from - (span.from - 2 >= floor && text[span.from - 2] === "\r" ? 2 : 1), to: span.to };
  }
  return span;
}

/**
 * A replacement stays in the text as the new words followed by the old ones until someone decides it.
 * Across the cells or rows of a table that glues a new row to the old row on one line: a row with twice
 * the cells, which the rich pane cannot draw as the table it is. Such a replacement is widened here to
 * whole lines, so the new rows stand above the old rows in the same table. One that changes the header
 * or the delimiter row, or that puts a table where there was none (or the reverse), is widened to whole
 * blocks: the new version, a blank line, the old version. Edits inside one cell are left as they are.
 */
function keepTablesWhole(text: string, edits: EditInput[]): EditInput[] {
  const replaces = (edit: EditInput) => edit.to > edit.from && edit.insert !== "";
  if (!edits.some(replaces) || (!text.includes("|") && !edits.some((edit) => edit.insert.includes("|")))) return edits;
  const lines = lineSpans(text);
  const tables = tableSpans(text, lines);
  const lineAt = (offset: number) => {
    let low = 0;
    let high = lines.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lines[middle].from <= offset) low = middle;
      else high = middle - 1;
    }
    return lines[low];
  };
  const rewritten = (span: Span, members: EditInput[]) => {
    let out = "";
    let at = span.from;
    for (const edit of members) {
      out += text.slice(at, edit.from) + edit.insert;
      at = edit.to;
    }
    return out + text.slice(at, span.to);
  };
  const widen = (edit: EditInput): Widened | null => {
    if (!replaces(edit)) return null;
    const rows = { from: lineAt(edit.from).from, to: lineAt(edit.to).to };
    const table = tables.find((candidate) => candidate.from <= edit.from && edit.to <= candidate.to);
    if (!table) {
      const tabular = hasTable(edit.insert) || tables.some((candidate) => candidate.from < edit.to && edit.from < candidate.to);
      return tabular ? { ...rows, blocks: true } : null;
    }
    const inDelimiter = edit.from <= table.delimiter.to && edit.to >= table.delimiter.from;
    if (!inDelimiter && !TABLE_STRUCTURE.test(text.slice(edit.from, edit.to)) && !TABLE_STRUCTURE.test(edit.insert)) return null;
    // Body rows stay rows of the same table. A new header needs its own delimiter row under it, so that is the whole table.
    return rows.from > table.delimiter.to ? { ...rows, blocks: false } : { from: table.from, to: table.to, blocks: true };
  };

  type Group = { members: EditInput[]; span: Widened | null };
  const groups: Group[] = [...edits].sort((a, b) => a.from - b.from).map((edit) => ({ members: [edit], span: widen(edit) }));
  if (!groups.some((group) => group.span)) return edits;
  const start = (group: Group) => group.span?.from ?? group.members[0].from;
  const end = (group: Group) => group.span?.to ?? group.members[group.members.length - 1].to;
  // Another edit on the widened lines is part of the same replacement, and can widen it again.
  for (let index = 0; index + 1 < groups.length; ) {
    const left = groups[index];
    const right = groups[index + 1];
    if ((!left.span && !right.span) || end(left) < start(right)) {
      index++;
      continue;
    }
    const members = [...left.members, ...right.members];
    const span = { from: Math.min(start(left), start(right)), to: Math.max(end(left), end(right)) };
    const merged = { ...span, insert: rewritten(span, members) };
    const widened = widen(merged);
    groups.splice(index, 2, widened ? { members, span: widened } : { members: [merged], span: null });
    index = Math.max(0, index - 1);
  }

  const out: EditInput[] = [];
  groups.forEach((group, index) => {
    if (!group.span) {
      out.push(...group.members);
      return;
    }
    const floor = out.length ? out[out.length - 1].to : 0;
    const ceiling = index + 1 < groups.length ? start(groups[index + 1]) : text.length;
    const span = apart(text, group.span, floor, ceiling);
    out.push({ ...span, insert: rewritten(span, group.members) });
  });
  return out;
}

function plannedEdits(oldText: string, newText: string, from: number, targeted: boolean): EditInput[] {
  if (oldText === newText) return [];
  const blocks = (text: string) => text.split(/((?:\r?\n[ \t]*){2,})/).filter(Boolean);
  const parts = diffArrays(blocks(oldText), blocks(newText), { maxEditLength: 2_000 });
  if (!parts) throw new SuggestionPlanError("Revision is too large to group safely; submit smaller targeted edits", 422);
  return editsFromParts(parts.map((part) => ({ ...part, value: part.value.join("") })), from).flatMap((edit) =>
    passageEdits(oldText.slice(edit.from - from, edit.to - from), edit.insert, edit.from, targeted),
  );
}

/**
 * Agent-only review granularity. Unchanged blocks are hard boundaries; inside a
 * changed passage retain small edits, but display substantial rewrites as a pair.
 * Ordinary CRDT editing and history diffs deliberately do not use this function.
 */
export function diffSuggestionEdits(oldText: string, newText: string, from = 0, options: { targeted?: boolean } = {}): EditInput[] {
  const edits = keepTablesWhole(oldText, plannedEdits(oldText, newText, 0, options.targeted ?? false));
  return from === 0 ? edits : edits.map((edit) => ({ ...edit, from: edit.from + from, to: edit.to + from }));
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
  return keepTablesWhole(
    current,
    targets.flatMap((target) => plannedEdits(current.slice(target.from, target.to), target.insert, target.from, true)),
  );
}
