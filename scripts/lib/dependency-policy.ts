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
// A whole lock key the way npm writes it for a package it installs: package folders, each directly inside a
// node_modules folder, and nothing else. npm reads the key as a path and names the package after its last folder:
// with "node_modules/lodash/../harmless" it fills the folder "harmless" and npm audit is asked about "harmless".
// The one group is that last folder, scope included. No folder is called node_modules, so every "/node_modules/"
// in a key that fits is one of the separators.
const LOCK_FOLDER = "(?:@[0-9A-Za-z][0-9A-Za-z._-]*/)?(?!node_modules(?:/|$))[0-9A-Za-z][0-9A-Za-z._-]*";
const LOCK_KEY_PATTERN = new RegExp(`^(?:node_modules/${LOCK_FOLDER}/)*node_modules/(${LOCK_FOLDER})$`);
// The one place a locked tarball may come from: the registry of the package feed, on the four hosts that serve it
// without a login. Every "resolved" this repository's lock ever held is on one of them. The list is code: no
// environment variable, flag or option adds a host, and none turns the check in parsePackageLock off.
const PACKAGE_FEED_REGISTRIES: readonly string[] = [2, 12, 17, 25].map((host) =>
  `https://ms-feed-${host}.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/`);
// A version written the one way the registry stores it: three numbers without leading zeros and an optional
// prerelease, nothing else. The feed also answers for other spellings of a version ("v6.15.3", "06.15.3",
// "6.15.3+x" all return the tarball of 6.15.3), which neither npm audit nor BLOCKED_DEPENDENCIES would recognise.
const CANONICAL_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[a-z-][0-9a-z-]*))*)?$/i;
const VULNERABILITY_SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;
const DEPENDENCY_COUNT_FIELDS = ["prod", "dev", "optional", "peer", "peerOptional", "total"] as const;

export const BLOCKED_DEPENDENCIES = [
  { name: "fast-uri", version: "3.1.5" },
  { name: "qs", version: "6.15.3" },
] as const;

export interface AcceptedAdvisory {
  advisory: string;
  package: string;
  version: string;
  expires: string;
}

export interface ListedAdvisory extends AcceptedAdvisory {
  reason: string;
  // Only an entry that sets this may match a package that production installs. Leave it out for dev-only advisories.
  production?: true;
}

// Advisories that do not stop a release, for a limited time, because no patched version exists. The whole rule is
// in acceptedAudit below and in docs/vm-hosting.md. This list is code: a change goes through a pull request, and no
// environment variable, flag or option can add to it. Delete an entry as soon as the lock has a patched version or
// no longer has the package.
const MCP_BODY_PARSER_REASON = "No patched body-parser 2.x; reached in production via @modelcontextprotocol/sdk -> express 5. Tracked in #2391.";
const MCP_FAST_URI_REASON = "No patched fast-uri 3.x; reached in production via @modelcontextprotocol/sdk -> ajv. Tracked in #2392.";
export const ACCEPTED_ADVISORIES: readonly ListedAdvisory[] = [
  { advisory: "GHSA-27r3-jxmh-p828", package: "body-parser", version: "2.3.0", expires: "2026-11-24", reason: MCP_BODY_PARSER_REASON, production: true },
  { advisory: "GHSA-w74x-v6f9-j3xg", package: "fast-uri", version: "3.1.8", expires: "2026-11-24", reason: MCP_FAST_URI_REASON, production: true },
  { advisory: "GHSA-xhq7-xmqj-769h", package: "fast-uri", version: "3.1.8", expires: "2026-11-24", reason: MCP_FAST_URI_REASON, production: true },
  { advisory: "GHSA-wjr9-j795-jxcr", package: "fast-uri", version: "3.1.8", expires: "2026-11-24", reason: MCP_FAST_URI_REASON, production: true },
  { advisory: "GHSA-333x-w4r6-6crp", package: "fast-uri", version: "3.1.8", expires: "2026-11-24", reason: MCP_FAST_URI_REASON, production: true },
];

