import os from "node:os";
import { isIP } from "node:net";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { stableHostnames } from "../scripts/lib/dev-origins.mjs";

/**
 * The app must work through the stable machine name rather than a DHCP-issued address. The e2e
 * server listens on 0.0.0.0, so this test swaps the machine name into baseURL and proves every
 * browser-owned auth/collaboration request stays on that origin through an edit and reload.
 */

function withHost(baseURL: string, host: string): string {
  const url = new URL(baseURL);
  url.hostname = host;
  return url.toString().replace(/\/$/, "");
}

interface SocketRecord {
  url: string;
  path: string;
  frames: number;
  closed: boolean;
}

interface RequestRecord {
  method: string;
  url: string;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Sign in through the dev form on `base` and return the page plus the URL it landed on. */
async function signInAt(
  browser: Browser,
  base: string,
  login: string,
): Promise<{ page: Page; errors: string[]; sockets: SocketRecord[]; requests: RequestRecord[] }> {
  const context = await browser.newContext({ baseURL: base });
  const page = await context.newPage();
  const errors: string[] = [];
  const sockets: SocketRecord[] = [];
  const requests: RequestRecord[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.request().method()} ${r.url()}`));
  page.on("websocket", (ws) => {
    const record = { url: ws.url(), path: new URL(ws.url()).pathname, frames: 0, closed: false };
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
  return { page, errors, sockets, requests };
}

async function editAndRead(page: Page, base: string, title: string, timeout = 30_000, openReader = true) {
  const created = await page.request.post("/api/documents", { data: { content: `# ${title}\n\nBody text.\n`, title } });
  expect(created.ok()).toBeTruthy();
  const { document } = (await created.json()) as { document: { id: string } };

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
  test("keeps auth, collaboration and persisted edits on the stable machine hostname", async ({ browser, baseURL }) => {
    test.skip(!baseURL, "no baseURL");
    const configured = new URL(baseURL!);
    const stableHost = (isLoopbackHost(configured.hostname) ? stableHostnames(os.hostname())[0] : configured.hostname).toLowerCase();
    test.skip(isIP(stableHost) !== 0 || isLoopbackHost(stableHost), "no stable non-loopback machine hostname");
    const base = isLoopbackHost(configured.hostname) ? withHost(baseURL!, stableHost) : baseURL!.replace(/\/$/, "");

    const { page, errors, sockets, requests } = await signInAt(browser, base, "lan-hostname");
    // Auth.js redirected to the host the client used, not the server's bind address.
    expect(new URL(page.url()).hostname).toBe(stableHost);
    expect(new URL(page.url()).hostname).not.toBe("0.0.0.0");

    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name.endsWith("session-token"));
    expect(session, "session cookie set for the stable host").toBeTruthy();
    expect(session!.secure).toBe(false);
    expect(session!.domain).toBe(stableHost);

    const authSessionStatus = await page.evaluate(async () => (await fetch("/api/auth/session")).status);
    expect(authSessionStatus).toBe(200);
    const authSessionHosts = requests
      .filter((request) => new URL(request.url).pathname === "/api/auth/session")
      .map((request) => new URL(request.url).hostname);
    expect(authSessionHosts).toContain(stableHost);

    sockets.length = 0;
    requests.length = 0;
    const openedAt = Date.now();
    const documentId = await editAndRead(page, base, "Stable hostname doc", 10_000, false);
    const connectedMs = Date.now() - openedAt;
    expect(connectedMs, "hostname editor reaches saved within 10 seconds").toBeLessThanOrEqual(10_000);

    await expect.poll(() => sockets.filter((socket) => socket.path === "/collab" && socket.frames > 0 && !socket.closed).length).toBe(1);
    await page.waitForTimeout(1_500);
    const tokenRequests = requests.filter(
      (request) => request.method === "POST" && new URL(request.url).pathname === `/api/documents/${documentId}/collab-token`,
    );
    expect(tokenRequests, "one browser collaboration-token request per editor load").toHaveLength(1);
    expect(new URL(tokenRequests[0].url).hostname).toBe(stableHost);
    const collabSockets = sockets.filter((socket) => socket.path === "/collab");
    expect(collabSockets, "exactly one collaboration WebSocket on the initial editor load").toHaveLength(1);
    expect(new URL(collabSockets[0].url).hostname).toBe(stableHost);
    expect(collabSockets[0].closed).toBe(false);
    expect(await sessionState(page)).toMatchObject({ status: "connected", synced: true, authError: null });

    const tokens = Array.from({ length: 20 }, (_, index) => `HOST${String(index).padStart(2, "0")}`);
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
    expect(sockets.filter((socket) => socket.path === "/collab").every((socket) => new URL(socket.url).hostname === stableHost)).toBe(true);
    console.log(
      `[stable-host] cookie domain=${session!.domain}; auth session host=${authSessionHosts.at(-1)}; token request host=${new URL(tokenRequests[0].url).hostname}; /collab host=${new URL(collabSockets[0].url).hostname}; edit persisted=true; reload=true; connected=${connectedMs}ms; saved=${saveMs}ms`,
    );

    const reader = await page.goto(`/p/${documentId}`);
    expect(reader?.status()).toBe(200);
    expect(new URL(page.url()).host).toBe(new URL(base).host);
    await expect(page.getByTestId("reader-body").locator("h1")).toHaveText("Stable hostname doc");
    expect(errors, "no console errors or failed requests over the stable host").toEqual([]);

    // The signed-in Auth.js endpoints also speak the LAN host.
    const providers = (await (await page.request.get("/api/auth/providers")).json()) as Record<string, { callbackUrl: string }>;
    expect(new URL(providers.dev.callbackUrl).hostname).toBe(stableHost);
    await page.context().close();
  });

  test("localhost still signs in and saves", async ({ browser, baseURL }) => {
    test.skip(!baseURL || !isLoopbackHost(new URL(baseURL).hostname), "no localhost server");
    const { page, errors } = await signInAt(browser, baseURL!, "lan-local");
    expect(new URL(page.url()).hostname).toBe(new URL(baseURL!).hostname);
    await editAndRead(page, baseURL!, "Localhost doc");
    expect(errors).toEqual([]);
    await page.context().close();
  });
});
