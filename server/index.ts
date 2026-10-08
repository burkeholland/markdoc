// Application-side imports reach Next request APIs before prepare(), so initialize its Node globals first.
import "next/dist/server/node-environment.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
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
import { attachCollab, COLLAB_PATH, protectUpgradePath } from "@/server/collab/ws";
import { closeDb, getDb } from "@/server/db";
import { purgeTrashOlderThan, TRASH_RETENTION_DAYS } from "@/server/documents";
import { httpOrigin, mcpRestOrigin } from "@/server/mcp-origin";
import { REMOTE_ADDR_HEADER } from "@/server/rate-limit";
import { localAccess } from "../scripts/lib/dev-origins.mjs";
import { attachRequestErrorGuards, attachUpgradeErrorGuard } from "./request-guards";
import { attachRequestLog } from "./request-log";
import { serveStaticBrotli } from "./static-brotli";
import { startGistAutoUpdateWorker, stopGistAutoUpdateWorker } from "@/server/gist-auto-update";
import { createShutdownOwner } from "./shutdown";

/** How often documents that have been in the trash for more than TRASH_RETENTION_DAYS are removed for good. */
const TRASH_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Baseline security headers on every response, set here rather than in the proxy because the proxy
// matcher skips /api/auth, /_next/static, /_next/image and favicon.ico, and the brotli branch below
// never reaches Next at all. Next keeps headers that are already on `res`: middleware headers land via
// setHeader, a route's Response headers are only appended when absent (send-response.js), and nothing
// on the app-router path removes them — so a route that sets the same header (nosniff on
// /api/assets) keeps one value, not two. The frame policy stays in src/proxy.ts: it depends on the
// embed cookie and must not touch /api/*.
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Clipboard is deliberately not restricted: the Copilot canvas frame relies on it.
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
// One year, no includeSubDomains/preload until the custom-domain question (docs/custom-domain.md) is
// settled. Only for requests that arrived over HTTPS: the Container Apps ingress terminates TLS and
// sets x-forwarded-proto, while local dev and the e2e server speak plain HTTP.
const STRICT_TRANSPORT_SECURITY = "max-age=31536000";

function arrivedOverHttps(req: IncomingMessage): boolean {
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",", 1)[0]?.trim().toLowerCase();
  return proto === "https" || (req.socket as { encrypted?: boolean }).encrypted === true;
}

function setSecurityHeaders(req: IncomingMessage, res: ServerResponse) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (arrivedOverHttps(req)) res.setHeader("Strict-Transport-Security", STRICT_TRANSPORT_SECURITY);
}

// Where `next build` put the client assets (same rule as next.config.ts). Production serves the
// precompressed `.br` siblings from here; `next dev` writes no `.br` files and the branch stays off.
const staticRoot = path.resolve(process.cwd(), process.env.NEXT_DIST_DIR || ".next", "static");

// Bind address. Only a concrete HOST is handed to Next as its hostname: for the default 0.0.0.0
// Next would stamp "http://0.0.0.0:<port>" into every absolute URL it builds (Auth.js redirects
// included), which no browser can follow. Without it Next falls back to localhost for its own
// URLs; Auth.js uses the request's Host header instead (src/app/api/auth/[...nextauth]/route.ts).
const bindHost = process.env.HOST ?? "0.0.0.0";
const hostname = bindHost === "0.0.0.0" || bindHost === "::" ? undefined : bindHost;
const port = Number(process.env.PORT ?? 3000);
const localUrls = localAccess(port);

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

type RuntimeResources = {
  server: Server | null;
  standby: Server | null;
  app: ReturnType<typeof next> | null;
  appPreparation: Promise<void> | null;
  hocuspocus: ReturnType<typeof createCollabServer> | null;
  collabAttachment: AbortController | null;
  databaseInitialization: Promise<unknown> | null;
  publishing: boolean;
};

const runtime: RuntimeResources = {
  server: null,
  standby: null,
  app: null,
  appPreparation: null,
  hocuspocus: null,
  collabAttachment: null,
  databaseInitialization: null,
  publishing: false,
};

function closeHttpIntake(server: Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  server.removeAllListeners("upgrade");
  // destroy() alone was not seen to raise an 'error' here; the guard keeps the rule "no upgrade socket
  // of ours without an 'error' listener" (#2311) true on this path if it ever writes an answer.
  server.on("upgrade", (req, socket) => {
    attachUpgradeErrorGuard(req, socket);
    socket.destroy();
  });
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(new Error("HTTP intake did not close"));
    });
  });
}

async function stopRuntimeIntake(): Promise<void> {
  runtime.collabAttachment?.abort();
  const serverResults = await Promise.allSettled([
    closeHttpIntake(runtime.server),
    closeHttpIntake(runtime.standby),
  ]);
  const preparationFailed = runtime.appPreparation
    ? await runtime.appPreparation.then(() => false, () => true)
    : false;
  const frameworkFailed = runtime.app
    ? await runtime.app.close().then(() => false, () => true)
    : false;
  if (preparationFailed || frameworkFailed || serverResults.some((result) => result.status === "rejected")) {
    throw new Error("HTTP or WebSocket intake did not close");
  }
}

