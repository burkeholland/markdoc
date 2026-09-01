import { EditorState, Plugin, PluginKey, TextSelection, type Command } from "prosemirror-state";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, chainCommands, newlineInCode, createParagraphNear, liftEmptyBlock, splitBlock, exitCode } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { tableEditing } from "prosemirror-tables";
import * as Y from "yjs";
import { schema } from "../markdown/schema";
import { markdownBindingKey, markdownBindingPlugin } from "../sync/markdown-binding";
import type { CollabSession } from "../collab/session";
import { markdownInputRules } from "./inputrules";
import { codeHighlightPlugin } from "./code-highlight";
import { remoteCursorsPlugin } from "./remote-cursors";
import { richHighlightsPlugin, richSuggestingPlugin, type HighlightHandlers } from "./highlights";
import { smartPastePlugin } from "./paste";
import { imageUploadPlugin, type ImageUploader } from "./images";
import { markdownFileDropPlugin, type MarkdownFileDropHandler } from "./file-drop";
import { slashMenuPlugin, type SlashMenuHandlers } from "./slash-menu";
import { editablePlugin, isEditable } from "./editable";
import type { NoticeAction } from "../markdown/tsv";
import {
  toggleMark,
  setHeadingLevel,
  toggleList,
  toggleBlockquote,
  toggleCodeBlock,
  sinkListItem,
  liftListItem,
  insertHardBreak,
  liftFirstListItemOnBackspace,
  deleteEmptyLaterListItemOnBackspace,
  goToNextCell,
  addRowBefore,
  addRowAfter,
  addColumnBefore,
  addColumnAfter,
  deleteRow,
  deleteColumn,
  addRowOnEnterAtEnd,
  deleteEmptyTableOnBackspace,
  liftEmptyQuoteParagraph,
  liftFirstQuoteParagraphOnBackspace,
  codeBlockToParagraphOnBackspace,
  headingToParagraphOnBackspace,
  splitListItemUnchecked,
  exitCodeBlockOnTripleEnter,
  exitTableBelow,
  exitTableOnArrowDown,
  codeFenceOnEnter,
  toggleTaskAtCaret,
  tableAt,
} from "./commands";

export interface RichEditorHandlers extends HighlightHandlers {
  onFocus?: () => void;
  onSelection?: (head: number, anchor: number) => void;
  onLinkShortcut?: () => void;
  onCommentShortcut?: () => void;
  /** Uploads a pasted or dropped image file; when absent, image files are left to the browser. */
  uploadImage?: ImageUploader;
  onImageError?: (message: string) => void;
  /** Non-blocking notice for the user (a toast), e.g. when pasted text had to be inserted as code. */
  onNotice?: (message: string, action?: NoticeAction) => void;
  /** A dropped .md/.txt file with the position under the pointer; when absent the browser handles the drop. */
  onMarkdownFileDrop?: MarkdownFileDropHandler;
  /** Slash command menu (`/`) state and navigation; when absent the menu is disabled. */
  slashMenu?: SlashMenuHandlers;
}

// The editable plugin lives in the leaf `./editable` so that `slash-menu.ts` can read it without importing this module.
export { editablePlugin, setEditable, isEditable } from "./editable";

const tableMenuKey = new PluginKey<{ hidden: boolean }>("tableMenu");

/** Fired on the editor's DOM element when Esc hides the floating table menu or a selection change shows it again. */
export const TABLE_MENU_EVENT = "markdoc:table-menu";

interface VerticalRect {
  top: number;
  bottom: number;
}

/** Smallest scroll delta that fully reveals `target` inside `viewport`. */
export function minimalVerticalScroll(viewport: VerticalRect, target: VerticalRect): number {
  if (target.top < viewport.top) return target.top - viewport.top;
  if (target.bottom > viewport.bottom) return target.bottom - viewport.bottom;
  return 0;
}

function owningVerticalScroller(dom: HTMLElement): HTMLElement | null {
  for (let element = dom.parentElement; element; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight) return element;
  }
  return null;
}

function revealRichSelection(view: import("prosemirror-view").EditorView) {
  const scroller = owningVerticalScroller(view.dom);
  if (!scroller) return;
  const delta = minimalVerticalScroll(scroller.getBoundingClientRect(), view.coordsAtPos(view.state.selection.head));
  if (delta !== 0) scroller.scrollTop += delta;
}

/**
 * Whether Esc hid the floating table menu (issue #163). The menu is a React component that keys off the
 * selection, so the hidden flag lives in plugin state: a meta transaction sets it, any explicit selection
 * change (caret moves, typing, leaving the table) clears it, and the view announces each flip on
 * `view.dom` so the component can re-read the state.
 */
