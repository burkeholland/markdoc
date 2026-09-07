import { createHash } from "node:crypto";
import {
  RECOVERY_CAPTURE_OPERATION,
  RECOVERY_PRODUCTION_BINDING_SUBJECT,
  RECOVERY_PROJECTION_FILES,
  RECOVERY_SCRATCH_SUBJECT,
  RecoveryCustodyError,
  canonicalJson,
  isCanonicalUtcTimestamp,
  withAuthenticatedRecoveryInput,
  type AuthenticatedRecoveryInput,
  type RecoveryAcquisitionHooks,
  type RecoveryAuthorityRoots,
  type RecoveryCustodyReason,
  type RecoveryProjectionName,
} from "./postgres-recovery-custody";

export {
  RECOVERY_ACCEPTED_AUTHORITY_REFERENCE_SCHEMA,
  RECOVERY_CAPTURE_AUTHORITY_SCHEMA,
  RECOVERY_CAPTURE_MANIFEST_SCHEMA,
  RECOVERY_CAPTURE_OPERATION,
  RECOVERY_POLICY_AUTHORITY_SCHEMA,
  RECOVERY_PRODUCTION_BINDING_SUBJECT,
  RECOVERY_PROJECTION_FILES,
  RECOVERY_SCRATCH_AUTHORITY_SCHEMA,
  RECOVERY_SCRATCH_SUBJECT,
  canonicalJson,
  parseCanonicalJsonBytes,
} from "./postgres-recovery-custody";
export type {
  AcceptedAuthorityReference,
  AcceptedFileIdentity,
  AcceptedInputRootIdentity,
  AuthenticatedRecoveryInput,
  RecoveryAcquisitionBoundary,
  RecoveryAcquisitionHookContext,
  RecoveryAcquisitionHooks,
  RecoveryAuthorityRoots,
  RecoveryCaptureAuthority,
  RecoveryCaptureManifest,
  RecoveryFileClaim,
  RecoveryPolicyAuthority,
  RecoveryProjectionName,
  RecoveryScratchAuthority,
} from "./postgres-recovery-custody";

export const RECOVERY_INPUT_SCHEMA = "markdoc-postgres-recovery-projections/v1";
export const RECOVERY_RECEIPT_SCHEMA = "markdoc-postgres-recovery-compatibility/v1";
export const RECOVERY_POLICY_SCHEMA = "markdoc-postgres-recovery-policy/v1";
export const RECOVERY_POLICY_AUTH_SCHEMA = "markdoc-postgres-recovery-policy-authentication/v1";
export const RECOVERY_POLICY_SUBJECT = "markdoc-postgresql-recovery";

export const RECOVERY_POLICY = Object.freeze({
  maximum_unarchived_data_seconds: 300,
  maximum_observation_age_seconds: 900,
  maximum_scratch_restore_age_seconds: 604_800,
});

export type RecoveryDecision = "STOP" | "MALFORMED";

export type RecoveryReason =
  | RecoveryCustodyReason
  | "ACTIVE_PACKAGE_VERSION_MISMATCH"
  | "ARCHIVE_CONFIGURATION_FUTURE"
  | "ARCHIVE_CONFIGURATION_MISMATCH"
  | "ARCHIVE_REPOSITORY_MISMATCH"
  | "ARCHIVE_SPOOL_ERROR"
  | "ARCHIVE_STATUS_MISSING"
  | "ARCHIVE_UNRESOLVED_FAILURE"
  | "BACKUP_ABSENT"
  | "BACKUP_ERROR"
  | "BACKUP_HEALTH_FUTURE"
  | "BACKUP_HEALTH_STALE"
  | "BACKUP_HEALTH_UNHEALTHY"
  | "BACKUP_INCOMPLETE"
  | "BACKUP_MAJOR_MISMATCH"
  | "BACKUP_SELECTION_AMBIGUOUS"
  | "BACKUP_TIMESTAMP_FUTURE"
  | "BINDING_COUNT_INVALID"
  | "BINDING_STATE_INVALID"
  | "BINDING_TYPE_MISMATCH"
  | "DATA_BINARY_MAJOR_MISMATCH"
  | "ENGINE_CHANGE_FUTURE"
  | "HISTORY_AMBIGUOUS"
  | "HISTORY_ABSENT"
  | "HELD_NON_OPERATIONAL"
  | "INPUT_SCHEMA_INVALID"
  | "INPUT_UNKNOWN_FIELD"
  | "MIXED_REPOSITORY"
  | "OBSERVATION_FUTURE"
  | "OBSERVATION_STALE"
  | "POLICY_ABSENT"
  | "POLICY_AUTHENTICATION_ABSENT"
  | "POLICY_AUTHENTICATION_INVALID"
  | "POLICY_AUTHORITY_FUTURE"
  | "POLICY_AUTHORITY_REPLAYED"
  | "POLICY_AUTHORITY_STALE"
  | "POLICY_DUPLICATE"
  | "POLICY_SUBJECT_MISMATCH"
  | "POLICY_VALUES_MISMATCH"
  | "POLICY_VERSION_MISMATCH"
  | "REPOSITORY_UNHEALTHY"
  | "RPO_OBJECTIVE_EXCEEDED"
  | "SCRATCH_AUTHORIZATION_INVALID"
  | "SCRATCH_CLEANUP_INCOMPLETE"
  | "SCRATCH_NOT_FRESH_AFTER_CHANGE"
  | "SCRATCH_NOT_ISOLATED"
  | "SCRATCH_RESTORE_FAILED"
  | "SCRATCH_RESTORE_FUTURE"
  | "SCRATCH_RESTORE_STALE"
  | "SYSTEM_ID_MISMATCH"
  | "VM_RECOVERY_FUTURE"
  | "VM_RECOVERY_KIND_INVALID";

interface PgVersionProjection {
  schema: "markdoc-recovery-pg-version/v1";
  major: string;
}

interface ActiveBinaryVersionProjection {
  schema: "markdoc-recovery-active-binary-version/v1";
  full_version: string;
}

interface InstalledPackageVersionProjection {
  schema: "markdoc-recovery-installed-package-version/v1";
  installed_version: string;
  upstream_full_version: string;
  changed_at: string;
}

interface ControlDataProjection {
  schema: "markdoc-recovery-control-data/v1";
  system_identifier: string;
}

interface PgBackRestRepository {
  key: number;
  status_code: number;
}

interface PgBackRestBackup {
  status: "complete" | "incomplete";
  error_code: number;
  timestamp: {
    start: string;
    stop: string;
  };
  database: {
    id: number;
    repo_key: number;
  };
}

interface PgBackRestHistory {
  id: number;
  repo_key: number;
  system_identifier: string;
  version: string;
}

interface PgBackRestInfoProjection {
  schema: "markdoc-recovery-pgbackrest-info/v1";
  stanza_status_code: number;
  repositories: PgBackRestRepository[];
  backups: PgBackRestBackup[];
  history: PgBackRestHistory[];
  incomplete_operation_count: number;
}

