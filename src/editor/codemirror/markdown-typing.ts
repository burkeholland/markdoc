import { EditorSelection, EditorState, Prec, type Extension, type StateCommand } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";

/**
 * Markdown-aware typing for the code pane. Replaces JS-style bracket pairing with what a
 * Markdown author expects:
 *
 * - `(`, `[`, `{` and quotes still pair (through `closeBrackets`), the backtick never does.
 * - The third `` ` `` (or `~`) on an otherwise empty line opens a fenced block: `` ``` `` becomes
 *   `` ```⏎⏎``` `` with the caret after the opening fence, ready for the language. Enter there
 *   moves onto the empty line inside the block.
 * - `*`, `_` and `` ` `` wrap a selection (press `*` twice for `**bold**`); without a selection they
 *   insert a single character. `[` wraps a selection as `[text]()` with the caret inside the parens.
 * - Tab / Shift-Tab on a list line indent / outdent the item instead of inserting a tab.
 *
 * None of the Markdown rules fire inside a fenced or indented code block.
 */
export function markdownTyping(): Extension {
  return [
    // Language-scoped pairing list: same as the closeBrackets defaults, spelled out so the
    // backtick is never added to it.
    markdownLanguage.data.of({ closeBrackets: { brackets: ["(", "[", "{", "'", '"'] } }),
    Prec.high(EditorView.inputHandler.of(handleTyping)),
    Prec.high(
      keymap.of([
        { key: "Enter", run: enterAfterOpeningFence },
        { key: "Tab", run: indentListItem, shift: outdentListItem },
      ]),
    ),
  ];
}

const WRAP_CHARS = new Set(["*", "_", "`"]);
const FENCE_CHARS = new Set(["`", "~"]);
const FENCE_LINE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const LIST_LINE = /^(\s*)([-+*]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/;

/** True when `pos` is inside a fenced or indented code block (the fence lines count as inside). */
export function inCodeBlock(state: EditorState, pos: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") return true;
    node = node.parent;
  }
  return false;
}

function handleTyping(view: EditorView, from: number, to: number, insert: string): boolean {
  const { state } = view;
  if (view.compositionStarted || state.readOnly) return false;
  const sel = state.selection.main;
  if (insert.length !== 1 || from !== sel.from || to !== sel.to) return false;
  if (!WRAP_CHARS.has(insert) && !FENCE_CHARS.has(insert) && insert !== "[") return false;

  if (inCodeBlock(state, sel.from)) {
    // Inside a fence the nested language's closeBrackets config may pair the backtick; never do that.
    if (insert !== "`") return false;
    view.dispatch(state.replaceSelection(insert), { scrollIntoView: true, userEvent: "input.type" });
    return true;
  }

  if (sel.empty && FENCE_CHARS.has(insert)) {
    const tr = openFence(state, insert);
    if (tr) {
      view.dispatch(tr);
      return true;
    }
  }

  if (!sel.empty && (WRAP_CHARS.has(insert) || insert === "[")) {
    view.dispatch(wrapSelection(state, insert));
    return true;
  }
  return false;
}

/** `` `` `` + `` ` `` at line start → `` ```⏎⏎``` `` unless a closing fence already follows. */
function openFence(state: EditorState, ch: string) {
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const after = line.text.slice(pos - line.from);
  const indent = before.match(/^\s*/)![0];
  if (before !== indent + ch + ch || after.trim() !== "") return null;
  if (closingFenceFollows(state, line.number, ch)) return null;
  const fence = ch + ch + ch;
  return state.update({
    changes: { from: pos, to: line.to, insert: `${ch}\n${indent}\n${indent}${fence}` },
    selection: EditorSelection.cursor(pos + 1),
    scrollIntoView: true,
    userEvent: "input.type",
  });
}

/** True when the first fence line below `lineNumber` is a bare closing fence of the same kind (the block is already closed). */
function closingFenceFollows(state: EditorState, lineNumber: number, ch: string): boolean {
  for (let n = lineNumber + 1; n <= state.doc.lines; n++) {
    const m = FENCE_LINE.exec(state.doc.line(n).text);
    if (m) return m[2][0] === ch && m[3].trim() === "";
  }
  return false;
}

