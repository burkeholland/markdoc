import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PGlite, type PGliteInterface } from "@electric-sql/pglite";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Client, type ClientConfig } from "pg";
import * as appSchema from "../../src/server/db/schema";

type SqlRow = Record<string, unknown>;

interface SqlResult<T extends SqlRow> {
  rows: T[];
}

export interface SqlConnection {
  query<T extends SqlRow = SqlRow>(text: string, values?: unknown[]): Promise<SqlResult<T>>;
}

interface TransactionOptions {
  readOnly?: boolean;
}

export interface TransactionalConnection extends SqlConnection {
  transaction<T>(callback: (connection: SqlConnection) => Promise<T>, options?: TransactionOptions): Promise<T>;
  close(): Promise<void>;
}

export interface PostgresClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: SqlRow[] }>;
  end(): Promise<void>;
}

export type PostgresClientFactory = (config: ClientConfig) => PostgresClient;

export const POSTGRES_TLS_VERIFICATION_QUERY =
  "SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid = pg_backend_pid()";

export const APPLICATION_TABLES = [
  "account",
  "activity",
  "agent_request",
  "api_token",
  "asset",
  "collaborator",
  "document",
  "folder",
  "folder_collaborator",
  "gist_auto_update",
  "notification",
  "ownership_transfer",
  "recent",
  "required_version_intent",
  "review",
  "session",
  "star",
  "user",
  "verificationToken",
  "version",
  "video_storage_cleanup",
  "video_stream_slot",
  "video_upload",
  "video_upload_part",
  "webhook",
  "webhook_delivery",
] as const;

interface ColumnInfo {
  name: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  identity: string | null;
  generated: string;
}

interface DatabaseShape {
  columns: Map<string, ColumnInfo[]>;
  order: string[];
  dependencies: string[];
  migration: SchemaVersion;
}

export interface SchemaVersion {
  count: number;
  latestCreatedAt: string | null;
  latestHash: string | null;
}

interface SequenceDefinition {
  table: string;
  column: string;
  schema: string;
  name: string;
  increment: bigint;
}

export interface SequenceManifest {
  sequence: string;
  nextValue: string;
}

export interface TableManifest {
  rows: number;
  sha256: string;
}

interface RecordSetManifest {
  count: number;
  sha256: string;
}

interface DataManifest {
  tables: Record<string, TableManifest>;
  records: {
    documents: RecordSetManifest;
    assets: RecordSetManifest & { bytes: number };
  };
  totals: {
    tables: number;
    rows: number;
  };
  sequences: Record<string, SequenceManifest>;
}

interface LoadedDatabaseData {
  manifest: DataManifest;
  rows: Map<string, SqlRow[]>;
}

export interface MigrationManifest extends DataManifest {
  formatVersion: 1;
  sourceSnapshot: {
    bytes: number;
    sha256: string;
  };
  schema: {
    source: SchemaVersion;
    target: SchemaVersion;
  };
}

export class MigrationCommittedManifestError extends Error {
  readonly committed = true;
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Destination migration committed and verified, but manifest publication failed");
    this.name = "MigrationCommittedManifestError";
    this.cause = cause;
  }
}

export class CommitOutcomeUnknownError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("PostgreSQL did not confirm whether COMMIT completed");
    this.name = "CommitOutcomeUnknownError";
    this.cause = cause;
  }
}

export class DestinationTlsVerificationError extends Error {
  readonly cause: unknown;

  constructor(reason: string, cause?: unknown) {
    super(`Destination PostgreSQL TLS ${reason}; migration was not started`);
    this.name = "DestinationTlsVerificationError";
    this.cause = cause;
  }
}

export interface MigrationHooks {
  afterTable?: (table: string) => Promise<void> | void;
}

export interface MigrateSnapshotOptions {
  sourceSnapshot: string;
  sourceDataDir: string;
  destination: TransactionalConnection;
  manifestPath?: string;
  replace?: boolean;
  verifyOnly?: boolean;
  hooks?: MigrationHooks;
}

