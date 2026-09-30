import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMain } from "../dependency-policy-preflight.mjs";
import {
  AUDIT_ARGUMENTS,
  BLOCKED_DEPENDENCIES,
  MAX_AUDIT_AGE_MS,
  MAX_AUDIT_ATTEMPTS,
  MAX_FAILURE_REASON_LENGTH,
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

// What npm 11 writes when the registry's audit endpoint cannot be reached: no report, only its error object.
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
const NPM_AUDIT_ERROR_DETAIL =
  "npm warn audit network timeout at: https://registry.invalid/-/npm/v1/security/advisories/bulk | npm error audit endpoint returned an error";

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
  expect(reason.length).toBeGreaterThan(0);
  expect(reason.length).toBeLessThanOrEqual(MAX_FAILURE_REASON_LENGTH);
  expect(reason).toMatch(/^[\x20-\x7e]+$/);
  return { reason, output: formatDependencyPolicyReport(report) };
}

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
      .mockResolvedValueOnce(NPM_AUDIT_ERROR)
      .mockResolvedValueOnce({ exitCode: 0, stdout: auditJson(), stderr: "" });
    const exitCode = await runMain(["--lock-sha256", fixture.identity, "--run-audit"], {
      cwd: fixture.directory,
      executor,
      retryDelayMs: 0,
      output: { log: (message) => messages.push(message), warn: (message) => warnings.push(message) },
    });
    expect(exitCode).toBe(0);
    expect(messages).toEqual([PASS_OUTPUT]);
    expect(warnings).toEqual([`Dependency preflight audit failed (npm audit exit 1: ${NPM_AUDIT_ERROR_DETAIL}); retrying once.`]);
  });

  it("prints a bounded command_failed report with its reason when the retry fails too", async () => {
    const fixture = await fixtureDirectory();
    const messages: string[] = [];
    const executor = vi.fn<AuditExecutor>().mockResolvedValue(NPM_AUDIT_ERROR);
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
      reason: `npm audit exit 1 (attempt 2 of 2): ${NPM_AUDIT_ERROR_DETAIL}`,
    });
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
    ["a timeout", { exitCode: null, stopped: "timeout" }, "npm audit timed out"],
    ["oversized output", { exitCode: null, stopped: "output_limit" }, "npm audit output exceeded its size limit"],
    ["a missing exit code", { exitCode: null }, "npm audit ended without an exit code"],
  ])("names %s", (_case, execution, reason) => {
    expect(commandFailure(execution).reason).toBe(reason);
  });

  it("adds the first two meaningful stderr lines and skips npm's log noise", () => {
    const stderr = [
      "npm warn config production Use `--omit=dev` instead.",
      "npm warn Unknown env config \"example\". This will stop working in the next major version of npm.",
      "npm warn audit network timeout at: https://registry.invalid/-/npm/v1/security/advisories/bulk",
      "npm error",
      "npm error audit endpoint returned an error",
      "npm error A complete log of this run can be found in: /tmp/npm-cache/_logs/debug-0.log",
      "npm error a third meaningful line",
    ].join("\r\n");
    expect(commandFailure({ exitCode: 1, stderr }).reason).toBe(`npm audit exit 1: ${NPM_AUDIT_ERROR_DETAIL}`);
  });

  const home = homedir();
  it.each<[string, string, string[], string]>([
    [
      "credentials and a query in a URL",
      `npm error 401 Unauthorized - POST https://${["release-bot", "pw-Hunter2x"].join(":")}@registry.invalid/-/npm/v1/security/advisories/bulk?token=qs-Secret9`,
      ["release-bot", "Hunter2x", "Secret9", "?token"],
      "POST https://registry.invalid/-/npm/v1/security/advisories/bulk",
    ],
    [
      "a URL password with a slash",
      `npm error GET https://${["release-bot", "pw/Sl4sh"].join(":")}@registry.invalid/-/npm/v1/security/advisories/bulk`,
      ["release-bot", "Sl4sh"],
      "GET https://registry.invalid/-/npm/v1/security/advisories/bulk",
    ],
    [
      "a URL password with an @",
      `npm error GET https://${["release-bot", "pw@At5x"].join(":")}@registry.invalid/-/npm/v1/security/advisories/bulk`,
      ["release-bot", "At5x"],
      "GET https://registry.invalid/-/npm/v1/security/advisories/bulk",
    ],
    [
      "proxy credentials",
      `npm error connect ECONNREFUSED via http://${["proxy-user", "proxy-Pass7"].join(":")}@proxy.invalid:8080`,
      ["proxy-user", "proxy-Pass7"],
      "via http://proxy.invalid:8080",
    ],
    [
      "an Authorization header",
      `npm http fetch POST 401 https://registry.invalid/-/npm/v1/security/advisories/bulk Authorization: Bearer ${FAKE_NPM_TOKEN}`,
      [FAKE_NPM_TOKEN, "Zx9Zx9"],
      "Authorization: [redacted]",
    ],
    ["a bearer token", "npm error retry with bearer sh0rtTok,then give up", ["sh0rtTok"], "bearer [redacted],then give up"],
    [
      "a proxy-authorization header",
      `npm error proxy-authorization: Basic ${Buffer.from("release-bot:pw-Basic6").toString("base64")}`,
      [Buffer.from("release-bot:pw-Basic6").toString("base64")],
      "proxy-authorization: [redacted]",
    ],
    [
      "an npm _authToken setting",
      `npm error //registry.invalid/:_authToken=${["tok", "Val1Secret"].join("-")}`,
      ["Val1Secret"],
      "//registry.invalid/:_authToken=[redacted]",
    ],
    ["a quoted password", 'npm error login failed, password: "hunter two"', ["hunter"], "password: [redacted]"],
    ["an npm token on its own", `npm error token ${FAKE_NPM_TOKEN} was revoked`, [FAKE_NPM_TOKEN, "Zx9Zx9"], "token [redacted] was revoked"],
    ["a GitHub token", `npm error fetch failed for ${FAKE_GITHUB_TOKEN}`, [FAKE_GITHUB_TOKEN, "Qw3Qw3"], "fetch failed for [redacted]"],
    ["a JWT", `npm error session ${FAKE_JWT} expired`, [FAKE_JWT, "c2lnbmF0dXJlLXBhcnQ"], "session [redacted] expired"],
    [
      "a long opaque value",
      "npm error request id a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8 failed",
      ["a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8"],
      "request id [redacted] failed",
    ],
    [
      "a cookie",
      "npm error set-cookie: session=abc123xyz; Path=/",
      ["abc123xyz"],
      "set-cookie: [redacted]; Path=/",
    ],
    [
      "the home directory",
      `npm error path ${home}${path.sep}private-project${path.sep}package-lock.json`,
      [home],
      `path ~${path.sep}private-project`,
    ],
    [
      "the home directory with forward slashes",
      `npm error path ${home.replace(/\\/g, "/")}/private-project/package-lock.json`,
      [home.replace(/\\/g, "/")],
      "path ~/private-project",
    ],
    [
      "terminal escapes, control characters and non-ASCII text",
      "\u001b[31mnpm error\u001b[39m caf\u00e9 \u2603 bell\u0007 tab\tend \u001b]8;;https://example.invalid/docs\u0007docs\u001b]8;;\u0007",
      ["\u001b", "\u00e9", "\u2603", "\u0007", "\t", "example.invalid"],
      "npm error caf? ? bell tab end docs",
    ],
  ])("removes %s", (_case, line, secrets, kept) => {
    const { reason, output } = commandFailure({ exitCode: 1, stderr: `${line}\n` });
    expect(reason).toContain(kept);
    for (const secret of secrets) expect(output).not.toContain(secret);
  });

  it("caps the reason at 200 characters", () => {
    // deploy/release-vm.ps1 shows a reason only when it has at most 200 characters.
    expect(MAX_FAILURE_REASON_LENGTH).toBe(200);
    const stderr = Array.from({ length: 20 }, (_, index) => `npm error detail ${index} ${"word ".repeat(60)}`).join("\n");
    const { reason } = commandFailure({ exitCode: 1, stderr });
    expect(reason.startsWith("npm audit exit 1: npm error detail 0 word word")).toBe(true);
    expect(reason.endsWith("...")).toBe(true);
    expect(reason.length).toBeGreaterThan(190);
    expect(reason.length).toBeLessThanOrEqual(200);
  });

  it("drops a stderr line cut off by the capture limit instead of keeping part of it", () => {
    const { reason, output } = commandFailure({ exitCode: 1, stderr: `npm error ${"padding ".repeat(2_000)}${FAKE_NPM_TOKEN}` });
    expect(reason).toBe("npm audit exit 1");
    expect(output).not.toContain("Zx9");
  });

  it("drops a line too long to cut at a word boundary", () => {
    const stderr = `npm error ${"x".repeat(1_500)}\nnpm error next line`;
    expect(commandFailure({ exitCode: 1, stderr }).reason).toBe("npm audit exit 1: npm error next line");
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

    const oddCode = Object.assign(new Error("private"), { code: "bad code; see private detail" });
    const { report: oddReport } = await auditWith(vi.fn<AuditExecutor>().mockRejectedValue(oddCode));
    expect(oddReport.reason).toBe("npm audit could not start (attempt 2 of 2)");
  });
});

