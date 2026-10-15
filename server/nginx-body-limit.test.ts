import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from "@modelcontextprotocol/sdk/server/requestBody.js";
import { MAX_ASSET_BYTES } from "@/server/assets";
import { MAX_IMPORT_BYTES } from "@/server/import-file";
import nextConfig from "../next.config";

/**
 * nginx on the production VM stands in front of the app and refuses a request body over its
 * `client_max_body_size` with its own 413 page, before the app sees the request. The default is 1 MB,
 * which refused picture uploads, imports and agent requests the app allows (#2339). This file holds the
 * value in infra/nginx-markdoc.conf between two bounds, so that it and the app's limits cannot drift
 * apart without a failing test:
 *
 * - at least every body the app accepts (a picture, a document's text, an MCP request, an import);
 * - at most the body Next passes on in full: a body that goes through src/proxy.ts is cut after
 *   10 MiB without an error, so anything nginx let through above that would reach a route mangled.
 *
 * nginx itself is not run here. The file is installed on the VM by a person (docs/vm-hosting.md).
 */

const ROOT = path.resolve(__dirname, "..");
const MIB = 1024 * 1024;
const read = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8");

interface Directive {
  name: string;
  args: string;
}
interface Block extends Directive {
  directives: Directive[];
  blocks: Block[];
}

/** A small reader for the subset of nginx syntax the file uses: `name args;` and `name args { … }`, `#` comments. */
function parseNginx(source: string): Block {
  const text = source.replace(/#[^\n]*/g, "");
  const root: Block = { name: "http", args: "", directives: [], blocks: [] };
  const stack = [root];
  let pending = "";
  const head = (): Directive => {
    const [name = "", ...rest] = pending.trim().split(/\s+/);
    pending = "";
    return { name, args: rest.join(" ") };
  };
  for (const ch of text) {
    const current = stack[stack.length - 1];
    if (ch === ";") {
      current.directives.push(head());
    } else if (ch === "{") {
      const block: Block = { ...head(), directives: [], blocks: [] };
      current.blocks.push(block);
      stack.push(block);
    } else if (ch === "}") {
      if (pending.trim() !== "" || stack.length === 1) throw new Error("infra/nginx-markdoc.conf: unbalanced braces or a directive without `;`");
      stack.pop();
    } else {
      pending += ch;
    }
  }
  if (pending.trim() !== "" || stack.length !== 1) throw new Error("infra/nginx-markdoc.conf: the file ends inside a block or a directive");
  return root;
}

/** nginx size syntax: bytes, or a number with `k`, `m` or `g` (powers of 1024). `0` switches the check off. */
function nginxBytes(value: string): number {
  const match = /^(\d+)([kmg]?)$/i.exec(value.trim());
  if (!match) throw new Error(`not an nginx size: ${JSON.stringify(value)}`);
  const unit = { "": 1, k: 1024, m: MIB, g: 1024 * MIB }[match[2].toLowerCase()] as number;
  return Number(match[1]) * unit;
}

const every = (block: Block, name: string): Directive[] => [...block.directives.filter((d) => d.name === name), ...block.blocks.flatMap((b) => every(b, name))];
const serverName = (server: Block) => server.directives.find((d) => d.name === "server_name")?.args ?? "";

const config = parseNginx(read("infra", "nginx-markdoc.conf"));
const servers = config.blocks.filter((b) => b.name === "server");
const tlsServers = servers.filter((s) => s.directives.some((d) => d.name === "listen" && /\b443\b/.test(d.args)));
const proxying = servers.filter((s) => every(s, "proxy_pass").length > 0);

/** The value that applies to a server block's locations, or null when the block leaves nginx's 1 MB default in place. */
function bodyLimit(server: Block): number | null {
  const own = server.directives.filter((d) => d.name === "client_max_body_size");
  return own.length === 1 ? nginxBytes(own[0].args) : null;
}

/**
 * How much of a request body Next hands to a route after src/proxy.ts: `experimental.proxyClientMaxBodySize`
 * when next.config.ts sets it, else Next's built-in default, read from the installed package so a Next
 * upgrade that changes it fails here instead of going unnoticed.
 */
function nextProxyBodyLimit(): number {
  const configured: unknown = (nextConfig.experimental as Record<string, unknown> | undefined)?.proxyClientMaxBodySize;
  if (typeof configured === "number") return configured;
  if (typeof configured === "string") {
    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(configured.trim());
    if (!match) throw new Error(`next.config.ts: cannot read experimental.proxyClientMaxBodySize ${JSON.stringify(configured)}`);
    return Math.floor(Number(match[1]) * ({ b: 1, kb: 1024, mb: MIB, gb: 1024 * MIB }[match[2].toLowerCase()] as number));
  }
  const source = readFileSync(createRequire(import.meta.url).resolve("next/dist/server/body-streams"), "utf8");
  const match = /DEFAULT_BODY_CLONE_SIZE_LIMIT = (\d+) \* 1024 \* 1024/.exec(source);
  if (!match) {
    throw new Error(
      "Next no longer declares DEFAULT_BODY_CLONE_SIZE_LIMIT as `<n> * 1024 * 1024` in next/dist/server/body-streams.js. " +
        "Find out how much of a request body Next now passes through src/proxy.ts, then update this function and client_max_body_size in infra/nginx-markdoc.conf.",
    );
  }
  return Number(match[1]) * MIB;
}

/** Every `route.ts` under src/app/api, as [path relative to the repository, source]. */
function apiRoutes(dir = path.join(ROOT, "src", "app", "api")): [string, string][] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry): [string, string][] => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return apiRoutes(full);
    return entry.name === "route.ts" ? [[path.relative(ROOT, full).replace(/\\/g, "/"), readFileSync(full, "utf8")]] : [];
  });
}