export function discoverDrizzleTableNames(): string[] {
  const discovered: string[] = [];
  for (const value of Object.values(appSchema) as unknown[]) {
    if (is(value, PgTable)) discovered.push(getTableName(value));
  }
  discovered.sort();
  assertStringListsEqual(discovered, [...APPLICATION_TABLES], "Drizzle schema table coverage");
  return discovered;
}

export function createPgliteDestination(client: PGliteInterface): TransactionalConnection {
  return {
    query: createPgliteQuery(client),
    transaction: (callback) => client.transaction((tx) => callback({ query: createPgliteQuery(tx) })),
    close: () => client.close(),
  };
}

export async function createPostgresDestination(
  connectionString: string,
  createClient: PostgresClientFactory = createNodePostgresClient,
): Promise<TransactionalConnection> {
  const client = createClient(createPostgresClientConfig(connectionString));
  await client.connect();
  let tlsRows: SqlRow[] | undefined;
  try {
    ({ rows: tlsRows } = await client.query(POSTGRES_TLS_VERIFICATION_QUERY));
  } catch (error) {
    await closeUnverifiedPostgresClient(client, "could not be verified after connect", error);
  }
  if (tlsRows?.length !== 1 || tlsRows[0]?.ssl !== true) {
    await closeUnverifiedPostgresClient(client, "was not reported as encrypted after connect");
  }
  const connection = createPgQuery(client);

  return {
    ...connection,
    transaction: async <T>(
      callback: (transaction: SqlConnection) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> => {
      await client.query("BEGIN");
      let result: T;
      try {
        result = await callback(connection);
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Migration failed and destination rollback also failed");
        }
        throw error;
      }
      try {
        await client.query("COMMIT");
        return result;
      } catch (error) {
        if (options?.readOnly) {
          throw new Error("Read-only destination transaction did not close cleanly", { cause: error });
        }
        throw new CommitOutcomeUnknownError(error);
      }
    },
    close: () => client.end(),
  };
}

