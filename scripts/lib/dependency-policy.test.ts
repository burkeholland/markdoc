import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMain } from "../dependency-policy-preflight.mjs";
import {
  AUDIT_ARGUMENTS,
  BLOCKED_DEPENDENCIES,
  FAILURE_REASON_PATTERN,
  MAX_AUDIT_AGE_MS,
  MAX_AUDIT_ATTEMPTS,
  MAX_REPORTED_PACKAGES,
  evaluateDependencyPolicy,
  evaluateTemporaryAuditFile,
  formatDependencyPolicyReport,
  npmAuditEnvironment,
  packageLockSha256,
  runBoundedProcess,
  runDependencyAudit,
  type AuditExecutionResult,
  type AuditExecutor,
  type DependencyPolicyStatus,
} from "./dependency-policy";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function packageLock(packages: Array<{ name: string; version: string }> = []): string {
  const entries = Object.fromEntries(packages.map(({ name, version }) => [`node_modules/${name}`, { version }]));
  return JSON.stringify({
    name: "dependency-policy-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "dependency-policy-fixture", version: "1.0.0" },
      ...entries,
    },
  });
}

function auditJson(
  vulnerabilities: Array<{
    name: string;
    severity: "info" | "low" | "moderate" | "high" | "critical";
    title?: string;
    url?: string;
  }> = [],
): string {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: vulnerabilities.length };
  const entries = Object.fromEntries(vulnerabilities.map(({ name, severity, title = "advisory detail", url = "https://registry.invalid/advisory" }, index) => {
    counts[severity] += 1;
    return [name, {
      name,
      severity,
      isDirect: index === 0,
      via: [{
        source: index + 1,
        name,
        dependency: name,
        title,
        url,
        severity,
        cwe: ["CWE-0"],
        cvss: { score: 5, vectorString: "CVSS:3.1/AV:N" },
        range: "<99.0.0",
      }],
      effects: [],
      range: "<99.0.0",
      nodes: [`node_modules/${name}`],
      fixAvailable: false,
    }];
  }));
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: entries,
    metadata: {
      vulnerabilities: counts,
      dependencies: { prod: 0, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 0 },
    },
  });
}

function evaluate(lock: string, audit = auditJson(), exitCode: number | null = 0, expected = packageLockSha256(lock)) {
  return evaluateDependencyPolicy({
    expectedLockSha256: expected,
    packageLockText: lock,
    execution: { exitCode, stdout: audit },
  });
}

async function fixtureDirectory(lock = packageLock()): Promise<{ directory: string; lockPath: string; identity: string }> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "markdoc-dependency-policy-"));
  temporaryDirectories.push(directory);
  const lockPath = path.join(directory, "package-lock.json");
  await fs.writeFile(lockPath, lock);
  return { directory, lockPath, identity: packageLockSha256(lock) };
}

const ZERO_REPORT_COUNTS = {
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

// The exact bytes deploy/release-vm.ps1 accepts as a pass.
const PASS_OUTPUT =
  '{"status":"pass","counts":{"blocked":0,"info":0,"low":0,"moderate":0,"high":0,"critical":0,"vulnerabilities":0,"reported":0,"omitted":0},"packages":[]}';

const NEXT_LOCK = packageLock([{ name: "next", version: "16.3.3" }]);

// Copied from npm 11's `npm audit --json` for next@16.3.3 (#2195): the registry sends no CVSS vector for it yet.
const GHSA_VCVR_ADVISORY: Record<string, unknown> = {
  source: 1240609,
  name: "next",
  dependency: "next",
  title: "Next.js: Remote Code Execution in next/og ImageResponse",
  url: "https://github.com/advisories/GHSA-vcvr-r3jv-pc5j",
  severity: "critical",
  cwe: ["CWE-1395"],
  cvss: { score: 0, vectorString: null },
  range: ">=16.2.0 <16.3.6",
};

function nextAudit(
  advisory: unknown = GHSA_VCVR_ADVISORY,
  fixAvailable: unknown = { name: "next", version: "16.3.6", isSemVerMajor: false },
): string {
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
      next: {
        name: "next",
        severity: "critical",
        isDirect: true,
        via: [advisory],
        effects: [],
        range: "16.2.0 - 16.3.5",
        nodes: ["node_modules/next"],
        fixAvailable,
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1, total: 1 },
      dependencies: { prod: 438, dev: 560, optional: 176, peer: 9, peerOptional: 0, total: 1037 },
    },
  });
}

const NEXT_REJECTED = {
  status: "rejected",
  counts: { ...ZERO_REPORT_COUNTS, critical: 1, vulnerabilities: 1, reported: 1 },
  packages: [{ name: "next", version: "16.3.3", status: "vulnerable" }],
};

function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

// What npm 11 writes when the registry's audit endpoint cannot be reached: its own error object on stdout, and no
// `npm error code` line on stderr. npm printed something, so this is judged and never retried.
const NPM_AUDIT_ERROR: AuditExecutionResult = {
  exitCode: 1,
  stdout: JSON.stringify({
    message: "network timeout at: https://registry.invalid/-/npm/v1/security/advisories/bulk",
    error: { summary: "", detail: "" },
  }),
  stderr: [
    "npm warn audit network timeout at: https://registry.invalid/-/npm/v1/security/advisories/bulk",
    "npm error audit endpoint returned an error",
    "npm error A complete log of this run can be found in: /tmp/npm-cache/_logs/debug-0.log",
    "",
  ].join("\n"),
};

// A failed attempt that printed nothing on stdout, the only kind that gets a second attempt.
const NPM_SILENT_FAILURE: AuditExecutionResult = {
  exitCode: 1,
  stdout: "",
  stderr: [
    "npm error code ECONNRESET",
    "npm error network aborted",
    "npm error A complete log of this run can be found in: /tmp/npm-cache/_logs/debug-0.log",
    "",
  ].join("\n"),
};

