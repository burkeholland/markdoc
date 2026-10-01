import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  customType,
  getTableConfig,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPLICATION_TABLES } from "../../../scripts/lib/pglite-postgres-migration";
import { seedMigrationFixture } from "./pglite-postgres-migration.test-fixture";
import * as currentSchema from "./schema";

const LEDGER_0018_TIME = "1788050213330";
const LEDGER_0019_TIME = "1788219322678";
const LEDGER_0021_TIME = "1790778877676";
const MIGRATION_TEST_TIMEOUT_MS = 60_000;
const PRE_0020_TABLES = APPLICATION_TABLES.filter((table) => table !== "gist_auto_update");

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

// Frozen to the columns used by the serving 6e251b1 source. The pending columns
// and table are deliberately absent so these queries exercise its ORM contract.
const servingDocuments = pgTable("document", {
  id: text("id").primaryKey(),
  title: text("title").notNull().default("Untitled"),
  ownerId: text("owner_id").notNull(),
  storage: text("storage").notNull().default("local"),
  ystate: bytea("ystate"),
  content: text("content").notNull().default(""),
  linkAccess: text("link_access").notNull().default("private"),
  gistId: text("gist_id"),
  gistFile: text("gist_file"),
  repoOwner: text("repo_owner"),
  repoName: text("repo_name"),
  repoBranch: text("repo_branch"),
  repoPath: text("repo_path"),
  githubSha: text("github_sha"),
  publishedContent: text("published_content"),
  publishedAt: timestamp("published_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  lastEditedBy: text("last_edited_by"),
  deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
});

const servingApiTokens = pgTable("api_token", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  mentionSlug: text("mention_slug"),
  prefix: text("prefix").notNull(),
  tokenHash: text("token_hash").notNull(),
  scope: text("scope").notNull().default("full"),
  documentIds: text("document_ids").array(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { mode: "date", withTimezone: true }),
  lastMcpSeenAt: timestamp("last_mcp_seen_at", { mode: "date", withTimezone: true }),
  lastMcpCallAt: timestamp("last_mcp_call_at", { mode: "date", withTimezone: true }),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
  revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
});

const servingAgentRequests = pgTable("agent_request", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  userId: text("user_id").notNull(),
  instruction: text("instruction").notNull(),
  selection: jsonb("selection"),
  threadId: text("thread_id"),
  mode: text("mode").notNull().default("suggest"),
  status: text("status").notNull().default("open"),
  claimedBy: text("claimed_by"),
  result: jsonb("result"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
});

const servingSchema = {
  documents: servingDocuments,
  apiTokens: servingApiTokens,
  agentRequests: servingAgentRequests,
};

interface Journal {
  entries: Array<{ idx: number }>;
}

interface DataState {
  digest: string;
  rows: number;
}

type ColumnProjection = Record<string, string[]>;

let roots: string[] = [];

