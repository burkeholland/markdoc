import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";

const NEXT_RUNTIME_READY = "> Next Node AsyncLocalStorage available";
const ASYNC_LOCAL_STORAGE_INVARIANT = "Invariant: AsyncLocalStorage accessed in runtime where it is not available";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`Server PID ${child.pid ?? "unknown"} did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("exit", onExit);
  });
}

async function waitForStartup(child: ChildProcess, output: () => string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = output();
    if (log.includes("> Markdoc ready on ") && log.includes(NEXT_RUNTIME_READY)) return Date.now();
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server exited before readiness (code ${child.exitCode}, signal ${child.signalCode})\n${log.slice(-4_000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become ready within ${timeoutMs} ms\n${output().slice(-4_000)}`);
}

function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
}

interface StartedServer {
  port: number;
  child: ChildProcess;
  output: () => string;
  /** Prints the size of the owned set, then fires the server's own SIGTERM handler (Windows cannot send a signal to a child; the probe listens on stdin). */
  requestStop: () => void;
}

/** One line per websocket upgrade, written by the probe before the listeners run: how many listeners the server has. */
const UPGRADE_LISTENERS_LINE = "> [test] upgrade listeners ";

/** Written by the probe when the stop is requested: how many upgrade sockets the server's own set holds. */
const OWNED_SOCKETS_LINE = "> [test] owned upgrade sockets ";

/** Starts `server/index.ts` as its own process on a free loopback port; stops it and cleans up when `run` settles. */
async function withCustomServer(run: (server: StartedServer) => Promise<void>): Promise<void> {
  const port = await freePort();
  const distDir = `.next-e2e-startup-${process.pid}-${port}`;
  const configHome = path.resolve(distDir, "config");
  const probe = [
    `const marker = ${JSON.stringify(NEXT_RUNTIME_READY)};`,
    "const observer = setInterval(() => {",
    "  if (typeof globalThis.AsyncLocalStorage === 'function') {",
    "    console.log(marker);",
    "    clearInterval(observer);",
    "  }",
    "}, 10);",
    "observer.unref();",
    "const { Server } = await import('node:http');",
    "const emit = Server.prototype.emit;",
    "Server.prototype.emit = function (event, ...args) {",
    `  if (event === 'upgrade') console.log(${JSON.stringify(UPGRADE_LISTENERS_LINE)} + this.listenerCount('upgrade'));`,
    "  return emit.call(this, event, ...args);",
    "};",
    "process.stdin.once('data', async () => {",
    "  const guards = await import('./server/request-guards.ts');",
    `  console.log(${JSON.stringify(OWNED_SOCKETS_LINE)} + guards.ownedUpgradeSockets?.size);`,
    "  process.emit('SIGTERM', 'SIGTERM');",
    "});",
    "await import('./server/index.ts');",
  ].join("\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APPDATA: configHome,
    HOME: configHome,
    LOCALAPPDATA: configHome,
    USERPROFILE: configHome,
    XDG_CONFIG_HOME: configHome,
    PORT: String(port),
    HOST: "127.0.0.1",
    AUTH_SECRET: "startup-test-secret-startup-test-secret",
    AUTH_DEV_LOGIN: "1",
    DATABASE_URL: "",
    PGLITE_DATA_DIR: "memory://",
    NEXT_DIST_DIR: distDir,
    RATE_LIMIT: "off",
    GITHUB_MOCK: "1",
    NEXT_TELEMETRY_DEBUG: "",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "development",
  };
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", probe], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("Custom server did not receive a PID");
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  try {
    await run({ port, child, output: () => output, requestStop: () => void child.stdin?.write("stop\n") });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      if (!child.kill()) throw new Error(`Could not terminate custom server PID ${pid}`);
    }
    await waitForExit(child, 20_000);
    await assertPortFree(port);
    rmSync(path.resolve(distDir), { recursive: true, force: true });
  }
}

async function expectHealthy(port: number, since?: number): Promise<number> {
  const startedAt = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { connection: "close" },
    signal: AbortSignal.timeout(30_000),
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ ok: true, db: true, collab: true });
  return Date.now() - (since ?? startedAt);
}

/** The answer `server/index.ts` gives a websocket upgrade until it is ready. */
const STARTING_UPGRADE_ANSWER = "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/**
 * Websocket clients that leave, from the first moment the port listens: one upgrade request every
 * 10 ms, taking turns to (0) reset the connection once the answer arrived, (1) reset it right after
 * sending, (2) close it right after sending, (3) wait for the whole answer. Four in a row ask for the
 * collaboration path, the next four for another path: the start-up answer is the same for every path.
 * `stop()` ends the stream of new clients and drops the ones still open.
 */
