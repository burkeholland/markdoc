import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORITY_SCOPES,
  canonicalJson,
  executeReleasePlanForTests,
  gitBlobSha,
  ReleaseStop,
  sha256,
  validateAuthorities,
  type AuthorityFileInput,
  type AuthorityScope,
  type ExecuteReleaseOptions,
  type ReleaseAuthority,
  type ReleaseIdentity,
  type ReleasePlan,
} from "./release-executor";
import { runMain } from "../release-executor.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

interface Fixture {
  root: string;
  repo: string;
  commonDirectory: string;
  packageFile: string;
  lockFile: string;
  output: string;
  plan: ReleasePlan;
  release: ReleaseIdentity;
  authorities: AuthorityFileInput[];
}

function writeAuthority(
  directory: string,
  scope: AuthorityScope,
  release: ReleaseIdentity,
  mutate?: (authority: ReleaseAuthority) => void,
): AuthorityFileInput {
  const authority: ReleaseAuthority = {
    schemaVersion: 1,
    kind: "markdoc-release-authority",
    scope,
    decision: "allow",
    authorityId: `${scope}-acceptance`,
    issuer: "markdoc-lead",
    release,
  };
  mutate?.(authority);
  const bytes = canonicalJson(authority);
  const file = path.join(directory, `authority-${scope}.json`);
  writeFileSync(file, bytes);
  return { scope, file, root: sha256(bytes) };
}

