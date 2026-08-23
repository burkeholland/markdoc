// The one place that knows where this repo's siblings live. Every tool that reaches outside the
// checkout (the load gate, the live worktree, the live data dir) resolves through here so no script
// carries an absolute machine path.
//
//   FACTORY_ROOT env var if set, else the parent directory of the repo root (the directory that
//   holds this package.json).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Nearest ancestor of this file that contains a package.json. */
export function repoRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("factory-root: no package.json above " + import.meta.url);
    dir = parent;
  }
}

/** Directory the repo and its sibling checkouts live in. */
export function factoryRoot() {
  const fromEnv = process.env.FACTORY_ROOT;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.resolve(repoRoot(), "..");
}
