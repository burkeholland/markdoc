import { EditorState, Plugin, PluginKey, TextSelection, type Command } from "prosemirror-state";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, chainCommands, newlineInCode, createParagraphNear, liftEmptyBlock, splitBlock, exitCode } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { tableEditing } from "prosemirror-tables";
import * as Y from "yjs";
import { schema } from "../markdown/schema";
import { markdownBindingPlugin } from "../sync/markdown-binding";
import type { CollabSession } from "../collab/session";
import { markdownInputRules } from "./inputrules";
import { codeHighlightPlugin } from "./code-highlight";
import { remoteCursorsPlugin } from "./remote-cursors";
import { richHighlightsPlugin, richSuggestingPlugin, type HighlightHandlers } from "./highlights";
import { smartPastePlugin } from "./paste";
import { imageUploadPlugin, type ImageUploader } from "./images";
import { markdownFileDropPlugin, type MarkdownFileDropHandler } from "./file-drop";
import { slashMenuPlugin, type SlashMenuHandlers } from "./slash-menu";
import {
  toggleMark,
  setHeadingLevel,
  toggleList,
  toggleBlockquote,
  toggleCodeBlock,
  splitListItem,
  sinkListItem,
  liftListItem,
  insertHardBreak,
  liftEmptyListItemOnBackspace,
  goToNextCell,
  addRowBefore,
  addRowAfter,
  addColumnBefore,
  addColumnAfter,
  deleteRow,
  deleteColumn,
  addRowOnEnterAtEnd,
  deleteEmptyTableOnBackspace,
} from "./commands";

export interface RichEditorHandlers extends HighlightHandlers {
  onFocus?: () => void;
  onSelection?: (head: number, anchor: number) => void;
  onLinkShortcut?: () => void;
  onCommentShortcut?: () => void;
  /** Uploads a pasted or dropped image file; when absent, image files are left to the browser. */
  uploadImage?: ImageUploader;
  onImageError?: (message: string) => void;
  /** A dropped .md/.txt file with the position under the pointer; when absent the browser handles the drop. */
  onMarkdownFileDrop?: MarkdownFileDropHandler;
  /** Slash command menu (`/`) state and navigation; when absent the menu is disabled. */
  slashMenu?: SlashMenuHandlers;
}

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

export function setEditable(view: import("prosemirror-view").EditorView, canEdit: boolean) {
  view.dispatch(view.state.tr.setMeta(editableKey, canEdit).setMeta("addToHistory", false));
}

export function isEditable(state: EditorState): boolean {
  return editableKey.getState(state)?.canEdit ?? true;
}

/** Restores the rich editor's selection after undo/redo driven by the shared Y.UndoManager. */
function undoSelectionPlugin(session: CollabSession): Plugin {
  const metaKey = { name: "richSelection" };
  return new Plugin({
    view(view) {
      const onAdded = ({ stackItem }: { stackItem: Y.UndoManager["undoStack"][number] }) => {
        if (!view.hasFocus()) return;
        const map = session.binding.getSourceMap();
        const { anchor, head } = view.state.selection;
        stackItem.meta.set(metaKey, {
          anchor: Y.createRelativePositionFromTypeIndex(session.ytext, map.pmToSrc(anchor)),
          head: Y.createRelativePositionFromTypeIndex(session.ytext, map.pmToSrc(head)),
        });
      };
      const onPopped = ({ stackItem }: { stackItem: Y.UndoManager["undoStack"][number] }) => {
        const saved = stackItem.meta.get(metaKey) as { anchor: Y.RelativePosition; head: Y.RelativePosition } | undefined;
        if (!saved || session.activeSurface !== "rich") return;
        // The binding applies the text change on a microtask; restore after it.
        queueMicrotask(() => {
          if (view.isDestroyed) return;
          const map = session.binding.getSourceMap();
          const a = Y.createAbsolutePositionFromRelativePosition(saved.anchor, session.ydoc);
          const h = Y.createAbsolutePositionFromRelativePosition(saved.head, session.ydoc);
          if (!a || !h) return;
          const size = view.state.doc.content.size;
          const anchor = Math.min(size, map.srcToPm(a.index));
          const head = Math.min(size, map.srcToPm(h.index));
          try {
            view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(anchor), view.state.doc.resolve(head))).scrollIntoView());
          } catch {
            /* positions no longer valid */
          }
        });
      };
      session.undoManager.on("stack-item-added", onAdded);
      session.undoManager.on("stack-item-popped", onPopped);
      return {
        destroy() {
          session.undoManager.off("stack-item-added", onAdded);
          session.undoManager.off("stack-item-popped", onPopped);
        },
      };
    },
  });
}

function guard(command: Command): Command {
  return (state, dispatch, view) => (isEditable(state) ? command(state, dispatch, view) : false);
}

