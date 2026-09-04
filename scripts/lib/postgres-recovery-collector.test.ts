import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RECOVERY_INPUT_SCHEMA,
  RECOVERY_POLICY,
  RECOVERY_PROJECTION_FILES,
  RECOVERY_RECEIPT_SCHEMA,
  canonicalJson,
  collectRecoveryReceipt,
  evaluateRecoveryProjectionSet,
  evaluateRecoveryProjectionSetReverse,
  readRecoveryInputRoot,
  type RecoveryProjectionName,
} from "./postgres-recovery-collector";
import {
  RECOVERY_FIXTURES,
  baseRecoveryProjectionSet,
  type RecoveryFixture,
} from "./postgres-recovery-collector.test-fixtures";

let fixtureParent: string;

beforeAll(async () => {
  fixtureParent = await mkdtemp(path.join(tmpdir(), "markdoc-recovery-fixtures-"));
});

afterAll(async () => {
  await rm(fixtureParent, { recursive: true, force: true });
});

async function writeFixture(fixture: RecoveryFixture, index: number): Promise<string> {
  const root = path.join(fixtureParent, `fixture-${index.toString().padStart(3, "0")}`);
  await mkdir(root);
  const projections = structuredClone(baseRecoveryProjectionSet());
  fixture.mutate?.(projections);

  for (const name of Object.keys(RECOVERY_PROJECTION_FILES) as RecoveryProjectionName[]) {
    await writeFile(
      path.join(root, RECOVERY_PROJECTION_FILES[name]),
      canonicalJson(projections[name]),
      "utf8",
    );
  }

  const mutation = fixture.rootMutation;
  if (mutation?.kind === "delete" && mutation.projection) {
    await unlink(path.join(root, RECOVERY_PROJECTION_FILES[mutation.projection]));
  } else if (mutation?.kind === "replace" && mutation.projection) {
    await writeFile(
      path.join(root, RECOVERY_PROJECTION_FILES[mutation.projection]),
      mutation.content ?? "",
      "utf8",
    );
  } else if (mutation?.kind === "extra" && mutation.filename) {
    await writeFile(path.join(root, mutation.filename), mutation.content ?? "", "utf8");
  }
  return root;
}

