import { createHash } from "node:crypto";

/**
 * In-memory rate limiting for `/api/*`. One token bucket per (caller, route class): the bucket
 * holds `burst` tokens and refills at `perMinute`, so a caller can spend a short burst and then
 * sustain the per-minute rate. Single process, single Map — Markdoc runs on one PGlite connection,
 * so there is nothing to share with another instance. Buckets that have refilled completely are
 * swept every minute.
 */

export type RouteClass = "read" | "write" | "create";

export interface Limit {
  /** Sustained rate: tokens added per minute. */
  perMinute: number;
  /** Bucket capacity: how many requests can arrive at once before `429`. */
  burst: number;
}

export const RATE_LIMITS: Record<RouteClass | "authFail", Limit> = {
  /** GET/HEAD/OPTIONS on any `/api/*` route, and `POST /api/agent/mcp-activity` (the MCP server's bookkeeping; its tools are counted at the REST routes they call). */
  read: { perMinute: 600, burst: 60 },
  /** Every other method. */
  write: { perMinute: 120, burst: 30 },
  /** Routes that create documents or store files: `POST /api/documents`, `/api/import/*`, `POST …/assets`, `POST …/duplicate`. */
  create: { perMinute: 20, burst: 20 },
  /** Bearer tokens that did not resolve, per client IP. */
  authFail: { perMinute: 30, burst: 30 },
};

const SWEEP_INTERVAL_MS = 60_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface TakeResult {
  ok: boolean;
  limit: number;
  /** Whole tokens left after this call (0 when refused). */
  remaining: number;
  /** Seconds until the next token when refused, else 0. */
  retryAfter: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  private bucket(key: string, limit: Limit, at: number): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: limit.burst, updatedAt: at };
      this.buckets.set(key, b);
      return b;
    }
    const elapsed = Math.max(0, at - b.updatedAt);
    b.tokens = Math.min(limit.burst, b.tokens + (elapsed / 60_000) * limit.perMinute);
    b.updatedAt = at;
    return b;
  }

  /** Spend one token from `key`'s bucket; refused (ok: false) when it is empty. */
  take(key: string, limit: Limit): TakeResult {
    const at = this.now();
    this.maybeSweep(at);
    const b = this.bucket(key, limit, at);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, limit: limit.burst, remaining: Math.floor(b.tokens), retryAfter: 0 };
    }
    const msPerToken = 60_000 / limit.perMinute;
    const retryAfter = Math.max(1, Math.ceil(((1 - b.tokens) * msPerToken) / 1000));
    return { ok: false, limit: limit.burst, remaining: 0, retryAfter };
  }

  /** Whole tokens currently available for `key` without spending one. */
  peek(key: string, limit: Limit): TakeResult {
    const at = this.now();
    const b = this.bucket(key, limit, at);
    if (b.tokens >= 1) return { ok: true, limit: limit.burst, remaining: Math.floor(b.tokens), retryAfter: 0 };
    const msPerToken = 60_000 / limit.perMinute;
    return { ok: false, limit: limit.burst, remaining: 0, retryAfter: Math.max(1, Math.ceil(((1 - b.tokens) * msPerToken) / 1000)) };
  }

  /** Drop buckets that are full again (idle callers); called at most once a minute. */
  private maybeSweep(at: number) {
    if (at - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = at;
    for (const [key, b] of this.buckets) {
      // Full after a minute of refill at the slowest rate (authFail/create: 20/min) or idle for an hour.
      const limit = limitForKey(key);
      const refilled = b.tokens + ((at - b.updatedAt) / 60_000) * limit.perMinute;
      if (refilled >= limit.burst) this.buckets.delete(key);
    }
  }

  /** Number of live buckets (tests). */
  get size(): number {
    return this.buckets.size;
  }

  reset() {
    this.buckets.clear();
    this.lastSweep = 0;
  }
}

/** Bucket keys are `<class>:<caller>`; the class picks the limit so the sweep can tell when a bucket is full. */
function limitForKey(key: string): Limit {
  const cls = key.slice(0, key.indexOf(":")) as RouteClass | "authFail";
  return RATE_LIMITS[cls] ?? RATE_LIMITS.write;
}

export const apiLimiter = new RateLimiter();

/** `RATE_LIMIT=off` switches the limiter off (the e2e dev server and `scripts/dev-port.mts` default to it: the Burke-scale fixture seeds dozens of documents through the API). */
export function rateLimitingEnabled(): boolean {
  return process.env.RATE_LIMIT !== "off";
}

/** Header our own `server/index.ts` stamps with the socket address so a client cannot forge its IP. */
export const REMOTE_ADDR_HEADER = "x-markdoc-remote-addr";

/** Whether a socket address is this machine: 127.0.0.0/8, `::1`, or either mapped into IPv6. */
function isLoopback(address: string): boolean {
  const a = address.toLowerCase();
  return a === "::1" || /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(a);
}

