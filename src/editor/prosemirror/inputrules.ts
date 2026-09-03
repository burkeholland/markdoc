import { InputRule, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { Mark, type MarkType } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { schema } from "../markdown/schema";
import { findParentNode } from "./utils";

interface MarkMatch {
  from: number;
  text: string;
  marks?: readonly Mark[];
  underscoreOrigin?: Omit<UnderscoreOrigin, "from" | "to">;
}

type MarkMatchResolver = (state: EditorState, match: RegExpMatchArray, start: number, end: number) => MarkMatch | null;

interface UnderscoreOrigin {
  from: number;
  to: number;
  leadingUnderscores: number;
}

interface MarkdownInputRuleState {
  underscoreOrigins: readonly UnderscoreOrigin[];
}

interface RunnableInputRule {
  match: RegExp;
  handler: (state: EditorState, match: RegExpMatchArray, start: number, end: number) => Transaction | null;
  inCode: boolean | "only";
  inCodeMark: boolean | "only";
}

interface UnderscoreOriginUpdate {
  remove?: UnderscoreOrigin;
  add?: UnderscoreOrigin;
}

const inputRuleKey = new PluginKey<MarkdownInputRuleState>("markdownInputRules");
const UNDERSCORE_ORIGIN_META = "markdownUnderscoreOrigin";
const MAX_MATCH = 500;

/**
 * Typing Markdown inline syntax applies the mark (task #437): `**bold**`, `*em*`, `_em_`, `~~gone~~` and
 * `` `code` `` become the mark the moment the closing delimiter is typed, instead of staying literal
 * and landing in the source escaped (`\*\*bold\*\*`). The optional first group is the character
 * before the opening delimiter; each pattern uses it to exclude invalid boundaries, so `*` never fires
 * halfway through `**bold**` and `_` does not turn an intraword underscore into emphasis.
 */
function markInputRule(pattern: RegExp, type: MarkType, resolve?: MarkMatchResolver): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const found = resolve
      ? resolve(state, match, start, end)
      : { text: match[3], from: start + match[0].length - match[2].length };
    if (!found?.text) return null;
    const $start = state.doc.resolve(found.from);
    if ($start.parent.type.spec.code) return null;
    // Inside a code span the delimiters are literal.
    if (type !== schema.marks.code && schema.marks.code.isInSet($start.marks())) return null;
    if (/^\s|\s$/.test(found.text)) return null;
    const tr = found.marks
      ? state.tr.replaceWith(found.from, end, schema.text(found.text, found.marks))
      : state.tr.insertText(found.text, found.from, end);
    tr.addMark(found.from, found.from + found.text.length, type.create());
    if (found.underscoreOrigin) {
      tr.setMeta(UNDERSCORE_ORIGIN_META, {
        add: {
          from: found.from,
          to: found.from + found.text.length,
          ...found.underscoreOrigin,
        },
      } satisfies UnderscoreOriginUpdate);
    }
    return tr.removeStoredMark(type);
  });
}

const isWhitespace = (character: string | undefined): boolean => character === undefined || /\s/u.test(character);
const isPunctuationOrSymbol = (character: string | undefined): boolean =>
  character !== undefined && /[\p{P}\p{S}]/u.test(character);

function uniformMarks(state: EditorState, from: number, to: number): readonly Mark[] | null {
  let marks: readonly Mark[] | null = null;
  let valid = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isInline) return;
    if (marks === null) marks = node.marks;
    else if (!Mark.sameSet(marks, node.marks)) valid = false;
  });
  return valid ? (marks ?? []) : null;
}

function canOpenUnderscoreRun(text: string, from: number, to: number): boolean {
  const before = text[from - 1];
  const after = text[to];
  const leftFlanking =
    !isWhitespace(after) && (!isPunctuationOrSymbol(after) || isWhitespace(before) || isPunctuationOrSymbol(before));
  const rightFlanking =
    !isWhitespace(before) && (!isPunctuationOrSymbol(before) || isWhitespace(after) || isPunctuationOrSymbol(after));
  return leftFlanking && (!rightFlanking || isPunctuationOrSymbol(before));
}