interface ArchiveConfigurationProjection {
  schema: "markdoc-recovery-archive-configuration/v1";
  wal_level: "replica" | "logical" | "minimal";
  archive_mode: "on" | "off" | "always";
  archive_command_kind: "pgbackrest-archive-push" | "other" | "empty";
  archive_timeout_seconds: number;
  repo_key: number;
  changed_at: string;
}

interface ArchiveStateProjection {
  schema: "markdoc-recovery-archive-state/v1";
  status_directory_present: boolean;
  repo_key: number;
  pending_ready: Array<{ age_seconds: number }>;
  spool_error_count: number;
  unresolved_failure: boolean;
}

interface BackupHealthProjection {
  schema: "markdoc-recovery-backup-health/v1";
  status: "ok" | "error";
  observed_at: string;
  repository_healthy: boolean;
  archive_healthy: boolean;
  operation_complete: boolean;
}

interface ScratchRestoreProjection {
  schema: "markdoc-recovery-scratch-restore/v1";
  status: "succeeded" | "failed" | "incomplete";
  completed_at: string;
  isolated: boolean;
  cleanup_complete: boolean;
  authorization: "verified-separate" | "absent" | "invalid";
}

interface ProductionBindingProjection {
  schema: "markdoc-recovery-production-binding/v1";
  subject: typeof RECOVERY_PRODUCTION_BINDING_SUBJECT | "other";
  kind: "production-postgresql-vm" | "other";
  state: "active" | "changed" | "deleted";
  binding_count: number;
}

interface ObservationClockProjection {
  schema: "markdoc-recovery-observation-clock/v1";
  observed_at: string;
  decision_at: string;
  observation_nonce: string;
}

interface RecoveryPolicyPayload {
  schema: typeof RECOVERY_POLICY_SCHEMA;
  subject: string;
  version: number;
  maximum_unarchived_data_seconds: number;
  maximum_observation_age_seconds: number;
  maximum_scratch_restore_age_seconds: number;
}

interface RecoveryPolicyAuthentication {
  schema: typeof RECOVERY_POLICY_AUTH_SCHEMA;
  status: "authenticated" | "unauthenticated";
  subject: string;
  policy_version: number;
  policy_sha256: string;
  authenticated_at: string;
  valid_until: string;
  observation_nonce: string;
  use_count: number;
}

interface RecoveryPolicyProjection {
  schema: "markdoc-recovery-rpo-policy-set/v1";
  policies: Array<{
    policy: RecoveryPolicyPayload;
    authentication?: RecoveryPolicyAuthentication;
  }>;
}

interface VmRecoveryProjection {
  schema: "markdoc-recovery-vm-recovery/v1";
  kind: "discrete-filesystem-consistent" | "other";
  recovery_point_utc: string;
}

export interface RecoveryProjectionSet {
  pg_version: PgVersionProjection;
  active_binary_version: ActiveBinaryVersionProjection;
  installed_package_version: InstalledPackageVersionProjection;
  control_data: ControlDataProjection;
  pgbackrest_info: PgBackRestInfoProjection;
  archive_configuration: ArchiveConfigurationProjection;
  archive_state: ArchiveStateProjection;
  backup_health: BackupHealthProjection;
  scratch_restore: ScratchRestoreProjection;
  production_binding: ProductionBindingProjection;
  observation_clock: ObservationClockProjection;
  rpo_policy: RecoveryPolicyProjection;
  vm_recovery: VmRecoveryProjection;
}

export interface RecoveryReceipt {
  schema: typeof RECOVERY_RECEIPT_SCHEMA;
  observed_at: string | null;
  binding_count: number | null;
  engine: {
    active_full: string | null;
    installed_full: string | null;
    data_major: number | null;
    backup_major: number | null;
    same_major: boolean | null;
    full_versions_equal: boolean | null;
    same_system_id: boolean | null;
    physical_compatible: boolean;
  };
  archive: {
    effective_config_matches: boolean | null;
    archive_timeout_seconds: number | null;
    pending_count: number | null;
    oldest_pending_age_seconds: number | null;
    spool_error_count: number | null;
    health_age_seconds: number | null;
    unarchived_age_bound_seconds: number | null;
    objective_seconds: number | null;
    meets_objective: boolean | null;
  };
  vm_recovery: {
    kind: "discrete-filesystem-consistent" | null;
    pitr: false;
    recovery_point_utc: string | null;
  };
  scratch_restore: {
    fresh_after_engine_change: boolean | null;
    within_drill_age: boolean | null;
  };
  decision: RecoveryDecision;
  reasons: RecoveryReason[];
}

class ProjectionError extends Error {
  constructor(
    readonly reason: Extract<
      RecoveryReason,
      | "INPUT_FIELD_INVALID"
      | "INPUT_FILE_UNEXPECTED"
      | "INPUT_JSON_INVALID"
      | "INPUT_ROOT_INVALID"
      | "INPUT_ROOT_NOT_ABSOLUTE"
      | "INPUT_SCHEMA_INVALID"
      | "INPUT_UNKNOWN_FIELD"
    >,
  ) {
    super(reason);
    this.name = "ProjectionError";
  }
}

type JsonObject = Record<string, unknown>;

const MAJOR = /^[1-9]\d{0,2}$/;
const FULL_VERSION = /^[1-9]\d{0,2}\.\d+(?:\.\d+)?$/;
const HISTORY_VERSION = /^[1-9]\d{0,2}(?:\.\d+){0,2}$/;
const PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,127}$/;
const SYSTEM_IDENTIFIER = /^\d{10,32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function emptyReceipt(reason: RecoveryReason, decision: RecoveryDecision): RecoveryReceipt {
  return {
    schema: RECOVERY_RECEIPT_SCHEMA,
    observed_at: null,
    binding_count: null,
    engine: {
      active_full: null,
      installed_full: null,
      data_major: null,
      backup_major: null,
      same_major: null,
      full_versions_equal: null,
      same_system_id: null,
      physical_compatible: false,
    },
    archive: {
      effective_config_matches: null,
      archive_timeout_seconds: null,
      pending_count: null,
      oldest_pending_age_seconds: null,
      spool_error_count: null,
      health_age_seconds: null,
      unarchived_age_bound_seconds: null,
      objective_seconds: null,
      meets_objective: null,
    },
    vm_recovery: {
      kind: null,
      pitr: false,
      recovery_point_utc: null,
    },
    scratch_restore: {
      fresh_after_engine_change: null,
      within_drill_age: null,
    },
    decision,
    reasons: [reason],
  };
}

function malformedReceipt(reason: RecoveryReason): RecoveryReceipt {
  return emptyReceipt(reason, "MALFORMED");
}

function stoppedReceipt(reason: RecoveryReason): RecoveryReceipt {
  return emptyReceipt(reason, "STOP");
}

function asObject(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectionError("INPUT_FIELD_INVALID");
  }
  return value as JsonObject;
}

function exactKeys(object: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(object).some((key) => !allowed.has(key))) {
    throw new ProjectionError("INPUT_UNKNOWN_FIELD");
  }
  if (required.some((key) => !Object.hasOwn(object, key))) {
    throw new ProjectionError("INPUT_FIELD_INVALID");
  }
}

function schema(object: JsonObject, expected: string): void {
  if (object.schema !== expected) throw new ProjectionError("INPUT_SCHEMA_INVALID");
}

