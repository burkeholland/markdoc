import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { HTTP_LOG_PREFIX } from "./request-log";
import { routeShape } from "./route-shape";

// Stream errors at the edge (task #1541). A client that closes its connection while a request body is
// still being read makes Node destroy the request with `Error: aborted` (code ECONNRESET, _http_server.js
// abortIncoming); writing to a response whose client is gone, or after end(), raises EPIPE,
// ERR_STREAM_DESTROYED or ERR_STREAM_WRITE_AFTER_END on the response. A stream `'error'` with no
// listener is an uncaughtException, and server/index.ts turns every one of those into exit(1) on
// purpose — so one departing client must never be the only listener's job to survive. These two
// listeners are attached before anything else touches `req`/`res`, swallow the errors of a client that
// went away, and log one line for anything else. They never rethrow.
//
// Websocket upgrades need the same care (issue #2311). Node's http server takes its own `'error'`
// listener off the socket before it emits `'upgrade'`, so a handler that answers the socket itself
// (the 503 while the server is starting) writes to a socket with no listener at all: a client that had
// already left turned that answer into `read ECONNRESET` / `write ECONNRESET`, an uncaughtException and
// exit(1) during start-up. `attachUpgradeErrorGuard` is the listener for those sockets.

/**
 * Codes that mean "the client went away": Node's `aborted` (ECONNRESET), a reset or EPIPE on the
 * socket, a write after the response was destroyed. The normal background of a public site — the
 * request log (server/request-log.ts) already writes one `[http] 0 …` line for a request whose response
 * closed before its headers, so these log nothing here.
 */
export const CLIENT_GONE_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/** `[http] request error <METHOD> <route shape> <code>` / `[http] response error …` / `[http] upgrade error …` for everything else. */
export function formatStreamErrorLine(side: "request" | "response" | "upgrade", req: Pick<IncomingMessage, "method" | "url">, err: unknown): string {
  const method = req.method && req.method.length > 0 ? req.method : "-";
  return `${HTTP_LOG_PREFIX} ${side} error ${method} ${routeShape(req.url ?? "")} ${errorCode(err)}`;
}

/** The error's `code` when it has one, else its class name; never the message (it may carry a path or a header). */
export function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    if (err instanceof Error && err.name) return err.name;
  }
  return "unknown";
}

/** True for the errors a departing client produces, which are expected and never logged. */
export function isClientGone(err: unknown): boolean {
  return CLIENT_GONE_CODES.has(errorCode(err));
}

/** The subset of IncomingMessage / ServerResponse the guards use, so tests can drive them with an EventEmitter. */
export type GuardedRequest = Pick<IncomingMessage, "on" | "method" | "url">;
export type GuardedResponse = Pick<ServerResponse, "on">;

export type AttachRequestErrorGuardsOptions = {
  /** Where a line for an unexpected error goes; defaults to stderr through console.warn. */
  write?: (line: string) => void;
};

/**
 * Installs one `'error'` listener on the request and one on the response. A client-gone error
 * (CLIENT_GONE_CODES) is swallowed silently; any other stream error writes one line and is swallowed
 * too — the request log's `close`/`finish` handling is untouched, so its line still appears exactly once.
 */
export function attachRequestErrorGuards(req: GuardedRequest, res: GuardedResponse, options: AttachRequestErrorGuardsOptions & { requests?: RequestsInFlight } = {}): void {
  const write = options.write ?? ((line: string) => console.warn(line));
  req.on("error", (err: unknown) => {
    if (!isClientGone(err)) write(formatStreamErrorLine("request", req, err));
  });
  res.on("error", (err: unknown) => {
    if (!isClientGone(err)) write(formatStreamErrorLine("response", req, err));
  });
  (options.requests ?? requestsInFlight).add(res);
}

// Requests in flight. Node's `server.close()` closes the connections that are idle after a request. A
// connection that has sent nothing yet, or only a part of a request (also of an upgrade), is not idle
// for Node: it is waited for, and one of them made a normal stop run into its deadline and exit 1 with
// the database still open, exactly as a left-open upgrade socket did (#2328). Shutdown may destroy such
// a connection, but not one whose request is being answered. This counter tells the two apart: every
// request passes through `attachRequestErrorGuards` before anything else touches it.

