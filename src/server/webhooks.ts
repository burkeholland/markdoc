import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { getDb, schema } from "@/server/db";
import { getDocumentAccess, type SessionUser } from "@/server/documents";
import { notify } from "@/server/notifications";
import { collectDocumentEvents, decodeCursor, encodeCursor, waitForWake, wakeSeq, wokenDocuments, type AgentEvent } from "@/server/agent-events";

/**
 * Outbound webhooks: push the events `markdoc_watch` long-polls for to a user's HTTP endpoint. The
 * dispatcher is a server-side long-poller: it waits on the same wake-ups as the REST route, then runs
 * `collectDocumentEvents` for every woken document × webhook with a per-webhook cursor, so both channels
 * see identical events. It lives in the Next.js module graph (it needs livedoc); the collaboration
 * server's wake-ups reach it through the shared state in agent-events.ts.
 */

export const WEBHOOK_EVENTS = ["request.created", "mention", "comment.added", "comment.replied", "review.created", "suggestion.accepted", "suggestion.rejected", "content.changed"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export const DELIVERY_TIMEOUT_MS = 5_000;
/** Retries after a failed delivery (so 4 attempts in all). */
export const RETRY_DELAYS_MS: readonly number[] = [10_000, 60_000, 600_000];
export const MAX_CONSECUTIVE_FAILURES = 20;
export const DELIVERY_RETENTION_DAYS = 7;
/** The dispatcher wakes at least this often to prune old deliveries. */
const IDLE_SWEEP_MS = 30_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;

const newId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

// --- Signing -----------------------------------------------------------------

export function signWebhookBody(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/** Constant-time check of an `X-Markdoc-Signature` header against a body. Receivers can copy this. */
export function verifyWebhookSignature(secret: string, body: string, signature: string | null | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signWebhookBody(secret, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ given[i];
  return diff === 0;
}

// --- CRUD --------------------------------------------------------------------

export class WebhookValidationError extends Error {}

export interface WebhookInput {
  url: string;
  events: string[];
  documentIds?: string[] | null;
}

export interface WebhookDto {
  id: string;
  url: string;
  events: WebhookEventType[];
  documentIds: string[] | null;
  active: boolean;
  failures: number;
  createdAt: string;
  lastDelivery: { status: number; at: string; attempt: number; event: string } | null;
}

export interface CreatedWebhook extends WebhookDto {
  /** The HMAC secret. Shown once. */
  secret: string;
}

/** `hostname:port` with the default port made explicit, so `https://x` and `https://x:443` compare equal. */
function hostKey(u: URL): string {
  return `${u.hostname.toLowerCase()}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
}

/**
 * `host:port` keys of this server's own origins, for refusing webhooks that would call Markdoc back:
 * the request's `Host` header (its scheme is unknown, so both default ports count) and `MARKDOC_URL`
 * when set (the public origin behind a proxy). Other localhost ports stay allowed — LAN bridges are real.
 */
export function ownOriginKeys(hostHeader: string | null | undefined, markdocUrl: string | undefined = process.env.MARKDOC_URL): string[] {
  const keys = new Set<string>();
  const host = hostHeader?.trim();
  if (host) {
    for (const proto of ["http:", "https:"]) {
      try {
        keys.add(hostKey(new URL(`${proto}//${host}`)));
      } catch {
        // A malformed Host header is nothing to compare against.
      }
    }
  }
  if (markdocUrl) {
    try {
      keys.add(hostKey(new URL(markdocUrl)));
    } catch {
      // Unparseable MARKDOC_URL: ignore here; the MCP route reports it.
    }
  }
  return [...keys];
}

