import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import eslintConfig, { assertNoNextRootDir } from "../../eslint.config.mjs";

// package.json "overrides" installs tinyglobby under the name fast-glob inside @next/eslint-plugin-next, so that
// braces is not in the lock (#2294). That is only safe while the plugin uses fast-glob the way version 16.3.6 does.
// These tests read the installed plugin and fail when a later version uses it in another way.
const WHAT_TO_DO =
  "@next/eslint-plugin-next changed how it uses fast-glob. package.json overrides fast-glob inside the plugin with "
  + "tinyglobby (#2294), which is safe only while the plugin requires it in dist/utils/get-root-dirs.js alone and "
  + "calls nothing but globSync. If the plugin no longer depends on fast-glob, delete the override from "
  + "package.json, the check at the end of eslint.config.mjs and this test file, then run "
  + "`npm install --package-lock-only`. Otherwise do not ship this version of the plugin with the override: decide "
  + "again as in issue #2294.";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromRoot = createRequire(path.join(root, "package.json"));
const requireFromNextConfig = createRequire(requireFromRoot.resolve("eslint-config-next"));
const pluginDirectory = path.dirname(path.dirname(requireFromNextConfig.resolve("@next/eslint-plugin-next")));
const USER = "utils/get-root-dirs.js";

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function scriptsBelow(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.[cm]?js$/.test(entry.name))
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, "/"))
    .sort();
}

describe("the fast-glob override for the Next lint plugin (#2294)", () => {
  it("reads the plugin that eslint-config-next loads", () => {
    expect(readJson(path.join(pluginDirectory, "package.json")).name).toBe("@next/eslint-plugin-next");
    expect(scriptsBelow(path.join(pluginDirectory, "dist"))).toContain(USER);
  });

  it("is one exact version of tinyglobby, for the plugin only", () => {
    const overrides = readJson(path.join(root, "package.json")).overrides as Record<string, unknown>;
    expect(overrides["fast-glob"]).toBeUndefined();
    expect(Object.keys(overrides["@next/eslint-plugin-next"] as object)).toEqual(["fast-glob"]);
    expect((overrides["@next/eslint-plugin-next"] as Record<string, unknown>)["fast-glob"])
      .toMatch(/^npm:tinyglobby@[0-9]+\.[0-9]+\.[0-9]+$/);
  });

  it("is still needed: the plugin depends on fast-glob", () => {
    const dependencies = readJson(path.join(pluginDirectory, "package.json")).dependencies as Record<string, unknown>;
    expect(dependencies["fast-glob"], WHAT_TO_DO).toBeTypeOf("string");
  });

  it("covers the only file of the plugin that mentions fast-glob", () => {
    const dist = path.join(pluginDirectory, "dist");
    const mentions = scriptsBelow(dist).filter((file) => fs.readFileSync(path.join(dist, file), "utf8").includes("fast-glob"));
    expect(mentions, WHAT_TO_DO).toEqual([USER]);
  });

  it("covers the only function the plugin takes from fast-glob", () => {
    const source = fs.readFileSync(path.join(pluginDirectory, "dist", USER), "utf8");
    const bindings = [...source.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*require\((["'])fast-glob\2\);?/g)];
    expect(bindings, WHAT_TO_DO).toHaveLength(1);
    expect(source.split("fast-glob"), WHAT_TO_DO).toHaveLength(2);
    const [declaration, name] = bindings[0];
    const escaped = name.replace(/[$]/g, "\\$&");
    const uses = [...source.replace(declaration, "").matchAll(new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])(?:\\.([A-Za-z_$][\\w$]*))?`, "g"))]
      .map((match) => match[1] ?? "(the module itself)");
    expect(uses.length, WHAT_TO_DO).toBeGreaterThan(0);
    expect([...new Set(uses)], WHAT_TO_DO).toEqual(["globSync"]);
  });

  it("gives the plugin a package that has that function", () => {
    const requireFromUser = createRequire(path.join(pluginDirectory, "dist", USER));
    let directory = path.dirname(requireFromUser.resolve("fast-glob"));
    while (!fs.existsSync(path.join(directory, "package.json"))) directory = path.dirname(directory);
    expect(readJson(path.join(directory, "package.json")).name).toBe("tinyglobby");
    expect((requireFromUser("fast-glob") as Record<string, unknown>).globSync).toBeTypeOf("function");
  });

  it("never reaches that function: no lint setting asks the plugin to expand a root directory", () => {
    expect(() => assertNoNextRootDir(eslintConfig)).not.toThrow();
    expect(eslintConfig.some((entry) => entry.settings?.next !== undefined)).toBe(false);
  });

  it.each([
    ["a directory", "."],
    ["a pattern", "packages/*/"],
    ["a list", ["apps/web"]],
    ["an empty text", ""],
    ["null", null],
  ])("stops the linter when a setting asks for %s", (_case, rootDir) => {
    const config = [...eslintConfig, { settings: { next: { rootDir } } }];
    expect(() => assertNoNextRootDir(config)).toThrow("settings.next.rootDir cannot be set while package.json overrides fast-glob");
  });

  it("allows other settings", () => {
    expect(() => assertNoNextRootDir([{ settings: { react: { version: "detect" } } }, { settings: { next: {} } }, {}])).not.toThrow();
  });

  // The check must also be wired into the config file itself. A copy of the real file with one more entry is loaded
  // from node_modules/.cache, where Node finds the same packages; the unchanged copy shows the place is not the cause.
  it("makes the real config file refuse to load once an entry sets the root directory", async () => {
    const source = fs.readFileSync(path.join(root, "eslint.config.mjs"), "utf8");
    const anchor = /^ {2}\.\.\.nextTs,\r?\n/m;
    expect(source.match(new RegExp(anchor, "gm"))).toHaveLength(1);
    const cache = path.join(root, "node_modules/.cache");
    fs.mkdirSync(cache, { recursive: true });
    const directory = fs.mkdtempSync(path.join(cache, "markdoc-2294-"));
    try {
      const unchanged = path.join(directory, "unchanged.mjs");
      const changed = path.join(directory, "changed.mjs");
      fs.writeFileSync(unchanged, source);
      fs.writeFileSync(changed, source.replace(anchor, (line) => `${line}  { settings: { next: { rootDir: "." } } },\n`));
      await expect(import(pathToFileURL(unchanged).href)).resolves.toHaveProperty("default");
      await expect(import(pathToFileURL(changed).href)).rejects.toThrow("settings.next.rootDir cannot be set");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
