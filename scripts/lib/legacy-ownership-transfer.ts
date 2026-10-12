import { createHash, randomUUID } from "node:crypto";
import * as Y from "yjs";
import {
  normalizeRepairGithubAccountId,
  normalizeRepairGithubLogin,
} from "./github-identity-repair";

/**
 * Ownership transfer from a legacy development-login user (`<login>@dev.local`, no account, no
 * session) to the application user behind one GitHub `account` row. Everything the legacy user owns or
 * is referenced by moves to the target, then the legacy user row is deleted. The rollback record lives
 * in the `ownership_transfer` table and is written in the same transaction as the transfer.
 *
 * Nothing here prints; the caller prints the count-only report. User ids never appear in the report.
 */

export type LegacyOwnershipTransferMode = "dry-run" | "apply" | "verify" | "rollback";

type Row = Record<string, unknown>;

export interface LegacyOwnershipTransferQueryClient {
  query<T extends Row = Row>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Every foreign key to `"user"(id)` in the Drizzle schema, `table.column`, sorted. The schema-guard test
 * derives the same list from `src/server/db/schema.ts` at test time and the tool audits the live
 * database against it, so a new user reference cannot be forgotten silently.
 */
export const TRANSFER_USER_FOREIGN_KEYS = [
  "account.userId",
  "agent_request.user_id",
  "api_token.user_id",
  "asset.user_id",
  "document.owner_id",
  "folder.owner_id",
  "recent.user_id",
  "review.user_id",
  "session.userId",
  "star.user_id",
  "webhook.user_id",
] as const;

/** Text columns that hold a user id (or an `agent:<userId>:<token>` actor id) without a foreign key. */
export const TRANSFER_SOFT_USER_REFERENCES = [
  "document.last_edited_by",
  "collaborator.added_by",
  "version.created_by",
  "activity.actor_id",
] as const;

/** Columns keyed by GitHub login rather than user id; they follow the source login to the target login. */
export const TRANSFER_LOGIN_REFERENCES = [
  "collaborator.login",
  "notification.user_login",
  "notification.actor_login",
] as const;

export const TRANSFER_COUNT_LABELS = [
  "document.owner_id moved",
  "document.last_edited_by updated",
  "version.created_by updated",
  "collaborator.added_by updated",
  "collaborator.login moved",
  "collaborator.login deduplicated",
  "collaborator.login owner_deleted",
  "star.user_id moved",
  "star.user_id deduplicated",
  "recent.user_id moved",
  "recent.user_id deduplicated",
  "api_token.user_id moved",
  "asset.user_id moved",
  "agent_request.user_id moved",
  "review.user_id moved",
  "webhook.user_id moved",
  "folder.owner_id moved",
  "activity.actor_id updated",
  "activity.actor_id agent_prefix updated",
  "notification.user_login moved",
  "notification.user_login deduplicated",
  "notification.actor_login updated",
  "document.ystate identity metadata (not rewritten)",
  "user deleted",
] as const;

export type TransferCountLabel = (typeof TRANSFER_COUNT_LABELS)[number];

export type LegacyOwnershipTransferReason =
  | "INVALID_LOGIN"
  | "INVALID_ACCOUNT_ID"
  | "INVALID_TRANSFER_ID"
  | "TRANSFER_ID_REQUIRED"
  | "SCHEMA_USER_FK_DRIFT"
  | "MIGRATION_MISSING"
  | "SOURCE_USER_COUNT"
  | "SOURCE_NOT_LEGACY"
  | "SOURCE_HAS_ACCOUNT_OR_SESSION"
  | "TARGET_ACCOUNT_COUNT"
  | "TARGET_IS_SOURCE"
  | "TARGET_LOGIN_INVALID"
  | "NOTHING_TO_TRANSFER"
  | "UNIQUE_CONFLICT"
  | "WRITE_COUNT_MISMATCH"
  | "RESIDUAL_REFERENCES"
  | "POSTCONDITION_FAILED"
  | "TRANSFER_RECORD_COUNT"
  | "TRANSFER_RECORD_INVALID"
  | "TRANSFER_BINDING_MISMATCH"
  | "TRANSFER_STATUS"
  | "STATE_CHANGED"
  | "COMMIT_OUTCOME_UNKNOWN"
  | "INTERNAL";

const REASON_MESSAGES: Record<LegacyOwnershipTransferReason, string> = {
  INVALID_LOGIN: "the source login is invalid",
  INVALID_ACCOUNT_ID: "the target GitHub account identifier is invalid",
  INVALID_TRANSFER_ID: "the transfer identifier is invalid",
  TRANSFER_ID_REQUIRED: "this operation requires --transfer-id",
  SCHEMA_USER_FK_DRIFT: "the database has user foreign keys this tool does not handle",
  MIGRATION_MISSING: "the ownership_transfer table is missing; run the application migrations first",
  SOURCE_USER_COUNT: "the source login does not select exactly one user",
  SOURCE_NOT_LEGACY: "the source user is not a legacy development-login user",
  SOURCE_HAS_ACCOUNT_OR_SESSION: "the source user has account or session rows",
  TARGET_ACCOUNT_COUNT: "the target GitHub account does not select exactly one user",
  TARGET_IS_SOURCE: "the target account belongs to the source user",
  TARGET_LOGIN_INVALID: "the target user has no usable GitHub login",
  NOTHING_TO_TRANSFER: "the source user owns no documents",
  UNIQUE_CONFLICT: "a source row would collide with a target row that cannot be deduplicated",
  WRITE_COUNT_MISMATCH: "a transfer statement affected an unexpected number of rows",
  RESIDUAL_REFERENCES: "references to the source user remain after the transfer",
  POSTCONDITION_FAILED: "transfer postconditions were not satisfied",
  TRANSFER_RECORD_COUNT: "the transfer identifier does not select exactly one rollback record",
  TRANSFER_RECORD_INVALID: "the rollback record is malformed",
  TRANSFER_BINDING_MISMATCH: "the rollback record does not match the configured identities",
  TRANSFER_STATUS: "the rollback record is not in the applied state",
  STATE_CHANGED: "a transferred row changed since the transfer was applied",
  COMMIT_OUTCOME_UNKNOWN: "the database did not confirm whether the transaction committed",
  INTERNAL: "the ownership transfer did not complete",
};

export class LegacyOwnershipTransferError extends Error {
  constructor(readonly reason: LegacyOwnershipTransferReason) {
    super(`legacy ownership transfer refused: ${REASON_MESSAGES[reason]}`);
    this.name = "LegacyOwnershipTransferError";
  }
}

/** The transfer committed but the rollback record could not be read back afterwards (exit code 2). */
export class LegacyOwnershipTransferCommittedRecordError extends Error {
  readonly committed = true;

