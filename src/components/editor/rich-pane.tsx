"use client";

import { useEffect, useRef } from "react";
import { EditorView } from "prosemirror-view";
import type { CollabSession } from "@/editor/collab/session";
import { createRichEditorState, setEditable } from "@/editor/prosemirror/setup";
import type { ImageUploader } from "@/editor/prosemirror/images";
import type { SlashMenuHandlers } from "@/editor/prosemirror/slash-menu";
import { createNodeViews } from "@/editor/prosemirror/nodeviews";
import { refreshRichHighlights } from "@/editor/prosemirror/highlights";
import type { NoticeAction } from "@/editor/markdown/tsv";
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
  onNotice?: (message: string, action?: NoticeAction) => void;
  /** A dropped .md/.txt file and the ProseMirror position under the pointer. */
  onMarkdownFileDrop?: (file: File, pos: number) => void;
  /** Slash command menu plumbing (stable object; see SlashMenuController). */
  slashMenu?: SlashMenuHandlers;
  /** Keep the pane mounted but not displayed (the shell shows its server-rendered stand-in meanwhile). */
  hidden?: boolean;
}

export function RichPane({ session, onReady, onSelection, onHighlightClick, onLinkShortcut, onCommentShortcut, uploadImage, onImageError, onNotice, onMarkdownFileDrop, slashMenu, hidden = false }: RichPaneProps) {
  // Source offset of the code pane's cursor while the code pane is active (for the focus block).
  const focusSource = useSessionValue(session, (s) => (s.activeSurface === "code" ? s.localCursor.code : null));
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const handlers = useRef({ onSelection, onHighlightClick, onLinkShortcut, onCommentShortcut, uploadImage, onImageError, onNotice, onMarkdownFileDrop });
  useEffect(() => {
    handlers.current = { onSelection, onHighlightClick, onLinkShortcut, onCommentShortcut, uploadImage, onImageError, onNotice, onMarkdownFileDrop };
  }, [onSelection, onHighlightClick, onLinkShortcut, onCommentShortcut, uploadImage, onImageError, onNotice, onMarkdownFileDrop]);
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
      onNotice: (message, action) => handlers.current.onNotice?.(message, action),
      onMarkdownFileDrop: (file, pos) => handlers.current.onMarkdownFileDrop?.(file, pos),
      getFocusSource: () => (session.activeSurface === "code" ? focusRef.current : null),
      slashMenu,
    });
    const view = new EditorView(host.current, {
      state,
      nodeViews: createNodeViews(() => session.canEdit),
    });
    viewRef.current = view;
    const unbindComposition = session.bindContentComposition(view.dom);
    onReady(view);
    if (process.env.NODE_ENV !== "production") {
      // Like `__markdocSession`: lets e2e tests wait for ProseMirror's own selection, not just the DOM's.
      (window as unknown as { __markdocRichView?: EditorView }).__markdocRichView = view;
    }
    return () => {
      onReady(null);
      unbindComposition();
      view.destroy();
      viewRef.current = null;
      if (process.env.NODE_ENV !== "production") delete (window as unknown as { __markdocRichView?: EditorView }).__markdocRichView;
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

  return <div ref={host} className={hidden ? "relative hidden h-full min-h-0 w-full" : "relative h-full min-h-0 w-full"} data-testid="rich-pane" />;
}