function validate(input: WebhookInput, ownOrigins: readonly string[]): { url: string; events: WebhookEventType[]; documentIds: string[] | null } {
  let parsed: URL;
  try {
    parsed = new URL(input.url.trim());
  } catch {
    throw new WebhookValidationError("Enter a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new WebhookValidationError("Webhook URLs must be http(s)");
  if (ownOrigins.includes(hostKey(parsed))) throw new WebhookValidationError("A webhook cannot point at Markdoc itself");
  const events = [...new Set(input.events)].filter((e): e is WebhookEventType => (WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (events.length === 0) throw new WebhookValidationError("Pick at least one event");
  const documentIds = input.documentIds && input.documentIds.length > 0 ? [...new Set(input.documentIds.map((d) => d.trim()).filter(Boolean))] : null;
  return { url: parsed.toString(), events, documentIds };
}

function toDto(row: schema.Webhook, last: schema.WebhookDelivery | null): WebhookDto {
  return {
    id: row.id,
    url: row.url,
    events: row.events.filter((e): e is WebhookEventType => (WEBHOOK_EVENTS as readonly string[]).includes(e)),
    documentIds: row.documentIds ?? null,
    active: row.active,
    failures: row.failures,
    createdAt: row.createdAt.toISOString(),
    lastDelivery: last ? { status: last.status, at: last.createdAt.toISOString(), attempt: last.attempt, event: last.event } : null,
  };
}

/** Add a webhook. `ownOrigins` (see `ownOriginKeys`) are the server's own `host:port`s, which a webhook may not target. */
export async function createWebhook(userId: string, input: WebhookInput, ownOrigins: readonly string[] = []): Promise<CreatedWebhook> {
  const { url, events, documentIds } = validate(input, ownOrigins);
  const db = await getDb();
  const secret = "whsec_" + randomBytes(24).toString("base64url");
  const [row] = await db.insert(schema.webhooks).values({ id: newId(), userId, url, secret, events, documentIds }).returning();
  state.cursors.delete(row.id);
  state.hooksCache = null;
  return { ...toDto(row, null), secret };
}

export async function listWebhooks(userId: string): Promise<WebhookDto[]> {
  const db = await getDb();
  const rows = await db.select().from(schema.webhooks).where(eq(schema.webhooks.userId, userId)).orderBy(desc(schema.webhooks.createdAt));
  if (rows.length === 0) return [];
  // Newest delivery per hook, one query.
  const latest = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(
      inArray(
        schema.webhookDeliveries.webhookId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(desc(schema.webhookDeliveries.createdAt))
    .limit(rows.length * 8);
  const lastBy = new Map<string, schema.WebhookDelivery>();
  for (const d of latest) if (!lastBy.has(d.webhookId)) lastBy.set(d.webhookId, d);
  return rows.map((r) => toDto(r, lastBy.get(r.id) ?? null));
}

export async function deleteWebhook(userId: string, id: string): Promise<boolean> {
  const db = await getDb();
  const deleted = await db.delete(schema.webhooks).where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.userId, userId))).returning();
  state.cursors.delete(id);
  state.hooksCache = null;
  return deleted.length > 0;
}

/** Active webhooks of a user, for `/api/me` (no secret). */
export async function activeWebhooksFor(userId: string): Promise<Pick<WebhookDto, "id" | "url" | "events" | "documentIds">[]> {
  const db = await getDb();
  const rows = await db.select().from(schema.webhooks).where(and(eq(schema.webhooks.userId, userId), eq(schema.webhooks.active, true))).orderBy(desc(schema.webhooks.createdAt));
  return rows.map((r) => ({ id: r.id, url: r.url, events: r.events as WebhookEventType[], documentIds: r.documentIds ?? null }));
}

// --- Delivery ----------------------------------------------------------------

export type WebhookPayload = (AgentEvent | { type: "test"; documentId: null; actor: null; at: string }) & { documentTitle: string | null; cursor: string | null };

export interface DeliveryResult {
  deliveryId: string;
  status: number;
  ok: boolean;
  durationMs: number;
  attempt: number;
}

interface DispatcherState {
  loop: Promise<void> | null;
  stopped: boolean;
  /** webhookId → documentId → cursor of the last collection. */
  cursors: Map<string, Map<string, string>>;
  /** Epoch ms of the last sweep; the starting point for documents a hook has not collected yet. */
  lastSweep: number;
  lastPrune: number;
  retryTimers: Set<ReturnType<typeof setTimeout>>;
  inflight: Set<Promise<unknown>>;
  retryDelays: readonly number[];
  seqs: Map<string, number>;
  sweeping: Promise<number> | null;
  /** Active hooks as of `at`; refreshed every few seconds and dropped on any change, so a wake per keystroke does not mean a query per keystroke. */
  hooksCache: { at: number; rows: schema.Webhook[] } | null;
}

// One dispatcher per process even when the module is re-evaluated (dev HMR).
const g = globalThis as typeof globalThis & { __markdocWebhooks?: DispatcherState };
const state: DispatcherState = (g.__markdocWebhooks ??= { loop: null, stopped: false, cursors: new Map(), lastSweep: Date.now(), lastPrune: 0, retryTimers: new Set(), inflight: new Set(), retryDelays: RETRY_DELAYS_MS, seqs: new Map(), sweeping: null, hooksCache: null });
const HOOKS_CACHE_MS = 5_000;

async function activeHooks(now: number): Promise<schema.Webhook[]> {
  if (state.hooksCache && now - state.hooksCache.at < HOOKS_CACHE_MS) return state.hooksCache.rows;
  const db = await getDb();
  const rows = await db.select().from(schema.webhooks).where(eq(schema.webhooks.active, true));
  state.hooksCache = { at: now, rows };
  return rows;
}

async function recordDelivery(webhookId: string, event: string, status: number, durationMs: number, attempt: number): Promise<string> {
  const db = await getDb();
  const id = newId();
  await db.insert(schema.webhookDeliveries).values({ id, webhookId, event, status, durationMs, attempt });
  return id;
}

async function postOnce(url: string, headers: Record<string, string>, body: string): Promise<number> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: ctl.signal, redirect: "manual" });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/** Disable a hook that keeps failing and tell its owner (a notification needs a document: the one that fired, else the owner's latest). */
async function disableWebhook(hook: schema.Webhook, documentId: string | null) {
  const db = await getDb();
  await db.update(schema.webhooks).set({ active: false }).where(eq(schema.webhooks.id, hook.id));
  state.cursors.delete(hook.id);
  state.hooksCache = null;
  const [owner] = await db.select({ login: schema.users.login }).from(schema.users).where(eq(schema.users.id, hook.userId)).limit(1);
  if (!owner?.login) return;
  let docId = documentId ?? hook.documentIds?.[0] ?? null;
  if (!docId) {
    const [doc] = await db.select({ id: schema.documents.id }).from(schema.documents).where(and(eq(schema.documents.ownerId, hook.userId), sql`${schema.documents.deletedAt} is null`)).orderBy(desc(schema.documents.updatedAt)).limit(1);
    docId = doc?.id ?? null;
  }
  if (!docId) return;
  await notify({ userLogin: owner.login, documentId: docId, kind: "webhook.disabled", actorLogin: null, actorName: "Markdoc", refId: `webhook:${hook.id}:${Date.now()}`, snippet: hook.url }).catch(() => false);
}

/**
 * POST one event to a webhook, record the attempt, and on failure count it towards disabling the hook
 * and schedule a retry (10 s / 1 min / 10 min). Resolves with the first attempt's result; retries run
 * in the background.
 */
export async function deliverWebhook(hook: schema.Webhook, payload: WebhookPayload, attempt = 1, deliveryId = randomUUID()): Promise<DeliveryResult> {
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "Markdoc-Webhook/1.0",
    "X-Markdoc-Event": payload.type,
    "X-Markdoc-Delivery": deliveryId,
    "X-Markdoc-Attempt": String(attempt),
    "X-Markdoc-Signature": signWebhookBody(hook.secret, body),
  };
  const started = Date.now();
  const status = await postOnce(hook.url, headers, body);
  const durationMs = Date.now() - started;
  const ok = status >= 200 && status < 300;
  const db = await getDb();
  const rowId = await recordDelivery(hook.id, payload.type, status, durationMs, attempt);
  if (ok) {
    await db.update(schema.webhooks).set({ failures: 0 }).where(and(eq(schema.webhooks.id, hook.id), sql`${schema.webhooks.failures} > 0`));
    return { deliveryId: rowId, status, ok, durationMs, attempt };
  }
  const [updated] = await db
    .update(schema.webhooks)
    .set({ failures: sql`${schema.webhooks.failures} + 1` })
    .where(eq(schema.webhooks.id, hook.id))
    .returning();
  if (!updated) return { deliveryId: rowId, status, ok, durationMs, attempt }; // deleted meanwhile
  if (updated.failures >= MAX_CONSECUTIVE_FAILURES) {
    if (updated.active) await disableWebhook(updated, payload.documentId);
    return { deliveryId: rowId, status, ok, durationMs, attempt };
  }
  const delay = state.retryDelays[attempt - 1];
  if (delay !== undefined && updated.active) {
    const timer = setTimeout(() => {
      state.retryTimers.delete(timer);
      track(deliverWebhook(updated, payload, attempt + 1, deliveryId));
    }, delay);
    timer.unref?.();
    state.retryTimers.add(timer);
  }
  return { deliveryId: rowId, status, ok, durationMs, attempt };
}

