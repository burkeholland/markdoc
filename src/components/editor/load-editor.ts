/**
 * The editor's two on-demand modules, each behind its one `import()`. The document page renders them
 * (`src/app/d/[id]/editor-client.tsx`, `editor-shell.tsx`) and the dashboard fetches them ahead of the
 * first open (`src/components/dashboard/warm-editor.ts`); both go through here so a module is requested
 * once per page however many callers ask. A leaf on purpose: only `import()`s, so importing this file
 * adds nothing to the caller's own chunk.
 */
export const loadEditorShell = () => import("./editor-shell");
export const loadCodePane = () => import("./code-pane");
