/**
 * Outer boxes of the editor shell's chrome, as Tailwind class strings. Two renderers share them: the
 * shell itself (`editor-shell.tsx`, `header.tsx`, `toolbar.tsx`, `outline.tsx`, `status-bar.tsx`) and the
 * server-rendered placeholder `src/app/d/[id]/editor-client.tsx` paints until the shell's chunks have
 * loaded (#1505). The placeholder only works if its boxes are the shell's to the pixel — header 57/65 px,
 * toolbar 48, pane-label row 48, status bar 41, rail 224 (open) / 40 (collapsed) — so a height lives
 * here once and never inline in either tree. A leaf module on purpose: no imports, so the placeholder's
 * chunk stays a few kilobytes.
 */

/** The shell's root: a viewport-high flex column. */
export const SHELL_BOX = "flex h-screen flex-col overflow-hidden bg-surface supports-[height:100dvh]:h-[100dvh]";

/** `<header>`: 56 px (`md`: 64 px) of content plus the 1 px bottom border (`box-content`). */
export const HEADER_BOX = "app-header safe-top safe-x box-content flex h-14 shrink-0 items-center gap-2 border-b border-line md:h-16 md:gap-3 md:[--safe-pad:1rem]";

/** Formatting toolbar: 48 px, border inside the box. */
export const TOOLBAR_BOX = "app-toolbar toolbar-scroll safe-x flex h-12 shrink-0 items-center gap-0.5 border-b border-line";

/** `<main id="editor-main">`: the row of rail, panes and side panel. */
export const MAIN_BOX = "relative flex min-h-0 flex-1";

/** Outline rail, open: 224 px. */
export const RAIL_BOX = "flex max-h-full min-h-0 w-56 shrink-0 flex-col border-r border-line";

/** Outline rail, collapsed to its toggle: 40 px (the shell's state below `TABLET_MAX`). */
export const RAIL_COLLAPSED_BOX = "flex w-10 shrink-0 flex-col items-center border-r border-line pt-3";

/** The panes' row (code column, rich column). */
export const PANES_BOX = "relative flex min-w-0 flex-1";

/** Code column base, and its extra classes when the rich column is shown beside it (split). */
export const CODE_COLUMN_BOX = "relative flex min-w-0 flex-col";
export const CODE_COLUMN_SPLIT = "flex-1 basis-0 border-r border-line";

/** Rich column base, and its extra classes when the code column is shown beside it (split). */
export const RICH_COLUMN_BOX = "rich-column flex min-w-0 flex-col";
export const RICH_COLUMN_SPLIT = "flex-1 basis-0";

/** The "Preview" label row above the rich pane: 48 px. */
export const PANE_LABEL_ROW_BOX = "flex h-12 shrink-0 items-center justify-between pl-6 pr-3";

/** The rich pane's scroll container. */
export const RICH_SCROLLER_BOX = "scrollbar-thin relative min-h-0 flex-1 overflow-y-auto";

/** The server-rendered preview's own box, inside the scroller (issue #118). */
export const RICH_PLACEHOLDER_BOX = "rich-placeholder reader-body";

/** `<footer>` status bar: 40 px of content plus the 1 px top border (`box-content`). */
export const STATUS_BOX = "safe-bottom safe-x box-content flex h-10 shrink-0 items-center gap-1 border-t border-line text-[13px] text-ink-3";
