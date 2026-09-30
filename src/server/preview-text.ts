/**
 * The first lines of a document as a link preview shows them: the `description`, `og:description` and
 * `twitter:description` that Slack, Teams, iMessage and X read from `/d/<id>`, `/p/<id>` or the sign-in
 * page they are sent to (see `document-metadata.ts`). Whoever pastes the link may not be able to open
 * the document, so only text the reader page shows may appear here.
 *
 * The text is therefore read from the page the reader builds (`readerHtml`: the same parse, the same
 * conversion to HTML and the same sanitizing), never from a line scanner or from the Markdown tree
 * alone, which holds text the page drops: front matter, HTML (comments, tags and their attributes), link
 * and image URLs and titles, reference definitions and table cells past the header's columns never reach
 * the page. Of the text that does, code blocks, footnotes and footnote numbers are left out too, and
 * headings are used only when there is no other prose. Links keep their text and images their alt text.
 *
 * Some text the guard lets through takes seconds to parse even in a few kilobytes, and nests deeper
 * than the main thread's call stack allows when turned into HTML (thousands of quotes), so this runs on
 * the Markdown worker (`previewOffThread` in `export/render-pool.ts`), never on the event loop. Like the
 * worker's entry (`export/render-markdown.ts`), it must therefore stay free of `@/` path aliases.
 */
import type { Nodes, Root } from "mdast";
import type { Element, ElementContent, Root as HastRoot, RootContent } from "hast";
import { splitGraphemes } from "unicode-segmenter/grapheme";
// The extensions are required: in development Node loads the worker straight from source.
import { findUnrenderable } from "../editor/markdown/renderable.ts";
import { readerHtml } from "./export/markdown-syntax.ts";

/** How much of a document is read: enough for a title, front matter and several paragraphs. */
export const PREVIEW_SOURCE_LIMIT = 4096;

const reader = readerHtml().freeze();

/** A first line that opens front matter; front matter must start the document, without indent. */
const FRONT_MATTER_OPEN = /^(?:---|\+\+\+)[ \t]*(?:\r\n?|\n)/;

/** A footnote call, `[^label]`: the reader page shows a number in its place once the label is defined. */
const FOOTNOTE_CALL = "[^";

/**
 * The document's first prose, at most `max` UTF-16 code units cut at a character boundary: the text of
 * paragraphs, list items, quotes and table cells in the order the reader page shows them, headings only
 * when there is nothing else (the title is shown on its own). "" when there is no prose to show, or the
 * guard refuses the document (the reader page then shows none of it either).
 *
 * A document longer than {@link PREVIEW_SOURCE_LIMIT} is parsed only up to its last line end within the
 * limit. Text past that cut can change two things before it: the blocks still open at the cut, and which
 * labels are defined. So front matter still open at the cut hides everything (""), the last block is
 * left out (a comment or code block still open at the cut runs to its end, so it is that block), and so
 * is every block a definition past the cut could change: one with a footnote call, or with a `]` that
 * closed no link here (`[label]`, which such a definition makes a link, and that can change how the rest
 * of the block parses). A definition on the last line read may be missing from the whole document (a
 * table past the cut can make that line its header row), so when one ends there the document is read
 * without that line. Each block that remains parses exactly as it does in the whole document; the page
 * is built from the tree once the others are taken out of it.
 */