// What tests may set about the accepted-advisory rule: the clock that decides expiry and the list itself. These are
// function parameters only. The command line and the release never pass them, so they use the real clock and
// ACCEPTED_ADVISORIES, and no environment variable, flag or option reaches either one.
export interface AcceptanceOptions {
  now?: number;
  acceptedAdvisories?: readonly ListedAdvisory[];
}

interface Acceptance {
  now: number;
  advisories: readonly ListedAdvisory[];
}

function acceptanceFrom(options: AcceptanceOptions): Acceptance {
  return { now: options.now ?? Date.now(), advisories: options.acceptedAdvisories ?? ACCEPTED_ADVISORIES };
}

// deploy/release-vm.ps1 checks the same three patterns before it prints an accepted advisory.
export const ACCEPTED_ADVISORY_ID_PATTERN = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;
export const ACCEPTED_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export const ACCEPTED_EXPIRY_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ADVISORY_URL_PREFIX = "https://github.com/advisories/";
const DAY_MS = 24 * 60 * 60 * 1000;

export type DependencyPolicyStatus =
  | "pass"
  | "accepted"
  | "rejected"
  | "invalid_request"
  | "invalid_lock"
  | "lock_mismatch"
  | "malformed_audit"
  | "command_failed"
  | "stale_audit";

// "accepted" and "dependent" appear only in an accepted report: a node of a package with a listed advisory, and a
// node that npm reports only because it depends on such a package.
export type DependencyPackageStatus = "blocked" | "vulnerable" | "accepted" | "dependent";

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
  // exactly three keys, except an accepted report, which adds exceptions.
  reason?: string;
  // Only accepted reports carry this: the entries of ACCEPTED_ADVISORIES that the audit matched, without the reason.
  exceptions?: AcceptedAdvisory[];
}

interface LockedPackage {
  path: string;
  // The name npm audit judges the node by: the entry's "name" field when it has one, otherwise the name in its path.
  name: string;
  // The name in the node's path: the folder that `npm ci` fills and that `require` finds.
  pathName: string;
  version: string;
  // True only when the lock marks the node "dev": true. npm 10 leaves exactly these out of `npm ci --omit=dev`.
  dev: boolean;
  // True when something production needs leads to the node (productionPaths). npm 11 installs exactly these with
  // `npm ci --omit=dev`. parsePackageLock gives out no node on which the two disagree.
  production: boolean;
}

