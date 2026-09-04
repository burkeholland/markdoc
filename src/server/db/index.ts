import path from "node:path";
import fs from "node:fs";
import * as schema from "./schema";

type PgDb = import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema>;
type LiteDb = import("drizzle-orm/pglite").PgliteDatabase<typeof schema>;
export type Db = PgDb | LiteDb;

/**
 * A transaction on the shared connection (`db.transaction(async (tx) => …)`), PGlite or PostgreSQL alike.
 * The create paths take one so a document, its assets and its first version land together or not at all;
 * everything inside the callback must run on `tx` — a `getDb()` statement there would not see the
 * uncommitted rows on PostgreSQL and, on PGlite, would wait for the transaction's lock forever.
 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface DbGlobal {
  promise?: Promise<Db>;
  migrated?: Promise<void>;
  /** Whatever holds the connection, so closeDb() can release it: a pg Pool or a PGlite instance. */
  close?: () => Promise<void>;
}

// The Next.js server bundle and the custom collaboration server each load their own
// copy of this module in the same process. Share one connection through globalThis.
const g = globalThis as typeof globalThis & { __markdocDb?: DbGlobal };
const registry: DbGlobal = (g.__markdocDb ??= {});
const PRODUCTION_PGLITE_OPT_IN = "local-rehearsal-only";

/** SQL migrations live in ./drizzle next to package.json (copied into the container image). */
function migrationsFolder(): string {
  return process.env.DRIZZLE_MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");
}

async function create(): Promise<Db> {
  const url = process.env.DATABASE_URL?.trim();
  // Production PGlite is only for explicit local/image rehearsals; ambient container defaults must not enable it.
  const allowProductionPglite = process.env.MARKDOC_PRODUCTION_PGLITE === PRODUCTION_PGLITE_OPT_IN;
  if (!url && process.env.NODE_ENV === "production" && !allowProductionPglite) {
    throw new Error("DATABASE_URL is required in production");
  }
  if (url) {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      ssl: /sslmode=require/.test(url) || process.env.DATABASE_SSL === "1" ? { rejectUnauthorized: false } : undefined,
    });
    // node-postgres emits "error" on the pool when an *idle* client's connection dies (PostgreSQL restart,
    // pg_terminate_backend, VM patching, network blip). With no listener Node raises it as an uncaught
    // exception and server/index.ts exits the process (seen in production as "terminating connection due
    // to administrator command" → exit 1 → container restart). The pool has already dropped the dead
    // client; the next query opens a fresh one. Message only: never the error object or connection string.
    pool.on("error", (err) => console.warn("[db] idle client error:", err.message));
    const db = drizzle(pool, { schema });
    registry.close = () => pool.end();
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db, { migrationsFolder: migrationsFolder() });
    return db;
  }

  const { drizzle } = await import("drizzle-orm/pglite");
  const { PGlite } = await import("@electric-sql/pglite");
  const configured = process.env.PGLITE_DATA_DIR ?? ".data/pglite";
  const dataDir = configured === "memory://" ? configured : path.resolve(/* turbopackIgnore: true */ process.cwd(), configured);
  if (dataDir !== "memory://") fs.mkdirSync(dataDir, { recursive: true });
  const client = dataDir === "memory://" ? new PGlite() : new PGlite(dataDir);
  await client.waitReady;
  registry.close = () => client.close();
  const db = drizzle(client, { schema });
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  await migrate(db, { migrationsFolder: migrationsFolder() });
  return db;
}

/** Get the shared database connection (migrated and ready). */
export function getDb(): Promise<Db> {
  if (!registry.promise) {
    registry.promise = create().catch((err) => {
      registry.promise = undefined;
      registry.close = undefined;
      throw err;
    });
  }
  return registry.promise;
}

/**
 * Close the shared connection and forget it, so the next getDb() opens whatever PGLITE_DATA_DIR /
 * DATABASE_URL say at that moment. Used by the standby handover in server/index.ts: the server warms
 * up on a throwaway database, then releases it and opens the real one once the old process is gone
 * (PGlite is single-writer, so the two can never be open at once).
 */
export async function closeDb(): Promise<void> {
  const pending = registry.promise;
  const close = registry.close;
  registry.promise = undefined;
  registry.close = undefined;
  if (pending) await pending.catch(() => undefined);
  if (close) await close();
}

export { schema };
