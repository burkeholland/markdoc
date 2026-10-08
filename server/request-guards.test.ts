import { EventEmitter } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { Hocuspocus } from "@hocuspocus/server";
import next from "next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { attachCollab, COLLAB_PATH, COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS, protectUpgradePath } from "../src/server/collab/ws";
import {
  ANSWERED_UPGRADE_CLOSE_MS,
  answerUpgrade,
  attachRequestErrorGuards,
  attachUpgradeErrorGuard,
  CLIENT_GONE_CODES,
  closeHttpIntake,
  createOwnedUpgradeSockets,
  createRequestsInFlight,
  errorCode,
  formatClosedUpgradeSocketsLine,
  formatStreamErrorLine,
  installOtherUpgradeListeners,
  isClientGone,
  rejectUnparseableUpgrade,
  setupNextUpgradeListener,
  STARTING_UPGRADE_ANSWER,
  UNKNOWN_UPGRADE_ANSWER,
  UNPARSEABLE_UPGRADE_ANSWER,
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

// Issue #2321: the answer to a websocket upgrade whose request target or Host header cannot be parsed.
describe("rejectUnparseableUpgrade", () => {
  function reject(req: { method?: string; url?: string }) {
    const lines: string[] = [];
    // autoDestroy off: only the function under test may destroy this socket.
    const socket = new PassThrough({ autoDestroy: false });
    const seen = { errorListenersAtAnswer: -1, answer: "" };
    const end = socket.end.bind(socket) as (chunk: string) => PassThrough;
    socket.end = ((chunk: string) => {
      seen.errorListenersAtAnswer = socket.listenerCount("error");
      seen.answer = chunk;
      return end(chunk);
    }) as typeof socket.end;
    socket.resume();
    rejectUnparseableUpgrade(req, socket, { write: (line) => lines.push(line) });
    return { socket, lines, seen };
  }

  it("guards the socket first, writes one fixed line, answers a plain 400 and destroys the socket once the answer is flushed", async () => {
    const { socket, lines, seen } = reject({ method: "GET", url: "//secret-host/secret-path?token=secret" });
    expect(seen.errorListenersAtAnswer).toBe(1);
    expect(seen.answer).toBe(UNPARSEABLE_UPGRADE_ANSWER);
    expect(UNPARSEABLE_UPGRADE_ANSWER).toBe("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    expect(lines).toEqual(["[http] upgrade error GET :unparseable ERR_INVALID_URL"]);
    expect(socket.destroyed).toBe(false);
    await new Promise<void>((resolve) => socket.once("finish", resolve));
    expect(socket.destroyed).toBe(true);
  });

  it("keeps the guard: a client that left is silent, another socket error is one line without the target", () => {
    const { socket, lines } = reject({ method: "GET", url: "//secret?token=secret" });
    lines.length = 0;
    expect(() => socket.emit("error", withCode("read ECONNRESET", "ECONNRESET"))).not.toThrow();
    expect(() => socket.emit("error", withCode("secret /tmp/path in message", "EACCES"))).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[http\] upgrade error GET \S+ EACCES$/);
    expect(lines[0]).not.toContain("secret");
  });

  it("writes `-` for a missing method and defaults to console.warn", () => {
    const warned: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args);
    try {
      rejectUnparseableUpgrade({ url: "//" }, new PassThrough().resume());
    } finally {
      console.warn = original;
    }
    expect(warned).toEqual([["[http] upgrade error - :unparseable ERR_INVALID_URL"]]);
  });

  // Issue #2328: the 400 is in the owned set, so an answer that is never flushed does not keep the socket.
  it("destroys the socket after the close time when the answer is never flushed", async () => {
    const sockets = createOwnedUpgradeSockets(40);
    // A socket whose write never completes: 'finish' never comes.
    const socket = new Duplex({ read() {}, write() {} });
    rejectUnparseableUpgrade({ method: "GET", url: "//" }, socket, { write: () => {}, sockets });
    expect(sockets.size).toBe(1);
    expect(socket.destroyed).toBe(false);
    await new Promise<void>((resolve) => socket.once("close", resolve));
    expect(socket.destroyed).toBe(true);
    expect(sockets.size).toBe(0);
  });
});

