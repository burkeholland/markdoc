/**
 * Manual dev server that never collides with the e2e suite or another dev's server in the same
 * worktree:
 *
 *   PORT=3800 npm run dev:port          # PowerShell: $env:PORT=3800; npm run dev:port
 *
 * PORT defaults to 3200. Sets NEXT_DIST_DIR=.next-manual-<port> and
 * PGLITE_DATA_DIR=.data/pglite-<port> (unless already set), then runs server/index.ts in this
 * process so Ctrl+C still goes through the server's graceful shutdown. On exit, the tsconfig.json
 * `include` entries Next appended for the dist dir are reverted (scripts/tsconfig-churn.ts).
 *
 * A fresh worktree has no .env.local, and Auth.js refuses to start without AUTH_SECRET. This
 * script (and only this script — never server/index.ts) fills in dev-only defaults so it works out
 * of the box: AUTH_SECRET=dev-only-secret-<port> and AUTH_DEV_LOGIN=1. Anything already set wins.
 */
import nextEnv from "@next/env";
import { revertTsconfigChurn } from "./tsconfig-churn";

const port = Number(process.env.PORT ?? 3200);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[dev:port] PORT must be a TCP port number, got ${JSON.stringify(process.env.PORT)}`);
  process.exit(2);
}

process.env.PORT = String(port);
process.env.NEXT_DIST_DIR ??= `.next-manual-${port}`;
process.env.PGLITE_DATA_DIR ??= `.data/pglite-${port}`;

console.log(`[dev:port] port ${port} · NEXT_DIST_DIR=${process.env.NEXT_DIST_DIR} · PGLITE_DATA_DIR=${process.env.PGLITE_DATA_DIR}`);

// Read .env* first (server/index.ts gets the cached result) so a real .env.local always wins over
// the defaults below. updateInitialEnv keeps them through Next's env reload on .env changes.
nextEnv.loadEnvConfig(process.cwd(), true);
const devDefaults: Record<string, string> = {};
if (!process.env.AUTH_SECRET) devDefaults.AUTH_SECRET = `dev-only-secret-${port}`;
if (!process.env.AUTH_DEV_LOGIN) devDefaults.AUTH_DEV_LOGIN = "1";
const applied = Object.keys(devDefaults);
if (applied.length > 0) {
  Object.assign(process.env, devDefaults);
  nextEnv.updateInitialEnv(devDefaults);
  console.log(`[dev:port] no .env.local value for ${applied.join(", ")} · applied dev-only defaults: ${applied.map((k) => `${k}=${devDefaults[k]}`).join(" ")}`);
}

// Sync-only: runs on process.exit() from the server's SIGINT/SIGTERM handler and on natural exit.
process.on("exit", () => {
  revertTsconfigChurn();
});

await import("../server/index");
