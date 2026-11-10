import { loadCodePane, loadEditorShell } from "@/components/editor/load-editor";

/** The code pane is shown from this width up (`md`); narrower screens open the rich layout and never fetch it. */
const CODE_PANE_MIN_WIDTH = "(min-width: 768px)";
/** Longest the browser may postpone an idle step. */
const IDLE_TIMEOUT_MS = 4000;

interface ConnectionHints {
  saveData?: boolean;
  effectiveType?: string;
}

export interface WarmEditorOptions {
  loadShell?: () => Promise<unknown>;
  loadCodePane?: () => Promise<unknown>;
}

/** A person who asked the browser to save data, or is on a 2G-class link, keeps their bytes. */
function shouldSaveData(): boolean {
  const connection = (navigator as Navigator & { connection?: ConnectionHints }).connection;
  return connection?.saveData === true || /(^|-)2g$/.test(connection?.effectiveType ?? "");
}

/**
 * Fetch the editor's code while the dashboard sits idle, so opening a document does not wait for it.
 *
 * Opening a document from the dashboard used to download and run the editor (ProseMirror, Yjs, the
 * shell, then CodeMirror in a second round) after the click: the page showed empty chrome, then the
 * shell, then the code pane. With the modules already in memory the click goes straight to the shell.
 *
 * Nothing starts before the window's `load` event and an idle period after it, so the dashboard's own
 * requests and first paint come first; each module runs in an idle step of its own. Returns a function
 * that cancels whatever has not started.
 */
export function warmEditorWhenIdle({ loadShell = loadEditorShell, loadCodePane: loadCode = loadCodePane }: WarmEditorOptions = {}): () => void {
  if (shouldSaveData()) return () => undefined;
  let cancelled = false;
  let cancelStep: (() => void) | null = null;

  const whenIdle = (run: () => void) => {
    if (typeof requestIdleCallback === "function") {
      const handle = requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
      cancelStep = () => cancelIdleCallback(handle);
    } else {
      const handle = setTimeout(run, 1000);
      cancelStep = () => clearTimeout(handle);
    }
  };
  // A failed request (offline, a deploy that replaced the chunks) costs nothing: the open loads them as before.
  const quietly = (load: () => Promise<unknown>) => load().catch(() => undefined);
  // `html[data-editor-warm]`: everything this screen will need is in memory (e2e/first-paint.spec.ts waits for it).
  const done = () => {
    if (!cancelled) document.documentElement.dataset.editorWarm = "";
  };

  const start = () => {
    whenIdle(() => {
      if (cancelled) return;
      void quietly(loadShell).then(() => {
        if (cancelled) return;
        if (!window.matchMedia(CODE_PANE_MIN_WIDTH).matches) return done();
        whenIdle(() => {
          if (!cancelled) void quietly(loadCode).then(done);
        });
      });
    });
  };

  if (document.readyState === "complete") start();
  else {
    window.addEventListener("load", start, { once: true });
    cancelStep = () => window.removeEventListener("load", start);
  }
  return () => {
    cancelled = true;
    cancelStep?.();
  };
}