  constructor(readonly transferId: string) {
    super("legacy ownership transfer committed, but the rollback record could not be confirmed");
    this.name = "LegacyOwnershipTransferCommittedRecordError";
  }
}

export interface LegacyOwnershipTransferHooks {
  afterMutations?(client: LegacyOwnershipTransferQueryClient): Promise<void> | void;
  beforeCommit?(): Promise<void> | void;
}

export interface LegacyOwnershipTransferOptions {
  client: LegacyOwnershipTransferQueryClient;
  sourceLogin: string;
  providerAccountId: string;
  mode?: LegacyOwnershipTransferMode;
  transferId?: string;
  hooks?: LegacyOwnershipTransferHooks;
}

export interface LegacyOwnershipTransferReport {
  mode: LegacyOwnershipTransferMode;
  committed: boolean;
  verified: boolean;
  transferId: string | null;
  schema: {
    userForeignKeys: number;
    softUserReferences: number;
    loginReferences: number;
    rollbackTableReady: boolean;
  };
  selection: {
    sourceUsers: number;
    sourceLoginLength: number;
    sourceIsLegacy: boolean;
    sourceAccounts: number;
    sourceSessions: number;
    targetAccounts: number;
    targetLoginLength: number;
    targetIsSource: boolean;
    sameLogin: boolean;
  };
  documents: {
    sourceBefore: number;
    targetBefore: number;
    targetAfter: number;
  };
  operations: Record<TransferCountLabel, number>;
  residualReferences: number;
  rollbackRecordRows: number;
}

interface UserRow extends Row {
  id: string;
  name: string | null;
  email: string | null;
  email_verified: string | null;
  image: string | null;
  login: string | null;
}

interface Selection {
  source: UserRow;
  target: UserRow;
  sourceLogin: string;
  targetLogin: string;
  sourceAccounts: number;
  sourceSessions: number;
  sourceDocuments: number;
  targetDocuments: number;
}

type Key = Record<string, string>;

interface UpdateEntry {
  kind: "update";
  table: string;
  key: Key;
  postKey: Key;
  column: string;
  before: string | null;
  after: string | null;
  label: TransferCountLabel;
}

interface DeleteEntry {
  kind: "delete";
  table: string;
  key: Key;
  row: Row;
  label: TransferCountLabel;
}

type PlanEntry = UpdateEntry | DeleteEntry;

interface Plan {
  entries: PlanEntry[];
  operations: Record<TransferCountLabel, number>;
}

interface RowFingerprint {
  table: string;
  key: Key;
  sha256: string;
}

interface RollbackRecord {
  id: string;
  status: string;
  sourceUser: UserRow;
  entries: PlanEntry[];
  fingerprints: RowFingerprint[];
  binding: {
    sourceLogin: string;
    targetUserId: string;
    targetLogin: string;
    providerAccountIdSha256: string;
  };
}

const TRANSFER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const USER_SELECT = `SELECT id, name, email, "emailVerified"::text AS email_verified, image, login FROM "user"`;

export function normalizeTransferId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return TRANSFER_ID_PATTERN.test(normalized) ? normalized : null;
}

