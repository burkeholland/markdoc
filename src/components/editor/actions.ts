"use client";

import { EditorView as CMView } from "@codemirror/view";
import type { EditorView as PMView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import type { CollabSession, Surface } from "@/editor/collab/session";
import { schema } from "@/editor/markdown/schema";
import * as cm from "@/editor/codemirror/commands";
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
  rich: PMView | null = null;

  setCodeView(view: CMView | null) {
    this.code = view;
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

  private get active(): { kind: "code"; view: CMView } | { kind: "rich"; view: PMView } | null {
    if (this.surface === "code" && this.code) return { kind: "code", view: this.code };
    if (this.rich) return { kind: "rich", view: this.rich };
    if (this.code) return { kind: "code", view: this.code };
    return null;
  }

  focus() {
    const a = this.active;
    if (!a) return;
    a.view.focus();
  }

  private runPm(command: import("prosemirror-state").Command) {
    if (!this.rich) return;
    command(this.rich.state, this.rich.dispatch, this.rich);
    this.rich.focus();
  }

  private guard(): boolean {
    return this.session.canEdit;
  }

  formatState(): FormatState {
    const a = this.active;
    if (!a) return EMPTY_FORMAT;
    if (a.kind === "code") {
      const s = cm.formatStateAt(a.view.state);
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
    if (a.kind === "code") return void cm.toggleInlineMark(cm.markerFor(kind))(a.view);
    const type = kind === "strike" ? schema.marks.strikethrough : schema.marks[kind];
    this.runPm(pm.toggleMark(type));
  }

  setHeading(level: number) {
    if (!this.guard()) return;
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") return void cm.setHeading(level)(a.view);
    this.runPm(pm.setHeadingLevel(level));
  }

  toggleList(kind: "bullet" | "ordered" | "task") {
    if (!this.guard()) return;
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") return void cm.toggleLinePrefix(kind)(a.view);
    this.runPm(pm.toggleList(kind));
  }

  toggleQuote() {
    if (!this.guard()) return;
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") return void cm.toggleLinePrefix("quote")(a.view);
    this.runPm(pm.toggleBlockquote());
  }

  toggleCodeBlock() {
    if (!this.guard()) return;
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") return void cm.insertCodeBlock(a.view);
    this.runPm(pm.toggleCodeBlock());
  }

  horizontalRule() {
    if (!this.guard()) return;
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") return void cm.insertHorizontalRule(a.view);
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
    if (a.kind === "code") return void cm.insertLink(a.view, href, text || undefined);
    const state = a.view.state;
    if (state.selection.empty && text) {
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
    if (a.kind === "code") return void cm.insertImage(a.view, src, alt);
    this.runPm(pm.insertImage(src, alt));
  }

  insertTable(rows: number, cols: number) {
    if (!this.guard()) return;
    const a = this.active;
    if (!a) return;
    if (a.kind === "code") return void cm.insertTable(a.view, rows, cols);
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

  /** Scroll a source range into view in every mounted pane without changing the selection. */
  revealSourceRange(range: { from: number; to: number }) {
    if (this.code) {
      const pos = Math.min(range.from, this.code.state.doc.length);
      this.code.dispatch({ effects: CMView.scrollIntoView(pos, { y: "center" }) });
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

  /** Scroll both panes to a source offset and place the caret there in the active surface. */
  revealSource(offset: number, opts: { focus?: boolean } = {}) {
    if (this.code) {
      const pos = Math.min(offset, this.code.state.doc.length);
      this.code.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      if (opts.focus && this.surface === "code") this.code.focus();
    }
    if (this.rich) {
      const map = this.session.binding.getSourceMap();
      const pos = Math.min(this.rich.state.doc.content.size, Math.max(0, map.srcToPm(offset)));
      const sel = TextSelection.near(this.rich.state.doc.resolve(pos));
      this.rich.dispatch(this.rich.state.tr.setSelection(sel).scrollIntoView());
      const dom = this.rich.domAtPos(sel.head);
      const el = (dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement) as HTMLElement | null;
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      if (opts.focus && this.surface === "rich") this.rich.focus();
    }
  }
}

