import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import type { AdapterUser } from "next-auth/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresClientConfig } from "../../scripts/lib/pglite-postgres-migration";
import { GithubReconciliationAdapter, githubOAuthProfile } from "./github-oauth-reconciliation";
import * as schema from "./db/schema";

const integrationEnvironmentName = "MARKDOC_PG_INTEGRATION_URL";
const describePostgres = process.env[integrationEnvironmentName] ? describe : describe.skip;

describePostgres("GitHub identity reconciliation on PostgreSQL", () => {
  const schemaName = `markdoc_identity_${process.pid}_${Date.now()}`;
  let administrator: Client;
  let pool: Pool;

  beforeAll(async () => {
    const connectionString = process.env[integrationEnvironmentName];
    if (!connectionString) throw new Error(`${integrationEnvironmentName} is required for the PostgreSQL integration`);
    const config = createPostgresClientConfig(connectionString);
    administrator = new Client(config);
    await administrator.connect();
    await administrator.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({ ...config, max: 4, options: `-c search_path=${schemaName}` });
    await migrate(drizzle(pool, { schema }), {
      migrationsFolder: path.resolve("drizzle"),
      migrationsSchema: schemaName,
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (administrator) {
      await administrator.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await administrator.end();
    }
  });

  it("serializes concurrent first sign-ins into one canonical user and account", async () => {
    const db = drizzle(pool, { schema });
    const adapter = GithubReconciliationAdapter(db);
    if (!adapter.createUser || !adapter.linkAccount) throw new Error("required adapter methods are missing");
    const [legacy] = await db
      .insert(schema.users)
      .values({
        name: "Legacy",
        login: "postgres-concurrent",
        email: "postgres-concurrent@dev.local",
      })
      .returning();
    const oauthProfile = {
      ...githubOAuthProfile({
        id: 836999,
        login: "POSTGRES-CONCURRENT",
        name: "Postgres Concurrent",
        email: "postgres-concurrent@example.test",
      }, { access_token: "postgres-profile-token" }),
      emailVerified: null,
    } as AdapterUser;

    const [first, second] = await Promise.all([
      adapter.createUser(oauthProfile),
      adapter.createUser(oauthProfile),
    ]);
    await Promise.all([
      adapter.linkAccount({
        userId: first.id,
        provider: "github",
        providerAccountId: "836999",
        type: "oauth",
        access_token: "first-test-token",
      }),
      adapter.linkAccount({
        userId: second.id,
        provider: "github",
        providerAccountId: "836999",
        type: "oauth",
        access_token: "second-test-token",
      }),
    ]);

    expect(first.id).toBe(legacy.id);
    expect(second.id).toBe(legacy.id);
    expect(await db.select().from(schema.users)).toHaveLength(1);
    const accounts = await db.select().from(schema.accounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].userId).toBe(legacy.id);
  }, 30_000);
});
