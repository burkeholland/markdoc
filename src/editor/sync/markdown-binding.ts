import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";
import { parseMarkdown, type HeadingInfo, type ParseResult } from "../markdown/parse";
import { reparseRange, textChangeSpan } from "../markdown/incremental";
import { serializeBlocks } from "../markdown/serialize";
import { schema } from "../markdown/schema";
import type { BlockRange, SourceMap } from "../markdown/sourcemap";
import { diffOps, applyOps, type TextOp } from "./text-diff";

export const markdownBindingKey = new PluginKey<{ remote: boolean }>("markdownBinding");

/** Quiet time after the last incremental parse before it is verified against a full parse. */
const VERIFY_QUIET_MS = 1000;

/**
 * Hook that lets a layer (for example suggesting mode) take over the text
 * operations produced by a local rich-text edit. When it returns `true` it has
 * applied its own changes to the document (using `origin` for its Y
 * transactions) and the binding re-synchronizes the rich editor from the text.
 */
export type TextChangeInterceptor = (ops: TextOp[], ytext: Y.Text, origin: object) => boolean;

interface PhantomRecord {
  /** Relative position of the end of the real block that precedes the phantom, or null for document start. */
  after: Y.RelativePosition | null;
  /** Placeholder for an empty document; dropped as soon as real content exists. */
  placeholder?: boolean;
}

export interface MarkdownBindingOptions {
  /** Called after the binding has synchronized in either direction. */
  onSync?: (direction: "local" | "remote") => void;
  interceptor?: TextChangeInterceptor;
}

function isEmptyBlock(node: PMNode): boolean {
  return node.type === schema.nodes.paragraph && node.content.size === 0;
}

function blockStarts(doc: PMNode): number[] {
  const starts: number[] = [];
  let pos = 0;
  doc.forEach((child) => {
    starts.push(pos);
    pos += child.nodeSize;
  });
  return starts;
}

