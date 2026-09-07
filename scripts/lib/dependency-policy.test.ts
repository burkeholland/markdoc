import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMain } from "../dependency-policy-preflight.mjs";
import {
  AUDIT_ARGUMENTS,
  BLOCKED_DEPENDENCIES,
  MAX_AUDIT_AGE_MS,
  MAX_REPORTED_PACKAGES,
  evaluateDependencyPolicy,
  evaluateTemporaryAuditFile,
  formatDependencyPolicyReport,
  packageLockSha256,
  runDependencyAudit,
  type AuditExecutor,
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

  it("fails a rejected executor and never calls one for a mismatched lock", async () => {
    const fixture = await fixtureDirectory();
    const failedExecutor = vi.fn<AuditExecutor>().mockRejectedValue(new Error("private command detail"));
    await expect(runDependencyAudit({
      cwd: fixture.directory,
      lockPath: fixture.lockPath,
      expectedLockSha256: fixture.identity,
      executor: failedExecutor,
    })).resolves.toMatchObject({ status: "command_failed" });

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
});