export async function transferLegacyOwnership(
  options: LegacyOwnershipTransferOptions,
): Promise<LegacyOwnershipTransferReport> {
  const mode = options.mode ?? "dry-run";
  const sourceLogin = normalizeRepairGithubLogin(options.sourceLogin);
  if (!sourceLogin) throw new LegacyOwnershipTransferError("INVALID_LOGIN");
  const providerAccountId = normalizeRepairGithubAccountId(options.providerAccountId);
  if (!providerAccountId) throw new LegacyOwnershipTransferError("INVALID_ACCOUNT_ID");
  let transferId: string | undefined;
  if (options.transferId !== undefined) {
    const normalized = normalizeTransferId(options.transferId);
    if (!normalized) throw new LegacyOwnershipTransferError("INVALID_TRANSFER_ID");
    transferId = normalized;
  }
  if (mode === "rollback" && !transferId) throw new LegacyOwnershipTransferError("TRANSFER_ID_REQUIRED");

  const { client } = options;
  let began = false;
  let commitAttempted = false;
  let committed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    began = true;
    // Row fingerprints and the rollback record render timestamps through to_jsonb; pin the session
    // time zone so apply, verify and rollback agree byte for byte whatever the server default is.
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await acquireLocks(client, [`legacy-transfer-login:${sourceLogin}`, `legacy-transfer-account:${providerAccountId}`]);
    await auditUserForeignKeys(client);
    const rollbackTableReady = await hasRollbackTable(client);

    if (mode === "verify" || mode === "rollback") {
      if (!rollbackTableReady) throw new LegacyOwnershipTransferError("MIGRATION_MISSING");
      const record = await loadRollbackRecord(client, transferId, sourceLogin, providerAccountId);
      if (record.status !== "applied") throw new LegacyOwnershipTransferError("TRANSFER_STATUS");
      const target = await getUser(client, record.binding.targetUserId, true);
      if (!target) throw new LegacyOwnershipTransferError("TRANSFER_BINDING_MISMATCH");
      await acquireLocks(client, [record.sourceUser.id, target.id].sort().map((id) => `legacy-transfer-user:${id}`));
      const residual = await countResidualReferences(client, record.sourceUser.id, sourceLogin, record.binding.targetLogin);
      const targetDocuments = await countWhere(client, `SELECT COUNT(*)::text AS count FROM document WHERE owner_id = $1`, [target.id]);
      await assertPostApplyState(client, record);
      const operations = countOperations(record.entries);
      const baseReport: LegacyOwnershipTransferReport = {
        mode,
        committed: false,
        verified: true,
        transferId: record.id,
        schema: schemaSummary(true),
        selection: {
          sourceUsers: 0,
          sourceLoginLength: sourceLogin.length,
          sourceIsLegacy: true,
          sourceAccounts: 0,
          sourceSessions: 0,
          targetAccounts: 1,
          targetLoginLength: record.binding.targetLogin.length,
          targetIsSource: false,
          sameLogin: sourceLogin === record.binding.targetLogin,
        },
        documents: { sourceBefore: 0, targetBefore: targetDocuments, targetAfter: targetDocuments },
        operations,
        residualReferences: residual,
        rollbackRecordRows: record.entries.length,
      };
      if (mode === "verify") {
        if (residual !== 0) throw new LegacyOwnershipTransferError("POSTCONDITION_FAILED");
        await client.query("ROLLBACK");
        began = false;
        return baseReport;
      }

      await restoreFromRecord(client, record);
      await options.hooks?.afterMutations?.(client);
      await assertRestoredState(client, record);
      const restoredSourceDocuments = await countWhere(client, `SELECT COUNT(*)::text AS count FROM document WHERE owner_id = $1`, [record.sourceUser.id]);
      const restoredTargetDocuments = await countWhere(client, `SELECT COUNT(*)::text AS count FROM document WHERE owner_id = $1`, [target.id]);
      await expectRows(client, `UPDATE ownership_transfer SET status = 'rolled_back' WHERE id = $1 AND status = 'applied' RETURNING id`, [record.id], 1);
      await options.hooks?.beforeCommit?.();
      commitAttempted = true;
      await client.query("COMMIT");
      committed = true;
      began = false;
      return {
        ...baseReport,
        committed: true,
        documents: { sourceBefore: restoredSourceDocuments, targetBefore: targetDocuments, targetAfter: restoredTargetDocuments },
      };
    }

    if (mode === "apply" && !rollbackTableReady) throw new LegacyOwnershipTransferError("MIGRATION_MISSING");
    const selection = await selectAndValidate(client, sourceLogin, providerAccountId);
    await acquireLocks(client, [selection.source.id, selection.target.id].sort().map((id) => `legacy-transfer-user:${id}`));
    const plan = await buildPlan(client, selection);
    const ystateReferences = await countDocumentIdentityReferences(client, selection.source.id);
    plan.operations["document.ystate identity metadata (not rewritten)"] = ystateReferences;
    plan.operations["user deleted"] = 1;

    const report: LegacyOwnershipTransferReport = {
      mode,
      committed: false,
      verified: true,
      transferId: null,
      schema: schemaSummary(rollbackTableReady),
      selection: {
        sourceUsers: 1,
        sourceLoginLength: sourceLogin.length,
        sourceIsLegacy: true,
        sourceAccounts: selection.sourceAccounts,
        sourceSessions: selection.sourceSessions,
        targetAccounts: 1,
        targetLoginLength: selection.targetLogin.length,
        targetIsSource: false,
        sameLogin: selection.sourceLogin === selection.targetLogin,
      },
      documents: {
        sourceBefore: selection.sourceDocuments,
        targetBefore: selection.targetDocuments,
        targetAfter: selection.targetDocuments + selection.sourceDocuments,
      },
      operations: plan.operations,
      residualReferences: 0,
      rollbackRecordRows: plan.entries.length,
    };

    if (mode === "dry-run") {
      await client.query("ROLLBACK");
      began = false;
      return report;
    }

    await executePlan(client, plan);
    await expectRows(client, `DELETE FROM "user" WHERE id = $1 RETURNING id`, [selection.source.id], 1);
    await options.hooks?.afterMutations?.(client);
    const residual = await countResidualReferences(client, selection.source.id, selection.sourceLogin, selection.targetLogin);
    if (residual !== 0) throw new LegacyOwnershipTransferError("RESIDUAL_REFERENCES");
    const targetAfter = await countWhere(client, `SELECT COUNT(*)::text AS count FROM document WHERE owner_id = $1`, [selection.target.id]);
    if (targetAfter !== selection.targetDocuments + selection.sourceDocuments) {
      throw new LegacyOwnershipTransferError("POSTCONDITION_FAILED");
    }
    const sourceRemaining = await countWhere(client, `SELECT COUNT(*)::text AS count FROM "user" WHERE id = $1`, [selection.source.id]);
    if (sourceRemaining !== 0) throw new LegacyOwnershipTransferError("POSTCONDITION_FAILED");

    const fingerprints = await fingerprintTouchedRows(client, plan.entries);
    const newTransferId = randomUUID();
    const record: RollbackRecord = {
      id: newTransferId,
      status: "applied",
      sourceUser: selection.source,
      entries: plan.entries,
      fingerprints,
      binding: {
        sourceLogin: selection.sourceLogin,
        targetUserId: selection.target.id,
        targetLogin: selection.targetLogin,
        providerAccountIdSha256: sha256(`account\0${providerAccountId}`),
      },
    };
    await expectRows(
      client,
      `INSERT INTO ownership_transfer (id, source_user_json, moved_rows_json, post_fingerprints_json, status)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, 'applied')
       RETURNING id`,
      [
        newTransferId,
        JSON.stringify(record.sourceUser),
        JSON.stringify(record.entries),
        JSON.stringify({ fingerprints: record.fingerprints, binding: record.binding }),
      ],
      1,
    );

    await options.hooks?.beforeCommit?.();
    commitAttempted = true;
    await client.query("COMMIT");
    committed = true;
    began = false;

    let confirmed: { rows: Row[] };
    try {
      confirmed = await client.query(`SELECT id FROM ownership_transfer WHERE id = $1 AND status = 'applied'`, [newTransferId]);
    } catch {
      throw new LegacyOwnershipTransferCommittedRecordError(newTransferId);
    }
    if (confirmed.rows.length !== 1) throw new LegacyOwnershipTransferCommittedRecordError(newTransferId);
    return { ...report, committed: true, transferId: newTransferId, documents: { ...report.documents, targetAfter } };
  } catch (error) {
    if (began && !commitAttempted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        throw new LegacyOwnershipTransferError("INTERNAL");
      }
    }
    if (commitAttempted && !committed) throw new LegacyOwnershipTransferError("COMMIT_OUTCOME_UNKNOWN");
    if (error instanceof LegacyOwnershipTransferError || error instanceof LegacyOwnershipTransferCommittedRecordError) {
      throw error;
    }
    throw new LegacyOwnershipTransferError("INTERNAL");
  }
}

