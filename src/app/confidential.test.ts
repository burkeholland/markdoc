import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Confidentiality guard. Certain words (internal project and model names) must never appear in the
 * tracked tree — not in code, docs, scripts or tests. The words themselves are deliberately not
 * written here: they come from `CONFIDENTIAL_WORDS` (comma-separated, see .env.example), which the
 * factory sets for the verification run. Without the variable the test skips and says so.
 *
 * Runs `git grep -i -l` over the tracked files of the working tree, so a hit anywhere in a tracked
 * file fails the run with the offending file names only — never the matched text.
 */

const repoRoot = path.resolve(__dirname, "..", "..");

function confidentialWords(): string[] {
  return (process.env.CONFIDENTIAL_WORDS ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
}

/** Tracked files whose contents contain any of the words (case-insensitive). */
export function filesMentioning(words: string[], cwd = repoRoot): string[] {
  if (words.length === 0) return [];
  const args = ["grep", "-i", "-l", "--no-color"];
  for (const w of words) args.push("-e", w);
  args.push("--", ".");
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return out.split(/\r?\n/).filter(Boolean).sort();
  } catch (err) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    const e = err as { status?: number; stderr?: string };
    if (e.status === 1) return [];
    throw new Error(`git grep failed (exit ${e.status}): ${e.stderr ?? ""}`);
  }
}

describe("confidentiality guard", () => {
  const words = confidentialWords();

  it.skipIf(words.length === 0)("no tracked file mentions a confidential word", () => {
    const offenders = filesMentioning(words);
    expect(offenders, `files mentioning a CONFIDENTIAL_WORDS entry:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  if (words.length === 0) {
    it("is skipped until CONFIDENTIAL_WORDS is set", () => {
      console.info("confidential.test.ts: CONFIDENTIAL_WORDS is unset; set it (comma-separated) to run the guard");
    });
  }
});
