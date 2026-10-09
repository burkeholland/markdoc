import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  type GithubIdentityRepairManifestStore,
  type GithubIdentityRepairQueryClient,
  normalizeRepairGithubLogin,
  REPAIR_APPLICATION_TABLES,
  REPAIR_SCHEMA_TABLES,
  repairGithubIdentity,
} from "../../../scripts/lib/github-identity-repair";
import {
  parseRepairArguments,
  runMain,
} from "../../../scripts/repair-github-identity.mjs";

const LOGIN = "repair-user";
const ACCOUNT_ID = "83612345";
const LEGACY_ID = "legacy-user-id";
const DUPLICATE_ID = "oauth-duplicate-id";
const OAUTH_TOKEN = "oauth-token-must-not-be-output";
const PRIVATE_NAME = "Private OAuth Name";
const PRIVATE_EMAIL = "private-oauth@example.test";
const PRIVATE_IMAGE = "https://images.example.test/private";
const testRoots: string[] = [];

describe("GitHub identity repair", () => {
  afterEach(async () => {
    await Promise.all(
      testRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("accepts provider-supplied legacy GitHub logins while rejecting unnormalizable input", () => {
    expect(normalizeRepairGithubLogin(" D--B ")).toBe("d--b");
    expect(normalizeRepairGithubLogin("x--")).toBe("x--");
    expect(normalizeRepairGithubLogin("-leading")).toBeNull();
    expect(normalizeRepairGithubLogin("bad_login")).toBeNull();
    expect(normalizeRepairGithubLogin("")).toBeNull();
  });

  it("dry-runs a complete plan and rolls every simulated write back", async () => {
    const fixture = await createFixture(true);
    try {
      const before = await identityRows(fixture.database);
      const report = await repairGithubIdentity({
        client: fixture.client,
        expectedLogin: `  ${LOGIN.toUpperCase()} `,
        providerAccountId: ACCOUNT_ID,
      });
      const after = await identityRows(fixture.database);

      expect(after).toEqual(before);
      expect(report).toMatchObject({
        mode: "dry-run",
        committed: false,
        verified: true,
        schema: { tables: 20, userForeignKeys: 10 },
        selection: {
          normalizedLoginUsers: 2,
          targetGithubAccounts: 1,
          legacySafe: true,
          duplicateAuthSafe: true,
        },
        operations: {
          profilesToUpdate: 1,
          accountsToMove: 1,
          usersToDelete: 1,
          usersToCreate: 0,
        },
      });
      expect(Object.keys(report.tables).sort()).toEqual([...REPAIR_SCHEMA_TABLES]);
      expect(report.dependencies["collaborator.login"]).toBe(1);
      expect(report.dependencies["notification.user_login"]).toBe(1);
      expect(report.dependencies["notification.actor_login"]).toBe(1);
      expect(
        Object.entries(report.dependencies).every(
          ([label, count]) =>
            ["collaborator.login", "notification.user_login", "notification.actor_login"].includes(label) ||
            count === 0,
        ),
      ).toBe(true);
      for (const table of REPAIR_APPLICATION_TABLES) {
        expect(report.tables[table].afterCount).toBe(report.tables[table].beforeCount);
        expect(report.tables[table].afterHashPrefix).toBe(
          report.tables[table].beforeHashPrefix,
        );
      }
      const output = JSON.stringify(report);
      for (const sensitive of [
        ACCOUNT_ID,
        LEGACY_ID,
        DUPLICATE_ID,
        OAUTH_TOKEN,
        PRIVATE_NAME,
        PRIVATE_EMAIL,
        PRIVATE_IMAGE,
      ]) {
        expect(output).not.toContain(sensitive);
      }
    } finally {
      await fixture.database.close();
    }
  }, 60_000);

  it("applies, verifies, and rolls back while preserving every application table", async () => {
    const fixture = await createFixture(true);
    const manifestPath = await newManifestPath();
    try {
      const beforeCounts = await tableCounts(fixture.database);
      const beforeGistUpdates = await fixture.database.query(`SELECT * FROM gist_auto_update`);
      const applied = await repairGithubIdentity({
        client: fixture.client,
        expectedLogin: LOGIN,
        providerAccountId: ACCOUNT_ID,
        mode: "apply",
        manifestPath,
      });
      expect(applied).toMatchObject({
        committed: true,
        verified: true,
        manifestStaged: true,
        manifestPublished: true,
      });

      const users = await fixture.database.query<{
        id: string;
        name: string | null;
        email: string | null;
        image: string | null;
        login: string | null;
      }>(`SELECT id, name, email, image, login FROM "user" ORDER BY id`);
      expect(users.rows.find((row) => row.id === DUPLICATE_ID)).toBeUndefined();
      expect(users.rows.find((row) => row.id === LEGACY_ID)).toEqual({
        id: LEGACY_ID,
        name: PRIVATE_NAME,
        email: PRIVATE_EMAIL,
        image: PRIVATE_IMAGE,
        login: LOGIN,
      });
      const account = await fixture.database.query<{ userId: string; accessToken: string; count: string }>(
        `SELECT "userId", access_token AS "accessToken", COUNT(*) OVER ()::text AS count
           FROM account
          WHERE provider = 'github' AND "providerAccountId" = $1`,
        [ACCOUNT_ID],
      );
      expect(account.rows).toEqual([{ userId: LEGACY_ID, accessToken: OAUTH_TOKEN, count: "1" }]);

      const afterCounts = await tableCounts(fixture.database);
      for (const table of REPAIR_APPLICATION_TABLES) {
        expect(beforeCounts[table]).toBeGreaterThan(0);
        expect(afterCounts[table]).toBe(beforeCounts[table]);
      }
      expect((await fixture.database.query(`SELECT * FROM gist_auto_update`)).rows).toEqual(
        beforeGistUpdates.rows,
      );
      expect(afterCounts.account).toBe(beforeCounts.account);
      expect(afterCounts.user).toBe(beforeCounts.user - 1);

      const manifestText = await fs.readFile(manifestPath, "utf8");
      expect(manifestText).not.toContain(ACCOUNT_ID);
      expect(manifestText).not.toContain(OAUTH_TOKEN);
      for (const field of [
        "access_token",
        "refresh_token",
        "id_token",
        "session_state",
        "token_hash",
        "prefix",
      ]) {
        expect(manifestText).not.toContain(field);
      }

      const verification = await repairGithubIdentity({
        client: fixture.client,
        expectedLogin: LOGIN,
        providerAccountId: ACCOUNT_ID,
        mode: "verify",
        manifestPath,
      });
      expect(verification).toMatchObject({
        mode: "verify",
        committed: false,
        verified: true,
      });

      const rolledBack = await repairGithubIdentity({
        client: fixture.client,
        expectedLogin: LOGIN,
        providerAccountId: ACCOUNT_ID,
        mode: "rollback",
        manifestPath,
      });
      expect(rolledBack).toMatchObject({
        mode: "rollback",
        committed: true,
        verified: true,
        operations: {
          profilesToUpdate: 1,
          accountsToMove: 1,
          usersToDelete: 0,
          usersToCreate: 1,
        },
      });
      expect(await tableCounts(fixture.database)).toEqual(beforeCounts);
      expect((await fixture.database.query(`SELECT * FROM gist_auto_update`)).rows).toEqual(
        beforeGistUpdates.rows,
      );
      const restored = await identityRows(fixture.database);
      expect(restored.users).toContainEqual(
        expect.objectContaining({
          id: LEGACY_ID,
          email: `${LOGIN}@dev.local`,
          name: "Legacy Development User",
        }),
      );
      expect(restored.users).toContainEqual(
        expect.objectContaining({
          id: DUPLICATE_ID,
          email: PRIVATE_EMAIL,
          name: PRIVATE_NAME,
        }),
      );
      expect(restored.accounts).toEqual([
        expect.objectContaining({ userId: DUPLICATE_ID, providerAccountId: ACCOUNT_ID }),
      ]);
    } finally {
      await fixture.database.close();
    }
  }, 60_000);

  it("refuses each duplicate user identifier classification before writes", async () => {
    const fixture = await createFixture(false);
    try {
      await fixture.database.query(
        `INSERT INTO document (id, owner_id) VALUES ('legacy-document', $1)`,
        [LEGACY_ID],
      );
      const cases: Array<{
        label: string;
        insert: string;
        values?: unknown[];
        cleanup: string;
      }> = [
        {
          label: "document.owner_id",
          insert: `INSERT INTO document (id, owner_id) VALUES ('duplicate-document', $1)`,
          values: [DUPLICATE_ID],
          cleanup: `DELETE FROM document WHERE id = 'duplicate-document'`,
        },
        {
          label: "star.user_id",
          insert: `INSERT INTO star (document_id, user_id) VALUES ('legacy-document', $1)`,
          values: [DUPLICATE_ID],
          cleanup: `DELETE FROM star WHERE document_id = 'legacy-document'`,
        },
        {
          label: "recent.user_id",
          insert: `INSERT INTO recent (user_id, document_id) VALUES ($1, 'legacy-document')`,
          values: [DUPLICATE_ID],
          cleanup: `DELETE FROM recent WHERE document_id = 'legacy-document'`,
        },
        {
          label: "api_token.user_id",
          insert: `INSERT INTO api_token (id, user_id, name, prefix, token_hash)
                   VALUES ('duplicate-token', $1, 'label', 'mk_case', 'case-hash')`,
          values: [DUPLICATE_ID],
          cleanup: `DELETE FROM api_token WHERE id = 'duplicate-token'`,
        },
        {
          label: "asset.user_id",
          insert: `INSERT INTO asset (id, document_id, user_id, name, mime, size, sha256, data)
                   VALUES ('duplicate-asset', 'legacy-document', $1, 'asset', 'text/plain', 0, 'case-sha', $2)`,
          values: [DUPLICATE_ID, Buffer.alloc(0)],
          cleanup: `DELETE FROM asset WHERE id = 'duplicate-asset'`,
        },
        {
          label: "agent_request.user_id",
          insert: `INSERT INTO agent_request (id, document_id, user_id, instruction)
                   VALUES ('duplicate-request', 'legacy-document', $1, 'request')`,
          values: [DUPLICATE_ID],
          cleanup: `DELETE FROM agent_request WHERE id = 'duplicate-request'`,
        },
        {
          label: "review.user_id",
          insert: `INSERT INTO review (id, document_id, user_id, author_name)
                   VALUES ('duplicate-review', 'legacy-document', $1, 'author')`,
          values: [DUPLICATE_ID],
          cleanup: `DELETE FROM review WHERE id = 'duplicate-review'`,
        },
        {
          label: "webhook.user_id",
          insert: `INSERT INTO webhook (id, user_id, url, secret)
                   VALUES ('duplicate-webhook', $1, 'https://example.invalid', 'secret')`,
          values: [DUPLICATE_ID],
          cleanup: `DELETE FROM webhook WHERE id = 'duplicate-webhook'`,
        },
        {
          label: "gist_auto_update.publisher_id (disabled consent)",
          insert: `INSERT INTO gist_auto_update (
                     document_id, publisher_id, gist_id, filename, account_login, is_public,
                     enabled, acknowledged_at, generation, due_at
                   ) VALUES (
                     'legacy-document', $1, 'fixture-gist', 'document.md', $2, false,
                     false, '2026-09-01T00:00:00Z', 'duplicate-generation', '2026-09-01T00:00:02Z'
                   )`,
          values: [DUPLICATE_ID, LOGIN],
          cleanup: `DELETE FROM gist_auto_update WHERE document_id = 'legacy-document'`,
        },
        {
          label: "document.last_edited_by",
          insert: `UPDATE document SET last_edited_by = $1 WHERE id = 'legacy-document'`,
          values: [DUPLICATE_ID],
          cleanup: `UPDATE document SET last_edited_by = NULL WHERE id = 'legacy-document'`,
        },
        {
          label: "collaborator.added_by",
          insert: `INSERT INTO collaborator (document_id, login, added_by)
                   VALUES ('legacy-document', 'someone-else', $1)`,
          values: [DUPLICATE_ID],
          cleanup: `DELETE FROM collaborator WHERE document_id = 'legacy-document'`,
        },
        {
          label: "version.created_by",
          insert: `INSERT INTO version (id, document_id, number, content, created_by)
                   VALUES ('duplicate-version', 'legacy-document', 1, '', $1)`,
          values: [DUPLICATE_ID],
          cleanup: `DELETE FROM version WHERE id = 'duplicate-version'`,
        },
        {
          label: "activity.actor_id",
          insert: `INSERT INTO activity (id, document_id, actor_id, actor_name, action)
                   VALUES ('duplicate-activity', 'legacy-document', $1, 'actor', 'edit')`,
          values: [DUPLICATE_ID],
          cleanup: `DELETE FROM activity WHERE id = 'duplicate-activity'`,
        },
        {
          label: "activity.actor_id agent form",
          insert: `INSERT INTO activity (id, document_id, actor_id, actor_name, actor_kind, action)
                   VALUES ('duplicate-agent-activity', 'legacy-document', $1, 'agent', 'agent', 'edit')`,
          values: [`agent:${DUPLICATE_ID}:token-id`],
          cleanup: `DELETE FROM activity WHERE id = 'duplicate-agent-activity'`,
        },
      ];

      for (const testCase of cases) {
        await fixture.database.query(testCase.insert, testCase.values);
        const before = await identityRows(fixture.database);
        await expect(
          repairGithubIdentity({
            client: fixture.client,
            expectedLogin: LOGIN,
            providerAccountId: ACCOUNT_ID,
          }),
          testCase.label,
        ).rejects.toMatchObject({
          reason: "DUPLICATE_APPLICATION_DATA",
        });
        expect(await identityRows(fixture.database), testCase.label).toEqual(before);
        await fixture.database.query(testCase.cleanup);
      }
      for (const metadata of ["comment", "reply", "suggestion", "reaction", "transition"] as const) {
        await fixture.database.query(
          `UPDATE document SET ystate = $1 WHERE id = 'legacy-document'`,
          [identityYState(metadata)],
        );
        const before = await identityRows(fixture.database);
        await expect(
          repairGithubIdentity({
            client: fixture.client,
            expectedLogin: LOGIN,
            providerAccountId: ACCOUNT_ID,
          }),
          `document.ystate ${metadata}`,
        ).rejects.toMatchObject({
          reason: "DUPLICATE_APPLICATION_DATA",
        });
        expect(await identityRows(fixture.database), metadata).toEqual(before);
        await fixture.database.query(
          `UPDATE document SET ystate = NULL WHERE id = 'legacy-document'`,
        );
      }
    } finally {
      await fixture.database.close();
    }
  }, 120_000);

  it("refuses account/login mismatches and unsafe extra authentication state", async () => {
    const mismatch = await createFixture(false);
    try {
      await expect(
        repairGithubIdentity({
          client: mismatch.client,
          expectedLogin: LOGIN,
          providerAccountId: "999999",
        }),
      ).rejects.toMatchObject({
        reason: "TARGET_ACCOUNT_COUNT",
      });
      await mismatch.database.query(
        `INSERT INTO session ("sessionToken", "userId", expires)
         VALUES ('duplicate-session-secret', $1, now() + interval '1 day')`,
        [DUPLICATE_ID],
      );
      await expect(
        repairGithubIdentity({
          client: mismatch.client,
          expectedLogin: LOGIN,
          providerAccountId: ACCOUNT_ID,
        }),
      ).rejects.toMatchObject({
        reason: "DUPLICATE_AUTH_UNSAFE",
      });
      await mismatch.database.query(
        `DELETE FROM session WHERE "userId" = $1`,
        [DUPLICATE_ID],
      );
      await mismatch.database.query(
        `INSERT INTO account ("userId", type, provider, "providerAccountId")
         VALUES ($1, 'oauth', 'other-provider', 'other-account')`,
        [DUPLICATE_ID],
      );
      await expect(
        repairGithubIdentity({
          client: mismatch.client,
          expectedLogin: LOGIN,
          providerAccountId: ACCOUNT_ID,
        }),
      ).rejects.toMatchObject({
        reason: "DUPLICATE_AUTH_UNSAFE",
      });
      await mismatch.database.query(
        `DELETE FROM account
          WHERE "userId" = $1 AND provider = 'other-provider'`,
        [DUPLICATE_ID],
      );
      await mismatch.database.query(
        `INSERT INTO "user" (id, email, login)
         VALUES ('email-conflict-user', $1, 'different-login')`,
        [PRIVATE_EMAIL.toUpperCase()],
      );
      await expect(
        repairGithubIdentity({
          client: mismatch.client,
          expectedLogin: LOGIN,
          providerAccountId: ACCOUNT_ID,
        }),
      ).rejects.toMatchObject({
        reason: "EMAIL_CONFLICT",
      });
    } finally {
      await mismatch.database.close();
    }
  }, 60_000);

  it("fails closed when state changes after apply", async () => {
    const fixture = await createFixture(false);
    const manifestPath = await newManifestPath();
    try {
      await repairGithubIdentity({
        client: fixture.client,
        expectedLogin: LOGIN,
        providerAccountId: ACCOUNT_ID,
        mode: "apply",
        manifestPath,
      });
      await fixture.database.query(
        `UPDATE account
            SET access_token = 'rotated-secret-token'
          WHERE provider = 'github' AND "providerAccountId" = $1`,
        [ACCOUNT_ID],
      );
      await expect(
        repairGithubIdentity({
          client: fixture.client,
          expectedLogin: LOGIN,
          providerAccountId: ACCOUNT_ID,
          mode: "rollback",
          manifestPath,
        }),
      ).rejects.toMatchObject({ reason: "STATE_CHANGED" });
      const account = await fixture.database.query<{ userId: string }>(
        `SELECT "userId" FROM account WHERE provider = 'github' AND "providerAccountId" = $1`,
        [ACCOUNT_ID],
      );
      expect(account.rows).toEqual([{ userId: LEGACY_ID }]);
    } finally {
      await fixture.database.close();
    }
  }, 60_000);

  it("rolls the database back on manifest staging and postcondition failures", async () => {
    const stagingFixture = await createFixture(false);
    const stagingManifest = await newManifestPath();
    const failingStore: GithubIdentityRepairManifestStore = {
      read: () => Promise.reject(new Error("not used")),
      stage: () => Promise.reject(new Error("injected manifest failure")),
      finalize: () => Promise.resolve(),
      discard: () => Promise.resolve(),
    };
    try {
      const before = await identityRows(stagingFixture.database);
      await expect(
        repairGithubIdentity({
          client: stagingFixture.client,
          expectedLogin: LOGIN,
          providerAccountId: ACCOUNT_ID,
          mode: "apply",
          manifestPath: stagingManifest,
          manifestStore: failingStore,
        }),
      ).rejects.toMatchObject({ reason: "INTERNAL" });
      expect(await identityRows(stagingFixture.database)).toEqual(before);
    } finally {
      await stagingFixture.database.close();
    }

    const postconditionFixture = await createFixture(false);
    const postconditionManifest = await newManifestPath();
    try {
      const before = await identityRows(postconditionFixture.database);
      await expect(
        repairGithubIdentity({
          client: postconditionFixture.client,
          expectedLogin: LOGIN,
          providerAccountId: ACCOUNT_ID,
          mode: "apply",
          manifestPath: postconditionManifest,
          hooks: {
            async afterMutations(client) {
              await client.query(
                `INSERT INTO "verificationToken" (identifier, token, expires)
                 VALUES ('injected', 'injected-secret', now() + interval '1 day')`,
              );
            },
          },
        }),
      ).rejects.toMatchObject({
        reason: "POSTCONDITION_FAILED",
      });
      expect(await identityRows(postconditionFixture.database)).toEqual(before);
      await expect(fs.stat(postconditionManifest)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await postconditionFixture.database.close();
    }
  }, 120_000);

  it("keeps identity inputs out of command arguments and CLI output", async () => {
    expect(parseRepairArguments([])).toBe("dry-run");
    expect(parseRepairArguments(["--apply"])).toBe("apply");
    expect(parseRepairArguments(["--verify"])).toBe("verify");
    expect(parseRepairArguments(["--rollback"])).toBe("rollback");
    expect(() => parseRepairArguments([`--login=${LOGIN}`])).toThrow(/unsupported/);
    expect(() => parseRepairArguments(["--apply", "--verify"])).toThrow(/mutually exclusive/);

    const fixture = await createFixture(false);
    const stdout: string[] = [];
    const stderr: string[] = [];
    let closed = false;
    try {
      const exitCode = await runMain([], {
        environment: {
          NODE_ENV: "test",
          DATABASE_URL: "configured-database-url",
          MARKDOC_REPAIR_LEGACY_LOGIN: LOGIN,
          MARKDOC_REPAIR_GITHUB_ACCOUNT_ID: ACCOUNT_ID,
        },
        output: {
          log: (message) => stdout.push(message),
          error: (message) => stderr.push(message),
        },
        connect: async () => ({
          client: fixture.client,
          close: async () => {
            closed = true;
          },
        }),
      });

      expect(exitCode).toBe(0);
      expect(closed).toBe(true);
      expect(stderr).toEqual([]);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        mode: "dry-run",
        committed: false,
        verified: true,
      });
      const output = `${stdout.join("\n")}\n${stderr.join("\n")}`;
      for (const sensitive of [
        "configured-database-url",
        LOGIN,
        ACCOUNT_ID,
        LEGACY_ID,
        DUPLICATE_ID,
        OAUTH_TOKEN,
        PRIVATE_EMAIL,
      ]) {
        expect(output).not.toContain(sensitive);
      }
    } finally {
      await fixture.database.close();
    }
  }, 60_000);
});

interface Fixture {
  database: PGlite;
  client: GithubIdentityRepairQueryClient;
}

async function createFixture(withApplicationRows: boolean): Promise<Fixture> {
  const database = new PGlite("memory://");
  await database.waitReady;
  await migrate(drizzle(database), { migrationsFolder: path.resolve("drizzle") });
  await database.query(
    `INSERT INTO "user" (id, name, email, "emailVerified", image, login)
     VALUES
       ($1, 'Legacy Development User', $2, NULL, NULL, $3),
       ($4, $5, $6, NULL, $7, $3)`,
    [
      LEGACY_ID,
      `${LOGIN}@dev.local`,
      LOGIN,
      DUPLICATE_ID,
      PRIVATE_NAME,
      PRIVATE_EMAIL,
      PRIVATE_IMAGE,
    ],
  );
  await database.query(
    `INSERT INTO account (
       "userId", type, provider, "providerAccountId", access_token,
       expires_at, token_type, scope
     ) VALUES ($1, 'oauth', 'github', $2, $3, 1999999999, 'bearer', 'read:user')`,
    [DUPLICATE_ID, ACCOUNT_ID, OAUTH_TOKEN],
  );
  if (withApplicationRows) await seedAllApplicationTables(database);
  return { database, client: pgliteClient(database) };
}

async function seedAllApplicationTables(database: PGlite): Promise<void> {
  await database.query(
    `INSERT INTO document (id, owner_id, last_edited_by)
     VALUES ('preserved-document', $1, $1)`,
    [LEGACY_ID],
  );
  await database.query(
    `UPDATE document SET ystate = $1 WHERE id = 'preserved-document'`,
    [identityYState("comment", LEGACY_ID)],
  );
  await database.query(
    `INSERT INTO gist_auto_update (
       document_id, publisher_id, gist_id, filename, account_login, is_public, enabled,
       acknowledged_at, generation, queued_version, synced_version, due_at, synced_at
     ) VALUES (
       'preserved-document', $1, 'fixture-gist', 'document.md', $2, false, false,
       '2026-09-01T00:00:00Z', 'preserved-generation', 3, 2,
       '2026-09-01T00:00:02Z', '2026-09-01T00:00:01Z'
     )`,
    [LEGACY_ID, LOGIN],
  );
  await database.query(
    `INSERT INTO collaborator (document_id, login, added_by)
     VALUES ('preserved-document', 'other-user', $1)`,
    [LEGACY_ID],
  );
  await database.query(
    `INSERT INTO collaborator (document_id, login, added_by)
     VALUES ('preserved-document', $1, $2)`,
    [LOGIN.toUpperCase(), LEGACY_ID],
  );
  await database.query(
    `INSERT INTO version (id, document_id, number, content, created_by)
     VALUES ('preserved-version', 'preserved-document', 1, 'private-content', $1)`,
    [LEGACY_ID],
  );
  await database.query(
    `INSERT INTO required_version_intent (
       document_id, version_id, content, content_hash, kind, created_by, created_by_name, applied
     ) VALUES (
       'preserved-document', 'pending-version', 'pending-content', 'pending-hash',
       'auto', $1, 'private author', true
     )`,
    [LEGACY_ID],
  );
  await database.query(
    `INSERT INTO star (document_id, user_id)
     VALUES ('preserved-document', $1)`,
    [LEGACY_ID],
  );
  await database.query(
    `INSERT INTO recent (user_id, document_id)
     VALUES ($1, 'preserved-document')`,
    [LEGACY_ID],
  );
  await database.query(
    `INSERT INTO api_token (id, user_id, name, prefix, token_hash)
     VALUES ('preserved-token', $1, 'private-token-name', 'mk_private', 'private-token-hash')`,
    [LEGACY_ID],
  );
  await database.query(
    `INSERT INTO asset (id, document_id, user_id, name, mime, size, sha256, data)
     VALUES ('preserved-asset', 'preserved-document', $1, 'private-name', 'text/plain', 1, 'private-sha', $2)`,
    [LEGACY_ID, Buffer.from("x")],
  );
  await database.query(
    `INSERT INTO notification (id, user_login, document_id, kind, actor_login, ref_id, snippet)
     VALUES ('preserved-notification', 'other-user', 'preserved-document', 'mention', 'another-user', 'private-ref', 'private snippet')`,
  );
  await database.query(
    `INSERT INTO notification (id, user_login, document_id, kind, actor_login, ref_id, snippet)
     VALUES
       ('preserved-login-recipient', $1, 'preserved-document', 'mention', 'another-user', 'login-recipient-ref', ''),
       ('preserved-login-actor', 'other-user', 'preserved-document', 'reply', $1, 'login-actor-ref', '')`,
    [LOGIN],
  );
  await database.query(
    `INSERT INTO activity (id, document_id, actor_id, actor_name, action, detail)
     VALUES ('preserved-activity', 'preserved-document', $1, 'private actor', 'edit', '{"private":"detail"}')`,
    [LEGACY_ID],
  );
  await database.query(
    `INSERT INTO agent_request (id, document_id, user_id, instruction)
     VALUES ('preserved-request', 'preserved-document', $1, 'private instruction')`,
    [LEGACY_ID],
  );
  await database.query(
    `INSERT INTO review (id, document_id, user_id, agent_token_id, author_name, summary)
     VALUES ('preserved-review', 'preserved-document', $1, 'preserved-token', 'private author', 'private summary')`,
    [LEGACY_ID],
  );
  await database.query(
    `INSERT INTO webhook (id, user_id, url, secret)
     VALUES ('preserved-webhook', $1, 'https://private.example.test/hook', 'private-webhook-secret')`,
    [LEGACY_ID],
  );
  await database.query(
    `INSERT INTO webhook_delivery (id, webhook_id, event, status, duration_ms)
     VALUES ('preserved-delivery', 'preserved-webhook', 'document.updated', 200, 12)`,
  );
  await database.query(
    `INSERT INTO "verificationToken" (identifier, token, expires)
     VALUES ('preserved-identifier', 'preserved-verification-secret', now() + interval '1 day')`,
  );
}

function identityYState(
  metadata: "comment" | "reply" | "suggestion" | "reaction" | "transition",
  userId = DUPLICATE_ID,
): Uint8Array {
  const document = new Y.Doc();
  try {
    if (metadata === "suggestion") {
      document.getMap("suggestions").set("suggestion", { authorId: userId });
    } else if (metadata === "transition") {
      document
        .getMap("commentSuggestionTransitions")
        .set(`agent:${userId}:token`, { actorId: userId });
    } else {
      const thread = new Y.Map<unknown>();
      if (metadata === "comment") thread.set("authorId", userId);
      if (metadata === "reply") {
        const replies = new Y.Array<Record<string, unknown>>();
        replies.push([{ authorId: userId }]);
        thread.set("replies", replies);
      }
      if (metadata === "reaction") {
        const reactions = new Y.Map<string>();
        reactions.set(`\u001f\u{1f44d}\u001f${userId}`, "User");
        thread.set("reactions", reactions);
      }
      document.getMap("comments").set("thread", thread);
    }
    return Y.encodeStateAsUpdate(document);
  } finally {
    document.destroy();
  }
}

function pgliteClient(database: PGlite): GithubIdentityRepairQueryClient {
  return {
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: T[] }> => {
      const result = await database.query<T>(text, values);
      return { rows: result.rows };
    },
  };
}

async function tableCounts(database: PGlite): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of REPAIR_SCHEMA_TABLES) {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const result = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${quoted}`,
    );
    counts[table] = Number(result.rows[0].count);
  }
  return counts;
}

async function identityRows(database: PGlite) {
  const users = await database.query<{
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
    login: string | null;
  }>(`SELECT id, name, email, image, login FROM "user" ORDER BY id`);
  const accounts = await database.query<{
    userId: string;
    provider: string;
    providerAccountId: string;
  }>(
    `SELECT "userId", provider, "providerAccountId"
       FROM account
      ORDER BY provider, "providerAccountId"`,
  );
  return { users: users.rows, accounts: accounts.rows };
}

async function newManifestPath(): Promise<string> {
  const root = path.resolve(".data", `github-identity-repair-test-${process.pid}-${randomUUID()}`);
  testRoots.push(root);
  await fs.mkdir(root, { recursive: true });
  return path.join(root, "manifest.json");
}
