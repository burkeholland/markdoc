import { createHash } from "node:crypto";
import {
  constants,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

export const RECOVERY_CAPTURE_MANIFEST_SCHEMA = "markdoc-postgres-recovery-capture-manifest/v1";
export const RECOVERY_CAPTURE_AUTHORITY_SCHEMA = "markdoc-postgres-recovery-capture-authority/v1";
export const RECOVERY_POLICY_AUTHORITY_SCHEMA = "markdoc-postgres-recovery-policy-authority/v1";
export const RECOVERY_SCRATCH_AUTHORITY_SCHEMA = "markdoc-postgres-recovery-scratch-authority/v1";
export const RECOVERY_ACCEPTED_AUTHORITY_REFERENCE_SCHEMA = "markdoc-postgres-recovery-accepted-authority-reference/v1";
export const RECOVERY_CAPTURE_OPERATION = "markdoc-postgres-value-safe-capture/v1";
export const RECOVERY_PRODUCTION_BINDING_SUBJECT = "markdoc-production-postgresql";
export const RECOVERY_SCRATCH_SUBJECT = "markdoc-postgresql-scratch-restore";

export const RECOVERY_PROJECTION_FILES = Object.freeze({
  pg_version: "pg-version.json",
  active_binary_version: "active-binary-version.json",
  installed_package_version: "installed-package-version.json",
  control_data: "control-data.json",
  pgbackrest_info: "pgbackrest-info.json",
  archive_configuration: "archive-configuration.json",
  archive_state: "archive-state.json",
  backup_health: "backup-health.json",
  scratch_restore: "scratch-restore.json",
  production_binding: "production-binding.json",
  observation_clock: "observation-clock.json",
  rpo_policy: "rpo-policy.json",
  vm_recovery: "vm-recovery.json",
});

export type RecoveryProjectionName = keyof typeof RECOVERY_PROJECTION_FILES;

export type RecoveryCustodyReason =
  | "CAPTURE_AUTHORITY_ABSENT"
  | "CAPTURE_AUTHORITY_INVALID"
  | "CAPTURE_AUTHORITY_REPLAYED"
  | "CAPTURE_AUTHORITY_STALE"
  | "INPUT_CANONICAL_INVALID"
  | "INPUT_CUSTODY_CHANGED"
  | "INPUT_FIELD_INVALID"
  | "INPUT_FILE_MISSING"
  | "INPUT_FILE_UNEXPECTED"
  | "INPUT_IDENTITY_DUPLICATE"
  | "INPUT_JSON_INVALID"
  | "INPUT_MANIFEST_INVALID"
  | "INPUT_MEMBER_MISMATCH"
  | "INPUT_PATH_AMBIGUOUS"
  | "INPUT_ROOT_INVALID"
  | "INPUT_ROOT_NOT_ABSOLUTE"
  | "POLICY_AUTHORITY_ROOT_ABSENT"
  | "POLICY_AUTHORITY_ROOT_INVALID"
  | "SCRATCH_AUTHORITY_ROOT_ABSENT"
  | "SCRATCH_AUTHORITY_ROOT_INVALID";

export class RecoveryCustodyError extends Error {
  constructor(
    readonly reason: RecoveryCustodyReason,
    readonly decision: "STOP" | "MALFORMED" = "STOP",
  ) {
    super(reason);
  }
}

export interface AcceptedFileIdentity {
  path: string;
  realpath: string;
  device: string;
  inode: string;
  byte_count: number;
  sha256: string;
}

export interface AcceptedInputRootIdentity {
  path: string;
  realpath: string;
  device: string;
  inode: string;
}

export interface AcceptedAuthorityReference extends AcceptedFileIdentity {
  schema: typeof RECOVERY_ACCEPTED_AUTHORITY_REFERENCE_SCHEMA;
  kind: "capture" | "policy" | "scratch";
}

export interface RecoveryAuthorityRoots {
  capture: AcceptedAuthorityReference & {
    kind: "capture";
    input_root: AcceptedInputRootIdentity;
  };
  policy: AcceptedAuthorityReference & { kind: "policy" };
  scratch: AcceptedAuthorityReference & { kind: "scratch" };
}

export interface RecoveryFileClaim {
  logical_name: string;
  byte_count: number;
  sha256: string;
}

export interface RecoveryCaptureManifest {
  schema: typeof RECOVERY_CAPTURE_MANIFEST_SCHEMA;
  production_binding_subject: typeof RECOVERY_PRODUCTION_BINDING_SUBJECT;
  capture_operation_identity: typeof RECOVERY_CAPTURE_OPERATION;
  observation_nonce: string;
  observed_at: string;
  valid_until: string;
  use_count: number;
  members: RecoveryFileClaim[];
}

export interface RecoveryCaptureAuthority {
  schema: typeof RECOVERY_CAPTURE_AUTHORITY_SCHEMA;
  status: "accepted";
  subject: typeof RECOVERY_PRODUCTION_BINDING_SUBJECT;
  capture_operation_identity: typeof RECOVERY_CAPTURE_OPERATION;
  observation_nonce: string;
  accepted_at: string;
  valid_until: string;
  use_count: number;
  manifest: RecoveryFileClaim;
}

export interface RecoveryPolicyAuthority {
  schema: typeof RECOVERY_POLICY_AUTHORITY_SCHEMA;
  status: "accepted";
  subject: string;
  observation_nonce: string;
  authenticated_at: string;
  valid_until: string;
  use_count: number;
  policy: RecoveryFileClaim;
}

export interface RecoveryScratchAuthority {
  schema: typeof RECOVERY_SCRATCH_AUTHORITY_SCHEMA;
  status: "accepted";
  subject: typeof RECOVERY_SCRATCH_SUBJECT;
  observation_nonce: string;
  authorization: "verified-separate";
  completed_at: string;
  isolated: true;
  cleanup_complete: true;
  authenticated_at: string;
  valid_until: string;
  use_count: number;
  receipt: RecoveryFileClaim;
}

export type RecoveryAcquisitionBoundary =
  | "input-root:census-initial"
  | "input-root:census-final"
  | `${string}:read-1`
  | `${string}:read-2`
  | `${string}:read-final`;

export interface RecoveryAcquisitionHookContext {
  boundary: RecoveryAcquisitionBoundary;
  path: string;
  logical_name: string;
}

export interface RecoveryAcquisitionHooks {
  onBoundary?(context: RecoveryAcquisitionHookContext): void | Promise<void>;
}

export interface AuthenticatedRecoveryInput {
  projections: { [K in RecoveryProjectionName]: unknown };
  manifest: RecoveryCaptureManifest;
  capture_authority: RecoveryCaptureAuthority;
  policy_authority: RecoveryPolicyAuthority;
  scratch_authority: RecoveryScratchAuthority;
}

interface FileFingerprint {
  device: bigint;
  inode: bigint;
  byteCount: bigint;
  linkCount: bigint;
  mode: bigint;
  modifiedNanoseconds: bigint;
  changedNanoseconds: bigint;
}

interface DirectorySnapshot {
  handle: FileHandle;
  path: string;
  realpath: string;
  fingerprint: FileFingerprint;
}

interface FileSnapshot {
  handle: FileHandle;
  path: string;
  realpath: string;
  logicalName: string;
  fingerprint: FileFingerprint;
  bytes: Uint8Array;
  value: unknown;
}

interface OpenFileOptions {
  logicalName: string;
  maximumBytes: number;
  expected?: AcceptedFileIdentity | RecoveryFileClaim;
  expectedIdentity?: AcceptedFileIdentity;
  hooks?: RecoveryAcquisitionHooks;
}

const MAX_PROJECTION_BYTES = 1_048_576;
const MAX_AUTHORITY_BYTES = 65_536;
const MAX_MANIFEST_BYTES = 65_536;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_LOGICAL_NAME = /^[a-z0-9][a-z0-9-]{0,62}\.json$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const NONCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MANIFEST_LOGICAL_NAME = "capture-manifest.json";

export function isCanonicalUtcTimestamp(value: string): boolean {
  if (!ISO_UTC.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const normalized = new Date(milliseconds).toISOString();
  return normalized === value || normalized.replace(".000Z", "Z") === value;
}

function fingerprint(stats: BigIntStats): FileFingerprint {
  return {
    device: stats.dev,
    inode: stats.ino,
    byteCount: stats.size,
    linkCount: stats.nlink,
    mode: stats.mode,
    modifiedNanoseconds: stats.mtimeNs,
    changedNanoseconds: stats.ctimeNs,
  };
}

function sameIdentity(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return sameIdentity(left, right)
    && left.byteCount === right.byteCount
    && left.linkCount === right.linkCount
    && left.mode === right.mode
    && left.modifiedNanoseconds === right.modifiedNanoseconds
    && left.changedNanoseconds === right.changedNanoseconds;
}

function isRegularFile(stats: BigIntStats): boolean {
  return stats.isFile() && !stats.isSymbolicLink();
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort(compareUnicodeCodePoints)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function assertNormalizedString(value: string): void {
  if (value.normalize("NFC") !== value) throw new RecoveryCustodyError("INPUT_CANONICAL_INVALID", "MALFORMED");
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new RecoveryCustodyError("INPUT_JSON_INVALID", "MALFORMED");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new RecoveryCustodyError("INPUT_JSON_INVALID", "MALFORMED");
    }
  }
}

class StrictJsonParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    const value = this.parseValue();
    if (this.index !== this.text.length) this.fail("INPUT_JSON_INVALID");
    if (canonicalJson(value) !== this.text) this.fail("INPUT_CANONICAL_INVALID");
    return value;
  }

  private parseValue(): unknown {
    const character = this.text[this.index];
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === "\"") return this.parseString();
    if (character === "t" && this.takeLiteral("true")) return true;
    if (character === "f" && this.takeLiteral("false")) return false;
    if (character === "n" && this.takeLiteral("null")) return null;
    if (character === "-" || (character >= "0" && character <= "9")) return this.parseNumber();
    this.fail("INPUT_JSON_INVALID");
  }

  private parseObject(): Record<string, unknown> {
    this.index += 1;
    const object: Record<string, unknown> = Object.create(null);
    const keys = new Set<string>();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return object;
    }
    while (this.index < this.text.length) {
      if (this.text[this.index] !== "\"") this.fail("INPUT_JSON_INVALID");
      const key = this.parseString();
      if (keys.has(key) || PROTOTYPE_KEYS.has(key)) this.fail("INPUT_JSON_INVALID");
      keys.add(key);
      if (this.text[this.index] !== ":") this.fail("INPUT_JSON_INVALID");
      this.index += 1;
      object[key] = this.parseValue();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return object;
      }
      if (this.text[this.index] !== ",") this.fail("INPUT_JSON_INVALID");
      this.index += 1;
    }
    this.fail("INPUT_JSON_INVALID");
  }

  private parseArray(): unknown[] {
    this.index += 1;
    const values: unknown[] = [];
    if (this.text[this.index] === "]") {
      this.index += 1;
      return values;
    }
    while (this.index < this.text.length) {
      values.push(this.parseValue());
      if (this.text[this.index] === "]") {
        this.index += 1;
        return values;
      }
      if (this.text[this.index] !== ",") this.fail("INPUT_JSON_INVALID");
      this.index += 1;
    }
    this.fail("INPUT_JSON_INVALID");
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        let value: unknown;
        try {
          value = JSON.parse(this.text.slice(start, this.index));
        } catch {
          this.fail("INPUT_JSON_INVALID");
        }
        if (typeof value !== "string") this.fail("INPUT_JSON_INVALID");
        assertNormalizedString(value);
        return value;
      }
      if (code < 0x20) this.fail("INPUT_JSON_INVALID");
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.text[this.index];
        if (escape === "u") {
          const hex = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[a-fA-F0-9]{4}$/.test(hex)) this.fail("INPUT_JSON_INVALID");
          this.index += 5;
          continue;
        }
        if (!escape || !"\"\\/bfnrt".includes(escape)) this.fail("INPUT_JSON_INVALID");
      }
      this.index += 1;
    }
    this.fail("INPUT_JSON_INVALID");
  }

  private parseNumber(): number {
    const rest = this.text.slice(this.index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (!match) this.fail("INPUT_JSON_INVALID");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isSafeInteger(value)) this.fail("INPUT_FIELD_INVALID");
    return value;
  }

  private takeLiteral(literal: string): boolean {
    if (!this.text.startsWith(literal, this.index)) return false;
    this.index += literal.length;
    return true;
  }

  private fail(reason: "INPUT_CANONICAL_INVALID" | "INPUT_FIELD_INVALID" | "INPUT_JSON_INVALID"): never {
    throw new RecoveryCustodyError(reason, "MALFORMED");
  }
}

