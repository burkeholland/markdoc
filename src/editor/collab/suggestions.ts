import * as Y from "yjs";
import { createAnchor, newId, resolveAnchor, type CollabUser, type TextAnchor } from "./shared";
import { retargetReplacementComments, SUGGESTION_ANCHORS_META } from "./replacement-anchors";

export type SuggestionType = "insert" | "delete";

export interface Suggestion {
  id: string;
  type: SuggestionType;
  anchor: TextAnchor;
  authorId: string;
  authorName: string;
  authorAvatar?: string | null;
  createdAt: number;
  /** Snapshot of the suggested text (inserted or to be deleted) for display. */
  text: string;
  /** Agent replacement identity. Legacy human typing keeps its adjacent-edit behavior. */
  groupId?: string;
  groupSize?: number;
}

export interface ResolvedSuggestion extends Suggestion {
  from: number;
  to: number;
}

export interface SuggestionGroup extends Omit<ResolvedSuggestion, "type"> {
  type: SuggestionType | "replace";
  members: ResolvedSuggestion[];
  before: string;
  after: string;
  outdated: boolean;
}

export class SuggestionConflictError extends Error {
  constructor() {
    super("This suggestion overlaps a newer edit. Review the changed text before deciding it.");
    this.name = "SuggestionConflictError";
  }
}

export const SUGGESTIONS_ORIGIN = { name: "suggestions" };

/** A table row without the padding around its pipes; a delimiter row also without the length of its dashes. */
function unpaddedRow(line: string): string {
  const row = line.replace(/[ \t]*\|[ \t]*/g, "|").trim();
  return /^\|?:?-+:?(?:\|:?-+:?)*\|?$/.test(row) ? row.replace(/-+/g, "-") : row;
}

/**
 * Whether the text of a pending suggestion still reads as it did when it was proposed. The rich editor
 * writes a table with its columns lined up, so typing in one cell changes the padding of every row and
 * the dashes of the delimiter row. That is not a change to a suggestion on another row of the table,
 * which would otherwise be outdated, with nothing left to accept or reject, by the first edit near it.
 */
function reads(current: string, proposed: string): boolean {
  if (current === proposed) return true;
  if (!proposed.includes("|") || !current.includes("|")) return false;
  const rows = (text: string) => text.split("\n").map((line) => (line.includes("|") ? unpaddedRow(line) : line)).join("\n");
  return rows(current) === rows(proposed);
}

export interface EditInput {
  from: number;
  to: number;
  insert: string;
}

/**
 * Tracked changes ("suggesting mode").
 *
 * Suggestions are annotations over the shared Markdown text:
 *  - an *insert* suggestion marks text that is in the document but not yet accepted;
 *  - a *delete* suggestion marks text that should be removed once accepted.
 *
 * This keeps the text the single source of truth for both editing surfaces
 * while allowing exact tracked-changes semantics: accept keeps the insertion and
 * drops the deleted text, reject does the reverse. Agent replacement pairs are
 * decided atomically; legacy typing suggestions remain independent.
 */
export class SuggestionsModel {
  readonly ymap: Y.Map<Suggestion>;
  private listeners = new Set<() => void>();

  constructor(
    readonly ydoc: Y.Doc,
    readonly ytext: Y.Text,
  ) {
    this.ymap = ydoc.getMap<Suggestion>("suggestions");
    this.ymap.observe(this.notify);
    this.ytext.observe(this.notify);
  }

  destroy() {
    this.ymap.unobserve(this.notify);
    this.ytext.unobserve(this.notify);
    this.listeners.clear();
  }

