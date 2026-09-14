import { MarkdownSerializer, MarkdownSerializerState } from "./to-markdown";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "./schema";
import { fenceFor } from "./code-fence";

type NodeSerializer = (state: MarkdownSerializerState, node: PMNode, parent: PMNode, index: number) => void;

type SerializerOptions = { tightLists?: boolean; escapeExtraCharacters?: RegExp; hardBreakNodeName?: string; strict?: boolean };

function escapeTitle(title: string): string {
  return title.replace(/[\\"]|&(?=[a-zA-Z][a-zA-Z0-9]*;|#\d+;|#[xX][0-9a-fA-F]+;)/g, "\\$&");
}

function escapeDestination(destination: string): string {
  return destination.replace(/[\\()"]|&(?=[a-zA-Z][a-zA-Z0-9]*;|#\d+;|#[xX][0-9a-fA-F]+;)/g, "\\$&");
}

/**
 * Serializer state with a gentler escaping strategy than the upstream default in `to-markdown.ts`:
 * it only escapes characters where they would otherwise change the meaning of the Markdown, which
 * keeps hand-written documents readable after a round trip through the rich editor.
 */
class State extends MarkdownSerializerState {
  inLink = false;
  inTable = false;

  escImageAlt(str: string): string {
    const inLink = this.inLink;
    this.inLink = true;
    try {
      return this.esc(str);
    } finally {
      this.inLink = inLink;
    }
  }

  esc(str: string, startOfLine = false): string {
    str = str.replace(/[`*\\]/g, "\\$&");
    str = str.replace(/_/g, (m, i: number, s: string) =>
      i > 0 && i + 1 < s.length && /\w/.test(s[i - 1]) && /\w/.test(s[i + 1]) ? m : "\\" + m,
    );
    // GFM strikes through text between one *or two* tildes, so a run of one or two tildes that touches
    // text on either side may be a delimiter and every tilde in it is escaped. The old `\~~` left the
    // second tilde live: typing `~~x~` in the preview serialized to `\~~x~`, which parsed back as
    // `~` + struck "x" and re-serialized to `~~~x~~` (task #437). Three or more never strike through.
    str = str.replace(/~+/g, (run, i: number, s: string) => {
      if (run.length > 2) return run;
      const before = i > 0 ? s[i - 1] : " ";
      const after = s[i + run.length] ?? " ";
      return /\S/.test(before) || /\S/.test(after) ? run.replace(/~/g, "\\~") : run;
    });
    str = str.replace(/\[/g, "\\[");
    if (this.inLink) str = str.replace(/\]/g, "\\]");
    str = str.replace(/<(?=[a-zA-Z/!?])/g, "\\<");
    str = str.replace(/&(?=[a-zA-Z][a-zA-Z0-9]*;|#\d+;|#[xX][0-9a-fA-F]+;)/g, "\\&");
    if (this.inTable) str = str.replace(/\|/g, "\\|");
    if (startOfLine) {
      str = str
        .replace(/^(\+[ ]|[-*>])/, "\\$&")
        .replace(/^(\s*)(#{1,6})(\s|$)/, "$1\\$2$3")
        .replace(/^(\s*\d+)([.)])(\s|$)/, "$1\\$2$3")
        .replace(/^(\s*)(---+|___+)\s*$/, "$1\\$2");
    }
    return str;
  }
}

function taskPrefix(item: PMNode): string {
  if (item.attrs.checked === null || item.attrs.checked === undefined) return "";
  return item.attrs.checked ? "[x] " : "[ ] ";
}

function renderCell(state: State, cell: PMNode): string {
  const sub = new State(state.nodes, state.marks, state.options);
  sub.inTable = true;
  sub.renderInline(cell, false);
  return sub.out.replace(/\n/g, "<br>").trim();
}

const isEmptyParagraph = (node: PMNode) => node.type === schema.nodes.paragraph && node.content.size === 0;

const nodes: Record<string, NodeSerializer> = {
  /**
   * Like `wrapBlock("> ", ...)`, but an empty paragraph inside the quote (the line Enter creates
   * at the end of a quoted paragraph) becomes one marker-only `>` line beyond the blank line that
   * separates blocks; `parse.ts` reads it back the same way, so the rich document round-trips
   * exactly and the caret stays where the user put it.
   */
  blockquote(state, node) {
    state.write("> ");
    const oldDelim = state.delim;
    state.delim += "> ";
    const marker = state.delim.replace(/\s+$/, "");
    if (node.childCount === 1 && isEmptyParagraph(node.firstChild!)) {
      // An empty quote is a single `>`.
      state.out = state.out.replace(/[ \t]+$/, "");
    } else {
      let lastEmpty = false;
      node.forEach((child, _, i) => {
        if (!isEmptyParagraph(child)) {
          state.render(child, node, i);
          lastEmpty = false;
          return;
        }
        if (i === 0) state.out = state.out.replace(/[ \t]+$/, "") + "\n" + marker + "\n";
        else {
          state.flushClose(2);
          state.out += marker + "\n";
        }
        state.closed = null;
        lastEmpty = true;
      });
      if (lastEmpty) state.out = state.out.replace(/\n$/, "");
    }
    state.delim = oldDelim;
    state.closeBlock(node);
  },
  /**
   * The closing fence always goes on the line after the last line of text. mdast reads the
   * content as the lines between the fences minus that one final line ending, so a text that
   * ends with newlines (a blank last line the user typed) keeps exactly those newlines.
   */
  code_block(state, node) {
    const fence = fenceFor(node.textContent);
    const info = [node.attrs.language, node.attrs.meta].filter(Boolean).join(" ");
    state.write(fence + info + "\n");
    if (node.textContent) state.text(node.textContent + "\n", false);
    state.write(fence);
    state.closeBlock(node);
  },
  heading(state, node) {
    state.write(state.repeat("#", node.attrs.level) + " ");
    state.renderInline(node, false);
    state.closeBlock(node);
  },
  horizontal_rule(state, node) {
    state.write("---");
    state.closeBlock(node);
  },
  bullet_list(state, node) {
    state.renderList(node, "  ", (i) => `${node.attrs.bullet || "-"} ${taskPrefix(node.child(i))}`);
  },
  ordered_list(state, node) {
    const start: number = node.attrs.start ?? 1;
    const delimiter: string = node.attrs.delimiter ?? ".";
    const maxW = String(start + node.childCount - 1).length;
    const space = state.repeat(" ", maxW + 2);
    state.renderList(node, space, (i) => {
      const nStr = String(start + i);
      return state.repeat(" ", maxW - nStr.length) + nStr + delimiter + " " + taskPrefix(node.child(i));
    });
  },
  list_item(state, node) {
    state.renderContent(node);
  },
  paragraph(state, node) {
    state.renderInline(node);
    state.closeBlock(node);
  },
  image(state, node) {
    state.write(
      "![" +
        (state as State).escImageAlt(node.attrs.alt || "") +
        "](" +
        escapeDestination(String(node.attrs.src)) +
        (node.attrs.title ? ' "' + escapeTitle(String(node.attrs.title)) + '"' : "") +
        ")",
    );
  },
  /**
   * `\` + newline is the CommonMark hard break, but only between content: at the end of a block
   * the backslash is literal and trailing spaces are dropped, so a break that ends the paragraph
   * (Shift+Enter before the next line is typed) is spelled `<br>`, which `parse.ts` reads back as
   * the same node. A GFM table row is one line, so a cell always uses `<br>`.
   */
  hard_break(state, node, parent, index) {
    if ((state as State).inTable) {
      state.write("<br>");
      return;
    }
    const isBlank = (n: PMNode) => n.type === node.type || (n.isText && !/\S/.test(n.text!));
    let trailing = true;
    for (let i = index + 1; i < parent.childCount && trailing; i++) if (!isBlank(parent.child(i))) trailing = false;
    if (!trailing) {
      state.write("\\\n");
      return;
    }
    // A paragraph of nothing but breaks has no Markdown form (`<br>` alone on a line is an HTML block).
    for (let i = 0; i < index; i++) {
      if (!isBlank(parent.child(i))) {
        state.write("<br>");
        return;
      }
    }
  },
  text(state, node) {
    state.text(node.text!, !state.inAutolink);
  },
  html_block(state, node) {
    state.text(node.textContent, false);
    state.closeBlock(node);
  },
  unrenderable(state, node) {
    state.text(node.attrs.src, false);
    state.closeBlock(node);
  },
  html_inline(state, node) {
    state.write(node.attrs.html);
  },
  frontmatter(state, node) {
    state.write("---\n");
    if (node.textContent) {
      state.text(node.textContent, false);
      state.ensureNewLine();
    }
    state.write("---");
    state.closeBlock(node);
  },
  link_definition(state, node) {
    const title = node.attrs.title ? ` "${escapeTitle(String(node.attrs.title))}"` : "";
    state.write(`[${node.attrs.label}]: ${escapeDestination(String(node.attrs.url))}${title}`);
    state.closeBlock(node);
  },
  footnote_definition(state, node) {
    state.wrapBlock("    ", `[^${node.attrs.label}]: `, node, () => state.renderContent(node));
  },
  footnote_reference(state, node) {
    state.write(`[^${node.attrs.label}]`);
  },
  table(state, node) {
    const rows: string[][] = [];
    const aligns: (string | null)[] = [];
    node.forEach((row, _, rowIndex) => {
      const cells: string[] = [];
      row.forEach((cell, __, colIndex) => {
        cells.push(renderCell(state as State, cell));
        if (rowIndex === 0) aligns[colIndex] = cell.attrs.align ?? null;
      });
      rows.push(cells);
    });
    const colCount = Math.max(...rows.map((r) => r.length), 1);
    const widths: number[] = [];
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.max(3, ...rows.map((r) => (r[c] ?? "").length));
    }
    const pad = (text: string, c: number) => {
      const align = aligns[c];
      const extra = widths[c] - text.length;
      if (align === "right") return " ".repeat(extra) + text;
      if (align === "center") {
        const left = Math.floor(extra / 2);
        return " ".repeat(left) + text + " ".repeat(extra - left);
      }
      return text + " ".repeat(extra);
    };
    const line = (cells: string[]) => "| " + cells.map((t, c) => pad(t, c)).join(" | ") + " |";
    const delimiter = () =>
      "| " +
      widths
        .map((w, c) => {
          const align = aligns[c];
          if (align === "left") return ":" + "-".repeat(w - 1);
          if (align === "right") return "-".repeat(w - 1) + ":";
          if (align === "center") return ":" + "-".repeat(Math.max(1, w - 2)) + ":";
          return "-".repeat(w);
        })
        .join(" | ") +
      " |";
    const out: string[] = [];
    rows.forEach((cells, i) => {
      const filled = Array.from({ length: colCount }, (_, c) => cells[c] ?? "");
      out.push(line(filled));
      if (i === 0) out.push(delimiter());
    });
    state.text(out.join("\n"), false);
    state.closeBlock(node);
  },
  table_row() {},
  table_cell() {},
  table_header() {},
};

function isPlainURL(link: import("prosemirror-model").Mark, parent: PMNode, index: number) {
  if (link.attrs.title || !/^\w+:/.test(link.attrs.href)) return false;
  const content = parent.child(index);
  if (!content.isText || content.text !== link.attrs.href || content.marks[content.marks.length - 1] !== link) return false;
  return index === parent.childCount - 1 || !link.isInSet(parent.child(index + 1).marks);
}

function backticksFor(node: PMNode, side: number) {
  const ticks = /`+/g;
  let m: RegExpExecArray | null;
  let len = 0;
  if (node.isText) while ((m = ticks.exec(node.text!))) len = Math.max(len, m[0].length);
  // CommonMark strips one edge-space pair unless the code contains only ASCII spaces.
  const needsPadding =
    len > 0 ||
    (node.isText &&
      node.text!.startsWith(" ") &&
      node.text!.endsWith(" ") &&
      /[^ ]/.test(node.text!) &&
      !/[\r\n]/.test(node.text!));
  let result = needsPadding && side > 0 ? " `" : "`";
  for (let i = 0; i < len; i++) result += "`";
  if (needsPadding && side < 0) result += " ";
  return result;
}

const marks = {
  em: { open: "*", close: "*", mixable: true, expelEnclosingWhitespace: true },
  strong: { open: "**", close: "**", mixable: true, expelEnclosingWhitespace: true },
  strikethrough: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
  link: {
    open(state: MarkdownSerializerState, mark: import("prosemirror-model").Mark, parent: PMNode, index: number) {
      const s = state as State;
      s.inAutolink = isPlainURL(mark, parent, index);
      if (!s.inAutolink) s.inLink = true;
      return s.inAutolink ? "<" : "[";
    },
    close(state: MarkdownSerializerState, mark: import("prosemirror-model").Mark) {
      const s = state as State;
      const { inAutolink } = s;
      s.inAutolink = undefined;
      s.inLink = false;
      return inAutolink
        ? ">"
        : "](" +
            escapeDestination(String(mark.attrs.href)) +
            (mark.attrs.title ? ` "${escapeTitle(String(mark.attrs.title))}"` : "") +
            ")";
    },
    mixable: true,
  },
  code: {
    open(_state: MarkdownSerializerState, _mark: unknown, parent: PMNode, index: number) {
      return backticksFor(parent.child(index), -1);
    },
    close(_state: MarkdownSerializerState, _mark: unknown, parent: PMNode, index: number) {
      return backticksFor(parent.child(index - 1), 1);
    },
    escape: false,
  },
};

class Serializer extends MarkdownSerializer {
  serialize(content: PMNode, options: SerializerOptions = {}): string {
    const opts = Object.assign({}, this.options, options);
    const state = new State(this.nodes, this.marks, opts);
    state.renderContent(content);
    return state.out;
  }
}

type SerializerCtorOptions = ConstructorParameters<typeof MarkdownSerializer>[2];

export const markdownSerializer = new Serializer(nodes, marks, {
  tightLists: true,
} as unknown as SerializerCtorOptions);

/** Serialize a whole document to Markdown. */
export function serializeMarkdown(doc: PMNode): string {
  return markdownSerializer.serialize(doc);
}

/** Serialize a run of top-level blocks to Markdown. */
export function serializeBlocks(blocks: PMNode[]): string {
  if (blocks.length === 0) return "";
  return markdownSerializer.serialize(schema.nodes.doc.create(null, blocks));
}

