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
import { closeDb, getDb } from "@/server/db";
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

// Standby mode (scripts/live/promote.ps1): with STANDBY_PORT set, the server comes up on
// 127.0.0.1:<STANDBY_PORT> against a throwaway in-memory database so the ops script can compile every
// route while the previous build keeps serving :PORT. `POST /_standby/takeover` on the standby port
// then closes the throwaway database, opens the real PGLITE_DATA_DIR and listens on :PORT — the whole
// handover is a database open plus a listen, with every route already compiled in memory.
const standbyPort = Number(process.env.STANDBY_PORT ?? 0);
const STANDBY_TAKEOVER_PATH = "/_standby/takeover";
const realDataDir = process.env.PGLITE_DATA_DIR;
if (standbyPort > 0) {
  process.env.PGLITE_DATA_DIR = "memory://";
  nextEnv.updateInitialEnv({ PGLITE_DATA_DIR: "memory://" });
}

function listenWithRetry(server: ReturnType<typeof createServer>, onPort: number, host: string, deadlineMs: number): Promise<void> {
  // The old process may still be releasing the port when the takeover arrives; retry EADDRINUSE briefly.
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE" && Date.now() < deadlineMs) setTimeout(attempt, 200);
        else reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(onPort, host);
    };
    attempt();
  });
}

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

  let takeover: Promise<void> | null = null;
  const runTakeover = async () => {
    if (hocuspocus.getDocumentsCount() > 0) {
      hocuspocus.closeConnections();
      hocuspocus.flushPendingStores();
      const until = Date.now() + 3000;
      while (hocuspocus.getDocumentsCount() > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      if (hocuspocus.getDocumentsCount() > 0) throw new Error("standby still holds documents from the throwaway database");
    }
    const t0 = Date.now();
    await closeDb();
    if (realDataDir === undefined) delete process.env.PGLITE_DATA_DIR;
    else process.env.PGLITE_DATA_DIR = realDataDir;
    nextEnv.updateInitialEnv({ PGLITE_DATA_DIR: realDataDir ?? "" });
    await getDb();
    const dbMs = Date.now() - t0;
    await listenWithRetry(server, port, bindHost, Date.now() + 15_000);
    console.log(`> Standby took over :${port} (database open ${dbMs} ms, listen ${Date.now() - t0 - dbMs} ms)`);
    standby?.close();
  };

  const server = createServer((req, res) => {
    if (standbyPort > 0 && req.url === STANDBY_TAKEOVER_PATH && req.socket.localPort === standbyPort) {
      if (req.method !== "POST") { res.statusCode = 405; res.end("POST"); return; }
      takeover ??= runTakeover();
      takeover.then(
        () => { res.statusCode = 200; res.end(JSON.stringify({ ok: true, port })); },
        (err: unknown) => {
          console.error("[standby] takeover failed", err);
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        },
      );
      return;
    }
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

  // In standby the same request handler also answers on the loopback side port; closing it after the
  // takeover leaves only :PORT.
  const standby = standbyPort > 0 ? createServer((req, res) => server.emit("request", req, res)) : null;
  if (standby) {
    standby.listen(standbyPort, "127.0.0.1", () => {
      console.log(`> Markdoc STANDBY on http://127.0.0.1:${standbyPort} (throwaway database; POST ${STANDBY_TAKEOVER_PATH} to take :${port})`);
    });
  } else {
    server.listen(port, bindHost, () => {
      const shownHost = hostname ?? "localhost";
      console.log(`> Markdoc ready on http://${shownHost}:${port} (${dev ? "development" : "production"})`);
      console.log(`> Collaboration WebSocket on ws://${shownHost}:${port}${COLLAB_PATH}`);
      if (!hostname) {
        for (const ip of lanAddresses()) console.log(`> Also reachable on the LAN at http://${ip}:${port}`);
      }
    });
  }

  const shutdown = async () => {
    console.log("> Shutting down, flushing documents...");
    server.close();
    standby?.close();
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
  console.error(err);
  process.exit(1);
});