/** The longest text a JSON route accepts: a document's content, in characters (UTF-16 units), not bytes. */
const DOCUMENT_MAX_CHARACTERS = 2_000_000;
/** A UTF-16 unit is at most three bytes of UTF-8 (CJK text; a four-byte character is two units). */
const MAX_UTF8_BYTES_PER_CHARACTER = 3;
/** Room for the JSON around a document's text (`{"content":"…"}` is 14 bytes; a title and a message fit as well). */
const JSON_OVERHEAD = 1024;
/** What the upload route itself allows over MAX_ASSET_BYTES for the multipart frame; measured 182 to 377 bytes. */
const MULTIPART_OVERHEAD = 4096;

const nextLimit = nextProxyBodyLimit();
/**
 * The import dialog sends every chosen file in one request (src/lib/import-upload.ts), so the largest
 * import that works is as many full-size files as fit under what Next passes on: four files of 2 MiB,
 * measured as 8,389,224 bytes. Remove this entry when imports are sent in smaller requests (#2340).
 */
const importFilesPerRequest = Math.floor((nextLimit - MULTIPART_OVERHEAD) / MAX_IMPORT_BYTES);

const accepted = [
  { what: "a picture of MAX_ASSET_BYTES in a multipart upload", bytes: MAX_ASSET_BYTES + MULTIPART_OVERHEAD },
  { what: "a document's text of 2,000,000 three-byte characters as JSON", bytes: DOCUMENT_MAX_CHARACTERS * MAX_UTF8_BYTES_PER_CHARACTER + JSON_OVERHEAD },
  { what: "an MCP request at the SDK's bound", bytes: DEFAULT_MAX_REQUEST_BODY_SIZE },
  { what: "one imported text of MAX_IMPORT_BYTES as JSON", bytes: MAX_IMPORT_BYTES + JSON_OVERHEAD },
  { what: `an import of ${importFilesPerRequest} files of MAX_IMPORT_BYTES in one multipart request`, bytes: importFilesPerRequest * MAX_IMPORT_BYTES + MULTIPART_OVERHEAD },
];

describe("infra/nginx-markdoc.conf client_max_body_size", () => {
  it("has one server block that proxies to the app and two that redirect to it over TLS", () => {
    expect(proxying.map(serverName)).toEqual(["markdoc.app"]);
    expect(tlsServers.map(serverName)).toEqual(["markdoc.app", "www.markdoc.app", "markdoc-burkeholland.eastus2.cloudapp.azure.com"]);
  });

  it.each(tlsServers.map((server) => [serverName(server), server] as const))("is set once in the %s server block, not left at nginx's 1 MB default", (_name, server) => {
    expect(server.directives.filter((d) => d.name === "client_max_body_size")).toHaveLength(1);
    // A second value inside a location would win there: the server block's is the only one.
    expect(every(server, "client_max_body_size")).toHaveLength(1);
    const limit = bodyLimit(server);
    expect(limit).not.toBeNull();
    // `0` means "no limit" to nginx.
    expect(limit).toBeGreaterThan(0);
  });

  it("is the same in the redirecting blocks as in the proxying one, so a large write to an old origin gets its 308", () => {
    const [app] = proxying;
    for (const server of tlsServers) expect([serverName(server), bodyLimit(server)]).toEqual([serverName(server), bodyLimit(app)]);
  });

  it("is not set anywhere else in the file", () => {
    // At the top level it would apply to every site on the VM and collide with a value in nginx.conf.
    expect(config.directives.filter((d) => d.name === "client_max_body_size")).toHaveLength(0);
    expect(every(config, "client_max_body_size")).toHaveLength(tlsServers.length);
  });

  it.each(accepted)("passes $what ($bytes bytes)", ({ bytes }) => {
    expect(bytes).toBeLessThanOrEqual(nextLimit);
    expect(bodyLimit(proxying[0])).toBeGreaterThanOrEqual(bytes);
  });

  it("passes nothing larger than the body Next hands to a route in full", () => {
    expect(nextLimit).toBe(10 * MIB);
    expect(bodyLimit(proxying[0])).toBeLessThanOrEqual(nextLimit);
  });
});

