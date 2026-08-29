import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type QueryResultRow } from "pg";
import { POSTGRES_TLS_VERIFICATION_QUERY } from "./lib/pglite-postgres-migration";
import {
  LegacyOwnershipTransferCommittedRecordError,
  LegacyOwnershipTransferError,
  type LegacyOwnershipTransferMode,
  type LegacyOwnershipTransferQueryClient,
  normalizeTransferId,
  transferLegacyOwnership,
} from "./lib/legacy-ownership-transfer";

const SOURCE_LOGIN_ENV = "MARKDOC_TRANSFER_SOURCE_LOGIN";
const TARGET_ACCOUNT_ID_ENV = "MARKDOC_TRANSFER_TARGET_GITHUB_ACCOUNT_ID";

export const usage = `usage: npm run transfer:legacy-ownership -- [--apply | --verify [--transfer-id <id>] | --rollback --transfer-id <id> | --help]

The default is a transactional dry-run that prints the plan as counts only.
Identity inputs are read only from MARKDOC_TRANSFER_SOURCE_LOGIN and
MARKDOC_TRANSFER_TARGET_GITHUB_ACCOUNT_ID. DATABASE_URL is required and must
use TLS (sslmode=require|verify-ca|verify-full, or DATABASE_SSL=1 like the app).
Environment values, user ids and rollback-record contents are never printed.`;

export interface TransferCliArguments {
  mode: LegacyOwnershipTransferMode | "help";
  transferId?: string;
}

interface CliOutput {
  log(message: string): void;
  error(message: string): void;
}

interface TransferConnection {
  client: LegacyOwnershipTransferQueryClient;
  close(): Promise<void>;
}

type TransferEnvironment = Record<string, string | undefined>;

type ConnectTransferDatabase = (databaseUrl: string, environment: TransferEnvironment) => Promise<TransferConnection>;

interface RunCliDependencies {
  environment?: TransferEnvironment;
  output?: CliOutput;
  connect?: ConnectTransferDatabase;
}

export function parseTransferArguments(argv: string[]): TransferCliArguments {
  const modes = new Set(["--apply", "--verify", "--rollback", "--help"]);
  const seen = new Set<string>();
  let mode: TransferCliArguments["mode"] | undefined;
  let transferId: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (seen.has(argument)) throw new Error("duplicate command-line argument");
    seen.add(argument);
    if (argument === "--transfer-id") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--transfer-id requires a value");
      const normalized = normalizeTransferId(value);
      if (!normalized) throw new Error("--transfer-id is not a transfer identifier");
      transferId = normalized;
      index += 1;
      continue;
    }
    if (!modes.has(argument)) throw new Error("unsupported command-line argument");
    if (mode !== undefined) throw new Error("transfer modes are mutually exclusive");
    mode = argument === "--apply" ? "apply" : argument === "--verify" ? "verify" : argument === "--rollback" ? "rollback" : "help";
  }
  mode ??= "dry-run";
  if (transferId !== undefined && mode !== "verify" && mode !== "rollback") {
    throw new Error("--transfer-id is only valid with --verify or --rollback");
  }
  if (mode === "rollback" && transferId === undefined) throw new Error("--rollback requires --transfer-id");
  return transferId === undefined ? { mode } : { mode, transferId };
}

export async function runTransferCli(argv: string[], dependencies: RunCliDependencies = {}): Promise<void> {
  const output = dependencies.output ?? console;
  const parsed = parseTransferArguments(argv);
  if (parsed.mode === "help") {
    output.log(usage);
    return;
  }

  const environment = dependencies.environment ?? process.env;
  const databaseUrl = requiredEnvironmentValue(environment, "DATABASE_URL");
  const sourceLogin = requiredEnvironmentValue(environment, SOURCE_LOGIN_ENV);
  const providerAccountId = requiredEnvironmentValue(environment, TARGET_ACCOUNT_ID_ENV);

  const connection = await (dependencies.connect ?? connectTransferDatabase)(databaseUrl, environment);
  let operationError: unknown;
  try {
    const report = await transferLegacyOwnership({
      client: connection.client,
      sourceLogin,
      providerAccountId,
      mode: parsed.mode,
      transferId: parsed.transferId,
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

export async function runMain(argv: string[], dependencies: RunCliDependencies = {}): Promise<number> {
  const output = dependencies.output ?? console;
  try {
    await runTransferCli(argv, dependencies);
    return 0;
  } catch (error) {
    if (error instanceof LegacyOwnershipTransferCommittedRecordError) {
      output.error(`transfer committed, but the rollback record could not be confirmed [transfer_id=${error.transferId}]`);
      return 2;
    }
    if (error instanceof LegacyOwnershipTransferError) {
      output.error(`transfer failed [${error.reason}]: ${error.message}`);
      return error.reason === "COMMIT_OUTCOME_UNKNOWN" ? 3 : 1;
    }
    if (error instanceof Error && /command-line|--transfer-id|--rollback|environment variable|DATABASE_URL|encrypted/.test(error.message)) {
      output.error(`transfer failed [INVALID_INVOCATION]: ${error.message}`);
      return 1;
    }
    output.error("transfer failed [INTERNAL]: the operation did not complete");
    return 1;
  }
}

/**
 * Same connection contract as `src/server/db/index.ts`: `DATABASE_URL`, with TLS switched on by
 * `sslmode=require` in the URL or `DATABASE_SSL=1`. Unlike the app, an unencrypted configuration is
 * refused here, and the session is checked against `pg_stat_ssl` after connecting.
 */
export function transportSslOption(databaseUrl: string, environment: TransferEnvironment): { rejectUnauthorized: false } | undefined {
  return /sslmode=require/.test(databaseUrl) || environment.DATABASE_SSL === "1" ? { rejectUnauthorized: false } : undefined;
}

export function assertEncryptedDatabaseConfiguration(databaseUrl: string, environment: TransferEnvironment): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL is not a valid PostgreSQL URL");
  }
  const sslParameters = [...parsed.searchParams.entries()].filter(([name]) => name.toLowerCase().startsWith("ssl"));
  if (sslParameters.length === 0) {
    if (environment.DATABASE_SSL === "1") return;
    throw new Error("DATABASE_URL must require an encrypted PostgreSQL connection (sslmode or DATABASE_SSL=1)");
  }
  if (
    sslParameters.length !== 1 ||
    sslParameters[0][0] !== "sslmode" ||
    !["require", "verify-ca", "verify-full"].includes(sslParameters[0][1].toLowerCase())
  ) {
    throw new Error("DATABASE_URL must require an encrypted PostgreSQL connection (sslmode or DATABASE_SSL=1)");
  }
}

async function connectTransferDatabase(databaseUrl: string, environment: TransferEnvironment): Promise<TransferConnection> {
  assertEncryptedDatabaseConfiguration(databaseUrl, environment);
  const pg = new Client({ connectionString: databaseUrl, ssl: transportSslOption(databaseUrl, environment) });
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

  const client: LegacyOwnershipTransferQueryClient = {
    query: async <T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }> => {
      const result = await pg.query<T>(text, values);
      return { rows: result.rows };
    },
  };
  return { client, close: () => pg.end() };
}

function requiredEnvironmentValue(environment: TransferEnvironment, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`a required transfer environment variable is unset (${name})`);
  return value;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
const modulePath = fileURLToPath(import.meta.url).toLowerCase();
if (invokedPath === modulePath) {
  process.exitCode = await runMain(process.argv.slice(2));
}
