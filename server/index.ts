import { createServer } from "node:http";
import next from "next";
import { createCollabServer, shutdownCollab } from "@/server/collab/hocuspocus";
import { registerCollab } from "@/server/collab/registry";
import { attachCollab, COLLAB_PATH } from "@/server/collab/ws";
import { getDb } from "@/server/db";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);

async function main() {
  // Fail fast on database problems before accepting traffic.
  await getDb();

  const app = next({ dev, hostname, port, turbopack: dev });
  const handle = app.getRequestHandler();
  const upgrade = app.getUpgradeHandler();
  await app.prepare();

  const hocuspocus = createCollabServer();
  registerCollab(hocuspocus);

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error("[http] request failed", err);
      if (!res.headersSent) res.statusCode = 500;
      res.end("internal server error");
    });
  });

  attachCollab(server, hocuspocus, { path: COLLAB_PATH, fallback: upgrade });

  server.listen(port, hostname, () => {
    const shownHost = hostname === "0.0.0.0" ? "localhost" : hostname;
    console.log(`> Markdoc ready on http://${shownHost}:${port} (${dev ? "development" : "production"})`);
    console.log(`> Collaboration WebSocket on ws://${shownHost}:${port}${COLLAB_PATH}`);
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

