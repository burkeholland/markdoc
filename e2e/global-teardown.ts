import { revertTsconfigChurn } from "../scripts/tsconfig-churn";

/**
 * Runs once after the last spec, before Playwright stops the webServer. The per-run dist dir is
 * deliberately not removed here: the dev server still holds its Turbopack cache open, and deleting
 * it underneath the server ended every run with a `thread panicked at turbopack…/operation/mod.rs`
 * line after the green summary. The dist dir is removed by `posttest:e2e` (scripts/e2e-cleanup.mts)
 * once the server has exited, and by the pre-run delete in playwright.config.ts before the next run
 * starts — the latter also covers failed runs (npm skips the post hook) and plain `npx playwright
 * test` invocations (no npm hooks at all). Only Next's tsconfig.json `include` churn is reverted here.
 */
export default async function globalTeardown() {
  if (process.env.PROD_BASE_URL) return;
  revertTsconfigChurn();
}