export function tableMenuPlugin(): Plugin<{ hidden: boolean }> {
  return new Plugin<{ hidden: boolean }>({
    key: tableMenuKey,
    state: {
      init: () => ({ hidden: false }),
      apply: (tr, value) => {
        if (tr.getMeta(tableMenuKey) === "hide") return { hidden: true };
        return value.hidden && tr.selectionSet ? { hidden: false } : value;
      },
    },
    view() {
      return {
        update(view, prevState) {
          if (isTableMenuHidden(view.state) !== isTableMenuHidden(prevState)) view.dom.dispatchEvent(new CustomEvent(TABLE_MENU_EVENT));
        },
      };
    },
  });
}

export function isTableMenuHidden(state: EditorState): boolean {
  return tableMenuKey.getState(state)?.hidden ?? false;
}

/**
 * Esc in the rich pane (issue #163), in this order: a non-empty selection collapses to its head (the
 * selection bubble keys off the selection, so it goes away); otherwise, with the caret in a table whose
 * floating menu is showing, the menu hides until the selection moves; otherwise the key is not handled,
 * so nothing else changes. The slash menu's own Esc runs before this (its plugin precedes the keymap),
 * following a collaborator stops on a window-level capture listener, and the find bar's Esc is handled
 * inside the bar, so none of those are affected.
 */
export const escapeFloatingUi: Command = (state, dispatch) => {
  const { selection } = state;
  if (!selection.empty) {
    dispatch?.(state.tr.setSelection(TextSelection.near(selection.$head)));
    return true;
  }
  if (isEditable(state) && tableAt(state) && !isTableMenuHidden(state)) {
    dispatch?.(state.tr.setMeta(tableMenuKey, "hide").setMeta("addToHistory", false));
    return true;
  }
  return false;
};

export type UndoSelectionSession = Pick<CollabSession, "activeSurface" | "binding" | "ydoc" | "ytext" | "undoManager">;

interface RelativeSelection {
  anchor: Y.RelativePosition;
  head: Y.RelativePosition;
}

interface UndoSelectionMeta {
  undo: RelativeSelection;
  redo: RelativeSelection;
}