export function previewText(markdown: string, max = 160): string {
  // As `renderMarkdownBody` does for the reader page. A cut can only lower the guard's counts, so the
  // part read below passes it too.
  if (findUnrenderable(markdown)) return "";
  // The parser skips a byte order mark and counts offsets after it; drop it so they match this string.
  const text = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const read = text.length > PREVIEW_SOURCE_LIMIT ? readCut(text) : { root: reader.parse(text), source: text, cut: false, unsettled: null };
  if (!read) return "";
  if (read.cut) prune(read);
  const prose: string[] = [];
  const headings: string[] = [];
  collect(reader.runSync(read.root), prose, headings);
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
  const root = reader.parse(kept);
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
  for (const node of walk(root.children)) {
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
  for (const node of walk([block])) {
    if (node.type === "text" && node.value.includes("]")) return true;
    if ((node.type === "image" || node.type === "imageReference") && node.alt?.includes("]")) return true;
  }
  return false;
}

/**
 * Every node under `nodes`, in document order. A loop, not recursion: 4 KB of `>` nests thousands of
 * quotes, deeper than the call stack goes.
 */
function* walk(nodes: readonly Nodes[]): Generator<Nodes> {
  const stack = [...nodes].reverse();
  for (let node = stack.pop(); node; node = stack.pop()) {
    yield node;
    if ("children" in node) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
}

/** The blocks that hold all the text a preview takes: a cut document loses those not settled. */
const PROSE_BLOCKS: ReadonlySet<string> = new Set(["paragraph", "heading", "table"]);
const BLOCK_CONTAINERS: ReadonlySet<string> = new Set(["blockquote", "list", "listItem"]);

/**
 * Takes the blocks whose text is not settled (see `settled`) out of a cut document's tree. Only the text
 * of paragraphs, headings and tables reaches a preview (footnotes, the other blocks with text, are left
 * out of it), and taking blocks out changes no other block's page: definitions stay, and whether a list
 * is loose was decided by the parser.
 */
function prune(read: Read): void {
  const parents: Nodes[] = [read.root];
  for (let parent = parents.pop(); parent; parent = parents.pop()) {
    if (!("children" in parent)) continue;
    const children: Nodes[] = parent.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const node = children[i];
      if (BLOCK_CONTAINERS.has(node.type)) parents.push(node);
      else if (PROSE_BLOCKS.has(node.type) && !settled(node, read)) children.splice(i, 1);
    }
  }
}

/** Elements whose text is one piece of prose. */
const PROSE: ReadonlySet<string> = new Set(["p", "td", "th"]);
const HEADINGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** Elements holding blocks. Code blocks, rules and the footnotes section are not among them. */
const CONTAINERS: ReadonlySet<string> = new Set(["blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr"]);
/** Inline elements whose text shows. */
const INLINE_CONTAINERS: ReadonlySet<string> = new Set(["a", "em", "strong", "del", "code"]);
/** Every inline element the page holds: a footnote number is a `sup`, a task's checkbox an `input`. */
const INLINE: ReadonlySet<string> = new Set([...INLINE_CONTAINERS, "br", "img", "input", "sup"]);

/** A block element, or a run of inline content that stands for a paragraph (see `blocksOf`). */
type Block = Element | ElementContent[];

/** The text of the page's paragraphs and table cells, and of its headings, in order. Anything unknown shows nothing. */
function collect(page: HastRoot, prose: string[], headings: string[]): void {
  const stack: Block[] = blocksOf(page.children, false).reverse();
  for (let block = stack.pop(); block; block = stack.pop()) {
    if (Array.isArray(block)) prose.push(inline(block));
    else if (PROSE.has(block.tagName)) prose.push(inline(block.children));
    else if (HEADINGS.has(block.tagName)) headings.push(inline(block.children));
    else if (CONTAINERS.has(block.tagName)) stack.push(...blocksOf(block.children, block.tagName === "li").reverse());
  }
}

/**
 * A container's blocks in order. In a tight list the page unwraps each item's paragraphs, so in an item
 * each run of inline content between its blocks is a paragraph; anywhere else, text between blocks is
 * only line breaks.
 */
function blocksOf(children: readonly (RootContent | ElementContent)[], listItem: boolean): Block[] {
  const blocks: Block[] = [];
  let run: ElementContent[] = [];
  for (const child of children) {
    if (child.type === "text" || (child.type === "element" && INLINE.has(child.tagName))) {
      if (listItem) run.push(child);
      continue;
    }
    if (run.length > 0) blocks.push(run);
    run = [];
    if (child.type === "element") blocks.push(child);
  }
  if (run.length > 0) blocks.push(run);
  return blocks;
}

/** The text inline content shows. A loop, not recursion, like the rest of the walk. */
function inline(nodes: readonly ElementContent[]): string {
  let text = "";
  const stack = [...nodes].reverse();
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.type === "text") {
      text += node.value;
    } else if (node.type === "element") {
      if (INLINE_CONTAINERS.has(node.tagName)) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
      else if (node.tagName === "br") text += " ";
      // An image shows its alt text in place of itself, apart from the words next to it.
      else if (node.tagName === "img") text += ` ${altOf(node)} `;
      // Footnote numbers, task checkboxes and anything unknown show nothing here.
    }
  }
  return text;
}

/** The alt keeps inline HTML verbatim (`![a <!-- note --> b](x.png)`), so an alt with a tag is left out. */
function altOf(img: Element): string {
  const alt = img.properties.alt;
  return typeof alt === "string" && !alt.includes("<") ? alt : "";
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
