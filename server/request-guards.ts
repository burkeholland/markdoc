import type { IncomingMessage, ServerResponse } from "node:http";
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

/** `[http] request error <METHOD> <route shape> <code>` / `[http] response error …` for everything else. */
export function formatStreamErrorLine(side: "request" | "response", req: Pick<IncomingMessage, "method" | "url">, err: unknown): string {
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
