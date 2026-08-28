import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import * as Y from "yjs";

export type GithubIdentityRepairMode = "dry-run" | "apply" | "verify" | "rollback";

type RepairRow = Record<string, unknown>;

export interface GithubIdentityRepairQueryClient {
  query<T extends RepairRow = RepairRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export const REPAIR_SCHEMA_TABLES = [
  "account",
  "activity",
  "agent_request",
  "api_token",
  "asset",
  "collaborator",
  "document",
  "notification",
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

export type RepairSchemaTable = (typeof REPAIR_SCHEMA_TABLES)[number];

export const REPAIR_APPLICATION_TABLES = [
  "activity",
  "agent_request",
  "api_token",
  "asset",
  "collaborator",
  "document",
  "notification",
  "recent",
  "review",
  "star",
  "version",
  "webhook",
  "webhook_delivery",
] as const satisfies readonly RepairSchemaTable[];

export const KNOWN_USER_FOREIGN_KEYS = [
  "account.userId",
  "agent_request.user_id",
  "api_token.user_id",
  "asset.user_id",
  "document.owner_id",
  "recent.user_id",
  "review.user_id",
  "session.userId",
  "star.user_id",
  "webhook.user_id",
] as const;

export const USER_IDENTITY_CLASSIFICATIONS = [
  ...KNOWN_USER_FOREIGN_KEYS,
  "document.last_edited_by",
  "collaborator.added_by",
  "version.created_by",
  "activity.actor_id",
  "collaborator.login",
  "notification.user_login",
  "notification.actor_login",
  "document.ystate identity metadata",
] as const;

const APPLICATION_DEPENDENCY_LABELS = [
  "document.owner_id",
  "star.user_id",
  "recent.user_id",
  "api_token.user_id",
  "asset.user_id",
  "agent_request.user_id",
  "review.user_id",
  "webhook.user_id",
  "document.last_edited_by",
  "collaborator.added_by",
  "version.created_by",
  "activity.actor_id",
  "collaborator.login",
  "notification.user_login",
  "notification.actor_login",
  "document.ystate identity metadata",
  "collaborator.document_id via duplicate-owned document",
  "version.document_id via duplicate-owned document",
  "star.document_id via duplicate-owned document",
  "recent.document_id via duplicate-owned document",
  "asset.document_id via duplicate-owned document",
  "notification.document_id via duplicate-owned document",
  "activity.document_id via duplicate-owned document",
  "agent_request.document_id via duplicate-owned document",
  "review.document_id via duplicate-owned document",
  "webhook_delivery.webhook_id via duplicate-owned webhook",
] as const;

export type ApplicationDependencyLabel = (typeof APPLICATION_DEPENDENCY_LABELS)[number];

export type GithubIdentityRepairReason =
  | "INVALID_LOGIN"
  | "INVALID_ACCOUNT_ID"
  | "MANIFEST_REQUIRED"
  | "MANIFEST_INVALID"
  | "MANIFEST_CHECKSUM_MISMATCH"
  | "MANIFEST_BINDING_MISMATCH"
  | "MANIFEST_FILE_EXISTS"
  | "SCHEMA_TABLE_DRIFT"
  | "SCHEMA_USER_FK_DRIFT"
  | "LOGIN_USER_COUNT"
  | "TARGET_ACCOUNT_COUNT"
  | "TARGET_ACCOUNT_TYPE"
  | "TARGET_ACCOUNT_LOGIN_MISMATCH"
  | "EMAIL_CONFLICT"
  | "LEGACY_UNSAFE"
  | "DUPLICATE_AUTH_UNSAFE"
  | "DUPLICATE_APPLICATION_DATA"
  | "DOCUMENT_STATE_INVALID"
  | "WRITE_COUNT_MISMATCH"
  | "POSTCONDITION_FAILED"
  | "STATE_CHANGED"
  | "COMMIT_OUTCOME_UNKNOWN"
  | "INTERNAL";

const REASON_MESSAGES: Record<GithubIdentityRepairReason, string> = {
  INVALID_LOGIN: "the expected legacy login is invalid",
  INVALID_ACCOUNT_ID: "the expected GitHub account identifier is invalid",
  MANIFEST_REQUIRED: "this operation requires a rollback manifest",
  MANIFEST_INVALID: "the rollback manifest is invalid",
  MANIFEST_CHECKSUM_MISMATCH: "the rollback manifest checksum does not match",
  MANIFEST_BINDING_MISMATCH: "the rollback manifest does not match the configured identity",
  MANIFEST_FILE_EXISTS: "the rollback manifest or staging file already exists",
  SCHEMA_TABLE_DRIFT: "the runtime schema table classification has drifted",
  SCHEMA_USER_FK_DRIFT: "the runtime user foreign-key classification has drifted",
  LOGIN_USER_COUNT: "the normalized login does not select exactly two users",
  TARGET_ACCOUNT_COUNT: "the target GitHub account does not select exactly one duplicate user",
  TARGET_ACCOUNT_TYPE: "the target GitHub account is not an OAuth account",
  TARGET_ACCOUNT_LOGIN_MISMATCH: "the target GitHub account user does not have the expected normalized login",
  EMAIL_CONFLICT: "a case-insensitive profile email conflict exists",
  LEGACY_UNSAFE: "the legacy development user does not satisfy the safety predicate",
  DUPLICATE_AUTH_UNSAFE: "the OAuth duplicate has additional authentication state",
  DUPLICATE_APPLICATION_DATA: "the OAuth duplicate has application dependencies",
  DOCUMENT_STATE_INVALID: "persisted document identity metadata could not be audited",
  WRITE_COUNT_MISMATCH: "a repair statement affected an unexpected number of rows",
  POSTCONDITION_FAILED: "repair postconditions were not satisfied",
  STATE_CHANGED: "database state no longer matches the rollback manifest",
  COMMIT_OUTCOME_UNKNOWN: "the database did not confirm whether the transaction committed",
  INTERNAL: "the identity repair did not complete",
};

export class GithubIdentityRepairError extends Error {
  constructor(readonly reason: GithubIdentityRepairReason) {
    super(`GitHub identity repair refused: ${REASON_MESSAGES[reason]}`);
    this.name = "GithubIdentityRepairError";
  }
}

export class GithubIdentityRepairCommittedManifestError extends Error {
  readonly committed = true;

  constructor() {
    super("GitHub identity repair committed, but rollback manifest publication failed");
    this.name = "GithubIdentityRepairCommittedManifestError";
  }
}

interface UserProfile {
  id: string;
  name: string | null;
  email: string | null;
  emailVerified: string | null;
  image: string | null;
  login: string | null;
}

interface AccountState {
  userId: string;
  type: string;
  provider: string;
  providerAccountIdHash: string;
  credentialsHash: string;
  expiresAt: string | null;
  rowVersion: string;
}

export interface RepairTableState {
  count: number;
  sha256: string;
}

export interface RepairDatabaseState {
  tables: Record<RepairSchemaTable, RepairTableState>;
}

interface GithubIdentityRepairManifestPayload {
  formatVersion: 1;
  kind: "markdoc-github-identity-repair";
  bindings: {
    normalizedLoginSha256: string;
    providerAccountIdSha256: string;
  };
  profiles: {
    before: {
      legacy: UserProfile;
      duplicate: UserProfile;
    };
    after: {
      canonical: UserProfile;
    };
  };
  targetAccount: {
    before: AccountState;
    after: AccountState;
  };
  pre: RepairDatabaseState;
  post: RepairDatabaseState;
}

export interface GithubIdentityRepairManifest extends GithubIdentityRepairManifestPayload {
  checksum: {
    algorithm: "sha256";
    value: string;
  };
}

export interface GithubIdentityRepairManifestStore {
  read(manifestPath: string): Promise<string>;
  stage(manifestPath: string, contents: string): Promise<void>;
  finalize(manifestPath: string): Promise<void>;
  discard(manifestPath: string): Promise<void>;
}

export interface GithubIdentityRepairHooks {
  afterMutations?(client: GithubIdentityRepairQueryClient): Promise<void> | void;
  beforeManifestStage?(): Promise<void> | void;
  beforeCommit?(): Promise<void> | void;
}

export interface GithubIdentityRepairOptions {
  client: GithubIdentityRepairQueryClient;
  expectedLogin: string;
  providerAccountId: string;
  mode?: GithubIdentityRepairMode;
  manifestPath?: string;
  manifestStore?: GithubIdentityRepairManifestStore;
  hooks?: GithubIdentityRepairHooks;
}

export interface GithubIdentityRepairReport {
  mode: GithubIdentityRepairMode;
  committed: boolean;
  verified: boolean;
  schema: {
    tables: number;
    userForeignKeys: number;
  };
  selection: {
    normalizedLoginUsers: number;
    targetGithubAccounts: number;
    legacySafe: boolean;
    duplicateAuthSafe: boolean;
  };
  operations: {
    profilesToUpdate: number;
    accountsToMove: number;
    usersToDelete: number;
    usersToCreate: number;
  };
  dependencies: Record<ApplicationDependencyLabel, number>;
  tables: Record<
    RepairSchemaTable,
    {
      beforeCount: number;
      afterCount: number;
      beforeHashPrefix: string;
      afterHashPrefix: string;
    }
  >;
  manifestStaged: boolean;
  manifestPublished: boolean;
}

interface InitialSelection {
  legacy: UserProfile;
  duplicate: UserProfile;
  targetAccount: AccountState;
  dependencies: Record<ApplicationDependencyLabel, number>;
  unaffectedAuth: {
    accounts: RepairTableState;
    users: RepairTableState;
  };
}

const LOGIN_PATTERN = /^(?!.*--)[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/;
const ACCOUNT_ID_PATTERN = /^\d{1,32}$/;
const HASH_PREFIX_LENGTH = 12;

const SAFE_STATE_QUERIES: Record<RepairSchemaTable, string> = {
  account: `SELECT xmin::text AS row_version,
                   "userId" AS user_id, type, provider,
                   "providerAccountId" AS provider_account_id,
                   refresh_token, access_token, token_type, scope, id_token, session_state,
                   expires_at::text AS expires_at
              FROM account`,
  activity: `SELECT xmin::text AS row_version,
                    id, document_id, actor_id, actor_kind, action,
                    created_at::text AS created_at
               FROM activity`,
  agent_request: `SELECT xmin::text AS row_version,
                         id, document_id, user_id, mode, status,
                         created_at::text AS created_at,
                         updated_at::text AS updated_at
                    FROM agent_request`,
  api_token: `SELECT xmin::text AS row_version,
                     id, user_id, scope, document_ids,
                     created_at::text AS created_at,
                     last_used_at::text AS last_used_at,
                     last_mcp_seen_at::text AS last_mcp_seen_at,
                     last_mcp_call_at::text AS last_mcp_call_at,
                     expires_at::text AS expires_at,
                     revoked_at::text AS revoked_at
                FROM api_token`,
  asset: `SELECT xmin::text AS row_version,
                 id, document_id, user_id, created_at::text AS created_at
            FROM asset`,
  collaborator: `SELECT xmin::text AS row_version,
                         document_id, login, role, added_by,
                         created_at::text AS created_at
                    FROM collaborator`,
  document: `SELECT xmin::text AS row_version,
                    id, owner_id, storage, link_access, last_edited_by,
                    published_at::text AS published_at,
                    created_at::text AS created_at,
                    updated_at::text AS updated_at,
                    deleted_at::text AS deleted_at
               FROM document`,
  notification: `SELECT xmin::text AS row_version,
                         id, user_login, document_id, kind, actor_login, ref_id,
                         created_at::text AS created_at,
                         read_at::text AS read_at
                    FROM notification`,
  recent: `SELECT xmin::text AS row_version,
                  user_id, document_id, opened_at::text AS opened_at
             FROM recent`,
  review: `SELECT xmin::text AS row_version,
                  id, document_id, user_id, agent_token_id, verdict, thread_ids,
                  created_at::text AS created_at
             FROM review`,
  session: `SELECT xmin::text AS row_version,
                   "userId" AS user_id, expires::text AS expires
              FROM session`,
  star: `SELECT xmin::text AS row_version, document_id, user_id, starred FROM star`,
  user: `SELECT xmin::text AS row_version,
                id, email, "emailVerified"::text AS email_verified, login
           FROM "user"`,
  verificationToken: `SELECT xmin::text AS row_version,
                              identifier, expires::text AS expires
                        FROM "verificationToken"`,
  version: `SELECT xmin::text AS row_version,
                   id, document_id, number::text AS number, kind, created_by,
                   commit_sha, created_at::text AS created_at
              FROM version`,
  webhook: `SELECT xmin::text AS row_version,
                    id, user_id, document_ids, active, failures,
                    created_at::text AS created_at
               FROM webhook`,
  webhook_delivery: `SELECT xmin::text AS row_version,
                            id, webhook_id, event, status, attempt,
                            created_at::text AS created_at
                       FROM webhook_delivery`,
};

const defaultManifestStore: GithubIdentityRepairManifestStore = {
  read: (manifestPath) => fs.readFile(manifestPath, "utf8"),
  async stage(manifestPath, contents) {
    const stagingPath = stagedManifestPath(manifestPath);
    if ((await pathExists(manifestPath)) || (await pathExists(stagingPath))) {
      throw new GithubIdentityRepairError("MANIFEST_FILE_EXISTS");
    }
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(stagingPath, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.unlink(stagingPath).catch(() => undefined);
      if (error instanceof GithubIdentityRepairError) throw error;
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new GithubIdentityRepairError("MANIFEST_FILE_EXISTS");
      }
      throw error;
    }
  },
  async finalize(manifestPath) {
    const stagingPath = stagedManifestPath(manifestPath);
    await fs.link(stagingPath, manifestPath);
    await fs.unlink(stagingPath);
  },
  async discard(manifestPath) {
    await fs.unlink(stagedManifestPath(manifestPath)).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  },
};

export function normalizeRepairGithubLogin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return LOGIN_PATTERN.test(normalized) ? normalized : null;
}

export function normalizeRepairGithubAccountId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return ACCOUNT_ID_PATTERN.test(normalized) ? normalized : null;
}