afterEach(async () => {
  vi.doUnmock("@electric-sql/pglite");
  vi.doUnmock("drizzle-orm/pglite");
  vi.doUnmock("drizzle-orm/pglite/migrator");
  vi.unstubAllEnvs();
  delete (globalThis as typeof globalThis & { __markdocDb?: unknown }).__markdocDb;
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("pending production migrations", () => {
  it(
    "upgrades ledger 0018 once without data loss and keeps current and serving schemas compatible",
    async () => {
      const root = await testRoot();
      const migrations0018 = await copyMigrations(root, "through-0018", 18);
      const client = await createLedger0018(migrations0018);
      try {
        await seedMigrationFixture(client);
        const projection = await applicationColumnProjection(client);
        const before = await applicationDataState(client, projection);
        expect(before.rows).toBe(18);
        await expectLedger(client, 19, LEDGER_0018_TIME);

        const database = drizzle(client, { schema: currentSchema });
        await migrate(database, { migrationsFolder: path.resolve("drizzle") });
        await migrate(database, { migrationsFolder: path.resolve("drizzle") });

        await expectLedger(client, 22, LEDGER_0021_TIME);
        expect(await applicationDataState(client, projection)).toEqual(before);
        await expectCurrentSchema(client);
        await expectServingSourceCompatibility(client);
      } finally {
        await client.close();
      }
    },
    MIGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "rolls back one pending batch while retaining migrations committed by an earlier run",
    async () => {
      const root = await testRoot();
      const migrations0018 = await copyMigrations(root, "through-0018", 18);
      const migrations0019 = await copyMigrations(root, "through-0019", 19);
      const broken0020 = await copyMigrations(root, "broken-0020", 20);
      await appendStatement(
        path.join(broken0020, "0020_gist_auto_update.sql"),
        `ALTER TABLE "fixture_missing_table" ADD COLUMN "never_applied" text;`,
      );

      const client = await createLedger0018(migrations0018);
      try {
        await seedMigrationFixture(client);
        const projection = await applicationColumnProjection(client);
        const before = await applicationDataState(client, projection);

        await expect(migrate(drizzle(client), { migrationsFolder: broken0020 })).rejects.toThrow(
          /fixture_missing_table/,
        );
        await expectLedger(client, 19, LEDGER_0018_TIME);
        expect(await applicationDataState(client, projection)).toEqual(before);
        await expectPendingSchemaAbsent(client);

        await migrate(drizzle(client), { migrationsFolder: migrations0019 });
        await expectLedger(client, 20, LEDGER_0019_TIME);
        expect(await applicationDataState(client, projection)).toEqual(before);

        await expect(migrate(drizzle(client), { migrationsFolder: broken0020 })).rejects.toThrow(
          /fixture_missing_table/,
        );
        await expectLedger(client, 20, LEDGER_0019_TIME);
        expect(await applicationDataState(client, projection)).toEqual(before);
        await expectColumns(client, "agent_request", [
          "agent_login",
          "agent_slug",
          "claimed_by_login",
        ]);
        await expectColumns(client, "api_token", ["collaborators_may_ask"]);
        await expectRelationAbsent(client, "gist_auto_update");
      } finally {
        await client.close();
      }
    },
    MIGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "keeps candidate database readiness pending until both migrations commit",
    async () => {
      let finishMigration: (() => void) | undefined;
      const migration = new Promise<void>((resolve) => {
        finishMigration = resolve;
      });
      const migrateCandidate = vi.fn(() => migration);
      const close = vi.fn(async () => undefined);
      vi.doMock("@electric-sql/pglite", () => ({
        PGlite: class {
          readonly waitReady = Promise.resolve();
          readonly close = close;
        },
      }));
      vi.doMock("drizzle-orm/pglite", () => ({
        drizzle: () => ({ candidate: true }),
      }));
      vi.doMock("drizzle-orm/pglite/migrator", () => ({
        migrate: migrateCandidate,
      }));
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("PGLITE_DATA_DIR", "memory://");
      vi.stubEnv("DATABASE_URL", "");
      vi.resetModules();
      const database = await import("./index");
      let ready = false;
      const opening = database.getDb().then((db) => {
        ready = true;
        return db;
      });

      try {
        await vi.waitFor(() => expect(migrateCandidate).toHaveBeenCalledOnce());
        expect(ready).toBe(false);
        finishMigration?.();
        await opening;
        expect(ready).toBe(true);
      } finally {
        await database.closeDb();
      }
      expect(close).toHaveBeenCalledOnce();
    },
    MIGRATION_TEST_TIMEOUT_MS,
  );
});

async function testRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "markdoc-pending-migrations-"));
  roots.push(root);
  return root;
}

