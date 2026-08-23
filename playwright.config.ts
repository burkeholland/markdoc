import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { e2eDistDir, removeDistDir } from "./e2e/dist-dir";
import { factoryRoot } from "./scripts/lib/factory-root.mjs";

const PORT = Number(process.env.E2E_PORT ?? 3100);
// PROD_BASE_URL points the suite at an already-running production build (see e2e/prod-smoke.spec.ts);
// no dev server is started in that case.
const prodBaseURL = process.env.PROD_BASE_URL?.replace(/\/$/, "");
const baseURL = prodBaseURL ?? `http://localhost:${PORT}`;

// Several devs share this machine. When the Tools team's load gate is installed, start the dev
// server only once CPU is <= 70 % (it gives up and starts anyway after 300 s), so the server's
// first compile does not race other suites. Without the tool the command is unchanged. The tool lives
// in the sibling `tools` checkout (FACTORY_ROOT overrides the default `..`; see scripts/lib/factory-root.mjs).
const LOAD_GATE = path.join(factoryRoot(), "tools", "bin", "load.mjs");
const SERVER_COMMAND = "npx tsx server/index.ts";
const useLoadGate = !prodBaseURL && existsSync(LOAD_GATE);
const webServerCommand = useLoadGate ? `node "${LOAD_GATE}" --wait 70 --max 300 -- ${SERVER_COMMAND}` : SERVER_COMMAND;
// 180 s is enough for the server boot alone; when gated, the up-to-300 s wait must not eat into it.
const webServerTimeout = useLoadGate ? 480_000 : 180_000;

// One Next dist dir per run so two worktrees (or a killed previous run) never share a cache:
// `.next-e2e` when E2E_PORT is unset, `.next-e2e-<port>` otherwise (see e2e/dist-dir.ts).
const distDir = e2eDistDir();
// Playwright re-imports this file in every worker process; only the runner (no TEST_WORKER_INDEX)
// may delete the cache, and only before the webServer starts. A stale cache is never useful for a
// test run (404s on every API route, EPERM on app-paths-manifest.json); Next recompiles in ~30 s.
if (!prodBaseURL && process.env.TEST_WORKER_INDEX === undefined) {
  removeDistDir(distDir, "pre-run");
}

export default defineConfig({
  testDir: "./e2e",
  // Compiles the editor and API routes once before the first spec (no-op with PROD_BASE_URL).
  globalSetup: "./e2e/global-setup.ts",
  // Removes the per-run dist dir (best-effort) and reverts Next's tsconfig.json `include` churn.
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 1000 },
  },
  webServer: prodBaseURL
    ? undefined
    : {
        command: webServerCommand,
        url: baseURL,
        reuseExistingServer: false,
        timeout: webServerTimeout,
        // E2E_SERVER_LOG=1 echoes the dev server's stdout too (browser console errors such as
        // hydration warnings are forwarded there by Next); stderr is always echoed.
        stdout: process.env.E2E_SERVER_LOG ? "pipe" : "ignore",
        env: {
          PORT: String(PORT),
          AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-e2e",
          AUTH_DEV_LOGIN: "1",
          PGLITE_DATA_DIR: "memory://",
          NEXT_DIST_DIR: distDir,
          AUTO_VERSION_INTERVAL_MS: "1000",
          READER_POLL_MS: "2000",
          NODE_ENV: "development",
        },
      },
});