export async function repairGithubIdentity(
  options: GithubIdentityRepairOptions,
): Promise<GithubIdentityRepairReport> {
  const mode = options.mode ?? "dry-run";
  const expectedLogin = normalizeRepairGithubLogin(options.expectedLogin);
  if (!expectedLogin) throw new GithubIdentityRepairError("INVALID_LOGIN");
  const providerAccountId = normalizeRepairGithubAccountId(options.providerAccountId);
  if (!providerAccountId) throw new GithubIdentityRepairError("INVALID_ACCOUNT_ID");
  if ((mode === "apply" || mode === "verify" || mode === "rollback") && !options.manifestPath) {
    throw new GithubIdentityRepairError("MANIFEST_REQUIRED");
  }

  const manifestStore = options.manifestStore ?? defaultManifestStore;
  const existingManifest =
    mode === "verify" || mode === "rollback"
      ? await readManifest(options.manifestPath ?? "", manifestStore, expectedLogin, providerAccountId)
      : undefined;

  let began = false;
  let commitAttempted = false;
  let committed = false;
  let manifestStaged = false;
  try {
    await options.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    began = true;
    await acquireRepairLocks(options.client, expectedLogin, providerAccountId);
    await auditRuntimeSchema(options.client);

    let report: GithubIdentityRepairReport;
    if (mode === "verify") {
      if (!existingManifest) throw new GithubIdentityRepairError("MANIFEST_INVALID");
      await assertManifestDatabaseState(
        options.client,
        existingManifest,
        "post",
        expectedLogin,
        providerAccountId,
      );
      const post = await collectDatabaseState(options.client);
      report = createReport({
        mode,
        committed: false,
        pre: post,
        post,
        dependencies: emptyDependencies(),
        operations: { profilesToUpdate: 0, accountsToMove: 0, usersToDelete: 0, usersToCreate: 0 },
        manifestStaged: false,
        manifestPublished: false,
      });
      await options.client.query("ROLLBACK");
      began = false;
      return report;
    }

    if (mode === "rollback") {
      if (!existingManifest) throw new GithubIdentityRepairError("MANIFEST_INVALID");
      await assertManifestDatabaseState(
        options.client,
        existingManifest,
        "post",
        expectedLogin,
        providerAccountId,
      );
      const current = await collectDatabaseState(options.client);
      await restorePreRepairState(options.client, existingManifest, providerAccountId);
      await options.hooks?.afterMutations?.(options.client);
      await assertManifestDatabaseState(
        options.client,
        existingManifest,
        "pre",
        expectedLogin,
        providerAccountId,
      );
      const restored = await collectDatabaseState(options.client);
      await options.hooks?.beforeCommit?.();
      commitAttempted = true;
      await options.client.query("COMMIT");
      committed = true;
      began = false;
      return createReport({
        mode,
        committed: true,
        pre: current,
        post: restored,
        dependencies: emptyDependencies(),
        operations: { profilesToUpdate: 1, accountsToMove: 1, usersToDelete: 0, usersToCreate: 1 },
        manifestStaged: false,
        manifestPublished: false,
      });
    }

    const selection = await selectAndValidateInitialState(
      options.client,
      expectedLogin,
      providerAccountId,
    );
    const pre = await collectDatabaseState(options.client);
    await applyRepairMutations(options.client, selection, expectedLogin, providerAccountId);
    await options.hooks?.afterMutations?.(options.client);
    const post = await verifyAppliedState(
      options.client,
      selection,
      pre,
      expectedLogin,
      providerAccountId,
    );
    const postAccount = await getTargetAccount(options.client, providerAccountId);
    if (!postAccount) throw new GithubIdentityRepairError("POSTCONDITION_FAILED");

    let manifest: GithubIdentityRepairManifest | undefined;
    if (mode === "apply") {
      manifest = createManifest(
        expectedLogin,
        providerAccountId,
        selection,
        postAccount,
        pre,
        post,
      );
      await options.hooks?.beforeManifestStage?.();
      await manifestStore.stage(options.manifestPath ?? "", `${JSON.stringify(manifest, null, 2)}\n`);
      manifestStaged = true;
    }

    report = createReport({
      mode,
      committed: mode === "apply",
      pre,
      post,
      dependencies: selection.dependencies,
      operations: { profilesToUpdate: 1, accountsToMove: 1, usersToDelete: 1, usersToCreate: 0 },
      manifestStaged,
      manifestPublished: false,
    });

    if (mode === "dry-run") {
      await options.client.query("ROLLBACK");
      began = false;
      return report;
    }

    await options.hooks?.beforeCommit?.();
    commitAttempted = true;
    await options.client.query("COMMIT");
    committed = true;
    began = false;
    try {
      await manifestStore.finalize(options.manifestPath ?? "");
    } catch {
      throw new GithubIdentityRepairCommittedManifestError();
    }
    return { ...report, manifestPublished: true };
  } catch (error) {
    if (began && !commitAttempted) {
      try {
        await options.client.query("ROLLBACK");
      } catch {
        throw new GithubIdentityRepairError("INTERNAL");
      } finally {
        if (manifestStaged && options.manifestPath) {
          await manifestStore.discard(options.manifestPath).catch(() => undefined);
        }
      }
    }
    if (commitAttempted && !committed) {
      throw new GithubIdentityRepairError("COMMIT_OUTCOME_UNKNOWN");
    }
    if (
      error instanceof GithubIdentityRepairError ||
      error instanceof GithubIdentityRepairCommittedManifestError
    ) {
      throw error;
    }
    throw new GithubIdentityRepairError("INTERNAL");
  }
}