function underscoreMarkMatch(state: EditorState, _match: RegExpMatchArray, start: number): MarkMatch | null {
  const $cursor = state.doc.resolve(start);
  if (!$cursor.parent.isTextblock || $cursor.parent.type.spec.code) return null;
  const before = $cursor.parent.textBetween(0, $cursor.parentOffset, "", "\ufffc");
  // A second or later closing underscore is either literal or handled by delimiter-run recovery.
  if (before.endsWith("_")) return null;
  const source = `${before}_`;
  const closing = source.length - 1;
  let closingBackslashes = 0;
  for (let index = closing - 1; index >= 0 && source[index] === "\\"; index--) closingBackslashes++;
  if (closingBackslashes % 2 === 1) return null;

  for (let index = closing - 1; index >= 0; ) {
    if (source[index] !== "_") {
      index--;
      continue;
    }
    const runTo = index + 1;
    while (index >= 0 && source[index] === "_") index--;
    const runFrom = index + 1;
    let openingBackslashes = 0;
    for (let slash = runFrom - 1; slash >= 0 && source[slash] === "\\"; slash--) openingBackslashes++;
    if (openingBackslashes > 0 || !canOpenUnderscoreRun(source, runFrom, runTo)) continue;

    const opener = runTo - 1;
    const text = source.slice(opener + 1, closing);
    if (!text || /^\s|\s$/.test(text) || /[\\\r\n\ufffc]/.test(text)) continue;
    const from = $cursor.start() + opener;
    const marks = uniformMarks(state, from, start);
    const cursorMarks = state.storedMarks ?? $cursor.marks();
    if (!marks || !Mark.sameSet(marks, cursorMarks) || schema.marks.code.isInSet(marks)) return null;
    return {
      from,
      text,
      marks,
      underscoreOrigin: { leadingUnderscores: runTo - runFrom - 1 },
    };
  }
  return null;
}

function originMarks(state: EditorState, origin: UnderscoreOrigin): readonly Mark[] | null {
  const marks = uniformMarks(state, origin.from, origin.to);
  if (!marks || !schema.marks.em.isInSet(marks)) return null;
  return marks;
}

function recoverDoubleUnderscoreRun(
  state: EditorState,
  _match: RegExpMatchArray,
  start: number,
  end: number,
): Transaction | null {
  const pluginState = inputRuleKey.getState(state);
  if (!pluginState) return null;
  const $cursor = state.doc.resolve(start);

  for (const origin of [...pluginState.underscoreOrigins].reverse()) {
    if (state.doc.resolve(origin.from).parent !== $cursor.parent || !originMarks(state, origin)) continue;

    // `__word_` first becomes `_` + em(`word`). If another `_` arrives immediately,
    // restore both consumed delimiters so the unsupported `__word__` shortcut stays literal.
    if (origin.to === start && origin.leadingUnderscores > 0) {
      const from = origin.from - origin.leadingUnderscores;
      const prefix = state.doc.textBetween(from, origin.from, "", "\ufffc");
      if (prefix !== "_".repeat(origin.leadingUnderscores)) return null;
      const marked = state.doc.textBetween(origin.from, origin.to, "", "\ufffc");
      const emMarks = originMarks(state, origin)!;
      const baseMarks = emMarks.filter((mark) => mark.type !== schema.marks.em);
      const prefixMarks = uniformMarks(state, from, origin.from);
      if (!prefixMarks || !Mark.sameSet(prefixMarks, baseMarks)) return null;
      const literal = `${"_".repeat(origin.leadingUnderscores + 1)}${marked}__`;
      return state.tr
        .replaceWith(from, end, schema.text(literal, baseMarks))
        .removeStoredMark(schema.marks.em)
        .setMeta(UNDERSCORE_ORIGIN_META, { remove: origin } satisfies UnderscoreOriginUpdate);
    }
  }
  return null;
}

