/**
 * Undo the `include` entries `next dev` / `next typegen` append to tsconfig.json for whatever
 * NEXT_DIST_DIR was in use (e.g. `.next-e2e-3190/types/**\/*.ts`). Next matches those entries by
 * exact string (lib/typescript/writeConfigurationDefaults.js), so no glob can pre-empt the edit;
 * the only alternative is `experimental.strictRouteTypes`, which changes app typing. Hence: revert.
 *
 * Safety rule: the file is restored from the git index ONLY when the working copy differs from it
 * by nothing but added `.next*\/(dev\/)?types/**\/*.ts` include entries. Any other difference is an
 * intentional edit; we print the diff and leave the file alone.
 *
 *   npx tsx scripts/tsconfig-churn.ts   # CLI; also imported by e2e/global-teardown.ts and scripts/dev-port.mts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TSCONFIG = "tsconfig.json";
const NEXT_TYPES_ENTRY = /^\.next[^/\\]*\/(dev\/)?types\/\*\*\/\*\.ts$/;

type TsConfig = { include?: unknown } & Record<string, unknown>;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export type ChurnResult = "clean" | "reverted" | "kept" | "skipped";

export function revertTsconfigChurn(cwd = process.cwd(), log: (line: string) => void = console.log): ChurnResult {
  const file = path.join(cwd, TSCONFIG);
  let indexed: string;
  try {
    if (!hasWorktreeDiff(cwd)) return "clean";
    indexed = git(["show", `:${TSCONFIG}`], cwd);
  } catch (err) {
    log(`[tsconfig] cannot compare ${TSCONFIG} with git (${(err as Error).message.split("\n")[0]}); leaving it alone`);
    return "skipped";
  }

  let working: string;
  try {
    working = readFileSync(file, "utf8");
  } catch {
    return "skipped";
  }

  if (onlyNextTypesAdded(indexed, working)) {
    writeFileSync(file, indexed);
    log(`[tsconfig] reverted Next's auto-added .next*/types include entries in ${TSCONFIG}`);
    return "reverted";
  }

  log(`[tsconfig] ${TSCONFIG} has changes beyond Next's .next*/types include entries; not touching it. Diff:`);
  try {
    log(git(["--no-pager", "diff", "--", TSCONFIG], cwd));
  } catch {
    /* diff output is informational only */
  }
  return "kept";
}

function hasWorktreeDiff(cwd: string): boolean {
  // `git diff --quiet` exits 1 (throws) when the working copy differs from the index.
  try {
    git(["diff", "--quiet", "--", TSCONFIG], cwd);
    return false;
  } catch (err) {
    if ((err as { status?: number }).status === 1) return true;
    throw err;
  }
}

function onlyNextTypesAdded(indexedText: string, workingText: string): boolean {
  let a: TsConfig;
  let b: TsConfig;
  try {
    a = JSON.parse(indexedText) as TsConfig;
    b = JSON.parse(workingText) as TsConfig;
  } catch {
    return false;
  }
  if (!Array.isArray(a.include) || !Array.isArray(b.include)) return false;
  const aInclude = a.include as unknown[];
  const bInclude = b.include as unknown[];
  // Next appends; the original entries must still be there, in order, at the front.
  if (bInclude.length <= aInclude.length) return false;
  for (let i = 0; i < aInclude.length; i++) if (aInclude[i] !== bInclude[i]) return false;
  for (const extra of bInclude.slice(aInclude.length)) {
    if (typeof extra !== "string" || !NEXT_TYPES_ENTRY.test(extra)) return false;
  }
  // Everything except `include` must be identical.
  const stripInclude = (cfg: TsConfig) => JSON.stringify({ ...cfg, include: undefined });
  return stripInclude(a) === stripInclude(b);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = revertTsconfigChurn();
  if (result === "clean") console.log(`[tsconfig] ${TSCONFIG} unchanged`);
}