// The values that got through the old free-text reason in the review of PR #2201.
const LETTERS_ONLY_PAT = "abcdefghijklmnopqrstuvwxyz".repeat(2);
const BASE64_AUTH = Buffer.from("bot:FakePass9!").toString("base64");
const BASE64_PASSWORD = Buffer.from("FakePass9!").toString("base64");

// Built at run time so no token-shaped literal sits in the source.
const FAKE_NPM_TOKEN = ["npm", "Zx9".repeat(12)].join("_");
const FAKE_GITHUB_TOKEN = ["ghp", "Qw3".repeat(12)].join("_");
const FAKE_JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJyZWxlYXNlIn0", "c2lnbmF0dXJlLXBhcnQ"].join(".");

function commandFailure(execution: Partial<AuditExecutionResult>): { reason: string; output: string } {
  const lock = packageLock();
  const report = evaluateDependencyPolicy({
    expectedLockSha256: packageLockSha256(lock),
    packageLockText: lock,
    execution: { exitCode: 1, stdout: "", ...execution },
  });
  const reason = report.reason ?? "";
  expect(report).toEqual({ status: "command_failed", counts: ZERO_REPORT_COUNTS, packages: [], reason });
  expect(Object.keys(report)).toEqual(["status", "counts", "packages", "reason"]);
  expect(reason).toMatch(FAILURE_REASON_PATTERN);
  return { reason, output: formatDependencyPolicyReport(report) };
}

const quietNode = { ...process.env, NODE_OPTIONS: "--no-warnings" };

async function auditWith(executor: AuditExecutor, lock = packageLock()) {
  const fixture = await fixtureDirectory(lock);
  const onRetry = vi.fn<(reason: string) => void>();
  const report = await runDependencyAudit({
    cwd: fixture.directory,
    lockPath: fixture.lockPath,
    expectedLockSha256: fixture.identity,
    executor,
    retryDelayMs: 0,
    onRetry,
  });
  return { report, onRetry };
}

describe("dependency policy", () => {
  it("passes a complete zero-finding audit for the exact lock identity", () => {
    const report = evaluate(packageLock());
    expect(report).toEqual({
      status: "pass",
      counts: {
        blocked: 0,
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        vulnerabilities: 0,
        reported: 0,
        omitted: 0,
      },
      packages: [],
    });
  });

  it.each(BLOCKED_DEPENDENCIES)("rejects the blocked current node $name@$version", ({ name, version }) => {
    const report = evaluate(packageLock([{ name, version }]));
    expect(report.status).toBe("rejected");
    expect(report.counts.blocked).toBe(1);
    expect(report.packages).toEqual([{ name, version, status: "blocked" }]);
  });

  it.each(["low", "moderate", "high", "critical"] as const)("rejects a %s vulnerability", (severity) => {
    const lock = packageLock([{ name: "unsafe-package", version: "1.2.3" }]);
    const report = evaluate(lock, auditJson([{ name: "unsafe-package", severity }]));
    expect(report.status).toBe("rejected");
    expect(report.counts[severity]).toBe(1);
    expect(report.counts.vulnerabilities).toBe(1);
    expect(report.packages).toEqual([{ name: "unsafe-package", version: "1.2.3", status: "vulnerable" }]);
  });

  it("parses npm's exit code 1 as findings when the vulnerability report is complete", () => {
    const lock = packageLock([{ name: "unsafe-package", version: "1.2.3" }]);
    const report = evaluate(lock, auditJson([{ name: "unsafe-package", severity: "high" }]), 1);
    expect(report).toMatchObject({
      status: "rejected",
      counts: { high: 1, vulnerabilities: 1 },
      packages: [{ name: "unsafe-package", version: "1.2.3", status: "vulnerable" }],
    });
  });

  it.each([
    ["truncated JSON", "{"],
    ["missing metadata", JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} })],
    ["missing dependency counts", JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }, dependencies: {} },
    })],
    ["inconsistent totals", JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0, total: 1 },
        dependencies: { prod: 0, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 0 },
      },
    })],
  ])("fails closed on %s", (_case, audit) => {
    expect(evaluate(packageLock(), audit).status).toBe("malformed_audit");
  });

  it("fails closed on a command failure without parsing or echoing its output", () => {
    const sensitiveBody = "https://user:secret@registry.invalid/raw-response";
    const report = evaluate(packageLock(), sensitiveBody, 17);
    expect(report.status).toBe("command_failed");
    expect(report.reason).toBe("npm audit exit 17");
    expect(formatDependencyPolicyReport(report)).not.toContain(sensitiveBody);
    expect(evaluate(packageLock(), auditJson(), 1).status).toBe("command_failed");
  });

  it("fails closed when the caller's lock identity does not match", () => {
    const lock = packageLock();
    expect(evaluate(lock, auditJson(), 0, "0".repeat(64)).status).toBe("lock_mismatch");
  });

  it("emits only bounded counts, validated package names and versions, and statuses", () => {
    const secret = "never-print-this-value";
    const packages = Array.from({ length: MAX_REPORTED_PACKAGES + 5 }, (_, index) => ({
      name: `unsafe-${String(index).padStart(2, "0")}`,
      version: `1.0.${index}`,
    }));
    const report = evaluate(
      packageLock(packages),
      auditJson(packages.map(({ name }) => ({
        name,
        severity: "high" as const,
        title: `description ${secret}`,
        url: `https://${secret}@registry.invalid/advisory`,
      }))),
    );
    const output = formatDependencyPolicyReport(report);
    expect(report.packages).toHaveLength(MAX_REPORTED_PACKAGES);
    expect(report.counts).toMatchObject({ high: packages.length, vulnerabilities: packages.length, reported: MAX_REPORTED_PACKAGES, omitted: 5 });
    expect(output).not.toContain(secret);
    expect(output).not.toContain("registry");
    expect(Object.keys(report)).toEqual(["status", "counts", "packages"]);
    expect(report.packages.every((item) => Object.keys(item).join(",") === "name,version,status")).toBe(true);
  });
});

