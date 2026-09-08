import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import type { CollabSession } from "../collab/session";
import { markdownBindingKey } from "../sync/markdown-binding";
import { SUGGESTIONS_ORIGIN } from "../collab/suggestions";
import type { TextOp } from "../sync/text-diff";
import type { SourceHighlight } from "../codemirror/highlights";
import {
  elementEditorRange,
  eventHighlightTarget,
  type HighlightClickHandler,
  type HighlightTarget,
} from "../highlight-activation";
import { isRefresh, refreshNow, scheduleRefresh } from "./refresh";

const key = new PluginKey<DecorationSet>("sourceHighlights");

/** Highlights derived from the session's comments, suggestions and focus state. */
export function collectHighlights(session: CollabSession, focusRange: { from: number; to: number } | null): SourceHighlight[] {
  const out: SourceHighlight[] = [];
  for (const thread of session.comments.list()) {
    if (!thread.range) continue;
    out.push({
      from: thread.range.from,
      to: thread.range.to,
      kind: thread.resolved ? "comment-resolved" : "comment",
      id: thread.id,
      active: thread.id === session.activeCommentId,
    });
  }
  if (session.pendingComment && session.pendingComment.to > session.pendingComment.from) {
    out.push({ ...session.pendingComment, kind: "comment", id: "pending", active: true });
  }
  for (const s of session.suggestions.list()) {
    out.push({
      from: s.from,
      to: s.to,
      kind: s.type === "insert" ? "suggest-insert" : "suggest-delete",
      id: s.groupId ?? s.id,
      active: (s.groupId ?? s.id) === session.activeSuggestionId,
    });
  }
  if (session.find) {
    session.find.matches.forEach((m, i) => {
      out.push({ from: m.from, to: m.to, kind: i === session.find!.active ? "find-active" : "find" });
    });
  }
  if (focusRange) out.push({ ...focusRange, kind: "focus" });
  return out;
}

function classFor(h: SourceHighlight): string {
  switch (h.kind) {
    case "comment":
      return "md-comment" + (h.active ? " md-comment-active" : "");
    case "comment-resolved":
      return "md-comment-resolved";
    case "suggest-insert":
      return "md-suggest-insert" + (h.active ? " md-suggest-active" : "");
    case "suggest-delete":
      return "md-suggest-delete" + (h.active ? " md-suggest-active" : "");
    case "focus":
      return "md-focus-block";
    case "find":
      return "md-find";
    case "find-active":
      return "md-find md-find-active";
  }
}

function build(session: CollabSession, doc: PMNode, getFocus: () => number | null): DecorationSet {
  // While the initial load is held the ProseMirror document does not hold the text yet, so there is
  // nothing to decorate — and the source map would cost a full parse of the new text inside the task
  // that applied it (the ~900 ms local-apply task on the 12k-word document, #118). The rebuild that
  // follows notifies the session, and that refresh builds the real set.
  if (session.binding.hasHeldSync) return DecorationSet.empty;
  const map = session.binding.getSourceMap();
  const max = doc.content.size;
  const clamp = (n: number) => Math.min(max, Math.max(0, n));
  const decorations: Decoration[] = [];
  for (const h of collectHighlights(session, null)) {
    const from = clamp(map.srcToPm(h.from));
    const to = clamp(map.srcToPm(h.to));
    if (to <= from) continue;
    decorations.push(
      Decoration.inline(from, to, {
        class: classFor(h),
        "data-highlight-kind": h.kind,
        ...(h.id ? { "data-highlight-id": h.id } : {}),
      }, {
        highlightKind: h.kind,
        highlightId: h.id,
      }),
    );
  }
  // Block focused from the other pane.
  const focusSrc = getFocus();
  if (focusSrc !== null) {
    const pos = clamp(map.srcToPm(focusSrc));
    const $pos = doc.resolve(pos);
    if ($pos.depth >= 1) {
      const start = $pos.before(1);
      const node = doc.nodeAt(start);
      if (node) decorations.push(Decoration.node(start, start + node.nodeSize, { class: "md-focus-block" }));
    }
  }
  return DecorationSet.create(doc, decorations);
}

