import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test, expect } from "./fixtures";
import type { Browser, Page } from "@playwright/test";
import WebSocket from "ws";
import { e2eDistDir, removeDistDir } from "./dist-dir";
import { devLogin, reloadHydrated } from "./helpers";

/**
 * A server restart while the user types (#190, the browser side of a zero-downtime promote, #577).
 *
 * The suite's shared webServer keeps its database in memory and is used by every other spec, so this
 * spec drives a server of its own on a free port with a file-backed PGlite directory: it is killed by
 * pid mid-typing and started again with the same environment. The editor must reconnect within a few
 * seconds of `/api/health` answering again, flush every keystroke typed during the outage, and a reload
 * must show the same text — nothing lost, nothing doubled.
 */

const TOKENS_BEFORE_KILL = 8;
const TOKENS_BEFORE_RESPAWN = 12;
const TOKENS_TOTAL = 50;
const TOKENS_AFTER_HEALTH = 6;
const ALL_TOKENS = Array.from({ length: TOKENS_TOTAL + TOKENS_AFTER_HEALTH }, (_, i) => `RSTRT${String(i).padStart(2, "0")}`);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

interface OwnServer {
  port: number;
  baseURL: string;
  dataDir: string;
  distDir: string;
  child: ChildProcess | null;
  log: string[];
}

const TSX_CLI = path.resolve("node_modules", "tsx", "dist", "cli.mjs");

