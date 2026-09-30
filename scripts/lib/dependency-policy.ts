import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const AUDIT_ARGUMENTS = ["audit", "--package-lock-only", "--json"] as const;
export const MAX_AUDIT_JSON_BYTES = 1024 * 1024;
export const MAX_AUDIT_AGE_MS = 5 * 60 * 1000;
export const MAX_REPORTED_PACKAGES = 25;
// Two full attempts plus the pause stay inside the release's 300 second preflight bound.
export const AUDIT_TIMEOUT_MS = 120_000;
export const MAX_AUDIT_ATTEMPTS = 2;
export const AUDIT_RETRY_DELAY_MS = 2_000;
export const MAX_FAILURE_REASON_LENGTH = 200;
export const MAX_FAILURE_STDERR_BYTES = 8 * 1024;

const MAX_FAILURE_LINE_LENGTH = 1024;
const FAILURE_DETAIL_LINES = 2;
const STOP_GRACE_MS = 5_000;
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
  // Only command_failed reports carry this bounded, sanitized summary; every other report keeps exactly three keys.
  reason?: string;
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
  stderr?: string;
  stopped?: "timeout" | "output_limit";
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

function isOptional(value: unknown, check: (present: unknown) => boolean): boolean {
  return value === undefined || value === null || check(value);
}

function isString(value: unknown): boolean {
  return typeof value === "string";
}

function isCvssScore(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10;
}

function isCvss(value: unknown): boolean {
  return isRecord(value)
    && isOptional(value.score, isCvssScore)
    && isOptional(value.vectorString, isString);
}

function isCweList(value: unknown): boolean {
  return Array.isArray(value) && value.every(isString);
}

// npm fills source, name, dependency and severity itself. It copies title, url, cwe, cvss and the advisory range
// from the registry, which can send them as null or leave them out (for example a critical advisory with no CVSS
// vector yet). A present value must still have the right type. Any entry here is already a finding, so accepting
// these gaps can only turn a report into "rejected", never into "pass".
function isAdvisory(value: unknown): boolean {
  if (typeof value === "string") return validPackageName(value);
  if (!isRecord(value)) return false;
  return isSafeCount(value.source)
    && validPackageName(value.name)
    && validPackageName(value.dependency)
    && isSeverity(value.severity)
    && isOptional(value.title, isString)
    && isOptional(value.url, isString)
    && isOptional(value.cwe, isCweList)
    && isOptional(value.cvss, isCvss)
    && isOptional(value.range, isString);
}

// npm documents a fix without isSemVerMajor when it cannot compare the versions.
function isFixAvailable(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  return isRecord(value)
    && validPackageName(value.name)
    && validPackageVersion(value.version)
    && isOptional(value.isSemVerMajor, (present) => typeof present === "boolean");
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

export function dependencyPolicyFailure(
  status: Exclude<DependencyPolicyStatus, "pass" | "rejected" | "command_failed">,
): DependencyPolicyReport {
  return { status, counts: { ...ZERO_COUNTS }, packages: [] };
}

function commandFailedReport(reason: string): DependencyPolicyReport {
  return { status: "command_failed", counts: { ...ZERO_COUNTS }, packages: [], reason };
}

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/g;
const AUTHORIZATION_HEADER_PATTERN =
  /\b((?:proxy-)?authorization)["']?\s*[:=]\s*(?:(?:bearer|basic|token|negotiate|ntlm|digest)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const AUTHORIZATION_SCHEME_PATTERN = /\b(bearer|basic|negotiate|ntlm|digest)\s+[^\s,;]+/gi;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b([\w.-]*?(?:token|password|passwd|pwd|secret|auth|apikey|api[_-]?key|signature|sig|credentials?|cookie))(["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&"']+)/gi;
const KNOWN_TOKEN_PATTERN =
  /\b(?:npm_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})/g;
const OPAQUE_VALUE_PATTERN = /[A-Za-z0-9_+=-]{32,}/g;
const NOISE_LINE_PATTERN =
  /^npm(?: (?:error|warn|notice|http|info|verbose|silly|timing))?$|^npm ERR!$|complete log of this run|^npm warn (?:config\b|unknown (?:env|user|project|builtin|global|cli) config\b)/i;

function replaceHomeDirectory(line: string): string {
  let home: string;
  try {
    home = homedir();
  } catch {
    return line;
  }
  if (home.length < 3) return line;
  let result = line;
  for (const variant of new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")])) {
    result = result.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "~");
  }
  return result;
}