  private notify = () => {
    for (const l of this.listeners) l();
  };

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): ResolvedSuggestion[] {
    const out: ResolvedSuggestion[] = [];
    this.ymap.forEach((s, id) => {
      const range = resolveAnchor(this.ytext, s.anchor);
      if (!range) {
        // The anchored text disappeared (for example an insertion was deleted by its author).
        return;
      }
      if (range.to <= range.from) {
        return;
      }
      out.push({ ...s, id, from: range.from, to: range.to });
    });
    return out.sort((a, b) => a.from - b.from || a.createdAt - b.createdAt);
  }

  get count(): number {
    const groups = new Set<string>();
    this.ymap.forEach((s, id) => {
      if (!s.groupId) {
        const range = resolveAnchor(this.ytext, s.anchor);
        if (!range || range.to <= range.from) return;
      }
      groups.add(JSON.stringify([s.groupId ?? id, s.authorId]));
    });
    return groups.size;
  }

  /** One review/navigation unit per agent operation; legacy suggestions stay independent. */
  groups(sourceText?: string): SuggestionGroup[] {
    if (this.ymap.size === 0) return [];
    const text = sourceText ?? this.ytext.toString();
    const grouped = new Map<string, SuggestionGroup>();
    this.ymap.forEach((s, id) => {
      const range = resolveAnchor(this.ytext, s.anchor);
      const live = !!range && range.to > range.from;
      if (!s.groupId && !live) return;
      const key = JSON.stringify([s.groupId ?? id, s.authorId]);
      const member = { ...s, id, from: range?.from ?? 0, to: range?.to ?? 0 };
      let group = grouped.get(key);
      if (!group) {
        group = { ...member, id: s.groupId ?? id, members: [], before: "", after: "", outdated: false };
        grouped.set(key, group);
      }
      group.members.push(member);
      group.from = Math.min(group.from, member.from);
      group.to = Math.max(group.to, member.to);
      if (s.groupId && (!live || !reads(text.slice(member.from, member.to), s.text))) group.outdated = true;
    });
    const groups = [...grouped.values()];
    const owners = new Map<string, SuggestionGroup>();
    for (const group of groups) {
      group.members.sort((a, b) => a.from - b.from);
      for (const member of group.members) {
        owners.set(member.id, group);
        const value = member.groupId ? member.text : text.slice(member.from, member.to);
        if (member.type === "delete") group.before += value;
        else group.after += value;
      }
      group.type = group.members.some((s) => s.type === "insert")
        ? group.members.some((s) => s.type === "delete") ? "replace" : "insert"
        : "delete";
      group.text = group.type === "delete" ? group.before : group.after;
      if (group.groupId && group.members.length !== group.groupSize) group.outdated = true;
    }
    // A newer tracked annotation can overlap without changing the underlying text.
    // A sweep, rather than a pairwise scan, keeps refreshes bounded.
    let furthest: ResolvedSuggestion | undefined;
    for (const member of groups.flatMap((group) => group.members).sort((a, b) => a.from - b.from)) {
      if (furthest && member.from < furthest.to && owners.get(member.id) !== owners.get(furthest.id)) {
        for (const id of [member.id, furthest.id]) {
          const group = owners.get(id)!;
          if (group.groupId) group.outdated = true;
        }
      }
      if (!furthest || member.to > furthest.to) furthest = member;
    }
    return groups.sort((a, b) => a.from - b.from || a.createdAt - b.createdAt);
  }

  /** A new agent operation never merges into a neighbor, even by the same author. */
  propose(edit: EditInput, author: CollabUser, origin: object = SUGGESTIONS_ORIGIN): string {
    return this.proposeEdits([edit], author, origin)[0];
  }

  /** Original-coordinate operations are preflighted together, then applied atomically. */
  proposeEdits(edits: EditInput[], author: CollabUser, origin: object = SUGGESTIONS_ORIGIN): string[] {
    const pending = this.list();
    const ordered = [...edits].sort((a, b) => a.from - b.from);
    for (const [index, edit] of ordered.entries()) {
      if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to) || edit.from < 0 || edit.to < edit.from || edit.to > this.ytext.length) {
        throw new RangeError("Suggestion range is outside the document");
      }
      if (edit.from === edit.to && !edit.insert) throw new Error("Cannot propose an empty edit");
      if ((index > 0 && ordered[index - 1].to > edit.from) ||
        pending.some((s) => (edit.from < s.to && edit.to > s.from) || (edit.from === edit.to && edit.from > s.from && edit.from < s.to))) {
        throw new SuggestionConflictError();
      }
    }
    const created: string[] = [];
    this.ydoc.transact(() => {
      for (const edit of ordered.reverse()) {
        const groupId = newId();
        const groupSize = Number(edit.to > edit.from) + Number(!!edit.insert);
        const ids: string[] = [];
        if (edit.to > edit.from) ids.push(this.create("delete", edit.from, edit.to, author, edit.insert ? newId() : groupId));
        if (edit.insert) {
          this.ytext.insert(edit.from, edit.insert);
          ids.push(this.create("insert", edit.from, edit.from + edit.insert.length, author, groupId));
        }
        for (const id of ids) this.ymap.set(id, { ...this.ymap.get(id)!, groupId, groupSize });
        created.push(groupId);
      }
    }, origin);
    return created.reverse();
  }

  /** Remove records whose text no longer exists. */
  prune(origin: object = SUGGESTIONS_ORIGIN) {
    const dead: string[] = [];
    this.ymap.forEach((s, id) => {
      const range = resolveAnchor(this.ytext, s.anchor);
      if (!s.groupId && (!range || range.to <= range.from)) dead.push(id);
    });
    if (dead.length) this.ydoc.transact(() => dead.forEach((id) => this.ymap.delete(id)), origin);
  }

  private setRange(id: string, from: number, to: number, text?: string) {
    const s = this.ymap.get(id);
    if (!s) return;
    this.ymap.set(id, { ...s, anchor: createAnchor(this.ytext, from, to), text: text ?? this.ytext.toString().slice(from, to) });
  }

  private create(type: SuggestionType, from: number, to: number, author: CollabUser, id = newId()): string {
    this.ymap.set(id, {
      id,
      type,
      anchor: createAnchor(this.ytext, from, to),
      authorId: author.id,
      authorName: author.name,
      authorAvatar: author.avatar ?? null,
      createdAt: Date.now(),
      text: this.ytext.toString().slice(from, to),
    });
    return id;
  }

  /**
   * Mark [from, to) as a suggested deletion. Portions that lie inside the
   * author's own pending insertions are really removed from the text instead.
   * Must be called inside a transaction. Returns the number of characters kept
   * in the text (i.e. marked rather than removed).
   */
  markDeleted(from: number, to: number, author: CollabUser): number {
    if (to <= from) return 0;
    const all = this.list();
    const ownInserts = all.filter((s) => !s.groupId && s.type === "insert" && s.authorId === author.id && s.from < to && s.to > from);
    let removedBeforeTo = 0;
    for (const s of [...ownInserts].sort((a, b) => b.from - a.from)) {
      const dFrom = Math.max(from, s.from);
      const dTo = Math.min(to, s.to);
      if (dTo <= dFrom) continue;
      this.ytext.delete(dFrom, dTo - dFrom);
      removedBeforeTo += dTo - dFrom;
      const remaining = resolveAnchor(this.ytext, s.anchor);
      if (!remaining || remaining.to <= remaining.from) this.ymap.delete(s.id);
      else this.setRange(s.id, remaining.from, remaining.to);
    }
    to -= removedBeforeTo;

    // What remains of [from, to) becomes delete-suggestions, skipping ranges already marked.
    const existingDeletes = this.list().filter((s) => s.type === "delete");
    const segments: { from: number; to: number }[] = [];
    let pos = from;
    for (const d of existingDeletes.filter((d) => d.to > from && d.from < to).sort((a, b) => a.from - b.from)) {
      if (d.from > pos) segments.push({ from: pos, to: Math.min(d.from, to) });
      pos = Math.max(pos, d.to);
    }
    if (pos < to) segments.push({ from: pos, to });
    let kept = 0;
    for (const seg of segments) {
      if (seg.to <= seg.from) continue;
      kept += seg.to - seg.from;
      const before = existingDeletes.find((d) => !d.groupId && d.authorId === author.id && d.to === seg.from);
      const after = existingDeletes.find((d) => !d.groupId && d.authorId === author.id && d.from === seg.to);
      if (before && after) {
        this.setRange(before.id, before.from, after.to);
        this.ymap.delete(after.id);
      } else if (before) {
        this.setRange(before.id, before.from, seg.to);
      } else if (after) {
        this.setRange(after.id, seg.from, after.to);
      } else {
        this.create("delete", seg.from, seg.to, author);
      }
    }
    return kept;
  }

  /**
   * Record text that is already in the document at [pos, pos+len) as a
   * suggested insertion, merging with the author's adjacent insertions. If the
   * range was inserted inside another delete-suggestion, that suggestion is
   * split around it. Must be called inside a transaction.
   */
  recordInserted(pos: number, len: number, author: CollabUser) {
    if (len <= 0) return;
    const all = this.list();
    // A delete-suggestion that spans the inserted range (it grew when the text was inserted).
    const spanning = all.find((d) => !d.groupId && d.type === "delete" && d.from < pos && d.to > pos + len);
    if (spanning) {
      const tailFrom = pos + len;
      const tailTo = spanning.to;
      this.setRange(spanning.id, spanning.from, pos);
      const tailId = this.create("delete", tailFrom, tailTo, {
        id: spanning.authorId,
        name: spanning.authorName,
        avatar: spanning.authorAvatar,
        color: "",
        colorLight: "",
      });
      const tailRecord = this.ymap.get(tailId);
      if (tailRecord) this.ymap.set(tailId, { ...tailRecord, createdAt: spanning.createdAt });
      this.create("insert", pos, pos + len, author);
      return;
    }
    const own = all.filter((s) => !s.groupId && s.type === "insert" && s.authorId === author.id);
    const before = own.find((s) => s.to === pos || (s.from < pos && s.to >= pos + len));
    const after = own.find((s) => s.from === pos + len);
    if (before) {
      const end = after ? after.to : Math.max(before.to, pos + len);
      this.setRange(before.id, before.from, end);
      if (after) this.ymap.delete(after.id);
    } else if (after) {
      this.setRange(after.id, pos, after.to);
    } else {
      this.create("insert", pos, pos + len, author);
    }
  }

  /**
   * Apply an edit made in suggesting mode: deletions become delete-suggestions
   * (except inside the author's own pending insertions, which are really
   * removed); insertions are inserted before any kept text and recorded.
   *
   * Returns the number of characters of the requested deletion that were kept
   * in the text (so callers can adjust later positions) and the cursor offset.
   */
  applyEdit(edit: EditInput, author: CollabUser, origin: object = SUGGESTIONS_ORIGIN): { kept: number; cursor: number } {
    let kept = 0;
    let cursor = edit.from;
    this.ydoc.transact(() => {
      const { from, to, insert } = edit;
      if (to > from) kept = this.markDeleted(from, to, author);
      if (insert) {
        this.ytext.insert(from, insert);
        this.recordInserted(from, insert.length, author);
        cursor = from + insert.length;
      }
    }, origin);
    return { kept, cursor };
  }


  accept(id: string, origin: object = SUGGESTIONS_ORIGIN) {
    return this.decideOne(id, true, origin);
  }

  reject(id: string, origin: object = SUGGESTIONS_ORIGIN) {
    return this.decideOne(id, false, origin);
  }

  private decideOne(id: string, accept: boolean, origin: object): number {
    const groups = this.groups().filter((group) => group.id === id || group.members.some((s) => s.id === id));
    if (!groups.length) this.ydoc.transact(() => this.ymap.delete(id), origin);
    return this.decide(groups, accept, origin);
  }

  acceptAll(origin: object = SUGGESTIONS_ORIGIN) {
    return this.decide(this.groups(), true, origin);
  }

  rejectAll(origin: object = SUGGESTIONS_ORIGIN) {
    return this.decide(this.groups(), false, origin);
  }

  private decide(groups: SuggestionGroup[], accept: boolean, origin: object): number {
    if (groups.some((group) => group.outdated)) throw new SuggestionConflictError();
    this.ydoc.transact((transaction) => {
      const pairs = groups.flatMap((group) => {
        if (!group.groupId || group.type !== "replace") return [];
        const removed = group.members.find((s) => s.type === (accept ? "delete" : "insert"))!;
        const kept = group.members.find((s) => s.type === (accept ? "insert" : "delete"))!;
        return [{ removed, kept }];
      });
      const anchors = retargetReplacementComments(this.ydoc, this.ytext, pairs);
      if (anchors.length) transaction.meta.set(SUGGESTION_ANCHORS_META, anchors);
      for (const s of groups.flatMap((group) => group.members).sort((a, b) => b.from - a.from)) {
        if (s.type === (accept ? "delete" : "insert")) this.ytext.delete(s.from, s.to - s.from);
        this.ymap.delete(s.id);
      }
    }, origin);
    return groups.length;
  }

  /** The text as it would be if every pending suggestion were rejected (for export/publish). */
  cleanText(): string {
    return cleanTextWith(this.ytext.toString(), this.list());
  }
}

