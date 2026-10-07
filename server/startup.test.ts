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

async function waitForStartup(child: ChildProcess, output: () => string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = output();
    if (log.includes("> Markdoc ready on ") && log.includes(NEXT_RUNTIME_READY)) return;
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
}

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
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("Custom server did not receive a PID");
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  try {
    await run({ port, child, output: () => output });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      if (!child.kill()) throw new Error(`Could not terminate custom server PID ${pid}`);
    }
    await waitForExit(child, 20_000);
    await assertPortFree(port);
    rmSync(path.resolve(distDir), { recursive: true, force: true });
  }
}

async function expectHealthy(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { connection: "close" },
    signal: AbortSignal.timeout(30_000),
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ ok: true, db: true, collab: true });
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
  it("initializes Next's Node AsyncLocalStorage before serving the readiness route", async () => {
    await withCustomServer(async ({ port, child, output }) => {
      await waitForStartup(child, output, 120_000);
      await expectHealthy(port);
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
});