async function copyMigrations(
  root: string,
  name: string,
  maximumIndex: number,
): Promise<string> {
  const destination = path.join(root, name);
  await fs.cp(path.resolve("drizzle"), destination, { recursive: true });

  const journalPath = path.join(destination, "meta", "_journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as Journal;
  journal.entries = journal.entries.filter((entry) => entry.idx <= maximumIndex);
  await fs.writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  for (const entry of await fs.readdir(destination)) {
    const index = Number.parseInt(entry.slice(0, 4), 10);
    if (entry.endsWith(".sql") && index > maximumIndex) {
      await fs.rm(path.join(destination, entry));
    }
  }
  return destination;
}

async function appendStatement(file: string, statement: string): Promise<void> {
  await fs.appendFile(file, `\n--> statement-breakpoint\n${statement}\n`);
}

async function createLedger0018(migrationsFolder: string, dataDir = "memory://"): Promise<PGlite> {
  const client = new PGlite(dataDir);
  await client.waitReady;
  await migrate(drizzle(client), { migrationsFolder });
  await client.query(
    `ALTER TABLE "version" ALTER COLUMN "number" ADD GENERATED BY DEFAULT AS IDENTITY`,
  );
  return client;
}

async function expectLedger(
  client: PGlite,
  count: number,
  latestCreatedAt: string,
): Promise<void> {
  const result = await client.query<{ created_at: string }>(
    `SELECT created_at::text AS created_at
       FROM drizzle.__drizzle_migrations
      ORDER BY created_at`,
  );
  expect(result.rows).toHaveLength(count);
  expect(result.rows.at(-1)?.created_at).toBe(latestCreatedAt);
}

async function applicationColumnProjection(client: PGlite): Promise<ColumnProjection> {
  const result = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`,
    [PRE_0020_TABLES],
  );
  return result.rows.reduce<ColumnProjection>((projection, row) => {
    (projection[row.table_name] ??= []).push(row.column_name);
    return projection;
  }, {});
}

async function applicationDataState(
  client: PGlite,
  projection: ColumnProjection,
): Promise<DataState> {
  const digest = createHash("sha256");
  let rows = 0;
  for (const table of PRE_0020_TABLES) {
    const columns = projection[table];
    if (!columns) throw new Error(`Missing fixture projection for ${table}`);
    const selection = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(", ");
    const result = await client.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(value) AS row
         FROM (SELECT ${selection} FROM "${table}") value
        ORDER BY to_jsonb(value)::text`,
    );
    rows += result.rows.length;
    digest.update(table);
    digest.update(JSON.stringify(result.rows));
  }
  return { digest: digest.digest("hex"), rows };
}

