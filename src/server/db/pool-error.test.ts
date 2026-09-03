import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectPressureGauges } from "@/server/pressure-gauges";

/**
 * Production once died with `uncaughtException: terminating connection due to administrator command`
 * (revision markdoc--0000011, 2026-08-28): node-postgres emits "error" on the *pool* when an idle
 * client's connection is cut, and a pool without a listener turns that into an uncaught exception,
 * which server/index.ts answers with exit 1. This stands in for pg.Pool with the same EventEmitter
 * surface and no sockets, and checks that the pool src/server/db opens survives that event.
 */
interface FakeClient {
  release: ReturnType<typeof vi.fn<() => void>>;
}

type FakeConnectCallback = (err: Error | undefined, client: FakeClient | undefined, done: () => void) => void;

interface PendingConnect {
  callback?: FakeConnectCallback;
  resolve?: (client: FakeClient) => void;
  reject?: (error: Error) => void;
}

class FakePool extends EventEmitter {
  static instances: FakePool[] = [];
  readonly options: Record<string, unknown>;
  readonly end = vi.fn(async () => undefined);
  readonly totalCount = 3;
  readonly idleCount = 2;
  waitingCount = 0;
  private readonly pending: PendingConnect[] = [];

  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    FakePool.instances.push(this);
  }

  connect(): Promise<FakeClient>;
  connect(callback: FakeConnectCallback): void;
  connect(callback?: FakeConnectCallback): Promise<FakeClient> | void {
    this.waitingCount++;
    if (callback) {
      this.pending.push({ callback });
      return;
    }
    return new Promise<FakeClient>((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  query(text: string): Promise<{ rows: Array<{ ok: boolean }> }> {
    void text;
    return new Promise((resolve, reject) => {
      this.connect((err, _client, done) => {
        if (err) {
          reject(err);
          return;
        }
        done();
        resolve({ rows: [{ ok: true }] });
      });
    });
  }

  settleNext(error?: Error): void {
    const pending = this.pending.shift();
    if (!pending) throw new Error("No pending checkout");
    this.waitingCount--;
    const client: FakeClient = { release: vi.fn() };
    const done = vi.fn();
    if (pending.callback) {
      pending.callback(error, error ? undefined : client, done);
    } else if (error) {
      pending.reject!(error);
    } else {
      pending.resolve!(client);
    }
  }
}

vi.mock("pg", () => ({ Pool: FakePool }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: (pool: unknown) => ({ $client: pool }) }));
vi.mock("drizzle-orm/node-postgres/migrator", () => ({ migrate: vi.fn(async () => undefined) }));

// No password in the fixture; the host name stands in for "anything from the connection string".
const FIXTURE_HOST = "db.invalid";
process.env.DATABASE_URL = `postgres://markdoc@${FIXTURE_HOST}:5432/markdoc`;
delete process.env.DATABASE_SSL;

const { closeDb, getDb } = await import("./index");
const toBigInt = Reflect.get(globalThis, "BigInt") as (value: number) => bigint;

async function currentPool(): Promise<FakePool> {
  const client = Reflect.get(await getDb(), "$client");
  if (!(client instanceof FakePool)) throw new Error("Expected the mocked PostgreSQL pool");
  return client;
}

describe("PostgreSQL pool", () => {
  let nowNs = toBigInt(0);

  beforeEach(() => {
    FakePool.instances.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => nowNs);
    nowNs = toBigInt(0);
  });

  afterEach(async () => {
    await closeDb();
    vi.restoreAllMocks();
  });

  it("survives an idle client error: one warn line, no throw, the shared connection stays", async () => {
    const db = await getDb();
    expect(FakePool.instances).toHaveLength(1);
    const pool = FakePool.instances[0];
    expect(pool.options).toMatchObject({ connectionString: process.env.DATABASE_URL });
    expect(pool.listenerCount("error")).toBe(1);

    // EventEmitter#emit("error") with no listener throws — that throw is the uncaught exception that
    // took the process down. pg emits (err, client); the client must not be logged either.
    const err = new Error("terminating connection due to administrator command");
    expect(() => pool.emit("error", err, { connectionParameters: { host: FIXTURE_HOST } })).not.toThrow();

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith("[db] idle client error:", err.message);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(FIXTURE_HOST);

    // The pool dropped the dead client itself; nothing is closed or recreated on our side.
    expect(pool.end).not.toHaveBeenCalled();
    expect(await getDb()).toBe(db);
    expect(FakePool.instances).toHaveLength(1);
  });

  it("logs every dropped idle client once, and only that", async () => {
    await getDb();
    const [pool] = FakePool.instances;
    pool.emit("error", new Error("Connection terminated unexpectedly"));
    pool.emit("error", new Error("read ECONNRESET"));
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ["[db] idle client error:", "Connection terminated unexpectedly"],
      ["[db] idle client error:", "read ECONNRESET"],
    ]);
  });

  it("preserves promise and callback checkout semantics while reporting pending and completed latency", async () => {
    const pool = await currentPool();
    expect(collectPressureGauges(false).gauges).toMatchObject({
      pg_total: 3,
      pg_idle: 2,
      pg_waiting: 0,
      pg_checkout_max_ms: 0,
    });

    const promised = pool.connect();
    nowNs = toBigInt(12_400_000);
    expect(collectPressureGauges(false).gauges).toMatchObject({
      pg_waiting: 1,
      pg_checkout_max_ms: 12,
    });
    pool.settleNext();
    await expect(promised).resolves.toMatchObject({ release: expect.any(Function) });
    expect(collectPressureGauges(true).gauges.pg_checkout_max_ms).toBe(12);
    expect(collectPressureGauges(false).gauges.pg_checkout_max_ms).toBe(0);

    const callback = vi.fn<FakeConnectCallback>();
    pool.connect(callback);
    nowNs = toBigInt(20_000_000);
    pool.settleNext();
    expect(callback).toHaveBeenCalledWith(undefined, expect.objectContaining({ release: expect.any(Function) }), expect.any(Function));
    expect(collectPressureGauges(true).gauges.pg_checkout_max_ms).toBe(8);
  });

  it("balances failed promise and callback checkouts and observes pool-internal query acquisition", async () => {
    const pool = await currentPool();

    const promiseError = new Error("promise checkout failed");
    const failedPromise = pool.connect();
    nowNs = toBigInt(5_000_000);
    pool.settleNext(promiseError);
    await expect(failedPromise).rejects.toBe(promiseError);
    expect(collectPressureGauges(true).gauges).toMatchObject({ pg_waiting: 0, pg_checkout_max_ms: 5 });

    const callback = vi.fn<FakeConnectCallback>();
    pool.connect(callback);
    nowNs = toBigInt(9_000_000);
    const callbackError = new Error("callback checkout failed");
    pool.settleNext(callbackError);
    expect(callback).toHaveBeenCalledWith(callbackError, undefined, expect.any(Function));
    expect(collectPressureGauges(true).gauges).toMatchObject({ pg_waiting: 0, pg_checkout_max_ms: 4 });

    const query = pool.query("SELECT 1");
    nowNs = toBigInt(16_000_000);
    expect(collectPressureGauges(false).gauges).toMatchObject({ pg_waiting: 1, pg_checkout_max_ms: 7 });
    pool.settleNext();
    await expect(query).resolves.toEqual({ rows: [{ ok: true }] });
    expect(collectPressureGauges(true).gauges).toMatchObject({ pg_waiting: 0, pg_checkout_max_ms: 7 });
  });
});
