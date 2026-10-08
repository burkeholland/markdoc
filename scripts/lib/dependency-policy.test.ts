import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMain } from "../dependency-policy-preflight.mjs";
import {
  ACCEPTED_ADVISORIES,
  ACCEPTED_ADVISORY_ID_PATTERN,
  ACCEPTED_EXPIRY_PATTERN,
  ACCEPTED_PACKAGE_PATTERN,
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
  packageLockProblems,
  packageLockSha256,
  runBoundedProcess,
  runDependencyAudit,
  type AuditExecutionResult,
  type AuditExecutor,
  type DependencyPolicyStatus,
  type ListedAdvisory,
} from "./dependency-policy";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

// One of the four hosts of the package feed, written out here so that the tests do not read the policy's own list.
const FEED = "https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/";

// What npm writes in "resolved" for a registry package: a scope is part of the folder, not of the file name.
function feedTarball(name: string, version: string, registry = FEED): string {
  return `${registry}${name}/-/${name.split("/").pop()}-${version}.tgz`;
}

// What a fixture's root entry must say so that the lock is one npm would write (#2308): every entry directly under
// the top node_modules folder is something the project itself needs, a devDependency when it is marked "dev": true
// and a dependency when it is not. An entry in a folder below another entry is not named here: a test that has one
// says in the entry above what needs it.
function honestRoot(entries: Record<string, unknown>): Record<string, Record<string, string>> {
  const root: Record<string, Record<string, string>> = {};
  for (const [key, entry] of Object.entries(entries)) {
    const folder = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key)?.[1];
    if (!folder || typeof entry !== "object" || entry === null) continue;
    const { dev, version } = entry as { dev?: unknown; version?: unknown };
    (root[dev === true ? "devDependencies" : "dependencies"] ??= {})[folder] = typeof version === "string" ? version : "*";
  }
  return root;
}

// Every fixture entry is honest unless a test says otherwise: its "resolved" is the feed tarball of the name the
// policy judges it by (the "name" flag when it has one, otherwise the folder) and of its version (#2297), and the
// root entry needs it the way honestRoot says (#2308). `root` replaces records of the root entry.
function packageLock(
  packages: Array<{ name: string; version: string; flags?: Record<string, unknown> }> = [],
  root: Record<string, unknown> = {},
): string {
  const entries = Object.fromEntries(packages.map(({ name, version, flags }) => {
    const judgedName = typeof flags?.name === "string" ? flags.name : name.split("node_modules/").pop() as string;
    return [`node_modules/${name}`, { version, resolved: feedTarball(judgedName, version), ...flags }];
  }));
  return JSON.stringify({
    name: "dependency-policy-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "dependency-policy-fixture", version: "1.0.0", ...honestRoot(entries), ...root },
      ...entries,
    },
  });
}