export interface PackageLockSnapshot {
  sha256: string;
  packages: readonly LockedPackage[];
  // The lock's own root entry as rootRecordsText writes it, for the comparison with package.json in readLock.
  rootRecords: string;
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

interface AuditEntry {
  name: string;
  // The advisory objects in the entry's `via`: the advisories against this package itself.
  advisories: Array<{ name: unknown; url: unknown; severity: unknown }>;
  // The package names in the entry's `via`: the vulnerable packages this one depends on.
  dependsOn: string[];
  nodes: LockedPackage[];
}

interface ParsedAudit {
  counts: AuditCounts;
  packages: LockedPackage[];
  entries: AuditEntry[];
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

// `npm ci` installs the tarball in "resolved" into the folder in the entry's path, whatever the entry's "name" and
// "version" say, while npm audit and the lists below judge the entry by those two fields. So "resolved" must be,
// character for character, the feed's address of the tarball of exactly that name and version. No URL is parsed:
// a query, a fragment, an encoded character, another letter case or a dot segment is simply another text.
function isFeedTarball(resolved: unknown, name: string, version: string): boolean {
  const tarball = `${name}/-/${name.slice(name.indexOf("/") + 1)}-${version}.tgz`;
  return PACKAGE_FEED_REGISTRIES.some((registry) => resolved === registry + tarball);
}

export function packageLockSha256(packageLockText: string): string {
  return createHash("sha256").update(packageLockText, "utf8").digest("hex");
}

function readLockEntries(packageLockText: string): Record<string, unknown> | null {
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
  return value.packages;
}

// Judges one lock entry other than the root. The answer is the node, or the reason the entry is refused. The reason
// is for packageLockProblems only: parsePackageLock drops it, so no report and no release log ever carries it.
function judgeLockEntry(lockPath: string, entry: unknown, entries: Record<string, unknown>): LockedPackage | string {
  // This repository has no workspace, no file: dependency and no link. Such an entry is installed from a folder,
  // not from the feed, so nothing below could judge it. The name in the path is read from the whole key, so it is
  // the folder npm fills and the name npm audit asks about when the entry has no "name".
  const pathName = LOCK_KEY_PATTERN.exec(lockPath)?.[1];
  if (!pathName) return "the key is not package folders under node_modules/ and nothing else";
  if (!isRecord(entry)) return "the entry is not an object";
  if (entry.link !== undefined) return "the entry is a link to a folder, not a package from the feed";
  // An aliased dependency ("x": "npm:qs@6.15.3") is installed at .../node_modules/x and carries its real name in
  // "name". npm audit reports it under the real name, and the blocked and accepted lists name real packages.
  const name = entry.name === undefined ? pathName : entry.name;
  if (!validPackageName(pathName) || !validPackageName(name)) return "the folder or the \"name\" is not a package name";
  if (!validPackageVersion(entry.version) || !CANONICAL_VERSION_PATTERN.test(entry.version)) {
    return "the \"version\" is not three numbers without leading zeros and an optional prerelease";
  }
  const node = { path: lockPath, name, pathName, version: entry.version, dev: entry.dev === true, production: true };
  if (isFeedTarball(entry.resolved, name, entry.version)) return node;
  if (entry.resolved !== undefined) {
    return "\"resolved\" is not the package feed's address of the tarball of this name and version";
  }
  // The only entries without "resolved" are the ones npm fetches nothing for: a package that arrives inside the
  // tarball of the package one folder up, which names it in "bundleDependencies" and comes from the feed itself.
  const bundlerPath = lockPath.slice(0, Math.max(0, lockPath.lastIndexOf("/node_modules/")));
  const bundler = entries[bundlerPath];
  if (
    entry.inBundle !== true
    || !isRecord(bundler)
    || !Array.isArray(bundler.bundleDependencies)
    || !bundler.bundleDependencies.includes(pathName)
    || bundler.resolved === undefined
    || typeof judgeLockEntry(bundlerPath, bundler, entries) === "string"
  ) {
    return "there is no \"resolved\", and the entry is not bundled by a feed package one folder up";
  }
  return node;
}

// The five records in which package.json and the lock's root entry say what the project itself needs.
const ROOT_RECORDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"] as const;

// The five records of a root (package.json, or the lock's "" entry) as one text, so two roots are equal exactly
// when their texts are. A record that is missing counts as an empty one, and the order of the names does not
// matter. A name in both dependencies and optionalDependencies counts in optionalDependencies only, as it does for
// npm. Every value must be a text and is compared character for character; in peerDependenciesMeta it must be
// {"optional": true} or {"optional": false}. Anything else, and any "workspaces", has no text: this repository has
// no workspace, and a workspace is installed from a folder that nothing here judges.
function rootRecordsText(root: unknown): string | null {
  if (!isRecord(root) || root.workspaces !== undefined) return null;
  const records: Array<Array<[string, string]>> = [];
  for (const field of ROOT_RECORDS) {
    const record = root[field] === undefined ? {} : root[field];
    if (!isRecord(record)) return null;
    const pairs: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(record)) {
      const text = field !== "peerDependenciesMeta"
        ? value
        : isRecord(value) && Object.keys(value).length === 1 && typeof value.optional === "boolean" ? String(value.optional) : null;
      if (typeof text !== "string") return null;
      // npm reads a name in both dependencies and optionalDependencies as optional only, in package.json and in
      // the lock's root entry alike. `npm install --save-optional` writes such a root entry: the name in both
      // records, under dependencies with the range from the command line, while package.json has it in one.
      if (field === "dependencies" && isRecord(root.optionalDependencies) && Object.hasOwn(root.optionalDependencies, name)) continue;
      pairs.push([name, text]);
    }
    records.push(pairs.sort(([left], [right]) => (left < right ? -1 : 1)));
  }
  return JSON.stringify(records);
}

// The names an entry needs, each with whether the lock must hold an entry for it. npm reads the same three records
// in the same order, a later one winning: peerDependencies, dependencies, optionalDependencies. An optional peer and
// an optional dependency may be left out of a lock; everything else npm installs. A package in "bundleDependencies"
// arrives inside the tarball of the entry itself, so it is there whenever the entry is.
function neededNames(entry: Record<string, unknown>): Map<string, boolean> | string {
  const needs = new Map<string, boolean>();
  const meta = entry.peerDependenciesMeta;
  for (const field of ["peerDependencies", "dependencies", "optionalDependencies"] as const) {
    const record = entry[field] === undefined ? {} : entry[field];
    if (!isRecord(record)) return `"${field}" is not an object`;
    for (const name of Object.keys(record)) {
      const optionalPeer = isRecord(meta) && isRecord(meta[name]) && meta[name].optional === true;
      needs.set(name, field === "dependencies" || (field === "peerDependencies" && !optionalPeer));
    }
  }
  const bundled = entry.bundleDependencies === undefined ? [] : entry.bundleDependencies;
  if (!Array.isArray(bundled)) return "\"bundleDependencies\" is not a list";
  for (const name of bundled) if (!needs.has(name)) needs.set(name, false);
  for (const name of needs.keys()) if (!validPackageName(name)) return "a dependency is not called by a package name";
  return needs;
}

// The paths of the entries production needs, worked out from what each entry depends on and never read from a flag.
// The walk starts at the root's dependencies, optionalDependencies and peerDependencies (not its devDependencies),
// finds each name the way npm and Node do, in the nearest node_modules folder going up from the entry that needs
// it, and goes on from every entry it finds. An alias is found by its folder, like any other entry. npm keeps the
// packages of a folder in a map that ignores letter case, so the walk does too, and it refuses two keys that
// differ only by case. npm puts an entry into the map of the entry whose key is, letter for letter, the folder
// above it, so a key whose folder above has no entry is refused as well: npm would never find that entry from the
// folder the walk finds it from, and real npm 10 and 11 then install the copy further up that the walk never
// reached. The answer is the set, or the reason the lock cannot be walked.
function productionPaths(entries: Record<string, unknown>): Set<string> | string {
  const pathByFoldedKey = new Map<string, string>();
  for (const lockPath of Object.keys(entries)) {
    if (pathByFoldedKey.has(lockPath.toLowerCase())) return `${lockPath}: another key differs only by letter case`;
    pathByFoldedKey.set(lockPath.toLowerCase(), lockPath);
    if (!Object.hasOwn(entries, lockPath.slice(0, Math.max(0, lockPath.lastIndexOf("/node_modules/"))))) {
      return `${lockPath}: the folder above it has no entry`;
    }
  }
  const production = new Set<string>();
  const queue = [""];
  for (let from = queue.pop(); from !== undefined; from = queue.pop()) {
    const needs = neededNames(entries[from] as Record<string, unknown>);
    const who = from === "" ? "the root entry" : from;
    if (typeof needs === "string") return `${who}: ${needs}`;
    for (const [name, required] of needs) {
      let found: string | undefined;
      for (let folder = from; ; folder = folder.slice(0, Math.max(0, folder.lastIndexOf("/node_modules/")))) {
        found = pathByFoldedKey.get(`${folder === "" ? "" : `${folder}/`}node_modules/${name}`.toLowerCase());
        if (found !== undefined || folder === "") break;
      }
      if (found === undefined) {
        // An entry production needs is missing, so nothing here can say what `npm ci` would put in its place.
        if (required) return `${who}: needs ${name}, which has no entry`;
      } else if (!production.has(found)) {
        production.add(found);
        queue.push(found);
      }
    }
  }
  return production;
}

// Everything a lock is refused for, with the reason. The entries that were judged are added to `packages`.
// The image has npm 10, which leaves out of `npm ci --omit=dev` exactly the entries marked "dev": true. npm 11 does
// not read the mark: it leaves out the entries production does not need. So an entry is surely absent from
// production only when both say so, and a lock in which the two disagree on any entry, in either direction, is
// refused: npm would not write it, and the two versions would install different production trees from it (#2308).
function lockProblems(entries: Record<string, unknown>, packages: LockedPackage[]): string[] {
  const problems: string[] = [];
  for (const [lockPath, entry] of Object.entries(entries)) {
    if (lockPath === "") continue;
    const node = judgeLockEntry(lockPath, entry, entries);
    if (typeof node === "string") problems.push(`${lockPath}: ${node}`);
    else packages.push(node);
  }
  if (rootRecordsText(entries[""]) === null) problems.push("the root entry has \"workspaces\", or one of its dependency records is not an object of texts");
  if (problems.length > 0) return problems;
  const production = productionPaths(entries);
  if (typeof production === "string") return [production];
  for (const node of packages) node.production = production.has(node.path);
  return packages.filter((node) => node.dev === node.production).map((node) => node.dev
    ? `${node.path}: the entry is marked "dev": true, but production needs it`
    : `${node.path}: the entry is not marked "dev": true, but production does not need it`);
}

export function parsePackageLock(packageLockText: string): PackageLockSnapshot | null {
  const entries = readLockEntries(packageLockText);
  if (!entries) return null;
  const packages: LockedPackage[] = [];
  if (lockProblems(entries, packages).length > 0) return null;
  return { sha256: packageLockSha256(packageLockText), packages, rootRecords: rootRecordsText(entries[""]) as string };
}

// Everything parsePackageLock refuses the lock for, with the reason, for a test or a person at a terminal. The
// preflight never calls this: a failed release shows the status invalid_lock and nothing about the entry.
export function packageLockProblems(packageLockText: string): string[] {
  const entries = readLockEntries(packageLockText);
  return entries ? lockProblems(entries, []) : ["package-lock.json is not a version 3 lock with a root entry"];
}

// A node is the listed package under either of its names. The "name" field is only what the lock says: `npm ci`
// installs the tarball in "resolved" into the folder in the path whatever that field holds. So an alias cannot hide
// a listed package behind another folder, and a "name" field cannot hide the listed package that fills its folder.
function isLockedPackage(node: LockedPackage, name: string): boolean {
  return node.name === name || node.pathName === name;
}

function isOutsideProduction(node: LockedPackage): boolean {
  return node.dev && !node.production;
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
  const entries: AuditEntry[] = [];
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
      // npm reports an empty range for an entry that is listed only because of what it depends on.
      || (entry.range.length === 0 && !entry.via.every((item: unknown) => typeof item === "string"))
      || entry.range.length > 512
      || !Array.isArray(entry.nodes)
      || entry.nodes.length === 0
      || !entry.nodes.every((node) => typeof node === "string")
      || !isFixAvailable(entry.fixAvailable)
    ) {
      return null;
    }
    entryCounts[entry.severity] += 1;
    const nodes: LockedPackage[] = [];
    for (const node of entry.nodes) {
      const lockedPackage = lockPackagesByPath.get(node);
      if (!lockedPackage || lockedPackage.name !== name) return null;
      nodes.push(lockedPackage);
    }
    vulnerablePackages.push(...nodes);
    const via: unknown[] = entry.via;
    entries.push({
      name,
      advisories: via.filter(isRecord).map(({ name: advisoryName, url, severity }) => ({ name: advisoryName, url, severity })),
      dependsOn: via.filter((item): item is string => typeof item === "string"),
      nodes,
    });
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
    entries,
  };
}

