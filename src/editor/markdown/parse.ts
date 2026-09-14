import { Mark, type Node as PMNode } from "prosemirror-model";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import type * as Md from "mdast";
import { schema } from "./schema";
import { buildSourceMap, type BlockRange, type Segment, type SourceMap } from "./sourcemap";
import { findUnrenderableRanges, type UnrenderableRange } from "./renderable";

export interface HeadingInfo {
  level: number;
  text: string;
  /** Character offset of the heading in the Markdown source. */
  from: number;
  /** 1-based line number. */
  line: number;
  /** Slug-like id for anchors. */
  id: string;
}

export interface ParseResult {
  doc: PMNode;
  map: SourceMap;
  headings: HeadingInfo[];
  /** The mdast the document was built from, with absolute source positions; the linter reads it. */
  tree: Md.Root;
}

interface SrcRange {
  from: number;
  to: number;
}

type Position = NonNullable<Md.Node["position"]>;

function offsets(node: Md.Node): SrcRange {
  const pos = node.position as Position | undefined;
  return { from: pos?.start.offset ?? 0, to: pos?.end.offset ?? 0 };
}

function rawLength(node: Md.Node): number {
  if ("value" in node && typeof node.value === "string") return node.value.length;
  const children = (node as Md.Parent).children;
  return children ? children.reduce((n, c) => n + rawLength(c), 0) : 0;
}

/**
 * GFM autolink literals that the mdast transform (rather than the tokenizer) finds
 * are spliced into the tree without positions. Recover them from the neighbouring
 * siblings so the source map stays exact; `from`/`to` bound the parent's content.
 */
function ensurePositions(children: Md.Node[], from: number, to: number) {
  let i = 0;
  while (i < children.length) {
    if (children[i].position) {
      i++;
      continue;
    }
    let j = i;
    while (j < children.length && !children[j].position) j++;
    let cursor = i > 0 ? offsets(children[i - 1]).to : from;
    const bound = j < children.length ? offsets(children[j]).from : to;
    for (let k = i; k < j; k++) {
      const node = children[k];
      const end = k === j - 1 ? Math.max(cursor, bound) : Math.min(Math.max(cursor, bound), cursor + rawLength(node));
      node.position = { start: { line: 0, column: 0, offset: cursor }, end: { line: 0, column: 0, offset: end } };
      const nested = (node as Md.Parent).children;
      if (nested) ensurePositions(nested, cursor, end);
      cursor = end;
    }
    i = j;
  }
}

/**
 * Last line holding content of a block. mdast lets a list's range run on over the blank lines
 * that follow it, so for lists the last item's content decides.
 */
function contentEndLine(node: Md.Node): number {
  const children = (node as Md.Parent).children;
  if ((node.type === "list" || node.type === "listItem") && children?.length) return contentEndLine(children[children.length - 1]);
  return node.position?.end.line ?? 0;
}

/** Source range of a container's content, excluding its own delimiters. */
function contentBounds(src: string, node: Md.Node): SrcRange {
  const { from, to } = offsets(node);
  switch (node.type) {
    case "heading": {
      const m = /^ {0,3}#{1,6}[ \t]+/.exec(src.slice(from, to));
      return m ? { from: from + m[0].length, to } : { from, to };
    }
    case "emphasis":
      return { from: from + 1, to: Math.max(from + 1, to - 1) };
    case "strong":
      return { from: from + 2, to: Math.max(from + 2, to - 2) };
    case "delete": {
      const n = src.startsWith("~~", from) ? 2 : 1;
      return { from: from + n, to: Math.max(from + n, to - n) };
    }
    case "link": {
      if (src[from] === "<") return { from: from + 1, to: Math.max(from + 1, to - 1) };
      if (src[from] !== "[") return { from, to };
      const close = src.lastIndexOf("](", to);
      return { from: from + 1, to: close > from ? close : to };
    }
    default:
      return { from, to };
  }
}

const isBr = (node: Md.Node) => node.type === "html" && /^<br\s*\/?>$/i.test((node as Md.Html).value);

