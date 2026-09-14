/** Find & replace over the Markdown source (shared by both editing surfaces). */

export interface FindOptions {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface FindMatch {
  from: number;
  to: number;
}

export const DEFAULT_FIND_OPTIONS: FindOptions = { matchCase: false, wholeWord: false, regex: false };

const MAX_MATCHES = 5000;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CompiledFindRegex {
  regex: RegExp | null;
  invalid: boolean;
}

/** Compile the query and report invalid syntax separately from an empty query. */
export function compileFindRegex(query: string, options: FindOptions): CompiledFindRegex {
  if (!query) return { regex: null, invalid: false };
  let source = options.regex ? query : escapeRegex(query);
  if (options.wholeWord) source = `(?<![\\p{L}\\p{M}\\p{N}_])(?:${source})(?![\\p{L}\\p{M}\\p{N}_])`;
  try {
    return { regex: new RegExp(source, "gu" + (options.matchCase ? "" : "i")), invalid: false };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { regex: null, invalid: options.regex };
  }
}

/** Compile the query into a global RegExp, or null when it is empty or invalid. */
export function buildFindRegex(query: string, options: FindOptions): RegExp | null {
  return compileFindRegex(query, options).regex;
}

/** All matches of the query in the text, in document order. */
export function findMatches(text: string, query: string, options: FindOptions): FindMatch[] {
  const re = buildFindRegex(query, options);
  if (!re) return [];
  const out: FindMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < MAX_MATCHES) {
    if (m[0].length === 0) {
      // Skip zero-width matches by a Unicode code point, including past the end.
      const codePoint = text.codePointAt(m.index);
      re.lastIndex = m.index + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
      continue;
    }
    out.push({ from: m.index, to: m.index + m[0].length });
  }
  return out;
}

/** Index of the first match starting at or after `offset` (wrapping to 0). */
export function matchIndexAfter(matches: FindMatch[], offset: number): number {
  if (matches.length === 0) return -1;
  for (let i = 0; i < matches.length; i++) if (matches[i].from >= offset) return i;
  return 0;
}

/** The match that `previous` most plausibly became after the text changed: same start, else the next one. */
export function carryActiveIndex(matches: FindMatch[], previous: FindMatch | null): number {
  if (matches.length === 0) return -1;
  if (!previous) return 0;
  const exact = matches.findIndex((m) => m.from === previous.from);
  if (exact !== -1) return exact;
  const after = matchIndexAfter(matches, previous.from);
  return after === -1 ? 0 : after;
}

/**
 * Replacement text for one match. In regex mode `$1`…`$9`, `$&` and `$$` are
 * expanded; otherwise the replacement is literal.
 */
export function expandReplacement(text: string, match: FindMatch, query: string, options: FindOptions, replacement: string): string {
  if (!options.regex) return replacement;
  const re = buildFindRegex(query, options);
  if (!re) return replacement;
  re.lastIndex = match.from;
  const m = re.exec(text);
  if (!m || m.index !== match.from) return replacement;
  return replacement.replace(/\$(\$|&|[1-9])/g, (_, g: string) => {
    if (g === "$") return "$";
    if (g === "&") return m[0];
    return m[Number(g)] ?? "";
  });
}