async function acquireRepairLocks(
  client: GithubIdentityRepairQueryClient,
  expectedLogin: string,
  providerAccountId: string,
): Promise<void> {
  const lockNames = [
    `github-account:${providerAccountId}`,
    `github-login:${expectedLogin}`,
  ].sort();
  for (const lockName of lockNames) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [lockName],
    );
  }
}

async function auditRuntimeSchema(client: GithubIdentityRepairQueryClient): Promise<void> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const actualTables = tables.rows.map((row) => row.table_name);
  if (!sameStrings(actualTables, [...REPAIR_SCHEMA_TABLES])) {
    throw new GithubIdentityRepairError("SCHEMA_TABLE_DRIFT");
  }

  const foreignKeys = await client.query<{ table_name: string; column_name: string }>(
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
  const actualForeignKeys = foreignKeys.rows.map(
    (row) => `${row.table_name}.${row.column_name}`,
  );
  if (!sameStrings(actualForeignKeys, [...KNOWN_USER_FOREIGN_KEYS].sort())) {
    throw new GithubIdentityRepairError("SCHEMA_USER_FK_DRIFT");
  }
}

async function selectAndValidateInitialState(
  client: GithubIdentityRepairQueryClient,
  expectedLogin: string,
  providerAccountId: string,
): Promise<InitialSelection> {
  const users = await client.query<UserProfileRow>(
    `${USER_PROFILE_SELECT}
       WHERE lower(btrim(login)) = $1
       ORDER BY id
       FOR UPDATE`,
    [expectedLogin],
  );
  if (users.rows.length !== 2) throw new GithubIdentityRepairError("LOGIN_USER_COUNT");
  const profiles = users.rows.map(profileFromRow);

  const accounts = await client.query<TargetAccountRow>(
    `SELECT xmin::text AS row_version,
            "userId" AS user_id, type, provider,
            "providerAccountId" AS provider_account_id,
            refresh_token, access_token, token_type, scope, id_token, session_state,
            expires_at::text AS expires_at
       FROM account
      WHERE provider = 'github' AND "providerAccountId" = $1
      FOR UPDATE`,
    [providerAccountId],
  );
  if (accounts.rows.length !== 1) {
    throw new GithubIdentityRepairError("TARGET_ACCOUNT_COUNT");
  }
  const accountRow = accounts.rows[0];
  if (accountRow.type !== "oauth") throw new GithubIdentityRepairError("TARGET_ACCOUNT_TYPE");
  const duplicate = profiles.find((profile) => profile.id === accountRow.user_id);
  if (!duplicate) {
    throw new GithubIdentityRepairError("TARGET_ACCOUNT_LOGIN_MISMATCH");
  }
  if (normalizeRepairGithubLogin(duplicate.login) !== expectedLogin) {
    throw new GithubIdentityRepairError("TARGET_ACCOUNT_LOGIN_MISMATCH");
  }
  const legacy = profiles.find((profile) => profile.id !== duplicate.id);
  if (!legacy) throw new GithubIdentityRepairError("LOGIN_USER_COUNT");

  const [legacyAccounts, legacySessions, duplicateAccounts, duplicateSessions] =
    await Promise.all([
      countWhere(client, `SELECT COUNT(*)::text AS count FROM account WHERE "userId" = $1`, [legacy.id]),
      countWhere(client, `SELECT COUNT(*)::text AS count FROM session WHERE "userId" = $1`, [legacy.id]),
      countWhere(client, `SELECT COUNT(*)::text AS count FROM account WHERE "userId" = $1`, [duplicate.id]),
      countWhere(client, `SELECT COUNT(*)::text AS count FROM session WHERE "userId" = $1`, [duplicate.id]),
    ]);

  const legacyEmail = legacy.email?.trim().toLowerCase() ?? null;
  if (
    legacyEmail !== `${expectedLogin}@dev.local` ||
    legacy.emailVerified !== null ||
    legacyAccounts !== 0 ||
    legacySessions !== 0
  ) {
    throw new GithubIdentityRepairError("LEGACY_UNSAFE");
  }
  if (duplicateAccounts !== 1 || duplicateSessions !== 0) {
    throw new GithubIdentityRepairError("DUPLICATE_AUTH_UNSAFE");
  }
  for (const email of new Set(
    [legacy.email, duplicate.email]
      .map((value) => value?.trim().toLowerCase() ?? null)
      .filter((value): value is string => !!value),
  )) {
    const conflicts = await countWhere(
      client,
      `SELECT COUNT(*)::text AS count
         FROM "user"
        WHERE lower(btrim(email)) = $1
          AND id <> $2
          AND id <> $3`,
      [email, legacy.id, duplicate.id],
    );
    if (conflicts !== 0) throw new GithubIdentityRepairError("EMAIL_CONFLICT");
  }

  const dependencies = await collectApplicationDependencies(
    client,
    duplicate.id,
    expectedLogin,
  );
  const preservedLoginReferences = new Set<ApplicationDependencyLabel>([
    "collaborator.login",
    "notification.user_login",
    "notification.actor_login",
  ]);
  if (
    APPLICATION_DEPENDENCY_LABELS.some(
      (label) => !preservedLoginReferences.has(label) && dependencies[label] !== 0,
    )
  ) {
    throw new GithubIdentityRepairError("DUPLICATE_APPLICATION_DATA");
  }

  return {
    legacy,
    duplicate,
    targetAccount: accountFromRow(accountRow),
    dependencies,
    unaffectedAuth: await collectUnaffectedAuthState(
      client,
      legacy.id,
      duplicate.id,
      providerAccountId,
    ),
  };
}

