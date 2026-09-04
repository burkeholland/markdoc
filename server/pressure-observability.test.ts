import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  durationBucketIndex,
  MAX_HTTP_SERIES,
  normalizePressureMethod,
  OVERFLOW_ROUTE,
  PRESSURE_BUCKET_MS,
  PRESSURE_LOG_PREFIX,
  PressureObservability,
  sizeBucketIndex,
  type PressureRequest,
  type PressureResponse,
} from "./pressure-observability";
import { collectPressureGauges, registerPressureGauge } from "@/server/pressure-gauges";

class FakeResponse extends EventEmitter {
  writableFinished = false;
  private readonly headers = new Map<string, string | number | string[]>();

  getHeader(name: string) {
    return this.headers.get(name.toLowerCase());
  }

  setHeader(name: string, value: string | number | string[]) {
    this.headers.set(name.toLowerCase(), value);
  }

  finish() {
    this.writableFinished = true;
    this.emit("finish");
    this.emit("close");
  }

  abort() {
    this.emit("close");
  }
}

class FakeDelay {
  max = 0;
  enabled = false;
  resets = 0;

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }

  reset() {
    this.resets++;
    this.max = 0;
  }
}

function request(url: string, method = "GET", contentLength?: string): PressureRequest {
  return {
    method,
    url,
    headers: {
      ...(contentLength === undefined ? {} : { "content-length": contentLength }),
      authorization: "******",
      cookie: "session=******",
      "x-forwarded-for": "203.0.113.42",
    },
  } as PressureRequest;
}

function response(): FakeResponse & PressureResponse {
  return new FakeResponse() as FakeResponse & PressureResponse;
}

function payload(line: string): Record<string, unknown> {
  expect(line.startsWith(`${PRESSURE_LOG_PREFIX} `)).toBe(true);
  return JSON.parse(line.slice(PRESSURE_LOG_PREFIX.length + 1)) as Record<string, unknown>;
}

function harness(options: { maxHttpSeries?: number } = {}) {
  let now = 0;
  const writes: string[] = [];
  const delay = new FakeDelay();
  const pressure = new PressureObservability({
    now: () => now,
    write: (line) => writes.push(line),
    eventLoopDelay: delay,
    maxHttpSeries: options.maxHttpSeries,
  });
  return { pressure, writes, delay, setNow: (value: number) => (now = value) };
}

function httpSeries(lines: string[]) {
  const http = lines.map(payload).find((item) => item.kind === "http");
  return (http?.series ?? []) as Array<Record<string, unknown>>;
}

function gauges(lines: string[]) {
  return lines.map(payload).find((item) => item.kind === "gauges")!;
}

describe("pressure normalization and bounds", () => {
  it("allows only fixed HTTP methods and reuses the privacy-safe route shape", () => {
    expect(normalizePressureMethod("get")).toBe("GET");
    expect(normalizePressureMethod("PROPFIND")).toBe("OTHER");
    expect(normalizePressureMethod("GET ******")).toBe("OTHER");

    const { pressure } = harness();
    const res = response();
    pressure.attachRequest(request("/api/documents/k3j9x0v2m8qa/collaborators?token=******", "GET"), res);
    res.finish();
    const [series] = httpSeries(pressure.flush(true));
    expect(series).toMatchObject({ method: "GET", route: "/api/documents/:id/collaborators" });
  });

  it("caps HTTP series and collapses excess labels into one overflow series", () => {
    const { pressure } = harness({ maxHttpSeries: 3 });
    for (const url of ["/api/health", "/api/me", "/api/tokens", "/api/webhooks"]) {
      const res = response();
      pressure.attachRequest(request(url), res);
      res.finish();
    }
    const series = httpSeries(pressure.flush(true));
    expect(series).toHaveLength(3);
    expect(series.find((item) => item.route === OVERFLOW_ROUTE)).toMatchObject({ method: "OTHER", accepted: 2, completed: 2 });
    expect(MAX_HTTP_SERIES).toBe(24);
  });
});

