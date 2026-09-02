/**
 * Read-only release checks for an app-only production release (README "Production runbook: app-only
 * releases", step 3): health, the liveness probe, the JSON `/api/*` 404 catch-all, the MCP liveness card, the
 * HTTP→HTTPS redirect, the baseline security headers, the `/login` chunks byte for byte against a local build
 * of the same SHA, every other local chunk by name, brotli and gzip negotiation, the Tailwind stylesheet rule
 * by rule, a `localhost` leak scan and the unauthenticated `/collab` rejection.
 * Everything that touches the network or the disk is injected (`ReleaseVerifyIo`) so the checks are unit
 * tested without a server; the CLI (`scripts/release-verify.mts`) supplies fetch, node:https, node:fs and
 * @hocuspocus/provider. Nothing here writes anywhere: the script only issues GETs and one WebSocket connect.
 */
import { createHash, randomInt } from "node:crypto";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

export type CheckStatus = "pass" | "fail" | "warn" | "skipped";

export interface Check {
  /** Stable id: `health`, `health:live`, `api:404`, `mcp:alive`, `redirect`, `headers`, `login`, `chunks:identity`, `chunks:all`, `css:rules`, `brotli`, `gzip`, `leak:localhost`, `collab:reject`, `flip`. */
  name: string;
  status: CheckStatus;
  /** The numbers; never an environment value, token or connection string. */
  detail: string;
}

/** Headers with lower-case names; multi-valued headers joined with `, `. */
export type Headers = Record<string, string>;

export interface TextResponse {
  status: number;
  headers: Headers;
  text: string;
}

export interface BytesResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

/** The `static/chunks` directory of a local `.next` build. */
export interface LocalDist {
  /** Every file under `static/chunks`, recursively, relative with forward slashes (`.br` siblings included). */
  list(): string[];
  /** Bytes of one file named as in `list()`, or null when it does not exist. */
  read(relativePath: string): Buffer | null;
}

export type CollabOutcome =
  | { outcome: "rejected"; reason?: string; ms: number }
  | { outcome: "synced" }
  | { outcome: "timeout" }
  | { outcome: "closed"; code?: number; ms: number }
  | { outcome: "error"; message: string };

export interface ReleaseVerifyIo {
  /** GET, body decoded as text. Redirects are never followed unless `redirect: "follow"` is asked for. */
  fetchText(url: string, init?: { redirect?: "manual" | "follow" }): Promise<TextResponse>;
  /** GET with `Accept-Encoding: identity`; the body as the server sent it (a fetch client is fine here). */
  fetchBytes(url: string): Promise<BytesResponse>;
  /** GET through node:http(s) with exactly `headers`; the body as it came over the wire, never decoded. */
  fetchRaw(url: string, headers: Headers): Promise<BytesResponse>;
  /** The local build's `static/chunks`, or undefined without `--dist` (those checks are then skipped). */
  readLocal?: LocalDist;
  /** Open an unauthenticated Hocuspocus connection and report how the server answered. */
  connectCollab(url: string, timeoutMs: number): Promise<CollabOutcome>;
  /** Milliseconds since the epoch, injectable for the flip timing. */
  now(): number;
  /** Wait between `--wait-flip` samples; defaults to a real timer. */
  sleep?(ms: number): Promise<void>;
}

export interface ReleaseVerifyOptions {
  /** Origin to check, e.g. `https://markdoc.example.com`. */
  base: string;
  /** Expected `APP_VERSION`: the full 40-hex SHA, or a 7+ hex prefix compared as a prefix. */
  sha: string;
  /** Per-request budget; also the `collab:reject` wait. */
  timeoutMs?: number;
  /** When set, sample `/api/health` until `version` matches or this many seconds have passed. */
  waitFlipSeconds?: number;
  /** Seconds between flip samples (2 in the runbook). */
  flipIntervalMs?: number;
}

export interface Summary {
  passed: number;
  failed: number;
  warned: number;
  skipped: number;
  /** 0 when nothing failed, 1 otherwise. */
  exitCode: 0 | 1;
}

export interface ReleaseVerifyReport {
  base: string;
  sha: string;
  startedAt: string;
  finishedAt: string;
  checks: Check[];
  summary: Summary;
}

export const CHUNK_URL_PREFIX = "/_next/static/chunks/";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const FLIP_INTERVAL_MS = 2_000;
/** `scripts/precompress-static.mjs` writes a `.br` sibling for every `.js`/`.css` of at least this size. */
export const BROTLI_MIN_BYTES = 1_024;
/** Up to this many local-only utility rules (from `.dockerignore` dropping Tailwind scan sources) is a warning. */
export const CSS_LOCAL_ONLY_WARN_LIMIT = 5;
/** Parallel requests against the origin: enough to finish under a minute, not a load test. */
const CONCURRENCY = 4;
/** Longest list of names one table cell carries; the count of the rest follows. */
const LIST_LIMIT = 25;
/** Characters of a response body quoted in a failure detail (`api:404`, `mcp:alive`): enough to see `<!DOCTYPE html>` and a title. */
const BODY_EXCERPT_CHARS = 120;
/** Random base-36 characters after `/api/nonexistent-`: the unknown path is never the same twice (repeat-safe, cache-proof). */
const RANDOM_PATH_CHARS = 8;

export const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** `length` random base-36 characters (`randomInt` is unbiased; `Math.random().toString(36)` can come up short). */
export function randomBase36(length: number): string {
  return Array.from({ length }, () => BASE36[randomInt(BASE36.length)]).join("");
}

/** The first `BODY_EXCERPT_CHARS` characters of a body as one quoted JSON string: control characters escaped, one table cell. */
export function bodyExcerpt(text: string): string {
  return JSON.stringify(text.slice(0, BODY_EXCERPT_CHARS));
}

/** `229280` → `229 280`, the runbook's notation. */
export function formatInt(value: number): string {
  return Math.trunc(value).toLocaleString("en-US").replace(/,/g, " ");
}

/** `version` equals `sha`; a shorter `sha` is compared as a prefix. */
export function versionMatches(version: unknown, sha: string): boolean {
  if (typeof version !== "string" || !version) return false;
  return sha.length === 40 ? version === sha : version.startsWith(sha);
}