function schemaSummary(rollbackTableReady: boolean): LegacyOwnershipTransferReport["schema"] {
  return {
    userForeignKeys: TRANSFER_USER_FOREIGN_KEYS.length,
    softUserReferences: TRANSFER_SOFT_USER_REFERENCES.length,
    loginReferences: TRANSFER_LOGIN_REFERENCES.length,
    rollbackTableReady,
  };
}

async function acquireLocks(client: LegacyOwnershipTransferQueryClient, names: string[]): Promise<void> {
  for (const name of [...names].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [name]);
  }
}

/** The live database must have exactly the user foreign keys this tool knows how to move. */
async function auditUserForeignKeys(client: LegacyOwnershipTransferQueryClient): Promise<void> {
  const result = await client.query<{ table_name: string; column_name: string }>(
    `SELECT kcu.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_catalog = tc.constraint_catalog
        AND kcu.constraint_schema = tc.constraint_schema
        AND kcu.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_catalog = tc.constraint_catalog
        AND ccu.constraint_schema = tc.constraint_schema
        AND ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = current_schema()
        AND ccu.table_schema = current_schema()
        AND ccu.table_name = 'user'
        AND ccu.column_name = 'id'
      ORDER BY kcu.table_name, kcu.column_name`,
  );
  const actual = result.rows.map((row) => `${row.table_name}.${row.column_name}`).sort();
  if (actual.join("\0") !== [...TRANSFER_USER_FOREIGN_KEYS].sort().join("\0")) {
    throw new LegacyOwnershipTransferError("SCHEMA_USER_FK_DRIFT");
  }
}

async function hasRollbackTable(client: LegacyOwnershipTransferQueryClient): Promise<boolean> {
  const tables = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'ownership_transfer' AND table_type = 'BASE TABLE'`,
  );
  if (parseCount(tables.rows[0]?.count) !== 1) return false;
  const columns = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'ownership_transfer'
      ORDER BY column_name`,
  );
  const expected = ["created_at", "id", "moved_rows_json", "post_fingerprints_json", "source_user_json", "status"];
  return columns.rows.map((row) => row.column_name).join("\0") === expected.join("\0");
}

async function selectAndValidate(
  client: LegacyOwnershipTransferQueryClient,
  sourceLogin: string,
  providerAccountId: string,
): Promise<Selection> {
  const sources = await client.query<UserRow>(`${USER_SELECT} WHERE lower(btrim(login)) = $1 ORDER BY id FOR UPDATE`, [sourceLogin]);
  if (sources.rows.length !== 1) throw new LegacyOwnershipTransferError("SOURCE_USER_COUNT");
  const source = sources.rows[0];
  if (source.email?.trim().toLowerCase() !== `${sourceLogin}@dev.local` || source.email_verified !== null) {
    throw new LegacyOwnershipTransferError("SOURCE_NOT_LEGACY");
  }
  const accounts = await client.query<{ user_id: string }>(
    `SELECT "userId" AS user_id FROM account WHERE provider = 'github' AND "providerAccountId" = $1 FOR UPDATE`,
    [providerAccountId],
  );
  if (accounts.rows.length !== 1) throw new LegacyOwnershipTransferError("TARGET_ACCOUNT_COUNT");
  if (accounts.rows[0].user_id === source.id) throw new LegacyOwnershipTransferError("TARGET_IS_SOURCE");
  const target = await getUser(client, accounts.rows[0].user_id, true);
  if (!target) throw new LegacyOwnershipTransferError("TARGET_ACCOUNT_COUNT");
  const targetLogin = normalizeRepairGithubLogin(target.login);
  if (!targetLogin) throw new LegacyOwnershipTransferError("TARGET_LOGIN_INVALID");

  const sourceAccounts = await countWhere(client, `SELECT COUNT(*)::text AS count FROM account WHERE "userId" = $1`, [source.id]);
  const sourceSessions = await countWhere(client, `SELECT COUNT(*)::text AS count FROM session WHERE "userId" = $1`, [source.id]);
  if (sourceAccounts !== 0 || sourceSessions !== 0) throw new LegacyOwnershipTransferError("SOURCE_HAS_ACCOUNT_OR_SESSION");

  const documents = await client.query<{ id: string }>(`SELECT id FROM document WHERE owner_id = $1 ORDER BY id FOR UPDATE`, [source.id]);
  if (documents.rows.length === 0) throw new LegacyOwnershipTransferError("NOTHING_TO_TRANSFER");
  const targetDocuments = await countWhere(client, `SELECT COUNT(*)::text AS count FROM document WHERE owner_id = $1`, [target.id]);

  return {
    source,
    target,
    sourceLogin,
    targetLogin,
    sourceAccounts,
    sourceSessions,
    sourceDocuments: documents.rows.length,
    targetDocuments,
  };
}