// Issue #2328: after the server was ready, a websocket upgrade on a path that was not the collaboration
// path got no answer, and its socket stayed open after the client had left; a client that kept the 503
// of the start-up open stayed too. `server.close()` waits for every such socket, so one of them made a
// normal stop run into its deadline and exit 1 with the database still open.
describe("the set of upgrade sockets the server owns", () => {
  it("remembers a socket until it closes and destroys it after the close time", async () => {
    const sockets = createOwnedUpgradeSockets(40);
    const socket = new PassThrough({ autoDestroy: false }).resume();
    sockets.end(socket, "answer");
    expect(sockets.size).toBe(1);
    expect(socket.writableEnded).toBe(true);
    expect(socket.destroyed).toBe(false);
    await new Promise<void>((resolve) => socket.once("close", resolve));
    expect(socket.destroyed).toBe(true);
    expect(sockets.size).toBe(0);
  });

  it("puts the guard on before it writes the answer", () => {
    const sockets = createOwnedUpgradeSockets(60_000);
    const lines: string[] = [];
    const socket = new PassThrough({ autoDestroy: false });
    let errorListenersAtAnswer = -1;
    const end = socket.end.bind(socket) as (chunk: string) => PassThrough;
    socket.end = ((chunk: string) => {
      errorListenersAtAnswer = socket.listenerCount("error");
      return end(chunk);
    }) as typeof socket.end;
    socket.resume();
    answerUpgrade({ method: "GET", url: "/other?token=secret" }, socket, UNKNOWN_UPGRADE_ANSWER, { sockets, write: (line) => void lines.push(line) });
    expect(errorListenersAtAnswer).toBe(1);
    expect(() => socket.emit("error", withCode("read ECONNRESET", "ECONNRESET"))).not.toThrow();
    expect(() => socket.emit("error", withCode("secret /tmp/path in message", "EACCES"))).not.toThrow();
    expect(lines).toEqual(["[http] upgrade error GET /:x EACCES"]);
    expect(sockets.destroyAll()).toBe(1);
  });

  it("forgets a socket that closed by itself before the close time", async () => {
    const sockets = createOwnedUpgradeSockets(60_000);
    const answered = new PassThrough().resume();
    const tracked = new PassThrough().resume();
    sockets.end(answered, "answer");
    sockets.track(tracked);
    expect(sockets.size).toBe(2);
    tracked.destroy();
    await Promise.all([answered, tracked].map((socket) => new Promise<void>((resolve) => socket.once("close", resolve))));
    expect(sockets.size).toBe(0);
    expect(sockets.destroyAll()).toBe(0);
  });

  it("never destroys a socket it only tracks until it is told to destroy them all", async () => {
    const sockets = createOwnedUpgradeSockets(20);
    const tracked = new PassThrough({ autoDestroy: false }).resume();
    sockets.track(tracked);
    await sleep(80);
    expect(tracked.destroyed).toBe(false);
    expect(sockets.destroyAll()).toBe(1);
    expect(tracked.destroyed).toBe(true);
    expect(sockets.size).toBe(0);
  });

  it("does not keep a socket that was already destroyed", () => {
    const sockets = createOwnedUpgradeSockets(60_000);
    const gone = new PassThrough();
    gone.on("error", () => {});
    gone.destroy();
    sockets.track(gone);
    sockets.end(gone, "answer");
    expect(sockets.size).toBe(0);
  });

  // A socket that was destroyed in this very loop turn is still in the set (its 'close' comes a turn
  // later). The line says how many sockets were OPEN, so the sweep must not count that one.
  it("does not count a socket that was destroyed a moment before the sweep", () => {
    const sockets = createOwnedUpgradeSockets(60_000);
    const open = new PassThrough({ autoDestroy: false }).resume();
    const dying = new PassThrough({ autoDestroy: false }).resume();
    sockets.end(open, "answer");
    sockets.end(dying, "answer");
    dying.destroy();
    expect(sockets.size).toBe(2);
    expect(sockets.destroyAll()).toBe(1);
    expect(open.destroyed).toBe(true);
    expect(sockets.size).toBe(0);
  });

  it("writes the line about destroyed sockets with a count and nothing else", () => {
    expect(formatClosedUpgradeSocketsLine(1)).toBe("> [exit] shutdown closed websocket upgrade sockets that were still open: 1");
    expect(formatClosedUpgradeSocketsLine(2000)).toBe("> [exit] shutdown closed websocket upgrade sockets that were still open: 2000");
  });

  it("gives a refused socket less time than an unauthenticated collaboration socket", () => {
    expect(ANSWERED_UPGRADE_CLOSE_MS).toBe(2_000);
    expect(ANSWERED_UPGRADE_CLOSE_MS).toBeLessThan(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS);
  });
});

