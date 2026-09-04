import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const AUTHORITY_SCOPES = ["controller", "source", "payload", "package"] as const;
export type AuthorityScope = (typeof AUTHORITY_SCOPES)[number];

export interface ReleaseIdentity {
  controllerCommit: string;
  controllerTree: string;
  productionCommit: string;
  productionTree: string;
  payloadTree: string;
  packageBlob: string;
  packageLockBlob: string;
  changedPaths: readonly string[];
}

export type ReleasePlan = Omit<ReleaseIdentity, "controllerCommit" | "controllerTree">;

export interface ReleaseAuthority {
  schemaVersion: 1;
  kind: "markdoc-release-authority";
  scope: AuthorityScope;
  decision: "allow";
  authorityId: string;
  issuer: string;
  release: ReleaseIdentity;
}

export interface AuthorityFileInput {
  scope: AuthorityScope;
  file: string;
  root: string;
}

export interface ExecuteReleaseOptions {
  repoRoot: string;
  authorities: AuthorityFileInput[];
  packageJsonFile: string;
  packageLockFile: string;
  output?: string;
  checkOnly?: boolean;
}

export interface ExecuteReleaseResult {
  mode: "checked" | "staged";
  payloadTree: string;
  packageBlob: string;
  packageLockBlob: string;
  authorityCount: number;
}

export const PRODUCTION_RELEASE_PLAN: Readonly<ReleasePlan> = Object.freeze({
  productionCommit: "6e251b1d047ed82427717ef595ef6872e95af3b5",
  productionTree: "6e9d3817118597c396e9b5b9c678105bc27e0de9",
  payloadTree: "ba4aa54f147fd3bce9e5c54345b2226f14e0a36d",
  packageBlob: "b74dac5dba6af30889877cace6a1055aab562327",
  packageLockBlob: "2fc8d918cad6964ed3da64be11ce07e949f5e3fd",
  changedPaths: Object.freeze(["package-lock.json", "package.json"]),
});

const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const AUTHORITY_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_AUTHORITY_BYTES = 32 * 1024;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;

export class ReleaseStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseStop";
  }
}

function stop(message: string): never {
  throw new ReleaseStop(message);
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    stop(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    stop(`${label} fields differ from schema`);
  }
}

function sha1(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA1_PATTERN.test(value)) stop(`${label} must be a lowercase 40-hex Git object id`);
  return value;
}

function authorityToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !AUTHORITY_TOKEN_PATTERN.test(value)) stop(`${label} is invalid`);
  return value;
}

function parseReleaseIdentity(value: unknown): ReleaseIdentity {
  const release = objectValue(value, "authority release");
  exactKeys(
    release,
    [
      "changedPaths",
      "controllerCommit",
      "controllerTree",
      "packageBlob",
      "packageLockBlob",
      "payloadTree",
      "productionCommit",
      "productionTree",
    ],
    "authority release",
  );
  if (!Array.isArray(release.changedPaths) || release.changedPaths.some((item) => typeof item !== "string")) {
    stop("authority release changedPaths must be an array of paths");
  }
  return {
    controllerCommit: sha1(release.controllerCommit, "authority controller commit"),
    controllerTree: sha1(release.controllerTree, "authority controller tree"),
    productionCommit: sha1(release.productionCommit, "authority production commit"),
    productionTree: sha1(release.productionTree, "authority production tree"),
    payloadTree: sha1(release.payloadTree, "authority payload tree"),
    packageBlob: sha1(release.packageBlob, "authority package blob"),
    packageLockBlob: sha1(release.packageLockBlob, "authority package-lock blob"),
    changedPaths: [...release.changedPaths] as string[],
  };
}

