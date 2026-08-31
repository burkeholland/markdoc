import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { describe, expect, it, vi } from "vitest";
import {
  acceptsBrotli,
  BROTLI_CONTENT_TYPES,
  resolveStaticAsset,
  resolveStaticBrotli,
  serveStaticBrotli,
  STATIC_CACHE_CONTROL,
  STATIC_CONTENT_TYPE_OPTIONS,
  type BrotliFileSystem,
} from "./static-brotli";

const staticRoot = path.resolve("/srv/markdoc/.next/static");
const inside = (...segments: string[]) => path.join(staticRoot, ...segments);

/** Pretends exactly the given files exist and remembers every path it was asked about. */
function fakeExists(files: string[]) {
  const asked: string[] = [];
  const existsSync = vi.fn((file: string) => {
    asked.push(file);
    return files.includes(file);
  });
  return { existsSync, asked };
}

function candidate(overrides: Partial<Parameters<typeof resolveStaticBrotli>[0]> = {}) {
  return {
    method: "GET",
    url: "/_next/static/chunks/app.js",
    acceptEncoding: "gzip, deflate, br",
    range: undefined,
    ...overrides,
  };
}

const APP_JS_BR = inside("chunks", "app.js.br");
const APP_CSS_BR = inside("chunks", "app.css.br");

describe("Next static asset headers this branch mirrors", () => {
  // Measured against `next build` + the custom server (Next 16.3.1) for /_next/static/chunks/*.js|css.
  it("uses Next's Content-Type values, charset included", () => {
    expect(BROTLI_CONTENT_TYPES[".js"]).toBe("application/javascript; charset=UTF-8");
    expect(BROTLI_CONTENT_TYPES[".css"]).toBe("text/css; charset=UTF-8");
    expect(Object.keys(BROTLI_CONTENT_TYPES)).toEqual([".js", ".css"]);
  });

  it("uses Next's Cache-Control for /_next/static/", () => {
    expect(STATIC_CACHE_CONTROL).toBe("public, max-age=31536000, immutable");
  });
});

describe("acceptsBrotli", () => {
  it.each([
    "br",
    "gzip, deflate, br",
    "gzip, deflate, br, zstd",
    "br;q=0.8, gzip;q=0.5",
    "gzip;q=1.0, br; q=0.001",
    "BR",
    " deflate ,br ",
  ])("accepts %j", (header) => {
    expect(acceptsBrotli(header)).toBe(true);
  });

  it.each(["br;q=0", "gzip, br;q=0, deflate", "br; q=0.000", "br;Q=0", "gzip, deflate", "identity", "*", "", "br;q=abc", "brotli", "xbr"])(
    "refuses %j",
    (header) => {
      expect(acceptsBrotli(header)).toBe(false);
    },
  );

  it("treats a missing header as no", () => {
    expect(acceptsBrotli(undefined)).toBe(false);
  });

  it("joins repeated headers", () => {
    expect(acceptsBrotli(["gzip", "br"])).toBe(true);
    expect(acceptsBrotli(["gzip", "br;q=0"])).toBe(false);
  });
});