/** Restores the rich editor's selection after undo/redo driven by the shared Y.UndoManager. */
export function undoSelectionPlugin(session: UndoSelectionSession): Plugin {
  const metaKey = { name: "richSelection" };
  return new Plugin({
    view(view) {
      let lastSelection: RelativeSelection | null = null;
      const relativeSelection = (): RelativeSelection => {
        const map = session.binding.getSourceMap();
        const { anchor, head } = view.state.selection;
        const sourceAnchor = map.pmToSrc(anchor);
        const sourceHead = map.pmToSrc(head);
        return {
          anchor: Y.createRelativePositionFromTypeIndex(session.ytext, sourceAnchor),
          head: Y.createRelativePositionFromTypeIndex(session.ytext, sourceHead),
        };
      };
      const rememberSelection = () => {
        if (view.hasFocus()) lastSelection = relativeSelection();
      };
      const saveSelection = ({ stackItem, origin }: { stackItem: Y.UndoManager["undoStack"][number]; origin: unknown }) => {
        if (!view.hasFocus() || origin === session.undoManager) return;
        const current = lastSelection ?? relativeSelection();
        const saved = stackItem.meta.get(metaKey) as UndoSelectionMeta | undefined;
        stackItem.meta.set(metaKey, {
          undo: saved?.undo ?? lastSelection ?? current,
          redo: saved?.redo ?? current,
        });
      };
      const onPopped = ({ stackItem, type }: { stackItem: Y.UndoManager["undoStack"][number]; type: "undo" | "redo" }) => {
        const meta = stackItem.meta.get(metaKey) as UndoSelectionMeta | undefined;
        const destinationStack = type === "undo" ? session.undoManager.redoStack : session.undoManager.undoStack;
        if (meta) destinationStack.at(-1)?.meta.set(metaKey, meta);
        const saved = meta?.[type];
        if (!saved || session.activeSurface !== "rich") return;
        // Restore after every Yjs observer and editor plugin has processed the text change.
        queueMicrotask(() => {
          if (view.isDestroyed) return;
          const map = session.binding.getSourceMap();
          const a = Y.createAbsolutePositionFromRelativePosition(saved.anchor, session.ydoc);
          const h = Y.createAbsolutePositionFromRelativePosition(saved.head, session.ydoc);
          if (!a || !h) return;
          const size = view.state.doc.content.size;
          const anchor = Math.max(0, Math.min(size, map.srcToPm(a.index)));
          const head = Math.max(0, Math.min(size, map.srcToPm(h.index)));
          view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(anchor), view.state.doc.resolve(head))));
          revealRichSelection(view);
        });
      };
      session.undoManager.on("stack-item-added", saveSelection);
      session.undoManager.on("stack-item-updated", saveSelection);
      session.undoManager.on("stack-item-popped", onPopped);
      view.dom.addEventListener("focus", rememberSelection);
      return {
        update(nextView, previousState) {
          if (!nextView.hasFocus()) return;
          if (nextView.state.doc !== previousState.doc && !markdownBindingKey.getState(nextView.state)?.remote) {
            queueMicrotask(() => {
              if (view.isDestroyed || !view.hasFocus()) return;
              const stackItem = session.undoManager.undoStack.at(-1);
              const saved = stackItem?.meta.get(metaKey) as UndoSelectionMeta | undefined;
              if (stackItem && saved) stackItem.meta.set(metaKey, { ...saved, redo: relativeSelection() });
            });
          }
          if (nextView.state.selection !== previousState.selection || nextView.state.doc !== previousState.doc) rememberSelection();
        },
        destroy() {
          session.undoManager.off("stack-item-added", saveSelection);
          session.undoManager.off("stack-item-updated", saveSelection);
          session.undoManager.off("stack-item-popped", onPopped);
          view.dom.removeEventListener("focus", rememberSelection);
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

  // Enter leaves every block the same way (task #415): an empty list item / quote paragraph lifts
  // out, a code block exits after two empty trailing lines, the end of a heading gives a paragraph
  // (splitBlock picks the parent's default block type), otherwise the block splits. A paragraph
  // that reads ```lang opens a code block instead (task #437).
  const enter = chainCommands(
    codeFenceOnEnter,
    splitListItemUnchecked,
    liftEmptyQuoteParagraph,
    exitCodeBlockOnTripleEnter,
    newlineInCode,
    createParagraphNear,
    liftEmptyBlock,
    splitBlock,
  );
  // Shift+Enter: a hard break where Markdown has one (paragraphs, list items, quotes, cells);
  // headings cannot hold a line break, so there it acts like Enter.
  const lineBreak = chainCommands(exitCode, insertHardBreak(), enter);
  const backspace = chainCommands(
    deleteEmptyTableOnBackspace,
    liftFirstListItemOnBackspace,
    deleteEmptyLaterListItemOnBackspace,
    liftFirstQuoteParagraphOnBackspace,
    codeBlockToParagraphOnBackspace,
    headingToParagraphOnBackspace,
    baseKeymap.Backspace,
  );
  const isolatedBackspace: Command = (state, dispatch, view) => {
    session.undoManager.stopCapturing();
    return backspace(state, dispatch, view);
  };

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
    "Shift-Enter": guard(lineBreak),
    "Mod-Enter": guard(chainCommands(exitCode, exitTableBelow, toggleTaskAtCaret, insertHardBreak())),
    // Not guarded: commenters get the selection bubble too, so Esc must collapse their selection as well.
    Escape: escapeFloatingUi,
    ArrowDown: guard(exitTableOnArrowDown),
    // Tab in the bottom-right cell adds a row (every table editor does; without it the key fell
    // through to the browser and moved focus out of the editor — task #437).
    Tab: guard(chainCommands(goToNextCell(1), addRowOnEnterAtEnd, sinkListItem(schema.nodes.list_item))),
    "Shift-Tab": guard(chainCommands(goToNextCell(-1), liftListItem(schema.nodes.list_item))),
    Backspace: guard(isolatedBackspace),
  });

  const guardedBase: Record<string, Command> = {};
  for (const [k, cmd] of Object.entries(baseKeymap)) guardedBase[k] = guard(cmd);

  return EditorState.create({
    doc: session.binding.initialDoc(),
    plugins: [
      editablePlugin(session.canEdit),
      tableMenuPlugin(),
      ...(handlers.slashMenu ? [slashMenuPlugin(handlers.slashMenu)] : []),
      markdownBindingPlugin(session.binding),
      richSuggestingPlugin(session),
      markdownInputRules(),
      ...(handlers.uploadImage ? [imageUploadPlugin(session, handlers.uploadImage, { onError: handlers.onImageError })] : []),
      ...(handlers.onMarkdownFileDrop ? [markdownFileDropPlugin(handlers.onMarkdownFileDrop)] : []),
      smartPastePlugin(session, { onNotice: handlers.onNotice }),
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
            "aria-label": "Rich text editor",
            // The pane's scroll container (editor-shell) has no focusable child other than this
            // contenteditable. An explicit tabindex does not add a tab stop (contenteditable is
            // already one) but lets axe's scrollable-region-focusable see it; reasoning in
            // src/editor/codemirror/setup.ts next to the same attribute on `.cm-content`.
            tabindex: "0",
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
