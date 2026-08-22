import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import * as Y from "yjs";
import { eq } from "drizzle-orm";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("./db");
const { createCollabServer, hydrateDoc, shutdownCollab } = await import("./collab/hocuspocus");
const { attachCollab } = await import("./collab/ws");
const { signCollabToken } = await import("./collab/token");
const { createDocument } = await import("./documents");

function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error("timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("collaboration server", () => {
  let server: Server;
  let url: string;
  let hocuspocus: ReturnType<typeof createCollabServer>;
  let userId: string;
  let docId: string;

  beforeAll(async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Alice", login: "alice", email: "alice@example.com" }).returning();
    userId = user.id;
    const doc = await createDocument({ ownerId: userId, content: "# Hello\n\nWorld." });
    docId = doc.id;

    hocuspocus = createCollabServer();
    hocuspocus.configuration.debounce = 50;
    hocuspocus.configuration.maxDebounce = 100;
    server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    attachCollab(server, hocuspocus, { path: "/collab" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/collab`;
  });

  afterAll(async () => {
    await shutdownCollab(hocuspocus);
    await new Promise<void>((r) => server.close(() => r()));
  });

  function connect(token: string, name = docId) {
    const ydoc = new Y.Doc();
    const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket });
    const provider = new HocuspocusProvider({ websocketProvider: socket, name, document: ydoc, token });
    provider.attach();
    return { ydoc, provider, socket };
  }

  it("loads the document from the database and syncs two clients", async () => {
    const token = await signCollabToken({ userId, docId, role: "owner", name: "Alice", login: "alice", avatar: null });
    const a = connect(token);
    const b = connect(token);
    await waitFor(() => a.provider.isSynced && b.provider.isSynced);
    expect(a.ydoc.getText("content").toString()).toBe("# Hello\n\nWorld.");
    expect(a.ydoc.getMap("meta").get("title")).toBe("Hello");

    a.ydoc.getText("content").insert(a.ydoc.getText("content").length, " More.");
    await waitFor(() => b.ydoc.getText("content").toString().endsWith(" More."));

    // Persisted (debounced) to the database.
    const db = await getDb();
    await waitFor(() => false, 300).catch(() => {});
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, docId));
    expect(row.content).toBe("# Hello\n\nWorld. More.");
    expect(row.ystate?.byteLength).toBeGreaterThan(0);

    // Reloading state from the stored update yields the same text.
    const fresh = new Y.Doc();
    hydrateDoc(fresh, row.ystate!, row.content, row.title);
    expect(fresh.getText("content").toString()).toBe("# Hello\n\nWorld. More.");

    a.provider.destroy();
    b.provider.destroy();
    a.socket.destroy();
    b.socket.destroy();
  });

  it("rejects invalid tokens and tokens for other documents", async () => {
    const bad = connect("not-a-token");
    let failed = false;
    bad.provider.on("authenticationFailed", () => (failed = true));
    await waitFor(() => failed);
    bad.provider.destroy();
    bad.socket.destroy();

    const other = await signCollabToken({ userId, docId: "someone-else", role: "owner", name: "A", login: null, avatar: null });
    const mismatch = connect(other);
    let failed2 = false;
    mismatch.provider.on("authenticationFailed", () => (failed2 = true));
    await waitFor(() => failed2);
    mismatch.provider.destroy();
    mismatch.socket.destroy();
  });

  it("makes viewers read-only", async () => {
    const token = await signCollabToken({ userId, docId, role: "viewer", name: "V", login: null, avatar: null });
    const v = connect(token);
    await waitFor(() => v.provider.isSynced);
    expect(v.provider.isAuthenticated).toBe(true);
    expect(v.provider.authorizedScope).toBe("readonly");
    v.provider.destroy();
    v.socket.destroy();
  });
});