/** Start `server/index.ts` on the spec's port; resolves once the process is running (not yet healthy). */
function startServer(server: OwnServer): ChildProcess {
  const child = spawn(process.execPath, [TSX_CLI, "server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(server.port),
      HOST: "127.0.0.1",
      AUTH_SECRET: "e2e-restart-secret-e2e-restart-secret",
      AUTH_DEV_LOGIN: "1",
      PGLITE_DATA_DIR: server.dataDir,
      NEXT_DIST_DIR: server.distDir,
      RATE_LIMIT: "off",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const tail = (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      server.log.push(line);
      if (server.log.length > 200) server.log.shift();
    }
  };
  child.stdout?.on("data", tail);
  child.stderr?.on("data", tail);
  server.child = child;
  return child;
}

/** Kill the server the way a crash or a deploy does: the whole process tree, no graceful shutdown. */
function killServer(server: OwnServer) {
  const child = server.child;
  server.child = null;
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  // tsx runs the script in a child node process; on Windows `kill()` would only end the parent.
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

async function waitForHealth(baseURL: string, timeoutMs: number): Promise<number> {
  const started = Date.now();
  let last = "no response";
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (res.status === 200) return Date.now() - started;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`GET ${baseURL}/api/health did not return 200 within ${timeoutMs} ms (last: ${last})`);
}

async function waitForReadyLog(server: OwnServer, from: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.log.slice(from).some((line) => line.includes("> Markdoc ready on "))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not report readiness within ${timeoutMs} ms\n--- server log ---\n${server.log.slice(from).join("\n")}`);
}

async function expectWebSocketOnlyReady(baseURL: string) {
  const url = `${baseURL.replace(/^http/, "ws")}/collab`;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`${url} did not open without an HTTP warm-up`));
    }, 5_000);
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.close();
      resolve();
    });
    socket.once("unexpected-response", (_req, response) => {
      clearTimeout(timeout);
      socket.terminate();
      reject(new Error(`${url} returned HTTP ${response.statusCode} without an HTTP warm-up`));
    });
    socket.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Installs a MutationObserver that records every `data-state` the save-state pill goes through. */
async function recordSaveStates(page: Page) {
  await page.evaluate(() => {
    type Win = Window & { __saveStates?: string[] };
    const w = window as Win;
    w.__saveStates = [];
    const started = performance.now();
    const record = () => {
      const el = document.querySelector('[data-testid="save-state"]');
      const state = el?.getAttribute("data-state") ?? "<missing>";
      const list = w.__saveStates!;
      const last = list[list.length - 1]?.split("@")[0];
      if (last !== state) list.push(`${state}@${Math.round(performance.now() - started)}`);
    };
    record();
    new MutationObserver(record).observe(document.body, { subtree: true, attributes: true, childList: true, attributeFilter: ["data-state"] });
  });
}

const saveStates = (page: Page) => page.evaluate(() => (window as Window & { __saveStates?: string[] }).__saveStates ?? []);

/** The shared Markdown text as the live session holds it (the code pane only renders the viewport). */
const paneText = (page: Page) =>
  page.evaluate(() => (window as unknown as { __markdocSession: { ytext: { toString(): string } } }).__markdocSession.ytext.toString());

/** From inside the page: can a brand-new WebSocket and a fetch reach the server right now? */
const probeFromPage = (page: Page) =>
  page.evaluate(async () => {
    const started = performance.now();
    const ws = await new Promise<string>((resolve) => {
      const sock = new WebSocket(`${location.origin.replace(/^http/, "ws")}/collab`);
      const timer = setTimeout(() => {
        resolve(`raw ws still CONNECTING after 4000 ms (readyState ${sock.readyState})`);
        sock.close();
      }, 4_000);
      sock.onopen = () => {
        clearTimeout(timer);
        resolve(`raw ws open after ${Math.round(performance.now() - started)} ms`);
        sock.close();
      };
      sock.onerror = () => {
        clearTimeout(timer);
        resolve(`raw ws error after ${Math.round(performance.now() - started)} ms`);
      };
    });
    const t1 = performance.now();
    const health = await fetch("/api/health").then((r) => `fetch /api/health ${r.status} in ${Math.round(performance.now() - t1)} ms`, (e) => `fetch failed: ${String(e)}`);
    return `${ws} · ${health}`;
  });

function countTokens(text: string): { present: number; doubled: string[] } {
  let present = 0;
  const doubled: string[] = [];
  for (const token of ALL_TOKENS) {
    const n = text.split(token).length - 1;
    if (n >= 1) present++;
    if (n > 1) doubled.push(token);
  }
  return { present, doubled };
}

async function signInAt(browser: Browser, baseURL: string, login: string) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await devLogin(page, login);
  return { context, page };
}

test.describe("server restart while typing", () => {
  // Two cold starts of a dev server with a fresh dist dir plus the typing: well beyond the suite's 90 s.
  test.describe.configure({ timeout: 10 * 60_000 });

  const server: OwnServer = { port: 0, baseURL: "", dataDir: "", distDir: "", child: null, log: [] };

  test.beforeAll(async () => {
    server.port = await freePort();
    server.baseURL = `http://127.0.0.1:${server.port}`;
    server.dataDir = mkdtempSync(path.join(os.tmpdir(), "markdoc-restart-"));
    server.distDir = `${e2eDistDir()}-restart-${server.port}`;
    const logStart = server.log.length;
    startServer(server);
    await waitForReadyLog(server, logStart, 240_000);
    await expectWebSocketOnlyReady(server.baseURL);
    await waitForHealth(server.baseURL, 240_000).catch((err) => {
      throw new Error(`${err instanceof Error ? err.message : String(err)}\n--- server log ---\n${server.log.join("\n")}`);
    });
  });

  test.afterAll(async () => {
    const child = server.child;
    killServer(server);
    if (child) await waitForExit(child, 10_000);
    removeDistDir(server.distDir, "restart-spec");
    rmSync(server.dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });

  test("edits typed across a restart reach the server and survive a reload", async ({ browser }) => {
    // Keep the two-cold-start scenario opt-in for the regular suite; targeted restart verification enables it.
    test.skip(!process.env.RESTART_SPEC, "set RESTART_SPEC=1 to run the slow restart scenario");
    const { context, page } = await signInAt(browser, server.baseURL, "restart-typist");
    try {
      const created = await page.request.post("/api/documents", {
        data: { title: "Restart", content: `# Restart\n\n${"The quick brown fox jumps over the lazy dog. ".repeat(200)}\n` },
      });
      expect(created.ok()).toBeTruthy();
      const docId = ((await created.json()) as { document: { id: string } }).document.id;

      // Warm the editor route before the timed part (a cold Turbopack compile takes a while).
      await page.goto(`/d/${docId}`);
      const saveState = page.getByTestId("save-state");
      await expect(saveState).toHaveAttribute("data-state", "saved", { timeout: 180_000 });
      await expect(page.locator(".cm-content")).toBeVisible();
      await recordSaveStates(page);
      const t0 = Date.now();
      const at = () => Date.now() - t0;
      // Every WebSocket the page opens from here on, with its fate: Chromium lets only one handshake per
      // host:port be pending at a time, so a socket that never settles blocks all later ones.
      const sockets: { url: string; opened: number; fate: string }[] = [];
      page.on("websocket", (ws) => {
        const entry = { url: ws.url().replace(/^ws:\/\/[^/]+/, ""), opened: at(), fate: "pending" };
        sockets.push(entry);
        ws.on("framereceived", () => {
          if (entry.fate === "pending") entry.fate = `open@${at()}`;
        });
        ws.on("close", () => {
          entry.fate = `${entry.fate === "pending" ? "failed" : entry.fate + " closed"}@${at()}`;
        });
        ws.on("socketerror", (e) => {
          entry.fate = `error(${e})@${at()}`;
        });
      });

      await page.locator(".cm-content").click();
      await page.keyboard.press("Control+End");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");

      let killedAt = 0;
      let respawnedAt = 0;
      // Next's dev HMR client reloads the page when the dev server comes back; keystrokes sent while
      // no editor exists are not a product bug, so every token waits for the pane (production never reloads).
      const reloads: number[] = [];
      page.on("load", () => reloads.push(at()));
      const waitForToken = async (token: string, timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (await paneText(page).then((text) => text.includes(token), () => false)) return true;
          await page.waitForTimeout(100);
        }
        return false;
      };
      const typeToken = async (token: string) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (reloads.length > 0) {
            await page.locator(".cm-content").waitFor({ timeout: 60_000 });
            await page.waitForFunction(() => Boolean((window as unknown as { __markdocSession?: unknown }).__markdocSession), undefined, { timeout: 60_000 });
            if (!(await page.locator(".cm-content").evaluate((el) => el.contains(document.activeElement)))) {
              await page.locator(".cm-content").click();
              await page.keyboard.press("Control+End");
            }
          }
          if (await waitForToken(token, 100)) return;
          await page.keyboard.type(`${token} `, { delay: 15 });
          if (await waitForToken(token, 1_500)) return;
        }
        throw new Error(`${token} was not inserted while the editor reloaded`);
      };
      for (let i = 0; i < TOKENS_TOTAL; i++) {
        await typeToken(ALL_TOKENS[i]);
        if (i + 1 === TOKENS_BEFORE_KILL) {
          killServer(server);
          killedAt = at();
        }
        if (i + 1 === TOKENS_BEFORE_RESPAWN) {
          startServer(server);
          respawnedAt = at();
        }
        await page.waitForTimeout(120);
      }
      expect(killedAt).toBeGreaterThan(0);
      expect(respawnedAt).toBeGreaterThan(0);

      const healthMs = await waitForHealth(server.baseURL, 240_000);
      const healthAt = at();
      // Give the dev HMR client its reload (if it takes one) before the last tokens go in.
      await page.waitForTimeout(2_000);
      for (let i = TOKENS_TOTAL; i < TOKENS_TOTAL + TOKENS_AFTER_HEALTH; i++) {
        await typeToken(ALL_TOKENS[i]);
        await page.waitForTimeout(120);
      }

      // The reconnect must follow the server within a few seconds, not the provider's 30 s backoff cap.
      const savedDeadline = 10_000 + TOKENS_AFTER_HEALTH * 300;
      const diagnostics = async () =>
        [
          `kill@${killedAt} respawn@${respawnedAt} health@${healthAt} (${healthMs} ms after the poll started) · page reloads@${reloads.join(",") || "none"}`,
          `save-state timeline: ${(await saveStates(page)).join(" ")}`,
          `probe: ${await probeFromPage(page)}`,
          `sockets: ${sockets.map((s) => `${s.url}@${s.opened}→${s.fate}`).join(" ")}`,
          `provider: ${JSON.stringify(
            await page.evaluate(() => {
              type Win = Window & {
                __markdocSession?: {
                  status: string;
                  synced: boolean;
                  unsyncedChanges: number;
                  authError: string | null;
                  restarts: number;
                  provider: { configuration: { websocketProvider: { status: string; shouldConnect: boolean; webSocket: { readyState: number; url: string } | null } } };
                };
              };
              const s = (window as Win).__markdocSession;
              if (!s) return null;
              const ws = s.provider.configuration.websocketProvider;
              return {
                status: s.status,
                synced: s.synced,
                unsynced: s.unsyncedChanges,
                authError: s.authError,
                restarts: s.restarts,
                wsStatus: ws.status,
                shouldConnect: ws.shouldConnect,
                readyState: ws.webSocket?.readyState ?? null,
                url: ws.webSocket?.url ?? null,
              };
            }),
          )}`,
        ].join("\n");
      try {
        await expect(saveState).toHaveAttribute("data-state", "saved", { timeout: savedDeadline });
      } catch (err) {
        throw new Error(`save-state did not return to "saved" within ${savedDeadline} ms of the server being healthy\n${await diagnostics()}\n${String(err)}`);
      }

      const local = countTokens(await paneText(page));
      expect(local.present, "every typed token is in the pane").toBe(ALL_TOKENS.length);
      expect(local.doubled, "no token was applied twice locally").toEqual([]);

      const onServer = await page.request.get(`/api/documents/${docId}/content`);
      expect(onServer.ok()).toBeTruthy();
      const remote = countTokens(((await onServer.json()) as { content: string }).content);
      expect(remote.present, `every typed token reached the server\n${await diagnostics()}`).toBe(ALL_TOKENS.length);
      expect(remote.doubled, "no token reached the server twice").toEqual([]);

      // The respawned server is healthy and saved by now, so this reload is a normal page load.
      await reloadHydrated(page);
      await expect(page.locator(".cm-content")).toBeVisible();
      await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
      const reloaded = countTokens(await paneText(page));
      expect(reloaded.present, "every typed token is there after a reload").toBe(ALL_TOKENS.length);
      expect(reloaded.doubled, "no token doubled after a reload").toEqual([]);
    } finally {
      await context.close();
    }
  });
});