describe("audit execution", () => {
  it("uses an injected executor with the fixed package-lock-only audit arguments", async () => {
    const fixture = await fixtureDirectory();
    const executor = vi.fn<AuditExecutor>().mockResolvedValue({ exitCode: 0, stdout: auditJson() });
    const report = await runDependencyAudit({
      cwd: fixture.directory,
      lockPath: fixture.lockPath,
      expectedLockSha256: fixture.identity,
      executor,
    });
    expect(report.status).toBe("pass");
    expect(executor).toHaveBeenCalledWith({ args: AUDIT_ARGUMENTS, cwd: fixture.directory });
  });

  it("fails a rejected executor after one retry and never calls one for a mismatched lock", async () => {
    const fixture = await fixtureDirectory();
    const failedExecutor = vi.fn<AuditExecutor>().mockRejectedValue(new Error("private command detail"));
    const failed = await runDependencyAudit({
      cwd: fixture.directory,
      lockPath: fixture.lockPath,
      expectedLockSha256: fixture.identity,
      executor: failedExecutor,
      retryDelayMs: 0,
    });
    expect(failed).toMatchObject({ status: "command_failed", reason: "npm audit could not start (attempt 2 of 2)" });
    expect(formatDependencyPolicyReport(failed)).not.toContain("private command detail");
    expect(failedExecutor).toHaveBeenCalledTimes(MAX_AUDIT_ATTEMPTS);

    const unusedExecutor = vi.fn<AuditExecutor>();
    await expect(runDependencyAudit({
      cwd: fixture.directory,
      lockPath: fixture.lockPath,
      expectedLockSha256: "0".repeat(64),
      executor: unusedExecutor,
    })).resolves.toMatchObject({ status: "lock_mismatch" });
    expect(unusedExecutor).not.toHaveBeenCalled();
  });

  it("rejects a lock that changes while the audit command is running", async () => {
    const fixture = await fixtureDirectory();
    const executor = vi.fn<AuditExecutor>().mockImplementation(async () => {
      await fs.writeFile(fixture.lockPath, packageLock([{ name: "added-package", version: "1.0.0" }]));
      return { exitCode: 0, stdout: auditJson() };
    });
    await expect(runDependencyAudit({
      cwd: fixture.directory,
      lockPath: fixture.lockPath,
      expectedLockSha256: fixture.identity,
      executor,
    })).resolves.toMatchObject({ status: "lock_mismatch" });
  });

  it("accepts only a fresh caller-specified file under the temporary directory", async () => {
    const fixture = await fixtureDirectory();
    const auditPath = path.join(fixture.directory, "audit.json");
    await fs.writeFile(auditPath, auditJson());
    await expect(evaluateTemporaryAuditFile({
      auditPath,
      lockPath: fixture.lockPath,
      expectedLockSha256: fixture.identity,
    })).resolves.toMatchObject({ status: "pass" });

    const old = new Date(Date.now() - MAX_AUDIT_AGE_MS - 1_000);
    await fs.utimes(auditPath, old, old);
    await expect(evaluateTemporaryAuditFile({
      auditPath,
      lockPath: fixture.lockPath,
      expectedLockSha256: fixture.identity,
    })).resolves.toMatchObject({ status: "stale_audit" });

    await expect(evaluateTemporaryAuditFile({
      auditPath: path.resolve("package.json"),
      lockPath: fixture.lockPath,
      expectedLockSha256: fixture.identity,
    })).resolves.toMatchObject({ status: "invalid_request" });
  });

  it("keeps the CLI thin and uses the injected executor instead of a registry", async () => {
    const fixture = await fixtureDirectory();
    const messages: string[] = [];
    const executor = vi.fn<AuditExecutor>().mockResolvedValue({ exitCode: 0, stdout: auditJson() });
    const exitCode = await runMain(
      ["--lock-sha256", fixture.identity, "--run-audit"],
      { cwd: fixture.directory, executor, output: { log: (message) => messages.push(message) } },
    );
    expect(exitCode).toBe(0);
    expect(executor).toHaveBeenCalledOnce();
    expect(JSON.parse(messages[0])).toMatchObject({ status: "pass" });
  });

  it("prints one exact pass report after a retried transient failure, with the retry note on stderr only", async () => {
    const fixture = await fixtureDirectory();
    const messages: string[] = [];
    const warnings: string[] = [];
    const executor = vi.fn<AuditExecutor>()
      .mockResolvedValueOnce(NPM_SILENT_FAILURE)
      .mockResolvedValueOnce({ exitCode: 0, stdout: auditJson(), stderr: "" });
    const exitCode = await runMain(["--lock-sha256", fixture.identity, "--run-audit"], {
      cwd: fixture.directory,
      executor,
      retryDelayMs: 0,
      output: { log: (message) => messages.push(message), warn: (message) => warnings.push(message) },
    });
    expect(exitCode).toBe(0);
    expect(messages).toEqual([PASS_OUTPUT]);
    expect(warnings).toEqual(["Dependency preflight audit failed (npm audit exit 1, npm code ECONNRESET); retrying once."]);
  });

  it("prints a bounded command_failed report with its reason when the retry fails too", async () => {
    const fixture = await fixtureDirectory();
    const messages: string[] = [];
    const executor = vi.fn<AuditExecutor>().mockResolvedValue(NPM_SILENT_FAILURE);
    const exitCode = await runMain(["--lock-sha256", fixture.identity, "--run-audit"], {
      cwd: fixture.directory,
      executor,
      retryDelayMs: 0,
      output: { log: (message) => messages.push(message) },
    });
    expect(exitCode).toBe(1);
    expect(messages).toHaveLength(1);
    expect(Buffer.byteLength(messages[0], "utf8")).toBeLessThanOrEqual(8192);
    expect(JSON.parse(messages[0])).toEqual({
      status: "command_failed",
      counts: ZERO_REPORT_COUNTS,
      packages: [],
      reason: "npm audit exit 1, npm code ECONNRESET (attempt 2 of 2)",
    });
  });

  it("prints command_failed without a retry when npm printed its own error object", async () => {
    const fixture = await fixtureDirectory();
    const messages: string[] = [];
    const warnings: string[] = [];
    const executor = vi.fn<AuditExecutor>()
      .mockResolvedValueOnce(NPM_AUDIT_ERROR)
      .mockResolvedValue({ exitCode: 0, stdout: auditJson() });
    const exitCode = await runMain(["--lock-sha256", fixture.identity, "--run-audit"], {
      cwd: fixture.directory,
      executor,
      retryDelayMs: 0,
      output: { log: (message) => messages.push(message), warn: (message) => warnings.push(message) },
    });
    expect(exitCode).toBe(1);
    expect(executor).toHaveBeenCalledOnce();
    expect(warnings).toEqual([]);
    expect(messages).toEqual([
      '{"status":"command_failed","counts":{"blocked":0,"info":0,"low":0,"moderate":0,"high":0,"critical":0,"vulnerabilities":0,"reported":0,"omitted":0},"packages":[],"reason":"npm audit exit 1"}',
    ]);
  });
});

