import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Issue #2257: some Radix builds wrapped side-effect helpers as
 * `(/* @__PURE__ *\/ __name(function updateSearch(v) { ... }, "updateSearch"))(search)`.
 * The production minifier trusts the PURE mark and drops the whole call, so menu typeahead (and Select,
 * and ScrollArea's resize loop) silently stopped working in production only. Fail on any such call.
 */
const PURE_IIFE = /\/\* @__PURE__ \*\/ __name\(\(?function[\s\S]*?\}\)?, "[\w$]+"\)\)\(/;

function radixBundles(): string[] {
  const root = join(process.cwd(), "node_modules", "@radix-ui");
  return readdirSync(root)
    .flatMap((pkg) => ["index.mjs", "index.js"].map((file) => join(root, pkg, "dist", file)))
    .filter((file) => existsSync(file));
}

describe("Radix bundles (#2257)", () => {
  it("finds the installed Radix packages", () => {
    expect(radixBundles().length).toBeGreaterThan(10);
  });

  it("detects the broken shape", () => {
    expect(PURE_IIFE.test('(/* @__PURE__ */ __name((function updateSearch(value) {\n  x = value;\n}), "updateSearch"))(search);')).toBe(true);
    expect(PURE_IIFE.test('var Menu = /* @__PURE__ */ __name((props) => {\n}, "Menu");')).toBe(false);
  });

  it("has no PURE-marked function that is called immediately", () => {
    const offenders = radixBundles().filter((file) => {
      const source = readFileSync(file, "utf8");
      // Only calls whose result is discarded matter: look at each `"name"))(` site.
      return source.split(/\n/).some((line, index, lines) => /"[\w$]+"\)\)\(/.test(line) && PURE_IIFE.test(lines.slice(Math.max(0, index - 40), index + 1).join("\n")));
    });
    expect(offenders).toEqual([]);
  });
});
