/**
 * `posttest:e2e` hook: by now Playwright has stopped the dev server, so the per-run dist dir
 * (`.next-e2e` or `.next-e2e-<E2E_PORT>`) can be removed for real, and any tsconfig.json include
 * entries Next appended for it are reverted. Both steps are idempotent; e2e/global-teardown.ts
 * already attempted them while the server was still up.
 */
import { e2eDistDir, removeDistDir } from "../e2e/dist-dir";
import { revertTsconfigChurn } from "./tsconfig-churn";

if (!process.env.PROD_BASE_URL) removeDistDir(e2eDistDir(), "post-run");
revertTsconfigChurn();
