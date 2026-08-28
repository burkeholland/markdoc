import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CommitOutcomeUnknownError,
  createPostgresClientConfig,
  createPostgresDestination,
  DestinationTlsVerificationError,
  MigrationCommittedManifestError,
  type MigrationManifest,
  POSTGRES_TLS_VERIFICATION_QUERY,
  type PostgresClient,
  type PostgresClientFactory,
  type TransactionalConnection,
} from "../../../scripts/lib/pglite-postgres-migration";
import {
  DestinationVerificationCloseError,
  MigrationCommittedCloseError,
  parseMigrationArguments,
  redactError,
  runCli,
  runMain,
} from "../../../scripts/migrate-pglite-to-postgres.mjs";

const destinationUrl = "postgresql://fixture-user:fixture-password@database.internal/fixture?sslmode=require";

class FakePostgresClient implements PostgresClient {
  readonly queries: string[] = [];
  connected = false;
  ended = false;
  failures = new Map<string, Error>();
  tlsRows: Record<string, unknown>[] = [{ ssl: true }];

  async connect(): Promise<void> {
    this.connected = true;
  }

  async query(text: string): Promise<{ rows: Record<string, unknown>[] }> {
    this.queries.push(text);
    const failure = this.failures.get(text);
    if (failure) throw failure;
    if (text === POSTGRES_TLS_VERIFICATION_QUERY) return { rows: this.tlsRows };
    return { rows: [] };
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

describe("PostgreSQL migration destination", () => {
  it("requires TLS and commits successful transactions", async () => {
    const client = new FakePostgresClient();
    const factory = vi.fn<PostgresClientFactory>(() => client);
    const destination = await createPostgresDestination(destinationUrl, factory);

    expect(client.connected).toBe(true);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0][0]).toMatchObject({
      connectionString: "postgresql://fixture-user:fixture-password@database.internal/fixture",
      ssl: { rejectUnauthorized: false },
    });
    expect(createPostgresClientConfig(destinationUrl)).toEqual(factory.mock.calls[0][0]);

    await expect(
      destination.transaction(async (transaction) => {
        await transaction.query("SELECT $1::text", ["binary-safe"]);
        return "committed";
      }),
    ).resolves.toBe("committed");
    expect(client.queries).toEqual([POSTGRES_TLS_VERIFICATION_QUERY, "BEGIN", "SELECT $1::text", "COMMIT"]);

    await destination.close();
    expect(client.ended).toBe(true);
  });

  it.each([
    "postgresql://database.internal/fixture",
    "postgresql://database.internal/fixture?sslmode=disable",
    "postgresql://database.internal/fixture?sslmode=require&ssl=0",
    "postgresql://database.internal/fixture?sslmode=require&sslmode=require",
    "postgresql://database.internal/fixture?sslmode=require&sslrootcert=certificate.pem",
    "https://database.internal/fixture?sslmode=require",
    "not a URL",
  ])("refuses a destination that cannot prove required PostgreSQL TLS: %s", async (url) => {
    const factory = vi.fn<PostgresClientFactory>();
    await expect(createPostgresDestination(url, factory)).rejects.toThrow(/PostgreSQL URL|sslmode=require/);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    { name: "plaintext", rows: [{ ssl: false }] },
    { name: "missing", rows: [] },
  ])("closes a connected $name backend before any schema or data access", async ({ rows }) => {
    const client = new FakePostgresClient();
    client.tlsRows = rows;

    await expect(createPostgresDestination(destinationUrl, () => client)).rejects.toBeInstanceOf(
      DestinationTlsVerificationError,
    );
    expect(client.connected).toBe(true);
    expect(client.ended).toBe(true);
    expect(client.queries).toEqual([POSTGRES_TLS_VERIFICATION_QUERY]);
  });

  it("closes a connection when runtime TLS verification cannot be queried", async () => {
    const client = new FakePostgresClient();
    client.failures.set(POSTGRES_TLS_VERIFICATION_QUERY, new Error("pg_stat_ssl unavailable"));

    await expect(createPostgresDestination(destinationUrl, () => client)).rejects.toThrow(
      /TLS could not be verified after connect; migration was not started/,
    );
    expect(client.ended).toBe(true);
    expect(client.queries).toEqual([POSTGRES_TLS_VERIFICATION_QUERY]);
  });

  it("rolls back a failed callback and preserves its original error", async () => {
    const client = new FakePostgresClient();
    const destination = await createPostgresDestination(destinationUrl, () => client);
    const injected = new Error("injected write failure");

    await expect(
      destination.transaction(async (transaction) => {
        await transaction.query("UPDATE document SET title = 'changed'");
        throw injected;
      }),
    ).rejects.toBe(injected);
    expect(client.queries).toEqual([
      POSTGRES_TLS_VERIFICATION_QUERY,
      "BEGIN",
      "UPDATE document SET title = 'changed'",
      "ROLLBACK",
    ]);
  });

  it("reports both the operation and rollback errors", async () => {
    const client = new FakePostgresClient();
    client.failures.set("ROLLBACK", new Error("rollback transport failed"));
    const destination = await createPostgresDestination(destinationUrl, () => client);

    const failure = await destination
      .transaction(async () => {
        throw new Error("operation failed");
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(client.queries).toEqual([POSTGRES_TLS_VERIFICATION_QUERY, "BEGIN", "ROLLBACK"]);
  });

  it("classifies an unconfirmed write COMMIT without attempting rollback", async () => {
    const client = new FakePostgresClient();
    client.failures.set("COMMIT", new Error("connection ended during COMMIT"));
    const destination = await createPostgresDestination(destinationUrl, () => client);

    await expect(destination.transaction(async () => "written")).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(client.queries).toEqual([POSTGRES_TLS_VERIFICATION_QUERY, "BEGIN", "COMMIT"]);
  });

  it("does not classify a read-only COMMIT failure as an unknown write outcome", async () => {
    const client = new FakePostgresClient();
    client.failures.set("COMMIT", new Error("connection ended during read-only COMMIT"));
    const destination = await createPostgresDestination(destinationUrl, () => client);

    const failure = await destination.transaction(async () => "read", { readOnly: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(client.queries).toEqual([POSTGRES_TLS_VERIFICATION_QUERY, "BEGIN", "COMMIT"]);
  });
});

describe("migration CLI", () => {
  let root: string;
  let argv: string[];

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "markdoc-migration-cli-"));
    argv = [
      "--source-snapshot",
      path.join(root, "fixture.tar.gz"),
      "--source-data-dir",
      path.join(root, "restore"),
      "--destination-url-env",
      "TEST_DATABASE_URL",
      "--manifest",
      path.join(root, "manifest.json"),
    ];
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("validates required, duplicate, conflicting, and environment arguments", async () => {
    expect(parseMigrationArguments(argv)).toMatchObject({
      destinationUrlEnv: "TEST_DATABASE_URL",
      replace: false,
      verifyOnly: false,
    });
    expect(() => parseMigrationArguments([])).toThrow(/are required/);
    expect(() => parseMigrationArguments([...argv, "--manifest", "second.json"])).toThrow(/Duplicate argument/);
    expect(() => parseMigrationArguments([...argv, "--replace", "--verify-only"])).toThrow(/cannot be combined/);
    expect(() =>
      parseMigrationArguments(
        argv.map((argument) => (argument === "TEST_DATABASE_URL" ? "NOT-AN-ENV-NAME" : argument)),
      ),
    ).toThrow(/variable name is invalid/);

    const connect = vi.fn();
    await expect(runCli(argv, { NODE_ENV: "test" }, connect)).rejects.toThrow(/TEST_DATABASE_URL is unset/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("does not print success before a post-commit close failure", async () => {
    const output = recordingOutput();
    const destination = fakeDestination(async () => {
      throw new Error(`close failed for ${destinationUrl}`);
    });

    await expect(
      runCli(
        argv,
        { NODE_ENV: "test", TEST_DATABASE_URL: destinationUrl },
        async () => destination,
        async () => emptyManifest(),
        output,
      ),
    ).rejects.toBeInstanceOf(MigrationCommittedCloseError);
    expect(output.logs).toEqual([]);
  });

  it("distinguishes verification close failure from a committed migration", async () => {
    const output = recordingOutput();
    const destination = fakeDestination(async () => {
      throw new Error("verification close failed");
    });

    await expect(
      runCli(
        [...argv, "--verify-only"],
        { NODE_ENV: "test", TEST_DATABASE_URL: destinationUrl },
        async () => destination,
        async () => emptyManifest(),
        output,
      ),
    ).rejects.toBeInstanceOf(DestinationVerificationCloseError);
    expect(output.logs).toEqual([]);
  });

  it("returns stable, secret-free exit classes", async () => {
    const cases: Array<{ error: Error; exitCode: number; marker: RegExp }> = [
      {
        error: new Error(`pre-commit failure at ${destinationUrl}`),
        exitCode: 1,
        marker: /failed before commit/,
      },
      {
        error: new MigrationCommittedManifestError(new Error(`publish failed for ${destinationUrl}`)),
        exitCode: 2,
        marker: /manifest publication failed/,
      },
      {
        error: new CommitOutcomeUnknownError(new Error(`COMMIT failed for ${destinationUrl}`)),
        exitCode: 3,
        marker: /COMMIT outcome is unknown/,
      },
    ];

    for (const testCase of cases) {
      const output = recordingOutput();
      const exitCode = await runMain(argv, {
        environment: { NODE_ENV: "test", TEST_DATABASE_URL: destinationUrl },
        connect: async () => fakeDestination(),
        migrate: async () => {
          throw testCase.error;
        },
        output,
      });
      expect(exitCode).toBe(testCase.exitCode);
      expect(output.errors).toHaveLength(1);
      expect(output.errors[0]).toMatch(testCase.marker);
      expect(output.errors[0]).toContain("[redacted PostgreSQL URL]");
      expect(output.errors[0]).not.toContain("fixture-password");
    }

    const closeOutput = recordingOutput();
    const closeExitCode = await runMain(argv, {
      environment: { NODE_ENV: "test", TEST_DATABASE_URL: destinationUrl },
      connect: async () =>
        fakeDestination(async () => {
          throw new Error(`close failed for ${destinationUrl}`);
        }),
      migrate: async () => emptyManifest(),
      output: closeOutput,
    });
    expect(closeExitCode).toBe(4);
    expect(closeOutput.errors[0]).toMatch(/committed and verified.*did not close cleanly/);
    expect(closeOutput.errors[0]).not.toContain("fixture-password");
  });

  it("reports runtime TLS rejection without logging destination credentials or running migration", async () => {
    const output = recordingOutput();
    const client = new FakePostgresClient();
    client.tlsRows = [{ ssl: false }];
    const migrate = vi.fn();

    const exitCode = await runMain(argv, {
      environment: { NODE_ENV: "test", TEST_DATABASE_URL: destinationUrl },
      connect: (url) => createPostgresDestination(url, () => client),
      migrate,
      output,
    });

    expect(exitCode).toBe(1);
    expect(migrate).not.toHaveBeenCalled();
    expect(client.ended).toBe(true);
    expect(output.logs).toEqual([]);
    expect(output.errors).toHaveLength(1);
    expect(output.errors[0]).toMatch(/failed before commit.*TLS was not reported as encrypted/);
    expect(output.errors[0]).not.toContain(destinationUrl);
    expect(output.errors[0]).not.toContain(new URL(destinationUrl).password);
  });

  it("redacts PostgreSQL URLs without exposing encoded credentials", () => {
    const message = redactError(
      new Error("connection postgresql://user:p%40ss@host.internal/db?sslmode=require failed"),
    );
    expect(message).toBe("connection [redacted PostgreSQL URL] failed");
    expect(message).not.toContain("p%40ss");
  });
});

function fakeDestination(close: () => Promise<void> = async () => undefined): TransactionalConnection {
  const destination: TransactionalConnection = {
    query: async () => ({ rows: [] }),
    transaction: async (callback) => callback(destination),
    close,
  };
  return destination;
}

function emptyManifest(): MigrationManifest {
  const emptyHash = "0".repeat(64);
  const schema = { count: 15, latestCreatedAt: "1787795284192", latestHash: emptyHash };
  return {
    formatVersion: 1,
    sourceSnapshot: { bytes: 1, sha256: emptyHash },
    schema: { source: schema, target: schema },
    tables: {},
    records: {
      documents: { count: 0, sha256: emptyHash },
      assets: { count: 0, bytes: 0, sha256: emptyHash },
    },
    totals: { tables: 17, rows: 0 },
    sequences: {},
  };
}

function recordingOutput(): CliOutputRecorder {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log(message) {
      logs.push(message);
    },
    error(message) {
      errors.push(message);
    },
  };
}

interface CliOutputRecorder {
  logs: string[];
  errors: string[];
  log(message: string): void;
  error(message: string): void;
}
