import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APPLICATION_TABLES,
  discoverDrizzleTableNames,
  migratePgliteSnapshot,
  writeManifest,
} from "../../../scripts/lib/pglite-postgres-migration";
import {
  createDestination,
  createMigrationFixture,
  fileHash,
  MIGRATION_TEST_TIMEOUT_MS,
  type MigrationSnapshotFixture,
} from "./pglite-postgres-migration.fixture";

/**
 * Data scenarios of the PGlite → PostgreSQL migration: the exhaustive table list, value fidelity across every
 * column kind, and the verify-only hash check. One of the three files task #1426 cut
 * `pglite-postgres-migration.test.ts` into (with `.safety` and `.failure`) so the suite's longest file stops
 * setting its wall time — vitest runs files, not tests, in parallel. The tests moved verbatim; the snapshot they
 * migrate from comes from `createMigrationFixture()` in `pglite-postgres-migration.fixture.ts`.
 */

const expectedTables = [
  "account",
  "activity",
  "agent_request",
  "api_token",
  "asset",
  "collaborator",
  "document",
  "notification",
  "ownership_transfer",
  "recent",
  "review",
  "session",
  "star",
  "user",
  "verificationToken",
  "version",
  "webhook",
  "webhook_delivery",
];

describe("PGlite to PostgreSQL migration", () => {
  let fixture: MigrationSnapshotFixture | undefined;
  let root: string;
  let snapshot: string;
  let snapshotHash: string;

  beforeAll(async () => {
    fixture = await createMigrationFixture();
    root = fixture.root;
    snapshot = fixture.snapshot;
    snapshotHash = fixture.snapshotHash;
  }, MIGRATION_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("guards the exhaustive Drizzle table list", () => {
    expect([...APPLICATION_TABLES]).toEqual(expectedTables);
    expect(discoverDrizzleTableNames()).toEqual(expectedTables);
  });

  it("preserves Unicode, nulls, timestamps, JSON, binary values, foreign keys, and sequences", async () => {
    const destination = await createDestination(true);
    const manifestPath = path.join(root, "fidelity-manifest.json");
    try {
      await destination.query(`CREATE SCHEMA shadow`);
      await destination.query(`CREATE TABLE shadow."user" (id text PRIMARY KEY)`);
      await destination.query(`INSERT INTO shadow."user" (id) VALUES ('shadow-user')`);
      await destination.query(`SET search_path = shadow, public`);
      const manifest = await migratePgliteSnapshot({
        sourceSnapshot: snapshot,
        sourceDataDir: path.join(root, "restore-fidelity"),
        destination,
        manifestPath,
      });

      expect(manifest.totals).toEqual({ tables: expectedTables.length, rows: 18 });
      expect(manifest.records.assets).toMatchObject({ count: 2, bytes: 1_048_579 });
      expect(manifest.schema.source).toMatchObject({ count: 15, latestCreatedAt: "1787795284192" });
      expect(manifest.schema.target).toMatchObject({ count: 20, latestCreatedAt: "1788219322678" });
      expect(JSON.stringify(manifest)).not.toContain("account-access-value");
      expect(JSON.stringify(manifest)).not.toContain("https://fixture.invalid/hook");
      expect(JSON.stringify(manifest)).not.toContain("Unicode");
      expect(JSON.parse(await fs.readFile(manifestPath, "utf8"))).toEqual(manifest);
      await expect(writeManifest(snapshot, manifest)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await fileHash(snapshot)).toBe(snapshotHash);

      const document = await destination.query<{
        title: string;
        content: string;
        ystate: Uint8Array;
        published_at: string;
        deleted_at: string;
      }>(
        `SELECT title, content, ystate,
                to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS published_at,
                deleted_at::text AS deleted_at
           FROM document WHERE id = 'doc-1'`,
      );
      expect(document.rows[0]).toMatchObject({
        title: "Unicode café 🚀",
        content: "# Unicode\n\nΚαλημέρα 世界",
        published_at: "2026-08-27T12:34:56.123456",
        deleted_at: "infinity",
      });
      expect([...document.rows[0].ystate]).toEqual([0, 1, 2, 255]);

      const activity = await destination.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM activity WHERE id = 'activity-1'`,
      );
      expect(activity.rows[0].detail).toEqual({ nested: { enabled: true }, values: [1, null, "é"] });

      const assets = await destination.query<{ id: string; size: number; bytes: number }>(
        `SELECT id, size, octet_length(data) AS bytes FROM asset ORDER BY id`,
      );
      expect(assets.rows).toEqual([
        { id: "asset-big", size: 1_048_579, bytes: 1_048_579 },
        { id: "asset-empty", size: 0, bytes: 0 },
      ]);

      const nullable = await destination.query<{ email: string | null; image: string | null }>(
        `SELECT email, image FROM public."user" WHERE id = 'user-1'`,
      );
      expect(nullable.rows[0]).toEqual({ email: null, image: null });
      const shadow = await destination.query<{ id: string }>(`SELECT id FROM shadow."user"`);
      expect(shadow.rows).toEqual([{ id: "shadow-user" }]);
      const historicalTimestamp = await destination.query<{ matches: boolean }>(
        `SELECT expires_at = $1::timestamptz AS matches FROM api_token WHERE id = 'api-token-1'`,
        ["0001-02-03 04:05:06.123456+00 BC"],
      );
      expect(historicalTimestamp.rows[0].matches).toBe(true);

      const next = await destination.query<{ value: string }>(
        `SELECT nextval(pg_get_serial_sequence('"version"', 'number'))::text AS value`,
      );
      expect(next.rows[0].value).toBe("42");
      expect(await fileHash(snapshot)).toBe(snapshotHash);
      await expect(fs.stat(path.join(root, "restore-fidelity"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await destination.close();
    }
  }, MIGRATION_TEST_TIMEOUT_MS);

  it("verify-only rejects a hash mismatch", async () => {
    const destination = await createDestination(true);
    try {
      await migratePgliteSnapshot({
        sourceSnapshot: snapshot,
        sourceDataDir: path.join(root, "restore-hash-migrate"),
        destination,
      });
      await destination.query(`UPDATE document SET content = 'changed' WHERE id = 'doc-1'`);
      await expect(
        migratePgliteSnapshot({
          sourceSnapshot: snapshot,
          sourceDataDir: path.join(root, "restore-hash-verify"),
          destination,
          verifyOnly: true,
        }),
      ).rejects.toThrow(/SHA-256 mismatch/);
    } finally {
      await destination.close();
    }
  }, MIGRATION_TEST_TIMEOUT_MS);
});
