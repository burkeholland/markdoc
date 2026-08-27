import { EditorSelection, Prec, type StateCommand } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";

// `nonTightLists: false` makes Enter on an empty `- ` / `1. ` / `- [ ] ` line drop the
// marker instead of inserting a blank line above it (which kept the caret in the list).
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/** A line made only of blockquote markers: `>`, `> `, `> > `, ` >` … */
const EMPTY_QUOTE_LINE = /^(\s*>)+\s*$/;

/**
 * Enter in the code pane. Continues quote and list markup like GitHub / VS Code, with one fix
 * over the stock `insertNewlineContinueMarkup`: Enter on an empty `> ` line removes one level of
 * quote marker right away (stock behaviour needs two empty quoted lines before it exits).
 */
export const exitOrContinueMarkup: StateCommand = (target) => {
  const { state, dispatch } = target;
  const range = state.selection.main;
  if (state.selection.ranges.length === 1 && range.empty) {
    const line = state.doc.lineAt(range.head);
    if (EMPTY_QUOTE_LINE.test(line.text) && range.head === line.to) {
      const lastMark = line.text.lastIndexOf(">");
      const from = line.from + line.text.slice(0, lastMark).trimEnd().length;
      const keep = state.doc.sliceString(line.from, from).trim().length > 0;
      const insert = keep ? " " : "";
      dispatch(
        state.update({
          changes: { from, to: line.to, insert },
          selection: EditorSelection.cursor(from + insert.length),
          scrollIntoView: true,
          userEvent: "delete",
        }),
      );
      return true;
    }
  }
  return continueMarkup(target);
};

/** Starts a new undo step before Markdown-specific or fallback Backspace handling. */
export function isolatedMarkdownBackspace(beforeBackspace: () => void = () => {}): StateCommand {
  return (target) => {
    beforeBackspace();
    return deleteMarkupBackward(target);
  };
}

/** Replaces lang-markdown's built-in keymap (`addKeymap: false`) with the same precedence. */
export function createMarkdownEditingKeymap(beforeBackspace: () => void = () => {}) {
  return Prec.high(
    keymap.of([
      { key: "Enter", run: exitOrContinueMarkup },
      { key: "Backspace", run: isolatedMarkdownBackspace(beforeBackspace) },
    ]),
  );
}

export const markdownEditingKeymap = createMarkdownEditingKeymap();
