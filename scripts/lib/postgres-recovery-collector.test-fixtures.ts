import {
  RECOVERY_POLICY_AUTH_SCHEMA,
  RECOVERY_POLICY_SCHEMA,
  RECOVERY_POLICY_SUBJECT,
  recoveryPolicySha256,
  type RecoveryProjectionName,
  type RecoveryProjectionSet,
  type RecoveryReason,
} from "./postgres-recovery-collector";

export interface RecoveryFixture {
  name: string;
  expectedDecision: "STOP" | "MALFORMED";
  expectedReason: RecoveryReason;
  compatible?: boolean;
  mutate?: (input: RecoveryProjectionSet) => void;
  rootMutation?: {
    kind: "delete" | "replace" | "extra";
    projection?: RecoveryProjectionName;
    content?: string;
    filename?: string;
  };
}

const SYSTEM_A = "7000000000000000001";
const SYSTEM_B = "7000000000000000002";

export function baseRecoveryProjectionSet(): RecoveryProjectionSet {
  const policy = {
    schema: RECOVERY_POLICY_SCHEMA,
    subject: RECOVERY_POLICY_SUBJECT,
    version: 1,
    maximum_unarchived_data_seconds: 300,
    maximum_observation_age_seconds: 900,
    maximum_scratch_restore_age_seconds: 604_800,
  } as const;

  return {
    pg_version: {
      schema: "markdoc-recovery-pg-version/v1",
      major: "16",
    },
    active_binary_version: {
      schema: "markdoc-recovery-active-binary-version/v1",
      full_version: "16.10",
    },
    installed_package_version: {
      schema: "markdoc-recovery-installed-package-version/v1",
      installed_version: "16.10-0ubuntu0.24.04.1",
      upstream_full_version: "16.10",
      changed_at: "2026-09-01T04:00:00Z",
    },
    control_data: {
      schema: "markdoc-recovery-control-data/v1",
      system_identifier: SYSTEM_A,
    },
    pgbackrest_info: {
      schema: "markdoc-recovery-pgbackrest-info/v1",
      stanza_status_code: 0,
      repositories: [{ key: 1, status_code: 0 }],
      backups: [
        {
          status: "complete",
          error_code: 0,
          timestamp: {
            start: "2026-09-04T07:55:00Z",
            stop: "2026-09-04T08:00:00Z",
          },
          database: { id: 7, repo_key: 1 },
        },
      ],
      history: [
        {
          id: 7,
          repo_key: 1,
          system_identifier: SYSTEM_A,
          version: "16",
        },
      ],
      incomplete_operation_count: 0,
    },
    archive_configuration: {
      schema: "markdoc-recovery-archive-configuration/v1",
      wal_level: "replica",
      archive_mode: "on",
      archive_command_kind: "pgbackrest-archive-push",
      archive_timeout_seconds: 240,
      repo_key: 1,
      changed_at: "2026-09-01T04:05:00Z",
    },
    archive_state: {
      schema: "markdoc-recovery-archive-state/v1",
      status_directory_present: true,
      repo_key: 1,
      pending_ready: [],
      spool_error_count: 0,
      unresolved_failure: false,
    },
    backup_health: {
      schema: "markdoc-recovery-backup-health/v1",
      status: "ok",
      observed_at: "2026-09-04T09:19:30Z",
      repository_healthy: true,
      archive_healthy: true,
      operation_complete: true,
    },
    scratch_restore: {
      schema: "markdoc-recovery-scratch-restore/v1",
      status: "succeeded",
      completed_at: "2026-09-03T05:00:00Z",
      isolated: true,
      cleanup_complete: true,
      authorization: "verified-separate",
    },
    production_binding: {
      schema: "markdoc-recovery-production-binding/v1",
      subject: "markdoc-production-postgresql",
      kind: "production-postgresql-vm",
      state: "active",
      binding_count: 1,
    },
    observation_clock: {
      schema: "markdoc-recovery-observation-clock/v1",
      observed_at: "2026-09-04T09:20:00Z",
      decision_at: "2026-09-04T09:25:00Z",
      observation_nonce: "fixture-observation-a",
    },
    rpo_policy: {
      schema: "markdoc-recovery-rpo-policy-set/v1",
      policies: [
        {
          policy,
          authentication: {
            schema: RECOVERY_POLICY_AUTH_SCHEMA,
            status: "authenticated",
            subject: RECOVERY_POLICY_SUBJECT,
            policy_version: 1,
            policy_sha256: recoveryPolicySha256(policy),
            authenticated_at: "2026-09-04T09:15:00Z",
            valid_until: "2026-09-04T09:30:00Z",
            observation_nonce: "fixture-observation-a",
            use_count: 1,
          },
        },
      ],
    },
    vm_recovery: {
      schema: "markdoc-recovery-vm-recovery/v1",
      kind: "discrete-filesystem-consistent",
      recovery_point_utc: "2026-09-04T02:00:00Z",
    },
  };
}