function stringField(object: JsonObject, key: string, pattern?: RegExp): string {
  const value = object[key];
  if (typeof value !== "string" || (pattern && !pattern.test(value))) {
    throw new ProjectionError("INPUT_FIELD_INVALID");
  }
  return value;
}

function numberField(object: JsonObject, key: string, options: { min?: number; max?: number } = {}): number {
  const value = object[key];
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || (options.min !== undefined && value < options.min)
    || (options.max !== undefined && value > options.max)
  ) {
    throw new ProjectionError("INPUT_FIELD_INVALID");
  }
  return value;
}

function booleanField(object: JsonObject, key: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") throw new ProjectionError("INPUT_FIELD_INVALID");
  return value;
}

function enumField<const T extends readonly string[]>(object: JsonObject, key: string, values: T): T[number] {
  const value = stringField(object, key);
  if (!values.includes(value)) throw new ProjectionError("INPUT_FIELD_INVALID");
  return value;
}

function arrayField(object: JsonObject, key: string, maximum = 10_000): unknown[] {
  const value = object[key];
  if (!Array.isArray(value) || value.length > maximum) throw new ProjectionError("INPUT_FIELD_INVALID");
  return value;
}

function timestampField(object: JsonObject, key: string): string {
  const value = stringField(object, key);
  if (!isCanonicalUtcTimestamp(value)) throw new ProjectionError("INPUT_FIELD_INVALID");
  return value;
}

function parsePgVersion(value: unknown): PgVersionProjection {
  const object = asObject(value);
  exactKeys(object, ["schema", "major"]);
  schema(object, "markdoc-recovery-pg-version/v1");
  return { schema: "markdoc-recovery-pg-version/v1", major: stringField(object, "major", MAJOR) };
}

function parseActiveBinaryVersion(value: unknown): ActiveBinaryVersionProjection {
  const object = asObject(value);
  exactKeys(object, ["schema", "full_version"]);
  schema(object, "markdoc-recovery-active-binary-version/v1");
  return {
    schema: "markdoc-recovery-active-binary-version/v1",
    full_version: stringField(object, "full_version", FULL_VERSION),
  };
}

function parseInstalledPackageVersion(value: unknown): InstalledPackageVersionProjection {
  const object = asObject(value);
  exactKeys(object, ["schema", "installed_version", "upstream_full_version", "changed_at"]);
  schema(object, "markdoc-recovery-installed-package-version/v1");
  const installedVersion = stringField(object, "installed_version", PACKAGE_VERSION);
  const upstreamFullVersion = stringField(object, "upstream_full_version", FULL_VERSION);
  const versionWithoutEpoch = installedVersion.includes(":")
    ? installedVersion.slice(installedVersion.indexOf(":") + 1)
    : installedVersion;
  const projectedUpstream = versionWithoutEpoch.match(/^([1-9]\d{0,2}\.\d+(?:\.\d+)?)(?:[-+~]|$)/)?.[1];
  if (projectedUpstream !== upstreamFullVersion) throw new ProjectionError("INPUT_FIELD_INVALID");
  return {
    schema: "markdoc-recovery-installed-package-version/v1",
    installed_version: installedVersion,
    upstream_full_version: upstreamFullVersion,
    changed_at: timestampField(object, "changed_at"),
  };
}

function parseControlData(value: unknown): ControlDataProjection {
  const object = asObject(value);
  exactKeys(object, ["schema", "system_identifier"]);
  schema(object, "markdoc-recovery-control-data/v1");
  return {
    schema: "markdoc-recovery-control-data/v1",
    system_identifier: stringField(object, "system_identifier", SYSTEM_IDENTIFIER),
  };
}

function parseRepository(value: unknown): PgBackRestRepository {
  const object = asObject(value);
  exactKeys(object, ["key", "status_code"]);
  return {
    key: numberField(object, "key", { min: 1, max: 1_000 }),
    status_code: numberField(object, "status_code", { min: 0, max: 255 }),
  };
}

function parseBackup(value: unknown): PgBackRestBackup {
  const object = asObject(value);
  exactKeys(object, ["status", "error_code", "timestamp", "database"]);
  const timestamp = asObject(object.timestamp);
  exactKeys(timestamp, ["start", "stop"]);
  const database = asObject(object.database);
  exactKeys(database, ["id", "repo_key"]);
  return {
    status: enumField(object, "status", ["complete", "incomplete"] as const),
    error_code: numberField(object, "error_code", { min: 0, max: 255 }),
    timestamp: {
      start: timestampField(timestamp, "start"),
      stop: timestampField(timestamp, "stop"),
    },
    database: {
      id: numberField(database, "id", { min: 1, max: 1_000_000 }),
      repo_key: numberField(database, "repo_key", { min: 1, max: 1_000 }),
    },
  };
}

function parseHistory(value: unknown): PgBackRestHistory {
  const object = asObject(value);
  exactKeys(object, ["id", "repo_key", "system_identifier", "version"]);
  return {
    id: numberField(object, "id", { min: 1, max: 1_000_000 }),
    repo_key: numberField(object, "repo_key", { min: 1, max: 1_000 }),
    system_identifier: stringField(object, "system_identifier", SYSTEM_IDENTIFIER),
    version: stringField(object, "version", HISTORY_VERSION),
  };
}

function parsePgBackRestInfo(value: unknown): PgBackRestInfoProjection {
  const object = asObject(value);
  exactKeys(object, ["schema", "stanza_status_code", "repositories", "backups", "history", "incomplete_operation_count"]);
  schema(object, "markdoc-recovery-pgbackrest-info/v1");
  return {
    schema: "markdoc-recovery-pgbackrest-info/v1",
    stanza_status_code: numberField(object, "stanza_status_code", { min: 0, max: 255 }),
    repositories: arrayField(object, "repositories", 16).map(parseRepository),
    backups: arrayField(object, "backups", 10_000).map(parseBackup),
    history: arrayField(object, "history", 1_000).map(parseHistory),
    incomplete_operation_count: numberField(object, "incomplete_operation_count", { min: 0, max: 1_000 }),
  };
}

function parseArchiveConfiguration(value: unknown): ArchiveConfigurationProjection {
  const object = asObject(value);
  exactKeys(object, ["schema", "wal_level", "archive_mode", "archive_command_kind", "archive_timeout_seconds", "repo_key", "changed_at"]);
  schema(object, "markdoc-recovery-archive-configuration/v1");
  return {
    schema: "markdoc-recovery-archive-configuration/v1",
    wal_level: enumField(object, "wal_level", ["replica", "logical", "minimal"] as const),
    archive_mode: enumField(object, "archive_mode", ["on", "off", "always"] as const),
    archive_command_kind: enumField(object, "archive_command_kind", ["pgbackrest-archive-push", "other", "empty"] as const),
    archive_timeout_seconds: numberField(object, "archive_timeout_seconds", { min: 0, max: 86_400 }),
    repo_key: numberField(object, "repo_key", { min: 1, max: 1_000 }),
    changed_at: timestampField(object, "changed_at"),
  };
}

