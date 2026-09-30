/**
 * The first lines of a document as a link preview shows them: the `description`, `og:description` and
 * `twitter:description` that Slack, Teams, iMessage and X read from `/d/<id>`, `/p/<id>` or the sign-in
 * page they are sent to (see `document-metadata.ts`). Whoever pastes the link may not be able to open
 * the document, so only text the reader page shows as prose may appear here.
 *
 * The text therefore comes from the parse the reader page renders (`readerMarkdown`: GFM plus YAML and
 * TOML front matter), never from a line scanner: front matter, HTML (comments, tags and their
 * attributes), code blocks, link and image URLs and titles, reference definitions and footnotes never
 * reach it, however they are spread over lines. Links keep their text and images their alt text.
 *
 * Some text the guard lets through takes the parser seconds even in a few kilobytes (deeply nested
 * lists or quotes), so this runs on the Markdown worker (`previewOffThread` in `export/render-pool.ts`),
 * never on the event loop. Like the worker's entry (`export/render-markdown.ts`), it must therefore stay
 * free of `@/` path aliases.
 */
import type { Nodes, PhrasingContent, Root } from "mdast";
import { splitGraphemes } from "unicode-segmenter/grapheme";
// The extensions are required: in development Node loads the worker straight from source.
import { findUnrenderable } from "../editor/markdown/renderable.ts";
import { readerMarkdown } from "./export/markdown-syntax.ts";

/** How much of a document is read: enough for a title, front matter and several paragraphs. */
export const PREVIEW_SOURCE_LIMIT = 4096;

const parser = readerMarkdown().freeze();

/** A first line that opens front matter; front matter must start the document, without indent. */
const FRONT_MATTER_OPEN = /^(?:---|\+\+\+)[ \t]*(?:\r\n?|\n)/;

/** A footnote call, `[^label]`: the reader page shows a number in its place once the label is defined. */
const FOOTNOTE_CALL = "[^";

/**
 * The document's first prose, at most `max` UTF-16 code units cut at a character boundary: paragraphs,
 * list items, quotes and table cells in order, headings only when there is nothing else (the title is
 * shown on its own). "" when there is no prose to show, or the guard refuses the text.
 *
 * A document longer than {@link PREVIEW_SOURCE_LIMIT} is parsed only up to its last line end within the
 * limit. Text past that cut can change two things before it: the blocks still open at the cut, and which
 * labels are defined. So front matter still open at the cut hides everything (""), the last block is
 * left out (a comment or code block still open at the cut runs to its end, so it is that block), and so
 * is every block a definition past the cut could change: one with a footnote call, or with a `]` that
 * closed no link here (`[label]`, which such a definition makes a link, and that can change how the rest
 * of the block parses). A definition on the last line read may be missing from the whole document (a
 * table past the cut can make that line its header row), so when one ends there the document is read
 * without that line. Each block that remains parses exactly as it does in the whole document.
 */
export function previewText(markdown: string, max = 160): string {
  // The parser skips a byte order mark and counts offsets after it; drop it so they match this string.
  const text = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const read = text.length > PREVIEW_SOURCE_LIMIT ? readCut(text) : readWhole(text);
  if (!read) return "";
  const prose: string[] = [];
  const headings: string[] = [];
  collect(read, prose, headings);
  return clip(joined(prose) || joined(headings), max);
}

interface Read {
  root: Root;
  /** The text parsed: the tree's offsets point into it. */
  source: string;
  /** Whether the document was cut short (see `previewText`). */
  cut: boolean;
  /** The block text past the cut could continue; null when nothing was cut off. */
  unsettled: Nodes | null;
}

function readWhole(text: string): Read | null {
  return findUnrenderable(text) ? null : { root: parser.parse(text), source: text, cut: false, unsettled: null };
}

function readCut(text: string): Read | null {
  const lineEnd = lastLineEnd(text, PREVIEW_SOURCE_LIMIT);
  // A first line longer than the limit is the last block, which is left out: nothing would remain.
  if (lineEnd === -1) return null;
  const read = readUpTo(text, lineEnd);
  // The line ending before the last line read (a `\r\n` is one line ending).
  const previous = lastLineEnd(text, text[lineEnd] === "\n" && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd);
  // A table past the cut can take over the last line as its header row (`| --- |` on the next line), so a
  // definition that ends on it may not exist in the whole document: read without that line instead.
  if (!read || !definesAfter(read.root, previous)) return read;
  return previous === -1 ? null : readUpTo(text, previous);
}

