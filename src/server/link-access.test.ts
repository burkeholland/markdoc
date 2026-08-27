import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import * as Y from "yjs";
import { eq } from "drizzle-orm";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Route tests resolve the caller through next-auth and `next/headers` (same stand-ins as trash-copy.test.ts).
type Actor = { id: string; login: string | null; name: string; image: null };
let actor: Actor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { createCollabServer, shutdownCollab, TEXT_KEY } = await import("@/server/collab/hocuspocus");
const { attachCollab } = await import("@/server/collab/ws");
const { registerCollab } = await import("@/server/collab/registry");
const { createDocument } = await import("@/server/documents");
const { GET, PATCH } = await import("../app/api/documents/[id]/route");
const { POST: COLLAB_TOKEN } = await import("../app/api/documents/[id]/collab-token/route");

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

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const as = async <T>(who: Actor | null, fn: () => Promise<T>) => {
  const saved = actor;
  actor = who;
  try {
    return await fn();
  } finally {
    actor = saved;
  }
};
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://localhost:3700/api/documents/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), params(id));
const get = (id: string) => GET(new Request(`http://localhost:3700/api/documents/${id}`), params(id));

describe("PATCH /api/documents/:id { linkAccess } reaches live link visitors", () => {
  let server: Server;
  let url: string;
  let hocuspocus: ReturnType<typeof createCollabServer>;
  let owner: Actor;
  let guest: Actor;

  beforeAll(async () => {
    const db = await getDb();
    const [o] = await db.insert(schema.users).values({ name: "Oona", login: "oona", email: "oona-link@example.com" }).returning();
    const [g] = await db.insert(schema.users).values({ name: "Gus", login: "gus", email: "gus-link@example.com" }).returning();
    owner = { id: o.id, login: "oona", name: "Oona", image: null };
    guest = { id: g.id, login: "gus", name: "Gus", image: null };

    hocuspocus = createCollabServer();
    registerCollab(hocuspocus);
    hocuspocus.configuration.debounce = 50;
    hocuspocus.configuration.maxDebounce = 100;
    server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    attachCollab(server, hocuspocus, { path: "/collab" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
  });

  afterAll(async () => {
    await shutdownCollab(hocuspocus);
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** Open the document the way the editor does: `POST /collab-token` as `who` (null = anonymous), then connect. */
  async function open(who: Actor | null, docId: string) {
    const res = await as(who, () => COLLAB_TOKEN(new Request(`http://localhost:3700/api/documents/${docId}/collab-token`, { method: "POST" }), params(docId)));
    expect(res.status).toBe(200);
    const { token, role } = (await res.json()) as { token: string; role: string };
    const ydoc = new Y.Doc();
    const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket });
    const provider = new HocuspocusProvider({ websocketProvider: socket, name: docId, document: ydoc, token });
    provider.attach();
    await waitFor(() => provider.isSynced);
    return { ydoc, provider, socket, role, text: () => ydoc.getText(TEXT_KEY).toString() };
  }

  it("restricting the link keeps the response shape, updates GET at once, and disconnects link editor and anonymous reader", async () => {
    const db = await getDb();
    const doc = await createDocument({ ownerId: owner.id, content: "Start" });
    const opened = await as(owner, () => patch(doc.id, { linkAccess: "edit" }));
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as { document: { linkAccess: string } }).document.linkAccess).toBe("edit");

    const ownerClient = await open(owner, doc.id);
    const guestClient = await open(guest, doc.id);
    const anonClient = await open(null, doc.id);
    expect(guestClient.role).toBe("editor");
    expect(anonClient.role).toBe("viewer");

    guestClient.ydoc.getText(TEXT_KEY).insert(5, " guest");
    await waitFor(() => ownerClient.text() === "Start guest" && anonClient.text() === "Start guest");

    const t0 = Date.now();
    const closed = await as(owner, () => patch(doc.id, { linkAccess: "private" }));
    expect(closed.status).toBe(200);
    const body = (await closed.json()) as { document: { id: string; linkAccess: string } };
    expect(body.document.id).toBe(doc.id);
    expect(body.document.linkAccess).toBe("private");
    const shown = await as(owner, () => get(doc.id));
    expect(((await shown.json()) as { document: { linkAccess: string }; role: string }).document.linkAccess).toBe("private");
    expect((await as(guest, () => get(doc.id))).status).toBe(404);

    const isVisitor = (c: { context: { userId: string } }) => c.context.userId !== owner.id;
    await waitFor(() => !hocuspocus.documents.get(doc.id)?.getConnections().some(isVisitor), 1000);
    expect(Date.now() - t0).toBeLessThan(1000);
    const [stored] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(stored.content).toBe("Start guest");

    guestClient.ydoc.getText(TEXT_KEY).insert(guestClient.ydoc.getText(TEXT_KEY).length, " AFTER-REVOKE");
    await sleep(150);
    expect(ownerClient.text()).toBe("Start guest");
    expect(anonClient.text()).toBe("Start guest");
    const [afterRejected] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(afterRejected.content).toBe("Start guest");

    // The owner's own socket never noticed.
    ownerClient.ydoc.getText(TEXT_KEY).insert(ownerClient.ydoc.getText(TEXT_KEY).length, " owner");
    await waitFor(() => hocuspocus.documents.get(doc.id)?.getText(TEXT_KEY).toString() === "Start guest owner");

    for (const client of [ownerClient, guestClient, anonClient]) {
      client.provider.destroy();
      client.socket.destroy();
    }
  });

  it("a non-owner cannot change link access and a title-only PATCH does not touch link visitors", async () => {
    const doc = await createDocument({ ownerId: owner.id, content: "Title test" });
    await as(owner, () => patch(doc.id, { linkAccess: "edit" }));
    const guestClient = await open(guest, doc.id);

    expect((await as(guest, () => patch(doc.id, { linkAccess: "private" }))).status).toBe(403);
    const renamed = await as(guest, () => patch(doc.id, { title: "Renamed by guest" }));
    expect(renamed.status).toBe(200);
    await sleep(100);
    const guestConnection = hocuspocus.documents.get(doc.id)?.getConnections().find((c) => c.context.userId === guest.id);
    expect(guestConnection?.readOnly).toBe(false);

    guestClient.provider.destroy();
    guestClient.socket.destroy();
  });
});