export function isPrefixSha(sha: string): boolean {
  return sha.length < 40;
}

/** A chunk URL with anything that follows it in HTML or a JSON string cut off; `.map` files never match. */
const CHUNK_URL_PATTERN = /\/_next\/static\/chunks\/[^"'\s)\\?#]+\.(?:js|css)(?=["'\s)\\?#]|$)/g;

/**
 * Every `/_next/static/chunks/…(.js|.css)` URL the page references — `<script src>`, `<link href>` and the
 * names inside the inlined `self.__next_f.push` payloads — in order of first appearance, deduplicated.
 */
export function extractChunkUrls(html: string): string[] {
  const seen = new Set<string>();
  for (const match of html.matchAll(CHUNK_URL_PATTERN)) seen.add(match[0]);
  return [...seen];
}

/** `/_next/static/chunks/app/x.js` → `app/x.js`. */
export function chunkName(url: string): string {
  return url.startsWith(CHUNK_URL_PREFIX) ? url.slice(CHUNK_URL_PREFIX.length) : url;
}

export interface ChunkDigest {
  name: string;
  bytes: number;
  sha256: string;
}

export interface ChunkComparison {
  ok: boolean;
  detail: string;
}

/** Same name, same byte count, same SHA-256; the failure text names what differs. */
export function compareChunk(remote: ChunkDigest, local: ChunkDigest | null | undefined): ChunkComparison {
  if (!local) return { ok: false, detail: `${remote.name}: not in local build` };
  if (remote.bytes !== local.bytes) return { ok: false, detail: `${remote.name}: production ${formatInt(remote.bytes)} B vs local ${formatInt(local.bytes)} B` };
  if (remote.sha256 !== local.sha256) return { ok: false, detail: `${remote.name}: ${formatInt(remote.bytes)} B on both sides but SHA-256 ${remote.sha256} (production) vs ${local.sha256} (local)` };
  return { ok: true, detail: `${remote.name}: ${formatInt(remote.bytes)} B, SHA-256 ${remote.sha256}` };
}

function skipString(text: string, openIndex: number, end: number): number {
  const quote = text[openIndex];
  let i = openIndex + 1;
  while (i < end) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === quote) return i + 1;
    else i += 1;
  }
  return end;
}

/** Index of the `}` closing the `{` at `openIndex`, or `end` when the block never closes. */
function findBlockEnd(text: string, openIndex: number, end: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < end) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipString(text, i, end);
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return end;
}

/**
 * Canonical spelling of one rule so two minifiers' output compares equal: whitespace collapsed and dropped
 * around `{ } ; ,` and after `:`, no `;` before `}`, and decimal numbers without a leading `.` or trailing zeros
 * (`.5` → `0.5`, `1.0` → `1`, `1.50` → `1.5`). Whitespace before `:` stays (`a :is(b)` is not `a:is(b)`), and
 * numbers glued to an identifier, escape or hash are left alone.
 */
export function normalizeCssRule(rule: string): string {
  return rule
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*([{};,])\s*/g, "$1")
    .replace(/:\s+/g, ":")
    .replace(/;}/g, "}")
    .replace(/(?<![\w.\\#-])(-?)(\d*)\.(\d+)(?![\d.])/g, (_match, sign: string, whole: string, fraction: string) => {
      const digits = fraction.replace(/0+$/, "");
      const integer = whole || "0";
      return digits ? `${sign}${integer}.${digits}` : `${sign}${integer}`;
    });
}

function walkRules(text: string, start: number, end: number, out: string[]): void {
  let i = start;
  let ruleStart = start;
  while (i < end) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipString(text, i, end);
      continue;
    }
    if (ch === ";") {
      const statement = normalizeCssRule(text.slice(ruleStart, i + 1));
      if (statement !== ";") out.push(statement);
      ruleStart = i + 1;
      i += 1;
      continue;
    }
    if (ch === "{") {
      const close = findBlockEnd(text, i, end);
      const prelude = text.slice(ruleStart, i).trim();
      // Tailwind v4 wraps every utility in `@layer utilities { … }`: compare what is inside, not the wrapper.
      if (/^@layer\b/i.test(prelude)) walkRules(text, i + 1, close, out);
      else out.push(normalizeCssRule(text.slice(ruleStart, Math.min(close + 1, end))));
      ruleStart = close + 1;
      i = close + 1;
      continue;
    }
    i += 1;
  }
  const tail = normalizeCssRule(text.slice(ruleStart, end));
  if (tail) out.push(tail);
}

/**
 * The stylesheet as a list of normalised top-level rules. A block (`@media`, `@supports`, `@keyframes`,
 * `@font-face`, a selector) is one rule with its whole body; `@layer name { … }` is transparent; a top-level
 * statement (`@import …;`, `@layer a, b;`) is one rule; comments are dropped; strings may contain braces.
 */
export function splitCssRules(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: string[] = [];
  walkRules(text, 0, text.length, rules);
  return rules;
}

/** The selector or at-rule prelude of a normalised rule, shortened for a table cell. */
export function cssRuleSelector(rule: string): string {
  const brace = rule.indexOf("{");
  const selector = (brace === -1 ? rule : rule.slice(0, brace)).trim();
  return selector.length > 80 ? `${selector.slice(0, 77)}…` : selector;
}

export interface CssDiff {
  remoteCount: number;
  localCount: number;
  productionOnly: string[];
  localOnly: string[];
  /** Rule pairs that differ only in the trailing digits of their numbers (`[production, local]`). */
  formattingOnly: [string, string][];
  status: "pass" | "warn" | "fail";
  detail: string;
}

const CSS_NUMBER = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi;
/** Relative difference between two numbers that still counts as the same value printed differently. */
const CSS_NUMBER_TOLERANCE = 1e-4;

/**
 * Two rules are the same up to number formatting when they are identical with every number blanked and
 * each number pair is within `CSS_NUMBER_TOLERANCE` — how oxide's `lab()` colour channels come out on
 * Windows and Linux (`1.52329` vs `1.52328`) after `normalizeCssRule` has already unified `.5`/`0.5` and `1.0`/`1`.
 */