function recoverAdjacentUnderscoreRun(
  state: EditorState,
  _match: RegExpMatchArray,
  start: number,
  end: number,
): Transaction | null {
  const pluginState = inputRuleKey.getState(state);
  if (!pluginState) return null;
  const $cursor = state.doc.resolve(start);

  for (const origin of [...pluginState.underscoreOrigins].reverse()) {
    if (state.doc.resolve(origin.from).parent !== $cursor.parent || !originMarks(state, origin)) continue;

    // `_a_b_` has already converted `_a_` when more body text arrives. Restore
    // that consumed closer inside the expanded emphasis without touching unrelated text.
    if (origin.to < start) {
      const suffix = state.doc.textBetween(origin.to, start, "", "\ufffc");
      const first = suffix[0];
      if (
        !/[^_]/.test(suffix) ||
        !suffix.at(-1) ||
        isWhitespace(suffix.at(-1)) ||
        (first !== "_" && (isWhitespace(first) || isPunctuationOrSymbol(first))) ||
        /[\\\r\n\ufffc]/.test(suffix)
      ) {
        continue;
      }
      const emMarks = originMarks(state, origin)!;
      const baseMarks = emMarks.filter((mark) => mark.type !== schema.marks.em);
      const suffixMarks = uniformMarks(state, origin.to, start);
      if (!suffixMarks || !Mark.sameSet(suffixMarks, baseMarks)) continue;
      const marked = state.doc.textBetween(origin.from, origin.to, "", "\ufffc");
      const text = `${marked}_${suffix}`;
      const tr = state.tr.replaceWith(origin.from, end, schema.text(text, baseMarks));
      tr.addMark(origin.from, origin.from + text.length, schema.marks.em.create());
      return tr
        .removeStoredMark(schema.marks.em)
        .setMeta(UNDERSCORE_ORIGIN_META, {
          remove: origin,
          add: { ...origin, to: origin.from + text.length },
        } satisfies UnderscoreOriginUpdate);
    }
  }
  return null;
}

function runInputRules(
  view: EditorView,
  from: number,
  to: number,
  text: string,
  rules: readonly InputRule[],
): boolean {
  if (view.composing) return false;
  const { state } = view;
  const $from = state.doc.resolve(from);
  const textBefore =
    $from.parent.textBetween(Math.max(0, $from.parentOffset - MAX_MATCH), $from.parentOffset, null, "\ufffc") + text;
  for (const rule of rules) {
    const runnable = rule as unknown as RunnableInputRule;
    if (!runnable.inCodeMark && $from.marks().some((mark) => mark.type.spec.code)) continue;
    if ($from.parent.type.spec.code ? !runnable.inCode : runnable.inCode === "only") continue;
    const match = runnable.match.exec(textBefore);
    if (!match || match[0].length < text.length) continue;
    const start = from - (match[0].length - text.length);
    if (!runnable.inCodeMark) {
      let hasCodeMark = false;
      state.doc.nodesBetween(start, $from.pos, (node) => {
        if (node.isInline && node.marks.some((mark) => mark.type.spec.code)) hasCodeMark = true;
      });
      if (hasCodeMark) continue;
    }
    const transaction = runnable.handler(state, match, start, to);
    if (!transaction) continue;
    view.dispatch(transaction);
    return true;
  }
  return false;
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
    new InputRule(/_$/, recoverDoubleUnderscoreRun),
    markInputRule(/_$/, schema.marks.em, underscoreMarkMatch),
    new InputRule(/_$/, recoverAdjacentUnderscoreRun),
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
      // The mapped selection would land after the new paragraph, at the start of the next block
      // (typing "---" then "Below" gave "BelowAfter text.", task #437): put the caret in the paragraph.
      tr.setSelection(TextSelection.create(tr.doc, blockPos + 2));
      return tr;
    }),
  ];
  const plugin = new Plugin<MarkdownInputRuleState>({
    key: inputRuleKey,
    state: {
      init: () => ({ underscoreOrigins: [] }),
      apply(transaction, value) {
        const update = transaction.getMeta(UNDERSCORE_ORIGIN_META) as UnderscoreOriginUpdate | undefined;
        const origins = value.underscoreOrigins
          .filter(
            (origin) =>
              !update?.remove ||
              origin.from !== update.remove.from ||
              origin.to !== update.remove.to ||
              origin.leadingUnderscores !== update.remove.leadingUnderscores,
          )
          .map((origin) => ({
            ...origin,
            from: transaction.mapping.map(origin.from, 1),
            to: transaction.mapping.map(origin.to, -1),
          }));
        const current = update?.add ? [...origins, update.add] : origins;
        return { underscoreOrigins: current.filter((origin) => origin.from < origin.to).slice(-32) };
      },
    },
    props: {
      handleTextInput(view, from, to, text): boolean {
        return runInputRules(view, from, to, text, rules);
      },
      handleDOMEvents: {
        compositionend(view) {
          setTimeout(() => {
            const { $cursor } = view.state.selection as TextSelection;
            if ($cursor) runInputRules(view, $cursor.pos, $cursor.pos, "", rules);
          });
        },
      },
    },
  });
  return plugin;
}
