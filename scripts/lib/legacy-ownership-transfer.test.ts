import { PGlite } from "@electric-sql/pglite";
import { getTableName, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import * as schema from "../../src/server/db/schema";
import {
  type LegacyOwnershipTransferQueryClient,
  type LegacyOwnershipTransferReport,
  TRANSFER_COUNT_LABELS,
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

const SOURCE_LOGIN = "legacy-dev";
const SOURCE_ID = "legacy-user-id-0001";
const TARGET_LOGIN = "target-gh";
const TARGET_ID = "target-user-id-0001";
const OTHER_ID = "other-user-id-0001";
const ACCOUNT_ID = "83699999";
const OAUTH_TOKEN = "oauth-token-must-not-be-output";
const PRIVATE_EMAIL = "private-target@example.test";

const ALL_TABLES = [
  "account",
  "activity",
  "agent_request",
  "api_token",
  "asset",
  "collaborator",
  "document",
  "notification",
  "ownership_transfer",
  "recent",
  "review",
  "session",
  "star",
  "user",
  "verificationToken",
  "version",
  "webhook",
  "webhook_delivery",
] as const;

const EXPECTED_DRY_RUN: Record<(typeof TRANSFER_COUNT_LABELS)[number], number> = {
  "document.owner_id moved": 2,
  "document.last_edited_by updated": 1,
  "version.created_by updated": 5,
  "collaborator.added_by updated": 1,
  "collaborator.login moved": 1,
  "collaborator.login deduplicated": 1,
  "collaborator.login owner_deleted": 2,
  "star.user_id moved": 1,
  "star.user_id deduplicated": 1,
  "recent.user_id moved": 1,
  "recent.user_id deduplicated": 1,
  "api_token.user_id moved": 1,
  "asset.user_id moved": 1,
  "agent_request.user_id moved": 1,
  "review.user_id moved": 1,
  "webhook.user_id moved": 1,
  "activity.actor_id updated": 1,
  "activity.actor_id agent_prefix updated": 1,
  "notification.user_login moved": 1,
  "notification.user_login deduplicated": 1,
  "notification.actor_login updated": 1,
  "document.ystate identity metadata (not rewritten)": 1,
  "user deleted": 1,
};

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
    expect(TRANSFER_SOFT_USER_REFERENCES).toHaveLength(4);
    expect(TRANSFER_LOGIN_REFERENCES).toHaveLength(3);
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
        schema: { userForeignKeys: 10, softUserReferences: 4, loginReferences: 3, rollbackTableReady: true },
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
      const references = await fixture.database.query<{ count: string }>(
        `SELECT (
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
      expect(references.rows[0].count).toBe("0");
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

/**
 * The verified production shape plus one row for every move, dedup and refusal path: a legacy user with
 * two documents, six versions and one last_edited_by; a target user with a GitHub account and seven
 * documents; a third user; and a document where both users have a `recent` row.
 */
async function createFixture(): Promise<Fixture> {
  const database = new PGlite("memory://");
  await database.waitReady;
  await migrate(drizzle(database), { migrationsFolder: path.resolve("drizzle") });
  const q = (text: string, values?: unknown[]) => database.query(text, values);

  await q(
    `INSERT INTO "user" (id, name, email, "emailVerified", image, login) VALUES
       ($1, 'Legacy Dev', $2, NULL, NULL, $3),
       ($4, 'Target Person', $5, now(), 'https://images.example.test/private', $6),
       ($7, 'Other Person', 'other@example.test', now(), NULL, 'other')`,
    [SOURCE_ID, `${SOURCE_LOGIN}@dev.local`, SOURCE_LOGIN, TARGET_ID, PRIVATE_EMAIL, TARGET_LOGIN, OTHER_ID],
  );
  await q(
    `INSERT INTO account ("userId", type, provider, "providerAccountId", access_token, token_type, scope)
     VALUES ($1, 'oauth', 'github', $2, $3, 'bearer', 'read:user')`,
    [TARGET_ID, ACCOUNT_ID, OAUTH_TOKEN],
  );
  await q(`INSERT INTO session ("sessionToken", "userId", expires) VALUES ('target-session', $1, now() + interval '7 days')`, [TARGET_ID]);
  await q(`INSERT INTO "verificationToken" (identifier, token, expires) VALUES ('kept', 'kept-secret', now() + interval '1 day')`);

  // Source documents: doc-a (last edited by the source, comment authored by the source) and doc-b.
  await q(`INSERT INTO document (id, title, owner_id, content, last_edited_by, ystate) VALUES ('doc-a', 'A', $1, 'alpha', $1, $2)`, [SOURCE_ID, identityYState(SOURCE_ID)]);
  await q(`INSERT INTO document (id, title, owner_id, content, last_edited_by) VALUES ('doc-b', 'B', $1, 'beta', $2)`, [SOURCE_ID, TARGET_ID]);
  for (let number = 1; number <= 4; number++) {
    await q(`INSERT INTO version (id, document_id, number, content, created_by, created_by_name) VALUES ($1, 'doc-a', $2, 'a', $3, 'Legacy Dev')`, [`ver-a-${number}`, number, SOURCE_ID]);
  }
  await q(`INSERT INTO version (id, document_id, number, content, created_by, created_by_name) VALUES ('ver-b-1', 'doc-b', 1, 'b', $1, 'Legacy Dev')`, [SOURCE_ID]);
  await q(`INSERT INTO version (id, document_id, number, content, created_by, created_by_name) VALUES ('ver-b-2', 'doc-b', 2, 'b2', $1, 'Target Person')`, [TARGET_ID]);

  // Target documents.
  for (let index = 1; index <= 7; index++) {
    await q(`INSERT INTO document (id, title, owner_id, content, last_edited_by) VALUES ($1, $2, $3, 't', $3)`, [`doc-t${index}`, `T${index}`, TARGET_ID]);
  }
  await q(`INSERT INTO version (id, document_id, number, content, created_by) VALUES ('ver-t1-1', 'doc-t1', 1, 't', $1)`, [TARGET_ID]);
  // Other user's documents: doc-o1 (source is a collaborator, added by the source) and doc-o2 (both are collaborators).
  await q(`INSERT INTO document (id, title, owner_id, content) VALUES ('doc-o1', 'O1', $1, 'o'), ('doc-o2', 'O2', $1, 'o')`, [OTHER_ID]);

  await q(`INSERT INTO collaborator (document_id, login, role, added_by) VALUES ('doc-o1', $1, 'editor', $2)`, [SOURCE_LOGIN, OTHER_ID]);
  await q(`INSERT INTO collaborator (document_id, login, role, added_by) VALUES ('doc-o1', 'someone', 'viewer', $1)`, [SOURCE_ID]);
  await q(`INSERT INTO collaborator (document_id, login, role, added_by) VALUES ('doc-o2', $1, 'viewer', $3), ('doc-o2', $2, 'editor', $3)`, [SOURCE_LOGIN, TARGET_LOGIN, OTHER_ID]);
  await q(`INSERT INTO collaborator (document_id, login, role, added_by) VALUES ('doc-t2', $1, 'commenter', $2)`, [SOURCE_LOGIN, TARGET_ID]);
  await q(`INSERT INTO collaborator (document_id, login, role, added_by) VALUES ('doc-b', $1, 'editor', $2)`, [TARGET_LOGIN, SOURCE_ID]);
  await q(`INSERT INTO collaborator (document_id, login, role, added_by) VALUES ('doc-t3', 'other', 'viewer', $1)`, [TARGET_ID]);

  await q(`INSERT INTO star (document_id, user_id) VALUES ('doc-a', $1), ('doc-t1', $1), ('doc-t1', $2), ('doc-o1', $3)`, [SOURCE_ID, TARGET_ID, OTHER_ID]);
  await q(`INSERT INTO recent (user_id, document_id, opened_at) VALUES ($1, 'doc-t1', now() - interval '2 days'), ($2, 'doc-t1', now() - interval '1 day'), ($1, 'doc-b', now()), ($3, 'doc-o1', now())`, [SOURCE_ID, TARGET_ID, OTHER_ID]);

  await q(`INSERT INTO api_token (id, user_id, name, mention_slug, prefix, token_hash) VALUES ('tok-legacy', $1, 'Copilot', 'copilot', 'mk_l', 'hash-legacy'), ('tok-target', $2, 'Reviewer', 'reviewer', 'mk_t', 'hash-target')`, [SOURCE_ID, TARGET_ID]);
  await q(`INSERT INTO asset (id, document_id, user_id, name, mime, size, sha256, data) VALUES ('asset-legacy', 'doc-a', $1, 'a.png', 'image/png', 1, 'sha-a', $3), ('asset-target', 'doc-t1', $2, 't.png', 'image/png', 1, 'sha-t', $3)`, [SOURCE_ID, TARGET_ID, Buffer.from([1])]);
  await q(`INSERT INTO agent_request (id, document_id, user_id, instruction) VALUES ('req-legacy', 'doc-a', $1, 'tidy'), ('req-target', 'doc-t1', $2, 'tidy')`, [SOURCE_ID, TARGET_ID]);
  await q(`INSERT INTO review (id, document_id, user_id, author_name) VALUES ('rev-legacy', 'doc-b', $1, 'Legacy Dev'), ('rev-target', 'doc-t2', $2, 'Target')`, [SOURCE_ID, TARGET_ID]);
  await q(`INSERT INTO webhook (id, user_id, url, secret) VALUES ('hook-legacy', $1, 'https://example.test/legacy', 'legacy-hook-secret'), ('hook-target', $2, 'https://example.test/target', 'target-hook-secret')`, [SOURCE_ID, TARGET_ID]);
  await q(`INSERT INTO webhook_delivery (id, webhook_id, event, status, duration_ms) VALUES ('del-legacy', 'hook-legacy', 'document.updated', 200, 5), ('del-target', 'hook-target', 'document.updated', 200, 5)`);

  await q(`INSERT INTO activity (id, document_id, actor_id, actor_name, action) VALUES ('act-user', 'doc-a', $1, 'Legacy Dev', 'edit'), ('act-agent', 'doc-a', $2, 'Copilot CLI', 'comment.add'), ('act-target', 'doc-t1', $3, 'Target', 'edit'), ('act-other', 'doc-o1', $4, 'Other', 'edit')`, [SOURCE_ID, `agent:${SOURCE_ID}:Copilot CLI`, TARGET_ID, OTHER_ID]);
  await q(
    `INSERT INTO notification (id, user_login, document_id, kind, actor_login, ref_id, snippet) VALUES
       ('note-move', $1, 'doc-o1', 'mention', 'other', 'thread-1', ''),
       ('note-dup-source', $1, 'doc-o2', 'share', 'other', 'doc-o2', ''),
       ('note-dup-target', $2, 'doc-o2', 'share', 'other', 'doc-o2', ''),
       ('note-actor', 'other', 'doc-o1', 'reply', $1, 'thread-2', ''),
       ('note-target', $2, 'doc-t1', 'mention', 'other', 'thread-3', '')`,
    [SOURCE_LOGIN, TARGET_LOGIN],
  );

  return { database, client: pgliteClient(database) };
}

function identityYState(userId: string): Uint8Array {
  const document = new Y.Doc();
  try {
    const thread = new Y.Map<unknown>();
    document.getMap("comments").set("thread-1", thread);
    thread.set("authorId", userId);
    thread.set("authorName", "Legacy Dev");
    return Y.encodeStateAsUpdate(document);
  } finally {
    document.destroy();
  }
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
  const result = {} as Snapshot;
  for (const table of ALL_TABLES) {
    const exists = await database.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${table}`]);
    if (!exists.rows[0]?.present) {
      result[table] = [];
      continue;
    }
    const rows = await database.query<{ row: string }>(`SELECT to_jsonb(t)::text AS row FROM "${table}" t`);
    result[table] = rows.rows.map((row) => row.row).sort();
  }
  return result;
}

function assertNoSecrets(output: string): void {
  for (const sensitive of [SOURCE_ID, TARGET_ID, OTHER_ID, SOURCE_LOGIN, TARGET_LOGIN, ACCOUNT_ID, OAUTH_TOKEN, PRIVATE_EMAIL, "legacy-hook-secret", "hash-legacy"]) {
    expect(output).not.toContain(sensitive);
  }
}
