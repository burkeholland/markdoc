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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Classify one Hocuspocus wire message: `sync-step1|2`, `update`, `awareness`, `auth`, `sync-status`, … */
function describeMessage(data: ArrayBuffer | Uint8Array): { type: string; bytes: number } {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let i = 0;
  let nameLength = 0;
  let shift = 0;
  for (;;) {
    const b = bytes[i++];
    nameLength |= (b & 0x7f) << shift;
    if (b < 0x80) break;
    shift += 7;
  }
  i += nameLength;
  const kind = bytes[i];
  const type = kind === 0 ? ["sync-step1", "sync-step2", "update"][bytes[i + 1]] ?? "sync-?" : ({ 1: "awareness", 2: "auth", 5: "stateless", 8: "sync-status" } as Record<number, string>)[kind] ?? `type-${kind}`;
  return { type, bytes: bytes.byteLength };
}

const countBy = (messages: { type: string }[]) => messages.reduce<Record<string, number>>((acc, m) => ((acc[m.type] = (acc[m.type] ?? 0) + 1), acc), {});

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
    const received: { type: string; bytes: number }[] = [];
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name,
      document: ydoc,
      token,
      onMessage: ({ message }) => received.push(describeMessage((message as unknown as { data: ArrayBuffer | Uint8Array }).data)),
    });
    provider.attach();
    return { ydoc, provider, socket, received };
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

  it("sends the initial state once and never echoes a client's own updates or awareness (task #480)", async () => {
    // A body large enough that a second copy of the state is unmistakable in the byte counts.
    const body = `# Traffic\n\n${"lorem ipsum dolor sit amet. ".repeat(2000)}`;
    const doc = await createDocument({ ownerId: userId, content: body });
    const token = await signCollabToken({ userId, docId: doc.id, role: "owner", name: "Alice", login: "alice", avatar: null });

    // First connection loads the document from the database: the hydration update must not be broadcast to it.
    const a = connect(token, doc.id);
    await waitFor(() => a.provider.isSynced);
    a.provider.awareness!.setLocalStateField("user", { name: "A" });
    await sleep(200);
    const b = connect(token, doc.id);
    await waitFor(() => b.provider.isSynced);
    b.provider.awareness!.setLocalStateField("user", { name: "B" });
    await sleep(200);

    const stateBytes = Y.encodeStateAsUpdate(a.ydoc).byteLength;
    expect(stateBytes).toBeGreaterThan(body.length);
    for (const client of [a, b]) {
      const total = client.received.reduce((n, m) => n + m.bytes, 0);
      // One sync step 2 (the whole state) plus small protocol messages; the second copy was ~2×.
      expect(total).toBeLessThan(stateBytes * 1.1);
      expect(countBy(client.received)["sync-step2"]).toBe(1);
      expect(countBy(client.received).update).toBeUndefined();
    }

    // A types 50 characters, moving its caret each time (what y-codemirror does mid-document).
    a.received.length = 0;
    b.received.length = 0;
    const text = a.ydoc.getText("content");
    for (let i = 0; i < 50; i++) {
      text.insert(text.length, "x");
      a.provider.awareness!.setLocalStateField("cursor", { pos: text.length });
      await sleep(20);
    }
    await waitFor(() => b.ydoc.getText("content").toString() === text.toString());
    await sleep(300);

    const toA = countBy(a.received);
    const toB = countBy(b.received);
    // The typist only gets the ack per update (the provider needs it for "saved"): no update echo, no own caret.
    expect(toA["sync-status"]).toBe(50);
    expect(toA.update).toBeUndefined();
    expect(toA.awareness).toBeUndefined();
    // The collaborator gets every update and a throttled stream of caret positions.
    expect(toB.update).toBe(50);
    expect(toB.awareness).toBeGreaterThanOrEqual(1);
    expect(toB.awareness).toBeLessThan(50);
    expect(b.provider.awareness!.getStates().get(a.ydoc.clientID)?.cursor).toEqual({ pos: text.length });

    // Nothing was lost: B's own edit reaches A exactly once too.
    b.ydoc.getText("content").insert(0, "B> ");
    await waitFor(() => a.ydoc.getText("content").toString().startsWith("B> "));
    await sleep(50);
    expect(countBy(a.received).update).toBe(1);
    expect(countBy(b.received).update).toBe(50);

    for (const client of [a, b]) {
      client.provider.destroy();
      client.socket.destroy();
    }
  });
});

