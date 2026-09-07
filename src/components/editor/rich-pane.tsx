"use client";

import { useLayoutEffect, useRef } from "react";
import { EditorView } from "prosemirror-view";
import type { CollabSession } from "@/editor/collab/session";
import { createRichEditorState, setEditable } from "@/editor/prosemirror/setup";
import type { ImageUploader } from "@/editor/prosemirror/images";
import type { SlashMenuHandlers } from "@/editor/prosemirror/slash-menu";
import { createNodeViews } from "@/editor/prosemirror/nodeviews";
import { refreshRichHighlights } from "@/editor/prosemirror/highlights";
import type { NoticeAction } from "@/editor/markdown/tsv";
import type { HighlightClickHandler } from "@/editor/highlight-activation";
import { useSessionValue } from "./use-session";

export interface RichPaneProps {
  session: CollabSession;
  onReady: (view: EditorView | null) => void;
  onSelection: (head: number, anchor: number) => void;
  onHighlightClick: HighlightClickHandler;
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

interface RichPaneHandlers {
  onSelection: RichPaneProps["onSelection"];
  onHighlightClick: RichPaneProps["onHighlightClick"];
  onLinkShortcut: RichPaneProps["onLinkShortcut"];
  onCommentShortcut: RichPaneProps["onCommentShortcut"];
  uploadImage: RichPaneProps["uploadImage"];
  onImageError: RichPaneProps["onImageError"];
  onNotice: RichPaneProps["onNotice"];
  onMarkdownFileDrop: RichPaneProps["onMarkdownFileDrop"];
}

interface RichViewVisit {
  session: CollabSession;
  host: HTMLDivElement;
  view: EditorView | null;
  handlers: RichPaneHandlers;
  focusSource: number | null;
  unbindComposition: (() => void) | null;
  onReady: RichPaneProps["onReady"];
  installing: boolean;
  retired: boolean;
}

export function RichPane({ session, onReady, onSelection, onHighlightClick, onLinkShortcut, onCommentShortcut, uploadImage, onImageError, onNotice, onMarkdownFileDrop, slashMenu, hidden = false }: RichPaneProps) {
  // Source offset of the code pane's cursor while the code pane is active (for the focus block).
  const focusSource = useSessionValue(session, (s) => (s.activeSurface === "code" ? s.localCursor.code : null));
  const canEdit = useSessionValue(session, (s) => s.canEdit);
  const host = useRef<HTMLDivElement>(null);
  const activeVisit = useRef<RichViewVisit | null>(null);
  const readyVisit = useRef<RichViewVisit | null>(null);
  const nextHandlers = { onSelection, onHighlightClick, onLinkShortcut, onCommentShortcut, uploadImage, onImageError, onNotice, onMarkdownFileDrop };

  useLayoutEffect(() => {
    const visit = activeVisit.current;
    if (visit && !visit.retired && visit.session === session && visit.host === host.current && visit.view) {
      visit.handlers = nextHandlers;
    }
  });

  useLayoutEffect(() => {
    const mount = host.current;
    if (!mount) return;
    const visit: RichViewVisit = {
      session,
      host: mount,
      view: null,
      handlers: nextHandlers,
      focusSource,
      unbindComposition: null,
      onReady,
      installing: true,
      retired: false,
    };
    const currentHandlers = () =>
      activeVisit.current === visit && !visit.retired && visit.host === host.current && visit.view ? visit.handlers : null;
    const isCurrent = () => currentHandlers() !== null;
    const state = createRichEditorState(session, {
      onFocus: () => {
        if (isCurrent()) visit.session.setActiveSurface("rich");
      },
      onSelection: (head, anchor) => currentHandlers()?.onSelection(head, anchor),
      onHighlightClick: (kind, id, sourcePosition) => currentHandlers()?.onHighlightClick(kind, id, sourcePosition),
      onLinkShortcut: () => currentHandlers()?.onLinkShortcut(),
      onCommentShortcut: () => currentHandlers()?.onCommentShortcut(),
      uploadImage: uploadImage
        ? async (file) => {
            const handler = currentHandlers()?.uploadImage;
            if (!handler) throw new Error("Rich editor view is no longer current");
            return handler(file);
          }
        : undefined,
      onImageError: (message) => currentHandlers()?.onImageError?.(message),
      onNotice: (message, action) => currentHandlers()?.onNotice?.(message, action),
      onMarkdownFileDrop: (file, pos) => currentHandlers()?.onMarkdownFileDrop?.(file, pos),
      getFocusSource: () => (isCurrent() && visit.session.activeSurface === "code" ? visit.focusSource : null),
      slashMenu,
    });
    const view = new EditorView(mount, {
      state,
      nodeViews: createNodeViews(
        () =>
          !visit.retired &&
          visit.host === host.current &&
          ((visit.installing && activeVisit.current === null) || isCurrent()) &&
          visit.session.canEdit,
      ),
    });
    visit.view = view;
    visit.installing = false;
    activeVisit.current = visit;
    visit.unbindComposition = session.bindContentComposition(view.dom);
    readyVisit.current = visit;
    onReady(view);
    if (process.env.NODE_ENV !== "production") {
      // Like `__markdocSession`: lets e2e tests wait for ProseMirror's own selection, not just the DOM's.
      (window as unknown as { __markdocRichView?: EditorView }).__markdocRichView = view;
    }
    return () => {
      if (visit.retired) return;
      visit.retired = true;
      if (activeVisit.current === visit) activeVisit.current = null;
      visit.unbindComposition?.();
      visit.unbindComposition = null;
      view.destroy();
      visit.view = null;
      if (process.env.NODE_ENV !== "production") {
        const testWindow = window as unknown as { __markdocRichView?: EditorView };
        if (testWindow.__markdocRichView === view) delete testWindow.__markdocRichView;
      }
      if (readyVisit.current === visit) {
        readyVisit.current = null;
        visit.onReady(null);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useLayoutEffect(() => {
    const visit = activeVisit.current;
    if (visit && !visit.retired && visit.session === session && visit.host === host.current && visit.view) {
      setEditable(visit.view, canEdit);
    }
  }, [session, canEdit]);

  // Highlights that depend on the session refresh themselves (see richHighlightsPlugin);
  // only the cross-pane focus block needs a push from here.
  useLayoutEffect(() => {
    const visit = activeVisit.current;
    if (visit && !visit.retired && visit.session === session && visit.host === host.current && visit.view) {
      visit.focusSource = focusSource;
      refreshRichHighlights(visit.view);
    }
  }, [session, focusSource]);

  return <div ref={host} className={hidden ? "relative hidden h-full min-h-0 w-full" : "relative h-full min-h-0 w-full"} data-testid="rich-pane" />;
}