function parseArchiveState(value: unknown): ArchiveStateProjection {
  const object = asObject(value);
  exactKeys(object, ["schema", "status_directory_present", "repo_key", "pending_ready", "spool_error_count", "unresolved_failure"]);
  schema(object, "markdoc-recovery-archive-state/v1");
  const pendingReady = arrayField(object, "pending_ready", 100_000).map((item) => {
    const pending = asObject(item);
    exactKeys(pending, ["age_seconds"]);
    return { age_seconds: numberField(pending, "age_seconds", { min: 1, max: 31_536_000 }) };
  });
  return {
    schema: "markdoc-recovery-archive-state/v1",
    status_directory_present: booleanField(object, "status_directory_present"),
    repo_key: numberField(object, "repo_key", { min: 1, max: 1_000 }),
    pending_ready: pendingReady,
    spool_error_count: numberField(object, "spool_error_count", { min: 0, max: 1_000_000 }),
    unresolved_failure: booleanField(object, "unresolved_failure"),
  };
}

function parseBackupHealth(value: unknown): BackupHealthProjection {
  const object = asObject(value);
  exactKeys(object, ["schema", "status", "observed_at", "repository_healthy", "archive_healthy", "operation_complete"]);
  schema(object, "markdoc-recovery-backup-health/v1");
  return {
    schema: "markdoc-recovery-backup-health/v1",
    status: enumField(object, "status", ["ok", "error"] as const),
    observed_at: timestampField(object, "observed_at"),
    repository_healthy: booleanField(object, "repository_healthy"),
    archive_healthy: booleanField(object, "archive_healthy"),
    operation_complete: booleanField(object, "operation_complete"),
  };
}

function parseScratchRestore(value: unknown): ScratchRestoreProjection {
  const object = asObject(value);
  exactKeys(object, ["schema", "status", "completed_at", "isolated", "cleanup_complete", "authorization"]);
  schema(object, "markdoc-recovery-scratch-restore/v1");
  return {
    schema: "markdoc-recovery-scratch-restore/v1",
    status: enumField(object, "status", ["succeeded", "failed", "incomplete"] as const),
    completed_at: timestampField(object, "completed_at"),
    isolated: booleanField(object, "isolated"),
    cleanup_complete: booleanField(object, "cleanup_complete"),
    authorization: enumField(object, "authorization", ["verified-separate", "absent", "invalid"] as const),
  };
}

function parseProductionBinding(value: unknown): ProductionBindingProjection {
  const object = asObject(value);
  exactKeys(object, ["schema", "subject", "kind", "state", "binding_count"]);
  schema(object, "markdoc-recovery-production-binding/v1");
  return {
    schema: "markdoc-recovery-production-binding/v1",
    subject: enumField(object, "subject", [RECOVERY_PRODUCTION_BINDING_SUBJECT, "other"] as const),
    kind: enumField(object, "kind", ["production-postgresql-vm", "other"] as const),
    state: enumField(object, "state", ["active", "changed", "deleted"] as const),
    binding_count: numberField(object, "binding_count", { min: 0, max: 1_000 }),
  };
}

function parseObservationClock(value: unknown): ObservationClockProjection {
  const object = asObject(value);
  exactKeys(object, ["schema", "observed_at", "decision_at", "observation_nonce"]);
  schema(object, "markdoc-recovery-observation-clock/v1");
  return {
    schema: "markdoc-recovery-observation-clock/v1",
    observed_at: timestampField(object, "observed_at"),
    decision_at: timestampField(object, "decision_at"),
    observation_nonce: stringField(object, "observation_nonce", NONCE),
  };
}

function parsePolicyPayload(value: unknown): RecoveryPolicyPayload {
  const object = asObject(value);
  exactKeys(object, [
    "schema",
    "subject",
    "version",
    "maximum_unarchived_data_seconds",
    "maximum_observation_age_seconds",
    "maximum_scratch_restore_age_seconds",
  ]);
  schema(object, RECOVERY_POLICY_SCHEMA);
  return {
    schema: RECOVERY_POLICY_SCHEMA,
    subject: stringField(object, "subject"),
    version: numberField(object, "version", { min: 1, max: 1_000 }),
    maximum_unarchived_data_seconds: numberField(object, "maximum_unarchived_data_seconds", { min: 0, max: 86_400 }),
    maximum_observation_age_seconds: numberField(object, "maximum_observation_age_seconds", { min: 0, max: 86_400 }),
    maximum_scratch_restore_age_seconds: numberField(object, "maximum_scratch_restore_age_seconds", { min: 0, max: 31_536_000 }),
  };
}

function parsePolicyAuthentication(value: unknown): RecoveryPolicyAuthentication {
  const object = asObject(value);
  exactKeys(object, [
    "schema",
    "status",
    "subject",
    "policy_version",
    "policy_sha256",
    "authenticated_at",
    "valid_until",
    "observation_nonce",
    "use_count",
  ]);
  schema(object, RECOVERY_POLICY_AUTH_SCHEMA);
  return {
    schema: RECOVERY_POLICY_AUTH_SCHEMA,
    status: enumField(object, "status", ["authenticated", "unauthenticated"] as const),
    subject: stringField(object, "subject"),
    policy_version: numberField(object, "policy_version", { min: 1, max: 1_000 }),
    policy_sha256: stringField(object, "policy_sha256", SHA256),
    authenticated_at: timestampField(object, "authenticated_at"),
    valid_until: timestampField(object, "valid_until"),
    observation_nonce: stringField(object, "observation_nonce", NONCE),
    use_count: numberField(object, "use_count", { min: 0, max: 1_000 }),
  };
}

function parseRpoPolicy(value: unknown): RecoveryPolicyProjection {
  const object = asObject(value);
  exactKeys(object, ["schema", "policies"]);
  schema(object, "markdoc-recovery-rpo-policy-set/v1");
  const policies = arrayField(object, "policies", 16).map((item) => {
    const entry = asObject(item);
    exactKeys(entry, ["policy"], ["authentication"]);
    return {
      policy: parsePolicyPayload(entry.policy),
      ...(entry.authentication === undefined ? {} : { authentication: parsePolicyAuthentication(entry.authentication) }),
    };
  });
  return { schema: "markdoc-recovery-rpo-policy-set/v1", policies };
}

function parseVmRecovery(value: unknown): VmRecoveryProjection {
  const object = asObject(value);
  exactKeys(object, ["schema", "kind", "recovery_point_utc"]);
  schema(object, "markdoc-recovery-vm-recovery/v1");
  return {
    schema: "markdoc-recovery-vm-recovery/v1",
    kind: enumField(object, "kind", ["discrete-filesystem-consistent", "other"] as const),
    recovery_point_utc: timestampField(object, "recovery_point_utc"),
  };
}

const PARSERS: {
  [K in RecoveryProjectionName]: (value: unknown) => RecoveryProjectionSet[K];
} = {
  pg_version: parsePgVersion,
  active_binary_version: parseActiveBinaryVersion,
  installed_package_version: parseInstalledPackageVersion,
  control_data: parseControlData,
  pgbackrest_info: parsePgBackRestInfo,
  archive_configuration: parseArchiveConfiguration,
  archive_state: parseArchiveState,
  backup_health: parseBackupHealth,
  scratch_restore: parseScratchRestore,
  production_binding: parseProductionBinding,
  observation_clock: parseObservationClock,
  rpo_policy: parseRpoPolicy,
  vm_recovery: parseVmRecovery,
};

