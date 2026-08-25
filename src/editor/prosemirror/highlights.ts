import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import type { CollabSession } from "../collab/session";
import { markdownBindingKey } from "../sync/markdown-binding";
import { SUGGESTIONS_ORIGIN } from "../collab/suggestions";
import type { TextOp } from "../sync/text-diff";
import type { SourceHighlight } from "../codemirror/highlights";
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
      id: s.id,
      active: s.id === session.activeSuggestionId,
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

export interface HighlightHandlers {
  onHighlightClick?: (kind: string, id: string | null) => void;
  /** Source offset of the code pane's cursor while the code pane is active, for the focus indicator. */
  getFocusSource?: () => number | null;
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
      handleClick(view, _pos, event) {
        const target = (event.target as HTMLElement).closest("[data-highlight-kind]") as HTMLElement | null;
        if (!target) return false;
        const kind = target.getAttribute("data-highlight-kind")!;
        if (kind === "focus") return false;
        handlers.onHighlightClick?.(kind, target.getAttribute("data-highlight-id"));
        return false;
      },
    },
    view(view) {
      const unsubscribe = session.subscribe(() => scheduleRefresh(view));
      return { destroy: unsubscribe };
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

