import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

const editableKey = new PluginKey<{ canEdit: boolean }>("editable");

/** Plugin whose state tells the view whether editing is allowed; toggled with a meta transaction. */
export function editablePlugin(initial: boolean): Plugin<{ canEdit: boolean }> {
  return new Plugin({
    key: editableKey,
    state: {
      init: () => ({ canEdit: initial }),
      apply: (tr, value) => {
        const next = tr.getMeta(editableKey);
        return typeof next === "boolean" ? { canEdit: next } : value;
      },
    },
    props: {
      editable: (state) => editableKey.getState(state)?.canEdit ?? true,
    },
  });
}

export function setEditable(view: EditorView, canEdit: boolean) {
  view.dispatch(view.state.tr.setMeta(editableKey, canEdit).setMeta("addToHistory", false));
}

export function isEditable(state: EditorState): boolean {
  return editableKey.getState(state)?.canEdit ?? true;
}
