import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { Hocuspocus } from "@hocuspocus/server";
import { attachCollab } from "@/server/collab/ws";
import {
  bodyExcerpt,
  checkBrotli,
  checkHeaders,
  compareChunk,
  cssRulesEqualUpToNumbers,
  diffCssRules,
  extractChunkUrls,
  formatReport,
  formatSummary,
  normalizeCssRule,
  randomBase36,
  runReleaseVerify,
  scanLocalhost,
  sha256,
  splitCssRules,
  summarize,
  versionMatches,
  type Check,
  type ReleaseVerifyIo,
} from "./release-verify";
import { connectBareCollab, connectCollab, createIo, createLocalDist, runMain } from "../release-verify.mjs";

const SHA = "5f9eb0daa9ea5ac35d3785a4f0aad6a465cb32b6";
const OTHER_SHA = "0000000000000000000000000000000000000000";

const statusOf = (checks: Check[]) => Object.fromEntries(checks.map((check) => [check.name, check.status]));
const row = (checks: Check[], name: string) => checks.find((check) => check.name === name)!;

/** Compressible pseudo-JavaScript of at least `bytes` bytes. */
function fakeScript(seed: string, bytes: number): Buffer {
  let text = `"use strict";/* ${seed} */\n`;
  for (let i = 0; text.length < bytes; i += 1) text += `function ${seed}${i}(a,b){return a+b*${i}}\n`;
  return Buffer.from(text);
}

const LOGIN_CSS = `/*! fixture */@layer theme,base,utilities;@layer theme{:root,:host{--spacing:.25rem;--color-red-50:lab(96.5005% 4.18508 1.52329)}}@layer utilities{.flex{display:flex}.p-1{padding:calc(var(--spacing)*1)}@media (min-width:40rem){.sm\\:flex{display:flex}}}${" ".repeat(1100)}`;

describe("extractChunkUrls", () => {
  it("returns the unique .js/.css chunk URLs from tags and __next_f payloads, never .map files", () => {
    const html = `<!DOCTYPE html><html><head>
      <link rel="stylesheet" href="/_next/static/chunks/3sp4rm73q5il6.css" data-precedence="next"/>
      <link rel="preload" as="script" fetchPriority="low" href="/_next/static/chunks/1jexzsn2qdw84.js"/>
      <script src="/_next/static/chunks/2ey_icn33wsjp.js" async=""></script>
      <script src="/_next/static/chunks/1tabz00zzzbk1.js" async=""></script>
      <script>self.__next_f.push([1,"2:I[339756,[\\"/_next/static/chunks/2ey_icn33wsjp.js\\",\\"/_next/static/chunks/33t46atd3n2zd.js\\"],\\"default\\"]\\n"])</script>
      <!-- /_next/static/chunks/1tabz00zzzbk1.js.map -->
      <script src="/_next/static/chunks/1jexzsn2qdw84.js" id="_R_" async=""></script>
    </head></html>`;
    expect(extractChunkUrls(html)).toEqual([
      "/_next/static/chunks/3sp4rm73q5il6.css",
      "/_next/static/chunks/1jexzsn2qdw84.js",
      "/_next/static/chunks/2ey_icn33wsjp.js",
      "/_next/static/chunks/1tabz00zzzbk1.js",
      "/_next/static/chunks/33t46atd3n2zd.js",
    ]);
    expect(extractChunkUrls("<p>nothing</p>")).toEqual([]);
  });
});

describe("compareChunk", () => {
  const remote = { name: "a.js", bytes: 10, sha256: "aa".repeat(32) };
  it("passes on equal size and hash", () => {
    expect(compareChunk(remote, { ...remote })).toEqual({ ok: true, detail: expect.stringContaining("10 B, SHA-256 aaaa") });
  });
  it("fails naming both hashes when only the SHA differs", () => {
    const result = compareChunk(remote, { ...remote, sha256: "bb".repeat(32) });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("aa".repeat(32));
    expect(result.detail).toContain("bb".repeat(32));
  });
  it("fails on a size difference and on a missing local file", () => {
    expect(compareChunk(remote, { ...remote, bytes: 11 }).detail).toBe("a.js: production 10 B vs local 11 B");
    expect(compareChunk(remote, null)).toEqual({ ok: false, detail: "a.js: not in local build" });
  });
});

describe("splitCssRules / diffCssRules", () => {
  const production = `@layer theme,base,utilities;@font-face{font-family:Inter;src:url(x.woff2)format("woff2")}@layer theme{:root,:host{--spacing:0.25rem;--w:1.0}}@layer utilities{.flex{display:flex}.p-1{padding:calc(var(--spacing)*1)}@media (min-width:40rem){.sm\\:flex{display:flex}.sm\\:p-1{padding:.25rem}}}@supports (color:lab(0% 0 0)){:root,:host{--color-red-50:lab(96.5005% 4.18508 1.52329)}}`;
  const local = `@layer theme, base, utilities;\n@font-face { font-family: Inter; src: url(x.woff2)format("woff2"); }\n@layer theme { :root, :host { --spacing: .25rem; --w: 1; } }\n@layer utilities { .flex { display: flex } .p-1 { padding: calc(var(--spacing)*1) } @media (min-width: 40rem) { .sm\\:flex { display: flex } .sm\\:p-1 { padding: 0.25rem } } .list-item{display:list-item}.\\[dev\\:port\\]{dev:port}.\\[seed\\:burke-scale\\]{seed:burke-scale} }\n@supports (color:lab(0% 0 0)) { :root, :host { --color-red-50: lab(96.5005% 4.18508 1.52328) } }`;

  it("splits into top-level rules, @layer transparent, @media/@supports one rule each, numbers normalised", () => {
    const rules = splitCssRules(production);
    expect(rules).toEqual([
      "@layer theme,base,utilities;",
      '@font-face{font-family:Inter;src:url(x.woff2)format("woff2")}',
      ":root,:host{--spacing:0.25rem;--w:1}",
      ".flex{display:flex}",
      ".p-1{padding:calc(var(--spacing)*1)}",
      "@media (min-width:40rem){.sm\\:flex{display:flex}.sm\\:p-1{padding:0.25rem}}",
      "@supports (color:lab(0% 0 0)){:root,:host{--color-red-50:lab(96.5005% 4.18508 1.52329)}}",
    ]);
    expect(normalizeCssRule(".a { content: \"{\"; margin: -.5em 1.50px 10.0% }")).toBe('.a{content:"{";margin:-0.5em 1.5px 10%}');
    expect(normalizeCssRule(".mt-0\\.5{margin-top:.125rem}")).toBe(".mt-0\\.5{margin-top:0.125rem}");
    expect(splitCssRules('.a{content:"}"}.b{color:red}')).toEqual(['.a{content:"}"}', ".b{color:red}"]);
  });

  it("three local-only utilities and a formatting-only lab() block are a warning", () => {
    const diff = diffCssRules(production, local);
    expect(diff.status).toBe("warn");
    expect(diff.remoteCount).toBe(7);
    expect(diff.localCount).toBe(10);
    expect(diff.productionOnly).toEqual([]);
    expect(diff.localOnly.map((rule) => rule.slice(0, rule.indexOf("{")))).toEqual([".list-item", ".\\[dev\\:port\\]", ".\\[seed\\:burke-scale\\]"]);
    expect(diff.formattingOnly).toHaveLength(1);
    expect(diff.detail).toBe("production 7 rules vs local 10; 3 local-only: .list-item, .\\[dev\\:port\\], .\\[seed\\:burke-scale\\]; 1 differing only in number formatting: @supports (color:lab(0% 0 0))");
  });

  it("six local-only rules fail, one production-only rule fails, identical sheets pass", () => {
    const six = `${local}.u1{a:1}.u2{a:2}.u3{a:3}`;
    expect(diffCssRules(production, six).status).toBe("fail");
    expect(diffCssRules(production, six).localOnly).toHaveLength(6);
    const missing = diffCssRules(`${production}.only-in-image{color:red}`, local);
    expect(missing.status).toBe("fail");
    expect(missing.productionOnly).toEqual([".only-in-image{color:red}"]);
    expect(missing.detail).toContain("1 production-only: .only-in-image");
    expect(diffCssRules(production, production)).toMatchObject({ status: "pass", productionOnly: [], localOnly: [], detail: "production 7 rules vs local 7; identical rule sets" });
  });

  it("number tolerance is tight: the last digit of a colour channel, not a different utility", () => {
    expect(cssRulesEqualUpToNumbers(".a{--x:lab(76.5514% 36.422 15.5335)}", ".a{--x:lab(76.5514% 36.4219 15.5335)}")).toBe(true);
    expect(cssRulesEqualUpToNumbers(".p-1{padding:1px}", ".p-2{padding:2px}")).toBe(false);
    expect(cssRulesEqualUpToNumbers(".a{width:50%}", ".a{width:51%}")).toBe(false);
    expect(cssRulesEqualUpToNumbers(".a{color:red}", ".b{color:red}")).toBe(false);
  });
});

