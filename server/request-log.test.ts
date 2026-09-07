import { EventEmitter } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ABORTED_STATUS, attachRequestLog, formatRequestLine, HTTP_LOG_PREFIX, shouldLogResponse, type LoggedResponse } from "./request-log";

const DOCUMENT_URL = "/api/documents/k3j9x0v2m8qa/collaborators?after=5";
const DOCUMENT_SHAPE = "/api/documents/:id/collaborators";

describe("shouldLogResponse", () => {
  it.each([500, 501, 502, 503, 504, 599])("logs %i (every 5xx)", (status) => {
    expect(shouldLogResponse(status)).toBe(true);
  });

  it.each([400, 402, 403, 405, 409, 413, 415, 422, 429, 499])("logs %i (4xx other than 401/404)", (status) => {
    expect(shouldLogResponse(status)).toBe(true);
  });

  it.each([401, 404])("does not log %i", (status) => {
    expect(shouldLogResponse(status)).toBe(false);
  });

  it.each([101, 200, 201, 202, 204, 206, 301, 302, 304, 307, 308])("does not log %i", (status) => {
    expect(shouldLogResponse(status)).toBe(false);
  });

  it("logs a response that was aborted before headers (0 / undefined)", () => {
    expect(shouldLogResponse(ABORTED_STATUS)).toBe(true);
    expect(shouldLogResponse(undefined)).toBe(true);
    expect(ABORTED_STATUS).toBe(0);
  });
});

describe("formatRequestLine", () => {
  it("is `[http] <status> <METHOD> <route shape> <ms>ms` with the query string gone and ids redacted", () => {
    expect(formatRequestLine({ status: 400, method: "POST", url: DOCUMENT_URL, ms: 12 })).toBe(`${HTTP_LOG_PREFIX} 400 POST ${DOCUMENT_SHAPE} 12ms`);
    expect(HTTP_LOG_PREFIX).toBe("[http]");
  });

  it("rounds the elapsed time to whole milliseconds", () => {
    expect(formatRequestLine({ status: 500, method: "GET", url: "/api/health", ms: 0.4 })).toBe("[http] 500 GET /api/health 0ms");
    expect(formatRequestLine({ status: 500, method: "GET", url: "/api/health", ms: 12.6 })).toBe("[http] 500 GET /api/health 13ms");
    expect(formatRequestLine({ status: 500, method: "GET", url: "/api/health", ms: Number.NaN })).toBe("[http] 500 GET /api/health 0ms");
    expect(formatRequestLine({ status: 500, method: "GET", url: "/api/health", ms: -3 })).toBe("[http] 500 GET /api/health 0ms");
  });

  it("writes 0 for an aborted response and - for a missing method", () => {
    expect(formatRequestLine({ status: undefined, method: undefined, url: "/d/k3j9x0v2m8qa", ms: 30000 })).toBe("[http] 0 - /d/:id 30000ms");
    expect(formatRequestLine({ status: ABORTED_STATUS, method: "", url: undefined, ms: 1 })).toBe("[http] 0 - / 1ms");
  });

  it("never carries a login or token from the URL", () => {
    const line = formatRequestLine({ status: 403, method: "GET", url: "/api/github/repos/octocat/secret-repo?token=test-access-token", ms: 5 });
    expect(line).toBe("[http] 403 GET /api/github/repos/:x/:x 5ms");
  });
});

/** Just enough of ServerResponse for attachRequestLog, driven by hand. */
class FakeResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableFinished = false;

  /** Node's order for a response it sent: headers, body, `finish`, then `close`. */
  finish(status: number, options: { close?: boolean } = {}) {
    this.statusCode = status;
    this.headersSent = true;
    this.writableFinished = true;
    this.emit("finish");
    if (options.close !== false) this.emit("close");
  }

  /** The socket went away: only `close`, and `writableFinished` stays false. */
  abort(options: { headersSent?: boolean; status?: number } = {}) {
    if (options.status !== undefined) this.statusCode = options.status;
    this.headersSent = options.headersSent ?? false;
    this.emit("close");
  }
}

function fakeClock(stepMs: number) {
  // Nanoseconds, like process.hrtime.bigint(); BigInt() rather than a literal — tsconfig targets ES2017.
  let now = BigInt(1_000_000_000);
  return () => {
    const value = now;
    now += BigInt(Math.round(stepMs * 1e6));
    return value;
  };
}

function attach(url = DOCUMENT_URL, method = "POST", stepMs = 12) {
  const lines: string[] = [];
  const res = new FakeResponse();
  attachRequestLog({ method, url }, res as unknown as LoggedResponse, { now: fakeClock(stepMs), write: (line) => lines.push(line) });
  return { res, lines };
}