function stripUrlSecrets(url: string): string {
  const schemeEnd = url.indexOf("://") + 3;
  let rest = url.slice(schemeEnd);
  const queryStart = rest.search(/[?#]/);
  if (queryStart >= 0) rest = rest.slice(0, queryStart);
  const slash = rest.indexOf("/");
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const userInfoEnd = authority.lastIndexOf("@");
  if (userInfoEnd >= 0) {
    rest = rest.slice(userInfoEnd + 1);
  } else if (authority.includes(":")) {
    // A raw "/" inside a password moves its "@" past the first "/", so drop credentials up to that "@" too.
    const at = rest.indexOf("@", authority.length);
    if (at > 0 && rest[at - 1] !== "/") rest = rest.slice(at + 1);
  }
  return url.slice(0, schemeEnd) + rest;
}

// Cuts at a space so a secret split by the cut can never survive as a fragment too short to redact.
function boundWords(line: string, maxLength: number): string {
  if (line.length <= maxLength) return line;
  const cut = line.lastIndexOf(" ", maxLength);
  return cut > 0 ? line.slice(0, cut) : "";
}

function sanitizeFailureLine(rawLine: string): string {
  const line = boundWords(
    rawLine.replace(ANSI_ESCAPE_PATTERN, "").replace(CONTROL_CHARACTER_PATTERN, " ").replace(/\s+/g, " ").trim(),
    MAX_FAILURE_LINE_LENGTH,
  );
  return replaceHomeDirectory(line)
    .replace(AUTHORIZATION_HEADER_PATTERN, "$1: [redacted]")
    .replace(AUTHORIZATION_SCHEME_PATTERN, "$1 [redacted]")
    .replace(URL_PATTERN, stripUrlSecrets)
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1$2[redacted]")
    .replace(KNOWN_TOKEN_PATTERN, "[redacted]")
    .replace(OPAQUE_VALUE_PATTERN, (value) => /[A-Za-z]/.test(value) && /[0-9]/.test(value) ? "[redacted]" : value)
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/ {2,}/g, " ")
    .trim();
}

function failureDetail(stderr: string): string {
  let bounded = stderr;
  if (bounded.length > MAX_FAILURE_STDERR_BYTES) {
    bounded = bounded.slice(0, MAX_FAILURE_STDERR_BYTES);
    bounded = bounded.slice(0, Math.max(bounded.lastIndexOf("\n"), bounded.lastIndexOf("\r")) + 1);
  }
  const lines: string[] = [];
  for (const rawLine of bounded.split(/\r\n|\r|\n/)) {
    const line = sanitizeFailureLine(rawLine);
    if (!line || NOISE_LINE_PATTERN.test(line)) continue;
    lines.push(line);
    if (lines.length === FAILURE_DETAIL_LINES) break;
  }
  return lines.join(" | ");
}

function commandFailureReason(failure: { execution?: AuditExecutionResult; startError?: unknown }, attempt: number): string {
  const { execution, startError } = failure;
  let summary: string;
  if (!execution) {
    const code = isRecord(startError) && typeof startError.code === "string" && /^[A-Z0-9_]{1,32}$/.test(startError.code)
      ? ` (${startError.code})`
      : "";
    summary = `npm audit could not start${code}`;
  } else if (execution.stopped === "timeout") {
    summary = "npm audit timed out";
  } else if (execution.stopped === "output_limit") {
    summary = "npm audit output exceeded its size limit";
  } else if (execution.exitCode === null) {
    summary = "npm audit ended without an exit code";
  } else {
    summary = `npm audit exit ${execution.exitCode}`;
  }
  if (attempt > 1) summary += ` (attempt ${attempt} of ${MAX_AUDIT_ATTEMPTS})`;
  const detail = execution?.stderr ? failureDetail(execution.stderr) : "";
  const reason = detail ? `${summary}: ${detail}` : summary;
  return reason.length <= MAX_FAILURE_REASON_LENGTH
    ? reason
    : `${reason.slice(0, MAX_FAILURE_REASON_LENGTH - 3).trimEnd()}...`;
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

interface AuditAssessment {
  report: DependencyPolicyReport;
  retryable: boolean;
}

// Matches any output where npm began writing audit results, including a report cut off part way through.
const AUDIT_REPORT_MARKER = /"(?:auditReportVersion|vulnerabilities)"\s*:/;

// A report npm wrote is final: it is either used as is or fails, and is never retried. Only a run that left no
// report behind (npm's own error object, no output, or a timeout) gets one more attempt, so a retry can never
// replace listed advisories with a pass.
function assessAuditExecution(lock: PackageLockSnapshot, execution: AuditExecutionResult, attempt: number): AuditAssessment {
  const commandFailed = (retryable: boolean): AuditAssessment => ({
    report: commandFailedReport(commandFailureReason({ execution }, attempt)),
    retryable,
  });
  if (execution.stopped) return commandFailed(execution.stopped === "timeout");
  const audit = parseAuditJson(execution.stdout, lock);
  if (audit) {
    const expectedExit = execution.exitCode === 0 || (execution.exitCode === 1 && audit.counts.total > 0);
    return expectedExit ? { report: policyReport(lock, audit), retryable: false } : commandFailed(false);
  }
  if (execution.exitCode === 0 || AUDIT_REPORT_MARKER.test(execution.stdout)) {
    return { report: dependencyPolicyFailure("malformed_audit"), retryable: false };
  }
  return commandFailed(true);
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
  return assessAuditExecution(lock, options.execution, 1).report;
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
  retryDelayMs?: number;
  onRetry?: (reason: string) => void;
}): Promise<DependencyPolicyReport> {
  const expected = options.expectedLockSha256.trim().toLowerCase();
  if (!SHA256_PATTERN.test(expected)) return dependencyPolicyFailure("invalid_request");
  const before = await readLock(options.lockPath);
  if (!before) return dependencyPolicyFailure("invalid_lock");
  if (before.snapshot.sha256 !== expected) return dependencyPolicyFailure("lock_mismatch");

  for (let attempt = 1; ; attempt += 1) {
    let execution: AuditExecutionResult | undefined;
    let startError: unknown;
    try {
      execution = await options.executor({ args: AUDIT_ARGUMENTS, cwd: options.cwd });
    } catch (error) {
      // The lock is still checked below so a failing command cannot hide a concurrent lock change.
      startError = error;
    }

    const after = await readLock(options.lockPath);
    if (!after || after.snapshot.sha256 !== expected) return dependencyPolicyFailure("lock_mismatch");
    const assessment: AuditAssessment = execution
      ? assessAuditExecution(after.snapshot, execution, attempt)
      : { report: commandFailedReport(commandFailureReason({ startError }, attempt)), retryable: true };
    if (!assessment.retryable || attempt >= MAX_AUDIT_ATTEMPTS) return assessment.report;
    options.onRetry?.(assessment.report.reason ?? "");
    await sleep(options.retryDelayMs ?? AUDIT_RETRY_DELAY_MS);
  }
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

export interface BoundedProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  timeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

// On Windows, npm runs as cmd.exe -> npm.cmd -> node.exe, and killing cmd.exe alone would leave node.exe running.
function stopProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    const killer = spawn(path.join(systemRoot, "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => child.kill());
    return;
  }
  child.kill("SIGKILL");
}

export function runBoundedProcess(
  command: string,
  args: readonly string[],
  options: BoundedProcessOptions,
): Promise<AuditExecutionResult> {
  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_AUDIT_JSON_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? MAX_FAILURE_STDERR_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderrTruncated = false;
    let stopped: "timeout" | "output_limit" | undefined;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = () => {
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settle();
      if (stopped) child.unref();
      let stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (stderrTruncated) stderr = stderr.slice(0, Math.max(stderr.lastIndexOf("\n"), stderr.lastIndexOf("\r")) + 1);
      resolve({
        exitCode: stopped ? null : exitCode,
        stdout: stopped ? "" : Buffer.concat(stdoutChunks).toString("utf8"),
        stderr,
        ...(stopped ? { stopped } : {}),
      });
    };
    const stop = (reason: "timeout" | "output_limit") => {
      if (stopped || settled) return;
      stopped = reason;
      stdoutChunks.length = 0;
      stopProcessTree(child);
      // Settle even if a stuck descendant keeps the pipes open after the kill.
      graceTimer = setTimeout(() => finish(null), STOP_GRACE_MS);
    };
    const timeoutTimer = setTimeout(() => stop("timeout"), options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stopped || settled) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        stop("output_limit");
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) return;
      const room = maxStderrBytes - stderrBytes;
      if (chunk.byteLength > room) stderrTruncated = true;
      if (room <= 0) return;
      const kept = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      stderrChunks.push(kept);
      stderrBytes += kept.byteLength;
    });
    child.on("error", (error) => {
      if (settled) return;
      if (stopped) {
        finish(null);
        return;
      }
      settle();
      stopProcessTree(child);
      reject(error);
    });
    child.on("close", (exitCode) => finish(exitCode));
  });
}

// `npm run --silent` hands npm_config_loglevel=silent to the preflight. The audit child would inherit it and write
// nothing to stderr, so a failure would carry no reason. Its stdout JSON does not depend on the log level.
export function npmAuditEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...base };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "npm_config_loglevel") delete environment[key];
  }
  environment.npm_config_loglevel = "warn";
  return environment;
}

export function createNpmAuditExecutor(options: { timeoutMs?: number } = {}): AuditExecutor {
  return ({ args, cwd }) => runBoundedProcess("npm", args, {
    cwd,
    env: npmAuditEnvironment(),
    shell: process.platform === "win32",
    timeoutMs: options.timeoutMs ?? AUDIT_TIMEOUT_MS,
  });
}

export function formatDependencyPolicyReport(report: DependencyPolicyReport): string {
  return JSON.stringify(report);
}