export function cssRulesEqualUpToNumbers(a: string, b: string): boolean {
  if (a.replace(CSS_NUMBER, "#") !== b.replace(CSS_NUMBER, "#")) return false;
  const numbersA = a.match(CSS_NUMBER) ?? [];
  const numbersB = b.match(CSS_NUMBER) ?? [];
  if (numbersA.length !== numbersB.length) return false;
  return numbersA.every((text, index) => {
    const x = Number(text);
    const y = Number(numbersB[index]);
    return Math.abs(x - y) <= CSS_NUMBER_TOLERANCE * Math.max(1, Math.abs(x), Math.abs(y));
  });
}

/**
 * Compare two stylesheets as sets of normalised rules. Anything only production has is a failure (the image
 * carries CSS the local build does not); up to `CSS_LOCAL_ONLY_WARN_LIMIT` local-only rules is a warning (the
 * local Tailwind scan sees `scripts/*.mts` and `*.md`, which `.dockerignore` drops), more is a failure. A rule
 * present on both sides with the same shape and numbers equal within tolerance is a formatting-only difference,
 * reported but not counted on either side.
 */
export function diffCssRules(remoteCss: string, localCss: string): CssDiff {
  const remote = new Set(splitCssRules(remoteCss));
  const local = new Set(splitCssRules(localCss));
  const productionOnly = [...remote].filter((rule) => !local.has(rule));
  const localOnly = [...local].filter((rule) => !remote.has(rule));
  const formattingOnly: [string, string][] = [];
  for (const rule of [...productionOnly]) {
    const twin = localOnly.find((candidate) => cssRulesEqualUpToNumbers(rule, candidate));
    if (twin === undefined) continue;
    formattingOnly.push([rule, twin]);
    productionOnly.splice(productionOnly.indexOf(rule), 1);
    localOnly.splice(localOnly.indexOf(twin), 1);
  }
  const status: CssDiff["status"] = productionOnly.length > 0 ? "fail" : localOnly.length === 0 ? "pass" : localOnly.length <= CSS_LOCAL_ONLY_WARN_LIMIT ? "warn" : "fail";
  const parts = [`production ${formatInt(remote.size)} rules vs local ${formatInt(local.size)}`];
  if (productionOnly.length > 0) parts.push(`${productionOnly.length} production-only: ${listNames(productionOnly.map(cssRuleSelector))}`);
  if (localOnly.length > 0) parts.push(`${localOnly.length} local-only: ${listNames(localOnly.map(cssRuleSelector))}`);
  if (formattingOnly.length > 0) parts.push(`${formattingOnly.length} differing only in number formatting: ${listNames(formattingOnly.map(([rule]) => cssRuleSelector(rule)))}`);
  if (productionOnly.length === 0 && localOnly.length === 0 && formattingOnly.length === 0) parts.push("identical rule sets");
  return { remoteCount: remote.size, localCount: local.size, productionOnly, localOnly, formattingOnly, status, detail: parts.join("; ") };
}

export interface BrotliResult {
  ok: boolean;
  brBytes: number;
  detail: string;
}

/**
 * A raw `Accept-Encoding: br` answer must be brotli (`content-encoding: br`), declare its own length,
 * match the local `.br` sibling's size when known, and decompress to the identity bytes (SHA-256).
 */
export function checkBrotli(rawBody: Buffer, headers: Headers, identitySha: string, localBrSize?: number): BrotliResult {
  const fail = (detail: string): BrotliResult => ({ ok: false, brBytes: rawBody.length, detail });
  const encoding = headers["content-encoding"];
  if (!encoding || encoding.trim().toLowerCase() !== "br") return fail(`content-encoding ${encoding ? `"${encoding}"` : "missing"} (expected br)`);
  const declared = headers["content-length"];
  if (declared === undefined) return fail("no content-length on the br answer");
  if (Number(declared) !== rawBody.length) return fail(`content-length ${declared} but ${formatInt(rawBody.length)} raw bytes`);
  if (localBrSize !== undefined && localBrSize !== rawBody.length) return fail(`br body ${formatInt(rawBody.length)} B but the local .br sibling is ${formatInt(localBrSize)} B`);
  let decoded: Buffer;
  try {
    decoded = brotliDecompressSync(rawBody);
  } catch {
    return fail("body does not decompress as brotli");
  }
  const decodedSha = sha256(decoded);
  if (decodedSha !== identitySha) return fail(`decompressed SHA-256 ${decodedSha} differs from the identity bytes' ${identitySha}`);
  return { ok: true, brBytes: rawBody.length, detail: `br ${formatInt(rawBody.length)} B → ${formatInt(decoded.length)} B` };
}

export interface LocalhostScan {
  count: number;
  /** Occurrences that look like an origin: preceded by `//` or followed by `:<digit>`. */
  originLike: number;
  /** Up to three short excerpts around the first hits, whitespace collapsed. */
  samples: string[];
}

/**
 * Case-sensitive `localhost` occurrences in a chunk. A dev origin (`http://localhost`, `localhost:3000`) is
 * what must never ship; a bare token can be legitimate — core-js's WHATWG URL parser in Next's `noModule`
 * polyfill compares a `file:` host against `"localhost"` — so the caller warns on those instead of failing.
 */
export function scanLocalhost(text: string): LocalhostScan {
  const needle = "localhost";
  const samples: string[] = [];
  let count = 0;
  let originLike = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    const before = text.slice(Math.max(0, index - 2), index);
    const after = text.slice(index + needle.length, index + needle.length + 2);
    if (before === "//" || /^:\d/.test(after)) originLike += 1;
    if (samples.length < 3) samples.push(text.slice(Math.max(0, index - 30), index + needle.length + 30).replace(/\s+/g, " "));
    index = text.indexOf(needle, index + needle.length);
  }
  return { count, originLike, samples };
}

/** What `server/index.ts` stamps on every response (task #1224), by lower-case name. */
export const BASELINE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
/** `server/index.ts` on every page that is not the embedded document; never on `/api/*` or a static chunk. */
export const FRAME_ANCESTORS_NONE = "frame-ancestors 'none'";
export const CSP_REPORT_ONLY_HEADER = "content-security-policy-report-only";
/** `server/index.ts`, only when the request arrived over HTTPS (`x-forwarded-proto` from the ingress). */
export const STRICT_TRANSPORT_SECURITY = "max-age=31536000";

