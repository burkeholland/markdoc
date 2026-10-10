import type { Mark, Node as PMNode } from "prosemirror-model";
import { Plugin, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { ReplaceStep } from "prosemirror-transform";
import type { CollabSession } from "../collab/session";
import { ownsLiveHighlight } from "../highlight-activation";
import { installLinkInteractions } from "../links";
import { schema } from "../markdown/schema";
import { markdownBindingKey } from "../sync/markdown-binding";
import { richHighlightAtPointer } from "./highlights";

const TYPED_AUTOLINK_DEMOTION = "typedAutolinkDemotion";

interface TextInsertion {
  from: number;
  text: string;
}

function textInsertion(transactions: readonly Transaction[], oldState: EditorState): TextInsertion | null {
  const changed = transactions.filter((transaction) => transaction.docChanged);
  if (changed.length !== 1) return null;
  const transaction = changed[0];
  if (
    transaction.getMeta(TYPED_AUTOLINK_DEMOTION) ||
    transaction.getMeta(markdownBindingKey)?.remote ||
    transaction.getMeta("composition") !== undefined ||
    transaction.before !== oldState.doc ||
    transaction.steps.length !== 1 ||
    !(transaction.steps[0] instanceof ReplaceStep)
  ) {
    return null;
  }
  const step = transaction.steps[0];
  if (step.from !== step.to || step.slice.size === 0) return null;
  const text = step.slice.content.textBetween(0, step.slice.size, "", "\ufffc");
  if (text.length !== step.slice.size || text.includes("\ufffc") || /[\r\n]/.test(text)) return null;
  return { from: step.from, text };
}

function automaticLink(mark: Mark, text: string): boolean {
  if (mark.type !== schema.marks.link || mark.attrs.title) return false;
  const href = String(mark.attrs.href);
  return (
    href === text ||
    (/^www\./i.test(text) && href.toLowerCase() === `http://${text}`.toLowerCase()) ||
    (text.includes("@") && href.toLowerCase() === `mailto:${text}`.toLowerCase())
  );
}

function isBareSourceLink(
  source: string,
  map: ReturnType<CollabSession["binding"]["getSourceMap"]>,
  node: PMNode,
  from: number,
  to: number,
  link: Mark,
): boolean {
  if (!node.isText || !node.text || !automaticLink(link, node.text)) return false;
  const sourceFrom = map.pmToSrc(from);
  const sourceTo = map.pmToSrc(to);
  if (source.slice(sourceFrom, sourceTo) !== node.text) return false;
  if (source[sourceFrom - 1] === "[" && source[sourceTo] === "]") return false;
  return source[sourceFrom - 1] !== "<" || source[sourceTo] !== ">";
}

function linkAtInsertion(state: EditorState, from: number): Mark | null {
  const $from = state.doc.resolve(from);
  const nodeBefore = $from.nodeBefore;
  const nodeAfter = $from.nodeAfter;
  if (!nodeBefore?.isText || !nodeAfter?.isText) return null;
  const beforeLink = schema.marks.link.isInSet(nodeBefore.marks);
  return beforeLink && beforeLink.isInSet(nodeAfter.marks) ? beforeLink : null;
}

function demoteTypedAutolinks(
  session: CollabSession,
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  const insertion = textInsertion(transactions, oldState);
  if (!insertion || linkAtInsertion(oldState, insertion.from)) return null;
  const $from = oldState.doc.resolve(insertion.from);
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null;

  const changedTransaction = transactions.find((candidate) => candidate.docChanged)!;
  const transaction = newState.tr;
  let changed = false;
  const block = $from.node(1);
  const blockStart = $from.before(1);
  const source = session.ytext.toString();
  const map = session.binding.getSourceMap();
  // The binding serializes one top-level block at a time. Strip parser-derived
  // autolink marks from that projection so unchanged bare URLs stay bare.
  block.descendants((node, offset) => {
    if (!node.isText || !node.text) return;
    const link = schema.marks.link.isInSet(node.marks);
    if (!link) return;
    const from = blockStart + 1 + offset;
    const to = from + node.nodeSize;
    if (!isBareSourceLink(source, map, node, from, to, link)) return;
    transaction.removeMark(
      changedTransaction.mapping.map(from, -1),
      changedTransaction.mapping.map(to, 1),
      link,
    );
    changed = true;
  });
  return changed
    ? transaction.setMeta(TYPED_AUTOLINK_DEMOTION, true).setMeta("addToHistory", false)
    : null;
}

export function richLinksPlugin(session: CollabSession): Plugin {
  return new Plugin({
    appendTransaction(transactions, oldState, newState) {
      return demoteTypedAutolinks(session, transactions, oldState, newState);
    },
    view(view) {
      const destroy = installLinkInteractions(view.dom, (event) => {
        const target = event.target;
        const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
        if (element?.closest(".md-remote-caret")) return null;
        const anchor = element?.closest("a[href]");
        return anchor && view.dom.contains(anchor) ? anchor.getAttribute("href") : null;
      }, (start, current) => {
        const anchor = view.posAtCoords({ left: start.clientX, top: start.clientY });
        const head = view.posAtCoords({ left: current.clientX, top: current.clientY });
        if (!anchor || !head) return;
        view.focus();
        view.dispatch(view.state.tr.setSelection(TextSelection.between(
          view.state.doc.resolve(anchor.pos), view.state.doc.resolve(head.pos),
        )).setMeta("pointer", true).scrollIntoView());
      }, (event) => {
        const target = richHighlightAtPointer(view, session, event);
        return !!target && ownsLiveHighlight(session, target.kind, target.id, target.sourcePosition);
      });
      return { destroy };
    },
  });
}
