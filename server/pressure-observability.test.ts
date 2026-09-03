import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
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

  it("can count a TCP-only side listener without claiming its upgrade sockets", () => {
    const { pressure } = harness();
    const standby = new EventEmitter();
    pressure.attachServer(standby as Server, { trackUpgrades: false });
    expect(standby.listenerCount("connection")).toBe(1);
    expect(standby.listenerCount("upgrade")).toBe(0);
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
});
