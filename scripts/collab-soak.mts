// Collaboration soak: many headless Hocuspocus writers against a real dev server. Prints one report
// block per scenario (convergence, sync latency + server memory, reconnect storm, offline merge,
// crash durability, read-only clients under load) and a summary table. Every headless editor runs in this
// one Node process, so each block also shows the server's and this process's CPU and the response time of
// GET /api/health from a separate probe process: a slow number can be attributed to the server or the rig.
// No product code is touched; findings go to the lead.
//
//   npm run soak:collab                                  # spawns its own dev server on :3270, runs everything
//   SOAK_SCENARIOS=1,3 SOAK_N=5,20 npm run soak:collab   # a subset (1 = convergence + latency + memory)
//   BASE_URL=http://localhost:3270 npm run soak:collab   # drive a server you started yourself (no crash scenario,
//                                                        # no stderr count; SOAK_SERVER_PID=<pid> enables memory samples)
//
// Environment / knobs (all optional):
//   SOAK_PORT          port for the spawned server (default 3270; never 3000/3001/3100)
//   SOAK_DATA_DIR      PGlite directory for the spawned server, outside the repo (default ../markdoc-data/collab-soak-<port>/pglite);
//                      the crash scenario restarts the server against it. Deleted at the end unless SOAK_KEEP_DATA=1.
//   SOAK_DIST_DIR      NEXT_DIST_DIR for the spawned server (default .next-soak; removed at the end)
//   SOAK_SCENARIOS     comma list of 1..6 (default all; 2 is measured by 1)
//   SOAK_N             writer counts for scenarios 1/2 (default 5,20,50)
//   SOAK_TYPING_MS     typing duration for scenarios 1/2/6 (default 60000), SOAK_OP_INTERVAL_MS per client (default 100)
//   SOAK_USERS         distinct (one dev-login user per client, default) | single (one user, N tabs); scenario 1 at
//                      N=20 also runs the other model once for comparison (SOAK_COMPARE_USERS=0 skips that)
//   SOAK_MEM_AFTER_MS  how long to watch the server's working set after all clients left (default 60000)
//   SOAK_TIME_SCALE    multiplies the fixed waits of scenarios 3–5 (storm 10 s + 30 s, offline 20 s, kill at 30 s);
//                      0.2 for a quick dry run
//   SOAK_AUTH_SECRET   AUTH_SECRET for the spawned server (default: the e2e harness's value)
//
// The server is started the way the e2e harness does (playwright.config.ts: AUTH_DEV_LOGIN, GITHUB_MOCK, RATE_LIMIT=off,
// a private NEXT_DIST_DIR), except for the on-disk PGlite directory. Clients log in with the dev login form
// (POST /api/auth/callback/dev), create the document through the API, fetch one collab token per client and connect
// exactly like src/server/collab.test.ts (HocuspocusProviderWebsocket + HocuspocusProvider over `ws`).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { promisify } from "node:util";
import WebSocket from "ws";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket, WebSocketStatus } from "@hocuspocus/provider";
import { COLLAB_PATH } from "../src/server/collab/ws";
import { TEXT_KEY } from "../src/server/collab/seed";
import { revertTsconfigChurn } from "./tsconfig-churn";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => performance.now();
const fmt = (n: number, digits = 1) => (Number.isFinite(n) ? n.toFixed(digits) : "n/a");
const mb = (bytes: number | null | undefined) => (bytes == null ? "n/a" : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const thousands = (n: number) => n.toLocaleString("en-US");
/** yes / NO / "unknown" when the server could not be read. */
const yn = (v: boolean | null | undefined) => (v == null ? "unknown (HTTP failed)" : v ? "yes" : "NO");

// ---------------------------------------------------------------------------------------------
// Configuration

const env = process.env;
const externalBase = env.BASE_URL?.replace(/\/$/, "");
const port = Number(env.SOAK_PORT ?? 3270);
if (!externalBase && [3000, 3001, 3100].includes(port)) {
  console.error(`[soak] SOAK_PORT=${port} is reserved (live server / recovery editor / e2e suite); pick another port`);
  process.exit(2);
}
const base = externalBase ?? `http://localhost:${port}`;
const wsUrl = `${base.replace(/^http/, "ws")}${COLLAB_PATH}`;
const repoRoot = process.cwd();
const dataDir = path.resolve(env.SOAK_DATA_DIR ?? path.join(repoRoot, "..", "markdoc-data", `collab-soak-${port}`, "pglite"));
const distDir = env.SOAK_DIST_DIR ?? ".next-soak";
const scenarios = new Set((env.SOAK_SCENARIOS ?? "1,2,3,4,5,6").split(",").map((s) => s.trim()).filter(Boolean));
const writerCounts = (env.SOAK_N ?? "5,20,50").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
const typingMs = Number(env.SOAK_TYPING_MS ?? 60_000);
const opIntervalMs = Number(env.SOAK_OP_INTERVAL_MS ?? 100);
const userModel: UserModel = env.SOAK_USERS === "single" ? "single" : "distinct";
const compareUsers = env.SOAK_COMPARE_USERS !== "0";
const memAfterMs = Number(env.SOAK_MEM_AFTER_MS ?? 60_000);
/** SOAK_TIME_SCALE=0.2 shortens the fixed waits of scenarios 3–5 for a quick dry run. */
const timeScale = Number(env.SOAK_TIME_SCALE ?? 1);
const scaled = (ms: number) => Math.max(500, Math.round(ms * timeScale));
const keepData = env.SOAK_KEEP_DATA === "1";
const isWindows = process.platform === "win32";

type UserModel = "distinct" | "single";

if (path.resolve(dataDir).startsWith(repoRoot + path.sep)) {
  console.error(`[soak] SOAK_DATA_DIR must be outside the repository (got ${dataDir})`);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// Dev server (spawned unless BASE_URL is given)

interface LogLine {
  at: number;
  line: string;
}

class DevServer {
  child: ChildProcess | null = null;
  pid: number | null = externalBase ? (env.SOAK_SERVER_PID ? Number(env.SOAK_SERVER_PID) : null) : null;
  readonly stderr: LogLine[] = [];
  readonly stdout: LogLine[] = [];
  starts = 0;
  private logDir = path.dirname(dataDir);

  get managed() {
    return !externalBase;
  }

  async start(): Promise<number> {
    if (!this.managed) {
      await waitForHealth(60_000);
      return 0;
    }
    mkdirSync(dataDir, { recursive: true });
    this.starts += 1;
    const t0 = now();
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      PORT: String(port),
      HOST: "127.0.0.1",
      AUTH_SECRET: env.SOAK_AUTH_SECRET ?? "e2e-secret-e2e-secret-e2e-secret-e2e",
      AUTH_DEV_LOGIN: "1",
      GITHUB_MOCK: "1",
      RATE_LIMIT: "off",
      NEXT_DIST_DIR: distDir,
      PGLITE_DATA_DIR: dataDir,
      NODE_ENV: "development",
    };
    // Never let a real database leak into the soak server.
    delete childEnv.DATABASE_URL;
    delete childEnv.DATABASE_SSL;
    // `node --import tsx` runs server/index.ts in this very process (the tsx CLI would spawn a child and the
    // PID we record, kill and sample would be the wrapper's).
    const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.pid = child.pid ?? null;
    const logFile = path.join(this.logDir, `server-${this.starts}.log`);
    const capture = (stream: NodeJS.ReadableStream, sink: LogLine[], tag: string) => {
      let rest = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        rest += chunk;
        const parts = rest.split(/\r?\n/);
        rest = parts.pop() ?? "";
        for (const line of parts) {
          sink.push({ at: now(), line });
          try {
            writeFileSync(logFile, `${tag} ${line}\n`, { flag: "a" });
          } catch {
            /* log file is best effort */
          }
        }
      });
    };
    capture(child.stdout!, this.stdout, "out");
    capture(child.stderr!, this.stderr, "err");
    const exited = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => reject(new Error(`server exited during startup (code ${code}, signal ${signal}); see ${logFile}`)));
    });
    await Promise.race([waitForHealth(240_000), exited]);
    child.removeAllListeners("exit");
    const ms = now() - t0;
    console.log(`[server] pid ${this.pid} ready on ${base} after ${fmt(ms / 1000)} s (log ${logFile})`);
    return ms;
  }

  /** `taskkill /PID <pid> /F` (Windows) / SIGKILL: the process dies mid-write, nothing is flushed. */
  async killHard(): Promise<number> {
    if (!this.child || !this.pid) throw new Error("no spawned server to kill");
    const child = this.child;
    const t0 = now();
    const gone = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
    });
    if (isWindows) await execFileAsync("taskkill", ["/PID", String(this.pid), "/F"]).catch(() => child.kill());
    else child.kill("SIGKILL");
    await Promise.race([gone, sleep(10_000)]);
    this.child = null;
    return now() - t0;
  }

  async stop(): Promise<void> {
    if (!this.managed || !this.child) return;
    await this.killHard();
  }

  stderrSince(mark: number): string[] {
    return this.stderr.filter((l) => l.at >= mark && l.line.trim() !== "").map((l) => l.line);
  }
}

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = now() + timeoutMs;
  let lastError = "";
  while (now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.status === 200) {
        const body = (await res.json()) as { ok?: boolean; db?: boolean };
        if (body.ok && body.db) return;
      }
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(500);
  }
  throw new Error(`server at ${base} not healthy after ${timeoutMs} ms (${lastError})`);
}

