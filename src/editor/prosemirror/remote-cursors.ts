import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";
import type { CollabSession } from "../collab/session";
import { isIdle } from "../collab/follow";
import { isRefresh, scheduleRefresh } from "./refresh";

const key = new PluginKey<DecorationSet>("remoteCursors");

interface CursorState {
  anchor: unknown;
  head: unknown;
}

type RelJSON = Parameters<typeof Y.createRelativePositionFromJSON>[0];

interface CaretFlags {
  userId: string;
  following: boolean;
  flash: boolean;
  idle: boolean;
  /** The caret of an agent (API token) published by the server. */
  agent: boolean;
}

/** lucide "bot" outline, inline so the label needs no React. */
const BOT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';

function caretWidget(session: CollabSession, color: string, name: string, flags: CaretFlags): HTMLElement {
  const caret = document.createElement("span");
  caret.className = "md-remote-caret";
  caret.style.borderColor = color;
  caret.dataset.userId = flags.userId;
  if (flags.following) caret.dataset.following = "";
  if (flags.flash) caret.dataset.flash = "";
  if (flags.idle) caret.dataset.idle = "";
  if (flags.agent) caret.dataset.agent = "";
  const label = document.createElement("span");
  label.className = "md-remote-caret-label";
  label.style.backgroundColor = color;
  if (flags.agent) {
    const glyph = document.createElement("span");
    glyph.className = "md-remote-caret-bot";
    glyph.innerHTML = BOT_SVG;
    label.appendChild(glyph);
  }
  label.appendChild(document.createTextNode(name));
  // The label is the one part of a remote caret the user can click: it starts following.
  label.style.pointerEvents = "auto";
  label.style.cursor = "pointer";
  label.title = flags.agent ? `Follow ${name} (agent)` : `Follow ${name}`;
  const onMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  label.addEventListener("mousedown", onMouseDown);
  label.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    session.follow(flags.userId);
  });
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
  const now = Date.now();
  session.awareness.getStates().forEach((state, clientId) => {
    if (clientId === localId) return;
    const cursor = state.cursor as CursorState | undefined;
    const user = state.user as { id?: string; name?: string; color?: string; colorLight?: string; isAgent?: boolean } | undefined;
    if (!cursor?.anchor || !cursor.head) return;
    const anchorSrc = resolve(session, cursor.anchor);
    const headSrc = resolve(session, cursor.head);
    if (anchorSrc === null || headSrc === null) return;
    const color = user?.color ?? "#2563eb";
    const colorLight = user?.colorLight ?? color + "33";
    const name = user?.name ?? "Anonymous";
    const userId = user?.id ?? String(clientId);
    const flags: CaretFlags = {
      userId,
      following: session.followUserId === userId,
      flash: session.flashUserId === userId,
      idle: isIdle(typeof state.lastActive === "number" ? state.lastActive : null, now),
      agent: user?.isAgent === true,
    };
    const head = clamp(map.srcToPm(headSrc));
    const anchor = clamp(map.srcToPm(anchorSrc));
    const from = Math.min(head, anchor);
    const to = Math.max(head, anchor);
    if (to > from) {
      decorations.push(
        Decoration.inline(from, to, { class: "md-remote-selection", style: `background-color: ${colorLight}` }, { inclusiveEnd: true }),
      );
    }
    decorations.push(
      Decoration.widget(head, () => caretWidget(session, color, name, flags), {
        key: `caret-${clientId}-${color}-${name}-${flags.following ? "f" : ""}${flags.flash ? "x" : ""}${flags.idle ? "i" : ""}${flags.agent ? "a" : ""}`,
        side: 1,
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
      let sessionSignature = `${session.followUserId ?? ""}:${session.flashUserId ?? ""}`;
      const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        if ([...added, ...updated, ...removed].some((id) => id !== session.ydoc.clientID)) refresh();
      };
      session.awareness.on("change", onAwareness);
      const unsubscribe = session.subscribe(() => {
        const next = `${session.followUserId ?? ""}:${session.flashUserId ?? ""}`;
        if (next === sessionSignature) return;
        sessionSignature = next;
        refresh();
      });

      const publish = () => {
        if (!view.hasFocus()) return;
        const { anchor, head } = view.state.selection;
        const map = session.binding.getSourceMap();
        const anchorRel = Y.createRelativePositionFromTypeIndex(session.ytext, map.pmToSrc(anchor));
        const headRel = Y.createRelativePositionFromTypeIndex(session.ytext, map.pmToSrc(head));
        const current = session.awareness.getLocalState()?.cursor as CursorState | undefined;
        if (!sameCursor(current, anchorRel, headRel)) {
          session.awareness.setLocalStateField("cursor", { anchor: anchorRel, head: headRel });
          session.touchActivity();
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
