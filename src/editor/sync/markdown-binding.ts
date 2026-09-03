import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import type * as Md from "mdast";
import * as Y from "yjs";
import { parseMarkdown, type HeadingInfo, type ParseResult } from "../markdown/parse";
import { reparseRange, textChangeSpan, type ChangeSpan } from "../markdown/incremental";
import { serializeBlocks } from "../markdown/serialize";
import { schema } from "../markdown/schema";
import type { BlockRange, Segment, SourceMap } from "../markdown/sourcemap";
import { diffOps, applyOps, type TextOp } from "./text-diff";
import { perfMark } from "../collab/shared";

export interface LocalDocChange {
  before: PMNode;
  after: PMNode;
  mapping: Transaction["mapping"];
  start: number;
  endA: number;
  endB: number;
}

interface MarkdownBindingState {
  remote: boolean;
  localChange: LocalDocChange | null;
}

export const markdownBindingKey = new PluginKey<MarkdownBindingState>("markdownBinding");

/** Quiet time after the last incremental parse before it is verified against a full parse. */
const VERIFY_QUIET_MS = 1000;
/** Consecutive matching verifications after which routine (non-structural) edits are no longer verified. */
export const VERIFY_TRUST_AFTER = 3;
/** Once trusted, one in this many routine idle windows still gets a full verification. */
export const VERIFY_EVERY_NTH_WINDOW = 25;
/** Quiet time after a held remote change's parse before the coalesced rebuild runs without waiting for `synced`. */
export const HOLD_QUIET_MS = 50;
/** Longest the held text waits for an idle period before it is parsed anyway. */
export const HELD_PARSE_TIMEOUT_MS = 1000;
const NO_HEADINGS: HeadingInfo[] = [];
/**
 * An edit is structural when a changed line could alter block structure or references beyond
 * the edited block: brackets (references, footnotes, definitions), tables, a newline (a block
 * boundary moved), or a line that starts a heading, fence, HTML block, setext underline,
 * list item, blockquote, thematic break or indented code.
 */
const STRUCTURAL =
  /[[\]|\n]|^[ \t]{0,3}(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|<|=+[ \t]*$|(?:[-*+>]|\d{1,9}[.)])(?:[ \t]|$)|([-*_])(?:[ \t]*\1){2,}[ \t]*$)|^(?: {4}|\t)/m;

/** The lines of `text` that contain the range `[from, to]`. */
function linesAround(text: string, from: number, to: number): string {
  const start = text.lastIndexOf("\n", from - 1) + 1;
  const endNl = text.indexOf("\n", to);
  return text.slice(start, endNl === -1 ? text.length : endNl);
}

/** True when the change between `oldText` and `newText` touches a line with structural Markdown. */
export function isStructuralChange(oldText: string, newText: string, span: ChangeSpan): boolean {
  return STRUCTURAL.test(linesAround(newText, span.from, span.newTo)) || STRUCTURAL.test(linesAround(oldText, span.from, span.oldTo));
}

export interface VerifyStats {
  /** Full-parse verifications that ran. */
  runs: number;
  /** Verifications whose result matched the incremental parse. */
  matches: number;
  /** Verifications that found drift and re-synchronized the editor. */
  mismatches: number;
  /** Idle windows where the verification was skipped because the incremental parser is trusted. */
  skipped: number;
}

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

function containsHardBreak(node: PMNode | null | undefined): boolean {
  return node?.content.content.some((child) => child.type === schema.nodes.hard_break) ?? false;
}