async function collectApplicationDependencies(
  client: GithubIdentityRepairQueryClient,
  duplicateId: string,
  expectedLogin: string,
): Promise<Record<ApplicationDependencyLabel, number>> {
  const definitions: Array<{
    label: ApplicationDependencyLabel;
    query: string;
    values: unknown[];
  }> = [
    { label: "document.owner_id", query: "SELECT COUNT(*)::text AS count FROM document WHERE owner_id = $1", values: [duplicateId] },
    { label: "star.user_id", query: "SELECT COUNT(*)::text AS count FROM star WHERE user_id = $1", values: [duplicateId] },
    { label: "recent.user_id", query: "SELECT COUNT(*)::text AS count FROM recent WHERE user_id = $1", values: [duplicateId] },
    { label: "api_token.user_id", query: "SELECT COUNT(*)::text AS count FROM api_token WHERE user_id = $1", values: [duplicateId] },
    { label: "asset.user_id", query: "SELECT COUNT(*)::text AS count FROM asset WHERE user_id = $1", values: [duplicateId] },
    { label: "agent_request.user_id", query: "SELECT COUNT(*)::text AS count FROM agent_request WHERE user_id = $1", values: [duplicateId] },
    { label: "review.user_id", query: "SELECT COUNT(*)::text AS count FROM review WHERE user_id = $1", values: [duplicateId] },
    { label: "webhook.user_id", query: "SELECT COUNT(*)::text AS count FROM webhook WHERE user_id = $1", values: [duplicateId] },
    { label: "document.last_edited_by", query: "SELECT COUNT(*)::text AS count FROM document WHERE last_edited_by = $1", values: [duplicateId] },
    { label: "collaborator.added_by", query: "SELECT COUNT(*)::text AS count FROM collaborator WHERE added_by = $1", values: [duplicateId] },
    { label: "version.created_by", query: "SELECT COUNT(*)::text AS count FROM version WHERE created_by = $1", values: [duplicateId] },
    {
      label: "activity.actor_id",
      query: `SELECT COUNT(*)::text AS count
                FROM activity
               WHERE actor_id = $1
                  OR position(('agent:' || $1 || ':') in actor_id) = 1`,
      values: [duplicateId],
    },
    {
      label: "collaborator.login",
      query: "SELECT COUNT(*)::text AS count FROM collaborator WHERE lower(btrim(login)) = $1",
      values: [expectedLogin],
    },
    {
      label: "notification.user_login",
      query: "SELECT COUNT(*)::text AS count FROM notification WHERE lower(btrim(user_login)) = $1",
      values: [expectedLogin],
    },
    {
      label: "notification.actor_login",
      query: "SELECT COUNT(*)::text AS count FROM notification WHERE lower(btrim(actor_login)) = $1",
      values: [expectedLogin],
    },
    {
      label: "collaborator.document_id via duplicate-owned document",
      query: `SELECT COUNT(*)::text AS count
                FROM collaborator c JOIN document d ON d.id = c.document_id
               WHERE d.owner_id = $1`,
      values: [duplicateId],
    },
    {
      label: "version.document_id via duplicate-owned document",
      query: `SELECT COUNT(*)::text AS count
                FROM version v JOIN document d ON d.id = v.document_id
               WHERE d.owner_id = $1`,
      values: [duplicateId],
    },
    {
      label: "star.document_id via duplicate-owned document",
      query: `SELECT COUNT(*)::text AS count
                FROM star s JOIN document d ON d.id = s.document_id
               WHERE d.owner_id = $1`,
      values: [duplicateId],
    },
    {
      label: "recent.document_id via duplicate-owned document",
      query: `SELECT COUNT(*)::text AS count
                FROM recent r JOIN document d ON d.id = r.document_id
               WHERE d.owner_id = $1`,
      values: [duplicateId],
    },
    {
      label: "asset.document_id via duplicate-owned document",
      query: `SELECT COUNT(*)::text AS count
                FROM asset a JOIN document d ON d.id = a.document_id
               WHERE d.owner_id = $1`,
      values: [duplicateId],
    },
    {
      label: "notification.document_id via duplicate-owned document",
      query: `SELECT COUNT(*)::text AS count
                FROM notification n JOIN document d ON d.id = n.document_id
               WHERE d.owner_id = $1`,
      values: [duplicateId],
    },
    {
      label: "activity.document_id via duplicate-owned document",
      query: `SELECT COUNT(*)::text AS count
                FROM activity a JOIN document d ON d.id = a.document_id
               WHERE d.owner_id = $1`,
      values: [duplicateId],
    },
    {
      label: "agent_request.document_id via duplicate-owned document",
      query: `SELECT COUNT(*)::text AS count
                FROM agent_request a JOIN document d ON d.id = a.document_id
               WHERE d.owner_id = $1`,
      values: [duplicateId],
    },
    {
      label: "review.document_id via duplicate-owned document",
      query: `SELECT COUNT(*)::text AS count
                FROM review r JOIN document d ON d.id = r.document_id
               WHERE d.owner_id = $1`,
      values: [duplicateId],
    },
    {
      label: "webhook_delivery.webhook_id via duplicate-owned webhook",
      query: `SELECT COUNT(*)::text AS count
                FROM webhook_delivery wd JOIN webhook w ON w.id = wd.webhook_id
               WHERE w.user_id = $1`,
      values: [duplicateId],
    },
  ];

  const result = emptyDependencies();
  for (const definition of definitions) {
    result[definition.label] = await countWhere(client, definition.query, definition.values);
  }
  result["document.ystate identity metadata"] = await countDocumentIdentityReferences(
    client,
    duplicateId,
  );
  return result;
}

