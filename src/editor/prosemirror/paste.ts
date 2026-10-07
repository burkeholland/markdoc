import { Plugin, TextSelection } from "prosemirror-state";
import type { Slice } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import type * as Y from "yjs";
import { schema } from "../markdown/schema";
import { matchLinkCard } from "../markdown/link-cards";
import { decideInsert, wrapInCodeFence } from "../markdown/renderable";
import { tsvToMarkdownTable, TSV_TABLE_NOTICE, type NoticeAction } from "../markdown/tsv";
import type { MarkdownBinding } from "../sync/markdown-binding";

/** The parts of a CollabSession the paste handler needs; kept narrow so tests can supply a stub. */
export interface PasteSession {
  ydoc: Y.Doc;
  ytext: Y.Text;
  binding: MarkdownBinding;
  undoManager?: Y.UndoManager;
  mode?: string;
  /** Undo the last step (the toast's Undo action); falls back to the undo manager. */
  undo?: () => void;
}

export interface SmartPasteOptions {
  onNotice?: (message: string, action?: NoticeAction) => void;
}

const URL_RE = /^(?:https?:\/\/|mailto:|www\.)[^\s<>"']+$/i;

/** True when the text is a single URL (what you get from copying a browser address bar). */
export function isUrlText(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && !/\s/.test(t) && URL_RE.test(t);
}

function hrefFor(url: string): string {
  return /^www\./i.test(url) ? `https://${url}` : url;
}

const BLOCK_START_RE = /^\s{0,3}(?:#{1,6}\s|[-*+]\s|>|\d+[.)]\s|```|~~~|\|)/;
const INLINE_RE = /\[[^\]]*\]\([^)]*\)|\*\*[^*\n]+\*\*|!\[[^\]]*\]\(/;

/**
 * Heuristic used to decide whether pasted plain text is Markdown source: at least two
 * lines, and one of them starts with block syntax or contains a link / strong span.
 */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length < 2) return false;
  return lines.some((line) => BLOCK_START_RE.test(line) || INLINE_RE.test(line));
}

/** A slice with only unmarked text in paragraphs is what ProseMirror makes of plain text. */
function isPlainSlice(slice: Slice): boolean {
  let plain = true;
  slice.content.descendants((node) => {
    if (!plain) return false;
    if (node.isText) {
      if (node.marks.length > 0) plain = false;
    } else if (node.type !== schema.nodes.paragraph && node.type !== schema.nodes.hard_break) {
      plain = false;
    }
    return plain;
  });
  return plain;
}

function clipboardText(event: ClipboardEvent | undefined): string {
  const data = event?.clipboardData;
  if (!data) return "";
  return data.getData("text/plain") || data.getData("Text") || "";
}

function clipboardHtml(event: ClipboardEvent | undefined): string {
  return event?.clipboardData?.getData("text/html") ?? "";
}

/** Wrap the selected text in a link to `url`. */
function linkSelection(view: EditorView, url: string): boolean {
  const { selection } = view.state;
  if (selection.empty || !(selection instanceof TextSelection)) return false;
  const { from, to } = selection;
  if (!view.state.doc.textBetween(from, to).trim()) return false;
  const mark = schema.marks.link.create({ href: hrefFor(url.trim()) });
  const tr = view.state.tr.addMark(from, to, mark);
  if (!tr.docChanged) return false;
  view.dispatch(tr.setMeta("paste", true).setMeta("uiEvent", "paste").scrollIntoView());
  return true;
}

/**
 * Insert Markdown source at the selection. The selection is mapped to source offsets
 * and replaced in the Y.Text directly, so the pasted text is parsed as Markdown
 * rather than being escaped as literal text. Uses the binding as the transaction
 * origin, like any other local edit from the rich pane, so it undoes as one step.
 */
function pasteMarkdownSource(view: EditorView, session: PasteSession, text: string): boolean {
  const { selection } = view.state;
  const $from = selection.$from;
  if ($from.parent.type.spec.code) return false;

  const map = session.binding.getSourceMap();
  const source = session.ytext.toString();
  let srcFrom = map.pmToSrc(selection.from);
  let srcTo = Math.max(srcFrom, map.pmToSrc(selection.to));
  if (srcTo > source.length) return false;
  // Blocks are pasted on their own lines; drop the spaces that would otherwise hang
  // off the ends of the split line.
  while (srcFrom > 0 && (source[srcFrom - 1] === " " || source[srcFrom - 1] === "\t")) srcFrom--;
  while (srcTo < source.length && (source[srcTo] === " " || source[srcTo] === "\t")) srcTo++;

  const body = text.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
  if (!body) return false;

  const before = source.slice(0, srcFrom);
  const after = source.slice(srcTo);
  let prefix = "";
  if (before.length > 0 && !before.endsWith("\n\n")) prefix = before.endsWith("\n") ? "\n" : "\n\n";
  let suffix = "";
  if (after.length > 0 && !after.startsWith("\n\n")) suffix = after.startsWith("\n") ? "\n" : "\n\n";
  const insert = prefix + body + suffix;

  // An empty paragraph under the cursor is a local phantom block; it has no source of
  // its own and would otherwise linger above the pasted content.
  const emptyBlock =
    selection.empty && $from.depth === 1 && $from.parent.type === schema.nodes.paragraph && $from.parent.content.size === 0
      ? $from.before(1)
      : null;

  session.undoManager?.stopCapturing();
  session.ydoc.transact(() => {
    if (srcTo > srcFrom) session.ytext.delete(srcFrom, srcTo - srcFrom);
    session.ytext.insert(srcFrom, insert);
  }, session.binding);
  // The binding ignores changes made with its own origin; bring the rich view up to date.
  session.binding.syncFromText();
  session.undoManager?.stopCapturing();

  if (view.isDestroyed) return true;
  if (emptyBlock !== null) {
    const node = view.state.doc.nodeAt(emptyBlock);
    if (node && node.type === schema.nodes.paragraph && node.content.size === 0 && view.state.doc.childCount > 1) {
      view.dispatch(view.state.tr.delete(emptyBlock, emptyBlock + node.nodeSize));
    }
  }

  const endSrc = srcFrom + prefix.length + body.length;
  const size = view.state.doc.content.size;
  const pos = Math.max(0, Math.min(size, session.binding.getSourceMap().srcToPm(endSrc)));
  try {
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos), -1)).scrollIntoView());
  } catch {
    /* keep whatever selection the sync left */
  }
  return true;
}

