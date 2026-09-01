import { defineConfig } from "vitest/config";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/** The whole unit suite; every file below lands in exactly one of the two projects. */
const ALL_TESTS = ["src/**/*.test.ts", "src/**/*.test.tsx", "server/**/*.test.ts", "scripts/**/*.test.ts"];
const NEVER = ["node_modules", ".next", "e2e"];

/** Candidates for `pure`: every test file under these directories, plus the single files. */
const PURE_DIRS = ["src/editor", "src/lib", "src/components", "server", "src/app/login", "src/app/api/mcp", "src/server/og"];
const PURE_FILES = [
  "src/app/css-layers.test.ts",
  "src/app/md-rhythm.test.ts",
  "src/app/tokens-contrast.test.ts",
  "src/app/theme-contrast.test.ts",
  "src/app/confidential.test.ts",
  "scripts/lib/custom-domain-preflight.test.ts",
  "src/server/seed-rate-limit-retry.test.ts",
  "src/server/db/externals.test.ts",
  "src/server/db/pglite-postgres-destination.test.ts",
];

/** Candidates that break the rule (see `projects` below); they stay isolated in `default`. */
const PURE_EXCLUDE = [
  "src/app/api/mcp/annotations.test.ts", // process: spawns `node mcp/server.mjs` over stdio
  "src/app/api/mcp/route.test.ts", // mock (also writes process.env and boots the database)
  "src/app/md-rhythm.test.ts", // imports ./css-layers.test: a test file is only evaluated once per shared module cache
  "src/app/tokens-contrast.test.ts", // imports ./theme-contrast.test (same reason)
  "src/app/login/page.test.tsx", // mock
  "src/components/editor/collaborator-login-input.test.tsx", // mock
  "src/components/editor/comments-panel.test.tsx", // mock
  "src/components/editor/find-bar.test.tsx", // mock
  "src/components/editor/github-dialog.test.tsx", // mock
  "src/components/editor/share-dialog.test.tsx", // mock
  "src/components/settings/settings-live-regions.test.tsx", // mock
  "src/components/settings/tokens-panel.test.tsx", // mock
  "src/components/ui/dialog.test.tsx", // mock
  "src/editor/collab/offline.test.ts", // mock
  "src/editor/collab/session-comments.test.ts", // mock
  "src/editor/collab/session-connect.test.ts", // mock
  "src/editor/collab/session-find.test.ts", // mock
  "src/editor/collab/session-reconnect.test.ts", // mock
  "src/editor/prosemirror/code-highlight.test.ts", // mock
  "src/lib/clipboard.test.ts", // global: redefines document.execCommand, not restored in a hook
  "src/lib/sign-out.test.ts", // mock
  "src/lib/theme.test.ts", // global: replaces window.matchMedia by hand and never restores it
];

const posix = (file: string) => file.split(path.sep).join("/");
const candidates = [
  ...PURE_DIRS.flatMap((dir) =>
    readdirSync(path.join(root, dir), { recursive: true })
      .map(String)
      .filter((file) => /\.test\.tsx?$/.test(file))
      .map((file) => posix(path.join(dir, file))),
  ),
  ...PURE_FILES,
];
for (const file of PURE_FILES) if (!existsSync(path.join(root, file))) throw new Error(`vitest.config: PURE_FILES entry "${file}" does not exist`);
for (const file of PURE_EXCLUDE) if (!candidates.includes(file)) throw new Error(`vitest.config: PURE_EXCLUDE entry "${file}" is not a pure candidate`);
/** Resolved once so both projects see the same set: `pure` includes exactly these, `default` excludes exactly these. */
const PURE = candidates.filter((file) => !PURE_EXCLUDE.includes(file)).sort();

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    // Two projects split the suite by how much state a file may leak (#1273 profile, cut 2):
    // `default` runs every file in its own fork (vitest's default), `pure` runs the stateless files with
    // `isolate: false`, so files in the same worker and environment share one process, module cache and jsdom.
    // A file qualifies for `pure` when nothing it does outlives the file: no vi.mock / vi.doMock / vi.hoisted
    // (module mocks are only reset between files when `isolate` is on), no vi.stubEnv / vi.stubGlobal or
    // hand-written global / process.env writes without a restore in afterEach or afterAll, no import of another
    // *.test file (its describe blocks would register once per worker instead of once per file), and no PGlite
    // or getDb(), server, child process or browser. A file is disqualified by any one of those, or by failing
    // only under `pure` or only under `--sequence.shuffle.files`: when that happens, add it to PURE_EXCLUDE with
    // the reason — do not edit the test to make it pass. The `// @vitest-environment jsdom` pragma keeps working
    // in both projects. Run one project with `--project pure` or `--project default`.
    projects: [
      {
        extends: true,
        test: {
          name: "default",
          isolate: true,
          include: ALL_TESTS,
          exclude: [...NEVER, ...PURE],
        },
      },
      {
        extends: true,
        test: {
          name: "pure",
          isolate: false,
          include: PURE,
          exclude: NEVER,
        },
      },
    ],
  },
});
