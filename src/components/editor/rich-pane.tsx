"use client";

import { useEffect, useRef } from "react";
import { EditorView } from "prosemirror-view";
import type { CollabSession } from "@/editor/collab/session";
import { createRichEditorState, setEditable } from "@/editor/prosemirror/setup";
import { createNodeViews } from "@/editor/prosemirror/nodeviews";
import { refreshRichHighlights } from "@/editor/prosemirror/highlights";
import { useSessionVersion } from "./use-session";

export interface RichPaneProps {
  session: CollabSession;
  onReady: (view: EditorView | null) => void;
  onSelection: (head: number, anchor: number) => void;
  onHighlightClick: (kind: string, id: string | null) => void;
  onLinkShortcut: () => void;
  onCommentShortcut: () => void;
  /** Source offset of the code pane's cursor while the code pane is active (for the focus block). */
  focusSource: number | null;
}

export function RichPane({ session, onReady, onSelection, onHighlightClick, onLinkShortcut, onCommentShortcut, focusSource }: RichPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const handlers = useRef({ onSelection, onHighlightClick, onLinkShortcut, onCommentShortcut });
  useEffect(() => {
    handlers.current = { onSelection, onHighlightClick, onLinkShortcut, onCommentShortcut };
  }, [onSelection, onHighlightClick, onLinkShortcut, onCommentShortcut]);
  const focusRef = useRef<number | null>(null);
  const version = useSessionVersion(session);

  useEffect(() => {
    if (!host.current) return;
    const state = createRichEditorState(session, {
      onFocus: () => session.setActiveSurface("rich"),
      onSelection: (head, anchor) => handlers.current.onSelection(head, anchor),
      onHighlightClick: (kind, id) => handlers.current.onHighlightClick(kind, id),
      onLinkShortcut: () => handlers.current.onLinkShortcut(),
      onCommentShortcut: () => handlers.current.onCommentShortcut(),
      getFocusSource: () => (session.activeSurface === "code" ? focusRef.current : null),
    });
    const view = new EditorView(host.current, {
      state,
      nodeViews: createNodeViews(() => session.canEdit),
      handleClickOn(view, _pos, node, _nodePos, event) {
        // Mod+click opens links.
        if ((event.metaKey || event.ctrlKey) && node.isText) {
          const link = node.marks.find((m) => m.type.name === "link");
          if (link) {
            window.open(link.attrs.href, "_blank", "noopener");
            return true;
          }
        }
        void view;
        return false;
      },
    });
    viewRef.current = view;
    onReady(view);
    return () => {
      onReady(null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const canEdit = session.canEdit;
  useEffect(() => {
    if (viewRef.current) setEditable(viewRef.current, canEdit);
  }, [canEdit]);

  useEffect(() => {
    focusRef.current = focusSource;
    if (viewRef.current) refreshRichHighlights(viewRef.current);
  }, [focusSource, version]);

  return <div ref={host} className="relative h-full min-h-0 w-full" data-testid="rich-pane" />;
}

