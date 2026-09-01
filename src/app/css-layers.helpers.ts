/**
 * Shared by css-layers.test.ts and md-rhythm.test.ts. A test file must never import another test file:
 * that re-registers the imported file's `describe`s into the importer (its tests run twice) and, under a
 * shared module cache, the imported file reports `No test suite found`. Not a route: Next ignores non-route
 * files in `app/`, and `*.helpers.ts` is outside vitest's `*.test.ts` include.
 */

/** Prefixes of the component classes defined in globals.css. `btn` also covers `.btn-primary`, `.btn:disabled`. */
export const COMPONENT_PREFIXES = [
  "btn",
  "icon-btn",
  "input",
  "textarea",
  "select",
  "menu",
  "dialog",
  "kbd",
  "pane-label",
  "skip-link",
  "avatar",
  "drawer",
  "sheet",
  "switch",
] as const;

export interface Rule {
  prelude: string;
  line: number;
  /** Preludes of the enclosing blocks, outermost first. */
  parents: string[];
  /** The block's own declarations (nested blocks excluded), whitespace-collapsed. */
  body: string;
}

/** Brace-depth scan; skips comments and string literals so braces inside them are not counted. */
export function parseRules(source: string): Rule[] {
  const rules: Rule[] = [];
  const open: Rule[] = [];
  let text = "";
  let line = 1;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      line += (source.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      text += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "{") {
      // Everything since the last `;` (or the previous brace) is this block's prelude.
      const semi = text.lastIndexOf(";");
      const prelude = text.slice(semi + 1).trim();
      const parent = open[open.length - 1];
      if (parent) parent.body += text.slice(0, semi + 1);
      const rule: Rule = { prelude, line, parents: open.map((r) => r.prelude), body: "" };
      rules.push(rule);
      open.push(rule);
      text = "";
      i++;
      continue;
    }
    if (ch === "}") {
      const done = open.pop();
      if (done) done.body += text;
      text = "";
      i++;
      continue;
    }
    if (ch === "\n") line++;
    text += ch;
    i++;
  }
  for (const r of rules) r.body = r.body.replace(/\s+/g, " ").trim();
  return rules;
}
