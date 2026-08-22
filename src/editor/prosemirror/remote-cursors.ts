import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";
import type { CollabSession } from "../collab/session";
import { isRefresh, scheduleRefresh } from "./refresh";

const key = new PluginKey<DecorationSet>("remoteCursors");

interface CursorState {
  anchor: unknown;
  head: unknown;
}

type RelJSON = Parameters<typeof Y.createRelativePositionFromJSON>[0];

function caretWidget(color: string, name: string): HTMLElement {
  const caret = document.createElement("span");
  caret.className = "md-remote-caret";
  caret.style.borderColor = color;
  const label = document.createElement("span");
  label.className = "md-remote-caret-label";
  label.style.backgroundColor = color;
  label.textContent = name;
  caret.appendChild(label);
  return caret;
}

function resolve(session: CollabSession, rel: unknown): number | null {
  try {
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel as RelJSON), session.ydoc);
    return abs && abs.type === session.ytext ? abs.index : null;
  } catch {
    return null;
  }
}

function buildDecorations(session: CollabSession, doc: PMNode): DecorationSet {
  const map = session.binding.getSourceMap();
  const decorations: Decoration[] = [];
  const localId = session.ydoc.clientID;
  const max = doc.content.size;
  const clamp = (n: number) => Math.min(max, Math.max(0, n));
  session.awareness.getStates().forEach((state, clientId) => {
    if (clientId === localId) return;
    const cursor = state.cursor as CursorState | undefined;
    const user = state.user as { name?: string; color?: string; colorLight?: string } | undefined;
    if (!cursor?.anchor || !cursor.head) return;
    const anchorSrc = resolve(session, cursor.anchor);
    const headSrc = resolve(session, cursor.head);
    if (anchorSrc === null || headSrc === null) return;
    const color = user?.color ?? "#2563eb";
    const colorLight = user?.colorLight ?? color + "33";
    const name = user?.name ?? "Anonymous";
    const head = clamp(map.srcToPm(headSrc));
    const anchor = clamp(map.srcToPm(anchorSrc));
    const from = Math.min(head, anchor);
    const to = Math.max(head, anchor);
    if (to > from) {
      decorations.push(Decoration.inline(from, to, { class: "md-remote-selection", style: `background-color: ${colorLight}` }));
    }
    decorations.push(
      Decoration.widget(head, () => caretWidget(color, name), {
        key: `caret-${clientId}-${color}-${name}`,
        side: head >= anchor ? 1 : -1,
        ignoreSelection: true,
      }),
    );
  });
  return DecorationSet.create(doc, decorations);
}

function sameCursor(current: CursorState | undefined, anchor: Y.RelativePosition, head: Y.RelativePosition): boolean {
  if (!current?.anchor || !current.head) return false;
  try {
    return (
      Y.compareRelativePositions(Y.createRelativePositionFromJSON(current.anchor as RelJSON), anchor) &&
      Y.compareRelativePositions(Y.createRelativePositionFromJSON(current.head as RelJSON), head)
    );
  } catch {
    return false;
  }
}

/**
 * Shows other users' carets and selections in the rich editor and publishes
 * the local selection as a source-text position, so a caret in either pane
 * appears in both panes of every collaborator.
 */
export function remoteCursorsPlugin(session: CollabSession): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) => buildDecorations(session, state.doc),
      apply(tr, old, _oldState, newState) {
        if (isRefresh(tr)) return buildDecorations(session, newState.doc);
        // The source map catches up with the text after this transaction; rebuild on refresh.
        if (tr.docChanged) return old.map(tr.mapping, tr.doc);
        return old;
      },
    },
    props: {
      decorations: (state) => key.getState(state),
    },
    view(view) {
      const refresh = () => scheduleRefresh(view);
      const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        if ([...added, ...updated, ...removed].some((id) => id !== session.ydoc.clientID)) refresh();
      };
      session.awareness.on("change", onAwareness);
      const unsubscribe = session.subscribe(refresh);

      const publish = () => {
        if (!view.hasFocus()) return;
        const { anchor, head } = view.state.selection;
        const map = session.binding.getSourceMap();
        const anchorRel = Y.createRelativePositionFromTypeIndex(session.ytext, map.pmToSrc(anchor));
        const headRel = Y.createRelativePositionFromTypeIndex(session.ytext, map.pmToSrc(head));
        const current = session.awareness.getLocalState()?.cursor as CursorState | undefined;
        if (!sameCursor(current, anchorRel, headRel)) {
          session.awareness.setLocalStateField("cursor", { anchor: anchorRel, head: headRel });
        }
      };
      const onFocus = () => publish();
      view.dom.addEventListener("focus", onFocus);
      publish();

      return {
        update(v, prevState) {
          if (v.state.selection !== prevState.selection || v.state.doc !== prevState.doc) publish();
        },
        destroy() {
          session.awareness.off("change", onAwareness);
          unsubscribe();
          view.dom.removeEventListener("focus", onFocus);
        },
      };
    },
  });
}
