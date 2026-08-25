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