export function dependencyPolicyFailure(
  status: Exclude<DependencyPolicyStatus, "pass" | "accepted" | "rejected" | "command_failed">,
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

// The first millisecond after the expiry date in UTC, or NaN when the text is not a real calendar day.
function expiryEndMs(expires: string): number {
  if (!ACCEPTED_EXPIRY_PATTERN.test(expires)) return Number.NaN;
  const start = Date.parse(`${expires}T00:00:00.000Z`);
  if (Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== expires) return Number.NaN;
  return start + DAY_MS;
}

// Decides whether an audit with findings is covered by the list of accepted advisories. Every check must hold; anything
// unexpected returns null and the caller reports "rejected" as before. A node is outside production when nothing
// production needs leads to it (productionPaths) and the lock marks it "dev": true, so that neither npm 10 nor
// npm 11 installs it with --omit=dev. parsePackageLock has already refused a lock in which the two disagree.
//   a. Every advisory object is a listed one: the exact advisory URL, on the listed package, and every lock node of
//      that package, whether npm reports it or not, has the listed version and is outside production.
//   b. Every other entry is reported only because it depends, directly or through such entries, on an accepted one.
//   c. Every lock node of every entry is outside production.
//   d. The current time is before the end of the listed expiry date in UTC.
//   e. Nothing is critical. The caller has already ruled out blocked dependencies.
function acceptedAudit(
  lock: PackageLockSnapshot,
  audit: ParsedAudit,
  { now, advisories }: Acceptance,
): { packages: DependencyPackageResult[]; exceptions: AcceptedAdvisory[] } | null {
  if (audit.entries.length === 0 || audit.counts.critical > 0) return null;
  const matched = new Set<ListedAdvisory>();
  // Entries whose every advisory is listed with production: true. Only these, and entries that depend on nothing
  // else, may have nodes that production installs.
  const productionListed = new Set<string>();
  for (const entry of audit.entries) {
    let allProduction = entry.advisories.length > 0;
    for (const advisory of entry.advisories) {
      const listed = advisories.find((item) =>
        advisory.url === ADVISORY_URL_PREFIX + item.advisory
        && advisory.name === item.package
        && entry.name === item.package);
      if (
        !listed
        || advisory.severity === "critical"
        || !ACCEPTED_ADVISORY_ID_PATTERN.test(listed.advisory)
        || !ACCEPTED_PACKAGE_PATTERN.test(listed.package)
        || !validPackageVersion(listed.version)
        // Read from the lock itself, so a node of the package that npm left out of its report is checked too.
        || !lock.packages.every((node) => !isLockedPackage(node, listed.package)
          || ((listed.production === true || isOutsideProduction(node)) && node.version === listed.version))
        // Written so that an expiry date or a clock that is not a number is rejected too.
        || !(now < expiryEndMs(listed.expires))
      ) {
        return null;
      }
      if (listed.production !== true) allProduction = false;
      matched.add(listed);
    }
    if (allProduction) productionListed.add(entry.name);
  }

  // An entry stands once everything it depends on stands. One with only advisory objects stands at once, because
  // the loop above already matched all of them. An entry that never stands leaves the audit rejected: it names a
  // package the audit does not report, or itself, or it is part of a cycle. An entry with a node in production
  // stands only through production-listed advisories: its own, or every entry it depends on standing that way.
  const standing = new Set<string>();
  const productionStanding = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of audit.entries) {
      if (standing.has(entry.name) || !entry.dependsOn.every((name) => standing.has(name))) continue;
      const viaProduction = entry.advisories.length > 0
        ? productionListed.has(entry.name) && entry.dependsOn.every((name) => productionStanding.has(name))
        : entry.dependsOn.length > 0 && entry.dependsOn.every((name) => productionStanding.has(name));
      if (!viaProduction && !entry.nodes.every(isOutsideProduction)) return null;
      standing.add(entry.name);
      if (viaProduction) productionStanding.add(entry.name);
      grew = true;
    }
  }
  if (standing.size !== audit.entries.length) return null;

  const packages = audit.entries
    .flatMap((entry) => entry.nodes.map(({ name, version }) => ({
      name,
      version,
      status: entry.advisories.length > 0 ? "accepted" as const : "dependent" as const,
    })))
    .sort(comparePackageResults);
  // An accepted report never omits a package, so the release script can check all of them.
  if (packages.length > MAX_REPORTED_PACKAGES) return null;
  const exceptions = advisories
    .filter((item) => matched.has(item))
    .map(({ advisory, package: name, version, expires }) => ({ advisory, package: name, version, expires }));
  return { packages, exceptions };
}