function parseAuthority(bytes: Buffer, expectedScope: AuthorityScope, expectedRoot: string): ReleaseAuthority {
  if (!SHA256_PATTERN.test(expectedRoot)) stop(`${expectedScope} authority root must be lowercase 64-hex SHA-256`);
  if (sha256(bytes) !== expectedRoot) stop(`${expectedScope} authority root mismatch`);

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return stop(`${expectedScope} authority is not UTF-8`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return stop(`${expectedScope} authority is not JSON`);
  }
  if (decoded !== canonicalJson(parsed)) stop(`${expectedScope} authority is not canonical JSON`);

  const authority = objectValue(parsed, `${expectedScope} authority`);
  exactKeys(authority, ["authorityId", "decision", "issuer", "kind", "release", "schemaVersion", "scope"], `${expectedScope} authority`);
  if (authority.schemaVersion !== 1) stop(`${expectedScope} authority schemaVersion must be 1`);
  if (authority.kind !== "markdoc-release-authority") stop(`${expectedScope} authority kind mismatch`);
  if (authority.scope !== expectedScope) stop(`${expectedScope} authority scope mismatch`);
  if (authority.decision !== "allow") stop(`${expectedScope} authority decision is not allow`);

  return {
    schemaVersion: 1,
    kind: "markdoc-release-authority",
    scope: expectedScope,
    decision: "allow",
    authorityId: authorityToken(authority.authorityId, `${expectedScope} authorityId`),
    issuer: authorityToken(authority.issuer, `${expectedScope} issuer`),
    release: parseReleaseIdentity(authority.release),
  };
}

