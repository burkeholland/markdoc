import { defineConfig } from "@playwright/test";

// Failure-page snapshots can contain a one-time secret even when tracing is off.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
  testDir: ".",
  // The .flow.ts suffix keeps this opt-in flow out of the root config's default spec discovery.
  testMatch: /token-management\.flow\.ts$/,
  outputDir: ".\\test-results\\token-management",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  captureGitInfo: { commit: false, diff: false },
  // A lead must separately start a sanitized, disposable server; this config starts nothing.
  use: {
    browserName: "chromium",
    baseURL: process.env.PROD_BASE_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:3414",
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