function containsLineEnding(text: string): boolean {
  return text.includes("\n") || text.includes("\r");
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

/** The changed range when one transaction map describes the complete old-to-new document change. */
export function localDocChange(tr: Transaction, before: PMNode, after: PMNode): LocalDocChange | null {
  if (!tr.docChanged || tr.mapping.maps.length !== 1) return null;
  let start = Number.POSITIVE_INFINITY;
  let endA = -1;
  let endB = -1;
  tr.mapping.maps[0].forEach((oldStart, oldEnd, _newStart, newEnd) => {
    start = Math.min(start, oldStart);
    endA = Math.max(endA, oldEnd);
    endB = Math.max(endB, newEnd);
  });
  return Number.isFinite(start) ? { before, after, mapping: tr.mapping, start, endA, endB } : null;
}

/** Top-level block containing a change start; a boundary belongs to the following block. */
function blockIndexAtResolvedStart(doc: PMNode, pos: number): number {
  if (pos >= doc.content.size) return doc.childCount;
  return doc.resolve(Math.max(0, pos)).index(0);
}

/** Top-level block containing a change end; a boundary belongs to the preceding block. */
function blockIndexAtResolvedEnd(doc: PMNode, pos: number): number {
  if (pos <= 0) return -1;
  const $pos = doc.resolve(Math.min(doc.content.size, pos));
  return $pos.depth === 0 ? $pos.index(0) - 1 : $pos.index(0);
}

interface SourceChange {
  oldFrom: number;
  oldTo: number;
  newTo: number;
}

/** Whether the edited PM and Markdown spans are unmarked and map one-to-one at both boundaries. */
function hasLinearUnmarkedMapping(old: SourceMap, oldDoc: PMNode, newDoc: PMNode, change: LocalDocChange, source: SourceChange): boolean {
  if (
    old.srcToPm(source.oldFrom) !== change.start ||
    old.srcToPm(source.oldTo) !== change.endA ||
    old.pmToSrc(change.start) !== source.oldFrom ||
    old.pmToSrc(change.endA) !== source.oldTo
  ) {
    return false;
  }
  let unmarked = true;
  if (change.endA > change.start) {
    oldDoc.nodesBetween(change.start, change.endA, (node) => {
      if (node.isText && node.marks.length > 0) unmarked = false;
    });
  }
  if (change.endB > change.start) {
    newDoc.nodesBetween(change.start, change.endB, (node) => {
      if (node.isText && node.marks.length > 0) unmarked = false;
    });
  }
  return unmarked;
}

/**
 * Carry an already-current source map through a simple text replacement. The changed source and
 * ProseMirror spans have equal lengths here, so positions inside the edit map directly; positions
 * outside it go through the transaction mapping and the previous map. Segments are materialized
 * only for diagnostics -- editor position lookups use the bounded mapping functions.
 */
function mapSourceMap(old: SourceMap, blocks: BlockRange[], doc: PMNode, change: LocalDocChange, source: SourceChange): SourceMap {
  const inverse = change.mapping.invert();
  const sourceDelta = source.newTo - source.oldTo;
  const sourceNewLength = source.newTo - source.oldFrom;
  const pmNewLength = change.endB - change.start;
  let segments: Segment[] | null = null;
  const sourceAfter = (offset: number, assoc: -1 | 1): number => {
    if (offset < source.oldFrom || (offset === source.oldFrom && assoc < 0)) return offset;
    if (offset > source.oldTo || (offset === source.oldTo && assoc > 0)) return offset + sourceDelta;
    return assoc < 0 ? source.oldFrom : source.newTo;
  };
  const sourceBefore = (offset: number, assoc: -1 | 1): number => {
    if (offset < source.oldFrom || (offset === source.oldFrom && assoc < 0)) return offset;
    if (offset > source.newTo || (offset === source.newTo && assoc > 0)) return offset - sourceDelta;
    return assoc < 0 ? source.oldFrom : source.oldTo;
  };
  return {
    blocks,
    get segments() {
      segments ??= old.segments.map((segment) => ({
        pmFrom: change.mapping.map(segment.pmFrom, -1),
        pmTo: change.mapping.map(segment.pmTo, 1),
        srcFrom: sourceAfter(segment.srcFrom, -1),
        srcTo: sourceAfter(segment.srcTo, 1),
      }));
      return segments;
    },
    srcToPm(offset) {
      if (offset >= source.oldFrom && offset <= source.newTo) {
        return change.start + Math.min(pmNewLength, Math.max(0, offset - source.oldFrom));
      }
      return change.mapping.map(old.srcToPm(sourceBefore(offset, offset < source.oldFrom ? -1 : 1)), offset < source.oldFrom ? -1 : 1);
    },
    pmToSrc(pos) {
      if (pos >= change.start && pos <= change.endB) {
        return source.oldFrom + Math.min(sourceNewLength, Math.max(0, pos - change.start));
      }
      const before = inverse.map(pos, pos < change.start ? -1 : 1);
      return sourceAfter(old.pmToSrc(before), pos < change.start ? -1 : 1);
    },
    blockIndexAt(pos) {
      if (pos >= doc.content.size) return Math.max(0, doc.childCount - 1);
      return doc.resolve(Math.max(0, pos)).index(0);
    },
  };
}

/**
 * Minimal replacement transaction that turns `state.doc` into `newDoc`.
 *
 * The diff range is replaced with the corresponding slice of `newDoc`. `tr.replace` *fits* an open
 * slice into the surrounding structure, and fitting is not guaranteed to reproduce `newDoc`: when
 * the diff starts inside one table cell and ends inside another row (a column removed by undo, for
 * example) the fitter keeps the header's cells and drops body cells, and prosemirror-tables'
 * `fixTables` then pads the rows back out — the rich pane shows a 4×3 table while the text says
 * 4×2 (task #459). When the fitted result differs from `newDoc`, the whole top-level blocks that
 * contain the diff are replaced instead (a closed slice is never fitted), so the result is exact
 * and the selection in untouched blocks still maps through.
 */
export function minimalReplaceTransaction(state: EditorState, newDoc: PMNode): Transaction {
  const oldDoc = state.doc;
  const start = oldDoc.content.findDiffStart(newDoc.content);
  const end = oldDoc.content.findDiffEnd(newDoc.content);
  if (start == null || end == null) return state.tr;
  let { a: endA, b: endB } = end;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  const fitted = state.tr.replace(start, endA, newDoc.slice(start, endB));
  if (fitted.doc.eq(newDoc)) return fitted;

  // Widen to top-level block boundaries. The prefix before `start` is shared, so the block start
  // is the same position in both documents; the suffix after the diff end is shared too, so the
  // old block end maps to the new document by the length difference.
  const $start = oldDoc.resolve(start);
  const blockFrom = $start.depth > 0 ? $start.before(1) : start;
  const $endA = oldDoc.resolve(endA);
  const blockToA = $endA.depth > 0 ? $endA.after(1) : endA;
  const blockToB = blockToA - endA + endB;
  const exact = state.tr.replaceWith(blockFrom, blockToA, newDoc.slice(blockFrom, blockToB).content);
  if (exact.doc.eq(newDoc)) return exact;
  return state.tr.replaceWith(0, oldDoc.content.size, newDoc.content);
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
  /** The ProseMirror document that blocks describes. */
  private currentDoc: PMNode | null = null;
  /** Markdown represented by currentDoc; avoids materializing the complete Y.Text for local lookups. */
  private currentText = "";
  private mapCache: { text: string; phantomKey: string; map: SourceMap } | null = null;
  private parseCache: { text: string; result: ParseResult } | null = null;
  private headingsCache: { text: string; headings: HeadingInfo[] } | null = null;
  private verifyHandle:
    | { idle: number }
    | { timer: ReturnType<typeof setTimeout> }
    | { visibility: () => void }
    | null = null;
  /** Consecutive verifications that matched the incremental parse. */
  private verifiedStreak = 0;
  /** Routine idle windows skipped since the last verification. */
  private skippedWindows = 0;
  /** An unverified incremental parse touched structural Markdown. */
  private structuralEdit = false;
  readonly verifyStats: VerifyStats = { runs: 0, matches: 0, mismatches: 0, skipped: 0 };
  private inLocalHandler = false;
  private pendingSync = false;
  /** True while a remote sync is being dispatched to the view. */
  syncing = false;
  private destroyed = false;
  /**
   * While held, text changes from Yjs are coalesced: the initial load may apply the IndexedDB copy and
   * the server state (or, on older servers, dozens of chunks) as separate transactions, and a full
   * parse + ProseMirror render per transaction is what made the 12k-word document slow to open (#118).
   * {@link releaseRemoteSync} (on `synced`) or a {@link HOLD_QUIET_MS} pause runs the one rebuild.
   */
  private holding = false;
  private heldTimer: ReturnType<typeof setTimeout> | null = null;
  private heldSync = false;
  /** Pending {@link scheduleHeldParse} task (the full parse of the held text, in a task of its own). */
  private heldParse: { idle: number } | { timer: ReturnType<typeof setTimeout> } | null = null;

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
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = null;
    this.cancelHeldParse();
    this.ytext.unobserve(this.onTextChange);
    this.view = null;
  }

  /**
   * Coalesce remote text changes until {@link releaseRemoteSync} or a {@link HOLD_QUIET_MS} pause.
   * Local edits (the rich pane's own transactions) are never held.
   */
  holdRemoteSync() {
    if (this.destroyed) return;
    this.holding = true;
  }

  /**
   * Stop coalescing. A held remote change is rebuilt now when its parse is already cached, else the
   * parse runs in its own task first ({@link scheduleHeldParse}) and the rebuild follows: a cold full
   * parse inside the `synced` handler would sit between the server's sync and its ack. The rich
   * pane's stand-in stays up until the rebuild (see `hasHeldSync`).
   */
  releaseRemoteSync() {
    if (!this.holding) return;
    this.holding = false;
    if (!this.heldSync) {
      this.cancelHeldParse();
      return;
    }
    if (this.parseCache?.text === this.ytext.toString()) {
      this.cancelHeldParse();
      if (this.heldTimer) clearTimeout(this.heldTimer);
      this.heldTimer = null;
      this.heldSync = false;
      this.syncFromText();
    } else {
      this.scheduleHeldParse();
    }
  }

  /** Whether a remote change is waiting for the coalesced rebuild. */
  get hasHeldSync(): boolean {
    return this.heldSync;
  }

  private holdSync() {
    this.heldSync = true;
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = null;
    this.scheduleHeldParse();
  }

  /** After the held text is parsed: the coalesced rebuild, once the changes pause for {@link HOLD_QUIET_MS}. */
  private scheduleHeldRebuild() {
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = setTimeout(() => {
      this.heldTimer = null;
      if (this.destroyed || !this.heldSync) return;
      this.heldSync = false;
      this.syncFromText();
    }, HOLD_QUIET_MS);
  }

  /**
   * Parse the held text in a task of its own (an idle callback, {@link HELD_PARSE_TIMEOUT_MS} at the
   * latest), then schedule the rebuild. The full parse the coalesced rebuild and the outline need is
   * then neither part of the task that applies the IndexedDB copy into Y.Text and the code pane, nor
   * of the rebuild, nor of the `synced` handler: on the 12k-word document it was the bulk of an
   * ~900 ms main-thread task that kept the WebSocket `open` and the server's sync waiting (#118).
   */
  private scheduleHeldParse() {
    if (this.heldParse) return;
    const run = () => {
      this.heldParse = null;
      if (this.destroyed) return;
      const text = this.ytext.toString();
      if (this.parseCache?.text !== text) {
        perfMark("markdoc:held-parse-start");
        this.parse(text);
        perfMark("markdoc:held-parse-end");
        // No notify here: the rebuild that follows notifies the session, and the outline reads the
        // headings then (a notify now would put a React render into the parse's task).
      }
      if (this.heldSync) this.scheduleHeldRebuild();
    };
    this.heldParse =
      typeof requestIdleCallback === "function" ? { idle: requestIdleCallback(run, { timeout: HELD_PARSE_TIMEOUT_MS }) } : { timer: setTimeout(run, 0) };
  }

  private cancelHeldParse() {
    const handle = this.heldParse;
    this.heldParse = null;
    if (!handle) return;
    if ("idle" in handle) cancelIdleCallback(handle.idle);
    else clearTimeout(handle.timer);
  }

  /** Build the initial ProseMirror document from the current text. */
  initialDoc(): PMNode {
    this.phantoms.clear();
    this.verifiedStreak = 0;
    this.skippedWindows = 0;
    const text = this.ytext.toString();
    const built = this.buildDoc(text);
    this.currentText = text;
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
      if (span) {
        result = reparseRange(cache.result, cache.text, text, span);
        if (result && isStructuralChange(cache.text, text, span)) this.structuralEdit = true;
      }
    }
    if (result) {
      this.scheduleVerify();
    } else {
      // A full parse is authoritative: nothing is left to verify.
      result = parseMarkdown(text);
      this.cancelVerify();
      this.structuralEdit = false;
    }
    this.parseCache = { text, result };
    this.headingsCache = { text, headings: result.headings };
    if (text === this.currentText && this.currentDoc?.eq(result.doc) && this.phantoms.size === 0) {
      this.mapCache = { text, phantomKey: "", map: { ...result.map, blocks: this.blocks } };
    }
    return result;
  }

  /**
   * Incremental parses are checked against a full parse once the user pauses. If the
   * two ever disagree the full result wins and the rich editor is re-synchronized.
   * The check is a trailing debounce: a full parse of a long document costs hundreds
   * of milliseconds, so it must never land between two keystrokes of a typing burst.
   * A keystroke cancels a pending check; a hidden tab defers it until the tab is visible.
   * Once the incremental parser has matched {@link VERIFY_TRUST_AFTER} times in a row,
   * routine edits (no structural Markdown on the changed lines) are verified only every
   * {@link VERIFY_EVERY_NTH_WINDOW}th pause, so resuming typing after a pause does not
   * collide with a full parse.
   */
  private scheduleVerify() {
    this.cancelVerify();
    const run = () => {
      this.verifyHandle = null;
      this.runScheduledVerify();
    };
    const whenIdle = () => {
      this.verifyHandle = null;
      if (this.tabHidden()) this.deferUntilVisible();
      else if (typeof requestIdleCallback === "function") this.verifyHandle = { idle: requestIdleCallback(run, { timeout: 3000 }) };
      else run();
    };
    this.verifyHandle = { timer: setTimeout(whenIdle, VERIFY_QUIET_MS) };
  }

  private cancelVerify() {
    const handle = this.verifyHandle;
    this.verifyHandle = null;
    if (!handle) return;
    if ("idle" in handle) cancelIdleCallback(handle.idle);
    else if ("timer" in handle) clearTimeout(handle.timer);
    else document.removeEventListener("visibilitychange", handle.visibility);
  }

  private tabHidden(): boolean {
    return typeof document !== "undefined" && document.visibilityState === "hidden";
  }

  private deferUntilVisible() {
    const onVisibility = () => {
      if (this.tabHidden()) return;
      document.removeEventListener("visibilitychange", onVisibility);
      if (this.verifyHandle && "visibility" in this.verifyHandle && this.verifyHandle.visibility === onVisibility) {
        this.verifyHandle = null;
        this.scheduleVerify();
      }
    };
    this.verifyHandle = { visibility: onVisibility };
    document.addEventListener("visibilitychange", onVisibility);
  }

  private runScheduledVerify() {
    if (this.destroyed || !this.parseCache) return;
    if (this.tabHidden()) {
      this.deferUntilVisible();
      return;
    }
    const trusted = this.verifiedStreak >= VERIFY_TRUST_AFTER;
    if (trusted && !this.structuralEdit && this.skippedWindows < VERIFY_EVERY_NTH_WINDOW - 1) {
      this.skippedWindows++;
      this.verifyStats.skipped++;
      return;
    }
    this.verifyParse();
  }

  /** Check the cached (incremental) parse against a full parse; repairs the editor on drift. */
  verifyParse(): boolean {
    const cache = this.parseCache;
    if (!cache || this.destroyed) return true;
    this.skippedWindows = 0;
    this.structuralEdit = false;
    this.verifyStats.runs++;
    const full = parseMarkdown(cache.text);
    const same =
      full.doc.eq(cache.result.doc) &&
      full.map.blocks.length === cache.result.map.blocks.length &&
      full.map.blocks.every((b, i) => b.from === cache.result.map.blocks[i].from && b.to === cache.result.map.blocks[i].to);
    this.parseCache = { text: cache.text, result: full };
    this.headingsCache = { text: cache.text, headings: full.headings };
    this.mapCache = null;
    if (same) {
      this.verifiedStreak++;
      this.verifyStats.matches++;
      return true;
    }
    this.verifiedStreak = 0;
    this.verifyStats.mismatches++;
    console.warn("[markdown-binding] incremental parse drifted from a full parse; resynchronizing");
    if (!this.inLocalHandler) this.syncFromText();
    return false;
  }

  private onTextChange = (_event: Y.YTextEvent, tr: Y.Transaction) => {
    if (this.destroyed || tr.origin === this) return;
    if (this.holding) {
      this.holdSync();
      return;
    }
    this.syncFromText();
  };

  /**
   * Headings of the current text, from the (incrementally maintained) parse. While the initial load
   * is held (see {@link holdRemoteSync}) a stale parse is not refreshed here: the outline asks for the
   * headings from inside the React render that the IndexedDB copy triggers, and a full parse there is
   * what made that task ~900 ms on the 12k-word document (#118). The held text is parsed in its own
   * task ({@link scheduleHeldParse}) and the session notified, so the outline fills in right after.
   */
  getHeadings(): HeadingInfo[] {
    const text = this.heldSync ? this.ytext.toString() : this.currentText;
    if (this.heldSync) {
      const cache = this.parseCache;
      if (cache && cache.text === text) return cache.result.headings;
      this.scheduleHeldParse();
      return cache ? cache.result.headings : NO_HEADINGS;
    }
    if (this.headingsCache?.text === text) return this.headingsCache.headings;
    return this.parse(text).headings;
  }

  /**
   * The current text and its mdast, from the same incrementally maintained parse. Callers that
   * walk the tree (the linter) get it without a second parse of the document.
   */
  getTree(): { text: string; tree: Md.Root } {
    const text = this.currentText;
    return { text, tree: this.parse(text).tree };
  }

  /**
   * Source map for the current state. Positions account for phantom blocks so
   * they are valid for the live ProseMirror document.
   */
  getSourceMap(): SourceMap {
    // While a remote change is held (initial load) the live document still describes the previous
    // text: map against that, not against the new text, whose full parse runs in its own task.
    const text = this.heldSync ? (this.parseCache?.text ?? "") : this.currentText;
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
  handleLocalTransaction(oldState: EditorState, newState: EditorState, change: LocalDocChange | null = null): boolean {
    if (this.destroyed) return false;
    this.inLocalHandler = true;
    try {
      return this.handleLocal(oldState, newState, change);
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

  private handleLocal(oldState: EditorState, newState: EditorState, change: LocalDocChange | null): boolean {
    const oldDoc = oldState.doc;
    const newDoc = newState.doc;
    let start: number;
    let endA: number;
    let endB: number;
    if (change && change.before === oldDoc && change.after === newDoc) {
      ({ start, endA, endB } = change);
    } else {
      if (oldDoc.eq(newDoc)) return false;
      const diffStart = oldDoc.content.findDiffStart(newDoc.content);
      const diffEnd = oldDoc.content.findDiffEnd(newDoc.content);
      if (diffStart == null || diffEnd == null) return false;
      start = diffStart;
      ({ a: endA, b: endB } = diffEnd);
      const overlap = start - Math.min(endA, endB);
      if (overlap > 0) {
        endA += overlap;
        endB += overlap;
      }
    }

    const N = oldDoc.childCount;
    const M = newDoc.childCount;
    if (this.blocks.length !== N) return this.fallbackReplaceAll(newDoc);
    const k = blockIndexAtResolvedStart(oldDoc, start);
    const endIdx = blockIndexAtResolvedEnd(oldDoc, endA);
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

    const fullText = this.currentText;
    const delta = newText.length - (srcTo - srcFrom);
    const nextFullText = fullText.slice(0, srcFrom) + newText + fullText.slice(srcTo);
    const oldText = fullText.slice(srcFrom, srcTo);
    const ops = diffOps(oldText, newText, srcFrom);
    const op = ops.length === 1 ? ops[0] : null;
    const sourceOldTo = op ? op.index + op.deleteCount : -1;
    const sourceNewTo = op ? op.index + op.insert.length : -1;
    const previousMap = this.mapCache?.text === fullText && this.phantoms.size === 0 ? this.mapCache.map : null;
    const sourceChange = op
      ? {
          oldFrom: op.index,
          oldTo: sourceOldTo,
          newTo: sourceNewTo,
        }
      : null;
    const changeContainsLineEnding =
      (op &&
        (containsLineEnding(op.insert) ||
          containsLineEnding(fullText.slice(op.index, sourceOldTo)) ||
          containsLineEnding(oldDoc.textBetween(start, endA, "\n", "\n")) ||
          containsLineEnding(newDoc.textBetween(start, endB, "\n", "\n")))) ??
      false;
    const simpleParagraphChange =
      change &&
      oldTo === k + 1 &&
      newTo === k + 1 &&
      chunks.length === 1 &&
      !chunks[0].phantom &&
      oldDoc.child(k)?.type === schema.nodes.paragraph &&
      newDoc.child(k)?.type === schema.nodes.paragraph &&
      !containsHardBreak(oldDoc.child(k)) &&
      !containsHardBreak(newDoc.child(k)) &&
      !changeContainsLineEnding &&
      op &&
      sourceOldTo - op.index === change.endA - change.start &&
      sourceNewTo - op.index === change.endB - change.start &&
      previousMap &&
      sourceChange &&
      hasLinearUnmarkedMapping(previousMap, oldDoc, newDoc, change, sourceChange);

    // Verify that the new text, together with its neighbouring blocks, parses back into
    // exactly the blocks of the rich document. Neighbours matter because Markdown merges
    // adjacent constructs (two lists, for example).
    let chunkBlocks: BlockRange[] = [];
    if (simpleParagraphChange) {
      chunkBlocks = [{ from: 0, to: chunkText.length }];
    } else if (chunkText) {
      const vFrom = prevReal ? prevReal.from : srcFrom;
      const vTo = nextReal ? nextReal.to + delta : srcFrom + newText.length;
      const parsed = parseMarkdown(nextFullText.slice(vFrom, vTo));
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

    if (ops.length > 0 && this.options.interceptor?.(ops, this.ytext, this)) {
      // The interceptor wrote the text its own way, so block ranges are rebuilt from the text by
      // the sync. Phantoms the edit turned into real blocks must not be re-inserted by that rebuild.
      if (chunks.every((c) => !c.phantom)) for (let i = k; i < oldTo; i++) this.phantoms.delete(i);
      this.requestSync();
      this.options.onSync?.("local");
      return true;
    }
    if (ops.length > 0) this.ydoc.transact(() => applyOps(this.ytext, ops), this);

    // Update block ranges: [0,k) unchanged, new chunk ranges, [oldTo,N) shifted.
    if (simpleParagraphChange && this.phantoms.size === 0) {
      this.blocks[k] = { from: srcFrom, to: srcFrom + newText.length };
      for (let i = k + 1; i < this.blocks.length; i++) {
        const block = this.blocks[i];
        this.blocks[i] = { from: block.from + delta, to: block.to + delta };
      }
    } else {
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
    }
    this.currentDoc = newDoc;
    this.currentText = nextFullText;
    this.cancelVerify();
    const onePlainTextBlock =
      simpleParagraphChange &&
      previousMap &&
      this.phantoms.size === 0 &&
      op &&
      sourceChange;
    if (onePlainTextBlock) {
      this.mapCache = {
        text: nextFullText,
        phantomKey: "",
        map: mapSourceMap(previousMap, this.blocks, newDoc, change, sourceChange),
      };
      if (this.headingsCache?.text === fullText) {
        this.headingsCache = {
          text: nextFullText,
          headings: this.headingsCache.headings.map((heading) =>
            heading.from >= sourceOldTo ? { ...heading, from: heading.from + delta } : heading,
          ),
        };
      }
    } else {
      this.mapCache = null;
      this.headingsCache = null;
    }

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
    const ops = diffOps(this.currentText, text, 0);
    if (ops.length > 0 && !this.options.interceptor?.(ops, this.ytext, this)) {
      this.ydoc.transact(() => applyOps(this.ytext, ops), this);
    }
    this.phantoms.clear();
    this.currentText = text;
    this.mapCache = null;
    this.headingsCache = null;
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
    // Any rebuild covers a held remote change too.
    this.heldSync = false;
    if (this.heldTimer) {
      clearTimeout(this.heldTimer);
      this.heldTimer = null;
    }
    perfMark("markdoc:rebuild-start");
    const view = this.view;
    const text = this.ytext.toString();
    const built = this.buildDoc(text);
    this.currentText = text;
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
    perfMark("markdoc:rebuild-end");
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
      init: (): MarkdownBindingState => ({ remote: false, localChange: null }),
      apply: (tr, value, oldState, newState): MarkdownBindingState => {
        // Transactions appended by other plugins (e.g. table normalization) inherit the
        // remote flag of the transaction they were appended to.
        if (tr.getMeta(markdownBindingKey)) return { remote: true, localChange: null };
        if (tr.getMeta("appendedTransaction")) {
          return tr.docChanged ? { remote: value.remote, localChange: null } : value;
        }
        return { remote: false, localChange: localDocChange(tr, oldState.doc, newState.doc) };
      },
    },
    view(view) {
      binding.attach(view);
      return {
        update(view, prevState) {
          const meta = markdownBindingKey.getState(view.state);
          if (meta?.remote || binding.syncing) return;
          if (view.state.doc === prevState.doc) return;
          binding.handleLocalTransaction(prevState, view.state, meta?.localChange ?? null);
        },
        destroy() {
          binding.view = null;
        },
      };
    },
  });
}