export async function migratePgliteSnapshot(options: MigrateSnapshotOptions): Promise<MigrationManifest> {
  if (!options.sourceSnapshot) throw new Error("An explicit source snapshot is required");
  if (!options.sourceDataDir) throw new Error("An explicit temporary source data directory is required");
  if (options.verifyOnly && options.replace) throw new Error("--verify-only and --replace cannot be combined");

  const snapshotPath = path.resolve(options.sourceSnapshot);
  const sourceDataDir = path.resolve(options.sourceDataDir);
  const snapshotBytes = await fs.readFile(snapshotPath);
  if (snapshotBytes.byteLength < 2 || snapshotBytes[0] !== 0x1f || snapshotBytes[1] !== 0x8b) {
    throw new Error("Source snapshot is not a gzip-compressed PGlite data-dir archive");
  }
  const snapshotSha256 = sha256(snapshotBytes);
  await prepareTemporaryDirectory(sourceDataDir);

  let source: PGlite | undefined;
  let removeSourceDataDir = true;
  try {
    source = new PGlite(sourceDataDir, { loadDataDir: new Blob([new Uint8Array(snapshotBytes)]) });
    await source.waitReady;
    const sourceConnection: SqlConnection = { query: createPgliteQuery(source) };
    const sourceSnapshotSchema = await readSchemaVersion(sourceConnection);
    await migrate(drizzle(source), { migrationsFolder: path.resolve("drizzle") });
    const sourceShape = await inspectDatabase(sourceConnection);
    const sourceData = await loadDatabaseData(sourceConnection, sourceShape);

    await source.close();
    source = undefined;
    const afterBytes = await fs.readFile(snapshotPath);
    if (afterBytes.byteLength !== snapshotBytes.byteLength || sha256(afterBytes) !== snapshotSha256) {
      throw new Error("Source snapshot changed while migration was reading it");
    }
    await fs.rm(sourceDataDir, { recursive: true, force: true });
    removeSourceDataDir = false;

    const targetShape = await options.destination.transaction(
      async (destination) => {
        await destination.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const targetShape = await inspectDatabase(destination);
        assertCompatibleShapes(sourceShape, targetShape);
        if (options.verifyOnly) {
          const targetData = await loadDatabaseData(destination, targetShape);
          assertDataMatches(sourceData.manifest, targetData.manifest);
        }
        return targetShape;
      },
      { readOnly: true },
    );

    const manifest = combineManifest(
      snapshotBytes.byteLength,
      snapshotSha256,
      sourceSnapshotSchema,
      targetShape,
      sourceData.manifest,
    );
    const preparedManifest = options.manifestPath ? await prepareManifest(options.manifestPath, manifest) : undefined;
    if (options.verifyOnly) {
      await preparedManifest?.publish();
      return manifest;
    }

    try {
      await options.destination.transaction(async (destination) => {
        await destination.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        await lockApplicationTables(destination);
        const lockedTargetShape = await inspectDatabase(destination);
        assertCompatibleShapes(sourceShape, lockedTargetShape);

        const targetBefore = await loadDatabaseData(destination, lockedTargetShape);
        const targetRows = targetBefore.manifest.totals.rows;
        if (targetRows > 0 && !options.replace) {
          throw new Error(`Destination is not empty (${targetRows} application rows); rerun with --replace to replace it transactionally`);
        }

        if (targetRows > 0) {
          for (const table of [...lockedTargetShape.order].reverse()) {
            await destination.query(`DELETE FROM ${qualifiedTable(table)}`);
          }
        }

        for (const table of sourceShape.order) {
          const columns = sourceShape.columns.get(table);
          if (!columns) throw new Error(`Missing source columns for ${table}`);
          const rows = sourceData.rows.get(table);
          if (!rows) throw new Error(`Missing loaded source rows for ${table}`);
          await insertRows(destination, table, columns, rows);
          await options.hooks?.afterTable?.(table);
        }

        await restartSequences(destination, lockedTargetShape, sourceData.manifest.sequences);

        const targetAfter = await loadDatabaseData(destination, lockedTargetShape);
        assertDataMatches(sourceData.manifest, targetAfter.manifest);
      });
    } catch (error) {
      try {
        await preparedManifest?.discard();
      } catch (manifestCleanupError) {
        if (error instanceof CommitOutcomeUnknownError) {
          throw new CommitOutcomeUnknownError(
            new AggregateError([error.cause, manifestCleanupError], "COMMIT outcome is unknown and staged manifest cleanup also failed"),
          );
        }
        throw new AggregateError([error, manifestCleanupError], "Migration rolled back, but the staged manifest could not be removed");
      }
      throw error;
    }

    try {
      await preparedManifest?.publish();
    } catch (error) {
      throw new MigrationCommittedManifestError(error);
    }
    return manifest;
  } finally {
    try {
      if (source) await source.close();
    } finally {
      if (removeSourceDataDir) await fs.rm(sourceDataDir, { recursive: true, force: true });
    }
  }
}

export async function writeManifest(file: string, manifest: MigrationManifest): Promise<void> {
  const prepared = await prepareManifest(file, manifest);
  await prepared.publish();
}

interface PreparedManifest {
  publish(): Promise<void>;
  discard(): Promise<void>;
}