function track<T>(p: Promise<T>): Promise<T> {
  const tracked = p.catch((err) => {
    console.error("[webhooks] delivery failed", err);
    return undefined as T;
  });
  state.inflight.add(tracked);
  void tracked.finally(() => state.inflight.delete(tracked));
  return tracked;
}

/** "Send test" in Settings: a `test` event, delivered once without retries. */
export async function sendTestWebhook(userId: string, id: string): Promise<DeliveryResult | null> {
  const db = await getDb();
  const [hook] = await db
    .select()
    .from(schema.webhooks)
    .where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.userId, userId)))
    .limit(1);
  if (!hook) return null;
  const payload: WebhookPayload = { type: "test", documentId: null, documentTitle: null, cursor: null, actor: null, at: new Date().toISOString() };
  // No retries for tests: the button's result is the answer.
  const body = JSON.stringify(payload);
  const deliveryId = randomUUID();
  const started = Date.now();
  const status = await postOnce(hook.url, { "Content-Type": "application/json", "User-Agent": "Markdoc-Webhook/1.0", "X-Markdoc-Event": "test", "X-Markdoc-Delivery": deliveryId, "X-Markdoc-Attempt": "1", "X-Markdoc-Signature": signWebhookBody(hook.secret, body) }, body);
  const durationMs = Date.now() - started;
  const ok = status >= 200 && status < 300;
  const rowId = await recordDelivery(hook.id, "test", status, durationMs, 1);
  return { deliveryId: rowId, status, ok, durationMs, attempt: 1 };
}