describe("checkBrotli", () => {
  const identity = fakeScript("br", 4000);
  const identitySha = sha256(identity);
  const body = brotliCompressSync(identity);
  const headers = { "content-encoding": "br", "content-length": String(body.length), vary: "Accept-Encoding" };

  it("passes with br encoding, a matching content-length, the local .br size and the identity hash", () => {
    expect(checkBrotli(body, headers, identitySha, body.length)).toEqual({ ok: true, brBytes: body.length, detail: expect.stringContaining("→ 4") });
    expect(checkBrotli(body, headers, identitySha).ok).toBe(true);
  });
  it("fails on a wrong content-length, a wrong local size, different bytes and a missing encoding", () => {
    expect(checkBrotli(body, { ...headers, "content-length": String(body.length + 1) }, identitySha).detail).toMatch(/content-length \d+ but/);
    expect(checkBrotli(body, headers, identitySha, body.length - 3).detail).toContain("local .br sibling");
    expect(checkBrotli(brotliCompressSync(Buffer.from("something else")), { ...headers, "content-length": String(brotliCompressSync(Buffer.from("something else")).length) }, identitySha).detail).toContain("decompressed SHA-256");
    expect(checkBrotli(body, { "content-length": String(body.length) }, identitySha).detail).toBe("content-encoding missing (expected br)");
    expect(checkBrotli(body, { ...headers, "content-encoding": "gzip" }, identitySha).detail).toContain('"gzip"');
    expect(checkBrotli(identity, headers, identitySha).ok).toBe(false);
  });
});

describe("small helpers", () => {
  it("versionMatches compares a full SHA exactly and a shorter one as a prefix", () => {
    expect(versionMatches(SHA, SHA)).toBe(true);
    expect(versionMatches(SHA, SHA.slice(0, 7))).toBe(true);
    expect(versionMatches(SHA, OTHER_SHA)).toBe(false);
    expect(versionMatches(undefined, SHA)).toBe(false);
    expect(versionMatches("dev", "dev1234")).toBe(false);
  });
  it("scanLocalhost tells an origin from a bare token", () => {
    expect(scanLocalhost('if("localhost"===s.host&&(s.host=""))')).toMatchObject({ count: 1, originLike: 0 });
    expect(scanLocalhost('fetch("http://localhost:3000/api")')).toMatchObject({ count: 1, originLike: 1 });
    expect(scanLocalhost("x localhost:3000 y")).toMatchObject({ count: 1, originLike: 1 });
    expect(scanLocalhost("no hits").count).toBe(0);
    expect(scanLocalhost("a localhost b localhost c").samples).toHaveLength(2);
  });
  it("formatReport is a Markdown table with pipes escaped; summarize counts and sets the exit code", () => {
    const checks: Check[] = [
      { name: "health", status: "pass", detail: "3× 200" },
      { name: "css:rules", status: "warn", detail: "a | b\nc" },
      { name: "chunks:all", status: "skipped", detail: "no --dist" },
    ];
    expect(formatReport(checks)).toBe("| check | status | detail |\n| --- | --- | --- |\n| health | pass | 3× 200 |\n| css:rules | warn | a \\| b c |\n| chunks:all | skipped | no --dist |");
    expect(summarize(checks)).toEqual({ passed: 1, failed: 0, warned: 1, skipped: 1, exitCode: 0 });
    expect(formatSummary(summarize([...checks, { name: "gzip", status: "fail", detail: "" }]))).toBe("release-verify: 1 passed, 1 failed, 1 warned, 1 skipped");
    expect(summarize([...checks, { name: "gzip", status: "fail", detail: "" }]).exitCode).toBe(1);
  });
  it("checkHeaders compares trimmed values exactly, names absent and forbidden headers, flags a repeated value", () => {
    const rules = [
      { name: "x-content-type-options", expected: "nosniff" },
      { name: "permissions-policy", expected: "camera=(), microphone=(), geolocation=()" },
      { name: "content-security-policy", expected: null },
    ];
    expect(checkHeaders("/x", { "x-content-type-options": " nosniff ", "permissions-policy": "camera=(), microphone=(), geolocation=()" }, rules)).toEqual([]);
    expect(checkHeaders("/x", { "x-content-type-options": "nosniff, nosniff", "permissions-policy": "camera=(), microphone=(), geolocation=(), camera=(), microphone=(), geolocation=()", "content-security-policy": "default-src 'self'" }, rules)).toEqual([
      "/x: x-content-type-options nosniff, got nosniff, nosniff (duplicated)",
      "/x: permissions-policy camera=(), microphone=(), geolocation=(), got camera=(), microphone=(), geolocation=(), camera=(), microphone=(), geolocation=() (duplicated)",
      "/x: content-security-policy absent, got default-src 'self'",
    ]);
    expect(checkHeaders("/x", { "x-content-type-options": "", "permissions-policy": "nosniff, camera=()" }, rules)).toEqual(['/x: x-content-type-options nosniff, got ""', "/x: permissions-policy camera=(), microphone=(), geolocation=(), got nosniff, camera=()"]);
    const hsts = { name: "strict-transport-security", expected: null, note: "HSTS sent over plain HTTP" };
    expect(checkHeaders("/x", {}, [hsts])).toEqual([]);
    expect(checkHeaders("/x", { "strict-transport-security": "max-age=31536000" }, [hsts])).toEqual(["/x: strict-transport-security absent, got max-age=31536000 (HSTS sent over plain HTTP)"]);
  });
  it("randomBase36 gives exactly n base-36 characters, fresh each call; bodyExcerpt quotes at most 120 of them with control characters escaped", () => {
    const first = randomBase36(8);
    expect(first).toMatch(/^[0-9a-z]{8}$/);
    expect(randomBase36(8)).not.toBe(first);
    expect(randomBase36(3)).toHaveLength(3);
    expect(bodyExcerpt("x".repeat(200))).toBe(`"${"x".repeat(120)}"`);
    expect(bodyExcerpt('<a href="x">\n\t</a>')).toBe('"<a href=\\"x\\">\\n\\t</a>"');
    expect(bodyExcerpt("")).toBe('""');
  });
});

