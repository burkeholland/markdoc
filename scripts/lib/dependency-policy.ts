import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const AUDIT_ARGUMENTS = ["audit", "--package-lock-only", "--json"] as const;
export const MAX_AUDIT_JSON_BYTES = 1024 * 1024;
export const MAX_AUDIT_AGE_MS = 5 * 60 * 1000;
export const MAX_REPORTED_PACKAGES = 25;

const MAX_PACKAGE_LOCK_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const PACKAGE_VERSION_PATTERN = /^[0-9a-z][0-9a-z.+_-]{0,127}$/i;
const VULNERABILITY_SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;
const DEPENDENCY_COUNT_FIELDS = ["prod", "dev", "optional", "peer", "peerOptional", "total"] as const;

export const BLOCKED_DEPENDENCIES = [
  { name: "fast-uri", version: "3.1.5" },
  { name: "qs", version: "6.15.3" },
] as const;

export type DependencyPolicyStatus =
  | "pass"
  | "rejected"
  | "invalid_request"
  | "invalid_lock"
  | "lock_mismatch"
  | "malformed_audit"
  | "command_failed"
  | "stale_audit";

export type DependencyPackageStatus = "blocked" | "vulnerable";

export interface DependencyPolicyCounts {
  blocked: number;
  info: number;
  low: number;
  moderate: number;
  high: number;
  critical: number;
  vulnerabilities: number;
  reported: number;
  omitted: number;
}

export interface DependencyPackageResult {
  name: string;
  version: string;
  status: DependencyPackageStatus;
}

export interface DependencyPolicyReport {
  status: DependencyPolicyStatus;
  counts: DependencyPolicyCounts;
  packages: DependencyPackageResult[];
}

interface LockedPackage {
  path: string;
  name: string;
  version: string;
}

export interface PackageLockSnapshot {
  sha256: string;
  packages: readonly LockedPackage[];
}

export interface AuditExecutionResult {
  exitCode: number | null;
  stdout: string;
}

export interface AuditExecutionRequest {
  args: readonly string[];
  cwd: string;
}

export type AuditExecutor = (request: AuditExecutionRequest) => Promise<AuditExecutionResult>;

interface AuditCounts {
  info: number;
  low: number;
  moderate: number;
  high: number;
  critical: number;
  total: number;
}

interface ParsedAudit {
  counts: AuditCounts;
  packages: LockedPackage[];
}

const ZERO_COUNTS: DependencyPolicyCounts = {
  blocked: 0,
  info: 0,
  low: 0,
  moderate: 0,
  high: 0,
  critical: 0,
  vulnerabilities: 0,
  reported: 0,
  omitted: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validPackageName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 214 && PACKAGE_NAME_PATTERN.test(value);
}

function validPackageVersion(value: unknown): value is string {
  return typeof value === "string" && PACKAGE_VERSION_PATTERN.test(value);
}

function packageNameFromLockPath(lockPath: string): string | null {
  const marker = "node_modules/";
  const markerIndex = lockPath.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const remainder = lockPath.slice(markerIndex + marker.length);
  const parts = remainder.split("/");
  const name = remainder.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return validPackageName(name) ? name : null;
}

export function packageLockSha256(packageLockText: string): string {
  return createHash("sha256").update(packageLockText, "utf8").digest("hex");
}

export function parsePackageLock(packageLockText: string): PackageLockSnapshot | null {
  const byteLength = Buffer.byteLength(packageLockText, "utf8");
  if (byteLength === 0 || byteLength > MAX_PACKAGE_LOCK_BYTES) return null;

  let value: unknown;
  try {
    value = JSON.parse(packageLockText);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.lockfileVersion !== 3 || !isRecord(value.packages) || !isRecord(value.packages[""])) {
    return null;
  }

  const packages: LockedPackage[] = [];
  for (const [lockPath, entry] of Object.entries(value.packages)) {
    if (lockPath === "" || !lockPath.includes("node_modules/")) continue;
    if (!isRecord(entry)) return null;
    if (entry.link === true) continue;
    const name = packageNameFromLockPath(lockPath);
    if (!name || !validPackageVersion(entry.version)) return null;
    packages.push({ path: lockPath, name, version: entry.version });
  }
  return { sha256: packageLockSha256(packageLockText), packages };
}

function isSeverity(value: unknown): value is (typeof VULNERABILITY_SEVERITIES)[number] {
  return typeof value === "string" && VULNERABILITY_SEVERITIES.includes(value as (typeof VULNERABILITY_SEVERITIES)[number]);
}

function isAdvisory(value: unknown): boolean {
  if (typeof value === "string") return validPackageName(value);
  if (!isRecord(value)) return false;
  if (
    !isSafeCount(value.source)
    || !validPackageName(value.name)
    || !validPackageName(value.dependency)
    || typeof value.title !== "string"
    || typeof value.url !== "string"
    || !isSeverity(value.severity)
    || !Array.isArray(value.cwe)
    || !value.cwe.every((item) => typeof item === "string")
    || !isRecord(value.cvss)
    || typeof value.cvss.score !== "number"
    || !Number.isFinite(value.cvss.score)
    || typeof value.cvss.vectorString !== "string"
    || typeof value.range !== "string"
  ) {
    return false;
  }
  return value.cvss.score >= 0 && value.cvss.score <= 10;
}

