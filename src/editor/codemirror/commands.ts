import { EditorSelection, type ChangeSpec, type EditorState, type SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode, Tree } from "@lezer/common";
import { fenceFor } from "../markdown/code-fence";
import { pathologicalParagraphs } from "./pathological";

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
  const wordChar = /[\p{L}\p{N}\p{M}_'-]/u;
  while (from > 0) {
    // A supplementary code point immediately before the boundary occupies two units.
    const previous = from > 1 ? text.codePointAt(from - 2) : undefined;
    const width = previous !== undefined && previous > 0xffff ? 2 : 1;
    if (!wordChar.test(text.slice(from - width, from))) break;
    from -= width;
  }
  while (to < text.length) {
    const point = text.codePointAt(to);
    if (point === undefined || !wordChar.test(String.fromCodePoint(point))) break;
    to += point > 0xffff ? 2 : 1;
  }
  return { from: line.from + from, to: line.from + to };
}

const inlineCodeParser = markdown({ base: markdownLanguage, addKeymap: false, extensions: [pathologicalParagraphs] }).language.parser;

/** Wrap or unwrap the selection (or the word at the cursor) with an inline marker. */
export function toggleInlineMark(marker: InlineMarker) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const len = marker.length;
    let codeTree: Tree | undefined;
    const changes = state.changeByRange((range) => {
      const orientedRange = (start: number, end: number) =>
        range.anchor > range.head ? EditorSelection.range(end, start) : EditorSelection.range(start, end);
      let { from, to } = range;
      if (from === to) {
        const word = wordRangeAt(state, from);
        from = word.from;
        to = word.to;
      }
      const before = state.sliceDoc(Math.max(0, from - len), from);
      const after = state.sliceDoc(to, to + len);
      const inner = state.sliceDoc(from, to);
      if (marker === "`" && from < to && state.doc.lineAt(from).number === state.doc.lineAt(to).number) {
        codeTree ??= ensureSyntaxTree(state, state.doc.length) ?? inlineCodeParser.parse(state.doc.toString());
        let span: SyntaxNode | null = null;
        let legacy = false;
        for (let node: SyntaxNode | null = codeTree.resolveInner(from, 1); node; node = node.parent) {
          if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "Table" || node.name === "UnrenderableParagraph") legacy = true;
          if (node.name === "InlineCode") span = node;
        }
        if (span && !legacy) {
          const opening = span.firstChild;
          const closing = span.lastChild;
          if (opening?.name === "CodeMark" && closing?.name === "CodeMark" && opening !== closing) {
            const raw = state.sliceDoc(opening.to, closing.from);
            const padding = raw.startsWith(" ") && raw.endsWith(" ") && /[^ ]/.test(raw) ? 1 : 0;
            const fullSpan = from === span.from && to === span.to;
            const fullContent = from === opening.to && to === closing.from;
            const payload = from === opening.to + padding && to === closing.from - padding;
            if (!/[\r\n]/.test(raw) && (fullSpan || fullContent || payload)) {
              const text = raw.slice(padding, raw.length - padding);
              return {
                changes: { from: span.from, to: span.to, insert: text },
                range: orientedRange(span.from, span.from + text.length),
              };
            }
          }
          // Partial or multiline spans retain the existing selection policy.
          legacy = true;
        }
        if (!legacy) {
          let longest = 0;
          for (const run of inner.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
          const delimiter = "`".repeat(longest + 1);
          // A synthetic pair prevents merged ticks and protects meaningful edge spaces.
          const padding = longest > 0 || (inner.startsWith(" ") && inner.endsWith(" ") && /[^ ]/.test(inner)) ? " " : "";
          const prefix = delimiter + padding;
          return {
            changes: [
              { from, insert: prefix },
              { from: to, insert: padding + delimiter },
            ],
            range: orientedRange(from + prefix.length, to + prefix.length),
          };
        }
      }
      // Unwrap when the selection is wrapped or contains the marker at both ends.
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: from - len, to: from, insert: "" },
            { from: to, to: to + len, insert: "" },
          ],
          range: orientedRange(from - len, to - len),
        };
      }
      if (inner.length >= len * 2 && inner.startsWith(marker) && inner.endsWith(marker)) {
        return {
          changes: { from, to, insert: inner.slice(len, inner.length - len) },
          range: orientedRange(from, to - len * 2),
        };
      }
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: from === to ? EditorSelection.cursor(from + len) : orientedRange(from + len, to + len),
      };
    });
    view.dispatch(changes, { scrollIntoView: true, userEvent: "input.format" });
    view.focus();
    return true;
  };
}