describe("resolveStaticBrotli", () => {
  it("serves an existing .br for a browser-style Accept-Encoding", () => {
    const { existsSync } = fakeExists([APP_JS_BR]);
    expect(resolveStaticBrotli(candidate(), { staticRoot, existsSync })).toEqual({
      brotliPath: APP_JS_BR,
      headers: {
        "Content-Encoding": "br",
        Vary: "Accept-Encoding",
        "Content-Type": "application/javascript; charset=UTF-8",
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
    expect(existsSync).toHaveBeenCalledWith(APP_JS_BR);
  });

  it("serves .css with the stylesheet content type", () => {
    const { existsSync } = fakeExists([APP_CSS_BR]);
    const match = resolveStaticBrotli(candidate({ url: "/_next/static/chunks/app.css" }), { staticRoot, existsSync });
    expect(match?.brotliPath).toBe(APP_CSS_BR);
    expect(match?.headers["Content-Type"]).toBe("text/css; charset=UTF-8");
  });

  it("serves HEAD like GET", () => {
    const { existsSync } = fakeExists([APP_JS_BR]);
    expect(resolveStaticBrotli(candidate({ method: "HEAD" }), { staticRoot, existsSync })?.brotliPath).toBe(APP_JS_BR);
  });

  it("ignores the query string", () => {
    const { existsSync } = fakeExists([APP_JS_BR]);
    const match = resolveStaticBrotli(candidate({ url: "/_next/static/chunks/app.js?v=1&x=..%2f" }), { staticRoot, existsSync });
    expect(match?.brotliPath).toBe(APP_JS_BR);
  });

  it("falls through when br is refused with q=0", () => {
    const { existsSync } = fakeExists([APP_JS_BR]);
    expect(resolveStaticBrotli(candidate({ acceptEncoding: "gzip, deflate, br;q=0" }), { staticRoot, existsSync })).toBeNull();
    expect(resolveStaticBrotli(candidate({ acceptEncoding: "gzip" }), { staticRoot, existsSync })).toBeNull();
    expect(resolveStaticBrotli(candidate({ acceptEncoding: undefined }), { staticRoot, existsSync })).toBeNull();
    expect(existsSync).not.toHaveBeenCalled();
  });

  it("falls through when the .br file is missing", () => {
    const { existsSync } = fakeExists([]);
    expect(resolveStaticBrotli(candidate(), { staticRoot, existsSync })).toBeNull();
    expect(existsSync).toHaveBeenCalledWith(APP_JS_BR);
  });

  it("falls through on a Range request", () => {
    const { existsSync } = fakeExists([APP_JS_BR]);
    expect(resolveStaticBrotli(candidate({ range: "bytes=0-10" }), { staticRoot, existsSync })).toBeNull();
    expect(existsSync).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "OPTIONS", "DELETE", undefined])("falls through for method %s", (method) => {
    const { existsSync } = fakeExists([APP_JS_BR]);
    expect(resolveStaticBrotli(candidate({ method }), { staticRoot, existsSync })).toBeNull();
    expect(existsSync).not.toHaveBeenCalled();
  });

  it.each([
    "/_next/static/../../package.json",
    "/_next/static/../../package.js",
    "/_next/static/%2e%2e/x.js",
    "/_next/static/%2E%2E/x.js",
    "/_next/static/%2e%2e%2fx.js",
    "/_next/static/chunks\\..\\x.js",
    "/_next/static/chunks%5c..%5cx.js",
    "/_next/static/chunks%5C..%5C..%5Cpackage.js",
    "/_next/static/chunks/..%2f..%2fpackage.js",
    "/_next/static/%252e%252e/x.js",
    "/_next/static//etc/passwd.js",
    "/_next/static/C:/windows/x.js",
    "/_next/static/chunks/%00.js",
    "/_next/static/chunks/x%00.js",
    "/_next/static/chunks/%E0%A4%A.js",
    "/_next/static/",
    "/_next/static",
    "/_next/static/chunks/.js",
    "/_next/static/chunks/x.js/",
    "/_next/static/chunks/x.js/..",
    "/_next/statics/x.js",
    "/_next/x.js",
    "/api/health",
    "http://example.test/_next/static/chunks/app.js",
  ])("falls through for %j and never looks outside the root", (url) => {
    const { existsSync, asked } = fakeExists([APP_JS_BR]);
    expect(resolveStaticBrotli(candidate({ url }), { staticRoot, existsSync })).toBeNull();
    for (const file of asked) expect(file.startsWith(staticRoot + path.sep)).toBe(true);
  });

  it.each([
    "/_next/static/chunks/app.js.map",
    "/_next/static/media/inter.woff2",
    "/_next/static/media/logo.png",
    "/_next/static/chunks/app.JS",
    "/_next/static/chunks/app.js.br",
    "/_next/static/chunks/app",
    "/_next/static/chunks/app.json",
  ])("only serves .js and .css: %s falls through", (url) => {
    const { existsSync } = fakeExists([`${inside("chunks", "app.js.map")}.br`, `${inside("media", "inter.woff2")}.br`]);
    expect(resolveStaticBrotli(candidate({ url }), { staticRoot, existsSync })).toBeNull();
    expect(existsSync).not.toHaveBeenCalled();
  });
});

describe("resolveStaticAsset", () => {
  it("maps a chunk URL to the file under the static root", () => {
    expect(resolveStaticAsset("/_next/static/chunks/app.js", staticRoot)).toBe(inside("chunks", "app.js"));
    expect(resolveStaticAsset("/_next/static/css/a-b_c.css", staticRoot)).toBe(inside("css", "a-b_c.css"));
  });

  it("decodes once and keeps decoded names inside the root", () => {
    expect(resolveStaticAsset("/_next/static/chunks/%5Bid%5D.js", staticRoot)).toBe(inside("chunks", "[id].js"));
    expect(resolveStaticAsset("/_next/static/chunks/a%20b.js", staticRoot)).toBe(inside("chunks", "a b.js"));
  });

  it.each([
    "/_next/static/../package.js",
    "/_next/static/%2e%2e/package.js",
    "/_next/static/chunks\\..\\package.js",
    "/_next/static//abs/package.js",
    "/_next/static/chunks/../../package.js",
  ])("rejects %j", (url) => {
    expect(resolveStaticAsset(url, staticRoot)).toBeNull();
  });
});

type FakeResponse = Writable & { writeHead: (status: number, headers: Record<string, unknown>) => FakeResponse };

function fakeResponse() {
  const body: Buffer[] = [];
  const written: { status?: number; headers?: Record<string, unknown> } = {};
  const res = new Writable({
    write(chunk, _encoding, callback) {
      body.push(Buffer.from(chunk));
      callback();
    },
  }) as FakeResponse;
  res.writeHead = (status, headers) => {
    written.status = status;
    written.headers = headers;
    return res;
  };
  return { res: res as unknown as ServerResponse, body, written };
}

function fakeRequest(method: string, headers: Record<string, string | undefined>): IncomingMessage {
  return { method, url: "/_next/static/chunks/app.js", headers } as unknown as IncomingMessage;
}

function fakeFs(content: Buffer, options: { statFails?: boolean } = {}): BrotliFileSystem & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    existsSync: (file) => file === APP_JS_BR,
    statSync: (file) => {
      if (options.statFails || file !== APP_JS_BR) throw new Error("ENOENT");
      return { size: content.length };
    },
    createReadStream: (file) => {
      opened.push(file);
      return Readable.from([content]);
    },
  };
}

describe("serveStaticBrotli", () => {
  const content = Buffer.from("brotli bytes stand-in");

  it("streams the .br file with exactly the mirrored headers plus Content-Length", async () => {
    const fs = fakeFs(content);
    const { res, body, written } = fakeResponse();
    const handled = serveStaticBrotli(fakeRequest("GET", { "accept-encoding": "gzip, deflate, br, zstd" }), res, { staticRoot, fs });
    expect(handled).toBe(true);
    await finished(res);
    expect(written.status).toBe(200);
    expect(written.headers).toEqual({
      "Content-Encoding": "br",
      Vary: "Accept-Encoding",
      "Content-Type": "application/javascript; charset=UTF-8",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": content.length,
    });
    expect(Buffer.concat(body).equals(content)).toBe(true);
    expect(fs.opened).toEqual([APP_JS_BR]);
  });

  // Task #1224: nosniff on every response includes the chunks this branch answers without Next.
  it("a served chunk carries X-Content-Type-Options: nosniff on GET and HEAD, .js and .css alike", async () => {
    const fs = fakeFs(content);
    for (const method of ["GET", "HEAD"]) {
      const { res, written } = fakeResponse();
      expect(serveStaticBrotli(fakeRequest(method, { "accept-encoding": "br" }), res, { staticRoot, fs })).toBe(true);
      await finished(res);
      expect(written.headers?.["X-Content-Type-Options"], method).toBe("nosniff");
    }
    const { existsSync } = fakeExists([APP_CSS_BR]);
    const css = resolveStaticBrotli(candidate({ url: "/_next/static/chunks/app.css" }), { staticRoot, existsSync });
    expect(css?.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(STATIC_CONTENT_TYPE_OPTIONS).toBe("nosniff");
  });

  it("answers HEAD with the same headers and no body", async () => {
    const fs = fakeFs(content);
    const { res, body, written } = fakeResponse();
    expect(serveStaticBrotli(fakeRequest("HEAD", { "accept-encoding": "br" }), res, { staticRoot, fs })).toBe(true);
    await finished(res);
    expect(written.status).toBe(200);
    expect(written.headers?.["Content-Length"]).toBe(content.length);
    expect(written.headers?.["Content-Encoding"]).toBe("br");
    expect(body).toEqual([]);
    expect(fs.opened).toEqual([]);
  });

  it("writes nothing and falls through when the request does not qualify", () => {
    const fs = fakeFs(content);
    for (const headers of [{ "accept-encoding": "gzip" }, { "accept-encoding": "br;q=0" }, { "accept-encoding": "br", range: "bytes=0-1" }]) {
      const { res, written } = fakeResponse();
      expect(serveStaticBrotli(fakeRequest("GET", headers), res, { staticRoot, fs })).toBe(false);
      expect(written.status).toBeUndefined();
    }
    const { res, written } = fakeResponse();
    expect(serveStaticBrotli(fakeRequest("POST", { "accept-encoding": "br" }), res, { staticRoot, fs })).toBe(false);
    expect(written.status).toBeUndefined();
    expect(fs.opened).toEqual([]);
  });

  it("falls through untouched when the .br file vanished between exists and stat", () => {
    const fs = fakeFs(content, { statFails: true });
    const { res, written } = fakeResponse();
    expect(serveStaticBrotli(fakeRequest("GET", { "accept-encoding": "br" }), res, { staticRoot, fs })).toBe(false);
    expect(written.status).toBeUndefined();
    expect(fs.opened).toEqual([]);
  });
});
