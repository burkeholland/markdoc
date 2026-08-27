/**
 * Document statistics over Markdown source: prose words, characters, sentences,
 * paragraphs, headings and derived reading / speaking times.
 *
 * Counting is prose-only: fenced code blocks and YAML front matter are excluded,
 * inline code text is included, link text counts but URLs do not, images are dropped.
 * Words are runs of Unicode letters/digits (with inner apostrophes/hyphens), which
 * under-counts CJK text where words are not space-separated; that is accepted for now.
 */

export interface DocStats {
  words: number;
  /** Characters of the prose text, including spaces. */
  characters: number;
  charactersNoSpaces: number;
  sentences: number;
  paragraphs: number;
  headings: number;
  /** Minutes at 200 words per minute; at least 1 when there are words. */
  readingMinutes: number;
  /** Minutes at 130 words per minute; at least 1 when there are words. */
  speakingMinutes: number;
}

export const READING_WPM = 200;
export const SPEAKING_WPM = 130;

const WORD_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
const SENTENCE_RE = /[.!?…]+(?=\s|$)/gu;
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})/;

export const EMPTY_STATS: DocStats = Object.freeze({
  words: 0,
  characters: 0,
  charactersNoSpaces: 0,
  sentences: 0,
  paragraphs: 0,
  headings: 0,
  readingMinutes: 0,
  speakingMinutes: 0,
}) as DocStats;

/** Minutes for `words` at `wpm`, rounded, never 0 when there is at least one word. */
export function minutesFor(words: number, wpm: number): number {
  if (words <= 0) return 0;
  return Math.max(1, Math.round(words / wpm));
}

/**
 * Linear replacement for the regex `\[([^\]]*)\]\([^)]*\)` family: at each `open` (`[` or `![`),
 * the label runs to the first `]`, which must be followed by `destOpen` and a destination that
 * runs to the first `destClose`. The regex rescans to the next `]` from every `[`, which is
 * quadratic on text such as 40 000 `[` in a row (#115); here the positions of the next `]` and
 * the next destination terminator are remembered between candidates.
 */
function stripLinkLike(s: string, open: string, destOpen: string, destClose: string, keepLabel: boolean): string {
  if (!s.includes(open)) return s;
  let out = "";
  let i = 0;
  let nextLabelEnd = -1;
  let nextDestEnd = -1;
  while (i < s.length) {
    if (!s.startsWith(open, i)) {
      out += s[i++];
      continue;
    }
    const labelFrom = i + open.length;
    if (nextLabelEnd < labelFrom) nextLabelEnd = s.indexOf("]", labelFrom);
    if (nextLabelEnd === -1) return out + s.slice(i);
    const destFrom = nextLabelEnd + 1;
    if (s[destFrom] !== destOpen) {
      out += s[i++];
      continue;
    }
    if (nextDestEnd < destFrom + 1) nextDestEnd = s.indexOf(destClose, destFrom + 1);
    if (nextDestEnd === -1) {
      // No terminator anywhere ahead: no candidate from here on can match.
      return out + s.slice(i);
    }
    if (keepLabel) out += s.slice(labelFrom, nextLabelEnd);
    i = nextDestEnd + 1;
  }
  return out;
}

/** Linear `s.replace(/<[^>]+>/g, "")`. */
function stripAngleTags(s: string): string {
  if (!s.includes("<")) return s;
  let out = "";
  let i = 0;
  let nextGt = -1;
  while (i < s.length) {
    if (s[i] !== "<") {
      out += s[i++];
      continue;
    }
    if (nextGt < i + 1) nextGt = s.indexOf(">", i + 1);
    if (nextGt === -1) return out + s.slice(i);
    if (nextGt === i + 1) {
      out += s[i++];
      continue;
    }
    i = nextGt + 1;
  }
  return out;
}

/**
 * Turn one Markdown line into prose: drop block markers (heading, list, quote, table pipes),
 * images (or keep their alt text with `imageAlt`), link URLs, emphasis and inline code
 * delimiters. Returns the prose text and whether the line was a heading.
 */
