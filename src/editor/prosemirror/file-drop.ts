import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

const TEXT_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd", ".txt", ".text"];

/** True for Markdown / plain-text files we can read straight into the document. */
export function isMarkdownFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export function markdownFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  return Array.from(data.files ?? []).filter(isMarkdownFile);
}

/** Called with the dropped file and the ProseMirror position under the pointer (or the selection head). */
export type MarkdownFileDropHandler = (file: File, pos: number) => void;

export const fileDropKey = new PluginKey("markdownFileDrop");

function dropPosition(view: EditorView, event: DragEvent): number | null {
  try {
    return view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
  } catch {
    return null;
  }
}

/**
 * Dropping a `.md` / `.txt` file on the rich pane hands it to the shell (which asks
 * whether to replace, insert or open a new document) instead of letting the browser
 * navigate to the file. Image files are left to the image upload plugin.
 */
export function markdownFileDropPlugin(onDrop: MarkdownFileDropHandler): Plugin {
  return new Plugin({
    key: fileDropKey,
    props: {
      handleDrop(view, event, _slice, moved) {
        if (moved) return false;
        const [file] = markdownFiles(event.dataTransfer);
        if (!file) return false;
        event.preventDefault();
        onDrop(file, dropPosition(view, event) ?? view.state.selection.head);
        return true;
      },
    },
  });
}
