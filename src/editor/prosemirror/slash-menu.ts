import { Plugin, PluginKey, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { Mapping, ReplaceStep } from "prosemirror-transform";
import type { EditorView } from "prosemirror-view";
import { schema } from "../markdown/schema";
import { isEditable } from "./setup";

export interface SlashState {
  /** Position of the `/` character. */
  from: number;
  /** End of the typed query (the caret). */
  to: number;
  /** Text typed after the `/`. */
  query: string;
  /** Viewport coordinates of the `/`, for positioning the menu. */
  coords: { left: number; top: number; bottom: number };
}

export type SlashKey = "ArrowUp" | "ArrowDown" | "Enter" | "Tab";

export interface SlashMenuHandlers {
  /** Called whenever the menu should open, move, change its query or close. */
  onState: (state: SlashState | null) => void;
  /** Navigation keys while the menu is open; return false to let the key through. */
  onKey?: (key: SlashKey) => boolean;
}

interface Tracked {
  from: number;
  to: number;
  query: string;
}

export const slashMenuKey = new PluginKey<Tracked | null>("slashMenu");

const QUERY = /^[a-z0-9 -]*$/i;

/** True when `tr` is a single-character insertion of `/` typed by the local user. */
function typedSlash(tr: Transaction): boolean {
  if (tr.steps.length !== 1 || tr.getMeta("addToHistory") === false || tr.getMeta("paste")) return false;
  const step = tr.steps[0];
  if (!(step instanceof ReplaceStep) || step.from !== step.to) return false;
  const node = step.slice.content.firstChild;
  return step.slice.content.childCount === 1 && !!node && node.isText && node.text === "/";
}

/** Whether a `/` typed at `pos` (so the caret is at pos + 1) should open the menu. */
function slashOpensAt(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock || parent.type === schema.nodes.code_block) return false;
  if ($pos.parentOffset === 0) return true;
  const before = parent.textBetween($pos.parentOffset - 1, $pos.parentOffset, "\0", "\0");
  return /\s/.test(before);
}

function track(state: EditorState, from: number): Tracked | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $from = state.doc.resolve(Math.min(from, state.doc.content.size));
  if (!$from.parent.isTextblock || $from.parent.type === schema.nodes.code_block) return null;
  const head = selection.head;
  if (head <= from || state.doc.resolve(head).parent !== $from.parent) return null;
  const text = state.doc.textBetween(from, head, "\0", "\0");
  if (text[0] !== "/") return null;
  const query = text.slice(1);
  if (!QUERY.test(query) || /\s\s$/.test(query) || query.length > 40) return null;
  return { from, to: head, query };
}

export const closeSlashMenu = (view: EditorView) => {
  if (!slashMenuKey.getState(view.state)) return;
  view.dispatch(view.state.tr.setMeta(slashMenuKey, { close: true }));
};

/**
 * Transaction that removes the tracked `/query` and closes the menu, or null
 * when the menu is not open.
 */
function deleteQueryTransaction(view: EditorView): Transaction | null {
  const tracked = slashMenuKey.getState(view.state);
  if (!tracked) return null;
  return view.state.tr.delete(tracked.from, tracked.to).setMeta(slashMenuKey, { close: true });
}

/**
 * The part of the session's Y.UndoManager the menu needs. Capturing is
 * stopped around the application so the typed `/query` (before) and whatever
 * the user types next (after) stay separate undo steps instead of being merged
 * into the menu's edit by the undo manager's capture timeout.
 */
export interface UndoBoundary {
  stopCapturing(): void;
}

/**
 * Removes the `/query` and runs `command` in the SAME ProseMirror transaction.
 * The command sees the document without the query (a derived state), and its
 * steps are appended to the deletion, so the binding writes one diff to the
 * shared text and one undo reverts the whole choice regardless of timing.
 *
 * Returns what the command returned; the query is removed either way.
 */