/**
 * A known link (`link-cards.ts`) pasted into an empty top-level paragraph becomes a card (#2317). It is
 * two steps, so the first undo leaves the plain link (written `<link>`) and the second the empty line.
 * Anywhere else (in a sentence, a list, a quote, a cell) the link is pasted as the text it is.
 */
function pasteAsCard(view: EditorView, session: PasteSession, url: string): boolean {
  const { selection } = view.state;
  const { $from } = selection;
  if (!selection.empty || $from.depth !== 1 || $from.parent.type !== schema.nodes.paragraph || $from.parent.content.size !== 0) return false;
  if (!matchLinkCard(url)) return false;
  const pos = $from.before(1);
  const link = schema.text(url, [schema.marks.link.create({ href: url })]);

  session.undoManager?.stopCapturing();
  view.dispatch(view.state.tr.insert(pos + 1, link).setMeta("paste", true).setMeta("uiEvent", "paste"));
  session.undoManager?.stopCapturing();
  if (view.isDestroyed) return true;

  const paragraph = view.state.doc.nodeAt(pos);
  if (!paragraph || paragraph.type !== schema.nodes.paragraph || paragraph.textContent !== url) return true;
  const end = pos + paragraph.nodeSize;
  const last = end === view.state.doc.content.size;
  // After the last block there is nowhere to go on typing, so an empty line follows the card.
  const tr = view.state.tr.replaceWith(pos, end, last ? [schema.nodes.link_card.create({ url }), schema.nodes.paragraph.create()] : schema.nodes.link_card.create({ url }));
  // The caret was in the paragraph that is replaced: it lands after the card, on the empty line or in the next block.
  view.dispatch(tr.setMeta("paste", true).setMeta("uiEvent", "paste").scrollIntoView());
  session.undoManager?.stopCapturing();
  return true;
}

/**
 * Smarter paste for the rich pane:
 *
 * - a URL pasted over a selection turns the selection into a link (the word-processor convention);
 *   without a selection it is inserted as text and autolinked by the Markdown;
 * - a link to a known site pasted on an empty line of its own becomes a card (not while suggesting);
 * - multi-line plain text that looks like Markdown is inserted as Markdown source so it
 *   renders as real structure instead of escaped literal text;
 * - tab-separated plain text (a spreadsheet range, `psql` or `jq -r @tsv` output) with the
 *   same number of tabs on every line becomes a GFM table, first row as header, unless the
 *   clipboard's HTML already carries structure (a real `<table>` goes through the HTML path);
 * - everything else (HTML from web pages and word processors, single lines of text) goes
 *   through ProseMirror's default clipboard parsing.
 */
export function smartPastePlugin(session: PasteSession, options: SmartPasteOptions = {}): Plugin {
  const undo = () => (session.undo ? session.undo() : session.undoManager?.undo());
  return new Plugin({
    props: {
      handlePaste(view, event, slice) {
        if (!view.editable) return false;
        const text = clipboardText(event);
        if (!text.trim()) return false;

        if (isUrlText(text) && linkSelection(view, text)) return true;

        if (session.mode === "suggesting") return false;
        if (isUrlText(text) && pasteAsCard(view, session, text.trim())) return true;
        // Text micromark would choke on goes in as a fenced code block (which the guard skips),
        // whatever the clipboard's HTML says; inside a code block it is already safe.
        if (!view.state.selection.$from.parent.type.spec.code) {
          const decision = decideInsert(text);
          if (decision.kind === "code") {
            if (!pasteMarkdownSource(view, session, wrapInCodeFence(text))) return false;
            options.onNotice?.(decision.message);
            return true;
          }
        }
        const html = clipboardHtml(event);
        if (html && !isPlainSlice(slice)) return false;
        const table = tsvToMarkdownTable(text);
        if (table !== null) {
          if (!pasteMarkdownSource(view, session, table)) return false;
          options.onNotice?.(TSV_TABLE_NOTICE, { label: "Undo", onClick: undo });
          return true;
        }
        if (!looksLikeMarkdown(text)) return false;
        return pasteMarkdownSource(view, session, text);
      },
    },
  });
}
