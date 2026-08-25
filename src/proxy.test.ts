import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.AUTH_SECRET_1;

const { proxy } = await import("@/proxy");
const { SESSION_COOKIE, SECURE_SESSION_COOKIE, STALE_SESSION_MESSAGE, findStaleSessionCookie, stripCookies, hasSessionCookie, logAuthError } = await import("@/server/session-cookie");

const OLD_SECRET = "old-secret-old-secret-old-secret-old";

function request(cookie?: string, extra: Record<string, string> = {}) {
  const headers = new Headers(extra);
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest("http://localhost:3610/", { headers });
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
  // Shaped like @auth/core's AuthError: the class name travels in `type`, the original error in `cause.err`.
  const authError = (type: string, message: string, err?: Error) => Object.assign(new Error(message), { name: type, type, cause: err ? { err } : undefined });

  it("downgrades JWTSessionError to the one warn line and keeps other errors on console.error", () => {
    logAuthError(authError("JWTSessionError", "no matching decryption secret", new Error("no matching decryption secret")));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(`[auth][warn] ${STALE_SESSION_MESSAGE}`);
    expect(error).not.toHaveBeenCalled();

    logAuthError(authError("OAuthCallbackError", "bad state", new Error("bad state")));
    expect(error.mock.calls[0][0]).toContain("[auth][error] OAuthCallbackError: bad state");
    expect(error.mock.calls[1][0]).toContain("[auth][cause]");
  });
});
