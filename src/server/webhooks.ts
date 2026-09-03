import { createHmac, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { getDb, schema } from "@/server/db";
import { getDocumentAccess, type SessionUser } from "@/server/documents";
import { notify } from "@/server/notifications";
import { registerPressureGauge } from "@/server/pressure-gauges";
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

/** A `documentIds` entry the user cannot see. Answered as `404 Document not found: <id>`, exactly like `POST /api/tokens`, so a restriction is not a way to name documents you do not have. */
export class WebhookDocumentNotFoundError extends Error {
  readonly status = 404;
  constructor(public readonly documentId: string) {
    super(`Document not found: ${documentId}`);
  }
}

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
  return `${u.hostname.toLowerCase()}:${portOf(u)}`;
}

function portOf(u: URL): string {
  return u.port || (u.protocol === "https:" ? "443" : "80");
}

/**
 * Literals that always mean this machine, whatever interfaces are up: `localhost` and `*.localhost`,
 * all of `127.0.0.0/8`, `::1`, the bind-all addresses `0.0.0.0` / `::`, and their IPv4-mapped forms.
 * `hostname` is WHATWG-canonical (`URL#hostname`): `127.1`, `2130706433` and `0x7f.0.0.1` have
 * already become `127.0.0.1`, and `[::ffff:127.0.0.1]` has become `[::ffff:7f00:1]`.
 */
function isLoopbackLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0" || h === "[::]" || h === "[::1]" || h === "[::ffff:0:0]") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(h);
}

/** Every address of every interface (`os.networkInterfaces()`), plus the machine name and `<name>.local`. */
function selfAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) out.push(entry.address);
  }
  const name = os.hostname();
  if (name) out.push(name, `${name}.local`);
  return out;
}

/** A bare IPv6 address as a URL host: zone id (`%eth0`) dropped, brackets added. Anything else passes through. */
function bracketIpv6(address: string): string {
  if (!address.includes(":") || address.startsWith("[")) return address;
  return `[${address.replace(/%.*$/, "")}]`;
}

export interface OwnOriginSelf {
  /** The port this server listens on; defaults to `PORT` (3000 when unset), as `server/index.ts` binds it. */
  port?: number;
  /** Addresses and names that reach this machine; defaults to `selfAddresses()`. Loopback literals are always included. */
  addresses?: readonly string[];
}

/**
 * `host:port` keys of this server's own origins, for refusing webhooks that would call Markdoc back:
 * the request's `Host` header (its scheme is unknown, so both default ports count), `MARKDOC_URL`
 * when set (the public origin behind a proxy), and — on each of those ports and the listening port —
 * every other spelling of this machine: `localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`, `[::]`, the
 * interface addresses `server/index.ts` prints at startup and the machine name. Other localhost ports
 * stay allowed — LAN bridges are real. Pass `self` to pin the port and addresses (tests).
 */
export function ownOriginKeys(hostHeader: string | null | undefined, markdocUrl: string | undefined = process.env.MARKDOC_URL, self: OwnOriginSelf = {}): string[] {
  const keys = new Set<string>();
  const ports = new Set<string>();
  const add = (url: string) => {
    try {
      const u = new URL(url);
      keys.add(hostKey(u));
      ports.add(portOf(u));
    } catch {
      // A malformed Host header, MARKDOC_URL or machine name is nothing to compare against.
    }
  };
  const host = hostHeader?.trim();
  if (host) for (const proto of ["http:", "https:"]) add(`${proto}//${host}`);
  if (markdocUrl) add(markdocUrl);
  const listening = self.port ?? Number(process.env.PORT ?? 3000);
  if (Number.isInteger(listening) && listening > 0 && listening <= 65535) ports.add(String(listening));
  const names = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]", ...(self.addresses ?? selfAddresses()).map(bracketIpv6)];
  for (const port of ports) for (const name of names) add(`http://${name}:${port}`);
  return [...keys];
}

/** Whether `url` targets one of `ownOrigins` (see `ownOriginKeys`): an exact key, or any loopback literal on one of their ports. */
export function isOwnOrigin(url: URL, ownOrigins: readonly string[]): boolean {
  if (ownOrigins.includes(hostKey(url))) return true;
  if (!isLoopbackLiteral(url.hostname)) return false;
  const port = portOf(url);
  return ownOrigins.some((key) => key.slice(key.lastIndexOf(":") + 1) === port);
}

