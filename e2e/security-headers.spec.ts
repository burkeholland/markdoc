import { expect, test } from "./fixtures";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { createDocument, signIn } from "./helpers";

/**
 * Baseline security response headers (task #1224). server/index.ts stamps nosniff, Referrer-Policy and
 * Permissions-Policy on every response and Strict-Transport-Security only when the request arrived
 * over HTTPS (x-forwarded-proto from the Container Apps ingress); src/proxy.ts adds
 * `frame-ancestors 'none'` to every page except the embedded document, which keeps
 * `frame-ancestors <parentOrigin>` (asserted byte-for-byte in e2e/copilot-canvas.spec.ts). The e2e
 * server speaks plain HTTP, so HSTS must be absent here unless the ingress header is simulated.
 *
 * #2317: the same header says what a page may frame. A document's editor and published page may frame
 * the hosts on the link card list; every other page may frame nothing.
 */

const BASELINE: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
const FRAME_NONE = "frame-ancestors 'none'";
const NO_FRAMES = "frame-src 'none'";
const CARD_FRAMES = "frame-src https://www.youtube-nocookie.com https://platform.twitter.com";
const HSTS = "max-age=31536000";

function expectBaseline(res: APIResponse, label: string) {
  const headers = res.headers();
  for (const [name, value] of Object.entries(BASELINE)) expect(headers[name], `${label}: ${name}`).toBe(value);
  expect(headers["strict-transport-security"], `${label}: no HSTS over plain http`).toBeUndefined();
}

function expectPage(res: APIResponse, label: string, frames = NO_FRAMES) {
  expectBaseline(res, label);
  expect(res.headers()["content-security-policy"], `${label}: frame policy`).toBe(`${FRAME_NONE}; ${frames}`);
}

function expectNotPage(res: APIResponse, label: string) {
  expectBaseline(res, label);
  expect(res.headers()["content-security-policy"], `${label}: no frame policy`).toBeUndefined();
}