async function countDocumentIdentityReferences(
  client: GithubIdentityRepairQueryClient,
  duplicateId: string,
): Promise<number> {
  const rows = await client.query<{ ystate: Uint8Array }>(
    `SELECT ystate FROM document WHERE ystate IS NOT NULL`,
  );
  let count = 0;
  for (const row of rows.rows) {
    const document = new Y.Doc();
    try {
      Y.applyUpdate(document, row.ystate);
      if (yjsStateReferencesIdentity(document, duplicateId)) count += 1;
    } catch {
      throw new GithubIdentityRepairError("DOCUMENT_STATE_INVALID");
    } finally {
      document.destroy();
    }
  }
  return count;
}

function yjsStateReferencesIdentity(document: Y.Doc, duplicateId: string): boolean {
  const suggestions = document.getMap<unknown>("suggestions");
  for (const suggestion of suggestions.values()) {
    if (metadataReferencesIdentity(suggestion, duplicateId)) return true;
  }

  const comments = document.getMap<Y.Map<unknown>>("comments");
  for (const thread of comments.values()) {
    if (!(thread instanceof Y.Map)) continue;
    for (const field of ["authorId", "resolvedBy", "suggestionBy"]) {
      if (identityMatches(thread.get(field), duplicateId)) return true;
    }
    const replies = thread.get("replies");
    if (
      replies instanceof Y.Array &&
      replies.toArray().some((reply) => metadataReferencesIdentity(reply, duplicateId))
    ) {
      return true;
    }
    const decisions = thread.get("replySuggestions");
    if (
      decisions instanceof Y.Map &&
      Array.from(decisions.values()).some((decision) =>
        metadataReferencesIdentity(decision, duplicateId),
      )
    ) {
      return true;
    }
    const reactions = thread.get("reactions");
    if (
      reactions instanceof Y.Map &&
      Array.from(reactions.keys()).some((key) =>
        identityMatches(key.split("\u001f").at(-1), duplicateId),
      )
    ) {
      return true;
    }
  }

  const transitions = document.getMap<unknown>("commentSuggestionTransitions");
  for (const [actorId, transition] of transitions.entries()) {
    if (
      identityMatches(actorId, duplicateId) ||
      metadataReferencesIdentity(transition, duplicateId)
    ) {
      return true;
    }
  }
  return false;
}

function metadataReferencesIdentity(value: unknown, duplicateId: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => metadataReferencesIdentity(item, duplicateId));
  }
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (
      ["actorId", "authorId", "resolvedBy", "suggestionBy", "userId"].includes(key) &&
      identityMatches(nested, duplicateId)
    ) {
      return true;
    }
    if (
      (Array.isArray(nested) || isRecord(nested)) &&
      metadataReferencesIdentity(nested, duplicateId)
    ) {
      return true;
    }
  }
  return false;
}

function identityMatches(value: unknown, duplicateId: string): boolean {
  return (
    typeof value === "string" &&
    (value === duplicateId || value.startsWith(`agent:${duplicateId}:`))
  );
}

async function collectUnaffectedAuthState(
  client: GithubIdentityRepairQueryClient,
  legacyId: string,
  duplicateId: string,
  providerAccountId: string,
): Promise<InitialSelection["unaffectedAuth"]> {
  const accounts = await client.query(
    `SELECT xmin::text AS row_version,
            "userId" AS user_id, type, provider,
            "providerAccountId" AS provider_account_id,
            refresh_token, access_token, expires_at::text AS expires_at,
            token_type, scope, id_token, session_state
       FROM account
      WHERE NOT (provider = 'github' AND "providerAccountId" = $1)`,
    [providerAccountId],
  );
  const users = await client.query(
    `SELECT xmin::text AS row_version,
            id, name, email, "emailVerified"::text AS email_verified, image, login
       FROM "user"
      WHERE id <> $1 AND id <> $2`,
    [legacyId, duplicateId],
  );
  return {
    accounts: stateFromRows(accounts.rows),
    users: stateFromRows(users.rows),
  };
}

