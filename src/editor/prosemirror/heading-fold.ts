import { AllSelection, Plugin, PluginKey, TextSelection, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { owningVerticalScroller } from "./scroller";

/*
 * Folding of top-level headings in the rich editor (#2378). A folded heading hides every block up to
 * the next heading of the same or a higher level, so folding an h1 hides its h2s and h3s with it. A
 * heading inside a folded section keeps its own state and shows it again when the section opens.
 *
 * The state is a set of heading positions, mapped through every transaction. It is a view setting, not
 * document content: it is not saved, not undoable, and not shared with collaborators. globals.css draws
 * the chevron as the heading's ::before (so no widget sits in the text) and hides the folded blocks
 * through the `md-fold-hidden` class this plugin puts on them.
 */

interface FoldState {
  /** Start positions of the folded headings that still have something under them. */
  folded: ReadonlySet<number>;
  /** Indexes (among the document's top-level blocks) of the blocks a fold hides. */
  hidden: ReadonlySet<number>;
  decorations: DecorationSet;
}

type FoldMeta = { toggle: number; deep: boolean } | { reveal: number };

const key = new PluginKey<FoldState>("headingFold");
const EMPTY: FoldState = { folded: new Set(), hidden: new Set(), decorations: DecorationSet.empty };

interface Outline {
  offsets: number[];
  /** Heading level of each top-level block, 0 for anything else. */
  levels: number[];
  /** For a heading, the index of the first later block that is not in its section (`offsets.length` at the end). */
  ends: number[];
}

function outline(doc: PMNode): Outline {
  const offsets: number[] = [];
  const levels: number[] = [];
  doc.forEach((node, offset) => {
    offsets.push(offset);
    levels.push(node.type.name === "heading" ? (node.attrs.level as number) : 0);
  });
  const ends: number[] = new Array<number>(offsets.length).fill(offsets.length);
  const stack: number[] = [];
  for (let i = offsets.length - 1; i >= 0; i--) {
    const level = levels[i];
    if (!level) continue;
    while (stack.length && levels[stack[stack.length - 1]] > level) stack.pop();
    ends[i] = stack.length ? stack[stack.length - 1] : offsets.length;
    stack.push(i);
  }
  return { offsets, levels, ends };
}

function indexAt(offsets: readonly number[], pos: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] === pos) return mid;
    if (offsets[mid] < pos) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

function blocksLabel(count: number): string {
  return `${count} ${count === 1 ? "block" : "blocks"} hidden`;
}

/** The heading a position inside it belongs to (its start), or null. */
function headingStartAt(doc: PMNode, pos: number): number | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  return $pos.depth === 1 && $pos.parent.type.name === "heading" ? $pos.before(1) : null;
}

function pillWidget(count: number): (view: EditorView, getPos: () => number | undefined) => HTMLElement {
  return (view, getPos) => {
    const pill = document.createElement("span");
    pill.className = "md-fold-pill";
    pill.setAttribute("role", "button");
    pill.setAttribute("aria-label", `Unfold section, ${blocksLabel(count)}`);
    pill.title = "Unfold section";
    pill.textContent = blocksLabel(count);
    pill.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const at = getPos();
      const heading = at === undefined ? null : headingStartAt(view.state.doc, at);
      if (heading !== null) toggleHeadingFold(view, heading, event.altKey);
    });
    return pill;
  };
}

