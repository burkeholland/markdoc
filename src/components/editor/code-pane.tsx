"use client";

import { useCallback, useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CollabSession } from "@/editor/collab/session";
import { createCodeApi, type CodeApi } from "@/editor/codemirror/api";
import { createCodeEditorSetup, type CodeEditorSetup } from "@/editor/codemirror/setup";
import type { ImageUploader } from "@/editor/prosemirror/images";
import { setHighlights, type SourceHighlight } from "@/editor/codemirror/highlights";
import { collectHighlights } from "@/editor/prosemirror/highlights";
import type { NoticeAction } from "@/editor/markdown/tsv";
import { useSessionValue } from "./use-session";

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
  onHighlightClick: (kind: string, id: string | null) => void;
  /** Uploads a pasted or dropped image and returns its URL. */
  uploadImage?: ImageUploader;
  onImageError?: (message: string) => void;
  onNotice?: (message: string, action?: NoticeAction) => void;
  /** A dropped .md/.txt file and the source offset under the pointer. */
  onMarkdownFileDrop?: (file: File, at: number) => void;
  lineWrapping: boolean;
}

export function CodePane({ session, onReady, onSelection, onHighlightClick, uploadImage, onImageError, onNotice, onMarkdownFileDrop, lineWrapping }: CodePaneProps) {
  // Source offset of the rich pane's cursor while the rich pane is active (for the focus line).
  const focusSource = useSessionValue(session, (s) => (s.activeSurface === "rich" ? s.localCursor.rich : null));
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const setupRef = useRef<CodeEditorSetup | null>(null);
  const handlers = useRef({ onSelection, onHighlightClick, uploadImage, onImageError, onNotice, onMarkdownFileDrop });
  useEffect(() => {
    handlers.current = { onSelection, onHighlightClick, uploadImage, onImageError, onNotice, onMarkdownFileDrop };
  }, [onSelection, onHighlightClick, uploadImage, onImageError, onNotice, onMarkdownFileDrop]);
  const focusRef = useRef<number | null>(null);
  const lastHighlights = useRef<SourceHighlight[] | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const setup = createCodeEditorSetup(session, {
      onFocus: () => session.setActiveSurface("code"),
      onSelection: (head, anchor) => handlers.current.onSelection(head, anchor),
      onHighlightClick: (kind, id) => handlers.current.onHighlightClick(kind, id),
      uploadImage: handlers.current.uploadImage ? (file) => handlers.current.uploadImage!(file) : undefined,
      onImageError: (message) => handlers.current.onImageError?.(message),
      onNotice: (message, action) => handlers.current.onNotice?.(message, action),
      onMarkdownFileDrop: (file, at) => handlers.current.onMarkdownFileDrop?.(file, at),
    });
    const view = new EditorView({
      state: EditorState.create({ doc: session.ytext.toString(), extensions: setup.extensions }),
      parent: host.current,
    });
    viewRef.current = view;
    setupRef.current = setup;
    lastHighlights.current = null;
    onReady(view, codeApi);
    return () => {
      onReady(null, null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Mode / permissions.
  const canEdit = useSessionValue(session, (s) => s.canEdit);
  const suggesting = useSessionValue(session, (s) => s.mode === "suggesting");
  useEffect(() => {
    if (viewRef.current && setupRef.current) setupRef.current.setMode(viewRef.current, canEdit, suggesting);
  }, [canEdit, suggesting]);

  useEffect(() => {
    if (viewRef.current && setupRef.current) setupRef.current.setLineWrapping(viewRef.current, lineWrapping);
  }, [lineWrapping]);

  // Comment / suggestion / focus highlights follow the session directly (no React render per keystroke).
  // The session notifies on every change while a document opens (status, awareness, each comment thread,
  // the text itself); only an actual change in the highlight list is dispatched. A CodeMirror dispatch
  // reads the DOM selection, which forces a layout of whatever the rich pane and React left dirty — on
  // the 12k-word document those no-op dispatches added up to ~200 ms of forced layout per open (#118).
  const applyHighlights = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const focusSource = focusRef.current;
    const focus = focusSource !== null && session.activeSurface === "rich" ? { from: focusSource, to: focusSource } : null;
    const highlights = collectHighlights(session, focus).map((h) =>
      h.kind === "focus" ? { ...h, from: view.state.doc.lineAt(Math.min(h.from, view.state.doc.length)).from, to: view.state.doc.lineAt(Math.min(h.from, view.state.doc.length)).from } : h,
    );
    if (lastHighlights.current && sameHighlights(lastHighlights.current, highlights)) return;
    lastHighlights.current = highlights;
    view.dispatch({ effects: setHighlights.of(highlights) });
  }, [session]);
  useEffect(() => {
    focusRef.current = focusSource;
    applyHighlights();
  }, [focusSource, applyHighlights]);
  useEffect(() => session.subscribe(applyHighlights), [session, applyHighlights]);

  return <div ref={host} className="h-full min-h-0 w-full" data-testid="code-pane" />;
}