export interface HeaderRule {
  /** Lower-case header name. */
  name: string;
  /** The exact value after trim, or null when the header must be absent. */
  expected: string | null;
  /** Appended in parentheses when the rule fails, e.g. why an absent header matters. */
  note?: string;
}

/** `nosniff, nosniff`: one value repeated, joined with `, ` as fetch and node:http do when a header is sent twice. */
function isRepeated(actual: string, expected: string): boolean {
  if (!expected || actual === expected) return false;
  let rest = actual;
  while (rest.startsWith(`${expected}, `)) rest = rest.slice(expected.length + 2);
  return rest === expected;
}

/**
 * Every rule one response breaks, as `<label>: <header> <expected|absent>, got <actual|absent>`, with
 * ` (duplicated)` when the same value arrived more than once and the rule's note when it has one. Header
 * values are compared exactly after trim; names are looked up lower-case (`Headers` is already lower-case).
 */
export function checkHeaders(label: string, headers: Headers, rules: HeaderRule[]): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    const raw = headers[rule.name];
    const actual = raw === undefined ? undefined : raw.trim();
    if (actual === undefined && rule.expected === null) continue;
    if (actual !== undefined && actual === rule.expected) continue;
    const got = actual === undefined ? "absent" : actual === "" ? '""' : actual;
    const marks: string[] = [];
    if (actual !== undefined && rule.expected !== null && isRepeated(actual, rule.expected)) marks.push("duplicated");
    if (rule.note) marks.push(rule.note);
    problems.push(`${label}: ${rule.name} ${rule.expected ?? "absent"}, got ${got}${marks.length > 0 ? ` (${marks.join("; ")})` : ""}`);
  }
  return problems;
}

/** The proxy's report-only page policy must give Next a per-request nonce and strict-dynamic. */
export function checkReportOnlyCsp(label: string, headers: Headers): string | null {
  const policy = headers[CSP_REPORT_ONLY_HEADER]?.trim();
  if (!policy) return `${label}: ${CSP_REPORT_ONLY_HEADER} with nonce and strict-dynamic, got absent`;
  const script = /(?:^|;\s*)script-src\s+([^;]+)/.exec(policy)?.[1];
  if (!script || !/'nonce-[A-Za-z0-9+/]+={0,2}'/.test(script) || !script.includes("'strict-dynamic'")) {
    return `${label}: ${CSP_REPORT_ONLY_HEADER} missing nonce or strict-dynamic`;
  }
  return null;
}

function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/** The Markdown table the runbook pastes: `| check | status | detail |`. */
export function formatReport(checks: Check[]): string {
  const lines = ["| check | status | detail |", "| --- | --- | --- |"];
  for (const check of checks) lines.push(`| ${escapeCell(check.name)} | ${check.status} | ${escapeCell(check.detail)} |`);
  return lines.join("\n");
}

export function summarize(checks: Check[]): Summary {
  const count = (status: CheckStatus) => checks.filter((check) => check.status === status).length;
  const failed = count("fail");
  return { passed: count("pass"), failed, warned: count("warn"), skipped: count("skipped"), exitCode: failed > 0 ? 1 : 0 };
}

export function formatSummary(summary: Summary): string {
  return `release-verify: ${summary.passed} passed, ${summary.failed} failed, ${summary.warned} warned, ${summary.skipped} skipped`;
}

/** An error as one line: message plus the innermost `code`, never a stack. */
export function describeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code && !message.includes(code)) {
      message = `${message} (${code})`;
      break;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return message.split("\n")[0];
}