async function closeRuntimeDatabase(): Promise<void> {
  const initializationFailed = runtime.databaseInitialization
    ? await runtime.databaseInitialization.then(() => false, () => true)
    : false;
  const closeFailed = await closeDb().then(() => false, () => true);
  if (initializationFailed || closeFailed) throw new Error("Database did not close");
}

function startRuntimePublishing() {
  startGistAutoUpdateWorker();
  runtime.publishing = true;
}

const shutdownOwner = createShutdownOwner({
  stopIntake: stopRuntimeIntake,
  stopPublishing: async () => {
    if (runtime.publishing) await stopGistAutoUpdateWorker();
  },
  stopCollaboration: async () => {
    if (runtime.hocuspocus) await shutdownCollab(runtime.hocuspocus);
  },
  closeDatabase: closeRuntimeDatabase,
  exit: (code) => process.exit(code),
  log: (message) => console.log(message),
  error: (message) => console.error(message),
});

process.on("SIGINT", () => { void shutdownOwner.request("SIGINT"); });
process.on("SIGTERM", () => { void shutdownOwner.request("SIGTERM"); });

// Standby mode (scripts/live/promote.ps1): with STANDBY_PORT set, the server comes up on
// 127.0.0.1:<STANDBY_PORT> against a throwaway in-memory database so the ops script can compile every
// route while the previous build keeps serving :PORT. `POST /_standby/takeover` on the standby port
// then closes the throwaway database, opens the real PGLITE_DATA_DIR and listens on :PORT — the whole
// handover is a database open plus a listen, with every route already compiled in memory.
const standbyPort = Number(process.env.STANDBY_PORT ?? 0);
const STANDBY_TAKEOVER_PATH = "/_standby/takeover";
const realDataDir = process.env.PGLITE_DATA_DIR;
const configuredMcpInternalOrigin = Boolean(process.env.MARKDOC_INTERNAL_URL?.trim());

function callbackHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function configureMcpInternalOrigin(onPort: number, host: string) {
  if (!configuredMcpInternalOrigin) {
    process.env.MARKDOC_INTERNAL_URL = `http://${callbackHost(host)}:${onPort}`;
    nextEnv.updateInitialEnv({ MARKDOC_INTERNAL_URL: process.env.MARKDOC_INTERNAL_URL });
  }
  mcpRestOrigin();
  if (process.env.MARKDOC_URL?.trim()) httpOrigin(process.env.MARKDOC_URL, "MARKDOC_URL");
}

configureMcpInternalOrigin(standbyPort > 0 ? standbyPort : port, standbyPort > 0 ? "127.0.0.1" : bindHost);
if (standbyPort > 0) {
  process.env.PGLITE_DATA_DIR = "memory://";
  nextEnv.updateInitialEnv({ PGLITE_DATA_DIR: "memory://" });
}