function leavingWebSocketClients(port: number) {
  const seen = { answered: 0, resetAfterAnswer: 0, resetAtOnce: 0, closedAtOnce: 0, otherPathLeft: 0, patientAnswers: [] as string[] };
  const open = new Set<net.Socket>();
  let turn = 0;
  const timer = setInterval(() => {
    const n = turn++;
    const kind = n % 4;
    const otherPath = n % 8 >= 4;
    let received = "";
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.write(`GET ${otherPath ? "/_next/webpack-hmr" : "/collab"} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
      if (kind === 1) {
        seen.resetAtOnce += 1;
        if (otherPath) seen.otherPathLeft += 1;
        setImmediate(() => socket.resetAndDestroy());
      } else if (kind === 2) {
        seen.closedAtOnce += 1;
        if (otherPath) seen.otherPathLeft += 1;
        setImmediate(() => socket.destroy());
      }
    });
    open.add(socket);
    socket.setEncoding("latin1");
    socket.on("data", (text: string) => {
      if (received === "" && text.startsWith("HTTP/1.1 503")) seen.answered += 1;
      received += text;
      if (kind === 0 && text.startsWith("HTTP/1.1 503")) {
        seen.resetAfterAnswer += 1;
        socket.resetAndDestroy();
      }
    });
    socket.on("end", () => {
      if (kind === 3 && received.startsWith("HTTP/1.1 503")) seen.patientAnswers.push(received);
      socket.end();
    });
    // Refused before the port listens, reset by our own hand afterwards.
    socket.on("error", () => {});
    socket.on("close", () => open.delete(socket));
  }, 10);
  return {
    seen,
    stop() {
      clearInterval(timer);
      for (const socket of open) socket.destroy();
    },
  };
}

describe("custom development server startup", () => {
  it("warms the full readiness route before logging ready", async () => {
    await withCustomServer(async ({ port, child, output }) => {
      const readyAt = await waitForStartup(child, output, 120_000);
      const firstHealthResponseMs = await expectHealthy(port, readyAt);
      process.stderr.write(`> [test] first health response after ready: ${firstHealthResponseMs} ms\n`);
      expect(firstHealthResponseMs, "first /api/health response after ready").toBeLessThan(1_000);
      expect(output()).toContain(NEXT_RUNTIME_READY);
      expect(output()).not.toContain(ASYNC_LOCAL_STORAGE_INVARIANT);
    });
  }, 180_000);

  // Issue #2311: open editor pages reconnect while a new server starts, and give up sockets that wait
  // too long. Until the server is ready it answers each upgrade with a 503 on a raw socket; a client
  // that had left made that answer an uncaughtException, and the process exited 1 before "ready".
  it("starts while websocket clients reset or close their upgrade requests, answering 503 until it is ready", async () => {
    await withCustomServer(async ({ port, child, output }) => {
      const clients = leavingWebSocketClients(port);
      try {
        // Throws with the server's output if the process exits before it reports readiness.
        await waitForStartup(child, output, 120_000);
      } finally {
        clients.stop();
      }
      // A late socket error would end the process a moment after "ready".
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(child.exitCode).toBeNull();
      expect(output()).not.toContain("uncaughtException");
      await expectHealthy(port);
      // The start-up window was really exercised: upgrades were answered, and clients left around the answer.
      const { seen } = clients;
      expect(seen.answered).toBeGreaterThan(0);
      expect(seen.resetAfterAnswer).toBeGreaterThan(0);
      expect(seen.resetAtOnce + seen.closedAtOnce).toBeGreaterThan(0);
      expect(seen.otherPathLeft).toBeGreaterThan(0);
      expect(seen.patientAnswers.length).toBeGreaterThan(0);
      for (const answer of seen.patientAnswers) expect(answer).toBe(STARTING_UPGRADE_ANSWER);
    });
  }, 180_000);

  // Issue #2328: an upgrade on a path that is not the collaboration path was left without an answer,
  // and its socket stayed open after the client had closed. The stop then waited for it until the
  // deadline and exited 1 with the database still open. Development keeps Next's own upgrade listener
  // (HMR), so here such a socket is still left open while the server runs; the stop must close it.
  it("keeps Next's HMR socket and its upgrade listeners, and stops with exit code 0 although upgrade sockets were left open", async () => {
    await withCustomServer(async ({ port, child, output, requestStop }) => {
      const held: net.Socket[] = [];
      /** One raw upgrade; resolves with the first line of the answer ("" when none came within `waitMs`). */
      const upgrade = (target: string, leave: "hold" | "close", waitMs = 5_000) =>
        new Promise<string>((resolve) => {
          let received = "";
          const done = () => {
            clearTimeout(giveUp);
            if (leave === "close") socket.destroy();
            resolve(received.split("\r\n")[0]);
          };
          const giveUp = setTimeout(done, waitMs);
          const socket = net.connect({ host: "127.0.0.1", port, allowHalfOpen: true }, () => {
            socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
          });
          held.push(socket);
          socket.setEncoding("latin1");
          socket.on("data", (text: string) => {
            received += text;
            if (received.includes("\r\n")) done();
          });
          socket.on("error", () => {});
        });
      const listenerCounts = () => output().split(/\r?\n/).filter((line) => line.startsWith(UPGRADE_LISTENERS_LINE)).map((line) => line.slice(UPGRADE_LISTENERS_LINE.length));
      try {
        // While the server starts: clients that take the 503 and then keep their side open for good.
        let startingAnswers = 0;
        while (!output().includes("> Markdoc ready on ") && child.exitCode === null) {
          const answer = await upgrade(startingAnswers % 2 ? "/collab" : "/_next/hmr", "hold", 500);
          if (answer === "HTTP/1.1 503 Service Unavailable") startingAnswers += 1;
          // Refused before the port listens, or answered by the ready server in the last moment: not held.
          else held[held.length - 1]?.destroy();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await waitForStartup(child, output, 120_000);
        expect(startingAnswers).toBeGreaterThan(0);
        const ready = Date.now();
        const upgradesWhileStarting = listenerCounts().length;
        // Before any HTTP request: Next's listener is there already, and answers its HMR path.
        expect(await upgrade("/_next/hmr?id=before-any-request", "close")).toBe("HTTP/1.1 101 Switching Protocols");
        // The first request, several more, and a page that does not exist (Next renders its error page).
        await expectHealthy(port);
        for (let i = 0; i < 5; i++) await expectHealthy(port);
        const missing = await fetch(`http://127.0.0.1:${port}/no-such-page-2328`, { headers: { connection: "close" }, signal: AbortSignal.timeout(90_000) });
        expect(missing.status).toBe(404);
        await missing.text();
        // Afterwards: HMR and the collaboration path still answer, each from its own listener.
        expect(await upgrade("/_next/hmr?id=after-requests", "hold")).toBe("HTTP/1.1 101 Switching Protocols");
        // The 503 sockets of the start-up get 2 s; the stop below must not find them any more.
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, ready + 2_500 - Date.now())));
        // A collaboration socket that is open at the stop: it is closed by the collaboration shutdown.
        expect(await upgrade("/collab", "hold")).toBe("HTTP/1.1 101 Switching Protocols");
        // A path nobody answers: in development Next leaves it open, also after the client has closed.
        expect(await upgrade("/other", "close", 300)).toBe("");
        const stopRequested = Date.now();
        requestStop();
        await waitForExit(child, 15_000);
        const stopMs = Date.now() - stopRequested;
        const log = output();
        const line = (prefix: string) => log.split(/\r?\n/).find((text) => text.startsWith(prefix))?.slice(prefix.length) ?? null;
        expect({
          // The remembering listener, Next's listener and the collaboration router: three, before the
          // first request and after the last. A fourth would be Next's own, added again outside the filter.
          listenersPerUpgrade: listenerCounts().slice(upgradesWhileStarting),
          // The held HMR socket and the one Next left open. Not the 503 sockets (gone after 2 s), and
          // not the collaboration socket: it is never in the set, its own shutdown closes it.
          ownedAtStop: line(OWNED_SOCKETS_LINE),
          closedAtStop: line("> [exit] shutdown closed websocket upgrade sockets that were still open: "),
          exitCode: child.exitCode,
          withinTheDeadline: stopMs < 9_000,
          summary: line("> [exit] shutdown "),
          complete: line("> [exit] shutdown complete: "),
          failed: line("> [exit] shutdown failed: "),
          uncaught: log.includes("uncaughtException"),
        }).toEqual({
          listenersPerUpgrade: ["3", "3", "3", "3"],
          ownedAtStop: "2",
          closedAtStop: "2",
          exitCode: 0,
          withinTheDeadline: true,
          summary: "started: trigger=SIGTERM deadline=10000ms",
          complete: "trigger=SIGTERM intake=ok publishing=ok collaboration=ok database=ok deadline=ok",
          failed: null,
          uncaught: false,
        });
      } finally {
        for (const socket of held) socket.destroy();
      }
    });
  }, 240_000);
});
