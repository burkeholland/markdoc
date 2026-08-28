import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type QueryResultRow } from "pg";
import { POSTGRES_TLS_VERIFICATION_QUERY } from "./lib/pglite-postgres-migration";
import {
  GithubIdentityRepairCommittedManifestError,
  GithubIdentityRepairError,
  type GithubIdentityRepairMode,
  type GithubIdentityRepairQueryClient,
  repairGithubIdentity,
} from "./lib/github-identity-repair";

const LEGACY_LOGIN_ENV = "MARKDOC_REPAIR_LEGACY_LOGIN";
const GITHUB_ACCOUNT_ID_ENV = "MARKDOC_REPAIR_GITHUB_ACCOUNT_ID";
const MANIFEST_ENV = "MARKDOC_REPAIR_MANIFEST";

export const usage = `usage: npm run repair:github-identity -- [--apply | --verify | --rollback | --help]

The default is a transactional dry-run. Identity inputs are read only from
MARKDOC_REPAIR_LEGACY_LOGIN and MARKDOC_REPAIR_GITHUB_ACCOUNT_ID.
DATABASE_URL is required. Apply, verify, and rollback also require
MARKDOC_REPAIR_MANIFEST. Environment values and manifest contents are never printed.`;

interface CliOutput {
  log(message: string): void;
  error(message: string): void;
}

interface RepairConnection {
  client: GithubIdentityRepairQueryClient;
  close(): Promise<void>;
}

type ConnectRepairDatabase = (databaseUrl: string) => Promise<RepairConnection>;

interface RunCliDependencies {
  environment?: NodeJS.ProcessEnv;
  output?: CliOutput;
  connect?: ConnectRepairDatabase;
}

export function parseRepairArguments(
  argv: string[],
): GithubIdentityRepairMode | "help" {
  const allowed = new Set(["--apply", "--verify", "--rollback", "--help"]);
  for (const argument of argv) {
    if (!allowed.has(argument)) throw new Error("unsupported command-line argument");
  }
  if (new Set(argv).size !== argv.length) throw new Error("duplicate command-line argument");
  if (argv.length > 1) throw new Error("repair modes are mutually exclusive");
  if (argv.length === 0) return "dry-run";
  if (argv[0] === "--apply") return "apply";
  if (argv[0] === "--verify") return "verify";
  if (argv[0] === "--rollback") return "rollback";
  return "help";
}

export async function runRepairCli(
  argv: string[],
  dependencies: RunCliDependencies = {},
): Promise<void> {
  const output = dependencies.output ?? console;
  const mode = parseRepairArguments(argv);
  if (mode === "help") {
    output.log(usage);
    return;
  }

  const environment = dependencies.environment ?? process.env;
  const databaseUrl = requiredEnvironmentValue(environment, "DATABASE_URL");
  const expectedLogin = requiredEnvironmentValue(environment, LEGACY_LOGIN_ENV);
  const providerAccountId = requiredEnvironmentValue(environment, GITHUB_ACCOUNT_ID_ENV);
  const manifestPath =
    mode === "dry-run"
      ? undefined
      : requiredEnvironmentValue(environment, MANIFEST_ENV);

  const connection = await (dependencies.connect ?? connectRepairDatabase)(databaseUrl);
  let operationError: unknown;
  try {
    const report = await repairGithubIdentity({
      client: connection.client,
      expectedLogin,
      providerAccountId,
      mode,
      manifestPath,
    });
    output.log(JSON.stringify(report));
  } catch (error) {
    operationError = error;
  }

  try {
    await connection.close();
  } catch {
    if (!operationError) throw new Error("database connection did not close cleanly");
  }
  if (operationError) throw operationError;
}

export async function runMain(
  argv: string[],
  dependencies: RunCliDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? console;
  try {
    await runRepairCli(argv, dependencies);
    return 0;
  } catch (error) {
    if (error instanceof GithubIdentityRepairCommittedManifestError) {
      output.error("repair committed, but rollback manifest publication failed");
      return 2;
    }
    if (error instanceof GithubIdentityRepairError) {
      output.error(`repair failed [${error.reason}]: ${error.message}`);
      return error.reason === "COMMIT_OUTCOME_UNKNOWN" ? 3 : 1;
    }
    output.error("repair failed [INTERNAL]: the operation did not complete");
    return 1;
  }
}

async function connectRepairDatabase(databaseUrl: string): Promise<RepairConnection> {
  assertEncryptedPostgresUrl(databaseUrl);
  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();
  try {
    const transport = await pg.query<{ ssl: boolean }>(POSTGRES_TLS_VERIFICATION_QUERY);
    if (transport.rows.length !== 1 || transport.rows[0].ssl !== true) {
      throw new Error("database transport is not encrypted");
    }
  } catch (error) {
    await pg.end().catch(() => undefined);
    throw error;
  }

  const client: GithubIdentityRepairQueryClient = {
    query: async <T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: T[] }> => {
      const result = await pg.query<T>(text, values);
      return { rows: result.rows };
    },
  };
  return { client, close: () => pg.end() };
}

function assertEncryptedPostgresUrl(databaseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL is not a valid PostgreSQL URL");
  }
  const sslParameters = [...parsed.searchParams.entries()].filter(([name]) =>
    name.toLowerCase().startsWith("ssl"),
  );
  if (
    sslParameters.length !== 1 ||
    sslParameters[0][0] !== "sslmode" ||
    !["require", "verify-ca", "verify-full"].includes(
      sslParameters[0][1].toLowerCase(),
    )
  ) {
    throw new Error("DATABASE_URL must require an encrypted PostgreSQL connection");
  }
}

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];
  if (!value) throw new Error("a required repair environment variable is unset");
  return value;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
const modulePath = fileURLToPath(import.meta.url).toLowerCase();
if (invokedPath === modulePath) {
  process.exitCode = await runMain(process.argv.slice(2));
}
