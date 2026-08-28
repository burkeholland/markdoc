import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type GithubIdentityRepairQueryClient,
  repairGithubIdentity,
} from "../../../scripts/lib/github-identity-repair";

const integrationEnvironmentName = "MARKDOC_PG_INTEGRATION_URL";
const describePostgres = process.env[integrationEnvironmentName] ? describe : describe.skip;

describePostgres("GitHub identity repair on PostgreSQL", () => {
  const runId = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const schemaName = `markdoc_repair_${runId}`;
  const migrationsSchema = `${schemaName}_migrations`;
  const manifestRoot = path.resolve(
    ".data",
    `github-identity-repair-pg-${process.pid}-${randomUUID()}`,
  );
  const manifestPath = path.join(manifestRoot, "manifest.json");
  let administrator: Client;
  let database: Client;

  beforeAll(async () => {
    const databaseUrl = integrationUrl();
    await fs.mkdir(manifestRoot, { recursive: true });
    const migrationsFolder = path.join(manifestRoot, "drizzle");
    await fs.cp(path.resolve("drizzle"), migrationsFolder, { recursive: true });
    for (const entry of await fs.readdir(migrationsFolder)) {
      if (!entry.endsWith(".sql")) continue;
      const migrationPath = path.join(migrationsFolder, entry);
      const migrationSql = await fs.readFile(migrationPath, "utf8");
      await fs.writeFile(
        migrationPath,
        migrationSql.replaceAll(`"public".`, `"${schemaName}".`),
        "utf8",
      );
    }

    administrator = new Client({ connectionString: databaseUrl });
    await administrator.connect();
    await administrator.query(`CREATE SCHEMA "${schemaName}"`);

    database = new Client({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName}`,
    });
    await database.connect();
    await migrate(drizzle(database), {
      migrationsFolder,
      migrationsSchema,
    });
    await database.query(
      `INSERT INTO "user" (id, name, email, login)
       VALUES
         ('pg-legacy', 'Legacy', 'pg-repair@dev.local', 'pg-repair'),
         ('pg-duplicate', 'OAuth', 'pg-oauth@example.test', 'PG-REPAIR')`,
    );
    await database.query(
      `INSERT INTO account (
         "userId", type, provider, "providerAccountId", access_token
       ) VALUES ('pg-duplicate', 'oauth', 'github', '83699999', 'pg-secret-token')`,
    );
  }, 120_000);

  afterAll(async () => {
    if (database) await database.end();
    if (administrator) {
      await administrator.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await administrator.query(`DROP SCHEMA IF EXISTS "${migrationsSchema}" CASCADE`);
      await administrator.end();
    }
    await fs.rm(manifestRoot, { recursive: true, force: true });
  });

  it("applies and verifies the manifest in isolated serializable transactions", async () => {
    const client = pgRepairClient(database);
    const applied = await repairGithubIdentity({
      client,
      expectedLogin: "pg-repair",
      providerAccountId: "83699999",
      mode: "apply",
      manifestPath,
    });
    expect(applied).toMatchObject({
      mode: "apply",
      committed: true,
      verified: true,
      manifestPublished: true,
    });

    const verification = await repairGithubIdentity({
      client,
      expectedLogin: "pg-repair",
      providerAccountId: "83699999",
      mode: "verify",
      manifestPath,
    });
    expect(verification).toMatchObject({
      mode: "verify",
      committed: false,
      verified: true,
    });

    const proof = await database.query<{
      users: string;
      accounts: string;
      account_user: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM "user") AS users,
         (SELECT COUNT(*)::text FROM account) AS accounts,
         (SELECT "userId" FROM account
           WHERE provider = 'github' AND "providerAccountId" = '83699999') AS account_user`,
    );
    expect(proof.rows).toEqual([
      { users: "1", accounts: "1", account_user: "pg-legacy" },
    ]);
    const manifestText = await fs.readFile(manifestPath, "utf8");
    expect(manifestText).not.toContain("83699999");
    expect(manifestText).not.toContain("pg-secret-token");
    expect(manifestText).not.toContain("access_token");
  }, 30_000);
});

function integrationUrl(): string {
  const value = process.env[integrationEnvironmentName];
  if (!value) throw new Error(`${integrationEnvironmentName} is required`);
  return value;
}

function pgRepairClient(database: Client): GithubIdentityRepairQueryClient {
  return {
    query: async <T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: T[] }> => {
      const result = await database.query<T>(text, values);
      return { rows: result.rows };
    },
  };
}
