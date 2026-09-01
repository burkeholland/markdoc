import type { IncomingMessage, ServerResponse } from "node:http";
import { routeShape } from "./route-shape";

// One stderr line per failed request, nothing for the healthy rest (task #1444, from the #1423 log
// triage: a route that *returns* a 4xx/5xx through NextResponse.json(…, { status }) used to leave no
// trace at all, so the ingress metric's 400s could not be attributed to a route). The line is
//
//   [http] <status> <METHOD> <route shape> <ms>ms
//
// e.g. `[http] 400 POST /api/documents/:id/collaborators 12ms`, emitted when the response status is
// ≥ 500, or a 4xx other than 401 and 404, or the client went away before any header was written (the
// status is then 0). 2xx, 3xx, 101, 401 and 404 never log: expired sessions and probes for paths that
// do not exist are the normal background of a public site, and a working request is not news. The
// route shape (server/route-shape.ts) carries no query string, login, title or token.

export const HTTP_LOG_PREFIX = "[http]";

/** Status recorded when the response closed before headers were written: nothing was answered. */
export const ABORTED_STATUS = 0;

/**
 * The filter: ≥ 500 always; 4xx unless 401 or 404; 0/undefined (aborted before headers) always;
 * everything else never.
 */
export function shouldLogResponse(status: number | undefined): boolean {
  if (status === undefined || status === ABORTED_STATUS) return true;
  if (status >= 500) return true;
  if (status >= 400) return status !== 401 && status !== 404;
  return false;
}

export type RequestLogEntry = {
  status: number | undefined;
  method: string | undefined;
  url: string | undefined;
  /** Wall time from the handler's entry to the response's end, in milliseconds. */
  ms: number;
};

/** `[http] <status> <METHOD> <route shape> <ms>ms`; an aborted response reads `0`, a missing method `-`. */
export function formatRequestLine(entry: RequestLogEntry): string {
  const status = entry.status === undefined ? ABORTED_STATUS : entry.status;
  const method = entry.method && entry.method.length > 0 ? entry.method : "-";
  const shape = routeShape(entry.url ?? "");
  const ms = Number.isFinite(entry.ms) && entry.ms >= 0 ? Math.round(entry.ms) : 0;
  return `${HTTP_LOG_PREFIX} ${status} ${method} ${shape} ${ms}ms`;
}

/** The subset of ServerResponse the hook reads, so tests can drive it with a plain EventEmitter. */
export type LoggedResponse = Pick<ServerResponse, "once" | "statusCode" | "headersSent" | "writableFinished">;

export type AttachRequestLogOptions = {
  /** Monotonic clock in nanoseconds; defaults to process.hrtime.bigint(). */
  now?: () => bigint;
  /** Where a qualifying line goes; defaults to stderr through console.error. */
  write?: (line: string) => void;
};

/**
 * Starts the clock for one request and logs at most one line when the response ends. `finish` covers
 * every response Node actually sent; `close` covers the ones it did not (client gone, socket error):
 * `writableFinished` tells them apart, and a response that closed before its headers went out is
 * recorded with status 0. Both events fire on a normal response, hence the once-only guard.
 */
export function attachRequestLog(req: Pick<IncomingMessage, "method" | "url">, res: LoggedResponse, options: AttachRequestLogOptions = {}): void {
  const now = options.now ?? (() => process.hrtime.bigint());
  const write = options.write ?? ((line: string) => console.error(line));
  const started = now();
  let done = false;
  const complete = () => {
    if (done) return;
    done = true;
    const status = res.writableFinished || res.headersSent ? res.statusCode : ABORTED_STATUS;
    if (!shouldLogResponse(status)) return;
    write(formatRequestLine({ status, method: req.method, url: req.url, ms: Number(now() - started) / 1e6 }));
  };
  res.once("finish", complete);
  res.once("close", complete);
}
