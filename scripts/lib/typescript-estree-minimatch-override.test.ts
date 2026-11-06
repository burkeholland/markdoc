import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// package.json "overrides" gives @typescript-eslint/typescript-estree minimatch 11, outside the ^10 range it asks for,
// to clear GHSA-g3hv-75wg-m249. These tests read the installed package and fail when that stops being safe or needed.
const WHAT_TO_DO =
  "@typescript-eslint/typescript-estree changed how it uses minimatch. package.json overrides minimatch inside it "
  + "with a patched version, which is safe only while dist/useProgramFromProjectService.js alone requires it and "
  + "calls nothing but the named function minimatch. If the package now asks for minimatch 11.0.1 or later itself, "
  + "delete the override and this test file, then run `npm install --package-lock-only`. See \"The minimatch "
  + "override\" in docs/vm-hosting.md.";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageDirectory = path.join(root, "node_modules/@typescript-eslint/typescript-estree");
const dist = path.join(packageDirectory, "dist");
const USER = "useProgramFromProjectService.js";

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function overrideVersion(): unknown {
  const overrides = readJson(path.join(root, "package.json")).overrides as Record<string, Record<string, unknown>>;
  return overrides["@typescript-eslint/typescript-estree"].minimatch;
}

describe("the minimatch override for typescript-estree", () => {
  it("is one exact version, for that package only", () => {
    const overrides = readJson(path.join(root, "package.json")).overrides as Record<string, unknown>;
    expect(overrides.minimatch).toBeUndefined();
    expect(Object.keys(overrides["@typescript-eslint/typescript-estree"] as object)).toEqual(["minimatch"]);
    expect(overrideVersion()).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
  });

  it("is still needed: the package asks for a minimatch before the patched 11.0.1", () => {
    const dependencies = readJson(path.join(packageDirectory, "package.json")).dependencies as Record<string, unknown>;
    expect(dependencies.minimatch, WHAT_TO_DO).toMatch(/^\^10\./);
  });

  it("covers the only file of the package that mentions minimatch and the only function it calls", () => {
    const scripts = fs.readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((file) => /\.[cm]?js$/.test(file));
    const mentions = scripts.filter((file) => fs.readFileSync(path.join(dist, file), "utf8").includes("minimatch"));
    expect(mentions, WHAT_TO_DO).toEqual([USER]);
    const source = fs.readFileSync(path.join(dist, USER), "utf8");
    expect(source.match(/require\("minimatch"\)/g), WHAT_TO_DO).toHaveLength(1);
    const uses = [...source.matchAll(/\bminimatch_1\b(?:\.([A-Za-z_$][\w$]*))?/g)].map((match) => match[1] ?? "(the module itself)");
    expect([...new Set(uses)].sort(), WHAT_TO_DO).toEqual(["(the module itself)", "minimatch"]);
    expect(uses.filter((use) => use === "(the module itself)"), WHAT_TO_DO).toHaveLength(1);
  });

  it("gives the package the overridden version, which has that function", () => {
    const requireFromUser = createRequire(path.join(dist, USER));
    expect(readJson(requireFromUser.resolve("minimatch/package.json")).version).toBe(overrideVersion());
    expect((requireFromUser("minimatch") as Record<string, unknown>).minimatch).toBeTypeOf("function");
  });
});
