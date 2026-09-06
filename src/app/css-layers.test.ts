import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMPONENT_PREFIXES, parseRules, type Rule } from "./css-layers.helpers";

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
 *
 * `COMPONENT_PREFIXES` and the `parseRules` scanner live in css-layers.helpers.ts (md-rhythm.test.ts
 * shares the scanner).
 */

const css = readFileSync(path.resolve(__dirname, "globals.css"), "utf8");

// `.btn`, `.btn-sm`, `.btn:disabled`, `.icon-btn[data-active="true"]` — but not `.drawer > aside` or `.btnx`.
const prefixRe = new RegExp(`^\\.(${COMPONENT_PREFIXES.join("|")})(?:-[\\w-]*)?(?:[:\\[.][^\\s>+~]*)?$`);

const rules = parseRules(css);

const inComponentsLayer = (r: Rule) => r.parents.some((p) => /^@layer\s+components\b/.test(p));
const inConditional = (r: Rule) => r.parents.some((p) => /^@(media|supports|container)\b/.test(p));
const isSelector = (r: Rule) => !r.prelude.startsWith("@") && r.prelude !== "from" && r.prelude !== "to";

function appliedUtilities(selector: string): string[] {
  const rule = rules.find((candidate) => candidate.prelude === selector);
  const apply = rule?.body.match(/@apply\s+([^;]+);/);
  if (!apply) throw new Error(`Missing @apply rule for ${selector}`);
  return apply[1].split(/\s+/);
}

function utilityPixels(utilities: string[], prefix: string): number {
  const token = utilities.find((utility) => utility.startsWith(`${prefix}-`));
  const value = token?.slice(prefix.length + 1);
  if (!value) throw new Error(`Missing ${prefix} utility in ${utilities.join(" ")}`);
  const arbitrary = /^\[(\d+(?:\.\d+)?)px\]$/.exec(value);
  if (arbitrary) return Number(arbitrary[1]);
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`Unsupported ${prefix} utility: ${token}`);
  return Number(value) * 4;
}

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

  it("keeps the switch thumb centered at both ends of its 44px track", () => {
    const track = appliedUtilities(".switch");
    const thumb = appliedUtilities(".switch::after");
    const checkedThumb = appliedUtilities('.switch[aria-checked="true"]::after');
    const geometry = {
      trackWidth: utilityPixels(track, "w"),
      trackHeight: utilityPixels(track, "h"),
      border: track.includes("border") ? 1 : 0,
      inset: utilityPixels(thumb, "left"),
      thumbWidth: utilityPixels(thumb, "w"),
      thumbHeight: utilityPixels(thumb, "h"),
      translation: utilityPixels(checkedThumb, "translate-x"),
    };
    const uncheckedLeftGap = geometry.border + geometry.inset;
    const checkedRightGap =
      geometry.trackWidth - geometry.border - geometry.inset - geometry.thumbWidth - geometry.translation;

    expect(geometry).toEqual({
      trackWidth: 44,
      trackHeight: 24,
      border: 1,
      inset: 2,
      thumbWidth: 16,
      thumbHeight: 16,
      translation: 22,
    });
    expect({ uncheckedLeftGap, checkedRightGap }).toEqual({ uncheckedLeftGap: 3, checkedRightGap: 3 });
    expect(uncheckedLeftGap).toBe(checkedRightGap);
  });
});