describe("npm advisories with missing optional fields (#2195)", () => {
  it.each([0, 1])("reports GHSA-vcvr-r3jv-pc5j with a null CVSS vector as a finding (npm exit %i)", (exitCode) => {
    const report = evaluate(NEXT_LOCK, nextAudit(), exitCode);
    expect(report).toEqual(NEXT_REJECTED);
    expect(Object.keys(report)).toEqual(["status", "counts", "packages"]);
  });

  const optionalFields = ["title", "url", "cwe", "cvss", "range"];
  it.each<[string, Record<string, unknown>]>([
    ...optionalFields.map((field): [string, Record<string, unknown>] => [`${field} is null`, { ...GHSA_VCVR_ADVISORY, [field]: null }]),
    ...optionalFields.map((field): [string, Record<string, unknown>] => [`${field} is missing`, withoutKey(GHSA_VCVR_ADVISORY, field)]),
    ["cvss.score is null", { ...GHSA_VCVR_ADVISORY, cvss: { score: null, vectorString: null } }],
    ["cvss is empty", { ...GHSA_VCVR_ADVISORY, cvss: {} }],
    ["every optional field is null", { ...GHSA_VCVR_ADVISORY, title: null, url: null, cwe: null, cvss: null, range: null }],
    ["every optional field is missing", optionalFields.reduce(withoutKey, GHSA_VCVR_ADVISORY)],
  ])("reports an advisory whose %s as a finding", (_case, advisory) => {
    expect(evaluate(NEXT_LOCK, nextAudit(advisory), 1)).toEqual(NEXT_REJECTED);
  });

  it.each<[string, unknown]>([
    ["has no isSemVerMajor", { name: "next", version: "16.3.6" }],
    ["has a null isSemVerMajor", { name: "next", version: "16.3.6", isSemVerMajor: null }],
    ["is true", true],
    ["is false", false],
  ])("reports a finding whose fixAvailable %s", (_case, fixAvailable) => {
    expect(evaluate(NEXT_LOCK, nextAudit(GHSA_VCVR_ADVISORY, fixAvailable), 1)).toEqual(NEXT_REJECTED);
  });

  it.each<[string, Record<string, unknown>, unknown?]>([
    ["cvss.vectorString is a number", { ...GHSA_VCVR_ADVISORY, cvss: { score: 0, vectorString: 42 } }],
    ["title is a number", { ...GHSA_VCVR_ADVISORY, title: 7 }],
    ["url is an object", { ...GHSA_VCVR_ADVISORY, url: {} }],
    ["cwe is a string", { ...GHSA_VCVR_ADVISORY, cwe: "CWE-1395" }],
    ["cwe holds a number", { ...GHSA_VCVR_ADVISORY, cwe: [1395] }],
    ["cvss is a string", { ...GHSA_VCVR_ADVISORY, cvss: "critical" }],
    ["cvss.score is above 10", { ...GHSA_VCVR_ADVISORY, cvss: { score: 11, vectorString: null } }],
    ["cvss.score is a string", { ...GHSA_VCVR_ADVISORY, cvss: { score: "9.8", vectorString: null } }],
    ["range is a number", { ...GHSA_VCVR_ADVISORY, range: 5 }],
    ["source is null", { ...GHSA_VCVR_ADVISORY, source: null }],
    ["name is null", { ...GHSA_VCVR_ADVISORY, name: null }],
    ["dependency is missing", withoutKey(GHSA_VCVR_ADVISORY, "dependency")],
    ["severity is null", { ...GHSA_VCVR_ADVISORY, severity: null }],
    ["fixAvailable.isSemVerMajor is a string", GHSA_VCVR_ADVISORY, { name: "next", version: "16.3.6", isSemVerMajor: "no" }],
    ["fixAvailable has no version", GHSA_VCVR_ADVISORY, { name: "next" }],
  ])("still fails closed when %s", (_case, advisory, fixAvailable) => {
    const audit = nextAudit(advisory, fixAvailable);
    expect(evaluate(NEXT_LOCK, audit, 0).status).toBe("malformed_audit");
    expect(evaluate(NEXT_LOCK, audit, 1).status).toBe("malformed_audit");
  });

  it("still fails closed when a finding is listed but the summary counts are zero", () => {
    const audit = JSON.parse(nextAudit());
    audit.metadata.vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
    expect(evaluate(NEXT_LOCK, JSON.stringify(audit), 0).status).toBe("malformed_audit");
    expect(evaluate(NEXT_LOCK, JSON.stringify(audit), 1).status).toBe("malformed_audit");
  });

  it("keeps the exact three-key pass report for a clean audit", () => {
    expect(formatDependencyPolicyReport(evaluate(packageLock(), auditJson(), 0))).toBe(PASS_OUTPUT);
  });
});

