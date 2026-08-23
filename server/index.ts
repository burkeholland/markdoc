import { createServer } from "node:http";
import nextEnv from "@next/env";
import next from "next";

// Load .env files the same way Next.js does, so the collaboration server sees them too.
nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
import { createCollabServer, shutdownCollab } from "@/server/collab/hocuspocus";
import { registerCollab } from "@/server/collab/registry";
import { attachCollab, COLLAB_PATH } from "@/server/collab/ws";
import { getDb } from "@/server/db";
import { purgeTrashOlderThan, TRASH_RETENTION_DAYS } from "@/server/documents";
import { lanAddresses } from "../scripts/lib/dev-origins.mjs";

/** How often documents that have been in the trash for more than TRASH_RETENTION_DAYS are removed for good. */
const TRASH_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const dev = process.env.NODE_ENV !== "production";
// Bind address. Only a concrete HOST is handed to Next as its hostname: for the default 0.0.0.0
// Next would stamp "http://0.0.0.0:<port>" into every absolute URL it builds (Auth.js redirects
// included), which no browser can follow. Without it Next falls back to localhost for its own
// URLs; Auth.js uses the request's Host header instead (src/app/api/auth/[...nextauth]/route.ts).
const bindHost = process.env.HOST ?? "0.0.0.0";
const hostname = bindHost === "0.0.0.0" || bindHost === "::" ? undefined : bindHost;
const port = Number(process.env.PORT ?? 3000);

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

  const shutdown = async () => {
    console.log("> Shutting down, flushing documents...");
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
  console.error(err);
  process.exit(1);
});