function isFixAvailable(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  return isRecord(value)
    && validPackageName(value.name)
    && validPackageVersion(value.version)
    && typeof value.isSemVerMajor === "boolean";
}

function parseAuditJson(auditJson: string, lock: PackageLockSnapshot): ParsedAudit | null {
  const byteLength = Buffer.byteLength(auditJson, "utf8");
  if (byteLength === 0 || byteLength > MAX_AUDIT_JSON_BYTES) return null;

  let value: unknown;
  try {
    value = JSON.parse(auditJson);
  } catch {
    return null;
  }
  if (
    !isRecord(value)
    || value.auditReportVersion !== 2
    || !isRecord(value.vulnerabilities)
    || !isRecord(value.metadata)
    || !isRecord(value.metadata.vulnerabilities)
    || !isRecord(value.metadata.dependencies)
  ) {
    return null;
  }

  const counts = value.metadata.vulnerabilities;
  for (const severity of VULNERABILITY_SEVERITIES) {
    if (!isSafeCount(counts[severity])) return null;
  }
  if (!isSafeCount(counts.total)) return null;
  const total = VULNERABILITY_SEVERITIES.reduce((sum, severity) => sum + (counts[severity] as number), 0);
  if (counts.total !== total) return null;
  for (const field of DEPENDENCY_COUNT_FIELDS) {
    if (!isSafeCount(value.metadata.dependencies[field])) return null;
  }

  const lockPackagesByPath = new Map(lock.packages.map((item) => [item.path, item]));
  const vulnerablePackages: LockedPackage[] = [];
  const entryCounts = Object.fromEntries(VULNERABILITY_SEVERITIES.map((severity) => [severity, 0])) as Record<(typeof VULNERABILITY_SEVERITIES)[number], number>;
  for (const [name, entry] of Object.entries(value.vulnerabilities)) {
    if (
      !validPackageName(name)
      || !isRecord(entry)
      || entry.name !== name
      || !isSeverity(entry.severity)
      || typeof entry.isDirect !== "boolean"
      || !Array.isArray(entry.via)
      || entry.via.length === 0
      || !entry.via.every(isAdvisory)
      || !Array.isArray(entry.effects)
      || !entry.effects.every(validPackageName)
      || typeof entry.range !== "string"
      || entry.range.length === 0
      || entry.range.length > 512
      || !Array.isArray(entry.nodes)
      || entry.nodes.length === 0
      || !entry.nodes.every((node) => typeof node === "string")
      || !isFixAvailable(entry.fixAvailable)
    ) {
      return null;
    }
    entryCounts[entry.severity] += 1;
    for (const node of entry.nodes) {
      const lockedPackage = lockPackagesByPath.get(node);
      if (!lockedPackage || lockedPackage.name !== name) return null;
      vulnerablePackages.push(lockedPackage);
    }
  }

  for (const severity of VULNERABILITY_SEVERITIES) {
    if (entryCounts[severity] !== counts[severity]) return null;
  }
  if (Object.keys(value.vulnerabilities).length !== counts.total) return null;

  return {
    counts: {
      info: counts.info as number,
      low: counts.low as number,
      moderate: counts.moderate as number,
      high: counts.high as number,
      critical: counts.critical as number,
      total: counts.total,
    },
    packages: vulnerablePackages,
  };
}

export function dependencyPolicyFailure(status: Exclude<DependencyPolicyStatus, "pass" | "rejected">): DependencyPolicyReport {
  return { status, counts: { ...ZERO_COUNTS }, packages: [] };
}

function comparePackageResults(left: DependencyPackageResult, right: DependencyPackageResult): number {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return compare(left.name, right.name)
    || compare(left.version, right.version)
    || compare(left.status, right.status);
}

function policyReport(lock: PackageLockSnapshot, audit: ParsedAudit): DependencyPolicyReport {
  const blocked = lock.packages.filter((item) =>
    BLOCKED_DEPENDENCIES.some((blockedNode) => blockedNode.name === item.name && blockedNode.version === item.version));
  const results = [
    ...blocked.map(({ name, version }) => ({ name, version, status: "blocked" as const })),
    ...audit.packages.map(({ name, version }) => ({ name, version, status: "vulnerable" as const })),
  ].sort(comparePackageResults);
  const packages = results.slice(0, MAX_REPORTED_PACKAGES);
  return {
    status: results.length === 0 ? "pass" : "rejected",
    counts: {
      blocked: blocked.length,
      info: audit.counts.info,
      low: audit.counts.low,
      moderate: audit.counts.moderate,
      high: audit.counts.high,
      critical: audit.counts.critical,
      vulnerabilities: audit.counts.total,
      reported: packages.length,
      omitted: results.length - packages.length,
    },
    packages,
  };
}