function stateFromRows(rows: RepairRow[]): RepairTableState {
  const canonicalRows = rows.map(canonicalJson).sort();
  return {
    count: canonicalRows.length,
    sha256: sha256(canonicalRows.join("\n")),
  };
}

async function applyRepairMutations(
  client: GithubIdentityRepairQueryClient,
  selection: InitialSelection,
  expectedLogin: string,
  providerAccountId: string,
): Promise<void> {
  await expectOneRow(
    client,
    `UPDATE "user" SET email = NULL WHERE id = $1 RETURNING id`,
    [selection.duplicate.id],
  );
  await expectOneRow(
    client,
    `UPDATE "user"
        SET name = $2,
            email = $3,
            "emailVerified" = $4::timestamptz,
            image = $5,
            login = $6
      WHERE id = $1
      RETURNING id`,
    [
      selection.legacy.id,
      selection.duplicate.name,
      selection.duplicate.email,
      selection.duplicate.emailVerified,
      selection.duplicate.image,
      expectedLogin,
    ],
  );
  await expectOneRow(
    client,
    `UPDATE account
        SET "userId" = $1
      WHERE "userId" = $2
        AND provider = 'github'
        AND "providerAccountId" = $3
      RETURNING "userId" AS id`,
    [selection.legacy.id, selection.duplicate.id, providerAccountId],
  );
  await expectOneRow(
    client,
    `DELETE FROM "user" WHERE id = $1 RETURNING id`,
    [selection.duplicate.id],
  );
}

