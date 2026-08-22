import { EditorSelection, type ChangeSpec, type EditorState, type SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

/**
 * Markdown-aware editing commands for the source pane. They mirror the rich
 * editor commands so the toolbar behaves the same on both surfaces.
 */

export type InlineMarker = "**" | "*" | "`" | "~~";

function wordRangeAt(state: EditorState, pos: number): { from: number; to: number } {
  const line = state.doc.lineAt(pos);
  const text = line.text;
  let from = pos - line.from;
  let to = from;
  while (from > 0 && /[\p{L}\p{N}_'-]/u.test(text[from - 1])) from--;
  while (to < text.length && /[\p{L}\p{N}_'-]/u.test(text[to])) to++;
  return { from: line.from + from, to: line.from + to };
}

/** Wrap or unwrap the selection (or the word at the cursor) with an inline marker. */
export function toggleInlineMark(marker: InlineMarker) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const len = marker.length;
    const changes = state.changeByRange((range) => {
      let { from, to } = range;
      if (from === to) {
        const word = wordRangeAt(state, from);
        from = word.from;
        to = word.to;
      }
      const before = state.sliceDoc(Math.max(0, from - len), from);
      const after = state.sliceDoc(to, to + len);
      const inner = state.sliceDoc(from, to);
      // Unwrap when the selection is wrapped or contains the marker at both ends.
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: from - len, to: from, insert: "" },
            { from: to, to: to + len, insert: "" },
          ],
          range: EditorSelection.range(from - len, to - len),
        };
      }
      if (inner.length >= len * 2 && inner.startsWith(marker) && inner.endsWith(marker)) {
        return {
          changes: { from, to, insert: inner.slice(len, inner.length - len) },
          range: EditorSelection.range(from, to - len * 2),
        };
      }
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: from === to ? EditorSelection.cursor(from + len) : EditorSelection.range(from + len, to + len),
      };
    });
    view.dispatch(changes, { scrollIntoView: true, userEvent: "input.format" });
    view.focus();
    return true;
  };
}

const HEADING_RE = /^(\s{0,3})(#{1,6})\s+/;

/** Set (level 1-6) or clear (level 0) the ATX heading marker on the selected lines. */
export function setHeading(level: number) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const changes: ChangeSpec[] = [];
    const seen = new Set<number>();
    for (const range of state.selection.ranges) {
      const fromLine = state.doc.lineAt(range.from).number;
      const toLine = state.doc.lineAt(range.to).number;
      for (let n = fromLine; n <= toLine; n++) {
        if (seen.has(n)) continue;
        seen.add(n);
        const line = state.doc.line(n);
        const m = HEADING_RE.exec(line.text);
        const prefix = level > 0 ? "#".repeat(level) + " " : "";
        if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: prefix });
        else if (level > 0) changes.push({ from: line.from, insert: prefix });
      }
    }
    if (changes.length === 0) return false;
    view.dispatch({ changes, userEvent: "input.format", scrollIntoView: true });
    view.focus();
    return true;
  };
}

const BULLET_RE = /^(\s*)([-*+])\s+(\[[ xX]\]\s+)?/;
const ORDERED_RE = /^(\s*)(\d+)[.)]\s+(\[[ xX]\]\s+)?/;
const QUOTE_RE = /^(\s*)>\s?/;

export type LinePrefixKind = "bullet" | "ordered" | "task" | "quote";

/** Toggle list/quote markers on the selected lines, like the rich editor's toolbar buttons. */
export function toggleLinePrefix(kind: LinePrefixKind) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const lines: { from: number; to: number; text: string }[] = [];
    const seen = new Set<number>();
    for (const range of state.selection.ranges) {
      const a = state.doc.lineAt(range.from).number;
      const b = state.doc.lineAt(range.to).number;
      for (let n = a; n <= b; n++) {
        if (seen.has(n)) continue;
        seen.add(n);
        const line = state.doc.line(n);
        lines.push({ from: line.from, to: line.to, text: line.text });
      }
    }
    const re = kind === "quote" ? QUOTE_RE : kind === "ordered" ? ORDERED_RE : BULLET_RE;
    const allHave = lines.every((l) => {
      const m = re.exec(l.text);
      if (!m) return false;
      if (kind === "task") return !!m[3];
      if (kind === "bullet") return !m[3];
      return true;
    });
    const changes: ChangeSpec[] = [];
    lines.forEach((l, i) => {
      const existing = BULLET_RE.exec(l.text) ?? ORDERED_RE.exec(l.text) ?? QUOTE_RE.exec(l.text);
      const indent = existing ? existing[1] : (/^\s*/.exec(l.text)?.[0] ?? "");
      const stripTo = existing ? l.from + existing[0].length : l.from + indent.length;
      if (allHave) {
        changes.push({ from: l.from, to: stripTo, insert: indent });
        return;
      }
      const marker =
        kind === "bullet" ? "- " : kind === "task" ? "- [ ] " : kind === "ordered" ? `${i + 1}. ` : "> ";
      changes.push({ from: l.from, to: stripTo, insert: indent + marker });
    });
    view.dispatch({ changes, userEvent: "input.format", scrollIntoView: true });
    view.focus();
    return true;
  };
}