async function prepareManifest(file: string, manifest: MigrationManifest): Promise<PreparedManifest> {
  const destination = path.resolve(file);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.lstat(destination);
    throw Object.assign(new Error(`Manifest already exists: ${destination}`), { code: "EEXIST" });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  const temporary = `${destination}.pending-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  let pending = true;
  return {
    async publish() {
      if (!pending) throw new Error("Manifest has already been published or discarded");
      try {
        await fs.link(temporary, destination);
      } finally {
        await fs.rm(temporary, { force: true });
        pending = false;
      }
    },
    async discard() {
      if (!pending) return;
      await fs.rm(temporary, { force: true });
      pending = false;
    },
  };
}

async function inspectDatabase(connection: SqlConnection): Promise<DatabaseShape> {
  const expectedTables = discoverDrizzleTableNames();
  const expectedColumns = discoverDrizzleColumns();
  const tableRows = await connection.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const actualTables = tableRows.rows.map((row) => row.table_name);
  assertStringListsEqual(actualTables, expectedTables, "public database table coverage");

  const columnRows = await connection.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    is_identity: string;
    identity_generation: string | null;
    is_generated: string;
  }>(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable,
            is_identity, identity_generation, is_generated
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
  );

  const columns = new Map<string, ColumnInfo[]>();
  for (const table of actualTables) columns.set(table, []);
  for (const row of columnRows.rows) {
    const tableColumns = columns.get(row.table_name);
    if (!tableColumns) throw new Error(`Database reported a column for unlisted table ${row.table_name}`);
    tableColumns.push({
      name: row.column_name,
      dataType: row.data_type,
      udtName: row.udt_name,
      nullable: row.is_nullable === "YES",
      identity: row.is_identity === "YES" ? row.identity_generation : null,
      generated: row.is_generated,
    });
  }

  for (const [table, tableColumns] of columns) {
    assertStringListsEqual(
      tableColumns.map((column) => column.name).sort(),
      [...(expectedColumns.get(table) ?? [])].sort(),
      `column coverage for ${table}`,
    );
  }

  const dependencyRows = await connection.query<{ table_name: string; referenced_table: string }>(
    `SELECT DISTINCT child.relname AS table_name, parent.relname AS referenced_table
       FROM pg_constraint constraint_row
       JOIN pg_class child ON child.oid = constraint_row.conrelid
       JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
       JOIN pg_class parent ON parent.oid = constraint_row.confrelid
       JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
      WHERE constraint_row.contype = 'f'
        AND child_namespace.nspname = 'public'
        AND parent_namespace.nspname = 'public'
      ORDER BY table_name, referenced_table`,
  );
  const dependencies = dependencyRows.rows.map((row) => `${row.table_name}\0${row.referenced_table}`);

  return {
    columns,
    dependencies,
    order: topologicalOrder(actualTables, dependencyRows.rows),
    migration: await readSchemaVersion(connection),
  };
}

function discoverDrizzleColumns(): Map<string, string[]> {
  const columns = new Map<string, string[]>();
  for (const value of Object.values(appSchema)) {
    if (!is(value, PgTable)) continue;
    columns.set(
      getTableName(value),
      Object.values(getTableColumns(value)).map((column) => column.name),
    );
  }
  return columns;
}

function topologicalOrder(tables: string[], dependencies: Array<{ table_name: string; referenced_table: string }>): string[] {
  const pending = new Set(tables);
  const emitted = new Set<string>();
  const result: string[] = [];
  const byTable = new Map<string, Set<string>>();
  for (const table of tables) byTable.set(table, new Set());
  for (const dependency of dependencies) {
    if (dependency.table_name !== dependency.referenced_table) {
      byTable.get(dependency.table_name)?.add(dependency.referenced_table);
    }
  }

  while (pending.size > 0) {
    const ready = [...pending]
      .filter((table) => [...(byTable.get(table) ?? [])].every((dependency) => emitted.has(dependency)))
      .sort();
    if (ready.length === 0) throw new Error(`Application tables contain a foreign-key cycle: ${[...pending].sort().join(", ")}`);
    for (const table of ready) {
      pending.delete(table);
      emitted.add(table);
      result.push(table);
    }
  }
  return result;
}

async function readSchemaVersion(connection: SqlConnection): Promise<SchemaVersion> {
  const countResult = await connection.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "drizzle"."__drizzle_migrations"`,
  );
  const latestResult = await connection.query<{ hash: string; created_at: string }>(
    `SELECT hash, created_at::text AS created_at
       FROM "drizzle"."__drizzle_migrations"
      ORDER BY created_at DESC
      LIMIT 1`,
  );
  const latest = latestResult.rows[0];
  return {
    count: Number(countResult.rows[0]?.count ?? "0"),
    latestCreatedAt: latest?.created_at ?? null,
    latestHash: latest?.hash ?? null,
  };
}

