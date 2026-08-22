"use client";

import { useCallback, useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CollabSession } from "@/editor/collab/session";
import { createCodeEditorSetup, type CodeEditorSetup } from "@/editor/codemirror/setup";
import { setHighlights } from "@/editor/codemirror/highlights";
import { collectHighlights } from "@/editor/prosemirror/highlights";
import { useSessionValue } from "./use-session";

export interface CodePaneProps {
  session: CollabSession;
  onReady: (view: EditorView | null) => void;
  onSelection: (head: number, anchor: number) => void;
  onHighlightClick: (kind: string, id: string | null) => void;
  /** Source offset of the rich pane's cursor when the rich pane is active (for the focus line). */
  focusSource: number | null;
  lineWrapping: boolean;
}

export function CodePane({ session, onReady, onSelection, onHighlightClick, focusSource, lineWrapping }: CodePaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const setupRef = useRef<CodeEditorSetup | null>(null);
  const handlers = useRef({ onSelection, onHighlightClick });
  useEffect(() => {
    handlers.current = { onSelection, onHighlightClick };
  }, [onSelection, onHighlightClick]);
  const focusRef = useRef<number | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const setup = createCodeEditorSetup(session, {
      onFocus: () => session.setActiveSurface("code"),
      onSelection: (head, anchor) => handlers.current.onSelection(head, anchor),
      onHighlightClick: (kind, id) => handlers.current.onHighlightClick(kind, id),
    });
    const view = new EditorView({
      state: EditorState.create({ doc: session.ytext.toString(), extensions: setup.extensions }),
      parent: host.current,
    });
    viewRef.current = view;
    setupRef.current = setup;
    onReady(view);
    return () => {
      onReady(null);
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
  const applyHighlights = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const focusSource = focusRef.current;
    const focus = focusSource !== null && session.activeSurface === "rich" ? { from: focusSource, to: focusSource } : null;
    const highlights = collectHighlights(session, focus).map((h) =>
      h.kind === "focus" ? { ...h, from: view.state.doc.lineAt(Math.min(h.from, view.state.doc.length)).from, to: view.state.doc.lineAt(Math.min(h.from, view.state.doc.length)).from } : h,
    );
    view.dispatch({ effects: setHighlights.of(highlights) });
  }, [session]);
  useEffect(() => {
    focusRef.current = focusSource;
    applyHighlights();
  }, [focusSource, applyHighlights]);
  useEffect(() => session.subscribe(applyHighlights), [session, applyHighlights]);

  return <div ref={host} className="h-full min-h-0 w-full" data-testid="code-pane" />;
}