describe("command failure reason", () => {
  it.each<[string, Partial<AuditExecutionResult>, string]>([
    ["an exit code", { exitCode: 17 }, "npm audit exit 17"],
    ["a large Windows exit code", { exitCode: 3_221_225_477 }, "npm audit exit 3221225477"],
    ["a timeout", { exitCode: null, stopped: "timeout" }, "npm audit timed out"],
    ["a signal", { exitCode: null, signal: "SIGTERM" }, "npm audit ended by signal SIGTERM"],
    ["a signal name in an unexpected form", { exitCode: null, signal: "SIGTERM; see private log" }, "npm audit ended without an exit code"],
    ["a missing exit code", { exitCode: null }, "npm audit ended without an exit code"],
    ["a negative exit code", { exitCode: -1 }, "npm audit ended without an exit code"],
    ["an exit code that is not a whole number", { exitCode: 1.5 }, "npm audit ended without an exit code"],
  ])("names %s", (_case, execution, reason) => {
    expect(commandFailure(execution).reason).toBe(reason);
  });

  it.each<[string, string, string]>([
    ["an npm 7+ code line", "npm error code E401\nnpm error 401 Unauthorized - GET https://registry.invalid/\n", "E401"],
    ["an npm 6 code line with Windows line endings", "npm ERR! code ENOTFOUND\r\nnpm ERR! errno ENOTFOUND\r\n", "ENOTFOUND"],
    ["the first of two code lines", "npm error code E401\nnpm error code E403\n", "E401"],
    ["a code line after other lines", "npm warn config production Use `--omit=dev` instead.\nnpm error code ECONNRESET\n", "ECONNRESET"],
    ["a last line with no line break", "npm error network aborted\nnpm error code EAI_AGAIN", "EAI_AGAIN"],
    ["the longest code allowed", `npm error code E${"X".repeat(24)}\n`, `E${"X".repeat(24)}`],
  ])("adds npm's error code from %s", (_case, stderr, code) => {
    expect(commandFailure({ exitCode: 1, stderr }).reason).toBe(`npm audit exit 1, npm code ${code}`);
  });

  it.each<[string, string]>([
    ["a lowercase code", "npm error code e401"],
    ["a bare E", "npm error code E"],
    ["a code one character too long", `npm error code E${"X".repeat(25)}`],
    ["text after the code", "npm error code E401 Unauthorized"],
    ["a leading space", " npm error code E401"],
    ["a double space", "npm error  code E401"],
    ["a warning prefix", "npm warn code E401"],
    ["a number instead of a code", "npm error code 401"],
    ["a dash in the code", "npm error code E-401"],
    ["punctuation after the code", "npm error code E401;"],
    ["text before npm", "stderr: npm error code E401"],
    ["terminal colors", "\u001b[31mnpm error\u001b[39m code E401"],
    ["a trailing non-breaking space", "npm error code E401\u00a0"],
    ["a trailing tab", "npm error code E401\t"],
    ["a carriage return inside the line", "npm error code E401\rnpm error code E403"],
    ["a non-ASCII letter", "npm error code E4\u00c50"],
  ])("ignores a code line with %s", (_case, line) => {
    expect(commandFailure({ exitCode: 1, stderr: `${line}\n` }).reason).toBe("npm audit exit 1");
  });

  it("takes npm's code only from stderr, never from what npm printed on stdout", () => {
    const stdout = JSON.stringify({ error: { code: "ENOLOCK", summary: "private summary", detail: "private detail" } });
    const { reason, output } = commandFailure({ exitCode: 1, stdout, stderr: "" });
    expect(reason).toBe("npm audit exit 1");
    expect(output).not.toContain("private");
  });

  it.each<[string, string, string]>([
    ["a 52-letter Azure DevOps PAT", `npm warn audit access denied for ${LETTERS_ONLY_PAT}`, LETTERS_ONLY_PAT],
    ["an _auth value on the next line", `npm warn audit //registry.invalid/:_auth=\n${BASE64_AUTH}`, BASE64_AUTH],
    ["a _password value on the next line", `npm warn audit //registry.invalid/:_password=\n${BASE64_PASSWORD}`, BASE64_PASSWORD],
  ])("never shows %s from the review of PR #2201", (_case, stderr, secret) => {
    const { reason, output } = commandFailure({ exitCode: 1, stderr });
    expect(reason).toBe("npm audit exit 1");
    expect(output).not.toContain(secret);
  });

  it("never shows a secret-shaped stderr value, wherever npm prints it", () => {
    const secrets = [
      LETTERS_ONLY_PAT,
      BASE64_AUTH,
      BASE64_PASSWORD,
      FAKE_NPM_TOKEN,
      FAKE_GITHUB_TOKEN,
      FAKE_JWT,
      "0123456789abcdef".repeat(4),
    ];
    const layouts: Array<(secret: string) => string> = [
      (secret) => secret,
      (secret) => `npm error ${secret}`,
      (secret) => `npm error code ${secret}`,
      (secret) => `npm ERR! code ${secret}`,
      (secret) => `npm error code E401${secret}`,
      (secret) => `npm error code E401 ${secret}`,
      (secret) => `npm error code E401\nnpm error ${secret}`,
      (secret) => `${secret}\nnpm error code E401`,
      (secret) => `npm error _auth=\n${secret}`,
      (secret) => `npm error _password=\nnpm error ${secret}`,
      (secret) => `npm error //registry.invalid/:_authToken=${secret}`,
      (secret) => `npm error Authorization: Bearer ${secret}`,
      (secret) => `npm error GET https://bot:${secret}@registry.invalid/-/npm/v1/security/advisories/bulk`,
    ];
    for (const secret of secrets) {
      for (const layout of layouts) {
        for (const lineBreak of ["\n", "\r\n"]) {
          const stderr = `${layout(secret).replaceAll("\n", lineBreak)}${lineBreak}`;
          const { reason, output } = commandFailure({ exitCode: 1, stderr });
          expect(["npm audit exit 1", "npm audit exit 1, npm code E401"]).toContain(reason);
          expect(output).not.toContain(secret);
        }
      }
    }
  });

  it("takes nothing from stderr except the code on a whole `npm error code` line", () => {
    // A seeded generator (mulberry32), so every run checks the same 2,000 inputs.
    let seed = 2195;
    function random(): number {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    }
    function pick<T>(items: readonly T[]): T {
      return items[Math.floor(random() * items.length)];
    }
    const alphabets = [
      "abcdefghijklmnopqrstuvwxyz234567",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_",
      "0123456789abcdef",
      " \t\r\u001b\u00a0\u2028:=@/\\\"'!;,.-",
    ].map((alphabet) => [...alphabet]);
    const prefixes = [
      "",
      "npm error ",
      "npm ERR! ",
      "npm warn ",
      "npm error code ",
      "npm ERR! code ",
      "npm error code E",
      "npm ERR! code E",
      "_auth=",
    ];
    let withCode = 0;
    for (let run = 0; run < 2_000; run += 1) {
      const lines = Array.from({ length: 1 + Math.floor(random() * 4) }, () => {
        const alphabet = pick(alphabets);
        return pick(prefixes) + Array.from({ length: 1 + Math.floor(random() * 40) }, () => pick(alphabet)).join("");
      });
      const stderr = lines.join(pick(["\n", "\r\n"]));
      const { reason } = commandFailure({ exitCode: 1, stderr });
      const code = /^npm audit exit 1, npm code (E[A-Z0-9_]{1,24})$/.exec(reason)?.[1];
      if (code === undefined) {
        expect(reason).toBe("npm audit exit 1");
        continue;
      }
      withCode += 1;
      const codeLines = stderr.split(/\r?\n/).filter((line) => line === `npm error code ${code}` || line === `npm ERR! code ${code}`);
      expect(codeLines.length).toBeGreaterThan(0);
    }
    expect(withCode).toBeGreaterThan(20);
  });

  it("uses the same grammar that deploy/release-vm.ps1 checks before it shows a reason", async () => {
    expect(FAILURE_REASON_PATTERN.flags).toBe("");
    const { source } = FAILURE_REASON_PATTERN;
    expect(source.startsWith("^") && source.endsWith("$")).toBe(true);
    const releaseScript = await fs.readFile(path.resolve("deploy", "release-vm.ps1"), "utf8");
    expect(releaseScript).toContain(`$reason -cmatch '\\A${source.slice(1, -1)}\\z'`);
  });

  it("names a start failure by its error code only", async () => {
    const error = Object.assign(new Error(`spawn failed near ${FAKE_NPM_TOKEN}`), { code: "ENOENT" });
    const { report } = await auditWith(vi.fn<AuditExecutor>().mockRejectedValue(error));
    expect(report).toEqual({
      status: "command_failed",
      counts: ZERO_REPORT_COUNTS,
      packages: [],
      reason: "npm audit could not start (ENOENT) (attempt 2 of 2)",
    });
    expect(formatDependencyPolicyReport(report)).not.toContain("Zx9");

    for (const code of ["bad code; see private detail", "enoent", `E${"X".repeat(25)}`, 13]) {
      const oddError = Object.assign(new Error("private"), { code });
      const { report: oddReport } = await auditWith(vi.fn<AuditExecutor>().mockRejectedValue(oddError));
      expect(oddReport.reason).toBe("npm audit could not start (attempt 2 of 2)");
    }
  });
});