export function createRichEditorState(session: CollabSession, handlers: RichEditorHandlers = {}): EditorState {
  const undo: Command = () => {
    session.undo();
    return true;
  };
  const redo: Command = () => {
    session.redo();
    return true;
  };

  const enter = chainCommands(splitListItem(schema.nodes.list_item), newlineInCode, createParagraphNear, liftEmptyBlock, splitBlock);

  const shortcuts = keymap({
    "Mod-z": undo,
    "Mod-y": redo,
    "Mod-Shift-z": redo,
    "Mod-b": guard(toggleMark(schema.marks.strong)),
    "Mod-i": guard(toggleMark(schema.marks.em)),
    "Mod-`": guard(toggleMark(schema.marks.code)),
    "Mod-Shift-x": guard(toggleMark(schema.marks.strikethrough)),
    "Mod-k": () => {
      handlers.onLinkShortcut?.();
      return true;
    },
    "Mod-Alt-m": () => {
      handlers.onCommentShortcut?.();
      return true;
    },
    "Mod-Alt-0": guard(setHeadingLevel(0)),
    "Mod-Alt-1": guard(setHeadingLevel(1)),
    "Mod-Alt-2": guard(setHeadingLevel(2)),
    "Mod-Alt-3": guard(setHeadingLevel(3)),
    "Mod-Alt-4": guard(setHeadingLevel(4)),
    "Mod-Alt-5": guard(setHeadingLevel(5)),
    "Mod-Alt-6": guard(setHeadingLevel(6)),
    "Mod-Shift-7": guard(toggleList("ordered")),
    "Mod-Shift-8": guard(toggleList("bullet")),
    "Mod-Shift-9": guard(toggleList("task")),
    "Mod-Shift-.": guard(toggleBlockquote()),
    "Mod-Alt-c": guard(toggleCodeBlock()),
    "Mod-Alt-ArrowDown": guard(addRowAfter),
    "Mod-Alt-ArrowUp": guard(addRowBefore),
    "Mod-Alt-ArrowRight": guard(addColumnAfter),
    "Mod-Alt-ArrowLeft": guard(addColumnBefore),
    "Mod-Alt-Backspace": guard(deleteRow),
    "Mod-Alt-Shift-Backspace": guard(deleteColumn),
    Enter: guard(chainCommands(addRowOnEnterAtEnd, enter)),
    "Shift-Enter": guard(chainCommands(exitCode, insertHardBreak())),
    "Mod-Enter": guard(chainCommands(exitCode, insertHardBreak())),
    Tab: guard(chainCommands(goToNextCell(1), sinkListItem(schema.nodes.list_item))),
    "Shift-Tab": guard(chainCommands(goToNextCell(-1), liftListItem(schema.nodes.list_item))),
    Backspace: guard(chainCommands(deleteEmptyTableOnBackspace, liftEmptyListItemOnBackspace, baseKeymap.Backspace)),
  });

  const guardedBase: Record<string, Command> = {};
  for (const [k, cmd] of Object.entries(baseKeymap)) guardedBase[k] = guard(cmd);

  return EditorState.create({
    doc: session.binding.initialDoc(),
    plugins: [
      editablePlugin(session.canEdit),
      ...(handlers.slashMenu ? [slashMenuPlugin(handlers.slashMenu)] : []),
      markdownBindingPlugin(session.binding),
      richSuggestingPlugin(session),
      markdownInputRules(),
      ...(handlers.uploadImage ? [imageUploadPlugin(session, handlers.uploadImage, { onError: handlers.onImageError })] : []),
      ...(handlers.onMarkdownFileDrop ? [markdownFileDropPlugin(handlers.onMarkdownFileDrop)] : []),
      smartPastePlugin(session),
      shortcuts,
      keymap(guardedBase),
      dropCursor({ color: "#2563eb", width: 2 }),
      gapCursor(),
      tableEditing(),
      codeHighlightPlugin(),
      remoteCursorsPlugin(session),
      richHighlightsPlugin(session, handlers),
      undoSelectionPlugin(session),
      new Plugin({
        props: {
          handleDOMEvents: {
            focus: () => {
              handlers.onFocus?.();
              return false;
            },
          },
          attributes: (state) => ({
            class: "md-rich" + (state.doc.textContent.length > 0 || state.doc.childCount > 1 ? " md-has-content" : ""),
            "data-placeholder": "Start writing…",
            spellcheck: "true",
            role: "textbox",
            "aria-multiline": "true",
            "aria-label": "Document",
          }),
        },
        view() {
          return {
            update(view, prevState) {
              if (view.state.selection !== prevState.selection && view.hasFocus()) {
                const { head, anchor } = view.state.selection;
                handlers.onSelection?.(head, anchor);
              }
            },
          };
        },
      }),
    ],
  });
}