function createFixture(options: { thirdPath?: boolean } = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "markdoc-release-executor-test-"));
  roots.push(root);
  const repository = path.join(root, "repository");
  const repo = path.join(root, "controller");
  const builder = path.join(root, "builder");
  const inputs = path.join(root, "inputs");
  mkdirSync(repository);
  mkdirSync(inputs);

  git(repository, "init", "--quiet");
  git(repository, "config", "user.name", "Release Test");
  git(repository, "config", "user.email", "release-test@example.invalid");
  writeFileSync(path.join(repository, ".gitattributes"), "* text=auto eol=lf\n");
  writeFileSync(path.join(repository, "app.txt"), "production application\n");
  writeFileSync(path.join(repository, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  writeFileSync(path.join(repository, "package-lock.json"), '{"name":"fixture","lockfileVersion":3}\n');
  git(repository, "add", ".");
  git(repository, "commit", "--quiet", "-m", "production source");
  const productionCommit = git(repository, "rev-parse", "HEAD");
  const productionTree = git(repository, "rev-parse", "HEAD^{tree}");
  git(root, "clone", "--quiet", "--no-hardlinks", repository, builder);
  git(repository, "worktree", "add", "--quiet", "-b", "controller", repo);

  const packageBytes = Buffer.from('{"name":"fixture","version":"1.0.1"}\n');
  const lockBytes = Buffer.from('{"name":"fixture","lockfileVersion":3,"packages":{"":{"version":"1.0.1"}}}\n');
  git(builder, "config", "user.name", "Release Test");
  git(builder, "config", "user.email", "release-test@example.invalid");
  writeFileSync(path.join(builder, "package.json"), packageBytes);
  writeFileSync(path.join(builder, "package-lock.json"), lockBytes);
  if (options.thirdPath) writeFileSync(path.join(builder, "extra.txt"), "not authorized\n");
  git(builder, "add", ".");
  git(builder, "commit", "--quiet", "-m", "payload tree");
  const payloadTree = git(builder, "rev-parse", "HEAD^{tree}");

  writeFileSync(path.join(repo, "controller.txt"), "external controller\n");
  git(repo, "add", "controller.txt");
  git(repo, "commit", "--quiet", "-m", "controller");
  const controllerCommit = git(repo, "rev-parse", "HEAD");
  const controllerTree = git(repo, "rev-parse", "HEAD^{tree}");

  const packageFile = path.join(inputs, "package.json");
  const lockFile = path.join(inputs, "package-lock.json");
  writeFileSync(packageFile, packageBytes);
  writeFileSync(lockFile, lockBytes);

  const plan: ReleasePlan = {
    productionCommit,
    productionTree,
    payloadTree,
    packageBlob: gitBlobSha(packageBytes),
    packageLockBlob: gitBlobSha(lockBytes),
    changedPaths: ["package-lock.json", "package.json"],
  };
  const release: ReleaseIdentity = {
    controllerCommit,
    controllerTree,
    ...plan,
  };
  const authorities = AUTHORITY_SCOPES.map((scope) => writeAuthority(inputs, scope, release));
  return {
    root,
    repo: real(repo),
    commonDirectory: real(path.join(repository, ".git")),
    packageFile,
    lockFile,
    output: path.join(root, "payload"),
    plan,
    release,
    authorities,
  };
}

function real(file: string): string {
  return path.resolve(file);
}

function executeOptions(fixture: Fixture, overrides: Partial<ExecuteReleaseOptions> = {}): ExecuteReleaseOptions {
  return {
    repoRoot: fixture.repo,
    authorities: fixture.authorities,
    packageJsonFile: fixture.packageFile,
    packageLockFile: fixture.lockFile,
    output: fixture.output,
    ...overrides,
  };
}

function executeFixture(fixture: Fixture, overrides: Partial<ExecuteReleaseOptions> = {}) {
  return executeReleasePlanForTests(executeOptions(fixture, overrides), fixture.plan);
}

function objectExists(repo: string, object: string): boolean {
  return spawnSync("git", ["cat-file", "-e", object], {
    cwd: repo,
    stdio: "ignore",
    windowsHide: true,
  }).status === 0;
}

describe("release authority boundary", () => {
  it("requires four distinct, canonical, independently rooted authorities over one exact tuple", () => {
    const fixture = createFixture();
    const protectedRoots = [fixture.repo, fixture.commonDirectory];
    expect(validateAuthorities(fixture.authorities, fixture.release, protectedRoots).map((authority) => authority.scope)).toEqual(AUTHORITY_SCOPES);

    const duplicateRoot = fixture.authorities.map((input) => ({ ...input }));
    duplicateRoot[1].root = duplicateRoot[0].root;
    expect(() => validateAuthorities(duplicateRoot, fixture.release, protectedRoots)).toThrow("authority roots must be distinct");

    const source = fixture.authorities.find((input) => input.scope === "source")!;
    writeFileSync(source.file, `${JSON.stringify(JSON.parse(readFileSync(source.file, "utf8")) as unknown, null, 2)}\n`);
    source.root = sha256(readFileSync(source.file));
    expect(() => validateAuthorities(fixture.authorities, fixture.release, protectedRoots)).toThrow("source authority is not canonical JSON");
  });

  it("rejects a coherent authority tuple rewrite even when that file's root is updated", () => {
    const fixture = createFixture();
    const source = fixture.authorities.find((input) => input.scope === "source")!;
    const rewritten: ReleaseIdentity = { ...fixture.release, payloadTree: "0".repeat(40) };
    const replacement = writeAuthority(path.dirname(source.file), "source", rewritten);
    source.root = replacement.root;
    expect(() => validateAuthorities(fixture.authorities, fixture.release, [fixture.repo, fixture.commonDirectory])).toThrow("source authority release identity mismatch");
  });

  it("rejects authority files stored in the controller checkout", () => {
    const fixture = createFixture();
    const controller = fixture.authorities.find((input) => input.scope === "controller")!;
    const inside = path.join(fixture.repo, "authority.json");
    writeFileSync(inside, readFileSync(controller.file));
    controller.file = inside;
    expect(() => validateAuthorities(fixture.authorities, fixture.release, [fixture.repo, fixture.commonDirectory])).toThrow("controller authority must be outside");
  });
});

describe("production-rooted composition", () => {
  it("checks and atomically stages only the authorized two-file payload without refs or repository objects", () => {
    const fixture = createFixture();
    const refsBefore = git(fixture.repo, "show-ref");
    const objectsBefore = git(fixture.repo, "count-objects", "-v");
    expect(objectExists(fixture.repo, fixture.plan.packageBlob)).toBe(false);
    expect(objectExists(fixture.repo, fixture.plan.packageLockBlob)).toBe(false);
    expect(objectExists(fixture.repo, fixture.plan.payloadTree)).toBe(false);

    const checked = executeFixture(fixture, { checkOnly: true, output: undefined });
    expect(checked).toMatchObject({ mode: "checked", payloadTree: fixture.plan.payloadTree, authorityCount: 4 });
    expect(readdirSync(fixture.root).filter((name) => name.startsWith(".markdoc-release-"))).toEqual([]);

    const staged = executeFixture(fixture);
    expect(staged.mode).toBe("staged");
    expect(readFileSync(path.join(fixture.output, "app.txt"), "utf8")).toBe("production application\n");
    expect(readFileSync(path.join(fixture.output, "package.json")).equals(readFileSync(fixture.packageFile))).toBe(true);
    expect(readFileSync(path.join(fixture.output, "package-lock.json")).equals(readFileSync(fixture.lockFile))).toBe(true);
    expect(() => readFileSync(path.join(fixture.output, "controller.txt"))).toThrow();
    expect(() => readFileSync(path.join(fixture.output, ".git"))).toThrow();
    expect(git(fixture.repo, "show-ref")).toBe(refsBefore);
    expect(git(fixture.repo, "count-objects", "-v")).toBe(objectsBefore);
    expect(objectExists(fixture.repo, fixture.plan.packageBlob)).toBe(false);
    expect(objectExists(fixture.repo, fixture.plan.packageLockBlob)).toBe(false);
    expect(objectExists(fixture.repo, fixture.plan.payloadTree)).toBe(false);
    expect(git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    expect(readdirSync(fixture.root).filter((name) => name.startsWith(".markdoc-release-"))).toEqual([]);
  });

  it("stops and removes quarantine state when the payload has a hidden third path", () => {
    const fixture = createFixture({ thirdPath: true });
    expect(() => executeFixture(fixture)).toThrow("composed payload tree identity mismatch");
    expect(() => readdirSync(fixture.output)).toThrow();
    expect(readdirSync(fixture.root).filter((name) => name.startsWith(".markdoc-release-"))).toEqual([]);
  });

  it("stops before composition on missing authority, package drift, dirty controller or an internal output", () => {
    const missing = createFixture();
    expect(() =>
      executeFixture(missing, { authorities: missing.authorities.slice(0, 3) }),
    ).toThrow("exactly four authority files");
    expect(() => readdirSync(missing.output)).toThrow();

    const packageDrift = createFixture();
    writeFileSync(packageDrift.packageFile, "{}\n");
    expect(() => executeFixture(packageDrift)).toThrow("package.json input blob mismatch");
    expect(() => readdirSync(packageDrift.output)).toThrow();

    const dirty = createFixture();
    writeFileSync(path.join(dirty.repo, "dirty.txt"), "dirty\n");
    expect(() => executeFixture(dirty)).toThrow("controller checkout is not clean");
    expect(() => readdirSync(dirty.output)).toThrow();

    const internal = createFixture();
    expect(() =>
      executeFixture(internal, { output: path.join(internal.repo, "payload") }),
    ).toThrow("output must be outside");
    expect(() =>
      executeFixture(internal, { output: path.join(internal.commonDirectory, "refs", "release-payload") }),
    ).toThrow("output must be outside");
    expect(readdirSync(internal.root).filter((name) => name.startsWith(".markdoc-release-"))).toEqual([]);
  });
});

describe("release executor CLI", () => {
  it("returns STOP rather than constructing defaults when current authorities are absent", () => {
    const lines: string[] = [];
    const execute = vi.fn();
    const output = { log: (message: string) => lines.push(message), error: (message: string) => lines.push(message) };
    expect(runMain([], { output, execute })).toBe(1);
    expect(lines).toEqual(["release-executor: STOP missing --controller-authority"]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes all explicit roots and inputs to the executor; malformed syntax exits 2", () => {
    const lines: string[] = [];
    const output = { log: (message: string) => lines.push(message), error: (message: string) => lines.push(message) };
    const execute = vi.fn((options: ExecuteReleaseOptions) => {
      expect(options.repoRoot).toBe("controller");
      return {
        mode: "checked" as const,
        payloadTree: "1".repeat(40),
        packageBlob: "2".repeat(40),
        packageLockBlob: "3".repeat(40),
        authorityCount: 4,
      };
    });
    const args = AUTHORITY_SCOPES.flatMap((scope) => [`--${scope}-authority`, `${scope}.json`, `--${scope}-root`, scope.repeat(64).slice(0, 64)]).concat([
      "--package-json",
      "package.json",
      "--package-lock",
      "package-lock.json",
      "--check",
    ]);
    expect(runMain(args, { output, execute, repoRoot: "controller" })).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0].authorities.map((input) => input.scope)).toEqual(AUTHORITY_SCOPES);
    expect(lines.at(-1)).toContain("release-executor: CHECKED");

    expect(runMain(["--unknown"], { output, execute })).toBe(2);
    expect(lines.at(-1)).toContain("usage: npm run release:execute");
  });

  it("surfaces a known fail-closed decision without a stack or unexpected details", () => {
    const lines: string[] = [];
    const output = { log: (message: string) => lines.push(message), error: (message: string) => lines.push(message) };
    const execute = vi.fn(() => {
      throw new ReleaseStop("package authority decision is not allow");
    });
    const args = AUTHORITY_SCOPES.flatMap((scope) => [`--${scope}-authority`, `${scope}.json`, `--${scope}-root`, "a".repeat(64)]).concat([
      "--package-json",
      "package.json",
      "--package-lock",
      "package-lock.json",
      "--check",
    ]);
    expect(runMain(args, { output, execute })).toBe(1);
    expect(lines).toEqual(["release-executor: STOP package authority decision is not allow"]);
  });
});