export function insertLink(view: EditorView, url: string, text?: string): boolean {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  const label = text ?? (selected || url);
  const insert = `[${label}](${url})`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(range.from + insert.length),
    userEvent: "input.format",
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

export function insertImage(view: EditorView, url: string, alt = ""): boolean {
  const range = view.state.selection.main;
  const insert = `![${alt}](${url})`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(range.from + insert.length),
    userEvent: "input.format",
  });
  view.focus();
  return true;
}

/** Insert a block of text on its own paragraph at the cursor. */
export function insertBlock(view: EditorView, block: string, cursorOffset?: number): boolean {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  const before = line.text.slice(0, range.from - line.from);
  const after = state.sliceDoc(range.to, state.doc.lineAt(range.to).to);
  const needsLeading = line.from > 0 && !(before.trim() === "" && state.doc.lineAt(line.from - 1).text.trim() === "");
  const prefix = before.trim() === "" ? (needsLeading ? "\n" : "") : "\n\n";
  const suffix = after.trim() === "" ? "\n" : "\n\n";
  const insert = prefix + block + suffix;
  const from = before.trim() === "" ? line.from : range.from;
  const to = after.trim() === "" ? state.doc.lineAt(range.to).to : range.to;
  const cursor = from + prefix.length + (cursorOffset ?? block.length);
  view.dispatch({ changes: { from, to, insert }, selection: EditorSelection.cursor(cursor), userEvent: "input.format", scrollIntoView: true });
  view.focus();
  return true;
}

export function insertTable(view: EditorView, rows = 3, cols = 3): boolean {
  const header = "| " + Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(" | ") + " |";
  const delim = "| " + Array.from({ length: cols }, () => "---").join(" | ") + " |";
  const body = Array.from({ length: Math.max(1, rows - 1) }, () => "| " + Array.from({ length: cols }, () => " ").join(" | ") + " |");
  const block = [header, delim, ...body].join("\n");
  return insertBlock(view, block, 2);
}

export function insertHorizontalRule(view: EditorView): boolean {
  return insertBlock(view, "---");
}

export function insertCodeBlock(view: EditorView, lang = ""): boolean {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  const block = "```" + lang + "\n" + (selected || "") + "\n```";
  return insertBlock(view, block, 4 + lang.length + (selected ? selected.length : 0));
}

/** Names of syntax nodes enclosing the cursor, used to reflect formatting state in the toolbar. */
export function enclosingMarkdownNodes(state: EditorState, pos: number): Set<string> {
  const names = new Set<string>();
  let node = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    names.add(node.name);
    if (!node.parent) break;
    node = node.parent;
  }
  return names;
}

export interface SourceFormatState {
  strong: boolean;
  em: boolean;
  code: boolean;
  strike: boolean;
  link: boolean;
  heading: number;
  bullet: boolean;
  ordered: boolean;
  task: boolean;
  quote: boolean;
  codeBlock: boolean;
}

export function formatStateAt(state: EditorState, range: SelectionRange = state.selection.main): SourceFormatState {
  const names = enclosingMarkdownNodes(state, range.head);
  const line = state.doc.lineAt(range.head).text;
  const heading = HEADING_RE.exec(line)?.[2].length ?? 0;
  const bullet = BULLET_RE.exec(line);
  return {
    strong: names.has("StrongEmphasis"),
    em: names.has("Emphasis"),
    code: names.has("InlineCode"),
    strike: names.has("Strikethrough"),
    link: names.has("Link") || names.has("URL"),
    heading,
    bullet: !!bullet && !bullet[3],
    task: !!bullet && !!bullet[3],
    ordered: ORDERED_RE.test(line),
    quote: QUOTE_RE.test(line),
    codeBlock: names.has("FencedCode") || names.has("CodeBlock"),
  };
}

const MARKERS = { strong: "**", em: "*", code: "`", strike: "~~" } as const;
export function markerFor(kind: keyof typeof MARKERS): InlineMarker {
  return MARKERS[kind];
}