function listenWithRetry(
  server: ReturnType<typeof createServer>,
  onPort: number,
  host: string,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<void> {
  // The old process may still be releasing the port when the takeover arrives; retry EADDRINUSE briefly.
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (signal?.aborted) {
        reject(new Error("Server startup was interrupted"));
        return;
      }
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE" && Date.now() < deadlineMs && !signal?.aborted) setTimeout(attempt, 200);
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

function setupNextWebSocketHandler(app: object, server: Server) {
  // Next 16's custom-server wrapper exposes this at runtime but omits it from its public interface.
  // Installing it now keeps WebSocket-only clients from depending on a later HTTP request after restart.
  const setup = Reflect.get(app, "setupWebSocketHandler");
  if (typeof setup !== "function") throw new Error("Next custom server does not expose setupWebSocketHandler");
  Reflect.apply(setup, app, [server]);
}

async function main() {
  let requestHandler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  const server = createServer((req, res) => {
    // First, before anything reads the request or writes the response: a client that leaves mid-body or
    // mid-response must not become an uncaughtException (server/request-guards.ts; the exit(1) policy
    // above stays). The standby side port re-emits its requests here, so it is covered too.
    attachRequestErrorGuards(req, res);
    setSecurityHeaders(req, res);
    if (requestHandler) return requestHandler(req, res);
    res.statusCode = 503;
    res.end("starting");
  });
  runtime.server = server;
  // Start accepting TCP connections before Next prepares. Reject upgrades promptly while starting:
  // a pending HMR handshake makes Chromium queue every later /collab socket behind it.
  // The socket arrives here with no 'error' listener (Node removed its own before emitting 'upgrade'),
  // and the client is often gone already: an editor page gives up a socket that waited 5 s while this
  // process was busy starting. The guard goes on before the write so that answering a client that left
  // cannot become an uncaughtException and exit(1) (#2311).
  const rejectStartupUpgrade = (req: IncomingMessage, socket: Duplex) => {
    attachUpgradeErrorGuard(req, socket);
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  };
  server.on("upgrade", rejectStartupUpgrade);
  const initialListen =
    standbyPort > 0 ? null : listenWithRetry(server, port, bindHost, Date.now() + 15_000, shutdownOwner.signal);
  void initialListen?.catch(() => {});

  // Initialize the database before serving application traffic. The early listener only returns 503
  // until this and Next preparation have both completed.
  runtime.databaseInitialization = getDb();
  await runtime.databaseInitialization;
  shutdownOwner.signal.throwIfAborted();
  const app = next({ dev, hostname, port, turbopack: dev, httpServer: server });
  runtime.app = app;
  runtime.appPreparation = app.prepare();
  await runtime.appPreparation;
  shutdownOwner.signal.throwIfAborted();
  const handle = app.getRequestHandler();

  const hocuspocus = createCollabServer();
  runtime.hocuspocus = hocuspocus;
  registerCollab(hocuspocus);
  if (standbyPort === 0) startRuntimePublishing();
  const collabShutdown = new AbortController();
  runtime.collabAttachment = collabShutdown;
  // Install Next's HMR listener before reporting readiness. Next otherwise waits for the first HTTP
  // request, leaving a browser that survived a restart unable to reconnect through WebSockets alone.
  const protectCollabUpgrade = protectUpgradePath(server, COLLAB_PATH);
  setupNextWebSocketHandler(app, server);
  protectCollabUpgrade();
  server.off("upgrade", rejectStartupUpgrade);
  attachCollab(server, hocuspocus, { path: COLLAB_PATH, signal: collabShutdown.signal });

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
      await hocuspocus.flushPendingStores();
      const until = Date.now() + 3000;
      while (hocuspocus.getDocumentsCount() > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      if (hocuspocus.getDocumentsCount() > 0) throw new Error("standby still holds documents from the throwaway database");
    }
    shutdownOwner.signal.throwIfAborted();
    const t0 = Date.now();
    await closeDb();
    shutdownOwner.signal.throwIfAborted();
    if (realDataDir === undefined) delete process.env.PGLITE_DATA_DIR;
    else process.env.PGLITE_DATA_DIR = realDataDir;
    nextEnv.updateInitialEnv({ PGLITE_DATA_DIR: realDataDir ?? "" });
    runtime.databaseInitialization = getDb();
    await runtime.databaseInitialization;
    shutdownOwner.signal.throwIfAborted();
    startRuntimePublishing();
    configureMcpInternalOrigin(port, bindHost);
    const dbMs = Date.now() - t0;
    await listenWithRetry(server, port, bindHost, Date.now() + 15_000, shutdownOwner.signal);
    console.log(`> Standby took over :${port} (database open ${dbMs} ms, listen ${Date.now() - t0 - dbMs} ms)`);
    standby?.close();
  };

  requestHandler = (req, res) => {
    // Clock starts here; when the response ends with a 5xx, a 4xx other than 401/404, or before any
    // header was written, one `[http] <status> <METHOD> <route shape> <ms>ms` line goes to stderr
    // (server/request-log.ts). The `[http] request failed` catch below keeps logging the thrown error;
    // that path then also produces a `[http] 500 …` line — expected, the two lines answer different
    // questions (what broke vs. which route and how long it took).
    attachRequestLog(req, res);
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
    // Immutable client assets for brotli-capable clients come from the build's `.br` files; everything
    // else (gzip, identity, Range, dev) is Next's as before.
    if (!dev && serveStaticBrotli(req, res, { staticRoot })) return;
    handle(req, res).catch((err: unknown) => {
      console.error("[http] request failed", err);
      if (!res.headersSent) res.statusCode = 500;
      res.end("internal server error");
    });
  };
  // In standby the same request handler also answers on the loopback side port; closing it after the
  // takeover leaves only :PORT.
  const standby = standbyPort > 0 ? createServer((req, res) => server.emit("request", req, res)) : null;
  runtime.standby = standby;
  if (standby) {
    standby.listen(standbyPort, "127.0.0.1", () => {
      console.log(`> Markdoc STANDBY on http://127.0.0.1:${standbyPort} (throwaway database; POST ${STANDBY_TAKEOVER_PATH} to take :${port})`);
    });
  } else {
    await initialListen;
    const shownHost = hostname ?? localUrls.canonicalHost;
    console.log(`> Markdoc ready on http://${shownHost}:${port} (${hostname ? "configured host" : "stable hostname"}; ${dev ? "development" : "production"})`);
    console.log(`> Collaboration WebSocket on ws://${shownHost}:${port}${COLLAB_PATH}`);
    if (!hostname) {
      for (const alias of localUrls.aliases) console.log(`> Hostname alias: ${alias.url}`);
      console.log(`> Loopback diagnostic: http://localhost:${port}`);
      for (const numeric of localUrls.numeric) {
        console.log(`> Numeric diagnostic (${numeric.interfaceName}${numeric.virtual ? ", virtual" : ""}): ${numeric.url}`);
      }
    }
  }

}

main().catch(() => {
  if (!shutdownOwner.signal.aborted) void shutdownOwner.request("startup");
});
