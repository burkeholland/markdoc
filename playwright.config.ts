import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
// PROD_BASE_URL points the suite at an already-running production build (see e2e/prod-smoke.spec.ts);
// no dev server is started in that case.
const prodBaseURL = process.env.PROD_BASE_URL?.replace(/\/$/, "");
const baseURL = prodBaseURL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
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
        command: "npx tsx server/index.ts",
        url: baseURL,
        reuseExistingServer: false,
        timeout: 180_000,
        env: {
          PORT: String(PORT),
          AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-e2e",
          AUTH_DEV_LOGIN: "1",
          PGLITE_DATA_DIR: "memory://",
          NEXT_DIST_DIR: ".next-e2e",
          AUTO_VERSION_INTERVAL_MS: "1000",
          NODE_ENV: "development",
        },
      },
});