async function expectCurrentSchema(client: PGlite): Promise<void> {
  const expectedColumns = [
    currentSchema.apiTokens,
    currentSchema.agentRequests,
    currentSchema.gistAutoUpdates,
  ]
    .flatMap((table) => {
      const config = getTableConfig(table);
      return config.columns.map((column) => ({
        table_name: config.name,
        column_name: column.name,
        data_type: column.getSQLType(),
        not_null: column.notNull,
        has_default: column.hasDefault,
      }));
    })
    .sort((left, right) =>
      `${left.table_name}.${left.column_name}`.localeCompare(
        `${right.table_name}.${right.column_name}`,
      ),
    );
  const columns = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    not_null: boolean;
    has_default: boolean;
  }>(
    `SELECT relation.relname AS table_name,
            attribute.attname AS column_name,
            format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
            attribute.attnotnull AS not_null,
            attribute.atthasdef AS has_default
       FROM pg_attribute attribute
       JOIN pg_class relation ON relation.oid = attribute.attrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname IN ('api_token', 'agent_request', 'gist_auto_update')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped`,
  );
  expect(
    columns.rows.sort((left, right) =>
      `${left.table_name}.${left.column_name}`.localeCompare(
        `${right.table_name}.${right.column_name}`,
      ),
    ),
  ).toEqual(expectedColumns);

  const expectedIndexes = [currentSchema.agentRequests, currentSchema.gistAutoUpdates]
    .flatMap((table) => getTableConfig(table).indexes.map((index) => index.config.name))
    .sort();
  const indexes = await client.query<{ indexname: string }>(
    `SELECT indexname
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'agent_request_document_status_idx',
          'agent_request_status_created_idx',
          'agent_request_document_thread_idx',
          'agent_request_agent_status_idx',
          'gist_auto_update_due_idx'
        )
      ORDER BY indexname`,
  );
  expect(indexes.rows.map((row) => row.indexname)).toEqual(expectedIndexes);

  const trigger = await client.query<{ function_name: string }>(
    `SELECT procedure.proname AS function_name
       FROM pg_trigger trigger
       JOIN pg_class relation ON relation.oid = trigger.tgrelid
       JOIN pg_proc procedure ON procedure.oid = trigger.tgfoid
      WHERE relation.relname = 'document'
        AND trigger.tgname = 'document_gist_saved'
        AND NOT trigger.tgisinternal`,
  );
  expect(trigger.rows.map((row) => row.function_name)).toEqual(["markdoc_queue_gist_save"]);

  const foreignKey = await client.query<{ constraint_name: string; delete_action: string }>(
    `SELECT constraint_entry.conname AS constraint_name,
            constraint_entry.confdeltype::text AS delete_action
       FROM pg_constraint constraint_entry
       JOIN pg_class relation ON relation.oid = constraint_entry.conrelid
      WHERE relation.relname = 'gist_auto_update'
        AND constraint_entry.conname = 'gist_auto_update_document_id_document_id_fk'`,
  );
  expect(foreignKey.rows).toEqual([
    {
      constraint_name: "gist_auto_update_document_id_document_id_fk",
      delete_action: "c",
    },
  ]);

  const linkPreview = await client.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'document'
        AND column_name = 'link_preview'`,
  );
  expect(linkPreview.rows).toEqual([{ data_type: "boolean", is_nullable: "NO", column_default: "false" }]);

  const database = drizzle(client, { schema: currentSchema });
  const [document] = await database
    .select({ linkPreview: currentSchema.documents.linkPreview })
    .from(currentSchema.documents)
    .where(eq(currentSchema.documents.id, "doc-1"));
  expect(document?.linkPreview).toBe(false);
  const [token] = await database
    .select({ collaboratorsMayAsk: currentSchema.apiTokens.collaboratorsMayAsk })
    .from(currentSchema.apiTokens)
    .where(eq(currentSchema.apiTokens.id, "api-token-1"));
  expect(token?.collaboratorsMayAsk).toBe(false);
  const [request] = await database
    .select({
      agentLogin: currentSchema.agentRequests.agentLogin,
      agentSlug: currentSchema.agentRequests.agentSlug,
      claimedByLogin: currentSchema.agentRequests.claimedByLogin,
    })
    .from(currentSchema.agentRequests)
    .where(eq(currentSchema.agentRequests.id, "request-1"));
  expect(request).toEqual({ agentLogin: null, agentSlug: null, claimedByLogin: null });
  await expect(
    client.query(
      `UPDATE api_token SET collaborators_may_ask = NULL WHERE id = 'api-token-1'`,
    ),
  ).rejects.toThrow(/not-null constraint/);
}

async function expectServingSourceCompatibility(client: PGlite): Promise<void> {
  const serving = drizzle(client, { schema: servingSchema });
  const current = drizzle(client, { schema: currentSchema });

  const [existingToken] = await serving
    .select()
    .from(servingApiTokens)
    .where(eq(servingApiTokens.id, "api-token-1"));
  const [existingRequest] = await serving
    .select()
    .from(servingAgentRequests)
    .where(eq(servingAgentRequests.id, "request-1"));
  const [existingDocument] = await serving
    .select()
    .from(servingDocuments)
    .where(eq(servingDocuments.id, "doc-1"));
  expect(existingToken?.id).toBe("api-token-1");
  expect(existingRequest?.id).toBe("request-1");
  expect(existingDocument?.id).toBe("doc-1");

  await serving.insert(servingApiTokens).values({
    id: "serving-token",
    userId: "user-1",
    name: "Serving fixture agent",
    mentionSlug: "serving-fixture-agent",
    prefix: "mk_fixture",
    tokenHash: "serving-fixture-token-hash",
  });
  const [insertedToken] = await current
    .select({ collaboratorsMayAsk: currentSchema.apiTokens.collaboratorsMayAsk })
    .from(currentSchema.apiTokens)
    .where(eq(currentSchema.apiTokens.id, "serving-token"));
  expect(insertedToken?.collaboratorsMayAsk).toBe(false);

  await serving.insert(servingAgentRequests).values({
    id: "serving-request",
    documentId: "doc-1",
    userId: "user-1",
    instruction: "Review the fixture",
    threadId: "fixture-thread",
  });
  const [insertedRequest] = await current
    .select({
      agentLogin: currentSchema.agentRequests.agentLogin,
      agentSlug: currentSchema.agentRequests.agentSlug,
      claimedByLogin: currentSchema.agentRequests.claimedByLogin,
    })
    .from(currentSchema.agentRequests)
    .where(eq(currentSchema.agentRequests.id, "serving-request"));
  expect(insertedRequest).toEqual({
    agentLogin: null,
    agentSlug: null,
    claimedByLogin: null,
  });

  await serving.insert(servingDocuments).values({
    id: "serving-gist-document",
    ownerId: "user-1",
    title: "Serving gist fixture",
    storage: "gist",
    gistId: "fixture-gist",
    gistFile: "fixture.md",
  });
  const [insertedDocument] = await current
    .select({ linkPreview: currentSchema.documents.linkPreview })
    .from(currentSchema.documents)
    .where(eq(currentSchema.documents.id, "serving-gist-document"));
  expect(insertedDocument?.linkPreview).toBe(false);
  await current.insert(currentSchema.gistAutoUpdates).values({
    documentId: "serving-gist-document",
    publisherId: "user-1",
    gistId: "fixture-gist",
    filename: "fixture.md",
    accountLogin: "fixture-login",
    isPublic: false,
    enabled: true,
    acknowledgedAt: new Date("2026-09-07T12:00:00.000Z"),
    generation: "fixture-generation",
    queuedVersion: 1,
    syncedVersion: 1,
    dueAt: new Date("2026-09-07T12:00:00.000Z"),
    status: "synced",
  });
  await serving
    .update(servingDocuments)
    .set({
      content: "# Updated by serving fixture",
      updatedAt: new Date("2026-09-07T12:01:00.000Z"),
    })
    .where(eq(servingDocuments.id, "serving-gist-document"));
  const [updatedDocument] = await serving
    .select({ content: servingDocuments.content })
    .from(servingDocuments)
    .where(eq(servingDocuments.id, "serving-gist-document"));
  const [queued] = await current
    .select({
      enabled: currentSchema.gistAutoUpdates.enabled,
      queuedVersion: currentSchema.gistAutoUpdates.queuedVersion,
      syncedVersion: currentSchema.gistAutoUpdates.syncedVersion,
      status: currentSchema.gistAutoUpdates.status,
    })
    .from(currentSchema.gistAutoUpdates)
    .where(eq(currentSchema.gistAutoUpdates.documentId, "serving-gist-document"));
  expect(updatedDocument?.content).toBe("# Updated by serving fixture");
  expect(queued).toEqual({
    enabled: true,
    queuedVersion: 2,
    syncedVersion: 1,
    status: "pending",
  });

  await serving
    .delete(servingDocuments)
    .where(eq(servingDocuments.id, "serving-gist-document"));
  const cascadeRows = await current
    .select({ documentId: currentSchema.gistAutoUpdates.documentId })
    .from(currentSchema.gistAutoUpdates)
    .where(eq(currentSchema.gistAutoUpdates.documentId, "serving-gist-document"));
  expect(cascadeRows).toHaveLength(0);
}

async function expectPendingSchemaAbsent(client: PGlite): Promise<void> {
  await expectColumnsAbsent(client, "agent_request", [
    "agent_login",
    "agent_slug",
    "claimed_by_login",
  ]);
  await expectColumnsAbsent(client, "api_token", ["collaborators_may_ask"]);
  await expectRelationAbsent(client, "gist_auto_update");
}

async function expectColumns(
  client: PGlite,
  table: string,
  expectedColumns: string[],
): Promise<void> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = ANY($2::text[])
      ORDER BY column_name`,
    [table, expectedColumns],
  );
  expect(result.rows.map((row) => row.column_name)).toEqual([...expectedColumns].sort());
}

async function expectColumnsAbsent(
  client: PGlite,
  table: string,
  columns: string[],
): Promise<void> {
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = ANY($2::text[])`,
    [table, columns],
  );
  expect(result.rows[0]?.count).toBe("0");
}

async function expectRelationAbsent(client: PGlite, relation: string): Promise<void> {
  const result = await client.query<{ relation: string | null }>(
    `SELECT to_regclass($1)::text AS relation`,
    [`public.${relation}`],
  );
  expect(result.rows[0]?.relation).toBeNull();
}
