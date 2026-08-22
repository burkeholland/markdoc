"use client";

import { useEffect, useRef } from "react";
import { EditorView } from "prosemirror-view";
import type { CollabSession } from "@/editor/collab/session";
import { createRichEditorState, setEditable } from "@/editor/prosemirror/setup";
import type { ImageUploader } from "@/editor/prosemirror/images";
import { createNodeViews } from "@/editor/prosemirror/nodeviews";
import { refreshRichHighlights } from "@/editor/prosemirror/highlights";
import { useSessionValue } from "./use-session";

export interface RichPaneProps {
  session: CollabSession;
  onReady: (view: EditorView | null) => void;
  onSelection: (head: number, anchor: number) => void;
  onHighlightClick: (kind: string, id: string | null) => void;
  onLinkShortcut: () => void;
  onCommentShortcut: () => void;
  /** Uploads a pasted or dropped image and returns its URL. */
  uploadImage?: ImageUploader;
  onImageError?: (message: string) => void;
  /** Source offset of the code pane's cursor while the code pane is active (for the focus block). */
  focusSource: number | null;
}

export function RichPane({ session, onReady, onSelection, onHighlightClick, onLinkShortcut, onCommentShortcut, uploadImage, onImageError, focusSource }: RichPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const handlers = useRef({ onSelection, onHighlightClick, onLinkShortcut, onCommentShortcut, uploadImage, onImageError });
  useEffect(() => {
    handlers.current = { onSelection, onHighlightClick, onLinkShortcut, onCommentShortcut, uploadImage, onImageError };
  }, [onSelection, onHighlightClick, onLinkShortcut, onCommentShortcut, uploadImage, onImageError]);
  const focusRef = useRef<number | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const state = createRichEditorState(session, {
      onFocus: () => session.setActiveSurface("rich"),
      onSelection: (head, anchor) => handlers.current.onSelection(head, anchor),
      onHighlightClick: (kind, id) => handlers.current.onHighlightClick(kind, id),
      onLinkShortcut: () => handlers.current.onLinkShortcut(),
      onCommentShortcut: () => handlers.current.onCommentShortcut(),
      uploadImage: handlers.current.uploadImage ? (file) => handlers.current.uploadImage!(file) : undefined,
      onImageError: (message) => handlers.current.onImageError?.(message),
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

  const canEdit = useSessionValue(session, (s) => s.canEdit);
  useEffect(() => {
    if (viewRef.current) setEditable(viewRef.current, canEdit);
  }, [canEdit]);

  // Highlights that depend on the session refresh themselves (see richHighlightsPlugin);
  // only the cross-pane focus block needs a push from here.
  useEffect(() => {
    focusRef.current = focusSource;
    if (viewRef.current) refreshRichHighlights(viewRef.current);
  }, [focusSource]);

  return <div ref={host} className="relative h-full min-h-0 w-full" data-testid="rich-pane" />;
}