describe("held PostgreSQL recovery collector", () => {
  it("defines 13 closed projection classes and binds the accepted policy values", () => {
    expect(RECOVERY_INPUT_SCHEMA).toBe("markdoc-postgres-recovery-projections/v1");
    expect(Object.keys(RECOVERY_PROJECTION_FILES)).toHaveLength(13);
    expect(new Set(Object.values(RECOVERY_PROJECTION_FILES)).size).toBe(13);
    expect(RECOVERY_POLICY).toEqual({
      maximum_unarchived_data_seconds: 300,
      maximum_observation_age_seconds: 900,
      maximum_scratch_restore_age_seconds: 604_800,
    });
  });

  it.each(RECOVERY_FIXTURES.map((fixture, index) => [index, fixture.name, fixture] as const))(
    "fixture %i: %s",
    async (index, _name, fixture) => {
      const root = await writeFixture(fixture, index);
      try {
        const forward = await collectRecoveryReceipt(root, evaluateRecoveryProjectionSet);
        const reverse = await collectRecoveryReceipt(root, evaluateRecoveryProjectionSetReverse);

        expect(reverse).toEqual(forward);
        expect(forward.decision).toBe(fixture.expectedDecision);
        expect(forward.reasons).toContain(fixture.expectedReason);
        if (fixture.compatible !== undefined) {
          expect(forward.engine.physical_compatible).toBe(fixture.compatible);
        }
        if (fixture.compatible) {
          expect(forward.decision).toBe("STOP");
          expect(forward.reasons).toContain("COLLECTOR_EXECUTION_AUTHORITY_ABSENT");
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("selects the newest complete non-error backup and binds its exact history tuple", () => {
    const input = baseRecoveryProjectionSet();
    input.pgbackrest_info.backups.push({
      status: "complete",
      error_code: 0,
      timestamp: { start: "2026-09-04T08:50:00Z", stop: "2026-09-04T09:00:00Z" },
      database: { id: 8, repo_key: 1 },
    });
    input.pgbackrest_info.history.unshift({
      id: 8,
      repo_key: 1,
      system_identifier: "7000000000000000002",
      version: "15.9",
    });
    const receipt = evaluateRecoveryProjectionSet(input);
    expect(receipt.engine.backup_major).toBe(15);
    expect(receipt.engine.same_system_id).toBe(false);
    expect(receipt.reasons).toEqual(expect.arrayContaining(["BACKUP_MAJOR_MISMATCH", "SYSTEM_ID_MISMATCH"]));
  });

  it("uses only timeout plus oldest pending age and never creates a latest-restorable time", () => {
    const input = baseRecoveryProjectionSet();
    input.archive_state.pending_ready = [
      { age_seconds: 12 },
      { age_seconds: 60 },
      { age_seconds: 3 },
    ];
    const receipt = evaluateRecoveryProjectionSet(input);
    expect(receipt.archive).toMatchObject({
      archive_timeout_seconds: 240,
      pending_count: 3,
      oldest_pending_age_seconds: 60,
      unarchived_age_bound_seconds: 300,
      objective_seconds: 300,
      meets_objective: true,
    });
    expect(JSON.stringify(receipt)).not.toMatch(/latest.restorable|wal|segment|archive.timestamp/i);
  });

  it("emits only the closed value-safe receipt and does not retain input identities", () => {
    const input = baseRecoveryProjectionSet();
    const receipt = evaluateRecoveryProjectionSet(input);
    expect(Object.keys(receipt)).toEqual([
      "schema",
      "observed_at",
      "binding_count",
      "engine",
      "archive",
      "vm_recovery",
      "scratch_restore",
      "decision",
      "reasons",
    ]);
    expect(receipt.schema).toBe(RECOVERY_RECEIPT_SCHEMA);
    expect(Object.keys(receipt.engine)).toEqual([
      "active_full",
      "installed_full",
      "data_major",
      "backup_major",
      "same_major",
      "full_versions_equal",
      "same_system_id",
      "physical_compatible",
    ]);
    expect(Object.keys(receipt.archive)).toEqual([
      "effective_config_matches",
      "archive_timeout_seconds",
      "pending_count",
      "oldest_pending_age_seconds",
      "spool_error_count",
      "health_age_seconds",
      "unarchived_age_bound_seconds",
      "objective_seconds",
      "meets_objective",
    ]);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(input.control_data.system_identifier);
    expect(serialized).not.toContain(input.observation_clock.observation_nonce);
    expect(serialized).not.toContain(input.rpo_policy.policies[0].authentication!.policy_sha256);
    expect(serialized).not.toMatch(/path|pid|stanza|repo.key|database.id|command|log|token|configuration.text/i);
  });

  it("rejects a relative root before reading it", async () => {
    const result = await readRecoveryInputRoot("relative-fixture-root");
    expect(result).toEqual({
      ok: false,
      receipt: expect.objectContaining({
        decision: "MALFORMED",
        reasons: ["INPUT_ROOT_NOT_ABSOLUTE"],
      }),
    });
  });

  it("the fixture corpus covers success, STOP, MALFORMED and every named boundary family", () => {
    expect(RECOVERY_FIXTURES.length).toBeGreaterThanOrEqual(64);
    expect(RECOVERY_FIXTURES.filter((fixture) => fixture.compatible).length).toBeGreaterThanOrEqual(15);
    expect(RECOVERY_FIXTURES.some((fixture) => fixture.expectedDecision === "MALFORMED")).toBe(true);
    expect(RECOVERY_FIXTURES.some((fixture) => fixture.expectedReason === "POLICY_AUTHORITY_REPLAYED")).toBe(true);
    expect(RECOVERY_FIXTURES.some((fixture) => fixture.expectedReason === "MIXED_REPOSITORY")).toBe(true);
    expect(RECOVERY_FIXTURES.some((fixture) => fixture.expectedReason === "SCRATCH_RESTORE_STALE")).toBe(true);
    expect(RECOVERY_FIXTURES.some((fixture) => fixture.expectedReason === "ACTIVE_PACKAGE_VERSION_MISMATCH")).toBe(true);
  });
});
