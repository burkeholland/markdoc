import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

type ScrollStrategy = "nearest" | "start" | "end" | "center";

interface ScrollOptions {
  x: ScrollStrategy;
  y: ScrollStrategy;
  xMargin: number;
  yMargin: number;
}

export function shouldSuppressInactiveScroll(codeActive: boolean, options: ScrollOptions): boolean {
  return !codeActive && options.x === "nearest" && options.y === "nearest" && options.xMargin === 5 && options.yMargin === 5;
}

/**
 * y-codemirror restores every saved selection with a scroll effect. A shared UndoManager also
 * contains edits made in Rich, where CodeMirror's saved selection is stale and must not move the
 * inactive pane (or drive synchronized scrolling back into Rich).
 */
export function preserveInactiveUndoScroll(isCodeActive: () => boolean): Extension {
  return EditorView.scrollHandler.of((_view, _range, options) => shouldSuppressInactiveScroll(isCodeActive(), options));
}
