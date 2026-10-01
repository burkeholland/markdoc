"use client";

import dynamic from "next/dynamic";
import { createContext, useContext, useEffect, useState } from "react";
import type { EditorShellProps } from "@/components/editor/editor-shell";
import { cn } from "@/lib/utils";
import {
  CODE_COLUMN_BOX,
  CODE_COLUMN_SPLIT,
  HEADER_BOX,
  MAIN_BOX,
  PANE_LABEL_ROW_BOX,
  PANES_BOX,
  RAIL_BOX,
  RAIL_COLLAPSED_BOX,
  RICH_COLUMN_BOX,
  RICH_COLUMN_SPLIT,
  RICH_PLACEHOLDER_BOX,
  RICH_SCROLLER_BOX,
  SHELL_BOX,
  STATUS_BOX,
  TOOLBAR_BOX,
} from "@/components/editor/chrome-classes";

/**
 * The editor stack (ProseMirror, Yjs, micromark, Radix, the shell itself — 8 chunks, ≈ 925 kB) loads
 * after first paint (#1505): the server renders only `EditorPlaceholder` — the shell's chrome at the
 * shell's heights and the #118 preview in the rich column's box — and `EditorShell` replaces it when
 * its chunks have loaded. On a phone that turns a ≈ 19 s blank-then-collapsing first paint into a
 * readable preview at ≈ 3 s with no layout shift; the editor becomes interactive at the same time as
 * before, because the same chunks parse after hydration instead of before it.
 */

/** The server-rendered preview, read by the placeholder from the props `EditorClient` received. */
const PreviewContext = createContext<string | null>(null);

/**
 * Chrome of the shell's exact outer boxes (`chrome-classes.ts`), phone-correct by itself so nothing moves
 * when the shell takes over: the outline rail is absent below `md` (the shell's phone drawer), the 40 px
 * collapsed strip from `md` to `lg` (the shell closes the rail below `TABLET_MAX`, `editor-shell.tsx`
 * l.≈212) and the open 224 px rail from `lg`; the code column is hidden below `md` like the shell's
 * `split` layout. Landmarks match the shell (`<header>`, `<main id="editor-main">`, `<footer>`); nothing
 * in here is focusable, and the preview is `inert` like the shell's own stand-in.
 */
function EditorPlaceholder() {
  const initialHtml = useContext(PreviewContext);
  // Filled once after mount: a live region's initial text is not announced, a change to it is.
  const [status, setStatus] = useState("");
  useEffect(() => setStatus("Loading the editor…"), []);
  return (
    <>
      <p className="sr-only" role="status" aria-live="polite" data-testid="editor-loading-status">
        {status}
      </p>
      <div className={SHELL_BOX} data-testid="editor-loading" aria-busy="true">
        <header className={HEADER_BOX} />
        <div className={TOOLBAR_BOX} />
        <main id="editor-main" className={MAIN_BOX}>
          <div className={cn(RAIL_COLLAPSED_BOX, "max-md:hidden lg:hidden")} />
          <div className={cn(RAIL_BOX, "max-lg:hidden")} />
          <div className={PANES_BOX}>
            <div className={cn(CODE_COLUMN_BOX, CODE_COLUMN_SPLIT, "max-md:hidden")} />
            <div className={cn(RICH_COLUMN_BOX, RICH_COLUMN_SPLIT)}>
              <div className={PANE_LABEL_ROW_BOX}>
                <span className="pane-label">Preview</span>
              </div>
              <div className={RICH_SCROLLER_BOX}>
                {initialHtml && <div className={RICH_PLACEHOLDER_BOX} data-testid="rich-placeholder" aria-hidden="true" inert dangerouslySetInnerHTML={{ __html: initialHtml }} />}
              </div>
            </div>
          </div>
        </main>
        <footer className={STATUS_BOX} />
      </div>
    </>
  );
}

const EditorShell = dynamic(() => import("@/components/editor/editor-shell").then((m) => m.EditorShell), { ssr: false, loading: EditorPlaceholder });

export function EditorClient(props: EditorShellProps) {
  // A stable host keeps the swapped-in shell where the placeholder was. Without it React appends the shell
  // at the end of <body> — after Next's scripts, the route announcer and, in dev, the nextjs-portal dev tools,
  // whose focusable button then precedes the skip link (a11y's first-Tab tests). `contents` adds no box.
  return (
    <div className="contents" data-testid="editor-root">
      <PreviewContext.Provider value={props.initialHtml ?? null}>
        <EditorShell {...props} />
      </PreviewContext.Provider>
    </div>
  );
}