describe("audit retry", () => {
  it("retries once when an attempt printed nothing, then passes on a clean report", async () => {
    const executor = vi.fn<AuditExecutor>()
      .mockResolvedValueOnce(NPM_SILENT_FAILURE)
      .mockResolvedValueOnce({ exitCode: 0, stdout: auditJson(), stderr: "" });
    const { report, onRetry } = await auditWith(executor);
    expect(formatDependencyPolicyReport(report)).toBe(PASS_OUTPUT);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor).toHaveBeenNthCalledWith(2, expect.objectContaining({ args: AUDIT_ARGUMENTS }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith("npm audit exit 1, npm code ECONNRESET");
  });

  it("stops after the second attempt and says so in the reason", async () => {
    const executor = vi.fn<AuditExecutor>().mockResolvedValue(NPM_SILENT_FAILURE);
    const { report, onRetry } = await auditWith(executor);
    expect(report).toEqual({
      status: "command_failed",
      counts: ZERO_REPORT_COUNTS,
      packages: [],
      reason: "npm audit exit 1, npm code ECONNRESET (attempt 2 of 2)",
    });
    expect(executor).toHaveBeenCalledTimes(MAX_AUDIT_ATTEMPTS);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it.each<[string, AuditExecutionResult, string]>([
    ["timed out", { exitCode: null, stdout: "", stderr: "", stopped: "timeout" }, "npm audit timed out"],
    ["exited with an error", { exitCode: 1, stdout: "", stderr: "" }, "npm audit exit 1"],
    ["was stopped without an exit code", { exitCode: null, stdout: "", stderr: "" }, "npm audit ended without an exit code"],
    ["was ended by a signal", { exitCode: null, stdout: "", stderr: "", signal: "SIGKILL" }, "npm audit ended by signal SIGKILL"],
  ])("retries once when npm printed nothing and %s", async (_case, failure, reason) => {
    const executor = vi.fn<AuditExecutor>()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce({ exitCode: 0, stdout: auditJson() });
    const { report, onRetry } = await auditWith(executor);
    expect(formatDependencyPolicyReport(report)).toBe(PASS_OUTPUT);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(reason);
  });

  it("retries once when npm could not start", async () => {
    const executor = vi.fn<AuditExecutor>()
      .mockRejectedValueOnce(Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }))
      .mockResolvedValueOnce({ exitCode: 0, stdout: auditJson() });
    const { report, onRetry } = await auditWith(executor);
    expect(formatDependencyPolicyReport(report)).toBe(PASS_OUTPUT);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith("npm audit could not start (ENOENT)");
  });

  const vulnerableLock = packageLock([{ name: "unsafe-package", version: "1.2.3" }]);
  const vulnerableAudit = auditJson([{ name: "unsafe-package", severity: "high" }]);
  const blockedLock = packageLock([{ ...BLOCKED_DEPENDENCIES[0] }]);
  it.each<[string, string, AuditExecutionResult, DependencyPolicyStatus]>([
    ["a report that lists advisories", vulnerableLock, { exitCode: 1, stdout: vulnerableAudit }, "rejected"],
    ["a report that lists advisories with an unexpected exit code", vulnerableLock, { exitCode: 2, stdout: vulnerableAudit }, "command_failed"],
    ["a clean report with a failing exit code", packageLock(), { exitCode: 1, stdout: auditJson() }, "command_failed"],
    ["a report cut off part way through", vulnerableLock, { exitCode: 1, stdout: vulnerableAudit.slice(0, 80) }, "malformed_audit"],
    [
      "a report with a field of the wrong type",
      NEXT_LOCK,
      { exitCode: 1, stdout: nextAudit({ ...GHSA_VCVR_ADVISORY, cvss: { score: 0, vectorString: 42 } }) },
      "malformed_audit",
    ],
    ["npm's own error object", packageLock(), NPM_AUDIT_ERROR, "command_failed"],
    ["printed text that is not an audit report", packageLock(), { exitCode: 1, stdout: "Error: unexpected failure" }, "command_failed"],
    ["a single line break", packageLock(), { exitCode: 1, stdout: "\n" }, "command_failed"],
    ["unreadable output with exit code 0", packageLock(), { exitCode: 0, stdout: "not json" }, "malformed_audit"],
    ["no output with exit code 0", packageLock(), { exitCode: 0, stdout: "" }, "malformed_audit"],
    ["a report that lists advisories, then a timeout", vulnerableLock, { exitCode: null, stdout: vulnerableAudit, stopped: "timeout" }, "rejected"],
    ["a clean report, then a timeout", packageLock(), { exitCode: null, stdout: auditJson(), stopped: "timeout" }, "malformed_audit"],
    [
      "a report cut off by a timeout",
      vulnerableLock,
      { exitCode: null, stdout: vulnerableAudit.slice(0, 80), stopped: "timeout" },
      "malformed_audit",
    ],
    ["text that is not a report, then a timeout", packageLock(), { exitCode: null, stdout: "Error", stopped: "timeout" }, "malformed_audit"],
    ["a clean report for a lock with a blocked package, then a timeout", blockedLock, { exitCode: null, stdout: auditJson(), stopped: "timeout" }, "rejected"],
    ["output over the size limit", packageLock(), { exitCode: null, stdout: auditJson(), stopped: "output_limit" }, "malformed_audit"],
    ["output over a limit that kept none of it", packageLock(), { exitCode: null, stdout: "", stopped: "output_limit" }, "malformed_audit"],
  ])("never retries %s", async (_case, lock, first, status) => {
    // A second call would return a clean report, so any retry here would turn into a pass.
    const executor = vi.fn<AuditExecutor>()
      .mockResolvedValueOnce(first)
      .mockResolvedValue({ exitCode: 0, stdout: auditJson() });
    const { report, onRetry } = await auditWith(executor, lock);
    expect(report.status).toBe(status);
    expect(executor).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  // The HIGH case from the review of PR #2201: npm prints a report and then hangs until the time limit. The old code
  // dropped the printed report, retried, got a clean report and passed.
  it.each<[string, string, unknown]>([
    ["a complete critical report", nextAudit(), NEXT_REJECTED],
    ["a report cut off part way through", '{"auditReportVersion":2,"vulnerabilities":', { status: "malformed_audit", counts: ZERO_REPORT_COUNTS, packages: [] }],
  ])("judges %s that npm printed before it hung, and never retries", async (_case, printed, expected) => {
    const hang = `process.stdout.write(${JSON.stringify(printed)}); setInterval(() => {}, 1000);`;
    const executor = vi.fn<AuditExecutor>()
      .mockImplementationOnce(() => runBoundedProcess(process.execPath, ["-e", hang], { cwd: tmpdir(), env: quietNode, timeoutMs: 1_000 }))
      .mockResolvedValue({ exitCode: 0, stdout: auditJson() });
    const { report, onRetry } = await auditWith(executor, NEXT_LOCK);
    expect(report).toEqual(expected);
    expect(executor).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("does not retry when the lock changed during the failed attempt", async () => {
    const executor = vi.fn<AuditExecutor>().mockImplementation(async ({ cwd }) => {
      await fs.writeFile(path.join(cwd, "package-lock.json"), packageLock([{ name: "added-package", version: "1.0.0" }]));
      return NPM_SILENT_FAILURE;
    });
    const { report } = await auditWith(executor);
    expect(report.status).toBe("lock_mismatch");
    expect(executor).toHaveBeenCalledOnce();
  });

  it("checks the lock again after the retry", async () => {
    const executor = vi.fn<AuditExecutor>()
      .mockResolvedValueOnce(NPM_SILENT_FAILURE)
      .mockImplementationOnce(async ({ cwd }) => {
        await fs.writeFile(path.join(cwd, "package-lock.json"), packageLock([{ name: "added-package", version: "1.0.0" }]));
        return { exitCode: 0, stdout: auditJson() };
      });
    const { report } = await auditWith(executor);
    expect(report.status).toBe("lock_mismatch");
    expect(executor).toHaveBeenCalledTimes(2);
  });
});

describe("npm audit process", () => {
  it("turns npm's warnings back on after `npm run --silent` turned them off", () => {
    const base: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: "/usr/bin",
      npm_config_loglevel: "silent",
      NPM_CONFIG_LOGLEVEL: "silent",
      Npm_Config_LogLevel: "error",
      npm_config_registry: "https://registry.invalid/",
    };
    expect(npmAuditEnvironment(base)).toEqual({
      NODE_ENV: "test",
      PATH: "/usr/bin",
      npm_config_registry: "https://registry.invalid/",
      npm_config_loglevel: "warn",
    });
    expect(base.npm_config_loglevel).toBe("silent");
  });

  it("returns the exit code, stdout and stderr of a finished process", async () => {
    const script = "process.stdout.write('{\"ok\":true}'); process.stderr.write('npm error one\\n'); process.exitCode = 3;";
    await expect(runBoundedProcess(process.execPath, ["-e", script], { cwd: tmpdir(), env: quietNode, timeoutMs: 20_000 }))
      .resolves.toEqual({ exitCode: 3, stdout: '{"ok":true}', stderr: "npm error one\n" });
  });

  it("stops a process that runs past its time limit and keeps what it printed", async () => {
    const script = "process.stdout.write('partial'); setInterval(() => {}, 1000);";
    await expect(runBoundedProcess(process.execPath, ["-e", script], { cwd: tmpdir(), env: quietNode, timeoutMs: 1_000 }))
      .resolves.toMatchObject({ exitCode: null, stdout: "partial", stopped: "timeout" });
  });

  it("stops a process whose stdout passes the size limit and keeps output up to the limit", async () => {
    const script = "process.stdout.write('x'.repeat(64 * 1024)); setInterval(() => {}, 1000);";
    await expect(runBoundedProcess(process.execPath, ["-e", script], {
      cwd: tmpdir(),
      env: quietNode,
      timeoutMs: 20_000,
      maxStdoutBytes: 1024,
    })).resolves.toMatchObject({ exitCode: null, stdout: "x".repeat(1024), stopped: "output_limit" });
  });

  it.runIf(process.platform !== "win32")("names the signal that ended a process", async () => {
    const script = "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);";
    await expect(runBoundedProcess(process.execPath, ["-e", script], { cwd: tmpdir(), env: quietNode, timeoutMs: 20_000 }))
      .resolves.toEqual({ exitCode: null, stdout: "", stderr: "", signal: "SIGTERM" });
  });

  it("keeps only whole stderr lines within the stderr limit", async () => {
    const script = "process.stderr.write('first line\\nsecond line that is long\\n' + 'z'.repeat(5000));";
    await expect(runBoundedProcess(process.execPath, ["-e", script], {
      cwd: tmpdir(),
      env: quietNode,
      timeoutMs: 20_000,
      maxStderrBytes: 30,
    })).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "first line\n" });
  });

  it("never reads npm's code from a stderr line cut off by the limit", async () => {
    // Keeping 17 bytes of "npm error code E401" would read as the code E4.
    const script = "process.stderr.write('npm error code E401\\n'); process.exitCode = 1;";
    const execution = await runBoundedProcess(process.execPath, ["-e", script], {
      cwd: tmpdir(),
      env: quietNode,
      timeoutMs: 20_000,
      maxStderrBytes: 17,
    });
    expect(execution).toEqual({ exitCode: 1, stdout: "", stderr: "" });
    expect(commandFailure(execution).reason).toBe("npm audit exit 1");
  });

  it("rejects when the command cannot start", async () => {
    await expect(runBoundedProcess(path.join(tmpdir(), "markdoc-missing-command-2195"), [], { cwd: tmpdir(), timeoutMs: 20_000 }))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "win32")("stops the whole process tree on Windows", async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
      "process.stderr.write('grandchild ' + child.pid + '\\n');",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const result = await runBoundedProcess(process.execPath, ["-e", script], { cwd: tmpdir(), env: quietNode, timeoutMs: 3_000 });
    expect(result.stopped).toBe("timeout");
    const pid = Number(/grandchild (\d+)/.exec(result.stderr ?? "")?.[1]);
    expect(pid).toBeGreaterThan(0);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      for (let waited = 0; alive() && waited < 10_000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(alive()).toBe(false);
    } finally {
      if (alive()) process.kill(pid);
    }
  });
});
