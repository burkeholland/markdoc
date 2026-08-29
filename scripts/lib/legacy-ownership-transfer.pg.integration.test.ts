import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type LegacyOwnershipTransferQueryClient,
  type LegacyOwnershipTransferReport,
  transferLegacyOwnership,
} from "./legacy-ownership-transfer";
import { runMain } from "../transfer-legacy-ownership.mjs";
import {
  FIXTURE,
  FIXTURE_EXPECTED_DRY_RUN as EXPECTED_DRY_RUN,
  FIXTURE_TABLES as ALL_TABLES,
  fixtureSecrets,
  seedLegacyOwnershipFixture,
  snapshotFixtureTables,
} from "./legacy-ownership-transfer.test-fixture";

const integrationEnvironmentName = "MARKDOC_PG_INTEGRATION_URL";
const describePostgres = process.env[integrationEnvironmentName] ? describe : describe.skip;

const { sourceLogin: SOURCE_LOGIN, sourceId: SOURCE_ID, targetId: TARGET_ID, accountId: ACCOUNT_ID } = FIXTURE;

describePostgres("legacy ownership transfer on PostgreSQL", () => {
  const runId = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const schemaName = `markdoc_transfer_${runId}`;
  const migrationsSchema = `${schemaName}_migrations`;
  const scratchRoot = path.resolve(".data", `legacy-ownership-transfer-pg-${process.pid}-${randomUUID()}`);
  let administrator: Client;
  let database: Client;

  beforeAll(async () => {
    const databaseUrl = integrationUrl();
    const migrationsFolder = path.join(scratchRoot, "drizzle");
    await fs.cp(path.resolve("drizzle"), migrationsFolder, { recursive: true });
    for (const entry of await fs.readdir(migrationsFolder)) {
      if (!entry.endsWith(".sql")) continue;
      const migrationPath = path.join(migrationsFolder, entry);
      const migrationSql = await fs.readFile(migrationPath, "utf8");
      await fs.writeFile(migrationPath, migrationSql.replaceAll(`"public".`, `"${schemaName}".`), "utf8");
    }

    administrator = new Client({ connectionString: databaseUrl });
    await administrator.connect();
    await administrator.query(`CREATE SCHEMA "${schemaName}"`);

    database = new Client({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
    await database.connect();
    await migrate(drizzle(database), { migrationsFolder, migrationsSchema });
    await seedLegacyOwnershipFixture((text, values) => database.query(text, values));
  }, 120_000);

  afterAll(async () => {
    if (database) await database.end();
    if (administrator) {
      await administrator.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await administrator.query(`DROP SCHEMA IF EXISTS "${migrationsSchema}" CASCADE`);
      await administrator.end();
    }
    await fs.rm(scratchRoot, { recursive: true, force: true });
  });

  it("dry-runs, applies, verifies and rolls back the production shape to a hash-identical seed", async () => {
    const client = pgTransferClient(database);
    const seed = await snapshot(database);
    const seedHash = hashSnapshot(seed);
    expect(seed.document.filter((row) => row.includes(`"owner_id": "${SOURCE_ID}"`))).toHaveLength(2);
    expect(seed.document.filter((row) => row.includes(`"owner_id": "${TARGET_ID}"`))).toHaveLength(7);
    expect(seed.version.filter((row) => /"document_id": "doc-(a|b)"/.test(row))).toHaveLength(6);
    expect(seed.document.filter((row) => row.includes(`"last_edited_by": "${SOURCE_ID}"`))).toHaveLength(1);
    expect(seed.recent.filter((row) => row.includes(`"document_id": "doc-t1"`))).toHaveLength(2);

    const dryRun = await transferLegacyOwnership({ client, sourceLogin: SOURCE_LOGIN, providerAccountId: ACCOUNT_ID });
    expect(dryRun).toMatchObject({
      mode: "dry-run",
      committed: false,
      verified: true,
      transferId: null,
      schema: { userForeignKeys: 10, softUserReferences: 4, loginReferences: 3, rollbackTableReady: true },
      selection: { sourceUsers: 1, sourceIsLegacy: true, sourceAccounts: 0, sourceSessions: 0, targetAccounts: 1, targetIsSource: false, sameLogin: false },
      documents: { sourceBefore: 2, targetBefore: 7, targetAfter: 9 },
      residualReferences: 0,
    });
    expect(dryRun.operations).toEqual(EXPECTED_DRY_RUN);
    assertNoSecrets(JSON.stringify(dryRun));
    expect(hashSnapshot(await snapshot(database))).toBe(seedHash);

    const applied = await transferLegacyOwnership({ client, sourceLogin: SOURCE_LOGIN, providerAccountId: ACCOUNT_ID, mode: "apply" });
    expect(applied).toMatchObject({ mode: "apply", committed: true, verified: true, residualReferences: 0 });
    expect(applied.operations).toEqual(EXPECTED_DRY_RUN);
    expect(applied.documents).toEqual({ sourceBefore: 2, targetBefore: 7, targetAfter: 9 });
    expect(applied.transferId).toMatch(/^[0-9a-f-]{36}$/);
    assertNoSecrets(JSON.stringify(applied));

    const after = await snapshot(database);
    expect(after.user.some((row) => row.includes(SOURCE_ID))).toBe(false);
    expect(after.user).toHaveLength(seed.user.length - 1);
    expect(after.document.filter((row) => row.includes(`"owner_id": "${TARGET_ID}"`))).toHaveLength(9);
    expect(await residualReferenceCount(database)).toBe(0);
    for (const table of ALL_TABLES) {
      if (table === "ownership_transfer") continue;
      for (const row of seed[table]) {
        if (row.includes(SOURCE_ID) || row.includes(SOURCE_LOGIN)) continue;
        expect(after[table]).toContain(row);
      }
    }
    expect(after.ownership_transfer).toHaveLength(1);
    expect(after.ownership_transfer[0]).toContain('"status": "applied"');

    const verified = await transferLegacyOwnership({
      client,
      sourceLogin: SOURCE_LOGIN,
      providerAccountId: ACCOUNT_ID,
      mode: "verify",
      transferId: applied.transferId ?? undefined,
    });
    expect(verified).toMatchObject({ mode: "verify", committed: false, verified: true, transferId: applied.transferId, residualReferences: 0 });
    expect(verified.documents).toEqual({ sourceBefore: 0, targetBefore: 9, targetAfter: 9 });
    expect(hashSnapshot(await snapshot(database))).toBe(hashSnapshot(after));

    const rolledBack = await transferLegacyOwnership({
      client,
      sourceLogin: SOURCE_LOGIN,
      providerAccountId: ACCOUNT_ID,
      mode: "rollback",
      transferId: applied.transferId ?? undefined,
    });
    expect(rolledBack).toMatchObject({ mode: "rollback", committed: true, transferId: applied.transferId });
    expect(rolledBack.documents).toEqual({ sourceBefore: 2, targetBefore: 9, targetAfter: 7 });
    const restored = await snapshot(database);
    const { ownership_transfer: seedRecords, ...seedRest } = seed;
    const { ownership_transfer: restoredRecords, ...restoredRest } = restored;
    expect(hashSnapshot(restoredRest)).toBe(hashSnapshot(seedRest));
    expect(seedRecords).toEqual([]);
    expect(restoredRecords).toHaveLength(1);
    expect(restoredRecords[0]).toContain('"status": "rolled_back"');

    // A second apply after rollback plans the identical transfer, so the tool is re-runnable.
    const again = await transferLegacyOwnership({ client, sourceLogin: SOURCE_LOGIN, providerAccountId: ACCOUNT_ID });
    expect(again.operations).toEqual(EXPECTED_DRY_RUN);
    expect(hashSnapshot(await snapshot(database))).toBe(hashSnapshot(restored));
  }, 120_000);

  it("connects through the CLI with the app's DATABASE_URL contract and confirms the session is encrypted", async () => {
    const run = async (argv: string[], environment: Record<string, string | undefined>) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runMain(argv, {
        environment: { NODE_ENV: "test", MARKDOC_TRANSFER_SOURCE_LOGIN: SOURCE_LOGIN, MARKDOC_TRANSFER_TARGET_GITHUB_ACCOUNT_ID: ACCOUNT_ID, ...environment },
        output: { log: (message) => stdout.push(message), error: (message) => stderr.push(message) },
      });
      return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
    };
    const secrets = [...fixtureSecrets(), integrationUrl(), new URL(integrationUrl()).password].filter(Boolean);
    const assertClean = (text: string) => {
      for (const sensitive of secrets) expect(text).not.toContain(sensitive);
    };

    // The integration URL carries sslmode=no-verify for the self-signed test server; the tool only accepts the
    // app's two spellings (sslmode=require|verify-ca|verify-full, or DATABASE_SSL=1), so it is refused as is.
    const refused = await run([], { DATABASE_URL: integrationUrl() });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("[INVALID_INVOCATION]");
    expect(refused.stderr).toContain("encrypted");
    assertClean(`${refused.stdout}\n${refused.stderr}`);

    const plain = new URL(integrationUrl());
    plain.searchParams.delete("sslmode");
    plain.searchParams.set("options", `-c search_path=${schemaName}`);
    const unencrypted = await run([], { DATABASE_URL: plain.toString() });
    expect(unencrypted.exitCode).toBe(1);
    expect(unencrypted.stderr).toContain("[INVALID_INVOCATION]");
    assertClean(`${unencrypted.stdout}\n${unencrypted.stderr}`);

    const before = hashSnapshot(await snapshot(database));
    const dryRun = await run([], { DATABASE_URL: plain.toString(), DATABASE_SSL: "1" });
    expect(dryRun.stderr).toBe("");
    expect(dryRun.exitCode).toBe(0);
    const report = JSON.parse(dryRun.stdout) as LegacyOwnershipTransferReport;
    expect(report).toMatchObject({ mode: "dry-run", committed: false, documents: { sourceBefore: 2, targetBefore: 7, targetAfter: 9 } });
    expect(report.operations).toEqual(EXPECTED_DRY_RUN);
    assertClean(dryRun.stdout);
    expect(hashSnapshot(await snapshot(database))).toBe(before);

    const ssl = await database.query<{ ssl: boolean }>(`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`);
    expect(ssl.rows).toEqual([{ ssl: true }]);
  }, 60_000);
});

function integrationUrl(): string {
  const value = process.env[integrationEnvironmentName];
  if (!value) throw new Error(`${integrationEnvironmentName} is required`);
  return value;
}

function pgTransferClient(database: Client): LegacyOwnershipTransferQueryClient {
  return {
    query: async <T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }> => {
      const result = await database.query<T>(text, values);
      return { rows: result.rows };
    },
  };
}

