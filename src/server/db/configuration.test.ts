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
  pgliteOrmImports: 0,
  pgliteClientImports: 0,
  pgliteMigratorImports: 0,
  pgDrizzle: vi.fn((client: unknown) => ({ driver: "postgres", client })),
  pgliteDrizzle: vi.fn((client: unknown) => ({ driver: "pglite", client })),
  pgMigrate: vi.fn(async () => undefined),
  pgliteMigrate: vi.fn(async () => undefined),
}));

vi.mock("pg", () => ({
  Client: class {},
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
vi.mock("@electric-sql/pglite", () => {
  doubles.pgliteClientImports += 1;
  return {
    PGlite: class {
      readonly waitReady = Promise.resolve();
      readonly close = vi.fn(async () => undefined);

      constructor(readonly dataDir?: string) {
        doubles.pglites.push(this);
      }
    },
  };
});
vi.mock("drizzle-orm/pglite", () => {
  doubles.pgliteOrmImports += 1;
  return { drizzle: doubles.pgliteDrizzle };
});
vi.mock("drizzle-orm/pglite/migrator", () => {
  doubles.pgliteMigratorImports += 1;
  return { migrate: doubles.pgliteMigrate };
});

type DbModule = typeof import("./index");
const PRODUCTION_DATABASE_ERROR = "DATABASE_URL is required in production";
const PRODUCTION_PGLITE_OPT_IN = "local-rehearsal-only";

const originalEnvironment = {
  databaseUrl: process.env.DATABASE_URL,
  productionPglite: process.env.MARKDOC_PRODUCTION_PGLITE,
  nodeEnv: process.env.NODE_ENV,
  pgliteDataDir: process.env.PGLITE_DATA_DIR,
};

let database: DbModule;
let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

function restoreEnvironment() {
  for (const [name, value] of [
    ["DATABASE_URL", originalEnvironment.databaseUrl],
    ["MARKDOC_PRODUCTION_PGLITE", originalEnvironment.productionPglite],
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
  doubles.pgliteOrmImports = 0;
  doubles.pgliteClientImports = 0;
  doubles.pgliteMigratorImports = 0;
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

async function expectProductionConfigurationFailure() {
  const error = await database.getDb().then(
    () => new Error("Expected database configuration to fail"),
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw error;
  expect(error.message).toBe(PRODUCTION_DATABASE_ERROR);
  expect(doubles.pools).toHaveLength(0);
  expect(doubles.pgliteOrmImports).toBe(0);
  expect(doubles.pgliteClientImports).toBe(0);
  expect(doubles.pglites).toHaveLength(0);
  expect(doubles.pgliteMigratorImports).toBe(0);
  expect(doubles.pgMigrate).not.toHaveBeenCalled();
  expect(doubles.pgliteMigrate).not.toHaveBeenCalled();
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
}

describe("database configuration", () => {
  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["whitespace-only", " \t\r\n "],
    ["malformed", "local-rehearsal"],
    ["case-varied", "LOCAL-REHEARSAL-ONLY"],
    ["generic truthy", "true"],
    ["numeric truthy", "1"],
  ])("fails closed when the production PGlite opt-in is %s", async (_label, optIn) => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = "/app/.data/pglite";
    if (optIn === undefined) delete process.env.MARKDOC_PRODUCTION_PGLITE;
    else process.env.MARKDOC_PRODUCTION_PGLITE = optIn;

    await expectProductionConfigurationFailure();
  });

  it("fails closed when production DATABASE_URL is blank despite the Docker PGlite default", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.DATABASE_URL = " \t\r\n ";
    process.env.PGLITE_DATA_DIR = "/app/.data/pglite";
    delete process.env.MARKDOC_PRODUCTION_PGLITE;

    await expectProductionConfigurationFailure();
  });

  it("uses one PostgreSQL pool when the URL and production PGlite opt-in are both set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.DATABASE_URL = " postgres://markdoc@db.invalid:5432/markdoc ";
    process.env.MARKDOC_PRODUCTION_PGLITE = PRODUCTION_PGLITE_OPT_IN;
    process.env.PGLITE_DATA_DIR = "/app/.data/pglite";

    const first = await database.getDb();

    expect(doubles.pools).toHaveLength(1);
    expect(doubles.pools[0].options).toMatchObject({
      connectionString: "postgres://markdoc@db.invalid:5432/markdoc",
    });
    expect(doubles.pgMigrate).toHaveBeenCalledTimes(1);
    expect(doubles.pgliteOrmImports).toBe(0);
    expect(doubles.pgliteClientImports).toBe(0);
    expect(doubles.pglites).toHaveLength(0);
    expect(doubles.pgliteMigratorImports).toBe(0);
    expect(doubles.pgliteMigrate).not.toHaveBeenCalled();
    expect(await database.getDb()).toBe(first);
    expect(doubles.pools).toHaveLength(1);

    await database.closeDb();
    expect(doubles.pools[0].end).toHaveBeenCalledTimes(1);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["blank", " \t\r\n "],
  ])("permits production-mode PGlite with the exact opt-in and a %s URL", async (_label, databaseUrl) => {
    vi.stubEnv("NODE_ENV", "production");
    if (databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = databaseUrl;
    process.env.MARKDOC_PRODUCTION_PGLITE = PRODUCTION_PGLITE_OPT_IN;
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

  it.each(["development", "test"])("retains in-memory PGlite in %s", async (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    delete process.env.DATABASE_URL;
    delete process.env.MARKDOC_PRODUCTION_PGLITE;
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
