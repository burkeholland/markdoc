import type { Mark, Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { ReplaceStep } from "prosemirror-transform";
import type { CollabSession } from "../collab/session";
import { ownsLiveHighlight } from "../highlight-activation";
import { matchLinkCard, MAX_CARD_URL_LENGTH } from "../markdown/link-cards";
import { installLinkInteractions } from "../links";
import { schema } from "../markdown/schema";
import { markdownBindingKey } from "../sync/markdown-binding";
import { richHighlightAtPointer } from "./highlights";
import { readLinkCardsSetting } from "@/lib/link-cards-setting";

const TYPED_AUTOLINK_DEMOTION = "typedAutolinkDemotion";

interface TextInsertion {
  from: number;
  text: string;
}

interface TypedCardCandidate {
  pos: number;
  text: string;
}

export const typedCardCandidateKey = new PluginKey<TypedCardCandidate | null>("typedCardCandidate");

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

function typedParagraphText(node: PMNode | null, expected: string): boolean {
  if (node?.type !== schema.nodes.paragraph) return false;
  let text = "";
  let plain = true;
  node.forEach((child) => {
    if (!child.isText) {
      plain = false;
      return;
    }
    const value = child.text ?? "";
    text += value;
    if (child.marks.some((mark) => !automaticLink(mark, value))) plain = false;
  });
  return plain && text === expected;
}

function candidateAfterBindingSync(
  transaction: Transaction,
  candidate: TypedCardCandidate | null,
  newState: EditorState,
): TypedCardCandidate | null {
  if (!candidate) return null;
  const pos = transaction.mapping.map(candidate.pos, -1);
  const { $from, empty } = newState.selection;
  if (
    !empty ||
    $from.depth !== 1 ||
    $from.before(1) !== pos ||
    $from.parent.type !== schema.nodes.paragraph ||
    $from.parentOffset !== candidate.text.length ||
    !typedParagraphText(newState.doc.nodeAt(pos), candidate.text)
  ) {
    return null;
  }
  return { pos, text: candidate.text };
}

function typedCardCandidateAfter(
  transaction: Transaction,
  candidate: TypedCardCandidate | null,
  oldState: EditorState,
  newState: EditorState,
): TypedCardCandidate | null {
  if (transaction.getMeta(TYPED_AUTOLINK_DEMOTION)) return candidate;
  if (transaction.getMeta(markdownBindingKey)?.remote) {
    return candidateAfterBindingSync(transaction, candidate, newState);
  }
  if (transaction.getMeta("composition") !== undefined) {
    return null;
  }
  if (!transaction.docChanged) return transaction.selectionSet || transaction.storedMarksSet ? null : candidate;
  if (
    transaction.getMeta("uiEvent") === "paste" ||
    transaction.getMeta("uiEvent") === "drop" ||
    transaction.getMeta("paste") !== undefined ||
    transaction.getMeta("addToHistory") === false ||
    transaction.getMeta("history$") !== undefined
  ) {
    return null;
  }
  const insertion = textInsertion([transaction], oldState);
  if (!insertion || !newState.selection.empty || newState.selection.head !== insertion.from + insertion.text.length) return null;

  if (candidate) {
    const previous = oldState.doc.nodeAt(candidate.pos);
    const pos = transaction.mapping.map(candidate.pos, -1);
    const text = candidate.text + insertion.text;
    if (
      previous?.type !== schema.nodes.paragraph ||
      previous.textContent !== candidate.text ||
      insertion.from !== candidate.pos + 1 + candidate.text.length ||
      text.length > MAX_CARD_URL_LENGTH ||
      !typedParagraphText(transaction.doc.nodeAt(pos), text)
    ) {
      return null;
    }
    return { pos, text };
  }

  const { $from, empty, head } = oldState.selection;
  if (
    !empty ||
    head !== insertion.from ||
    $from.depth !== 1 ||
    $from.parent.type !== schema.nodes.paragraph ||
    $from.parent.content.size !== 0 ||
    insertion.text.length > MAX_CARD_URL_LENGTH
  ) {
    return null;
  }
  const pos = transaction.mapping.map($from.before(1), -1);
  return typedParagraphText(transaction.doc.nodeAt(pos), insertion.text) ? { pos, text: insertion.text } : null;
}

/**
 * Enter converts only a URL typed key by key into an empty paragraph; old, pasted, remote, undone and
 * deliberately shown-as-text links never acquire the local typing candidate this command consumes.
 */
export function typedCardLinkOnEnter(session: Pick<CollabSession, "undoManager">): Command {
  return (state, dispatch) => {
    const candidate = typedCardCandidateKey.getState(state);
    const { $from, $to } = state.selection;
    if (
      !readLinkCardsSetting() ||
      !candidate ||
      !state.selection.empty ||
      !$from.sameParent($to) ||
      $from.depth !== 1 ||
      $from.before(1) !== candidate.pos ||
      $from.parent.type !== schema.nodes.paragraph ||
      $from.parentOffset !== candidate.text.length ||
      !typedParagraphText($from.parent, candidate.text) ||
      !matchLinkCard(candidate.text)
    ) {
      return false;
    }
    if (dispatch) {
      const card = schema.nodes.link_card.create({ url: candidate.text });
      const paragraph = schema.nodes.paragraph.create();
      const tr = state.tr.replaceWith(candidate.pos, candidate.pos + $from.parent.nodeSize, [card, paragraph]);
      tr.setSelection(TextSelection.create(tr.doc, candidate.pos + card.nodeSize + 1));
      session.undoManager.stopCapturing();
      try {
        dispatch(tr.scrollIntoView());
      } finally {
        session.undoManager.stopCapturing();
      }
    }
    return true;
  };
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
  return new Plugin<TypedCardCandidate | null>({
    key: typedCardCandidateKey,
    state: {
      init: () => null,
      apply(transaction, candidate, oldState, newState) {
        return typedCardCandidateAfter(transaction, candidate, oldState, newState);
      },
    },
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