/** Counts the requests whose response has not closed yet. */
export function createRequestsInFlight() {
  let count = 0;
  const waiting: (() => void)[] = [];
  return {
    /** Counts the request of `res` until `res` closes (finished, or its client gone). */
    add(res: GuardedResponse): void {
      let counted = true;
      count += 1;
      res.on("close", () => {
        if (!counted) return;
        counted = false;
        count -= 1;
        if (count === 0) for (const run of waiting.splice(0)) run();
      });
    },
    /** Runs `run` now when no request is in flight, else once the last one has closed. */
    whenNone(run: () => void): void {
      if (count === 0) run();
      else waiting.push(run);
    },
    get count(): number {
      return count;
    },
  };
}

export type RequestsInFlight = ReturnType<typeof createRequestsInFlight>;

/** The process's counter: the request handler adds to it, shutdown waits for it. */
export const requestsInFlight = createRequestsInFlight();

/** The subset of the upgrade socket the guard uses. */
export type GuardedUpgradeSocket = Pick<Duplex, "on">;

/**
 * Installs one `'error'` listener on the raw socket of a websocket upgrade that the server answers or
 * closes itself. Call it before anything is written to the socket. A client-gone error
 * (CLIENT_GONE_CODES) is swallowed silently; any other socket error writes one
 * `[http] upgrade error <METHOD> <route shape> <code>` line (never the message or a stack) and is
 * swallowed too. Nothing else is caught: an exception thrown by the handler is still the process's.
 */
export function attachUpgradeErrorGuard(req: Pick<IncomingMessage, "method" | "url">, socket: GuardedUpgradeSocket, options: AttachRequestErrorGuardsOptions = {}): void {
  const write = options.write ?? ((line: string) => console.warn(line));
  socket.on("error", (err: unknown) => {
    if (!isClientGone(err)) write(formatStreamErrorLine("upgrade", req, err));
  });
}

// Upgrade sockets the server owns (issue #2328). Node keeps no list of upgraded sockets:
// `closeAllConnections()` passes them by and `server.close()` waits for every one of them. A socket the
// server had answered, or that no listener answered at all, stayed open for as long as the client did
// not close it (and for the life of the process when nothing read the client's close), and one such
// socket made a normal stop run into its deadline and exit 1 with the database still open. Three rules:
// the server answers every upgrade it does not hand to a websocket server, an answered socket is
// destroyed after ANSWERED_UPGRADE_CLOSE_MS unless it closed before, and shutdown destroys every
// socket that is still in the set before it waits for the connections to close.

/** The answer to every websocket upgrade until the server is ready. */
export const STARTING_UPGRADE_ANSWER = "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/** The answer, in production, to a websocket upgrade on a path that has no websocket. */
export const UNKNOWN_UPGRADE_ANSWER = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/**
 * How long a socket may stay open after the server wrote its own answer and ended its side (#2328).
 * Why 2 s: a client that reads the answer closes within one round trip, so this is generous; a client
 * that does not close loses nothing when the server lets go first, because the answer is already with
 * the operating system and is still delivered; it bounds what one client can hold to its request rate
 * times 2 s; and it is shorter than COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS (3 s), so a refused socket
 * never outlives an accepted, unauthenticated one. Not 0: closing at once resets a client that has
 * sent more bytes, and a reset can cost it the answer.
 */
export const ANSWERED_UPGRADE_CLOSE_MS = 2_000;