async function getUser(client: LegacyOwnershipTransferQueryClient, id: string, forUpdate: boolean): Promise<UserRow | null> {
  const result = await client.query<UserRow>(`${USER_SELECT} WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [id]);
  return result.rows.length === 1 ? result.rows[0] : null;
}

async function buildPlan(client: LegacyOwnershipTransferQueryClient, selection: Selection): Promise<Plan> {
  const { source, target, sourceLogin, targetLogin } = selection;
  const entries: PlanEntry[] = [];
  const operations = emptyOperations();
  const add = (entry: PlanEntry) => {
    entries.push(entry);
    operations[entry.label] += 1;
  };
  const update = (table: string, key: Key, column: string, before: string | null, after: string | null, label: TransferCountLabel) => {
    const postKey = { ...key };
    if (column in postKey && after !== null) postKey[column] = after;
    add({ kind: "update", table, key, postKey, column, before, after, label });
  };

  // Rows keyed only by user: straight moves.
  const simpleMoves: Array<{ table: string; column: string; label: TransferCountLabel }> = [
    { table: "document", column: "owner_id", label: "document.owner_id moved" },
    { table: "api_token", column: "user_id", label: "api_token.user_id moved" },
    { table: "asset", column: "user_id", label: "asset.user_id moved" },
    { table: "agent_request", column: "user_id", label: "agent_request.user_id moved" },
    { table: "review", column: "user_id", label: "review.user_id moved" },
    { table: "webhook", column: "user_id", label: "webhook.user_id moved" },
    { table: "folder", column: "owner_id", label: "folder.owner_id moved" },
  ];
  for (const move of simpleMoves) {
    const rows = await client.query<{ id: string }>(`SELECT id FROM ${quote(move.table)} WHERE ${quote(move.column)} = $1 ORDER BY id`, [source.id]);
    for (const row of rows.rows) update(move.table, { id: row.id }, move.column, source.id, target.id, move.label);
  }
  const slugConflicts = await countWhere(
    client,
    `SELECT COUNT(*)::text AS count
       FROM api_token s JOIN api_token t ON t.mention_slug = s.mention_slug AND t.user_id = $2
      WHERE s.user_id = $1 AND s.mention_slug IS NOT NULL`,
    [source.id, target.id],
  );
  if (slugConflicts !== 0) throw new LegacyOwnershipTransferError("UNIQUE_CONFLICT");

  // folder_owner_name_idx is unique on (owner_id, lower(name)), so a folder name both people use
  // would collide the moment the source's folders change hands. Refuse before writing anything,
  // the same way a mention-slug collision is refused above.
  const folderNameConflicts = await countWhere(
    client,
    `SELECT COUNT(*)::text AS count
       FROM folder s JOIN folder t ON lower(t.name) = lower(s.name) AND t.owner_id = $2
      WHERE s.owner_id = $1`,
    [source.id, target.id],
  );
  if (folderNameConflicts !== 0) throw new LegacyOwnershipTransferError("UNIQUE_CONFLICT");

  // Soft user-id references.
  const softUpdates: Array<{ table: string; column: string; label: TransferCountLabel }> = [
    { table: "document", column: "last_edited_by", label: "document.last_edited_by updated" },
    { table: "version", column: "created_by", label: "version.created_by updated" },
  ];
  for (const soft of softUpdates) {
    const rows = await client.query<{ id: string }>(`SELECT id FROM ${quote(soft.table)} WHERE ${quote(soft.column)} = $1 ORDER BY id`, [source.id]);
    for (const row of rows.rows) update(soft.table, { id: row.id }, soft.column, source.id, target.id, soft.label);
  }
  const actors = await client.query<{ id: string; actor_id: string }>(
    `SELECT id, actor_id FROM activity WHERE actor_id = $1 OR position(('agent:' || $1 || ':') in actor_id) = 1 ORDER BY id`,
    [source.id],
  );
  for (const row of actors.rows) {
    if (row.actor_id === source.id) {
      update("activity", { id: row.id }, "actor_id", row.actor_id, target.id, "activity.actor_id updated");
    } else {
      const suffix = row.actor_id.slice(`agent:${source.id}:`.length);
      update("activity", { id: row.id }, "actor_id", row.actor_id, `agent:${target.id}:${suffix}`, "activity.actor_id agent_prefix updated");
    }
  }

  // (document, user) keyed rows: move unless the target already has one for the same document. Rows that
  // will be deleted are captured as PostgreSQL renders them (to_jsonb) so jsonb_populate_record restores
  // them exactly, microseconds included; a driver-side Date would truncate timestamps to milliseconds.
  const stars = await client.query<{ row: Row; document_id: string }>(`SELECT to_jsonb(s) AS row, s.document_id FROM star s WHERE s.user_id = $1 ORDER BY s.document_id`, [source.id]);
  for (const { row, document_id: documentId } of stars.rows) {
    const duplicate = await countWhere(client, `SELECT COUNT(*)::text AS count FROM star WHERE document_id = $1 AND user_id = $2`, [documentId, target.id]);
    if (duplicate) add({ kind: "delete", table: "star", key: { document_id: documentId, user_id: source.id }, row, label: "star.user_id deduplicated" });
    else update("star", { document_id: documentId, user_id: source.id }, "user_id", source.id, target.id, "star.user_id moved");
  }
  const recents = await client.query<{ row: Row; document_id: string }>(`SELECT to_jsonb(r) AS row, r.document_id FROM recent r WHERE r.user_id = $1 ORDER BY r.document_id`, [source.id]);
  for (const { row, document_id: documentId } of recents.rows) {
    const duplicate = await countWhere(client, `SELECT COUNT(*)::text AS count FROM recent WHERE document_id = $1 AND user_id = $2`, [documentId, target.id]);
    if (duplicate) add({ kind: "delete", table: "recent", key: { user_id: source.id, document_id: documentId }, row, label: "recent.user_id deduplicated" });
    else update("recent", { user_id: source.id, document_id: documentId }, "user_id", source.id, target.id, "recent.user_id moved");
  }

  // Login-keyed rows follow the login. When both users share a login nothing needs to move.
  const deletedCollaborators = new Set<string>();
  const movedCollaborators = new Map<string, string>();
  const collaboratorKey = (documentId: string, login: string) => `${documentId}\0${login}`;
  if (sourceLogin !== targetLogin) {
    const collaborators = await client.query<{ row: Row; document_id: string; login: string; owner_id: string }>(
      `SELECT to_jsonb(c) AS row, c.document_id, c.login, d.owner_id FROM collaborator c JOIN document d ON d.id = c.document_id
        WHERE lower(btrim(c.login)) = $1 ORDER BY c.document_id, c.login`,
      [sourceLogin],
    );
    for (const { row, document_id: documentId, login, owner_id: ownerId } of collaborators.rows) {
      const key = { document_id: documentId, login };
      if (ownerId === target.id || ownerId === source.id) {
        add({ kind: "delete", table: "collaborator", key, row, label: "collaborator.login owner_deleted" });
        deletedCollaborators.add(collaboratorKey(documentId, login));
        continue;
      }
      const duplicate = await countWhere(
        client,
        `SELECT COUNT(*)::text AS count FROM collaborator WHERE document_id = $1 AND lower(btrim(login)) = $2`,
        [documentId, targetLogin],
      );
      if (duplicate) {
        add({ kind: "delete", table: "collaborator", key, row, label: "collaborator.login deduplicated" });
        deletedCollaborators.add(collaboratorKey(documentId, login));
      } else {
        update("collaborator", key, "login", login, targetLogin, "collaborator.login moved");
        movedCollaborators.set(collaboratorKey(documentId, login), targetLogin);
      }
    }
    // The target becomes the owner of every source document: an owner is never their own collaborator.
    const ownerRows = await client.query<{ row: Row; document_id: string; login: string }>(
      `SELECT to_jsonb(c) AS row, c.document_id, c.login FROM collaborator c JOIN document d ON d.id = c.document_id
        WHERE d.owner_id = $1 AND lower(btrim(c.login)) = $2 ORDER BY c.document_id, c.login`,
      [source.id, targetLogin],
    );
    for (const { row, document_id: documentId, login } of ownerRows.rows) {
      add({ kind: "delete", table: "collaborator", key: { document_id: documentId, login }, row, label: "collaborator.login owner_deleted" });
      deletedCollaborators.add(collaboratorKey(documentId, login));
    }

    const notifications = await client.query<{ row: Row; id: string; kind: string; ref_id: string; user_login: string }>(
      `SELECT to_jsonb(n) AS row, n.id, n.kind, n.ref_id, n.user_login FROM notification n WHERE lower(btrim(n.user_login)) = $1 ORDER BY n.id`,
      [sourceLogin],
    );
    for (const { row, id, kind, ref_id: refId, user_login: userLogin } of notifications.rows) {
      const duplicate = await countWhere(
        client,
        `SELECT COUNT(*)::text AS count FROM notification WHERE lower(btrim(user_login)) = $1 AND kind = $2 AND ref_id = $3`,
        [targetLogin, kind, refId],
      );
      if (duplicate) add({ kind: "delete", table: "notification", key: { id }, row, label: "notification.user_login deduplicated" });
      else update("notification", { id }, "user_login", userLogin, targetLogin, "notification.user_login moved");
    }
    const actorLogins = await client.query<{ id: string; actor_login: string }>(
      `SELECT id, actor_login FROM notification WHERE lower(btrim(actor_login)) = $1 ORDER BY id`,
      [sourceLogin],
    );
    for (const row of actorLogins.rows) {
      update("notification", { id: row.id }, "actor_login", row.actor_login, targetLogin, "notification.actor_login updated");
    }
  }

  // collaborator.added_by comes last: a row that is deleted above needs no update, and a row whose login
  // moved above is addressed by its new login (the entry runs after the move and is reversed before it).
  const addedBy = await client.query<{ document_id: string; login: string }>(
    `SELECT document_id, login FROM collaborator WHERE added_by = $1 ORDER BY document_id, login`,
    [source.id],
  );
  for (const row of addedBy.rows) {
    const identity = collaboratorKey(row.document_id, row.login);
    if (deletedCollaborators.has(identity)) continue;
    const login = movedCollaborators.get(identity) ?? row.login;
    update("collaborator", { document_id: row.document_id, login }, "added_by", source.id, target.id, "collaborator.added_by updated");
  }

  return { entries, operations };
}

async function executePlan(client: LegacyOwnershipTransferQueryClient, plan: Plan): Promise<void> {
  // Deletes first so a moved (document, user) row never collides with the duplicate it replaces.
  for (const entry of plan.entries) {
    if (entry.kind !== "delete") continue;
    const where = whereClause(entry.key, 1);
    await expectRows(client, `DELETE FROM ${quote(entry.table)} WHERE ${where.text} RETURNING 1 AS id`, where.values, 1);
  }
  for (const entry of plan.entries) {
    if (entry.kind !== "update") continue;
    const where = whereClause(entry.key, 2);
    await expectRows(
      client,
      `UPDATE ${quote(entry.table)} SET ${quote(entry.column)} = $1
        WHERE ${where.text} AND ${quote(entry.column)} IS NOT DISTINCT FROM $${where.values.length + 2}
        RETURNING 1 AS id`,
      [entry.after, ...where.values, entry.before],
      1,
    );
  }
}

async function fingerprintTouchedRows(client: LegacyOwnershipTransferQueryClient, entries: PlanEntry[]): Promise<RowFingerprint[]> {
  const seen = new Set<string>();
  const fingerprints: RowFingerprint[] = [];
  for (const entry of entries) {
    if (entry.kind !== "update") continue;
    const identity = `${entry.table}\0${canonicalJson(entry.postKey)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    fingerprints.push({ table: entry.table, key: entry.postKey, sha256: await rowFingerprint(client, entry.table, entry.postKey) });
  }
  return fingerprints;
}

async function rowFingerprint(client: LegacyOwnershipTransferQueryClient, table: string, key: Key): Promise<string> {
  const where = whereClause(key, 1);
  const result = await client.query<{ row: Row }>(`SELECT to_jsonb(t) AS row FROM ${quote(table)} t WHERE ${where.text}`, where.values);
  if (result.rows.length !== 1) throw new LegacyOwnershipTransferError("POSTCONDITION_FAILED");
  return sha256(canonicalJson(result.rows[0].row));
}

async function loadRollbackRecord(
  client: LegacyOwnershipTransferQueryClient,
  transferId: string | undefined,
  sourceLogin: string,
  providerAccountId: string,
): Promise<RollbackRecord> {
  const rows = await client.query<{ id: string; status: string; source_user_json: unknown; moved_rows_json: unknown; post_fingerprints_json: unknown }>(
    transferId
      ? `SELECT id, status, source_user_json, moved_rows_json, post_fingerprints_json FROM ownership_transfer WHERE id = $1 FOR UPDATE`
      : `SELECT id, status, source_user_json, moved_rows_json, post_fingerprints_json FROM ownership_transfer
          WHERE status = 'applied' AND lower(btrim(source_user_json->>'login')) = $1 FOR UPDATE`,
    [transferId ?? sourceLogin],
  );
  if (rows.rows.length !== 1) throw new LegacyOwnershipTransferError("TRANSFER_RECORD_COUNT");
  const row = rows.rows[0];
  const record = parseRollbackRecord(row);
  if (
    record.binding.sourceLogin !== sourceLogin ||
    normalizeRepairGithubLogin(record.sourceUser.login) !== sourceLogin ||
    record.binding.providerAccountIdSha256 !== sha256(`account\0${providerAccountId}`)
  ) {
    throw new LegacyOwnershipTransferError("TRANSFER_BINDING_MISMATCH");
  }
  const account = await client.query<{ user_id: string }>(
    `SELECT "userId" AS user_id FROM account WHERE provider = 'github' AND "providerAccountId" = $1 FOR UPDATE`,
    [providerAccountId],
  );
  if (account.rows.length !== 1 || account.rows[0].user_id !== record.binding.targetUserId) {
    throw new LegacyOwnershipTransferError("TRANSFER_BINDING_MISMATCH");
  }
  return record;
}

function parseRollbackRecord(row: { id: string; status: string; source_user_json: unknown; moved_rows_json: unknown; post_fingerprints_json: unknown }): RollbackRecord {
  const sourceUser = row.source_user_json;
  const entries = row.moved_rows_json;
  const post = row.post_fingerprints_json;
  if (
    !isUserRow(sourceUser) ||
    !Array.isArray(entries) ||
    !entries.every(isPlanEntry) ||
    !isRecord(post) ||
    !Array.isArray(post.fingerprints) ||
    !post.fingerprints.every(isRowFingerprint) ||
    !isBinding(post.binding)
  ) {
    throw new LegacyOwnershipTransferError("TRANSFER_RECORD_INVALID");
  }
  return { id: row.id, status: row.status, sourceUser, entries, fingerprints: post.fingerprints, binding: post.binding };
}

/** Every touched row must still look exactly as it did right after apply, and the source user must be gone. */
async function assertPostApplyState(client: LegacyOwnershipTransferQueryClient, record: RollbackRecord): Promise<void> {
  const sourceExists = await countWhere(client, `SELECT COUNT(*)::text AS count FROM "user" WHERE id = $1`, [record.sourceUser.id]);
  if (sourceExists !== 0) throw new LegacyOwnershipTransferError("STATE_CHANGED");
  for (const fingerprint of record.fingerprints) {
    let current: string;
    try {
      current = await rowFingerprint(client, fingerprint.table, fingerprint.key);
    } catch {
      throw new LegacyOwnershipTransferError("STATE_CHANGED");
    }
    if (current !== fingerprint.sha256) throw new LegacyOwnershipTransferError("STATE_CHANGED");
  }
  for (const entry of record.entries) {
    if (entry.kind !== "delete") continue;
    const where = whereClause(entry.key, 1);
    const present = await countWhere(client, `SELECT COUNT(*)::text AS count FROM ${quote(entry.table)} WHERE ${where.text}`, where.values);
    if (present !== 0) throw new LegacyOwnershipTransferError("STATE_CHANGED");
  }
}

async function restoreFromRecord(client: LegacyOwnershipTransferQueryClient, record: RollbackRecord): Promise<void> {
  const user = record.sourceUser;
  await expectRows(
    client,
    `INSERT INTO "user" (id, name, email, "emailVerified", image, login)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6) RETURNING id`,
    [user.id, user.name, user.email, user.email_verified, user.image, user.login],
    1,
  );
  for (const entry of [...record.entries].reverse()) {
    if (entry.kind !== "update") continue;
    const where = whereClause(entry.postKey, 2);
    await expectRows(
      client,
      `UPDATE ${quote(entry.table)} SET ${quote(entry.column)} = $1
        WHERE ${where.text} AND ${quote(entry.column)} IS NOT DISTINCT FROM $${where.values.length + 2}
        RETURNING 1 AS id`,
      [entry.before, ...where.values, entry.after],
      1,
    );
  }
  for (const entry of [...record.entries].reverse()) {
    if (entry.kind !== "delete") continue;
    await expectRows(
      client,
      `INSERT INTO ${quote(entry.table)} SELECT * FROM jsonb_populate_record(NULL::${quote(entry.table)}, $1::jsonb) RETURNING 1 AS id`,
      [JSON.stringify(entry.row)],
      1,
    );
  }
}

async function assertRestoredState(client: LegacyOwnershipTransferQueryClient, record: RollbackRecord): Promise<void> {
  const sourceExists = await countWhere(client, `SELECT COUNT(*)::text AS count FROM "user" WHERE id = $1`, [record.sourceUser.id]);
  if (sourceExists !== 1) throw new LegacyOwnershipTransferError("POSTCONDITION_FAILED");
  // Entries that chain on one row share a post-apply key; the first entry of the chain holds the original key.
  const originalKeys = new Map<string, { table: string; key: Key }>();
  for (const entry of record.entries) {
    const identity = `${entry.table}\0${canonicalJson(entry.kind === "update" ? entry.postKey : entry.key)}`;
    if (!originalKeys.has(identity)) originalKeys.set(identity, { table: entry.table, key: entry.key });
  }
  for (const { table, key } of originalKeys.values()) {
    const where = whereClause(key, 1);
    const present = await countWhere(client, `SELECT COUNT(*)::text AS count FROM ${quote(table)} WHERE ${where.text}`, where.values);
    if (present !== 1) throw new LegacyOwnershipTransferError("POSTCONDITION_FAILED");
  }
}

/** Every column that could still name the source user or its login; must be zero after apply. */
async function countResidualReferences(
  client: LegacyOwnershipTransferQueryClient,
  sourceId: string,
  sourceLogin: string,
  targetLogin: string,
): Promise<number> {
  const idQueries = [
    `SELECT COUNT(*) FROM account WHERE "userId" = $1`,
    `SELECT COUNT(*) FROM session WHERE "userId" = $1`,
    `SELECT COUNT(*) FROM document WHERE owner_id = $1 OR last_edited_by = $1`,
    `SELECT COUNT(*) FROM collaborator WHERE added_by = $1`,
    `SELECT COUNT(*) FROM version WHERE created_by = $1`,
    `SELECT COUNT(*) FROM star WHERE user_id = $1`,
    `SELECT COUNT(*) FROM recent WHERE user_id = $1`,
    `SELECT COUNT(*) FROM api_token WHERE user_id = $1`,
    `SELECT COUNT(*) FROM asset WHERE user_id = $1`,
    `SELECT COUNT(*) FROM agent_request WHERE user_id = $1`,
    `SELECT COUNT(*) FROM review WHERE user_id = $1`,
    `SELECT COUNT(*) FROM webhook WHERE user_id = $1`,
    `SELECT COUNT(*) FROM activity WHERE actor_id = $1 OR position(('agent:' || $1 || ':') in actor_id) = 1`,
  ];
  let total = 0;
  for (const query of idQueries) total += await countWhere(client, `${query.replace("COUNT(*)", "COUNT(*)::text AS count")}`, [sourceId]);
  if (sourceLogin !== targetLogin) {
    total += await countWhere(client, `SELECT COUNT(*)::text AS count FROM collaborator WHERE lower(btrim(login)) = $1`, [sourceLogin]);
    total += await countWhere(
      client,
      `SELECT COUNT(*)::text AS count FROM notification WHERE lower(btrim(user_login)) = $1 OR lower(btrim(actor_login)) = $1`,
      [sourceLogin],
    );
  }
  return total;
}

/**
 * Documents whose collaborative state names the source user (comment authors, resolvers, reactions,
 * suggestion decisions). Reported for awareness only: the CRDT state is not rewritten by this tool.
 */
async function countDocumentIdentityReferences(client: LegacyOwnershipTransferQueryClient, sourceId: string): Promise<number> {
  const rows = await client.query<{ ystate: Uint8Array | Buffer }>(`SELECT ystate FROM document WHERE ystate IS NOT NULL`);
  let count = 0;
  for (const row of rows.rows) {
    const document = new Y.Doc();
    try {
      Y.applyUpdate(document, row.ystate instanceof Uint8Array ? row.ystate : new Uint8Array(row.ystate));
      const roots = ["comments", "suggestions", "commentSuggestionTransitions"].map((name) => document.getMap<unknown>(name).toJSON());
      if (yjsReferencesIdentity(roots, sourceId)) count += 1;
    } catch {
      throw new LegacyOwnershipTransferError("INTERNAL");
    } finally {
      document.destroy();
    }
  }
  return count;
}

const IDENTITY_KEYS = new Set(["actorId", "authorId", "resolvedBy", "suggestionBy", "userId"]);

function yjsReferencesIdentity(value: unknown, sourceId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => yjsReferencesIdentity(item, sourceId));
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (identityMatches(key.split("\u001f").at(-1), sourceId) || identityMatches(key, sourceId)) return true;
    if (IDENTITY_KEYS.has(key) && identityMatches(nested, sourceId)) return true;
    if (yjsReferencesIdentity(nested, sourceId)) return true;
  }
  return false;
}

