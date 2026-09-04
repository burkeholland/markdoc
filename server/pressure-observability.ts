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

interface FlushAuthority {
  kind: "running" | "stopping";
  generation: symbol;
  seedCollectorFailures?: number;
  seedOutputFailures?: number;
  claimedOutputs?: ReadonlySet<PressureOutputKind>;
  eventLoopResetClaimed?: boolean;
}

interface FlushOperation extends FlushAuthority {
  collectorFailures: number;
  outputFailures: number;
  outputClaims: Set<PressureOutputKind>;
  eventLoopResetClaimed: boolean;
}

type PressureOutputKind = "http" | "gauges";

interface OwnedValue<T> {
  owned: boolean;
  value: T;
}

interface WindowSnapshot {
  series: Map<string, HttpSeries>;
  activeRequests: number;
  activeRequestAgeMaxMs: number;
  tcpOpen: number;
  tcpAccepted: number;
  upgradesOpen: number;
  upgradesAccepted: number;
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

function cloneSeries(series: HttpSeries): HttpSeries {
  return {
    ...series,
    duration_ms: [...series.duration_ms],
    request_bytes: [...series.request_bytes],
    response_bytes: [...series.response_bytes],
  };
}

function subtractSeries(
  current: Map<string, HttpSeries>,
  consumed: Map<string, HttpSeries>,
): Map<string, HttpSeries> {
  const remaining = new Map<string, HttpSeries>();
  for (const [key, series] of current) {
    const snapshot = consumed.get(key);
    if (!snapshot) {
      remaining.set(key, cloneSeries(series));
      continue;
    }
    const next: HttpSeries = {
      method: series.method,
      route: series.route,
      accepted: Math.max(0, series.accepted - snapshot.accepted),
      completed: Math.max(0, series.completed - snapshot.completed),
      aborted: Math.max(0, series.aborted - snapshot.aborted),
      duration_ms: series.duration_ms.map((value, index) =>
        Math.max(0, value - snapshot.duration_ms[index]),
      ) as DurationBuckets,
      request_bytes: series.request_bytes.map((value, index) =>
        Math.max(0, value - snapshot.request_bytes[index]),
      ) as SizeBuckets,
      response_bytes: series.response_bytes.map((value, index) =>
        Math.max(0, value - snapshot.response_bytes[index]),
      ) as SizeBuckets,
    };
    if (
      next.accepted > 0 ||
      next.completed > 0 ||
      next.aborted > 0 ||
      [...next.duration_ms, ...next.request_bytes, ...next.response_bytes].some((value) => value > 0)
    ) {
      remaining.set(key, next);
    }
  }
  return remaining;
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
  private runningGeneration: symbol | null = Symbol("pressure-observability-run");
  private stopGeneration: symbol | null = null;
  private state: "running" | "stopping" | "stopped" = "running";
  private flushOwner: FlushOperation | null = null;
  private readonly flushFrames = new Set<FlushOperation>();
  private injectedBoundaryDepth = 0;
  private restartPending = false;
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
    if (
      this.state === "stopping" ||
      (this.state === "stopped" &&
        (this.flushFrames.size > 0 || this.injectedBoundaryDepth > 0))
    ) {
      this.restartPending = true;
      return;
    }
    let restarted = false;
    if (this.state === "stopped") {
      restarted = true;
      this.restartPending = false;
      this.state = "running";
      this.runningGeneration = Symbol("pressure-observability-run");
    }
    const generation = this.runningGeneration;
    if (this.state !== "running" || generation === null) return;
    if (restarted) {
      const nowResult = this.readRunningNow(generation, this.windowStartedAt);
      if (!nowResult.owned) return;
      this.windowStartedAt = nowResult.value;
      if (!this.resetRunningEventLoopDelay(generation)) return;
    }
    if (this.timer || !this.enableRunningEventLoopDelay(generation)) return;
    const timer = setInterval(() => {
      this.flushInternal(false, { kind: "running", generation });
    }, this.windowMs);
    if (!this.ownsRunningGeneration(generation)) {
      clearInterval(timer);
      return;
    }
    this.timer = timer;
    timer.unref();
  }

