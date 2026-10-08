import type { IncomingMessage, ServerResponse } from "node:http";
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
export function attachRequestErrorGuards(req: GuardedRequest, res: GuardedResponse, options: AttachRequestErrorGuardsOptions = {}): void {
  const write = options.write ?? ((line: string) => console.warn(line));
  req.on("error", (err: unknown) => {
    if (!isClientGone(err)) write(formatStreamErrorLine("request", req, err));
  });
  res.on("error", (err: unknown) => {
    if (!isClientGone(err)) write(formatStreamErrorLine("response", req, err));
  });
}

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

/** The answer to a websocket upgrade whose request target or Host header cannot be parsed into a URL. */
export const UNPARSEABLE_UPGRADE_ANSWER = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/** Stands where the route shape would be in the line for such an upgrade: a fixed word, never a part of the request. */
export const UNPARSEABLE_UPGRADE_SHAPE = ":unparseable";

/**
 * Answers a websocket upgrade whose request target or Host header cannot be parsed (issue #2321): the
 * guard first, then one `[http] upgrade error <METHOD> :unparseable ERR_INVALID_URL` line, a plain
 * `400` and the socket closed once the answer is flushed. The caller catches only its own parse; the
 * target and the header never reach the line.
 */
export function rejectUnparseableUpgrade(req: Pick<IncomingMessage, "method" | "url">, socket: Duplex, options: AttachRequestErrorGuardsOptions = {}): void {
  const write = options.write ?? ((line: string) => console.warn(line));
  attachUpgradeErrorGuard(req, socket, options);
  const method = req.method && req.method.length > 0 ? req.method : "-";
  write(`${HTTP_LOG_PREFIX} upgrade error ${method} ${UNPARSEABLE_UPGRADE_SHAPE} ERR_INVALID_URL`);
  socket.once("finish", () => socket.destroy());
  socket.end(UNPARSEABLE_UPGRADE_ANSWER);
}