describe("infra/nginx-markdoc.conf client address (#2324)", () => {
  it("states the peer in X-Real-IP, which replaces a client-sent value, where it proxies to the app", () => {
    const location = proxying[0].blocks.find((b) => b.name === "location" && every(b, "proxy_pass").length > 0);
    const headers = (location?.directives ?? []).filter((d) => d.name === "proxy_set_header").map((d) => d.args);
    expect(headers).toContain("X-Real-IP $remote_addr");
  });
});

describe("the app limits the nginx value follows", () => {
  it("are the ones this file was written for", () => {
    expect(MAX_ASSET_BYTES).toBe(5 * MIB);
    expect(MAX_IMPORT_BYTES).toBe(2 * MIB);
    expect(DEFAULT_MAX_REQUEST_BODY_SIZE).toBe(4 * MIB);
    expect(importFilesPerRequest).toBe(4);
  });

  it("the picture upload route allows the multipart frame the same margin as this file", () => {
    expect(read("src", "app", "api", "documents", "[id]", "assets", "route.ts")).toContain(`MAX_ASSET_BYTES + ${MULTIPART_OVERHEAD}`);
  });

  it("no JSON route accepts a longer text than a document's 2,000,000 characters", () => {
    const routes = apiRoutes();
    expect(routes.length).toBeGreaterThan(40);
    const bounds = routes.flatMap(([file, source]) => Array.from(source.matchAll(/\.max\(([\d_]+)\)/g), (m) => ({ file, max: Number(m[1].replace(/_/g, "")) })));
    const largest = Math.max(...bounds.map((b) => b.max));
    expect(bounds.filter((b) => b.max === largest).map((b) => b.file).sort()).toEqual([
      "src/app/api/documents/[id]/content/route.ts",
      "src/app/api/documents/[id]/suggest/route.ts",
      "src/app/api/documents/route.ts",
    ]);
    expect(largest).toBe(DOCUMENT_MAX_CHARACTERS);
  });

  it("the MCP route keeps the SDK's default body bound", () => {
    expect(read("src", "app", "api", "mcp", "route.ts")).not.toContain("maxRequestBodySize");
  });
});

describe("the nginx reader in this file", () => {
  it("reads nginx sizes", () => {
    expect(nginxBytes("10m")).toBe(10 * MIB);
    expect(nginxBytes("8M")).toBe(8 * MIB);
    expect(nginxBytes("512k")).toBe(512 * 1024);
    expect(nginxBytes("1g")).toBe(1024 * MIB);
    expect(nginxBytes("4096")).toBe(4096);
    expect(nginxBytes("0")).toBe(0);
    expect(() => nginxBytes("10mb")).toThrow();
  });

  it("reads directives, nested blocks and comments", () => {
    const parsed = parseNginx("# client_max_body_size 1m;\nmap $a $b { default x; }\nserver { listen 443 ssl; client_max_body_size 10m; # 2m;\n location / { proxy_pass http://127.0.0.1:3000; } }\n");
    expect(parsed.blocks.map((b) => b.name)).toEqual(["map", "server"]);
    expect(every(parsed, "client_max_body_size")).toEqual([{ name: "client_max_body_size", args: "10m" }]);
    expect(every(parsed.blocks[1], "proxy_pass")).toHaveLength(1);
    expect(() => parseNginx("server { listen 443 ssl; ")).toThrow();
    expect(() => parseNginx("server { listen 443 ssl }")).toThrow();
  });
});