const valid = (
  name: string,
  mutate?: RecoveryFixture["mutate"],
): RecoveryFixture => ({
  name,
  expectedDecision: "STOP",
  expectedReason: "HELD_NON_OPERATIONAL",
  compatible: true,
  mutate,
});

const stopped = (
  name: string,
  expectedReason: RecoveryReason,
  mutate: NonNullable<RecoveryFixture["mutate"]>,
  compatible = false,
): RecoveryFixture => ({
  name,
  expectedDecision: "STOP",
  expectedReason,
  compatible,
  mutate,
});

const malformed = (
  name: string,
  expectedReason: RecoveryReason,
  rootMutation?: RecoveryFixture["rootMutation"],
  mutate?: RecoveryFixture["mutate"],
): RecoveryFixture => ({
  name,
  expectedDecision: "MALFORMED",
  expectedReason,
  rootMutation,
  mutate,
});

function rehashPolicy(input: RecoveryProjectionSet): void {
  const entry = input.rpo_policy.policies[0];
  if (entry?.authentication) entry.authentication.policy_sha256 = recoveryPolicySha256(entry.policy);
}

export const RECOVERY_FIXTURES: RecoveryFixture[] = [
  valid("valid held result"),
  valid("same major different backup minor", (input) => {
    input.pgbackrest_info.history[0].version = "16.9";
  }),
  valid("newest backup selected by stop time", (input) => {
    input.pgbackrest_info.backups.unshift({
      status: "complete",
      error_code: 0,
      timestamp: { start: "2026-09-03T07:00:00Z", stop: "2026-09-03T08:00:00Z" },
      database: { id: 6, repo_key: 1 },
    });
    input.pgbackrest_info.history.unshift({
      id: 6,
      repo_key: 1,
      system_identifier: SYSTEM_B,
      version: "15",
    });
  }),
  valid("history order does not select history", (input) => {
    input.pgbackrest_info.history.unshift({
      id: 99,
      repo_key: 1,
      system_identifier: SYSTEM_B,
      version: "15.7",
    });
  }),
  valid("no ready file means zero pending age"),
  valid("unarchived bound exactly objective", (input) => {
    input.archive_state.pending_ready = [{ age_seconds: 60 }];
  }),
  valid("observation exactly maximum age", (input) => {
    input.observation_clock.decision_at = "2026-09-04T09:35:00Z";
    input.rpo_policy.policies[0].authentication!.valid_until = "2026-09-04T09:35:00Z";
  }),
  valid("scratch exactly maximum drill age", (input) => {
    input.scratch_restore.completed_at = "2026-08-28T09:20:00Z";
    input.installed_package_version.changed_at = "2026-08-27T04:00:00Z";
    input.archive_configuration.changed_at = "2026-08-27T04:05:00Z";
  }),
  valid("policy authentication exactly maximum age", (input) => {
    input.rpo_policy.policies[0].authentication!.authenticated_at = "2026-09-04T09:05:00Z";
  }),
  valid("health exactly maximum age", (input) => {
    input.backup_health.observed_at = "2026-09-04T09:05:00Z";
  }),
  valid("package revision does not alter upstream equality", (input) => {
    input.installed_package_version.installed_version = "16.10-9synthetic.1";
  }),
  valid("three complete backups select latest tuple", (input) => {
    input.pgbackrest_info.backups.push(
      {
        status: "complete",
        error_code: 0,
        timestamp: { start: "2026-09-02T01:00:00Z", stop: "2026-09-02T01:10:00Z" },
        database: { id: 5, repo_key: 1 },
      },
      {
        status: "complete",
        error_code: 0,
        timestamp: { start: "2026-09-03T01:00:00Z", stop: "2026-09-03T01:10:00Z" },
        database: { id: 6, repo_key: 1 },
      },
    );
    input.pgbackrest_info.history.push(
      { id: 5, repo_key: 1, system_identifier: SYSTEM_B, version: "15" },
      { id: 6, repo_key: 1, system_identifier: SYSTEM_B, version: "15" },
    );
  }),
  valid("VM recovery point may predate physical backup"),
  valid("fractional-second UTC projections", (input) => {
    input.observation_clock.observed_at = "2026-09-04T09:20:00.000Z";
    input.observation_clock.decision_at = "2026-09-04T09:25:00.000Z";
  }),

  stopped("zero production bindings", "BINDING_COUNT_INVALID", (input) => {
    input.production_binding.binding_count = 0;
  }),
  stopped("duplicate production bindings", "BINDING_COUNT_INVALID", (input) => {
    input.production_binding.binding_count = 2;
  }),
  stopped("wrong production binding type", "BINDING_TYPE_MISMATCH", (input) => {
    input.production_binding.kind = "other";
  }),
  stopped("changed production binding", "BINDING_STATE_INVALID", (input) => {
    input.production_binding.state = "changed";
  }),
  stopped("deleted production binding", "BINDING_STATE_INVALID", (input) => {
    input.production_binding.state = "deleted";
  }),
  stopped("data major differs from active binary", "DATA_BINARY_MAJOR_MISMATCH", (input) => {
    input.pg_version.major = "15";
  }),
  stopped("backup major differs from active binary", "BACKUP_MAJOR_MISMATCH", (input) => {
    input.pgbackrest_info.history[0].version = "15.12";
  }),
  stopped("active binary differs from installed upstream", "ACTIVE_PACKAGE_VERSION_MISMATCH", (input) => {
    input.installed_package_version.installed_version = "16.9-0synthetic.1";
    input.installed_package_version.upstream_full_version = "16.9";
  }),
  stopped("package change is future", "ENGINE_CHANGE_FUTURE", (input) => {
    input.installed_package_version.changed_at = "2026-09-04T09:20:01Z";
  }),
  stopped("system identifier mismatch", "SYSTEM_ID_MISMATCH", (input) => {
    input.control_data.system_identifier = SYSTEM_B;
  }),
  stopped("no backup", "BACKUP_ABSENT", (input) => {
    input.pgbackrest_info.backups = [];
  }),
  stopped("only error backup", "BACKUP_ABSENT", (input) => {
    input.pgbackrest_info.backups[0].error_code = 1;
  }),
  stopped("backup error is independently reported", "BACKUP_ERROR", (input) => {
    input.pgbackrest_info.backups.push({
      status: "complete",
      error_code: 1,
      timestamp: { start: "2026-09-03T01:00:00Z", stop: "2026-09-03T01:05:00Z" },
      database: { id: 7, repo_key: 1 },
    });
  }),
  stopped("incomplete backup", "BACKUP_INCOMPLETE", (input) => {
    input.pgbackrest_info.backups.push({
      status: "incomplete",
      error_code: 0,
      timestamp: { start: "2026-09-04T08:30:00Z", stop: "2026-09-04T08:35:00Z" },
      database: { id: 7, repo_key: 1 },
    });
  }),
  stopped("incomplete operation", "BACKUP_INCOMPLETE", (input) => {
    input.pgbackrest_info.incomplete_operation_count = 1;
  }),
  stopped("future backup stop", "BACKUP_TIMESTAMP_FUTURE", (input) => {
    input.pgbackrest_info.backups[0].timestamp.stop = "2026-09-04T09:21:00Z";
  }),
  stopped("crossed backup timestamps", "BACKUP_TIMESTAMP_FUTURE", (input) => {
    input.pgbackrest_info.backups[0].timestamp.start = "2026-09-04T08:01:00Z";
  }),
  stopped("equal newest backup stop is ambiguous", "BACKUP_SELECTION_AMBIGUOUS", (input) => {
    input.pgbackrest_info.backups.push({
      status: "complete",
      error_code: 0,
      timestamp: { start: "2026-09-04T07:50:00Z", stop: "2026-09-04T08:00:00Z" },
      database: { id: 7, repo_key: 1 },
    });
  }),
  stopped("matching history absent", "HISTORY_ABSENT", (input) => {
    input.pgbackrest_info.history[0].id = 8;
  }),
  stopped("matching history duplicated", "HISTORY_AMBIGUOUS", (input) => {
    input.pgbackrest_info.history.push(structuredClone(input.pgbackrest_info.history[0]));
  }),
  stopped("multiple repositories", "MIXED_REPOSITORY", (input) => {
    input.pgbackrest_info.repositories.push({ key: 2, status_code: 0 });
  }),
  stopped("backup from mixed repository", "MIXED_REPOSITORY", (input) => {
    input.pgbackrest_info.backups.push({
      status: "complete",
      error_code: 0,
      timestamp: { start: "2026-09-03T02:00:00Z", stop: "2026-09-03T02:05:00Z" },
      database: { id: 8, repo_key: 2 },
    });
  }),
  stopped("stanza unhealthy", "REPOSITORY_UNHEALTHY", (input) => {
    input.pgbackrest_info.stanza_status_code = 1;
  }),
  stopped("repository unhealthy", "REPOSITORY_UNHEALTHY", (input) => {
    input.pgbackrest_info.repositories[0].status_code = 1;
  }),
  stopped("archive repository mismatch", "ARCHIVE_REPOSITORY_MISMATCH", (input) => {
    input.archive_state.repo_key = 2;
  }),
  stopped("wrong wal level", "ARCHIVE_CONFIGURATION_MISMATCH", (input) => {
    input.archive_configuration.wal_level = "logical";
  }),
  stopped("archive mode off", "ARCHIVE_CONFIGURATION_MISMATCH", (input) => {
    input.archive_configuration.archive_mode = "off";
  }),
  stopped("archive command mismatch", "ARCHIVE_CONFIGURATION_MISMATCH", (input) => {
    input.archive_configuration.archive_command_kind = "other";
  }),
  stopped("archive timeout mismatch", "ARCHIVE_CONFIGURATION_MISMATCH", (input) => {
    input.archive_configuration.archive_timeout_seconds = 241;
  }),
  stopped("archive configuration change is future", "ARCHIVE_CONFIGURATION_FUTURE", (input) => {
    input.archive_configuration.changed_at = "2026-09-04T09:20:01Z";
  }),
  stopped("archive status missing", "ARCHIVE_STATUS_MISSING", (input) => {
    input.archive_state.status_directory_present = false;
  }),
  stopped("spool error", "ARCHIVE_SPOOL_ERROR", (input) => {
    input.archive_state.spool_error_count = 1;
  }),
  stopped("unresolved archive failure", "ARCHIVE_UNRESOLVED_FAILURE", (input) => {
    input.archive_state.unresolved_failure = true;
  }),
  stopped("backup health status error", "BACKUP_HEALTH_UNHEALTHY", (input) => {
    input.backup_health.status = "error";
  }),
  stopped("backup health repository false", "BACKUP_HEALTH_UNHEALTHY", (input) => {
    input.backup_health.repository_healthy = false;
  }),
  stopped("backup health archive false", "BACKUP_HEALTH_UNHEALTHY", (input) => {
    input.backup_health.archive_healthy = false;
  }),
  stopped("backup health operation incomplete", "BACKUP_HEALTH_UNHEALTHY", (input) => {
    input.backup_health.operation_complete = false;
  }),
  stopped("backup health future", "BACKUP_HEALTH_FUTURE", (input) => {
    input.backup_health.observed_at = "2026-09-04T09:20:01Z";
  }),
  stopped("backup health stale", "BACKUP_HEALTH_STALE", (input) => {
    input.backup_health.observed_at = "2026-09-04T09:04:59Z";
  }),
  stopped("unarchived objective exceeded by one", "RPO_OBJECTIVE_EXCEEDED", (input) => {
    input.archive_state.pending_ready = [{ age_seconds: 61 }];
  }, true),
  stopped("oldest of several ready files drives bound", "RPO_OBJECTIVE_EXCEEDED", (input) => {
    input.archive_state.pending_ready = [{ age_seconds: 1 }, { age_seconds: 61 }, { age_seconds: 12 }];
  }, true),
  stopped("scratch restore failed", "SCRATCH_RESTORE_FAILED", (input) => {
    input.scratch_restore.status = "failed";
  }),
  stopped("scratch restore incomplete", "SCRATCH_RESTORE_FAILED", (input) => {
    input.scratch_restore.status = "incomplete";
  }),
  stopped("scratch restore not isolated", "SCRATCH_AUTHORITY_ROOT_INVALID", (input) => {
    input.scratch_restore.isolated = false;
  }),
  stopped("scratch cleanup incomplete", "SCRATCH_AUTHORITY_ROOT_INVALID", (input) => {
    input.scratch_restore.cleanup_complete = false;
  }),
  stopped("scratch authorization absent", "SCRATCH_AUTHORIZATION_INVALID", (input) => {
    input.scratch_restore.authorization = "absent";
  }),
  stopped("scratch restore before latest configuration change", "SCRATCH_NOT_FRESH_AFTER_CHANGE", (input) => {
    input.scratch_restore.completed_at = "2026-09-01T04:04:59Z";
  }),
  stopped("scratch restore stale by one second", "SCRATCH_RESTORE_STALE", (input) => {
    input.scratch_restore.completed_at = "2026-08-28T09:19:59Z";
  }),
  stopped("scratch restore future", "SCRATCH_AUTHORITY_ROOT_INVALID", (input) => {
    input.scratch_restore.completed_at = "2026-09-04T09:20:01Z";
  }),
  stopped("observation stale by one second", "OBSERVATION_STALE", (input) => {
    input.observation_clock.decision_at = "2026-09-04T09:35:01Z";
    input.rpo_policy.policies[0].authentication!.valid_until = "2026-09-04T09:36:00Z";
  }),
  stopped("observation is future relative to decision", "OBSERVATION_FUTURE", (input) => {
    input.observation_clock.decision_at = "2026-09-04T09:19:59Z";
  }),
  stopped("policy absent", "POLICY_ABSENT", (input) => {
    input.rpo_policy.policies = [];
  }),
  stopped("policy duplicated", "POLICY_DUPLICATE", (input) => {
    input.rpo_policy.policies.push(structuredClone(input.rpo_policy.policies[0]));
  }),
  stopped("policy wrong subject", "POLICY_SUBJECT_MISMATCH", (input) => {
    input.rpo_policy.policies[0].policy.subject = "other-subject";
    rehashPolicy(input);
  }),
  stopped("policy wrong version", "POLICY_VERSION_MISMATCH", (input) => {
    input.rpo_policy.policies[0].policy.version = 2;
    input.rpo_policy.policies[0].authentication!.policy_version = 2;
    rehashPolicy(input);
  }),
  stopped("policy objective altered", "POLICY_VALUES_MISMATCH", (input) => {
    input.rpo_policy.policies[0].policy.maximum_unarchived_data_seconds = 301;
    rehashPolicy(input);
  }),
  stopped("policy observation age altered", "POLICY_VALUES_MISMATCH", (input) => {
    input.rpo_policy.policies[0].policy.maximum_observation_age_seconds = 901;
    rehashPolicy(input);
  }),
  stopped("policy drill age altered", "POLICY_VALUES_MISMATCH", (input) => {
    input.rpo_policy.policies[0].policy.maximum_scratch_restore_age_seconds = 604_801;
    rehashPolicy(input);
  }),
  stopped("policy authentication absent", "POLICY_AUTHENTICATION_ABSENT", (input) => {
    delete input.rpo_policy.policies[0].authentication;
  }),
  stopped("policy authentication status invalid", "POLICY_AUTHENTICATION_INVALID", (input) => {
    input.rpo_policy.policies[0].authentication!.status = "unauthenticated";
  }),
  stopped("policy digest mismatch", "POLICY_AUTHENTICATION_INVALID", (input) => {
    input.rpo_policy.policies[0].authentication!.policy_sha256 = "0".repeat(64);
  }),
  stopped("policy authority future", "POLICY_AUTHORITY_FUTURE", (input) => {
    input.rpo_policy.policies[0].authentication!.authenticated_at = "2026-09-04T09:20:01Z";
  }),
  stopped("policy authority stale age", "POLICY_AUTHORITY_STALE", (input) => {
    input.rpo_policy.policies[0].authentication!.authenticated_at = "2026-09-04T09:04:59Z";
  }),
  stopped("policy authority expired", "POLICY_AUTHORITY_STALE", (input) => {
    input.rpo_policy.policies[0].authentication!.valid_until = "2026-09-04T09:24:59Z";
  }),
  stopped("policy authority nonce replay", "POLICY_AUTHORITY_REPLAYED", (input) => {
    input.rpo_policy.policies[0].authentication!.observation_nonce = "fixture-observation-old";
  }),
  stopped("policy authority use replay", "POLICY_AUTHORITY_REPLAYED", (input) => {
    input.rpo_policy.policies[0].authentication!.use_count = 2;
  }),
  stopped("VM recovery wrong kind", "VM_RECOVERY_KIND_INVALID", (input) => {
    input.vm_recovery.kind = "other";
  }, true),
  stopped("VM recovery future", "VM_RECOVERY_FUTURE", (input) => {
    input.vm_recovery.recovery_point_utc = "2026-09-04T09:20:01Z";
  }, true),

  {
    name: "missing projection file",
    expectedDecision: "STOP",
    expectedReason: "INPUT_FILE_MISSING",
    rootMutation: { kind: "delete", projection: "control_data" },
  },
  malformed("unexpected projection file", "INPUT_FILE_UNEXPECTED", {
    kind: "extra",
    filename: "raw-command-output.log",
    content: "not allowed",
  }),
  malformed("invalid JSON", "INPUT_JSON_INVALID", {
    kind: "replace",
    projection: "pg_version",
    content: "{",
  }),
  malformed("unknown top-level field", "INPUT_UNKNOWN_FIELD", undefined, (input) => {
    (input.pg_version as unknown as Record<string, unknown>).unexpected = true;
  }),
  malformed("wrong projection schema", "INPUT_SCHEMA_INVALID", undefined, (input) => {
    (input.pg_version as { schema: string }).schema = "wrong/v1";
  }),
  malformed("missing required projection field", "INPUT_FIELD_INVALID", undefined, (input) => {
    delete (input.pg_version as unknown as { major?: string }).major;
  }),
  malformed("bad PG major", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.pg_version.major = "16.1";
  }),
  malformed("bad active full version", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.active_binary_version.full_version = "PostgreSQL 16.10";
  }),
  malformed("bad installed package version", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.installed_package_version.installed_version = "16.10 package output";
  }),
  malformed("bad upstream full version", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.installed_package_version.upstream_full_version = "v16";
  }),
  malformed("installed package and upstream projection disagree", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.installed_package_version.upstream_full_version = "16.9";
  }),
  malformed("bad system identifier", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.control_data.system_identifier = "system-a";
  }),
  malformed("negative repository key", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.pgbackrest_info.repositories[0].key = -1;
  }),
  malformed("backup timestamp not UTC", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.pgbackrest_info.backups[0].timestamp.stop = "2026-09-04T08:00:00-05:00";
  }),
  malformed("history version ambiguous text", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.pgbackrest_info.history[0].version = "16beta";
  }),
  malformed("archive timeout fractional", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.archive_configuration.archive_timeout_seconds = 240.5;
  }),
  malformed("pending age negative", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.archive_state.pending_ready = [{ age_seconds: -1 }];
  }),
  malformed("pending age zero with a ready file", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.archive_state.pending_ready = [{ age_seconds: 0 }];
  }),
  malformed("health status unknown", "INPUT_FIELD_INVALID", undefined, (input) => {
    (input.backup_health as unknown as { status: string }).status = "unknown";
  }),
  malformed("scratch completion not a timestamp", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.scratch_restore.completed_at = "yesterday";
  }),
  malformed("binding count fractional", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.production_binding.binding_count = 1.5;
  }),
  malformed("observation nonce empty", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.observation_clock.observation_nonce = "";
  }),
  malformed("policy set is not an array", "INPUT_FIELD_INVALID", undefined, (input) => {
    (input.rpo_policy as unknown as { policies: unknown }).policies = {};
  }),
  malformed("policy digest credential-shaped garbage rejected", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.rpo_policy.policies[0].authentication!.policy_sha256 = "not-a-digest";
  }),
  malformed("policy authentication has unknown field", "INPUT_UNKNOWN_FIELD", undefined, (input) => {
    (input.rpo_policy.policies[0].authentication as unknown as Record<string, unknown>).token = "not-present";
  }),
  malformed("VM recovery timestamp has offset", "INPUT_FIELD_INVALID", undefined, (input) => {
    input.vm_recovery.recovery_point_utc = "2026-09-04T02:00:00+00:00";
  }),
  malformed("nested backup database has unknown field", "INPUT_UNKNOWN_FIELD", undefined, (input) => {
    (input.pgbackrest_info.backups[0].database as unknown as Record<string, unknown>).name = "not-allowed";
  }),
];
