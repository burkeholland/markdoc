import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { eq } from "drizzle-orm";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

type TestActor = { id: string; login: string; name: string; image: null };
let actor: TestActor | null = null;
let bearer: string | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(bearer ? { authorization: `Bearer ${bearer}` } : {}) }));

const { getDb, schema } = await import("@/server/db");
const { createDocument, upsertCollaborator, removeCollaborator } = await import("@/server/documents");
const { createApiToken } = await import("@/server/tokens");
const { createCollabServer, shutdownCollab } = await import("@/server/collab/hocuspocus");
const { registerCollab } = await import("@/server/collab/registry");
const { POST: postComment } = await import("@/app/api/documents/[id]/comments/route");
const webhooks = await import("@/server/webhooks");
const { createWebhook, listWebhooks, deleteWebhook, enableWebhook, sendTestWebhook, deliverWebhook, sweepWebhooks, verifyWebhookSignature, signWebhookBody, setWebhookRetryDelays, settleWebhookDeliveries, stopWebhookDispatcher, startWebhookDispatcher, activeWebhooksFor, pruneDeliveries, ownOriginKeys, WebhookDocumentNotFoundError } = webhooks;
const { POST: postWebhook } = await import("@/app/api/webhooks/route");
const { POST: enableWebhookRoute } = await import("@/app/api/webhooks/[id]/enable/route");

interface Received {
  headers: IncomingMessage["headers"];
  body: string;
  json: Record<string, unknown>;
}

function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error("timeout waiting"));
      setTimeout(tick, 15);
    };
    tick();
  });
}

async function createUser(login: string, name: string): Promise<TestActor> {
  const db = await getDb();
  const [user] = await db.insert(schema.users).values({ name, login, email: `${login}@example.com` }).returning();
  return { id: user.id, login, name, image: null };
}