export function recoveryPolicySha256(policy: RecoveryPolicyPayload): string {
  return createHash("sha256").update(canonicalJson(policy), "utf8").digest("hex");
}

interface SelectedBackup {
  backup: PgBackRestBackup | null;
  ambiguous: boolean;
}

function selectBackupAscending(info: PgBackRestInfoProjection): SelectedBackup {
  const candidates = info.backups
    .filter((backup) => backup.status === "complete" && backup.error_code === 0)
    .toSorted((left, right) => Date.parse(right.timestamp.stop) - Date.parse(left.timestamp.stop));
  const ambiguous = candidates.length > 1
    && epoch(candidates[0].timestamp.stop) === epoch(candidates[1].timestamp.stop);
  return {
    backup: ambiguous ? null : candidates[0] ?? null,
    ambiguous,
  };
}

function selectBackupByReduction(info: PgBackRestInfoProjection): SelectedBackup {
  let newest: PgBackRestBackup | null = null;
  let ambiguous = false;
  for (let index = info.backups.length - 1; index >= 0; index -= 1) {
    const backup = info.backups[index];
    if (backup.status !== "complete" || backup.error_code !== 0) continue;
    if (!newest || Date.parse(backup.timestamp.stop) > Date.parse(newest.timestamp.stop)) {
      newest = backup;
      ambiguous = false;
    } else if (epoch(backup.timestamp.stop) === epoch(newest.timestamp.stop)) {
      ambiguous = true;
    }
  }
  return { backup: ambiguous ? null : newest, ambiguous };
}

interface EvaluationFacts {
  input: RecoveryProjectionSet;
  selected: SelectedBackup;
  matchedHistory: PgBackRestHistory[];
  observedMs: number;
  decisionMs: number;
  activeMajor: number;
  dataMajor: number;
  backupMajor: number | null;
  policyEntry: RecoveryPolicyProjection["policies"][number] | null;
  policyValid: boolean;
  configMatches: boolean;
  repositoryHealthy: boolean;
  repositoryMatches: boolean;
  pendingCount: number;
  oldestPendingAge: number;
  healthAge: number;
  healthFresh: boolean;
  observationCurrent: boolean;
  archiveHealthy: boolean;
  unarchivedBound: number | null;
  scratchAgeMilliseconds: number;
  scratchFreshAfterChange: boolean;
  scratchWithinDrillAge: boolean;
}

type Check = (facts: EvaluationFacts, reasons: Set<RecoveryReason>) => void;

function epoch(timestamp: string): number {
  return Date.parse(timestamp);
}

function majorOf(version: string): number {
  return Number(version.split(".")[0]);
}

function conservativeAgeSeconds(milliseconds: number): number {
  return milliseconds >= 0
    ? Math.ceil(milliseconds / 1_000)
    : Math.floor(milliseconds / 1_000);
}

function buildFacts(
  input: RecoveryProjectionSet,
  selected: SelectedBackup,
): EvaluationFacts {
  const matchedHistory = selected.backup
    ? input.pgbackrest_info.history.filter(
        (row) => row.id === selected.backup?.database.id && row.repo_key === selected.backup.database.repo_key,
      )
    : [];
  const policyEntry = input.rpo_policy.policies.length === 1 ? input.rpo_policy.policies[0] : null;
  const observedMs = epoch(input.observation_clock.observed_at);
  const decisionMs = epoch(input.observation_clock.decision_at);
  const healthAgeMilliseconds = observedMs - epoch(input.backup_health.observed_at);
  const healthAge = conservativeAgeSeconds(healthAgeMilliseconds);
  const pendingCount = input.archive_state.pending_ready.length;
  const oldestPendingAge = pendingCount === 0
    ? 0
    : Math.max(...input.archive_state.pending_ready.map((pending) => pending.age_seconds));
  const selectedRepo = selected.backup?.database.repo_key ?? null;
  const repositoryMatches = selectedRepo !== null
    && input.archive_configuration.repo_key === selectedRepo
    && input.archive_state.repo_key === selectedRepo;
  const repositoryHealthy = input.pgbackrest_info.stanza_status_code === 0
    && selectedRepo !== null
    && input.pgbackrest_info.repositories.length === 1
    && input.pgbackrest_info.repositories[0].key === selectedRepo
    && input.pgbackrest_info.repositories[0].status_code === 0;
  const configMatches = input.archive_configuration.wal_level === "replica"
    && input.archive_configuration.archive_mode === "on"
    && input.archive_configuration.archive_command_kind === "pgbackrest-archive-push"
    && input.archive_configuration.archive_timeout_seconds === 240;
  const observationCurrent = observedMs <= decisionMs
    && decisionMs - observedMs <= RECOVERY_POLICY.maximum_observation_age_seconds * 1_000;
  const healthFresh = healthAgeMilliseconds >= 0
    && healthAgeMilliseconds <= RECOVERY_POLICY.maximum_observation_age_seconds * 1_000;
  const latestChange = Math.max(
    epoch(input.installed_package_version.changed_at),
    epoch(input.archive_configuration.changed_at),
  );
  const scratchAgeMilliseconds = observedMs - epoch(input.scratch_restore.completed_at);
  const scratchFreshAfterChange = epoch(input.scratch_restore.completed_at) >= latestChange;
  const policyValid = policyEntry !== null
    && policyEntry.policy.subject === RECOVERY_POLICY_SUBJECT
    && policyEntry.policy.version === 1
    && policyEntry.policy.maximum_unarchived_data_seconds === RECOVERY_POLICY.maximum_unarchived_data_seconds
    && policyEntry.policy.maximum_observation_age_seconds === RECOVERY_POLICY.maximum_observation_age_seconds
    && policyEntry.policy.maximum_scratch_restore_age_seconds === RECOVERY_POLICY.maximum_scratch_restore_age_seconds
    && policyEntry.authentication !== undefined
    && policyEntry.authentication.status === "authenticated"
    && policyEntry.authentication.subject === RECOVERY_POLICY_SUBJECT
    && policyEntry.authentication.policy_version === 1
    && policyEntry.authentication.policy_sha256 === recoveryPolicySha256(policyEntry.policy)
    && policyEntry.authentication.observation_nonce === input.observation_clock.observation_nonce
    && policyEntry.authentication.use_count === 1
    && epoch(policyEntry.authentication.authenticated_at) <= observedMs
    && observedMs - epoch(policyEntry.authentication.authenticated_at) <= RECOVERY_POLICY.maximum_observation_age_seconds * 1_000
    && epoch(policyEntry.authentication.valid_until) >= decisionMs;
  const archiveHealthy = repositoryHealthy
    && repositoryMatches
    && configMatches
    && epoch(input.archive_configuration.changed_at) <= observedMs
    && input.archive_state.status_directory_present
    && input.archive_state.spool_error_count === 0
    && !input.archive_state.unresolved_failure
    && input.backup_health.status === "ok"
    && input.backup_health.repository_healthy
    && input.backup_health.archive_healthy
    && input.backup_health.operation_complete
    && healthFresh
    && observationCurrent;
  const unarchivedBound = archiveHealthy && policyValid
    ? input.archive_configuration.archive_timeout_seconds + oldestPendingAge
    : null;
  const scratchWithinDrillAge = policyValid
    && scratchAgeMilliseconds >= 0
    && scratchAgeMilliseconds <= policyEntry.policy.maximum_scratch_restore_age_seconds * 1_000;

  return {
    input,
    selected,
    matchedHistory,
    observedMs,
    decisionMs,
    activeMajor: majorOf(input.active_binary_version.full_version),
    dataMajor: Number(input.pg_version.major),
    backupMajor: matchedHistory.length === 1 ? majorOf(matchedHistory[0].version) : null,
    policyEntry,
    policyValid,
    configMatches,
    repositoryHealthy,
    repositoryMatches,
    pendingCount,
    oldestPendingAge,
    healthAge,
    healthFresh,
    observationCurrent,
    archiveHealthy,
    unarchivedBound,
    scratchAgeMilliseconds,
    scratchFreshAfterChange,
    scratchWithinDrillAge,
  };
}