interface Health {
  documentsLoaded: number;
  connections: number;
  latencyMs: number;
}

async function health(): Promise<Health> {
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10_000) });
  if (res.status !== 200) throw new Error(`GET /api/health -> ${res.status}`);
  return (await res.json()) as Health;
}

// ---------------------------------------------------------------------------------------------
// Process metrics: working set of the server, CPU of the machine, event-loop lag of this client process

async function workingSetBytes(pid: number): Promise<number | null> {
  try {
    if (isWindows) {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], { windowsHide: true });
      const n = Number(stdout.trim());
      return Number.isFinite(n) ? n : null;
    }
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

async function cpuPercent(): Promise<number | null> {
  try {
    if (isWindows) {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples[0].CookedValue"],
        { windowsHide: true },
      );
      const n = Number(stdout.trim());
      return Number.isFinite(n) ? n : null;
    }
    const { stdout } = await execFileAsync("sh", ["-c", "top -bn2 -d1 | grep '^%Cpu' | tail -1 | awk '{print 100-$8}'"]);
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

class MemorySampler {
  readonly samples: { at: number; bytes: number }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private readonly pid: number | null,
    private readonly everyMs = 5000,
  ) {}

  async sampleOnce(): Promise<number | null> {
    if (!this.pid) return null;
    const bytes = await workingSetBytes(this.pid);
    if (bytes != null) this.samples.push({ at: now(), bytes });
    return bytes;
  }

  start() {
    if (!this.pid || this.timer) return;
    void this.sampleOnce();
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void this.sampleOnce().finally(() => (this.busy = false));
    }, this.everyMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  peak(since = 0): { at: number; bytes: number } | null {
    let best: { at: number; bytes: number } | null = null;
    for (const s of this.samples) if (s.at >= since && (!best || s.bytes > best.bytes)) best = s;
    return best;
  }
}

/** CPU time consumed so far by a process (all threads), in ms. */
async function processCpuMs(pid: number): Promise<number | null> {
  try {
    if (isWindows) {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`], { windowsHide: true });
      const n = Number(stdout.trim());
      return Number.isFinite(n) ? n : null;
    }
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[11]) + Number(fields[12]); // utime + stime, 100 Hz
    return Number.isFinite(ticks) ? ticks * 10 : null;
  } catch {
    return null;
  }
}

/**
 * Who is busy: CPU of the server process and of this client process over a window, as % of one core
 * (the client hosts every headless editor in one Node process, so a saturated client inflates latency
 * numbers that are not the server's fault; a saturated server is the finding).
 */
class CpuMeter {
  private wallStart = now();
  private clientStart = process.cpuUsage();
  private serverStart: number | null = null;

  constructor(private readonly pid: number | null) {}

  async start() {
    this.serverStart = this.pid ? await processCpuMs(this.pid) : null;
    this.clientStart = process.cpuUsage();
    this.wallStart = now();
  }

  async stop(): Promise<CpuWindow> {
    const wallMs = now() - this.wallStart;
    const c = process.cpuUsage(this.clientStart);
    const serverEnd = this.pid ? await processCpuMs(this.pid) : null;
    return {
      wallMs,
      clientPct: ((c.user + c.system) / 1000 / wallMs) * 100,
      serverPct: serverEnd != null && this.serverStart != null ? ((serverEnd - this.serverStart) / wallMs) * 100 : null,
    };
  }
}

interface CpuWindow {
  wallMs: number;
  clientPct: number;
  serverPct: number | null;
}

const cpuLine = (c: CpuWindow) => `process CPU over ${fmt(c.wallMs / 1000, 0)} s (% of one core): server ${c.serverPct == null ? "n/a" : fmt(c.serverPct, 0)} % · this client process ${fmt(c.clientPct, 0)} %`;

/**
 * Server responsiveness measured from a *separate* Node process: GET /api/health once a second and
 * record the response time. Because it does not share this script's event loop, a slow or timed-out
 * probe means the server's event loop is busy, whatever the headless clients are doing.
 */
class HealthProbe {
  static readonly active = new Set<HealthProbe>();
  readonly samples: { at: number; ms: number | null }[] = [];
  private child: ChildProcess | null = null;

  start() {
    if (this.child) return;
    HealthProbe.active.add(this);
    const script = `
      const url = process.argv[1];
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      (async () => {
        for (;;) {
          const t = Date.now();
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
            await res.arrayBuffer();
            console.log(res.status === 200 ? Date.now() - t : "error");
          } catch {
            console.log("timeout");
          }
          await sleep(1000);
        }
      })();`;
    this.child = spawn(process.execPath, ["-e", script, `${base}/api/health`], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let buffer = "";
    this.child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const ms = Number(line);
        this.samples.push({ at: now(), ms: Number.isFinite(ms) ? ms : null });
      }
    });
  }

  stop(): { n: number; p50: number; max: number; failed: number } {
    this.child?.kill();
    this.child = null;
    HealthProbe.active.delete(this);
    const ok = this.samples.filter((s) => s.ms != null).map((s) => s.ms as number);
    const p = percentiles(ok);
    return { n: this.samples.length, p50: p.p50, max: p.max, failed: this.samples.length - ok.length };
  }
}

const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
const loopLagMs = () => ({ p50: loopDelay.percentile(50) / 1e6, p99: loopDelay.percentile(99) / 1e6, max: loopDelay.max / 1e6 });

// ---------------------------------------------------------------------------------------------
// HTTP sessions (one cookie jar per dev-login user)

class Session {
  private jar = new Map<string, string>();
  constructor(readonly login: string) {}

  private remember(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /max-age=0/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async call(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(`${base}${pathname}`, { ...init, headers, redirect: init.redirect ?? "manual", signal: init.signal ?? AbortSignal.timeout(60_000) });
    this.remember(res);
    return res;
  }

  async json<T>(method: string, pathname: string, body?: unknown, okStatuses = [200, 201, 202]): Promise<T> {
    const res = await this.call(pathname, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!okStatuses.includes(res.status)) throw new Error(`${method} ${pathname} -> ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  async signIn(): Promise<void> {
    const csrf = await this.call("/api/auth/csrf");
    if (csrf.status !== 200) throw new Error(`GET /api/auth/csrf -> ${csrf.status}; is the server up at ${base}?`);
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    await this.call("/api/auth/callback/dev", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken, login: this.login, redirect: "false" }),
    });
    const me = await this.call("/api/me");
    if (me.status !== 200) throw new Error(`dev login as ${this.login} failed (GET /api/me -> ${me.status}); does the server have AUTH_DEV_LOGIN set?`);
    const { user } = (await me.json()) as { user: { login: string | null } };
    if (user.login !== this.login) throw new Error(`signed in as ${user.login}, expected ${this.login}`);
  }

  collabToken(docId: string) {
    return this.json<{ token: string; role: string }>("POST", `/api/documents/${docId}/collab-token`);
  }
}