function lastSelectedLine(state: EditorState, range: SelectionRange): number {
  const line = state.doc.lineAt(range.to);
  // A nonempty selection's end is exclusive; a caret still includes its line.
  return !range.empty && line.from === range.to ? line.number - 1 : line.number;
}

const HEADING_RE = /^(\s{0,3})(#{1,6})(?:\s+|$)/;

/** Set ATX headings (level 1-6), or clear ATX and parsed Setext headings (level 0). */
export function setHeading(level: number) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const changes: ChangeSpec[] = [];
    const seen = new Set<number>();
    const tree = level === 0 ? syntaxTree(state) : null;
    const clearedSetext = new Set<number>();
    for (const range of state.selection.ranges) {
      const fromLine = state.doc.lineAt(range.from).number;
      const toLine = lastSelectedLine(state, range);
      for (let n = fromLine; n <= toLine; n++) {
        if (seen.has(n)) continue;
        seen.add(n);
        const line = state.doc.line(n);
        let setext = false;
        // Include the whole logical line, even when the caret precedes a container's heading.
        tree?.iterate({
          from: line.from,
          to: line.to,
          enter(node) {
            if (node.name !== "SetextHeading1" && node.name !== "SetextHeading2") return;
            setext = true;
            if (!clearedSetext.has(node.from)) {
              clearedSetext.add(node.from);
              const mark = node.node.getChild("HeaderMark");
              if (mark) changes.push({ from: mark.from, to: mark.to, insert: "" });
            }
            return false;
          },
        });
        if (setext) continue;
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

const BULLET_RE = /^(\s*)([-*+])(?:\s+|$)(\[[ xX]\]\s+)?/;
const ORDERED_RE = /^(\s*)(\d+)[.)](?:\s+|$)(\[[ xX]\]\s+)?/;
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
      const b = lastSelectedLine(state, range);
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

function escapeDestination(url: string): string {
  return url.replace(/[\\()]|&(?=[a-zA-Z][a-zA-Z0-9]*;|#\d+;|#[xX][0-9a-fA-F]+;)/g, "\\$&");
}

export function insertLink(view: EditorView, url: string, text?: string): boolean {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  const label = text ?? (selected || url);
  const insert = `[${label}](${escapeDestination(url)})`;
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
  const insert = `![${alt}](${escapeDestination(url)})`;
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
  const fence = fenceFor(selected);
  const block = fence + lang + "\n" + selected + "\n" + fence;
  return insertBlock(view, block, fence.length + 1 + lang.length + selected.length);
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
  const heading = names.has("SetextHeading1") ? 1 : names.has("SetextHeading2") ? 2 : HEADING_RE.exec(line)?.[2].length ?? 0;
  const bullet = BULLET_RE.exec(line);
  const codeBlock = names.has("FencedCode") || names.has("CodeBlock");
  let codeTask = false;
  if (codeBlock && names.has("ListItem")) {
    // Lezer's Task is a sibling of the code block, not one of its ancestors.
    let item = syntaxTree(state).resolveInner(range.head, -1);
    while (item.parent && item.name !== "ListItem") item = item.parent;
    codeTask = item.getChild("Task") !== null;
  }
  return {
    strong: names.has("StrongEmphasis"),
    em: names.has("Emphasis"),
    code: names.has("InlineCode"),
    strike: names.has("Strikethrough"),
    link: names.has("Link") || names.has("URL"),
    heading: codeBlock ? 0 : heading,
    bullet: codeBlock ? names.has("BulletList") && !codeTask : !!bullet && !bullet[3],
    task: codeBlock ? codeTask : !!bullet && !!bullet[3],
    ordered: codeBlock ? names.has("OrderedList") : ORDERED_RE.test(line),
    quote: codeBlock ? names.has("Blockquote") : QUOTE_RE.test(line),
    codeBlock,
  };
}

const MARKERS = { strong: "**", em: "*", code: "`", strike: "~~" } as const;
export function markerFor(kind: keyof typeof MARKERS): InlineMarker {
  return MARKERS[kind];
}