function highlightSignature(session: CollabSession): string {
  const highlights = collectHighlights(session, null);
  const parts = highlights.map((highlight) => {
    const rangeMatters =
      highlight.kind === "find" ||
      highlight.kind === "find-active" ||
      highlight.kind === "suggest-insert" ||
      highlight.kind === "suggest-delete" ||
      highlight.id === "pending";
    return `${highlight.kind}:${highlight.id ?? ""}:${highlight.active ? 1 : 0}:${rangeMatters ? `${highlight.from}-${highlight.to}` : ""}`;
  });
  parts.push(`identity:${session.relativePositionVersion}:${session.commentRangeVersion}`);
  parts.push(`held:${session.binding.hasHeldSync ? 1 : 0}`);
  return parts.join("|");
}

function refreshSignature(session: CollabSession, getFocus: () => number | null): string {
  return `${highlightSignature(session)}|focus:${getFocus() ?? ""}`;
}

export interface HighlightHandlers {
  onHighlightClick?: HighlightClickHandler;
  /** Source offset of the code pane's cursor while the code pane is active, for the focus indicator. */
  getFocusSource?: () => number | null;
}

export interface PositionedHighlightTarget extends HighlightTarget {
  sourcePosition: number;
  from: number;
  to: number;
}

function richHighlightAtPosition(
  view: EditorView,
  session: CollabSession,
  event: MouseEvent,
  position: number,
): PositionedHighlightTarget | null {
  const target = eventHighlightTarget(view.dom, event.target);
  if (!target) return null;
  const range = elementEditorRange(target.element, (node, offset) => view.posAtDOM(node, offset));
  const ownsRange = range && key
    .getState(view.state)
    ?.find(range.from, range.to, (spec) => spec.highlightKind === target.kind && spec.highlightId === target.id)
    .some((decoration) => decoration.from <= range.from && range.to <= decoration.to);
  if (!ownsRange) return null;
  return { ...target, sourcePosition: session.binding.getSourceMap().pmToSrc(position), ...range };
}

export function richHighlightAtPointer(
  view: EditorView,
  session: CollabSession,
  event: MouseEvent,
): PositionedHighlightTarget | null {
  const position = view.posAtCoords({ left: event.clientX, top: event.clientY });
  return position ? richHighlightAtPosition(view, session, event, position.pos) : null;
}

// Chromium honors Windows' documented 5000 ms cap; wait past it so the second press retires first.
const HIGHLIGHT_ACTIVATION_DELAY_MS = 5001;
const DRAG_TOLERANCE_PX = 4;

interface RichHighlightPress {
  down: MouseEvent;
  pointerId: number | null;
  target: PositionedHighlightTarget;
  signature: string;
  released: boolean;
}

interface PendingRichHighlightActivation {
  target: PositionedHighlightTarget;
  signature: string;
  selection: EditorView["state"]["selection"];
  timer: ReturnType<typeof setTimeout>;
}

function isPlainPrimaryEvent(event: MouseEvent): boolean {
  return event.button === 0 &&
    event.detail === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey;
}

function samePositionedTarget(a: PositionedHighlightTarget, b: PositionedHighlightTarget | null): boolean {
  return !!b &&
    a.kind === b.kind &&
    a.id === b.id &&
    a.sourcePosition === b.sourcePosition &&
    a.from === b.from &&
    a.to === b.to;
}

function movedPastClickTolerance(start: MouseEvent, current: MouseEvent): boolean {
  return Math.abs(start.clientX - current.clientX) > DRAG_TOLERANCE_PX ||
    Math.abs(start.clientY - current.clientY) > DRAG_TOLERANCE_PX;
}

function richHighlightIsCurrent(view: EditorView, target: PositionedHighlightTarget): boolean {
  return !!key
    .getState(view.state)
    ?.find(
      target.from,
      target.to,
      (spec) => spec.highlightKind === target.kind && spec.highlightId === target.id,
    )
    .some((decoration) => decoration.from <= target.from && target.to <= decoration.to);
}