describe("pressure aggregation", () => {
  it("aggregates accepted and completed requests, then resets the HTTP window", () => {
    const { pressure, setNow } = harness();
    const first = response();
    const second = response();
    pressure.attachRequest(request("/api/health"), first);
    pressure.attachRequest(request("/api/health"), second);
    first.finish();
    second.finish();
    setNow(PRESSURE_BUCKET_MS);

    const lines = pressure.flush();
    expect(httpSeries(lines)).toEqual([
      expect.objectContaining({ method: "GET", route: "/api/health", accepted: 2, completed: 2, aborted: 0 }),
    ]);
    expect(httpSeries(pressure.flush(true))).toEqual([]);
  });

  it("records an active age maximum and a later abort in separate windows", () => {
    const { pressure, setNow } = harness();
    const res = response();
    pressure.attachRequest(request("/d/k3j9x0v2m8qa"), res);
    setNow(5_000);
    const activeWindow = pressure.flush(true);
    expect(gauges(activeWindow)).toMatchObject({ active_requests: 1, active_request_age_max_ms: 5_000 });
    expect(httpSeries(activeWindow)[0]).toMatchObject({ accepted: 1, completed: 0, aborted: 0 });

    setNow(7_500);
    res.abort();
    const abortedWindow = pressure.flush(true);
    expect(httpSeries(abortedWindow)[0]).toMatchObject({
      route: "/d/:id",
      accepted: 0,
      completed: 0,
      aborted: 1,
      duration_ms: [0, 0, 0, 1, 0],
    });
    expect(gauges(abortedWindow)).toMatchObject({ active_requests: 0, active_request_age_max_ms: 0 });
  });

  it("uses coarse duration and content-length buckets without retaining bytes", () => {
    expect([0, 100, 101, 500, 501, 2_000, 2_001, 10_000, 10_001].map(durationBucketIndex)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4]);
    expect([null, 0, 1, 1_024, 1_025, 65_536, 65_537, 1_048_576, 1_048_577].map(sizeBucketIndex)).toEqual([5, 0, 1, 1, 2, 2, 3, 3, 4]);

    const { pressure, setNow } = harness();
    const res = response();
    res.setHeader("content-length", 70_000);
    pressure.attachRequest(request("/api/import/file", "POST", "1024"), res);
    setNow(450);
    res.finish();
    expect(httpSeries(pressure.flush(true))[0]).toMatchObject({
      duration_ms: [0, 1, 0, 0, 0],
      request_bytes: [0, 1, 0, 0, 0, 0],
      response_bytes: [0, 0, 0, 1, 0, 0],
    });
  });
});