/**
 * The caller's IP, for the per-IP buckets.
 *
 * A request is "from a trusted proxy" when `TRUST_PROXY=1`, or when the socket peer (the address
 * `server/index.ts` stamped in `REMOTE_ADDR_HEADER`) is loopback: only a process on this machine can
 * connect from loopback, and on the VM that is our own nginx. A caller that reaches the app directly
 * has a non-loopback socket address, so it can never switch this on by sending headers.
 *
 * 1. Trusted proxy: the LAST `x-forwarded-for` entry, else `x-real-ip`. nginx's
 *    `$proxy_add_x_forwarded_for` appends `$remote_addr` to whatever the client sent, so the last
 *    entry is always nginx's own view of the peer and a client cannot add one after it. Never the
 *    first entry: that one is the client's to choose. `x-real-ip` comes second on purpose: until
 *    `proxy_set_header X-Real-IP` is installed, nginx passes a client-sent `X-Real-IP` through
 *    untouched, so preferring it would let a client name any address (and burn that address's
 *    `authFail` bucket). It is only the fallback for a proxy that does not append `x-forwarded-for`.
 * 2. Otherwise the socket address (no proxy at all: dev, e2e, a direct connection).
 * 3. No socket header (the request did not come through `server/index.ts`): the last
 *    `x-forwarded-for` entry, else `x-real-ip`, else `unknown`.
 */
export function clientIp(headers: Headers): string {
  const socket = headers.get(REMOTE_ADDR_HEADER)?.trim();
  const realIp = headers.get("x-real-ip")?.trim();
  const forwarded = headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  const proxied = forwarded || realIp;
  if (process.env.TRUST_PROXY === "1" || (socket && isLoopback(socket))) {
    if (proxied) return proxied;
  }
  return socket || proxied || "unknown";
}

const shortHash = (value: string) => createHash("sha256").update(value).digest("base64url").slice(0, 22);

/**
 * Who to count a request against: the bearer token when there is one (per token, so one leaked or
 * looping token cannot starve the others), else the session cookie (per browser session), else the IP.
 */
export function callerKey(headers: Headers): string {
  const authorization = headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice(7).trim();
    if (token) return `tok:${shortHash(token)}`;
  }
  const cookie = headers.get("cookie");
  if (cookie) {
    const session = cookie.split(";").map((c) => c.trim()).find((c) => /^((__Secure-)?authjs\.session-token|(__Secure-)?markdoc\.embed-session)(\.\d+)?=/.test(c));
    if (session) return `ses:${shortHash(session.slice(session.indexOf("=") + 1))}`;
  }
  return `ip:${clientIp(headers)}`;
}

const CREATE_PATHS = [/^\/api\/documents\/?$/, /^\/api\/import(\/|$)/, /^\/api\/documents\/[^/]+\/assets\/?$/, /^\/api\/documents\/[^/]+\/duplicate\/?$/];

/** Which budget a request spends: reads are cheap, writes dearer, creating documents/files dearest. */
export function routeClass(method: string, pathname: string): RouteClass {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return "read";
  // The MCP server reports activity once per JSON-RPC message; each tool call is counted at the REST route it hits.
  if (/^\/api\/agent\/mcp-activity\/?$/.test(pathname)) return "read";
  if (m === "POST" && CREATE_PATHS.some((re) => re.test(pathname))) return "create";
  return "write";
}

/** Spend one request from the caller's bucket for this route. */
export function takeApiRequest(req: Request): TakeResult & { cls: RouteClass } {
  const cls = routeClass(req.method, new URL(req.url).pathname);
  return { cls, ...apiLimiter.take(`${cls}:${callerKey(req.headers)}`, RATE_LIMITS[cls]) };
}

/** Whether this IP may still try a bearer token (it has not exhausted its failed-authentication budget). */
export function failedAuthAllowed(headers: Headers): TakeResult {
  return apiLimiter.peek(`authFail:${clientIp(headers)}`, RATE_LIMITS.authFail);
}

/** Record a bearer token that did not resolve for this IP. */
export function recordFailedAuth(headers: Headers): void {
  apiLimiter.take(`authFail:${clientIp(headers)}`, RATE_LIMITS.authFail);
}

/** Add the `X-RateLimit-*` (and on refusal `Retry-After`) headers to a response, copying it when its headers are immutable. */
export function withRateLimitHeaders(res: Response, result: TakeResult): Response {
  // A 429 raised inside the route (failed-token lockout) already names its own bucket.
  if (res.status === 429 && res.headers.has("Retry-After")) return res;
  const set = (headers: Headers) => {
    headers.set("X-RateLimit-Limit", String(result.limit));
    headers.set("X-RateLimit-Remaining", String(result.remaining));
    if (!result.ok) headers.set("Retry-After", String(result.retryAfter));
  };
  try {
    set(res.headers);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    set(headers);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}