function assertCompatibleShapes(source: DatabaseShape, target: DatabaseShape): void {
  if (JSON.stringify(source.migration) !== JSON.stringify(target.migration)) {
    throw new Error("Source and destination schema migration versions do not match");
  }
  assertStringListsEqual(target.order.slice().sort(), source.order.slice().sort(), "source/target table coverage");
  assertStringListsEqual(target.dependencies, source.dependencies, "source/target foreign keys");

  for (const table of source.order) {
    const sourceColumns = source.columns.get(table) ?? [];
    const targetColumns = target.columns.get(table) ?? [];
    if (JSON.stringify(sourceColumns) !== JSON.stringify(targetColumns)) {
      throw new Error(`Source and destination column definitions differ for ${table}`);
    }
  }
}

async function loadDatabaseData(connection: SqlConnection, shape: DatabaseShape): Promise<LoadedDatabaseData> {
  const tables: Record<string, TableManifest> = {};
  const rowsByTable = new Map<string, SqlRow[]>();
  const documentDigests: string[] = [];
  const assetDigests: string[] = [];
  let assetBytes = 0;
  let totalRows = 0;

  for (const table of [...shape.order].sort()) {
    const columns = shape.columns.get(table);
    if (!columns) throw new Error(`Missing columns for ${table}`);
    const rows = await readTableRows(connection, table, columns);
    rowsByTable.set(table, rows);
    const rowDigests = rows.map((row) => hashCanonical(columns.map((column) => [column.name, row[column.name]]))).sort();
    tables[table] = { rows: rows.length, sha256: hashDigestList(rowDigests) };
    totalRows += rows.length;

    if (table === "document") {
      for (const row of rows) {
        documentDigests.push(hashCanonical(["document", row.id, row.content, row.ystate]));
      }
    } else if (table === "asset") {
      for (const row of rows) {
        if (row.data === null && typeof row.storage_key === "string") {
          if (typeof row.size !== "number" || !Number.isSafeInteger(row.size) || row.size < 0) {
            throw new Error("External asset size was not returned as a non-negative integer");
          }
          assetBytes += row.size;
          assetDigests.push(hashCanonical(["external-asset", row.id, row.storage_key, row.size]));
        } else {
          const bytes = asBytes(row.data, "asset.data");
          assetBytes += bytes.byteLength;
          assetDigests.push(hashCanonical(["asset", row.id, bytes]));
        }
      }
    }
  }

  const sequences = await readSequenceStates(connection, shape);
  return {
    rows: rowsByTable,
    manifest: {
      tables,
      records: {
        documents: { count: documentDigests.length, sha256: hashDigestList(documentDigests.sort()) },
        assets: { count: assetDigests.length, bytes: assetBytes, sha256: hashDigestList(assetDigests.sort()) },
      },
      totals: { tables: shape.order.length, rows: totalRows },
      sequences,
    },
  };
}

async function readTableRows(connection: SqlConnection, table: string, columns: ColumnInfo[]): Promise<SqlRow[]> {
  const expressions = columns.map((column) => selectExpression(column)).join(", ");
  const result = await connection.query(`SELECT ${expressions} FROM ${qualifiedTable(table)}`);
  return result.rows.map((row) => {
    const normalized: SqlRow = {};
    for (const column of columns) {
      const value = row[column.name];
      normalized[column.name] = column.udtName === "bytea" && value !== null ? Buffer.from(String(value), "base64") : value;
    }
    return normalized;
  });
}

