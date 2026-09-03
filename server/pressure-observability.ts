import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import { collectPressureGauges, type PressureGaugeCollection } from "@/server/pressure-gauges";
import { routeShape } from "./route-shape";

export const PRESSURE_LOG_PREFIX = "[pressure]";
export const PRESSURE_BUCKET_MS = 15_000;
export const MAX_HTTP_SERIES = 24;
export const OVERFLOW_ROUTE = "/:overflow";

export const PRESSURE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type PressureMethod = (typeof PRESSURE_METHODS)[number] | "OTHER";

/** Exact, non-cumulative buckets: ≤100, ≤500, ≤2,000, ≤10,000, >10,000 ms. */
export type DurationBuckets = [number, number, number, number, number];
/** Exact, non-cumulative buckets: 0, ≤1 KiB, ≤64 KiB, ≤1 MiB, >1 MiB, unknown. */
export type SizeBuckets = [number, number, number, number, number, number];

interface HttpSeries {
  method: PressureMethod;
  route: string;
  accepted: number;
  completed: number;
  aborted: number;
  duration_ms: DurationBuckets;
  request_bytes: SizeBuckets;
  response_bytes: SizeBuckets;
}

interface ActiveRequest {
  method: PressureMethod;
  route: string;
  startedAt: number;
}

interface ServerAttachment {
  trackUpgrades: boolean;
  connection: (socket: Socket) => void;
  upgrade: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null;
}

export type PressureRequest = Pick<IncomingMessage, "method" | "url" | "headers">;
export type PressureResponse = Pick<ServerResponse, "once" | "writableFinished" | "getHeader">;

interface EventLoopDelayMonitor {
  readonly max: number;
  enable(): void;
  disable(): void;
  reset(): void;
}

export interface PressureObservabilityOptions {
  windowMs?: number;
  maxHttpSeries?: number;
  now?: () => number;
  write?: (line: string) => void;
  collectGauges?: (resetIntervalMaximum: boolean) => PressureGaugeCollection;
  eventLoopDelay?: EventLoopDelayMonitor;
}

function isPressureMethod(method: string | undefined): method is (typeof PRESSURE_METHODS)[number] {
  return method !== undefined && PRESSURE_METHODS.some((candidate) => candidate === method);
}

export function normalizePressureMethod(method: string | undefined): PressureMethod {
  const normalized = method?.toUpperCase();
  return isPressureMethod(normalized) ? normalized : "OTHER";
}

export function durationBucketIndex(ms: number): number {
  if (ms <= 100) return 0;
  if (ms <= 500) return 1;
  if (ms <= 2_000) return 2;
  if (ms <= 10_000) return 3;
  return 4;
}

export function sizeBucketIndex(bytes: number | null): number {
  if (bytes === null) return 5;
  if (bytes === 0) return 0;
  if (bytes <= 1_024) return 1;
  if (bytes <= 65_536) return 2;
  if (bytes <= 1_048_576) return 3;
  return 4;
}

function contentLength(value: string | string[] | number | undefined): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function emptyDurationBuckets(): DurationBuckets {
  return [0, 0, 0, 0, 0];
}

function emptySizeBuckets(): SizeBuckets {
  return [0, 0, 0, 0, 0, 0];
}

function emptySeries(method: PressureMethod, route: string): HttpSeries {
  return {
    method,
    route,
    accepted: 0,
    completed: 0,
    aborted: 0,
    duration_ms: emptyDurationBuckets(),
    request_bytes: emptySizeBuckets(),
    response_bytes: emptySizeBuckets(),
  };
}

/**
 * Process-local, privacy-safe pressure aggregation. It emits at most two lines per window: one
 * capped array of normalized HTTP series (when non-empty), and one fixed-name gauge record.
 */
