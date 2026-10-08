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
  /** PGlite has one exclusive process; PostgreSQL needs a database-wide publication lock. */
  publishLock?: <T>(key: string, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => Promise<{ acquired: false } | { acquired: true; value: T }>;
}

// The Next.js server bundle and the custom collaboration server each load their own
// copy of this module in the same process. Share one connection through globalThis.
const g = globalThis as typeof globalThis & { __markdocDb?: DbGlobal };
const registry: DbGlobal = (g.__markdocDb ??= {});
const PRODUCTION_PGLITE_OPT_IN = "local-rehearsal-only";

export const GIST_LOCK_CONNECT_TIMEOUT_MS = 5_000;
export const GIST_LOCK_QUERY_TIMEOUT_MS = 5_000;
export const GIST_LOCK_CLOSE_TIMEOUT_MS = 1_000;

function gistCancellation(signal?: AbortSignal) {
  const controller = new AbortController();
  // Caller-supplied abort reasons can contain request/provider details.
  const cancel = () => {
    const error = new Error("Gist publication coordination was canceled");
    error.name = "AbortError";
    controller.abort(error);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  return { controller, dispose: () => signal?.removeEventListener("abort", cancel) };
}

/** Observe late settlement, but never resume a canceled step. The owner must close any resources. */
function waitForGistStep<T>(
  start: () => Promise<T>,
  signal?: AbortSignal,
  bound?: { ms: number; message: string },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => finish(() => reject(signal!.reason));
    const fail = (error: unknown) => finish(() => reject(bound ? new Error(bound.message) : error));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    if (bound) timer = setTimeout(() => fail(undefined), bound.ms);
    try {
      start().then(
        (value) => {
          if (signal?.aborted) abort();
          else finish(() => resolve(value));
        },
        fail,
      );
    } catch (error) {
      fail(error);
    }
  });
}

async function closeGistClient(client: import("pg").Client, signal: AbortSignal): Promise<void> {
  let destructionFailed = false;
  const destroy = () => {
    try {
      // pg 8's query_timeout does not cancel a non-pipelined query, and end() waits
      // for an end event. Its own connect timeout/end paths use this typed transport.
      // Read the current stream: pg replaces the initial socket when upgrading to TLS.
      client.connection.stream.destroy();
    } catch {
      destructionFailed = true;
    }
  };
  signal.addEventListener("abort", destroy, { once: true });
  try {
    await waitForGistStep(() => {
      const ending = client.end();
      if (signal.aborted) destroy();
      return ending;
    }, undefined, { ms: GIST_LOCK_CLOSE_TIMEOUT_MS, message: "Gist publication coordination cleanup failed" });
    if (destructionFailed) throw new Error("Gist publication coordination cleanup failed");
  } catch {
    destroy();
    throw new Error("Gist publication coordination cleanup failed");
  } finally {
    signal.removeEventListener("abort", destroy);
  }
}

/** SQL migrations live in ./drizzle next to package.json (copied into the container image). */
function migrationsFolder(): string {
  return process.env.DRIZZLE_MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");
}

/** The type id of `bytea` in PostgreSQL. */
const BYTEA_OID = 17;
/**
 * How the embedded database writes and reads `bytea` (a document's `ystate`, an image's bytes). Its own
 * code builds the hex text one byte at a time: 2.1 to 2.4 s to store 5.4 MB and 1.5 to 1.8 s to read them
 * back, in the thread that serves every request. `Buffer` does the same in 0.34 to 0.38 s and 0.07 s
 * (#2341). The text is the same (`\x` and two hex digits a byte), so the stored bytes are too. PostgreSQL
 * over a socket (production) does not come through here.
 */
export const PGLITE_BYTEA = {
  serializers: { [BYTEA_OID]: (value: Uint8Array | string) => (typeof value === "string" ? value : `\\x${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")}`) },
  parsers: { [BYTEA_OID]: (text: string) => new Uint8Array(Buffer.from(text.slice(2), "hex")) },
};