describe("pressure gauges and cadence", () => {
  it("collects non-negative integer gauges, resets interval maxima, and surfaces provider failures", () => {
    let checkout = 12.6;
    const disposeTotal = registerPressureGauge("pg_total", () => 4.4);
    const disposeCheckout = registerPressureGauge("pg_checkout_max_ms", (reset) => {
      const value = checkout;
      if (reset) checkout = 0;
      return value;
    });
    const disposeFailure = registerPressureGauge("pdf_inflight", () => {
      throw new Error("fixed test failure");
    });
    try {
      const first = collectPressureGauges();
      expect(first.gauges).toMatchObject({ pg_total: 4, pg_checkout_max_ms: 13, pdf_inflight: 0 });
      expect(Object.keys(first.gauges)).toHaveLength(12);
      expect(first.failures).toBe(1);
      const output = harness().pressure.flush(true).join("\n");
      expect(output).toContain('"gauge_failures":1');
      expect(output).not.toContain("fixed test failure");
      expect(collectPressureGauges().gauges.pg_checkout_max_ms).toBe(0);
    } finally {
      disposeTotal();
      disposeCheckout();
      disposeFailure();
    }
  });

  it("rate-limits duplicate flushes to one 15-second boundary", () => {
    const { pressure, writes, setNow } = harness();
    const res = response();
    pressure.attachRequest(request("/api/health"), res);
    res.finish();
    setNow(PRESSURE_BUCKET_MS - 1);
    expect(pressure.flush()).toEqual([]);
    expect(writes).toEqual([]);
    setNow(PRESSURE_BUCKET_MS);
    expect(pressure.flush()).toHaveLength(2);
    expect(writes).toHaveLength(2);
    expect(pressure.flush()).toEqual([]);
  });

  it("collects TCP, upgrade, and event-loop state without socket labels", () => {
    const { pressure, delay } = harness();
    const server = new EventEmitter();
    const tcp = new EventEmitter();
    const upgrade = new EventEmitter();
    pressure.attachServer(server as Server);
    server.emit("connection", tcp);
    server.emit("connection", upgrade);
    server.emit("upgrade", request("/collab"), upgrade, Buffer.alloc(0));
    delay.max = 8_600_000;

    expect(gauges(pressure.flush(true))).toMatchObject({
      tcp_open: 2,
      tcp_accepted: 2,
      upgrades_open: 1,
      upgrades_accepted: 1,
      event_loop_delay_max_ms: 9,
    });
    tcp.emit("close");
    upgrade.emit("close");
    expect(gauges(pressure.flush(true))).toMatchObject({ tcp_open: 0, tcp_accepted: 0, upgrades_open: 0, upgrades_accepted: 0 });
    expect(delay.resets).toBe(2);
  });

  it("owns one listener per event across duplicate attachment and removes only its listeners on stop", () => {
    const { pressure, writes } = harness();
    const server = new EventEmitter();
    const tcp = new EventEmitter();
    const upgrade = new EventEmitter();
    const otherConnection = vi.fn();
    const otherUpgrade = vi.fn();
    server.on("connection", otherConnection);
    server.on("upgrade", otherUpgrade);

    pressure.attachServer(server as Server);
    pressure.attachServer(server as Server);
    expect(server.listenerCount("connection")).toBe(2);
    expect(server.listenerCount("upgrade")).toBe(2);

    server.emit("connection", tcp);
    server.emit("upgrade", request("/collab"), upgrade, Buffer.alloc(0));
    expect(gauges(pressure.flush(true))).toMatchObject({
      tcp_open: 1,
      tcp_accepted: 1,
      upgrades_open: 1,
      upgrades_accepted: 1,
    });
    expect(otherConnection).toHaveBeenCalledTimes(1);
    expect(otherUpgrade).toHaveBeenCalledTimes(1);

    tcp.emit("close");
    upgrade.emit("close");
    pressure.stop(false);
    expect(server.listeners("connection")).toEqual([otherConnection]);
    expect(server.listeners("upgrade")).toEqual([otherUpgrade]);
    const writesAfterStop = writes.length;
    expect(pressure.detachServer(server as Server)).toBe(false);
    expect(() => pressure.stop(false)).not.toThrow();
    expect(writes).toHaveLength(writesAfterStop);
    expect(pressure.flush(true)).toEqual([]);
    pressure.start();
    expect(gauges(pressure.flush(true))).toMatchObject({
      tcp_open: 0,
      tcp_accepted: 0,
      upgrades_open: 0,
      upgrades_accepted: 0,
    });
    pressure.stop(false);
  });

  it("keeps main and TCP-only standby tracking separate and rejects contradictory reattachment", () => {
    const { pressure } = harness();
    const main = new EventEmitter();
    const standby = new EventEmitter();
    pressure.attachServer(main as Server);
    pressure.attachServer(standby as Server, { trackUpgrades: false });
    pressure.attachServer(standby as Server, { trackUpgrades: false });
    expect(main.listenerCount("connection")).toBe(1);
    expect(main.listenerCount("upgrade")).toBe(1);
    expect(standby.listenerCount("connection")).toBe(1);
    expect(standby.listenerCount("upgrade")).toBe(0);

    expect(() => pressure.attachServer(main as Server, { trackUpgrades: false })).toThrow(
      "already attached to this server with trackUpgrades=true",
    );
    expect(() => pressure.attachServer(standby as Server)).toThrow(
      "already attached to this server with trackUpgrades=false",
    );
    expect(main.listenerCount("connection")).toBe(1);
    expect(main.listenerCount("upgrade")).toBe(1);
    expect(standby.listenerCount("connection")).toBe(1);
    expect(standby.listenerCount("upgrade")).toBe(0);

    const mainSocket = new EventEmitter();
    const standbySocket = new EventEmitter();
    const mainUpgrade = new EventEmitter();
    main.emit("connection", mainSocket);
    standby.emit("connection", standbySocket);
    main.emit("upgrade", request("/collab"), mainUpgrade, Buffer.alloc(0));
    expect(standby.emit("upgrade", request("/collab"), standbySocket, Buffer.alloc(0))).toBe(false);
    expect(gauges(pressure.flush(true))).toMatchObject({
      tcp_open: 2,
      tcp_accepted: 2,
      upgrades_open: 1,
      upgrades_accepted: 1,
    });

    pressure.stop(false);
    expect(main.listenerCount("connection")).toBe(0);
    expect(main.listenerCount("upgrade")).toBe(0);
    expect(standby.listenerCount("connection")).toBe(0);
    expect(standby.listenerCount("upgrade")).toBe(0);
    mainSocket.emit("close");
    standbySocket.emit("close");
    mainUpgrade.emit("close");
  });

  it("does not resurrect listeners on restart and permits an explicit fresh attachment", () => {
    vi.useFakeTimers();
    try {
      const { pressure, delay } = harness();
      const server = new EventEmitter();
      pressure.attachServer(server as Server);
      pressure.start();
      pressure.start();
      expect(vi.getTimerCount()).toBe(1);
      expect(delay.enabled).toBe(true);

      pressure.stop(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(delay.enabled).toBe(false);
      expect(server.listenerCount("connection")).toBe(0);
      expect(server.listenerCount("upgrade")).toBe(0);

      pressure.start();
      expect(vi.getTimerCount()).toBe(1);
      expect(server.listenerCount("connection")).toBe(0);
      expect(server.listenerCount("upgrade")).toBe(0);
      pressure.attachServer(server as Server);
      expect(server.listenerCount("connection")).toBe(1);
      expect(server.listenerCount("upgrade")).toBe(1);
      pressure.stop(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps open socket accounting exact across detach, flush, shutdown, and repeated close", () => {
    const { pressure } = harness();
    const server = new EventEmitter();
    const socket = new EventEmitter();
    pressure.attachServer(server as Server);
    server.emit("connection", socket);
    server.emit("upgrade", request("/collab"), socket, Buffer.alloc(0));

    expect(pressure.detachServer(server as Server)).toBe(true);
    expect(pressure.detachServer(server as Server)).toBe(false);
    expect(gauges(pressure.flush(true))).toMatchObject({
      tcp_open: 0,
      tcp_accepted: 1,
      upgrades_open: 0,
      upgrades_accepted: 1,
    });

    pressure.stop(false);
    socket.emit("close");
    socket.emit("close");
    pressure.start();
    expect(gauges(pressure.flush(true))).toMatchObject({
      tcp_open: 0,
      tcp_accepted: 0,
      upgrades_open: 0,
      upgrades_accepted: 0,
    });
    pressure.stop(false);
  });
});

describe("pressure privacy", () => {
  it("never emits query strings, ids, headers, addresses, bodies, methods, or unknown path segments verbatim", () => {
    const { pressure } = harness();
    const res = response();
    res.setHeader("content-length", "17");
    pressure.attachRequest(
      request(
        "/api/documents/k3j9x0v2m8qa/someone@example.com?token=******&webhook=https://private.example/hook",
        "TRACE secret-method",
        "42",
      ),
      res,
    );
    res.finish();
    const output = pressure.flush(true).join("\n");
    for (const excluded of [
      "k3j9x0v2m8qa",
      "someone@example.com",
      "******",
      "private.example",
      "session=",
      "203.0.113.42",
      "secret-method",
    ]) {
      expect(output).not.toContain(excluded);
    }
    expect(output).toContain('"method":"OTHER"');
    expect(output).toContain('"route":"/api/documents/:id/:x"');
  });

  it("bounds 100,000 requests over 1,000 sensitive variants to 24 sanitized series", () => {
    const { pressure } = harness();
    for (let index = 0; index < 100_000; index++) {
      const variant = index % 1_000;
      const id = variant.toString(36).padStart(12, "0");
      const res = response();
      pressure.attachRequest(
        request(
          `/api/documents/${id}/private-${variant}-sensitive?token=credential-${variant}-sensitive`,
          index % 2 === 0 ? "GET" : "POST",
        ),
        res,
      );
      res.finish();
    }

    const lines = pressure.flush(true);
    const series = httpSeries(lines);
    expect(series.length).toBeLessThanOrEqual(MAX_HTTP_SERIES);
    expect(series.reduce((total, item) => total + Number(item.accepted), 0)).toBe(100_000);
    expect(series.reduce((total, item) => total + Number(item.completed), 0)).toBe(100_000);
    expect(gauges(lines).active_requests).toBe(0);
    const output = lines.join("\n");
    expect(output.match(/(?:private|credential|sensitive)-/g) ?? []).toHaveLength(0);
    expect(output).not.toContain("?token=");
  });
});

describe("pressure teardown ownership and failure containment", () => {
  it("leaves no owned callback or post-stop mutation across 512 lifecycle compositions", () => {
    let compositions = 0;
    for (let shape = 0; shape < 512; shape++) {
      let now = shape;
      let failCollector = (shape & 64) !== 0;
      let failSink = (shape & 128) !== 0;
      const emitted: string[] = [];
      const delay = new FakeDelay();
      const pressure = new PressureObservability({
        now: () => now,
        eventLoopDelay: delay,
        collectGauges: (reset) => {
          if (failCollector) {
            failCollector = false;
            throw new Error(`collector-sensitive-${shape}`);
          }
          return collectPressureGauges(reset);
        },
        write: (line) => {
          if (failSink) {
            failSink = false;
            throw new Error(`sink-sensitive-${shape}`);
          }
          emitted.push(line);
        },
      });
      const main = new EventEmitter();
      const standby = new EventEmitter();
      const mainSocket = new EventEmitter();
      const standbySocket = new EventEmitter();
      const upgradeSocket = new EventEmitter();
      const res = response();
      const unrelated = () => {};

      main.on("connection", unrelated);
      main.on("upgrade", unrelated);
      standby.on("connection", unrelated);
      mainSocket.on("close", unrelated);
      standbySocket.on("close", unrelated);
      upgradeSocket.on("close", unrelated);
      res.on("finish", unrelated);
      res.on("close", unrelated);

      pressure.attachServer(main as Server);
      pressure.attachServer(main as Server);
      pressure.attachServer(standby as Server, { trackUpgrades: false });
      pressure.attachServer(standby as Server, { trackUpgrades: false });
      const ownedServerCallbacks = [
        ...main.listeners("connection").filter((listener) => listener !== unrelated),
        ...main.listeners("upgrade").filter((listener) => listener !== unrelated),
        ...standby.listeners("connection").filter((listener) => listener !== unrelated),
      ];
      main.emit("connection", mainSocket);
      standby.emit("connection", standbySocket);
      main.emit("upgrade", request("/collab"), upgradeSocket, Buffer.alloc(0));
      pressure.attachRequest(request(`/api/documents/${shape.toString(36).padStart(12, "0")}?secret=value`), res);

      const ownedSocketCallbacks = [mainSocket, standbySocket, upgradeSocket].flatMap((socket) =>
        socket.listeners("close").filter((listener) => listener !== unrelated),
      );
      const ownedResponseCallbacks = [
        ...res.listeners("finish").filter((listener) => listener !== unrelated),
        ...res.listeners("close").filter((listener) => listener !== unrelated),
      ];

      const finishFirst = (shape & 1) === 0;
      const settleBeforeStop = (shape & 2) !== 0;
      if (settleBeforeStop) {
        if (finishFirst) {
          res.writableFinished = true;
          res.emit("finish");
          res.emit("close");
        } else {
          res.emit("close");
          res.writableFinished = true;
          res.emit("finish");
        }
      }
      if ((shape & 4) !== 0) {
        mainSocket.emit("close");
        standbySocket.emit("close");
        upgradeSocket.emit("close");
      }
      if ((shape & (64 | 128)) !== 0) pressure.flush(true);

      pressure.stop(false);
      expect(main.listeners("connection")).toEqual([unrelated]);
      expect(main.listeners("upgrade")).toEqual([unrelated]);
      expect(standby.listeners("connection")).toEqual([unrelated]);
      for (const socket of [mainSocket, standbySocket, upgradeSocket]) expect(socket.listeners("close")).toEqual([unrelated]);
      expect(res.listeners("finish")).toEqual([unrelated]);
      expect(res.listeners("close")).toEqual([unrelated]);

      for (const listener of finishFirst ? ownedResponseCallbacks : [...ownedResponseCallbacks].reverse()) listener();
      for (const listener of (shape & 8) === 0 ? ownedSocketCallbacks : [...ownedSocketCallbacks].reverse()) listener();
      for (const listener of (shape & 16) === 0 ? ownedServerCallbacks : [...ownedServerCallbacks].reverse()) {
        listener(new EventEmitter());
      }
      now += PRESSURE_BUCKET_MS;
      pressure.start();
      const after = pressure.flush(true);
      expect(httpSeries(after)).toEqual([]);
      expect(gauges(after)).toMatchObject({
        active_requests: 0,
        tcp_open: 0,
        tcp_accepted: 0,
        upgrades_open: 0,
        upgrades_accepted: 0,
      });
      pressure.stop(false);
      pressure.stop(false);
      expect(emitted.join("\n")).not.toContain(`sensitive-${shape}`);
      compositions++;
    }
    expect(compositions).toBe(512);
  });

  it("contains and reports all 341 injected collector and output failure shapes without recursion", () => {
    let failureShapes = 0;
    for (let shape = 0; shape < 341; shape++) {
      const failCollector = shape % 2 === 0;
      const failureCall = (shape % 5) + 1;
      const sensitive = `raw-sensitive-failure-${shape}`;
      let collectCalls = 0;
      let outputCalls = 0;
      const emitted: string[] = [];
      const pressure = new PressureObservability({
        eventLoopDelay: new FakeDelay(),
        collectGauges: (reset) => {
          collectCalls++;
          if (failCollector && collectCalls === failureCall) throw new Error(sensitive);
          return collectPressureGauges(reset);
        },
        write: (line) => {
          outputCalls++;
          if (!failCollector && outputCalls === failureCall) throw new Error(sensitive);
          emitted.push(line);
        },
      });

      for (let call = 0; call < 4; call++) pressure.flush(true);
      pressure.stop(true);
      pressure.start();
      pressure.flush(true);
      pressure.stop(false);

      expect(collectCalls).toBe(6);
      expect(outputCalls).toBe(6);
      const snapshots = emitted.map(payload).filter((item) => item.kind === "gauges");
      expect(snapshots.at(-1)).toMatchObject(
        failCollector ? { collector_failures: 1, output_failures: 0 } : { collector_failures: 0, output_failures: 1 },
      );
      expect(emitted.join("\n")).not.toContain(sensitive);
      failureShapes++;
    }
    expect(failureShapes).toBe(341);
  });

  it("contains timer and final-stop collector and sink failures", () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      let collectFailures = 2;
      let outputFailures = 2;
      const emitted: string[] = [];
      const pressure = new PressureObservability({
        now: () => now,
        eventLoopDelay: new FakeDelay(),
        collectGauges: (reset) => {
          if (collectFailures-- > 0) throw new Error("collector raw error");
          return collectPressureGauges(reset);
        },
        write: (line) => {
          if (outputFailures-- > 0) throw new Error("output raw error");
          emitted.push(line);
        },
      });
      pressure.start();
      now = PRESSURE_BUCKET_MS;
      expect(() => vi.advanceTimersByTime(PRESSURE_BUCKET_MS)).not.toThrow();
      expect(() => pressure.stop(true)).not.toThrow();
      pressure.start();
      now += PRESSURE_BUCKET_MS;
      pressure.flush(true);
      pressure.stop(false);

      expect(emitted.map(payload).find((item) => item.kind === "gauges")).toMatchObject({
        collector_failures: 2,
        output_failures: 2,
      });
      expect(emitted.join("\n")).not.toContain("raw error");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resume a rollover after its collector or sink synchronously stops it", () => {
    const collectorRef: { current?: PressureObservability } = {};
    let stopInCollector = true;
    const collectorWrites: string[] = [];
    const collectorResponse = response();
    const collectorPressure = new PressureObservability({
      eventLoopDelay: new FakeDelay(),
      collectGauges: (reset) => {
        if (stopInCollector) {
          stopInCollector = false;
          collectorRef.current!.stop(false);
          throw new Error("collector stopped");
        }
        return collectPressureGauges(reset);
      },
      write: (line) => collectorWrites.push(line),
    });
    collectorRef.current = collectorPressure;
    collectorPressure.attachRequest(request("/api/health"), collectorResponse);
    const collectorCallbacks = [
      ...collectorResponse.listeners("finish"),
      ...collectorResponse.listeners("close"),
    ];
    expect(collectorPressure.flush(true)).toEqual([]);
    expect(collectorWrites).toEqual([]);
    expect(collectorResponse.listenerCount("finish")).toBe(0);
    expect(collectorResponse.listenerCount("close")).toBe(0);
    for (const callback of collectorCallbacks) callback();
    collectorPressure.start();
    expect(gauges(collectorPressure.flush(true))).toMatchObject({
      active_requests: 0,
      collector_failures: 0,
      output_failures: 0,
    });
    collectorPressure.stop(false);

    const sinkRef: { current?: PressureObservability } = {};
    let stopInSink = true;
    let sinkCalls = 0;
    const sinkResponse = response();
    const sinkPressure = new PressureObservability({
      eventLoopDelay: new FakeDelay(),
      write: () => {
        sinkCalls++;
        if (stopInSink) {
          stopInSink = false;
          sinkRef.current!.stop(false);
          throw new Error("sink stopped");
        }
      },
    });
    sinkRef.current = sinkPressure;
    sinkPressure.attachRequest(request("/api/health"), sinkResponse);
    const sinkCallbacks = [...sinkResponse.listeners("finish"), ...sinkResponse.listeners("close")];
    expect(sinkPressure.flush(true)).toHaveLength(1);
    expect(sinkCalls).toBe(1);
    expect(sinkResponse.listenerCount("finish")).toBe(0);
    expect(sinkResponse.listenerCount("close")).toBe(0);
    for (const callback of sinkCallbacks.reverse()) callback();
    sinkPressure.start();
    expect(gauges(sinkPressure.flush(true))).toMatchObject({
      active_requests: 0,
      collector_failures: 0,
      output_failures: 0,
    });
    sinkPressure.stop(false);
  });
});