export function parseCanonicalJsonBytes(bytes: Uint8Array): unknown {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new RecoveryCustodyError("INPUT_CANONICAL_INVALID", "MALFORMED");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new RecoveryCustodyError("INPUT_JSON_INVALID", "MALFORMED");
  }
  return new StrictJsonParser(text).parse();
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RecoveryCustodyError("INPUT_FIELD_INVALID", "MALFORMED");
  }
  return value as Record<string, unknown>;
}

function exactKeys(object: Record<string, unknown>, required: readonly string[]): void {
  const expected = new Set(required);
  if (Object.keys(object).length !== expected.size || required.some((key) => !Object.hasOwn(object, key))) {
    throw new RecoveryCustodyError("INPUT_FIELD_INVALID", "MALFORMED");
  }
  if (Object.keys(object).some((key) => !expected.has(key))) {
    throw new RecoveryCustodyError("INPUT_FIELD_INVALID", "MALFORMED");
  }
}

function stringValue(object: Record<string, unknown>, key: string, pattern?: RegExp): string {
  const value = object[key];
  if (typeof value !== "string" || (pattern && !pattern.test(value))) {
    throw new RecoveryCustodyError("INPUT_FIELD_INVALID", "MALFORMED");
  }
  return value;
}

function timestampValue(object: Record<string, unknown>, key: string): string {
  const value = stringValue(object, key);
  if (!isCanonicalUtcTimestamp(value)) throw new RecoveryCustodyError("INPUT_FIELD_INVALID", "MALFORMED");
  return value;
}

