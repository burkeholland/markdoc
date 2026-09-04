import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakePool {
  options: Record<string, unknown>;
  on: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

interface FakePglite {
  dataDir?: string;
  waitReady: Promise<void>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

const doubles = vi.hoisted(() => ({
  pools: [] as FakePool[],
  pglites: [] as FakePglite[],
  pgDrizzle: vi.fn((client: unknown) => ({ driver: "postgres", client })),
  pgliteDrizzle: vi.fn((client: unknown) => ({ driver: "pglite", client })),
  pgMigrate: vi.fn(async () => undefined),
  pgliteMigrate: vi.fn(async () => undefined),
}));

vi.mock("pg", () => ({
  Pool: class {
    readonly options: Record<string, unknown>;
    readonly on = vi.fn(() => this);
    readonly end = vi.fn(async () => undefined);

    constructor(options: Record<string, unknown>) {
      this.options = options;
      doubles.pools.push(this);
    }
  },
}));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: doubles.pgDrizzle }));
vi.mock("drizzle-orm/node-postgres/migrator", () => ({ migrate: doubles.pgMigrate }));
vi.mock("@electric-sql/pglite", () => ({
  PGlite: class {
    readonly waitReady = Promise.resolve();
    readonly close = vi.fn(async () => undefined);

    constructor(readonly dataDir?: string) {
      doubles.pglites.push(this);
    }
  },
}));
vi.mock("drizzle-orm/pglite", () => ({ drizzle: doubles.pgliteDrizzle }));
vi.mock("drizzle-orm/pglite/migrator", () => ({ migrate: doubles.pgliteMigrate }));

type DbModule = typeof import("./index");

const originalEnvironment = {
  databaseUrl: process.env.DATABASE_URL,
  nodeEnv: process.env.NODE_ENV,
  pgliteDataDir: process.env.PGLITE_DATA_DIR,
};

let database: DbModule;
let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

function restoreEnvironment() {
  for (const [name, value] of [
    ["DATABASE_URL", originalEnvironment.databaseUrl],
    ["NODE_ENV", originalEnvironment.nodeEnv],
    ["PGLITE_DATA_DIR", originalEnvironment.pgliteDataDir],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else Reflect.set(process.env, name, value);
  }
}

beforeEach(async () => {
  vi.resetModules();
  delete (globalThis as typeof globalThis & { __markdocDb?: unknown }).__markdocDb;
  doubles.pools.length = 0;
  doubles.pglites.length = 0;
  doubles.pgDrizzle.mockClear();
  doubles.pgliteDrizzle.mockClear();
  doubles.pgMigrate.mockClear();
  doubles.pgliteMigrate.mockClear();
  consoleSpies = [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
  ];
  database = await import("./index");
});

afterEach(async () => {
  await database.closeDb();
  for (const spy of consoleSpies) spy.mockRestore();
  vi.unstubAllEnvs();
  restoreEnvironment();
  delete (globalThis as typeof globalThis & { __markdocDb?: unknown }).__markdocDb;
});

describe("database configuration", () => {
  it.each([
    ["missing", undefined],
    ["blank", " \t\r\n "],
  ])("fails closed when production DATABASE_URL is %s", async (_label, databaseUrl) => {
    vi.stubEnv("NODE_ENV", "production");
    if (databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = databaseUrl;

    await expect(database.getDb()).rejects.toThrow("DATABASE_URL is required in production");

    expect(doubles.pools).toHaveLength(0);
    expect(doubles.pglites).toHaveLength(0);
    expect(doubles.pgMigrate).not.toHaveBeenCalled();
    expect(doubles.pgliteMigrate).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("uses one PostgreSQL pool in production and closes it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.DATABASE_URL = " postgres://markdoc@db.invalid:5432/markdoc ";

    const first = await database.getDb();

    expect(doubles.pools).toHaveLength(1);
    expect(doubles.pools[0].options).toMatchObject({
      connectionString: "postgres://markdoc@db.invalid:5432/markdoc",
    });
    expect(doubles.pgMigrate).toHaveBeenCalledTimes(1);
    expect(doubles.pglites).toHaveLength(0);
    expect(doubles.pgliteMigrate).not.toHaveBeenCalled();
    expect(await database.getDb()).toBe(first);
    expect(doubles.pools).toHaveLength(1);

    await database.closeDb();
    expect(doubles.pools[0].end).toHaveBeenCalledTimes(1);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it.each(["development", "test"])("retains in-memory PGlite in %s", async (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = "memory://";

    const first = await database.getDb();

    expect(doubles.pglites).toHaveLength(1);
    expect(doubles.pglites[0].dataDir).toBeUndefined();
    expect(doubles.pgliteMigrate).toHaveBeenCalledTimes(1);
    expect(doubles.pools).toHaveLength(0);
    expect(doubles.pgMigrate).not.toHaveBeenCalled();
    expect(await database.getDb()).toBe(first);
    expect(doubles.pglites).toHaveLength(1);

    await database.closeDb();
    expect(doubles.pglites[0].close).toHaveBeenCalledTimes(1);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