async function verifyAppliedState(
  client: GithubIdentityRepairQueryClient,
  selection: InitialSelection,
  pre: RepairDatabaseState,
  expectedLogin: string,
  providerAccountId: string,
): Promise<RepairDatabaseState> {
  const users = await client.query<UserProfileRow>(
    `${USER_PROFILE_SELECT}
       WHERE lower(btrim(login)) = $1
       ORDER BY id`,
    [expectedLogin],
  );
  if (users.rows.length !== 1 || users.rows[0].id !== selection.legacy.id) {
    throw new GithubIdentityRepairError("POSTCONDITION_FAILED");
  }
  const expectedCanonical: UserProfile = {
    ...selection.duplicate,
    id: selection.legacy.id,
    login: expectedLogin,
  };
  if (!sameJson(profileFromRow(users.rows[0]), expectedCanonical)) {
    throw new GithubIdentityRepairError("POSTCONDITION_FAILED");
  }
  const duplicate = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "user" WHERE id = $1`,
    [selection.duplicate.id],
  );
  if (parseCount(duplicate.rows[0]?.count) !== 0) {
    throw new GithubIdentityRepairError("POSTCONDITION_FAILED");
  }
  const account = await client.query<TargetAccountRow>(
    `SELECT xmin::text AS row_version,
            "userId" AS user_id, type, provider,
            "providerAccountId" AS provider_account_id,
            refresh_token, access_token, token_type, scope, id_token, session_state,
            expires_at::text AS expires_at
       FROM account
      WHERE provider = 'github' AND "providerAccountId" = $1`,
    [providerAccountId],
  );
  if (account.rows.length !== 1) {
    throw new GithubIdentityRepairError("POSTCONDITION_FAILED");
  }
  const appliedAccount = accountFromRow(account.rows[0]);
  const expectedAccount: AccountState = {
    ...selection.targetAccount,
    userId: selection.legacy.id,
    rowVersion: appliedAccount.rowVersion,
  };
  if (!sameAccountExceptRowVersion(appliedAccount, expectedAccount)) {
    throw new GithubIdentityRepairError("POSTCONDITION_FAILED");
  }

  const post = await collectDatabaseState(client);
  for (const table of REPAIR_APPLICATION_TABLES) {
    if (!sameJson(pre.tables[table], post.tables[table])) {
      throw new GithubIdentityRepairError("POSTCONDITION_FAILED");
    }
  }
  if (
    post.tables.account.count !== pre.tables.account.count ||
    !sameJson(post.tables.session, pre.tables.session) ||
    !sameJson(post.tables.verificationToken, pre.tables.verificationToken) ||
    post.tables.user.count !== pre.tables.user.count - 1
  ) {
    throw new GithubIdentityRepairError("POSTCONDITION_FAILED");
  }
  const unaffectedAuth = await collectUnaffectedAuthState(
    client,
    selection.legacy.id,
    selection.duplicate.id,
    providerAccountId,
  );
  if (!sameJson(unaffectedAuth, selection.unaffectedAuth)) {
    throw new GithubIdentityRepairError("POSTCONDITION_FAILED");
  }
  return post;
}

async function restorePreRepairState(
  client: GithubIdentityRepairQueryClient,
  manifest: GithubIdentityRepairManifest,
  providerAccountId: string,
): Promise<void> {
  const { legacy, duplicate } = manifest.profiles.before;
  await expectOneRow(
    client,
    `UPDATE "user"
        SET name = $2,
            email = $3,
            "emailVerified" = $4::timestamptz,
            image = $5,
            login = $6
      WHERE id = $1
      RETURNING id`,
    [
      legacy.id,
      legacy.name,
      legacy.email,
      legacy.emailVerified,
      legacy.image,
      legacy.login,
    ],
  );
  await expectOneRow(
    client,
    `INSERT INTO "user" (id, name, email, "emailVerified", image, login)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6)
     RETURNING id`,
    [
      duplicate.id,
      duplicate.name,
      duplicate.email,
      duplicate.emailVerified,
      duplicate.image,
      duplicate.login,
    ],
  );
  await expectOneRow(
    client,
    `UPDATE account
        SET "userId" = $1
      WHERE "userId" = $2
        AND provider = 'github'
        AND "providerAccountId" = $3
      RETURNING "userId" AS id`,
    [duplicate.id, legacy.id, providerAccountId],
  );
}

async function assertManifestDatabaseState(
  client: GithubIdentityRepairQueryClient,
  manifest: GithubIdentityRepairManifest,
  phase: "pre" | "post",
  expectedLogin: string,
  providerAccountId: string,
): Promise<void> {
  const current = await collectDatabaseState(client);
  if (
    phase === "post"
      ? !sameJson(current, manifest.post)
      : !matchesRestoredPreState(current, manifest.pre)
  ) {
    throw new GithubIdentityRepairError("STATE_CHANGED");
  }

  function matchesRestoredPreState(
    current: RepairDatabaseState,
    expected: RepairDatabaseState,
  ): boolean {
    for (const table of REPAIR_SCHEMA_TABLES) {
      if (table === "account" || table === "user") {
        if (current.tables[table].count !== expected.tables[table].count) return false;
        continue;
      }
      if (!sameJson(current.tables[table], expected.tables[table])) return false;
    }
    return true;
  }

  if (phase === "post") {
    const canonical = await getProfile(client, manifest.profiles.after.canonical.id);
    if (!canonical || !sameJson(canonical, manifest.profiles.after.canonical)) {
      throw new GithubIdentityRepairError("STATE_CHANGED");
    }
    const duplicate = await getProfile(client, manifest.profiles.before.duplicate.id);
    if (duplicate) throw new GithubIdentityRepairError("STATE_CHANGED");
    const matches = await client.query<{ id: string }>(
      `SELECT id FROM "user" WHERE lower(btrim(login)) = $1 ORDER BY id`,
      [expectedLogin],
    );
    if (
      matches.rows.length !== 1 ||
      matches.rows[0].id !== manifest.profiles.after.canonical.id
    ) {
      throw new GithubIdentityRepairError("STATE_CHANGED");
    }
  } else {
    const legacy = await getProfile(client, manifest.profiles.before.legacy.id);
    const duplicate = await getProfile(client, manifest.profiles.before.duplicate.id);
    if (
      !legacy ||
      !duplicate ||
      !sameJson(legacy, manifest.profiles.before.legacy) ||
      !sameJson(duplicate, manifest.profiles.before.duplicate)
    ) {
      throw new GithubIdentityRepairError("STATE_CHANGED");
    }
  }

  const target = await getTargetAccount(client, providerAccountId);
  const expectedTarget =
    manifest.targetAccount[phase === "pre" ? "before" : "after"];
  if (
    !target ||
    (phase === "post"
      ? !sameJson(target, expectedTarget)
      : !sameAccountExceptRowVersion(target, expectedTarget))
  ) {
    throw new GithubIdentityRepairError("STATE_CHANGED");
  }
}

async function collectDatabaseState(
  client: GithubIdentityRepairQueryClient,
): Promise<RepairDatabaseState> {
  const partial: Partial<Record<RepairSchemaTable, RepairTableState>> = {};
  for (const table of REPAIR_SCHEMA_TABLES) {
    const rows = await client.query(SAFE_STATE_QUERIES[table]);
    const canonicalRows = rows.rows.map(canonicalJson).sort();
    partial[table] = {
      count: canonicalRows.length,
      sha256: sha256(canonicalRows.join("\n")),
    };
  }
  return { tables: partial as Record<RepairSchemaTable, RepairTableState> };
}

function createManifest(
  expectedLogin: string,
  providerAccountId: string,
  selection: InitialSelection,
  postAccount: AccountState,
  pre: RepairDatabaseState,
  post: RepairDatabaseState,
): GithubIdentityRepairManifest {
  const payload: GithubIdentityRepairManifestPayload = {
    formatVersion: 1,
    kind: "markdoc-github-identity-repair",
    bindings: identityBindings(expectedLogin, providerAccountId),
    profiles: {
      before: {
        legacy: selection.legacy,
        duplicate: selection.duplicate,
      },
      after: {
        canonical: {
          ...selection.duplicate,
          id: selection.legacy.id,
          login: expectedLogin,
        },
      },
    },
    targetAccount: {
      before: selection.targetAccount,
      after: postAccount,
    },
    pre,
    post,
  };
  return {
    ...payload,
    checksum: {
      algorithm: "sha256",
      value: sha256(canonicalJson(payload)),
    },
  };
}

async function readManifest(
  manifestPath: string,
  store: GithubIdentityRepairManifestStore,
  expectedLogin: string,
  providerAccountId: string,
): Promise<GithubIdentityRepairManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await store.read(manifestPath)) as unknown;
  } catch {
    throw new GithubIdentityRepairError("MANIFEST_INVALID");
  }
  if (!isManifest(parsed)) throw new GithubIdentityRepairError("MANIFEST_INVALID");
  const { checksum, ...payload } = parsed;
  if (
    checksum.algorithm !== "sha256" ||
    !constantTimeTextEqual(checksum.value, sha256(canonicalJson(payload)))
  ) {
    throw new GithubIdentityRepairError("MANIFEST_CHECKSUM_MISMATCH");
  }
  const expectedBindings = identityBindings(expectedLogin, providerAccountId);
  if (
    !constantTimeTextEqual(
      parsed.bindings.normalizedLoginSha256,
      expectedBindings.normalizedLoginSha256,
    ) ||
    !constantTimeTextEqual(
      parsed.bindings.providerAccountIdSha256,
      expectedBindings.providerAccountIdSha256,
    )
  ) {
    throw new GithubIdentityRepairError("MANIFEST_BINDING_MISMATCH");
  }
  return parsed;
}

function isManifest(value: unknown): value is GithubIdentityRepairManifest {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      "formatVersion",
      "kind",
      "bindings",
      "profiles",
      "targetAccount",
      "pre",
      "post",
      "checksum",
    ]) ||
    value.formatVersion !== 1 ||
    value.kind !== "markdoc-github-identity-repair" ||
    !isRecord(value.bindings) ||
    !hasExactKeys(value.bindings, [
      "normalizedLoginSha256",
      "providerAccountIdSha256",
    ]) ||
    typeof value.bindings.normalizedLoginSha256 !== "string" ||
    typeof value.bindings.providerAccountIdSha256 !== "string" ||
    !isRecord(value.checksum) ||
    !hasExactKeys(value.checksum, ["algorithm", "value"]) ||
    value.checksum.algorithm !== "sha256" ||
    typeof value.checksum.value !== "string" ||
    !isRecord(value.profiles) ||
    !hasExactKeys(value.profiles, ["before", "after"]) ||
    !isRecord(value.profiles.before) ||
    !hasExactKeys(value.profiles.before, ["legacy", "duplicate"]) ||
    !isUserProfile(value.profiles.before.legacy) ||
    !isUserProfile(value.profiles.before.duplicate) ||
    !isRecord(value.profiles.after) ||
    !hasExactKeys(value.profiles.after, ["canonical"]) ||
    !isUserProfile(value.profiles.after.canonical) ||
    !isRecord(value.targetAccount) ||
    !hasExactKeys(value.targetAccount, ["before", "after"]) ||
    !isAccountState(value.targetAccount.before) ||
    !isAccountState(value.targetAccount.after) ||
    !isDatabaseState(value.pre) ||
    !isDatabaseState(value.post)
  ) {
    return false;
  }
  return true;
}

function isDatabaseState(value: unknown): value is RepairDatabaseState {
  if (!isRecord(value) || !hasExactKeys(value, ["tables"]) || !isRecord(value.tables)) return false;
  const tables = value.tables;
  if (Object.keys(tables).sort().join("\0") !== [...REPAIR_SCHEMA_TABLES].sort().join("\0")) {
    return false;
  }
  return REPAIR_SCHEMA_TABLES.every((table) => {
    const state = tables[table];
    return (
      isRecord(state) &&
      Number.isSafeInteger(state.count) &&
      typeof state.count === "number" &&
      state.count >= 0 &&
      typeof state.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(state.sha256) &&
      hasExactKeys(state, ["count", "sha256"])
    );
  });
}

function isUserProfile(value: unknown): value is UserProfile {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "name", "email", "emailVerified", "image", "login"]) ||
    typeof value.id !== "string"
  ) return false;
  return ["name", "email", "emailVerified", "image", "login"].every(
    (key) => value[key] === null || typeof value[key] === "string",
  );
}

function isAccountState(value: unknown): value is AccountState {
  return (
    isRecord(value) &&
    typeof value.userId === "string" &&
    typeof value.type === "string" &&
    value.provider === "github" &&
    typeof value.providerAccountIdHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.providerAccountIdHash) &&
    typeof value.credentialsHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.credentialsHash) &&
    (value.expiresAt === null || typeof value.expiresAt === "string") &&
    typeof value.rowVersion === "string" &&
    hasExactKeys(value, [
      "userId",
      "type",
      "provider",
      "providerAccountIdHash",
      "credentialsHash",
      "expiresAt",
      "rowVersion",
    ])
  );
}

function createReport(input: {
  mode: GithubIdentityRepairMode;
  committed: boolean;
  pre: RepairDatabaseState;
  post: RepairDatabaseState;
  dependencies: Record<ApplicationDependencyLabel, number>;
  operations: GithubIdentityRepairReport["operations"];
  manifestStaged: boolean;
  manifestPublished: boolean;
}): GithubIdentityRepairReport {
  const tables = {} as GithubIdentityRepairReport["tables"];
  for (const table of REPAIR_SCHEMA_TABLES) {
    tables[table] = {
      beforeCount: input.pre.tables[table].count,
      afterCount: input.post.tables[table].count,
      beforeHashPrefix: input.pre.tables[table].sha256.slice(0, HASH_PREFIX_LENGTH),
      afterHashPrefix: input.post.tables[table].sha256.slice(0, HASH_PREFIX_LENGTH),
    };
  }
  return {
    mode: input.mode,
    committed: input.committed,
    verified: true,
    schema: {
      tables: REPAIR_SCHEMA_TABLES.length,
      userForeignKeys: KNOWN_USER_FOREIGN_KEYS.length,
    },
    selection: {
      normalizedLoginUsers: input.mode === "rollback" ? 1 : input.mode === "verify" ? 1 : 2,
      targetGithubAccounts: 1,
      legacySafe: true,
      duplicateAuthSafe: true,
    },
    operations: input.operations,
    dependencies: input.dependencies,
    tables,
    manifestStaged: input.manifestStaged,
    manifestPublished: input.manifestPublished,
  };
}

const USER_PROFILE_SELECT = `SELECT id, name, email,
                                    "emailVerified"::text AS email_verified,
                                    image, login
                               FROM "user"`;

interface UserProfileRow extends RepairRow {
  id: string;
  name: string | null;
  email: string | null;
  email_verified: string | null;
  image: string | null;
  login: string | null;
}

interface TargetAccountRow extends RepairRow {
  user_id: string;
  type: string;
  provider: string;
  provider_account_id: string;
  refresh_token: string | null;
  access_token: string | null;
  token_type: string | null;
  scope: string | null;
  id_token: string | null;
  session_state: string | null;
  expires_at: string | null;
  row_version: string;
}

function profileFromRow(row: UserProfileRow): UserProfile {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.email_verified,
    image: row.image,
    login: row.login,
  };
}

function accountFromRow(row: TargetAccountRow): AccountState {
  return {
    userId: row.user_id,
    type: row.type,
    provider: row.provider,
    providerAccountIdHash: sha256(`account\0${row.provider_account_id}`),
    credentialsHash: sha256(
      canonicalJson({
        refreshToken: row.refresh_token,
        accessToken: row.access_token,
        tokenType: row.token_type,
        scope: row.scope,
        idToken: row.id_token,
        sessionState: row.session_state,
      }),
    ),
    expiresAt: row.expires_at,
    rowVersion: row.row_version,
  };
}

async function getProfile(
  client: GithubIdentityRepairQueryClient,
  id: string,
): Promise<UserProfile | null> {
  const result = await client.query<UserProfileRow>(
    `${USER_PROFILE_SELECT} WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? profileFromRow(result.rows[0]) : null;
}

