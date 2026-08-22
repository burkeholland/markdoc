import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "server/**/*.test.ts"],
    exclude: ["node_modules", ".next", "e2e"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