describe("attachRequestLog", () => {
  it.each([200, 201, 204, 302, 304])("writes nothing for a %i", (status) => {
    const { res, lines } = attach();
    res.finish(status);
    expect(lines).toEqual([]);
  });

  it("writes nothing for a 404", () => {
    const { res, lines } = attach("/api/nope");
    res.finish(404);
    expect(lines).toEqual([]);
  });

  it("writes nothing for a 401", () => {
    const { res, lines } = attach("/api/me", "GET");
    res.finish(401);
    expect(lines).toEqual([]);
  });

  it("writes one line for a 400, with the route shape and the elapsed time", () => {
    const { res, lines } = attach();
    res.finish(400);
    expect(lines).toEqual([`[http] 400 POST ${DOCUMENT_SHAPE} 12ms`]);
  });

  it("writes one line for a 500", () => {
    const { res, lines } = attach("/api/documents/k3j9x0v2m8qa/export?format=pdf", "GET", 2500.4);
    res.finish(500);
    expect(lines).toEqual(["[http] 500 GET /api/documents/:id/export 2500ms"]);
  });

  it("writes one line with status 0 for a response aborted before headers, whatever statusCode defaulted to", () => {
    const { res, lines } = attach("/d/k3j9x0v2m8qa", "GET", 30000);
    expect(res.statusCode).toBe(200);
    res.abort();
    expect(lines).toEqual(["[http] 0 GET /d/:id 30000ms"]);
  });

  it("uses the sent status for a response aborted after its headers went out", () => {
    const ok = attach("/api/assets/q7w2e9r4t1y6u3i8", "GET");
    ok.res.abort({ headersSent: true, status: 200 });
    expect(ok.lines).toEqual([]);
    const failed = attach("/api/assets/q7w2e9r4t1y6u3i8", "GET");
    failed.res.abort({ headersSent: true, status: 502 });
    expect(failed.lines).toEqual(["[http] 502 GET /api/assets/:id 12ms"]);
  });

  it("writes exactly one line when finish and close both fire", () => {
    const { res, lines } = attach();
    res.finish(400, { close: true });
    res.emit("close");
    res.emit("finish");
    expect(lines).toHaveLength(1);
  });

  it("writes exactly one line when close fires without finish, then finish arrives late", () => {
    const { res, lines } = attach();
    res.abort();
    res.finish(400);
    expect(lines).toEqual([`[http] 0 POST ${DOCUMENT_SHAPE} 12ms`]);
  });

  it("measures from attach to the end of the response", () => {
    const { res, lines } = attach("/api/health", "GET", 7.4);
    res.finish(503);
    expect(lines).toEqual(["[http] 503 GET /api/health 7ms"]);
  });
});

// The fakes above assume Node's ServerResponse emits `finish` for a sent response and only `close` for
// one the client walked away from. One real server on a loopback port the OS picks proves that.
describe("attachRequestLog on a real http server", () => {
  async function withServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    run: (port: number) => Promise<void>,
  ): Promise<void> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await run((server.address() as AddressInfo).port);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("logs a 400 and a 500 once each and a 200, 401 and 404 not at all", async () => {
    const lines: string[] = [];
    const ended: Promise<void>[] = [];
    await withServer(
      (req, res) => {
        ended.push(new Promise<void>((resolve) => res.once("close", resolve)));
        attachRequestLog(req, res, { write: (line) => lines.push(line) });
        const status = Number(new URL(req.url ?? "/", "http://x").searchParams.get("status"));
        if (status === 500) {
          // The shape of the `[http] request failed` catch in server/index.ts.
          Promise.reject(new Error("boom")).catch(() => {
            if (!res.headersSent) res.statusCode = 500;
            res.end("internal server error");
          });
          return;
        }
        res.statusCode = status;
        res.end(JSON.stringify({ status }));
      },
      async (port) => {
        for (const status of [200, 401, 404, 400, 500]) {
          const response = await fetch(`http://127.0.0.1:${port}/api/documents/k3j9x0v2m8qa/collaborators?status=${status}`, {
            method: "POST",
            headers: { connection: "close" },
          });
          expect(response.status).toBe(status);
          await response.text();
        }
        await Promise.all(ended);
      },
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[http\] 400 POST \/api\/documents\/:id\/collaborators \d+ms$/);
    expect(lines[1]).toMatch(/^\[http\] 500 POST \/api\/documents\/:id\/collaborators \d+ms$/);
  });

  it("logs status 0 once when the client goes away before any header is written", async () => {
    const lines: string[] = [];
    let closed!: Promise<void>;
    let received!: () => void;
    const arrived = new Promise<void>((resolve) => (received = resolve));
    await withServer(
      (req, res) => {
        attachRequestLog(req, res, { write: (line) => lines.push(line) });
        closed = new Promise<void>((resolve) => res.once("close", resolve));
        received();
        // Never answers: the client hangs up first.
      },
      async (port) => {
        const request = http.request({ host: "127.0.0.1", port, path: "/d/k3j9x0v2m8qa?embed=1", method: "GET" });
        request.on("error", () => {});
        request.end();
        await arrived;
        request.destroy();
        await closed;
      },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[http\] 0 GET \/d\/:id \d+ms$/);
  });
});