/** First /_next/static/chunks/*.js the login page's HTML references (dev and production name it differently). */
async function chunkReferencedByLogin(request: APIRequestContext): Promise<string> {
  const html = await (await request.get("/login")).text();
  const match = /(?:src|href)="(\/_next\/static\/chunks\/[^"]+?\.js(?:\?[^"]*)?)"/.exec(html);
  expect(match, "the login HTML references at least one /_next/static/chunks/*.js").not.toBeNull();
  return match![1];
}

test.describe("security response headers", () => {
  test("GET /login: the four baseline headers, frame-ancestors 'none', no HSTS over http", async ({ request }) => {
    const res = await request.get("/login");
    expect(res.status()).toBe(200);
    expectPage(res, "/login");
  });

  test("GET /api/health: baseline headers, no Content-Security-Policy on an API route", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    expectNotPage(res, "/api/health");
  });

  test("a /_next/static chunk referenced by /login carries nosniff (default and identity encodings), no CSP", async ({ request }) => {
    const chunk = await chunkReferencedByLogin(request);
    for (const [label, headers] of [
      ["default", {}],
      ["identity", { "accept-encoding": "identity" }],
    ] as const) {
      const res = await request.get(chunk, { headers });
      expect(res.status(), `${chunk} (${label})`).toBe(200);
      expect(res.headers()["content-type"], `${chunk} (${label})`).toMatch(/javascript/);
      expectNotPage(res, `${chunk} (${label})`);
    }
  });

  test("paths the proxy matcher skips still get the baseline from the server: /api/auth/session and favicon", async ({ request }) => {
    const session = await request.get("/api/auth/session");
    expect(session.status()).toBe(200);
    expectNotPage(session, "/api/auth/session");
    const favicon = await request.get("/favicon.ico");
    expect(favicon.status()).toBe(200);
    expectNotPage(favicon, "/favicon.ico");
  });

  test("an unknown page (404) is a page too", async ({ request }) => {
    const res = await request.get("/no-such-page-1224");
    expect(res.status()).toBe(404);
    expectPage(res, "/no-such-page-1224");
  });

  test("HSTS appears only when the request arrived over HTTPS (x-forwarded-proto from the ingress)", async ({ request }) => {
    for (const path of ["/login", "/api/health"]) {
      const forwarded = await request.get(path, { headers: { "x-forwarded-proto": "https" } });
      expect(forwarded.status(), path).toBe(200);
      expect(forwarded.headers()["strict-transport-security"], `${path} over forwarded https`).toBe(HSTS);
      // Anything else than https stays plain: an explicit http, or the header missing.
      const plain = await request.get(path, { headers: { "x-forwarded-proto": "http" } });
      expect(plain.status(), path).toBe(200);
      expect(plain.headers()["strict-transport-security"], `${path} over forwarded http`).toBeUndefined();
      const none = await request.get(path);
      expect(none.headers()["strict-transport-security"], `${path} without the header`).toBeUndefined();
    }
    // A comma-separated list (several proxies) is read by its first, client-facing hop. Checked on an API
    // route only: Auth.js builds a URL from the raw header value on pages and would log an Invalid URL error.
    const list = await request.get("/api/health", { headers: { "x-forwarded-proto": "http, https" } });
    expect(list.status()).toBe(200);
    expect(list.headers()["strict-transport-security"], "list led by http").toBeUndefined();
  });

  test("signed in: the dashboard, the editor and the reader refuse to be framed; the embed URL without its cookie does too", async ({ browser }) => {
    const user = await signIn(browser, "security-headers-user");
    try {
      const id = await createDocument(user.page, "# Headers\n\nBaseline security headers.\n", "Security headers");
      for (const path of ["/", `/d/${id}`, `/p/${id}`]) {
        const res = await user.page.request.get(path);
        expect(res.status(), path).toBe(200);
        expectPage(res, path, path === "/" ? NO_FRAMES : CARD_FRAMES);
      }
      // `?embed=1` without a valid embed cookie is not the embedded document: the page (here, for the
      // signed-in owner, the normal editor) carries 'none' and a canvas frame that lost its cookie is blocked.
      const embedWithoutCookie = await user.page.request.get(`/d/${id}?embed=1`);
      expect(embedWithoutCookie.status()).toBe(200);
      expectPage(embedWithoutCookie, `/d/${id}?embed=1 without the embed cookie`, CARD_FRAMES);
      // /api/assets sets nosniff itself and a sandboxing CSP on SVGs: the server's nosniff must not become a
      // second value (Playwright joins duplicates with ", ") and the proxy must not replace the route's CSP.
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
      const uploaded = await user.page.request.post(`/api/documents/${id}/assets?name=dot.svg`, { headers: { "Content-Type": "image/svg+xml" }, data: svg });
      expect(uploaded.status(), await uploaded.text()).toBe(201);
      const asset = await user.page.request.get(((await uploaded.json()) as { url: string }).url);
      expect(asset.status()).toBe(200);
      expectBaseline(asset, "/api/assets/<id>");
      expect(asset.headers()["content-security-policy"]).toBe("sandbox; script-src 'none'");
      // Signed-out, the same URL redirects to /login; both the 307 and the login page refuse framing, so the
      // frame shows the browser's blocked-frame placeholder instead of a login form inside a third-party frame.
      const signedOut = await browser.newContext();
      try {
        const redirect = await signedOut.request.get(`/d/${id}?embed=1`, { maxRedirects: 0 });
        expect(redirect.status()).toBe(307);
        expect(redirect.headers().location).toBe(`/login?next=${encodeURIComponent(`/d/${id}`)}`);
        expect(redirect.headers()["content-security-policy"]).toBe(`${FRAME_NONE}; ${CARD_FRAMES}`);
        const login = await signedOut.request.get(`/d/${id}?embed=1`);
        expect(login.status()).toBe(200);
        expect(login.url()).toContain("/login?next=");
        expectPage(login, "/login after the embed redirect");
      } finally {
        await signedOut.close();
      }
    } finally {
      await user.context.close();
    }
  });
});
