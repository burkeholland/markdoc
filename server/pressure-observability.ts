import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import {
  collectPressureGauges,
  emptyPressureGaugeSnapshot,
  PRESSURE_GAUGE_NAMES,
  type PressureGaugeCollection,
} from "@/server/pressure-gauges";
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
  id: number;
  method: PressureMethod;
  route: string;
  startedAt: number;
  response: PressureResponse;
  finish: () => void;
  close: () => void;
  owned: boolean;
}

interface ServerAttachment {
  trackUpgrades: boolean;
  connection: (socket: Socket) => void;
  upgrade: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null;
  owned: boolean;
}

interface SocketCloseAttachment {
  server: Server;
  socket: Socket | Duplex;
  close: () => void;
  kind: "tcp" | "upgrade";
  owned: boolean;
}

export type PressureRequest = Pick<IncomingMessage, "method" | "url" | "headers">;
export type PressureResponse = Pick<ServerResponse, "once" | "off" | "writableFinished" | "getHeader">;

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
  private readonly socketCloseAttachments = new Set<SocketCloseAttachment>();
  private upgradedSockets = new WeakSet<object>();
  private series = new Map<string, HttpSeries>();
  private nextRequestId = 0;
  private windowStartedAt: number;
  private openTcp = 0;
  private tcpAccepted = 0;
  private openUpgrades = 0;
  private upgradesAccepted = 0;
  private timer: NodeJS.Timeout | null = null;
  private state: "running" | "stopping" | "stopped" = "running";
  private flushing = false;
  private collectorFailures = 0;
  private outputFailures = 0;

  constructor(options: PressureObservabilityOptions = {}) {
    this.windowMs = options.windowMs ?? PRESSURE_BUCKET_MS;
    this.maxHttpSeries = Math.max(1, Math.floor(options.maxHttpSeries ?? MAX_HTTP_SERIES));
    this.now = options.now ?? (() => Number(process.hrtime.bigint()) / 1e6);
    this.write = options.write ?? ((line) => console.log(line));
    this.collectGauges = options.collectGauges ?? collectPressureGauges;
    this.eventLoopDelay = options.eventLoopDelay ?? monitorEventLoopDelay({ resolution: 20 });
    this.windowStartedAt = this.readNow(0);
  }

  start(): void {
    if (this.state === "stopping") return;
    if (this.state === "stopped") {
      this.state = "running";
      this.windowStartedAt = this.readNow(this.windowStartedAt);
      this.resetEventLoopDelay();
    }
    if (this.timer) return;
    try {
      this.eventLoopDelay.enable();
    } catch {
      this.recordCollectorFailure();
    }
    this.timer = setInterval(() => {
      if (this.state === "running") this.flush();
    }, this.windowMs);
    this.timer.unref();
  }

  stop(flush = true): void {
    if (this.state === "stopping") return;
    if (
      this.state === "stopped" &&
      this.timer === null &&
      this.serverAttachments.size === 0 &&
      this.socketCloseAttachments.size === 0 &&
      this.active.size === 0
    ) {
      return;
    }
    const wasStarted = this.timer !== null;
    this.state = "stopping";
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      if (flush) this.flushInternal(true, "stopping");
    } finally {
      for (const server of [...this.serverAttachments.keys()]) this.detachServer(server);
      for (const attachment of [...this.socketCloseAttachments]) this.releaseSocketClose(attachment, true);
      for (const request of [...this.active.values()]) this.releaseRequest(request);
      this.active.clear();
      this.resetWindowState();
      if (wasStarted) {
        try {
          this.eventLoopDelay.disable();
        } catch {
          this.recordCollectorFailure();
        }
      }
      this.state = "stopped";
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

    const attachment: ServerAttachment = {
      trackUpgrades,
      owned: true,
      connection: () => {},
      upgrade: null,
    };
    const connection = (socket: Socket) => {
      if (!attachment.owned || this.state !== "running") return;
      if (!this.ownSocketClose(server, socket, "tcp")) return;
      this.openTcp++;
      this.tcpAccepted++;
    };
    const upgrade = trackUpgrades
      ? (_req: IncomingMessage, socket: Duplex) => {
          if (!attachment.owned || this.state !== "running") return;
          this.upgradesAccepted++;
          if (this.upgradedSockets.has(socket)) return;
          if (!this.ownSocketClose(server, socket, "upgrade")) return;
          this.upgradedSockets.add(socket);
          this.openUpgrades++;
        }
      : null;
    attachment.connection = connection;
    attachment.upgrade = upgrade;

    server.on("connection", connection);
    if (upgrade) server.on("upgrade", upgrade);
    this.serverAttachments.set(server, attachment);
  }

  detachServer(server: Server): boolean {
    const attached = this.serverAttachments.get(server);
    if (!attached) return false;
    attached.owned = false;
    try {
      server.off("connection", attached.connection);
    } catch {
      this.recordCollectorFailure();
    }
    if (attached.upgrade) {
      try {
        server.off("upgrade", attached.upgrade);
      } catch {
        this.recordCollectorFailure();
      }
    }
    this.serverAttachments.delete(server);
    for (const socket of [...this.socketCloseAttachments]) {
      if (socket.server === server) this.releaseSocketClose(socket, true);
    }
    return true;
  }

  attachRequest(req: PressureRequest, res: PressureResponse): void {
    if (this.state !== "running") return;
    try {
      const method = normalizePressureMethod(req.method);
      const route = routeShape(req.url ?? "");
      const accepted = this.seriesFor(method, route);
      accepted.accepted++;
      accepted.request_bytes[sizeBucketIndex(contentLength(req.headers["content-length"]))]++;

      const requestId = ++this.nextRequestId;
      const active: ActiveRequest = {
        id: requestId,
        method,
        route,
        startedAt: this.readNow(this.windowStartedAt),
        response: res,
        finish: () => {},
        close: () => {},
        owned: true,
      };
      const complete = () => this.completeRequest(active);
      active.finish = complete;
      active.close = complete;
      this.active.set(requestId, active);
      try {
        res.once("finish", active.finish);
        res.once("close", active.close);
      } catch {
        this.releaseRequest(active);
        this.recordCollectorFailure();
      }
    } catch {
      this.recordCollectorFailure();
    }
  }

  /**
   * Emit and reset a complete window. Non-forced calls before the configured boundary are ignored,
   * which rate-limits timer drift or accidental duplicate calls.
   */
  flush(force = false): string[] {
    if (this.state !== "running") return [];
    return this.flushInternal(force, "running");
  }

  private flushInternal(force: boolean, expectedState: "running" | "stopping"): string[] {
    if (this.flushing) return [];
    this.flushing = true;
    try {
      const now = this.readNow(this.windowStartedAt);
      if (this.state !== expectedState) return [];
      const elapsed = Math.max(0, now - this.windowStartedAt);
      if (!force && elapsed < this.windowMs) return [];

      const series = [...this.series.values()].sort((a, b) => `${a.method} ${a.route}`.localeCompare(`${b.method} ${b.route}`));
      this.series = new Map();
      const { gauges, failures } = this.readGauges();
      if (this.state !== expectedState) return [];
      const activeAgeMax = [...this.active.values()].reduce((max, request) => Math.max(max, now - request.startedAt), 0);
      const loopDelayMs = this.readEventLoopDelay();
      this.resetEventLoopDelay();
      if (this.state !== expectedState) return [];
      const windowMs = Math.round(elapsed);
      const tcpAccepted = this.tcpAccepted;
      const upgradesAccepted = this.upgradesAccepted;
      this.tcpAccepted = 0;
      this.upgradesAccepted = 0;
      this.windowStartedAt = now;

      const lines: string[] = [];
      if (series.length > 0) {
        this.emitLine(
          `${PRESSURE_LOG_PREFIX} ${JSON.stringify({ kind: "http", window_ms: windowMs, series })}`,
          lines,
        );
      }
      if (this.state !== expectedState) return lines;
      this.emitLine(
        `${PRESSURE_LOG_PREFIX} ${JSON.stringify({
          kind: "gauges",
          window_ms: windowMs,
          active_requests: this.active.size,
          active_request_age_max_ms: Math.round(activeAgeMax),
          tcp_open: this.openTcp,
          tcp_accepted: tcpAccepted,
          upgrades_open: this.openUpgrades,
          upgrades_accepted: upgradesAccepted,
          event_loop_delay_max_ms: loopDelayMs,
          gauge_failures: failures,
          collector_failures: this.collectorFailures,
          output_failures: this.outputFailures,
          ...gauges,
        })}`,
        lines,
      );
      return lines;
    } catch {
      this.recordCollectorFailure();
      return [];
    } finally {
      this.flushing = false;
    }
  }

  private emitLine(line: string, lines: string[]): void {
    lines.push(line);
    try {
      this.write(line);
    } catch {
      if (this.state !== "stopped") this.outputFailures = incrementBounded(this.outputFailures);
    }
  }

  private readGauges(): PressureGaugeCollection {
    const gauges = emptyPressureGaugeSnapshot();
    try {
      const collected = this.collectGauges(true);
      for (const name of PRESSURE_GAUGE_NAMES) gauges[name] = nonNegativeInteger(collected.gauges[name]);
      return { gauges, failures: nonNegativeInteger(collected.failures) };
    } catch {
      this.recordCollectorFailure();
      return { gauges, failures: 0 };
    }
  }

  private readEventLoopDelay(): number {
    try {
      return Number.isFinite(this.eventLoopDelay.max) ? Math.max(0, Math.round(this.eventLoopDelay.max / 1e6)) : 0;
    } catch {
      this.recordCollectorFailure();
      return 0;
    }
  }

  private resetEventLoopDelay(): void {
    try {
      this.eventLoopDelay.reset();
    } catch {
      this.recordCollectorFailure();
    }
  }

  private readNow(fallback: number): number {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : fallback;
    } catch {
      this.recordCollectorFailure();
      return fallback;
    }
  }

  private recordCollectorFailure(): void {
    if (this.state !== "stopped") this.collectorFailures = incrementBounded(this.collectorFailures);
  }

  private ownSocketClose(server: Server, socket: Socket | Duplex, kind: "tcp" | "upgrade"): boolean {
    const attachment: SocketCloseAttachment = {
      server,
      socket,
      close: () => {},
      kind,
      owned: true,
    };
    attachment.close = () => {
      if (!attachment.owned) return;
      attachment.owned = false;
      this.socketCloseAttachments.delete(attachment);
      if (this.state !== "running") return;
      if (kind === "tcp") this.openTcp = Math.max(0, this.openTcp - 1);
      else this.openUpgrades = Math.max(0, this.openUpgrades - 1);
    };
    this.socketCloseAttachments.add(attachment);
    try {
      socket.once("close", attachment.close);
      return true;
    } catch {
      attachment.owned = false;
      this.socketCloseAttachments.delete(attachment);
      this.recordCollectorFailure();
      return false;
    }
  }

  private releaseSocketClose(attachment: SocketCloseAttachment, adjustOpen: boolean): void {
    if (!attachment.owned) return;
    attachment.owned = false;
    this.socketCloseAttachments.delete(attachment);
    try {
      attachment.socket.off("close", attachment.close);
    } catch {
      this.recordCollectorFailure();
    }
    if (!adjustOpen) return;
    if (attachment.kind === "tcp") this.openTcp = Math.max(0, this.openTcp - 1);
    else this.openUpgrades = Math.max(0, this.openUpgrades - 1);
  }

  private completeRequest(request: ActiveRequest): void {
    if (!request.owned) return;
    this.releaseRequest(request);
    if (this.state !== "running") return;
    try {
      const completed = request.response.writableFinished;
      const duration = durationBucketIndex(Math.max(0, this.readNow(request.startedAt) - request.startedAt));
      const responseBytes = sizeBucketIndex(contentLength(request.response.getHeader("content-length")));
      const terminal = this.seriesFor(request.method, request.route);
      if (completed) terminal.completed++;
      else terminal.aborted++;
      terminal.duration_ms[duration]++;
      terminal.response_bytes[responseBytes]++;
    } catch {
      this.recordCollectorFailure();
    }
  }

  private releaseRequest(request: ActiveRequest): void {
    if (!request.owned) return;
    request.owned = false;
    this.active.delete(request.id);
    try {
      request.response.off("finish", request.finish);
    } catch {
      this.recordCollectorFailure();
    }
    try {
      request.response.off("close", request.close);
    } catch {
      this.recordCollectorFailure();
    }
  }

  private resetWindowState(): void {
    this.series = new Map();
    this.nextRequestId = 0;
    this.openTcp = 0;
    this.tcpAccepted = 0;
    this.openUpgrades = 0;
    this.upgradesAccepted = 0;
    this.upgradedSockets = new WeakSet<object>();
    this.windowStartedAt = this.readNow(this.windowStartedAt);
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

function incrementBounded(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
}
