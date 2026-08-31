import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import {
  DEFAULT_TIMEOUT_MS,
  formatReport,
  formatSummary,
  runReleaseVerify,
  SHA_PATTERN,
  type CollabOutcome,
  type Headers,
  type LocalDist,
  type ReleaseVerifyIo,
} from "./lib/release-verify";

export const usage = `usage: npm run release:verify -- --base https://<fqdn> --sha <40-hex> [--dist <path to a local .next of that SHA>] [--wait-flip <seconds>] [--json <file>] [--timeout-ms ${DEFAULT_TIMEOUT_MS}]

Read-only release checks (README "Production runbook: app-only releases", step 3), one Markdown table row each:
  flip             only with --wait-flip S: 2 s /api/health samples until version = --sha or S seconds pass
  health           GET /api/health x3: 200, ok, db, version = --sha (a 7+ hex prefix compares as a prefix)
  health:live      GET /api/health?probe=live: 200, ok, probe=live, version, and no db key
  redirect         GET http://<host>/ answers 301/302/307/308 to https://<host> (skipped for an http base)
  login            GET /login is 200 text/html and references .js chunks
  chunks:identity  every referenced chunk: identity GET, immutable, byte count + SHA-256 (= the local build with --dist)
  chunks:all       with --dist: every other local chunk fetched by name, 200 and byte/SHA-identical
  css:rules        with --dist: the Tailwind stylesheet rule by rule (<= 5 local-only utility rules warn)
  brotli           Accept-Encoding: br on every chunk >= 1 KiB: br, content-length = .br sibling, decompresses to identity
  gzip             one referenced .js with Accept-Encoding: gzip decompresses to the identity bytes
  leak:localhost   "localhost" occurs 0 times in the /login chunks
  collab:reject    an unauthenticated wss://<host>/collab connection reaches authenticationFailed

Only GETs and one WebSocket connection are issued; nothing is written to production and no az call is made.
Exit 0 when nothing failed, 1 when a check failed, 2 on a usage error.`;

interface CliOutput {
  log(message: string): void;
  error(message: string): void;
}

export interface CliIo extends ReleaseVerifyIo {
  /** Release keep-alive sockets so the process exits as soon as the report is printed. */
  close?(): void;
}

interface RunMainDependencies {
  output?: CliOutput;
  io?: CliIo;
}

export function parseArguments(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      sha: { type: "string" },
      dist: { type: "string" },
      "wait-flip": { type: "string" },
      json: { type: "string" },
      "timeout-ms": { type: "string", default: String(DEFAULT_TIMEOUT_MS) },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return values;
}

function flattenHeaders(headers: http.IncomingHttpHeaders | globalThis.Headers): Headers {
  const flat: Headers = {};
  if (headers instanceof globalThis.Headers) {
    headers.forEach((value, key) => {
      flat[key.toLowerCase()] = value;
    });
    return flat;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    flat[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}

/** `<dist>/static/chunks` as the lib's reader; names never escape the directory. */
export function createLocalDist(distDir: string): LocalDist {
  const root = path.resolve(distDir, "static", "chunks");
  return {
    list: () =>
      readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
        .sort(),
    read: (relativePath) => {
      const full = path.resolve(root, relativePath);
      if (!full.startsWith(root + path.sep)) return null;
      try {
        return readFileSync(full);
      } catch {
        return null;
      }
    },
  };
}

/** A GET through node:http(s) whose body is returned exactly as sent — fetch would decode br and gzip. */
function requestRaw(url: string, headers: Headers, timeoutMs: number, agents: { http: http.Agent; https: https.Agent }): Promise<{ status: number; headers: Headers; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;
    const request = client.request(target, { method: "GET", headers, agent: target.protocol === "https:" ? agents.https : agents.http }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: flattenHeaders(response.headers), body: Buffer.concat(chunks) }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    request.on("error", reject);
    request.end();
  });
}

/** Grace after a close without `authenticationFailed`, in case the two events arrive in the other order. */
const CLOSE_GRACE_MS = 250;

/**
 * The shape `src/server/collab.test.ts` uses: a HocuspocusProvider on its own websocket with an invalid token.
 * The server answers an unauthenticated connection with `authenticationFailed` and closes it with 4401; a
 * socket that closes without it (a 404 upgrade), a synced document or silence within `timeoutMs` is a failure.
 * Provider and socket are destroyed on every path so nothing keeps the process alive.
 */
