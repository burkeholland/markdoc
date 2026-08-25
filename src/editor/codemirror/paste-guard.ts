import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { decideInsert, wrapInCodeFence } from "../markdown/renderable";

export interface CodePasteGuardOptions {
  onNotice?: (message: string) => void;
}

/**
 * Pasted text that micromark would parse in quadratic time (see `renderable.ts`) is inserted
 * as a fenced code block, on its own lines, instead of as Markdown, so neither pane's parser
 * ever sees it. Ordinary text is left to CodeMirror's default paste.
 */
export function codePasteGuard(options: CodePasteGuardOptions = {}): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (!view.state.facet(EditorView.editable)) return false;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text.trim()) return false;
      const decision = decideInsert(text);
      if (decision.kind === "markdown") return false;
      event.preventDefault();
      const range = view.state.selection.main;
      const doc = view.state.doc;
      const before = range.from > 0 && doc.sliceString(range.from - 1, range.from) !== "\n" ? "\n" : "";
      const after = range.to < doc.length && doc.sliceString(range.to, range.to + 1) !== "\n" ? "\n" : "";
      const insert = before + wrapInCodeFence(text) + after;
      view.dispatch({
        changes: { from: range.from, to: range.to, insert },
        selection: EditorSelection.cursor(range.from + insert.length),
        userEvent: "input.paste",
        scrollIntoView: true,
      });
      options.onNotice?.(decision.message);
      return true;
    },
  });
}