/** The set of upgrade sockets the server answered itself or handed to a listener that may leave them open. */
export function createOwnedUpgradeSockets(closeMs = ANSWERED_UPGRADE_CLOSE_MS) {
  const open = new Set<Duplex>();
  /** False for a socket that is already destroyed: its `'close'` may be over, and it would never leave the set. */
  const remember = (socket: Duplex): boolean => {
    if (socket.destroyed) return false;
    open.add(socket);
    socket.once("close", () => open.delete(socket));
    return true;
  };
  return {
    /** Remembers a socket another listener may leave open (Next, in development); only shutdown closes it. */
    track(socket: Duplex): void {
      remember(socket);
    },
    /** Writes the server's answer, ends the socket and destroys it after `closeMs` unless it closed before. */
    end(socket: Duplex, answer: string): void {
      if (remember(socket)) {
        const timer = setTimeout(() => socket.destroy(), closeMs);
        timer.unref();
        socket.once("close", () => clearTimeout(timer));
      }
      socket.end(answer);
    },
    /** Destroys every socket that is still open and returns how many there were. */
    destroyAll(): number {
      let count = 0;
      for (const socket of open) {
        if (socket.destroyed) continue;
        socket.destroy();
        count += 1;
      }
      open.clear();
      return count;
    },
    get size(): number {
      return open.size;
    },
  };
}

export type OwnedUpgradeSockets = ReturnType<typeof createOwnedUpgradeSockets>;

/** The process's set: the answers below, the collaboration router's 400 and shutdown all use this one. */
export const ownedUpgradeSockets = createOwnedUpgradeSockets();

export type OwnedUpgradeOptions = AttachRequestErrorGuardsOptions & {
  /** Test-only set; production uses `ownedUpgradeSockets`. */
  sockets?: OwnedUpgradeSockets;
};

/** Answers a websocket upgrade on its raw socket: the guard first, then the answer, the end and the timed destroy. */
export function answerUpgrade(req: Pick<IncomingMessage, "method" | "url">, socket: Duplex, answer: string, options: OwnedUpgradeOptions = {}): void {
  attachUpgradeErrorGuard(req, socket, options);
  (options.sockets ?? ownedUpgradeSockets).end(socket, answer);
}

type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Asks Next's custom-server wrapper to add its upgrade listener to `server`. This is
 * `NextCustomServer.setupWebSocketHandler` in node_modules/next/dist/server/next.js: Next 16 has it at
 * runtime and leaves it out of its public interface. It adds the listener once (`didWebSocketSetup`);
 * the handler `getRequestHandler()` returns calls it again on every request, and that call must add
 * nothing. Doing it before the first request also keeps WebSocket-only clients from depending on a
 * later HTTP request after a restart.
 */
export function setupNextUpgradeListener(next: object, server: unknown): void {
  const setup = Reflect.get(next, "setupWebSocketHandler");
  if (typeof setup !== "function") throw new Error("Next custom server does not expose setupWebSocketHandler");
  Reflect.apply(setup, next, [server]);
}

/**
 * Installs the listeners for websocket upgrades on every path but the collaboration path, once the
 * server is ready. Call it between `protectUpgradePath()` and the function that returns, so that what
 * is added here never sees the collaboration path or a request target that cannot be parsed.
 *
 * Production: each such upgrade gets a plain 404 and is closed. Next's own listener is taken off
 * again: in a production server it answers nothing (router-server.js `upgradeHandler` ends its side
 * for a path it knows and leaves every other socket alone, for "a custom server"; it would only be
 * needed to proxy a websocket through a rewrite to another server, and there is none).
 * Development: Next's listener stays, its HMR socket lives on it. The sockets it sees are remembered,
 * because it leaves most of them open, and only shutdown closes them.
 *
 * Both rely on Next not adding its listener a second time when a request arrives: such a listener
 * would be outside the path filter and would see the collaboration path too. That is checked here, at
 * start, and the server does not start if Next has changed it.
 */
export function installOtherUpgradeListeners(
  server: Pick<Server, "on" | "off" | "listeners">,
  options: OwnedUpgradeOptions & { dev: boolean; next: object },
): void {
  const sockets = options.sockets ?? ownedUpgradeSockets;
  if (options.dev) server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => sockets.track(socket));
  const before = new Set(server.listeners("upgrade"));
  setupNextUpgradeListener(options.next, server);
  if (!options.dev) {
    for (const added of server.listeners("upgrade")) {
      if (!before.has(added)) server.off("upgrade", added as UpgradeListener);
    }
  }
  const settled = new Set(server.listeners("upgrade"));
  setupNextUpgradeListener(options.next, server);
  if (server.listeners("upgrade").some((listener) => !settled.has(listener))) {
    throw new Error("Next custom server added its upgrade listener a second time");
  }
  if (!options.dev) {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex) => answerUpgrade(req, socket, UNKNOWN_UPGRADE_ANSWER, options));
  }
}

