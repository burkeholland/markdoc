import { EventEmitter } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachRequestErrorGuards,
  CLIENT_GONE_CODES,
  errorCode,
  formatStreamErrorLine,
  isClientGone,
  type GuardedRequest,
  type GuardedResponse,
} from "./request-guards";
import { attachRequestLog } from "./request-log";

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });
/** What Node's abortIncoming() hands to req.destroy(): connResetException('aborted'). */
const aborted = () => withCode("aborted", "ECONNRESET");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("isClientGone / errorCode", () => {
  it.each([...CLIENT_GONE_CODES])("treats %s as the client going away", (code) => {
    expect(isClientGone(withCode("x", code))).toBe(true);
  });

  it("does not treat a write after end, a plain Error or a non-error as the client going away", () => {
    expect(isClientGone(withCode("write after end", "ERR_STREAM_WRITE_AFTER_END"))).toBe(false);
    expect(isClientGone(new Error("aborted"))).toBe(false);
    expect(isClientGone("aborted")).toBe(false);
    expect(isClientGone(undefined)).toBe(false);
  });

  it("reads the code, else the error's name, else unknown", () => {
    expect(errorCode(aborted())).toBe("ECONNRESET");
    expect(errorCode(new TypeError("no code"))).toBe("TypeError");
    expect(errorCode(Object.assign(new Error("empty code"), { code: "" }))).toBe("Error");
    expect(errorCode("string")).toBe("unknown");
    expect(errorCode(null)).toBe("unknown");
  });
});

describe("formatStreamErrorLine", () => {
  it("is `[http] <side> error <METHOD> <route shape> <code>` with the query string gone and ids redacted", () => {
    const req = { method: "POST", url: "/api/documents/k3j9x0v2m8qa/import?token=******" };
    expect(formatStreamErrorLine("request", req, withCode("write after end", "ERR_STREAM_WRITE_AFTER_END"))).toBe(
      "[http] request error POST /api/documents/:id/import ERR_STREAM_WRITE_AFTER_END",
    );
    expect(formatStreamErrorLine("response", req, new TypeError("boom"))).toBe("[http] response error POST /api/documents/:id/import TypeError");
  });

  it("writes - for a missing method and never the error message", () => {
    const line = formatStreamErrorLine("request", { method: undefined, url: "/d/k3j9x0v2m8qa" }, withCode("secret /tmp/path in message", "EACCES"));
    expect(line).toBe("[http] request error - /d/:id EACCES");
    expect(line).not.toContain("secret");
  });
});

/** Just enough of IncomingMessage / ServerResponse for the guards, driven by hand. */
class FakeStream extends EventEmitter {
  constructor(public method: string | undefined = "POST", public url: string | undefined = "/api/documents") {
    super();
  }
}

function attach(method = "POST", url = "/api/documents") {
  const lines: string[] = [];
  const req = new FakeStream(method, url);
  const res = new FakeStream();
  attachRequestErrorGuards(req as unknown as GuardedRequest, res as unknown as GuardedResponse, { write: (line) => lines.push(line) });
  return { req, res, lines };
}

