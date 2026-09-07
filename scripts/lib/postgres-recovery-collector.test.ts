import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RECOVERY_ACCEPTED_AUTHORITY_REFERENCE_SCHEMA,
  RECOVERY_CAPTURE_AUTHORITY_SCHEMA,
  RECOVERY_CAPTURE_MANIFEST_SCHEMA,
  RECOVERY_CAPTURE_OPERATION,
  RECOVERY_INPUT_SCHEMA,
  RECOVERY_POLICY,
  RECOVERY_POLICY_AUTHORITY_SCHEMA,
  RECOVERY_POLICY_SUBJECT,
  RECOVERY_PRODUCTION_BINDING_SUBJECT,
  RECOVERY_PROJECTION_FILES,
  RECOVERY_RECEIPT_SCHEMA,
  RECOVERY_SCRATCH_AUTHORITY_SCHEMA,
  RECOVERY_SCRATCH_SUBJECT,
  canonicalJson,
  collectRecoveryReceipt,
  evaluateRecoveryProjectionSet,
  evaluateRecoveryProjectionSetReverse,
  type AcceptedAuthorityReference,
  type RecoveryAuthorityRoots,
  type RecoveryAcquisitionBoundary,
  type RecoveryFileClaim,
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

interface WrittenFixture {
  caseRoot: string;
  inputRoot: string;
  authorities: RecoveryAuthorityRoots;
}

type AuthorityKind = AcceptedAuthorityReference["kind"];

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileClaim(logicalName: string, filePath: string): Promise<RecoveryFileClaim> {
  const bytes = await readFile(filePath);
  return { logical_name: logicalName, byte_count: bytes.length, sha256: digest(bytes) };
}

async function authorityReference(
  kind: AcceptedAuthorityReference["kind"],
  filePath: string,
): Promise<AcceptedAuthorityReference> {
  const [bytes, stats, nativePath] = await Promise.all([
    readFile(filePath),
    stat(filePath, { bigint: true }),
    realpath(filePath),
  ]);
  return {
    schema: RECOVERY_ACCEPTED_AUTHORITY_REFERENCE_SCHEMA,
    kind,
    path: filePath,
    realpath: nativePath,
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    byte_count: bytes.length,
    sha256: digest(bytes),
  };
}

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1_000).toISOString().replace(".000Z", "Z");
}

async function writeFixture(
  fixture: RecoveryFixture,
  label: string,
  rawOverrides: Partial<Record<RecoveryProjectionName, string | Uint8Array>> = {},
): Promise<WrittenFixture> {
  const caseRoot = path.join(fixtureParent, label);
  const inputRoot = path.join(caseRoot, "input");
  const authorityRoot = path.join(caseRoot, "authorities");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(authorityRoot);
  const projections = structuredClone(baseRecoveryProjectionSet());
  fixture.mutate?.(projections);

  for (const name of Object.keys(RECOVERY_PROJECTION_FILES) as RecoveryProjectionName[]) {
    const bytes = rawOverrides[name] ?? canonicalJson(projections[name]);
    await writeFile(
      path.join(inputRoot, RECOVERY_PROJECTION_FILES[name]),
      bytes,
    );
  }

  const mutation = fixture.rootMutation;
  if (mutation?.kind === "replace" && mutation.projection) {
    await writeFile(
      path.join(inputRoot, RECOVERY_PROJECTION_FILES[mutation.projection]),
      mutation.content ?? "",
      "utf8",
    );
  }

  const members = await Promise.all(
    Object.values(RECOVERY_PROJECTION_FILES)
      .toSorted()
      .map((logicalName) => fileClaim(logicalName, path.join(inputRoot, logicalName))),
  );
  const observedAt = projections.observation_clock.observed_at;
  const decisionAt = projections.observation_clock.decision_at;
  const nonce = projections.observation_clock.observation_nonce || "invalid-observation-nonce";
  const manifest = {
    schema: RECOVERY_CAPTURE_MANIFEST_SCHEMA,
    production_binding_subject: RECOVERY_PRODUCTION_BINDING_SUBJECT,
    capture_operation_identity: RECOVERY_CAPTURE_OPERATION,
    observation_nonce: nonce,
    observed_at: observedAt,
    valid_until: Number.isFinite(Date.parse(decisionAt)) ? addSeconds(decisionAt, 300) : decisionAt,
    use_count: 1,
    members,
  } as const;
  const manifestPath = path.join(inputRoot, "capture-manifest.json");
  await writeFile(manifestPath, canonicalJson(manifest), "utf8");
  const manifestClaim = await fileClaim("capture-manifest.json", manifestPath);

  const scratch = projections.scratch_restore;
  const captureAuthority = {
    schema: RECOVERY_CAPTURE_AUTHORITY_SCHEMA,
    status: "accepted",
    subject: RECOVERY_PRODUCTION_BINDING_SUBJECT,
    capture_operation_identity: RECOVERY_CAPTURE_OPERATION,
    observation_nonce: nonce,
    accepted_at: Number.isFinite(Date.parse(observedAt)) ? addSeconds(observedAt, -300) : observedAt,
    valid_until: manifest.valid_until,
    use_count: 1,
    manifest: manifestClaim,
  } as const;
  const policyAuthority = {
    schema: RECOVERY_POLICY_AUTHORITY_SCHEMA,
    status: "accepted",
    subject: RECOVERY_POLICY_SUBJECT,
    observation_nonce: nonce,
    authenticated_at: addSeconds(observedAt, -300),
    valid_until: addSeconds(decisionAt, 300),
    use_count: 1,
    policy: members.find((member) => member.logical_name === RECOVERY_PROJECTION_FILES.rpo_policy)!,
  } as const;
  const scratchAuthority = {
    schema: RECOVERY_SCRATCH_AUTHORITY_SCHEMA,
    status: "accepted",
    subject: RECOVERY_SCRATCH_SUBJECT,
    observation_nonce: nonce,
    authorization: "verified-separate",
    completed_at: scratch.completed_at,
    isolated: true,
    cleanup_complete: true,
    authenticated_at: Number.isFinite(Date.parse(scratch.completed_at))
      ? addSeconds(scratch.completed_at, 60)
      : scratch.completed_at,
    valid_until: Number.isFinite(Date.parse(decisionAt)) ? addSeconds(decisionAt, 300) : decisionAt,
    use_count: 1,
    receipt: members.find((member) => member.logical_name === RECOVERY_PROJECTION_FILES.scratch_restore)!,
  } as const;
  const captureAuthorityPath = path.join(authorityRoot, "capture-authority.json");
  const policyAuthorityPath = path.join(authorityRoot, "policy-authority.json");
  const scratchAuthorityPath = path.join(authorityRoot, "scratch-authority.json");
  await Promise.all([
    writeFile(captureAuthorityPath, canonicalJson(captureAuthority), "utf8"),
    writeFile(policyAuthorityPath, canonicalJson(policyAuthority), "utf8"),
    writeFile(scratchAuthorityPath, canonicalJson(scratchAuthority), "utf8"),
  ]);

  const [inputStats, inputNativePath, captureReference, policyReference, scratchReference] = await Promise.all([
    stat(inputRoot, { bigint: true }),
    realpath(inputRoot),
    authorityReference("capture", captureAuthorityPath),
    authorityReference("policy", policyAuthorityPath),
    authorityReference("scratch", scratchAuthorityPath),
  ]);
  const authorities: RecoveryAuthorityRoots = {
    capture: {
      ...captureReference,
      kind: "capture",
      input_root: {
        path: inputRoot,
        realpath: inputNativePath,
        device: inputStats.dev.toString(),
        inode: inputStats.ino.toString(),
      },
    },
    policy: { ...policyReference, kind: "policy" },
    scratch: { ...scratchReference, kind: "scratch" },
  };

  if (mutation?.kind === "delete" && mutation.projection) {
    await unlink(path.join(inputRoot, RECOVERY_PROJECTION_FILES[mutation.projection]));
  } else if (mutation?.kind === "extra" && mutation.filename) {
    await writeFile(path.join(inputRoot, mutation.filename), mutation.content ?? "", "utf8");
  }
  return { caseRoot, inputRoot, authorities };
}