describe("websocket upgrades once the server is ready, on a real http server around Next's own wrapper", () => {
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

  const upgradeRequest = (target: string, port: number) =>
    `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;

  /**
   * Next's custom-server wrapper (`NextCustomServer`, node_modules/next/dist/server/next.js), the real
   * one, with the handlers `prepare()` would have stored in `init` replaced by stand-ins that do what
   * Next's do with an upgrade (router-server.js `upgradeHandler`): in development the HMR path is
   * upgraded, every other socket is left alone. `setupWebSocketHandler`, its `didWebSocketSetup` flag
   * and the handler `getRequestHandler()` returns are Next's own code: a Next that adds its upgrade
   * listener again when a request arrives fails these tests.
   */
  function nextWrapper(server: http.Server, dev: boolean) {
    const app = next({ dev, httpServer: server, quiet: true });
    const sawUpgrade: string[] = [];
    const hmr = new WebSocketServer({ noServer: true });
    Reflect.set(app, "init", {
      requestHandler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.url === "/boom") throw new Error("render failed");
        res.statusCode = req.url === "/missing" ? 404 : 200;
        res.end(req.url === "/missing" ? "not found page" : "page");
      },
      upgradeHandler: async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        sawUpgrade.push(req.url ?? "");
        socket.on("error", () => {});
        if (dev && req.url?.startsWith("/_next/hmr")) hmr.handleUpgrade(req, socket, head, () => {});
      },
    });
    return { app, sawUpgrade, hmr };
  }

  /** The request handler and the upgrade listeners server/index.ts has once it is ready, in its order. */
  async function startReady(mode: "production" | "development", closeMs: number | "default" = 300) {
    const dev = mode === "development";
    const sockets = closeMs === "default" ? createOwnedUpgradeSockets() : createOwnedUpgradeSockets(closeMs);
    const guardLines: string[] = [];
    const write = (line: string) => void guardLines.push(line);
    let handle: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;
    const server = http.createServer((req, res) => {
      attachRequestErrorGuards(req, res);
      if (!handle) {
        res.statusCode = 503;
        res.end("starting");
        return;
      }
      handle(req, res).catch(() => {
        if (!res.headersSent) res.statusCode = 500;
        res.end("internal server error");
      });
    });
    const connections = new Set<net.Socket>();
    server.on("connection", (socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
    });
    const rejectStartupUpgrade = (req: IncomingMessage, socket: Duplex) => answerUpgrade(req, socket, STARTING_UPGRADE_ANSWER, { sockets, write });
    server.on("upgrade", rejectStartupUpgrade);
    const { app, sawUpgrade, hmr } = nextWrapper(server, dev);
    handle = app.getRequestHandler();
    const hocuspocus = new Hocuspocus({ quiet: true });
    const protectCollabUpgrade = protectUpgradePath(server, COLLAB_PATH);
    installOtherUpgradeListeners(server, { dev, next: app, sockets, write });
    protectCollabUpgrade();
    server.off("upgrade", rejectStartupUpgrade);
    const collab = attachCollab(server, hocuspocus, { path: COLLAB_PATH });
    let collabConnections = 0;
    collab.on("connection", () => collabConnections++);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      server,
      port,
      sockets,
      guardLines,
      /** The upgrades Next's handler was given. */
      nextSaw: sawUpgrade,
      collab,
      collabConnections: () => collabConnections,
      /** The upgrade listeners as wired; they must stay exactly these. */
      wired: server.listeners("upgrade"),
      openServerSockets: () => new Promise<number>((resolve) => server.getConnections((_error, count) => resolve(count))),
      get: async (target: string) => {
        const response = await fetch(`http://127.0.0.1:${port}${target}`, { headers: { connection: "close" } });
        await response.text();
        return response.status;
      },
      async close() {
        for (const client of [...hmr.clients, ...collab.clients]) client.terminate();
        hocuspocus.closeConnections();
        for (const socket of connections) socket.destroy();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }
  type Site = Awaited<ReturnType<typeof startReady>>;
  type Held = Awaited<ReturnType<typeof heldUpgrade>>;

  /** One raw upgrade whose client keeps its side open (and, with `neverRead`, reads nothing) until the test destroys it. */
  function heldUpgrade(port: number, target: string, options: { neverRead?: boolean } = {}) {
    return new Promise<{ socket: net.Socket; answer: () => string; endedByServer: () => boolean }>((resolve) => {
      let answer = "";
      let ended = false;
      const socket = net.connect({ host: "127.0.0.1", port, allowHalfOpen: true }, () => {
        socket.write(upgradeRequest(target, port));
        resolve({ socket, answer: () => answer, endedByServer: () => ended });
      });
      if (options.neverRead) socket.pause();
      else socket.on("data", (chunk: Buffer) => (answer += chunk.toString("latin1")));
      socket.on("end", () => (ended = true));
      socket.on("error", () => {});
    });
  }

  /** One raw upgrade that leaves by itself: `fin` closes 20 ms after sending, `rst` resets then. */
  function leavingUpgrade(port: number, target: string, leave: "fin" | "rst") {
    return new Promise<void>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.write(upgradeRequest(target, port));
        setTimeout(() => (leave === "fin" ? socket.destroy() : socket.resetAndDestroy()), 20);
      });
      socket.resume();
      socket.on("error", () => {});
      socket.on("close", () => resolve());
    });
  }

  function opens(url: string): Promise<WebSocket> {
    const socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  /** Waits until the server has no connection left; resolves with the time it took, or -1 after `timeoutMs`. */
  async function untilNoServerSockets(site: Site, timeoutMs: number): Promise<number> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if ((await site.openServerSockets()) === 0) return Date.now() - started;
      await sleep(10);
    }
    return -1;
  }

  /** The set empties on each socket's `close`, a moment after the server stops counting the connection. */
  async function untilForgotten(sockets: { size: number }): Promise<number> {
    for (let i = 0; i < 100 && sockets.size > 0; i++) await sleep(10);
    return sockets.size;
  }

  const settledWithin = (work: Promise<unknown>, ms: number) =>
    Promise.race([work.then(() => "settled" as const), sleep(ms).then(() => "pending" as const)]);

  /** Paths with no websocket in production: unknown ones, Next's own, ones Next has a page or a route for. */
  const OTHER_PATHS = ["/other", "/_next/hmr", "/_next/webpack-hmr", "/collab/", "/collab/x", "/collaborate", "/", "/api/health"];

  describe("production", () => {
    it("answers an upgrade on every path but the collaboration path with a plain 404, ends it, and Next never sees it", async () => {
      const site = await startReady("production");
      try {
        expect(UNKNOWN_UPGRADE_ANSWER).toBe("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        for (const target of OTHER_PATHS) {
          const client = await heldUpgrade(site.port, target);
          for (let i = 0; i < 100 && !client.endedByServer(); i++) await sleep(10);
          expect({ target, answer: client.answer(), endedByServer: client.endedByServer() }).toEqual({ target, answer: UNKNOWN_UPGRADE_ANSWER, endedByServer: true });
          client.socket.destroy();
        }
        expect(site.nextSaw).toEqual([]);
        expect(site.collabConnections()).toBe(0);
        expect(site.guardLines).toEqual([]);
      } finally {
        await site.close();
      }
      expect(processErrors).toEqual([]);
    });

    it("lets go of an answered socket after the close time although the client keeps its side open, reading or not", async () => {
      const site = await startReady("production", 500);
      const clients: Held[] = [];
      try {
        for (let i = 0; i < 10; i++) clients.push(await heldUpgrade(site.port, OTHER_PATHS[i % OTHER_PATHS.length], { neverRead: i % 2 === 1 }));
        await sleep(100);
        expect(await site.openServerSockets()).toBe(10);
        expect(site.sockets.size).toBe(10);
        expect(await untilNoServerSockets(site, 3_000)).toBeGreaterThanOrEqual(0);
        expect(await untilForgotten(site.sockets)).toBe(0);
        expect(clients.filter((client) => client.socket.destroyed)).toEqual([]);
      } finally {
        for (const client of clients) client.socket.destroy();
        await site.close();
      }
      expect(processErrors).toEqual([]);
    });

    it("leaves no socket behind 300 clients that close normally, reset or keep their side open", async () => {
      const site = await startReady("production", 300);
      const held: Held[] = [];
      try {
        for (let round = 0; round < 10; round++) {
          const leaving = [];
          for (let i = 0; i < 10; i++) {
            const target = OTHER_PATHS[(round + i) % OTHER_PATHS.length];
            leaving.push(leavingUpgrade(site.port, target, "fin"), leavingUpgrade(site.port, target, "rst"));
            held.push(await heldUpgrade(site.port, target));
          }
          await Promise.all(leaving);
        }
        expect(await untilNoServerSockets(site, 5_000)).toBeGreaterThanOrEqual(0);
        expect(await untilForgotten(site.sockets)).toBe(0);
        expect(site.nextSaw).toEqual([]);
        expect(site.guardLines).toEqual([]);
        expect(await site.get("/")).toBe(200);
      } finally {
        for (const client of held) client.socket.destroy();
        await site.close();
      }
      expect(processErrors).toEqual([]);
    });

    it("leaves a patient collaboration client alone: one connection, never in the set, open after the close time", async () => {
      const site = await startReady("production", 100);
      try {
        const client = await opens(`ws://127.0.0.1:${site.port}${COLLAB_PATH}`);
        const withQuery = await opens(`ws://127.0.0.1:${site.port}${COLLAB_PATH}?x=1`);
        await sleep(400);
        expect(client.readyState).toBe(WebSocket.OPEN);
        expect(withQuery.readyState).toBe(WebSocket.OPEN);
        expect(site.collabConnections()).toBe(2);
        expect(site.sockets.size).toBe(0);
        expect(site.nextSaw).toEqual([]);
        expect(site.sockets.destroyAll()).toBe(0);
        await sleep(50);
        expect(client.readyState).toBe(WebSocket.OPEN);
      } finally {
        await site.close();
      }
      expect(processErrors).toEqual([]);
    });

    it("keeps Next's upgrade listener off after the first request, more requests, a missing page and a failed request", async () => {
      const site = await startReady("production");
      try {
        // Ours only: the 404 behind the path filter, then the collaboration router.
        expect(site.wired).toHaveLength(2);
        expect(await site.get("/")).toBe(200);
        expect(site.server.listeners("upgrade")).toEqual(site.wired);
        for (let i = 0; i < 10; i++) expect(await site.get(`/page-${i}`)).toBe(200);
        expect(await site.get("/missing")).toBe(404);
        expect(await site.get("/boom")).toBe(500);
        expect(site.server.listeners("upgrade")).toEqual(site.wired);
        const collabClient = await opens(`ws://127.0.0.1:${site.port}${COLLAB_PATH}`);
        const other = await heldUpgrade(site.port, "/other");
        for (let i = 0; i < 100 && !other.endedByServer(); i++) await sleep(10);
        expect(other.answer()).toBe(UNKNOWN_UPGRADE_ANSWER);
        other.socket.destroy();
        expect(site.collabConnections()).toBe(1);
        expect(collabClient.readyState).toBe(WebSocket.OPEN);
        expect(site.nextSaw).toEqual([]);
      } finally {
        await site.close();
      }
      expect(processErrors).toEqual([]);
    });

    // The whole reason for the test above: Next's wrapper adds its listener by itself when a request
    // arrives, unless it was set up before. If this stops being true, the reliance has changed: read
    // `NextCustomServer.getRequestHandler` and `setupWebSocketHandler` again.
    it("control: a wrapper that was never set up adds its upgrade listener on the first request", async () => {
      const server = http.createServer();
      const { app } = nextWrapper(server, false);
      const handle = app.getRequestHandler();
      server.on("request", (req, res) => void handle(req, res));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        expect(server.listenerCount("upgrade")).toBe(0);
        const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { headers: { connection: "close" } });
        expect(response.status).toBe(200);
        expect(server.listenerCount("upgrade")).toBe(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("gives a refused socket its default 2 s, and lets go of it before an unauthenticated collaboration socket", async () => {
      const site = await startReady("production", "default");
      const refused = await heldUpgrade(site.port, "/other");
      try {
        const started = Date.now();
        const collabClient = await opens(`ws://127.0.0.1:${site.port}${COLLAB_PATH}`);
        let collabClosedAfter = -1;
        collabClient.once("close", () => (collabClosedAfter = Date.now() - started));
        await sleep(ANSWERED_UPGRADE_CLOSE_MS - 500);
        expect(site.sockets.size).toBe(1);
        for (let i = 0; i < 100 && site.sockets.size > 0; i++) await sleep(10);
        const refusedGoneAfter = Date.now() - started;
        expect(site.sockets.size).toBe(0);
        expect(refusedGoneAfter).toBeLessThan(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS);
        // The collaboration socket that never authenticated is still there: its own deadline is later.
        expect(collabClient.readyState).toBe(WebSocket.OPEN);
        for (let i = 0; i < 300 && collabClosedAfter < 0; i++) await sleep(10);
        expect(collabClosedAfter).toBeGreaterThanOrEqual(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS - 50);
        expect(refused.socket.destroyed).toBe(false);
      } finally {
        refused.socket.destroy();
        await site.close();
      }
      expect(processErrors).toEqual([]);
    }, 20_000);
  });

  describe("development", () => {
    it("hands the HMR upgrade to Next and leaves it open; no other path is answered; the collaboration path never reaches Next", async () => {
      const site = await startReady("development", 100);
      const other = await heldUpgrade(site.port, "/other");
      try {
        // The remembering listener and Next's, both behind the path filter, then the collaboration router.
        expect(site.wired).toHaveLength(3);
        const hmr = await opens(`ws://127.0.0.1:${site.port}/_next/hmr?id=abc`);
        expect(await site.get("/")).toBe(200);
        for (let i = 0; i < 10; i++) expect(await site.get(`/page-${i}`)).toBe(200);
        expect(await site.get("/missing")).toBe(404);
        expect(await site.get("/boom")).toBe(500);
        expect(site.server.listeners("upgrade")).toEqual(site.wired);
        const collabClient = await opens(`ws://127.0.0.1:${site.port}${COLLAB_PATH}`);
        await sleep(400);
        expect(hmr.readyState).toBe(WebSocket.OPEN);
        expect(collabClient.readyState).toBe(WebSocket.OPEN);
        expect(site.collabConnections()).toBe(1);
        expect([...site.nextSaw].sort()).toEqual(["/_next/hmr?id=abc", "/other"]);
        // As before this change: Next leaves a path it does not know without an answer, and open.
        expect({ answer: other.answer(), endedByServer: other.endedByServer() }).toEqual({ answer: "", endedByServer: false });
        // Both are remembered for shutdown; the collaboration socket is not.
        expect(site.sockets.size).toBe(2);
      } finally {
        other.socket.destroy();
        await site.close();
      }
      expect(processErrors).toEqual([]);
    });
  });

  describe("shutdown", () => {
    it.each(["production", "development"] as const)("%s: closeHttpIntake destroys the sockets that are still held, writes one line with their count, and resolves", async (mode) => {
      // A close time far away: only the sweep can have closed these.
      const site = await startReady(mode, 60_000);
      const held: Held[] = [];
      const lines: string[] = [];
      try {
        // In production they are answered with the 404 and held; in development Next left them open
        // after the client closed, which is the socket that used to stay for the life of the process.
        for (let i = 0; i < 3; i++) held.push(await heldUpgrade(site.port, OTHER_PATHS[i]));
        if (mode === "development") await leavingUpgrade(site.port, "/other", "fin");
        const expected = mode === "development" ? 4 : 3;
        await sleep(100);
        expect(await site.openServerSockets()).toBe(expected);
        const closing = closeHttpIntake(site.server, { sockets: site.sockets, log: (line) => void lines.push(line) });
        expect(await settledWithin(closing, 2_000)).toBe("settled");
        expect(lines).toEqual([`> [exit] shutdown closed websocket upgrade sockets that were still open: ${expected}`]);
        expect(site.sockets.size).toBe(0);
        expect(site.server.listening).toBe(false);
      } finally {
        for (const client of held) client.socket.destroy();
        await site.close();
      }
      expect(processErrors).toEqual([]);
    });

    it("leaves an established collaboration socket to its owner, and waits for it", async () => {
      const site = await startReady("production", 60_000);
      const held = await heldUpgrade(site.port, "/other");
      const lines: string[] = [];
      try {
        const collabClient = await opens(`ws://127.0.0.1:${site.port}${COLLAB_PATH}`);
        await sleep(50);
        const closing = closeHttpIntake(site.server, { sockets: site.sockets, log: (line) => void lines.push(line) });
        expect(await settledWithin(closing, 300)).toBe("pending");
        expect(collabClient.readyState).toBe(WebSocket.OPEN);
        expect(lines).toEqual(["> [exit] shutdown closed websocket upgrade sockets that were still open: 1"]);
        // The collaboration shutdown closes it (server/index.ts: the attachment's signal, then Hocuspocus).
        for (const client of site.collab.clients) client.terminate();
        expect(await settledWithin(closing, 2_000)).toBe("settled");
      } finally {
        held.socket.destroy();
        await site.close();
      }
      expect(processErrors).toEqual([]);
    });

    it("writes no line when no upgrade socket was open", async () => {
      const site = await startReady("production");
      const lines: string[] = [];
      try {
        const client = await heldUpgrade(site.port, "/other");
        client.socket.destroy();
        expect(await untilNoServerSockets(site, 2_000)).toBeGreaterThanOrEqual(0);
        expect(await untilForgotten(site.sockets)).toBe(0);
        await closeHttpIntake(site.server, { sockets: site.sockets, log: (line) => void lines.push(line) });
        expect(lines).toEqual([]);
        await expect(closeHttpIntake(null)).resolves.toBeUndefined();
      } finally {
        await site.close();
      }
    });
  });

  // Found in the review of #2328: Node's `server.close()` closes only the connections that are idle
  // after a request. A connection that has sent nothing yet, or only a part of a request or of an
  // upgrade, was waited for, and ONE of them made a normal stop run into its deadline and exit 1 with
  // the database still open. An upgrade that arrives while the server stops had no test either.
  describe("shutdown: connections that are not answering a request, and upgrades that still arrive", () => {
    /** A plain http server with the request guard, a slow route, and the 404 for upgrades of a ready production server. */
    async function startPlain() {
      const sockets = createOwnedUpgradeSockets(60_000);
      const requests = createRequestsInFlight();
      const server = http.createServer((req, res) => {
        attachRequestErrorGuards(req, res, { requests });
        if (req.url === "/slow") setTimeout(() => res.end("slow answer"), 400);
        else res.end("page");
      });
      server.on("upgrade", (req: IncomingMessage, socket: Duplex) => answerUpgrade(req, socket, UNKNOWN_UPGRADE_ANSWER, { sockets }));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return { server, sockets, requests, port: (server.address() as AddressInfo).port };
    }

    /** A raw client that sends `text` (or nothing) and then only waits: what it gets, and whether the server let go of it. */
    function waitingClient(port: number, text: string) {
      return new Promise<{ socket: net.Socket; received: () => string; letGoByServer: () => boolean }>((resolve) => {
        let received = "";
        let letGo = false;
        const socket = net.connect({ host: "127.0.0.1", port, allowHalfOpen: true }, () => {
          if (text) socket.write(text);
          resolve({ socket, received: () => received, letGoByServer: () => letGo });
        });
        socket.on("data", (chunk: Buffer) => (received += chunk.toString("latin1")));
        socket.on("end", () => (letGo = true));
        socket.on("close", () => (letGo = true));
        socket.on("error", () => (letGo = true));
      });
    }
    type Waiting = Awaited<ReturnType<typeof waitingClient>>;

    const stopPlain = async (site: Awaited<ReturnType<typeof startPlain>>, clients: Waiting[]) => {
      for (const client of clients) client.socket.destroy();
      site.server.closeAllConnections();
      if (site.server.listening) await new Promise<void>((resolve) => site.server.close(() => resolve()));
    };

    it("counts a request until its response closes, and runs what waits for none at that moment", () => {
      const requests = createRequestsInFlight();
      const ran: string[] = [];
      requests.whenNone(() => void ran.push("at once"));
      const first = new EventEmitter();
      const second = new EventEmitter();
      requests.add(first as unknown as GuardedResponse);
      requests.add(second as unknown as GuardedResponse);
      requests.whenNone(() => void ran.push("after the last one"));
      first.emit("close");
      first.emit("close");
      expect({ count: requests.count, ran }).toEqual({ count: 1, ran: ["at once"] });
      second.emit("close");
      expect({ count: requests.count, ran }).toEqual({ count: 0, ran: ["at once", "after the last one"] });
    });

    it("does not wait for a connection that has sent nothing, or only a part of a request or of an upgrade", async () => {
      const site = await startPlain();
      const clients = [
        await waitingClient(site.port, ""),
        await waitingClient(site.port, "GET / HTTP/1.1\r\nHost: x\r\n"),
        await waitingClient(site.port, upgradeRequest("/other", site.port).slice(0, -2)),
      ];
      try {
        await sleep(50);
        expect(await new Promise<number>((resolve) => site.server.getConnections((_error, n) => resolve(n)))).toBe(3);
        expect(await settledWithin(closeHttpIntake(site.server, { sockets: site.sockets, requests: site.requests }), 500)).toBe("settled");
        for (let i = 0; i < 50 && clients.some((client) => !client.letGoByServer()); i++) await sleep(10);
        expect(clients.map((client) => ({ letGoByServer: client.letGoByServer(), received: client.received() }))).toEqual(Array(3).fill({ letGoByServer: true, received: "" }));
        expect(site.server.listening).toBe(false);
      } finally {
        await stopPlain(site, clients);
      }
      expect(processErrors).toEqual([]);
    });

    it("lets a request that is being answered finish, and only then lets go of a connection that waits", async () => {
      const site = await startPlain();
      const slow = await waitingClient(site.port, "GET /slow HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      const idle = await waitingClient(site.port, "");
      try {
        await sleep(50);
        expect(site.requests.count).toBe(1);
        const closing = closeHttpIntake(site.server, { sockets: site.sockets, requests: site.requests });
        expect(await settledWithin(closing, 150)).toBe("pending");
        expect(idle.letGoByServer()).toBe(false);
        expect(await settledWithin(closing, 2_000)).toBe("settled");
        // The answer is on its way to the client when the server has let go of the socket.
        for (let i = 0; i < 100 && !(slow.letGoByServer() && idle.letGoByServer()); i++) await sleep(10);
        expect(slow.received()).toMatch(/^HTTP\/1\.1 200 OK\r\n[\s\S]*slow answer$/);
        expect(idle.letGoByServer()).toBe(true);
        expect(site.requests.count).toBe(0);
      } finally {
        await stopPlain(site, [slow, idle]);
      }
      expect(processErrors).toEqual([]);
    });

    it("leaves an established collaboration socket alone when it lets go of a connection that waits", async () => {
      const site = await startReady("production", 60_000);
      const idle = await waitingClient(site.port, "");
      try {
        const collabClient = await opens(`ws://127.0.0.1:${site.port}${COLLAB_PATH}`);
        await sleep(50);
        const closing = closeHttpIntake(site.server, { sockets: site.sockets, requests: createRequestsInFlight(), log: () => {} });
        expect(await settledWithin(closing, 300)).toBe("pending");
        expect(idle.letGoByServer()).toBe(true);
        expect(collabClient.readyState).toBe(WebSocket.OPEN);
        for (const client of site.collab.clients) client.terminate();
        expect(await settledWithin(closing, 2_000)).toBe("settled");
      } finally {
        idle.socket.destroy();
        await site.close();
      }
      expect(processErrors).toEqual([]);
    });

    it("destroys an upgrade that arrives while the server stops: no answer, not kept, and the stop does not wait for it", async () => {
      const site = await startPlain();
      // A request that never finishes stands for work in flight, so the connections are left alone meanwhile.
      const busy = createRequestsInFlight();
      busy.add(new EventEmitter() as unknown as GuardedResponse);
      const late = await waitingClient(site.port, "");
      try {
        await sleep(30);
        const closing = closeHttpIntake(site.server, { sockets: site.sockets, requests: busy });
        expect(late.letGoByServer()).toBe(false);
        late.socket.write(upgradeRequest("/other", site.port));
        for (let i = 0; i < 100 && !late.letGoByServer(); i++) await sleep(10);
        expect({ answer: late.received(), letGoByServer: late.letGoByServer(), kept: site.sockets.size }).toEqual({ answer: "", letGoByServer: true, kept: 0 });
        expect(await settledWithin(closing, 500)).toBe("settled");
      } finally {
        await stopPlain(site, [late]);
      }
      expect(processErrors).toEqual([]);
    });
  });

  describe("start-up", () => {
    it("lets go of a client that keeps the 503 open, and shutdown does not wait for one that is still there", async () => {
      const sockets = createOwnedUpgradeSockets(300);
      const server = http.createServer((_req, res) => {
        res.statusCode = 503;
        res.end("starting");
      });
      server.on("upgrade", (req: IncomingMessage, socket: Duplex) => answerUpgrade(req, socket, STARTING_UPGRADE_ANSWER, { sockets }));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const count = () => new Promise<number>((resolve) => server.getConnections((_error, n) => resolve(n)));
      const clients: Held[] = [];
      try {
        for (let i = 0; i < 6; i++) clients.push(await heldUpgrade(port, i % 2 ? COLLAB_PATH : "/other", { neverRead: i >= 4 }));
        await sleep(100);
        expect(clients.slice(0, 4).map((client) => client.answer())).toEqual(Array(4).fill(STARTING_UPGRADE_ANSWER));
        expect(await count()).toBe(6);
        for (let i = 0; i < 300 && (await count()) > 0; i++) await sleep(10);
        expect(await count()).toBe(0);
        expect(await untilForgotten(sockets)).toBe(0);
        // A stop during start-up, with a client that took its 503 a moment ago.
        clients.push(await heldUpgrade(port, COLLAB_PATH));
        await sleep(50);
        const lines: string[] = [];
        expect(await settledWithin(closeHttpIntake(server, { sockets, log: (line) => void lines.push(line) }), 200)).toBe("settled");
        expect(lines).toEqual(["> [exit] shutdown closed websocket upgrade sockets that were still open: 1"]);
      } finally {
        for (const client of clients) client.socket.destroy();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      expect(processErrors).toEqual([]);
    });
  });

  describe("the reliance on Next", () => {
    it.each([true, false])("refuses to start (dev %s) when Next adds its upgrade listener again on a second set-up", (dev) => {
      const server = http.createServer();
      const eager = { setupWebSocketHandler: (target: http.Server) => void target.on("upgrade", () => {}) };
      expect(() => installOtherUpgradeListeners(server, { dev, next: eager, sockets: createOwnedUpgradeSockets() })).toThrow(
        "Next custom server added its upgrade listener a second time",
      );
    });

    it("refuses to start when Next no longer has the set-up function", () => {
      expect(() => setupNextUpgradeListener({}, http.createServer())).toThrow("Next custom server does not expose setupWebSocketHandler");
    });
  });
});