function stableFile(file: string, label: string, maxBytes: number): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(file, "r");
  } catch {
    return stop(`${label} is not readable`);
  }

  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) stop(`${label} is not a regular file`);
    if (before.size > BigInt(maxBytes)) stop(`${label} exceeds ${maxBytes} bytes`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      stop(`${label} changed while it was read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof ReleaseStop) throw error;
    return stop(`${label} is not readable`);
  } finally {
    closeSync(descriptor);
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function externalFile(file: string, protectedRoots: readonly string[], label: string): string {
  const absolute = path.resolve(file);
  try {
    if (lstatSync(absolute).isSymbolicLink()) stop(`${label} must not be a symbolic link`);
  } catch (error) {
    if (error instanceof ReleaseStop) throw error;
    return stop(`${label} does not exist`);
  }
  const real = realpathSync(absolute);
  if (protectedRoots.some((root) => isWithin(root, real))) stop(`${label} must be outside the controller checkout and Git metadata`);
  return real;
}

function releaseEquals(actual: ReleaseIdentity, expected: ReleaseIdentity): boolean {
  return canonicalJson(actual) === canonicalJson(expected);
}

export function validateAuthorities(
  inputs: AuthorityFileInput[],
  expected: ReleaseIdentity,
  protectedRoots: readonly string[],
): ReleaseAuthority[] {
  if (inputs.length !== AUTHORITY_SCOPES.length) stop("exactly four authority files are required");
  const authorities: ReleaseAuthority[] = [];
  const roots = new Set<string>();
  const files = new Set<string>();
  const authorityIds = new Set<string>();

  for (const scope of AUTHORITY_SCOPES) {
    const matching = inputs.filter((input) => input.scope === scope);
    if (matching.length !== 1) stop(`exactly one ${scope} authority is required`);
    const input = matching[0];
    const file = externalFile(input.file, protectedRoots, `${scope} authority`);
    if (files.has(file)) stop("authority files must be distinct");
    files.add(file);
    if (roots.has(input.root)) stop("authority roots must be distinct");
    roots.add(input.root);
    const authority = parseAuthority(stableFile(file, `${scope} authority`, MAX_AUTHORITY_BYTES), scope, input.root);
    if (authorityIds.has(authority.authorityId)) stop("authorityId values must be distinct");
    authorityIds.add(authority.authorityId);
    if (!releaseEquals(authority.release, expected)) stop(`${scope} authority release identity mismatch`);
    authorities.push(authority);
  }
  return authorities;
}

interface GitOptions {
  env?: Partial<NodeJS.ProcessEnv>;
}

type GitEnvironment = NodeJS.ProcessEnv;

function cleanGitEnvironment(overrides: Partial<NodeJS.ProcessEnv> = {}): GitEnvironment {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: process.env.NODE_ENV };
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  return {
    ...env,
    ...overrides,
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(repoRoot: string, args: string[], options: GitOptions = {}): string {
  const command = ["--no-replace-objects", "-c", "core.autocrlf=false", ...args];
  const result = spawnSync("git", command, {
    cwd: repoRoot,
    env: cleanGitEnvironment(options.env),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) stop(`git ${args[0]} could not start`);
  if (result.status !== 0) stop(`git ${args[0]} failed with exit ${result.status ?? "unknown"}`);
  return result.stdout.trim();
}

interface ControllerState {
  commit: string;
  tree: string;
  commonDirectory: string;
  protectedRoots: string[];
}

function inspectController(repoRoot: string): ControllerState {
  let top: string;
  try {
    top = realpathSync(git(repoRoot, ["rev-parse", "--show-toplevel"]));
  } catch (error) {
    if (error instanceof ReleaseStop) throw error;
    return stop("controller checkout root could not be resolved");
  }
  if (top !== repoRoot) stop("executor is not running from the controller checkout root");
  const gitDirectory = realpathSync(git(repoRoot, ["rev-parse", "--absolute-git-dir"]));
  const commonPath = git(repoRoot, ["rev-parse", "--git-common-dir"]);
  const commonDirectory = realpathSync(path.resolve(repoRoot, commonPath));
  const commit = git(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const tree = git(repoRoot, ["rev-parse", "--verify", "HEAD^{tree}"]);
  if (!SHA1_PATTERN.test(commit) || !SHA1_PATTERN.test(tree)) stop("controller Git identity is invalid");
  if (git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") stop("controller checkout is not clean");
  return { commit, tree, commonDirectory, protectedRoots: [repoRoot, gitDirectory, commonDirectory] };
}

function verifySourceObjects(repoRoot: string, plan: ReleasePlan): void {
  if (git(repoRoot, ["cat-file", "-t", plan.productionCommit]) !== "commit") stop("production commit object is absent");
  if (git(repoRoot, ["cat-file", "-t", plan.productionTree]) !== "tree") stop("production tree object is absent");
  if (git(repoRoot, ["rev-parse", "--verify", `${plan.productionCommit}^{tree}`]) !== plan.productionTree) {
    stop("production commit does not resolve to the authorized tree");
  }
}

function outputLocation(requested: string, protectedRoots: readonly string[]): { output: string; parent: string } {
  const absolute = path.resolve(requested);
  if (existsSync(absolute)) stop("output already exists");
  const parentPath = path.dirname(absolute);
  let parent: string;
  try {
    parent = realpathSync(parentPath);
  } catch {
    return stop("output parent does not exist");
  }
  const output = path.join(parent, path.basename(absolute));
  if (protectedRoots.some((root) => isWithin(root, output))) stop("output must be outside the controller checkout and Git metadata");
  return { output, parent };
}

function exactChangedPaths(repoRoot: string, sourceTree: string, payloadTree: string, env: Partial<NodeJS.ProcessEnv>): string[] {
  const text = git(repoRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", sourceTree, payloadTree], { env });
  return text === "" ? [] : text.split(/\r?\n/);
}

function samePaths(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function composePayload(
  repoRoot: string,
  plan: ReleasePlan,
  packageFile: string,
  lockFile: string,
  packageBytes: Buffer,
  lockBytes: Buffer,
  commonDirectory: string,
  destination: { output: string; parent: string } | undefined,
): void {
  const temporaryParent = destination?.parent ?? realpathSync(tmpdir());
  const temporaryRoot = mkdtempSync(path.join(temporaryParent, ".markdoc-release-control-"));
  let staged: string | undefined;
  let controlRemoved = false;
  let moved = false;

  try {
    staged = mkdtempSync(path.join(temporaryParent, ".markdoc-release-payload-"));
    const objectDirectory = path.join(temporaryRoot, "objects");
    const indexFile = path.join(temporaryRoot, "index");
    mkdirSync(objectDirectory);
    const alternates = path.join(commonDirectory, "objects");
    const env: Partial<NodeJS.ProcessEnv> = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates,
      GIT_INDEX_FILE: indexFile,
      GIT_OBJECT_DIRECTORY: objectDirectory,
    };

    git(repoRoot, ["read-tree", plan.productionTree], { env });
    const packageBlob = git(repoRoot, ["hash-object", "-w", "--no-filters", packageFile], { env });
    const packageLockBlob = git(repoRoot, ["hash-object", "-w", "--no-filters", lockFile], { env });
    if (packageBlob !== plan.packageBlob) stop("quarantined package blob identity drift");
    if (packageLockBlob !== plan.packageLockBlob) stop("quarantined package-lock blob identity drift");

    git(repoRoot, ["update-index", "--add", "--cacheinfo", "100644", packageLockBlob, "package-lock.json"], { env });
    git(repoRoot, ["update-index", "--add", "--cacheinfo", "100644", packageBlob, "package.json"], { env });
    const payloadTree = git(repoRoot, ["write-tree"], { env });
    if (payloadTree !== plan.payloadTree) stop("composed payload tree identity mismatch");

    const changedPaths = exactChangedPaths(repoRoot, plan.productionTree, payloadTree, env);
    if (!samePaths(changedPaths, plan.changedPaths)) stop("payload changes are not exactly package-lock.json and package.json");

    const prefix = `${staged.split(path.sep).join("/")}/`;
    git(repoRoot, ["checkout-index", "--all", "--force", `--prefix=${prefix}`], { env });
    if (!readFileSync(path.join(staged, "package.json")).equals(packageBytes)) stop("staged package.json bytes drifted");
    if (!readFileSync(path.join(staged, "package-lock.json")).equals(lockBytes)) stop("staged package-lock.json bytes drifted");
    if (existsSync(path.join(staged, ".git"))) stop("staged payload unexpectedly contains Git metadata");

    if (destination) {
      rmSync(temporaryRoot, { recursive: true, force: true });
      controlRemoved = true;
      if (existsSync(destination.output)) stop("output appeared while the payload was composed");
      renameSync(staged, destination.output);
      moved = true;
    }
  } catch (error) {
    if (moved && destination) rmSync(destination.output, { recursive: true, force: true });
    throw error;
  } finally {
    try {
      if (!controlRemoved) rmSync(temporaryRoot, { recursive: true, force: true });
    } finally {
      if (!moved && staged) rmSync(staged, { recursive: true, force: true });
    }
  }
}

function executeReleasePlan(options: ExecuteReleaseOptions, plan: ReleasePlan): ExecuteReleaseResult {
  const repoRoot = realpathSync(path.resolve(options.repoRoot));
  if (!samePaths(plan.changedPaths, ["package-lock.json", "package.json"])) {
    stop("release plan changedPaths must be exactly package-lock.json and package.json");
  }

  const controller = inspectController(repoRoot);
  const expected: ReleaseIdentity = {
    controllerCommit: controller.commit,
    controllerTree: controller.tree,
    productionCommit: plan.productionCommit,
    productionTree: plan.productionTree,
    payloadTree: plan.payloadTree,
    packageBlob: plan.packageBlob,
    packageLockBlob: plan.packageLockBlob,
    changedPaths: [...plan.changedPaths],
  };

  const authorities = validateAuthorities(options.authorities, expected, controller.protectedRoots);
  const packageFile = externalFile(options.packageJsonFile, controller.protectedRoots, "package.json input");
  const lockFile = externalFile(options.packageLockFile, controller.protectedRoots, "package-lock.json input");
  if (packageFile === lockFile) stop("package inputs must be distinct files");
  const packageBytes = stableFile(packageFile, "package.json input", MAX_PACKAGE_BYTES);
  const lockBytes = stableFile(lockFile, "package-lock.json input", MAX_PACKAGE_BYTES);
  if (gitBlobSha(packageBytes) !== plan.packageBlob) stop("package.json input blob mismatch");
  if (gitBlobSha(lockBytes) !== plan.packageLockBlob) stop("package-lock.json input blob mismatch");

  verifySourceObjects(repoRoot, plan);

  if (options.checkOnly && options.output) stop("--check and --output cannot be combined");
  if (!options.checkOnly && !options.output) stop("--output is required unless --check is used");
  const destination = options.checkOnly ? undefined : outputLocation(options.output!, controller.protectedRoots);
  composePayload(repoRoot, plan, packageFile, lockFile, packageBytes, lockBytes, controller.commonDirectory, destination);

  return {
    mode: options.checkOnly ? "checked" : "staged",
    payloadTree: plan.payloadTree,
    packageBlob: plan.packageBlob,
    packageLockBlob: plan.packageLockBlob,
    authorityCount: authorities.length,
  };
}

export function executeProductionRootedRelease(options: ExecuteReleaseOptions): ExecuteReleaseResult {
  return executeReleasePlan(options, PRODUCTION_RELEASE_PLAN);
}

export function executeReleasePlanForTests(options: ExecuteReleaseOptions, plan: ReleasePlan): ExecuteReleaseResult {
  return executeReleasePlan(options, plan);
}
