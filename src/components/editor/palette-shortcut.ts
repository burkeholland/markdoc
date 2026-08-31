/**
 * Whether a keydown should open the command palette. Mod-Shift-P always; Mod-K only with a
 * collapsed selection outside text inputs (Mod-K with a selection still means "Link").
 *
 * Lives apart from `command-palette.tsx` so the editor shell's keydown handler can stay synchronous
 * without pinning the palette (a `next/dynamic` chunk since #1150) to the route's entry JS.
 */
export function isPaletteShortcut(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return false;
  const key = e.key.toLowerCase();
  if (e.shiftKey && key === "p") return true;
  if (e.shiftKey || key !== "k") return false;
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  return !sel || sel.isCollapsed;
}