function policyReport(lock: PackageLockSnapshot, audit: ParsedAudit, acceptance: Acceptance): DependencyPolicyReport {
  // Reported under the listed name, which for an alias or a false "name" field is not the name in the lock entry.
  const blocked = BLOCKED_DEPENDENCIES.flatMap(({ name, version }) =>
    lock.packages.filter((item) => item.version === version && isLockedPackage(item, name)).map(() => ({ name, version })));
  const accepted = blocked.length === 0 ? acceptedAudit(lock, audit, acceptance) : null;
  if (accepted) {
    return {
      status: "accepted",
      counts: {
        blocked: 0,
        info: audit.counts.info,
        low: audit.counts.low,
        moderate: audit.counts.moderate,
        high: audit.counts.high,
        critical: audit.counts.critical,
        vulnerabilities: audit.counts.total,
        reported: accepted.packages.length,
        omitted: 0,
      },
      packages: accepted.packages,
      exceptions: accepted.exceptions,
    };
  }
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
function assessAuditExecution(
  lock: PackageLockSnapshot,
  execution: AuditExecutionResult,
  attempt: number,
  acceptance: Acceptance,
): AuditAssessment {
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
    const report = audit ? policyReport(lock, audit, acceptance) : undefined;
    return report?.status === "rejected" ? { report, retryable: false } : malformed;
  }
  if (audit) {
    const expectedExit = execution.exitCode === 0 || (execution.exitCode === 1 && audit.counts.total > 0);
    return expectedExit ? { report: policyReport(lock, audit, acceptance), retryable: false } : commandFailed(false);
  }
  return execution.exitCode === 0 || AUDIT_REPORT_MARKER.test(execution.stdout) ? malformed : commandFailed(false);
}

