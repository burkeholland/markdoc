import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import * as Y from "yjs";
import { eq } from "drizzle-orm";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { MarkdocProvider } from "@/editor/collab/provider";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("./db");
const { createCollabServer, hydrateDoc, shutdownCollab } = await import("./collab/hocuspocus");
const { attachCollab, protectUpgradePath } = await import("./collab/ws");
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

  it("owns upgrade routing so collaboration is handled once and HMR reaches Next", async () => {
    const nextServer = new WebSocketServer({ noServer: true });
    const routed = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    let collabConnections = 0;
    const protectCollab = protectUpgradePath(routed, "/collab");
    let nextUpgrades = 0;
    routed.on("upgrade", (req, socket, head) => {
      nextUpgrades++;
      nextServer.handleUpgrade(req, socket, head, (ws) => nextServer.emit("connection", ws, req));
    });
    protectCollab();
    const collabServer = attachCollab(routed, hocuspocus, { path: "/collab" });
    collabServer.on("connection", () => collabConnections++);
    await new Promise<void>((resolve) => routed.listen(0, "127.0.0.1", resolve));
    const { port } = routed.address() as AddressInfo;
    const collabClient = new WebSocket(`ws://127.0.0.1:${port}/collab`);
    const hmrClient = new WebSocket(`ws://127.0.0.1:${port}/_next/hmr`);

    try {
      await Promise.all(
        [collabClient, hmrClient].map(
          (client) =>
            new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error("WebSocket upgrade timed out")), 2_000);
              client.once("open", () => {
                clearTimeout(timeout);
                resolve();
              });
              client.once("error", (err) => {
                clearTimeout(timeout);
                reject(err);
              });
            }),
        ),
      );
      expect(routed.listenerCount("upgrade")).toBe(2);
      expect(collabConnections).toBe(1);
      expect(nextUpgrades).toBe(1);
    } finally {
      collabClient.close();
      hmrClient.close();
      nextServer.close();
      await new Promise<void>((resolve) => routed.close(() => resolve()));
    }
  });

  it("bootstraps a non-collaboration upgrade before another listener is attached", async () => {
    const nextServer = new WebSocketServer({ noServer: true });
    const routed = createServer();
    attachCollab(routed, hocuspocus, {
      path: "/collab",
      fallback: (req, socket, head) => nextServer.handleUpgrade(req, socket, head, (ws) => nextServer.emit("connection", ws, req)),
    });
    await new Promise<void>((resolve) => routed.listen(0, "127.0.0.1", resolve));
    const { port } = routed.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}/_next/hmr`);

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("bootstrap HMR upgrade timed out")), 2_000);
        client.once("open", () => {
          clearTimeout(timeout);
          resolve();
        });
        client.once("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    } finally {
      client.close();
      nextServer.close();
      await new Promise<void>((resolve) => routed.close(() => resolve()));
    }
  });

  it("closes an unhandled upgrade when no fallback or other listener exists", async () => {
    const routed = createServer();
    attachCollab(routed, hocuspocus, { path: "/collab" });
    await new Promise<void>((resolve) => routed.listen(0, "127.0.0.1", resolve));
    const { port } = routed.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}/other`);

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("unhandled upgrade was not closed")), 2_000);
        client.once("error", () => {
          clearTimeout(timeout);
          resolve();
        });
        client.once("open", () => {
          clearTimeout(timeout);
          reject(new Error("unhandled upgrade unexpectedly opened"));
        });
      });
    } finally {
      client.close();
      await new Promise<void>((resolve) => routed.close(() => resolve()));
    }
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

  /**
   * A browser that holds the document in IndexedDB, the way `CollabSession` wires it (issue #189): the
   * mirror is applied under its own origin before the socket opens, and the provider must let the sync
   * handshake — not a raw update — carry whatever the server is missing.
   */
  function warmClient(token: string, name: string) {
    const ydoc = new Y.Doc();
    const sent: { type: string; bytes: number }[] = [];
    // Counts the frames that actually leave: the provider's own `send` also runs for queued messages on flush.
    class CountingSocket extends WebSocket {
      send(data: Parameters<WebSocket["send"]>[0], ...rest: unknown[]) {
        sent.push(describeMessage(data as Uint8Array));
        return (super.send as (...a: unknown[]) => void)(data, ...rest);
      }
    }
    const socket = new HocuspocusProviderWebsocket({ url, autoConnect: false, WebSocketPolyfill: CountingSocket as unknown as typeof globalThis.WebSocket });
    const received: { type: string; bytes: number }[] = [];
    const provider = new MarkdocProvider({
      websocketProvider: socket,
      name,
      document: ydoc,
      token,
      onMessage: ({ message }) => received.push(describeMessage((message as unknown as { data: ArrayBuffer | Uint8Array }).data)),
    });
    provider.attach();
    const localOrigin = { name: "indexeddb mirror" };
    provider.setLocalOrigin(localOrigin);
    const total = (list: { bytes: number }[]) => list.reduce((n, m) => n + m.bytes, 0);
    return { ydoc, provider, socket, received, sent, localOrigin, total };
  }

  it("a client whose local copy is current exchanges state vectors, not the document (issue #189)", async () => {
    const body = `# Warm open\n\n${"the quick brown fox jumps over the lazy dog. ".repeat(2500)}`;
    const doc = await createDocument({ ownerId: userId, content: body });
    const token = await signCollabToken({ userId, docId: doc.id, role: "owner", name: "Alice", login: "alice", avatar: null });

    // Cold open: the whole state once, downstream only.
    const cold = warmClient(token, doc.id);
    void cold.socket.connect();
    await waitFor(() => cold.provider.isSynced && !cold.provider.hasUnsyncedChanges);
    const state = Y.encodeStateAsUpdate(cold.ydoc);
    expect(state.byteLength).toBeGreaterThan(body.length);
    expect(cold.total(cold.received)).toBeGreaterThan(state.byteLength);
    expect(cold.total(cold.received)).toBeLessThan(state.byteLength * 1.1);
    expect(cold.total(cold.sent)).toBeLessThan(state.byteLength * 0.05);
    cold.provider.destroy();
    cold.socket.destroy();

    // Warm open, nothing changed: the mirror restores the state before the socket opens.
    const warm = warmClient(token, doc.id);
    Y.transact(warm.ydoc, () => Y.applyUpdate(warm.ydoc, state), warm.localOrigin);
    expect(warm.ydoc.getText("content").toString()).toBe(body);
    // Counted as pending (the copy may hold offline edits) but not pushed: nothing has been sent yet.
    expect(warm.provider.hasUnsyncedChanges).toBe(true);
    expect(warm.sent).toHaveLength(0);
    void warm.socket.connect();
    await waitFor(() => warm.provider.isSynced && !warm.provider.hasUnsyncedChanges);
    await sleep(200);
    const recvKinds = countBy(warm.received);
    const sentKinds = countBy(warm.sent);
    console.log(`[collab] warm open: recv ${warm.total(warm.received)} B ${JSON.stringify(recvKinds)} · sent ${warm.total(warm.sent)} B ${JSON.stringify(sentKinds)} · state ${state.byteLength} B`);
    expect(warm.total(warm.received)).toBeLessThan(state.byteLength * 0.05);
    expect(warm.total(warm.sent)).toBeLessThan(state.byteLength * 0.05);
    expect(sentKinds.update).toBeUndefined();
    expect(recvKinds["sync-step2"]).toBe(1);
    expect(warm.ydoc.getText("content").toString()).toBe(body);

    /** The IndexedDB copy of a browser that typed `text` at `index` while offline (under that session's own client id). */
    const mirrorWith = (index: number, text: string) => {
      const offline = new Y.Doc();
      Y.applyUpdate(offline, state);
      offline.getText("content").insert(index, text);
      return Y.encodeStateAsUpdate(offline);
    };

    // Warm open with an edit made offline: only the edit travels, and it reaches the server.
    const edited = warmClient(token, doc.id);
    Y.transact(edited.ydoc, () => Y.applyUpdate(edited.ydoc, mirrorWith(0, "Typed offline. ")), edited.localOrigin);
    expect(edited.provider.hasUnsyncedChanges).toBe(true);
    void edited.socket.connect();
    await waitFor(() => edited.provider.isSynced && !edited.provider.hasUnsyncedChanges);
    await waitFor(() => warm.ydoc.getText("content").toString().startsWith("Typed offline. "));
    await sleep(200);
    expect(edited.total(edited.sent)).toBeLessThan(state.byteLength * 0.05);
    expect(edited.total(edited.received)).toBeLessThan(state.byteLength * 0.05);
    expect(countBy(edited.sent).update).toBeUndefined();
    expect(countBy(edited.sent)["sync-step2"]).toBe(1);

    // Mirror slower than the socket (applied after the handshake): the state vectors are exchanged again.
    const late = warmClient(token, doc.id);
    void late.socket.connect();
    await waitFor(() => late.provider.isSynced && !late.provider.hasUnsyncedChanges);
    late.sent.length = 0;
    late.received.length = 0;
    Y.transact(late.ydoc, () => Y.applyUpdate(late.ydoc, mirrorWith(body.length, " Late mirror.")), late.localOrigin);
    await waitFor(() => warm.ydoc.getText("content").toString().includes(" Late mirror."));
    await waitFor(() => !late.provider.hasUnsyncedChanges);
    await sleep(200);
    expect(late.total(late.sent)).toBeLessThan(state.byteLength * 0.05);
    expect(late.total(late.received)).toBeLessThan(state.byteLength * 0.05);
    expect(countBy(late.sent).update).toBeUndefined();
    expect(countBy(late.sent)["sync-step1"]).toBe(1);
    expect(countBy(late.sent)["sync-step2"]).toBe(1);

    for (const client of [warm, edited, late]) {
      client.provider.destroy();
      client.socket.destroy();
    }
  });
});
