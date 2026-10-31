import { EditorSelection, type EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { EditorView } from "@codemirror/view";
import { extractHeadings } from "../markdown/parse";
import { calloutMarkdown, footnoteLabelsInSource, nextFootnoteLabel, tocMarkdown, type CalloutKind } from "../slash-blocks";
import { insertBlock, insertCodeBlock, insertHorizontalRule, insertTable, setHeading, toggleLinePrefix, type LinePrefixKind } from "./commands";

/**
 * The source-editor side of the slash items. Each returns a CodeMirror command; the menu runs it right
 * after removing the typed `/query`. Reached through `CodeApi.slash` so the shell never imports CodeMirror.
 */
export type SourceSlashCommand = (view: EditorView) => boolean;

export const heading = (level: number): SourceSlashCommand => (view) => {
  // Text on a line that is not a heading is already plain text; nothing to change is still a success.
  setHeading(level)(view);
  return true;
};

export const linePrefix = (kind: LinePrefixKind): SourceSlashCommand => toggleLinePrefix(kind);

export const codeBlock = (lang: string): SourceSlashCommand => (view) => insertCodeBlock(view, lang);

export const divider: SourceSlashCommand = (view) => insertHorizontalRule(view);

export const table: SourceSlashCommand = (view) => insertTable(view, 3, 3);

export const text = (value: string): SourceSlashCommand => (view) => {
  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: value },
    selection: EditorSelection.cursor(range.from + value.length),
    userEvent: "input.type",
    scrollIntoView: true,
  });
  view.focus();
  return true;
};

export const block = (markdown: string): SourceSlashCommand => (view) => (markdown ? insertBlock(view, markdown) : false);

export const tableOfContents: SourceSlashCommand = (view) => block(tocMarkdown(extractHeadings(view.state.doc.toString())))(view);

export const callout = (kind: CalloutKind): SourceSlashCommand => block(calloutMarkdown(kind));

/** `[^n]` at the caret and `[^n]: ` at the end of the document, with the caret after the definition marker. */
export const footnote: SourceSlashCommand = (view) => {
  const { state } = view;
  const label = nextFootnoteLabel(footnoteLabelsInSource(state.doc.toString()));
  const range = state.selection.main;
  const ref = `[^${label}]`;
  const end = state.doc.length;
  const tail = state.sliceDoc(Math.max(0, end - 2), end);
  const lead = end === 0 ? "" : tail.endsWith("\n\n") ? "" : tail.endsWith("\n") ? "\n" : "\n\n";
  const definition = `${lead}[^${label}]: `;
  view.dispatch({
    changes: [
      { from: range.from, to: range.to, insert: ref },
      { from: end, insert: definition },
    ],
    selection: EditorSelection.cursor(end + ref.length - (range.to - range.from) + definition.length),
    userEvent: "input.type",
    scrollIntoView: true,
  });
  view.focus();
  return true;
};

/** Selects the line around the caret, so a comment started from `/comment` anchors to it. */
export const selectLine: SourceSlashCommand = (view) => {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (line.to > line.from) view.dispatch({ selection: EditorSelection.range(line.from, line.to) });
  return true;
};

/** Whether the caret is in a GFM table, where block items are not offered. */
export function inTable(state: EditorState): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(state.selection.main.head, -1); node; node = node.parent) {
    if (node.name === "Table") return true;
  }
  return false;
}
