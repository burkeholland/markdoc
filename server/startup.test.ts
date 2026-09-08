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

describe("custom development server startup", () => {
  it("initializes Next's Node AsyncLocalStorage before serving the readiness route", async () => {
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
      await waitForStartup(child, () => output, 120_000);
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { connection: "close" },
        signal: AbortSignal.timeout(30_000),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true, db: true, collab: true });
      expect(output).toContain(NEXT_RUNTIME_READY);
      expect(output).not.toContain(ASYNC_LOCAL_STORAGE_INVARIANT);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        if (!child.kill()) throw new Error(`Could not terminate custom server PID ${pid}`);
      }
      await waitForExit(child, 20_000);
      await assertPortFree(port);
      rmSync(path.resolve(distDir), { recursive: true, force: true });
    }
  }, 180_000);
});