function integerValue(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  if (!safeInteger(value)) throw new RecoveryCustodyError("INPUT_FIELD_INVALID", "MALFORMED");
  return value;
}

function exactValue<T extends string | boolean>(
  object: Record<string, unknown>,
  key: string,
  expected: T,
): T {
  if (object[key] !== expected) throw new RecoveryCustodyError("INPUT_FIELD_INVALID", "MALFORMED");
  return expected;
}

function parseFileClaim(value: unknown): RecoveryFileClaim {
  const object = asObject(value);
  exactKeys(object, ["logical_name", "byte_count", "sha256"]);
  return {
    logical_name: stringValue(object, "logical_name", SAFE_LOGICAL_NAME),
    byte_count: integerValue(object, "byte_count"),
    sha256: stringValue(object, "sha256", SHA256),
  };
}

function parseCaptureManifest(value: unknown): RecoveryCaptureManifest {
  const object = asObject(value);
  exactKeys(object, [
    "schema",
    "production_binding_subject",
    "capture_operation_identity",
    "observation_nonce",
    "observed_at",
    "valid_until",
    "use_count",
    "members",
  ]);
  exactValue(object, "schema", RECOVERY_CAPTURE_MANIFEST_SCHEMA);
  const members = object.members;
  if (!Array.isArray(members) || members.length !== 13) {
    throw new RecoveryCustodyError("INPUT_MANIFEST_INVALID", "MALFORMED");
  }
  return {
    schema: RECOVERY_CAPTURE_MANIFEST_SCHEMA,
    production_binding_subject: exactValue(
      object,
      "production_binding_subject",
      RECOVERY_PRODUCTION_BINDING_SUBJECT,
    ),
    capture_operation_identity: exactValue(
      object,
      "capture_operation_identity",
      RECOVERY_CAPTURE_OPERATION,
    ),
    observation_nonce: stringValue(object, "observation_nonce", NONCE),
    observed_at: timestampValue(object, "observed_at"),
    valid_until: timestampValue(object, "valid_until"),
    use_count: integerValue(object, "use_count"),
    members: members.map(parseFileClaim),
  };
}