  stop(flush = true): void {
    if (this.state === "stopping") return;
    if (
      this.state === "stopped" &&
      this.timer === null &&
      this.runningGeneration === null &&
      this.serverAttachments.size === 0 &&
      this.socketCloseAttachments.size === 0 &&
      this.active.size === 0
    ) {
      this.restartPending = false;
      return;
    }
    const wasStarted = this.timer !== null;
    const timer = this.timer;
    const stopGeneration = Symbol("pressure-observability-stop");
    const interruptedFlush =
      this.flushOwner?.kind === "running" && this.ownsFlush(this.flushOwner)
        ? this.flushOwner
        : null;
    this.runningGeneration = null;
    this.flushOwner = null;
    this.timer = null;
    this.state = "stopping";
    this.stopGeneration = stopGeneration;
    if (timer) clearInterval(timer);
    try {
      if (flush) {
        this.flushInternal(true, {
          kind: "stopping",
          generation: stopGeneration,
          seedCollectorFailures: interruptedFlush?.collectorFailures,
          seedOutputFailures: interruptedFlush?.outputFailures,
          claimedOutputs: interruptedFlush?.outputClaims,
          eventLoopResetClaimed: interruptedFlush?.eventLoopResetClaimed,
        });
      }
    } finally {
      for (const server of [...this.serverAttachments.keys()]) this.detachServer(server);
      for (const attachment of [...this.socketCloseAttachments]) this.releaseSocketClose(attachment, true);
      for (const request of [...this.active.values()]) this.releaseRequest(request);
      this.active.clear();
      this.resetWindowState();
      if (wasStarted) {
        this.disableStoppingEventLoopDelay(stopGeneration);
      }
      this.stopGeneration = null;
      this.state = "stopped";
      this.startPendingRestart();
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
    const generation = this.runningGeneration;
    if (generation === null) return [];
    return this.flushInternal(force, { kind: "running", generation });
  }

  private flushInternal(force: boolean, authority: FlushAuthority): string[] {
    const operation = this.beginFlush(authority);
    if (operation === null) return [];
    const lines: string[] = [];
    try {
      const nowResult = this.readOwnedNow(operation, this.windowStartedAt);
      if (!nowResult.owned) return [];
      const now = nowResult.value;
      const elapsed = Math.max(0, now - this.windowStartedAt);
      if (!force && elapsed < this.windowMs) return [];

      const snapshot = this.snapshotWindow(now);
      const gaugeResult = this.readOwnedGauges(operation);
      if (!gaugeResult.owned) return [];
      const loopDelayResult = this.readOwnedEventLoopDelay(operation);
      if (!loopDelayResult.owned) return [];
      if (!operation.eventLoopResetClaimed && !this.resetOwnedEventLoopDelay(operation)) return [];
      if (!this.ownsFlush(operation)) return [];

      const windowMs = Math.round(elapsed);
      const series = [...snapshot.series.values()].sort((a, b) =>
        `${a.method} ${a.route}`.localeCompare(`${b.method} ${b.route}`),
      );
      if (
        series.length > 0 &&
        !operation.outputClaims.has("http") &&
        !this.emitOwnedLine(
          operation,
          "http",
          `${PRESSURE_LOG_PREFIX} ${JSON.stringify({ kind: "http", window_ms: windowMs, series })}`,
          lines,
        )
      ) {
        return [];
      }
      if (
        !operation.outputClaims.has("gauges") &&
        !this.emitOwnedLine(
          operation,
          "gauges",
          `${PRESSURE_LOG_PREFIX} ${JSON.stringify({
            kind: "gauges",
            window_ms: windowMs,
            active_requests: snapshot.activeRequests,
            active_request_age_max_ms: Math.round(snapshot.activeRequestAgeMaxMs),
            tcp_open: snapshot.tcpOpen,
            tcp_accepted: snapshot.tcpAccepted,
            upgrades_open: snapshot.upgradesOpen,
            upgrades_accepted: snapshot.upgradesAccepted,
            event_loop_delay_max_ms: loopDelayResult.value,
            gauge_failures: gaugeResult.value.failures,
            collector_failures: operation.collectorFailures,
            output_failures: operation.outputFailures,
            ...gaugeResult.value.gauges,
          })}`,
          lines,
        )
      ) {
        return [];
      }
      if (!this.commitWindow(operation, snapshot, now)) return [];
      return lines;
    } catch {
      if (this.ownsFlush(operation)) {
        operation.collectorFailures = incrementBounded(operation.collectorFailures);
        this.collectorFailures = operation.collectorFailures;
        this.outputFailures = operation.outputFailures;
      }
      return [];
    } finally {
      this.finishFlush(operation);
    }
  }

  private beginFlush(authority: FlushAuthority): FlushOperation | null {
    if (!this.ownsFlushAuthority(authority) || this.flushOwner !== null) return null;
    const operation: FlushOperation = {
      ...authority,
      collectorFailures: authority.seedCollectorFailures ?? this.collectorFailures,
      outputFailures: authority.seedOutputFailures ?? this.outputFailures,
      outputClaims: new Set(authority.claimedOutputs),
      eventLoopResetClaimed: authority.eventLoopResetClaimed === true,
    };
    this.flushOwner = operation;
    this.flushFrames.add(operation);
    return operation;
  }

  private finishFlush(operation: FlushOperation): void {
    this.flushFrames.delete(operation);
    if (this.flushOwner === operation) this.flushOwner = null;
    this.startPendingRestart();
  }

  private ownsFlushAuthority(authority: FlushAuthority): boolean {
    if (authority.kind === "running") {
      return this.state === "running" && this.runningGeneration === authority.generation;
    }
    return this.state === "stopping" && this.stopGeneration === authority.generation;
  }

  private ownsFlush(operation: FlushOperation): boolean {
    return this.flushOwner === operation && this.ownsFlushAuthority(operation);
  }

  private startPendingRestart(): void {
    if (
      !this.restartPending ||
      this.state !== "stopped" ||
      this.flushFrames.size !== 0 ||
      this.injectedBoundaryDepth !== 0
    ) {
      return;
    }
    this.restartPending = false;
    this.start();
  }

  private injectedBoundary<T>(callback: () => T): T {
    this.injectedBoundaryDepth++;
    try {
      return callback();
    } finally {
      this.injectedBoundaryDepth--;
      this.startPendingRestart();
    }
  }

  private snapshotWindow(now: number): WindowSnapshot {
    return {
      series: new Map([...this.series].map(([key, series]) => [key, cloneSeries(series)])),
      activeRequests: this.active.size,
      activeRequestAgeMaxMs: [...this.active.values()].reduce(
        (max, request) => Math.max(max, now - request.startedAt),
        0,
      ),
      tcpOpen: this.openTcp,
      tcpAccepted: this.tcpAccepted,
      upgradesOpen: this.openUpgrades,
      upgradesAccepted: this.upgradesAccepted,
    };
  }

  private commitWindow(operation: FlushOperation, snapshot: WindowSnapshot, now: number): boolean {
    if (!this.ownsFlush(operation)) return false;
    const remainingSeries = subtractSeries(this.series, snapshot.series);
    if (!this.ownsFlush(operation)) return false;
    this.series = remainingSeries;
    if (!this.ownsFlush(operation)) return false;
    this.tcpAccepted = Math.max(0, this.tcpAccepted - snapshot.tcpAccepted);
    if (!this.ownsFlush(operation)) return false;
    this.upgradesAccepted = Math.max(0, this.upgradesAccepted - snapshot.upgradesAccepted);
    if (!this.ownsFlush(operation)) return false;
    this.windowStartedAt = now;
    if (!this.ownsFlush(operation)) return false;
    this.collectorFailures = operation.collectorFailures;
    if (!this.ownsFlush(operation)) return false;
    this.outputFailures = operation.outputFailures;
    return true;
  }

  private emitOwnedLine(
    operation: FlushOperation,
    kind: PressureOutputKind,
    line: string,
    lines: string[],
  ): boolean {
    if (!this.ownsFlush(operation)) return false;
    let write: (line: string) => void;
    try {
      write = this.injectedBoundary(() => this.write);
    } catch {
      if (!this.ownsFlush(operation)) return false;
      operation.outputFailures = incrementBounded(operation.outputFailures);
      if (!this.ownsFlush(operation)) return false;
      lines.push(line);
      return true;
    }
    if (!this.ownsFlush(operation)) return false;
    operation.outputClaims.add(kind);
    try {
      this.injectedBoundary(() => Reflect.apply(write, this, [line]));
    } catch {
      if (!this.ownsFlush(operation)) return false;
      operation.outputFailures = incrementBounded(operation.outputFailures);
    }
    if (!this.ownsFlush(operation)) return false;
    lines.push(line);
    return true;
  }

  private readOwnedGauges(operation: FlushOperation): OwnedValue<PressureGaugeCollection> {
    const gauges = emptyPressureGaugeSnapshot();
    if (!this.ownsFlush(operation)) return { owned: false, value: { gauges, failures: 0 } };
    let collect: (resetIntervalMaximum: boolean) => PressureGaugeCollection;
    try {
      collect = this.injectedBoundary(() => this.collectGauges);
    } catch {
      return this.ownedCollectorFallback(operation, { gauges, failures: 0 });
    }
    if (!this.ownsFlush(operation)) return { owned: false, value: { gauges, failures: 0 } };
    let collected: PressureGaugeCollection;
    try {
      collected = this.injectedBoundary(() => Reflect.apply(collect, this, [true]));
    } catch {
      return this.ownedCollectorFallback(operation, { gauges, failures: 0 });
    }
    if (!this.ownsFlush(operation)) return { owned: false, value: { gauges, failures: 0 } };
    try {
      const collectedGauges = this.injectedBoundary(() => collected.gauges);
      if (!this.ownsFlush(operation)) return { owned: false, value: { gauges, failures: 0 } };
      for (const name of PRESSURE_GAUGE_NAMES) {
        const value = this.injectedBoundary(() => collectedGauges[name]);
        if (!this.ownsFlush(operation)) return { owned: false, value: { gauges, failures: 0 } };
        gauges[name] = nonNegativeInteger(value);
      }
      const failures = this.injectedBoundary(() => collected.failures);
      if (!this.ownsFlush(operation)) return { owned: false, value: { gauges, failures: 0 } };
      return { owned: true, value: { gauges, failures: nonNegativeInteger(failures) } };
    } catch {
      return this.ownedCollectorFallback(operation, { gauges, failures: 0 });
    }
  }

  private readOwnedEventLoopDelay(operation: FlushOperation): OwnedValue<number> {
    if (!this.ownsFlush(operation)) return { owned: false, value: 0 };
    try {
      const monitor = this.injectedBoundary(() => this.eventLoopDelay);
      if (!this.ownsFlush(operation)) return { owned: false, value: 0 };
      const max = this.injectedBoundary(() => monitor.max);
      if (!this.ownsFlush(operation)) return { owned: false, value: 0 };
      return {
        owned: true,
        value: Number.isFinite(max) ? Math.max(0, Math.round(max / 1e6)) : 0,
      };
    } catch {
      return this.ownedCollectorFallback(operation, 0);
    }
  }

  private resetOwnedEventLoopDelay(operation: FlushOperation): boolean {
    if (!this.ownsFlush(operation)) return false;
    let monitor: EventLoopDelayMonitor;
    try {
      monitor = this.injectedBoundary(() => this.eventLoopDelay);
    } catch {
      return this.ownedCollectorFallback(operation, true).owned;
    }
    if (!this.ownsFlush(operation)) return false;
    let reset: () => void;
    try {
      reset = this.injectedBoundary(() => monitor.reset);
    } catch {
      return this.ownedCollectorFallback(operation, true).owned;
    }
    if (!this.ownsFlush(operation)) return false;
    operation.eventLoopResetClaimed = true;
    try {
      this.injectedBoundary(() => Reflect.apply(reset, monitor, []));
    } catch {
      return this.ownedCollectorFallback(operation, true).owned;
    }
    return this.ownsFlush(operation);
  }

  private readOwnedNow(operation: FlushOperation, fallback: number): OwnedValue<number> {
    if (!this.ownsFlush(operation)) return { owned: false, value: fallback };
    let now: () => number;
    try {
      now = this.injectedBoundary(() => this.now);
    } catch {
      return this.ownedCollectorFallback(operation, fallback);
    }
    if (!this.ownsFlush(operation)) return { owned: false, value: fallback };
    try {
      const value = this.injectedBoundary(() => Reflect.apply(now, this, []));
      if (!this.ownsFlush(operation)) return { owned: false, value: fallback };
      return { owned: true, value: Number.isFinite(value) ? value : fallback };
    } catch {
      return this.ownedCollectorFallback(operation, fallback);
    }
  }

  private ownedCollectorFallback<T>(operation: FlushOperation, fallback: T): OwnedValue<T> {
    if (!this.ownsFlush(operation)) return { owned: false, value: fallback };
    operation.collectorFailures = incrementBounded(operation.collectorFailures);
    return { owned: this.ownsFlush(operation), value: fallback };
  }

  private ownsRunningGeneration(generation: symbol): boolean {
    return this.state === "running" && this.runningGeneration === generation;
  }

  private readRunningNow(generation: symbol, fallback: number): OwnedValue<number> {
    if (!this.ownsRunningGeneration(generation)) return { owned: false, value: fallback };
    let now: () => number;
    try {
      now = this.injectedBoundary(() => this.now);
    } catch {
      if (!this.ownsRunningGeneration(generation)) return { owned: false, value: fallback };
      this.recordCollectorFailure();
      return { owned: true, value: fallback };
    }
    if (!this.ownsRunningGeneration(generation)) return { owned: false, value: fallback };
    try {
      const value = this.injectedBoundary(() => Reflect.apply(now, this, []));
      if (!this.ownsRunningGeneration(generation)) return { owned: false, value: fallback };
      return { owned: true, value: Number.isFinite(value) ? value : fallback };
    } catch {
      if (!this.ownsRunningGeneration(generation)) return { owned: false, value: fallback };
      this.recordCollectorFailure();
      return { owned: true, value: fallback };
    }
  }

  private resetRunningEventLoopDelay(generation: symbol): boolean {
    if (!this.ownsRunningGeneration(generation)) return false;
    try {
      const monitor = this.injectedBoundary(() => this.eventLoopDelay);
      if (!this.ownsRunningGeneration(generation)) return false;
      const reset = this.injectedBoundary(() => monitor.reset);
      if (!this.ownsRunningGeneration(generation)) return false;
      this.injectedBoundary(() => Reflect.apply(reset, monitor, []));
      return this.ownsRunningGeneration(generation);
    } catch {
      if (!this.ownsRunningGeneration(generation)) return false;
      this.recordCollectorFailure();
      return true;
    }
  }

  private enableRunningEventLoopDelay(generation: symbol): boolean {
    if (!this.ownsRunningGeneration(generation)) return false;
    try {
      const monitor = this.injectedBoundary(() => this.eventLoopDelay);
      if (!this.ownsRunningGeneration(generation)) return false;
      const enable = this.injectedBoundary(() => monitor.enable);
      if (!this.ownsRunningGeneration(generation)) return false;
      this.injectedBoundary(() => Reflect.apply(enable, monitor, []));
      return this.ownsRunningGeneration(generation);
    } catch {
      if (!this.ownsRunningGeneration(generation)) return false;
      this.recordCollectorFailure();
      return true;
    }
  }

  private disableStoppingEventLoopDelay(generation: symbol): void {
    if (this.state !== "stopping" || this.stopGeneration !== generation) return;
    try {
      const monitor = this.injectedBoundary(() => this.eventLoopDelay);
      if (this.state !== "stopping" || this.stopGeneration !== generation) return;
      const disable = this.injectedBoundary(() => monitor.disable);
      if (this.state !== "stopping" || this.stopGeneration !== generation) return;
      this.injectedBoundary(() => Reflect.apply(disable, monitor, []));
    } catch {
      if (this.state === "stopping" && this.stopGeneration === generation) {
        this.recordCollectorFailure();
      }
    }
  }

  private recordCollectorFailure(): void {
    if (this.state === "stopped") return;
    const operation = this.flushOwner;
    if (operation && this.ownsFlush(operation)) {
      operation.collectorFailures = incrementBounded(operation.collectorFailures);
      return;
    }
    this.collectorFailures = incrementBounded(this.collectorFailures);
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
