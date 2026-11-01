import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_VIDEO_BYTES, VIDEO_CHUNK_BYTES } from "@/lib/video-limits";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;
delete process.env.RATE_LIMIT;

// Routes read the caller through `next/headers`; tests set `requestHeaders` to the request they send.
let requestHeaders = new Headers();
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const { getDb, schema } = await import("@/server/db");
const { createApiToken } = await import("@/server/tokens");
const { createDocument } = await import("@/server/documents");
const { apiLimiter, RATE_LIMITS, RateLimiter, clientIp, routeClass, REMOTE_ADDR_HEADER, recordFailedAuth, failedAuthAllowed } = await import("@/server/rate-limit");
const me = await import("@/app/api/me/route");
const documents = await import("@/app/api/documents/route");
const star = await import("@/app/api/documents/[id]/star/route");
const { handler, json, rateLimitCaller } = await import("@/server/http");

const BASE = "http://localhost:3700";
const bearer = (value: string) => ["Bear", "er ", value].join("");

function send(route: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>, method: string, path: string, init: { token?: string; ip?: string; body?: unknown; id?: string } = {}) {
  const headers = new Headers();
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  headers.set(REMOTE_ADDR_HEADER, init.ip ?? "10.0.0.1");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  requestHeaders = headers;
  const req = new Request(`${BASE}${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  return route(req, { params: Promise.resolve({ id: init.id ?? "" }) });
}

const statuses = (responses: Response[]) => responses.reduce<Record<number, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
/** Move the faked clock forward (only `Date` is faked, so PGlite's own timers keep running). */
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

let token: string;
let otherToken: string;
let docId: string;

beforeAll(async () => {
  const db = await getDb();
  const [user] = await db.insert(schema.users).values({ name: "Limited", login: "limited", email: "limited@example.com" }).returning();
  token = (await createApiToken(user.id, "Agent A")).token;
  otherToken = (await createApiToken(user.id, "Agent B")).token;
  docId = (await createDocument({ ownerId: user.id, title: "Starred" })).id;
});

beforeEach(() => {
  apiLimiter.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-25T06:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  apiLimiter.reset();
});

describe("RateLimiter", () => {
  it("allows a burst, then refills at the sustained rate", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const limit = { perMinute: 120, burst: 30 };
    for (let i = 0; i < 30; i++) expect(limiter.take("write:k", limit).ok).toBe(true);
    const refused = limiter.take("write:k", limit);
    expect(refused).toMatchObject({ ok: false, remaining: 0, retryAfter: 1 });
    now += 500; // one token at 2/s
    expect(limiter.take("write:k", limit).ok).toBe(true);
    expect(limiter.take("write:k", limit).ok).toBe(false);
    now += 60_000;
    expect(limiter.take("write:k", limit)).toMatchObject({ ok: true, remaining: 29 });
  });

  describe("cross-site mutation protection", () => {
    const write = handler(async (req: Request) => json({ ok: req.method === "POST" }));

    it("rejects cookie-backed cross-site writes while allowing same-origin and bearer requests", async () => {
      const crossSite = new Request(`${BASE}/api/test`, {
        method: "POST",
        headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      });
      expect((await write(crossSite)).status).toBe(403);

      const sameOrigin = new Request(`${BASE}/api/test`, {
        method: "POST",
        headers: { origin: BASE, "sec-fetch-site": "same-origin" },
      });
      expect((await write(sameOrigin)).status).toBe(200);

      const bearer = new Request(`${BASE}/api/test`, {
        method: "POST",
        headers: { authorization: "Bearer mdk_test", origin: "https://agent.example", "sec-fetch-site": "cross-site" },
      });
      expect((await write(bearer)).status).toBe(200);
    });

    it("uses the browser-facing host and protocol behind LAN and HTTPS proxies", async () => {
      for (const request of [
        new Request("http://127.0.0.1:3200/api/test", {
          method: "POST",
          headers: {
            host: "SURF:3200",
            origin: "http://surf:3200",
            "x-forwarded-host": "SURF:3200",
          },
        }),
        new Request("http://127.0.0.1:3200/api/test", {
          method: "POST",
          headers: {
            host: "SURF.local:3200",
            origin: "http://surf.local:3200",
            "x-forwarded-host": "SURF.local:3200",
          },
        }),
        new Request("http://127.0.0.1:3200/api/test", {
          method: "POST",
          headers: {
            origin: "https://markdoc.example",
            "x-forwarded-host": "markdoc.example",
            "x-forwarded-proto": "https",
          },
        }),
      ]) {
        expect((await write(request)).status).toBe(200);
      }

      const spoofedSameSite = new Request("http://127.0.0.1:3200/api/test", {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "sec-fetch-site": "same-origin",
          "x-forwarded-host": "markdoc.example",
          "x-forwarded-proto": "https",
        },
      });
      expect((await write(spoofedSameSite)).status).toBe(403);
    });
  });

  it("sweeps idle buckets once a minute", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    limiter.take("read:a", RATE_LIMITS.read);
    limiter.take("read:b", RATE_LIMITS.read);
    expect(limiter.size).toBe(2);
    now = 10 * 60_000;
    limiter.take("read:c", RATE_LIMITS.read);
    expect(limiter.size).toBe(1);
  });
});

describe("route classes and caller keys", () => {
  it("classifies reads, writes and creates", () => {
    expect(routeClass("GET", "/api/me")).toBe("read");
    expect(routeClass("HEAD", "/api/documents")).toBe("read");
    expect(routeClass("POST", "/api/mcp")).toBe("read");
    expect(routeClass("PUT", "/api/documents/abc/content")).toBe("write");
    expect(routeClass("POST", "/api/documents/abc/comments")).toBe("write");
    expect(routeClass("POST", "/api/documents")).toBe("create");
    expect(routeClass("POST", "/api/import")).toBe("create");
    expect(routeClass("POST", "/api/import/file")).toBe("create");
    expect(routeClass("POST", "/api/documents/abc/assets")).toBe("create");
    expect(routeClass("POST", "/api/documents/abc/assets/videos")).toBe("create");
    expect(routeClass("PUT", "/api/documents/abc/assets/videos/0123456789abcdef/parts/0")).toBe("videoUpload");
    expect(routeClass("POST", "/api/documents/abc/assets/videos/0123456789abcdef/complete")).toBe("videoUpload");
    expect(routeClass("DELETE", "/api/documents/abc/assets/videos/0123456789abcdef")).toBe("videoUpload");
    expect(routeClass("POST", "/api/documents/abc/duplicate")).toBe("create");
    expect(routeClass("DELETE", "/api/documents/abc")).toBe("write");
  });

  it("budgets every chunk and terminal request for a maximum video upload", () => {
    const chunks = Math.ceil(MAX_VIDEO_BYTES / VIDEO_CHUNK_BYTES);
    const requestsPerFile = chunks + 1;
    expect(RATE_LIMITS.videoUpload.burst).toBe(requestsPerFile * RATE_LIMITS.create.burst);
    expect(RATE_LIMITS.videoUpload.perMinute).toBe(requestsPerFile * RATE_LIMITS.create.perMinute);
  });

  it("keys verified tokens by token id and everything unverified by client address (#2323)", async () => {
    const ip = { [REMOTE_ADDR_HEADER]: "10.1.1.1" };
    const a = await rateLimitCaller(new Headers({ ...ip, authorization: bearer(token) }));
    const b = await rateLimitCaller(new Headers({ ...ip, authorization: bearer(otherToken) }));
    expect(a).toMatch(/^tok:/);
    expect(b).toMatch(/^tok:/);
    expect(a).not.toBe(b);
    for (const authorization of [bearer("mdk_made_up_value"), bearer("not-a-token"), bearer(`${token}x`)]) {
      expect(await rateLimitCaller(new Headers({ ...ip, authorization }))).toBe("ip:10.1.1.1");
    }
    expect(await rateLimitCaller(new Headers({ ...ip, cookie: "authjs.session-token=made-up" }))).toBe("ip:10.1.1.1");
    expect(await rateLimitCaller(new Headers({ ...ip, cookie: "markdoc.embed-session=made-up" }))).toBe("ip:10.1.1.1");
    expect(await rateLimitCaller(new Headers(ip))).toBe("ip:10.1.1.1");
  });

  it("a different made-up bearer value per request does not get a fresh bucket (#2323)", async () => {
    const open = handler(async (req: Request) => json({ ok: req.method === "GET" }));
    const results: Response[] = [];
    for (let i = 0; i < 70; i++) {
      results.push(await open(new Request(`${BASE}/api/open`, { headers: { [REMOTE_ADDR_HEADER]: "10.2.2.2", authorization: bearer(`mdk_made_up_${i}`) } })));
    }
    const none: Response[] = [];
    for (let i = 0; i < 70; i++) none.push(await open(new Request(`${BASE}/api/open`, { headers: { [REMOTE_ADDR_HEADER]: "10.3.3.3" } })));
    expect(statuses(results)[429]).toBeGreaterThan(0);
    expect(statuses(results)[200]).toBe(RATE_LIMITS.read.burst);
    expect(statuses(none)[429]).toBeGreaterThan(0);
  });

  it("behind nginx, a client-sent X-Forwarded-For cannot pick or escape the bucket (#2324)", async () => {
    const open = handler(async (req: Request) => json({ ok: req.method === "GET" }));
    const results: Response[] = [];
    for (let i = 0; i < 70; i++) {
      // nginx appends the real peer (203.0.113.50) after whatever the client sent.
      const xff = `198.51.100.${i}, 203.0.113.50`;
      results.push(await open(new Request(`${BASE}/api/open`, { headers: { [REMOTE_ADDR_HEADER]: "127.0.0.1", "x-forwarded-for": xff } })));
    }
    expect(statuses(results)[200]).toBe(RATE_LIMITS.read.burst);
    const other = await open(new Request(`${BASE}/api/open`, { headers: { [REMOTE_ADDR_HEADER]: "127.0.0.1", "x-forwarded-for": "203.0.113.51" } }));
    expect(other.status).toBe(200);
  });

  it("takes the socket address over client-supplied forwarding headers when the peer is not loopback", () => {
    const h = new Headers({ [REMOTE_ADDR_HEADER]: "10.1.1.1", "x-forwarded-for": "1.2.3.4, 10.0.0.2", "x-real-ip": "9.9.9.9" });
    expect(clientIp(h)).toBe("10.1.1.1");
  });

  it("with TRUST_PROXY=1 uses the last x-forwarded-for entry, then x-real-ip, never the first", () => {
    process.env.TRUST_PROXY = "1";
    try {
      const forged = { [REMOTE_ADDR_HEADER]: "10.1.1.1", "x-forwarded-for": "6.6.6.6, 203.0.113.7" };
      expect(clientIp(new Headers(forged))).toBe("203.0.113.7");
      expect(clientIp(new Headers({ ...forged, "x-real-ip": "198.51.100.2" }))).toBe("203.0.113.7");
      expect(clientIp(new Headers({ [REMOTE_ADDR_HEADER]: "10.1.1.1", "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
      expect(clientIp(new Headers({ [REMOTE_ADDR_HEADER]: "10.1.1.1" }))).toBe("10.1.1.1");
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });

  it("behind nginx (loopback peer) uses the address nginx appended, without TRUST_PROXY", () => {
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const base = { [REMOTE_ADDR_HEADER]: peer };
      // The client forged the first X-Forwarded-For entry; nginx appended the real peer last.
      expect(clientIp(new Headers({ ...base, "x-forwarded-for": "6.6.6.6, 203.0.113.7" }))).toBe("203.0.113.7");
      expect(clientIp(new Headers({ ...base, "x-forwarded-for": "6.6.6.6, 203.0.113.7", "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    }
  });

  it("ignores a client-forged x-real-ip when nginx has not yet been told to overwrite it (the interim state)", () => {
    // nginx passes a client's X-Real-IP through until `proxy_set_header X-Real-IP` is installed; the last
    // X-Forwarded-For entry is nginx's own and wins, so nobody can burn a victim's authFail bucket.
    const h = new Headers({ [REMOTE_ADDR_HEADER]: "127.0.0.1", "x-real-ip": "198.51.100.99", "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
    expect(clientIp(h)).toBe("203.0.113.7");
    const victim = new Headers({ [REMOTE_ADDR_HEADER]: "127.0.0.1", "x-real-ip": "198.51.100.99", "x-forwarded-for": "203.0.113.7" });
    for (let i = 0; i < RATE_LIMITS.authFail.burst; i++) recordFailedAuth(victim);
    expect(failedAuthAllowed(new Headers({ [REMOTE_ADDR_HEADER]: "127.0.0.1", "x-forwarded-for": "198.51.100.99" })).ok).toBe(true);
  });

  it("with no proxy (dev, e2e) the socket address is the client", () => {
    expect(clientIp(new Headers({ [REMOTE_ADDR_HEADER]: "127.0.0.1" }))).toBe("127.0.0.1");
    expect(clientIp(new Headers({ [REMOTE_ADDR_HEADER]: "192.0.2.9" }))).toBe("192.0.2.9");
  });

  it("without a socket header falls back to the last x-forwarded-for entry, then x-real-ip, then unknown", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 1.2.3.4", "x-real-ip": "5.5.5.5" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-real-ip": "5.5.5.5" }))).toBe("5.5.5.5");
    expect(clientIp(new Headers())).toBe("unknown");
  });

  it("gives two client addresses behind the same proxy separate authFail buckets", () => {
    const via = (ip: string) => new Headers({ [REMOTE_ADDR_HEADER]: "127.0.0.1", "x-forwarded-for": `6.6.6.6, ${ip}` });
    const a = via("203.0.113.1");
    const b = via("203.0.113.2");
    for (let i = 0; i < RATE_LIMITS.authFail.burst; i++) recordFailedAuth(a);
    expect(failedAuthAllowed(a).ok).toBe(false);
    expect(failedAuthAllowed(b).ok).toBe(true);
    expect(failedAuthAllowed(b).remaining).toBe(RATE_LIMITS.authFail.burst);
  });
});

describe("rate limiting in handler()", () => {
  it("reports the budget on every response and refuses a read burst over the limit", async () => {
    const first = await send(me.GET, "GET", "/api/me", { token });
    expect(first.status).toBe(200);
    expect(first.headers.get("X-RateLimit-Limit")).toBe(String(RATE_LIMITS.read.burst));
    expect(first.headers.get("X-RateLimit-Remaining")).toBe(String(RATE_LIMITS.read.burst - 1));

    const rest = await Promise.all(Array.from({ length: 99 }, () => send(me.GET, "GET", "/api/me", { token })));
    const counts = statuses(rest);
    expect(counts[200]).toBe(RATE_LIMITS.read.burst - 1);
    expect(counts[429]).toBe(100 - RATE_LIMITS.read.burst);
    const refused = rest.find((r) => r.status === 429)!;
    expect(refused.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(refused.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining("Rate limit"), retryAfter: expect.any(Number) });
  });

  it("budgets are per token: another token is unaffected", async () => {
    for (let i = 0; i < RATE_LIMITS.read.burst; i++) await send(me.GET, "GET", "/api/me", { token });
    expect((await send(me.GET, "GET", "/api/me", { token })).status).toBe(429);
    expect((await send(me.GET, "GET", "/api/me", { token: otherToken })).status).toBe(200);
  });

  it("121 writes inside a minute from one token: the 121st is 429 with Retry-After, then the budget refills", async () => {
    const responses: Response[] = [];
    for (let i = 0; i < 121; i++) responses.push(await send(star.PUT, "PUT", `/api/documents/${docId}/star`, { token, id: docId }));
    expect(responses[0].status).toBe(200);
    expect(responses[0].headers.get("X-RateLimit-Limit")).toBe(String(RATE_LIMITS.write.burst));
    const last = responses[120];
    expect(last.status).toBe(429);
    expect(last.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(await last.json()).toMatchObject({ retryAfter: expect.any(Number) });
    expect(statuses(responses)).toEqual({ 200: RATE_LIMITS.write.burst, 429: 121 - RATE_LIMITS.write.burst });
    // The sustained rate: one more write every 500 ms.
    advance(500);
    expect((await send(star.PUT, "PUT", `/api/documents/${docId}/star`, { token, id: docId })).status).toBe(200);
    expect((await send(star.PUT, "PUT", `/api/documents/${docId}/star`, { token, id: docId })).status).toBe(429);
    // After a pause the bucket is full again.
    advance(60_000);
    const again = await send(star.PUT, "PUT", `/api/documents/${docId}/star`, { token, id: docId });
    expect(again.status).toBe(200);
    expect(again.headers.get("X-RateLimit-Remaining")).toBe(String(RATE_LIMITS.write.burst - 1));
  });

  it("refuses creating documents past the create budget, and does not create them", async () => {
    const db = await getDb();
    const before = (await db.select().from(schema.documents)).length;
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => send(documents.POST, "POST", "/api/documents", { token, body: { title: `Doc ${i}` } })));
    const counts = statuses(responses);
    expect(counts[201]).toBe(RATE_LIMITS.create.burst);
    expect(counts[429]).toBe(50 - RATE_LIMITS.create.burst);
    const after = (await db.select().from(schema.documents)).length;
    expect(after - before).toBe(RATE_LIMITS.create.burst);
  });

  it("locks out an IP after 30 wrong tokens in a minute, without touching the database", async () => {
    const bad = (i: number) => `mdk_${String(i).padStart(40, "0")}`;
    const attempts: Response[] = [];
    for (let i = 0; i < 31; i++) attempts.push(await send(me.GET, "GET", "/api/me", { token: bad(i), ip: "10.9.9.9" }));
    const counts = statuses(attempts);
    expect(counts[401]).toBe(RATE_LIMITS.authFail.burst);
    expect(counts[429]).toBe(1);
    const locked = attempts[30];
    expect(locked.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(await locked.json()).toMatchObject({ error: expect.stringContaining("authentication"), retryAfter: expect.any(Number) });
    // A valid token from the same IP is also refused until a failure token refills...
    expect((await send(me.GET, "GET", "/api/me", { token, ip: "10.9.9.9" })).status).toBe(429);
    // ...while another IP is unaffected.
    expect((await send(me.GET, "GET", "/api/me", { token: bad(99), ip: "10.9.9.10" })).status).toBe(401);
    advance(2_100);
    expect((await send(me.GET, "GET", "/api/me", { token, ip: "10.9.9.9" })).status).toBe(200);
  });

  it("RATE_LIMIT=off disables the limiter and its headers", async () => {
    process.env.RATE_LIMIT = "off";
    try {
      const responses = await Promise.all(Array.from({ length: 70 }, () => send(me.GET, "GET", "/api/me", { token })));
      expect(statuses(responses)).toEqual({ 200: 70 });
      expect(responses[0].headers.has("X-RateLimit-Remaining")).toBe(false);
    } finally {
      delete process.env.RATE_LIMIT;
    }
  });
});