function parseCaptureAuthority(value: unknown): RecoveryCaptureAuthority {
  const object = asObject(value);
  exactKeys(object, [
    "schema",
    "status",
    "subject",
    "capture_operation_identity",
    "observation_nonce",
    "accepted_at",
    "valid_until",
    "use_count",
    "manifest",
  ]);
  return {
    schema: exactValue(object, "schema", RECOVERY_CAPTURE_AUTHORITY_SCHEMA),
    status: exactValue(object, "status", "accepted"),
    subject: exactValue(object, "subject", RECOVERY_PRODUCTION_BINDING_SUBJECT),
    capture_operation_identity: exactValue(
      object,
      "capture_operation_identity",
      RECOVERY_CAPTURE_OPERATION,
    ),
    observation_nonce: stringValue(object, "observation_nonce", NONCE),
    accepted_at: timestampValue(object, "accepted_at"),
    valid_until: timestampValue(object, "valid_until"),
    use_count: integerValue(object, "use_count"),
    manifest: parseFileClaim(object.manifest),
  };
}

function parsePolicyAuthority(value: unknown): RecoveryPolicyAuthority {
  const object = asObject(value);
  exactKeys(object, [
    "schema",
    "status",
    "subject",
    "observation_nonce",
    "authenticated_at",
    "valid_until",
    "use_count",
    "policy",
  ]);
  return {
    schema: exactValue(object, "schema", RECOVERY_POLICY_AUTHORITY_SCHEMA),
    status: exactValue(object, "status", "accepted"),
    subject: stringValue(object, "subject"),
    observation_nonce: stringValue(object, "observation_nonce", NONCE),
    authenticated_at: timestampValue(object, "authenticated_at"),
    valid_until: timestampValue(object, "valid_until"),
    use_count: integerValue(object, "use_count"),
    policy: parseFileClaim(object.policy),
  };
}

function parseScratchAuthority(value: unknown): RecoveryScratchAuthority {
  const object = asObject(value);
  exactKeys(object, [
    "schema",
    "status",
    "subject",
    "observation_nonce",
    "authorization",
    "completed_at",
    "isolated",
    "cleanup_complete",
    "authenticated_at",
    "valid_until",
    "use_count",
    "receipt",
  ]);
  return {
    schema: exactValue(object, "schema", RECOVERY_SCRATCH_AUTHORITY_SCHEMA),
    status: exactValue(object, "status", "accepted"),
    subject: exactValue(object, "subject", RECOVERY_SCRATCH_SUBJECT),
    observation_nonce: stringValue(object, "observation_nonce", NONCE),
    authorization: exactValue(object, "authorization", "verified-separate"),
    completed_at: timestampValue(object, "completed_at"),
    isolated: exactValue(object, "isolated", true),
    cleanup_complete: exactValue(object, "cleanup_complete", true),
    authenticated_at: timestampValue(object, "authenticated_at"),
    valid_until: timestampValue(object, "valid_until"),
    use_count: integerValue(object, "use_count"),
    receipt: parseFileClaim(object.receipt),
  };
}

function parseReference(
  value: unknown,
  expectedKind: AcceptedAuthorityReference["kind"],
): AcceptedAuthorityReference {
  const object = asObject(value);
  exactKeys(object, [
    "schema",
    "kind",
    "path",
    "realpath",
    "device",
    "inode",
    "byte_count",
    "sha256",
  ]);
  const filePath = stringValue(object, "path");
  const nativeRealpath = stringValue(object, "realpath");
  if (
    !path.isAbsolute(filePath)
    || !path.isAbsolute(nativeRealpath)
    || filePath.normalize("NFC") !== filePath
    || nativeRealpath.normalize("NFC") !== nativeRealpath
  ) {
    throw new RecoveryCustodyError(
      expectedKind === "capture"
        ? "CAPTURE_AUTHORITY_INVALID"
        : expectedKind === "policy"
          ? "POLICY_AUTHORITY_ROOT_INVALID"
          : "SCRATCH_AUTHORITY_ROOT_INVALID",
    );
  }
  return {
    schema: exactValue(object, "schema", RECOVERY_ACCEPTED_AUTHORITY_REFERENCE_SCHEMA),
    kind: exactValue(object, "kind", expectedKind),
    path: filePath,
    realpath: nativeRealpath,
    device: stringValue(object, "device", /^\d+$/),
    inode: stringValue(object, "inode", /^\d+$/),
    byte_count: integerValue(object, "byte_count"),
    sha256: stringValue(object, "sha256", SHA256),
  };
}

function parseInputRootIdentity(value: unknown): AcceptedInputRootIdentity {
  const object = asObject(value);
  exactKeys(object, ["path", "realpath", "device", "inode"]);
  const rootPath = stringValue(object, "path");
  const nativeRealpath = stringValue(object, "realpath");
  if (
    !path.isAbsolute(rootPath)
    || !path.isAbsolute(nativeRealpath)
    || rootPath.normalize("NFC") !== rootPath
    || nativeRealpath.normalize("NFC") !== nativeRealpath
  ) {
    throw new RecoveryCustodyError("CAPTURE_AUTHORITY_INVALID");
  }
  return {
    path: rootPath,
    realpath: nativeRealpath,
    device: stringValue(object, "device", /^\d+$/),
    inode: stringValue(object, "inode", /^\d+$/),
  };
}