/**
 * A `<br>` that only has other `<br>`s after it and some content before it ends its block: it is
 * the hard break `serialize.ts` writes for a break at the end of a paragraph (the `\` form would
 * be a literal backslash there). A block of nothing but `<br>` is an HTML block, never inline.
 */
function isTrailingBreak(siblings: Md.Node[], index: number): boolean {
  for (let i = index + 1; i < siblings.length; i++) if (!isBr(siblings[i])) return false;
  for (let i = 0; i < index; i++) if (!isBr(siblings[i])) return true;
  return false;
}

/**
 * Accumulates inline nodes while merging adjacent text nodes that carry the
 * same marks. Merging ourselves (instead of letting ProseMirror do it) keeps the
 * source-offset bookkeeping exact for every text leaf in the resulting doc.
 */
class InlineBuilder {
  nodes: PMNode[] = [];
  constructor(private leafInfo: WeakMap<PMNode, SrcRange>) {}

  text(value: string, marks: readonly Mark[], range: SrcRange) {
    if (!value) return;
    const last = this.nodes[this.nodes.length - 1];
    if (last && last.isText && Mark.sameSet(last.marks, marks)) {
      const prev = this.leafInfo.get(last);
      const merged = schema.text(last.text! + value, marks);
      this.nodes[this.nodes.length - 1] = merged;
      this.leafInfo.set(merged, { from: prev ? prev.from : range.from, to: range.to });
      return;
    }
    const node = schema.text(value, marks);
    this.leafInfo.set(node, range);
    this.nodes.push(node);
  }

  leaf(node: PMNode, range: SrcRange) {
    this.leafInfo.set(node, range);
    this.nodes.push(node);
  }
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

class Converter {
  leafInfo = new WeakMap<PMNode, SrcRange>();
  definitions = new Map<string, Md.Definition>();
  headings: HeadingInfo[] = [];
  private lineStarts: number[] | null = null;
  private inTableCell = false;

  constructor(
    private src: string,
    /** Paragraphs the guard refused (see `renderable.ts`); blocks overlapping them become placeholders. */
    private unrenderable: readonly UnrenderableRange[] = [],
  ) {}

  private isUnrenderable(node: Md.RootContent): boolean {
    if (this.unrenderable.length === 0) return false;
    const { from, to } = offsets(node);
    return this.unrenderable.some((r) => r.from < to && from < r.to);
  }