export function evaluateDependencyPolicy(options: {
  expectedLockSha256: string;
  packageLockText: string;
  execution: AuditExecutionResult;
}): DependencyPolicyReport {
  const expected = options.expectedLockSha256.trim().toLowerCase();
  if (!SHA256_PATTERN.test(expected)) return dependencyPolicyFailure("invalid_request");
  const lock = parsePackageLock(options.packageLockText);
  if (!lock) return dependencyPolicyFailure("invalid_lock");
  if (lock.sha256 !== expected) return dependencyPolicyFailure("lock_mismatch");
  const audit = parseAuditJson(options.execution.stdout, lock);
  if (!audit) {
    return dependencyPolicyFailure(options.execution.exitCode === 0 ? "malformed_audit" : "command_failed");
  }
  if (options.execution.exitCode !== 0 && !(options.execution.exitCode === 1 && audit.counts.total > 0)) {
    return dependencyPolicyFailure("command_failed");
  }
  return policyReport(lock, audit);
}

async function readLock(lockPath: string): Promise<{ text: string; snapshot: PackageLockSnapshot } | null> {
  try {
    const text = await fs.readFile(lockPath, "utf8");
    const snapshot = parsePackageLock(text);
    return snapshot ? { text, snapshot } : null;
  } catch {
    return null;
  }
}

export async function runDependencyAudit(options: {
  cwd: string;
  lockPath: string;
  expectedLockSha256: string;
  executor: AuditExecutor;
}): Promise<DependencyPolicyReport> {
  const expected = options.expectedLockSha256.trim().toLowerCase();
  if (!SHA256_PATTERN.test(expected)) return dependencyPolicyFailure("invalid_request");
  const before = await readLock(options.lockPath);
  if (!before) return dependencyPolicyFailure("invalid_lock");
  if (before.snapshot.sha256 !== expected) return dependencyPolicyFailure("lock_mismatch");

  let execution: AuditExecutionResult | null = null;
  try {
    execution = await options.executor({ args: AUDIT_ARGUMENTS, cwd: options.cwd });
  } catch {
    // The lock is still checked below so a failing command cannot hide a concurrent lock change.
  }

  const after = await readLock(options.lockPath);
  if (!after || after.snapshot.sha256 !== expected || after.snapshot.sha256 !== before.snapshot.sha256) {
    return dependencyPolicyFailure("lock_mismatch");
  }
  if (!execution) return dependencyPolicyFailure("command_failed");
  return evaluateDependencyPolicy({
    expectedLockSha256: expected,
    packageLockText: after.text,
    execution,
  });
}

function isWithinDirectory(parent: string, child: string): boolean {
  const normalizedParent = process.platform === "win32" ? parent.toLowerCase() : parent;
  const normalizedChild = process.platform === "win32" ? child.toLowerCase() : child;
  const relative = path.relative(normalizedParent, normalizedChild);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export async function evaluateTemporaryAuditFile(options: {
  auditPath: string;
  lockPath: string;
  expectedLockSha256: string;
  now?: number;
}): Promise<DependencyPolicyReport> {
  const now = options.now ?? Date.now();
  let auditPath: string;
  let temporaryRoot: string;
  let auditStat;
  try {
    const suppliedStat = await fs.lstat(options.auditPath);
    if (!suppliedStat.isFile() || suppliedStat.isSymbolicLink()) return dependencyPolicyFailure("invalid_request");
    [auditPath, temporaryRoot] = await Promise.all([fs.realpath(options.auditPath), fs.realpath(tmpdir())]);
    auditStat = await fs.stat(auditPath);
  } catch {
    return dependencyPolicyFailure("invalid_request");
  }
  if (!isWithinDirectory(temporaryRoot, auditPath) || auditStat.size > MAX_AUDIT_JSON_BYTES) {
    return dependencyPolicyFailure("invalid_request");
  }
  if (now - auditStat.mtimeMs > MAX_AUDIT_AGE_MS || auditStat.mtimeMs - now > 60_000) {
    return dependencyPolicyFailure("stale_audit");
  }

  const lock = await readLock(options.lockPath);
  if (!lock) return dependencyPolicyFailure("invalid_lock");
  let auditJson: string;
  try {
    auditJson = await fs.readFile(auditPath, "utf8");
  } catch {
    return dependencyPolicyFailure("invalid_request");
  }
  return evaluateDependencyPolicy({
    expectedLockSha256: options.expectedLockSha256,
    packageLockText: lock.text,
    execution: { exitCode: 0, stdout: auditJson },
  });
}

export function createNpmAuditExecutor(): AuditExecutor {
  return ({ args, cwd }) =>
    new Promise((resolve, reject) => {
      const child = spawn("npm", [...args], {
        cwd,
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let byteLength = 0;
      let oversized = false;
      child.stdout.on("data", (chunk: Buffer) => {
        byteLength += chunk.byteLength;
        if (byteLength > MAX_AUDIT_JSON_BYTES) {
          oversized = true;
          child.kill();
          return;
        }
        chunks.push(chunk);
      });
      child.once("error", reject);
      child.once("close", (exitCode) => {
        resolve({
          exitCode: oversized ? null : exitCode,
          stdout: oversized ? "" : Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
}

export function formatDependencyPolicyReport(report: DependencyPolicyReport): string {
  return JSON.stringify(report);
}