async function refreshAuthorityReference(written: WrittenFixture, kind: AuthorityKind): Promise<void> {
  const current = written.authorities[kind];
  const refreshed = await authorityReference(kind, current.path);
  if (kind === "capture") {
    written.authorities.capture = {
      ...refreshed,
      kind: "capture",
      input_root: written.authorities.capture.input_root,
    };
  } else if (kind === "policy") {
    written.authorities.policy = { ...refreshed, kind: "policy" };
  } else {
    written.authorities.scratch = { ...refreshed, kind: "scratch" };
  }
}

async function rewriteAuthority(
  written: WrittenFixture,
  kind: AuthorityKind,
  mutate: (authority: Record<string, unknown>) => void,
): Promise<void> {
  const authorityPath = written.authorities[kind].path;
  const authority = JSON.parse(await readFile(authorityPath, "utf8")) as Record<string, unknown>;
  mutate(authority);
  await writeFile(authorityPath, canonicalJson(authority));
  await refreshAuthorityReference(written, kind);
}

async function rewriteManifest(
  written: WrittenFixture,
  mutate: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const manifestPath = path.join(written.inputRoot, "capture-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  mutate(manifest);
  await writeFile(manifestPath, canonicalJson(manifest));
  const manifestDigest = await fileClaim("capture-manifest.json", manifestPath);
  await rewriteAuthority(written, "capture", (authority) => {
    authority.manifest = manifestDigest;
  });
}

async function writeRawManifest(
  written: WrittenFixture,
  bytes: string | Uint8Array,
): Promise<void> {
  const manifestPath = path.join(written.inputRoot, "capture-manifest.json");
  await writeFile(manifestPath, bytes);
  const manifestDigest = await fileClaim("capture-manifest.json", manifestPath);
  await rewriteAuthority(written, "capture", (authority) => {
    authority.manifest = manifestDigest;
  });
}

const STABLE_FILE_LABELS = [
  "capture-authority-root",
  "policy-authority-root",
  "scratch-authority-root",
  "capture-manifest.json",
  ...Object.values(RECOVERY_PROJECTION_FILES),
] as const;

const FILE_READ_BOUNDARIES = STABLE_FILE_LABELS.flatMap((label) => [
  `${label}:read-1`,
  `${label}:read-2`,
  `${label}:read-final`,
] as RecoveryAcquisitionBoundary[]);

const CUSTODY_BOUNDARY_ATTACKS = FILE_READ_BOUNDARIES.flatMap((boundary) => [
  { boundary, mode: "in-place" as const },
  { boundary, mode: "path-replacement" as const },
]);

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

  async function evaluateBoth(written: WrittenFixture) {
    const forward = await collectRecoveryReceipt(
      written.inputRoot,
      written.authorities,
      undefined,
      "forward",
    );
    const reverse = await collectRecoveryReceipt(
      written.inputRoot,
      written.authorities,
      undefined,
      "reverse",
    );
    expect(reverse).toEqual(forward);
    return forward;
  }

  describe("recovery authority and descriptor custody", () => {
    it.each(CUSTODY_BOUNDARY_ATTACKS.map((attack, index) => [index, attack] as const))(
      "custody attack %i rejects $1.boundary $1.mode",
      async (index, attack) => {
        const receipts = [];
        for (const order of ["forward", "reverse"] as const) {
          const written = await writeFixture(
            {
              name: "authenticated custody boundary",
              expectedDecision: "STOP",
              expectedReason: "INPUT_CUSTODY_CHANGED",
            },
            `custody-${index.toString().padStart(3, "0")}-${order}`,
          );
          let attacked = false;
          try {
            const receipt = await collectRecoveryReceipt(
              written.inputRoot,
              written.authorities,
              {
                async onBoundary(context) {
                  if (attacked || context.boundary !== attack.boundary) return;
                  attacked = true;
                  if (attack.mode === "in-place") {
                    await appendFile(context.path, " ");
                  } else {
                    const replacement = `${context.path}.replaced`;
                    const bytes = await readFile(context.path);
                    await rename(context.path, replacement);
                    await writeFile(context.path, bytes);
                  }
                },
              },
              order,
            );
            expect(attacked).toBe(true);
            expect(receipt).toMatchObject({
              decision: "STOP",
              reasons: ["INPUT_CUSTODY_CHANGED"],
              observed_at: null,
              engine: {
                same_system_id: null,
                physical_compatible: false,
              },
              archive: {
                objective_seconds: null,
                meets_objective: null,
              },
            });
            receipts.push(receipt);
          } finally {
            await rm(written.caseRoot, { recursive: true, force: true });
          }
        }
        expect(receipts[1]).toEqual(receipts[0]);
      },
    );

    it.each(["input-root:census-initial", "input-root:census-final"] as const)(
      "rejects input root replacement at %s",
      async (boundary) => {
        const receipts = [];
        for (const order of ["forward", "reverse"] as const) {
          const written = await writeFixture(
            {
              name: "root replacement",
              expectedDecision: "STOP",
              expectedReason: "INPUT_CUSTODY_CHANGED",
            },
            `root-${boundary.endsWith("initial") ? "initial" : "final"}-${order}`,
          );
          let attacked = false;
          try {
            const receipt = await collectRecoveryReceipt(
              written.inputRoot,
              written.authorities,
              {
                async onBoundary(context) {
                  if (attacked || context.boundary !== boundary) return;
                  attacked = true;
                  const moved = `${written.inputRoot}.replaced`;
                  await rename(written.inputRoot, moved);
                  await cp(moved, written.inputRoot, { recursive: true });
                },
              },
              order,
            );
            expect(attacked).toBe(true);
            expect(receipt.reasons).toEqual(["INPUT_CUSTODY_CHANGED"]);
            receipts.push(receipt);
          } finally {
            await rm(written.caseRoot, { recursive: true, force: true });
            await rm(`${written.inputRoot}.replaced`, { recursive: true, force: true });
          }
        }
        expect(receipts[1]).toEqual(receipts[0]);
      },
    );

    it("rejects projection content drift introduced during the final root census", async () => {
      const written = await writeFixture(
        { name: "final census content drift", expectedDecision: "STOP", expectedReason: "INPUT_CUSTODY_CHANGED" },
        "final-census-content-drift",
      );
      let attacked = false;
      try {
        const receipt = await collectRecoveryReceipt(
          written.inputRoot,
          written.authorities,
          {
            async onBoundary(context) {
              if (attacked || context.boundary !== "input-root:census-final") return;
              attacked = true;
              await appendFile(path.join(written.inputRoot, RECOVERY_PROJECTION_FILES.pg_version), " ");
            },
          },
        );
        expect(attacked).toBe(true);
        expect(receipt).toMatchObject({
          decision: "STOP",
          reasons: ["INPUT_CUSTODY_CHANGED"],
          observed_at: null,
          engine: { physical_compatible: false },
        });
      } finally {
        await rm(written.caseRoot, { recursive: true, force: true });
      }
    });

    it("counts at least 96 new deterministic custody attacks", () => {
      expect(CUSTODY_BOUNDARY_ATTACKS).toHaveLength(102);
      expect(new Set(CUSTODY_BOUNDARY_ATTACKS.map((attack) => `${attack.boundary}:${attack.mode}`)).size)
        .toBe(CUSTODY_BOUNDARY_ATTACKS.length);
    });

    it.each([
      {
        name: "duplicate keys",
        bytes: "{\"major\":\"16\",\"major\":\"15\",\"schema\":\"markdoc-recovery-pg-version/v1\"}",
        reason: "INPUT_JSON_INVALID",
      },
      {
        name: "prototype key",
        bytes: "{\"__proto__\":null,\"major\":\"16\",\"schema\":\"markdoc-recovery-pg-version/v1\"}",
        reason: "INPUT_JSON_INVALID",
      },
      {
        name: "constructor key",
        bytes: "{\"constructor\":null,\"major\":\"16\",\"schema\":\"markdoc-recovery-pg-version/v1\"}",
        reason: "INPUT_JSON_INVALID",
      },
      {
        name: "UTF-8 BOM",
        bytes: Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from("{\"major\":\"16\",\"schema\":\"markdoc-recovery-pg-version/v1\"}"),
        ]),
        reason: "INPUT_CANONICAL_INVALID",
      },
      {
        name: "UTF-16 bytes",
        bytes: Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from("{\"major\":\"16\",\"schema\":\"markdoc-recovery-pg-version/v1\"}", "utf16le"),
        ]),
        reason: "INPUT_JSON_INVALID",
      },
      {
        name: "fatal UTF-8",
        bytes: Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]),
        reason: "INPUT_JSON_INVALID",
      },
      {
        name: "escaped lone surrogate",
        bytes: "{\"major\":\"\\ud800\",\"schema\":\"markdoc-recovery-pg-version/v1\"}",
        reason: "INPUT_JSON_INVALID",
      },
      {
        name: "non-NFC string",
        bytes: "{\"major\":\"e\u0301\",\"schema\":\"markdoc-recovery-pg-version/v1\"}",
        reason: "INPUT_CANONICAL_INVALID",
      },
      {
        name: "leading whitespace",
        bytes: " {\"major\":\"16\",\"schema\":\"markdoc-recovery-pg-version/v1\"}",
        reason: "INPUT_JSON_INVALID",
      },
      {
        name: "trailing newline",
        bytes: "{\"major\":\"16\",\"schema\":\"markdoc-recovery-pg-version/v1\"}\n",
        reason: "INPUT_JSON_INVALID",
      },
      {
        name: "noncanonical key order",
        bytes: "{\"schema\":\"markdoc-recovery-pg-version/v1\",\"major\":\"16\"}",
        reason: "INPUT_CANONICAL_INVALID",
      },
      {
        name: "unsafe integer",
        bytes: "{\"major\":9007199254740992,\"schema\":\"markdoc-recovery-pg-version/v1\"}",
        reason: "INPUT_FIELD_INVALID",
      },
    ])("strict canonical decoding rejects $name", async ({ name, bytes, reason }) => {
      const written = await writeFixture(
        {
          name,
          expectedDecision: "MALFORMED",
          expectedReason: reason as never,
        },
        `decode-${name.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
        { pg_version: bytes },
      );
      try {
        const receipt = await evaluateBoth(written);
        expect(receipt).toMatchObject({ decision: "MALFORMED", reasons: [reason] });
      } finally {
        await rm(written.caseRoot, { recursive: true, force: true });
      }
    });

    it("rejects calendar-normalized timestamps instead of accepting Date.parse coercion", async () => {
      const written = await writeFixture(
        {
          name: "invalid calendar date",
          expectedDecision: "MALFORMED",
          expectedReason: "INPUT_FIELD_INVALID",
          mutate(input) {
            input.pgbackrest_info.backups[0].timestamp.stop = "2026-04-31T08:00:00Z";
          },
        },
        "invalid-calendar-date",
      );
      try {
        const receipt = await evaluateBoth(written);
        expect(receipt).toMatchObject({ decision: "MALFORMED", reasons: ["INPUT_FIELD_INVALID"] });
      } finally {
        await rm(written.caseRoot, { recursive: true, force: true });
      }
    });

    it.each([
      {
        name: "duplicate member",
        mutate(manifest: Record<string, unknown>) {
          const members = manifest.members as Array<Record<string, unknown>>;
          members[1] = structuredClone(members[0]);
        },
        reason: "INPUT_MANIFEST_INVALID",
        decision: "MALFORMED",
      },
      {
        name: "missing member",
        mutate(manifest: Record<string, unknown>) {
          (manifest.members as unknown[]).pop();
        },
        reason: "INPUT_MANIFEST_INVALID",
        decision: "MALFORMED",
      },
      {
        name: "extra member",
        mutate(manifest: Record<string, unknown>) {
          (manifest.members as unknown[]).push({
            logical_name: "extra.json",
            byte_count: 0,
            sha256: "0".repeat(64),
          });
        },
        reason: "INPUT_MANIFEST_INVALID",
        decision: "MALFORMED",
      },
      {
        name: "traversal member",
        mutate(manifest: Record<string, unknown>) {
          (manifest.members as Array<Record<string, unknown>>)[0].logical_name = "../outside.json";
        },
        reason: "INPUT_FIELD_INVALID",
        decision: "MALFORMED",
      },
      {
        name: "case alias member",
        mutate(manifest: Record<string, unknown>) {
          (manifest.members as Array<Record<string, unknown>>)[0].logical_name = "Archive-Configuration.json";
        },
        reason: "INPUT_FIELD_INVALID",
        decision: "MALFORMED",
      },
      {
        name: "wrong observation nonce",
        mutate(manifest: Record<string, unknown>) {
          manifest.observation_nonce = "other-observation";
        },
        reason: "CAPTURE_AUTHORITY_REPLAYED",
        decision: "STOP",
      },
      {
        name: "wrong observation time",
        mutate(manifest: Record<string, unknown>) {
          manifest.observed_at = "2026-09-04T09:19:59Z";
        },
        reason: "CAPTURE_AUTHORITY_INVALID",
        decision: "STOP",
      },
      {
        name: "wrong production subject",
        mutate(manifest: Record<string, unknown>) {
          manifest.production_binding_subject = "other-subject";
        },
        reason: "INPUT_FIELD_INVALID",
        decision: "MALFORMED",
      },
      {
        name: "wrong capture operation",
        mutate(manifest: Record<string, unknown>) {
          manifest.capture_operation_identity = "other-operation/v1";
        },
        reason: "INPUT_FIELD_INVALID",
        decision: "MALFORMED",
      },
      {
        name: "manifest replay",
        mutate(manifest: Record<string, unknown>) {
          manifest.use_count = 2;
        },
        reason: "CAPTURE_AUTHORITY_REPLAYED",
        decision: "STOP",
      },
      {
        name: "manifest expiry mismatch",
        mutate(manifest: Record<string, unknown>) {
          manifest.valid_until = "2026-09-04T09:24:59Z";
        },
        reason: "CAPTURE_AUTHORITY_REPLAYED",
        decision: "STOP",
      },
      {
        name: "wrong member digest",
        mutate(manifest: Record<string, unknown>) {
          (manifest.members as Array<Record<string, unknown>>)[0].sha256 = "0".repeat(64);
        },
        reason: "INPUT_MEMBER_MISMATCH",
        decision: "STOP",
      },
      {
        name: "wrong member byte count",
        mutate(manifest: Record<string, unknown>) {
          const member = (manifest.members as Array<Record<string, unknown>>)[0];
          member.byte_count = Number(member.byte_count) + 1;
        },
        reason: "INPUT_MEMBER_MISMATCH",
        decision: "STOP",
      },
    ])("manifest attack rejects $name", async ({ name, mutate, reason, decision }) => {
      const written = await writeFixture(
        { name, expectedDecision: decision as "STOP", expectedReason: reason as never },
        `manifest-${name.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      );
      try {
        await rewriteManifest(written, mutate);
        const receipt = await evaluateBoth(written);
        expect(receipt).toMatchObject({ decision, reasons: [reason] });
      } finally {
        await rm(written.caseRoot, { recursive: true, force: true });
      }
    });

    it("rejects a manifest self-grant file inside the input root", async () => {
      const written = await writeFixture(
        {
          name: "manifest self grant",
          expectedDecision: "MALFORMED",
          expectedReason: "INPUT_FILE_UNEXPECTED",
        },
        "manifest-self-grant",
      );
      try {
        await writeFile(
          path.join(written.inputRoot, "capture-authority.json"),
          canonicalJson({ schema: RECOVERY_CAPTURE_AUTHORITY_SCHEMA, status: "accepted" }),
        );
        const receipt = await evaluateBoth(written);
        expect(receipt).toMatchObject({
          decision: "MALFORMED",
          reasons: ["INPUT_FILE_UNEXPECTED"],
          observed_at: null,
        });
      } finally {
        await rm(written.caseRoot, { recursive: true, force: true });
      }
    });

    it("rejects downstream projection fields that try to grant upstream authority", async () => {
      const written = await writeFixture(
        {
          name: "downstream grant",
          expectedDecision: "MALFORMED",
          expectedReason: "INPUT_UNKNOWN_FIELD",
          mutate(input) {
            (input.production_binding as unknown as Record<string, unknown>).capture_authority = "accepted";
          },
        },
        "downstream-authority-grant",
      );
      try {
        const receipt = await evaluateBoth(written);
        expect(receipt).toMatchObject({
          decision: "MALFORMED",
          reasons: ["INPUT_UNKNOWN_FIELD"],
          observed_at: null,
        });
      } finally {
        await rm(written.caseRoot, { recursive: true, force: true });
      }
    });

    it.each(["capture", "policy", "scratch"] as const)(
      "missing %s authority root cannot expose a positive claim",
      async (kind) => {
        const written = await writeFixture(
          { name: `missing ${kind}`, expectedDecision: "STOP", expectedReason: "CAPTURE_AUTHORITY_ABSENT" },
          `missing-authority-${kind}`,
        );
        try {
          const authorities = structuredClone(written.authorities) as unknown as Record<string, unknown>;
          delete authorities[kind];
          const receipt = await collectRecoveryReceipt(
            written.inputRoot,
            authorities as unknown as RecoveryAuthorityRoots,
          );
          expect(receipt.engine.physical_compatible).toBe(false);
          expect(receipt.engine.same_system_id).toBeNull();
          expect(receipt.archive.objective_seconds).toBeNull();
          expect(receipt.archive.meets_objective).toBeNull();
          expect(receipt.reasons).toEqual([
            kind === "capture"
              ? "CAPTURE_AUTHORITY_ABSENT"
              : kind === "policy"
                ? "POLICY_AUTHORITY_ROOT_ABSENT"
                : "SCRATCH_AUTHORITY_ROOT_ABSENT",
          ]);
        } finally {
          await rm(written.caseRoot, { recursive: true, force: true });
        }
      },
    );

    it.each(["capture", "policy", "scratch"] as const)(
      "fake %s authority digest is rejected",
      async (kind) => {
        const written = await writeFixture(
          { name: `fake ${kind}`, expectedDecision: "STOP", expectedReason: "INPUT_MEMBER_MISMATCH" },
          `fake-authority-${kind}`,
        );
        try {
          written.authorities[kind].sha256 = "0".repeat(64);
          const receipt = await evaluateBoth(written);
          expect(receipt.engine.physical_compatible).toBe(false);
          expect(receipt.observed_at).toBeNull();
          expect(receipt.reasons).toEqual(["INPUT_MEMBER_MISMATCH"]);
        } finally {
          await rm(written.caseRoot, { recursive: true, force: true });
        }
      },
    );

    it("rejects a coherently rehashed capture root that is not the accepted external identity", async () => {
      const receipts = [];
      for (const order of ["forward", "reverse"] as const) {
        const written = await writeFixture(
          { name: "coherent rehash", expectedDecision: "STOP", expectedReason: "INPUT_MEMBER_MISMATCH" },
          `coherent-rehashed-capture-root-${order}`,
        );
        try {
          const manifestPath = path.join(written.inputRoot, "capture-manifest.json");
          const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
          manifest.observation_nonce = "coherent-other-observation";
          const fakeManifestPath = `${manifestPath}.fake`;
          await writeFile(fakeManifestPath, canonicalJson(manifest));
          await rename(manifestPath, `${manifestPath}.accepted`);
          await rename(fakeManifestPath, manifestPath);
          const manifestDigest = await fileClaim("capture-manifest.json", manifestPath);
          const capturePath = written.authorities.capture.path;
          const capture = JSON.parse(await readFile(capturePath, "utf8")) as Record<string, unknown>;
          capture.observation_nonce = "coherent-other-observation";
          capture.manifest = manifestDigest;
          const fakeCapturePath = `${capturePath}.fake`;
          await writeFile(fakeCapturePath, canonicalJson(capture));
          await rename(capturePath, `${capturePath}.accepted`);
          await rename(fakeCapturePath, capturePath);
          const receipt = await collectRecoveryReceipt(
            written.inputRoot,
            written.authorities,
            undefined,
            order,
          );
          expect(receipt).toMatchObject({
            decision: "STOP",
            reasons: ["INPUT_PATH_AMBIGUOUS"],
            engine: { physical_compatible: false },
          });
          receipts.push(receipt);
        } finally {
          await rm(written.caseRoot, { recursive: true, force: true });
        }
      }
      expect(receipts[1]).toEqual(receipts[0]);
    });

    it.each([
      {
        kind: "capture" as const,
        name: "capture wrong nonce",
        mutate: (authority: Record<string, unknown>) => {
          authority.observation_nonce = "other-observation";
        },
        reason: "CAPTURE_AUTHORITY_REPLAYED",
      },
      {
        kind: "capture" as const,
        name: "capture future acceptance",
        mutate: (authority: Record<string, unknown>) => {
          authority.accepted_at = "2026-09-04T09:20:01Z";
        },
        reason: "CAPTURE_AUTHORITY_STALE",
      },
      {
        kind: "capture" as const,
        name: "capture stale acceptance",
        mutate: (authority: Record<string, unknown>) => {
          authority.accepted_at = "2026-09-04T09:04:59Z";
        },
        reason: "CAPTURE_AUTHORITY_STALE",
      },
      {
        kind: "capture" as const,
        name: "capture expired",
        mutate: (authority: Record<string, unknown>) => {
          authority.valid_until = "2026-09-04T09:24:59Z";
        },
        reason: "CAPTURE_AUTHORITY_REPLAYED",
      },
      {
        kind: "capture" as const,
        name: "capture use replay",
        mutate: (authority: Record<string, unknown>) => {
          authority.use_count = 2;
        },
        reason: "CAPTURE_AUTHORITY_REPLAYED",
      },
      {
        kind: "policy" as const,
        name: "policy root wrong nonce",
        mutate: (authority: Record<string, unknown>) => {
          authority.observation_nonce = "other-observation";
        },
        reason: "POLICY_AUTHORITY_ROOT_INVALID",
      },
      {
        kind: "policy" as const,
        name: "policy root wrong subject",
        mutate: (authority: Record<string, unknown>) => {
          authority.subject = "other-subject";
        },
        reason: "POLICY_AUTHORITY_ROOT_INVALID",
      },
      {
        kind: "policy" as const,
        name: "policy root future",
        mutate: (authority: Record<string, unknown>) => {
          authority.authenticated_at = "2026-09-04T09:20:01Z";
        },
        reason: "POLICY_AUTHORITY_ROOT_INVALID",
      },
      {
        kind: "policy" as const,
        name: "policy root stale",
        mutate: (authority: Record<string, unknown>) => {
          authority.authenticated_at = "2026-09-04T09:04:59Z";
        },
        reason: "POLICY_AUTHORITY_ROOT_INVALID",
      },
      {
        kind: "policy" as const,
        name: "policy root expired",
        mutate: (authority: Record<string, unknown>) => {
          authority.valid_until = "2026-09-04T09:24:59Z";
        },
        reason: "POLICY_AUTHORITY_ROOT_INVALID",
      },
      {
        kind: "policy" as const,
        name: "policy root replay",
        mutate: (authority: Record<string, unknown>) => {
          authority.use_count = 2;
        },
        reason: "POLICY_AUTHORITY_ROOT_INVALID",
      },
      {
        kind: "scratch" as const,
        name: "scratch root wrong nonce",
        mutate: (authority: Record<string, unknown>) => {
          authority.observation_nonce = "other-observation";
        },
        reason: "SCRATCH_AUTHORITY_ROOT_INVALID",
      },
      {
        kind: "scratch" as const,
        name: "scratch receipt time mismatch",
        mutate: (authority: Record<string, unknown>) => {
          authority.completed_at = "2026-09-03T05:00:01Z";
        },
        reason: "SCRATCH_AUTHORITY_ROOT_INVALID",
      },
      {
        kind: "scratch" as const,
        name: "scratch authority before completion",
        mutate: (authority: Record<string, unknown>) => {
          authority.authenticated_at = "2026-09-03T04:59:59Z";
        },
        reason: "SCRATCH_AUTHORITY_ROOT_INVALID",
      },
      {
        kind: "scratch" as const,
        name: "scratch authority future",
        mutate: (authority: Record<string, unknown>) => {
          authority.authenticated_at = "2026-09-04T09:20:01Z";
        },
        reason: "SCRATCH_AUTHORITY_ROOT_INVALID",
      },
      {
        kind: "scratch" as const,
        name: "scratch authority expired",
        mutate: (authority: Record<string, unknown>) => {
          authority.valid_until = "2026-09-04T09:24:59Z";
        },
        reason: "SCRATCH_AUTHORITY_ROOT_INVALID",
      },
      {
        kind: "scratch" as const,
        name: "scratch authority replay",
        mutate: (authority: Record<string, unknown>) => {
          authority.use_count = 2;
        },
        reason: "SCRATCH_AUTHORITY_ROOT_INVALID",
      },
    ])("$name fails closed under both evaluators", async ({ kind, name, mutate, reason }) => {
      const written = await writeFixture(
        { name, expectedDecision: "STOP", expectedReason: reason as never },
        `authority-${name.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      );
      try {
        await rewriteAuthority(written, kind, mutate);
        const receipt = await evaluateBoth(written);
        expect(receipt).toMatchObject({
          decision: "STOP",
          reasons: [reason],
          observed_at: null,
          engine: { same_system_id: null, physical_compatible: false },
          archive: { objective_seconds: null, meets_objective: null },
        });
      } finally {
        await rm(written.caseRoot, { recursive: true, force: true });
      }
    });

    it.each(["projection hard link", "manifest hard link"] as const)(
      "rejects %s identity ambiguity",
      async (attack) => {
        const written = await writeFixture(
          { name: attack, expectedDecision: "STOP", expectedReason: "INPUT_PATH_AMBIGUOUS" },
          `identity-${attack.replaceAll(" ", "-")}`,
        );
        try {
          const logicalName = attack.startsWith("manifest")
            ? "capture-manifest.json"
            : RECOVERY_PROJECTION_FILES.pg_version;
          const target = path.join(written.inputRoot, logicalName);
          const external = path.join(written.caseRoot, `${logicalName}.external`);
          await writeFile(external, await readFile(target));
          await unlink(target);
          await link(external, target);
          const receipt = await evaluateBoth(written);
          expect(receipt.engine.physical_compatible).toBe(false);
          expect(receipt.reasons).toContain("INPUT_PATH_AMBIGUOUS");
        } finally {
          await rm(written.caseRoot, { recursive: true, force: true });
        }
      },
    );

    it("rejects a native root symlink alias", async () => {
      const written = await writeFixture(
        { name: "root symlink alias", expectedDecision: "MALFORMED", expectedReason: "INPUT_ROOT_INVALID" },
        "identity-root-junction",
      );
      const alias = `${written.inputRoot}-alias`;
      try {
        await symlink(written.inputRoot, alias, "junction");
        const receipt = await collectRecoveryReceipt(
          alias,
          written.authorities,
        );
        expect(receipt).toMatchObject({
          decision: "MALFORMED",
          reasons: ["INPUT_ROOT_INVALID"],
          engine: { physical_compatible: false },
        });
      } finally {
        await rm(alias, { recursive: true, force: true });
        await rm(written.caseRoot, { recursive: true, force: true });
      }
    });

    it("strict-decodes an externally accepted malformed manifest instead of trusting its digest", async () => {
      const written = await writeFixture(
        { name: "manifest duplicate key", expectedDecision: "MALFORMED", expectedReason: "INPUT_JSON_INVALID" },
        "manifest-duplicate-key",
      );
      try {
        const manifest = await readFile(path.join(written.inputRoot, "capture-manifest.json"), "utf8");
        await writeRawManifest(written, manifest.replace("{", "{\"schema\":\"duplicate\","));
        const receipt = await evaluateBoth(written);
        expect(receipt).toMatchObject({ decision: "MALFORMED", reasons: ["INPUT_JSON_INVALID"] });
      } finally {
        await rm(written.caseRoot, { recursive: true, force: true });
      }
    });
  });

  it.each(RECOVERY_FIXTURES.map((fixture, index) => [index, fixture.name, fixture] as const))(
    "fixture %i: %s",
    async (index, _name, fixture) => {
      const written = await writeFixture(fixture, `fixture-${index.toString().padStart(3, "0")}`);
      try {
        const forward = await collectRecoveryReceipt(
          written.inputRoot,
          written.authorities,
          undefined,
          "forward",
        );
        const reverse = await collectRecoveryReceipt(
          written.inputRoot,
          written.authorities,
          undefined,
          "reverse",
        );

        expect(reverse).toEqual(forward);
        expect(forward.decision).toBe(fixture.expectedDecision);
        expect(forward.reasons).toContain(fixture.expectedReason);
        if (fixture.compatible !== undefined) {
          expect(forward.engine.physical_compatible).toBe(fixture.compatible);
        }
        if (fixture.compatible) {
          expect(forward.decision).toBe("STOP");
          expect(forward.reasons).toContain("HELD_NON_OPERATIONAL");
        }
        if (["OBSERVATION_FUTURE", "OBSERVATION_STALE"].includes(fixture.expectedReason)) {
          expect(forward.archive).toMatchObject({
            unarchived_age_bound_seconds: null,
            objective_seconds: null,
            meets_objective: null,
          });
          expect(forward.vm_recovery).toEqual({
            kind: null,
            pitr: false,
            recovery_point_utc: null,
          });
        }
        if (fixture.expectedReason === "ARCHIVE_CONFIGURATION_FUTURE") {
          expect(forward.archive.unarchived_age_bound_seconds).toBeNull();
          expect(forward.archive.meets_objective).toBeNull();
        }
        if (["VM_RECOVERY_FUTURE", "VM_RECOVERY_KIND_INVALID"].includes(fixture.expectedReason)) {
          expect(forward.vm_recovery).toEqual({
            kind: null,
            pitr: false,
            recovery_point_utc: null,
          });
        }
      } finally {
        await rm(written.caseRoot, { recursive: true, force: true });
      }
    },
  );

  it("treats equivalent timestamp spellings at the newest instant as ambiguous", async () => {
    const written = await writeFixture({
      name: "equivalent stop instants",
      expectedDecision: "STOP",
      expectedReason: "BACKUP_SELECTION_AMBIGUOUS",
      mutate(input) {
        input.pgbackrest_info.backups.push({
          status: "complete",
          error_code: 0,
          timestamp: { start: "2026-09-04T07:50:00Z", stop: "2026-09-04T08:00:00.000Z" },
          database: { id: 8, repo_key: 1 },
        });
        input.pgbackrest_info.history.push({
          id: 8,
          repo_key: 1,
          system_identifier: "7000000000000000002",
          version: "15.9",
        });
      },
    }, "equivalent-stop-instants");
    try {
      const receipt = await evaluateBoth(written);
      expect(receipt.reasons).toContain("BACKUP_SELECTION_AMBIGUOUS");
      expect(receipt.engine.backup_major).toBeNull();
      expect(receipt.engine.same_system_id).toBeNull();
      expect(receipt.engine.physical_compatible).toBe(false);
    } finally {
      await rm(written.caseRoot, { recursive: true, force: true });
    }
  });

  it("selects the newest complete non-error backup and binds its exact history tuple", async () => {
    const written = await writeFixture({
      name: "newest exact tuple",
      expectedDecision: "STOP",
      expectedReason: "BACKUP_MAJOR_MISMATCH",
      mutate(input) {
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
      },
    }, "newest-exact-tuple");
    try {
      const receipt = await evaluateBoth(written);
      expect(receipt.engine.backup_major).toBe(15);
      expect(receipt.engine.same_system_id).toBe(false);
      expect(receipt.reasons).toEqual(expect.arrayContaining(["BACKUP_MAJOR_MISMATCH", "SYSTEM_ID_MISMATCH"]));
    } finally {
      await rm(written.caseRoot, { recursive: true, force: true });
    }
  });

  it("uses only timeout plus oldest pending age and never creates a latest-restorable time", async () => {
    const written = await writeFixture({
      name: "conservative pending bound",
      expectedDecision: "STOP",
      expectedReason: "HELD_NON_OPERATIONAL",
      mutate(input) {
        input.archive_state.pending_ready = [
          { age_seconds: 12 },
          { age_seconds: 60 },
          { age_seconds: 3 },
        ];
      },
    }, "conservative-pending-bound");
    try {
      const receipt = await evaluateBoth(written);
      expect(receipt.archive).toMatchObject({
        archive_timeout_seconds: 240,
        pending_count: 3,
        oldest_pending_age_seconds: 60,
        unarchived_age_bound_seconds: 300,
        objective_seconds: 300,
        meets_objective: true,
      });
      expect(JSON.stringify(receipt)).not.toMatch(/latest.restorable|wal|segment|archive.timestamp/i);
    } finally {
      await rm(written.caseRoot, { recursive: true, force: true });
    }
  });

  it("does not round fractional health staleness down into the policy window", async () => {
    const written = await writeFixture({
      name: "fractional health staleness",
      expectedDecision: "STOP",
      expectedReason: "BACKUP_HEALTH_STALE",
      mutate(input) {
        input.observation_clock.observed_at = "2026-09-04T09:20:00.999Z";
        input.backup_health.observed_at = "2026-09-04T09:05:00.000Z";
      },
    }, "fractional-health-staleness");
    try {
      const receipt = await evaluateBoth(written);
      expect(receipt.archive.health_age_seconds).toBe(901);
      expect(receipt.archive.unarchived_age_bound_seconds).toBeNull();
      expect(receipt.archive.meets_objective).toBeNull();
      expect(receipt.engine.physical_compatible).toBe(false);
    } finally {
      await rm(written.caseRoot, { recursive: true, force: true });
    }
  });

  it("does not round fractional scratch staleness down into the drill window", async () => {
    const written = await writeFixture({
      name: "fractional scratch staleness",
      expectedDecision: "STOP",
      expectedReason: "SCRATCH_RESTORE_STALE",
      mutate(input) {
        input.observation_clock.observed_at = "2026-09-04T09:20:00.999Z";
        input.scratch_restore.completed_at = "2026-08-28T09:20:00.000Z";
      },
    }, "fractional-scratch-staleness");
    try {
      const receipt = await evaluateBoth(written);
      expect(receipt.scratch_restore.within_drill_age).toBe(false);
      expect(receipt.engine.physical_compatible).toBe(false);
      expect(receipt.reasons).toContain("SCRATCH_RESTORE_STALE");
    } finally {
      await rm(written.caseRoot, { recursive: true, force: true });
    }
  });

  it("emits only the closed value-safe receipt and does not retain input identities", async () => {
    const input = baseRecoveryProjectionSet();
    const written = await writeFixture(
      { name: "closed receipt", expectedDecision: "STOP", expectedReason: "HELD_NON_OPERATIONAL" },
      "closed-receipt",
    );
    const receipt = await collectRecoveryReceipt(written.inputRoot, written.authorities);
    try {
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
    } finally {
      await rm(written.caseRoot, { recursive: true, force: true });
    }
  });

  it("absent external authority stops before reading input and exposes no positive claim", async () => {
    const receipt = await collectRecoveryReceipt("relative-fixture-root");
    expect(receipt).toMatchObject({
      decision: "STOP",
      reasons: ["CAPTURE_AUTHORITY_ABSENT"],
      observed_at: null,
      engine: {
        same_system_id: null,
        physical_compatible: false,
      },
      archive: {
        objective_seconds: null,
        meets_objective: null,
      },
    });
  });

  it("caller-created authority values cannot produce a positive evaluator result", () => {
    const forgedAuthority = {
      capture_authenticated: true,
      policy_authenticated: true,
      scratch_authenticated: true,
    };
    for (const evaluator of [evaluateRecoveryProjectionSet, evaluateRecoveryProjectionSetReverse]) {
      const receipt = (evaluator as unknown as (
        input: ReturnType<typeof baseRecoveryProjectionSet>,
        authority: typeof forgedAuthority,
      ) => ReturnType<typeof evaluator>)(baseRecoveryProjectionSet(), forgedAuthority);
      expect(receipt).toMatchObject({
        decision: "STOP",
        reasons: ["CAPTURE_AUTHORITY_ABSENT"],
        observed_at: null,
        engine: { same_system_id: null, physical_compatible: false },
        archive: { objective_seconds: null, meets_objective: null },
      });
    }
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
