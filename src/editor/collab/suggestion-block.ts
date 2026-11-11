/**
 * GitHub-style suggestion blocks inside comment bodies:
 *
 * ````
 * ```suggestion
 * proposed replacement for the quoted text
 * ```
 * ````
 *
 * The block proposes a replacement for the thread's anchored range. It is stored as part of the
 * Markdown body and parsed on render, so threads need no schema change. Only the first block
 * counts; extra blocks are reported as a warning and left in the prose.
 */

export interface SuggestionBlock {
  /** Proposed replacement text (fence contents, without the trailing newline). */
  text: string;
  /** The body with the suggestion block removed (what renders as prose). */
  prose: string;
  /** Set when the body held more than one block: only the first is used. */
  warning: string | null;
}

// An empty block (no content line) proposes deleting the quoted text, as on GitHub.
const FENCE_RE = /(\n)[ \t]{0,3}(`{3,}|~{3,})[ \t]*suggestion[ \t]*\n(?:([\s\S]*?)\n)?[ \t]{0,3}\2[ \t]*(?=\n|$)/g;

/** Extract the first ```suggestion block from a comment body; null when there is none. */
export function parseSuggestionBlock(body: string): SuggestionBlock | null {
  const src = body.replace(/\r\n?/g, "\n");
  // A block at the very start has no preceding newline; normalise by prefixing one.
  const padded = "\n" + src;
  const matches = Array.from(padded.matchAll(FENCE_RE));
  if (matches.length === 0) return null;
  const first = matches[0];
  const text = first[3] ?? "";
  const start = first.index! + first[1].length;
  const end = first.index! + first[0].length;
  const prose = (padded.slice(0, start) + padded.slice(end)).slice(1).replace(/\n{3,}/g, "\n\n").trim();
  return {
    text,
    prose,
    warning: matches.length > 1 ? `Only the first of ${matches.length} suggestion blocks is used.` : null,
  };
}

/** Whether `body` contains a suggestion block at all (cheap check for lists). */
export function hasSuggestionBlock(body: string): boolean {
  return /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[ \t]*suggestion[ \t]*\n/.test(body.replace(/\r\n?/g, "\n"));
}

/** Build a comment body that proposes `replacement` for the quoted text (composer "Suggest a change"). */
export function suggestionBlockFor(replacement: string, prose = ""): string {
  // A fence longer than any backtick run inside the text keeps the block well-formed.
  const longest = Math.max(2, ...Array.from(replacement.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const block = `${fence}suggestion\n${replacement}\n${fence}`;
  return prose.trim() ? `${prose.trim()}\n\n${block}` : block;
}

/**
 * A suggestion is outdated when the text it would replace no longer reads as it did when the
 * comment was written (the anchored range drifted, shrank, or the words changed). GitHub disables
 * Accept in that case; Reject stays available.
 */
export function isSuggestionOutdated(thread: { quote: string; range: { from: number; to: number } | null }, text: string): boolean {
  if (!thread.range) return true;
  return text.slice(thread.range.from, thread.range.to) !== thread.quote;
}

export type SuggestionOutdatedCause = "pending-suggestion" | "changed";

/**
 * Why a suggestion is outdated; null when it is not. "pending-suggestion": the quoted range reads as the
 * quote again once the text of pending tracked insertions is taken out of it, so rejecting those tracked
 * suggestions makes this one applicable again (accepting them leaves it outdated). "changed": the text
 * was edited, or the anchor is gone; no pending decision brings it back (#2327).
 */
export function suggestionOutdatedCause(
  thread: { quote: string; range: { from: number; to: number } | null },
  text: string,
  pendingInsertions: readonly { from: number; to: number }[],
): SuggestionOutdatedCause | null {
  if (!isSuggestionOutdated(thread, text)) return null;
  const range = thread.range;
  if (!range) return "changed";
  let rest = "";
  let at = range.from;
  for (const insertion of [...pendingInsertions].sort((a, b) => a.from - b.from)) {
    const from = Math.max(insertion.from, at);
    const to = Math.min(insertion.to, range.to);
    if (to <= from) continue;
    rest += text.slice(at, from);
    at = to;
  }
  if (at === range.from) return "changed";
  return rest + text.slice(at, range.to) === thread.quote ? "pending-suggestion" : "changed";
}

/**
 * The sentence a review card shows when some of its undecided suggestions cannot be applied; null when all
 * of them can. `waiting` counts the outdated ones whose cause is a pending tracked suggestion: that wording
 * wins when both causes occur, because it is the one a person can act on.
 */
export function reviewSuggestionNote({ undecided, applicable, waiting }: { undecided: number; applicable: number; waiting: number }): string | null {
  const outdated = undecided - applicable;
  if (outdated <= 0) return null;
  const quote = (count: number) => (count === 1 ? "quotes" : "quote");
  if (applicable > 0) {
    const head = `${applicable} of ${undecided} suggestions can be applied; `;
    if (waiting === 0) return `${head}${outdated} ${quote(outdated)} text that has changed.`;
    if (waiting >= outdated) return `${head}${outdated} ${quote(outdated)} text that a pending suggestion changes.`;
    return `${head}${outdated} quote text that has changed, ${waiting} of them by a pending suggestion.`;
  }
  if (undecided === 1) {
    return waiting === 0
      ? "The suggestion cannot be applied: the text it quotes has changed."
      : "The suggestion cannot be applied: a pending suggestion changes the text it quotes. It applies again if the pending suggestion is rejected.";
  }
  const head = `None of the ${undecided} suggestions can be applied: `;
  if (waiting === 0) return `${head}the text they quote has changed.`;
  if (waiting >= outdated) return `${head}a pending suggestion changes the text they quote. They apply again if it is rejected.`;
  return `${head}the text they quote has changed, for ${waiting} of them by a pending suggestion. ${waiting === 1 ? "That one applies" : "Those apply"} again if it is rejected.`;
}

/** Pluralised summary for a review card: "3 comments · 2 suggestions". */
export function reviewSummaryLabel(comments: number, suggestions: number): string {
  const c = `${comments} ${comments === 1 ? "comment" : "comments"}`;
  if (suggestions === 0) return c;
  return `${c} · ${suggestions} ${suggestions === 1 ? "suggestion" : "suggestions"}`;
}

export type ReviewVerdict = "approve" | "request_changes" | "comment";

/** "Copilot requested changes", "Alice approved", "Bob commented". */
export function reviewVerdictLabel(author: string, verdict: ReviewVerdict): string {
  switch (verdict) {
    case "approve":
      return `${author} approved`;
    case "request_changes":
      return `${author} requested changes`;
    default:
      return `${author} commented`;
  }
}