export function cleanTextWith(text: string, suggestions: ResolvedSuggestion[]): string {
  const inserts = suggestions.filter((s) => s.type === "insert").sort((a, b) => a.from - b.from);
  if (inserts.length === 0) return text;
  let out = "";
  let pos = 0;
  for (const s of inserts) {
    if (s.from > pos) out += text.slice(pos, s.from);
    pos = Math.max(pos, s.to);
  }
  out += text.slice(pos);
  return out;
}

/**
 * Inverse of {@link cleanTextWith} for one offset: the index in the full text (with pending insertions)
 * that corresponds to `clean`, an offset in the clean text. An offset right before a pending insertion
 * stays before it, so a range never swallows a suggestion that merely touches it.
 */
export function cleanToRawOffset(clean: number, suggestions: Pick<ResolvedSuggestion, "type" | "from" | "to">[]): number {
  let raw = Math.max(0, clean);
  let covered = 0;
  for (const s of suggestions.filter((s) => s.type === "insert").sort((a, b) => a.from - b.from)) {
    const from = Math.max(s.from, covered);
    const to = Math.max(s.to, from);
    if (from >= raw) break;
    raw += to - from;
    covered = to;
  }
  return raw;
}

/** Inverse of {@link cleanToRawOffset}: the clean-text offset of an index in the full text (inside a pending insertion → its start). */
export function rawToCleanOffset(raw: number, suggestions: Pick<ResolvedSuggestion, "type" | "from" | "to">[]): number {
  let removed = 0;
  let covered = 0;
  for (const s of suggestions.filter((s) => s.type === "insert").sort((a, b) => a.from - b.from)) {
    const from = Math.max(s.from, covered);
    const to = Math.max(s.to, from);
    if (from >= raw) break;
    removed += Math.min(to, raw) - from;
    covered = to;
  }
  return Math.max(0, raw - removed);
}

/** Where an agent says it is: offsets in the clean text, or the first occurrence of a quote. */
export type CleanRangeInput = { from: number; to: number } | { anchor: string };

/**
 * Resolve a clean-text range to offsets in the full text. Offsets are clamped to the clean text;
 * an `anchor` that does not occur yields null.
 */
export function resolveCleanRange(
  clean: string,
  suggestions: Pick<ResolvedSuggestion, "type" | "from" | "to">[],
  input: CleanRangeInput,
): { clean: { from: number; to: number }; raw: { from: number; to: number } } | null {
  let from: number;
  let to: number;
  if ("anchor" in input) {
    if (!input.anchor) return null;
    const idx = clean.indexOf(input.anchor);
    if (idx === -1) return null;
    from = idx;
    to = idx + input.anchor.length;
  } else {
    from = Math.min(Math.max(0, input.from), clean.length);
    to = Math.min(Math.max(from, input.to), clean.length);
  }
  return { clean: { from, to }, raw: { from: cleanToRawOffset(from, suggestions), to: cleanToRawOffset(to, suggestions) } };
}