function parseAuthorityRoots(value: unknown): RecoveryAuthorityRoots {
  const object = asObject(value);
  exactKeys(object, ["capture", "policy", "scratch"]);
  const captureObject = asObject(object.capture);
  exactKeys(captureObject, [
    "schema",
    "kind",
    "path",
    "realpath",
    "device",
    "inode",
    "byte_count",
    "sha256",
    "input_root",
  ]);
  const { input_root: inputRoot, ...captureReference } = captureObject;
  return {
    capture: {
      ...parseReference(captureReference, "capture"),
      kind: "capture",
      input_root: parseInputRootIdentity(inputRoot),
    },
    policy: { ...parseReference(object.policy, "policy"), kind: "policy" },
    scratch: { ...parseReference(object.scratch, "scratch"), kind: "scratch" },
  };
}

async function bigintLstat(filePath: string): Promise<BigIntStats> {
  return lstat(filePath, { bigint: true });
}

function noFollowReadFlags(): number {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}

async function readDescriptorExactly(
  handle: FileHandle,
  byteCount: bigint,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (byteCount < BigInt(0) || byteCount > BigInt(maximumBytes) || byteCount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RecoveryCustodyError("INPUT_FIELD_INVALID", "MALFORMED");
  }
  const expected = Number(byteCount);
  const bytes = new Uint8Array(expected);
  let offset = 0;
  while (offset < expected) {
    const result = await handle.read(bytes, offset, expected - offset, offset);
    if (result.bytesRead === 0) throw new RecoveryCustodyError("INPUT_CUSTODY_CHANGED");
    offset += result.bytesRead;
  }
  const eof = new Uint8Array(1);
  const extra = await handle.read(eof, 0, 1, expected);
  if (extra.bytesRead !== 0) throw new RecoveryCustodyError("INPUT_CUSTODY_CHANGED");
  return bytes;
}

async function callHook(
  hooks: RecoveryAcquisitionHooks | undefined,
  boundary: RecoveryAcquisitionBoundary,
  filePath: string,
  logicalName: string,
): Promise<void> {
  await hooks?.onBoundary?.({ boundary, path: filePath, logical_name: logicalName });
}

async function verifyFileIdentity(snapshot: FileSnapshot): Promise<void> {
  const descriptorStats = await snapshot.handle.stat({ bigint: true });
  const pathStats = await bigintLstat(snapshot.path);
  const nativeRealpath = await realpath(snapshot.path);
  const descriptorFingerprint = fingerprint(descriptorStats);
  const pathFingerprint = fingerprint(pathStats);
  if (
    !isRegularFile(descriptorStats)
    || !isRegularFile(pathStats)
    || descriptorFingerprint.linkCount !== BigInt(1)
    || !sameFingerprint(snapshot.fingerprint, descriptorFingerprint)
    || !sameFingerprint(snapshot.fingerprint, pathFingerprint)
    || nativeRealpath !== snapshot.realpath
  ) {
    throw new RecoveryCustodyError("INPUT_CUSTODY_CHANGED");
  }
}

function assertExpectedFile(
  snapshot: FileSnapshot,
  expected: AcceptedFileIdentity | RecoveryFileClaim | undefined,
  expectedIdentity: AcceptedFileIdentity | undefined,
): void {
  if (expected) {
    if (
      Number(snapshot.fingerprint.byteCount) !== expected.byte_count
      || sha256(snapshot.bytes) !== expected.sha256
    ) {
      throw new RecoveryCustodyError("INPUT_MEMBER_MISMATCH");
    }
    if ("logical_name" in expected && snapshot.logicalName !== expected.logical_name) {
      throw new RecoveryCustodyError("INPUT_MEMBER_MISMATCH");
    }
  }
  if (expectedIdentity) {
    if (
      snapshot.path !== expectedIdentity.path
      || snapshot.realpath !== expectedIdentity.realpath
      || snapshot.fingerprint.device.toString() !== expectedIdentity.device
      || snapshot.fingerprint.inode.toString() !== expectedIdentity.inode
    ) {
      throw new RecoveryCustodyError("INPUT_CUSTODY_CHANGED");
    }
  }
}

