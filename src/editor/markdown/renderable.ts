/**
 * Cheap pre-parse guard against Markdown that micromark parses in quadratic time.
 *
 * micromark resolves link labels and emphasis per paragraph: every `]` walks back over the
 * paragraph's events looking for its `[`, and the attention resolver pairs `*` / `_` runs the
 * same way. A single paragraph of 40 000 `[` + `a` + 40 000 `]` (80 KB) therefore takes ~40 s,
 * and 4x more for every doubling. Real prose never comes close to these counts inside one
 * paragraph, so a document that does is refused before parsing instead of stalling the process.
 *
 * Paragraphs are approximated as runs of non-blank lines outside fenced code; each table row is
 * its own unit because GFM tables tokenize inline content per cell.
 */

/** Max `]` (label ends, including images and footnotes) in one paragraph. ~25 ms of parsing at the limit. */
export const MAX_LABEL_ENDS_PER_PARAGRAPH = 1000;
/** Max `*` + `_` (emphasis markers) in one paragraph. */
export const MAX_ATTENTION_MARKERS_PER_PARAGRAPH = 2000;

export type UnrenderableReason = "brackets" | "emphasis";

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Returns why the text cannot be rendered within budget, or `null` when it is fine.
 * Linear in the text length.
 */
export function findUnrenderable(text: string): UnrenderableReason | null {
  let fence: string | null = null;
  let labelEnds = 0;
  let attention = 0;

  const check = (): UnrenderableReason | null => {
    if (labelEnds > MAX_LABEL_ENDS_PER_PARAGRAPH) return "brackets";
    if (attention > MAX_ATTENTION_MARKERS_PER_PARAGRAPH) return "emphasis";
    return null;
  };
  const reset = () => {
    labelEnds = 0;
    attention = 0;
  };

  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;

    if (fence) {
      const m = FENCE_RE.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      continue;
    }
    const open = FENCE_RE.exec(line);
    if (open) {
      const bad = check();
      if (bad) return bad;
      reset();
      fence = open[1];
      continue;
    }
    if (line.trim() === "") {
      const bad = check();
      if (bad) return bad;
      reset();
      continue;
    }
    // A table row's cells are tokenized separately, so the row does not add to the paragraph.
    if (line.charCodeAt(line.search(/\S|$/)) === 124 /* | */) {
      const bad = check();
      if (bad) return bad;
      reset();
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c === 93 /* ] */) labelEnds++;
      else if (c === 42 /* * */ || c === 95 /* _ */) attention++;
    }
    const bad = check();
    if (bad) return bad;
  }
  return check();
}

/** Shorthand for `findUnrenderable(text) === null`. */
export function isRenderable(text: string): boolean {
  return findUnrenderable(text) === null;
}

/** A paragraph (run of non-blank lines, see module doc) that trips the guard. `to` excludes the trailing newline. */
export interface UnrenderableRange {
  from: number;
  to: number;
  reason: UnrenderableReason;
  /** The offending marker count (label ends or attention markers). */
  count: number;
}

/**
 * Every paragraph of `text` that cannot be rendered within budget, in document order. Linear in
 * the text length; the same paragraph model as {@link findUnrenderable}, which is the cheap
 * yes/no version of this. The client parser swaps these ranges for placeholder blocks.
 */
export function findUnrenderableRanges(text: string): UnrenderableRange[] {
  const out: UnrenderableRange[] = [];
  let fence: string | null = null;
  let labelEnds = 0;
  let attention = 0;
  let paraFrom = -1;
  let paraTo = -1;

  const flush = () => {
    if (paraFrom !== -1) {
      if (labelEnds > MAX_LABEL_ENDS_PER_PARAGRAPH) out.push({ from: paraFrom, to: paraTo, reason: "brackets", count: labelEnds });
      else if (attention > MAX_ATTENTION_MARKERS_PER_PARAGRAPH) out.push({ from: paraFrom, to: paraTo, reason: "emphasis", count: attention });
    }
    labelEnds = 0;
    attention = 0;
    paraFrom = -1;
  };

  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    const lineStart = start;
    start = end + 1;

    if (fence) {
      const m = FENCE_RE.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      continue;
    }
    const open = FENCE_RE.exec(line);
    if (open) {
      flush();
      fence = open[1];
      continue;
    }
    if (line.trim() === "" || line.charCodeAt(line.search(/\S|$/)) === 124 /* | */) {
      flush();
      continue;
    }
    if (paraFrom === -1) paraFrom = lineStart;
    paraTo = end;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c === 93 /* ] */) labelEnds++;
      else if (c === 42 /* * */ || c === 95 /* _ */) attention++;
    }
  }
  flush();
  return out;
}

/** What to do with text that is about to be inserted into the document as Markdown (paste, file import). */
export type InsertDecision = { kind: "markdown" } | { kind: "code"; reason: UnrenderableReason; count: number; message: string };

/**
 * Decide whether incoming text can be inserted as Markdown or must be wrapped in a fenced code
 * block (which the guard treats as safe) so the browser never parses it. The message is the
 * toast shown to the user.
 */
export function decideInsert(text: string, subject = "Pasted text"): InsertDecision {
  const ranges = findUnrenderableRanges(text);
  if (ranges.length === 0) return { kind: "markdown" };
  const worst = ranges.reduce((a, b) => (b.count > a.count ? b : a));
  const what = worst.reason === "brackets" ? "unbalanced brackets" : "emphasis markers";
  const message = `${subject} contains ${worst.count.toLocaleString()} ${what} in one paragraph and cannot be rendered — inserted as a code block`;
  return { kind: "code", reason: worst.reason, count: worst.count, message };
}

/** Wrap `text` in a fenced code block whose fence is longer than any backtick run inside it. */
export function wrapInCodeFence(text: string): string {
  const body = text.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
  let longest = 2;
  for (const m of body.matchAll(/`+/g)) if (m[0].length > longest) longest = m[0].length;
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${body}\n${fence}`;
}

export const UNRENDERABLE_MESSAGE = "Document is not renderable";

/** Thrown by server-side renderers when the guard (or the parse time-out) refuses a document. */
export class UnrenderableDocumentError extends Error {
  readonly reason: UnrenderableReason | "timeout";
  constructor(reason: UnrenderableReason | "timeout", message = UNRENDERABLE_MESSAGE) {
    super(message);
    this.name = "UnrenderableDocumentError";
    this.reason = reason;
  }
}