const checkBinding: Check = ({ input }, reasons) => {
  if (input.production_binding.subject !== RECOVERY_PRODUCTION_BINDING_SUBJECT) reasons.add("BINDING_TYPE_MISMATCH");
  if (input.production_binding.binding_count !== 1) reasons.add("BINDING_COUNT_INVALID");
  if (input.production_binding.kind !== "production-postgresql-vm") reasons.add("BINDING_TYPE_MISMATCH");
  if (input.production_binding.state !== "active") reasons.add("BINDING_STATE_INVALID");
};

const checkClock: Check = ({ observedMs, decisionMs }, reasons) => {
  if (observedMs > decisionMs) reasons.add("OBSERVATION_FUTURE");
  if (decisionMs - observedMs > RECOVERY_POLICY.maximum_observation_age_seconds * 1_000) {
    reasons.add("OBSERVATION_STALE");
  }
};

const checkPolicy: Check = ({ input, policyEntry, observedMs, decisionMs }, reasons) => {
  if (input.rpo_policy.policies.length === 0) {
    reasons.add("POLICY_ABSENT");
    return;
  }
  if (input.rpo_policy.policies.length !== 1) {
    reasons.add("POLICY_DUPLICATE");
    return;
  }
  if (!policyEntry) return;
  const { policy, authentication } = policyEntry;
  if (policy.subject !== RECOVERY_POLICY_SUBJECT) reasons.add("POLICY_SUBJECT_MISMATCH");
  if (policy.version !== 1) reasons.add("POLICY_VERSION_MISMATCH");
  if (
    policy.maximum_unarchived_data_seconds !== RECOVERY_POLICY.maximum_unarchived_data_seconds
    || policy.maximum_observation_age_seconds !== RECOVERY_POLICY.maximum_observation_age_seconds
    || policy.maximum_scratch_restore_age_seconds !== RECOVERY_POLICY.maximum_scratch_restore_age_seconds
  ) {
    reasons.add("POLICY_VALUES_MISMATCH");
  }
  if (!authentication) {
    reasons.add("POLICY_AUTHENTICATION_ABSENT");
    return;
  }
  if (
    authentication.status !== "authenticated"
    || authentication.subject !== policy.subject
    || authentication.policy_version !== policy.version
    || authentication.policy_sha256 !== recoveryPolicySha256(policy)
  ) {
    reasons.add("POLICY_AUTHENTICATION_INVALID");
  }
  const authenticatedMs = epoch(authentication.authenticated_at);
  if (authenticatedMs > observedMs) reasons.add("POLICY_AUTHORITY_FUTURE");
  if (
    observedMs - authenticatedMs > RECOVERY_POLICY.maximum_observation_age_seconds * 1_000
    || epoch(authentication.valid_until) < decisionMs
  ) {
    reasons.add("POLICY_AUTHORITY_STALE");
  }
  if (
    authentication.observation_nonce !== input.observation_clock.observation_nonce
    || authentication.use_count !== 1
  ) {
    reasons.add("POLICY_AUTHORITY_REPLAYED");
  }
};

const checkBackup: Check = ({ input, selected, matchedHistory, observedMs }, reasons) => {
  if (input.pgbackrest_info.incomplete_operation_count > 0) reasons.add("BACKUP_INCOMPLETE");
  if (input.pgbackrest_info.backups.some((backup) => backup.status === "incomplete")) reasons.add("BACKUP_INCOMPLETE");
  if (input.pgbackrest_info.backups.some((backup) => backup.error_code !== 0)) reasons.add("BACKUP_ERROR");
  if (selected.ambiguous) reasons.add("BACKUP_SELECTION_AMBIGUOUS");
  if (!selected.backup) {
    if (!selected.ambiguous) reasons.add("BACKUP_ABSENT");
    return;
  }
  if (epoch(selected.backup.timestamp.stop) > observedMs || epoch(selected.backup.timestamp.start) > epoch(selected.backup.timestamp.stop)) {
    reasons.add("BACKUP_TIMESTAMP_FUTURE");
  }
  if (matchedHistory.length === 0) reasons.add("HISTORY_ABSENT");
  if (matchedHistory.length > 1) reasons.add("HISTORY_AMBIGUOUS");
  const repoKeys = new Set([
    ...input.pgbackrest_info.repositories.map((repository) => repository.key),
    ...input.pgbackrest_info.backups.map((backup) => backup.database.repo_key),
    ...input.pgbackrest_info.history.map((history) => history.repo_key),
  ]);
  if (repoKeys.size !== 1) reasons.add("MIXED_REPOSITORY");
};

const checkEngine: Check = ({ input, dataMajor, activeMajor, backupMajor, matchedHistory, observedMs }, reasons) => {
  if (dataMajor !== activeMajor) reasons.add("DATA_BINARY_MAJOR_MISMATCH");
  if (backupMajor !== null && backupMajor !== activeMajor) reasons.add("BACKUP_MAJOR_MISMATCH");
  if (input.active_binary_version.full_version !== input.installed_package_version.upstream_full_version) {
    reasons.add("ACTIVE_PACKAGE_VERSION_MISMATCH");
  }
  if (matchedHistory.length === 1 && matchedHistory[0].system_identifier !== input.control_data.system_identifier) {
    reasons.add("SYSTEM_ID_MISMATCH");
  }
  if (epoch(input.installed_package_version.changed_at) > observedMs) reasons.add("ENGINE_CHANGE_FUTURE");
};