export function applySlashCommand(view: EditorView, command: Command, undo?: UndoBoundary): boolean {
  undo?.stopCapturing();
  try {
    const tr = deleteQueryTransaction(view);
    if (!tr) return command(view.state, view.dispatch, view);
    // Plugins may append normalizing transactions to the deletion (tables);
    // fold those in so the command's steps apply to the document it was given.
    const { state: derived, transactions } = view.state.applyTransaction(tr);
    for (const appended of transactions.slice(1)) for (const step of appended.steps) tr.step(step);
    const ok = command(
      derived,
      (next) => {
        for (const step of next.steps) tr.step(step);
        tr.setSelection(next.selection.map(tr.doc, new Mapping()));
        if (next.storedMarksSet) tr.setStoredMarks(next.storedMarks);
        if (next.scrolledIntoView) tr.scrollIntoView();
      },
      view,
    );
    view.dispatch(tr);
    return ok;
  } finally {
    undo?.stopCapturing();
  }
}

/**
 * Removes the `/query` text and then runs `action`, for items that do not edit
 * the document themselves (dialogs, comments). Editing items should use
 * {@link applySlashCommand} so the edit is a single transaction.
 */
export function applySlashItem(view: EditorView, action: () => void, undo?: UndoBoundary) {
  undo?.stopCapturing();
  try {
    const tr = deleteQueryTransaction(view);
    if (tr) view.dispatch(tr);
    action();
  } finally {
    undo?.stopCapturing();
  }
}

/**
 * Notion-style `/` menu. Typing `/` at the start of a textblock or after
 * whitespace opens the menu; the text after the slash is the filter query. The
 * plugin tracks the range and keeps navigation keys away from other keymaps
 * while the menu is open; rendering lives in the React `SlashMenu` component.
 */
export function slashMenuPlugin(handlers: SlashMenuHandlers): Plugin<Tracked | null> {
  return new Plugin<Tracked | null>({
    key: slashMenuKey,
    state: {
      init: () => null,
      apply(tr, prev, _old, next) {
        const meta = tr.getMeta(slashMenuKey) as { close?: boolean } | undefined;
        if (meta?.close) return null;
        if (!isEditable(next)) return null;
        if (prev) {
          const from = tr.mapping.map(prev.from, -1);
          // If the slash itself was deleted, the mapped start no longer points at it.
          if (tr.docChanged && next.doc.textBetween(from, Math.min(from + 1, next.doc.content.size), "\0", "\0") !== "/") return null;
          return track(next, from);
        }
        if (!tr.docChanged || !typedSlash(tr)) return null;
        const head = next.selection.head;
        if (!next.selection.empty || head < 1 || !slashOpensAt(next, head - 1)) return null;
        return track(next, head - 1);
      },
    },
    props: {
      handleKeyDown(view, event) {
        if (!slashMenuKey.getState(view.state)) return false;
        if (event.key === "Escape") {
          closeSlashMenu(view);
          return true;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter" || event.key === "Tab") {
          if (event.altKey || event.ctrlKey || event.metaKey) return false;
          handlers.onKey?.(event.key);
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        blur(view) {
          // Closing on blur would race with clicks inside the menu; the menu itself
          // cancels mousedown, so only a real focus loss reaches here.
          setTimeout(() => {
            if (!view.isDestroyed && !view.hasFocus()) closeSlashMenu(view);
          }, 0);
          return false;
        },
      },
    },
    view() {
      let last: Tracked | null = null;
      return {
        update(view) {
          const tracked = slashMenuKey.getState(view.state) ?? null;
          if (tracked === last) return;
          if (last && tracked && last.from === tracked.from && last.to === tracked.to && last.query === tracked.query) {
            last = tracked;
            return;
          }
          last = tracked;
          if (!tracked) return handlers.onState(null);
          let coords: SlashState["coords"];
          try {
            const c = view.coordsAtPos(tracked.from);
            coords = { left: c.left, top: c.top, bottom: c.bottom };
          } catch {
            coords = { left: 0, top: 0, bottom: 0 };
          }
          handlers.onState({ ...tracked, coords });
        },
        destroy() {
          handlers.onState(null);
        },
      };
    },
  });
}

export function slashMenuState(state: EditorState): { from: number; to: number; query: string } | null {
  return slashMenuKey.getState(state) ?? null;
}
