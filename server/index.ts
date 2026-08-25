import { createServer } from "node:http";
import nextEnv from "@next/env";
import next from "next";

const dev = process.env.NODE_ENV !== "production";

// `next dev` (cli/next-dev) puts __NEXT_DEV_SERVER=1 in its child's environment before anything
// else runs; a custom server only gets it set inside app.prepare(). @next/env snapshots process.env
// on its first loadEnvConfig() call and, on every forced reload (any .env* change event, including
// the watcher's first aggregation on a cold start), deletes every variable that was not in that
// snapshot. Without this line the snapshot below predates prepare(), the reload wipes
// __NEXT_DEV_SERVER, and every route module built afterwards believes it is a production build:
// it then tries to read <distDir>/required-server-files.json (which `next dev` never writes) and
// answers 500 "ENOENT … required-server-files.json" for every request until the process restarts.
if (dev) process.env.__NEXT_DEV_SERVER = "1";

// Load .env files the same way Next.js does, so the collaboration server sees them too.
nextEnv.loadEnvConfig(process.cwd(), dev);
// scripts/dev-port.mts loads the env (and takes the snapshot) before importing this file.
if (dev) nextEnv.updateInitialEnv({ __NEXT_DEV_SERVER: "1" });
import { createCollabServer, shutdownCollab } from "@/server/collab/hocuspocus";
import { registerCollab } from "@/server/collab/registry";
import { attachCollab, COLLAB_PATH } from "@/server/collab/ws";
import { getDb } from "@/server/db";
import { purgeTrashOlderThan, TRASH_RETENTION_DAYS } from "@/server/documents";
import { REMOTE_ADDR_HEADER } from "@/server/rate-limit";
import { lanAddresses } from "../scripts/lib/dev-origins.mjs";

/** How often documents that have been in the trash for more than TRASH_RETENTION_DAYS are removed for good. */
const TRASH_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Bind address. Only a concrete HOST is handed to Next as its hostname: for the default 0.0.0.0
// Next would stamp "http://0.0.0.0:<port>" into every absolute URL it builds (Auth.js redirects
// included), which no browser can follow. Without it Next falls back to localhost for its own
// URLs; Auth.js uses the request's Host header instead (src/app/api/auth/[...nextauth]/route.ts).
const bindHost = process.env.HOST ?? "0.0.0.0";
const hostname = bindHost === "0.0.0.0" || bindHost === "::" ? undefined : bindHost;
const port = Number(process.env.PORT ?? 3000);

// Exit trace (task #614): the live server once died with nothing in live.log. Whatever ends this process
// leaves one line here, with the uptime, so a silent death can be told apart from a kill or a crash.
const startedAt = Date.now();
const uptime = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
const describe = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));
process.on("exit", (code) => {
  console.log(`> [exit] process exiting with code ${code} after ${uptime()}`);
});
// Without these listeners Node prints the error and exits 1 (the rejection is raised as an uncaught
// exception since v15); keep that outcome, just with the uptime on the line.
process.on("uncaughtException", (err, origin) => {
  console.error(`> [exit] ${origin} after ${uptime()}:`, describe(err));
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(`> [exit] unhandledRejection after ${uptime()}:`, describe(reason));
  process.exit(1);
});

async function main() {
  // Fail fast on database problems before accepting traffic.
  await getDb();

  const app = next({ dev, hostname, port, turbopack: dev });
  await app.prepare();
  const handle = app.getRequestHandler();
  const upgrade = app.getUpgradeHandler();

  const hocuspocus = createCollabServer();
  registerCollab(hocuspocus);

  const purgeTrash = () =>
    purgeTrashOlderThan(TRASH_RETENTION_DAYS)
      .then((n) => n > 0 && console.log(`> Purged ${n} document(s) from the trash`))
      .catch((err: unknown) => console.error("[trash] purge failed", err));
  void purgeTrash();
  setInterval(purgeTrash, TRASH_PURGE_INTERVAL_MS).unref();

  const server = createServer((req, res) => {
    // The address the socket saw, for the per-IP rate limiter: always overwritten so a client cannot forge it.
    const remote = req.socket.remoteAddress;
    if (remote) req.headers[REMOTE_ADDR_HEADER] = remote;
    else delete req.headers[REMOTE_ADDR_HEADER];
    handle(req, res).catch((err: unknown) => {
      console.error("[http] request failed", err);
      if (!res.headersSent) res.statusCode = 500;
      res.end("internal server error");
    });
  });

  attachCollab(server, hocuspocus, { path: COLLAB_PATH, fallback: upgrade });

  server.listen(port, bindHost, () => {
    const shownHost = hostname ?? "localhost";
    console.log(`> Markdoc ready on http://${shownHost}:${port} (${dev ? "development" : "production"})`);
    console.log(`> Collaboration WebSocket on ws://${shownHost}:${port}${COLLAB_PATH}`);
    if (!hostname) {
      for (const ip of lanAddresses()) console.log(`> Also reachable on the LAN at http://${ip}:${port}`);
    }
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`> [exit] ${signal} after ${uptime()}; shutting down, flushing documents...`);
    server.close();
    try {
      await shutdownCollab(hocuspocus);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`> [exit] startup failed after ${uptime()}:`, describe(err));
  process.exit(1);
});




