import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { altFromFileName, imageFiles, type ImageUploader } from "../prosemirror/images";

export interface CodeImageOptions {
  onError?: (message: string, file: File) => void;
}

interface CodeImageSession {
  readonly canEdit: boolean;
  readonly ytext: Y.Text;
}

/**
 * Paste or drop image files into the Markdown source. The file uploads first and
 * `![alt](url)` is inserted where the cursor (or drop point) was; the position is
 * remembered relative to the shared text so it survives edits made meanwhile.
 */
export function codeImageUpload(session: CodeImageSession, upload: ImageUploader, options: CodeImageOptions = {}): Extension {
  function insertAt(view: EditorView, pos: number, files: File[]) {
    const clamped = Math.min(Math.max(pos, 0), view.state.doc.length);
    const anchor = session.ytext.doc ? Y.createRelativePositionFromTypeIndex(session.ytext, clamped) : null;
    for (const file of files) {
      upload(file).then(
        ({ url, alt }) => {
          const resolved = anchor && session.ytext.doc ? Y.createAbsolutePositionFromRelativePosition(anchor, session.ytext.doc) : null;
          const at = Math.min(resolved?.index ?? clamped, view.state.doc.length);
          const before = at > 0 ? view.state.doc.sliceString(at - 1, at) : "";
          const after = view.state.doc.sliceString(at, at + 1);
          const insert = `${before && !/\s/.test(before) ? " " : ""}![${alt ?? altFromFileName(file.name)}](${url})${after && !/\s/.test(after) ? " " : ""}`;
          try {
            view.dispatch({ changes: { from: at, insert }, selection: EditorSelection.cursor(at + insert.length), userEvent: "input.paste", scrollIntoView: true });
          } catch {
            // The view was destroyed while the upload was in flight.
          }
        },
        (err: unknown) => options.onError?.(err instanceof Error ? err.message : "Upload failed", file),
      );
    }
  }

  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = imageFiles(event.clipboardData);
      if (!files.length || !session.canEdit) return false;
      event.preventDefault();
      const range = view.state.selection.main;
      if (!range.empty) view.dispatch({ changes: { from: range.from, to: range.to, insert: "" }, selection: EditorSelection.cursor(range.from) });
      insertAt(view, range.from, files);
      return true;
    },
    drop(event, view) {
      const files = imageFiles(event.dataTransfer);
      if (!files.length || !session.canEdit) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      insertAt(view, pos, files);
      return true;
    },
  });
}
