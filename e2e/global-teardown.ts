import { e2eDistDir, removeDistDir } from "./dist-dir";
import { revertTsconfigChurn } from "../scripts/tsconfig-churn";

/**
 * Runs once after the last spec, before Playwright stops the webServer. Removing the per-run dist
 * dir here is therefore best-effort (the dev server may still hold files open on Windows); the
 * `posttest:e2e` npm hook (scripts/e2e-cleanup.mts) runs after the server is gone and finishes the
 * job, and playwright.config.ts deletes whatever is left before the next run starts.
 */
export default async function globalTeardown() {
  if (process.env.PROD_BASE_URL) return;
  removeDistDir(e2eDistDir(), "teardown");
  revertTsconfigChurn();
}