function listNames(names: string[]): string {
  if (names.length <= LIST_LIMIT) return names.join(", ");
  return `${names.slice(0, LIST_LIMIT).join(", ")} … and ${names.length - LIST_LIMIT} more`;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One body field in a failure detail: its JSON, or `absent` when the key is missing. */
function shown(value: unknown): string {
  return value === undefined ? "absent" : JSON.stringify(value);
}

function localDigest(dist: LocalDist, name: string): ChunkDigest | null {
  const bytes = dist.read(name);
  return bytes ? { name, bytes: bytes.length, sha256: sha256(bytes) } : null;
}

function isChunkFile(name: string): boolean {
  return name.endsWith(".js") || name.endsWith(".css");
}

/** Everything the per-chunk checks share once `/login` and its chunks have been fetched. */
interface ChunkState {
  /** Referenced URLs from the `/login` HTML. */
  referenced: string[];
  /** Production identity digests by chunk name (referenced ones and, with `--dist`, the local ones fetched by name). */
  identity: Map<string, ChunkDigest>;
  /** Identity bytes of the referenced chunks, for the leak scan and the CSS comparison. */
  referencedBytes: Map<string, Buffer>;
  /** Local `.css` files that a referenced production stylesheet was compared with rule by rule (the Tailwind chunk's name differs). */
  cssPairedLocal: Set<string>;
  /** Referenced production `.css` names absent from the local build by name: no local `.br` sibling to size against. */
  cssRenamed: Set<string>;
}

export async function runReleaseVerify(options: ReleaseVerifyOptions, io: ReleaseVerifyIo): Promise<ReleaseVerifyReport> {
  const base = new URL(options.base);
  const origin = base.origin;
  const sha = options.sha.toLowerCase();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = new Date(io.now()).toISOString();
  const checks: Check[] = [];
  const versionNote = isPrefixSha(sha) ? ` (prefix match on ${sha})` : "";

  const attempt = async (name: string, run: () => Promise<Check>): Promise<Check> => {
    try {
      return await run();
    } catch (error) {
      return { name, status: "fail", detail: `request failed: ${describeError(error)}` };
    }
  };
  const guarded = async (name: string, run: () => Promise<Check>) => {
    checks.push(await attempt(name, run));
  };

  const healthUrl = `${origin}/api/health`;

  if (options.waitFlipSeconds !== undefined) {
    await guarded("flip", async () => {
      const budgetMs = options.waitFlipSeconds! * 1000;
      const intervalMs = options.flipIntervalMs ?? FLIP_INTERVAL_MS;
      const first = io.now();
      let samples = 0;
      let non200 = 0;
      let maxRtt = 0;
      let lastVersion: unknown;
      for (;;) {
        const started = io.now();
        let response: TextResponse | undefined;
        try {
          response = await io.fetchText(healthUrl);
        } catch {
          response = undefined;
        }
        const rtt = io.now() - started;
        samples += 1;
        maxRtt = Math.max(maxRtt, rtt);
        if (!response || response.status !== 200) non200 += 1;
        else {
          const body = parseJson(response.text);
          lastVersion = body?.version;
          if (versionMatches(lastVersion, sha)) {
            const at = io.now();
            const detail = samples === 1 ? `already at version${versionNote} on the first sample (rtt ${rtt} ms)` : `at version${versionNote} after ${samples} samples, ${non200} non-200, max rtt ${maxRtt} ms; first sample at the new version ${new Date(at).toISOString()}, ${((at - first) / 1000).toFixed(1)} s after the first sample`;
            return { name: "flip", status: "pass", detail };
          }
        }
        if (io.now() - first >= budgetMs) {
          const seen = typeof lastVersion === "string" ? lastVersion : "?";
          return { name: "flip", status: "fail", detail: `version did not become ${sha} within ${options.waitFlipSeconds} s: ${samples} samples, ${non200} non-200, max rtt ${maxRtt} ms, last version ${seen}` };
        }
        await sleep(intervalMs);
      }
    });
  }

  await guarded("health", async () => {
    const statuses: number[] = [];
    const rtts: number[] = [];
    const latencies: string[] = [];
    const problems: string[] = [];
    let version = "?";
    for (let i = 0; i < 3; i += 1) {
      const started = io.now();
      const response = await io.fetchText(healthUrl);
      rtts.push(io.now() - started);
      statuses.push(response.status);
      const body = parseJson(response.text);
      latencies.push(typeof body?.latencyMs === "number" ? String(body.latencyMs) : "?");
      if (typeof body?.version === "string") version = body.version;
      if (response.status !== 200) problems.push(`sample ${i + 1}: status ${response.status}`);
      if (body?.ok !== true) problems.push(`sample ${i + 1}: ok=${String(body?.ok)}`);
      if (body?.db !== true) problems.push(`sample ${i + 1}: db=${String(body?.db)}`);
      if (!versionMatches(body?.version, sha)) problems.push(`sample ${i + 1}: version ${typeof body?.version === "string" ? body.version : "?"} is not ${sha}`);
    }
    const detail = `3× GET /api/health: status ${statuses.join("/")}, rtt ${rtts.join("/")} ms, latencyMs ${latencies.join("/")}, version ${version}${versionNote}`;
    return { name: "health", status: problems.length === 0 ? "pass" : "fail", detail: problems.length === 0 ? detail : `${detail}; ${problems.join("; ")}` };
  });

  await guarded("health:live", async () => {
    const started = io.now();
    const response = await io.fetchText(`${healthUrl}?probe=live`);
    const rtt = io.now() - started;
    const body = parseJson(response.text);
    const problems: string[] = [];
    if (response.status !== 200) problems.push(`status ${response.status}`);
    if (body?.ok !== true) problems.push(`ok=${String(body?.ok)}`);
    if (body?.probe !== "live") problems.push(`probe=${String(body?.probe)}`);
    if (!versionMatches(body?.version, sha)) problems.push(`version ${typeof body?.version === "string" ? body.version : "?"} is not ${sha}`);
    if (body && "db" in body) problems.push("body has a db key (the liveness probe must not touch the database)");
    const detail = `GET /api/health?probe=live: status ${response.status}, rtt ${rtt} ms, probe=${String(body?.probe)}, db key ${body && "db" in body ? "present" : "absent"}, version ${typeof body?.version === "string" ? body.version : "?"}${versionNote}`;
    return { name: "health:live", status: problems.length === 0 ? "pass" : "fail", detail: problems.length === 0 ? detail : `${detail}; ${problems.join("; ")}` };
  });

  await guarded("api:404", async () => {
    // The probe scripts/smoke.mts' unauthenticated-API step makes: an unknown /api/* path must reach the
    // `[...rest]` catch-all (src/app/api/[...rest]/route.ts) and answer JSON, never Next's HTML 404 page.
    const pathname = `/api/nonexistent-${randomBase36(RANDOM_PATH_CHARS)}`;
    const started = io.now();
    const response = await io.fetchText(`${origin}${pathname}`);
    const rtt = io.now() - started;
    const contentType = response.headers["content-type"] ?? "";
    const body = parseJson(response.text);
    const problems: string[] = [];
    if (response.status !== 404) problems.push(`status ${response.status}`);
    if (!contentType.startsWith("application/json")) problems.push(`content-type ${contentType ? `"${contentType}"` : "missing"} is not application/json${contentType.startsWith("text/html") ? " (Next's HTML 404 page: the [...rest] catch-all is gone from the build)" : ""}`);
    if (!body) problems.push("body is not JSON");
    else {
      if (typeof body.error !== "string") problems.push("body has no error string");
      if (body.path !== pathname) problems.push(`body path=${shown(body.path)} is not the requested path`);
    }
    const detail = `GET ${pathname}: status ${response.status}, rtt ${rtt} ms, ${contentType || "no content-type"}`;
    if (problems.length === 0) return { name: "api:404", status: "pass", detail: `${detail}, JSON { error, path } echoing the path` };
    return { name: "api:404", status: "fail", detail: `${detail}, body ${bodyExcerpt(response.text)}; ${problems.join("; ")}` };
  });

  await guarded("mcp:alive", async () => {
    // The card scripts/smoke.mts' "GET /api/mcp (alive)" row and e2e/share-agent.spec.ts read: a plain Accept
    // (never text/event-stream, which the stateless transport refuses with 405) answers JSON, not a stream.
    const started = io.now();
    const response = await io.fetchText(`${origin}/api/mcp`);
    const rtt = io.now() - started;
    const contentType = response.headers["content-type"] ?? "";
    const body = parseJson(response.text);
    const problems: string[] = [];
    if (response.status !== 200) problems.push(`status ${response.status}`);
    if (!contentType.startsWith("application/json")) problems.push(`content-type ${contentType ? `"${contentType}"` : "missing"} is not application/json`);
    if (!body) problems.push(`body is not JSON: ${bodyExcerpt(response.text)}`);
    else {
      if (body.name !== "markdoc") problems.push(`name=${shown(body.name)} (expected "markdoc")`);
      if (typeof body.tools !== "number" || !(body.tools > 0)) problems.push(`tools=${shown(body.tools)} (expected a number > 0)`);
      if (body.transport !== "streamable-http") problems.push(`transport=${shown(body.transport)} (expected "streamable-http")`);
    }
    // The card's name and version are fixed strings and tools a count; its auth and docs lines are never echoed.
    const detail = `GET /api/mcp: status ${response.status}, rtt ${rtt} ms, name=${typeof body?.name === "string" ? body.name : "?"} tools=${typeof body?.tools === "number" ? body.tools : "?"} version=${typeof body?.version === "string" ? body.version : "?"}`;
    return { name: "mcp:alive", status: problems.length === 0 ? "pass" : "fail", detail: problems.length === 0 ? detail : `${detail}; ${problems.join("; ")}` };
  });

  await guarded("redirect", async () => {
    if (base.protocol !== "https:") return { name: "redirect", status: "skipped", detail: `base is ${base.protocol}//: no HTTP→HTTPS redirect to check` };
    const url = `http://${base.host}/`;
    const response = await io.fetchText(url, { redirect: "manual" });
    const location = response.headers.location ?? "";
    const ok = [301, 302, 307, 308].includes(response.status) && location.startsWith(`https://${base.host}`);
    return { name: "redirect", status: ok ? "pass" : "fail", detail: `GET ${url} → ${response.status}${location ? ` location ${location}` : " (no location header)"}` };
  });

  await guarded("headers", async () => {
    const https = base.protocol === "https:";
    const baseline: HeaderRule[] = Object.entries(BASELINE_SECURITY_HEADERS).map(([name, expected]) => ({ name, expected }));
    const hsts: HeaderRule = https ? { name: "strict-transport-security", expected: STRICT_TRANSPORT_SECURITY } : { name: "strict-transport-security", expected: null, note: "HSTS sent over plain HTTP" };
    // Both CSP headers belong to pages only: API routes keep their own policies and chunks are outside the proxy matcher.
    const noCsp: HeaderRule = { name: "content-security-policy", expected: null };
    const noReportOnlyCsp: HeaderRule = { name: CSP_REPORT_ONLY_HEADER, expected: null };
    const loginRules: HeaderRule[] = [...baseline, { name: "content-security-policy", expected: FRAME_ANCESTORS_NONE }, hsts];
    const healthRules: HeaderRule[] = [...baseline, hsts];
    const chunkRules: HeaderRule[] = [{ name: "x-content-type-options", expected: BASELINE_SECURITY_HEADERS["x-content-type-options"] }];

    const login = await io.fetchText(`${origin}/login`, { redirect: "manual" });
    const health = await io.fetchText(healthUrl, { redirect: "manual" });
    const reportOnlyProblem = checkReportOnlyCsp("/login", login.headers);
    const problems = [
      ...checkHeaders("/login", login.headers, loginRules),
      ...(reportOnlyProblem ? [reportOnlyProblem] : []),
      ...checkHeaders("/api/health", health.headers, [...healthRules, noCsp, noReportOnlyCsp]),
    ];
    const targets = ["/login", "/api/health"];
    const counts = [loginRules.length + 1, healthRules.length];
    let skipped = "";
    // This row runs before `login` fills state.referenced, so it reads the /login HTML it fetched itself.
    const chunkUrl = extractChunkUrls(login.text).find((url) => url.endsWith(".js"));
    if (chunkUrl) {
      const name = chunkName(chunkUrl);
      const chunk = await io.fetchText(`${origin}${chunkUrl}`, { redirect: "manual" });
      problems.push(...checkHeaders(name, chunk.headers, [...chunkRules, noCsp, noReportOnlyCsp]));
      targets.push(name);
      counts.push(chunkRules.length);
    } else skipped = "; chunk skipped: /login references no .js chunk (see login)";
    if (problems.length > 0) return { name: "headers", status: "fail", detail: `${problems.join("; ")}${skipped}` };
    return { name: "headers", status: "pass", detail: `GET ${targets.join(", ")}: ${counts.join(" + ")} headers as expected (HSTS ${https ? "checked" : "not expected over http"})${skipped}` };
  });

  const state: ChunkState = { referenced: [], identity: new Map(), referencedBytes: new Map(), cssPairedLocal: new Set(), cssRenamed: new Set() };
  let loginOk = false;

  await guarded("login", async () => {
    const response = await io.fetchText(`${origin}/login`);
    const contentType = response.headers["content-type"] ?? "";
    state.referenced = extractChunkUrls(response.text);
    const js = state.referenced.filter((url) => url.endsWith(".js")).length;
    const css = state.referenced.length - js;
    const problems: string[] = [];
    if (response.status !== 200) problems.push(`status ${response.status}`);
    if (!contentType.startsWith("text/html")) problems.push(`content-type "${contentType}"`);
    if (js === 0) problems.push("no .js chunk referenced");
    loginOk = problems.length === 0;
    const detail = `GET /login: status ${response.status}, ${contentType || "no content-type"}, ${formatInt(response.text.length)} chars; references ${js} .js + ${css} .css chunks`;
    return { name: "login", status: loginOk ? "pass" : "fail", detail: loginOk ? detail : `${detail}; ${problems.join("; ")}` };
  });

  const dist = io.readLocal;
  const localFiles = dist ? dist.list().map((name) => name.replace(/\\/g, "/")) : [];
  const localChunks = localFiles.filter(isChunkFile);
  const referencedNames = new Set(state.referenced.map(chunkName));
  const noLogin = (name: string): Check => ({ name, status: "skipped", detail: "no /login chunks to check (see login)" });
  const noDist = (name: string): Check => ({ name, status: "skipped", detail: "no --dist: pass the .next directory of a local build of the same SHA" });

  /** Identity GET of one chunk: 200, no content-encoding, immutable cache-control; the digest is recorded. */
  const fetchIdentity = async (url: string): Promise<{ digest?: ChunkDigest; body?: Buffer; status: number; problem?: string }> => {
    const name = chunkName(url);
    const response = await io.fetchBytes(`${origin}${url}`);
    if (response.status !== 200) return { status: response.status, problem: `${name}: status ${response.status}` };
    const encoding = response.headers["content-encoding"];
    if (encoding) return { status: response.status, problem: `${name}: content-encoding "${encoding}" on an identity request` };
    const cacheControl = response.headers["cache-control"] ?? "";
    if (!/\bimmutable\b/.test(cacheControl)) return { status: response.status, problem: `${name}: cache-control "${cacheControl}" lacks immutable` };
    const digest = { name, bytes: response.body.length, sha256: sha256(response.body) };
    state.identity.set(name, digest);
    return { digest, body: response.body, status: response.status };
  };

  await guarded("chunks:identity", async () => {
    if (!loginOk || state.referenced.length === 0) return noLogin("chunks:identity");
    const results = await mapLimit(state.referenced, CONCURRENCY, fetchIdentity);
    const problems: string[] = [];
    let total = 0;
    let comparedJs = 0;
    let comparedCss = 0;
    const cssByRules: string[] = [];
    results.forEach((result, index) => {
      if (!result.digest || !result.body) {
        problems.push(result.problem ?? `${chunkName(state.referenced[index])}: unreadable`);
        return;
      }
      total += result.digest.bytes;
      state.referencedBytes.set(result.digest.name, result.body);
      if (!dist) return;
      const local = localDigest(dist, result.digest.name);
      if (result.digest.name.endsWith(".css") && !local) {
        // The Tailwind chunk's name differs between a Windows worktree and the Linux image: css:rules compares it.
        cssByRules.push(result.digest.name);
        state.cssRenamed.add(result.digest.name);
        return;
      }
      const comparison = compareChunk(result.digest, local);
      if (comparison.ok) {
        if (result.digest.name.endsWith(".js")) comparedJs += 1;
        else comparedCss += 1;
      } else problems.push(comparison.detail);
    });
    const parts = [`${state.referenced.length} chunks, ${formatInt(total)} bytes total`];
    if (dist) {
      parts.push(`${comparedJs} .js + ${comparedCss} .css byte/SHA-identical to the local build`);
      if (cssByRules.length > 0) parts.push(`${cssByRules.join(", ")} not in the local build by name → css:rules`);
    } else parts.push("no --dist: bytes and SHA-256 recorded, not compared");
    if (problems.length > 0) parts.push(`${problems.length} problem(s): ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? ` … and ${problems.length - 3} more` : ""}`);
    return { name: "chunks:identity", status: problems.length === 0 ? "pass" : "fail", detail: parts.join("; ") };
  });

  // css:rules runs before chunks:all (it decides which local stylesheet is the renamed Tailwind chunk) but is
  // listed after it, in the runbook's order.
  const cssCheck = await attempt("css:rules", async () => {
    if (!dist) return noDist("css:rules");
    if (!loginOk) return noLogin("css:rules");
    const remoteCss = state.referenced.map(chunkName).filter((name) => name.endsWith(".css") && state.referencedBytes.has(name));
    if (remoteCss.length === 0) return { name: "css:rules", status: "skipped", detail: "no .css chunk referenced by /login" };
    const localCss = localChunks.filter((name) => name.endsWith(".css")).map((name) => ({ name, rules: new Set(splitCssRules(dist.read(name)?.toString("utf8") ?? "")) }));
    if (localCss.length === 0) return { name: "css:rules", status: "fail", detail: "no .css under <dist>/static/chunks" };
    let status: Check["status"] = "pass";
    const details: string[] = [];
    for (const name of remoteCss) {
      const remoteText = state.referencedBytes.get(name)!.toString("utf8");
      const remoteRules = splitCssRules(remoteText);
      // The name differs across platforms, so pair each production stylesheet with the local one it overlaps most.
      const paired = localCss.map((candidate) => ({ candidate, shared: remoteRules.filter((rule) => candidate.rules.has(rule)).length })).sort((a, b) => b.shared - a.shared)[0];
      if (paired.shared === 0) {
        status = "fail";
        details.push(`${name}: ${formatInt(remoteRules.length)} rules, none shared with any local stylesheet`);
        continue;
      }
      state.cssPairedLocal.add(paired.candidate.name);
      const diff = diffCssRules(remoteText, dist.read(paired.candidate.name)?.toString("utf8") ?? "");
      if (diff.status === "fail" || (diff.status === "warn" && status === "pass")) status = diff.status;
      details.push(`${name} vs local ${paired.candidate.name}: ${diff.detail}`);
    }
    return { name: "css:rules", status, detail: details.join(" | ") };
  });

  await guarded("chunks:all", async () => {
    if (!dist) return noDist("chunks:all");
    if (!loginOk) return noLogin("chunks:all");
    // Every local .js the HTML did not reference, plus the .css files that keep their name across platforms.
    const names = localChunks.filter((name) => !referencedNames.has(name) && !state.cssPairedLocal.has(name));
    const results = await mapLimit(names, CONCURRENCY, (name) => fetchIdentity(`${CHUNK_URL_PREFIX}${name}`));
    const problems: string[] = [];
    let total = 0;
    results.forEach((result, index) => {
      if (!result.digest) {
        problems.push(result.problem ?? `${names[index]}: unreadable`);
        return;
      }
      total += result.digest.bytes;
      const comparison = compareChunk(result.digest, localDigest(dist, result.digest.name));
      if (!comparison.ok) problems.push(comparison.detail);
    });
    const js = names.filter((name) => name.endsWith(".js")).length;
    const parts = [`${names.length} unreferenced local chunks (${js} .js + ${names.length - js} .css) fetched by name, ${formatInt(total)} bytes total`];
    if (problems.length === 0) parts.push("all 200 and byte/SHA-identical");
    else parts.push(`${problems.length} problem(s): ${listNames(problems)}`);
    return { name: "chunks:all", status: problems.length === 0 ? "pass" : "fail", detail: parts.join("; ") };
  });
  checks.push(cssCheck);

  await guarded("brotli", async () => {
    if (!loginOk) return noLogin("brotli");
    const candidates = [...state.identity.values()].filter((digest) => digest.bytes >= BROTLI_MIN_BYTES);
    if (candidates.length === 0) return { name: "brotli", status: "skipped", detail: `no chunk of ${BROTLI_MIN_BYTES} bytes or more` };
    const results = await mapLimit(candidates, CONCURRENCY, async (digest) => {
      const response = await io.fetchRaw(`${origin}${CHUNK_URL_PREFIX}${digest.name}`, { "accept-encoding": "br" });
      if (response.status !== 200) return { ok: false, brBytes: 0, detail: `${digest.name}: status ${response.status}` };
      let localBrSize: number | undefined;
      if (dist && !state.cssRenamed.has(digest.name)) {
        const sibling = dist.read(`${digest.name}.br`);
        if (!sibling) return { ok: false, brBytes: response.body.length, detail: `${digest.name}: no .br sibling in the local build` };
        localBrSize = sibling.length;
      }
      const result = checkBrotli(response.body, response.headers, digest.sha256, localBrSize);
      return result.ok ? result : { ...result, detail: `${digest.name}: ${result.detail}` };
    });
    const identityTotal = candidates.reduce((sum, digest) => sum + digest.bytes, 0);
    const brTotal = results.reduce((sum, result) => sum + (result.ok ? result.brBytes : 0), 0);
    const problems = results.filter((result) => !result.ok).map((result) => result.detail);
    const ratio = identityTotal > 0 ? ((brTotal / identityTotal) * 100).toFixed(1) : "?";
    const renamed = candidates.filter((digest) => state.cssRenamed.has(digest.name)).map((digest) => digest.name);
    const parts = [`${candidates.length} chunks ≥ ${formatInt(BROTLI_MIN_BYTES)} B, identity ${formatInt(identityTotal)} bytes → br ${formatInt(brTotal)} bytes (${ratio} %)${dist ? `, content-length = local .br size${renamed.length > 0 ? ` except ${renamed.join(", ")} (renamed stylesheet, decompression checked only)` : ""}` : ""}`];
    if (problems.length > 0) parts.push(`${problems.length} problem(s): ${listNames(problems)}`);
    return { name: "brotli", status: problems.length === 0 ? "pass" : "fail", detail: parts.join("; ") };
  });

  await guarded("gzip", async () => {
    if (!loginOk) return noLogin("gzip");
    const candidates = state.referenced.map(chunkName).filter((name) => name.endsWith(".js") && state.identity.has(name));
    if (candidates.length === 0) return { name: "gzip", status: "skipped", detail: "no referenced .js chunk with identity bytes" };
    // The largest referenced script: the one Next's compression certainly handles.
    const name = candidates.sort((a, b) => state.identity.get(b)!.bytes - state.identity.get(a)!.bytes)[0];
    const digest = state.identity.get(name)!;
    const response = await io.fetchRaw(`${origin}${CHUNK_URL_PREFIX}${name}`, { "accept-encoding": "gzip" });
    const encoding = response.headers["content-encoding"] ?? "";
    if (response.status !== 200) return { name: "gzip", status: "fail", detail: `${name}: status ${response.status}` };
    if (encoding.trim().toLowerCase() !== "gzip") return { name: "gzip", status: "fail", detail: `${name}: content-encoding ${encoding ? `"${encoding}"` : "missing"} on a GET with Accept-Encoding: gzip` };
    let decoded: Buffer;
    try {
      decoded = gunzipSync(response.body);
    } catch {
      return { name: "gzip", status: "fail", detail: `${name}: body does not gunzip` };
    }
    const decodedSha = sha256(decoded);
    const detail = `${name}: identity ${formatInt(digest.bytes)} B → gzip ${formatInt(response.body.length)} B, decompressed SHA-256 ${decodedSha === digest.sha256 ? "identical" : `${decodedSha} differs from ${digest.sha256}`}`;
    return { name: "gzip", status: decodedSha === digest.sha256 ? "pass" : "fail", detail };
  });

  await guarded("leak:localhost", async () => {
    if (!loginOk) return noLogin("leak:localhost");
    if (state.referencedBytes.size === 0) return { name: "leak:localhost", status: "skipped", detail: "no referenced chunk bytes (see chunks:identity)" };
    const hits: string[] = [];
    let total = 0;
    let originLike = 0;
    let bytes = 0;
    for (const [name, body] of state.referencedBytes) {
      bytes += body.length;
      const scan = scanLocalhost(body.toString("latin1"));
      if (scan.count === 0) continue;
      total += scan.count;
      originLike += scan.originLike;
      hits.push(`${name}: ${scan.count}${scan.originLike > 0 ? ` (${scan.originLike} origin-like)` : ""} — ${scan.samples.map((sample) => `"…${sample}…"`).join(" ")}`);
    }
    const summary = `"localhost" occurs ${total} time(s) across ${state.referencedBytes.size} referenced chunks (${formatInt(bytes)} bytes)`;
    if (total === 0) return { name: "leak:localhost", status: "pass", detail: summary };
    if (originLike > 0) return { name: "leak:localhost", status: "fail", detail: `${summary}, ${originLike} as an origin (//localhost or localhost:<port>): ${listNames(hits)}` };
    return { name: "leak:localhost", status: "warn", detail: `${summary}, none as an origin (bare token, e.g. a URL parser's file: host rule): ${listNames(hits)}` };
  });

  await guarded("collab:reject", async () => {
    const url = `${base.protocol === "https:" ? "wss" : "ws"}://${base.host}/collab`;
    const outcome = await io.connectCollab(url, timeoutMs);
    switch (outcome.outcome) {
      case "rejected":
        return { name: "collab:reject", status: "pass", detail: `${url} with an invalid token: authenticationFailed after ${outcome.ms} ms${outcome.reason ? ` (${outcome.reason})` : ""}` };
      case "synced":
        return { name: "collab:reject", status: "fail", detail: `${url} synced a document with an invalid token` };
      case "closed":
        return { name: "collab:reject", status: "fail", detail: `${url}: socket closed${outcome.code !== undefined ? ` (code ${outcome.code})` : ""} after ${outcome.ms} ms without authenticationFailed (no upgrade?)` };
      case "timeout":
        return { name: "collab:reject", status: "fail", detail: `${url}: no authenticationFailed within ${timeoutMs} ms` };
      default:
        return { name: "collab:reject", status: "fail", detail: `${url}: ${outcome.message}` };
    }
  });

  return { base: origin, sha, startedAt, finishedAt: new Date(io.now()).toISOString(), checks, summary: summarize(checks) };
}