function wrapSelection(state: EditorState, ch: string) {
  const link = ch === "[";
  const changes = state.changeByRange((range) => {
    if (range.empty) return { changes: { from: range.from, insert: ch }, range: EditorSelection.cursor(range.from + 1) };
    if (link) {
      return {
        changes: [
          { from: range.from, insert: "[" },
          { from: range.to, insert: "]()" },
        ],
        range: EditorSelection.cursor(range.to + 3),
      };
    }
    return {
      changes: [
        { from: range.from, insert: ch },
        { from: range.to, insert: ch },
      ],
      range: EditorSelection.range(range.anchor + 1, range.head + 1),
    };
  });
  return state.update(changes, { scrollIntoView: true, userEvent: "input.type" });
}

/**
 * Enter at the end of an opening fence line whose block is still empty (`` ```ts⏎⏎``` ``, as left by
 * {@link openFence}) moves the caret onto the empty line instead of adding another one.
 */
export const enterAfterOpeningFence: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (state.selection.ranges.length !== 1 || !range.empty) return false;
  const line = state.doc.lineAt(range.head);
  if (range.head !== line.to || line.number + 2 > state.doc.lines) return false;
  const open = FENCE_LINE.exec(line.text);
  if (!open || /[`~]/.test(open[3])) return false;
  const empty = state.doc.line(line.number + 1);
  const close = FENCE_LINE.exec(state.doc.line(line.number + 2).text);
  if (empty.text.trim() !== "" || !close || close[2][0] !== open[2][0] || close[3].trim() !== "") return false;
  // Only an opening fence: a closing one would be the end of an earlier block.
  const tree = syntaxTree(state).resolveInner(line.from, 1);
  const fence = tree.name === "FencedCode" ? tree : tree.parent;
  if (fence?.name === "FencedCode" && fence.from !== line.from) return false;
  dispatch(state.update({ selection: EditorSelection.cursor(empty.to), scrollIntoView: true }));
  return true;
};

function listLinesInSelection(state: EditorState) {
  const lines: { from: number; text: string }[] = [];
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    // A range ending at the very start of a line does not include that line.
    const last = range.empty || state.doc.lineAt(range.to).from !== range.to ? state.doc.lineAt(range.to).number : state.doc.lineAt(range.to).number - 1;
    for (let n = first; n <= Math.max(first, last); n++) {
      const line = state.doc.line(n);
      if (lines.some((l) => l.from === line.from)) continue;
      if (!LIST_LINE.test(line.text) || inCodeBlock(state, line.from)) return null;
      lines.push({ from: line.from, text: line.text });
    }
  }
  return lines.length ? lines : null;
}

/** Width of the marker that a nested list needs to sit under: `- ` → 2, `1. ` → 3, `- [ ] ` → 2. */
function listIndentWidth(state: EditorState, lineFrom: number): number {
  const line = state.doc.lineAt(lineFrom);
  for (let n = line.number - 1; n >= 1; n--) {
    const text = state.doc.line(n).text;
    if (text.trim() === "") break;
    const m = LIST_LINE.exec(text);
    if (m && m[1].length <= (LIST_LINE.exec(line.text)?.[1].length ?? 0)) return m[2].length + m[3].length;
  }
  return 2;
}

/** Tab on list lines: nest the items one level deeper. Elsewhere falls through to `indentWithTab`. */
export const indentListItem: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const lines = listLinesInSelection(state);
  if (!lines) return false;
  dispatch(
    state.update({
      changes: lines.map((l) => ({ from: l.from, insert: " ".repeat(listIndentWidth(state, l.from)) })),
      scrollIntoView: true,
      userEvent: "input.indent",
    }),
  );
  return true;
};

/** Shift-Tab on list lines: remove one level of nesting (up to the marker width of leading spaces). */
export const outdentListItem: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const lines = listLinesInSelection(state);
  if (!lines) return false;
  const changes = lines.flatMap((l) => {
    const lead = /^[ \t]*/.exec(l.text)![0];
    if (!lead) return [];
    const width = lead.startsWith("\t") ? 1 : Math.min(lead.length, outdentWidth(state, l.from, lead.length));
    return [{ from: l.from, to: l.from + width }];
  });
  if (changes.length) dispatch(state.update({ changes, scrollIntoView: true, userEvent: "delete.dedent" }));
  return true;
};

/** How far to outdent: back to the nearest shallower list item's column, or the usual marker width. */
function outdentWidth(state: EditorState, lineFrom: number, indent: number): number {
  const line = state.doc.lineAt(lineFrom);
  for (let n = line.number - 1; n >= 1; n--) {
    const text = state.doc.line(n).text;
    if (text.trim() === "") break;
    const m = LIST_LINE.exec(text);
    if (m && m[1].length < indent) return indent - m[1].length;
  }
  return Math.min(indent, 2);
}