const checkArchive: Check = ({ input, configMatches, repositoryHealthy, repositoryMatches, healthAge, healthFresh, observedMs }, reasons) => {
  if (!repositoryHealthy) reasons.add("REPOSITORY_UNHEALTHY");
  if (!repositoryMatches) reasons.add("ARCHIVE_REPOSITORY_MISMATCH");
  if (!configMatches) reasons.add("ARCHIVE_CONFIGURATION_MISMATCH");
  if (epoch(input.archive_configuration.changed_at) > observedMs) reasons.add("ARCHIVE_CONFIGURATION_FUTURE");
  if (!input.archive_state.status_directory_present) reasons.add("ARCHIVE_STATUS_MISSING");
  if (input.archive_state.spool_error_count > 0) reasons.add("ARCHIVE_SPOOL_ERROR");
  if (input.archive_state.unresolved_failure) reasons.add("ARCHIVE_UNRESOLVED_FAILURE");
  if (
    input.backup_health.status !== "ok"
    || !input.backup_health.repository_healthy
    || !input.backup_health.archive_healthy
    || !input.backup_health.operation_complete
  ) {
    reasons.add("BACKUP_HEALTH_UNHEALTHY");
  }
  if (healthAge < 0) reasons.add("BACKUP_HEALTH_FUTURE");
  if (!healthFresh && healthAge >= 0) reasons.add("BACKUP_HEALTH_STALE");
};

const checkScratch: Check = ({
  input,
  scratchAgeMilliseconds,
  scratchFreshAfterChange,
  scratchWithinDrillAge,
  policyValid,
}, reasons) => {
  if (input.scratch_restore.status !== "succeeded") reasons.add("SCRATCH_RESTORE_FAILED");
  if (!input.scratch_restore.isolated) reasons.add("SCRATCH_NOT_ISOLATED");
  if (!input.scratch_restore.cleanup_complete) reasons.add("SCRATCH_CLEANUP_INCOMPLETE");
  if (input.scratch_restore.authorization !== "verified-separate") reasons.add("SCRATCH_AUTHORIZATION_INVALID");
  if (scratchAgeMilliseconds < 0) reasons.add("SCRATCH_RESTORE_FUTURE");
  if (!scratchFreshAfterChange) reasons.add("SCRATCH_NOT_FRESH_AFTER_CHANGE");
  if (
    policyValid
    && scratchAgeMilliseconds > RECOVERY_POLICY.maximum_scratch_restore_age_seconds * 1_000
  ) {
    reasons.add("SCRATCH_RESTORE_STALE");
  }
  if (policyValid && !scratchWithinDrillAge && scratchAgeMilliseconds >= 0) {
    reasons.add("SCRATCH_RESTORE_STALE");
  }
};

const checkObjective: Check = ({ policyValid, unarchivedBound }, reasons) => {
  if (
    policyValid
    && unarchivedBound !== null
    && unarchivedBound > RECOVERY_POLICY.maximum_unarchived_data_seconds
  ) {
    reasons.add("RPO_OBJECTIVE_EXCEEDED");
  }
};

const checkVmRecovery: Check = ({ input, observedMs }, reasons) => {
  if (input.vm_recovery.kind !== "discrete-filesystem-consistent") reasons.add("VM_RECOVERY_KIND_INVALID");
  if (epoch(input.vm_recovery.recovery_point_utc) > observedMs) reasons.add("VM_RECOVERY_FUTURE");
};

const FORWARD_CHECKS: readonly Check[] = [
  checkBinding,
  checkClock,
  checkPolicy,
  checkBackup,
  checkEngine,
  checkArchive,
  checkScratch,
  checkObjective,
  checkVmRecovery,
];

const REVERSE_CHECKS: readonly Check[] = [
  checkVmRecovery,
  checkObjective,
  checkScratch,
  checkArchive,
  checkEngine,
  checkBackup,
  checkPolicy,
  checkClock,
  checkBinding,
];

const PHYSICAL_COMPATIBILITY_BLOCKERS = new Set<RecoveryReason>([
  "ACTIVE_PACKAGE_VERSION_MISMATCH",
  "ARCHIVE_CONFIGURATION_FUTURE",
  "ARCHIVE_CONFIGURATION_MISMATCH",
  "ARCHIVE_REPOSITORY_MISMATCH",
  "ARCHIVE_SPOOL_ERROR",
  "ARCHIVE_STATUS_MISSING",
  "ARCHIVE_UNRESOLVED_FAILURE",
  "BACKUP_ABSENT",
  "BACKUP_ERROR",
  "BACKUP_HEALTH_FUTURE",
  "BACKUP_HEALTH_STALE",
  "BACKUP_HEALTH_UNHEALTHY",
  "BACKUP_INCOMPLETE",
  "BACKUP_MAJOR_MISMATCH",
  "BACKUP_SELECTION_AMBIGUOUS",
  "BACKUP_TIMESTAMP_FUTURE",
  "BINDING_COUNT_INVALID",
  "BINDING_STATE_INVALID",
  "BINDING_TYPE_MISMATCH",
  "DATA_BINARY_MAJOR_MISMATCH",
  "ENGINE_CHANGE_FUTURE",
  "HISTORY_AMBIGUOUS",
  "HISTORY_ABSENT",
  "MIXED_REPOSITORY",
  "OBSERVATION_FUTURE",
  "OBSERVATION_STALE",
  "POLICY_ABSENT",
  "POLICY_AUTHENTICATION_ABSENT",
  "POLICY_AUTHENTICATION_INVALID",
  "POLICY_AUTHORITY_FUTURE",
  "POLICY_AUTHORITY_REPLAYED",
  "POLICY_AUTHORITY_STALE",
  "POLICY_DUPLICATE",
  "POLICY_SUBJECT_MISMATCH",
  "POLICY_VALUES_MISMATCH",
  "POLICY_VERSION_MISMATCH",
  "REPOSITORY_UNHEALTHY",
  "SCRATCH_AUTHORIZATION_INVALID",
  "SCRATCH_CLEANUP_INCOMPLETE",
  "SCRATCH_NOT_FRESH_AFTER_CHANGE",
  "SCRATCH_NOT_ISOLATED",
  "SCRATCH_RESTORE_FAILED",
  "SCRATCH_RESTORE_FUTURE",
  "SCRATCH_RESTORE_STALE",
  "SYSTEM_ID_MISMATCH",
]);