function identityMatches(value: unknown, sourceId: string): boolean {
  return typeof value === "string" && (value === sourceId || value.startsWith(`agent:${sourceId}:`));
}

function countOperations(entries: PlanEntry[]): Record<TransferCountLabel, number> {
  const operations = emptyOperations();
  for (const entry of entries) operations[entry.label] += 1;
  operations["user deleted"] = 1;
  return operations;
}

function emptyOperations(): Record<TransferCountLabel, number> {
  const result = {} as Record<TransferCountLabel, number>;
  for (const label of TRANSFER_COUNT_LABELS) result[label] = 0;
  return result;
}

function whereClause(key: Key, firstParameter: number): { text: string; values: string[] } {
  const columns = Object.keys(key).sort();
  if (columns.length === 0) throw new LegacyOwnershipTransferError("INTERNAL");
  return {
    text: columns.map((column, index) => `${quote(column)} = $${firstParameter + index}`).join(" AND "),
    values: columns.map((column) => key[column]),
  };
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quote(identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) throw new LegacyOwnershipTransferError("INTERNAL");
  return `"${identifier}"`;
}

async function expectRows(client: LegacyOwnershipTransferQueryClient, query: string, values: unknown[], expected: number): Promise<void> {
  const result = await client.query(query, values);
  if (result.rows.length !== expected) throw new LegacyOwnershipTransferError("WRITE_COUNT_MISMATCH");
}