function proseOfLine(line: string, imageAlt = false): { text: string; heading: boolean } {
  let s = line;
  let heading = false;
  // Block quotes (possibly nested), then heading markers, list bullets, task boxes.
  s = s.replace(/^\s{0,3}(?:>\s?)+/, "");
  const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(s);
  if (h) {
    heading = true;
    s = h[2];
  } else {
    s = s.replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, "");
  }
  // Horizontal rules, table separator rows.
  if (/^\s*(?:[-*_]\s*){3,}$/.test(s) || /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s)) return { text: "", heading };
  // Table pipes become spaces so cells stay separate words.
  if (s.includes("|")) s = s.replace(/\|/g, " ");
  // Images are dropped (or reduced to their alt text); links keep their text; reference definitions vanish.
  s = stripLinkLike(s, "![", "(", ")", imageAlt);
  s = stripLinkLike(s, "![", "[", "]", imageAlt);
  s = stripLinkLike(s, "[", "(", ")", true);
  s = stripLinkLike(s, "[", "[", "]", true);
  if (/^\s{0,3}\[[^\]]+\]:\s*\S+/.test(s)) return { text: "", heading };
  s = stripAngleTags(s);
  s = s.replace(/`+/g, "");
  s = s.replace(/(\*\*|__|~~|\*|_)/g, "");
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");
  return { text: s, heading };
}

function countWords(text: string): number {
  const m = text.match(WORD_RE);
  return m ? m.length : 0;
}

/**
 * Index of the first line after a YAML front matter block (a `---` line, possibly after blank
 * lines, closed by `---` or `...`), or 0 when there is none.
 */
function afterFrontMatter(lines: string[]): number {
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (lines[i]?.trim() !== "---") return 0;
  let j = i + 1;
  while (j < lines.length && lines[j].trim() !== "---" && lines[j].trim() !== "...") j++;
  return j < lines.length ? j + 1 : 0;
}

/** Whether `line` closes the fence opened with `fence`. */
function closesFence(line: string, fence: string): boolean {
  const m = FENCE_RE.exec(line);
  return !!m && m[2][0] === fence[0] && m[2].length >= fence.length && line.trim() === m[2];
}

/**
 * The first `max` characters of a document's prose, for the dashboard card under the title:
 * front matter and fenced code are skipped, headings are passed over (the title is already on
 * the card), images become their alt text, links their text, table cells are joined by spaces
 * and the remaining Markdown punctuation is removed. A document with no prose at all falls back
 * to its heading text. Linear in the input and stops once `max` characters are collected.
 */
export function excerptOf(markdown: string, max = 160): string {
  return collectExcerpt(markdown, max).text;
}

/**
 * {@link excerptOf} computed from only the first characters of a document, as read with a bounded
 * `left(content, n)` instead of the whole column. `truncated` says whether `prefix` is cut short.
 * Returns null when the prefix is not enough to know the excerpt for certain: the partial last line
 * is dropped, and the result is trusted only if the excerpt filled up before running out of lines
 * (the full function would have stopped at the same point). Otherwise the caller must read the
 * whole text. A prefix that is not truncated is the whole document and is always conclusive.
 */
export function excerptOfPrefix(prefix: string, truncated: boolean, max = 160): string | null {
  if (!truncated) return excerptOf(prefix, max);
  const complete = prefix.slice(0, prefix.lastIndexOf("\n") + 1);
  const lines = complete.split("\n");
  let first = 0;
  while (first < lines.length && lines[first].trim() === "") first++;
  // Front matter that closes beyond the prefix would be read as prose here and skipped by the full text.
  if (lines[first]?.trim() === "---" && afterFrontMatter(lines) === 0) return null;
  const { text, saturated } = collectExcerpt(complete, max);
  return saturated ? text : null;
}

function collectExcerpt(markdown: string, max: number): { text: string; saturated: boolean } {
  if (!markdown) return { text: "", saturated: false };
  const lines = markdown.split("\n");
  let out = "";
  let headingsOnly = "";
  let inFence: string | null = null;
  for (let i = afterFrontMatter(lines); i < lines.length && out.length < max; i++) {
    const line = lines[i];
    if (inFence) {
      if (closesFence(line, inFence)) inFence = null;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      inFence = fence[2];
      continue;
    }
    if (line.trim() === "") continue;
    const { text, heading } = proseOfLine(line, true);
    const t = text.replace(/\s+/g, " ").trim();
    if (t === "") continue;
    if (heading) {
      if (headingsOnly.length < max) headingsOnly += (headingsOnly ? " " : "") + t;
      continue;
    }
    out += (out ? " " : "") + t;
  }
  // Once `out` holds `max` characters the remaining lines cannot change the result.
  return { text: (out || headingsOnly).slice(0, max).trim(), saturated: out.length >= max };
}

function countSentences(text: string): number {
  const m = text.match(SENTENCE_RE);
  return m ? m.length : 0;
}

function compute(markdown: string): DocStats {
  const lines = markdown.split("\n");
  let i = afterFrontMatter(lines);
  let words = 0;
  let characters = 0;
  let charactersNoSpaces = 0;
  let sentences = 0;
  let paragraphs = 0;
  let headings = 0;
  let inFence: string | null = null;
  let para: string[] = [];

  const flush = () => {
    if (para.length === 0) return;
    const text = para.join("\n");
    para = [];
    const w = countWords(text);
    if (w === 0) return;
    paragraphs++;
    words += w;
    characters += text.length;
    charactersNoSpaces += text.replace(/\s/g, "").length;
    // A block that ends without terminal punctuation is still a sentence.
    const s = countSentences(text);
    sentences += s > 0 ? s : 1;
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (inFence) {
      if (closesFence(line, inFence)) inFence = null;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flush();
      inFence = fence[2];
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const { text, heading } = proseOfLine(line);
    if (heading) {
      flush();
      headings++;
      const w = countWords(text);
      if (w > 0) {
        words += w;
        characters += text.length;
        charactersNoSpaces += text.replace(/\s/g, "").length;
      }
      continue;
    }
    if (text.trim() !== "") para.push(text.trim());
  }
  flush();

  return {
    words,
    characters,
    charactersNoSpaces,
    sentences,
    paragraphs,
    headings,
    readingMinutes: minutesFor(words, READING_WPM),
    speakingMinutes: minutesFor(words, SPEAKING_WPM),
  };
}

// The status bar asks for stats on every render; remember the last result per string.
let lastInput: string | null = null;
let lastStats: DocStats = EMPTY_STATS;

/** Statistics of a whole Markdown document. Memoised on the input string (size-1 cache). */
export function computeStats(markdown: string): DocStats {
  if (markdown === lastInput) return lastStats;
  const stats = markdown ? compute(markdown) : EMPTY_STATS;
  lastInput = markdown;
  lastStats = stats;
  return stats;
}

let lastSelKey: string | null = null;
let lastSelStats: DocStats = EMPTY_STATS;

/** Statistics of the source range `[from, to)`; `EMPTY_STATS` when the range is empty. */
export function computeSelectionStats(markdown: string, from: number, to: number): DocStats {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(markdown.length, Math.max(from, to));
  if (b <= a) return EMPTY_STATS;
  const key = `${a}:${b}:${markdown.length}:${markdown}`;
  if (key === lastSelKey) return lastSelStats;
  // Open fences before the selection would otherwise swallow the whole range as code, so the
  // slice is counted on its own; partial fences inside it are treated as-is (best effort).
  const stats = compute(markdown.slice(a, b));
  lastSelKey = key;
  lastSelStats = stats;
  return stats;
}

export type GoalKind = "words" | "minutes";
export type GoalMode = "min" | "max";

export interface WritingGoal {
  kind: GoalKind;
  mode: GoalMode;
  value: number;
  setBy: string | null;
  setAt: number;
}

export interface GoalProgress {
  /** Current value in the goal's unit (words or reading minutes). */
  current: number;
  target: number;
  /** 0..1, clamped. */
  fraction: number;
  /** "progress" until reached, "reached" at/after a min goal or within a max goal, "exceeded" past a max goal. */
  state: "progress" | "reached" | "exceeded";
}

/** Compare document stats against a goal. */
export function goalProgress(stats: DocStats, goal: WritingGoal): GoalProgress {
  const current = goal.kind === "words" ? stats.words : stats.readingMinutes;
  const target = Math.max(1, goal.value);
  const fraction = Math.max(0, Math.min(1, current / target));
  let state: GoalProgress["state"] = "progress";
  if (goal.mode === "min") {
    if (current >= target) state = "reached";
  } else {
    state = current > target ? "exceeded" : "reached";
  }
  return { current, target, fraction, state };
}