function selectExpression(column: ColumnInfo): string {
  const identifier = quoteIdentifier(column.name);
  const alias = ` AS ${identifier}`;
  if (column.udtName === "bytea") return `encode(${identifier}, 'base64')${alias}`;
  if (column.udtName === "timestamptz") {
    return `(CASE
      WHEN ${identifier} = 'infinity'::timestamptz THEN 'infinity'
      WHEN ${identifier} = '-infinity'::timestamptz THEN '-infinity'
      ELSE to_char(${identifier} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')
        || '+00 ' || to_char(${identifier} AT TIME ZONE 'UTC', 'BC')
    END)${alias}`;
  }
  if (column.udtName === "timestamp") {
    return `(CASE
      WHEN ${identifier} = 'infinity'::timestamp THEN 'infinity'
      WHEN ${identifier} = '-infinity'::timestamp THEN '-infinity'
      ELSE to_char(${identifier}, 'YYYY-MM-DD HH24:MI:SS.US BC')
    END)${alias}`;
  }
  if (column.udtName === "date") {
    return `(CASE
      WHEN ${identifier} = 'infinity'::date THEN 'infinity'
      WHEN ${identifier} = '-infinity'::date THEN '-infinity'
      ELSE to_char(${identifier}, 'YYYY-MM-DD BC')
    END)${alias}`;
  }
  if (column.udtName === "json" || column.udtName === "jsonb" || column.udtName === "int8" || column.udtName === "numeric") {
    return `${identifier}::text${alias}`;
  }
  return identifier;
}