function installRichHighlightActivation(
  view: EditorView,
  session: CollabSession,
  onClick: HighlightClickHandler,
  currentSignature: () => string,
): {
  update(view: EditorView, previousState: EditorView["state"]): void;
  retire(): void;
  destroy(): void;
} {
  const dom = view.dom;
  const owner = dom.ownerDocument;
  const win = owner.defaultView;
  let press: RichHighlightPress | null = null;
  let pending: PendingRichHighlightActivation | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let nextPointerId: number | null = null;

  const pointerId = (event: Event) => {
    const value = (event as Partial<PointerEvent>).pointerId;
    return typeof value === "number" ? value : null;
  };
  const stopPressTracking = () => {
    owner.removeEventListener("mousemove", move, true);
    owner.removeEventListener("mouseup", up, true);
    owner.removeEventListener("pointerup", pointerUp, true);
  };
  const clearPress = () => {
    stopPressTracking();
    clearTimeout(releaseTimer);
    releaseTimer = undefined;
    press = null;
  };
  const clearPending = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
  };
  const retire = () => {
    clearPress();
    clearPending();
    nextPointerId = null;
  };
  const pointerDown = (event: PointerEvent) => {
    retire();
    nextPointerId = pointerId(event);
  };
  const pointerUp = (event: PointerEvent) => {
    if (!press) {
      nextPointerId = null;
    } else if (press.pointerId !== null && pointerId(event) !== press.pointerId) {
      clearPress();
    }
  };
  const schedule = (current: RichHighlightPress) => {
    clearPending();
    const activation: PendingRichHighlightActivation = {
      target: current.target,
      signature: current.signature,
      selection: view.state.selection,
      timer: setTimeout(() => {
        if (pending !== activation) return;
        pending = null;
        if (
          view.isDestroyed ||
          !dom.isConnected ||
          activation.signature !== currentSignature() ||
          !activation.selection.eq(view.state.selection) ||
          !richHighlightIsCurrent(view, activation.target)
        ) {
          return;
        }
        onClick(activation.target.kind, activation.target.id, activation.target.sourcePosition);
      }, HIGHLIGHT_ACTIVATION_DELAY_MS),
    };
    pending = activation;
  };
  const move = (event: MouseEvent) => {
    if (!press) return;
    if (
      event.buttons !== 1 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      movedPastClickTolerance(press.down, event)
    ) {
      clearPress();
    }
  };
  const up = (event: MouseEvent) => {
    const current = press;
    if (
      !current ||
      !isPlainPrimaryEvent(event) ||
      event.buttons !== 0 ||
      movedPastClickTolerance(current.down, event) ||
      current.signature !== currentSignature() ||
      !samePositionedTarget(current.target, richHighlightAtPointer(view, session, event))
    ) {
      clearPress();
      return;
    }
    current.released = true;
    stopPressTracking();
    schedule(current);
    releaseTimer = setTimeout(clearPress, 0);
  };
  const down = (event: MouseEvent) => {
    const currentPointerId = nextPointerId;
    retire();
    if (event.defaultPrevented || !isPlainPrimaryEvent(event) || event.buttons !== 1 || !key.getState(view.state)) return;
    const target = richHighlightAtPointer(view, session, event);
    if (!target) return;
    press = {
      down: event,
      pointerId: currentPointerId,
      target,
      signature: currentSignature(),
      released: false,
    };
    owner.addEventListener("mousemove", move, true);
    owner.addEventListener("mouseup", up, true);
    owner.addEventListener("pointerup", pointerUp, true);
  };
  const click = (event: MouseEvent) => {
    const current = press;
    clearPress();
    if (
      event.defaultPrevented ||
      !current?.released ||
      !isPlainPrimaryEvent(event) ||
      event.buttons !== 0 ||
      current.signature !== currentSignature() ||
      !samePositionedTarget(current.target, richHighlightAtPointer(view, session, event))
    ) {
      clearPending();
      return;
    }
    if (!pending || pending.target !== current.target) {
      clearPending();
      return;
    }
    pending.selection = view.state.selection;
  };

  dom.addEventListener("pointerdown", pointerDown, true);
  dom.addEventListener("pointercancel", retire, true);
  dom.addEventListener("mousedown", down, true);
  dom.addEventListener("click", click, true);
  dom.addEventListener("dblclick", retire, true);
  dom.addEventListener("blur", retire, true);
  win?.addEventListener("blur", retire);

  return {
    update(currentView, previousState) {
      if (press && currentView.state.doc !== previousState.doc) clearPress();
      if (
        pending &&
        (currentView.state.doc !== previousState.doc ||
          !pending.selection.eq(currentView.state.selection))
      ) {
        clearPending();
      }
      if (!dom.isConnected) retire();
    },
    retire,
    destroy() {
      retire();
      dom.removeEventListener("pointerdown", pointerDown, true);
      dom.removeEventListener("pointercancel", retire, true);
      dom.removeEventListener("mousedown", down, true);
      dom.removeEventListener("click", click, true);
      dom.removeEventListener("dblclick", retire, true);
      dom.removeEventListener("blur", retire, true);
      win?.removeEventListener("blur", retire);
    },
  };
}