describe("attachRequestErrorGuards", () => {
  it("installs one error listener on each side", () => {
    const { req, res } = attach();
    expect(req.listenerCount("error")).toBe(1);
    expect(res.listenerCount("error")).toBe(1);
  });

  it.each([...CLIENT_GONE_CODES])("swallows %s on the request and the response without a line", (code) => {
    const { req, res, lines } = attach();
    expect(() => req.emit("error", withCode("gone", code))).not.toThrow();
    expect(() => res.emit("error", withCode("gone", code))).not.toThrow();
    expect(lines).toEqual([]);
  });

  it("writes one line per unexpected error and does not rethrow", () => {
    const { req, res, lines } = attach("GET", "/api/documents/k3j9x0v2m8qa/export?format=pdf");
    expect(() => req.emit("error", withCode("bad", "ERR_HTTP_INVALID_HEADER_VALUE"))).not.toThrow();
    expect(() => res.emit("error", withCode("write after end", "ERR_STREAM_WRITE_AFTER_END"))).not.toThrow();
    expect(lines).toEqual([
      "[http] request error GET /api/documents/:id/export ERR_HTTP_INVALID_HEADER_VALUE",
      "[http] response error GET /api/documents/:id/export ERR_STREAM_WRITE_AFTER_END",
    ]);
  });

  it("defaults to console.warn", () => {
    const warned: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args);
    try {
      const req = new FakeStream("GET", "/api/health");
      const res = new FakeStream();
      attachRequestErrorGuards(req as unknown as GuardedRequest, res as unknown as GuardedResponse);
      req.emit("error", aborted());
      res.emit("error", withCode("write after end", "ERR_STREAM_WRITE_AFTER_END"));
    } finally {
      console.warn = original;
    }
    expect(warned).toEqual([["[http] response error GET /api/health ERR_STREAM_WRITE_AFTER_END"]]);
  });
});