function validate(input: WebhookInput, ownOrigins: readonly string[]): { url: string; events: WebhookEventType[]; documentIds: string[] | null } {
  let parsed: URL;
  try {
    parsed = new URL(input.url.trim());
  } catch {
    throw new WebhookValidationError("Enter a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new WebhookValidationError("Webhook URLs must be http(s)");
  if (isOwnOrigin(parsed, ownOrigins)) throw new WebhookValidationError("A webhook cannot point at Markdoc itself");
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

/**
 * Add a webhook. `ownOrigins` (see `ownOriginKeys`) are the server's own `host:port`s, which a webhook may not target.
 * Every `documentIds` entry must be a document `user` can see, else `WebhookDocumentNotFoundError` (404): the
 * dispatcher only delivers what the owner could read anyway, and a bogus or foreign id must not be stored either.
 */
export async function createWebhook(user: SessionUser, input: WebhookInput, ownOrigins: readonly string[] = []): Promise<CreatedWebhook> {
  const { url, events, documentIds } = validate(input, ownOrigins);
  for (const id of documentIds ?? []) {
    if (!(await getDocumentAccess(id, user))) throw new WebhookDocumentNotFoundError(id);
  }
  const db = await getDb();
  const secret = "whsec_" + randomBytes(24).toString("base64url");
  const [row] = await db.insert(schema.webhooks).values({ id: newId(), userId: user.id, url, secret, events, documentIds }).returning();
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
  deliveryInflight: number;
  /** Active hooks as of `at`; refreshed every few seconds and dropped on any change, so a wake per keystroke does not mean a query per keystroke. */
  hooksCache: { at: number; rows: schema.Webhook[] } | null;
}

// One dispatcher per process even when the module is re-evaluated (dev HMR).
const g = globalThis as typeof globalThis & { __markdocWebhooks?: DispatcherState };
const state: DispatcherState = (g.__markdocWebhooks ??= { loop: null, stopped: false, cursors: new Map(), lastSweep: Date.now(), lastPrune: 0, retryTimers: new Set(), inflight: new Set(), retryDelays: RETRY_DELAYS_MS, seqs: new Map(), sweeping: null, deliveryInflight: 0, hooksCache: null });
state.deliveryInflight ??= 0;
const HOOKS_CACHE_MS = 5_000;

registerPressureGauge("webhook_inflight", () => state.deliveryInflight);
registerPressureGauge("webhook_retries", () => state.retryTimers.size);

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
  // A hook stored before the own-origin check (or under a spelling it missed) must not loop Markdoc into itself.
  if (targetsSelf(url)) return 0;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DELIVERY_TIMEOUT_MS);
  state.deliveryInflight++;
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: ctl.signal, redirect: "manual" });
    return res.status;
  } catch {
    return 0;
  } finally {
    state.deliveryInflight = Math.max(0, state.deliveryInflight - 1);
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

/** Whether a stored webhook URL points back at this server. No request `Host` here: `MARKDOC_URL`, the listening port and this machine's addresses decide. */
function targetsSelf(url: string): boolean {
  try {
    return isOwnOrigin(new URL(url), ownOriginKeys(null));
  } catch {
    return false;
  }
}

/**
 * POST one event to a webhook, record the attempt, and on failure count it towards disabling the hook
 * and schedule a retry (10 s / 1 min / 10 min). Resolves with the first attempt's result; retries run
 * in the background. A hook that targets this server is never sent and is disabled at once: retrying
 * cannot fix it, and each attempt would be the self-loop the own-origin check exists to prevent.
 */
export async function deliverWebhook(hook: schema.Webhook, payload: WebhookPayload, attempt = 1, deliveryId = randomUUID()): Promise<DeliveryResult> {
  if (targetsSelf(hook.url)) {
    const rowId = await recordDelivery(hook.id, payload.type, 0, 0, attempt);
    if (hook.active) await disableWebhook(hook, payload.documentId);
    return { deliveryId: rowId, status: 0, ok: false, durationMs: 0, attempt };
  }
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
      // Always re-check at delivery time, `documentIds` or not: shares get revoked, link access gets closed, and a
      // hook created before the share was revoked must not keep receiving that document's comments and diffs.
      // Dropping the cursor means a later re-share starts from that sweep, not from the events missed meanwhile.
      if (!(await getDocumentAccess(docId, user).catch(() => null))) {
        cursors.delete(docId);
        continue;
      }
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