  lineAt(offset: number): number {
    if (!this.lineStarts) {
      const starts = [0];
      for (let i = 0; i < this.src.length; i++) if (this.src.charCodeAt(i) === 10) starts.push(i + 1);
      this.lineStarts = starts;
    }
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  collectDefinitions(node: Md.Node) {
    if (node.type === "definition") {
      const def = node as Md.Definition;
      if (!this.definitions.has(def.identifier)) this.definitions.set(def.identifier, def);
    }
    const children = (node as Md.Parent).children;
    if (children) for (const child of children) this.collectDefinitions(child);
  }

  root(root: Md.Root): { doc: PMNode; blocks: BlockRange[] } {
    this.collectDefinitions(root);
    const children: PMNode[] = [];
    const blocks: BlockRange[] = [];
    for (let i = 0; i < root.children.length; i++) {
      const child = root.children[i];
      if (this.isUnrenderable(child)) {
        // The parser saw neutralized text here (see parseMarkdown); the placeholder carries the
        // real source so it serializes back unchanged, and the tree keeps it as raw html so the
        // linter does not read the neutralized paragraph.
        const { from, to } = offsets(child);
        const raw = this.src.slice(from, to);
        children.push(schema.nodes.unrenderable.create({ src: raw }));
        blocks.push({ from, to });
        root.children[i] = { type: "html", value: raw, position: child.position };
        continue;
      }
      const node = this.block(child, true);
      if (!node) continue;
      children.push(node);
      blocks.push(this.blockRange(child));
    }
    if (children.length === 0) {
      children.push(schema.nodes.paragraph.create());
      blocks.push({ from: 0, to: this.src.length });
    }
    return { doc: schema.nodes.doc.create(null, children), blocks };
  }

  /**
   * Source range of a top-level block. mdast starts a paragraph at its first non-blank character,
   * but `inlineContent` puts the 1–3 spaces of indentation before it back into the node, so the
   * range has to start at the line start too: the binding diffs the serialized node (which has
   * the spaces) against the text in this range, and a range that misses them doubles the
   * indentation on the next keystroke and forces a full re-serialization of the document.
   */
  private blockRange(node: Md.RootContent): SrcRange {
    const range = offsets(node);
    if (node.type !== "paragraph" || node.children.length === 0) return range;
    const start = this.leadingGapStart(offsets(node.children[0]).from);
    return start === null ? range : { from: start, to: range.to };
  }

  /** Start of the line when `first` is preceded on its line only by 1–3 spaces or tabs (paragraph indentation), else null. */
  private leadingGapStart(first: number): number | null {
    const lineStart = this.src.lastIndexOf("\n", first - 1) + 1;
    return /^[ \t]{1,3}$/.test(this.src.slice(lineStart, first)) ? lineStart : null;
  }

  blocks(children: Md.Node[]): PMNode[] {
    const out: PMNode[] = [];
    for (const child of children) {
      const node = this.block(child as Md.RootContent, false);
      if (node) out.push(node);
    }
    return out;
  }

  block(node: Md.RootContent, topLevel: boolean): PMNode | null {
    switch (node.type) {
      case "paragraph":
        return schema.nodes.paragraph.create(null, this.inlineContent(node, topLevel));
      case "heading": {
        const content = this.inlineContent(node, false);
        const text = content.map((n) => n.textContent).join("");
        const { from } = offsets(node);
        this.headings.push({ level: node.depth, text, from, line: this.lineAt(from), id: slugify(text) });
        return schema.nodes.heading.create({ level: node.depth }, content);
      }
      case "thematicBreak":
        return schema.nodes.horizontal_rule.create();
      case "blockquote": {
        const content = this.quoteContent(node);
        return schema.nodes.blockquote.create(null, content.length ? content : [schema.nodes.paragraph.create()]);
      }
      case "list":
        return this.list(node);
      case "code": {
        const { from, to } = offsets(node);
        const text = node.value ?? "";
        const content = text ? [this.codeText(text, from, to)] : [];
        return schema.nodes.code_block.create({ language: node.lang ?? null, meta: node.meta ?? null }, content);
      }
      case "html": {
        const { from, to } = offsets(node);
        const textNode = schema.text(node.value);
        this.leafInfo.set(textNode, { from, to });
        return schema.nodes.html_block.create(null, node.value ? [textNode] : []);
      }
      case "yaml": {
        const { from, to } = offsets(node);
        const text = node.value ?? "";
        const content = text ? [this.codeText(text, from, to)] : [];
        return schema.nodes.frontmatter.create(null, content);
      }
      case "definition":
        return schema.nodes.link_definition.create({
          label: node.label ?? node.identifier,
          url: node.url,
          title: node.title ?? null,
        });
      case "footnoteDefinition": {
        const content = this.blocks(node.children);
        return schema.nodes.footnote_definition.create(
          { label: node.label ?? node.identifier },
          content.length ? content : [schema.nodes.paragraph.create()],
        );
      }
      case "table":
        return this.table(node);
      default: {
        // Unknown construct: keep its raw source as a paragraph so nothing is lost.
        const { from, to } = offsets(node);
        const raw = this.src.slice(from, to);
        const b = new InlineBuilder(this.leafInfo);
        b.text(raw, [], { from, to });
        return schema.nodes.paragraph.create(null, b.nodes);
      }
    }
  }

  /** Text node for fenced/indented code, mapping source offsets to the content after the opening fence. */
  private codeText(text: string, from: number, to: number): PMNode {
    const textNode = schema.text(text);
    const firstNewline = this.src.indexOf("\n", from);
    const contentStart = firstNewline === -1 || firstNewline >= to ? from : firstNewline + 1;
    this.leafInfo.set(textNode, { from: contentStart, to: Math.min(to, contentStart + text.length) });
    return textNode;
  }

  private list(node: Md.List): PMNode {
    const { from } = offsets(node);
    const items = node.children.map((item) => this.listItem(item));
    const tight = !node.spread && !node.children.some((item) => item.spread);
    if (node.ordered) {
      // Find the delimiter character that follows the digits of the first marker.
      let i = from;
      while (i < this.src.length && /\d/.test(this.src[i])) i++;
      const delimiter = this.src[i] === ")" ? ")" : ".";
      return schema.nodes.ordered_list.create({ start: node.start ?? 1, tight, delimiter }, items);
    }
    const bullet = ["-", "*", "+"].includes(this.src[from]) ? this.src[from] : "-";
    return schema.nodes.bullet_list.create({ bullet, tight }, items);
  }

  private listItem(item: Md.ListItem): PMNode {
    let checked: boolean | null = item.checked ?? null;
    const children = [...item.children];
    // GFM only recognizes a task marker when text follows it, so an item the user just
    // created (`- [ ] `) parses as literal "[ ]". Treat it as an empty task instead.
    if (checked === null && children[0]?.type === "paragraph") {
      const para = children[0] as Md.Paragraph;
      const text = para.children.length === 1 && para.children[0].type === "text" ? (para.children[0] as Md.Text).value : null;
      const m = text !== null ? /^\[( |x|X)\]\s*$/.exec(text) : null;
      if (m) {
        checked = m[1].toLowerCase() === "x";
        children.shift();
      }
    }
    const content = this.blocks(children);
    if (content.length === 0 || content[0].type !== schema.nodes.paragraph) {
      content.unshift(schema.nodes.paragraph.create());
    }
    return schema.nodes.list_item.create({ checked }, content);
  }

  /**
   * Children of a blockquote. Markdown has no empty paragraph, so the serializer writes one as a
   * marker-only `>` line beyond the single blank line that separates (or pads) blocks; every such
   * extra line becomes an empty paragraph here. One `>` line alone (the code pane's `> ` after
   * Enter, or a hand-written trailing marker) still means nothing, as before.
   */
  private quoteContent(node: Md.Blockquote): PMNode[] {
    const pos = node.position;
    if (!pos) return this.blocks(node.children);
    const out: PMNode[] = [];
    const empties = (lines: number) => {
      for (let i = 1; i < lines; i++) out.push(schema.nodes.paragraph.create());
    };
    let prevEnd = pos.start.line - 1;
    for (const child of node.children) {
      if (child.position) {
        empties(child.position.start.line - prevEnd - 1);
        prevEnd = contentEndLine(child);
      }
      const block = this.block(child, false);
      if (block) out.push(block);
    }
    empties(pos.end.line - prevEnd);
    return out;
  }

  private table(node: Md.Table): PMNode {
    const align = node.align ?? [];
    const cols = node.children[0]?.children.length ?? 0;
    this.inTableCell = true;
    const rows = node.children.map((row, rowIndex) => {
      const cells = row.children.map((cell, colIndex) => {
        const type = rowIndex === 0 ? schema.nodes.table_header : schema.nodes.table_cell;
        return type.create({ align: align[colIndex] ?? null }, this.inlineContent(cell, false));
      });
      // Pad short rows so every row has the header's column count (prosemirror-tables
      // would otherwise normalize the table itself and desynchronize the surfaces).
      while (cells.length < cols) {
        const type = rowIndex === 0 ? schema.nodes.table_header : schema.nodes.table_cell;
        cells.push(type.create({ align: align[cells.length] ?? null }));
      }
      return schema.nodes.table_row.create(null, cells);
    });
    this.inTableCell = false;
    return schema.nodes.table.create(null, rows);
  }

  /**
   * Convert the phrasing children of a block. For paragraphs and headings we
   * also restore whitespace that Markdown parsing drops at the block edges so
   * that typing a trailing space in the rich editor round-trips cleanly.
   */
  private inlineContent(parent: Md.Paragraph | Md.Heading | Md.TableCell, topLevelParagraph: boolean): PMNode[] {
    const b = new InlineBuilder(this.leafInfo);
    const children = parent.children;
    const bounds = contentBounds(this.src, parent);
    ensurePositions(children, bounds.from, bounds.to);
    if (parent.type === "paragraph" && topLevelParagraph && children.length) {
      const first = offsets(children[0]).from;
      const lineStart = this.leadingGapStart(first);
      if (lineStart !== null) b.text(this.src.slice(lineStart, first), [], { from: lineStart, to: first });
    }
    for (let i = 0; i < children.length; i++) this.inline(children[i], [], b, children, i);
    if ((parent.type === "paragraph" || parent.type === "heading") && children.length) {
      const last = offsets(children[children.length - 1]).to;
      let lineEnd = this.src.indexOf("\n", last);
      if (lineEnd === -1) lineEnd = this.src.length;
      const gap = this.src.slice(last, lineEnd);
      if (/^[ \t]+$/.test(gap)) b.text(gap, [], { from: last, to: lineEnd });
    }
    return b.nodes;
  }

  /**
   * `siblings`/`index` are given for the direct children of a block so that a `<br>` ending the
   * block can be recognised (see `isTrailingBreak`).
   */
  private inline(node: Md.PhrasingContent | Md.Node, marks: readonly Mark[], b: InlineBuilder, siblings?: Md.Node[], index = 0) {
    const range = offsets(node);
    switch (node.type) {
      case "text":
        b.text((node as Md.Text).value.replace(/\n/g, " "), marks, range);
        return;
      case "emphasis":
        this.inlineChildren(node as Md.Emphasis, schema.marks.em.create().addToSet(marks), b);
        return;
      case "strong":
        this.inlineChildren(node as Md.Strong, schema.marks.strong.create().addToSet(marks), b);
        return;
      case "delete":
        this.inlineChildren(node as Md.Delete, schema.marks.strikethrough.create().addToSet(marks), b);
        return;
      case "inlineCode": {
        const raw = this.src.slice(range.from, range.to);
        const ticks = /^`+/.exec(raw)?.[0].length ?? 1;
        const inner = raw.slice(ticks, raw.length - ticks);
        const stripped = inner.length > 1 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "" ? 1 : 0;
        const from = range.from + ticks + stripped;
        b.text((node as Md.InlineCode).value, schema.marks.code.create().addToSet(marks), {
          from,
          to: Math.max(from, range.to - ticks - stripped),
        });
        return;
      }
      case "break":
        b.leaf(schema.nodes.hard_break.create(), range);
        return;
      case "link": {
        const link = node as Md.Link;
        const mark = schema.marks.link.create({ href: link.url, title: link.title ?? null });
        this.inlineChildren(link, mark.addToSet(marks), b);
        return;
      }
      case "image": {
        const img = node as Md.Image;
        b.leaf(schema.nodes.image.create({ src: img.url, alt: img.alt ?? null, title: img.title ?? null }, null, marks), range);
        return;
      }
      case "linkReference": {
        const ref = node as Md.LinkReference;
        const def = this.definitions.get(ref.identifier);
        if (def) {
          const mark = schema.marks.link.create({ href: def.url, title: def.title ?? null });
          this.inlineChildren(ref, mark.addToSet(marks), b);
        } else {
          b.text("[", marks, { from: range.from, to: range.from + 1 });
          this.inlineChildren(ref, marks, b);
          const suffix =
            ref.referenceType === "full" ? `][${ref.label ?? ref.identifier}]` : ref.referenceType === "collapsed" ? "][]" : "]";
          b.text(suffix, marks, { from: range.to - suffix.length, to: range.to });
        }
        return;
      }
      case "imageReference": {
        const ref = node as Md.ImageReference;
        const def = this.definitions.get(ref.identifier);
        if (def) {
          b.leaf(schema.nodes.image.create({ src: def.url, alt: ref.alt ?? null, title: def.title ?? null }, null, marks), range);
        } else {
          b.text(this.src.slice(range.from, range.to), marks, range);
        }
        return;
      }
      case "footnoteReference": {
        const ref = node as Md.FootnoteReference;
        b.leaf(schema.nodes.footnote_reference.create({ label: ref.label ?? ref.identifier }), range);
        return;
      }
      case "html":
        // `<br>` is how a table cell spells a line break, and how any block spells a break at its
        // end (CommonMark has no trailing hard break); the serializer writes both back the same way.
        if (isBr(node) && (this.inTableCell || (siblings && isTrailingBreak(siblings, index)))) {
          b.leaf(schema.nodes.hard_break.create(), range);
          return;
        }
        b.leaf(schema.nodes.html_inline.create({ html: (node as Md.Html).value }), range);
        return;
      default:
        b.text(this.src.slice(range.from, range.to), marks, range);
    }
  }

  private inlineChildren(parent: Md.Parent, marks: readonly Mark[], b: InlineBuilder) {
    const bounds = contentBounds(this.src, parent);
    ensurePositions(parent.children, bounds.from, bounds.to);
    for (const child of parent.children) this.inline(child, marks, b);
  }
}

/** Opening `---` on the first line and a closing `---` line somewhere after it. */
const CLOSED_FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * True when the text starts with complete YAML front matter. The frontmatter
 * extension is only enabled in that case: when a document starts with a `---`
 * that is never closed (a thematic break), the extension's failed attempt
 * breaks list parsing for the rest of the document.
 */
export function hasFrontmatter(src: string): boolean {
  return src.startsWith("---") && CLOSED_FRONTMATTER.test(src);
}

export function parseMdast(src: string): Md.Root {
  if (hasFrontmatter(src)) {
    return fromMarkdown(src, {
      extensions: [gfm(), frontmatter(["yaml"])],
      mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(["yaml"])],
    });
  }
  return fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/**
 * Copy of `src` with every unrenderable paragraph replaced by a same-length run of a harmless
 * letter (line breaks kept), so micromark parses a plain paragraph in linear time and every
 * offset in the result still points into the real text.
 */
function neutralize(src: string, ranges: readonly UnrenderableRange[]): string {
  let out = "";
  let pos = 0;
  for (const r of ranges) {
    out += src.slice(pos, r.from) + src.slice(r.from, r.to).replace(/[^\n\r]/g, "x");
    pos = r.to;
  }
  return out + src.slice(pos);
}

/**
 * Parse Markdown into a ProseMirror document plus a source map that relates
 * document positions to character offsets in the Markdown text.
 *
 * Paragraphs that micromark would parse in quadratic time (see `renderable.ts`) are never
 * handed to it: they come back as `unrenderable` placeholder blocks holding their source.
 */
export function parseMarkdown(src: string): ParseResult {
  const unrenderable = findUnrenderableRanges(src);
  const tree = parseMdast(unrenderable.length > 0 ? neutralize(src, unrenderable) : src);
  const converter = new Converter(src, unrenderable);
  const { doc, blocks } = converter.root(tree);
  const segments: Segment[] = [];
  doc.descendants((node, pos) => {
    if (node.isText || (node.isInline && node.isLeaf)) {
      const info = converter.leafInfo.get(node);
      if (info) segments.push({ pmFrom: pos, pmTo: pos + node.nodeSize, srcFrom: info.from, srcTo: info.to });
      return false;
    }
    return true;
  });
  return { doc, map: buildSourceMap(doc, blocks, segments), headings: converter.headings, tree };
}

/** Extract headings only (cheap; used for the outline of the code editor). */
export function extractHeadings(src: string): HeadingInfo[] {
  return parseMarkdown(src).headings;
}