async function countWhere(client: LegacyOwnershipTransferQueryClient, query: string, values: unknown[]): Promise<number> {
  const result = await client.query<{ count: string }>(query, values);
  return parseCount(result.rows[0]?.count);
}

function parseCount(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") throw new LegacyOwnershipTransferError("INTERNAL");
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new LegacyOwnershipTransferError("INTERNAL");
  return count;
}

function isUserRow(value: unknown): value is UserRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    ["name", "email", "email_verified", "image", "login"].every((key) => value[key] === null || typeof value[key] === "string")
  );
}

function isKey(value: unknown): value is Key {
  return isRecord(value) && Object.keys(value).length > 0 && Object.values(value).every((item) => typeof item === "string");
}

function isPlanEntry(value: unknown): value is PlanEntry {
  if (!isRecord(value) || typeof value.table !== "string" || !isKey(value.key) || !isCountLabel(value.label)) return false;
  if (value.kind === "update") {
    return (
      isKey(value.postKey) &&
      typeof value.column === "string" &&
      (value.before === null || typeof value.before === "string") &&
      (value.after === null || typeof value.after === "string")
    );
  }
  return value.kind === "delete" && isRecord(value.row);
}

function isRowFingerprint(value: unknown): value is RowFingerprint {
  return isRecord(value) && typeof value.table === "string" && isKey(value.key) && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256);
}

function isBinding(value: unknown): value is RollbackRecord["binding"] {
  return (
    isRecord(value) &&
    typeof value.sourceLogin === "string" &&
    typeof value.targetUserId === "string" &&
    typeof value.targetLogin === "string" &&
    typeof value.providerAccountIdSha256 === "string"
  );
}

function isCountLabel(value: unknown): value is TransferCountLabel {
  return typeof value === "string" && (TRANSFER_COUNT_LABELS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalValue(value[key]);
    return sorted;
  }
  throw new LegacyOwnershipTransferError("INTERNAL");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