// The real thing: a loopback http server, a raw socket that sends part of a body and hangs up, another
// that hangs up while a large response is being written. The process must not see an uncaughtException
// (a temporary spy records any; server/index.ts would exit(1) on one) and the server must still answer.
describe("attachRequestErrorGuards on a real http server", () => {
  const processErrors: unknown[] = [];
  const recordProcessError = (err: unknown) => void processErrors.push(err);

  beforeEach(() => {
    processErrors.length = 0;
    process.on("uncaughtException", recordProcessError);
    process.on("unhandledRejection", recordProcessError);
  });

  afterEach(() => {
    process.off("uncaughtException", recordProcessError);
    process.off("unhandledRejection", recordProcessError);
  });

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

  /** Opens a raw connection, writes the request head and `bodyBytes` of a `contentLength` body, then destroys the socket after `holdMs`. */
  function sendPartialBodyThenHangUp(port: number, options: { path: string; method?: string; contentLength?: number; bodyBytes?: number; holdMs?: number }): Promise<void> {
    const { path, method = "POST", contentLength = 200_000, bodyBytes = 1000, holdMs = 100 } = options;
    return new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.write(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${contentLength}\r\n\r\n`);
        socket.write(`{"content":"${"x".repeat(bodyBytes - 13)}`);
        setTimeout(() => socket.destroy(), holdMs);
      });
      socket.on("error", () => {});
      socket.on("close", () => resolve());
    });
  }

  async function stillAnswers(port: number): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { connection: "close" } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  }

  it("survives a client that hangs up mid-body while the handler is reading it; the request log still writes its one line", async () => {
    const guardLines: string[] = [];
    const logLines: string[] = [];
    const seenByRequest: unknown[] = [];
    let bodyReadError: unknown;
    let closed!: Promise<void>;
    await withServer(
      (req, res) => {
        attachRequestErrorGuards(req, res, { write: (line) => guardLines.push(line) });
        attachRequestLog(req, res, { write: (line) => logLines.push(line) });
        if (req.url === "/api/health") {
          res.end("ok");
          return;
        }
        closed = new Promise<void>((resolve) => res.once("close", resolve));
        // A second listener only observes: it proves the abort surfaces as an 'error' event on req here.
        req.on("error", (err) => seenByRequest.push(err));
        void (async () => {
          try {
            // Reads slowly, like a route parsing a large body while the client goes away.
            for await (const chunk of req) {
              expect(chunk.length).toBeGreaterThan(0);
              await sleep(20);
            }
            res.end("done");
          } catch (err) {
            bodyReadError = err;
          }
        })();
      },
      async (port) => {
        await sendPartialBodyThenHangUp(port, { path: "/api/documents/k3j9x0v2m8qa/import?x=1" });
        await closed;
        await sleep(50);
        await stillAnswers(port);
      },
    );
    expect(seenByRequest).toHaveLength(1);
    expect(seenByRequest[0]).toMatchObject({ message: "aborted", code: "ECONNRESET" });
    expect(bodyReadError).toMatchObject({ message: "aborted", code: "ECONNRESET" });
    expect(guardLines).toEqual([]);
    expect(logLines).toEqual([expect.stringMatching(/^\[http\] 0 POST \/api\/documents\/:id\/import \d+ms$/)]);
    expect(processErrors).toEqual([]);
  });

  it("survives a client that hangs up mid-body when nothing reads the body (401 before the body, a page route with a body)", async () => {
    const guardLines: string[] = [];
    let closed!: Promise<void>;
    await withServer(
      (req, res) => {
        attachRequestErrorGuards(req, res, { write: (line) => guardLines.push(line) });
        if (req.url === "/api/health") {
          res.end("ok");
          return;
        }
        closed = new Promise<void>((resolve) => res.once("close", resolve));
        // Never answers and never reads: the client hangs up first.
      },
      async (port) => {
        await sendPartialBodyThenHangUp(port, { path: "/d/k3j9x0v2m8qa", method: "GET" });
        await closed;
        await sleep(50);
        await stillAnswers(port);
      },
    );
    expect(guardLines).toEqual([]);
    expect(processErrors).toEqual([]);
  });

  it("survives a client that hangs up while the handler is writing a large response", async () => {
    const guardLines: string[] = [];
    const logLines: string[] = [];
    let closed!: Promise<void>;
    let wroteAfterClose = false;
    await withServer(
      (req, res) => {
        attachRequestErrorGuards(req, res, { write: (line) => guardLines.push(line) });
        attachRequestLog(req, res, { write: (line) => logLines.push(line) });
        if (req.url === "/api/health") {
          res.end("ok");
          return;
        }
        closed = new Promise<void>((resolve) => res.once("close", resolve));
        res.writeHead(200, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let remaining = 64;
        const pump = () => {
          while (remaining > 0) {
            remaining--;
            if (!res.write(chunk)) {
              res.once("drain", pump);
              return;
            }
          }
          res.end();
        };
        pump();
        // A streaming export keeps writing until it notices the client left; the writes after `close`
        // must be as harmless as the ones before.
        res.once("close", () => {
          if (remaining > 0) {
            remaining = 0;
            wroteAfterClose = true;
            res.write(chunk);
            res.end();
          }
        });
      },
      async (port) => {
        await new Promise<void>((resolve) => {
          const socket = net.connect({ host: "127.0.0.1", port }, () => {
            socket.write(`GET /api/documents/k3j9x0v2m8qa/export?format=pdf HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
          });
          let received = 0;
          socket.on("data", (data) => {
            received += data.length;
            if (received > 100_000) socket.destroy();
          });
          socket.on("error", () => {});
          socket.on("close", () => resolve());
        });
        await closed;
        await sleep(50);
        await stillAnswers(port);
      },
    );
    expect(wroteAfterClose).toBe(true);
    expect(guardLines).toEqual([]);
    // Headers went out with 200 before the hang-up: nothing to log.
    expect(logLines).toEqual([]);
    expect(processErrors).toEqual([]);
  });

  it("turns a write after end on the response into one line instead of an uncaughtException", async () => {
    const guardLines: string[] = [];
    let finished!: Promise<void>;
    await withServer(
      (req, res) => {
        attachRequestErrorGuards(req, res, { write: (line) => guardLines.push(line) });
        if (req.url === "/api/health") {
          res.end("ok");
          return;
        }
        finished = new Promise<void>((resolve) => res.once("finish", resolve));
        res.end("done");
        // Without a listener this 'error' would be the process's last event.
        res.write("late");
      },
      async (port) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/documents/k3j9x0v2m8qa/versions`, { method: "POST", headers: { connection: "close" } });
        expect(await response.text()).toBe("done");
        await finished;
        await sleep(50);
        await stillAnswers(port);
      },
    );
    expect(guardLines).toEqual(["[http] response error POST /api/documents/:id/versions ERR_STREAM_WRITE_AFTER_END"]);
    expect(processErrors).toEqual([]);
  });
});