async function getTargetAccount(
  client: GithubIdentityRepairQueryClient,
  providerAccountId: string,
): Promise<AccountState | null> {
  const result = await client.query<TargetAccountRow>(
    `SELECT xmin::text AS row_version,
            "userId" AS user_id, type, provider,
            "providerAccountId" AS provider_account_id,
            refresh_token, access_token, token_type, scope, id_token, session_state,
            expires_at::text AS expires_at
       FROM account
      WHERE provider = 'github' AND "providerAccountId" = $1`,
    [providerAccountId],
  );
  return result.rows.length === 1 ? accountFromRow(result.rows[0]) : null;
}

async function expectOneRow(
  client: GithubIdentityRepairQueryClient,
  query: string,
  values: unknown[],
): Promise<void> {
  const result = await client.query<{ id: string }>(query, values);
  if (result.rows.length !== 1) {
    throw new GithubIdentityRepairError("WRITE_COUNT_MISMATCH");
  }
}

async function countWhere(
  client: GithubIdentityRepairQueryClient,
  query: string,
  values: unknown[],
): Promise<number> {
  const result = await client.query<{ count: string }>(query, values);
  return parseCount(result.rows[0]?.count);
}

function parseCount(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new GithubIdentityRepairError("INTERNAL");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new GithubIdentityRepairError("INTERNAL");
  }
  return count;
}

function emptyDependencies(): Record<ApplicationDependencyLabel, number> {
  const result = {} as Record<ApplicationDependencyLabel, number>;
  for (const label of APPLICATION_DEPENDENCY_LABELS) result[label] = 0;
  return result;
}

function identityBindings(expectedLogin: string, providerAccountId: string) {
  return {
    normalizedLoginSha256: sha256(`login\0${expectedLogin}`),
    providerAccountIdSha256: sha256(`account\0${providerAccountId}`),
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new GithubIdentityRepairError("INTERNAL");
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalValue(value[key]);
    return sorted;
  }
  throw new GithubIdentityRepairError("INTERNAL");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return leftDigest.equals(rightDigest);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameAccountExceptRowVersion(left: AccountState, right: AccountState): boolean {
  const { rowVersion: leftRowVersion, ...leftComparable } = left;
  const { rowVersion: rightRowVersion, ...rightComparable } = right;
  return (
    typeof leftRowVersion === "string" &&
    typeof rightRowVersion === "string" &&
    sameJson(leftComparable, rightComparable)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return sameStrings(Object.keys(value).sort(), [...expected].sort());
}

function stagedManifestPath(manifestPath: string): string {
  return `${manifestPath}.staged`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
