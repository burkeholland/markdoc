import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { budgetScale } from "./scripts/lib/test-budget.ts";

console.info(`[vitest] stress timing budgets x${budgetScale()}`);

const root = path.dirname(fileURLToPath(import.meta.url));
const include = ["src/**/*.test.ts", "src/**/*.test.tsx", "server/**/*.test.ts", "scripts/**/*.test.ts"];
const exclude = ["node_modules", ".next", "e2e"];
const livePdfTest = "src/server/export/pdf.test.ts";
const resolve = {
  alias: {
    "@": path.resolve(root, "src"),
  },
};
const sharedTest = {
  environment: "node" as const,
  setupFiles: ["./vitest.setup.ts"],
  testTimeout: 20000,
  hookTimeout: 30000,
};

export default defineConfig({
  resolve,
  test: {
    ...sharedTest,
    // Let ordinary files keep their default parallelism, then run the sole Chromium-backed file without worker contention.
    projects: [
      {
        resolve,
        test: {
          ...sharedTest,
          name: "unit",
          include,
          exclude: [...exclude, livePdfTest],
          sequence: { groupOrder: 0 },
        },
      },
      {
        resolve,
        test: {
          ...sharedTest,
          name: "live-pdf",
          include: [livePdfTest],
          exclude,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