// --- Dispatcher --------------------------------------------------------------

function startCursor(sinceMs: number): string {
  return encodeCursor({ a: sinceMs, ids: [], n: sinceMs, r: sinceMs, h: null });
}

function wants(hook: schema.Webhook, event: AgentEvent): boolean {
  return hook.events.includes(event.type);
}

/** One pass: collect events on the woken documents for every active webhook and post them. Exported for tests. */
export function sweepWebhooks(now = Date.now()): Promise<number> {
  // Sweeps never overlap (two collections with one cursor would deliver twice); a concurrent call queues behind the running one.
  const run = (state.sweeping ?? Promise.resolve()).then(() => sweepOnce(now), () => sweepOnce(now));
  state.sweeping = run;
  void run.finally(() => {
    if (state.sweeping === run) state.sweeping = null;
  });
  return run;
}

async function sweepOnce(now: number): Promise<number> {
  const { changed, seqs } = wokenDocuments(state.seqs);
  state.seqs = seqs;
  const since = state.lastSweep;
  state.lastSweep = now;
  if (changed.length === 0) return 0;
  const db = await getDb();
  const hooks = await activeHooks(now);
  if (hooks.length === 0) return 0;
  const users = new Map((await db.select().from(schema.users).where(inArray(schema.users.id, [...new Set(hooks.map((h) => h.userId))]))).map((u) => [u.id, u]));
  const docs = new Map((await db.select({ id: schema.documents.id, title: schema.documents.title, deletedAt: schema.documents.deletedAt }).from(schema.documents).where(inArray(schema.documents.id, changed))).map((d) => [d.id, d]));
  let sent = 0;
  for (const hook of hooks) {
    const u = users.get(hook.userId);
    if (!u) continue;
    const user: SessionUser = { id: u.id, login: u.login ?? null, name: u.name, image: u.image };
    let cursors = state.cursors.get(hook.id);
    if (!cursors) {
      cursors = new Map();
      state.cursors.set(hook.id, cursors);
    }
    for (const docId of changed) {
      const doc = docs.get(docId);
      if (!doc || doc.deletedAt) continue;
      if (hook.documentIds && !hook.documentIds.includes(docId)) continue;
      if (!hook.documentIds && !(await getDocumentAccess(docId, user).catch(() => null))) continue;
      const cursor = cursors.get(docId) ?? startCursor(since);
      const page = await collectDocumentEvents(docId, user, decodeCursor(cursor), { includeSelf: true }).catch((err) => {
        console.error("[webhooks] collect failed", docId, err);
        return null;
      });
      if (!page) continue;
      cursors.set(docId, page.cursor);
      for (const event of page.events) {
        if (!wants(hook, event)) continue;
        const payload: WebhookPayload = { ...event, documentTitle: "documentTitle" in event && event.documentTitle ? event.documentTitle : doc.title, cursor: page.cursor };
        track(deliverWebhook(hook, payload));
        sent++;
      }
    }
  }
  if (now - state.lastPrune > PRUNE_INTERVAL_MS) {
    state.lastPrune = now;
    await pruneDeliveries(now).catch(() => 0);
  }
  return sent;
}

