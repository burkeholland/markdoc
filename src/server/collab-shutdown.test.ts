import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import * as Y from "yjs";
import { eq } from "drizzle-orm";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

const { getDb, closeDb, schema } = await import("./db");
const { createCollabServer, shutdownCollab } = await import("./collab/hocuspocus");
const { attachCollab, COLLAB_SHUTDOWN_CLOSE } = await import("./collab/ws");
const { signCollabToken } = await import("./collab/token");
const { registerCollab } = await import("./collab/registry");
const { createDocument } = await import("./documents");
const { closeHttpIntake } = await import("../../server/request-guards");

async function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Issue #2355: with one document open, the stop waited for the collaboration socket until the deadline.
describe("shutdown with an open document connection", () => {
  it("stores the document, closes the socket with a reconnect code, and closes the database well under the deadline", async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Alice", login: "alice", email: "alice@example.com" }).returning();
    const doc = await createDocument({ ownerId: user.id, content: "Hello" });

    const hocuspocus = createCollabServer();
    registerCollab(hocuspocus);
    const server = createServer((_req, res) => res.end());
    const intake = new AbortController();
    const collab = attachCollab(server, hocuspocus, { path: "/collab", signal: intake.signal });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;

    const ydoc = new Y.Doc();
    const socket = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/collab`,
      autoConnect: false,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    const token = await signCollabToken({ userId: user.id, docId: doc.id, role: "owner", name: "Alice", login: "alice", avatar: null });
    const provider = new HocuspocusProvider({ websocketProvider: socket, name: doc.id, document: ydoc, token });
    const closeCodes: number[] = [];
    socket.on("close", ({ event }: { event: { code: number } }) => closeCodes.push(event.code));
    provider.attach();
    void socket.connect();
    await waitFor(() => provider.isSynced);
    ydoc.getText("content").insert(5, " typed right before the stop");
    await new Promise((r) => setTimeout(r, 50));

    // Same order as server/index.ts: intake and collaboration together, then the database.
    const started = Date.now();
    intake.abort();
    await Promise.all([
      closeHttpIntake(server, { log: () => {} }),
      (async () => {
        try {
          await shutdownCollab(hocuspocus);
        } finally {
          await collab.closeSockets();
        }
      })(),
    ]);
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    await closeDb();
    const elapsed = Date.now() - started;

    // Stop the client from reconnecting before asserting.
    provider.destroy();
    socket.destroy();

    expect(elapsed).toBeLessThan(3_000);
    expect(row.content).toBe("Hello typed right before the stop");
    expect(closeCodes[0]).toBe(COLLAB_SHUTDOWN_CLOSE.code);
    expect(collab.clients.size).toBe(0);
  });
});
