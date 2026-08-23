import os from "node:os";
import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * The app must work when the browser reaches the server through a host other than localhost: a
 * phone on the LAN, or a colleague typing the machine name. The e2e webServer listens on 0.0.0.0,
 * so the same process is reachable on this machine's LAN address — the test swaps that host into
 * baseURL and signs in, edits and reads through it. Skipped when the machine has no LAN address.
 */

function lanAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const e of entries ?? []) {
      if (e.family === "IPv4" && !e.internal && !e.address.startsWith("169.254.")) return e.address;
    }
  }
  return null;
}

function withHost(baseURL: string, host: string): string {
  const url = new URL(baseURL);
  url.hostname = host;
  return url.toString().replace(/\/$/, "");
}

/** Sign in through the dev form on `base` and return the page plus the URL it landed on. */
async function signInAt(browser: Browser, base: string, login: string): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ baseURL: base });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.request().method()} ${r.url()}`));
  await page.goto("/login");
  await page.getByTestId("dev-login").fill(login);
  await page.getByTestId("dev-login-submit").click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.waitForLoadState("networkidle");
  return { page, errors };
}

async function editAndRead(page: Page, base: string, title: string) {
  const created = await page.request.post("/api/documents", { data: { content: `# ${title}\n\nBody text.\n`, title } });
  expect(created.ok()).toBeTruthy();
  const { document } = (await created.json()) as { document: { id: string } };

  // The collaboration token and the WebSocket both go to the host the browser is on.
  const token = await page.request.post(`/api/documents/${document.id}/collab-token`);
  expect(token.status()).toBe(200);

  await page.goto(`/d/${document.id}`);
  const saveState = page.getByTestId("save-state");
  await expect(saveState).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  await expect(page.getByTestId("presence").getByTestId("presence-avatar")).toHaveCount(1);
  await page.locator(".md-rich").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" typed remotely");
  await expect(page.locator(".cm-content")).toContainText("typed remotely");
  await expect(saveState).toHaveAttribute("data-state", "saved", { timeout: 30_000 });

  const reader = await page.goto(`/p/${document.id}`);
  expect(reader?.status()).toBe(200);
  expect(new URL(page.url()).host).toBe(new URL(base).host);
  await expect(page.getByTestId("reader-body").locator("h1")).toHaveText(title);
  return document.id;
}

test.describe("LAN access", () => {
  test("signs in, edits and reads through the machine's LAN address", async ({ browser, baseURL }) => {
    const lan = lanAddress();
    test.skip(!lan, "no non-loopback IPv4 address on this machine");
    test.skip(!baseURL || new URL(baseURL).hostname !== "localhost", "the suite is not driving its own server");
    const base = withHost(baseURL!, lan!);

    const { page, errors } = await signInAt(browser, base, "lan-phone");
    // Auth.js redirected to the host the client used, not the server's bind address.
    expect(new URL(page.url()).hostname).toBe(lan);
    expect(new URL(page.url()).hostname).not.toBe("0.0.0.0");

    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name.endsWith("session-token"));
    expect(session, "session cookie set for the LAN host").toBeTruthy();
    expect(session!.secure).toBe(false);
    expect(session!.domain).toBe(lan);

    const me = await page.request.get("/api/me");
    expect(me.status()).toBe(200);

    await editAndRead(page, base, "LAN doc");
    expect(errors, "no console errors or failed requests over the LAN host").toEqual([]);

    // The signed-in Auth.js endpoints also speak the LAN host.
    const providers = (await (await page.request.get("/api/auth/providers")).json()) as Record<string, { callbackUrl: string }>;
    expect(new URL(providers.dev.callbackUrl).hostname).toBe(lan);
    await page.context().close();
  });

  test("localhost still signs in and saves", async ({ browser, baseURL }) => {
    test.skip(!baseURL, "no baseURL");
    const { page, errors } = await signInAt(browser, baseURL!, "lan-local");
    expect(new URL(page.url()).hostname).toBe(new URL(baseURL!).hostname);
    await editAndRead(page, baseURL!, "Localhost doc");
    expect(errors).toEqual([]);
    await page.context().close();
  });
});