/** `> [exit] shutdown closed websocket upgrade sockets that were still open: <n>`: a count, never a path or an address. */
export function formatClosedUpgradeSocketsLine(count: number): string {
  return `> [exit] shutdown closed websocket upgrade sockets that were still open: ${count}`;
}

export type CloseHttpIntakeOptions = {
  /** Test-only set; production uses `ownedUpgradeSockets`. */
  sockets?: OwnedUpgradeSockets;
  /** Test-only counter; production uses `requestsInFlight`. */
  requests?: RequestsInFlight;
  /** Where the line about destroyed sockets goes; defaults to stdout through console.log. */
  log?: (line: string) => void;
};

/**
 * Stops a server taking connections and upgrades at shutdown; resolves when its last connection has
 * closed. An upgrade that still arrives is destroyed, and so is every upgrade socket in the set, with
 * one line when there were any: `server.close()` would otherwise wait for them until the deadline.
 * Established collaboration sockets are never in the set; their own shutdown closes them.
 * A connection that is not answering a request (nothing sent yet, or an unfinished request) is
 * destroyed too, once no request is in flight; a request that is being answered is left to finish.
 */
export function closeHttpIntake(server: Server | null, options: CloseHttpIntakeOptions = {}): Promise<void> {
  if (!server) return Promise.resolve();
  server.removeAllListeners("upgrade");
  // destroy() alone was not seen to raise an 'error' here; the guard keeps the rule "no upgrade socket
  // of ours without an 'error' listener" (#2311) true on this path if it ever writes an answer.
  server.on("upgrade", (req, socket) => {
    attachUpgradeErrorGuard(req, socket);
    socket.destroy();
  });
  const closed = (options.sockets ?? ownedUpgradeSockets).destroyAll();
  if (closed > 0) (options.log ?? ((line: string) => console.log(line)))(formatClosedUpgradeSocketsLine(closed));
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(new Error("HTTP intake did not close"));
    });
    // close() has closed the connections that were idle after a request. What is left and is not
    // answering a request would be waited for until the deadline: closeAllConnections() destroys it,
    // at once when no request is in flight, else when the last one has closed. It never touches a
    // socket that was upgraded, so a collaboration socket stays with its owner.
    (options.requests ?? requestsInFlight).whenNone(() => server.closeAllConnections());
  });
}

/** The answer to a websocket upgrade whose request target or Host header cannot be parsed into a URL. */
export const UNPARSEABLE_UPGRADE_ANSWER = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/** Stands where the route shape would be in the line for such an upgrade: a fixed word, never a part of the request. */
export const UNPARSEABLE_UPGRADE_SHAPE = ":unparseable";

/**
 * Answers a websocket upgrade whose request target or Host header cannot be parsed (issue #2321): the
 * guard first, then one `[http] upgrade error <METHOD> :unparseable ERR_INVALID_URL` line, a plain
 * `400` and the socket closed once the answer is flushed. The caller catches only its own parse; the
 * target and the header never reach the line. The socket is in the owned set until it has closed, so
 * the timed destroy and the shutdown sweep cover an answer that is never flushed.
 */
export function rejectUnparseableUpgrade(req: Pick<IncomingMessage, "method" | "url">, socket: Duplex, options: OwnedUpgradeOptions = {}): void {
  const write = options.write ?? ((line: string) => console.warn(line));
  attachUpgradeErrorGuard(req, socket, options);
  const method = req.method && req.method.length > 0 ? req.method : "-";
  write(`${HTTP_LOG_PREFIX} upgrade error ${method} ${UNPARSEABLE_UPGRADE_SHAPE} ERR_INVALID_URL`);
  socket.once("finish", () => socket.destroy());
  (options.sockets ?? ownedUpgradeSockets).end(socket, UNPARSEABLE_UPGRADE_ANSWER);
}
