import { TextSelection, type Command } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { parseMarkdown } from "../markdown/parse";
import { schema } from "../markdown/schema";
import { nextFootnoteLabel, tocMarkdown, type TocHeading } from "../slash-blocks";

/**
 * Rich-editor commands for the slash items that insert whole Markdown blocks (`/toc`, `/footnote`).
 * Kept apart from `commands.ts` so the toolbar commands stay untouched.
 */

/**
 * Inserts the blocks parsed from `markdown` at the caret: in place of the caret's textblock when it is
 * empty, otherwise after it. The caret ends at the end of the inserted content.
 */
export function insertMarkdownBlocks(markdown: string): Command {
  return (state, dispatch) => {
    if (!markdown.trim()) return false;
    const { $from } = state.selection;
    if ($from.depth < 1 || !$from.parent.isTextblock) return false;
    const content = parseMarkdown(markdown).doc.content;
    if (!dispatch) return true;
    const empty = $from.parent.content.size === 0;
    const from = empty ? $from.before() : $from.after();
    const to = empty ? $from.after() : from;
    const tr = state.tr.replaceWith(from, to, content);
    const end = tr.mapping.map(to, 1);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1)).scrollIntoView();
    dispatch(tr);
    return true;
  };
}

/** The document's headings in order (the ones inside tables or quotes too). */
export function headingsOf(doc: PMNode): TocHeading[] {
  const headings: TocHeading[] = [];
  doc.descendants((node) => {
    if (node.type === schema.nodes.heading) {
      headings.push({ level: node.attrs.level as number, text: node.textContent });
      return false;
    }
    return true;
  });
  return headings;
}

/** `/toc`: a linked list of the document's headings. Does nothing in a document without headings. */
export const insertTableOfContents: Command = (state, dispatch, view) => insertMarkdownBlocks(tocMarkdown(headingsOf(state.doc)))(state, dispatch, view);

/**
 * `/footnote`: a `[^n]` reference at the caret and its definition at the end of the document, with the
 * caret in the definition so the note can be typed straight away.
 */
export const insertFootnote: Command = (state, dispatch) => {
  const { footnote_reference: ref, footnote_definition: def, paragraph } = schema.nodes;
  const { $from } = state.selection;
  if (!$from.parent.inlineContent || !$from.parent.canReplaceWith($from.index(), $from.index(), ref)) return false;
  if (!dispatch) return true;
  const labels: string[] = [];
  state.doc.descendants((node) => {
    if (node.type === ref || node.type === def) labels.push(String(node.attrs.label));
    return true;
  });
  const label = nextFootnoteLabel(labels);
  const tr = state.tr.replaceSelectionWith(ref.create({ label }), false);
  const at = tr.doc.content.size;
  tr.insert(at, def.create({ label }, paragraph.create()));
  tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView();
  dispatch(tr);
  return true;
};