// Judges the lock's text alone. The preflight never calls this directly: it uses runDependencyAudit and
// evaluateTemporaryAuditFile, which read the lock through readLock and so also hold package.json to it.
export function evaluateDependencyPolicy(options: AcceptanceOptions & {
  expectedLockSha256: string;
  packageLockText: string;
  execution: AuditExecutionResult;
}): DependencyPolicyReport {
  const expected = options.expectedLockSha256.trim().toLowerCase();
  if (!SHA256_PATTERN.test(expected)) return dependencyPolicyFailure("invalid_request");
  const lock = parsePackageLock(options.packageLockText);
  if (!lock) return dependencyPolicyFailure("invalid_lock");
  if (lock.sha256 !== expected) return dependencyPolicyFailure("lock_mismatch");
  return assessAuditExecution(lock, options.execution, 1, acceptanceFrom(options)).report;
}

// npm reads npm-shrinkwrap.json instead of package-lock.json when a folder holds both. `npm audit` would then judge
// a file this policy never reads, while the image is built from package-lock.json alone. So the lock is not read
// while anything called npm-shrinkwrap.json stands next to it.
// Both npm 10 and npm 11 take what the project itself needs from package.json, not from the lock's root entry: a
// package that package.json moves from devDependencies to dependencies is installed by `npm ci --omit=dev` even
// when the lock still calls it a devDependency and marks it "dev": true. productionPaths starts at the lock's root
// entry, so the lock is not read either unless the package.json next to it has the same five records (#2308).
async function readLock(lockPath: string): Promise<{ text: string; snapshot: PackageLockSnapshot; packageJsonSha256: string } | null> {
  try {
    const folder = path.dirname(lockPath);
    const absent = await fs.lstat(path.join(folder, "npm-shrinkwrap.json"))
      .then(() => false, (error) => isRecord(error) && error.code === "ENOENT");
    if (!absent) return null;
    const text = await fs.readFile(lockPath, "utf8");
    const packageJson = await fs.readFile(path.join(folder, "package.json"), "utf8");
    const snapshot = parsePackageLock(text);
    if (!snapshot || rootRecordsText(JSON.parse(packageJson)) !== snapshot.rootRecords) return null;
    return { text, snapshot, packageJsonSha256: packageLockSha256(packageJson) };
  } catch {
    return null;
  }
}

export async function runDependencyAudit(options: AcceptanceOptions & {
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
    // package.json has no identity the release pins, so it is held to the bytes it had before the audit.
    if (!after || after.snapshot.sha256 !== expected || after.packageJsonSha256 !== before.packageJsonSha256) {
      return dependencyPolicyFailure("lock_mismatch");
    }
    const assessment: AuditAssessment = execution
      ? assessAuditExecution(after.snapshot, execution, attempt, acceptanceFrom(options))
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

export async function evaluateTemporaryAuditFile(options: AcceptanceOptions & {
  auditPath: string;
  lockPath: string;
  expectedLockSha256: string;
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
    now,
    acceptedAdvisories: options.acceptedAdvisories,
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
