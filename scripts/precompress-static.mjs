import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

// Precompress the immutable client assets once, at build time, so the custom server can answer
// `Accept-Encoding: br` for /_next/static/** by streaming `<file>.br` (server/static-brotli.ts) instead
// of spending CPU per request. Next's own `compress` (gzip on the fly) stays as the fallback for every
// other client. Same dist dir rule as next.config.ts.
const distDir = process.env.NEXT_DIST_DIR || ".next";
const staticRoot = path.resolve(process.cwd(), distDir, "static");

/** Only text assets; fonts and images under static/media are already compressed. */
const EXTENSIONS = new Set([".js", ".css"]);
/** Below this size the brotli framing eats most of the gain and a second file is not worth it. */
const MIN_BYTES = 1024;
const QUALITY = 11;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

const started = performance.now();
let written = 0;
let notSmaller = 0;
let bytesBefore = 0;
let bytesAfter = 0;

for (const file of walk(staticRoot)) {
  if (!EXTENSIONS.has(path.extname(file))) continue;
  const input = readFileSync(file);
  if (input.length < MIN_BYTES) continue;
  const output = brotliCompressSync(input, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: input.length,
    },
  });
  if (output.length >= input.length) {
    notSmaller += 1;
    continue;
  }
  writeFileSync(`${file}.br`, output);
  written += 1;
  bytesBefore += input.length;
  bytesAfter += output.length;
}

const seconds = ((performance.now() - started) / 1000).toFixed(1);
const ratio = bytesBefore > 0 ? ` (${((bytesAfter / bytesBefore) * 100).toFixed(1)} %)` : "";
console.log(
  `> precompress-static: ${written} .br file(s) under ${path.relative(process.cwd(), staticRoot)}, ` +
    `${bytesBefore} -> ${bytesAfter} B${ratio}, brotli q${QUALITY}, ${seconds} s` +
    (notSmaller > 0 ? `, ${notSmaller} skipped (not smaller)` : ""),
);