async function create(): Promise<Db> {
  const url = process.env.DATABASE_URL?.trim();
  // Production PGlite is only for explicit local/image rehearsals; ambient container defaults must not enable it.
  const allowProductionPglite = process.env.MARKDOC_PRODUCTION_PGLITE === PRODUCTION_PGLITE_OPT_IN;
  if (!url && process.env.NODE_ENV === "production" && !allowProductionPglite) {
    throw new Error("DATABASE_URL is required in production");
  }
  if (url) {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { Pool, Client } = await import("pg");
    const connection = {
      connectionString: url,
      ssl: /sslmode=require/.test(url) || process.env.DATABASE_SSL === "1" ? { rejectUnauthorized: false } : undefined,
    };
    const pool = new Pool({
      ...connection,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    });
    // node-postgres emits "error" on the pool when an *idle* client's connection dies (PostgreSQL restart,
    // pg_terminate_backend, VM patching, network blip). With no listener Node raises it as an uncaught
    // exception and server/index.ts exits the process (seen in production as "terminating connection due
    // to administrator command" → exit 1 → container restart). The pool has already dropped the dead
    // client; the next query opens a fresh one. Message only: never the error object or connection string.
    pool.on("error", (err) => console.warn("[db] idle client error:", err.message));
    const db = drizzle(pool, { schema });
    registry.publishLock = async (key, fn, signal) => {
      // Do not hold a pool connection or a data transaction during HTTP work: saves must be
      // able to commit even with a small pool. Closing this session releases its advisory lock.
      const { controller, dispose } = gistCancellation(signal);
      let client: import("pg").Client;
      let closing = false;
      try {
        controller.signal.throwIfAborted();
        try {
          client = new Client({
            ...connection,
            connectionTimeoutMillis: GIST_LOCK_CONNECT_TIMEOUT_MS,
            query_timeout: GIST_LOCK_QUERY_TIMEOUT_MS,
          });
        } catch {
          throw new Error("Gist publication coordination connection failed");
        }
        // Keep the error listener on this owned client to absorb late transport errors.
        const interrupt = () => controller.abort(new Error("Gist publication coordination was interrupted"));
        client.on("error", interrupt);
        client.on("end", () => { if (!closing) interrupt(); });
        let cleanup: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
        const close = () => {
          if (!cleanup) {
            closing = true;
            cleanup = closeGistClient(client, controller.signal).then(
              () => ({ ok: true as const }),
              (error: unknown) => ({ ok: false as const, error }),
            );
          }
          return cleanup;
        };
        // Close our transport promptly, but keep callbacks tracked through their own cleanup.
        const cancelSession = () => { void close(); };
        controller.signal.addEventListener("abort", cancelSession, { once: true });
        let completed = false;
        try {
          let locked: boolean;
          try {
            await waitForGistStep(() => client.connect(), controller.signal, {
              ms: GIST_LOCK_CONNECT_TIMEOUT_MS,
              message: "Gist publication coordination connection failed",
            });
            controller.signal.throwIfAborted();
            const result = await waitForGistStep(
              () => client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [key]),
              controller.signal,
              { ms: GIST_LOCK_QUERY_TIMEOUT_MS, message: "Gist publication coordination acquisition failed" },
            );
            controller.signal.throwIfAborted();
            locked = !!result.rows[0]?.locked;
          } catch (error) {
            controller.abort(error);
            throw error;
          }
          if (!locked) {
            completed = true;
            return { acquired: false };
          }
          controller.signal.throwIfAborted();
          const value = await fn(controller.signal);
          controller.signal.throwIfAborted();
          completed = true;
          return { acquired: true, value };
        } finally {
          const result = await close();
          controller.signal.removeEventListener("abort", cancelSession);
          if (!result.ok) {
            controller.abort(result.error);
            throw result.error;
          }
          // Do not replace a nested cleanup failure with an expected cancellation.
          if (completed) controller.signal.throwIfAborted();
        }
      } finally {
        dispose();
      }
    };
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
  const client = dataDir === "memory://" ? new PGlite({ ...PGLITE_BYTEA }) : new PGlite(dataDir, { ...PGLITE_BYTEA });
  await client.waitReady;
  registry.close = () => client.close();
  const db = drizzle(client, { schema });
  const publishing = new Set<string>();
  registry.publishLock = async (key, fn, signal) => {
    const { controller, dispose } = gistCancellation(signal);
    try {
      controller.signal.throwIfAborted();
      if (publishing.has(key)) return { acquired: false };
      publishing.add(key);
      try {
        controller.signal.throwIfAborted();
        // Unlike a PostgreSQL session, this process-local lock cannot be force-closed:
        // retain it until the callback settles, even if that callback ignores cancellation.
        const value = await fn(controller.signal);
        controller.signal.throwIfAborted();
        return { acquired: true, value };
      } finally {
        publishing.delete(key);
      }
    } finally {
      dispose();
    }
  };
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

async function withGistLock<T>(key: string, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
  const { controller, dispose } = gistCancellation(signal);
  try {
    await waitForGistStep(() => getDb().catch(() => {
      throw new Error("Gist publication coordination initialization failed");
    }), controller.signal);
    // Shared initialization is not ours to cancel; a late getDb must not open a lock session.
    controller.signal.throwIfAborted();
    const result = await registry.publishLock!(key, fn, controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    dispose();
  }
}

/**
 * Shared by both server graphs and, on PostgreSQL, separate servers. Callbacks must
 * await all protected work and honor their signal before side effects and after awaits.
 * PostgreSQL cancellation/loss closes our session promptly, independently of callback
 * settlement. Both backends keep the call pending until protected callbacks settle;
 * PGlite also retains its local lock. Worker shutdown bounds that final wait.
 * External cancellation is a sanitized AbortError; cleanup failure is always an Error.
 */
export async function withGistPublicationLock<T>(gistId: string, filename: string, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
  return withGistLock(JSON.stringify(["gist", gistId, filename]), fn, signal);
}

/** Same cancellation and callback-lifetime contract as withGistPublicationLock. */
export async function withGistSettingsLock<T>(docId: string, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
  return withGistLock(JSON.stringify(["gist-settings", docId]), fn, signal);
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
