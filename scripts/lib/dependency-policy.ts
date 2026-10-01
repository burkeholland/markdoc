import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
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
export const MAX_FAILURE_STDERR_BYTES = 8 * 1024;
// Every command_failed reason matches this, and deploy/release-vm.ps1 shows a reason only when it matches the same
// pattern. Each part is fixed text, a number, a signal name or an error code, so no other text from npm fits.
export const FAILURE_REASON_PATTERN =
  /^npm audit (?:exit (?:0|[1-9][0-9]{0,9})|ended by signal SIG[A-Z0-9]{1,12}|ended without an exit code|timed out|could not start(?: \(E[A-Z0-9_]{1,24}\))?)(?:, npm code E[A-Z0-9_]{1,24})?(?: \(attempt [1-9] of [1-9]\))?$/;

const ERROR_CODE_PATTERN = /^E[A-Z0-9_]{1,24}$/;
const NPM_ERROR_CODE_LINE_PATTERN = /^npm (?:error|ERR!) code (E[A-Z0-9_]{1,24})$/;
const SIGNAL_PATTERN = /^SIG[A-Z0-9]{1,12}$/;
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
  // Only command_failed reports carry this, and it always matches FAILURE_REASON_PATTERN. Every other report keeps
  // exactly three keys.
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
  signal?: string;
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
    // npm 11.12.1 emits exactly these three keys. Fail closed on additions, especially an accompanying error;
    // a future npm schema change needs an explicit policy review rather than silently passing a release.
    || Object.keys(value).length !== 3
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

function isExitCode(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
}

// Only a whole stderr line such as "npm error code E401" counts, and only its code is kept.
function npmErrorCode(stderr: string | undefined): string | undefined {
  for (const line of stderr?.split(/\r?\n/) ?? []) {
    const code = NPM_ERROR_CODE_LINE_PATTERN.exec(line)?.[1];
    if (code) return code;
  }
  return undefined;
}

function parseNpmErrorJson(stdout: string): { code?: string } | null {
  if (Buffer.byteLength(stdout, "utf8") > MAX_AUDIT_JSON_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (
    !isRecord(value)
    || Object.keys(value).length !== 1
    || !isRecord(value.error)
    || !Object.values(value.error).every(isString)
  ) return null;
  return { code: typeof value.error.code === "string" ? value.error.code : undefined };
}

// Built only from fixed text, the exit code, a signal name, error codes and the attempt number. No other text from
// npm is used, so nothing npm printed (tokens, URLs, paths) can reach the report.
function commandFailureReason(failure: { execution?: AuditExecutionResult; startError?: unknown }, attempt: number): string {
  const { execution, startError } = failure;
  let reason: string;
  if (!execution) {
    const code = isRecord(startError) ? startError.code : undefined;
    reason = typeof code === "string" && ERROR_CODE_PATTERN.test(code)
      ? `npm audit could not start (${code})`
      : "npm audit could not start";
  } else if (execution.stopped === "timeout") {
    reason = "npm audit timed out";
  } else if (isExitCode(execution.exitCode)) {
    reason = `npm audit exit ${execution.exitCode}`;
  } else if (typeof execution.signal === "string" && SIGNAL_PATTERN.test(execution.signal)) {
    reason = `npm audit ended by signal ${execution.signal}`;
  } else {
    reason = "npm audit ended without an exit code";
  }
  const stdoutCode = execution ? parseNpmErrorJson(execution.stdout)?.code : undefined;
  // JavaScript's $ also matches before a final newline, so require the matched code to equal the whole value.
  const npmCode = typeof stdoutCode === "string" && ERROR_CODE_PATTERN.exec(stdoutCode)?.[0] === stdoutCode
    ? stdoutCode
    : npmErrorCode(execution?.stderr);
  if (npmCode) reason += `, npm code ${npmCode}`;
  if (attempt > 1) reason += ` (attempt ${attempt} of ${MAX_AUDIT_ATTEMPTS})`;
  return reason;
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

// Only empty stdout or npm's exact string-only error object means no report. Reports, malformed reports and
// all other printed output are never retried, and a timed-out attempt can never pass.
function assessAuditExecution(lock: PackageLockSnapshot, execution: AuditExecutionResult, attempt: number): AuditAssessment {
  const commandFailed = (retryable: boolean): AuditAssessment => ({
    report: commandFailedReport(commandFailureReason({ execution }, attempt)),
    retryable,
  });
  const malformed: AuditAssessment = { report: dependencyPolicyFailure("malformed_audit"), retryable: false };
  if (execution.stopped === "output_limit") return malformed;
  if (execution.stdout.length === 0) return execution.exitCode === 0 ? malformed : commandFailed(true);
  if (parseNpmErrorJson(execution.stdout)) return execution.exitCode === 0 ? malformed : commandFailed(true);
  const audit = parseAuditJson(execution.stdout, lock);
  if (execution.stopped === "timeout") {
    // A report printed before the time limit still counts when it rejects. Anything else is incomplete.
    const report = audit ? policyReport(lock, audit) : undefined;
    return report?.status === "rejected" ? { report, retryable: false } : malformed;
  }
  if (audit) {
    const expectedExit = execution.exitCode === 0 || (execution.exitCode === 1 && audit.counts.total > 0);
    return expectedExit ? { report: policyReport(lock, audit), retryable: false } : commandFailed(false);
  }
  return execution.exitCode === 0 || AUDIT_REPORT_MARKER.test(execution.stdout) ? malformed : commandFailed(false);
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
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null = null) => {
      if (settled) return;
      settle();
      if (stopped) child.unref();
      let stderr = Buffer.concat(stderrChunks).toString("utf8");
      // Whole lines only, so a line cut off by the limit is never read (a cut "npm error code E401" would read as E4).
      if (stderrTruncated) stderr = stderr.slice(0, Math.max(stderr.lastIndexOf("\n"), stderr.lastIndexOf("\r")) + 1);
      resolve({
        exitCode: stopped ? null : exitCode,
        // Kept after a stop too, so output printed before a timeout is judged instead of dropped and retried.
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr,
        ...(stopped ? { stopped } : signal ? { signal } : {}),
      });
    };
    const stop = (reason: "timeout" | "output_limit") => {
      if (stopped || settled) return;
      stopped = reason;
      stopProcessTree(child);
      // Settle even if a stuck descendant keeps the pipes open after the kill.
      graceTimer = setTimeout(() => finish(null), STOP_GRACE_MS);
    };
    const timeoutTimer = setTimeout(() => stop("timeout"), options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      const room = maxStdoutBytes - stdoutBytes;
      stdoutBytes += chunk.byteLength;
      if (room > 0) stdoutChunks.push(chunk.byteLength > room ? chunk.subarray(0, room) : chunk);
      if (stdoutBytes > maxStdoutBytes) stop("output_limit");
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
      // No IPC or AbortSignal is used and only stop() kills, so an 'error' before a stop means the process never
      // started. If it printed anything it did start, and that output is judged like any other.
      if (stopped || stdoutBytes > 0) {
        if (!stopped) stopProcessTree(child);
        finish(null);
        return;
      }
      settle();
      stopProcessTree(child);
      reject(error);
    });
    child.on("close", (exitCode, signal) => finish(exitCode, signal));
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