type Snapshot = Record<(typeof ALL_TABLES)[number], string[]>;

async function snapshot(database: Client): Promise<Snapshot> {
  return snapshotFixtureTables(pgTransferClient(database).query);
}

function hashSnapshot(value: Partial<Snapshot>): string {
  const hash = createHash("sha256");
  for (const table of Object.keys(value).sort()) {
    hash.update(`${table}\n`);
    for (const row of value[table as keyof Snapshot] ?? []) hash.update(`${row}\n`);
  }
  return hash.digest("hex");
}

async function residualReferenceCount(database: Client): Promise<number> {
  const result = await database.query<{ count: string }>(
    `SELECT (
       (SELECT COUNT(*) FROM account WHERE "userId" = $1) +
       (SELECT COUNT(*) FROM session WHERE "userId" = $1) +
       (SELECT COUNT(*) FROM document WHERE owner_id = $1 OR last_edited_by = $1) +
       (SELECT COUNT(*) FROM version WHERE created_by = $1) +
       (SELECT COUNT(*) FROM collaborator WHERE added_by = $1 OR lower(login) = $2) +
       (SELECT COUNT(*) FROM star WHERE user_id = $1) +
       (SELECT COUNT(*) FROM recent WHERE user_id = $1) +
       (SELECT COUNT(*) FROM api_token WHERE user_id = $1) +
       (SELECT COUNT(*) FROM asset WHERE user_id = $1) +
       (SELECT COUNT(*) FROM agent_request WHERE user_id = $1) +
       (SELECT COUNT(*) FROM review WHERE user_id = $1) +
       (SELECT COUNT(*) FROM webhook WHERE user_id = $1) +
       (SELECT COUNT(*) FROM activity WHERE actor_id = $1 OR actor_id LIKE 'agent:' || $1 || ':%') +
       (SELECT COUNT(*) FROM notification WHERE lower(user_login) = $2 OR lower(actor_login) = $2)
     )::text AS count`,
    [SOURCE_ID, SOURCE_LOGIN],
  );
  return Number(result.rows[0].count);
}

function assertNoSecrets(output: string): void {
  for (const sensitive of fixtureSecrets()) expect(output).not.toContain(sensitive);
}