/** Comments, suggestions and cross-pane focus rendered as inline decorations in the rich editor. */
export function richHighlightsPlugin(session: CollabSession, handlers: HighlightHandlers = {}): Plugin<DecorationSet> {
  const getFocus = () => handlers.getFocusSource?.() ?? null;
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) => build(session, state.doc, getFocus),
      apply(tr, old, _oldState, newState) {
        if (isRefresh(tr)) return build(session, newState.doc, getFocus);
        // The text (and therefore the source map) only changes after this transaction has
        // been applied; follow the edit for now and rebuild on the refresh that follows.
        if (tr.docChanged) return old.map(tr.mapping, tr.doc);
        return old;
      },
    },
    props: {
      decorations: (state) => key.getState(state),
    },
    view(view) {
      let activationSignature = highlightSignature(session);
      let signature = refreshSignature(session, getFocus);
      const activation = handlers.onHighlightClick
        ? installRichHighlightActivation(view, session, handlers.onHighlightClick, () => activationSignature)
        : null;
      const unsubscribe = session.subscribe(() => {
        const nextActivationSignature = highlightSignature(session);
        const next = refreshSignature(session, getFocus);
        if (next === signature) return;
        if (nextActivationSignature !== activationSignature) activation?.retire();
        activationSignature = nextActivationSignature;
        signature = next;
        scheduleRefresh(view);
      });
      return {
        update: activation?.update,
        destroy() {
          activation?.destroy();
          unsubscribe();
        },
      };
    },
  });
}

/** Ask the rich editor to refresh highlight decorations (for example after the focus source changed). */
export function refreshRichHighlights(view: EditorView) {
  refreshNow(view);
}

/**
 * Suggesting mode for the rich editor: intercepts the text operations the
 * binding derived from a local edit and turns them into suggestions. After the
 * binding re-syncs the document from the text, the caret is placed where the
 * user expects it (after inserted text, or before text marked for deletion).
 */
export function richSuggestingPlugin(session: CollabSession): Plugin {
  let pendingCursor: number | null = null;

  session.binding.setInterceptor((ops: TextOp[], ytext) => {
    if (session.mode !== "suggesting") return false;
    let shift = 0;
    let cursor: number | null = null;
    session.ydoc.transact(() => {
      for (const op of ops) {
        const idx = op.index + shift;
        if (op.deleteCount > 0) {
          const kept = session.suggestions.markDeleted(idx, idx + op.deleteCount, session.user);
          shift += kept;
          cursor = idx;
        }
        if (op.insert) {
          ytext.insert(idx, op.insert);
          session.suggestions.recordInserted(idx, op.insert.length, session.user);
          cursor = idx + op.insert.length;
        }
      }
    }, SUGGESTIONS_ORIGIN);
    pendingCursor = cursor;
    return true;
  });

  return new Plugin({
    view() {
      return {
        update(view, prevState) {
          if (pendingCursor === null) return;
          const meta = markdownBindingKey.getState(view.state);
          if (!meta?.remote || view.state.doc === prevState.doc) return;
          const target = pendingCursor;
          pendingCursor = null;
          const pos = Math.min(view.state.doc.content.size, Math.max(0, session.binding.getSourceMap().srcToPm(target)));
          const sel = TextSelection.near(view.state.doc.resolve(pos));
          view.dispatch(view.state.tr.setSelection(sel).setMeta("addToHistory", false));
        },
        destroy() {
          session.binding.setInterceptor(undefined);
        },
      };
    },
  });
}
