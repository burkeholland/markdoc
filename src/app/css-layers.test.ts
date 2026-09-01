import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Cascade-layer guard for globals.css. Tailwind 4 orders `theme, base, components, utilities`; a rule
 * written outside any layer beats every utility no matter its specificity, so `className="input pl-9"`
 * would keep `.input`'s px-3 and the search icon would sit on the placeholder. Every component class
 * definition must therefore live in `@layer components`, and `@apply` must never appear outside it.
 *
 * Two kinds of rules are allowed to stay unlayered on purpose and are skipped here:
 * - rules nested in `@media` / `@supports` / `@container` (phone font-size 16px, reduced motion) —
 *   those are device overrides that are meant to beat call-site utilities;
 * - rules whose subject is a descendant (`.drawer > aside`) — they style the child, not the component,
 *   and must win over the child's own utilities.
 */

const css = readFileSync(path.resolve(__dirname, "globals.css"), "utf8");

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

// `.btn`, `.btn-sm`, `.btn:disabled`, `.icon-btn[data-active="true"]` — but not `.drawer > aside` or `.btnx`.
const prefixRe = new RegExp(`^\\.(${COMPONENT_PREFIXES.join("|")})(?:-[\\w-]*)?(?:[:\\[.][^\\s>+~]*)?$`);

interface Rule {
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

const rules = parseRules(css);

const inComponentsLayer = (r: Rule) => r.parents.some((p) => /^@layer\s+components\b/.test(p));
const inConditional = (r: Rule) => r.parents.some((p) => /^@(media|supports|container)\b/.test(p));
const isSelector = (r: Rule) => !r.prelude.startsWith("@") && r.prelude !== "from" && r.prelude !== "to";

function unlayeredComponentRules(list: Rule[]): string[] {
  const out: string[] = [];
  for (const r of list) {
    if (!isSelector(r) || inConditional(r) || inComponentsLayer(r)) continue;
    const subjects = r.prelude
      .split(",")
      .map((s) => s.trim())
      .filter((s) => prefixRe.test(s));
    if (subjects.length) out.push(`line ${r.line}: ${subjects.join(", ")}`);
  }
  return out;
}

function unlayeredApply(list: Rule[]): string[] {
  return list.filter((r) => /@apply\b/.test(r.body) && !inComponentsLayer(r)).map((r) => `line ${r.line}: ${r.prelude}`);
}

describe("globals.css cascade layers", () => {
  it("imports tailwindcss first so its layer order (theme, base, components, utilities) applies", () => {
    expect(css.trimStart().startsWith('@import "tailwindcss";')).toBe(true);
  });

  it("has an @layer components block", () => {
    expect(rules.some((r) => /^@layer\s+components\b/.test(r.prelude))).toBe(true);
  });

  it("defines every component class inside @layer components", () => {
    const offenders = unlayeredComponentRules(rules);
    expect(offenders, `component classes defined outside @layer components:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("never uses @apply outside @layer components", () => {
    const offenders = unlayeredApply(rules);
    expect(offenders, `@apply outside @layer components:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("lists every class defined in @layer components in COMPONENT_PREFIXES", () => {
    // Keeps the prefix list honest: a new `.chip { @apply … }` must be added above so it is guarded too.
    const missing = new Set<string>();
    for (const r of rules) {
      if (!isSelector(r) || !inComponentsLayer(r)) continue;
      for (const s of r.prelude.split(",")) {
        const m = /^\s*\.([a-z][\w-]*)/i.exec(s);
        if (!m || m[1] === "scrollbar-thin") continue; // scrollbar-thin is a utility-like helper, not a component
        if (!COMPONENT_PREFIXES.some((p) => m[1] === p || m[1].startsWith(`${p}-`))) missing.add(m[1]);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it("catches an unlayered component class and a stray @apply (self-check)", () => {
    const sample = [
      '@import "tailwindcss";',
      "@layer components { .btn { @apply h-9; } .btn:disabled { opacity: 0.5; } }",
      ".input { @apply px-3; }",
      ".btn-x:hover, .cm-editor { color: red; }",
      ".drawer > aside { width: 100%; }",
      '@media (max-width: 10px) { .input, .textarea { font-size: 16px; } .dialog { width: 1px; } }',
      "@keyframes k { from { opacity: 0; } to { opacity: 1; } }",
    ].join("\n");
    const parsed = parseRules(sample);
    expect(unlayeredComponentRules(parsed)).toEqual(["line 3: .input", "line 4: .btn-x:hover"]);
    expect(unlayeredApply(parsed)).toEqual(["line 3: .input"]);
  });
});
