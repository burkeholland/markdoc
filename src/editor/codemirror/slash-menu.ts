import { EditorSelection, Prec, StateEffect, StateField, type EditorState, type Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SlashKey, SlashMenuHandlers, SlashState, UndoBoundary } from "../prosemirror/slash-menu";

/**
 * The `/` menu of the Markdown source editor: the CodeMirror twin of `prosemirror/slash-menu.ts`. Typing
 * `/` at the start of a line or after whitespace opens it, outside code; the text after the slash is the
 * query. The same React `SlashMenu` renders it and takes the navigation keys through `handlers`.
 */

interface Tracked {
  from: number;
  to: number;
  query: string;
}

const closeEffect = StateEffect.define<null>();

const QUERY = /^[a-z0-9 -]*$/i;

/** Syntax nodes the menu never opens in: code, raw HTML, comments, front matter, link destinations. */
const NO_MENU = new Set(["FencedCode", "CodeBlock", "InlineCode", "CodeText", "HTMLBlock", "HTMLTag", "CommentBlock", "Comment", "URL", "Frontmatter", "YAMLFrontMatter"]);

function insideNoMenu(state: EditorState, pos: number): boolean {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (NO_MENU.has(node.name)) return true;
  }
  return false;
}

/** Whether a `/` at `pos` opens the menu: first on its line or after whitespace, and not in code. */
export function sourceSlashOpensAt(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  if (pos > line.from && !/\s/.test(line.text[pos - 1 - line.from])) return false;
  // Front matter is not in the Markdown tree; a document that starts with `---` keeps the menu out of it.
  if (/^---\s*$/.test(state.doc.line(1).text)) {
    for (let n = 2; n <= state.doc.lines; n++) {
      if (/^(---|\.\.\.)\s*$/.test(state.doc.line(n).text)) {
        if (line.number <= n) return false;
        break;
      }
    }
  }
  return !insideNoMenu(state, pos) && !insideNoMenu(state, pos + 1);
}

function typedSlash(tr: Transaction): boolean {
  if (!tr.docChanged || !tr.isUserEvent("input.type")) return false;
  let count = 0;
  let ok = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    count++;
    ok = fromA === toA && inserted.toString() === "/";
  });
  return count === 1 && ok;
}

function track(state: EditorState, from: number): Tracked | null {
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return null;
  const head = sel.main.head;
  if (from < 0 || head <= from || state.doc.lineAt(from).number !== state.doc.lineAt(head).number) return null;
  const text = state.sliceDoc(from, head);
  if (text[0] !== "/") return null;
  const query = text.slice(1);
  if (!QUERY.test(query) || /\s\s$/.test(query) || query.length > 40) return null;
  return { from, to: head, query };
}

export const sourceSlashField = StateField.define<Tracked | null>({
  create: () => null,
  update(value, tr) {
    if (tr.effects.some((e) => e.is(closeEffect))) return null;
    if (tr.state.readOnly) return null;
    if (value) {
      if (!tr.docChanged && !tr.selection) return value;
      const from = tr.changes.mapPos(value.from, 1);
      if (tr.state.sliceDoc(from, from + 1) !== "/") return null;
      return track(tr.state, from);
    }
    if (!typedSlash(tr)) return null;
    const head = tr.state.selection.main.head;
    if (head < 1 || !sourceSlashOpensAt(tr.state, head - 1)) return null;
    return track(tr.state, head - 1);
  },
});

export function sourceSlashState(state: EditorState): Tracked | null {
  return state.field(sourceSlashField, false) ?? null;
}

export function closeSourceSlashMenu(view: EditorView) {
  if (sourceSlashState(view.state)) view.dispatch({ effects: closeEffect.of(null) });
}

/**
 * Removes the `/query`, then runs `command` (a source slash command). The Y.UndoManager merges the two
 * transactions into one undo step; capturing stops around them so neither the typed query nor what is
 * typed next joins that step.
 */
export function applySourceSlash(view: EditorView, command: ((view: EditorView) => boolean) | null, undo?: UndoBoundary): boolean {
  undo?.stopCapturing();
  try {
    const tracked = sourceSlashState(view.state);
    if (tracked) {
      view.dispatch({
        changes: { from: tracked.from, to: tracked.to },
        selection: EditorSelection.cursor(tracked.from),
        effects: closeEffect.of(null),
        userEvent: "delete",
      });
    }
    return command ? command(view) : true;
  } finally {
    undo?.stopCapturing();
  }
}

const KEYS: readonly SlashKey[] = ["ArrowUp", "ArrowDown", "Home", "End", "Enter", "Tab"];

export function sourceSlashMenu(handlers: SlashMenuHandlers) {
  const keys = Prec.highest(
    keymap.of([
      ...KEYS.map((key) => ({
        key,
        run: (view: EditorView) => !!sourceSlashState(view.state) && handlers.onKey?.(key) === true,
      })),
      {
        key: "Escape",
        run: (view: EditorView) => {
          if (!sourceSlashState(view.state)) return false;
          closeSourceSlashMenu(view);
          return true;
        },
      },
    ]),
  );

  const notify = ViewPlugin.fromClass(
    class {
      last: Tracked | null = null;
      constructor(readonly view: EditorView) {}
      update(update: ViewUpdate) {
        const tracked = sourceSlashState(update.state);
        const same = tracked === this.last || (tracked && this.last && tracked.from === this.last.from && tracked.to === this.last.to && tracked.query === this.last.query);
        this.last = tracked;
        if (!tracked) {
          if (!same) handlers.onState(null);
          return;
        }
        // Re-measure on scroll and resize too, so the menu follows the `/`.
        if (same && !update.geometryChanged && !update.viewportChanged) return;
        this.measure();
      }
      measure() {
        this.view.requestMeasure({
          read: (view) => {
            const tracked = sourceSlashState(view.state);
            if (!tracked) return null;
            const c = view.coordsAtPos(tracked.from);
            return { ...tracked, coords: c ? { left: c.left, top: c.top, bottom: c.bottom } : { left: 0, top: 0, bottom: 0 } } satisfies SlashState;
          },
          write: (state) => {
            if (state) handlers.onState(state);
          },
        });
      }
      destroy() {
        handlers.onState(null);
      }
    },
    {
      eventHandlers: {
        scroll() {
          if (sourceSlashState(this.view.state)) this.measure();
        },
        blur() {
          // As in the rich editor: the menu cancels mousedown, so only a real focus loss closes it.
          setTimeout(() => {
            if (this.view.dom.isConnected && !this.view.hasFocus) closeSourceSlashMenu(this.view);
          }, 0);
        },
      },
    },
  );

  return [sourceSlashField, keys, notify];
}
