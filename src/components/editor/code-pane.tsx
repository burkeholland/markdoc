"use client";

import { useLayoutEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CollabSession } from "@/editor/collab/session";
import { createCodeApi, type CodeApi } from "@/editor/codemirror/api";
import { createCodeEditorSetup, type CodeEditorSetup } from "@/editor/codemirror/setup";
import type { ImageUploader } from "@/editor/prosemirror/images";
import { setHighlights, type SourceHighlight } from "@/editor/codemirror/highlights";
import { collectHighlights } from "@/editor/prosemirror/highlights";
import type { NoticeAction } from "@/editor/markdown/tsv";
import type { HighlightClickHandler } from "@/editor/highlight-activation";
import type { SlashMenuHandlers } from "@/editor/prosemirror/slash-menu";

function sameHighlights(a: SourceHighlight[], b: SourceHighlight[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.from !== y.from || x.to !== y.to || x.kind !== y.kind || x.id !== y.id || x.active !== y.active || x.color !== y.color) return false;
  }
  return true;
}

/** Built once: the same object for every pane, so a consumer can hold it as a stable dependency. */
const codeApi = createCodeApi();

export interface CodePaneProps {
  session: CollabSession;
  /** The mounted view and the CodeMirror values the shell needs with it; both null again on unmount. */
  onReady: (view: EditorView | null, api: CodeApi | null) => void;
  onSelection: (head: number, anchor: number) => void;
  onHighlightClick: HighlightClickHandler;
  /** Uploads a pasted or dropped image and returns its URL. */
  uploadImage?: ImageUploader;
  onImageError?: (message: string) => void;
  onNotice?: (message: string, action?: NoticeAction) => void;
  /** A dropped .md/.txt file and the source offset under the pointer. */
  onMarkdownFileDrop?: (file: File, at: number) => void;
  lineWrapping: boolean;
  /** Slash command menu plumbing (stable object; see SlashMenuController). */
  slashMenu?: SlashMenuHandlers;
}

interface CodePaneHandlers {
  onSelection: CodePaneProps["onSelection"];
  onHighlightClick: CodePaneProps["onHighlightClick"];
  uploadImage: CodePaneProps["uploadImage"];
  onImageError: CodePaneProps["onImageError"];
  onNotice: CodePaneProps["onNotice"];
  onMarkdownFileDrop: CodePaneProps["onMarkdownFileDrop"];
}

interface CodePaneVisit {
  active: boolean;
  session: CollabSession;
  host: HTMLDivElement;
  view: EditorView;
  setup: CodeEditorSetup;
  canEdit: boolean | null;
  suggesting: boolean | null;
  lineWrapping: boolean | null;
  lastHighlights: SourceHighlight[] | null;
}

export function CodePane({ session, onReady, onSelection, onHighlightClick, uploadImage, onImageError, onNotice, onMarkdownFileDrop, lineWrapping, slashMenu }: CodePaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const authority = useRef<CodePaneVisit | null>(null);
  const handlers = useRef<CodePaneHandlers>({ onSelection, onHighlightClick, uploadImage, onImageError, onNotice, onMarkdownFileDrop });

  useLayoutEffect(() => {
    handlers.current = { onSelection, onHighlightClick, uploadImage, onImageError, onNotice, onMarkdownFileDrop };
  }, [onSelection, onHighlightClick, uploadImage, onImageError, onNotice, onMarkdownFileDrop]);

  useLayoutEffect(() => {
    const mountedHost = host.current;
    if (!mountedHost) return;

    let visit: CodePaneVisit | null = null;
    let ownedView: EditorView | null = null;
    const hasAuthority = () =>
      visit !== null &&
      visit.active &&
      authority.current === visit &&
      visit.session === session &&
      visit.host === mountedHost &&
      visit.view === ownedView;
    const setup = createCodeEditorSetup(session, {
      onFocus: () => {
        if (hasAuthority()) session.setActiveSurface("code");
      },
      onSelection: (head, anchor) => {
        if (hasAuthority()) handlers.current.onSelection(head, anchor);
      },
      onHighlightClick: (kind, id, sourcePosition) => {
        if (hasAuthority()) handlers.current.onHighlightClick(kind, id, sourcePosition);
      },
      uploadImage: handlers.current.uploadImage
        ? (file) => {
            if (!hasAuthority()) return Promise.reject(new Error("Code editor visit is no longer active"));
            return handlers.current.uploadImage!(file);
          }
        : undefined,
      onImageError: (message) => {
        if (hasAuthority()) handlers.current.onImageError?.(message);
      },
      onNotice: (message, action) => {
        if (hasAuthority()) handlers.current.onNotice?.(message, action);
      },
      onMarkdownFileDrop: (file, at) => {
        if (hasAuthority()) handlers.current.onMarkdownFileDrop?.(file, at);
      },
      slashMenu,
    });
    const view = new EditorView({
      state: EditorState.create({ doc: session.ytext.toString(), extensions: setup.extensions }),
      parent: mountedHost,
    });
    ownedView = view;
    const unbindComposition = session.bindContentComposition(view.contentDOM);
    visit = {
      active: true,
      session,
      host: mountedHost,
      view,
      setup,
      canEdit: null,
      suggesting: null,
      lineWrapping: null,
      lastHighlights: null,
    };
    authority.current = visit;

    const applyMode = () => {
      if (!hasAuthority()) return;
      const canEdit = session.canEdit;
      const suggesting = session.mode === "suggesting";
      if (visit.canEdit === canEdit && visit.suggesting === suggesting) return;
      visit.canEdit = canEdit;
      visit.suggesting = suggesting;
      setup.setMode(view, canEdit, suggesting);
    };
    const applyHighlights = () => {
      if (!hasAuthority()) return;
      const focusSource = session.activeSurface === "rich" ? session.localCursor.rich : null;
      const focus = focusSource !== null ? { from: focusSource, to: focusSource } : null;
      const highlights = collectHighlights(session, focus).map((highlight) =>
        highlight.kind === "focus"
          ? {
              ...highlight,
              from: view.state.doc.lineAt(Math.min(highlight.from, view.state.doc.length)).from,
              to: view.state.doc.lineAt(Math.min(highlight.from, view.state.doc.length)).from,
            }
          : highlight,
      );
      if (visit.lastHighlights && sameHighlights(visit.lastHighlights, highlights)) return;
      visit.lastHighlights = highlights;
      view.dispatch({ effects: setHighlights.of(highlights) });
    };
    const updateFromSession = () => {
      if (!hasAuthority()) return;
      applyMode();
      applyHighlights();
    };
    const unsubscribe = session.subscribe(updateFromSession);

    onReady(view, codeApi);
    applyMode();
    visit.lineWrapping = lineWrapping;
    setup.setLineWrapping(view, lineWrapping);
    applyHighlights();

    return () => {
      if (!visit || !visit.active) return;
      visit.active = false;
      unsubscribe();
      unbindComposition();
      view.destroy();
      if (authority.current === visit) {
        authority.current = null;
        onReady(null, null);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useLayoutEffect(() => {
    const visit = authority.current;
    if (!visit?.active || visit.session !== session || visit.lineWrapping === lineWrapping) return;
    visit.lineWrapping = lineWrapping;
    visit.setup.setLineWrapping(visit.view, lineWrapping);
  }, [lineWrapping, session]);

  return <div ref={host} className="h-full min-h-0 w-full" data-testid="code-pane" />;
}