export function connectCollab(url: string, timeoutMs: number): Promise<CollabOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket });
    const finish = (outcome: CollabOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (closeTimer) clearTimeout(closeTimer);
      try {
        provider.destroy();
      } catch {
        // already gone
      }
      try {
        socket.destroy();
      } catch {
        // already gone
      }
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ outcome: "timeout" }), timeoutMs);
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: "release-verify",
      token: "not-a-token",
      onAuthenticationFailed: ({ reason }) => finish({ outcome: "rejected", reason, ms: Date.now() - started }),
      onSynced: () => finish({ outcome: "synced" }),
      onClose: ({ event }) => {
        const code = (event as { code?: number } | undefined)?.code;
        closeTimer ??= setTimeout(() => finish({ outcome: "closed", code, ms: Date.now() - started }), CLOSE_GRACE_MS);
      },
    });
    try {
      provider.attach();
    } catch (error) {
      finish({ outcome: "error", message: error instanceof Error ? error.message : String(error) });
    }
  });
}

export function createIo(options: { timeoutMs: number; dist?: string }): CliIo {
  const { timeoutMs } = options;
  const agents = { http: new http.Agent({ keepAlive: true, maxSockets: 8 }), https: new https.Agent({ keepAlive: true, maxSockets: 8 }) };
  const request = (url: string, init?: { redirect?: "manual" | "follow" }) =>
    fetch(url, { redirect: init?.redirect ?? "manual", headers: { "accept-encoding": "identity" }, signal: AbortSignal.timeout(timeoutMs) });
  return {
    async fetchText(url, init) {
      const response = await request(url, init);
      return { status: response.status, headers: flattenHeaders(response.headers), text: await response.text() };
    },
    async fetchBytes(url) {
      const response = await request(url);
      return { status: response.status, headers: flattenHeaders(response.headers), body: Buffer.from(await response.arrayBuffer()) };
    },
    fetchRaw: (url, headers) => requestRaw(url, headers, timeoutMs, agents),
    readLocal: options.dist ? createLocalDist(options.dist) : undefined,
    connectCollab,
    now: () => Date.now(),
    close: () => {
      agents.http.destroy();
      agents.https.destroy();
    },
  };
}

function positiveInteger(text: string | undefined, flag: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}

export async function runMain(argv: string[], dependencies: RunMainDependencies = {}): Promise<number> {
  const output = dependencies.output ?? console;
  const usageError = (message: string) => {
    output.error(message);
    output.error(usage);
    return 2;
  };
  let values: ReturnType<typeof parseArguments>;
  try {
    values = parseArguments(argv);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : "invalid arguments");
  }
  if (values.help) {
    output.log(usage);
    return 0;
  }
  if (!values.base) return usageError("--base is required");
  let base: URL;
  try {
    base = new URL(values.base);
  } catch {
    return usageError("--base must be an http(s) origin such as https://markdoc.example.com");
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return usageError("--base must be an http(s) origin such as https://markdoc.example.com");
  const sha = values.sha?.trim().toLowerCase();
  if (!sha) return usageError("--sha is required");
  if (!SHA_PATTERN.test(sha)) return usageError("--sha must be the 40-hex commit SHA (or a 7+ hex prefix)");
  let timeoutMs: number;
  let waitFlipSeconds: number | undefined;
  try {
    timeoutMs = positiveInteger(values["timeout-ms"], "--timeout-ms");
    waitFlipSeconds = values["wait-flip"] === undefined ? undefined : positiveInteger(values["wait-flip"], "--wait-flip");
  } catch (error) {
    return usageError(error instanceof Error ? error.message : "invalid number");
  }
  let dist: string | undefined;
  if (values.dist !== undefined) {
    dist = path.resolve(values.dist);
    if (!existsSync(path.join(dist, "static", "chunks")) || !existsSync(path.join(dist, "BUILD_ID"))) return usageError(`--dist ${dist} is not a Next build: static/chunks/ or BUILD_ID is missing`);
  }

  const io = dependencies.io ?? createIo({ timeoutMs, dist });
  try {
    const report = await runReleaseVerify({ base: base.origin, sha, timeoutMs, waitFlipSeconds }, io);
    output.log(formatReport(report.checks));
    output.log(formatSummary(report.summary));
    if (values.json) writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
    return report.summary.exitCode;
  } finally {
    io.close?.();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
const modulePath = fileURLToPath(import.meta.url).toLowerCase();
if (invokedPath === modulePath) {
  process.exitCode = await runMain(process.argv.slice(2));
}
