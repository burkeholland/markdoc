import type { Node as PMNode } from "prosemirror-model";
import { hasFrontmatter, parseMarkdown, type HeadingInfo, type ParseResult } from "./parse";
import { schema } from "./schema";
import { buildSourceMap, type BlockRange, type Segment } from "./sourcemap";

/** Span of a text change in old and new coordinates. */
export interface ChangeSpan {
  from: number;
  oldTo: number;
  newTo: number;
}

/** Smallest span that turns `oldText` into `newText` (common prefix and suffix trimmed). */
export function textChangeSpan(oldText: string, newText: string): ChangeSpan | null {
  if (oldText === newText) return null;
  const max = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++;
  }
  return { from: prefix, oldTo: oldText.length - suffix, newTo: newText.length - suffix };
}

/** Constructs whose meaning depends on text anywhere else in the document (link reference definitions, footnotes). */
const GLOBAL_CONTEXT = /^[ \t]*(?:(?:>[ \t]?|[-*+][ \t]|\d{1,9}[.)][ \t])[ \t]*)*\[[^\]\n]*\]:|\[\^/m;

/** True when a region cannot be parsed in isolation because of document-wide constructs. */
export function hasGlobalContext(text: string): boolean {
  return GLOBAL_CONTEXT.test(text);
}

/**
 * Appended (after a blank line) to a region that is followed by more document. If it
 * does not come out as its own paragraph, an unclosed fence or HTML block in the region
 * would swallow the text that follows it, and the region cannot be parsed alone.
 */
const SENTINEL = "MARKDOC\u00b7SENTINEL";

function countNewlines(text: string, end: number): number {
  let n = 0;
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

function lineEnd(text: string, offset: number): number {
  const i = text.indexOf("\n", offset);
  return i === -1 ? text.length : i;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 13;
}

/** True when the line that ends at `pos` (a newline offset) contains only whitespace. */
function blankLineEndingAt(text: string, pos: number): boolean {
  for (let i = pos - 1; i >= 0; i--) {
    const c = text.charCodeAt(i);
    if (c === 10) return true;
    if (!isSpace(c)) return false;
  }
  return true;
}

/** True when the line that starts at `pos` contains only whitespace. */
function blankLineStartingAt(text: string, pos: number): boolean {
  for (let i = pos; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) return true;
    if (!isSpace(c)) return false;
  }
  return true;
}

function isIndentedCode(node: PMNode, src: string, from: number): boolean {
  if (node.type !== schema.nodes.code_block) return false;
  return !/^ {0,3}(?:`{3,}|~{3,})/.test(src.slice(lineStart(src, from), from + 8));
}

/** Adjacent top-level blocks that Markdown would join across a blank line. */
function wouldMerge(first: PMNode, second: PMNode): boolean {
  if (first.type !== second.type) return false;
  if (first.type === schema.nodes.bullet_list) return first.attrs.bullet === second.attrs.bullet;
  if (first.type === schema.nodes.ordered_list) return first.attrs.delimiter === second.attrs.delimiter;
  return false;
}

interface RegionParse {
  nodes: PMNode[];
  blocks: BlockRange[];
  segments: Segment[];
  headings: HeadingInfo[];
  size: number;
}

/** Parse a region on its own; `followed` means more document comes after it. */
function parseRegion(region: string, followed: boolean): RegionParse | null {
  if (region.trim() === "") return { nodes: [], blocks: [], segments: [], headings: [], size: 0 };
  const text = followed ? region + "\n\n" + SENTINEL : region;
  const parsed = parseMarkdown(text);
  let count = parsed.doc.childCount;
  if (followed) {
    const last = parsed.doc.child(count - 1);
    const range = parsed.map.blocks[count - 1];
    if (last.type !== schema.nodes.paragraph || last.textContent !== SENTINEL || range.from !== region.length + 2) return null;
    count--;
    if (count === 0) return null;
  }
  const nodes: PMNode[] = [];
  let size = 0;
  for (let i = 0; i < count; i++) {
    nodes.push(parsed.doc.child(i));
    size += parsed.doc.child(i).nodeSize;
  }
  return {
    nodes,
    blocks: parsed.map.blocks.slice(0, count),
    segments: parsed.map.segments.filter((s) => s.pmTo <= size),
    headings: parsed.headings.filter((h) => h.from < region.length),
    size,
  };
}

/**
 * Re-parse only the top-level blocks touched by a change (plus one neighbour on each
 * side, because Markdown merges adjacent constructs) and splice the result into the
 * previous parse. Unchanged ProseMirror nodes are reused, so the result is cheap to
 * diff against the previous document.
 *
 * Returns null when the change cannot be isolated safely; callers then fall back to
 * a full parse.
 */
export function reparseRange(prev: ParseResult, oldText: string, newText: string, span: ChangeSpan): ParseResult | null {
  const blocks = prev.map.blocks;
  const n = blocks.length;
  if (n === 0 || n !== prev.doc.childCount || oldText.trim() === "" || newText.trim() === "") return null;
  if (hasGlobalContext(oldText) || hasGlobalContext(newText)) return null;
  if (hasFrontmatter(oldText) !== hasFrontmatter(newText)) return null;
  const delta = span.newTo - span.oldTo;

  // Blocks overlapping the change, extended by one neighbour on each side.
  let a = blocks.findIndex((b) => b.to >= span.from);
  if (a === -1) a = n - 1;
  a = Math.max(0, a - 1);
  let b = n - 1;
  while (b > 0 && blocks[b].from > span.oldTo) b--;
  b = Math.min(n - 1, Math.max(b + 1, a));

  const regionFrom = a === 0 ? 0 : lineStart(oldText, blocks[a].from);
  const regionToOld = b === n - 1 ? oldText.length : lineEnd(oldText, Math.max(blocks[b].from, blocks[b].to - 1));
  if (span.from < regionFrom || span.oldTo > regionToOld) return null;
  if (a > 0 && blocks[a - 1].to > regionFrom) return null;
  if (b < n - 1 && blocks[b + 1].from <= regionToOld) return null;
  const regionToNew = regionToOld + delta;
  if (regionToNew < regionFrom) return null;

  // The region must stay separated from its neighbours by blank lines and must not be
  // followed by an indented block that a list in the region could absorb.
  if (a > 0 && !blankLineEndingAt(newText, regionFrom - 1)) return null;
  if (b < n - 1) {
    if (!blankLineStartingAt(newText, regionToNew + 1)) return null;
    if (isSpace(oldText.charCodeAt(lineStart(oldText, blocks[b + 1].from)))) return null;
  }
  const region = newText.slice(regionFrom, regionToNew);
  if (regionFrom > 0 && region.startsWith("---")) return null;
  if (regionFrom === 0 && hasFrontmatter(region) !== hasFrontmatter(newText)) return null;

  const sub = parseRegion(region, b < n - 1);
  if (!sub) return null;
  if (sub.nodes.length === 0 && a === 0 && b === n - 1) return null;

  // Indented code continues across blank lines and changes how a following list is
  // read, and lists with the same marker join across blank lines: bail out when such a
  // construct sits on either side of a region boundary.
  const first = sub.nodes[0];
  const last = sub.nodes[sub.nodes.length - 1];
  if (a > 0) {
    const before = prev.doc.child(a - 1);
    if (isIndentedCode(before, oldText, blocks[a - 1].from)) return null;
    if (first && (wouldMerge(before, first) || isIndentedCode(first, region, sub.blocks[0].from))) return null;
  }
  if (b < n - 1) {
    const after = prev.doc.child(b + 1);
    if (isIndentedCode(after, oldText, blocks[b + 1].from)) return null;
    // micromark reads the block after indented code as if it interrupted a paragraph,
    // so the old parse of `after` may not hold once the code block is gone.
    if (isIndentedCode(prev.doc.child(b), oldText, blocks[b].from)) return null;
    if (last && (wouldMerge(last, after) || isIndentedCode(last, region, sub.blocks[sub.blocks.length - 1].from))) return null;
  }

  // Positions in the previous (parsed) document.
  let pmStartOld = 0;
  for (let i = 0; i < a; i++) pmStartOld += prev.doc.child(i).nodeSize;
  let pmEndOld = pmStartOld;
  for (let i = a; i <= b; i++) pmEndOld += prev.doc.child(i).nodeSize;
  const pmDelta = sub.size - (pmEndOld - pmStartOld);

  const children: PMNode[] = [];
  const newBlocks: BlockRange[] = [];
  for (let i = 0; i < a; i++) {
    children.push(prev.doc.child(i));
    newBlocks.push(blocks[i]);
  }
  sub.nodes.forEach((child, i) => {
    children.push(child);
    newBlocks.push({ from: sub.blocks[i].from + regionFrom, to: sub.blocks[i].to + regionFrom });
  });
  for (let i = b + 1; i < n; i++) {
    children.push(prev.doc.child(i));
    newBlocks.push({ from: blocks[i].from + delta, to: blocks[i].to + delta });
  }
  if (children.length === 0) return null;

  const segments: Segment[] = [];
  for (const s of prev.map.segments) if (s.pmTo <= pmStartOld) segments.push(s);
  for (const s of sub.segments) {
    segments.push({
      pmFrom: s.pmFrom + pmStartOld,
      pmTo: s.pmTo + pmStartOld,
      srcFrom: s.srcFrom + regionFrom,
      srcTo: s.srcTo + regionFrom,
    });
  }
  for (const s of prev.map.segments) {
    if (s.pmFrom >= pmEndOld) {
      segments.push({ pmFrom: s.pmFrom + pmDelta, pmTo: s.pmTo + pmDelta, srcFrom: s.srcFrom + delta, srcTo: s.srcTo + delta });
    }
  }

  const lineOffset = countNewlines(newText, regionFrom);
  const lineDelta = countNewlines(newText, newText.length) - countNewlines(oldText, oldText.length);
  const headings: HeadingInfo[] = [];
  for (const h of prev.headings) if (h.from < regionFrom) headings.push(h);
  for (const h of sub.headings) headings.push({ ...h, from: h.from + regionFrom, line: h.line + lineOffset });
  for (const h of prev.headings) if (h.from >= regionToOld) headings.push({ ...h, from: h.from + delta, line: h.line + lineDelta });

  const doc = schema.nodes.doc.create(null, children);
  return { doc, map: buildSourceMap(doc, newBlocks, segments), headings };
}