function build(doc: PMNode, folded: ReadonlySet<number>): FoldState {
  if (folded.size === 0) return EMPTY;
  const { offsets, levels, ends } = outline(doc);
  const hasBody = (i: number) => levels[i] > 0 && ends[i] > i + 1;
  const kept = new Set<number>();
  const hidden = new Set<number>();
  const decorations: Decoration[] = [];
  for (let i = 0; i < offsets.length; ) {
    if (!hasBody(i) || !folded.has(offsets[i])) {
      i++;
      continue;
    }
    kept.add(offsets[i]);
    const heading = doc.child(i);
    const count = ends[i] - i - 1;
    decorations.push(Decoration.node(offsets[i], offsets[i] + heading.nodeSize, { class: "md-fold-collapsed" }));
    decorations.push(
      Decoration.widget(offsets[i] + heading.nodeSize - 1, pillWidget(count), {
        side: 1,
        key: `fold-pill-${count}`,
        ignoreSelection: true,
        stopEvent: () => true,
      }),
    );
    for (let j = i + 1; j < ends[i]; j++) {
      hidden.add(j);
      // A heading folded inside this section keeps its fold for when this one opens.
      if (hasBody(j) && folded.has(offsets[j])) kept.add(offsets[j]);
      decorations.push(Decoration.node(offsets[j], offsets[j] + doc.child(j).nodeSize, { class: "md-fold-hidden" }));
    }
    i = ends[i];
  }
  if (kept.size === 0) return EMPTY;
  return { folded: kept, hidden, decorations: DecorationSet.create(doc, decorations) };
}

function isTopLevelHeading(doc: PMNode, pos: number): boolean {
  return pos >= 0 && pos <= doc.content.size && doc.resolve(pos).depth === 0 && doc.nodeAt(pos)?.type.name === "heading";
}

/** Carries the fold positions through a transaction; a heading that is gone drops its fold. */
function mapFolded(folded: ReadonlySet<number>, mapping: { map(pos: number, assoc?: number): number }, doc: PMNode): Set<number> {
  const next = new Set<number>();
  for (const pos of folded) {
    // A block replaced in place maps to its end with assoc 1, to its start with -1: try both.
    for (const assoc of [1, -1]) {
      const mapped = mapping.map(pos, assoc);
      if (isTopLevelHeading(doc, mapped)) {
        next.add(mapped);
        break;
      }
    }
  }
  return next;
}

function applyMeta(folded: ReadonlySet<number>, meta: FoldMeta, doc: PMNode): ReadonlySet<number> {
  const { offsets, levels, ends } = outline(doc);
  const next = new Set(folded);
  if ("reveal" in meta) {
    for (const pos of folded) {
      const i = indexAt(offsets, pos);
      if (i >= 0 && i < meta.reveal && meta.reveal < ends[i]) next.delete(pos);
    }
    return next;
  }
  const i = indexAt(offsets, meta.toggle);
  if (i < 0 || !levels[i] || ends[i] === i + 1) return folded;
  const fold = !folded.has(meta.toggle);
  for (let j = i; j < (meta.deep ? ends[i] : i + 1); j++) {
    if (!levels[j] || ends[j] === j + 1) continue;
    if (fold) next.add(offsets[j]);
    else next.delete(offsets[j]);
  }
  return next;
}

const holds = new WeakMap<EditorView, () => void>();

/**
 * Folding shortens the page. Near the bottom of a long document the scroll position would then be
 * clamped and the document would slide under the pointer. The page keeps its height until the user
 * scrolls up to a place where giving it back moves nothing.
 */
