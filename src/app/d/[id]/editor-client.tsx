"use client";

import dynamic from "next/dynamic";
import { createContext, useContext, useEffect, useState } from "react";
import type { EditorShellProps } from "@/components/editor/editor-shell";
import { loadEditorShell } from "@/components/editor/load-editor";
import { EditorChrome } from "@/components/editor/editor-chrome";
import { RICH_PLACEHOLDER_BOX } from "@/components/editor/chrome-classes";

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
 * The shell's chrome (`EditorChrome`: its exact outer boxes and landmarks, see `editor-chrome.tsx`) around
 * the preview, which is `inert` like the shell's own stand-in.
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
      <EditorChrome data-testid="editor-loading" aria-busy>
        {initialHtml && <div className={RICH_PLACEHOLDER_BOX} data-testid="rich-placeholder" aria-hidden="true" inert dangerouslySetInnerHTML={{ __html: initialHtml }} />}
      </EditorChrome>
    </>
  );
}

/**
 * On a phone-width screen the shell waits for one paint. When its module is already in memory (the
 * dashboard fetched it, `warm-editor.ts`) React would otherwise render the shell in the same pass as the
 * page, and on a phone that first render takes over a second during which nothing is on screen; with the
 * wait the preview is painted first, as on a cold load. Wider screens render the shell in ≈ 0.1 s, so there
 * it stays one step. The timer covers a tab that is not visible, where no frame is ever painted.
 */
function afterFirstPaint<T>(value: T): T | Promise<T> {
  if (window.matchMedia("(min-width: 768px)").matches) return value;
  return new Promise<T>((resolve) => {
    const done = () => resolve(value);
    requestAnimationFrame(() => setTimeout(done, 0));
    setTimeout(done, 200);
  });
}

// `loadEditorShell` is the shell's one `import()`: the dashboard calls it ahead of the first open
// (`warm-editor.ts`), and then this resolves from memory and, on a desktop, the placeholder is never painted.
const EditorShell = dynamic(() => loadEditorShell().then((m) => afterFirstPaint(m.EditorShell)), { ssr: false, loading: EditorPlaceholder });

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