async function insertRows(connection: SqlConnection, table: string, columns: ColumnInfo[], rows: SqlRow[]): Promise<void> {
  const insertable = columns.filter((column) => column.generated === "NEVER");
  if (rows.length === 0) return;
  if (insertable.length === 0) throw new Error(`Table ${table} has rows but no insertable columns`);
  const batchSize = Math.max(1, Math.min(100, Math.floor(60_000 / insertable.length)));
  const columnSql = insertable.map((column) => quoteIdentifier(column.name)).join(", ");
  const identityOverride = insertable.some((column) => column.identity !== null) ? " OVERRIDING SYSTEM VALUE" : "";

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const tuples = batch.map((row) => {
      const placeholders = insertable.map((column) => {
        values.push(row[column.name]);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await connection.query(
      `INSERT INTO ${qualifiedTable(table)} (${columnSql})${identityOverride} VALUES ${tuples.join(", ")}`,
      values,
    );
  }
}

async function readSequenceStates(connection: SqlConnection, shape: DatabaseShape): Promise<Record<string, SequenceManifest>> {
  const definitions = await discoverSequences(connection);
  const result: Record<string, SequenceManifest> = {};

  for (const definition of definitions) {
    if (!shape.columns.has(definition.table)) continue;
    if (definition.increment <= BigInt(0)) {
      throw new Error(`Descending sequence ${definition.schema}.${definition.name} is not supported`);
    }
    const sequenceState = await connection.query<{ last_value: string; is_called: boolean }>(
      `SELECT last_value::text AS last_value, is_called FROM ${quoteIdentifier(definition.schema)}.${quoteIdentifier(definition.name)}`,
    );
    const state = sequenceState.rows[0];
    if (!state) throw new Error(`Could not read sequence ${definition.schema}.${definition.name}`);
    const maximum = await connection.query<{ maximum: string | null }>(
      `SELECT MAX(${quoteIdentifier(definition.column)})::text AS maximum FROM ${qualifiedTable(definition.table)}`,
    );
    const lastValue = BigInt(state.last_value);
    const currentNext = state.is_called ? lastValue + definition.increment : lastValue;
    const maximumValue = maximum.rows[0]?.maximum;
    const minimumNext = maximumValue === null || maximumValue === undefined ? currentNext : BigInt(maximumValue) + definition.increment;
    const nextValue = currentNext > minimumNext ? currentNext : minimumNext;
    const key = `${definition.table}.${definition.column}`;
    result[key] = {
      sequence: `${definition.schema}.${definition.name}`,
      nextValue: nextValue.toString(),
    };
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

async function discoverSequences(connection: SqlConnection): Promise<SequenceDefinition[]> {
  const result = await connection.query<{
    table_name: string;
    column_name: string;
    sequence_schema: string;
    sequence_name: string;
    increment_by: string;
  }>(
    `SELECT table_row.relname AS table_name,
            attribute_row.attname AS column_name,
            sequence_namespace.nspname AS sequence_schema,
            sequence_row.relname AS sequence_name,
            sequence_details.seqincrement::text AS increment_by
       FROM pg_class sequence_row
       JOIN pg_namespace sequence_namespace ON sequence_namespace.oid = sequence_row.relnamespace
       JOIN pg_sequence sequence_details ON sequence_details.seqrelid = sequence_row.oid
       JOIN pg_depend dependency
         ON dependency.objid = sequence_row.oid
        AND dependency.classid = 'pg_class'::regclass
        AND dependency.refclassid = 'pg_class'::regclass
        AND dependency.deptype IN ('a', 'i')
       JOIN pg_class table_row ON table_row.oid = dependency.refobjid
       JOIN pg_namespace table_namespace ON table_namespace.oid = table_row.relnamespace
       JOIN pg_attribute attribute_row
         ON attribute_row.attrelid = table_row.oid
        AND attribute_row.attnum = dependency.refobjsubid
      WHERE sequence_row.relkind = 'S' AND table_namespace.nspname = 'public'
      ORDER BY table_name, column_name`,
  );
  return result.rows.map((row) => ({
    table: row.table_name,
    column: row.column_name,
    schema: row.sequence_schema,
    name: row.sequence_name,
    increment: BigInt(row.increment_by),
  }));
}

async function restartSequences(
  destination: SqlConnection,
  targetShape: DatabaseShape,
  sourceSequences: Record<string, SequenceManifest>,
): Promise<void> {
  const targetDefinitions = await discoverSequences(destination);
  const targetKeys = targetDefinitions
    .filter((definition) => targetShape.columns.has(definition.table))
    .map((definition) => `${definition.table}.${definition.column}`)
    .sort();
  assertStringListsEqual(targetKeys, Object.keys(sourceSequences).sort(), "source/target sequences");

  for (const definition of targetDefinitions) {
    const key = `${definition.table}.${definition.column}`;
    const source = sourceSequences[key];
    if (!source || !targetShape.columns.has(definition.table)) continue;
    if (!/^-?\d+$/.test(source.nextValue)) throw new Error(`Invalid next sequence value for ${key}`);
    await destination.query(
      `ALTER SEQUENCE ${quoteIdentifier(definition.schema)}.${quoteIdentifier(definition.name)} RESTART WITH ${source.nextValue}`,
    );
  }
}

async function lockApplicationTables(connection: SqlConnection): Promise<void> {
  const names = discoverDrizzleTableNames().map(qualifiedTable).join(", ");
  await connection.query(`LOCK TABLE ${names} IN ACCESS EXCLUSIVE MODE`);
}

function assertDataMatches(source: DataManifest, target: DataManifest): void {
  const sourceTables = Object.keys(source.tables);
  assertStringListsEqual(Object.keys(target.tables), sourceTables, "manifest table coverage");
  for (const table of sourceTables) {
    const sourceTable = source.tables[table];
    const targetTable = target.tables[table];
    if (sourceTable.rows !== targetTable.rows) {
      throw new Error(`Row count mismatch for ${table}: source ${sourceTable.rows}, target ${targetTable.rows}`);
    }
    if (sourceTable.sha256 !== targetTable.sha256) throw new Error(`SHA-256 mismatch for table ${table}`);
  }
  if (JSON.stringify(source.records.documents) !== JSON.stringify(target.records.documents)) {
    throw new Error("SHA-256 mismatch for document content or Yjs state");
  }
  if (JSON.stringify(source.records.assets) !== JSON.stringify(target.records.assets)) {
    throw new Error("SHA-256 mismatch for asset IDs or bytes");
  }
  if (JSON.stringify(source.sequences) !== JSON.stringify(target.sequences)) {
    throw new Error("Sequence state mismatch");
  }
}

function combineManifest(
  snapshotBytes: number,
  snapshotSha256: string,
  sourceSnapshotSchema: SchemaVersion,
  targetShape: DatabaseShape,
  sourceData: DataManifest,
): MigrationManifest {
  return {
    formatVersion: 1,
    sourceSnapshot: { bytes: snapshotBytes, sha256: snapshotSha256 },
    schema: { source: sourceSnapshotSchema, target: targetShape.migration },
    ...sourceData,
  };
}

function hashCanonical(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(normalizeForHash(value)), "utf8"));
}

function hashDigestList(digests: string[]): string {
  const hash = createHash("sha256");
  for (const digest of digests) {
    const bytes = Buffer.from(digest, "hex");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function normalizeForHash(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot hash a non-finite number");
    return value;
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, normalizeForHash(object[key])]));
  }
  throw new Error(`Cannot hash value of type ${typeof value}`);
}

function asBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error(`${label} was not returned as binary data`);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function qualifiedTable(table: string): string {
  return `${quoteIdentifier("public")}.${quoteIdentifier(table)}`;
}

function assertStringListsEqual(actual: string[], expected: string[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: expected [${expected.join(", ")}], found [${actual.join(", ")}]`);
  }
}

async function prepareTemporaryDirectory(directory: string): Promise<void> {
  await assertNoSymlinkComponents(path.dirname(directory));
  await fs.mkdir(path.dirname(directory), { recursive: true });
  try {
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink()) throw new Error(`Temporary source data directory cannot be a symbolic link or junction: ${directory}`);
    throw new Error(`Temporary source data directory must not already exist: ${directory}`);
  }
  const created = await fs.lstat(directory);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new Error(`Temporary source data directory was not created as a private directory: ${directory}`);
  }
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
}

async function assertNoSymlinkComponents(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  const relative = path.relative(root, resolved);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Temporary source path cannot traverse a symbolic link or junction: ${current}`);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function createPgliteQuery(client: Pick<PGliteInterface, "query">): SqlConnection["query"] {
  return async <T extends SqlRow = SqlRow>(text: string, values?: unknown[]): Promise<SqlResult<T>> => {
    const result = await client.query<T>(text, values);
    return { rows: result.rows };
  };
}

function createPgQuery(client: Pick<PostgresClient, "query">): SqlConnection {
  return {
    query: async <T extends SqlRow = SqlRow>(text: string, values?: unknown[]): Promise<SqlResult<T>> => {
      const result = await client.query(text, values);
      return { rows: result.rows as T[] };
    },
  };
}

export function createPostgresClientConfig(connectionString: string): ClientConfig {
  if (!connectionString) throw new Error("Destination URL is empty");
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Destination URL is not a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Destination URL is not a valid PostgreSQL URL");
  }
  const tlsParameters = [...url.searchParams.entries()].filter(([name]) => name.toLowerCase().startsWith("ssl"));
  if (
    tlsParameters.length !== 1 ||
    tlsParameters[0][0].toLowerCase() !== "sslmode" ||
    tlsParameters[0][1] !== "require"
  ) {
    throw new Error(
      "Destination URL must contain exactly sslmode=require and no other ssl* options; plaintext PostgreSQL connections are refused",
    );
  }
  url.searchParams.delete(tlsParameters[0][0]);
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
  };
}

async function closeUnverifiedPostgresClient(
  client: PostgresClient,
  reason: string,
  verificationError?: unknown,
): Promise<never> {
  try {
    await client.end();
  } catch (closeError) {
    const errors = verificationError === undefined ? [closeError] : [verificationError, closeError];
    throw new DestinationTlsVerificationError(
      `${reason}, and the unverified connection did not close cleanly`,
      new AggregateError(errors, "PostgreSQL TLS verification and connection close failed"),
    );
  }
  throw new DestinationTlsVerificationError(reason, verificationError);
}

function createNodePostgresClient(config: ClientConfig): PostgresClient {
  const client = new Client(config);
  return {
    connect: async () => {
      await client.connect();
    },
    query: async (text, values) => {
      const result = await client.query<SqlRow>(text, values);
      return { rows: result.rows };
    },
    end: () => client.end(),
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
