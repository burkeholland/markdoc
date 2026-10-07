import { EventEmitter } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachRequestErrorGuards,
  attachUpgradeErrorGuard,
  CLIENT_GONE_CODES,
  errorCode,
  formatStreamErrorLine,
  isClientGone,
  type GuardedRequest,
  type GuardedResponse,
  type GuardedUpgradeSocket,
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

  it("names a websocket upgrade as `upgrade error`", () => {
    expect(formatStreamErrorLine("upgrade", { method: "GET", url: "/collab?token=secret" }, withCode("timed out", "ETIMEDOUT"))).toBe(
      "[http] upgrade error GET /collab ETIMEDOUT",
    );
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

describe("attachUpgradeErrorGuard", () => {
  function attachUpgrade(url = "/collab") {
    const lines: string[] = [];
    const socket = new EventEmitter();
    attachUpgradeErrorGuard({ method: "GET", url }, socket as unknown as GuardedUpgradeSocket, { write: (line) => lines.push(line) });
    return { socket, lines };
  }

  it("installs one error listener on the socket", () => {
    expect(attachUpgrade().socket.listenerCount("error")).toBe(1);
  });

  it.each([...CLIENT_GONE_CODES])("swallows %s without a line", (code) => {
    const { socket, lines } = attachUpgrade();
    expect(() => socket.emit("error", withCode("gone", code))).not.toThrow();
    expect(lines).toEqual([]);
  });

  it("writes one line for an error that is not a client leaving, without the message, and does not rethrow", () => {
    const { socket, lines } = attachUpgrade("/collab?token=secret");
    expect(() => socket.emit("error", withCode("secret /tmp/path in message", "EACCES"))).not.toThrow();
    expect(() => socket.emit("error", new TypeError("boom"))).not.toThrow();
    expect(lines).toEqual(["[http] upgrade error GET /collab EACCES", "[http] upgrade error GET /collab TypeError"]);
  });

  it("defaults to console.warn", () => {
    const warned: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args);
    try {
      const socket = new EventEmitter();
      attachUpgradeErrorGuard({ method: "GET", url: "/collab" }, socket as unknown as GuardedUpgradeSocket);
      socket.emit("error", withCode("read ECONNRESET", "ECONNRESET"));
      socket.emit("error", withCode("timed out", "ETIMEDOUT"));
    } finally {
      console.warn = original;
    }
    expect(warned).toEqual([["[http] upgrade error GET /collab ETIMEDOUT"]]);
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

// Websocket upgrades (#2311). While server/index.ts is starting it answers every upgrade itself with a
// 503, on a raw socket that Node hands over without any 'error' listener. The clients below leave at
// each moment around that answer; with the guard on first, none of them may reach the process.
describe("attachUpgradeErrorGuard on a real http server", () => {
  /** The answer server/index.ts writes to an upgrade while it is starting. */
  const STARTING = "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
  const TRIES = 25;
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

  interface StartingServer {
    port: number;
    guardLines: string[];
    /** Run inside the server's upgrade handler, around the answer; set per attempt. */
    hooks: { beforeAnswer?: () => void; afterAnswer?: (socket: Duplex) => void; serverSocketClosed?: () => void };
  }

  /** An http server that treats upgrades the way server/index.ts does before it is ready. */
  async function withStartingServer(guard: boolean, run: (server: StartingServer) => Promise<void>): Promise<void> {
    const starting: StartingServer = { port: 0, guardLines: [], hooks: {} };
    const server = http.createServer((_req, res) => {
      res.statusCode = 503;
      res.end("starting");
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
      const { hooks } = starting;
      socket.once("close", () => hooks.serverSocketClosed?.());
      hooks.beforeAnswer?.();
      if (guard) attachUpgradeErrorGuard(req, socket, { write: (line) => starting.guardLines.push(line) });
      socket.end(STARTING);
      hooks.afterAnswer?.(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    starting.port = (server.address() as AddressInfo).port;
    try {
      await run(starting);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  interface Leaving {
    beforeAnswer?: (client: net.Socket) => void;
    afterAnswer?: (client: net.Socket, serverSocket: Duplex) => void;
    onAnswer?: (client: net.Socket) => void;
  }

  /** One upgrade request on a raw connection; resolves with what the client received once both ends have closed. */
  function upgrade(server: StartingServer, leaving: Leaving = {}): Promise<string> {
    return new Promise((resolve) => {
      let received = "";
      let open = 2;
      const closed = () => {
        if (--open === 0) resolve(received);
      };
      const client = net.connect({ host: "127.0.0.1", port: server.port }, () => {
        client.write(`GET /collab?token=secret HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
      });
      server.hooks = {
        serverSocketClosed: closed,
        beforeAnswer: leaving.beforeAnswer && (() => leaving.beforeAnswer?.(client)),
        afterAnswer: leaving.afterAnswer && ((socket) => leaving.afterAnswer?.(client, socket)),
      };
      client.setEncoding("latin1");
      client.on("data", (text: string) => {
        received += text;
        leaving.onAnswer?.(client);
      });
      client.on("end", () => client.end());
      client.on("error", () => {});
      client.on("close", closed);
    });
  }

  async function stillStarting(port: number): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { connection: "close" } });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("starting");
  }

  const moments: [string, Leaving][] = [
    ["resets the connection before the answer is written", { beforeAnswer: (client) => client.resetAndDestroy() }],
    // An editor page that gave up waiting closes like this; on Windows the server then reads ECONNRESET.
    ["closes (no reset) before the answer is written", { beforeAnswer: (client) => client.destroy() }],
    ["resets the connection while the answer is on its way", { afterAnswer: (client) => client.resetAndDestroy() }],
    ["resets the connection after it received the answer", { onAnswer: (client) => client.resetAndDestroy() }],
  ];

  it.each(moments)(`survives ${TRIES} clients in a row, each of which %s`, async (_name, leaving) => {
    await withStartingServer(true, async (server) => {
      for (let i = 0; i < TRIES; i++) await upgrade(server, leaving);
      await sleep(50);
      expect(server.guardLines).toEqual([]);
      await stillStarting(server.port);
      expect(await upgrade(server)).toBe(STARTING);
    });
    expect(processErrors).toEqual([]);
  });

  it("still gives a patient client the whole 503 and closes the socket", async () => {
    await withStartingServer(true, async (server) => {
      for (let i = 0; i < 3; i++) expect(await upgrade(server)).toBe(STARTING);
      expect(server.guardLines).toEqual([]);
    });
    expect(processErrors).toEqual([]);
  });

  it("writes one line for a socket error that is not a client leaving, and nothing reaches the process", async () => {
    await withStartingServer(true, async (server) => {
      await upgrade(server, { afterAnswer: (_client, socket) => socket.destroy(withCode("secret /tmp/path in message", "EACCES")) });
      await sleep(50);
      expect(server.guardLines).toEqual(["[http] upgrade error GET /collab EACCES"]);
    });
    expect(processErrors).toEqual([]);
  });

  // The control: the same server without the guard. This is the bug itself, kept so that the tests above
  // cannot pass for the wrong reason (a platform or a Node version where a leaving client raises nothing).
  it("control: without the guard, a client that resets after the answer becomes an uncaughtException", async () => {
    // The test runner's own listeners would fail the run for the exception this test is about.
    const others = process.listeners("uncaughtException").filter((listener) => listener !== recordProcessError);
    for (const listener of others) process.off("uncaughtException", listener);
    try {
      await withStartingServer(false, async (server) => {
        await upgrade(server, { onAnswer: (client) => client.resetAndDestroy() });
        await sleep(50);
      });
    } finally {
      for (const listener of others) process.on("uncaughtException", listener);
    }
    expect(processErrors).toHaveLength(1);
    expect(isClientGone(processErrors[0])).toBe(true);
  });
});