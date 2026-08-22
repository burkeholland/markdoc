import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import type { Plugin } from "prosemirror-state";
import { schema } from "../markdown/schema";
import { findParentNode } from "./utils";

/**
 * Markdown-style shortcuts in the rich editor: typing `# `, `- `, `1. `, `> `,
 * `- [ ] `, ```` ``` ```` or `---` converts the block, like Google Docs'
 * automatic formatting but using Markdown syntax people already know.
 */
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
    textblockTypeInputRule(/^```([a-zA-Z0-9+#_-]*)$/, schema.nodes.code_block, (match) => ({ language: match[1] || null })),
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