function evaluate(
  input: RecoveryProjectionSet,
  selector: (info: PgBackRestInfoProjection) => SelectedBackup,
  checks: readonly Check[],
): RecoveryReceipt {
  const facts = buildFacts(input, selector(input.pgbackrest_info));
  const reasons = new Set<RecoveryReason>();
  for (const check of checks) check(facts, reasons);

  reasons.add("HELD_NON_OPERATIONAL");

  const fullVersionsEqual = input.active_binary_version.full_version
    === input.installed_package_version.upstream_full_version;
  const sameMajor = facts.backupMajor === null
    ? null
    : facts.dataMajor === facts.activeMajor && facts.activeMajor === facts.backupMajor;
  const sameSystemId = facts.matchedHistory.length === 1
    ? facts.matchedHistory[0].system_identifier === input.control_data.system_identifier
    : null;
  const physicalCompatible = facts.policyValid
    && sameMajor === true
    && fullVersionsEqual
    && sameSystemId === true
    && facts.archiveHealthy
    && input.scratch_restore.status === "succeeded"
    && input.scratch_restore.isolated
    && input.scratch_restore.cleanup_complete
    && input.scratch_restore.authorization === "verified-separate"
    && facts.scratchFreshAfterChange
    && facts.scratchWithinDrillAge
    && ![...reasons].some((reason) => PHYSICAL_COMPATIBILITY_BLOCKERS.has(reason));
  const objectiveSeconds = facts.policyValid
    && facts.observationCurrent
    ? facts.policyEntry?.policy.maximum_unarchived_data_seconds ?? null
    : null;
  const meetsObjective = objectiveSeconds !== null && facts.unarchivedBound !== null
    ? facts.unarchivedBound <= objectiveSeconds
    : null;
  const vmRecoveryValid = facts.observationCurrent
    && input.vm_recovery.kind === "discrete-filesystem-consistent"
    && epoch(input.vm_recovery.recovery_point_utc) <= facts.observedMs;

  return {
    schema: RECOVERY_RECEIPT_SCHEMA,
    observed_at: input.observation_clock.observed_at,
    binding_count: input.production_binding.binding_count,
    engine: {
      active_full: input.active_binary_version.full_version,
      installed_full: input.installed_package_version.upstream_full_version,
      data_major: facts.dataMajor,
      backup_major: facts.backupMajor,
      same_major: sameMajor,
      full_versions_equal: fullVersionsEqual,
      same_system_id: sameSystemId,
      physical_compatible: physicalCompatible,
    },
    archive: {
      effective_config_matches: facts.configMatches,
      archive_timeout_seconds: input.archive_configuration.archive_timeout_seconds,
      pending_count: facts.pendingCount,
      oldest_pending_age_seconds: facts.oldestPendingAge,
      spool_error_count: input.archive_state.spool_error_count,
      health_age_seconds: facts.healthAge >= 0 ? facts.healthAge : null,
      unarchived_age_bound_seconds: facts.unarchivedBound,
      objective_seconds: objectiveSeconds,
      meets_objective: meetsObjective,
    },
    vm_recovery: {
      kind: vmRecoveryValid ? "discrete-filesystem-consistent" : null,
      pitr: false,
      recovery_point_utc: vmRecoveryValid ? input.vm_recovery.recovery_point_utc : null,
    },
    scratch_restore: {
      fresh_after_engine_change: facts.scratchFreshAfterChange,
      within_drill_age: facts.policyValid && facts.observationCurrent ? facts.scratchWithinDrillAge : null,
    },
    decision: "STOP",
    reasons: [...reasons].sort(),
  };
}

export function evaluateRecoveryProjectionSet(): RecoveryReceipt {
  return stoppedReceipt("CAPTURE_AUTHORITY_ABSENT");
}

export function evaluateRecoveryProjectionSetReverse(): RecoveryReceipt {
  return stoppedReceipt("CAPTURE_AUTHORITY_ABSENT");
}

function parseProjectionSet(values: AuthenticatedRecoveryInput["projections"]): RecoveryProjectionSet {
  const parsed = {} as RecoveryProjectionSet;
  for (const name of Object.keys(RECOVERY_PROJECTION_FILES) as RecoveryProjectionName[]) {
    (parsed[name] as RecoveryProjectionSet[typeof name]) = PARSERS[name](values[name]);
  }
  return parsed;
}

function assertAuthorityRelations(
  acquired: AuthenticatedRecoveryInput,
  input: RecoveryProjectionSet,
): void {
  const observedMs = epoch(input.observation_clock.observed_at);
  const decisionMs = epoch(input.observation_clock.decision_at);
  const captureAcceptedMs = epoch(acquired.capture_authority.accepted_at);
  if (
    acquired.manifest.production_binding_subject !== input.production_binding.subject
    || acquired.manifest.capture_operation_identity !== RECOVERY_CAPTURE_OPERATION
    || acquired.manifest.observation_nonce !== input.observation_clock.observation_nonce
    || acquired.manifest.observed_at !== input.observation_clock.observed_at
    || acquired.capture_authority.observation_nonce !== input.observation_clock.observation_nonce
  ) {
    throw new RecoveryCustodyError("CAPTURE_AUTHORITY_INVALID");
  }
  if (
    captureAcceptedMs > observedMs
    || observedMs - captureAcceptedMs > RECOVERY_POLICY.maximum_observation_age_seconds * 1_000
    || epoch(acquired.capture_authority.valid_until) < decisionMs
    || epoch(acquired.manifest.valid_until) < decisionMs
  ) {
    throw new RecoveryCustodyError("CAPTURE_AUTHORITY_STALE");
  }

  if (
    acquired.policy_authority.subject !== RECOVERY_POLICY_SUBJECT
    || acquired.policy_authority.observation_nonce !== input.observation_clock.observation_nonce
    || acquired.policy_authority.use_count !== 1
    || epoch(acquired.policy_authority.authenticated_at) > observedMs
    || observedMs - epoch(acquired.policy_authority.authenticated_at)
      > RECOVERY_POLICY.maximum_observation_age_seconds * 1_000
    || epoch(acquired.policy_authority.valid_until) < decisionMs
  ) {
    throw new RecoveryCustodyError("POLICY_AUTHORITY_ROOT_INVALID");
  }

  if (
    acquired.scratch_authority.subject !== RECOVERY_SCRATCH_SUBJECT
    || acquired.scratch_authority.observation_nonce !== input.observation_clock.observation_nonce
    || acquired.scratch_authority.completed_at !== input.scratch_restore.completed_at
    || acquired.scratch_authority.isolated !== input.scratch_restore.isolated
    || acquired.scratch_authority.cleanup_complete !== input.scratch_restore.cleanup_complete
    || acquired.scratch_authority.use_count !== 1
    || epoch(acquired.scratch_authority.authenticated_at) < epoch(input.scratch_restore.completed_at)
    || epoch(acquired.scratch_authority.authenticated_at) > observedMs
    || epoch(acquired.scratch_authority.valid_until) < decisionMs
  ) {
    throw new RecoveryCustodyError("SCRATCH_AUTHORITY_ROOT_INVALID");
  }
}

export async function collectRecoveryReceipt(
  inputRoot: string,
  authorities?: RecoveryAuthorityRoots,
  hooks?: RecoveryAcquisitionHooks,
  evaluationOrder: "forward" | "reverse" = "forward",
): Promise<RecoveryReceipt> {
  if (evaluationOrder !== "forward" && evaluationOrder !== "reverse") {
    return malformedReceipt("INPUT_FIELD_INVALID");
  }
  try {
    return await withAuthenticatedRecoveryInput(
      inputRoot,
      authorities,
      (acquired) => {
        const input = parseProjectionSet(acquired.projections);
        assertAuthorityRelations(acquired, input);
        return evaluationOrder === "forward"
          ? evaluate(input, selectBackupAscending, FORWARD_CHECKS)
          : evaluate(input, selectBackupByReduction, REVERSE_CHECKS);
      },
      hooks,
    );
  } catch (error) {
    if (error instanceof ProjectionError) return malformedReceipt(error.reason);
    if (error instanceof RecoveryCustodyError) {
      return error.decision === "MALFORMED"
        ? malformedReceipt(error.reason)
        : stoppedReceipt(error.reason);
    }
    return stoppedReceipt("INPUT_CUSTODY_CHANGED");
  }
}
