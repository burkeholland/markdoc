import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.AUTH_SECRET_1;

const { proxy } = await import("@/proxy");
const { EMBED_SESSION_COOKIE, SESSION_COOKIE, SECURE_SESSION_COOKIE, STALE_SESSION_MESSAGE, findStaleSessionCookie, stripCookies, hasSessionCookie, logAuthError } = await import("@/server/session-cookie");

const OLD_SECRET = "old-secret-old-secret-old-secret-old";

function request(cookie?: string, extra: Record<string, string> = {}, path = "/") {
  const headers = new Headers(extra);
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(new URL(path, "http://localhost:3610"), { headers });
}

/** The Cookie header the route behind the proxy will see (Next carries overridden request headers in `x-middleware-request-*`). */
function forwardedCookie(res: Response): string | null {
  if (!res.headers.get("x-middleware-override-headers")) return "(unchanged)";
  return res.headers.get("x-middleware-request-cookie");
}

const setCookies = (res: Response) => res.headers.getSetCookie();

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("proxy: stale session cookie", () => {
  it("clears a garbage token, strips it from the forwarded request and warns once without a stack", async () => {
    const res = await proxy(request(`theme=dark; ${SESSION_COOKIE}=not-a-jwt`));
    expect(res.status).toBe(200);
    const cleared = setCookies(res);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(cleared[0]).toMatch(/Max-Age=0/i);
    expect(cleared[0]).toMatch(/Path=\//);
    expect(cleared[0]).not.toMatch(/Secure/);
    expect(forwardedCookie(res)).toBe("theme=dark");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(STALE_SESSION_MESSAGE);
    expect(String(warn.mock.calls[0][0])).not.toMatch(/\n\s+at /);
    expect(error).not.toHaveBeenCalled();
  });

  it("a token signed with a previous secret is the #1139 case: cleared with the reason", async () => {
    const token = await encode({ token: { sub: "u1" }, secret: OLD_SECRET, salt: SESSION_COOKIE });
    const res = await proxy(request(`${SESSION_COOKIE}=${token}`));
    expect(setCookies(res)).toHaveLength(1);
    expect(forwardedCookie(res)).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("no matching decryption secret");
  });

  it("the second request (cookie gone) is a no-op: nothing set, nothing logged", async () => {
    const res = await proxy(request("theme=dark"));
    expect(setCookies(res)).toHaveLength(0);
    expect(forwardedCookie(res)).toBe("(unchanged)");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("a valid session passes untouched", async () => {
    const token = await encode({ token: { sub: "u1", login: "burke" }, secret: process.env.AUTH_SECRET!, salt: SESSION_COOKIE });
    const res = await proxy(request(`${SESSION_COOKIE}=${token}`, { authorization: "Bearer mdk_notasessiontoken" }));
    expect(setCookies(res)).toHaveLength(0);
    expect(forwardedCookie(res)).toBe("(unchanged)");
    expect(warn).not.toHaveBeenCalled();
  });

  it("honours AUTH_SECRET_1 rotation: a token from the previous secret is still valid while it is listed", async () => {
    process.env.AUTH_SECRET_1 = OLD_SECRET;
    try {
      const token = await encode({ token: { sub: "u1" }, secret: OLD_SECRET, salt: SESSION_COOKIE });
      const res = await proxy(request(`${SESSION_COOKIE}=${token}`));
      expect(setCookies(res)).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      delete process.env.AUTH_SECRET_1;
    }
  });

  it("clears the __Secure- variant with the Secure attribute, and every chunk of a split token", async () => {
    const res = await proxy(request(`${SECURE_SESSION_COOKIE}.0=garbage; ${SECURE_SESSION_COOKIE}.1=more`));
    const cleared = setCookies(res);
    expect(cleared.map((c) => c.slice(0, c.indexOf("=")))).toEqual([`${SECURE_SESSION_COOKIE}.0`, `${SECURE_SESSION_COOKIE}.1`]);
    for (const c of cleared) expect(c).toMatch(/Secure/);
    expect(forwardedCookie(res)).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("an API bearer token without a session cookie is not mistaken for a session", async () => {
    const res = await proxy(request(undefined, { authorization: "Bearer mdk_notasessiontoken" }));
    expect(setCookies(res)).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("binds a valid embed session response to its canvas parent origin", async () => {
    const token = await encode({
      token: {
        sub: "u1",
        embedTokenId: "token-1",
        embedDocumentId: "doc-1",
        embedParentOrigin: "http://127.0.0.1:4749",
      },
      secret: process.env.AUTH_SECRET!,
      salt: EMBED_SESSION_COOKIE,
      maxAge: 300,
    });
    const cookie = `${EMBED_SESSION_COOKIE}=${token}`;
    const res = await proxy(request(cookie, {}, "/d/doc-1?embed=1"));
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors http://127.0.0.1:4749");
    expect(setCookies(res)).toHaveLength(0);

    const asset = await proxy(request(cookie, {}, "/api/assets/asset-1"));
    expect(asset.headers.get("content-security-policy")).toBeNull();
  });
});

describe("proxy: canonical host redirect", () => {
  const CANONICAL = "markdoc.example.com";
  const on = (host: string, path = "/", extra: Record<string, string> = {}) => request(undefined, { host, ...extra }, path);

  afterEach(() => {
    delete process.env.MARKDOC_CANONICAL_HOST;
  });

  it("unset: no redirect, and the request passes through unchanged", async () => {
    delete process.env.MARKDOC_CANONICAL_HOST;
    const res = await proxy(on("markdoc.old.azurecontainerapps.io", "/d/abc?x=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("empty string is unset", async () => {
    process.env.MARKDOC_CANONICAL_HOST = "";
    const res = await proxy(on("markdoc.old.azurecontainerapps.io"));
    expect(res.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });

  it("set + same host: no redirect", async () => {
    process.env.MARKDOC_CANONICAL_HOST = CANONICAL;
    const res = await proxy(on(CANONICAL, "/d/abc?x=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("set + different host GET: 308 to https://<canonical> with the path and query kept", async () => {
    process.env.MARKDOC_CANONICAL_HOST = CANONICAL;
    const res = await proxy(on("markdoc.old.azurecontainerapps.io", "/d/abc?x=1"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`https://${CANONICAL}/d/abc?x=1`);
    expect(warn).not.toHaveBeenCalled();
  });

  it("HEAD redirects like GET", async () => {
    process.env.MARKDOC_CANONICAL_HOST = CANONICAL;
    const res = await proxy(new NextRequest(new URL("/", "http://localhost:3610"), { method: "HEAD", headers: { host: "old.example" } }));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`https://${CANONICAL}/`);
  });

  it("set + different host POST: no redirect", async () => {
    process.env.MARKDOC_CANONICAL_HOST = CANONICAL;
    const res = await proxy(new NextRequest(new URL("/d/abc", "http://localhost:3610"), { method: "POST", headers: { host: "old.example" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("set + different host GET /api/*: no redirect (health probes and agents on the old URL keep working)", async () => {
    process.env.MARKDOC_CANONICAL_HOST = CANONICAL;
    for (const path of ["/api/health", "/api/mcp", "/api/documents/abc"]) {
      const res = await proxy(on("old.example", path));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  it("a WebSocket upgrade is never redirected", async () => {
    process.env.MARKDOC_CANONICAL_HOST = CANONICAL;
    const res = await proxy(on("old.example", "/collab", { upgrade: "websocket", connection: "Upgrade" }));
    expect(res.status).toBe(200);
  });

  it("x-forwarded-host wins over host", async () => {
    process.env.MARKDOC_CANONICAL_HOST = CANONICAL;
    const same = await proxy(on("old.example", "/", { "x-forwarded-host": CANONICAL }));
    expect(same.status).toBe(200);
    const other = await proxy(on(CANONICAL, "/", { "x-forwarded-host": "old.example, proxy.internal" }));
    expect(other.status).toBe(308);
    expect(other.headers.get("location")).toBe(`https://${CANONICAL}/`);
  });

  it("a :443 suffix and different case still equal the canonical host", async () => {
    process.env.MARKDOC_CANONICAL_HOST = CANONICAL;
    expect((await proxy(on(`${CANONICAL}:443`))).status).toBe(200);
    expect((await proxy(on(CANONICAL.toUpperCase()))).status).toBe(200);
    expect((await proxy(on("old.example:443"))).status).toBe(308);
  });

  it("no host header at all passes through", async () => {
    process.env.MARKDOC_CANONICAL_HOST = CANONICAL;
    const res = await proxy(new NextRequest(new URL("/", "http://localhost:3610")));
    expect(res.status).toBe(200);
  });

  it.each(["https://markdoc.example.com", "markdoc.example.com/", "markdoc.example.com:443", "mark doc.example", "user@markdoc.example.com"])(
    "invalid value %j: no redirect and exactly one [proxy][warn] line, then silence",
    async (value) => {
      process.env.MARKDOC_CANONICAL_HOST = value;
      expect((await proxy(on("old.example"))).status).toBe(200);
      expect((await proxy(on("old.example", "/d/abc"))).status).toBe(200);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/^\[proxy\]\[warn\] MARKDOC_CANONICAL_HOST/);
      expect(String(warn.mock.calls[0][0])).not.toContain(value);
      expect(String(warn.mock.calls[0][0])).not.toMatch(/\n\s+at /);
    },
  );

  it("the redirect runs before the stale-cookie logic and sets no cookies", async () => {
    process.env.MARKDOC_CANONICAL_HOST = CANONICAL;
    const res = await proxy(request(`${SESSION_COOKIE}=not-a-jwt`, { host: "old.example" }, "/"));
    expect(res.status).toBe(308);
    expect(setCookies(res)).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("session-cookie helpers", () => {
  it("hasSessionCookie / stripCookies", () => {
    expect(hasSessionCookie(null)).toBe(false);
    expect(hasSessionCookie("theme=dark; authjs.csrf-token=x")).toBe(false);
    expect(hasSessionCookie("theme=dark; __Secure-authjs.session-token.1=x")).toBe(true);
    expect(stripCookies("a=1; authjs.session-token=x; b=2", ["authjs.session-token"])).toBe("a=1; b=2");
    expect(stripCookies("authjs.session-token=x", ["authjs.session-token"])).toBe("");
  });

  it("findStaleSessionCookie returns null without a configured secret", async () => {
    expect(await findStaleSessionCookie(`${SESSION_COOKIE}=garbage`, [])).toBeNull();
  });
});

describe("logAuthError", () => {
  // Shaped like @auth/core's AuthError: the class name travels in `type`, the original error in `cause.err`,
  // and every message ends in Auth.js's "Read more" pointer.
  const authError = (type: string, message: string, err?: Error) =>
    Object.assign(new Error(`${message}. Read more at https://errors.authjs.dev#${type.toLowerCase()}`), { name: type, type, cause: err ? { err } : undefined });

  it("downgrades JWTSessionError to the one warn line and keeps other errors on console.error", () => {
    logAuthError(authError("JWTSessionError", "no matching decryption secret", new Error("no matching decryption secret")));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(`[auth][warn] ${STALE_SESSION_MESSAGE}`);
    expect(error).not.toHaveBeenCalled();

    logAuthError(authError("OAuthCallbackError", "bad state", new Error("bad state")));
    expect(error.mock.calls[0][0]).toContain("[auth][error] OAuthCallbackError: bad state");
    expect(error.mock.calls[1][0]).toContain("[auth][cause]");
  });

  // Task #988: the three expected events are one line each — no stack, no "Read more" pointer.
  it.each([
    ["JWTSessionError", "no matching decryption secret", `[auth][warn] ${STALE_SESSION_MESSAGE}`],
    ["MissingCSRF", "CSRF token was missing during an action signin", "[auth] MissingCSRF during signin (expected from the post-release check)"],
    ["UnknownAction", "Cannot parse action at /api/auth/wp-login.php", "[auth] UnknownAction: wp-login.php"],
  ])("%s is exactly one warn line and no stack", (type, message, line) => {
    logAuthError(authError(type, message, new Error(message)));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([line]);
    expect(line).not.toMatch(/\n|Read more/);
    expect(error).not.toHaveBeenCalled();
  });

  it("names the action only: MissingCSRF on other actions, every UnknownAction wording, long scanner paths cut short", () => {
    logAuthError(authError("MissingCSRF", "CSRF token was missing during an action signout"));
    logAuthError(authError("UnknownAction", "Cannot handle action: providers"));
    logAuthError(authError("UnknownAction", "Cannot parse action at /api/auth/signin/github/extra"));
    logAuthError(authError("UnknownAction", "Cannot parse action at /api/auth"));
    logAuthError(authError("UnknownAction", `Cannot parse action at /api/auth/${"x".repeat(200)}`));
    logAuthError(authError("UnknownAction", "Unsupported action"));
    expect(warn.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      "[auth] MissingCSRF during signout",
      "[auth] UnknownAction: providers",
      "[auth] UnknownAction: signin/github/extra",
      "[auth] UnknownAction: /",
      `[auth] UnknownAction: ${"x".repeat(80)}…`,
      "[auth] UnknownAction: Unsupported action",
    ]);
    expect(error).not.toHaveBeenCalled();
  });

  it("an error class outside the quiet set still prints the stack, with or without an Auth.js cause", () => {
    logAuthError(authError("OAuthCallbackError", "bad state", new Error("bad state")));
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(3);
    expect(error.mock.calls[0][0]).toContain("[auth][error] OAuthCallbackError: bad state");
    expect(error.mock.calls[1][0]).toBe("[auth][cause]:");
    expect(String(error.mock.calls[1][1])).toMatch(/\n\s+at /);
    expect(error.mock.calls[2][0]).toBe("[auth][details]:");

    error.mockClear();
    logAuthError(Object.assign(new Error("something new"), { type: "SomethingNew" }));
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0][0]).toBe("[auth][error] SomethingNew: something new");
    expect(String(error.mock.calls[1][0])).toMatch(/^\s+at /);
    expect(warn).not.toHaveBeenCalled();
  });
});
