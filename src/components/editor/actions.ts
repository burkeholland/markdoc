"use client";

import type { EditorView as CMView } from "@codemirror/view";
import type { EditorView as PMView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import type { CollabSession, Surface } from "@/editor/collab/session";
import type { CodeApi } from "@/editor/codemirror/api";
import { schema } from "@/editor/markdown/schema";
import * as pm from "@/editor/prosemirror/commands";
import { findParentNode } from "@/editor/prosemirror/utils";

export interface FormatState {
  strong: boolean;
  em: boolean;
  code: boolean;
  strike: boolean;
  link: boolean;
  heading: number;
  bullet: boolean;
  ordered: boolean;
  task: boolean;
  quote: boolean;
  codeBlock: boolean;
  hasSelection: boolean;
  /** Start position of the table around the rich selection, or -1 when outside a table. */
  tablePos: number;
  tableAlign: pm.TableAlign;
}

export const EMPTY_FORMAT: FormatState = {
  strong: false,
  em: false,
  code: false,
  strike: false,
  link: false,
  heading: 0,
  bullet: false,
  ordered: false,
  task: false,
  quote: false,
  codeBlock: false,
  hasSelection: false,
  tablePos: -1,
  tableAlign: null,
};

export type TableCommand = "rowBefore" | "rowAfter" | "colBefore" | "colAfter" | "deleteRow" | "deleteColumn" | "deleteTable";

export type DialogKind = "link" | "image" | "table" | "share" | "publish" | "shortcuts" | "versionName" | null;

/**
 * Toolbar and shortcut actions that apply to whichever surface the user is
 * working in. The code pane gets Markdown text edits, the rich pane gets
 * ProseMirror commands; both end up as the same change in the shared text.
 */
export class EditorActions {
  code: CMView | null = null;
  /**
   * CodeMirror values handed up by the code pane with its view (`EditorView.scrollIntoView`, the source
   * commands). This module imports `@codemirror/*` as types only, so the code pane's chunk stays out of
   * the editor's first load (#1121); null exactly when `code` is.
   */
  codeApi: CodeApi | null = null;
  rich: PMView | null = null;

  setCodeView(view: CMView | null, api: CodeApi | null) {
    this.code = view;
    this.codeApi = view ? api : null;
  }

  setRichView(view: PMView | null) {
    this.rich = view;
  }

  constructor(
    private session: CollabSession,
    private openDialog: (kind: DialogKind) => void,
  ) {}

  get surface(): Surface {
    return this.session.activeSurface;
  }

  private get active(): { kind: "code"; view: CMView; api: CodeApi } | { kind: "rich"; view: PMView } | null {
    const code = this.code && this.codeApi ? { kind: "code" as const, view: this.code, api: this.codeApi } : null;
    if (this.surface === "code" && code) return code;
    if (this.rich) return { kind: "rich", view: this.rich };
    return code;
  }

  focus() {
    const a = this.active;
    if (!a) return;
    a.view.focus();
  }

  /**
   * Return focus to the editor with the caret collapsed at the end of the current selection.
   * Used after a comment is posted/cancelled: refocusing with the range still selected would
   * re-open the selection bubble over the text the user just commented on.
   */
  focusCollapsed() {
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") {
      const { main } = a.view.state.selection;
      if (!main.empty) a.view.dispatch({ selection: { anchor: main.to } });
    } else {
      const { selection } = a.view.state;
      if (!selection.empty) a.view.dispatch(a.view.state.tr.setSelection(TextSelection.create(a.view.state.doc, selection.to)));
    }
    a.view.focus();
  }

  private runPm(command: import("prosemirror-state").Command) {
    if (!this.rich) return;
    this.discrete();
    command(this.rich.state, this.rich.dispatch, this.rich);
    this.rich.focus();
  }

  /**
   * A toolbar or menu action is its own undo step. Y.UndoManager merges edits closer than its
   * 400 ms capture window, so two quick menu clicks — or a click right after typing — would undo
   * together (the table menu's add row / add column came back as one step, task #437).
   */
  private discrete() {
    this.session.undoManager.stopCapturing();
  }

  private guard(): boolean {
    return this.session.canEdit;
  }

  formatState(): FormatState {
    const a = this.active;
    if (!a) return EMPTY_FORMAT;
    if (a.kind === "code") {
      const s = a.api.commands.formatStateAt(a.view.state);
      return { ...s, hasSelection: !a.view.state.selection.main.empty, tablePos: -1, tableAlign: null };
    }
    const state = a.view.state;
    const list = pm.listTypeAt(state);
    const table = pm.tableAt(state);
    return {
      strong: pm.isMarkActive(state, schema.marks.strong),
      em: pm.isMarkActive(state, schema.marks.em),
      code: pm.isMarkActive(state, schema.marks.code),
      strike: pm.isMarkActive(state, schema.marks.strikethrough),
      link: pm.isMarkActive(state, schema.marks.link),
      heading: pm.currentHeadingLevel(state),
      bullet: !!list && list.type === schema.nodes.bullet_list && !list.task,
      ordered: !!list && list.type === schema.nodes.ordered_list,
      task: !!list && list.task,
      quote: !!findParentNode(state.selection.$from, (n) => n.type === schema.nodes.blockquote),
      codeBlock: pm.blockTypeActive(state, schema.nodes.code_block),
      hasSelection: !state.selection.empty,
      tablePos: table ? table.pos : -1,
      tableAlign: table ? pm.columnAlignAt(state) : null,
    };
  }

  toggleMark(kind: "strong" | "em" | "code" | "strike") {
    if (!this.guard()) return;
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") return void a.api.commands.toggleInlineMark(a.api.commands.markerFor(kind))(a.view);
    const type = kind === "strike" ? schema.marks.strikethrough : schema.marks[kind];
    this.runPm(pm.toggleMark(type));
  }

  setHeading(level: number) {
    if (!this.guard()) return;
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") return void a.api.commands.setHeading(level)(a.view);
    this.runPm(pm.setHeadingLevel(level));
  }

  toggleList(kind: "bullet" | "ordered" | "task") {
    if (!this.guard()) return;
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") return void a.api.commands.toggleLinePrefix(kind)(a.view);
    this.runPm(pm.toggleList(kind));
  }

  toggleQuote() {
    if (!this.guard()) return;
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") return void a.api.commands.toggleLinePrefix("quote")(a.view);
    this.runPm(pm.toggleBlockquote());
  }

  toggleCodeBlock() {
    if (!this.guard()) return;
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") return void a.api.commands.insertCodeBlock(a.view);
    this.runPm(pm.toggleCodeBlock());
  }

  horizontalRule() {
    if (!this.guard()) return;
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") return void a.api.commands.insertHorizontalRule(a.view);
    this.runPm(pm.insertHorizontalRule());
  }

  /** Current link target at the cursor, used to prefill the link dialog. */
  currentLink(): { href: string; text: string } | null {
    const a = this.active;
    if (!a) return null;
    if (a.kind === "code") {
      const { from, to } = a.view.state.selection.main;
      return { href: "", text: a.view.state.sliceDoc(from, to) };
    }
    const state = a.view.state;
    const attrs = pm.markAttrs(state, schema.marks.link);
    const { from, to } = state.selection;
    return { href: (attrs?.href as string) ?? "", text: state.doc.textBetween(from, to, " ") };
  }

  openLinkDialog() {
    if (!this.guard()) return;
    this.openDialog("link");
  }

  applyLink(href: string, text: string) {
    if (!this.guard()) return;
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") return void a.api.commands.insertLink(a.view, href, text || undefined);
    const state = a.view.state;
    if (state.selection.empty && text) {
      this.discrete();
      const tr = state.tr.insertText(text);
      const from = state.selection.from;
      tr.addMark(from, from + text.length, schema.marks.link.create({ href }));
      a.view.dispatch(tr.scrollIntoView());
      a.view.focus();
      return;
    }
    this.runPm(pm.setLink(href || null));
  }

  removeLink() {
    if (!this.guard()) return;
    const a = this.active;
    if (!a || a.kind === "code") return;
    this.runPm(pm.setLink(null));
  }

  insertImage(src: string, alt: string) {
    if (!this.guard()) return;
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") return void a.api.commands.insertImage(a.view, src, alt);
    this.runPm(pm.insertImage(src, alt));
  }

  insertTable(rows: number, cols: number) {
    if (!this.guard()) return;
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") return void a.api.commands.insertTable(a.view, rows, cols);
    this.runPm(pm.insertTable(rows, cols));
  }

  /** Structural table edits; rich pane only (the code pane edits the Markdown directly). */
  table(command: TableCommand) {
    if (!this.guard() || !this.rich) return;
    const cmd = {
      rowBefore: pm.addRowBefore,
      rowAfter: pm.addRowAfter,
      colBefore: pm.addColumnBefore,
      colAfter: pm.addColumnAfter,
      deleteRow: pm.deleteRow,
      deleteColumn: pm.deleteColumn,
      deleteTable: pm.deleteTable,
    }[command];
    this.runPm(cmd);
  }

  setColumnAlign(align: pm.TableAlign) {
    if (!this.guard() || !this.rich) return;
    this.runPm(pm.setColumnAlign(align));
  }

  undo() {
    this.session.undo();
    this.focus();
  }

  redo() {
    this.session.redo();
    this.focus();
  }

  /** Current selection as source offsets (for comments), or null when empty. */
  selectionSourceRange(): { from: number; to: number } | null {
    const a = this.active;
    if (!a) return null;
    if (a.kind === "code") {
      const { from, to } = a.view.state.selection.main;
      return from === to ? null : { from, to };
    }
    const { from, to } = a.view.state.selection;
    if (from === to) return null;
    const map = this.session.binding.getSourceMap();
    const sFrom = map.pmToSrc(from);
    const sTo = map.pmToSrc(to);
    return sTo > sFrom ? { from: sFrom, to: sTo } : null;
  }

  /** Selected text in the active surface, or "" when empty or spanning several lines (used to seed find). */
  selectionText(): string {
    const a = this.active;
    if (!a) return "";
    let text: string;
    if (a.kind === "code") {
      const { from, to } = a.view.state.selection.main;
      text = a.view.state.sliceDoc(from, to);
    } else {
      const { from, to } = this.richSelection(a.view);
      text = a.view.state.doc.textBetween(from, to, "\n");
    }
    return /\n/.test(text) ? "" : text;
  }

  /**
   * The rich pane's selection, preferring the live DOM selection. ProseMirror
   * reads keyboard selection changes on the (async) `selectionchange` event, so
   * a shortcut fired right after Shift-Arrow would otherwise see a stale state.
   */
  private richSelection(view: PMView): { from: number; to: number } {
    const state = view.state.selection;
    if (!view.hasFocus()) return state;
    const sel = view.dom.ownerDocument.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return state;
    if (!view.dom.contains(sel.anchorNode) || !view.dom.contains(sel.focusNode)) return state;
    try {
      const anchor = view.posAtDOM(sel.anchorNode, sel.anchorOffset);
      const head = view.posAtDOM(sel.focusNode, sel.focusOffset);
      return { from: Math.min(anchor, head), to: Math.max(anchor, head) };
    } catch {
      return state;
    }
  }

  /** Scrollable container of the rich pane, so matches can be revealed without touching the selection. */
  private richScroller: HTMLElement | null = null;

  setRichScroller(el: HTMLElement | null) {
    this.richScroller = el;
  }

  /** Whether scroll sync is mirroring the two panes onto each other (both shown, toggle on). */
  private scrollSynced = false;

  setScrollSynced(on: boolean) {
    this.scrollSynced = on;
  }

  /** Scroll a source range into view in every mounted pane without changing the selection. */
  revealSourceRange(range: { from: number; to: number }) {
    if (this.code && this.codeApi) {
      const pos = Math.min(range.from, this.code.state.doc.length);
      this.code.dispatch({ effects: this.codeApi.scrollIntoView(pos, { y: "center" }) });
    }
    if (this.rich && this.rich.dom.isConnected) {
      const map = this.session.binding.getSourceMap();
      const pos = Math.min(this.rich.state.doc.content.size, Math.max(0, map.srcToPm(range.from)));
      const scroller = this.richScroller ?? this.rich.dom.parentElement?.parentElement ?? null;
      if (!scroller) return;
      let coords: { top: number; bottom: number };
      try {
        coords = this.rich.coordsAtPos(pos);
      } catch {
        return;
      }
      const box = scroller.getBoundingClientRect();
      if (box.height === 0) return; // pane hidden
      const margin = 24;
      if (coords.top < box.top + margin || coords.bottom > box.bottom - margin) {
        scroller.scrollTop += coords.top - box.top - box.height / 2;
      }
    }
  }

  /** Select a source range in the active surface (and focus it). */
  selectSourceRange(range: { from: number; to: number }, opts: { focus?: boolean } = {}) {
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") {
      const len = a.view.state.doc.length;
      a.view.dispatch({ selection: { anchor: Math.min(range.from, len), head: Math.min(range.to, len) }, scrollIntoView: true });
      if (opts.focus) a.view.focus();
      return;
    }
    const map = this.session.binding.getSourceMap();
    const size = a.view.state.doc.content.size;
    const from = Math.min(size, Math.max(0, map.srcToPm(range.from)));
    const to = Math.min(size, Math.max(0, map.srcToPm(range.to)));
    try {
      const sel = TextSelection.between(a.view.state.doc.resolve(from), a.view.state.doc.resolve(to));
      a.view.dispatch(a.view.state.tr.setSelection(sel).scrollIntoView());
    } catch {
      /* positions not valid in the rich document (e.g. inside syntax) */
    }
    if (opts.focus) a.view.focus();
  }

  /**
   * Scroll the visible pane(s) so a source offset sits in the middle of the viewport, without
   * touching the selection (used while following a collaborator). Panes whose offset already sits
   * in the middle 60 % of the viewport are left alone. With both panes shown and scroll sync on,
   * only the active surface is scrolled: the sync moves the other one.
   */
  scrollToSource(offset: number, opts: { code: boolean; rich: boolean; synced: boolean; behavior?: ScrollBehavior }) {
    const behavior = opts.behavior ?? "smooth";
    let code = opts.code && !!this.code;
    let rich = opts.rich && !!this.rich && this.rich.dom.isConnected;
    if (code && rich && opts.synced) {
      if (this.surface === "code") rich = false;
      else code = false;
    }
    if (code && this.code) {
      const view = this.code;
      const pos = Math.min(offset, view.state.doc.length);
      const scroller = view.scrollDOM;
      const box = scroller.getBoundingClientRect();
      if (box.height > 0) {
        const block = view.lineBlockAt(pos);
        const top = block.top + view.documentTop - box.top; // viewport-relative
        if (!withinMiddle(top, block.height, box.height)) {
          scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + top + block.height / 2 - box.height / 2), behavior });
        }
      }
    }
    if (rich && this.rich) {
      const view = this.rich;
      const map = this.session.binding.getSourceMap();
      const pos = Math.min(view.state.doc.content.size, Math.max(0, map.srcToPm(offset)));
      const scroller = this.richScroller ?? view.dom.parentElement?.parentElement ?? null;
      if (!scroller) return;
      const top = this.richCentreTop(view, scroller, pos);
      if (top !== null) scroller.scrollTo({ top, behavior });
    }
  }

  /**
   * Scroll the visible pane(s) to a source offset so it sits in the middle of the viewport, and place
   * the caret there in the active surface (comment cards, outline, lint issues). The rich pane is
   * scrolled by measuring the target and moving its own scroller: with scroll sync on and both panes
   * shown only the active surface scrolls itself (the sync mirrors the other), so the sync's mirror
   * can no longer cancel the glide and strand the target at the pane's edge. The glide is capped to
   * one viewport and verified once it settles, so a long document still lands in well under a second.
   */
  revealSource(offset: number, opts: { focus?: boolean } = {}) {
    this.cancelRevealWatch();
    const code = this.code && this.codeApi ? { view: this.code, api: this.codeApi } : null;
    const rich = this.rich && this.rich.dom.isConnected ? this.rich : null;
    const richScroller = rich ? this.richScroller ?? rich.dom.parentElement?.parentElement ?? null : null;
    const codeVisible = !!code && code.view.scrollDOM.getBoundingClientRect().height > 0;
    // An unknown scroller cannot be measured; treat the pane as visible and fall back to scrollIntoView.
    const richVisible = !!rich && (!richScroller || richScroller.getBoundingClientRect().height > 0);
    let scrollCode = codeVisible;
    let scrollRich = richVisible;
    if (this.scrollSynced && codeVisible && richVisible) {
      if (this.surface === "code") scrollRich = false;
      else scrollCode = false;
    }
    // Focus the active surface when shown, otherwise whichever pane is; a hidden pane cannot take focus.
    const focusCode = !!opts.focus && codeVisible && (this.surface === "code" || !richVisible);
    const focusRich = !!opts.focus && !focusCode && richVisible;
    // Focus before dispatching: both panes only report selection changes while focused, and the
    // outline's active heading follows that report.
    if (code) {
      const pos = Math.min(offset, code.view.state.doc.length);
      if (focusCode) code.view.focus();
      code.view.dispatch({ selection: { anchor: pos }, effects: scrollCode ? code.api.scrollIntoView(pos, { y: "center" }) : [] });
    }
    if (rich) {
      const map = this.session.binding.getSourceMap();
      const doc = rich.state.doc;
      // Offsets at a block start (outline headings, lint issues) sit in Markdown syntax, where
      // srcToPm snaps to the previous block's end; resolve them to the block itself instead.
      const blockIdx = map.blocks.findIndex((b) => b.from === offset && !b.phantom);
      let pos: number;
      if (blockIdx >= 0 && blockIdx < doc.childCount) {
        pos = 0;
        for (let i = 0; i < blockIdx; i++) pos += doc.child(i).nodeSize;
      } else {
        pos = Math.min(doc.content.size, Math.max(0, map.srcToPm(offset)));
      }
      const sel = TextSelection.near(doc.resolve(pos), 1);
      if (focusRich) rich.focus();
      // No tr.scrollIntoView(): its "nearest" scroll would leave the caret on the pane's edge.
      rich.dispatch(rich.state.tr.setSelection(sel));
      if (!scrollRich) return;
      if (richScroller) {
        this.centreRich(rich, richScroller, sel.head);
      } else {
        const dom = rich.domAtPos(sel.head);
        const el = (dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement) as HTMLElement | null;
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }

  /**
   * scrollTop that puts a rich position in the middle of its scroller, or null when the position
   * already sits in the middle 60 % of the viewport (or cannot be measured, e.g. the pane is hidden).
   */
  private richCentreTop(view: PMView, scroller: HTMLElement, pos: number): number | null {
    let coords: { top: number; bottom: number };
    try {
      coords = view.coordsAtPos(Math.min(pos, view.state.doc.content.size));
    } catch {
      return null;
    }
    const box = scroller.getBoundingClientRect();
    if (box.height === 0) return null;
    const top = coords.top - box.top;
    const height = coords.bottom - coords.top;
    if (withinMiddle(top, height, box.height)) return null;
    return Math.max(0, scroller.scrollTop + top + height / 2 - box.height / 2);
  }

  /** Smooth-scroll the rich pane so `pos` is centred, jumping first when it is more than a viewport away. */
  private centreRich(view: PMView, scroller: HTMLElement, pos: number) {
    const top = this.richCentreTop(view, scroller, pos);
    if (top === null) return;
    // Chromium's smooth scroll takes ~sqrt(px)/60 s with a slow ease-in (1.6 s for 9 000 px, of which
    // the first 200 ms barely move), which reads as "nothing happened" on a long document. Jump to
    // within one viewport of the target and glide the rest: the eye still sees the direction.
    const cap = scroller.clientHeight;
    const from = scroller.scrollTop;
    if (Math.abs(top - from) > cap) scroller.scrollTop = top + (from < top ? -cap : cap);
    scroller.scrollTo({ top, behavior: "smooth" });
    this.watchRichReveal(view, scroller, pos);
  }

  private revealWatch: (() => void) | null = null;

  private cancelRevealWatch() {
    this.revealWatch?.();
    this.revealWatch = null;
  }

  /**
   * Once the smooth scroll settles (scrollTop unchanged for two frames, checked only after the glide has
   * had 250 ms to start; 2 s at most), re-measure the target and correct once, instantly, if something (a
   * scroll-sync mirror, a late layout shift) moved the pane off it. Any user scroll or key on the pane
   * cancels the watch so it never fights the user.
   */
  private watchRichReveal(view: PMView, scroller: HTMLElement, pos: number) {
    const started = performance.now();
    let last = scroller.scrollTop;
    let still = 0;
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      for (const type of REVEAL_CANCEL_EVENTS) scroller.removeEventListener(type, stop);
      if (this.revealWatch === stop) this.revealWatch = null;
    };
    const tick = () => {
      const top = scroller.scrollTop;
      if (top === last) still++;
      else {
        still = 0;
        last = top;
      }
      const elapsed = performance.now() - started;
      if ((elapsed >= REVEAL_SETTLE_MIN_MS && still >= 2) || elapsed >= REVEAL_SETTLE_MAX_MS) {
        stop();
        if (view.isDestroyed || !scroller.isConnected) return;
        const target = this.richCentreTop(view, scroller, pos);
        if (target !== null) scroller.scrollTo({ top: target, behavior: "auto" });
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    for (const type of REVEAL_CANCEL_EVENTS) scroller.addEventListener(type, stop, { passive: true });
    frame = requestAnimationFrame(tick);
    this.revealWatch = stop;
  }
}

const REVEAL_CANCEL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
/** Chromium's smooth scroll may not move a full pixel in its first ~100 ms; do not mistake that for "settled". */
const REVEAL_SETTLE_MIN_MS = 250;
const REVEAL_SETTLE_MAX_MS = 2_000;

/** Whether a box at `top` (viewport-relative) with `height` lies inside the middle 60 % of a viewport. */
function withinMiddle(top: number, height: number, viewport: number): boolean {
  const margin = viewport * 0.2;
  return top >= margin && top + height <= viewport - margin;
}

