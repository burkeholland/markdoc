import { test, expect } from "@playwright/test";
import { encode } from "next-auth/jwt";
import { devLogin } from "./helpers";

/**
 * A browser still carrying a session cookie signed with a previous AUTH_SECRET (every rebuild
 * regenerates `.env.local`) used to make Auth.js log `JWTSessionError` on every request and light
 * up the dev error badge, while the cookie was never cleared (#1139). The proxy now expires it on
 * the first response and logs one warn line; the user just sees the signed-out landing page once.
 */

const SESSION_COOKIE = "authjs.session-token";

/** Issue count on Next's dev overlay badge (inside the `nextjs-portal` shadow root); 0 when there is no badge. */
async function overlayIssueCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const portal = document.querySelector("nextjs-portal");
    const count = portal?.shadowRoot?.querySelector("[data-issues-count]")?.textContent ?? "0";
    return Number(count) || 0;
  });
}

test.describe("stale session cookie", () => {
  test("a token from an old secret is cleared on the first response; no error badge; sign-in still works", async ({ browser, baseURL }) => {
    test.skip(!baseURL, "no baseURL");
    const host = new URL(baseURL!).hostname;
    const staleToken = await encode({ token: { sub: "ghost", login: "ghost" }, secret: "previous-secret-previous-secret-1", salt: SESSION_COOKIE });

    const context = await browser.newContext({ baseURL });
    await context.addCookies([{ name: SESSION_COOKIE, value: staleToken, domain: host, path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    // (Chromium does not expose Set-Cookie on navigation responses; the cookie jar below is the proof it was cleared.)
    // The signed-out landing page, not an error.
    await expect(page.getByRole("link", { name: /sign in with github/i }).first()).toBeVisible();
    await page.waitForLoadState("networkidle");

    // The browser dropped the cookie, so the next request carries none and the server has nothing to clear or log.
    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name.endsWith("session-token")), "stale session cookie gone").toBeUndefined();
    const second = await page.goto("/");
    expect(second?.status()).toBe(200);
    await page.waitForLoadState("networkidle");

    expect(await overlayIssueCount(page), "no issues on the Next dev overlay badge").toBe(0);
    expect(consoleErrors).toEqual([]);

    // A fresh sign-in from the same browser works and its cookie is left alone.
    await devLogin(page, "stale-cookie-user");
    const me = await page.request.get("/api/me");
    expect(me.status()).toBe(200);
    await page.goto("/");
    expect((await context.cookies()).some((c) => c.name.endsWith("session-token")), "valid session cookie kept").toBe(true);
    await context.close();
  });

  test("a garbage cookie on an API route is cleared too and the route answers as signed out", async ({ browser, baseURL }) => {
    test.skip(!baseURL, "no baseURL");
    const context = await browser.newContext({ baseURL });
    await context.addCookies([{ name: SESSION_COOKIE, value: "not-a-jwt", domain: new URL(baseURL!).hostname, path: "/" }]);
    const res = await context.request.get("/api/me");
    expect(res.status()).toBe(401);
    expect(res.headers()["set-cookie"] ?? "").toMatch(new RegExp(`${SESSION_COOKIE}=;`));
    expect((await context.cookies()).find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
    await context.close();
  });
});
