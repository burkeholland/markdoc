import type { Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/** Transaction meta asking decoration plugins to rebuild from the session's current state. */
export const REFRESH_META = "markdoc/refresh";

const scheduled = new WeakSet<EditorView>();

export function isRefresh(tr: Transaction): boolean {
  return Boolean(tr.getMeta(REFRESH_META));
}

/** Dispatch a refresh transaction now. */
export function refreshNow(view: EditorView) {
  if (view.isDestroyed) return;
  view.dispatch(view.state.tr.setMeta(REFRESH_META, true).setMeta("addToHistory", false));
}

/**
 * Dispatch a single refresh transaction on the next animation frame, however
 * many plugins ask for one in the meantime.
 */
export function scheduleRefresh(view: EditorView) {
  if (scheduled.has(view) || view.isDestroyed) return;
  scheduled.add(view);
  requestAnimationFrame(() => {
    scheduled.delete(view);
    refreshNow(view);
  });
}
