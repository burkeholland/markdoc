import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Production once died with `uncaughtException: terminating connection due to administrator command`
 * (revision markdoc--0000011, 2026-08-28): node-postgres emits "error" on the *pool* when an idle
 * client's connection is cut, and a pool without a listener turns that into an uncaught exception,
 * which server/index.ts answers with exit 1. This stands in for pg.Pool with the same EventEmitter
 * surface and no sockets, and checks that the pool src/server/db opens survives that event.
 */
class FakePool extends EventEmitter {
  static instances: FakePool[] = [];
  readonly options: Record<string, unknown>;
  readonly end = vi.fn(async () => undefined);

  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    FakePool.instances.push(this);
  }
}

vi.mock("pg", () => ({
  Pool: FakePool,
  Client: class {
    constructor() { throw new Error("Pool-only tests must not open a publication session"); }
  },
}));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: (pool: unknown) => ({ $client: pool }) }));
vi.mock("drizzle-orm/node-postgres/migrator", () => ({ migrate: vi.fn(async () => undefined) }));

// No password in the fixture; the host name stands in for "anything from the connection string".
const FIXTURE_HOST = "db.invalid";
process.env.DATABASE_URL = `postgres://markdoc@${FIXTURE_HOST}:5432/markdoc`;
delete process.env.DATABASE_SSL;

const { closeDb, getDb } = await import("./index");

describe("PostgreSQL pool", () => {
  beforeEach(() => {
    FakePool.instances.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
});