const sessions = new Map<string, Session>();
async function sessionFor(login: string): Promise<Session> {
  let s = sessions.get(login);
  if (!s) {
    s = new Session(login);
    await s.signIn();
    sessions.set(login, s);
  }
  return s;
}

/** Sign in N users a few at a time (each first request may compile a route in dev). */
async function signInAll(logins: string[], concurrency = 5): Promise<Session[]> {
  const out: Session[] = new Array(logins.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, logins.length) }, async () => {
      while (next < logins.length) {
        const i = next++;
        out[i] = await sessionFor(logins[i]);
      }
    }),
  );
  return out;
}

const SEED = `# Collaboration soak\n\n${Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog while ${i + 1} editors type at once.\n`).join("")}\n`;

async function createSharedDocument(owner: Session, editors: Session[], viewers: Session[]): Promise<string> {
  const { document } = await owner.json<{ document: { id: string } }>("POST", "/api/documents", { content: SEED });
  for (const s of editors) if (s !== owner) await owner.json("POST", `/api/documents/${document.id}/collaborators`, { login: s.login, role: "editor" });
  for (const s of viewers) await owner.json("POST", `/api/documents/${document.id}/collaborators`, { login: s.login, role: "viewer" });
  return document.id;
}

async function serverText(session: Session, docId: string): Promise<string> {
  const { content } = await session.json<{ content: string }>("GET", `/api/documents/${docId}/content`);
  return content;
}

// ---------------------------------------------------------------------------------------------
// Headless clients

interface Op {
  /** Sender's Yjs clock after the insert: an observer has this op once its state for the sender reaches it. */
  clock: number;
  sentAt: number;
  marker: string;
}

/** Classify one Hocuspocus wire message (see src/server/collab.test.ts); `applied` is the sync-status payload. */
function describeMessage(data: ArrayBuffer | Uint8Array): { type: string; applied?: boolean } {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let i = 0;
  let nameLength = 0;
  let shift = 0;
  for (;;) {
    const b = bytes[i++];
    nameLength |= (b & 0x7f) << shift;
    if (b < 0x80) break;
    shift += 7;
  }
  i += nameLength;
  const kind = bytes[i];
  if (kind === 0) return { type: ["sync-step1", "sync-step2", "update"][bytes[i + 1]] ?? "sync-?" };
  if (kind === 8) return { type: "sync-status", applied: bytes[i + 1] === 1 };
  return { type: ({ 1: "awareness", 2: "auth", 3: "query-awareness", 5: "stateless", 7: "close" } as Record<number, string>)[kind] ?? `type-${kind}` };
}

type ChunkMode = "random" | "marker";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789    ,.";

/** Every client not yet destroyed, so a failed scenario can be torn down before the next one starts. */
const liveClients = new Set<SoakClient>();

class SoakClient {
  readonly ydoc = new Y.Doc();
  readonly text = this.ydoc.getText(TEXT_KEY);
  readonly socket: HocuspocusProviderWebsocket;
  readonly provider: HocuspocusProvider;
  readonly ops: Op[] = [];
  /** Latency samples (ms) for ops of other clients, as observed here. */
  readonly latencies: number[] = [];
  private nextOp = new Map<SoakClient, number>();
  observedOps = 0;
  lastRemoteUpdateAt = 0;
  remoteUpdates = 0;
  syncStatusFalse = 0;
  syncStatusTrue = 0;
  messages = 0;
  syncedAt: number | null = null;
  syncedCount = 0;
  authFailed: string | null = null;
  closes: { at: number; code?: number; reason?: string }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  peers: SoakClient[] = [];

  constructor(
    readonly index: number,
    readonly login: string,
    readonly role: string,
    docId: string,
    token: string,
    readonly tag: string,
  ) {
    this.socket = new HocuspocusProviderWebsocket({ url: wsUrl, WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket });
    this.provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: docId,
      document: this.ydoc,
      token,
      onMessage: ({ message }) => {
        this.messages += 1;
        const described = describeMessage((message as unknown as { data: ArrayBuffer | Uint8Array }).data);
        if (described.type === "sync-status") {
          if (described.applied) this.syncStatusTrue += 1;
          else this.syncStatusFalse += 1;
        }
      },
      onSynced: () => {
        this.syncedAt = now();
        this.syncedCount += 1;
      },
      onAuthenticationFailed: ({ reason }) => {
        this.authFailed = reason;
      },
      onClose: ({ event }) => {
        this.closes.push({ at: now(), code: (event as { code?: number })?.code, reason: (event as { reason?: string })?.reason });
      },
    });
    this.ydoc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin !== this.provider) return;
      const t = now();
      this.lastRemoteUpdateAt = t;
      this.remoteUpdates += 1;
      for (const peer of this.peers) {
        if (peer === this) continue;
        let i = this.nextOp.get(peer) ?? 0;
        if (i >= peer.ops.length) continue;
        const clock = Y.getState(this.ydoc.store, peer.ydoc.clientID);
        while (i < peer.ops.length && peer.ops[i].clock <= clock) {
          this.latencies.push(t - peer.ops[i].sentAt);
          this.observedOps += 1;
          i += 1;
        }
        this.nextOp.set(peer, i);
      }
    });
    // Presence like the editor: one awareness state per client, a caret that moves with every op.
    this.provider.awareness!.setLocalStateField("user", { id: login, name: login, login, role, color: "#3b82f6" });
    this.provider.attach();
    liveClients.add(this);
  }

  get synced() {
    return this.provider.isSynced;
  }

  waitSynced(timeoutMs = 30_000): Promise<number> {
    const t0 = now();
    return new Promise((resolve, reject) => {
      if (this.provider.isSynced) return resolve(0);
      const timer = setTimeout(() => {
        this.provider.off("synced", onSynced);
        reject(new Error(`client ${this.tag} not synced after ${timeoutMs} ms (authFailed=${this.authFailed}, closes=${this.closes.length})`));
      }, timeoutMs);
      const onSynced = () => {
        clearTimeout(timer);
        this.provider.off("synced", onSynced);
        resolve(now() - t0);
      };
      this.provider.on("synced", onSynced);
    });
  }

  /** Insert one chunk. `random`: 1–8 random characters anywhere. `marker`: a unique 6-char marker + newline at a line start. */
  typeOnce(mode: ChunkMode) {
    let pos: number;
    let chunk: string;
    if (mode === "random") {
      const len = 1 + Math.floor(Math.random() * 8);
      chunk = Array.from({ length: len }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
      pos = Math.floor(Math.random() * (this.text.length + 1));
    } else {
      chunk = `${this.marker(this.seq)}\n`;
      const current = this.text.toString();
      const starts = [0];
      for (let i = 0; i < current.length; i++) if (current[i] === "\n" && i + 1 < current.length) starts.push(i + 1);
      if (current.length > 0 && current.endsWith("\n")) starts.push(current.length);
      pos = starts[Math.floor(Math.random() * starts.length)];
    }
    this.seq += 1;
    this.text.insert(pos, chunk);
    this.provider.awareness!.setLocalStateField("cursor", { pos: pos + chunk.length });
    this.ops.push({ clock: Y.getState(this.ydoc.store, this.ydoc.clientID), sentAt: now(), marker: mode === "marker" ? chunk.trimEnd() : chunk });
  }

  marker(seq: number) {
    return `${this.tag}${seq.toString(36).padStart(3, "0")}`;
  }

  startTyping(mode: ChunkMode, intervalMs = opIntervalMs) {
    this.stopTyping();
    this.timer = setInterval(() => this.typeOnce(mode), intervalMs);
  }

  stopTyping() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Go offline and stay offline. `socket.disconnect()` alone is not enough when the *server* dropped the
   * socket (crash scenario): the provider's onClose has already armed a 1 s reconnect timer, and its
   * connect() flips `shouldConnect` back on — a "parked" client would then silently reconnect to the
   * restarted server and replay its state into what the script reads as "persisted". While parked,
   * connect() on this socket instance is a no-op; reconnect() restores the prototype method.
   */
  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      Object.defineProperty(this.socket, "connect", { value: async () => undefined, configurable: true, writable: true });
      if (this.socket.status !== WebSocketStatus.Connected) {
        this.socket.disconnect();
        return resolve();
      }
      const done = () => {
        clearTimeout(timeout);
        this.socket.off("disconnect", done);
        resolve();
      };
      const timeout = setTimeout(done, 5000);
      this.socket.on("disconnect", done);
      this.socket.disconnect();
    });
  }

  reconnect() {
    delete (this.socket as unknown as { connect?: unknown }).connect;
    void this.socket.connect();
  }

  destroy() {
    this.stopTyping();
    this.provider.destroy();
    this.socket.destroy();
    liveClients.delete(this);
  }
}

interface Group {
  docId: string;
  owner: Session;
  writers: SoakClient[];
  viewers: SoakClient[];
  all: SoakClient[];
}

/** N writers (+ read-only viewers) on a fresh document, all synced. */
async function openGroup(n: number, model: UserModel, label: string, viewerCount = 0): Promise<Group> {
  const t0 = now();
  const logins = model === "distinct" ? Array.from({ length: n }, (_, i) => `soak-${label}-w${i}`) : [`soak-${label}-w0`];
  const viewerLogins = Array.from({ length: viewerCount }, (_, i) => `soak-${label}-v${i}`);
  const [writerSessions, viewerSessions] = await Promise.all([signInAll(logins), signInAll(viewerLogins)]);
  const owner = writerSessions[0];
  const docId = await createSharedDocument(owner, writerSessions, viewerSessions);
  const tokens: { token: string; role: string }[] = new Array(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, n) }, async () => {
      while (next < n) {
        const i = next++;
        tokens[i] = await (model === "distinct" ? writerSessions[i] : owner).collabToken(docId);
      }
    }),
  );
  const viewerTokens = await Promise.all(viewerSessions.map((s) => s.collabToken(docId)));
  const writers = tokens.map((t, i) => new SoakClient(i, model === "distinct" ? logins[i] : `${logins[0]}#${i}`, t.role, docId, t.token, `w${i.toString(36).padStart(2, "0")}`));
  const viewers = viewerTokens.map((t, i) => new SoakClient(n + i, viewerLogins[i], t.role, docId, t.token, `r${i.toString(36).padStart(2, "0")}`));
  const all = [...writers, ...viewers];
  for (const c of all) c.peers = writers;
  await Promise.all(all.map((c) => c.waitSynced()));
  console.log(
    `  setup: ${n} writer(s)${viewerCount ? ` + ${viewerCount} viewer(s)` : ""} as ${model === "distinct" ? `${n} users` : "1 user"} · doc ${docId} · seed ${SEED.length} chars · all synced after ${fmt((now() - t0) / 1000)} s`,
  );
  return { docId, owner, writers, viewers, all };
}

