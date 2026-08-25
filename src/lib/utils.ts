import { clsx, type ClassValue } from "clsx";

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
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function countWords(text: string): number {
  const words = text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
  return words ? words.length : 0;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function shortcut(keys: string): string {
  return keys.replace(/Mod/g, isMac ? "⌘" : "Ctrl").replace(/Alt/g, isMac ? "⌥" : "Alt").replace(/Shift/g, isMac ? "⇧" : "Shift");
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
