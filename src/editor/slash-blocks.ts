import { slugify } from "./markdown/parse";

/**
 * Markdown produced by the slash items that came over from fancygist (`/toc`, `/callout`, `/footnote`,
 * `/lorem`). Pure functions, shared by the rich and the source editor so both insert the same text.
 */

export interface TocHeading {
  level: number;
  text: string;
}

/**
 * A nested bullet list of links to the headings, indented relative to the shallowest one. Duplicate
 * headings get `-1`, `-2` suffixes the way GitHub numbers their anchors. Empty when there are no headings.
 */
export function tocMarkdown(headings: readonly TocHeading[]): string {
  const usable = headings.filter((h) => h.text.trim());
  if (usable.length === 0) return "";
  const min = Math.min(...usable.map((h) => h.level));
  const seen = new Map<string, number>();
  return usable
    .map(({ level, text }) => {
      const base = slugify(text.trim());
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      const slug = count ? `${base}-${count}` : base;
      const label = text.trim().replace(/([\\[\]])/g, "\\$1");
      return `${"  ".repeat(level - min)}- [${label}](#${slug})`;
    })
    .join("\n");
}

export const CALLOUT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/** The callout kind an argument asks for (`/callout warn` → warning); NOTE when it names none. */
export function calloutKind(arg: string): CalloutKind {
  const word = arg.trim().toLowerCase();
  if (!word) return "note";
  return CALLOUT_KINDS.find((kind) => kind.startsWith(word)) ?? "note";
}

/** A GitHub alert (`> [!NOTE]`); the caret goes on the empty second line. */
export function calloutMarkdown(kind: CalloutKind): string {
  return `> [!${kind.toUpperCase()}]\n> `;
}

/** The next free numeric footnote label, one more than the largest `[^n]` in the document. */
export function nextFootnoteLabel(labels: Iterable<string>): string {
  let max = 0;
  for (const label of labels) {
    if (/^\d+$/.test(label)) max = Math.max(max, Number(label));
  }
  return String(max + 1);
}

/** Every footnote label referenced or defined in Markdown source. */
export function footnoteLabelsInSource(source: string): string[] {
  return [...source.matchAll(/\[\^([^\]\s]+)\]/g)].map((m) => m[1]);
}

export const LOREM_IPSUM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. " +
  "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. " +
  "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.";