/** Index of the top-level block in which a change *starts* (boundary positions belong to the following block). */
function blockIndexAtStart(starts: number[], docSize: number, pos: number): number {
  if (pos >= docSize) return starts.length;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Index of the top-level block in which a change *ends* (boundary positions belong to the preceding block). */
function blockIndexAtEnd(starts: number[], pos: number): number {
  if (pos <= 0) return -1;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] < pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Minimal replacement transaction that turns `state.doc` into `newDoc`. */
export function minimalReplaceTransaction(state: EditorState, newDoc: PMNode): Transaction {
  const oldDoc = state.doc;
  const tr = state.tr;
  const start = oldDoc.content.findDiffStart(newDoc.content);
  const end = oldDoc.content.findDiffEnd(newDoc.content);
  if (start != null && end != null) {
    let { a: endA, b: endB } = end;
    const overlap = start - Math.min(endA, endB);
    if (overlap > 0) {
      endA += overlap;
      endB += overlap;
    }
    tr.replace(start, endA, newDoc.slice(start, endB));
  }
  return tr;
}

/**
 * Two-way binding between a ProseMirror document and a Y.Text that holds
 * Markdown source.
 *
 * The Y.Text is the single source of truth. Local ProseMirror edits are
 * serialized block by block and applied to the text as minimal diffs; text
 * changes from anywhere else (other users, the code editor, undo) are parsed
 * and applied to the ProseMirror document as a minimal replacement so the
 * selection survives.
 *
 * Empty paragraphs cannot be represented in Markdown. The binding keeps them
 * as local "phantom" blocks so the editing experience matches a normal rich
 * text editor.
 */
export class MarkdownBinding {
  view: EditorView | null = null;
  /** Source range of every top-level block of the current ProseMirror document. */
  blocks: BlockRange[] = [];
  private phantoms = new Map<number, PhantomRecord>();
  /** The ProseMirror document that locks describes. */
  private currentDoc: PMNode | null = null;
  private mapCache: { text: string; phantomKey: string; map: SourceMap } | null = null;
  private parseCache: { text: string; result: ParseResult } | null = null;
  private verifyHandle: { idle: number } | { timer: ReturnType<typeof setTimeout> } | null = null;
  private inLocalHandler = false;
  private pendingSync = false;
  /** True while a remote sync is being dispatched to the view. */
  syncing = false;
  private destroyed = false;

  constructor(
    public readonly ytext: Y.Text,
    private options: MarkdownBindingOptions = {},
  ) {
    this.ytext.observe(this.onTextChange);
  }

  get ydoc(): Y.Doc {
    const doc = this.ytext.doc;
    if (!doc) throw new Error("Y.Text is not attached to a document");
    return doc;
  }

  setInterceptor(interceptor: TextChangeInterceptor | undefined) {
    this.options = { ...this.options, interceptor };
  }

  destroy() {
    this.destroyed = true;
    this.cancelVerify();
    this.ytext.unobserve(this.onTextChange);
    this.view = null;
  }

  /** Build the initial ProseMirror document from the current text. */
  initialDoc(): PMNode {
    this.phantoms.clear();
    const built = this.buildDoc(this.ytext.toString());
    this.blocks = built.blocks;
    this.phantoms = built.phantoms;
    this.currentDoc = built.doc;
    this.mapCache = null;
    return built.doc;
  }

  attach(view: EditorView) {
    this.view = view;
    if (this.blocks.length === 0) {
      this.initialDoc();
      this.syncFromText();
    }
  }

  private parse(text: string): ParseResult {
    const cache = this.parseCache;
    if (cache && cache.text === text) return cache.result;
    let result: ParseResult | null = null;
    if (cache) {
      const span = textChangeSpan(cache.text, text);
      if (span) result = reparseRange(cache.result, cache.text, text, span);
    }
    if (result) this.scheduleVerify();
    else result = parseMarkdown(text);
    this.parseCache = { text, result };
    return result;
  }

  /**
   * Incremental parses are checked against a full parse once the user pauses. If the
   * two ever disagree the full result wins and the rich editor is re-synchronized.
   * The check is a trailing debounce: a full parse of a long document costs hundreds
   * of milliseconds, so it must never land between two keystrokes of a typing burst.
   */
  private scheduleVerify() {
    this.cancelVerify();
    const run = () => {
      this.verifyHandle = null;
      this.verifyParse();
    };
    const whenIdle = () => {
      if (typeof requestIdleCallback === "function") {
        this.verifyHandle = { idle: requestIdleCallback(run, { timeout: 3000 }) };
      } else {
        run();
      }
    };
    this.verifyHandle = { timer: setTimeout(whenIdle, VERIFY_QUIET_MS) };
  }

  private cancelVerify() {
    const handle = this.verifyHandle;
    this.verifyHandle = null;
    if (!handle) return;
    if ("idle" in handle) cancelIdleCallback(handle.idle);
    else clearTimeout(handle.timer);
  }

  verifyParse(): boolean {
    const cache = this.parseCache;
    if (!cache || this.destroyed) return true;
    const full = parseMarkdown(cache.text);
    const same =
      full.doc.eq(cache.result.doc) &&
      full.map.blocks.length === cache.result.map.blocks.length &&
      full.map.blocks.every((b, i) => b.from === cache.result.map.blocks[i].from && b.to === cache.result.map.blocks[i].to);
    this.parseCache = { text: cache.text, result: full };
    this.mapCache = null;
    if (same) return true;
    console.warn("[markdown-binding] incremental parse drifted from a full parse; resynchronizing");
    if (!this.inLocalHandler) this.syncFromText();
    return false;
  }

  private onTextChange = (_event: Y.YTextEvent, tr: Y.Transaction) => {
    if (this.destroyed || tr.origin === this) return;
    this.syncFromText();
  };

  /** Headings of the current text, from the (incrementally maintained) parse. */
  getHeadings(): HeadingInfo[] {
    return this.parse(this.ytext.toString()).headings;
  }

  /**
   * Source map for the current state. Positions account for phantom blocks so
   * they are valid for the live ProseMirror document.
   */
  getSourceMap(): SourceMap {
    const text = this.ytext.toString();
    const phantomKey = Array.from(this.phantoms.keys()).join(",");
    if (this.mapCache && this.mapCache.text === text && this.mapCache.phantomKey === phantomKey) {
      return this.mapCache.map;
    }
    const { map } = this.parse(text);
    const adjusted = this.phantoms.size === 0 ? { ...map, blocks: this.blocks } : this.adjustMapForPhantoms(map);
    this.mapCache = { text, phantomKey, map: adjusted };
    return adjusted;
  }

  private adjustMapForPhantoms(map: SourceMap): SourceMap {
    const doc = this.currentDoc ?? this.view?.state.doc;
    if (!doc) return map;
    const starts = blockStarts(doc);
    // Phantom paragraphs each occupy 2 positions in the live doc but nothing in the parsed doc.
    const phantomStarts = Array.from(this.phantoms.keys())
      .sort((a, b) => a - b)
      .map((i) => starts[i])
      .filter((s): s is number => s !== undefined);
    const toParsed = (pos: number) => {
      let shift = 0;
      for (const s of phantomStarts) {
        if (s + 2 <= pos) shift += 2;
        else if (s < pos) shift += pos - s;
        else break;
      }
      return pos - shift;
    };
    const fromParsed = (pos: number) => {
      let out = pos;
      for (const s of phantomStarts) {
        if (s <= out) out += 2;
        else break;
      }
      return out;
    };
    const blocks = this.blocks;
    return {
      blocks,
      segments: map.segments.map((seg) => ({ ...seg, pmFrom: fromParsed(seg.pmFrom), pmTo: fromParsed(seg.pmTo) })),
      srcToPm: (offset) => fromParsed(map.srcToPm(offset)),
      pmToSrc: (pos) => {
        const idx = Math.min(blockIndexAtStart(starts, doc.content.size, pos), blocks.length - 1);
        const block = blocks[idx];
        if (block?.phantom) return block.from;
        return map.pmToSrc(toParsed(pos));
      },
      blockIndexAt: (pos) => Math.min(blockIndexAtStart(starts, doc.content.size, pos), blocks.length - 1),
    };
  }

  /** Called by the plugin. Handles a state change produced by the user in the rich editor. */
  handleLocalTransaction(oldState: EditorState, newState: EditorState): boolean {
    if (this.destroyed) return false;
    this.inLocalHandler = true;
    try {
      return this.handleLocal(oldState, newState);
    } finally {
      this.inLocalHandler = false;
      if (this.pendingSync) {
        this.pendingSync = false;
        queueMicrotask(() => {
          if (!this.destroyed) this.syncFromText();
        });
      }
    }
  }

  private handleLocal(oldState: EditorState, newState: EditorState): boolean {
    const oldDoc = oldState.doc;
    const newDoc = newState.doc;
    if (oldDoc.eq(newDoc)) return false;

    const start = oldDoc.content.findDiffStart(newDoc.content);
    const end = oldDoc.content.findDiffEnd(newDoc.content);
    if (start == null || end == null) return false;
    let { a: endA, b: endB } = end;
    const overlap = start - Math.min(endA, endB);
    if (overlap > 0) {
      endA += overlap;
      endB += overlap;
    }

    const oldStarts = blockStarts(oldDoc);
    const N = oldDoc.childCount;
    const M = newDoc.childCount;
    if (this.blocks.length !== N) return this.fallbackReplaceAll(newDoc);
    const k = blockIndexAtStart(oldStarts, oldDoc.content.size, start);
    const endIdx = blockIndexAtEnd(oldStarts, endA);
    const t = N - 1 - Math.max(endIdx, k - 1);
    const oldTo = N - t;
    const newTo = M - t;
    if (k > oldTo || k > newTo || newTo < 0) return this.fallbackReplaceAll(newDoc);

    // Serialize the new blocks. Empty paragraphs become phantoms.
    const newBlocks: PMNode[] = [];
    for (let i = k; i < newTo; i++) newBlocks.push(newDoc.child(i));
    const chunks = newBlocks.map((node) => {
      if (isEmptyBlock(node)) return { text: "", phantom: true };
      const text = serializeBlocks([node]);
      return { text, phantom: text.trim() === "" };
    });
    const chunkText = chunks
      .filter((c) => !c.phantom)
      .map((c) => c.text)
      .join("\n\n");

    // Figure out the source range being replaced.
    const realOld = this.blocks.slice(k, oldTo).filter((b) => !b.phantom);
    let prevReal: BlockRange | null = null;
    let prevRealIdx = -1;
    for (let i = k - 1; i >= 0; i--) {
      if (!this.blocks[i].phantom) {
        prevReal = this.blocks[i];
        prevRealIdx = i;
        break;
      }
    }
    let nextReal: BlockRange | null = null;
    let nextRealIdx = -1;
    for (let i = oldTo; i < N; i++) {
      if (!this.blocks[i].phantom) {
        nextReal = this.blocks[i];
        nextRealIdx = i;
        break;
      }
    }

    let srcFrom: number;
    let srcTo: number;
    let newText: string;
    let chunkOffset = 0;
    if (realOld.length > 0) {
      srcFrom = realOld[0].from;
      srcTo = realOld[realOld.length - 1].to;
      newText = chunkText;
      if (!chunkText) {
        if (nextReal) srcTo = nextReal.from;
        else if (prevReal) srcFrom = prevReal.to;
        else {
          srcFrom = 0;
          srcTo = this.ytext.length;
        }
      }
    } else if (!chunkText) {
      srcFrom = srcTo = prevReal ? prevReal.to : 0;
      newText = "";
    } else if (prevReal) {
      srcFrom = srcTo = prevReal.to;
      newText = "\n\n" + chunkText;
      chunkOffset = 2;
    } else if (nextReal) {
      srcFrom = srcTo = nextReal.from;
      newText = chunkText + "\n\n";
    } else {
      srcFrom = 0;
      srcTo = this.ytext.length;
      newText = chunkText;
    }

    const fullText = this.ytext.toString();
    const delta = newText.length - (srcTo - srcFrom);

    // Verify that the new text, together with its neighbouring blocks, parses back into
    // exactly the blocks of the rich document. Neighbours matter because Markdown merges
    // adjacent constructs (two lists, for example).
    let chunkBlocks: BlockRange[] = [];
    if (chunkText) {
      const newFull = fullText.slice(0, srcFrom) + newText + fullText.slice(srcTo);
      const vFrom = prevReal ? prevReal.from : srcFrom;
      const vTo = nextReal ? nextReal.to + delta : srcFrom + newText.length;
      const parsed = parseMarkdown(newFull.slice(vFrom, vTo));
      const expected: PMNode[] = [];
      if (prevReal) expected.push(oldDoc.child(prevRealIdx));
      newBlocks.forEach((n, i) => {
        if (!chunks[i].phantom) expected.push(n);
      });
      if (nextReal) expected.push(oldDoc.child(nextRealIdx));
      if (parsed.doc.childCount !== expected.length || !expected.every((n, i) => parsed.doc.child(i).eq(n))) {
        return this.fallbackReplaceAll(newDoc);
      }
      const skip = prevReal ? 1 : 0;
      const realCount = expected.length - skip - (nextReal ? 1 : 0);
      chunkBlocks = parsed.map.blocks.slice(skip, skip + realCount).map((b) => ({
        from: b.from + vFrom - (srcFrom + chunkOffset),
        to: b.to + vFrom - (srcFrom + chunkOffset),
      }));
    }

    const oldText = fullText.slice(srcFrom, srcTo);
    const ops = diffOps(oldText, newText, srcFrom);
    if (ops.length > 0 && this.options.interceptor?.(ops, this.ytext, this)) {
      this.requestSync();
      this.options.onSync?.("local");
      return true;
    }
    if (ops.length > 0) this.ydoc.transact(() => applyOps(this.ytext, ops), this);

    // Update block ranges: [0,k) unchanged, new chunk ranges, [oldTo,N) shifted.
    const updated: BlockRange[] = [];
    const newPhantoms = new Map<number, PhantomRecord>();
    for (let i = 0; i < k; i++) {
      updated.push(this.blocks[i]);
      if (this.blocks[i].phantom) newPhantoms.set(i, this.phantoms.get(i) ?? { after: null });
    }
    const base = srcFrom + chunkOffset;
    let chunkIdx = 0;
    let phantomPos = prevReal ? prevReal.to : 0;
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].phantom) {
        newPhantoms.set(updated.length, {
          after: phantomPos > 0 ? Y.createRelativePositionFromTypeIndex(this.ytext, phantomPos, -1) : null,
        });
        updated.push({ from: phantomPos, to: phantomPos, phantom: true });
      } else {
        const range = chunkBlocks[chunkIdx++];
        updated.push({ from: base + range.from, to: base + range.to });
        phantomPos = base + range.to;
      }
    }
    for (let i = oldTo; i < N; i++) {
      const b = this.blocks[i];
      if (b.phantom) {
        newPhantoms.set(updated.length, this.phantoms.get(i) ?? { after: null });
        updated.push({ from: phantomPos, to: phantomPos, phantom: true });
      } else {
        updated.push({ from: b.from + delta, to: b.to + delta });
        phantomPos = b.to + delta;
      }
    }
    this.blocks = updated;
    this.phantoms = newPhantoms;
    this.currentDoc = newDoc;
    this.mapCache = null;

    if (process.env.NODE_ENV !== "production") this.assertConsistent(newDoc);
    this.options.onSync?.("local");
    return ops.length > 0;
  }

  private requestSync() {
    if (this.inLocalHandler) this.pendingSync = true;
    else this.syncFromText();
  }

  private fallbackReplaceAll(newDoc: PMNode): boolean {
    const blocks: PMNode[] = [];
    newDoc.forEach((child) => {
      if (!isEmptyBlock(child)) blocks.push(child);
    });
    const text = blocks
      .map((b) => serializeBlocks([b]))
      .filter((t) => t.trim() !== "")
      .join("\n\n");
    const ops = diffOps(this.ytext.toString(), text, 0);
    if (ops.length > 0 && !this.options.interceptor?.(ops, this.ytext, this)) {
      this.ydoc.transact(() => applyOps(this.ytext, ops), this);
    }
    this.phantoms.clear();
    this.requestSync();
    this.options.onSync?.("local");
    return ops.length > 0;
  }

  private buildDoc(text: string): { doc: PMNode; blocks: BlockRange[]; phantoms: Map<number, PhantomRecord> } {
    const { doc: parsed, map } = this.parse(text);
    const children: PMNode[] = [];
    const blocks: BlockRange[] = [];
    const phantoms = new Map<number, PhantomRecord>();
    const realCount = text.trim() === "" ? 0 : parsed.childCount;

    // Re-insert phantom paragraphs after the real block that preceded them.
    const startPhantoms: PhantomRecord[] = [];
    const targets: { offset: number; record: PhantomRecord }[] = [];
    for (const record of this.phantoms.values()) {
      if (record.placeholder && realCount > 0) continue;
      if (record.after === null) {
        startPhantoms.push(record);
        continue;
      }
      const abs = Y.createAbsolutePositionFromRelativePosition(record.after, this.ydoc);
      if (!abs || abs.type !== this.ytext) continue;
      targets.push({ offset: abs.index, record });
    }
    targets.sort((a, b) => a.offset - b.offset);

    const pushPhantom = (record: PhantomRecord, pos: number) => {
      phantoms.set(children.length, record);
      children.push(schema.nodes.paragraph.create());
      blocks.push({ from: pos, to: pos, phantom: true });
    };
    for (const record of startPhantoms) pushPhantom(record, 0);
    let pi = 0;
    for (let i = 0; i < realCount; i++) {
      const range = map.blocks[i];
      children.push(parsed.child(i));
      blocks.push({ from: range.from, to: range.to });
      const nextFrom = map.blocks[i + 1]?.from ?? Number.POSITIVE_INFINITY;
      while (pi < targets.length && targets[pi].offset < nextFrom) pushPhantom(targets[pi++].record, range.to);
    }
    while (pi < targets.length) pushPhantom(targets[pi++].record, text.length);
    if (children.length === 0) pushPhantom({ after: null, placeholder: true }, 0);

    return { doc: schema.nodes.doc.create(null, children), blocks, phantoms };
  }

  /** Re-parse the text and update the rich editor with a minimal replacement. */
  syncFromText() {
    if (this.destroyed) return;
    if (this.inLocalHandler) {
      this.pendingSync = true;
      return;
    }
    const view = this.view;
    const built = this.buildDoc(this.ytext.toString());
    this.blocks = built.blocks;
    this.phantoms = built.phantoms;
    this.currentDoc = built.doc;
    this.mapCache = null;

    if (view && !view.state.doc.eq(built.doc)) {
      const tr = minimalReplaceTransaction(view.state, built.doc);
      tr.setMeta(markdownBindingKey, { remote: true });
      tr.setMeta("addToHistory", false);
      this.syncing = true;
      try {
        view.dispatch(tr);
      } finally {
        this.syncing = false;
      }
    }
    this.options.onSync?.("remote");
  }

  private assertConsistent(doc: PMNode) {
    if (this.blocks.length !== doc.childCount) {
      console.warn("[markdown-binding] block count mismatch", this.blocks.length, doc.childCount);
    }
  }
}

/** ProseMirror plugin that drives a {@link MarkdownBinding}. */
export function markdownBindingPlugin(binding: MarkdownBinding): Plugin {
  return new Plugin({
    key: markdownBindingKey,
    state: {
      init: () => ({ remote: false }),
      apply: (tr, value) => {
        // Transactions appended by other plugins (e.g. table normalization) inherit the
        // remote flag of the transaction they were appended to.
        if (tr.getMeta(markdownBindingKey)) return { remote: true };
        if (tr.getMeta("appendedTransaction")) return value;
        return { remote: false };
      },
    },
    view(view) {
      binding.attach(view);
      return {
        update(view, prevState) {
          const meta = markdownBindingKey.getState(view.state);
          if (meta?.remote || binding.syncing) return;
          if (view.state.doc === prevState.doc) return;
          binding.handleLocalTransaction(prevState, view.state);
        },
        destroy() {
          binding.view = null;
        },
      };
    },
  });
}



