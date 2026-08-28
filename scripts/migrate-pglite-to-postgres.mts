import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CommitOutcomeUnknownError,
  createPostgresDestination,
  MigrationCommittedManifestError,
  migratePgliteSnapshot,
  type TransactionalConnection,
} from "./lib/pglite-postgres-migration";

interface MigrationArguments {
  sourceSnapshot: string;
  sourceDataDir: string;
  destinationUrlEnv: string;
  manifest: string;
  replace: boolean;
  verifyOnly: boolean;
}

const usage = `usage:
  npx tsx scripts/migrate-pglite-to-postgres.mts \\
    --source-snapshot <markdoc-pglite.tar.gz> \\
    --source-data-dir <new-private-temporary-directory> \\
    --destination-url-env <environment-variable-name> \\
    --manifest <output.json> [--replace | --verify-only]

The destination URL is read from the named environment variable so credentials never enter shell history.
The temporary source directory must not already exist; it is created privately and removed after every run.`;

export function parseMigrationArguments(argv: string[]): MigrationArguments {
  const values = new Map<string, string>();
  let replace = false;
  let verifyOnly = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--replace") {
      replace = true;
      continue;
    }
    if (argument === "--verify-only") {
      verifyOnly = true;
      continue;
    }
    if (!["--source-snapshot", "--source-data-dir", "--destination-url-env", "--manifest"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    values.set(argument, value);
  }

  const sourceSnapshot = values.get("--source-snapshot");
  const sourceDataDir = values.get("--source-data-dir");
  const destinationUrlEnv = values.get("--destination-url-env");
  const manifest = values.get("--manifest");
  if (!sourceSnapshot || !sourceDataDir || !destinationUrlEnv || !manifest) {
    throw new Error("Source snapshot, temporary source data directory, destination URL environment variable, and manifest path are required");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(destinationUrlEnv)) {
    throw new Error("Destination URL environment variable name is invalid");
  }
  if (replace && verifyOnly) throw new Error("--replace and --verify-only cannot be combined");

  return { sourceSnapshot, sourceDataDir, destinationUrlEnv, manifest, replace, verifyOnly };
}

export async function runCli(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  connect: (url: string) => Promise<TransactionalConnection> = createPostgresDestination,
): Promise<void> {
  const argumentsValue = parseMigrationArguments(argv);
  const destinationUrl = environment[argumentsValue.destinationUrlEnv];
  if (!destinationUrl) throw new Error(`Destination URL environment variable ${argumentsValue.destinationUrlEnv} is unset`);

  const sourceDataDir = path.resolve(argumentsValue.sourceDataDir);
  const sourceSnapshot = path.resolve(argumentsValue.sourceSnapshot);
  const manifestPath = path.resolve(argumentsValue.manifest);
  const canonicalSourceDataDir = await canonicalPath(sourceDataDir);
  const canonicalSourceSnapshot = await canonicalPath(sourceSnapshot);
  const canonicalManifest = await canonicalPath(manifestPath);
  if (isSamePath(canonicalManifest, canonicalSourceSnapshot) || (await filesAlias(manifestPath, sourceSnapshot))) {
    throw new Error("Manifest path cannot replace or alias the source snapshot");
  }
  if (
    isSamePath(canonicalManifest, canonicalSourceDataDir) ||
    isChildPath(canonicalManifest, canonicalSourceDataDir)
  ) {
    throw new Error("Manifest path cannot be inside the disposable temporary source data directory");
  }

  const destination = await connect(destinationUrl);
  let operationError: unknown;
  try {
    const manifest = await migratePgliteSnapshot({
      sourceSnapshot,
      sourceDataDir,
      destination,
      manifestPath,
      replace: argumentsValue.replace,
      verifyOnly: argumentsValue.verifyOnly,
    });
    const action = argumentsValue.verifyOnly ? "verified" : "migrated and verified";
    console.log(`${action}: ${manifest.totals.rows} rows across ${manifest.totals.tables} application tables`);
    console.log(`manifest: ${manifestPath}`);
  } catch (error) {
    operationError = error;
  }
  try {
    await destination.close();
  } catch (closeError) {
    if (operationError instanceof CommitOutcomeUnknownError) {
      throw new CommitOutcomeUnknownError(
        new AggregateError([operationError.cause, closeError], "COMMIT outcome and destination connection close both failed"),
      );
    }
    if (operationError instanceof MigrationCommittedManifestError) {
      throw new MigrationCommittedManifestError(
        new AggregateError([operationError.cause, closeError], "Manifest publication and destination connection close both failed"),
      );
    }
    if (operationError) throw new AggregateError([operationError, closeError], "Migration failed and the destination connection did not close cleanly");
    console.error(`warning: migration committed, but the destination connection did not close cleanly: ${redactError(closeError)}`);
  }
  if (operationError) throw operationError;
}

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted PostgreSQL URL]");
}

async function canonicalPath(input: string): Promise<string> {
  let current = path.resolve(input);
  const missing: string[] = [];
  while (true) {
    try {
      const existing = await fs.realpath(current);
      return path.join(existing, ...missing.reverse());
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

async function filesAlias(left: string, right: string): Promise<boolean> {
  try {
    const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)]);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isSamePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function isChildPath(candidate: string, parent: string): boolean {
  const relative = path.relative(normalizePath(parent), normalizePath(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
const modulePath = fileURLToPath(import.meta.url).toLowerCase();
if (invokedPath === modulePath) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage);
  } else {
    runCli(argv).catch((error) => {
      if (error instanceof MigrationCommittedManifestError) {
        console.error(`migration committed and verified, but manifest publication failed: ${redactError(error.cause)}`);
        process.exitCode = 2;
      } else if (error instanceof CommitOutcomeUnknownError) {
        console.error(
          `migration COMMIT outcome is unknown; do not retry or use --replace until --verify-only establishes destination state: ${redactError(error.cause)}`,
        );
        process.exitCode = 3;
      } else {
        console.error(`migration failed before commit; no successful destination COMMIT was issued: ${redactError(error)}`);
        process.exitCode = 1;
      }
    });
  }
}