/** An origin that behaves like production: health, the JSON `/api/*` 404 catch-all, the `/api/mcp` card, /login, chunks with identity/br/gzip negotiation, /collab rejecting every token, the #1224 headers. */
interface FakeSite {
  server: Server;
  url: string;
  version: string;
  chunks: Map<string, Buffer>;
  html: string;
  hocuspocus: Hocuspocus;
  /** "The request arrived over HTTPS": Strict-Transport-Security on every response, as server/index.ts does behind the ingress. */
  hsts: boolean;
  /** Per-pathname header overrides for the headers-row tests: a string sets, an array sends the header that many times, null removes. */
  headerOverrides: Map<string, Record<string, string | string[] | null>>;
  /** What an unknown `/api/*` path answers: production's JSON catch-all, Next's HTML 404 page (the catch-all gone from the build) or a 200 (a route swallowed the path). */
  apiNotFound: "json" | "html" | "ok";
  /** The `GET /api/mcp` liveness card as JSON; a string is sent verbatim as text/html (a non-JSON body). */
  mcp: Record<string, unknown> | string;
  /** The `Accept` header of the last `GET /api/mcp` the site saw. */
  lastMcpAccept?: string;
}

const BASELINE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** What production's `GET /api/mcp` answers (src/app/api/mcp/route.ts): 27 tools at revision 29. */
const MCP_CARD: Record<string, unknown> = { name: "markdoc", version: "0.1.0", transport: "streamable-http", tools: 27, docs: "https://release.example/docs/agents.md", auth: "Authorization: ****** — create one at /settings" };
/** Next's HTML 404 page: what an unknown `/api/*` path answers once the `[...rest]` catch-all is gone from the build. */
const HTML_404 = `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width"/><title>404: This page could not be found.</title></head><body><div style="font-family:system-ui"><h1>404</h1><h2>This page could not be found.</h2></div></body></html>`;

function startSite(chunks: Map<string, Buffer>, html: string): Promise<FakeSite> {
  const site = { version: SHA, chunks, html, hsts: false, headerOverrides: new Map(), apiNotFound: "json", mcp: { ...MCP_CARD } } as FakeSite;
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // server/index.ts stamps these on every response; src/proxy.ts adds the frame policy to pages only (not /api/*, not chunks).
    for (const [name, value] of Object.entries(BASELINE_HEADERS)) res.setHeader(name, value);
    if (site.hsts) res.setHeader("strict-transport-security", "max-age=31536000");
    if (url.pathname === "/login") res.setHeader("content-security-policy", "frame-ancestors 'none'");
    const finish = (body: string | Buffer) => {
      for (const [name, value] of Object.entries(site.headerOverrides.get(url.pathname) ?? {})) {
        if (value === null) res.removeHeader(name);
        else res.setHeader(name, value);
      }
      return res.end(body);
    };
    if (url.pathname === "/api/health") {
      res.setHeader("content-type", "application/json");
      const body = url.searchParams.get("probe") === "live" ? { ok: true, probe: "live", collab: true, version: site.version } : { ok: true, db: true, collab: true, documentsLoaded: 0, connections: 0, latencyMs: 1, version: site.version };
      return finish(JSON.stringify(body));
    }
    if (url.pathname === "/api/mcp") {
      // src/app/api/mcp/route.ts: a plain GET is the liveness card (an SSE Accept would get a 405; the check never sends one).
      site.lastMcpAccept = req.headers.accept;
      if (typeof site.mcp === "string") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        return finish(site.mcp);
      }
      res.setHeader("content-type", "application/json");
      return finish(JSON.stringify(site.mcp));
    }
    if (url.pathname === "/login") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return finish(site.html);
    }
    if (url.pathname.startsWith("/_next/static/chunks/")) {
      const body = site.chunks.get(url.pathname.slice("/_next/static/chunks/".length));
      if (!body) {
        res.statusCode = 404;
        return finish("Not Found");
      }
      res.setHeader("content-type", url.pathname.endsWith(".css") ? "text/css; charset=UTF-8" : "application/javascript; charset=UTF-8");
      res.setHeader("cache-control", "public, max-age=31536000, immutable");
      res.setHeader("vary", "Accept-Encoding");
      const accept = String(req.headers["accept-encoding"] ?? "");
      if (/\bbr\b/.test(accept) && body.length >= 1024) {
        const compressed = brotliCompressSync(body);
        res.setHeader("content-encoding", "br");
        res.setHeader("content-length", String(compressed.length));
        return finish(compressed);
      }
      if (/\bgzip\b/.test(accept) && body.length >= 1024) {
        res.setHeader("content-encoding", "gzip");
        res.setHeader("transfer-encoding", "chunked");
        return finish(gzipSync(body));
      }
      res.setHeader("content-length", String(body.length));
      return finish(body);
    }
    if (url.pathname.startsWith("/api/")) {
      // src/app/api/[...rest]/route.ts answers every unclaimed /api/* path with JSON; "html" is Next's page instead
      // (the catch-all gone from the build), "ok" a route that swallowed the path.
      if (site.apiNotFound === "ok") {
        res.setHeader("content-type", "application/json");
        return finish(JSON.stringify({ ok: true }));
      }
      res.statusCode = 404;
      if (site.apiNotFound === "html") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        return finish(HTML_404);
      }
      res.setHeader("content-type", "application/json");
      return finish(JSON.stringify({ error: "Not found", path: url.pathname }));
    }
    res.statusCode = 404;
    finish("Not Found");
  };
  const server = createServer(handler);
  const hocuspocus = new Hocuspocus({
    name: "release-verify-test",
    quiet: true,
    async onAuthenticate() {
      throw new Error("no such token");
    },
  });
  attachCollab(server, hocuspocus as unknown as Parameters<typeof attachCollab>[1], { path: "/collab" });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(Object.assign(site, { server, url: `http://127.0.0.1:${port}`, hocuspocus }));
    });
  });
}

/** A `--dist`-shaped directory: `static/chunks/*` with `.br` siblings for files ≥ 1 KiB and a `BUILD_ID`. */
function writeDist(files: Map<string, Buffer>): string {
  const dist = mkdtempSync(path.join(tmpdir(), "release-verify-dist-"));
  const chunks = path.join(dist, "static", "chunks");
  mkdirSync(chunks, { recursive: true });
  for (const [name, body] of files) {
    writeFileSync(path.join(chunks, name), body);
    if (body.length >= 1024) writeFileSync(path.join(chunks, `${name}.br`), brotliCompressSync(body));
  }
  writeFileSync(path.join(dist, "BUILD_ID"), "test-build\n");
  return dist;
}