describe("audit retry", () => {
  it("retries once when npm printed no audit report, then passes on a clean report", async () => {
    const executor = vi.fn<AuditExecutor>()
      .mockResolvedValueOnce(NPM_AUDIT_ERROR)
      .mockResolvedValueOnce({ exitCode: 0, stdout: auditJson(), stderr: "" });
    const { report, onRetry } = await auditWith(executor);
    expect(formatDependencyPolicyReport(report)).toBe(PASS_OUTPUT);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor).toHaveBeenNthCalledWith(2, expect.objectContaining({ args: AUDIT_ARGUMENTS }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(`npm audit exit 1: ${NPM_AUDIT_ERROR_DETAIL}`);
  });

  it("stops after the second attempt and says so in the reason", async () => {
    const executor = vi.fn<AuditExecutor>().mockResolvedValue(NPM_AUDIT_ERROR);
    const { report, onRetry } = await auditWith(executor);
    expect(report).toEqual({
      status: "command_failed",
      counts: ZERO_REPORT_COUNTS,
      packages: [],
      reason: `npm audit exit 1 (attempt 2 of 2): ${NPM_AUDIT_ERROR_DETAIL}`,
    });
    expect(executor).toHaveBeenCalledTimes(MAX_AUDIT_ATTEMPTS);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it.each<[string, AuditExecutionResult]>([
    ["timed out", { exitCode: null, stdout: "", stderr: "", stopped: "timeout" }],
    ["exited without any output", { exitCode: 1, stdout: "", stderr: "" }],
    ["was stopped without an exit code", { exitCode: null, stdout: "", stderr: "" }],
    ["printed text that is not an audit report", { exitCode: 1, stdout: "Error: unexpected failure", stderr: "" }],
  ])("retries once when npm %s", async (_case, failure) => {
    const executor = vi.fn<AuditExecutor>()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce({ exitCode: 0, stdout: auditJson() });
    const { report, onRetry } = await auditWith(executor);
    expect(formatDependencyPolicyReport(report)).toBe(PASS_OUTPUT);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
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
    ["unreadable output with exit code 0", packageLock(), { exitCode: 0, stdout: "not json" }, "malformed_audit"],
    ["output over the size limit", packageLock(), { exitCode: null, stdout: "", stopped: "output_limit" }, "command_failed"],
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

  it("does not retry when the lock changed during the failed attempt", async () => {
    const executor = vi.fn<AuditExecutor>().mockImplementation(async ({ cwd }) => {
      await fs.writeFile(path.join(cwd, "package-lock.json"), packageLock([{ name: "added-package", version: "1.0.0" }]));
      return NPM_AUDIT_ERROR;
    });
    const { report } = await auditWith(executor);
    expect(report.status).toBe("lock_mismatch");
    expect(executor).toHaveBeenCalledOnce();
  });

  it("checks the lock again after the retry", async () => {
    const executor = vi.fn<AuditExecutor>()
      .mockResolvedValueOnce(NPM_AUDIT_ERROR)
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
  const quietNode = { ...process.env, NODE_OPTIONS: "--no-warnings" };

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

  it("stops a process that runs past its time limit and drops its partial output", async () => {
    const script = "process.stdout.write('partial'); setInterval(() => {}, 1000);";
    await expect(runBoundedProcess(process.execPath, ["-e", script], { cwd: tmpdir(), env: quietNode, timeoutMs: 1_000 }))
      .resolves.toMatchObject({ exitCode: null, stdout: "", stopped: "timeout" });
  });

  it("stops a process whose stdout passes the size limit", async () => {
    const script = "process.stdout.write('x'.repeat(64 * 1024)); setInterval(() => {}, 1000);";
    await expect(runBoundedProcess(process.execPath, ["-e", script], {
      cwd: tmpdir(),
      env: quietNode,
      timeoutMs: 20_000,
      maxStdoutBytes: 1024,
    })).resolves.toMatchObject({ exitCode: null, stdout: "", stopped: "output_limit" });
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
