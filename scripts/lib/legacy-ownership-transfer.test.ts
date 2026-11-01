import { PGlite } from "@electric-sql/pglite";
import { getTableName, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as schema from "../../src/server/db/schema";
import {
  type LegacyOwnershipTransferQueryClient,
  type LegacyOwnershipTransferReport,
  TRANSFER_LOGIN_REFERENCES,
  TRANSFER_SOFT_USER_REFERENCES,
  TRANSFER_USER_FOREIGN_KEYS,
  transferLegacyOwnership,
} from "./legacy-ownership-transfer";
import {
  assertEncryptedDatabaseConfiguration,
  parseTransferArguments,
  runMain,
  transportSslOption,
} from "../transfer-legacy-ownership.mjs";

import {
  FIXTURE,
  FIXTURE_EXPECTED_DRY_RUN as EXPECTED_DRY_RUN,
  FIXTURE_TABLES as ALL_TABLES,
  fixtureSecrets,
  seedLegacyOwnershipFixture,
  snapshotFixtureTables,
} from "./legacy-ownership-transfer.test-fixture";

const { sourceLogin: SOURCE_LOGIN, sourceId: SOURCE_ID, targetLogin: TARGET_LOGIN, targetId: TARGET_ID, otherId: OTHER_ID, accountId: ACCOUNT_ID } = FIXTURE;

describe("legacy ownership transfer", () => {
  it("handles exactly the user foreign keys declared in the Drizzle schema", () => {
    const declared: string[] = [];
    for (const value of Object.values(schema) as unknown[]) {
      if (!is(value, PgTable)) continue;
      for (const foreignKey of getTableConfig(value).foreignKeys) {
        const reference = foreignKey.reference();
        if (getTableName(reference.foreignTable) !== "user") continue;
        if (!reference.foreignColumns.some((column) => column.name === "id")) continue;
        for (const column of reference.columns) declared.push(`${getTableName(value)}.${column.name}`);
      }
    }
    expect(declared.sort()).toEqual([...TRANSFER_USER_FOREIGN_KEYS]);
    expect([...TRANSFER_USER_FOREIGN_KEYS]).toEqual([...TRANSFER_USER_FOREIGN_KEYS].sort());
    expect(TRANSFER_SOFT_USER_REFERENCES).toHaveLength(5);
    expect(TRANSFER_LOGIN_REFERENCES).toHaveLength(4);
  });

  it("dry-runs the production shape as counts only and writes nothing", async () => {
    const fixture = await createFixture();
    try {
      const before = await snapshot(fixture.database);
      const report = await transferLegacyOwnership({
        client: fixture.client,
        sourceLogin: ` ${SOURCE_LOGIN.toUpperCase()} `,
        providerAccountId: ACCOUNT_ID,
      });
      expect(await snapshot(fixture.database)).toEqual(before);
      expect(report).toMatchObject({
        mode: "dry-run",
        committed: false,
        verified: true,
        transferId: null,
        schema: { userForeignKeys: 12, softUserReferences: 5, loginReferences: 4, rollbackTableReady: true },
        selection: {
          sourceUsers: 1,
          sourceLoginLength: SOURCE_LOGIN.length,
          sourceIsLegacy: true,
          sourceAccounts: 0,
          sourceSessions: 0,
          targetAccounts: 1,
          targetLoginLength: TARGET_LOGIN.length,
          targetIsSource: false,
          sameLogin: false,
        },
        documents: { sourceBefore: 2, targetBefore: 7, targetAfter: 9 },
        residualReferences: 0,
      });
      expect(report.operations).toEqual(EXPECTED_DRY_RUN);
      expect(report.rollbackRecordRows).toBe(
        Object.entries(EXPECTED_DRY_RUN)
          .filter(([label]) => !label.startsWith("document.ystate") && label !== "user deleted")
          .reduce((sum, [, count]) => sum + count, 0),
      );
      assertNoSecrets(JSON.stringify(report));
    } finally {
      await fixture.database.close();
    }
  }, 60_000);

  it("applies, verifies, and rolls back to a hash-identical seed", async () => {
    const fixture = await createFixture();
    try {
      const seed = await snapshot(fixture.database);
      const applied = await transferLegacyOwnership({
        client: fixture.client,
        sourceLogin: SOURCE_LOGIN,
        providerAccountId: ACCOUNT_ID,
        mode: "apply",
      });
      expect(applied).toMatchObject({ mode: "apply", committed: true, verified: true, residualReferences: 0 });
      expect(applied.operations).toEqual(EXPECTED_DRY_RUN);
      expect(applied.documents).toEqual({ sourceBefore: 2, targetBefore: 7, targetAfter: 9 });
      expect(applied.transferId).toMatch(/^[0-9a-f-]{36}$/);
      assertNoSecrets(JSON.stringify(applied));

      const after = await snapshot(fixture.database);
      expect(after.user.some((row) => row.includes(SOURCE_ID))).toBe(false);
      expect(after.document.filter((row) => row.includes(`"owner_id": "${TARGET_ID}"`))).toHaveLength(9);
      const transferredVideo = await fixture.database.query<{ user_id: string }>(
        `SELECT user_id FROM video_upload WHERE id = 'video-upload-legacy'`,
      );
      expect(transferredVideo.rows).toEqual([{ user_id: TARGET_ID }]);
      const references = await fixture.database.query<{ count: string }>(
        `SELECT (
           (SELECT COUNT(*) FROM document WHERE owner_id = $1 OR last_edited_by = $1) +
           (SELECT COUNT(*) FROM version WHERE created_by = $1) +
           (SELECT COUNT(*) FROM collaborator WHERE added_by = $1 OR lower(login) = $2) +
           (SELECT COUNT(*) FROM folder_collaborator WHERE added_by = $1 OR lower(login) = $2) +
           (SELECT COUNT(*) FROM star WHERE user_id = $1) +
           (SELECT COUNT(*) FROM recent WHERE user_id = $1) +
           (SELECT COUNT(*) FROM api_token WHERE user_id = $1) +
           (SELECT COUNT(*) FROM asset WHERE user_id = $1) +
           (SELECT COUNT(*) FROM video_upload WHERE user_id = $1) +
           (SELECT COUNT(*) FROM agent_request WHERE user_id = $1) +
           (SELECT COUNT(*) FROM review WHERE user_id = $1) +
           (SELECT COUNT(*) FROM webhook WHERE user_id = $1) +
           (SELECT COUNT(*) FROM activity WHERE actor_id = $1 OR actor_id LIKE 'agent:' || $1 || ':%') +
           (SELECT COUNT(*) FROM notification WHERE lower(user_login) = $2 OR lower(actor_login) = $2)
         )::text AS count`,
        [SOURCE_ID, SOURCE_LOGIN],
      );
      expect(references.rows[0].count).toBe("0");
      const folderRoles = await fixture.database.query<{ folder_id: string; login: string; role: string; added_by: string }>(
        `SELECT folder_id, login, role, added_by FROM folder_collaborator ORDER BY folder_id`,
      );
      expect(folderRoles.rows).toEqual([
        { folder_id: "fold-other", login: TARGET_LOGIN, role: "editor", added_by: OTHER_ID },
        { folder_id: "fold-other-move", login: TARGET_LOGIN, role: "viewer", added_by: TARGET_ID },
      ]);
      // Rows that never mentioned the source user are byte-for-byte unchanged.
      for (const table of ALL_TABLES) {
        if (table === "ownership_transfer") continue;
        for (const row of seed[table]) {
          if (row.includes(SOURCE_ID) || row.includes(SOURCE_LOGIN)) continue;
          expect(after[table]).toContain(row);
        }
      }
      const activity = await fixture.database.query<{ actor_id: string }>(`SELECT actor_id FROM activity WHERE id = 'act-agent'`);
      expect(activity.rows).toEqual([{ actor_id: `agent:${TARGET_ID}:Copilot CLI` }]);
      expect(after.ownership_transfer).toHaveLength(1);
      expect(after.ownership_transfer[0]).toContain('"status": "applied"');

      const verified = await transferLegacyOwnership({
        client: fixture.client,
        sourceLogin: SOURCE_LOGIN,
        providerAccountId: ACCOUNT_ID,
        mode: "verify",
        transferId: applied.transferId ?? undefined,
      });
      expect(verified).toMatchObject({ mode: "verify", committed: false, verified: true, transferId: applied.transferId, residualReferences: 0 });
      expect(verified.operations).toEqual({ ...EXPECTED_DRY_RUN, "document.ystate identity metadata (not rewritten)": 0 });
      expect(await snapshot(fixture.database)).toEqual(after);
      // Verify without an id resolves the single applied record for the source login.
      const resolved = await transferLegacyOwnership({ client: fixture.client, sourceLogin: SOURCE_LOGIN, providerAccountId: ACCOUNT_ID, mode: "verify" });
      expect(resolved.transferId).toBe(applied.transferId);

      const rolledBack = await transferLegacyOwnership({
        client: fixture.client,
        sourceLogin: SOURCE_LOGIN,
        providerAccountId: ACCOUNT_ID,
        mode: "rollback",
        transferId: applied.transferId ?? undefined,
      });
      expect(rolledBack).toMatchObject({ mode: "rollback", committed: true, transferId: applied.transferId });
      expect(rolledBack.documents).toEqual({ sourceBefore: 2, targetBefore: 9, targetAfter: 7 });
      const restored = await snapshot(fixture.database);
      const { ownership_transfer: seedRecords, ...seedRest } = seed;
      const { ownership_transfer: restoredRecords, ...restoredRest } = restored;
      expect(restoredRest).toEqual(seedRest);
      expect(seedRecords).toEqual([]);
      expect(restoredRecords).toHaveLength(1);
      expect(restoredRecords[0]).toContain('"status": "rolled_back"');

      await expect(
        transferLegacyOwnership({ client: fixture.client, sourceLogin: SOURCE_LOGIN, providerAccountId: ACCOUNT_ID, mode: "rollback", transferId: applied.transferId ?? undefined }),
      ).rejects.toMatchObject({ reason: "TRANSFER_STATUS" });
      await expect(
        transferLegacyOwnership({ client: fixture.client, sourceLogin: SOURCE_LOGIN, providerAccountId: ACCOUNT_ID, mode: "verify" }),
      ).rejects.toMatchObject({ reason: "TRANSFER_RECORD_COUNT" });
    } finally {
      await fixture.database.close();
    }
  }, 120_000);

  it("refuses each selection classification before any write", async () => {
    const fixture = await createFixture();
    const { database, client } = fixture;
    const refuse = async (reason: string, options: Partial<Parameters<typeof transferLegacyOwnership>[0]> = {}) => {
      const before = await snapshot(database);
      await expect(
        transferLegacyOwnership({ client, sourceLogin: SOURCE_LOGIN, providerAccountId: ACCOUNT_ID, mode: "apply", ...options }),
      ).rejects.toMatchObject({ reason });
      expect(await snapshot(database)).toEqual(before);
    };
    try {
      await refuse("INVALID_LOGIN", { sourceLogin: "bad_login" });
      await refuse("INVALID_ACCOUNT_ID", { providerAccountId: "12ab" });
      await refuse("INVALID_TRANSFER_ID", { mode: "verify", transferId: "not-a-uuid" });
      await refuse("TRANSFER_ID_REQUIRED", { mode: "rollback" });
      await refuse("TRANSFER_RECORD_COUNT", { mode: "verify", transferId: "00000000-0000-4000-8000-000000000000" });
      await refuse("TRANSFER_RECORD_COUNT", { mode: "rollback", transferId: "00000000-0000-4000-8000-000000000000" });

      await refuse("SOURCE_USER_COUNT", { sourceLogin: "nobody" });
      await database.query(`INSERT INTO "user" (id, email, login) VALUES ('twin', 'twin@dev.local', $1)`, [SOURCE_LOGIN.toUpperCase()]);
      await refuse("SOURCE_USER_COUNT");
      await database.query(`DELETE FROM "user" WHERE id = 'twin'`);

      await database.query(`UPDATE "user" SET email = 'real@example.test' WHERE id = $1`, [SOURCE_ID]);
      await refuse("SOURCE_NOT_LEGACY");
      await database.query(`UPDATE "user" SET email = $2, "emailVerified" = now() WHERE id = $1`, [SOURCE_ID, `${SOURCE_LOGIN}@dev.local`]);
      await refuse("SOURCE_NOT_LEGACY");
      await database.query(`UPDATE "user" SET "emailVerified" = NULL WHERE id = $1`, [SOURCE_ID]);

      await database.query(`INSERT INTO session ("sessionToken", "userId", expires) VALUES ('legacy-session', $1, now() + interval '1 day')`, [SOURCE_ID]);
      await refuse("SOURCE_HAS_ACCOUNT_OR_SESSION");
      await database.query(`DELETE FROM session WHERE "sessionToken" = 'legacy-session'`);
      await database.query(`INSERT INTO account ("userId", type, provider, "providerAccountId") VALUES ($1, 'oauth', 'other', 'legacy-acct')`, [SOURCE_ID]);
      await refuse("SOURCE_HAS_ACCOUNT_OR_SESSION");
      await database.query(`DELETE FROM account WHERE provider = 'other'`);

      await refuse("TARGET_ACCOUNT_COUNT", { providerAccountId: "1" });
      await database.query(`UPDATE account SET "userId" = $1 WHERE provider = 'github' AND "providerAccountId" = $2`, [SOURCE_ID, ACCOUNT_ID]);
      await refuse("TARGET_IS_SOURCE");
      await database.query(`UPDATE account SET "userId" = $1 WHERE provider = 'github' AND "providerAccountId" = $2`, [TARGET_ID, ACCOUNT_ID]);

      await database.query(`UPDATE "user" SET login = NULL WHERE id = $1`, [TARGET_ID]);
      await refuse("TARGET_LOGIN_INVALID");
      await database.query(`UPDATE "user" SET login = $2 WHERE id = $1`, [TARGET_ID, TARGET_LOGIN]);

      await database.query(`INSERT INTO api_token (id, user_id, name, mention_slug, prefix, token_hash) VALUES ('tok-conflict', $1, 'Copilot', 'copilot', 'mk_c', 'hash-conflict')`, [TARGET_ID]);
      await refuse("UNIQUE_CONFLICT");
      await database.query(`DELETE FROM api_token WHERE id = 'tok-conflict'`);

      await database.query(`CREATE TABLE extra_user_ref (id text PRIMARY KEY, user_id text REFERENCES "user"(id))`);
      await refuse("SCHEMA_USER_FK_DRIFT");
      await refuse("SCHEMA_USER_FK_DRIFT", { mode: "dry-run" });
      await database.query(`DROP TABLE extra_user_ref`);

      await database.query(`UPDATE document SET owner_id = $2 WHERE owner_id = $1`, [SOURCE_ID, OTHER_ID]);
      await refuse("NOTHING_TO_TRANSFER");
      await database.query(`UPDATE document SET owner_id = $1 WHERE id IN ('doc-a', 'doc-b')`, [SOURCE_ID]);

      // Postconditions inside the transaction roll every write back.
      await refuse("RESIDUAL_REFERENCES", {
        hooks: {
          async afterMutations(hookClient) {
            await hookClient.query(`INSERT INTO version (id, document_id, number, content, created_by) VALUES ('late', 'doc-a', 99, '', $1)`, [SOURCE_ID]);
          },
        },
      });
      await refuse("POSTCONDITION_FAILED", {
        hooks: {
          async afterMutations(hookClient) {
            await hookClient.query(`INSERT INTO document (id, owner_id) VALUES ('late-doc', $1)`, [TARGET_ID]);
          },
        },
      });
      await refuse("INTERNAL", {
        hooks: {
          beforeCommit() {
            throw new Error("injected failure before commit");
          },
        },
      });

      await database.query(`ALTER TABLE ownership_transfer RENAME TO ownership_transfer_missing`);
      await refuse("MIGRATION_MISSING");
      await refuse("MIGRATION_MISSING", { mode: "verify" });
      const dryRun = await transferLegacyOwnership({ client, sourceLogin: SOURCE_LOGIN, providerAccountId: ACCOUNT_ID });
      expect(dryRun.schema.rollbackTableReady).toBe(false);
      expect(dryRun.operations).toEqual(EXPECTED_DRY_RUN);
      await database.query(`ALTER TABLE ownership_transfer_missing RENAME TO ownership_transfer`);
    } finally {
      await database.close();
    }
  }, 120_000);

  it("fails closed on a changed row, a foreign record, or an unknown commit outcome", async () => {
    const fixture = await createFixture();
    try {
      const applied = await transferLegacyOwnership({ client: fixture.client, sourceLogin: SOURCE_LOGIN, providerAccountId: ACCOUNT_ID, mode: "apply" });
      const transferId = applied.transferId ?? undefined;
      await expect(
        transferLegacyOwnership({ client: fixture.client, sourceLogin: "someone-else", providerAccountId: ACCOUNT_ID, mode: "rollback", transferId }),
      ).rejects.toMatchObject({ reason: "TRANSFER_BINDING_MISMATCH" });
      await expect(
        transferLegacyOwnership({ client: fixture.client, sourceLogin: SOURCE_LOGIN, providerAccountId: "1", mode: "rollback", transferId }),
      ).rejects.toMatchObject({ reason: "TARGET_ACCOUNT_COUNT" }).catch(() => undefined);

      await fixture.database.query(`UPDATE document SET title = 'edited after transfer' WHERE id = 'doc-a'`);
      const changed = await snapshot(fixture.database);
      await expect(
        transferLegacyOwnership({ client: fixture.client, sourceLogin: SOURCE_LOGIN, providerAccountId: ACCOUNT_ID, mode: "verify", transferId }),
      ).rejects.toMatchObject({ reason: "STATE_CHANGED" });
      await expect(
        transferLegacyOwnership({ client: fixture.client, sourceLogin: SOURCE_LOGIN, providerAccountId: ACCOUNT_ID, mode: "rollback", transferId }),
      ).rejects.toMatchObject({ reason: "STATE_CHANGED" });
      expect(await snapshot(fixture.database)).toEqual(changed);

      await fixture.database.query(`UPDATE ownership_transfer SET moved_rows_json = '[{"kind":"bogus"}]'::jsonb WHERE id = $1`, [transferId]);
      await expect(
        transferLegacyOwnership({ client: fixture.client, sourceLogin: SOURCE_LOGIN, providerAccountId: ACCOUNT_ID, mode: "verify", transferId }),
      ).rejects.toMatchObject({ reason: "TRANSFER_RECORD_INVALID" });
    } finally {
      await fixture.database.close();
    }

    const unknown = await createFixture();
    try {
      const failingClient: LegacyOwnershipTransferQueryClient = {
        async query(text, values) {
          if (text === "COMMIT") throw new Error("connection dropped during COMMIT");
          return unknown.client.query(text, values);
        },
      };
      await expect(
        transferLegacyOwnership({ client: failingClient, sourceLogin: SOURCE_LOGIN, providerAccountId: ACCOUNT_ID, mode: "apply" }),
      ).rejects.toMatchObject({ reason: "COMMIT_OUTCOME_UNKNOWN" });
      await unknown.database.query("ROLLBACK");
    } finally {
      await unknown.database.close();
    }
  }, 120_000);

  it("keeps identity inputs out of command arguments and CLI output", async () => {
    expect(parseTransferArguments([])).toEqual({ mode: "dry-run" });
    expect(parseTransferArguments(["--apply"])).toEqual({ mode: "apply" });
    expect(parseTransferArguments(["--verify"])).toEqual({ mode: "verify" });
    expect(parseTransferArguments(["--verify", "--transfer-id", "00000000-0000-4000-8000-000000000000"])).toEqual({
      mode: "verify",
      transferId: "00000000-0000-4000-8000-000000000000",
    });
    expect(parseTransferArguments(["--rollback", "--transfer-id", "00000000-0000-4000-8000-000000000000"])).toEqual({
      mode: "rollback",
      transferId: "00000000-0000-4000-8000-000000000000",
    });
    expect(parseTransferArguments(["--help"])).toEqual({ mode: "help" });
    expect(() => parseTransferArguments(["--rollback"])).toThrow(/requires --transfer-id/);
    expect(() => parseTransferArguments(["--apply", "--transfer-id", "00000000-0000-4000-8000-000000000000"])).toThrow(/only valid/);
    expect(() => parseTransferArguments(["--transfer-id", "nope", "--verify"])).toThrow(/not a transfer identifier/);
    expect(() => parseTransferArguments(["--transfer-id"])).toThrow(/requires a value/);
    expect(() => parseTransferArguments([`--login=${SOURCE_LOGIN}`])).toThrow(/unsupported/);
    expect(() => parseTransferArguments(["--apply", "--verify"])).toThrow(/mutually exclusive/);
    expect(() => parseTransferArguments(["--apply", "--apply"])).toThrow(/duplicate/);

    const environment = { DATABASE_SSL: "" };
    expect(() => assertEncryptedDatabaseConfiguration("postgresql://h/db", environment)).toThrow(/encrypted/);
    expect(() => assertEncryptedDatabaseConfiguration("postgresql://h/db?sslmode=disable", environment)).toThrow(/encrypted/);
    expect(() => assertEncryptedDatabaseConfiguration("postgresql://h/db?sslmode=no-verify", environment)).toThrow(/encrypted/);
    expect(() => assertEncryptedDatabaseConfiguration("postgresql://h/db?sslmode=disable", { DATABASE_SSL: "1" })).toThrow(/encrypted/);
    expect(() => assertEncryptedDatabaseConfiguration("mysql://h/db?sslmode=require", environment)).toThrow(/valid PostgreSQL/);
    expect(() => assertEncryptedDatabaseConfiguration("postgresql://h/db?sslmode=require", environment)).not.toThrow();
    expect(() => assertEncryptedDatabaseConfiguration("postgresql://h/db?sslmode=verify-full", environment)).not.toThrow();
    expect(() => assertEncryptedDatabaseConfiguration("postgresql://h/db", { DATABASE_SSL: "1" })).not.toThrow();
    expect(transportSslOption("postgresql://h/db?sslmode=require", environment)).toEqual({ rejectUnauthorized: false });
    expect(transportSslOption("postgresql://h/db", { DATABASE_SSL: "1" })).toEqual({ rejectUnauthorized: false });
    expect(transportSslOption("postgresql://h/db?sslmode=verify-full", environment)).toBeUndefined();

    const fixture = await createFixture();
    try {
      const run = async (argv: string[], overrides: Record<string, string | undefined> = {}) => {
        const stdout: string[] = [];
        const stderr: string[] = [];
        let closed = false;
        const exitCode = await runMain(argv, {
          environment: {
            NODE_ENV: "test",
            DATABASE_URL: "configured-database-url",
            MARKDOC_TRANSFER_SOURCE_LOGIN: SOURCE_LOGIN,
            MARKDOC_TRANSFER_TARGET_GITHUB_ACCOUNT_ID: ACCOUNT_ID,
            ...overrides,
          },
          output: { log: (message) => stdout.push(message), error: (message) => stderr.push(message) },
          connect: async () => ({
            client: fixture.client,
            close: async () => {
              closed = true;
            },
          }),
        });
        return { exitCode, stdout, stderr, closed };
      };

      const dryRun = await run([]);
      expect(dryRun.exitCode).toBe(0);
      expect(dryRun.closed).toBe(true);
      expect(dryRun.stderr).toEqual([]);
      const report = JSON.parse(dryRun.stdout.join("")) as LegacyOwnershipTransferReport;
      expect(report).toMatchObject({ mode: "dry-run", committed: false });
      expect(report.operations).toEqual(EXPECTED_DRY_RUN);
      assertNoSecrets(`${dryRun.stdout.join("\n")}\n${dryRun.stderr.join("\n")}`);
      expect(dryRun.stdout.join("")).not.toContain("configured-database-url");

      const refused = await run([], { MARKDOC_TRANSFER_SOURCE_LOGIN: "nobody" });
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.join("\n")).toContain("[SOURCE_USER_COUNT]");
      expect(refused.stderr.join("\n")).not.toContain("nobody");

      const unset = await run([], { MARKDOC_TRANSFER_TARGET_GITHUB_ACCOUNT_ID: undefined });
      expect(unset.exitCode).toBe(1);
      expect(unset.stderr.join("\n")).toContain("MARKDOC_TRANSFER_TARGET_GITHUB_ACCOUNT_ID");
      expect(unset.stderr.join("\n")).not.toContain(ACCOUNT_ID);

      const badArgument = await run(["--rollback"]);
      expect(badArgument.exitCode).toBe(1);
      expect(badArgument.stderr.join("\n")).toContain("INVALID_INVOCATION");

      const help = await run(["--help"]);
      expect(help.exitCode).toBe(0);
      expect(help.stdout.join("")).toContain("usage:");

      const applied = await run(["--apply"]);
      expect(applied.exitCode).toBe(0);
      const appliedReport = JSON.parse(applied.stdout.join("")) as LegacyOwnershipTransferReport;
      expect(appliedReport.committed).toBe(true);
      assertNoSecrets(applied.stdout.join("\n"));
      const verified = await run(["--verify", "--transfer-id", appliedReport.transferId ?? ""]);
      expect(verified.exitCode).toBe(0);
      const rolledBack = await run(["--rollback", "--transfer-id", appliedReport.transferId ?? ""]);
      expect(rolledBack.exitCode).toBe(0);
      expect((JSON.parse(rolledBack.stdout.join("")) as LegacyOwnershipTransferReport).committed).toBe(true);
    } finally {
      await fixture.database.close();
    }
  }, 120_000);
});

interface Fixture {
  database: PGlite;
  client: LegacyOwnershipTransferQueryClient;
}

async function createFixture(): Promise<Fixture> {
  const database = new PGlite("memory://");
  await database.waitReady;
  await migrate(drizzle(database), { migrationsFolder: path.resolve("drizzle") });
  await seedLegacyOwnershipFixture((text, values) => database.query(text, values));
  return { database, client: pgliteClient(database) };
}

function pgliteClient(database: PGlite): LegacyOwnershipTransferQueryClient {
  return {
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> => {
      const result = await database.query<T>(text, values);
      return { rows: result.rows };
    },
  };
}

type Snapshot = Record<(typeof ALL_TABLES)[number], string[]>;

async function snapshot(database: PGlite): Promise<Snapshot> {
  return snapshotFixtureTables(pgliteClient(database).query);
}

function assertNoSecrets(output: string): void {
  for (const sensitive of fixtureSecrets()) {
    expect(output).not.toContain(sensitive);
  }
}
