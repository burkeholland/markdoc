import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import type { Plugin } from "prosemirror-state";
import type { MarkType } from "prosemirror-model";
import { schema } from "../markdown/schema";
import { findParentNode } from "./utils";

/**
 * Typing Markdown inline syntax applies the mark (task #437): `**bold**`, `*em*`, `~~gone~~` and
 * `` `code` `` become the mark the moment the closing delimiter is typed, instead of staying literal
 * and landing in the source escaped (`\*\*bold\*\*`). The optional first group is the character
 * before the opening delimiter, which must not be another delimiter, so `*` never fires halfway
 * through `**bold**`; the typed text goes on unmarked.
 */
function markInputRule(pattern: RegExp, type: MarkType): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    if ($start.parent.type.spec.code) return null;
    // Inside a code span the delimiters are literal.
    if (type !== schema.marks.code && schema.marks.code.isInSet($start.marks())) return null;
    const text = match[3];
    if (!text || /^\s|\s$/.test(text)) return null;
    const from = start + match[0].length - match[2].length;
    const tr = state.tr.insertText(text, from, end);
    tr.addMark(from, from + text.length, type.create());
    return tr.removeStoredMark(type);
  });
}

/**
 * Markdown-style shortcuts in the rich editor: typing `# `, `- `, `1. `, `> `,
 * `- [ ] `, ```` ```lang ```` + space or Enter, or `---` converts the block as you type — a word
 * processor's automatic formatting, but using Markdown syntax people already know.
 */
export const CODE_FENCE_RULE = /^```([a-zA-Z0-9+#_-]*)\s$/;

export function markdownInputRules(): Plugin {
  const rules: InputRule[] = [
    textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, (match) => ({ level: match[1].length })),
    // Task list: "- [ ] " or "- [x] " at the start of a paragraph.
    new InputRule(/^\s*[-*+]\s\[( |x|X)\]\s$/, (state, match, start, end) => {
      const $start = state.doc.resolve(start);
      if ($start.parent.type !== schema.nodes.paragraph) return null;
      const checked = match[1].toLowerCase() === "x";
      const tr = state.tr.delete(start, end);
      const range = tr.selection.$from.blockRange();
      if (!range) return null;
      const item = schema.nodes.list_item.create({ checked });
      const wrapping = [{ type: schema.nodes.bullet_list, attrs: { bullet: "-", tight: true } }, { type: item.type, attrs: item.attrs }];
      tr.wrap(range, wrapping);
      return tr;
    }),
    // Inside an existing list item, "[ ] " turns the item into a task.
    new InputRule(/^\[( |x|X)\]\s$/, (state, match, start, end) => {
      const $start = state.doc.resolve(start);
      const item = findParentNode($start, (n) => n.type === schema.nodes.list_item);
      if (!item || $start.parent.type !== schema.nodes.paragraph) return null;
      const checked = match[1].toLowerCase() === "x";
      return state.tr.delete(start, end).setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked });
    }),
    wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list, (match) => ({ bullet: match[1] })),
    wrappingInputRule(
      /^(\d+)[.)]\s$/,
      schema.nodes.ordered_list,
      (match) => ({ start: Number(match[1]), delimiter: match[0].includes(")") ? ")" : "." }),
      (match, node) => node.childCount + node.attrs.start === Number(match[1]),
    ),
    wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
    // A fence closes on the space (or Enter, see codeFenceOnEnter) so a language can be typed first: "```ts ".
    textblockTypeInputRule(CODE_FENCE_RULE, schema.nodes.code_block, (match) => ({ language: match[1] || null })),
    markInputRule(/(^|[^*])(\*\*([^*]+)\*\*)$/, schema.marks.strong),
    markInputRule(/(^|[^*])(\*([^*]+)\*)$/, schema.marks.em),
    markInputRule(/(^|[^~])(~~([^~]+)~~)$/, schema.marks.strikethrough),
    markInputRule(/(^|[^`])(`([^`]+)`)$/, schema.marks.code),
    // Horizontal rule when a paragraph consists of exactly "---", "***" or "___".
    new InputRule(/^(?:---|\*\*\*|___)$/, (state, _match, start, end) => {
      const $start = state.doc.resolve(start);
      if ($start.parent.type !== schema.nodes.paragraph || $start.parentOffset !== 0) return null;
      const tr = state.tr.delete(start, end);
      const blockPos = tr.selection.$from.before();
      const block = tr.doc.nodeAt(blockPos);
      if (!block || block.content.size !== 0) return null;
      tr.replaceWith(blockPos, blockPos + block.nodeSize, [schema.nodes.horizontal_rule.create(), schema.nodes.paragraph.create()]);
      return tr;
    }),
  ];
  return inputRules({ rules });
}
