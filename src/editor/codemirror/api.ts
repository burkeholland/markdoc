import type { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as commands from "./commands";

/**
 * The CodeMirror *values* the rest of the editor needs while the code pane is mounted. The pane hands
 * one of these up together with its view (`onReady(view, api)`), so `actions.ts` and `scroll-sync.ts`
 * import only types from `@codemirror/*` and `@/editor/codemirror/*`. Types are erased at build time:
 * this file and everything it reaches stay in the code pane's lazily loaded chunk instead of the
 * editor's first-load JavaScript (task #1121).
 */
export interface CodeApi {
  /** `EditorView.scrollIntoView`: a state effect that scrolls `pos` to the given vertical alignment. */
  scrollIntoView(pos: number, opts: { y: "center" | "start"; yMargin?: number }): StateEffect<unknown>;
  /** The Markdown source commands (`@/editor/codemirror/commands`). */
  commands: typeof commands;
}

export function createCodeApi(): CodeApi {
  return {
    scrollIntoView: (pos, opts) => EditorView.scrollIntoView(pos, opts),
    commands,
  };
}
