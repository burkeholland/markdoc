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
 */
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

// Sync-only: runs on process.exit() from the server's SIGINT/SIGTERM handler and on natural exit.
process.on("exit", () => {
  revertTsconfigChurn();
});

await import("../server/index");