describe("runReleaseVerify against an in-process origin", () => {
  const chunks = new Map<string, Buffer>([
    ["main-abc.js", fakeScript("main", 3000)],
    ["app-def.js", fakeScript("app", 2000)],
    ["tiny.js", Buffer.from('"use strict";console.log("tiny")')],
    ["styles-111.css", Buffer.from(LOGIN_CSS)],
    ["lazy-ghi.js", fakeScript("lazy", 2500)],
  ]);
  const html = `<!DOCTYPE html><html><head><link rel="stylesheet" href="/_next/static/chunks/styles-111.css" data-precedence="next"/><script src="/_next/static/chunks/main-abc.js" async=""></script><script src="/_next/static/chunks/app-def.js" async=""></script><script src="/_next/static/chunks/tiny.js" noModule=""></script></head><body><script>self.__next_f.push([1,"2:I[1,[\\"/_next/static/chunks/main-abc.js\\"],\\"default\\"]"])</script></body></html>`;
  let site: FakeSite;
  let dist: string;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    site = await startSite(new Map(chunks), html);
    dist = writeDist(new Map(chunks));
    tempDirs.push(dist);
  });

  afterAll(async () => {
    try {
      site.hocuspocus.closeConnections();
      await new Promise<void>((resolve) => site.server.close(() => resolve()));
    } finally {
      for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    }
  });

  const rejected: ReleaseVerifyIo["connectCollab"] = async () => ({ outcome: "rejected", reason: "permission-denied", ms: 12 });
  const idleClosed: ReleaseVerifyIo["connectBareCollab"] = async () => ({ outcome: "closed", opened: true, code: 4401, reason: "Unauthorized", ms: 3_000 });
  const io = (overrides: Partial<ReleaseVerifyIo> = {}, distDir: string | null = dist): ReleaseVerifyIo => ({
    ...createIo({ timeoutMs: 5000, dist: distDir ?? undefined }),
    connectBareCollab: idleClosed,
    connectCollab: rejected,
    ...overrides,
  });

  it("all rows pass with a matching build; redirect is skipped for an http:// base; exit code 0", async () => {
    const report = await runReleaseVerify({ base: site.url, sha: SHA }, io());
    expect(report.checks.map((check) => check.name)).toEqual(["health", "health:live", "api:404", "mcp:alive", "redirect", "headers", "login", "chunks:identity", "chunks:all", "css:rules", "brotli", "gzip", "leak:localhost", "collab:idle", "collab:reject"]);
    expect(statusOf(report.checks)).toEqual({
      health: "pass",
      "health:live": "pass",
      "api:404": "pass",
      "mcp:alive": "pass",
      redirect: "skipped",
      headers: "pass",
      login: "pass",
      "chunks:identity": "pass",
      "chunks:all": "pass",
      "css:rules": "pass",
      brotli: "pass",
      gzip: "pass",
      "leak:localhost": "pass",
      "collab:idle": "pass",
      "collab:reject": "pass",
    });
    expect(report.summary).toEqual({ passed: 14, failed: 0, warned: 0, skipped: 1, exitCode: 0 });
    expect(row(report.checks, "headers").detail).toBe("GET /login, /api/health, main-abc.js: 5 + 4 + 1 headers as expected (HSTS not expected over http)");
    expect(row(report.checks, "login").detail).toContain("references 3 .js + 1 .css chunks");
    expect(row(report.checks, "chunks:identity").detail).toContain("4 chunks");
    expect(row(report.checks, "chunks:identity").detail).toContain("3 .js + 1 .css byte/SHA-identical");
    expect(row(report.checks, "chunks:all").detail).toContain("1 unreferenced local chunks (1 .js + 0 .css)");
    expect(row(report.checks, "css:rules").detail).toContain("identical rule sets");
    expect(row(report.checks, "brotli").detail).toMatch(/^4 chunks ≥ 1 024 B, identity [\d ]+ bytes → br [\d ]+ bytes \([\d.]+ %\), content-length = local \.br size$/);
    expect(row(report.checks, "gzip").detail).toMatch(/^main-abc\.js: identity 3 \d{3} B → gzip \d+ B, decompressed SHA-256 identical$/);
    expect(row(report.checks, "collab:idle").detail).toContain('bare 101 upgrade closed 4401 "Unauthorized" after 3000 ms');
    expect(row(report.checks, "collab:reject").detail).toContain("authenticationFailed after 12 ms (permission-denied)");
    expect(report.base).toBe(site.url);
    expect(report.startedAt <= report.finishedAt).toBe(true);
    expect(formatReport(report.checks).split("\n")).toHaveLength(17);
  });

  describe("headers", () => {
    /** Run with `overrides` on one path (or `hsts` on) and hand back the report; the site is restored afterwards. */
    async function withHeaders(pathname: string | null, overrides: Record<string, string | string[] | null>, hsts = false) {
      if (pathname) site.headerOverrides.set(pathname, overrides);
      site.hsts = hsts;
      try {
        return await runReleaseVerify({ base: site.url, sha: SHA }, io({}, null));
      } finally {
        site.headerOverrides.clear();
        site.hsts = false;
      }
    }

    it("a missing referrer-policy on /api/health fails the row naming the path, header and expected value; exactly one failure", async () => {
      const report = await withHeaders("/api/health", { "referrer-policy": null });
      expect(row(report.checks, "headers")).toEqual({ name: "headers", status: "fail", detail: "/api/health: referrer-policy strict-origin-when-cross-origin, got absent" });
      expect(report.summary).toMatchObject({ failed: 1, warned: 0, exitCode: 1 });
      expect(statusOf(report.checks)).toMatchObject({ health: "pass", login: "pass", "chunks:identity": "pass" });
    });

    it("a frame policy on /api/health fails: the proxy must not touch API responses", async () => {
      const report = await withHeaders("/api/health", { "content-security-policy": "frame-ancestors 'none'" });
      expect(row(report.checks, "headers")).toMatchObject({ status: "fail", detail: "/api/health: content-security-policy absent, got frame-ancestors 'none'" });
      expect(report.summary.failed).toBe(1);
    });

    it("HSTS on an http base fails with 'HSTS sent over plain HTTP'; a wrong frame policy on /login is named too", async () => {
      const report = await withHeaders(null, {}, true);
      const headers = row(report.checks, "headers");
      expect(headers.status).toBe("fail");
      expect(headers.detail).toBe("/login: strict-transport-security absent, got max-age=31536000 (HSTS sent over plain HTTP); /api/health: strict-transport-security absent, got max-age=31536000 (HSTS sent over plain HTTP)");
      expect(report.summary.failed).toBe(1);
      const framed = await withHeaders("/login", { "content-security-policy": "frame-ancestors 'self'", "permissions-policy": null });
      expect(row(framed.checks, "headers").detail).toBe("/login: permissions-policy camera=(), microphone=(), geolocation=(), got absent; /login: content-security-policy frame-ancestors 'none', got frame-ancestors 'self'");
    });

    it("nosniff sent twice on the chunk fails as duplicated; a frame policy on a chunk fails too", async () => {
      const report = await withHeaders("/_next/static/chunks/main-abc.js", { "x-content-type-options": ["nosniff", "nosniff"] });
      expect(row(report.checks, "headers")).toMatchObject({ status: "fail", detail: "main-abc.js: x-content-type-options nosniff, got nosniff, nosniff (duplicated)" });
      expect(report.summary.failed).toBe(1);
      expect(statusOf(report.checks)).toMatchObject({ "chunks:identity": "pass", brotli: "pass", gzip: "pass" });
      const framed = await withHeaders("/_next/static/chunks/main-abc.js", { "content-security-policy": "frame-ancestors 'none'" });
      expect(row(framed.checks, "headers").detail).toBe("main-abc.js: content-security-policy absent, got frame-ancestors 'none'");
    });

    it("a /login without any .js chunk skips the chunk sub-check inside the detail; login fails on its own", async () => {
      const original = site.html;
      site.html = "<!DOCTYPE html><html><body>maintenance</body></html>";
      try {
        const report = await runReleaseVerify({ base: site.url, sha: SHA }, io({}, null));
        expect(row(report.checks, "headers")).toEqual({ name: "headers", status: "pass", detail: "GET /login, /api/health: 5 + 4 headers as expected (HSTS not expected over http); chunk skipped: /login references no .js chunk (see login)" });
        expect(row(report.checks, "login").status).toBe("fail");
      } finally {
        site.html = original;
      }
    });

    it("an https base requires HSTS: present passes as 'HSTS checked', absent is named on both pages", async () => {
      // The fixture speaks http: route every request for the https base to it, as the ingress would.
      const real = io({}, null);
      const toSite = (url: string) => url.replace(/^https?:\/\/[^/]+/, site.url);
      const proxied: ReleaseVerifyIo = { ...real, fetchText: (url, init) => real.fetchText(toSite(url), init), fetchBytes: (url) => real.fetchBytes(toSite(url)), fetchRaw: (url, headers) => real.fetchRaw(toSite(url), headers) };
      site.hsts = true;
      try {
        const report = await runReleaseVerify({ base: "https://release.example", sha: SHA }, proxied);
        expect(row(report.checks, "headers")).toEqual({ name: "headers", status: "pass", detail: "GET /login, /api/health, main-abc.js: 5 + 4 + 1 headers as expected (HSTS checked)" });
        expect(statusOf(report.checks)).toMatchObject({ login: "pass", "chunks:identity": "pass", brotli: "pass" });
      } finally {
        site.hsts = false;
      }
      const report = await runReleaseVerify({ base: "https://release.example", sha: SHA }, proxied);
      expect(row(report.checks, "headers")).toMatchObject({ status: "fail", detail: "/login: strict-transport-security max-age=31536000, got absent; /api/health: strict-transport-security max-age=31536000, got absent" });
    });
  });

  describe("api:404 and mcp:alive", () => {
    const PASS_404 = /^GET \/api\/nonexistent-[0-9a-z]{8}: status 404, rtt \d+ ms, application\/json, JSON \{ error, path \} echoing the path$/;
    const PASS_MCP = /^GET \/api\/mcp: status 200, rtt \d+ ms, name=markdoc tools=27 version=0\.1\.0$/;
    /** The quoted body excerpt of a failure detail, decoded. */
    const excerptOf = (detail: string): string => JSON.parse(detail.match(/body(?: is not JSON:)? ("(?:[^"\\]|\\.)*")/)![1]) as string;

    it("both pass on the fixture: the catch-all echoes the random path as JSON, the card says markdoc with 27 tools", async () => {
      const report = await runReleaseVerify({ base: site.url, sha: SHA }, io({}, null));
      expect(row(report.checks, "api:404")).toEqual({ name: "api:404", status: "pass", detail: expect.stringMatching(PASS_404) });
      expect(row(report.checks, "mcp:alive")).toEqual({ name: "mcp:alive", status: "pass", detail: expect.stringMatching(PASS_MCP) });
      expect(report.summary).toMatchObject({ failed: 0, exitCode: 0 });
    });

    it("the two rows sit right after health:live and before redirect, after flip with --wait-flip", async () => {
      const report = await runReleaseVerify({ base: site.url, sha: SHA }, io({}, null));
      expect(report.checks.map((check) => check.name).slice(0, 5)).toEqual(["health", "health:live", "api:404", "mcp:alive", "redirect"]);
      const flipped = await runReleaseVerify({ base: site.url, sha: SHA, waitFlipSeconds: 5 }, io({}, null));
      expect(flipped.checks.map((check) => check.name).slice(0, 6)).toEqual(["flip", "health", "health:live", "api:404", "mcp:alive", "redirect"]);
      expect(flipped.checks).toHaveLength(16);
    });

    it("the card is asked for with a plain Accept, the unknown path differs between runs, and no detail echoes the auth line", async () => {
      const real = io({}, null);
      const asked: string[] = [];
      const spy: ReleaseVerifyIo = {
        ...real,
        fetchText: (url, init) => {
          asked.push(url);
          return real.fetchText(url, init);
        },
      };
      const first = await runReleaseVerify({ base: site.url, sha: SHA }, spy);
      const second = await runReleaseVerify({ base: site.url, sha: SHA }, spy);
      const paths = asked.filter((url) => url.includes("/api/nonexistent-")).map((url) => new URL(url).pathname);
      expect(paths).toHaveLength(2);
      expect(paths[0]).toMatch(/^\/api\/nonexistent-[0-9a-z]{8}$/);
      expect(paths[1]).toMatch(/^\/api\/nonexistent-[0-9a-z]{8}$/);
      expect(paths[0]).not.toBe(paths[1]);
      expect(asked.filter((url) => url.endsWith("/api/mcp"))).toHaveLength(2);
      expect(site.lastMcpAccept).toBeDefined();
      expect(site.lastMcpAccept).not.toContain("text/event-stream");
      for (const report of [first, second]) expect(formatReport(report.checks)).not.toMatch(/Authorization|\*\*\*\*\*\*|\/settings|docs\/agents/);
    });

    it("Next's HTML 404 page on the unknown path fails api:404 with status, content-type and exactly the first 120 body characters", async () => {
      site.apiNotFound = "html";
      try {
        const report = await runReleaseVerify({ base: site.url, sha: SHA }, io({}, null));
        const check = row(report.checks, "api:404");
        expect(check.status).toBe("fail");
        expect(check.detail).toMatch(/^GET \/api\/nonexistent-[0-9a-z]{8}: status 404, rtt \d+ ms, text\/html; charset=utf-8, body "<!DOCTYPE html>/);
        expect(check.detail).toContain(`body ${JSON.stringify(HTML_404.slice(0, 120))}; content-type "text/html; charset=utf-8" is not application/json (Next's HTML 404 page: the [...rest] catch-all is gone from the build); body is not JSON`);
        expect(HTML_404.length).toBeGreaterThan(120);
        expect(excerptOf(check.detail)).toBe(HTML_404.slice(0, 120));
        expect(row(report.checks, "mcp:alive")).toMatchObject({ status: "pass" });
        expect(report.summary).toMatchObject({ failed: 1, exitCode: 1 });
        expect(formatReport(report.checks).split("\n")).toHaveLength(17);
      } finally {
        site.apiNotFound = "json";
      }
    });

    it("a 200 on the unknown path fails api:404 naming the status and the missing error/path; a JSON 404 echoing another path fails too", async () => {
      site.apiNotFound = "ok";
      try {
        const report = await runReleaseVerify({ base: site.url, sha: SHA }, io({}, null));
        expect(row(report.checks, "api:404")).toMatchObject({ status: "fail", detail: expect.stringMatching(/^GET \/api\/nonexistent-[0-9a-z]{8}: status 200, rtt \d+ ms, application\/json, body "\{\\"ok\\":true\}"; status 200; body has no error string; body path=absent is not the requested path$/) });
        expect(report.summary).toMatchObject({ failed: 1, exitCode: 1 });
      } finally {
        site.apiNotFound = "json";
      }
      const real = io({}, null);
      const rewritten = { status: 404, headers: { "content-type": "application/json" }, text: JSON.stringify({ error: "Not found", path: "/api/other" }) };
      const proxied = await runReleaseVerify({ base: site.url, sha: SHA }, { ...real, fetchText: (url, init) => (url.includes("/api/nonexistent-") ? Promise.resolve(rewritten) : real.fetchText(url, init)) });
      expect(row(proxied.checks, "api:404")).toMatchObject({ status: "fail", detail: expect.stringMatching(/; body path="\/api\/other" is not the requested path$/) });
      expect(row(proxied.checks, "api:404").detail).not.toContain("error string");
    });

    it("mcp:alive fails on tools: 0 and on a non-numeric tools, naming the value", async () => {
      site.mcp = { ...MCP_CARD, tools: 0 };
      try {
        const report = await runReleaseVerify({ base: site.url, sha: SHA }, io({}, null));
        expect(row(report.checks, "mcp:alive")).toEqual({ name: "mcp:alive", status: "fail", detail: expect.stringMatching(/^GET \/api\/mcp: status 200, rtt \d+ ms, name=markdoc tools=0 version=0\.1\.0; tools=0 \(expected a number > 0\)$/) });
        expect(row(report.checks, "api:404").status).toBe("pass");
        expect(report.summary).toMatchObject({ failed: 1, exitCode: 1 });
        site.mcp = { ...MCP_CARD, tools: "27" };
        const stringy = await runReleaseVerify({ base: site.url, sha: SHA }, io({}, null));
        expect(row(stringy.checks, "mcp:alive")).toMatchObject({ status: "fail", detail: expect.stringMatching(/ name=markdoc tools=\? version=0\.1\.0; tools="27" \(expected a number > 0\)$/) });
      } finally {
        site.mcp = { ...MCP_CARD };
      }
    });

    it("mcp:alive fails on a non-JSON body (an HTML page), naming the content-type and quoting the first 120 characters", async () => {
      site.mcp = HTML_404;
      try {
        const report = await runReleaseVerify({ base: site.url, sha: SHA }, io({}, null));
        const check = row(report.checks, "mcp:alive");
        expect(check.status).toBe("fail");
        expect(check.detail).toMatch(/^GET \/api\/mcp: status 200, rtt \d+ ms, name=\? tools=\? version=\?; content-type "text\/html; charset=utf-8" is not application\/json; body is not JSON: "<!DOCTYPE html>/);
        expect(excerptOf(check.detail)).toBe(HTML_404.slice(0, 120));
        expect(report.summary).toMatchObject({ failed: 1, exitCode: 1 });
      } finally {
        site.mcp = { ...MCP_CARD };
      }
    });

    it("mcp:alive fails on name \"other\", on a transport that is not streamable-http, and on a card missing all three", async () => {
      try {
        site.mcp = { ...MCP_CARD, name: "other" };
        const other = await runReleaseVerify({ base: site.url, sha: SHA }, io({}, null));
        expect(row(other.checks, "mcp:alive")).toMatchObject({ status: "fail", detail: expect.stringMatching(/^GET \/api\/mcp: status 200, rtt \d+ ms, name=other tools=27 version=0\.1\.0; name="other" \(expected "markdoc"\)$/) });
        expect(other.summary.failed).toBe(1);
        site.mcp = { ...MCP_CARD, transport: "sse" };
        const sse = await runReleaseVerify({ base: site.url, sha: SHA }, io({}, null));
        expect(row(sse.checks, "mcp:alive")).toMatchObject({ status: "fail", detail: expect.stringMatching(/ name=markdoc tools=27 version=0\.1\.0; transport="sse" \(expected "streamable-http"\)$/) });
        site.mcp = { version: "0.1.0" };
        const bare = await runReleaseVerify({ base: site.url, sha: SHA }, io({}, null));
        expect(row(bare.checks, "mcp:alive").detail).toMatch(/ name=\? tools=\? version=0\.1\.0; name=absent \(expected "markdoc"\); tools=absent \(expected a number > 0\); transport=absent \(expected "streamable-http"\)$/);
      } finally {
        site.mcp = { ...MCP_CARD };
      }
    });

    it("a 405 on GET /api/mcp (the stateless transport refusing an SSE stream) fails mcp:alive by status", async () => {
      const real = io({}, null);
      const refused = { status: 405, headers: { "content-type": "application/json", allow: "GET, POST" }, text: JSON.stringify({ error: "Method Not Allowed", detail: "GET as an SSE stream is not supported: this MCP endpoint is stateless." }) };
      const report = await runReleaseVerify({ base: site.url, sha: SHA }, { ...real, fetchText: (url, init) => (url.endsWith("/api/mcp") ? Promise.resolve(refused) : real.fetchText(url, init)) });
      expect(row(report.checks, "mcp:alive")).toMatchObject({ status: "fail", detail: expect.stringMatching(/^GET \/api\/mcp: status 405, rtt \d+ ms, name=\? tools=\? version=\?; status 405; name=absent \(expected "markdoc"\); tools=absent \(expected a number > 0\); transport=absent \(expected "streamable-http"\)$/) });
      expect(row(report.checks, "mcp:alive").detail).not.toContain("stateless");
      expect(report.summary).toMatchObject({ failed: 1, exitCode: 1 });
    });
  });

  it("a served chunk that differs by one byte fails chunks:identity naming both hashes; exactly one failure", async () => {
    const original = site.chunks.get("tiny.js")!;
    const mutated = Buffer.from(original);
    mutated[mutated.length - 3] ^= 0x01;
    site.chunks.set("tiny.js", mutated);
    try {
      const report = await runReleaseVerify({ base: site.url, sha: SHA }, io());
      const identity = row(report.checks, "chunks:identity");
      expect(identity.status).toBe("fail");
      expect(identity.detail).toContain(`tiny.js: ${original.length} B on both sides but SHA-256 ${sha256(mutated)} (production) vs ${sha256(original)} (local)`);
      expect(report.summary.failed).toBe(1);
      expect(report.summary.exitCode).toBe(1);
    } finally {
      site.chunks.set("tiny.js", original);
    }
  });

  it("a different served version fails health and health:live and nothing else", async () => {
    site.version = OTHER_SHA;
    try {
      const report = await runReleaseVerify({ base: site.url, sha: SHA }, io());
      expect(row(report.checks, "health").status).toBe("fail");
      expect(row(report.checks, "health").detail).toContain(`version ${OTHER_SHA} is not ${SHA}`);
      expect(row(report.checks, "health:live").status).toBe("fail");
      expect(report.summary.failed).toBe(2);
    } finally {
      site.version = SHA;
    }
  });

  it("a 7-hex prefix is accepted and reported as a prefix match", async () => {
    const report = await runReleaseVerify({ base: site.url, sha: SHA.slice(0, 7) }, io());
    expect(row(report.checks, "health").status).toBe("pass");
    expect(row(report.checks, "health").detail).toContain(`(prefix match on ${SHA.slice(0, 7)})`);
  });

  it("a collab timeout, a synced document or a closed socket fail collab:reject", async () => {
    const timeout = await runReleaseVerify({ base: site.url, sha: SHA, timeoutMs: 1234 }, io({ connectCollab: async () => ({ outcome: "timeout" }) }));
    expect(row(timeout.checks, "collab:reject")).toEqual({ name: "collab:reject", status: "fail", detail: expect.stringContaining("no authenticationFailed within 1234 ms") });
    expect(row(timeout.checks, "collab:reject").detail).toContain(`ws://${new URL(site.url).host}/collab`);
    const synced = await runReleaseVerify({ base: site.url, sha: SHA }, io({ connectCollab: async () => ({ outcome: "synced" }) }));
    expect(row(synced.checks, "collab:reject").detail).toContain("synced a document with an invalid token");
    const closed = await runReleaseVerify({ base: site.url, sha: SHA }, io({ connectCollab: async () => ({ outcome: "closed", code: 1006, ms: 40 }) }));
    expect(row(closed.checks, "collab:reject").detail).toContain("socket closed (code 1006) after 40 ms");
  });

  it("keeps a bare no-frame upgrade distinct from invalid-token authentication", async () => {
    const timeout = await runReleaseVerify(
      { base: site.url, sha: SHA, timeoutMs: 5_000 },
      io({ connectBareCollab: async () => ({ outcome: "timeout", opened: true }) }),
    );
    expect(row(timeout.checks, "collab:idle")).toEqual({
      name: "collab:idle",
      status: "fail",
      detail: expect.stringContaining("bare 101 upgrade stayed open for 5000 ms without authentication"),
    });
    expect(row(timeout.checks, "collab:reject").status).toBe("pass");

    const noUpgrade = await runReleaseVerify(
      { base: site.url, sha: SHA },
      io({ connectBareCollab: async () => ({ outcome: "closed", opened: false, code: 1006, ms: 10 }) }),
    );
    expect(row(noUpgrade.checks, "collab:idle").detail).toContain("closed before the 101 upgrade completed");

    const wrongClose = await runReleaseVerify(
      { base: site.url, sha: SHA },
      io({ connectBareCollab: async () => ({ outcome: "closed", opened: true, code: 4408, reason: "Connection Timeout", ms: 3_000 }) }),
    );
    expect(row(wrongClose.checks, "collab:idle").detail).toContain('expected 4401 "Unauthorized"');
  });

  it("without --dist the local comparisons are skipped, not failed", async () => {
    const report = await runReleaseVerify({ base: site.url, sha: SHA }, io({}, null));
    expect(statusOf(report.checks)).toMatchObject({ "chunks:identity": "pass", "chunks:all": "skipped", "css:rules": "skipped", brotli: "pass", gzip: "pass" });
    expect(row(report.checks, "chunks:identity").detail).toContain("not compared");
    expect(row(report.checks, "chunks:all").detail).toContain("no --dist");
    expect(report.summary).toEqual({ passed: 12, failed: 0, warned: 0, skipped: 3, exitCode: 0 });
  });

  it("a renamed Tailwind stylesheet is compared rule by rule (warn on ≤ 5 local-only utilities), its .br by decompression only", async () => {
    const renamed = new Map([...chunks].filter(([name]) => name !== "styles-111.css"));
    renamed.set("styles-222.css", Buffer.from(LOGIN_CSS.replace("@layer utilities{", "@layer utilities{.list-item{display:list-item}")));
    renamed.set("orphan-xyz.js", fakeScript("orphan", 1500));
    const renamedDist = writeDist(renamed);
    tempDirs.push(renamedDist);
    const report = await runReleaseVerify({ base: site.url, sha: SHA }, io({}, renamedDist));
    expect(row(report.checks, "chunks:identity")).toMatchObject({ status: "pass", detail: expect.stringContaining("styles-111.css not in the local build by name → css:rules") });
    expect(row(report.checks, "css:rules")).toMatchObject({ status: "warn", detail: expect.stringContaining("styles-111.css vs local styles-222.css: production 5 rules vs local 6; 1 local-only: .list-item") });
    expect(row(report.checks, "brotli")).toMatchObject({ status: "pass", detail: expect.stringContaining("except styles-111.css (renamed stylesheet, decompression checked only)") });
    const all = row(report.checks, "chunks:all");
    expect(all.status).toBe("fail");
    expect(all.detail).toContain("2 unreferenced local chunks (2 .js + 0 .css)");
    expect(all.detail).toContain("orphan-xyz.js: status 404");
    expect(report.summary).toEqual({ passed: 12, failed: 1, warned: 1, skipped: 1, exitCode: 1 });
  });

  it("a dev origin in a referenced chunk fails leak:localhost; a bare token only warns", async () => {
    const original = site.chunks.get("app-def.js")!;
    site.chunks.set("app-def.js", Buffer.concat([original, Buffer.from('\nconst api="http://localhost:3000/api";')]));
    try {
      const report = await runReleaseVerify({ base: site.url, sha: SHA }, io({}, null));
      expect(row(report.checks, "leak:localhost")).toMatchObject({ status: "fail", detail: expect.stringContaining("1 as an origin") });
      expect(row(report.checks, "leak:localhost").detail).toContain("app-def.js: 1 (1 origin-like)");
    } finally {
      site.chunks.set("app-def.js", original);
    }
    site.chunks.set("app-def.js", Buffer.concat([original, Buffer.from('\nif("localhost"===h)h="";')]));
    try {
      const report = await runReleaseVerify({ base: site.url, sha: SHA }, io({}, null));
      expect(row(report.checks, "leak:localhost")).toMatchObject({ status: "warn", detail: expect.stringContaining("none as an origin") });
      expect(report.summary.exitCode).toBe(0);
    } finally {
      site.chunks.set("app-def.js", original);
    }
  });

  it("an unreachable origin fails every network row with the error, never a stack", async () => {
    const report = await runReleaseVerify({ base: "http://127.0.0.1:1", sha: SHA, timeoutMs: 2000 }, io());
    expect(row(report.checks, "health").status).toBe("fail");
    expect(row(report.checks, "health").detail).toMatch(/^request failed: /);
    expect(row(report.checks, "api:404")).toMatchObject({ status: "fail", detail: expect.stringMatching(/^request failed: /) });
    expect(row(report.checks, "mcp:alive")).toMatchObject({ status: "fail", detail: expect.stringMatching(/^request failed: /) });
    expect(row(report.checks, "headers").status).toBe("fail");
    expect(row(report.checks, "headers").detail).toMatch(/^request failed: /);
    expect(statusOf(report.checks)).toMatchObject({ "chunks:identity": "skipped", brotli: "skipped", gzip: "skipped", "leak:localhost": "skipped" });
    expect(formatReport(report.checks)).not.toMatch(/\n\s+at /);
  });

  describe("--wait-flip", () => {
    const health = (version: string) => ({ status: 200, headers: { "content-type": "application/json" }, text: JSON.stringify({ ok: true, db: true, latencyMs: 1, version }) });

    it("passes once the sampled version matches and reports the flip time", async () => {
      const real = io();
      const sequence = [health(OTHER_SHA), health(OTHER_SHA), health(SHA)];
      let clock = Date.UTC(2026, 7, 31, 13, 0, 0);
      const report = await runReleaseVerify(
        { base: site.url, sha: SHA, waitFlipSeconds: 60 },
        { ...real, now: () => (clock += 500), sleep: async () => {}, fetchText: (url, init) => (url.endsWith("/api/health") && sequence.length > 0 ? Promise.resolve(sequence.shift()!) : real.fetchText(url, init)) },
      );
      const flip = row(report.checks, "flip");
      expect(flip.status).toBe("pass");
      expect(flip.detail).toMatch(/^at version after 3 samples, 0 non-200, max rtt 500 ms; first sample at the new version 2026-08-31T13:00:0\d\.\d{3}Z, \d\.\d s after the first sample$/);
      expect(report.checks[0].name).toBe("flip");
      expect(report.checks).toHaveLength(16);
      expect(report.summary.failed).toBe(0);
    });

    it("passes immediately when the first sample is already at the version", async () => {
      const report = await runReleaseVerify({ base: site.url, sha: SHA, waitFlipSeconds: 20 }, io());
      expect(row(report.checks, "flip")).toMatchObject({ status: "pass", detail: expect.stringMatching(/^already at version on the first sample \(rtt \d+ ms\)$/) });
    });

    it("fails after the budget when the version never changes, and the other checks still run", async () => {
      const real = io();
      let clock = 1_700_000_000_000;
      const report = await runReleaseVerify(
        { base: site.url, sha: SHA, waitFlipSeconds: 6 },
        { ...real, now: () => (clock += 500), sleep: async () => {}, fetchText: (url, init) => (url.endsWith("/api/health") && !url.includes("probe=") && clock < 1_700_000_000_000 + 6_500 ? Promise.resolve(health(OTHER_SHA)) : real.fetchText(url, init)) },
      );
      const flip = row(report.checks, "flip");
      expect(flip.status).toBe("fail");
      expect(flip.detail).toMatch(/^version did not become 5f9eb0d\w+ within 6 s: [3-5] samples, 0 non-200, max rtt 500 ms, last version 0{40}$/);
      expect(report.checks).toHaveLength(16);
      expect(statusOf(report.checks)).toMatchObject({ health: "pass", login: "pass", "collab:idle": "pass", "collab:reject": "pass" });
      expect(report.summary).toMatchObject({ failed: 1, exitCode: 1 });
    });
  });

  describe("the CLI", () => {
    /** Hocuspocus logs a rejected `onAuthenticate` as `[onAuthenticate] <message>`; swallow it and hand back the calls. */
    function quietOnAuthenticate<T>(run: () => Promise<T>): Promise<{ result: T; authenticateLogs: unknown[][] }> {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      return run()
        .then((result) => ({ result, authenticateLogs: error.mock.calls.filter((call) => call[0] === "[onAuthenticate]") }))
        .finally(() => error.mockRestore());
    }

    it("the real connectCollab reaches authenticationFailed on a Hocuspocus server and tears everything down", async () => {
      const { result, authenticateLogs } = await quietOnAuthenticate(() => connectCollab(`ws://${new URL(site.url).host}/collab`, 5000));
      expect(result).toMatchObject({ outcome: "rejected", reason: "permission-denied" });
      expect(authenticateLogs).toEqual([["[onAuthenticate]", "no such token"]]);
    });

    it("the real connectBareCollab observes the 101 upgrade and bare-socket deadline", async () => {
      const result = await connectBareCollab(`ws://${new URL(site.url).host}/collab`, 5_000);
      expect(result).toMatchObject({ outcome: "closed", opened: true, code: 4401, reason: "Unauthorized" });
      if (result.outcome === "closed") expect(result.ms).toBeLessThan(5_000);
    });

    it("reports a socket that closes without authentication (no upgrade) as closed, within the grace period", async () => {
      const plain = createServer((_req, res) => {
        res.statusCode = 404;
        res.end();
      });
      await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", () => resolve()));
      try {
        const outcome = await connectCollab(`ws://127.0.0.1:${(plain.address() as AddressInfo).port}/collab`, 5000);
        expect(outcome.outcome).toBe("closed");
      } finally {
        await new Promise<void>((resolve) => plain.close(() => resolve()));
      }
    });

    it("createLocalDist lists files with forward slashes and refuses to read outside static/chunks", () => {
      const local = createLocalDist(dist);
      expect(local.list()).toEqual(["app-def.js", "app-def.js.br", "lazy-ghi.js", "lazy-ghi.js.br", "main-abc.js", "main-abc.js.br", "styles-111.css", "styles-111.css.br", "tiny.js"]);
      expect(local.read("tiny.js")?.equals(chunks.get("tiny.js")!)).toBe(true);
      expect(local.read("missing.js")).toBeNull();
      expect(local.read("../../BUILD_ID")).toBeNull();
    });

    it("runMain: usage errors exit 2 without running anything; --help exits 0", async () => {
      const lines: string[] = [];
      const output = { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
      expect(await runMain([], { output })).toBe(2);
      expect(lines[0]).toBe("--base is required");
      expect(await runMain(["--base", site.url], { output })).toBe(2);
      expect(await runMain(["--base", site.url, "--sha", "xyz"], { output })).toBe(2);
      expect(await runMain(["--base", "ftp://x", "--sha", SHA], { output })).toBe(2);
      expect(await runMain(["--base", site.url, "--sha", SHA, "--dist", tmpdir()], { output })).toBe(2);
      expect(await runMain(["--base", site.url, "--sha", SHA, "--wait-flip", "-1"], { output })).toBe(2);
      expect(await runMain(["--base", site.url, "--sha", SHA, "--bogus"], { output })).toBe(2);
      expect(await runMain(["--help"], { output })).toBe(0);
      expect(lines.at(-1)).toContain("usage: npm run release:verify");
      expect(lines.at(-1)).toMatch(/\n {2}health:live {6}GET .*\n {2}api:404 {10}GET \/api\/nonexistent-<8 random chars>: 404 application\/json .*\n {2}mcp:alive {8}GET \/api\/mcp with a plain Accept: 200 JSON, name "markdoc", tools > 0, transport "streamable-http"\n {2}redirect {9}GET /);
    });

    it("runMain prints the table and the summary line, writes --json and returns the exit code", async () => {
      const lines: string[] = [];
      const output = { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
      const jsonPath = path.join(dist, "report.json");
      const code = await runMain(["--base", site.url, "--sha", SHA, "--dist", dist, "--json", jsonPath, "--timeout-ms", "5000"], { output, io: io() });
      expect(code).toBe(0);
      expect(lines[0].split("\n")[0]).toBe("| check | status | detail |");
      expect(lines[1]).toBe("release-verify: 14 passed, 0 failed, 0 warned, 1 skipped");
      const written = JSON.parse(readFileSync(jsonPath, "utf8")) as { base: string; sha: string; checks: Check[]; summary: { exitCode: number } };
      expect(written.base).toBe(site.url);
      expect(written.sha).toBe(SHA);
      expect(written.checks).toHaveLength(15);
      expect(written.summary.exitCode).toBe(0);
    });

    it("the script exits on its own after the real collab handshake (no handle keeps the process alive)", async () => {
      const tsx = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
      const script = path.resolve("scripts", "release-verify.mts");
      const { result, authenticateLogs } = await quietOnAuthenticate(
        () =>
          new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
            const child = spawn(process.execPath, [tsx, script, "--base", site.url, "--sha", SHA, "--dist", dist, "--timeout-ms", "5000"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
            child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
            child.on("close", (code) => resolve({ code, stdout, stderr }));
          }),
      );
      expect(authenticateLogs).toHaveLength(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("| collab:idle | pass |");
      expect(result.stdout).toContain("| collab:reject | pass |");
      expect(result.stdout).toMatch(/\| api:404 \| pass \| GET \/api\/nonexistent-[0-9a-z]{8}: status 404, rtt \d+ ms, application\/json, JSON \{ error, path \} echoing the path \|/);
      expect(result.stdout).toMatch(/\| mcp:alive \| pass \| GET \/api\/mcp: status 200, rtt \d+ ms, name=markdoc tools=27 version=0\.1\.0 \|/);
      expect(result.stdout).toContain("| headers | pass | GET /login, /api/health, main-abc.js: 5 + 4 + 1 headers as expected (HSTS not expected over http) |");
      expect(result.stdout.trim().split("\n").at(-1)).toBe("release-verify: 14 passed, 0 failed, 0 warned, 1 skipped");
      expect(result.code).toBe(0);
    }, 60_000);
  });
});
