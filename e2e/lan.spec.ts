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

interface SocketRecord {
  path: string;
  frames: number;
  closed: boolean;
}

/** Sign in through the dev form on `base` and return the page plus the URL it landed on. */
async function signInAt(browser: Browser, base: string, login: string): Promise<{ page: Page; errors: string[]; sockets: SocketRecord[] }> {
  const context = await browser.newContext({ baseURL: base });
  const page = await context.newPage();
  const errors: string[] = [];
  const sockets: SocketRecord[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.request().method()} ${r.url()}`));
  page.on("websocket", (ws) => {
    const record = { path: new URL(ws.url()).pathname, frames: 0, closed: false };
    sockets.push(record);
    ws.on("framereceived", () => record.frames++);
    ws.on("close", () => (record.closed = true));
    ws.on("socketerror", (error) => errors.push(`WebSocket ${record.path}: ${error}`));
  });
  await page.goto("/login");
  await page.getByTestId("dev-login").fill(login);
  await page.getByTestId("dev-login-submit").click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.waitForLoadState("networkidle");
  return { page, errors, sockets };
}

async function editAndRead(page: Page, base: string, title: string, timeout = 30_000, openReader = true) {
  const created = await page.request.post("/api/documents", { data: { content: `# ${title}\n\nBody text.\n`, title } });
  expect(created.ok()).toBeTruthy();
  const { document } = (await created.json()) as { document: { id: string } };

  // The collaboration token and the WebSocket both go to the host the browser is on.
  const token = await page.request.post(`/api/documents/${document.id}/collab-token`);
  expect(token.status()).toBe(200);

  await page.goto(`/d/${document.id}`);
  const saveState = page.getByTestId("save-state");
  await expect(saveState).toHaveAttribute("data-state", "saved", { timeout });
  await expect(page.getByTestId("presence").getByTestId("presence-avatar")).toHaveCount(1);
  await page.locator(".md-rich").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" typed remotely");
  await expect(page.locator(".cm-content")).toContainText("typed remotely");
  await expect(saveState).toHaveAttribute("data-state", "saved", { timeout: 30_000 });

  if (openReader) {
    const reader = await page.goto(`/p/${document.id}`);
    expect(reader?.status()).toBe(200);
    expect(new URL(page.url()).host).toBe(new URL(base).host);
    await expect(page.getByTestId("reader-body").locator("h1")).toHaveText(title);
  }
  return document.id;
}

const sessionState = (page: Page) =>
  page.evaluate(() => {
    const session = (window as unknown as {
      __markdocSession: { status: string; synced: boolean; authError: string | null; ytext: { toString(): string } };
    }).__markdocSession;
    return { status: session.status, synced: session.synced, authError: session.authError, text: session.ytext.toString() };
  });

test.describe("LAN access", () => {
  test("signs in, edits and reads through the machine's LAN address", async ({ browser, baseURL }) => {
    const lan = lanAddress();
    test.skip(!lan, "no non-loopback IPv4 address on this machine");
    test.skip(!baseURL || new URL(baseURL).hostname !== "localhost", "the suite is not driving its own server");
    const base = withHost(baseURL!, lan!);

    const { page, errors, sockets } = await signInAt(browser, base, "lan-phone");
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

    sockets.length = 0;
    const openedAt = Date.now();
    const documentId = await editAndRead(page, base, "LAN doc", 10_000, false);
    const connectedMs = Date.now() - openedAt;
    expect(connectedMs, "LAN editor reaches saved within 10 seconds").toBeLessThanOrEqual(10_000);

    await expect.poll(() => sockets.some((socket) => socket.path === "/_next/hmr" && socket.frames > 0 && !socket.closed)).toBe(true);
    await expect.poll(() => sockets.some((socket) => socket.path === "/collab" && socket.frames > 0 && !socket.closed)).toBe(true);
    expect(await sessionState(page)).toMatchObject({ status: "connected", synced: true, authError: null });

    const tokens = Array.from({ length: 20 }, (_, index) => `LAN${String(index).padStart(2, "0")}`);
    await page.goto(`/d/${documentId}`);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 10_000 });
    await page.locator(".md-rich").click();
    await page.keyboard.press("Control+End");
    const saveStartedAt = Date.now();
    const saveTimeLeft = () => Math.max(1, 10_000 - (Date.now() - saveStartedAt));
    await page.keyboard.type(` ${tokens.join(" ")}`, { delay: 10 });
    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/documents/${documentId}/content`);
        if (!response.ok()) return false;
        const content = ((await response.json()) as { content: string }).content;
        return tokens.every((token) => content.split(token).length === 2);
      }, { timeout: saveTimeLeft() })
      .toBe(true);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: saveTimeLeft() });
    const saveMs = Date.now() - saveStartedAt;
    expect(saveMs, "20 tokens reach saved within 10 seconds").toBeLessThanOrEqual(10_000);

    await page.reload();
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 10_000 });
    const { text } = await sessionState(page);
    for (const token of tokens) expect(text.split(token)).toHaveLength(2);
    console.log(`[lan] connected ${connectedMs} ms; saved 20 tokens ${saveMs} ms`);

    const reader = await page.goto(`/p/${documentId}`);
    expect(reader?.status()).toBe(200);
    expect(new URL(page.url()).host).toBe(new URL(base).host);
    await expect(page.getByTestId("reader-body").locator("h1")).toHaveText("LAN doc");
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