/** Wait until no writer has received a remote update for `quietMs` and every writer's own updates are acked. */
async function waitQuiescent(clients: SoakClient[], quietMs = 2000, timeoutMs = 120_000): Promise<{ ms: number; timedOut: boolean }> {
  const t0 = now();
  for (;;) {
    const last = Math.max(0, ...clients.map((c) => c.lastRemoteUpdateAt));
    const quiet = now() - Math.max(last, t0) >= quietMs;
    const acked = clients.every((c) => !c.provider.hasUnsyncedChanges);
    if (quiet && acked) return { ms: now() - t0, timedOut: false };
    if (now() - t0 > timeoutMs) return { ms: now() - t0, timedOut: true };
    await sleep(100);
  }
}

function percentiles(values: number[]): { n: number; p50: number; p95: number; p99: number; max: number } {
  if (values.length === 0) return { n: 0, p50: NaN, p95: NaN, p99: NaN, max: NaN };
  const sorted = Float64Array.from(values).sort();
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { n: sorted.length, p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1] };
}

interface Convergence {
  divergent: number;
  textLength: number;
  liveMatches: boolean | null;
  liveLength: number | null;
  persistedMatches: boolean | null;
  persistedLength: number | null;
  unloadMs: number | null;
  overheadBytesPerChar: number;
  /** HTTP reads that failed (timeout / error) while comparing with the server. */
  httpErrors: string[];
}

