import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

type PgDb = import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema>;
type LiteDb = import("drizzle-orm/pglite").PgliteDatabase<typeof schema>;
export type Db = PgDb | LiteDb;

interface DbGlobal {
  promise?: Promise<Db>;
  migrated?: Promise<void>;
}

// The Next.js server bundle and the custom collaboration server each load their own
// copy of this module in the same process. Share one connection through globalThis.
const g = globalThis as typeof globalThis & { __markdocDb?: DbGlobal };
const registry: DbGlobal = (g.__markdocDb ??= {});

function migrationsFolder(): string {
  const candidates = [
    path.resolve(process.cwd(), "drizzle"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../drizzle"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

async function create(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      ssl: /sslmode=require/.test(url) || process.env.DATABASE_SSL === "1" ? { rejectUnauthorized: false } : undefined,
    });
    const db = drizzle(pool, { schema });
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db, { migrationsFolder: migrationsFolder() });
    return db;
  }

  const { drizzle } = await import("drizzle-orm/pglite");
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = process.env.PGLITE_DATA_DIR ?? path.resolve(process.cwd(), ".data/pglite");
  const client = dataDir === "memory://" ? new PGlite() : new PGlite(dataDir);
  await client.waitReady;
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
      throw err;
    });
  }
  return registry.promise;
}

export { schema };
