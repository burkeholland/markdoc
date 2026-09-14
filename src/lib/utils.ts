import { clsx, type ClassValue } from "clsx";
import { splitGraphemes } from "unicode-segmenter/grapheme";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

// Intl formatters cost ~1 ms each to construct; a list of 41 version rows or 75 comment timestamps
// built one per call was a visible share of a panel open (task #487). Built once, reused.
const formatters = new Map<string, Intl.DateTimeFormat>();
function dateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", options);
    formatters.set(key, f);
  }
  return f;
}
let relativeFormat: Intl.RelativeTimeFormat | null = null;

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function relativeTime(input: string | number | Date, now = Date.now()): string {
  const date = input instanceof Date ? input : new Date(input);
  const diff = (date.getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "just now";
  const rtf = (relativeFormat ??= new Intl.RelativeTimeFormat("en", { numeric: "auto" }));
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return dateFormat({ month: "short", day: "numeric", year: date.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" }).format(date);
}

export function formatDateTime(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  return dateFormat({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

/** "Monday, August 24" — the day heading used to group lists by calendar day. */
export function formatDayHeading(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  return dateFormat({ weekday: "long", month: "long", day: "numeric" }).format(date);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const words = parts.length === 1 ? parts : [parts[0], parts[parts.length - 1]];
  const limit = parts.length === 1 ? 2 : 1;
  let result = "";
  // Use pinned Unicode 17.0 / UAX #29 rev. 47 boundaries on both server and client.
  for (const word of words) {
    let selected = 0;
    for (const grapheme of splitGraphemes(word)) {
      result += grapheme;
      if (++selected === limit) break;
    }
  }
  return result.toUpperCase();
}

export function countWords(text: string): number {
  const words = text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
  return words ? words.length : 0;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function shortcut(keys: string): string {
  return keys.replace(/Mod/g, isMac ? "⌘" : "Ctrl").replace(/Alt/g, isMac ? "⌥" : "Alt").replace(/Shift/g, isMac ? "⇧" : "Shift");
}

/**
 * The keymap-style shortcut that opens find *and replace*: `Mod-H` on Windows/Linux, `Mod-Alt-F` on a
 * Mac, where ⌘H hides the application before the browser ever sees the key.
 */
export function findReplaceShortcut(mac: boolean = isMac): string {
  return mac ? "Mod-Alt-F" : "Mod-H";
}

export interface FindShortcutKey {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type FindShortcutAction = "find" | "replace" | null;

/**
 * What a keydown means for the find bar: `Mod-F` finds; `Ctrl-H` (Windows/Linux) or `⌥⌘F` (Mac) finds
 * and replaces. With Option held macOS reports a symbol in `key` (`⌥F` is "ƒ"), so the physical `code`
 * decides there; `Ctrl+Alt` on Windows/Linux is AltGr on many layouts and is left alone, and `⌘H` is
 * never bound on a Mac.
 */
export function findShortcutAction(e: FindShortcutKey, mac: boolean = isMac): FindShortcutAction {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return null;
  const key = e.key.toLowerCase();
  if (mac) {
    if (e.altKey) return e.code === "KeyF" || key === "f" ? "replace" : null;
    return key === "f" ? "find" : null;
  }
  if (e.altKey) return null;
  if (key === "f") return "find";
  if (key === "h") return "replace";
  return null;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