export class PressureObservability {
  private readonly windowMs: number;
  private readonly maxHttpSeries: number;
  private readonly now: () => number;
  private readonly write: (line: string) => void;
  private readonly collectGauges: (resetIntervalMaximum: boolean) => PressureGaugeCollection;
  private readonly eventLoopDelay: EventLoopDelayMonitor;
  private readonly active = new Map<number, ActiveRequest>();
  private readonly serverAttachments = new Map<Server, ServerAttachment>();
  private readonly upgradedSockets = new WeakSet<object>();
  private series = new Map<string, HttpSeries>();
  private nextRequestId = 0;
  private windowStartedAt: number;
  private openTcp = 0;
  private tcpAccepted = 0;
  private openUpgrades = 0;
  private upgradesAccepted = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: PressureObservabilityOptions = {}) {
    this.windowMs = options.windowMs ?? PRESSURE_BUCKET_MS;
    this.maxHttpSeries = Math.max(1, Math.floor(options.maxHttpSeries ?? MAX_HTTP_SERIES));
    this.now = options.now ?? (() => Number(process.hrtime.bigint()) / 1e6);
    this.write = options.write ?? ((line) => console.log(line));
    this.collectGauges = options.collectGauges ?? collectPressureGauges;
    this.eventLoopDelay = options.eventLoopDelay ?? monitorEventLoopDelay({ resolution: 20 });
    this.windowStartedAt = this.now();
  }

  start(): void {
    if (this.timer) return;
    this.eventLoopDelay.enable();
    this.timer = setInterval(() => this.flush(), this.windowMs);
    this.timer.unref();
  }

  stop(flush = true): void {
    const wasStarted = this.timer !== null;
    if (!wasStarted && this.serverAttachments.size === 0) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const server of [...this.serverAttachments.keys()]) this.detachServer(server);
    try {
      if (flush) this.flush(true);
    } finally {
      if (wasStarted) this.eventLoopDelay.disable();
    }
  }

  attachServer(server: Server, options: { trackUpgrades?: boolean } = {}): void {
    const trackUpgrades = options.trackUpgrades !== false;
    const attached = this.serverAttachments.get(server);
    if (attached) {
      if (attached.trackUpgrades !== trackUpgrades) {
        throw new Error(
          `Pressure observability already attached to this server with trackUpgrades=${attached.trackUpgrades}`,
        );
      }
      return;
    }

    const connection = (socket: Socket) => {
      this.openTcp++;
      this.tcpAccepted++;
      let open = true;
      socket.once("close", () => {
        if (!open) return;
        open = false;
        this.openTcp = Math.max(0, this.openTcp - 1);
      });
    };
    const upgrade = trackUpgrades
      ? (_req: IncomingMessage, socket: Duplex) => {
          this.upgradesAccepted++;
          if (this.upgradedSockets.has(socket)) return;
          this.upgradedSockets.add(socket);
          this.openUpgrades++;
          let open = true;
          socket.once("close", () => {
            if (!open) return;
            open = false;
            this.openUpgrades = Math.max(0, this.openUpgrades - 1);
          });
        }
      : null;

    server.on("connection", connection);
    if (upgrade) server.on("upgrade", upgrade);
    this.serverAttachments.set(server, { trackUpgrades, connection, upgrade });
  }

  detachServer(server: Server): boolean {
    const attached = this.serverAttachments.get(server);
    if (!attached) return false;
    server.off("connection", attached.connection);
    if (attached.upgrade) server.off("upgrade", attached.upgrade);
    this.serverAttachments.delete(server);
    return true;
  }

  attachRequest(req: PressureRequest, res: PressureResponse): void {
    const method = normalizePressureMethod(req.method);
    const route = routeShape(req.url ?? "");
    const accepted = this.seriesFor(method, route);
    accepted.accepted++;
    accepted.request_bytes[sizeBucketIndex(contentLength(req.headers["content-length"]))]++;

    const requestId = ++this.nextRequestId;
    const active: ActiveRequest = { method, route, startedAt: this.now() };
    this.active.set(requestId, active);
    let done = false;
    const complete = () => {
      if (done) return;
      done = true;
      this.active.delete(requestId);
      const terminal = this.seriesFor(active.method, active.route);
      if (res.writableFinished) terminal.completed++;
      else terminal.aborted++;
      terminal.duration_ms[durationBucketIndex(Math.max(0, this.now() - active.startedAt))]++;
      terminal.response_bytes[sizeBucketIndex(contentLength(res.getHeader("content-length")))]++;
    };
    res.once("finish", complete);
    res.once("close", complete);
  }

  /**
   * Emit and reset a complete window. Non-forced calls before the configured boundary are ignored,
   * which rate-limits timer drift or accidental duplicate calls.
   */
  flush(force = false): string[] {
    const now = this.now();
    const elapsed = Math.max(0, now - this.windowStartedAt);
    if (!force && elapsed < this.windowMs) return [];

    const series = [...this.series.values()].sort((a, b) => `${a.method} ${a.route}`.localeCompare(`${b.method} ${b.route}`));
    this.series = new Map();
    const { gauges, failures } = this.collectGauges(true);
    const activeAgeMax = [...this.active.values()].reduce((max, request) => Math.max(max, now - request.startedAt), 0);
    const loopDelayMs = Number.isFinite(this.eventLoopDelay.max) ? Math.max(0, Math.round(this.eventLoopDelay.max / 1e6)) : 0;
    this.eventLoopDelay.reset();

    const windowMs = Math.round(elapsed);
    const lines: string[] = [];
    if (series.length > 0) {
      lines.push(`${PRESSURE_LOG_PREFIX} ${JSON.stringify({ kind: "http", window_ms: windowMs, series })}`);
    }
    lines.push(
      `${PRESSURE_LOG_PREFIX} ${JSON.stringify({
        kind: "gauges",
        window_ms: windowMs,
        active_requests: this.active.size,
        active_request_age_max_ms: Math.round(activeAgeMax),
        tcp_open: this.openTcp,
        tcp_accepted: this.tcpAccepted,
        upgrades_open: this.openUpgrades,
        upgrades_accepted: this.upgradesAccepted,
        event_loop_delay_max_ms: loopDelayMs,
        gauge_failures: failures,
        ...gauges,
      })}`,
    );
    this.tcpAccepted = 0;
    this.upgradesAccepted = 0;
    this.windowStartedAt = now;
    for (const line of lines) this.write(line);
    return lines;
  }

  private seriesFor(method: PressureMethod, route: string): HttpSeries {
    const key = `${method}\0${route}`;
    const existing = this.series.get(key);
    if (existing) return existing;

    if (this.series.size >= this.maxHttpSeries - 1) {
      const overflowKey = `OTHER\0${OVERFLOW_ROUTE}`;
      let overflow = this.series.get(overflowKey);
      if (!overflow) {
        overflow = emptySeries("OTHER", OVERFLOW_ROUTE);
        this.series.set(overflowKey, overflow);
      }
      return overflow;
    }

    const created = emptySeries(method, route);
    this.series.set(key, created);
    return created;
  }
}
