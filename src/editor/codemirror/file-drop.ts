import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownFiles, type MarkdownFileDropHandler } from "../prosemirror/file-drop";

/**
 * Dropping a `.md` / `.txt` file on the source pane hands it to the shell with the
 * source offset under the pointer; images are handled by {@link codeImageUpload}.
 */
export function codeMarkdownFileDrop(onDrop: MarkdownFileDropHandler): Extension {
  return EditorView.domEventHandlers({
    drop(event, view) {
      const [file] = markdownFiles(event.dataTransfer);
      if (!file) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      onDrop(file, pos);
      return true;
    },
  });
}
