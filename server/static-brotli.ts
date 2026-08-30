import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

// Precompressed brotli for the immutable client assets. scripts/precompress-static.mjs writes
// `<file>.br` next to every `.js`/`.css` under `<distDir>/static` at build time; in production the
// custom server answers `Accept-Encoding: br` for /_next/static/** from those files and leaves every
// other request (no `.br`, Range, other methods, dev mode, undecodable URL) to Next, whose built-in
// gzip keeps working exactly as before.

export const STATIC_URL_PREFIX = "/_next/static/";

/** Content types Next (send/mime) answers for the two asset kinds that get a `.br` sibling. */
export const BROTLI_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "application/javascript; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
};

/** What Next sends for every /_next/static/ asset (hashed file names, so immutable). */
export const STATIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

export type BrotliCandidate = {
  method: string | undefined;
  url: string | undefined;
  acceptEncoding: string | string[] | undefined;
  range: string | string[] | undefined;
};

export type BrotliResponseHeaders = {
  "Content-Encoding": "br";
  Vary: "Accept-Encoding";
  "Content-Type": string;
  "Cache-Control": string;
};

export type BrotliMatch = {
  /** Absolute path of the `.br` file to stream. */
  brotliPath: string;
  /** Every response header except Content-Length, which comes from the `.br` file's size. */
  headers: BrotliResponseHeaders;
};

/** Rejected before and after decoding: dot segments, encoded separators, backslashes and NULs. */
const FORBIDDEN_PATH_PATTERN = /\.\.|%2e|%2f|%5c|\\|\0/i;

/**
 * True when the Accept-Encoding header explicitly lists `br` with a non-zero quality, e.g.
 * `gzip, deflate, br, zstd`, `br;q=0.8`, `BR`. `br;q=0`, `*`, an unparsable q or a missing header
 * mean "no": the request then goes to Next unchanged.
 */
export function acceptsBrotli(acceptEncoding: string | string[] | undefined): boolean {
  if (acceptEncoding === undefined) return false;
  const value = Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : acceptEncoding;
  for (const entry of value.split(",")) {
    const [coding, ...params] = entry.split(";").map((part) => part.trim());
    if (coding.toLowerCase() !== "br") continue;
    let quality = 1;
    for (const param of params) {
      const eq = param.indexOf("=");
      if (eq === -1 || param.slice(0, eq).trim().toLowerCase() !== "q") continue;
      const parsed = Number(param.slice(eq + 1).trim());
      quality = Number.isFinite(parsed) ? parsed : 0;
    }
    return quality > 0;
  }
  return false;
}

/**
 * Maps a request URL to the asset it names under `staticRoot`, or null when the URL is not a
 * /_next/static/ `.js`/`.css` path or tries to leave the root. Decodes exactly once; anything with `..`,
 * `%2e`, `%2f`, `%5c`, a backslash or a NUL (before or after decoding) is rejected, and the resolved
 * path must stay strictly inside `staticRoot`.
 */
export function resolveStaticAsset(url: string, staticRoot: string): string | null {
  const queryAt = url.indexOf("?");
  const rawPath = queryAt === -1 ? url : url.slice(0, queryAt);
  if (!rawPath.startsWith(STATIC_URL_PREFIX)) return null;
  if (FORBIDDEN_PATH_PATTERN.test(rawPath)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (FORBIDDEN_PATH_PATTERN.test(decoded)) return null;
  const relative = decoded.slice(STATIC_URL_PREFIX.length);
  if (relative === "" || relative.startsWith("/")) return null;
  const extension = path.posix.extname(relative);
  if (!(extension in BROTLI_CONTENT_TYPES)) return null;
  const root = path.resolve(staticRoot);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/**
 * The whole decision, side-effect free: which `.br` file to stream and with which headers, or null to
 * fall through to Next. `existsSync` is injected so the rule can be tested without a file system.
 */
export function resolveStaticBrotli(
  candidate: BrotliCandidate,
  options: { staticRoot: string; existsSync: (file: string) => boolean },
): BrotliMatch | null {
  if (candidate.method !== "GET" && candidate.method !== "HEAD") return null;
  if (candidate.url === undefined) return null;
  if (candidate.range !== undefined) return null;
  if (!acceptsBrotli(candidate.acceptEncoding)) return null;
  const asset = resolveStaticAsset(candidate.url, options.staticRoot);
  if (asset === null) return null;
  const contentType: string | undefined = BROTLI_CONTENT_TYPES[path.extname(asset)];
  if (contentType === undefined) return null;
  const brotliPath = `${asset}.br`;
  if (!options.existsSync(brotliPath)) return null;
  return {
    brotliPath,
    headers: {
      "Content-Encoding": "br",
      Vary: "Accept-Encoding",
      "Content-Type": contentType,
      "Cache-Control": STATIC_CACHE_CONTROL,
    },
  };
}

export type BrotliFileSystem = {
  existsSync: (file: string) => boolean;
  statSync: (file: string) => { size: number };
  createReadStream: (file: string) => NodeJS.ReadableStream & { destroy?: () => void };
};

const nodeFs: BrotliFileSystem = { existsSync, statSync, createReadStream };

/**
 * Answers the request from the precompressed file when resolveStaticBrotli matches; returns false
 * (having written nothing) whenever the caller should hand the request to Next instead.
 */
export function serveStaticBrotli(
  req: IncomingMessage,
  res: ServerResponse,
  options: { staticRoot: string; fs?: BrotliFileSystem },
): boolean {
  const fs = options.fs ?? nodeFs;
  const match = resolveStaticBrotli(
    { method: req.method, url: req.url, acceptEncoding: req.headers["accept-encoding"], range: req.headers.range },
    { staticRoot: options.staticRoot, existsSync: fs.existsSync },
  );
  if (match === null) return false;
  let size: number;
  try {
    size = fs.statSync(match.brotliPath).size;
  } catch {
    return false;
  }
  res.writeHead(200, { ...match.headers, "Content-Length": size });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  const stream = fs.createReadStream(match.brotliPath);
  // Headers are already out, so a read error mid-stream cannot become a Next response; cut the
  // connection so the client sees a truncated body rather than a corrupt one.
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy?.());
  stream.pipe(res);
  return true;
}