describe("outbound webhooks", () => {
  let receiver: Server;
  let receiverUrl: string;
  /** What the receiver answers next; reset to 200 after each request when `once` is set. */
  let respondWith = 200;
  const received: Received[] = [];
  let alice: TestActor;
  let bob: TestActor;
  let docId: string;
  let hocuspocus: ReturnType<typeof createCollabServer>;

  beforeAll(async () => {
    alice = await createUser("alice-hooks", "Alice");
    bob = await createUser("bob-hooks", "Bob");
    const doc = await createDocument({ ownerId: alice.id, content: "# Hooked\n\nA paragraph to comment on.\n" });
    docId = doc.id;
    await upsertCollaborator(docId, bob.login, "commenter", alice.id);
    hocuspocus = createCollabServer();
    hocuspocus.configuration.debounce = 50;
    hocuspocus.configuration.maxDebounce = 100;
    registerCollab(hocuspocus);

    receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body, json: body ? (JSON.parse(body) as Record<string, unknown>) : {} });
        res.statusCode = respondWith;
        res.end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
    setWebhookRetryDelays([20, 20, 20]);
    startWebhookDispatcher();
  });

  afterAll(async () => {
    await stopWebhookDispatcher();
    setWebhookRetryDelays(null);
    await shutdownCollab(hocuspocus);
    receiver.closeAllConnections(); await new Promise<void>((r) => receiver.close(() => r()));
  });

  it("signs bodies and verifies them in constant time", () => {
    const sig = signWebhookBody("whsec_abc", '{"a":1}');
    expect(sig.startsWith("sha256=")).toBe(true);
    expect(verifyWebhookSignature("whsec_abc", '{"a":1}', sig)).toBe(true);
    expect(verifyWebhookSignature("whsec_abc", '{"a":2}', sig)).toBe(false);
    expect(verifyWebhookSignature("other", '{"a":1}', sig)).toBe(false);
    expect(verifyWebhookSignature("whsec_abc", '{"a":1}', null)).toBe(false);
  });

  it("validates input and returns the secret once", async () => {
    await expect(createWebhook(alice, { url: "not a url", events: ["mention"] })).rejects.toThrow(/valid URL/);
    await expect(createWebhook(alice, { url: "ftp://x/y", events: ["mention"] })).rejects.toThrow(/http/);
    await expect(createWebhook(alice, { url: receiverUrl, events: ["nope"] })).rejects.toThrow(/at least one event/);
    const created = await createWebhook(alice, { url: receiverUrl, events: ["mention", "mention", "bogus"], documentIds: [] });
    expect(created.secret.startsWith("whsec_")).toBe(true);
    expect(created.events).toEqual(["mention"]);
    expect(created.documentIds).toBeNull();
    const list = await listWebhooks(alice.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: created.id, url: receiverUrl, active: true, failures: 0, lastDelivery: null });
    expect("secret" in list[0]).toBe(false);
    expect(await activeWebhooksFor(alice.id)).toEqual([{ id: created.id, url: receiverUrl, events: ["mention"], documentIds: null }]);
    expect(await listWebhooks(bob.id)).toEqual([]);
    expect(await deleteWebhook(bob.id, created.id)).toBe(false);
    expect(await deleteWebhook(alice.id, created.id)).toBe(true);
    expect(await listWebhooks(alice.id)).toEqual([]);
  });

  it("refuses a URL at the server's own origin (Host header or MARKDOC_URL) but allows another localhost port", async () => {
    // Pinned self: the listening port and one LAN address, so the keys are machine-independent.
    const self = { port: 3000, addresses: ["192.168.100.71"] };
    // Host header, scheme unknown: both default ports are "own"; an explicit other port is not.
    expect(ownOriginKeys("localhost:3000", undefined, self)).toEqual(["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "0.0.0.0:3000", "[::]:3000", "192.168.100.71:3000"]);
    expect(ownOriginKeys("Docs.Example.com", undefined, self)).toContain("docs.example.com:80");
    expect(ownOriginKeys("Docs.Example.com", undefined, self)).toContain("docs.example.com:443");
    expect(ownOriginKeys("localhost:3000", "https://docs.example.com", self)).toContain("docs.example.com:443");
    expect(ownOriginKeys(null, undefined, self)).toEqual(["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "0.0.0.0:3000", "[::]:3000", "192.168.100.71:3000"]);
    expect(ownOriginKeys(null, undefined, { port: 0, addresses: [] })).toEqual([]);
    // Every spelling of the listener (issue #184), on the listening port and the Host header's port; other ports stay free.
    const keys = ownOriginKeys("localhost:3400", undefined, { port: 3400, addresses: ["192.168.100.71", "fd74:fea9::1252:bd53", "fe80::1%eth0"] });
    for (const k of ["localhost:3400", "127.0.0.1:3400", "[::1]:3400", "0.0.0.0:3400", "[::]:3400", "192.168.100.71:3400", "[fd74:fea9::1252:bd53]:3400", "[fe80::1]:3400"]) expect(keys).toContain(k);
    expect(keys.some((k) => !k.endsWith(":3400"))).toBe(false);
    // Defaults: PORT (3000 when unset), this machine's interfaces and its name.
    const defaults = ownOriginKeys("localhost:3000");
    expect(defaults).toContain("127.0.0.1:3000");
    expect(defaults).toContain("[::1]:3000");
    expect(defaults).toContain(`${hostname().toLowerCase()}:3000`);
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) expect(defaults).toContain(entry.family === "IPv6" ? `[${entry.address.replace(/%.*$/, "")}]:3000` : `${entry.address}:3000`);
    }

    const own = ownOriginKeys("localhost:3000", "https://docs.example.com", self);
    for (const url of [
      "http://localhost:3000/api/webhooks",
      "https://docs.example.com/hook",
      "https://docs.example.com:443/hook",
      "http://LOCALHOST:3000/",
      "http://127.0.0.1:3000/hook",
      "http://127.0.0.2:3000/hook",
      "http://127.1:3000/hook",
      "http://2130706433:3000/hook",
      "http://[::1]:3000/hook",
      "http://[::ffff:127.0.0.1]:3000/hook",
      "http://0.0.0.0:3000/hook",
      "http://0:3000/hook",
      "http://[::]:3000/hook",
      "http://192.168.100.71:3000/hook",
      "http://app.localhost:3000/hook",
      // Loopback on the public origin's port is the proxy in front of Markdoc.
      "https://127.0.0.1/hook",
    ]) {
      await expect(createWebhook(alice, { url, events: ["mention"] }, own), url).rejects.toThrow("A webhook cannot point at Markdoc itself");
    }
    // Same host, different port (a LAN bridge next to the server), the receiver, and http on the public host's other port are fine.
    const port = (receiver.address() as AddressInfo).port;
    const allowed = await createWebhook(alice, { url: `http://localhost:${port}/bridge`, events: ["mention"] }, own);
    expect(allowed.url).toBe(`http://localhost:${port}/bridge`);
    const other = await createWebhook(alice, { url: "http://docs.example.com/hook", events: ["mention"] }, own);
    expect(other.url).toBe("http://docs.example.com/hook");
    const lan = await createWebhook(alice, { url: `http://192.168.100.71:${port}/hook`, events: ["mention"] }, own);
    expect(lan.url).toBe(`http://192.168.100.71:${port}/hook`);
    await deleteWebhook(alice.id, allowed.id);
    await deleteWebhook(alice.id, other.id);
    await deleteWebhook(alice.id, lan.id);

    // Through the route: the Host header the browser sent is the origin to refuse, under every spelling of this machine.
    actor = alice;
    const make = (url: string) => postWebhook(new Request("http://localhost/api/webhooks", { method: "POST", headers: { "Content-Type": "application/json", Host: `localhost:${port}` }, body: JSON.stringify({ url, events: ["mention"] }) }));
    const lanIp = Object.values(networkInterfaces()).flat().find((e) => e?.family === "IPv4" && !e.internal)?.address;
    for (const url of [`http://localhost:${port}/hook`, `http://127.0.0.1:${port}/x`, `http://[::1]:${port}/x`, `http://0.0.0.0:${port}/x`, `http://${hostname()}:${port}/x`, ...(lanIp ? [`http://${lanIp}:${port}/x`] : [])]) {
      const refused = await make(url);
      expect(refused.status, url).toBe(400);
      expect(await refused.json()).toEqual({ error: "A webhook cannot point at Markdoc itself" });
    }
    const accepted = await make(`http://localhost:${port + 1}/hook`);
    expect(accepted.status).toBe(201);
    const { webhook } = (await accepted.json()) as { webhook: { id: string; url: string } };
    expect(webhook.url).toBe(`http://localhost:${port + 1}/hook`);
    expect(await deleteWebhook(alice.id, webhook.id)).toBe(true);
  });

  it("never delivers to a hook that targets this server: it is disabled at once, with a notification", async () => {
    // The receiver stands in for Markdoc: make its port the listening port, so a hook stored before the check (or under a spelling it missed) now resolves to "self".
    received.length = 0;
    const created = await createWebhook(alice, { url: receiverUrl, events: ["comment.added"], documentIds: [docId] });
    const db = await getDb();
    const [hook] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, created.id));
    const payload = { type: "test" as const, documentId: null, documentTitle: null, cursor: null, actor: null, at: new Date().toISOString() };
    const previousPort = process.env.PORT;
    process.env.PORT = String((receiver.address() as AddressInfo).port);
    try {
      expect(await sendTestWebhook(alice.id, created.id)).toMatchObject({ ok: false, status: 0 });
      const result = await deliverWebhook(hook, payload);
      expect(result).toMatchObject({ ok: false, status: 0, attempt: 1 });
      await settleWebhookDeliveries();
      await new Promise((r) => setTimeout(r, 100));
      expect(received).toHaveLength(0);
      const [listed] = await listWebhooks(alice.id);
      expect(listed.active).toBe(false);
      expect(listed.lastDelivery).toMatchObject({ status: 0 });
      const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.kind, "webhook.disabled"));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ userLogin: alice.login, documentId: docId, snippet: receiverUrl });
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    }
    await db.delete(schema.notifications).where(eq(schema.notifications.kind, "webhook.disabled"));
    await deleteWebhook(alice.id, created.id);
  });

  it("delivers a comment.added event within a second, signed with the secret", async () => {
    received.length = 0;
    const hook = await createWebhook(alice, { url: receiverUrl, events: ["comment.added", "mention"], documentIds: [docId] });
    // The dispatcher was idle since before the hook existed; give it one sweep so its baseline predates the comment.
    await sweepWebhooks();
    actor = bob;
    const res = await postComment(new Request(`http://localhost/api/documents/${docId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", quote: "A paragraph", body: "Looks good, @alice-hooks." }) }), { params: Promise.resolve({ id: docId }) });
    expect(res.status).toBe(200);
    const { id: threadId } = (await res.json()) as { id: string };

    await waitFor(() => received.some((r) => r.headers["x-markdoc-event"] === "comment.added"), 1000);
    const delivery = received.find((r) => r.headers["x-markdoc-event"] === "comment.added")!;
    expect(verifyWebhookSignature(hook.secret, delivery.body, delivery.headers["x-markdoc-signature"] as string)).toBe(true);
    expect(delivery.headers["x-markdoc-delivery"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(delivery.headers["content-type"]).toBe("application/json");
    expect(delivery.json).toMatchObject({ type: "comment.added", documentId: docId, documentTitle: "Hooked", threadId, author: "Bob", body: "Looks good, @alice-hooks." });
    expect(typeof delivery.json.cursor).toBe("string");
    expect((delivery.json.actor as { login: string }).login).toBe(bob.login);

    // Alice is mentioned too: the mention event reaches her hook; the same event is not delivered twice.
    await waitFor(() => received.some((r) => r.headers["x-markdoc-event"] === "mention"), 2000);
    await settleWebhookDeliveries();
    await new Promise((r) => setTimeout(r, 150));
    expect(received.filter((r) => r.headers["x-markdoc-event"] === "comment.added")).toHaveLength(1);

    const [listed] = await listWebhooks(alice.id);
    expect(listed.lastDelivery).toMatchObject({ status: 200, attempt: 1 });
    expect(listed.failures).toBe(0);
    await deleteWebhook(alice.id, hook.id);
  });

  it("does not deliver events the hook did not subscribe to or on other documents", async () => {
    received.length = 0;
    const other = await createDocument({ ownerId: bob.id, content: "# Bob's\n\nPrivate.\n" });
    const hook = await createWebhook(alice, { url: receiverUrl, events: ["comment.replied"] });
    await sweepWebhooks();
    actor = bob;
    await postComment(new Request(`http://localhost/api/documents/${other.id}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", from: 0, to: 5, body: "Mine." }) }), { params: Promise.resolve({ id: other.id }) });
    await postComment(new Request(`http://localhost/api/documents/${docId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", from: 0, to: 5, body: "Unsubscribed kind." }) }), { params: Promise.resolve({ id: docId }) });
    await sweepWebhooks();
    await settleWebhookDeliveries();
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toHaveLength(0);
    await deleteWebhook(alice.id, hook.id);
  });

  it("refuses documentIds the user cannot see with 404, like POST /api/tokens, and stores nothing", async () => {
    const bobsPrivate = await createDocument({ ownerId: bob.id, content: "# Other private\n\nSecret line one.\n" });
    const foreign = createWebhook(alice, { url: receiverUrl, events: ["comment.added"], documentIds: [bobsPrivate.id] });
    await expect(foreign).rejects.toBeInstanceOf(WebhookDocumentNotFoundError);
    await expect(foreign).rejects.toMatchObject({ status: 404, message: `Document not found: ${bobsPrivate.id}`, documentId: bobsPrivate.id });
    await expect(createWebhook(alice, { url: receiverUrl, events: ["comment.added"], documentIds: ["nope12345678"] })).rejects.toMatchObject({ status: 404, message: "Document not found: nope12345678" });
    // One bad id among good ones refuses the whole hook: nothing is stored.
    await expect(createWebhook(alice, { url: receiverUrl, events: ["comment.added"], documentIds: [docId, bobsPrivate.id] })).rejects.toMatchObject({ status: 404 });
    expect(await listWebhooks(alice.id)).toEqual([]);
    // The owner, and a collaborator, may name it.
    const own = await createWebhook(bob, { url: receiverUrl, events: ["comment.added"], documentIds: [bobsPrivate.id] });
    expect(own.documentIds).toEqual([bobsPrivate.id]);
    await deleteWebhook(bob.id, own.id);
    const shared = await createWebhook(bob, { url: receiverUrl, events: ["comment.added"], documentIds: [docId] });
    expect(shared.documentIds).toEqual([docId]);
    await deleteWebhook(bob.id, shared.id);

    // Through the route: `404 { error: "Document not found: <id>" }`, and a visible id is still 201.
    actor = alice;
    const post = (documentIds: string[]) => postWebhook(new Request("http://localhost/api/webhooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: receiverUrl, events: ["comment.added", "content.changed"], documentIds }) }));
    const refused = await post([bobsPrivate.id]);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: `Document not found: ${bobsPrivate.id}` });
    const bogus = await post(["nope12345678"]);
    expect(bogus.status).toBe(404);
    expect(await bogus.json()).toEqual({ error: "Document not found: nope12345678" });
    expect(await listWebhooks(alice.id)).toEqual([]);
    const accepted = await post([docId]);
    expect(accepted.status).toBe(201);
    const { webhook } = (await accepted.json()) as { webhook: { id: string; documentIds: string[] } };
    expect(webhook.documentIds).toEqual([docId]);
    expect(await deleteWebhook(alice.id, webhook.id)).toBe(true);
  });

  it("stops delivering a document's events once the share is revoked, even when the hook names that document", async () => {
    received.length = 0;
    const shared = await createDocument({ ownerId: bob.id, content: "# Shared for a while\n\nSecret line one.\n" });
    await upsertCollaborator(shared.id, alice.login, "commenter", bob.id);
    const hook = await createWebhook(alice, { url: receiverUrl, events: ["comment.added"], documentIds: [shared.id] });
    await sweepWebhooks();
    actor = bob;
    const comment = (body: string) => postComment(new Request(`http://localhost/api/documents/${shared.id}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", quote: "Secret line one", body }) }), { params: Promise.resolve({ id: shared.id }) });
    expect((await comment("While shared.")).status).toBe(200);
    await waitFor(() => received.some((r) => r.headers["x-markdoc-event"] === "comment.added"), 1000);
    expect(received.map((r) => r.json.body)).toEqual(["While shared."]);

    // Bob revokes Alice's access: the hook still lists the document, but nothing more reaches it.
    await removeCollaborator(shared.id, alice.login);
    received.length = 0;
    expect((await comment("After revoke: private remark.")).status).toBe(200);
    await sweepWebhooks();
    await settleWebhookDeliveries();
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toHaveLength(0);

    // Shared again: deliveries resume from now; the comment made while revoked is not back-filled.
    await upsertCollaborator(shared.id, alice.login, "commenter", bob.id);
    await sweepWebhooks();
    expect((await comment("Shared again.")).status).toBe(200);
    await waitFor(() => received.some((r) => r.headers["x-markdoc-event"] === "comment.added"), 1000);
    await settleWebhookDeliveries();
    await new Promise((r) => setTimeout(r, 150));
    expect(received.map((r) => r.json.body)).toEqual(["Shared again."]);
    await deleteWebhook(alice.id, hook.id);
  });

  it("records a retry when the receiver fails, and disables the hook after 20 consecutive failures with a notification", async () => {
    received.length = 0;
    respondWith = 500;
    const created = await createWebhook(alice, { url: receiverUrl, events: ["comment.added"], documentIds: [docId] });
    const db = await getDb();
    const [hook] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, created.id));
    const payload = { type: "test" as const, documentId: null, documentTitle: null, cursor: null, actor: null, at: new Date().toISOString() };

    const first = await deliverWebhook(hook, payload);
    expect(first).toMatchObject({ ok: false, status: 500, attempt: 1 });
    // 3 retries at the test's 20 ms back-off: attempts 2, 3 and 4 are recorded under the same delivery id.
    await waitFor(() => received.length >= 4, 3000);
    await settleWebhookDeliveries();
    const ids = new Set(received.map((r) => r.headers["x-markdoc-delivery"]));
    expect(ids.size).toBe(1);
    expect(received.map((r) => r.headers["x-markdoc-attempt"])).toEqual(["1", "2", "3", "4"]);
    const rows = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.webhookId, hook.id));
    expect(rows.map((r) => r.attempt).sort()).toEqual([1, 2, 3, 4]);
    expect(rows.every((r) => r.status === 500)).toBe(true);
    let [listed] = await listWebhooks(alice.id);
    expect(listed.failures).toBe(4);
    expect(listed.active).toBe(true);
    expect(listed.lastDelivery).toMatchObject({ status: 500 });

    // Four more failing events (4 attempts each) reach 20.
    for (let i = 0; i < 4; i++) {
      const [current] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, hook.id));
      await deliverWebhook(current, payload);
      await waitFor(() => received.length >= 4 * (i + 2), 3000);
      await settleWebhookDeliveries();
    }
    [listed] = await listWebhooks(alice.id);
    expect(listed.failures).toBe(20);
    expect(listed.active).toBe(false);
    const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.kind, "webhook.disabled"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ userLogin: alice.login, documentId: docId, snippet: receiverUrl, readAt: null });
    expect(await activeWebhooksFor(alice.id)).toEqual([]);

    // A disabled hook gets nothing more.
    received.length = 0;
    respondWith = 200;
    actor = bob;
    await postComment(new Request(`http://localhost/api/documents/${docId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", from: 0, to: 5, body: "After disable." }) }), { params: Promise.resolve({ id: docId }) });
    await sweepWebhooks();
    await settleWebhookDeliveries();
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toHaveLength(0);
    await deleteWebhook(alice.id, hook.id);
  });

  it("re-enables only an owned hook in place, is idempotent, and makes it visible to the dispatcher", async () => {
    received.length = 0;
    respondWith = 200;
    const created = await createWebhook(alice, { url: receiverUrl, events: ["comment.added"], documentIds: [docId] });
    const db = await getDb();
    await db.update(schema.webhooks).set({ active: false, failures: 20 }).where(eq(schema.webhooks.id, created.id));
    await db.insert(schema.webhookDeliveries).values({ id: "enable-history", webhookId: created.id, event: "comment.added", status: 500, durationMs: 12, attempt: 4 });

    // Populate the dispatcher cache while this hook is inactive.
    actor = bob;
    await postComment(new Request(`http://localhost/api/documents/${docId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", from: 0, to: 5, body: "While disabled." }) }), { params: Promise.resolve({ id: docId }) });
    await sweepWebhooks();
    await settleWebhookDeliveries();
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);

    const callEnable = (id: string) => enableWebhookRoute(new Request(`http://localhost/api/webhooks/${id}/enable`, { method: "POST" }), { params: Promise.resolve({ id }) });
    expect(await enableWebhook(bob.id, created.id)).toBeNull();
    actor = bob;
    const foreign = await callEnable(created.id);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "Webhook not found" });
    actor = alice;
    const missing = await callEnable("missing-hook");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Webhook not found" });

    const token = await createApiToken(alice.id, "Webhook route test");
    actor = null;
    bearer = token.token;
    try {
      const agent = await callEnable(created.id);
      expect(agent.status).toBe(403);
      expect(await agent.json()).toEqual({ error: "Webhooks can only be managed from a signed-in browser session" });
    } finally {
      bearer = null;
      actor = alice;
    }

    const [before] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, created.id));
    const historyBefore = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.webhookId, created.id));
    const enabled = await callEnable(created.id);
    expect(enabled.status).toBe(200);
    const body = (await enabled.json()) as { webhook: Record<string, unknown> };
    expect(body.webhook).toMatchObject({ id: created.id, url: receiverUrl, events: ["comment.added"], documentIds: [docId], active: true, failures: 0, lastDelivery: { status: 500, attempt: 4, event: "comment.added" } });
    expect(body.webhook).not.toHaveProperty("secret");

    const [after] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, created.id));
    expect(after).toMatchObject({ active: true, failures: 0, secret: before.secret, url: before.url, events: before.events, documentIds: before.documentIds, createdAt: before.createdAt });
    expect(await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.webhookId, created.id))).toEqual(historyBefore);
    expect(await activeWebhooksFor(alice.id)).toContainEqual({ id: created.id, url: receiverUrl, events: ["comment.added"], documentIds: [docId] });

    const again = await callEnable(created.id);
    expect(again.status).toBe(200);
    expect((await again.json()) as { webhook: Record<string, unknown> }).toMatchObject({ webhook: { id: created.id, active: true, failures: 0 } });

    received.length = 0;
    actor = bob;
    await postComment(new Request(`http://localhost/api/documents/${docId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", from: 0, to: 5, body: "After enable." }) }), { params: Promise.resolve({ id: docId }) });
    await waitFor(() => received.some((entry) => entry.json.body === "After enable."), 1000);
    await settleWebhookDeliveries();
    expect(received.some((entry) => entry.json.body === "While disabled.")).toBe(false);
    await deleteWebhook(alice.id, created.id);
  });

  it("keeps a self-targeting stored webhook disabled and unchanged", async () => {
    const created = await createWebhook(alice, { url: receiverUrl, events: ["mention"] });
    const db = await getDb();
    await db.update(schema.webhooks).set({ active: false, failures: 20 }).where(eq(schema.webhooks.id, created.id));
    const [before] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, created.id));

    actor = alice;
    const receiverPort = (receiver.address() as AddressInfo).port;
    const previousPort = process.env.PORT;
    process.env.PORT = String(receiverPort);
    try {
      await expect(enableWebhook(alice.id, created.id)).rejects.toThrow("A webhook cannot point at Markdoc itself");
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    }

    const host = `localhost:${receiverPort}`;
    const refused = await enableWebhookRoute(new Request(`http://${host}/api/webhooks/${created.id}/enable`, { method: "POST", headers: { Host: host } }), { params: Promise.resolve({ id: created.id }) });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "A webhook cannot point at Markdoc itself" });
    const [after] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, created.id));
    expect(after).toEqual(before);
    expect(await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.webhookId, created.id))).toEqual([]);
    await deleteWebhook(alice.id, created.id);
  });

  it("sends a test event once, without retries, and resets the failure count on success", async () => {
    received.length = 0;
    respondWith = 200;
    const created = await createWebhook(alice, { url: receiverUrl, events: ["mention"] });
    const db = await getDb();
    await db.update(schema.webhooks).set({ failures: 3 }).where(eq(schema.webhooks.id, created.id));
    expect(await sendTestWebhook(bob.id, created.id)).toBeNull();
    const result = await sendTestWebhook(alice.id, created.id);
    expect(result).toMatchObject({ ok: true, status: 200, attempt: 1 });
    expect(received).toHaveLength(1);
    expect(received[0].headers["x-markdoc-event"]).toBe("test");
    expect(verifyWebhookSignature(created.secret, received[0].body, received[0].headers["x-markdoc-signature"] as string)).toBe(true);
    const [listed] = await listWebhooks(alice.id);
    expect(listed.lastDelivery).toMatchObject({ status: 200, event: "test" });

    // The receiver is gone: a failed test is recorded as status 0 and is not retried.
    receiver.closeAllConnections(); await new Promise<void>((r) => receiver.close(() => r()));
    const failed = await sendTestWebhook(alice.id, created.id);
    expect(failed).toMatchObject({ ok: false, status: 0 });
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(1);

    // Deliveries older than 7 days are pruned.
    await db.update(schema.webhookDeliveries).set({ createdAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(schema.webhookDeliveries.id, failed!.deliveryId));
    expect(await pruneDeliveries()).toBe(1);
    const rest = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.webhookId, created.id));
    expect(rest).toHaveLength(1);
  });
});
