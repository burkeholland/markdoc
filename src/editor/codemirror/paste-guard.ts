import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type * as Y from "yjs";
import { decideInsert, wrapInCodeFence } from "../markdown/renderable";
import { tsvToMarkdownTable, TSV_TABLE_NOTICE, type NoticeAction } from "../markdown/tsv";
import { inCodeBlock } from "./markdown-typing";

export interface CodePasteGuardOptions {
  onNotice?: (message: string, action?: NoticeAction) => void;
  /** Isolates a table paste as its own undo step; the toast's Undo reverts it. */
  undoManager?: Y.UndoManager;
}

/**
 * Pasted text that micromark would parse in quadratic time (see `renderable.ts`) is inserted
 * as a fenced code block, on its own lines, instead of as Markdown, so neither pane's parser
 * ever sees it. Tab-separated text with the same number of tabs on every line (≥ 2 lines) is
 * inserted as a GFM table. Ordinary text is left to CodeMirror's default paste.
 */
export function codePasteGuard(options: CodePasteGuardOptions = {}): Extension {
  const insertBlock = (view: EditorView, block: string) => {
    const range = view.state.selection.main;
    const doc = view.state.doc;
    const before = range.from > 0 && doc.sliceString(range.from - 1, range.from) !== "\n" ? "\n" : "";
    const after = range.to < doc.length && doc.sliceString(range.to, range.to + 1) !== "\n" ? "\n" : "";
    const insert = before + block + after;
    options.undoManager?.stopCapturing();
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.cursor(range.from + insert.length),
      userEvent: "input.paste",
      scrollIntoView: true,
    });
    options.undoManager?.stopCapturing();
  };

  return EditorView.domEventHandlers({
    paste(event, view) {
      if (!view.state.facet(EditorView.editable)) return false;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text.trim()) return false;
      const decision = decideInsert(text);
      if (decision.kind === "code") {
        event.preventDefault();
        insertBlock(view, wrapInCodeFence(text));
        options.onNotice?.(decision.message);
        return true;
      }
      // Inside a fenced code block the tabs are content; leave them alone.
      if (inCodeBlock(view.state, view.state.selection.main.from)) return false;
      const table = tsvToMarkdownTable(text);
      if (table === null) return false;
      event.preventDefault();
      insertBlock(view, table);
      options.onNotice?.(TSV_TABLE_NOTICE, {
        label: "Undo",
        onClick: () => {
          options.undoManager?.undo();
          options.undoManager?.stopCapturing();
        },
      });
      return true;
    },
  });
}