// The package.json npm would have written a lock from: the lock's own root entry. A text that is no lock gets an
// empty package.json, which the policy never reaches.
function packageJsonFor(lock: string): string {
  try {
    return JSON.stringify((JSON.parse(lock) as { packages: Record<string, unknown> }).packages[""] ?? {});
  } catch {
    return "{}";
  }
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

// A folder with the lock and, unless a test says otherwise, the package.json that belongs to it (#2308).
async function fixtureDirectory(
  lock = packageLock(),
  packageJson: string | null = packageJsonFor(lock),
): Promise<{ directory: string; lockPath: string; identity: string }> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "markdoc-dependency-policy-"));
  temporaryDirectories.push(directory);
  const lockPath = path.join(directory, "package-lock.json");
  await fs.writeFile(lockPath, lock);
  if (packageJson !== null) await fs.writeFile(path.join(directory, "package.json"), packageJson);
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

  // An alias ("harmless-alias": "npm:qs@6.15.3") installs the package in a folder with another name and writes the
  // real name into the lock entry (#2294). The policy must judge the package, not the folder.
  it.each(BLOCKED_DEPENDENCIES)("rejects the blocked node $name@$version behind an alias", ({ name, version }) => {
    const report = evaluate(packageLock([{ name: "harmless-alias", version, flags: { name } }]));
    expect(report.status).toBe("rejected");
    expect(report.counts.blocked).toBe(1);
    expect(report.packages).toEqual([{ name, version, status: "blocked" }]);
  });

  // The "name" field of a lock entry is only what the lock says. `npm ci` installs the tarball in "resolved" into
  // the folder in the path whatever that field holds, so a blocked package stays blocked under either name.
  it.each(BLOCKED_DEPENDENCIES)("rejects the blocked node $name@$version whose lock entry claims another name", ({ name, version }) => {
    const report = evaluate(packageLock([{ name, version, flags: { name: "another-package" } }]));
    expect(report.status).toBe("rejected");
    expect(report.counts.blocked).toBe(1);
    expect(report.packages).toEqual([{ name, version, status: "blocked" }]);
  });

  it.each(BLOCKED_DEPENDENCIES)("rejects the blocked node $name@$version in a nested folder whose lock entry claims another name", ({ name, version }) => {
    const report = evaluate(packageLock([
      { name: "parent-package", version: "1.0.0" },
      { name: `parent-package/node_modules/${name}`, version, flags: { name: "another-package", dev: true } },
    ]));
    expect(report.status).toBe("rejected");
    expect(report.counts.blocked).toBe(1);
    expect(report.packages).toEqual([{ name, version, status: "blocked" }]);
  });

  it("counts a blocked node once when its folder and its lock entry both name it", () => {
    const { name, version } = BLOCKED_DEPENDENCIES[0];
    const report = evaluate(packageLock([{ name, version, flags: { name } }]));
    expect(report.counts.blocked).toBe(1);
    expect(report.packages).toEqual([{ name, version, status: "blocked" }]);
  });

  it("does not block a blocked name at another version, under either name", () => {
    const { name } = BLOCKED_DEPENDENCIES[0];
    const report = evaluate(packageLock([
      { name, version: "0.0.1", flags: { name: "another-package" } },
      { name: "harmless-alias", version: "0.0.1", flags: { name } },
    ]));
    expect(formatDependencyPolicyReport(report)).toBe(PASS_OUTPUT);
  });

  it("reports an advisory on an aliased node under the real package name", () => {
    const lock = packageLock([{ name: "harmless-alias", version: "1.2.3", flags: { name: "unsafe-package" } }]);
    const audit = JSON.parse(auditJson([{ name: "unsafe-package", severity: "high" }]));
    // npm audit names the real package and lists the folder the alias was installed in.
    audit.vulnerabilities["unsafe-package"].nodes = ["node_modules/harmless-alias"];
    const report = evaluate(lock, JSON.stringify(audit), 1);
    expect(report.status).toBe("rejected");
    expect(report.packages).toEqual([{ name: "unsafe-package", version: "1.2.3", status: "vulnerable" }]);
  });

  it("fails closed when an advisory names the folder of an alias instead of its real package", () => {
    const lock = packageLock([{ name: "harmless-alias", version: "1.2.3", flags: { name: "unsafe-package" } }]);
    const report = evaluate(lock, auditJson([{ name: "harmless-alias", severity: "high" }]), 1);
    expect(report.status).toBe("malformed_audit");
  });

  it.each([
    ["a number", 7],
    ["empty text", ""],
    ["a path", "../unsafe-package"],
    ["null", null],
    ["a list", ["unsafe-package"]],
  ])("fails closed on a lock entry whose name is %s", (_case, name) => {
    expect(evaluate(packageLock([{ name: "harmless-alias", version: "1.2.3", flags: { name } }])).status).toBe("invalid_lock");
  });

  it("fails closed on an aliased entry whose folder is not a package name", () => {
    expect(evaluate(packageLock([{ name: "not a folder name", version: "1.2.3", flags: { name: "unsafe-package" } }])).status).toBe("invalid_lock");
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

// `npm ci` installs the tarball in "resolved", checked against "integrity", into the folder in the entry's path. It
// never compares that tarball with the entry's "name" and "version", and those two fields are all that npm audit
// and the lists look at. So the lock is refused unless every entry's "resolved" is, character for character, the
// package feed's address of the tarball of the entry's own name and version. Each case below that says "real npm"
// was run with npm 11.12.1 against the feed in a scratch folder.
describe("locked tarballs (#2297)", () => {
  const INVALID_LOCK_OUTPUT =
    '{"status":"invalid_lock","counts":{"blocked":0,"info":0,"low":0,"moderate":0,"high":0,"critical":0,"vulnerabilities":0,"reported":0,"omitted":0},"packages":[]}';
  const NOT_THE_TARBALL = "\"resolved\" is not the package feed's address of the tarball of this name and version";
  const NOT_CANONICAL = "the \"version\" is not three numbers without leading zeros and an optional prerelease";
  const NOT_BUNDLED = "there is no \"resolved\", and the entry is not bundled by a feed package one folder up";
  const NOT_A_FOLDER = "the key is not package folders under node_modules/ and nothing else";
  const A_LINK = "the entry is a link to a folder, not a package from the feed";
  const LODASH_4_17_20_INTEGRITY = "sha1-tEqbYpe8tpjxxRo1RaKzs2jVnFI=";
  const GOOD = `${FEED}some-package/-/some-package-1.2.3.tgz`;

  function rawLock(entries: Record<string, unknown>, root: Record<string, unknown> = {}): string {
    return JSON.stringify({
      name: "locked-tarball-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "locked-tarball-fixture", version: "1.0.0", ...honestRoot(entries), ...root }, ...entries },
    });
  }

  // An entry the way npm writes it for a registry package.
  function honest(name: string, version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { version, resolved: feedTarball(name, version), integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=", ...extra };
  }

  const lastFolder = (key: string) => `/${key}`.split("/node_modules/").pop() as string;

  // What an honest lock has for an entry in a folder below another entry (#2308): an entry for every folder above
  // it, each naming the folder below as a dependency.
  function withParents(entries: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
    const all = { ...entries };
    for (let child of Object.keys(entries)) {
      for (let cut = child.lastIndexOf("/node_modules/"); cut > 0; cut = child.lastIndexOf("/node_modules/")) {
        const parent = child.slice(0, cut);
        const above = all[parent] ?? honest(lastFolder(parent), "1.0.0");
        all[parent] = { ...above, dependencies: { ...(above.dependencies as Record<string, string>), [lastFolder(child)]: "*" } };
        child = parent;
      }
    }
    return all;
  }

  function expectRefused(lock: string, problems: string[]): void {
    expect(formatDependencyPolicyReport(evaluate(lock))).toBe(INVALID_LOCK_OUTPUT);
    expect(packageLockProblems(lock)).toEqual(problems);
  }

  function expectJudged(lock: string): void {
    expect(packageLockProblems(lock)).toEqual([]);
    expect(formatDependencyPolicyReport(evaluate(lock))).toBe(PASS_OUTPUT);
  }

  it("judges an entry whose resolved is the feed tarball of its name and version", () => {
    const lock = rawLock({ "node_modules/lodash": honest("lodash", "4.17.20", { integrity: LODASH_4_17_20_INTEGRITY }) });
    expectJudged(lock);
    const report = evaluate(lock, auditJson([{ name: "lodash", severity: "high" }]), 1);
    expect(report.status).toBe("rejected");
    expect(report.packages).toEqual([{ name: "lodash", version: "4.17.20", status: "vulnerable" }]);
  });

  // First row of the issue. Real npm: audit asks about "harmless" and finds nothing, npm ci installs lodash 4.17.20.
  it("refuses a vulnerable tarball whose entry claims another name", () => {
    expectRefused(rawLock({
      "node_modules/lodash": { name: "harmless", ...honest("lodash", "4.17.20", { integrity: LODASH_4_17_20_INTEGRITY }) },
    }), [`node_modules/lodash: ${NOT_THE_TARBALL}`]);
  });

  // Second row of the issue. Real npm: audit asks about lodash 4.18.1 and finds nothing, npm ci installs 4.17.20.
  it("refuses a vulnerable tarball whose entry claims another version", () => {
    expectRefused(rawLock({
      "node_modules/lodash": { ...honest("lodash", "4.17.20", { integrity: LODASH_4_17_20_INTEGRITY }), version: "4.18.1" },
    }), [`node_modules/lodash: ${NOT_THE_TARBALL}`]);
  });

  it("refuses a blocked tarball in a folder and under a name that are both harmless", () => {
    const { name, version } = BLOCKED_DEPENDENCIES[0];
    expectRefused(rawLock({
      "node_modules/harmless": { version, resolved: feedTarball(name, version) },
    }), [`node_modules/harmless: ${NOT_THE_TARBALL}`]);
  });

  it.each<[string, unknown]>([
    ["the public npm registry", "https://registry.npmjs.org/some-package/-/some-package-1.2.3.tgz"],
    ["another host with the feed's path", GOOD.replace("ms-feed-25.pkgs.visualstudio.com", "example.com")],
    ["a host that only starts with the feed's host", GOOD.replace(".com/", ".com.example.com/")],
    ["the feed's host as a folder of another host", GOOD.replace("https://", "https://example.com/")],
    ["the feed's host as the user name for another host", GOOD.replace(".com/", ".com@example.com/")],
    ["http", GOOD.replace("https://", "http://")],
    ["no scheme", GOOD.replace("https:", "")],
    ["an upper-case scheme", GOOD.replace("https://", "HTTPS://")],
    ["an upper-case host", GOOD.replace("ms-feed-25", "MS-FEED-25")],
    ["a user name", GOOD.replace("https://", "https://user@")],
    ["a user name and a password", GOOD.replace("https://", "https://user:secret@")],
    ["the default port", GOOD.replace(".com/", ".com:443/")],
    ["another port", GOOD.replace(".com/", ".com:8443/")],
    ["a query", `${GOOD}?download=1`],
    // Real npm: the feed ignores the query, so this installs 1.2.2 while the text ends in the tarball of 1.2.3.
    ["a query that ends in the right tarball", `${FEED}some-package/-/some-package-1.2.2.tgz?x=/some-package/-/some-package-1.2.3.tgz`],
    ["a fragment", `${GOOD}#fragment`],
    ["a fragment that ends in the right tarball", `${FEED}some-package/-/some-package-1.2.2.tgz#/some-package/-/some-package-1.2.3.tgz`],
    ["another project on the feed's host", GOOD.replace("/1es-public/", "/other-project/")],
    ["another feed in the project", GOOD.replace("/npm-public/", "/other-feed/")],
    ["an upper-case project", GOOD.replace("/1es-public/", "/1ES-PUBLIC/")],
    ["an upper-case package name", `${FEED}Some-Package/-/Some-Package-1.2.3.tgz`],
    ["an upper-case file name", `${FEED}some-package/-/SOME-PACKAGE-1.2.3.tgz`],
    ["an upper-case extension", GOOD.replace(".tgz", ".TGZ")],
    ["a percent-encoded letter in the folder", `${FEED}some-packag%65/-/some-package-1.2.3.tgz`],
    ["a percent-encoded letter in the file name", `${FEED}some-package/-/%73ome-package-1.2.3.tgz`],
    ["a percent-encoded dash segment", `${FEED}some-package/%2d/some-package-1.2.3.tgz`],
    ["a percent-encoded dot in the version", `${FEED}some-package/-/some-package-1%2e2%2e3.tgz`],
    ["a dot segment", `${FEED}some-package/-/./some-package-1.2.3.tgz`],
    ["a parent segment", `${FEED}other-package/../some-package/-/some-package-1.2.3.tgz`],
    ["a parent segment after another tarball", `${FEED}some-package/-/some-package-1.2.2.tgz/../some-package-1.2.3.tgz`],
    ["a double slash", `${FEED}some-package/-//some-package-1.2.3.tgz`],
    ["a trailing slash", `${GOOD}/`],
    ["a trailing space", `${GOOD} `],
    ["a leading space", ` ${GOOD}`],
    ["a trailing line feed", `${GOOD}\n`],
    // `node` and `@types/node` are two real packages whose tarballs are both called node-<version>.tgz.
    ["the right file name under another package's folder", `${FEED}other-package/-/some-package-1.2.3.tgz`],
    ["the right folder with another package's file", `${FEED}some-package/-/other-package-1.2.3.tgz`],
    ["the right name with another version", `${FEED}some-package/-/some-package-1.2.4.tgz`],
    ["the right name with a longer version", `${FEED}some-package/-/some-package-1.2.34.tgz`],
    ["the right name with a prerelease of the version", `${FEED}some-package/-/some-package-1.2.3-beta.1.tgz`],
    // Real npm: the feed serves the tarball of 1.2.3 for each of these three spellings.
    ["the version with a v", `${FEED}some-package/-/some-package-v1.2.3.tgz`],
    ["the version with a leading zero", `${FEED}some-package/-/some-package-1.2.03.tgz`],
    ["the version with build metadata", `${FEED}some-package/-/some-package-1.2.3+build.tgz`],
    ["no dash segment", `${FEED}some-package/some-package-1.2.3.tgz`],
    ["no extension", GOOD.replace(".tgz", "")],
    ["another extension", GOOD.replace(".tgz", ".tar.gz")],
    ["only the file name", "some-package-1.2.3.tgz"],
    ["a git URL over ssh", "git+ssh://git@github.com/owner/some-package.git#0123456789abcdef0123456789abcdef01234567"],
    ["a git URL over https", "git+https://github.com/owner/some-package.git#0123456789abcdef0123456789abcdef01234567"],
    ["a GitHub tarball", "https://codeload.github.com/owner/some-package/tar.gz/0123456789abcdef0123456789abcdef01234567"],
    ["a file: URL of a folder", "file:../some-package"],
    ["a file: URL of a tarball", "file:some-package-1.2.3.tgz"],
    ["a folder", "packages/some-package"],
    ["empty text", ""],
    ["null", null],
    ["a number", 7],
    ["true", true],
    ["a list that holds the right address", [GOOD]],
    ["an object that holds the right address", { href: GOOD }],
  ])("refuses a resolved that is %s", (_case, resolved) => {
    expectRefused(rawLock({ "node_modules/some-package": { version: "1.2.3", resolved } }), [`node_modules/some-package: ${NOT_THE_TARBALL}`]);
  });

  it.each([2, 12, 17, 25])("judges an entry from the feed host ms-feed-%i", (host) => {
    const registry = FEED.replace("ms-feed-25", `ms-feed-${host}`);
    expectJudged(rawLock({ "node_modules/some-package": { version: "1.2.3", resolved: feedTarball("some-package", "1.2.3", registry) } }));
  });

  // ms-feed-1 to ms-feed-28 exist, but only these four serve the feed without a login. A host name that does not
  // exist yet could be registered by anyone. docs/vm-hosting.md names the hosts in backticks, and must name the same
  // ones: a fifth host is added in the policy and in the docs in one pull request.
  it("accepts the four feed hosts that docs/vm-hosting.md names, and no other number", async () => {
    const accepted: string[] = [];
    for (let host = 0; host <= 300; host += 1) {
      const registry = FEED.replace("ms-feed-25", `ms-feed-${host}`);
      const lock = rawLock({ "node_modules/some-package": { version: "1.2.3", resolved: feedTarball("some-package", "1.2.3", registry) } });
      if (evaluate(lock).status !== "invalid_lock") accepted.push(`ms-feed-${host}.pkgs.visualstudio.com`);
    }
    expect(accepted).toEqual([2, 12, 17, 25].map((host) => `ms-feed-${host}.pkgs.visualstudio.com`));
    const docs = await fs.readFile(new URL("../../docs/vm-hosting.md", import.meta.url), "utf8");
    const documented = [...docs.matchAll(/`(ms-feed-[0-9]+\.pkgs\.visualstudio\.com)`/g)].map((match) => match[1]);
    expect([...new Set(documented)], "docs/vm-hosting.md and PACKAGE_FEED_REGISTRIES must name the same hosts").toEqual(accepted);
  });

  describe("a scoped package", () => {
    const folder = "node_modules/@scope/some-package";

    it("is judged when the scope is in the folder and the file has the base name", () => {
      expect(feedTarball("@scope/some-package", "1.2.3")).toBe(`${FEED}@scope/some-package/-/some-package-1.2.3.tgz`);
      expectJudged(rawLock({ [folder]: honest("@scope/some-package", "1.2.3") }));
    });

    it.each([
      ["the scope in the file name", `${FEED}@scope/some-package/-/@scope/some-package-1.2.3.tgz`],
      ["the scope joined to the file name", `${FEED}@scope/some-package/-/scope-some-package-1.2.3.tgz`],
      ["an encoded slash", `${FEED}@scope%2fsome-package/-/some-package-1.2.3.tgz`],
      ["an encoded upper-case slash", `${FEED}@scope%2Fsome-package/-/some-package-1.2.3.tgz`],
      // The unscoped package with the same base name is another package with the same file name.
      ["no scope", `${FEED}some-package/-/some-package-1.2.3.tgz`],
      ["another scope", `${FEED}@other/some-package/-/some-package-1.2.3.tgz`],
      ["only the scope as the folder", `${FEED}@scope/-/some-package-1.2.3.tgz`],
    ])("is refused with %s", (_case, resolved) => {
      expectRefused(rawLock({ [folder]: { version: "1.2.3", resolved } }), [`${folder}: ${NOT_THE_TARBALL}`]);
    });

    it("is refused in the folder of the unscoped package with the same base name", () => {
      expectRefused(rawLock({ "node_modules/some-package": honest("@scope/some-package", "1.2.3") }), [`node_modules/some-package: ${NOT_THE_TARBALL}`]);
    });
  });

  describe("an alias", () => {
    // Copied from this repository's lock: the first alias npm wrote into it (#2294).
    const folder = "node_modules/@next/eslint-plugin-next/node_modules/fast-glob";
    const written = {
      name: "tinyglobby",
      version: "0.2.17",
      resolved: "https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/tinyglobby/-/tinyglobby-0.2.17.tgz",
      integrity: "sha1-ViqabJ6ys7Ej05cZ+a9btE/NdjE=",
      dev: true,
      license: "MIT",
      dependencies: { fdir: "^6.5.0", picomatch: "^4.0.4" },
      engines: { node: ">=12.0.0" },
    };

    it("is judged the way npm writes it: the tarball of the real name in the folder of the alias", () => {
      // The entry above it, as the real lock has one: without it npm would not count the alias as its package.
      const above = honest("@next/eslint-plugin-next", "16.3.6", { dev: true, dependencies: { "fast-glob": "3.3.1" } });
      const lock = rawLock({ "node_modules/@next/eslint-plugin-next": above, [folder]: written });
      expectJudged(lock);
      const audit = JSON.parse(auditJson([{ name: "tinyglobby", severity: "high" }]));
      audit.vulnerabilities.tinyglobby.nodes = [folder];
      expect(evaluate(lock, JSON.stringify(audit), 1).packages).toEqual([{ name: "tinyglobby", version: "0.2.17", status: "vulnerable" }]);
    });

    it("is judged when the real package is scoped and the folder is not", () => {
      expectJudged(rawLock({ "node_modules/harmless-alias": { name: "@scope/some-package", ...honest("@scope/some-package", "1.2.3") } }));
    });

    it("is refused when resolved is the tarball of the folder's name", () => {
      expectRefused(rawLock({ [folder]: { ...written, resolved: feedTarball("fast-glob", "0.2.17") } }), [`${folder}: ${NOT_THE_TARBALL}`]);
    });

    it("is refused when resolved is another version of the real package", () => {
      expectRefused(rawLock({ [folder]: { ...written, resolved: feedTarball("tinyglobby", "0.2.16") } }), [`${folder}: ${NOT_THE_TARBALL}`]);
    });
  });

  describe("the spelling of a version", () => {
    it.each([
      "1.2.3", "0.0.0", "10.20.30", "1.0.0-beta.2", "5.0.0-beta.32", "2.0.0-next.7", "1.0.0-0", "1.0.0-rc-1.x-y",
      "0.0.0-experimental-abc123-20240101", "1.0.0-RC.1", "1.0.0-0a", "1.0.0-a.0.b",
    ])("judges %s", (version) => {
      expectJudged(rawLock({ "node_modules/some-package": honest("some-package", version) }));
    });

    // Every one of these comes with the "resolved" that spells the version the same way, so only the spelling is
    // wrong. Real npm for the first four: the feed serves the tarball of 1.2.3, npm ci installs it, and for the
    // leading zeros npm audit reports nothing because it cannot read the version.
    it.each([
      "v1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2.3+build", "1.2.3+build.1", "1.2.3-beta.1+build", "1.2.3+", "V1.2.3",
      "=1.2.3", "+1.2.3", "1.2", "1", "1.2.3.4", "1.2.3-", "1.2.3-01", "1.2.3-beta.01", "1.2.3-beta..1", "1.2.3-beta.",
      "1.2.3_", "1.2.3beta", "1.2.x", "1.x.3", "latest", "1.2.3-beta_1", "00.0.0", "1.2.3-.beta",
    ])("refuses %s", (version) => {
      expectRefused(rawLock({ "node_modules/some-package": honest("some-package", version) }), [`node_modules/some-package: ${NOT_CANONICAL}`]);
    });

    it.each([["a number", 1], ["null", null], ["a list", ["1.2.3"]], ["missing", undefined]])("refuses a version that is %s", (_case, version) => {
      expectRefused(rawLock({ "node_modules/some-package": { version, resolved: GOOD } }), [`node_modules/some-package: ${NOT_CANONICAL}`]);
    });

    // Real npm: "06.15.3" with .../qs/-/qs-06.15.3.tgz gave 0 audit findings and installed the blocked qs 6.15.3.
    it.each(BLOCKED_DEPENDENCIES.flatMap(({ name, version }) =>
      [`0${version}`, `v${version}`, `${version}+x`].map((spelling) => ({ name, spelling }))))(
      "refuses the blocked $name spelled $spelling",
      ({ name, spelling }) => {
        expectRefused(rawLock({ [`node_modules/${name}`]: honest(name, spelling) }), [`node_modules/${name}: ${NOT_CANONICAL}`]);
      },
    );
  });

  describe("an entry without resolved", () => {
    // Copied from this repository's lock: the only entries npm wrote without "resolved". They arrive inside the
    // tarball of the package one folder up, so npm fetches nothing for them.
    const bundler = "node_modules/@tailwindcss/oxide-wasm32-wasi";
    const bundlerEntry = honest("@tailwindcss/oxide-wasm32-wasi", "4.3.3", {
      bundleDependencies: ["@napi-rs/wasm-runtime", "@emnapi/core", "tslib"],
      cpu: ["wasm32"],
      dev: true,
      optional: true,
    });
    const core = `${bundler}/node_modules/@emnapi/core`;
    const tslib = `${bundler}/node_modules/tslib`;
    const bundledEntry = (version: string) => ({ version, dev: true, inBundle: true, license: "MIT", optional: true });
    const bundle = (): Record<string, Record<string, unknown>> => ({
      [bundler]: { ...bundlerEntry },
      [core]: bundledEntry("1.11.1"),
      [tslib]: bundledEntry("2.8.1"),
    });

    it("is judged when a feed package one folder up bundles it", () => {
      const lock = rawLock(bundle());
      expectJudged(lock);
      const audit = JSON.parse(auditJson([{ name: "tslib", severity: "high" }]));
      audit.vulnerabilities.tslib.nodes = [tslib];
      expect(evaluate(lock, JSON.stringify(audit), 1).packages).toEqual([{ name: "tslib", version: "2.8.1", status: "vulnerable" }]);
    });

    it("stays blocked when it is a bundled copy of a blocked version", () => {
      const { name, version } = BLOCKED_DEPENDENCIES[0];
      const entries = bundle();
      entries[bundler].bundleDependencies = [name];
      const report = evaluate(rawLock({ [bundler]: entries[bundler], [`${bundler}/node_modules/${name}`]: bundledEntry(version) }));
      expect(report.status).toBe("rejected");
      expect(report.packages).toEqual([{ name, version, status: "blocked" }]);
    });

    // Real npm: without "resolved" npm ci fetches name@version from whatever registry is configured.
    it("is refused for an ordinary package", () => {
      expectRefused(rawLock({ "node_modules/some-package": { version: "1.2.3", integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=" } }), [`node_modules/some-package: ${NOT_BUNDLED}`]);
    });

    it.each<[string, (entries: Record<string, Record<string, unknown>>) => void, string[]]>([
      ["it has no inBundle flag", (entries) => { delete entries[tslib].inBundle; }, [tslib]],
      ["inBundle is false", (entries) => { entries[tslib].inBundle = false; }, [tslib]],
      ["inBundle is the text true", (entries) => { entries[tslib].inBundle = "true"; }, [tslib]],
      ["inBundle is 1", (entries) => { entries[tslib].inBundle = 1; }, [tslib]],
      ["the package one folder up does not name it", (entries) => { entries[bundler].bundleDependencies = ["@emnapi/core"]; }, [tslib]],
      ["the package one folder up names a longer name", (entries) => { entries[bundler].bundleDependencies = ["@emnapi/core", "tslib-extra"]; }, [tslib]],
      // npm decides by the folder: it would fetch other-package@2.8.1 into this folder from the configured registry.
      ["the package one folder up names its \"name\" and not its folder", (entries) => {
        entries[tslib].name = "other-package";
        entries[bundler].bundleDependencies = ["@emnapi/core", "other-package"];
      }, [tslib]],
      ["the package one folder up bundles nothing", (entries) => { entries[bundler].bundleDependencies = []; }, [core, tslib]],
      ["the package one folder up has no bundleDependencies", (entries) => { delete entries[bundler].bundleDependencies; }, [core, tslib]],
      ["bundleDependencies is text that contains the names", (entries) => { entries[bundler].bundleDependencies = "@emnapi/core tslib"; }, [core, tslib]],
      ["bundleDependencies is the name as text", (entries) => { entries[bundler].bundleDependencies = "tslib"; }, [core, tslib]],
      ["bundleDependencies is true", (entries) => { entries[bundler].bundleDependencies = true; }, [core, tslib]],
      ["bundleDependencies is an object", (entries) => { entries[bundler].bundleDependencies = { tslib: true, "@emnapi/core": true }; }, [core, tslib]],
      ["the list is under the other spelling", (entries) => {
        entries[bundler].bundledDependencies = entries[bundler].bundleDependencies;
        delete entries[bundler].bundleDependencies;
      }, [core, tslib]],
      ["there is no package one folder up", (entries) => { delete entries[bundler]; }, [core, tslib]],
      ["the package one folder up is not an object", (entries) => { (entries as Record<string, unknown>)[bundler] = "tslib"; }, [bundler, core, tslib]],
      ["the package one folder up has no resolved", (entries) => { delete entries[bundler].resolved; }, [bundler, core, tslib]],
      ["the package one folder up is not from the feed", (entries) => {
        entries[bundler].resolved = "https://registry.npmjs.org/@tailwindcss/oxide-wasm32-wasi/-/oxide-wasm32-wasi-4.3.3.tgz";
      }, [bundler, core, tslib]],
      ["the package one folder up has another version in resolved", (entries) => {
        entries[bundler].resolved = feedTarball("@tailwindcss/oxide-wasm32-wasi", "4.3.2");
      }, [bundler, core, tslib]],
      ["the package one folder up is a link", (entries) => { entries[bundler].link = true; }, [bundler, core, tslib]],
      ["its version is not canonical", (entries) => { entries[tslib].version = "02.8.1"; }, [tslib]],
    ])("is refused when %s", (_case, change, refused) => {
      const entries = bundle();
      change(entries);
      const lock = rawLock(entries);
      expect(formatDependencyPolicyReport(evaluate(lock))).toBe(INVALID_LOCK_OUTPUT);
      expect(packageLockProblems(lock).map((problem) => problem.slice(0, problem.indexOf(": ")))).toEqual(refused);
    });

    it("is refused with a resolved that is not the feed's, even when it is bundled", () => {
      const entries = bundle();
      entries[tslib].resolved = "https://registry.npmjs.org/tslib/-/tslib-2.8.1.tgz";
      expectRefused(rawLock(entries), [`${tslib}: ${NOT_THE_TARBALL}`]);
    });

    it("is refused at the top level", () => {
      expectRefused(rawLock({ "node_modules/tslib": bundledEntry("2.8.1") }), [`node_modules/tslib: ${NOT_BUNDLED}`]);
    });

    it("is refused at the top level when the root names it in bundleDependencies", () => {
      expectRefused(rawLock({ "node_modules/tslib": bundledEntry("2.8.1") }, { bundleDependencies: ["tslib"], resolved: GOOD }), [`node_modules/tslib: ${NOT_BUNDLED}`]);
    });

    // The folder one level up is found by cutting the path at its last "/node_modules/". A top-level entry has
    // none, and must not be matched with a neighbour whose path is the same text without the last letter.
    it("is refused at the top level next to a package whose path is one letter shorter", () => {
      expectRefused(rawLock({
        "node_modules/tsli": honest("tsli", "1.0.0", { bundleDependencies: ["tslib"] }),
        "node_modules/tslib": bundledEntry("2.8.1"),
      }), [`node_modules/tslib: ${NOT_BUNDLED}`]);
    });

    it("is refused two folders below the package that names it", () => {
      const entries = bundle();
      entries[bundler].bundleDependencies = ["@emnapi/core", "some-package", "tslib"];
      const deep = `${tslib}/node_modules/some-package`;
      expectRefused(rawLock({ ...entries, [deep]: bundledEntry("1.2.3") }), [`${deep}: ${NOT_BUNDLED}`]);
    });

    it("is refused when the package one folder up is itself bundled", () => {
      const entries = bundle();
      entries[tslib].bundleDependencies = ["some-package"];
      const deep = `${tslib}/node_modules/some-package`;
      expectRefused(rawLock({ ...entries, [deep]: bundledEntry("1.2.3") }), [`${deep}: ${NOT_BUNDLED}`]);
    });
  });

  // This repository has no workspace, no file: dependency and no link, so the lock has only the root and folders
  // under node_modules/. npm installs a link from a folder on disk, which nothing here could judge.
  describe("an entry that is not a package from the feed", () => {
    it.each([
      ["a link, the way npm writes a file: dependency", { resolved: "packages/some-package", link: true }],
      ["a link with the fields of a feed package", { ...honest("some-package", "1.2.3"), link: true }],
      ["an entry with link false", { ...honest("some-package", "1.2.3"), link: false }],
      ["an entry with link as text", { ...honest("some-package", "1.2.3"), link: "true" }],
      ["an entry with link null", { ...honest("some-package", "1.2.3"), link: null }],
    ])("refuses %s", (_case, entry) => {
      expectRefused(rawLock({ "node_modules/some-package": entry }), [`node_modules/some-package: ${A_LINK}`]);
    });

    it.each([
      "packages/some-package", "some-package", "node_modules", "node_modules\\some-package", "NODE_MODULES/some-package",
      "..", "/", " ", "__proto__", "constructor",
    ])("refuses the key %j, which is not a folder under node_modules/", (key) => {
      expectRefused(rawLock({ [key]: honest("some-package", "1.2.3") }), [`${key}: ${NOT_A_FOLDER}`]);
    });

    // npm reads a key as a path: it resolves dot segments and slashes, fills the folder that comes out and, for an
    // entry without "name", asks npm audit about that folder's name. Each key below carries the honest tarball of
    // some-package, so only the key is wrong. Real npm for the first six, with lodash 4.17.20 as the package: 0
    // audit findings, and npm ci filled node_modules/harmless (or node_modules/@types/ms, or the scoped folder)
    // with lodash 4.17.20. The fourth worked with no change to package.json, through a "dependencies" added by
    // hand to another entry. For the next five npm audit named the folder node_modules/some-package, or one
    // outside the project, which is not a key of the lock.
    it.each([
      "node_modules/some-package/../harmless",
      "node_modules/some-package/./../harmless",
      "node_modules/some-package/../@types/harmless",
      "node_modules/other-package/node_modules/some-package/../harmless",
      "node_modules/@x-node_modules/some-package",
      "node_modules/@node_modules/some-package",
      "node_modules/some-package/",
      "node_modules/some-package/.",
      "./node_modules/some-package",
      "node_modules//some-package",
      "../node_modules/some-package",
      "/node_modules/some-package",
      "C:/node_modules/some-package",
      "node_modules/some-package/harmless",
      "node_modules/some-package/node_modules",
      "node_modules/some-package/node_modules/",
      "node_modules/node_modules/some-package",
      "node_modules/node_modules/node_modules/some-package",
      "node_modules/@scope/node_modules/node_modules/some-package",
      "node_modules/other-package/NODE_MODULES/some-package",
      "node_modules/other-package\\node_modules/some-package",
      "node_modules/other-package/node_modules\\some-package",
      "node_modules/some-package\\..\\harmless",
      "node_modules/some%2Dpackage",
      "node_modules/%2E%2E/some-package",
      "node_modules/some-package%2F..%2Fharmless",
      "node_modules/@scope",
      "node_modules/@scope/",
      "node_modules/@/some-package",
      "node_modules/@scope/@other/some-package",
      "node_modules/@scope/some-package/extra",
      "node_modules/.some-package",
      "node_modules/..some-package",
      "node_modules/some-package ",
      " node_modules/some-package",
      "node_modules/some-package\n",
      "node_modules/some-package\t",
      "node_modules/some\u2010package",
      "node_modules/some-package/node_modules/..",
    ])("refuses the key %j, which npm would not read as the folder of some-package", (key) => {
      const name = key.includes("@x-node_modules") ? "@x-node_modules/some-package"
        : key.includes("@node_modules") ? "@node_modules/some-package" : null;
      // The two scoped keys are well formed: they are refused because the tarball is not the one of the scoped name.
      expectRefused(rawLock({ [key]: honest("some-package", "1.2.3") }), [`${key}: ${name ? NOT_THE_TARBALL : NOT_A_FOLDER}`]);
      if (name) expectJudged(rawLock({ [key]: honest(name, "1.2.3") }));
    });

    // The same tarball in the same lock is judged when the key is the folder npm fills.
    it.each([
      ["node_modules/some-package", "some-package"],
      ["node_modules/@scope/some-package", "@scope/some-package"],
      ["node_modules/other-package/node_modules/some-package", "some-package"],
      ["node_modules/@scope/other-package/node_modules/@scope/some-package", "@scope/some-package"],
      ["node_modules/a/node_modules/b/node_modules/c/node_modules/some-package", "some-package"],
      ["node_modules/node_modules-extra/node_modules/some-package", "some-package"],
      ["node_modules/some.package_1", "some.package_1"],
      // A few old packages have capital letters in their names. The feed tells letter case apart, so the tarball
      // must be spelled the same way.
      ["node_modules/JSONStream", "JSONStream"],
    ])("judges the key %j by its last folder, %j", (key, name) => {
      expectJudged(rawLock(withParents({ [key]: honest(name, "1.2.3") })));
      const lock = rawLock(withParents({ [key]: honest(BLOCKED_DEPENDENCIES[0].name, BLOCKED_DEPENDENCIES[0].version) }));
      expect(evaluate(lock).status).toBe("invalid_lock");
    });

    it("refuses a capital letter in the folder when the tarball is spelled without it", () => {
      expectRefused(rawLock({ "node_modules/Some-Package": honest("some-package", "1.2.3") }), [`node_modules/Some-Package: ${NOT_THE_TARBALL}`]);
    });

    it("refuses a folder name longer than a package name can be, also behind a valid \"name\"", () => {
      const alias = (length: number) => ({ [`node_modules/${"a".repeat(length)}`]: { name: "some-package", ...honest("some-package", "1.2.3") } });
      expectJudged(rawLock(alias(214)));
      expectRefused(rawLock(alias(215)), [`node_modules/${"a".repeat(215)}: the folder or the "name" is not a package name`]);
    });

    // The blocked list alone would catch a blocked version under such a key, because the policy reads its real
    // name. The lock is refused all the same: npm audit would be asked about another name.
    it.each(BLOCKED_DEPENDENCIES)("refuses the blocked $name $version under a key that names another folder", ({ name, version }) => {
      const key = `node_modules/${name}/../harmless`;
      expectRefused(rawLock({ [key]: honest(name, version) }), [`${key}: ${NOT_A_FOLDER}`]);
    });

    it("does not look for the bundler through a key that is not package folders", () => {
      const bundler = "node_modules/some-package";
      const key = `${bundler}/node_modules/bundled/../harmless`;
      expectRefused(rawLock({
        [bundler]: honest("some-package", "1.2.3", { bundleDependencies: ["bundled", "harmless"] }),
        [key]: { version: "1.0.0", inBundle: true },
      }), [`${key}: ${NOT_A_FOLDER}`]);
    });

    it("answers at once for a key of a million characters", () => {
      for (const key of [
        `${"node_modules/a/".repeat(70_000)}node_modules/b!`,
        `node_modules/${"a-".repeat(500_000)}/..`,
        `${`node_modules/${"a.".repeat(40)}/`.repeat(10_000)}x`,
      ]) {
        const started = performance.now();
        expect(packageLockProblems(rawLock({ [key]: honest("b", "1.0.0") }))).toEqual([`${key}: ${NOT_A_FOLDER}`]);
        expect(performance.now() - started).toBeLessThan(2_000);
      }
    });

    it("refuses the pair npm writes for a workspace or a file: dependency", () => {
      expectRefused(rawLock({
        "node_modules/some-package": { resolved: "packages/some-package", link: true },
        "packages/some-package": { version: "1.2.3" },
      }), [`node_modules/some-package: ${A_LINK}`, `packages/some-package: ${NOT_A_FOLDER}`]);
    });

    it("refuses a package in the node_modules of such a folder too", () => {
      const nested = "packages/some-package/node_modules/other-package";
      expectRefused(rawLock({
        "packages/some-package": { version: "1.2.3" },
        [nested]: honest("other-package", "1.0.0"),
      }), [`packages/some-package: ${NOT_A_FOLDER}`, `${nested}: ${NOT_A_FOLDER}`]);
    });

    it("refuses an entry that is not an object", () => {
      expectRefused(rawLock({ "node_modules/some-package": GOOD }), ["node_modules/some-package: the entry is not an object"]);
    });
  });

  it("names every refused entry, and only those", () => {
    const lock = rawLock({
      "node_modules/first": honest("first", "1.0.0"),
      "node_modules/second": { version: "1.0.0" },
      "node_modules/third": { version: "v1.0.0", resolved: feedTarball("third", "v1.0.0") },
      "node_modules/fourth": honest("fourth", "1.0.1", { version: "1.0.0" }),
      "node_modules/fifth": honest("fifth", "1.0.0"),
    });
    expectRefused(lock, [
      `node_modules/second: ${NOT_BUNDLED}`,
      `node_modules/third: ${NOT_CANONICAL}`,
      `node_modules/fourth: ${NOT_THE_TARBALL}`,
    ]);
  });

  it("says so when the file is not a lock at all", () => {
    for (const text of ["", "{", "[]", JSON.stringify({ lockfileVersion: 2, packages: { "": {} } }), JSON.stringify({ lockfileVersion: 3, packages: {} })]) {
      expect(packageLockProblems(text)).toEqual(["package-lock.json is not a version 3 lock with a root entry"]);
    }
  });

  // The release prints "Dependency preflight failed (status invalid_lock); raw output withheld." and nothing else,
  // because this report is all the preflight gives it. The reasons above exist for tests and for a terminal only.
  it("reports a refused lock with the status alone, runs no audit and prints nothing about the entry", async () => {
    const marker = "never-print-this-value";
    const lock = rawLock({ [`node_modules/${marker}`]: { version: "1.2.3", resolved: `https://user:${marker}@example.com/${marker}.tgz` } });
    expect(packageLockProblems(lock)).toHaveLength(1);

    const executor = vi.fn<AuditExecutor>().mockResolvedValue({ exitCode: 0, stdout: auditJson(), stderr: "" });
    const { report, onRetry } = await auditWith(executor, lock);
    expect(formatDependencyPolicyReport(report)).toBe(INVALID_LOCK_OUTPUT);
    expect(executor).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();

    const fixture = await fixtureDirectory(lock);
    const printed: string[] = [];
    const exitCode = await runMain(["--lock-sha256", fixture.identity, "--run-audit"], {
      cwd: fixture.directory,
      executor,
      retryDelayMs: 0,
      output: { log: (message) => printed.push(message), warn: (message) => printed.push(message) },
    });
    expect(exitCode).toBe(1);
    expect(printed).toEqual([INVALID_LOCK_OUTPUT]);
    expect(executor).not.toHaveBeenCalled();

    const auditPath = path.join(fixture.directory, "audit.json");
    await fs.writeFile(auditPath, auditJson());
    const fromFile = await evaluateTemporaryAuditFile({ auditPath, lockPath: fixture.lockPath, expectedLockSha256: fixture.identity });
    expect(formatDependencyPolicyReport(fromFile)).toBe(INVALID_LOCK_OUTPUT);
  });

  it("has no switch: neither the accepted list nor the clock nor the environment changes the answer", async () => {
    const lock = rawLock({
      "node_modules/lodash": { ...honest("lodash", "4.17.20"), version: "4.18.1", dev: true },
    });
    const listed: ListedAdvisory = { advisory: "GHSA-vfj7-8cjw-p6xm", package: "lodash", version: "4.18.1", expires: "2999-12-31", reason: "test list entry" };
    const switches = ["MARKDOC_DEPENDENCY_POLICY", "DEPENDENCY_POLICY_SKIP_RESOLVED", "PACKAGE_FEED_REGISTRIES", "npm_config_registry", "NPM_CONFIG_REPLACE_REGISTRY_HOST"];
    const before = switches.map((name) => process.env[name]);
    try {
      for (const name of switches) process.env[name] = "https://registry.npmjs.org/";
      expect(evaluateDependencyPolicy({
        expectedLockSha256: packageLockSha256(lock),
        packageLockText: lock,
        execution: { exitCode: 0, stdout: auditJson() },
        now: 0,
        acceptedAdvisories: [listed],
      })).toEqual({ status: "invalid_lock", counts: ZERO_REPORT_COUNTS, packages: [] });
    } finally {
      switches.forEach((name, index) => {
        if (before[index] === undefined) delete process.env[name];
        else process.env[name] = before[index];
      });
    }
    // The preflight has three options and passes the lock to the policy as it is; it never asks for the reasons.
    const cli = await fs.readFile(path.resolve("scripts/dependency-policy-preflight.mts"), "utf8");
    expect(cli).not.toContain("packageLockProblems");
    expect(cli.match(/type: "(?:string|boolean)"/g)).toHaveLength(3);
  });

  // The real lock, so that a pull request that changes package-lock.json finds out here and not at the next
  // release. The failure lists each refused entry with its reason.
  it("accepts every entry of this repository's package-lock.json", async () => {
    const whatToDo =
      "package-lock.json has entries the release preflight refuses; they are listed below as \"entry: reason\", and a "
      + "release would stop with the status invalid_lock. If npm itself wrote a \"resolved\" on a host of the package "
      + "feed that is not in the list yet, check that the host serves the same feed without a login, then add it to "
      + "PACKAGE_FEED_REGISTRIES in scripts/lib/dependency-policy.ts and to docs/vm-hosting.md in the same pull request. "
      + "In every other case the entry was edited by hand, or it is a kind of dependency the preflight cannot judge "
      + "(a link, a workspace, a git or file: dependency, a package that brings bundled packages its entry does not "
      + "name in \"bundleDependencies\" or that nests them), or its \"dev\" mark does not say what production needs, or "
      + "a package production needs has no entry: change the lock, not the rule.";
    const lock = await fs.readFile(new URL("../../package-lock.json", import.meta.url), "utf8");
    expect(packageLockProblems(lock), whatToDo).toEqual([]);
    expect(formatDependencyPolicyReport(evaluate(lock))).toBe(PASS_OUTPUT);
  });

  // The key rule against every key npm wrote into this repository's lock, apart from what the entries hold: each
  // key gets the honest tarball of its last folder, taken here by cutting the key at "/node_modules/".
  it("reads the last folder of every key of this repository's package-lock.json the way npm does", async () => {
    const real = JSON.parse(await fs.readFile(new URL("../../package-lock.json", import.meta.url), "utf8")) as { packages: Record<string, unknown> };
    const keys = Object.keys(real.packages).filter((key) => key !== "");
    expect(keys.length).toBeGreaterThan(900);
    const written = /^node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/;
    expect(keys.filter((key) => !written.test(key))).toEqual([]);
    expectJudged(rawLock(withParents(Object.fromEntries(keys.map((key) => [key, honest(lastFolder(key), "1.2.3")])))));
    // One wrong last folder anywhere is found: every key in turn gets the tarball of another package.
    const wrong = keys.filter((key) =>
      packageLockProblems(rawLock({ [key]: honest(`${lastFolder(key)}-other`, "1.2.3") })).join() !== `${key}: ${NOT_THE_TARBALL}`);
    expect(wrong).toEqual([]);
  });

  // npm reads npm-shrinkwrap.json instead of package-lock.json when a folder holds both. Real npm: with a
  // shrinkwrap that held lodash 4.18.1 next to a lock that held lodash 4.17.20, npm audit --package-lock-only
  // reported 0 findings, and npm ci from package.json and package-lock.json alone, which is all the Dockerfile
  // copies, installed lodash 4.17.20.
  describe("an npm-shrinkwrap.json next to the lock", () => {
    const shrinkwrapOf = (directory: string) => path.join(directory, "npm-shrinkwrap.json");

    it("refuses the lock before any audit runs, whatever the file holds", async () => {
      for (const content of [packageLock(), packageLock([{ name: "some-package", version: "1.2.3" }]), "", "{"]) {
        const fixture = await fixtureDirectory();
        await fs.writeFile(shrinkwrapOf(fixture.directory), content);
        const executor = vi.fn<AuditExecutor>().mockResolvedValue({ exitCode: 0, stdout: auditJson() });
        const report = await runDependencyAudit({ cwd: fixture.directory, lockPath: fixture.lockPath, expectedLockSha256: fixture.identity, executor });
        expect(formatDependencyPolicyReport(report)).toBe(INVALID_LOCK_OUTPUT);
        expect(executor).not.toHaveBeenCalled();
      }
    });

    it("refuses a folder of that name too", async () => {
      const fixture = await fixtureDirectory();
      await fs.mkdir(shrinkwrapOf(fixture.directory));
      const executor = vi.fn<AuditExecutor>().mockResolvedValue({ exitCode: 0, stdout: auditJson() });
      const report = await runDependencyAudit({ cwd: fixture.directory, lockPath: fixture.lockPath, expectedLockSha256: fixture.identity, executor });
      expect(formatDependencyPolicyReport(report)).toBe(INVALID_LOCK_OUTPUT);
      expect(executor).not.toHaveBeenCalled();
    });

    it("passes the same lock once the file is gone, and without it as before", async () => {
      const fixture = await fixtureDirectory();
      const executor = vi.fn<AuditExecutor>().mockResolvedValue({ exitCode: 0, stdout: auditJson() });
      const run = () => runDependencyAudit({ cwd: fixture.directory, lockPath: fixture.lockPath, expectedLockSha256: fixture.identity, executor });
      expect(formatDependencyPolicyReport(await run())).toBe(PASS_OUTPUT);
      await fs.writeFile(shrinkwrapOf(fixture.directory), packageLock());
      expect(formatDependencyPolicyReport(await run())).toBe(INVALID_LOCK_OUTPUT);
      await fs.rm(shrinkwrapOf(fixture.directory));
      expect(formatDependencyPolicyReport(await run())).toBe(PASS_OUTPUT);
      expect(executor).toHaveBeenCalledTimes(2);
    });

    it("does not mind the file in another folder", async () => {
      const fixture = await fixtureDirectory();
      await fs.mkdir(path.join(fixture.directory, "nested"));
      await fs.writeFile(shrinkwrapOf(path.join(fixture.directory, "nested")), packageLock());
      await fs.writeFile(path.join(fixture.directory, "npm-shrinkwrap.json.bak"), packageLock());
      const executor = vi.fn<AuditExecutor>().mockResolvedValue({ exitCode: 0, stdout: auditJson() });
      const report = await runDependencyAudit({ cwd: fixture.directory, lockPath: fixture.lockPath, expectedLockSha256: fixture.identity, executor });
      expect(formatDependencyPolicyReport(report)).toBe(PASS_OUTPUT);
    });

    it("stops with lock_mismatch when the file appears while the audit runs, and does not retry", async () => {
      const fixture = await fixtureDirectory();
      const executor = vi.fn<AuditExecutor>().mockImplementation(async ({ cwd }) => {
        await fs.writeFile(shrinkwrapOf(cwd), packageLock());
        return { exitCode: 1, stdout: "", stderr: "" };
      });
      const report = await runDependencyAudit({ cwd: fixture.directory, lockPath: fixture.lockPath, expectedLockSha256: fixture.identity, executor, retryDelayMs: 0 });
      expect(report.status).toBe("lock_mismatch");
      expect(executor).toHaveBeenCalledOnce();
    });

    it("refuses through the command line with the status alone, for an audit it runs and for an audit file", async () => {
      const fixture = await fixtureDirectory();
      await fs.writeFile(shrinkwrapOf(fixture.directory), packageLock());
      const executor = vi.fn<AuditExecutor>().mockResolvedValue({ exitCode: 0, stdout: auditJson() });
      const printed: string[] = [];
      const output = { log: (message: string) => printed.push(message), warn: (message: string) => printed.push(message) };
      expect(await runMain(["--lock-sha256", fixture.identity, "--run-audit"], { cwd: fixture.directory, executor, retryDelayMs: 0, output })).toBe(1);
      const auditPath = path.join(fixture.directory, "audit.json");
      await fs.writeFile(auditPath, auditJson());
      expect(await runMain(["--lock-sha256", fixture.identity, "--audit-json", auditPath], { cwd: fixture.directory, output })).toBe(1);
      expect(printed).toEqual([INVALID_LOCK_OUTPUT, INVALID_LOCK_OUTPUT]);
      expect(executor).not.toHaveBeenCalled();
      await fs.rm(shrinkwrapOf(fixture.directory));
      expect(await runMain(["--lock-sha256", fixture.identity, "--audit-json", auditPath], { cwd: fixture.directory, output })).toBe(0);
      expect(printed[2]).toBe(PASS_OUTPUT);
    });

    it("refuses the lock when it cannot tell whether the file is there", async () => {
      const fixture = await fixtureDirectory();
      const executor = vi.fn<AuditExecutor>().mockResolvedValue({ exitCode: 0, stdout: auditJson() });
      const lstat = vi.spyOn(fs, "lstat").mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
      try {
        const report = await runDependencyAudit({ cwd: fixture.directory, lockPath: fixture.lockPath, expectedLockSha256: fixture.identity, executor });
        expect(formatDependencyPolicyReport(report)).toBe(INVALID_LOCK_OUTPUT);
        expect(lstat).toHaveBeenCalledWith(shrinkwrapOf(fixture.directory));
        expect(executor).not.toHaveBeenCalled();
      } finally {
        lstat.mockRestore();
      }
    });

    it("is not in this repository", async () => {
      await expect(fs.lstat(new URL("../../npm-shrinkwrap.json", import.meta.url))).rejects.toMatchObject({ code: "ENOENT" });
    });
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

type AuditVia = string | Record<string, unknown>;

interface AuditFixtureEntry {
  name: string;
  severity: string;
  isDirect: boolean;
  via: AuditVia[];
  effects: string[];
  range: string;
  nodes: string[];
  fixAvailable: unknown;
}

interface AuditFixture {
  auditReportVersion: number;
  vulnerabilities: Record<string, AuditFixtureEntry>;
  metadata: { vulnerabilities: Record<string, number>; dependencies: Record<string, number> };
}

interface LockFixturePackage {
  name: string;
  version: string;
  flags?: Record<string, unknown>;
}

// The five lock nodes npm reported for GHSA-vfj7-8cjw-p6xm on 2026-10-03 (#2260). All are "dev": true in the lock.
const BRACES_CHAIN: LockFixturePackage[] = [
  { name: "@next/eslint-plugin-next", version: "16.3.6", flags: { dev: true } },
  { name: "braces", version: "3.0.3", flags: { dev: true } },
  { name: "eslint-config-next", version: "16.3.6", flags: { dev: true } },
  { name: "fast-glob", version: "3.3.1", flags: { dev: true } },
  { name: "micromatch", version: "4.0.8", flags: { dev: true } },
];

const BRACES_ADVISORY: Record<string, unknown> = {
  source: 1240992,
  name: "braces",
  dependency: "braces",
  title: "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
  url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
  severity: "high",
  cwe: ["CWE-674"],
  cvss: { score: 7.5, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" },
  range: "<=3.0.3",
};

// Copied from npm 11's `npm audit --package-lock-only --json` for main's lock on 2026-10-03 (#2260).
function bracesAudit(): AuditFixture {
  const fixAvailable = { name: "eslint-config-next", version: "14.2.35", isSemVerMajor: true };
  const dependent = (name: string, via: string, effects: string[], range: string, isDirect = false): AuditFixtureEntry => ({
    name,
    severity: "high",
    isDirect,
    via: [via],
    effects,
    range,
    nodes: [`node_modules/${name}`],
    fixAvailable: { ...fixAvailable },
  });
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      "@next/eslint-plugin-next": dependent("@next/eslint-plugin-next", "fast-glob", ["eslint-config-next"], ">=14.3.0-canary.0"),
      braces: {
        name: "braces",
        severity: "high",
        isDirect: false,
        via: [{ ...BRACES_ADVISORY }],
        effects: ["micromatch"],
        range: "*",
        nodes: ["node_modules/braces"],
        fixAvailable: { ...fixAvailable },
      },
      "eslint-config-next": dependent("eslint-config-next", "@next/eslint-plugin-next", [], ">=14.3.0-canary.0", true),
      "fast-glob": dependent("fast-glob", "micromatch", ["@next/eslint-plugin-next"], "*"),
      micromatch: dependent("micromatch", "braces", ["fast-glob"], ">=0.2.0"),
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 5, critical: 0, total: 5 },
      dependencies: { prod: 438, dev: 560, optional: 176, peer: 9, peerOptional: 0, total: 1037 },
    },
  };
}

// A second advisory that is in no list, shaped like the real one.
function unlistedAdvisory(name: string): Record<string, unknown> {
  return { ...BRACES_ADVISORY, source: 1, name, dependency: name, url: "https://github.com/advisories/GHSA-2222-3333-4444" };
}

function addHighEntry(audit: AuditFixture, entry: AuditFixtureEntry): void {
  audit.vulnerabilities[entry.name] = entry;
  audit.metadata.vulnerabilities.high += 1;
  audit.metadata.vulnerabilities.total += 1;
}

// The tests bring their own list and their own clock, so they do not change when the real list changes or when a
// real entry expires. This one has the values of the first real entry (#2260).
const TEST_ADVISORY: ListedAdvisory = {
  advisory: "GHSA-vfj7-8cjw-p6xm",
  package: "braces",
  version: "3.0.3",
  expires: "2026-10-17",
  reason: "test list entry",
};

// Clocks around the end of the test entry's expiry date, 2026-10-17, in UTC.
const BEFORE_EXPIRY = Date.UTC(2026, 9, 3, 13, 20);
const LAST_ACCEPTED_MOMENT = Date.UTC(2026, 9, 17, 23, 59, 59, 999);
const FIRST_REJECTED_MOMENT = Date.UTC(2026, 9, 18);

interface BracesCase {
  packages: LockFixturePackage[];
  audit: AuditFixture;
  now: number;
  advisories: ListedAdvisory[];
}

function bracesCase(): BracesCase {
  return {
    packages: BRACES_CHAIN.map((item) => ({ ...item, flags: { ...item.flags } })),
    audit: bracesAudit(),
    now: BEFORE_EXPIRY,
    advisories: [{ ...TEST_ADVISORY }],
  };
}

function lockNode(fixture: BracesCase, name: string): LockFixturePackage {
  const node = fixture.packages.find((item) => item.name === name);
  if (!node) throw new Error(`no lock fixture for ${name}`);
  return node;
}

function evaluateBraces(fixture: BracesCase, execution: Partial<AuditExecutionResult> = {}) {
  const lock = packageLock(fixture.packages);
  return evaluateDependencyPolicy({
    expectedLockSha256: packageLockSha256(lock),
    packageLockText: lock,
    // npm exits 1 when it reports findings.
    execution: { exitCode: 1, stdout: JSON.stringify(fixture.audit), ...execution },
    now: fixture.now,
    acceptedAdvisories: fixture.advisories,
  });
}

const ACCEPTED_EXCEPTION = { advisory: "GHSA-vfj7-8cjw-p6xm", package: "braces", version: "3.0.3", expires: "2026-10-17" };

// The exact bytes of the accepted report for the audit of 2026-10-03. deploy/release-vm.ps1 accepts only this shape or
// PASS_OUTPUT.
const ACCEPTED_OUTPUT =
  '{"status":"accepted","counts":{"blocked":0,"info":0,"low":0,"moderate":0,"high":5,"critical":0,"vulnerabilities":5,"reported":5,"omitted":0},'
  + '"packages":[{"name":"@next/eslint-plugin-next","version":"16.3.6","status":"dependent"},{"name":"braces","version":"3.0.3","status":"accepted"},'
  + '{"name":"eslint-config-next","version":"16.3.6","status":"dependent"},{"name":"fast-glob","version":"3.3.1","status":"dependent"},'
  + '{"name":"micromatch","version":"4.0.8","status":"dependent"}],'
  + '"exceptions":[{"advisory":"GHSA-vfj7-8cjw-p6xm","package":"braces","version":"3.0.3","expires":"2026-10-17"}]}';

// What the policy printed for the same audit before the exception list existed, and still prints when a rule fails.
const BRACES_REJECTED = {
  status: "rejected",
  counts: { ...ZERO_REPORT_COUNTS, high: 5, vulnerabilities: 5, reported: 5 },
  packages: BRACES_CHAIN.map(({ name, version }) => ({ name, version, status: "vulnerable" })),
};

function expectRejected(report: ReturnType<typeof evaluateBraces>): void {
  expect(report.status).toBe("rejected");
  expect(Object.keys(report)).toEqual(["status", "counts", "packages"]);
  expect(report.packages.length).toBeGreaterThan(0);
  expect(report.packages.every((item) => item.status === "vulnerable" || item.status === "blocked")).toBe(true);
}

describe("accepted advisories (#2260)", () => {
  // The only test that reads the real list. It checks the format of each entry, never which entries exist, so it
  // stays green when an entry is added, expires or is deleted.
  it("keeps every entry of the real list in the format the release script checks", () => {
    for (const item of ACCEPTED_ADVISORIES) {
      expect(Object.keys(item).sort()).toEqual(["advisory", "expires", "package", "reason", "version"]);
      expect(item.advisory).toMatch(ACCEPTED_ADVISORY_ID_PATTERN);
      expect(item.package).toMatch(ACCEPTED_PACKAGE_PATTERN);
      expect(item.version).toMatch(/^[0-9a-z][0-9a-z.+_-]{0,127}$/i);
      expect(item.expires).toMatch(ACCEPTED_EXPIRY_PATTERN);
      expect(new Date(`${item.expires}T00:00:00.000Z`).toISOString().slice(0, 10)).toBe(item.expires);
      expect(item.reason.length).toBeGreaterThan(0);
      expect(item.reason).not.toContain("\n");
    }
    expect(new Set(ACCEPTED_ADVISORIES.map((item) => item.advisory)).size).toBe(ACCEPTED_ADVISORIES.length);
  });

  // Built from whatever the real list holds, with the clock set from each entry, so it proves the real list is the
  // default without depending on its content. With an empty list it checks nothing.
  it("uses the real list when the caller passes none", () => {
    for (const item of ACCEPTED_ADVISORIES) {
      const lock = packageLock([{ name: item.package, version: item.version, flags: { dev: true } }]);
      const audit = JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: {
          [item.package]: {
            name: item.package,
            severity: "high",
            isDirect: false,
            via: [{ ...BRACES_ADVISORY, name: item.package, dependency: item.package, url: `https://github.com/advisories/${item.advisory}` }],
            effects: [],
            range: "*",
            nodes: [`node_modules/${item.package}`],
            fixAvailable: false,
          },
        },
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
          dependencies: { prod: 0, dev: 1, optional: 0, peer: 0, peerOptional: 0, total: 1 },
        },
      });
      const expiryStart = Date.parse(`${item.expires}T00:00:00.000Z`);
      const at = (now: number) => evaluateDependencyPolicy({
        expectedLockSha256: packageLockSha256(lock),
        packageLockText: lock,
        execution: { exitCode: 1, stdout: audit },
        now,
      });
      expect(at(expiryStart)).toMatchObject({
        status: "accepted",
        exceptions: [{ advisory: item.advisory, package: item.package, version: item.version, expires: item.expires }],
      });
      expect(at(expiryStart + 24 * 60 * 60 * 1000).status).toBe("rejected");
    }
  });

  // The table in docs/vm-hosting.md is where a person reads which advisories a release accepts, so it must hold the
  // real list row for row: an entry cannot be added, changed or brought back without its documented row. The test
  // reads no clock and needs no change when an entry and its row are added or deleted together.
  it("holds exactly the entries in the table of docs/vm-hosting.md", async () => {
    const whatToDo =
      "ACCEPTED_ADVISORIES and the table under \"Accepted advisories\" in docs/vm-hosting.md do not hold the same "
      + "entries. In the same pull request, add or remove the table row: one row per list entry, in list order, with "
      + "the advisory, package, version and expiry date each in backticks. With an empty list the only row is "
      + "\"| (no entries) | | | | |\".";
    const lines = (await fs.readFile(new URL("../../docs/vm-hosting.md", import.meta.url), "utf8")).split(/\r?\n/);
    const header = "| Advisory | Package | Version | Expires (UTC) | Reason |";
    expect(lines.filter((line) => line === header), whatToDo).toHaveLength(1);
    const rows: string[][] = [];
    for (let index = lines.indexOf(header) + 2; lines[index]?.startsWith("|"); index += 1) {
      rows.push(lines[index].split("|").slice(1, 5).map((cell) => cell.trim()));
    }
    const listed = ACCEPTED_ADVISORIES.map(({ advisory, package: name, version, expires }) =>
      [advisory, name, version, expires].map((cell) => `\`${cell}\``));
    expect(rows, whatToDo).toEqual(listed.length > 0 ? listed : [["(no entries)", "", "", ""]]);
  });

  it("rejects the same audit, exactly as before, once the list is empty", () => {
    expect(evaluateBraces({ ...bracesCase(), advisories: [] })).toEqual(BRACES_REJECTED);
  });

  it("treats an aliased node as the package named in its lock entry", () => {
    const fixture = bracesCase();
    const node = lockNode(fixture, "braces");
    node.name = "harmless-alias";
    node.flags = { name: "braces", dev: true };
    fixture.audit.vulnerabilities.braces.nodes = ["node_modules/harmless-alias"];
    expect(formatDependencyPolicyReport(evaluateBraces(fixture))).toBe(ACCEPTED_OUTPUT);
    expect(evaluateBraces({ ...fixture, advisories: [] })).toEqual(BRACES_REJECTED);
  });

  it.each<[string, Partial<ListedAdvisory>]>([
    ["another advisory", { advisory: "GHSA-2222-3333-4444" }],
    ["another package", { package: "micromatch" }],
    ["another version", { version: "3.0.2" }],
    ["a day that does not exist", { expires: "2026-02-30" }],
    ["a day that does not exist and would fall after the clock", { expires: "2027-02-30" }],
    ["a month that does not exist", { expires: "2026-13-01" }],
    ["a date with a time", { expires: "2026-10-17T23:59:59Z" }],
    ["a date in another order", { expires: "17-10-2026" }],
    ["an empty date", { expires: "" }],
    ["an advisory id in upper case", { advisory: "GHSA-VFJ7-8CJW-P6XM" }],
  ])("rejects, exactly as before, when the list entry has %s", (_case, change) => {
    expect(evaluateBraces({ ...bracesCase(), advisories: [{ ...TEST_ADVISORY, ...change }] })).toEqual(BRACES_REJECTED);
  });

  it("rejects an advisory id that does not fit the pattern even when the audit carries the same text", () => {
    const fixture = bracesCase();
    fixture.advisories = [{ ...TEST_ADVISORY, advisory: "GHSA-vfj7-8cjw-p6xm; package=other" }];
    fixture.audit.vulnerabilities.braces.via = [{ ...BRACES_ADVISORY, url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm; package=other" }];
    expect(evaluateBraces(fixture)).toEqual(BRACES_REJECTED);
  });

  it("reports two listed advisories on one package in list order, and only the entries the audit matched", () => {
    const fixture = bracesCase();
    const second = { ...TEST_ADVISORY, advisory: "GHSA-2222-3333-4444", expires: "2026-10-20" };
    const unused = { ...TEST_ADVISORY, advisory: "GHSA-5555-6666-7777", package: "picomatch" };
    fixture.advisories = [second, unused, { ...TEST_ADVISORY }];
    fixture.audit.vulnerabilities.braces.via.push(unlistedAdvisory("braces"));
    const report = evaluateBraces(fixture);
    expect(report.status).toBe("accepted");
    expect(report.exceptions).toEqual([
      { advisory: "GHSA-2222-3333-4444", package: "braces", version: "3.0.3", expires: "2026-10-20" },
      ACCEPTED_EXCEPTION,
    ]);
    // The earlier of the two expiry dates decides.
    expect(evaluateBraces({ ...fixture, now: FIRST_REJECTED_MOMENT })).toEqual(BRACES_REJECTED);
  });

  it.each([0, 1])("accepts today's real audit and reports the exception (npm exit %i)", (exitCode) => {
    const report = evaluateBraces(bracesCase(), { exitCode });
    expect(report).toEqual({
      status: "accepted",
      counts: { ...ZERO_REPORT_COUNTS, high: 5, vulnerabilities: 5, reported: 5 },
      packages: BRACES_CHAIN.map(({ name, version }) => ({ name, version, status: name === "braces" ? "accepted" : "dependent" })),
      exceptions: [ACCEPTED_EXCEPTION],
    });
    expect(Object.keys(report)).toEqual(["status", "counts", "packages", "exceptions"]);
    expect(formatDependencyPolicyReport(report)).toBe(ACCEPTED_OUTPUT);
    expect(Buffer.byteLength(ACCEPTED_OUTPUT, "utf8")).toBeLessThanOrEqual(8192);
  });

  it("puts nothing from the advisory text or the list's reason in the accepted report", () => {
    const output = formatDependencyPolicyReport(evaluateBraces(bracesCase()));
    expect(output).not.toContain("stack-exhaustion");
    expect(output).not.toContain("github.com");
    expect(output).not.toContain("CVSS");
    expect(output).not.toContain("reason");
    expect(output).not.toContain("linter");
  });

  it("accepts up to the last millisecond of the expiry date in UTC and rejects from the next day on", () => {
    expect(formatDependencyPolicyReport(evaluateBraces({ ...bracesCase(), now: LAST_ACCEPTED_MOMENT }))).toBe(ACCEPTED_OUTPUT);
    expect(evaluateBraces({ ...bracesCase(), now: FIRST_REJECTED_MOMENT })).toEqual(BRACES_REJECTED);
    expect(evaluateBraces({ ...bracesCase(), now: Date.UTC(2027, 0, 1) })).toEqual(BRACES_REJECTED);
  });

  it("rejects when the clock is not a number", () => {
    expect(evaluateBraces({ ...bracesCase(), now: Number.NaN })).toEqual(BRACES_REJECTED);
  });

  it.each<[string, (fixture: BracesCase) => void]>([
    ["the braces node has no dev flag", (fixture) => { lockNode(fixture, "braces").flags = {}; }],
    ["a dependent node has no dev flag", (fixture) => { lockNode(fixture, "micromatch").flags = {}; }],
    ["the direct dependency has no dev flag", (fixture) => { lockNode(fixture, "eslint-config-next").flags = {}; }],
    ["the braces node is only devOptional", (fixture) => { lockNode(fixture, "braces").flags = { devOptional: true }; }],
    ["the braces dev flag is false", (fixture) => { lockNode(fixture, "braces").flags = { dev: false }; }],
    ["the braces dev flag is the text \"true\"", (fixture) => { lockNode(fixture, "braces").flags = { dev: "true" }; }],
  ])("rejects, exactly as before, when %s", (_case, change) => {
    const fixture = bracesCase();
    change(fixture);
    expect(evaluateBraces(fixture)).toEqual(BRACES_REJECTED);
  });

  it.each<[string, (fixture: BracesCase) => void]>([
    ["braces has a second advisory that is not listed", ({ audit }) => {
      audit.vulnerabilities.braces.via.push(unlistedAdvisory("braces"));
    }],
    ["the only advisory on braces is not listed", ({ audit }) => {
      audit.vulnerabilities.braces.via = [unlistedAdvisory("braces")];
    }],
    ["another package has an advisory that is not listed", ({ packages, audit }) => {
      packages.push({ name: "unsafe-package", version: "1.2.3", flags: { dev: true } });
      addHighEntry(audit, {
        name: "unsafe-package",
        severity: "high",
        isDirect: false,
        via: [unlistedAdvisory("unsafe-package")],
        effects: [],
        range: "<99.0.0",
        nodes: ["node_modules/unsafe-package"],
        fixAvailable: false,
      });
    }],
    ["another package carries the listed advisory URL", ({ packages, audit }) => {
      packages.push({ name: "unsafe-package", version: "3.0.3", flags: { dev: true } });
      addHighEntry(audit, {
        name: "unsafe-package",
        severity: "high",
        isDirect: false,
        via: [{ ...BRACES_ADVISORY, name: "unsafe-package", dependency: "unsafe-package" }],
        effects: [],
        range: "<99.0.0",
        nodes: ["node_modules/unsafe-package"],
        fixAvailable: false,
      });
    }],
    ["a dependent also has its own advisory", ({ audit }) => {
      audit.vulnerabilities.micromatch.via.push(unlistedAdvisory("micromatch"));
    }],
    ["a dependent carries a copy of the listed advisory", ({ audit }) => {
      audit.vulnerabilities.micromatch.via.push({ ...BRACES_ADVISORY });
    }],
    ["the listed advisory names another package", ({ audit }) => {
      audit.vulnerabilities.braces.via = [{ ...BRACES_ADVISORY, name: "micromatch" }];
    }],
    ["the lock has a different braces version", (fixture) => { lockNode(fixture, "braces").version = "3.0.2"; }],
    ["one of two reported braces nodes has a different version", ({ packages, audit }) => {
      packages.push({ name: "micromatch/node_modules/braces", version: "3.0.2", flags: { dev: true } });
      audit.vulnerabilities.braces.nodes.push("node_modules/micromatch/node_modules/braces");
    }],
    // The lock is checked directly: a braces node that npm left out of its report still counts.
    ["the lock has another braces node without a dev flag that npm does not report", ({ packages }) => {
      packages.push({ name: "glob-parent", version: "5.1.2", flags: { dependencies: { braces: "3.0.3" } } });
      packages.push({ name: "glob-parent/node_modules/braces", version: "3.0.3" });
    }],
    ["the lock has another braces node at a different version that npm does not report", ({ packages }) => {
      packages.push({ name: "glob-parent", version: "5.1.2", flags: { dev: true, dependencies: { braces: "3.0.2" } } });
      packages.push({ name: "glob-parent/node_modules/braces", version: "3.0.2", flags: { dev: true } });
    }],
    // An alias carries the real name in its lock entry (#2294): it is a braces node whatever its folder is called.
    ["the lock has an aliased braces node without a dev flag that npm does not report", ({ packages }) => {
      packages.push({ name: "harmless-alias", version: "3.0.3", flags: { name: "braces" } });
    }],
    ["the lock has an aliased braces node at a different version that npm does not report", ({ packages }) => {
      packages.push({ name: "harmless-alias", version: "3.0.2", flags: { name: "braces", dev: true } });
    }],
    // The other direction: a braces folder stays a braces node whatever name its lock entry claims.
    ["the lock has a braces folder that claims another name, without a dev flag", ({ packages }) => {
      packages.push({ name: "glob-parent", version: "5.1.2", flags: { dependencies: { braces: "3.0.3" } } });
      packages.push({ name: "glob-parent/node_modules/braces", version: "3.0.3", flags: { name: "another-package" } });
    }],
    ["the lock has a braces folder that claims another name, at a different version", ({ packages }) => {
      packages.push({ name: "glob-parent", version: "5.1.2", flags: { dev: true, dependencies: { braces: "3.0.2" } } });
      packages.push({ name: "glob-parent/node_modules/braces", version: "3.0.2", flags: { name: "another-package", dev: true } });
    }],
    ["a dependent names a package that is not in the audit", ({ audit }) => {
      audit.vulnerabilities.micromatch.via = ["picomatch"];
    }],
    ["a dependent names a package that is not in the audit next to an accepted one", ({ audit }) => {
      audit.vulnerabilities.micromatch.via = ["braces", "picomatch"];
    }],
    ["a dependent names only itself", ({ audit }) => {
      audit.vulnerabilities.micromatch.via = ["micromatch"];
    }],
    ["two dependents name only each other", ({ audit }) => {
      audit.vulnerabilities.micromatch.via = ["fast-glob"];
    }],
    ["the advisory URL uses http", ({ audit }) => {
      audit.vulnerabilities.braces.via = [{ ...BRACES_ADVISORY, url: "http://github.com/advisories/GHSA-vfj7-8cjw-p6xm" }];
    }],
    ["the advisory URL has text after the id", ({ audit }) => {
      audit.vulnerabilities.braces.via = [{ ...BRACES_ADVISORY, url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm/" }];
    }],
    ["the advisory URL has the id in upper case", ({ audit }) => {
      audit.vulnerabilities.braces.via = [{ ...BRACES_ADVISORY, url: "https://github.com/advisories/GHSA-VFJ7-8CJW-P6XM" }];
    }],
    ["the advisory URL is on another host", ({ audit }) => {
      audit.vulnerabilities.braces.via = [{ ...BRACES_ADVISORY, url: "https://registry.invalid/advisories/GHSA-vfj7-8cjw-p6xm" }];
    }],
    ["the advisory URL is null", ({ audit }) => {
      audit.vulnerabilities.braces.via = [{ ...BRACES_ADVISORY, url: null }];
    }],
    ["the advisory URL is missing", ({ audit }) => {
      audit.vulnerabilities.braces.via = [withoutKey(BRACES_ADVISORY, "url")];
    }],
    ["braces is reported as critical", ({ audit }) => {
      audit.vulnerabilities.braces.severity = "critical";
      audit.vulnerabilities.braces.via = [{ ...BRACES_ADVISORY, severity: "critical" }];
      audit.metadata.vulnerabilities.high = 4;
      audit.metadata.vulnerabilities.critical = 1;
    }],
    ["only the advisory object says critical", ({ audit }) => {
      audit.vulnerabilities.braces.via = [{ ...BRACES_ADVISORY, severity: "critical" }];
    }],
    ["a dependent is reported as critical", ({ audit }) => {
      audit.vulnerabilities.micromatch.severity = "critical";
      audit.metadata.vulnerabilities.high = 4;
      audit.metadata.vulnerabilities.critical = 1;
    }],
    ["a blocked dependency is in the lock", ({ packages }) => {
      packages.push({ name: BLOCKED_DEPENDENCIES[0].name, version: BLOCKED_DEPENDENCIES[0].version, flags: { dev: true } });
    }],
  ])("rejects when %s", (_case, change) => {
    const fixture = bracesCase();
    change(fixture);
    const report = evaluateBraces(fixture);
    expectRejected(report);
    expect(formatDependencyPolicyReport(report)).not.toContain("exceptions");
  });

  it("reports a blocked dependency next to the chain as blocked, with the chain as vulnerable", () => {
    const fixture = bracesCase();
    fixture.packages.push({ name: "qs", version: "6.15.3" });
    const report = evaluateBraces(fixture);
    expect(report.status).toBe("rejected");
    expect(report.counts).toEqual({ ...ZERO_REPORT_COUNTS, blocked: 1, high: 5, vulnerabilities: 5, reported: 6 });
    expect(report.packages).toContainEqual({ name: "qs", version: "6.15.3", status: "blocked" });
  });

  it("rejects a chain with more nodes than the report can list", () => {
    const fixture = bracesCase();
    for (let index = 0; index < MAX_REPORTED_PACKAGES - BRACES_CHAIN.length + 1; index += 1) {
      const name = `dependent-${String(index).padStart(2, "0")}`;
      fixture.packages.push({ name, version: "1.0.0", flags: { dev: true } });
      addHighEntry(fixture.audit, {
        name,
        severity: "high",
        isDirect: false,
        via: ["braces"],
        effects: [],
        range: "*",
        nodes: [`node_modules/${name}`],
        fixAvailable: false,
      });
    }
    const report = evaluateBraces(fixture);
    expectRejected(report);
    expect(report.counts).toMatchObject({ vulnerabilities: MAX_REPORTED_PACKAGES + 1, reported: MAX_REPORTED_PACKAGES, omitted: 1 });
  });

  it("accepts a chain that fills the report exactly", () => {
    const fixture = bracesCase();
    for (let index = 0; index < MAX_REPORTED_PACKAGES - BRACES_CHAIN.length; index += 1) {
      const name = `dependent-${String(index).padStart(2, "0")}`;
      fixture.packages.push({ name, version: "1.0.0", flags: { dev: true } });
      addHighEntry(fixture.audit, {
        name,
        severity: "high",
        isDirect: false,
        via: ["braces", "micromatch"],
        effects: [],
        range: "*",
        nodes: [`node_modules/${name}`],
        fixAvailable: false,
      });
    }
    const report = evaluateBraces(fixture);
    expect(report.status).toBe("accepted");
    expect(report.counts).toEqual({ ...ZERO_REPORT_COUNTS, high: MAX_REPORTED_PACKAGES, vulnerabilities: MAX_REPORTED_PACKAGES, reported: MAX_REPORTED_PACKAGES });
    expect(report.exceptions).toEqual([ACCEPTED_EXCEPTION]);
  });

  it("never accepts a report from an attempt that timed out", () => {
    expect(evaluateBraces(bracesCase(), { exitCode: null, stopped: "timeout" }).status).toBe("malformed_audit");
    expect(evaluateBraces({ ...bracesCase(), now: FIRST_REJECTED_MOMENT }, { exitCode: null, stopped: "timeout" }))
      .toEqual(BRACES_REJECTED);
  });

  it("keeps the plain pass report byte for byte, whatever the clock and the lock's dev flags", () => {
    const lock = packageLock(BRACES_CHAIN);
    for (const now of [BEFORE_EXPIRY, FIRST_REJECTED_MOMENT]) {
      const report = evaluateDependencyPolicy({
        expectedLockSha256: packageLockSha256(lock),
        packageLockText: lock,
        execution: { exitCode: 0, stdout: auditJson() },
        now,
      });
      expect(formatDependencyPolicyReport(report)).toBe(PASS_OUTPUT);
    }
  });

  async function runBracesCli(now: number, extraArguments: string[] = []) {
    const fixture = await fixtureDirectory(packageLock(BRACES_CHAIN));
    const messages: string[] = [];
    const warnings: string[] = [];
    const executor = vi.fn<AuditExecutor>().mockResolvedValue({ exitCode: 1, stdout: JSON.stringify(bracesAudit()), stderr: "" });
    const exitCode = await runMain(["--lock-sha256", fixture.identity, "--run-audit", ...extraArguments], {
      cwd: fixture.directory,
      executor,
      now,
      acceptedAdvisories: [{ ...TEST_ADVISORY }],
      retryDelayMs: 0,
      output: { log: (message) => messages.push(message), warn: (message) => warnings.push(message) },
    });
    return { exitCode, messages, warnings, executor };
  }

  it("makes the CLI print exactly the accepted report and exit 0", async () => {
    const result = await runBracesCli(BEFORE_EXPIRY);
    expect(result.exitCode).toBe(0);
    expect(result.messages).toEqual([ACCEPTED_OUTPUT]);
    expect(result.warnings).toEqual([]);
    expect(result.executor).toHaveBeenCalledOnce();
  });

  it("makes the CLI print the rejected report and exit 1 after the expiry date", async () => {
    const result = await runBracesCli(FIRST_REJECTED_MOMENT);
    expect(result.exitCode).toBe(1);
    expect(result.messages.map((message) => JSON.parse(message))).toEqual([BRACES_REJECTED]);
    expect(result.executor).toHaveBeenCalledOnce();
  });

  it.each([
    ["--now", String(BEFORE_EXPIRY)],
    ["--accept", "GHSA-2222-3333-4444"],
    ["--expires", "2099-01-01"],
    ["--omit", "dev"],
  ])("gives the command line no option to set the clock or widen the list (%s)", async (...extraArguments) => {
    const result = await runBracesCli(FIRST_REJECTED_MOMENT, extraArguments);
    expect(result.exitCode).toBe(1);
    expect(result.messages.map((message) => JSON.parse(message))).toEqual([
      { status: "invalid_request", counts: ZERO_REPORT_COUNTS, packages: [] },
    ]);
    expect(result.executor).not.toHaveBeenCalled();
  });

  it("applies the same rule to a caller-supplied audit file", async () => {
    const fixture = await fixtureDirectory(packageLock(BRACES_CHAIN));
    const auditPath = path.join(fixture.directory, "audit.json");
    await fs.writeFile(auditPath, JSON.stringify(bracesAudit()));
    for (const [now, expected] of [[BEFORE_EXPIRY, "accepted"], [FIRST_REJECTED_MOMENT, "rejected"]] as const) {
      // The file must look fresh to the same clock that decides the expiry.
      await fs.utimes(auditPath, new Date(now), new Date(now));
      await expect(evaluateTemporaryAuditFile({
        auditPath,
        lockPath: fixture.lockPath,
        expectedLockSha256: fixture.identity,
        now,
        acceptedAdvisories: [{ ...TEST_ADVISORY }],
      })).resolves.toMatchObject({ status: expected });
    }
  });

  it("exits 1 for every status other than pass and accepted", async () => {
    const clean = { exitCode: 0, stdout: auditJson(), stderr: "" };
    const seen = new Map<string, number>();
    const run = async (options: {
      lock?: string;
      execution?: AuditExecutionResult;
      argumentsFor?: (identity: string, directory: string) => string[] | Promise<string[]>;
    }) => {
      const fixture = await fixtureDirectory(options.lock ?? packageLock(BRACES_CHAIN));
      const messages: string[] = [];
      const argv = await (options.argumentsFor ?? ((identity) => ["--lock-sha256", identity, "--run-audit"]))(fixture.identity, fixture.directory);
      const exitCode = await runMain(argv, {
        cwd: fixture.directory,
        executor: vi.fn<AuditExecutor>().mockResolvedValue(options.execution ?? clean),
        now: BEFORE_EXPIRY,
        acceptedAdvisories: [{ ...TEST_ADVISORY }],
        retryDelayMs: 0,
        output: { log: (message) => messages.push(message) },
      });
      expect(messages).toHaveLength(1);
      seen.set(JSON.parse(messages[0]).status, exitCode);
    };

    await run({});
    await run({ execution: { exitCode: 1, stdout: JSON.stringify(bracesAudit()), stderr: "" } });
    await run({
      lock: packageLock([{ name: "unsafe-package", version: "1.2.3" }]),
      execution: { exitCode: 1, stdout: auditJson([{ name: "unsafe-package", severity: "high" }]), stderr: "" },
    });
    await run({ argumentsFor: (identity) => ["--lock-sha256", identity] });
    await run({ lock: "{}", argumentsFor: () => ["--lock-sha256", "0".repeat(64), "--run-audit"] });
    await run({ argumentsFor: () => ["--lock-sha256", "0".repeat(64), "--run-audit"] });
    await run({ execution: { exitCode: 0, stdout: "{", stderr: "" } });
    await run({ execution: { exitCode: 17, stdout: "", stderr: "" } });
    await run({
      argumentsFor: async (identity, directory) => {
        const auditPath = path.join(directory, "audit.json");
        await fs.writeFile(auditPath, auditJson());
        const old = new Date(BEFORE_EXPIRY - MAX_AUDIT_AGE_MS - 1_000);
        await fs.utimes(auditPath, old, old);
        return ["--lock-sha256", identity, "--audit-json", auditPath];
      },
    });

    const everyStatus: Record<DependencyPolicyStatus, number> = {
      pass: 0,
      accepted: 0,
      rejected: 1,
      invalid_request: 1,
      invalid_lock: 1,
      lock_mismatch: 1,
      malformed_audit: 1,
      command_failed: 1,
      stale_audit: 1,
    };
    expect(Object.fromEntries(seen)).toEqual(everyStatus);
  });

  it("starts the CLI with the command line alone, so a release cannot set the clock or the list", async () => {
    const source = await fs.readFile(path.resolve("scripts/dependency-policy-preflight.mts"), "utf8");
    expect(source.match(/runMain\(/g)).toHaveLength(2);
    expect(source).toContain("export async function runMain(argv: string[], dependencies: RunMainDependencies = {})");
    expect(source).toContain("process.exitCode = await runMain(process.argv.slice(2));");
    for (const file of ["scripts/dependency-policy-preflight.mts", "scripts/lib/dependency-policy.ts"]) {
      const text = await fs.readFile(path.resolve(file), "utf8");
      // The only environment reads are the ones that start npm and taskkill.
      expect(text.match(/process\.env\b/g) ?? []).toHaveLength(file.endsWith(".mts") ? 0 : 3);
    }
  });
});

// Measured with real npm 10.9.4, 10.9.9 and 11.12.1 (#2308). The image has npm 10, which leaves out of
// `npm ci --omit=dev` exactly the entries marked "dev": true. npm 11 does not read the mark: it leaves out the entries
// production does not need. Both take what the project itself needs from package.json, not from the lock's root
// entry. So the policy works out what production needs, refuses a lock whose marks disagree with that in either
// direction, and refuses a lock whose package.json needs something else.
describe("what production needs (#2308)", () => {
  type Entry = Record<string, unknown>;
  const INVALID_LOCK = { status: "invalid_lock", counts: ZERO_REPORT_COUNTS, packages: [] };
  const DEV = { dev: true };
  const markedDev = (key: string) => `${key}: the entry is marked "dev": true, but production needs it`;
  const notMarkedDev = (key: string) => `${key}: the entry is not marked "dev": true, but production does not need it`;
  const noEntry = (from: string, name: string) => `${from}: needs ${name}, which has no entry`;
  const BAD_ROOT = "the root entry has \"workspaces\", or one of its dependency records is not an object of texts";

  // A lock written out entry by entry: unlike packageLock, nothing is added to the root or to an entry.
  function lockOf(root: Entry, entries: Record<string, Entry>): string {
    return JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "fixture", version: "1.0.0", ...root },
        ...Object.fromEntries(Object.entries(entries).map(([key, entry]) => [`node_modules/${key}`, entry])),
      },
    });
  }

  // The entry of a registry package. `name` is the package, which for an alias is not the folder.
  const pkg = (name: string, extra: Entry = {}, version = "1.0.0"): Entry => ({ version, resolved: feedTarball(name, version), ...extra });
  const braces = (mark: Entry) => pkg("braces", mark, "3.0.3");

  // npm audit's report of the listed advisory on the one braces node of a fixture.
  function bracesAuditAt(node: string): string {
    return JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        braces: {
          name: "braces",
          severity: "high",
          isDirect: false,
          via: [{ ...BRACES_ADVISORY }],
          effects: [],
          range: "*",
          nodes: [`node_modules/${node}`],
          fixAvailable: false,
        },
      },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
        dependencies: { prod: 1, dev: 1, optional: 0, peer: 0, peerOptional: 0, total: 2 },
      },
    });
  }

  // The policy with the test list, which accepts the advisory on braces 3.0.3 when every rule holds.
  function judge(lock: string, node = "braces") {
    return evaluateDependencyPolicy({
      expectedLockSha256: packageLockSha256(lock),
      packageLockText: lock,
      execution: { exitCode: 1, stdout: bracesAuditAt(node) },
      now: BEFORE_EXPIRY,
      acceptedAdvisories: [{ ...TEST_ADVISORY }],
    });
  }

  const SERVER = { dependencies: { server: "1.0.0" } };
  const NEEDS_BRACES = { braces: "3.0.3" };
  const OPTIONAL_BRACES = { braces: { optional: true } };

  it("accepts a listed advisory on a package that only a devDependency leads to, as before", () => {
    const lock = lockOf({ ...SERVER, devDependencies: { linter: "1.0.0" } }, {
      server: pkg("server"),
      linter: pkg("linter", { dev: true, dependencies: NEEDS_BRACES }),
      braces: braces(DEV),
    });
    expect(packageLockProblems(lock)).toEqual([]);
    expect(judge(lock)).toEqual({
      status: "accepted",
      counts: { ...ZERO_REPORT_COUNTS, high: 1, vulnerabilities: 1, reported: 1 },
      packages: [{ name: "braces", version: "3.0.3", status: "accepted" }],
      exceptions: [ACCEPTED_EXCEPTION],
    });
  });

  // Each row is a way production reaches braces. `entries` gets the mark of the braces entry; `node` is its key.
  const PRODUCTION_REACHES: Array<[string, Entry, (mark: Entry) => Record<string, Entry>, string]> = [
    ["a dependency of the project", { dependencies: NEEDS_BRACES }, (mark) => ({ braces: braces(mark) }), "braces"],
    ["an optionalDependency of the project", { optionalDependencies: NEEDS_BRACES }, (mark) => ({ braces: braces(mark) }), "braces"],
    ["a peerDependency of the project", { peerDependencies: NEEDS_BRACES }, (mark) => ({ braces: braces(mark) }), "braces"],
    ["an optional peerDependency of the project", { peerDependencies: NEEDS_BRACES, peerDependenciesMeta: OPTIONAL_BRACES },
      (mark) => ({ braces: braces(mark) }), "braces"],
    // Real npm 10 and 11 treat a name in both records as a devDependency and leave it out. The policy does not
    // count on that: a dependency is in production.
    ["both a dependency and a devDependency of the project", { dependencies: NEEDS_BRACES, devDependencies: NEEDS_BRACES },
      (mark) => ({ braces: braces(mark) }), "braces"],
    ["a dependency of a production package", SERVER,
      (mark) => ({ server: pkg("server", { dependencies: NEEDS_BRACES }), braces: braces(mark) }), "braces"],
    ["an optionalDependency of a production package", SERVER,
      (mark) => ({ server: pkg("server", { optionalDependencies: NEEDS_BRACES }), braces: braces(mark) }), "braces"],
    ["a peerDependency of a production package", SERVER,
      (mark) => ({ server: pkg("server", { peerDependencies: NEEDS_BRACES }), braces: braces(mark) }), "braces"],
    ["an optional peerDependency of a production package", SERVER,
      (mark) => ({ server: pkg("server", { peerDependencies: NEEDS_BRACES, peerDependenciesMeta: OPTIONAL_BRACES }), braces: braces(mark) }), "braces"],
    ["three packages away from the project", SERVER, (mark) => ({
      server: pkg("server", { dependencies: { router: "1.0.0" } }),
      router: pkg("router", { optionalDependencies: { matcher: "1.0.0" } }),
      matcher: pkg("matcher", { peerDependencies: NEEDS_BRACES }),
      braces: braces(mark),
    }), "braces"],
    ["bundled inside a production package", SERVER, (mark) => ({
      server: pkg("server", { bundleDependencies: ["braces"] }),
      "server/node_modules/braces": { version: "3.0.3", inBundle: true, ...mark },
    }), "server/node_modules/braces"],
    ["in a folder below the production package that needs it", SERVER, (mark) => ({
      server: pkg("server", { dependencies: NEEDS_BRACES }),
      "server/node_modules/braces": braces(mark),
    }), "server/node_modules/braces"],
    ["one folder up from the package that needs it, and not at the top", SERVER, (mark) => ({
      server: pkg("server", { dependencies: { router: "1.0.0" } }),
      "server/node_modules/router": pkg("router", { dependencies: NEEDS_BRACES }),
      "server/node_modules/braces": braces(mark),
    }), "server/node_modules/braces"],
    ["behind an alias", { dependencies: { "harmless-alias": "npm:braces@3.0.3" } },
      (mark) => ({ "harmless-alias": { name: "braces", ...braces(mark) } }), "harmless-alias"],
    // npm keeps the packages of a folder in a map that ignores letter case, so "Braces" finds the folder braces.
    ["needed under its name in another letter case", { optionalDependencies: { Braces: "3.0.3" }, devDependencies: NEEDS_BRACES },
      (mark) => ({ braces: braces(mark) }), "braces"],
  ];

  it.each(PRODUCTION_REACHES)("never accepts a listed advisory on a package marked \"dev\": true that is %s", (_case, root, entries, node) => {
    const lie = lockOf(root, entries(DEV));
    expect(packageLockProblems(lie)).toEqual([markedDev(`node_modules/${node}`)]);
    expect(judge(lie, node)).toEqual(INVALID_LOCK);
    // With the mark taken off the lock is one npm would write. The package is in production, so the advisory
    // stops the release although it is listed.
    const truth = lockOf(root, entries({}));
    expect(packageLockProblems(truth)).toEqual([]);
    expect(judge(truth, node)).toEqual({
      status: "rejected",
      counts: { ...ZERO_REPORT_COUNTS, high: 1, vulnerabilities: 1, reported: 1 },
      packages: [{ name: "braces", version: "3.0.3", status: "vulnerable" }],
    });
  });

  // The other direction. npm 10 installs an entry without the mark, whatever leads to it.
  it("refuses a lock that leaves the mark off a package only a devDependency leads to", () => {
    const lock = lockOf({ devDependencies: { linter: "1.0.0" } }, {
      linter: pkg("linter", { dev: true, dependencies: NEEDS_BRACES }),
      braces: braces({}),
    });
    expect(packageLockProblems(lock)).toEqual([notMarkedDev("node_modules/braces")]);
    expect(judge(lock)).toEqual(INVALID_LOCK);
    expect(evaluate(lock)).toEqual(INVALID_LOCK);
  });

  it("refuses an entry that nothing leads to unless it is marked \"dev\": true", () => {
    const stray = (mark: Entry) => lockOf(SERVER, { server: pkg("server"), stray: pkg("stray", mark) });
    expect(packageLockProblems(stray({}))).toEqual([notMarkedDev("node_modules/stray")]);
    expect(evaluate(stray({}))).toEqual(INVALID_LOCK);
    // Marked, npm 10 leaves it out for the mark and npm 11 because nothing needs it.
    expect(packageLockProblems(stray(DEV))).toEqual([]);
    expect(formatDependencyPolicyReport(evaluate(stray(DEV)))).toBe(PASS_OUTPUT);
  });

  it("names every entry whose mark disagrees, in both directions at once", () => {
    const lock = lockOf({ ...SERVER, devDependencies: { linter: "1.0.0" } }, { server: pkg("server", DEV), linter: pkg("linter") });
    expect(packageLockProblems(lock)).toEqual([markedDev("node_modules/server"), notMarkedDev("node_modules/linter")]);
    expect(evaluate(lock)).toEqual(INVALID_LOCK);
  });

  it.each([true, 1, "true", {}])("takes only the mark \"dev\": true for a mark, not %j", (dev) => {
    const marked = lockOf({ devDependencies: { linter: "1.0.0" } }, { linter: pkg("linter", { dev }) });
    expect(packageLockProblems(marked)).toEqual(dev === true ? [] : [notMarkedDev("node_modules/linter")]);
  });

  describe("the nearest folder going up", () => {
    // Two copies of shared: the one below server is production's, the one at the top is the linter's.
    const twoCopies = (below: Entry, top: Entry) => lockOf({ ...SERVER, devDependencies: { linter: "1.0.0" } }, {
      server: pkg("server", { dependencies: { shared: "2.0.0" } }),
      "server/node_modules/shared": pkg("shared", below, "2.0.0"),
      linter: pkg("linter", { dev: true, dependencies: { shared: "1.0.0" } }),
      shared: pkg("shared", top),
    });

    it("gives a package the copy in its own node_modules folder and leaves the copy at the top to the others", () => {
      expect(packageLockProblems(twoCopies({}, DEV))).toEqual([]);
      expect(formatDependencyPolicyReport(evaluate(twoCopies({}, DEV)))).toBe(PASS_OUTPUT);
      expect(packageLockProblems(twoCopies(DEV, {}))).toEqual([
        markedDev("node_modules/server/node_modules/shared"),
        notMarkedDev("node_modules/shared"),
      ]);
    });

    it("goes up one folder at a time, past folders that do not hold the name", () => {
      const lock = (middle: Entry, top: Entry) => lockOf({ dependencies: { a: "1.0.0" }, devDependencies: { shared: "1.0.0" } }, {
        a: pkg("a", { dependencies: { b: "1.0.0" } }),
        "a/node_modules/b": pkg("b", { dependencies: { c: "1.0.0" } }),
        "a/node_modules/b/node_modules/c": pkg("c", { dependencies: { shared: "2.0.0" } }),
        "a/node_modules/shared": pkg("shared", middle, "2.0.0"),
        shared: pkg("shared", top),
      });
      expect(packageLockProblems(lock({}, DEV))).toEqual([]);
      expect(packageLockProblems(lock(DEV, {}))).toEqual([markedDev("node_modules/a/node_modules/shared"), notMarkedDev("node_modules/shared")]);
    });

    // A walk that went from an entry's own folder straight to the first folder under the top passed every other
    // test and the real lock; it takes the copy further up for production's.
    it("takes the nearer of two copies above an entry, not the one further up", () => {
      const lock = (near: Entry, far: Entry) => lockOf({ dependencies: { a: "1.0.0" } }, {
        a: pkg("a", { dependencies: { b: "1.0.0" } }),
        "a/node_modules/b": pkg("b", { dependencies: { c: "1.0.0" } }),
        "a/node_modules/b/node_modules/c": pkg("c", { dependencies: { shared: "2.0.0" } }),
        "a/node_modules/b/node_modules/shared": pkg("shared", near, "2.0.0"),
        "a/node_modules/shared": pkg("shared", far),
      });
      expect(packageLockProblems(lock({}, DEV))).toEqual([]);
      expect(packageLockProblems(lock(DEV, {}))).toEqual([
        markedDev("node_modules/a/node_modules/b/node_modules/shared"),
        notMarkedDev("node_modules/a/node_modules/shared"),
      ]);
    });

    it("finds a scoped package below a scoped package", () => {
      const lock = (mark: Entry) => lockOf({ dependencies: { "@scope/server": "1.0.0" } }, {
        "@scope/server": pkg("@scope/server", { dependencies: { "@scope/shared": "1.0.0" } }),
        "@scope/server/node_modules/@scope/shared": pkg("@scope/shared", mark),
      });
      expect(packageLockProblems(lock({}))).toEqual([]);
      expect(packageLockProblems(lock(DEV))).toEqual([markedDev("node_modules/@scope/server/node_modules/@scope/shared")]);
    });

    it("does not look in the folder of another package", () => {
      const lock = lockOf({ dependencies: { server: "1.0.0", other: "1.0.0" } }, {
        server: pkg("server", { dependencies: { shared: "1.0.0" } }),
        other: pkg("other", { dependencies: { shared: "1.0.0" } }),
        "other/node_modules/shared": pkg("shared"),
      });
      expect(packageLockProblems(lock)).toEqual([noEntry("node_modules/server", "shared")]);
      expect(evaluate(lock)).toEqual(INVALID_LOCK);
    });
  });

  describe("a name without an entry", () => {
    it.each<[string, Entry, Record<string, Entry>, string]>([
      ["a dependency of the project", { dependencies: { missing: "1.0.0" } }, {}, "the root entry"],
      ["a peerDependency of the project", { peerDependencies: { missing: "1.0.0" } }, {}, "the root entry"],
      ["a dependency of a production package", SERVER, { server: pkg("server", { dependencies: { missing: "1.0.0" } }) }, "node_modules/server"],
      ["a peerDependency of a production package", SERVER, { server: pkg("server", { peerDependencies: { missing: "1.0.0" } }) }, "node_modules/server"],
      ["a dependency that is also an optional peerDependency", SERVER, {
        server: pkg("server", { dependencies: { missing: "1.0.0" }, peerDependencies: { missing: "1.0.0" }, peerDependenciesMeta: { missing: { optional: true } } }),
      }, "node_modules/server"],
      ["a peerDependency that peerDependenciesMeta calls optional with the text \"true\"", SERVER, {
        server: pkg("server", { peerDependencies: { missing: "1.0.0" }, peerDependenciesMeta: { missing: { optional: "true" } } }),
      }, "node_modules/server"],
      ["a peerDependency whose peerDependenciesMeta is about another name", SERVER, {
        server: pkg("server", { peerDependencies: { missing: "1.0.0" }, peerDependenciesMeta: { other: { optional: true } } }),
      }, "node_modules/server"],
    ])("refuses the lock when it is %s", (_case, root, entries, from) => {
      const lock = lockOf(root, entries);
      expect(packageLockProblems(lock)).toEqual([noEntry(from, "missing")]);
      expect(evaluate(lock)).toEqual(INVALID_LOCK);
    });

    // npm leaves these out of a lock itself: an optional package for another platform, a peer nobody installed.
    it.each<[string, Entry, Record<string, Entry>]>([
      ["an optionalDependency of the project", { optionalDependencies: { missing: "1.0.0" } }, {}],
      ["an optional peerDependency of the project", { peerDependencies: { missing: "1.0.0" }, peerDependenciesMeta: { missing: { optional: true } } }, {}],
      ["an optionalDependency of a production package", SERVER, { server: pkg("server", { optionalDependencies: { missing: "1.0.0" } }) }],
      ["an optional peerDependency of a production package", SERVER, {
        server: pkg("server", { peerDependencies: { missing: "1.0.0" }, peerDependenciesMeta: { missing: { optional: true } } }),
      }],
      ["a name in both dependencies and optionalDependencies", SERVER, {
        server: pkg("server", { dependencies: { missing: "1.0.0" }, optionalDependencies: { missing: "1.0.0" } }),
      }],
      ["a package named only in bundleDependencies", SERVER, { server: pkg("server", { bundleDependencies: ["missing"] }) }],
      ["a devDependency of the project", { devDependencies: { missing: "1.0.0" } }, {}],
      ["a dependency of a package production does not need", { devDependencies: { linter: "1.0.0" } }, {
        linter: pkg("linter", { dev: true, dependencies: { missing: "1.0.0" } }),
      }],
    ])("judges the lock when it is %s", (_case, root, entries) => {
      const lock = lockOf(root, entries);
      expect(packageLockProblems(lock)).toEqual([]);
      expect(formatDependencyPolicyReport(evaluate(lock))).toBe(PASS_OUTPUT);
    });
  });

  describe("records that are not what npm writes", () => {
    it.each(["peerDependencies", "dependencies", "optionalDependencies"].flatMap((field) =>
      [[], ["braces"], "braces", null, 7, true].map((value): [string, unknown] => [field, value])))(
      "refuses a production entry whose %s is %j", (field, value) => {
        const lock = lockOf(SERVER, { server: pkg("server", { [field]: value }) });
        expect(packageLockProblems(lock)).toEqual([`node_modules/server: "${field}" is not an object`]);
        expect(evaluate(lock)).toEqual(INVALID_LOCK);
      });

    it.each(["braces", { braces: true }, null, true, 7])("refuses a production entry whose bundleDependencies is %j", (value) => {
      const lock = lockOf(SERVER, { server: pkg("server", { bundleDependencies: value }) });
      expect(packageLockProblems(lock)).toEqual(["node_modules/server: \"bundleDependencies\" is not a list"]);
      expect(evaluate(lock)).toEqual(INVALID_LOCK);
    });

    const NOT_A_NAME = ["", ".", "..", "../braces", "braces/node_modules/other", "node_modules/braces", "@scope", "a b", "braces\n", "a".repeat(215)];
    it.each(["peerDependencies", "dependencies", "optionalDependencies"].flatMap((field) =>
      NOT_A_NAME.map((name): [string, string] => [field, name])))("refuses a name in %s that is %j", (field, name) => {
      const lock = lockOf(SERVER, { server: pkg("server", { [field]: { [name]: "1.0.0" } }) });
      expect(packageLockProblems(lock)).toEqual(["node_modules/server: a dependency is not called by a package name"]);
      expect(evaluate(lock)).toEqual(INVALID_LOCK);
    });

    it.each([...NOT_A_NAME, 7, null, ["braces"]].map((name): [unknown] => [name]))("refuses a member of bundleDependencies that is %j", (name) => {
      const lock = lockOf(SERVER, { server: pkg("server", { bundleDependencies: [name] }) });
      expect(packageLockProblems(lock)).toEqual(["node_modules/server: a dependency is not called by a package name"]);
    });

    it("says so when the root entry's bundleDependencies is not a list", () => {
      expect(packageLockProblems(lockOf({ bundleDependencies: "braces" }, {}))).toEqual(["the root entry: \"bundleDependencies\" is not a list"]);
    });
  });

  describe("letter case", () => {
    it("refuses two keys that differ only by letter case", () => {
      const lock = lockOf({ dependencies: { JSONStream: "1.0.0", jsonstream: "1.0.0" } }, { JSONStream: pkg("JSONStream"), jsonstream: pkg("jsonstream") });
      expect(packageLockProblems(lock)).toEqual(["node_modules/jsonstream: another key differs only by letter case"]);
      expect(evaluate(lock)).toEqual(INVALID_LOCK);
    });

    it("refuses two keys whose folders above differ only by letter case", () => {
      const lock = lockOf({ dependencies: { Server: "1.0.0" } }, {
        Server: pkg("Server", { dependencies: { shared: "1.0.0" } }),
        "Server/node_modules/shared": pkg("shared"),
        "server/node_modules/shared": pkg("shared"),
      });
      expect(packageLockProblems(lock)).toEqual(["node_modules/server/node_modules/shared: another key differs only by letter case"]);
    });

    it("finds an entry for a dependency written in another letter case", () => {
      const lock = lockOf({ dependencies: { jsonstream: "1.0.0" } }, { JSONStream: pkg("JSONStream") });
      expect(packageLockProblems(lock)).toEqual([]);
      const nested = lockOf(SERVER, { server: pkg("server", { dependencies: { JSONStream: "1.0.0" } }), "server/node_modules/jsonstream": pkg("jsonstream") });
      expect(packageLockProblems(nested)).toEqual([]);
    });
  });

  // npm makes an entry a package of the entry whose key is, letter for letter, the folder above it. Measured with
  // real npm 10.9.4, 10.9.9 and 11.12.1: with the key node_modules/Server/node_modules/shared and no entry
  // node_modules/Server, npm gives node_modules/server the copy of shared at the top. A walk that found the copy
  // below "Server" instead called the top copy dev-only, and `npm ci --omit=dev` installed it.
  describe("a key whose folder above has no entry", () => {
    const noFolderAbove = (key: string) => `node_modules/${key}: the folder above it has no entry`;
    // server needs shared. The top copy of shared needs braces, and both are marked as if only the linter needed
    // them. `folder` is where a second copy of shared sits, which holds another package.
    const withCopyBelow = (folder: string | null) => lockOf({ ...SERVER, devDependencies: { linter: "1.0.0" } }, {
      server: pkg("server", { dependencies: { shared: "1.0.0" } }),
      ...(folder === null ? {} : { [`${folder}/node_modules/shared`]: pkg("harmless", { name: "harmless" }) }),
      linter: pkg("linter", { dev: true, dependencies: { shared: "1.0.0" } }),
      shared: pkg("shared", { dev: true, dependencies: NEEDS_BRACES }),
      braces: braces(DEV),
    });

    it.each(["Server", "SERVER", "sErver"])("never accepts a listed advisory behind a copy in the folder %s, which has no entry", (folder) => {
      const lock = withCopyBelow(folder);
      expect(packageLockProblems(lock)).toEqual([noFolderAbove(`${folder}/node_modules/shared`)]);
      expect(judge(lock)).toEqual(INVALID_LOCK);
      expect(evaluate(lock)).toEqual(INVALID_LOCK);
    });

    it("tells that lock from the two honest ones next to it", () => {
      // The copy really is below server: production gets the copy, and the top shared and braces are the linter's.
      expect(packageLockProblems(withCopyBelow("server"))).toEqual([]);
      expect(judge(withCopyBelow("server")).status).toBe("accepted");
      // No copy: production gets the top shared, so its mark and the mark of braces are false.
      expect(packageLockProblems(withCopyBelow(null))).toEqual([markedDev("node_modules/shared"), markedDev("node_modules/braces")]);
      expect(judge(withCopyBelow(null))).toEqual(INVALID_LOCK);
    });

    it.each([
      "ghost/node_modules/stray",
      "@ghost/package/node_modules/stray",
      "server/node_modules/ghost/node_modules/stray",
      "ghost/node_modules/server/node_modules/stray",
      "SERVER/node_modules/stray",
    ])("refuses the key node_modules/%s, with the mark and without it", (key) => {
      for (const mark of [{}, DEV]) {
        const lock = lockOf(SERVER, { server: pkg("server"), [key]: pkg("stray", mark) });
        expect(packageLockProblems(lock)).toEqual([noFolderAbove(key)]);
        expect(evaluate(lock)).toEqual(INVALID_LOCK);
      }
    });

    it("judges an entry three folders down when every folder above it has an entry", () => {
      const lock = lockOf({ dependencies: { a: "1.0.0" } }, {
        a: pkg("a", { dependencies: { b: "1.0.0" } }),
        "a/node_modules/b": pkg("b", { dependencies: { c: "1.0.0" } }),
        "a/node_modules/b/node_modules/c": pkg("c"),
      });
      expect(packageLockProblems(lock)).toEqual([]);
      expect(formatDependencyPolicyReport(evaluate(lock))).toBe(PASS_OUTPUT);
    });
  });

  describe("package.json next to the lock", () => {
    const ROOT: Record<string, Record<string, unknown>> = {
      dependencies: { server: "^1.0.0", router: "^1.0.0" },
      devDependencies: { linter: "^1.0.0" },
      optionalDependencies: { extra: "^1.0.0" },
      peerDependencies: { host: "^1.0.0", plugin: "^1.0.0" },
      peerDependenciesMeta: { plugin: { optional: true } },
    };
    const ENTRIES = {
      server: pkg("server"),
      router: pkg("router"),
      linter: pkg("linter", DEV),
      extra: pkg("extra"),
      host: pkg("host"),
      plugin: pkg("plugin"),
    };
    const LOCK = lockOf(ROOT, ENTRIES);
    const packageJson = (records: Entry, rest: Entry = { name: "fixture", version: "1.0.0" }) => JSON.stringify({ ...rest, ...records });

    // Runs the audit in a folder that holds the lock and the given package.json (null: none).
    async function auditBeside(file: string | null, lock = LOCK, duringAudit: (directory: string) => Promise<void> = async () => {}) {
      const fixture = await fixtureDirectory(lock, file);
      const executor = vi.fn<AuditExecutor>().mockImplementation(async ({ cwd }) => {
        await duringAudit(cwd);
        return { exitCode: 0, stdout: auditJson() };
      });
      const report = await runDependencyAudit({ cwd: fixture.directory, lockPath: fixture.lockPath, expectedLockSha256: fixture.identity, executor, retryDelayMs: 0 });
      return { report, executor, fixture };
    }

    async function expectRefusedBeside(file: string | null, lock = LOCK): Promise<void> {
      const { report, executor } = await auditBeside(file, lock);
      expect(report).toEqual(INVALID_LOCK);
      expect(executor).not.toHaveBeenCalled();
    }

    async function expectJudgedBeside(file: string, lock = LOCK): Promise<void> {
      const { report, executor } = await auditBeside(file, lock);
      expect(formatDependencyPolicyReport(report)).toBe(PASS_OUTPUT);
      expect(executor).toHaveBeenCalledOnce();
    }

    it("judges the lock when package.json needs what the lock's root entry needs", async () => {
      expect(packageLockProblems(LOCK)).toEqual([]);
      await expectJudgedBeside(packageJson(ROOT));
    });

    it("does not mind what else package.json holds", async () => {
      await expectJudgedBeside(packageJson(ROOT, {
        name: "another-name",
        version: "9.9.9",
        private: true,
        scripts: { build: "next build" },
        engines: { node: ">=22" },
        overrides: { router: "1.0.0" },
        bundleDependencies: ["linter"],
        bundledDependencies: ["linter"],
        workspace: "not the field npm reads",
      }));
    });

    it("does not mind the order of the names or of the records", async () => {
      const reversed = Object.fromEntries(Object.entries(ROOT).reverse().map(([field, record]) => [field, Object.fromEntries(Object.entries(record).reverse())]));
      expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(ROOT));
      await expectJudgedBeside(packageJson(reversed));
    });

    it("takes a missing record for an empty one, on either side", async () => {
      const few = { dependencies: { server: "^1.0.0" } };
      const lock = lockOf(few, { server: pkg("server") });
      const empty = { devDependencies: {}, optionalDependencies: {}, peerDependencies: {}, peerDependenciesMeta: {} };
      await expectJudgedBeside(packageJson({ ...few, ...empty }), lock);
      await expectJudgedBeside(packageJson(few), lockOf({ ...few, ...empty }, { server: pkg("server") }));
      await expectJudgedBeside(packageJson({}), lockOf({ dependencies: {} }, {}));
      await expectJudgedBeside(packageJson({ dependencies: {} }), lockOf({}, {}));
    });

    // Measured with real npm 10.9.9 and 11.12.1: `npm install --save-optional extra@^1` writes extra into
    // optionalDependencies of package.json, and into both dependencies (with the range from the command line) and
    // optionalDependencies of the lock's root entry. npm reads a name in both records as optional only, in either
    // file, and `npm ci` installs from that pair. The next plain `npm install` takes the name out of the root
    // entry's dependencies again.
    describe("a name in both dependencies and optionalDependencies", () => {
      const inBoth = (range: unknown) => ({ ...ROOT, dependencies: { ...ROOT.dependencies, extra: range } });

      it("judges the pair npm writes for --save-optional: the name in both records of the root entry only", async () => {
        const lock = lockOf(inBoth("^1"), ENTRIES);
        expect(packageLockProblems(lock)).toEqual([]);
        await expectJudgedBeside(packageJson(ROOT), lock);
      });

      it("judges a package.json that has the name in both records, whatever range dependencies gives it", async () => {
        await expectJudgedBeside(packageJson(inBoth("^1.0.0")));
        await expectJudgedBeside(packageJson(inBoth("^99.0.0")));
        await expectJudgedBeside(packageJson(inBoth("^2")), lockOf(inBoth("^1"), ENTRIES));
      });

      it("still compares the range optionalDependencies gives the name", async () => {
        const other = { ...inBoth("^1.0.0"), optionalDependencies: { extra: "^2.0.0" } };
        await expectRefusedBeside(packageJson(other));
        await expectRefusedBeside(packageJson(ROOT), lockOf(other, ENTRIES));
      });

      it("refuses the lock when only one side has the name in optionalDependencies", async () => {
        const dependencyOnly = { ...inBoth("^1.0.0"), optionalDependencies: {} };
        await expectRefusedBeside(packageJson(dependencyOnly), lockOf(inBoth("^1.0.0"), ENTRIES));
        await expectRefusedBeside(packageJson(inBoth("^1.0.0")), lockOf(dependencyOnly, ENTRIES));
      });

      it("still wants the value in dependencies to be a text", async () => {
        const lock = lockOf(inBoth(7), ENTRIES);
        expect(packageLockProblems(lock)).toEqual([BAD_ROOT]);
        await expectRefusedBeside(packageJson(inBoth(7)), lock);
        await expectRefusedBeside(packageJson(inBoth(7)));
      });

      // A name that devDependencies or peerDependencies also has stays a dependency: npm does not read those so.
      it.each<[string, string]>([["devDependencies", "linter"], ["peerDependencies", "host"]])(
        "does not do the same for a name in both dependencies and %s", async (_field, name) => {
          const both = { ...ROOT, dependencies: { ...ROOT.dependencies, [name]: "^1.0.0" } };
          const lock = lockOf(both, { ...ENTRIES, [name]: pkg(name) });
          expect(packageLockProblems(lock)).toEqual([]);
          await expectRefusedBeside(packageJson(ROOT), lock);
          await expectJudgedBeside(packageJson(both), lock);
        });
    });

    // Real npm 10 and 11: package.json moves a package from devDependencies to dependencies, the lock stays as it
    // was, root entry and "dev": true included, and `npm ci --omit=dev` installs the package.
    it("refuses a lock whose package.json has moved a devDependency to dependencies", async () => {
      await expectRefusedBeside(packageJson({ ...ROOT, dependencies: { ...ROOT.dependencies, linter: "^1.0.0" }, devDependencies: {} }));
    });

    it.each(Object.keys(ROOT).flatMap((field): Array<[string, string, Entry | undefined]> => {
      const record = ROOT[field];
      const [first] = Object.keys(record);
      const { [first]: removed, ...others } = record;
      const changed = field === "peerDependenciesMeta" ? { optional: false } : `${removed as string} `;
      return [
        [field, "is missing", undefined],
        [field, "is empty", {}],
        [field, "lacks a name", others],
        [field, "has one more name", { ...record, added: field === "peerDependenciesMeta" ? { optional: true } : "^1.0.0" }],
        [field, "has another value for a name", { ...record, [first]: changed }],
        [field, "has a name in another letter case", { ...others, [first.toUpperCase()]: removed }],
      ];
    }))("refuses the lock when %s in package.json %s", async (field, _case, record) => {
      await expectRefusedBeside(packageJson({ ...ROOT, [field]: record }));
    });

    it.each<[string, unknown]>([
      ["a list", []],
      ["a list of names", ["server"]],
      ["null", null],
      ["a text", "server"],
      ["a number", 7],
    ])("refuses a record in package.json that is %s, also when it would be empty", async (_case, value) => {
      const lock = lockOf({}, {});
      for (const field of Object.keys(ROOT)) await expectRefusedBeside(packageJson({ [field]: value }), lock);
      await expectJudgedBeside(packageJson({}), lock);
    });

    // The two sides hold the same record, so only its kind can refuse the lock.
    it.each(Object.keys(ROOT).flatMap((field) => [[], null, "server", 7].map((value): [string, unknown] => [field, value])))(
      "refuses the record %s when it is %j on both sides", async (field, value) => {
        const lock = lockOf({ [field]: value }, {});
        expect(packageLockProblems(lock)).toEqual([BAD_ROOT]);
        expect(evaluate(lock)).toEqual(INVALID_LOCK);
        await expectRefusedBeside(packageJson({ [field]: value }), lock);
      });

    // The two sides hold the same value, so only its kind can refuse the lock.
    it.each<[string, string, unknown]>([
      ["dependencies", "a number", 1],
      ["dependencies", "null", null],
      ["dependencies", "a list", ["^1.0.0"]],
      ["dependencies", "an object", { version: "^1.0.0" }],
      ["devDependencies", "true", true],
      ["optionalDependencies", "a number", 1],
      ["peerDependencies", "null", null],
      ["peerDependenciesMeta", "a text", "optional"],
      ["peerDependenciesMeta", "true", true],
      ["peerDependenciesMeta", "an empty object", {}],
      ["peerDependenciesMeta", "optional as a text", { optional: "true" }],
      ["peerDependenciesMeta", "optional and something else", { optional: true, other: true }],
    ])("refuses a value in %s that is %s on both sides", async (field, _case, value) => {
      const root = { [field]: { strange: value } };
      const lock = lockOf(root, {});
      expect(packageLockProblems(lock)).toEqual([BAD_ROOT]);
      expect(evaluate(lock)).toEqual(INVALID_LOCK);
      await expectRefusedBeside(packageJson(root), lock);
    });

    it.each<[string, unknown]>([["a list of folders", ["packages/*"]], ["an empty list", []], ["an object", { packages: ["packages/*"] }], ["null", null]])(
      "refuses \"workspaces\" that is %s, in package.json and in the lock's root entry", async (_case, workspaces) => {
        await expectRefusedBeside(packageJson({ ...ROOT, workspaces }));
        const lock = lockOf({ ...ROOT, workspaces }, ENTRIES);
        expect(packageLockProblems(lock)).toEqual([BAD_ROOT]);
        expect(evaluate(lock)).toEqual(INVALID_LOCK);
        await expectRefusedBeside(packageJson(ROOT), lock);
        await expectRefusedBeside(packageJson({ ...ROOT, workspaces }), lock);
      });

    it("refuses the lock when there is no package.json", async () => {
      await expectRefusedBeside(null);
      // Also when the lock's root entry needs nothing at all.
      await expectRefusedBeside(null, lockOf({}, {}));
    });

    it.each<[string, string]>([
      ["empty", ""],
      ["cut off", packageJson(ROOT).slice(0, -1)],
      ["a list", `[${packageJson(ROOT)}]`],
      ["a text", JSON.stringify(packageJson(ROOT))],
      ["null", "null"],
      ["written with a byte order mark", `\uFEFF${packageJson(ROOT)}`],
    ])("refuses the lock when package.json is %s", async (_case, file) => {
      await expectRefusedBeside(file);
    });

    it("refuses the lock when package.json is a folder", async () => {
      const fixture = await fixtureDirectory(LOCK, null);
      await fs.mkdir(path.join(fixture.directory, "package.json"));
      const executor = vi.fn<AuditExecutor>().mockResolvedValue({ exitCode: 0, stdout: auditJson() });
      const report = await runDependencyAudit({ cwd: fixture.directory, lockPath: fixture.lockPath, expectedLockSha256: fixture.identity, executor });
      expect(report).toEqual(INVALID_LOCK);
      expect(executor).not.toHaveBeenCalled();
    });

    it("reads the package.json in the lock's folder, not one above or below it", async () => {
      const fixture = await fixtureDirectory(LOCK, packageJson({}));
      await fs.mkdir(path.join(fixture.directory, "nested"));
      await fs.writeFile(path.join(fixture.directory, "nested", "package.json"), packageJson(ROOT));
      const nestedLock = path.join(fixture.directory, "nested", "package-lock.json");
      await fs.writeFile(nestedLock, LOCK);
      const executor = vi.fn<AuditExecutor>().mockResolvedValue({ exitCode: 0, stdout: auditJson() });
      const run = (lockPath: string) => runDependencyAudit({ cwd: path.dirname(lockPath), lockPath, expectedLockSha256: fixture.identity, executor });
      expect(await run(fixture.lockPath)).toEqual(INVALID_LOCK);
      expect(formatDependencyPolicyReport(await run(nestedLock))).toBe(PASS_OUTPUT);
    });

    it("refuses through the command line with the status alone, for an audit it runs and for an audit file", async () => {
      const fixture = await fixtureDirectory(LOCK, null);
      const executor = vi.fn<AuditExecutor>().mockResolvedValue({ exitCode: 0, stdout: auditJson() });
      const printed: string[] = [];
      const output = { log: (message: string) => printed.push(message), warn: (message: string) => printed.push(message) };
      const auditPath = path.join(fixture.directory, "audit.json");
      await fs.writeFile(auditPath, auditJson());
      const both = async () => [
        await runMain(["--lock-sha256", fixture.identity, "--run-audit"], { cwd: fixture.directory, executor, retryDelayMs: 0, output }),
        await runMain(["--lock-sha256", fixture.identity, "--audit-json", auditPath], { cwd: fixture.directory, output }),
      ];
      expect(await both()).toEqual([1, 1]);
      await fs.writeFile(path.join(fixture.directory, "package.json"), packageJson({ ...ROOT, devDependencies: {} }));
      expect(await both()).toEqual([1, 1]);
      expect(printed).toEqual(Array(4).fill(formatDependencyPolicyReport(INVALID_LOCK as ReturnType<typeof evaluate>)));
      expect(executor).not.toHaveBeenCalled();
      await fs.writeFile(path.join(fixture.directory, "package.json"), packageJson(ROOT));
      expect(await both()).toEqual([0, 0]);
      expect(printed.slice(4)).toEqual([PASS_OUTPUT, PASS_OUTPUT]);
    });

    describe("while the audit runs", () => {
      const file = (directory: string) => path.join(directory, "package.json");

      it.each<[string, (directory: string) => Promise<void>]>([
        ["gets another record", (directory) => fs.writeFile(file(directory), packageJson({ ...ROOT, devDependencies: {} }))],
        ["gets a field the policy does not compare", (directory) => fs.writeFile(file(directory), packageJson(ROOT, { name: "fixture", version: "1.0.0", overrides: { router: "1.0.0" } }))],
        ["gets one more space", (directory) => fs.writeFile(file(directory), `${packageJson(ROOT)} `)],
        ["is deleted", (directory) => fs.rm(file(directory))],
      ])("stops with lock_mismatch when package.json %s, and does not retry", async (_case, duringAudit) => {
        const { report, executor } = await auditBeside(packageJson(ROOT), LOCK, duringAudit);
        expect(report).toEqual({ status: "lock_mismatch", counts: ZERO_REPORT_COUNTS, packages: [] });
        expect(executor).toHaveBeenCalledOnce();
      });

      it("passes when package.json is written again with the same bytes", async () => {
        const { report } = await auditBeside(packageJson(ROOT), LOCK, (directory) => fs.writeFile(file(directory), packageJson(ROOT)));
        expect(formatDependencyPolicyReport(report)).toBe(PASS_OUTPUT);
      });

      it("stops with lock_mismatch when package.json changes during a failed attempt, before the second one", async () => {
        const fixture = await fixtureDirectory(LOCK, packageJson(ROOT));
        const executor = vi.fn<AuditExecutor>().mockImplementation(async ({ cwd }) => {
          await fs.writeFile(file(cwd), `${packageJson(ROOT)}\n`);
          return { exitCode: 1, stdout: "", stderr: "" };
        });
        const report = await runDependencyAudit({ cwd: fixture.directory, lockPath: fixture.lockPath, expectedLockSha256: fixture.identity, executor, retryDelayMs: 0 });
        expect(report.status).toBe("lock_mismatch");
        expect(executor).toHaveBeenCalledOnce();
      });
    });
  });

  describe("this repository", () => {
    const repository = fileURLToPath(new URL("../../", import.meta.url));

    // What the issue asks for: on the real lock the production set the policy works out equals npm's own marks,
    // entry by entry. packageLockProblems lists every entry on which they differ.
    it("works out, for every entry of package-lock.json, what its \"dev\" mark says", async () => {
      const text = await fs.readFile(path.join(repository, "package-lock.json"), "utf8");
      expect(packageLockProblems(text), "the \"dev\" marks of package-lock.json and what production needs differ; see docs/vm-hosting.md").toEqual([]);
      const lock = JSON.parse(text) as { packages: Record<string, { dev?: boolean }> };
      const keys = Object.keys(lock.packages).filter((key) => key !== "");
      const marked = keys.filter((key) => lock.packages[key].dev === true);
      expect(marked.length).toBeGreaterThan(300);
      expect(keys.length - marked.length).toBeGreaterThan(300);
      // The comparison has teeth on the real lock: one mark turned over, on every tenth entry in turn, is found,
      // and nothing else is.
      const wrong: string[] = [];
      for (const key of keys.filter((_key, index) => index % 10 === 0)) {
        const { dev, ...unmarked } = lock.packages[key];
        const turned = { ...lock, packages: { ...lock.packages, [key]: dev === true ? unmarked : { ...unmarked, dev: true } } };
        const expected = dev === true ? notMarkedDev(key) : markedDev(key);
        if (packageLockProblems(JSON.stringify(turned)).join() !== expected) wrong.push(key);
      }
      expect(wrong).toEqual([]);
    }, 60_000);

    it("has a package.json that needs what the root entry of package-lock.json needs", async () => {
      const lockPath = path.join(repository, "package-lock.json");
      const text = await fs.readFile(lockPath, "utf8");
      const executor = vi.fn<AuditExecutor>().mockResolvedValue({ exitCode: 0, stdout: auditJson() });
      const report = await runDependencyAudit({ cwd: repository, lockPath, expectedLockSha256: packageLockSha256(text), executor });
      expect(
        formatDependencyPolicyReport(report),
        "package.json and the root entry of package-lock.json do not need the same packages: run npm install and commit both files",
      ).toBe(PASS_OUTPUT);
    });
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

  it("takes only the validated code from npm's exact error object on stdout", () => {
    const stdout = JSON.stringify({ error: { code: "ENOLOCK", summary: "private summary", detail: "private detail" } });
    const { reason, output } = commandFailure({ exitCode: 1, stdout, stderr: "" });
    expect(reason).toBe("npm audit exit 1, npm code ENOLOCK");
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

describe("npm error-only stdout (#2202)", () => {
  const errorOnly = (code = "ENOTFOUND") => JSON.stringify({
    error: { code, summary: LETTERS_ONLY_PAT, detail: `${BASE64_AUTH}\n${BASE64_PASSWORD}` },
  });

  async function fakeNpmAudit(
    responses: AuditExecutionResult[],
    lock = packageLock(),
  ) {
    const fixture = await fixtureDirectory(lock);
    const scriptPath = path.join(fixture.directory, "fake-npm.cjs");
    await fs.writeFile(scriptPath, [
      "const fs = require('node:fs');",
      `const responses = ${JSON.stringify(responses)};`,
      "const counter = 'calls.txt';",
      "const calls = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;",
      "fs.writeFileSync(counter, String(calls + 1));",
      "const result = responses[Math.min(calls, responses.length - 1)];",
      "process.stdout.write(result.stdout);",
      "process.stderr.write(result.stderr || '');",
      "if (result.stopped === 'timeout') setInterval(() => {}, 1000);",
      "else process.exitCode = result.exitCode;",
    ].join("\n"));
    const executor: AuditExecutor = ({ args, cwd }) => runBoundedProcess(process.execPath, [scriptPath, ...args], {
      cwd, env: quietNode, timeoutMs: responses.some((response) => response.stopped === "timeout") ? 1_000 : 20_000,
    });
    const output = { log: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() };
    const exitCode = await runMain(["--run-audit", "--lock-sha256", fixture.identity], {
      cwd: fixture.directory, executor, output, retryDelayMs: 0,
    });
    const calls = Number(await fs.readFile(path.join(fixture.directory, "calls.txt"), "utf8"));
    const printed = output.log.mock.calls[0][0];
    expect(output.log).toHaveBeenCalledOnce();
    for (const text of [printed, ...output.warn.mock.calls.map(([message]) => message)]) {
      for (const secret of [LETTERS_ONLY_PAT, BASE64_AUTH, BASE64_PASSWORD]) expect(text).not.toContain(secret);
    }
    return { calls, exitCode, printed, output };
  }

  it("retries ENOTFOUND, then returns the exact pass report", async () => {
    const result = await fakeNpmAudit([
      { exitCode: 1, stdout: errorOnly() },
      { exitCode: 0, stdout: auditJson() },
    ]);
    expect(result.calls).toBe(2);
    expect(result.exitCode).toBe(0);
    expect(result.printed).toBe(PASS_OUTPUT);
    expect(result.output.warn).toHaveBeenCalledExactlyOnceWith(
      "Dependency preflight audit failed (npm audit exit 1, npm code ENOTFOUND); retrying once.",
    );
  });

  it("retries the error object, then rejects the critical null-vector advisory", async () => {
    const result = await fakeNpmAudit([
      { exitCode: 1, stdout: errorOnly() },
      { exitCode: 1, stdout: nextAudit() },
    ], NEXT_LOCK);
    expect(result.calls).toBe(2);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.printed)).toEqual(NEXT_REJECTED);
  });

  it("stops after two error objects with the exact bounded reason", async () => {
    const result = await fakeNpmAudit([{ exitCode: 1, stdout: errorOnly() }]);
    expect(result.calls).toBe(2);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.printed)).toEqual({
      status: "command_failed", counts: ZERO_REPORT_COUNTS, packages: [],
      reason: "npm audit exit 1, npm code ENOTFOUND (attempt 2 of 2)",
    });
    expect(result.output.warn).toHaveBeenCalledOnce();
  });

  it("keeps the longest valid stdout code", async () => {
    const code = `E${"X".repeat(24)}`;
    const result = await fakeNpmAudit([{ exitCode: 1, stdout: errorOnly(code) }]);
    expect(result.calls).toBe(2);
    expect(JSON.parse(result.printed).reason).toBe(`npm audit exit 1, npm code ${code} (attempt 2 of 2)`);
  });

  it.each([{}, { summary: "private", detail: "private" }])(
    "retries a string-only error object without a code: %j",
    async (error) => {
      const result = await fakeNpmAudit([{ exitCode: 1, stdout: JSON.stringify({ error }) }]);
      expect(result.calls).toBe(2);
      expect(JSON.parse(result.printed).reason).toBe("npm audit exit 1 (attempt 2 of 2)");
      expect(result.printed).not.toContain("private");
    },
  );

  it("uses a valid stdout code before stderr, falling back when the stdout code is invalid", async () => {
    for (const [stdoutCode, expected] of [["ENOTFOUND", "ENOTFOUND"], ["enotfound", "E401"]]) {
      const result = await fakeNpmAudit([{
        exitCode: 1, stdout: errorOnly(stdoutCode), stderr: "npm error code E401\n",
      }]);
      expect(result.calls).toBe(2);
      expect(JSON.parse(result.printed).reason).toBe(`npm audit exit 1, npm code ${expected} (attempt 2 of 2)`);
    }
  });

  it.each([
    "enotfound", `E${"X".repeat(25)}`, LETTERS_ONLY_PAT, BASE64_AUTH,
    BASE64_PASSWORD, FAKE_NPM_TOKEN, FAKE_GITHUB_TOKEN, "ENOTFOUND\n",
    "ENOTFOUND\r", "ENOTFOUND private", "E", "",
  ])("retries but withholds invalid stdout code %j", async (code) => {
    const result = await fakeNpmAudit([{ exitCode: 1, stdout: errorOnly(code) }]);
    expect(result.calls).toBe(2);
    expect(JSON.parse(result.printed).reason).toBe("npm audit exit 1 (attempt 2 of 2)");
    expect(result.output.warn).toHaveBeenCalledExactlyOnceWith(
      "Dependency preflight audit failed (npm audit exit 1); retrying once.",
    );
  });

  it.each(["auditReportVersion", "vulnerabilities", "metadata", "message", "unexpected"])(
    "never retries an error object with extra top-level %s",
    async (key) => {
      const result = await fakeNpmAudit([
        { exitCode: 1, stdout: JSON.stringify({ ...JSON.parse(errorOnly()), [key]: {} }) },
        { exitCode: 0, stdout: auditJson() },
      ]);
      expect(result.calls).toBe(1);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.printed)).toEqual(
        key === "auditReportVersion" || key === "vulnerabilities"
          ? { status: "malformed_audit", counts: ZERO_REPORT_COUNTS, packages: [] }
          : { status: "command_failed", counts: ZERO_REPORT_COUNTS, packages: [], reason: "npm audit exit 1" },
      );
      expect(result.output.warn).not.toHaveBeenCalled();
    },
  );

  it.each([null, [], "private", { code: "ENOTFOUND", detail: {} }, { code: 42 }])(
    "never retries an error field that is not a string-only object: %j",
    async (error) => {
      const result = await fakeNpmAudit([
        { exitCode: 1, stdout: JSON.stringify({ error }) },
        { exitCode: 0, stdout: auditJson() },
      ]);
      expect(result.calls).toBe(1);
      expect(result.exitCode).toBe(1);
      expect(result.output.warn).not.toHaveBeenCalled();
    },
  );

  it.each([["unexpected", true], ["error", { code: "EAUDIT", summary: "endpoint failed" }]])(
    "rejects a clean audit with extra top-level %s as malformed, without retry",
    async (key, value) => {
      const result = await fakeNpmAudit([
        { exitCode: 0, stdout: JSON.stringify({ ...JSON.parse(auditJson()), [String(key)]: value }) },
        { exitCode: 0, stdout: auditJson() },
      ]);
      expect(result.calls).toBe(1);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.printed)).toEqual({ status: "malformed_audit", counts: ZERO_REPORT_COUNTS, packages: [] });
      expect(result.output.warn).not.toHaveBeenCalled();
    },
  );

  it("does not retry an error-only object with a successful exit", async () => {
    const result = await fakeNpmAudit([{ exitCode: 0, stdout: errorOnly() }]);
    expect(result.calls).toBe(1);
    expect(JSON.parse(result.printed).status).toBe("malformed_audit");
  });

  it("retries an error-only object after a timeout but never passes that attempt", async () => {
    const result = await fakeNpmAudit([
      { exitCode: null, stdout: errorOnly(), stopped: "timeout" },
      { exitCode: 0, stdout: auditJson() },
    ]);
    expect(result.calls).toBe(2);
    expect(result.printed).toBe(PASS_OUTPUT);
    expect(result.output.warn).toHaveBeenCalledExactlyOnceWith(
      "Dependency preflight audit failed (npm audit timed out, npm code ENOTFOUND); retrying once.",
    );
  });

  it("never passes when both error-only attempts time out", async () => {
    const result = await fakeNpmAudit([{ exitCode: null, stdout: errorOnly(), stopped: "timeout" }]);
    expect(result.calls).toBe(2);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.printed).reason).toBe("npm audit timed out, npm code ENOTFOUND (attempt 2 of 2)");
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
