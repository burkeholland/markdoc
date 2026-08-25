import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

type TestActor = { id: string; login: string; name: string; image: null };
let actor: TestActor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { createDocument, upsertCollaborator } = await import("@/server/documents");
const { createCollabServer, shutdownCollab } = await import("@/server/collab/hocuspocus");
const { registerCollab } = await import("@/server/collab/registry");
const { POST: postComment } = await import("@/app/api/documents/[id]/comments/route");
const webhooks = await import("@/server/webhooks");
const { createWebhook, listWebhooks, deleteWebhook, sendTestWebhook, deliverWebhook, sweepWebhooks, verifyWebhookSignature, signWebhookBody, setWebhookRetryDelays, settleWebhookDeliveries, stopWebhookDispatcher, startWebhookDispatcher, activeWebhooksFor, pruneDeliveries, ownOriginKeys } = webhooks;
const { POST: postWebhook } = await import("@/app/api/webhooks/route");

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
    await expect(createWebhook(alice.id, { url: "not a url", events: ["mention"] })).rejects.toThrow(/valid URL/);
    await expect(createWebhook(alice.id, { url: "ftp://x/y", events: ["mention"] })).rejects.toThrow(/http/);
    await expect(createWebhook(alice.id, { url: receiverUrl, events: ["nope"] })).rejects.toThrow(/at least one event/);
    const created = await createWebhook(alice.id, { url: receiverUrl, events: ["mention", "mention", "bogus"], documentIds: [] });
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
    // Host header, scheme unknown: both default ports are "own"; an explicit other port is not.
    expect(ownOriginKeys("localhost:3000")).toEqual(["localhost:3000"]);
    expect(ownOriginKeys("Docs.Example.com", undefined)).toEqual(["docs.example.com:80", "docs.example.com:443"]);
    expect(ownOriginKeys("localhost:3000", "https://docs.example.com")).toEqual(["localhost:3000", "docs.example.com:443"]);
    expect(ownOriginKeys(null, undefined)).toEqual([]);

    const own = ownOriginKeys("localhost:3000", "https://docs.example.com");
    for (const url of ["http://localhost:3000/api/webhooks", "https://docs.example.com/hook", "https://docs.example.com:443/hook", "http://LOCALHOST:3000/"]) {
      await expect(createWebhook(alice.id, { url, events: ["mention"] }, own)).rejects.toThrow("A webhook cannot point at Markdoc itself");
    }
    // Same host, different port (a LAN bridge next to the server), the receiver, and http on the public host's other port are fine.
    const port = (receiver.address() as AddressInfo).port;
    const allowed = await createWebhook(alice.id, { url: `http://localhost:${port}/bridge`, events: ["mention"] }, own);
    expect(allowed.url).toBe(`http://localhost:${port}/bridge`);
    const other = await createWebhook(alice.id, { url: "http://docs.example.com/hook", events: ["mention"] }, own);
    expect(other.url).toBe("http://docs.example.com/hook");
    await deleteWebhook(alice.id, allowed.id);
    await deleteWebhook(alice.id, other.id);

    // Through the route: the Host header the browser sent is the origin to refuse.
    actor = alice;
    const make = (url: string) => postWebhook(new Request("http://localhost/api/webhooks", { method: "POST", headers: { "Content-Type": "application/json", Host: `localhost:${port}` }, body: JSON.stringify({ url, events: ["mention"] }) }));
    const refused = await make(`http://localhost:${port}/hook`);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "A webhook cannot point at Markdoc itself" });
    const accepted = await make(`http://localhost:${port + 1}/hook`);
    expect(accepted.status).toBe(201);
    const { webhook } = (await accepted.json()) as { webhook: { id: string; url: string } };
    expect(webhook.url).toBe(`http://localhost:${port + 1}/hook`);
    expect(await deleteWebhook(alice.id, webhook.id)).toBe(true);
  });

  it("delivers a comment.added event within a second, signed with the secret", async () => {
    received.length = 0;
    const hook = await createWebhook(alice.id, { url: receiverUrl, events: ["comment.added", "mention"], documentIds: [docId] });
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
    const hook = await createWebhook(alice.id, { url: receiverUrl, events: ["comment.replied"] });
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

  it("records a retry when the receiver fails, and disables the hook after 20 consecutive failures with a notification", async () => {
    received.length = 0;
    respondWith = 500;
    const created = await createWebhook(alice.id, { url: receiverUrl, events: ["comment.added"], documentIds: [docId] });
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

  it("sends a test event once, without retries, and resets the failure count on success", async () => {
    received.length = 0;
    respondWith = 200;
    const created = await createWebhook(alice.id, { url: receiverUrl, events: ["mention"] });
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