function holdPageHeight(view: EditorView) {
  const scroller = owningVerticalScroller(view.dom);
  const height = view.dom.offsetHeight;
  if (!scroller || !height) return;
  holds.get(view)?.();
  view.dom.style.minHeight = `${height}px`;
  let lastTop = scroller.scrollTop;
  const release = () => {
    scroller.removeEventListener("scroll", onScroll);
    holds.delete(view);
    view.dom.style.minHeight = "";
  };
  const onScroll = () => {
    const top = scroller.scrollTop;
    const scrolledUp = top < lastTop;
    lastTop = top;
    if (!scrolledUp) return;
    view.dom.style.minHeight = "";
    if (scroller.scrollTop === top) {
      scroller.removeEventListener("scroll", onScroll);
      holds.delete(view);
      return;
    }
    view.dom.style.minHeight = `${height}px`;
    scroller.scrollTop = top;
    lastTop = top;
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  holds.set(view, release);
}

/**
 * Folds the section of the heading at `pos`, or unfolds it when it is folded. `deep` applies the same
 * to every heading nested under it. A caret inside a section that disappears moves to the end of its
 * heading. Returns false when `pos` is not a heading with something under it.
 */
export function toggleHeadingFold(view: EditorView, pos: number, deep = false): boolean {
  const state = key.getState(view.state);
  if (!state) return false;
  const { doc, selection } = view.state;
  const { offsets, levels, ends } = outline(doc);
  const i = indexAt(offsets, pos);
  if (i < 0 || !levels[i] || ends[i] === i + 1) return false;
  const tr = view.state.tr.setMeta(key, { toggle: pos, deep } satisfies FoldMeta).setMeta("addToHistory", false);
  const folding = !state.folded.has(pos);
  if (folding) {
    const headingEnd = pos + doc.child(i).nodeSize;
    const sectionEnd = ends[i] < offsets.length ? offsets[ends[i]] : doc.content.size;
    if (selection.head > headingEnd && selection.head < sectionEnd) tr.setSelection(TextSelection.create(doc, headingEnd - 1));
    holdPageHeight(view);
  }
  view.dispatch(tr);
  return true;
}

/** Whether the top-level heading at `pos` is folded. */
export function isHeadingFolded(state: EditorState, pos: number): boolean {
  return key.getState(state)?.folded.has(pos) ?? false;
}

/**
 * Heading folds for the rich editor. A click on the chevron the stylesheet draws in the left padding
 * toggles the section (Alt-click: the whole subtree); a selection that lands inside a folded section
 * (find, a comment, following a collaborator, undo) opens it.
 */
export function headingFoldPlugin(): Plugin<FoldState> {
  return new Plugin<FoldState>({
    key,
    state: {
      init: () => EMPTY,
      apply(tr, value, _oldState, newState) {
        const meta = tr.getMeta(key) as FoldMeta | undefined;
        if (!meta && (!tr.docChanged || value.folded.size === 0)) return value;
        let folded = value.folded;
        if (tr.docChanged) folded = mapFolded(folded, tr.mapping, newState.doc);
        if (meta) folded = applyMeta(folded, meta, newState.doc);
        return build(newState.doc, folded);
      },
    },
    props: {
      decorations: (state) => key.getState(state)?.decorations,
      // Delete at the end of a folded heading would pull the first hidden block into its text unseen: open the section first.
      handleKeyDown(view, event) {
        if (event.key !== "Delete") return false;
        const { empty, $head } = view.state.selection;
        if (!empty || $head.depth !== 1 || $head.parent.type.name !== "heading" || $head.parentOffset !== $head.parent.content.size) return false;
        const at = $head.before(1);
        if (!isHeadingFolded(view.state, at)) return false;
        view.dispatch(view.state.tr.setMeta(key, { toggle: at, deep: false } satisfies FoldMeta).setMeta("addToHistory", false));
        return true;
      },
      handleDOMEvents: {
        mousedown(view, event) {
          if (event.button !== 0 || !(event.target instanceof HTMLElement)) return false;
          const heading = event.target;
          // The chevron is the heading's ::before, outside its box on the left: the event's target is the heading.
          if (heading.parentElement !== view.dom || !/^H[1-6]$/.test(heading.tagName)) return false;
          if (event.clientX >= heading.getBoundingClientRect().left) return false;
          const at = headingStartAt(view.state.doc, view.posAtDOM(heading, 0));
          if (at === null || !toggleHeadingFold(view, at, event.altKey)) return false;
          event.preventDefault();
          return true;
        },
      },
    },
    appendTransaction(transactions, _oldState, newState) {
      const state = key.getState(newState);
      if (!state || state.hidden.size === 0) return null;
      if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) return null;
      const { selection } = newState;
      if (selection instanceof AllSelection) return null;
      // Either end: a range with its anchor in a fold would otherwise be replaced by typing without being seen.
      const index = [selection.$head.index(0), selection.$anchor.index(0)].find((i) => state.hidden.has(i));
      if (index === undefined) return null;
      return newState.tr.setMeta(key, { reveal: index } satisfies FoldMeta).setMeta("addToHistory", false);
    },
    view(view) {
      return {
        destroy() {
          holds.get(view)?.();
        },
      };
    },
  });
}