/** The document up to and including the line ending at `lineEnd`, parsed as a cut document. */
function readUpTo(text: string, lineEnd: number): Read | null {
  const kept = text.slice(0, lineEnd + 1);
  if (findUnrenderable(kept)) return null;
  const root = parser.parse(kept);
  // Front matter that closes past the cut parses here as a rule and paragraphs, which the reader hides.
  // mdast's types list `yaml` but not `toml`, which the parser also produces.
  const first: string | undefined = root.children[0]?.type;
  if (FRONT_MATTER_OPEN.test(kept) && first !== "yaml" && first !== "toml") return null;
  return { root, source: kept, cut: true, unsettled: lastBlock(root) };
}

/** The index of the last line ending character before `end`, or -1. */
function lastLineEnd(text: string, end: number): number {
  return end <= 0 ? -1 : Math.max(text.lastIndexOf("\n", end - 1), text.lastIndexOf("\r", end - 1));
}

/** Whether a definition, anywhere in the tree, ends after `offset`. */
function definesAfter(root: Root, offset: number): boolean {
  for (const node of walk(root.children, () => true)) {
    if (node.type === "definition" && (node.position?.end.offset ?? Infinity) > offset) return true;
  }
  return false;
}

/** The innermost last block: the only one that lines past the cut could continue. */
function lastBlock(root: Root): Nodes | null {
  let block: Nodes | null = null;
  let children: readonly Nodes[] = root.children;
  while (children.length > 0) {
    block = children[children.length - 1];
    if (block.type !== "blockquote" && block.type !== "list" && block.type !== "listItem") break;
    children = block.children;
  }
  return block;
}

/**
 * Whether a block's text is the text the reader page shows: always in a whole document. In a cut one, not
 * for the last block, nor for a block a definition past the cut could change (see `previewText`).
 */
function settled(node: Nodes, read: Read): boolean {
  if (!read.cut) return true;
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (node === read.unsettled || start === undefined || end === undefined) return false;
  return !read.source.slice(start, end).includes(FOOTNOTE_CALL) && !hasUnmatchedBracket(node);
}

/**
 * Whether a `]` was left as text: every `]` the parser reaches either closes a link or stays text, so a
 * block without one parses the same whatever is defined later. Also true for an escaped `\]`, which is fine.
 */
function hasUnmatchedBracket(block: Nodes): boolean {
  for (const node of walk([block], () => true)) {
    if (node.type === "text" && node.value.includes("]")) return true;
    if ((node.type === "image" || node.type === "imageReference") && node.alt?.includes("]")) return true;
  }
  return false;
}

/**
 * The nodes in document order, going into those `descend` accepts. A loop, not recursion: 4 KB of `>`
 * nests thousands of quotes, deeper than the call stack goes.
 */
function* walk(nodes: readonly Nodes[], descend: (node: Nodes) => boolean): Generator<Nodes> {
  const stack = [...nodes].reverse();
  for (let node = stack.pop(); node; node = stack.pop()) {
    yield node;
    if ("children" in node && descend(node)) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
}

const BLOCK_CONTAINERS: ReadonlySet<string> = new Set(["blockquote", "list", "listItem"]);
const INLINE_CONTAINERS: ReadonlySet<string> = new Set(["emphasis", "strong", "delete", "link", "linkReference"]);

function collect(read: Read, prose: string[], headings: string[]): void {
  for (const node of walk(read.root.children, (node) => BLOCK_CONTAINERS.has(node.type))) {
    switch (node.type) {
      case "paragraph":
        if (settled(node, read)) prose.push(inline(node.children));
        break;
      case "heading":
        if (settled(node, read)) headings.push(inline(node.children));
        break;
      case "table":
        if (settled(node, read)) for (const row of node.children) for (const cell of row.children) prose.push(inline(cell.children));
        break;
      // Front matter, HTML, code, rules, definitions and footnote definitions show no prose.
    }
  }
}

function inline(nodes: readonly PhrasingContent[]): string {
  let text = "";
  for (const node of walk(nodes, (node) => INLINE_CONTAINERS.has(node.type))) {
    switch (node.type) {
      case "text":
      case "inlineCode":
        text += node.value;
        break;
      case "break":
        text += " ";
        break;
      case "image":
      case "imageReference":
        // The alt keeps inline HTML verbatim (`![a <!-- note --> b](x.png)`), so an alt with a tag is left out.
        if (node.alt && !node.alt.includes("<")) text += node.alt;
        break;
      // Links and emphasis show their text; inline HTML (comments, tags and their attributes) and footnote markers show nothing.
    }
  }
  return text;
}

function joined(pieces: readonly string[]): string {
  return pieces
    .map((piece) => piece.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

/** At most `max` UTF-16 code units, cut between graphemes so no character is split. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = 0;
  for (const grapheme of splitGraphemes(text)) {
    if (end + grapheme.length > max) break;
    end += grapheme.length;
  }
  return text.slice(0, end).trim();
}