export async function pruneDeliveries(now = Date.now()): Promise<number> {
  const db = await getDb();
  const rows = await db
    .delete(schema.webhookDeliveries)
    .where(lt(schema.webhookDeliveries.createdAt, new Date(now - DELIVERY_RETENTION_DAYS * 86_400_000)))
    .returning();
  return rows.length;
}

async function runLoop() {
  while (!state.stopped) {
    const seq = wakeSeq(null);
    try {
      await sweepWebhooks();
    } catch (err) {
      console.error("[webhooks] sweep failed", err);
    }
    if (state.stopped) break;
    await waitForWake(null, seq, IDLE_SWEEP_MS);
  }
}

/** Start the dispatcher once per process. Called from instrumentation.ts and, as a fallback, from the webhook routes. */
export function startWebhookDispatcher(): void {
  if (state.loop) return;
  state.stopped = false;
  state.seqs = wokenDocuments(new Map()).seqs;
  state.lastSweep = Date.now();
  state.loop = runLoop().catch((err) => console.error("[webhooks] dispatcher stopped", err));
}

/** Tests only: stop the loop, cancel retries, wait for in-flight deliveries. */
export async function stopWebhookDispatcher(): Promise<void> {
  state.stopped = true;
  for (const t of state.retryTimers) clearTimeout(t);
  state.retryTimers.clear();
  await Promise.allSettled([...state.inflight]);
  state.loop = null;
}

/** Tests only. */
export function setWebhookRetryDelays(delays: readonly number[] | null): void {
  state.retryDelays = delays ?? RETRY_DELAYS_MS;
}

/** Tests only. */
export async function settleWebhookDeliveries(): Promise<void> {
  while (state.inflight.size > 0) await Promise.allSettled([...state.inflight]);
}
