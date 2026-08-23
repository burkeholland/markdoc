import { existsSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Next dist dir for this e2e run. `.next-e2e` when E2E_PORT is unset (muscle memory),
 * `.next-e2e-<port>` otherwise, so two worktrees or a killed previous run never share a cache.
 * Shared by playwright.config.ts (pre-run delete + NEXT_DIST_DIR), global-setup (fast-fail
 * message), global-teardown and scripts/e2e-cleanup.mts.
 */
export function e2eDistDir(): string {
  const port = process.env.E2E_PORT;
  return port ? `.next-e2e-${Number(port)}` : ".next-e2e";
}

/** Best-effort recursive delete. EBUSY/EPERM (server still holding files on Windows) is logged, not thrown. */
export function removeDistDir(distDir: string, phase: string): boolean {
  const abs = path.resolve(distDir);
  if (!existsSync(abs)) return true;
  try {
    rmSync(abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    console.log(`[e2e dist] ${phase}: removed ${distDir}`);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    console.log(`[e2e dist] ${phase}: could not remove ${distDir} (${code}); ignored, the next run deletes it first`);
    return false;
  }
}