async function openStableFile(filePath: string, options: OpenFileOptions): Promise<FileSnapshot> {
  const preStats = await bigintLstat(filePath);
  if (!isRegularFile(preStats) || preStats.nlink !== BigInt(1)) {
    throw new RecoveryCustodyError("INPUT_PATH_AMBIGUOUS");
  }
  const handle = await open(filePath, noFollowReadFlags());
  try {
    const descriptorStats = await handle.stat({ bigint: true });
    const postStats = await bigintLstat(filePath);
    const nativeRealpath = await realpath(filePath);
    const initialFingerprint = fingerprint(descriptorStats);
    if (
      !isRegularFile(descriptorStats)
      || descriptorStats.nlink !== BigInt(1)
      || !sameFingerprint(fingerprint(preStats), initialFingerprint)
      || !sameFingerprint(fingerprint(postStats), initialFingerprint)
      || nativeRealpath !== path.resolve(filePath)
    ) {
      throw new RecoveryCustodyError("INPUT_PATH_AMBIGUOUS");
    }

    const first = await readDescriptorExactly(handle, initialFingerprint.byteCount, options.maximumBytes);
    const provisional: FileSnapshot = {
      handle,
      path: filePath,
      realpath: nativeRealpath,
      logicalName: options.logicalName,
      fingerprint: initialFingerprint,
      bytes: first,
      value: null,
    };
    await callHook(options.hooks, `${options.logicalName}:read-1`, filePath, options.logicalName);
    await verifyFileIdentity(provisional);
    const second = await readDescriptorExactly(handle, initialFingerprint.byteCount, options.maximumBytes);
    await callHook(options.hooks, `${options.logicalName}:read-2`, filePath, options.logicalName);
    await verifyFileIdentity(provisional);
    if (!first.every((value, index) => value === second[index])) {
      throw new RecoveryCustodyError("INPUT_CUSTODY_CHANGED");
    }
    provisional.value = parseCanonicalJsonBytes(first);
    assertExpectedFile(provisional, options.expected, options.expectedIdentity);
    return provisional;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function finalRead(snapshot: FileSnapshot, hooks: RecoveryAcquisitionHooks | undefined): Promise<void> {
  const bytes = await readDescriptorExactly(snapshot.handle, snapshot.fingerprint.byteCount, snapshot.bytes.length);
  await callHook(hooks, `${snapshot.logicalName}:read-final`, snapshot.path, snapshot.logicalName);
  await verifyFileIdentity(snapshot);
  if (!snapshot.bytes.every((value, index) => value === bytes[index])) {
    throw new RecoveryCustodyError("INPUT_CUSTODY_CHANGED");
  }
}

async function openInputRoot(
  inputRoot: string,
  expected: AcceptedInputRootIdentity,
): Promise<DirectorySnapshot> {
  if (!path.isAbsolute(inputRoot)) throw new RecoveryCustodyError("INPUT_ROOT_NOT_ABSOLUTE", "MALFORMED");
  if (inputRoot.normalize("NFC") !== inputRoot || path.resolve(inputRoot) !== inputRoot) {
    throw new RecoveryCustodyError("INPUT_PATH_AMBIGUOUS");
  }
  const preStats = await bigintLstat(inputRoot);
  if (!preStats.isDirectory() || preStats.isSymbolicLink()) {
    throw new RecoveryCustodyError("INPUT_ROOT_INVALID", "MALFORMED");
  }
  const handle = await open(inputRoot, noFollowReadFlags());
  try {
    const descriptorStats = await handle.stat({ bigint: true });
    const postStats = await bigintLstat(inputRoot);
    const nativeRealpath = await realpath(inputRoot);
    const initialFingerprint = fingerprint(descriptorStats);
    if (
      !descriptorStats.isDirectory()
      || descriptorStats.isSymbolicLink()
      || !sameFingerprint(fingerprint(preStats), initialFingerprint)
      || !sameFingerprint(fingerprint(postStats), initialFingerprint)
      || nativeRealpath !== inputRoot
      || expected.path !== inputRoot
      || expected.realpath !== nativeRealpath
      || expected.device !== initialFingerprint.device.toString()
      || expected.inode !== initialFingerprint.inode.toString()
    ) {
      throw new RecoveryCustodyError("INPUT_CUSTODY_CHANGED");
    }
    return { handle, path: inputRoot, realpath: nativeRealpath, fingerprint: initialFingerprint };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function verifyInputRoot(root: DirectorySnapshot): Promise<void> {
  const descriptorStats = await root.handle.stat({ bigint: true });
  const pathStats = await bigintLstat(root.path);
  const nativeRealpath = await realpath(root.path);
  if (
    !descriptorStats.isDirectory()
    || pathStats.isSymbolicLink()
    || !pathStats.isDirectory()
    || !sameFingerprint(root.fingerprint, fingerprint(descriptorStats))
    || !sameFingerprint(root.fingerprint, fingerprint(pathStats))
    || nativeRealpath !== root.realpath
  ) {
    throw new RecoveryCustodyError("INPUT_CUSTODY_CHANGED");
  }
}

function assertCensus(entries: Dirent[]): void {
  const expected = [MANIFEST_LOGICAL_NAME, ...Object.values(RECOVERY_PROJECTION_FILES)].sort();
  const names = entries.map((entry) => entry.name).sort();
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new RecoveryCustodyError("INPUT_PATH_AMBIGUOUS");
  }
  if (
    names.length !== expected.length
    || names.some((name, index) => name !== expected[index])
  ) {
    const missing = expected.some((name) => !names.includes(name));
    throw new RecoveryCustodyError(
      missing ? "INPUT_FILE_MISSING" : "INPUT_FILE_UNEXPECTED",
      missing ? "STOP" : "MALFORMED",
    );
  }
  const folded = new Set<string>();
  for (const name of names) {
    if (!SAFE_LOGICAL_NAME.test(name) || name.normalize("NFC") !== name) {
      throw new RecoveryCustodyError("INPUT_PATH_AMBIGUOUS");
    }
    const key = name.toLocaleLowerCase("en-US");
    if (folded.has(key)) throw new RecoveryCustodyError("INPUT_PATH_AMBIGUOUS");
    folded.add(key);
  }
}

async function readCensus(
  root: DirectorySnapshot,
  phase: "initial" | "final",
  hooks: RecoveryAcquisitionHooks | undefined,
): Promise<void> {
  const entries = await readdir(root.realpath, { withFileTypes: true });
  await callHook(hooks, `input-root:census-${phase}`, root.path, "input-root");
  await verifyInputRoot(root);
  assertCensus(entries);
}

async function verifyTerminalSnapshot(
  root: DirectorySnapshot,
  snapshots: readonly FileSnapshot[],
): Promise<void> {
  const entries = await readdir(root.realpath, { withFileTypes: true });
  await Promise.all([
    verifyInputRoot(root),
    ...snapshots.map((snapshot) => verifyFileIdentity(snapshot)),
  ]);
  assertCensus(entries);
}

function assertOutsideInputRoot(authorityPath: string, inputRoot: string): void {
  const relative = path.relative(inputRoot, authorityPath);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new RecoveryCustodyError("CAPTURE_AUTHORITY_INVALID");
  }
}

function exactMemberClaims(manifest: RecoveryCaptureManifest): Map<string, RecoveryFileClaim> {
  const expected = Object.values(RECOVERY_PROJECTION_FILES).toSorted();
  const names = manifest.members.map((member) => member.logical_name);
  if (
    names.length !== expected.length
    || names.some((name, index) => name !== expected[index])
    || new Set(names).size !== expected.length
  ) {
    throw new RecoveryCustodyError("INPUT_MANIFEST_INVALID", "MALFORMED");
  }
  return new Map(manifest.members.map((member) => [member.logical_name, member]));
}

function claimsEqual(left: RecoveryFileClaim, right: RecoveryFileClaim): boolean {
  return left.logical_name === right.logical_name
    && left.byte_count === right.byte_count
    && left.sha256 === right.sha256;
}

function assertInitialAuthorityRelations(
  capture: RecoveryCaptureAuthority,
  policy: RecoveryPolicyAuthority,
  scratch: RecoveryScratchAuthority,
): void {
  if (
    capture.status !== "accepted"
    || capture.subject !== RECOVERY_PRODUCTION_BINDING_SUBJECT
    || capture.capture_operation_identity !== RECOVERY_CAPTURE_OPERATION
    || capture.manifest.logical_name !== MANIFEST_LOGICAL_NAME
  ) {
    throw new RecoveryCustodyError("CAPTURE_AUTHORITY_INVALID");
  }
  if (policy.status !== "accepted" || policy.policy.logical_name !== RECOVERY_PROJECTION_FILES.rpo_policy) {
    throw new RecoveryCustodyError("POLICY_AUTHORITY_ROOT_INVALID");
  }
  if (
    scratch.status !== "accepted"
    || scratch.subject !== RECOVERY_SCRATCH_SUBJECT
    || scratch.authorization !== "verified-separate"
    || scratch.receipt.logical_name !== RECOVERY_PROJECTION_FILES.scratch_restore
  ) {
    throw new RecoveryCustodyError("SCRATCH_AUTHORITY_ROOT_INVALID");
  }
}

export async function withAuthenticatedRecoveryInput<T>(
  inputRoot: string,
  authorities: RecoveryAuthorityRoots | undefined,
  consume: (input: AuthenticatedRecoveryInput) => T | Promise<T>,
  hooks?: RecoveryAcquisitionHooks,
): Promise<T> {
  if (!authorities?.capture) throw new RecoveryCustodyError("CAPTURE_AUTHORITY_ABSENT");
  if (!authorities.policy) throw new RecoveryCustodyError("POLICY_AUTHORITY_ROOT_ABSENT");
  if (!authorities.scratch) throw new RecoveryCustodyError("SCRATCH_AUTHORITY_ROOT_ABSENT");

  let roots: RecoveryAuthorityRoots;
  try {
    roots = parseAuthorityRoots(authorities);
  } catch (error) {
    if (error instanceof RecoveryCustodyError || (error instanceof Error && error.name === "ProjectionError")) throw error;
    throw new RecoveryCustodyError("CAPTURE_AUTHORITY_INVALID");
  }

  const snapshots: FileSnapshot[] = [];
  let directory: DirectorySnapshot | undefined;
  try {
    const captureSnapshot = await openStableFile(roots.capture.path, {
      logicalName: "capture-authority-root",
      maximumBytes: MAX_AUTHORITY_BYTES,
      expected: roots.capture,
      expectedIdentity: roots.capture,
      hooks,
    });
    snapshots.push(captureSnapshot);
    const captureAuthority = parseCaptureAuthority(captureSnapshot.value);

    const policySnapshot = await openStableFile(roots.policy.path, {
      logicalName: "policy-authority-root",
      maximumBytes: MAX_AUTHORITY_BYTES,
      expected: roots.policy,
      expectedIdentity: roots.policy,
      hooks,
    });
    snapshots.push(policySnapshot);
    const policyAuthority = parsePolicyAuthority(policySnapshot.value);

    const scratchSnapshot = await openStableFile(roots.scratch.path, {
      logicalName: "scratch-authority-root",
      maximumBytes: MAX_AUTHORITY_BYTES,
      expected: roots.scratch,
      expectedIdentity: roots.scratch,
      hooks,
    });
    snapshots.push(scratchSnapshot);
    const scratchAuthority = parseScratchAuthority(scratchSnapshot.value);
    assertInitialAuthorityRelations(captureAuthority, policyAuthority, scratchAuthority);

    directory = await openInputRoot(inputRoot, roots.capture.input_root);
    assertOutsideInputRoot(captureSnapshot.realpath, directory.realpath);
    assertOutsideInputRoot(policySnapshot.realpath, directory.realpath);
    assertOutsideInputRoot(scratchSnapshot.realpath, directory.realpath);
    const externalIdentities = new Set(
      snapshots.map((snapshot) => `${snapshot.fingerprint.device}:${snapshot.fingerprint.inode}`),
    );
    if (externalIdentities.size !== snapshots.length) {
      throw new RecoveryCustodyError("INPUT_IDENTITY_DUPLICATE");
    }

    await readCensus(directory, "initial", hooks);
    const manifestPath = path.join(directory.realpath, MANIFEST_LOGICAL_NAME);
    const manifestSnapshot = await openStableFile(manifestPath, {
      logicalName: MANIFEST_LOGICAL_NAME,
      maximumBytes: MAX_MANIFEST_BYTES,
      expected: captureAuthority.manifest,
      hooks,
    });
    snapshots.push(manifestSnapshot);
    const manifestIdentity = `${manifestSnapshot.fingerprint.device}:${manifestSnapshot.fingerprint.inode}`;
    if (externalIdentities.has(manifestIdentity)) {
      throw new RecoveryCustodyError("INPUT_IDENTITY_DUPLICATE");
    }
    const manifest = parseCaptureManifest(manifestSnapshot.value);
    const memberClaims = exactMemberClaims(manifest);
    if (
      captureAuthority.observation_nonce !== manifest.observation_nonce
      || captureAuthority.use_count !== 1
      || manifest.use_count !== 1
      || captureAuthority.valid_until !== manifest.valid_until
    ) {
      throw new RecoveryCustodyError("CAPTURE_AUTHORITY_REPLAYED");
    }

    const projections = {} as { [K in RecoveryProjectionName]: unknown };
    const inputIdentities = new Set<string>([manifestIdentity]);
    for (const name of Object.keys(RECOVERY_PROJECTION_FILES) as RecoveryProjectionName[]) {
      const logicalName = RECOVERY_PROJECTION_FILES[name];
      const claim = memberClaims.get(logicalName);
      if (!claim) throw new RecoveryCustodyError("INPUT_MANIFEST_INVALID", "MALFORMED");
      const memberPath = path.join(directory.realpath, logicalName);
      if (path.dirname(memberPath) !== directory.realpath || path.basename(memberPath) !== logicalName) {
        throw new RecoveryCustodyError("INPUT_PATH_AMBIGUOUS");
      }
      const snapshot = await openStableFile(memberPath, {
        logicalName,
        maximumBytes: MAX_PROJECTION_BYTES,
        expected: claim,
        hooks,
      });
      snapshots.push(snapshot);
      const identity = `${snapshot.fingerprint.device}:${snapshot.fingerprint.inode}`;
      if (inputIdentities.has(identity) || externalIdentities.has(identity)) {
        throw new RecoveryCustodyError("INPUT_IDENTITY_DUPLICATE");
      }
      inputIdentities.add(identity);
      projections[name] = snapshot.value;
    }

    const policyClaim = memberClaims.get(RECOVERY_PROJECTION_FILES.rpo_policy);
    const scratchClaim = memberClaims.get(RECOVERY_PROJECTION_FILES.scratch_restore);
    if (
      !policyClaim
      || !claimsEqual(policyAuthority.policy, policyClaim)
    ) {
      throw new RecoveryCustodyError("POLICY_AUTHORITY_ROOT_INVALID");
    }
    if (
      !scratchClaim
      || !claimsEqual(scratchAuthority.receipt, scratchClaim)
    ) {
      throw new RecoveryCustodyError("SCRATCH_AUTHORITY_ROOT_INVALID");
    }

    const result = await consume({
      projections,
      manifest,
      capture_authority: captureAuthority,
      policy_authority: policyAuthority,
      scratch_authority: scratchAuthority,
    });

    await finalRead(captureSnapshot, hooks);
    await finalRead(policySnapshot, hooks);
    await finalRead(scratchSnapshot, hooks);
    await finalRead(manifestSnapshot, hooks);
    for (const logicalName of Object.values(RECOVERY_PROJECTION_FILES)) {
      const snapshot = snapshots.find((candidate) => candidate.logicalName === logicalName);
      if (!snapshot) throw new RecoveryCustodyError("INPUT_FILE_MISSING");
      await finalRead(snapshot, hooks);
    }
    await readCensus(directory, "final", hooks);
    await Promise.all(snapshots.map((snapshot) => finalRead(snapshot, undefined)));
    await verifyTerminalSnapshot(directory, snapshots);
    return result;
  } catch (error) {
    if (error instanceof RecoveryCustodyError || (error instanceof Error && error.name === "ProjectionError")) throw error;
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
    if (code === "ENOENT") throw new RecoveryCustodyError("INPUT_FILE_MISSING");
    if (code === "ELOOP") throw new RecoveryCustodyError("INPUT_PATH_AMBIGUOUS");
    throw new RecoveryCustodyError("INPUT_CUSTODY_CHANGED");
  } finally {
    await Promise.allSettled(snapshots.map((snapshot) => snapshot.handle.close()));
    if (directory) await directory.handle.close().catch(() => undefined);
  }
}