/**
 * Compare every client's text with each other and with the server: the live copy first (GET /content prefers
 * the loaded document), then, after every client left and the document unloaded, the copy read back from the
 * database. Destroys the clients. A server too busy to answer HTTP is reported, not fatal.
 */
async function checkConvergence(group: Group, clients: SoakClient[]): Promise<Convergence> {
  const texts = clients.map((c) => c.text.toString());
  const reference = texts[0];
  const divergent = texts.filter((t) => t !== reference).length;
  const httpErrors: string[] = [];
  const tryRead = async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    const t0 = now();
    try {
      return await fn();
    } catch (err) {
      httpErrors.push(`${label} failed after ${fmt((now() - t0) / 1000)} s: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  // The store is debounced 1.5 s after the last change; give it that plus a margin before reading.
  await sleep(2500);
  const live = await tryRead("GET /content (live)", () => serverText(group.owner, group.docId));
  const liveMatches = live == null ? null : live === reference;
  const overhead = Y.encodeStateAsUpdate(clients[0].ydoc).byteLength / Math.max(1, reference.length);
  for (const c of group.all) c.destroy();
  const t0 = now();
  let unloadMs: number | null = null;
  while (now() - t0 < 60_000) {
    const h = await tryRead("GET /api/health", health);
    if (h && h.documentsLoaded === 0 && h.connections === 0) {
      unloadMs = now() - t0;
      break;
    }
    await sleep(200);
  }
  const persistedText = unloadMs === null ? null : await tryRead("GET /content (persisted)", () => serverText(group.owner, group.docId));
  const persisted = persistedText == null ? null : persistedText === reference;
  return {
    divergent,
    textLength: reference.length,
    liveMatches,
    liveLength: live?.length ?? null,
    persistedMatches: persisted,
    persistedLength: persistedText?.length ?? null,
    unloadMs,
    overheadBytesPerChar: overhead,
    httpErrors,
  };
}

const summary: { scenario: string; n: string; result: string }[] = [];
const results: Record<string, unknown>[] = [];
const record = (scenario: string, n: string, result: string, data: Record<string, unknown>) => {
  summary.push({ scenario, n, result });
  results.push({ scenario, n, ...data });
};

// ---------------------------------------------------------------------------------------------
// Scenarios

/** 1 + 2: N writers for `typingMs`, quiescence, convergence, latency percentiles, server working set. */
async function scenarioConvergence(server: DevServer, n: number, model: UserModel, opts: { viewers?: number; watchMemory?: boolean } = {}) {
  const viewers = opts.viewers ?? 0;
  const title = viewers ? `Scenario 6: read-only clients under load · N=${n} writers + ${viewers} viewers` : `Scenario 1+2: convergence & sync latency · N=${n} · users=${model}`;
  console.log(`\n== ${title} ==`);
  const mem = new MemorySampler(server.pid);
  const stderrMark = now();
  const group = await openGroup(n, model, `${viewers ? "s6" : "s1"}-n${n}-${model}-${Date.now().toString(36)}`, viewers);
  // "before" = everyone connected and synced, nobody typing yet (route compiles and logins are behind us).
  const before = await mem.sampleOnce();
  mem.start();
  loopDelay.reset();
  const cpu = new CpuMeter(server.pid);
  await cpu.start();
  const probe = new HealthProbe();
  probe.start();
  const startedAt = now();
  for (const w of group.writers) w.startTyping("random");
  for (const v of group.viewers) v.startTyping("marker");
  await sleep(typingMs);
  for (const c of group.all) c.stopTyping();
  const typedFor = now() - startedAt;
  const sent = group.writers.map((w) => w.ops.length);
  const totalSent = sent.reduce((a, b) => a + b, 0);
  const quiet = await waitQuiescent(group.writers);
  const cpuWindow = await cpu.stop();
  const probeStats = probe.stop();
  const observed = group.writers.map((w) => w.observedOps);
  const expected = group.writers.map((w) => totalSent - w.ops.length);
  const dropped = group.writers.reduce((acc, w, i) => acc + (expected[i] - observed[i]), 0);
  const latency = percentiles(group.writers.flatMap((w) => w.latencies));
  const lag = loopLagMs();
  const peakDuring = mem.peak(startedAt);
  const viewerStats = group.viewers.map((v) => ({
    tag: v.tag,
    scope: v.provider.authorizedScope,
    attempted: v.ops.length,
    rejectedAcks: v.syncStatusFalse,
    acceptedAcks: v.syncStatusTrue,
    closes: v.closes.length,
    connectedMs: (v.closes[0]?.at ?? now()) - startedAt,
    localTextLength: v.text.length,
    stillSynced: v.synced,
  }));
  const viewerMarkers = group.viewers.flatMap((v) => v.ops.map((o) => o.marker));
  const writerText = group.writers[0].text.toString();
  const viewerMarkersInWriters = viewerMarkers.filter((m) => writerText.includes(m)).length;
  const liveBeforeUnload = viewers ? await serverText(group.owner, group.docId).catch(() => "") : "";
  const viewerMarkersLive = viewerMarkers.filter((m) => liveBeforeUnload.includes(m)).length;

  console.log(`  typed ${fmt(typedFor / 1000)} s @ 1 op/${opIntervalMs} ms per writer → ${thousands(totalSent)} ops sent (per writer min ${Math.min(...sent)} / max ${Math.max(...sent)})`);
  console.log(`  quiescent (no remote update for 2 s, all acked) after ${fmt(quiet.ms / 1000)} s${quiet.timedOut ? " — TIMED OUT (updates still arriving)" : ""}`);
  console.log(`  ops observed per writer: min ${thousands(Math.min(...observed))} / max ${thousands(Math.max(...observed))} (expected = sent − own: ${thousands(Math.min(...expected))}…${thousands(Math.max(...expected))}) → ${quiet.timedOut ? `still undelivered when the wait timed out ${thousands(dropped)}` : `dropped ${dropped}`}`);
  console.log(`  server HTTP from a separate probe process during typing + wait: GET /api/health p50 ${fmt(probeStats.p50, 0)} ms · max ${fmt(probeStats.max, 0)} ms · timed out (>10 s) or failed ${probeStats.failed} of ${probeStats.n}`);
  const conv = await checkConvergence(group, group.writers);
  console.log(`  divergent writers after quiescence: ${conv.divergent} / ${n} · final text ${thousands(conv.textLength)} chars`);
  console.log(`  server live text == writers: ${yn(conv.liveMatches)}${conv.liveMatches === false ? ` (server ${thousands(conv.liveLength ?? 0)} chars vs writer 0 ${thousands(conv.textLength)})` : ""} · unloaded ${conv.unloadMs == null ? "NOT within 60 s" : `after ${fmt(conv.unloadMs / 1000)} s`} · persisted (read back from the database) == writers: ${conv.persistedMatches == null ? "n/a" : yn(conv.persistedMatches)}${conv.persistedMatches === false ? ` (${thousands(conv.persistedLength ?? 0)} chars)` : ""}`);
  if (conv.httpErrors.length) console.log(`  server HTTP while comparing: ${conv.httpErrors.join(" · ")}`);
  console.log(`  Yjs state ${thousands(Math.round(conv.overheadBytesPerChar * conv.textLength))} B / ${thousands(conv.textLength)} chars = ${fmt(conv.overheadBytesPerChar, 2)} B/char`);
  console.log(`  one-way latency (ms, ${thousands(latency.n)} samples): p50 ${fmt(latency.p50)} · p95 ${fmt(latency.p95)} · p99 ${fmt(latency.p99)} · max ${fmt(latency.max)} · client event-loop lag p99 ${fmt(lag.p99)} ms (max ${fmt(lag.max)})`);
  console.log(`  ${cpuLine(cpuWindow)}`);
  const errors = server.stderrSince(stderrMark);
  console.log(`  server stderr lines during the scenario: ${errors.length}${errors.length ? ` · first: ${JSON.stringify(errors[0].slice(0, 160))}` : ""}`);

  let after: number | null = null;
  let afterHealth: Health | null = null;
  if (opts.watchMemory !== false && server.pid) {
    await sleep(memAfterMs);
    after = await mem.sampleOnce();
    afterHealth = await health();
  }
  mem.stop();
  const peakAll = mem.peak();
  if (server.pid) {
    console.log(
      `  server working set: before ${mb(before)} · peak ${mb(peakDuring?.bytes ?? peakAll?.bytes)} (+${fmt(((peakDuring?.at ?? startedAt) - startedAt) / 1000, 0)} s)` +
        (after != null ? ` · ${fmt(memAfterMs / 1000, 0)} s after disconnect ${mb(after)} (documentsLoaded ${afterHealth?.documentsLoaded}, connections ${afterHealth?.connections})` : ""),
    );
  } else console.log("  server working set: n/a (no pid; set SOAK_SERVER_PID)");

  if (viewers) {
    const persisted = await serverText(group.owner, group.docId);
    const viewerMarkersPersisted = viewerMarkers.filter((m) => persisted.includes(m)).length;
    console.log(`  viewers: ${viewerStats.map((v) => `${v.tag} scope=${v.scope} attempted ${v.attempted} inserts, sync-status(false) ${v.rejectedAcks}, sync-status(true) ${v.acceptedAcks}, closes ${v.closes}, connected ${fmt(v.connectedMs / 1000)} s${v.stillSynced ? " (still synced at the end)" : ""}`).join("\n           ")}`);
    console.log(`  viewer inserts in writers' text: ${viewerMarkersInWriters} · in server live text: ${viewerMarkersLive} · in persisted text: ${viewerMarkersPersisted} (of ${viewerMarkers.length} attempted)`);
    console.log(`  viewers' own local text: ${viewerStats.map((v) => `${v.tag} ${thousands(v.localTextLength)} chars`).join(", ")} vs writers ${thousands(conv.textLength)} (a viewer keeps its rejected inserts locally)`);
    record("6 read-only under load", `${n}+${viewers}`, `viewer inserts persisted ${viewerMarkersPersisted}/${viewerMarkers.length}; writers divergent ${conv.divergent}; rejected via sync-status(false) ${viewerStats.reduce((a, v) => a + v.rejectedAcks, 0)}; disconnects ${viewerStats.reduce((a, v) => a + v.closes, 0)}`, {
      viewerStats,
      viewerMarkersPersisted,
      viewerMarkersLive,
      viewerMarkersInWriters,
      attempted: viewerMarkers.length,
      divergent: conv.divergent,
      textLength: conv.textLength,
    });
    return;
  }
  record(
    "1 convergence",
    `${n} (${model})`,
    `sent ${totalSent}, observed min/max ${Math.min(...observed)}/${Math.max(...observed)}, ${quiet.timedOut ? "undelivered when the wait timed out" : "dropped"} ${dropped}, divergent ${conv.divergent}, live ${conv.liveMatches == null ? "?" : conv.liveMatches ? "=" : "≠"}, persisted ${conv.persistedMatches == null ? "?" : conv.persistedMatches ? "=" : "≠"}, ${thousands(conv.textLength)} chars, ${fmt(conv.overheadBytesPerChar, 2)} B/char`,
    { sent, observed, expected, dropped, quiescenceMs: quiet.ms, ...conv },
  );
  record(
    "2 latency & memory",
    `${n} (${model})`,
    `p50 ${fmt(latency.p50)} / p95 ${fmt(latency.p95)} / max ${fmt(latency.max)} ms (n=${latency.n}); WS before ${mb(before)} / peak ${mb(peakDuring?.bytes)} / +${fmt(memAfterMs / 1000, 0)} s ${mb(after)}${afterHealth ? ` (docs ${afterHealth.documentsLoaded})` : ""}; loop lag p99 ${fmt(lag.p99)} ms; CPU server ${cpuWindow.serverPct == null ? "n/a" : `${fmt(cpuWindow.serverPct, 0)} %`} / client ${fmt(cpuWindow.clientPct, 0)} %`,
    { latency, loopLag: lag, cpu: cpuWindow, healthProbe: probeStats, quiescenceTimedOut: quiet.timedOut, memoryBefore: before, memoryPeak: peakDuring?.bytes ?? null, memoryAfter: after, documentsLoadedAfter: afterHealth?.documentsLoaded ?? null, stderrLines: errors.length },
  );
}

/** 3: N=20 typing, all sockets closed at once and reconnected within 100 ms, typing on for 30 s. */
async function scenarioReconnectStorm(server: DevServer, n = 20) {
  console.log(`\n== Scenario 3: reconnect storm · N=${n} ==`);
  const group = await openGroup(n, "distinct", `s3-${Date.now().toString(36)}`);
  const stderrMark = now();
  for (const w of group.writers) w.startTyping("random");
  await sleep(scaled(10_000));
  const stormAt = now();
  for (const w of group.writers) w.syncedAt = null;
  await Promise.all(group.writers.map((w) => w.disconnect()));
  const closedAfter = now() - stormAt;
  for (const w of group.writers) w.reconnect();
  const reconnectIssuedAfter = now() - stormAt;
  const resynced = await Promise.allSettled(group.writers.map((w) => w.waitSynced(60_000)));
  const resyncTimes = group.writers.map((w) => (w.syncedAt == null ? NaN : w.syncedAt - stormAt)).filter((t) => Number.isFinite(t));
  const failed = resynced.filter((r) => r.status === "rejected").length;
  await sleep(scaled(30_000));
  for (const w of group.writers) w.stopTyping();
  const totalSent = group.writers.reduce((a, w) => a + w.ops.length, 0);
  const quiet = await waitQuiescent(group.writers);
  const observed = group.writers.map((w) => w.observedOps);
  const expected = group.writers.map((w) => totalSent - w.ops.length);
  const dropped = group.writers.reduce((acc, w, i) => acc + (expected[i] - observed[i]), 0);
  const p = percentiles(resyncTimes);
  console.log(`  all ${n} sockets closed within ${fmt(closedAfter)} ms, reconnect issued for all within ${fmt(reconnectIssuedAfter)} ms`);
  console.log(`  synced again: ${resyncTimes.length}/${n} (failed ${failed}) · time to synced after the close: p50 ${fmt(p.p50)} · max ${fmt(p.max)} ms`);
  console.log(`  ${thousands(totalSent)} ops sent in total (typing through the storm) · quiescent after ${fmt(quiet.ms / 1000)} s${quiet.timedOut ? " — TIMED OUT" : ""} · dropped ${dropped}`);
  const conv = await checkConvergence(group, group.writers);
  console.log(`  divergent writers: ${conv.divergent} / ${n} · text ${thousands(conv.textLength)} chars · live == writers: ${yn(conv.liveMatches)} · persisted == writers: ${conv.persistedMatches == null ? "n/a" : yn(conv.persistedMatches)}`);
  const errors = server.managed ? server.stderrSince(stderrMark) : null;
  if (errors) {
    const distinct = [...new Set(errors)].slice(0, 3);
    console.log(`  server stderr lines during the scenario: ${errors.length}${distinct.length ? `\n    ${distinct.map((l) => l.slice(0, 200)).join("\n    ")}` : ""}`);
  } else console.log("  server stderr: n/a (external server)");
  record("3 reconnect storm", String(n), `synced again ${resyncTimes.length}/${n}; reconnect p50 ${fmt(p.p50)} / max ${fmt(p.max)} ms; divergent ${conv.divergent}; dropped ${dropped}; stderr lines ${errors?.length ?? "n/a"}`, {
    resyncTimes,
    failed,
    dropped,
    ...conv,
    stderrLines: errors?.length ?? null,
    stderrSample: errors ? [...new Set(errors)].slice(0, 3) : null,
  });
}

/** 4: two writers; one goes offline, both type 20 s, it reconnects; nothing lost, both converge. */
async function scenarioOfflineMerge() {
  console.log("\n== Scenario 4: offline divergence · 2 writers, one offline for 20 s ==");
  const group = await openGroup(2, "distinct", `s4-${Date.now().toString(36)}`);
  const [online, offline] = group.writers;
  await offline.disconnect();
  const offlineAt = now();
  online.startTyping("marker");
  offline.startTyping("marker");
  await sleep(scaled(20_000));
  online.stopTyping();
  offline.stopTyping();
  const offlineOps = offline.ops.length;
  const onlineOps = online.ops.length;
  offline.syncedAt = null;
  const reconnectAt = now();
  offline.reconnect();
  const resync = await offline.waitSynced(60_000).catch(() => NaN);
  const quiet = await waitQuiescent(group.writers);
  const texts = group.writers.map((w) => w.text.toString());
  const markers = group.writers.flatMap((w) => w.ops.map((o) => `${o.marker}\n`));
  const missing = texts.map((t) => markers.filter((m) => !t.includes(m)).length);
  console.log(`  offline for ${fmt((reconnectAt - offlineAt) / 1000)} s: online writer sent ${onlineOps} ops, offline writer ${offlineOps} ops`);
  console.log(`  offline writer synced again ${fmt(resync)} ms after reconnect · quiescent after ${fmt(quiet.ms / 1000)} s${quiet.timedOut ? " — TIMED OUT" : ""}`);
  console.log(`  markers missing per writer: ${missing.join(" / ")} of ${markers.length}`);
  const conv = await checkConvergence(group, group.writers);
  const persisted = await serverText(group.owner, group.docId);
  const missingPersisted = markers.filter((m) => !persisted.includes(m)).length;
  console.log(`  divergent: ${conv.divergent} / 2 · text ${thousands(conv.textLength)} chars · live == writers: ${yn(conv.liveMatches)} · persisted == writers: ${conv.persistedMatches == null ? "n/a" : yn(conv.persistedMatches)} · markers missing in persisted text: ${missingPersisted}`);
  record("4 offline merge", "2", `resynced after ${fmt(resync)} ms; divergent ${conv.divergent}; markers lost ${Math.max(...missing, missingPersisted)}/${markers.length}`, { resyncMs: resync, onlineOps, offlineOps, missing, missingPersisted, ...conv });
}

/** 5: five writers typing, server killed hard at 30 s, restarted on the same data dir. */
async function scenarioCrash(server: DevServer, n = 5) {
  console.log(`\n== Scenario 5: crash durability · N=${n}, server killed at 30 s ==`);
  if (!server.managed) {
    console.log("  skipped: needs the spawned server (unset BASE_URL)");
    record("5 crash durability", String(n), "skipped (external server)", {});
    return;
  }
  const group = await openGroup(n, "distinct", `s5-${Date.now().toString(36)}`);
  for (const w of group.writers) w.startTyping("marker");
  await sleep(scaled(30_000));
  for (const w of group.writers) w.stopTyping();
  const killAt = now();
  const killMs = await server.killHard();
  const sentBeforeKill = group.writers.flatMap((w) => w.ops.map((o) => ({ ...o, writer: w })));
  // Park the old clients (they keep their Yjs state); their replay is measured separately below.
  await Promise.all(group.writers.map((w) => w.disconnect()));
  console.log(`  killed pid after ${fmt(killMs)} ms · ${sentBeforeKill.length} ops sent before the kill (last one ${fmt(killAt - Math.max(...sentBeforeKill.map((o) => o.sentAt)))} ms before it)`);
  const restartMs = await server.start();
  // A fresh client (empty Y.Doc) receives exactly what the database held.
  const fresh = new SoakClient(99, group.owner.login, "owner", group.docId, (await group.owner.collabToken(group.docId)).token, "fresh");
  group.all.push(fresh);
  await fresh.waitSynced(60_000);
  const persisted = fresh.text.toString();
  // Proof that the read is the database, not a replay: the fresh client must be the only connection.
  const healthAfterRestart = await health().catch(() => null);
  const onlyFresh = healthAfterRestart?.connections === 1;
  if (!onlyFresh) console.log(`  WARNING: ${healthAfterRestart?.connections ?? "?"} connections after restart — a parked client reconnected early, "persisted" may include replayed state`);
  const lost = sentBeforeKill.filter((o) => !persisted.includes(`${o.marker}\n`));
  const lostByClock = sentBeforeKill.filter((o) => o.clock > Y.getState(fresh.ydoc.store, o.writer.ydoc.clientID));
  const kept = sentBeforeKill.filter((o) => persisted.includes(`${o.marker}\n`));
  const lostSpanMs = lost.length ? killAt - Math.min(...lost.map((o) => o.sentAt)) : 0;
  const lastKeptAgeMs = kept.length ? killAt - Math.max(...kept.map((o) => o.sentAt)) : NaN;
  console.log(`  restarted in ${fmt(restartMs / 1000)} s · persisted text ${thousands(persisted.length)} chars (read by a fresh client; connections on the new server: ${healthAfterRestart?.connections ?? "?"})`);
  console.log(`  markers lost: ${lost.length} (by Yjs clock: ${lostByClock.length}) of ${sentBeforeKill.length} · lost span ${fmt(lostSpanMs)} ms of typing before the kill · last persisted op was ${fmt(lastKeptAgeMs)} ms old at the kill`);
  // Replay: the old clients reconnect with their local state; Yjs sync step 2 pushes what the server lacks.
  for (const w of group.writers) {
    w.syncedAt = null;
    w.reconnect();
  }
  await Promise.all(group.writers.map((w) => w.waitSynced(60_000)));
  await waitQuiescent([...group.writers, fresh]);
  const afterReplay = fresh.text.toString();
  const stillLost = sentBeforeKill.filter((o) => !afterReplay.includes(`${o.marker}\n`)).length;
  console.log(`  after the old clients reconnected: markers still missing ${stillLost} of ${sentBeforeKill.length} → client replay ${stillLost === 0 && lost.length > 0 ? "restored every lost marker" : stillLost === 0 ? "had nothing to restore" : "did NOT restore everything"}`);
  const conv = await checkConvergence(group, [fresh, ...group.writers]);
  console.log(`  divergent after replay: ${conv.divergent} / ${n + 1} · live == clients: ${yn(conv.liveMatches)} · persisted == clients: ${conv.persistedMatches == null ? "n/a" : yn(conv.persistedMatches)}`);
  record("5 crash durability", String(n), `lost ${lost.length}/${sentBeforeKill.length} markers = ${fmt(lostSpanMs / 1000)} s of typing; last store ${fmt(lastKeptAgeMs / 1000)} s before the kill; replay restored ${stillLost === 0 ? "all" : `all but ${stillLost}`}; restart ${fmt(restartMs / 1000)} s`, {
    sentBeforeKill: sentBeforeKill.length,
    lost: lost.length,
    lostByClock: lostByClock.length,
    lostSpanMs,
    lastKeptAgeMs,
    stillLostAfterReplay: stillLost,
    connectionsAfterRestart: healthAfterRestart?.connections ?? null,
    restartMs,
    ...conv,
  });
}

// ---------------------------------------------------------------------------------------------

async function main() {
  console.log(`[soak] ${externalBase ? `external server ${base}` : `spawning server on :${port}`} · scenarios ${[...scenarios].join(",")} · N ${writerCounts.join(",")} · typing ${typingMs / 1000} s @ ${opIntervalMs} ms · users=${userModel}`);
  console.log(`[soak] node ${process.version} · data dir ${dataDir} · dist dir ${distDir}`);
  const cpuSamples: (number | null)[] = [await cpuPercent()];
  console.log(`[soak] machine CPU at start: ${cpuSamples[0] == null ? "n/a" : `${fmt(cpuSamples[0], 0)} %`}`);
  const server = new DevServer();
  const startMs = await server.start();
  let sha = "unknown";
  try {
    sha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
  } catch {
    /* not a git checkout */
  }
  console.log(`[soak] server SHA ${sha} · first start ${fmt(startMs / 1000)} s`);

  // One scenario failing (a server too swamped to answer, a client that never syncs) is a result, not the end
  // of the run: it goes into the summary and the remaining scenarios still run.
  const failures: string[] = [];
  const attempt = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${label}: ${message}`);
      console.log(`  FAILED: ${message}`);
      record(label, "-", `FAILED: ${message}`, { failed: true, error: message });
      if (liveClients.size) {
        console.log(`  tearing down ${liveClients.size} client(s) the scenario left connected`);
        for (const c of [...liveClients]) c.destroy();
      }
      for (const probe of [...HealthProbe.active]) probe.stop();
      if (!server.managed) return;
      // The server may have been left in a bad state; make sure it is still there before going on.
      await waitForHealth(60_000).catch(() => {
        throw new Error(`server unhealthy after "${label}" failed: ${message}`);
      });
    }
  };

  try {
    if (scenarios.has("1") || scenarios.has("2")) {
      for (const n of writerCounts) await attempt(`1+2 convergence N=${n}`, () => scenarioConvergence(server, n, userModel));
      if (compareUsers) {
        const other: UserModel = userModel === "distinct" ? "single" : "distinct";
        const n = writerCounts.includes(20) ? 20 : writerCounts[writerCounts.length - 1];
        await attempt(`1+2 convergence N=${n} (${other})`, () => scenarioConvergence(server, n, other, { watchMemory: false }));
      }
      cpuSamples.push(await cpuPercent());
    }
    if (scenarios.has("3")) await attempt("3 reconnect storm", () => scenarioReconnectStorm(server));
    if (scenarios.has("4")) await attempt("4 offline merge", () => scenarioOfflineMerge());
    if (scenarios.has("5")) await attempt("5 crash durability", () => scenarioCrash(server));
    if (scenarios.has("6")) await attempt("6 read-only under load", () => scenarioConvergence(server, 20, "distinct", { viewers: 5, watchMemory: false }));
  } finally {
    cpuSamples.push(await cpuPercent());
    await server.stop();
  }

  console.log("\n== Summary ==");
  console.log(`| Scenario | N | Result |\n| --- | --- | --- |`);
  for (const row of summary) console.log(`| ${row.scenario} | ${row.n} | ${row.result} |`);
  console.log(`\nenvironment: SHA ${sha} · node ${process.version} · ${process.platform} · CPU samples ${cpuSamples.map((c) => (c == null ? "n/a" : `${fmt(c, 0)} %`)).join(" / ")}`);
  const out = path.join(path.dirname(dataDir), `results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  try {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ sha, node: process.version, base, cpuSamples, failures, results }, null, 2));
    console.log(`results written to ${out}`);
  } catch (err) {
    console.log(`could not write ${out}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (failures.length) throw new Error(`${failures.length} scenario(s) failed: ${failures.join("; ")}`);
}

async function cleanup() {
  for (const probe of [...HealthProbe.active]) probe.stop();
  if (externalBase) return;
  if (!keepData) {
    for (let attempt = 0; attempt < 5 && existsSync(dataDir); attempt++) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        await sleep(500);
      }
    }
    console.log(`[soak] data dir ${existsSync(dataDir) ? "could NOT be removed: " : "removed: "}${dataDir}`);
  }
  const dist = path.join(repoRoot, distDir);
  if (existsSync(dist)) {
    try {
      rmSync(dist, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      console.log(`[soak] removed ${distDir}`);
    } catch (err) {
      console.log(`[soak] could not remove ${distDir} (${(err as NodeJS.ErrnoException).code ?? err}); delete it by hand`);
    }
  }
  revertTsconfigChurn(repoRoot);
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  exitCode = 1;
  console.error(`[soak] FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  await cleanup();
}
process.exit(exitCode);
