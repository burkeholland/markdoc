/**
 * `posttest:e2e` hook: by now Playwright has stopped the dev server, so the per-run dist dir
 * (`.next-e2e` or `.next-e2e-<E2E_PORT>`) can be removed without Turbopack panicking over its
 * cache, and any tsconfig.json include entries Next appended for it are reverted. This is the only
 * post-run delete: e2e/global-teardown.ts leaves the dist dir alone because the server still holds it.
 * npm skips this hook when `test:e2e` fails and `npx playwright test` never runs it; both cases are
 * covered by the pre-run delete in playwright.config.ts. Both steps are idempotent.
 */
import { e2eDistDir, removeDistDir } from "../e2e/dist-dir";
import { revertTsconfigChurn } from "./tsconfig-churn";

if (!process.env.PROD_BASE_URL) removeDistDir(e2eDistDir(), "post-run");
revertTsconfigChurn();
